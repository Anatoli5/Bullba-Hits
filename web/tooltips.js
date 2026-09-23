// ONE tooltip for the whole page, drawn by the page itself (23.09).
// The game's embedded browser (CEF) never shows the native `title` tooltip, and neither the right button nor
// Ctrl/Alt + click reach the page there (the original Armor Inspector behaves the same), so every word the page
// keeps in a `title` stayed unread in the game. The words stay where they are - in the `title` attributes the
// page writes - and this file draws them:
// - hover: ~350 ms over an element with a title (the nearest ancestor that has one) shows it in a bubble by the
//   pointer, kept inside the window; moving on to the next titled element while one is up shows it at once;
// - a left click (a tap) on an element that does nothing else pins the bubble open; a click elsewhere, Escape,
//   a scroll or a resize closes it; a click on a control keeps its action and the bubble only follows hover;
// - while an element is hovered or pinned its title waits in data-tip, so a normal browser never draws its own
//   tooltip over this one; a title the page writes meanwhile (the characteristics panel updates live) is moved
//   again by a MutationObserver on that element alone, and the bubble takes the new words.
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
  // The page's dark panel: the popover background, the tiles' border, 13 px text, a gold edge - all gold when pinned.
  var CSS = '#page-tip{position:fixed;left:0;top:0;z-index:10000;box-sizing:border-box;max-width:360px;'
    + 'max-width:min(360px,calc(100vw - 12px));padding:6px 10px 7px;border:1px solid rgba(157,174,191,.55);'
    + 'border-left:2px solid var(--gold,#eac36e);border-radius:6px;background:#15212e;color:#e5edf5;font-size:13px;'
    + 'font-weight:400;font-style:normal;line-height:1.4;letter-spacing:normal;text-align:left;text-transform:none;'
    + 'text-shadow:none;white-space:pre-line;overflow-wrap:break-word;word-wrap:break-word;'
    + 'box-shadow:0 8px 25px rgba(0,0,0,.55);pointer-events:none;-webkit-user-select:none;user-select:none}'
    + '#page-tip[hidden]{display:none}#page-tip[data-pinned]{border-color:var(--gold,#eac36e)}';
  // What a click already means something on: the bubble then follows hover only and the click keeps its action.
  var ACTIVE_TAGS = {A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, LABEL: 1, OPTION: 1, AUDIO: 1, VIDEO: 1};
  var ACTIVE_ROLES = /^(button|link|checkbox|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|textbox|searchbox|combobox|treeitem)$/;
  var LISTEN = {capture: true, passive: true};
  var WATCH = {attributes: true, attributeFilter: ['title']};

  var bubble = null, style = null;
  var shownEl = null, pinned = false, anchorX = 0, anchorY = 0, placeQueued = false;
  var hoverEl = null, pinEl = null, timer = 0, warmUntil = 0, px = 0, py = 0, tracking = false;
  var observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(retitled) : null;

  function now() { return Date.now(); }

  // --- The words: a title waits in data-tip while its element is hovered or pinned -------------------------
  function take(el) {
    var t = el.getAttribute('title');
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
  // The element whose words apply: the nearest one up from the pointer's target that has a title.
  function holderOf(node) {
    for (var el = node; el && el !== doc; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      if (el === hoverEl || el === pinEl || el.getAttribute('title') || el.hasAttribute('data-tip')) return el;
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
  function within(box, node) {
    for (var el = node; el; el = el.parentNode) if (el === box) return true;
    return false;
  }

  // --- A title the page writes while its element is hovered or pinned --------------------------------------
  function watch() {
    if (!observer) return;
    retitled(observer.takeRecords());
    observer.disconnect();
    if (hoverEl) observer.observe(hoverEl, WATCH);
    if (pinEl && pinEl !== hoverEl) observer.observe(pinEl, WATCH);
  }
  function retitled(records) {
    for (var i = 0; i < records.length; i++) {
      var el = records[i].target;
      if ((el !== hoverEl && el !== pinEl) || el.getAttribute('title') === null) continue;
      take(el);
      if (el === shownEl) refresh();
    }
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
  function show(el, x, y, pin) {
    cancel();
    var text = tipOf(el);
    if (!text) { hide(); return; }
    shownEl = el; pinned = !!pin; anchorX = x; anchorY = y;
    if (pinned) bubble.setAttribute('data-pinned', ''); else bubble.removeAttribute('data-pinned');
    bubble.textContent = text;
    place();
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
    var text = tipOf(shownEl);
    if (!text) { if (shownEl === pinEl) unpin(); else hide(); return; }
    if (bubble.textContent === text) return;
    bubble.textContent = text;
    if (placeQueued) return;
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
  // bubble closes too unless the press is on its own element and that is no control - the click may pin it.
  function down(e) {
    cancel();
    if (shownEl && !pinned && !(within(shownEl, e.target) && !interactive(e.target, shownEl))) hide();
    if (pinEl && !within(pinEl, e.target)) unpin();
  }
  function clicked(e) {
    if (e.isTrusted === false) return;                    // the page's own el.click()
    var el = holderOf(e.target);
    if (!el || interactive(e.target, el)) return;
    if (el === pinEl) { unpin(); return; }                // the second click closes it
    if (!tipOf(el)) return;
    unpin();
    pinEl = el;
    take(el); watch();
    show(el, e.clientX, e.clientY, true);
  }
  function key(e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && (shownEl || pinEl || timer)) closeAll();
  }

  build();
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
