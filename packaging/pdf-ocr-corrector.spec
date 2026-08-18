# Run from the repo root: pyinstaller packaging/pdf-ocr-corrector.spec
#
# Produces a portable, --onedir build (a folder you can zip and move around, no
# installer, no registry writes) rather than --onefile: --onefile re-extracts
# everything to a fresh temp directory on every launch, which is slow and wasteful
# for a bundle this size (Tesseract + its language data alone is ~100MB).
import platform
from pathlib import Path

REPO_ROOT = Path(SPECPATH).resolve().parent

VENDOR_DIR = REPO_ROOT / "packaging" / "vendor" / platform.system().lower() / "tesseract"

datas = [
    (str(REPO_ROOT / "static"), "static"),
    (str(REPO_ROOT / "VERSION"), "."),
]
if VENDOR_DIR.is_dir():
    datas.append((str(VENDOR_DIR), "tesseract"))

a = Analysis(
    [str(REPO_ROOT / "app.py")],
    pathex=[str(REPO_ROOT)],
    datas=datas,
    hiddenimports=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pdf-ocr-corrector",
    console=True,
)

COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="pdf-ocr-corrector",
)
