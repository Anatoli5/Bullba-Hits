/* THE FRAME COST OF THE EMULATION (27.09, frame-smoothness): the real page in a local headless browser (cdp.cjs, software
 * WebGL), the synthetic data of fixture.cjs, the live aiming ring driven by real input - the cursor circling over the model,
 * then W held and the cursor still moving, then everything at rest - and every animation-frame callback timed from an init
 * script (the page is not changed for the test).
 *
 * The fixture's models are boxes, where a ray costs microseconds. A real model costs 15-80 us a ray (KNOWLEDGE §14: 256 rays
 * 3.9 / 9.1 / 19.7 ms on the median / upper quartile / heavy models, 1024 rays 15.3 / 32.9 / 78.1 ms), so the harness makes
 * every ray of the viewer's engine spin for RAY_US microseconds (default 80: the heavy model). The integral of the ring is then
 * as dear as on a heavy model, and a frame that runs it in one piece shows.
 *
 * Asked of the page:
 *   - the JS of the ring's own frame callbacks (aimTick and the figure's slices, aimEstTick) stays under BUDGET_MS a frame
 *     (two exceptions, none near the old spikes) while moving and coming to rest - the integral is sliced over frames;
 *   - the figure reaches the ring: taken while moving, and at rest the fine figure equals the one a synchronous 1024-ray
 *     integral over the same ring gives (liveAimProbability), text for text;
 *   - a shot's own figure, fired at rest and on the move, lands on its tile as the one-piece integral over its ring;
 *   - no uncaught exception.
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
  else fixture.write(folder);
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
  const label = (fn) => { if (fn.name) return fn.name; const s = String(fn); return /countFrame/.test(s) ? 'render' : /hoverEvent/.test(s) ? 'hover' : /pendingPan|orbitId/.test(s) ? 'orbit' : 'other'; };
  window.requestAnimationFrame = function (fn) {
    const name = label(fn);
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
    const ray = e.ray; e.__slow = true;
    e.ray = function () { window.__rays++; const t = performance.now() + spin / 1000; while (performance.now() < t) {} return ray.apply(this, arguments); };
  };
  setInterval(window.__slow, 20);
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
    if (!DATA) await ev(`(() => { if (document.getElementById('battle-list').hidden) document.getElementById('battle-pick').click(); document.querySelector('#battle-list [data-id="pm3"]').click(); })()`);
    await new Promise((r) => setTimeout(r, 800));
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
      // The GPU time of the heavy passes, finished (gl.finish): the composite alone, and a full peel + composite (the camera moved).
      const gpu = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], g = v.renderer.getContext(), s = v.surface, out = {};
        const time = (fn) => { const a = []; for (let i = 0; i < 12; i++) { g.finish(); const t = performance.now(); fn(); g.finish(); a.push(performance.now() - t); } a.sort((x, y) => x - y); return +a[6].toFixed(2); };
        out.composite = time(() => s.composite());
        out.peel = time(() => { s.key = null; v.paint(); v.renderer.render(v.scene, v.camera); });
        out.frame = time(() => { v.paint(); v.renderer.render(v.scene, v.camera); });
        out.size = s.width + 'x' + s.height; return out; })()`);
      console.log('GPU passes (median of 12, finished): composite ' + gpu.composite + ' ms, peel + composite ' + gpu.peel + ' ms, a still frame ' + gpu.frame + ' ms, layers ' + gpu.size);
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
    await ev('window.__record(true)'); await circle(3000); await ev('window.__record(false)');
    const cursor = summary('cursor moving', await ev('window.__read()'));
    const moving = await ev('window.__figure()');
    await ev('window.__record(true)'); await key('keyDown', 'KeyW', 'w', 87); await circle(2500); await key('keyUp', 'KeyW', 'w', 87); await ev('window.__record(false)');
    const drive = summary('W held, cursor moving', await ev('window.__read()'));
    await ev('window.__record(true)'); await new Promise((r) => setTimeout(r, 6000)); await ev('window.__record(false)');
    const rest = summary('coming to rest (the fine figure)', await ev('window.__read()'));
    const shown = await ev('window.__figure()'), exact = await ev('window.__exact()');
    if (MEASURE) console.log('figure at rest: shown ' + JSON.stringify(shown.text) + ', synchronous 1024 rays ' + JSON.stringify(exact) + '; throttle ' + THROTTLE + 'x, ray spin ' + RAY_US + ' us, ' + browser.product);
    if (!DATA && RAY_US >= 40 && THROTTLE <= 1) {   // the budget is for the plain run; throttled runs are for reading
      // At most two frames over the budget (a garbage collection landing in one, a machine busy with the other suites) and
      // none near the old spikes: the one-piece integral put ~20 ms into a frame every 120 ms and ~80 ms into one at rest.
      [cursor, drive, rest].forEach((s) => ok('frame budget, ' + s.label + ': the ring’s JS (aimTick + figure slices) at most ' + BUDGET_MS + ' ms a frame (two exceptions, none over ' + SPIKE_MS + ' ms)',
        s.frames > 20 && s.overBudget <= 2 && s.ringMax < SPIKE_MS, '(' + s.frames + ' frames, ' + s.overBudget + ' over, max ' + fix(s.ringMax) + ' ms, p95 ' + fix(s.ringP95) + ' ms)'));
    }
    ok('the figure is on the ring while it moves', moving.shown && /%$/.test(moving.text || ''), JSON.stringify(moving));
    ok('at rest the figure is the exact 1024-ray integral over the ring on screen', shown.shown && shown.text === exact, JSON.stringify(shown) + ' vs ' + exact);
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
