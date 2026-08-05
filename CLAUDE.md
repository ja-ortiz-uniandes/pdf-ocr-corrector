# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-only web tool for patching missing OCR text into PDFs. The user draws a box over a page region,
the backend OCRs just that crop, the user corrects the result, and on save the app writes an **invisible**
text layer at those coordinates so the page looks identical but becomes searchable. See README.md for the
end-user view.

## Commands

```bash
# Run the app (creates .venv and installs deps on first run, then opens a browser)
start.bat                    # Windows
./start.sh                   # macOS / Linux

# Run the server directly, without the launcher
.venv/Scripts/python app.py             # Windows
.venv/bin/python app.py                 # macOS / Linux

# Backend tests (OCR tests self-skip when Tesseract is absent)
.venv/Scripts/python -W ignore::ResourceWarning -m unittest test_app

# A single test or class
.venv/Scripts/python -m unittest test_app.TestInvisibleText.test_rotated_pages_land_in_the_same_place
.venv/Scripts/python -m unittest test_app.TestOcr

# Regenerate the test PDF (two pages, each mixing a real text layer with an image-only block)
.venv/Scripts/python make_sample.py

# Inspect / verify a PDF's text layer after a save
.venv/Scripts/python check_pdf_text.py "work/<doc_id>/output/<name>_ocr-fixed.pdf" --find "some text"

# Optional frontend tests (jsdom; the app itself needs no Node.js)
cd tests/ui && npm install && npm test
node ui.test.mjs ../../static/app.js     # or point at any other copy of app.js
```

Env vars: `PDFOCR_PORT` (default 8765, auto-increments if busy), `PDFOCR_HOST`, `PDFOCR_NO_BROWSER=1`,
`TESSERACT_CMD`.

No linter or formatter is configured. Match the surrounding style.

## Architecture

Four files carry all the logic: `app.py`, `static/app.js`, `static/index.html`, `static/style.css`.
PyMuPDF (`fitz`) does both page rendering and text insertion, which is why there is no poppler binary,
no pdf.js, and no reportlab overlay-merge step.

### The coordinate contract

**Boxes travel as normalised 0..1 rects relative to `page.rect`.** This is the single most important
invariant; violating it is how zoom-dependent and rotation-dependent bugs get introduced.

- The server renders pages to PNG (`GET /api/page/<doc_id>/<n>.png?dpi=`), so browser and backend share
  one rendering stack by construction rather than by keeping two in agreement.
- The frontend positions box divs in **percentages**, so changing zoom cannot move a box or alter what
  gets saved.
- `_rect_from_norm()` is the only place normalised coords become PDF points.

**Do not add rotation compensation.** `page.rect`, `page.get_pixmap(clip=...)`, `page.insert_text()` and
`page.search_for()` all operate in the *rotated view* coordinate system the browser sees, so `/Rotate
90/180/270` needs no derotation. An earlier version derotated via `page.derotation_matrix` and
`set_rotation(0)`, which double-compensated and placed text 90° off on rotated pages.
`test_app.py::test_rotated_pages_land_in_the_same_place` pins this for all four rotations.

### Region OCR path (`POST /api/ocr`)

Renders **only the clipped region** at up to 900 DPI (never a full-page rasterise), then
`_prep_for_ocr()`: grayscale → upscale if shorter than 120px → optional invert → autocontrast →
unsharp mask → optional Otsu binarise → 12px white margin (Tesseract's line finder needs it).
Returns the OCR text plus a base64 preview of the exact crop that was fed to Tesseract.

Tesseract is located by `TESSERACT_CMD`, then `PATH`, then known Windows/macOS/Linux install paths, so
it works on Windows even when not on PATH. Absence degrades to HTTP 503 with an actionable message, and
`_tesseract_info()` feeds the UI banner and language dropdown.

### Invisible text insertion (`POST /api/save`)

- `render_mode=3` (`INVISIBLE`) — neither fill nor stroke, so glyphs are selectable and searchable but
  never drawn. `test_app.py` asserts `3 Tr` appears in the content stream *and* that rendered page bytes
  stay identical to the original.
- Base-14 Helvetica (`helv`) avoids font embedding but limits the layer to **cp1252**. `_sanitize()` folds
  typographic quotes/dashes and replaces anything unencodable with `?`, returning the dropped characters
  so the UI can report them. Supporting CJK/Cyrillic/Greek would mean embedding a TTF.
- `_insert_invisible_text()` writes **one PDF text line per input line**, each sized to fit both its share
  of the box height and the box width. Text is fitted to the *box*, not to the ink.
- The source document is opened and saved to a new path under `work/<doc_id>/output/`; the original bytes
  are never rewritten. A test hashes the stored original to prove it.

### Working storage

`work/<doc_id>/` (git-ignored) holds `original.pdf`, `meta.json`, `render/p<n>_<dpi>.png` (render cache),
`output/<stem>_ocr-fixed.pdf`, and `boxes.json` (provenance of the last save). `doc_id` is a 32-char hex
UUID and `_doc_dir()` validates it character by character — that check is what keeps path traversal out
of the work directory, so keep it if you refactor.

### Frontend

Classic script, no modules, no build step, no external requests (a strict local-only tool must not pull
from a CDN). Top-level `const state` holds boxes, selection and the saved flag.

**`renderList()` rebuilds the card list from scratch, destroying live DOM.** Consequences that already
caused one bug:

- `select()` must never call `renderList()` — it returns early on a no-op and otherwise only toggles CSS
  classes via `markSelection()`. Rebuilding on selection change replaced the textarea the user had just
  clicked, silently discarding every keystroke.
- Rebuilds that *are* necessary (add/remove/OCR-complete) save and restore the focused region plus caret
  offset, so an OCR response arriving for one region cannot yank the caret out of another.

`tests/ui/ui.test.mjs` drives the real `static/app.js` in jsdom against a stubbed backend and guards
exactly these behaviours. It loads the script via an injected inline `<script>` with
`runScripts: 'dangerously'`, because `window.eval()` keeps strict-mode function declarations off `window`.

## Launcher conventions

`app.py` opens the browser (via `threading.Timer`), not the shell scripts — one code path for all
platforms, and it fires after the server is listening. First-run dependency install is guarded by a
`.venv/.deps-installed` stamp; delete `.venv` to force a clean reinstall.

`start.command` exists because macOS Finder opens a double-clicked `.sh` in an editor. `.gitattributes`
forces LF on `*.sh`/`*.command` (CRLF yields `bad interpreter: /usr/bin/env bash^M`) and CRLF on `*.bat`;
both shell scripts are committed with the exec bit set.

## Git

This repository lives under the `ja-ortiz-uniandes` GitHub account while the machine's default `gh`
account is a different one. `.git/config` carries a repo-local credential helper that fetches the right
token from the `gh` keyring, so `git` fetch/push work without `gh auth switch`. Note that `gh` CLI
commands still act as the globally active account and will 404 on this private repo unless switched.
