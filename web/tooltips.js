// ONE tooltip for the whole page, drawn by the page itself (23.09).
// The game's embedded browser (CEF) never shows the native `title` tooltip, and neither the right button nor
// Ctrl/Alt + click reach the page there (the original Armor Inspector behaves the same), so every word the page
// keeps in a `title` stayed unread in the game. The words stay where they are - in the `title` attributes the
// page writes - and this file draws them:
// - hover: ~350 ms over an element with a title (the nearest ancestor that has one) shows it in a bubble by the
//   pointer, kept inside the window; moving on to the next titled element while one is up shows it at once;
// - a left click (a tap) on an element that does nothing else pins the bubble open; a click elsewhere, Escape,
//   a scroll or a resize closes it; a click on a control keeps its action and the bubble only follows hover;
// - a help dot (<button class="help-dot" data-help-for="id id ...">?</button>, 23.09) is the pin a control
//   cannot have: its click IS the pin (a second click, Escape or a click elsewhere closes it), and its bubble
//   gathers the words of the elements it lists - one group each, led by the element's glyph and the heading of
//   what hovering it shows, the ones not on screen left out. A dot is hidden while every element it lists is hidden;
// - the words are one plain-text markup for every title (23.09), readable as is in a native tooltip and drawn
//   here with createElement/textContent only - a title is data (a record's names), never HTML:
//     lines split by '\n'; the first line is the heading, drawn bold (unless it is a sentence: ends in . ! ?);
//     '• Key: text' is an item, its key up to the first ': ' bold; '• text' an item without a key;
//     an empty line starts a new group (a gap); any other line is a paragraph;
// - while an element is hovered or pinned its title waits in data-tip, so a normal browser never draws its own
//   tooltip over this one; a title the page writes meanwhile (the characteristics panel updates live) is moved
//   again by a MutationObserver on that element alone, and the bubble takes the new words - for a help dot the
//   observer watches the elements it lists, only while the dot is hovered or pinned.
// Listeners on the document only (capture, passive - nothing is ever stopped or prevented), none per element,
// nothing per frame (pointermove is listened to only during the 350 ms wait, to show the bubble where the
// pointer rests); layout is read only when a bubble opens or its words change. The bubble takes no pointer
// events, so the 3D scene under it keeps every drag, wheel and click. ES5, like the rest of the page.
(function () {
  'use strict';
  var win = window, doc = document;
  if (win.BullbaTips || !doc || !doc.addEventListener) return;

  var DELAY = 350;          // ms of hover before the bubble shows
  var WARM = 300;           // ms after a hover bubble closed during which the next one opens at once
  var GAP_X = 12, GAP_Y = 18, ABOVE = 8, EDGE = 6;
  var HELP = 'data-help-for';
  // The page's dark panel: the popover background, the tiles' border, 13 px text, a gold edge - all gold when pinned.
  // The markup: a bright bold heading, items hanging off a grey bullet with a bold key, a gap between groups.
  // A help bubble is wider (it gathers several tooltips), each group led by its element's glyph in gold and
  // parted from the one before by a faint line.
  // The help dot: one small round "?" wherever it stands, one look above whatever the row around it gives a
  // button (hence the doubled class); a lighter edge on hover, gold while its bubble is pinned.
  var DOT = 'button.help-dot.help-dot[data-help-for]';
  // A help that opens a box of its own (the vehicle list's <details>, its summary .help-dot) wears the same dot, gold
  // while open: one look for every "?" of the page (review 23.09; the gold and grey ⓘ marks are gone).
  var BOX = 'details>summary.help-dot.help-dot';
  function dotCss(suffix) { return DOT + suffix + ',' + BOX + suffix; }
  var CSS = '#page-tip{position:fixed;left:0;top:0;z-index:10000;box-sizing:border-box;max-width:360px;'
    + 'max-width:min(360px,calc(100vw - 12px));padding:6px 10px 7px;border:1px solid rgba(157,174,191,.55);'
    + 'border-left:2px solid var(--gold,#eac36e);border-radius:6px;background:#15212e;color:#e5edf5;font-size:13px;'
    + 'font-weight:400;font-style:normal;line-height:1.4;letter-spacing:normal;text-align:left;text-transform:none;'
    + 'text-shadow:none;white-space:pre-line;overflow-wrap:break-word;word-wrap:break-word;'
    + 'box-shadow:0 8px 25px rgba(0,0,0,.55);pointer-events:none;-webkit-user-select:none;user-select:none}'
    + '#page-tip[hidden]{display:none}#page-tip[data-pinned]{border-color:var(--gold,#eac36e)}'
    + '#page-tip[data-help]{max-width:520px;max-width:min(520px,calc(100vw - 12px))}'
    + '#page-tip .tip-h,#page-tip .tip-li>b{color:#f4f8fb;font-weight:600}'
    + '#page-tip .tip-li{position:relative;padding-left:13px}'
    + '#page-tip .tip-li::before{content:"\\2022";position:absolute;left:2px;top:0;color:#96a9bd}'
    + '#page-tip .tip-h+div{margin-top:3px}#page-tip div.tip-gap{margin-top:7px}'
    + '#page-tip .tip-row+.tip-row{margin-top:7px;padding-top:6px;border-top:1px solid rgba(157,174,191,.22)}'
    + '#page-tip .tip-glyph{margin-right:7px;color:var(--gold,#eac36e);font-weight:600}'
    + '#page-tip .tip-glyph img{height:18px;width:auto;vertical-align:-4px}'
    + dotCss('') + '{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;'
    + 'align-self:center;box-sizing:border-box;width:18px;height:18px;min-width:0;min-height:0;margin:0;padding:0;'
    + 'border:1px solid rgba(157,174,191,.55);border-radius:50%;background:rgba(23,35,48,.35);color:#96a9bd;'
    + 'font-family:inherit;font-size:11px;font-weight:700;font-style:normal;line-height:1;letter-spacing:0;'
    + 'text-transform:none;text-shadow:none;box-shadow:none;vertical-align:middle;cursor:help}'
    + dotCss(':hover') + '{border-color:#c9d3dd;color:#e5edf5;background:rgba(38,55,73,.45)}'
    + DOT + '[data-open],details[open]>summary.help-dot.help-dot{border-color:var(--gold,#eac36e);color:var(--gold,#eac36e);background:#302b23}'
    + dotCss(':focus-visible') + '{outline:2px solid var(--gold,#eac36e);outline-offset:2px}'
    + dotCss('[hidden]') + '{display:none}' + BOX + '::after{content:none}';
  // What a click already means something on: the bubble then follows hover only and the click keeps its action.
  var ACTIVE_TAGS = {A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, LABEL: 1, OPTION: 1, AUDIO: 1, VIDEO: 1};
  var ACTIVE_ROLES = /^(button|link|checkbox|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|textbox|searchbox|combobox|treeitem)$/;
  var LISTEN = {capture: true, passive: true};
  var WATCH = {attributes: true, attributeFilter: ['title']};
  // What a help dot lists: the words of the element and of its items, and whether they are on screen.
  var WATCH_LISTED = {attributes: true, attributeFilter: ['title', 'hidden'], subtree: true};
  var WATCH_HIDDEN = {attributes: true, attributeFilter: ['hidden']};

  var bubble = null, style = null;
  var shownEl = null, shownKey = '', pinned = false, anchorX = 0, anchorY = 0, placeQueued = false;
  var hoverEl = null, pinEl = null, timer = 0, warmUntil = 0, px = 0, py = 0, tracking = false;
  var observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(retitled) : null;
  var dots = [];

  function now() { return Date.now(); }

  // --- The words: a title waits in data-tip while its element is hovered or pinned -------------------------
  // A help dot keeps its own empty title (see adopt(); one the page adds later gets it here) and parks nothing.
  function take(el) {
    var t = el.getAttribute('title');
    if (isHelp(el)) { if (t === null) el.setAttribute('title', ''); return; }
    if (t === null) return;
    el.setAttribute('data-tip', t);
    el.removeAttribute('title');
  }
  // Back to `title` once the element is neither hovered nor pinned. A title the page has written since wins.
  function release(el) {
    if (!el || el === hoverEl || el === pinEl) return;
    var t = el.getAttribute('data-tip');
    if (t === null) return;
    el.removeAttribute('data-tip');
    if (t !== '' && el.getAttribute('title') === null) el.setAttribute('title', t);
  }
  function tipOf(el) {
    var t = el.getAttribute('data-tip');
    return t === null ? (el.getAttribute('title') || '') : t;
  }
  function hasWords(el) { return el.nodeType === 1 && (!!el.getAttribute('title') || el.hasAttribute('data-tip')); }
  function isHelp(el) { return el.nodeType === 1 && el.hasAttribute(HELP); }
  // The element whose words apply: the nearest one up from the pointer's target that has a title, or a help dot.
  function holderOf(node) {
    for (var el = node; el && el !== doc; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      if (el === hoverEl || el === pinEl || isHelp(el) || hasWords(el)) return el;
    }
    return null;
  }
  // A control, or inside one: a native control or its label anywhere up the chain, a control role, a click
  // handler set as a property or an attribute; between the target and the titled element also a focusable
  // element, and a pointer cursor on the target (the stylesheet marks what is pressable with it). The scene
  // (#viewport, focusable) is above the tiles in it, so a titled tile of the scene still counts as a picture.
  function interactive(target, holder) {
    var inside = true;
    for (var el = target; el && el.nodeType === 1; el = el.parentNode) {
      if (ACTIVE_TAGS[String(el.tagName).toUpperCase()] === 1) return true;
      var role = el.getAttribute('role');
      if (role && ACTIVE_ROLES.test(role)) return true;
      if (typeof el.onclick === 'function' || el.hasAttribute('onclick') || el.hasAttribute('data-act') || el.isContentEditable === true) return true;
      if (inside && el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
      if (el === holder) inside = false;
    }
    try { return win.getComputedStyle(target).cursor === 'pointer'; } catch (e) { return false; }
  }
  // A click there pins the bubble: a picture, or a help dot - pinning is the one thing its click does.
  function pinnable(target, holder) { return isHelp(holder) || !interactive(target, holder); }
  function within(box, node) {
    for (var el = node; el; el = el.parentNode) if (el === box) return true;
    return false;
  }

  // --- A help dot: the rows it gathers ---------------------------------------------------------------------
  function listed(dot) {
    var ids = String(dot.getAttribute(HELP) || '').split(/\s+/), out = [];
    for (var i = 0; i < ids.length; i++) {
      var el = ids[i] ? doc.getElementById(ids[i]) : null;
      if (el && out.indexOf(el) < 0) out.push(el);
    }
    return out;
  }
  // Laid out at all: not hidden, not display:none, not in a closed <details> (the toolbar's “More”).
  function onScreen(el) {
    if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) if (e.hidden) return false;
    return true;
  }
  function textOf(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  // The glyph a row starts with, as the element shows itself: its symbol (⇅, ◔), the symbol a drawn icon stands for
  // (data-glyph: the ⌖ switch is an SVG crosshair, 23.09), its accessible name, its first part's caption (the tile's
  // “Collision model”, not the vehicle after it), a short caption (Fit, ● AP 258) or its icon (a shell of the gun panel).
  function glyphOf(el) {
    var t = textOf(el), a = el.getAttribute('aria-label'), img = el.querySelector ? el.querySelector('img') : null;
    var g = el.getAttribute('data-glyph');
    if (g) return g;
    if (t && t.length <= 3 && !img) return t;
    if (a) return a;
    var f = textOf(el.firstElementChild);
    if (f && f.length <= 24) return f;
    if (t && t.length <= 24 && !img) return t;
    return img && img.getAttribute('src') ? img : '';
  }
  // One row (a group) per element the dot lists that is on screen: the words hovering it shows - its own title; for a
  // group without one, the titles of its items (the gun's shells, the shell chips); for an element inside a
  // titled one (the checkbox of a labelled switch), that one's. Each title once.
  function helpRows(dot) {
    var els = listed(dot), rows = [], seen = [];
    function add(el, holder) {
      if (seen.indexOf(holder) >= 0) return;
      seen.push(holder);
      var text = tipOf(holder);
      if (/\S/.test(text)) rows.push({glyph: glyphOf(el) || (holder !== el ? glyphOf(holder) : ''), text: text});
    }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!onScreen(el)) continue;
      if (hasWords(el)) { add(el, el); continue; }
      var kids = el.children || [], items = 0;
      for (var k = 0; k < kids.length; k++) if (hasWords(kids[k]) && onScreen(kids[k])) { add(kids[k], kids[k]); items++; }
      if (items) continue;
      for (var up = el.parentNode; up && up.nodeType === 1; up = up.parentNode) if (hasWords(up)) { add(el, up); break; }
    }
    return rows;
  }
  function rowsKey(rows) {
    var parts = [];
    for (var i = 0; i < rows.length; i++) {
      var g = rows[i].glyph;
      parts.push((typeof g === 'string' ? g : 'img ' + g.getAttribute('src')) + '\u0001' + rows[i].text);
    }
    return parts.join('\u0002');
  }
  // A help dot stands only while something it explains does: while every element it lists is hidden (the
  // model row with no model on screen), so is the dot. An element counts as hidden when it or a box around it
  // below the one it shares with the dot carries `hidden` (the gun's shells inside the hidden gun panel); a
  // box around both hides the dot with them anyway. The dots of the page are taken once, at start, and one
  // observer follows the page's own `hidden` writes on those few boxes - no layout is read for it. The dot's
  // empty title keeps a normal browser from showing the title of a group around it (the shell types).
  function adopt() {
    var found = doc.querySelectorAll ? doc.querySelectorAll('[' + HELP + ']') : [];
    for (var i = 0; i < found.length; i++) {
      var dot = found[i], els = listed(dot), chains = [];
      if (dot.getAttribute('title') === null) dot.setAttribute('title', '');
      for (var k = 0; k < els.length; k++) {
        var chain = [];
        for (var el = els[k]; el && el.nodeType === 1 && !within(el, dot); el = el.parentNode) chain.push(el);
        chains.push(chain);
      }
      dots.push({dot: dot, chains: chains});
    }
    if (!dots.length || typeof win.MutationObserver !== 'function') return;
    var follow = new win.MutationObserver(present), seen = [];
    for (var d = 0; d < dots.length; d++) {
      for (var c = 0; c < dots[d].chains.length; c++) {
        for (var b = 0; b < dots[d].chains[c].length; b++) {
          var box = dots[d].chains[c][b];
          if (seen.indexOf(box) < 0) { seen.push(box); follow.observe(box, WATCH_HIDDEN); }
        }
      }
    }
    present();
  }
  function present() {
    for (var i = 0; i < dots.length; i++) {
      var on = false, chains = dots[i].chains;
      for (var c = 0; c < chains.length && !on; c++) {
        on = true;
        for (var b = 0; b < chains[c].length && on; b++) on = !chains[c][b].hidden;
      }
      if (dots[i].dot.hidden === on) dots[i].dot.hidden = !on;
    }
  }

  // --- A title the page writes while its element is hovered or pinned --------------------------------------
  // For a help dot hovered or pinned, the elements it lists as well (added last, so a listed element that is
  // also the one hovered keeps the wider watch).
  function watch() {
    if (!observer) return;
    retitled(observer.takeRecords());
    observer.disconnect();
    if (hoverEl) observer.observe(hoverEl, WATCH);
    if (pinEl && pinEl !== hoverEl) observer.observe(pinEl, WATCH);
    var dot = pinEl && isHelp(pinEl) ? pinEl : hoverEl && isHelp(hoverEl) ? hoverEl : null;
    if (dot) for (var els = listed(dot), i = 0; i < els.length; i++) observer.observe(els[i], WATCH_LISTED);
  }
  function retitled(records) {
    var help = !!shownEl && isHelp(shownEl), again = false;
    for (var i = 0; i < records.length; i++) {
      var el = records[i].target;
      if ((el === hoverEl || el === pinEl) && el.getAttribute('title') !== null) take(el);
      if (el === shownEl || help) again = true;
    }
    if (again && shownEl) refresh();
  }

  // --- The bubble -----------------------------------------------------------------------------------------
  function build() {
    style = doc.createElement('style');
    style.id = 'page-tip-style';
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    bubble = doc.createElement('div');
    bubble.id = 'page-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    (doc.body || doc.documentElement).appendChild(bubble);
  }
  // --- The markup: lines of a title, then their elements ----------------------------------------------------
  // Each non-empty line: {kind: 'h' heading | 'li' item | 'p' paragraph, key, text, gap - an empty line before it}.
  var BULLET = /^\u2022\s*/, SENTENCE = /[.!?]$/, TRIM = /^\s+|\s+$/g;
  // The first line is the heading; a lone line that ends like a sentence is an old one-sentence title, drawn plain.
  // A title of several lines keeps its heading even when a name ends in a full stop ("… wz. 62 P.").
  function parse(text) {
    var src = String(text).split('\n'), out = [], gap = false, lines = 0;
    for (var n = 0; n < src.length && lines < 2; n++) if (src[n].replace(TRIM, '')) lines++;
    for (var i = 0; i < src.length; i++) {
      var s = src[i].replace(TRIM, ''), line;
      if (!s) { gap = out.length > 0; continue; }
      if (BULLET.test(s)) {
        s = s.replace(BULLET, '');
        var at = s.indexOf(': ');
        line = at > 0 ? {kind: 'li', key: s.slice(0, at + 1) + ' ', text: s.slice(at + 2).replace(TRIM, '')} : {kind: 'li', key: '', text: s};
      } else line = {kind: !out.length && (lines > 1 || !SENTENCE.test(s)) ? 'h' : 'p', key: '', text: s};
      line.gap = gap; gap = false;
      out.push(line);
    }
    return out;
  }
  function lineOf(l, mark) {
    var div = doc.createElement('div');
    div.className = 'tip-' + l.kind + (l.gap ? ' tip-gap' : '');
    if (mark) div.appendChild(mark);
    if (l.key) { var k = doc.createElement('b'); k.textContent = l.key; div.appendChild(k); }
    if (l.text) { var s = doc.createElement('span'); s.textContent = l.text; div.appendChild(s); }
    return div;
  }
  function squash(s) { return String(s).replace(/\s+/g, ' ').replace(TRIM, '').toLowerCase(); }
  // A title's lines into a box. In a help group the glyph leads the first line - the heading (left out when it only
  // repeats the glyph's caption: Auto-frame) or a lone sentence; before an item it stands on a line of its own.
  function draw(box, text, glyph) {
    var list = parse(text), from = 0;
    if (glyph) {
      var mark = doc.createElement('b'), l0 = list[0], head = {kind: 'h', key: '', text: ''};
      mark.className = 'tip-glyph';
      if (typeof glyph === 'string') mark.textContent = glyph; else mark.appendChild(glyph.cloneNode(false));
      if (l0 && l0.kind !== 'li') {
        from = 1;
        if (!(l0.kind === 'h' && typeof glyph === 'string' && squash(glyph) === squash(l0.text))) head = l0;
      }
      box.appendChild(lineOf(head, mark));
    }
    for (var i = from; i < list.length; i++) box.appendChild(lineOf(list[i]));
  }
  // The bubble's words: the element's title, or the groups a help dot gathers. 0 - nothing to show, 1 - the
  // bubble already shows exactly this, 2 - written.
  function paint(el) {
    var rows = isHelp(el) ? helpRows(el) : null, key = rows ? rowsKey(rows) : tipOf(el);
    if (!/\S/.test(key)) return 0;
    if (key === shownKey) return 1;
    shownKey = key;
    bubble.textContent = '';
    if (!rows) {
      if (bubble.hasAttribute('data-help')) bubble.removeAttribute('data-help');
      draw(bubble, key, '');
      return 2;
    }
    bubble.setAttribute('data-help', '');
    for (var i = 0; i < rows.length; i++) {
      var row = doc.createElement('div');
      row.className = 'tip-row';
      draw(row, rows[i].text, rows[i].glyph);
      bubble.appendChild(row);
    }
    return 2;
  }
  function show(el, x, y, pin) {
    cancel();
    shownKey = '';
    if (!paint(el)) { hide(); return false; }
    shownEl = el; pinned = !!pin; anchorX = x; anchorY = y;
    if (pinned) bubble.setAttribute('data-pinned', ''); else bubble.removeAttribute('data-pinned');
    place();
    return true;
  }
  // Below and right of the pointer; to its left when the right edge is near, above it when the bottom is.
  function place() {
    var root = doc.documentElement;
    var vw = root.clientWidth || win.innerWidth || 0, vh = root.clientHeight || win.innerHeight || 0;
    bubble.style.left = '0px'; bubble.style.top = '0px';
    bubble.hidden = false;
    var w = bubble.offsetWidth, h = bubble.offsetHeight;
    var left = anchorX + GAP_X, top = anchorY + GAP_Y;
    if (left + w > vw - EDGE) left = anchorX - GAP_X - w;
    if (top + h > vh - EDGE) top = anchorY - ABOVE - h;
    left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
    top = Math.max(EDGE, Math.min(top, vh - EDGE - h));
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }
  // New words for the bubble that is up: written at once, placed again once on the next frame however many
  // times the page rewrote them meanwhile.
  function refresh() {
    var done = paint(shownEl);
    if (!done) { if (shownEl === pinEl) unpin(); else hide(); return; }
    if (done === 1 || placeQueued) return;
    placeQueued = true;
    (win.requestAnimationFrame || function (fn) { return win.setTimeout(fn, 16); })(function () {
      placeQueued = false;
      if (shownEl) place();
    });
  }
  function hide() {
    cancel();
    var was = shownEl;
    shownEl = null; pinned = false;
    if (was) { bubble.hidden = true; bubble.removeAttribute('data-pinned'); }
    return was;
  }
  function cancel() {
    if (timer) { win.clearTimeout(timer); timer = 0; }
    track(false);
  }
  // Where the pointer rests while the bubble is waiting to open - listened to only for those 350 ms.
  function track(on) {
    if (on === tracking) return;
    tracking = on;
    if (on) doc.addEventListener('pointermove', moved, LISTEN); else doc.removeEventListener('pointermove', moved, LISTEN);
  }
  function moved(e) { px = e.clientX; py = e.clientY; }
  function unpin() {
    var el = pinEl;
    if (!el) return;
    pinEl = null;
    if (el.hasAttribute('data-open')) el.removeAttribute('data-open');
    if (shownEl === el) hide();
    watch(); release(el);
  }
  function closeAll() { cancel(); unpin(); hide(); }

  // --- The document's events ------------------------------------------------------------------------------
  function over(e) {
    var el = holderOf(e.target);
    px = e.clientX; py = e.clientY;
    if (el === hoverEl) return;
    var old = hoverEl, hoverUp = !!shownEl && !pinned;
    hoverEl = el;
    if (el) take(el);
    watch(); release(old);
    if (pinEl) return;                                    // a pinned bubble stays until it is closed
    if (!el) { if (hide()) warmUntil = now() + WARM; return; }
    if (e.buttons) { hide(); return; }                    // a drag or a held control passing over: no bubble
    if (hoverUp || now() < warmUntil) { show(el, px, py, false); return; }
    hide();
    timer = win.setTimeout(function () {
      timer = 0; track(false);
      if (hoverEl === el && !pinEl) show(el, px, py, false);
    }, DELAY);
    track(true);
  }
  // Out of the window (or a touch lifted): the next element's pointerover handles every other case.
  function out(e) {
    if (e.relatedTarget) return;
    var old = hoverEl;
    hoverEl = null;
    watch(); release(old);
    if (!pinned) hide(); else cancel();
  }
  // A press anywhere but on the pinned element closes it (the scene's own drag goes on untouched); a hover
  // bubble closes too unless the press is on its own element and could pin it there (a picture, a help dot).
  function down(e) {
    cancel();
    if (shownEl && !pinned && !(within(shownEl, e.target) && pinnable(e.target, shownEl))) hide();
    if (pinEl && !within(pinEl, e.target)) unpin();
  }
  function clicked(e) {
    if (e.isTrusted === false) return;                    // the page's own el.click()
    var el = holderOf(e.target);
    if (!el || !pinnable(e.target, el)) return;
    if (el === pinEl) { unpin(); return; }                // the second click closes it
    unpin();
    var x = e.clientX, y = e.clientY;
    // A dot pressed with the keyboard has no pointer position: the bubble opens by the dot.
    if (!x && !y && typeof el.getBoundingClientRect === 'function') { var r = el.getBoundingClientRect(); x = r.left; y = r.top; }
    if (!show(el, x, y, true)) return;
    pinEl = el;
    take(el); watch();
    if (isHelp(el)) el.setAttribute('data-open', '');
  }
  function key(e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && (shownEl || pinEl || timer)) closeAll();
  }

  build();
  adopt();
  doc.addEventListener('pointerover', over, LISTEN);
  doc.addEventListener('pointerout', out, LISTEN);
  doc.addEventListener('pointerdown', down, LISTEN);
  doc.addEventListener('click', clicked, LISTEN);
  doc.addEventListener('keydown', key, LISTEN);
  doc.addEventListener('scroll', closeAll, LISTEN);
  // The window's own blur only: in the capture phase every control losing focus would close a pinned bubble.
  win.addEventListener('resize', closeAll);
  win.addEventListener('blur', closeAll);
  win.BullbaTips = {close: closeAll};
})();
