"""
Dump the text layer of a PDF, page by page - handy for confirming that a saved
correction really landed.

Run:  python check_pdf_text.py "path\\to\\file.pdf"
      python check_pdf_text.py "path\\to\\file.pdf" --find "Sample ID"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz


def main() -> int:
    ap = argparse.ArgumentParser(description="Show the extractable text of a PDF.")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--find", help="report which pages contain this string (case-insensitive)")
    ap.add_argument("--max-chars", type=int, default=1200,
                    help="truncate each page's dump (default 1200)")
    args = ap.parse_args()

    if not args.pdf.exists():
        print(f"no such file: {args.pdf}", file=sys.stderr)
        return 1

    doc = fitz.open(args.pdf)
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
