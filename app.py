"""
PDF OCR Corrector - local-only web tool for patching missing OCR text into PDFs.

Everything runs on 127.0.0.1. Uploaded PDFs stay in ./work and are never sent
anywhere off this machine.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import uuid
import webbrowser
from pathlib import Path

import fitz  # PyMuPDF
import pytesseract
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageFilter, ImageOps

BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / "work"
STATIC_DIR = BASE_DIR / "static"

HOST = os.environ.get("PDFOCR_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PDFOCR_PORT", "8765"))
OPEN_BROWSER = os.environ.get("PDFOCR_NO_BROWSER", "") == ""

# Font used for the invisible text layer. Base-14 Helvetica keeps the output
# PDF small and needs no embedding; its encoding is cp1252 (see _sanitize).
FONT_NAME = "helv"

# Render mode 3 = "neither fill nor stroke" -> glyphs are invisible but still
# selectable, searchable and copyable.
INVISIBLE = 3

MAX_RENDER_PIXELS = 40_000_000  # guard against absurd zoom levels

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300 MB upload cap


# --------------------------------------------------------------------------- #
# Tesseract discovery
# --------------------------------------------------------------------------- #

def _find_tesseract() -> str | None:
    """Locate the tesseract binary, honouring TESSERACT_CMD first."""
    explicit = os.environ.get("TESSERACT_CMD")
    if explicit and Path(explicit).exists():
        return explicit

    found = shutil.which("tesseract")
    if found:
        return found

    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Tesseract-OCR\tesseract.exe"),
        "/opt/homebrew/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/usr/bin/tesseract",
    ]
    for cand in candidates:
        if cand and Path(cand).exists():
            return cand
    return None


_TESS_CMD = _find_tesseract()
if _TESS_CMD:
    pytesseract.pytesseract.tesseract_cmd = _TESS_CMD


def _tesseract_info() -> dict:
    if not _TESS_CMD:
        return {"available": False, "cmd": None, "version": None, "langs": []}
    try:
        version = str(pytesseract.get_tesseract_version())
    except Exception as exc:  # pragma: no cover - environment dependent
        return {"available": False, "cmd": _TESS_CMD, "version": None,
                "langs": [], "error": str(exc)}
    try:
        langs = sorted(l for l in pytesseract.get_languages(config="") if l != "osd")
    except Exception:
        langs = ["eng"]
    return {"available": True, "cmd": _TESS_CMD, "version": version, "langs": langs}


# --------------------------------------------------------------------------- #
# Document storage helpers
# --------------------------------------------------------------------------- #

def _doc_dir(doc_id: str) -> Path:
    """Resolve a doc's working directory, rejecting anything path-ish."""
    if not doc_id or len(doc_id) != 32 or any(c not in "0123456789abcdef" for c in doc_id):
        abort(400, "invalid doc id")
    d = WORK_DIR / doc_id
    if not d.is_dir():
        abort(404, "unknown doc id")
    return d


def _original_pdf(doc_id: str) -> Path:
    path = _doc_dir(doc_id) / "original.pdf"
    if not path.exists():
        abort(404, "original pdf missing")
    return path


def _meta(doc_id: str) -> dict:
    return json.loads((_doc_dir(doc_id) / "meta.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

def _rect_from_norm(page: fitz.Page, norm: dict) -> fitz.Rect:
    """Convert a normalised (0..1) rect from the browser into page points."""
    pr = page.rect  # already accounts for /Rotate
    try:
        x0 = float(norm["x0"]); y0 = float(norm["y0"])
        x1 = float(norm["x1"]); y1 = float(norm["y1"])
    except (KeyError, TypeError, ValueError):
        abort(400, "bad rect")

    x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
    y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))

    rect = fitz.Rect(
        pr.x0 + x0 * pr.width,
        pr.y0 + y0 * pr.height,
        pr.x0 + x1 * pr.width,
        pr.y0 + y1 * pr.height,
    )
    if rect.width < 1 or rect.height < 1:
        abort(400, "selection too small")
    return rect


def _clamp_zoom(rect: fitz.Rect, zoom: float) -> float:
    """Shrink zoom if the requested pixmap would be unreasonably large."""
    px = (rect.width * zoom) * (rect.height * zoom)
    if px > MAX_RENDER_PIXELS:
        zoom *= (MAX_RENDER_PIXELS / px) ** 0.5
    return max(0.1, zoom)


# --------------------------------------------------------------------------- #
# OCR image preprocessing
# --------------------------------------------------------------------------- #

def _otsu_threshold(img: Image.Image) -> int:
    hist = img.histogram()
    total = sum(hist)
    if not total:
        return 127
    sum_all = sum(i * h for i, h in enumerate(hist))
    sum_b = 0.0
    w_b = 0
    best_var = -1.0
    thr = 127
    for i, h in enumerate(hist):
        w_b += h
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += i * h
        mean_b = sum_b / w_b
        mean_f = (sum_all - sum_b) / w_f
        var = w_b * w_f * (mean_b - mean_f) ** 2
        if var > best_var:
            best_var = var
            thr = i
    return thr


def _prep_for_ocr(img: Image.Image, min_height: int = 120,
                  binarize: bool = False, invert: bool = False) -> Image.Image:
    """Grayscale, upscale small crops, boost contrast and sharpen."""
    img = img.convert("L")

    if img.height < min_height:
        factor = min(4.0, min_height / max(1, img.height))
        img = img.resize(
            (max(1, int(img.width * factor)), max(1, int(img.height * factor))),
            Image.LANCZOS,
        )

    if invert:
        img = ImageOps.invert(img)

    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=160, threshold=3))

    if binarize:
        thr = _otsu_threshold(img)
        img = img.point(lambda p, t=thr: 255 if p > t else 0, mode="L")

    # Small white margin helps Tesseract's line finder.
    return ImageOps.expand(img, border=12, fill=255)


# --------------------------------------------------------------------------- #
# Invisible text layer
# --------------------------------------------------------------------------- #

_TYPOGRAPHIC = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2010": "-", "\u2011": "-",
    "\u2026": "...", "\u00a0": " ", "\u200b": "", "\ufb01": "fi", "\ufb02": "fl",
}


def _sanitize(text: str) -> tuple[str, list[str]]:
    """Map text into the cp1252 range that base-14 Helvetica can encode."""
    for src, dst in _TYPOGRAPHIC.items():
        text = text.replace(src, dst)
    out: list[str] = []
    dropped: list[str] = []
    for ch in text:
        if ch in "\n\r\t":
            out.append(ch)
            continue
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            dropped.append(ch)
            out.append("?")
        else:
            out.append(ch)
    return "".join(out), sorted(set(dropped))


def _insert_invisible_text(page: fitz.Page, rect: fitz.Rect, text: str) -> int:
    """
    Lay `text` invisibly inside `rect`, one PDF text line per input line.

    Font size is chosen so each line fits both the line's vertical slot and the
    box width, so selection highlights line up with what is on the page.
    """
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        return 0

    line_h = rect.height / len(lines)
    written = 0
    for i, line in enumerate(lines):
        width_at_1pt = fitz.get_text_length(line, fontname=FONT_NAME, fontsize=1)
        size = line_h * 0.9
        if width_at_1pt > 0:
            size = min(size, rect.width / width_at_1pt)
        size = max(1.0, min(size, 200.0))
        baseline = rect.y0 + line_h * i + line_h * 0.8
        page.insert_text(
            fitz.Point(rect.x0, baseline),
            line,
            fontname=FONT_NAME,
            fontsize=size,
            render_mode=INVISIBLE,
            color=(0, 0, 0),
        )
        written += 1
    return written


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

@app.after_request
def _no_cache(resp):
    if request.path.startswith("/api/") or request.path == "/":
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "tesseract": _tesseract_info(),
        "pymupdf": fitz.__doc__.strip() if fitz.__doc__ else "",
        "work_dir": str(WORK_DIR),
    })


@app.post("/api/upload")
def upload():
    f = request.files.get("pdf")
    if f is None or not f.filename:
        abort(400, "no file uploaded")
    if not f.filename.lower().endswith(".pdf"):
        abort(400, "only .pdf files are accepted")

    doc_id = uuid.uuid4().hex
    ddir = WORK_DIR / doc_id
    (ddir / "render").mkdir(parents=True, exist_ok=True)
    target = ddir / "original.pdf"
    f.save(target)

    try:
        doc = fitz.open(target)
        if doc.needs_pass:
            doc.close()
            shutil.rmtree(ddir, ignore_errors=True)
            abort(400, "password-protected PDFs are not supported")
        pages = [{
            "index": i,
            "width": round(p.rect.width, 2),
            "height": round(p.rect.height, 2),
            "rotation": p.rotation,
            "has_text": bool(p.get_text("text").strip()),
        } for i, p in enumerate(doc)]
        doc.close()
    except Exception as exc:
        shutil.rmtree(ddir, ignore_errors=True)
        abort(400, f"could not read PDF: {exc}")

    meta = {"doc_id": doc_id, "filename": f.filename, "pages": pages}
    (ddir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return jsonify(meta)


@app.get("/api/page/<doc_id>/<int:page_no>.png")
def page_png(doc_id: str, page_no: int):
    dpi = max(50, min(300, request.args.get("dpi", 150, type=int)))
    ddir = _doc_dir(doc_id)
    cached = ddir / "render" / f"p{page_no}_{dpi}.png"
    if not cached.exists():
        doc = fitz.open(_original_pdf(doc_id))
        try:
            if not 0 <= page_no < doc.page_count:
                abort(404, "page out of range")
            page = doc[page_no]
            zoom = _clamp_zoom(page.rect, dpi / 72.0)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            pix.save(cached)
        finally:
            doc.close()
    resp = send_file(cached, mimetype="image/png")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@app.post("/api/ocr")
def ocr():
    data = request.get_json(silent=True) or {}
    doc_id = data.get("doc_id", "")
    page_no = int(data.get("page", 0))
    lang = str(data.get("lang") or "eng")[:64]
    psm = int(data.get("psm", 6))
    ocr_dpi = max(150, min(900, int(data.get("ocr_dpi", 400))))
    binarize = bool(data.get("binarize"))
    invert = bool(data.get("invert"))

    if psm not in (1, 3, 4, 6, 7, 8, 11, 13):
        abort(400, "unsupported psm")
    if not all(c.isalnum() or c in "+_" for c in lang):
        abort(400, "bad lang code")

    info = _tesseract_info()
    if not info["available"]:
        return jsonify({"error": "tesseract_missing",
                        "message": "Tesseract is not installed or not on PATH. "
                                   "See the README for install steps."}), 503

    doc = fitz.open(_original_pdf(doc_id))
    try:
        if not 0 <= page_no < doc.page_count:
            abort(404, "page out of range")
        page = doc[page_no]
        rect = _rect_from_norm(page, data.get("rect") or {})
        zoom = _clamp_zoom(rect, ocr_dpi / 72.0)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False)
        raw = Image.open(io.BytesIO(pix.tobytes("png")))
        existing = page.get_text("text", clip=rect).strip()
    finally:
        doc.close()

    prepped = _prep_for_ocr(raw, binarize=binarize, invert=invert)
    config = f"--oem 3 --psm {psm} -c preserve_interword_spaces=1"
    try:
        text = pytesseract.image_to_string(prepped, lang=lang, config=config)
    except pytesseract.TesseractError as exc:
        return jsonify({"error": "tesseract_failed", "message": str(exc)}), 500

    text = "\n".join(ln.rstrip() for ln in text.splitlines())
    text = "\n".join(ln for ln in text.split("\n") if ln.strip())

    preview = raw.copy()
    preview.thumbnail((640, 640), Image.LANCZOS)
    buf = io.BytesIO()
    preview.save(buf, format="PNG")

    return jsonify({
        "text": text,
        "existing_text": existing,
        "crop_size": [prepped.width, prepped.height],
        "preview": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
    })


@app.post("/api/save")
def save():
    data = request.get_json(silent=True) or {}
    doc_id = data.get("doc_id", "")
    boxes = data.get("boxes") or []
    if not isinstance(boxes, list) or not boxes:
        abort(400, "no boxes to save")

    ddir = _doc_dir(doc_id)
    meta = _meta(doc_id)
    stem = Path(meta["filename"]).stem or "document"
    out_dir = ddir / "output"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{stem}_ocr-fixed.pdf"

    doc = fitz.open(_original_pdf(doc_id))
    applied = 0
    lines_written = 0
    dropped_chars: set[str] = set()
    try:
        for box in boxes:
            text = (box.get("text") or "").strip()
            if not text:
                continue
            page_no = int(box.get("page", 0))
            if not 0 <= page_no < doc.page_count:
                continue
            page = doc[page_no]
            # page.rect and insert_text both work in the rotated ("view")
            # coordinate system that the browser sees, so /Rotate 90/180/270
            # pages need no extra compensation. test_app.py pins this.
            rect = _rect_from_norm(page, box.get("rect") or {})

            clean, dropped = _sanitize(text)
            dropped_chars.update(dropped)
            lines_written += _insert_invisible_text(page, rect, clean)
            applied += 1

        if not applied:
            abort(400, "every box was empty")
        doc.save(str(out_path), garbage=3, deflate=True)
    finally:
        doc.close()

    (ddir / "boxes.json").write_text(
        json.dumps({"filename": meta["filename"], "boxes": boxes}, indent=2),
        encoding="utf-8",
    )

    return jsonify({
        "boxes_applied": applied,
        "lines_written": lines_written,
        "unsupported_chars": sorted(dropped_chars),
        "output_name": out_path.name,
        "output_path": str(out_path),
        "download_url": f"/api/download/{doc_id}",
    })


@app.get("/api/download/<doc_id>")
def download(doc_id: str):
    ddir = _doc_dir(doc_id)
    meta = _meta(doc_id)
    stem = Path(meta["filename"]).stem or "document"
    out_path = ddir / "output" / f"{stem}_ocr-fixed.pdf"
    if not out_path.exists():
        abort(404, "nothing saved yet")
    return send_file(out_path, mimetype="application/pdf",
                     as_attachment=True, download_name=out_path.name)


@app.delete("/api/doc/<doc_id>")
def delete_doc(doc_id: str):
    ddir = _doc_dir(doc_id)
    shutil.rmtree(ddir, ignore_errors=True)
    return jsonify({"deleted": doc_id})


# --------------------------------------------------------------------------- #
# Launcher
# --------------------------------------------------------------------------- #

def _pick_port(host: str, preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket() as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port in range {preferred}-{preferred + 19}")


def main() -> None:
    WORK_DIR.mkdir(exist_ok=True)
    port = _pick_port(HOST, DEFAULT_PORT)
    url = f"http://{HOST}:{port}"

    info = _tesseract_info()
    print("=" * 66)
    print("  PDF OCR Corrector  -  everything stays on this machine")
    print("=" * 66)
    if info["available"]:
        print(f"  Tesseract {info['version']}  ({info['cmd']})")
        print(f"  Languages: {', '.join(info['langs']) or 'none found'}")
    else:
        print("  WARNING: Tesseract not found. Region OCR will not work until")
        print("           you install it (see README) or set TESSERACT_CMD.")
    print(f"  Serving  {url}")
    print("  Press Ctrl+C to stop.")
    print("=" * 66)

    if OPEN_BROWSER:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    app.run(host=HOST, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
