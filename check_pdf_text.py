"""
Dump the text layer of a PDF, page by page - handy for confirming that a saved
correction really landed, or for working out why one did not.

Run:  python check_pdf_text.py "path\\to\\file.pdf"
      python check_pdf_text.py "path\\to\\file.pdf" --find "Sample ID"
      python check_pdf_text.py "path\\to\\file.pdf" --modes        # hidden vs visible
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import _confirm_buried, _hidden_kind, _image_rects  # noqa: E402


def dump_modes(doc: fitz.Document, page_no: int | None, source: Path) -> None:
    """
    Show each text span with its render mode and whether the app treats it as
    hidden. If a region's text does not show up here at all, it is clip-only text
    (render mode 7), which get_texttrace() cannot report.
    """
    for i, page in enumerate(doc):
        if page_no is not None and i != page_no:
            continue
        spans = page.get_texttrace()
        images = _image_rects(page)
        buried = _confirm_buried(page, source, i)
        traced = sum(len(s["chars"]) for s in spans)
        extracted = len(page.get_text("text").replace("\n", "").replace(" ", ""))
        print(f"\n--- page {i + 1}: {len(spans)} span(s), {len(images)} image(s) ---")
        for span in spans:
            text = "".join(chr(c[0]) for c in span["chars"]).strip()
            if not text:
                continue
            kind = _hidden_kind(span)
            if kind is None and span.get("seqno") in buried:
                kind = "behind image"
            label = f"HIDDEN[{kind}]" if kind else "visible"
            box = tuple(round(v) for v in span["bbox"])
            print(f"  {label:<22} mode={span['type']} opacity={span['opacity']} "
                  f"colour={span['color']} seqno={span.get('seqno')} bbox={box}")
            print(f"      {text[:88]}")
        if extracted > traced + 5:
            print(f"  NOTE: {extracted} characters extract from this page but only "
                  f"{traced} are traceable.")
            print("        The difference is clip-only text (render mode 7). The app "
                  "clears it via the")
            print("        selection rectangle when the area has no visible text.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Show the extractable text of a PDF.")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--find", help="report which pages contain this string (case-insensitive)")
    ap.add_argument("--max-chars", type=int, default=1200,
                    help="truncate each page's dump (default 1200)")
    ap.add_argument("--modes", action="store_true",
                    help="list text spans with render mode and hidden/visible status")
    ap.add_argument("--page", type=int,
                    help="restrict --modes to this 1-based page number")
    args = ap.parse_args()

    if not args.pdf.exists():
        print(f"no such file: {args.pdf}", file=sys.stderr)
        return 1

    doc = fitz.open(args.pdf)

    if args.modes:
        dump_modes(doc, args.page - 1 if args.page else None, args.pdf)
        doc.close()
        return 0
    hits = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        if args.find and args.find.lower() in text.lower():
            hits.append(i + 1)
        shown = text.strip()
        if len(shown) > args.max_chars:
            shown = shown[:args.max_chars] + " …[truncated]"
        print(f"\n--- page {i + 1} ({len(text.strip())} chars) ---")
        print(shown if shown else "(no extractable text)")

    if args.find:
        print(f"\n'{args.find}' found on page(s): "
              + (", ".join(map(str, hits)) if hits else "none"))
    doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
