// ONE tooltip for the whole page, drawn by the page itself and shown by a LEFT CLICK only (23.09).
// The game's embedded browser (CEF) never shows the native `title` tooltip, gives the page no hover to rely on, and
// lets neither the right button nor Ctrl/Alt + click through (the original Armor Inspector behaves the same); a bubble
// popping up under a passing pointer only drew the eye off the scene (user 23.09). So nothing ever shows on hover:
// - an element that does nothing on a left click (a figure, a tile of the scene, a line of a popover): a click shows
//   its words by the pointer; a second click on it, a press elsewhere, Escape, a scroll or a resize close them;
// - an element that acts on a click (a button, a tile of Config, a shell chip) is reached through the HELP MODE.
//   A help dot (<button class="help-dot" data-help-for="id id ...">?</button>, one per cluster of controls) shows the
//   short summary of its cluster - one group per element it lists that is on screen, led by the element's glyph -
//   and turns the mode on: the dot lit, the help cursor over the page. In the mode a press on ANY element with words
//   shows them and does nothing else: the press, the release, the click and a double-click are taken in the window's
//   capture phase, before every listener of the page, and stopped with their defaults - no control, no <details>, no
//   label and not the 3D scene sees them; the keys are left alone. The mode ends with Escape, the same dot again or a
//   press on a place with no words (the bubble goes with it); another dot moves it to its own cluster. A dot is
//   hidden while every element it lists is hidden.
// - every `title` of the page lives in data-tip, so no browser draws a tooltip of its own: the markup's are moved at
//   start; `el.title = words` - how the page writes them all - writes data-tip and `el.title` reads it back (a page
//   comparing before it writes keeps comparing its own words); ONE MutationObserver moves a title attribute written
//   any other way (setAttribute) and follows the words of the bubble that is up. None of the page's per-frame writes
//   of text or of a tooltip reaches it: it watches the attribute `title` of the page, not its text;
// - the words are one plain-text markup for every title (23.09), readable as is in a native tooltip and drawn here
//   with createElement/textContent only - a title is data (a record's names), never HTML:
//     lines split by '\n'; the first line is the heading, drawn bold (unless it is a sentence: ends in . ! ?);
//     '• Key: text' is an item, its key up to the first ': ' bold; '• text' an item without a key;
//     an empty line starts a new group (a gap); any other line is a paragraph.
// Listeners on the document and the window only, none per element, nothing per frame; layout is read only when a
// bubble opens or its words change. The bubble takes no pointer events. ES5, like the rest of the page.
(function () {
  'use strict';
  var win = window, doc = document;
  if (win.BullbaTips || !doc || !doc.addEventListener) return;

  var GAP_X = 12, GAP_Y = 18, ABOVE = 8, EDGE = 6;
  var HELP = 'data-help-for', TIP = 'data-tip', MODE = 'data-help-mode';
  // The bubble wears the page's own panel - the choice lists' background and border, 13 px text - and nothing more:
  // no accent edge, no shade (user 23.09: they drew the eye). The markup: a bold heading, items hanging off a grey
  // bullet with a bold key, a gap between groups; a help bubble is wider and gives each group its element's glyph.
  // The help dot: one small round "?" wherever it stands, one look above whatever the row around it gives a button
  // (hence the doubled class); a lighter edge under the pointer, gold while its help mode is on.
  var DOT = 'button.help-dot.help-dot[data-help-for]';
  // A help that opens a box of its own (the vehicle list's <details>, its summary .help-dot) wears the same dot, gold
  // while open: one look for every "?" of the page.
  var BOX = 'details>summary.help-dot.help-dot';
  function dotCss(suffix) { return DOT + suffix + ',' + BOX + suffix; }
  var CSS = '#page-tip{position:fixed;left:0;top:0;z-index:10000;box-sizing:border-box;max-width:360px;'
    + 'max-width:min(360px,calc(100vw - 12px));padding:6px 10px 7px;border:1px solid #35475a;border-radius:6px;'
    + 'background:#172330;color:#e5edf5;font-size:13px;font-weight:400;font-style:normal;line-height:1.4;'
    + 'letter-spacing:normal;text-align:left;text-transform:none;text-shadow:none;white-space:pre-line;'
    + 'overflow-wrap:break-word;word-wrap:break-word;box-shadow:none;pointer-events:none;-webkit-user-select:none;user-select:none}'
    + '#page-tip[hidden]{display:none}'
    + '#page-tip[data-help]{max-width:520px;max-width:min(520px,calc(100vw - 12px))}'
    + '#page-tip .tip-h,#page-tip .tip-li>b,#page-tip .tip-glyph{font-weight:600}'
    + '#page-tip .tip-li{position:relative;padding-left:13px}'
    + '#page-tip .tip-li::before{content:"\\2022";position:absolute;left:2px;top:0;color:#96a9bd}'
    + '#page-tip .tip-h+div{margin-top:3px}#page-tip div.tip-gap{margin-top:7px}'
    + '#page-tip .tip-row+.tip-row{margin-top:8px}'
    + '#page-tip .tip-glyph{margin-right:7px}'
    + '#page-tip .tip-glyph img{height:18px;width:auto;vertical-align:-4px}'
    + dotCss('') + '{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;'
    + 'align-self:center;box-sizing:border-box;width:18px;height:18px;min-width:0;min-height:0;margin:0;padding:0;'
    + 'border:1px solid rgba(157,174,191,.55);border-radius:50%;background:rgba(23,35,48,.35);color:#96a9bd;'
    + 'font-family:inherit;font-size:11px;font-weight:700;font-style:normal;line-height:1;letter-spacing:0;'
    + 'text-transform:none;text-shadow:none;box-shadow:none;vertical-align:middle;cursor:help}'
    + dotCss(':hover') + '{border-color:#c9d3dd;color:#e5edf5;background:rgba(38,55,73,.45)}'
    + DOT + '[data-open],details[open]>summary.help-dot.help-dot{border-color:var(--gold,#eac36e);color:var(--gold,#eac36e);background:#302b23}'
    + dotCss(':focus-visible') + '{outline:2px solid var(--gold,#eac36e);outline-offset:2px}'
    + dotCss('[hidden]') + '{display:none}' + BOX + '::after{content:none}'
    // The help mode: the help cursor over the whole page, whatever an element or the scene sets for itself.
    + 'html[' + MODE + '],html[' + MODE + '] *{cursor:help!important}';
  // What a click already means something on: its click keeps its action and shows nothing (the help mode shows it).
  var ACTIVE_TAGS = {A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, LABEL: 1, OPTION: 1, AUDIO: 1, VIDEO: 1};
  var ACTIVE_ROLES = /^(button|link|checkbox|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|textbox|searchbox|combobox|treeitem)$/;
  var PASSIVE = {capture: true, passive: true}, TAKE = {capture: true, passive: false};
  // The help mode takes a whole press: its first event down to the click, and a double-click after it.
  var PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];
  // What the one observer follows: a title attribute written anywhere (and, where el.title could not be taken over,
  // the elements added with one); the `hidden` of the few boxes that decide whether a help dot stands; the words of
  // the element whose bubble is up, or for a help bubble the words and `hidden` of what its dot lists.
  var TITLES = {attributes: true, attributeFilter: ['title'], subtree: true};
  var TITLES_ADDED = {attributes: true, attributeFilter: ['title'], subtree: true, childList: true};
  var HIDDEN = {attributes: true, attributeFilter: ['hidden']};
  var WORDS = {attributes: true, attributeFilter: [TIP, 'hidden']};
  var LISTED = {attributes: true, attributeFilter: [TIP, 'hidden'], subtree: true};

  var bubble = null, style = null;
  var shownEl = null, shownKey = '', anchorX = 0, anchorY = 0, placeQueued = false;
  var helpDot = null, pressed = false, eatDouble = false;
  var observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(changed) : null;
  var direct = false;     // el.title writes data-tip itself (takeTitle)
  var dots = [], boxes = [];

  // --- The words: data-tip, never title --------------------------------------------------------------------
  function park(el) {
    var t = el.getAttribute('title');
    if (t === null) return;
    el.setAttribute(TIP, t);
    el.removeAttribute('title');
  }
  function parkAll(node) {
    if (!node || node.nodeType !== 1) return;
    park(node);
    var found = node.querySelectorAll ? node.querySelectorAll('[title]') : [];
    for (var i = 0; i < found.length; i++) park(found[i]);
  }
  // `el.title = words` writes data-tip, `el.title` reads it back - HTML elements only. Where the accessor cannot be
  // replaced the observer also watches the elements the page adds, and moves their titles.
  function takeTitle() {
    var proto = win.HTMLElement && win.HTMLElement.prototype, own = null;
    try { own = proto ? Object.getOwnPropertyDescriptor(proto, 'title') : null; } catch (e) { own = null; }
    if (!own || !own.configurable || typeof own.get !== 'function' || typeof own.set !== 'function') return false;
    try {
      Object.defineProperty(proto, 'title', {configurable: true, enumerable: !!own.enumerable,
        get: function () { var t = this.getAttribute(TIP); return t === null ? own.get.call(this) : t; },
        set: function (v) { this.setAttribute(TIP, String(v)); if (this.hasAttribute('title')) this.removeAttribute('title'); }});
    } catch (e2) { return false; }
    return true;
  }
  function tipOf(el) {
    var t = el.getAttribute(TIP);
    return t === null ? (el.getAttribute('title') || '') : t;
  }
  function hasWords(el) { return el.nodeType === 1 && /\S/.test(tipOf(el)); }
  function isHelp(el) { return el.nodeType === 1 && el.hasAttribute(HELP); }
  // The element whose words apply: the nearest one up from the target that has words, or a help dot.
  function holderOf(node) {
    for (var el = node; el && el !== doc; el = el.parentNode) {
      if (el.nodeType === 1 && (isHelp(el) || hasWords(el))) return el;
    }
    return null;
  }
  function dotOf(node) {
    for (var el = node; el && el !== doc; el = el.parentNode) if (el.nodeType === 1 && isHelp(el)) return el;
    return null;
  }
  // A control, or inside one: a native control or its label anywhere up the chain, a control role, a click
  // handler set as a property or an attribute; between the target and the element with the words also a focusable
  // element, and a pointer cursor on the target (the stylesheet marks what is pressable with it). The scene
  // (#viewport, focusable) is above the tiles in it, so a tile of the scene with words still counts as a picture.
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
  // One row (a group) per element the dot lists that is on screen: its own words; for a group without words of its
  // own, the words of its items (the gun's shells, the shell chips); for an element inside one with words (the
  // checkbox of a labelled switch), that one's. Each once.
  function helpRows(dot) {
    var els = listed(dot), rows = [], seen = [];
    function add(el, holder) {
      if (seen.indexOf(holder) >= 0) return;
      seen.push(holder);
      rows.push({glyph: glyphOf(el) || (holder !== el ? glyphOf(holder) : ''), text: tipOf(holder)});
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
  // A help dot stands only while something it explains does: while every element it lists is hidden (the model row
  // with no model on screen), so is the dot. An element counts as hidden when it or a box around it below the one it
  // shares with the dot carries `hidden` (the gun's shells inside the hidden gun panel); a box around both hides the
  // dot with them anyway. The dots of the page are taken once, at start, and the observer follows the page's own
  // `hidden` writes on those few boxes - no layout is read for it.
  function adopt() {
    var found = doc.querySelectorAll ? doc.querySelectorAll('[' + HELP + ']') : [];
    for (var i = 0; i < found.length; i++) {
      var dot = found[i], els = listed(dot), chains = [];
      for (var k = 0; k < els.length; k++) {
        var chain = [];
        for (var el = els[k]; el && el.nodeType === 1 && !within(el, dot); el = el.parentNode) {
          chain.push(el);
          if (boxes.indexOf(el) < 0) boxes.push(el);
        }
        chains.push(chain);
      }
      dots.push({dot: dot, chains: chains});
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

  // --- The one observer ------------------------------------------------------------------------------------
  // Set again whenever the bubble opens or closes: the page's titles, the dots' boxes, and what the bubble shows.
  // A box watched twice keeps the wider watch (the later observe() replaces the earlier one's options).
  function watch() {
    if (!observer) return;
    var pending = observer.takeRecords();
    observer.disconnect();
    observer.observe(doc.documentElement, direct ? TITLES : TITLES_ADDED);
    for (var i = 0; i < boxes.length; i++) observer.observe(boxes[i], HIDDEN);
    if (shownEl && isHelp(shownEl)) for (var els = listed(shownEl), k = 0; k < els.length; k++) observer.observe(els[k], LISTED);
    else if (shownEl) observer.observe(shownEl, WORDS);
    if (pending.length) changed(pending);
  }
  function changed(records) {
    var words = false, hid = false;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'childList') { for (var k = 0; k < r.addedNodes.length; k++) parkAll(r.addedNodes[k]); continue; }
      if (r.attributeName === 'title') { if (r.target.getAttribute('title') !== null) park(r.target); }
      else if (r.attributeName === 'hidden') hid = true;
      else words = true;
    }
    if (hid) present();
    if (!shownEl || !(words || hid)) return;
    if (hid && !onScreen(shownEl)) hide(); else refresh();
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
  var BULLET = /^•\s*/, SENTENCE = /[.!?]$/, TRIM = /^\s+|\s+$/g;
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
  // The bubble's words: the element's own, or the groups a help dot gathers. 0 - nothing to show, 1 - the bubble
  // already shows exactly this, 2 - written.
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
  function show(el, x, y) {
    shownKey = '';
    if (!paint(el)) { hide(); return false; }
    shownEl = el; anchorX = x; anchorY = y;
    place();
    watch();
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
    if (!done) { hide(); return; }
    if (done === 1 || placeQueued) return;
    placeQueued = true;
    (win.requestAnimationFrame || function (fn) { return win.setTimeout(fn, 16); })(function () {
      placeQueued = false;
      if (shownEl) place();
    });
  }
  function hide() {
    if (!shownEl) return false;
    shownEl = null; shownKey = '';
    bubble.hidden = true;
    watch();
    return true;
  }
  // Where the bubble of a click opens: at the pointer; a click from the keyboard has none - by the element then.
  function pointOf(e, el) {
    var x = e.clientX || 0, y = e.clientY || 0;
    if (!x && !y && typeof el.getBoundingClientRect === 'function') { var r = el.getBoundingClientRect(); x = r.left; y = r.top; }
    return [x, y];
  }

  // --- The help mode --------------------------------------------------------------------------------------
  function helpOn(dot, at) {
    if (!show(dot, at[0], at[1])) return;                 // nothing of its cluster on screen: no mode
    if (helpDot && helpDot !== dot) helpDot.removeAttribute('data-open');
    helpDot = dot;
    dot.setAttribute('data-open', '');
    if (!doc.documentElement.hasAttribute(MODE)) doc.documentElement.setAttribute(MODE, '');
  }
  function helpOff() {
    if (!helpDot) return;
    helpDot.removeAttribute('data-open');
    helpDot = null;
    doc.documentElement.removeAttribute(MODE);
    hide();
  }
  function dotPressed(dot, at) { if (dot === helpDot) helpOff(); else helpOn(dot, at); }
  // A press in the mode: a dot - its own cluster (or, the lit one, the end of the mode); anything with words - its
  // words (the same element again - closed, the mode stays); a place with none - the end of the mode.
  function helpPress(e) {
    var t = e.target, dot = dotOf(t), at = pointOf(e, t);
    if (dot) { dotPressed(dot, at); return; }
    var el = holderOf(t);
    if (el && el === shownEl) { hide(); return; }
    if (!el || !show(el, at[0], at[1])) helpOff();
  }

  // --- The events -----------------------------------------------------------------------------------------
  // THE HELP MODE'S PRESS, taken whole in the window's capture phase and stopped with its default. Outside the mode
  // every one of these returns at once.
  function take(e) {
    var type = e.type;
    if (type === 'pointerdown') { eatDouble = false; pressed = !!helpDot && e.isTrusted !== false; }
    if (type === 'dblclick' ? !(eatDouble || helpDot) : !pressed) return;
    e.preventDefault();
    e.stopPropagation();
    if (type === 'pointerdown') { if (!e.button) helpPress(e); }
    else if (type === 'click') { pressed = false; eatDouble = true; }
  }
  // Outside the mode: a press anywhere but on the words shown closes them (a control inside them too); the scene's
  // own drag goes on untouched - nothing here is ever stopped or prevented.
  function down(e) {
    if (shownEl && !(within(shownEl, e.target) && !interactive(e.target, shownEl))) hide();
  }
  // A click on an element with words that does nothing else shows them, a second one closes them; a click on a
  // dot (or a key on it, in the mode too) turns the help mode on or off.
  function clicked(e) {
    if (e.isTrusted === false) return;                    // the page's own el.click()
    var t = e.target, dot = dotOf(t);
    if (dot) { dotPressed(dot, pointOf(e, dot)); return; }
    if (helpDot) return;                                  // a key in the mode: the control acts, as keys always do
    var el = holderOf(t);
    if (!el || interactive(t, el)) return;
    if (el === shownEl) { hide(); return; }
    var at = pointOf(e, el);
    show(el, at[0], at[1]);
  }
  // Escape ends the mode, or closes the bubble - and is then the bubble's alone: a popover under it stays open.
  function key(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (helpDot) helpOff(); else if (!hide()) return;
    e.stopPropagation();
  }
  function away() { hide(); }

  build();
  direct = takeTitle();
  parkAll(doc.documentElement);
  adopt();
  watch();
  for (var p = 0; p < PRESS.length; p++) win.addEventListener(PRESS[p], take, TAKE);
  doc.addEventListener('pointerdown', down, PASSIVE);
  doc.addEventListener('click', clicked, PASSIVE);
  doc.addEventListener('keydown', key, PASSIVE);
  doc.addEventListener('scroll', away, PASSIVE);
  // The window's own resize and blur only: in the capture phase every control losing focus would close the bubble.
  win.addEventListener('resize', away);
  win.addEventListener('blur', away);
  win.BullbaTips = {close: function () { helpOff(); hide(); }};
})();
