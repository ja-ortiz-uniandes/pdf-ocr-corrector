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
from PIL import Image

import app as A
import make_sample

SAMPLE = Path(make_sample.OUT)

# Werkzeug's test client hands back lazily-closed file wrappers for send_file
# responses; the warnings are noise, not leaks in this app.
warnings.filterwarnings("ignore", category=ResourceWarning)

# Page 3's flattened grey block, in unrotated PDF coordinates, derived from
# make_sample.py: x = MARGIN .. PAGE_W - MARGIN, y = 166 .. 341.
BLOCK_UNROTATED = fitz.Rect(56, 166, 539, 341)


def block_view_norm(page: fitz.Page) -> dict:
    """
    Where the grey block sits in the *rendered* image, normalised 0..1.

    This is the shape the browser posts. Going through `rotation_matrix` is what
    makes rotation tests meaningful rather than circular - and
    `test_block_norm_matches_rendered_pixels` anchors this helper itself against
    the actual pixels.
    """
    view = (fitz.Rect(BLOCK_UNROTATED) * page.rotation_matrix).normalize()
    pr = page.rect
    return {
        "x0": (view.x0 - pr.x0) / pr.width, "y0": (view.y0 - pr.y0) / pr.height,
        "x1": (view.x1 - pr.x0) / pr.width, "y1": (view.y1 - pr.y0) / pr.height,
    }


def find_grey_block(page: fitz.Page, dpi: int = 100) -> tuple[float, float, float, float]:
    """Locate the grey block by scanning rendered pixels; returns view-normalised rect."""
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    w, h = img.size
    px = img.load()
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            # block fill is (0.94, 0.94, 0.92) -> roughly (240, 240, 235)
            if 232 <= r <= 245 and 232 <= g <= 245 and 228 <= b <= 240 and r - b >= 3:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise AssertionError("grey block not found in the rendered page")
    return min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h


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
        self.assertEqual(len(meta["pages"]), 3)
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

    def test_block_norm_matches_rendered_pixels(self):
        """
        Anchor: the helper the rotation tests rely on must agree with the pixels
        the user actually sees, at every rotation.
        """
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                doc = fitz.open(SAMPLE)
                try:
                    page = doc[2]
                    page.set_rotation(rotation)
                    expected = block_view_norm(page)
                    x0, y0, x1, y1 = find_grey_block(page)
                    self.assertAlmostEqual(x0, expected["x0"], delta=0.02)
                    self.assertAlmostEqual(y0, expected["y0"], delta=0.02)
                    self.assertAlmostEqual(x1, expected["x1"], delta=0.02)
                    self.assertAlmostEqual(y1, expected["y1"], delta=0.02)
                finally:
                    doc.close()

    def test_rotated_pages_land_on_what_the_user_boxed(self):
        """
        A box drawn over the rendered grey block must place text *on that block*
        in the PDF, for every /Rotate value.

        Comparing insert position against search_for() would prove nothing here:
        both APIs work in unrotated space, so a wrong view->unrotated mapping
        stays invisible. The independent reference is BLOCK_UNROTATED, taken from
        make_sample.py and cross-checked against rendered pixels above.
        """
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                src = fitz.open(SAMPLE)
                src[2].set_rotation(rotation)
                data = src.tobytes()
                norm = block_view_norm(src[2])
                src.close()

                doc_id = self.upload(data, f"rot{rotation}.pdf")
                out = self.save(doc_id, [{
                    "page": 2, "rect": norm, "replace": False, "text": "ROTATION PROBE",
                }])
                doc = fitz.open(out["output_path"])
                try:
                    page = doc[2]
                    self.assertEqual(page.rotation, rotation, "/Rotate not preserved")
                    hits = page.search_for("ROTATION PROBE")
                    self.assertEqual(len(hits), 1, "probe text not found")
                    landed = hits[0]
                    target = fitz.Rect(BLOCK_UNROTATED) + (-6, -6, 6, 6)
                    self.assertTrue(
                        target.contains(landed),
                        f"rot {rotation}: text landed at {tuple(round(v) for v in landed)}, "
                        f"outside the boxed block {tuple(round(v) for v in target)}",
                    )
                finally:
                    doc.close()

    def test_ocr_crop_follows_the_rendered_orientation(self):
        """
        The OCR crop is clipped in view space, so a 90 degree page must yield a
        crop that is taller than wide - proof the clip did not use text space.
        """
        if not A._tesseract_info()["available"]:
            self.skipTest("Tesseract is not installed")
        for rotation, expect_tall in ((0, False), (90, True), (180, False), (270, True)):
            with self.subTest(rotation=rotation):
                src = fitz.open(SAMPLE)
                src[2].set_rotation(rotation)
                data = src.tobytes()
                norm = block_view_norm(src[2])
                src.close()

                doc_id = self.upload(data, f"crop{rotation}.pdf")
                res = self.client.post("/api/ocr", json={
                    "doc_id": doc_id, "page": 2, "rect": norm, "psm": 6, "ocr_dpi": 200,
                })
                self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
                w, h = res.get_json()["crop_size"]
                self.assertEqual(h > w, expect_tall, f"rot {rotation}: crop is {w}x{h}")

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


class TestReplaceExistingText(Base):
    """Page 3 of the sample carries a deliberately wrong *invisible* OCR layer."""

    BAD_PAGE = 2
    # Page 3 has three header lines, so its grey block spans y 166-341pt of 842.
    # Staying inside it matters: the visible caption sits just below at y~367.
    BAD_BLOCK = {"x0": 0.094, "y0": 0.200, "x1": 0.906, "y1": 0.400}
    # Page 1's paragraph is real, visible text.
    VISIBLE_AREA = {"x0": 0.05, "y0": 0.115, "x1": 0.95, "y1": 0.165}

    def test_sample_has_a_bad_invisible_layer(self):
        doc = fitz.open(SAMPLE)
        try:
            self.assertEqual(doc.page_count, 3)
            page = doc[self.BAD_PAGE]
            rect = A._rect_from_norm(page, self.BAD_BLOCK)
            text, visible = A._region_text(page, rect)
            self.assertIn("QF-348O-<", text, "garbled OCR text should be present")
            self.assertFalse(visible, "the bad layer must be invisible")
        finally:
            doc.close()

    def test_replacing_removes_the_bad_text(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": self.BAD_PAGE, "rect": self.BAD_BLOCK, "replace": True,
            "text": "STATION 22 - OUTFLOW READINGS\nFlow rate 214.9 L/min\n"
                    "Turbidity 1.2 NTU\nSample ID QF-3480-C",
        }])
        self.assertGreater(out["chars_removed"], 0)
        self.assertFalse(out["visible_text_removed"], "nothing visible should have gone")

        doc = fitz.open(out["output_path"])
        try:
            text = doc[self.BAD_PAGE].get_text("text")
            self.assertNotIn("QF-348O-<", text, "garbled text survived the replace")
            self.assertNotIn("5amp1e", text)
            self.assertIn("Sample ID QF-3480-C", text, "corrected text missing")
            self.assertIn("Turbidity 1.2 NTU", text)
        finally:
            doc.close()

    def test_replacing_an_invisible_layer_keeps_pixels_identical(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": self.BAD_PAGE, "rect": self.BAD_BLOCK, "replace": True,
            "text": "Sample ID QF-3480-C",
        }])
        original = fitz.open(SAMPLE)
        patched = fitz.open(out["output_path"])
        try:
            before = original[self.BAD_PAGE].get_pixmap(dpi=110).tobytes("png")
            after = patched[self.BAD_PAGE].get_pixmap(dpi=110).tobytes("png")
            self.assertEqual(before, after, "clearing invisible text changed the page")
        finally:
            original.close()
            patched.close()

    def test_replace_off_keeps_both_texts(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": self.BAD_PAGE, "rect": self.BAD_BLOCK, "replace": False,
            "text": "Sample ID QF-3480-C",
        }])
        self.assertEqual(out["chars_removed"], 0)
        doc = fitz.open(out["output_path"])
        try:
            text = doc[self.BAD_PAGE].get_text("text")
            self.assertIn("QF-348O-<", text, "old text should survive when replace is off")
            self.assertIn("Sample ID QF-3480-C", text)
        finally:
            doc.close()

    def test_replace_defaults_on_when_the_box_says_nothing(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": self.BAD_PAGE, "rect": self.BAD_BLOCK, "text": "REPLACED BY DEFAULT",
        }])
        self.assertGreater(out["chars_removed"], 0)

    def test_request_level_flag_can_disable_replacement(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        res = self.client.post("/api/save", json={
            "doc_id": doc_id, "replace_existing": False,
            "boxes": [{"page": self.BAD_PAGE, "rect": self.BAD_BLOCK, "text": "KEEP BOTH"}],
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["chars_removed"], 0)

    def test_visible_text_removal_is_reported(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": 0, "rect": self.VISIBLE_AREA, "replace": True, "text": "NEW VISIBLE AREA TEXT",
        }])
        self.assertTrue(out["visible_text_removed"],
                        "removing visible text must be reported back")
        self.assertGreater(out["chars_removed"], 0)

    def test_removal_is_per_glyph_not_per_line(self):
        """A box over half a line must leave the other half in place."""
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [{
            "page": 0, "rect": {"x0": 0.05, "y0": 0.115, "x1": 0.45, "y1": 0.165},
            "replace": True, "text": "PARTIAL",
        }])
        doc = fitz.open(out["output_path"])
        try:
            text = doc[0].get_text("text")
            self.assertIn("already select it,", text, "right-hand remainder should survive")
            self.assertNotIn("This paragraph has a proper", text, "left side should be gone")
        finally:
            doc.close()

    def test_multiple_boxes_on_one_page_all_get_cleared(self):
        doc_id = self.upload(SAMPLE.read_bytes())
        out = self.save(doc_id, [
            {"page": self.BAD_PAGE, "rect": {"x0": 0.1, "y0": 0.205, "x1": 0.9, "y1": 0.30},
             "replace": True, "text": "FIRST HALF"},
            {"page": self.BAD_PAGE, "rect": {"x0": 0.1, "y0": 0.30, "x1": 0.9, "y1": 0.395},
             "replace": True, "text": "SECOND HALF"},
        ])
        self.assertEqual(out["boxes_applied"], 2)
        doc = fitz.open(out["output_path"])
        try:
            text = doc[self.BAD_PAGE].get_text("text")
            self.assertIn("FIRST HALF", text)
            self.assertIn("SECOND HALF", text)
            self.assertNotIn("5amp1e", text)
            self.assertNotIn("F1ow ra7e", text)
        finally:
            doc.close()

    def test_replacement_on_rotated_pages(self):
        """Clearing must hit the boxed block, not some rotation-shifted region."""
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                src = fitz.open(SAMPLE)
                src[self.BAD_PAGE].set_rotation(rotation)
                data = src.tobytes()
                norm = block_view_norm(src[self.BAD_PAGE])
                src.close()

                doc_id = self.upload(data, f"rot-replace{rotation}.pdf")
                out = self.save(doc_id, [{
                    "page": self.BAD_PAGE, "rect": norm, "replace": True,
                    "text": "ROTATED REPLACEMENT",
                }])
                doc = fitz.open(out["output_path"])
                try:
                    page = doc[self.BAD_PAGE]
                    self.assertEqual(page.rotation, rotation)
                    text = page.get_text("text")
                    self.assertIn("ROTATED REPLACEMENT", text)
                    self.assertNotIn("QF-348O-<", text, "bad text survived")
                    self.assertIn("throw the bad text away.", text,
                                  "header outside the box must be left alone")
                finally:
                    doc.close()

    def test_region_text_flags_visible_and_invisible(self):
        doc = fitz.open(SAMPLE)
        try:
            visible_rect = A._rect_from_norm(doc[0], self.VISIBLE_AREA)
            text, visible = A._region_text(doc[0], visible_rect)
            self.assertIn("This paragraph", text)
            self.assertTrue(visible)

            empty_rect = A._rect_from_norm(doc[0], {"x0": 0.05, "y0": 0.75, "x1": 0.4, "y1": 0.8})
            self.assertEqual(A._region_text(doc[0], empty_rect), ("", False))
        finally:
            doc.close()


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
