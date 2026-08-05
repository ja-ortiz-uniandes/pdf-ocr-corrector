# PDF OCR Corrector

A small, **fully local** web tool for patching missing OCR text into a PDF.

You open a PDF that was already OCR'd but has gaps, drag a box over an area
whose text is missing or wrong, and the app OCRs *just that crop* at high
resolution. The result appears in an editable field so you can fix whatever
Tesseract still got wrong. When you save, the app writes an **invisible text
layer** at those exact coordinates on top of the existing page: the page looks
pixel-for-pixel identical, but the text is now selectable and searchable.

The original PDF is never modified — you always get a new file.

Nothing is uploaded anywhere. The server binds to `127.0.0.1` only, and your
PDFs stay in the local `work/` folder (which is git-ignored).

---

## 1. Prerequisites

Two things must be installed on your machine.

### Python 3.10 or newer

- **Windows:** [python.org/downloads](https://www.python.org/downloads/) — during
  setup tick **"Add python.exe to PATH"**.
  Or: `winget install Python.Python.3.13`
- **macOS:** `brew install python` (or the python.org installer)
- **Debian/Ubuntu:** `sudo apt install python3 python3-venv`

### Tesseract OCR

This is a separate program, not a Python package.

- **Windows:** `winget install UB-Mannheim.TesseractOCR`
  (installs to `C:\Program Files\Tesseract-OCR`, which this app finds
  automatically even if it is not on your PATH)
- **macOS:** `brew install tesseract`
- **Debian/Ubuntu:** `sudo apt install tesseract-ocr`

Extra languages: on Windows tick them in the installer's *Additional language
data* section; on macOS `brew install tesseract-lang`; on Ubuntu
`sudo apt install tesseract-ocr-spa` (swap `spa` for the language you need).

If Tesseract lives somewhere unusual, point the app at it:

```
# Windows (PowerShell)
$env:TESSERACT_CMD = "D:\tools\Tesseract-OCR\tesseract.exe"
# macOS / Linux
export TESSERACT_CMD=/opt/local/bin/tesseract
```

Python packages (`flask`, `pymupdf`, `pytesseract`, `pillow`) are installed
automatically on first launch — you do not need to install them yourself.

---

## 2. Launch

### Windows

Double-click **`start.bat`**.

### macOS

Double-click **`start.command`**. The very first time, make the scripts
executable (once, in Terminal):

```
chmod +x start.command start.sh
```

macOS Gatekeeper may block the first double-click — if so, right-click →
**Open** → **Open** once, and afterwards double-clicking works.

### Linux

```
chmod +x start.sh
./start.sh
```

On the first run the script creates a `.venv` folder and installs the Python
dependencies (about a minute). Every later run skips straight to starting the
server. Then it starts the app and opens your browser at
`http://127.0.0.1:8765` automatically.

To stop the app: press `Ctrl+C` in the console window, or just close it.

> If port 8765 is busy the app picks the next free port and prints the real URL
> in the console.

---

## 3. How to use it

1. **Open PDF…** in the top bar, or drag a PDF onto the page.
2. Navigate pages with `‹` `›`, the page number field, or the arrow keys.
   Zoom with `−` `+` / **Fit**.
3. **Drag a box** over an area with missing or wrong text. It can be a single
   word, one line, a paragraph, or — via the **Whole page** button — the entire
   page.
4. OCR runs on that crop only and the reading appears in the right-hand panel,
   together with a preview of exactly what was sent to Tesseract.
5. **Edit the text** in the box until it is correct. That edited text is what
   gets embedded — Tesseract's guess is only a starting point.
6. Repeat for as many regions and pages as you need. `Delete` removes the
   selected box; **Re-OCR** re-runs a box after you change the settings.
7. Click **Save PDF**. The corrected file downloads as
   `<original-name>_ocr-fixed.pdf` (also kept in
   `work/<id>/output/`).

### OCR settings (right panel)

| Setting | What it does |
| --- | --- |
| **Language** | Tesseract language pack. Only installed packs are listed. |
| **Layout** | Tesseract page-segmentation mode. Match it to your selection: *Single word*, *Single line*, *Block of text*, *Column of lines*, *Sparse text*. Wrong mode is the most common cause of bad output — if a one-line box reads as gibberish, try *Single line* or *Raw line* and hit **Re-OCR**. |
| **OCR DPI** | Resolution the crop is re-rendered at before OCR. 400 suits most scans; 600–900 helps tiny print but is slower. |
| **B/W** | Otsu black-and-white threshold. Helps faded or uneven scans, hurts anti-aliased text. |
| **Invert** | For light text on a dark background. |

Regardless of these settings, every crop is upscaled if small, contrast-
normalised and unsharp-masked before OCR.

### Notes and limits

- **Text placement.** Each line of your text becomes one PDF text line, sized
  to fit its share of the box height and the box width. Draw boxes that hug the
  text reasonably closely and keep one line of text per line of the page, and
  selection highlights will line up well. A box far larger than its text still
  works for search — the invisible glyphs are just bigger than the visible ink.
- **Character set.** The invisible layer uses base-14 Helvetica (cp1252), so
  Western European accents (`á é í ó ú ñ ü ç`) work fine. Characters outside it
  (e.g. CJK, Greek, Cyrillic) are replaced with `?` and the app tells you which
  ones after saving.
- Encrypted / password-protected PDFs are rejected.
- Existing text is left untouched. If you box an area that *already* has text,
  the panel warns you — patching it anyway means that area ends up with both
  the old and new text.
- Rotated pages (`/Rotate 90/180/270`) are handled: your box is interpreted in
  the same rotated view you drew it on, and the page's rotation is preserved in
  the output. `test_app.py` pins this for all four rotations.

---

## 4. Testing it

Generate the bundled sample, which imitates a partially-OCR'd scan — part of
each page has a real text layer, and a grey block on each page is a flattened
image with no text behind it:

```
# Windows
.venv\Scripts\python make_sample.py
# macOS / Linux
.venv/bin/python make_sample.py
```

That writes `samples/sample_missing_ocr.pdf`. Open it in the app, draw a box
over the grey block, and save. Then confirm the new text is really in the file:

```
# Windows
.venv\Scripts\python check_pdf_text.py "work\<id>\output\sample_missing_ocr_ocr-fixed.pdf" --find "QF-2291-B"
# macOS / Linux
.venv/bin/python check_pdf_text.py "work/<id>/output/sample_missing_ocr_ocr-fixed.pdf" --find "QF-2291-B"
```

Any PDF works too — no sample required. A good check with a real file: open the
saved PDF in a viewer, press `Ctrl+F` and search for a word that used to be
unfindable, and confirm the page still looks unchanged.

### Automated tests

```
# Windows
.venv\Scripts\python -m unittest test_app
# macOS / Linux
.venv/bin/python -m unittest test_app
```

25 tests covering the parts that can fail silently: text lands inside the box
you drew, it is written in invisible render mode, the rendered page stays
byte-identical to the original, the source file is never modified, all four page
rotations place text identically, accents survive and unsupported characters are
reported, and the API rejects bad input. The OCR tests skip themselves if
Tesseract is missing.

---

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Red banner: *Tesseract is not installed* | Install Tesseract (section 1), then restart the app. The console prints the path it found on startup. |
| `[ERROR] Python was not found on PATH` | Reinstall Python with the "Add to PATH" option, or run `python -m venv .venv` yourself once. |
| Dependency install failed / broken venv | Delete the `.venv` folder and run the start script again. |
| OCR returns nothing for a box | Try a different **Layout** mode, raise **OCR DPI**, or tick **B/W**. Very small boxes read better as *Single word* / *Single line*. |
| Text embedded but selection sits too high or low | Redraw the box to hug the text block more tightly; the layer is fitted to the box, not to the ink. |
| Browser did not open | Open the URL printed in the console manually. Set `PDFOCR_NO_BROWSER=1` to disable auto-open. |
| Want a different port | `PDFOCR_PORT=9000` before launching. |

Uploaded PDFs, cached page renders and outputs accumulate in `work/`. Deleting
that folder is always safe.

---

## 6. What's in here

| File | Purpose |
| --- | --- |
| `app.py` | Flask server: upload, page render, region OCR, invisible-text writer |
| `static/index.html`, `static/app.js`, `static/style.css` | Frontend — box drawing, editing panel, no external libraries |
| `make_sample.py` | Builds the test PDF with deliberate OCR gaps |
| `check_pdf_text.py` | Dumps / searches a PDF's text layer to verify results |
| `test_app.py` | Test suite (`python -m unittest test_app`) |
| `start.bat`, `start.sh`, `start.command` | One-click setup + launch |
| `requirements.txt` | Python dependencies |

Built with [PyMuPDF](https://pymupdf.readthedocs.io/) (rendering + text
insertion), [pytesseract](https://github.com/madmaze/pytesseract) +
[Tesseract](https://github.com/tesseract-ocr/tesseract) (OCR),
[Pillow](https://python-pillow.org/) (crop preprocessing) and
[Flask](https://flask.palletsprojects.com/) (local server).

## License

MIT — see [LICENSE](LICENSE).
