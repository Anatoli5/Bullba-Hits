/* The page's side of the ray worker's life (28.09, steady-60-fix; web/ballistics.js remote*): web/ballistics.js runs in a
 * context of its own with a fake Worker, a fake clock and fake timers, so every term is exercised in milliseconds:
 *   - a worker silent after `ready`, or never ready, is ended by its watchdog: its jobs fail (their callers compute on the
 *     main thread, the same figure), nothing more is posted to it, a new one is tried 30 s later, none after 3 failures;
 *   - a late watchdog tick (a suspended page) starts the silence afresh instead of failing a worker that was frozen with it;
 *   - useWorker(false) / useWorker(true): the blob URL revoked, what the page believed the worker held forgotten (engines and
 *     models sent to the new one afresh);
 *   - lanes: a newer circle job of a lane cancels the one before (a cancel posted, the old job failed as cancelled);
 *   - memory: at most 2 engines and 16 models in the worker (never one of the scene being sent), release() frees them.
 * The worker's own side (the tree, the queue, the answers): tests/test_ray_worker.cjs; the real blob worker: frame_cost.cjs. */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');

let clock = 1000, timerId = 0, created = 0, revoked = 0;
const timers = [], workers = [];
class FakeWorker {
  constructor(url) { this.url = url; this.msgs = []; this.terminated = false; workers.push(this); }
  postMessage(m) { if (this.terminated) throw new Error('posted to a terminated worker'); this.msgs.push(m); }
  terminate() { this.terminated = true; }
  say(m) { if (this.onmessage) this.onmessage({data: m}); }
  types() { return this.msgs.map((m) => m.type); }
}
const ctx = {
  performance: {now: () => clock},
  setTimeout: (f, ms) => { const t = {f: f, at: clock + ms, id: ++timerId}; timers.push(t); return t.id; },
  clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); },
  Worker: FakeWorker,
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: {createObjectURL: () => 'blob:' + (++created), revokeObjectURL: () => { revoked++; }},
  document: {currentScript: {src: 'file:///C:/stage/web/ballistics.js'}},
  console: {info: () => {}, warn: () => {}, log: console.log}
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/ballistics.js', 'utf8'), ctx);
const B = ctx.ArmorBallistics;
// Runs every timer due within `ms`, in order, the clock following them.
function advance(ms) {
  const end = clock + ms;
  for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = Math.max(clock, t.at); t.f(); }
  clock = end;
}
const last = () => workers[workers.length - 1];
const json = (x) => JSON.stringify(x);
const quiet = (p) => { if (p) p.then(null, () => {}); return p; };   // a verdict promise nobody waits for here

// A small scene: a box of main armour and a screen, as the page's models.
const main = {armor: 80, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true};
const screen = Object.assign({}, main, {armor: 10, vehicleDamageFactor: 0});
function boxModel(material, lo, hi) {
  const g = {material: material, vertices: [], indices: []}, [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const quad = (a, b, c, d) => { const k = g.vertices.length; g.vertices.push(a, b, c, d); g.indices.push(k, k + 1, k + 2, k, k + 2, k + 3); };
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]);
  quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]); quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  return {kind: 'client-shot-collision', groups: [g]};
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function scene(n) {   // n parts, each its own model object
  const parts = [], models = {};
  for (let i = 1; i <= n; i++) { parts.push({id: i, transform: I, armor: {a: i === 1 ? main : screen}}); models[i] = boxModel('a', [-2 + i * .01, -1, -3], [2, 1, 3 - i * .01]); }
  return {hit: {target: {parts: parts}}, models: models};
}
const data = scene(2), shell = B.shell('ARMOR_PIERCING', 140, 100);
const engineA = B.build(data, false), engineB = B.build(scene(3), false), engineC = B.build(scene(4), false);
const sampler = (engine, count) => new B.CircleSampler(engine, shell, [0.3, 0.2, -30], [0.1, 0.05, 0], [1, 0, 0], [0, 1, 0], .9, count || 64, 'empirical-post96');
const exact = json(sampler(engineA).step(Infinity));

// 1. Silent after `ready`: the watchdog ends it at WORKER_SILENCE (5 s) of silence with a job out.
let s = sampler(engineA).post('live'), w = last();
assert.ok(s.remote && workers.length === 1, 'the job went to a worker');
assert.deepEqual(w.types(), ['engine', 'circle']);
assert.ok(w.msgs[0].engine.box instanceof vm.runInContext('Float64Array', ctx), 'the engine is sent with its kd-tree');
w.say({type: 'ready'});
assert.equal(revoked, 1, 'the blob URL is revoked once the worker has loaded');
advance(4900);
assert.equal(s.step(clock), null, 'within the term the figure waits for the worker');
advance(600);
assert.ok(w.terminated, 'silent 5 s with a job out: the worker is ended');
const r = s.step(clock + 1e9);
assert.equal(json(r), exact, 'the failed job is computed on the main thread, the same figure');
const posted = w.msgs.length, s2 = sampler(engineA).post('live');
assert.equal(s2.remote, null, 'after the failure nothing is sent: the job stays on the main thread');
assert.equal(w.msgs.length, posted);
assert.equal(workers.length, 1, 'no new worker before WORKER_RETRY');
assert.equal(B.useWorker().failures, 1);
console.log('ok   a worker silent after ready is ended by its watchdog; its job is computed here; nothing more is sent to it');

// 2. A new worker 30 s later: what the old one held is forgotten, the engine is sent again.
advance(30000);
s = sampler(engineA).post('live'); w = last();
assert.equal(workers.length, 2, 'a new worker after WORKER_RETRY');
assert.deepEqual(w.types(), ['engine', 'circle'], 'the new worker is sent the engine afresh');
// 3. Never ready: ended at WORKER_WAIT (3 s); after 3 failures no worker for the session.
advance(3600);
assert.ok(w.terminated && s.remote.failed, 'never ready within 3 s (the next watchdog tick): ended, its job failed');
assert.equal(B.useWorker().failures, 2);
advance(30000); sampler(engineA).post('live'); advance(3600);
assert.equal(workers.length, 3); assert.ok(last().terminated);
assert.equal(B.useWorker().failures, 3);
advance(600000); assert.equal(sampler(engineA).post('live').remote, null, 'after 3 failures: no worker for the session');
assert.equal(workers.length, 3);
console.log('ok   never ready: ended at 3 s; a new worker 30 s after a failure, sent everything afresh; none after 3 failures');

// 4. useWorker(true) forgets the failures; useWorker(false) ends the worker (its URL revoked, its jobs failed); on again,
// the engines and the models go to the new worker afresh.
B.useWorker(true);
s = sampler(engineA).post('live'); w = last();
assert.equal(workers.length, 4); w.say({type: 'ready'});
const verdictPts = [{pos: [0, 0, -3], line: [0, 0, 1], part: 1, effect: 3, pi: 0, hitType: 0, source: 'segment', chordDev: 0}];
let vp = B.remoteVerdicts(data, verdictPts, shell);
assert.ok(vp && typeof vp.then === 'function');
assert.deepEqual(w.types(), ['engine', 'circle', 'model', 'model', 'verdicts']);
const before = revoked;
B.useWorker(false);
assert.ok(w.terminated && s.remote.failed, 'off: the worker ended, its jobs failed');
let rejected = false; vp.then(null, () => { rejected = true; });
B.useWorker(true);
s = sampler(engineA).post('live'); w = last();
assert.equal(workers.length, 5);
assert.deepEqual(w.types(), ['engine', 'circle'], 'on again: the engine is sent to the new worker');
quiet(B.remoteVerdicts(data, verdictPts, shell));
assert.deepEqual(w.types().slice(2), ['model', 'model', 'verdicts'], 'and the models');
assert.ok(revoked === before || revoked === before + 1);
B.useWorker(false); B.useWorker(true);
assert.equal(revoked, created, 'every blob URL is revoked');
console.log('ok   useWorker(false/true): URLs revoked, jobs failed, engines and models sent afresh to the new worker');

// 5. A late watchdog tick (the page was suspended with its worker): the silence starts again instead of failing.
s = sampler(engineA).post('live'); w = last(); w.say({type: 'ready'});
clock += 60000;   // suspended: no timer ran
advance(0);
assert.ok(!w.terminated, 'a late tick does not end the worker');
advance(4000); assert.ok(!w.terminated);
w.say({id: s.remote.id, result: JSON.parse(exact)});
assert.equal(json(s.step(clock)), exact, 'the answer lands');
assert.equal(B.useWorker().jobs, 0);
advance(60000); assert.ok(!w.terminated, 'no job out: no term runs');
console.log('ok   a late watchdog tick restarts the silence; an idle worker has no term');

// 6. Lanes: a newer job of a lane cancels the one before; another lane is left alone. An error answer fails one job only.
const live1 = sampler(engineA).post('live'), shot = sampler(engineA).post('shot'), live2 = sampler(engineA).post('live');
assert.ok(live1.remote.failed && live1.remote.cancelled, 'the older live job is cancelled');
const cancel = w.msgs.filter((m) => m.type === 'cancel').pop();
assert.deepEqual(Array.from(cancel.ids), [live1.remote.id], 'and the worker told');
assert.ok(!shot.remote.failed && !live2.remote.failed);
assert.equal(B.useWorker().jobs, 2);
w.say({id: shot.remote.id, error: 'no engine 1'});
assert.ok(shot.remote.failed && !w.terminated, 'an error fails that job, not the worker');
assert.equal(json(shot.step(clock + 1e9)), exact, 'and it is computed here');
console.log('ok   a newer job of a lane cancels the older one (the worker told); an error answer fails only its job');

// 7. Memory: at most 2 engines; release('scene') drops them and keeps the jobs; release('circles') also cancels the lanes.
sampler(engineB).post('shot'); sampler(engineC).post('shot');
const drop = w.msgs.filter((m) => m.type === 'drop' && m.engines).pop();
assert.ok(drop && drop.engines.length === 1, 'a third engine drops the oldest');
assert.equal(B.useWorker().engines, 2);
B.release('scene');
assert.equal(B.useWorker().engines, 0); assert.ok(B.useWorker().jobs > 0, 'the jobs out are kept');
assert.deepEqual(w.msgs[w.msgs.length - 1].type, 'drop');
const liveJob = sampler(engineA).post('live');
B.release('circles');
assert.ok(liveJob.remote.cancelled && B.useWorker().jobs === 0 && B.useWorker().engines === 0, '⌖ off: lanes cancelled, engines dropped');
console.log('ok   at most 2 engines in the worker; release frees them (the scene: jobs kept; ⌖ off: jobs cancelled)');

// 8. Models: at most 16, never one of the scene being sent; release('models') frees them all.
for (let k = 0; k < 6; k++) quiet(B.remoteVerdicts(scene(5), verdictPts, shell));   // 30 fresh model objects
const big = scene(18);
quiet(B.remoteVerdicts(big, verdictPts, shell));
const st = B.useWorker();
assert.equal(st.models, 18, 'a scene of 18 models keeps all of its own');
const dropped = w.msgs.filter((m) => m.type === 'drop' && m.models).reduce((a, m) => a.concat(Array.from(m.models)), []);
const bigIds = w.msgs.filter((m) => m.type === 'verdicts').pop().scene.models;
assert.ok(Object.keys(bigIds).every((k) => dropped.indexOf(bigIds[k]) < 0), 'none of the current scene dropped');
quiet(B.remoteVerdicts(scene(2), verdictPts, shell));
assert.ok(B.useWorker().models <= 16, 'past the scene the limit holds again');
B.release('models');
assert.equal(B.useWorker().models, 0);
console.log('ok   at most 16 models in the worker (never the current scene\'s); release frees them');
setTimeout(() => { assert.ok(rejected, 'a verdict job of an ended worker rejects (the caller computes it here)'); console.log('PASS: worker life'); }, 0);
