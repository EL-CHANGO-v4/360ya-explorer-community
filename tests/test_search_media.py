import http.cookiejar
import json
import os
import sys
import threading
import time
import unittest
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import uvicorn


class TestSearchMedia(unittest.TestCase):
    @classmethod
    def cleanup_test_files(cls):
        (server.DATA_DIR / 'trabajo' / 'archivo_subido.bin').unlink(missing_ok=True)

    @classmethod
    def setUpClass(cls):
        cls.cleanup_test_files()
        cls.port = 8804
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

    def test_01_search_by_name_and_extension(self):
        # Buscar por nombre 'bienvenida'
        search_res = self.api_get({'op': 'search', 'path': 'trabajo', 'name': 'bienvenida'})
        self.assertIn('entries', search_res)
        names = [e['name'] for e in search_res['entries']]
        self.assertIn('bienvenida.txt', names)

        # Buscar por extensión 'json'
        search_json = self.api_get({'op': 'search', 'path': 'trabajo', 'ext': 'json'})
        names_json = [e['name'] for e in search_json['entries']]
        self.assertIn('config.json', names_json)
        self.assertNotIn('bienvenida.txt', names_json)

    def test_02_media_streaming_and_range(self):
        # 1. Imagen completa
        res_img = self.opener.open(f'{self.base_url}/explorer/api?op=media&path=fotos/ejemplo_teal.png')
        self.assertEqual(res_img.status, 200)
        self.assertEqual(res_img.headers.get('Content-Type'), 'image/png')
        img_bytes = res_img.read()
        self.assertGreater(len(img_bytes), 0)

        # 2. Video con Range request
        req_video = urllib.request.Request(
            f'{self.base_url}/explorer/api?op=media&path=videos/demo_video.mp4',
            headers={'Range': 'bytes=0-100'}
        )
        res_video = self.opener.open(req_video)
        self.assertEqual(res_video.status, 206)
        self.assertEqual(res_video.headers.get('Content-Type'), 'video/mp4')
        self.assertIn('bytes 0-100/', res_video.headers.get('Content-Range', ''))
        partial = res_video.read()
        self.assertEqual(len(partial), 101)

    def test_03_file_download(self):
        res = self.opener.open(f'{self.base_url}/explorer/api?op=download&path=trabajo/bienvenida.txt')
        self.assertEqual(res.status, 200)
        self.assertIn('attachment', res.headers.get('Content-Disposition', ''))
        self.assertIn('bienvenida.txt', res.headers.get('Content-Disposition', ''))
        data = res.read().decode('utf-8')
        self.assertIn('360YA Explorer Community', data)

    def test_04_file_upload(self):
        test_bytes = b'PAYLOAD-TEST-BINARIO-360YA-1234567890'
        boundary = '----WebKitFormBoundary' + uuid.uuid4().hex

        def upload(payload):
            request_json = json.dumps(payload)
            body_parts = [
                f'--{boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n{request_json}\r\n'.encode(),
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.bin"\r\n\r\n'.encode(),
                test_bytes,
                f'\r\n--{boundary}--\r\n'.encode(),
            ]
            req = urllib.request.Request(f'{self.base_url}/explorer/api',data=b''.join(body_parts),headers={
                'Content-Type':f'multipart/form-data; boundary={boundary}', 'X-CSRF-Token':self.csrf,
            })
            return self.opener.open(req)

        operation = {'op':'upload','target':'trabajo/archivo_subido.bin','replace':True}
        with upload(operation | {'phase':'prepare'}) as prepared:
            nonce = json.load(prepared)['data']['nonce']
        with upload(operation | {'phase':'execute','nonce':nonce,'password':server.PASSWORD}) as result:
            self.assertEqual(result.status,200)

        # Descargar y verificar integridad
        res_down = self.opener.open(f'{self.base_url}/explorer/api?op=download&path=trabajo/archivo_subido.bin')
        self.assertEqual(res_down.status, 200)
        down_bytes = res_down.read()
        self.assertEqual(down_bytes, test_bytes)


if __name__ == '__main__':
    unittest.main()
