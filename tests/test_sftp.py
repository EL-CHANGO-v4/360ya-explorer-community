"""HTTP integration over an actual SSH/SFTP transport and temporary disk."""
import base64
import errno
import hashlib
import io
import os
from pathlib import Path
import socket
import threading
import time
import unittest

import httpx
import paramiko
import uvicorn

import server


class Login(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username,password)==('fixture','ssh-test-password') else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username=='fixture' and key==self.key else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class DiskSFTP(paramiko.SFTPServerInterface):
    def __init__(self, server, directory):
        super().__init__(server)
        self.directory = directory

    def path(self, path):
        target = (self.directory/path.lstrip('/')).resolve()
        if not target.is_relative_to(self.directory):
            raise PermissionError(errno.EACCES,'Outside SFTP home')
        return target

    def canonicalize(self,path):
        return '/'+self.path(path).relative_to(self.directory).as_posix().removeprefix('.')

    def stat(self,path):
        return paramiko.SFTPAttributes.from_stat(self.path(path).stat())

    lstat = stat

    def list_folder(self,path):
        return [paramiko.SFTPAttributes.from_stat(x.stat(),x.name) for x in self.path(path).iterdir()]

    def open(self,path,flags,attr):
        descriptor = os.open(self.path(path),flags,0o640)
        handle = paramiko.SFTPHandle(flags)
        mode = 'r+b' if flags&os.O_RDWR else 'wb' if flags&os.O_WRONLY else 'rb'
        stream = os.fdopen(descriptor,mode)
        handle.readfile = handle.writefile = stream
        return handle

    def mkdir(self,path,attr):
        self.path(path).mkdir(mode=attr.st_mode or 0o750)
        return 0

    def rename(self,old,new):
        if self.path(new).exists():
            return paramiko.SFTP_FAILURE
        self.path(old).rename(self.path(new))
        return 0

    def remove(self,path):
        self.path(path).unlink()
        return 0

    def rmdir(self,path):
        self.path(path).rmdir()
        return 0

    def chattr(self,path,attr):
        paramiko.SFTPServer.set_file_attr(str(self.path(path)),attr)
        return 0


def sftp_errors(method):
    def handle(*args,**kwargs):
        try:
            return method(*args,**kwargs)
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)
    return handle


for method in ('stat','lstat','list_folder','open','mkdir','rename','remove','rmdir','chattr'):
    setattr(DiskSFTP,method,sftp_errors(getattr(DiskSFTP,method)))


class TestSFTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.remote = (server.DATA_DIR/'fixture-ssh').resolve()
        cls.remote.mkdir()
        cls.host_key = paramiko.RSAKey.generate(2048)
        cls.login_key = paramiko.RSAKey.generate(2048)
        cls.listener = socket.create_server(('127.0.0.1',0))
        cls.listener.settimeout(.25)
        cls.stop = threading.Event()
        def incoming():
            while not cls.stop.is_set():
                try:
                    connection,_ = cls.listener.accept()
                except TimeoutError:
                    continue
                def serve(connection):
                    with paramiko.Transport(connection) as transport:
                        transport.add_server_key(cls.host_key)
                        transport.set_subsystem_handler('sftp',paramiko.SFTPServer,DiskSFTP,cls.remote)
                        auth = Login()
                        auth.key = cls.login_key
                        try:
                            transport.start_server(server=auth)
                            while transport.is_active() and not cls.stop.wait(.05):
                                pass
                        except (EOFError,paramiko.SSHException):
                            pass
                threading.Thread(target=serve,args=(connection,),daemon=True).start()
        cls.ssh = threading.Thread(target=incoming,daemon=True)
        cls.ssh.start()
        cls.web_socket = socket.create_server(('127.0.0.1',0))
        cls.url = f'http://127.0.0.1:{cls.web_socket.getsockname()[1]}'
        cls.web = uvicorn.Server(uvicorn.Config(server.app,log_level='warning'))
        cls.thread = threading.Thread(target=lambda:cls.web.run(sockets=[cls.web_socket]),daemon=True)
        cls.thread.start()
        deadline = time.monotonic()+10
        while not cls.web.started and time.monotonic()<deadline:
            time.sleep(.02)
        assert cls.web.started

    @classmethod
    def tearDownClass(cls):
        cls.web.should_exit = True
        cls.thread.join(5)
        cls.stop.set()
        cls.ssh.join(2)
        cls.listener.close()

    def test_sftp_over_http(self):
        with httpx.Client(base_url=self.url,timeout=15) as client:
            login = client.post('/api/login',json={'password':server.PASSWORD})
            self.assertEqual(login.status_code,200)
            client.headers['X-CSRF-Token'] = login.json()['csrf']
            def get(op,**params):
                response = client.get('/explorer/api',params=dict(op=op,**params))
                self.assertEqual(response.status_code,200,response.text)
                return response.json()['data']
            def change(op,file=None):
                def post(payload):
                    if file is None:
                        return client.post('/explorer/api',json=payload)
                    import json
                    return client.post('/explorer/api',data={'request':json.dumps(payload)},
                                       files={'file':('test.txt',file)})
                prepared = post(op|dict(phase='prepare'))
                self.assertEqual(prepared.status_code,200,prepared.text)
                execute = op|dict(phase='execute',nonce=prepared.json()['data']['nonce'],password=server.PASSWORD)
                result = post(execute)
                self.assertEqual(result.status_code,200,result.text)
            settings = dict(host='127.0.0.1',port=self.listener.getsockname()[1],username='fixture')
            fingerprint = 'SHA256:'+base64.b64encode(hashlib.sha256(self.host_key.asbytes()).digest()).decode().rstrip('=')
            self.assertEqual(client.post('/api/connect',json=settings|dict(password='ssh-test-password')).status_code,403)
            settings['fingerprint'] = fingerprint
            self.assertEqual(client.post('/api/connect',json=settings|dict(password='wrong')).status_code,401)
            self.assertEqual(client.post('/api/connect',json=settings|dict(password='ssh-test-password')).status_code,200)
            self.assertTrue(any(v['path']=='remote' for v in get('roots')['volumes']))
            key = io.StringIO()
            self.login_key.write_private_key(key,password='encrypted-test-key')
            response = client.post('/api/connect',json=settings|dict(private_key=key.getvalue(),passphrase='encrypted-test-key'))
            self.assertEqual(response.status_code,200,response.text)
            for folder in ('remote/tree','remote/tree/nested','remote/empty'):
                change(dict(op='create',target=folder,kind='folder'))
            path = 'remote/tree/nested/example.txt'
            change(dict(op='upload',target=path),b'payload')
            version = get('text',path=path)['version']
            change(dict(op='edit',target=path,version=version,text='changed'))
            change(dict(op='chmod',target=path,mode='600'))
            self.assertEqual(get('properties',path=path)['mode'],'600')
            result = client.get('/explorer/api',params=dict(op='download',path=path),headers={'Range':'bytes=1-3'})
            self.assertEqual((result.status_code,result.content),(206,b'han'))
            self.assertEqual(get('search',path='remote/tree/nested',name='example')['count'],1)
            change(dict(op='copy',pairs=[['remote/tree','archivo/from-ssh']]))
            change(dict(op='copy',pairs=[['archivo/from-ssh','remote/copy']]))
            change(dict(op='copy',pairs=[['remote/copy','remote/another']]))
            change(dict(op='move',pairs=[['remote/another','remote/renamed']]))
            change(dict(op='delete',paths=['remote/renamed','remote/empty']))
            rows = [row for row in get('trash') if row['original'] in ('remote/renamed','remote/empty')]
            self.assertEqual(len(rows),2)
            change(dict(op='restore',paths=[row['id'] for row in rows]))
            self.assertEqual((self.remote/'renamed/nested/example.txt').read_text(),'changed')
            self.assertTrue((self.remote/'empty').is_dir())
            change(dict(op='delete',paths=['remote/renamed','remote/empty']))
            rows = [row for row in get('trash') if row['original'] in ('remote/renamed','remote/empty')]
            change(dict(op='purge',paths=[row['id'] for row in rows]))
            self.assertFalse(any(row['original']=='remote/renamed' for row in get('trash')))
            self.assertEqual(client.post('/api/disconnect').status_code,200)
