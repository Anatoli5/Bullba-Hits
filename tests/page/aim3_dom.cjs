// A DOM stub just rich enough to run web/app.js outside a browser, so the aim emulation can be exercised
// without loading the page: the module body must run clean, and then the emulation is switched on beside
// the Shooter tile, driven with W A S D, fired by a tap and by a held burst, paused by a drag, and given
// the equipment slots and presets, with a stub viewer standing in for three.js.
// Stage 4 (20.09): the press is a state machine - down arms, a drag cancels, a short press fires one shot
// on release, a long one starts a burst on the gun's cooldown - and the ring of the last shot and the live
// ring that never freezes are two separate things the stub viewer records.
// Stage 5 (20.09): a move no longer cancels a burst that is already firing (only the release does), the
// reload is the FILL of the live ring (null = loaded, 0..1 = reloading) instead of an amber arc.
// Stage 6 (20.09): the keys are listened for on the DOCUMENT (they drive the moment the mode is on, and a
// key typed into a field is left alone), braking is a phase of its own, the hull carries the gun with it
// (turnAim) and the turret chases back, the recorded shot stays until the USER'S FIRST SHOT, and the
// corner readout is gone - each ring prints ONE figure, "Circle 25 %", on its own info panel.
// Stage 7 (20.09): every STANDING ring is magenta and only the live one is cyan (checked against the
// source of viewer.js, which cannot run here), the hit-line panel prints the Circle figure of the
// RECORDED ring too - the client reticle, or the nominal estimate when the hit has none - the key glyph
// lights the caps that are held, and a turn arc beside the speed shows which way the hull is coming round.
// Stage 8 (20.09): the mode is ON BY DEFAULT and its switch is an ordinary Settings -> Scene checkbox
// (nothing beside the Shooter tile any more), and a gun panel stands where that switch was - the
// shooter's own shells as the client's icons, in step with the heading shell list, plus the load state
// the in-game reticle shows (a countdown and the rounds of a clip while a burst is held, the gun's own
// reload time and clip size at rest).
// Stage 11 (21.09): the pickers have no "empty" tile any more - the fitted piece is the pressed tile and a
// click on it takes it out; Brothers in Arms is one tile per crew member and the crew law is the client's
// (5 x members-with-it / N, the commander's tenth only for the roles he does not hold, gunner and loader
// apart); the "Fitted: ..." line is gone; and while the Config popover is open the aim is held on the model
// centre with a drawn crosshair. That last part is also run against the REAL viewer.js methods at the end,
// on three.js in Node with a box for a model, since the stub viewer cannot say where a ray lands.
// S5 (22.09): the two Circle figures left the info panels for a mirrored column at the top RIGHT of the
// scene, one tile per ring on the row of the panel it belongs to. The ids stayed on the VALUE elements, so
// circleLine() still writes the figure there; the TILE around each of them (<id>-tile) takes the hidden
// flag, the ring's colour class and the tooltip, and its heading holds the word "Circle".
// S0 (22.09): five fixes from the review of stage 11 - a configuration change takes the ring's figure again
// at once and wakes the loop for the fine one; the held centre is found again when the camera comes to rest
// after an orbit (checked on the REAL orbit loop); a turret that catches the cursor in one frame no longer
// puts the loop to sleep with a bloomed ring; the whole scene click with Config open (the document handler
// closes the popover, nothing fires); and the roster's shooter mark follows a clicked hit. The model-change
// check now really changes the model. BULLBA_WEB=<dir>/ runs the same checks against another copy of web/.
// It is NOT a rendering test - nothing here draws anything - it is a check that the wiring runs.
// Grown out of scratchpad/aim2_dom.cjs (stage 2), whose strip of sliders no longer exists.
'use strict';
const HERE = require('node:path').resolve(__dirname).replace(/\\/g, '/') + '/';   // tests/page/: the repository's web/ and mod/ are ../../, the local fixtures ../fixtures-local/
const fs = require('fs');
const path = process.env.BULLBA_WEB || HERE + '../../web/';

let rafQueue = [], rafId = 1, timerQueue = [], timerId = 1, clock = 0;

function Element(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = []; this.attributes = {}; this.style = {}; this.dataset = {};
  this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false;
  this.disabled = false; this.title = ''; this.className = ''; this.id = '';
  this.options = []; this.parentNode = null; this.open = false; this.listeners = {};
  this.min = ''; this.max = ''; this.step = ''; this.type = ''; this.maxLength = 0;
  this.offsetWidth = 100; this.clientWidth = 1000; this.offsetLeft = 0;
  this.classList = {
    add: function () {}, remove: function () {}, toggle: function () {},
    contains: function () { return false; }
  };
}
Element.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; if (c.tagName === 'OPTION') this.options.push(c); return c; };
// Crits (22.09): before the reference node, as a browser does (the details row of a later tie is put back in place).
Element.prototype.insertBefore = function (c, ref) {
  const at = ref ? this.children.indexOf(ref) : -1;
  if (at < 0) return this.appendChild(c);
  if (c.parentNode) c.parentNode.removeChild(c);
  this.children.splice(this.children.indexOf(ref), 0, c); c.parentNode = this; if (c.tagName === 'OPTION') this.options.push(c);
  return c;
};
Element.prototype.removeChild = function (c) { this.children = this.children.filter(function (x) { return x !== c; }); return c; };
Element.prototype.replaceChildren = function () {
  this.children = []; this.options = [];
  for (let i = 0; i < arguments.length; i++) if (typeof arguments[i] !== 'string') this.appendChild(arguments[i]);
};
Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
// S4 review (22.09): a name field committed in place becomes the row's name button again, without the list
// being rebuilt - so the icon whose mousedown committed it is still on the page to receive its own click.
Element.prototype.replaceWith = function (c) { if (this.parentNode) { this.parentNode.insertBefore(c, this); this.remove(); } };
Element.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
Element.prototype.getAttribute = function (k) { return this.attributes[k] === undefined ? null : this.attributes[k]; };
// 24.09 (scene-one-path): web/tooltips.js runs here too (the help dots), and it asks these of an element.
Element.prototype.hasAttribute = function (k) { return this.attributes[k] !== undefined; };
Element.prototype.nodeType = 1;
Element.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
Element.prototype.addEventListener = function (n, fn) { (this.listeners[n] = this.listeners[n] || []).push(fn); };
Element.prototype.removeEventListener = function (n, fn) { this.listeners[n] = (this.listeners[n] || []).filter(function (f) { return f !== fn; }); };
Element.prototype.fire = function (n, e) { (this.listeners[n] || []).slice().forEach(function (fn) { fn(e || {}); }); };
Element.prototype.listenerCount = function (n) { return (this.listeners[n] || []).length; };
Element.prototype.querySelector = function () { return new Element('div'); };
Element.prototype.querySelectorAll = function () { return []; };
Element.prototype.getBoundingClientRect = function () { return {left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40}; };
Element.prototype.focus = function () {}; Element.prototype.select = function () {};
Element.prototype.closest = function () { return null; };
// A slider under the cursor takes the wheel and the arrows (user, 22.09): the page moves it by dispatching
// real 'input'/'change' events, so the stub needs a constructor and a dispatch that reach its listeners.
global.Event = function (type) { this.type = String(type); };
Element.prototype.dispatchEvent = function (e) { this.fire(e.type, {target: this}); if (this['on' + e.type]) this['on' + e.type].call(this); return true; };
Element.prototype.scrollIntoView = function () {};
// S0: the document click handlers ask a popover whether the click came from inside it.
Element.prototype.contains = function (el) { for (let e = el; e; e = e.parentNode) if (e === this) return true; return false; };

const byId = {};
// An element that is given an id becomes findable by it, exactly as it is once it is in the document:
// without this the page's own controls (the vehicle search, the popover fields) and the auto-created
// stubs would be two different objects.
Object.defineProperty(Element.prototype, 'id', {
  get: function () { return this._id || ''; },
  set: function (v) { this._id = String(v || ''); if (this._id) byId[this._id] = this; }
});
// The document listens too since stage 6: W A S D are attached HERE while the mode is on, not to the
// viewport, so the harness has to record and fire document listeners exactly as an element does.
const document = {
  activeElement: null,
  createElement: function (tag) { return new Element(tag); },
  // fillPanel() has put the chance figure in a text node beside the alpha span since 20.09; without this
  // the whole load path threw and two later checks failed for no reason of their own.
  createTextNode: function (text) { const n = new Element('#text'); n.textContent = String(text); return n; },
  getElementById: function (id) { if (byId[id]) return byId[id]; const e = new Element('div'); e.id = id; return e; },
  querySelector: function (sel) { return byId['sel:' + sel] || (byId['sel:' + sel] = new Element('div')); },
  querySelectorAll: function () { return []; },
  listeners: {},
  addEventListener: Element.prototype.addEventListener,
  removeEventListener: Element.prototype.removeEventListener,
  fire: Element.prototype.fire,
  listenerCount: Element.prototype.listenerCount,
  body: new Element('body'),
  hidden: false
};
const storage = {};
// Stage 11: a v3 store written before Brothers in Arms went per member. "Old whole crew" holds the
// whole-crew flag skills.brotherhood, which must come back as every member having it; "Old partial" holds
// the new per-member map with a member this five-man crew does not have (loader2), which must be kept for
// a crew that has him, and a key that is nobody's name (bogus), which must go.
storage['bullba-settings'] = JSON.stringify({v: 1, values: {}, aim: {v: 3, chosen: {}, presets: {
  'Old whole crew': {slots: ['', '', ''], directive: '', food: false, fuel: '', skills: {brotherhood: true, gunner_smoothTurret: true}},
  'Old partial': {slots: ['', '', ''], directive: '', food: false, fuel: '', skills: {}, bia: {gunner: true, loader2: true, bogus: true}}}}});
// S4 (22.09): the reload check. The run below starts this same harness again in a child process with the store
// the first run left behind, and that second page has to come back on the vehicle's Custom build from the
// store alone. In the child, everything after the load is skipped: only the reload checks run.
const RELOAD = process.env.BULLBA_RELOAD || '';
const winListeners = {};
// The page's whole layout pass, now: its own resize handler, then the frame it asked for.
function scheduleLayoutNow() { (winListeners.resize || []).forEach(function (fn) { fn({}); }); tick(0.001); }
const RELOAD_WANT = RELOAD ? JSON.parse(process.env.BULLBA_RELOAD_WANT || '{}') : null;
if (RELOAD) storage['bullba-settings'] = RELOAD;
const window = {
  document: document,
  localStorage: {
    getItem: function (k) { return storage[k] === undefined ? null : storage[k]; },
    setItem: function (k, v) { storage[k] = String(v); },
    removeItem: function (k) { delete storage[k]; }
  },
  requestAnimationFrame: function (fn) { const id = rafId++; rafQueue.push({id: id, fn: fn}); return id; },
  cancelAnimationFrame: function (id) { rafQueue = rafQueue.filter(function (r) { return r.id !== id; }); },
  // The fake clock counts SECONDS, setTimeout is given MILLISECONDS: the stage-3 harness scheduled every
  // timer a thousand times too late, which nothing noticed until the 250 ms hold timer had to fire.
  setTimeout: function (fn, ms) { const id = timerId++; timerQueue.push({id: id, fn: fn, at: clock + (ms || 0) / 1000}); return id; },
  clearTimeout: function (id) { timerQueue = timerQueue.filter(function (t) { return t.id !== id; }); },
  // TTX (23.09): the window's listeners are kept, so a check can run the page's resize handler - the layout pass.
  addEventListener: function (n, fn) { (winListeners[n] = winListeners[n] || []).push(fn); }, removeEventListener: function () {},
  getComputedStyle: function () { return {columnGap: '10px', paddingLeft: '0px', paddingRight: '0px'}; },
  performance: {now: function () { return clock * 1000; }},
  console: console,
  location: {hash: '', href: 'about:blank'},
  Element: Element
};
window.window = window;
global.window = window; global.document = document;
// Node's own timers are left alone on purpose: replacing the global setTimeout breaks stdout flushing.
// app.js asks for window.setTimeout / window.requestAnimationFrame everywhere the emulation is concerned.
global.Element = Element;
// The page writes `window.performance && performance.now` - in a browser those are the same object.
// Here they are not, so the fake clock has to be the global one too or the frame loop sees no time pass.
global.performance = window.performance;

// Time control: advance the fake clock and run whatever is due.
// S2: the frames the aim loop asked for - the page's layout debounce, which now runs in these checks (see the
// load below), is not the loop and is left out of the count.
function loopFrames() { return rafQueue.filter(function (f) { return !/layoutHeading/.test(String(f.fn)); }).length; }
// 24.09: the page saves its settings one moment after the last change (persistNow on a 300 ms timer) and a wheel
// notch redraws the control on the next frame (flushInput): a check that reads the store or the drawn value runs
// just those two, so no other timer or frame of the page moves.
function runNamed(name) {
  const t = timerQueue.filter(function (x) { return x.fn && x.fn.name === name; });
  timerQueue = timerQueue.filter(function (x) { return !(x.fn && x.fn.name === name); });
  t.forEach(function (x) { x.fn(); });
  const f = rafQueue.filter(function (x) { return x.fn && x.fn.name === name; });
  rafQueue = rafQueue.filter(function (x) { return !(x.fn && x.fn.name === name); });
  f.forEach(function (x) { x.fn(clock * 1000); });
}
function savedSettings() { runNamed('persistNow'); return storage['bullba-settings']; }
function tick(seconds) {
  clock += seconds;
  const frames = rafQueue; rafQueue = [];
  frames.forEach(function (f) { f.fn(clock * 1000); });
  const due = timerQueue.filter(function (t) { return t.at <= clock; });
  timerQueue = timerQueue.filter(function (t) { return t.at > clock; });
  due.forEach(function (t) { t.fn(); });
}

// ---- stub collaborators -----------------------------------------------------------------------
const shots = [];
function StubViewer() {
  this.distance = 100; this.shell = null; this.liveRadius100 = null; this.liveAimPoint = {x: 1};
  this.aimCursorPoint = {x: 1}; this.spreadAim = null; this.aimChase = false; this.pinned = null;
  this.engine = {}; this.savedAim = null; this.estimateAim = null; this.turretAngle = 0; this.gunAngle = 0;
  // The range the recorded shot was fired at (viewer.setShotContext reads it off the record). The figure of
  // the STANDING ring is taken with the shell at THAT range, not at the one the Distance slider stands on.
  this.recordedDistance = null;
  this.gap = 0; this.profile = null; this.chased = 0; this.pinnedPoints = 0;
  this.aimHold = false; this.dragging = false; this.emulation = null;
  // recordedHidden: whether the battle's own reticles and tracers are off the scene. Since stage 6 that
  // is NOT the mode but the first shot: setAimShot hides them, clearAimShot (mode on, mode off, a reset)
  // brings them back and releases the pin the shot made.
  this.recordedHidden = false; this.aimPinned = false;
  // shotRing: the radius the ring left by the LAST shot was taken at (one ring, replaced by each shot);
  // shotsDrawn: how many times it was replaced; reloadPart: how much of the LIVE ring is drawn while the
  // gun reloads, 0..1, null when it is loaded and the ring is whole; turned: the angles the hull swung
  // the aim point through.
  this.shotRing = null; this.shotsDrawn = 0; this.reloadPart = null; this.turned = [];
  this.impact = null;   // how strongly the cross at an impact point is drawn, 0.1..1 (stage 7)
  // Stage 11: the hold on the model centre and the figure's bookkeeping. They must exist from the start:
  // the Proxy below hands a no-op FUNCTION for any property the stub lacks, which reads as truthy.
  this.centred = null; this.centreCalls = 0; this.markerShape = ''; this.drawnAt = null;
  this.probes = 0; this.lastProbeCount = 0; this.probeRadius = null; this.fineProbes = 0;
  // The fun layer (22.09): what the page asks of the viewer for a rolled shot. `sampled` counts the draws
  // of a point inside the ring, `pinnedAt` is the point the shot line was pinned through (the ring's
  // middle with the layer off, the drawn point with it on), `pinResult` the verdict refreshPin hands back
  // and `marks` the dots the page asked to be left on the armour. They must exist from the start: the
  // Proxy below answers an unknown property with a no-op FUNCTION, which reads as truthy.
  this.sampled = 0; this.sampleDraws = []; this.pinnedAt = null; this.pinResult = null;
  this.pinNormal = {normal: true}; this.marks = []; this.marksOn = false; this.marksCleared = 0;
  this.flashes = 0;   // strip (23.09): the pulses of the live ring a refused press asked for
  // BACKLOG 28 step 2 (24.09): the shot disc of an own shot - its frame (discAim), the solid ring's (ringAim), the Settings
  // switch and opacity. They must exist from the start, for the same reason as above.
  this.discAim = null; this.ringAim = null; this.discOn = true; this.discOpacity = null; this.ringLook = null;
  // shot-line-true (24.09): the shell's flight carried onto the hit (viewer.shotPath), null without a tracer - the page's
  // marks of the game's oddities read it. It must exist from the start, for the same reason as above.
  this.shotPath = null;
}
// The temporary Shot ring lab hands the look over; the stub keeps what it got.
StubViewer.prototype.setShotRingLook = function (look) { this.ringLook = look; };
// The real setShotDisc hands the figure to the circle on screen: the disc while it is on, the solid ring otherwise.
StubViewer.prototype.setShotDisc = function (on, opacity) { this.discOn = !!on; this.discOpacity = opacity; if (this.discAim) this.savedAim = on ? this.discAim : this.ringAim; };
StubViewer.prototype.setImpactOpacity = function (v) { this.impact = v; };
// Soft lighting and how deep it shades (user, 22.09): the page keeps both and hands them to every new surface.
StubViewer.prototype.setLighting = function (v) { this.lighting = !!v; };
StubViewer.prototype.setLightStrength = function (v) { this.lightStrength = v; };
// drawnAt: the point the live ring was last drawn around - the gun's point, or the held centre (stage 11).
StubViewer.prototype.setLiveAim = function (r) { this.liveRadius100 = r; this.drawnAt = this.liveAimPoint; };
// Stage 11: the hold on the model centre while the Config popover is open, as viewer.js does it - the gun
// and the cursor point both jump to the centre (CENTRE stands for the point the real one raycasts), and
// letting go gives back what was there. The real geometry is checked at the end on three.js.
const CENTRE = {centre: true};
StubViewer.prototype.setAimCentre = function (on, shape) {
  this.markerShape = shape; this.centreCalls = (this.centreCalls || 0) + 1;
  if (!!on === !!this.centred) return;
  if (on) { this.centred = {cursor: this.aimCursorPoint, gun: this.liveAimPoint}; this.aimCursorPoint = CENTRE; this.liveAimPoint = CENTRE; }
  else { const held = this.centred; this.centred = null; this.aimCursorPoint = held.cursor; this.liveAimPoint = held.gun; }
  if (this.liveRadius100) this.drawnAt = this.liveAimPoint;
};
StubViewer.prototype.setAimShot = function () { this.shotsDrawn++; this.shotRing = this.liveRadius100; this.recordedHidden = true; return true; };
StubViewer.prototype.clearAimShot = function () {
  this.shotRing = null; this.shotsDrawn = 0; this.reloadPart = null; this.recordedHidden = false;
  if (this.aimPinned) { this.aimPinned = false; this.pinned = null; }
};
StubViewer.prototype.setAimReload = function (part) { this.reloadPart = part === null || part === undefined ? null : part; };
// Strip (23.09): a press the gun refused pulses the live ring; the stub counts the pulses asked for.
StubViewer.prototype.flashAim = function () { this.flashes = (this.flashes || 0) + 1; return true; };
StubViewer.prototype.setAimEmulation = function (on) { this.emulation = !!on; this.aimChase = !!on; if (!on) this.aimHold = false; this.clearAimShot(); };
// The hull swung the gun by `angle`; the cursor did not move, so the gap the turret has to close grows.
StubViewer.prototype.turnAim = function (angle) { this.turned.push(angle); this.gap += Math.abs(angle); return true; };
StubViewer.prototype.clearLiveAim = function () { this.liveRadius100 = null; this.clearAimShot(); };
StubViewer.prototype.setAimProfile = function (name) { this.profile = name; };
// BACKLOG 40 (23.09): the page hands both the shooter's horizontal sector (or null); the stub only keeps what it got.
StubViewer.prototype.aimGap = function (limits) { this.gapLimits = limits; return this.gap; };
StubViewer.prototype.chaseAim = function (step, limits) { this.chaseLimits = limits; this.chased++; this.gap = Math.max(0, this.gap - step); return true; };
StubViewer.prototype.pinAtPoint = function (point) { this.pinnedPoints++; this.pinnedAt = point; this.pinned = {point: point, normal: this.pinNormal}; this.aimPinned = true; return true; };
// The fun layer: the page draws its impact point from the viewer (the same law the ring's figure is
// integrated with) and asks for a dot on the armour. Both are recorded, nothing is computed here.
StubViewer.prototype.liveAimSample = function (random) { this.sampled++; this.sampleDraws.push(random(), random()); return {drawn: this.sampled}; };
StubViewer.prototype.setHitMarks = function (on) { this.marksOn = !!on; };
StubViewer.prototype.hitMarkLimit = function () { return 500; };
StubViewer.prototype.addHitMark = function (mark) { this.marks.push(mark); return true; };
// 22.09, 23:15: the record of a shot is the viewer's - one entry per plate the shell met, in its part.
StubViewer.prototype.hitMarkShot = function (verdict, caliber, roll) { return {caliber: caliber, roll: roll, verdict: verdict, marks: [{point: this.pinned && this.pinned.point, outcome: verdict.outcome}]}; };
StubViewer.prototype.clearHitMarks = function () { const had = this.marks.length > 0; this.marks = []; this.marksCleared++; return had; };
// Stage 11: counted, so the harness can see the figure being taken again when the ring moves to the centre.
// S0: probeRadius is the ring the last figure was taken for, so a figure left over from another ring shows.
StubViewer.prototype.liveAimProbability = function (shell, count) { this.probes = (this.probes || 0) + 1; this.lastProbeCount = count; this.probeRadius = this.liveRadius100; if (count >= 1024) this.fineProbes++; return {low: 42, high: 42, unknown: 0, miss: 3, samples: 1024, damage: 100, damageHigh: 100}; };
// Stage 7: the recorded rings are sampled too. Three different damages, so the panel line says which
// ring it belongs to without being asked: 100 HP = 25 % for the live ring and the emulated shot,
// 200 = 50 % for the recorded client reticle, 300 = 75 % for the nominal estimate. Of a 400 HP shell.
StubViewer.prototype.savedAimProbability = function () { return {low: 40, high: 40, unknown: 0, miss: 0, samples: 256, damage: 200, damageHigh: 200}; };
StubViewer.prototype.estimateAimProbability = function () { return {low: 60, high: 60, unknown: 0, miss: 0, samples: 256, damage: 300, damageHigh: 300}; };
// The recorded rings are on screen unless something took them away: a pinned point, or the user's own
// first shot. The real viewer reads aimGroup.visible, which is set by exactly those two.
StubViewer.prototype.savedAimShown = function () { return (!!this.savedAim || !!this.estimateAim) && !this.recordedHidden && !this.pinned; };
// S0: no shell, no line - as viewer.js answers it. A hit opened on "Pick a shell" (several matches, none
// resolved) used to get a line here without a shell and throw in shotStats, which the real page never does.
StubViewer.prototype.shotProbability = function (shell) { return shell ? {chance: 42, reason: 'penetration', layers: [], nominal: 100, effective: 120, angle: 20} : null; };
// The page logs a verdict line per resolved point of the hit on screen. The stub has no engine, so it has
// nothing to say - but it must say it with a list: since 22.09 a hit whose shell the record does not name
// still gets an assumed one, so this path is reached for hits that used to have no shell at all.
StubViewer.prototype.pointVerdicts = function () { return []; };
StubViewer.prototype.hideSpread = function () {};
StubViewer.prototype.configure = function () {};
StubViewer.prototype.showSavedAim = function () {};
StubViewer.prototype.drawLiveAim = function () { return null; };
StubViewer.prototype.heightRange = function () { return [0, 3]; };
// viewer-batch (24.09, VIEW-03): the shot range - camera to the hit point - is the viewer's one figure; the stub has no
// point, so it is its distance, and the Distance slider and field set it.
StubViewer.prototype.shotRange = function () { return this.distance; };
StubViewer.prototype.setShotRange = function (value) { this.distance = value; };
StubViewer.prototype.cameraGliding = function () { return typeof this.targetDistance === 'number' || !!this.dragging; };
// The real Viewer.clear() - and therefore load() - drops the Hitmarks with everything else it holds,
// so the stub must too, or a scene rebuilt under the same vehicle would keep them twice over.
StubViewer.prototype.clear = function () { this.marks = []; };
StubViewer.prototype.load = function () { this.marks = []; return false; };
StubViewer.prototype.setShotContext = function () { return false; }; StubViewer.prototype.setAimEstimate = function () { return null; };
StubViewer.prototype.kick = function () {}; StubViewer.prototype.unpin = function () {};
StubViewer.prototype.wireframe = function () {};
StubViewer.prototype.setOutline = function () {}; StubViewer.prototype.setDots = function () {};
StubViewer.prototype.estimateSpread = function () { return {low: 1, high: 1, unknown: 0, miss: 0, samples: 1024, damage: 0, damageHigh: 0}; };
let viewerInstance = null;
// Any viewer method this harness has not spelled out is a no-op: the aim path is what is under test,
// and the camera, the paint and the pose are three.js work that cannot run here anyway.
const VIEWER_NOOPS = [];
function stubViewer() {
  const target = new StubViewer();
  return new Proxy(target, {
    get: function (obj, key) {
      if (key in obj || typeof key === 'symbol') return obj[key];
      if (VIEWER_NOOPS.indexOf(key) < 0) VIEWER_NOOPS.push(key);
      return function () { return undefined; };
    },
    set: function (obj, key, value) { obj[key] = value; return true; }
  });
}
global.ArmorViewer = function () { viewerInstance = stubViewer(); return viewerInstance; };
global.ArmorViewer.points = function () { return []; };
global.ArmorViewer.verdicts = function () { return []; };
const D0 = Math.PI / 180;
const AIM_BLOCK = {
  dispersion: 0.00383, aimingTime: 2.0, turretRotationFactor: 0.09 / D0, afterShotFactor: 4.0,
  movementFactor: 0.19 / 0.27778, rotationFactor: 0.19 / D0,
  turretRotationSpeed: 30 * D0, hullRotationSpeed: 24 * D0,
  speedForward: 50 * 0.27778, speedBackward: 20 * 0.27778,
  multFactor: 1, additiveFactor: 1, aimingTimeFactor: 1,
  reloadTime: 10, reloadTimeFactor: 1, clip: [1, 0]
};
// Stage 9: the recorder writes what a vehicle may mount (exporter.py fitment_block), and the aim
// configuration offers only the devices whose <vehicleFilter> this vehicle passes. A tier-X German
// heavy that carries the Class 1 eligibility tags, so the Class 2 and Class 3 bands must stay off the
// menu. `supplySlots` is deliberately ABSENT: that is the older record the page has to cope with, and
// it is what makes the page ask which of the three slots carries a category instead of assuming one.
const VEHICLE = {
  id: 'test_vehicle', type: 'germany:Test', name: 'Test vehicle', level: 10, 'class': 'heavyTank',
  nation: 'germany', role: 'role_HT_break', exportedAt: 1, parts: [], shells: [], warnings: [],
  gunDispersion: 0.00383, aim: AIM_BLOCK,
  tags: ['germany', 'heavyTank', 'tankRammer_class1_user', 'aimingStabilizer_class1_user',
         'improvedVentilation_class1_user', 'improvedVentilation_class2_user', 'extraHealthReserve_class1_user']
};
global.ArmorInspectorData = {
  index: function () { return Promise.resolve({application: 'local.armor_inspector', battles: [], version: 'test'}); },
  battle: function () { return Promise.reject(new Error('no battle')); },
  vehicles: function () { return Promise.resolve({vehicles: [VEHICLE]}); },
  vehicle: function (id) { return id === VEHICLE.id ? Promise.resolve(VEHICLE) : Promise.reject(new Error('no vehicle')); },
  scene: function () { return Promise.reject(new Error('no scene')); },
  sceneFor: function (battle, hit) { return Promise.resolve({hit: hit, models: {}, warnings: []}); }
};
global.BullbaHost = {game: false, interrupted: null, guard: function (a, fn) { return fn; }, done: function () {},
  canSend: function () { return false; }, send: function () { return Promise.reject(new Error('no channel')); },
  mark: function () {}, params: function () { return {vehicle: VEHICLE.id}; }};
window.BullbaHost = global.BullbaHost;
// Stage 8: the shooter's gun has a shell list of its own, so the gun panel beside the Shooter tile has
// something to draw. Three shells, as a real gun has: AP, APCR and a MODERN HE of an ability gun (the
// client gives modern HE an icon of its own, and an ability-gun shell wears the ✦ of the heading list).
const SHELLS = [
  {kind: 'ARMOR_PIERCING', name: 'AP shell', caliber: 120, penetration100: 250, penetration500: 230,
   alpha: 400, gunInstallation: 0, gun: '120 mm test'},
  {kind: 'ARMOR_PIERCING_CR', name: 'APCR shell', caliber: 120, penetration100: 300, penetration500: 270,
   alpha: 400, gunInstallation: 0, gun: '120 mm test'},
  {kind: 'HIGH_EXPLOSIVE', name: 'HE shell', caliber: 120, penetration100: 60, penetration500: 60,
   alpha: 500, mechanics: 'MODERN', gunInstallation: 1, gun: '120 mm ability'}
];
global.ArmorShotContext = {resolve: function () { return {choices: SHELLS, index: -1, kind: 'ARMOR_PIERCING', source: 'stub', aimReason: 'no-snapshot'}; },
  // resolve() is stubbed, but which shell the page assumes when nothing is determined is the real rule.
  assume: new Function('window', fs.readFileSync(path + 'shot-context.js', 'utf8') + ';return window.ArmorShotContext;')({}).assume};
global.ArmorShotTelemetry = {load: function () {}, shots: function () { return []; }};

require(path + 'ballistics.js');
require(path + 'modifiers.js');
// Stage 9: the aim configuration is built out of the client's own catalogue, which the page loads as a
// plain script before app.js. Without it the menu would fall back to an empty one.
require(path + 'equipment.js');
// Crits (22.09): the hit tiles and the verdict line call ArmorCrits, which the page loads before app.js. A copy of
// web/ without it (an older one under BULLBA_WEB) runs the rest of the checks all the same.
try { require(path + 'crits.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
global.ArmorCrits = window.ArmorCrits;
// TTX (23.09): the characteristics panel's arithmetic, loaded before app.js as the page loads it.
try { require(path + 'ttx.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
global.BullbaTtx = window.BullbaTtx;
// In a browser `window.X` and the bare global X are one and the same; here they are not, so the two
// libraries the page loads before app.js are bridged onto the global object by hand.
global.ArmorBallistics = window.ArmorBallistics;
global.ModifierGroup = window.ModifierGroup;
window.ModifierGroup = window.ModifierGroup;
window.ArmorViewer = global.ArmorViewer;
window.ArmorInspectorData = global.ArmorInspectorData;
window.ArmorShotContext = global.ArmorShotContext;
window.ArmorShotTelemetry = global.ArmorShotTelemetry;
// The Display select has to offer its options, or updateShell reads an empty value.
const mode = document.getElementById('armor-mode'); mode.value = 'damage';
document.getElementById('model-tile').hidden = false;
document.getElementById('penetration').value = '250';
document.getElementById('caliber').value = '120';
document.getElementById('shell-choice').value = 'ARMOR_PIERCING';
document.getElementById('crosshair-style').value = 'cross';
// Stage 11: the Config button's tooltip is the one place the fitted list is left, and the page reaches the
// button through querySelector('summary'), which the stub would answer with a fresh element every time.
const cfgSummary = new Element('summary');
document.getElementById('aim-config').querySelector = function (sel) { return sel === 'summary' ? cfgSummary : new Element('div'); };
// The popover's body really is inside the <details> in the markup, and since 22.09 that matters: the document
// click handler reads the click's own path and asks whether the popover is in it.
document.getElementById('aim-config').appendChild(document.getElementById('aim-config-body'));
document.getElementById('app-version').setAttribute('data-version', 'dev');
// Stage 8: the mode is ON BY DEFAULT and its switch is an ordinary Settings -> Scene checkbox, so it is
// the settings machinery that turns the emulation on at startup - no line of app.js does it any more.
// The page finds its controls with `.settings-menu .settings-content` + querySelectorAll, which this
// stub cannot resolve, so the one control under test is registered by hand here. `checked` and
// `defaultChecked` are what the markup's `checked` attribute gives a real browser.
const settingsBox = document.querySelector('.settings-menu .settings-content');
const onBox = document.getElementById('aim-on');
onBox.type = 'checkbox'; onBox.checked = true; onBox.defaultChecked = true;
settingsBox.querySelectorAll = function (sel) { return sel === 'input[id],select[id]' ? [onBox] : []; };
// The pressed state of every shell control on the page is set in one pass over [data-shell]: the chips
// of the heading list and the icons of the gun panel are both marked there, which is what keeps them in
// step. The stub resolves that one selector over the two containers that hold them.
// 24.09 (scene-one-path): the page's static help dots, laid from index.html after app.js has run (below).
const staticDots = [];
document.querySelectorAll = function (sel) {
  if (sel === '[data-help-for]') return staticDots.slice();
  // S0: the document click handler closes every open .toolbar-more popover the click did not come from;
  // the Config popover is the one of them this harness drives.
  if (sel === '.toolbar-more[open]') return byId['aim-config'] && byId['aim-config'].open ? [byId['aim-config']] : [];
  // Crits (22.09): the side panel's two mode buttons, so that a check can go back to Battles, where the poll reloads.
  if (sel === '#sidebar-mode [data-mode]') return sidebarModes;
  // 24.09: the list's two scopes, so the path matrix can list a vehicle that is not in the battle (a row without a model).
  if (sel === '#vehicle-scope [data-scope]') return scopeButtons;
  if (sel !== '[data-shell]') return [];
  const out = [];
  ['shell-quick', 'aim-gun-shells'].forEach(function (id) {
    (byId[id] ? byId[id].children : []).forEach(function (c) { if (c.dataset && c.dataset.shell !== undefined) out.push(c); });
  });
  return out;
};

const sidebarModes = ['battles', 'vehicles'].map(function (m) { const e = new Element('button'); e.setAttribute('data-mode', m); return e; });
const scopeButtons = ['battle', 'all'].map(function (m) { const e = new Element('button'); e.setAttribute('data-scope', m); return e; });
let failures = 0, thrown = [];
process.on('uncaughtException', function (e) { thrown.push(e); });
function ok(name, cond, extra) {
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}
// Strip (23.09): a press the gun refused pulses the indicator in the way (data-balk, 1 or 2) - which ones do now.
function balked() {
  return ['aim-gun-load', 'aim-gun-mag', 'aim-gun-heat', 'aim-gun-mech'].filter(function (id) {
    const v = document.getElementById(id).getAttribute('data-balk'); return v === '1' || v === '2';
  }).join(',');
}

// ---- run the module ---------------------------------------------------------------------------
// A throw here would otherwise be swallowed by the uncaughtException handler above and the process
// would end silently, which is exactly the failure this harness exists to show.
let moduleError = null;
// 24.09 (scene-one-path): the scene painters of app.js are COUNTED as it runs - the path matrix at the end asks that
// each runs once per scene, whatever path put the scene on screen. The source is compiled as it stands with one
// counter call at the head of each of those functions and nothing else changed. A painter that is asked while a
// scene is still being built returns at once (its first line, `if (sceneBuild) return;`): the counter stands after
// that line, so what is counted is a painter that did its work.
const PAINTERS = ['sceneTiles', 'sceneShown', 'shotStats', 'updateAim', 'paintFun', 'funModel', 'ttxPaint', 'modsVisible', 'renderFocus', 'renderHits'];
const paints = {}, painterHeads = {};
window.__paint = function (name) { paints[name] = (paints[name] || 0) + 1; };
function loadCounted(file) {
  const Module = require('module');
  const src = fs.readFileSync(file, 'utf8').replace(/\n  function (\w+)\(([^)]*)\) ?\{(\s*if ?\(sceneBuild\) ?return;)?/g, function (m, name) {
    if (PAINTERS.indexOf(name) < 0) return m;
    painterHeads[name] = (painterHeads[name] || 0) + 1;
    return m + 'window.__paint(\'' + name + '\');';
  });
  const mod = new Module(file, module);
  mod.filename = file; mod.paths = module.paths;
  mod._compile(src, file);
}
try { loadCounted(path + 'app.js'); } catch (e) { moduleError = e; }
ok('web/app.js runs to the end outside a browser', !moduleError, moduleError ? String(moduleError.stack) : '');
ok('scene-one-path: every painter the path matrix counts is ONE function of app.js, counted at its head',
   PAINTERS.every(function (n) { return painterHeads[n] === 1; }), JSON.stringify(painterHeads));
// web/tooltips.js runs after app.js, as the page loads it - with NO MutationObserver here, so the help dots stand
// only by the scene finisher's BullbaTips.refresh(): the path matrix shows that every path calls it. The markup's
// parent chains are laid from index.html onto the stub's elements - parentNode only, `children` untouched, so no
// other check sees another tree; an element the page itself has put somewhere keeps its place.
const pageMarkup = fs.readFileSync(path + 'index.html', 'utf8');
const htmlRoot = new Element('html');
document.documentElement = htmlRoot; document.head = new Element('head');
(function layMarkup() {
  const VOID = /^(input|img|br|meta|link|hr|source|area|base|col|embed|param|track|wbr)$/;
  const body = pageMarkup.slice(pageMarkup.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '');
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, els = [htmlRoot], names = ['html'];
  let m;
  while ((m = tag.exec(body))) {
    const name = m[2].toLowerCase(), attrs = m[3];
    if (m[1]) { const at = names.lastIndexOf(name); if (at > 0) { els.length = at; names.length = at; } continue; }
    const id = (/\sid="([^"]*)"/.exec(attrs) || [])[1], help = (/\sdata-help-for="([^"]*)"/.exec(attrs) || [])[1];
    let el;
    if (id) el = document.getElementById(id);
    else {
      el = new Element(name);
      if (help !== undefined) { el.setAttribute('data-help-for', help); el.className = 'help-dot'; staticDots.push(el); }
    }
    if (!el.parentNode) el.parentNode = els[els.length - 1];
    if (!VOID.test(name) && !/\/\s*$/.test(attrs)) { els.push(el); names.push(name); }
  }
}());
let tipsError = null;
try { require(path + 'tooltips.js'); } catch (e) { tipsError = e; }
let tipRefreshes = 0;
if (window.BullbaTips && window.BullbaTips.refresh) {
  const own = window.BullbaTips.refresh;
  window.BullbaTips.refresh = function () { tipRefreshes++; return own.apply(this, arguments); };
}
ok('scene-one-path: web/tooltips.js runs beside it and takes the page’s eight static help dots (the circle tiles’ one since 24.09)',
   !tipsError && staticDots.length === 8 && !!(window.BullbaTips && window.BullbaTips.refresh),
   tipsError ? String(tipsError.stack) : '(' + staticDots.length + ' dots)');
// Since 22.09 the page keeps listeners of its own on the document from the start (the slider under the
// cursor takes the wheel and the arrows), so the aim mode's handlers are counted against that baseline.
// 24.09: web/tooltips.js now runs here as in the page, and its Escape (one keydown on the document) is part of the baseline.
const baseKeys = 2;   // the slider's own keydown and the tooltips' Escape; the aim mode adds its pair on top of them
ok('the slider handlers are on the document from the start',
   document.listenerCount('keydown') >= baseKeys && document.listenerCount('wheel') === 1
   && document.listenerCount('pointerover') === 1 && document.listenerCount('pointerout') === 1,
   '(' + document.listenerCount('keydown') + ')');
const view = viewerInstance;
ok('the viewer was built', !!view);

// ---- stage 7: one colour rule for every ring --------------------------------------------------
// Nothing in this harness draws, so the rule is read off the source of viewer.js: all four STANDING
// rings (client reticle, server reticle, nominal estimate, the ring an emulated shot leaves) take the
// one magenta constant, and the live ring alone keeps the cyan. The three old colours are gone.
const viewerSrc = fs.readFileSync(path + 'viewer.js', 'utf8');
ok('every standing ring takes the one magenta constant',
   /var AIM_RING=0xff5ad6;/.test(viewerSrc)
   && /AIM_FIXED=\{color:AIM_RING/.test(viewerSrc)
   && /ring\(context\.aim\.clientMarker,AIM_RING,false,gun\)/.test(viewerSrc)
   && /ring\(server,AIM_RING,true,/.test(viewerSrc)
   && /LineDashedMaterial\(\{color:AIM_RING/.test(viewerSrc)
   // the shot ring of an own shot (24.09): a thick long-dashed band whose colour the Settings lab sets (the user's default
   // hsl(180, 100 %, 80 %), blue and magenta presets), drawn by its own shader
   && /SHOT_RING_LOOK=\{color:\[\.6,1,1\]/.test(viewerSrc) && /new THREE\.ShaderMaterial\(\{vertexShader:SHOT_RING_VERTEX/.test(viewerSrc));
ok('and the live ring is the only cyan one left',
   /AIM_LIVE=\{color:0x5ee0ff/.test(viewerSrc)
   && viewerSrc.indexOf('0x68d7be') < 0 && viewerSrc.indexOf('0xeac36e') < 0
   && viewerSrc.indexOf('0x79cfff') < 0);
// The controls that sit INSIDE the viewport must not be dragged or pinned through: viewer.js lets a
// pointerdown on one of them alone, and the gun panel of stage 8 took the deleted switch's place there.
// TTX (23.09): and on the characteristics panel in the bottom-right corner. Strip (23.09): and on the strip beside ⌖.
ok('the viewer leaves a press on the gun panel, the strip beside ⌖, the characteristics panel and the tiles band (circle tiles, their ?, the ⚠; 24.09) to the panels themselves',
   /closest\('\.viewport-tile,\.viewport-tiles,\.mod-slot,\.swap-roles,\.aim-gun,\.fun-strip,\.aim-drive,#aim-config,\.ttx-panel'\)/.test(viewerSrc)
   && viewerSrc.indexOf('aim-switch') < 0);
// Settings left the scene heading for the header row (user, 20.09): the Statistics log status first, the
// menu in the corner. Read off the markup, since this harness's querySelector is a stub.
const pageSrc = fs.readFileSync(path + 'index.html', 'utf8');
const appSrc = fs.readFileSync(path + 'app.js', 'utf8');
const header = pageSrc.slice(pageSrc.indexOf('<header>'), pageSrc.indexOf('</header>'));
ok('Settings sits in the header row, after the Statistics log status',
   header.indexOf('<details class="settings-menu">') > header.indexOf('id="connection"')
   && pageSrc.slice(pageSrc.indexOf('<div class="scene-heading">')).indexOf('settings-menu') < 0);
ok('and the heading layout no longer measures it',
   fs.readFileSync(path + 'app.js', 'utf8').indexOf(".scene-heading .settings-menu") < 0);
// The impact cross has an opacity of its own in Settings -> Scene (user, 20.09), 10..100 %; the default is
// 90 since 22.09 - at 50 the cross was hard to see, and a store still holding that old default is migrated.
ok('the impact-mark slider is in the settings menu, 10-100 %, default 90',
   /id="impact-opacity" min="10" max="100" value="90"/.test(pageSrc)
   && /<output id="impact-opacity-value">90 %<\/output>/.test(pageSrc)
   && pageSrc.indexOf('Impact mark opacity') > 0);
// S5 (22.09): the Circle figures are tiles of their own, and the word "Circle" is the tile's HEADING - the
// value element under it holds nothing but the figure. Read off the markup: nothing here parses index.html.
ok('each Circle figure is a tile with a "Circle" heading, and the old panel lines are gone',
   /<div class="aim-circle-tile shot" id="shot-circle-tile" hidden><span class="info-title" id="shot-circle-head">Circle<\/span><b class="info-chance" id="shot-circle"><\/b><\/div>/.test(pageSrc)
   && /<div class="aim-circle-tile live" id="probe-circle-tile" hidden><span class="info-title" id="probe-circle-head">Circle<\/span><b class="info-chance" id="probe-circle"><\/b><\/div>/.test(pageSrc)
   && pageSrc.indexOf('class="aim-circle ') < 0);
const impact = document.getElementById('impact-opacity');
impact.type = 'range'; impact.min = '10'; impact.max = '100'; impact.step = '1';   // the page's own control is a range
impact.value = '90';
impact.oninput.call(impact);
ok('and it reaches the viewer as a fraction and prints its own per cent',
   viewerInstance.impact === 0.9 && document.getElementById('impact-opacity-value').textContent === '90 %',
   '(' + viewerInstance.impact + ')');
impact.value = '20';
impact.oninput.call(impact);
ok('moving it applies live', viewerInstance.impact === 0.2, '(' + viewerInstance.impact + ')');
impact.value = '90';
impact.oninput.call(impact);

// The wheel and the arrows on the slider under the cursor (user, 22.09): no click to focus it first, one
// notch is one step of the slider's own, a trackpad's small deltas add up to one, and the scene must not
// zoom or turn under the hand - so the page takes the event in the capture phase and stops it.
function wheelAt(target, deltaY, mode) {
  const e = {target: target, deltaY: deltaY, deltaX: 0, deltaMode: mode || 0,
    stopped: false, prevented: false,
    preventDefault: function () { this.prevented = true; },
    stopPropagation: function () { this.stopped = true; }};
  document.fire('wheel', e);
  runNamed('flushInput');
  return e;
}
function keyAt(key) {
  const e = {key: key, target: document.body, stopped: false, prevented: false,
    preventDefault: function () { this.prevented = true; },
    stopPropagation: function () { this.stopped = true; }};
  document.fire('keydown', e);
  return e;
}
const notch = wheelAt(impact, -100);
// 24.09 evening (user): one notch is one step of the control - the wheel is for the fine value, dragging for the coarse.
ok('a wheel notch over a slider moves it by one step of its own and is kept from the scene',
   impact.value === '91' && viewerInstance.impact === 0.91 && notch.prevented && notch.stopped,
   '(' + impact.value + ')');
wheelAt(impact, 100);
ok('and the other way back', impact.value === '90', '(' + impact.value + ')');
[-25, -25, -25].forEach(function (d) { wheelAt(impact, d); });
ok('a trackpad glide under a notch does not move it yet', impact.value === '90', '(' + impact.value + ')');
wheelAt(impact, -25);
ok('and moves it one notch once the glide adds up to a notch', impact.value === '91', '(' + impact.value + ')');
const elsewhere = wheelAt(new Element('div'), -100);
ok('a wheel away from any slider is left alone', !elsewhere.prevented && !elsewhere.stopped && impact.value === '91');
// 24.09 (user: the wheel stalls and slips; the number box should take it too): a number box steps like a
// slider, an empty one (a manual figure not typed yet) is left alone, notches inside one frame redraw the
// control once, 'change' comes once when the turn is over, and the settings are written once after it.
(function () {
  const box = new Element('input'); box.type = 'number'; box.min = '3'; box.max = '1000'; box.step = '1'; box.value = '50';
  let inputs = 0, changes = 0; box.addEventListener('input', function () { inputs++; }); box.addEventListener('change', function () { changes++; });
  const e1 = wheelAt(box, -100);
  ok('a wheel notch over a number box steps it like a slider', box.value === '51' && e1.prevented && inputs === 1, '(' + box.value + ', ' + inputs + ')');
  const empty = new Element('input'); empty.type = 'number'; empty.min = '1'; empty.max = '3000'; empty.step = '1'; empty.value = '';
  const e2 = wheelAt(empty, -100);
  ok('an empty number box is left to the page', empty.value === '' && !e2.prevented);
  inputs = 0; changes = 0;
  ['-100', '-100', '-100'].forEach(function (d) { document.fire('wheel', {target: box, deltaY: Number(d), deltaX: 0, deltaMode: 0, preventDefault: function () {}, stopPropagation: function () {}}); });
  const moved = box.value;
  runNamed('flushInput');
  ok('three notches in one frame move the value at once and redraw the control once', Number(moved) > 51 && inputs === 1 && changes === 0, '(' + moved + ', ' + inputs + ', ' + changes + ')');
  runNamed('flushChange');
  ok('and the turn ends with one change', changes === 1, '(' + changes + ')');
})();
document.fire('pointerover', {target: impact});
keyAt('ArrowUp');
ok('an arrow over a slider steps it by its own step', impact.value === '92', '(' + impact.value + ')');
const down = keyAt('ArrowLeft');
ok('and the other arrow back, kept from the camera', impact.value === '91' && down.prevented && down.stopped, '(' + impact.value + ')');
document.activeElement = impact;
keyAt('ArrowUp');
ok('a focused slider is left to the browser', impact.value === '91', '(' + impact.value + ')');
document.activeElement = null;
document.fire('pointerout', {target: impact});
keyAt('ArrowUp');
ok('and the arrows do nothing once the cursor has left it', impact.value === '91', '(' + impact.value + ')');
const coarse = new Element('input');
coarse.type = 'range'; coarse.min = '0'; coarse.max = '150'; coarse.step = '5'; coarse.value = '145';
wheelAt(coarse, -100);
ok('a slider of its own step moves by that step', coarse.value === '150', '(' + coarse.value + ')');
wheelAt(coarse, -100);
ok('and stops at its end', coarse.value === '150', '(' + coarse.value + ')');
const off = new Element('input');
off.type = 'range'; off.min = '0'; off.max = '100'; off.value = '50'; off.disabled = true;
const dead = wheelAt(off, -100);
ok('a disabled slider takes nothing', off.value === '50' && !dead.prevented);

// 24.09 (user: the wheel over a slider "sometimes responsive, sometimes it sticks"; over the scene it is smooth): the
// run that grew the step with the pace of the notches and fell back after a pause is gone - the game's browser
// delivers the wheel in bursts, so it reset at random. Every notch is the same share of the scale, as on the scene.
const spin = new Element('input');
spin.type = 'range'; spin.min = '0'; spin.max = '1000'; spin.step = '1'; spin.value = '0';
const spun = [];
for (let i = 0; i < 6; i++) { wheelAt(spin, -100); spun.push(Number(spin.value)); }
ok('every notch of a turn moves one step, whatever the pace',
   spun.join(',') === '1,2,3,4,5,6', '(' + spun.join(',') + ')');
clock += 0.5;
wheelAt(spin, -100);
ok('a pause changes nothing about the next notch', spin.value === '7', '(' + spin.value + ')');
wheelAt(spin, 100);
ok('the other direction is one notch back', spin.value === '6', '(' + spin.value + ')');
wheelAt(spin, -300);
ok('a fast spin folded into one event counts its notches', spin.value === '9', '(' + spin.value + ')');
const tiny = new Element('input');
tiny.type = 'range'; tiny.min = '0'; tiny.max = '20'; tiny.step = '1'; tiny.value = '0';
for (let i = 0; i < 8; i++) wheelAt(tiny, -100);
ok('a short scale still moves at least its own step a notch', tiny.value === '8', '(' + tiny.value + ')');
// Zoom's step is below one whole: the minimal step must still be exactly that step, and a grown one must
// not drift off the grid (7 × 0.1 is 0.7000000000000001 in plain arithmetic).
const fine = new Element('input');
fine.type = 'range'; fine.min = '0'; fine.max = '10'; fine.step = '0.1'; fine.value = '0';
wheelAt(fine, -100);
ok('a step below one whole moves by exactly that step', fine.value === '0.1', '(' + fine.value + ')');
wheelAt(fine, -100); wheelAt(fine, -100); wheelAt(fine, -100);
ok('and stays on the slider’s own grid', fine.value === '0.4', '(' + fine.value + ')');
// The arrows are a deliberate press each: they keep the minimal step whatever the wheel was doing.
document.fire('pointerover', {target: fine});
keyAt('ArrowUp'); keyAt('ArrowUp'); keyAt('ArrowUp');
ok('the arrow keys never grow their step', fine.value === '0.7', '(' + fine.value + ')');
document.fire('pointerout', {target: fine});

impact.value = '90';
impact.oninput.call(impact);


// Everything below waits for the vehicle scene to arrive (the page opens it from the fragment), then
// drives the emulation the way a user would: the switch, the keys, a slider, a click, the reload.
function settle(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 8); i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}
// Run the frame loop for `seconds` at 60 Hz, as the browser would.
function run(seconds) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) tick(1 / 60);
}
// TTX panel v2 (23.09): the rows of the characteristics panel sit in sections (a rule, the reload line, grids, lines),
// so they are found by walking the tree. ttxRowsIn: every row (the one widget, r.ttx) under an element, in order;
// ttxLineOf: the parts of a reload line - [{side, key, text, title, cmp, glyph}] in their order.
function ttxRowsIn(el, out) {
  out = out || [];
  (el.children || []).forEach(function (c) { if (c.ttx) out.push(c); else ttxRowsIn(c, out); });
  return out;
}
function ttxFind(el, test, out) {
  out = out || [];
  (el.children || []).forEach(function (c) { if (test(c)) out.push(c); ttxFind(c, test, out); });
  return out;
}
// The parts by side, left, centre, right - the compact view lays its sides in another order for its two columns (24.09).
const SIDE_ORDER = ['left', 'center', 'right'];
function ttxLineOf(line) {
  const out = [];
  if (!line) return out;
  line.children.slice().sort(function (a, b) { return SIDE_ORDER.indexOf(a.getAttribute('data-side')) - SIDE_ORDER.indexOf(b.getAttribute('data-side')); }).forEach(function (side) {
    side.children.forEach(function (r) {
      out.push({side: side.getAttribute('data-side'), key: r.getAttribute('data-key'), text: r.ttx.value.textContent, title: r.title,
                cmp: r.getAttribute('data-cmp'), glyph: r.ttx.glyph});
    });
  });
  return out;
}

const viewport = document.getElementById('viewport');
const config = document.getElementById('aim-config');
// Stage 8: the gun panel stands where the mode's switch used to - the shells of this gun as icons, and
// the load state the way the in-game reticle shows it.
const gun = document.getElementById('aim-gun');
const gunShells = document.getElementById('aim-gun-shells');
const gunReload = document.getElementById('aim-gun-reload');
// clip-indicator (22.09 ~24:15): the clip's text "2/3" became the magazine - a row of slots, one per round, whose
// state is the data-s of each (on, next, wait, off, fill) and whose fill is the transform of the slot's inner mark;
// more than twelve rounds make one bar. magStates() reads the row, magFills() the fills of the loading slots.
const gunMag = document.getElementById('aim-gun-mag');
function magStates() { return gunMag.children.map(function (c) { return c.getAttribute('data-s'); }).join(','); }
function magFills() {
  return gunMag.children.map(function (c) {
    const m = /scale[XY]\(([\d.]+)\)/.exec(c.children[0].style.transform || '');
    return m ? Number(m[1]) : null;
  });
}
// The icon file each shell tile asks for, and the text badge's label beside it (the page falls back to
// the badge when the mod has not unpacked that icon yet).
function shellIcons() {
  return gunShells.children.map(function (b) {
    const img = b.children[0].children[0];
    // web/icons since 20.09: the icons ship with the page instead of being unpacked from the client.
    return String(img.src || '').replace('web/icons/', '').replace('data/icons/', '').replace('.png', '');
  }).join(',');
}
function shellPressed() {
  return gunShells.children.map(function (b) { return b.getAttribute('aria-pressed'); }).join(',');
}
function chipPressed() {
  return document.getElementById('shell-quick').children.map(function (b) { return b.getAttribute('aria-pressed'); }).join(',');
}
// Stage 6: the figures live on the two info panels, one line each, and the speed tile sits beside the
// Shooter tile. `probeCircle` is the LIVE ring (cyan, "Under the cursor"), `shotCircle` the ring the
// last shot left behind (magenta, pinned-shot panel).
const probeCircle = document.getElementById('probe-circle');
const shotCircle = document.getElementById('shot-circle');
// S5 (22.09): each figure sits in a tile of its own at the right edge of its panel's row. The value element
// keeps the id and takes the figure alone; the tile takes the hidden flag, the ring's colour class and the
// tooltip, and its heading holds the word "Circle" the value used to carry.
const probeTile = document.getElementById('probe-circle-tile');
const shotTile = document.getElementById('shot-circle-tile');
const drive = document.getElementById('aim-drive');
const speed = document.getElementById('aim-speed');
// Stage 7: the keycaps are a 2x3 glyph beside the speed and light up while their key is held, and the
// turn arc says which way the hull is coming round and how fast.
const caps = {forward: document.getElementById('aim-key-forward'), left: document.getElementById('aim-key-left'),
              back: document.getElementById('aim-key-back'), right: document.getElementById('aim-key-right')};
const turn = document.getElementById('aim-turn');
const turnArc = document.getElementById('aim-turn-arc');
const turnHead = document.getElementById('aim-turn-head');
function capsDown() { return Object.keys(caps).filter(function (k) { return caps[k].getAttribute('data-down') !== null; }).sort().join(','); }
// The two flags of the SVG arc: large-arc (the span passed 180 deg) and sweep (1 = clockwise = D).
function turnFlags() { const m = /A8 8 0 (\d) (\d)/.exec(turnArc.getAttribute('d') || ''); return m ? m[1] + m[2] : ''; }
// Every id stage 5 or stage 6 deleted from the page. They are still asked for on purpose: the stub hands
// out an empty element for an unknown id, so anything written back into them would show up as text.
const hud = document.getElementById('aim-hud');
const hudChance = document.getElementById('aim-hud-chance');
const hudDamage = document.getElementById('aim-hud-damage');
const hudShot = document.getElementById('aim-hud-shot');
const hudCap = document.getElementById('aim-hud-cap');
const hudState = document.getElementById('aim-hud-state');
const legend = document.getElementById('armor-legend');
const legendCaption = document.getElementById('legend-caption');
// A field on the page: a key typed into it is text, never driving.
const field = new Element('input');
const block = document.getElementById('aim-block');
const slots = document.getElementById('aim-cfg-slots');
const picker = document.getElementById('aim-cfg-picker');
const directive = document.getElementById('aim-cfg-directive');
const consumables = document.getElementById('aim-cfg-consumables');
const crew = document.getElementById('aim-cfg-crew');
// Layers (22.09): a sub-panel - the equipment picker, the directive picker, the preset list - opens OVER the
// popover on a scrim of its own, and the element it belongs to is lifted out of the scrim and lit. `picker` is
// the panel's content, `layer` the panel, `scrim` what lies over the sections, `cfgMain` the sections
// themselves (the scrolling box the popover now holds instead of scrolling itself).
const layer = document.getElementById('aim-cfg-layer');
const scrim = document.getElementById('aim-cfg-scrim');
const cfgBody = document.getElementById('aim-config-body');
function cfgMain() { return cfgBody.children[0]; }
// The preset control is a button that names the entry in force; the <select>, the three action buttons, the
// name row and the warning line of 0.7.20 are gone with it.
const preset = document.getElementById('aim-cfg-preset');
// Config's own "?" (23.09): at the end of the preset row, inside the popover - the help mode (web/tooltips.js) reaches
// its tiles from there; the shooter row's dot is outside, and a click there closes the popover.
{
  const top = preset.parentNode, dot = top && top.children[1];
  ok('config help: the preset row ends in Config\'s own help dot - the page\'s one dot (helpDotFor), listing Config for its summary, inside the popover',
     !!top && top.className === 'aim-config-top' && top.children[0] === preset && top.children.length === 2 && !!dot && dot.tagName === 'BUTTON'
     && dot.className === 'help-dot' && dot.type === 'button' && dot.getAttribute('data-help-for') === 'aim-config' && dot.getAttribute('aria-label') === 'Help'
     && dot.textContent === '?' && top.parentNode === cfgMain().children[0] && cfgMain().children[0].className === 'aim-config-grid');
}
function presetName() { return preset.textContent; }
function presetOpen() { return preset.getAttribute('aria-expanded') === 'true'; }
function presetRows() { return layer.hidden || picker.children.length === 0 ? [] : picker.children[0].children; }
function rowName(row) { const c = row.children[0]; return c.tagName === 'INPUT' ? null : c.textContent; }
function rowNames() { return presetRows().map(rowName).join(','); }
function presetRow(name) { return presetRows().filter(function (r) { return rowName(r) === name; })[0]; }
function rowAct(row, act) { return row.children.filter(function (c) { return c.getAttribute('data-act') === act; })[0]; }
function rowField(row) { return row.children[0].tagName === 'INPUT' ? row.children[0] : null; }
function openPresets() { if (!presetOpen()) click(preset); }
// A click on a row puts the entry in force; a preset of the user's own keeps the list up for the length of a
// double-click (it is renamed by one), so the clock is run on past it.
function choosePreset(name) {
  openPresets();
  const row = presetRow(name);
  click(row.children[0]);
  if (!layer.hidden) tick(0.6);
}
// The row whose name is open for typing, and the four things a user does to such a field.
function editingRow() { return presetRows().filter(function (r) { return !!rowField(r); })[0]; }
function typeName(field, text) { field.value = text; field.oninput.call(field); }
function keyEvent(name) { return {key: name, preventDefault: function () {}, stopPropagation: function () {}}; }
function commitName(field) { field.onkeydown.call(field, keyEvent('Enter')); }
function cancelName(field) { field.onkeydown.call(field, keyEvent('Escape')); }
// A browser fires blur when the focus really leaves a field that is still on the page; a field a repaint took
// away is not one the user left, and the page tells the two apart by isConnected.
function blurName(field) { field.isConnected = true; field.onblur.call(field); }
// Everything the sub-panel itself prints, its whole subtree walked: no heading of its own anywhere in it -
// the lit element it belongs to is the heading (user, 22.09: graphics over text).
function panelWords() { return tileWords(layer); }
// A click as the browser delivers it: the element's own handler first - which repaints the menu and takes that
// element out of the page - and then the SAME event at the document, whose handler closes every popover the
// click did not come from. composedPath() is taken when the dispatch starts, so it still names the popover.
function clickThrough(el) {
  const path = [];
  for (let e = el; e; e = e.parentNode) path.push(e);
  let stopped = false;
  const event = {target: el, detail: 1, composedPath: function () { return path; },
                 stopPropagation: function () { stopped = true; }, preventDefault: function () {}};
  if (el.onclick) el.onclick.call(el, event);
  if (!stopped) document.fire('click', event);
}
// Stage 10 (21.09): the picker is one .aim-picker box - an empty tile, then a quiet heading and a dense
// row of tiles per GRADE (Standard, Bounty, Improved, Experimental), not per family. A tile carries the
// device icon with its grade badge over the corner and NOT ONE WORD: the item's garage name is the
// tile's accessible label and everything else is in the tooltip, so that is what the harness reads.
function pickBox() { return picker.children[0]; }
function pickPart(cls) { return pickBox().children.filter(function (c) { return c.className === cls; }); }
function pickGrades() { return pickPart('aim-pick-grade').map(function (c) { return c.textContent; }); }
function pickTiles() {
  const out = [];
  pickPart('aim-pick-row').forEach(function (row) { row.children.forEach(function (t) { out.push(t); }); });
  return out;
}
function tileTier(tile) { return tile.getAttribute('data-tier'); }
// fieldmods (23.09): the empty slot's own tile, the one tile of the picker's first row (class aim-pick-clear).
function clearTile() { const r = pickBox() && pickBox().children[0]; return r && r.className === 'aim-pick-row aim-pick-clear' ? r.children[0] : null; }
function tileName(tile) { return tile.getAttribute('aria-label'); }
// The tile's art box: the device icon first, the grade badge over its corner second, and nothing else.
function iconOf(tile) { return tile.children[0]; }
function pick(name) { return pickTiles().filter(function (t) { return tileName(t) === name; })[0]; }
// Every character the tile itself would draw, the whole subtree walked: it has to come out empty.
function tileWords(el) {
  let out = String(el.textContent || '');
  el.children.forEach(function (c) { out += tileWords(c); });
  return out;
}
function allTiles() {
  return pickTiles().concat(slots.children, directive.children, consumables.children[0].children,
                            crewChips());
}
// What the interface PRINTS or reads out - the grade headings and the tiles' own labels - never the
// tooltips, which quote the client's entry ids (trophyUpgradedTankRammer and friends) on purpose.
function pickerLabels() {
  return pickTiles().map(tileName).concat(pickGrades()).join('\n');
}
function crewChips() {
  const out = [];
  crew.children.forEach(function (c) {
    if (c.className === 'aim-chips') c.children.forEach(function (chip) { out.push(chip); });
  });
  return out;
}
function crewChip(name) { return crewChips().filter(function (c) { return tileName(c) === name; })[0]; }
const CREW_ORDER = ['Commander', 'Gunner', 'Driver', 'Loader', 'Radio Operator'];
function biaMarks() {
  return CREW_ORDER.map(function (r) {
    const chip = crewChip('Brothers in Arms, ' + r);
    return chip ? chip.getAttribute('aria-pressed') : '-';
  }).join(',');
}
// S4: the second page, started with the store the first run left behind. It has to come back on the vehicle's
// Custom entry with the build the user made by hand, and with every preset he saved - from the store alone.
function reloadChecks() {
  openConfigMenu();
  const tiers = slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',');
  ok('S4 (reload): the page comes back on the vehicle’s Custom entry',
     presetName() === RELOAD_WANT.name, '(' + presetName() + ')');
  ok('S4 (reload): with the build the user made by hand - slots, directive and crew',
     tiers === RELOAD_WANT.tiers && biaMarks() === RELOAD_WANT.bia
     && directive.children[0].getAttribute('data-tier') === RELOAD_WANT.dir,
     '(' + tiers + ' / ' + biaMarks() + ' / ' + directive.children[0].getAttribute('data-tier') + ')');
  openPresets();
  ok('S4 (reload): and his presets are all there, Custom first',
     rowNames() === RELOAD_WANT.rows, '(' + rowNames() + ')');
}
const FULL_AIM = 0.383 / 1.043;   // dispersion 0.00383 rad at 100 m, divided by the trained crew factor

// A click on the Settings checkbox: the browser runs the property handler AND the shared listener the
// settings machinery attached, which is what writes the value to storage.
function switchOn(on) { onBox.checked = on; onBox.onchange.call(onBox); onBox.fire('change', {}); }
function storedValues() { return (JSON.parse(savedSettings() || '{}') || {}).values || {}; }
// S4 review (22.09): Custom is a build PER VEHICLE TYPE - a hand build belongs to the gun it was made for, and
// one Custom shared by every shooter would be written over by the next edit made on another vehicle - so the
// store holds it under the type's own key.
function storedAim() { return (JSON.parse(savedSettings() || '{}') || {}).aim || {}; }
function storedCustom(type) { return (storedAim().custom || {})[type || 'germany:Test'] || null; }
function click(el) { el.onclick.call(el, {stopPropagation: function () {}}); }
// S2: the user's click on the Config button (its <summary>): the page's own listener runs as the browser would
// run it, before the popover opens. See the equipment section below.
function openConfigMenu() { cfgSummary.fire('click', {}); }
// The three pointer events the real viewer sends, in the order and with the bookkeeping viewer.js does:
// a press that the page claims sets aimHold (so the emulation is not paused for it), a move past the drag
// threshold takes the press away again, and the release is handed back only to a press still held.
function press() { const view = viewerInstance; view.dragging = true; if (view.onShotDown && view.onShotDown({})) view.aimHold = true; }
// A move past the drag threshold, with viewer.js's stage-5 rule: the press is handed to the drag only if
// the page lets it go. A burst already firing refuses (false), keeps the press and goes on shooting.
// Returns true when the press really did become a drag.
function dragAway() {
  const view = viewerInstance;
  if (!view.aimHold) return false;
  if (view.onShotCancel && view.onShotCancel({}) === false) { view.dragging = false; return false; }
  view.aimHold = false;
  return true;
}
function release() { const view = viewerInstance; const hold = view.aimHold; view.aimHold = false; view.dragging = false; if (hold && view.onShotUp) view.onShotUp({}); }
// The gun's cooldown in seconds, read off the FILL of the live ring after `seconds` of it have run: the
// page prints the reload nowhere any more, which is the point of stage 5.
function cooldownFromFill(seconds) { return seconds / viewerInstance.reloadPart; }

settle(20).then(function () {
  // The layout debounce of the load, not ours. S2: it is RUN rather than dropped - a dropped frame left the
  // page's debounce waiting for ever, so no later layout pass ran here at all and nothing could be counted.
  const loadFrames = rafQueue; rafQueue = [];
  loadFrames.forEach(function (f) { if (/layoutHeading/.test(String(f.fn))) f.fn(clock * 1000); });
  ok('the shooter scene loaded', document.getElementById('shooter-tile').hidden === false);
  if (RELOAD) return reloadChecks();

  // ---- stage 8: the mode is on by default, and its switch is a Settings control ------------------
  ok('the emulation is ON by default', onBox.checked === true && drive.hidden === false && config.hidden === false);
  // The switch element of stage 7 is gone from the scene; asking for its id hands out an empty stub, so
  // anything still written into it would show up here.
  ok('nothing is written into the deleted switch beside the Shooter tile',
     document.getElementById('aim-switch').textContent === ''
     && document.getElementById('aim-switch').children.length === 0);
  ok('the key handlers went on the document at startup, without anybody ticking anything',
     document.listenerCount('keydown') === baseKeys + 1 && document.listenerCount('keyup') === 1);
  ok('the bottom block is hidden while nothing asks for the fallback', block.hidden === true);
  // Off and on again through the checkbox, to see that the Settings control really is the switch.
  switchOn(false);
  ok('unticking the Settings checkbox takes the whole mode away',
     drive.hidden === true && config.hidden === true && gun.hidden === true
     && document.listenerCount('keydown') === baseKeys);
  ok('and it is stored as an ordinary setting value, not in the preset store',
     storedValues()['aim-on'] === false
     && (JSON.parse(savedSettings()).aim || {}).on === undefined,
     '(' + JSON.stringify(storedValues()) + ')');
  switchOn(true);
  ok('ticking it back on shows the speed tile, the gun panel and the configuration',
     drive.hidden === false && config.hidden === false && gun.hidden === false);
  ok('and the stored value follows', storedValues()['aim-on'] === true);
  ok('the bottom strip stays away', block.hidden === true);

  // ---- stage 8: the gun panel beside the Shooter tile -------------------------------------------
  ok('the gun panel carries one icon per shell of this gun', gunShells.children.length === 3,
     '(' + gunShells.children.length + ')');
  ok('each icon is the client’s own file for that shell type, modern HE included',
     shellIcons() === 'ARMOR_PIERCING,ARMOR_PIERCING_CR,HIGH_EXPLOSIVE_MODERN', '(' + shellIcons() + ')');
  ok('the ability-gun shell wears the ✦ of the heading list, and it alone',
     gunShells.children.map(function (b) { return b.children.length; }).join(',') === '1,1,2');
  ok('the tooltip of an icon names the shell, its type, its penetration and its alpha',
     gunShells.children[0].title === 'AP shell\nOne of the gun’s shells: pressed, the scene and the ⌖ shots use it.\n• Type: AP\n• Penetration: 250 mm\n• Damage: 400 HP\n\n• Click: use this shell',
     '(' + gunShells.children[0].title + ')');
  ok('the first AP shell is the one selected, on the icons and on the heading chips alike',
     shellPressed() === 'true,false,false' && chipPressed() === 'true,false,false',
     '(' + shellPressed() + ' / ' + chipPressed() + ')');
  // Clicking an icon goes through the page's own selectShell(), exactly as a heading chip does, so the
  // two lists are never out of step and the whole page changes shell with them.
  click(gunShells.children[1]);
  ok('clicking an icon selects that shell for the whole page',
     document.getElementById('shell-choice').value === 'saved:1'
     && Number(document.getElementById('penetration').value) === 300,
     '(' + document.getElementById('shell-choice').value + ')');
  ok('and the heading list moves with it', shellPressed() === 'false,true,false' && chipPressed() === 'false,true,false',
     '(' + shellPressed() + ' / ' + chipPressed() + ')');
  // The other way round: the heading chip is the same call, so the icons follow it.
  click(document.getElementById('shell-quick').children[0]);
  ok('picking a shell in the heading list moves the icons',
     shellPressed() === 'true,false,false' && chipPressed() === 'true,false,false',
     '(' + shellPressed() + ')');
  // The load state: no burst runs, so the panel reads the gun's OWN reload time and nothing about a clip.
  ok('at rest the panel reads the gun’s reload time as a static figure',
     /^\d+\.\d s$/.test(gunReload.textContent) && Number(gunReload.textContent.split(' ')[0]) > 8
     && gunReload.getAttribute('data-running') === '0',
     '(' + gunReload.textContent + ')');
  ok('and a single-shot gun shows ONE slot, loaded and marked as the round to fire - no clip text any more',
     gunMag.hidden === false && magStates() === 'next' && gunMag.children[0].className === 'aim-mag-slot'
     && /^Loaded\n• Reload: \d+(\.\d)? s(\n|$)/.test(gunMag.title), '(' + magStates() + ' / ' + gunMag.title.slice(0, 40) + ')');
  // Stage 6: the keys hang on the DOCUMENT, so they drive before the viewport has ever been clicked.
  ok('the key handlers are attached to the document, not to the viewport',
     document.listenerCount('keydown') === baseKeys + 1 && document.listenerCount('keyup') === 1
     && viewport.listenerCount('keydown') === 0);
  ok('the viewer is in emulation mode', view.emulation === true);
  ok('but the battle’s own reticles and tracers are still on screen', view.recordedHidden === false);
  ok('a circle is on screen at the full-aim radius', Math.abs(view.liveRadius100 - FULL_AIM) < 1e-6,
     '(' + view.liveRadius100.toFixed(4) + ' m at 100 m)');
  // No shell is on screen yet, so neither panel has a figure to print.
  ok('neither circle tile is on until there is a shell and a ring to measure',
     probeTile.hidden === true && probeCircle.textContent === ''
     && shotTile.hidden === true && shotCircle.textContent === '');
  const liveTileAwayWithNoFigure = probeTile.hidden === true;
  ok('the speed tile reads a standing vehicle', speed.textContent === '0 km/h', '(' + speed.textContent + ')');
  ok('no keycap is lit and no turn arc is drawn while the shooter stands',
     capsDown() === '' && turn.hidden === true, '(' + capsDown() + ')');
  ok('nothing is written into the deleted corner readout at all',
     hud.textContent === '' && hudChance.textContent === '' && hudDamage.textContent === ''
     && hudShot.textContent === '' && hudCap.textContent === '' && hudState.textContent === '');
  ok('and nothing is written into the deleted legend either',
     legend.textContent === '' && legendCaption.textContent === '' && legend.hidden === false);
  ok('nothing is looping while the shooter stands still', loopFrames() === 0);

  // ---- driving ---------------------------------------------------------------------------------
  // The keys reach the emulation without the viewport ever having been focused or clicked.
  document.fire('keydown', {code: 'KeyW', key: 'w', target: document.body, preventDefault: function () {}});
  ok('a key starts the loop with no click in the scene first', loopFrames() === 1);
  run(2.5);
  const wide = view.liveRadius100;
  ok('two and a half seconds of W widens the circle', wide > 0.9, '(' + wide.toFixed(3) + ' m at 100 m)');
  ok('and the speed tile counts up, signed', Number(speed.textContent.split(' ')[0]) > 20,
     '(' + speed.textContent + ')');
  ok('the W cap is lit while it is held, and it alone, with no arc on a straight run',
     capsDown() === 'forward' && turn.hidden === true, '(' + capsDown() + ')');
  // A key typed into a field is text: the page must not drive on it.
  document.fire('keydown', {code: 'KeyA', key: 'a', target: field, preventDefault: function () {}});
  run(0.5);
  ok('a key typed into a field never drives: the hull never turned and its cap stayed dark',
     view.turned.length === 0 && capsDown() === 'forward',
     '(' + view.turned.length + ' hull steps, caps ' + capsDown() + ')');

  // ---- a drag pauses everything ----------------------------------------------------------------
  view.dragging = true;
  const held = view.liveRadius100, chasedBefore = view.chased;
  view.gap = 40 * Math.PI / 180;
  run(2);
  ok('a drag freezes the circle and the turret', view.liveRadius100 === held && view.chased === chasedBefore,
     '(' + view.liveRadius100.toFixed(3) + ')');
  ok('the loop is kept alive so it can resume', loopFrames() === 1);
  view.dragging = false;
  view.gap = 0;
  run(0.5);
  ok('the drag over, the emulation runs on from the same state', view.liveRadius100 > held * 0.98);

  // ---- braking, as in the game: S stops a forward run before it reverses ------------------------
  // Read straight off the model, where it is deterministic: the page's own frame loop is the same
  // moveStep() called once per frame.
  const MOVE_AIM = {speedForward: 50 * 0.27778, speedBackward: 20 * 0.27778, hullRotationSpeed: 24 * D0};
  let st = null;
  for (let i = 0; i < 300; i++) st = window.ArmorBallistics.moveStep(st, {forward: true}, MOVE_AIM, {}, 1 / 60);
  const rolling = st.speed;
  ok('five seconds of W reach the top speed', Math.abs(rolling - MOVE_AIM.speedForward) < 1e-6,
     '(' + (rolling / 0.27778).toFixed(1) + ' km/h)');
  let crossed = -1, braked = 0;
  for (let i = 0; i < 300 && crossed < 0; i++) {
    st = window.ArmorBallistics.moveStep(st, {back: true}, MOVE_AIM, {}, 1 / 60);
    braked = i + 1;
    if (st.speed < 0) crossed = i;
    else if (st.speed === 0) crossed = i;
  }
  ok('S brakes a forward run down to a standstill first, it never jumps through zero',
     st.speed === 0 && braked > 30, '(' + braked + ' frames to a stop)');
  st = window.ArmorBallistics.moveStep(st, {back: true}, MOVE_AIM, {}, 1 / 60);
  // From a standstill the reverse ramps at speedBackward/accelBack (3 s), not at the brake rate.
  ok('and only then does the reverse accelerate, at its own rate',
     st.speed < 0 && Math.abs(st.speed + MOVE_AIM.speedBackward / 3 / 60) < 1e-9,
     '(' + (st.speed / 0.27778).toFixed(2) + ' km/h after one frame)');
  let stw = null;
  for (let i = 0; i < 120; i++) stw = window.ArmorBallistics.moveStep(stw, {back: true}, MOVE_AIM, {}, 1 / 60);
  const reversing = stw.speed;
  for (let i = 0; i < 300 && stw.speed < 0; i++) stw = window.ArmorBallistics.moveStep(stw, {forward: true}, MOVE_AIM, {}, 1 / 60);
  ok('W brakes a reversing vehicle to a stop the same way', reversing < 0 && stw.speed === 0,
     '(' + (reversing / 0.27778).toFixed(1) + ' km/h -> ' + stw.speed + ')');

  document.fire('keyup', {code: 'KeyW', key: 'w', target: document.body, preventDefault: function () {}});
  run(25);
  ok('letting go stops the vehicle and the circle settles back',
     Math.abs(view.liveRadius100 - FULL_AIM) < 1e-6 && loopFrames() === 0,
     '(' + view.liveRadius100.toFixed(4) + ')');
  ok('and the speed tile is back to zero', speed.textContent === '0 km/h', '(' + speed.textContent + ')');

  // ---- the hull carries the gun, the turret chases back ----------------------------------------
  view.turned = [];
  view.gap = 0;
  const chasedHull = view.chased;
  document.fire('keydown', {code: 'KeyD', key: 'd', target: document.body, preventDefault: function () {}});
  // Stage 7: the arc GROWS with the turn rate. The hull needs half a second to reach its top rotation
  // speed, so a twentieth of a second in the sweep is still short (under 180 deg, large-arc flag 0) and
  // by the end of the second it is the full 270 (flag 1). The sweep flag is 1 both times: D is clockwise.
  run(0.05);
  const arcEarly = turnFlags();
  ok('D lights its own cap and starts a short clockwise arc',
     capsDown() === 'right' && turn.hidden === false && arcEarly === '01', '(' + arcEarly + ')');
  run(0.95);
  ok('and the arc grows to the full sweep at the hull’s top rotation speed',
     turnFlags() === '11' && (turnHead.getAttribute('d') || '').length > 10, '(' + turnFlags() + ')');
  ok('holding D swings the aim point around the shooter every frame',
     view.turned.length > 50 && view.turned.every(function (a) { return a > 0; }),
     '(' + view.turned.length + ' steps, ' + (view.turned.reduce(function (s, a) { return s + a; }, 0) * 180 / Math.PI).toFixed(1) + ' deg)');
  ok('and the turret chases it back towards the crosshair', view.chased > chasedHull && view.gap < 0.05,
     '(' + (view.gap * 180 / Math.PI).toFixed(2) + ' deg left)');
  const turningRing = view.liveRadius100;
  ok('turning the hull blooms the circle', turningRing > FULL_AIM * 1.2,
     '(' + turningRing.toFixed(4) + ')');
  document.fire('keyup', {code: 'KeyD', key: 'd', target: document.body, preventDefault: function () {}});
  run(25);
  view.turned = [];
  view.gap = 0;
  run(1);
  ok('a standing hull moves nothing', view.turned.length === 0 && loopFrames() === 0);
  ok('and a hull at rest draws no arc and lights no cap', turn.hidden === true && capsDown() === '');
  // ---- BACKLOG 40: the shooter's horizontal sector reaches the chase ------------------------------
  // The block in force carries gun.turretYawLimits for a turretless tank destroyer or a limited turret; the page hands
  // the pair to both the gap and the chase, and nothing for a turret that turns all the way round - or for a pair that
  // spans the whole circle, which nine turrets carry (-180 180).
  const yawCases = [[[-0.0524, 0.0524], 'pair'], [[-Math.PI, Math.PI], null], [undefined, null], [[0.1, -0.1], null], [['a', 1], null]];
  const yawSeen = yawCases.map(function (c) {
    if (c[0] === undefined) delete AIM_BLOCK.turretYawLimits; else AIM_BLOCK.turretYawLimits = c[0];
    view.gapLimits = 'unset'; view.chaseLimits = 'unset'; view.gap = 5 * Math.PI / 180; view.onAimMove(); run(0.1);
    return {gap: view.gapLimits, chase: view.chaseLimits, want: c[1] === 'pair' ? c[0] : null};
  });
  delete AIM_BLOCK.turretYawLimits;
  run(25); view.gap = 0;
  ok('sector: a limited gun hands its turretYawLimits to the gap and the chase, a full circle or no pair hands none',
     yawSeen.every(function (s) { return s.gap === s.want && s.chase === s.want; }),
     '(' + yawSeen.map(function (s) { return JSON.stringify(s.gap) + '/' + JSON.stringify(s.chase); }).join(', ') + ')');
  // A is the other way round: the arc sweeps counter-clockwise (sweep flag 0) and the aim swings the
  // other way with it.
  document.fire('keydown', {code: 'KeyA', key: 'a', target: document.body, preventDefault: function () {}});
  run(0.6);
  ok('A lights its own cap and sweeps the arc counter-clockwise',
     capsDown() === 'left' && turn.hidden === false && turnFlags() === '10'
     && view.turned[view.turned.length - 1] < 0, '(' + turnFlags() + ')');
  document.fire('keyup', {code: 'KeyA', key: 'a', target: document.body, preventDefault: function () {}});
  run(25);
  view.turned = [];
  view.gap = 0;

  // ---- stage 7: the RECORDED ring of the hit prints its own figure too --------------------------
  // The hit-line panel builds its own shell, and a manual one carries no alpha at all: every shell is
  // given the 400 HP a recorded one would have, or the line could only say "Circle —" (stage 6's rule
  // for an unknown alpha), which is not what is under test here.
  const plainShell = window.ArmorBallistics.shell;
  window.ArmorBallistics.shell = function (k, p, c) { const s = plainShell(k, p, c); s.alpha = 400; return s; };
  // onPin is the page's own "the pinned line changed, read the panel again" callback: the cheapest
  // honest way to ask for a fresh reading of the hit-line panel.
  view.savedAim = {};
  view.onPin(false);
  tick(0.2);
  ok('the recorded client reticle prints its own figure on the hit-line panel',
     shotTile.hidden === false && shotCircle.textContent === '50 %',
     '(' + shotCircle.textContent + ')');
  ok('and the tooltip says which ring that is',
     shotTile.title.indexOf('reticle as the fire key was pressed') >= 0 && shotTile.title.indexOf('share of the shell') >= 0);
  view.savedAim = null; view.estimateAim = {radius: 0.5};
  view.onPin(false);
  tick(0.2);
  ok('a hit with no reticle of its own prints the figure of its nominal ring instead',
     shotTile.hidden === false && shotCircle.textContent === '75 %',
     '(' + shotCircle.textContent + ')');
  ok('and says in the tooltip that the ring, and the figure with it, is the estimate',
     shotTile.title.indexOf('no recorded reticle') >= 0
     && shotTile.title.indexOf('Nominal full-aim circle') === 0);
  view.estimateAim = null; view.savedAim = {};
  view.onPin(false);
  tick(0.2);
  ok('back on the recorded reticle again', shotCircle.textContent === '50 %',
     '(' + shotCircle.textContent + ')');

  // ---- BACKLOG 28 step 2 (24.09): the shot ring of an own shot (a filled disc first: the internal names stay) -------
  // The figure is sampled over the disc and the tile names it; a disc one server tick stale puts the ⚠ beside the tile,
  // which goes with the rings (a pin) and with the disc (the Settings switch); a ring without a disc has none.
  const staleIcon = document.getElementById('shot-disc-stale'), discBox = document.getElementById('shot-ring'), discSlider = document.getElementById('shot-ring-opacity');
  ok('shot disc: no ⚠ on a recorded ring without a disc', staleIcon.hidden !== false);
  view.ringAim = {kind: 'saved'}; view.discAim = {kind: 'fired', stale: true, gap: 1.89, q: .5, from: 'last'}; view.savedAim = view.discAim;
  view.onPin(false); tick(0.2);
  ok('shot disc: the figure is the disc\'s and the tile says so', shotTile.title.indexOf('Shot circle') === 0 && shotCircle.textContent === '50 %', '(' + shotTile.title.slice(0, 40) + ')');
  ok('shot disc: a stale disc shows the ⚠, whose words give the tick and how far off', staleIcon.hidden === false
     && staleIcon.title.indexOf('one tick uncertain') >= 0 && staleIcon.title.indexOf('1.89 m') >= 0 && staleIcon.title.indexOf('outside their ring') >= 0);
  view.pinned = {point: {}}; view.onPin(true); tick(0.2);
  ok('shot disc: a pinned point takes the ⚠ away with the rings', staleIcon.hidden === true);
  view.pinned = null; view.onPin(false); tick(0.2);
  ok('shot disc: unpinned, the ⚠ is back', staleIcon.hidden === false);
  ok('shot disc: a single shot of an old record: the vehicle moved, newer builds usually make it exact',
     staleIcon.title.indexOf('the vehicle moved 1.89 m') >= 0 && staleIcon.title.indexOf('newer builds') >= 0 && staleIcon.title.indexOf('salvo') < 0);
  // Review 24.09: a salvo's gap is from the middle of its barrels, never the vehicle's move; a record whose updates after
  // the shot were kept and none matched is not promised what newer builds give.
  const single = view.discAim;
  view.discAim = Object.assign({}, single, {salvo: 2, gap: 1.2, afterRecorded: true}); view.savedAim = view.discAim; view.onPin(false); tick(0.2);
  ok('shot disc: a stale salvo is measured from the middle of its barrels, and kept updates that did not match are said so',
     staleIcon.hidden === false && staleIcon.title.indexOf('middle of this salvo’s 2 barrels') >= 0 && staleIcon.title.indexOf('vehicle moved') < 0
     && staleIcon.title.indexOf('do not match its origin either') >= 0 && staleIcon.title.indexOf('newer builds') < 0);
  view.discAim = single; view.savedAim = single; view.onPin(false); tick(0.2);
  discBox.checked = false; discSlider.value = '20'; discBox.onchange(); tick(0.2);
  ok('shot disc: the Settings switch off tells the viewer, greys the slider, and the ⚠ goes; the figure takes the solid ring',
     view.discOn === false && discSlider.disabled === true && staleIcon.hidden === true && view.savedAim === view.ringAim && shotTile.title.indexOf('Recorded aiming circle') === 0);
  discBox.checked = true; discBox.onchange(); discSlider.value = '35'; discSlider.oninput(); tick(0.2);
  ok('shot disc: on again, the slider hands its opacity to the viewer', view.discOn === true && view.discOpacity === .35 && staleIcon.hidden === false
     && document.getElementById('shot-ring-opacity-value').textContent === '35 %' && discSlider.disabled === false);
  view.discAim = Object.assign({}, view.discAim, {stale: false, from: 'after'}); view.savedAim = view.discAim; view.onPin(false); tick(0.2);
  ok('shot disc: a disc made exact by the update after the tracer shows no ⚠', staleIcon.hidden === true);
  discSlider.value = '20'; discSlider.oninput();
  view.discAim = null; view.ringAim = null; view.savedAim = {}; view.onPin(false); tick(0.2);
  // ---- shot-line-true (24.09): the game's oddities of a hit, two marks on the hit-line panel's title row ----------------
  // From the viewer's shotPath and shooterHeight: the pose mark only above 0.5 m between the recorded point and the server's,
  // the height mark only when the viewer says the shooter is far enough below the tracks (below); both go with the recorded line (a pin) and come back; their
  // own help dot; words with the figures.
  const poseMark = document.getElementById('pose-gap'), heightMark = document.getElementById('shooter-height');
  let heightNow = null; view.recordedShown = function () { return !this.pinned; }; view.shooterHeight = function () { return heightNow; };
  view.shotPath = {gap: .45, along: .44, angle: .004, turned: 0}; heightNow = {grid: -.3, world: .5, tilt: -.8, angle: .02, below: false}; view.onPin(false); tick(0.2);
  ok('hit marks: 0.45 m apart and the shooter only 0.3 m below the tracks - no mark', poseMark.hidden === true && heightMark.hidden === true);
  view.shotPath = {gap: .84, along: .8, angle: .05, turned: .04}; heightNow = {grid: -2.4, world: .6, tilt: -3, angle: .07, below: true}; view.onPin(false); tick(0.2);
  ok('hit marks: 0.84 m apart - the pose mark, whose words give the gap, the hull and the turn', poseMark.hidden === false
     && poseMark.title.indexOf('Pose diverged: 0.84 m') === 0 && poseMark.title.split('\n')[1].indexOf('0.84 m from where the game drew it') >= 0
     && poseMark.title.indexOf('Along the hull: 0.80 m (it was moving)') >= 0 && poseMark.title.indexOf('about 2.9°') >= 0, '(' + poseMark.title.split('\n')[0] + ')');
  ok('hit marks: the shooter 2.4 m below the tracks - the height mark with its figure; the lean and the world in its words',
     heightMark.hidden === false && document.getElementById('shooter-height-value').textContent === '2.4 m'
     && heightMark.title.indexOf('Shooter below the tracks: 2.4 m') === 0 && heightMark.title.indexOf('All of it is this vehicle’s lean (4.0°): in the world the shooter stood 0.6 m higher than its base') >= 0
     && heightMark.title.indexOf('Dashed square') >= 0, '(' + heightMark.title.split('\n').slice(0, 4).join(' | ') + ')');
  heightNow = {grid: -2.4, world: -1, tilt: -1.4, angle: .07, below: true}; view.shotPath = Object.assign({}, view.shotPath); view.onPin(false); tick(0.2);
  ok('hit marks: the shooter really lower - the world part and what the lean adds, never more than the whole',
     heightMark.title.indexOf('In the world: the shooter stood 1.0 m lower than this vehicle’s base') >= 0 && heightMark.title.indexOf('lean (4.0°) adds 1.4 m') >= 0,
     '(' + heightMark.title.split('\n').slice(2, 4).join(' | ') + ')');
  ok('hit marks: their own help dot, listing both', document.getElementById('hit-marks').children.some(function (c) {
    return String(c.getAttribute ? c.getAttribute('data-help-for') : c.attributes['data-help-for']) === 'pose-gap shooter-height'; }));
  view.pinned = {point: {}}; view.onPin(true); tick(0.2);
  ok('hit marks: a pinned point takes both away with the recorded line', poseMark.hidden === true && heightMark.hidden === true);
  view.pinned = null; view.onPin(false); tick(0.2);
  ok('hit marks: unpinned, they are back', poseMark.hidden === false && heightMark.hidden === false);
  view.shotPath = null; view.onPin(false); tick(0.2);
  ok('hit marks: no tracer (no shotPath) - no marks', poseMark.hidden === true && heightMark.hidden === true);
  delete view.recordedShown; delete view.shooterHeight;
  // Ring axes (the lab's switch, 24.09): the checkbox tells the viewer; off by default.
  const axesBox = document.getElementById('ring-axes'); let axesOn = null; view.setRingAxes = function (on) { axesOn = on; };
  ok('ring axes: off by default', axesBox.checked === false);
  axesBox.checked = true; axesBox.onchange();
  ok('ring axes: the switch tells the viewer', axesOn === true);
  axesBox.checked = false; axesBox.onchange(); delete view.setRingAxes;
  // View from (the lab, 24.09): the select tells the viewer (its default and storage: real_page.cjs).
  const viewFrom = document.getElementById('view-from'); let fromNow = null; view.setViewFrom = function (m) { fromNow = m; };
  viewFrom.value = 'gun'; viewFrom.onchange();
  ok('view from: the pick tells the viewer', fromNow === 'gun');
  viewFrom.value = 'fired'; viewFrom.onchange(); delete view.setViewFrom;
  // The TEMPORARY Shot ring lab: sliders to the viewer (colour as hue/saturation/lightness in sRGB), tracks painted for the
  // hue, the two presets set the three colour sliders, its own help dot.
  const lab = function (id, value) { const el = document.getElementById(id); el.value = String(value); (el.oninput || el.onchange).call(el); };
  lab('ring-hue', 218); lab('ring-sat', 100); lab('ring-light', 62); lab('ring-width', 9); lab('ring-dashes', 8); lab('ring-share', 70);
  document.getElementById('ring-place').value = 'centre'; document.getElementById('ring-place').onchange();
  const lk = view.ringLook || {}, rgb255 = (lk.color || []).map(function (x) { return Math.round(x * 255); });
  ok('ring lab: the sliders hand the viewer its look (hsl 218/100/62 = the blue 61,132,255; 9 px; 8 dashes of 70 %; centred)',
     rgb255.join() === '61,132,255' && lk.width === 9 && lk.dashes === 8 && lk.share === .7 && lk.place === .5, JSON.stringify(lk));
  ok('ring lab: the saturation and lightness tracks show the colours of this hue',
     String(document.getElementById('ring-sat').style.background).indexOf('hsl(218,100%,62%)') >= 0
     && String(document.getElementById('ring-light').style.background).indexOf('hsl(218,100%,50%)') >= 0);
  document.getElementById('ring-preset-magenta').onclick();
  ok('ring lab: the magenta chip sets the three colour sliders to the outlines\' magenta',
     document.getElementById('ring-hue').value === '315' && document.getElementById('ring-light').value === '68'
     && (view.ringLook.color || []).map(function (x) { return Math.round(x * 255); }).join() === '255,92,214');
  document.getElementById('ring-preset-blue').onclick();
  ok('ring lab: its own help dot lists the lab\'s controls', document.getElementById('ring-lab-help').children.some(function (c) {
    return String(c.getAttribute ? c.getAttribute('data-help-for') : c.attributes['data-help-for']).indexOf('ring-hue') >= 0; }));
  lab('ring-width', 6); lab('ring-dashes', 12); lab('ring-share', 80); document.getElementById('ring-place').value = 'inside'; document.getElementById('ring-place').onchange();

  // ---- a shell chosen BY HAND carries the shooter's own alpha (user, 22.09) ---------------------
  // Until now ArmorBallistics.shell() gave a manual shell no alpha at all, so every Circle line read
  // "Circle —" the moment the user picked a type by hand - which is why the block above has to lend the
  // stub one. A manual shell is still a shell of the SAME shooter, so the damage side is taken from his
  // own shell of that type; only a record whose shells carry no alpha at all falls back to the
  // penetration chance over the circle.
  const savedChoice = document.getElementById('shell-choice').value;
  const manualPick = function (kind) {
    const sel = document.getElementById('shell-choice');
    sel.value = kind; sel.onchange.call(sel);
    view.onPin(false); tick(0.2);
  };
  window.ArmorBallistics.shell = plainShell;   // the real one, with no alpha of its own
  manualPick('ARMOR_PIERCING');
  ok('manual: a hand-picked type takes the alpha of the shooter’s own shell of that type',
     shotTile.hidden === false && shotCircle.textContent === '50 %',
     '(' + shotCircle.textContent + ')');
  ok('manual: and the shell line says whose alpha it is',
     document.getElementById('shell-choice').title.indexOf('\n• Alpha: of the shooter’s AP shell') > 0,
     '(' + document.getElementById('shell-choice').title.slice(0, 60) + ')');
  ok('manual: the tooltip of the figure is the ordinary share-of-alpha one',
     shotTile.title.indexOf('share of the shell') >= 0);
  // The alpha field (user, 22.09): a third number beside the penetration and the calibre.
  const alphaField = document.getElementById('alpha');
  ok('manual: the alpha field is prefilled from the shooter\u2019s own shell of that type',
     Number(alphaField.value) === 400, '(' + alphaField.value + ')');
  alphaField.value = '800'; alphaField.oninput.call(alphaField);
  view.onPin(false); tick(0.2);
  ok('manual: editing the alpha moves the damage figure with it',
     shotCircle.textContent === '25 %', '(' + shotCircle.textContent + ')');
  alphaField.value = '400'; alphaField.oninput.call(alphaField);
  view.onPin(false); tick(0.2);
  // A record whose shells carry no alpha (before 0.7.13) and no alpha typed either: nothing to borrow, so
  // the circle prints the mean penetration chance instead of a dash, and says why.
  const keptAlphas = SHELLS.map(function (s) { return s.alpha; });
  SHELLS.forEach(function (s) { s.alpha = 0; });
  manualPick('ARMOR_PIERCING_CR');
  alphaField.value = ''; alphaField.oninput.call(alphaField);
  manualPick('ARMOR_PIERCING');
  alphaField.value = ''; alphaField.oninput.call(alphaField);
  view.onPin(false); tick(0.2);
  ok('manual: with no alpha anywhere in the record the circle prints the penetration chance',
     shotTile.hidden === false && shotCircle.textContent === '40 %',
     '(' + shotCircle.textContent + ')');
  ok('manual: and the tooltip says that is what it is',
     shotTile.title.indexOf('penetration chance over the circle') >= 0
     && shotTile.title.indexOf('share of the shell') < 0, '(' + shotTile.title.slice(-90) + ')');
  SHELLS.forEach(function (s, i) { s.alpha = keptAlphas[i]; });
  // A SAVED shell keeps its own alpha and its damage figure, as it always did.
  manualPick('saved:0');
  ok('manual: a saved shell is untouched and keeps its damage figure',
     shotCircle.textContent === '50 %'
     && document.getElementById('shell-choice').title.indexOf('Alpha: of the shooter') < 0,
     '(' + shotCircle.textContent + ')');
  ok('manual: and the alpha field mirrors that saved shell\u2019s own alpha',
     Number(alphaField.value) === 400, '(' + alphaField.value + ')');
  window.ArmorBallistics.shell = function (k, p, c) { const s = plainShell(k, p, c); s.alpha = 400; return s; };
  // ---- the recorded ring is not touched when only the probe distance moves (user, 22.09) ---------
  // The magenta ring belongs to a shot that was fired at its OWN range; the Distance slider is the live
  // probe's. Moving it used to change the shell in the tile's key (penetration at the new range), which
  // blanked the tile for 100 ms and sent the 256 rays out again for the same answer.
  view.recordedDistance = 250; view.distance = 100;
  manualPick('saved:0');   // a saved candidate: the only kind whose penetration falls off with range at all
  const recordedFigure = shotCircle.textContent;
  let integrals = 0;
  const realIntegral = StubViewer.prototype.savedAimProbability;
  view.savedAimProbability = function () { integrals++; return realIntegral.apply(this, arguments); };
  view.onPin(false); tick(0.2);
  ok('the recorded ring is read once and not again while nothing of its own has changed',
     integrals === 0 && shotCircle.textContent === recordedFigure && recordedFigure === '50 %',
     '(' + integrals + ' / ' + shotCircle.textContent + ')');
  view.distance = 800;
  view.onPin(false);
  ok('the probe distance moving does not blank the recorded ring’s tile',
     shotTile.hidden === false && shotCircle.textContent === recordedFigure,
     '(' + shotCircle.textContent + ')');
  tick(0.2);
  ok('and does not send its 256 rays out a second time',
     integrals === 0 && shotCircle.textContent === recordedFigure, '(' + integrals + ')');
  // The shot's own range is what the figure IS taken at, so a different one is a different figure.
  view.recordedDistance = 900;
  view.onPin(false); tick(0.2);
  ok('the shot’s own range is what its figure is taken at', integrals === 1, '(' + integrals + ')');
  view.savedAimProbability = realIntegral;
  view.recordedDistance = null; view.distance = 100;
  manualPick(savedChoice);

  // ---- a short press is one shot, and the live ring keeps aiming --------------------------------
  view.shell = {alpha: 400, penetration: 250, kind: 'ARMOR_PIERCING'};
  const aimedRadius = view.liveRadius100;
  press();
  ok('the press alone fires nothing', view.pinnedPoints === 0 && view.shotsDrawn === 0);
  ok('the press is claimed as a shot, not as a drag', view.aimHold === true);
  tick(0.1);
  ok('and still nothing 100 ms in, below the 250 ms hold', view.pinnedPoints === 0);
  ok('and the recorded shot of the battle is still on screen', view.recordedHidden === false);
  release();
  ok('a short press is one shot', view.pinnedPoints === 1 && view.shotsDrawn === 1);
  ok('the first shot is what takes the recorded reticles and tracers away', view.recordedHidden === true);
  // ONE figure per ring, on its own panel (user, 20.09): 100 HP of a 400 HP shell = 25 %.
  ok('the last shot prints its figure on the pinned-shot panel',
     shotTile.hidden === false && shotCircle.textContent === '25 %',
     '(' + shotCircle.textContent + ')');
  // Stage 7: the emulated shot took the recorded ring off the model, so it takes its line too - one
  // figure per ring, and the ring on that line is the one the user is looking at.
  ok('and it replaced the recorded reticle’s figure, as it replaced the ring itself',
     shotTile.title.indexOf('left on the model') >= 0, '(' + shotTile.title + ')');
  ok('and the live ring prints its own on the "Under the cursor" panel',
     probeTile.hidden === false && probeCircle.textContent === '25 %',
     '(' + probeCircle.textContent + ')');
  // S5 (22.09): the whole rule of the live ring's right tile in one line - away while there is no figure,
  // and with a figure the value ALONE, on a tile wearing the live ring's own colour class.
  ok('the live ring’s tile is away with no figure and wears the live colour with one',
     liveTileAwayWithNoFigure && probeTile.hidden === false
     && probeCircle.textContent === '25 %' && probeCircle.textContent.indexOf('Circle') < 0
     && probeTile.className === 'aim-circle-tile live',
     '(' + probeTile.className + ')');
  ok('no percentage is repeated and no alpha in HP is printed anywhere',
     shotCircle.textContent.indexOf('400') < 0 && shotCircle.textContent.indexOf('·') < 0
     && hudChance.textContent === '' && hudDamage.textContent === '' && hudShot.textContent === '');
  ok('the ring left behind was taken before the recoil widened the live one',
     Math.abs(view.shotRing - aimedRadius) < 1e-9, '(' + view.shotRing.toFixed(4) + ')');
  ok('the live ring is NOT frozen: the recoil blew it up', view.liveRadius100 > aimedRadius * 1.5,
     '(' + aimedRadius.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');
  const afterShot = view.liveRadius100;
  run(0.5);
  ok('and it goes on settling while the gun reloads', view.liveRadius100 < afterShot,
     '(' + view.liveRadius100.toFixed(4) + ')');
  ok('a released button leaves the ring whole: the fill shows only while the button is held', view.reloadPart === null,
     '(' + view.reloadPart + ')');
  ok('and nothing about the reload is written anywhere on the page',
     hudState.textContent === '' && shotCircle.textContent === '25 %',
     '(' + hudState.textContent + ')');

  // ---- a new press fires at once: the reload only paces one hold --------------------------------
  press(); tick(0.05); release();
  ok('a press during the reload fires at once', view.pinnedPoints === 2);
  ok('the new shot replaced the ring, it did not add one', view.shotsDrawn === 2);

  // ---- a press that becomes a drag never fires --------------------------------------------------
  press();
  ok('a move before the first round hands the press to the drag', dragAway() === true && view.aimHold === false);
  tick(0.5);
  release();
  ok('a press that turned into a drag fires nothing', view.pinnedPoints === 2);
  run(20);
  ok('the reload over, the ring is whole again and the loop stopped',
     view.reloadPart === null && loopFrames() === 0, '(' + view.reloadPart + ')');

  // ---- holding the button: a burst on the gun's own cooldown ------------------------------------
  press();
  tick(0.3);                             // past the 250 ms hold
  ok('holding fires the first shot at the hold threshold', view.pinnedPoints === 3);
  tick(0.1);
  const cooldown = cooldownFromFill(0.1);
  ok('the cooldown of a single-shot gun is its reload', cooldown > 5, '(' + cooldown.toFixed(1) + ' s)');
  // Stage 8: while the burst is held the panel counts the cooldown down instead of printing the gun's
  // nominal reload, and it is the same cooldown the ring's fill is measured against.
  const counting = Number(gunReload.textContent.split(' ')[0]);
  ok('the panel counts the cooldown down while the burst is held',
     gunReload.getAttribute('data-running') === '1' && Math.abs(counting - (cooldown - 0.1)) < 0.11,
     '(' + gunReload.textContent + ' of ' + cooldown.toFixed(1) + ' s)');
  run(0.5);
  ok('and it keeps counting down, per frame',
     Number(gunReload.textContent.split(' ')[0]) < counting - 0.4, '(' + gunReload.textContent + ')');
  const burstRing = view.shotRing;
  run(cooldown - 0.8);                   // 0.6 s of it is already behind us, and stop 0.2 s short
  ok('nothing leaves before the cooldown is over', view.pinnedPoints === 3);
  run(0.4);
  ok('the next round leaves the moment it is', view.pinnedPoints === 4);
  ok('a ten-second reload leaves time to settle, so the second round is aimed again',
     Math.abs(view.shotRing - burstRing) < 1e-9, '(' + burstRing.toFixed(4) + ' -> ' + view.shotRing.toFixed(4) + ')');

  // ---- stage 5: moving the mouse AIMS the burst, it never stops it ------------------------------
  ok('a move with the burst running keeps the press', dragAway() === false && view.aimHold === true);
  const beforeMove = view.pinnedPoints;
  view.gap = 40 * Math.PI / 180;         // the cursor ran away: the turret has to chase it
  const chasedBeforeMove = view.chased;
  run(cooldown + 0.4);
  ok('the burst fires on through the move', view.pinnedPoints > beforeMove,
     '(' + beforeMove + ' -> ' + view.pinnedPoints + ')');
  ok('and the turret chases the cursor while it fires', view.chased > chasedBeforeMove && view.gap < 40 * Math.PI / 180,
     '(' + (view.gap * 180 / Math.PI).toFixed(1) + ' deg left)');
  const fired = view.pinnedPoints, lastRing = view.shotRing;
  release();
  ok('only letting go stops it, and the last shot stays on screen',
     view.pinnedPoints === fired && view.shotRing === lastRing);
  run(30);
  ok('and nothing fires by itself afterwards', view.pinnedPoints === fired && loopFrames() === 0);
  view.gap = 0;
  run(15);

  // ---- a clip gun: the burst stops when the clip is empty ---------------------------------------
  AIM_BLOCK.clip = [3, 0.5];
  // Stage 8: at rest a clip gun prints its clip SIZE beside the reload time. Nothing has repainted the
  // panel since the clip was given to the gun, so one frame of the loop is asked for.
  view.onAimMove(); tick(1 / 60);
  ok('at rest a clip gun shows its three rounds in the magazine, the last one to fire lit, and its full reload',
     gunMag.hidden === false && magStates() === 'on,on,next'
     && gunReload.getAttribute('data-running') === '0',
     '(' + gunReload.textContent + ' / ' + magStates() + ')');
  const beforeClip = view.pinnedPoints;
  press();
  tick(0.3);
  ok('the hold fires the first round of the clip', view.pinnedPoints === beforeClip + 1);
  const clipFirst = view.shotRing;
  tick(0.1);
  ok('the ring fills over the clip interval too, not over the reload',
     view.reloadPart > 0.1 && view.reloadPart < 0.3, '(' + view.reloadPart.toFixed(3) + ' of the ring)');
  ok('and the panel counts the clip interval down; the magazine has one round spent and the next one waiting out the gap',
     gunReload.getAttribute('data-running') === '1'
     && Number(gunReload.textContent.split(' ')[0]) < 0.5 && magStates() === 'on,wait,off'
     && /^Magazine 2 \/ 3\n• Next round: in 1 s\n/.test(gunMag.title),
     '(' + gunReload.textContent + ' / ' + magStates() + ' / ' + gunMag.title.slice(0, 50) + ')');
  run(0.5);
  ok('the second round leaves at the clip interval, not at the reload', view.pinnedPoints === beforeClip + 2);
  ok('and it is wider: half a second is not enough to settle the recoil out',
     view.shotRing > clipFirst * 1.5, '(' + clipFirst.toFixed(4) + ' -> ' + view.shotRing.toFixed(4) + ')');
  run(0.6);
  ok('the third empties the clip', view.pinnedPoints === beforeClip + 3);
  run(5);
  ok('an empty clip fires nothing more, and nothing is printed about it',
     view.pinnedPoints === beforeClip + 3 && hudState.textContent === '' && hudCap.textContent === '',
     '(' + hudState.textContent + ')');
  ok('the magazine shows it empty - the simplified rule loads nothing back while the hold lasts',
     magStates() === 'off,off,off' && /Simplified \(⌖ or ◔ off\)/.test(gunMag.title), '(' + magStates() + ')');
  release();
  ok('the release leaves it full again, as the next press will find it', magStates() === 'on,on,next', '(' + magStates() + ')');
  press();
  tick(0.3);
  ok('a new press starts from a full clip and fires at once', view.pinnedPoints === beforeClip + 4);
  release();
  AIM_BLOCK.clip = [1, 0];
  run(30);

  // ---- the turret chasing the cursor -----------------------------------------------------------
  view.gap = 60 * Math.PI / 180;
  view.onAimMove();
  ok('a cursor the gun has not reached starts the loop', loopFrames() === 1);
  tick(1 / 60); tick(1 / 60);
  ok('the turret turns towards it', view.chased >= 2 && view.gap < 60 * Math.PI / 180,
     '(' + (view.gap * 180 / Math.PI).toFixed(1) + ' deg left)');
  run(15);
  ok('the gun catches up, the circle settles and the loop stops',
     view.gap < 1e-9 && loopFrames() === 0 && Math.abs(view.liveRadius100 - FULL_AIM) < 1e-6);

  // ---- the equipment slots, the directive, the consumables and the crew -------------------------
  // Stage 10 (21.09): the menu is laid out the way the garage lays it out - four GRADE groups, one
  // tile per device, the tile an icon and its corner badge and nothing else. The slot-bonus machinery
  // is gone with the categories it needed (a standard piece always counts as bonused), and Bounty is
  // one grade whose piece is the upgraded one.
  // S2 (22.09): the popover's body is painted when it is OPENED - the summary's own click, before <details>
  // opens - and not on every hit shown while it is closed; the button's tooltip is written either way. The
  // checks below read the body, so they open it the user's way first. The popover's `open` flag itself is
  // left alone here: opening it holds the aim on the model centre (stage 11), which the checks further
  // down switch on and off themselves.
  const tilesBefore = slots.children;
  ok('S2: with the popover closed, a shown hit leaves its body alone and marks it out of date',
     cfgSummary.listenerCount('click') === 1 && /^Config\n/.test(cfgSummary.title));
  openConfigMenu();
  ok('S2: the click that opens it paints it',
     slots.children !== tilesBefore && slots.children.length === 3);
  const tilesPainted = slots.children;
  openConfigMenu();
  ok('S2: a second click with nothing changed paints nothing', slots.children === tilesPainted);
  // S4 (22.09): the preset control is one button that names the entry in force; its list is a sub-panel.
  ok('the preset control names the entry in force, and starts on the stock build',
     presetName() === 'Stock — no equipment' && presetOpen() === false && layer.hidden === true,
     '(' + presetName() + ')');
  // Stage 11: the two presets seeded into the old store are the user's own, and both survived the load.
  // S4: Custom - the user's own working build - is the first entry of the list, before the built-in builds.
  openPresets();
  ok('its list is Custom, the four built-in builds and the two stored ones, in that order',
     rowNames() === ['Custom', 'Stock — no equipment', 'Rammer, stabiliser, vents',
                     'Improved Aiming, laying drive, stabiliser', 'Bounty — rammer, stabiliser, vents',
                     'Old partial', 'Old whole crew'].join(','),
     '(' + rowNames() + ')');
  ok('S4: the row of the entry in force is the marked one, and its name says so to a screen reader',
     presetRows().filter(function (r) { return r.getAttribute('data-selected') === 'true'; })
       .map(rowName).join(',') === 'Stock — no equipment'
     && presetRow('Stock — no equipment').children[0].getAttribute('aria-current') === 'true'
     && presetRow('Custom').children[0].getAttribute('aria-current') === null);
  click(document.getElementById('aim-cfg-scrim'));
  ok('S4: a click on the scrim closes the list', layer.hidden === true && presetOpen() === false);
  // Stage 11: 18 skills and perks plus one Brothers in Arms tile per member of the five-man crew.
  // TTX (23.09): four skills that do not shoot (Recon, Situational Awareness, Off-Road Driving, Engineer), one
  // Concealment tile per member beside his Brothers in Arms, and the paint beside the consumables.
  ok('three equipment slots, one directive slot, three consumables and the paint, and 32 crew tiles',
     slots.children.length === 3 && directive.children.length === 1
     && consumables.children[0].children.length === 4 && crewChips().length === 32,
     '(' + slots.children.length + ' / ' + directive.children.length + ' / '
     + consumables.children[0].children.length + ' / ' + crewChips().length + ')');
  ok('there is no Whole crew group any more: the crew groups are the five roles, a BiA tile first in each',
     crew.children.filter(function (c) { return c.className === 'aim-role'; }).map(function (c) { return c.textContent; }).join(',')
       === 'Commander,Gunner,Driver,Loader,Radio Operator'
     && crew.children.filter(function (c) { return c.className === 'aim-chips'; })
          .every(function (row) { return /^Brothers in Arms, /.test(tileName(row.children[0])); }),
     '(' + crew.children.map(function (c) { return c.textContent || (c.children[0] && tileName(c.children[0])); }).join(' | ') + ')');
  ok('the summary line under the crew is gone, and no element of the popover carries it',
     document.getElementById('aim-config-body').children.every(function (c) { return c.id !== 'aim-cfg-summary' && !/^Fitted:/.test(c.textContent); })
     && document.getElementById('aim-cfg-summary').parentNode === null
     && document.getElementById('aim-cfg-summary').textContent === '');
  ok('the Config button’s own tooltip still lists what is fitted, on hover only',
     /\nNothing fitted\.$/.test(cfgSummary.title), '(' + cfgSummary.title + ')');
  ok('the collapsed button says nothing about the preset (stage 5)',
     document.getElementById('aim-config-brief').textContent === '',
     '(' + document.getElementById('aim-config-brief').textContent + ')');
  ok('the slots start empty',
     slots.children.every(function (t) { return t.getAttribute('data-tier') === 'none'; }));
  ok('nothing is asked about the vehicle’s slot categories any more: the select is gone',
     document.getElementById('aim-cfg-cat-row').parentNode === null);
  // S4 (user, 22.09): the paragraph under the slots is gone - the coefficients and the policy lines nobody
  // read there - and with it every explanatory paragraph of the popover. What is left of it is in the Config
  // button's tooltip, and on the dimmed tiles of a kind the vehicle's lock keeps out.
  ok('S4: no note under the slots, no warning line, no paragraph anywhere in the menu',
     document.getElementById('aim-cfg-fit').parentNode === null
     && document.getElementById('aim-cfg-fit').textContent === ''
     && document.getElementById('aim-cfg-warn').parentNode === null
     && cfgMain().children.every(function (c) { return c.tagName !== 'P'; }),
     '(' + cfgMain().children.map(function (c) { return c.tagName; }).join(',') + ')');
  // S4: the yellow "?" inside the Config button is gone, and nothing is written into it any more.
  ok('S4: the mark inside the Config button is gone from the markup and from the page',
     pageSrc.indexOf('aim-mode-mark') < 0
     && document.getElementById('aim-mode-mark').textContent === ''
     && document.getElementById('aim-mode-mark').getAttribute('data-kind') === null);
  ok('S4: and this battle, whose rules are known, says nothing extra in the button’s tooltip',
     /\nNothing fitted\.$/.test(cfgSummary.title), '(' + cfgSummary.title + ')');
  // What the deleted note and the deleted mark used to say is written into that tooltip instead, by the one
  // function that builds it. This shooter's record gives no reason to say any of it, so it is read off the
  // source - as the ring colours of viewer.js are, which cannot run here either.
  ok('S4: their reasons live in the button’s tooltip now, and nothing paints a mark or a note any more',
     /function aimConfigTitle\(\)/.test(appSrc)
     && /The game fixes this vehicle’s/.test(appSrc)
     && /Everything is offered, which may be more than the game allowed here/.test(appSrc)
     && /Kept from the record/.test(appSrc)
     && appSrc.indexOf('paintAimModeMark') < 0 && appSrc.indexOf('aimCarried') < 0
     && appSrc.indexOf('aim-cfg-fit') < 0 && appSrc.indexOf('aim-config-note') < 0);
  ok('the picker is closed', picker.hidden === true && layer.hidden === true);
  click(slots.children[0]);
  ok('clicking a slot opens the picker', picker.hidden === false && layer.hidden === false);
  ok('the picker is four grade groups in the garage’s order, not ten family rows',
     pickGrades().join(',') === 'Standard,Bounty,Improved,Experimental',
     '(' + pickGrades().join(',') + ')');
  // Stage 11 took the "empty this slot" tile away (it read as a copy of the slot just clicked); the user asked for
  // it back on 23.09 ("there is no option to clear the cell... put an empty slot there"): the first row of the
  // picker, above the grades. pickTiles() counts the grade rows only, so the counts below stay the grades'.
  // TTX (23.09): EVERY device of the client is offered now - the ones that do not shoot count on the
  // characteristics panel, or at least weigh something there: 30 gunnery tiles and 20 more for this vehicle.
  const byGrade = {};
  pickTiles().forEach(function (t) { byGrade[tileTier(t)] = (byGrade[tileTier(t)] || 0) + 1; });
  ok('50 tiles for this vehicle - 14 standard, 11 Bounty, 13 Improved, 12 experimental - and no empty one',
     pickTiles().length === 50 && byGrade.standard === 14 && byGrade.bounty === 11 && byGrade.improved === 13
     && byGrade.experimental === 12, '(' + pickTiles().length + ' tiles: ' + JSON.stringify(byGrade) + ')');
  ok('fieldmods: the picker opens on the empty slot’s own tile - a row of its own above the grades, the empty slot’s art, pressed while the slot is empty; no grade tile wears that art or is pressed',
     clearTile() && pickBox().children[0].children.length === 1 && iconOf(clearTile()).children[0].src === 'web/icons/empty_slot.png'
     && clearTile().getAttribute('aria-pressed') === 'true' && tileName(clearTile()) === 'Empty slot' && /^Empty slot\nSlot 1 is empty now\.$/.test(clearTile().title)
     && pickBox().children[1].className === 'aim-pick-grade'
     && pickTiles().every(function (t) { return iconOf(t).children[0].src !== 'web/icons/empty_slot.png'; })
     && pickTiles().every(function (t) { return t.getAttribute('aria-pressed') === 'false'; }));
  // The complaint this rewrite answers: a tile is an icon, and an icon carries no words.
  ok('not one tile anywhere in the configuration prints a single character',
     allTiles().every(function (t) { return tileWords(t) === ''; }),
     '(' + allTiles().filter(function (t) { return tileWords(t) !== ''; })
       .map(function (t) { return tileWords(t); }).join(' | ') + ')');
  ok('every tile still has an accessible name and a tooltip of its own',
     allTiles().every(function (t) { return !!tileName(t) && t.title.length > 10; }));
  // The Class number is a vehicle-tier band, not a strength (report section 1): a tier-X vehicle that
  // carries tankRammer_class1_user takes Class 1 and nothing else, and no Class 3 ventilation at all.
  ok('the Class bands this vehicle cannot take are off the menu',
     !!pick('Gun Rammer Class 1') && !pick('Gun Rammer Class 2')
     && !pick('Improved Ventilation Class 3') && !pick('Enhanced Gun Laying Drive Class 2'));
  // And the bands it CAN take are one tile, not three: the owner's "why are there three rammers".
  ok('the two ventilation bands this vehicle passes collapse into one tile that names both',
     !!pick('Improved Ventilation Class 1') && !pick('Improved Ventilation Class 2')
     && /Improved Ventilation Class 1, Improved Ventilation Class 2/
        .test(pick('Improved Ventilation Class 1').title));
  ok('Improved Aiming is on the menu, and so is the whole Experimental tier, T1 to T3 apart',
     !!pick('Improved Aiming Class 1') && !!pick('Fire-Control System T1')
     && !!pick('Fire-Control System T2') && !!pick('Fire-Control System T3'));
  ok('Bounty is ONE grade and its piece is the upgraded one',
     tileTier(pick('Bounty Rammer')) === 'bounty'
     && pickTiles().filter(function (t) { return tileName(t) === 'Bounty Rammer'; }).length === 1
     && /×0\.875/.test(pick('Bounty Rammer').title),
     '(' + pick('Bounty Rammer').title.slice(0, 60) + ')');
  ok('nothing anywhere says “trophy”: the garage calls those pieces Bounty',
     !/trophy/i.test(pickerLabels()) && !!pick('Bounty Rammer'));
  // The badge is the grade: the same picture with a different corner mark, as the client does it.
  ok('a grade wears the client’s badge over the corner of the shared device icon',
     iconOf(pick('Bounty Rammer')).children.length === 2
     && iconOf(pick('Bounty Rammer')).children[1].src === 'web/icons/grade_bounty_up.png'
     && iconOf(pick('Fire-Control System T2')).children[1].src === 'web/icons/grade_experimental2.png'
     && iconOf(pick('Gun Rammer Class 1')).children.length === 1
     && iconOf(pick('Gun Rammer Class 1')).children[0].src === iconOf(pick('Bounty Rammer')).children[0].src,
     '(' + iconOf(pick('Fire-Control System T2')).children[1].src + ')');
  const before = view.liveRadius100;
  click(pick('Vertical Stabilizer Class 1'));
  ok('fitting a stabiliser closes the picker and fills the slot',
     picker.hidden === true && slots.children[0].getAttribute('data-tier') === 'standard',
     '(' + slots.children[0].getAttribute('data-tier') + ')');
  ok('a stabiliser leaves the full-aim circle alone', Math.abs(view.liveRadius100 - before) < 1e-9);
  // S4: an edit lands in Custom, which becomes the entry in force - the built-in build it started from is
  // untouched, and Custom is kept in the store at once.
  ok('the build is Custom now, and Custom is what the store holds, under this vehicle’s own type',
     presetName() === 'Custom'
     && (storedCustom() || {}).slots.join(',') === 'aimingStabilizer_tier1,,'
     && JSON.parse(savedSettings()).aim.chosen['germany:Test'] === 'Custom',
     '(' + presetName() + ' / ' + JSON.stringify(storedAim().custom) + ')');
  // Stage 11: the fitted piece is the pressed tile of its own slot's picker, and a click on it empties
  // the slot - that is the only way out now, and its tooltip says so.
  click(slots.children[0]);
  const fittedTile = pick('Vertical Stabilizer Class 1');
  ok('the piece fitted in this slot is the pressed tile, and its tooltip says a click takes it out',
     fittedTile.getAttribute('aria-pressed') === 'true'
     && /\n• Click: take it out of slot 1$/.test(fittedTile.title)
     && pickTiles().filter(function (t) { return t.getAttribute('aria-pressed') === 'true'; }).length === 1,
     '(' + fittedTile.title.slice(-60) + ')');
  click(fittedTile);
  ok('clicking it empties the slot and closes the picker',
     picker.hidden === true && slots.children[0].getAttribute('data-tier') === 'none'
     && /Empty/.test(slots.children[0].title), '(' + slots.children[0].getAttribute('data-tier') + ')');
  // S4: an empty build is not "the stock preset" any more - an edit is an edit, and it stays in Custom.
  ok('and the empty build is still Custom, not the stock preset it happens to equal',
     presetName() === 'Custom', '(' + presetName() + ')');
  click(slots.children[0]);
  ok('in the picker of the empty slot nothing is pressed', pickTiles().every(function (t) { return t.getAttribute('aria-pressed') === 'false'; }));
  click(pick('Vertical Stabilizer Class 1'));
  ok('and the same tile fits it again', slots.children[0].getAttribute('data-tier') === 'standard' && presetName() === 'Custom');
  click(slots.children[0]);
  ok('fieldmods: with a piece fitted the empty slot’s tile is not pressed and says a click takes the piece out',
     clearTile().getAttribute('aria-pressed') === 'false' && /\n• Click: take out what is fitted and leave slot 1 empty$/.test(clearTile().title));
  click(clearTile());
  ok('fieldmods: a click on it empties the slot and closes the picker, as the garage’s empty slot does',
     picker.hidden === true && slots.children[0].getAttribute('data-tier') === 'none' && (storedCustom() || {}).slots.join(',') === ',,',
     '(' + JSON.stringify(storedCustom()) + ')');
  const keptCustom = JSON.stringify(storedCustom());
  click(slots.children[0]); click(clearTile());
  ok('fieldmods: on a slot that is empty already it changes nothing - the picker just closes, the store as it was',
     picker.hidden === true && slots.children[0].getAttribute('data-tier') === 'none' && JSON.stringify(storedCustom()) === keptCustom);
  click(slots.children[0]); click(pick('Vertical Stabilizer Class 1'));
  // A collapsed Standard tile (the two ventilation bands of this vehicle in one) is pressed and taken out
  // the same way.
  click(slots.children[2]);
  click(pick('Improved Ventilation Class 1'));
  ok('ventilation fitted in slot 3', slots.children[2].getAttribute('data-tier') === 'standard');
  click(slots.children[2]);
  ok('its collapsed tile is pressed in slot 3’s picker', pick('Improved Ventilation Class 1').getAttribute('aria-pressed') === 'true');
  click(pick('Improved Ventilation Class 1'));
  ok('and a click on it empties slot 3 again', slots.children[2].getAttribute('data-tier') === 'none');

  click(slots.children[1]);
  ok('the pieces that block the same archetype are greyed out in the other slot',
     pick('Stabilizing Equipment System').disabled === true
     && pick('Bounty Stabilizer').disabled === true
     && pick('Gun Rammer Class 1').disabled === false);
  // The client's own asymmetry: a Fire-Control System stabilises too, but its <incompatibleTags> names
  // only enhancedAimDrives, so it may sit beside a Vertical Stabilizer (report section 2.7).
  ok('a Fire-Control System may still sit beside a stabiliser, as the client allows',
     pick('Fire-Control System T1').disabled === false);
  click(pick('Bounty Rammer'));
  ok('the grade is marked on the slot', slots.children[1].getAttribute('data-tier') === 'bounty',
     '(' + slots.children[1].getAttribute('data-tier') + ')');

  // ---- the slot bonus, which is not modelled any more (user, 21.09) ----------------------------
  // A standard piece is always worth the LAST figure the client gives it, whatever slot it sits in:
  // Improved Aiming is x0.93 and never x0.95, and there is no category to take away from it.
  const plainAim = view.liveRadius100;
  click(slots.children[2]);
  click(pick('Improved Aiming Class 1'));
  ok('Improved Aiming is the one device that shrinks the FULLY AIMED circle, at the bonused x0.93',
     Math.abs(view.liveRadius100 / plainAim - 0.93) < 1e-9,
     '(' + plainAim.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');

  // ---- the directive, the consumables and the crew ----------------------------------------------
  const beforeDirective = view.liveRadius100;
  click(directive.children[0]);
  ok('the directive slot opens a picker of its own', picker.hidden === false);
  // TTX (23.09): 8 directives and the three that land on the characteristics panel - Fuel Filter Replacement,
  // Optical Calibration, Exhaust Insulation.
  ok('fieldmods: the directive picker is headed by the same empty slot tile (pressed: nothing fitted), then one tile per directive, none pressed',
     clearTile() && clearTile().getAttribute('aria-pressed') === 'true' && iconOf(clearTile()).children[0].src === 'web/icons/empty_slot.png'
     && /^Empty slot\nThe directive slot is empty now\.$/.test(clearTile().title)
     && pickTiles().length === 11 && pickTiles().every(function (t) {
       return iconOf(t).children[0].src !== 'web/icons/empty_slot.png' && t.getAttribute('aria-pressed') === 'false';
     }), '(' + pickTiles().length + ')');
  click(pick('Polished Lens'));
  ok('Polished Lens is active beside Improved Aiming and shrinks the circle again',
     view.liveRadius100 < beforeDirective - 1e-9,
     '(' + beforeDirective.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');
  const withLens = view.liveRadius100;
  click(directive.children[0]);
  ok('the fitted directive is the pressed tile of its picker, and says a click takes it out',
     pick('Polished Lens').getAttribute('aria-pressed') === 'true'
     && /\n• Click: take it out$/.test(pick('Polished Lens').title));
  click(pick('Polished Lens'));
  ok('a click on it empties the directive slot, and the circle goes back',
     picker.hidden === true && directive.children[0].getAttribute('data-tier') === 'none'
     && Math.abs(view.liveRadius100 - beforeDirective) < 1e-12,
     '(' + view.liveRadius100.toFixed(4) + ')');
  click(directive.children[0]); click(pick('Polished Lens'));
  ok('and fitting it again is one more click', Math.abs(view.liveRadius100 - withLens) < 1e-12);
  click(directive.children[0]); click(clearTile());
  ok('fieldmods: the empty slot tile takes the directive out too, and the circle goes back',
     picker.hidden === true && directive.children[0].getAttribute('data-tier') === 'none' && Math.abs(view.liveRadius100 - beforeDirective) < 1e-12);
  click(directive.children[0]); click(pick('Polished Lens'));
  const beforeRations = view.liveRadius100;
  click(consumables.children[0].children[0]);   // Combat rations, +10 crew levels
  ok('combat rations tighten the circle through the crew', view.liveRadius100 < beforeRations - 1e-9,
     '(' + beforeRations.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');
  // ---- stage 11: Brothers in Arms, one tile per crew member ------------------------------------
  // The client's law (outputs/brothers-in-arms-2026-09-21.md, checked on its own bytecode): every tankman
  // who has it adds 5/N crew levels to everybody, and a role held by a non-commander gets the commander's
  // tenth on top. Here N = 5 and the rations already add 10, so with k members on, common = 10 + k and the
  // circle scales as f(10) / f(10 + k).
  function crewF(common) { return 0.57 + 0.43 * (100 + common + (100 + common) / 10) / 100; }
  const BIA = ['Commander', 'Gunner', 'Driver', 'Loader', 'Radio Operator'];
  function biaPressed() { return BIA.map(function (r) { return crewChip('Brothers in Arms, ' + r).getAttribute('aria-pressed'); }).join(','); }
  ok('five Brothers in Arms tiles, one per member of the assumed crew, all off',
     biaPressed() === 'false,false,false,false,false', '(' + biaPressed() + ')');
  const gunnerBia = crewChip('Brothers in Arms, Gunner');
  ok('its tooltip gives the client’s averaging rule and says the crew is assumed',
     /\n• Each member with it: \+5\/5 = 1 crew level to everybody\n/.test(gunnerBia.title)
     && /\n• The full \+5: only when all 5 have it\n/.test(gunnerBia.title)
     && /\n• Now: 0 of 5, \+0 crew levels\n/.test(gunnerBia.title)
     && /does not carry this vehicle’s crew yet, so the page assumes five tankmen: commander, gunner, driver, radio operator and loader/.test(gunnerBia.title),
     '\n     ' + gunnerBia.title);
  const noBia = view.liveRadius100;
  click(crewChip('Brothers in Arms, Gunner'));   // every edit repaints the crew, so a tile is fetched again
  ok('ONE member with it is worth a fifth: the circle shrinks by f(10)/f(11), not by f(10)/f(15)',
     crewChip('Brothers in Arms, Gunner').getAttribute('aria-pressed') === 'true'
     && Math.abs(view.liveRadius100 / noBia - crewF(10) / crewF(11)) < 1e-12,
     '(' + (view.liveRadius100 / noBia).toFixed(6) + ' vs ' + (crewF(10) / crewF(11)).toFixed(6) + ')');
  ok('and every tile’s tooltip now reads 1 of 5', /• Now: 1 of 5, \+1 crew level\n/.test(crewChip('Brothers in Arms, Driver').title),
     '(' + /Now: [^\n]*/.exec(crewChip('Brothers in Arms, Driver').title) + ')');
  ok('it does not matter WHO has it: the gunner’s own tile is no stronger than anybody’s',
     biaPressed() === 'false,true,false,false,false');
  const stepwise = [];
  ['Commander', 'Driver', 'Loader', 'Radio Operator'].forEach(function (r, i) {
    click(crewChip('Brothers in Arms, ' + r));
    stepwise.push(Math.abs(view.liveRadius100 / noBia - crewF(10) / crewF(12 + i)) < 1e-12);
  });
  ok('each further member adds his fifth, linearly, up to the whole crew', stepwise.every(Boolean),
     '(' + stepwise.join(',') + ')');
  ok('with all five on it is the full +5 of before, and the tooltip says 5 of 5',
     biaPressed() === 'true,true,true,true,true'
     && Math.abs(view.liveRadius100 / noBia - crewF(10) / crewF(15)) < 1e-12
     && /• Now: 5 of 5, \+5 crew levels\n/.test(crewChip('Brothers in Arms, Loader').title));
  click(crewChip('Snap Shot'));
  ok('Snap Shot is a skill, Concentration a situational perk',
     crewChip('Snap Shot').getAttribute('data-situational') === null
     && crewChip('Concentration').getAttribute('data-situational') === '1');

  // ---- S4 (22.09): the preset list, Custom, and managing a preset in its own row -----------------
  // Everything clicked above landed in Custom, which is the entry in force. Saving it as a preset of its own
  // is the save icon on the Custom row: it makes a "Build N" and opens that row's name for typing at once.
  openPresets();
  const customRow = presetRow('Custom');
  ok('S4: Custom carries the save icon alone - it cannot be renamed or deleted - and a built-in row carries none',
     !!rowAct(customRow, 'save') && !rowAct(customRow, 'rename') && !rowAct(customRow, 'delete')
     && presetRow('Stock — no equipment').children.length === 1
     && rowAct(customRow, 'save').title === 'Save as a preset',
     '(' + customRow.children.length + ' / ' + presetRow('Stock — no equipment').children.length + ')');
  ok('S4: a user preset carries the pencil and the bin, with their words in the tooltip only',
     !!rowAct(presetRow('Old partial'), 'rename') && !!rowAct(presetRow('Old partial'), 'delete')
     && rowAct(presetRow('Old partial'), 'delete').title === 'Delete'
     && rowAct(presetRow('Old partial'), 'delete').textContent === '');
  click(rowAct(customRow, 'save'));
  ok('S4: the save makes a preset under a default name and opens that name for typing',
     !!editingRow() && rowField(editingRow()).value === 'Build 1'
     && !!JSON.parse(savedSettings()).aim.presets['Build 1']
     && presetName() === 'Custom',
     '(' + rowNames() + ' / ' + presetName() + ')');
  typeName(rowField(editingRow()), 'My brawler');
  commitName(rowField(editingRow()));
  ok('the build saved under its own name, the default one gone with it',
     !!presetRow('My brawler') && !presetRow('Build 1') && !editingRow(),
     '(' + rowNames() + ')');
  const stored = JSON.parse(savedSettings() || '{}');
  const mine = stored.aim && stored.aim.presets && stored.aim.presets['My brawler'];
  ok('it is stored in the page one settings object as the client’s own entry ids, at v3',
     !!(stored.aim && stored.aim.v === 3 && mine
        && mine.slots.join(',') === 'aimingStabilizer_tier1,trophyUpgradedTankRammer,improvedSights_tier1'
        && mine.directive === 'improvedSightsBattleBooster' && mine.food === true
        && mine.skills.brotherhood === true && mine.skills.gunner_smoothTurret === true
        && mine.slotCat === undefined
        && stored.aim.chosen['germany:Test'] === 'Custom'),
     '\n     ' + JSON.stringify(stored.aim));
  // Stage 11: Brothers in Arms on every member is stored as the whole-crew flag it always was, so an
  // older page and a crew of another size both read it as "everybody"; no per-member map is written.
  ok('a whole crew with Brothers in Arms is stored as skills.brotherhood, with no per-member map',
     mine.bia === undefined && mine.skills.brotherhood === true);
  // The two presets of the old store: rewritten in the same shape, the whole-crew flag kept as it was,
  // the member this crew lacks kept, the key that is nobody's name gone.
  const oldWhole = stored.aim.presets['Old whole crew'], oldPartial = stored.aim.presets['Old partial'];
  ok('the old store’s presets are carried over, nothing the user saved is dropped',
     !!oldWhole && oldWhole.skills.brotherhood === true && oldWhole.skills.gunner_smoothTurret === true && oldWhole.bia === undefined
     && !!oldPartial && JSON.stringify(oldPartial.bia) === '{"gunner":true,"loader2":true}' && oldPartial.skills.brotherhood === undefined,
     '\n     ' + JSON.stringify(oldWhole) + '\n     ' + JSON.stringify(oldPartial));
  // S4: a name that cannot be taken keeps the field open, outlined red, with the reason in its tooltip - there
  // is no warning paragraph any more. "Custom" is the page's own entry and is refused like a built-in name.
  click(rowAct(presetRow('My brawler'), 'rename'));
  typeName(rowField(editingRow()), 'Custom');
  commitName(rowField(editingRow()));
  ok('S4: a preset cannot take the name Custom: the field stays open, marked, with the reason on hover',
     !!editingRow() && rowField(editingRow()).getAttribute('aria-invalid') === 'true'
     && /Custom/.test(rowField(editingRow()).title) && !!JSON.parse(savedSettings()).aim.presets['My brawler'],
     '(' + (editingRow() ? rowField(editingRow()).title : 'closed') + ')');
  typeName(rowField(editingRow()), 'Old partial');
  commitName(rowField(editingRow()));
  ok('S4: nor the name of another preset of his own',
     !!editingRow() && rowField(editingRow()).getAttribute('aria-invalid') === 'true'
     && /already have/.test(rowField(editingRow()).title));
  typeName(rowField(editingRow()), 'Bounty — rammer, stabiliser, vents');
  commitName(rowField(editingRow()));
  ok('S4: nor the name of a built-in build',
     !!editingRow() && rowField(editingRow()).getAttribute('aria-invalid') === 'true'
     && /built-in/.test(rowField(editingRow()).title));
  cancelName(rowField(editingRow()));
  ok('S4: Escape in the field gives the old name back and closes it',
     !editingRow() && !!presetRow('My brawler') && layer.hidden === false, '(' + rowNames() + ')');
  // A double-click on the name opens the same field, which is what the owner asked for; typing and leaving the
  // field (its blur) keeps the new name, and the vehicles that had the old one follow it.
  const brawler = presetRow('My brawler');
  brawler.children[0].ondblclick.call(brawler.children[0], {});
  ok('S4: a double-click on a name opens it for typing', !!editingRow() && rowField(editingRow()).value === 'My brawler');
  typeName(rowField(editingRow()), 'My heavy');
  blurName(rowField(editingRow()));
  ok('S4: leaving the field keeps the name',
     !!presetRow('My heavy') && !presetRow('My brawler')
     && !!JSON.parse(savedSettings()).aim.presets['My heavy'], '(' + rowNames() + ')');
  // S4 review (22.09): what commits a name in place is usually the mousedown of the next icon pressed, which
  // takes the focus off the field. That icon has to be on the page still when its own click arrives - the row
  // is mended, not rebuilt - and it has to find its preset under the NEW name.
  click(rowAct(presetRow('Custom'), 'save'));
  typeName(rowField(editingRow()), 'Scratch');
  const scratchBin = rowAct(editingRow(), 'delete');
  blurName(rowField(editingRow()));   // the bin's mousedown: the name is committed there and then
  ok('S4: a name committed in place leaves its row and its icons where they were, under the new name',
     !!presetRow('Scratch') && !editingRow() && scratchBin.parentNode === presetRow('Scratch'),
     '(' + rowNames() + ')');
  click(scratchBin);                  // ... and then the bin's own click
  ok('S4: and that same bin deletes the preset it now names, not the name it was made with',
     !presetRow('Scratch') && !storedAim().presets['Scratch'] && !storedAim().presets['Build 1'],
     '(' + rowNames() + ')');
  // A partly trained crew is the one case that writes the `bia` map.
  click(document.getElementById('aim-cfg-scrim'));
  click(crewChip('Brothers in Arms, Driver'));
  click(crewChip('Brothers in Arms, Radio Operator'));
  openPresets();
  click(rowAct(presetRow('Custom'), 'save'));
  typeName(rowField(editingRow()), 'Three of five');
  commitName(rowField(editingRow()));
  const partial = JSON.parse(savedSettings()).aim.presets['Three of five'];
  ok('three of five members are stored by name, and the whole-crew flag is not',
     !!partial && JSON.stringify(partial.bia) === '{"commander":true,"gunner":true,"loader":true}'
     && partial.skills.brotherhood === undefined && JSON.parse(savedSettings()).aim.v === 3,
     '(' + JSON.stringify(partial) + ')');
  ok('the Config button’s tooltip counts them', /Brothers in Arms \(3 of 5\)/.test(cfgSummary.title), '(' + cfgSummary.title + ')');
  // S4: the entry in force follows the list, and Custom survives every one of them.
  const customBuild = JSON.stringify(storedCustom());
  choosePreset('Old whole crew');
  ok('an old whole-crew preset is every member having it',
     biaPressed() === 'true,true,true,true,true' && crewChip('Snap Shot').getAttribute('aria-pressed') === 'true'
     && presetName() === 'Old whole crew', '(' + biaPressed() + ')');
  choosePreset('Old partial');
  ok('a partial one gives it to the members of this crew it names (loader2 waits for a crew that has him)',
     biaPressed() === 'false,true,false,false,false' && presetName() === 'Old partial', '(' + biaPressed() + ')');
  choosePreset('Rammer, stabiliser, vents');
  ok('a built-in preset with Brothers in Arms gives it to every member',
     biaPressed() === 'true,true,true,true,true', '(' + biaPressed() + ')');
  choosePreset('Three of five');
  ok('and the partial preset comes back as it was saved, and is recognised as itself',
     biaPressed() === 'true,true,false,true,false' && presetName() === 'Three of five',
     '(' + biaPressed() + ' / ' + presetName() + ')');
  ok('S4: four presets later Custom is still the build the user made by hand',
     JSON.stringify(storedCustom()) === customBuild, '(' + JSON.stringify(storedCustom()) + ')');
  choosePreset('Custom');
  ok('S4: and choosing Custom brings that build back, slots and crew',
     presetName() === 'Custom' && biaPressed() === 'true,true,false,true,false'
     && slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',') === 'standard,bounty,standard',
     '(' + presetName() + ' / ' + biaPressed() + ' / '
     + slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',') + ')');
  // The client's own figures (report section 5, the table run on its bytecode), with nothing else fitted:
  // f = 1.043 with no member, 1.04773 with one, 1.06665 with all five.
  choosePreset('Stock — no equipment');
  const stock = view.liveRadius100;
  ok('the stock build is the plain trained crew, f = 1.043', Math.abs(stock - 0.383 / 1.043) < 1e-12, '(' + stock + ')');
  click(crewChip('Brothers in Arms, Commander'));
  ok('one member: f = 1.04773, as the client computes it', Math.abs(view.liveRadius100 - 0.383 / 1.04773) < 1e-12,
     '(' + (0.383 / view.liveRadius100).toFixed(6) + ')');
  ['Gunner', 'Driver', 'Loader', 'Radio Operator'].forEach(function (r) { click(crewChip('Brothers in Arms, ' + r)); });
  ok('all five: f = 1.06665', Math.abs(view.liveRadius100 - 0.383 / 1.06665) < 1e-12,
     '(' + (0.383 / view.liveRadius100).toFixed(6) + ')');

  // ---- stage 11: a crew from the record --------------------------------------------------------
  // Nothing writes one yet; the page takes aim.crewRoles when it is there (the field the research
  // proposes for aim_block) and the maths runs on it. F100 Panhard EBR 90: the commander is the loader.
  function stockAgain() { choosePreset('Stock — no equipment'); }
  AIM_BLOCK.crewRoles = [['commander', 'loader'], ['gunner'], ['driver'], ['radioman']];
  stockAgain();
  ok('EBR crew: the gunner is a non-commander, so the circle is the usual f = 1.043',
     Math.abs(view.liveRadius100 - 0.383 / 1.043) < 1e-12, '(' + view.liveRadius100 + ')');
  ok('but the loader is the commander, who gets no commander’s tenth: the reload is 10.0 s, not 9.6',
     gunReload.textContent === '10.0 s', '(' + gunReload.textContent + ')');
  const ebrTiles = crewChips().filter(function (c) { return /^Brothers in Arms, /.test(tileName(c)); }).map(tileName);
  ok('four tiles for four tankmen, the commander’s naming both his roles, none in the Loader group',
     ebrTiles.join('|') === 'Brothers in Arms, Commander and Loader|Brothers in Arms, Gunner|Brothers in Arms, Driver|Brothers in Arms, Radio Operator',
     '(' + ebrTiles.join('|') + ')');
  const ebrTitle = crewChip('Brothers in Arms, Gunner').title;
  ok('and the tooltip counts four and names the recorded crew',
     /• Each member with it: \+5\/4 = 1\.25 crew levels to everybody/.test(ebrTitle)
     && /This vehicle’s crew, from the record: Commander and Loader, Gunner, Driver, Radio Operator\./.test(ebrTitle),
     '\n     ' + ebrTitle);
  click(crewChip('Brothers in Arms, Driver'));
  ok('one of four: f(gunner) = 1.0489125, the client’s 1.048912', Math.abs(view.liveRadius100 - 0.383 / 1.0489125) < 1e-12,
     '(' + (0.383 / view.liveRadius100).toFixed(7) + ')');
  ['Commander and Loader', 'Gunner', 'Radio Operator'].forEach(function (r) { click(crewChip('Brothers in Arms, ' + r)); });
  ok('all four: the gunner at 1.06665 and the loader-commander at 1.0215 (reload 9.8 s)',
     Math.abs(view.liveRadius100 - 0.383 / 1.06665) < 1e-12 && gunReload.textContent === '9.8 s',
     '(' + (0.383 / view.liveRadius100).toFixed(6) + ' / ' + gunReload.textContent + ')');
  // Cz10 LT vz.38: the commander is the gunner, so the CIRCLE loses the commander's tenth.
  AIM_BLOCK.crewRoles = [['commander', 'gunner'], ['driver'], ['radioman'], ['loader']];
  stockAgain();
  ok('Cz10 crew: the commander aims, so f(gunner) = 1.0 and the circle is the bare dispersion',
     Math.abs(view.liveRadius100 - 0.383) < 1e-12 && gunReload.textContent === '9.6 s',
     '(' + view.liveRadius100 + ' / ' + gunReload.textContent + ')');
  // A list the client would refuse (two commanders) is not taken: the assumed five come back.
  AIM_BLOCK.crewRoles = [['commander'], ['commander', 'gunner'], ['driver'], ['radioman'], ['loader']];
  stockAgain();
  ok('a crew list the client would refuse falls back to the assumed five',
     crewChips().filter(function (c) { return /^Brothers in Arms, /.test(tileName(c)); }).length === 5
     && Math.abs(view.liveRadius100 - 0.383 / 1.043) < 1e-12);
  delete AIM_BLOCK.crewRoles;
  stockAgain();
  ok('and without one it is the assumed five again', Math.abs(view.liveRadius100 - FULL_AIM) < 1e-12 && gunReload.textContent === '9.6 s');

  // ---- S0: a cursor move the turret catches in ONE frame --------------------------------------------
  // The catching frame has the turret's speed in it, so the ring rises instantly to that state's ideal and
  // aimStep calls it settled. The loop used to fall asleep right there, the ring bloomed and its figure
  // stale until the next mouse move (optimisation plan 21.09, §8.3).
  run(30);
  const restRing = view.liveRadius100;
  view.gap = 0.004; view.onAimMove(); tick(1 / 60);
  const bloomed = view.liveRadius100;
  ok('S0: a cursor move the turret catches in one frame blooms the ring for that frame',
     view.gap === 0 && bloomed > restRing * 1.01, '(' + restRing.toFixed(4) + ' -> ' + bloomed.toFixed(4) + ')');
  tick(1 / 60);
  ok('S0: the loop stays awake after it, and the next frame, with no turret speed, starts shrinking the ring',
     view.liveRadius100 < bloomed && view.liveRadius100 > restRing, '(' + view.liveRadius100.toFixed(4) + ')');
  run(10);
  ok('S0: the ring settles back to full aim, and only then does the loop sleep',
     Math.abs(view.liveRadius100 / restRing - 1) < 1e-12 && loopFrames() === 0);
  ok('S0: with the fine figure taken for the settled ring, not for the bloomed one',
     view.lastProbeCount === 1024 && view.probeRadius === view.liveRadius100);
  // A slow sweep: a small move every frame. The coarse figure keeps its 120 ms pace and the fine one is taken
  // once, at the end - never 1024 rays per frame (the variant rejected in the plan's §9).
  const sweepProbes = view.probes, sweepFine = view.fineProbes;
  for (let i = 0; i < 60; i++) { view.gap = 0.002; view.onAimMove(); tick(1 / 60); }
  ok('S0: a one-second slow sweep takes only coarse figures, at most one per 120 ms',
     view.fineProbes === sweepFine && view.probes - sweepProbes <= 9,
     '(' + (view.probes - sweepProbes) + ' figures, ' + (view.fineProbes - sweepFine) + ' fine)');
  run(10);
  ok('S0: and the fine one once the sweep has stopped and the ring rests',
     view.lastProbeCount === 1024 && view.probeRadius === restRing && loopFrames() === 0);

  // ---- stage 11: the circle goes to the tank while the Config popover is open -----------------------
  run(2);
  const gunPoint = view.liveAimPoint, cursorPointBefore = view.aimCursorPoint;
  ok('with the popover closed the ring is drawn around the gun’s own point', !view.centred && view.drawnAt === gunPoint && gunPoint !== CENTRE);
  const probesBefore = view.probes;
  config.open = true; config.fire('toggle');
  ok('opening the Config popover holds the aim on the model centre and draws the Settings cross there',
     !!view.centred && view.liveAimPoint === CENTRE && view.aimCursorPoint === CENTRE && view.drawnAt === CENTRE
     && view.markerShape === 'cross');
  ok('and the live figure is taken again for the ring where it now stands', view.probes > probesBefore,
     '(' + probesBefore + ' -> ' + view.probes + ')');
  run(1);
  ok('then finely once it rests', view.lastProbeCount === 1024 && probeTile.hidden === false && loopFrames() === 0);
  const openRing = view.liveRadius100;
  click(slots.children[2]); click(pick('Improved Aiming Class 1'));
  ok('a tile clicked with the popover open changes the ring AT ONCE, and it stays on the centre',
     Math.abs(view.liveRadius100 / openRing - 0.93) < 1e-9 && view.drawnAt === CENTRE && !!view.centred && config.open === true,
     '(' + openRing.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');
  const beforeGunnerBia = view.liveRadius100;
  click(crewChip('Brothers in Arms, Gunner'));
  ok('so does a crew tile', Math.abs(view.liveRadius100 / beforeGunnerBia - crewF(0) / crewF(1)) < 1e-12 && view.drawnAt === CENTRE);
  // S0: two clicks inside one frame. The coarse figure's 120 ms pace used to keep the figure of the ring
  // after the FIRST click on the panel, and nothing woke the loop for the fine one.
  run(1);
  const beforeS0 = view.liveRadius100;
  click(crewChip('Brothers in Arms, Loader'));
  const afterFirst = view.liveRadius100;
  click(crewChip('Brothers in Arms, Driver'));
  ok('S0: a configuration change takes the figure again at once, even inside the 120 ms pace',
     view.liveRadius100 !== afterFirst && view.probeRadius === view.liveRadius100 && view.lastProbeCount === 256,
     '(' + afterFirst.toFixed(5) + ' -> ' + view.liveRadius100.toFixed(5) + ', figure for ' + (view.probeRadius || 0).toFixed(5) + ')');
  run(1);
  ok('S0: and wakes the loop, which takes the fine figure of the new ring once it rests',
     view.lastProbeCount === 1024 && view.probeRadius === view.liveRadius100 && loopFrames() === 0);
  click(crewChip('Brothers in Arms, Loader')); click(crewChip('Brothers in Arms, Driver'));
  ok('S0: (both taken out again)', Math.abs(view.liveRadius100 / beforeS0 - 1) < 1e-12);
  // S0: the viewer found the held centre again after an orbit (onAimCentre): the ring stands on another
  // point, so its figure is taken again, coarse within its 120 ms pace and fine at rest.
  run(1);
  const probesOrbit = view.probes;
  view.onAimCentre();
  ok('S0: the held centre found again after an orbit takes the ring’s figure again',
     view.probes === probesOrbit + 1 && view.lastProbeCount === 256);
  run(1);
  ok('S0: and finely once it rests', view.lastProbeCount === 1024 && loopFrames() === 0);
  // Review fix: a second settle inside the 120 ms pace (a wheel glide or a +/- key soon after) takes no
  // coarse figure at once - the pace is kept, unlike a new ring (aimRingMoved) - but the loop is woken and
  // the fine figure of the new point still comes at rest.
  view.onAimCentre(); tick(1 / 60);
  const probesPace = view.probes, fineBeforePace = view.fineProbes;
  view.onAimCentre();
  ok('S0: a settle inside the 120 ms pace takes no coarse figure at once', view.probes === probesPace && loopFrames() === 1);
  tick(1 / 60);
  ok('S0: but the fine one at rest', view.probes === probesPace + 1 && view.fineProbes === fineBeforePace + 1
     && view.lastProbeCount === 1024 && loopFrames() === 0);
  const cross = document.getElementById('crosshair-style');
  cross.value = 'dot'; cross.onchange.call(cross);
  ok('the drawn crosshair follows the Settings shape', view.markerShape === 'dot' && !!view.centred);
  cross.value = 'cross'; cross.onchange.call(cross);
  // A press in the scene with the popover open only closes it (the document click handler, which this
  // stub does not run): it fires nothing, at the centre or anywhere else, and it pins nothing.
  const shotsOpen = view.pinnedPoints;
  press(); tick(0.3); release();
  ok('a press in the scene with the popover open fires nothing', view.pinnedPoints === shotsOpen && view.aimHold === false);
  press();
  ok('and a drag from it still orbits', dragAway() === true && view.aimHold === false);
  release();
  ok('still nothing fired', view.pinnedPoints === shotsOpen);
  // S0: the whole click, as the browser delivers it: pointerdown and pointerup on the viewer, then the click
  // bubbling up to the document, whose handler closes every open .toolbar-more popover it did not come from,
  // and the <details> firing its toggle. A click inside the popover leaves it open.
  const inside = new Element('button'); config.appendChild(inside);
  document.fire('click', {target: inside});
  ok('S0: a click inside the popover leaves it open, and the hold with it', config.open === true && !!view.centred);
  config.removeChild(inside);
  const pinsDoc = view.pinnedPoints, ringsDoc = view.shotsDrawn;
  press(); tick(0.05); release();
  document.fire('click', {target: viewport});
  ok('S0: a scene click reaching the document closes the popover', config.open === false);
  config.fire('toggle');
  tick(0.3);
  ok('S0: which ends the hold, and no shot was fired at any point of it',
     !view.centred && view.pinnedPoints === pinsDoc && view.shotsDrawn === ringsDoc);
  config.open = true; config.fire('toggle');
  ok('S0: (open and held again for the checks below)', !!view.centred);
  // The keys keep driving: the hull swings the gun off the centre and the turret brings it back.
  view.turned = []; view.gap = 0;
  document.fire('keydown', {code: 'KeyD', key: 'd', target: document.body, preventDefault: function () {}});
  run(0.5);
  ok('W A S D keep driving with the popover open', view.turned.length > 20 && capsDown() === 'right' && !!view.centred,
     '(' + view.turned.length + ')');
  document.fire('keyup', {code: 'KeyD', key: 'd', target: document.body, preventDefault: function () {}});
  run(25);
  view.turned = []; view.gap = 0;
  config.open = false; config.fire('toggle');
  ok('closing the popover gives the aim back to the cursor, the ring with it',
     !view.centred && view.liveAimPoint === gunPoint && view.aimCursorPoint === cursorPointBefore && view.drawnAt === gunPoint);
  const shotsClosed = view.pinnedPoints;
  press(); tick(0.05); release();
  ok('and a click shoots again', view.pinnedPoints === shotsClosed + 1);
  // The mode going off with the popover open closes it and ends the hold with it.
  config.open = true; config.fire('toggle');
  ok('open again, held again', !!view.centred);
  switchOn(false);
  ok('switching the mode off closes the popover and releases the hold', !view.centred && config.open === false);
  switchOn(true);
  ok('and on again it is the cursor that aims', !view.centred && view.drawnAt !== CENTRE);
  run(30);
  // ---- S4 (22.09): the sub-panel layer, and a preset chosen with the popover open ----------------
  config.open = true; config.fire('toggle');
  openConfigMenu();
  ok('S4: (the popover is open and the aim is held on the model)', !!view.centred && config.open === true);
  const heldRing = view.liveRadius100;
  openPresets();
  ok('S4: the preset control is the lit owner of its list, and the panel is placed under it, never over it',
     presetOpen() === true && preset.getAttribute('data-owner') === 'true'
     && layer.hidden === false && scrim.hidden === false && parseFloat(layer.style.top) > 0,
     '(top ' + layer.style.top + ')');
  ok('S4: the panel has no heading of its own: a close control and the rows, nothing that names the owner',
     panelWords() === '×Custom' + ['Stock — no equipment', 'Rammer, stabiliser, vents',
                                   'Improved Aiming, laying drive, stabiliser', 'Bounty — rammer, stabiliser, vents',
                                   'My heavy', 'Old partial', 'Old whole crew', 'Three of five'].join(''),
     '(' + panelWords() + ')');
  // CHOOSING A PRESET KEEPS THE MENU OPEN (user, 22.09). The click is delivered the way a browser delivers it:
  // the row's own handler first - which repaints the menu and takes that row out of the page - and then the
  // same event at the document, whose handler closes every popover the click did not come from. It reads the
  // event's own path, taken when the dispatch started, so the menu is still named in it.
  clickThrough(presetRow('Bounty — rammer, stabiliser, vents').children[0]);
  ok('S4: choosing a built-in Bounty build fills the three slots and closes the list',
     slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',') === 'bounty,bounty,bounty'
     && layer.hidden === true && presetName() === 'Bounty — rammer, stabiliser, vents',
     '(' + slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',') + ')');
  ok('S4: and the Config menu stays open, with the aim held and the circle changed under it',
     config.open === true && !!view.centred && view.drawnAt === CENTRE && view.liveRadius100 !== heldRing,
     '(' + heldRing.toFixed(4) + ' -> ' + view.liveRadius100.toFixed(4) + ')');
  // The other half of the rule, kept as a check: a click that really did come from outside still closes it.
  const outside = new Element('button');
  document.fire('click', {target: outside});
  ok('S4: a click from outside the menu closes it as before', config.open === false);
  config.fire('toggle');
  config.open = true; config.fire('toggle'); openConfigMenu();
  // Arrow Up / Down step through the entries without opening the list: the quick comparison.
  const beforeArrow = presetName();
  preset.onkeydown.call(preset, keyEvent('ArrowDown'));
  const stepped = presetName();
  ok('S4: Arrow Down on the preset control puts the next entry in force, the list still closed',
     stepped !== beforeArrow && layer.hidden === true && config.open === true,
     '(' + beforeArrow + ' -> ' + stepped + ')');
  preset.onkeydown.call(preset, keyEvent('ArrowUp'));
  ok('S4: and Arrow Up steps back', presetName() === beforeArrow, '(' + presetName() + ')');
  // S4: EVERY sub-panel is placed by the same rule - straight under the element it belongs to. Nothing in this
  // harness lays anything out, so the three owners are given rectangles of their own here.
  function measured(el, top, bottom) {
    el.getBoundingClientRect = function () { return {top: top, bottom: bottom, left: 0, right: 500, width: 500, height: bottom - top}; };
  }
  measured(cfgBody, 0, 560); measured(preset, 20, 50); measured(slots, 100, 150); measured(directive, 220, 270);
  // The PANEL does not scroll - its content box does, so the × stays pinned in the corner - and it is that
  // box's height the placement measures, plus the panel's own 10px top and bottom padding.
  picker.scrollHeight = 0;
  click(slots.children[1]);
  const slotTop = layer.style.top, slotCap = layer.style.maxHeight;
  click(directive.children[0]);
  const dirTop = layer.style.top;
  openPresets();
  ok('S4: each panel opens straight under its own element, by the one rule, and down to the popover at most',
     slotTop === '156px' && dirTop === '276px' && layer.style.top === '56px' && slotCap === 'calc(100% - 164px)',
     '(' + [slotTop, dirTop, layer.style.top, slotCap].join(' / ') + ')');
  // When the panel wants more room than there is under its element, the sections are scrolled up to give it,
  // never past the element itself.
  cfgMain().scrollTop = 0;
  picker.scrollHeight = 500;
  click(slots.children[1]);
  ok('S4: a panel taller than the room below scrolls the sections up for it, no further than the element’s top',
     cfgMain().scrollTop === 92 && layer.style.top === '156px', '(' + cfgMain().scrollTop + ')');
  picker.scrollHeight = 0; cfgMain().scrollTop = 0;
  // The slot row is lifted out of the scrim, so the other slots stay clickable and take the panel over.
  click(slots.children[0]);
  ok('S4: the picker opens on its scrim, under the lit slot, with the whole slot row lifted out of the scrim',
     layer.hidden === false && scrim.hidden === false && slots.getAttribute('data-owner') === 'true'
     && slots.children[0].getAttribute('aria-expanded') === 'true'
     && slots.children[1].getAttribute('aria-expanded') === 'false'
     && preset.getAttribute('data-owner') === null);
  click(slots.children[2]);
  ok('S4: a click on another slot moves the picker and the light to that slot',
     slots.children[2].getAttribute('aria-expanded') === 'true'
     && slots.children[0].getAttribute('aria-expanded') === 'false' && layer.hidden === false);
  click(scrim);
  ok('S4: a click on the scrim closes the sub-panel and nothing else - the menu and the hold stay',
     layer.hidden === true && scrim.hidden === true && config.open === true && !!view.centred
     && slots.children[2].getAttribute('aria-expanded') === 'false' && slots.getAttribute('data-owner') === null);
  // S4: the second click of a double-click that closed a panel is dropped, so it cannot toggle the tile it
  // happens to land on. (The page's own guard, on the sections in the capture phase.)
  let guarded = false;
  cfgMain().fire('click', {detail: 2, stopPropagation: function () { guarded = true; }, preventDefault: function () {}});
  ok('S4: the second click of a double-click on a panel that just closed never reaches the menu under it', guarded);
  let passed = true;
  tick(0.6);
  cfgMain().fire('click', {detail: 2, stopPropagation: function () { passed = false; }, preventDefault: function () {}});
  ok('S4: and a double click later on is the user’s own again', passed);
  // S4 review (22.09): a panel MOVED from one slot to the next is not a close - another panel stands where it
  // stood - so the guard stays out of the way and a quick second click on the new slot really closes it.
  click(slots.children[0]); click(slots.children[1]);
  let moved = true;
  cfgMain().fire('click', {detail: 2, stopPropagation: function () { moved = false; }, preventDefault: function () {}});
  ok('S4: moving the panel to the next slot is not a close, so a quick second click there is the user’s own', moved);
  click(slots.children[1]);
  ok('S4: and that second click closes the panel, as a click on the lit slot does', layer.hidden === true);
  // S4 review: the wheel. It is the POPOVER that listens, not the whole <details>, so a wheel over the
  // collapsed "Config" button still reaches the viewer and zooms the scene. With a panel open only the panel
  // scrolls: a wheel over the greyed menu is swallowed instead of dragging the page under it.
  ok('S4: the wheel listener sits on the popover, not on the collapsed button',
     cfgBody.listenerCount('wheel') === 1 && config.listenerCount('wheel') === 0,
     '(' + cfgBody.listenerCount('wheel') + ' / ' + config.listenerCount('wheel') + ')');
  let wheelStopped = 0, wheelHeld = 0;
  function wheelAt(target) {
    wheelStopped = wheelHeld = 0;
    cfgBody.fire('wheel', {target: target, stopPropagation: function () { wheelStopped++; },
                           preventDefault: function () { wheelHeld++; }});
  }
  click(slots.children[0]);
  wheelAt(slots.children[0]);
  ok('S4: with a panel open the wheel over the menu is swallowed', wheelStopped === 1 && wheelHeld === 1);
  wheelAt(picker);
  ok('S4: and inside the panel it is the panel’s own', wheelStopped === 1 && wheelHeld === 0);
  click(scrim);
  wheelAt(slots.children[0]);
  ok('S4: with no panel open the sections scroll as they always did', wheelStopped === 1 && wheelHeld === 0);
  // Escape takes the top layer and no more: the sub-panel first, the popover second.
  click(directive.children[0]);
  document.fire('keydown', {key: 'Escape', target: document.body, preventDefault: function () {}});
  ok('S4: Escape closes the sub-panel and leaves the popover open, the aim still held',
     layer.hidden === true && config.open === true && !!view.centred
     && directive.children[0].getAttribute('aria-expanded') === 'false');
  document.fire('keydown', {key: 'Escape', target: document.body, preventDefault: function () {}});
  ok('S4: the next Escape closes the popover itself', config.open === false);
  config.fire('toggle');
  ok('S4: and the hold goes with it', !view.centred);
  ok('S4: with the popover closed nothing of it listens on the document any more',
     document.listenerCount('keydown') === baseKeys + 1,   // the aim mode's own handler and the slider's
     '(' + document.listenerCount('keydown') + ')');
  // S4: an edit after a preset lands in Custom and leaves the preset alone - a mis-click cannot damage one.
  config.open = true; config.fire('toggle'); openConfigMenu();
  choosePreset('Rammer, stabiliser, vents');
  const builtIn = slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',');
  click(crewChip('Snap Shot'));
  ok('S4: an edit after a built-in preset lands in Custom', presetName() === 'Custom'
     && crewChip('Snap Shot').getAttribute('aria-pressed') === 'false');
  choosePreset('Rammer, stabiliser, vents');
  ok('S4: and the built-in build itself is untouched',
     slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(',') === builtIn
     && crewChip('Snap Shot').getAttribute('aria-pressed') === 'true', '(' + builtIn + ')');
  // S4: the bin in a row deletes that preset; a vehicle that had it chosen goes back to the stock build.
  choosePreset('Three of five');
  openPresets();
  click(rowAct(presetRow('Three of five'), 'delete'));
  ok('S4: the bin deletes the preset, the list stays open and the build goes back to the stock one',
     !presetRow('Three of five') && !JSON.parse(savedSettings()).aim.presets['Three of five']
     && layer.hidden === false && presetName() === 'Stock — no equipment',
     '(' + rowNames() + ' / ' + presetName() + ')');
  ok('S4: and no built-in row has a bin to press at all', !rowAct(presetRow('Stock — no equipment'), 'delete'));
  click(layer.children[0]);
  ok('S4: the panel’s × closes it', layer.hidden === true && config.open === true);
  // S4: THE RELOAD. Custom is put in force, then this same harness is started again in a child process with
  // the store as it stands: that second page has to come back on this very build without being told anything.
  choosePreset('Custom');
  openPresets();
  const want = {name: presetName(), bia: biaMarks(), rows: rowNames(),
                tiers: slots.children.map(function (t) { return t.getAttribute('data-tier'); }).join(','),
                dir: directive.children[0].getAttribute('data-tier')};
  click(scrim);
  config.open = false; config.fire('toggle');
  run(1);
  const child = require('child_process').spawnSync(process.execPath, [__filename], {encoding: 'utf8',
    env: Object.assign({}, process.env, {BULLBA_RELOAD: savedSettings(),
                                         BULLBA_RELOAD_WANT: JSON.stringify(want)})});
  const childOut = String(child.stdout || '') + String(child.stderr || '');
  childOut.split('\n').filter(function (l) { return /S4 \(reload\)/.test(l); })
    .forEach(function (l) { console.log('     ' + l.trim()); });
  const childFails = (childOut.match(/^FAIL/gm) || []).length;
  failures += childFails;
  ok('S4: a second page started on this store ran its own checks and passed them',
     childFails === 0 && /S4 \(reload\)/.test(childOut) && /all passed/.test(childOut),
     childFails || !/S4 \(reload\)/.test(childOut) ? '\n' + childOut : '');
  // S4 review (22.09): the store's first shape held ONE Custom build for every vehicle. A page reading it now
  // gives that build to each vehicle whose chosen entry is Custom, so nothing made by hand is lost on the way.
  const oneShape = JSON.parse(savedSettings());
  oneShape.aim.custom = oneShape.aim.custom['germany:Test'];
  const older = require('child_process').spawnSync(process.execPath, [__filename], {encoding: 'utf8',
    env: Object.assign({}, process.env, {BULLBA_RELOAD: JSON.stringify(oneShape),
                                         BULLBA_RELOAD_WANT: JSON.stringify(want)})});
  const olderOut = String(older.stdout || '') + String(older.stderr || '');
  const olderFails = (olderOut.match(/^FAIL/gm) || []).length;
  failures += olderFails;
  ok('S4: a store whose Custom was one build for every vehicle keeps it where it was chosen',
     olderFails === 0 && /S4 \(reload\)/.test(olderOut) && /all passed/.test(olderOut),
     olderFails || !/S4 \(reload\)/.test(olderOut) ? '\n' + olderOut : '');

  // ---- the two effects that had to reach ballistics.js -----------------------------------------
  // A turbocharger raises the CAP the WASD model accelerates to (forwardMaxSpeedKMHTerm), which makes
  // the movement term bigger, and Mag Mastery shortens the interval between the rounds of a clip. The
  // page hands both in as ordinary modifiers, so they are checked on the library directly.
  const KMH = 0.27778;
  const plainCap = ArmorBallistics.moveStep(null, {forward: true}, AIM_BLOCK, {}, 0);
  const turboCap = ArmorBallistics.moveStep(null, {forward: true}, AIM_BLOCK,
                                            {speedForwardAdd: 5 * KMH, speedBackwardAdd: 3 * KMH}, 0);
  ok('a turbocharger raises the speed caps the movement term is built on',
     Math.abs(turboCap.forward - plainCap.forward - 5 * KMH) < 1e-9
     && Math.abs(turboCap.back - plainCap.back - 3 * KMH) < 1e-9,
     '(' + plainCap.forward.toFixed(3) + ' -> ' + turboCap.forward.toFixed(3) + ' m/s)');
  const noSpeed = ArmorBallistics.moveStep(null, {forward: true}, {dispersion: 0.00383},
                                           {speedForwardAdd: 5 * KMH}, 0);
  ok('a record that carries no speed at all gains none: 0 means no data, not a standstill',
     noSpeed.forward === 0 && noSpeed.back === 0);
  // TTX (23.09): Mag Mastery shortens the reload of the WHOLE MAGAZINE and leaves the interval alone - the client's
  // own rule (params __calcReloadTime 1401-1405), which the page had the wrong way round until then. Not on an
  // autoloader, not on an automatic gun, not on a single-shot one.
  const clipGun = {reloadTime: 10, reloadTimeFactor: 1, clip: [3, 2]};
  const mm = ArmorBallistics.reloadSeconds(clipGun, {magazineReload: 0.975});
  ok('Mag Mastery: the magazine reload x 0.975, the interval between the rounds unchanged',
     Math.abs(mm.reload - 9.75) < 1e-9 && mm.interval === 2 && mm.magazine === true,
     '(' + mm.reload + ' s / ' + mm.interval + ' s)');
  const mmAuto = ArmorBallistics.reloadSeconds({reloadTime: 10, clip: [3, 2], gunTags: ['clip', 'autoreload'], autoreload: {reloadTime: [3, 4, 5]}}, {magazineReload: 0.975});
  const mmShoot = ArmorBallistics.reloadSeconds({reloadTime: 10, clip: [30, 0.1], gunTags: ['clip', 'autoShoot']}, {magazineReload: 0.975});
  const mmOne = ArmorBallistics.reloadSeconds({reloadTime: 10, clip: [1, 0]}, {magazineReload: 0.975});
  ok('Mag Mastery: nothing on an autoloader, an automatic gun or a single-shot gun',
     mmAuto.reload === 10 && mmAuto.magazine === false && mmShoot.reload === 10 && mmShoot.magazine === false
     && mmOne.reload === 10 && mmOne.magazine === false);
  ok('Mag Mastery reaches the emulator as magazineReload, and the old clipInterval input is gone',
     appSrc.indexOf("magazineReload: aimMul(e, 'magazineReload')") > 0 && appSrc.indexOf('clipInterval') < 0
     && fs.readFileSync(path + 'ballistics.js', 'utf8').indexOf('clipInterval') < 0
     && /"loader_magMastery"[^}]*"eff": \{"magazineReload": \["mul", 0\.975\]\}/.test(fs.readFileSync(path + 'equipment.js', 'utf8')));
  ok('the autoloader\'s slots are scaled by ONE shared helper, the emulator\'s and the panel\'s',
     typeof ArmorBallistics.autoreloadScaled === 'function'
     && ArmorBallistics.autoreloadScaled({reloadTime: 10, autoreload: {reloadTime: [3, 4, 5]}}, {reload: 9}).join(',') === [2.7, 3.6, 4.5].join(',')
     && appSrc.indexOf('return ArmorBallistics.autoreloadScaled(a, rl);') > 0);

  // ---- switching off ---------------------------------------------------------------------------
  // One more shot first, so switching off has something to put back.
  press(); tick(0.05); release();
  ok('the recorded shot is away again after that shot', view.recordedHidden === true);
  switchOn(false);
  ok('off takes the key handlers off the document',
     document.listenerCount('keydown') === baseKeys && document.listenerCount('keyup') === 0);
  ok('off clears the circle and stops the loop', view.liveRadius100 === null && loopFrames() === 0);
  ok('off takes the last shot’s ring away and the ring is whole again',
     view.shotRing === null && view.reloadPart === null);
  ok('off hides the speed tile, the gun panel and the configuration',
     drive.hidden === true && gun.hidden === true && config.hidden === true);
  ok('and the tile is put away with no cap lit and no arc drawn', capsDown() === '' && turn.hidden === true);
  ok('off brings everything recorded back and releases the shot’s pin',
     view.emulation === false && view.aimChase === false && view.recordedHidden === false
     && view.pinned === null);
  // Stage 7: the live line goes with the mode, but the recorded ring is back on the model, so the
  // hit-line panel goes back to ITS figure instead of falling silent.
  ok('off clears the live line and hands the hit-line panel back to the recorded ring',
     probeTile.hidden === true && probeCircle.textContent === ''
     && shotTile.hidden === false && shotCircle.textContent === '50 %',
     '(' + shotCircle.textContent + ')');
  ok('off is remembered as a plain setting value', storedValues()['aim-on'] === false);
  // Back on: the recorded shot is shown again until the next round leaves (user, 20.09).
  switchOn(true);
  ok('on again shows the recorded shot once more', view.recordedHidden === false && view.pinned === null);
  const againBefore = view.pinnedPoints;
  press(); tick(0.05); release();
  ok('and the next shot takes it away again',
     view.pinnedPoints === againBefore + 1 && view.recordedHidden === true);
  switchOn(false);

  // ---- S2 (22.09): less work per frame and per event ----------------------------------------------
  // D5: the layout pass is split into its four parts and runs only for what changed. The heading and the
  // toolbar passes are the two that ask getComputedStyle, the pose pass the one that measures #pose-info.
  let styleReads = 0, poseReads = 0;
  const computed = window.getComputedStyle;
  window.getComputedStyle = function (el) { styleReads++; return computed(el); };
  const poseInfo = document.getElementById('pose-info');
  poseInfo.getBoundingClientRect = function () { poseReads++; return Element.prototype.getBoundingClientRect.call(this); };
  document.querySelector('.shooter-row').offsetWidth = 400;
  tick(0.02); styleReads = 0; poseReads = 0;
  const penField = document.getElementById('penetration');
  penField.value = '240'; penField.oninput.call(penField);
  tick(0.02);
  ok('S2: a Pen. edit that shows and hides nothing lays nothing out', styleReads === 0 && poseReads === 0, '(' + styleReads + ' / ' + poseReads + ')');
  switchOn(true);
  tick(0.02);
  ok('S2: the mode switched on (its tiles appear) lays out the heading and the toolbar', styleReads === 2, '(' + styleReads + ')');
  switchOn(false); tick(0.02);
  // D7 and D5 on the pose tile: one pose handler per drag step; while the drag lasts only the tile is kept up to
  // date and the figures wait for the committed pose, unless the pose crosses the recorded one.
  let lineCasts = 0, spreadHides = 0, ringDraws = 0;
  view.shotProbability = function (shell) { lineCasts++; return StubViewer.prototype.shotProbability.call(this, shell); };
  view.hideSpread = function () { spreadHides++; };
  view.drawLiveAim = function () { ringDraws++; return null; };
  view.loadedData = {hit: {aim: [0, 0], target: {}}};
  view.gunRangeAbsolute = function () { return {min: -10, max: 20, known: true}; };
  view.turretAngle = 0; view.gunAngle = 0; view.dragging = false; view.liveRadius100 = 0.3;
  view.onTurret({});
  tick(0.02); styleReads = 0; poseReads = 0; lineCasts = 0; spreadHides = 0; ringDraws = 0;
  view.dragging = true;
  view.turretAngle = 0.0005; view.onTurret({});
  ok('S2: a drag step that stays on the recorded pose: no figure, no ring redrawn', lineCasts === 0 && spreadHides === 0 && ringDraws === 0,
     '(' + lineCasts + ' / ' + spreadHides + ' / ' + ringDraws + ')');
  tick(0.02);
  ok('S2: and only the pose tile is measured again (its text changed)', styleReads === 0 && poseReads === 1, '(' + styleReads + ' / ' + poseReads + ')');
  view.turretAngle = 0.05; view.onTurret({});
  ok('S2: a step past the viewer’s 0.001° but inside the note’s 0.1° redoes the figure once', lineCasts === 1, '(' + lineCasts + ')');
  view.turretAngle = 0.06; view.onTurret({});
  ok('S2: and the next step inside the same band does not', lineCasts === 1, '(' + lineCasts + ')');
  view.turretAngle = 5; view.onTurret({});
  ok('S2: the step that leaves the recorded pose redoes the figure once', lineCasts === 2, '(' + lineCasts + ')');
  view.turretAngle = 9; view.onGun({});
  ok('S2: the next steps off it do not', lineCasts === 2, '(' + lineCasts + ')');
  ok('S2: with the live ring up and no manual estimate, the ring is never put away for a pose', spreadHides === 0 && ringDraws === 0);
  view.dragging = false; view.onTurret({});
  ok('S2: without a drag every pose change redoes the figure', lineCasts === 3, '(' + lineCasts + ')');
  view.liveRadius100 = null; view.onTurret({});
  ok('S2: with no live ring the pose puts the estimate away as before', spreadHides === 1 && lineCasts === 4, '(' + spreadHides + ' / ' + lineCasts + ')');
  tick(0.02); styleReads = 0; poseReads = 0;
  view.onTurret({});
  tick(0.02);
  ok('S2: the same pose again measures nothing', poseReads === 0 && styleReads === 0, '(' + poseReads + ')');
  view.loadedData = null; view.onTurret({}); tick(0.02);
  ok('S2: the tile going away is measured once more', poseInfo.hidden === true);
  window.getComputedStyle = computed;
  delete view.shotProbability; delete view.hideSpread; delete view.drawLiveAim; delete view.gunRangeAbsolute;
  // D3: a wheel glide redoes the shell (its penetration at the new distance, the panels, the map's shell)
  // once, when it ends - not on each of its ~16 frames.
  let configures = 0;
  view.configure = function () { configures++; };
  view.target = {y: 1};
  const cam = function (d) { view.onCamera({distance: d, zoom: 1, yaw: 0, pitch: 0}); };
  view.targetDistance = 150;
  for (let i = 1; i <= 16; i++) cam(100 + i * 3);
  ok('S2: sixteen frames of a wheel glide redo the shell not once on the way', configures === 0, '(' + configures + ')');
  view.targetDistance = null; cam(150);
  ok('S2: the last step, with the target reached, redoes it at once', configures === 1, '(' + configures + ')');
  tick(0.2);
  ok('S2: and the timer of the glide does not redo it a second time', configures === 1, '(' + configures + ')');
  view.targetDistance = 300; cam(160); cam(170); tick(0.2);
  ok('S2: a glide cut short is finished by the timer', configures === 2, '(' + configures + ')');
  view.targetDistance = null; cam(180);
  ok('S2: a distance set directly (slider, keys, Fit) is answered at once', configures === 3, '(' + configures + ')');
  cam(180);
  ok('S2: a camera step that keeps the distance does not redo the shell', configures === 3, '(' + configures + ')');
  // viewer-batch (24.09, VIEW-03, the user's decision): the Distance field and slider show the SHOT range the viewer reports
  // (camera -> hit point), not the orbit radius; a report whose range is unchanged - the orbit centre switched between the
  // vehicle and the hit, the orbit radius with it - redoes nothing, and the slider and the field set the shot range.
  const distField = document.getElementById('camera-distance-field'), distSlider = document.getElementById('camera-distance');
  view.onCamera({distance: 186.5, zoom: 1, yaw: .2, pitch: .1, range: 180});
  ok('viewer-batch: a new orbit radius at the same shot range (⊙ Vehicle / ⊙ Hit) does not redo the shell', configures === 3, '(' + configures + ')');
  ok('viewer-batch: the Distance field shows the shot range, not the orbit radius', String(distField.value) === '180', '(' + distField.value + ')');
  view.onCamera({distance: 186.5, zoom: 1, yaw: .2, pitch: .1, range: 190});
  ok('viewer-batch: a new shot range redoes the shell at once', configures === 4 && String(distField.value) === '190', '(' + configures + ', ' + distField.value + ')');
  let askedRange = null;
  view.setShotRange = function (value) { askedRange = value; };
  view.setDistance = function () { askedRange = 'setDistance'; };
  distSlider.value = '500'; distSlider.oninput();
  ok('viewer-batch: the Distance slider sets the shot range (the middle of its log scale = √(3 × 1000) m)', typeof askedRange === 'number' && Math.abs(askedRange - Math.sqrt(3000)) < 1e-9, '(' + askedRange + ')');
  distField.value = '42'; distField.onchange();
  ok('viewer-batch: and so does the field', askedRange === 42, '(' + askedRange + ')');
  delete view.setShotRange; delete view.setDistance;
  delete view.configure; delete view.target; delete view.targetDistance;

  // ---- stage 11: the hold on the model, on the REAL viewer.js ------------------------------------
  // three.js does its maths and its raycasts without a GPU, so the viewer's own methods run here on a
  // bare object built from Viewer.prototype: a camera 20 m in front of a 6 x 2 x 3 m box standing on the
  // ground, the box as the painted model. The stub viewer above is left in place for the page.
  const THREE = require(path + 'vendor/three.min.js');
  global.THREE = THREE; window.THREE = THREE;
  const stubCtor = window.ArmorViewer;
  require(path + 'viewer.js');
  const RealViewer = window.ArmorViewer;
  global.RealViewerCtor = RealViewer;   // the fun-layer section at the end drives it too
  window.ArmorViewer = stubCtor;
  const rv = Object.create(RealViewer.prototype);
  rv.scene = new THREE.Scene();
  rv.camera = new THREE.PerspectiveCamera(38, 800 / 600, 0.1, 1000);
  rv.camera.position.set(0, 2, 20); rv.camera.lookAt(0, 1, 0); rv.camera.updateMatrixWorld();
  const box = new THREE.BoxGeometry(6, 2, 3); box.translate(0, 1, 0);
  rv.paintMesh = new THREE.Mesh(box, new THREE.MeshBasicMaterial()); rv.scene.add(rv.paintMesh); rv.scene.updateMatrixWorld(true);
  rv.bounds = new THREE.Box3().setFromObject(rv.paintMesh);
  rv.target = new THREE.Vector3(0, 1, 0);
  rv.reticleLayer = new Element('div'); rv.viewWidth = 800; rv.viewHeight = 600;
  rv.draw = function () {}; rv.liveRadius100 = 0.4; rv.aimChase = true; rv.spreadAim = null; rv.aimReloadPart = null;
  const cursorAt = new THREE.Vector3(2.5, 1.5, 1.5);
  rv.aimCursorPoint = cursorAt.clone(); rv.liveAimPoint = cursorAt.clone(); rv.drawLiveAim();
  rv.setAimCentre(true, 'dot');
  // The view ray from (0, 2, 20) through the bounds centre (0, 1, 0) meets the front face z = 1.5 at
  // y = 2 - 18.5/20: that is the point on the surface, not the centre inside the box.
  const onFace = new THREE.Vector3(0, 2 - 18.5 / 20, 1.5);
  ok('real viewer: the held aim is the point on the model’s surface along the ray through its bounds centre',
     rv.liveAimPoint.distanceTo(onFace) < 1e-9 && rv.aimCursorPoint.distanceTo(onFace) < 1e-9,
     '(' + rv.liveAimPoint.toArray().map(function (v) { return v.toFixed(4); }).join(', ') + ')');
  ok('real viewer: the live ring is drawn there, at that range',
     !!rv.spreadCircle && rv.liveAim.center.distanceTo(onFace) < 1e-9
     && Math.abs(rv.liveAim.radius - rv.camera.position.distanceTo(onFace) * 0.4 / 100) < 1e-12);
  const mk = rv.aimMarker;
  ok('real viewer: a crosshair in the Settings shape is put on that point, mid-screen here',
     !!mk && mk.className === 'aim-marker' && mk.hidden === false && mk.getAttribute('data-shape') === 'dot'
     && mk.parentNode === rv.reticleLayer
     && Math.abs(parseFloat(mk.style.left) - 400) < 1e-6 && Math.abs(parseFloat(mk.style.top) - 300) < 1e-6,
     '(' + (mk && mk.style.left) + ', ' + (mk && mk.style.top) + ')');
  // A pointer move over the menu: the raycast the cursor makes, which must not move the held aim.
  const aimDir = new THREE.Vector3(-2, 0.5, 1.5).sub(rv.camera.position).normalize();
  const caster = new THREE.Raycaster(rv.camera.position.clone(), aimDir);
  const hits = caster.intersectObjects([rv.paintMesh]);
  ok('real viewer: a pointer move while held moves nothing, and draws nothing',
     hits.length > 0 && rv.aimAtPointer(caster, hits) === null
     && rv.liveAimPoint.distanceTo(onFace) < 1e-9 && rv.aimCursorPoint.distanceTo(onFace) < 1e-9);
  // The hull still swings the gun and the turret still brings it back to the held crosshair.
  ok('real viewer: a hull turn swings the gun off the centre while held',
     rv.turnAim(0.05) === true && rv.liveAimPoint.distanceTo(onFace) > 0.1 && rv.aimGap() > 0.04);
  rv.chaseAim(1);
  ok('real viewer: and the chase brings it back onto the held point', rv.liveAimPoint.distanceTo(onFace) < 1e-9 && rv.aimGap() < 1e-6);
  // An Alt + click pin is outranked while the hold lasts and in force again after it.
  rv.spreadAim = new THREE.Vector3(-2, 1, 1.5); rv.drawLiveAim();
  ok('real viewer: the hold outranks a pinned centre', rv.liveAim.center.distanceTo(onFace) < 1e-9);
  rv.setAimCentre(true, 'cross');
  ok('real viewer: asking again only changes the crosshair’s shape', !!rv.aimCentred && mk.getAttribute('data-shape') === 'cross'
     && rv.liveAimPoint.distanceTo(onFace) < 1e-9);
  rv.setAimCentre(false, 'cross');
  ok('real viewer: letting go gives the aim to where the pointer last pointed, and the crosshair goes',
     rv.aimCursorPoint.distanceTo(hits[0].point) < 1e-9 && rv.liveAimPoint.distanceTo(hits[0].point) < 1e-9 && mk.hidden === true);
  ok('real viewer: and the pin is in force again', rv.liveAim.center.distanceTo(rv.spreadAim) < 1e-9);
  rv.spreadAim = null;
  rv.aimCursorPoint = cursorAt.clone(); rv.liveAimPoint = cursorAt.clone(); rv.drawLiveAim();
  rv.setAimCentre(true, 'cross'); rv.setAimCentre(false, 'cross');
  ok('real viewer: a hold with no pointer move gives back exactly the points it took',
     rv.aimCursorPoint.distanceTo(cursorAt) < 1e-9 && rv.liveAimPoint.distanceTo(cursorAt) < 1e-9
     && rv.liveAim.center.distanceTo(cursorAt) < 1e-9);
  // A new model while held: clearLiveAim drops the points and setLiveAim finds the new centre. S0: the new
  // model really is another one - a 4 x 2 x 2 m box off to the right and further back - or the check would
  // pass with the aim simply left where it was.
  rv.setAimCentre(true, 'cross');
  rv.clearLiveAim();
  rv.scene.remove(rv.paintMesh);
  const box2 = new THREE.BoxGeometry(4, 2, 2); box2.translate(3, 1, -2);
  rv.paintMesh = new THREE.Mesh(box2, new THREE.MeshBasicMaterial()); rv.scene.add(rv.paintMesh); rv.scene.updateMatrixWorld(true);
  rv.bounds = new THREE.Box3().setFromObject(rv.paintMesh);
  rv.setLiveAim(0.4);
  rv.reticles = []; rv.updateReticles();   // what every drawn frame does, and it moves the crosshair too
  // The ray from (0, 2, 20) through the new centre (3, 1, -2) meets the new front face z = -1 at t = 21/22.
  const onFace2 = new THREE.Vector3(3 * 21 / 22, 2 - 21 / 22, -1);
  ok('real viewer: a model change while held puts the aim on the new model’s centre',
     !!rv.aimCentred && rv.liveAimPoint.distanceTo(onFace2) < 1e-9 && rv.aimCursorPoint.distanceTo(onFace2) < 1e-9
     && rv.liveAim.center.distanceTo(onFace2) < 1e-9 && onFace2.distanceTo(onFace) > 2 && mk.hidden === false,
     '(' + rv.liveAimPoint.toArray().map(function (v) { return v.toFixed(4); }).join(', ') + ')');
  rv.setAimCentre(false, 'cross');
  ok('real viewer: and letting go of it keeps the aim there until the pointer moves',
     !rv.aimCentred && rv.liveAimPoint.distanceTo(onFace2) < 1e-9 && mk.hidden === true);

  // S0: an orbit while held, through the viewer's REAL camera loop (startOrbit on the harness's frames). The
  // camera stands where it stood, as the loop's own yaw / pitch / distance round the target (0, 1, 0).
  rv.target = new THREE.Vector3(0, 1, 0); rv.distance = Math.sqrt(401); rv.yaw = 0; rv.pitch = Math.asin(1 / rv.distance);
  rv.targetYaw = rv.yaw; rv.targetPitch = rv.pitch; rv.orbitId = null; rv.contextLost = false;
  rv.targetDistance = null; rv.targetScale = null; rv.targetZoom = null; rv.pendingPan = null;
  rv.pan = {x: 0, y: 0}; rv.frameCenter = {x: 0, y: 0}; rv.autoFrame = false;
  let recentred = 0; rv.onAimCentre = function () { recentred++; };
  rv.render();
  ok('real viewer: (the loop’s camera is the one the checks above used)', rv.camera.position.distanceTo(new THREE.Vector3(0, 2, 20)) < 1e-9);
  rv.setAimCentre(true, 'cross');
  ok('real viewer: held on the new model’s centre again', rv.aimCursorPoint.distanceTo(onFace2) < 1e-9 && recentred === 0);
  rv.orbitTo(0.3, rv.pitch);
  tick(1 / 60);
  ok('real viewer: while the camera is still turning the held point stays put (no raycast per frame)',
     rv.orbitId !== null && rv.aimCursorPoint.distanceTo(onFace2) < 1e-9 && recentred === 0);
  for (let i = 0; i < 600 && rv.orbitId !== null; i++) tick(1 / 60);
  const eye = rv.camera.position.clone(), centre2 = rv.bounds.getCenter(new THREE.Vector3());
  // Where the ray from the new eye through the middle of the box enters it, found without the viewer's
  // raycaster: the box is the model, so its entry point is the surface point.
  const entry = new THREE.Ray(eye, centre2.clone().sub(eye).normalize()).intersectBox(rv.bounds, new THREE.Vector3());
  ok('real viewer: once the camera rests the held aim is found again along the new view of the middle',
     rv.orbitId === null && Math.abs(rv.yaw - 0.3) < 1e-12 && !!entry
     && rv.aimCursorPoint.distanceTo(entry) < 1e-9 && rv.liveAimPoint.distanceTo(entry) < 1e-9
     && rv.liveAim.center.distanceTo(entry) < 1e-9 && entry.distanceTo(onFace2) > 0.05,
     '(' + rv.aimCursorPoint.toArray().map(function (v) { return v.toFixed(4); }).join(', ') + ')');
  ok('real viewer: the ring is drawn there at the new range, the crosshair is on it and the page is told once',
     Math.abs(rv.liveAim.radius - eye.distanceTo(entry) * 0.4 / 100) < 1e-12 && mk.hidden === false && recentred === 1);
  const markLeft = parseFloat(mk.style.left), markTop = parseFloat(mk.style.top), proj = entry.clone().project(rv.camera);
  ok('real viewer: the crosshair sits on the projection of that point',
     Math.abs(markLeft - (proj.x + 1) * 400) < 1e-6 && Math.abs(markTop - (1 - proj.y) * 300) < 1e-6);
  // A camera that comes back to rest over the same middle point changes nothing and tells nobody.
  rv.orbitTo(0.3, rv.pitch); for (let i = 0; i < 600 && rv.orbitId !== null; i++) tick(1 / 60);
  ok('real viewer: a settle on the same point moves nothing', recentred === 1 && rv.aimCursorPoint.distanceTo(entry) < 1e-9);
  // Review fix: a pan settles its loop on EVERY frame (the pan of one frame is consumed in it), so a settle
  // during a drag must not look for the middle - that asked the page for a figure per frame in the middle of
  // a drag, which pauses the emulation. The release looks once (settleAim, what pointerup runs).
  function entryFromEye() {
    const e = rv.camera.position.clone();
    return new THREE.Ray(e, rv.bounds.getCenter(new THREE.Vector3()).sub(e).normalize()).intersectBox(rv.bounds, new THREE.Vector3());
  }
  rv.dragging = true;
  let panSettles = 0;
  for (let i = 0; i < 30; i++) {
    const p = rv.pendingPan || (rv.pendingPan = {x: 0, y: 0}); p.x += 5; rv.startOrbit();
    tick(1 / 60); if (rv.orbitId === null) panSettles++;
  }
  ok('real viewer: a pan settles its loop every frame but looks for nothing while the drag lasts',
     panSettles === 30 && recentred === 1 && rv.aimCursorPoint.distanceTo(entry) < 1e-9, '(' + panSettles + ' settles, ' + recentred + ')');
  rv.dragging = false; rv.settleAim();
  const panned = entryFromEye();
  ok('real viewer: the release looks once, along the panned view of the middle',
     recentred === 2 && !!panned && panned.distanceTo(entry) > 1e-3 && rv.aimCursorPoint.distanceTo(panned) < 1e-9
     && rv.liveAimPoint.distanceTo(panned) < 1e-9);
  // A release while the camera still eases leaves it to the loop, which looks when it settles.
  rv.orbitTo(0.2, rv.pitch); tick(1 / 60); rv.settleAim();
  ok('real viewer: a release while the loop still eases leaves the look to the loop', rv.orbitId !== null && recentred === 2);
  for (let i = 0; i < 600 && rv.orbitId !== null; i++) tick(1 / 60);
  ok('real viewer: which looks once when it settles', recentred === 3 && rv.aimCursorPoint.distanceTo(entryFromEye()) < 1e-9);
  // The +/- keys set the distance at once and repeat: the look waits POSE_SETTLE ms after the last step.
  for (let i = 0; i < 15; i++) { rv.setDistance(rv.distance / 1.1); rv.settleAimSoon(); tick(1 / 30); }
  ok('real viewer: held +/- repeats look for nothing while they come', recentred === 3);
  tick(0.25);
  const keyed = entryFromEye();
  ok('real viewer: and once after the last one', recentred === 4 && rv.aimSettleTimer === null && rv.aimCursorPoint.distanceTo(keyed) < 1e-9,
     '(' + recentred + ')');
  // No ring (the window between clear() and the next model): nothing is looked for on the old bounds.
  const ringWas = rv.liveRadius100; rv.liveRadius100 = null;
  rv.orbitTo(0.35, rv.pitch); for (let i = 0; i < 600 && rv.orbitId !== null; i++) tick(1 / 60);
  ok('real viewer: without a ring a settle moves nothing', recentred === 4 && rv.aimCursorPoint.distanceTo(keyed) < 1e-9);
  rv.liveRadius100 = ringWas;
  // Not held: an orbit leaves the aim to the cursor, as before.
  rv.setAimCentre(false, 'cross');
  const freePoint = rv.liveAimPoint.clone();
  rv.orbitTo(0, rv.pitch); for (let i = 0; i < 600 && rv.orbitId !== null; i++) tick(1 / 60);
  ok('real viewer: without the hold an orbit does not move the aim', rv.liveAimPoint.distanceTo(freePoint) < 1e-9 && recentred === 4);

  // ---- S0: the roster's shooter mark follows a clicked hit --------------------------------------------
  // A battle of three with two incoming hits from two different shooters. renderHits() runs before the
  // scene of the clicked hit arrives and used to be the last roster paint, so the mark stayed on the
  // shooter of the hit before (optimisation plan 21.09, §8.4).
  // The shooter of a recorded hit carries his own four collision parts, exactly as the published records do
  // (22.09 scan of preview/data: 732 of 741 hits of the eight newest battles have attacker parts with a
  // modelKey). That is what the ⇅ swap button is offered for, so the fixture has to carry them.
  const PARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const HIT = function (id, attackerId, name) {
    return {id: id, attackerId: attackerId, targetId: 1, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: name, type: 'germany:Shooter', parts: PARTS()}, target: {name: 'Alpha', type: 'germany:Test', parts: PARTS()}, warnings: []};
  };
  const BATTLE = {id: 'b1', playerVehicleId: 1, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 1, name: 'Alpha', team: 1, player: ''}, {id: 2, name: 'Bravo', team: 2, player: ''}, {id: 3, name: 'Charlie', team: 2, player: ''}],
    hits: [HIT('h1', 2, 'Bravo'), HIT('h2', 3, 'Charlie')]};
  global.ArmorInspectorData.battle = function (id) { return id === 'b1' ? Promise.resolve(BATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (h) { return h.id === id; })[0], models: {}, warnings: []});
  };
  function shooterMarks() {
    return document.getElementById('focus-list').children
      .filter(function (c) { return c.getAttribute('data-role') === 'shooter'; })
      .map(function (c) { return c.getAttribute('data-id'); }).join(',');
  }
  const battles = document.getElementById('battles');
  battles.value = 'b1'; battles.onchange.call(battles);
  return settle(20).then(function () {
    ok('S0: the battle opens on its first hit, and the roster marks that hit’s shooter', shooterMarks() === '2', '(' + shooterMarks() + ')');
    const rows = document.getElementById('hits').children;
    ok('S0: (both hits are on the list)', rows.length === 2);
    rows[1].onclick();
    return settle(20);
  }).then(function () {
    ok('S0: a click on the second hit moves the mark to ITS shooter', shooterMarks() === '3', '(' + shooterMarks() + ')');
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    ok('S0: and back to the first', shooterMarks() === '2', '(' + shooterMarks() + ')');
    // ---- the ⇅ swap button of a recorded hit (user, 22.09: it had stopped appearing) -------------
    // It is about the hit, not about which list is open beside it: this page is in the Vehicles panel
    // (BullbaHost.params names a vehicle), and a recorded hit on screen used to lose the button there.
    const swap = document.getElementById('swap-roles');
    ok('swap: a recorded hit whose shooter has models offers the button in either panel',
       swap.hidden === false, '(hidden=' + swap.hidden + ')');
    // No modelKey and nothing being extracted either - but the catalogue knows this shooter's vehicle, so
    // his own export can be read and the button stands.
    BATTLE.hits.forEach(function (h) { h.attacker.parts = []; h.attacker.type = VEHICLE.type; });
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    ok('swap: a shooter with no parts is still offered while the catalogue knows his vehicle',
       document.getElementById('swap-roles').hidden === false,
       '(hidden=' + document.getElementById('swap-roles').hidden + ')');
    // Neither parts nor a catalogue row: this shooter genuinely has no model, and only then is it hidden.
    BATTLE.hits.forEach(function (h) { h.attacker.type = 'germany:Unknown'; });
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    ok('swap: and hidden only when the shooter has no model to be had at all',
       document.getElementById('swap-roles').hidden === true,
       '(hidden=' + document.getElementById('swap-roles').hidden + ')');
    BATTLE.hits.forEach(function (h) { h.attacker.type = 'germany:Shooter'; h.attacker.parts = PARTS(); });
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    document.getElementById('swap-roles').onclick();
    return settle(20);
  }).then(function () {
    const swap = document.getElementById('swap-roles');
    ok('swap: the click puts the shooter on screen and the button offers the way back',
       swap.hidden === false && swap.title.indexOf('Back to the recorded hit') === 0, '(' + swap.title + ')');
    swap.onclick();
    return settle(20);
  }).then(function () {
    ok('swap: and the way back returns to the recorded hit',
       document.getElementById('swap-roles').title.indexOf('Swap the model') === 0,
       '(' + document.getElementById('swap-roles').title + ')');
  });
}).then(function () {
  // ---- Crits (22.09): the hit tile carries the client's own icons, and not a word -------------------------
  if (RELOAD) return;
  if (!global.ArmorCrits) { console.log('(crit tile checks skipped: no web/crits.js in this copy)'); return; }
  const item = function (kind, type, extra, state) { return {kind: kind, type: type, extra: extra, state: state, from: 'damageInfo', tie: 'unique', dt: 0.02, event: 'c1'}; };
  const CHIT = function (id, attackerId, effect, part, crits) {
    const h = {id: id, attackerId: attackerId, targetId: 1, direction: 'incoming', damage: 100, receivedAt: 200, warnings: [],
               points: [{effect: effect, part: part, status: 'resolved'}], attacker: {name: 'Bravo', parts: []}, target: {name: 'Alpha', parts: []}};
    if (crits) h.crits = crits;
    return h;
  };
  const five = [item('device', 'track', 'leftTrack0', 'destroyed'), item('crew', 'gunner', 'gunner2', 'injured'),
                item('device', 'engine', 'engine', 'critical'), item('device', 'radio', 'radio', 'critical'),
                {kind: 'fire', type: 'fire', extra: 'engine', state: 'started', from: 'fireInfo', tie: 'unique', dt: 0.02, event: 'c9'}];
  const CBATTLE = {id: 'b2', playerVehicleId: 1, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 1, name: 'Alpha', team: 1, player: ''}, {id: 2, name: 'Bravo', team: 2, player: ''}],
    hits: [CHIT('c-items', 2, 6, 1, {schema: 1, code: 6, items: five.slice(0, 2), conflicts: [], maskTied: true, mask: 12582912}),
           CHIT('c-code', 2, 6, 1, null), CHIT('c-none', 2, 4, 1, null), CHIT('c-many', 2, 6, 1, {schema: 1, code: 6, items: five, conflicts: []}),
           CHIT('c-chassis', 2, 5, 0, null)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'b2' ? Promise.resolve(CBATTLE) : Promise.reject(new Error('no battle')); };
  const battles = document.getElementById('battles');
  battles.value = 'b2'; battles.onchange.call(battles);
  return settle(20).then(function () {
    const rows = document.getElementById('hits').children;
    const box = function (i) { return (rows[i] ? rows[i].children : []).filter(function (c) { return c.className === 'hit-crits'; })[0] || null; };
    const icons = function (i) { const b = box(i); return b ? b.children : []; };
    const iconOnly = function (i) {
      const b = box(i);
      return !!b && b.textContent === '' && b.children.every(function (c) { return c.tagName === 'IMG' && c.textContent === '' && !!c.title && /^web\/icons\/crits\/\w+\.png$/.test(c.src); });
    };
    ok('crits: (the five crit hits are on the list)', rows.length === 5, '(' + rows.length + ')');
    ok('crits: identified items give one icon each, titled, and no text on the tile',
       icons(0).length === 2 && iconOnly(0) && icons(0)[0].src === 'web/icons/crits/trackDestroyedSmall.png'
       && icons(0)[1].src === 'web/icons/crits/gunnerDestroyedSmall.png'
       && icons(0)[0].title === 'Left track destroyed\n• From: the vehicle’s damage report\n• Matched: by shooter and time'
       && /^Gunner 2 injured/.test(icons(0)[1].title), icons(0).map(function (c) { return c.title; }).join(' | '));
    ok('crits: the tile title names them too', /^Incoming from Bravo\n• Result: Damage 100 HP\n• Critical damage: Left track destroyed, Gunner 2 injured$/.test(rows[0].title), '(' + rows[0].title + ')');
    ok('crits: a crit code alone gives the one generic icon',
       icons(1).length === 1 && iconOnly(1) && icons(1)[0].src === 'web/icons/crits/hit_critical.png'
       && icons(1)[0].title === 'Critical hit\nA module or crew member was damaged; which one was not reported.', '(' + (icons(1)[0] || {}).title + ')');
    ok('crits: nothing known gives no crit element at all', box(2) === null && !/[Cc]rit/.test(rows[2].title), '(' + rows[2].title + ')');
    ok('crits: more than four items give three icons and the generic one listing all five',
       icons(3).length === 4 && iconOnly(3) && icons(3)[3].src === 'web/icons/crits/hit_critical.png'
       && /^Critical damage\n• /.test(icons(3)[3].title)
       && ['Left track destroyed', 'Gunner 2 injured', 'Engine damaged (critical)', 'Radio damaged (critical)', 'Fire started (engine)']
            .every(function (t) { return icons(3)[3].title.indexOf('\n• ' + t) >= 0; })
       && /\n• Radio damaged \(critical\): from [^\n]+/.test(icons(3)[3].title)
       && /\n• Engine damaged \(critical\)\n/.test(icons(3)[3].title)
       && icons(3).slice(0, 3).every(function (c) { return c.src !== 'web/icons/crits/hit_critical.png'; }), '(' + (icons(3)[3] || {}).title + ')');
    ok('crits: code 5 on the chassis with nothing named takes the chassis crit icon',
       icons(4).length === 1 && icons(4)[0].src === 'web/icons/crits/hit_critical_track.png' && /on the chassis/.test(icons(4)[0].title));
    // Tooltip markup (23.09): the row's tooltip is the one bubble of the row - its vehicle tile is bare, so it does
    // not cover the row's words with its own; a crit code alone reads "Not named" after the key.
    ok('crits: the row is one bubble - the vehicle tile in it carries no tooltip of its own; an unnamed crit says so',
       rows[0].children[0].className === 'vehicle-tile' && !rows[0].children[0].title
       && /\n• Critical damage: Not named$/.test(rows[1].title) && /\n• Critical damage: Not named, on the chassis$/.test(rows[4].title),
       '(' + rows[1].title + ' | ' + rows[4].title + ')');
    ok('crits: an icon that fails to load takes itself away, and the empty box with it',
       (function () { const b = box(1), i = b.children[0]; i.onerror(); return b.children.length === 0 && rows[1].children.indexOf(b) < 0; }()));
    const details = document.getElementById('details').children;
    const critRow = details.filter(function (d) { return d.getAttribute && d.getAttribute('data-detail') === 'crits'; })[0];
    ok('crits: the details pane of the open hit has a Critical damage row right after Result',
       !!critRow && critRow.children[0].textContent === 'Critical damage' && critRow.children[1].textContent === 'Left track destroyed, Gunner 2 injured'
       && details.indexOf(critRow) === details.findIndex(function (d) { return d.children && d.children[0] && d.children[0].textContent === 'Result'; }) + 1,
       details.map(function (d) { return d.children && d.children[0] ? d.children[0].textContent : d.tagName; }).join(','));
    rows[2].onclick();
    return settle(20);
  }).then(function () {
    const details = document.getElementById('details').children;
    ok('crits: and a hit with nothing known has no such row',
       details.length > 0 && !details.some(function (d) { return d.getAttribute && d.getAttribute('data-detail') === 'crits'; }));
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    // A tie that arrives with a later publish: the poll reloads the battle, the selected hit's fingerprint is the
    // same (crits are not in it), so the scene stays and only the one details row is redrawn in place.
    const again = JSON.parse(JSON.stringify(CBATTLE));
    again.hits[0].crits.items.push(item('device', 'engine', 'engine', 'destroyed'));
    global.ArmorInspectorData.battle = function (id) { return id === 'b2' ? Promise.resolve(again) : Promise.reject(new Error('no battle')); };
    global.ArmorInspectorData.index = function () { return Promise.resolve({application: 'local.armor_inspector', version: 'test', updatedAt: 999, battles: [{id: 'b2', startedAt: 1, map: 'Test', hits: 5}]}); };
    const scene = global.ArmorInspectorData.scene;
    global.ArmorInspectorData.scenes = 0;
    global.ArmorInspectorData.scene = function (b, id) { global.ArmorInspectorData.scenes++; return scene(b, id); };
    sidebarModes[0].onclick();   // back to Battles: the poll reloads the battle there only
    return settle(20).then(function () { global.ArmorInspectorData.scenes = 0; tick(5.1); return settle(30); });
  }).then(function () {
    const details = document.getElementById('details').children;
    const rows = details.filter(function (d) { return d.getAttribute && d.getAttribute('data-detail') === 'crits'; });
    const at = details.findIndex(function (d) { return d.children && d.children[0] && d.children[0].textContent === 'Result'; });
    ok('crits: a tie that arrives later redraws the one details row in place, without a new scene',
       global.ArmorInspectorData.scenes === 0 && rows.length === 1 && details.indexOf(rows[0]) === at + 1
       && rows[0].children[1].textContent === 'Left track destroyed, Engine destroyed, Gunner 2 injured',
       '(' + global.ArmorInspectorData.scenes + ' scenes, ' + rows.map(function (r) { return r.children[1].textContent; }).join(' / ') + ')');
    const tile = document.getElementById('hits').children[0].children.filter(function (c) { return c.className === 'hit-crits'; })[0];
    ok('crits: and the tile has its third icon', !!tile && tile.children.length === 3 && tile.children[1].src === 'web/icons/crits/engineDestroyedSmall.png');
  });
}).then(function () {
  // The shell a record does not name (user, 22.09: a grey model has no logic). The resolver now reads the
  // shooter's own list when the record narrowed nothing down, and the page assumes a shell instead of
  // colouring nothing. Checked here on the resolver itself plus the page's source: driving it through this
  // stub would need a hit open, and the stub page is browsing a vehicle by now.
  if (RELOAD) return;
  const SHELL = function (kind, name, cal, pen) { return {kind: kind, name: name, caliber: cal, penetration100: pen, speed: 800, gunInstallation: 0}; };
  const hitOf = function (kind, shells) {
    return {id: 'x', attackerId: 2, targetId: 1, damage: 100, receivedAt: 100, effectsIndex: 1,
            points: [{part: 0, status: 'resolved', shellKind: kind, caliber: 100}],
            availableShells: shells, shellCandidates: [], target: {parts: []}};
  };
  // The page runs against a stubbed resolver, so the real one is loaded here on its own, into its own root.
  const realShot = new Function('window', fs.readFileSync(path + 'shot-context.js', 'utf8') + ';return window.ArmorShotContext;')({});
  const one = realShot.resolve(hitOf('ARMOR_PIERCING_CR', [SHELL('ARMOR_PIERCING_CR', 'AP CR', 100, 250)]), []);
  ok('shells: the only shell the shooter can load, agreeing with the hit, is the hit’s own',
     one.index === 0 && one.choices.length === 1, '(' + one.index + ')');
  const off = realShot.resolve(hitOf('HIGH_EXPLOSIVE', [SHELL('ARMOR_PIERCING_CR', 'AP CR', 100, 250)]), []);
  ok('shells: a list that holds nothing of the hit’s type stays undetermined', off.index === -1, '(' + off.index + ')');
  const three = realShot.resolve(hitOf('HIGH_EXPLOSIVE',
    [SHELL('ARMOR_PIERCING', 'AP', 100, 200), SHELL('HIGH_EXPLOSIVE', 'HE', 100, 45), SHELL('HOLLOW_CHARGE', 'HEAT', 100, 300)]), []);
  ok('shells: one shell of the hit’s type among several is the hit’s own', three.index === 1, '(' + three.index + ')');
  // Lighting depth (user, 22.09): the slider scales the composite's brightness range and nothing else.
  const depth = document.getElementById('light-strength');
  depth.type = 'range'; depth.min = '0'; depth.max = '250'; depth.step = '5';
  depth.value = '0'; depth.oninput.call(depth);
  ok('lighting: the depth slider reaches the viewer as a factor and prints its per cent',
     viewerInstance.lightStrength === 0 && document.getElementById('light-strength-value').textContent === '0 %',
     '(' + viewerInstance.lightStrength + ')');
  depth.value = '250'; depth.oninput.call(depth);
  ok('lighting: and follows to its end', viewerInstance.lightStrength === 2.5, '(' + viewerInstance.lightStrength + ')');
  depth.value = '100'; depth.oninput.call(depth);
  const switchBox = document.getElementById('soft-lighting');
  switchBox.checked = false; switchBox.onchange.call(switchBox);
  ok('lighting: the depth is greyed out with the light off', depth.disabled === true);
  switchBox.checked = true; switchBox.onchange.call(switchBox);
  ok('lighting: and live again with it on', depth.disabled === false && viewerInstance.lighting === true);
  const surfaceSrc = fs.readFileSync(path + 'screen-armor.js', 'utf8');
  ok('lighting: the depth only moves the composite brightness range',
     /uLightRange\.value\.set\(this\.lightFloor\(\),LIGHT_MAX\)/.test(surfaceSrc)
     && /LIGHT_MAX-\(LIGHT_MAX-LIGHT_MIN\)\*s/.test(surfaceSrc));
  // Which of several indistinguishable shells is assumed (user, 22.09: the deeper penetration was likelier).
  const S = function (kind, pen, alpha) { return {kind: kind, name: kind + pen, caliber: 100, penetration100: pen, alpha: alpha, damageRandomization: .25, speed: 800}; };
  const two = [S('HIGH_EXPLOSIVE', 92, 300), S('HIGH_EXPLOSIVE', 230, 300)];
  ok('shells: of two the record cannot tell apart, the deeper penetration is assumed',
     realShot.assume(two, 'HIGH_EXPLOSIVE', 0).index === 1 && /deepest penetration/.test(realShot.assume(two, 'HIGH_EXPLOSIVE', 0).reason),
     '(' + JSON.stringify(realShot.assume(two, 'HIGH_EXPLOSIVE', 0)) + ')');
  const alphas = [S('HIGH_EXPLOSIVE', 92, 500), S('HIGH_EXPLOSIVE', 230, 300)];
  ok('shells: a recorded damage only one of them can do decides instead of the penetration',
     realShot.assume(alphas, 'HIGH_EXPLOSIVE', 480).index === 0
     && /recorded damage/.test(realShot.assume(alphas, 'HIGH_EXPLOSIVE', 480).reason), '(' + realShot.assume(alphas, 'HIGH_EXPLOSIVE', 480).index + ')');
  ok('shells: damage above what either can do is no evidence, so the penetration decides again',
     realShot.assume(alphas, 'HIGH_EXPLOSIVE', 900).index === 1, '(' + realShot.assume(alphas, 'HIGH_EXPLOSIVE', 900).index + ')');
  ok('shells: a damage under both windows - the target had that much left - excludes neither',
     realShot.assume(alphas, 'HIGH_EXPLOSIVE', 40).index === 1, '(' + realShot.assume(alphas, 'HIGH_EXPLOSIVE', 40).index + ')');
  ok('shells: a type the list does not hold is left to the page’s own fallback',
     realShot.assume(two, 'ARMOR_PIERCING', 0).index === -1);
  const appSrc = fs.readFileSync(path + 'app.js', 'utf8');
  ok('shells: the page assumes a shell of the hit’s type when nothing is determined, and marks it',
     /shellAssumed=guess\.index/.test(appSrc) && /'◌ Assumed shell'/.test(appSrc)
     && /Assumed: the record does not say which shell it was/.test(appSrc)
     && appSrc.indexOf('Pick a shell — several matches') < 0);

  // ---- distance laws (23.09, BACKLOG № 32): penetration and damage over the flight ----------------------
  // The client has one law for both (helpers_common.computePiercingPowerAtDist / computeDamageAtDist): the first
  // value up to 50 m, the line through the second at 500 m which goes ON past 500 m, never below 0; its reticle
  // gives 0 from the shot's maxDistance on. The law lives in ballistics.js alone, and shellAt, the damage window
  // of the shell choice, the ✸ roll, the log line and the characteristics panel all take it from there.
  const AB = global.ArmorBallistics;
  const r1 = function (x) { return Math.round(x * 10) / 10; };
  const APCR218 = {kind: 'ARMOR_PIERCING_CR', name: 'APCR 218', penetration100: 218, penetration500: 194, caliber: 105, maxDistance: 720, alpha: 390, damageRandomization: .25};
  const penRow = [50, 100, 300, 500, 650, 719, 720, 900].map(function (d) { return r1(AB.penetrationAt(APCR218, d)); });
  ok('distance: APCR 218/194 - 218 up to 50 m, 215.3 at 100 m, 204.7 at 300, 194 at 500, then on to 186 at 650 m, and 0 from its maxDistance 720 m on',
     JSON.stringify(penRow) === JSON.stringify([218, 215.3, 204.7, 194, 186, 182.3, 0, 0]), '(' + penRow.join(' ') + ')');
  ok('distance: a record without maxDistance keeps the line going (no zero it cannot know), a shell whose two values are equal keeps its value up to maxDistance',
     r1(AB.penetrationAt({penetration100: 218, penetration500: 194}, 900)) === 172.7
     && AB.penetrationAt({penetration100: 300, penetration500: 300, maxDistance: 720}, 650) === 300
     && AB.penetrationAt({penetration100: 300, penetration500: 300, maxDistance: 720}, 720) === 0);
  // Błyskawica's APCR as the record has it (PP-GG m85/175: 292/278, alpha 800, alphaFar 300 - damageMutable).
  const BLY = {kind: 'ARMOR_PIERCING_CR', name: 'PP-GG m85/175', caliber: 85, penetration100: 292, penetration500: 278, maxDistance: 720,
               alpha: 800, alphaFar: 300, damageRandomization: .25};
  const alphaRow = [30, 300, 500, 700].map(function (d) { return Math.round(AB.alphaAt(BLY, d)); });
  ok('distance: Błyskawica APCR alpha 800 up to 50 m, 522 at 300 m, 300 at 500 m and on down to 78 at 700 m',
     JSON.stringify(alphaRow) === JSON.stringify([800, 522, 300, 78]), '(' + alphaRow.join(' ') + ')');
  ok('distance: a shell without alphaFar, and one whose two values are equal, keep their alpha at every range',
     [30, 300, 700].every(function (d) { return AB.alphaAt({alpha: 400}, d) === 400 && AB.alphaAt({alpha: 400, alphaFar: 400}, d) === 400; }));
  // shellAt, cut out of app.js: the page's shell at a distance.
  const cutFn = function (name) {
    const at = appSrc.indexOf('  function ' + name + '(');
    if (at < 0) return null;
    let i = appSrc.indexOf('{', at), depth = 0;
    for (; i < appSrc.length; i++) { if (appSrc[i] === '{') depth++; else if (appSrc[i] === '}' && --depth === 0) break; }
    return appSrc.slice(at, i + 1);
  };
  const pageShell = new Function('ArmorBallistics', 'function targetFactor(){return 1;}function manualDamageFrom(){return null;}var MANUAL_DAMAGE_KEYS=[];\n'
    + cutFn('shellAt') + '\n' + cutFn('damageColumns') + '\nreturn {shellAt:shellAt,damageColumns:damageColumns};')(AB);
  const b30 = pageShell.shellAt(BLY, BLY.kind, 292, 85, 30, null, null, '800'), b300 = pageShell.shellAt(BLY, BLY.kind, 292, 85, 300, null, null, '800');
  const b500 = pageShell.shellAt(BLY, BLY.kind, 292, 85, 500, null, null, '800'), b700 = pageShell.shellAt(BLY, BLY.kind, 292, 85, 700, null, null, '800');
  ok('distance: the page’s shell (shellAt) - Błyskawica APCR 800 at 30 m, 522 at 300, 300 at 500, 78 at 700, the field’s 800 kept beside it',
     b30.alpha === 800 && b30.alphaNear === undefined && Math.round(b300.alpha) === 522 && b300.alphaNear === 800
     && Math.round(b500.alpha) === 300 && Math.round(b700.alpha) === 78,
     '(' + [b30.alpha, b300.alpha, b500.alpha, b700.alpha].map(Math.round).join(' ') + ')');
  ok('distance: and its penetration by the same law - 292 at 30 m, 284.2 at 300 m',
     b30.penetration === 292 && r1(b300.penetration) === 284.2, '(' + r1(b300.penetration) + ')');
  const typed = pageShell.shellAt(BLY, BLY.kind, 292, 85, 300, null, null, '1000');
  ok('distance: an alpha typed over the record’s falls off by the record’s own factor (1000 at the muzzle - 653 at 300 m)',
     Math.round(typed.alpha) === 653 && typed.alphaNear === 1000, '(' + Math.round(typed.alpha) + ')');
  const AP400 = {kind: 'ARMOR_PIERCING', name: 'AP 250', caliber: 120, penetration100: 250, penetration500: 230, maxDistance: 720, alpha: 400};
  const ap700 = pageShell.shellAt(AP400, AP400.kind, 250, 120, 700, null, null, '400');
  ok('distance: a shell without alphaFar is exactly what it was - alpha 400 at 700 m, no second alpha on it',
     ap700.alpha === 400 && !('alphaNear' in ap700) && r1(ap700.penetration) === 221.1, '(' + ap700.alpha + ', ' + r1(ap700.penetration) + ')');
  const a650 = pageShell.shellAt(APCR218, APCR218.kind, 218, 105, 650, null, null, '390'), a720 = pageShell.shellAt(APCR218, APCR218.kind, 218, 105, 720, null, null, '390');
  ok('distance: shellAt gives APCR 218/194 186 mm at 650 m and 0 at its maxDistance',
     Math.round(a650.penetration) === 186 && a720.penetration === 0, '(' + a650.penetration + ', ' + a720.penetration + ')');
  ok('distance: the Statistics log line of such a shell carries the server’s damage, the alpha at the range and the one up to 50 m; others nothing new',
     pageShell.damageColumns({damage: 480}, {}, b300) === ' dmg=480 alpha=522 alphaNear=800'
     && pageShell.damageColumns({damage: 400}, {}, ap700) === '', '(' + pageShell.damageColumns({damage: 480}, {}, b300) + ')');
  // The ✸ roll: its damage base is the shell's alpha - the one at the range.
  const funA = appSrc.indexOf('  function funOn()'), funB = appSrc.indexOf('  // Everything the emulation holds', funA);
  const funD = new Function('$', 'window', 'chanceRgb', 'var viewer=null,current=null,activeHit=null;function ttxHealth(){return 0;}\n'
    + appSrc.slice(funA, funB) + '\nreturn {funVerdict:funVerdict};')(function () { return new Element('div'); }, {}, function () { return ''; });
  const rolled = funD.funVerdict({reason: 'penetration', chance: 100, screenPass: 1}, b300);
  ok('distance: the ✸ damage roll of a penetration at 300 m starts from 522, not 800',
     rolled.outcome === 'pen' && Math.round(rolled.base) === 522, '(' + JSON.stringify(rolled) + ')');
  // The shell choice: the damage window at the shot's range. A 450 HP hit at 300 m from a shooter who carries
  // Błyskawica's APCR and a deeper-piercing APCR of alpha 700: at the muzzle neither window holds 450 and the
  // deeper one was taken; at 300 m Błyskawica's window (392-653) alone holds it.
  const shotAB = new Function('window', fs.readFileSync(path + 'shot-context.js', 'utf8') + ';return window.ArmorShotContext;')({ArmorBallistics: AB});
  const pairAB = [BLY, {kind: 'ARMOR_PIERCING_CR', name: 'deeper', caliber: 85, penetration100: 330, penetration500: 300, alpha: 700, damageRandomization: .25}];
  const at300 = shotAB.assume(pairAB, 'ARMOR_PIERCING_CR', 450, 300), noRange = shotAB.assume(pairAB, 'ARMOR_PIERCING_CR', 450);
  ok('distance: the shell choice keeps Błyskawica’s APCR for a 450 HP hit at 300 m (the window at the range), where the muzzle window took the other',
     at300.index === 0 && /recorded damage/.test(at300.reason) && noRange.index === 1, '(' + at300.index + ' / ' + noRange.index + ')');
  // One copy of the law: every caller asks ballistics.js, and the old (d-100)/400 is gone from the page.
  const ttxSrc = fs.readFileSync(path + 'ttx.js', 'utf8'), ctxSrc = fs.readFileSync(path + 'shot-context.js', 'utf8');
  ok('distance: shellAt, the shell choice and the characteristics panel ask ballistics.js, and no second copy of the law is left',
     /ArmorBallistics\.penetrationAt\(c,distance\)/.test(appSrc) && /ArmorBallistics\.alphaAt\(c,distance\)/.test(appSrc)
     && /B\.alphaAt\(c,range\)/.test(ctxSrc) && /R\.atDistance\(P, far, d\)/.test(ttxSrc)
     && !/\/400/.test(appSrc) && !/\/ ?450/.test(appSrc + ctxSrc + ttxSrc)
     // BACKLOG 38 (23.09): both calls hand on the Borkenkäfer's mark as well (the window's top on a marked target).
     && /assume\(context\.choices,context\.kind,hit\.damage,context\.range,context\.mark\)/.test(appSrc)
     && /assume\(recorded,shotContext\.kind,hit&&hit\.damage,shotContext\.range,shotContext\.mark\)/.test(appSrc));
  ok('distance: the characteristics panel’s 500 m figure is the garage’s - 194 for 218/194, 199.3 at int(maxDistance) for a shell that flies 400 m',
     (function () { const v = global.BullbaTtx && global.BullbaTtx.values({shells: [APCR218, Object.assign({}, APCR218, {maxDistance: 400})]});
       return !!v && v.shells[0].pen500 === 194 && r1(v.shells[1].pen500) === 199.3; })());
  // Crits: leftTrack1 / rightTrack1 is the OUTER pair of a twin-track vehicle (trackPairParams, O1).
  const critSrc = fs.readFileSync(path + 'crits.js', 'utf8');
  ok('crits: track 1 is called the outer track', critSrc.indexOf("m[2]==='1'?'outer track'") > 0 && critSrc.indexOf('inner track') < 0);

  // ---- the shooter's two modes and the ballistic check (22.09) ----------------------------------
  // outputs/mode-shell-modifiers-2026-09-22.md P1-P3. Six vehicles of this client fire different shell
  // parameters in their second mode, and until now the page showed the Gorilla's low-charge hits as a
  // determined full-charge shell. The resolver is exercised on its own, as the shell checks above are.
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // A hit with a real matched tracer: an endpoint event at the contact point, inside the resolver's own
  // 0.75 m / 0.1 s window, is what makes resolve() adopt the tracer at all.
  const modeHit = function (o) {
    return {id: 'm', attackerId: 7, targetId: 1, damage: o.damage === undefined ? 0 : o.damage,
            receivedAt: 100, effectsIndex: o.effectsIndex,
            points: [{part: 0, status: 'resolved', position: [0, 0, 0], shellKind: o.kind, caliber: o.caliber}],
            availableShells: o.shells, shellCandidates: [], attacker: o.attacker || {},
            target: {worldTransform: IDENT, parts: [{id: 0, transform: IDENT}]}};
  };
  const modeEvents = function (speed, gravity, extra) {
    const t = {event: 'tracer', id: 't1', shooterId: 7, effectsIndex: 42, receivedAt: 99.9, isRicochet: false,
               gunInstallationIndex: 0, own: false, origin: [0, 0, 100], velocity: [speed, 0, 0], gravity: gravity};
    if (extra) Object.keys(extra).forEach(function (k) { t[k] = extra[k]; });
    return [t, {event: 'stop', id: 'e1', tracerId: 't1', receivedAt: 100, position: [0, 0, 0]}];
  };
  const MODE_SHELL = function (o) {
    return {kind: o.kind, name: o.name, caliber: o.caliber, penetration100: o.pen, penetration500: o.pen - 30,
            speed: o.speed, gravity: o.gravity, alpha: o.alpha, damageRandomization: .25,
            normalization: o.norm || 0, ricochetCos: o.ric === undefined ? -.34 : o.ric,
            effectsIndex: o.effects, gunInstallation: 0, gun: 'test'};
  };
  // P1. One candidate is still only a candidate: the three measured Gorilla hits used to come back as a
  // determined shell whose speed the tracer flatly contradicts.
  const fullAPCR = MODE_SHELL({kind: 'ARMOR_PIERCING_CR', name: 'APCR MPCS', caliber: 155, pen: 385,
                               speed: 1100, gravity: 9.81, alpha: 800, effects: 50});
  const lowAPCR = MODE_SHELL({kind: 'ARMOR_PIERCING_CR', name: 'APCR MPCS', caliber: 155, pen: 325,
                              speed: 950, gravity: 9.81, alpha: 390, effects: 42});
  const onlyFull = modeHit({kind: 'ARMOR_PIERCING_CR', caliber: 155, effectsIndex: 42, shells: [fullAPCR], damage: 390});
  // The server scales every shot's (v, g) by the same k, so 826.9 m/s at g = 7.4335 is v/sqrt(g) = 303.3 -
  // the low charge - while the only shell in the list is 1100/sqrt(9.81) = 351.2.
  const wrong = realShot.resolve(onlyFull, modeEvents(826.9, 7.4335));
  ok('modes: a lone candidate the tracer ballistics contradict is NOT determined',
     wrong.index === -1 && !!wrong.tracer && /ballistics/.test(wrong.unresolvedWhy || ''),
     '(' + wrong.index + ' / ' + wrong.unresolvedWhy + ')');
  const right = realShot.resolve(onlyFull, modeEvents(1100, 9.81));
  ok('modes: and the same lone candidate the tracer agrees with still is',
     right.index === 0 && !!right.tracer, '(' + right.index + ')');
  ok('modes: a hit with no tracer at all is judged exactly as before',
     realShot.resolve(onlyFull, []).index === 0);
  // P2. The same hit once the recorder writes the second mode's shells: the low charge is named.
  const gorilla = modeHit({kind: 'ARMOR_PIERCING_CR', caliber: 155, effectsIndex: 42, shells: [fullAPCR], damage: 390,
                           attacker: {vehicleMode: 0, modeShellsMode: 1, modeShells: [lowAPCR],
                                      aim: {dispersion: .003, gunMechanics: ['lowChargeShot']}}});
  const low = realShot.resolve(gorilla, modeEvents(826.9, 7.4335));
  ok('modes: with the second mode recorded, the low-charge shell is the answer',
     low.index >= 0 && low.choices[low.index] && low.choices[low.index].alpha === 390
     && low.choices[low.index].vehicleMode === 1,
     '(' + low.index + ' / ' + (low.choices[low.index] && low.choices[low.index].alpha) + ')');
  ok('modes: and it is named with the client own word for that state',
     realShot.modeLabel(gorilla, low.choices[low.index]) === 'low charge',
     '(' + realShot.modeLabel(gorilla, low.choices[low.index]) + ')');
  // P3. The five German switchers: both modes fire the same speed, gravity, penetration and effects id,
  // so only the recorded siege state or the damage can tell them apart.
  const swBase = {kind: 'ARMOR_PIERCING_CR', name: 'Pzgr. 67', caliber: 105, pen: 268, speed: 1478,
                  gravity: 9.81, effects: 17};
  const swDefault = MODE_SHELL(Object.assign({}, swBase, {alpha: 420, norm: 2 * Math.PI / 180, ric: Math.cos(70 * Math.PI / 180)}));
  const swSiege = MODE_SHELL(Object.assign({}, swBase, {alpha: 380, norm: 7 * Math.PI / 180, ric: Math.cos(75 * Math.PI / 180)}));
  const swHE = MODE_SHELL({kind: 'HIGH_EXPLOSIVE', name: 'Sprgr. 67', caliber: 105, pen: 53, speed: 1000,
                           gravity: 9.81, alpha: 420, effects: 18});
  const switcher = function (damage, extra) {
    return modeHit({kind: 'ARMOR_PIERCING_CR', caliber: 105, effectsIndex: 17, damage: damage,
                    shells: [swDefault, swHE],
                    attacker: Object.assign({vehicleMode: 0, modeShellsMode: 1, modeShells: [swSiege, swHE],
                                             aim: {dispersion: .0018, gunMechanics: ['shellParamsSwitcher']}}, extra || {})});
  };
  // The switchers leave their HE alone, so the second list's copy of it must not double the shell list.
  const bands = realShot.resolve(switcher(300), []);
  ok('modes: a mode shell the mode did not change is not offered twice',
     bands.choices.length === 3, '(' + bands.choices.length + ')');
  ok('modes: without any evidence the switcher state stays unknown and the page must assume',
     bands.index === -1 && /switches its shell parameters/.test(bands.unresolvedWhy || ''),
     '(' + bands.index + ' / ' + bands.unresolvedWhy + ')');
  const bySiege = realShot.resolve(switcher(300), modeEvents(1478, 9.81, {effectsIndex: 17, siegeState: 2}));
  ok('modes: the siege state recorded at the tracer names the set',
     bySiege.index >= 0 && bySiege.choices[bySiege.index].alpha === 380
     && /state at the shot/.test(bySiege.source), '(' + bySiege.index + ' / ' + bySiege.source + ')');
  const byImpact = realShot.resolve(switcher(300, {siegeStateAtImpact: 0}), []);
  ok('modes: and the state read at the impact does when the tracer carries none',
     byImpact.index >= 0 && byImpact.choices[byImpact.index].alpha === 420
     && /state at the impact/.test(byImpact.source), '(' + byImpact.index + ' / ' + byImpact.source + ')');
  // 380 x 1.25 = 475: a hit for 500 cannot have come out of the siege band, so the default one it is.
  const byDamage = realShot.resolve(switcher(500), []);
  ok('modes: damage above the second mode whole band leaves only the default set',
     byDamage.index >= 0 && byDamage.choices[byDamage.index].alpha === 420
     && /damage band/.test(byDamage.source), '(' + byDamage.index + ' / ' + byDamage.source + ')');
  ok('modes: the client own words for a switcher two states',
     realShot.modeLabel(switcher(300), bands.choices[0]) === 'straight armour'
     && realShot.modeLabel(switcher(300), bands.choices[2]) === 'angled armour',
     '(' + realShot.modeLabel(switcher(300), bands.choices[0]) + ' / ' + realShot.modeLabel(switcher(300), bands.choices[2]) + ')');
  ok('modes: a record without the new fields keeps exactly the list it had',
     realShot.resolve(modeHit({kind: 'ARMOR_PIERCING_CR', caliber: 105, effectsIndex: 17, damage: 300,
                               shells: [swDefault, swHE]}), []).choices.length === 2);
  // The page's own side: the chip marker, the tooltip and the Onslaught line of the Config tooltip.
  ok('modes: the shell chip carries the second-mode marker and explains it in the tooltip',
     /second=c\.vehicleMode===1/.test(appSrc) && /The shooter fired in his second mode/.test(appSrc));
  ok('modes: the battle own modifiers reach the aim block and the Config tooltip',
     /battleModifiersDescr/.test(appSrc) && /aimBattleModifiers/.test(appSrc)
     && /shotDispersionRadius: 'dispersion'/.test(appSrc) && /Not applied: /.test(appSrc));
}).then(function () {
  // ================ The fun layer (user, 22.09): target HP, the rolled shot, the Hitmarks ============
  // ONE switch, and it stands on the SCENE beside the collision-model tile: the two Settings rows of
  // 0.7.25 are gone (user, 22.09). Checked in four ways, because the feature lives in four places: the
  // markup carries the switch and the stored control, the page's own arithmetic is CUT OUT of web/app.js
  // and run on a seeded source (the way tools/verdicts_offline.cjs cuts out the verdict code, so there is
  // no private copy of it here), the wiring is driven through the page with the stub viewer, and the
  // geometry - the drawn point, the one ray, the instanced discs - runs on the REAL viewer.js over a box
  // model in three.js.
  if (RELOAD) return;
  const THREE = global.THREE, RealViewer = global.RealViewerCtor;
  const styleSrc = fs.readFileSync(path + 'style.css', 'utf8');
  const NB = ' ';   // the thin space the page groups thousands with

  // ---- 0. the markup: one switch, on the scene, lit while it is on -------------------------------
  ok('fun: the two Settings rows are gone and the state rides in ONE hidden control of the menu',
     pageSrc.indexOf('id="target-hp-on"') < 0 && pageSrc.indexOf('id="hit-marks-on"') < 0
     && /<input type="checkbox" id="fun-mode" hidden/.test(pageSrc)
     && pageSrc.indexOf('id="fun-mode"') < pageSrc.indexOf('id="reset-settings"'));
  const modelRow = pageSrc.slice(pageSrc.indexOf('<div class="model-row"'), pageSrc.indexOf('<div id="target-mods-slot"'));
  // Strip (23.09): the glyph ✸ said nothing (user: "a star of some kind") - the switch is a drawn crosshair now, and
  // the help rows name it by the ⌖ its data-glyph carries; the bar and ↺ went into the strip beside it.
  ok('fun: the switch the user sees is a .swap-roles button in the model tile’s own row - an icon only, before the bar and the ↺',
     /<button type="button" id="fun-mode-toggle" class="swap-roles" aria-pressed="false" data-glyph="⌖"/.test(modelRow)
     && modelRow.indexOf('id="model-tile"') < modelRow.indexOf('id="fun-mode-toggle"')
     && modelRow.indexOf('id="fun-mode-toggle"') < modelRow.indexOf('id="target-hp"')
     && modelRow.indexOf('id="target-hp"') < modelRow.indexOf('id="target-hp-reset"')
     && /aria-label="Target HP, RNG shots and Hitmarks" hidden><svg class="fun-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="4\.6"\/><path d="M8 1v3\.6M8 11\.4V15M1 8h3\.6M11\.4 8H15"\/><circle class="fun-icon-dot" cx="8" cy="8" r="1\.2"\/><\/svg><\/button>/.test(modelRow)
     && pageSrc.indexOf('>✸<') < 0);
  ok('fun: its tooltip says first what the switch does (user 23.09: the essence, not a wall), in the user word for the marks, and no longer promises a colour',
     // The tooltip markup of 23.09 (tooltips.js): a heading, the one line that says what it does (a help dot shows
     // just these two), then '• Key: text' points, &#10; between lines.
     (function (t) {
       return /^Shooting emulation&#10;On: you shoot the vehicle on screen as in a battle — it loses HP, shots scatter in the aiming circle, hits leave Hitmarks\.&#10;/.test(t)
         && /&#10;• HP bar: the target’s health; ↺ refills it and clears the Hitmarks&#10;/.test(t)
         && /&#10;Off: the recorded shot only\.$/.test(t) && t.length < 520;
     })((/id="fun-mode-toggle"[^>]*title="([^"]*)"/.exec(modelRow) || [])[1] || '')
     && modelRow.indexOf('Hit marks') < 0 && modelRow.indexOf('outcome colour') < 0);
  ok('fun: a .swap-roles that is a switch is LIT in the page’s own accent, the very state the chips and pills wear',
     /\.swap-roles\[aria-pressed=true\]\{border-color:var\(--gold\);color:var\(--gold\);background:#302b23\}/.test(styleSrc));
  // ---- the sweep of every vehicle's characteristics (24.09): its block of app.js cut out and run on stubs -------------
  (function sweepChecks() {
    const from = appSrc.indexOf("  // THE SWEEP OF EVERY VEHICLE'S CHARACTERISTICS"), to = appSrc.indexOf('  sweepTick();\n', from);
    ok('sweep: its block of app.js can be cut out, and the poll runs it', from > 0 && to > from
       && /refresh\(\);if\(sidebarMode==='vehicles'\)loadCatalogue\(\);\n    sweepTick\(\);/.test(appSrc) && /modelsPending\|\|sweepRunning\?2000:5000/.test(appSrc));
    const tipJoinCut = (/\n  function tipJoin\(lines\) \{[\s\S]*?\n  \}\n/.exec(appSrc) || [''])[0];
    function page(game, file, hidden) {
      const els = {}, sent = [], reads = {n: 0};
      const $ = function (id) { return els[id] || (els[id] = {id: id, hidden: true, textContent: '', title: '', style: {}, onclick: null}); };
      const host = {game: game}, doc = {hidden: !!hidden};
      const data = {ttxSweep: function () { reads.n++; const f = file(); return f ? Promise.resolve(f) : Promise.reject(new Error('Not found data/ttx-sweep.js')); }};
      const run = new Function('$', 'host', 'sendCommand', 'ArmorInspectorData', 'document', tipJoinCut + appSrc.slice(from, to)
        + 'return {tick: sweepTick, paint: paintSweep, running: function () { return sweepRunning; }};');
      const api = run($, host, function (action) { sent.push(action); }, data, doc);
      api.tick();   // the block's own first call at load (left out of the cut)
      return {$: $, sent: sent, reads: reads, api: api, doc: doc, host: host};
    }
    const settleMicro = function () { return new Promise(function (r) { setImmediate(r); }); };
    let file = {done: false, count: 0, total: 1343, catalogue: 1343, confirmed: false, built: 0, builtMs: 0};
    const g = page(true, function () { return file; });
    return settleMicro().then(function () {
      const ask = g.$('ttx-sweep-ask');
      ok('sweep: in the game the page tells the mod it is open, and reads the progress file',
         g.sent[0] === 'open' && g.reads.n === 1 && g.$('ttx-sweep').hidden === false && g.$('ttx-sweep-count').textContent === '0 / 1343');
      ok('sweep: a first sweep asks - heading, one sentence with the estimate (40 ms a vehicle before this machine has built any), Start and Later',
         ask.hidden === false && g.$('ttx-sweep-ask-head').textContent === 'First start after a game update'
         && g.$('ttx-sweep-ask-text').textContent === 'Preparing the characteristics of all 1343 vehicles takes about 70 s (an estimate); the hangar stutters meanwhile.'
         && g.$('ttx-sweep-go').textContent === 'Start' && g.$('ttx-sweep-stop').hidden === true, g.$('ttx-sweep-ask-text').textContent);
      g.$('ttx-sweep-go').onclick();
      ok('sweep: Start - the question goes, the mod is told, the ■ Stop stands', ask.hidden === true && g.sent.indexOf('sweepStart') >= 0
         && g.$('ttx-sweep-stop').hidden === false && g.api.running());
      file = {done: false, count: 340, total: 1343, catalogue: 1343, confirmed: false, built: 340, builtMs: 6800};
      g.api.paint(file);
      ok('sweep: a read of the file from before the mod took the Start does not bring the question back', ask.hidden === true && g.$('ttx-sweep-stop').hidden === false);
      g.$('ttx-sweep-stop').onclick();
      ok('sweep: ■ Stop - the mod is told at once, the ■ goes, and this page asks no more', g.sent.indexOf('sweepStop') >= 0
         && g.$('ttx-sweep-stop').hidden === true && ask.hidden === true && g.$('ttx-sweep').hidden === false);
      // The next open of the page: the sweep that was stopped asks again, with how far it got.
      const n = page(true, function () { return file; });
      return settleMicro().then(function () {
        const ask2 = n.$('ttx-sweep-ask');
        ok('sweep: the next open asks again - how far it got and the time left at this machine\'s own pace, Continue and Later',
           ask2.hidden === false && n.$('ttx-sweep-ask-head').textContent === 'Preparation not finished'
           && n.$('ttx-sweep-ask-text').textContent === '340 of 1343 vehicles done (25 %), about 27 s left (an estimate).'
           && n.$('ttx-sweep-go').textContent === 'Continue', n.$('ttx-sweep-ask-text').textContent);
        n.$('ttx-sweep-later').onclick();
        n.api.paint(file);
        ok('sweep: Later - the question goes for this open of the page, nothing is sent', ask2.hidden === true && n.sent.indexOf('sweepStart') < 0);
        // A game update that changed twelve vehicles.
        const u = page(true, function () { return {done: false, count: 0, total: 12, catalogue: 1343, confirmed: false, built: 1343, builtMs: 26860}; });
        return settleMicro().then(function () {
          ok('sweep: after an update only the vehicles that changed - "12 vehicles changed", about 1 s',
             u.$('ttx-sweep-ask-head').textContent === 'The game was updated'
             && u.$('ttx-sweep-ask-text').textContent === '12 vehicles changed: preparing their characteristics takes about 1 s (an estimate); the hangar stutters meanwhile.',
             u.$('ttx-sweep-ask-text').textContent);
          const d = page(true, function () { return {done: true, count: 0, total: 0, catalogue: 1343}; });
          return settleMicro().then(function () {
            d.api.tick(); d.api.tick();
            ok('sweep: done - no question, no bar, no "open", the file is not read again', d.$('ttx-sweep-ask').hidden === true && d.$('ttx-sweep').hidden === true
               && d.reads.n === 1 && d.sent.length === 1, d.reads.n + ' reads, ' + d.sent.join());
            const b = page(false, function () { return null; });
            return settleMicro().then(function () {
              b.api.tick(); b.api.tick();
              ok('sweep: outside the game - no "open", no question, and a missing file is not read again (review #9)',
                 b.sent.length === 0 && b.reads.n === 1 && b.$('ttx-sweep-ask').hidden === true);
              const h = page(true, function () { return file; }, true);
              return settleMicro().then(function () {
                ok('sweep: a page not on screen does not say it is open (review #9)', h.sent.indexOf('open') < 0);
              });
            });
          });
        });
      });
    });
  })();
  ok('fun: the stored values of the two old rows are dropped when a store from 0.7.25 is read',
     /delete box\.values\['target-hp-on'\];delete box\.values\['hit-marks-on'\];/.test(appSrc));

  // ---- 1. the page's own arithmetic, cut out of app.js and run on a seeded source ----------------
  const funStart = appSrc.indexOf('  function funOn()');
  const funEnd = appSrc.indexOf('  // Everything the emulation holds', funStart);
  ok('fun: the layer is one block of app.js and can be cut out of it', funStart > 0 && funEnd > funStart);
  const funSrc = appSrc.slice(funStart, funEnd);
  ok('fun: it casts no ray and re-evaluates no armour of its own - it reads the verdict of the pinned line',
     !/engine\.ray|new\s+THREE\.Raycaster|sampleCircle|aimProfile/.test(funSrc) && /viewer\.pinResult/.test(funSrc));
  ok('fun: the random source is one module-level function that falls back to Math.random',
     /function rng\(\)\s*\{[^}]*BullbaHitsRng[^}]*Math\.random\(\)/.test(funSrc));
  ok('fun: the whole layer is read from the ONE switch, and the two old ids are nowhere in it',
     /function funOn\(\) \{ var e = \$\('fun-mode'\)/.test(funSrc)
     && funSrc.indexOf('target-hp-on') < 0 && funSrc.indexOf('hit-marks-on') < 0);

  const fx = {};
  const $$ = function (id) { return fx[id] || (fx[id] = new Element('div')); };
  const fwin = {};
  let seq = [], seqAt = 0;
  function seed(list) { seq = list.slice(); seqAt = 0; }
  fwin.BullbaHitsRng = function () { const v = seqAt < seq.length ? seq[seqAt] : 0.5; seqAt++; return v; };
  // TTX (23.09): the block asks the characteristics panel for a vehicle's hit points when nothing else has them;
  // cut out on its own it has no panel, and the stub answers "no figure", as a page without the file does - unless a
  // check hands it one (fun.ttx, 24.09: the figure a characteristics file gives a vehicle the roster has none for).
  // The bar's tooltip is joined by the page's own tipJoin, cut out of app.js as it stands.
  const tipJoinSrc = (/\n  function tipJoin\(lines\) \{[\s\S]*?\n  \}\n/.exec(appSrc) || [''])[0];
  ok('fun: (the page’s own tipJoin is cut out for the block)', tipJoinSrc.length > 0);
  const fun = new Function('$', 'window', 'chanceRgb',
    // BACKLOG 38 (23.09): the Borkenkäfer's mark lives in the tier-XI block beside this one; cut out alone, none.
    // Strip (23.09): the strip beside ⌖ comes and goes with paintFun, which then asks the layout pass for the top band.
    'var viewer=null,current=null,activeHit=null,xiMarkState=null,LAYOUT_MODS=4,funLayouts=0,ttxHp=0,ttxAsked=[],sceneBuild=false;function ttxHealth(){return ttxHp;}function xiMarkNow(){return null;}' +
    'function readTtx(type){ttxAsked.push(type);return Promise.resolve(null);}' + tipJoinSrc +
    'function scheduleLayout(p){if(p===LAYOUT_MODS)funLayouts++;}function stripLayout(){var s=$("fun-strip");if(s&&!s.hidden)scheduleLayout(LAYOUT_MODS);}\n' + funSrc +
    '\nreturn {set:function(v,c,h){viewer=v;current=c;activeHit=h;},targetMaxHp:targetMaxHp,targetHp:targetHp,targetRow:targetRow,' +
    'targetKey:targetKey,funVerdict:funVerdict,funRoll:funRoll,funRandomization:funRandomization,funShot:funShot,' +
    'funReset:funReset,funModel:funModel,funSettings:funSettings,paintFun:paintFun,funMarks:function(){return funMarks;},' +
    'ttx:function(hp){ttxHp=hp;},asked:function(){return ttxAsked;},reloaded:function(){funLaid=false;},' +
    'hp:function(){return {max:hpMax,left:hpLeft,roll:hpRoll,key:hpKey,from:hpFrom};},layouts:function(){return funLayouts;}};')(
    $$, fwin, function (r) { return 'rgb(' + (r.chance === null || r.chance === undefined ? 'grey' : r.chance) + ')'; });

  // The hit points of a record, as the roster writes them since 0.7.20.
  const ROSTER = [{id: 7, type: 'germany:Alpha', maxHealth: 1850, defaultMaxHealth: 1800},
                  {id: 9, type: 'germany:Bravo', defaultMaxHealth: 1400},
                  {id: 11, type: 'germany:Bravo', defaultMaxHealth: 1400}];
  const FBATTLE = {id: 'f1', roster: ROSTER, hits: [{id: 'h1', attackerId: 9, targetId: 7}]};
  fun.set(null, FBATTLE, null);
  ok('fun: the target HP is this battle’s maxHealth of the roster row with the hit’s target id (Onslaught writes its own there)',
     fun.targetMaxHp({targetId: 7, target: {type: 'germany:Alpha'}}) === 1850);
  ok('fun: a row with no battle value of its own falls back to the stock one',
     fun.targetMaxHp({targetId: 9, target: {type: 'germany:Bravo'}}) === 1400);
  // 24.09 recorder fix: Onslaught records up to 0.7.42 kept a switched ally's row on his previous vehicle - a row
  // naming another type is not this vehicle's health, and the lookup goes on to the vehicle's own sources.
  ok('fun: a roster row of another vehicle type (a switched Onslaught ally) is not taken for this one',
     fun.targetMaxHp({targetId: 7, target: {type: 'germany:Zulu', maxHealth: 999}}) === 999);
  ok('fun: a swapped view has no ids of its own and asks the hit it was made from for its shooter',
     fun.targetMaxHp({synthetic: true, base: 'h1', target: {type: 'germany:Bravo'}}) === 1400);
  ok('fun: an id the roster does not hold falls back to the ONE row of that vehicle type',
     fun.targetMaxHp({targetId: 99, target: {type: 'germany:Alpha'}}) === 1850);
  ok('fun: and never guesses when two vehicles of that type fought',
     fun.targetMaxHp({targetId: 99, target: {type: 'germany:Bravo'}}) === 0);
  // Audit PD-01 г (24.09) reverses the rule of 22.09: a browsed vehicle is no seat of the battle open beside it, and
  // took the Onslaught figure of a same-type row of whatever battle was loaded. It never guesses a row by type now;
  // the model of a seat with no hits (showFocusEmpty) names its row by id and keeps the battle's figure.
  ok('fun: a browsed vehicle never takes a same-type roster row of the battle beside it; a seat’s model named by id does',
     fun.targetMaxHp({vehicle: true, synthetic: true, target: {type: 'germany:Alpha'}}) === 0
     && fun.targetMaxHp({vehicle: true, synthetic: true, target: {type: 'germany:Alpha', maxHealth: 1700}}) === 1700
     && fun.targetMaxHp({vehicle: true, synthetic: true, modelVehicleId: 7, target: {type: 'germany:Alpha', maxHealth: 1700}}) === 1850
     && fun.targetMaxHp({vehicle: true, synthetic: true, target: {type: 'germany:Bravo'}}) === 0);
  fun.set(null, null, null);
  ok('fun: and a page with no battle open gets no bar at all', fun.targetMaxHp({targetId: 7}) === 0);
  // 24.09, the user on 0.7.41: "the HP bar is there, but SWAP makes it disappear". The battles on his screen were
  // Onslaught (7 v 7): the roster lists the enemy team with its id, player and team ONLY - no type, no figure (12 of
  // 12 such records in preview/data). ⇅ on an incoming hit puts that enemy on screen, targetRow found his row, and a
  // row without a figure ended the search at 0: no bar. A row without one no longer ends it - the vehicle's own export,
  // then its characteristics file, both its stock, and the tooltip says which.
  const ONSLAUGHT = {id: 'f7', roster: [{id: 7, type: 'germany:Alpha', maxHealth: 2750, defaultMaxHealth: 2100}, {id: 21, player: 'x', team: 1}],
    hits: [{id: 'o1', attackerId: 21, targetId: 7}]};
  fun.set(null, ONSLAUGHT, null);
  const SWAPPED_ENEMY = {synthetic: true, base: 'o1', target: {type: 'germany:Echo', name: 'Echo'}};
  ok('fun: (the swapped view finds the enemy’s roster row, which carries no figure)',
     !!fun.targetRow(SWAPPED_ENEMY) && fun.targetRow(SWAPPED_ENEMY).id === 21);
  fun.ttx(1950);
  ok('fun: a roster row without a figure no longer ends the search - the vehicle’s characteristics file gives it, as its stock',
     fun.targetMaxHp(SWAPPED_ENEMY) === 1950 && fun.targetHp(SWAPPED_ENEMY).from === 'ttx',
     '(' + JSON.stringify(fun.targetHp(SWAPPED_ENEMY)) + ')');
  ok('fun: the vehicle’s own export comes before the file, and a row WITH a figure before both',
     fun.targetHp({synthetic: true, base: 'o1', target: {type: 'germany:Echo', maxHealth: 2000}}).from === 'export'
     && fun.targetHp({targetId: 7, target: {type: 'germany:Alpha', maxHealth: 2000}}).hp === 2750
     && fun.targetHp({targetId: 7, target: {type: 'germany:Alpha'}}).from === 'roster');
  fun.ttx(0);
  ok('fun: and with neither there is still no made-up figure', fun.targetMaxHp(SWAPPED_ENEMY) === 0);
  fun.set(null, null, null);

  // The bug of 0.7.25 (user, 22.09): "changing the shooter tank makes the HP bar disappear and the ↺ does
  // nothing". The target had NOT changed - only the shooter - but the health was looked up in the HIT, and
  // a shooter picked from the roster builds a synthetic hit with no target id at all. The old rule then
  // asked the hit it was made from for its SHOOTER, which is another vehicle entirely: 2 000 HP instead of
  // 1 850 where that shooter is still in the roster, and no row and no bar where he is not. The health is
  // now looked up for the vehicle ON SCREEN, and pickShooter carries its roster row over on the hit.
  fun.set(null, FBATTLE, null);
  const RECORDED = {targetId: 7, target: {type: 'germany:Alpha'}};
  const CHOSEN = {synthetic: true, chosenShooter: true, base: 'h1', modelVehicleId: 7, target: {type: 'germany:Alpha'}};
  ok('fun: picking another shooter leaves the health on the vehicle on screen, not on the shooter of the hit it was made from',
     fun.targetMaxHp(CHOSEN) === 1850, '(' + fun.targetMaxHp(CHOSEN) + ' HP)');
  ok('fun: and the vehicle on screen keeps its key, so nothing is reset under it',
     fun.targetKey(CHOSEN) === fun.targetKey(RECORDED) && fun.targetKey(RECORDED) === 'f1|r7',
     '(' + fun.targetKey(RECORDED) + ' / ' + fun.targetKey(CHOSEN) + ')');
  ok('fun: a chosen-shooter hit never falls back to the base hit’s shooter, even with no row of its own',
     fun.targetKey({synthetic: true, chosenShooter: true, base: 'h1', target: {type: 'germany:Zulu'}}) === 'f1|tgermany:Zulu/');
  ok('fun: another VEHICLE is another key', fun.targetKey({targetId: 9, target: {type: 'germany:Bravo'}}) !== fun.targetKey(RECORDED));
  ok('fun: and the same vehicle in another battle too',
     (function () { fun.set(null, {id: 'f9', roster: ROSTER, hits: []}, null); const k = fun.targetKey(RECORDED); fun.set(null, FBATTLE, null); return k !== fun.targetKey(RECORDED); }()));

  // One penetration roll per shot, the model the page's own figures are built on: u under the chance is a
  // penetration, u between the chance and the screen-pass chance is a non-penetration on the main armour
  // (the page's HE law says what it is worth), above it the shell died on a screen and does nothing.
  const HE = {alpha: 400, spallDamage: 200, damageRandomization: .25, kind: 'HIGH_EXPLOSIVE', mechanics: 'MODERN', caliber: 105};
  const PEN = {reason: 'penetration', chance: 40, screenPass: .8, nominal: 100, nonPen: 90};
  seed([.1]);
  const vPen = fun.funVerdict(PEN, HE);
  seed([.5]);
  const vNon = fun.funVerdict(PEN, HE);
  seed([.9]);
  const vStopped = fun.funVerdict(PEN, HE);
  ok('fun: one roll decides the shot - under the chance a penetration for the whole alpha',
     vPen.outcome === 'pen' && vPen.base === 400, '(' + vPen.outcome + ' / ' + vPen.base + ')');
  ok('fun: between the chance and the screen-pass chance a non-penetration for the page’s own HE figure',
     vNon.outcome === 'no-pen' && vNon.base === 90, '(' + vNon.outcome + ' / ' + vNon.base + ')');
  ok('fun: above it the shell was stopped on a screen and deals nothing at all',
     vStopped.outcome === 'no-pen' && vStopped.base === 0, '(' + vStopped.outcome + ' / ' + vStopped.base + ')');
  ok('fun: a ricochet and an unreadable line are outcomes of their own and roll no damage',
     fun.funVerdict({reason: 'ricochet'}, HE).outcome === 'ricochet'
     && fun.funVerdict({reason: 'ricochet'}, HE).base === 0
     && fun.funVerdict({reason: 'no-hull'}, HE).outcome === 'unknown'
     && fun.funVerdict({reason: 'penetration', chance: null}, HE).outcome === 'unknown'
     && fun.funVerdict(null, HE).outcome === 'unknown');
  // 22.09, the user's verdict on 0.7.26: the discs wore the very colours of the hit map and melted into it.
  // The page no longer picks a colour for a mark at all - it hands the outcome over and the viewer draws
  // the shape that belongs to it, so there is no second palette beside the map's.
  ok('fun: the page picks NO colour for a mark - the outcome itself goes to the viewer',
     funSrc.indexOf('funColor') < 0 && /funMark\(v, shell\)/.test(funSrc)
     && !/chanceRgb[^\n]*(pen|ricochet)/.test(funSrc));
  // 22.09, 23:15: one mark per plate the shell met, each in its own part - so the record is the VIEWER's,
  // made out of the ray the shot already cast; the page hands it the verdict as rolled, the calibre and
  // the one roll it draws for the shot, keeps what comes back and lays it again after a rebuild.
  ok('fun: and one SHOT is ONE record: the viewer makes it from the verdict, the calibre and the shot’s own roll, and the page keeps it as it is',
     /roll = rng\(\) \* Math\.PI \* 2/.test(funSrc)
     && /viewer\.hitMarkShot\(v, caliber, roll\)/.test(funSrc) && /funMarks\.push\(shot\)/.test(funSrc)
     && /funMarks\.forEach\(function \(m\) \{ if \(viewer && viewer\.addHitMark\) viewer\.addHitMark\(m\); \}\)/.test(funSrc));
  ok('fun: the roll rides along with the verdict, and nothing but the Hitmarks reads it',
     fun.funVerdict(PEN, HE) && (function () { seed([.1]); const a = fun.funVerdict(PEN, HE); seed([.9]); const b = fun.funVerdict(PEN, HE); return a.u === .1 && b.u === .9; }())
     && fun.funVerdict({reason: 'ricochet'}, HE).u === undefined);

  // The damage roll: base x (1 +- the shell's own damageRandomization), drawn uniformly over the band.
  ok('fun: the damage spread is the shell’s own field, 0.25 by default and 0.12 where the record says so',
     fun.funRandomization(HE) === .25 && fun.funRandomization({damageRandomization: .12}) === .12
     && fun.funRandomization({}) === .25 && fun.funRandomization(null) === .25);
  seed([0]);
  const low = fun.funRoll(400, HE);
  seed([1]);
  const high = fun.funRoll(400, HE);
  seed([.5]);
  const mid = fun.funRoll(400, HE);
  seed([0]);
  const lowOnslaught = fun.funRoll(400, {damageRandomization: .12});
  ok('fun: the roll runs from 0.75 to 1.25 of the base and sits on it in the middle',
     Math.abs(low - 300) < 1e-9 && Math.abs(high - 500) < 1e-9 && Math.abs(mid - 400) < 1e-9,
     '(' + low + ' … ' + high + ')');
  ok('fun: an Onslaught shell rolls over its own narrower band', Math.abs(lowOnslaught - 352) < 1e-9, '(' + lowOnslaught + ')');

  // The deduction, the clamp, the reset and the change of model, on the block's own state.
  const marks = [];
  const fviewer = {pinResult: PEN, pinned: {point: {p: 1}, normal: {n: 1}, origin: {o: 1}, direction: {d: 1}}, shell: HE,
    addHitMark: function (mark) { marks.push(mark); return true; }, clearHitMarks: function () { marks.length = 0; return true; },
    hitMarkShot: function (verdict, caliber, roll) { return {caliber: caliber, roll: roll, verdict: verdict, marks: [{point: this.pinned.point, normal: this.pinned.normal, from: this.pinned.origin, dir: this.pinned.direction, outcome: verdict.outcome}]}; },
    hitMarkLimit: function () { return 500; }};
  fx['fun-mode'] = new Element('input'); fx['fun-mode'].checked = true;
  fun.set(fviewer, FBATTLE, RECORDED);
  fun.funReset();
  ok('fun: a reset fills the bar to the record’s own maximum', fun.hp().max === 1850 && fun.hp().left === 1850);
  seed([.1, .5]);   // the outcome roll, then the damage roll
  fun.funShot(HE);
  ok('fun: a penetration takes its rolled damage off the target',
     Math.abs(fun.hp().left - 1450) < 1e-9 && /penetration/.test(fun.hp().roll) && /400/.test(fun.hp().roll),
     '(' + fun.hp().left + ' · ' + fun.hp().roll + ')');
  seed([.5, 1]);    // a non-penetration: 90 HP of the page's HE law, rolled at the top of the band
  fun.funShot(HE);
  ok('fun: a non-penetration takes the page’s own HE figure, rolled the same way',
     Math.abs(fun.hp().left - (1450 - 112.5)) < 1e-9 && /no penetration/.test(fun.hp().roll), '(' + fun.hp().left + ')');
  seed([.9, .5]);   // stopped on a screen: nothing at all
  const wasLeft = fun.hp().left;
  fun.funShot(HE);
  ok('fun: a shell stopped on a screen takes nothing and says so',
     fun.hp().left === wasLeft && /no damage/.test(fun.hp().roll), '(' + fun.hp().roll + ')');
  ok('fun: every one of those shots left its Hitmark', marks.length === 3);
  ok('fun: and each shot hands the viewer its own verdict as rolled, the shell’s calibre and its own roll round the normal',
     marks[0].marks[0].outcome === 'pen' && marks[1].marks[0].outcome === 'no-pen' && marks[2].marks[0].outcome === 'no-pen'
     && marks[0].verdict.u === .1 && marks[1].verdict.u === .5 && marks[2].verdict.u === .9 && marks[2].verdict.base === 0
     && marks.every(function (m) { return m.caliber === 105 && m.roll >= 0 && m.roll < Math.PI * 2; })
     && marks[0].marks[0].point === fviewer.pinned.point && marks[0].marks[0].from === fviewer.pinned.origin
     && marks[0].marks[0].dir === fviewer.pinned.direction,
     '(' + marks.map(function (m) { return m.marks[0].outcome; }).join(', ') + ' · ' + marks[0].caliber + ' mm)');
  ok('fun: a shell the record gives no calibre for still leaves a mark, with none of its own - the viewer’s floor answers for it',
     (function () { seed([.1, .5]); fun.funShot({alpha: 400}); const m = marks.pop(); fun.funMarks().pop(); return m.caliber === 0; }()));
  // The very thing the user asked for: the shooter changes, the model does not, so nothing is reset and
  // the Hitmarks are laid on the rebuilt scene again (viewer.load clears everything the viewer holds).
  // 24.09: display() says the viewer was reloaded (funLaid = false after viewer.load) - done here by hand.
  const wasHp = fun.hp().left;
  marks.length = 0;
  fun.set(fviewer, FBATTLE, CHOSEN);
  fun.reloaded(); fun.funModel();
  ok('fun: a shooter picked from the roster leaves the health where it was and puts the Hitmarks back',
     fun.hp().left === wasHp && fun.hp().max === 1850 && marks.length === 3,
     '(' + fun.hp().left + ' HP · ' + marks.length + ' marks)');
  // The one finisher (sceneShown, 24.09) also runs for a scene shown again WITHOUT a reload (the side panel
  // switched): the marks it still has must not be laid a second time.
  fun.funModel();
  ok('fun: a scene shown again without a reload keeps its Hitmarks and does not lay them twice',
     marks.length === 3 && fun.hp().left === wasHp, '(' + marks.length + ' marks)');
  fun.set(fviewer, FBATTLE, {targetId: 9, target: {type: 'germany:Bravo'}});
  fun.funModel();
  ok('fun: another VEHICLE on screen is full again and carries none of the marks',
     fun.hp().left === 1400 && fun.hp().max === 1400 && marks.length === 0, '(' + fun.hp().left + ' HP)');
  fun.set(fviewer, FBATTLE, RECORDED);
  fun.funReset();
  for (let i = 0; i < 15; i++) { seed([.1, 1]); fun.funShot(HE); }
  ok('fun: the HP stop at zero and do not go negative', fun.hp().left === 0);
  ok('fun: at zero the bar is empty, the tooltip says destroyed and the shots still leave Hitmarks',
     fx['target-hp-fill'].style.width === '0.0%' && fx['target-hp'].title.indexOf('\n• Destroyed: 0 / 1' + NB + '850 HP - further shots still leave Hitmarks\n') > 0 && marks.length === 15,
     '(' + fx['target-hp-fill'].style.width + ' · ' + marks.length + ')');
  // 24.09 (user: "is there no way to get the number?"): the figures stand INSIDE the bar, "left / max", and the
  // tooltip follows the page's markup - the heading, the one line of what it shows, then the figures and the roll.
  ok('fun: the figures stand inside the bar; the tooltip carries them under a heading and the one line of what it shows, names the source and the roll as an assumption',
     fx['target-hp-text'].textContent === '0 / 1' + NB + '850'
     && fx['target-hp'].title.indexOf('Target HP\nHealth of the vehicle on screen; every ⌖ shot takes its rolled damage off.\n• Destroyed: 0 / 1' + NB + '850 HP') === 0
     && fx['target-hp'].title.indexOf('\n• Source: this battle’s roster\n') > 0 && /assumption\.$/.test(fx['target-hp'].title),
     '(' + fx['target-hp-text'].textContent + ' · ' + fx['target-hp'].title.slice(0, 120) + ')');
  fun.funReset();
  ok('fun: the ↺ fills the bar again and clears every Hitmark',
     fun.hp().left === 1850 && marks.length === 0 && fx['target-hp-fill'].style.width === '100.0%'
     && fx['target-hp-text'].textContent === '1' + NB + '850 / 1' + NB + '850');
  // The ↺ is never inert: it finds the health of the vehicle on screen however the hit was built.
  fun.set(fviewer, FBATTLE, CHOSEN);
  fun.funShot(HE);
  fun.funReset();
  ok('fun: and it brings the bar back under a chosen shooter too, the 0.7.25 case where it did nothing',
     fun.hp().max === 1850 && fun.hp().left === 1850 && fx['target-hp'].hidden === false,
     '(' + fun.hp().max + ' HP · hidden=' + fx['target-hp'].hidden + ')');
  fx['fun-mode'].checked = false;
  fun.paintFun();
  ok('fun: with the switch off the bar and the ↺ are off the scene, and the switch itself is not lit',
     fx['target-hp'].hidden === true && fx['target-hp-reset'].hidden === true
     && fx['fun-mode-toggle'].getAttribute('aria-pressed') === 'false' && fx['fun-mode-toggle'].hidden === false);

  // ---- 2. the wiring, driven through the page with the stub viewer -------------------------------
  // A battle whose shooter carries an aim block, so the emulation is live and a press really fires.
  const FPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const FNAMES = {7: ['Alpha', 'germany:Alpha'], 11: ['Charlie', 'germany:Charlie']};
  const FSHOOTERS = {7: ['Alpha', 'germany:Alpha'], 9: ['Bravo', 'germany:Shooter'], 13: ['Delta', 'germany:Delta']};
  const FHIT = function (id, targetId, attackerId) {
    const a = attackerId === undefined ? 9 : attackerId;
    return {id: id, attackerId: a, targetId: targetId, direction: a === 7 ? 'outgoing' : 'incoming',
            damage: 0, receivedAt: 100, points: [],
            attacker: {name: FSHOOTERS[a][0], type: FSHOOTERS[a][1], parts: FPARTS(), gunDispersion: 0.00383, aim: AIM_BLOCK},
            target: {name: FNAMES[targetId][0], type: FNAMES[targetId][1], parts: FPARTS()}, warnings: []};
  };
  const HPBATTLE = {id: 'f2', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 1850, defaultMaxHealth: 1800},
             {id: 9, name: 'Bravo', type: 'germany:Shooter', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 11, name: 'Charlie', type: 'germany:Charlie', team: 1, player: '', maxHealth: 1200, defaultMaxHealth: 1200},
             {id: 13, name: 'Delta', type: 'germany:Delta', team: 2, player: '', maxHealth: 900, defaultMaxHealth: 900}],
    // Two hits on the SAME vehicle, one on another, and one fired by a second shooter so that the roster
    // pick below has a gun of its own in the record.
    hits: [FHIT('f-h1', 7), FHIT('f-h2', 7), FHIT('f-h3', 11, 7), FHIT('f-h4', 7, 13)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'f2' ? Promise.resolve(HPBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (h) { return h.id === id; })[0], models: {}, warnings: []});
  };
  // 24.09 (user: "is there no way to get the number?"): what the bar shows - the figures INSIDE it (#target-hp-text)
  // and the same figures as the first item of its tooltip ('• Left:' or '• Destroyed:'). Both must agree.
  const hpText = function () { return document.getElementById('target-hp-text').textContent; };
  const hpShows = function (figures) {
    const want = figures.replace(/ /g, NB), title = document.getElementById('target-hp').title;
    return hpText() === want && (title.indexOf('\n• Left: ' + want + ' HP') > 0 || title.indexOf('\n• Destroyed: ' + want + ' HP') > 0);
  };
  // Checks above left the emulation switched off; the fun layer needs it live to fire at all.
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const fbattles = document.getElementById('battles');
  fbattles.value = 'f2'; fbattles.onchange.call(fbattles);
  return settle(20).then(function () {
    const view = viewerInstance;
    const funBox = document.getElementById('fun-mode'), toggle = document.getElementById('fun-mode-toggle');
    const bar = document.getElementById('target-hp'), reset = document.getElementById('target-hp-reset');
    ok('fun: the battle is on screen with the emulation live', document.getElementById('aim-drive').hidden === false
       && view.liveRadius100 > 0, '(drive hidden=' + document.getElementById('aim-drive').hidden
       + ', radius=' + view.liveRadius100 + ', mode=' + document.getElementById('armor-mode').value
       + ', model hidden=' + document.getElementById('model-tile').hidden
       + ', aimOn=' + onBox.checked + ')');
    ok('fun: the switch starts off and unlit, and nothing of the layer is on screen',
       funBox.checked === false && toggle.getAttribute('aria-pressed') === 'false' && toggle.hidden === false
       && bar.hidden === true && reset.hidden === true);
    // The page never sets these itself: the stub's configure() is a no-op, so the shell and the verdict of
    // the pinned line are put in by hand - they are what the real viewer would have handed back.
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };

    const off = {pins: view.pinnedPoints, probes: view.probes, sampled: view.sampled};
    press(); release();
    ok('fun: with the switch off a shot is the shot of 0.7.24 - one integral, one pin through the ring’s middle, no draw, no Hitmark',
       view.pinnedPoints === off.pins + 1 && view.probes === off.probes + 1 && view.sampled === off.sampled
       && view.marks.length === 0 && view.pinnedAt === (view.spreadAim || view.liveAimPoint),
       '(' + (view.pinnedPoints - off.pins) + ' pins, ' + (view.probes - off.probes) + ' integrals, '
       + (view.sampled - off.sampled) + ' draws)');

    click(toggle);
    ok('fun: the button on the scene turns the whole mode on, lights itself and tells the viewer to leave a Hitmark instead of the cross',
       funBox.checked === true && toggle.getAttribute('aria-pressed') === 'true' && view.marksOn === true,
       '(checked=' + funBox.checked + ', pressed=' + toggle.getAttribute('aria-pressed') + ')');
    ok('fun: the bar comes up with it, on the hit points the roster recorded for the vehicle on screen',
       bar.hidden === false && reset.hidden === false
       && hpShows('1 850 / 1 850'), '(' + hpText() + ')');
    // The settings box itself cannot be read here - this harness's querySelector is a stub, so the page
    // finds no controls in the menu and writes an empty set. What CAN be checked is that the button goes
    // through the very control the settings machinery stores, and saves through the very function it saves
    // with; the control's place inside the menu is checked on the markup above.
    ok('fun: the button flips the stored control and saves through the settings machinery, with no second copy of it',
       /\$\('fun-mode-toggle'\)\.onclick=function\(\)\{var box=\$\('fun-mode'\);box\.checked=!box\.checked;funSettings\(\);persistSettings\(\);\}/.test(appSrc)
       && /\$\('fun-mode'\)\.onchange=funSettings;/.test(appSrc));

    // The draw of the point takes two numbers, then the outcome roll, the damage roll and the roll that
    // turns the decal round its own normal take one each.
    let queue = [.3, .3, .0, .5], at = 0;
    window.BullbaHitsRng = function () { const v = at < queue.length ? queue[at] : .5; at++; return v; };
    const on = {pins: view.pinnedPoints, probes: view.probes, sampled: view.sampled};
    press(); release();
    ok('fun: a rolled shot draws ONE point in the ring, pins the line through THAT point, leaves one Hitmark and takes its damage off - still one integral and one cast',
       view.sampled === on.sampled + 1 && view.pinnedPoints === on.pins + 1 && view.probes === on.probes + 1
       && !!view.pinnedAt && view.pinnedAt.drawn === view.sampled && view.marks.length === 1
       && view.marks[0].marks[0].outcome === 'pen' && view.marks[0].roll >= 0 && view.marks[0].roll < Math.PI * 2
       && hpShows('1 450 / 1 850'),
       '(' + (view.sampled - on.sampled) + ' draws, ' + (view.probes - on.probes) + ' integrals, '
       + view.marks.length + ' marks, ' + hpText() + ')');
    for (let i = 0; i < 6; i++) { at = 0; press(); release(); }
    ok('fun: the damage stops at zero and the Hitmarks go on being left',
       hpShows('0 / 1 850') && bar.title.indexOf(' HP - further shots still leave Hitmarks\n') > 0 && view.marks.length === 7,
       '(' + hpText() + ' · ' + view.marks.length + ' marks)');
    click(reset);
    ok('fun: the ↺ fills the bar and clears the Hitmarks',
       hpShows('1 850 / 1 850') && view.marks.length === 0);
    at = 0; press(); release();
    ok('fun: (and the run goes on after a reset)', view.marks.length === 1 && hpShows('1 450 / 1 850'));
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance, bar = document.getElementById('target-hp');
    ok('fun: another hit on the SAME vehicle leaves the health where it is and lays its Hitmarks again',
       view.marks.length === 1 && hpShows('1 450 / 1 850'),
       '(' + view.marks.length + ' marks · ' + hpText() + ')');
    document.getElementById('hits').children[2].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance, bar = document.getElementById('target-hp');
    ok('fun: a change of the VEHICLE on screen fills the bar again, with its own hit points, and clears the Hitmarks',
       view.marks.length === 0 && hpShows('1 200 / 1 200'),
       '(' + view.marks.length + ' marks · ' + hpText() + ')');
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    // ---- the user's own case: only the SHOOTER changes, driven through the roster picker ----------
    const view = viewerInstance, bar = document.getElementById('target-hp'), reset = document.getElementById('target-hp-reset');
    let at = 0;
    window.BullbaHitsRng = function () { const q = [.3, .3, .0, .5]; const v = at < q.length ? q[at] : .5; at++; return v; };
    press(); release();
    ok('fun: (back on the first vehicle, one shot fired at it)',
       view.marks.length === 1 && hpShows('1 450 / 1 850'),
       '(' + hpText() + ')');
    // The shooter tile puts the roster picker in the shooter role; a click on a row is pickShooter().
    document.getElementById('shooter-tile').onclick();
    const row = document.getElementById('focus-list').children
      .filter(function (c) { return c.getAttribute('data-id') === '13'; })[0];
    ok('fun: (the roster offers a second shooter with a gun of his own)', !!row);
    if (row) row.onclick();
    return settle(30);
  }).then(function () {
    const view = viewerInstance, bar = document.getElementById('target-hp'), reset = document.getElementById('target-hp-reset');
    // 0.7.25: the bar went out here (or read the other vehicle's health) and the ↺ could not bring it back.
    ok('fun: changing the SHOOTER leaves the bar on the same target, at the same health, with its Hitmarks',
       bar.hidden === false && hpShows('1 450 / 1 850') && view.marks.length === 1,
       '(hidden=' + bar.hidden + ' · ' + hpText() + ' · ' + view.marks.length + ' marks)');
    click(reset);
    ok('fun: and the ↺ fills it again instead of doing nothing',
       bar.hidden === false && hpShows('1 850 / 1 850') && view.marks.length === 0,
       '(' + hpText() + ')');
    const toggle = document.getElementById('fun-mode-toggle');
    click(toggle);
    const off = {pins: view.pinnedPoints, probes: view.probes, sampled: view.sampled};
    press(); release();
    ok('fun: switched off again, the shot is once more exactly the shot of 0.7.24',
       view.pinnedPoints === off.pins + 1 && view.probes === off.probes + 1 && view.sampled === off.sampled
       && view.marks.length === 0 && view.marksOn === false
       && toggle.getAttribute('aria-pressed') === 'false'
       && view.pinnedAt === (view.spreadAim || view.liveAimPoint));
    delete window.BullbaHitsRng;

    // ---- 3. the geometry, on the REAL viewer.js over a box model ------------------------------------
    ok('fun: one law for the integral and for the drawn point - both go through circlePoint()',
       /function circlePoint\(/.test(viewerSrc)
       && /point=circlePoint\(center,right,up,radius,\(i\+\.5\)\/count/.test(viewerSrc)
       && /return circlePoint\(aim\.center,aim\.right,aim\.up,aim\.radius,r\(\),r\(\)\*Math\.PI\*2,this\.aimQuantile\(\)\)/.test(viewerSrc));
    ok('fun: a new model in the viewer clears the marks with everything else',
       /Viewer\.prototype\.clear=function\(\)\{this\.dropTargets\(\);this\.clearLiveAim\(\);this\.clearHitMarks\(\);/.test(viewerSrc));

    const rv2 = Object.create(RealViewer.prototype);
    rv2.scene = new THREE.Scene(); rv2.root = new THREE.Group(); rv2.scene.add(rv2.root);
    rv2.camera = new THREE.PerspectiveCamera(38, 800 / 600, .1, 1000);
    rv2.camera.position.set(0, 2, 20); rv2.camera.lookAt(0, 1, 0); rv2.camera.updateMatrixWorld();
    const fbox = new THREE.BoxGeometry(6, 2, 3); fbox.translate(0, 1, 0);
    rv2.paintMesh = new THREE.Mesh(fbox, new THREE.MeshBasicMaterial()); rv2.root.add(rv2.paintMesh);
    rv2.scene.updateMatrixWorld(true);
    rv2.bounds = new THREE.Box3().setFromObject(rv2.paintMesh);
    rv2.target = new THREE.Vector3(0, 1, 0);
    rv2.reticleLayer = new Element('div'); rv2.viewWidth = 800; rv2.viewHeight = 600;
    rv2.reticles = []; rv2.pinReticles = []; rv2.pinGroup = null; rv2.pinCache = null; rv2.pinned = null;
    rv2.turretAngle = 0; rv2.gunAngle = 0; rv2.aimGroup = null; rv2.trackMesh = null; rv2.trackGroup = null;
    rv2.outline = null; rv2.outlineDepth = null; rv2.impactOpacity = .9;
    rv2.draw = function () {}; rv2.liveRadius100 = 4; rv2.aimChase = false; rv2.spreadAim = null;
    rv2.aimReloadPart = null; rv2.aimProfileName = ArmorBallistics.aimProfileDefault;
    rv2.liveAimPoint = new THREE.Vector3(0, 1.075, 1.5); rv2.aimCursorPoint = rv2.liveAimPoint.clone();
    rv2.drawLiveAim();
    const aim = rv2.liveAim, normal = aim.center.clone().sub(aim.origin).normalize();
    ok('fun: (the live ring of the real viewer stands across the shot line)', !!aim && aim.radius > 0);
    // A seeded uniform source, so the same run always gives the same histogram.
    const lcg = (function () { let s = 123456789; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }());
    const N = 20000, rings = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let maxR = 0, offPlane = 0;
    for (let i = 0; i < N; i++) {
      const p = rv2.liveAimSample(lcg), d = p.clone().sub(aim.center), r = d.length();
      if (r > maxR) maxR = r;
      offPlane = Math.max(offPlane, Math.abs(d.dot(normal)));
      rings[Math.min(9, Math.floor(r / aim.radius * 10))]++;
    }
    ok('fun: every drawn point lies inside the ring and in its own plane',
       maxR <= aim.radius + 1e-9 && offPlane < 1e-9, '(max ' + (maxR / aim.radius).toFixed(4) + ' R)');
    // The very table the integral fans its rays over (ballistics.js POST96), in shares of 0.1 R.
    const WANT = [9.9, 16.1, 16.1, 14.6, 12.2, 9.9, 7.3, 5.6, 4.4, 3.9];
    const got = rings.map(function (n) { return n / N * 100; });
    const worst = Math.max.apply(null, got.map(function (v, i) { return Math.abs(v - WANT[i]); }));
    ok('fun: and they follow the profile’s own law, ring by ring (0.1 R bands, ' + N + ' draws)',
       worst < 1.2, '(worst ' + worst.toFixed(2) + ' pp · ' + got.map(function (v) { return v.toFixed(1); }).join(' ') + ')');
    // The old Gaussian would put ~2 % in the middle band where the table puts ~10 %: the law really is read.
    ok('fun: the middle of the circle is the table’s, not the page’s old Gaussian',
       got[0] > 8 && got[0] < 12, '(' + got[0].toFixed(1) + ' %)');

    let rays = 0;
    rv2.engine = {ray: function () { rays++; return {chance: 55, reason: 'penetration', layers: [], nominal: 100,
      effective: 120, angle: 20, screenPass: 1, nonPen: 50, expected: 220, expectedShare: .55}; }};
    rv2.shell = {alpha: 400, penetration: 250, caliber: 120, kind: 'ARMOR_PIERCING'};
    const shotAt = rv2.liveAimSample(lcg);
    rays = 0;
    const pinned = rv2.pinAtPoint(shotAt);
    ok('fun: the rolled shot is cast down the one line a shot has always been cast down - one ray, one verdict, handed back',
       pinned === true && rays === 1 && !!rv2.pinResult && rv2.pinResult.chance === 55, '(' + rays + ' rays)');
    ok('fun: and the pinned line really runs through the drawn point',
       rv2.pinned.direction.clone().cross(shotAt.clone().sub(rv2.camera.position).normalize()).length() < 1e-9);
    ok('fun: with the mode off that shot leaves its cross, as before',
       rv2.reticles.filter(function (r) { return r.pinned; }).length === 1);
    rv2.setHitMarks(true);
    rv2.pinCache = null; rv2.pinned = null; rv2.aimPinned = false;
    rv2.pinAtPoint(shotAt);
    ok('fun: with it on the emulated shot leaves no cross at all - the Hitmark takes its place',
       rv2.reticles.filter(function (r) { return r.pinned; }).length === 0);
    // A pin the USER made (pinAt, an ordinary click on the armour) never sets aimPinned, so it is not an
    // emulated shot and keeps its cross. Driven exactly as pinAt drives it.
    rv2.aimPinned = false; rv2.pinCache = null;
    const userDir = shotAt.clone().sub(rv2.camera.position).normalize();
    const userHit = new THREE.Raycaster(rv2.camera.position.clone(), userDir).intersectObjects([rv2.paintMesh])[0];
    rv2.pinned = {origin: rv2.camera.position.clone(), direction: userDir, point: userHit.point.clone(),
                  normal: userHit.face.normal.clone().transformDirection(userHit.object.matrixWorld)};
    rv2.refreshPin(userHit.point);
    ok('fun: a pin the USER made keeps its cross even with the mode on',
       rv2.reticles.filter(function (r) { return r.pinned; }).length === 1,
       '(' + rv2.reticles.filter(function (r) { return r.pinned; }).length + ')');

    // ---- the PROJECTED decals, final scheme (user, 22.09, 22:50 and 23:00). One mark is geometry CUT OUT
    // OF THE MODEL: an oriented box at the impact, which is the MIDDLE of the mark, Z along the shell's
    // travel, a footprint 0.7 calibre across (no floor), every triangle it catches clipped against its six
    // planes AND a thin slab round the struck facet's plane. At an angle the footprint stretches by 1 / cos i
    // along the plate with NO cap - the plate's edge ends it - and nothing spills onto the next plate or a
    // plate behind. Only a numeric guard (1 m each way along the plate) stops a near-tangent box.
    // WHY 0.7.25 showed nothing at all: the exported collision meshes are wound the other way round - over
    // 12 exported models and 13 299 triangles not one face normal points OUT of the vehicle, which is why
    // the painted mesh is drawn DoubleSide - so a decal has to be turned, and wound, to the side the shot
    // CAME from or front-face culling throws it away.
    rv2.clearHitMarks();
    const markSrc = viewerSrc.slice(viewerSrc.indexOf('// --- Hitmarks (user, 22.09)'), viewerSrc.indexOf('window.ArmorViewer=Viewer;'));
    // The three textures are drawn ONCE on a canvas for the life of the page. A canvas is a browser thing
    // and node has none, so the generator must degrade to a 1 x 1 transparent stub instead of throwing -
    // and every check below then runs on that stub, which is the point of covering this path.
    const sheet = RealViewer.hitMarkTextures();
    ok('fun: the three decal textures are made ONCE for the page, one per outcome, and degrade to a stub where there is no canvas',
       sheet === RealViewer.hitMarkTextures()
       && ['pen', 'no-pen', 'ricochet'].every(function (k) { return !!sheet[k] && sheet[k].isTexture === true && sheet[k].userData.stub === true; })
       && sheet.pen !== sheet['no-pen'] && sheet['no-pen'] !== sheet.ricochet && sheet.pen !== sheet.ricochet
       && sheet.pen.image.width === 1 && sheet.pen.image.height === 1);
    ok('fun: and they are drawn from the page’s own canvas - no client decal is read, and nothing falls back to a colour of the map',
       /function drawHole\(ctx,S\)/.test(markSrc) && /function drawScuff\(ctx,S\)/.test(markSrc)
       && /function drawGraze\(ctx,S\)/.test(markSrc) && /createRadialGradient/.test(markSrc) && /createLinearGradient/.test(markSrc)
       && markSrc.indexOf('chanceRgb') < 0 && markSrc.indexOf('ArmorBallistics.color') < 0
       && markSrc.indexOf('.dds') < 0 && markSrc.indexOf('damage_stickers') < 0);
    // node has no canvas, so the check above only shows that the generator does not throw without one. The
    // drawing itself is cut out of viewer.js the way the fun block is cut out of app.js and run against a
    // recording 2d context: each of the three really paints, with a gradient and a dark/light pairing, and
    // none of them asks for a colour of the chance palette.
    const drawSrc = viewerSrc.slice(viewerSrc.indexOf('  function markNoise('), viewerSrc.indexOf('  var markTextures=null;'));
    const draws = new Function('THREE', 'document', drawSrc + '\nreturn {pen: drawHole, "no-pen": drawScuff, ricochet: drawGraze};')(THREE, null);
    function recorder() {
      const log = {fill: 0, stroke: 0, stops: [], gradients: 0, linear: 0, points: [], controls: []};
      const grad = function () { return {addColorStop: function (at, c) { log.stops.push({at: at, colour: c}); }}; };
      return {log: log, ctx: {
        canvas: {width: 256, height: 256}, lineCap: '', lineWidth: 0, fillStyle: '', strokeStyle: '',
        createRadialGradient: function () { log.gradients++; return grad(); },
        createLinearGradient: function () { log.gradients++; log.linear++; return grad(); },
        beginPath: function () {}, closePath: function () {},
        moveTo: function (x, y) { log.points.push([x, y]); }, lineTo: function (x, y) { log.points.push([x, y]); },
        arc: function (x, y, r) { log.points.push([x - r, y - r], [x + r, y + r]); },
        quadraticCurveTo: function (cx, cy, x, y) { log.controls.push([cx, cy]); log.points.push([x, y]); },
        fill: function () { log.fill++; }, stroke: function () { log.stroke++; }
      }};
    }
    function painted(kind) { const r = recorder(); draws[kind](r.ctx, 256); return r.log; }
    function rgba(stop) { const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(stop.colour); return m ? {at: stop.at, r: +m[1], g: +m[2], b: +m[3], a: +m[4]} : null; }
    ok('fun: each of the three really paints when there IS a canvas - gradients, fills and a FEW bold strokes, a dark part against a light one',
       ['pen', 'no-pen', 'ricochet'].every(function (k) {
         const log = painted(k), stops = log.stops.map(rgba).filter(Boolean);
         return log.gradients > 0 && log.fill > 0 && log.stroke > 0 && log.stroke <= 10
           && stops.some(function (s) { return s.r < 90; }) && stops.some(function (s) { return s.r > 195; });
       }),
       '(' + ['pen', 'no-pen', 'ricochet'].map(function (k) { const l = painted(k); return k + ' ' + l.gradients + 'g/' + l.fill + 'f/' + l.stroke + 's'; }).join(', ') + ')');
    // What the user asked each one to LOOK like (22.09): the penetration is bare metal outside with a thin
    // burnt edge and dark red/black inside - NOT a red rim on the outside; its dark core is about 70 % of
    // the disc, so the hole reads as half a calibre inside a 0.7-calibre mark.
    const holeStops = painted('pen').stops.map(rgba).filter(Boolean);
    const inner = holeStops.filter(function (s) { return s.at < .72; }), outer = holeStops.filter(function (s) { return s.at >= .72 && s.at < .88; });
    const firstSteel = holeStops.filter(function (s) { return s.r > 150; })[0];
    ok('fun: the penetration is black with a dark red glow INSIDE its lip, bare grey steel outside it, the burnt edge last - and the dark core fills 70 % of the disc',
       inner.some(function (s) { return s.r < 20 && s.g < 20; })
       && inner.some(function (s) { return s.r > 90 && s.r > s.g * 2 && s.g > s.b; })
       && outer.length > 0 && outer.every(function (s) { return Math.abs(s.r - s.b) < 30 && s.r > 170; })
       && holeStops.filter(function (s) { return s.at >= .88 && s.at < 1; }).every(function (s) { return s.r < 40; })
       && !!firstSteel && firstSteel.at >= .7,
       '(inner ' + inner.map(function (s) { return s.r + ',' + s.g + ',' + s.b; }).join(' · ') + '; steel from ' + (firstSteel && firstSteel.at) + ')');
    const scuffStops = painted('no-pen').stops.map(rgba).filter(Boolean), grazeLog = painted('ricochet');
    const grazeStops = grazeLog.stops.map(rgba).filter(Boolean);
    function grey(s) { return s.every(function (c) { return Math.abs(c.r - c.g) < 12 && Math.abs(c.g - c.b) < 12; }); }
    ok('fun: the stop is a grey metal scrape - bright metal inside, the paint burnt black round it, no hue anywhere',
       grey(scuffStops) && scuffStops[0].r > 195
       && scuffStops.some(function (s) { return s.at >= .68 && s.r < 50 && s.a > .8; }));
    // The ricochet is the classic SKID: a lens drawn from one edge of the texture to the other along V (the
    // slide the projection stretches), dark grey at its sides and light in the middle, lighter and greyer
    // than the stop - never burnt black.
    const lensY = grazeLog.points.map(function (p) { return p[1]; });
    // a quadratic curve's widest point is half-way to its control point, so the lens is max|cx - c| wide
    const lensW = Math.max.apply(null, grazeLog.controls.map(function (c) { return Math.abs(c[0] - 128); }));
    const opaque = grazeStops.filter(function (s) { return s.a > .5; });
    ok('fun: the ricochet is a skid drawn edge to edge along the slide - dark grey at its sides, light down the middle, lighter than the scrape and never black',
       grey(grazeStops) && grazeLog.linear > 0
       && Math.min.apply(null, lensY) <= 256 * .03 && Math.max.apply(null, lensY) >= 256 * .97
       && lensW >= 256 * .3 && lensW <= 256 * .7
       && Math.min.apply(null, opaque.map(function (s) { return s.r; })) > 60
       && Math.max.apply(null, opaque.map(function (s) { return s.r; })) >= Math.max.apply(null, scuffStops.map(function (s) { return s.r; }))
       && opaque[0].r < opaque[Math.floor(opaque.length / 2)].r,
       '(spans ' + Math.min.apply(null, lensY).toFixed(0) + '…' + Math.max.apply(null, lensY).toFixed(0) + ' of 256 along, '
       + lensW.toFixed(0) + ' across; sides ' + opaque[0].r + ', middle ' + opaque[Math.floor(opaque.length / 2)].r + ')');

    // ---- the projection itself, on the real box model ------------------------------------------------
    // The model is the 6 x 2 x 3 m box of this section: its front face is the plane z = 1.5, x from -3 to 3
    // and y from 0 to 2. Every record below carries its own `from` and `dir`, so nothing here depends on
    // where the camera of the moment happens to stand.
    const FACE = 1.5, CAL = .105, SIZE = .7 * CAL;
    function range(piece, axis, from, count) {
      let lo = Infinity, hi = -Infinity;
      const a = from || 0, n = count === undefined ? piece.count - a : count;
      for (let i = a; i < a + n; i++) {
        const d = piece.position[i * 3] * axis.x + piece.position[i * 3 + 1] * axis.y + piece.position[i * 3 + 2] * axis.z;
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
      return {lo: lo, hi: hi, span: hi - lo, mid: (lo + hi) / 2};
    }
    function spread(piece, axis) { return range(piece, axis).span; }
    function shotAtAngle(degrees, point, kind, caliber, roll) {
      const a = degrees * Math.PI / 180, dir = new THREE.Vector3(0, -Math.sin(a), -Math.cos(a)).normalize();
      const from = point.clone().addScaledVector(dir, -20);
      return {point: point.clone(), normal: new THREE.Vector3(0, 0, -1), from: from, dir: dir,
              outcome: kind, caliber: caliber === undefined ? 105 : caliber, roll: roll || 0};
    }
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    const square = rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(0, 1, FACE), 'pen'));
    ok('fun: a square-on 105 mm hit is ROUND and 0.7 calibre across, both ways - 0.0735 m, the shell’s own size, never the model’s',
       !!square && Math.abs(spread(square, square.across) - SIZE) < 1e-6 && Math.abs(spread(square, square.along) - SIZE) < 1e-6
       && Math.abs(square.size - SIZE) < 1e-12 && square.count === 12,
       '(' + spread(square, square.across).toFixed(4) + ' x ' + spread(square, square.along).toFixed(4) + ' m, ' + (square && square.count) + ' vertices)');
    ok('fun: and it lies ON the plate, a hair off it along the facet’s own normal, centred on the contact point',
       (function () {
         const z = range(square, Z), x = range(square, X), y = range(square, Y);
         return z.span < 1e-9 && z.lo - FACE > 0 && z.lo - FACE < .01 && Math.abs(x.mid) < 1e-6 && Math.abs(y.mid - 1) < 1e-6;
       }()), '(+' + (square.position[2] - FACE).toFixed(4) + ' m)');
    // At 60 degrees off the normal the very same footprint covers 0.0735 / cos 60 = 0.147 m of plate along
    // the way the shell slid, stays 0.0735 m across it, and the contact point is its middle.
    const graze = rv2.hitMarkGeometry(shotAtAngle(60, new THREE.Vector3(0, 1, FACE), 'ricochet'));
    ok('fun: at 60 degrees the mark STRETCHES - 0.147 m along the plate, still 0.0735 m across it, the contact point in its middle',
       !!graze && Math.abs(spread(graze, Y) - SIZE / Math.cos(Math.PI / 3)) < 1e-6 && Math.abs(spread(graze, X) - SIZE) < 1e-6
       && Math.abs(range(graze, Y).mid - 1) < 1e-6 && Math.abs(range(graze, X).mid) < 1e-6,
       '(' + spread(graze, Y).toFixed(4) + ' along, ' + spread(graze, X).toFixed(4) + ' across, middle at y ' + range(graze, Y).mid.toFixed(6) + ')');
    ok('fun: and the stretch runs along the SLIDE - the decal’s own long axis leans into the plate the way the shell went',
       Math.abs(graze.along.dot(Z) - Math.sin(Math.PI / 3)) < 1e-6 && Math.abs(graze.across.dot(X)) > .999999,
       '(along · n = ' + graze.along.dot(Z).toFixed(4) + ')');
    // NO cap any more (user, 22.09, 22:50: "if it comes out longer, then longer"): 1 / cos i all the way, as
    // long as the plate lasts. Every one of these is well inside the 2 m plate, so every one is exact.
    const LONG = [60, 70, 80, 84].map(function (d) {
      return {deg: d, got: spread(rv2.hitMarkGeometry(shotAtAngle(d, new THREE.Vector3(0, 1, FACE), 'ricochet')), Y), want: SIZE / Math.cos(d * Math.PI / 180)};
    });
    ok('fun: the stretch has NO cap - 1 / cos i exactly, past the 4 calibres the last build stopped at',
       LONG.every(function (c) { return Math.abs(c.got - c.want) < 1e-6; }) && LONG[3].got > CAL * 4,
       '(' + LONG.map(function (c) { return c.deg + '° ' + c.got.toFixed(3); }).join(' · ') + ' m)');
    // 85 degrees near the bottom of the plate: 0.0735 / cos 85 = 0.843 m of skid, centred on y = 0.3, so its
    // lower half runs into the plate's edge at y = 0 and is cut exactly there.
    const at85 = rv2.hitMarkGeometry(shotAtAngle(85, new THREE.Vector3(0, .3, FACE), 'ricochet'));
    const r85 = range(at85, Y), half85 = SIZE / 2 / Math.cos(85 * Math.PI / 180);
    ok('fun: at 85 degrees the skid is long - and cut EXACTLY at the plate’s edge, not a millimetre over it',
       Math.abs(r85.lo) < 1e-9 && Math.abs(r85.hi - (.3 + half85)) < 1e-6 && spread(at85, X) - SIZE < 1e-6
       && range(at85, Z).span < 1e-9,
       '(y ' + r85.lo.toFixed(6) + ' … ' + r85.hi.toFixed(4) + ' m, uncut half ' + half85.toFixed(4) + ')');
    // Near the tangent the one guard steps in: a 1 m reach each way on the plate instead of 1 / cos i, and
    // the plate's edges cut even that - the skid runs from edge to edge of this 2 m plate.
    const tangent = rv2.hitMarkGeometry(shotAtAngle(89.9, new THREE.Vector3(0, 1, FACE), 'ricochet'));
    const rT = range(tangent, Y);
    ok('fun: a near-tangent hit asks for a finite box - the only guard, 1 m each way - and the plate’s edges end it',
       !!tangent && tangent.reach === 1 && Number.isFinite(tangent.depth) && tangent.depth < 1.1
       && Math.abs(rT.lo) < 1e-9 && Math.abs(rT.hi - 2) < 1e-9,
       '(reach ' + (tangent && tangent.reach) + ' m, box depth ' + (tangent && tangent.depth.toFixed(3)) + ' m, y ' + rT.lo.toFixed(4) + ' … ' + rT.hi.toFixed(4) + ')');
    // A round mark near an edge stops where the armour stops.
    const atEdge = rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(0, 2 - SIZE / 4, FACE), 'pen'));
    const rE = range(atEdge, Y);
    ok('fun: a square-on hit near the top of the plate is cut off AT the plate - nothing hangs over the edge',
       Math.abs(rE.hi - 2) < 1e-9 && rE.span < SIZE - 1e-6 && atEdge.count <= square.count,
       '(top ' + rE.hi.toFixed(6) + ' of 2, ' + rE.span.toFixed(4) + ' m tall, ' + atEdge.count + ' vertices)');
    // THE PLATE AND ONLY THE PLATE, on a scene built for it: the front plate z = 1.5, the adjacent top plate
    // y = 2 running back from its upper edge, and a PARALLEL plate 10 cm behind the front one (a spaced
    // screen seen from the other side). The long grazing box reaches both; the decal must touch neither.
    function plateScene() {
      const tris = [];
      function quad(a, b, c, d) { tris.push(a, b, c, a, c, d); }
      quad([-3, 0, 1.5], [3, 0, 1.5], [3, 2, 1.5], [-3, 2, 1.5]);        // the front plate
      quad([-3, 2, 1.5], [3, 2, 1.5], [3, 2, -1.5], [-3, 2, -1.5]);      // the adjacent top plate
      quad([-3, 0, 1.4], [3, 0, 1.4], [3, 2, 1.4], [-3, 2, 1.4]);        // parallel, 10 cm behind
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([].concat.apply([], tris), 3));
      const v = Object.create(RealViewer.prototype);
      v.scene = new THREE.Scene(); v.root = new THREE.Group(); v.scene.add(v.root);
      v.camera = rv2.camera; v.draw = function () {};
      v.paintMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); v.root.add(v.paintMesh); v.scene.updateMatrixWorld(true);
      return v;
    }
    const plates = plateScene();
    function onFront(piece) {
      for (let i = 0; i < piece.count; i++) {
        const y = piece.position[i * 3 + 1], z = piece.position[i * 3 + 2];
        if (Math.abs(z - (FACE + .006)) > 1e-6 || y > 2 + 1e-9 || y < -1e-9) return false;
      }
      return true;
    }
    // Shot upwards at 85 degrees from just under the top edge: the skid runs up into the corner.
    function upShot(degrees, y, caliber) {
      const a = degrees * Math.PI / 180, dir = new THREE.Vector3(0, Math.sin(a), -Math.cos(a)), p = new THREE.Vector3(.5, y, FACE);
      return {point: p, normal: new THREE.Vector3(0, 0, 1), from: p.clone().addScaledVector(dir, -20), dir: dir, outcome: 'ricochet', caliber: caliber, roll: 0};
    }
    const corner = plates.hitMarkGeometry(upShot(85, 1.8, 105));
    ok('fun: at 85 degrees into a corner the skid ends EXACTLY at the edge - nothing on the adjacent plate, nothing on the parallel plate 10 cm behind',
       !!corner && onFront(corner) && Math.abs(range(corner, Y).hi - 2) < 1e-9 && corner.triangles > 2,
       '(' + (corner && corner.count) + ' vertices, top ' + range(corner, Y).hi.toFixed(6) + ', ' + (corner && corner.triangles) + ' candidate triangles)');
    // And where the box really does reach through to the plate behind - a 300 mm shell at 60 degrees, a box
    // 0.2 m deep - the slab round the struck plane is what keeps it off: every vertex is on the front plate.
    const deep = plates.hitMarkGeometry(upShot(60, 1, 300));
    const boxBack = FACE - (deep.size / 2 * Math.sin(Math.PI / 3) + deep.depth * Math.cos(Math.PI / 3));
    ok('fun: a box that reaches THROUGH the parallel plate still paints only the plate that was hit - the slab round its plane',
       !!deep && boxBack < 1.4 && onFront(deep) && Math.abs(spread(deep, Y) - deep.size / Math.cos(Math.PI / 3)) < 1e-6,
       '(the box reaches z = ' + boxBack.toFixed(3) + ', the plate behind is at 1.4; slab ±' + deep.plane.toFixed(4) + ' m)');
    ok('fun: the decal is cut out of the very meshes the shot was cast against, and nothing at all of it runs per frame',
       /function markSurfaces\(viewer\)\{[^}]*viewer\.paintMesh[^}]*viewer\.trackMesh/.test(markSrc)
       && markSrc.indexOf('requestAnimationFrame') < 0 && markSrc.indexOf('onBeforeRender') < 0
       && markSrc.indexOf('getBoundingSphere') < 0 && markSrc.indexOf('this.bounds') < 0);
    // Every piece is projected from the box's own X/Y, so a texture coordinate cannot leave the picture.
    let uvLo = 2, uvHi = -1;
    [square, graze, atEdge, at85, tangent, corner, deep].forEach(function (p) { for (let i = 0; i < p.count * 2; i++) { uvLo = Math.min(uvLo, p.uv[i]); uvHi = Math.max(uvHi, p.uv[i]); } });
    ok('fun: the texture is projected from the box’s own footprint - every uv inside [0, 1], the corners at the corners',
       uvLo >= 0 && uvHi <= 1 && Math.abs(uvLo) < 1e-6 && Math.abs(uvHi - 1) < 1e-6
       && square.uv.length === square.count * 2,
       '(' + uvLo.toFixed(4) + ' … ' + uvHi.toFixed(4) + ')');
    // The normals, and the WINDING with them, face the side the shot came from - 0.7.25 culled every mark
    // because the exported meshes are wound inward and nothing turned them round.
    function facesShooter(piece, record) {
      const to = record.from.clone().sub(record.point).normalize();
      for (let i = 0; i < piece.count; i++) {
        const n = new THREE.Vector3(piece.normal[i * 3], piece.normal[i * 3 + 1], piece.normal[i * 3 + 2]);
        if (Math.abs(n.length() - 1) > 1e-6 || n.dot(to) <= .001) return false;
      }
      for (let t = 0; t < piece.count; t += 3) {
        const a = new THREE.Vector3(piece.position[t * 3], piece.position[t * 3 + 1], piece.position[t * 3 + 2]);
        const b = new THREE.Vector3(piece.position[t * 3 + 3], piece.position[t * 3 + 4], piece.position[t * 3 + 5]);
        const c = new THREE.Vector3(piece.position[t * 3 + 6], piece.position[t * 3 + 7], piece.position[t * 3 + 8]);
        const wound = b.sub(a).cross(c.sub(a));
        if (wound.dot(to) <= 0) return false;
      }
      return true;
    }
    const squareRec = shotAtAngle(0, new THREE.Vector3(0, 1, FACE), 'pen'), grazeRec = shotAtAngle(60, new THREE.Vector3(0, 1, FACE), 'ricochet');
    ok('fun: every face of every decal is turned AND wound to the side the shot came from, whichever way the record’s normal points',
       facesShooter(square, squareRec) && facesShooter(graze, grazeRec) && facesShooter(corner, upShot(85, 1.8, 105))
       && Math.abs(square.facing.dot(Z) - 1) < 1e-9,
       '(facing ' + square.facing.toArray().map(function (v) { return v.toFixed(2); }).join(', ') + ')');
    // The size is the SHELL's and nothing else (user, 22.09, 23:00: no minimum, "let it be what it is"): a
    // 20 mm gun leaves 14 mm, and a shell the record gives no calibre for leaves no mark at all.
    const small = rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(-1, 1, FACE), 'pen', 20));
    ok('fun: a 20 mm gun leaves a 14 mm mark - no floor any more - and a shell with no calibre leaves none',
       !!small && Math.abs(spread(small, small.across) - .014) < 1e-6 && Math.abs(spread(small, small.along) - .014) < 1e-6
       && rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(1, 1, FACE), 'pen', 0)) === null
       && rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(1, 1, FACE), 'pen', NaN)) === null
       && rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(1, 1, FACE), 'pen', 0)) === false && rv2.markCount === 0,
       '(' + spread(small, small.across).toFixed(4) + ' m)');
    // A shot that met no armour at all leaves nothing, and neither does one with no line to project along.
    ok('fun: a shot that met nothing - and one that met armour nowhere near it - leaves no decal at all',
       rv2.hitMarkGeometry({point: new THREE.Vector3(0, 1, FACE), normal: null, outcome: 'pen', caliber: 105}) === null
       && rv2.hitMarkGeometry({normal: Z.clone(), outcome: 'pen', caliber: 105}) === null
       && rv2.hitMarkGeometry(null) === null
       && rv2.hitMarkGeometry(shotAtAngle(0, new THREE.Vector3(0, 40, FACE), 'pen')) === null
       && rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(0, 40, FACE), 'pen')) === false);
    // A mark laid again on a rebuilt scene must be the SAME mark - the page re-lays its kept records after
    // every model change, and a re-laid decal that differed by a vertex would be a second, brighter copy.
    const again = rv2.hitMarkGeometry(grazeRec);
    rv2.camera.position.set(0, 2, -60); rv2.camera.updateMatrixWorld();
    const afterMove = rv2.hitMarkGeometry(grazeRec);
    rv2.camera.position.set(0, 2, 20); rv2.camera.updateMatrixWorld();
    ok('fun: a kept record laid again is the same decal, vertex for vertex - turned by its own shot, not by the camera of the moment',
       again.count === graze.count && afterMove.count === graze.count
       && graze.position.every(function (v, i) { return v === again.position[i] && v === afterMove.position[i]; })
       && graze.uv.every(function (v, i) { return v === again.uv[i]; })
       && graze.normal.every(function (v, i) { return v === again.normal[i]; }));
    // A record whose normal is not the face the point lies on (made by hand - a pinned shot always carries
    // the face the ray met) is laid out on the facet found under the point, and comes out the same.
    const handRec = shotAtAngle(60, new THREE.Vector3(0, 1, FACE), 'ricochet');
    handRec.normal = new THREE.Vector3(0, 1, 0);
    const byHand = rv2.hitMarkGeometry(handRec);
    ok('fun: a record carrying a wrong normal is laid out on the facet under the point - the same decal as the right one',
       !!byHand && byHand.count === graze.count && byHand.position.every(function (v, i) { return v === graze.position[i]; }));

    // ---- ONE merged buffer per outcome ---------------------------------------------------------------
    rv2.clearHitMarks();
    const OUTCOMES = ['pen', 'no-pen', 'ricochet'];
    const SHOTS = [new THREE.Vector3(-1, 1, FACE), new THREE.Vector3(0, 1.4, FACE), new THREE.Vector3(1.2, .6, FACE)];
    SHOTS.forEach(function (p, i) { rv2.addHitMark(shotAtAngle(i * 20, p, OUTCOMES[i], 105, i * 1.1)); });
    const meshes = rv2.hitMarkMeshes();
    function drawn(kind) { return meshes[kind].geometry.drawRange.count; }
    // 22.09, 23:15: the buffers are per PART and outcome, each part's in one group of its own. A record with
    // no part (these, made by hand in world coordinates) lives in the world's own group, which never moves.
    const worldSet = rv2.markSets && rv2.markSets.w;
    ok('fun: three outcomes, three ordinary meshes in ONE group of the scene, ONE merged geometry each, wearing its own texture, the three materials shared',
       OUTCOMES.every(function (k) { return meshes[k].isMesh === true && meshes[k].isInstancedMesh !== true
         && meshes[k].parent === worldSet.group && meshes[k].material.map === sheet[k] && meshes[k].material === rv2.markMaterials[k]
         && meshes[k].userData.chunks.length === 1 && drawn(k) === meshes[k].userData.vertices && drawn(k) > 0
         && meshes[k].visible === true
         && meshes[k].geometry.getAttribute('position').itemSize === 3
         && meshes[k].geometry.getAttribute('uv').itemSize === 2; })
       && rv2.markCount === 3 && rv2.hitMarkLimit() === 500
       && Object.keys(rv2.markSets).join() === 'w' && worldSet.group.parent === rv2.scene
       && worldSet.group.matrixAutoUpdate === false && worldSet.group.matrix.equals(new THREE.Matrix4())
       && rv2.scene.children.filter(function (o) { return o.isMesh; }).length === 0,
       '(' + OUTCOMES.map(function (k) { return k + ' ' + drawn(k) + 'v'; }).join(', ') + ')');
    const beforeAdd = drawn('pen');
    rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(-2, 1, FACE), 'pen'));
    const afterAdd = drawn('pen');
    ok('fun: a second mark of the same outcome is APPENDED to that one buffer - the vertex count grows, nothing is rebuilt',
       afterAdd > beforeAdd && meshes.pen.userData.chunks.length === 2
       && meshes.pen.userData.chunks[1].start === beforeAdd
       && meshes.pen.geometry.getAttribute('position').array.length >= afterAdd * 3,
       '(' + beforeAdd + ' → ' + afterAdd + ' vertices)');
    const firstPen = meshes.pen.userData.chunks[0].slot;
    rv2.dropHitMark(firstPen);
    ok('fun: and dropping one shrinks that buffer again, with the marks after it slid down into its place',
       drawn('pen') === afterAdd - beforeAdd && meshes.pen.userData.chunks.length === 1
       && meshes.pen.userData.chunks[0].start === 0 && rv2.markSlots[3][0] === meshes.pen.userData.chunks[0]
       && rv2.markSlots[firstPen] === null && rv2.markCount === 3,
       '(' + afterAdd + ' → ' + drawn('pen') + ' vertices)');
    // three uploads ONLY the listed ranges whenever there are any. A buffer that owes a WHOLE upload - a mark
    // slid out of its middle - must stay owed it when the ring's next append comes before the frame, or the
    // slid-down marks would stay stale on the GPU; once three has sent it, an append sends its tail alone.
    (function () {
      const pa = meshes.pen.geometry.getAttribute('position');
      pa.onUploadCallback();
      pa.clearUpdateRanges();
      rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(-2.5, 1, FACE), 'pen'));
      const tailOnly = pa.updateRanges.length === 1 && pa.markWhole === false;
      const version = pa.version;
      rv2.dropHitMark(meshes.pen.userData.chunks[0].slot);
      rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(-2.2, 1, FACE), 'pen'));
      const stillWhole = pa.updateRanges.length === 0 && pa.markWhole === true && pa.version > version;
      pa.onUploadCallback();
      rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(-1.9, 1, FACE), 'pen'));
      const tailAgain = pa.updateRanges.length === 1 && pa.markWhole === false;
      ok('fun: an eviction and an append to the same buffer before the next frame still upload that buffer WHOLE; after the upload an append sends only its tail',
         tailOnly && stillWhole && tailAgain, '(' + tailOnly + ' / ' + stillWhole + ' / ' + tailAgain + ')');
    }());
    ok('fun: an unjudged shot takes the scrape, muted grey, written into the vertices themselves; a judged one is left as the texture drew it',
       (function () {
         rv2.clearHitMarks();
         rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(0, 1, FACE), 'no-pen'));
         rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(.5, 1, FACE), 'unknown'));
         const live = rv2.hitMarkMeshes()['no-pen'], colour = live.geometry.getAttribute('color').array;
         const chunk = live.userData.chunks[1], muted = new THREE.Color(0x7f8488);
         return colour[0] === 1 && colour[1] === 1 && colour[2] === 1
           && Math.abs(colour[chunk.start * 3] - muted.r) < 1e-6 && Math.abs(colour[chunk.start * 3 + 2] - muted.b) < 1e-6
           && live.material.vertexColors === true;
       }()));
    ok('fun: the decals are drawn over the composed map (quad 0, screens 1-2) and under the tracers (4) and the rings (12, 14), depth-tested, offset, writing no depth, culled from behind',
       OUTCOMES.every(function (k) {
         const m = meshes[k].material;
         return meshes[k].renderOrder === 3 && meshes[k].frustumCulled === false && m.transparent === true
           && m.depthTest === true && m.depthWrite === false && m.polygonOffset === true
           && m.polygonOffsetFactor < 0 && m.side === THREE.FrontSide;
       }),
       '(renderOrder ' + meshes.pen.renderOrder + ', depthTest ' + meshes.pen.material.depthTest + ')');

    // ---- ONE ring of 500 across the three meshes -----------------------------------------------------
    rv2.clearHitMarks();
    const KIND3 = ['pen', 'no-pen', 'ricochet'];
    for (let i = 0; i < 501; i++)
      rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(i * .002, 1, FACE), KIND3[i % 3]));
    const live = rv2.hitMarkMeshes();
    // Which marks are alive, by the x the shot was fired at: the middle of every live chunk's vertices.
    function liveX() {
      const xs = [];
      KIND3.forEach(function (k) {
        const pos = live[k].geometry.getAttribute('position').array;
        live[k].userData.chunks.forEach(function (c) {
          let sum = 0;
          for (let v = 0; v < c.count; v++) sum += pos[(c.start + v) * 3];
          xs.push(sum / c.count);
        });
      });
      return xs.sort(function (a, b) { return a - b; });
    }
    const chunks = KIND3.reduce(function (n, k) { return n + live[k].userData.chunks.length; }, 0), xs = liveX();
    ok('fun: 500 marks all told, in three buffers that share ONE ring - the 501st dropped the oldest, which lived in another buffer than its own',
       rv2.markCount === 500 && chunks === 500
       && live.pen.userData.chunks.length === 166 && live['no-pen'].userData.chunks.length === 167 && live.ricochet.userData.chunks.length === 167
       && KIND3.every(function (k) { return live[k].geometry.drawRange.count === live[k].userData.vertices
         && live[k].userData.chunks.reduce(function (n, c) { return n + c.count; }, 0) === live[k].userData.vertices; }),
       '(' + KIND3.map(function (k) { return k + ' ' + live[k].userData.chunks.length; }).join(', ') + ')');
    ok('fun: and it really is the OLDEST that went, whatever buffer it was in',
       xs.length === 500 && Math.abs(xs[0] - .002) < 1e-6 && Math.abs(xs[499] - 1) < 1e-6,
       '(' + xs[0].toFixed(3) + ' … ' + xs[499].toFixed(3) + ')');
    const roomBefore = KIND3.map(function (k) { return live[k].geometry.getAttribute('position').array.length; });
    for (let i = 0; i < 200; i++)
      rv2.addHitMark(shotAtAngle(0, new THREE.Vector3(2 + i * .002, 1, FACE), 'pen'));
    const xs2 = liveX(), unique = new Set(xs2.map(function (v) { return v.toFixed(5); }));
    // A burst of one outcome fills its own buffer and empties the other two: the two that only shrink keep
    // the room they had - a buffer is never rebuilt to give room back - and the one that grows doubles it,
    // which is the only allocation in the whole thing.
    const roomAfter = KIND3.map(function (k) { return live[k].geometry.getAttribute('position').array.length; });
    ok('fun: a long burst past the cap keeps exactly 500 live marks, never loses one or draws one twice, and allocates only where the buffer overflowed',
       rv2.markCount === 500 && xs2.length === 500 && unique.size === 500
       && KIND3.reduce(function (n, k) { return n + live[k].userData.chunks.length; }, 0) === 500
       && Math.abs(xs2[499] - 2.398) < 1e-6
       && roomAfter[1] === roomBefore[1] && roomAfter[2] === roomBefore[2]
       && roomAfter[0] === roomBefore[0] * 2 && roomAfter[0] >= live.pen.userData.vertices * 3,
       '(' + unique.size + ' distinct · newest ' + xs2[499].toFixed(3) + ' · room ' + roomBefore.join('/') + ' → ' + roomAfter.join('/') + ')');
    const liveGroup = rv2.markSets.w.group, liveMaterial = rv2.markMaterials.pen;
    let freed = 0;
    liveMaterial.addEventListener('dispose', function () { freed++; });
    ok('fun: clearing drops every group, mesh and material and the ring, not only the counts - and leaves the page’s three textures alone',
       rv2.clearHitMarks() === true && rv2.markSets === null && rv2.markMaterials === null && rv2.markCount === 0 && rv2.markSlots === null
       && liveGroup.parent === null && freed === 1 && rv2.clearHitMarks() === false
       && RealViewer.hitMarkTextures() === sheet);

    // ---- the BVH path, and what one decal costs on the heaviest exported model -----------------------
    // The page's painted mesh carries no bounds tree today, so the walk with a box reject per triangle is
    // the live path; the tree is asked when a geometry has one. Both must give the very same decal.
    const Mod = require('node:module'), resolveOrig = Mod._resolveFilename;
    Mod._resolveFilename = function (request) { return request === 'three' ? 'three' : resolveOrig.apply(this, arguments); };
    require.cache.three = new Mod('three', null);
    require.cache.three.filename = 'three'; require.cache.three.loaded = true; require.cache.three.exports = THREE;
    const bvhLib = require(path + 'vendor/three-mesh-bvh.umd.js');
    Mod._resolveFilename = resolveOrig;
    const walked = rv2.hitMarkGeometry(grazeRec);
    fbox.boundsTree = new bvhLib.MeshBVH(fbox);
    const cast = rv2.hitMarkGeometry(grazeRec);
    delete fbox.boundsTree;
    ok('fun: a geometry that carries a three-mesh-bvh bounds tree is asked through it, and gives the very same decal',
       !!cast && cast.count === walked.count && cast.triangles > 0
       && [].slice.call(cast.position).sort().join() === [].slice.call(walked.position).sort().join()
       && [].slice.call(cast.uv).sort().join() === [].slice.call(walked.uv).sort().join(),
       '(' + walked.count + ' vertices, ' + walked.triangles + ' candidates from the walk / ' + cast.triangles + ' from the tree - a leaf hands over all of its own)');
    // The cost, on the heaviest vehicle the exported models under preview/data/models add up to. Read
    // only: nothing there is written, and the check is skipped where the folder is not there at all.
    (function () {
      const modelDir = path.replace(/web\/$/, '') + 'preview/data/models/';
      if (!fs.existsSync(modelDir)) { console.log('SKIP fun: (no exported models beside this copy of web/ - the decal cost is not measured)'); return; }
      const owners = {};
      fs.readdirSync(modelDir).forEach(function (f) {
        let got = null;
        const sandbox = {ArmorInspectorData: {receive: function (x) { got = x; }}};
        require('node:vm').runInNewContext(fs.readFileSync(modelDir + f, 'utf8'), sandbox);
        const model = got[1], who = String(model.resource || f).split('/').slice(0, 3).join('/');
        const owner = owners[who] || (owners[who] = {who: who, tris: 0, parts: []});
        (model.groups || []).forEach(function (g) { owner.tris += g.indices.length / 3; });
        owner.parts.push(model);
      });
      let worst = null;
      Object.keys(owners).forEach(function (k) { if (!worst || owners[k].tris > worst.tris) worst = owners[k]; });
      const xyz = [];
      worst.parts.forEach(function (m) { m.groups.forEach(function (g) {
        for (let i = 0; i < g.indices.length; i++) { const p = g.vertices[g.indices[i]]; xyz.push(p[0], p[1], -p[2]); }
      }); });
      const heavy = new THREE.BufferGeometry();
      heavy.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
      const hv = Object.create(RealViewer.prototype);
      hv.scene = new THREE.Scene(); hv.root = new THREE.Group(); hv.scene.add(hv.root);
      hv.camera = rv2.camera; hv.draw = function () {};
      hv.paintMesh = new THREE.Mesh(heavy, new THREE.MeshBasicMaterial());
      hv.root.add(hv.paintMesh); hv.scene.updateMatrixWorld(true);
      // 200 impact points spread over the whole model, each with the normal of the face it lies on - what a
      // pinned shot carries (the face the ray met) - so the one-pass path is the one being timed.
      const at = [], faceNormals = [], pos = heavy.getAttribute('position').array, tris = pos.length / 9;
      for (let i = 0; i < 200; i++) {
        const t = Math.floor(i / 200 * tris) * 9;
        at.push(new THREE.Vector3((pos[t] + pos[t + 3] + pos[t + 6]) / 3, (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3, (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3));
        faceNormals.push(new THREE.Triangle(new THREE.Vector3(pos[t], pos[t + 1], pos[t + 2]), new THREE.Vector3(pos[t + 3], pos[t + 4], pos[t + 5]),
          new THREE.Vector3(pos[t + 6], pos[t + 7], pos[t + 8])).getNormal(new THREE.Vector3()));
      }
      const eye = new THREE.Vector3(0, 3, 30);
      function cost(n) {
        let verts = 0, built = 0;
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < n; i++) {
          const p = at[i % at.length];
          const g = hv.hitMarkGeometry({point: p, normal: faceNormals[i % at.length], from: eye,
                                        dir: p.clone().sub(eye).normalize(), outcome: 'pen', caliber: 105, roll: 0});
          if (g) { built++; verts += g.count; }
        }
        return {ms: Number(process.hrtime.bigint() - t0) / 1e6 / n, built: built, verts: verts / Math.max(1, built)};
      }
      cost(200);
      const walk = cost(1000);
      heavy.boundsTree = new bvhLib.MeshBVH(heavy);
      let passes = 0;
      const shapecast = heavy.boundsTree.shapecast;
      heavy.boundsTree.shapecast = function () { passes++; return shapecast.apply(this, arguments); };
      const tree = cost(1000);
      heavy.boundsTree.shapecast = shapecast;
      ok('fun: one decal on the heaviest exported vehicle costs well under a millisecond, once per shot and never per frame',
         walk.ms < 3 && walk.built === 1000 && tree.ms <= walk.ms && passes === 1000,
         '(' + worst.who + ', ' + worst.tris + ' triangles: ' + walk.ms.toFixed(3) + ' ms by the walk, '
         + tree.ms.toFixed(3) + ' ms through a bounds tree, ' + (passes / 1000).toFixed(2) + ' model pass a shot, ' + walk.verts.toFixed(0) + ' vertices a decal)');
    }());

    // ---- the marks follow their PART, and there is one mark at every plate the shell met (22.09, 23:15) ---
    // A real four-part vehicle driven through the viewer's own rebuild, pose and pin paths: a hull box with a
    // 10 mm CLOSED screen standing in front of it, a turret on top, a gun with a barrel and a mantlet set
    // flush into the turret face. Model coordinates, each part with its own recorded transform; the viewer
    // mirrors z, so the model's -z is the side facing the shooters below.
    (function () {
      const T3 = THREE, F = new T3.Matrix4().makeScale(1, 1, -1);
      function box(x0, x1, y0, y1, z0, z1) {
        return {vertices: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
                indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]};
      }
      function grp(material, b) { return {material: material, vertices: b.vertices, indices: b.indices}; }
      const ARM = {armor_1: {armor: 100, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, checkCaliberForRicochet: true, useArmorHomogenization: true},
                   armor_s: {armor: 10, vehicleDamageFactor: 0, useHitAngle: true, mayRicochet: true}};
      function vehicle(yaw) {
        const turret = new T3.Matrix4().makeTranslation(0, 1.6, 0).multiply(new T3.Matrix4().makeRotationY(yaw));
        const gun = turret.clone().multiply(new T3.Matrix4().makeTranslation(0, .4, -1.2));
        return {hit: {aim: [0, 0], target: {parts: [
            {id: 1, transform: new T3.Matrix4().toArray(), armor: ARM},
            {id: 2, transform: turret.toArray(), armor: ARM},
            {id: 3, transform: gun.toArray(), armor: ARM}]}},
          models: {
            1: {groups: [grp('armor_1', box(-3, 3, .4, 1.6, -1.5, 1.5)), grp('armor_s', box(-1, 1, .5, 1.3, -1.71, -1.70))]},
            2: {groups: [grp('armor_1', box(-1.2, 1.2, 0, .8, -1.2, 1.2))]},
            3: {groups: [grp('armor_1', box(-.1, .1, -.1, .1, -3, 0)), grp('armor_1', box(-.4, .4, -.2, .2, 0, .05))]}}};
      }
      const v = Object.create(RealViewer.prototype);
      v.scene = new T3.Scene(); v.root = new T3.Group(); v.scene.add(v.root);
      v.camera = new T3.PerspectiveCamera(38, 800 / 600, .1, 1000);
      v.draw = function () {}; v.render = function () {};
      v.materials = []; v.surface = null; v.reticles = []; v.pinReticles = []; v.pinned = null; v.pinGroup = null; v.pinCache = null;
      v.reticleLayer = new Element('div'); v.turretAngle = 0; v.gunAngle = 0; v.aimGroup = null;
      v.heatmap = true; v.trackOpacity = .12; v.showOutline = false; v.outlineStyle = {brightness: .8, opacity: .06};
      v.hitMarks = true;
      v.loadedData = vehicle(0); v.posedData = null; v.poseBuilt = null;
      v.rebuild(); v.scene.updateMatrixWorld(true);
      const AP = ArmorBallistics.shell('ARMOR_PIERCING', 250, 105);
      v.shell = AP;
      // A shot the way the page fires one: the camera stands at the gun, pinAtPoint casts the drawn model and
      // the ONE engine ray, and the record is made from what that ray already holds.
      let rays = 0;
      const ray = v.engine.ray;
      function shoot(from, through, verdict) {
        v.engine.ray = function () { rays++; return ray.apply(this, arguments); };
        v.camera.position.copy(from); v.camera.updateMatrixWorld();
        v.pinCache = null; v.pinned = null;
        v.pinAtPoint(through);
        const before = rays, rec = v.hitMarkShot(verdict, 105, .3);
        v.engine.ray = ray;
        return {rec: rec, result: v.pinResult, extra: rays - before};
      }
      function worldOf(chunk) {
        const m = chunk.mesh.parent.matrix, p = chunk.mesh.geometry.getAttribute('position').array, out = [];
        for (let i = 0; i < chunk.count; i++) out.push(new T3.Vector3().fromArray(p, (chunk.start + i) * 3).applyMatrix4(m));
        return out;
      }
      function gap(a, b) {
        if (!a || !b || a.length !== b.length) return Infinity;
        let worst = 0;
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, a[i].distanceTo(b[i]));
        return worst;
      }
      function moved(list, m) { return list.map(function (p) { return p.clone().applyMatrix4(m); }); }
      function span(list, axis) { let lo = Infinity, hi = -Infinity; list.forEach(function (p) { const d = p.getComponent(axis); lo = Math.min(lo, d); hi = Math.max(hi, d); }); return {lo: lo, hi: hi}; }

      // ---- 2. one mark per plate: a screen passed, then the main plate --------------------------------
      const screenShot = shoot(new T3.Vector3(0, .9, 20), new T3.Vector3(0, .9, 0), {outcome: 'no-pen', u: .99});
      const sLayers = screenShot.result.layers;
      ok('contacts: the verdict’s own path already holds every plate - the screen’s near face, its far face and the hull, each with its distance and facet',
         sLayers.length === 3 && !sLayers[0].main && !sLayers[1].main && sLayers[2].main
         && sLayers.every(function (l) { return Number.isFinite(l.distance) && Array.isArray(l.normal); })
         && Math.abs(sLayers[0].distance - (20 - 1.71)) < 1e-9 && Math.abs(sLayers[2].distance - 18.5) < 1e-9,
         '(' + sLayers.map(function (l) { return (l.main ? 'm' : 's') + l.nominal + '@' + l.distance.toFixed(3); }).join(' ') + ')');
      const sm = screenShot.rec && screenShot.rec.marks;
      ok('contacts: a shot through a screen onto the hull makes TWO marks - a hole in the screen, the rolled stop on the main plate - the screen’s far face none, and no ray is cast for them',
         !!sm && sm.length === 2 && sm[0].outcome === 'pen' && sm[1].outcome === 'no-pen' && sm[0].part === 1 && sm[1].part === 1
         && Math.abs(sm[0].point.z - 1.71) < 1e-9 && Math.abs(sm[1].point.z - 1.5) < 1e-9 && screenShot.extra === 0
         && screenShot.rec.caliber === 105 && screenShot.rec.roll === .3,
         '(' + (sm ? sm.map(function (m) { return m.outcome + '@z' + m.point.z.toFixed(3); }).join(', ') : 'none') + ')');
      v.addHitMark(screenShot.rec);
      const sSlot = v.markSlots && v.markSlots[0], hullSet = v.markSets && v.markSets['1'];
      ok('contacts: laid, they are ONE entry of the ring - two pieces, the hole in the hull’s penetration buffer on the screen, the stop in its no-pen buffer on the plate',
         v.markCount === 1 && !!sSlot && sSlot.length === 2 && !!hullSet
         && sSlot[0].mesh === hullSet.meshes.pen && sSlot[1].mesh === hullSet.meshes['no-pen']
         && span(worldOf(sSlot[0]), 2).lo > 1.71 && span(worldOf(sSlot[0]), 2).hi < 1.72
         && span(worldOf(sSlot[1]), 2).lo > 1.5 && span(worldOf(sSlot[1]), 2).hi < 1.51,
         '(' + v.markCount + ' shot, ' + (sSlot ? sSlot.length : 0) + ' pieces; screen z ' + (sSlot ? span(worldOf(sSlot[0]), 2).lo.toFixed(4) : '-') + ')');
      // The ring counts SHOTS: 500 more and the first one goes - with both of its pieces.
      for (let i = 0; i < 500; i++)
        v.addHitMark({point: new T3.Vector3(-2.8 + i * .01, 1.2, 1.5), normal: new T3.Vector3(0, 0, 1), from: new T3.Vector3(-2.8 + i * .01, 1.2, 20),
                      dir: new T3.Vector3(0, 0, -1), outcome: 'pen', caliber: 20, roll: 0});
      ok('contacts: evicting that shot takes BOTH of its pieces out of their buffers, wherever they were',
         v.markCount === 500 && hullSet.meshes.pen.userData.chunks.indexOf(sSlot[0]) < 0
         && hullSet.meshes['no-pen'].userData.chunks.length === 0 && hullSet.meshes['no-pen'].visible === false
         && hullSet.meshes.pen.userData.chunks.length === 0 && v.markSets.w.meshes.pen.userData.chunks.length === 500,
         '(' + v.markCount + ' shots; hull pen ' + hullSet.meshes.pen.userData.chunks.length + ', hull no-pen ' + hullSet.meshes['no-pen'].userData.chunks.length + ')');
      v.clearHitMarks();

      // An HE shell the screen stops: the page rolls it dead on the screen (u above the pass chance), so the
      // screen gets the stop and nothing behind it gets anything.
      v.shell = ArmorBallistics.shell('HIGH_EXPLOSIVE', 30, 105);
      const stopped = shoot(new T3.Vector3(0, .9, 20), new T3.Vector3(0, .9, 0), {outcome: 'no-pen', u: .5});
      v.shell = AP;
      const st = stopped.rec && stopped.rec.marks;
      ok('contacts: an HE shell the roll kills on the screen leaves the stop ON the screen and nothing on the hull',
         stopped.result.screenPass < .5 && !!st && st.length === 1 && st[0].outcome === 'no-pen' && Math.abs(st[0].point.z - 1.71) < 1e-9,
         '(pass ' + stopped.result.screenPass + ', ' + (st ? st.map(function (m) { return m.outcome + '@z' + m.point.z.toFixed(3); }).join(', ') : 'none') + ')');

      // ---- the ricochet the engine FOLLOWS: the skid, then the plate the shell flies into ----------------
      const a10 = 10 * Math.PI / 180, roofAt = new T3.Vector3(.6, 1.6, 1.4), down = new T3.Vector3(0, -Math.sin(a10), -Math.cos(a10));
      const glance = shoot(roofAt.clone().addScaledVector(down, -20), roofAt, {outcome: 'pen', u: .2});
      const gm = glance.rec && glance.rec.marks;
      ok('contacts: a shell that glances off the roof leaves the skid there AND a mark on the turret face it flies into - the flight the page’s engine already follows',
         !!glance.result.bounce && glance.result.bounce.part === 1 && glance.result.reason === 'penetration'
         && !!gm && gm.length === 2 && gm[0].outcome === 'ricochet' && gm[0].part === 1 && gm[1].outcome === 'pen' && gm[1].part === 2
         && gm[0].point.distanceTo(roofAt) < 1e-6 && glance.extra === 0,
         '(' + (gm ? gm.map(function (m) { return m.outcome + '/part ' + m.part; }).join(', ') : 'none') + ')');
      v.clearHitMarks();
      // A shot the page cannot judge at all (no shell) keeps the one muted mark it always had, on the part the
      // drawn face belongs to.
      v.shell = null;
      const blind = shoot(new T3.Vector3(2.5, 1, 20), new T3.Vector3(2.5, 1, 0), {outcome: 'unknown'});
      v.shell = AP;
      ok('contacts: a line with no verdict keeps its ONE mark at the pinned point, on the drawn face’s own part',
         blind.result === null && !!blind.rec && blind.rec.marks.length === 1 && blind.rec.marks[0].outcome === 'unknown'
         && blind.rec.marks[0].part === 1 && Math.abs(blind.rec.marks[0].point.z - 1.5) < 1e-9);

      // ---- 1. each mark lives in its part --------------------------------------------------------------
      const shotT = shoot(new T3.Vector3(.6, 2, 20), new T3.Vector3(.6, 2, 0), {outcome: 'pen', u: .1});
      const shotG = shoot(new T3.Vector3(20, 2, 3), new T3.Vector3(0, 2, 3), {outcome: 'no-pen', u: .9});
      const shotH = shoot(new T3.Vector3(2.5, 1, 20), new T3.Vector3(2.5, 1, 0), {outcome: 'ricochet'});
      ok('parts: the turret, the gun and the hull shots name the part the RAY met, not a guess',
         shotT.rec.marks.length === 1 && shotT.rec.marks[0].part === 2 && shotG.rec.marks[0].part === 3 && shotH.rec.marks[0].part === 1,
         '(' + [shotT, shotG, shotH].map(function (s) { return s.rec.marks.map(function (m) { return m.part; }).join('+'); }).join(' / ') + ')');
      [shotT, shotG, shotH].forEach(function (s) { v.addHitMark(s.rec); });
      const cT = v.markSlots[0][0], cG = v.markSlots[1][0], cH = v.markSlots[2][0];
      const sets = v.markSets;
      ok('parts: each part with marks has ONE group of its own in the scene, carrying the part’s world matrix, and its marks are children of it',
         Object.keys(sets).sort().join() === '1,2,3' && ['1', '2', '3'].every(function (k) { return sets[k].group.parent === v.scene && sets[k].group.matrixAutoUpdate === false; })
         && cT.mesh.parent === sets['2'].group && cG.mesh.parent === sets['3'].group && cH.mesh.parent === sets['1'].group
         && sets['2'].group.matrix.equals(F.clone().multiply(new T3.Matrix4().fromArray(v.loadedData.hit.target.parts[1].transform)).multiply(F)),
         '(' + Object.keys(sets).join(', ') + ')');
      const bT = worldOf(cT), bG = worldOf(cG), bH = worldOf(cH);
      ok('parts: (the turret mark lies on the turret face, the gun mark on the barrel’s side)',
         span(bT, 2).lo > 1.2 && span(bT, 2).hi < 1.21 && span(bG, 0).lo > .1 && span(bG, 0).hi < .11);
      const locals = [cT, cG, cH].map(function (c) { return c.mesh.geometry.getAttribute('position').array.slice(); });
      const versions = [cT, cG, cH].map(function (c) { return c.mesh.geometry.getAttribute('position').version; });
      // The drag: 30 degrees of turret and 5 of gun, previewed the way a drag previews them.
      v.turretTo(30); v.gunTo(5); v.previewPose();
      const extra = v.poseExtra(), D2 = F.clone().multiply(extra[2]).multiply(F), D3 = F.clone().multiply(extra[3]).multiply(F);
      const eT = gap(worldOf(cT), moved(bT, D2)), eG = gap(worldOf(cG), moved(bG, D3)), eH = gap(worldOf(cH), bH);
      ok('parts: dragging the turret 30° and the gun 5° turns the turret mark with the turret and pitches the gun mark with the gun - world = part matrix × local - and the hull mark stays',
         eT < 1e-5 && eG < 1e-5 && eH === 0 && gap(bT, worldOf(cT)) > .1 && gap(bG, worldOf(cG)) > .05,
         '(turret ' + eT.toExponential(1) + ', gun ' + eG.toExponential(1) + ', hull ' + eH + ' m off; the turret mark moved ' + gap(bT, worldOf(cT)).toFixed(3) + ' m)');
      ok('parts: and it moved NO vertex: the kept coordinates and their upload count are exactly what they were',
         [cT, cG, cH].every(function (c, i) { const a = c.mesh.geometry.getAttribute('position'); return a.version === versions[i] && a.array.every(function (x, j) { return x === locals[i][j]; }); }));
      // The drag settles: the full rebuild of the posed model sets the very same matrices.
      v.pinned = null; v.applyTurret();
      const fT = worldOf(cT), fG = worldOf(cG);
      ok('parts: when the pose settles (a full rebuild) the marks stay on their turned turret and pitched gun',
         gap(fT, moved(bT, D2)) < 1e-5 && gap(fG, moved(bG, D3)) < 1e-5 && gap(worldOf(cH), bH) === 0);
      // The turned turret really is where the mark now lies: every vertex a lift off the posed turret face.
      const faceN = new T3.Vector3(0, 0, 1).transformDirection(D2);
      const faceHit = new T3.Raycaster(fT[0].clone().addScaledVector(faceN, 1), faceN.clone().negate()).intersectObjects([v.paintMesh])[0];
      ok('parts: (and that is ON the turned turret: a mark vertex sits the 6 mm lift off the face the rebuilt, turned model has there)',
         !!faceHit && Math.abs(faceHit.distance - 1.006) < 1e-4,
         '(' + (faceHit ? (faceHit.distance - 1).toFixed(5) : 'no face') + ' m off the face)');
      // A shooter change re-lays the kept records on the rebuilt scene: the turret record, laid again while
      // the turret stands at 30°, lands on the spot it had followed the turret to.
      v.clearHitMarks();
      v.addHitMark(shotT.rec); v.addHitMark(shotH.rec);
      const rT = worldOf(v.markSlots[0][0]), rH = worldOf(v.markSlots[1][0]);
      ok('parts: the kept turret record laid again after the turret turned lands on the SAME spot of the turret - the hull one where it was',
         gap(rT, fT) < 1e-5 && gap(rH, bH) < 1e-6, '(' + gap(rT, fT).toExponential(1) + ' m)');
      // Another hit of the same vehicle that RECORDED its turret 30° round: the record keeps the part's own
      // coordinates, so it lands on that turret's same spot although the new hit's pose is its own.
      v.loadedData = vehicle(Math.PI / 6); v.posedData = null; v.poseBuilt = null; v.turretAngle = 0; v.gunAngle = 0;
      v.clearHitMarks(); v.rebuild();
      v.addHitMark(shotT.rec);
      const nT = worldOf(v.markSlots[0][0]);
      ok('parts: laid on another hit whose record has the turret 30° round, the same record lands on the same spot of that turret',
         gap(nT, fT) < 1e-5 && v.markSets['2'].group.parent === v.scene, '(' + gap(nT, fT).toExponential(1) + ' m)');
      // A mark keeps to its own part: the turret face beside the mantlet set flush into it takes the mark,
      // the mantlet (the gun's plate, coplanar) does not - it would be left behind when the gun pitches.
      v.loadedData = vehicle(0); v.posedData = null; v.poseBuilt = null; v.clearHitMarks(); v.rebuild();
      const flush = shoot(new T3.Vector3(.43, 2, 20), new T3.Vector3(.43, 2, 0), {outcome: 'pen', u: .1});
      // (the record is in the turret's own coordinates; the cut is asked in the world, as addHitMark asks it)
      const pin = v.pinned, at = {point: pin.point, normal: pin.normal, from: pin.origin, dir: pin.direction, outcome: 'pen', caliber: 105, roll: .3};
      const own = v.hitMarkGeometry(Object.assign({part: 2}, at)), any = v.hitMarkGeometry(at);
      ok('parts: a mark is cut from its own part’s plates only - the same cut with no part also paints the gun’s mantlet flush beside it',
         flush.rec.marks[0].part === 2 && !!own && !!any && own.count < any.count,
         '(' + (own && own.count) + ' vertices on the turret alone, ' + (any && any.count) + ' across both parts)');
      // A part whose recorded matrix MIRRORS (no vehicle has one, but nothing may assume it): three draws an
      // object with a negative determinant with its front face turned (frontFaceCW), so the pieces of such a
      // part are kept wound the other way round - in the world they read clockwise from the shooter's side,
      // which is exactly what three then draws as their front.
      const mirrored = vehicle(0);
      mirrored.hit.target.parts[0].transform = new T3.Matrix4().makeScale(-1, 1, 1).toArray();
      v.loadedData = mirrored; v.posedData = null; v.poseBuilt = null; v.clearHitMarks(); v.rebuild();
      const mShot = shoot(new T3.Vector3(2.5, 1, 20), new T3.Vector3(2.5, 1, 0), {outcome: 'pen', u: .1});
      v.addHitMark(mShot.rec);
      const mc = v.markSlots[0][0], mw = worldOf(mc), toShooter = new T3.Vector3(0, 0, 1);
      let cw = 0;
      for (let t = 0; t + 2 < mw.length; t += 3)
        if (mw[t + 1].clone().sub(mw[t]).cross(mw[t + 2].clone().sub(mw[t])).dot(toShooter) < 0) cw++;
      ok('parts: a mirrored part keeps its pieces wound the other way round, so three’s turned front face still shows them to the shooter',
         mc.mesh.parent.matrix.determinant() < 0 && mw.length > 0 && cw === mw.length / 3
         && span(mw, 2).lo > 1.5 && span(mw, 2).hi < 1.51,
         '(' + cw + ' of ' + mw.length / 3 + ' triangles clockwise from the shooter)');
      v.clearHitMarks();
    }());
  });
}).then(function () {
  // ---- the snapshot format with references (22.09, record-format B) -----------------------------
  // web/local-data.js is the only place a reference is resolved, so app.js, shot-context.js and
  // viewer.js must see the very hits they saw before. Run in a context of its own, so the stubbed
  // ArmorInspectorData the rest of this harness uses is left alone.
  const vm = require('node:vm');
  const ctx = {Promise, Date, setTimeout, clearTimeout, console, Object, Array, JSON};
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path + 'local-data.js', 'utf8'), ctx);
  const expand = ctx.ArmorInspectorData.expandBattle;
  const CFG = 'EX8kATkB0AAZAf0ASQEA', H = function (c) { return CFG + ':' + c.repeat(32); };
  const ARMOR_REF = '1'.repeat(64), ARMOR = {hull: {armor: 120, useHitAngle: true}};
  const PITCH = {samples: [[0, -0.1, 0.2]], hullTurretPitch: 0.05, gunJointPitch: 0.01};
  const SHELLS_A = [{kind: 'ARMOR_PIERCING', alpha: 400}], SHELLS_C = [{kind: 'ARMOR_PIERCING'}];
  const REST = [[1, 0, 0, 1]], POSE1 = [[1, 0, 0, 9]], POSE2 = [[1, 0, 0, 7]];
  const PART = {id: 0, name: 'hull', resource: 'hull.model', armorRef: ARMOR_REF};
  function oldHit(id, pose) {
    return {schema: 1, type: 'hit', id: id, damage: 490, gameTime: 12.5, receivedAt: 13.5,
      points: [{position: [1, 2, 3]}], availableShells: SHELLS_A, shellCandidates: SHELLS_C,
      attacker: {name: 'A', compactDescriptor: CFG, partsFrom: 'rest pose', aim: {dispersion: 0.1},
        parts: [{id: 0, name: 'hull', resource: 'hull.model', armor: ARMOR, transform: REST[0]}]},
      target: {name: 'T', compactDescriptor: CFG, worldTransform: [1, 2], gunPitchLimits: PITCH,
        parts: [{id: 0, name: 'hull', resource: 'hull.model', armor: ARMOR, transform: pose[0]}]}};
  }
  function newBattle(extra) {
    const battle = {id: 'fmt', source: 'live', staticTableFormat: 1, pitchTableFormat: 1, armorTableFormat: 1,
      armorTables: {}, pitchTables: {}, staticTables: {},
      hits: [1, 2].map(function (n) {
        return {schema: 1, type: 'hit', id: String(n), damage: 490, gameTime: 12.5, receivedAt: 13.5,
          points: [{position: [1, 2, 3]}],
          availableShellsRef: H('d'), shellCandidatesRef: H('e'),
          attacker: {vehicleRef: H('a')},
          target: {worldTransform: [1, 2], vehicleRef: H('b'), partPoses: n === 1 ? POSE1 : POSE2}};
      })};
    battle.armorTables[ARMOR_REF] = ARMOR;
    battle.pitchTables[H('f')] = PITCH;
    battle.staticTables[H('a')] = {name: 'A', compactDescriptor: CFG, partsFrom: 'rest pose',
      aim: {dispersion: 0.1}, partsRef: H('c'), posesRef: H('0')};
    battle.staticTables[H('b')] = {name: 'T', compactDescriptor: CFG, gunPitchRef: H('f'), partsRef: H('c')};
    battle.staticTables[H('c')] = [PART];
    battle.staticTables[H('0')] = REST;
    battle.staticTables[H('d')] = SHELLS_A;
    battle.staticTables[H('e')] = SHELLS_C;
    if (extra) extra(battle);
    return JSON.parse(JSON.stringify(battle));
  }
  // Key ORDER is not part of the contract - a part gets its pose back after its static fields -
  // so the two sides are compared by sorted keys, field by field.
  const canon = function (v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.keys(v).sort().map(function (k) { return [k, canon(v[k])]; });
    return v;
  };
  const same = function (a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); };
  const full = expand(newBattle());
  const want = {id: 'fmt', source: 'live', hits: [oldHit('1', POSE1), oldHit('2', POSE2)]};
  ok('format B: a referenced battle expands to exactly the hits of the old shape',
     same(full, want), same(full, want) ? '' : JSON.stringify(full).slice(0, 400));
  ok('format B: the container keys are gone once the battle is expanded',
     ['staticTables', 'staticTableFormat', 'pitchTables', 'pitchTableFormat', 'armorTables', 'armorTableFormat']
       .every(function (k) { return !(k in full); }));
  ok('format B: one pitch table object is shared by every hit that names it',
     full.hits[0].target.gunPitchLimits === full.hits[1].target.gunPitchLimits);
  ok('format B: one armour table object is shared, and a part is a new object per hit',
     full.hits[0].target.parts[0].armor === full.hits[1].target.parts[0].armor
     && full.hits[0].target.parts[0] !== full.hits[1].target.parts[0]);
  ok('format B: the shooter keeps its rest pose and the target its own pose per hit',
     same(full.hits[0].attacker.parts[0].transform, REST[0])
     && same(full.hits[0].target.parts[0].transform, POSE1[0])
     && same(full.hits[1].target.parts[0].transform, POSE2[0]));
  ok('format B: the shell lists are handed out as copies, not as the shared definition',
     same(full.hits[0].availableShells, SHELLS_A) && full.hits[0].availableShells !== full.hits[1].availableShells);
  ok('format B: the header source field is carried through and nothing branches on it',
     expand(newBattle(function (b) { b.source = 'replay'; })).source === 'replay'
     && same(expand(newBattle(function (b) { b.source = 'replay'; })).hits, want.hits));
  // ---- a reference with no definition: a warning, and never an invented number -------------------
  const dangling = expand(newBattle(function (b) {
    delete b.staticTables[H('b')]; delete b.pitchTables[H('f')]; delete b.staticTables[H('d')];
    delete b.armorTables[ARMOR_REF];
  }));
  const t0 = dangling.hits[0].target, a0 = dangling.hits[0].attacker, w0 = dangling.hits[0].warnings || [];
  ok('format B: a missing vehicle definition leaves the live fields and warns',
     !('name' in t0) && !('gunPitchLimits' in t0) && !('parts' in t0) && same(t0.worldTransform, [1, 2])
     && w0.indexOf('Recorded vehicle data unavailable: target') !== -1,
     '(' + JSON.stringify(t0) + ')');
  ok('format B: a missing pitch table leaves the field unset - no made-up range',
     !('gunPitchRef' in t0) && t0.gunPitchLimits === undefined);
  ok('format B: a missing shell list leaves the field unset and warns',
     dangling.hits[0].availableShells === undefined && !('availableShellsRef' in dangling.hits[0])
     && w0.indexOf('Recorded shell list unavailable: availableShells') !== -1);
  ok('format B: a missing armour table still gives the empty table, the error and the warning',
     same(a0.parts[0].armor, {}) && a0.parts[0].armorError === 'Recorded armor table unavailable'
     && !('armorRef' in a0.parts[0]) && w0.some(function (t) { return t.indexOf('Recorded armor table unavailable') === 0; }));
  const lonely = expand(newBattle(function (b) {
    b.staticTables[H('b')] = {name: 'T', compactDescriptor: CFG, gunPitchRef: H('f'), partsRef: H('9')};
  }));
  ok('format B: a missing part list gives an empty list and a warning, never a guessed part',
     Array.isArray(lonely.hits[0].target.parts) && lonely.hits[0].target.parts.length === 0
     && (lonely.hits[0].warnings || []).indexOf('Recorded vehicle parts unavailable: target') !== -1);
  // ---- the old files must read exactly as before -------------------------------------------------
  const legacy = {id: 'old', hits: [{type: 'hit', id: '1', target: {parts: [{id: 0, armor: ARMOR, transform: [1, 2]}]}}]};
  ok('format B: a battle with no marker at all is returned untouched',
     same(expand(JSON.parse(JSON.stringify(legacy))), legacy));
  let threw = null;
  try { expand({id: 'x', staticTableFormat: 7, hits: []}); } catch (e) { threw = e; }
  ok('format B: a static-table format this build does not know is refused, not guessed', !!threw);

}).then(function () {
  // ---- gun-overheat (22.09 ~23:30): the heat of an Ares gun and the real-reload sub-switch of ✸ -----------
  // The record carries the gun's own numbers since the build after 0.7.26 (exporter.gun_heat; the Ares 90 C
  // block below is exactly what it writes, outputs/gun-overheat-2026-09-22.md). Under ✸ the page runs the
  // client's rule: every round +heatingPerShot, a rest of coolingDelay, then coolingPerSec a second; at 100 the
  // gun locks, cools at ×coolingPerSecFactor and fires again only at 0; the temperature band multiplies the
  // full-aim circle. Checked on the page's own code cut out of app.js (as the fun layer is), then through the
  // page with the stub viewer and the fake clock, on a battle with an Ares 90 C, a plain gun and a clip gun.
  if (RELOAD) return;
  const styleSrc = fs.readFileSync(path + 'style.css', 'utf8');
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };
  // ---- 0. the markup -------------------------------------------------------------------------------------
  const modelRow = pageSrc.slice(pageSrc.indexOf('<div class="model-row"'), pageSrc.indexOf('<div id="target-mods-slot"'));
  ok('heat: the real-reload sub-switch is a .swap-roles button right after ✸ in the model row - glyph only, lit by default, hidden until ✸ is on',
     /<button type="button" id="real-reload-toggle" class="swap-roles" aria-pressed="true" title="[^"]+" aria-label="Real reload" hidden>◔<\/button>/.test(modelRow)
     && modelRow.indexOf('id="fun-mode-toggle"') < modelRow.indexOf('id="real-reload-toggle"')
     && modelRow.indexOf('id="real-reload-toggle"') < modelRow.indexOf('id="target-hp"'));
  ok('heat: its English tooltip says what ON and OFF do, and that the heat builds up either way',
     /id="real-reload-toggle"[^>]*title="Real reload&#10;On: the gun reloads in real time[^"]*Off: every press fires\.&#10;[^"]*&#10;• Ares heat: builds up either way"/.test(modelRow));
  ok('heat: the ⌖ tooltip names the heat and the sub-switch',
     /id="fun-mode-toggle"[^>]*title="Shooting emulation&#10;[^"]*&#10;• Gun: reload, magazine and heat as in the game; ◔ real reload&#10;/.test(modelRow));
  ok('heat: the sub-switch state is ONE hidden control of the Settings menu, checked (ON) by default',
     /<input type="checkbox" id="real-reload" hidden aria-hidden="true" tabindex="-1" checked>/.test(pageSrc)
     && pageSrc.indexOf('class="settings-content"') < pageSrc.indexOf('id="real-reload"')
     && pageSrc.indexOf('id="real-reload"') < pageSrc.indexOf('id="reset-settings"'));
  // Strip (23.09): the load state left the gun panel for the strip beside ⌖ in the model row - the same nodes.
  const gunPanel = pageSrc.slice(pageSrc.indexOf('<div id="fun-strip"'), pageSrc.indexOf('<div id="target-mods-slot"'));
  ok('heat: the heat bar sits in the strip beside ⌖ after the reload figure - graphics only, hidden until needed',
     /<span id="aim-gun-heat" class="aim-gun-heat" role="img" aria-label="Gun heat" hidden><span id="aim-gun-heat-fill" class="aim-gun-heat-fill"><\/span><span id="aim-gun-heat-warn" class="aim-gun-heat-warn"><\/span><\/span>/.test(gunPanel)
     && gunPanel.indexOf('id="aim-gun-reload"') < gunPanel.indexOf('id="aim-gun-heat"'));
  ok('heat: the bar has its rules - hidden, a fill, the warning mark and a red frame while locked',
     /\.aim-gun-heat\[hidden\]\{display:none\}/.test(styleSrc) && /\.aim-gun-heat-fill\{/.test(styleSrc)
     && /\.aim-gun-heat-warn\{/.test(styleSrc) && /\.aim-gun-heat\[data-locked="1"\]\{border-color:var\(--red\)/.test(styleSrc));
  ok('heat: the sub-switch goes through its stored control and the settings machinery, exactly as ✸ does',
     /\$\('real-reload'\)\.onchange=realReloadSettings;/.test(appSrc)
     && /\$\('real-reload-toggle'\)\.onclick=function\(\)\{var box=\$\('real-reload'\);box\.checked=!box\.checked;realReloadSettings\(\);persistSettings\(\);\}/.test(appSrc));

  // ---- 1. the rule, cut out of app.js and run on a fake clock ---------------------------------------------
  const hStart = appSrc.indexOf('  // --- ✸: real reload and the heat');
  const hEnd = appSrc.indexOf('  // --- The fun layer', hStart);
  ok('heat: the heat and real-reload code is one block of app.js, outside the fun block', hStart > 0 && hEnd > hStart);
  const hSrc = appSrc.slice(hStart, hEnd);
  ok('heat: it casts no ray, touches no shell and no armour', !/engine\.ray|liveAimProbability|pinAtPoint|\.shell\b|penetration/.test(hSrc));
  const hx = {}, h$ = function (id) { return hx[id] || (hx[id] = new Element('div')); };
  const hwin = {timers: [], setTimeout: function (fn) { hwin.timers.push(fn); return hwin.timers.length; }, clearTimeout: function () {}};
  let hNow = 0, hFun = true, hBlock = null, hWakes = 0;
  const HT = new Function('$', 'window', 'env',
    'var aimReload=null,aimClipDry=false,aimClipSize=1,aimClip=1,aimLive=true,aimNow=null,aimLastState=null;' +
    'function funOn(){return env.fun();}function aimBlockData(){return env.block();}function aimSeconds(){return env.now();}' +
    'function aimReloadLeft(){return 0;}function aimClipRounds(){return 1;}function paintFun(){}function paintAim(){}function aimState(){return {};}' +
    'function startAimLoop(){env.wake();}function aimNum(v){return String(Math.round(Number(v)*10000)/10000);}' +
    // BACKLOG 37 (23.09): the tier-XI block stands outside this one; cut out alone, no vehicle has a mechanic.
    'function xiApply(m){return m;}function xiReset(){}function paintXi(){}function xiBurstOn(){return false;}function xiSwitching(){return false;}' +
    // Final review (23.09): the heat bar coming or going asks the strip's layout pass; cut out alone, a no-op.
    'function stripLayout(){}\n' + hSrc +
    '\nreturn {now:heatNow,shot:heatShot,heated:aimHeated,free:gunFree,reset:gunHeatReset,unlockIn:function(){return heatUnlockIn(heatNow());},tick:panelTick,band:heatBand};')(
    h$, hwin, {fun: function () { return hFun; }, block: function () { return hBlock; }, now: function () { return hNow; }, wake: function () { hWakes++; }});
  const MUL = function (v) { return [{op: 'mul', name: 'dynAttrs/multShotDispersionFactor', value: v}]; };
  const ARES = {
    temperatureGun: {heatingPerShot: 11, coolingDelay: 2, coolingPerSec: 10.9, maxTemperature: 100, thermalStateHysteresis: 1,
      thermalStates: [{maxTemperature: 50}, {maxTemperature: 88, modifiers: MUL(1.25)}, {maxTemperature: 100, modifiers: MUL(1.5)}]},
    overheatGun: {coolingPerSecFactor: 0.5, tempOverheatOnThreshold: 100, tempOverheatOffThreshold: 0, tempOverheatWarnThreshold: 89}};
  hBlock = ARES;
  let h = HT.now();
  ok('heat: a cold gun - 0, the first band, not locked, free to fire', h && h.t === 0 && h.band === 0 && !h.locked && HT.free());
  HT.shot(); h = HT.now();
  ok('heat: one round adds heatingPerShot (11)', near(h.t, 11));
  ok('heat: a warm gun keeps a 10 Hz timer of its own (the bar falls with the frame loop asleep)', hwin.timers.length === 1);
  hNow = 1.99; h = HT.now();
  ok('heat: for coolingDelay (2 s) after the round the temperature stands', near(h.t, 11));
  hNow = 2.5; h = HT.now();
  ok('heat: then it falls by coolingPerSec (10.9) a second', near(h.t, 11 - 10.9 * 0.5));
  hNow = 4; h = HT.now();
  ok('heat: and stops at 0', h.t === 0);
  // Ten rounds 0.3 s apart from cold: no cooling between them (the rest is longer than the gap).
  hNow = 10; const t0 = hNow; let lockedAt = -1;
  for (let i = 1; i <= 10; i++) {
    hNow = t0 + (i - 1) * 0.3;
    if (!HT.free()) break;
    HT.shot(); h = HT.now();
    if (i === 5) ok('heat: 5 rounds - 55, the second band: the circle ×1.25', near(h.t, 55) && h.band === 1 && near(HT.heated({mult: 2}).mult, 2.5));
    if (i === 9) ok('heat: 9 rounds - 99, not locked yet, the top band: ×1.5', near(h.t, 99) && !h.locked && h.band === 2 && near(HT.heated({mult: 1}).mult, 1.5));
    if (h.locked && lockedAt < 0) lockedAt = i;
  }
  ok('heat: the 10th round takes it to 100 (no further) and LOCKS the gun - the gun says so and refuses',
     lockedAt === 10 && h.t === 100 && h.locked && !HT.free());
  const lockT = hNow, unlock = HT.unlockIn();
  ok('heat: the lock lasts the rest of the delay plus 100 / (10.9 × 0.5) - 20.35 s', near(unlock, 2 + 100 / 5.45, 1e-9), '(' + unlock.toFixed(3) + ' s)');
  hNow = lockT + 2 + 5; h = HT.now();
  ok('heat: locked, it cools at HALF speed (5.45 a second): 72.75 after 5 s of it, and the band steps down to ×1.25',
     near(h.t, 100 - 5.45 * 5) && h.locked && h.band === 1);
  hNow = lockT + 20.3; h = HT.now();
  ok('heat: still locked a moment before the gun is down to 0', h.locked && !HT.free() && h.t > 0);
  hNow = lockT + 20.36; h = HT.now();
  ok('heat: at 0 it unlocks and may fire again - the unlock mark is 0, not the warning', !h.locked && h.t === 0 && HT.free() && h.band === 0);
  // The hysteresis on the way down: 88 is the top of the second band, so the top band is left only below 87.
  hNow = 100; HT.reset();
  for (let i = 0; i < 9; i++) { HT.shot(); hNow += 0.3; }
  hNow -= 0.3;
  const top = hNow; h = HT.now();
  ok('heat: (9 rounds: 99, the top band)', near(h.t, 99) && h.band === 2);
  hNow = top + 2 + (99 - 87.5) / 10.9; h = HT.now();
  ok('heat: at 87.5 - under the band edge, within the hysteresis - the circle stays ×1.5', near(h.t, 87.5) && h.band === 2);
  hNow = top + 2 + (99 - 86.5) / 10.9; h = HT.now();
  ok('heat: at 86.5 it steps down to ×1.25', near(h.t, 86.5) && h.band === 1);
  // The timer: painting only, and a wake of the loop only when the band - and with it the circle - changed.
  const wakes = hWakes; hwin.timers.length = 0; HT.tick();
  ok('heat: a tick in the same band paints and re-arms, without waking the frame loop', hWakes === wakes && hwin.timers.length === 1);
  hNow = top + 2 + (99 - 40) / 10.9; hwin.timers.length = 0; HT.tick();
  ok('heat: a tick that finds a new band wakes the loop once', hWakes === wakes + 1);
  hNow = top + 100; hwin.timers.length = 0; HT.tick();
  ok('heat: a cold gun stops the timer', hwin.timers.length === 0);
  // The bar: graphics, the numbers in the tooltip.
  hNow = 300; HT.reset(); HT.shot(); HT.now(); HT.tick();
  const hbox = hx['aim-gun-heat'], hfill = hx['aim-gun-heat-fill'];
  ok('heat: the bar shows the temperature as its fill and puts the warning mark at 89 %',
     hbox.hidden === false && hfill.style.width === '11.0%' && hx['aim-gun-heat-warn'].style.left === '89.0%' && hbox.getAttribute('data-locked') === '0');
  ok('heat: its tooltip carries the numbers - temperature, per round, delay, cooling, lock, unlock, warning, the circle',
     /^Gun heat 11 \/ 100\n• Per round: \+11\n• Cooling: 10\.9 a second after 2 s without firing\n• Overheat: at 100 the gun locks, cools at ×0\.5 \(5\.45 a second\) and fires again only at 0; a press meanwhile blinks this bar\n• Mark: the warning at 89\n• Aiming circle: ×1\.25 above 50, ×1\.5 above 88 — now ×1\n/.test(hbox.title), '(' + hbox.title.slice(0, 80) + ')');
  for (let i = 0; i < 9; i++) HT.shot();
  HT.tick();
  ok('heat: locked, the bar goes red with a red frame and the tooltip counts down to the unlock',
     hbox.getAttribute('data-locked') === '1' && hfill.style.backgroundColor === 'rgb(251,133,128)' && hfill.style.width === '100.0%'
     && /\n• Overheated: fires again in 21 s\n/.test(hbox.title));
  // Off the layer, and on a gun that only heats: nothing at all.
  hFun = false;
  const same = {mult: 3};
  ok('heat: with ✸ off there is no heat, the gun is free and the circle untouched (the very object comes back)',
     HT.now() === null && HT.free() && HT.heated(same) === same && same.mult === 3);
  // B4 (23.09): a gun that heats but never locks (the STK-2) runs the same rule without the lock - its own bands,
  // ×1.227 already on the cold gun (docs/KNOWLEDGE.md section 4). Until 23.09 it was left alone.
  hFun = true; hNow = 1000; HT.reset();
  hBlock = {temperatureGun: {heatingPerShot: 50, coolingDelay: 1, coolingPerSec: 2.8, maxTemperature: 100, thermalStateHysteresis: 1,
    thermalStates: [{maxTemperature: 20, modifiers: MUL(1.227)}, {maxTemperature: 40, modifiers: MUL(1.455)}, {maxTemperature: 60, modifiers: MUL(1.682)},
      {maxTemperature: 80, modifiers: MUL(1.909)}, {maxTemperature: 100, modifiers: MUL(2.136)}]}, heatingZonesGun: {zones: [0, 20, 80, 100]}};
  h = HT.now();
  ok('heat: the STK-2 (heats, never locks) - cold, the first band already widens the circle ×1.227', h && h.t === 0 && h.band === 0 && near(HT.heated({mult: 1}).mult, 1.227));
  HT.shot(); h = HT.now();
  ok('heat: the STK-2 - one round is +50, the band ×1.682', near(h.t, 50) && h.band === 2 && near(HT.heated({mult: 1}).mult, 1.682));
  hNow += 9.7; h = HT.now();
  ok('heat: the STK-2 - 9.7 s later (its reload) 50 − 2.8 × 8.7 = 25.64, ×1.455', near(h.t, 25.64, 1e-9) && h.band === 1);
  for (let i = 0; i < 3; i++) { HT.shot(); hNow += 9.7; }
  h = HT.now();
  ok('heat: the STK-2 - before its 4th round and every one after it stands at 75.64, ×1.909', near(h.t, 75.64, 1e-9) && h.band === 3 && near(HT.heated({mult: 1}).mult, 1.909));
  for (let i = 0; i < 6; i++) HT.shot();
  h = HT.now();
  ok('heat: the STK-2 - six rounds at once: 100 and the top band ×2.136, and never locked', h.t === 100 && !h.locked && HT.free() && near(HT.heated({mult: 1}).mult, 2.136));
  // 23.09: every record since 0.7.27 spells the modifier 'dynAttrs//multShotDispersionFactor' (the client keeps its kind
  // with the slash, the mod joined one more on) - read as the XML spells it, so the bands of real records apply at last.
  HT.reset(); hNow += 100;
  const MUL2 = function (v) { return [{op: 'mul', name: 'dynAttrs//multShotDispersionFactor', value: v}]; };
  hBlock = {temperatureGun: {heatingPerShot: 50, coolingDelay: 1, coolingPerSec: 2.8, maxTemperature: 100, thermalStateHysteresis: 1,
    thermalStates: [{maxTemperature: 20, modifiers: MUL2(1.227)}, {maxTemperature: 40, modifiers: MUL2(1.455)}, {maxTemperature: 60, modifiers: MUL2(1.682)},
      {maxTemperature: 80, modifiers: MUL2(1.909)}, {maxTemperature: 100, modifiers: MUL2(2.136)}]}};
  h = HT.now();
  ok('heat: the recorded double slash (dynAttrs//multShotDispersionFactor) is read - the cold STK-2 ×1.227, one round ×1.682',
     near(HT.heated({mult: 1}).mult, 1.227) && (HT.shot(), near(HT.heated({mult: 1}).mult, 1.682)));
  HT.reset();
  hBlock = {dispersion: 1};
  ok('heat: and so is every gun without the numbers (an old record)', HT.now() === null && HT.free());
  HT.tick();
  ok('heat: the bar is hidden for them', hbox.hidden === true);

  // ---- 2. through the page: an Ares 90 C, a plain gun and a clip gun under ✸ ------------------------------
  const GPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const ARES_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 7, clip: [250, 0.3]}, ARES);
  const PLAIN_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0});
  const CLIP_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, clip: [3, 2]});
  const GHIT = function (id, attackerId, type, aim) {
    return {id: id, attackerId: attackerId, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: type, type: type, parts: GPARTS(), gunDispersion: 0.00383, aim: aim},
            target: {name: 'Alpha', type: 'germany:Alpha', parts: GPARTS()}, warnings: []};
  };
  const GBATTLE = {id: 'g1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 1850, defaultMaxHealth: 1800},
             {id: 21, name: 'Ares', type: 'usa:A191_Ares_90_C', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 23, name: 'Plain', type: 'germany:Plain', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 25, name: 'Clip', type: 'germany:Clip', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000}],
    hits: [GHIT('g-ares', 21, 'usa:A191_Ares_90_C', ARES_AIM), GHIT('g-plain', 23, 'germany:Plain', PLAIN_AIM),
           GHIT('g-clip', 25, 'germany:Clip', CLIP_AIM)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'g1' ? Promise.resolve(GBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []});
  };
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const funBox = document.getElementById('fun-mode'), realBox = document.getElementById('real-reload');
  if (funBox.checked) click(document.getElementById('fun-mode-toggle'));
  realBox.checked = true;   // the markup's default; this stub never parsed it
  const gb = document.getElementById('battles');
  gb.value = 'g1'; gb.onchange.call(gb);
  const heatBox = document.getElementById('aim-gun-heat'), sub = document.getElementById('real-reload-toggle');
  const prepare = function (view) {
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
  };
  const tap = function () { press(); release(); };
  // clip-indicator: the heat's 10 Hz timer is the gun panel's, shared with an autoloader's loading round.
  const heatTimers = function () { return timerQueue.filter(function (t) { return /function panelTick/.test(String(t.fn)); }).length; };
  return settle(20).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    ok('heat: (the Ares battle is on screen with the emulation live, ✸ off)', view.liveRadius100 > 0 && funBox.checked === false);
    const r0 = view.liveRadius100, p0 = view.pinnedPoints;
    for (let i = 0; i < 12; i++) tap();
    run(0.05);
    ok('heat: ✸ OFF - twelve taps at one instant all fire, as before: no heat, no lock, no bar, no sub-switch, no timer, the circle as it was',
       view.pinnedPoints === p0 + 12 && heatBox.hidden === true && sub.hidden === true && heatTimers() === 0 && near(view.liveRadius100, r0, 1e-9),
       '(' + (view.pinnedPoints - p0) + ' pins, bar hidden=' + heatBox.hidden + ')');
    ok('heat: ✸ OFF - the stored real reload (ON) changed nothing: every tap fired', realBox.checked === true);
    click(document.getElementById('fun-mode-toggle'));
    run(0.05);
    ok('heat: ✸ ON - the sub-switch stands beside it, lit as its control says, and the bar is up for this gun',
       sub.hidden === false && sub.getAttribute('aria-pressed') === 'true' && heatBox.hidden === false);
    // The simplified reload first, as the user may pick it: the release resets the cooldown.
    click(sub);
    ok('heat: the sub-switch flips its control and goes dark', realBox.checked === false && sub.getAttribute('aria-pressed') === 'false');
    const p1 = view.pinnedPoints;
    tap();
    ok('heat: one round - 11 on the bar', view.pinnedPoints === p1 + 1 && /^Gun heat 11 \/ 100/.test(heatBox.title), '(' + heatBox.title.slice(0, 20) + ')');
    for (let i = 0; i < 4; i++) tap();
    run(0.05);
    ok('heat: five rounds (55) - the live circle is ×1.25', near(view.liveRadius100 / r0, 1.25, 1e-6), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    for (let i = 0; i < 4; i++) tap();
    run(0.05);
    ok('heat: nine rounds (99) - ×1.5, still firing', near(view.liveRadius100 / r0, 1.5, 1e-6) && view.pinnedPoints === p1 + 9);
    tap();
    const p2 = view.pinnedPoints, f2 = view.flashes;
    ok('strip: nothing pulses while every tap fires', balked() === '' && f2 === 0, '(' + balked() + ' / ' + f2 + ')');
    tap();
    const b2 = balked(), v2 = heatBox.getAttribute('data-balk');
    tap();
    ok('heat: the tenth round locks the gun: further taps do not fire, the bar is red-framed and says so',
       p2 === p1 + 10 && view.pinnedPoints === p2 && heatBox.getAttribute('data-locked') === '1' && /\n• Overheated: fires again in 21 s\n/.test(heatBox.title),
       '(' + (view.pinnedPoints - p1) + ' rounds, ' + heatBox.title.slice(0, 50) + ')');
    ok('strip: a tap refused by the heat pulses the heat bar alone, and the live ring with it - once per refused tap',
       b2 === 'aim-gun-heat' && balked() === 'aim-gun-heat' && view.flashes === f2 + 2, '(' + b2 + ' / ' + (view.flashes - f2) + ')');
    ok('strip: a second refusal during the pulse starts it again (the other of the two animation names)',
       (v2 === '1' || v2 === '2') && heatBox.getAttribute('data-balk') !== v2, '(' + v2 + ' then ' + heatBox.getAttribute('data-balk') + ')');
    run(11);
    ok('strip: the pulse leaves no mark behind - the attribute is gone after it', balked() === '' && heatBox.getAttribute('data-balk') === null);
    ok('heat: while it cools (locked, at half speed) the circle comes back down a band with the loop asleep - ×1.25 and settling',
       view.liveRadius100 / r0 > 1.24 && view.liveRadius100 / r0 < 1.3, '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(9.2);
    tap();
    ok('heat: 20.2 s after the lock it is still locked', view.pinnedPoints === p2);
    run(0.25);
    tap();
    ok('heat: past 20.35 s it is cold, unlocked and fires again; the circle is back to where it was',
       view.pinnedPoints === p2 + 1 && /^Gun heat 11 \/ 100/.test(heatBox.title) && heatBox.getAttribute('data-locked') === '0'
       && near(view.liveRadius100 / r0, 1, 0.01), '(' + (view.liveRadius100 / r0).toFixed(4) + ', ' + heatBox.title.slice(0, 20) + ')');
    run(1.9);
    ok('heat: it stands at 11 for the rest of the delay', /^Gun heat 11 \/ 100/.test(heatBox.title));
    run(0.6);
    ok('heat: then cools 10.9 a second (6 after half a second of it)', /^Gun heat 6 \/ 100/.test(heatBox.title), '(' + heatBox.title.slice(0, 20) + ')');
    run(1);
    ok('heat: down to 0, the timer stops', /^Gun heat 0 \/ 100/.test(heatBox.title) && heatTimers() === 0);
    // Real reload ON: the gap of 0.3 s between rounds holds across presses, and the heat builds up as before.
    click(sub);
    ok('heat: (real reload back on)', realBox.checked === true && sub.getAttribute('aria-pressed') === 'true');
    const p3 = view.pinnedPoints;
    tap(); tap();
    ok('heat: real reload ON - a tap before the 0.3 s gap is over does not fire; the ring fill stays after the release',
       view.pinnedPoints === p3 + 1 && view.reloadPart !== null);
    ok('strip: a tap inside the gap between rounds pulses the reload figure alone (the magazine still has rounds)', balked() === 'aim-gun-load', '(' + balked() + ')');
    run(0.32); tap();
    ok('heat: after the gap it fires, and the heat has built up by two rounds', view.pinnedPoints === p3 + 2 && /^Gun heat 22 \/ 100/.test(heatBox.title),
       '(' + heatBox.title.slice(0, 20) + ')');
    run(5);   // cold again
    const p4 = view.pinnedPoints;
    press(); run(4); release();
    ok('heat: a held burst fires every 0.3 s until the tenth round locks the gun, and then holds fire',
       view.pinnedPoints === p4 + 10 && heatBox.getAttribute('data-locked') === '1', '(' + (view.pinnedPoints - p4) + ' rounds)');
    run(25);
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    ok('heat: a plain gun: no bar under ✸, and no heat timer', heatBox.hidden === true && heatTimers() === 0 && funBox.checked === true);
    const reload = parseFloat(document.getElementById('aim-gun-reload').textContent);
    ok('heat: (its reload, off the panel)', reload > 1, '(' + reload + ' s)');
    const p5 = view.pinnedPoints;
    tap(); tap();
    ok('heat: real reload ON - a second tap during the reload does not fire', view.pinnedPoints === p5 + 1);
    ok('strip: ... and it pulses the reload figure - not the one slot of a single-shot gun', balked() === 'aim-gun-load', '(' + balked() + ')');
    run(0.5);
    const probesAtRest = view.probes;
    run(reload / 2 - 0.5);
    ok('heat: the release did not reset the reload: half of it is on the ring', view.reloadPart !== null && near(view.reloadPart, 0.5, 0.03),
       '(' + view.reloadPart + ')');
    ok('heat: while it runs with the shooter at rest only the ring fill and the panel are redrawn - no figure is integrated again',
       view.probes === probesAtRest, '(' + (view.probes - probesAtRest) + ' integrals over ' + (reload / 2 - 0.5).toFixed(1) + ' s)');
    tap();
    ok('heat: and a tap in the middle of it still does not fire', view.pinnedPoints === p5 + 1);
    run(reload / 2 + 0.05); tap();
    ok('heat: once it is over the gun fires', view.pinnedPoints === p5 + 2);
    click(sub);
    const p6 = view.pinnedPoints;
    tap(); tap(); tap();
    ok('heat: real reload OFF - the simplified emulation: each release resets the cooldown and every tap fires', view.pinnedPoints === p6 + 3);
    click(sub);
    document.getElementById('hits').children[2].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    const reload = parseFloat(document.getElementById('aim-gun-reload').textContent);
    ok('heat: (a clip gun of three, 2 s apart)', reload > 2.1 && magStates() === 'on,on,next', '(' + reload + ' s, clip ' + magStates() + ')');
    const p7 = view.pinnedPoints;
    tap(); run(2.05); tap(); run(2.05); tap();
    ok('heat: real reload ON - three taps 2 s apart empty the clip', view.pinnedPoints === p7 + 3);
    run(2.05); tap();
    ok('heat: the fourth tap does not fire: the whole clip is reloading, and every slot of the magazine shows it', view.pinnedPoints === p7 + 3 && magStates() === 'fill,fill,fill',
       '(' + magStates() + ')');
    ok('strip: a tap refused by the clip reload pulses the reload figure and the empty magazine', balked() === 'aim-gun-load,aim-gun-mag', '(' + balked() + ')');
    run(reload - 2.05 + 0.05); tap();
    ok('heat: after the full reload the clip is full again and fires - 2 of 3 left', view.pinnedPoints === p7 + 4 && magStates() === 'on,wait,off' && /^Magazine 2 \/ 3\n/.test(gunMag.title),
       '(' + magStates() + ')');
    click(sub);
    const p8 = view.pinnedPoints;
    tap(); tap(); tap(); tap(); tap();
    ok('heat: real reload OFF - every press starts from a full clip, as before', view.pinnedPoints === p8 + 5);
    click(sub);
    click(document.getElementById('fun-mode-toggle'));
    run(0.05);
    const p9 = view.pinnedPoints;
    tap(); tap(); tap(); tap(); tap();
    ok('heat: ✸ OFF again - the clip gun fires on every tap, the sub-switch is gone, and its control keeps its ON for next time',
       view.pinnedPoints === p9 + 5 && sub.hidden === true && realBox.checked === true);
    delete window.BullbaHitsRng;
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- clip-indicator (22.09 ~24:15): the magazine in the gun panel -------------------------------------------
  // The clip's text "2/3" beside the reload figure became a row of slots, one per round, graphics only: loaded
  // (on), the next to fire (next, or wait while the gap between rounds runs), spent (off) and loading (fill, its
  // share the transform of the inner mark). A single-shot gun is one slot filling with its reload; more than
  // twelve rounds is one bar. Under ✸ with real reload ◔ an AUTOLOADER loads its spent rounds back one at a time,
  // each on its own timer: the client keeps aim.autoreload.reloadTime last-round-first (getFirstReloadTime takes
  // the LAST entry for the first round into an empty magazine; the garage shows the tuple reversed), so with k
  // rounds in the next one takes reloadTime[N-1-k]. Checked on a battle with an autoloader of four
  // (10, 12, 14, 16 s), a clip of three, a single-shot gun and a magazine of thirty.
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };
  const styleSrc = fs.readFileSync(path + 'style.css', 'utf8');
  const gunPanel = pageSrc.slice(pageSrc.indexOf('<div id="fun-strip"'), pageSrc.indexOf('<div id="target-mods-slot"'));   // strip, 23.09
  ok('mag: the magazine sits in the strip beside ⌖ between the reload figure and the heat bar - graphics only, hidden until painted',
     /<span id="aim-gun-mag" class="aim-gun-mag" role="img" aria-label="Magazine" hidden><\/span>/.test(gunPanel)
     && gunPanel.indexOf('id="aim-gun-reload"') < gunPanel.indexOf('id="aim-gun-mag"')
     && gunPanel.indexOf('id="aim-gun-mag"') < gunPanel.indexOf('id="aim-gun-heat"'));
  ok('mag: the clip text is gone from the page, its code and its styles',
     pageSrc.indexOf('aim-gun-clip') < 0 && appSrc.indexOf('aim-gun-clip') < 0 && styleSrc.indexOf('aim-gun-clip') < 0);
  ok('mag: the slots have their looks - hidden, loaded, next, waiting, and a fill that grows from the bottom by transform',
     /\.aim-gun-mag\[hidden\]\{display:none\}/.test(styleSrc) && /\.aim-mag-slot\[data-s=on\]\{/.test(styleSrc)
     && /\.aim-mag-slot\[data-s=next\]\{background:var\(--gold\)/.test(styleSrc) && /\.aim-mag-slot\[data-s=wait\]\{/.test(styleSrc)
     && /\.aim-mag-fill\{[^}]*transform:scaleY\(0\);transform-origin:50% 100%\}/.test(styleSrc));
  ok('mag: the big-magazine bar is the heat bar’s own frame (one widget, one look), its fill moving by transform',
     /\.aim-gun-heat,\.aim-mag-bar\{position:relative;/.test(styleSrc) && /\.aim-mag-bar-fill\{[^}]*transform-origin:0 50%\}/.test(styleSrc)
     && !/\.aim-mag-bar-fill\{[^}]*width:\d+%[^}]*;width/.test(styleSrc));
  // The rule of the order, from the page's own code: with k rounds in, the next takes reloadTime[N-1-k].
  const rStart = appSrc.indexOf('  // AN AUTOLOADER under real reload');
  const rEnd = appSrc.indexOf('  // THE HEAT of the five Ares guns', rStart);
  ok('mag: the autoloader rule is part of the ✸ real-reload block', rStart > 0 && rEnd > rStart);
  const R = new Function('env', 'var aimClip=0,aimClipSize=4;function realReload(){return env.real;}function panelWake(){env.wakes++;}\n' +
    appSrc.slice(rStart, rEnd) + '\nreturn {times:autoreloadTimes,next:refillSeconds,settle:refillSettle,shot:refillShot,' +
    'state:function(){return {clip:aimClip,refill:aimRefill};},set:function(c){aimClip=c;aimRefill=null;}};')({real: true, wakes: 0});
  const AR = {reloadTime: 15.4, autoreload: {reloadTime: [10, 12, 14, 16]}};
  const T = R.times(AR, {reload: 15.4 * 0.9});
  ok('mag: the per-round times are the tuple scaled by the reload’s own factors (here ×0.9)', T && near(T[0], 9) && near(T[3], 14.4), '(' + T + ')');
  ok('mag: with k rounds in the next takes reloadTime[N-1-k]: an empty magazine 16, then 14, 12, and the last round 10',
     R.next([10, 12, 14, 16], 0) === 16 && R.next([10, 12, 14, 16], 1) === 14 && R.next([10, 12, 14, 16], 2) === 12 && R.next([10, 12, 14, 16], 3) === 10);
  R.set(0); R.shot([10, 12, 14, 16], 100);
  R.settle(100 + 16 + 14 - 1e-9);
  ok('mag: from empty the rounds come in at 16 s and 16 + 14 s, one at a time', R.state().clip === 1 && near(R.state().refill.until, 130), '(' + R.state().clip + ')');
  R.settle(100 + 16 + 14 + 12 + 10);
  ok('mag: and the magazine is full at 16 + 14 + 12 + 10 s, nothing loading any more', R.state().clip === 4 && R.state().refill === null);
  ok('mag: not an autoloader, or not under real reload - no per-round times',
     R.times({reloadTime: 10}, {reload: 10}) === null && R.times({reloadTime: 10, autoreload: {reloadTime: []}}, {reload: 10}) === null);

  // ---- through the page ---------------------------------------------------------------------------------------
  const MPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const AUTO_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 15.4, clip: [4, 2.5], gunTags: ['autoreload', 'clip'],
    autoreload: {boostFraction: 1.0, boostStartTime: 0.0, reloadTime: [10.0, 12.0, 14.0, 16.0], boostResidueTime: 0.0}});
  const CLIP3_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 9, clip: [3, 2]});
  const SINGLE_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 8, clip: [1, 0]});
  const BIG_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 6, clip: [30, 0.2]});
  const MHIT = function (id, attackerId, type, aim) {
    return {id: id, attackerId: attackerId, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: type, type: type, parts: MPARTS(), gunDispersion: 0.00383, aim: aim},
            target: {name: 'Alpha', type: 'germany:Alpha', parts: MPARTS()}, warnings: []};
  };
  const MBATTLE = {id: 'm1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 1850, defaultMaxHealth: 1800},
             {id: 31, name: 'Auto', type: 'italy:Auto', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 33, name: 'Clip3', type: 'germany:Clip3', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 35, name: 'Single', type: 'germany:Single', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000},
             {id: 37, name: 'Big', type: 'germany:Big', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000}],
    hits: [MHIT('m-auto', 31, 'italy:Auto', AUTO_AIM), MHIT('m-clip3', 33, 'germany:Clip3', CLIP3_AIM),
           MHIT('m-single', 35, 'germany:Single', SINGLE_AIM), MHIT('m-big', 37, 'germany:Big', BIG_AIM)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'm1' ? Promise.resolve(MBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []});
  };
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const funBox = document.getElementById('fun-mode'), realBox = document.getElementById('real-reload');
  // Strip (23.09): the magazine and the reload figure live in the strip beside ⌖ now, in its part that needs a live
  // emulation (#fun-gun) - that part is what the checks below call the gun panel.
  const sub = document.getElementById('real-reload-toggle'), gunPanelEl = document.getElementById('fun-gun');
  const mb = document.getElementById('battles');
  mb.value = 'm1'; mb.onchange.call(mb);
  const prepare = function (view) {
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
  };
  const tap = function () { press(); release(); };
  const panelTimers = function () { return timerQueue.filter(function (t) { return /function panelTick/.test(String(t.fn)); }).length; };
  const loadedCount = function () { return magStates().split(',').filter(function (x) { return x === 'on' || x === 'next' || x === 'wait'; }).length; };
  const figure = function () { return parseFloat(gunReload.textContent); };
  // Steps of 1/20 s until the count of loaded rounds changes; the time it took, or -1.
  const untilChange = function (most) {
    const from = loadedCount(), t0 = clock;
    for (let i = 0; i < most * 20; i++) { tick(0.05); if (loadedCount() !== from) return clock - t0; }
    return -1;
  };
  return settle(20).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    if (!funBox.checked) click(document.getElementById('fun-mode-toggle'));
    if (!realBox.checked) click(sub);
    run(0.1);
    ok('mag: (the autoloader of four is on screen, ⌖ and real reload ◔ on, the strip up)', view.liveRadius100 > 0 && funBox.checked && realBox.checked && gunPanelEl.hidden === false
       && document.getElementById('fun-strip').hidden === false);
    // At rest: four rounds, the last lit; the figure is the client's stand-in for an autoloader's reload - the
    // LAST entry of the tuple, the first round into an empty magazine - scaled like any reload.
    const k = figure() / 16;
    ok('mag: autoloader at rest - four slots loaded, the next to fire lit; the reload figure is the empty-magazine round (16 s × the reload’s factors)',
       magStates() === 'on,on,on,next' && gunReload.getAttribute('data-running') === '0' && k > 0.5 && k < 1.5,
       '(' + magStates() + ' / ' + gunReload.textContent + ')');
    const tm = /^Magazine 4 \/ 4\n• Rounds: 2\.5 s apart\n• Load back: one round at a time, each on its own timer — from empty ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+) s$/.exec(gunMag.title);
    ok('mag: its tooltip carries the numbers - the count, the gap and the per-round times in loading order, 16 14 12 10 × k',
       tm && near(+tm[1], 16 * k, 0.06) && near(+tm[2], 14 * k, 0.06) && near(+tm[3], 12 * k, 0.06) && near(+tm[4], 10 * k, 0.06), '(' + gunMag.title + ')');
    const p0 = view.pinnedPoints;
    tap();
    ok('mag: a shot - three rounds in, the next waiting out the gap, the spent slot loading back, and the panel timer running',
       view.pinnedPoints === p0 + 1 && magStates() === 'on,on,wait,fill' && panelTimers() === 1, '(' + magStates() + ')');
    run(2.6);
    ok('mag: past the gap the next round is lit and fires on a tap', magStates() === 'on,on,next,fill', '(' + magStates() + ')');
    const shareBefore = magFills()[3];
    ok('mag: the loading slot has filled by its share of the last round’s time (10 s × k)', near(shareBefore, 2.6 / (10 * k), 0.035),
       '(' + shareBefore + ' vs ' + (2.6 / (10 * k)).toFixed(3) + ')');
    tap();
    const fills = magFills();
    ok('mag: a second shot - two in; still ONE slot loading, and it keeps the share it had done',
       view.pinnedPoints === p0 + 2 && magStates() === 'on,wait,fill,off' && near(fills[2], shareBefore, 0.035), '(' + magStates() + ' / ' + fills + ')');
    ok('mag: the reload figure counts that round down while the gun may fire', gunReload.getAttribute('data-running') === '1', '(' + gunReload.textContent + ')');
    run(2.6); tap(); run(2.6); tap();
    ok('mag: two more shots empty the magazine - one slot loading, three spent', view.pinnedPoints === p0 + 4 && magStates() === 'fill,off,off,off', '(' + magStates() + ')');
    const partNow = view.reloadPart;
    tap();
    ok('mag: an empty magazine does not fire, and the ring shows the load of the round coming in',
       view.pinnedPoints === p0 + 4 && partNow !== null && near(partNow, magFills()[0], 0.03), '(' + partNow + ' / ' + magFills()[0] + ')');
    const first = untilChange(20);
    ok('mag: the round comes in - lit as the next to fire, the next one loading', first > 0 && magStates() === 'next,fill,off,off', '(' + first.toFixed(2) + ' s, ' + magStates() + ')');
    tap();
    ok('mag: and it fires at once', view.pinnedPoints === p0 + 5 && magStates() === 'fill,off,off,off', '(' + magStates() + ')');
    // From empty with nothing fired any more: 16 s for the loading round (its share kept), then 14, 12 and 10.
    const t1 = untilChange(30), t2 = untilChange(30), t3 = untilChange(30), t4 = untilChange(30);
    ok('mag: left alone the rounds come back one at a time: the second after 14 s × k, the third 12 s × k, the fourth 10 s × k',
       t1 > 0 && near(t2, 14 * k, 0.16) && near(t3, 12 * k, 0.16) && near(t4, 10 * k, 0.16),
       '(' + [t1, t2, t3, t4].map(function (v) { return v.toFixed(2); }).join(', ') + ' s)');
    run(0.3);
    ok('mag: full again - four loaded, the panel timer stopped, the figure back at rest',
       magStates() === 'on,on,on,next' && panelTimers() === 0 && gunReload.getAttribute('data-running') === '0' && near(figure(), 16 * k, 0.051),
       '(' + magStates() + ' / ' + panelTimers() + ' / ' + gunReload.textContent + ')');
    // Real reload OFF: the simplified rule - nothing loads back, and the release leaves the gun full.
    click(sub);
    tap();
    ok('mag: real reload OFF - a tap leaves the magazine full (the next press starts full), nothing loading, no timer',
       magStates() === 'on,on,on,next' && panelTimers() === 0 && /Simplified \(⌖ or ◔ off\)/.test(gunMag.title), '(' + magStates() + ')');
    press(); run(0.3);
    ok('mag: real reload OFF - a hold empties it round by round', magStates() === 'on,on,wait,off', '(' + magStates() + ')');
    run(8);
    ok('mag: to the last, and nothing loads back while it lasts', magStates() === 'off,off,off,off' && magStates().indexOf('fill') < 0, '(' + magStates() + ')');
    release();
    ok('mag: the release: full again', magStates() === 'on,on,on,next');
    click(sub);
    // The emulation off: nothing of the magazine moves and no timer runs, a loading round or not.
    tap();
    ok('mag: (a round loading again under real reload)', magStates() === 'on,on,wait,fill' && panelTimers() === 1);
    onBox.checked = false; onBox.onchange.call(onBox);
    const snap = JSON.stringify([gunMag.hidden, magStates(), magFills(), gunMag.title, gunReload.textContent]);
    run(1); run(20);
    ok('mag: the emulation OFF - the gun panel and the strip’s load part are put away, the panel timer stops and the magazine is left exactly as it was',
       gunPanelEl.hidden === true && document.getElementById('aim-gun').hidden === true && panelTimers() === 0 && JSON.stringify([gunMag.hidden, magStates(), magFills(), gunMag.title, gunReload.textContent]) === snap,
       '(' + panelTimers() + ')');
    onBox.checked = true; onBox.onchange.call(onBox);
    run(0.2);
    ok('mag: back on, the load is taken up from the time that passed - that round came in long ago', magStates() === 'on,on,on,next', '(' + magStates() + ')');
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    const reload = figure(), p0 = view.pinnedPoints;
    ok('mag: a clip of three at rest - three loaded, the last lit', magStates() === 'on,on,next' && reload > 5, '(' + magStates() + ', ' + reload + ' s)');
    tap(); run(2.05); tap();
    ok('mag: the slots empty one per shot', view.pinnedPoints === p0 + 2 && magStates() === 'wait,off,off', '(' + magStates() + ')');
    run(2.05); tap();
    ok('mag: the last round - the whole clip reloads: every slot shows it', view.pinnedPoints === p0 + 3 && magStates() === 'fill,fill,fill', '(' + magStates() + ')');
    run(reload / 2);
    const f = magFills();
    ok('mag: ONE shared fill - all three the same, half-way at half the reload, and the ring with them',
       f[0] === f[1] && f[1] === f[2] && near(f[0], 0.5, 0.03) && near(view.reloadPart, 0.5, 0.03) && /\n• Clip reloading: \d+ s left\n/.test(gunMag.title),
       '(' + f + ' / ' + view.reloadPart + ')');
    ok('mag: a clip reload runs with the frame loop (the ring fills), so no panel timer of its own', panelTimers() === 0);
    run(reload / 2 + 0.1);
    ok('mag: then all three are loaded together', magStates() === 'on,on,next', '(' + magStates() + ')');
    tap();
    ok('mag: and the clip fires again from full', view.pinnedPoints === p0 + 4 && magStates() === 'on,wait,off', '(' + magStates() + ')');
    run(reload + 5);
    document.getElementById('hits').children[2].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    const reload = figure(), p0 = view.pinnedPoints;
    ok('mag: a single-shot gun - one slot, loaded and lit', magStates() === 'next' && gunMag.children.length === 1, '(' + magStates() + ')');
    tap();
    ok('mag: the shot empties it and it starts to fill', view.pinnedPoints === p0 + 1 && magStates() === 'fill' && magFills()[0] < 0.05, '(' + magFills() + ')');
    run(reload / 2);
    ok('mag: half-way through the reload the slot is half full, as the ring is', near(magFills()[0], 0.5, 0.03) && near(view.reloadPart, 0.5, 0.03)
       && /^Loading: \d+ s left of /.test(gunMag.title), '(' + magFills() + ' / ' + gunMag.title.slice(0, 30) + ')');
    run(reload / 2 + 0.1);
    ok('mag: then loaded again', magStates() === 'next' && /^Loaded\n/.test(gunMag.title));
    click(sub);
    tap();
    ok('mag: real reload OFF - the release resets the reload, so the slot stays loaded', view.pinnedPoints === p0 + 2 && magStates() === 'next', '(' + magStates() + ')');
    click(sub);
    document.getElementById('hits').children[3].onclick();
    return settle(20);
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    const reload = figure(), bar = gunMag.children[0];
    ok('mag: a magazine of thirty is ONE bar, full', gunMag.children.length === 1 && bar.className === 'aim-mag-bar'
       && bar.children[0].className === 'aim-mag-bar-fill' && magStates() === 'on' && magFills()[0] === 1 && /^Magazine 30 \/ 30\n/.test(gunMag.title),
       '(' + gunMag.children.length + ' / ' + magFills() + ')');
    tap(); run(0.25); tap(); run(0.25); tap();
    ok('mag: three rounds - its fill is the rounds left, the count in the tooltip', near(magFills()[0], 27 / 30, 0.002) && /^Magazine 27 \/ 30\n/.test(gunMag.title),
       '(' + magFills() + ' / ' + gunMag.title.slice(0, 20) + ')');
    press(); run(6); release();
    ok('mag: emptied, the bar shows the reload instead', magStates() === 'fill' && magFills()[0] < 0.1, '(' + magStates() + ' / ' + magFills() + ')');
    run(reload / 2);
    ok('mag: half-way through it, half a bar', near(magFills()[0], 0.5, 0.03), '(' + magFills() + ')');
    run(reload / 2 + 0.1);
    ok('mag: then the bar is full again', magStates() === 'on' && magFills()[0] === 1, '(' + magStates() + ' / ' + magFills() + ')');
    click(document.getElementById('fun-mode-toggle'));
    delete window.BullbaHitsRng;
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- circle-rhythm (23.09, BACKLOG 35-36): the circle after a round and the rhythm of fire under ✸ ---------------
  // The client's formula takes the after-shot term by three branches (Avatar.getOwnVehicleShotDispersionAngle
  // 3310-3318): an automatic gun's controller - n × shotDispersionPerShot after n rounds of one stream -, afterShotInBurst
  // for a round of a burst with more rounds after it, afterShot for every other round; a dual-accuracy gun's ideal is
  // ×(afterShotDispersionAngle / shotDispersionAngle) while its component is ACTIVE (3327-3331). Beside it: the STK-2
  // heats in bands with no lock, one pull fires a burst gun's whole burst, an improved autoloader loads faster after a
  // pause, a siege shot takes the siege block (modeAim), and the tier-XI skill tree's velocity node names a shell the
  // tracer used to contradict. The client's numbers: Ares 90 ×1.10 after the first round (the page drew ×4.12) and
  // ×6.9 after the tenth with its heat band; Donnola ×1.41 after the 1st and 2nd round of its burst, ×8.06 after the
  // 3rd; Type 71 ×1.73 for 12 s; the STK-2 ×1.227 cold and ×1.909 before every round from the 4th; Breaker ×1.0400.
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };
  const B = ArmorBallistics;
  // ---- 1. the arithmetic --------------------------------------------------------------------------------------------
  const AUTO = {maxShotDispersion: 10, shotDispersionPerShot: 0.45, groupSize: 1, aimingDelay: 0.3};
  const ARES_T = {dispersion: 0.001, afterShotFactor: 4, autoShoot: AUTO};
  ok('circle: an automatic gun’s term is n × shotDispersionPerShot, held between rounds - Ares 90: 0.45 after the first round, 4.5 after the tenth, the cap 10 from the 23rd',
     near(B.shotTerm(ARES_T, 1).term, 0.45) && near(B.shotTerm(ARES_T, 10).term, 4.5) && B.shotTerm(ARES_T, 23).term === 10
     && B.shotTerm(ARES_T, 1).hold === true && B.shotTerm(ARES_T, 3, true).term === B.shotTerm(ARES_T, 3).term);
  const first = B.aimFactor(ARES_T, {afterShot: true, shotTerm: B.shotTerm(ARES_T, 1).term}), old = B.aimFactor(ARES_T, {afterShot: true});
  ok('circle: Ares 90 - the first round ×1.10 (√(1 + 0.45²) = 1.0966), where afterShot 4 gave ×4.12',
     near(first.ideal, Math.sqrt(1.2025)) && near(old.ideal, Math.sqrt(17)), '(' + first.ideal.toFixed(4) + ' / ' + old.ideal.toFixed(4) + ')');
  const tenth = B.aimFactor(ARES_T, {afterShot: true, shotTerm: B.shotTerm(ARES_T, 10).term}, {mult: 1.5});
  ok('circle: the tenth round ×4.61, and in the heat band ×1.5 ×6.91', near(tenth.ideal, 1.5 * Math.sqrt(1 + 4.5 * 4.5)), '(' + tenth.ideal.toFixed(4) + ')');
  const held = B.aimStep(null, {hold: true, shotTerm: 2.25}, ARES_T, null, 1 / 60);
  ok('circle: the held term stays in the ideal between rounds - the fifth round’s ×2.46 does not settle away', near(held.ideal, Math.sqrt(1 + 2.25 * 2.25)) && held.settled);
  const DON = {dispersion: 0.001, afterShotFactor: 8, afterShotInBurstFactor: 1};
  ok('circle: Donnola - a round with more of its burst after it takes afterShotInBurst 1 (×1.41), the last one afterShot 8 (×8.06)',
     B.shotTerm(DON, 0, true).term === 1 && B.shotTerm(DON, 0, false).term === 8 && B.shotTerm(DON, 0, true).hold === false
     && near(B.aimFactor(DON, {afterShot: true, shotTerm: 1}).ideal, Math.SQRT2) && near(B.aimFactor(DON, {afterShot: true}).ideal, Math.sqrt(65)));
  ok('circle: with no term handed in the formula is the old one - afterShot at the shot only, a lone term without a shot or a hold is nothing',
     B.aimFactor(AIM_BLOCK, {afterShot: true}).ideal === Math.sqrt(17) && B.aimFactor(AIM_BLOCK, {}).ideal === 1
     && B.aimFactor(AIM_BLOCK, {shotTerm: 3}).ideal === 1 && B.aimFactor(AIM_BLOCK, {afterShot: true, shotTerm: null}).ideal === Math.sqrt(17));
  ok('circle: a gun with neither the controller nor a burst factor keeps its afterShot even inside a burst',
     B.shotTerm(AIM_BLOCK, 0, true).term === 4 && B.shotTerm(AIM_BLOCK, 0, false).term === 4);
  // The field modification's miscAttrs afterShot (final review, 23.09): the client reads that copy for the plain
  // after-shot term only (Avatar 3310-3318) - never for an automatic gun's controller term or a burst's afterShotInBurst.
  const FM = {afterShotField: 0.85}, FM_UP = {afterShotField: 1.15};
  ok('circle: the field modification’s afterShot goes on the plain term only - afterShot 4 ×0.85 = 3.4, while an Ares round, a Donnola round inside its burst and a held stream keep their own terms',
     near(B.aimFactor(AIM_BLOCK, {afterShot: true}, FM).ideal, Math.sqrt(1 + 3.4 * 3.4))
     && B.aimFactor(ARES_T, {afterShot: true, shotTerm: B.shotTerm(ARES_T, 4).term}, FM).ideal === B.aimFactor(ARES_T, {afterShot: true, shotTerm: B.shotTerm(ARES_T, 4).term}).ideal
     && B.aimFactor(DON, {afterShot: true, shotTerm: 1}, FM_UP).ideal === B.aimFactor(DON, {afterShot: true, shotTerm: 1}).ideal
     && near(B.aimFactor(DON, {afterShot: true}, FM_UP).ideal, Math.sqrt(1 + 9.2 * 9.2))
     && B.aimStep(null, {hold: true, shotTerm: 2.25}, ARES_T, FM, 1 / 60).ideal === held.ideal
     && near(B.aimFactor(AIM_BLOCK, {afterShot: true}, {afterShotField: 0.85, afterShot: 1.66}).ideal, Math.sqrt(1 + Math.pow(3.4 * 1.66, 2))));
  ok('circle: the page hands it over as afterShotField, apart from the tier-XI afterShot of xiApply',
     /afterShotField: aimMul\(e, 'afterShotFactor'\)/.test(appSrc) && !/\n\s*afterShot: aimMul\(e, 'afterShotFactor'\)/.test(appSrc));
  // The improved autoloader's cut, off the page's own autoloader block (boostAt is part of it).
  const bStart = appSrc.indexOf('  // AN AUTOLOADER under real reload'), bEnd = appSrc.indexOf('  // THE HEAT of the five Ares guns', bStart);
  const BR = new Function('env', 'var aimClip=4,aimClipSize=4;function realReload(){return true;}function panelWake(){}\n' + appSrc.slice(bStart, bEnd) +
    '\nreturn {boost:boostAt,shot:refillShot,settle:refillSettle,set:function(c){aimClip=c;},state:function(){return {clip:aimClip,refill:aimRefill};}};')({});
  const BOOST = {autoreload: {boostFraction: 0.5, boostStartTime: 1, boostResidueTime: 2, reloadTime: [10, 12, 14, 16]}};
  ok('circle: an improved autoloader at rest with a full magazine is CHARGED - the cut is its boostFraction 0.5; a plain autoloader has none',
     BR.boost(BOOST, 2.5, 100) === 0.5 && BR.boost({autoreload: {boostFraction: 1, reloadTime: [10]}}, 2.5, 100) === 1 && BR.boost(null, 2.5, 100) === 1);
  ok('circle: the Bélier’s 0.25 cuts a 10 s round to 2.5 s (the other reading, less by a quarter, would give 7.5 s - only a battle tells)',
     BR.boost({autoreload: {boostFraction: 0.25, boostStartTime: 0.5, boostResidueTime: 2, reloadTime: [15, 15]}}, 2.5, 100) === 0.25);
  BR.set(3); BR.shot([10, 12, 14, 16], 100, BR.boost(BOOST, 2.5, 100));
  ok('circle: fired from rest, the spent round loads back in 10 × 0.5 = 5 s (×boostFraction, the page’s reading)',
     BR.state().clip === 3 && near(BR.state().refill.until, 105), '(' + BR.state().refill.until + ')');
  ok('circle: a round 2.6 s into that load is still WAITING (clip interval 2.5 + boostStartTime 1) - no cut',
     BR.boost(BOOST, 2.5, 102.6) === 1);
  ok('circle: from the end of the load − boostResidueTime 2 (and past the wait) it is CHARGED again', BR.boost(BOOST, 2.5, 103.4) === 1 && BR.boost(BOOST, 2.5, 103.5) === 0.5);
  // B6: the tier-XI skill tree's velocity node in the ballistic check (shot-context.js), on a Breaker hit.
  const realShot = new Function('window', fs.readFileSync(path + 'shot-context.js', 'utf8') + ';return window.ArmorShotContext;')({});
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const APDS = {kind: 'ARMOR_PIERCING_CR', name: 'APDS Mk. 2B', caliber: 123, penetration100: 326, penetration500: 306, speed: 1000,
                gravity: 6.2784, alpha: 480, damageRandomization: .25, effectsIndex: 42, gunInstallation: 0, gun: 'OQF 123 mm Mk. 1B'};
  const treeHit = function (type) {
    return {id: 'x', attackerId: 7, targetId: 1, damage: 0, receivedAt: 100, effectsIndex: 42,
            points: [{part: 0, status: 'resolved', position: [0, 0, 0], shellKind: 'ARMOR_PIERCING_CR', caliber: 123}],
            availableShells: [APDS], shellCandidates: [], attacker: {type: type},
            target: {worldTransform: IDENT, parts: [{id: 0, transform: IDENT}]}};
  };
  const treeEvents = function (speed) {
    return [{event: 'tracer', id: 't1', shooterId: 7, effectsIndex: 42, receivedAt: 99.9, isRicochet: false, gunInstallationIndex: 0, own: false,
             origin: [0, 0, 100], velocity: [speed, 0, 0], gravity: 6.2784}, {event: 'stop', id: 'e1', tracerId: 't1', receivedAt: 100, position: [0, 0, 0]}];
  };
  const byTree = realShot.resolve(treeHit('uk:GB152_AT_FV230_Breaker'), treeEvents(1040));
  ok('circle: a Breaker tracer at ×1.0400 of its APDS Mk. 2B (the tree’s +50 × 0.8 = +40 m/s) names the shell, marked XI skill tree',
     byTree.index === 0 && byTree.treeSpeed === 40 && /XI skill tree: the tracer flew 40 m\/s faster/.test(byTree.source), '(' + byTree.index + ' / ' + byTree.source + ')');
  ok('circle: the stock tracer still names it, with no tree in the words',
     (function () { const r = realShot.resolve(treeHit('uk:GB152_AT_FV230_Breaker'), treeEvents(1000)); return r.index === 0 && r.treeSpeed === null && !/XI/.test(r.source); })());
  ok('circle: a vehicle without the node - the same tracer still contradicts the shell',
     realShot.resolve(treeHit('uk:Other'), treeEvents(1040)).index === -1);
  ok('circle: and a tracer off both the stock and the tree ratio does too', realShot.resolve(treeHit('uk:GB152_AT_FV230_Breaker'), treeEvents(1075)).index === -1);
  ok('circle: the tree table is the client’s (17 vehicles, the nodes ×0.8 as projectileSpeedFactor) and lives in shot-context.js alone',
     /'uk:GB152_AT_FV230_Breaker':\[\[1000,50\],\[1250,50\]\]/.test(fs.readFileSync(path + 'shot-context.js', 'utf8')) && appSrc.indexOf('XI_TREE_SPEED') < 0);
  ok('circle: the new ✸ block is inside the one ✸ block of app.js and casts no ray',
     appSrc.indexOf('  // --- ✸: the circle after a round') > appSrc.indexOf('  // --- ✸: real reload and the heat')
     && appSrc.indexOf('  // --- ✸: the circle after a round') < appSrc.indexOf('  // --- The fun layer'));

  // ---- 2. through the page -------------------------------------------------------------------------------------------
  const CPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const MULT = function (v) { return [{op: 'mul', name: 'dynAttrs/multShotDispersionFactor', value: v}]; };
  const DONNOLA_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 8, afterShotInBurstFactor: 1, burst: [3, 0.3, false], clip: [3, 0.3], reloadTime: 6, gunTags: ['clip']});
  const ARES_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 4, reloadTime: 7, clip: [250, 0.3], gunTags: ['autoShoot', 'clip'], autoShoot: AUTO,
    temperatureGun: {heatingPerShot: 11, coolingDelay: 2, coolingPerSec: 10, maxTemperature: 100, thermalStateHysteresis: 1,
      thermalStates: [{maxTemperature: 50}, {maxTemperature: 88, modifiers: MULT(1.25)}, {maxTemperature: 100, modifiers: MULT(1.5)}]},
    overheatGun: {coolingPerSecFactor: 0.5, tempOverheatOnThreshold: 100, tempOverheatOffThreshold: 0, tempOverheatWarnThreshold: 89}});
  const TYPE71_AIM = Object.assign({}, AIM_BLOCK, {dispersion: 0.0022, afterShotFactor: 0, reloadTime: 10, gunTags: ['dualAccuracy'],
    dualAccuracy: {afterShotDispersionAngle: 0.0038, coolingDelay: 12}});
  const STK_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 9.7,
    temperatureGun: {heatingPerShot: 50, coolingDelay: 1, coolingPerSec: 2.8, maxTemperature: 100, thermalStateHysteresis: 1,
      thermalStates: [{maxTemperature: 20, modifiers: MULT(1.227)}, {maxTemperature: 40, modifiers: MULT(1.455)}, {maxTemperature: 60, modifiers: MULT(1.682)},
        {maxTemperature: 80, modifiers: MULT(1.909)}, {maxTemperature: 100, modifiers: MULT(2.136)}]}, heatingZonesGun: {zones: [0, 20, 80, 100]}});
  const SIEGE_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0});
  const SIEGE_MODE = Object.assign({}, SIEGE_AIM, {dispersion: 0.0024, aimingTime: 1.0});
  const CHAR_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, burst: [3, 0.5, false], clip: [6, 3.5], reloadTime: 42, gunTags: ['clip']});
  const BOOST_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 15.4, clip: [4, 2.5], gunTags: ['autoreload', 'clip'],
    autoreload: {boostFraction: 0.5, boostStartTime: 1.0, reloadTime: [10.0, 12.0, 14.0, 16.0], boostResidueTime: 2.0}});
  const ROCK_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 4, afterShotInBurstFactor: 2, burst: [2, 1.5, true], reloadTime: 10.5, gunMechanics: ['chargeableBurst']});
  const CHIT = function (id, attackerId, type, aim, extra) {
    return {id: id, attackerId: attackerId, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: Object.assign({name: type, type: type, parts: CPARTS(), gunDispersion: aim.dispersion, aim: aim}, extra || {}),
            target: {name: 'Alpha', type: 'germany:Alpha', parts: CPARTS()}, warnings: []};
  };
  const ROW = function (id, type) { return {id: id, name: type, type: type, team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000}; };
  const CBATTLE = {id: 'c1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 1850, defaultMaxHealth: 1800},
             ROW(41, 'italy:It38_Donnola'), ROW(42, 'usa:A189_Ares_90'), ROW(43, 'china:Ch_Type_71'), ROW(44, 'japan:J52_STK_2'),
             ROW(45, 'sweden:Siege'), ROW(46, 'sweden:Siege0'), ROW(47, 'france:F118_Char_Mle_75'), ROW(48, 'italy:Boost'), ROW(49, 'usa:A179_Black_Rock')],
    hits: [CHIT('c-donnola', 41, 'italy:It38_Donnola', DONNOLA_AIM), CHIT('c-ares', 42, 'usa:A189_Ares_90', ARES_AIM),
           CHIT('c-type71', 43, 'china:Ch_Type_71', TYPE71_AIM), CHIT('c-stk2', 44, 'japan:J52_STK_2', STK_AIM),
           CHIT('c-siege', 45, 'sweden:Siege', SIEGE_AIM, {modeAim: SIEGE_MODE, modeAimMode: 1, vehicleMode: 0, siegeStateAtImpact: 2}),
           CHIT('c-siege0', 46, 'sweden:Siege0', SIEGE_AIM, {modeAim: SIEGE_MODE, modeAimMode: 1, vehicleMode: 0, siegeStateAtImpact: 0}),
           CHIT('c-char', 47, 'france:F118_Char_Mle_75', CHAR_AIM), CHIT('c-boost', 48, 'italy:Boost', BOOST_AIM),
           CHIT('c-rock', 49, 'usa:A179_Black_Rock', ROCK_AIM)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'c1' ? Promise.resolve(CBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []});
  };
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const funBox = document.getElementById('fun-mode'), realBox = document.getElementById('real-reload');
  const star = document.getElementById('fun-mode-toggle'), sub = document.getElementById('real-reload-toggle');
  const heatBox = document.getElementById('aim-gun-heat'), warnMark = document.getElementById('aim-gun-heat-warn');
  const setFun = function (on) { if (funBox.checked !== on) click(star); };
  const cb = document.getElementById('battles');
  cb.value = 'c1'; cb.onchange.call(cb);
  const prepare = function (view) {
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
  };
  const tap = function () { press(); release(); };
  // Frames of 1/60 s until the gun has fired `want` rounds in all, at most `most` seconds: the time it took and the
  // live ring at the very frame the round left - its bloom.
  const fireStep = function (view, want, most) {
    const t0 = clock;
    for (let i = 0; i < most * 60 && view.pinnedPoints < want; i++) tick(1 / 60);
    return {t: clock - t0, r: view.liveRadius100};
  };
  const openHit = function (i) { document.getElementById('hits').children[i].onclick(); return settle(20); };
  let r0 = 0;
  return settle(20).then(function () {
    // Donnola: a burst of three 0.3 s apart, the magazine three, afterShot 8, afterShotInBurst 1.
    const view = viewerInstance; prepare(view); setFun(false); if (!realBox.checked) click(sub); run(0.1);
    r0 = view.liveRadius100;
    ok('circle: (Donnola on screen, ✸ off, the ring at rest)', r0 > 0 && funBox.checked === false && realBox.checked === true);
    let p = view.pinnedPoints;
    tap();
    ok('circle: ✸ OFF - one press is one round, and its bloom is afterShot 8: ×8.06, exactly as before',
       view.pinnedPoints === p + 1 && near(view.liveRadius100 / r0, Math.sqrt(65), 1e-9), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(1);
    ok('circle: ✸ OFF - and nothing follows it', view.pinnedPoints === p + 1);
    run(30);
    setFun(true); run(0.1);
    p = view.pinnedPoints;
    tap();
    const b1 = view.liveRadius100 / r0;
    const s2 = fireStep(view, p + 2, 2), b2 = s2.r / r0;
    const s3 = fireStep(view, p + 3, 2), b3 = s3.r / r0;
    ok('circle: ✸ ON - one press fires the whole burst: three rounds, 0.3 s apart, the button long up',
       view.pinnedPoints === p + 3 && near(s2.t, 0.3, 0.02) && near(s3.t, 0.3, 0.02), '(' + s2.t.toFixed(3) + ' / ' + s3.t.toFixed(3) + ' s)');
    ok('circle: B1 - the 1st and 2nd round bloom by afterShotInBurst: ×1.41, the 3rd by afterShot: ×8.06 (the page drew ≈6.9 on the 2nd and 3rd)',
       near(b1, Math.SQRT2, 1e-9) && near(b2, Math.SQRT2, 1e-9) && near(b3, Math.sqrt(65), 1e-9), '(' + [b1, b2, b3].map(function (v) { return v.toFixed(4); }).join(', ') + ')');
    run(1.5); tap();
    ok('circle: the magazine is empty - no fourth round, and a press during the reload does not fire', view.pinnedPoints === p + 3 && magStates() === 'fill,fill,fill', '(' + magStates() + ')');
    run(7);
    tap();
    ok('circle: after the reload the next press is a new burst', view.pinnedPoints === p + 4 && fireStep(view, p + 6, 2).t < 0.7);
    // The simplified reload: the burst still goes out whole, and the gun is left full once it has.
    click(sub); run(30);
    p = view.pinnedPoints; tap(); fireStep(view, p + 3, 2); run(0.2);
    ok('circle: ◔ off - the burst goes out whole all the same, and the release leaves the gun full once it has',
       view.pinnedPoints === p + 3 && magStates() === 'on,on,next', '(' + (view.pinnedPoints - p) + ' / ' + magStates() + ')');
    tap(); tap();
    ok('circle: ◔ off - a press during a burst is refused (the game takes no second pull), the burst goes on', view.pinnedPoints === p + 4 && fireStep(view, p + 6, 2).t < 0.7 && view.pinnedPoints === p + 6);
    click(sub); run(30);
    return openHit(1);
  }).then(function () {
    // Ares 90: afterShot 4, the controller 0.45 a round, 250 rounds 0.3 s apart, the heat of the Ares 90.
    const view = viewerInstance; prepare(view); setFun(false); run(0.1);
    r0 = view.liveRadius100;
    let p = view.pinnedPoints;
    tap();
    ok('circle: Ares 90, ✸ OFF - a round blooms by afterShot 4: ×4.12, as before', near(view.liveRadius100 / r0, Math.sqrt(17), 1e-9), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(30); setFun(true); run(0.1);
    ok('circle: (✸ on: the cold Ares is ×1)', near(view.liveRadius100 / r0, 1, 1e-9));
    tap();
    ok('circle: B2 - ✸ ON: the first round is ×1.10 (√(1 + 0.45²))', near(view.liveRadius100 / r0, Math.sqrt(1.2025), 1e-9), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(30);
    p = view.pinnedPoints;
    press();
    const r = [];
    for (let n = 1; n <= 10; n++) {
      const s = fireStep(view, p + n, 1);
      r.push(s.r / r0);
      if (n === 5) { tick(0.15); r.push(view.liveRadius100 / r0); }
    }
    const want = function (n, band) { return Math.sqrt(1 + 0.2025 * n * n) * band; };
    ok('circle: a hold - the n-th round blooms √(1 + (0.45 n)²): ×1.10, ×1.35 ... ×2.46 on the 5th',
       near(r[0], want(1, 1), 1e-9) && near(r[1], want(2, 1), 1e-9) && near(r[4], want(5, 1), 1e-9), '(' + r.slice(0, 5).map(function (v) { return v.toFixed(3); }).join(', ') + ')');
    ok('circle: the term stays between rounds: half a gap after the 5th the circle is still ×2.46 - times 1.25 now, the 5th round took the gun to 55',
       near(r[5], want(5, 1.25), 1e-9), '(' + r[5].toFixed(4) + ')');
    ok('circle: the heat bands on top: the 6th round (55) ×1.25, the 10th (99) ×1.5 - ×6.91, the client’s ×6.9',
       near(r[6], want(6, 1.25), 1e-9) && near(r[10], want(10, 1.5), 1e-9), '(' + r[6].toFixed(3) + ' / ' + r[10].toFixed(3) + ')');
    const locked = view.liveRadius100 / r0;
    run(2);
    ok('circle: the tenth round locks the gun: the stream stops and its term leaves the circle, which settles back while still held',
       view.pinnedPoints === p + 10 && heatBox.getAttribute('data-locked') === '1' && view.liveRadius100 / r0 < locked * 0.7, '(' + (view.liveRadius100 / r0).toFixed(3) + ')');
    release(); run(30);
    // The gun panel's reload figure has no parent in this stub DOM; the load title goes on the parent (paintAimMechanics).
    new Element('span').appendChild(document.getElementById('aim-gun-reload'));
    return openHit(2);
  }).then(function () {
    // Type 71: 0.22 m/100 m, after a shot 0.38 (×1.727) for coolingDelay 12 s; afterShot 0 so the factor stands alone.
    const view = viewerInstance; prepare(view); setFun(false); run(0.1);
    r0 = view.liveRadius100;
    tap(); run(1);
    ok('circle: Type 71, ✸ OFF - after a shot the circle is as before (×1, afterShot 0 here)', near(view.liveRadius100 / r0, 1, 1e-9));
    const title = document.getElementById('aim-gun-reload').parentNode.title;
    ok('circle: the gun panel says what dual accuracy does and that its length is the page’s assumption',
       /\n• Dual accuracy: after a shot the whole circle widens ×1\.7273 \(0\.38 against 0\.22 m at 100 m\); under ⌖ for 12 s after every round - that length is this page’s assumption(\n|$)/.test(title), '(' + title.slice(-200) + ')');
    run(12); setFun(true); run(0.1);
    tap();
    ok('circle: B3 - ✸ ON: the round widens the whole circle ×0.38/0.22 = ×1.727 at once', near(view.liveRadius100 / r0, 0.0038 / 0.0022, 1e-9), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(11);
    ok('circle: and it holds for its 12 s - once the reload is over, with the loop asleep: no frame spent on a circle that does not move',
       near(view.liveRadius100 / r0, 0.0038 / 0.0022, 1e-9) && loopFrames() === 0, '(' + (view.liveRadius100 / r0).toFixed(4) + ' / ' + loopFrames() + ')');
    run(1.2);
    const after = view.liveRadius100 / r0;
    run(15);
    ok('circle: past 12 s its timer wakes the loop and the circle settles back to ×1 by the aiming time',
       after < 0.0038 / 0.0022 - 0.01 && near(view.liveRadius100 / r0, 1, 1e-3), '(' + after.toFixed(4) + ' -> ' + (view.liveRadius100 / r0).toFixed(4) + ')');
    return openHit(3);
  }).then(function () {
    // STK-2: +50 a round, 1 s, 2.8 a second, the bands ×1.227 .. ×2.136, no overheatGun, reload 9.7 s.
    const view = viewerInstance; prepare(view); setFun(false); run(0.1);
    r0 = view.liveRadius100;
    ok('circle: STK-2, ✸ OFF - no heat bar, the circle ×1', heatBox.hidden === true);
    setFun(true); run(20);
    ok('circle: B4 - ✸ ON: the bar is up without a warning mark, and the cold gun is already ×1.227',
       heatBox.hidden === false && warnMark.hidden === true && near(view.liveRadius100 / r0, 1.227, 1e-6) && /\n• Overheat: never — this gun has no lock\n/.test(heatBox.title)
       && /\n• Aiming circle: ×1\.227 up to 20, ×1\.455 above 20, ×1\.682 above 40, ×1\.909 above 60, ×2\.136 above 80 — now ×1\.227\n/.test(heatBox.title),
       '(' + (view.liveRadius100 / r0).toFixed(4) + ' / ' + heatBox.title + ')');
    const p = view.pinnedPoints;
    tap(); run(0.05);
    ok('circle: one round: 50, ×1.682', /^Gun heat 50 \/ 100/.test(heatBox.title) && near(view.liveRadius100 / r0, 1.682, 1e-6), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(9.65);
    ok('circle: a reload later it has cooled to 25.6: ×1.455', /^Gun heat 26 \/ 100/.test(heatBox.title) && /now ×1\.455\n/.test(heatBox.title), '(' + heatBox.title.slice(0, 20) + ')');
    tap(); run(9.7); tap(); run(9.7);
    ok('circle: before the 4th round it stands at 75.6 - ×1.909, the stable fire of the client', /^Gun heat 76 \/ 100/.test(heatBox.title) && /now ×1\.909\n/.test(heatBox.title), '(' + heatBox.title.slice(0, 20) + ')');
    tap(); run(0.05); tap(); run(9.7); tap();
    ok('circle: at 100 it never locks: every round the reload lets through fires, the frame never goes red',
       view.pinnedPoints === p + 5 && heatBox.getAttribute('data-locked') === '0', '(' + (view.pinnedPoints - p) + ')');
    return openHit(4);
  }).then(function () {
    // A siege shot: the recorded block 0.383 m/100 m, the siege descriptor's 0.24 (modeAim, mode 1), the impact in siege.
    // 23.09: the siege block applies with or without ✸ - the recorded ring of a siege shot is the siege circle.
    const view = viewerInstance; prepare(view); setFun(false); run(20);
    globalThis.__b5Siege = view.liveRadius100;
    setFun(true); run(20);
    ok('circle: B5 - the siege shot keeps the same siege circle with ✸ on and off', near(view.liveRadius100 / globalThis.__b5Siege, 1, 1e-6));
    setFun(false); run(20);
    return openHit(5);
  }).then(function () {
    const view = viewerInstance; prepare(view); setFun(false); run(20);
    const r5 = view.liveRadius100;
    ok('circle: B5 - a shot fired in the siege mode takes the siege block (✸ off): 0.24 against 0.383, the ring ×0.627',
       near(globalThis.__b5Siege / r5, 0.0024 / 0.00383, 1e-6), '(' + (globalThis.__b5Siege / r5).toFixed(4) + ')');
    setFun(true); run(20);
    ok('circle: a shot of the same vehicle in its default mode keeps the recorded block under ✸', near(view.liveRadius100 / r5, 1, 1e-6));
    setFun(false);
    return openHit(6);
  }).then(function () {
    // Char Mle. 75: bursts of three 0.5 s apart from a magazine of six, 3.5 s between bursts, 42 s to reload.
    const view = viewerInstance; prepare(view); setFun(false); run(0.1);
    let p = view.pinnedPoints;
    tap(); run(2);
    ok('circle: Char Mle. 75, ✸ OFF - one press, one round', view.pinnedPoints === p + 1);
    run(60); setFun(true); run(0.1);
    p = view.pinnedPoints;
    tap();
    const t2 = fireStep(view, p + 2, 2).t, t3 = fireStep(view, p + 3, 2).t;
    ok('circle: C1 - ✸ ON: one press fires its burst of three, 0.5 s apart; three rounds left, the next waiting',
       view.pinnedPoints === p + 3 && near(t2, 0.5, 0.02) && near(t3, 0.5, 0.02) && magStates() === 'on,on,wait,off,off,off', '(' + t2.toFixed(3) + ' / ' + t3.toFixed(3) + ' / ' + magStates() + ')');
    run(3); tap();
    ok('circle: a press 3 s after the burst is refused - the clip interval, 3.5 s, runs from its last round', view.pinnedPoints === p + 3);
    run(0.55); tap(); fireStep(view, p + 6, 2);
    ok('circle: past it, the second burst empties the magazine, and the whole clip reloads', view.pinnedPoints === p + 6 && magStates() === 'fill,fill,fill,fill,fill,fill', '(' + magStates() + ')');
    run(2); tap();
    ok('circle: no seventh round', view.pinnedPoints === p + 6);
    run(60);
    return openHit(7);
  }).then(function () {
    // An improved autoloader: 10 12 14 16 s, a magazine of four 2.5 s apart, boostFraction 0.5, boostStartTime 1, residue 2.
    const view = viewerInstance; prepare(view); setFun(true); if (!realBox.checked) click(sub); run(0.1);
    const k = parseFloat(document.getElementById('aim-gun-reload').textContent) / 16;
    const loaded = function () { return magStates().split(',').filter(function (x) { return x === 'on' || x === 'next' || x === 'wait'; }).length; };
    const back = function (most) { const from = loaded(), t0 = clock; for (let i = 0; i < most * 20; i++) { tick(0.05); if (loaded() !== from) return clock - t0; } return -1; };
    tap();
    const t1 = back(20);
    ok('circle: C2 - fired from rest, the spent round of an improved autoloader loads back in 10 s × k × 0.5',
       near(t1, 10 * k * 0.5, 0.06) && magStates() === 'on,on,on,next', '(' + t1.toFixed(2) + ' s against ' + (10 * k * 0.5).toFixed(2) + ')');
    ok('circle: its tooltip says so, with the numbers and the reading marked as the page’s',
       /\n• Improved autoreloader: a round fired after a rest loads the next one in ×0\.5 of its time \(⌖ with ◔\)\n• Rest: at least 3\.5 s into a round’s load and within 2 s of its end, or a full magazine\nThe game’s numbers; this page reads ×0\.5 as the share of the time kept, not the share cut\./.test(gunMag.title), '(' + gunMag.title.slice(-260) + ')');
    tap(); run(2.6); tap();
    // The second round went 2.6 s into the boosted 5k load: WAITING, so its load goes on at the time of two rounds in
    // (12 s × k) with the share already done - (1 − 2.6 / 5k) × 12k. k is read off the panel's one-decimal figure and
    // the steps are 0.05 s, so 0.1 s of slack; a cut would have made it half that, 2.6 s.
    const t2 = back(20), expect = (1 - 2.6 / (5 * k)) * 12 * k;
    ok('circle: a round fired before the gun has rested gets no cut - its load goes on at 12 s × k with the share it had',
       near(t2, expect, 0.1) && t2 > expect * 0.75, '(' + t2.toFixed(2) + ' s against ' + expect.toFixed(2) + ')');
    setFun(false); run(60);
    return openHit(8);
  }).then(function () {
    // The Black Rock: its burst is the Burst mode of chargeableBurst only - under ✸ one press is still one round.
    const view = viewerInstance; prepare(view); setFun(false); run(0.1);
    r0 = view.liveRadius100;
    setFun(true); run(0.1);
    const p = view.pinnedPoints;
    tap(); const bloom = view.liveRadius100 / r0; run(3);
    ok('circle: the Black Rock under ✸ - one round per press while its Burst mode is off (the ✸ mode button switches it, BACKLOG 37), its bloom afterShot 4',
       view.pinnedPoints === p + 1 && near(bloom, Math.sqrt(17), 1e-9), '(' + (view.pinnedPoints - p) + ' / ' + bloom.toFixed(4) + ')');
    setFun(false);
    delete window.BullbaHitsRng;
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- xi-mechanics (23.09, BACKLOG 37-38): the tier-XI mechanics under ✸, one mode button; the Borkenkäfer's mark ----
  // One button in the gun panel (#aim-gun-mech) runs the shooter's own mechanic, only under ✸ and only for the eleven
  // vehicles (plus the three it names and does not run); it starts from the recorded state of the shot. Its factors go
  // on the very mods the circle and the reload take (aimHeated / xiApply). The mark of a leKpz Borkenkäfer on the target
  // (target.designatorMark) widens the damage window of the shell choice to ×1.15 at the top while it is on at the hit's
  // gameTime, and rolls the ✸ damage ×1.1. The client's numbers: A179 chargeableBurst, A183 concentrationMode, S36
  // pillboxSiegeMode, Pl37 stanceDance, G188 targetDesignator, G185 accuracyStacks, A182 battleFury, It43 autoreloaderSurge,
  // the secondary guns of J53 and G187 (vehicle files of client 2.4.0.1).
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };
  const B = ArmorBallistics;
  const styleSrc = fs.readFileSync(path + 'style.css', 'utf8');
  const realShot = new Function('window', fs.readFileSync(path + 'shot-context.js', 'utf8') + ';return window.ArmorShotContext;')({ArmorBallistics: B});
  // ---- 1. the markup, the rules and the arithmetic ----------------------------------------------------------------------
  // Strip (23.09): the button went up with the load state, into the strip beside ⌖ (the end of its live part).
  const gunPanel = pageSrc.slice(pageSrc.indexOf('<div id="fun-strip"'), pageSrc.indexOf('<div id="target-mods-slot"'));
  ok('xi: ONE mode button in the strip beside ⌖, after the heat bar - the page’s lit switch, hidden until needed, no text',
     /<button type="button" id="aim-gun-mech" class="swap-roles aim-gun-mech" aria-pressed="false" hidden><\/button><\/span>/.test(gunPanel)
     && gunPanel.indexOf('id="aim-gun-heat"') < gunPanel.indexOf('id="aim-gun-mech"'));
  ok('xi: its rules - ⌖’s own size (every lit switch of the top row, no smaller one in the strip), dashed while something runs down, a gold ring, passive and dimmed states',
     !/\.fun-strip \.swap-roles\{/.test(styleSrc) && /\.fun-strip\{flex-wrap:wrap;justify-content:center;row-gap:4px;max-width:100%;padding:2px 9px\}/.test(styleSrc) && /\.aim-gun-mech\[data-busy="1"\]\{border-style:dashed\}/.test(styleSrc)
     && /\.aim-gun-mech\[data-glow="1"\]/.test(styleSrc) && /\.aim-gun-mech\[aria-disabled=true\]:not\(\[data-passive="1"\]\)\{opacity:\.5/.test(styleSrc));
  ok('xi: one table of the client’s numbers, thirteen vehicles, a glyph each; the XM69 gyro = the Black Rock Burst set + ×0.94 and ×1.1',
     /var XI_GYRO = \{movement: 0, rotation: 0, turret: 0, aimingTime: 0\.3\};/.test(appSrc)
     && /mods: \{movement: 0, rotation: 0, turret: 0, aimingTime: 0\.3, mult: 0\.94, hullSpeed: 1\.1\}/.test(appSrc)
     && (appSrc.match(/^    '[a-z]+:[A-Za-z0-9_]+': \{mech: '/gm) || []).length === 13 && /\$\('aim-gun-mech'\)\.onclick=xiPress;/.test(appSrc));
  ok('xi: ballistics.js takes the two new keys (after-shot term, speed cap) and lets a mechanic zero the three movement terms',
     near(B.aimFactor(AIM_BLOCK, {afterShot: true}, {afterShot: 1.66}).ideal, Math.sqrt(1 + 6.64 * 6.64))
     && B.aimFactor(AIM_BLOCK, {afterShot: true}).ideal === Math.sqrt(17)
     && B.aimFactor(AIM_BLOCK, {speed: 10, hullTurn: 0.3, turretTurn: 0.2}, {movement: 0, rotation: 0, turret: 0}).ideal === 1
     && B.aimFactor(AIM_BLOCK, {speed: 10}, {movement: null}).ideal > 1 && B.aimFactor(AIM_BLOCK, {speed: 10}, {mult: 0}).ideal > 1
     && B.moveStep(null, {forward: true}, AIM_BLOCK, {speed: 0}, 0.2).speed === 0
     && near(B.moveStep({speed: 5}, {}, AIM_BLOCK, {speed: 0}, 0.1).speed, 5 - AIM_BLOCK.speedForward / 2 * 0.1, 1e-9));
  // ---- 2. BACKLOG 38: the mark in shot-context.js ------------------------------------------------------------------------
  const MHIT = function (end, at) { return {gameTime: at === undefined ? 500 : at, target: {designatorMark: {creatorID: 99, startTime: 495, endTime: end}}}; };
  const on = realShot.markOf(MHIT(506));
  ok('mark: markOf is on while the mark ends after the hit’s own gameTime - 6 s left, ×1.1 … ×1.15',
     on && on.left === 6 && on.low === 1.1 && on.high === 1.15 && on.creatorID === 99);
  ok('mark: an ended mark, a hit without gameTime and a record without the field are no mark',
     realShot.markOf(MHIT(499)) === null && realShot.markOf(MHIT(500)) === null && realShot.markOf(MHIT(506, null)) === null
     && realShot.markOf({gameTime: 500, target: {}}) === null && realShot.markOf(null) === null);
  // Two AP shells, 320 (240..400; ×1.15 at the top: 460) piercing deeper and 390 (292.5..487.5). A 450 HP hit: the plain
  // window throws the 320 out and keeps the 390; on a marked target the 320 reaches 460 and, deeper, is taken.
  const PAIR = [{kind: 'ARMOR_PIERCING', name: 'deep', caliber: 100, penetration100: 300, alpha: 320, damageRandomization: .25},
                {kind: 'ARMOR_PIERCING', name: 'hard', caliber: 100, penetration100: 250, alpha: 390, damageRandomization: .25}];
  const plainPick = realShot.assume(PAIR, 'ARMOR_PIERCING', 450, 100), markPick = realShot.assume(PAIR, 'ARMOR_PIERCING', 450, 100, on);
  const oldPick = realShot.assume(PAIR, 'ARMOR_PIERCING', 450, 100, realShot.markOf(MHIT(499)));
  ok('mark: the damage window of the shell choice widens only while the mark is on - 450 HP: the 390 without it, the deeper 320 with it',
     plainPick.index === 1 && markPick.index === 0 && oldPick.index === 1 && /Borkenkäfer mark: its damage window reaches ×1\.15/.test(markPick.reason)
     && !/mark/.test(plainPick.reason), '(' + plainPick.index + ' / ' + markPick.index + ' / ' + markPick.reason + ')');
  ok('mark: the bottom of the window stays (whether the marking shot itself gets the bonus is not known) - 250 HP fits the 320 either way',
     realShot.assume(PAIR, 'ARMOR_PIERCING', 250, 100, on).index === 0 && realShot.assume(PAIR, 'ARMOR_PIERCING', 250, 100).index === 0);
  ok('mark: resolve() hands the mark on with the context, and the page passes it to assume() at both calls',
     /mark:markOf\(hit\)/.test(fs.readFileSync(path + 'shot-context.js', 'utf8')) && /,context\.mark\)/.test(appSrc) && /,shotContext\.mark\)/.test(appSrc));

  // ---- 3. through the page ------------------------------------------------------------------------------------------------
  // The stubbed resolve() hands the page the recorded gun state and the mark, the two things the real one reads here.
  const CTX = global.ArmorShotContext, keepResolve = CTX.resolve;
  CTX.resolve = function (hit) {
    const st = hit && hit.attacker && hit.attacker.gunStateAtImpact || null;
    return {choices: SHELLS, index: -1, kind: 'ARMOR_PIERCING', source: 'stub', aimReason: 'no-snapshot', tracer: null,
            gunState: st, gunStateFrom: st ? 'impact' : null, mark: realShot.markOf(hit)};
  };
  CTX.markOf = realShot.markOf;
  const XP = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const XA = function (extra) { return Object.assign({}, AIM_BLOCK, extra || {}); };
  const XHIT = function (id, attackerId, type, aim, extra, hitExtra, targetExtra) {
    return Object.assign({id: id, attackerId: attackerId, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, gameTime: 500, points: [],
      attacker: Object.assign({name: type, type: type, parts: XP(), gunDispersion: aim.dispersion, aim: aim}, extra || {}),
      target: Object.assign({name: 'Alpha', type: 'germany:Alpha', parts: XP()}, targetExtra || {}), warnings: []}, hitExtra || {});
  };
  const HORI_SEC = {installation: 1, name: 'rocket', dispersion: 0.0015, aimingTime: 1.0, turretRotationFactor: 0.10 / D0, afterShotFactor: 1.0,
                    reloadTime: 60, clip: [1, 0], gunTags: []};
  const ROCK = XA({afterShotFactor: 4, afterShotInBurstFactor: 2, burst: [2, 1.5, true], reloadTime: 10.5, gunMechanics: ['chargeableBurst']});
  const CAV = XA({afterShotFactor: 0, reloadTime: 15.4, clip: [4, 2.5], gunTags: ['autoreload', 'clip'], autoreload: {reloadTime: [10.0, 12.0, 14.0, 16.0], boostFraction: 1}});
  const SIEGE_B = XA({afterShotFactor: 0}), SIEGE_M = XA({afterShotFactor: 0, dispersion: 0.0024, aimingTime: 1.0});
  const XHITS = [
    XHIT('x-plain', 60, 'usa:Plain', XA()),
    XHIT('x-szakal-turbo', 61, 'poland:Pl37_CS_67_Szakal', XA(), {gunStateAtImpact: {stanceDance: {abilityState: {state: 1, energyFight: 40, energyTurbo: 10}}}}),
    XHIT('x-szakal-fight', 61, 'poland:Pl37_CS_67_Szakal', XA(), {gunStateAtImpact: {stanceDance: {abilityState: {state: 0, energyFight: 94, energyTurbo: 0}}}}),
    XHIT('x-xm69', 62, 'usa:A183_XM69_Hacker', XA()),
    XHIT('x-xm69-rec', 62, 'usa:A183_XM69_Hacker', XA(), {gunStateAtImpact: {concentrationMode: {status: {state: 3, baseTime: 490, endTime: 504}}}}),
    XHIT('x-strv-siege', 63, 'sweden:S36_Strv_107_12', SIEGE_B, {modeAim: SIEGE_M, modeAimMode: 1, vehicleMode: 0, siegeStateAtImpact: 2}),
    XHIT('x-strv-drive', 63, 'sweden:S36_Strv_107_12', SIEGE_B, {modeAim: SIEGE_M, modeAimMode: 1, vehicleMode: 0, siegeStateAtImpact: 0}),
    XHIT('x-bork', 64, 'germany:G188_LeKpz_Borkenkafer', XA()),
    XHIT('x-bork-armed', 64, 'germany:G188_LeKpz_Borkenkafer', XA(), {gunStateAtImpact: {targetDesignator: {abilityState: {state: 1, startTime: 495, endTime: 0}}}}),
    XHIT('x-hori', 65, 'japan:J53_Ho_Ri_Shugo', XA({secondary: HORI_SEC})),
    XHIT('x-hori-slot1', 65, 'japan:J53_Ho_Ri_Shugo', XA({secondary: HORI_SEC}), null, {gunInstallationIndex: 1}),
    XHIT('x-tasch', 66, 'germany:G187_Taschenratte', XA()),
    XHIT('x-rock', 67, 'usa:A179_Black_Rock', ROCK),
    XHIT('x-rock-rec', 67, 'usa:A179_Black_Rock', ROCK, {gunStateAtImpact: {chargeableBurst: {charges: 2, shots: 0, isBurstActive: true}}}),
    XHIT('x-leo', 68, 'germany:G185_Leopard_120_Verbessert', XA(), {gunStateAtImpact: {accuracyStacks: {abilityState: {curLevel: 2, maxLevel: 4, gainTime: 5, gainMaxSpdKmh: 20, aimLevelBonus: 0.04}}}}),
    XHIT('x-t803', 69, 'usa:A182_T803', XA(), {gunStateAtImpact: {battleFury: {abilityState: {currentLevel: 3, maxLevel: 5}}}}),
    XHIT('x-cav', 70, 'italy:It43_CAV_mod_71', CAV, {gunStateAtImpact: {autoreloaderSurge: {abilityState: {state: 0, charges: 2, restrictions: 0}}}}),
    XHIT('x-breaker', 71, 'uk:GB152_AT_FV230_Breaker', XA()),
    XHIT('x-asxx', 72, 'france:F135_AS_XX_40_t', XA()),
    XHIT('x-amx67', 73, 'france:F136_AMX_67_Imbattable', XA()),
    XHIT('x-marked', 74, 'usa:Plain2', XA(), null, null, {designatorMark: {creatorID: 99, startTime: 495, endTime: 506}}),
    XHIT('x-marked-old', 74, 'usa:Plain2', XA(), null, null, {designatorMark: {creatorID: 99, startTime: 480, endTime: 490}})];
  const XROW = function (id, type) { return {id: id, name: type, type: type, team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000}; };
  const XBATTLE = {id: 'x1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 5000, defaultMaxHealth: 5000}]
      .concat([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74].map(function (id) { return XROW(id, 'x:' + id); })),
    hits: XHITS};
  const keepBattle = global.ArmorInspectorData.battle, keepScene = global.ArmorInspectorData.scene;
  global.ArmorInspectorData.battle = function (id) { return id === 'x1' ? Promise.resolve(XBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []});
  };
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const funBox = document.getElementById('fun-mode'), realBox = document.getElementById('real-reload');
  const star = document.getElementById('fun-mode-toggle'), sub = document.getElementById('real-reload-toggle');
  const mech = document.getElementById('aim-gun-mech'), bar = document.getElementById('target-hp');
  const setFun = function (want) { if (funBox.checked !== want) click(star); };
  const cb = document.getElementById('battles');
  cb.value = 'x1'; cb.onchange.call(cb);
  const prepare = function (view) {
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
  };
  const tap = function () { press(); release(); };
  // The Strv 107-12's touch and hold on the mode button (23.09): the left button's own down and up, `sec` apart.
  const holdMech = function (sec) { mech.onpointerdown({button: 0}); run(sec); mech.onpointerup({button: 0}); };
  const tapMech = function () { holdMech(0.1); };
  const keyW = function (down) { document.fire(down ? 'keydown' : 'keyup', {code: 'KeyW', key: 'w', target: document.body, preventDefault: function () {}}); };
  const openX = function (id) {
    const i = XHITS.findIndex(function (h) { return h.id === id; });
    document.getElementById('hits').children[i].onclick();
    return settle(20);
  };
  const lit = function () { return mech.getAttribute('aria-pressed') === 'true'; };
  const busy = function () { return mech.getAttribute('data-busy') === '1'; };
  const glow = function () { return mech.getAttribute('data-glow') === '1'; };
  const reloadFig = function () { return parseFloat(document.getElementById('aim-gun-reload').textContent); };
  const lastRoll = function () { const m = /Last shot: [a-z -]+, ([\d ]+) HP/.exec(bar.title || ''); return m ? Number(m[1].replace(/ /g, '')) : NaN; };
  let r0 = 0, rel0 = 0;
  // A fresh start of this hit: another hit first, so the mechanic starts over from this one's record.
  const fresh = function (id) { return openX('x-plain').then(function () { return openX(id); }); };
  return settle(20).then(function () {
    const view = viewerInstance; prepare(view); setFun(false); if (!realBox.checked) click(sub); run(20);
    r0 = view.liveRadius100; rel0 = reloadFig();
    ok('xi: (a plain vehicle on screen, ✸ off, the ring at rest)', r0 > 0 && rel0 > 0 && mech.hidden === true);
    setFun(true); run(1);
    ok('xi: a vehicle without a mechanic - no button under ✸ either, and its ring and reload as before',
       mech.hidden === true && near(view.liveRadius100 / r0, 1, 1e-9) && reloadFig() === rel0);
    setFun(false);
    return openX('x-szakal-turbo');
  }).then(function () {
    // CS-67 Szakal, recorded in the turbo stance (state bit 1), fight energy 40.
    const view = viewerInstance; prepare(view); setFun(false); run(20);
    ok('xi: ✸ OFF - no button on a tier-XI vehicle, and its ring is the recorded one', mech.hidden === true && near(view.liveRadius100 / r0, 1, 1e-9));
    tap(); const offBloom = view.liveRadius100 / r0;
    ok('xi: Szakal, ✸ OFF - a round blooms by afterShot 4 (×4.12), exactly as before', near(offBloom, Math.sqrt(17), 1e-9), '(' + offBloom.toFixed(4) + ')');
    run(20); setFun(true); run(1);
    ok('xi: Szakal, ✸ ON - the button is up with its glyph, LIT: the record’s stance is turbo, and the tooltip says it started from the record',
       mech.hidden === false && mech.textContent === '⇋' && lit() && /^CS-67 Szakal — stance\n• Now: turbo\n/.test(mech.title) && /\nStarted from the recorded state of this shot\.$/.test(mech.title)
       && mech.getAttribute('aria-label') === 'CS-67 Szakal: Stance', '(' + mech.title.slice(0, 80) + ')');
    tap(); const turbo = view.liveRadius100 / r0; run(1); const t1 = view.liveRadius100 / r0;
    ok('xi: turbo - the after-shot term ×1.66: the round blooms √(1 + 6.64²) = ×6.71 (×4.12 in the fight stance)', near(turbo, Math.sqrt(1 + 6.64 * 6.64), 1e-9), '(' + turbo.toFixed(4) + ')');
    const tauTurbo = 1 / Math.log(turbo / t1);
    run(20); click(mech);
    ok('xi: a press starts the switch - dashed, still turbo for its 3 s', busy() && lit());
    run(2.9);
    ok('xi: at 2.9 s it is still turbo', busy() && lit());
    run(0.2);
    ok('xi: at 3.1 s the fight stance takes over - not lit, not dashed', !busy() && !lit() && /\n• Now: fight\n/.test(mech.title));
    tap(); const fight = view.liveRadius100 / r0; run(1); const f1 = view.liveRadius100 / r0;
    const tauFight = 1 / Math.log(fight / f1);
    ok('xi: the fight stance blooms by afterShot 4 again (×4.12) and settles 1.9 times faster than turbo (aiming time ×1.9 in turbo)',
       near(fight, Math.sqrt(17), 1e-9) && near(tauTurbo / tauFight, 1.9, 1e-6), '(' + fight.toFixed(4) + ' / ' + (tauTurbo / tauFight).toFixed(4) + ')');
    run(20);
    return fresh('x-szakal-fight');
  }).then(function () {
    // Recorded in the fight stance with 94 energy: a damaging hit (+15) fills it at once.
    const view = viewerInstance; prepare(view); run(0.1);
    ok('xi: Szakal from its record - the fight stance, energy 94', !lit() && /\n• Fight energy: 9[4-9] \/ 100\n/.test(mech.title), '(' + mech.title.slice(0, 120) + ')');
    tap(); run(0.05);
    ok('xi: a round that deals damage adds 15 - 94 → 100, and the fight ability goes off at once (the gold ring)', glow() && /the fight ability on - 13 s left/.test(mech.title), '(' + mech.title.slice(0, 140) + ')');
    return fresh('x-szakal-fight');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    const ring = view.liveRadius100 / r0, rel = reloadFig();
    run(9.8);
    ok('xi: at rest the energy builds 0.6 a second - 9.8 s later no ability yet, the ring ×1', !glow() && near(view.liveRadius100 / r0, ring, 1e-9) && near(ring, 1, 1e-9));
    run(0.4);
    const relAbility = reloadFig();
    ok('xi: at 100 (10 s) the fight ability goes off - the gold ring, the reload ×0.8 at once (the panel’s figure)',
       glow() && near(relAbility / rel, 0.8, 0.012), '(' + rel + ' -> ' + relAbility + ')');
    run(10);
    const inAbility = view.liveRadius100 / r0;
    ok('xi: the circle falls to ×0.8 by the aiming time ×0.75, as the client lets it fall', near(inAbility, 0.8, 1e-3), '(' + inAbility.toFixed(5) + ')');
    run(3);
    ok('xi: 13 s later it is over - the circle ×1 and the reload back', !glow() && near(view.liveRadius100 / r0, 1, 1e-9) && reloadFig() === rel, '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    return openX('x-xm69');
  }).then(function () {
    // XM69 Hacker, no state recorded: the gyro ready.
    const view = viewerInstance; prepare(view); run(20);
    ok('xi: XM69 - its glyph, ready, not lit; the tooltip says no state was recorded', mech.textContent === '◎' && !lit() && !busy()
       && /No state of it is recorded for this shot: started from the default\./.test(mech.title));
    click(mech); run(0.05);
    const early = view.liveRadius100 / r0;
    run(3);
    ok('xi: a press switches the gyro on - lit, the full-aim circle falls to ×0.94 by an aiming time ×0.3', lit() && early < 1 && near(view.liveRadius100 / r0, 0.94, 1e-4),
       '(' + early.toFixed(4) + ' -> ' + (view.liveRadius100 / r0).toFixed(5) + ')');
    keyW(true); run(2);
    const driving = view.liveRadius100 / r0;
    keyW(false);
    ok('xi: driving under the gyro does not widen the circle - the movement term ×0', near(driving, 0.94, 1e-4) && parseFloat(speed.textContent) > 0, '(' + driving.toFixed(5) + ' / ' + speed.textContent + ')');
    run(4.9);
    ok('xi: still on at 9.9 s', lit());
    run(0.3);
    ok('xi: at 10 s it ends - the cooldown (dashed), the circle back to ×1', !lit() && busy() && near(view.liveRadius100 / r0, 1, 1e-9), '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    click(mech); run(0.1);
    ok('xi: a press during the cooldown does nothing', !lit() && busy());
    run(40);
    ok('xi: 40 s later it is ready again', !lit() && !busy());
    keyW(true); run(2); const bare = view.liveRadius100 / r0; keyW(false); run(20);
    ok('xi: (and without it the same drive widens the circle)', bare > 1.2, '(' + bare.toFixed(3) + ')');
    return openX('x-xm69-rec');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(3.8);
    ok('xi: XM69 from a record of the gyro on with 4 s left - lit from the start', lit() && near(view.liveRadius100 / r0, 0.94, 1e-9));
    run(0.4);
    ok('xi: and off 4 s later, into its cooldown', !lit() && busy());
    return openX('x-strv-siege');
  }).then(function () {
    // Strv 107-12 fired in the siege mode (siegeState 2): the siege block 0.0024 m, the pillbox on top of it. Since the second
    // modes (23.09) the button is the siege mode's own - lit in siege - with the client's touch and hold (TAP_TIME 0.25 s,
    // HOLD_TIME 1.0 s): a touch switches siege / travel, a hold of 1 s goes into the pillbox or out of it to travel.
    const view = viewerInstance; prepare(view); setFun(false); run(20);
    const rs = view.liveRadius100, relS = reloadFig();
    ok('xi: Strv 107-12, ✸ off - the siege shot’s ring is the siege block, as before (0.24 against 0.383)', near(rs / r0, 0.0024 / 0.00383, 1e-6));
    setFun(true); run(1);
    ok('xi: ✸ on - its glyph, LIT (the shot was fired in siege), no gold ring: not in the pillbox', mech.textContent === '▣' && lit() && !glow() && near(view.liveRadius100 / rs, 1, 1e-9));
    holdMech(1.05);
    ok('xi: held 1 s from the siege mode - into the pillbox, 3 s of switching, dashed', busy() && !glow());
    run(2.9);
    ok('xi: at 3.9 s still switching', busy() && !glow());
    run(0.2);
    const relP = reloadFig();
    run(15);
    ok('xi: in the pillbox - the gold ring, the siege circle ×0.85 (settled by its aiming time) and the reload ×0.925',
       glow() && !busy() && near(view.liveRadius100 / rs, 0.85, 1e-6) && near(relP / relS, 0.925, 0.012), '(' + (view.liveRadius100 / rs).toFixed(6) + ' / ' + relS + ' -> ' + relP + ')');
    keyW(true); run(2);
    ok('xi: the pillbox does not drive (maxSpeed ×0) - W leaves the speed at 0 and the circle as it was', /^0 km\/h/.test(speed.textContent) && near(view.liveRadius100 / rs, 0.85, 1e-6), '(' + speed.textContent + ')');
    keyW(false);
    tapMech(); run(3.1);
    ok('xi: a touch in the pillbox - back to siege in 3 s, the siege circle', lit() && !glow() && !busy() && near(view.liveRadius100 / rs, 1, 1e-9));
    holdMech(0.6); run(2);
    ok('xi: a press between 0.25 and 1 s does nothing (the client’s __onHoldCanceled)', lit() && !busy() && !glow());
    return openX('x-strv-drive');
  }).then(function () {
    // The same vehicle fired in travel: the pillbox takes 5 s and brings the siege block with it.
    const view = viewerInstance; prepare(view); run(20);
    ok('xi: Strv 107-12 fired in travel - the recorded (travel) block, the button not lit', near(view.liveRadius100 / r0, 1, 1e-9) && !lit());
    holdMech(1.02); run(4.85);
    ok('xi: held from travel the switch takes 5 s - at 4.9 s still the travel circle', busy() && near(view.liveRadius100 / r0, 1, 1e-9));
    run(0.2);
    const jump = view.liveRadius100 / r0;
    run(15);
    ok('xi: in the pillbox the siege descriptor’s block goes on at once (0.24 m) and the circle settles to ×0.85 of it',
       glow() && jump < 0.0024 / 0.00383 + 1e-9 && near(view.liveRadius100 / r0, 0.0024 / 0.00383 * 0.85, 1e-6), '(' + jump.toFixed(4) + ' -> ' + (view.liveRadius100 / r0).toFixed(5) + ')');
    holdMech(1.02); run(4.1);
    ok('xi: held in the pillbox - out to travel in 4 s', !lit() && !glow() && near(view.liveRadius100 / r0, 1, 1e-9));
    return openX('x-bork');
  }).then(function () {
    // leKpz Borkenkäfer: the designator arms the next round; the mark ×1.1 for 10 s; the cooldown 25 s from the round.
    const view = viewerInstance; prepare(view); run(20);
    ok('xi: Borkenkäfer - its glyph, ready', mech.textContent === '⊕' && !lit() && !busy() && !glow());
    click(mech);
    ok('xi: a press arms it (lit); a second one disarms it', lit() && (click(mech), !lit()) && (click(mech), lit()));
    tap(); run(0.05);
    const marking = lastRoll();
    ok('xi: the armed round marks the target (the gold ring), starts the 25 s cooldown - and rolls its own damage plain: 400',
       !lit() && busy() && glow() && marking === 400 && /\n• leKpz Borkenkäfer mark: 10 s left — every hit on it rolls ×1\.1 /.test(bar.title),
       '(' + marking + ' / ' + bar.title.slice(-160) + ')');
    run(9.8); tap(); run(0.05);
    ok('xi: a round on the marked target rolls ×1.1 - 440, and the bar says why', lastRoll() === 440 && /440 HP \(×1\.1: the target carries a Borkenkäfer mark\)/.test(bar.title), '(' + lastRoll() + ')');
    run(10.2); tap(); run(0.05);
    ok('xi: the mark is gone 10 s after the marking round - 400 again, no ring', lastRoll() === 400 && !glow() && busy());
    run(5);
    ok('xi: the cooldown ends 25 s after the marking round - ready', !busy() && !lit());
    return openX('x-bork-armed');
  }).then(function () {
    ok('xi: Borkenkäfer from a record of the designator armed (state 1) - lit from the start', lit() && !busy());
    return openX('x-hori');
  }).then(function () {
    // Ho-Ri Shugo with aim.secondary in the record: the rocket launcher 0.15 m, 60 s.
    const view = viewerInstance; prepare(view); run(20);
    const main = view.liveRadius100, relM = reloadFig(), shellBefore = document.getElementById('shell-choice').value;
    ok('xi: Ho-Ri Shugo - the ✦ button, the main gun in hand, its main-gun shell', mech.textContent === '✦' && !lit() && shellBefore === 'saved:0');
    click(mech); run(0.5);
    ok('xi: a press takes up the rocket launcher - lit, its ability-gun shell on screen, its circle (0.15 against 0.383 m)',
       lit() && document.getElementById('shell-choice').value === 'saved:2' && near(view.liveRadius100 / main, 0.0015 / 0.00383, 1e-6)
       && /\n• Second gun’s numbers: the record’s\n/.test(mech.title), '(' + (view.liveRadius100 / main).toFixed(4) + ')');
    ok('xi: its own reload - 60 s against the main gun’s 10 s, by the same factors', near(reloadFig() / relM, 6, 0.02), '(' + relM + ' -> ' + reloadFig() + ')');
    ok('xi: the gun panel says it is the second gun', /\nThis is the vehicle’s second gun, taken up with the ⌖ mode button\./.test(document.getElementById('aim-gun-reload').parentNode.title));
    click(mech); run(0.5);
    ok('xi: pressed again - the main gun, its shell and its circle back', !lit() && document.getElementById('shell-choice').value === 'saved:0' && near(view.liveRadius100 / main, 1, 1e-6));
    const p = view.pinnedPoints;
    tap(); run(3);
    click(mech); run(0.1); tap(); run(0.1);
    ok('xi: the main gun reloading, the rocket launcher is loaded and fires at once', view.pinnedPoints === p + 2);
    click(mech); run(0.1);
    const left = reloadFig();
    ok('xi: back on the main gun its reload has gone on in the background - about ' + (relM - 3.2).toFixed(1) + ' s left',
       near(left, relM - 3.2, 0.25) && document.getElementById('aim-gun-reload').getAttribute('data-running') === '1', '(' + left + ')');
    run(20);
    return openX('x-hori-slot1');
  }).then(function () {
    ok('xi: Ho-Ri from a hit its rocket launcher fired (slot 1) - the second gun in hand from the start', lit());
    return openX('x-tasch');
  }).then(function () {
    // Taschenratte without aim.secondary: the mortar's own XML figures - 2 rounds 0.5 s apart, 50 s.
    const view = viewerInstance; prepare(view); run(20);
    click(mech); run(0.5);
    ok('xi: Taschenratte, no aim.secondary in the record - the mortar’s stock figures, and the tooltip says so',
       lit() && /\n• Second gun’s numbers: stock, from the vehicle file \(not in this record\) - reload 50 s, aiming 1\.9 s, 0\.35 m at 100 m, 2 rounds 0\.5 s apart\n/.test(mech.title)
       && magStates() === 'on,next', '(' + magStates() + ' / ' + mech.title.slice(0, 200) + ')');
    const p = view.pinnedPoints;
    tap(); run(0.55);
    ok('xi: one press fires the mortar’s burst of two, 0.5 s apart - the magazine and the burst of the second gun', view.pinnedPoints === p + 2 && magStates() === 'fill,fill', '(' + (view.pinnedPoints - p) + ' / ' + magStates() + ')');
    click(mech); run(60);
    return openX('x-rock');
  }).then(function () {
    // The Black Rock: its burst only in the Burst mode, which the button switches.
    const view = viewerInstance; prepare(view); run(20);
    let p = view.pinnedPoints;
    tap(); run(3);
    ok('xi: Black Rock - the Burst mode off: one press, one round', mech.textContent === '»' && !lit() && view.pinnedPoints === p + 1);
    run(15); click(mech); run(0.1);
    p = view.pinnedPoints;
    tap(); const b1 = view.liveRadius100 / r0; run(1.55);
    ok('xi: the Burst mode on - one press fires the burst of 2, 1.5 s apart; the first round blooms by afterShotInBurst 2 (×2.24)',
       lit() && view.pinnedPoints === p + 2 && near(b1, Math.sqrt(5), 1e-9), '(' + (view.pinnedPoints - p) + ' / ' + b1.toFixed(4) + ')');
    run(15); keyW(true); run(2); const drive = view.liveRadius100 / r0; keyW(false);
    ok('xi: the Burst mode takes the movement terms ×0 - driving leaves the circle at rest', near(drive, 1, 1e-6), '(' + drive.toFixed(4) + ')');
    run(10); click(mech); run(15);
    p = view.pinnedPoints; tap(); run(3);
    ok('xi: switched off - one round a press again', !lit() && view.pinnedPoints === p + 1);
    run(15);
    return openX('x-rock-rec');
  }).then(function () {
    ok('xi: Black Rock from a record of the Burst mode on (isBurstActive) - lit from the start', lit());
    return openX('x-leo');
  }).then(function () {
    // Leopard 120 Verbessert, recorded at level 2: the full-aim circle ×(1 − 0.04 × level), a level every 5 s at rest.
    const view = viewerInstance; prepare(view); run(0.1);
    ok('xi: Leopard 120 V - level 2 from the record: lit, passive (no press), the circle ×0.92 in its tooltip', mech.textContent === '≡' && lit()
       && mech.getAttribute('data-passive') === '1' && mech.getAttribute('aria-disabled') === 'true' && /level 2 of 4 - the circle ×0\.92/.test(mech.title));
    const l2 = view.liveRadius100 / r0;
    run(5);
    ok('xi: 5 s at rest - level 3 (its timer wakes the loop), the circle narrower', /level 3 of 4 - the circle ×0\.88/.test(mech.title) && view.liveRadius100 / r0 < l2, '(' + l2.toFixed(4) + ' -> ' + (view.liveRadius100 / r0).toFixed(4) + ')');
    run(35);
    ok('xi: at the cap, level 4, the circle settles at ×(1 − 0.04 × 4) = ×0.84', /level 4 of 4/.test(mech.title) && near(view.liveRadius100 / r0, 0.84, 1e-6), '(' + (view.liveRadius100 / r0).toFixed(6) + ')');
    click(mech);
    ok('xi: a press does nothing on a passive mechanic', /level 4 of 4/.test(mech.title));
    tap(); run(0.05);
    ok('xi: a round takes the stacks away (levelAfterShot 0)', !lit() && /level 0 of 4/.test(mech.title));
    run(4.8);
    ok('xi: and they build again at rest - still 0 at 4.85 s', /level 0 of 4/.test(mech.title));
    run(0.3);
    ok('xi: level 1 at 5 s', /level 1 of 4/.test(mech.title) && lit());
    return openX('x-t803');
  }).then(function () {
    // T803, recorded at fury level 3: the reload ×(1 − 0.02 × level); a level lost every 9.5 s; +1 a damaging hit.
    const view = viewerInstance; prepare(view); setFun(false); run(1);
    const relOff = reloadFig();
    setFun(true); run(0.1);
    ok('xi: T803 - fury level 3 from the record: the reload ×0.94', mech.textContent === '⇈' && lit() && near(reloadFig() / relOff, 0.94, 0.012), '(' + relOff + ' -> ' + reloadFig() + ')');
    run(9.5);
    ok('xi: 9.5 s later a level is gone - ×0.96', /level 2 of 5/.test(mech.title) && near(reloadFig() / relOff, 0.96, 0.012), '(' + reloadFig() + ')');
    tap(); run(0.05);
    ok('xi: a damaging round adds a level - 3 again', /level 3 of 5/.test(mech.title));
    return openX('x-cav');
  }).then(function () {
    // CAV mod. 71: 2 charges from the record; a press puts the round loading back on 8.5 s instead of its 10 s.
    const view = viewerInstance; prepare(view); if (!realBox.checked) click(sub); run(0.5);
    const k = reloadFig() / 16;
    const loaded = function () { return magStates().split(',').filter(function (x) { return x === 'on' || x === 'next' || x === 'wait'; }).length; };
    ok('xi: CAV mod. 71 - 2 charges from the record, a full magazine', mech.textContent === '↯' && /2 of 3 charges/.test(mech.title) && loaded() === 4);
    click(mech);
    ok('xi: a press with nothing loading does nothing', /2 of 3 charges/.test(mech.title));
    tap(); run(1);
    click(mech);
    ok('xi: a press while a round loads back spends a charge - lit while the surged round loads', /1 of 3 charges/.test(mech.title) && lit());
    const t0 = clock; let t = -1;
    for (let i = 0; i < 400 && t < 0; i++) { tick(0.05); if (loaded() === 4) t = clock - t0; }
    const expect = (1 - 1 / (10 * k)) * 8.5 * k;
    ok('xi: the round loads in 8.5 s × k (with the second it had done) instead of 10 s × k', near(t, expect, 0.1), '(' + t.toFixed(2) + ' s against ' + expect.toFixed(2) + ', k ' + k.toFixed(3) + ')');
    return openX('x-breaker');
  }).then(function () {
    ok('xi: Breaker - the button is there, dimmed, and says why it does nothing: blocked until a battle shows what ×2.0 doubles',
       mech.hidden === false && mech.textContent === '⇶' && mech.getAttribute('aria-disabled') === 'true' && mech.getAttribute('data-passive') === '0'
       && /blocked until a battle on the Breaker shows it/.test(mech.title) && (click(mech), !lit()));
    return openX('x-asxx');
  }).then(function () {
    const as = mech.title;
    return openX('x-amx67').then(function () {
      ok('xi: AS-XX 40 t and AMX 67 - dimmed, the client’s numbers named, and why the rule is not run',
         /\n• Delays: preparing 4\.5 s, finishing 3 s /.test(as) && /\n• Not emulated: /.test(as) && /\n• Extra-shot reload: 4\.5 s /.test(mech.title) && /\n• Not emulated: /.test(mech.title) &&mech.getAttribute('aria-disabled') === 'true');
    });
  }).then(function () {
    setFun(false); run(1);
    ok('xi: ✸ off - the button goes on a tier-XI vehicle too', mech.hidden === true);
    return openX('x-marked');
  }).then(function () {
    // BACKLOG 38 through the page: a plain shooter's hit on a target the record shows marked, 6 s left at the hit.
    const view = viewerInstance; prepare(view); setFun(false); run(1);
    const title = document.getElementById('shot-panel').title;
    ok('mark: the hit-line panel says the target was marked at this hit - ×1.1 … ×1.15, the HP of this shell, the window of the shell choice',
       /\n\n• leKpz Borkenkäfer mark: on the target at this hit, 6 s left\n• Mark damage: every shell ×1\.1 \(×1\.15 with the marker’s full skill tree, which the record cannot tell\) - 440…460 HP for this shell’s 400\n• Shares here: of the plain alpha, so they stand$/.test(title),
       '(' + title.slice(-360) + ')');
    ok('mark: ✸ off - no button, no roll', mech.hidden === true);
    setFun(true); run(0.1); tap(); run(0.05);
    ok('mark: ✸ on - a round on the recorded mark rolls ×1.1: 440', lastRoll() === 440 && /the record’s, at this hit/.test(bar.title), '(' + lastRoll() + ')');
    run(10); tap(); run(0.05);
    ok('mark: its 6 s run out - 400', lastRoll() === 400);
    setFun(false);
    return openX('x-marked-old');
  }).then(function () {
    const view = viewerInstance; prepare(view);
    ok('mark: a mark that ended before the hit - nothing said', !/Borkenkäfer/.test(document.getElementById('shot-panel').title));
    setFun(true); run(0.1); tap(); run(0.05);
    ok('mark: and the roll is plain', lastRoll() === 400);
    setFun(false); run(1);
    CTX.resolve = keepResolve; delete CTX.markOf;
    global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.scene = keepScene;
    delete window.BullbaHitsRng;
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- TTX (23.09): the characteristics panel ------------------------------------------------------------------
  // web/ttx.js is pure and runs here as it is; the panel in the bottom-right corner is driven through the page:
  // hidden without a characteristics file, the compact list from a fixture file, ⚙ stock / build, the pair
  // picker, Mag Mastery on the magazine reload, the expanded view, the layout pass, never a call from a frame.
  // The IS-7 fixture carries the client's own XML figures of ussr:R45_IS-7 (outputs/ttx-formulas-2026-09-22.md
  // section 10), and its stock must print exactly the strings that section works out.
  const TX = window.BullbaTtx, D = Math.PI / 180;
  ok('ttx: web/ttx.js is loaded before app.js and exports its pure functions',
     !!TX && ['values', 'display', 'better', 'compare', 'match', 'pairKey', 'pairIndex', 'groups', 'dr', 'rp', 'nice', 'integral', 'ceilTo']
       .every(function (k) { return typeof TX[k] === 'function'; })
     && pageSrc.indexOf('<script src="web/ttx.js"></script><script src="web/app.js"></script>') > 0);
  ok('ttx: decimal_round is half-up on the shortest decimal form - 26.074999999999996 is 26.07, 2.675 is 2.68, 0.3835 to 4 places stays',
     TX.dr(26.074999999999996, 2) === 26.07 && TX.dr(2.675, 2) === 2.68 && TX.dr(0.38350381, 4) === 0.3835
     && TX.dr(9.995, 2) === 10 && TX.dr(-1.005, 2) === -1.01 && TX.dr(1e-7, 2) === 0 && TX.dr(3.306, 2) === 3.31);
  ok('ttx: round_py2_style takes a half away from zero; getIntegralFormat truncates; nice drops trailing zeros',
     TX.rp(2.5) === 3 && TX.rp(-2.5) === -3 && TX.integral(1199.9) === '1199' && TX.nice(17.6) === '17.6' && TX.nice(400) === '400' && TX.nice(null) === '—');
  ok('ttx: hit points with a health factor go UP to whole tens after the client’s decimal_round (ceilTo)',
     TX.ceilTo(2400 * 1.08, 1) === 2600 && TX.ceilTo(2590.4, 1) === 2590 && TX.ceilTo(2591, 1) === 2600);
  ok('ttx: which way is better - less for the reload, the dispersion, the aiming, the stabilisation, the terrain and the mass',
     ['reload', 'shotDispersionAngle', 'aimingTime', 'stabMovement', 'terrainResistance', 'vehicleWeight'].every(function (k) { return TX.better(k) === -1; })
     && ['avgDamagePerMinute', 'turretRotationSpeed', 'speedLimits', 'circularVisionRadius', 'maxHealth'].every(function (k) { return TX.better(k) === 1; }));

  const IS7_AIM = {dispersion: Math.atan(0.004), aimingTime: 2.9, reloadTime: 13.7, clip: [1, 0], reloadTimeFactor: 1,
    multFactor: 1, additiveFactor: 1, aimingTimeFactor: 1, turretRotationSpeed: 25 * D, hullRotationSpeed: 28 * D,
    speedForward: 59.6 * 0.27778, speedBackward: 15 * 0.27778, movementFactor: 0.18 / 0.27778, rotationFactor: 0.18 / D,
    turretRotationFactor: 0.1 / D, afterShotFactor: 4, gunTags: [], aimFrom: 'compact',
    crewRoles: [['commander'], ['gunner'], ['driver'], ['radioman', 'loader'], ['loader']]};
  const IS7 = {schema: 1, id: 'ussr-R45_IS-7', type: 'ussr:R45_IS-7', clientVersion: 'test',
    vehicle: {invisibility: [0.058, 0.116], camouflageBonus: 0.02, projectileSpeedFactor: 0.8,
              optDevsOverrides: {camouflageNet: {invisibilityBonus: [0.05, 0.075]}, additionalInvisibilityDevice: {invisibilityBonus: [0.03, 0.04]}},
              modes: {siege: false, wheeled: false, onSpotRotation: true}},
    modules: {chassis: {name: 'Chassis_R45_IS-7', level: 10, terrainResistance: [1.1, 1.3, 2.3], maxSteeringLockAngle: null},
              engine: {name: 'V-16ST', level: 10, power: 1200 * 735.5}},
    turrets: [{name: 'Turret_1_IS-7', userString: 'IS-7', level: 10, circularVisionRadius: 400, invisibilityFactor: 1}],
    shells: {_130mm_S_70: [{kind: 'ARMOR_PIERCING', name: 'BR-482B', caliber: 130, alpha: 490, penetration100: 250, penetration500: 244,
                            speed: 900 * 0.8, damageRandomization: 0.25, randomization: 0.25},
                           {kind: 'HIGH_EXPLOSIVE', name: 'OF-482', caliber: 130, alpha: 640, penetration100: 65, penetration500: 65,
                            speed: 900 * 0.8, damageRandomization: 0.25, randomization: 0.25}]},
    configs: [{turret: 0, gun: '_130mm_S_70', gunUserString: '130 mm S-70', gunLevel: 10, top: true, aim: IS7_AIM,
               maxHealth: 2400, weight: 68190, maxAmmo: 30, invisibilityFactorAtShot: 0.153, turretYawLimits: null,
               pitch: {absolute: [-18 * D, 6 * D], minPitch: [[0, -18 * D], [1, -18 * D]], maxPitch: [[0, 6 * D], [1, 6 * D]]}}],
    warnings: []};
  // The page's own crew law for this crew: the commander 1.0, everybody else 1.043.
  const is7v = TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: IS7.shells._130mm_S_70,
                          crew: {commander: 1, gunner: 0.57 + 0.43 * 1.1, driver: 0.57 + 0.43 * 1.1, radioman: 0.57 + 0.43 * 1.1, loader: 0.57 + 0.43 * 1.1, camouflage: 0.57}});
  const is7 = TX.display(is7v);
  const A10 = {maxHealth: '2400', vehicleWeight: '68.19', enginePower: '1200', enginePowerPerTon: '17.6', speedLimits: '59.6/15',
    chassisRotationSpeed: '29.2', turretRotationSpeed: '26.07', shotsPerMinute: '4.57', reloadTimeSecs: '13.14',
    avgDamagePerMinute: '2238', aimingTime: '2.78', shotDispersionAngle: '0.38', pitchLimits: '-6/18',
    circularVisionRadius: '400', invisibilityStillFactor: '6.61', invisibilityMovingFactor: '3.31', invisibilityAfterShot: '1.01'};
  const is7bad = Object.keys(A10).filter(function (k) { return is7[k] !== A10[k]; });
  ok('ttx: IS-7 stock prints every figure of ttx-formulas section 10 - HP, weight, power, speed, hull, turret, rate, reload, DPM, aiming, dispersion, VN, view, concealment',
     is7bad.length === 0, is7bad.map(function (k) { return k + ' ' + is7[k] + ' (want ' + A10[k] + ')'; }).join(', '));
  // The file the mod itself writes for the IS-7 (phase 1, built offline under the client's own items.vehicles), when
  // it is on this machine: the same strings, through the same functions, from the real shape (float32 figures,
  // optDevsOverrides as {values}, the crew of the record).
  const REAL = process.env.BULLBA_TTX_SAMPLE || HERE + '../fixtures-local/ttx-offline/out/mod/ttx/ussr-R45_IS-7.js';
  if (fs.existsSync(REAL)) {
    let real = null;
    new Function('ArmorInspectorData', fs.readFileSync(REAL, 'utf8'))({receive: function (x) { real = x[1]; }});
    const rp0 = real.configs[0], f = 0.57 + 0.43 * 1.1;
    const rd = TX.display(TX.values({ttx: real, pair: rp0, aim: rp0.aim, shells: rp0.shells || real.shells[rp0.gun],
                                     crew: {commander: 1, gunner: f, driver: f, radioman: f, loader: f, camouflage: 0.57}}));
    const rbad = Object.keys(A10).filter(function (k) { return rd[k] !== A10[k]; });
    ok('ttx: the IS-7 file the mod writes prints the same seventeen figures', real.schema === 1 && rbad.length === 0,
       rbad.map(function (k) { return k + ' ' + rd[k]; }).join(', '));
    // Survivability (23.09): the file carries the hull's and the turret's armour and the suspension's repair time; the
    // client's own strings for the IS-7 (tools/ttx_reference.py): 150/150/100, 240/185/94, 12.03 s - XML 6.857 s / 0.57,
    // the Repairs group skill nobody has, whatever the crew's level (the client's fire build with rations: 12.03 too).
    const fed = TX.display(TX.values({ttx: real, pair: rp0, aim: rp0.aim, shells: [], crew: {commander: 1.1, gunner: 1.1, driver: 1.1, radioman: 1.1, loader: 1.1, camouflage: 0.57}}));
    ok('ttx: Survivability of the IS-7 file - hull 150/150/100, turret 240/185/94, suspension 12.03 s, as the client prints them, and no crew level moves the repair',
       real.armorSchema === 1 && rd.hullArmor === '150/150/100' && rd.turretArmor === '240/185/94' && rd.chassisRepairTime === '12.03'
       && fed.chassisRepairTime === '12.03', [rd.hullArmor, rd.turretArmor, rd.chassisRepairTime, fed.chassisRepairTime].join(' '));
    // A turret that is only the hull's fake one has no line (the garage's None); two track pairs print in the garage's
    // REVERSED order (the M-VI-Yoh: the file's 5.29 / 6.86 s -> 12.03/9.29); a file of before 23.09 has none of them.
    const fake = Object.assign({}, real, {vehicle: Object.assign({}, real.vehicle, {hasTurret: false}),
                                          modules: Object.assign({}, real.modules, {chassis: Object.assign({}, real.modules.chassis, {repairTime: [5.2941179275512695, 6.857142925262451]})})});
    const fd = TX.display(TX.values({ttx: fake, pair: rp0, aim: rp0.aim, shells: []}));
    const od = TX.display(TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: []}));
    ok('ttx: no turret armour on a fake turret, two track pairs in the garage\'s reversed order, and dashes from a file of before 23.09',
       fd.turretArmor === '—' && fd.hullArmor === '150/150/100' && fd.chassisRepairTime === '12.03/9.29'
       && od.hullArmor === '—' && od.turretArmor === '—' && od.chassisRepairTime === '—' && TX.better('chassisRepairTime') === -1 && TX.better('hullArmor') === 1,
       [fd.turretArmor, fd.chassisRepairTime, od.hullArmor].join(' '));
  } else console.log('SKIP (the mod’s IS-7 file is not on this machine: ' + REAL + ')');
  ok('ttx: the stabilisation factors are shown in the players’ units - per km/h and per degree a second',
     is7.stabMovement === '0.18' && is7.stabRotation === '0.18' && is7.stabTurret === '0.1' && is7.stabAfterShot === '4');
  ok('ttx: the shell table - average damage, the damage range, penetration and the garage’s velocity (speed / projectileSpeedFactor)',
     is7v.shells.length === 2 && is7v.shells[0].avgDamage === 490 && is7v.shells[0].damage.join('-') === '368-612'
     && is7v.shells[0].avgPiercingPower === 250 && Math.abs(is7v.shells[0].shellVelocity - 900) < 1e-9 && is7v.shells[0].selected === true
     && is7v.shells[1].dpm === Math.round(60 / (13.7 / (0.57 + 0.43 * 1.1)) * 640));
  // Concealment: the whole crew with the skill gives 1.0344 - the XML figure within rounding - and the paint its bonus.
  const hid = TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: [], paint: true,
                         crew: {commander: 1, gunner: 1.043, driver: 1.043, radioman: 1.043, loader: 1.043, camouflage: 1.0344}});
  ok('ttx: Concealment on the whole crew and the paint: (0.116 x 1.0344 + 0.02) x 100 standing',
     Math.abs(hid.invisibilityStillFactor - (0.116 * 1.0344 + 0.02) * 100) < 1e-9);
  // The net only standing and never on top of the exhaust: the larger of the two, the vehicle's own figures.
  const NET = {id: 'camouflageNet_tier2', eff: {invisibilityStill: ['add', 0.15, 0.175]}, override: {invisibilityStill: 'camouflageNet'}};
  const EXH = {id: 'additionalInvisibilityDevice_tier1', eff: {invisibilityAdd: ['add', 0.06, 0.08]}, override: {invisibilityAdd: 'additionalInvisibilityDevice'}};
  const both = TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: [], crew: {camouflage: 0.57},
                          fx: {dev: {}, devAdd: {invisibilityStill: 0.175, invisibilityAdd: 0.08}, perk: {}, perkAdd: {}, weight: 150, devices: [NET, EXH]}});
  ok('ttx: net and exhaust - the vehicle’s own 0.075 and 0.04, the net only standing and only by what it gives over the exhaust',
     Math.abs(both.invisibilityStillFactor - (0.116 * 0.57 + 0.075) * 100) < 1e-9
     && Math.abs(both.invisibilityMovingFactor - (0.058 * 0.57 + 0.04) * 100) < 1e-9 && Math.abs(both.vehicleWeight - 68.34) < 1e-9);
  // Grousers and the driver make the hull turn faster through the terrain factor; Off-Road Driving brings soft down to medium.
  const grip = TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: [], crew: {driver: 1.043},
                          fx: {dev: {terrainResistance: 0.869}, devAdd: {}, perk: {mediumGround: 0.05, softGround: 1}, perkAdd: {}, weight: 0, devices: []}});
  ok('ttx: grousers speed the hull through the mean terrain factor, Off-Road Driving takes the medium ground ÷1.05 and the soft one down to it',
     Math.abs(grip.chassisRotationSpeed - 28 / (1 / 1.043 * 0.869)) < 1e-9
     && Math.abs(grip.terrainResistance[1] - 1.3 / 1.05 / 1.043 * 0.869) < 1e-9 && Math.abs(grip.terrainResistance[2] - grip.terrainResistance[1]) < 1e-12);
  // The perks come after the rounding of the devices, their deviations summed (params 1472).
  const perks = TX.values({ttx: IS7, pair: IS7.configs[0], aim: IS7_AIM, shells: [], crew: {gunner: 1.043},
                           fx: {dev: {turretRotationSpeed: 1.1}, devAdd: {}, perk: {turretRotationSpeed: 0.025}, perkAdd: {}, weight: 0, devices: []}});
  ok('ttx: the turret is rounded to 2 places with the devices, and Quick Aiming multiplies that rounded figure',
     perks.turretRotationSpeed === TX.dr(25 * D * (1.043 * 1.1) * (180 / Math.PI), 2) * 1.025);
  // Pair matching (spec 3.1): by the XML names, else the gun's short name (top first), else the top pair.
  const TWO = {configs: [{turret: 0, gun: 'a', gunUserString: 'A gun', top: false}, {turret: 1, gun: 'a', gunUserString: 'A gun', top: true},
                         {turret: 1, gun: 'b', gunUserString: 'B gun', top: false}],
               turrets: [{name: 'T1', level: 8}, {name: 'T2', level: 9}]};
  ok('ttx: the recorded pair - by gunName and turretName, else by the short name preferring the top pair, else the top pair',
     TX.match(TWO, {gunName: 'a', turretName: 'T1'}) === 0 && TX.match(TWO, {gun: 'A gun'}) === 1 && TX.match(TWO, {gun: 'B gun'}) === 2
     && TX.match(TWO, {}) === 1 && TX.pairKey(TWO, 2) === 'T2|b' && TX.pairIndex(TWO, 'T1|a') === 0
     && TX.groups(TWO).map(function (g) { return g.pairs.join(''); }).join(',') === '0,12');

  // ---- through the page ----------------------------------------------------------------------------------------
  const CLIP_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 9, clip: [3, 2]});
  const SINGLE2_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 7, clip: [1, 0]});
  const CLIPX = {schema: 1, id: 'germany-ClipX', type: 'germany:ClipX',
    vehicle: {invisibility: [0.1, 0.2], camouflageBonus: 0.03, projectileSpeedFactor: 0.8, modes: {}},
    modules: {chassis: {terrainResistance: [1, 1.2, 2]}, engine: {power: 600 * 735.5}},
    turrets: [{name: 'TurretX', userString: 'Turret X', level: 8, circularVisionRadius: 380, invisibilityFactor: 1}],
    shells: {_105_single: [{kind: 'ARMOR_PIERCING', name: 'AP shell', caliber: 105, alpha: 400, penetration100: 250, speed: 800}],
             _105_clip: [{kind: 'ARMOR_PIERCING', name: 'AP shell', caliber: 120, alpha: 400, penetration100: 250, speed: 800}]},
    configs: [{turret: 0, gun: '_105_single', gunUserString: '105 mm single', gunLevel: 8, top: true, aim: SINGLE2_AIM, maxHealth: 1500, weight: 40000,
               pitch: {absolute: [-20 * D, 8 * D]}, invisibilityFactorAtShot: 0.2},
              {turret: 0, gun: '_105_clip', gunUserString: '120 mm clip', gunLevel: 8, top: false, aim: CLIP_AIM, maxHealth: 1500, weight: 40500,
               pitch: {absolute: [-20 * D, 8 * D]}, invisibilityFactorAtShot: 0.2}]};
  const TPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const THIT = function (id, attacker) {
    return {id: id, attackerId: 40, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: Object.assign({parts: TPARTS(), gunDispersion: 0.00383}, attacker),
            target: {name: 'Beta', type: 'germany:Beta', parts: TPARTS(), maxHealth: 1850}, warnings: []};
  };
  // No roster at all: the health of the vehicle on screen comes from its own export (targetMaxHp, 23.09).
  const TBATTLE = {id: 't1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    hits: [THIT('t-is7', {name: 'IS-7', type: 'ussr:R45_IS-7', gun: '130 mm S-70', aim: IS7_AIM}),
           THIT('t-clip', {name: 'ClipX', type: 'germany:ClipX', gun: '120 mm clip', aim: CLIP_AIM}),
           THIT('t-none', {name: 'NoFile', type: 'germany:NoFile', aim: SINGLE2_AIM})]};
  global.ArmorInspectorData.battle = function (id) { return id === 't1' ? Promise.resolve(TBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) {
    return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []});
  };
  const FIXTURES = {'ussr-R45_IS-7': IS7, 'germany-ClipX': CLIPX};
  let ttxReads = 0;
  const ttxLoader = function (id) { ttxReads++; return FIXTURES[id] ? Promise.resolve(FIXTURES[id]) : Promise.reject(new Error('Not found data/ttx/' + id + '.js')); };
  const tb = document.getElementById('battles');
  tb.value = 't1'; tb.onchange.call(tb);
  const panel = document.getElementById('ttx-panel'), buildBox = document.getElementById('ttx-build');
  const buildToggle = document.getElementById('ttx-build-toggle'), pairsBox = document.getElementById('ttx-pairs');
  const pairTile = document.getElementById('ttx-pair'), more = document.getElementById('ttx-more'), full = document.getElementById('ttx-full');
  const compact = document.getElementById('ttx-compact');
  const hpSlot = document.getElementById('ttx-hp');
  const rowOf = function (slot) {
    if (slot === 'reload') return centreOf(compact);
    if (slot === 'maxHealth') return hpSlot.children[0] || null;
    return ttxRowsIn(compact).filter(function (r) { return r.getAttribute('data-key') === slot && !(r.parentNode && r.parentNode.getAttribute('data-side')); })[0] || null;
  };
  // The reload line of a view and its centre part (the reload itself).
  const lineIn = function (el) { return ttxFind(el, function (c) { return c.className === 'ttx-reload'; })[0] || null; };
  const centreOf = function (el) { const l = lineIn(el), c = l && l.children.filter(function (x) { return x.getAttribute('data-side') === 'center'; })[0]; return c ? c.children[0] || null : null; };
  const val = function (slot) { const r = rowOf(slot); return r ? r.ttx.value.textContent : null; };
  const glyphOf = function (slot) { const r = rowOf(slot); return r ? r.ttx.glyph : null; };
  const keyOf = function (slot) { const r = rowOf(slot); return r ? r.getAttribute('data-key') : null; };
  const lineText = function (el) { return ttxLineOf(lineIn(el)).map(function (p) { return p.side[0] + ':' + p.key + '=' + p.text; }).join(' '); };
  const fullRows = function () {
    const out = {};
    ttxRowsIn(full).forEach(function (r) { if (!(r.parentNode && r.parentNode.getAttribute('data-side'))) out[r.getAttribute('data-key')] = r.ttx.value.textContent; });
    return out;
  };
  return settle(20).then(function () {
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    ok('ttx: without the loader of characteristics files (an older page data layer) the panel is hidden',
       panel.hidden === true && document.getElementById('shooter-tile').hidden === false);
    global.ArmorInspectorData.ttx = ttxLoader;
    document.getElementById('hits').children[2].onclick();
    return settle(20);
  }).then(function () {
    ok('ttx: a vehicle with no characteristics file - the panel is hidden and the rest of the scene is as it was',
       panel.hidden === true && ttxReads === 1 && document.getElementById('shooter-tile').hidden === false
       && document.getElementById('aim-gun').hidden === false);
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    const want = {avgDamagePerMinute: '2238', reload: '13.14', maxHealth: '2400', shotDispersionAngle: '0.38', aimingTime: '2.78',
                  turretRotationSpeed: '26.07', hull: '29.2', speedLimits: '59.6/15', enginePowerPerTon: '17.6',
                  stabMovement: '0.18', stabRotation: '0.18', stabTurret: '0.1',
                  circularVisionRadius: '400', invisibilityStillFactor: '6.61', invisibilityMovingFactor: '3.31'};
    const bad = Object.keys(want).filter(function (k) { return val(k) !== want[k]; });
    ok('ttx: IS-7 with its file - the panel shows, and the compact list prints the stock of ttx-formulas section 10',
       panel.hidden === false && bad.length === 0, bad.map(function (k) { return k + ' ' + val(k); }).join(', '));
    // The compact view, the user's layout of 24.09 (TTX_COMPACT): the HP in the head; Firepower - the DPM first, the
    // reload sector beside it, then dispersion and aiming right above the stabilisation three; Mobility - the speed and
    // the specific power, then the hull and the turret; Concealment's three (view range, standing, moving). A line of
    // rows is a box of its own, which starts a row of the view's grid (style.css .ttx-body).
    const secs = compact.children, keysOf = function (box) { return box && box.className === 'ttx-rows' ? box.children.map(function (r) { return r.getAttribute('data-key'); }).join() : null; };
    const layout = secs.map(function (sec) { return sec.getAttribute('data-group') + '[' + sec.children.map(function (c) { return c.className === 'ttx-rows' ? keysOf(c) : c.className; }).join(' | ') + ']'; }).join(' ');
    ok('ttx 24.09: the compact view - Firepower (the DPM first, the reload line after it, dispersion and aiming, the stabilisation three), Mobility (speed and specific power; the hull and the turret), Concealment (view range; standing and moving); the HP in the head; glyphs and figures only',
       layout === 'relativePower[ttx-rule | avgDamagePerMinute | ttx-reload | shotDispersionAngle,aimingTime | stabMovement,stabTurret | stabRotation] '
         + 'relativeMobility[ttx-rule | speedLimits,turretRotationSpeed | enginePowerPerTon,hull] relativeCamouflage[ttx-rule | circularVisionRadius,invisibilityStillFactor | ,invisibilityMovingFactor]'
       && rowOf('maxHealth').getAttribute('data-key') === 'maxHealth' && rowOf('maxHealth').ttx.glyph === 'maxHealth'
       && ttxRowsIn(compact).concat([rowOf('maxHealth')]).every(function (r) { return r.children.length === 2 && r.children[0].className === 'ttx-icon'; }),
       layout);
    const ruled = secs;
    ok('ttx v2: a section is a thin rule with the group\'s glyph and no word; its name (the garage\'s own) is the rule\'s tooltip',
       ruled.length === 3 && ruled.every(function (sec) { const r = sec.children[0]; return r.className === 'ttx-rule' && r.children.length === 1 && r.children[0].className === 'ttx-icon' && r.children[0].getAttribute('data-glyph') === sec.getAttribute('data-group') && !r.textContent; })
       && /^Firepower\nThe garage’s own group/.test(ruled[0].children[0].title) && /^Mobility\n/.test(ruled[1].children[0].title)
       && /^Concealment and spotting\nThe garage’s two groups in one row/.test(ruled[2].children[0].title)
       && ruled[0].children[0].getAttribute('role') === 'separator' && ruled[0].children[0].getAttribute('aria-label') === 'Firepower');
    ok('ttx 24.09: Concealment in the compact view - the garage\'s view range and concealment, standing with its figure after a shot in the tooltip',
       /^View range, standing, m\n• Stock: 400\n\n• Moving: 400 m/.test(rowOf('circularVisionRadius').title)
       && /^Concealment standing, %\n• Stock: 6\.61\n\n• After a shot: 1\.01 %$/.test(rowOf('invisibilityStillFactor').title)
       && /^Concealment moving, %\n• Stock: 3\.31$/.test(rowOf('invisibilityMovingFactor').title),
       rowOf('invisibilityStillFactor').title);
    ok('ttx v2: a single-shot gun\'s reload line is one figure in its middle - Gun Loading, 13.14',
       lineText(compact) === 'c:reloadTimeSecs=13.14' && glyphOf('reload') === 'reload', lineText(compact));
    ok('ttx: the stock by default - ⚙ is off, no colours, and the tooltip names the stock and where the figure comes from',
       buildBox.checked === false && buildToggle.getAttribute('aria-pressed') === 'false' && rowOf('reload').getAttribute('data-cmp') === null
       && /^Gun loading, s\n• Stock: 13\.14\n/.test(rowOf('reload').title) && !/as the garage shows a bare vehicle|characteristics file/.test(rowOf('reload').title)
       && /^Stock or this build\n• Off: the stock, as the garage shows a bare vehicle - [^\n]*no equipment, directive, consumables, paint or field modification\n• On: /.test(buildToggle.title)
       && !/not modelled/.test(rowOf('reload').title));
    ok('ttx v2: the HP in the head carry the Hit points tooltip, stock 2400',
       /^Hit points, HP\n• Stock: 2400$/.test(rowOf('maxHealth').title), rowOf('maxHealth').title.slice(0, 60));
    ok('ttx: one pair - the tile is plainly the gun: its glyph, the calibre and the gun\'s tier, with no ▾ and nothing to open',
       pairsBox.getAttribute('data-many') === 'false' && pairTile.children[0].getAttribute('data-glyph') === 'gun' && pairTile.children[1].textContent === '130'
       && pairTile.children[2].textContent === 'X' && /^Gun: 130 mm S-70\nThe shooter’s gun: this panel, the ⌖ circle, the reload and the shells follow it\.\n• Calibre: 130 mm\n• Tier: X\n• Turret: IS-7\n\nThis turret carries no other gun\.$/.test(pairTile.title), pairTile.title);
    // The expanded view is built by the click that opens it.
    document.getElementById('ttx-more-button').onclick({}); more.open = true;
    const f = fullRows();
    ok('ttx: ▴ opens everything else - weight, power, HP, VN, view range, concealment, in rows of the same widget',
       f.maxHealth === '2400' && f.vehicleWeight === '68.19' && f.enginePower === '1200' && f.pitchLimits === '-6/18'
       && f.circularVisionRadius === '400' && f.invisibilityStillFactor === '6.61' && f.invisibilityMovingFactor === '3.31'
       && f.invisibilityAfterShot === '1.01' && f.maxAmmo === '30' && f.shotsPerMinute === '4.57', JSON.stringify(f));
    // Survivability (23.09): the garage's whole group in its order under its rule. This fixture is a file as a mod of
    // before 23.09 wrote it (no armour, no repair): dashes, the tooltip says why, and nothing is coloured.
    const armSec = full.children.filter(function (s) { return s.getAttribute('data-group') === 'relativeArmor'; })[0];
    const armRows = armSec ? ttxRowsIn(armSec) : [];
    ok('ttx: Survivability in the expanded view - HP, hull armour, turret armour, suspension repair, in the garage\'s order with their own glyphs; a file of before 23.09 shows dashes and says why',
       armRows.map(function (r) { return r.getAttribute('data-key') + ':' + r.ttx.glyph; }).join() === 'maxHealth:maxHealth,hullArmor:hullArmor,turretArmor:turretArmor,chassisRepairTime:chassisRepairTime'
       && f.hullArmor === '—' && f.turretArmor === '—' && f.chassisRepairTime === '—'
       && armRows.slice(1).every(function (r) { return /written before the armour and the suspension’s repair were added/.test(r.title) && r.getAttribute('data-cmp') === null; })
       && /^Hull armour, mm\nFront \/ sides \/ rear\.\n• Stock: —\n/.test(armRows[1].title) && /^Suspension repair time, s\n/.test(armRows[3].title),
       armRows.map(function (r) { return r.getAttribute('data-key') + '=' + r.ttx.value.textContent; }).join(' '));
    // The expanded view in the garage's five groups and its order (params_helper PARAMS_GROUPS over RELATIVE_PARAMS);
    // every row in the group the client puts it in (the page's own rows - the stabilisation factors, the terrain -
    // where the client lists the matching extra KPIs, the heat and the ammunition at the end of Firepower).
    const CLIENT_GROUPS = {
      relativePower: ['reloadTimeSecs', 'clipFireRate', 'shellsCount', 'shellReloadingTime', 'burstFireRate', 'autoReloadTime', 'autoShootClipFireRate', 'shellLoadingTime',
                      'continuousShotsPerMinute', 'twinGunSwitchFireModeTime', 'chargeTime', 'shotsPerMinute', 'turretRotationSpeed', 'gunYawLimits', 'pitchLimits', 'aimingTime',
                      'shotDispersionAngle', 'avgDamagePerMinute', 'stabMovement', 'stabRotation', 'stabTurret', 'stabAfterShot', 'overheat', 'maxAmmo'],
      relativeArmor: ['maxHealth', 'hullArmor', 'turretArmor', 'chassisRepairTime'],
      relativeMobility: ['vehicleWeight', 'enginePower', 'enginePowerPerTon', 'speedLimits', 'chassisRotationSpeed', 'maxSteeringLockAngle', 'switchTime', 'autoSiege', 'terrainResistance'],
      relativeCamouflage: ['invisibilityStillFactor', 'invisibilityMovingFactor', 'invisibilityAfterShot'], relativeVisibility: ['circularVisionRadius']};
    const fsecs = full.children, misplaced = [];
    fsecs.forEach(function (sec) {
      ttxRowsIn(sec).forEach(function (r) { if ((CLIENT_GROUPS[sec.getAttribute('data-group')] || []).indexOf(r.getAttribute('data-key')) < 0) misplaced.push(sec.getAttribute('data-group') + ':' + r.getAttribute('data-key')); });
    });
    const fireKeys = ttxRowsIn(fsecs[0].children[3]).map(function (r) { return r.getAttribute('data-key'); });
    ok('ttx v2: the expanded view - the garage\'s five groups in its order, each under its rule, every row in the client\'s own group, Firepower in its order with the reload line on top and the shells under it',
       fsecs.map(function (x) { return x.getAttribute('data-group'); }).join() === 'relativePower,relativeArmor,relativeMobility,relativeCamouflage,relativeVisibility'
       && fsecs.every(function (x) { return x.children[0].className === 'ttx-rule'; }) && misplaced.length === 0
       && fsecs[0].children[1].className === 'ttx-reload' && fsecs[0].children[2].className === 'ttx-shells'
       && fireKeys.join() === 'shotsPerMinute,turretRotationSpeed,pitchLimits,aimingTime,shotDispersionAngle,avgDamagePerMinute,stabMovement,stabRotation,stabTurret,stabAfterShot,maxAmmo'
       && lineText(full) === 'c:reloadTimeSecs=13.14' && f.reloadTimeSecs === undefined,
       misplaced.join(' ') + ' | ' + fireKeys.join());
    ok('ttx v2: the rule names follow the client\'s own words, and the order is the client\'s RELATIVE_PARAMS',
       fsecs.map(function (x) { return x.children[0].getAttribute('aria-label'); }).join() === 'Firepower,Survivability,Mobility,Concealment,Spotting'
       && TX.GROUPS.map(function (g) { return g[0]; }).join() === 'relativePower,relativeArmor,relativeMobility,relativeCamouflage,relativeVisibility');
    const shellRows = ttxFind(full, function (c) { return c.className === 'ttx-shells'; })[0];
    ok('ttx: and the shells of this gun as a table under the three icons of the garage, one row a shell',
       !!shellRows && shellRows.children.length === 3 && shellRows.children[1].children[0].children[0].src === 'web/icons/ARMOR_PIERCING.png'
       && shellRows.children[1].children[1].textContent === '490' && shellRows.children[2].children[1].textContent === '640'
       && shellRows.children[1].children[3].textContent === '900');
    // ONE GRID OF THREE COLUMNS a view (user 23.09: "the first column is fine, the rest scatter"): the view is the grid -
    // the compact view's .ttx-body, the expanded view's .ttx-full - and every box between it and a row (a section, its
    // box of rows, the reload line) hands its cells to it (display:contents); the reload line's sides take columns 1-3,
    // the stabilisation three start a row, a rule and the shell table span it. No box of the panel lays rows out on its
    // own any more (the two-column grid, the flex line of three, the reload line's own 1fr auto 1fr).
    const cssT = fs.readFileSync(path + 'style.css', 'utf8'), CONTENTS = ['ttx-sec', 'ttx-rows', 'ttx-reload'];
    const onGrid = function (view) {
      const rows = ttxRowsIn(view);
      return rows.length > 0 && rows.every(function (r) {
        let e = r.parentNode;
        if (e && e.getAttribute('data-side')) e = e.parentNode;   // a part of the reload line: its side is the grid's cell
        for (; e && e !== view; e = e.parentNode) if (CONTENTS.indexOf(e.className) < 0) return false;
        return e === view;
      });
    };
    ok('ttx grid: one grid of three columns a view - every row of the compact and of the expanded view is a cell of its view\'s grid, the boxes between hand their cells over; reload sides on columns 1-3, the stabilisation three start a row, rules and the shell table span it',
       /\.ttx-body,\.ttx-full\{display:grid;grid-template-columns:repeat\(3,auto\);/.test(cssT) && /\.ttx-sec,\.ttx-rows,\.ttx-reload\{display:contents\}/.test(cssT)
       && /\.ttx-reload-side\[data-side=left\]\{grid-column:1\}/.test(cssT) && /\.ttx-reload-side\[data-side=center\]\{grid-column:2\}/.test(cssT)
       && /\.ttx-reload-side\[data-side=right\]\{grid-column:3\}/.test(cssT) && /\.ttx-row\[data-key=stabMovement\]\{grid-column-start:1\}/.test(cssT)
       && /\.ttx-rule\{grid-column:1\/-1;/.test(cssT) && /\.ttx-shells\{grid-column:1\/-1;/.test(cssT)
       && !/\.ttx-(?:rows|reload|sec)\{display:(?:grid|flex)/.test(cssT) && cssT.indexOf('.ttx-line') < 0 && !/data-side=\w+\]\{justify-content/.test(cssT)
       && /<div id="ttx-compact" class="ttx-body"><\/div>/.test(pageSrc) && /<div class="toolbar-popover ttx-full" id="ttx-full"><\/div>/.test(pageSrc)
       && onGrid(compact) && onGrid(full) && ttxRowsIn(compact).length === 14 && ttxFind(full, function (c) { return c.className === 'ttx-rows'; }).length === 5,
       ttxRowsIn(compact).length + ' compact rows');
    // The compact view's own grid (24.09): two columns, a line of rows starting a grid row; the reload line's sides placed
    // by its shape - a magazine's interval beside the DPM, its reload and rounds under them; any other gun's reload beside it.
    ok('ttx 24.09: the compact grid - two columns, every line starts a row, the reload line\'s sides in their columns by its shape',
       /\.ttx-body\{grid-template-columns:repeat\(2,auto\)\}/.test(cssT) && /\.ttx-body \.ttx-rows>:first-child\{grid-column-start:1\}/.test(cssT)
       && /\.ttx-body \.ttx-reload-side:empty\{display:none\}/.test(cssT)
       && /\.ttx-reload\[data-shape=mag\]>\.ttx-reload-side\[data-side=right\],[^{]*\[data-shape=mag\]>\.ttx-reload-side\[data-side=left\],\s*\.ttx-body \.ttx-reload\[data-shape=one\]>\.ttx-reload-side\[data-side=center\]\{grid-column:2\}/.test(cssT)
       && /\.ttx-reload\[data-shape=mag\]>\.ttx-reload-side\[data-side=center\],\.ttx-body \.ttx-reload\[data-shape=one\]>\.ttx-reload-side\[data-side=right\]\{grid-column:1\}/.test(cssT)
       && lineIn(compact).getAttribute('data-shape') === 'one' && lineIn(compact).children.map(function (x) { return x.getAttribute('data-side'); }).join() === 'center,right,left');
    // ⚙: this build against the stock.
    click(buildToggle);
    ok('ttx: ⚙ turns on this build - lit, kept in the hidden settings control, and every equal figure stays uncoloured',
       buildBox.checked === true && buildToggle.getAttribute('aria-pressed') === 'true' && rowOf('reload').getAttribute('data-cmp') === null
       && /\n• This build: 13\.14/.test(rowOf('reload').title) && /\n• From the gun on the scene: the fire figures/.test(buildToggle.title));
    openConfigMenu();
    choosePreset('Rammer, stabiliser, vents');
    const r = Number(val('reload')), m = Number(val('stabMovement'));
    ok('ttx: a build with a rammer and vents - a shorter reload in mint, the stock and the build both in its tooltip',
       r < 13.14 && rowOf('reload').getAttribute('data-cmp') === 'better' && new RegExp('• Stock: 13\\.14\\n• This build: ' + val('reload').replace('.', '\\.') + '\\n').test(rowOf('reload').title),
       '(' + val('reload') + ' / ' + rowOf('reload').getAttribute('data-cmp') + ')');
    ok('ttx: the stabiliser and Smooth Ride shrink the movement factor, a worse figure would be red',
       m < 0.18 && rowOf('stabMovement').getAttribute('data-cmp') === 'better' && rowOf('speedLimits').getAttribute('data-cmp') === null);
    ok('ttx: the expanded view, open, follows the same event', centreOf(full).ttx.value.textContent === val('reload') && centreOf(full).getAttribute('data-cmp') === 'better');
    more.open = false;
    // Not a single call from a frame: 300 steps of the emulation with W held, and the panel's arithmetic untouched.
    let calls = 0, steps = 0;
    const realValues = TX.values, realStep = ArmorBallistics.aimStep;
    TX.values = function (x) { calls++; return realValues(x); };
    ArmorBallistics.aimStep = function () { steps++; return realStep.apply(this, arguments); };
    document.fire('keydown', {code: 'KeyW', key: 'w', target: document.body, preventDefault: function () {}});
    run(5);
    document.fire('keyup', {code: 'KeyW', key: 'w', target: document.body, preventDefault: function () {}});
    run(3);
    TX.values = realValues; ArmorBallistics.aimStep = realStep;
    ok('ttx: the frame loop never calls the panel - 0 calls over 300+ steps of the emulation',
       calls === 0 && steps >= 300, '(' + calls + ' calls, ' + steps + ' steps)');
    choosePreset('Stock — no equipment');
    click(buildToggle);
    ok('ttx: ⚙ off again - the stock, no colours', buildBox.checked === false && rowOf('reload').getAttribute('data-cmp') === null && val('reload') === '13.14');
    // The layout pass: the stub's rectangles all overlap, so the panel steps up above the shooter row, as the pose tile does.
    scheduleLayoutNow();
    ok('ttx: the panel rises above the shooter row it would collide with - the pose tile’s own rule, one function for both corners',
       panel.style.bottom === '60px' && appSrc.indexOf('function layoutCorner(el)') > 0 && appSrc.indexOf('function layoutPose(){layoutCorner($(\'pose-info\'));}') > 0);
    viewport.clientHeight = 300;
    scheduleLayoutNow();
    const fold = document.getElementById('ttx-fold');
    ok('ttx: on a scene lower than 420 px it folds into one button, its controls moved into the popover',
       fold.hidden === false && document.getElementById('ttx-fold-pop').children.indexOf(document.getElementById('ttx-inner')) >= 0);
    viewport.clientHeight = 800;
    scheduleLayoutNow();
    ok('ttx: and unfolds when the scene grows again, the controls back in the panel',
       fold.hidden === true && panel.children.indexOf(document.getElementById('ttx-inner')) >= 0);
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    // Two pairs, the recorded gun the clip one.
    ok('ttx: a vehicle with two guns - the tile shows ▾, and the pair on the panel is the one that fired (the clip gun, by its name)',
       panel.hidden === false && pairsBox.getAttribute('data-many') === 'true' && pairTile.children[1].textContent === '120'
       && pairsBox.getAttribute('data-other') === null && keyOf('reload') === 'clipFireRate' && val('reload') === TX.nice(9 / (0.57 + 0.43 * 1.1)));
    ok('ttx v2: a magazine\'s reload line grows both ways - its 3 rounds to the left, the magazine\'s reload in the middle, the 2 s between rounds to the right',
       lineText(compact) === 'l:shellsCount=3 c:clipFireRate=' + TX.nice(9 / (0.57 + 0.43 * 1.1)) + ' r:shellReloadingTime=2'
       && ttxLineOf(lineIn(compact)).map(function (p) { return p.glyph; }).join() === 'clip,reload,interval'
       && /^Shells in the magazine, rounds\n/.test(rowOf('reload').parentNode.parentNode.children.filter(function (x) { return x.getAttribute('data-side') === 'left'; })[0].children[0].title)
       && lineIn(compact).getAttribute('data-shape') === 'mag' && lineIn(compact).children.map(function (x) { return x.getAttribute('data-side'); }).join() === 'right,center,left'
       && /\nAs the garage prints it:\n• Reload \(the magazine \/ between the shells \/ shells\): 8\.63\/2\/3\n/.test(rowOf('reload').title), lineText(compact));
    const stockClip = val('reload');
    openConfigMenu();
    click(crewChip('Mag Mastery'));
    click(buildToggle);
    const mm = val('reload');
    click(document.getElementById('ttx-more-button')); more.open = true;
    const clipRow = lineText(full), clipParts = ttxLineOf(lineIn(compact));
    ok('ttx: Mag Mastery on the panel - the magazine reload x 0.975, in mint, and the interval between the rounds unchanged',
       mm === TX.nice(9 / (0.57 + 0.43 * 1.1) * 0.975) && rowOf('reload').getAttribute('data-cmp') === 'better'
       && clipRow === 'l:shellsCount=3 c:clipFireRate=' + mm + ' r:shellReloadingTime=2' && clipParts[0].cmp === null && clipParts[2].cmp === null,
       '(' + stockClip + ' -> ' + mm + ', ' + clipRow + ')');
    ok('ttx: and the emulator reloads the magazine by the same factor (the gun panel)',
       document.getElementById('aim-gun-reload').textContent === (9 / (0.57 + 0.43 * 1.1) * 0.975).toFixed(1) + ' s',
       '(' + document.getElementById('aim-gun-reload').textContent + ')');
    more.open = false;
    click(crewChip('Mag Mastery'));
    click(buildToggle);
    // The picker: built by the click that opens it.
    pairTile.onclick({preventDefault: function () {}});
    const list = document.getElementById('ttx-pair-list');
    const tiles = list.children.filter(function (c) { return c.className === 'aim-pick-row'; })[0].children;
    ok('ttx: the quick list - the two guns of this turret as tiles (no turret heading: the turret is Config\'s), the one on the panel pressed, ● the fired one, ▲ the top one',
       list.children.length === 1 && list.children[0].className === 'aim-pick-row' && tiles.length === 2
       && tiles[1].getAttribute('aria-pressed') === 'true' && tiles[0].getAttribute('aria-pressed') === 'false'
       && tiles[1].children.some(function (c) { return c.textContent === '●'; }) && tiles[0].children.some(function (c) { return c.textContent === '▲'; })
       && /\n• DPM: \d+ \(stock\)/.test(tiles[0].title) && /\n• ●: the gun that fired in the record/.test(tiles[1].title));
    // 24.09 (gun-switch-owner): the user's WZ-55 - a magazine gun and a single-shot one; the picked gun is the EMULATOR's.
    // Fire the clip gun once first, as the user did - ✸ on with ◔ the real reload: a round gone and the gap running, so
    // the reset of the run is seen.
    const gunReload = document.getElementById('aim-gun-reload'), gunShellsBox = document.getElementById('aim-gun-shells');
    const realBox = document.getElementById('real-reload'), realWas = realBox.checked;
    click(document.getElementById('fun-mode-toggle'));
    if (!realBox.checked) click(document.getElementById('real-reload-toggle'));
    press(); release(); tick(0.05);
    const beforeMag = magStates(), beforeRunning = gunReload.getAttribute('data-running');
    click(tiles[0]); tick(0.05);
    ok('ttx: picking the other gun - its figures on the panel, the tile lit, and the choice kept per vehicle type',
       keyOf('reload') === 'reloadTimeSecs' && lineText(compact) === 'c:reloadTimeSecs=' + TX.nice(7 / (0.57 + 0.43 * 1.1)) && pairsBox.getAttribute('data-other') === 'true'
       && /\nNot the gun that fired \(●\):\n• Its own: the ⌖ circle, the reload, the magazine and the shells\n• The record’s: the recorded ring and the hit’s own shell and result/.test(pairTile.title)
       && storedAim().pairs && storedAim().pairs['germany:ClipX'] === 'TurretX|_105_single', pairTile.title);
    ok('gun switch: the emulator fires the picked gun - the single-shot gun\'s reload, one slot in place of the magazine\'s three',
       gunReload.textContent === (7 / (0.57 + 0.43 * 1.1)).toFixed(1) + ' s' && magStates().split(',').length === 1 && beforeMag.split(',').length === 3,
       '(' + gunReload.textContent + ' · ' + beforeMag + ' -> ' + magStates() + ')');
    ok('gun switch: the run starts over for the new gun - the magazine\'s gap that was running is gone, the one round loaded',
       beforeRunning === '1' && gunReload.getAttribute('data-running') === '0' && magStates() === 'next', beforeRunning + ' ' + beforeMag + ' -> ' + magStates() + ' on=' + onBox.checked + ' live=' + !!(viewerInstance && viewerInstance.liveRadius100));
    click(document.getElementById('target-hp-reset'));   // the shot's damage off the target, for the checks after
    click(document.getElementById('fun-mode-toggle'));
    if (realBox.checked !== realWas) click(document.getElementById('real-reload-toggle'));
    const pickedShell = document.getElementById('shell-choice').value;
    ok('gun switch: the picked gun\'s shells come into the list (⇆) and the one on screen is its own - 105 mm, and the gun panel shows only them',
       /^saved:\d+$/.test(pickedShell) && document.getElementById('caliber').value === 105
       && gunShellsBox.children.length === 1 && /\n• Gun: 105 mm single/.test(gunShellsBox.children[0].title)
       && document.getElementById('shell-quick').children.some(function (b) { return / ⇆$/.test(b.textContent) && /the gun the emulation fires/.test(b.title); }),
       pickedShell + ' ' + document.getElementById('caliber').value + ' ' + gunShellsBox.children.length);
    ok('gun switch: a picked gun\'s shell writes no Statistics log line - the log keeps one line per point and shell type, and it is the record\'s',
       /if\(!\(c&&c\.emuGun\)\)logVerdicts\(shell\);/.test(appSrc));
    // The panel's build figures are read off the emulator's own block (ttxValues live): with ⚙ on they are the picked gun's.
    click(buildToggle);
    ok('gun switch: ⚙ on - the build\'s reload is the picked gun\'s, read off the emulator\'s block (not the clip gun\'s)',
       lineText(compact) === 'c:reloadTimeSecs=' + TX.nice(7 / (0.57 + 0.43 * 1.1)), lineText(compact));
    click(buildToggle);
    pairTile.onclick({preventDefault: function () {}});
    click(list.children.filter(function (c) { return c.className === 'aim-pick-row'; })[0].children[1]);
    ok('ttx: and back to the fired gun', keyOf('reload') === 'clipFireRate' && pairsBox.getAttribute('data-other') === null);
    ok('gun switch: back on the gun that fired - the magazine again (3 slots, its reload), no pick kept for the type, no ⇆ shell left',
       magStates().split(',').length === 3 && gunReload.textContent === (9 / (0.57 + 0.43 * 1.1)).toFixed(1) + ' s'
       && !(storedAim().pairs && storedAim().pairs['germany:ClipX'])
       && !document.getElementById('shell-quick').children.some(function (b) { return / ⇆$/.test(b.textContent); }),
       magStates() + ' ' + gunReload.textContent + ' ' + JSON.stringify(storedAim().pairs || {}));
    ok('ttx v2: one turret - the Turret row of Config is not there', document.getElementById('aim-cfg-turrets').hidden === true);
    // The health of a vehicle without a roster row: its own export (23.09).
    click(document.getElementById('fun-mode-toggle'));
    // 24.09: the figures inside the bar, and the tooltip's first item and source line.
    ok('ttx: a vehicle with no roster row takes its hit points from its own export',
       document.getElementById('target-hp').hidden === false && document.getElementById('target-hp-text').textContent === '1 850 / 1 850'
       && document.getElementById('target-hp').title.indexOf('\n• Left: 1 850 / 1 850 HP\n• Source: the vehicle’s own export') > 0,
       '(' + document.getElementById('target-hp-text').textContent + ' · ' + document.getElementById('target-hp').title.slice(0, 160) + ')');
    click(document.getElementById('fun-mode-toggle'));
    ok('ttx: the markup - the panel in the scene, ⚙ kept in the settings menu, the page’s own controls untouched',
       /<div id="ttx-panel" class="ttx-panel" hidden>/.test(pageSrc) && /<input type="checkbox" id="ttx-build" hidden aria-hidden="true" tabindex="-1">/.test(pageSrc)
       && pageSrc.indexOf('id="ttx-panel"') > pageSrc.indexOf('id="pose-info"') && pageSrc.indexOf('id="ttx-panel"') < pageSrc.indexOf('<div class="scene-toolbar">'));
  }).then(function () {
    // ---- TTX acceptance (23.09, spec section 4): the characteristics files the mod writes (the offline stand,
    // ttx-offline/out/mod/ttx), through the page itself, against the client's own strings (tools/ttx_reference.py:
    // the garage's VehicleParams and formatParameterValue on a real VehicleDescr). Every pair in its stock and in
    // the two builds of spec 4.2, set up with the page's own Config: "fire" - the built-in "Rammer, stabiliser,
    // vents" as the page fits it on the vehicle, Brothers in Arms on everybody, rations; "non-fire" - Coated Optics
    // Class 1, Camouflage Net Class 2, Additional Grousers Class 1 (what the vehicle can mount), Concealment on
    // everybody, paint. The comparison is ttx_accept.cjs's own; the page's strings are written for the table when
    // BULLBA_TTX_PAGE_OUT names a file.
    const ACC_DIR = process.env.BULLBA_TTX_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx/';
    const ACC_REF = process.env.BULLBA_TTX_REF || HERE + '../fixtures-local/ttx-reference/ttx_reference.json';
    if (!fs.existsSync(ACC_REF) || !fs.existsSync(ACC_DIR)) { console.log('SKIP (the TTX reference is not on this machine: ' + ACC_REF + ')'); return; }
    const accept = require('./ttx_accept.cjs');
    const ref = JSON.parse(fs.readFileSync(ACC_REF, 'utf8')), files = {};
    fs.readdirSync(ACC_DIR).forEach(function (f) {
      if (!/\.js$/.test(f)) return;
      new Function('ArmorInspectorData', fs.readFileSync(ACC_DIR + f, 'utf8'))({receive: function (x) {
        // A type the page has read already this session (the IS-7 fixture above) sits in its cache of eight: the
        // real file takes the fixture's place in that very object.
        const t = FIXTURES[x[1].id] || {};
        Object.keys(t).forEach(function (k) { delete t[k]; });
        files[x[1].type] = FIXTURES[x[1].id] = Object.assign(t, x[1]);
      }});
    });
    const stock = ref.filter(function (r) { return r.mode === 'stock' && files[r.vehicle]; });
    const ACC = {id: 't-acc', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: stock.map(function (r, i) {
      const t = files[r.vehicle], ti = t.turrets.map(function (x) { return x.name; }).indexOf(r.turret);
      const pair = t.configs.filter(function (c) { return c.gun === r.gun && c.turret === ti; })[0];
      // The shooter as a record of this build carries him: the gun's XML names, the aim block and the vehicle's own
      // tags and tier (exporter.fitment_block), which decide what Config offers.
      return THIT('acc-' + i, {name: r.vehicle.split(':')[1], type: r.vehicle, gun: pair.gunUserString, gunName: r.gun, turretName: r.turret,
                               aim: pair.aim, level: r.level, tags: r.tags, tagsRead: true});
    })};
    const battleBefore = global.ArmorInspectorData.battle;
    global.ArmorInspectorData.battle = function (id) { return id === 't-acc' ? Promise.resolve(ACC) : battleBefore(id); };
    tb.value = 't-acc'; tb.onchange.call(tb);
    const COMPACT = ['avgDamagePerMinute', 'maxHealth', 'shotDispersionAngle', 'aimingTime', 'turretRotationSpeed', 'hull', 'speedLimits',
                     'enginePowerPerTon', 'stabMovement', 'stabRotation', 'stabTurret'];
    const page = {}, fitted = {};
    function read(r, mode) {
      const out = {compact: {}, full: {}, shells: []};
      COMPACT.forEach(function (slot) { out.compact[slot] = val(slot); });
      out.line = ttxLineOf(lineIn(compact));
      more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true;
      out.full = fullRows();
      out.fullLine = ttxLineOf(lineIn(full));
      const sec = ttxFind(full, function (s) { return s.className === 'ttx-shells'; })[0];
      (sec ? sec.children.slice(1) : []).forEach(function (line) {
        out.shells.push({avgDamage: line.children[1].textContent, avgPiercingPower: line.children[2].textContent,
                         shellVelocity: line.children[3].textContent, title: line.title});
      });
      more.open = false;
      page[[r.vehicle, r.turret, r.gun, mode].join('|')] = out;
    }
    function fit(name) {
      const i = slots.children.map(function (t) { return /\. Empty$/.test(t.getAttribute('aria-label')); }).indexOf(true);
      if (i < 0) return false;
      click(slots.children[i]);
      const tile = pick(name);
      if (!tile) { click(document.getElementById('aim-cfg-scrim')); return false; }
      click(tile);
      if (!layer.hidden) click(document.getElementById('aim-cfg-scrim'));
      return true;
    }
    function everybody(prefix) {
      for (let n = 0; n < 12; n++) {
        const chip = crewChips().filter(function (c) { return tileName(c).indexOf(prefix) === 0 && c.getAttribute('aria-pressed') !== 'true'; })[0];
        if (!chip) return;
        click(chip);
      }
    }
    function slotNames() {
      return slots.children.map(function (t) { return t.getAttribute('aria-label').replace(/^Slot \d+\. /, ''); }).filter(function (n) { return n !== 'Empty'; });
    }
    let chain = Promise.resolve();
    stock.forEach(function (r, i) {
      chain = chain.then(function () { document.getElementById('hits').children[i].onclick(); return settle(20); }).then(function () {
        if (buildBox.checked) click(buildToggle);
        read(r, 'stock');
        click(buildToggle);
        openConfigMenu();
        choosePreset('Rammer, stabiliser, vents');
        everybody('Brothers in Arms, ');
        const food = consumables.children[0].children[0];
        if (food.getAttribute('aria-pressed') !== 'true') click(food);
        fitted[r.vehicle + '|' + r.gun + '|fire'] = slotNames();
        read(r, 'fire');
        choosePreset('Stock — no equipment');
        ['Coated Optics Class 1', 'Camouflage Net Class 2', 'Additional Grousers Class 1'].forEach(fit);
        everybody('Concealment, ');
        const paint = consumables.children[0].children.filter(function (t) { return tileName(t) === 'Camouflage'; })[0];
        if (paint && paint.getAttribute('aria-pressed') !== 'true') click(paint);
        fitted[r.vehicle + '|' + r.gun + '|nonfire'] = slotNames();
        read(r, 'nonfire');
        choosePreset('Stock — no equipment');
        click(buildToggle);
      });
    });
    // GUN SWITCH (24.09, gun-switch-owner): every pair B of a vehicle with more than one - the Vz. 55's magazine and
    // single-shot guns, the VK 30.01 P's two turrets x two guns, the M-VI-Yoh whose second turret brings a gun the first
    // lacks - picked on the hit of ANOTHER pair (Config's Turret row, then the chip's list) under the "fire" build must
    // print exactly what B's own recorded hit printed under it above (and that was held against the client's strings):
    // the panel's build figures are read off the emulator's own block, so this is the emulator's gun, not a second copy.
    const swDiff = [], swPairs = {};
    stock.forEach(function (r, i) { (swPairs[r.vehicle] = swPairs[r.vehicle] || []).push(i); });
    const swPick = function (t, r, again) {
      const row = document.getElementById('aim-cfg-turrets'), ti = t.turrets.map(function (x) { return x.name; }).indexOf(r.turret), info = t.turrets[ti] || {};
      const pair = t.configs.filter(function (c) { return c.gun === r.gun && c.turret === ti; })[0];
      if (!row.hidden) {
        const tt = row.children.filter(function (x) { return x.getAttribute('aria-label') === (info.userString || info.name); })[0];
        if (tt && tt.getAttribute('aria-pressed') !== 'true') click(tt);
      }
      pairTile.onclick({preventDefault: function () {}});
      const list = document.getElementById('ttx-pair-list'), away = list.children.filter(function (c) { return c.getAttribute('data-turrets') === 'true'; })[0];
      const at = away ? away.children.filter(function (x) { return x.getAttribute('aria-label') === (info.userString || info.name); })[0] : null;
      if (at && at.getAttribute('aria-pressed') !== 'true') { click(at); pairTile.onclick({preventDefault: function () {}}); }
      const guns = list.children.filter(function (c) { return c.className === 'aim-pick-row' && c.getAttribute('data-turrets') === null; })[0];
      const tile = guns ? guns.children.filter(function (x) { return x.getAttribute('aria-label') === (pair.gunUserString || pair.gun); })[0] : null;
      if (tile && (again || tile.getAttribute('aria-pressed') !== 'true')) click(tile);
      pairsBox.open = false;
    };
    Object.keys(swPairs).forEach(function (veh) {
      const idx = swPairs[veh];
      if (idx.length < 2) return;
      idx.forEach(function (bi, k) {
        const ai = idx[k === 0 ? 1 : 0], r = stock[bi], t = files[veh];
        chain = chain.then(function () { document.getElementById('hits').children[ai].onclick(); return settle(20); }).then(function () {
          if (buildBox.checked) click(buildToggle);
          swPick(t, r);
          click(buildToggle);
          openConfigMenu();
          choosePreset('Rammer, stabiliser, vents');
          everybody('Brothers in Arms, ');
          const food = consumables.children[0].children[0];
          if (food.getAttribute('aria-pressed') !== 'true') click(food);
          read(r, 'switched');
          const key = [r.vehicle, r.turret, r.gun], got = page[key.concat('switched').join('|')], own = page[key.concat('fire').join('|')];
          delete page[key.concat('switched').join('|')];
          const diff = ['compact', 'line', 'full', 'fullLine', 'shells'].filter(function (f) { return JSON.stringify(got[f]) !== JSON.stringify(own[f]); });
          if (diff.length) swDiff.push(veh.split(':')[1] + ' ' + stock[ai].gun + ' -> ' + r.gun + ' @ ' + r.turret + ': ' + diff.map(function (f) { return f + ' ' + JSON.stringify(got[f]).slice(0, 160) + ' / ' + JSON.stringify(own[f]).slice(0, 160); }).join('; '));
          swDiff.count = (swDiff.count || 0) + 1;
          choosePreset('Stock — no equipment');
          click(buildToggle);
          swPick(t, stock[ai], true);   // the recorded gun picked back: the choice goes back to the record
        });
      });
    });
    chain = chain.then(function () {
      ok('gun switch acceptance: a pair picked on another pair\'s hit prints under the "fire" build exactly what its own recorded hit printed - compact, reload line, expanded view, shells (' + ((swDiff.count || 0) - swDiff.length) + '/' + (swDiff.count || 0) + ')',
         (swDiff.count || 0) > 0 && swDiff.length === 0, swDiff.join(' || '));
    });
    return chain.then(function () {
      if (process.env.BULLBA_TTX_PAGE_OUT) fs.writeFileSync(process.env.BULLBA_TTX_PAGE_OUT, JSON.stringify(page, null, 1));
      const rows = accept.compare(ref, page), by = accept.summary(rows);
      // The devices the page fitted are the client's pick for this vehicle (the reference mounts the Class band
      // checkCompatibilityWithVehicle allows, and leaves out what the vehicle cannot mount).
      const DEV = {};
      window.AIM_CATALOGUE.devices.forEach(function (d) { DEV[d.name] = d.id; });
      const wrong = ref.filter(function (r) { return r.mode !== 'stock' && files[r.vehicle] && r.build && r.build.devices; }).filter(function (r) {
        const got = (fitted[r.vehicle + '|' + r.gun + '|' + r.mode] || []).map(function (n) { return DEV[n] || n; });
        return got.join(',') !== r.build.devices.join(',');
      }).map(function (r) { return r.vehicle + ' ' + r.mode + ': page ' + (fitted[r.vehicle + '|' + r.gun + '|' + r.mode] || []).join('+') + ', client ' + r.build.devices.join('+'); });
      ok('ttx acceptance: the builds fit on each vehicle exactly the devices the client lets it mount', wrong.length === 0, wrong.join('; '));
      Object.keys(by).forEach(function (k) {
        const bad = rows.filter(function (x) { return x.vehicle + ' · ' + x.mode === k && !accept.good(x); });
        ok('ttx acceptance: ' + k + ' - the panel prints the client’s own strings (' + by[k].ok + '/' + by[k].all + ')', bad.length === 0,
           bad.map(function (x) { return x.where + ' ' + x.key + ' page ' + x.page + ' client ' + x.client; }).join('; '));
      });
      ok('ttx acceptance: every pair of the reference’s vehicles was compared in the three modes',
         Object.keys(by).length === stock.length * 3, '(' + Object.keys(by).length + ' of ' + stock.length * 3 + ')');
    });
  });
}).then(function () {
  // ---- Survivability (23.09): a file of before 23.09 in the game, then the mod's new one -----------------------------
  // The JagdPz E 100 (the mod's own file offline): the page first gets it as a mod of before 23.09 wrote it (no armour,
  // no repair, no armorSchema) and shows it at once; in the game it reads it again every 2 s until the new file is
  // there (readTtx / ttxRefresh), then paints the whole group - and, the turret being the hull's fake one, no turret line.
  const SDIR = process.env.BULLBA_TTX_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx/';
  const E100 = SDIR + 'germany-G72_JagdPz_E100.js';
  if (!fs.existsSync(E100)) { console.log('SKIP (the JagdPz E 100 file is not on this machine: ' + E100 + ')'); return; }
  let fresh = null;
  new Function('ArmorInspectorData', fs.readFileSync(E100, 'utf8'))({receive: function (x) { fresh = x[1]; }});
  // Under a type of its own: the acceptance above may have left the real E 100 in the page's cache.
  fresh.id = 'germany-SurvE100'; fresh.type = 'germany:SurvE100';
  const old = JSON.parse(JSON.stringify(fresh));
  delete old.armorSchema; delete old.modules.chassis.repairTime;
  old.configs.forEach(function (c) { delete c.hullArmor; }); old.turrets.forEach(function (t) { delete t.primaryArmor; });
  let serve = old, reads = 0;
  const keepBattle = global.ArmorInspectorData.battle, keepTtx = global.ArmorInspectorData.ttx, keepScene = global.ArmorInspectorData.scene;
  global.ArmorInspectorData.ttx = function (id) {
    if (id !== fresh.id) return keepTtx ? keepTtx(id) : Promise.reject(new Error('none'));
    reads++; return Promise.resolve(serve);
  };
  const parts = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const p0 = fresh.configs[0];
  const SBATTLE = {id: 't-surv', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: [
    {id: 'sv-0', attackerId: 41, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
     attacker: {name: 'JagdPz E 100', type: fresh.type, gun: p0.gunUserString, gunName: p0.gun, turretName: fresh.turrets[p0.turret].name, aim: p0.aim,
                parts: parts(), gunDispersion: 0.00383},
     target: {name: 'Beta', type: 'germany:Beta', parts: parts(), maxHealth: 1850}, warnings: []}]};
  global.ArmorInspectorData.battle = function (id) { return id === 't-surv' ? Promise.resolve(SBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  const more = document.getElementById('ttx-more'), full = document.getElementById('ttx-full');
  const armour = function () {
    more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true;
    const sec = full.children.filter(function (s) { return s.getAttribute('data-group') === 'relativeArmor'; })[0];
    const out = {};
    (sec ? ttxRowsIn(sec) : []).forEach(function (r) { out[r.getAttribute('data-key')] = {text: r.ttx.value.textContent, title: r.title}; });
    more.open = false;
    return out;
  };
  global.BullbaHost.game = true;
  const tb = document.getElementById('battles');
  tb.value = 't-surv'; tb.onchange.call(tb);
  let before = null, readsBefore = 0;
  return settle(20).then(function () { document.getElementById('hits').children[0].onclick(); return settle(20); }).then(function () {
    before = armour(); readsBefore = reads;
    serve = fresh;
    tick(2.1);
    return settle(20);
  }).then(function () {
    const after = armour();
    ok('ttx: Survivability - a file of before 23.09 is shown at once in the game (dashes, and why), with no turret line on a fake turret',
       !!before.maxHealth && before.maxHealth.text === '2200' && before.hullArmor && before.hullArmor.text === '—' && before.turretArmor === undefined
       && before.chassisRepairTime && before.chassisRepairTime.text === '—' && /written before the armour/.test(before.hullArmor.title),
       JSON.stringify(before).slice(0, 200));
    ok('ttx: Survivability - in the game the page reads it again and takes the mod\'s new file: hull 200/120/150 and 12.03 s, as the client prints them, still no turret line',
       reads > readsBefore && after.hullArmor && after.hullArmor.text === '200/120/150' && after.turretArmor === undefined
       && after.chassisRepairTime && after.chassisRepairTime.text === '12.03' && /÷ 0\.57/.test(after.chassisRepairTime.title)
       && /not their slope/.test(after.hullArmor.title), JSON.stringify(after).slice(0, 300));
    // No more reads once the new file is there.
    const settled = reads;
    tick(6);
    return settle(10).then(function () {
      ok('ttx: Survivability - the reading again stops with the new file', reads === settled, reads + ' / ' + settled);
    });
  }).then(function () {
    global.BullbaHost.game = false;
    global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.ttx = keepTtx; global.ArmorInspectorData.scene = keepScene;
  });
}).then(function () {
  // ---- TTX panel v2 (23.09): the reload line against the client's own lines for every kind of loading ----------
  // Ten vehicles (tools/ttx_reference.py --out ttx-reference/reload; their files by the mod's own ttx_block offline,
  // ttx-offline/out/mod/ttx-reload): single (IS-7, Vz. 55 vz. 54, the Black Rock's chargeable burst), magazine (Vz. 55
  // 2A), bursts (Donnola: the magazine is one burst; Char Mle. 75: two of three), autoloader (Progetto 65), dual gun
  // (ST-II), twin gun (Contriver), automatic (Vz. 64 Blesk, two turrets x two guns) and the Ares 90 - each pair's stock
  // through the page: the parts, their sides and order, the tooltip of the middle with the garage's whole lines, the
  // HP in the head; then the quick list of guns and the Turret row of Config on the Blesk.
  const RDIR = process.env.BULLBA_TTX_RELOAD_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx-reload/';
  const RREF = process.env.BULLBA_TTX_RELOAD_REF || HERE + '../fixtures-local/ttx-reference/reload/ttx_reference.json';
  if (!fs.existsSync(RREF) || !fs.existsSync(RDIR)) { console.log('SKIP (the reload reference is not on this machine: ' + RREF + ')'); return; }
  const accept = require('./ttx_accept.cjs');
  const TX = window.BullbaTtx;
  const ref = JSON.parse(fs.readFileSync(RREF, 'utf8')).filter(function (r) { return r.mode === 'stock'; }), files = {}, byId = {};
  fs.readdirSync(RDIR).forEach(function (f) {
    if (/\.js$/.test(f)) new Function('ArmorInspectorData', fs.readFileSync(RDIR + f, 'utf8'))({receive: function (x) { files[x[1].type] = byId[x[1].id] = x[1]; }});
  });
  const keepBattle = global.ArmorInspectorData.battle, keepTtx = global.ArmorInspectorData.ttx, keepScene = global.ArmorInspectorData.scene;
  // Review 23.09: where the expanded view puts a gun's sector. The Black Rock gets a made-up one (its pairs only: the
  // file's, which the panel reads; the record's aim block stays without, so the emulator is untouched).
  const BR = 'usa:A179_Black_Rock';
  files[BR].configs.forEach(function (c) { c.turretYawLimits = [-0.2618, 0.2618]; });
  let sectorOrder = null;
  const parts = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const hits = ref.map(function (r, i) {
    const t = files[r.vehicle], ti = t.turrets.map(function (x) { return x.name; }).indexOf(r.turret);
    const pair = t.configs.filter(function (c) { return c.gun === r.gun && c.turret === ti; })[0];
    return {id: 'rl-' + i, attackerId: 40, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: r.vehicle.split(':')[1], type: r.vehicle, gun: pair.gunUserString, gunName: r.gun, turretName: r.turret, aim: pair.aim,
                       level: r.level, tags: r.tags, tagsRead: true, parts: parts(), gunDispersion: 0.00383},
            target: {name: 'Beta', type: 'germany:Beta', parts: parts(), maxHealth: 1850}, warnings: []};
  });
  const RBATTLE = {id: 't-reload', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: hits};
  global.ArmorInspectorData.battle = function (id) { return id === 't-reload' ? Promise.resolve(RBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  // A type the page has read already this session sits in its cache: the reload file takes its place in that object.
  global.ArmorInspectorData.ttx = function (id) {
    if (!byId[id]) return keepTtx ? keepTtx(id) : Promise.reject(new Error('none'));
    return (keepTtx ? keepTtx(id).catch(function () { return null; }) : Promise.resolve(null)).then(function (old) {
      if (old && old !== byId[id]) { Object.keys(old).forEach(function (k) { delete old[k]; }); byId[id] = Object.assign(old, byId[id]); }
      return byId[id];
    });
  };
  const tb = document.getElementById('battles');
  tb.value = 't-reload'; tb.onchange.call(tb);
  const compact = document.getElementById('ttx-compact'), full = document.getElementById('ttx-full'), more = document.getElementById('ttx-more');
  const buildBox = document.getElementById('ttx-build');
  const hpRow = function () { return document.getElementById('ttx-hp').children[0] || null; };
  const lineIn = function (el) { return ttxFind(el, function (c) { return c.className === 'ttx-reload'; })[0] || null; };
  const page = {};
  let chain = settle(20);
  hits.forEach(function (h, i) {
    chain = chain.then(function () { document.getElementById('hits').children[i].onclick(); return settle(20); }).then(function () {
      if (buildBox.checked) click(document.getElementById('ttx-build-toggle'));
      const r = ref[i], out = {compact: {maxHealth: hpRow() ? hpRow().ttx.value.textContent : null}};
      out.line = ttxLineOf(lineIn(compact));
      // The compact line's shape and its sides' order (24.09, two columns): a magazine's - the interval, the reload, the rounds.
      out.shape = lineIn(compact).getAttribute('data-shape') + ':' + lineIn(compact).children.map(function (x) { return x.getAttribute('data-side'); }).join();
      more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true;
      out.fullLine = ttxLineOf(lineIn(full));
      more.open = false;
      if (r.vehicle === BR) {
        // The page's own object of the file (byId, after the read), its turret flag three ways.
        const held = byId[files[BR].id], order = function (flag) {
          if (flag === undefined) delete held.vehicle.hasTurret; else held.vehicle.hasTurret = flag;
          more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true;
          const keys = ttxRowsIn(full).map(function (x) { return x.getAttribute('data-key'); }).filter(function (k) { return ['turretRotationSpeed', 'gunYawLimits', 'pitchLimits'].indexOf(k) >= 0; });
          more.open = false;
          return keys.join();
        };
        sectorOrder = {turret: order(true), none: order(false), old: order(undefined)};
      }
      page[[r.vehicle, r.turret, r.gun, r.mode].join('|')] = out;
    });
  });
  // ---- GUN SWITCH ACCEPTANCE (24.09, gun-switch-owner) ----------------------------------------------------------
  // The user, 24.09: the gun picked on the chip must be the gun the emulation fires. For every pair B of a vehicle with
  // more than one (Vz. 55 single <-> 2A magazine, the Blesk's two turrets x two automatic guns, ...): its record's hit is
  // opened on ANOTHER pair A, B is picked (Config's Turret row, then the chip's list), and everything the emulator shows
  // is read - the reload, the magazine, the live ring, the mode button, the heat bar, the reload's words, the panel's
  // build line (⚙ on: read off the emulator's own block). Then B's own recorded hit is opened: the two must be the same
  // screen (one function, no second formula), and the switched build line must print the client's own strings for B.
  const SW = {rows: [], same: [], shells: [], resets: []};
  const byVehicle = {};
  ref.forEach(function (r, i) { (byVehicle[r.vehicle] = byVehicle[r.vehicle] || []).push(i); });
  const pairTileSw = document.getElementById('ttx-pair'), listSw = document.getElementById('ttx-pair-list'), buildToggleSw = document.getElementById('ttx-build-toggle');
  const mech = document.getElementById('aim-gun-mech'), heat = document.getElementById('aim-gun-heat'), gunReloadSw = document.getElementById('aim-gun-reload');
  const snap = function () {
    tick(0.05);
    if (!buildBox.checked) click(buildToggleSw);
    const line = ttxLineOf(lineIn(compact)).map(function (p) { return p.side[0] + ':' + p.key + '=' + p.text; }).join(' ');
    const rows = ttxRowsIn(compact).map(function (x) { return x.getAttribute('data-key') + '=' + x.ttx.value.textContent; }).join(' ');
    const lineParts = ttxLineOf(lineIn(compact));
    click(buildToggleSw);
    return {reload: gunReloadSw.textContent, mag: magStates(), ring: viewerInstance.liveRadius100 ? viewerInstance.liveRadius100.toFixed(6) : null,
            mech: mech.hidden ? '' : mech.textContent + '|' + mech.getAttribute('aria-label') + '|' + mech.title,
            heat: heat.hidden ? '' : heat.title, words: gunReloadSw.parentNode.title, line: line, rows: rows, parts: lineParts};
  };
  const pickPair = function (t, pair, again) {
    const turretName = (t.turrets[pair.turret] || {}), row = document.getElementById('aim-cfg-turrets');
    if (!row.hidden) {
      const tt = row.children.filter(function (x) { return x.getAttribute('aria-label') === (turretName.userString || turretName.name); })[0];
      if (tt && tt.getAttribute('aria-pressed') !== 'true') click(tt);
    }
    pairTileSw.onclick({preventDefault: function () {}});
    const guns = listSw.children.filter(function (c) { return c.className === 'aim-pick-row' && c.getAttribute('data-turrets') === null; })[0];
    const tile = guns ? guns.children.filter(function (x) { return x.getAttribute('aria-label') === (pair.gunUserString || pair.gun); })[0] : null;
    if (tile && (again || tile.getAttribute('aria-pressed') !== 'true')) click(tile);
    document.getElementById('ttx-pairs').open = false;
  };
  const onBefore = onBox.checked;
  switchOn(true);
  click(document.getElementById('fun-mode-toggle'));   // ✸: the mode button and the heat bar are there only under it
  Object.keys(byVehicle).forEach(function (veh) {
    const idx = byVehicle[veh];
    if (idx.length < 2) return;
    idx.forEach(function (bi, k) {
      const ai = idx[k === 0 ? 1 : 0], r = ref[bi], t = files[veh];
      const ti = t.turrets.map(function (x) { return x.name; }).indexOf(r.turret);
      const pairB = t.configs.filter(function (c) { return c.gun === r.gun && c.turret === ti; })[0];
      let switched = null;
      chain = chain.then(function () { document.getElementById('hits').children[ai].onclick(); return settle(20); }).then(function () {
        const before = gunReloadSw.textContent + '|' + magStates();
        pickPair(byId[t.id] || t, pairB);
        tick(0.05);
        switched = snap();
        switched.stored = (storedAim().pairs || {})[veh] || '';
        switched.gunShells = document.getElementById('aim-gun-shells').children.length;
        switched.before = before;
        document.getElementById('hits').children[bi].onclick();
        return settle(20);
      }).then(function () {
        const own = snap(), name = veh.split(':')[1] + ' ' + ref[ai].gun.slice(0, 18) + ' -> ' + r.gun.slice(0, 18) + ' @ ' + r.turret.replace(/^Turret_/, 'T').replace(/_.*$/, '');
        const diff = ['reload', 'mag', 'ring', 'mech', 'heat', 'words', 'line', 'rows'].filter(function (f) { return switched[f] !== own[f]; });
        SW.same.push({name: name, diff: diff.map(function (f) { return f + ': ' + String(switched[f]).slice(0, 90) + ' / ' + String(own[f]).slice(0, 90); })});
        SW.shells.push({name: name, ok: switched.gunShells === ((pairB.shells || (byId[t.id] || t).shells[pairB.gun] || []).length), n: switched.gunShells});
        SW.resets.push({name: name, ok: switched.stored === r.turret + '|' + r.gun, stored: switched.stored});
        // The switched build line against the client's own strings for B (the ⚙-on stock: the page's Stock preset).
        accept.lineRows(function (key, where, client, shown, entry) {
          const good = client === shown || (entry && entry.ambiguous && entry.modes && Object.keys(entry.modes).some(function (m) { return entry.modes[m] === shown; }));
          SW.rows.push({vehicle: name, key: key, where: where, client: client, page: shown, ok: !!good});
        }, r.values, switched.parts, 'switched');
        // Give the choice back to the record: B's own gun picked on B's own hit.
        pickPair(byId[t.id] || t, pairB, true);
      });
    });
  });
  chain = chain.then(function () {
    click(document.getElementById('fun-mode-toggle'));
    switchOn(onBefore);
    const bad = SW.same.filter(function (x) { return x.diff.length; });
    ok('gun switch acceptance: a pair picked on another pair\'s hit shows exactly what its own recorded hit shows - reload, magazine, live ring, mode button, heat, the reload\'s words, the ⚙ build line and rows (' + (SW.same.length - bad.length) + '/' + SW.same.length + ')',
       SW.same.length > 0 && bad.length === 0, bad.map(function (x) { return x.name + ': ' + x.diff.join('; '); }).join(' || '));
    const good = SW.rows.filter(function (x) { return x.ok; }).length, wrong = SW.rows.filter(function (x) { return !x.ok; });
    ok('gun switch acceptance: the switched gun\'s build line (⚙ on, stock preset) prints the client\'s own strings for that gun (' + good + '/' + SW.rows.length + ')',
       SW.rows.length > 0 && wrong.length === 0, wrong.map(function (x) { return x.vehicle + ' ' + x.key + ' page ' + x.page + ' client ' + x.client; }).join('; '));
    const noShell = SW.shells.filter(function (x) { return !x.ok; }), noStore = SW.resets.filter(function (x) { return !x.ok; });
    ok('gun switch acceptance: the gun panel carries the picked gun\'s own shells, and the pick is kept per type as "turret|gun"',
       noShell.length === 0 && noStore.length === 0, JSON.stringify(noShell.concat(noStore)).slice(0, 400));
    const left = Object.keys(storedAim().pairs || {}).filter(function (k) { return byVehicle[k]; });
    ok('gun switch acceptance: the recorded gun picked back gives the choice back to the record - no pick left for these vehicles', left.length === 0, left.join(', '));
    console.log('     gun switch: ' + SW.same.length + ' switches over ' + Object.keys(byVehicle).filter(function (v) { return byVehicle[v].length > 1; }).length + ' vehicles');
  });
  return chain.then(function () {
    if (process.env.BULLBA_TTX_RELOAD_OUT) fs.writeFileSync(process.env.BULLBA_TTX_RELOAD_OUT, JSON.stringify(page, null, 1));
    const rows = [];
    ref.forEach(function (r) {
      const P = page[[r.vehicle, r.turret, r.gun, r.mode].join('|')];
      if (!P) return;
      const name = r.vehicle.split(':')[1] + ' ' + r.gun + ' @ ' + r.turret.replace(/^Turret_/, 'T').replace(/_.*$/, '');
      const add = function (key, where, client, shown, entry) {
        const good = client === shown || (entry && entry.ambiguous && entry.modes && Object.keys(entry.modes).some(function (m) { return entry.modes[m] === shown; }));
        rows.push({vehicle: name, key: key, where: where, client: client, page: shown, ok: !!good});
      };
      accept.lineRows(add, r.values, P.line, 'compact');
      accept.lineRows(add, r.values, P.fullLine, 'expanded');
      add('maxHealth (head)', 'compact', r.values.maxHealth.text, P.compact.maxHealth, r.values.maxHealth);
    });
    const by = {};
    rows.forEach(function (x) { const b = by[x.vehicle] = by[x.vehicle] || {all: 0, ok: 0, bad: []}; b.all++; if (x.ok) b.ok++; else b.bad.push(x.where + ' ' + x.key + ' page ' + x.page + ' client ' + x.client); });
    Object.keys(by).forEach(function (k) {
      ok('ttx v2 reload: ' + k + ' - the reload line and the HP print the client\'s own strings (' + by[k].ok + '/' + by[k].all + ')', by[k].bad.length === 0, by[k].bad.join('; '));
    });
    const total = rows.length, good = rows.filter(function (x) { return x.ok; }).length;
    ok('ttx v2 reload: all ' + ref.length + ' pairs of the ten vehicles compared (' + good + '/' + total + ')', Object.keys(by).length === ref.length && good === total);
    const kinds = {};
    const badShape = ref.map(function (r) { const P = page[[r.vehicle, r.turret, r.gun, r.mode].join('|')], mag = P.line.some(function (p) { return p.side === 'left'; });
      return P.shape === (mag ? 'mag:right,center,left' : 'one:center,right,left') ? null : r.vehicle + ' ' + r.gun + ' ' + P.shape; }).filter(Boolean);
    ok('ttx 24.09: the compact line of every reference gun is shaped for the two columns - a magazine, autoloader, dual or automatic gun (it has the rounds): interval, reload, rounds; the rest: reload first',
       badShape.length === 0, badShape.join('; '));
    ref.forEach(function (r) { const P = page[[r.vehicle, r.turret, r.gun, r.mode].join('|')]; kinds[r.vehicle.split(':')[1] + ' ' + r.gun.slice(0, 12)] = P.line.map(function (p) { return p.side[0] + ':' + p.text; }).join(' '); });
    console.log('     reload lines: ' + JSON.stringify(kinds));
    ok('ttx v2: the gun\'s sector where the garage prints it - after the turret\'s traverse on a real turret (vehicle.hasTurret), after the pitch limits with none, and with none in an older file (232 of 266)',
       !!sectorOrder && sectorOrder.turret === 'turretRotationSpeed,gunYawLimits,pitchLimits' && sectorOrder.none === 'turretRotationSpeed,pitchLimits,gunYawLimits'
       && sectorOrder.old === sectorOrder.none, JSON.stringify(sectorOrder));
    // Review 23.09: a Black Rock record before 0.7.27 has no gunMechanics - its chargeable burst is known by its shape.
    const brPair = files[BR].configs[0], brShells = brPair.shells || files[BR].shells[brPair.gun] || [], brOld = Object.assign({}, brPair.aim);
    delete brOld.gunMechanics;
    const vNew = TX.values({ttx: files[BR], pair: brPair, aim: brPair.aim, shells: brShells}), vOld = TX.values({ttx: files[BR], pair: brPair, aim: brOld, shells: brShells});
    ok('ttx v2: the Black Rock of a record before 0.7.27 (no gunMechanics) - Gun Loading and the rate as with its chargeable burst named (the review\'s 5.78 instead of 10.07)',
       brPair.aim.gunMechanics.indexOf('chargeableBurst') >= 0 && vOld.kind === 'single' && TX.display(vOld).reloadTimeSecs === TX.display(vNew).reloadTimeSecs
       && Math.abs(vOld.shotsPerMinute - vNew.shotsPerMinute) < 1e-9 && !vOld.burstFireRate,
       TX.display(vOld).reloadTimeSecs + ' / ' + TX.display(vNew).reloadTimeSecs);
    // The glyphs of the line: the continuous fire a belt of its own, never the rate of fire's; the salvo preparation its own.
    const partOf = function (veh, key) {
      const r = ref.filter(function (x) { return x.vehicle === veh; })[0], P = r && page[[r.vehicle, r.turret, r.gun, r.mode].join('|')];
      return P ? P.line.filter(function (x) { return x.key === key; })[0] || null : null;
    };
    const blesk = partOf('czech:Cz24_Vz_64_Blesk', 'continuousShotsPerMinute'), ares = partOf('usa:A189_Ares_90', 'continuousShotsPerMinute'), salvo = partOf('ussr:R169_ST_II', 'chargeTime');
    ok('ttx v2: the continuous fire (Blesk, Ares) wears its own glyph, not the rate of fire\'s; the ST-II\'s salvo preparation 2.5/3 its own, with the garage\'s line in the tooltip',
       !!blesk && blesk.glyph === 'spmHold' && !!ares && ares.glyph === 'spmHold' && !!salvo && salvo.glyph === 'salvo' && salvo.text === '2.5/3'
       && /Hold the trigger to charge a salvo/.test(salvo.title), JSON.stringify([blesk && blesk.glyph, ares && ares.glyph, salvo && salvo.glyph, salvo && salvo.text]));
    // The quick list and the Turret row on the Blesk: two turrets x the same two guns, 1350 / 1400 HP.
    const bi = ref.map(function (r) { return r.vehicle + '|' + r.turret + '|' + r.gun; }).indexOf('czech:Cz24_Vz_64_Blesk|Turret_1_Cz24_Vz_64_Blesk|_30_mm_protiletadlovy_dvojkanon_vz_53');
    document.getElementById('hits').children[bi].onclick();
    return settle(20).then(function () {
      const pairTile = document.getElementById('ttx-pair'), pairsBox = document.getElementById('ttx-pairs'), list = document.getElementById('ttx-pair-list');
      const turrets = document.getElementById('aim-cfg-turrets');
      pairTile.onclick({preventDefault: function () {}});
      const tiles = list.children[0].children;
      ok('ttx v2: the gun chip of a two-turret vehicle - ▾ for the two guns of ITS turret, and the tooltip sends the turret to Config',
         pairsBox.getAttribute('data-many') === 'true' && /\n• Click: another gun of this turret/.test(pairTile.title) && /picked in Config, in its Turret row/.test(pairTile.title));
      ok('ttx v2: the quick list holds only the guns of the turret on the panel - 2 of the 4 pairs, the one shown pressed',
         list.children.length === 1 && tiles.length === 2 && tiles[0].getAttribute('aria-pressed') === 'true'
         && tiles.every(function (t) { return /\n• Turret: /.test(t.title) && /\n• Tier: /.test(t.title); }), tiles.map(function (t) { return t.title.slice(0, 60); }).join(' | '));
      ok('ttx v2: the Turret row of Config - there for two turrets, its label with it, the turret on the panel pressed, ● the fired one, ▲ the top one',
         turrets.hidden === false && turrets.children.length === 2 && turrets.children[0].getAttribute('aria-pressed') === 'true'
         && turrets.children[0].children[0].getAttribute('data-glyph') === 'turret' && turrets.children[0].children.some(function (c) { return c.textContent === '●'; })
         && turrets.children[1].children.some(function (c) { return c.textContent === '▲'; }) && /^Turret: /.test(turrets.children[1].title));
      const hpOf = function () { return document.getElementById('ttx-hp').children[0].ttx.value.textContent; };
      const hp0 = hpOf();
      click(turrets.children[1]);
      const stored = storedAim().pairs['czech:Cz24_Vz_64_Blesk'];
      ok('ttx v2: a turret picked in Config changes the pair on the panel - the same gun on the other turret, its HP (1350 -> 1400), kept per type, the gun chip lit',
         hp0 === '1350' && hpOf() === '1400'
         && stored === 'Turret_2_Cz24_Vz_64_Blesk|_30_mm_protiletadlovy_dvojkanon_vz_53' && turrets.children[1].getAttribute('aria-pressed') === 'true'
         && pairsBox.getAttribute('data-other') === 'true', hp0 + ' ' + stored);
      pairTile.onclick({preventDefault: function () {}});
      const t2 = list.children[0].children;
      ok('ttx v2: and the quick list now lists the other turret\'s guns, the gun kept pressed; a gun picked there keeps the turret',
         t2.length === 2 && t2[0].getAttribute('aria-pressed') === 'true' && (click(t2[1]), storedAim().pairs['czech:Cz24_Vz_64_Blesk'] === 'Turret_2_Cz24_Vz_64_Blesk|_37_mm_automaticky_dvojkanon'),
         storedAim().pairs['czech:Cz24_Vz_64_Blesk']);
      click(turrets.children[0]);
      ok('ttx v2: back on the first turret it takes the same gun there (the 37 mm)', storedAim().pairs['czech:Cz24_Vz_64_Blesk'] === 'Turret_1_Cz24_Vz_64_Blesk|_37_mm_automaticky_dvojkanon');
      // Review 23.09: one paint counts the emulator's pair once (ttxPaint hands it down); a warm repaint asks TTX.match once.
      const keepMatch = TX.match;
      let matches = 0;
      click(document.getElementById('ttx-build-toggle'));
      TX.match = function () { matches++; return keepMatch.apply(this, arguments); };
      click(document.getElementById('ttx-build-toggle'));
      TX.match = keepMatch;
      // 24.09: the pairs are the owner's (emuIndexes), counted once per file, shooter and pick - a warm repaint asks none.
      ok('ttx v2: a repaint of the panel counts the emulator\'s pair at most once - the chip, the Turret row and the rows take it from the owner', matches <= 1, '(' + matches + ' TTX.match calls)');
      // Review 23.09: Config away (the aim emulation off; also a record without its block, the parts view) - the turret
      // could not be picked at all; the quick list then carries the turret tiles of Config's Turret row, the same widget.
      switchOn(false);
      const cfgAway = document.getElementById('aim-config').hidden === true;
      pairTile.onclick({preventDefault: function () {}});
      const rows = list.children;
      ok('ttx v2: Config away - the chip says so, and its quick list carries the turret tiles above the guns (the same tiles as Config\'s Turret row)',
         cfgAway && pairsBox.getAttribute('data-many') === 'true' && /Config, where the turret is picked, is not on screen now/.test(pairTile.title) && !/in its Turret row/.test(pairTile.title)
         && rows.length === 2 && rows[0].getAttribute('data-turrets') === 'true' && rows[0].children.length === 2 && rows[0].children[0].getAttribute('aria-pressed') === 'true'
         && rows[0].children[0].children[0].getAttribute('data-glyph') === 'turret' && /^Turret: /.test(rows[0].children[1].title) && rows[1].children.length === 2,
         pairTile.title.slice(-120) + ' | rows ' + rows.length);
      click(rows[0].children[1]);
      ok('ttx v2: a turret picked in that list moves the panel to it, the gun kept, the list closed',
         storedAim().pairs['czech:Cz24_Vz_64_Blesk'] === 'Turret_2_Cz24_Vz_64_Blesk|_37_mm_automaticky_dvojkanon' && pairsBox.open === false,
         storedAim().pairs['czech:Cz24_Vz_64_Blesk']);
      switchOn(true);
      pairTile.onclick({preventDefault: function () {}});
      ok('ttx v2: Config back - the chip sends the turret to Config again and the list holds the guns only',
         /picked in Config, in its Turret row/.test(pairTile.title) && list.children.length === 1 && list.children[0].getAttribute('data-turrets') === null);
      click(turrets.children[0]);
      // The markup of the panel (24.09): the mode switch on its left; then the row of the panel's controls (⚙, ▴ and the
      // one help dot, which names the panel's clickable elements in their order), the head (HP, the gun chip) and the table.
      const m = /<div id="ttx-inner" class="ttx-inner">(.*?)<div id="ttx-compact" class="ttx-body">/.exec(pageSrc), inner = m ? m[1] : '';
      const tm = /<div class="ttx-tools">(.*?)<\/div><div class="ttx-head">(.*)$/.exec(inner), tools = tm ? tm[1] : '', head = tm ? tm[2] : '';
      const dot = /<button type="button" class="help-dot" data-help-for="([^"]+)" aria-label="Help">\?<\/button>/.exec(tools);
      const ids = dot ? dot[1].split(' ') : [], at = ids.map(function (id) { return inner.indexOf('id="' + id + '"'); });
      ok('ttx v2: the controls row has one help dot naming the panel\'s clickable elements in their order - the mode switch, ⚙, ▴, the gun chip',
         !!dot && ids.join(' ') === 'ttx-mode ttx-build-toggle ttx-more-button ttx-pair' && at.every(function (x, k) { return x >= 0 && (k === 0 || x > at[k - 1]); }),
         inner.slice(0, 80));
      ok('ttx 24.09: the panel\'s controls on a row of their own above the head - the mode switch at its left end, then ⚙, ▴ and "?"; the head is the HP and the gun chip',
         inner.indexOf('<div class="ttx-main"><div class="ttx-tools"><button type="button" id="ttx-mode" class="swap-roles"') === 0
         && /^<button type="button" id="ttx-mode"[^>]*>◐<\/button><button type="button" id="ttx-build-toggle"/.test(tools) && tools.indexOf('id="ttx-more"') > 0 && tools.indexOf('id="ttx-pair"') < 0
         && /\.ttx-tools>#ttx-mode\{margin-right:auto\}/.test(fs.readFileSync(path + 'style.css', 'utf8'))
         && /^<span id="ttx-hp" class="ttx-hp"><\/span><details id="ttx-pairs"[^]*<\/details><\/div>$/.test(head), inner.slice(0, 120));
      // Review 23.09: every "?" of the page is the one help dot - no ⓘ left: the Statistics log's is a .help-dot on its
      // words, the vehicle list's summary wears the dot (its own box of help opens under it).
      ok('help marks: one look - no ⓘ left in the page; the Statistics log has a help dot on its words, the vehicle list\'s help is a .help-dot summary',
         pageSrc.indexOf('\u24d8') < 0 && pageSrc.indexOf('info-mark') < 0
         && /<span id="connection">Statistics log<\/span><button type="button" class="help-dot" data-help-for="ttx-sweep ttx-sweep-stop connection" aria-label="Help"[^>]*>\?<\/button>/.test(pageSrc)
         && /<summary id="vehicle-info" class="help-dot"[^>]*>\?<\/summary>/.test(pageSrc));
      // Put the page back as the sections before it left it.
      global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.ttx = keepTtx; global.ArmorInspectorData.scene = keepScene;
    });
  });
}).then(function () {
  // ---- GUN SWITCH ON A VEHICLE WITH A SECOND MODE (24.09, gun-switch-owner) --------------------------------------------
  // No siege vehicle of the offline files carries two guns, so one is made of the Kunze Panzer's own file (its reload is
  // 9.3 s in travel and 12.3 s in siege): a second pair of the same turret whose gun is the same gun with other numbers
  // in BOTH mode blocks. Picked on the first pair's hit under ✸, the emulator must run the picked gun in each mode - its
  // travel block first, and after the mode button its siege block - exactly as that pair's own recorded hit does.
  const KDIR = process.env.BULLBA_TTX_MODES_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx-modes/';
  const KFILE = KDIR + 'germany-G147_Kunze_Panzer.js';
  if (!fs.existsSync(KFILE)) { console.log('SKIP (the Kunze Panzer file is not on this machine: ' + KFILE + ')'); return; }
  let K = null;
  new Function('ArmorInspectorData', fs.readFileSync(KFILE, 'utf8'))({receive: function (x) { K = x[1]; }});
  K.id = 'germany-SwKunze'; K.type = 'germany:SwKunze';
  const p0 = K.configs.filter(function (c) { return c.top; })[0] || K.configs[0];
  const other = function (b) { return Object.assign({}, b, {dispersion: b.dispersion * 1.5, aimingTime: b.aimingTime * 0.8, reloadTime: b.reloadTime * 2}); };
  const p1 = Object.assign({}, p0, {gun: p0.gun + '_B', gunUserString: 'Gun B', top: false, aim: other(p0.aim), modeAim: other(p0.modeAim)});
  K.configs = [p0, p1];
  K.shells = Object.assign({}, K.shells);
  K.shells[p1.gun] = (K.shells[p0.gun] || []).map(function (s) { return Object.assign({}, s, {name: 'B ' + s.name, caliber: s.caliber + 5}); });
  const tname = K.turrets[p0.turret].name;
  const parts = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const hitOf = function (id, p) {
    return {id: id, attackerId: 40, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: 'SwKunze', type: K.type, gun: p.gunUserString, gunName: p.gun, turretName: tname, aim: p.aim, vehicleMode: 0,
                       parts: parts(), gunDispersion: 0.00383},
            target: {name: 'Beta', type: 'germany:Beta', parts: parts(), maxHealth: 1850}, warnings: []};
  };
  const KBATTLE = {id: 't-swk', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: [hitOf('swk-0', p0), hitOf('swk-1', p1)]};
  const keepBattle = global.ArmorInspectorData.battle, keepTtx = global.ArmorInspectorData.ttx, keepScene = global.ArmorInspectorData.scene;
  global.ArmorInspectorData.battle = function (id) { return id === 't-swk' ? Promise.resolve(KBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  global.ArmorInspectorData.ttx = function (id) { return id === K.id ? Promise.resolve(K) : keepTtx ? keepTtx(id) : Promise.reject(new Error('none')); };
  const tb = document.getElementById('battles');
  tb.value = 't-swk'; tb.onchange.call(tb);
  const mech = document.getElementById('aim-gun-mech'), reload = document.getElementById('aim-gun-reload');
  const onBefore = onBox.checked;
  const state = function () { tick(0.05); return {reload: reload.textContent, ring: viewerInstance.liveRadius100 ? viewerInstance.liveRadius100.toFixed(6) : null, mech: mech.hidden ? '' : mech.getAttribute('aria-pressed') + '|' + mech.title}; };
  // Both modes of the gun on screen: travel, then the mode button and the switch time run out, siege.
  const modes = function () {
    const travel = state();
    click(mech); tick(6); const siege = state();
    click(mech); tick(6);
    return {travel: travel, siege: siege};
  };
  let switched = null, own = null, recorded = null;
  return settle(20).then(function () {
    switchOn(true);
    click(document.getElementById('fun-mode-toggle'));
    document.getElementById('hits').children[0].onclick();
    return settle(20);
  }).then(function () {
    recorded = modes();
    document.getElementById('ttx-pair').onclick({preventDefault: function () {}});
    const row = document.getElementById('ttx-pair-list').children.filter(function (c) { return c.className === 'aim-pick-row' && c.getAttribute('data-turrets') === null; })[0];
    click(row.children.filter(function (x) { return x.getAttribute('aria-label') === 'Gun B'; })[0]);
    switched = modes();
    switched.caliber = document.getElementById('caliber').value;
    document.getElementById('hits').children[1].onclick();
    return settle(20);
  }).then(function () {
    own = modes();
    ok('gun switch, second mode: the picked gun runs in both modes - its travel reload and circle, and after the mode button its siege ones (not the recorded gun\'s)',
       switched.travel.reload !== recorded.travel.reload && switched.siege.reload !== recorded.siege.reload && switched.travel.reload !== switched.siege.reload
       && switched.travel.ring !== recorded.travel.ring && switched.caliber === (K.shells[p1.gun][0] || {}).caliber,
       JSON.stringify({rec: [recorded.travel.reload, recorded.siege.reload], sw: [switched.travel.reload, switched.siege.reload], cal: switched.caliber}));
    ok('gun switch, second mode: exactly what the picked pair\'s own recorded hit shows - reload, live ring and the mode button, in travel and in siege',
       JSON.stringify(switched.travel) === JSON.stringify(own.travel) && JSON.stringify(switched.siege) === JSON.stringify(own.siege),
       ['travel', 'siege'].map(function (m) { return ['reload', 'ring', 'mech'].filter(function (f) { return switched[m][f] !== own[m][f]; }).map(function (f) { return m + '.' + f + ': ' + switched[m][f] + ' / ' + own[m][f]; }).join(' | '); }).join(' || '));
    // Give the choice back to the record (Gun B picked on its own hit), and the page back to the sections after.
    document.getElementById('ttx-pair').onclick({preventDefault: function () {}});
    const row = document.getElementById('ttx-pair-list').children.filter(function (c) { return c.className === 'aim-pick-row' && c.getAttribute('data-turrets') === null; })[0];
    click(row.children.filter(function (x) { return x.getAttribute('aria-pressed') === 'true'; })[0]);
    click(document.getElementById('fun-mode-toggle'));
    switchOn(onBefore);
    global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.ttx = keepTtx; global.ArmorInspectorData.scene = keepScene;
  });
}).then(function () {
  // ---- parts (23.09, BACKLOG 33): the outer track pair of a double-track vehicle is collision part 4 ----------
  // The page takes every part a record lists: web/local-data.js loads part 4's model like the four, the scene is
  // complete only with it, the old warning still withholds a scene whose extra part is missing, and the engine
  // (web/ballistics.js) puts part 4's triangles in the ray, so a side shot meets the outer track as a screen of its
  // own before the inner track and the hull. Run in a context of its own, with a document that serves the models.
  // The engine mirrors z (ballistics.js transform), so the short inner track at model z -2..0 sits at +0..2 there.
  const vm = require('node:vm');
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function box(material, lo, hi) {
    const v = [];
    for (let i = 0; i < 8; i++) v.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]], idx = [];
    f.forEach(function (q) { idx.push(q[0], q[1], q[2], q[0], q[2], q[3]); });
    return {kind: 'client-shot-collision', groups: [{material: material, vertices: v, indices: idx}]};
  }
  const K = function (n) { return String(n).repeat(64); };
  const MODELS = {};
  MODELS[K(1)] = box('rightTrack', [1.1, 0, -2], [1.4, 1, 0]);      // part 0: the inner track, short
  MODELS[K(2)] = box('armor_1', [-1, 0.2, -3], [1, 1.5, 3]);        // part 1: the hull
  MODELS[K(3)] = box('armor_1', [-0.8, 1.5, -1], [0.8, 2.2, 1]);    // part 2: the turret
  MODELS[K(4)] = box('armor_1', [-0.1, 1.8, 1], [0.1, 2, 4]);       // part 3: the gun
  MODELS[K(5)] = box('rightTrack', [1.5, 0, -3], [1.7, 1.1, 3]);    // part 4: the outer track, full length
  const TRACK = function (mm) { return {rightTrack: {armor: mm, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, collideOnceOnly: true}}; };
  const HULL = {armor_1: {armor: 40, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, collideOnceOnly: false}};
  function target(extra) {
    const parts = [[0, 'chassis', TRACK(20)], [1, 'hull', HULL], [2, 'turret', HULL], [3, 'gun', HULL], [4, 'trackPair1', TRACK(20)]]
      .map(function (p) { return {id: p[0], name: p[1], modelKey: K(p[0] + 1), transform: I.slice(), armor: p[2]}; });
    if (extra) extra(parts);
    return {name: 'Ares 90', parts: parts};
  }
  const ctx = {Promise, Date, setTimeout, clearTimeout, console, Object, Array, JSON};
  ctx.window = ctx;
  ctx.document = {
    createElement: function () { return {remove: function () {}}; },
    head: {appendChild: function (script) {
      const key = /data\/models\/([a-f0-9]{64})\.js/.exec(script.src);
      setTimeout(function () {
        if (key && MODELS[key[1]]) { ctx.ArmorInspectorData.receive(['model:' + key[1], MODELS[key[1]]]); script.onload(); }
        else script.onerror();
      }, 0);
    }}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path + 'local-data.js', 'utf8'), ctx);
  const scene = function (hit) { return ctx.ArmorInspectorData.sceneFor({warnings: []}, hit); };
  const WARN = 'Additional vehicle parts are not yet rendered';
  return Promise.all([
    scene({id: 'p1', target: target(), points: [], warnings: []}),
    scene({id: 'p2', target: target(function (p) { p.pop(); }), points: [], warnings: [WARN]}),
    scene({id: 'p3', target: target(function (p) { delete p[4].modelKey; p[4].modelPending = true; }), points: [], warnings: []}),
    scene({id: 'p4', target: target(function (p) { p.pop(); }), points: [], warnings: []}),
    // 24.09: a vehicle browsed without its model (app.js ttxRecord): no parts by design.
    scene({id: 'p5', target: {name: 'X', parts: [], noModel: 'Model not exported yet.'}, points: [], warnings: []})
  ]).then(function (s) {
    ok('noModel: a vehicle without its model gets no geometry, its own words as the reason and no warning (web/local-data.js sceneFor)',
       s[4].geometryIncomplete === true && s[4].geometryError === 'Model not exported yet.' && !s[4].warnings.length && !Object.keys(s[4].models).length);
    ok('outer track: a record with part 4 loads its model like the four, and the scene is complete',
       Object.keys(s[0].models).sort().join() === '0,1,2,3,4' && !s[0].geometryError && !s[0].warnings.length,
       '(' + Object.keys(s[0].models).join() + ' ' + s[0].warnings.join('; ') + ')');
    ok('outer track: an old record with the extra-parts warning is still withheld, as before',
       s[1].geometryIncomplete === true && s[1].geometryError === 'This vehicle has unsupported collision parts.' && !Object.keys(s[1].models).length);
    ok('outer track: part 4 still on its way withholds the scene until it arrives (no half vehicle)',
       s[2].geometryIncomplete === true && s[2].geometryError === 'Complete vehicle model unavailable.'
       && s[2].warnings.some(function (w) { return /^trackPair1: /.test(w); }));
    ok('outer track: a vehicle recorded with the four parts and no warning reads exactly as before',
       Object.keys(s[3].models).sort().join() === '0,1,2,3' && !s[3].geometryError);
    const B = window.ArmorBallistics, engine = B.build(s[0]), shot = B.shell('ARMOR_PIERCING', 100, 30);
    const outer = engine.triangles.filter(function (t) { return t.part === 4; });
    ok('outer track: the engine takes part 4\'s triangles with its own armour table',
       outer.length === 12 && outer.every(function (t) { return t.name === 'rightTrack' && t.armor && t.armor.armor === 20; }));
    const r = engine.ray([10, 0.6, 1], [-1, 0, 0], shot);
    const way = (r.layers || []).map(function (l) { return l.part + ':' + l.material + ':' + l.nominal; }).join(' ');
    ok('outer track: a side shot meets the outer track, then the inner track, then the hull - each track once (collideOnceOnly per part)',
       way === '4:rightTrack:20 0:rightTrack:20 1:armor_1:40' && r.reason === 'penetration', '(' + way + ' ' + r.reason + ')');
    const r2 = engine.ray([10, 0.6, -1], [-1, 0, 0], shot);
    const way2 = (r2.layers || []).map(function (l) { return l.part + ':' + l.material; }).join(' ');
    ok('outer track: ahead of the short inner track the outer track alone screens the hull',
       way2 === '4:rightTrack 1:armor_1', '(' + way2 + ')');
    const without = B.build(s[3]).ray([10, 0.6, 1], [-1, 0, 0], shot);
    ok('outer track: the outer track screen costs the shell its 20 mm (the verdict changes by exactly that layer)',
       r.effective - without.effective === 20 && without.layers.length === 2, '(' + r.effective + ' vs ' + without.effective + ')');
    ok('outer track: the Statistics log names part 4 trackPair1 (tools/verdicts_offline.cjs reads this literal)',
       appSrc.indexOf("partNames=['chassis','hull','turret','gun','trackPair1']") !== -1);
    ok('outer track: the hit details call a contact on part 4 the outer track, and an unknown part by its number',
       appSrc.indexOf("['Chassis','Hull','Turret','Gun','Outer track'][point.part]||'Part '+point.part") !== -1);
    ok('outer track: the viewer colours part 4 as the chassis (part % 4) and puts it with the tracks (vehicleDamageFactor 0)',
       viewerSrc.indexOf('baseColors[t.part%4]') !== -1 && viewerSrc.indexOf('function externalLayer(t){return t.part===0||') !== -1);
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- BACKLOG 40 (23.09): the gun's horizontal sector and the tilted turret ring, on the REAL viewer.js ------------
  const T3 = global.THREE, RealViewer = global.RealViewerCtor, D = Math.PI / 180, B = window.ArmorBallistics;
  function azimuthOf(p, eye) { const d = p.clone().sub(eye); return Math.atan2(-d.x, d.z); }
  function turnOf(from, to, eye) { const t = azimuthOf(to, eye) - azimuthOf(from, eye); return Math.atan2(Math.sin(t), Math.cos(t)); }
  function elevationOf(p, eye) { return Math.asin(p.clone().sub(eye).normalize().y); }
  // (a) The chase stops at the sector. A camera 19.5 m in front of a wide wall (front face z = 0.5), so every point the
  // gun is turned to lies on the model; the camera looks down -z, so screen-right is +x and a right turn is positive.
  const w = Object.create(RealViewer.prototype);
  w.scene = new T3.Scene();
  w.camera = new T3.PerspectiveCamera(38, 800 / 600, .1, 1000);
  w.camera.position.set(0, 2, 20); w.camera.lookAt(0, 1, 0); w.camera.updateMatrixWorld();
  const wall = new T3.BoxGeometry(80, 12, 1); wall.translate(0, 1, 0);
  w.paintMesh = new T3.Mesh(wall, new T3.MeshBasicMaterial()); w.scene.add(w.paintMesh); w.scene.updateMatrixWorld(true);
  w.bounds = new T3.Box3().setFromObject(w.paintMesh); w.target = new T3.Vector3(0, 1, 0);
  w.reticleLayer = new Element('div'); w.viewWidth = 800; w.viewHeight = 600;
  w.draw = function () {}; w.liveRadius100 = .4; w.aimChase = true; w.spreadAim = null; w.aimReloadPart = null; w.aimCentred = null; w.aimYaw = 0;
  const eye = w.camera.position, L = [-3 * D, 3 * D], start = new T3.Vector3(0, 1, .5), far = new T3.Vector3(5, 1, .5);
  w.liveAimPoint = start.clone(); w.aimCursorPoint = far.clone();
  const cursorOff = turnOf(start, far, eye);
  const g0 = w.aimGap(null), g1 = w.aimGap(L), plain = start.clone().sub(eye).normalize().angleTo(far.clone().sub(eye).normalize());
  ok('sector: without a sector the gap is the whole angle to the cursor, exactly as before',
     g0 === plain && Math.abs(cursorOff - Math.atan(5 / 19.5)) < 1e-12, '(' + (g0 / D).toFixed(3) + '°)');
  ok('sector: with ±3° the gap is only the way to the limit - the cursor 14.4° to the right is out of reach',
     Math.abs(g1 - 3 * D) < 0.02 * D, '(' + (g1 / D).toFixed(4) + '°)');
  const moved1 = w.chaseAim(1, L), at1 = w.liveAimPoint.clone();
  ok('sector: the chase takes the gun to the right limit and no further - its yaw on the hull is exactly +3° - and the point stays on the armour',
     moved1 === true && Math.abs(w.aimYaw - 3 * D) < 1e-9 && Math.abs(turnOf(start, at1, eye) - 3 * D) < 1e-9 && Math.abs(at1.z - .5) < 1e-9,
     '(yaw ' + (w.aimYaw / D).toFixed(6) + '°, turned ' + (turnOf(start, at1, eye) / D).toFixed(6) + '°)');
  ok('sector: at the limit there is nothing left to turn: no gap, no move, the ring stays where it is',
     w.aimGap(L) < 1e-9 && w.chaseAim(1, L) === false && w.liveAimPoint.distanceTo(at1) === 0 && w.aimGap(null) > 11 * D);
  const chaseStopped = B.turretChase(w.aimGap(L), 20 * D, {turretRotationSpeed: 30 * D}, null, 1 / 60, true);
  ok('sector: and the circle gets no turret term from it - the formula sees the hull turning and the turret still (caught, rate 0)',
     chaseStopped.turretTurn === 0 && chaseStopped.rate === 0 && chaseStopped.caught === true);
  // The hull turns right 5°: it carries the gun, whose yaw on the hull stays at the limit; the cursor is still 6.4° off.
  w.turnAim(5 * D); const at2 = w.liveAimPoint.clone();
  const moved2 = w.chaseAim(1, L), at3 = w.liveAimPoint.clone();
  ok('sector: the hull turned 5° right carries the gun with it, its yaw on the hull stays +3°, and the gun still stops short of the cursor',
     Math.abs(turnOf(at1, at2, eye) - 5 * D) < 1e-9 && Math.abs(w.aimYaw - 3 * D) < 1e-9 && Math.abs(turnOf(at3, far, eye) - (cursorOff - 8 * D)) < 1e-9
     && w.aimCursorPoint.distanceTo(far) === 0,
     '(chase ' + moved2 + ', yaw ' + (w.aimYaw / D).toFixed(6) + '°, the cursor ' + (turnOf(at3, far, eye) / D).toFixed(3) + '° to the right)');
  // Ten more: the cursor is now inside the sector, 3.6° to the left of the gun - the gun catches it.
  w.turnAim(10 * D); const at4 = w.liveAimPoint.clone(), back = turnOf(at4, far, eye);
  const moved3 = w.chaseAim(1, L);
  ok('sector: ten more degrees of hull and the cursor is back inside the sector: the gun catches it exactly, its yaw now +3° less the way back',
     moved3 === true && w.liveAimPoint.distanceTo(far) < 1e-9 && Math.abs(w.aimYaw - (3 * D + back)) < 1e-9 && back < 0,
     '(yaw ' + (w.aimYaw / D).toFixed(4) + '°)');
  // The left limit and the elevation: an asymmetric sector, a cursor high up and far to the left.
  w.liveAimPoint = start.clone(); w.aimYaw = 0; w.aimCursorPoint = new T3.Vector3(-10, 4, .5);
  const L2 = [-.1, .05];
  w.chaseAim(1, L2);
  ok('sector: the LEFT limit is the first of the pair (negative), and the gun at it takes the cursor’s elevation',
     Math.abs(w.aimYaw + .1) < 1e-9 && Math.abs(turnOf(start, w.liveAimPoint, eye) + .1) < 1e-9
     && Math.abs(elevationOf(w.liveAimPoint, eye) - elevationOf(w.aimCursorPoint, eye)) < 1e-9 && w.liveAimPoint.y > 1,
     '(yaw ' + w.aimYaw.toFixed(6) + ', elevation ' + (elevationOf(w.liveAimPoint, eye) / D).toFixed(4) + '° vs ' + (elevationOf(w.aimCursorPoint, eye) / D).toFixed(4) + '°)');
  w.aimCursorPoint = new T3.Vector3(10, 1, .5); w.chaseAim(1, L2);
  ok('sector: and the right one the second (+0.05): the whole sector is 0.15 rad wide',
     Math.abs(w.aimYaw - .05) < 1e-9, '(yaw ' + w.aimYaw.toFixed(6) + ')');
  // A step shorter than the way to the limit is an ordinary step.
  w.liveAimPoint = start.clone(); w.aimYaw = 0; w.aimCursorPoint = far.clone();
  w.chaseAim(1 * D, L);
  ok('sector: a step shorter than the way to the limit turns the gun by just that step',
     Math.abs(start.clone().sub(eye).angleTo(w.liveAimPoint.clone().sub(eye)) - 1 * D) < 1e-9 && Math.abs(w.aimYaw - turnOf(start, w.liveAimPoint, eye)) < 1e-12);
  // No sector: the gun goes all the way, as before.
  w.liveAimPoint = start.clone(); w.aimYaw = 0; w.aimCursorPoint = far.clone();
  ok('sector: without a sector the chase reaches the cursor as before',
     w.chaseAim(1, null) === true && w.liveAimPoint.distanceTo(far) === 0 && Math.abs(w.aimYaw - cursorOff) < 1e-12);
  // A tank destroyer's ±15° sector, the cursor 25° to the right, the chase at a 30°/s turret over 1/60 s frames: the gun
  // stops at +15°, the turret term vanishes there while the cursor is still 10° away, and the hull (D) carries it on.
  {
    const L15 = [-15 * D, 15 * D], wide = new T3.Vector3(19.5 * Math.tan(25 * D), 1, .5), aim15 = {turretRotationSpeed: 30 * D};
    w.liveAimPoint = start.clone(); w.aimYaw = 0; w.aimCursorPoint = wide.clone();
    let frames = 0, last = null;
    for (; frames < 120; frames++) {
      last = B.turretChase(w.aimGap(L15), 0, aim15, null, 1 / 60, false);
      if (!(last.step > 1e-9)) break;
      w.chaseAim(last.step, L15);
    }
    const stopped = w.aimYaw, left = turnOf(w.liveAimPoint, wide, eye);
    ok('sector ±15°: a tank destroyer’s gun chased at 30°/s stops at +15° (half a second), the cursor still 10° beyond, and the turret term is gone',
       Math.abs(stopped - 15 * D) < 1e-9 && Math.abs(left - 10 * D) < 1e-9 && last.turretTurn < 1e-5 && last.caught === true && frames >= 30 && frames <= 32,
       '(yaw ' + (stopped / D).toFixed(6) + '°, ' + frames + ' frames, the cursor ' + (left / D).toFixed(4) + '° on, turret term ' + last.turretTurn + ')');
    // D for 6°: the hull swings the gun on; the turret still sits at +15° and adds nothing, only the hull term remains.
    w.turnAim(6 * D);
    const riding = B.turretChase(w.aimGap(L15), 20 * D, aim15, null, 1 / 60, true);
    ok('sector ±15°: the hull turned 6° carries the gun 6° on with no turret term (yaw still +15°, the cursor 4° on)',
       Math.abs(w.aimYaw - 15 * D) < 1e-9 && riding.turretTurn < 1e-5 && Math.abs(turnOf(w.liveAimPoint, wide, eye) - 4 * D) < 1e-9,
       '(yaw ' + (w.aimYaw / D).toFixed(6) + '°, turret term ' + riding.turretTurn + ')');
    // Six more: the cursor 2° to the left, inside the sector - the turret takes over again and catches it.
    w.turnAim(6 * D);
    const back2 = B.turretChase(w.aimGap(L15), 0, aim15, null, 1 / 60, false);
    for (let f = 0, c = back2; f < 30 && c.step > 1e-9; f++) { w.chaseAim(c.step, L15); c = B.turretChase(w.aimGap(L15), 0, aim15, null, 1 / 60, false); }
    ok('sector ±15°: six more degrees of hull and the turret catches the cursor 2° back at its full 30°/s term (yaw +13°)',
       Math.abs(back2.turretTurn - 30 * D) < 1e-12 && w.liveAimPoint.distanceTo(wide) < 1e-9 && Math.abs(w.aimYaw - 13 * D) < 1e-9,
       '(yaw ' + (w.aimYaw / D).toFixed(6) + '°, turret term ' + (back2.turretTurn / D).toFixed(2) + '°/s)');
  }
  // The gun put down straight on a point has the hull facing it: the held centre, and the hold let go gives the old yaw back.
  w.liveAimPoint = at1.clone(); w.aimCursorPoint = far.clone(); w.aimYaw = 3 * D;
  w.setAimCentre(true, 'dot'); const heldYaw = w.aimYaw;
  w.setAimCentre(false); const backYaw = w.aimYaw;
  w.aimYaw = .02; w.clearLiveAim();
  ok('sector: the held centre puts the gun down with the hull facing it (0), letting go gives the gun and its yaw back, a new model starts at 0',
     heldYaw === 0 && backYaw === 3 * D && w.liveAimPoint === null && w.aimYaw === 0);

  // (b) The tilted ring. The collision assembly of the client puts the turret node at the hull's turretPitches[0] and
  // turns the turret RotateY(yaw) under it (model_assembler.prepareCollisionAssembler: addNode(turretJoint, 'V',
  // createRTMatrix(Vector3(0, turretPitches[0], 0), turretPositions[0]))), so a recorded turret is hull x T x tilt x
  // RotateY(yaw). A hull on a slope, the CC-67's 11.07° ring, a turret recorded at 20°.
  const F = new T3.Matrix4().makeScale(1, 1, -1);
  function tilted(tilt, yaw0) {
    const hull = new T3.Matrix4().makeRotationY(.4).multiply(new T3.Matrix4().makeRotationX(.05)).setPosition(.2, .6, -.1);
    const ring = hull.clone().multiply(new T3.Matrix4().makeTranslation(0, 1.6, .4)).multiply(new T3.Matrix4().makeRotationX(tilt));
    const turret = ring.clone().multiply(new T3.Matrix4().makeRotationY(yaw0));
    const gun = turret.clone().multiply(new T3.Matrix4().makeTranslation(0, .4, 1.2));
    const v = Object.create(RealViewer.prototype);
    v.loadedData = {hit: {aim: [yaw0, 0], target: {parts: [{id: 1, transform: hull.toArray()}, {id: 2, transform: turret.toArray()}, {id: 3, transform: gun.toArray()}]}}, models: {}};
    v.turretAngle = 0; v.gunAngle = 0;
    return {v: v, hull: hull, ring: ring, turret: turret, gun: gun};
  }
  function worst(a, b) { let m = 0; for (let i = 0; i < 16; i++) m = Math.max(m, Math.abs(a.elements[i] - b.elements[i])); return m; }
  // The pose the hull's vertical gave until 23.09, for the comparison.
  function oldTurret(t, degrees) {
    const pivot = new T3.Vector3().setFromMatrixPosition(t.turret), axis = new T3.Vector3(0, 1, 0).transformDirection(t.hull);
    return new T3.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new T3.Matrix4().makeRotationAxis(axis, degrees * D))
      .multiply(new T3.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)).multiply(t.turret);
  }
  const cc = tilted(11.07 * D, 20 * D), tiltErr = {};
  [90, 180, -135].forEach(function (deg) {
    cc.v.turretAngle = deg;
    const extra = cc.v.poseExtra(), posed = extra[2].clone().multiply(cc.turret), want = cc.ring.clone().multiply(new T3.Matrix4().makeRotationY((20 + deg) * D));
    const ringUp = new T3.Vector3(0, 1, 0).transformDirection(cc.ring);
    tiltErr[deg] = {now: worst(posed, want), oldLean: new T3.Vector3(0, 1, 0).transformDirection(oldTurret(cc, deg)).angleTo(ringUp) / D,
                    gun: worst(extra[3].clone().multiply(cc.gun), want.clone().multiply(new T3.Matrix4().makeTranslation(0, .4, 1.2)))};
  });
  ok('tilted ring: the turret turned 90°, 180° and -135° is exactly hull x T x tilt x RotateY(20° + turn) - the client’s own composition - and the gun rides it',
     [90, 180, -135].every(function (d) { return tiltErr[d].now < 1e-12 && tiltErr[d].gun < 1e-12; }),
     '(' + [90, 180, -135].map(function (d) { return d + '°: ' + tiltErr[d].now.toExponential(1) + '/' + tiltErr[d].gun.toExponential(1); }).join(', ') + ')');
  ok('tilted ring: (the hull’s vertical used until 23.09 leaned the turret off its ring by up to 2 x 11.07° = 22.14° after half a turn)',
     Math.abs(tiltErr[180].oldLean - 22.14) < 1e-6 && tiltErr[90].oldLean > 1,
     '(' + [90, 180, -135].map(function (d) { return d + '°: ' + tiltErr[d].oldLean.toFixed(3) + '°'; }).join(', ') + ')');
  // The Hitmark group of the turret carries the corrected matrix: the mirror, the pose and the recorded transform.
  cc.v.turretAngle = 180;
  const extra180 = cc.v.poseExtra(), group = new T3.Group();
  group.matrixAutoUpdate = false;
  cc.v.markSets = {2: {part: 2, group: group}};
  cc.v.markDrawn = cc.v.markFrames(extra180); cc.v.poseHitMarks();
  const wantGroup = F.clone().multiply(cc.ring.clone().multiply(new T3.Matrix4().makeRotationY(200 * D))).multiply(F);
  ok('tilted ring: the turret’s Hitmark group follows it - its matrix is the mirrored hull x T x tilt x RotateY(200°)',
     worst(group.matrix, wantGroup) < 1e-12, '(' + worst(group.matrix, wantGroup).toExponential(1) + ')');
  // Every other vehicle: the turret's own vertical IS the hull's, so the pose is the one it always was.
  const flat = tilted(0, 20 * D); let flatWorst = 0;
  [30, 90, 180, -100].forEach(function (deg) { flat.v.turretAngle = deg; flatWorst = Math.max(flatWorst, worst(flat.v.poseExtra()[2].clone().multiply(flat.turret), oldTurret(flat, deg))); });
  ok('tilted ring: an untilted turret turns exactly as before (the two axes are one)', flatWorst < 1e-12, '(' + flatWorst.toExponential(1) + ')');
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- second modes (23.09, outputs/second-modes-2026-09-23.md 5.2-5.4) and the rocket booster ---------------------------
  // The characteristics files of the reference vehicles, written OFFLINE by the mod's own ttx_block on the client's real
  // items.vehicles (tests/fixtures-local/ttx-offline, modes27_off.py): the top pair's 'aim' (with the fields of
  // aim_mode_fields) stands for the record's block, its 'modeAim' for the second mode. Section 5.4 A on the bare blocks
  // (ArmorBallistics), then the page under ✸: the one mode button of the gun panel, the switch rules, the gun held on the
  // axis, the autorotation past the sector, the automatic siege, Rapid, the salvo, the rocket; then the characteristics
  // panel: the garage's vertical and horizon with the hull aiming, the second mode's switch and figures (5.4 B).
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };
  const B = window.ArmorBallistics, D = Math.PI / 180, KMH = 1 / 3.6;
  const MDIR = process.env.BULLBA_TTX_MODES_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx-modes/';
  const MREF = process.env.BULLBA_TTX_MODES_REF || HERE + '../fixtures-local/ttx-reference/modes/ttx_reference.json';
  if (!fs.existsSync(MDIR)) { console.log('SKIP (the second modes\' characteristics files are not on this machine: ' + MDIR + ')'); return; }
  const MF = {}, MFID = {};
  fs.readdirSync(MDIR).forEach(function (f) {
    if (/\.js$/.test(f)) new Function('ArmorInspectorData', fs.readFileSync(MDIR + f, 'utf8'))({receive: function (x) { MF[x[1].type] = x[1]; MFID[x[1].id] = x[1]; }});
  });
  const top = function (t) { return t.configs.filter(function (c) { return c.top; })[0] || t.configs[0]; };
  const S103 = 'sweden:S11_Strv_103B', CS63 = 'poland:Pl21_CS_63', EBR = 'france:F108_Panhard_EBR_105', UDES = 'sweden:S28_UDES_15_16';
  const CONTR = 'uk:GB147_FV4025_Contriver', S107 = 'sweden:S36_Strv_107_12', CHAR = 'france:F118_Char_Mle_75', KUNZE = 'germany:G147_Kunze_Panzer';
  const KUST = 'ussr:R217_Object_Kust', T71 = 'japan:J40_Type_71', BZ = 'china:Ch47_BZ_176', YONG = 'china:Ch63_Yong_Bing', CS52 = 'poland:Pl25_CS_52_C';
  // ---- A. the bare blocks (5.4 A): multipliers 1, no crew - ArmorBallistics itself ------------------------------------
  const m100 = function (b) { return Math.tan(b.dispersion) * 100; };
  const fac = function (b, st) { return B.aimFactor(b, st).ideal; };
  const both = function (type) { const p = top(MF[type]); return [p.aim, p.modeAim]; };
  const row = function (type, want) {
    const pair = both(type), bad = [];
    [0, 1].forEach(function (i) {
      const b = pair[i], w = want[i];
      if (!b) { bad.push('no block ' + i); return; }
      if (w.circle !== undefined && !near(m100(b), w.circle, 1e-4)) bad.push(i + ' circle ' + m100(b).toFixed(4));
      if (w.aiming !== undefined && !near(b.aimingTime, w.aiming, 1e-6)) bad.push(i + ' aiming ' + b.aimingTime);
      if (w.kmh !== undefined && !near(b.speedForward / KMH, w.kmh, 0.01)) bad.push(i + ' kmh ' + (b.speedForward / KMH).toFixed(3));
      if (w.drive !== undefined && !near(m100(b) * fac(b, {speed: b.speedForward}), w.drive, 1e-3)) bad.push(i + ' drive ' + (m100(b) * fac(b, {speed: b.speedForward})).toFixed(4));
      if (w.driveX !== undefined && !near(fac(b, {speed: b.speedForward}), w.driveX, 1e-3)) bad.push(i + ' driveX ' + fac(b, {speed: b.speedForward}).toFixed(4));
      if (w.hullDeg !== undefined && !near(b.hullRotationSpeed / D, w.hullDeg, 1e-3)) bad.push(i + ' hull ' + (b.hullRotationSpeed / D).toFixed(3));
      if (w.hull !== undefined && !near(m100(b) * fac(b, {hullTurn: b.hullRotationSpeed}), w.hull, 1e-3)) bad.push(i + ' hullm ' + (m100(b) * fac(b, {hullTurn: b.hullRotationSpeed})).toFixed(4));
      if (w.hullX !== undefined && !near(fac(b, {hullTurn: b.hullRotationSpeed}), w.hullX, 1e-3)) bad.push(i + ' hullX ' + fac(b, {hullTurn: b.hullRotationSpeed}).toFixed(4));
      if (w.turretX !== undefined && !near(fac(b, {turretTurn: b.turretRotationSpeed}), w.turretX, 1e-3)) bad.push(i + ' turretX ' + fac(b, {turretTurn: b.turretRotationSpeed}).toFixed(4));
      if (w.turretDeg !== undefined && !near(b.turretRotationSpeed / D, w.turretDeg, 1e-3)) bad.push(i + ' turret ' + (b.turretRotationSpeed / D).toFixed(3));
      if (w.shotX !== undefined && !near(fac(b, {afterShot: true}), w.shotX, 1e-3)) bad.push(i + ' shotX ' + fac(b, {afterShot: true}).toFixed(4));
      if (w.reload !== undefined && !near(b.reloadTime, w.reload, 1e-4)) bad.push(i + ' reload ' + b.reloadTime);
      if (w.burst !== undefined && !(b.burst && near(b.burst[1], w.burst, 1e-4))) bad.push(i + ' burst ' + JSON.stringify(b.burst));
    });
    return bad;
  };
  const A = [
    [S103, 'Strv 103B travel / siege: 0.30 / 0.25 m, 3.0 / 1.0 s; 50 km/h ×20.025 → 6.0075 m, 10 km/h ×4.1231 → 1.0308 m; the hull at 35 °/s ×3.6401 → 1.0920 / ×1.0595 → 0.2649 m; the turret 16 °/s ×1.0000 / ×1.0127; after a shot ×18.028',
      [{circle: 0.30, aiming: 3.0, kmh: 50, driveX: 20.025, drive: 6.0075, hullDeg: 35, hullX: 3.6401, hull: 1.0920, turretDeg: 16, turretX: 1.0, shotX: 18.028},
       {circle: 0.25, aiming: 1.0, kmh: 10, driveX: 4.1231, drive: 1.0308, hullX: 1.0595, hull: 0.2649, turretX: 1.0127}]],
    [S107, 'Strv 107-12 travel / siege: 0.29 / 0.24 m, 3.0 / 1.0 s; 51 / 10 km/h; the hull at 35 °/s ×1.0716 → 0.2572 m in siege',
      [{circle: 0.29, aiming: 3.0, kmh: 51}, {circle: 0.24, aiming: 1.0, kmh: 10, hullX: 1.0716, hull: 0.2572}]],
    [KUST, 'Object Kust travel / siege: 0.43 / 0.33 m, 3.0 / 1.7 s; 50 / 5 km/h 8.6107 / 0.3848 m; 30 °/s 5.1779 / 1.2330 m',
      [{circle: 0.43, aiming: 3.0, kmh: 50, drive: 8.6107, hullDeg: 30, hull: 5.1779}, {circle: 0.33, aiming: 1.7, kmh: 5, drive: 0.3848, hull: 1.2330}]],
    [KUNZE, 'Kunze Panzer travel / siege: 0.42 / 0.30 m, 2.7 / 1.8 s; 65 / 30 km/h 4.1165 / 2.2699 m; 42 °/s 2.6791 / 3.1643 m (worse in siege); reload 9.3 / 12.3 s',
      [{circle: 0.42, aiming: 2.7, kmh: 65, drive: 4.1165, hullDeg: 42, hull: 2.6791, reload: 9.3}, {circle: 0.30, aiming: 1.8, kmh: 30, drive: 2.2699, hull: 3.1643, reload: 12.3}]],
    [CS63, 'CS-63 normal / turbine: 0.36 m both, 2.3 / 3.5 s; 55 / 70 km/h 2.4031 / 11.3457 m; 48 °/s 2.1046 / 7.7843 m; the turret at 50 °/s ×3.1623 / ×15.033',
      [{circle: 0.36, aiming: 2.3, kmh: 55, drive: 2.4031, hullDeg: 48, hull: 2.1046, turretDeg: 50, turretX: 3.1623}, {circle: 0.36, aiming: 3.5, kmh: 70, drive: 11.3457, hull: 7.7843, turretX: 15.033}]],
    [CHAR, 'Char Mle. 75 normal / turbine: 0.38 m both, 2.8 / 3.5 s; 55 / 75 km/h 3.5733 / 4.8599 m; 60 °/s 3.8946 m in both; the turret 65 / 20 °/s; the burst 0.5 / 0.6 s; after a shot ×2.2361 / ×8.0623',
      [{circle: 0.38, aiming: 2.8, kmh: 55, drive: 3.5733, hullDeg: 60, hull: 3.8946, turretDeg: 65, burst: 0.5, shotX: 2.2361}, {circle: 0.38, aiming: 3.5, kmh: 75, drive: 4.8599, hull: 3.8946, turretDeg: 20, burst: 0.6, shotX: 8.0623}]],
    [EBR, 'EBR 105 Cruise / Rapid: 0.38 m, 1.4 s; 70 / 91 km/h 2.4240 / 3.1353 m; 34 °/s 1.2233 m in both',
      [{circle: 0.38, aiming: 1.4, kmh: 70, drive: 2.4240, hullDeg: 34, hull: 1.2233}, {circle: 0.38, aiming: 1.4, kmh: 91, drive: 3.1353, hull: 1.2233}]],
    [UDES, 'UDES 15/16 automatic: 0.35 m, 2.2 s in both; 50 km/h 2.4749 m, 50 °/s 1.7847 m',
      [{circle: 0.35, aiming: 2.2, kmh: 50, drive: 2.4749, hullDeg: 50, hull: 1.7847}, {circle: 0.35, aiming: 2.2, kmh: 50, drive: 2.4749, hull: 1.7847}]],
    [T71, 'Type 71 automatic: 0.22 m, 2.0 s in both', [{circle: 0.22, aiming: 2.0}, {circle: 0.22, aiming: 2.0}]],
    [CONTR, 'Contriver normal / salvo: 0.33 / 1.10 m, 2.0 / 3.2 s; 38 / 20 km/h 1.9715 / 1.1218 m; 23 °/s 1.2219 / 1.1287 m',
      [{circle: 0.33, aiming: 2.0, kmh: 38, drive: 1.9715, hullDeg: 23, hull: 1.2219}, {circle: 1.10, aiming: 3.2, kmh: 20, drive: 1.1218, hull: 1.1287}]]];
  A.forEach(function (x) { const bad = MF[x[0]] ? row(x[0], x[2]) : ['no file']; ok('modes A: ' + x[1], bad.length === 0, bad.join('; ')); });
  // The switch parameters of the blocks (M1), as the emulation reads them.
  const sm = function (type) { return top(MF[type]).aim.siegeMode || {}; };
  ok('modes A: the switches - 103B hydraulic 2 / 1.3 s, CS-63 turbine 2 / 2, CS-52 C 2.5 / 1.5, Char Mle. 75 1 / 3, EBR 105 wheeled 0 / 0, Contriver twinGun 1.5 / 1.5 with the engine running, UDES 15/16 auto 10 / 23 km/h, Type 71 25 / 25',
     sm(S103).kind === 'hydraulic' && sm(S103).switchOnTime === 2 && near(sm(S103).switchOffTime, 1.3) && sm(CS63).kind === 'turboshaft' && sm(CS63).switchOffTime === 2
     && sm(CS52).switchOnTime === 2.5 && sm(CS52).switchOffTime === 1.5 && sm(CHAR).switchOnTime === 1 && sm(CHAR).switchOffTime === 3
     && sm(EBR).kind === 'wheeled' && sm(EBR).switchOnTime === 0 && sm(CONTR).kind === 'twinGun' && sm(CONTR).stopEngineOnSwitch === false && sm(CONTR).switchOnTime === 1.5
     && sm(UDES).kind === 'auto' && near(sm(UDES).autoOn / KMH, 10, 1e-3) && near(sm(UDES).autoOff / KMH, 23, 1e-3) && near(sm(T71).autoOn / KMH, 25, 1e-3) && near(sm(T71).autoOff / KMH, 25, 1e-3));
  // The rocket (part 2): BZ-176 - 30 km/h ×7.57, 45 km/h under the rocket ×11.29; the hull 29 °/s ×7.32, ×1.48 under it.
  const bz = top(MF[BZ]).aim, rk = MF[BZ].vehicle.rocketAcceleration;
  ok('rocket A: BZ-176 - 30 km/h ×7.57 and 45 km/h under the rocket ×11.29 (+49 %); the hull at 29 °/s ×7.32, at 4.35 °/s under it ×1.48; no modifier of the dispersion in the file',
     near(fac(bz, {speed: 30 * KMH}), Math.sqrt(1 + 7.5 * 7.5), 2e-3) && near(fac(bz, {speed: 45 * KMH}), 11.29, 5e-3) && near(fac(bz, {speed: 45 * KMH}) / fac(bz, {speed: 30 * KMH}), 1.49, 5e-3)
     && near(fac(bz, {hullTurn: 29 * D}), 7.32, 5e-3) && near(fac(bz, {hullTurn: 29 * 0.15 * D}), 1.48, 5e-3)
     && rk.modifiers.every(function (m) { return !/ispersion|aimingTime/.test(m.name); }),
     '(' + [fac(bz, {speed: 30 * KMH}), fac(bz, {speed: 45 * KMH}), fac(bz, {hullTurn: 29 * D}), fac(bz, {hullTurn: 4.35 * D})].map(function (x) { return x.toFixed(4); }).join(' / ') + ')');
  // moveStep's new keys: the rocket's own caps, the autorotation's virtual key that never overshoots.
  const mv = B.moveStep(null, {forward: true}, bz, {forwardSpeed: 1.5, backwardSpeed: 0.1}, 0.1);
  let turnSum = 0, st = null, left = 7 * D;
  for (let i = 0; i < 300 && left > 1e-9; i++) { st = B.moveStep(st, {auto: left}, top(MF[S103]).modeAim, {}, 1 / 60); turnSum += st.hullTurn / 60; left -= st.hullTurn / 60; }
  const stop = B.moveStep(st, {auto: 0, autoStop: true}, top(MF[S103]).modeAim, {}, 1 / 60);
  ok('ballistics: the rocket\'s caps (forward ×1.5, reverse ×0.1) and the autorotation - 7° turned exactly, never more, and autoStop halts the hull',
     near(mv.forward, bz.speedForward * 1.5, 1e-9) && near(mv.back, bz.speedBackward * 0.1, 1e-9) && near(turnSum, 7 * D, 1e-9) && stop.hullTurn === 0,
     '(' + (turnSum / D).toFixed(9) + '°)');
  // aimBeyond on the REAL viewer.js: how far the cursor lies past the sector - independent of the gun's own yaw.
  const RV = global.RealViewerCtor, T3 = global.THREE;
  if (RV && T3) {
    const rv = Object.create(RV.prototype), dir = function (deg) { return new T3.Vector3(-Math.sin(deg * D) * 50, 1, Math.cos(deg * D) * 50); };
    rv.camera = {position: new T3.Vector3(0, 1, 0)}; rv.aimPin = function () { return null; };
    rv.liveAimPoint = dir(3); rv.aimCursorPoint = dir(10); rv.aimYaw = 3 * D;
    const b1 = rv.aimBeyond([-3 * D, 3 * D]);
    rv.liveAimPoint = dir(0); rv.aimYaw = 0;
    const b2 = rv.aimBeyond([-3 * D, 3 * D]);
    rv.aimCursorPoint = dir(-1);
    ok('viewer: aimBeyond - the cursor 10° right of a hull heading 0 with a ±3° sector lies 7° past it, wherever the gun stands; inside the sector 0; no sector 0',
       near(b1, 7 * D, 1e-9) && near(b2, 7 * D, 1e-9) && rv.aimBeyond([-3 * D, 3 * D]) === 0 && rv.aimBeyond(null) === 0, '(' + (b1 / D).toFixed(6) + '° / ' + (b2 / D).toFixed(6) + '°)');
    // 5.2 p. 8: the viewer holds a static turret and gun still - by the target's pitch table or the exported file's top level.
    rv.loadedData = {hit: {target: {gunPitchLimits: {samples: [], staticPitch: -D, staticTurretYaw: 0}}}};
    const l1 = rv.poseLocks();
    rv.loadedData = {hit: {target: {staticTurretYaw: 0, gunPitchLimits: {samples: []}}}};
    const l2 = rv.poseLocks();
    rv.loadedData = {hit: {target: {gunPitchLimits: {samples: []}}}};
    const l3 = rv.poseLocks();
    const vsrc = fs.readFileSync(path + 'viewer.js', 'utf8');
    ok('viewer: poseLocks - the 103B\'s table locks the turret and the gun, a file\'s top-level staticTurretYaw only the turret, an ordinary vehicle nothing; the drag skips the locked axis and orbits when both are held',
       l1.turret && l1.gun && l2.turret && !l2.gun && !l3.turret && !l3.gun
       && vsrc.indexOf('drag.locks=self.poseLocks();if(drag.locks.turret&&drag.locks.gun)drag.part=1;') > 0
       && vsrc.indexOf('var dx=drag.locks&&drag.locks.turret?0:e.clientX-drag.x,dy=drag.locks&&drag.locks.gun?0:e.clientY-drag.y;') > 0);
  }
  // ---- B. through the page under ✸ -------------------------------------------------------------------------------------
  const CTX = global.ArmorShotContext, keepResolve = CTX.resolve;
  CTX.resolve = function (hit) {
    const st = hit && hit.attacker && hit.attacker.gunStateAtImpact || null;
    return {choices: SHELLS, index: -1, kind: 'ARMOR_PIERCING', source: 'stub', aimReason: 'no-snapshot', tracer: null, gunState: st, gunStateFrom: st ? 'impact' : null};
  };
  const PARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  let aid = 90;
  const SH = function (id, type, extra, hitExtra) {
    const t = MF[type], p = top(t), tn = t.turrets[p.turret].name;
    return Object.assign({id: id, attackerId: aid++, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, gameTime: 500, points: [],
      attacker: Object.assign({name: type.split(':')[1], type: type, gun: p.gunUserString, gunName: p.gun, turretName: tn, parts: PARTS(), gunDispersion: p.aim.dispersion, aim: clone(p.aim)}, extra || {}),
      target: {name: 'Alpha', type: 'germany:Alpha', parts: PARTS(), maxHealth: 2000}, warnings: []}, hitExtra || {});
  };
  const S103_REC = {modeAim: clone(top(MF[S103]).modeAim), modeAimMode: 1, vehicleMode: 0, siegeStateAtImpact: 0};
  const SHITS = [
    SH('m-103b', S103), SH('m-103b-rec', S103, S103_REC), SH('m-107', S107, {siegeStateAtImpact: 0}), SH('m-cs63', CS63), SH('m-ebr', EBR),
    SH('m-udes', UDES), SH('m-contr', CONTR), SH('m-bz', BZ), SH('m-bz-rec', BZ, {gunStateAtImpact: {rocketAcceleration: {stateStatus: {status: 4, endTime: 504, timeLeft: 4, reuseCount: 2}}}}),
    SH('m-yong', YONG), SH('m-kunze', KUNZE), SH('m-char', CHAR), SH('m-cs52', CS52), SH('m-t71', T71), SH('m-kust', KUST),
    SH('m-kust-old', KUST, {modeAim: undefined}), SH('m-103b-old', S103, {aim: (function () { const a = clone(top(MF[S103]).aim); delete a.siegeMode; delete a.hullAiming; delete a.staticPitch; delete a.staticTurretYaw; return a; }())})];
  const SBATTLE = {id: 's-modes', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: SHITS};
  const keepBattle = global.ArmorInspectorData.battle, keepTtx = global.ArmorInspectorData.ttx;
  global.ArmorInspectorData.battle = function (id) { return id === 's-modes' ? Promise.resolve(SBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  // The characteristics files by id; the IS-7-like fixtures of the earlier sections keep answering.
  let noTtx = false;
  global.ArmorInspectorData.ttx = function (id) { return !noTtx && MFID[id] ? Promise.resolve(MFID[id]) : keepTtx ? keepTtx(id) : Promise.reject(new Error('none')); };
  const onBox2 = document.getElementById('aim-on');
  if (!onBox2.checked) { onBox2.checked = true; onBox2.onchange.call(onBox2); }
  const funBox = document.getElementById('fun-mode'), star = document.getElementById('fun-mode-toggle'), sub = document.getElementById('real-reload-toggle'), realBox = document.getElementById('real-reload');
  const mech = document.getElementById('aim-gun-mech'), ttxMode = document.getElementById('ttx-mode');
  const setFun = function (want) { if (funBox.checked !== want) click(star); };
  const lit = function () { return mech.getAttribute('aria-pressed') === 'true'; };
  const busy = function () { return mech.getAttribute('data-busy') === '1'; };
  const glow = function () { return mech.getAttribute('data-glow') === '1'; };
  const key = function (code, down) { document.fire(down ? 'keydown' : 'keyup', {code: code, key: code.slice(3).toLowerCase(), target: document.body, preventDefault: function () {}}); };
  const kmh = function () { return parseFloat(speed.textContent); };
  const tap = function () { press(); release(); };
  const holdMech = function (sec) { mech.onpointerdown({button: 0}); run(sec); mech.onpointerup({button: 0}); };
  const prepare = function (view) {
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
  };
  const openM = function (id) {
    const i = SHITS.findIndex(function (h) { return h.id === id; });
    document.getElementById('hits').children[i].onclick();
    return settle(30);
  };
  const cb = document.getElementById('battles');
  cb.value = 's-modes'; cb.onchange.call(cb);
  const allKeysUp = function () { ['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach(function (c) { key(c, false); }); };
  return settle(30).then(function () { return openM('m-103b'); }).then(function () {
    // --- the Strv 103B recorded in travel, no modeAim in the record: under ✸ the second block is its file's ---------
    const view = viewerInstance; prepare(view); setFun(false); if (!realBox.checked) click(sub); allKeysUp(); run(20);
    const r0 = view.liveRadius100;
    ok('modes: ✸ off - no button, the recorded (travel) ring', mech.hidden === true && r0 > 0);
    setFun(true); run(1);
    ok('modes: ✸ on - the siege button of the Strv 103B: its glyph, not lit (recorded in travel), the second block from the characteristics file',
       mech.hidden === false && mech.textContent === '⤓' && !lit() && !busy() && /— Siege mode\n• Now: travel\n/.test(mech.title)
       && /\nThe second mode’s numbers are from the vehicle’s characteristics file/.test(mech.title) && mech.getAttribute('aria-label') === SHITS[0].attacker.name + ': Siege mode',
       '(' + mech.textContent + ' / ' + mech.getAttribute('aria-label') + ' / ' + mech.title.slice(0, 120) + ')');
    // Drive at 50 km/h, then press: 2.0 s of switching, the gun does not fire, W is ignored, the speed dies by the brake.
    key('KeyW', true); run(6);
    const v0 = kmh();
    click(mech); run(0.02);
    const p0 = view.pinnedPoints;
    tap(); run(0.02);
    ok('modes: pressed at ' + v0 + ' km/h - dashed, 2 s of switching into siege, and a shot in the middle of it does not go (PlayerAvatar.shoot)',
       v0 >= 49.9 && busy() && !lit() && view.pinnedPoints === p0, '(' + v0 + ' / ' + (view.pinnedPoints - p0) + ')');
    ok('strip: a tap refused by the mode switch pulses the mode button alone', balked() === 'aim-gun-mech' && /\n• While it switches: the gun does not fire/.test(mech.title),
       '(' + balked() + ')');
    run(0.96);
    const v1 = kmh();
    click(mech); run(0.02);
    ok('modes: 1 s in, W still held - the speed has dropped by the brake to about half (not driven), and a second press changes nothing',
       v1 > 20 && v1 < 30 && busy(), '(' + v1 + ')');
    run(0.8);
    ok('modes: at 1.8 s nearly stopped (the brake takes 2 s from 50 km/h), still switching, the old mode holding', kmh() < 6 && busy() && !lit(), '(' + kmh() + ')');
    key('KeyW', false); run(0.25);
    ok('modes: at 2.05 s the siege mode takes over - lit, no longer dashed', lit() && !busy());
    run(15);
    const rSiege = view.liveRadius100;
    ok('modes: the ring settles on the siege block\'s circle: 0.25 against the travel 0.30 m (both at rest)', near(rSiege / r0, both(S103)[1].dispersion / both(S103)[0].dispersion, 1e-6) && near(rSiege / r0, 0.25 / 0.30, 2e-3),
       '(' + (rSiege / r0).toFixed(5) + ')');
    const aimTau = function () { tap(); run(0.5); const a = view.liveRadius100; run(0.5); const b = view.liveRadius100; run(20); return 0.5 / Math.log(a / b); };
    ok('modes: and it settles by the siege aiming time (1.0 s × the crew): a shot\'s bloom falls e-fold in about 1 s', aimTau() < 1.2, '');
    tap(); const pShot = view.pinnedPoints; run(20);
    // Exit: 1.3 s, the siege block holding until the end.
    click(mech); run(1.2);
    ok('modes: out of siege - 1.3 s, the siege block holds until the end (lit)', busy() && lit() && near(view.liveRadius100 / rSiege, 1, 1e-6));
    run(0.15);
    ok('modes: at 1.35 s travel again', !busy() && !lit());
    run(20);
    // --- the autorotation past the sector and the gun held on the axis: a stub of the scene's angles ------------------
    // C the cursor's heading, H the hull's, Y the gun's yaw on the hull; the real viewer's aimReach/aimBeyond reduce to this.
    let C = 0, H = 0, Y = 0;
    const clampTo = function (x, l) { return l ? Math.max(l[0], Math.min(l[1], x)) : x; };
    const keep = {aimGap: view.aimGap, chaseAim: view.chaseAim, turnAim: view.turnAim, aimBeyond: view.aimBeyond};
    view.aimGap = function (l) { return Math.abs(clampTo(C - H, l) - Y); };
    view.chaseAim = function (step, l) { view.chaseLimits = l; const d = clampTo(C - H, l) - Y; if (Math.abs(d) < 1e-12) return false; Y += Math.sign(d) * Math.min(step, Math.abs(d)); return true; };
    view.turnAim = function (a) { H += a; return true; };
    view.aimBeyond = function (l) { const w = C - H; return w - clampTo(w, l); };
    click(mech); run(2.5);   // into siege again
    ok('modes: (back in siege for the turn)', lit() && !busy());
    run(20);
    const rRest = view.liveRadius100;
    let worst = 0;
    C = 10 * D; view.onAimMove(true);   // the cursor moved: the page wakes its loop (viewer.onAimMove)
    for (let i = 0; i < 180; i++) { run(1 / 60); worst = Math.max(worst, view.liveRadius100 / rRest); }
    ok('modes: siege, standing, the cursor 10° right - the gun goes to +3° and the hull turns the other 7° by itself (the autorotation), exactly: 0 ± 1e-6 left past the sector',
       near(Y, 3 * D, 1e-9) && near(H, 7 * D, 1e-6) && near(C - H - Y, 0, 1e-6), '(Y ' + (Y / D).toFixed(6) + '°, H ' + (H / D).toFixed(6) + '°)');
    ok('modes: and the ring never grew past the hull\'s term at 35 °/s in siege (×1.0595 → 0.2649 m)', worst <= 1.0595 + 1e-4 && worst > 1.0, '(×' + worst.toFixed(5) + ')');
    // W: the gun is held on the axis - the chase goes to 0 at the turret's speed - and the hull swings round to the cursor.
    key('KeyW', true); run(1 / 60);
    const lim = view.chaseLimits;
    run(2);
    key('KeyW', false);
    ok('modes: W held - the gun\'s limits collapse to its static yaw (0, 0) and it comes back to the axis; the hull turns the rest to the cursor',
       Array.isArray(lim) && lim[0] === 0 && lim[1] === 0 && near(Y, 0, 1e-9) && near(H, 10 * D, 1e-6), '(' + JSON.stringify(lim) + ' Y ' + (Y / D).toFixed(4) + ' H ' + (H / D).toFixed(4) + ')');
    ok('modes: the turret\'s term while it swings back at 16 °/s in siege - ×1.0127 of the bare block', near(fac(both(S103)[1], {turretTurn: 16 * D}), 1.0127, 1e-4));
    C = H; view.onAimMove(true); run(20);
    Object.keys(keep).forEach(function (k) { view[k] = keep[k]; });
    return openM('m-103b-rec');
  }).then(function () {
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    ok('modes: a record with its own modeAim - the second block is the record\'s', /\nThe second mode’s numbers are the record’s\.\n/.test(mech.title) && !lit());
    // The TTX panel: the garage's vertical and horizon with the hull aiming; the second mode's switch.
    return settle(10);
  }).then(function () {
    const more = document.getElementById('ttx-more'), full = document.getElementById('ttx-full');
    const fullRows = function () {
      const out = {};
      ttxRowsIn(full).forEach(function (r) { out[r.getAttribute('data-key')] = {text: r.ttx.value.textContent, cmp: r.getAttribute('data-cmp'), title: r.title}; });
      return out;
    };
    const openFull = function () { more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true; return fullRows(); };
    const buildBox = document.getElementById('ttx-build');
    if (buildBox.checked) click(document.getElementById('ttx-build-toggle'));
    let f = openFull();
    ok('ttx modes: the Strv 103B\'s vertical and horizon as the garage prints them - -11/11 (the hull\'s tilt) and 0/0 (the hull aims), the gun\'s own 1/1 and 3/3° in the tooltips; the switch 2/1.3 s',
       f.pitchLimits && f.pitchLimits.text === '-11/11' && /\n• Gun alone: 1\/1°\n/.test(f.pitchLimits.title) && f.gunYawLimits && f.gunYawLimits.text === '0/0'
       && /\n• Gun’s own sector: 3\/3°; past it the hull turns$/.test(f.gunYawLimits.title) && f.switchTime && f.switchTime.text === '2/1.3',
       JSON.stringify({p: f.pitchLimits && f.pitchLimits.text, y: f.gunYawLimits && f.gunYawLimits.text, s: f.switchTime && f.switchTime.text}));
    more.open = false;
    ok('ttx modes: the second mode\'s switch beside ⚙ - under ✸ it is the emulator\'s mode (off: travel)', ttxMode.hidden === false && ttxMode.getAttribute('aria-pressed') === 'false'
       && /Under ⌖ this is the emulator’s own mode/.test(ttxMode.title));
    click(ttxMode); run(2.1);
    ok('ttx modes: pressed under ✸ - the emulator switches (its button lit) and the panel follows it', lit() && ttxMode.getAttribute('aria-pressed') === 'true');
    f = openFull();
    ok('ttx modes: the siege figures - the circle 0.24, aiming 0.96, 10/10 km/h (the siege descriptor by the garage\'s own formula), mint against travel',
       f.shotDispersionAngle.text === '0.24' && f.aimingTime.text === '0.96' && f.speedLimits.text === '10/10' && f.shotDispersionAngle.cmp === 'better' && f.speedLimits.cmp === 'worse'
       && /\n• Siege, stock: 0\.24\n• Travel, stock: 0\.29\n/.test(f.shotDispersionAngle.title) && /The garage shows the travel figures only/.test(f.shotDispersionAngle.title),
       JSON.stringify([f.shotDispersionAngle, f.aimingTime.text, f.speedLimits.text].map(function (x) { return x && x.text !== undefined ? x.text + ' ' + x.cmp : x; })));
    more.open = false;
    click(mech); run(1.5); run(1);
    ok('ttx modes: the emulator back in travel - the panel follows', !lit() && ttxMode.getAttribute('aria-pressed') === 'false');
    // Off ✸ the switch is the panel's own, kept per type.
    setFun(false); run(0.5);
    ok('ttx modes: off ⌖ - the switch is the panel\'s own', /Off ⌖ only the panel changes/.test(ttxMode.title) && mech.hidden === true);
    click(ttxMode);
    ok('ttx modes: pressed off ✸ - lit, the siege figures on the panel, the emulator untouched (the recorded ring)', ttxMode.getAttribute('aria-pressed') === 'true'
       && /"modes":\{"sweden:S11_Strv_103B":1\}/.test(savedSettings() || ''), (savedSettings() || '').slice(-160));
    click(ttxMode);
    setFun(true); run(0.5);
    return openM('m-107');
  }).then(function () {
    // --- the Strv 107-12: a touch from travel goes into siege, 2 s ----------------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    ok('modes: Strv 107-12 recorded in travel - ▣, not lit', mech.textContent === '▣' && !lit() && !glow());
    holdMech(0.1); run(1.85);
    ok('modes: a touch (0.1 s) from travel - into siege, dashed for 2 s', busy() && !lit());
    run(0.2);
    ok('modes: in siege at 2 s - lit, no gold ring', lit() && !busy() && !glow());
    holdMech(1.02); run(2.9);
    ok('modes: held 1 s in siege - into the pillbox, 3 s', busy() && !glow());
    run(0.2);
    ok('modes: in the pillbox - the gold ring', glow() && lit());
    holdMech(1.02); run(3.9);
    ok('modes: held 1 s in the pillbox - out to travel, 4 s: still in the pillbox at 3.9 s', busy() && glow());
    run(0.2);
    ok('modes: travel at 4 s', !lit() && !glow() && !busy());
    return openM('m-cs63');
  }).then(function () {
    // --- CS-63: the turbine switches only standing ------------------------------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    const r0 = view.liveRadius100;
    ok('modes: CS-63 - the turbine button ≫, not lit', mech.textContent === '≫' && !lit() && /— Engine mode\n• Now: the normal engine mode\n/.test(mech.title));
    key('KeyW', true); run(1);
    click(mech); run(0.05);
    ok('modes: pressed on the move - refused (not dashed), the tooltip says to stop first', !busy() && !lit() && /\n• Last press refused: the engine mode switches only standing - stop first\n/.test(mech.title));
    key('KeyW', false); run(6);
    click(mech); run(0.05);
    const p0 = view.pinnedPoints; tap(); run(0.05);
    ok('modes: standing - 2 s of switching, the gun blocked', busy() && view.pinnedPoints === p0);
    run(2);
    ok('modes: the turbine on - lit', lit() && !busy());
    key('KeyW', true); run(9); const top70 = kmh(); key('KeyW', false); run(20);
    ok('modes: in the turbine the top speed is 70 km/h (55 in the normal mode) and the ring at rest the same (0.36 m in both)', top70 >= 69.9 && top70 <= 70.1 && near(view.liveRadius100 / r0, 1, 1e-6), '(' + top70 + ')');
    return openM('m-ebr');
  }).then(function () {
    // --- EBR 105: Rapid at once; standing, the wheels do not turn the hull ------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    ok('modes: EBR 105 - ↠, Cruise', mech.textContent === '↠' && !lit());
    // The hull's traverse on the move at its ceiling (past the 0.5 s ramp), to compare Rapid's with (23.09: Rapid turns
    // x tan 15° / tan 33° = 0.4126 - the steering locks of the characteristics file). Stops the vehicle after itself.
    const turnRate = function () {
      key('KeyW', true); run(9); key('KeyA', true); run(1.5);
      const i0 = view.turned.length; run(1.5);
      const r = view.turned.slice(i0).reduce(function (t, a) { return t + Math.abs(a); }, 0) / 1.5;
      key('KeyA', false); key('KeyW', false); run(40); return r;
    };
    const cruiseRate = turnRate();
    ok('modes: EBR 105 Cruise - the hull turns on the move, then stands', cruiseRate > 0 && kmh() < 0.1, '(' + (cruiseRate * 180 / Math.PI).toFixed(2) + ' deg/s, ' + kmh() + ' km/h)');
    click(mech); run(0.02);
    ok('modes: a press - Rapid at once (0 s), not dashed', lit() && !busy());
    const turned0 = view.turned.length;
    key('KeyA', true); run(1); key('KeyA', false); run(1);
    ok('modes: standing, A does not turn a French wheeled vehicle (no turn on the spot)', view.turned.length === turned0, '(' + (view.turned.length - turned0) + ')');
    key('KeyW', true); run(9); const rapid = kmh();
    key('KeyA', true); run(0.5); key('KeyA', false); key('KeyW', false);
    ok('modes: Rapid - 91 km/h, and on the move A steers', rapid >= 90.9 && rapid <= 91.1 && view.turned.length > turned0, '(' + rapid + ')');
    run(40);
    const rapidRate = turnRate(), want = Math.tan(15 * Math.PI / 180) / Math.tan(33 * Math.PI / 180);
    ok('modes: Rapid turns x tan 15° / tan 33° = 0.4126 of Cruise (the steering locks 15° / 33°), and the tooltip says so',
       near(rapidRate / cruiseRate, want, 1e-3) && /hull turns ×0\.41/.test(mech.title || mech.getAttribute('data-tip') || ''),
       '(' + (rapidRate / cruiseRate).toFixed(4) + ')');
    click(mech); run(0.02);
    const backRate = turnRate();
    ok('modes: back in Cruise the full traverse returns', near(backRate / cruiseRate, 1, 1e-3), '(' + (backRate / cruiseRate).toFixed(4) + ')');
    return openM('m-udes');
  }).then(function () {
    // --- UDES 15/16: the automatic siege is an indicator ------------------------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    const r0 = view.liveRadius100;
    ok('modes: UDES 15/16 - ∠, lit at a standstill (the hull tilts), passive: a press does nothing', mech.textContent === '∠' && lit() && mech.getAttribute('data-passive') === '1'
       && (click(mech), lit() && !busy()) && /\n• Circle: does not change - /.test(mech.title));
    key('KeyW', true); run(4); const v = kmh();
    ok('modes: above 23 km/h it goes out', v > 23 && !lit(), '(' + v + ')');
    key('KeyW', false); run(0.9);
    ok('modes: slowing between 23 and 10 km/h it stays out (the hysteresis)', kmh() > 10 && kmh() < 23 && !lit(), '(' + kmh() + ')');
    run(10);
    ok('modes: at a standstill lit again, the ring as it was', lit() && near(view.liveRadius100 / r0, 1, 1e-6));
    return openM('m-contr');
  }).then(function () {
    // --- Contriver: the salvo, 1.5 s, the engine keeps running ---------------------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    const r0 = view.liveRadius100;
    ok('modes: Contriver - ∥, single rounds', mech.textContent === '∥' && !lit() && /double damage and double reload are not emulated yet/.test(mech.title));
    click(mech); key('KeyW', true); run(1);
    ok('modes: switching to the salvo, 1.5 s - the vehicle drives on (device gun)', busy() && kmh() > 3, '(' + kmh() + ')');
    run(0.6); key('KeyW', false); run(20);
    ok('modes: the salvo - lit, the ring at rest ×(1.10 / 0.33)', lit() && near(view.liveRadius100 / r0, both(CONTR)[1].dispersion / both(CONTR)[0].dispersion, 1e-6),
       '(' + (view.liveRadius100 / r0).toFixed(4) + ')');
    return openM('m-bz');
  }).then(function () {
    // --- BZ-176: the rocket booster -------------------------------------------------------------------------------------
    const view = viewerInstance; prepare(view); allKeysUp(); run(20);
    const r0 = view.liveRadius100;
    ok('rocket: BZ-176 - ⇮, ready, 4 uses, the tooltip names the numbers', mech.textContent === '⇮' && !lit() && !busy() && /\n• Uses left: 4 of 4\n/.test(mech.title)
       && /fire it for 10 s; it recharges 4 s/.test(mech.title) && /top speed 30 → 45 km\/h, reverse ×0\.1, hull traverse ×0\.15/.test(mech.title), '(' + mech.title.slice(0, 200) + ')');
    key('KeyW', true); run(6);
    const x30 = view.liveRadius100 / r0, v30 = kmh();
    click(mech); run(2);
    const x45 = view.liveRadius100 / r0, v45 = kmh();
    ok('rocket: fired at 30 km/h - lit, the cap ×1.5: 45 km/h, and the ring grows only through the speed: ×7.57 → ×11.29',
       lit() && v30 >= 29.9 && v45 >= 44.9 && v45 <= 45.1 && near(x30, fac(bz, {speed: 30 * KMH}), 2e-3) && near(x45, fac(bz, {speed: 45 * KMH}), 5e-3),
       '(' + v30 + ' → ' + v45 + ' km/h, ×' + x30.toFixed(3) + ' → ×' + x45.toFixed(3) + ')');
    run(8.1);
    ok('rocket: 10 s later it is out - recharging (dashed), the cap back to 30: the speed falls by the brake', !lit() && busy() && kmh() < 45 && /\n• Uses left: 3 of 4\n/.test(mech.title), '(' + kmh() + ')');
    run(4);
    key('KeyW', false);
    ok('rocket: 4 s later ready again', !busy() && !lit());
    run(20);
    return openM('m-bz-rec');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(0.1);
    ok('rocket: from a record of it burning with 4 s left and 2 uses - lit, then recharging', lit() && /Uses left: 2 of 4/.test(mech.title) && /Started from the recorded state/.test(mech.title));
    run(4.2);
    ok('rocket: its 4 s over - recharging', !lit() && busy());
    return openM('m-yong');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(1);
    ok('rocket: Yong Bing (a dual gun with the rocket) - the button is the rocket\'s only: its dualGun mode gets no button (5.5)', mech.textContent === '⇮' && /Uses left: 10 of 10/.test(mech.title));
    return openM('m-kunze');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(1);
    ok('modes: Kunze Panzer - the siege button, travel, a turret that turns all round (no autorotation line)', mech.textContent === '⤓' && !lit() && !/Past its sector/.test(mech.title));
    // A record whose block names the mode but carries no second block, and no characteristics file: dimmed, with the reason.
    noTtx = true;
    return openM('m-kust-old');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(1);
    ok('modes: a record of the siege mode with no second block and no file - the button dimmed, the reason in its tooltip',
       mech.textContent === '⤓' && mech.getAttribute('aria-disabled') === 'true' && /come with the vehicle’s characteristics file/.test(mech.title), '(' + mech.title.slice(0, 120) + ')');
    noTtx = false;
    return openM('m-103b-old');
  }).then(function () {
    const view = viewerInstance; prepare(view); run(1);
    ok('modes: an older record of a 103B whose block does not name the mode - the siege button from its characteristics file', mech.textContent === '⤓' && !lit());
    // ---- B. the panel against the garage (5.4 B): the reference's stock strings, first and second mode ----------------
    if (!fs.existsSync(MREF)) { console.log('SKIP (the second modes\' reference is not on this machine: ' + MREF + ')'); return; }
    const ref = JSON.parse(fs.readFileSync(MREF, 'utf8')).filter(function (r) { return r.mode === 'stock'; });
    const IDS = {}; SHITS.forEach(function (h) { if (!IDS[h.attacker.type] && h.id !== 'm-103b-old') IDS[h.attacker.type] = h.id; });
    const more = document.getElementById('ttx-more'), full = document.getElementById('ttx-full');
    const rows = function () {
      const out = {};
      more.open = false; document.getElementById('ttx-more-button').onclick({}); more.open = true;
      ttxRowsIn(full).forEach(function (r) { out[r.getAttribute('data-key')] = r.ttx.value.textContent; });
      more.open = false;
      return out;
    };
    setFun(false);
    let chain = Promise.resolve();
    const results = [];
    ref.forEach(function (r) {
      if (!IDS[r.vehicle]) return;
      chain = chain.then(function () { return openM(IDS[r.vehicle]); }).then(function () {
        if (ttxMode.getAttribute('aria-pressed') === 'true') click(ttxMode);
        const first = rows(), V = r.values, txt = function (k) { return V[k] && V[k].text !== undefined ? V[k].text : null; };
        let second = null;
        if (!ttxMode.hidden) { click(ttxMode); second = rows(); click(ttxMode); }
        const cmp = [];
        const pairOf = function (k) { const t = txt(k); return t && t.indexOf('/') > 0 && ['aimingTime', 'enginePowerPerTon', 'shotDispersionAngle', 'turretRotationSpeed', 'circularVisionRadius'].indexOf(k) >= 0 ? t.split('/') : null; };
        ['pitchLimits', 'gunYawLimits', 'aimingTime', 'shotDispersionAngle', 'enginePowerPerTon', 'turretRotationSpeed', 'circularVisionRadius', 'speedLimits', 'enginePower'].forEach(function (k) {
          const t = txt(k);
          if (t === null) return;
          const p = pairOf(k);
          cmp.push([k + ' (first)', p ? p[0] : t, first[k]]);
          if (p && second) cmp.push([k + ' (second)', p[1], second[k]]);
        });
        // The garage's own keys of the second mode, against the panel's second-mode rows.
        const second2 = function (k, rowKey, part) { const t = txt(k); if (t === null || !second) return; cmp.push([k, part === undefined ? t : t.split('/')[part], second[rowKey]]); };
        second2('turboshaftSpeedModeSpeed', 'speedLimits'); second2('wheeledSpeedModeSpeed', 'speedLimits'); second2('twinGunTopSpeed', 'speedLimits');
        second2('turboshaftEnginePower', 'enginePower');
        second2('turboshaftInvisibilityStillFactor', 'invisibilityStillFactor', 0); second2('turboshaftInvisibilityStillFactor', 'invisibilityAfterShot', 1);
        second2('turboshaftInvisibilityMovingFactor', 'invisibilityMovingFactor', 0);
        const sw = txt('switchOnTime') !== null ? [txt('switchOnTime'), txt('switchOffTime')] : txt('turboshaftSwitchOnTime') !== null ? [txt('turboshaftSwitchOnTime'), txt('turboshaftSwitchOffTime')] : null;
        if (sw) cmp.push(['switch times', sw.join('/'), first.switchTime]);
        results.push({vehicle: r.vehicle, rows: cmp});
      });
    });
    return chain.then(function () {
      let all = 0, good = 0;
      results.forEach(function (x) {
        const bad = x.rows.filter(function (c) { return c[1] !== c[2]; });
        all += x.rows.length; good += x.rows.length - bad.length;
        ok('ttx modes B: ' + x.vehicle.split(':')[1] + ' stock - the panel prints the garage\'s strings in both modes (' + (x.rows.length - bad.length) + '/' + x.rows.length + ')', bad.length === 0,
           bad.map(function (c) { return c[0] + ' page ' + c[2] + ' client ' + c[1]; }).join('; '));
      });
      ok('ttx modes B: the eight reference vehicles compared (' + good + '/' + all + ' strings)', results.length === 8 && good === all, '(' + results.length + ')');
      // The 103B's second mode by the garage's formula on the siege descriptor (the garage prints the travel ones only).
      return openM('m-103b');
    }).then(function () {
      click(ttxMode); const s = rows(); click(ttxMode);
      ok('ttx modes B: the 103B\'s siege on the panel (no garage line: its formula on the siege descriptor) - 0.24 m, 0.96 s, 10/10 km/h',
         s.shotDispersionAngle === '0.24' && s.aimingTime === '0.96' && s.speedLimits === '10/10', JSON.stringify([s.shotDispersionAngle, s.aimingTime, s.speedLimits]));
      setFun(false);
    });
  }).then(function () {
    CTX.resolve = keepResolve;
    global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.ttx = keepTtx;
    allKeysUp(); delete window.BullbaHitsRng;
  });
}).then(function () {
  if (RELOAD) return;   // the S4 child page checks the stored settings only
  // ---- strip (23.09): the gun's load state beside ⌖ at the top, the crosshair icon, the pulse of a refused press -------
  // The user (23.09): the reload at the bottom of the scene went unnoticed while the gun would not fire - beside the
  // switch of these mechanics it would say why, and only while the emulation is on. So under ⌖ alone a strip beside the
  // switch holds ◔, the reload figure, the magazine, the heat bar and the mode button - the SAME nodes, moved - with the
  // health bar and ↺; the gun panel at the bottom keeps the shells (they choose the shell with ⌖ off too). The glyph ✸
  // said nothing ("a star of some kind"): the switch is a drawn crosshair, and ⌖ in every word the page shows. A press the
  // gun refuses pulses what is in the way and the live ring: the heat, the gap between rounds, the reload, the clip
  // reload and the mode switch are checked where those sections refuse a tap; the burst and a hold here. A narrow scene
  // stacks the strip under the tile - read off the layout pass on the stub's geometry.
  const styleSrc = fs.readFileSync(path + 'style.css', 'utf8');
  const rowSrc = pageSrc.slice(pageSrc.indexOf('<div class="model-row"'), pageSrc.indexOf('<div id="target-mods-slot"'));
  const headSrc = rowSrc.slice(0, rowSrc.indexOf('<div id="fun-strip"')), stripSrc = rowSrc.slice(rowSrc.indexOf('<div id="fun-strip"'));
  const gunSrc = pageSrc.slice(pageSrc.indexOf('<div id="aim-gun"'), pageSrc.indexOf('<details class="toolbar-more aim-config"'));
  const once = function (id) { return pageSrc.split('id="' + id + '"').length === 2; };
  const MOVED = ['real-reload-toggle', 'aim-gun-load', 'aim-gun-reload', 'aim-gun-mag', 'aim-gun-heat', 'aim-gun-heat-fill', 'aim-gun-heat-warn', 'aim-gun-mech', 'target-hp', 'target-hp-reset'];
  ok('strip: the model row is the tile’s head (the tile, the ⌖ switch, the help dot) and the strip after it, hidden until something of it is there',
     /^<div class="model-row" id="model-row"><div class="model-head"><button type="button" id="model-tile"/.test(rowSrc)
     && headSrc.indexOf('id="fun-mode-toggle"') > 0 && /class="help-dot swap-roles"/.test(headSrc)
     && /^<div id="fun-strip" class="fun-strip" hidden><button type="button" id="real-reload-toggle"/.test(stripSrc));
  ok('strip: in it ◔, then the live part (reload figure, magazine, heat bar, mode button), then the health bar and ↺',
     /<span id="fun-gun" class="fun-gun" hidden><span id="aim-gun-load" class="aim-gun-load" title="[^"]+"><b id="aim-gun-reload">—<\/b><\/span><span id="aim-gun-mag"/.test(stripSrc)
     && ['real-reload-toggle', 'fun-gun', 'aim-gun-load', 'aim-gun-mag', 'aim-gun-heat', 'aim-gun-mech', 'target-hp', 'target-hp-reset'].every(function (id, i, a) {
       return stripSrc.indexOf('id="' + id + '"') > 0 && (!i || stripSrc.indexOf('id="' + a[i - 1] + '"') < stripSrc.indexOf('id="' + id + '"')); })
     && /id="aim-gun-mech" class="swap-roles aim-gun-mech" aria-pressed="false" hidden><\/button><\/span><span id="target-hp"/.test(stripSrc));
  ok('strip: the same nodes, moved - every id once in the page, none of them left in the gun panel, and the page builds no copy',
     MOVED.every(once) && MOVED.every(function (id) { return gunSrc.indexOf('id="' + id + '"') < 0; })
     && /^<div id="aim-gun" class="aim-gun" hidden><span id="aim-gun-shells" class="aim-gun-shells" role="group" aria-label="Shells of this gun"><\/span><\/div>$/.test(gunSrc)
     && !/cloneNode|'aim-gun-load'\)\.cloneNode/.test(appSrc.slice(appSrc.indexOf('  function paintGunLoad('), appSrc.indexOf('  function restReload(')))
     && MOVED.every(function (id) { return appSrc.indexOf("id = '" + id) < 0 && appSrc.indexOf("id='" + id) < 0; }));
  const dots = {};
  pageSrc.replace(/<button type="button" class="help-dot[^"]*" (?:data-tb="\d+" )?data-help-for="([^"]*)"/g, function (m, ids) { dots[ids.split(' ')[0]] = ids.split(' '); return m; });
  ok('strip: the top help dot lists ⌖ first and everything of the strip one can press or read, not the tile (user 23.09: the group opened on the collision model); the shooter row no longer the mode button',
     JSON.stringify(dots['fun-mode-toggle']) === JSON.stringify(['fun-mode-toggle', 'real-reload-toggle', 'aim-gun-load', 'aim-gun-mag', 'aim-gun-heat', 'aim-gun-mech', 'target-hp-reset'])
     && JSON.stringify(dots['swap-roles']) === JSON.stringify(['swap-roles', 'shooter-tile', 'aim-gun-shells', 'aim-config']),
     '(' + JSON.stringify(dots['fun-mode-toggle']) + ' / ' + JSON.stringify(dots['swap-roles']) + ')');
  ok('strip: every id a help dot of the page lists is on the page',
     Object.keys(dots).length >= 5 && Object.keys(dots).every(function (k) { return dots[k].every(once); }), '(' + Object.keys(dots).length + ' dots)');
  ok('strip: the switch is a crosshair drawn in currentColor - lit in the accent with the switch - and its help row names it ⌖',
     /\.fun-icon\{display:block;width:1em;height:1em;fill:none;stroke:currentColor;/.test(styleSrc) && /\.fun-icon \.fun-icon-dot\{fill:currentColor;stroke:none\}/.test(styleSrc)
     && /id="fun-mode-toggle"[^>]*data-glyph="⌖"/.test(headSrc) && /var g = el\.getAttribute\('data-glyph'\);\s*if \(g\) return g;/.test(fs.readFileSync(path + 'tooltips.js', 'utf8')));
  // ✸ in words: none left anywhere the page shows text - its markup outside comments, and the strings of its scripts.
  const noComments = function (src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1'); };
  const shown = ['app.js', 'ttx.js', 'equipment.js', 'modifiers.js', 'crits.js', 'shot-context.js', 'vehicle-modes.js'].filter(function (f) {
    return fs.existsSync(path + f) && noComments(fs.readFileSync(path + f, 'utf8')).indexOf('✸') >= 0; });
  ok('strip: the ✸ is gone from every word the page shows - the markup outside its comments, the strings of its scripts',
     pageSrc.replace(/<!--[\s\S]*?-->/g, '').indexOf('✸') < 0 && shown.length === 0 && (appSrc.match(/⌖/g) || []).length >= 17, '(' + shown + ')');
  // Final review (23.09): ⌖ is the switch alone - the orbit centre's buttons of the camera panel wore it too ("⌖ Vehicle",
  // "⌖ Hit"), one look for two functions; they wear ⊙ now (Segoe UI Symbol has both, as it has ⌖).
  ok('strip: ⌖ means the switch only - the camera panel’s orbit-centre buttons wear ⊙',
     />⊙ Vehicle<\/button>/.test(pageSrc) && />⊙ Hit<\/button>/.test(pageSrc) && pageSrc.indexOf('⌖ Vehicle') < 0 && pageSrc.indexOf('⌖ Hit') < 0);
  ok('strip: the rules - the row as wide as its content, stacked into a column on data-stack, the strip the gun panel’s own look',
     /\.model-row\{[^}]*width:max-content;max-width:calc\(100% - 24px\)\}/.test(styleSrc) && /\.model-row\[data-stack\]\{flex-direction:column;/.test(styleSrc)
     && /\.aim-gun,\.fun-strip\{display:flex;/.test(styleSrc) && /\.aim-gun\[hidden\],\.fun-strip\[hidden\],\.fun-gun\[hidden\]\{display:none\}/.test(styleSrc)
     && /\.fun-strip\{flex-wrap:wrap;/.test(styleSrc) && /\.aim-gun-load b\{display:inline-block;min-width:5\.4ch;/.test(styleSrc));
  ok('strip: the pulse - two names of one animation, a red ring twice, and no frame of its own: a CSS animation, one timeout to take it off',
     /\.fun-strip \[data-balk="1"\]\{animation:balk-1 \.3s ease-out 2\}/.test(styleSrc) && /\.fun-strip \[data-balk="2"\]\{animation:balk-2 \.3s ease-out 2\}/.test(styleSrc)
     && /@keyframes balk-1\{from\{box-shadow:0 0 0 2px var\(--red\)/.test(styleSrc) && /@keyframes balk-2\{from\{box-shadow:0 0 0 2px var\(--red\)/.test(styleSrc)
     && /balkTimer = window\.setTimeout\(balkClear, BALK_MS\);/.test(appSrc) && !/requestAnimationFrame/.test(appSrc.slice(appSrc.indexOf('  function gunBalk('), appSrc.indexOf('  function balkClear(') + 300)));
  ok('strip: the ring pulses by its one material and the frame draw() already asks for - four timeouts, no loop',
     /Viewer\.prototype\.flashAim=function\(\)\{[\s\S]*?m\.color\.setHex\(s\.color\);m\.opacity=s\.opacity;self\.draw\(\);[\s\S]*?window\.setTimeout\(next,AIM_BALK_STEP\)/.test(viewerSrc)
     && /var AIM_BALK=\{color:0xfb8580,opacity:1\},AIM_BALK_STEP=150;/.test(viewerSrc)
     && !/requestAnimationFrame/.test(viewerSrc.slice(viewerSrc.indexOf('Viewer.prototype.flashAim'), viewerSrc.indexOf('Viewer.prototype.setAimEmulation'))));
  ok('strip: the refusal is ONE rule - gunFree is gunBlock, and the tap and the hold name what blocked them',
     /function gunFree\(\) \{ return !gunBlock\(\); \}/.test(appSrc) && /var why = gunBlock\(\);\s*if \(why\) gunBalk\(why\);/.test(appSrc)
     && /var single = !aimBurst, why = single \? gunBlock\(\) : '';/.test(appSrc) && /if \(why\) gunBalk\(why\);/.test(appSrc));

  // ---- through the page: a burst gun and a plain one -----------------------------------------------------------------
  const SPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const BURST_AIM = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, afterShotInBurstFactor: 0, burst: [3, 0.3, false], clip: [3, 0.3], reloadTime: 6, gunTags: ['clip']});
  const SHIT = function (id, attackerId, type, aim) {
    return {id: id, attackerId: attackerId, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: {name: type, type: type, parts: SPARTS(), gunDispersion: aim.dispersion, aim: aim},
            target: {name: 'Alpha', type: 'germany:Alpha', parts: SPARTS()}, warnings: []};
  };
  const SBATTLE = {id: 'st1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [],
    roster: [{id: 7, name: 'Alpha', type: 'germany:Alpha', team: 1, player: '', maxHealth: 1850, defaultMaxHealth: 1800},
             {id: 61, name: 'Burst', type: 'italy:Burst', team: 2, player: '', maxHealth: 2000, defaultMaxHealth: 2000}],
    hits: [SHIT('st-burst', 61, 'italy:Burst', BURST_AIM)]};
  global.ArmorInspectorData.battle = function (id) { return id === 'st1' ? Promise.resolve(SBATTLE) : Promise.reject(new Error('no battle')); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  const funBox = document.getElementById('fun-mode'), realBox = document.getElementById('real-reload'), star = document.getElementById('fun-mode-toggle');
  const sub = document.getElementById('real-reload-toggle'), strip = document.getElementById('fun-strip'), live = document.getElementById('fun-gun');
  const gunPanel = document.getElementById('aim-gun'), row = document.getElementById('model-row'), box = document.getElementById('viewport');
  const setFun = function (on) { if (funBox.checked !== on) click(star); };
  const tap = function () { press(); release(); };
  const layoutFrames = function (sec) {
    let n = 0; const req = window.requestAnimationFrame;
    window.requestAnimationFrame = function (fn) { if (/layoutHeading/.test(String(fn))) n++; return req(fn); };
    run(sec); window.requestAnimationFrame = req; return n;
  };
  const sb = document.getElementById('battles');
  sb.value = 'st1'; sb.onchange.call(sb);
  return settle(20).then(function () {
    const view = viewerInstance;
    view.shell = {alpha: 400, damageRandomization: .25, kind: 'ARMOR_PIERCING', penetration: 250, caliber: 120};
    view.pinResult = {reason: 'penetration', chance: 100, screenPass: 1, nominal: 100, nonPen: 0};
    window.BullbaHitsRng = function () { return .5; };
    setFun(false); if (!realBox.checked) click(sub); run(10);
    // The user's word (23.09): the reload, the magazine and the rest of the strip only in the emulation mode - off ⌖
    // nothing blocks a shot (gunBlock), so the whole strip waits for ⌖; the gun panel at the bottom keeps the shells.
    ok('strip: ⌖ OFF - no strip at all (the reload, magazine, heat and mode button wait for ⌖, the user 23.09); the gun panel at the bottom has the shells; the switch stands by the tile, dark',
       view.liveRadius100 > 0 && strip.hidden === true && document.getElementById('target-hp').hidden === true
       && document.getElementById('target-hp-reset').hidden === true && gunPanel.hidden === false && star.hidden === false && star.getAttribute('aria-pressed') === 'false');
    let p = view.pinnedPoints, f = view.flashes;
    tap(); tap(); tap();
    ok('strip: ⌖ OFF - every tap fires as before, nothing pulses and the ring never flashes', view.pinnedPoints === p + 3 && view.flashes === f && balked() === '');
    run(10);
    setFun(true); run(0.1);
    ok('strip: ⌖ ON - the strip comes up with its live part, ◔, the health bar and ↺; the gun panel keeps the shells',
       strip.hidden === false && live.hidden === false && sub.hidden === false && document.getElementById('target-hp').hidden === false
       && document.getElementById('target-hp-reset').hidden === false && gunPanel.hidden === false && star.getAttribute('aria-pressed') === 'true');
    // A burst of three, 0.3 s apart: a tap while it goes out is refused - the figure and the magazine pulse.
    p = view.pinnedPoints; f = view.flashes;
    tap();
    ok('strip: (the press starts the burst: its first round is out)', view.pinnedPoints === p + 1);
    tap();
    ok('strip: a tap while the burst goes out is refused - the reload figure and the magazine pulse, the live ring once',
       view.pinnedPoints === p + 1 && balked() === 'aim-gun-load,aim-gun-mag' && view.flashes === f + 1, '(' + balked() + ' / ' + (view.flashes - f) + ')');
    const frames = layoutFrames(0.7);
    ok('strip: the burst goes on regardless, and the whole of it and the pulse ask for no layout pass (nothing new per frame)',
       view.pinnedPoints === p + 3 && frames === 0 && balked() === '', '(' + (view.pinnedPoints - p) + ' rounds, ' + frames + ' layout frames)');
    // The magazine is empty and reloading (real reload): a hold is refused at its start - once - and fires when it may.
    f = view.flashes;
    press(); run(0.3);
    ok('strip: a hold during the clip reload is refused at its start - the figure and the empty magazine pulse',
       view.pinnedPoints === p + 3 && balked() === 'aim-gun-load,aim-gun-mag' && view.flashes === f + 1, '(' + balked() + ')');
    run(6);
    ok('strip: ... and the held burst fires the moment the reload is over, without a second pulse', view.pinnedPoints > p + 3 && view.flashes === f + 1,
       '(' + (view.pinnedPoints - p) + ' / ' + (view.flashes - f) + ')');
    release(); run(10);
    // The load part needs a live emulation: with the aim emulation off the strip keeps ◔, the bar and ↺ only.
    onBox.checked = false; onBox.onchange.call(onBox); run(0.1);
    ok('strip: the aim emulation OFF under ⌖ - the strip keeps ◔, the health bar and ↺, its live part goes, and so does the gun panel',
       strip.hidden === false && live.hidden === true && sub.hidden === false && gunPanel.hidden === true);
    onBox.checked = true; onBox.onchange.call(onBox); run(0.1);
    ok('strip: (back on)', live.hidden === false && gunPanel.hidden === false);
    // A narrow scene (375 px): the one-line row does not fit the band - the strip goes under the tile. A wide one: beside it.
    const keepW = box.clientWidth, keepR = row.offsetWidth;
    box.clientWidth = 375; row.offsetWidth = 520; scheduleLayoutNow();
    ok('strip: a 375 px scene - the row is stacked, the strip on its own line under the tile', row.getAttribute('data-stack') === '');
    box.clientWidth = 1920; scheduleLayoutNow();
    ok('strip: a wide scene - the strip stands on the tile’s own line again', row.getAttribute('data-stack') === null);
    // Stacked and still crossing the grid (final review, 23.09): on the 375 px scene the info panel (14-300) and the
    // circle tile (300-361) reach the strip's line - the row goes down under the lowest tile it meets; a strip that
    // clears them stays at the top.
    const TT = {'shot-panel': [14, 300, 12, 130], 'armor-probe': [14, 300, 138, 230], 'shot-circle-tile': [308, 361, 12, 70], 'probe-circle-tile': [308, 361, 138, 196]};
    const keepRect = {};
    Object.keys(TT).forEach(function (id) {
      const el = document.getElementById(id), g = TT[id]; keepRect[id] = [el.getBoundingClientRect, el.hidden];
      el.hidden = false; el.getBoundingClientRect = function () { return {left: g[0], right: g[1], top: g[2], bottom: g[3], width: g[1] - g[0], height: g[3] - g[2]}; };
    });
    row.offsetTop = 12; row.offsetHeight = 76; strip.offsetWidth = 300;
    box.clientWidth = 375; scheduleLayoutNow();
    ok('strip: a 375 px scene whose panels reach the stacked strip - the row goes down under them (both rows of the grid: 230 + 8)',
       row.getAttribute('data-stack') === '' && row.style.top === '238px', '(' + row.style.top + ')');
    Object.keys(TT).forEach(function (id) { if (id !== 'shot-panel') document.getElementById(id).hidden = true; });
    scheduleLayoutNow();
    ok('strip: ... under the one panel it meets when only that one is there (130 + 8)', row.style.top === '138px', '(' + row.style.top + ')');
    box.clientWidth = 1920; scheduleLayoutNow();
    ok('strip: a wide scene - the row back at the top of the band, on one line', row.style.top === '' && row.getAttribute('data-stack') === null, '(' + row.style.top + ')');
    Object.keys(TT).forEach(function (id) { const el = document.getElementById(id); el.getBoundingClientRect = keepRect[id][0]; el.hidden = keepRect[id][1]; });
    delete row.offsetTop; delete row.offsetHeight; strip.offsetWidth = 100;
    box.clientWidth = 375; scheduleLayoutNow();
    setFun(false); scheduleLayoutNow();
    ok('strip: ⌖ OFF on the narrow scene - the strip is gone with ⌖ (the user 23.09)',
       strip.hidden === true);
    // Its width moves on events only: ◔/the bar/↺ with ⌖, the health bar coming late with the characteristics file, the
    // heat bar - each asks the top band's pass (stripLayout), never a frame.
    ok('strip: the health bar, ◔, ↺ and the heat bar coming or going ask the top band to be laid out again (stripLayout), only then',
       /if \(bar\.hidden !== !show\) \{ bar\.hidden = !show; wide = true; \}/.test(appSrc) && /if \(wide\) stripLayout\(\);/.test(appSrc)
       && /if \(box\.hidden !== !h\) \{ box\.hidden = !h; stripLayout\(\); \}/.test(appSrc));
    onBox.checked = false; onBox.onchange.call(onBox); run(0.1);
    ok('strip: ⌖ and the aim emulation both OFF - no strip at all: the tile and the switch alone', strip.hidden === true && row.getAttribute('data-stack') === null);
    onBox.checked = true; onBox.onchange.call(onBox); run(0.1);
    box.clientWidth = keepW; row.offsetWidth = keepR; scheduleLayoutNow();
    delete window.BullbaHitsRng;
  });
}).then(function () {
  // ---- fieldmods (23.09, the user's word): the empty slot is back, and the field modification is set in Config -------
  // The catalogue is the client's own (tools/build_equipment_catalogue.py field_rows, out of scripts.pkg of 2.4.0.1; the
  // figures below are field_modifications.xml's, outputs/field-modifications-2026-09-20.md section 2). Through the page:
  // a tier-X SPG whose record names its tree (5106, role_SPG) gets a Field modification block under Directive - one
  // column per level, the standard modification on top, the pair in a frame under it, a help dot - with the three
  // states of a pair exactly as the user put them, a standard modification on/off, the client's law (the deviations
  // add and are applied once, the equipment multiplies that), the characteristics panel and the ring on the one pass
  // of multipliers, the record's own field modification left out once Config sets one, the recorded ring untouched,
  // the tier bands, and the store.
  const FMC = window.AIM_CATALOGUE && window.AIM_CATALOGUE.field, D = Math.PI / 180, TX = window.BullbaTtx;
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-12); };
  const mods = FMC ? FMC.mods : {}, trees = FMC ? FMC.trees : {};
  ok('fieldmods: the catalogue - 18 role trees of one shape (levels 2, 4, 5, 7 from tier IX, 8 at tier X), 160 modifications, no feature among them',
     Object.keys(trees).length === 18 && Object.keys(mods).length === 160
     && Object.keys(trees).every(function (id) {
       return trees[id].levels.map(function (l) { return l.level + (l.min ? ':' + l.min + '-' + l.max : ''); }).join(',') === '2,4,5,7:9-10,8:10-10'
         && trees[id].levels.every(function (l) { return mods[l.base] && l.pair.length === 2 && mods[l.pair[0]] && mods[l.pair[1]]; });
     }));
  const want = [
    ['role_ATSPG_base_1', 'Suspension Components Replacement (Type 1)', {rotationFactor: ['mul', 0.99]}],
    ['role_heavyTank_pair_2_1', 'Parallax Adjustment', {multFactor: ['mul', 0.97], aimingTimeFactor: ['mul', 1.05]}],
    ['role_heavyTank_pair_2_2', 'Aiming Gears Lapping', {aimingTimeFactor: ['mul', 0.95], multFactor: ['mul', 1.03]}],
    ['role_HT_break_pair_4_1', 'Power Supply Rewiring (Setup 1)', {speedForward: ['add', 4], turretRotationSpeed: ['mul', 0.93], aimingTimeFactor: ['mul', 1.05]}],
    ['role_MT_sniper_base_4', 'Improved Suspension (Type 1)', {movementFactor: ['mul', 0.985], rotationFactor: ['mul', 0.985]}],
    ['role_SPG_base_4', 'Barrel Rifling Cleaning (Type 1)', {multFactor: ['mul', 0.99]}],
    ['role_SPG_pair_4_2', 'Aiming Mechanism Tuning', {multFactor: ['mul', 0.97], reloadTimeFactor: ['mul', 1.03]}],
    ['role_HT_support_pair_5_1', 'Heavyweight Gun', {healthFactor: ['mul', 1.02], afterShotFactor: ['mul', 0.85], aimingTimeFactor: ['mul', 1.06]}]];
  const same = function (a, b) {
    return !!b && Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every(function (k) { return b[k] && b[k][0] === a[k][0] && near(b[k][1], a[k][1]); });
  };
  const badMods = want.filter(function (w) { const m = mods[w[0]]; return !m || m.name !== w[1] || !same(w[2], m.eff); });
  ok('fieldmods: eight modifications against the client’s XML - the garage name and every factor the page counts',
     badMods.length === 0, badMods.map(function (w) { return w[0] + ' ' + JSON.stringify(mods[w[0]]); }).join('; '));
  ok('fieldmods: the garage’s own lines of what it changes (tank_setup.mo), a pair side’s art, a modification the page does not draw marked',
     mods.role_heavyTank_pair_2_1.kpi.join('|') === '-3% to the aiming circle size|-5% to aiming speed'
     && mods.role_heavyTank_pair_2_1.icon === 'fm_improvedScope' && !mods.role_heavyTank_base_1.icon
     && mods.role_LT_support_base_4.rest === true && Object.keys(mods.role_LT_support_base_4.eff).length === 0,
     mods.role_heavyTank_pair_2_1.kpi.join('|'));
  const icons = {};
  Object.keys(mods).forEach(function (k) { if (mods[k].icon) icons[mods[k].icon] = 1; });
  [2, 4, 5, 7, 8].forEach(function (l) { icons['fm_level_' + l] = 1; });
  const exporterPath = process.env.BULLBA_EXPORTER || HERE + '../../mod/local_armor_inspector/exporter.py';
  const exporterSrc = fs.existsSync(exporterPath) ? fs.readFileSync(exporterPath, 'utf8') : '';
  const noArt = Object.keys(icons).filter(function (n) { return !fs.existsSync(path + 'icons/' + n + '.png') || exporterSrc.indexOf("'" + n + "'") < 0; });
  ok('fieldmods: every picture the block names ships in web/icons and is in the package list (ICON_FILES)', Object.keys(icons).length === 31 && noArt.length === 0, noArt.join(', '));

  // --- through the page ---------------------------------------------------------------------------------------------
  const SPG_AIM = {dispersion: Math.atan(0.1), aimingTime: 4, reloadTime: 20, clip: [1, 0], reloadTimeFactor: 1, multFactor: 1, additiveFactor: 1,
    aimingTimeFactor: 1, turretRotationSpeed: 20 * D, hullRotationSpeed: 20 * D, speedForward: 50 * 0.27778, speedBackward: 20 * 0.27778,
    movementFactor: 0.2 / 0.27778, rotationFactor: 0.2 / D, turretRotationFactor: 100 / D, afterShotFactor: 4, gunTags: [], aimFrom: 'compact'};
  const clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  const FM_TTX = {schema: 1, id: 'france-FM_Arty', type: 'france:FM_Arty', clientVersion: 'test',
    vehicle: {invisibility: [0.05, 0.1], camouflageBonus: 0.02, projectileSpeedFactor: 0.8, modes: {}},
    modules: {chassis: {terrainResistance: [1, 1.2, 2]}, engine: {power: 600 * 735.5}},
    turrets: [{name: 'FM_Turret', userString: 'FM turret', level: 10, circularVisionRadius: 350, invisibilityFactor: 1}],
    shells: {_155: [{kind: 'HIGH_EXPLOSIVE', name: 'HE', caliber: 155, alpha: 1000, penetration100: 80, penetration500: 80, speed: 500}]},
    configs: [{turret: 0, gun: '_155', gunUserString: '155 mm test', gunLevel: 10, top: true, aim: clone(SPG_AIM), maxHealth: 1500, weight: 50000,
               pitch: {absolute: [-45 * D, 0]}, invisibilityFactorAtShot: 0.2}]};
  const FPARTS = function () { return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'}, {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}]; };
  const FH = function (id, attacker) {
    return {id: id, attackerId: 60, targetId: 7, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
            attacker: Object.assign({name: 'FM Arty', type: 'france:FM_Arty', gun: '155 mm test', parts: FPARTS(), gunDispersion: SPG_AIM.dispersion, aim: clone(SPG_AIM)}, attacker),
            target: {name: 'Beta', type: 'germany:Beta', parts: FPARTS(), maxHealth: 1850}, warnings: []};
  };
  const ARENA_AIM = Object.assign(clone(SPG_AIM), {aimFrom: 'arena', multFactor: 1.03, compactFactors: {multFactor: 1, additiveFactor: 1, aimingTimeFactor: 1, reloadTimeFactor: 1}});
  const FHITS = [FH('fm-x', {level: 10, postProgressionTree: '5106'}), FH('fm-old', {name: 'FM Old', type: 'france:FM_Old', level: 10}),
                 FH('fm-8', {level: 8, postProgressionTree: '5106'}), FH('fm-arena', {level: 10, postProgressionTree: '5106', aim: ARENA_AIM})];
  const FBATTLE = {id: 'fm1', playerVehicleId: 7, map: 'Test', warnings: [], shotEvents: [], hits: FHITS};
  const keepBattle = global.ArmorInspectorData.battle, keepTtx = global.ArmorInspectorData.ttx;
  global.ArmorInspectorData.battle = function (id) { return id === 'fm1' ? Promise.resolve(FBATTLE) : keepBattle(id); };
  global.ArmorInspectorData.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (x) { return x.id === id; })[0], models: {}, warnings: []}); };
  global.ArmorInspectorData.ttx = function (id) { return id === 'france-FM_Arty' ? Promise.resolve(FM_TTX) : keepTtx ? keepTtx(id) : Promise.reject(new Error('none')); };
  const onBox3 = document.getElementById('aim-on');
  if (!onBox3.checked) { onBox3.checked = true; onBox3.onchange.call(onBox3); }
  const funBox3 = document.getElementById('fun-mode');
  if (funBox3.checked) click(document.getElementById('fun-mode-toggle'));
  const fieldBox = document.getElementById('aim-cfg-field');
  const openF = function (id) {
    const i = FHITS.findIndex(function (h) { return h.id === id; });
    document.getElementById('hits').children[i].onclick();
    return settle(30).then(function () { config.open = true; config.fire('toggle'); openConfigMenu(); run(20); });
  };
  const fm = function (level, k) { return document.getElementById('aim-fm-' + level + '-' + k); };
  const pressed = function (t) { return t.getAttribute('aria-pressed') === 'true'; };
  const fmClick = function (level, k) { click(fm(level, k)); run(20); };
  const fieldStored = function () { return ((storedCustom('france:FM_Arty') || {}).field || []).join(','); };
  const bb = document.getElementById('battles');
  bb.value = 'fm1'; bb.onchange.call(bb);
  return settle(30).then(function () { return openF('fm-old'); }).then(function () {
    ok('fieldmods: a record that names no tree - no Field modification block, no heading',
       fieldBox.hidden === true && fieldBox.children.length === 0 && document.getElementById('aim-fm-2-b').parentNode === null);
    return openF('fm-x');
  }).then(function () {
    const view = viewerInstance, cols = fieldBox.children;
    const r0 = view.liveRadius100;
    ok('fieldmods: a tier-X SPG naming tree 5106 - the block is there, one column per level 2, 4, 5, 7, 8, in the tree’s order',
       fieldBox.hidden === false && cols.length === 5 && cols.map(function (c) { return c.getAttribute('data-level'); }).join(',') === '2,4,5,7,8' && r0 > 0,
       '(' + cols.map(function (c) { return c.getAttribute('data-level'); }).join(',') + ')');
    const shape = cols.every(function (c) {
      const lv = c.getAttribute('data-level'), base = c.children[0], frame = c.children[1], dot = c.children[2];
      return c.children.length === 3 && base.id === 'aim-fm-' + lv + '-b' && iconOf(base).children[0].src === 'web/icons/fm_level_' + lv + '.png'
        && frame.className === 'aim-fm-pair' && frame.children.length === 2 && frame.children[0].id === 'aim-fm-' + lv + '-1' && frame.children[1].id === 'aim-fm-' + lv + '-2'
        && /^web\/icons\/fm_/.test(iconOf(frame.children[0]).children[0].src)
        && dot.className === 'help-dot' && dot.tagName === 'BUTTON' && dot.getAttribute('aria-label') === 'Help'
        && dot.getAttribute('data-help-for') === ['aim-fm-' + lv + '-b', 'aim-fm-' + lv + '-1', 'aim-fm-' + lv + '-2'].join(' ');
    });
    ok('fieldmods: a column - the level’s hexagon (the standard modification), the pair in one frame, one help dot listing the three', shape);
    const all = [];
    cols.forEach(function (c) { all.push(c.children[0]); c.children[1].children.forEach(function (t) { all.push(t); }); });
    ok('fieldmods: fifteen tiles, not one character on any of them, each named and with the garage’s name and lines in its tooltip, all off',
       all.length === 15 && all.every(function (t) { return tileWords(t) === '' && !!tileName(t) && t.title.indexOf(tileName(t) + '\n') === 0 && !pressed(t); })
       && /^Barrel Rifling Cleaning \(Type 1\)\nStandard Modification, level VII\.\n• -1% to the aiming circle size\n• Counted here: ×0\.99 on the whole circle, the fully aimed one included\n\n• Click: switch it on$/.test(fm(7, 'b').title),
       fm(7, 'b').title);
    // A standard modification: on and off.
    fmClick(7, 'b');
    ok('fieldmods: a standard modification on - lit, the circle ×0.99, and it lands in Custom under the type',
       pressed(fm(7, 'b')) && near(view.liveRadius100 / r0, 0.99) && presetName() === 'Custom' && fieldStored() === 'role_SPG_base_4',
       '(' + (view.liveRadius100 / r0) + ' / ' + fieldStored() + ')');
    fmClick(7, 'b');
    ok('fieldmods: and off again - the circle back, nothing stored', !pressed(fm(7, 'b')) && near(view.liveRadius100, r0) && fieldStored() === '',
       '(' + fieldStored() + ')');
    // A pair: the three states, every transition.
    const A = function () { return fm(7, 1); }, B = function () { return fm(7, 2); };
    const state = function () { return (pressed(A()) ? 'A' : '-') + (pressed(B()) ? 'B' : '-') + (A().parentNode.getAttribute('data-set') ? '*' : ''); };
    const ratio = function () { return view.liveRadius100 / r0; };
    const steps = [];
    fmClick(7, 1); steps.push([state(), ratio(), 'A-*', 1.03]);
    fmClick(7, 2); steps.push([state(), ratio(), '-B*', 0.97]);
    fmClick(7, 2); steps.push([state(), ratio(), '--', 1]);
    fmClick(7, 2); steps.push([state(), ratio(), '-B*', 0.97]);
    fmClick(7, 1); steps.push([state(), ratio(), 'A-*', 1.03]);
    fmClick(7, 1); steps.push([state(), ratio(), '--', 1]);
    const badSteps = steps.filter(function (s) { return s[0] !== s[2] || !near(s[1], s[3]); });
    ok('fieldmods: a pair - off, A on (×1.03), B takes its place (×0.97), B off (neutral), B on, A takes its place, A off: every transition as the user put it',
       badSteps.length === 0, steps.map(function (s) { return s[0] + ' ' + s[1].toFixed(6); }).join(' | '));
    fmClick(7, 1);
    ok('fieldmods: while one side is on the other’s tooltip says a click swaps them; the stored field holds one side only',
       /\n• Click: it takes the place of Loading Mechanism Tuning$/.test(B().title) && /\n• Click: take it off; the pair is then neutral$/.test(A().title)
       && fieldStored() === 'role_SPG_pair_4_1', fieldStored());
    fmClick(7, 1);
    // THE LAW: three factors on the circle - x0.99, x0.99, x0.97 - add their deviations and apply once: x0.95, not their
    // product 0.950697; the equipment then multiplies that (Improved Aiming x0.93): 0.8835, not 1 - 0.05 - 0.07.
    fmClick(7, 'b'); fmClick(8, 'b'); fmClick(7, 2);
    ok('fieldmods: the client’s law - x0.99, x0.99 and x0.97 on the circle give x0.95 (the deviations add), not the product 0.950697',
       near(ratio(), 0.95) && !near(ratio(), 0.99 * 0.99 * 0.97, 1e-6), '(' + ratio() + ')');
    click(slots.children[0]); click(pick('Improved Aiming Class 1')); run(20);
    ok('fieldmods: and the equipment multiplies on top - Improved Aiming x0.93 makes x0.8835, not x0.88',
       near(ratio(), 0.95 * 0.93) && fieldStored() === 'role_SPG_base_4,role_SPG_base_5,role_SPG_pair_4_2', '(' + ratio() + ' / ' + fieldStored() + ')');
    ok('fieldmods: the Config button lists the field modification and states the law once',
       /\n• Field modification: Barrel Rifling Cleaning \(Type 1\), Barrel Rifling Cleaning \(Type 1\), Aiming Mechanism Tuning\n/.test(cfgSummary.title)
       && /the deviations of its modifications add up and are applied once \(three ×0\.99 make ×0\.97\)/.test(cfgSummary.title), cfgSummary.title);
    // The characteristics panel in the build (⚙) reads the SAME pass: the dispersion is the ring's figure, and the three
    // x0.99 on the turret term (levels 2, 4, 5) print 97, not 97.03.
    fmClick(2, 'b'); fmClick(4, 'b'); fmClick(5, 'b');
    const buildBox = document.getElementById('ttx-build'), panel = document.getElementById('ttx-panel'), compact = document.getElementById('ttx-compact');
    const row = function (k) { return ttxRowsIn(compact).filter(function (r) { return r.getAttribute('data-key') === k; })[0] || null; };
    const val = function (k) { const r = row(k); return r ? r.ttx.value.textContent : null; };
    if (buildBox.checked) click(document.getElementById('ttx-build-toggle'));
    const stockDisp = val('shotDispersionAngle'), stockTurret = val('stabTurret'), stockTitle = document.getElementById('ttx-build-toggle').title;
    click(document.getElementById('ttx-build-toggle'));
    const ring = view.liveRadius100;
    ok('fieldmods: ⚙ stock - no field modification: the bare vehicle’s 9.56 and 100, and the tooltip says the stock has none',
       panel.hidden === false && stockDisp === '9.56' && stockTurret === '100' && /• Off: the stock[^\n]*or field modification\n/.test(stockTitle) && !/This build/.test(stockTitle), stockDisp + ' / ' + stockTurret);
    ok('fieldmods: ⚙ build - the panel’s dispersion is the ring’s own figure (one pass of multipliers), and three x0.99 on the turret term print 97',
       buildBox.checked === true && val('shotDispersionAngle') === TX.nice(TX.dr(ring, 4)) && val('stabTurret') === '97'
       && /\nThe field modification set in Config is counted by the client’s law; any the record carries is left out\.$/.test(document.getElementById('ttx-build-toggle').title),
       val('shotDispersionAngle') + ' / ' + TX.nice(TX.dr(ring, 4)) + ' / ' + val('stabTurret'));
    click(document.getElementById('ttx-build-toggle'));
    // The recorded ring is the record's: switching field modifications never touches it or the recorded block.
    const aimBefore = JSON.stringify(FHITS[0].attacker.aim);
    let recordedCalls = 0;
    const keepCtx = view.setShotContext, keepEst = view.setAimEstimate;
    view.setShotContext = function () { recordedCalls++; return keepCtx.apply(this, arguments); };
    view.setAimEstimate = function () { recordedCalls++; return keepEst.apply(this, arguments); };
    fmClick(2, 1); fmClick(2, 2); fmClick(2, 2);
    view.setShotContext = keepCtx; view.setAimEstimate = keepEst;
    ok('fieldmods: the recorded ring is left alone - no call to redraw it, the recorded aim block unchanged',
       recordedCalls === 0 && JSON.stringify(FHITS[0].attacker.aim) === aimBefore);
    return openF('fm-8');
  }).then(function () {
    // Another hit of the SAME type kept the running ring until 24.09 (syncShooterMods resets it only for another type),
    // so the entry in force was put in force again to take the ring of this record's tier at once. BACKLOG 47 / audit
    // PD-03: the scene's finisher now builds the ring of a block that is not the one it was computed on - asked first,
    // with nothing chosen again; the old way below still gives the same ring.
    run(20);
    const early = viewerInstance.liveRadius100 / (Math.atan(0.1) * 100 / 1.043);
    ok('fieldmods: BACKLOG 47 - another hit of the same vehicle with another aim block has that block’s ring at once, nothing chosen again',
       near(early, 0.93), '(' + early + ')');
    choosePreset('Custom'); run(20);
    const view = viewerInstance, cols = fieldBox.children;
    ok('fieldmods: the same vehicle at tier VIII - levels 2, 4, 5 only (level 7 from tier IX, 8 at X), and Custom’s level-7/8 entries are not in force: only Improved Aiming’s x0.93',
       cols.map(function (c) { return c.getAttribute('data-level'); }).join(',') === '2,4,5'
       && near(view.liveRadius100 / (Math.atan(0.1) * 100 / 1.043), 0.93), '(' + (view.liveRadius100 / (Math.atan(0.1) * 100 / 1.043)) + ')');
    return openF('fm-arena');
  }).then(function () {
    // A LIVE block of an enemy (aimFrom arena, x1.03 on the circle over its compact rebuild: his pair). The configurator
    // keeps it while the block is all off, and leaves it out the moment anything is on - never both.
    const view = viewerInstance, bare = Math.atan(0.1) * 100 / 1.043;
    choosePreset('Stock — no equipment'); run(20);
    ok('fieldmods: an enemy’s live block with the block all off - his own x1.03 is kept, and the Config tooltip says until when',
       near(view.liveRadius100 / bare, 1.03) && /Kept from the record: ×1\.03 on the circle \(field modifications\) - until anything in the Field modification block is on/.test(cfgSummary.title),
       '(' + (view.liveRadius100 / bare) + ')');
    fmClick(2, 'b');
    ok('fieldmods: one standard modification on (the turret term only) - the record’s x1.03 goes: never a field modification on top of the recorded one',
       near(view.liveRadius100 / bare, 1) && !/Kept from the record/.test(cfgSummary.title), '(' + (view.liveRadius100 / bare) + ')');
    fmClick(2, 'b');
    ok('fieldmods: all off again - the recorded x1.03 is back', near(view.liveRadius100 / bare, 1.03));
  }).then(function () {
    global.ArmorInspectorData.battle = keepBattle; global.ArmorInspectorData.ttx = keepTtx;
    config.open = false; config.fire('toggle');
  });
}).then(function () {
  return pathMatrix();
}).then(function () {


  if (thrown.length) console.log('\nEXCEPTIONS: ' + thrown.map(function (e) { return e && e.stack; }).join('\n'));
  failures += thrown.length;
  console.log('\nviewer methods stubbed as no-ops: ' + VIEWER_NOOPS.join(', '));
  console.log(failures ? failures + ' FAILURES' : 'all passed');
  process.exitCode = failures ? 1 : 0;
}).catch(function (e) {
  // A throw inside the chain used to end the process in silence - the run simply stopped mid-list and
  // said nothing, which cost a good while to spot. Now it says what broke and fails.
  console.log('\nTHREW: ' + (e && e.stack));
  process.exitCode = 1;
});

// ================= THE PATH MATRIX (24.09, scene-one-path) =================
// The user, 24.09: "rendering is unstable - there must be ONE procedure that builds the screen by the same rules;
// instead, depending on where the call came from, something is drawn or not". Every path that puts a scene on screen
// now ends in the one finisher (app.js sceneShown). Each path is driven here through the page, with ⌖ off and on, and
// after each the SAME invariants are asked:
//   - the tiles show the scene;
//   - the ⌖ switch stands with a model, lit with the mode; the strip and ↺ only under ⌖ and with a model;
//   - the health bar iff ⌖, a model and a known figure - the figure INSIDE it, and the tooltip's source line;
//   - the emulation's controls (speed tile, gun panel, Config) go with the model;
//   - a vehicle browsed without its model (24.09, the browser): its tile stays, but nothing is drawn - no ⌖, no strip,
//     no bar, no emulation; Config stays (its build is the ⚙ of the panel), the panel shows its file, the scene says why;
//   - every static help dot stands iff one of the controls it lists does - tooltips.js runs here without an observer,
//     so only the finisher's BullbaTips.refresh() can stand them;
//   - each scene painter ran ONCE for the scene (counted at the head of each function), the help dots refreshed once,
//     and the roster was painted once beyond what the hit list paints.
// The fixture is the user's own case: an Onslaught battle, where the enemy's roster row carries no vehicle and no
// figure (12 of 12 such records in preview/data), and ⇅ on an incoming hit puts that enemy on screen.
function pathMatrix() {
  if (RELOAD) return Promise.resolve();
  const $ = function (id) { return document.getElementById(id); };
  const NBS = ' ';   // the thin space the page groups thousands with
  const fig = function (s) { return s.replace(/ /g, NBS); };
  const PMPARTS = function () {
    return [{id: 0, name: 'chassis', modelKey: 'k0'}, {id: 1, name: 'hull', modelKey: 'k1'},
            {id: 2, name: 'turret', modelKey: 'k2'}, {id: 3, name: 'gun', modelKey: 'k3'}];
  };
  const PMV = {30: {name: 'Papa', type: 'germany:Papa'}, 31: {name: 'Romeo', type: 'germany:Romeo'},
               32: {name: 'Quebec', type: 'germany:Quebec'}, 34: {name: 'Tango', type: 'germany:Tango'}};
  const PMHIT = function (id, attackerId, targetId) {
    return {id: id, attackerId: attackerId, targetId: targetId, direction: 'incoming', damage: 0, receivedAt: 100, points: [],
      attacker: Object.assign({parts: PMPARTS(), gun: '105 mm single', gunDispersion: 0.00383, aim: AIM_BLOCK}, PMV[attackerId]),
      target: Object.assign({parts: PMPARTS(), gun: '105 mm single'}, PMV[targetId]), warnings: []};
  };
  const ROSTER = [{id: 30, name: 'Papa', type: 'germany:Papa', team: 2, player: 'me', maxHealth: 2750, defaultMaxHealth: 2100},
    {id: 31, player: 'enemy', team: 1},   // Onslaught: the enemy's row names neither his vehicle nor its figure
    {id: 32, name: 'Quebec', type: 'germany:Quebec', team: 2, player: 'ally', maxHealth: 1500, defaultMaxHealth: 1500},
    {id: 33, name: 'Sierra', type: 'germany:Sierra', team: 2, player: 'idle', maxHealth: 1000, defaultMaxHealth: 1000},
    {id: 34, player: 'enemy2', team: 1}];
  const BATTLE = function (id, hitList) { return {id: id, playerVehicleId: 30, playerTeam: 2, map: 'Test', warnings: [], shotEvents: [], roster: ROSTER, hits: hitList}; };
  const BATTLES = {pm: BATTLE('pm', [PMHIT('pm-1', 31, 30), PMHIT('pm-2', 32, 30)]), pm2: BATTLE('pm2', [PMHIT('pm2-1', 32, 30)]),
                   pm3: BATTLE('pm3', [PMHIT('pm3-1', 30, 34)])};
  BATTLES.pm3.hits[0].direction = 'outgoing';
  // The characteristics files: each type's stock figure (Romeo's is the one the swapped enemy gets, Tango's is read
  // only for the vehicle on screen - he never is a shooter).
  const TTXOF = function (type, hp) {
    const aim = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 7, clip: [1, 0]});
    return {schema: 1, id: type.replace(':', '-'), type: type,
      vehicle: {invisibility: [0.1, 0.2], camouflageBonus: 0.03, projectileSpeedFactor: 0.8, modes: {}},
      modules: {chassis: {terrainResistance: [1, 1.2, 2]}, engine: {power: 600 * 735.5}},
      turrets: [{name: 'TurretX', userString: 'Turret X', level: 8, circularVisionRadius: 380, invisibilityFactor: 1}],
      shells: {_105_single: [{kind: 'ARMOR_PIERCING', name: 'AP shell', caliber: 105, alpha: 400, penetration100: 250, speed: 800}]},
      configs: [{turret: 0, gun: '_105_single', gunUserString: '105 mm single', gunLevel: 8, top: true, aim: aim, maxHealth: hp, weight: 40000,
                 pitch: {absolute: [-0.35, 0.14]}, invisibilityFactorAtShot: 0.2}]};
  };
  const TTXS = {'germany-Papa': TTXOF('germany:Papa', 2100), 'germany-Romeo': TTXOF('germany:Romeo', 1950),
                'germany-Quebec': TTXOF('germany:Quebec', 1400), 'germany-Tango': TTXOF('germany:Tango', 1234),
                'germany-Uniform': TTXOF('germany:Uniform', 1111)};   // 24.09: the row without a model
  const ttxAsked = [];
  // Two browsed vehicles for the Vehicles panel's ⇅: their exports carry their own figure.
  const EXPORT = function (id, type, name, hp) {
    return {id: id, type: type, name: name, level: 10, 'class': 'heavyTank', nation: 'germany', role: 'role_HT_break', exportedAt: 1,
      parts: [], shells: SHELLS.slice(0, 2), warnings: [], gun: '105 mm single', gunDispersion: 0.00383, aim: AIM_BLOCK, maxHealth: hp};
  };
  const EXPORTS = {pm_papa: EXPORT('pm_papa', 'germany:Papa', 'Papa', 2200), pm_quebec: EXPORT('pm_quebec', 'germany:Quebec', 'Quebec', 1600)};
  const CATALOGUE = [VEHICLE,
    {id: 'pm_papa', type: 'germany:Papa', name: 'Papa', level: 10, 'class': 'heavyTank', nation: 'germany', exported: true, exportedAt: 1},
    {id: 'pm_quebec', type: 'germany:Quebec', name: 'Quebec', level: 10, 'class': 'heavyTank', nation: 'germany', exported: true, exportedAt: 1},
    // 24.09: a catalogue row without a model - in the browser it opens with its characteristics file alone.
    {id: 'germany-Uniform', type: 'germany:Uniform', name: 'Uniform', level: 10, 'class': 'heavyTank', nation: 'germany', exported: false, exportedAt: null}];
  const D = global.ArmorInspectorData;
  const keep = {battle: D.battle, scene: D.scene, ttx: D.ttx, vehicles: D.vehicles, vehicle: D.vehicle, sceneFor: D.sceneFor};
  // web/local-data.js's rule for a vehicle without its model (tested on the real reader below, 'noModel'): no geometry,
  // its words as the reason, no warning.
  D.sceneFor = function (b, hit) {
    return hit && hit.target && hit.target.noModel ? Promise.resolve({hit: hit, models: {}, warnings: [], geometryIncomplete: true, geometryError: String(hit.target.noModel)})
      : keep.sceneFor(b, hit);
  };
  D.battle = function (id) { return BATTLES[id] ? Promise.resolve(BATTLES[id]) : Promise.reject(new Error('no battle')); };
  D.scene = function (b, id) { return Promise.resolve({hit: b.hits.filter(function (h) { return h.id === id; })[0], models: {}, warnings: []}); };
  D.ttx = function (id) { ttxAsked.push(id); return TTXS[id] ? Promise.resolve(TTXS[id]) : Promise.reject(new Error('Not found data/ttx/' + id + '.js')); };
  D.vehicles = function () { return Promise.resolve({updatedAt: 'pm', vehicles: CATALOGUE}); };
  D.vehicle = function (id) { return EXPORTS[id] ? Promise.resolve(EXPORTS[id]) : id === VEHICLE.id ? Promise.resolve(VEHICLE) : Promise.reject(new Error('no vehicle')); };

  const hitRows = function () { return $('hits').children.filter(function (c) { return c.getAttribute('data-hit') !== null; }); };
  const rosterRow = function (id) { return $('focus-list').children.filter(function (c) { return c.getAttribute('data-id') === String(id); })[0]; };
  const listRow = function (id) { return $('vehicles').children.filter(function (c) { return c.getAttribute('data-vehicle') === id; })[0]; };
  const scopeTo = function (scope) { document.querySelectorAll('#vehicle-scope [data-scope]').forEach(function (b) { if (b.getAttribute('data-scope') === scope) b.onclick(); }); };
  const setFun = function (on) { if ($('fun-mode').checked !== on) click($('fun-mode-toggle')); };
  const pickBattle = function (id) { const s = $('battles'); s.value = id; s.onchange.call(s); };
  const counted = function () { const c = Object.assign({}, paints); c.refresh = tipRefreshes; return c; };
  const delta = function (was) {
    const now = counted(), out = {};
    Object.keys(now).forEach(function (k) { const d = (now[k] || 0) - (was[k] || 0); if (d) out[k] = d; });
    return out;
  };
  // The rule of the help dots, read at CHECK time (a dot stood by a stale pass would differ): a dot stands iff one
  // control it lists stands, and every box around it below the one it shares with the dot.
  const inside = function (box, el) { for (let e = el; e; e = e.parentNode) if (e === box) return true; return false; };
  const dotShouldStand = function (dot) {
    return dot.getAttribute('data-help-for').split(/\s+/).some(function (id) {
      for (let el = $(id); el && !inside(el, dot); el = el.parentNode) if (el.hidden) return false;
      return true;
    });
  };
  const dotFor = function (id) { return staticDots.filter(function (d) { return d.getAttribute('data-help-for').split(/\s+/).indexOf(id) >= 0; })[0]; };
  const ROSTER_HP = 'this battle’s roster', FILE_HP = 'the vehicle’s characteristics, stock', OWN_HP = 'the vehicle’s own export';
  function expectScene(label, fun, want, d) {
    const tag = 'matrix, ⌖ ' + (fun ? 'on' : 'off') + ', ' + label + ': ';
    const tile = !$('model-tile').hidden, shooter = !$('shooter-tile').hidden;
    // A model DRAWN: the tile, and not a vehicle browsed without its model (want.drawn false: the tile alone).
    const model = tile && want.drawn !== false;
    ok(tag + 'the tiles show the scene', tile === want.model && shooter === want.shooter, '(model ' + tile + ', shooter ' + shooter + ')');
    ok(tag + 'the ⌖ switch stands with a model, lit with the mode; the strip and ↺ only under ⌖ with a model',
       $('fun-mode-toggle').hidden === !model && $('fun-mode-toggle').getAttribute('aria-pressed') === String(fun)
       && $('fun-strip').hidden === !(fun && model) && $('target-hp-reset').hidden === !(fun && model),
       '(switch hidden ' + $('fun-mode-toggle').hidden + ', strip hidden ' + $('fun-strip').hidden + ', ↺ hidden ' + $('target-hp-reset').hidden + ')');
    const bar = fun && model && !!want.hp;
    ok(tag + (bar ? 'the health bar stands with ' + want.hp + ' inside it, from ' + want.source : 'no health bar'),
       $('target-hp').hidden === !bar
       && (!bar || ($('target-hp-text').textContent === fig(want.hp) && $('target-hp').title.indexOf('\n• Left: ' + fig(want.hp) + ' HP\n• Source: ' + want.source) > 0)),
       '(hidden ' + $('target-hp').hidden + ', "' + $('target-hp-text').textContent + '")');
    ok(tag + 'the emulation’s controls go with the model' + (want.drawn === false ? ' - Config stays for the panel\'s build' : ''),
       model || ($('aim-drive').hidden && $('aim-gun').hidden && $('fun-gun').hidden && $('aim-config').hidden === (want.drawn !== false)),
       '(drive ' + $('aim-drive').hidden + ', config ' + $('aim-config').hidden + ', gun ' + $('aim-gun').hidden + ')');
    const wrong = staticDots.filter(function (dt) { return dt.hidden !== !dotShouldStand(dt); });
    ok(tag + 'every static help dot stands iff a control it lists does (the ⌖ one with the model)',
       wrong.length === 0 && dotFor('fun-mode-toggle').hidden === !model,
       '(' + wrong.map(function (dt) { return dt.getAttribute('data-help-for').split(' ')[0] + (dt.hidden ? ' hidden' : ' shown'); }).join(', ') + ')');
    const once = ['sceneTiles', 'shotStats', 'updateAim', 'funModel', 'paintFun', 'ttxPaint', 'modsVisible', 'refresh'];
    ok(tag + 'ONE finisher, each scene painter once, the help dots refreshed once, the roster once beyond the hit list',
       d.sceneShown === 1 && once.every(function (k) { return d[k] === 1; }) && (d.renderFocus || 0) - (d.renderHits || 0) === 1,
       '(' + JSON.stringify(d) + ')');
  }
  let was = null;
  const step = function (fn, n) { was = counted(); fn(); return settle(n || 30); };
  const loop = function (fun) {
    return Promise.resolve().then(function () {
      setFun(fun);
      return step(function () { hitRows()[0].onclick(); });
    }).then(function () {
      expectScene('a hit clicked', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      return step(function () { $('swap-roles').onclick(); });
    }).then(function () {
      // THE USER'S CASE (24.09): the enemy's row has no figure - his characteristics file gives it now.
      expectScene('⇅ puts the Onslaught enemy on screen', fun, {model: true, shooter: true, hp: '1 950 / 1 950', source: FILE_HP}, delta(was));
      return step(function () { $('swap-roles').onclick(); });
    }).then(function () {
      expectScene('⇅ back', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      return step(function () { $('shooter-tile').onclick(); });   // the shooter's role: the side panel goes to Vehicles
    }).then(function () {
      expectScene('the side panel to Vehicles, the scene kept', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      return step(function () { sidebarModes[0].onclick(); });
    }).then(function () {
      expectScene('the side panel back to Hits', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      return step(function () { rosterRow(32).onclick(); });
    }).then(function () {
      expectScene('another shooter from the roster', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (the roster marks the new shooter)', !!rosterRow(32) && rosterRow(32).getAttribute('data-role') === 'shooter');
      return step(function () { $('model-tile').onclick(); });
    }).then(function () {
      expectScene('the side panel to Vehicles again', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      ok('matrix: (the Vehicles list offers the two browsable vehicles)', !!listRow('pm_quebec') && !!listRow('pm_papa'));
      return step(function () { listRow('pm_quebec').onclick(); });
    }).then(function () {
      // Audit PD-01 г: a browsed vehicle takes its export's figure, never the roster row of the battle beside it.
      expectScene('a vehicle browsed', fun, {model: true, shooter: true, hp: '1 600 / 1 600', source: OWN_HP}, delta(was));
      $('shooter-tile').onclick();   // the shooter's role in the list: no scene of its own
      return settle(10).then(function () { return step(function () { listRow('pm_papa').onclick(); }); });
    }).then(function () {
      expectScene('another shooter from the Vehicles list', fun, {model: true, shooter: true, hp: '1 600 / 1 600', source: OWN_HP}, delta(was));
      return step(function () { $('swap-roles').onclick(); });
    }).then(function () {
      expectScene('⇅ of two browsed vehicles', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: OWN_HP}, delta(was));
      // 24.09: a row without a model, in the shooter's role - its file's gun fires at the model on screen. It is not in
      // this battle, so the list is put on "All vehicles" first (and back after).
      scopeTo('all');
      ok('matrix: (the browser lists the row without a model too, marked)', !!listRow('germany-Uniform') && listRow('germany-Uniform').getAttribute('data-exported') === 'false',
         $('vehicles').children.map(function (c) { return c.getAttribute('data-vehicle') || c.className; }).join() + ' | ' + $('vehicle-count').textContent);
      return step(function () { listRow('germany-Uniform').onclick(); });
    }).then(function () {
      expectScene('a shooter without a model from the Vehicles list', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: OWN_HP}, delta(was));
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (the shooter is the file\'s top pair - the panel shows it, the scene keeps its model)',
         $('ttx-panel').hidden === false && $('scene-message').textContent.indexOf('not exported') < 0 && ttxAsked.indexOf('germany-Uniform') >= 0,
         '(panel hidden ' + $('ttx-panel').hidden + ', "' + $('scene-message').textContent + '")');
      $('model-tile').onclick();   // the model's role: no scene of its own
      return settle(10).then(function () { return step(function () { listRow('germany-Uniform').onclick(); }); });
    }).then(function () {
      // THE PATH OF 24.09: a vehicle without a model browsed - its tile and its characteristics, nothing drawn.
      expectScene('a vehicle without a model browsed', fun, {model: true, drawn: false, shooter: true, hp: null}, delta(was));
      const hp = $('ttx-hp').children[0];
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (a vehicle without a model - the scene says so, the panel shows its file, both tiles are it)',
         /^Model not exported yet\. In the game, one click on this vehicle opens it\.$/.test($('scene-message').textContent)
         && $('ttx-panel').hidden === false && !!hp && hp.ttx.value.textContent === '1111'
         && $('model-tile').title.indexOf('Uniform') >= 0 && $('shooter-tile').title.indexOf('Uniform') >= 0,
         '"' + $('scene-message').textContent + '" ' + (hp ? hp.ttx.value.textContent : 'no HP row'));
      return step(function () { listRow('pm_papa').onclick(); });
    }).then(function () {
      expectScene('a vehicle with a model after one without', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: OWN_HP}, delta(was));
      scopeTo('battle');
      return step(function () { sidebarModes[0].onclick(); });
    }).then(function () {
      expectScene('back to Hits with the browsed vehicle kept', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: OWN_HP}, delta(was));
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (no ⇅ for browsed vehicles in the Hits panel)', $('swap-roles').hidden === true);
      return step(function () { pickBattle('pm2'); }, 40);
    }).then(function () {
      expectScene('another battle', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: ROSTER_HP}, delta(was));
      // The model's role for the roster (the tile opens Vehicles), then back to Hits - neither is the path under test.
      $('model-tile').onclick();
      return settle(10).then(function () { sidebarModes[0].onclick(); return settle(10); });
    }).then(function () {
      return step(function () { rosterRow(33).onclick(); }, 40);
    }).then(function () {
      expectScene('a seat with no hits and no model - the scene emptied', fun, {model: false, shooter: false, hp: null}, delta(was));
      pickBattle('pm');
      return settle(40);
    });
  };
  // Warm up: every shooter's characteristics file read once, so an arriving file does not paint the panel again inside
  // a counted step (that later paint is an event of its own, not the scene's).
  $('sidebar-mode');
  if (!onBox.checked) { onBox.checked = true; onBox.onchange.call(onBox); }
  sidebarModes[0].onclick();
  return settle(20).then(function () {
    pickBattle('pm');
    return settle(40);
  }).then(function () {
    hitRows()[1].onclick();
    return settle(30);
  }).then(function () {
    $('swap-roles').onclick();
    return settle(30);
  }).then(function () {
    $('swap-roles').onclick();
    return settle(30);
  }).then(function () {
    ok('matrix: (the three shooters’ characteristics files are read once before the matrix)',
       ['germany-Romeo', 'germany-Quebec', 'germany-Papa'].every(function (id) { return ttxAsked.indexOf(id) >= 0; }), '(' + ttxAsked.join(', ') + ')');
    return loop(false);
  }).then(function () {
    return loop(true);
  }).then(function () {
    // Audit PD-01 б: the target's OWN characteristics file is read for it - Tango never was a shooter, and his row has no
    // figure. The bar comes when the file does.
    return step(function () { pickBattle('pm3'); }, 60);
  }).then(function () {
    ok('matrix, ⌖ on: a target whose only figure is in his own characteristics file - that file is read for him and the bar comes with it',
       ttxAsked.indexOf('germany-Tango') >= 0 && $('target-hp').hidden === false && $('target-hp-text').textContent === fig('1 234 / 1 234')
       && $('target-hp').title.indexOf('\n• Source: ' + FILE_HP) > 0,
       '(' + ttxAsked.join(', ') + ' · hidden ' + $('target-hp').hidden + ' · "' + $('target-hp-text').textContent + '")');
    setFun(false);
    Object.keys(keep).forEach(function (k) { D[k] = keep[k]; });
  });
}
