/*
 * Optional frontend tests. The app itself needs no Node.js - these only exist
 * because the sidebar's focus handling is easy to break in ways that are
 * invisible until you try to type.
 *
 *   cd tests/ui && npm install && npm test
 *
 * Pass a path to test a different copy of app.js (handy for bisecting):
 *   node ui.test.mjs ../../static/app.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
const jsPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'static/app.js');
const js = fs.readFileSync(jsPath, 'utf8');

const calls = [];
let failures = 0;

function ok(cond, label) {
  console.log((cond ? '  pass  ' : '  FAIL  ') + label);
  if (!cond) failures++;
}

function group(label) {
  console.log('\n' + label);
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// runScripts: 'dangerously' so the injected inline <script> gets real script
// scope, which is what puts top-level functions on window as a browser does.
// The page's own <script src> never runs - jsdom does not fetch subresources.
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:8765/',
});
const { window } = dom;
const doc = window.document;

const OCR_TEXT = 'W5062 184 garbled';

const HIDDEN_SPANS = [
  { text: 'F1ow ra7e Z14.9 1/m1n', mode: 3, kind: 'invisible', id: 11,
    rect: { x0: 0.12, y0: 0.25, x1: 0.60, y1: 0.28 } },
  { text: '5amp1e 1D QF-348O-<', mode: 0, kind: 'behind image', id: 12,
    rect: { x0: 0.12, y0: 0.30, x1: 0.55, y1: 0.33 } },
];

// Knobs the later regression tests turn: response delays make ordering
// observable, and the document shape has to change to test paging.
const stub = {
  hiddenSpans: HIDDEN_SPANS,
  hiddenDelay: 0,
  ocrDelay: 0,
  pages: [{ index: 0, width: 595, height: 842, rotation: 0, has_text: false }],
  docId: 'a'.repeat(32),
};

window.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, body: opts.body });
  const json = (obj) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => obj,
  });
  if (url.startsWith('/api/hidden/')) {
    if (stub.hiddenDelay) await new Promise((r) => setTimeout(r, stub.hiddenDelay));
    return json({ spans: stub.hiddenSpans, untraceable_chars: 0 });
  }
  switch (url) {
    case '/api/health':
      return json({ ok: true, tesseract: { available: true, version: '5.4.0', langs: ['eng', 'spa'] } });
    case '/api/upload':
      return json({
        doc_id: stub.docId,
        filename: 'scan.pdf',
        pages: stub.pages,
      });
    case '/api/ocr':
      if (stub.ocrDelay) await new Promise((r) => setTimeout(r, stub.ocrDelay));
      return json({
        text: OCR_TEXT,
        existing_invisible_text: 'W5O62 l84 (wrong OCR layer)',
        existing_visible_text: 'a visible caption',
        crop_size: [100, 40],
        preview: 'data:image/png;base64,AAAA',
      });
    case '/api/save':
      return json({
        boxes_applied: 1, boxes_deleted_only: 1, lines_written: 1, unsupported_chars: [],
        chars_removed: 27, lines_protected: 3, pages_appearance_guarded: 1,
        output_name: 'scan_ocr-fixed.pdf', download_url: '/api/download/x',
      });
    default:
      throw new Error('unexpected fetch: ' + url);
  }
};

// jsdom gaps the app touches.
window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.HTMLAnchorElement.prototype.click = function () {};  // suppress download navigation
window.confirm = () => true;

const tag = doc.createElement('script');
tag.textContent = js;
doc.body.appendChild(tag);
await tick(20);

group('health check drives the toolbar');
ok(doc.getElementById('lang').options.length === 2, 'installed languages listed');
ok(doc.getElementById('banner').hidden, 'no error banner while Tesseract is present');

group('loading a document');
await window.loadPdf(new window.File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' }));
ok(!doc.getElementById('pagewrap').hidden, 'page container revealed');
ok(!doc.getElementById('save').hidden, 'save button revealed');
ok(doc.getElementById('pagecount').textContent === '1', 'page count shown');

group('existing hidden text is outlined');
await tick(20);   // the hidden-text fetch is kicked off by showPage()
const outlines = () => [...doc.querySelectorAll('.hx')];
ok(outlines().length === 2, `both hidden objects are outlined (got ${outlines().length})`);
ok(/Hidden text \(invisible text layer\)/.test(outlines()[0].title),
  'the outline names why the text is hidden');
ok(/behind the scan image/.test(outlines()[1].title),
  'buried text is described as being behind the image');
ok(outlines()[0].style.left === '12%', 'outline positioned from the reported rect');
doc.getElementById('showhidden').checked = false;
doc.getElementById('showhidden').dispatchEvent(new window.Event('change', { bubbles: true }));
ok(outlines().length === 0, 'the toggle hides the outlines');
doc.getElementById('showhidden').checked = true;
doc.getElementById('showhidden').dispatchEvent(new window.Event('change', { bubbles: true }));
ok(outlines().length === 2, 'and brings them back');

group('drawing a region runs OCR into the panel');
window.addBox({ x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.35 });
await tick();
const card = doc.querySelector('.card');
const ta = card.querySelector('textarea');
ok(!!ta, 'a card with a textarea appears');
ok(ta.value === OCR_TEXT, 'textarea is prefilled with the OCR result');
ok(doc.querySelectorAll('.bx').length === 1, 'box is drawn on the page overlay');
ok(!!card.querySelector('img.crop'), 'crop preview shown');

group('the textarea must stay editable (regression: focus was lost on click)');
ta.focus();
ok(doc.activeElement === ta, 'focus survives clicking into the textarea');
const typed = 'W5062184';
ta.value = '';
for (const ch of typed) {
  if (doc.activeElement !== ta) break;   // a re-render would break the loop here
  ta.value += ch;
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
}
ok(doc.activeElement === ta, 'focus survives typing');
ok(ta.value === typed, `textarea holds the typed value (got "${ta.value}")`);

group('OCR finishing elsewhere must not steal the caret');
window.addBox({ x0: 0.1, y0: 0.5, x1: 0.8, y1: 0.6 });
const first = doc.querySelector('.card textarea');
first.focus();
first.value = 'EDITED FIRST';
first.dispatchEvent(new window.Event('input', { bubbles: true }));
first.setSelectionRange(6, 6);
await tick(40);   // the second region's OCR lands mid-typing
ok(doc.activeElement === doc.querySelector('.card textarea'), 'caret stays in region 1');
ok(doc.querySelector('.card textarea').selectionStart === 6, 'caret offset preserved');

group('deleting the old OCR text is opt-out per region');
const firstCard = doc.querySelector('.card');
const replaceBox = firstCard.querySelector('.note-check input');
ok(!!replaceBox, 'a per-region "delete old OCR text" checkbox appears when hidden text exists');
ok(replaceBox.checked, 'it defaults to on, following the global setting');
const notes = [...firstCard.querySelectorAll('.note')].map((n) => n.textContent).join(' | ');
ok(/invisible, so deleting it changes nothing/.test(notes),
  'the hidden layer is described as safe to delete');
ok(/visible text, which is always kept/.test(notes),
  'visible text in the same region is reported as kept, not as a hazard');
ok(!firstCard.querySelector('.note.warn'), 'no scare styling: nothing here is destructive');
replaceBox.checked = false;
replaceBox.dispatchEvent(new window.Event('change', { bubbles: true }));

group('saving sends the edited text, not the OCR guess');
doc.getElementById('save').click();
await tick();
const saved = calls.filter((c) => c.url === '/api/save').pop();
ok(!!saved, 'save request issued');
const payload = JSON.parse(saved.body);
ok(payload.boxes.length === 2, `both regions sent (got ${payload.boxes.length})`);
ok(payload.boxes[0].text === 'EDITED FIRST', `region 1 carries the edit (got "${payload.boxes[0].text}")`);
ok(Math.abs(payload.boxes[0].rect.x0 - 0.1) < 1e-9, 'normalised coordinates passed through unchanged');
ok(payload.doc_id === 'a'.repeat(32), 'doc id passed through');
ok(payload.replace_existing === true, 'global replace setting sent');
ok(payload.boxes[0].replace === false, 'region 1 opted out of replacement');
ok(payload.boxes[1].replace === true, 'region 2 kept the default');
const banner = doc.getElementById('banner').textContent;
ok(banner.includes('27 character'), 'save banner reports how much old text was deleted');
ok(/page still looks the same/.test(banner), 'banner states the page is unchanged');
ok(/3 hidden line\(s\) were kept/.test(banner), 'protected lines are reported');
ok(/would have changed how the page looks/.test(banner),
  'appearance-guarded pages are reported rather than silently shipped');

group('discarding a region');
doc.querySelector('.card-head .del').click();
ok(doc.querySelectorAll('.card').length === 1, 'card removed');
ok(doc.querySelectorAll('.bx').length === 1, 'overlay box removed');

group('clicking a hidden outline picks that text up');
// Start from a clean slate so counts are unambiguous.
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
ok(doc.querySelectorAll('.card').length === 0, 'no regions queued');
const ocrCallsBefore = calls.filter((c) => c.url === '/api/ocr').length;

// jsdom reports a zero-sized overlay, so give it real geometry for pointer maths.
const overlay = doc.getElementById('overlay');
Object.defineProperty(overlay, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ left: 0, top: 0, width: 800, height: 1000, right: 800, bottom: 1000 }),
});
const pointer = (type, target, x, y) => target.dispatchEvent(
  new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

pointer('pointerdown', outlines()[1], 200, 310);
pointer('pointerup', overlay, 202, 311);           // a tap, not a drag
await tick(10);
let picked = [...doc.querySelectorAll('.card')];
ok(picked.length === 1, `tapping an outline created one region (got ${picked.length})`);
ok(picked[0].querySelector('textarea').value === HIDDEN_SPANS[1].text,
  'prefilled with the existing hidden text, ready to correct');
ok(calls.filter((c) => c.url === '/api/ocr').length === ocrCallsBefore,
  'no OCR call needed - the text is already known');
ok(/existing text/.test(picked[0].querySelector('.card-head').textContent),
  'the card is marked as coming from the PDF');
ok(!!doc.querySelector('.hx.used'), 'the claimed outline is marked as used');

pointer('pointerdown', outlines()[1], 200, 310);
pointer('pointerup', overlay, 200, 310);
await tick(10);
ok(doc.querySelectorAll('.card').length === 1, 'tapping it again selects, does not duplicate');

group('a drag starting on an outline still draws a new box');
pointer('pointerdown', outlines()[0], 150, 255);
pointer('pointermove', overlay, 420, 430);
pointer('pointerup', overlay, 420, 430);
await tick(30);
ok(doc.querySelectorAll('.card').length === 2, 'the drag drew a second region');
ok(calls.filter((c) => c.url === '/api/ocr').length > ocrCallsBefore,
  'and that one did run OCR');

group('Delete key marks the selected region for deletion');
const key = (k, opts = {}) => doc.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

// Pick up a fresh outline; focus must stay off the text field so Delete is free.
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
pointer('pointerdown', outlines()[0], 200, 260);
pointer('pointerup', overlay, 200, 260);
await tick(10);
ok(doc.activeElement !== doc.querySelector('.card textarea'),
  'clicking an outline does not focus the field, leaving Delete usable');

key('Delete');
await tick(10);
let marked = doc.querySelector('.card');
ok(marked.classList.contains('delonly'), 'Delete marked the region as delete-only');
ok(marked.querySelector('textarea').disabled, 'its field is disabled');
ok(doc.querySelectorAll('.card').length === 1, 'the region itself is kept');
ok(marked.querySelector('textarea').value === HIDDEN_SPANS[0].text,
  'the text is kept for reference, so the decision is reversible');

key('Delete');
await tick(10);
ok(doc.querySelectorAll('.card').length === 1, 'pressing Delete again is harmless');

group('Shift+Delete discards the region entirely');
key('Delete', { shiftKey: true });
await tick(10);
ok(doc.querySelectorAll('.card').length === 0, 'the region is gone');
ok(!doc.querySelector('.hx.used'), 'and its outline is available again');

group('Delete inside the text field still edits text');
pointer('pointerdown', outlines()[0], 200, 260);
pointer('pointerup', overlay, 200, 260);
await tick(10);
const editing = doc.querySelector('.card textarea');
editing.focus();
key('Delete');
await tick(10);
ok(!doc.querySelector('.card').classList.contains('delonly'),
  'typing in the field is not hijacked by the shortcut');

group('delete-only regions reach the backend');
// A second, ordinary region so the payload carries both kinds.
window.addBox({ x0: 0.2, y0: 0.6, x1: 0.7, y1: 0.7 });
await tick(30);
ok(doc.querySelectorAll('.card').length === 2, 'two regions queued');

const onlyBtn = [...doc.querySelectorAll('.card')[0].querySelectorAll('.card-head button')]
  .find((b) => b.textContent === 'Delete only');
ok(!!onlyBtn, 'cards offer a "Delete only" action');
onlyBtn.click();
const flipped = doc.querySelectorAll('.card')[0];
ok(flipped.classList.contains('delonly'), 'the card shows delete-only styling');
ok(flipped.querySelector('textarea').disabled, 'its text field is disabled');
ok([...flipped.querySelectorAll('.card-head button')].some((b) => b.textContent === 'Keep text'),
  'the action flips to "Keep text"');

doc.getElementById('save').click();
await tick(30);
const delPayload = JSON.parse(calls.filter((c) => c.url === '/api/save').pop().body);
const delBox = delPayload.boxes.find((b) => b.delete_only);
ok(!!delBox, 'the delete-only flag reaches the backend');
ok(delBox.text === '', 'and it carries no text to write');
ok(delBox.replace === true, 'replacement is forced on for it');
ok(delPayload.boxes.filter((b) => !b.delete_only).length === 1,
  'the other region is sent normally');

/* ------------------------------------------------------------------------- *
 * Regressions from the flicker / save-mismatch hunt.
 * ------------------------------------------------------------------------- */

const hiddenCalls = () => calls.filter((c) => c.url.startsWith('/api/hidden/')).length;
const pageImg = () => doc.getElementById('pageimg');

group('an in-flight OCR reply must not overwrite what was typed');
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
stub.ocrDelay = 60;
window.addBox({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 });
await tick(10);                       // card exists, OCR still running
const busyTa = doc.querySelector('.card textarea');
ok(!!busyTa && !busyTa.disabled, 'the field is usable while OCR runs');
busyTa.focus();
busyTa.value = 'TYPED WHILE BUSY';
busyTa.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick(120);                      // the reply lands after the typing
ok(doc.querySelector('.card textarea').value === 'TYPED WHILE BUSY',
  `the typed text survives the OCR reply (got "${doc.querySelector('.card textarea').value}")`);
stub.ocrDelay = 0;

group('a fresh region still takes the OCR result');
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
window.addBox({ x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.4 });
await tick(40);
ok(doc.querySelector('.card textarea').value === OCR_TEXT,
  'an untouched region is still filled from OCR');

group('drawing a box while editing another region moves the caret to the new box');
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
window.addBox({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 });
await tick(40);
const editFirst = doc.querySelector('.card textarea');
editFirst.focus();
editFirst.value = 'CORRECTED ONE';
editFirst.dispatchEvent(new window.Event('input', { bubbles: true }));
pointer('pointerdown', overlay, 100, 600);
pointer('pointermove', overlay, 500, 700);
pointer('pointerup', overlay, 500, 700);
await tick(60);
const cards2 = [...doc.querySelectorAll('.card')];
ok(cards2.length === 2, `a second region was drawn (got ${cards2.length})`);
const selected = doc.querySelector('.card.sel');
ok(!!selected && selected !== cards2[0],
  'the new region is the selected one, not the one being edited');
ok(cards2[0].querySelector('textarea').value === 'CORRECTED ONE',
  'the earlier correction is untouched');

group('two hidden spans with the same text stay separate objects');
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
stub.hiddenSpans = [
  { text: 'Total', mode: 3, kind: 'invisible', id: 21,
    rect: { x0: 0.10, y0: 0.20, x1: 0.30, y1: 0.24 } },
  { text: 'Total', mode: 3, kind: 'invisible', id: 22,
    rect: { x0: 0.10, y0: 0.60, x1: 0.30, y1: 0.64 } },
];
// Re-upload so the hidden cache is dropped and the new spans are fetched.
await window.loadPdf(new window.File([new Uint8Array([1])], 'dup.pdf', { type: 'application/pdf' }));
await tick(40);
ok(outlines().length === 2, `both same-text spans are outlined (got ${outlines().length})`);
pointer('pointerdown', outlines()[0], 150, 220);
pointer('pointerup', overlay, 150, 220);
await tick(20);
ok(doc.querySelectorAll('.card').length === 1, 'the first one is picked up');
ok(doc.querySelectorAll('.hx.used').length === 1,
  `only the clicked outline is marked used (got ${doc.querySelectorAll('.hx.used').length})`);
pointer('pointerdown', outlines()[1], 150, 620);
pointer('pointerup', overlay, 150, 620);
await tick(20);
ok(doc.querySelectorAll('.card').length === 2,
  `the second occurrence is reachable too (got ${doc.querySelectorAll('.card').length} card(s))`);
doc.getElementById('save').click();
await tick(30);
const dupPayload = JSON.parse(calls.filter((c) => c.url === '/api/save').pop().body);
ok(dupPayload.boxes.length === 2, 'both are sent to the backend');
ok(Math.abs((dupPayload.boxes[0]?.rect.y0 ?? -1) - 0.20) < 1e-9
  && Math.abs((dupPayload.boxes[1]?.rect.y0 ?? -1) - 0.60) < 1e-9,
  'each carries its own coordinates, so a correction lands on the right one');

group('a cancelled drag cannot become a phantom region');
while (doc.querySelector('.card-head .del')) doc.querySelector('.card-head .del').click();
pointer('pointerdown', overlay, 100, 100);
pointer('pointermove', overlay, 300, 300);
overlay.dispatchEvent(new window.MouseEvent('pointercancel', { bubbles: true, button: 0, clientX: 300, clientY: 300 }));
ok(doc.querySelectorAll('.ghost').length === 0, 'the ghost rectangle is cleaned up');
pointer('pointerup', overlay, 700, 900);          // a later stray release
await tick(30);
ok(doc.querySelectorAll('.card').length === 0,
  `no phantom region was created (got ${doc.querySelectorAll('.card').length})`);

group('paging is quiet: no refetch, no rebuilt cards');
stub.docId = 'b'.repeat(32);
stub.pages = [0, 1, 2].map((i) => ({ index: i, width: 595, height: 842, rotation: 0, has_text: false }));
stub.hiddenSpans = HIDDEN_SPANS;
await window.loadPdf(new window.File([new Uint8Array([1])], 'multi.pdf', { type: 'application/pdf' }));
await tick(40);
ok(doc.getElementById('pagecount').textContent === '3', 'a 3-page document is loaded');

window.addBox({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 });
await tick(40);
const keptTa = doc.querySelector('.card textarea');
keptTa.focus();
keptTa.value = 'STILL HERE';
keptTa.dispatchEvent(new window.Event('input', { bubbles: true }));
keptTa.setSelectionRange(5, 5);

const beforeHidden = hiddenCalls();
const beforeSrc = pageImg().src;
// Re-entering the page number you are already on. Going through the field
// rather than `prev` matters: prev is disabled on page 1, so clicking it proves
// nothing about the guard.
doc.getElementById('pageno').value = '1';
doc.getElementById('pageno').dispatchEvent(new window.Event('change', { bubbles: true }));
await tick(30);
ok(hiddenCalls() === beforeHidden, 'a no-op page change does not refetch hidden text');
ok(pageImg().src === beforeSrc, 'and does not reload the page image');
ok(doc.querySelector('.card textarea') === keptTa, 'the live textarea is not replaced');
ok(doc.activeElement === keptTa && keptTa.selectionStart === 5, 'the caret is untouched');

doc.getElementById('pageno').value = '99';    // out of range, clamps to page 3
doc.getElementById('pageno').dispatchEvent(new window.Event('change', { bubbles: true }));
await tick(40);
ok(doc.getElementById('pageno').value === '3', 'an out-of-range page snaps back');

group('a real page change keeps the cards but refreshes outlines');
const cardsBefore = doc.querySelectorAll('.card').length;
const hiddenBeforeReal = hiddenCalls();
doc.getElementById('prev').click();           // page 3 -> page 2, a real move
await tick(40);
ok(hiddenCalls() === hiddenBeforeReal + 1, 'the new page fetches its hidden text');
ok(doc.querySelectorAll('.card').length === cardsBefore,
  'regions from other pages stay listed');
ok(doc.querySelector('.card textarea') === keptTa,
  'and their textareas are still the same live elements');

group('revisiting a page is served from cache');
const beforeRevisit = hiddenCalls();
doc.getElementById('next').click();           // back to page 3, already seen
await tick(40);
doc.getElementById('prev').click();
await tick(40);
ok(hiddenCalls() === beforeRevisit, 'paging back and forth issues no new requests');

group('a slow hidden-text reply for the previous document is discarded');
stub.hiddenDelay = 80;
stub.docId = 'c'.repeat(32);
stub.hiddenSpans = [{ text: 'OLD DOC SPAN', mode: 3, kind: 'invisible', id: 31,
  rect: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.14 } }];
const slow = window.loadPdf(new window.File([new Uint8Array([1])], 'slow.pdf', { type: 'application/pdf' }));
await tick(10);
stub.docId = 'd'.repeat(32);
stub.hiddenSpans = [{ text: 'NEW DOC SPAN', mode: 3, kind: 'invisible', id: 41,
  rect: { x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.54 } }];
stub.hiddenDelay = 0;
await window.loadPdf(new window.File([new Uint8Array([1])], 'new.pdf', { type: 'application/pdf' }));
await slow;
await tick(150);                              // the stale reply arrives late
const titles = outlines().map((o) => o.title).join(' | ');
ok(!/OLD DOC SPAN/.test(titles),
  'the previous document\'s spans never appear over the new one');
ok(/NEW DOC SPAN/.test(titles), 'the current document\'s spans are shown');

console.log(failures === 0
  ? '\nOK - all frontend checks passed'
  : `\nFAILED - ${failures} frontend check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
