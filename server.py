#!/usr/bin/env python3
"""
360YA Explorer Community v1.0.1
Software libre, gratuito y autoalojado.
Consolidación integral del diseño original y mejoras comunitarias.
"""
import contextlib
import ctypes
import datetime
import errno
import hashlib
import hmac
import io
import json
import os
import posixpath
import re
import secrets
import shutil
import sqlite3
import stat
import sys
import threading
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
import paramiko

# --- Directorios y Configuración ---
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('EXPLORER_DATA_DIR', str(BASE_DIR / 'data'))).resolve()
STATE_DIR = Path(os.environ.get('EXPLORER_STATE_DIR', str(DATA_DIR / '.state'))).resolve()
STATIC_DIR = BASE_DIR / 'static'

PASSWORD = os.environ.get('EXPLORER_PASSWORD', '')
if len(PASSWORD) < 12:
    raise RuntimeError('EXPLORER_PASSWORD debe tener al menos 12 caracteres')

KNOWN_HOSTS = Path(os.environ.get('EXPLORER_KNOWN_HOSTS', str(Path.home() / '.ssh/known_hosts'))).expanduser()

# Volúmenes locales predeterminados
ROOTS = {
    'trabajo': (str(DATA_DIR / 'trabajo'), 'Trabajo · disco del sistema', True),
    'archivo': (str(DATA_DIR / 'archivo'), 'Trabajo · disco multimedia', True),
    'fotos': (str(DATA_DIR / 'fotos'), 'Fotografías', True),
    'videos': (str(DATA_DIR / 'videos'), 'Videos', True),
    'panorama': (str(DATA_DIR / 'panorama'), 'Videos panorámicos', True),
}

MEDIA = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
    '.webm': 'video/webm', '.ogg': 'video/ogg', '.ogv': 'video/ogg', '.mov': 'video/quicktime'
}
TEXT = set('.txt .md .php .html .htm .css .js .mjs .json .xml .yaml .yml .ini .conf .cfg .sh .py .sql .csv .log .toml'.split())
PROTECTED = ['/etc/shadow', '/etc/ssl/private', '/var/lib/360ya-seguridad']

MAX_TRANSFER = 512 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024

DIR = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

# Inicializar carpetas
STATE_DIR.mkdir(parents=True, exist_ok=True)
for root_path, _, _ in ROOTS.values():
    Path(root_path).mkdir(parents=True, exist_ok=True)
    (Path(root_path) / '.trash').mkdir(parents=True, exist_ok=True)

# Syscall renameat2
try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _renameat2 = _libc.renameat2
    _renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    _renameat2.restype = ctypes.c_int
except Exception:
    _renameat2 = None

def rename_new(src_fd, old_name, dst_fd, new_name):
    if _renameat2:
        if _renameat2(src_fd, os.fsencode(old_name), dst_fd, os.fsencode(new_name), 1) == 0:
            return
        err = ctypes.get_errno()
        if err != errno.EINVAL and err != errno.ENOSYS:
            raise OSError(err, os.strerror(err))
    raise OSError(errno.ENOTSUP,'El sistema de archivos no admite renombrado seguro')


class Failure(Exception):
    def __init__(self, status=400, message='Solicitud inválida'):
        super().__init__(message)
        self.status = status


def require(valid, message='Solicitud inválida', status=400):
    if not valid:
        raise Failure(status, message)


# Base de datos de auditoría e historial
def db():
    conn = sqlite3.connect(str(STATE_DIR / 'history.sqlite'), timeout=5)
    conn.row_factory = sqlite3.Row
    return conn

with contextlib.closing(db()) as conn, conn:
    conn.execute('''
        CREATE TABLE IF NOT EXISTS history (
            id TEXT PRIMARY KEY,
            time INTEGER,
            user TEXT,
            ip TEXT,
            operation TEXT,
            paths TEXT,
            result TEXT,
            error TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS authorizations (
            nonce TEXT PRIMARY KEY,
            sid TEXT,
            digest TEXT,
            snapshot TEXT,
            expires REAL
        )
    ''')

    conn.execute("""
        CREATE TABLE IF NOT EXISTS explorer_password (
            id INTEGER PRIMARY KEY CHECK (id=1), salt BLOB NOT NULL, digest BLOB NOT NULL
        )
    """)

# --- Sesiones ---
sessions = {}
login_attempts = {}
session_lock = threading.RLock()
TTL = 3600
mutation_lock = threading.RLock()

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.exception_handler(RequestValidationError)
async def invalid_request(_req,error):
    return JSONResponse({'detail':'Formato de solicitud inválido'},status_code=422)


@app.middleware('http')
async def response_headers(req,call_next):
    response = await call_next(req)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    return response


def password_digest(value, salt):
    return hashlib.scrypt(value.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64*1024*1024)


def password_matches(value):
    if len(value)>256:
        return False
    with contextlib.closing(db()) as conn:
        row = conn.execute('SELECT salt,digest FROM explorer_password WHERE id=1').fetchone()
    if row is not None:
        return hmac.compare_digest(password_digest(value,row['salt']),row['digest'])
    return hmac.compare_digest(value.encode(),PASSWORD.encode())


class LoginModel(BaseModel):
    password: str
    username: str | None = 'community'

class ConnectModel(BaseModel):
    host: str
    port: int = 22
    username: str
    password: str | None = None
    private_key: str | None = Field(default=None, max_length=65536)
    passphrase: str | None = Field(default=None, max_length=1024)
    fingerprint: str | None = None


def get_session(req: Request) -> dict | None:
    token = req.cookies.get('explorer_session')
    if not token:
        return None
    with session_lock:
        s = sessions.get(token)
        if not s or s['until'] < time.time():
            if s:
                sessions.pop(token, None)
            return None
        s['until'] = time.time() + TTL
        return s

def require_session(req: Request) -> dict:
    s = get_session(req)
    if not s:
        raise HTTPException(401, 'Sesión no válida o expirada')
    if req.method not in ('GET', 'HEAD'):
        csrf = req.headers.get('x-csrf-token') or req.headers.get('x-csrf')
        if not hmac.compare_digest(csrf or '',s['csrf']):
            raise HTTPException(403, 'Validación CSRF requerida')
    return s


# --- Cliente SSH/SFTP ---

class HostPin(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        import base64
        actual = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if not self.expected or not hmac.compare_digest(self.expected, actual):
            raise Failure(403, 'Verificá la huella del servidor SSH e ingresala para conectar: '+actual)


@contextlib.contextmanager
def sftp_client(s):
    conn = s.get('connection') if s else None
    require(conn, 'No hay conexión SFTP activa', 409)
    client = paramiko.SSHClient()
    if KNOWN_HOSTS.is_file():
        client.load_host_keys(str(KNOWN_HOSTS))
    client.set_missing_host_key_policy(HostPin(conn.get('fingerprint')))
    try:
        try:
            client.connect(conn['host'],port=conn['port'],username=conn['username'],
                           password=conn.get('password'),pkey=conn.get('pkey'),
                           timeout=10,banner_timeout=10,auth_timeout=10,channel_timeout=15,
                           allow_agent=False,look_for_keys=False)
            ftp = client.open_sftp()
            ftp.get_channel().settimeout(30)
        except paramiko.AuthenticationException:
            raise Failure(401,'Credenciales SSH rechazadas')
        except paramiko.BadHostKeyException:
            raise Failure(403,'Cambió la clave del servidor SSH')
        except (paramiko.SSHException,OSError,EOFError):
            raise Failure(502,'No se pudo establecer la conexión SFTP')
        with ftp:
            ftp.chdir(conn.get('home') or ftp.normalize('.'))
            yield ftp
    finally:
        client.close()


def sftp_path(path):
    names = parts(path)
    require(names[0]=='remote','Ruta SFTP inválida')
    return '/'.join(names[1:]) or '.'


def remote_info(ftp, path, missing=False):
    components = path.split('/')
    for index in range(1,len(components)):
        info = ftp.lstat('/'.join(components[:index]))
        require(stat.S_ISDIR(info.st_mode),'Directorio SFTP inválido o enlace',403)
    try:
        info = ftp.lstat(path)
    except FileNotFoundError:
        if missing:
            return None
        raise
    require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),
            'Archivo especial o enlace SFTP',403)
    return info


def remote_state(session,path,missing=False):
    with sftp_client(session) as ftp:
        remote = sftp_path(path)
        require(remote!='.','Raíz SFTP protegida',403)
        info = remote_info(ftp,remote,missing)
        return [0,0,[0,0,info.st_mtime,info.st_size,info.st_mode,info.st_uid,info.st_gid] if info else None]


# --- Operaciones de Rutas y Broker de Archivos ---

def parts(path: str):
    require(isinstance(path, str) and 0 < len(path.encode()) <= 1024, 'Ruta inválida')
    names = path.split('/')
    require(names[0] in ROOTS or names[0] == 'vps' or names[0] == 'remote', 'Raíz desconocida o no autorizada', 403)
    for name in names[1:]:
        require(name and not name.startswith('.') and len(name.encode()) <= 255 and
                not any(ord(c) < 32 or ord(c) == 127 for c in name) and '\\' not in name, 'Ruta no permitida', 403)
    return names

def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size, info.st_mode, info.st_uid, info.st_gid)

@contextlib.contextmanager
def directory(path: str, write: bool = False, trash: bool = False):
    names = parts(path)
    root = names[0]
    if root == 'vps':
        require(not write, 'Ubicación protegida de solo lectura',403)
        base = str(DATA_DIR)
        writable = False
    else:
        config = ROOTS[root]
        base = config[0]
        writable = config[2]
    require(not write or writable, 'Ubicación protegida de solo lectura', 403)
    fd = os.open(base, DIR)
    try:
        subnames = names[1:]
        if trash:
            require(writable and len(names) == 1, 'Papelera inválida')
            subnames.append('.trash')
        device = os.fstat(fd).st_dev
        for name in subnames:
            new = os.open(name, DIR, dir_fd=fd)
            os.close(fd)
            fd = new
            if root != 'vps':
                require(os.fstat(fd).st_dev == device, 'Límite de volumen cruzado', 403)
        yield fd
    finally:
        os.close(fd)

@contextlib.contextmanager
def parent(path: str, write: bool = False, trash: bool = False):
    names = parts(path)
    require(len(names) > 1, 'La raíz del volumen está protegida', 403)
    with directory('/'.join(names[:-1]), write, trash) as fd:
        yield names[0], fd, names[-1]

def checked(root, fd, name, missing=False):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'Archivo especial no permitido', 403)
        return info
    except FileNotFoundError:
        if missing:
            return None
        raise

def item(path, info):
    name = path.rsplit('/', 1)[-1]
    folder = stat.S_ISDIR(info.st_mode)
    extension = os.path.splitext(name)[1].lower()
    return dict(
        path=path,
        name=name,
        kind='folder' if folder else 'file',
        size=0 if folder else info.st_size,
        modified=int(info.st_mtime),
        mode=oct(stat.S_IMODE(info.st_mode))[2:],
        uid=info.st_uid,
        gid=info.st_gid,
        type='Carpeta' if folder else (extension[1:] or 'Archivo'),
        media=None if folder else MEDIA.get(extension),
        text=not folder and (extension in TEXT or extension == ''),
        version=':'.join(map(str, fingerprint(info)))
    )

def children(path, limit=25000, recursive=False):
    pending = [path]
    count = 0
    deadline = time.monotonic() + 5
    while pending:
        sub = pending.pop()
        try:
            with directory(sub) as fd, os.scandir(fd) as listing:
                for entry in listing:
                    count += 1
                    require(count <= limit and time.monotonic() < deadline,
                            'El directorio supera el límite. Elegí una carpeta más específica.', 422)
                    if entry.name.startswith('.') or any(ord(c) < 32 or ord(c) == 127 for c in entry.name) or '\\' in entry.name:
                        continue
                    try:
                        info = checked(parts(path)[0], fd, entry.name)
                    except (Failure, FileNotFoundError, UnicodeError, OSError):
                        continue
                    key = sub + '/' + entry.name
                    if recursive and stat.S_ISDIR(info.st_mode):
                        pending.append(key)
                    yield item(key, info)
        except (PermissionError, OSError):
            if sub == path:
                raise

def browse_remote(session,args,search=False):
    path = args.get('path','remote')
    remote = sftp_path(path)
    order = args.get('sort','name')
    require(order in ('name','modified','size','type'),'Orden inválido')
    page = max(0,int(args.get('page',0)))
    accept = search_filter(args) if search else lambda row: True
    pending = [(remote,path)]
    rows = []
    examined = 0
    with sftp_client(session) as ftp:
        remote_info(ftp,remote)
        while pending:
            directory_path,logical = pending.pop()
            for info in ftp.listdir_iter(directory_path):
                examined += 1
                require(examined<=25000,'La búsqueda supera el límite de elementos',422)
                name = info.filename
                if name.startswith('.') or '/' in name or chr(92) in name:
                    continue
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    continue
                child = logical+'/'+name
                row = remote_item(child,info)
                if search and row['kind']=='folder':
                    pending.append((posixpath.join(directory_path,name),child))
                if accept(row):
                    rows.append(row)
    rows.sort(key=lambda row: (str(row[order]).casefold() if isinstance(row[order],str) else row[order],row['path']),
              reverse=args.get('desc')=='1')
    rows.sort(key=lambda row:row['kind']!='folder')
    return dict(entries=rows[page*80:(page+1)*80],count=len(rows),available=0,capacity=0)


def remote_item(path,info):
    name = path.rsplit('/',1)[-1]
    directory = stat.S_ISDIR(info.st_mode)
    ext = os.path.splitext(name)[1].lower()
    return dict(path=path,name=name,kind='folder' if directory else 'file',
                size=0 if directory else info.st_size,modified=int(info.st_mtime),
                mode=oct(stat.S_IMODE(info.st_mode))[2:],uid=info.st_uid,gid=info.st_gid,
                type='Carpeta' if directory else ext[1:] or 'Archivo',
                media=None if directory else MEDIA.get(ext),
                text=not directory and (ext in TEXT or not ext),version=f'{info.st_mtime}:{info.st_size}')


def search_filter(args):
    filters = {key:args.get(key,'') for key in ('name','ext','after','before','min','max')}
    require(any(filters.values()),'Ingresá un filtro de búsqueda')
    try:
        after = datetime.date.fromisoformat(filters['after']).toordinal() if filters['after'] else 0
        before = datetime.date.fromisoformat(filters['before']).toordinal() if filters['before'] else 4000000
        minimum = int(filters['min']) if filters['min'] else 0
        maximum = int(filters['max']) if filters['max'] else 2**63
    except ValueError:
        raise Failure(400,'Fecha o tamaño inválido')
    extension = filters['ext'].lstrip('.').casefold()
    def accepts(row):
        name = row['name'].casefold()
        day = datetime.datetime.fromtimestamp(row['modified'],datetime.timezone.utc).date().toordinal()
        return (filters['name'].casefold() in name and (not extension or name.endswith('.'+extension))
                and minimum<=row['size']<=maximum and after<=day<=before)
    return accepts


def browse(args: dict, search=False, session: dict | None = None):
    path = args.get('path', 'trabajo')
    if path == 'remote' or path.startswith('remote/'):
        if not session or not session.get('connection'):
            raise Failure(409, 'Conectá primero un servidor VPS (SFTP)')
        return browse_remote(session, args, search)
        
    page = max(0, int(args.get('page', 0)))
    order = args.get('sort', 'name')
    require(order in ('name', 'modified', 'size', 'type'), 'Orden inválido')
    accept = search_filter(args) if search else lambda row: True
    rows = [row for row in children(path,25000,search) if accept(row)]

    def key_fn(entry):
        val = entry[order]
        return (val.casefold() if isinstance(val, str) else val, entry['path'])
        
    rows.sort(key=key_fn, reverse=(args.get('desc') == '1'))
    rows.sort(key=lambda e: e['kind'] != 'folder')
    
    try:
        with directory(path) as fd:
            fs = os.fstatvfs(fd)
            available = fs.f_bavail * fs.f_frsize
            capacity = fs.f_blocks * fs.f_frsize
    except Exception:
        available, capacity = 100 * 1024 * 1024 * 1024, 500 * 1024 * 1024 * 1024
        
    return dict(
        entries=rows[page * 80:(page + 1) * 80],
        count=len(rows),
        available=available,
        capacity=capacity
    )

def file_text(path: str, session: dict | None = None):
    if path.startswith('remote/'):
        if not session or not session.get('connection'):
            raise Failure(409, 'No hay conexión VPS activa')
        with sftp_client(session) as ftp:
            r_path = sftp_path(path)
            stat_info = remote_info(ftp,r_path)
            require(stat.S_ISREG(stat_info.st_mode),'Se requiere un archivo regular')
            require(stat_info.st_size <= MAX_TEXT, 'El archivo supera el límite de 2 MB del editor', 413)
            with ftp.open(r_path, 'rb') as f:
                data = f.read(MAX_TEXT + 1)
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                raise Failure(415, 'El archivo no tiene codificación UTF-8')
            return {'text': text, 'version': f"{stat_info.st_mtime}:{stat_info.st_size}"}
            
    with parent(path) as (root, fd, name):
        info = checked(root, fd, name)
        require(stat.S_ISREG(info.st_mode), 'Se requiere un archivo regular')
        require(info.st_size <= MAX_TEXT, 'El archivo supera el límite de 2 MB del editor', 413)
        with os.fdopen(os.open(name, os.O_RDONLY | FILE, dir_fd=fd), 'rb') as f:
            data = f.read()
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            raise Failure(415, 'El archivo no tiene codificación UTF-8')
        return {'text': text, 'version': ':'.join(map(str, fingerprint(info)))}

def properties_info(path: str, session: dict | None = None):
    if path.startswith('remote/'):
        if not session or not session.get('connection'):
            raise Failure(409, 'No hay conexión VPS activa')
        with sftp_client(session) as ftp:
            r_path = sftp_path(path)
            x = remote_info(ftp,r_path)
            return remote_item(path,x)
    with parent(path) as (root, fd, name):
        return item(path, checked(root, fd, name))

def trash_record(path: str):
    with parent(path, True, True) as (root, fd, name):
        require(re.fullmatch(r'[a-f0-9]{32}', name), 'Elemento de papelera inválido')
        info = checked(root, fd, name)
        with os.fdopen(os.open(name + '.json', os.O_RDONLY | FILE, dir_fd=fd), 'rb') as meta:
            record = json.load(meta)
        return record, fingerprint(info)

def trash_list(session=None):
    result = []
    for root, config in ROOTS.items():
        if not config[2]:
            continue
        try:
            with directory(root, True, True) as fd:
                for name in os.listdir(fd):
                    if re.fullmatch(r'[a-f0-9]{32}', name):
                        try:
                            record, identity = trash_record(root + '/' + name)
                            result.append(record | {'size': identity[3], 'folder': stat.S_ISDIR(identity[4])})
                        except Exception:
                            continue
        except Exception:
            continue
    if session and session.get('connection'):
        with sftp_client(session) as ftp:
            try:
                remote_trash(ftp)
            except FileNotFoundError:
                pass
            else:
                for name in ftp.listdir('.trash'):
                    if re.fullmatch(r'[a-f0-9]{32}',name):
                        with ftp.open('.trash/'+name+'.json','r') as stream:
                            record = json.loads(stream.read(8192))
                        info = remote_info(ftp,'.trash/'+name)
                        result.append(record | {'size':info.st_size,'folder':stat.S_ISDIR(info.st_mode)})
    return sorted(result, key=lambda row: row.get('deleted', 0), reverse=True)

def history_list(page: int = 0):
    with contextlib.closing(db()) as connection:
        offset = max(0, page) * 80
        rows = connection.execute('SELECT * FROM history ORDER BY rowid DESC LIMIT 80 OFFSET ?', (offset,)).fetchall()
        return [dict(r) for r in rows]

def audit(request_info: dict, status: str, error: str | None = None, ident: str | None = None):
    ident = ident or secrets.token_hex(16)
    op = request_info.get('args', {})
    locs = {k: op[k] for k in ('path', 'target', 'pairs', 'paths') if k in op}
    with contextlib.closing(db()) as connection, connection:
        connection.execute(
            'INSERT INTO history VALUES (?,?,?,?,?,?,?,?)',
            (ident, int(time.time()), request_info.get('user', 'community'), request_info.get('ip', '127.0.0.1'),
             str(op.get('op', 'session'))[:40], json.dumps(locs, ensure_ascii=True), status, error)
        )
    return ident

def preserve(root, fd, name, original, user):
    key = secrets.token_hex(16)
    with directory(root, True, True) as bin_fd:
        record = dict(id=root + '/' + key, original=original, deleted=time.time(), user=user)
        with os.fdopen(os.open(key + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o600, dir_fd=bin_fd), 'w') as meta:
            json.dump(record, meta)
            meta.flush()
            os.fsync(meta.fileno())
        try:
            rename_new(fd, name, bin_fd, key)
        except OSError:
            os.unlink(key + '.json', dir_fd=bin_fd)
            raise
        os.fsync(bin_fd)
        os.fsync(fd)
    return key

def remove_entry(fd, name):
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(name, dir_fd=fd)
    else:
        os.unlink(name, dir_fd=fd)

def copy_entry(root, src_fd, name, dst_fd, temp_name, budget, depth=0):
    require(depth <= 32, 'Demasiados niveles de anidamiento', 422)
    info = checked(root, src_fd, name)
    budget[1] -= 1
    require(budget[1] >= 0, 'Demasiados elementos a copiar', 422)
    if stat.S_ISDIR(info.st_mode):
        os.mkdir(temp_name, 0o750, dir_fd=dst_fd)
        with contextlib.ExitStack() as stack:
            source = os.open(name, DIR, dir_fd=src_fd)
            stack.callback(os.close, source)
            dest = os.open(temp_name, DIR, dir_fd=dst_fd)
            stack.callback(os.close, dest)
            with os.scandir(source) as listing:
                for entry in listing:
                    copy_entry(root, source, entry.name, dest, entry.name, budget, depth + 1)
            os.fsync(dest)
    else:
        budget[0] -= info.st_size
        require(budget[0] >= 0, 'Transferencia superior al límite de 2 GiB', 413)
        with os.fdopen(os.open(name, os.O_RDONLY | FILE, dir_fd=src_fd), 'rb') as src, \
             os.fdopen(os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o644, dir_fd=dst_fd), 'wb') as dst:
            shutil.copyfileobj(src, dst, length=1024*1024)
            dst.flush()
            os.fsync(dst.fileno())

def target_state(path, write=False, missing=False):
    with parent(path, write) as (root, fd, name):
        info = checked(root, fd, name, missing)
        return [*fingerprint(os.fstat(fd))[:2], fingerprint(info) if info else None]

def is_remote(path):
    return path=='remote' or path.startswith('remote/')


def remote_trash(ftp, create=False):
    try:
        remote_info(ftp,'.trash')
    except FileNotFoundError:
        if not create:
            raise
        ftp.mkdir('.trash',mode=0o700)
    require(stat.S_ISDIR(remote_info(ftp,'.trash').st_mode),'Papelera SFTP inválida',403)


def remote_trash_record(session,path):
    key = sftp_path(path)
    require(bool(re.fullmatch(r'[a-f0-9]{32}',key)),'Papelera inválida')
    with sftp_client(session) as ftp:
        remote_trash(ftp)
        info = remote_info(ftp,'.trash/'+key)
        with ftp.open('.trash/'+key+'.json','r') as stream:
            record = json.loads(stream.read(8192))
        require(is_remote(record['original']) and sftp_path(record['original'])!='.','Papelera inválida')
        return record, [0,0,info.st_mtime,info.st_size,info.st_mode,info.st_uid,info.st_gid]


def remote_preserve(ftp,path,original,user):
    remote_trash(ftp,True)
    key = secrets.token_hex(16)
    dest = '.trash/'+key
    with ftp.open(dest+'.json','wx') as stream:
        stream.write(json.dumps(dict(id='remote/'+key,original=original,deleted=time.time(),user=user)))
    try:
        ftp.rename(path,dest)
    except OSError:
        ftp.remove(dest+'.json')
        raise
    return dest


def remote_remove(ftp,path):
    if stat.S_ISDIR(ftp.lstat(path).st_mode):
        for name in ftp.listdir(path):
            remote_remove(ftp,path+'/'+name)
        ftp.rmdir(path)
    else:
        ftp.remove(path)


def plan_state(path,session,write=False,missing=False):
    return remote_state(session,path,missing) if is_remote(path) else target_state(path,write,missing)


def stream_copy(source,destination,budget):
    while chunk := source.read(1024*1024):
        budget[0] -= len(chunk)
        require(budget[0]>=0,'Transferencia superior al límite de 2 GiB',413)
        destination.write(chunk)


def copy_remote_tree(ftp,remote,fd,name,budget,to_remote,depth=0):
    budget[1] -= 1
    require(depth<=32 and budget[1]>=0,'Demasiados elementos o niveles',422)
    info = os.stat(name,dir_fd=fd,follow_symlinks=False) if to_remote else remote_info(ftp,remote)
    if stat.S_ISDIR(info.st_mode):
        if to_remote:
            ftp.mkdir(remote,mode=0o750)
            entries = None
            child = os.open(name,DIR,dir_fd=fd)
        else:
            os.mkdir(name,0o750,dir_fd=fd)
            child = os.open(name,DIR,dir_fd=fd)
            entries = ftp.listdir(remote)
        try:
            for entry in os.listdir(child) if entries is None else entries:
                require(entry not in ('.','..','.trash') and '/' not in entry,'Nombre no permitido',403)
                copy_remote_tree(ftp,remote+'/'+entry,child,entry,budget,to_remote,depth+1)
        finally:
            os.close(child)
    else:
        require(stat.S_ISREG(info.st_mode),'Archivo especial no permitido',403)
        flags = os.O_RDONLY | FILE if to_remote else os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE
        with os.fdopen(os.open(name,flags,0o640,dir_fd=fd),'rb' if to_remote else 'wb') as local, \
             ftp.open(remote,'wx' if to_remote else 'rb') as other:
            stream_copy(local if to_remote else other,other if to_remote else local,budget)


def remote_install(ftp,temp,dest,logical,user):
    old = remote_preserve(ftp,dest,logical,user) if remote_info(ftp,dest,True) else None
    try:
        ftp.rename(temp,dest)
    except OSError:
        if old:
            ftp.rename(old,dest)
            ftp.remove(old+'.json')
        raise


def local_install(root,fd,temp,name,logical,user):
    old = preserve(root,fd,name,logical,user) if checked(root,fd,name,True) else None
    try:
        rename_new(fd,temp,fd,name)
    except OSError:
        if old:
            with directory(root,True,True) as trash_fd:
                rename_new(trash_fd,old,fd,name)
                os.unlink(old+'.json',dir_fd=trash_fd)
        raise


def transfer_remote(session,src,dst,action,user,budget):
    incoming = is_remote(src)
    outgoing = is_remote(dst)
    with sftp_client(session) as ftp:
        source = sftp_path(src) if incoming else None
        dest = sftp_path(dst) if outgoing else None
        if incoming and outgoing and action=='move':
            remote_install(ftp,source,dest,dst,user)
            return
        temp = (posixpath.dirname(dest)+'/' if outgoing and '/' in dest else '')+'.tmp-'+secrets.token_hex(16)
        with contextlib.ExitStack() as stack:
            if incoming and outgoing:
                scratch = stack.enter_context(tempfile.TemporaryDirectory(dir=STATE_DIR))
                fd = os.open(scratch,DIR)
                stack.callback(os.close,fd)
                copy_remote_tree(ftp,source,fd,'source',budget,False)
                name = 'source'
            elif outgoing:
                root,fd,name = stack.enter_context(parent(src,action=='move'))
            else:
                root,fd,name = stack.enter_context(parent(dst,True))
            try:
                if outgoing:
                    remote_info(ftp,posixpath.dirname(dest) or '.')
                    copy_remote_tree(ftp,temp,fd,name,budget,True)
                    remote_install(ftp,temp,dest,dst,user)
                else:
                    copy_remote_tree(ftp,source,fd,temp,budget,False)
                    local_install(root,fd,temp,name,dst,user)
                if action=='move':
                    if incoming:
                        remote_preserve(ftp,source,src,user)
                    else:
                        preserve(root,fd,name,src,user)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    if outgoing:
                        remote_remove(ftp,temp)
                    else:
                        remove_entry(fd,temp)


def plan(op, session: dict | None = None):
    kind = op['op']
    if kind in ('copy', 'move'):
        pairs = op['pairs']
        require(isinstance(pairs, list) and all(isinstance(p, list) and len(p) == 2 for p in pairs))
        result = []
        for src, dst in pairs:
            first = plan_state(src,session,kind=='move')
            second = plan_state(dst,session,True,True)
            if second[2]:
                require(op.get('replace') and stat.S_ISREG(second[2][4]) and stat.S_ISREG(first[2][4]),
                        'Ya existe un elemento en ' + dst, 409)
            result.append([first, second])
        return result
    if kind in ('delete', 'purge', 'restore'):
        result = []
        for path in op['paths']:
            if kind == 'delete':
                result.append(plan_state(path,session,True))
            else:
                record, identity = remote_trash_record(session,path) if is_remote(path) else trash_record(path)
                row = [record, identity]
                if kind == 'restore':
                    dest = plan_state(record['original'],session,True,True)
                    if dest[2]:
                        require(op.get('replace') and stat.S_ISREG(dest[2][4]) and stat.S_ISREG(identity[4]),
                                'Ya existe un elemento en ' + record['original'], 409)
                    row.append(dest)
                result.append(row)
        return result
    path = op['target']
    state = plan_state(path,session,True,kind in ('create','upload'))
    if kind == 'create':
        require(op['kind'] in ('file', 'folder'))
        require(state[2] is None, 'El destino ya existe', 409)
    elif kind == 'upload':
        require(state[2] is None or (op.get('replace') and stat.S_ISREG(state[2][4])), 'El destino ya existe', 409)
    elif kind == 'edit':
        require(stat.S_ISREG(state[2][4]), 'El archivo no es regular', 415)
        if op.get('version') is not None:
            require(op['version']==file_text(path,session)['version'],'El texto cambió desde que lo abriste',409)
        require(len(op['text'].encode()) <= MAX_TEXT, 'El texto supera el límite de 2 MB', 413)
    elif kind == 'chmod':
        require(re.fullmatch(r'0?[0-7]{3}', str(op['mode'])), 'Modo octal inválido')
    return state

def execute(op, user, upload_file, snapshot, session: dict | None = None):
    action = op['op']
    if action in ('copy', 'move'):
        budget = [2 * 1024 * 1024 * 1024, 10000, action == 'move']
        for src, dst in op['pairs']:
            if is_remote(src) or is_remote(dst):
                transfer_remote(session,src,dst,action,user,budget)
                continue
            with parent(src, action == 'move') as (sr, sfd, sn), parent(dst, True) as (dr, dfd, dn):
                old = checked(dr, dfd, dn, True)
                temp = '.tmp-' + secrets.token_hex(16)
                if action == 'move' and os.fstat(sfd).st_dev == os.fstat(dfd).st_dev:
                    backup = preserve(dr,dfd,dn,dst,user) if old else None
                    try:
                        rename_new(sfd,sn,dfd,dn)
                    except OSError as error:
                        if backup:
                            with directory(dr,True,True) as trash_fd:
                                rename_new(trash_fd,backup,dfd,dn)
                                os.unlink(backup+'.json',dir_fd=trash_fd)
                        if error.errno!=errno.EXDEV:
                            raise
                    else:
                        continue
                try:
                    copy_entry(sr, sfd, sn, dfd, temp, budget)
                    local_install(dr,dfd,temp,dn,dst,user)
                    if action == 'move':
                        preserve(sr, sfd, sn, src, user)
                finally:
                    try:
                        remove_entry(dfd,temp)
                    except OSError:
                        pass
        return

    if action in ('delete', 'purge', 'restore'):
        for index, path in enumerate(op['paths']):
            if is_remote(path):
                with sftp_client(session) as ftp:
                    key = sftp_path(path)
                    if action=='delete':
                        remote_preserve(ftp,key,path,user)
                    else:
                        trash_path = '.trash/'+key
                        if action=='purge':
                            remote_remove(ftp,trash_path)
                        else:
                            original = snapshot[index][0]['original']
                            remote_install(ftp,trash_path,sftp_path(original),original,user)
                        ftp.remove(trash_path+'.json')
                continue
            if action == 'delete':
                with parent(path, True) as (root, fd, name):
                    preserve(root, fd, name, path, user)
                continue
            with parent(path, True, True) as (root, fd, name):
                if action == 'purge':
                    remove_entry(fd, name)
                else:
                    dest = snapshot[index][0]['original']
                    with parent(dest, True) as (dr, dfd, dn):
                        old = preserve(dr,dfd,dn,dest,user) if checked(dr,dfd,dn,True) else None
                        try:
                            rename_new(fd,name,dfd,dn)
                        except OSError:
                            if old:
                                rename_new(fd,old,dfd,dn)
                                os.unlink(old+'.json',dir_fd=fd)
                            raise
                try:
                    os.unlink(name + '.json', dir_fd=fd)
                except OSError:
                    pass
        return

    path = op['target']
    if is_remote(path):
        with sftp_client(session) as ftp:
            dest = sftp_path(path)
            if action=='chmod':
                ftp.chmod(dest,int(str(op['mode']),8))
            elif action=='create' and op['kind']=='folder':
                ftp.mkdir(dest,mode=0o750)
            else:
                tmp = posixpath.join(posixpath.dirname(dest),'.tmp-'+secrets.token_hex(16))
                try:
                    with ftp.open(tmp,'wx') as output:
                        if action=='edit':
                            output.write(op['text'].encode())
                        elif action=='upload':
                            stream_copy(upload_file.file,output,[MAX_TRANSFER])
                    remote_install(ftp,tmp,dest,path,user)
                finally:
                    with contextlib.suppress(FileNotFoundError):
                        ftp.remove(tmp)
        return

    with parent(path, True) as (root, fd, name):
        if action == 'create':
            if op['kind'] == 'folder':
                os.mkdir(name, 0o755, dir_fd=fd)
            else:
                os.close(os.open(name, os.O_WRONLY | FILE | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=fd))
        elif action == 'chmod':
            mode = int(str(op['mode']), 8)
            info = checked(root, fd, name)
            target_fd = os.open(name, DIR if stat.S_ISDIR(info.st_mode) else (os.O_RDONLY | FILE), dir_fd=fd)
            try:
                os.fchmod(target_fd, mode)
            finally:
                os.close(target_fd)
        elif action == 'edit':
            temp = '.tmp-' + secrets.token_hex(16)
            old = checked(root, fd, name, True)
            try:
                data = op['text'].encode('utf-8')
                with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o644, dir_fd=fd), 'wb') as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
                local_install(root,fd,temp,name,path,user)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except OSError:
                    pass
        elif action == 'upload':
            temp = '.tmp-' + secrets.token_hex(16)
            old = checked(root, fd, name, True)
            try:
                with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o644, dir_fd=fd), 'wb') as dst:
                    if hasattr(upload_file, 'file'):
                        shutil.copyfileobj(upload_file.file, dst, length=1024*1024)
                    elif hasattr(upload_file, 'read'):
                        shutil.copyfileobj(upload_file, dst, length=1024*1024)
                    dst.flush()
                    os.fsync(dst.fileno())
                local_install(root,fd,temp,name,path,user)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except OSError:
                    pass


# --- Rutas Web y Frontend ---

@app.get('/')
@app.get('/explorer')
def index_page(req: Request):
    s = get_session(req)
    if s:
        return FileResponse(STATIC_DIR / 'shell.html')
    return FileResponse(STATIC_DIR / 'login-start.html')

@app.get('/explorer-worker.js')
def explorer_worker():
    return FileResponse(STATIC_DIR / 'worker.js',media_type='application/javascript',
                        headers={'Service-Worker-Allowed':'/explorer'})


@app.get('/explorer/assets/{name:path}')
@app.get('/static/{name:path}')
def static_assets(name: str):
    file_path = STATIC_DIR / name
    if not file_path.is_file() or not file_path.resolve().is_relative_to(STATIC_DIR.resolve()):
        raise HTTPException(404, 'Archivo no encontrado')
    media_type = 'text/css' if name.endswith('.css') else ('application/javascript' if name.endswith('.js') else None)
    if name == 'manifest.webmanifest':
        media_type = 'application/manifest+json'
    return FileResponse(file_path, media_type=media_type)

@app.get('/explorer/view')
@app.get('/view')
def view_page(req: Request):
    require_session(req)
    return FileResponse(STATIC_DIR / 'view.html')


# --- Autenticación y Conexión ---

def verify_password_attempt(req,password):
    ip = req.client.host if req.client else 'unknown'
    now = time.monotonic()
    for key in [key for key,(until,_) in login_attempts.items() if until<=now]:
        login_attempts.pop(key)
    until,count = login_attempts.get(ip,(now+60,0))
    if count>=10:
        raise HTTPException(429,'Demasiados intentos. Reintentá en un minuto.')
    if not password_matches(password):
        login_attempts[ip] = until,count+1
        raise HTTPException(401,'Contraseña incorrecta')
    login_attempts.pop(ip,None)


class PasswordChange(BaseModel):
    current: str = Field(max_length=256)
    replacement: str = Field(min_length=12,max_length=256)


@app.post('/api/password')
def api_change_password(req: Request, body: PasswordChange):
    with mutation_lock, session_lock:
        require_session(req)
        verify_password_attempt(req,body.current)
        if hmac.compare_digest(body.current.encode(),body.replacement.encode()):
            raise HTTPException(400,'Elegí una contraseña distinta de la actual')
        salt = secrets.token_bytes(16)
        digest = password_digest(body.replacement,salt)
        with contextlib.closing(db()) as conn, conn:
            conn.execute('INSERT OR REPLACE INTO explorer_password VALUES (1,?,?)',(salt,digest))
            conn.execute('DELETE FROM authorizations')
        sessions.clear()
    response = JSONResponse({'data':{'changed':True}})
    response.delete_cookie('explorer_session',path='/')
    return response


@app.post('/api/login')
@app.post('/explorer/api/login')
def api_login(req: Request, body: LoginModel):
    origin = req.headers.get('origin')
    if origin and origin != str(req.base_url).rstrip('/'):
        raise HTTPException(403,'Origen inválido')
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    with session_lock:
        verify_password_attempt(req,body.password)
        now = time.time()
        for expired in [key for key,value in sessions.items() if value['until']<now]:
            sessions.pop(expired,None)
        sessions.pop(req.cookies.get('explorer_session'),None)
        sessions[token] = {
            'csrf': csrf,
            'user': body.username or 'community',
            'until': time.time() + TTL,
            'connection': None,
            'unlocked_until': 0
        }
    r = JSONResponse({'data': {'csrf': csrf, 'ok': True}, 'csrf': csrf})
    r.set_cookie(
        'explorer_session', token,
        httponly=True, samesite='strict',
        secure=os.environ.get('EXPLORER_HTTPS') == '1',
        max_age=TTL, path='/'
    )
    return r

@app.post('/api/logout')
def api_logout(req: Request):
    require_session(req)
    token = req.cookies.get('explorer_session')
    if token:
        with mutation_lock, session_lock:
            sessions.pop(token, None)
    r = JSONResponse({'data': {'loggedOut': True}, 'ok': True})
    r.delete_cookie('explorer_session', path='/')
    return r

@app.get('/api/session')
def api_session(req: Request):
    s = require_session(req)
    conn = s.get('connection') or {}
    return {
        'data': {
            'csrf': s['csrf'],
            'email': 'FREE & OPEN SOURCE FOREVER',
            'version': 'Community 1.0.1',
            'user': s['user'],
            'connected': bool(s.get('connection')),
            'host': conn.get('host')
        },
        'csrf': s['csrf'],
        'connected': bool(s.get('connection')),
        'host': conn.get('host')
    }

@app.post('/api/connect')
def api_connect(req: Request, body: ConnectModel):
    s = require_session(req)
    if not re.fullmatch(r'[A-Za-z0-9.:%_-]{1,253}',body.host) or not 1 <= body.port <= 65535 or not body.username.strip():
        raise HTTPException(400,'Datos de conexión incompletos')
    if not body.private_key and not body.password:
        raise HTTPException(400,'Ingresá contraseña SSH o clave privada')
    conn = dict(host=body.host,port=body.port,username=body.username,password=body.password,
                fingerprint=body.fingerprint, generation=secrets.token_hex(16))
    if body.private_key:
        for key_type in (paramiko.Ed25519Key,paramiko.ECDSAKey,paramiko.RSAKey):
            try:
                conn['pkey'] = key_type.from_private_key(io.StringIO(body.private_key),password=body.passphrase)
                break
            except (paramiko.SSHException,ValueError):
                continue
        else:
            raise HTTPException(400,'Clave SSH inválida o frase de paso incorrecta')
    try:
        with sftp_client({'connection':conn}) as ftp:
            conn['home'] = ftp.getcwd()
        with mutation_lock:
            s['connection'] = conn
        return {'host':body.host,'home':'remote'}
    except Failure as error:
        raise HTTPException(error.status,str(error))


@app.post('/api/disconnect')
def api_disconnect(req: Request):
    s = require_session(req)
    with mutation_lock:
        s['connection'] = None
    return {'data':{'ok':True}}


# --- Endpoint Central Explorer API ---

def byte_range(header,size):
    if not header:
        return 0,size-1,200
    match = re.fullmatch(r'bytes=(\d{0,18})-(\d{0,18})',header)
    if match and size and any(match.groups()):
        left,right = match.groups()
        if left:
            start,end = int(left),min(size-1,int(right)) if right else size-1
        else:
            start,end = max(0,size-int(right)),size-1
        if start<=end:
            return start,end,206
    raise HTTPException(416,'Rango no válido',headers={'Content-Range':f'bytes */{size}'})


def stream_range(stream,start,count):
    stream.seek(start)
    while count:
        block = stream.read(min(count,256*1024))
        if not block:
            break
        count -= len(block)
        yield block


@app.get('/explorer/api')
def explorer_api_get(req: Request):
    s = require_session(req)
    params = req.query_params
    op = params.get('op', 'roots')
    
    if op == 'session':
        return {
            'data': {
                'csrf': s['csrf'],
                'email': 'FREE & OPEN SOURCE FOREVER',
                'version': 'Community 1.0.1',
                'user': s['user']
            }
        }
        
    if op == 'roots':
        vols = [{'name': 'Local · datos', 'path': 'vps', 'writable': False}]
        for k, v in ROOTS.items():
            vols.append({'name': v[1], 'path': k, 'writable': v[2]})
        if s.get('connection'):
            vols.append({'name': f"VPS · {s['connection']['host']}", 'path': 'remote', 'writable': True})
        return {'data': {'volumes': vols, 'protected': PROTECTED}}
        
    if op in ('list', 'search'):
        try:
            return {'data': browse(dict(params), search=(op == 'search'), session=s)}
        except Failure as f:
            raise HTTPException(f.status, str(f))
        except HTTPException:
            raise
        except FileNotFoundError:
            raise HTTPException(404,'No se encontró el elemento')
        except PermissionError:
            raise HTTPException(403,'Permiso denegado')
        except (OSError,paramiko.SSHException):
            raise HTTPException(502,'Error de acceso a los archivos')
            
    if op == 'properties':
        try:
            return {'data': properties_info(params['path'], session=s)}
        except Failure as f:
            raise HTTPException(f.status, str(f))
            
    if op == 'text':
        try:
            return {'data': file_text(params['path'], session=s)}
        except Failure as f:
            raise HTTPException(f.status, str(f))
            
    if op == 'trash':
        return {'data': trash_list(s)}
        
    if op == 'history':
        page = int(params.get('page', 0))
        return {'data': history_list(page)}
        
    if op == 'tree':
        path = params.get('path', 'trabajo')
        try:
            if path.startswith('remote'):
                entries = [e for e in browse_remote(s, {'path': path})['entries'] if e['kind'] == 'folder']
            else:
                entries = [e for e in children(path, 500) if e['kind'] == 'folder']
            return {'data': entries}
        except Exception:
            return {'data': []}
            
    if op in ('media', 'download'):
        path = params['path']
        try:
            if path.startswith('remote'):
                r_path = sftp_path(path)
                filename = posixpath.basename(r_path)
                mime = MEDIA.get(os.path.splitext(filename)[1].lower(), 'application/octet-stream')
                disposition = 'inline' if op == 'media' else f'attachment; filename="{quote(filename)}"'
                with sftp_client(s) as ftp:
                    info = remote_info(ftp,r_path)
                    require(stat.S_ISREG(info.st_mode),'Se requiere un archivo regular')
                start,end,status = byte_range(req.headers.get('range'),info.st_size)
                def iter_remote():
                    with sftp_client(s) as ftp:
                        remote_info(ftp,r_path)
                        with ftp.open(r_path,'rb') as f:
                            yield from stream_range(f,start,end-start+1)
                headers = {
                    'Content-Type': mime,
                    'Content-Disposition': disposition,
                    'Accept-Ranges':'bytes',
                    'Content-Length':str(end-start+1),
                }
                if status==206:
                    headers['Content-Range']=f'bytes {start}-{end}/{info.st_size}'
                return StreamingResponse(iter_remote(),status_code=status,headers=headers)

            with parent(path) as (root, fd, name):
                info = checked(root, fd, name)
                mime = MEDIA.get(os.path.splitext(name)[1].lower(), 'application/octet-stream')
                disposition = 'inline' if op == 'media' else f'attachment; filename="{quote(name)}"'
                
                # Soporte de Range Requests para streaming multimedia
                require(stat.S_ISREG(info.st_mode),'Se requiere un archivo regular')
                file_size = info.st_size
                start,end,status_code = byte_range(req.headers.get('range'),file_size)

                length = max(0, end - start + 1)
                
                def iter_file(start_pos, total_len):
                    with parent(path) as (r, f_fd, fn):
                        with os.fdopen(os.open(fn, os.O_RDONLY | FILE, dir_fd=f_fd), 'rb') as f:
                            yield from stream_range(f,start_pos,total_len)

                headers = {
                    'Content-Type': mime,
                    'Content-Disposition': disposition,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': str(length),
                }
                if status_code == 206:
                    headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
                    
                return StreamingResponse(iter_file(start, length), status_code=status_code, headers=headers)
        except Failure as f:
            raise HTTPException(f.status, str(f))
        except HTTPException:
            raise
        except FileNotFoundError:
            raise HTTPException(404,'No se encontró el elemento')
        except PermissionError:
            raise HTTPException(403,'Permiso denegado')
        except (OSError,paramiko.SSHException):
            raise HTTPException(502,'Error de acceso a los archivos')
            
    raise HTTPException(404, f'Operación {op} desconocida')


@app.post('/explorer/api')
async def explorer_api_post(
    req: Request,
    request: str = Form(None),
    file: UploadFile = File(None)
):
    s = require_session(req)
    
    if request:
        try:
            body = json.loads(request)
        except Exception:
            raise HTTPException(400, 'JSON multipart inválido')
    else:
        try:
            body = await req.json()
        except Exception:
            raise HTTPException(400, 'JSON inválido')
            
    if not isinstance(body,dict):
        raise HTTPException(400,'Se esperaba un objeto JSON')
    op = body.get('op')
    
    if op == 'logout':
        token = req.cookies.get('explorer_session')
        if token:
            with mutation_lock, session_lock:
                sessions.pop(token, None)
        r = JSONResponse({'data': {'loggedOut': True}})
        r.delete_cookie('explorer_session', path='/')
        return r
        
    if op == 'unlockSystem':
        pwd = body.get('password', '')
        if not isinstance(pwd,str) or not password_matches(pwd):
            raise HTTPException(401, 'Contraseña incorrecta')
        s['unlocked_until'] = time.time() + 600
        return {'data': {'unlocked': True}}
        
    return await run_in_threadpool(mutate, req, s, body, file)


def mutation_body(body, file):
    fields = {
        'create': ('target','kind'), 'edit': ('target','text','version'),
        'chmod': ('target','mode'), 'upload': ('target','replace'),
        'copy': ('pairs','replace'), 'move': ('pairs','replace'),
        'delete': ('paths',), 'purge': ('paths',), 'restore': ('paths','replace'),
    }
    op = body.get('op')
    require(isinstance(op,str) and op in fields,'Operación inválida')
    required = fields[op]
    require(all(key in body or key in ('version','replace') for key in required),'Faltan datos de la operación')
    clean = {'op':op, **{key:body.get(key,False if key=='replace' else None) for key in required}}
    if 'replace' in clean:
        require(type(clean['replace']) is bool,'Reemplazo inválido')
    if 'pairs' in clean:
        pairs = clean['pairs']
        require(isinstance(pairs,list) and 0<len(pairs)<=50,'Seleccioná entre 1 y 50 elementos')
        require(all(isinstance(pair,list) and len(pair)==2 for pair in pairs),'Transferencia inválida')
        for src,dst in pairs:
            parts(src)
            parts(dst)
            require(src!=dst and not dst.startswith(src+'/'),'Origen y destino superpuestos',409)
        sources = [p[0] for p in pairs]
        destinations = [p[1] for p in pairs]
        require(len(set(sources))==len(sources) and len(set(destinations))==len(destinations) and
                not set(sources)&set(destinations),'La selección contiene rutas superpuestas',409)
    if 'paths' in clean:
        paths = clean['paths']
        require(isinstance(paths,list) and 0<len(paths)<=50,'Seleccioná entre 1 y 50 elementos')
        for path in paths:
            parts(path)
        require(len(set(paths))==len(paths) and not any(
            other.startswith(path+'/') for path in paths for other in paths),'La selección contiene rutas superpuestas',409)
    if 'target' in clean:
        parts(clean['target'])
    if op=='create':
        require(clean['kind'] in ('file','folder'),'Tipo de elemento inválido')
    if op=='edit':
        require(isinstance(clean['text'],str) and len(clean['text'].encode())<=MAX_TEXT,'Texto inválido',413)
    if op=='chmod':
        require(bool(re.fullmatch(r'0?[0-7]{3}',str(clean['mode']))),'Modo octal inválido')
    require((file is not None)==(op=='upload'),'Archivo de subida requerido')
    if file:
        require(file.size is not None and file.size<=MAX_TRANSFER,'La subida supera el límite',413)
        clean['upload_digest'] = hashlib.file_digest(file.file,'sha256').hexdigest()
        file.file.seek(0)
    return clean


def mutate(req,s,body,file):
    try:
        return mutate_operation(req,s,body,file)
    except Failure as error:
        raise HTTPException(error.status,str(error))
    except (paramiko.SSHException,EOFError):
        raise HTTPException(502,'Se interrumpió la conexión SFTP')
    except OSError as error:
        status, message = {
            errno.ENOENT:(404,'El elemento o su carpeta ya no existe'),
            errno.EACCES:(403,'Permiso de archivos denegado'),
            errno.EPERM:(403,'Permiso de archivos denegado'),
            errno.EEXIST:(409,'El destino ya existe'),
            errno.ENOTDIR:(409,'La ruta no es un directorio'),
            errno.ENOSPC:(507,'No hay espacio disponible'),
        }.get(error.errno,(502,'Falló una operación del sistema de archivos'))
        raise HTTPException(status,message)


def mutate_operation(req,s,body,file):
    clean = mutation_body(body,file)
    phase = body.get('phase')
    require(phase in ('prepare','execute'),'Fase de autorización inválida')
    if phase=='execute':
        password = body.get('password')
        require(isinstance(password,str) and password_matches(password),'Contraseña de Explorer incorrecta',401)
    sid = req.cookies.get('explorer_session')
    with mutation_lock:
        require(get_session(req) is s,'Sesión no válida o expirada',401)
        generation = (s.get('connection') or {}).get('generation')
        digest = hashlib.sha256(json.dumps([clean,generation],sort_keys=True).encode()).hexdigest()
        if phase=='prepare':
            snapshot = plan(clean,session=s)
            nonce = secrets.token_hex(32)
            with contextlib.closing(db()) as connection, connection:
                connection.execute('DELETE FROM authorizations WHERE expires < ?', (time.time(),))
                connection.execute('INSERT INTO authorizations VALUES (?,?,?,?,?)',
                                   (nonce,sid,digest,json.dumps(snapshot),time.time()+180))
            return {'data':{'nonce':nonce}}
        nonce = body.get('nonce')
        require(isinstance(nonce,str) and bool(re.fullmatch('[0-9a-f]{64}',nonce)),'Autorización inválida',409)
        with contextlib.closing(db()) as connection, connection:
            row = connection.execute(
                'DELETE FROM authorizations WHERE nonce=? AND sid=? AND digest=? AND expires>=? RETURNING snapshot',
                (nonce,sid,digest,time.time())).fetchone()
        require(row,'Autorización vencida o inválida',409)
        snapshot = plan(clean,session=s)
        require(json.dumps(snapshot)==row[0],'El contenido cambió desde la confirmación',409)
        ident = audit({'user':s['user'],'ip':req.client.host if req.client else '127.0.0.1','args':clean},'started')
        try:
            execute(clean,s['user'],file,snapshot,session=s)
        except Exception:
            with contextlib.closing(db()) as connection, connection:
                connection.execute('UPDATE history SET result=? WHERE id=?',('failed',ident))
            raise
        with contextlib.closing(db()) as connection, connection:
            connection.execute('UPDATE history SET result=? WHERE id=?',('ok',ident))
        return {'data':{'id':ident}}

if __name__ == '__main__':
    import uvicorn
    host = os.environ.get('EXPLORER_HOST', '127.0.0.1')
    port = int(os.environ.get('EXPLORER_PORT', '8766'))
    print(f"Iniciando 360YA Explorer Community v1.0.1 en http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)
