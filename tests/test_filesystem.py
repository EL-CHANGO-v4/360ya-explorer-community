import http.cookiejar
import json
import os
import shutil
import sys
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import uvicorn


class TestFilesystem(unittest.TestCase):
    @classmethod
    def cleanup_test_files(cls):
        shutil.rmtree(server.DATA_DIR / 'trabajo' / 'carpeta_prueba', ignore_errors=True)
        (server.DATA_DIR / 'archivo' / 'archivo_copiado.txt').unlink(missing_ok=True)
        (server.DATA_DIR / 'archivo' / 'archivo_renombrado.txt').unlink(missing_ok=True)

    @classmethod
    def setUpClass(cls):
        cls.cleanup_test_files()
        cls.port = 8802
        cls.base_url = f'http://127.0.0.1:{cls.port}'
        config = uvicorn.Config(server.app, host='127.0.0.1', port=cls.port, log_level='error')
        cls.server = uvicorn.Server(config)
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.cleanup_test_files()
        cls.server.should_exit = True
        cls.thread.join(timeout=2)

    def setUp(self):
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))
        # Autenticar
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

    def test_01_roots(self):
        roots = self.api_get({'op': 'roots'})
        self.assertIn('volumes', roots)
        vols = {v['path']: v for v in roots['volumes']}
        self.assertIn('trabajo', vols)
        self.assertIn('archivo', vols)
        self.assertIn('fotos', vols)
        self.assertIn('videos', vols)
        self.assertIn('panorama', vols)
        self.assertTrue(vols['trabajo']['writable'])

    def test_02_create_folder_and_file(self):
        # 1. Crear carpeta
        prep_folder = self.api_post({
            'op': 'create', 'target': 'trabajo/carpeta_prueba', 'kind': 'folder', 'phase': 'prepare'
        })
        self.assertIn('nonce', prep_folder)
        exec_folder = self.api_post({
            'op': 'create', 'target': 'trabajo/carpeta_prueba', 'kind': 'folder',
            'phase': 'execute', 'nonce': prep_folder['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_folder)

        # 2. Crear archivo
        prep_file = self.api_post({
            'op': 'create', 'target': 'trabajo/carpeta_prueba/archivo1.txt', 'kind': 'file', 'phase': 'prepare'
        })
        self.assertIn('nonce', prep_file)
        exec_file = self.api_post({
            'op': 'create', 'target': 'trabajo/carpeta_prueba/archivo1.txt', 'kind': 'file',
            'phase': 'execute', 'nonce': prep_file['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_file)

        # 3. Listar contenido
        listing = self.api_get({'op': 'list', 'path': 'trabajo/carpeta_prueba'})
        names = [e['name'] for e in listing['entries']]
        self.assertIn('archivo1.txt', names)

    def test_03_edit_and_read_text(self):
        # 1. Editar archivo
        prep_edit = self.api_post({
            'op': 'edit', 'target': 'trabajo/carpeta_prueba/archivo1.txt',
            'text': 'Contenido de prueba UTF-8 con acentos: áéíóú 360YA Community', 'phase': 'prepare'
        })
        self.assertIn('nonce', prep_edit)
        exec_edit = self.api_post({
            'op': 'edit', 'target': 'trabajo/carpeta_prueba/archivo1.txt',
            'text': 'Contenido de prueba UTF-8 con acentos: áéíóú 360YA Community',
            'phase': 'execute', 'nonce': prep_edit['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_edit)

        # 2. Leer archivo
        read_data = self.api_get({'op': 'text', 'path': 'trabajo/carpeta_prueba/archivo1.txt'})
        self.assertIn('text', read_data)
        self.assertIn('360YA Community', read_data['text'])

    def test_04_chmod_and_properties(self):
        # Chmod
        prep_chmod = self.api_post({
            'op': 'chmod', 'target': 'trabajo/carpeta_prueba/archivo1.txt', 'mode': '0755', 'phase': 'prepare'
        })
        exec_chmod = self.api_post({
            'op': 'chmod', 'target': 'trabajo/carpeta_prueba/archivo1.txt', 'mode': '0755',
            'phase': 'execute', 'nonce': prep_chmod['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_chmod)

        # Properties
        props = self.api_get({'op': 'properties', 'path': 'trabajo/carpeta_prueba/archivo1.txt'})
        self.assertEqual(props['name'], 'archivo1.txt')
        self.assertEqual(props['mode'], '755')
        self.assertEqual(props['kind'], 'file')

    def test_05_copy_and_move(self):
        # Copiar de trabajo a archivo
        prep_copy = self.api_post({
            'op': 'copy', 'pairs': [['trabajo/carpeta_prueba/archivo1.txt', 'archivo/archivo_copiado.txt']],
            'replace': False, 'phase': 'prepare'
        })
        exec_copy = self.api_post({
            'op': 'copy', 'pairs': [['trabajo/carpeta_prueba/archivo1.txt', 'archivo/archivo_copiado.txt']],
            'replace': False, 'phase': 'execute', 'nonce': prep_copy['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_copy)

        # Verificar copia
        listing_archivo = self.api_get({'op': 'list', 'path': 'archivo'})
        names_archivo = [e['name'] for e in listing_archivo['entries']]
        self.assertIn('archivo_copiado.txt', names_archivo)

        # Mover / Renombrar
        prep_move = self.api_post({
            'op': 'move', 'pairs': [['archivo/archivo_copiado.txt', 'archivo/archivo_renombrado.txt']],
            'replace': False, 'phase': 'prepare'
        })
        exec_move = self.api_post({
            'op': 'move', 'pairs': [['archivo/archivo_copiado.txt', 'archivo/archivo_renombrado.txt']],
            'replace': False, 'phase': 'execute', 'nonce': prep_move['nonce'], 'password': server.PASSWORD
        })
        self.assertIn('id', exec_move)

        # Verificar renombrado
        listing_archivo2 = self.api_get({'op': 'list', 'path': 'archivo'})
        names_archivo2 = [e['name'] for e in listing_archivo2['entries']]
        self.assertNotIn('archivo_copiado.txt', names_archivo2)
        self.assertIn('archivo_renombrado.txt', names_archivo2)


if __name__ == '__main__':
    unittest.main()
