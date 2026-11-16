import http.cookiejar
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

# Agregar ruta del servidor
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import uvicorn


class TestAuth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8801
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

    def test_login_failure_wrong_password(self):
        req = urllib.request.Request(
            f'{self.base_url}/api/login',
            data=json.dumps({'password': 'clave-incorrecta-123'}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.opener.open(req)
        self.assertEqual(ctx.exception.code, 401)

    def test_login_success_and_session(self):
        req = urllib.request.Request(
            f'{self.base_url}/api/login',
            data=json.dumps({'password': server.PASSWORD}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        res = self.opener.open(req)
        self.assertEqual(res.status, 200)
        data = json.loads(res.read().decode('utf-8'))
        self.assertIn('csrf', data)
        csrf = data['csrf']

        # Verificar cookie explorer_session
        cookies = {c.name: c.value for c in self.cookie_jar}
        self.assertIn('explorer_session', cookies)

        # Consultar /api/session
        res_session = self.opener.open(f'{self.base_url}/api/session')
        self.assertEqual(res_session.status, 200)
        session_data = json.loads(res_session.read().decode('utf-8'))
        self.assertEqual(session_data['csrf'], csrf)

    def test_logout(self):
        # Primero login
        req = urllib.request.Request(
            f'{self.base_url}/api/login',
            data=json.dumps({'password': server.PASSWORD}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        res = self.opener.open(req)
        csrf = json.loads(res.read().decode('utf-8'))['csrf']

        # Logout con CSRF
        req_logout = urllib.request.Request(
            f'{self.base_url}/api/logout',
            data=b'{}',
            headers={'Content-Type': 'application/json', 'X-CSRF-Token': csrf}
        )
        res_logout = self.opener.open(req_logout)
        self.assertEqual(res_logout.status, 200)

        # Intentar acceder a /api/session posterior al logout
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.opener.open(f'{self.base_url}/api/session')
        self.assertEqual(ctx.exception.code, 401)


if __name__ == '__main__':
    unittest.main()
