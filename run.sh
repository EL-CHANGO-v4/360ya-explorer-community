#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [ ! -r .env ]; then
    echo "Ejecutá primero bash install.sh" >&2
    exit 1
fi
exec .venv/bin/python start.py
