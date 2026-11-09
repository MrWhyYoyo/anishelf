#!/bin/bash
# Mac: double-click to start AniShelf (first time: run  chmod +x run.command  in Terminal)
cd "$(dirname "$0")" || exit 1
if [ ! -x ".venv/bin/python" ]; then
    echo "First run: setting up AniShelf..."
    python3 -m venv .venv && .venv/bin/python -m pip install --quiet -r requirements.txt || { echo "Setup failed"; exit 1; }
fi
exec .venv/bin/python run.py "$@"
