import socket
import threading
import time
import unittest

import httpx
import uvicorn

import server


class TestAuthorization(unittest.TestCase):
    def test_nonce_csrf_and_nested_trash_over_http(self):
        listener = socket.create_server(('127.0.0.1',0))
        url = f'http://127.0.0.1:{listener.getsockname()[1]}'
        app = uvicorn.Server(uvicorn.Config(server.app,log_level='warning'))
        runner = threading.Thread(target=lambda: app.run(sockets=[listener]),daemon=True)
        runner.start()
        try:
            deadline = time.monotonic()+10
            while not app.started and time.monotonic()<deadline:
                time.sleep(.02)
            self.assertTrue(app.started)
            tree = server.DATA_DIR/'trabajo'/'fixture-auth'
            (tree/'nested').mkdir(parents=True)
            (tree/'nested'/'test.txt').write_bytes(b'original')
            (tree/'empty').mkdir()
            operation = dict(op='delete',paths=['trabajo/fixture-auth'])
            with httpx.Client(base_url=url) as first, httpx.Client(base_url=url) as other:
                def post(client,payload,code):
                    response = client.post('/explorer/api',json=payload)
                    self.assertEqual(response.status_code,code,response.text)
                    return response.json()
                post(first,operation|{'phase':'prepare'},401)
                for client in (first,other):
                    result = client.post('/api/login',json={'password':server.PASSWORD})
                    self.assertEqual(result.status_code,200,result.text)
                    client.headers['X-CSRF-Token'] = result.json()['csrf']
                csrf = first.headers.pop('X-CSRF-Token')
                post(first,operation|{'phase':'prepare'},403)
                first.headers['X-CSRF-Token'] = csrf
                token = post(first,operation|{'phase':'prepare'},200)['data']['nonce']
                execution = operation|dict(phase='execute',nonce=token)
                post(first,execution,401)
                execution['password'] = server.PASSWORD
                post(other,execution,409)
                post(first,execution|{'paths':['trabajo/fixture-auth/empty']},409)
                self.assertTrue(tree.exists())
                post(first,execution,200)
                post(first,execution,409)
                self.assertFalse(tree.exists())
                trash = first.get('/explorer/api?op=trash').json()['data']
                key = next(row['id'] for row in trash if row['original']=='trabajo/fixture-auth')
                restore = dict(op='restore',paths=[key])
                token = post(first,restore|{'phase':'prepare'},200)['data']['nonce']
                post(first,restore|dict(phase='execute',nonce=token,password=server.PASSWORD),200)
                self.assertEqual((tree/'nested'/'test.txt').read_bytes(),b'original')
                self.assertTrue((tree/'empty').exists())
        finally:
            app.should_exit = True
            runner.join(5)
