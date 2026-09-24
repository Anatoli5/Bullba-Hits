// viewer-batch (24.09): the REAL web/viewer.js and web/screen-armor.js on three r160 in Node, over a fake WebGL
// renderer that counts what the GPU would be asked to draw. Nothing is drawn; the renderer only records which
// scene each render() call was given, so a frame's cost reads as passes: the nine peel layers, the light pass,
// the full-screen composite and the frame itself.
//
//   node tests/page/viewer_batch.cjs            the checks (ok / FAIL lines, exit code 1 on a failure)
//   node tests/page/viewer_batch.cjs --measure [webdir]
//                                               the pass counts per wheel notch and the picking cost, for any copy
//                                               of web/ (the "before" figures were taken on a copy of HEAD 400b2db)
//
// tools/check.py runs it in its page suite; the page's side of the same changes (the Distance field and slider on the
// shot range) is checked in aim3_dom.cjs. The model is synthetic - boxes - and no battle data is read.
'use strict';
const fs = require('fs'), vm = require('vm');
const DEFAULT_WEB = process.env.BULLBA_WEB || require('path').join(__dirname, '..', '..', 'web').split('\\').join('/') + '/';

// ---------------------------------------------------------------------------------------------------------------
// The environment: a vm context with a manual clock, manual frames and manual timers.
function env(web) {
  web = web || DEFAULT_WEB;
  let now = 1000;
  const frames = [], timers = [];
  let frameId = 0, timerId = 0;
  const count = {peel: 0, light: 0, composite: 0, frame: 0, other: 0, fbcheck: 0};
  function el() {
    return {style: {setProperty() {}}, classList: {add() {}, toggle() {}, remove() {}}, hidden: false, children: [],
      setAttribute() {}, getAttribute() { return null; }, appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      replaceChildren() { this.children = []; }, remove() {}, addEventListener() {}};
  }
  const sb = {console, Math, JSON, Object, Array, String, Number, Error, Set, Map, WeakMap, Symbol, Promise, Proxy, Reflect,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray,
    ArrayBuffer, SharedArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt,
    Event: function (n) { this.type = n; }};
  sb.window = sb; sb.self = sb; sb.globalThis = sb; sb.devicePixelRatio = 1;
  sb.performance = {now: function () { return now; }};
  sb.addEventListener = function () {}; sb.dispatchEvent = function () {};
  sb.requestAnimationFrame = function (fn) { frames.push({id: ++frameId, fn: fn}); return frameId; };
  sb.cancelAnimationFrame = function (id) { const i = frames.findIndex(function (f) { return f.id === id; }); if (i >= 0) frames.splice(i, 1); };
  sb.setTimeout = function (fn, ms) { timers.push({id: ++timerId, fn: fn, at: now + (ms || 0)}); return timerId; };
  sb.clearTimeout = function (id) { const i = timers.findIndex(function (t) { return t.id === id; }); if (i >= 0) timers.splice(i, 1); };
  sb.localStorage = {getItem: function () { return null; }, setItem: function () {}};
  sb.document = {createElement: function () { return el(); }, addEventListener: function () {}, hidden: false};
  // three's "build/three.min.js is deprecated" notice and the viewer's own warnings are not what is looked at here.
  sb.console = {log: console.log, warn: function () {}, error: console.error};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(web + 'vendor/three.min.js', 'utf8'), sb, {filename: 'three.min.js'});
  vm.runInContext(fs.readFileSync(web + 'vendor/three-mesh-bvh.umd.js', 'utf8').replace(/typeof exports === 'object'/, 'false'), sb, {filename: 'three-mesh-bvh.umd.js'});
  for (const name of ['ballistics.js', 'screen-armor.js', 'viewer.js']) vm.runInContext(fs.readFileSync(web + name, 'utf8'), sb, {filename: name});
  const T = sb.THREE;
  let viewer = null, target = null;
  const gl = {FRAMEBUFFER: 1, FRAMEBUFFER_COMPLETE: 2, getExtension: function (n) { return n === 'EXT_color_buffer_float' ? {} : null; },
    getParameter: function () { return ''; }, checkFramebufferStatus: function () { count.fbcheck++; return 2; },
    getProgramInfoLog: function () { return ''; }, getShaderInfoLog: function () { return ''; }};
  const W = 1600, H = 900;
  T.WebGLRenderer = function () {
    this.domElement = {addEventListener: function () {}};
    this.capabilities = {isWebGL2: true, maxTextures: 16, maxTextureSize: 16384};
    this.debug = {onShaderError: null}; this.autoClear = true;
  };
  const R = T.WebGLRenderer.prototype;
  R.setPixelRatio = function () {}; R.getPixelRatio = function () { return 1; }; R.setSize = function () {};
  R.getContext = function () { return gl; };
  R.getRenderTarget = function () { return target; }; R.setRenderTarget = function (t) { target = t; };
  R.getViewport = function (v) { return v.set(0, 0, W, H); }; R.setViewport = function () {};
  R.getScissor = function (v) { return v.set(0, 0, W, H); }; R.setScissor = function () {};
  R.getScissorTest = function () { return false; }; R.setScissorTest = function () {};
  R.getClearColor = function (c) { return c; }; R.getClearAlpha = function () { return 0; }; R.setClearColor = function () {};
  R.clear = function () {}; R.compile = function () {};
  R.getDrawingBufferSize = function (v) { return v.set(W, H); };
  R.render = function (scene) {
    const s = viewer && viewer.surface;
    if (s && scene === s.captureScene) count.peel++;
    else if (s && scene === s.lightScene) count.light++;
    else if (s && scene === s.compositeScene) count.composite++;
    else if (viewer && scene === viewer.scene) count.frame++;
    else count.other++;
  };
  const container = Object.assign(el(), {clientWidth: W, clientHeight: H, focus() {}, setPointerCapture() {},
    getBoundingClientRect: function () { return {left: 0, top: 0, width: W, height: H}; }});
  const handlers = {};
  container.addEventListener = function (n, f) { handlers[n] = f; };
  viewer = new sb.ArmorViewer(container);
  // One browser frame: the frame callbacks queued so far run with the clock moved on by `dt` ms; timers due by then
  // run first, as a browser would have run them in between.
  function frame(dt) {
    now += dt === undefined ? 21.3 : dt;
    runTimers();
    const list = frames.splice(0);
    list.forEach(function (f) { f.fn(now); });
    return list.length;
  }
  function runTimers() {
    for (;;) {
      timers.sort(function (a, b) { return a.at - b.at; });
      if (!timers.length || timers[0].at > now) return;
      const t = timers.shift(); t.fn();
    }
  }
  // Everything still pending, frames and timers, until nothing is left (or `limit` frames).
  function settle(limit) {
    let n = 0;
    for (; n < (limit || 500); n++) {
      if (!frames.length && !timers.length) break;
      if (!frames.length) { now = Math.max(now, timers.reduce(function (m, t) { return Math.min(m, t.at); }, Infinity)); runTimers(); continue; }
      frame();
    }
    return n;
  }
  function reset() { Object.keys(count).forEach(function (k) { count[k] = 0; }); }
  return {sb: sb, T: T, viewer: viewer, count: count, frame: frame, settle: settle, reset: reset, handlers: handlers,
    frames: frames, timers: timers, clock: function () { return now; }, advance: function (ms) { now += ms; runTimers(); }, W: W, H: H};
}

// ---------------------------------------------------------------------------------------------------------------
// A synthetic vehicle: hull, turret, gun barrel and a chassis slab, each a box; one recorded contact on the hull's
// face, a 5 m clinch shot arriving slightly downwards.
function box(cx, cy, cz, sx, sy, sz, split) {
  // `split` subdivides each face into split x split quads, for a heavier model.
  const v = [], idx = [], n = split || 1;
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  const half = [sx / 2, sy / 2, sz / 2];
  faces.forEach(function (f) {
    const nrm = f[0], a = f[1], b = f[2], base = v.length;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const s = i / n * 2 - 1, t = j / n * 2 - 1, p = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = (nrm[k] + a[k] * s + b[k] * t) * half[k];
      v.push([cx + p[0], cy + p[1], cz + p[2]]);
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const q = base + i * (n + 1) + j;
      idx.push(q, q + n + 1, q + n + 2, q, q + n + 2, q + 1);
    }
  });
  return {groups: [{material: 1, vertices: v, indices: idx}]};
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function vehicle(split) {
  const armor = {1: {armor: 80, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true}};
  const hit = {target: {parts: [{id: 0, transform: I, armor: {1: {armor: 20, vehicleDamageFactor: 0}}}, {id: 1, transform: I, armor: armor},
    {id: 2, transform: I, armor: armor}, {id: 3, transform: I, armor: armor}]},
    points: [{status: 'resolved', part: 1, position: [0.6, 1.2, -1.5], direction: [0, -0.1, 1], effect: 0}],
    rangeAtImpact: 5, aim: [0, 0], attacker: {gunHeight: 2.1, gunHeightFrom: 'ground'}};
  const models = {0: box(0, .3, 0, 6.5, .6, 3.4, split), 1: box(0, 1.2, 0, 6, 1.6, 3, split), 2: box(0, 2.4, .2, 3, 1, 2.5, split), 3: box(0, 2.5, -3, .2, .2, 4, split)};
  return {hit: hit, models: models};
}
// A viewer with the vehicle loaded, the map on, Soft lighting on (the page's default) and every frame run out.
function loaded(e, split, range) {
  const v = e.viewer;
  v.setLighting(true);
  v.configure(e.sb.ArmorBallistics.shell('ARMOR_PIERCING', 250, 105), true, 'classic', 'chance');
  v.clear();
  v.load(vehicle(split), {range: range || 5});
  e.settle();
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Measurements: passes per notch for each wheel path, and the cost of one pick.
function measure(web) {
  const out = [];
  function row(label, c, frames, extra) {
    out.push(label.padEnd(58) + ' frames ' + String(frames).padStart(3) + ' | peel layers ' + String(c.peel).padStart(4) + ' (' + (c.peel / 9).toFixed(0) + ' sets)'
      + ' | light ' + String(c.light).padStart(3) + ' | composite ' + String(c.composite).padStart(3) + (extra ? ' | ' + extra : ''));
  }
  function run(label, before, act) {
    const e = env(web), v = loaded(e);
    if (before) before(v, e);
    e.settle(); e.reset();
    const f = act(v, e);
    const rest = e.settle();
    row(label, e.count, (f || 0) + rest);
  }
  const notch = Math.exp(100 * .002);
  // The Zoom slider or its number box turned by the wheel: the page sets the zoom once per frame for each notch.
  run('Zoom slider, 1 notch (setZoom once)', null, function (v, e) { v.setZoom(v.camera.zoom * 1.1); return 0; });
  run('Zoom slider, 10 notches, one per frame', null, function (v, e) { for (let i = 0; i < 10; i++) { v.setZoom(v.camera.zoom * 1.1); e.frame(); } return 10; });
  // Shift + wheel over the scene: the zoom glide (Auto frame off, the default).
  run('Shift + wheel over the scene, 1 notch (zoom glide)', function (v) { v.setAutoFrame(false); }, function (v) { v.zoomTo(v.camera.zoom * notch); return 0; });
  run('Shift + wheel, Auto frame on, 1 notch (frame-scale glide)', function (v) { v.setAutoFrame(true); }, function (v) { v.scaleTo(v.frameScale * notch); return 0; });
  // The Distance: the scene wheel (orbit-radius glide) and the slider (one set per notch).
  run('Wheel over the scene, 1 notch (distance glide)', function (v) { v.setAutoFrame(false); }, function (v) { v.distanceTo(v.distance * notch); return 0; });
  run('Distance slider, 1 notch (setDistance once)', null, function (v) { v.setDistance(v.distance * 1.05); return 0; });
  run('Distance slider, 10 notches, one per frame', null, function (v, e) { for (let i = 0; i < 10; i++) { v.setDistance(v.distance * 1.05); e.frame(); } return 10; });
  // A hit click: the page's clear() and the load, and what the viewer tells the page on the way.
  (function () {
    const e = env(web), v = loaded(e);
    let cams = 0, poses = 0;
    v.onCamera = function () { cams++; }; v.onTurret = function () { poses++; }; v.onGun = function () { poses++; };
    e.reset();
    v.clear(); v.load(vehicle(), {range: 5});
    const rest = e.settle();
    row('Hit click (page clear() + load())', e.count, rest, 'onCamera ' + cams + ', pose notifications ' + poses);
  }());
  // One pick: the model split to ~30 000 triangles, 400 rays over it, linear three raycast against the viewer's own.
  (function () {
    const e = env(web), v = loaded(e, 30), T = e.T;
    const objects = [v.paintMesh]; if (v.trackMesh) objects.push(v.trackMesh);
    const tris = v.samples.length + v.trackTriangles.length, rays = [];
    for (let i = 0; i < 400; i++) {
      const a = i * 2.399963, r = 3 * Math.sqrt(i / 400);
      const o = new T.Vector3(r * Math.cos(a), 1.5 + r * Math.sin(a) * .5, -30), d = new T.Vector3(0, 1.2, 0).sub(o).normalize();
      rays.push([o, d]);
    }
    let t0 = process.hrtime.bigint(), hits = 0;
    rays.forEach(function (r) { const h = new T.Raycaster(r[0], r[1]).intersectObjects(objects); if (h.length) hits++; });
    const linear = Number(process.hrtime.bigint() - t0) / 1e3 / rays.length;
    let text = 'triangles ' + tris + ' | linear three raycast ' + linear.toFixed(1) + ' µs/ray (' + hits + '/' + rays.length + ' hit)';
    if (typeof v.pick === 'function') {
      v.pick(rays[0][0], rays[0][1]);   // the tree is built on the first pick
      const b0 = process.hrtime.bigint(); v.dropPickTrees(); v.pick(rays[0][0], rays[0][1]); const build = Number(process.hrtime.bigint() - b0) / 1e6;
      t0 = process.hrtime.bigint(); let h2 = 0;
      rays.forEach(function (r) { if (v.pick(r[0], r[1])) h2++; });
      const tree = Number(process.hrtime.bigint() - t0) / 1e3 / rays.length;
      text += ' | viewer.pick (BVH) ' + tree.toFixed(1) + ' µs/ray (' + h2 + '/' + rays.length + ' hit), tree built once in ' + build.toFixed(1) + ' ms';
    }
    out.push('Picking: ' + text);
  }());
  console.log(out.join('\n'));
}

// ---------------------------------------------------------------------------------------------------------------
// The checks.
function checks(ok, web) {
  // Each block on its own: one that throws (an older viewer without the method) fails, and the rest still run.
  const section = function (fn) { try { fn(); } catch (e) { ok('viewer-batch: a block threw', false, String(e && e.message)); } };
  const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); };

  // ---- 1. ZOOM is a 2D change of the last composed picture ------------------------------------------------------
  section(function () {
    const e = env(web), v = loaded(e), s = v.surface;
    ok('viewer-batch: the composition is up after a load (the fake renderer took peels and a composite)', !!s && !!s.result);
    e.reset();
    for (let i = 0; i < 10; i++) { v.setZoom(v.camera.zoom * 1.1); e.frame(); }
    ok('viewer-batch: ten notches of the Zoom slider, one per frame, peel and compose nothing', e.count.peel === 0 && e.count.composite === 0 && e.count.light === 0,
       '(peel ' + e.count.peel + ', composite ' + e.count.composite + ', light ' + e.count.light + ')');
    ok('viewer-batch: and every one of those frames was drawn (the map is scaled, not frozen)', e.count.frame === 10, '(' + e.count.frame + ')');
    ok('viewer-batch: the picture is scaled in 2D meanwhile (uView is not the identity)', s.markMaterial.uniforms.uView && s.markMaterial.uniforms.uView.value.x !== 1);
    // The 2D transform maps a pixel of the current view onto the pixel of the SAME world point in the layers' view.
    const T = e.T, layerCam = new T.PerspectiveCamera();
    const L = s.cameraCache, P = new T.Matrix4().fromArray(Array.prototype.slice.call(L, 16, 32)), M = new T.Matrix4().fromArray(Array.prototype.slice.call(L, 0, 16));
    layerCam.projectionMatrix.copy(P); layerCam.projectionMatrixInverse.copy(P).invert(); layerCam.matrixWorld.copy(M); layerCam.matrixWorldInverse.copy(M).invert();
    const uv = s.markMaterial.uniforms.uView.value, pts = [new T.Vector3(0.6, 1.2, -1.5), new T.Vector3(3, 2, 1.5), new T.Vector3(-2.9, .1, -1.6)];
    let worst = 0;
    pts.forEach(function (p) {
      const now = p.clone().project(v.camera), then = p.clone().project(layerCam);
      const px = (now.x + 1) / 2 * e.W, py = (now.y + 1) / 2 * e.H, lx = (then.x + 1) / 2 * e.W, ly = (then.y + 1) / 2 * e.H;
      worst = Math.max(worst, Math.hypot(px * uv.x + uv.z - lx, py * uv.y + uv.w - ly));
    });
    ok('viewer-batch: the 2D transform puts every world point on the layer pixel it was composed at (< 1e-6 px)', worst < 1e-6, '(' + worst.toExponential(2) + ' px)');
    e.reset();
    const after = e.settle();
    ok('viewer-batch: once the zoom has stood still, ONE full composition sharpens it', e.count.peel === 9 && e.count.composite === 1 && e.count.light === 1,
       '(peel ' + e.count.peel + ', composite ' + e.count.composite + ', light ' + e.count.light + ', frames ' + after + ')');
    ok('viewer-batch: and the picture is the layers\' own again (uView back to the identity)', uv.x === 1 && uv.y === 1 && uv.z === 0 && uv.w === 0);
    e.reset(); e.frame(); e.settle();
    ok('viewer-batch: a still frame after that composes nothing', e.count.peel === 0 && e.count.composite === 0);
    // A camera move while the 2D zoom is pending is a real move: it peels at once.
    v.setZoom(v.camera.zoom * 1.1); e.frame(); e.reset();
    v.orbitTo(v.targetYaw + .1, v.targetPitch); e.frame(); e.frame();
    ok('viewer-batch: an orbit during the 2D zoom peels at once (the camera really moved)', e.count.peel >= 9, '(' + e.count.peel + ')');
    e.settle();
    // Auto frame: the wheel with a modifier glides the frame scale - the same zoom-only change.
    v.setAutoFrame(true); e.settle(); e.reset();
    v.scaleTo(v.frameScale * 1.3);
    let peelsDuring = 0; for (let i = 0; i < 8; i++) { e.frame(); peelsDuring += e.count.peel; e.count.peel = 0; }
    ok('viewer-batch: the Auto-frame scale glide is a 2D zoom too (no peel while it glides)', peelsDuring === 0, '(' + peelsDuring + ')');
    e.settle(); v.setAutoFrame(false); e.settle();
    // A resize is not a zoom: the layers go.
    e.reset(); s.renderer.getDrawingBufferSize = function (vec) { return vec.set(1200, 900); };
    v.camera.aspect = 1200 / 900; v.camera.updateProjectionMatrix(); v.viewWidth = 1200; v.projection(); v.draw(); e.frame();
    ok('viewer-batch: a new drawing-buffer size is never taken for a zoom (full composition)', e.count.peel === 9 && e.count.composite === 1, '(' + e.count.peel + ')');
  });

  // ---- 2. DISTANCE is re-rendered, one composition per drawn frame, none wasted ----------------------------------
  section(function () {
    const e = env(web), v = loaded(e);
    v.setAutoFrame(false); e.settle(); e.reset();
    v.distanceTo(v.distance * Math.exp(.2));
    const frames = e.settle();
    ok('viewer-batch: a distance glide peels on every frame it moves the camera, and composes once per peel', e.count.composite * 9 === e.count.peel && e.count.peel > 0,
       '(frames ' + frames + ', peel ' + e.count.peel + ', composite ' + e.count.composite + ')');
    ok('viewer-batch: never more compositions than frames drawn', e.count.composite <= e.count.frame, '(' + e.count.composite + ' / ' + e.count.frame + ')');
    // At 50 m the easing tail that moves nothing by half a pixel is not composed any more (16 compositions a notch before).
    const e2 = env(web), v2 = loaded(e2, 1, 50);
    v2.setAutoFrame(false); e2.settle(); e2.reset();
    const goal = v2.distance * Math.exp(.2); v2.distanceTo(goal); e2.settle();
    ok('viewer-batch: a distance notch at 50 m composes at most 14 frames (the sub-pixel tail is cut)', e2.count.composite > 0 && e2.count.composite <= 14, '(' + e2.count.composite + ')');
    ok('viewer-batch: and the glide still lands exactly on its target', v2.distance === goal, '(' + v2.distance + ' / ' + goal + ')');
    // VIEW-15: the Soft lighting depth changes one uniform of the composite - it composes once and peels nothing.
    e2.reset(); v2.setLightStrength(2); e2.settle();
    ok('viewer-batch: the Soft lighting depth slider composes once and peels nothing', e2.count.peel === 0 && e2.count.composite === 1, '(peel ' + e2.count.peel + ', composite ' + e2.count.composite + ')');
  });

  // ---- 3. VIEW-03: the shot range is camera -> hit point, one owner -----------------------------------------------
  section(function () {
    const e = env(web), v = loaded(e, 1, 5);
    ok('viewer-batch: after a hit click the shot range is the recorded range (camera -> hit point), not the orbit radius',
       near(v.shotRange(), 5, 1e-3) && Math.abs(v.distance - 5) > .1, '(range ' + v.shotRange() + ', orbit ' + v.distance.toFixed(3) + ')');
    let ranges = [];
    v.onCamera = function (st) { ranges.push(st.range); };
    const eye = v.camera.position.clone();
    v.setPivot('hit'); e.settle();
    ok('viewer-batch: ⊙ Hit keeps the eye and the shot range', v.camera.position.distanceTo(eye) < 1e-9 && near(v.shotRange(), 5, 1e-3), '(' + v.shotRange() + ')');
    v.setPivot('vehicle'); e.settle();
    ok('viewer-batch: ⊙ Vehicle back: still the same eye and the same range', v.camera.position.distanceTo(eye) < 1e-6 && near(v.shotRange(), 5, 1e-3), '(' + v.shotRange() + ')');
    ok('viewer-batch: every camera report on the way carried that same range', ranges.length > 0 && ranges.every(function (r) { return near(r, 5, 1e-3); }), '(' + ranges.join(', ') + ')');
    v.setShotRange(40); e.settle();
    ok('viewer-batch: setting the Distance field to 40 m puts the camera 40 m from the hit point', near(v.shotRange(), 40, 1e-3) && near(v.camera.position.distanceTo(v.point), 40, 1e-3), '(' + v.shotRange() + ')');
    v.setShotRange(12); e.settle();
    ok('viewer-batch: and 12 m', near(v.shotRange(), 12, 1e-3));
    // Without a hit point (a vehicle opened without a shot) the range is the camera's distance to the orbit centre.
    const e2 = env(web), v2 = e2.viewer;
    v2.configure(e2.sb.ArmorBallistics.shell('ARMOR_PIERCING', 250, 105), true, 'classic', 'chance');
    const data = vehicle(); data.hit.points = []; v2.load(data, {}); e2.settle();
    ok('viewer-batch: without a hit point the range is the orbit distance', near(v2.shotRange(), v2.distance, 1e-3), '(' + v2.shotRange() + ' / ' + v2.distance + ')');
    v2.setShotRange(33); e2.settle();
    ok('viewer-batch: and setting it sets that distance', near(v2.distance, 33, 1e-9));
  });

  // ---- 4. VIEW-07: one notification per real change --------------------------------------------------------------
  section(function () {
    const e = env(web), v = loaded(e);
    let cams = 0, poses = 0;
    v.onCamera = function () { cams++; }; v.onTurret = function () { poses++; }; v.onGun = function () { poses++; };
    v.clear();
    ok('viewer-batch: clear() tells the page nothing (the camera did not move)', cams === 0 && poses === 0, '(' + cams + ', ' + poses + ')');
    v.load(vehicle(), {range: 5}); e.settle();
    ok('viewer-batch: a hit click reports the camera once and the pose once', cams === 1 && poses === 1, '(camera ' + cams + ', pose ' + poses + ')');
    cams = 0; v.configure(v.shell, true, 'classic', 'chance'); e.settle();
    ok('viewer-batch: a new shell (configure) does not report an unmoved camera', cams === 0, '(' + cams + ')');
    cams = 0; v.render(); v.render(); e.settle();
    ok('viewer-batch: a render with the camera where it was reports nothing', cams === 0, '(' + cams + ')');
    cams = 0; v.setDistance(v.distance * 1.2); e.settle();
    ok('viewer-batch: one setDistance, one report', cams === 1, '(' + cams + ')');
    cams = 0; v.setZoom(v.camera.zoom * 1.2); e.settle();
    ok('viewer-batch: one setZoom, one report', cams === 1, '(' + cams + ')');
    cams = 0; v.setTurret(20); e.settle();
    ok('viewer-batch: a committed pose (new engine) is still reported to the page, once', cams === 1, '(' + cams + ')');
    // While the camera is still on its way the page puts the shell off (the range moves as the camera orbits the vehicle);
    // the last report of the move must say it has arrived, or the page would wait for a timer it does not need.
    const gliding = [];
    v.onCamera = function () { gliding.push(v.cameraGliding()); };
    v.orbitTo(v.targetYaw + .3, v.targetPitch); e.settle();
    ok('viewer-batch: an orbit reports "still gliding" on its way and "arrived" on its last report',
       gliding.length > 2 && gliding.slice(0, -1).every(Boolean) && gliding[gliding.length - 1] === false, '(' + gliding.map(Number).join('') + ')');
    gliding.length = 0; v.distanceTo(v.distance * 1.3); e.settle();
    ok('viewer-batch: so does a distance glide', gliding.length > 2 && gliding.slice(0, -1).every(Boolean) && gliding[gliding.length - 1] === false, '(' + gliding.map(Number).join('') + ')');
  });

  // ---- 5. VIEW-02: the zoom has one owner; Fit's zoom survives the next render under Auto frame -------------------
  section(function () {
    const e = env(web), v = loaded(e);
    v.setAutoFrame(true); e.settle();
    v.setPivot('hit'); e.settle();
    const fitted = v.camera.zoom; v.render(); e.settle();
    ok('viewer-batch: Auto frame on, ⊙ Hit: the Fit zoom is still the zoom after the next render (was a jump)', near(v.camera.zoom, fitted, 1e-9), '(' + fitted + ' -> ' + v.camera.zoom + ')');
    const z = v.camera.zoom; v.pan.set(2, 1); v.render(); e.settle();
    ok('viewer-batch: a pan does not re-zoom under Auto frame (the framing reads the orbit distance)', near(v.camera.zoom, z, 1e-9), '(' + z + ' -> ' + v.camera.zoom + ')');
  });

  // ---- 6. VIEW-01: the ricochet leg is off while the pose is only previewed ----------------------------------------
  section(function () {
    const e = env(web), v = loaded(e), s = v.surface;
    ok('viewer-batch: at rest the bounced leg is traced', s.material.uniforms.uBounce.value === 1);
    v.dragging = true; v.setTurret(25); e.frame();
    ok('viewer-batch: while the turret drag previews the pose, the leg (built for the old turret) is off', v.poseStale === true && s.material.uniforms.uBounce.value === 0);
    e.advance(400); e.frame();
    ok('viewer-batch: still off while the drag is held still (idle-settle must not bring it back on the old BVH)', v.poseStale !== true || s.material.uniforms.uBounce.value === 0);
    v.dragging = false; v.commitPose(); e.settle();
    ok('viewer-batch: once the pose is committed the leg is traced again', v.poseStale === false && s.material.uniforms.uBounce.value === 1);
  });

  // ---- 7. VIEW-05: one picking service, on a BVH, same answers as the linear raycast -------------------------------
  section(function () {
    const e = env(web), v = loaded(e, 6), T = e.T;
    const objects = [v.paintMesh]; if (v.trackMesh) objects.push(v.trackMesh);
    let same = 0, total = 0, bad = '';
    for (let i = 0; i < 300; i++) {
      const a = i * 2.399963, r = 4 * Math.sqrt(i / 300);
      const o = new T.Vector3(r * Math.cos(a) * 1.5, 1.4 + r * Math.sin(a) * .6, (i % 2 ? -1 : 1) * 25), d = new T.Vector3((i % 7) * .1 - .3, 1.2, 0).sub(o).normalize();
      const lin = new T.Raycaster(o, d).intersectObjects(objects)[0] || null, got = v.pick(o, d);
      total++;
      if (!lin && !got) { same++; continue; }
      if (lin && got && lin.point.distanceTo(got.point) < 1e-6 && lin.object === got.object && lin.faceIndex === got.faceIndex) same++;
      else if (!bad) bad = i + ': ' + (lin ? lin.faceIndex : '-') + ' vs ' + (got ? got.faceIndex : '-');
    }
    ok('viewer-batch: viewer.pick gives the very contact, mesh and triangle the linear raycast gives (300 rays)', same === total, '(' + same + '/' + total + ' ' + bad + ')');
    ok('viewer-batch: the pick runs on a three-mesh-bvh tree built for the painted model', !!(v.paintMesh.geometry.boundsTree));
    v.dragging = true; v.setTurret(30); e.frame();
    ok('viewer-batch: a previewed pose drops the trees (their bounds are the old pose)', !v.paintMesh.geometry.boundsTree);
    v.dragging = false; v.commitPose(); e.settle();
  });

  // ---- 8. The live ring: one geometry for the viewer's life ---------------------------------------------------------
  section(function () {
    const e = env(web), v = loaded(e);
    v.setLiveAim(.4); v.liveAimPoint = v.point.clone(); v.aimCursorPoint = v.point.clone();
    v.drawLiveAim(); const line = v.spreadCircle, geometry = line && line.geometry;
    for (let i = 0; i < 10; i++) { v.setAimReload(i / 10); v.drawLiveAim(); }
    ok('viewer-batch: ten live-ring redraws (with the reload arc) reuse one line and one geometry', v.spreadCircle === line && line.geometry === geometry);
    v.setAimReload(.5); v.drawLiveAim();
    ok('viewer-batch: the reload arc is a draw range over it, half the ring at half the reload', line.geometry.drawRange.count === 49, '(' + line.geometry.drawRange.count + ')');
    ok('viewer-batch: the live ring stays over the pinned shot\'s ring (render order 15 > 14)', line.renderOrder === 15);
  });

  // ---- 9. The shot ring of an own shot (BACKLOG 28 step 2, 24.09) ----------------------------------------------------
  // First a filled disc, since the same evening a thick ring of long dashes (user): the frame (discAim) is the same.
  // The circle the server fired from: centre C = I - depth·(dx·e1 + dy·e2), radius angle·depth. For a shell flying in a
  // straight line from its muzzle to the impact point that centre is exactly muzzle + depth·n - the server axis carried
  // to the impact plane - which is what is checked, in the viewer's own frame (z mirrored).
  section(function () {
    const e = env(web), v = loaded(e), T = e.T;
    v.loadedData.hit.target.worldTransform = I;
    const Iw = [v.point.x, v.point.y, -v.point.z], o = [Iw[0], Iw[1] - 1, Iw[2] - 50], n = new T.Vector3(0.002, 0.018, 1).normalize();
    const vel = [0, 1, 2].map(function (i) { return (Iw[i] - o[i]) * 18; });
    const tracer = {id: 's1', own: true, origin: o, velocity: vel};
    const ring = {position: [Iw[0], Iw[1], Iw[2] + 2], direction: [0, 0, 1], diameter: .9, receivedAt: 10};
    const ctx = {aim: {clientMarker: ring}, tracer: tracer, serverShot: {update: {origin: o, vector: n.toArray(), dispersionAngle: .003}, from: 'last', stale: false, gap: 0}};
    e.settle(); e.reset();
    const drew = v.setShotContext(ctx); e.settle();
    const d = v.discAim, depth = new T.Vector3().fromArray(Iw).sub(new T.Vector3().fromArray(o)).dot(n);
    const want = new T.Vector3().fromArray(o).addScaledVector(n, depth); want.z *= -1;
    ok('viewer-batch: the disc is drawn beside the solid ring', drew && !!d && !!v.ringAim && !!v.shotDisc);
    ok('viewer-batch: disc centre = the server axis at the impact plane (< 1e-9 m)', d && d.center.distanceTo(want) < 1e-9, d ? '(' + d.center.distanceTo(want).toExponential(2) + ' m)' : '');
    ok('viewer-batch: disc radius = the update\'s angle × depth', d && near(d.radius, .003 * depth, 1e-12));
    const m = v.shotDisc, pos = new T.Vector3().setFromMatrixPosition(m.matrix), sx = new T.Vector3().setFromMatrixColumn(m.matrix, 0).length();
    ok('viewer-batch: the disc mesh stands at that centre with that radius', pos.distanceTo(d.center) < 1e-9 && near(sx, d.radius, 1e-9));
    const drawn = {peel: e.count.peel, composite: e.count.composite};   // what drawing the circles cost, before the checks below move the camera
    const U = m.material.uniforms, rgb = U.uColor.value.toArray().map(function (x) { return Math.round(x * 255); });
    ok('viewer-batch: the shot ring is blue, translucent (0.6), 6 px, inside, no depth test, under the tracers (4) and the rings (12)',
       rgb.join() === '59,130,255' && m.material.transparent && U.uOpacity.value === .6 && U.uWidth.value === 6 && U.uPlace.value === 0
       && !m.material.depthTest && m.renderOrder > 3 && m.renderOrder < 4, '(renderOrder ' + m.renderOrder + ', rgb ' + rgb + ', opacity ' + U.uOpacity.value + ')');
    // Long dashes: 12 of 80 %, an inner and an outer vertex per step.
    const sides = m.geometry.getAttribute('side').array, P = m.geometry.getAttribute('position');
    let covered = 0; for (let i = 0; i + 2 < P.count; i += 2) { const a = Math.atan2(P.getY(i), P.getX(i)), b = Math.atan2(P.getY(i + 2), P.getX(i + 2)); let dA = b - a; if (dA < 0) dA += 2 * Math.PI; if (dA < .07) covered += dA; }
    ok('viewer-batch: 12 long dashes cover 80 % of the circle, each step an inner and an outer vertex',
       near(covered / (2 * Math.PI), .8, 1e-6) && sides.length === P.count && Array.prototype.every.call(sides, function (x, i) { return x === i % 2; }), '(' + (covered / 2 / Math.PI).toFixed(4) + ')');
    // The band's width on screen, the vertex shader's own arithmetic: the widest of 32 directions round the ring.
    function bandPx() {
      m.onBeforeRender(); v.scene.updateMatrixWorld(true); v.camera.updateMatrixWorld(true);
      const mvM = new T.Matrix4().multiplyMatrices(v.camera.matrixWorldInverse, m.matrixWorld), Pm = v.camera.projectionMatrix;
      let most = 0;
      for (let k = 0; k < 32; k++) {
        const a = k / 32 * Math.PI * 2, px = [];
        [0, 1].forEach(function (side) {
          const mv = new T.Vector3(Math.cos(a), Math.sin(a), 0).applyMatrix4(mvM), rad = new T.Vector3(Math.cos(a), Math.sin(a), 0).transformDirection(mvM);
          const perPx = 2 * Math.max(-mv.z, 1e-4) / (Pm.elements[5] * Math.max(U.uViewH.value, 1));
          mv.addScaledVector(rad, (side - 1 + U.uPlace.value) * U.uWidth.value * perPx);
          const c = mv.applyMatrix4(Pm); px.push(new T.Vector2((c.x + 1) / 2 * v.viewWidth, (1 - c.y) / 2 * v.viewHeight));
        });
        most = Math.max(most, px[0].distanceTo(px[1]));
      }
      return most;
    }
    const w1 = bandPx(); v.setZoom(v.camera.zoom * 2); e.settle(); const w2 = bandPx(); v.setDistance(v.distance * 3); e.settle(); const w3 = bandPx();
    ok('viewer-batch: the band is 6 screen pixels wide, and stays so over a 2x zoom and a 3x distance (the shader, no CPU work)',
       Math.abs(w1 - 6) < .3 && Math.abs(w2 - 6) < .3 && Math.abs(w3 - 6) < .3 && U.uViewH.value === v.viewHeight, '(' + [w1, w2, w3].map(function (x) { return x.toFixed(2); }) + ' px)');
    v.setZoom(v.camera.zoom / 2); e.settle();
    ok('viewer-batch: the disc belongs to the recorded group (a pin or the first emulated shot hides it with the rings)', v.aimGroup.children.indexOf(m) >= 0);
    ok('viewer-batch: the circle figure is sampled over the disc while it is on; q = the shell offset over the radius', v.savedAim === d && d.kind === 'fired'
       && near(d.q, Math.tan(Math.acos(new T.Vector3().fromArray(vel).normalize().dot(n))) / .003, 1e-6), d ? '(q ' + d.q.toFixed(4) + ')' : '');
    ok('viewer-batch: drawing the shot ring and the outlines on a composed scene peels and composes nothing', drawn.peel === 0 && drawn.composite === 0, '(peel ' + drawn.peel + ', composite ' + drawn.composite + ')');
    e.reset(); v.setShotDisc(true, .35); e.settle();
    ok('viewer-batch: the opacity slider changes the one material and composes nothing', U.uOpacity.value === .35 && e.count.peel === 0 && e.count.composite === 0 && e.count.frame === 1,
       '(opacity ' + U.uOpacity.value + ', frames ' + e.count.frame + ')');
    v.setShotDisc(false, .35);
    ok('viewer-batch: switched off, the shot ring hides and the figure goes back to the solid ring', !m.visible && v.savedAim === v.ringAim);
    v.setShotDisc(true, .6);
    // The lab (temporary): colour, width and placement are uniforms; the dashes make the one geometry again, the old freed.
    const geo0 = m.geometry; let freed0 = 0; geo0.addEventListener('dispose', function () { freed0++; });
    e.reset(); v.setShotRingLook({color: [1, 0, 1], width: 10, place: .5}); e.settle();
    ok('viewer-batch: the lab\'s colour, thickness and placement change uniforms only, compose nothing',
       U.uColor.value.toArray().join() === '1,0,1' && U.uWidth.value === 10 && U.uPlace.value === .5 && m.geometry === geo0 && e.count.peel === 0 && e.count.composite === 0);
    v.setShotRingLook({dashes: 6, share: 1});
    ok('viewer-batch: new dashes make one new geometry for the ring on screen and free the old (share 100 %: one unbroken ring)',
       m.geometry !== geo0 && freed0 === 1 && m.geometry === v.ringGeom && m.geometry.getAttribute('position').count === 2 * (128 + 1));
    v.setShotRingLook({color: [59 / 255, 130 / 255, 1], width: 6, place: 0, dashes: 12, share: .8});
    const mat = m.material, geo = m.geometry;
    v.setShotContext(ctx);
    ok('viewer-batch: another hit makes a new mesh on the same geometry and material', v.shotDisc !== m && v.shotDisc.geometry === geo && v.shotDisc.material === mat);
    e.reset(); v.setZoom(v.camera.zoom * 1.1); e.frame();
    ok('viewer-batch: a 2D zoom frame draws the scene with the shot ring in it (it follows like the outlines)', e.count.frame === 1 && e.count.peel === 0 && v.shotDisc.parent === v.aimGroup);
    e.settle();
    // An old record: no update in the context, no disc; the solid ring carries the figure as before.
    v.setShotContext({aim: {clientMarker: ring}, tracer: tracer, serverShot: null});
    ok('viewer-batch: without the server update (records 0.7.6-0.7.12) no disc, the ring as before', !v.discAim && !v.shotDisc && v.savedAim === v.ringAim);
    // ⌖: the user's first emulated shot takes the recorded circles away - the disc with them - and dropping it brings them back.
    v.setShotContext(ctx); v.setLiveAim(.4); v.liveAimPoint = v.point.clone(); v.aimCursorPoint = v.point.clone(); v.drawLiveAim();
    const fired = v.setAimShot();
    ok('viewer-batch: the first emulated shot takes the disc away with the outlines', fired && !v.savedAimShown() && v.shotDisc.parent === v.aimGroup);
    v.clearAimShot();
    ok('viewer-batch: and dropping that shot brings the disc back', v.savedAimShown() && v.shotDisc.visible);
    // The centre's DIRECTION, not only containment (three-rings check 24.09): a turned and moved target, the server axis
    // 4 mrad left and 1 mrad up of the shell. A flipped sign or a swapped/mirrored e1/e2 would still hold the impact point
    // inside the ring but put the centre on the other side; here it must be the axis carried to the impact plane.
    const RT = new T.Matrix4().makeRotationFromEuler(new T.Euler(.1, 2.3, -.05)).setPosition(37, -4, 12);
    v.loadedData.hit.target.worldTransform = RT.toArray();
    const Iw2 = new T.Vector3(v.point.x, v.point.y, -v.point.z).applyMatrix4(RT), s2 = new T.Vector3(.3, -.02, 1).normalize();
    const o2 = Iw2.clone().addScaledVector(s2, -60), left = new T.Vector3().crossVectors(s2, new T.Vector3(0, 1, 0)).normalize(), up2 = new T.Vector3().crossVectors(left, s2);
    const n2 = s2.clone().addScaledVector(left, .004).addScaledVector(up2, .001).normalize();
    v.setShotContext({aim: {clientMarker: ring}, tracer: {id: 's2', own: true, origin: o2.toArray(), velocity: s2.clone().multiplyScalar(900).toArray()},
      serverShot: {update: {origin: o2.toArray(), vector: n2.toArray(), dispersionAngle: .006}, from: 'last', stale: false, gap: 0}});
    const c2 = v.discAim && v.discAim.center.clone(); if (c2) { c2.z *= -1; c2.applyMatrix4(RT); }
    const want2 = o2.clone().addScaledVector(n2, Iw2.clone().sub(o2).dot(n2)), off = c2 && c2.clone().sub(Iw2);
    ok('viewer-batch: turned target - the shot ring centre is the server axis at the impact plane: 4 mrad left, 1 mrad up of the hit (not mirrored)',
       c2 && c2.distanceTo(want2) < 1e-6 && near(off.dot(left) / 60, .004, 2e-4) && near(off.dot(up2) / 60, .001, 2e-4),
       c2 ? '(' + c2.distanceTo(want2).toExponential(2) + ' m; left ' + (off.dot(left) / .06).toFixed(2) + ' mrad, up ' + (off.dot(up2) / .06).toFixed(2) + ' mrad)' : '');
    v.loadedData.hit.target.worldTransform = I; v.setShotContext(ctx);
    let freed = 0; geo.addEventListener('dispose', function () { freed++; }); mat.addEventListener('dispose', function () { freed++; });
    v.clear();
    ok('viewer-batch: clear() drops the disc and both circles', !v.discAim && !v.ringAim && !v.shotDisc && !v.savedAim);
    ok('viewer-batch: and leaves the one shot-ring geometry and material alone (nothing to rebuild or recompile on the next hit)', freed === 0, '(' + freed + ' disposed)');
  });
}

module.exports = {env: env, vehicle: vehicle, loaded: loaded, measure: measure, checks: checks};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--measure') measure(args[1]);
  else {
    let failures = 0;
    const ok = function (name, cond, extra) {
      if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
      else console.log('ok   ' + name + (extra ? ' ' + extra : ''));
    };
    try { checks(ok, args[0]); } catch (e) { failures++; console.log('THREW ' + (e && e.stack)); }
    console.log(failures ? failures + ' FAILURES' : 'all passed');
    process.exitCode = failures ? 1 : 0;
  }
}
