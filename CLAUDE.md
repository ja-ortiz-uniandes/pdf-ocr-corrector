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
.venv/Scripts/python -m unittest test_app.TestInvisibleText.test_rotated_pages_land_on_what_the_user_boxed
.venv/Scripts/python -m unittest test_app.TestReplaceExistingText

# Regenerate the 3-page test PDF. Pages 1-2 mix a real text layer with an image-only
# block; page 3 adds a deliberately garbled INVISIBLE OCR layer over its block, which
# is the case the `replace` flag exists for. The block's position is hard-coded as
# BLOCK_UNROTATED in test_app.py, so changing the layout means updating that constant.
.venv/Scripts/python make_sample.py

# Inspect / verify a PDF's text layer after a save
.venv/Scripts/python check_pdf_text.py "work/<doc_id>/output/<name>_ocr-fixed.pdf" --find "some text"

# Why did deletion not remove anything? Show render modes and hidden/visible verdicts
.venv/Scripts/python check_pdf_text.py "some.pdf" --modes --page 1

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

**There are two coordinate systems and they differ on rotated pages.** Getting this wrong is silent:
everything looks fine at `/Rotate 0`, which most PDFs use.

| space | reported by | used by |
| --- | --- | --- |
| **view** (rotated) | `page.rect`, `get_pixmap()` — what the browser renders and the user draws on | `get_pixmap(clip=...)`, i.e. the OCR crop |
| **unrotated** (rotation-independent) | never changes when `/Rotate` does | `insert_text()`, `get_text()`, `search_for()`, `get_texttrace()`, redaction annotations |

`_rect_from_norm()` produces a **view** rect; `_text_rect()` converts it to unrotated space via
`page.derotation_matrix`. Every text operation must go through `_text_rect()`; the OCR crop must not.

Beware of writing circular rotation tests: comparing `insert_text()` output against `search_for()` proves
nothing, because both live in unrotated space, so a wrong view→unrotated mapping stays invisible and the
test passes. An earlier version shipped exactly that bug behind exactly that test. The current tests anchor
on `BLOCK_UNROTATED` (taken from `make_sample.py`) and on `find_grey_block()`, which locates the sample's
grey block in the **rendered pixels** — see `test_block_norm_matches_rendered_pixels` and
`test_rotated_pages_land_on_what_the_user_boxed`.

### Region OCR path (`POST /api/ocr`)

Renders **only the clipped region** at up to 900 DPI (never a full-page rasterise), then
`_prep_for_ocr()`: grayscale → upscale if shorter than 120px → optional invert → autocontrast →
unsharp mask → optional Otsu binarise → 12px white margin (Tesseract's line finder needs it).
Returns the OCR text plus a base64 preview of the exact crop that was fed to Tesseract.

Tesseract is located by `TESSERACT_CMD`, then `PATH`, then known Windows/macOS/Linux install paths, so
it works on Windows even when not on PATH. Absence degrades to HTTP 503 with an actionable message, and
`_tesseract_info()` feeds the UI banner and language dropdown.

### Clearing old text (`replace`) — invisible glyphs only

**Hard invariant: visible text is never deleted.** Only render-mode-3 glyphs are removable. A whole-page
box must still leave every drawn word intact (`test_whole_page_box_keeps_all_visible_text`). This is a
structural guarantee, not a warning the user can override — there is no flag that deletes visible text.

Boxes carry a `replace` flag (default on; `replace_existing` sets the request-wide default) controlling
whether the hidden layer goes.

The awkward part: `apply_redactions()` has **no render-mode filter** — it deletes every glyph meeting the
rectangle. Which rectangles get handed to it *is* the safety mechanism.

`_hidden_kind()` decides what counts as an OCR layer rather than content. Real files use several shapes and
missing one makes deletion look broken:

| shape | `get_texttrace()` reports | treated as |
| --- | --- | --- |
| render mode 3 | `type` 3 | hidden (`invisible`) |
| zero opacity | `opacity` 0 | hidden (`transparent`) |
| white fill (old OCR tools) | `type` 0, `color` ≈ (1,1,1) | hidden (`white`) |
| painted before the scan image | `type` 0, plain black — **indistinguishable from content** | hidden (`behind image`), decided by experiment |
| clip-only, render mode 7 | **nothing at all** — the span is absent | hidden, but only reachable via the selection rect |
| modes 4/5/6 (clip + paint) | `type` 0 or 1 | visible |

**Burial is decided by rendering, not by draw order.** Some tools write the OCR text first and paint the
scan over it; the text is ordinary black text that nobody can see. Do not try to settle this from
`get_texttrace()["seqno"]` versus `get_image_info()["number"]` — they are *different sequences* (in the
sample's page 4 the image's real slot is 8, the gap in the span seqnos, while `number` reports 6). Instead
`_buried_candidates()` finds spans lying ≥90% inside an image rect and `_burial_confirmed()` clears them on
a throwaway copy of the file, comparing renders of just that area. The group is tested at once (the common
scan case); if that fails, spans are probed individually, capped at `MAX_BURIAL_PROBES`. Confirmed spans
are passed around as a set of `seqno` values (`buried`) that `_region_text`, `_visible_boxes` and
`_clearable_rects` all accept.

`_clearable_rects()` then plans the deletion:

- **No visible glyph intersects the selection** (the normal scan case): the selection rect itself is
  cleared, which is also the only way to reach clip-only mode-7 text.
- Any hidden span whose bbox overlaps the selection by at least `COVERAGE_TO_DELETE` (20%) is cleared
  **whole**, including the part outside the selection. Selections never align with the OCR layer's own
  boxes, so per-glyph deletion left fragments; this is the behaviour users expect. Below the threshold the
  span is untouched, which keeps a barely clipped neighbouring line safe.
- A hidden span overlapping visible ink is skipped and counted as `lines_protected`.

`_clear_invisible_text()` redacts with `add_redact_annot(rect, fill=False)` +
`apply_redactions(images=KEEP_IMAGES, graphics=KEEP_GRAPHICS, text=DROP_TEXT)`. **`fill=False` is
essential** — the default `fill=(1, 1, 1)` paints a white rectangle over the scan.

Boxes are grouped by page, and a page's redactions are applied **before** any text is inserted; reversing
that order makes `apply_redactions()` strip the text just written.

**The appearance guard makes the invariant enforced rather than intended.** Each touched page is rendered
at `VERIFY_DPI` before and after clearing; if the bytes differ, something visible was removed, so
`_restore_page()` reinstates the page from a pristine second handle on the original file and
`pages_appearance_guarded` is reported. The correction is still inserted. This covers any future
classification gap in `_is_hidden()` — a misclassified layer fails closed instead of destroying content.
`test_appearance_guard_refuses_a_damaging_deletion` monkey-patches `_visible_boxes` to empty to force that
path.

`check_pdf_text.py --modes` prints each span's render mode and hidden/visible verdict using the app's own
`_is_hidden()`, and flags the character-count gap that indicates clip-only text. It is the first thing to
run when deletion appears to do nothing on a real file.

`_region_text()` returns `(visible_text, invisible_text)` for a region, filtered per glyph rather than via
`get_text(clip=...)`. `/api/ocr` surfaces both so the UI can say "this hidden text will go" and "this
visible text is kept" independently.

### Hidden-text outlines (`GET /api/hidden/<doc_id>/<page>`)

The OCR layer is invisible, so the UI outlines it and lets the user click an object instead of guessing
where it sits. The endpoint returns each hidden span's text plus its rect **normalised in view space** —
`(bbox * page.rotation_matrix)` then divided by `page.rect` — which is the inverse of `_text_rect()` and is
what makes a click map straight back to a selection on rotated pages.

Clicking an outline creates a region prefilled with that text, `replace` forced on, and **no OCR call** —
correcting a misread word should not risk a fresh misread. `sourceText` links the region to the span so
re-clicking selects instead of duplicating, and claimed outlines render `.used`.

Clip-only (mode 7) text cannot be outlined at all, so the response also carries `untraceable_chars`; the UI
reports it rather than implying the page is clean.

Drag-versus-tap on an outline is resolved in `pointerup`: a movement under 6px picks the outline up, larger
means the user was drawing a box that happened to start there. Outlines sit at `z-index: 1` under the user's
own boxes so they never steal a click.

### Delete-only regions

A box may carry `delete_only: true` with empty text, which clears the old text and writes nothing (`replace`
is forced on). Empty text *without* that flag is still ignored — otherwise an OCR pass that returned nothing
would silently delete the existing layer. Reported separately as `boxes_deleted_only`.

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

### Caching

`_no_cache()` sends `no-store` for `/`, `/api/*` and **`/static/*`**. A browser holding a stale `app.js`
after an update is indistinguishable from a broken feature, and there is nothing to gain from caching a
local file. `/api/page/*` is exempt: renders are large and immutable per (page, dpi), so that route sets its
own header. The frontend also guards `el.showhidden` for null, so a stale `index.html` degrades to "no
outlines" instead of throwing and taking the whole script down.

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
