#!/usr/bin/env bash
# Sets up the virtual environment on first run, then starts the local app.
set -euo pipefail

cd "$(dirname "$0")"

VENV=".venv"
STAMP="$VENV/.deps-installed"

fail() {
  echo
  echo "[ERROR] $1"
  echo "        To force a clean reinstall, delete the .venv folder and run again."
  # Keep the window open when launched by double-click from a file manager.
  if [ -t 0 ]; then read -r -p "Press Enter to close..." _; fi
  exit 1
}

PY_BIN=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then PY_BIN="$cand"; break; fi
done
[ -n "$PY_BIN" ] || fail "Python 3.10+ was not found. Install it from https://www.python.org/downloads/ (or 'brew install python' on macOS)."

if [ ! -x "$VENV/bin/python" ]; then
  echo "[setup] Creating virtual environment in $VENV ..."
  "$PY_BIN" -m venv "$VENV" || fail "Could not create the virtual environment."
fi

PY="$VENV/bin/python"

if [ ! -f "$STAMP" ]; then
  echo "[setup] Installing dependencies (first run only, this takes a minute) ..."
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install -r requirements.txt || fail "Dependency install failed."
  echo installed > "$STAMP"
fi

if ! command -v tesseract >/dev/null 2>&1 \
   && [ ! -x /opt/homebrew/bin/tesseract ] && [ ! -x /usr/local/bin/tesseract ]; then
  echo
  echo "[WARNING] Tesseract OCR was not found. Region OCR will not work."
  echo "          macOS:         brew install tesseract"
  echo "          Debian/Ubuntu: sudo apt install tesseract-ocr"
  echo "          Then re-run this script."
  echo
fi

echo "[run] Starting the app - your browser will open shortly."
echo "      Press Ctrl+C to stop the server."
exec "$PY" app.py
