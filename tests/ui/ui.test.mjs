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
  { text: 'F1ow ra7e Z14.9 1/m1n', mode: 3, kind: 'invisible',
    rect: { x0: 0.12, y0: 0.25, x1: 0.60, y1: 0.28 } },
  { text: '5amp1e 1D QF-348O-<', mode: 0, kind: 'behind image',
    rect: { x0: 0.12, y0: 0.30, x1: 0.55, y1: 0.33 } },
];

window.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, body: opts.body });
  const json = (obj) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => obj,
  });
  if (url.startsWith('/api/hidden/')) {
    return json({ spans: HIDDEN_SPANS, untraceable_chars: 0 });
  }
  switch (url) {
    case '/api/health':
      return json({ ok: true, tesseract: { available: true, version: '5.4.0', langs: ['eng', 'spa'] } });
    case '/api/upload':
      return json({
        doc_id: 'a'.repeat(32),
        filename: 'scan.pdf',
        pages: [{ index: 0, width: 595, height: 842, rotation: 0, has_text: false }],
      });
    case '/api/ocr':
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

group('delete-only regions');
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

console.log(failures === 0
  ? '\nOK - all frontend checks passed'
  : `\nFAILED - ${failures} frontend check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
