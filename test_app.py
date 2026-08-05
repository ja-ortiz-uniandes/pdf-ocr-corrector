"""
Tests for the pieces that are easy to get quietly wrong: where the invisible
text lands, that it really is invisible, that the page still renders
identically, and that the original file is untouched.

Run:  .venv\\Scripts\\python -m unittest test_app        (Windows)
      .venv/bin/python -m unittest test_app             (macOS / Linux)

The OCR tests skip themselves if Tesseract is not installed.
"""

from __future__ import annotations

import hashlib
import io
import shutil
import unittest
import warnings
from pathlib import Path

import fitz

import app as A
import make_sample

SAMPLE = Path(make_sample.OUT)

# Werkzeug's test client hands back lazily-closed file wrappers for send_file
# responses; the warnings are noise, not leaks in this app.
warnings.filterwarnings("ignore", category=ResourceWarning)


def _ensure_sample() -> None:
    if not SAMPLE.exists():
        make_sample.main()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_sample()
        A.WORK_DIR.mkdir(exist_ok=True)
        cls.client = A.app.test_client()
        cls.doc_ids: list[str] = []

    @classmethod
    def tearDownClass(cls):
        for doc_id in cls.doc_ids:
            shutil.rmtree(A.WORK_DIR / doc_id, ignore_errors=True)

    def upload(self, data: bytes, name: str = "test.pdf") -> str:
        res = self.client.post(
            "/api/upload",
            data={"pdf": (io.BytesIO(data), name)},
            content_type="multipart/form-data",
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        doc_id = res.get_json()["doc_id"]
        type(self).doc_ids.append(doc_id)
        return doc_id

    def save(self, doc_id: str, boxes: list[dict]) -> dict:
        res = self.client.post("/api/save", json={"doc_id": doc_id, "boxes": boxes})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return res.get_json()

    @staticmethod
    def norm_hits(page: fitz.Page, needle: str) -> list[tuple[float, float, float, float]]:
        pr = page.rect
        return [(
            (h.x0 - pr.x0) / pr.width, (h.y0 - pr.y0) / pr.height,
            (h.x1 - pr.x0) / pr.width, (h.y1 - pr.y0) / pr.height,
        ) for h in page.search_for(needle)]


class TestUploadAndRender(Base):
    def test_page_metadata(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        meta = A._meta(doc_id)
        self.assertEqual(len(meta["pages"]), 2)
        self.assertAlmostEqual(meta["pages"][0]["width"], 595, delta=1)
        self.assertAlmostEqual(meta["pages"][0]["height"], 842, delta=1)

    def test_render_png_and_cache(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        for _ in range(2):  # second call comes from the on-disk cache
            res = self.client.get(f"/api/page/{doc_id}/0.png?dpi=120")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers["Content-Type"], "image/png")
            self.assertGreater(len(res.data), 5000)
        self.assertTrue((A.WORK_DIR / doc_id / "render" / "p0_120.png").exists())

    def test_rejects_bad_input(self):
        cases = [
            (b"not a pdf at all", "x.pdf"),
            (b"whatever", "x.txt"),
        ]
        for data, name in cases:
            res = self.client.post(
                "/api/upload",
                data={"pdf": (io.BytesIO(data), name)},
                content_type="multipart/form-data",
            )
            self.assertEqual(res.status_code, 400, name)

    def test_rejects_bad_doc_ids(self):
        self.assertEqual(self.client.get("/api/page/nope/0.png").status_code, 400)
        self.assertEqual(self.client.get("/api/page/" + "a" * 32 + "/0.png").status_code, 404)

    def test_page_out_of_range(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        self.assertEqual(self.client.get(f"/api/page/{doc_id}/99.png").status_code, 404)

    def test_static_assets(self):
        for path in ("/", "/static/app.js", "/static/style.css"):
            self.assertEqual(self.client.get(path).status_code, 200, path)


class TestInvisibleText(Base):
    RECT = {"x0": 0.15, "y0": 0.30, "x1": 0.85, "y1": 0.40}

    def test_text_is_searchable_and_invisible(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "PATCHED MARKER 42"}])
        self.assertEqual(out["boxes_applied"], 1)

        doc = fitz.open(out["output_path"])
        try:
            page = doc[0]
            self.assertIn("PATCHED MARKER 42", page.get_text("text"))
            streams = b"".join(doc.xref_stream(x) for x in page.get_contents())
            self.assertIn(b"3 Tr", streams, "text render mode 3 (invisible) missing")
        finally:
            doc.close()

    def test_appearance_unchanged(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "INVISIBLE"}])
        original = fitz.open(SAMPLE)
        patched = fitz.open(out["output_path"])
        try:
            for i in range(original.page_count):
                before = original[i].get_pixmap(dpi=110).tobytes("png")
                after = patched[i].get_pixmap(dpi=110).tobytes("png")
                self.assertEqual(before, after, f"page {i + 1} changed visually")
        finally:
            original.close()
            patched.close()

    def test_original_file_untouched(self):
        before = hashlib.sha256(SAMPLE.read_bytes()).hexdigest()
        doc_id = self.upload(SAMPLE.read_bytes())
        self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "SOMETHING"}])
        stored = A.WORK_DIR / doc_id / "original.pdf"
        self.assertEqual(hashlib.sha256(stored.read_bytes()).hexdigest(), before)
        self.assertEqual(hashlib.sha256(SAMPLE.read_bytes()).hexdigest(), before)

    def test_lands_inside_requested_box(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "ALIGNMENT PROBE"}])
        doc = fitz.open(out["output_path"])
        try:
            hits = self.norm_hits(doc[0], "ALIGNMENT PROBE")
            self.assertEqual(len(hits), 1)
            x0, y0, x1, y1 = hits[0]
            self.assertAlmostEqual(x0, self.RECT["x0"], delta=0.01)
            self.assertGreaterEqual(y0, self.RECT["y0"] - 0.03)
            self.assertLessEqual(y1, self.RECT["y1"] + 0.03)
            self.assertLessEqual(x1, self.RECT["x1"] + 0.03)
        finally:
            doc.close()

    def test_rotated_pages_land_in_the_same_place(self):
        """Boxes are drawn on the rotated view, so /Rotate must not shift them."""
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                src = fitz.open(SAMPLE)
                src[0].set_rotation(rotation)
                data = src.tobytes()
                src.close()

                doc_id = self.upload(data, f"rot{rotation}.pdf")
                out = self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "ROTATION PROBE"}])
                doc = fitz.open(out["output_path"])
                try:
                    page = doc[0]
                    self.assertEqual(page.rotation, rotation, "/Rotate not preserved")
                    hits = self.norm_hits(page, "ROTATION PROBE")
                    self.assertEqual(len(hits), 1)
                    x0, y0, x1, y1 = hits[0]
                    self.assertAlmostEqual(x0, self.RECT["x0"], delta=0.02)
                    self.assertGreaterEqual(y0, self.RECT["y0"] - 0.03)
                    self.assertLessEqual(y1, self.RECT["y1"] + 0.03)
                finally:
                    doc.close()

    def test_multiline_becomes_one_line_each(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": 1,
            "rect": {"x0": 0.1, "y0": 0.25, "x1": 0.9, "y1": 0.45},
            "text": "LINE ALPHA\nLINE BETA\n\nLINE GAMMA\n   ",
        }])
        self.assertEqual(out["lines_written"], 3, "blank lines should be dropped")
        doc = fitz.open(out["output_path"])
        try:
            text = doc[1].get_text("text")
            ys = []
            for needle in ("LINE ALPHA", "LINE BETA", "LINE GAMMA"):
                self.assertIn(needle, text)
                ys.append(self.norm_hits(doc[1], needle)[0][1])
            self.assertEqual(ys, sorted(ys), "lines must stay in reading order")
        finally:
            doc.close()

    def test_multiple_boxes_and_pages(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [
            {"page": 0, "rect": {"x0": 0.1, "y0": 0.25, "x1": 0.5, "y1": 0.28}, "text": "BOX ONE"},
            {"page": 0, "rect": {"x0": 0.1, "y0": 0.30, "x1": 0.5, "y1": 0.33}, "text": "BOX TWO"},
            {"page": 1, "rect": {"x0": 0.1, "y0": 0.25, "x1": 0.9, "y1": 0.30}, "text": "BOX THREE"},
            {"page": 0, "rect": {"x0": 0.1, "y0": 0.5, "x1": 0.5, "y1": 0.55}, "text": "   "},
            {"page": 42, "rect": {"x0": 0.1, "y0": 0.1, "x1": 0.5, "y1": 0.2}, "text": "IGNORED"},
        ])
        self.assertEqual(out["boxes_applied"], 3, "empty and out-of-range boxes skipped")
        doc = fitz.open(out["output_path"])
        try:
            self.assertIn("BOX ONE", doc[0].get_text())
            self.assertIn("BOX TWO", doc[0].get_text())
            self.assertIn("BOX THREE", doc[1].get_text())
            self.assertNotIn("IGNORED", doc[0].get_text() + doc[1].get_text())
        finally:
            doc.close()

    def test_accents_survive_and_unsupported_reported(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": 0, "rect": self.RECT,
            "text": "café naïve señor “quoted” – dash 中",
        }])
        self.assertEqual(out["unsupported_chars"], ["中"])
        doc = fitz.open(out["output_path"])
        try:
            text = doc[0].get_text("text")
            self.assertIn("café naïve señor", text)
            self.assertIn('"quoted"', text, "curly quotes should be folded to ASCII")
        finally:
            doc.close()

    def test_save_validation(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        self.assertEqual(
            self.client.post("/api/save", json={"doc_id": doc_id, "boxes": []}).status_code, 400)
        self.assertEqual(
            self.client.post("/api/save", json={"doc_id": doc_id, "boxes": [
                {"page": 0, "rect": self.RECT, "text": ""}]}).status_code, 400)
        self.assertEqual(
            self.client.post("/api/save", json={"doc_id": doc_id, "boxes": [
                {"page": 0, "rect": {"x0": .5, "y0": .5, "x1": .5001, "y1": .5001},
                 "text": "tiny"}]}).status_code, 400)

    def test_download_requires_a_save(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        self.assertEqual(self.client.get(f"/api/download/{doc_id}").status_code, 404)
        self.save(doc_id, [{"page": 0, "rect": self.RECT, "text": "DOWNLOAD ME"}])
        res = self.client.get(f"/api/download/{doc_id}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["Content-Type"], "application/pdf")
        self.assertTrue(res.data.startswith(b"%PDF"))


class TestSanitize(unittest.TestCase):
    def test_typographic_folding(self):
        clean, dropped = A._sanitize("“A” – B… ’")
        self.assertEqual(clean, '"A" - B... \'')
        self.assertEqual(dropped, [])

    def test_unsupported_replaced_once_each(self):
        clean, dropped = A._sanitize("a中文b中")
        self.assertEqual(clean, "a??b?")
        self.assertEqual(dropped, ["中", "文"])

    def test_newlines_preserved(self):
        clean, _ = A._sanitize("one\ntwo")
        self.assertEqual(clean, "one\ntwo")


class TestOcr(Base):
    # The grey block on sample page 1 sits at roughly y 150-325pt of 842.
    BLOCK = {"x0": 0.094, "y0": 0.208, "x1": 0.906, "y1": 0.417}
    LINE = {"x0": 0.120, "y0": 0.316, "x1": 0.500, "y1": 0.334}  # "Turbidity ... 3.7 NTU"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not A._tesseract_info()["available"]:
            raise unittest.SkipTest("Tesseract is not installed")

    def ocr(self, doc_id, rect, **kw):
        payload = {"doc_id": doc_id, "page": 0, "rect": rect}
        payload.update(kw)
        res = self.client.post("/api/ocr", json=payload)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return res.get_json()

    def test_reads_image_only_block(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.ocr(doc_id, self.BLOCK, psm=6)
        for needle in ("Flow rate", "Turbidity", "QF-2291-B"):
            self.assertIn(needle, out["text"])
        self.assertTrue(out["preview"].startswith("data:image/png;base64,"))

    def test_single_line_mode(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.ocr(doc_id, self.LINE, psm=7)
        self.assertIn("3.7", out["text"])
        self.assertIn("NTU", out["text"])

    def test_reports_existing_text_in_region(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.ocr(doc_id, {"x0": 0.05, "y0": 0.05, "x1": 0.95, "y1": 0.20})
        self.assertIn("Quarterly Field Report", out["existing_text"])

    def test_preprocessing_flags_accepted(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.ocr(doc_id, self.LINE, psm=7, binarize=True, ocr_dpi=600)
        self.assertIn("NTU", out["text"])
        # invert is for light-on-dark scans; here it just must not blow up.
        inverted = self.ocr(doc_id, self.LINE, psm=7, invert=True)
        self.assertIn("text", inverted)
        self.assertIn("preview", inverted)

    def test_out_of_range_dpi_is_clamped_not_rejected(self):
        """Absurd DPI values must be clamped server-side, never crash."""
        doc_id = self.upload(SAMPLE.read_bytes())
        high = self.ocr(doc_id, self.LINE, psm=7, ocr_dpi=99999)
        self.assertIn("Turbidity", high["text"])
        # The low end is clamped to 150 dpi, which still reads (less reliably).
        low = self.ocr(doc_id, self.LINE, psm=7, ocr_dpi=1)
        self.assertIn("Turbidity", low["text"])

    def test_parameter_validation(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        bad = [
            {"psm": 5},                      # unsupported segmentation mode
            {"lang": "../etc/passwd"},       # injection attempt
        ]
        for kw in bad:
            payload = {"doc_id": doc_id, "page": 0, "rect": self.BLOCK}
            payload.update(kw)
            self.assertEqual(self.client.post("/api/ocr", json=payload).status_code, 400, kw)

        self.assertEqual(self.client.post(
            "/api/ocr", json={"doc_id": doc_id, "page": 0}).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/ocr", json={"doc_id": doc_id, "page": 42, "rect": self.BLOCK}).status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
