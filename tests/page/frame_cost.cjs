/* THE FRAME COST OF THE EMULATION (27.09, frame-smoothness): the real page in a local headless browser (cdp.cjs, software
 * WebGL), the synthetic data of fixture.cjs, the live aiming ring driven by real input - the cursor circling over the model,
 * then W held and the cursor still moving, then everything at rest - and every task of the page's frame loop timed (28.09:
 * web/frame.js reports each task's time to BullbaFrame.probe; the page is not changed for the test).
 *
 * HOW EVENLY THE PICTURE MOVES (28.09, frame-sync): the game forwards the pointer at its own frame rate, not the page's, and a
 * steady hand then reached the page as uneven steps per frame. Pointer moves are sent here at a cadence of their own (not
 * waiting for the page), a left drag orbits the camera and the cursor circles the model with the ring, and the picture each
 * frame DREW is recorded (the viewer's render). Asked of the page:
 *   - one animation-frame loop: every frame callback the page asks for during the phases is web/frame.js's;
 *   - the camera turns by even steps: per 16.7 ms of frame time, the orbit's step varies by at most EVEN_CV (sd / mean), and
 *     no frame repeats the last picture while the drag goes on (before 28.09: 0.37-0.39, the steps spread 3.6 times);
 *   - the ring moves by even steps while the cursor circles: at most EVEN_CV_RING and at most two repeated frames (before:
 *     0.36-0.59 and 13-19 frames in which the ring stood while the cursor moved);
 *   - the host's line for that orbit carries the input and camera figures (host.js: 'input', 'camera step off').
 *
 * The fixture's models are boxes, where a ray costs microseconds. A real model costs 15-80 us a ray (KNOWLEDGE §14: 256 rays
 * 3.9 / 9.1 / 19.7 ms on the median / upper quartile / heavy models, 1024 rays 15.3 / 32.9 / 78.1 ms), so the harness makes
 * every ray of the viewer's engine spin for RAY_US microseconds (default 80: the heavy model). The integral of the ring is then
 * as dear as on a heavy model, and a frame that runs it in one piece shows.
 *
 * The phases run twice (28.09, steady-60): with the page's ray worker taking the figures (web/ballistics.js, a blob worker)
 * and on the main thread's slices after ArmorBallistics.useWorker(false) - the fallback where no worker starts.
 *
 * Asked of the page:
 *   - the worker runs, and its 1024-ray figure equals the main thread's, every field;
 *   - the frame telemetry of host.js: a line after ~5 s of emulation, silence at rest, an orbit flushed as one line;
 *   - the JS of the ring's own frame callbacks (aimTick and the figure's slices, aimEstTick) stays under BUDGET_MS a frame
 *     (two exceptions, none near the old spikes) while moving and coming to rest - the integral is sliced over frames;
 *   - the figure reaches the ring: taken while moving, and at rest the fine figure equals the one a synchronous 1024-ray
 *     integral over the same ring gives (liveAimProbability), text for text;
 *   - a shot's own figure, fired at rest and on the move, lands on its tile as the one-piece integral over its ring;
 *   - no uncaught exception.
 * THE STATISTICS LOG'S PASS UNDER AN ORBIT (04.10): the pass no longer waits for the user to stop. A battle of 450 hits is
 * opened and the scene dragged: the pass goes on, the frames of the drag are no worse than without it, and each of its
 * steps tells the frame loop its time (the rest of the pass's checks: tests/page/stats_pass.cjs).
 * The budget applies to the plain run only (no --throttle, no --data).
 *
 *   node tests/page/frame_cost.cjs [--verbose] [--measure] [--throttle=N] [--ray-us=N] [--gpu] [--data=<data folder>]
 *     --measure     print the frame-time histogram and the per-callback costs instead of only the checks
 *     --throttle=N  CPU throttling N x (Emulation.setCPUThrottlingRate) - a stand-in for the game's CEF under load
 *     --ray-us=N    the spin per ray (0: the box models' own cost)
 *     --gpu         the machine's GPU through ANGLE Direct3D 11 (the game CEF's path) instead of SwiftShader; with --measure
 *                   it also prints the slow frames of the page's start (the first scene's shader compile), the host's
 *                   3-second count and the GPU time of a composite and of a full peel
 *     --hit=N       the N-th hit row of the battle shown (default 0)
 *     --battle=ID   with --data: the battle to open first (default: the one the page shows)
 *     --data=DIR    a real data folder (read in place through a junction, nothing written into it) instead of the fixture:
 *                   local profiling only, the checks then do not apply
 *   exit 0 pass, 1 fail, 77 skip (no browser installed)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');
const fixture = require('./fixture.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const arg = (name, def) => { const a = process.argv.find((s) => s.indexOf('--' + name + '=') === 0); return a ? a.slice(name.length + 3) : def; };
const VERBOSE = process.argv.includes('--verbose'), MEASURE = process.argv.includes('--measure');
const THROTTLE = Number(arg('throttle', 1)), RAY_US = Number(arg('ray-us', 80)), DATA = arg('data', ''), GPU = process.argv.includes('--gpu');
// The ring's own JS per frame. The figure's slice is 3 ms (app.js AIM_EST_SLICE); aimTick and the ring's redraw add well under
// 1 ms on a desktop - the rest is a generous margin for a loaded test machine. Before 27.09 a coarse figure on the heavy model
// took ~21 ms in one frame every 120 ms and the fine one ~82 ms.
const BUDGET_MS = 10, SPIKE_MS = 40;
// How evenly the drawn picture moves (frame-sync, 28.09): the coefficient of variation of the per-frame step, per 16.7 ms of
// frame time, over the steady middle of a drag / a cursor circle. Measured 0.04-0.05 / 0.05-0.19 after, 0.37-0.39 / 0.36-0.59
// before (scratch stand, cadences 7 and 16 ms).
const EVEN_CV = 0.15, EVEN_CV_RING = 0.3;
// The Statistics log's pass under an orbit (04.10): the hits of the battle opened for it (about 8 s of pass at a hit per
// frame-sized step), the hits it must get through during a 2.5 s drag, and how long one of its steps may hold the main thread.
const PASS_HITS = 450, PASS_DRAG_HITS = 60, PASS_STEP_MS = 8;

let checks = 0, failures = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else if (VERBOSE) console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}

function stage() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-frame-'));
  fs.cpSync(WEB, path.join(folder, 'web'), {recursive: true});
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(folder, 'Viewer.html'));
  if (DATA) fs.symlinkSync(path.resolve(DATA), path.join(folder, 'data'), 'junction');
  else fixture.write(folder, {bulk: PASS_HITS});   // pmx: the battle whose Statistics log pass runs under the last orbit
  return folder;
}

// Before the page's scripts: the viewer instances kept, every animation-frame callback timed and named, long tasks counted.
const INIT = `(() => {
  const viewers = [];
  let wrapped;
  Object.defineProperty(window, '__bullbaViewers', {value: viewers});
  Object.defineProperty(window, 'ArmorViewer', {configurable: true, enumerable: true,
    get() { return wrapped; },
    set(V) { wrapped = new Proxy(V, {construct(t, args, nt) { const v = Reflect.construct(t, args, nt); viewers.push(v); return v; }}); }});
  const rec = {on: false, frames: new Map(), long: [], start: [], slow: [], tasks: []};
  Object.defineProperty(window, '__frames', {value: rec});
  const raf = window.requestAnimationFrame.bind(window);
  // The page's frame loop (web/frame.js) is one callback, 'tick'; its tasks are timed by the loop itself (BullbaFrame.probe,
  // set after load). Its total is kept apart ('.loop': a name with a dot is not added into a frame's total again).
  const label = (fn) => { if (fn.name === 'tick') return '.loop'; if (fn.name) return fn.name; const s = String(fn); return /countFrame/.test(s) ? 'render' : /hoverEvent/.test(s) ? 'hover' : /pendingPan|orbitId/.test(s) ? 'orbit' : 'other'; };
  rec.names = new Set();
  window.requestAnimationFrame = function (fn) {
    const name = label(fn);
    if (rec.on) rec.names.add(name);
    return raf(function (t) {
      const s = performance.now(); rec.cur = t;
      try { return fn(t); } finally { rec.cur = null;
        const d = performance.now() - s;
        if (rec.on) { const f = rec.frames.get(t) || {}; f[name] = (f[name] || 0) + d; rec.frames.set(t, f); }
        if (d > 50) rec.slow.push([name, Math.round(s), Math.round(d)]);
      }
    });
  };
  try { new PerformanceObserver((l) => { if (rec.on) l.getEntries().forEach((e) => rec.long.push(e.duration)); l.getEntries().forEach((e) => rec.tasks.push([Math.round(e.startTime), Math.round(e.duration)])); }).observe({entryTypes: ['longtask']}); } catch (e) {}
  // The host's own measure (host.js): frames counted over the first 3 s of the page.
  (function () { let n = 0, t0 = null; raf(function count(t) { if (t0 === null) t0 = t; n++; if (t - t0 < 3000) raf(count); else rec.start = [n, Math.round(t - t0)]; }); })();
  // A steady frame clock of our own, so the intervals between frames are seen even when nothing of the page's runs.
  (function tick(t) { if (rec.on && !rec.frames.has(t)) rec.frames.set(t, {}); raf(tick); })(0);
})();`;

// After load: the ray spin on every engine the viewer builds, and the readings.
const DRIVER = (rayUs) => `(() => {
  const spin = ${rayUs};
  const v = () => window.__bullbaViewers[window.__bullbaViewers.length - 1];
  window.__rays = 0;
  window.__slow = function () {
    const e = v() && v().engine;
    if (!e || e.__slow || !(spin > 0)) return;
    const ray = e.ray, lean = e.lean; e.__slow = true;
    e.ray = function () { window.__rays++; const t = performance.now() + spin / 1000; while (performance.now() < t) {} return ray.apply(this, arguments); };
    // The circle's integral casts the lean ray (28.09): the same spin on it.
    if (lean) e.lean = function () { window.__rays++; const t = performance.now() + spin / 1000; while (performance.now() < t) {} return lean.apply(this, arguments); };
  };
  setInterval(window.__slow, 20);
  // Every task of the page's frame loop, timed by the loop (frame-sync, 28.09), into the frame it ran in.
  if (window.BullbaFrame) window.BullbaFrame.probe = function (name, d, t) { const f = window.__frames; if (!f.on) return; const r = f.frames.get(t) || {}; r[name] = (r[name] || 0) + d; f.frames.set(t, r); };
  // What each frame DREW: the camera's yaw and the live ring's centre at the viewer's render (the renderer's own call).
  window.__shown = [];
  window.__watch = function () { const view = v(), r = view.renderer; if (r.__watched) return; r.__watched = true; const render = r.render.bind(r);
    r.render = function (scene, cam) { const out = render(scene, cam); const f = window.__frames; if (f.on && scene === view.scene) { const a = view.liveAim; window.__shown.push([f.cur, view.yaw, a ? a.center.x : NaN, a ? a.center.y : NaN, a ? a.center.z : NaN]); } return out; }; };
  window.__read = function () {
    const f = window.__frames, ts = Array.from(f.frames.keys()).sort((a, b) => a - b), rows = [];
    for (let i = 1; i < ts.length; i++) rows.push(Object.assign({gap: ts[i] - ts[i - 1]}, f.frames.get(ts[i])));
    return {rows: rows, long: f.long.slice()};
  };
  window.__record = function (on) { const f = window.__frames; if (on) { f.frames.clear(); f.long.length = 0; } f.on = on; };
  window.__figure = function () {
    const tile = document.getElementById('probe-circle-tile'), e = document.getElementById('probe-circle');
    return {shown: !!tile && !tile.hidden, text: e ? e.textContent : null, ring: !!(v() && v().liveAim)};
  };
  // What a synchronous integral over the ring on screen gives, as the tile would print it (app.js circleText/damagePct).
  window.__exact = function () {
    const view = v(), s = view.shell, r = view.liveAimProbability(s, 1024);
    if (!r) return null;
    if (s.alpha > 0) return Math.round(Math.max(0, Math.min(100, 100 * r.damage / s.alpha))) + ' %';
    return (r.unknown ? Math.round(r.low) + '–' + Math.round(r.high) : Math.round(r.low)) + ' %';
  };
  return true;
})()`;

const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const fix = (x) => (Math.round(x * 10) / 10).toFixed(1);

function summary(label, data) {
  const rows = data.rows, ring = rows.map((r) => (r.aimTick || 0) + (r.aimEstTick || 0)), gaps = rows.map((r) => r.gap);
  // Names starting with '.' are parts timed inside a callback (--measure): not added to the frame's total a second time.
  const all = rows.map((r) => Object.keys(r).filter((k) => k !== 'gap' && k[0] !== '.').reduce((s, k) => s + r[k], 0));
  const names = {};
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (k !== 'gap') { names[k] = names[k] || []; names[k].push(r[k]); } }));
  const out = {label: label, frames: rows.length, ringMax: Math.max(0, ...ring), ringP95: pct(ring, 95), jsMax: Math.max(0, ...all), overBudget: ring.filter((x) => x > BUDGET_MS).length,
    gapP50: pct(gaps, 50), gapP95: pct(gaps, 95), gapMax: Math.max(0, ...gaps), over20: gaps.filter((g) => g > 20).length,
    over33: gaps.filter((g) => g > 33.4).length, long: data.long.length, longMax: Math.max(0, ...data.long)};
  if (MEASURE) {
    console.log('--- ' + label + ': ' + rows.length + ' frames; interval p50 ' + fix(out.gapP50) + ' p95 ' + fix(out.gapP95) + ' max ' + fix(out.gapMax)
      + ' ms; >20 ms ' + out.over20 + ', >33 ms ' + out.over33 + '; long tasks ' + out.long + ' (max ' + fix(out.longMax) + ' ms)');
    console.log('    ring JS per frame (aimTick + aimEstTick): p95 ' + fix(out.ringP95) + ' max ' + fix(out.ringMax) + ' ms; all rAF JS max ' + fix(out.jsMax) + ' ms');
    Object.keys(names).sort().forEach((k) => { const a = names[k]; console.log('    ' + k.padEnd(12) + ' n ' + String(a.length).padStart(4) + '  p50 ' + fix(pct(a, 50)).padStart(6) + '  p95 ' + fix(pct(a, 95)).padStart(6) + '  max ' + fix(Math.max(...a)).padStart(6) + ' ms'); });
    const bins = [8, 12, 17, 20, 25, 33.4, 50, 100, 1e9], hist = bins.map(() => 0);
    gaps.forEach((g) => { hist[bins.findIndex((b) => g <= b)]++; });
    console.log('    frame interval histogram: ' + bins.map((b, i) => (b > 1e8 ? '>100' : '<=' + b) + ':' + hist[i]).join('  '));
  }
  return out;
}

let browserName = '';
async function main() {
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000, angle: GPU ? 'd3d11' : ''});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  browserName = browser.product;
  const folder = stage();
  let page;
  try {
    page = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    const ev = (js) => page.evaluate(js);
    await ev(DRIVER(RAY_US));
    const ready = await ev(`(async () => { for (let i = 0; i < 150; i++) { if (document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length) break; await new Promise((r) => setTimeout(r, 100)); } return {hits: document.querySelectorAll('#hits [data-hit]').length, webgl: !!(window.__bullbaViewers[0] && window.__bullbaViewers[0].renderer)}; })()`);
    ok('the page starts: hits listed, the viewer made with WebGL', ready.hits > 0 && ready.webgl, JSON.stringify(ready));
    if (!ready.webgl) throw new Error('no WebGL viewer');
    // An outgoing hit of the player (pm3: the player shoots, so the emulated shooter is his vehicle) or, on real data, the first.
    const battle = DATA ? arg('battle', '') : 'pm3';
    if (battle) await ev(`(() => { if (document.getElementById('battle-list').hidden) document.getElementById('battle-pick').click(); document.querySelector('#battle-list [data-id="${battle}"]').click(); })()`);
    await new Promise((r) => setTimeout(r, DATA ? 2500 : 800));
    await ev(`document.querySelectorAll('#hits [data-hit]')[${Number(arg('hit', 0))}].click()`);
    await new Promise((r) => setTimeout(r, 1500));
    const box = await ev(`(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height}; })()`);
    if (THROTTLE > 1) await page.send('Emulation.setCPUThrottlingRate', {rate: THROTTLE});
    const move = (x, y) => page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: x, y: y, button: 'none'});
    const key = (type, code, k, vk) => page.send('Input.dispatchKeyEvent', {type: type, code: code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk});
    const R = Math.min(box.w, box.h) * 0.08;
    // The cursor circles the middle of the scene for `ms`, one move per ~16 ms of wall clock.
    async function circle(ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const a = (Date.now() - t0) / 700 * Math.PI; await move(box.x + R * Math.cos(a), box.y + R * Math.sin(a)); await new Promise((r) => setTimeout(r, 16)); }
    }
    await move(box.x, box.y); await new Promise((r) => setTimeout(r, 500)); await ev('window.__slow()');
    await ev(`document.getElementById('viewport').focus()`);
    const ringUp = await ev('window.__figure()');
    if (MEASURE && GPU) {
      const st = await ev(`(() => ({start: window.__frames.start, slow: window.__frames.slow, tasks: window.__frames.tasks, gl: (() => { const g = window.__bullbaViewers[0].renderer.getContext(), d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })()}))()`);
      console.log('GPU: ' + st.gl);
      // The first scene's shader compile is the first 'render' callback's stall (the D3D11 compiler; SwiftShader compiles fast).
      console.log('slow frame callbacks (> 50 ms) [name, at ms, ms]: ' + JSON.stringify(st.slow.slice(0, 12)) + '; long tasks [at ms, ms]: ' + JSON.stringify(st.tasks.slice(0, 12)));
      console.log('start: host-style count ' + st.start[0] + ' frames over ' + st.start[1] + ' ms = ' + Math.round(st.start[0] * 1000 / st.start[1]) + ' frames/s');
      // The GPU time of the heavy passes. gl.finish() is only a flush in Chrome (0 ms whatever the work - stack-compare §3.2,
      // 28.09), so each pass is fenced by a 1-pixel readPixels of the canvas, which waits for everything queued before it;
      // the paths are interleaved (a GPU's clock and a shared GPU's load drift between blocks), median of 15. Where
      // EXT_disjoint_timer_query_webgl2 is offered, its GPU-side time is given beside.
      // EVERY PATH IN ITS OWN MODE (28.09, steady-60-fix, D-092's correction): the exact ones ('exact', the leg unbounded)
      // are exact by the viewer's own switch, not by a guess at movedAt - a composite() alone takes the leg's budget the
      // last render() left in its uniform, and the peel's dropped layers used to start the camera's settle (the budgeted
      // leg). "moving" is a camera that has just moved ('always', the leg on its budget). Nothing of the page draws in
      // between: the viewer's draw() is held and its bounce redraw timer cleared, so no animation frame lands in a pass.
      const gpu = await ev(`(async () => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], r = v.renderer, g = r.getContext(), s = v.surface, out = {}, px = new Uint8Array(4);
        const ext = g.getExtension('EXT_disjoint_timer_query_webgl2'), u = s.material.uniforms, mode = v.bounceMode;
        const fence = () => { r.setRenderTarget(null); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); };
        const query = async (fn) => { if (!ext) return NaN; const q = g.createQuery(); g.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(); g.endQuery(ext.TIME_ELAPSED_EXT); fence();
          for (let i = 0; i < 200 && !g.getQueryParameter(q, g.QUERY_RESULT_AVAILABLE); i++) await new Promise((z) => setTimeout(z, 2));
          const ns = g.getQueryParameter(q, g.QUERY_RESULT), bad = g.getParameter(ext.GPU_DISJOINT_EXT); g.deleteQuery(q); return bad ? NaN : ns / 1e6; };
        if (v.cancelDraw) v.cancelDraw(); else if (v.frameId !== null) { cancelAnimationFrame(v.frameId); v.frameId = null; }
        v.draw = function () {};   // held: no frame of the page's own while the passes are timed
        const quietTimer = () => { if (v.bounceTimer !== null) { clearTimeout(v.bounceTimer); v.bounceTimer = null; } };
        // At rest, exact: the viewer's 'exact' mode, the layers of the camera on screen, the composite done.
        const rest = () => { v.bounceMode = 'exact'; s.movedAt = -1e9; v.paint(); quietTimer(); };
        rest(); const EXACT = u.uLegBudget.value;
        const paths = {
          composite: {prep: rest, run: () => { s.composite(); }},
          peel: {prep: () => { rest(); s.key = null; }, run: () => { v.paint(); r.render(v.scene, v.camera); }},
          moving: {prep: () => { rest(); v.bounceMode = 'always'; s.key = null; s.movedAt = performance.now(); }, run: () => { v.paint(); r.render(v.scene, v.camera); }},
          frame: {prep: rest, run: () => { v.paint(); r.render(v.scene, v.camera); }}};
        const wall = {}, gpuMs = {}, budget = {}; Object.keys(paths).forEach((k) => { wall[k] = []; gpuMs[k] = []; });
        try {
          for (let i = 0; i < 15; i++) for (const k of Object.keys(paths)) {
            const p = paths[k];
            p.prep(); fence(); const t = performance.now(); p.run(); fence(); wall[k].push(performance.now() - t); budget[k] = u.uLegBudget.value; quietTimer();
            p.prep(); gpuMs[k].push(await query(p.run)); quietTimer();
          }
        } finally { delete v.draw; v.bounceMode = mode; s.movedAt = -1e9; quietTimer(); v.draw(); }
        const med = (a) => { a = a.filter((x) => x === x).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(2) : '-'; };
        Object.keys(paths).forEach((k) => { out[k] = med(wall[k]) + ' ms (GPU ' + med(gpuMs[k]) + ')'; });
        out.budget = budget; out.exact = EXACT; out.size = s.width + 'x' + s.height; return out; })()`);
      // The stand itself: the exact paths ran on the unbounded leg, the moving one on the budget.
      const exactLeg = gpu.exact > 1e9 && ['composite', 'peel', 'frame'].every((k) => gpu.budget[k] === gpu.exact) && gpu.budget.moving > 0 && gpu.budget.moving < 1e6;
      console.log('GPU stand: the leg exact on composite / peel / still frame, on its budget (' + gpu.budget.moving + ') on the moving camera: ' + (exactLeg ? 'yes' : 'NO ' + JSON.stringify(gpu.budget)));
      console.log('GPU passes (median of 15, readPixels fence; timer query in brackets): composite ' + gpu.composite + ', peel + composite + scene ' + gpu.peel + ', the same on a moving camera ' + gpu.moving + ', a still frame ' + gpu.frame + ', layers ' + gpu.size);
    }
    ok('the live ring stands on the model under the cursor', ringUp.ring, JSON.stringify(ringUp));

    if (MEASURE) {
      // The parts of a frame: the viewer's calls the loop makes, and the figure's slices, timed inside the callbacks.
      await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], rec = window.__frames;
        const add = (name, d) => { if (!rec.on || rec.cur === null || rec.cur === undefined) return; const f = rec.frames.get(rec.cur) || {}; f[name] = (f[name] || 0) + d; rec.frames.set(rec.cur, f); };
        const wrap = (o, m, name) => { const f = o[m]; if (typeof f !== 'function') return; o[m] = function () { const s = performance.now(); try { return f.apply(this, arguments); } finally { add(name, performance.now() - s); } }; };
        ['setLiveAim', 'chaseAim', 'turnAim', 'aimGap', 'aimBeyond', 'setAimReload', 'setAimOffset'].forEach((m) => wrap(v, m, '.v.' + m));
        const make = v.liveAimSampler; if (make) v.liveAimSampler = function () { const s = make.apply(this, arguments); if (s) wrap(s, 'step', '.figure slice'); return s; };
        // One-piece integrals on this model at this ray cost, for the record.
        const t = (n) => { const s = performance.now(); v.liveAimProbability(v.shell, n); return +(performance.now() - s).toFixed(1); };
        window.__oneShot = {r256: t(256), r1024: t(1024), triangles: v.engine && v.engine.triangles ? v.engine.triangles.length : null,
          model: (document.getElementById('model-tile-body') || {}).textContent || ''}; })()`);
      const one = await ev('window.__oneShot');
      console.log('one-piece integral on this model (' + one.model.trim().slice(0, 40) + ', ' + one.triangles + ' triangles): 256 rays ' + one.r256 + ' ms, 1024 rays ' + one.r1024 + ' ms');
    }
    // The three phases: the cursor circling, W held with the cursor moving, coming to rest (the fine figure). Run twice (28.09,
    // steady-60): with the page's worker taking the figures (the default where a Worker starts) and on the main thread's
    // slices (ArmorBallistics.useWorker(false): the fallback when none does). The ray spin applies to the main thread only.
    async function phases(tag) {
      await ev('window.__record(true)'); await circle(3000); await ev('window.__record(false)');
      const cursor = summary('cursor moving' + tag, await ev('window.__read()'));
      const moving = await ev('window.__figure()');
      await ev('window.__record(true)'); await key('keyDown', 'KeyW', 'w', 87); await circle(2500); await key('keyUp', 'KeyW', 'w', 87); await ev('window.__record(false)');
      const drive = summary('W held, cursor moving' + tag, await ev('window.__read()'));
      await ev('window.__record(true)'); await new Promise((r) => setTimeout(r, 6000)); await ev('window.__record(false)');
      const rest = summary('coming to rest (the fine figure)' + tag, await ev('window.__read()'));
      const shown = await ev('window.__figure()'), exact = await ev('window.__exact()');
      if (MEASURE) console.log('figure at rest' + tag + ': shown ' + JSON.stringify(shown.text) + ', synchronous 1024 rays ' + JSON.stringify(exact) + '; throttle ' + THROTTLE + 'x, ray spin ' + RAY_US + ' us, ' + browser.product);
      if (!DATA && RAY_US >= 40 && THROTTLE <= 1) {   // the budget is for the plain run; throttled runs are for reading
        // At most two frames over the budget (a garbage collection landing in one, a machine busy with the other suites) and
        // none near the old spikes: the one-piece integral put ~20 ms into a frame every 120 ms and ~80 ms into one at rest.
        [cursor, drive, rest].forEach((s) => ok('frame budget, ' + s.label + ': the ring’s JS (aimTick + figure slices) at most ' + BUDGET_MS + ' ms a frame (two exceptions, none over ' + SPIKE_MS + ' ms)',
          s.frames > 20 && s.overBudget <= 2 && s.ringMax < SPIKE_MS, '(' + s.frames + ' frames, ' + s.overBudget + ' over, max ' + fix(s.ringMax) + ' ms, p95 ' + fix(s.ringP95) + ' ms)'));
      }
      ok('the figure is on the ring while it moves' + tag, moving.shown && /%$/.test(moving.text || ''), JSON.stringify(moving));
      ok('at rest the figure is the exact 1024-ray integral over the ring on screen' + tag, shown.shown && shown.text === exact, JSON.stringify(shown) + ' vs ' + exact);
      return {cursor: cursor, drive: drive, rest: rest};
    }
    const worker = await ev('ArmorBallistics.useWorker()');
    ok('the page’s ray worker runs (a blob worker importing web/ballistics.js)', worker.on && worker.running && worker.ready, JSON.stringify(worker));
    const inWorker = await phases(' [worker]');
    // The worker's figure is the main thread's to the bit: one ring integrated both ways, every field of the result.
    // Answered BY THE WORKER (review 28.09: the old check's `!!there.remote || !!r` was true whatever answered): the job handed
    // out must come back with its result and without a failure, and that result is the figure the sampler lands on.
    const same = await ev(`(async () => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], here = v.liveAimSampler(v.shell, 1024, true), there = v.liveAimSampler(v.shell, 1024), job = there.remote;
      let r = null; for (let i = 0; i < 400 && !(r = there.step(performance.now())); i++) await new Promise((z) => setTimeout(z, 5));
      return {posted: !!job, answered: !!(job && job.result && !job.failed), same: !!(job && r === job.result), here: JSON.stringify(here.step(Infinity)), there: JSON.stringify(r)}; })()`);
    ok('the worker answers the 1024-ray figure itself', same.posted && same.answered && same.same, JSON.stringify(same).slice(0, 300));
    ok('the worker’s 1024-ray figure equals the main thread’s, every field', same.here === same.there && same.here !== 'null', JSON.stringify(same));
    // The host's steady-state line (host.js, 28.09): at least one line covering the emulation came out of the 5.5 s of
    // activity above, and the 6 s at rest added at most the one flush of what was left - an idle page logs nothing more.
    const hostLines = () => ev('(window.BullbaHost && window.BullbaHost.frameLines || []).slice()');
    const linesMoving = await hostLines();
    ok('frame telemetry: a line with the emulation’s frame rate after ~5 s of emulation', linesMoving.some((l) => l.labels.emulation && l.labels.emulation.frames > 10), JSON.stringify(linesMoving).slice(0, 300));
    await new Promise((r) => setTimeout(r, 2500));
    ok('frame telemetry: nothing more is logged while the page is idle', (await hostLines()).length === linesMoving.length, JSON.stringify(await hostLines()).slice(0, 300));
    // A camera drag's label: the orbit noted every frame for 1.3 s, then idle - flushed as one line under 'orbit'.
    await ev(`new Promise((done) => { const t0 = performance.now(); (function f() { BullbaHost.activity('orbit'); if (performance.now() - t0 < 1300) requestAnimationFrame(f); else done(); })(); })`);
    await new Promise((r) => setTimeout(r, 1600));
    const linesOrbit = await hostLines(), lastLine = linesOrbit[linesOrbit.length - 1];
    ok('frame telemetry: an orbit flushed as one line when the page goes idle', linesOrbit.length === linesMoving.length + 1 && !!(lastLine && lastLine.labels.orbit), JSON.stringify(lastLine));
    const logged = page.console.filter((l) => /Bullba Hits frames \(/.test(l));
    ok('frame telemetry: every line reached the console (game.log in the game)', logged.length === linesOrbit.length, logged.length + ' vs ' + linesOrbit.length);
    if (MEASURE) logged.forEach((l) => console.log('host line: ' + l.replace(/^info: /, '')));
    // A shot's own figure is a job of its own, in slices: it must land on the shot's tile as the one-piece integral over the
    // ring the shot left gives it. The harness keeps an untouched copy of the shot's sampler and integrates it in one piece.
    const shotTile = () => ev(`(() => { const t = document.getElementById('shot-circle-tile'); return t && !t.hidden ? document.getElementById('shot-circle').textContent : null; })()`);
    const click = async () => { for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', {type: type, x: box.x, y: box.y, button: 'left', clickCount: 1}); };
    const shotExact = `(() => { const c = window.__shotCopy; if (!c) return null; const r = c.step(Infinity), s = c.shell;
      return s.alpha > 0 ? Math.round(Math.max(0, Math.min(100, 100 * r.damage / s.alpha))) + ' %' : (r.unknown ? Math.round(r.low) + '–' + Math.round(r.high) : Math.round(r.low)) + ' %'; })()`;
    await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], make = v.liveAimSampler;
      v.liveAimSampler = function (shell, count) { const s = make.apply(this, arguments); if (s && count === 1024) window.__shotCopy = Object.assign(Object.create(Object.getPrototypeOf(s)), s); return s; }; })()`);
    for (const [label, before] of [['at rest', 4000], ['on the move', 0]]) {
      if (before) { await move(box.x, box.y); await new Promise((r) => setTimeout(r, before)); } else await circle(400);
      await ev('window.__shotCopy = null');
      const drawn = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; return v.shotsDrawn || 0; })()`);
      await click();
      let shot = null; for (let i = 0; i < 40 && !shot; i++) { await new Promise((r) => setTimeout(r, 100)); shot = await shotTile(); }
      const exact = await ev(shotExact);
      ok('a shot ' + label + ': its figure lands on its tile, the one-piece integral over the ring it left', !!exact && shot === exact, '(' + shot + ' vs ' + exact + ')');
      await new Promise((r) => setTimeout(r, 1000));   // off the ⌖ mode a press fires whatever the reload
    }
    // The fallback: the same phases on the main thread's slices, the budget and the exact figure as before the worker.
    await ev('ArmorBallistics.useWorker(false)');
    await move(box.x, box.y); await new Promise((r) => setTimeout(r, 500));
    const onMain = await phases(' [main thread]');
    if (MEASURE) ['cursor', 'drive', 'rest'].forEach((k) => console.log('ring JS p95/max, worker vs main thread, ' + k + ': ' + fix(inWorker[k].ringP95) + '/' + fix(inWorker[k].ringMax) + ' vs ' + fix(onMain[k].ringP95) + '/' + fix(onMain[k].ringMax) + ' ms'));
    // ---- frame-sync (28.09): how evenly the picture moves under pointer input at a cadence of its own -------------------
    // Moves are sent every CADENCE ms without waiting for the page (the game forwards its cursor at its own frame rate), the
    // hand's position taken at the wall time of the send. Per frame the drawn picture: its step per 16.7 ms of frame time.
    await ev('window.__watch()');
    const CADENCE = 7, send = (type, x, y, held) => page.send('Input.dispatchMouseEvent', {type: type, x: x, y: y, button: held || type !== 'mouseMoved' ? 'left' : 'none', buttons: held ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1}).catch(() => {});
    async function sweep(ms, pos, held) { const t0 = Date.now(); let next = t0; while (Date.now() - t0 < ms) { const p = pos((Date.now() - t0) / 1000); send('mouseMoved', p[0], p[1], held); next += CADENCE; const w = next - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); } }
    async function drawn(fn) {
      await ev('(window.__shown.length = 0, window.__record(true), true)'); await fn(); await ev('window.__record(false)');
      const out = await ev(`(() => { const f = window.__frames, ts = Array.from(f.frames.keys()).sort((a, b) => a - b); return {frames: ts, shown: window.__shown.slice(), names: Array.from(f.names || [])}; })()`);
      return out;
    }
    function evenness(rec, pick) {
      // The state on screen at each frame = the last render at or before it; steps per 16.7 ms of frame time, the steady middle.
      let j = 0, last = null; const at = [];
      rec.frames.forEach((t) => { while (j < rec.shown.length && rec.shown[j][0] !== null && rec.shown[j][0] <= t) last = rec.shown[j++]; at.push([t, last]); });
      const steps = []; for (let i = 1; i < at.length; i++) if (at[i][1] && at[i - 1][1]) steps.push(pick(at[i][1], at[i - 1][1]) / (at[i][0] - at[i - 1][0]) * 16.667);
      const cut = Math.floor(steps.length * .15), mid = steps.slice(cut, steps.length - cut), m = mid.reduce((s, x) => s + x, 0) / Math.max(1, mid.length);
      const sd = Math.sqrt(mid.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, mid.length));
      return {n: mid.length, mean: m, cv: m ? sd / Math.abs(m) : 1, repeats: mid.filter((x) => Math.abs(x) < 1e-12).length};
    }
    // A left drag from an empty spot at the right of the scene, 400 px/s to the left: the camera orbits.
    const vp = await ev(`(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return {l: b.left, t: b.top, w: b.width, h: b.height}; })()`);
    const dx0 = vp.l + vp.w * 0.88, dy0 = vp.t + vp.h * 0.55;
    await send('mouseMoved', dx0, dy0); await new Promise((r) => setTimeout(r, 400));
    await send('mousePressed', dx0, dy0); await new Promise((r) => setTimeout(r, 60));
    const orbitRec = await drawn(() => sweep(2500, (s) => [dx0 - 400 * s, dy0], true));
    await send('mouseReleased', dx0 - 1000, dy0);
    const orbitEven = evenness(orbitRec, (a, b) => (a[1] - b[1]) * 1000);
    ok('one frame loop: every animation-frame callback the page asked for during the drag is web/frame.js\'s', orbitRec.names.length > 0 && orbitRec.names.every((n) => n === '.loop'), JSON.stringify(orbitRec.names));
    ok('the camera turns by even steps under uneven pointer input: CV of the step per frame time at most ' + EVEN_CV + ', no repeated picture',
       orbitEven.n > 60 && orbitEven.cv <= EVEN_CV && orbitEven.repeats === 0, JSON.stringify(orbitEven));
    // The host flushes the orbit's line at its 5-second window or when the page goes idle - the ring settling after the drag
    // keeps the emulation's clock running for a few seconds more.
    let orbitLine = null;
    for (let i = 0; i < 100 && !orbitLine; i++) { await new Promise((r) => setTimeout(r, 100)); orbitLine = (await hostLines()).slice(linesOrbit.length).filter((l) => l.labels.orbit).pop(); }
    ok('frame telemetry: the orbit\'s line carries the pointer input and how evenly the camera moved', !!(orbitLine && orbitLine.labels.orbit.input && orbitLine.labels.orbit.camera && orbitLine.labels.orbit.camera.repeats === 0)
       && page.console.some((l) => /Bullba Hits frames \(.*orbit .*; input .* per frame.*; camera step off/.test(l)), JSON.stringify(orbitLine));
    // The cursor circles the model: the ring follows it (the turret's chase) - how evenly it moves on screen.
    const box2 = await ev(`(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, r: Math.min(b.width, b.height) * 0.08}; })()`);
    await send('mouseMoved', box2.x + box2.r, box2.y); await new Promise((r) => setTimeout(r, 1500));
    const ringRec = await drawn(() => sweep(2500, (s) => { const a = s / 1.4 * Math.PI; return [box2.x + box2.r * Math.cos(a), box2.y + box2.r * Math.sin(a)]; }, false));
    const ringEven = evenness(ringRec, (a, b) => Math.hypot(a[2] - b[2], a[3] - b[3], a[4] - b[4]) * 1000);
    ok('the ring moves by even steps while the cursor circles: CV at most ' + EVEN_CV_RING + ', at most two repeated pictures',
       ringEven.n > 60 && ringEven.cv <= EVEN_CV_RING && ringEven.repeats <= 2, JSON.stringify(ringEven));
    if (MEASURE) console.log('evenness: orbit ' + JSON.stringify(orbitEven) + ', ring ' + JSON.stringify(ringEven));
    // ---- the Statistics log's pass while the scene is orbited (04.10) -------------------------------------------------------
    // The user: the pass "stands still while the mouse is over the scene". It waited for a pause in the user's work (a drag,
    // the aim loop, the cursor) and now waits for nothing: a battle of PASS_HITS hits is opened and the scene dragged at once.
    // Asked: the pass goes on under the drag; the frames of that drag are no worse than the frames of the same drag with
    // nothing queued; the pass tells the frame loop its own time (BullbaFrame.note 'verdicts') and no step of it is long.
    if (!DATA) {
      await ev('ArmorBallistics.useWorker(true)');
      await ev(`(() => { const F = window.BullbaFrame, note = F.note; window.__vnotes = []; F.note = function (name, since) { const d = note.call(F, name, since); if (name === 'verdicts') window.__vnotes.push(d); return d; }; return true; })()`);
      const written = () => page.console.filter((l) => l.indexOf('Bullba Hits verdict: battle=pmx ') >= 0 && l.indexOf(' mode=auto') > 0).length;
      const drag = async () => {
        await send('mouseMoved', dx0, dy0); await new Promise((r) => setTimeout(r, 150));
        await send('mousePressed', dx0, dy0); await new Promise((r) => setTimeout(r, 60));
        const rec = await drawn(() => sweep(2500, (s) => [dx0 - 400 * s, dy0], true));
        await send('mouseReleased', dx0 - 1000, dy0);
        const gaps = []; for (let i = 1; i < rec.frames.length; i++) gaps.push(rec.frames[i] - rec.frames[i - 1]);
        return {frames: gaps.length, slow: gaps.filter((g) => g > 25).length, p50: pct(gaps, 50), p95: pct(gaps, 95), max: Math.max(0, ...gaps)};
      };
      await ev(`(() => { if (document.getElementById('battle-list').hidden) document.getElementById('battle-pick').click(); document.querySelector('#battle-list [data-id="pmx"]').click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 1200));   // the battle's own scene is on screen: its load is not the drag's
      const w0 = written(), under = await drag(), w1 = written();
      for (let i = 0; i < 300 && written() < PASS_HITS; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      const alone = await drag(), notes = await ev('window.__vnotes'), worst = Math.max(0, ...notes);
      if (MEASURE) console.log('pass under an orbit: ' + (w1 - w0) + ' hits in the drag; frames with the pass ' + JSON.stringify(under) + ', without ' + JSON.stringify(alone) + '; ' + notes.length + ' steps noted, the longest ' + fix(worst) + ' ms');
      ok('Statistics log: the pass goes on while the scene is dragged (at least ' + PASS_DRAG_HITS + ' hits in 2.5 s; before 04.10 none)', w1 - w0 >= PASS_DRAG_HITS && written() === PASS_HITS, '(' + (w1 - w0) + ' hits in the drag, ' + written() + ' of ' + PASS_HITS + ' in all)');
      // A machine busy with the other suites gives either drag a slow frame or two: the allowance is three and 3 % of the frames.
      ok('Statistics log: the frames of a drag are no worse with the pass running than without it (frames over 25 ms, the median interval)',
         under.frames > 60 && under.slow <= alone.slow + Math.max(3, Math.round(under.frames * 0.03)) && under.p50 <= alone.p50 * 1.25 + 1, JSON.stringify({pass: under, alone: alone}));
      ok('Statistics log: the pass tells the frame loop its own time, and no step holds the main thread ' + PASS_STEP_MS + ' ms',
         notes.length >= PASS_HITS && worst < PASS_STEP_MS, '(' + notes.length + ' notes, the longest ' + fix(worst) + ' ms)');
    }
    ok('no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    // The junction goes first and alone: a recursive delete must never reach through it into the real data.
    const link = path.join(folder, 'data');
    if (DATA) { try { fs.rmdirSync(link); } catch (e) { try { fs.unlinkSync(link); } catch (e2) { /* left */ } } }
    if (!fs.existsSync(link) || !DATA) { try { fs.rmSync(folder, {recursive: true, force: true}); } catch (e) { /* a temp folder */ } }
  }
  console.log('frame cost (' + browserName + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.log('FAIL frame_cost: ' + (e && e.stack || e)); process.exit(1); });
