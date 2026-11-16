import http.cookiejar
import json
import os
import sys
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import uvicorn


class TestTrashHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8803
        cls.base_url = f'http://127.0.0.1:{cls.port}'
        config = uvicorn.Config(server.app, host='127.0.0.1', port=cls.port, log_level='error')
        cls.server = uvicorn.Server(config)
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=2)

    def setUp(self):
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))
        req = urllib.request.Request(
            f'{self.base_url}/api/login',
            data=json.dumps({'password': server.PASSWORD}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        res = self.opener.open(req)
        self.csrf = json.loads(res.read().decode('utf-8'))['csrf']

    def api_get(self, params):
        qs = urllib.parse.urlencode(params)
        res = self.opener.open(f'{self.base_url}/explorer/api?{qs}')
        self.assertEqual(res.status, 200)
        return json.loads(res.read().decode('utf-8'))['data']

    def api_post(self, body):
        req = urllib.request.Request(
            f'{self.base_url}/explorer/api',
            data=json.dumps(body).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'X-CSRF-Token': self.csrf}
        )
        res = self.opener.open(req)
        self.assertEqual(res.status, 200)
        return json.loads(res.read().decode('utf-8'))['data']

    def test_trash_cycle_and_audit_history(self):
        filename = f'doc_papelera_{int(time.time())}.txt'
        target_path = f'trabajo/{filename}'

        # 1. Crear archivo
        prep = self.api_post({'op': 'create', 'target': target_path, 'kind': 'file', 'phase': 'prepare'})
        self.api_post({'op': 'create', 'target': target_path, 'kind': 'file', 'phase': 'execute', 'nonce': prep['nonce'], 'password': server.PASSWORD})

        # 2. Editar con contenido específico
        test_text = 'Contenido importante que se va a recuperar de la papelera.'
        prep_edit = self.api_post({'op': 'edit', 'target': target_path, 'text': test_text, 'phase': 'prepare'})
        self.api_post({'op': 'edit', 'target': target_path, 'text': test_text, 'phase': 'execute', 'nonce': prep_edit['nonce'], 'password': server.PASSWORD})

        # Verificar existencia
        listing1 = self.api_get({'op': 'list', 'path': 'trabajo'})
        names1 = [e['name'] for e in listing1['entries']]
        self.assertIn(filename, names1)

        # 3. Eliminar (enviar a papelera)
        prep_del = self.api_post({'op': 'delete', 'paths': [target_path], 'phase': 'prepare'})
        self.api_post({'op': 'delete', 'paths': [target_path], 'phase': 'execute', 'nonce': prep_del['nonce'], 'password': server.PASSWORD})

        # Verificar que ya no está en trabajo
        listing2 = self.api_get({'op': 'list', 'path': 'trabajo'})
        names2 = [e['name'] for e in listing2['entries']]
        self.assertNotIn(filename, names2)

        # 4. Verificar que aparece en la papelera
        trash_items = self.api_get({'op': 'trash'})
        item = next((i for i in trash_items if i.get('original') == target_path), None)
        self.assertIsNotNone(item, 'El archivo no se encontró en la papelera')
        trash_id = item['id']

        # 5. Restaurar desde la papelera
        prep_res = self.api_post({'op': 'restore', 'paths': [trash_id], 'replace': False, 'phase': 'prepare'})
        self.api_post({'op': 'restore', 'paths': [trash_id], 'replace': False, 'phase': 'execute', 'nonce': prep_res['nonce'], 'password': server.PASSWORD})

        # Verificar que reaparece en trabajo
        listing3 = self.api_get({'op': 'list', 'path': 'trabajo'})
        names3 = [e['name'] for e in listing3['entries']]
        self.assertIn(filename, names3)

        # Verificar que el contenido se conservó intacto
        content = self.api_get({'op': 'text', 'path': target_path})['text']
        self.assertEqual(content, test_text)

        # 6. Eliminar nuevamente y purgar definitivamente
        prep_del2 = self.api_post({'op': 'delete', 'paths': [target_path], 'phase': 'prepare'})
        self.api_post({'op': 'delete', 'paths': [target_path], 'phase': 'execute', 'nonce': prep_del2['nonce'], 'password': server.PASSWORD})

        trash_items2 = self.api_get({'op': 'trash'})
        item2 = next((i for i in trash_items2 if i.get('original') == target_path), None)
        self.assertIsNotNone(item2)

        prep_purge = self.api_post({'op': 'purge', 'paths': [item2['id']], 'phase': 'prepare'})
        self.api_post({'op': 'purge', 'paths': [item2['id']], 'phase': 'execute', 'nonce': prep_purge['nonce'], 'password': server.PASSWORD})

        # Verificar que item2 ya no está en la papelera
        trash_items3 = self.api_get({'op': 'trash'})
        trash_ids3 = [i['id'] for i in trash_items3]
        self.assertNotIn(item2['id'], trash_ids3, 'El archivo debería haberse purgado de la papelera')

        # 7. Verificar historial y auditoría SQLite
        history = self.api_get({'op': 'history', 'page': 0})
        self.assertIsInstance(history, list)
        self.assertGreater(len(history), 0)
        operations = [h['operation'] for h in history]
        self.assertIn('create', operations)
        self.assertIn('delete', operations)
        self.assertIn('restore', operations)
        self.assertIn('purge', operations)


if __name__ == '__main__':
    unittest.main()
