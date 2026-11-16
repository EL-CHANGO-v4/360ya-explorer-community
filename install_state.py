"""Local backups and checked rollback of files managed by the package."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile

MANAGED = ('server.py','start.py','run.sh','install.sh','install_state.py','requirements.txt',
           '.env','.env.example','config.example.json','README.md','LICENSE','static','tests','data','vendor')
ROOT = Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def backup():
    directory = ROOT/'backups'
    directory.mkdir(mode=0o700,exist_ok=True)
    path = directory/datetime.now(timezone.utc).strftime('explorer-%Y%m%dT%H%M%S%fZ.tar.gz')
    with tarfile.open(path,'x:gz') as archive:
        for name in MANAGED:
            if (ROOT/name).exists():
                archive.add(ROOT/name,arcname=name)
    path.chmod(0o600)
    path.with_suffix('.sha256').write_text(digest(path)+'\n')
    print(path)


def rollback(path):
    if path.with_suffix('.sha256').read_text().strip()!=digest(path):
        raise SystemExit('El SHA-256 del respaldo no coincide')
    with tempfile.TemporaryDirectory(prefix='.rollback-',dir=ROOT) as scratch:
        stage = Path(scratch)/'new'
        old = Path(scratch)/'old'
        stage.mkdir()
        old.mkdir()
        with tarfile.open(path,'r:gz') as archive:
            members = archive.getmembers()
            for member in members:
                parts = Path(member.name).parts
                if not parts or parts[0] not in MANAGED or '..' in parts or not (member.isfile() or member.isdir()):
                    raise SystemExit('El respaldo contiene una ruta o entrada inválida')
            archive.extractall(stage,filter='data')
        if not (stage/'server.py').is_file():
            raise SystemExit('El respaldo está incompleto')
        moved = []
        installed = []
        try:
            for name in MANAGED:
                if os.path.lexists(ROOT/name):
                    (ROOT/name).rename(old/name)
                    moved.append(name)
                if (stage/name).exists():
                    (stage/name).rename(ROOT/name)
                    installed.append(name)
        except BaseException:
            for name in installed:
                (ROOT/name).rename(stage/name)
            for name in moved:
                (old/name).rename(ROOT/name)
            raise
    print('Respaldo restaurado.')


if __name__=='__main__':
    if sys.argv[1:] == ['--backup']:
        backup()
    elif len(sys.argv)==3 and sys.argv[1]=='--rollback':
        rollback(Path(sys.argv[2]).resolve())
    else:
        raise SystemExit('Acción inválida')
