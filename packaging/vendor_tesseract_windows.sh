#!/usr/bin/env bash
# Fetches a self-contained, portable Tesseract for bundling into the Windows build:
# tesseract.exe + its DLLs (extracted from the official installer without running it)
# plus eng/osd language data (fetched separately - the installer downloads these at
# install time rather than embedding them, so they aren't in the installer archive).
#
# Pinned versions/commits so this is reproducible instead of tracking moving targets.
set -euo pipefail

TESSERACT_INSTALLER_URL="https://github.com/tesseract-ocr/tesseract/releases/download/5.5.3/tesseract-ocr-w64-setup-5.5.3.20260724.exe"
TESSDATA_FAST_COMMIT="87416418657359cb625c412a48b6e1d6d41c29bd"

OUT_DIR="${1:?usage: vendor_tesseract_windows.sh <output-dir>}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUT_DIR/tessdata"

curl -sL --retry 3 --retry-delay 2 --retry-all-errors -o "$WORK_DIR/setup.exe" "$TESSERACT_INSTALLER_URL"
7z x "$WORK_DIR/setup.exe" -o"$WORK_DIR/extracted" -y >/dev/null

cp "$WORK_DIR/extracted/tesseract.exe" "$OUT_DIR/"
cp "$WORK_DIR"/extracted/*.dll "$OUT_DIR/"

for lang in eng osd spa; do
  curl -sL --retry 3 --retry-delay 2 --retry-all-errors -o "$OUT_DIR/tessdata/$lang.traineddata" \
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$TESSDATA_FAST_COMMIT/$lang.traineddata"
done

echo "Vendored Tesseract into $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
