"""Load the local settings without interpreting shell code."""
import os
from pathlib import Path
import re
import runpy

for line in Path('.env').read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    key, separator, value = line.partition('=')
    if not separator or not re.fullmatch(r'EXPLORER_[A-Z_]+',key):
        raise SystemExit('Configuración .env inválida')
    os.environ.setdefault(key,value.strip())

host = os.environ.get('EXPLORER_HOST','127.0.0.1')
if host not in ('127.0.0.1','::1','localhost') and os.environ.get('EXPLORER_HTTPS')!='1':
    raise SystemExit('Usá una dirección de loopback o configurá un proxy HTTPS')
runpy.run_path('server.py',run_name='__main__')
