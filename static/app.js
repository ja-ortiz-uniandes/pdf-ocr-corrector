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
  showhidden: $('showhidden'), hiddenlbl: $('hiddenlbl'),
  lang: $('lang'), psm: $('psm'), ocrdpi: $('ocrdpi'),
  binarize: $('binarize'), invert: $('invert'), replace: $('replace'),
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
  hidden: [],         // hidden text objects on the current page, from /api/hidden
  hiddenPage: null,   // which page state.hidden belongs to
  untraceable: 0,     // hidden chars that cannot be outlined (clip-mode text)
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

function trim(s, max) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
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
    if (el.hiddenlbl) el.hiddenlbl.hidden = false;

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
  loadHidden(n);
}

/* ------------------------------------------------- existing hidden text */

async function loadHidden(pageNo) {
  state.hidden = [];
  state.hiddenPage = pageNo;
  drawHidden();
  try {
    const out = await api(`/api/hidden/${state.doc.doc_id}/${pageNo}`);
    if (state.hiddenPage !== pageNo) return;   // user paged away meanwhile
    state.hidden = out.spans || [];
    state.untraceable = out.untraceable_chars || 0;
    drawHidden();
    if (state.hidden.length || state.untraceable) {
      let msg = `${state.hidden.length} hidden text object(s) on this page`;
      if (state.untraceable) {
        msg += `; ~${state.untraceable} character(s) cannot be outlined (clip-mode`
          + ' text) - draw a box over those by hand';
      }
      status(msg);
    }
  } catch (err) {
    status('could not read hidden text: ' + err.message);
  }
}

function drawHidden() {
  el.overlay.querySelectorAll('.hx').forEach((n) => n.remove());
  // Guard against a stale cached index.html lacking the toggle: better to lose
  // the outlines than to throw and take the whole script down.
  if (!el.showhidden || !el.showhidden.checked) return;

  state.hidden.forEach((span, i) => {
    const d = document.createElement('div');
    d.className = 'hx';
    d.dataset.hidden = i;
    // Grey out ones already claimed by a region, so it is obvious what is queued.
    if (state.boxes.some((b) => b.page === state.page && b.sourceText === span.text)) {
      d.classList.add('used');
    }
    Object.assign(d.style, {
      left: span.rect.x0 * 100 + '%', top: span.rect.y0 * 100 + '%',
      width: (span.rect.x1 - span.rect.x0) * 100 + '%',
      height: (span.rect.y1 - span.rect.y0) * 100 + '%',
    });
    const why = {
      invisible: 'invisible text layer',
      transparent: 'fully transparent text',
      white: 'white-on-white text',
      'behind image': 'text painted behind the scan image',
    }[span.kind] || 'hidden text';
    d.title = `Hidden text (${why}): ${trim(span.text, 120)}`
      + '\nClick to load it for correction, or to delete it.';
    el.overlay.appendChild(d);
  });
}

if (el.showhidden) el.showhidden.addEventListener('change', drawHidden);

function addFromHidden(span) {
  // Already queued? Just select it instead of stacking duplicates.
  const existing = state.boxes.find(
    (b) => b.page === state.page && b.sourceText === span.text);
  if (existing) {
    select(existing.id);
    return;
  }
  const box = {
    id: state.nextId++,
    page: state.page,
    rect: span.rect,
    text: span.text,           // prefilled: usually a typo fix, no OCR needed
    sourceText: span.text,
    busy: false,
    preview: null,
    existingInvisible: span.text,
    existingVisible: '',
    replace: true,             // the point is to get rid of this object
    deleteOnly: false,
    fromHidden: true,
    err: null,
  };
  state.boxes.push(box);
  state.saved = false;
  state.selected = box.id;
  drawBoxes();
  drawHidden();
  renderList();
  focusBox(box.id);
  status('loaded existing hidden text - edit it, or use "Delete only"');
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
  const onHidden = e.target.closest('.hx');
  const r = el.overlay.getBoundingClientRect();
  drag = {
    x0: (e.clientX - r.left) / r.width,
    y0: (e.clientY - r.top) / r.height,
    x1: (e.clientX - r.left) / r.width,
    y1: (e.clientY - r.top) / r.height,
    // Remember the outline under the pointer: a tap picks it up, while an actual
    // drag still means "draw a new box", even when it starts over an outline.
    hiddenIndex: onHidden ? Number(onHidden.dataset.hidden) : null,
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
  const hiddenIndex = drag.hiddenIndex;
  drag.ghost.remove();
  drag = null;
  el.overlay.releasePointerCapture(e.pointerId);
  // Ignore accidental clicks / hairline drags.
  if ((rect.x1 - rect.x0) * r.width < 6 || (rect.y1 - rect.y0) * r.height < 6) {
    if (hiddenIndex != null && state.hidden[hiddenIndex]) {
      addFromHidden(state.hidden[hiddenIndex]);
    } else {
      select(null);
    }
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
    existingInvisible: '',
    existingVisible: '',
    replace: el.replace.checked,   // per box, seeded from the global setting
    deleteOnly: false,
    fromHidden: false,
    sourceText: null,
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
    box.existingInvisible = out.existing_invisible_text || '';
    box.existingVisible = out.existing_visible_text || '';
    status(box.text ? `region #${indexOf(box)} read` : `region #${indexOf(box)}: nothing found`);
  } catch (err) {
    box.err = err.message;
    status('OCR failed');
  } finally {
    box.busy = false;
    const typingElsewhere = document.activeElement
      && document.activeElement.tagName === 'TEXTAREA';
    drawBoxes();
    renderList();
    // Editing the result is the next step, so put the caret there - unless the
    // user is already typing in another region.
    if (state.selected === box.id && !typingElsewhere) focusBox(box.id);
  }
}

function indexOf(box) {
  return state.boxes.indexOf(box) + 1;
}

function select(id) {
  if (state.selected === id) return;   // never rebuild for a no-op selection
  state.selected = id;
  drawBoxes();
  markSelection();
  if (id != null) {
    const card = el.boxlist.querySelector(`.card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }
}

/* Selection changes only toggle classes. Rebuilding the card list here would
   destroy the textarea the user just clicked, taking focus with it. */
function markSelection() {
  el.boxlist.querySelectorAll('.card').forEach((n) => {
    n.classList.toggle('sel', Number(n.dataset.id) === state.selected);
  });
}

function focusBox(id) {
  const ta = el.boxlist.querySelector(`.card[data-id="${id}"] textarea`);
  if (ta) ta.focus();
}

function removeBox(id) {
  const i = state.boxes.findIndex((b) => b.id === id);
  if (i < 0) return;
  state.boxes.splice(i, 1);
  if (state.selected === id) state.selected = null;
  state.saved = state.boxes.length === 0 && state.saved;
  drawBoxes();
  drawHidden();     // an outline may no longer be claimed
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
  // A rebuild throws away the live DOM, so remember where the caret was and
  // put it back afterwards - OCR finishing on one box must not interrupt
  // typing in another.
  let caret = null;
  const active = document.activeElement;
  if (active && active.tagName === 'TEXTAREA') {
    const card = active.closest('.card');
    if (card) {
      caret = {
        id: Number(card.dataset.id),
        start: active.selectionStart,
        end: active.selectionEnd,
      };
    }
  }

  if (!state.boxes.length) {
    el.boxlist.innerHTML = '<p class="muted pad">No regions yet. Drag a box on the page.</p>';
    el.save.disabled = true;
    return;
  }
  el.save.disabled = false;
  el.boxlist.innerHTML = '';

  state.boxes.forEach((b, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (b.id === state.selected ? ' sel' : '')
      + (b.deleteOnly ? ' delonly' : '');
    card.dataset.id = b.id;

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = `<span class="num${b.fromHidden ? ' hidden-src' : ''}">${i + 1}</span>`
      + `<span>page ${b.page + 1}${b.fromHidden ? ' · existing text' : ''}</span>`
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

    const only = document.createElement('button');
    only.textContent = b.deleteOnly ? 'Keep text' : 'Delete only';
    only.title = b.deleteOnly
      ? 'Go back to writing text here'
      : 'Just remove the old text in this area and write nothing';
    only.addEventListener('click', () => {
      b.deleteOnly = !b.deleteOnly;
      b.replace = b.replace || b.deleteOnly;
      state.saved = false;
      renderList();
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Discard';
    del.title = 'Forget this region (changes nothing in the PDF)';
    del.addEventListener('click', () => removeBox(b.id));

    head.append(goto, redo, only, del);
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
    ta.disabled = b.deleteOnly;
    ta.placeholder = b.busy ? 'running OCR…'
      : (b.deleteOnly ? 'old text will be deleted, nothing written'
        : 'text to embed at this box');
    ta.spellcheck = false;
    ta.addEventListener('input', () => { b.text = ta.value; state.saved = false; });
    ta.addEventListener('focus', () => select(b.id));
    card.appendChild(ta);

    if (b.err) {
      const note = document.createElement('div');
      note.className = 'note warn';
      note.textContent = 'OCR error: ' + b.err;
      card.appendChild(note);
    } else {
      if (b.existingInvisible) {
        const wrap = document.createElement('div');
        wrap.className = 'note';

        const chk = document.createElement('label');
        chk.className = 'note-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = b.replace;
        cb.disabled = b.deleteOnly;   // deleting is the entire point of that mode
        cb.addEventListener('change', () => { b.replace = cb.checked; state.saved = false; });
        chk.append(cb, document.createTextNode(' Delete the old OCR text here'));
        wrap.appendChild(chk);

        const detail = document.createElement('div');
        detail.textContent = b.fromHidden
          ? 'Loaded from the PDF: ' + trim(b.existingInvisible, 80)
            + ' - edit it above to correct it, or use "Delete only" to drop it.'
          : 'Wrong OCR text hidden here: ' + trim(b.existingInvisible, 80)
            + ' - invisible, so deleting it changes nothing on the page.';
        wrap.appendChild(detail);
        card.appendChild(wrap);
      }
      if (b.existingVisible) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'This area also has visible text, which is always kept: '
          + trim(b.existingVisible, 70)
          + ' - if it is already correct, this region may not need a correction.';
        card.appendChild(note);
      }
    }

    card.addEventListener('pointerdown', (e) => {
      if (e.target.tagName !== 'TEXTAREA') select(b.id);
    });
    el.boxlist.appendChild(card);
  });

  if (caret) {
    const ta = el.boxlist.querySelector(`.card[data-id="${caret.id}"] textarea`);
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(caret.start, caret.end); } catch (_) { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ save */

el.save.addEventListener('click', async () => {
  const boxes = state.boxes
    .filter((b) => b.deleteOnly || b.text.trim())
    .map((b) => ({
      page: b.page,
      rect: b.rect,
      text: b.deleteOnly ? '' : b.text,
      replace: b.replace,
      delete_only: !!b.deleteOnly,
    }));

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
      body: JSON.stringify({
        doc_id: state.doc.doc_id,
        boxes,
        replace_existing: el.replace.checked,
      }),
    });
    state.saved = true;
    let msg = `Saved ${out.boxes_applied} region(s), ${out.lines_written} line(s) of invisible text.`;
    if (out.boxes_deleted_only) {
      msg += ` ${out.boxes_deleted_only} region(s) were delete-only.`;
    }
    if (out.chars_removed) {
      msg += ` Deleted ${out.chars_removed} character(s) of old hidden text`
        + ' (the page still looks the same).';
    }
    if (out.lines_protected) {
      msg += ` ${out.lines_protected} hidden line(s) were kept because visible text`
        + ' overlaps them.';
    }
    if (out.pages_appearance_guarded) {
      msg += ` On ${out.pages_appearance_guarded} page(s) the deletion would have`
        + ' changed how the page looks, so the old text was left in place;'
        + ' your text was still added.';
    }
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
