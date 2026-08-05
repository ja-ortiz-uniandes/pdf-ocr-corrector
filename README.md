# PDF OCR Corrector

A small, **fully local** web tool for patching missing OCR text into a PDF.

You open a PDF that was already OCR'd but has gaps, drag a box over an area
whose text is missing or wrong, and the app OCRs *just that crop* at high
resolution. The result appears in an editable field so you can fix whatever
Tesseract still got wrong. When you save, the app writes an **invisible text
layer** at those exact coordinates on top of the existing page: the page looks
pixel-for-pixel identical, but the text is now selectable and searchable.

Wrong or partial **hidden OCR text** inside the box is deleted first, so the
region ends up with exactly the text you approved and nothing else. **Visible text
is never deleted** — only the invisible layer a scanner's OCR pass left behind, so
the page cannot lose a word you can see.

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
3. Existing hidden OCR text is **outlined faintly in purple**. Click an outline to
   pick that text up: the panel opens with its current text prefilled, so fixing a
   misread word is just editing it — no OCR needed. **Delete only** on the card
   drops the text without writing anything. Toggle the outlines with **Hidden
   text** in the toolbar.
4. Or **drag a box** over an area with missing or wrong text. It can be a single
   word, one line, a paragraph, or — via the **Whole page** button — the entire
   page. Dragging works even when you start on top of an outline; a click picks
   the outline up, a drag draws a new box.
5. For a drawn box, OCR runs on that crop only and the reading appears in the
   right-hand panel, together with a preview of exactly what was sent to Tesseract.
6. **Edit the text** in the box until it is correct. That edited text is what
   gets embedded — Tesseract's guess is only a starting point.
7. Repeat for as many regions and pages as you need. `Delete` discards the
   selected region; **Re-OCR** re-runs a box after you change the settings.
8. Click **Save PDF**. The corrected file downloads as
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
| **Delete old OCR text in the box** | On by default. Deletes the *hidden* OCR text inside the box before writing yours, so wrong or partial text does not survive next to the correction. Visible text is never deleted, whatever this is set to. Turn it off to keep the old hidden text as well. |

### What "delete the old text" does and does not touch

A PDF text object carries a render mode that decides whether it paints ink:

- **Hidden text** — what a scanner's OCR pass writes over the page image. You never
  see it; it exists so the scan can be searched. When the OCR was wrong, this is
  the text you want gone. Usually it is marked invisible (render mode 3), but it can
  also be transparent, white-on-white, or plain black text painted *before* the
  scan image so the picture buries it — the app handles all four.
- **Visible text** — real, drawn words: a born-digital PDF, or a caption. This *is*
  the page.

This tool only ever deletes the hidden kind. Selecting the whole page and saving
will not remove a single visible word — there is no setting that makes it do so.

Per region the panel shows what it found:

- *"Wrong OCR text hidden here: … — invisible, so deleting it changes nothing on
  the page"*, with a **Delete the old OCR text here** checkbox (seeded from the
  global setting) if you want to keep it after all.
- *"This area also has visible text, which is always kept: …"* — an FYI. If that
  visible text is already correct, the region probably needs no correction at all,
  since adding your text on top would just create a second copy for searches.

Three details worth knowing:

- **A hidden line goes whole once your box covers about 20% of it**, including the
  part sticking out past your selection. Selections never line up exactly with the
  OCR layer's own boxes, so this is what stops fragments being left behind. Clip
  only a sliver of a neighbouring line and that line is left alone.
- A hidden line that physically overlaps visible ink cannot be removed without
  taking the ink with it, so it is kept and counted in the save banner as *"N
  hidden line(s) were kept because visible text overlaps them"*. Rare outside
  watermarked or double-layered files.
- As a last check, each touched page is **rendered before and after** the
  deletion. If anything visible changed, the deletion is thrown away, the page is
  restored exactly as it was, and the banner says so — your correction is still
  added. So "the page cannot lose visible words" is enforced, not just intended.

### Working straight from the outlines

The purple outlines are the OCR layer itself, so they are the most precise way to
work: no guessing where the hidden text sits, and no coverage threshold to worry
about, because clicking one selects exactly that object.

- **Fix a misread word** — click its outline, correct the prefilled text, save.
  Nothing is re-OCR'd, so nothing new can go wrong.
- **Drop junk text** — click the outline, hit **Delete only**, save. The region
  writes nothing and just removes that object.
- **Re-OCR instead** — click the outline, then **Re-OCR** on the card if you would
  rather have Tesseract read that area afresh.

Outlines already claimed by a region turn grey, so it is obvious what is queued.
An outline is only drawn for text the app can locate; clip-mode text cannot be
located, and the status line reports how many characters are in that state so you
know to draw a box over them by hand.

### If deleting the old text seems to do nothing

Hidden OCR layers come in several shapes, and it is worth checking which one your
file uses:

```
# Windows
.venv\Scripts\python check_pdf_text.py "path\to\file.pdf" --modes --page 1
# macOS / Linux
.venv/bin/python check_pdf_text.py "path/to/file.pdf" --modes --page 1
```

That lists every text span with its render mode and whether the app treats it as
hidden or visible. Handled shapes:

| shape | how it appears | handled |
| --- | --- | --- |
| render mode 3 | `HIDDEN[invisible]` | yes — the standard OCR layer |
| zero opacity | `HIDDEN[transparent]` | yes |
| white fill | `HIDDEN[white]` | yes — what older OCR tools used |
| painted before the scan image | `HIDDEN[behind image]` — ordinary black text that the picture covers | yes |
| clip-only (mode 7) | not listed at all; the tool prints a NOTE about untraceable characters | yes, via the selection rectangle, but only where the area has no visible text |

The fourth case is worth knowing about: some tools write the OCR text *first* and
then paint the scan on top, so the text is plain black yet nobody can ever see it.
Nothing about the text itself gives that away, so the app settles it by experiment
— it clears the candidates on a throwaway copy and checks whether the render
changes. If it does not, the text really was buried and can go.

If a span shows as `visible` but you know it is not drawn on the page, that is a
classification gap — the appearance guard will refuse to delete it, so nothing
breaks, but it will not be removed either. Send that `--modes` output along if you
hit it.

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
- Rotated pages (`/Rotate 90/180/270`) are handled: your box is interpreted
  against the image you drew it on, and the page's rotation is preserved in the
  output. `test_app.py` checks this against the position of a known block in the
  rendered pixels, at all four rotations.

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

That writes `samples/sample_missing_ocr.pdf` — four pages:

- **Pages 1-2**: a real text layer plus a grey block that is a flattened image
  with no text behind it. Tests the "missing text" case.
- **Page 3**: the same, except the grey block *already* has an invisible text
  layer with the wrong characters (`5amp1e 1D ........ QF-348O-<`). Tests the
  "wrong text" case — box it, OCR it, save with **Replace text** on, and the
  garbled text is gone rather than duplicated.

Open it in the app, draw a box over a grey block, and save. Then confirm the new text is really in the file:

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

63 tests covering the parts that can fail silently: text lands inside the box you
drew, it is written in invisible render mode, the rendered page stays
byte-identical to the original, the source file is never modified, deleting a
hidden OCR layer removes it without changing a pixel, a partly covered hidden line
goes whole while a barely clipped one is left alone (both sides of the 20%
threshold), mode 3 / zero-opacity / white-fill / clip-only layers are all handled,
**visible text survives even a whole-page selection**, hidden lines overlapping
visible ink are protected, the appearance guard restores a page when deletion would
have changed the render, boxes on `/Rotate 90/180/270` pages land where you drew
them (checked against rendered pixels, not against another PyMuPDF call), accents
survive and unsupported characters are reported, and the API rejects bad input. The
OCR tests skip themselves if Tesseract is missing.

There is also an **optional** frontend test suite. It needs Node.js, which the
app itself does not:

```
cd tests/ui
npm install
npm test
```

It drives the real `static/app.js` in jsdom with a stubbed backend and checks
that the editable text field stays focused while you type, that a region
finishing OCR does not steal the caret from another, that clicking a hidden-text
outline picks that text up without running OCR while a drag starting on the same
outline still draws a box, and that Save sends your edits rather than Tesseract's
guess.

---

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Red banner: *Tesseract is not installed* | Install Tesseract (section 1), then restart the app. The console prints the path it found on startup. |
| `[ERROR] Python was not found on PATH` | Reinstall Python with the "Add to PATH" option, or run `python -m venv .venv` yourself once. |
| Dependency install failed / broken venv | Delete the `.venv` folder and run the start script again. |
| OCR returns nothing for a box | Try a different **Layout** mode, raise **OCR DPI**, or tick **B/W**. Very small boxes read better as *Single word* / *Single line*. |
| Text embedded but selection sits too high or low | Redraw the box to hug the text block more tightly; the layer is fitted to the box, not to the ink. |
| Old wrong text still there after saving | The region's **Delete the old OCR text here** box was unticked, or your box overlapped less than ~20% of the hidden line. Redraw it larger, and see *"If deleting the old text seems to do nothing"* above. |
| Banner mentions protected lines | Those hidden lines overlap visible ink, so removing them would have erased visible words. Nothing to fix — the visible text is authoritative there. |
| Banner says the deletion "would have changed how the page looks" | The appearance guard rejected it and restored the page. Usually means the text you boxed is actually drawn on the page, so it should not be deleted anyway. |
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
| `test_app.py` | Backend test suite (`python -m unittest test_app`) |
| `tests/ui/` | Optional jsdom tests for the frontend (needs Node.js) |
| `start.bat`, `start.sh`, `start.command` | One-click setup + launch |
| `requirements.txt` | Python dependencies |

Built with [PyMuPDF](https://pymupdf.readthedocs.io/) (rendering + text
insertion), [pytesseract](https://github.com/madmaze/pytesseract) +
[Tesseract](https://github.com/tesseract-ocr/tesseract) (OCR),
[Pillow](https://python-pillow.org/) (crop preprocessing) and
[Flask](https://flask.palletsprojects.com/) (local server).

## License

MIT — see [LICENSE](LICENSE).
