# Samples

Generated PDFs are not committed to the repo (see `.gitignore`). Build the test
file yourself:

```
# Windows
.venv\Scripts\python ..\make_sample.py
# macOS / Linux
.venv/bin/python ../make_sample.py
```

That writes `sample_missing_ocr.pdf` here: two A4 pages that each mix a real,
already-searchable text layer with a grey block that was flattened to an image
and therefore has **no** text behind it — exactly the situation this tool
fixes. Open it in the app, drag a box over a grey block, and save.

Any other PDF works just as well; nothing in the app depends on this sample.
