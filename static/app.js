/* PDF OCR Corrector - frontend. Plain JS, no libraries, no network beyond
   this local server. Boxes are kept in normalised (0..1) page coordinates so
   zoom level never affects the saved result. */

'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  file: $('file'), docname: $('docname'), banner: $('banner'),
  dropzone: $('dropzone'), pagewrap: $('pagewrap'), pageimg: $('pageimg'),
  overlay: $('overlay'), viewer: $('viewer'),
  pagenav: $('pagenav'), prev: $('prev'), next: $('next'),
  pageno: $('pageno'), pagecount: $('pagecount'),
  zoomgrp: $('zoomgrp'), zoomin: $('zoomin'), zoomout: $('zoomout'),
  zoomval: $('zoomval'), fitw: $('fitw'),
  wholepage: $('wholepage'), save: $('save'),
  lang: $('lang'), psm: $('psm'), ocrdpi: $('ocrdpi'),
  binarize: $('binarize'), invert: $('invert'),
  tessinfo: $('tessinfo'), boxlist: $('boxlist'), status: $('status'),
};

const RENDER_DPI = 150;
const ZOOMS = [0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

const state = {
  doc: null,          // {doc_id, filename, pages:[...]}
  page: 0,            // 0-based
  zoom: 1,
  boxes: [],          // {id, page, rect:{x0,y0,x1,y1}, text, busy, preview, existing, err}
  selected: null,     // box id
  nextId: 1,
  tesseract: null,
  saved: true,
};

/* ------------------------------------------------------------------ utils */

function status(msg, spinning) {
  el.status.innerHTML = (spinning ? '<span class="spin"></span> ' : '') + escapeHtml(msg);
}

function banner(msg, kind) {
  if (!msg) { el.banner.hidden = true; return; }
  el.banner.hidden = false;
  el.banner.className = 'banner' + (kind ? ' ' + kind : '');
  el.banner.textContent = msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const ctype = res.headers.get('content-type') || '';
  let body = null;
  if (ctype.includes('application/json')) body = await res.json();
  if (!res.ok) {
    const msg = (body && (body.message || body.error))
      || (body && body.description) || res.statusText || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return body;
}

/* ------------------------------------------------------------------ health */

(async function health() {
  try {
    const h = await api('/api/health');
    state.tesseract = h.tesseract;
    if (h.tesseract.available) {
      el.tessinfo.textContent = `Tesseract ${h.tesseract.version} - ${h.tesseract.langs.length} language(s)`;
      const langs = h.tesseract.langs.length ? h.tesseract.langs : ['eng'];
      el.lang.innerHTML = langs.map((l) => `<option value="${l}">${l}</option>`).join('');
      // Prefer English, then Spanish, else first available.
      el.lang.value = langs.includes('eng') ? 'eng' : (langs.includes('spa') ? 'spa' : langs[0]);
    } else {
      el.tessinfo.textContent = 'Tesseract not found';
      el.lang.innerHTML = '<option value="eng">eng</option>';
      banner('Tesseract is not installed (or not on PATH), so region OCR will fail. '
        + 'See the README for install steps, then restart the app.', 'err');
    }
  } catch (err) {
    el.tessinfo.textContent = 'health check failed: ' + err.message;
  }
})();

/* ------------------------------------------------------------------ upload */

el.file.addEventListener('change', () => {
  if (el.file.files.length) loadPdf(el.file.files[0]);
  el.file.value = '';
});

['dragenter', 'dragover'].forEach((evt) => el.viewer.addEventListener(evt, (e) => {
  e.preventDefault();
  el.dropzone.classList.add('hot');
}));
['dragleave', 'drop'].forEach((evt) => el.viewer.addEventListener(evt, () => {
  el.dropzone.classList.remove('hot');
}));
el.viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadPdf(f);
});

async function loadPdf(file) {
  if (!state.saved && !confirm('Discard the regions you have not saved yet?')) return;
  status('uploading ' + file.name, true);
  banner('');
  try {
    const fd = new FormData();
    fd.append('pdf', file);
    const doc = await api('/api/upload', { method: 'POST', body: fd });
    state.doc = doc;
    state.boxes = [];
    state.selected = null;
    state.nextId = 1;
    state.saved = true;
    state.page = 0;

    el.docname.textContent = doc.filename;
    el.pagecount.textContent = doc.pages.length;
    el.pageno.max = doc.pages.length;
    el.dropzone.hidden = true;
    el.pagewrap.hidden = false;
    el.pagenav.hidden = el.zoomgrp.hidden = false;
    el.wholepage.hidden = el.save.hidden = false;

    showPage(0);
    fitWidth();
    renderList();
    status(`${doc.pages.length} page(s) loaded`);
  } catch (err) {
    status('upload failed');
    banner('Upload failed: ' + err.message, 'err');
  }
}

/* ------------------------------------------------------------------ paging */

function showPage(n) {
  if (!state.doc) return;
  n = Math.max(0, Math.min(state.doc.pages.length - 1, n));
  state.page = n;
  el.pageno.value = n + 1;
  el.pageimg.src = `/api/page/${state.doc.doc_id}/${n}.png?dpi=${RENDER_DPI}`;
  el.prev.disabled = n === 0;
  el.next.disabled = n === state.doc.pages.length - 1;
  drawBoxes();
  renderList();
}

el.prev.addEventListener('click', () => showPage(state.page - 1));
el.next.addEventListener('click', () => showPage(state.page + 1));
el.pageno.addEventListener('change', () => showPage((parseInt(el.pageno.value, 10) || 1) - 1));

/* ------------------------------------------------------------------ zoom */

function applyZoom() {
  const page = state.doc.pages[state.page];
  const basePx = page.width * (RENDER_DPI / 72);
  el.pagewrap.style.width = Math.round(basePx * state.zoom) + 'px';
  el.zoomval.textContent = Math.round(state.zoom * 100) + '%';
}

function stepZoom(dir) {
  let i = ZOOMS.findIndex((z) => z >= state.zoom - 1e-6);
  if (i < 0) i = ZOOMS.length - 1;
  i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
  state.zoom = ZOOMS[i];
  applyZoom();
}

function fitWidth() {
  const page = state.doc.pages[state.page];
  const basePx = page.width * (RENDER_DPI / 72);
  const avail = el.viewer.clientWidth - 40;
  state.zoom = Math.max(0.1, Math.min(3, avail / basePx));
  applyZoom();
}

el.zoomin.addEventListener('click', () => stepZoom(1));
el.zoomout.addEventListener('click', () => stepZoom(-1));
el.fitw.addEventListener('click', fitWidth);
el.pageimg.addEventListener('load', () => { if (state.doc) applyZoom(); });

/* ------------------------------------------------------------------ drawing */

let drag = null;

el.overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.doc) return;
  if (e.target.closest('.bx')) return;   // clicking an existing box selects it
  const r = el.overlay.getBoundingClientRect();
  drag = {
    x0: (e.clientX - r.left) / r.width,
    y0: (e.clientY - r.top) / r.height,
    x1: (e.clientX - r.left) / r.width,
    y1: (e.clientY - r.top) / r.height,
    ghost: document.createElement('div'),
  };
  drag.ghost.className = 'ghost';
  el.overlay.appendChild(drag.ghost);
  el.overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});

el.overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = el.overlay.getBoundingClientRect();
  drag.x1 = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  drag.y1 = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  const rect = normRect(drag);
  Object.assign(drag.ghost.style, {
    left: rect.x0 * 100 + '%', top: rect.y0 * 100 + '%',
    width: (rect.x1 - rect.x0) * 100 + '%', height: (rect.y1 - rect.y0) * 100 + '%',
  });
});

el.overlay.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const r = el.overlay.getBoundingClientRect();
  const rect = normRect(drag);
  drag.ghost.remove();
  drag = null;
  el.overlay.releasePointerCapture(e.pointerId);
  // Ignore accidental clicks / hairline drags.
  if ((rect.x1 - rect.x0) * r.width < 6 || (rect.y1 - rect.y0) * r.height < 6) {
    select(null);
    return;
  }
  addBox(rect);
});

function normRect(d) {
  return {
    x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1),
    x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1),
  };
}

el.wholepage.addEventListener('click', () => {
  addBox({ x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 }, 3);
});

/* ------------------------------------------------------------------ boxes */

function addBox(rect, psmOverride) {
  const box = {
    id: state.nextId++,
    page: state.page,
    rect,
    text: '',
    busy: true,
    preview: null,
    existing: '',
    err: null,
  };
  state.boxes.push(box);
  state.saved = false;
  select(box.id);
  drawBoxes();
  renderList();
  runOcr(box, psmOverride);
}

async function runOcr(box, psmOverride) {
  box.busy = true;
  box.err = null;
  renderList();
  status(`OCR on region #${indexOf(box)}`, true);
  try {
    const out = await api('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_id: state.doc.doc_id,
        page: box.page,
        rect: box.rect,
        lang: el.lang.value,
        psm: parseInt(psmOverride || el.psm.value, 10),
        ocr_dpi: parseInt(el.ocrdpi.value, 10),
        binarize: el.binarize.checked,
        invert: el.invert.checked,
      }),
    });
    box.text = out.text || '';
    box.preview = out.preview;
    box.existing = out.existing_text || '';
    status(box.text ? `region #${indexOf(box)} read` : `region #${indexOf(box)}: nothing found`);
  } catch (err) {
    box.err = err.message;
    status('OCR failed');
  } finally {
    box.busy = false;
    drawBoxes();
    renderList();
  }
}

function indexOf(box) {
  return state.boxes.indexOf(box) + 1;
}

function select(id) {
  state.selected = id;
  drawBoxes();
  renderList();
  if (id != null) {
    const card = el.boxlist.querySelector(`.card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }
}

function removeBox(id) {
  const i = state.boxes.findIndex((b) => b.id === id);
  if (i < 0) return;
  state.boxes.splice(i, 1);
  if (state.selected === id) state.selected = null;
  state.saved = state.boxes.length === 0 && state.saved;
  drawBoxes();
  renderList();
}

function drawBoxes() {
  el.overlay.querySelectorAll('.bx').forEach((n) => n.remove());
  state.boxes.forEach((b, i) => {
    if (b.page !== state.page) return;
    const d = document.createElement('div');
    d.className = 'bx' + (b.id === state.selected ? ' sel' : '') + (b.busy ? ' pending' : '');
    d.dataset.id = b.id;
    Object.assign(d.style, {
      left: b.rect.x0 * 100 + '%', top: b.rect.y0 * 100 + '%',
      width: (b.rect.x1 - b.rect.x0) * 100 + '%',
      height: (b.rect.y1 - b.rect.y0) * 100 + '%',
    });
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = i + 1;
    d.appendChild(tag);
    d.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(b.id); });
    el.overlay.appendChild(d);
  });
}

function renderList() {
  if (!state.boxes.length) {
    el.boxlist.innerHTML = '<p class="muted pad">No regions yet. Drag a box on the page.</p>';
    el.save.disabled = true;
    return;
  }
  el.save.disabled = false;
  el.boxlist.innerHTML = '';

  state.boxes.forEach((b, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (b.id === state.selected ? ' sel' : '');
    card.dataset.id = b.id;

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = `<span class="num">${i + 1}</span>`
      + `<span>page ${b.page + 1}</span>`
      + `<span class="grow">${b.busy ? '<span class="spin"></span> reading…' : ''}</span>`;

    const goto = document.createElement('button');
    goto.textContent = 'Go';
    goto.title = 'Jump to this region';
    goto.addEventListener('click', () => {
      if (state.page !== b.page) showPage(b.page);
      select(b.id);
    });

    const redo = document.createElement('button');
    redo.textContent = 'Re-OCR';
    redo.title = 'Run OCR again with the current settings';
    redo.disabled = b.busy;
    redo.addEventListener('click', () => runOcr(b));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.addEventListener('click', () => removeBox(b.id));

    head.append(goto, redo, del);
    card.appendChild(head);

    if (b.preview) {
      const img = document.createElement('img');
      img.className = 'crop';
      img.src = b.preview;
      img.alt = 'selected region';
      card.appendChild(img);
    }

    const ta = document.createElement('textarea');
    ta.value = b.text;
    ta.placeholder = b.busy ? 'running OCR…' : 'text to embed at this box';
    ta.spellcheck = false;
    ta.addEventListener('input', () => { b.text = ta.value; state.saved = false; });
    ta.addEventListener('focus', () => select(b.id));
    card.appendChild(ta);

    if (b.err) {
      const note = document.createElement('div');
      note.className = 'note warn';
      note.textContent = 'OCR error: ' + b.err;
      card.appendChild(note);
    } else if (b.existing) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'Note: this area already has text: '
        + b.existing.replace(/\s+/g, ' ').slice(0, 90);
      card.appendChild(note);
    }

    card.addEventListener('pointerdown', (e) => {
      if (e.target.tagName !== 'TEXTAREA') select(b.id);
    });
    el.boxlist.appendChild(card);
  });
}

/* ------------------------------------------------------------------ save */

el.save.addEventListener('click', async () => {
  const boxes = state.boxes
    .filter((b) => b.text.trim())
    .map((b) => ({ page: b.page, rect: b.rect, text: b.text }));

  if (!boxes.length) {
    banner('Nothing to save - every region is empty.', 'err');
    return;
  }
  const empty = state.boxes.length - boxes.length;
  el.save.disabled = true;
  status('writing PDF', true);
  try {
    const out = await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: state.doc.doc_id, boxes }),
    });
    state.saved = true;
    let msg = `Saved ${out.boxes_applied} region(s), ${out.lines_written} line(s) of invisible text.`;
    if (empty) msg += ` ${empty} empty region(s) skipped.`;
    if (out.unsupported_chars.length) {
      msg += ` Characters not supported by the font were replaced with "?": ${out.unsupported_chars.join(' ')}`;
    }
    msg += ' Downloading ' + out.output_name;
    banner(msg, 'ok');
    status('saved ' + out.output_name);

    const a = document.createElement('a');
    a.href = out.download_url;
    a.download = out.output_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    banner('Save failed: ' + err.message, 'err');
    status('save failed');
  } finally {
    el.save.disabled = false;
  }
});

/* ------------------------------------------------------------------ keys */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing) return;
  if (!state.doc) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected != null) { removeBox(state.selected); e.preventDefault(); }
  } else if (e.key === 'Escape') {
    select(null);
  } else if (e.key === 'PageDown' || e.key === 'ArrowRight') {
    showPage(state.page + 1);
  } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
    showPage(state.page - 1);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!state.saved && state.boxes.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});
