// NOTEBOOK Z18 (23.11.2026): the shot episode's dashed tracer was drawn whole at once while the replay's tracers grow
// with the shell's flight. Both now draw by one procedure, web/playback/battle.js growTracer: from the muzzle to the
// shell's place at the clock's moment. Here: its length at moments of a flight (none before the shot, the share of the
// flight on the way, all of it from the arrival on), the same result on a rewind, and on a recorded arc (trajectory).
'use strict';
const path = require('path'), assert = require('assert');
const PB = require(path.join(__dirname, '..', 'web', 'playback', 'battle.js'));
let passed = 0;
function ok(what, fn) { fn(); passed++; console.log('ok - ' + what); }

const len = (out, n) => { let s = 0; for (let i = 1; i < n; i++) s += Math.hypot(out[i * 3] - out[i * 3 - 3], out[i * 3 + 1] - out[i * 3 - 2], out[i * 3 + 2] - out[i * 3 - 1]); return s; };
const near = (a, b, e, what) => assert.ok(Math.abs(a - b) <= e, what + ': ' + a + ' vs ' + b);

// a straight 100 m flight of 0.2 s along x
const line = (f) => [100 * f, 0, 0], FLIGHT = 0.2, SEGS = 12;

ok('nothing before the shot', () => {
  const out = new Float32Array((SEGS + 1) * 3);
  assert.strictEqual(PB.growTracer(line, FLIGHT, -0.01, SEGS, out).n, 0);
  assert.strictEqual(PB.tracerReach(FLIGHT, -1), 0);
});

ok('length grows with the shell: tau / flight of the line', () => {
  [0, 0.05, 0.1, 0.15, 0.2, 0.5].forEach((tau) => {
    const out = new Float32Array((SEGS + 1) * 3), g = PB.growTracer(line, FLIGHT, tau, SEGS, out);
    assert.strictEqual(g.n, SEGS + 1);
    near(len(out, g.n), 100 * Math.min(1, tau / FLIGHT), 1e-3, 'length at ' + tau);
    near(out[0], 0, 1e-9, 'starts at the muzzle');
    near(out[SEGS * 3], 100 * Math.min(1, tau / FLIGHT), 1e-3, 'ends at the shell at ' + tau);
  });
});

ok('rewind: the same moment gives the same line, whatever came before', () => {
  const fwd = new Float32Array((SEGS + 1) * 3), back = new Float32Array((SEGS + 1) * 3);
  PB.growTracer(line, FLIGHT, 0.07, SEGS, fwd);
  PB.growTracer(line, FLIGHT, 0.2, SEGS, back); PB.growTracer(line, FLIGHT, 0.07, SEGS, back);
  assert.deepStrictEqual(Array.from(back), Array.from(fwd));
  near(len(back, SEGS + 1), 35, 1e-3, 'shrunk back to 35 m');
});

ok('no flight time: whole from the shot on', () => {
  assert.strictEqual(PB.tracerReach(0, 0), 1);
});

ok('recorded arc: grows along the arc to its end on its duration', () => {
  // shot fields: t, shooter, ricochet, start xyz, velocity xyz, gravity, end t, end xyz
  const v = 300, shot = [10, 1, 0, 0, 0, 0, v, 30, 0, 9.81, 0, 0, 0, 0];
  const T = 2; shot[10] = 10 + T; shot[11] = v * T; shot[12] = 30 * T - 0.5 * 9.81 * T * T; shot[13] = 0;
  const p = PB.trajectory(shot, null, null, {});
  assert.ok(p, 'an arc');
  const out = new Float32Array(97 * 3);
  const half = PB.growTracer(p.point, p.duration, p.duration / 2, 96, out);
  near(out[96 * 3], v * T / 2, 1e-6, 'half-way in time is half-way in x');
  const all = PB.growTracer(p.point, p.duration, p.duration * 3, 96, out);
  assert.strictEqual(all.reach, 1);
  near(len(out, all.n), p.length, p.length * 1e-3, 'whole arc from the arrival on');
  assert.ok(half.reach === 0.5);
});

ok('the eased camera never passes the shell (23.11, the user), lagging allowed', () => {
  // the shot view's eye on the default eased pace (shot-view.js easedFrame: smoothstep over max(0.6 s, flight) of the arc
  // up to its framing stop endU), capped by the shell's arc fraction at that moment
  const vm = require('vm'), fs = require('fs'), sb = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'playback', 'shot-view.js'), 'utf8'), sb);
  const A = sb.window.BullbaShotView.arty;
  const v = 800, shot = [0, 1, 0, 0, 0, 0, v, 2, 0, 9.81, 1, v, 2 - 4.905, 0];   // a 1 s direct-fire flight
  const p = PB.trajectory(shot, null, null, {}), pt = (u) => p.point(u), dur = Math.max(0.6, p.duration), endU = 0.95;
  let ahead = 0, lag = 0, aheadUncapped = 0;
  for (let e = 0; e <= dur + 0.3; e += 1 / 60) {
    const f = Math.min(1, e / dur), sm = f * f * (3 - 2 * f), sf = PB.tracerReach(p.duration, e), shell = A.arcD(p, sf);
    const eye = A.arcD(p, A.easedFrame(p, pt, sm, endU, sf).uc), free = A.arcD(p, A.easedFrame(p, pt, sm, endU).uc);
    ahead = Math.max(ahead, eye - shell); lag = Math.max(lag, shell - eye); aheadUncapped = Math.max(aheadUncapped, free - shell);
  }
  assert.ok(aheadUncapped > 10, 'the uncapped glide does pass the shell here: ' + aheadUncapped);
  assert.ok(ahead < 0.05, 'the eye ahead of the shell by ' + ahead + ' m');
  assert.ok(lag > 10, 'the eye still lags early: ' + lag);
});

console.log('# passed ' + passed);
