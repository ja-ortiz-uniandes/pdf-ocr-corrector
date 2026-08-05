"""
Build samples/sample_missing_ocr.pdf - a test file that mimics a PDF which was
already OCR'd but has gaps: part of each page carries a real text layer, while
the rest is a flattened image with no text behind it at all.

Run:  python make_sample.py
"""

from __future__ import annotations

from pathlib import Path

import fitz

OUT = Path(__file__).resolve().parent / "samples" / "sample_missing_ocr.pdf"

PAGES = [
    {
        "title": "Quarterly Field Report - Page 1",
        "text_layer": [
            "This paragraph has a proper text layer. You can already select it,",
            "search it, and copy it out of the PDF without doing anything.",
        ],
        "image_only": [
            "STATION 14 - INTAKE READINGS",
            "",
            "The lines in this grey block were flattened into a picture, so the",
            "PDF has no text behind them. Selecting them yields nothing.",
            "",
            "Flow rate ......... 128.4 L/min",
            "Turbidity ........ 3.7 NTU",
            "Sample ID ........ QF-2291-B",
        ],
    },
    {
        "title": "Quarterly Field Report - Page 2",
        "text_layer": [
            "Page 2 also starts with a normal, searchable text layer.",
        ],
        "image_only": [
            "HANDWRITTEN-STYLE CAPTION AREA",
            "",
            "Tesseract usually reads clean print like this well, but small or",
            "low-contrast areas often come back wrong - which is exactly what",
            "the editable text box in the app is for.",
            "",
            "Inspector: R. Alvarez        Date: 12 March 2024",
        ],
    },
]

PAGE_W, PAGE_H = 595, 842  # A4 in points
MARGIN = 56
RASTER_ZOOM = 2.2  # renders the flattened block at ~158 dpi


def _render_block(lines: list[str], width: float, height: float) -> bytes:
    """Lay `lines` out on a scratch page and return it as a PNG (no text layer)."""
    scratch = fitz.open()
    page = scratch.new_page(width=width, height=height)
    page.draw_rect(fitz.Rect(0, 0, width, height), color=None, fill=(0.94, 0.94, 0.92))

    y = 26
    for i, line in enumerate(lines):
        if line:
            page.insert_text(
                fitz.Point(20, y),
                line,
                fontname="cobo" if i == 0 else "cour",
                fontsize=12 if i == 0 else 10.5,
                color=(0.1, 0.1, 0.1),
            )
        y += 17

    pix = page.get_pixmap(matrix=fitz.Matrix(RASTER_ZOOM, RASTER_ZOOM), alpha=False)
    png = pix.tobytes("png")
    scratch.close()
    return png


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()

    for spec in PAGES:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)

        page.insert_text(fitz.Point(MARGIN, MARGIN + 8), spec["title"],
                         fontname="hebo", fontsize=15)

        y = MARGIN + 44
        for line in spec["text_layer"]:
            page.insert_text(fitz.Point(MARGIN, y), line, fontname="helv", fontsize=11)
            y += 16

        block = fitz.Rect(MARGIN, y + 18, PAGE_W - MARGIN, y + 18 + 175)
        page.insert_image(block, stream=_render_block(spec["image_only"],
                                                      block.width, block.height))

        note_y = block.y1 + 26
        page.insert_text(
            fitz.Point(MARGIN, note_y),
            "(The grey block above is an image. Draw a box over it in the app.)",
            fontname="heit", fontsize=9, color=(0.45, 0.45, 0.45),
        )

    doc.set_metadata({"title": "Sample PDF with missing OCR text",
                      "producer": "make_sample.py"})
    doc.save(str(OUT), garbage=3, deflate=True)
    doc.close()
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
