// web/tooltips.js on a DOM stub (23.09): the page-drawn tooltip that replaces the native `title` one, which the
// game's embedded browser never shows - shown by a LEFT CLICK only since the evening of 23.09 (user: the hover bubbles
// were too much, and hover does not work in the game anyway). Checked:
// - nothing on hover (no listener for it, no timer, no bubble);
// - every title of the page kept in data-tip: the markup's moved at start, `el.title = …` writing data-tip and reading
//   it back (the real ttxSet of web/app.js), a title set as an attribute moved by the ONE observer; where el.title
//   cannot be taken over, elements added with a title moved too - a second run of this file, BULLBA_TIPS_FALLBACK=1;
// - a click on an element that does nothing else shows its words at the pointer; a second click, a press elsewhere,
//   Escape, a scroll, a resize and the window's blur close them; a click on a control keeps its action and shows
//   nothing; live words while shown; the placement inside the window; the markup (heading, items, groups, text only);
// - help dots: presence (hidden while all they list is), their rows, and the HELP MODE: a dot's click shows its
//   cluster's summary, lights the dot and sets the help cursor; in the mode a press on any element with words shows
//   them and nothing else sees the press - neither a button's handler, nor the scene, nor the page's own click
//   listener, and the default is prevented (a <details> would not toggle); keys still reach the page; the same
//   element again closes its bubble; another dot moves the mode; Escape, the same dot, or a press on a place with no
//   words ends it (that press, its release and its click stopped too);
// - the costs: listeners on the document and the window only, no pointermove/pointerover, no timer, no frame except
//   one after a live change, and the observer quiet on the page's own title writes while nothing is shown.
// Not a pixel test. BULLBA_WEB=<dir>/ runs it against another copy of web/.
'use strict';
const HERE = require('node:path').resolve(__dirname).replace(/\\/g, '/') + '/';   // tests/page/: the repository's web/ and mod/ are ../../, the local fixtures ../fixtures-local/
const fs = require('fs'), vm = require('vm'), cp = require('child_process');
const WEB = process.env.BULLBA_WEB || HERE + '../../web/';
const FALLBACK = process.env.BULLBA_TIPS_FALLBACK === '1';
let failures = 0, passed = 0;
function ok(name, cond, extra) {
  if (cond) passed++; else failures++;
  console.log((cond ? 'ok   ' : 'FAIL ') + 'tooltips' + (FALLBACK ? ' (fallback)' : '') + ': ' + name + (extra ? ' ' + extra : ''));
}

// --- Time: timers, frames, microtasks, all by hand --------------------------------------------------------
let clock = 1000, timers = [], timerId = 1, frames = [], micro = [];
function setTimeout_(fn, ms) { const id = timerId++; timers.push({id: id, at: clock + (ms || 0), fn: fn}); return id; }
function clearTimeout_(id) { timers = timers.filter(function (t) { return t.id !== id; }); }
function flushMicro() { let n = 0; while (micro.length) { if (++n > 1000) throw new Error('microtask loop'); micro.shift()(); } }
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift(); clock = t.at; t.fn(); flushMicro();
  }
  clock = end;
}
function flushFrames() { const f = frames; frames = []; f.forEach(function (fn) { fn(clock); }); flushMicro(); }

// --- Elements, with attribute and child-list mutations reported to the observers that watch them -------------
// observe() on a node already watched by the same observer replaces its options, as in the DOM.
const observers = [];
function MO(cb) { this.cb = cb; this.targets = []; this.records = []; this.calls = 0; this.queued = false; observers.push(this); }
MO.prototype.observe = function (el, opts) {
  opts = opts || {};
  this.targets = this.targets.filter(function (t) { return t.el !== el; });
  this.targets.push({el: el, filter: opts.attributeFilter, subtree: !!opts.subtree, attributes: !!(opts.attributes || opts.attributeFilter), childList: !!opts.childList});
};
MO.prototype.disconnect = function () { this.targets = []; this.records = []; };
MO.prototype.takeRecords = function () { const r = this.records; this.records = []; return r; };
function covers(t, el) { return t.el === el || (t.subtree && inside(t.el, el)); }
function queue(o, record) {
  o.records.push(record);
  if (o.queued) return;
  o.queued = true;
  micro.push(function () { o.queued = false; const r = o.takeRecords(); if (r.length) { o.calls++; o.cb(r, o); } });
}
function notify(el, name) {
  observers.forEach(function (o) {
    if (o.targets.some(function (t) { return t.attributes && covers(t, el) && (!t.filter || t.filter.indexOf(name) >= 0); }))
      queue(o, {type: 'attributes', attributeName: name, target: el});
  });
}
function notifyAdded(parent, child) {
  observers.forEach(function (o) {
    if (o.targets.some(function (t) { return t.childList && covers(t, parent); })) queue(o, {type: 'childList', target: parent, addedNodes: [child]});
  });
}
function inside(box, el) { for (let e = el && el.parentNode; e; e = e.parentNode) if (e === box) return true; return false; }
const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
function El(tag) {
  this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.attrs = {}; this.children = [];
  this.parentNode = null; this.style = {}; this.listeners = []; this.onclick = null; this._text = '';
  this.isContentEditable = false;
}
El.prototype.getAttribute = function (k) { return has(this.attrs, k) ? this.attrs[k] : null; };
El.prototype.hasAttribute = function (k) { return has(this.attrs, k); };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); notify(this, k); };
El.prototype.removeAttribute = function (k) { if (!has(this.attrs, k)) return; delete this.attrs[k]; notify(this, k); };
// The element's `title` accessor as a browser has it - replaceable, as HTMLElement.prototype.title is; the fallback run
// makes it fixed, so tooltips.js cannot take it over.
Object.defineProperty(El.prototype, 'title', {configurable: !FALLBACK, enumerable: true,
  get: function () { return this.getAttribute('title') || ''; }, set: function (v) { this.setAttribute('title', v); }});
Object.defineProperty(El.prototype, 'id', {get: function () { return this.getAttribute('id') || ''; }, set: function (v) { this.setAttribute('id', v); }});
Object.defineProperty(El.prototype, 'hidden', {get: function () { return this.hasAttribute('hidden'); }, set: function (v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }});
Object.defineProperty(El.prototype, 'tabIndex', {get: function () {
  const t = this.getAttribute('tabindex');
  return t !== null ? Number(t) : (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(this.tagName) ? 0 : -1);
}});
Object.defineProperty(El.prototype, 'textContent', {get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(''); },
  set: function (v) { this._text = String(v); this.children.forEach(function (c) { c.parentNode = null; }); this.children = []; }});
// The bubble's size from its words: 7 px a character up to the 360 px cap, 18 px a line.
Object.defineProperty(El.prototype, 'offsetWidth', {get: function () { return this.hidden ? 0 : Math.min(360, 20 + 7 * this.textContent.length); }});
Object.defineProperty(El.prototype, 'offsetHeight', {get: function () { return this.hidden ? 0 : 10 + 18 * Math.max(1, Math.ceil(this.textContent.length / 48)); }});
Object.defineProperty(El.prototype, 'firstElementChild', {get: function () { return this.children[0] || null; }});
El.prototype.querySelector = function (sel) {
  const tag = String(sel).toUpperCase();
  for (let i = 0; i < this.children.length; i++) {
    const c = this.children[i];
    if (c.tagName === tag) return c;
    const d = c.querySelector(sel);
    if (d) return d;
  }
  return null;
};
El.prototype.querySelectorAll = function (sel) {
  const a = /^\[([\w-]+)\]$/.exec(sel), out = [];
  if (a) this.children.forEach(function (c) { walk(c, function (e) { if (e.hasAttribute(a[1])) out.push(e); }); });
  return out;
};
El.prototype.cloneNode = function () { const c = new El(this.tagName); Object.keys(this.attrs).forEach(function (k) { c.attrs[k] = this.attrs[k]; }, this); return c; };
// Laid out: on the page, nothing up the chain hidden or display:none, not inside a closed <details> but its summary.
El.prototype.getClientRects = function () {
  for (let e = this, child = null; e; child = e, e = e.parentNode) {
    if (e === document) return [{}];
    if (e.hidden || e.style.display === 'none') return [];
    if (e.tagName === 'DETAILS' && !e.hasAttribute('open') && child && !(child.tagName === 'SUMMARY' && e.children[0] === child)) return [];
  }
  return [];
};
El.prototype.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; notifyAdded(this, c); return c; };
El.prototype.removeChild = function (c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; };
El.prototype.insertBefore = function (c, ref) {
  const at = this.children.indexOf(ref);
  if (at < 0) return this.appendChild(c);
  if (c.parentNode) c.parentNode.removeChild(c);
  this.children.splice(this.children.indexOf(ref), 0, c); c.parentNode = this; notifyAdded(this, c); return c;
};
El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
El.prototype.addEventListener = function (type, fn, opt) {
  this.listeners.push({type: type, fn: fn, capture: !!(opt === true || (opt && opt.capture)), passive: !!(opt && opt.passive)});
};
El.prototype.removeEventListener = function (type, fn, opt) {
  const cap = !!(opt === true || (opt && opt.capture));
  this.listeners = this.listeners.filter(function (l) { return !(l.type === type && l.fn === fn && l.capture === cap); });
};

const html = new El('html'), head = new El('head'), body = new El('body');
html.clientWidth = 1280; html.clientHeight = 720;
html.appendChild(head); html.appendChild(body);
function walk(el, fn) { fn(el); el.children.forEach(function (c) { walk(c, fn); }); }
const document = {nodeType: 9, documentElement: html, head: head, body: body, listeners: [], parentNode: null,
  createElement: function (t) { return new El(t); },
  createTextNode: function (t) { const e = new El('#text'); e.textContent = String(t); return e; },
  getElementById: function (id) { let f = null; walk(html, function (e) { if (!f && e.getAttribute('id') === id) f = e; }); return f; },
  querySelectorAll: function (sel) { const a = /^\[([\w-]+)\]$/.exec(sel), out = []; if (a) walk(html, function (e) { if (e.hasAttribute(a[1])) out.push(e); }); return out; },
  addEventListener: El.prototype.addEventListener, removeEventListener: El.prototype.removeEventListener};
html.parentNode = document;
function cursorOf(el) { for (let e = el; e && e.nodeType === 1; e = e.parentNode) if (e.style.cursor) return e.style.cursor; return 'auto'; }
const win = {document: document, Date: {now: function () { return clock; }}, setTimeout: setTimeout_, clearTimeout: clearTimeout_,
  requestAnimationFrame: function (fn) { frames.push(fn); return frames.length; }, MutationObserver: MO, HTMLElement: El,
  getComputedStyle: function (el) { return {cursor: cursorOf(el)}; }, innerWidth: 1280, innerHeight: 720, listeners: [],
  addEventListener: El.prototype.addEventListener, removeEventListener: El.prototype.removeEventListener, Math: Math, String: String, Object: Object};
win.window = win;

// --- Events: capture from the window down, the target, then bubbling; `onclick` properties run too -----------
function pathOf(el) { const p = []; for (let e = el; e; e = e.parentNode) p.push(e); return p; }
function runAt(node, ev, capture) {
  (node.listeners || []).filter(function (l) { return l.type === ev.type && l.capture === capture; })
    .forEach(function (l) { ev._passive = l.passive; l.fn.call(node, ev); ev._passive = false; });
  if (!capture && ev.type === 'click' && typeof node.onclick === 'function') node.onclick(ev);
}
function dispatch(type, target, props) {
  const ev = Object.assign({type: type, target: target, bubbles: true, isTrusted: true, clientX: 0, clientY: 0, buttons: 0,
    button: 0, detail: 1, relatedTarget: null, defaultPrevented: false, _stop: false}, props || {});
  ev.stopPropagation = function () { this._stop = true; };
  ev.preventDefault = function () { if (!this._passive) this.defaultPrevented = true; };
  const up = target === win ? [win] : pathOf(target).concat([win]);
  const down = up.slice().reverse();
  for (let i = 0; i < down.length - 1 && !ev._stop; i++) runAt(down[i], ev, true);
  if (!ev._stop) { runAt(target, ev, true); runAt(target, ev, false); }
  if (ev.bubbles) for (let i = 1; i < up.length && !ev._stop; i++) runAt(up[i], ev, false);
  flushMicro();
  return ev;
}
function hover(el, x, y) {
  dispatch('pointerover', el, {clientX: x, clientY: y});
  dispatch('pointermove', el, {clientX: x + 3, clientY: y + 2});
}
// A left click as a mouse gives it: press, its mouse twin, release, its twin, click.
function press(el, x, y, extra) {
  const d = dispatch('pointerdown', el, Object.assign({clientX: x, clientY: y, buttons: 1}, extra || {}));
  const md = dispatch('mousedown', el, Object.assign({clientX: x, clientY: y, buttons: 1}, extra || {}));
  const u = dispatch('pointerup', el, {clientX: x, clientY: y});
  const mu = dispatch('mouseup', el, {clientX: x, clientY: y});
  const c = dispatch('click', el, Object.assign({clientX: x, clientY: y}, extra || {}));
  return {down: d, mdown: md, up: u, mup: mu, click: c, all: [d, md, u, mu, c]};
}
// Every event of a press taken: stopped and its default prevented.
function taken(r) { return r.all.every(function (e) { return e._stop && e.defaultPrevented; }); }
function untouched(r) { return r.all.every(function (e) { return !e._stop && !e.defaultPrevented; }); }
function keyDown(key) { return dispatch('keydown', body, {key: key}); }
function node(tag, parent, attrs) {
  const el = new El(tag);
  Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  (parent || body).appendChild(el);
  return el;
}

// --- The fixture: a few of the page's kinds of element ------------------------------------------------------
// The page's own listeners, there before tooltips.js: a click listener in the bubble phase (the popovers' closer of
// app.js is one) and the keys (the ⌖ drive's WASD).
let pageClicks = 0; const pageKeys = [];
body.addEventListener('click', function () { pageClicks++; });
body.addEventListener('keydown', function (e) { pageKeys.push(e.key); });
const header = node('div');
let fitClicks = 0;
const fit = node('button', header, {title: 'Zoom so that the whole vehicle is on screen'});
fit.style.cursor = 'pointer';
fit.onclick = function () { fitClicks++; };
const fitGlyph = node('span', fit);
const plain = node('div'), plainChild = node('span', plain);
const viewport = node('div', body, {id: 'viewport', tabindex: '0', role: 'img'});
viewport.style.cursor = 'crosshair';
const canvas = node('canvas', viewport);
let canvasDowns = 0, sceneClicks = 0;
viewport.addEventListener('pointerdown', function () { canvasDowns++; });
viewport.addEventListener('click', function () { sceneClicks++; });
const panel = node('div', viewport, {id: 'ttx-panel'}), compact = node('div', panel, {id: 'ttx-compact'});
const row = node('span', compact, {'data-key': 'dpm'});
const rowIcon = node('span', row), rowValue = node('b', row);
row.ttx = {glyph: 'dpm', icon: rowIcon, value: rowValue, text: '—', cmp: '', title: ''};
const row2 = node('span', compact, {'data-key': 'reload', title: 'Reload, s. Stock 7.2.'});
const hp = node('span', viewport, {id: 'target-hp', role: 'img', title: 'Target HP 1 500 / 2 000'});
const nest = node('div', body, {title: 'Outer words'}), nestPlain = node('span', nest), nestOwn = node('span', nest, {title: 'Inner words'});
const nestBtnHolder = node('div', body, {title: 'A group with a control in it'});
let groupBtnClicks = 0;
const nestBtn = node('button', nestBtnHolder); nestBtn.onclick = function () { groupBtnClicks++; };
const details = node('details'), summary = node('summary', details, {title: 'Every characteristic'}), popover = node('div', details);
const popRow = node('span', popover, {title: 'Penetration, mm. Stock 258.'});
const lab = node('label', body, {title: 'A label'}), link = node('a', body, {href: '#', title: 'A link'});
const input = node('input', body, {title: 'A field'}), select = node('select', body, {title: 'A choice'});
const roleBtn = node('div', body, {role: 'button', title: 'A role button'});
const propClick = node('div', body, {title: 'A div with an onclick property'}); propClick.onclick = function () {};
const focusable = node('div', body, {tabindex: '0', title: 'A focusable div'});
const pointerDiv = node('div', body, {title: 'A div with a pointer cursor'}); pointerDiv.style.cursor = 'pointer';
const actBtn = node('span', body, {'data-act': 'rename', title: 'Rename'});
const stopper = node('span', body, {title: 'A picture whose own listener stops the click'});
stopper.addEventListener('click', function (e) { e.stopPropagation(); });
const blank = node('span', body, {title: ''});
const fixture = [header, fit, fitGlyph, plain, plainChild, canvas, panel, compact, row, rowIcon, rowValue, row2, hp, nest, nestPlain,
  nestOwn, nestBtnHolder, nestBtn, details, summary, popover, popRow, lab, link, input, select, roleBtn, propClick, focusable, pointerDiv, actBtn];
const ownListeners = fixture.map(function (e) { return e.listeners.length; });

// The real ttxSet of web/app.js: the characteristics panel writes its rows' tooltips live with it.
const appSrc = fs.readFileSync(WEB + 'app.js', 'utf8');
const ttxMatch = /\n  function ttxSet\(row, glyph, text, cmp, title\) \{[\s\S]*?\n  \}\n/.exec(appSrc);
const ttxSet = ttxMatch ? new Function('ttxGlyph', ttxMatch[0] + '; return ttxSet;')(function () { return new El('span'); }) : null;
ok('the real ttxSet of app.js was found and runs here', !!ttxSet);
if (ttxSet) ttxSet(row, 'dpm', '2 400', '', 'DPM, HP/min. Stock 2 400.');
ok('the fixture row carries its title as the page writes it', row.getAttribute('title') === 'DPM, HP/min. Stock 2 400.');

// Help dots, as the page places them: in the model row (a tile, ⌖ and its sub-switches), in the shooter row (a
// group of shell buttons with icons, the mode button, Config), by a labelled checkbox, and inside a titled group.
// Strip (23.09): ⌖ is a drawn crosshair - an <svg> with no text - and names itself by data-glyph.
const mrow = node('div', viewport, {id: 'model-row'});
const mtile = node('button', mrow, {id: 'model-tile', title: 'The collision model on screen · click to pick it'});
const mcap = node('span', mtile); mcap.textContent = 'Collision model';
const mbody = node('span', mtile); mbody.textContent = 'IS-7 heavy tank of tier ten';
node('img', mbody, {src: 'web/flags/ussr.png'});
let funClicks = 0;
const fun = node('button', mrow, {id: 'fun-mode-toggle', title: 'Target HP, RNG shots and Hitmarks.', 'aria-label': 'Target HP, RNG shots and Hitmarks', 'data-glyph': '⌖'});
node('svg', fun, {'class': 'fun-icon', 'aria-hidden': 'true'}); fun.onclick = function () { funClicks++; };
const rr = node('button', mrow, {id: 'real-reload-toggle', title: 'Real reload, with ⌖ on.', 'aria-label': 'Real reload', hidden: ''}); rr.textContent = '◔';
const hpReset = node('button', mrow, {id: 'target-hp-reset', title: 'Fill the health bar again', hidden: ''}); hpReset.textContent = '↺';
const dotA = node('button', mrow, {type: 'button', 'class': 'help-dot', 'data-help-for': 'model-tile fun-mode-toggle real-reload-toggle target-hp-reset no-such-id fun-mode-toggle', 'aria-label': 'Help'});
dotA.textContent = '?';
const srow = node('div', viewport, {id: 'shooter-row'});
const gpanel = node('span', srow, {id: 'gun-panel'});
const gshells = node('span', gpanel, {id: 'gun-shells', role: 'group', 'aria-label': 'Shells of this gun'});
const shAP = node('button', gshells, {title: 'AP · 390 mm · 750 HP'}), shHE = node('button', gshells, {title: 'HE · 105 mm'}), shOff = node('button', gshells, {title: 'Hidden shell', hidden: ''});
[shAP, shHE, shOff].forEach(function (b, i) { const box = node('span', b); node('img', box, {src: 'web/icons/shell' + i + '.png', alt: ''}); });
node('span', shAP).textContent = '✦';
let shellClicks = 0; shAP.onclick = function () { shellClicks++; };
const mech = node('button', gpanel, {id: 'gun-mech', title: 'Siege mode: off. Switch 3 s.', 'aria-label': 'Siege mode'}); mech.textContent = '◧';
const cfg = node('details', srow, {id: 'cfg'});
const cfgSum = node('summary', cfg, {title: 'This shooter’s equipment and perks'}); cfgSum.textContent = 'Config';
const cfgPop = node('div', cfg, {title: 'Inside the closed popover'});
const dotB = node('button', srow, {'class': 'help-dot', 'data-help-for': 'gun-shells gun-mech cfg', 'aria-label': 'Help'}); dotB.textContent = '?';
const afLabel = node('label', body, {title: 'Hold the on-screen size of the vehicle'}); afLabel.textContent = 'Auto-frame';
const afBox = node('input', afLabel, {id: 'auto-x', type: 'checkbox'}), afField = node('input', afLabel, {id: 'auto-x-field', type: 'number'});
const dotC = node('button', body, {'class': 'help-dot', 'data-help-for': 'auto-x auto-x-field', 'aria-label': 'Help'}); dotC.textContent = '?';
const types = node('span', body, {id: 'types', role: 'group', 'aria-label': 'Shell type', title: 'Shell type for the penetration entered here.'});
node('button', types, {'data-kind': 'AP'}).textContent = 'AP'; node('button', types, {'data-kind': 'HE'}).textContent = 'HE';
const dotD = node('button', types, {'class': 'help-dot', 'data-help-for': 'types', 'aria-label': 'Help'}); dotD.textContent = '?';
const lonely = node('span', body, {id: 'lonely', title: 'Never on screen', hidden: ''});
const dotE = node('button', body, {'class': 'help-dot', 'data-help-for': 'lonely', 'aria-label': 'Help'}); dotE.textContent = '?';
dotE.getBoundingClientRect = function () { return {left: 200, top: 300, right: 218, bottom: 318, width: 18, height: 18}; };
dotA.getBoundingClientRect = function () { return {left: 640, top: 40, right: 658, bottom: 58, width: 18, height: 18}; };
const helpFixture = [mrow, mtile, fun, rr, hpReset, dotA, srow, gpanel, gshells, shAP, shHE, mech, cfg, cfgSum, dotB, afLabel, afBox, dotC, types, dotD, dotE];
const helpListeners = helpFixture.map(function (e) { return e.listeners.length; });
// 24.09 (scene-one-path, user: "the help icons disappeared"): two controls the page MOVES and one it makes ANEW. The
// scene toolbar hands its groups to its "More" popover when the row is too narrow and takes them back when it widens
// (app.js layoutToolbar) - and hides "More" then. Here both of the dot's controls sit in "More" when the page loads.
const tbRow = node('div', body, {id: 'tb-row'});
const tbMore = node('details', tbRow, {id: 'tb-more'}), tbPop = node('div', tbMore);
const tbFit = node('button', tbPop, {id: 'tb-fit', title: 'Fit\nZoom so the whole vehicle is on screen.'});
const tbAutoLabel = node('label', tbPop, {title: 'Auto-frame\nKeeps the vehicle’s size on screen.'}), tbAuto = node('input', tbAutoLabel, {id: 'tb-auto', type: 'checkbox'});
const dotT = node('button', tbRow, {'class': 'help-dot', 'data-help-for': 'tb-fit tb-auto', 'aria-label': 'Help'}); dotT.textContent = '?';
const remade = node('button', body, {id: 'remade', title: 'Remade\nA control the page builds anew.'});
const dotR = node('button', body, {'class': 'help-dot', 'data-help-for': 'remade', 'aria-label': 'Help'}); dotR.textContent = '?';

// --- Load ---------------------------------------------------------------------------------------------------
const titledBefore = [];
walk(html, function (e) { if (e.hasAttribute('title')) titledBefore.push([e, e.getAttribute('title')]); });
const src = fs.readFileSync(WEB + 'tooltips.js', 'utf8');
vm.createContext(win);
vm.runInContext(src, win, {filename: 'tooltips.js'});
flushMicro();
const style = head.children.filter(function (e) { return e.tagName === 'STYLE'; })[0];
const bubble = body.children.filter(function (e) { return e.getAttribute('id') === 'page-tip'; })[0];
const obs = observers[0];
const css = style ? style.textContent : '';
const rootWatch = function () { return obs ? obs.targets.filter(function (t) { return t.el === html; })[0] : null; };
ok('loads: one <style> in the head, a hidden bubble in the body, window.BullbaTips.close, and ONE observer',
   !!style && !!bubble && bubble.hidden && typeof win.BullbaTips.close === 'function' && observers.length === 1);
ok('words: every title of the markup moved to data-tip at start - none left for a browser to draw',
   titledBefore.length > 30 && titledBefore.every(function (p) { return p[0].getAttribute('title') === null && p[0].getAttribute('data-tip') === p[1]; }),
   '(' + titledBefore.length + ' titles)');

// --- The fallback: el.title fixed, so the observer moves the titles of added elements too -------------------------
if (FALLBACK) {
  const w = rootWatch();
  ok('the observer watches the whole page for a title attribute AND for elements added, since el.title stayed the browser\'s',
     !!w && w.subtree && w.childList && w.filter.join() === 'title');
  const late = new El('span'); late.title = 'Added later'; const lateKid = new El('b'); lateKid.title = 'Its item'; late.appendChild(lateKid);
  body.appendChild(late); flushMicro();
  ok('an element added with a title - and its items - are parked', late.getAttribute('title') === null && late.getAttribute('data-tip') === 'Added later'
     && lateKid.getAttribute('title') === null && lateKid.getAttribute('data-tip') === 'Its item');
  row2.title = 'Reload, s. Rewritten.'; flushMicro();
  ok('a title written by the page on an element of the page is parked', row2.getAttribute('title') === null && row2.getAttribute('data-tip') === 'Reload, s. Rewritten.');
  press(row2, 300, 300);
  ok('and a click shows it', !bubble.hidden && bubble.textContent === 'Reload, s. Rewritten.');
  console.log('\n' + passed + ' ok, ' + (failures ? failures + ' FAILURES' : 'all passed'));
  process.exitCode = failures ? 1 : 0;
  return;
}

ok('the bubble takes no pointer events, sits above the page, keeps within 360 px, on the page\'s panel: its background and border, 13 px',
   /#page-tip\{[^}]*pointer-events:none/.test(css) && /position:fixed/.test(css) && /z-index:10000/.test(css)
   && /max-width:360px/.test(css) && /#page-tip\{[^}]*border:1px solid #35475a;border-radius:6px;background:#172330;/.test(css)
   && /font-size:13px/.test(css) && /white-space:pre-line/.test(css));
const tipRules = css.split('}').filter(function (r) { return /#page-tip/.test(r); }).join('}');
ok('calm: no accent edge, no shade, no gold anywhere in the bubble, no pinned look, the heading not coloured',
   !/border-left/.test(tipRules) && /#page-tip\{[^}]*box-shadow:none/.test(css) && !/0 8px 25px|rgba\(0,0,0,\.55\)/.test(css)
   && !/gold|eac36e/.test(tipRules) && css.indexOf('data-pinned') < 0
   && /#page-tip \.tip-h,#page-tip \.tip-li>b,#page-tip \.tip-glyph\{font-weight:600\}/.test(css) && !/\.tip-h[^{]*\{[^}]*color/.test(css));
ok('help mode: the help cursor over the whole page while it is on, over whatever an element sets itself',
   /html\[data-help-mode\],html\[data-help-mode\] \*\{cursor:help!important\}/.test(css));
const docTypes = document.listeners.map(function (l) { return l.type + (l.capture ? ':c' : '') + (l.passive ? ':p' : ''); }).sort().join(' ');
ok('listeners: the document - capture and passive - pointerdown, click, keydown, scroll; nothing for hover',
   docTypes === 'click:c:p keydown:c:p pointerdown:c:p scroll:c:p', '(' + docTypes + ')');
const winTypes = win.listeners.map(function (l) { return l.type + (l.capture ? ':c' : '') + (l.passive ? ':p' : ''); }).sort().join(' ');
ok('listeners: the window - the help mode\'s press in the capture phase, able to stop it (not passive), and its own resize and blur',
   winTypes === 'blur click:c dblclick:c mousedown:c mouseup:c pointerdown:c pointerup:c resize', '(' + winTypes + ')');
ok('listeners: none for pointerover, pointerout or pointermove anywhere', document.listeners.concat(win.listeners).every(function (l) { return !/^pointer(over|out|move)$/.test(l.type); }));
ok('no listener on any element of the page', fixture.every(function (e, i) { return e.listeners.length === ownListeners[i]; })
   && helpFixture.every(function (e, i) { return e.listeners.length === helpListeners[i]; }));

// --- The words live in data-tip ------------------------------------------------------------------------------
const w0 = rootWatch();
ok('the observer: the whole page for a title attribute only - not the elements added, not their text (el.title is taken over here)',
   !!w0 && w0.subtree && !w0.childList && w0.filter.join() === 'title');
ok('el.title reads the words back', row.title === 'DPM, HP/min. Stock 2 400.' && fit.title === 'Zoom so that the whole vehicle is on screen' && plain.title === '');
let calls = obs.calls;
fit.title = 'Fit the vehicle\n• Click: zoom to it'; flushMicro();
ok('el.title = words writes data-tip - no title attribute, and nothing reaches the observer while nothing is shown',
   fit.getAttribute('title') === null && fit.getAttribute('data-tip') === 'Fit the vehicle\n• Click: zoom to it' && obs.calls === calls);
fit.title = 'Zoom so that the whole vehicle is on screen'; flushMicro();
const made = new El('span'); made.title = 'Made by the page'; body.appendChild(made); flushMicro();
ok('an element the page makes and adds with el.title carries data-tip from the start; its adding reaches no observer',
   made.getAttribute('title') === null && made.getAttribute('data-tip') === 'Made by the page' && obs.calls === calls);
const attrd = node('span', body); attrd.setAttribute('title', 'Set as an attribute'); flushMicro();
ok('a title set as an attribute on the page is moved by the observer', attrd.getAttribute('title') === null && attrd.getAttribute('data-tip') === 'Set as an attribute'
   && obs.calls > calls);

// --- Hover: nothing ------------------------------------------------------------------------------------------
hover(rowIcon, 100, 200); advance(2000);
hover(fit, 700, 20); advance(2000);
hover(dotA, 650, 50); advance(2000);
ok('hover: nothing shows - over a figure, a button or a help dot, however long; no timer, no frame', bubble.hidden && timers.length === 0 && frames.length === 0);

// --- A click on an element that does nothing else ------------------------------------------------------------
let r = press(rowIcon, 104, 202);
ok('click: a figure shows the words of the nearest element with words (the icon\'s row), at the click',
   !bubble.hidden && bubble.textContent === 'DPM, HP/min. Stock 2 400.' && bubble.style.left === '116px' && bubble.style.top === '220px'
   && !bubble.hasAttribute('data-help'), '(' + bubble.style.left + ', ' + bubble.style.top + ')');
ok('click: nothing of the press stopped or prevented', untouched(r) && pageClicks > 0);
ok('click: the observer follows the words of the shown element only (data-tip, hidden), besides the page\'s titles',
   obs.targets.some(function (t) { return t.el === row && !t.subtree && t.filter.join() === 'data-tip,hidden'; }));
const callsBefore = obs.calls;
ttxSet(row, 'dpm', '2 520', 'better', 'DPM, HP/min. Stock 2 400 · this build 2 520.');
flushMicro();
ok('live: new words written by ttxSet while shown reach the bubble; still no title attribute', row.getAttribute('title') === null
   && row.getAttribute('data-tip') === 'DPM, HP/min. Stock 2 400 · this build 2 520.' && bubble.textContent === 'DPM, HP/min. Stock 2 400 · this build 2 520.');
ok('live: one frame requested to place it again', frames.length === 1);
ttxSet(row, 'dpm', '2 640', 'better', 'DPM, HP/min. Stock 2 400 · this build 2 640 with the rammer.');
flushMicro();
ok('live: a second write before that frame asks for no second frame', frames.length === 1 && bubble.textContent.indexOf('2 640') > 0);
flushFrames();
ok('live: placed once, then no frame asked for any more (nothing per frame)', frames.length === 0 && !bubble.hidden);
ttxSet(row, 'dpm', '2 640', 'better', 'DPM, HP/min. Stock 2 400 · this build 2 640 with the rammer.');
flushMicro();
ok('live: ttxSet with the same words writes nothing, the observer stays quiet and bounded',
   frames.length === 0 && obs.calls - callsBefore <= 2 && row.ttx.title === row.title, '(' + (obs.calls - callsBefore) + ' observer calls for 2 writes)');
press(rowValue, 130, 210);
ok('click: a second click on the same element closes its words', bubble.hidden);
press(rowValue, 130, 210);
press(plainChild, 500, 500);
ok('close: a click on a place with no words closes them, and shows nothing', bubble.hidden);
press(row2, 300, 300);
press(hp, 600, 300);
ok('click: a click on another element moves the bubble to its words; a picture of the scene (role=img) too', !bubble.hidden && bubble.textContent === 'Target HP 1 500 / 2 000');
ok('markup: a lone line that is no sentence is a heading', bubble.children.length === 1 && bubble.children[0].className === 'tip-h');
const downsBefore = canvasDowns;
r = press(canvas, 640, 360);
ok('scene: a press on the 3D canvas closes it, reaches the scene\'s own pointerdown and click unstopped and unprevented',
   bubble.hidden && canvasDowns === downsBefore + 1 && untouched(r) && sceneClicks > 0);
press(nestPlain, 50, 50);
ok('click: an element without words shows its parent\'s', !bubble.hidden && bubble.textContent === 'Outer words');
press(nestOwn, 55, 50);
ok('click: an element with words of its own shows its own', !bubble.hidden && bubble.textContent === 'Inner words');
press(blank, 10, 10);
ok('click: an empty title is no words - nothing shown', bubble.hidden);
press(row2, 300, 300);
ok('click: inside the scene\'s focusable #viewport a row with words still counts as a picture', !bubble.hidden && bubble.textContent === 'Reload, s. Stock 7.2.');
const esc = keyDown('Escape');
ok('close: Escape closes it - and is the bubble\'s alone, the page does not get it', bubble.hidden && esc._stop && pageKeys.indexOf('Escape') < 0);
keyDown('Escape');
ok('close: an Escape with nothing up is the page\'s', pageKeys.indexOf('Escape') >= 0);
press(popRow, 200, 100);
ok('click: a line inside an open popover (details, not summary) is a picture', !bubble.hidden && bubble.textContent === 'Penetration, mm. Stock 258.');
dispatch('scroll', popover, {bubbles: false});
ok('close: a scroll anywhere (captured) closes it', bubble.hidden);
press(popRow, 200, 100);
dispatch('resize', win, {bubbles: false});
ok('close: a resize closes it', bubble.hidden);
press(popRow, 200, 100);
dispatch('blur', input, {bubbles: false});
ok('close: a control losing focus does NOT close it', !bubble.hidden);
dispatch('blur', win, {bubbles: false});
ok('close: the window losing focus does', bubble.hidden);

const controls = [['a button', fit], ['a span inside a button', fitGlyph], ['a summary', summary], ['a label', lab], ['a link', link],
  ['an input', input], ['a select', select], ['role=button', roleBtn], ['an onclick property', propClick], ['tabindex=0', focusable],
  ['a pointer cursor', pointerDiv], ['data-act', actBtn], ['a button inside a titled group', nestBtn]];
const shownControls = controls.filter(function (c) {
  press(c[1], 10, 10);
  const bad = !bubble.hidden;
  win.BullbaTips.close();
  return bad;
}).map(function (c) { return c[0]; });
ok('controls: a click on none of ' + controls.length + ' kinds of control shows anything', shownControls.length === 0, shownControls.length ? '(' + shownControls.join(', ') + ')' : '');
const fitBefore = fitClicks, groupBefore = groupBtnClicks;
r = press(fit, 700, 20);
ok('controls: a button\'s click keeps its action, untouched', fitClicks === fitBefore + 1 && bubble.hidden && untouched(r));
press(nestBtn, 10, 10);
ok('controls: a button in a titled group still gets its click, and the group\'s words do not show', groupBtnClicks === groupBefore + 1 && bubble.hidden);
press(row2, 300, 300);
const fitBefore2 = fitClicks;
press(fit, 700, 20);
ok('controls: with words up a button still works, and the press closes them', fitClicks === fitBefore2 + 1 && bubble.hidden);
dispatch('click', stopper, {clientX: 10, clientY: 10, isTrusted: false});
ok('click: the page\'s own el.click() (untrusted) shows nothing', bubble.hidden);
press(stopper, 20, 20);
ok('click: seen in the capture phase even when the element\'s own listener stops the click', !bubble.hidden && bubble.textContent.indexOf('stops the click') > 0);
win.BullbaTips.close();
ok('BullbaTips.close() closes it', bubble.hidden);

// --- Words cleared, an element gone ----------------------------------------------------------------------------
press(row2, 300, 300);
row2.title = ''; flushMicro();
ok('cleared: words emptied while shown close the bubble', bubble.hidden);
row2.title = 'Reload, s. Stock 7.2.';
press(row2, 300, 300);
row2.hidden = true; flushMicro();
ok('hidden: the shown element hidden by the page closes its bubble', bubble.hidden);
row2.hidden = false; flushMicro();

// --- Placement --------------------------------------------------------------------------------------------
const long = node('span', body, {title: new Array(40).join('A long explanation. ')});
press(long, 1250, 700);
const L = parseInt(bubble.style.left, 10), T = parseInt(bubble.style.top, 10), W = bubble.offsetWidth, H = bubble.offsetHeight;
ok('place: by the bottom-right corner it flips left of and above the pointer, inside the window',
   L + W <= 1250 - 12 && T + H <= 700 - 8 && L >= 6 && T >= 6, '(' + [L, T, W, H].join(', ') + ')');
press(long, 2, 2); press(long, 2, 2);
ok('place: by the top-left corner it stays right of and below the pointer',
   parseInt(bubble.style.left, 10) === 14 && parseInt(bubble.style.top, 10) === 20);
html.clientWidth = 300;
press(long, 150, 20); press(long, 150, 20);
ok('place: a window narrower than the bubble - held at the 6 px edge', parseInt(bubble.style.left, 10) === 6, '(' + bubble.style.left + ')');
html.clientWidth = 1280;
win.BullbaTips.close();
ok('no frame requested and no timer left once everything is closed', frames.length === 0 && timers.length === 0);

// --- The markup ------------------------------------------------------------------------------------------------
ok('markup: the bubble is built from text only - no innerHTML, outerHTML or insertAdjacentHTML in tooltips.js',
   !/innerHTML|outerHTML|insertAdjacentHTML/.test(src));
const marked = node('span', body, {title: 'Real reload\nThe gun reloads in real time.\n• Left click: on or off\n• Only with ⌖ on\n\n\nA <b>tag</b> stays text: 7.2 s\n• Time left: 3.1 s'});
flushMicro();
press(marked, 100, 100);
// bubble.children[i].children[j]..., or an empty element when one is missing (a failed check, not a crash).
const at = function () { let e = bubble; for (let a = 0; a < arguments.length; a++) e = (e && e.children[arguments[a]]) || null; return e || new El('i'); };
const kinds = bubble.children.map(function (k) { return k.className; }).join(' | ');
ok('markup: eight lines, two of them empty, become six elements in order - heading, paragraph, item, item, paragraph after a gap, item',
   !bubble.hidden && kinds === 'tip-h | tip-p | tip-li | tip-li | tip-p tip-gap | tip-li', '(' + kinds + ')');
ok('markup: the heading and the paragraph carry their words', at(0).textContent === 'Real reload' && at(1).textContent === 'The gun reloads in real time.');
ok('markup: an item with a key - the key up to the first ": " in <b>, the rest after it',
   at(2).children.length === 2 && at(2, 0).tagName === 'B' && at(2, 0).textContent === 'Left click: '
   && at(2, 1).textContent === 'on or off');
ok('markup: an item without a key - its words only, the bullet drawn by the stylesheet',
   at(3).children.length === 1 && at(3, 0).tagName === 'SPAN' && at(3).textContent === 'Only with ⌖ on'
   && /\.tip-li::before\{content:"\\2022"/.test(css));
ok('markup: a "<b>" in a title is shown as text, no element made of it; a ": " in a paragraph is no key',
   at(4).children.length === 1 && at(4, 0).tagName === 'SPAN' && at(4).textContent === 'A <b>tag</b> stays text: 7.2 s');
ok('markup: the last item keyed too', at(5, 0).textContent === 'Time left: ' && at(5, 1).textContent === '3.1 s');
ok('markup: CSS - bold heading and key, a hanging bullet, a gap between groups, help groups apart by a gap alone',
   /\.tip-li\{position:relative;padding-left:13px\}/.test(css) && /div\.tip-gap\{margin-top:7px\}/.test(css)
   && /\.tip-row\+\.tip-row\{margin-top:8px\}/.test(css) && !/\.tip-row\+\.tip-row\{[^}]*border/.test(css));
marked.title = '\n  Auto-frame\r\n      • Left click: shows it\r\n   '; flushMicro();
ok('markup: written live - CRLF, indented lines (an attribute spread over source lines), blank lines at the ends: heading and item only',
   bubble.children.length === 2 && bubble.children[0].className === 'tip-h' && bubble.children[0].textContent === 'Auto-frame'
   && bubble.children[1].children[0].textContent === 'Left click: ' && bubble.children[1].children[1].textContent === 'shows it' && frames.length === 1);
flushFrames();
// Review 23.09: a lone line ending like a sentence is an old one-sentence title (a paragraph), but the first line of a
// title of several lines is its heading even when a name ends in a full stop.
marked.title = 'Gun: 100 mm armata wz. 62 P.\n• Calibre: 100 mm'; flushMicro();
ok('markup: several lines - the first is the heading even when the name ends in a full stop',
   bubble.children.length === 2 && bubble.children[0].className === 'tip-h' && bubble.children[0].textContent === 'Gun: 100 mm armata wz. 62 P.'
   && bubble.children[1].className === 'tip-li');
flushFrames();
marked.title = '  \n '; flushMicro();
ok('markup: a title of blanks only shows nothing', bubble.hidden);
ok('markup: the words kept as written, line breaks and all', marked.title === '  \n ' && marked.getAttribute('title') === null);
press(row2, 300, 300);
ok('markup: a lone sentence is a paragraph, not a heading; a plain bubble has no help look',
   !bubble.hidden && !bubble.hasAttribute('data-help') && bubble.children.length === 1 && bubble.children[0].className === 'tip-p');
win.BullbaTips.close();

// --- Help dots: where they stand -------------------------------------------------------------------------------
ok('help: CSS - one small round dot, gone when [hidden], lit while its mode is on - the same dot on a help that opens its own box (a <details> summary, gold while open); the help bubble wider',
   /button\.help-dot\.help-dot\[data-help-for\],details>summary\.help-dot\.help-dot\{[^}]*width:18px;height:18px[^}]*border-radius:50%/.test(css)
   && /button\.help-dot\.help-dot\[data-help-for\]\[hidden\],details>summary\.help-dot\.help-dot\[hidden\]\{display:none\}/.test(css)
   && /button\.help-dot\.help-dot\[data-help-for\]\[data-open\],details\[open\]>summary\.help-dot\.help-dot\{/.test(css)
   && /details>summary\.help-dot\.help-dot::after\{content:none\}/.test(css) && /#page-tip\[data-help\]\{max-width:520px/.test(css));
const hiddenWatch = function () { return obs.targets.filter(function (t) { return t.filter && t.filter.join() === 'hidden' && !t.subtree; }); };
// 12 boxes of the first dots, and since 24.09 six of the moved and remade controls' (tb-fit, tb-auto, its label, "More"
// and its popover, remade).
ok('presence: the same observer follows `hidden` of the listed elements and the boxes around them below the dot\'s own (18, each once)',
   hiddenWatch().length === 18, '(' + hiddenWatch().length + ' watched)');
ok('presence: a dot with something to explain stands, a dot whose only element is hidden is hidden', !dotA.hidden && !dotB.hidden && !dotD.hidden && dotE.hidden);
mtile.hidden = true; fun.hidden = true; flushMicro();
ok('presence: everything the model row\'s dot lists hidden - the dot goes too', dotA.hidden);
mtile.hidden = false; flushMicro();
ok('presence: ... and comes back with the tile', !dotA.hidden);
fun.hidden = false; flushMicro();
cfg.hidden = true; gpanel.hidden = true; flushMicro();
ok('presence: elements inside a hidden box count as hidden (the gun\'s shells in the hidden gun panel) - the dot goes', dotB.hidden);
gpanel.hidden = false; flushMicro();
ok('presence: ... and comes back with the box', !dotB.hidden);
cfg.hidden = false; flushMicro();

// --- Presence taken live (24.09, scene-one-path; user: "the help icons disappeared") -------------------------------
// Until 0.7.41 the boxes around each listed control were taken ONCE, at load: a control the page moved later kept the
// chain of the box it had left, and a control made anew was never looked at - the dot stood or vanished by them.
ok('presence live: the dot of two controls sitting in "More" stands at load', !dotT.hidden);
tbRow.insertBefore(tbFit, tbMore); tbRow.insertBefore(tbAutoLabel, tbMore); tbMore.hidden = true; flushMicro();
ok('presence live: the row widens - the controls back in the row and "More" hidden: the dot stands (until 0.7.41 it went for good, "More" was one of its boxes)',
   !dotT.hidden);
tbFit.hidden = true; tbAuto.hidden = true; flushMicro();
ok('presence live: ... and the observer follows the boxes they are in NOW - both hidden, the dot goes', dotT.hidden);
tbFit.hidden = false; flushMicro();
ok('presence live: ... one back, the dot back', !dotT.hidden);
tbAuto.hidden = false; flushMicro();
remade.remove(); const remade2 = node('button', body, {id: 'remade', hidden: ''}); flushMicro();
win.BullbaTips.refresh(); flushMicro();
ok('presence live: a control made anew under the same id is the one looked at - hidden, its dot goes (the scene finisher’s refresh)', dotR.hidden);
remade2.hidden = false; flushMicro();
ok('presence live: ... and the observer watches the new one - shown, the dot back with no refresh', !dotR.hidden);
const late2 = node('button', body, {'class': 'help-dot', 'data-help-for': 'lonely', 'aria-label': 'Help'}); late2.textContent = '?';
win.BullbaTips.refresh(); flushMicro();
ok('presence live: a dot the page adds later is taken by the next refresh() - all it lists hidden, it is hidden', late2.hidden);
late2.remove(); win.BullbaTips.refresh(); flushMicro();
// The help mode belongs to its dot: when all the lit dot explains leaves the screen, the mode goes with it.
press(dotA, 640, 40);
const litBefore = html.hasAttribute('data-help-mode') && dotA.hasAttribute('data-open') && !bubble.hidden;
mtile.hidden = true; fun.hidden = true; flushMicro();
ok('presence live: the lit dot whose cluster leaves the screen hides and ends its help mode, bubble and all',
   litBefore && dotA.hidden && !html.hasAttribute('data-help-mode') && !dotA.hasAttribute('data-open') && bubble.hidden);
mtile.hidden = false; fun.hidden = false; flushMicro();
ok('presence live: ... and stands again with the cluster, the mode still off', !dotA.hidden && !html.hasAttribute('data-help-mode'));

// --- The help mode -------------------------------------------------------------------------------------------------
const modeOn = function () { return html.hasAttribute('data-help-mode'); };
// A help group: its glyph leads its first line (b.tip-glyph); part 0 - the glyph's text, part 1 - all the words after it.
const glyphEl = function (i) { const g = bubble.children[i], l = g && g.children[0], b = l && l.children[0]; return b && b.className === 'tip-glyph' ? b : null; };
const rowA = function (i, part) {
  const g = bubble.children[i], m = glyphEl(i);
  if (!g) return null;
  return part === 0 ? (m ? m.textContent : '') : g.textContent.slice(m ? m.textContent.length : 0);
};
r = press(dotA, 652, 52);
ok('help mode: a dot\'s click shows its cluster - the hidden ◔ and ↺, a missing id and a repeat left out - lights the dot and turns the mode on (the help cursor)',
   !bubble.hidden && bubble.hasAttribute('data-help') && bubble.children.length === 2 && dotA.hasAttribute('data-open') && modeOn()
   && bubble.style.left === '664px' && bubble.style.top === '70px', '(' + bubble.children.length + ' rows, ' + bubble.style.left + ', ' + bubble.style.top + ')');
ok('help rows: the tile by its caption, the drawn ⌖ by the symbol it stands for (data-glyph, not its long name), each with its own words',
   rowA(0, 0) === 'Collision model' && rowA(0, 1) === 'The collision model on screen · click to pick it'
   && rowA(1, 0) === '⌖' && rowA(1, 1) === 'Target HP, RNG shots and Hitmarks.' && bubble.children[0].className === 'tip-row'
   && fun.textContent === '' && fun.children[0].tagName === 'SVG');
ok('help mode: the observer follows what the dot lists, with their items (words and hidden)',
   obs.targets.some(function (t) { return t.el === fun && t.subtree && t.filter.join() === 'data-tip,hidden'; }));
fun.title = 'Target HP, RNG shots and Hitmarks. Now with a live figure.'; flushMicro();
ok('help live: a listed element\'s words written meanwhile reach its row, one frame asked to place it again',
   String(rowA(1, 1)).indexOf('live figure') > 0 && frames.length === 1);
flushFrames();
rr.hidden = false; flushMicro();
ok('help live: a listed element shown meanwhile gets its row (◔)', bubble.children.length === 3 && rowA(2, 0) === '◔' && !dotA.hidden);
flushFrames();
// A button: its words, and nothing else sees the press.
let fitB = fitClicks, pageB = pageClicks, sceneB = sceneClicks, downsB = canvasDowns;
r = press(fit, 700, 20);
ok('help mode: a press on a button shows its words at the press - and the button does not act',
   !bubble.hidden && bubble.textContent === 'Zoom so that the whole vehicle is on screen' && !bubble.hasAttribute('data-help') && fitClicks === fitB
   && bubble.style.left === '712px' && bubble.style.top === '38px' && modeOn() && dotA.hasAttribute('data-open'));
ok('help mode: the press, its mouse twin, the release, its twin and the click - all stopped in the window\'s capture phase with their defaults prevented; the page\'s own click listener gets nothing',
   taken(r) && pageClicks === pageB);
r = press(shAP, 30, 600);
ok('help mode: a shell chip (a button with an icon) - its words, no shell chosen', !bubble.hidden && bubble.textContent === 'AP · 390 mm · 750 HP' && shellClicks === 0 && taken(r));
r = press(cfgSum, 60, 600);
ok('help mode: a <summary> - its words, and its click prevented, so its <details> does not toggle', !bubble.hidden && bubble.textContent === 'This shooter’s equipment and perks' && taken(r));
r = press(hp, 600, 300);
ok('help mode: a picture of the scene - its words, and the scene gets neither the press nor the click', !bubble.hidden && bubble.textContent === 'Target HP 1 500 / 2 000'
   && canvasDowns === downsB && sceneClicks === sceneB && taken(r));
r = press(hp, 600, 300);
ok('help mode: the same element again closes its words; the mode stays', bubble.hidden && modeOn() && dotA.hasAttribute('data-open') && taken(r));
const wKey = keyDown('w');
ok('help mode: keys are the page\'s - WASD reaches it', pageKeys.indexOf('w') >= 0 && !wKey._stop && modeOn());
fitB = fitClicks;
const keyClick = dispatch('click', fit, {clientX: 0, clientY: 0, detail: 0});
ok('help mode: a click from the keyboard (Enter on a focused button, no press before it) is the page\'s too - the button acts, the mode stays',
   fitClicks === fitB + 1 && !keyClick._stop && modeOn());
press(fit, 700, 20); press(fit, 700, 20);
const dbl = dispatch('dblclick', fit, {clientX: 700, clientY: 20});
ok('help mode: a double-click after its presses is taken too (a preset is not renamed by it)', dbl._stop && dbl.defaultPrevented);
// Another dot moves the mode.
r = press(dotB, 700, 300);
ok('help mode: another dot moves the mode to its cluster - its rows, it lit, the first one not',
   !bubble.hidden && bubble.children.length === 4 && dotB.hasAttribute('data-open') && !dotA.hasAttribute('data-open') && modeOn() && taken(r));
ok('help group: each item with words of a group without its own gets a row, its icon drawn as the glyph, the hidden shell left out',
   glyphEl(0) && glyphEl(0).children[0] && glyphEl(0).children[0].tagName === 'IMG'
   && glyphEl(0).children[0].getAttribute('src') === 'web/icons/shell0.png' && rowA(0, 1) === 'AP · 390 mm · 750 HP' && rowA(1, 1) === 'HE · 105 mm');
ok('help group: the mode button by its symbol; a closed <details> by its summary, the popover inside left out',
   rowA(2, 0) === '◧' && rowA(3, 0) === 'Config' && rowA(3, 1) === 'This shooter’s equipment and perks');
shHE.title = 'HE · 105 mm · now 910 HP'; flushMicro();
ok('help live: an item of a listed group retitled meanwhile reaches its row', rowA(1, 1) === 'HE · 105 mm · now 910 HP');
flushFrames();
// The three ways out.
r = press(dotB, 700, 300);
ok('help mode ends - the same dot again: the bubble closes, the dot goes out, the help cursor too', bubble.hidden && !modeOn() && !dotB.hasAttribute('data-open') && taken(r));
press(dotA, 652, 52);
const escOut = keyDown('Escape');
ok('help mode ends - Escape (the page does not get that Escape)', bubble.hidden && !modeOn() && !dotA.hasAttribute('data-open') && escOut._stop);
press(dotA, 652, 52); press(row2, 300, 300);
downsB = canvasDowns; sceneB = sceneClicks; pageB = pageClicks;
r = press(canvas, 640, 360);
ok('help mode ends - a press on a place with no words (the 3D scene): the bubble goes, and the scene gets neither that press, nor its release, nor its click',
   bubble.hidden && !modeOn() && !dotA.hasAttribute('data-open') && taken(r) && canvasDowns === downsB && sceneClicks === sceneB && pageClicks === pageB);
r = press(canvas, 640, 360);
ok('help mode over: the next press on the scene is the scene\'s again', canvasDowns === downsB + 1 && untouched(r));
const dbl2 = dispatch('dblclick', canvas, {clientX: 640, clientY: 360});
ok('help mode over: a double-click is the page\'s again', !dbl2._stop && !dbl2.defaultPrevented);
fitB = fitClicks;
press(fit, 700, 20);
ok('help mode over: a button acts again and shows nothing', fitClicks === fitB + 1 && bubble.hidden);
// The keyboard, a dot with nothing to show, a dot the page adds later, a dot in a titled group, a labelled checkbox.
dispatch('click', dotA, {clientX: 0, clientY: 0, detail: 0});
ok('help keyboard: a dot clicked with no pointer position (Enter) turns the mode on, its bubble by the dot', !bubble.hidden && modeOn() && bubble.style.left === '652px'
   && bubble.style.top === '58px', '(' + bubble.style.left + ', ' + bubble.style.top + ')');
dispatch('click', dotA, {clientX: 0, clientY: 0, detail: 0});
ok('help keyboard: ... and off again', bubble.hidden && !modeOn());
press(dotE, 210, 310);
ok('help: a dot with nothing on screen to explain shows nothing and turns no mode on', bubble.hidden && !modeOn() && !dotE.hasAttribute('data-open'));
press(dotC, 100, 600);
ok('help around: a checkbox with no words of its own takes its label\'s, the label\'s caption as the glyph; two inputs of one label - one row',
   bubble.children.length === 1 && rowA(0, 0) === 'Auto-frame' && rowA(0, 1) === 'Hold the on-screen size of the vehicle' && modeOn());
r = press(dotD, 300, 100);
ok('help in a titled group: the dot shows its rows, not the group\'s words, and moves the mode',
   !bubble.hidden && bubble.hasAttribute('data-help') && bubble.children.length === 1 && rowA(0, 0) === 'Shell type' && dotD.hasAttribute('data-open') && !dotC.hasAttribute('data-open'));
win.BullbaTips.close();
ok('BullbaTips.close() ends the mode too', bubble.hidden && !modeOn() && !dotD.hasAttribute('data-open'));
const dotLate = node('button', body, {'class': 'help-dot', 'data-help-for': 'types gun-mech', 'aria-label': 'Help'}); dotLate.textContent = '?';
flushMicro();
press(dotLate, 300, 400);
ok('help: a dot the page adds later works the same', !bubble.hidden && bubble.children.length === 2 && rowA(0, 0) === 'Shell type' && rowA(1, 0) === '◧'
   && dotLate.hasAttribute('data-open') && modeOn());
win.BullbaTips.close();

// Help groups from multi-line titles: glyph + heading, then the items.
const mlRow = node('div', body);
const mlTile = node('button', mlRow, {id: 'ml-tile', title: 'Collision model\n• Left click: pick another model'});
node('span', mlTile).textContent = 'Collision model'; node('span', mlTile).textContent = 'IS-7';
node('button', mlRow, {id: 'ml-fun', 'data-glyph': '⌖', title: 'Target HP and RNG shots\n• Left click: on or off\n\n• Only with ⌖: the strip'});
node('button', mlRow, {id: 'ml-list', title: '• Left click: sort\n• Arrows: the order'}).textContent = '⇅';
node('button', mlRow, {id: 'ml-old', title: 'Siege mode: off. Switch 3 s.'}).textContent = '◧';
const dotML = node('button', mlRow, {'class': 'help-dot', 'data-help-for': 'ml-tile ml-fun ml-list ml-old'}); dotML.textContent = '?';
flushMicro();
press(dotML, 300, 400);
const lineKinds = function (i) { const g = bubble.children[i]; return g ? g.children.map(function (l) { return l.className; }).join(' | ') : ''; };
ok('help markup: one group per listed element', !bubble.hidden && bubble.hasAttribute('data-help') && bubble.children.length === 4
   && bubble.children.every(function (g) { return g.className === 'tip-row'; }), '(' + bubble.children.length + ' groups)');
ok('help markup: a heading that only repeats the glyph caption is left out - the glyph alone heads the group, no items (the gist, user 23.09)',
   lineKinds(0) === 'tip-h' && rowA(0, 0) === 'Collision model' && at(0, 0).children.length === 1, '(' + lineKinds(0) + ')');
ok('help markup: the glyph leads the heading of its title; its items are left for its own tooltip (the gist)',
   lineKinds(1) === 'tip-h' && rowA(1, 0) === '⌖' && at(1, 0, 1).textContent === 'Target HP and RNG shots', '(' + lineKinds(1) + ')');
ok('help markup: a title that starts with an item - its first item is its gist, the glyph on a line of its own above it',
   lineKinds(2) === 'tip-h | tip-li' && rowA(2, 0) === '⇅' && at(2, 0).children.length === 1, '(' + lineKinds(2) + ')');
ok('help markup: a lone sentence - the glyph leads it as a paragraph',
   lineKinds(3) === 'tip-p' && rowA(3, 0) === '◧' && rowA(3, 1) === 'Siege mode: off. Switch 3 s.', '(' + lineKinds(3) + ')');
press(dotML, 300, 400);
ok('help: closed - the observer back to the page\'s titles and the dots\' boxes, no frame, no timer, no pointer listener',
   bubble.hidden && !modeOn() && obs.targets.every(function (t) { return t.el === html || (t.filter && t.filter.join() === 'hidden'); })
   && frames.length === 0 && timers.length === 0 && document.listeners.concat(win.listeners).every(function (l) { return l.type !== 'pointermove'; }));

// --- The second run: el.title fixed ------------------------------------------------------------------------------
const child = cp.spawnSync(process.execPath, [__filename], {env: Object.assign({}, process.env, {BULLBA_TIPS_FALLBACK: '1'}), encoding: 'utf8'});
const lines = String(child.stdout || '').split('\n').filter(function (l) { return /^(ok {3}|FAIL )tooltips/.test(l); });
lines.forEach(function (l) { console.log(l); if (/^ok/.test(l)) passed++; else failures++; });
ok('fallback: the second run (el.title not taken over) ran to its end', child.status === 0 && lines.length >= 6, '(' + lines.length + ' checks, status ' + child.status + ')');

console.log('\n' + passed + ' ok, ' + (failures ? failures + ' FAILURES' : 'all passed'));
process.exitCode = failures ? 1 : 0;
