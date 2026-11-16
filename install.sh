#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077

case "${1:-}" in
    --backup|--rollback) exec python3 install_state.py "$@" ;;
    --test)
        test_dir=$(mktemp -d "$PWD/.test.XXXXXXXX")
        trap 'rm -rf -- "$test_dir"' EXIT
        cp -a data/. "$test_dir/"
        export EXPLORER_DATA_DIR="$test_dir" EXPLORER_STATE_DIR="$test_dir/.test-state"
        export EXPLORER_PASSWORD="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(24))')"
        .venv/bin/python -m unittest discover -s tests
        exit ;;
    '') ;;
    *) echo "Uso: bash install.sh [--test|--backup|--rollback ARCHIVO]" >&2; exit 2 ;;
esac

if [ -f .env ]; then
    python3 install_state.py --backup
fi
if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
fi
if [ -d vendor/wheels ]; then
    .venv/bin/pip install --no-index --find-links vendor/wheels -r requirements.txt
else
    .venv/bin/pip install -r requirements.txt
fi
if [ ! -f .env ]; then
    python3 - <<'PY'
import secrets
from pathlib import Path
template = Path('.env.example').read_text()
with Path('.env').open('x') as output:
    output.write(template.replace('GENERAR_EN_INSTALACION',secrets.token_urlsafe(24)))
PY
fi
chmod 600 .env
.venv/bin/python -m py_compile server.py
printf '360YA Explorer Community 1.0.2 instalado. Ejecutá bash run.sh.\n'
