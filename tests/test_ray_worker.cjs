/* The page's ray worker (28.09, steady-60): the engine and the models as flat arrays and back, and the worker's side
 * (ArmorBallistics.serve) over a scope whose messages go through structuredClone as a real postMessage would. Everything
 * the worker answers must equal the main thread's own result, every field: rays of a full and of a flat engine, a circle
 * integral in one piece and in slices, the Statistics log's verdicts. The real blob worker in Chrome: tests/page/frame_cost.cjs.
 * 28.09 (steady-60-fix): the engine carries its kd-tree - the worker puts back the very nodes the page built instead of
 * building them again; a model stays flat arrays in the worker; jobs queue and a cancelled one is never answered.
 * The page's side of the worker's life (terms, failures, lanes, memory): tests/test_worker_life.cjs. */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
vm.runInThisContext(fs.readFileSync('web/ballistics.js', 'utf8'));
const B = globalThis.ArmorBallistics;
const json = (x) => JSON.stringify(x);

// A deterministic soup: a hull box of main armour, a screen in front of it, spaced plates at angles (ricochets), a
// collide-once track and triangles with no armour table - every branch of the walk.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const main = {armor: 80, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true, collideOnceOnly: false};
const screen = {armor: 10, vehicleDamageFactor: 0, useHitAngle: true, mayRicochet: true, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true, collideOnceOnly: false};
const track = Object.assign({}, screen, {armor: 20, collideOnceOnly: true});
const models = {
  1: {kind: 'client-shot-collision', groups: [{material: 'armor_1', vertices: [], indices: []}, {material: 'armor_2', vertices: [], indices: []}]},
  2: {kind: 'client-shot-collision', groups: [{material: 'armor_3', vertices: [], indices: []}, {material: 'nothing', vertices: [], indices: []}]}
};
function quad(g, a, b, c, d) { const k = g.vertices.length; g.vertices.push(a, b, c, d); g.indices.push(k, k + 1, k + 2, k, k + 2, k + 3); }
function box(g, lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  quad(g, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); quad(g, [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]);
  quad(g, [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]); quad(g, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  quad(g, [x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]); quad(g, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
}
box(models[1].groups[0], [-2, -1, -3], [2, 1, 3]);
for (let i = 0; i < 40; i++) {   // spaced plates, tilted
  const x = rnd() * 6 - 3, y = rnd() * 2 - 1, z = rnd() * 8 - 4, s = .3 + rnd(), t = rnd() * 2 - 1;
  quad(models[1].groups[1], [x, y, z], [x + s, y + t, z], [x + s, y + t + s, z + t], [x, y + s, z + t]);
}
box(models[2].groups[0], [-3, -1.2, -3.5], [-2.4, 1.2, 3.5]);   // a track beside the hull
box(models[2].groups[1], [2.4, -1, -1], [2.6, 1, 1]);          // no armour table for this material
const parts = [
  {id: 1, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], armor: {armor_1: main, armor_2: screen}},
  {id: 2, transform: [0.8, 0, -0.6, 0, 0, 1, 0, 0, 0.6, 0, 0.8, 0, 0.1, 0.2, -0.3, 1], armor: {armor_3: track}}
];
const data = {hit: {target: {parts: parts}}, models: models};

// A worker scope in-process: every message through structuredClone (with the transfer list), the answers collected; the
// worker's queue runs on setImmediate (scope.later), so `answer(id)` waits for the job's own reply.
function scope() {
  const answers = [], s = {postMessage: (m) => answers.push(structuredClone(m)), answers: answers, later: (f) => setImmediate(f)};
  B.serve(s);
  s.send = (m, transfer) => s.onmessage({data: structuredClone(m, {transfer: transfer || []})});
  s.answer = async (id) => { for (let i = 0; i < 100000; i++) { const k = answers.findIndex((a) => a.id === id); if (k >= 0) return answers.splice(k, 1)[0]; await new Promise((r) => setImmediate(r)); } throw new Error('no answer to ' + id); };
  s.idle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  return s;
}
// The kd-tree as a plain structure (boxes, children, leaf indices), to compare the page's with the worker's node for node.
const shape = (n) => (n ? {min: n.min.slice(), max: n.max.slice(), idx: n.idx ? Array.from(n.idx) : null, left: n.idx ? null : shape(n.left), right: n.idx ? null : shape(n.right)} : null);
const shells = [B.shell('ARMOR_PIERCING', 140, 100), B.shell('ARMOR_PIERCING_CR', 90, 85), B.shell('HOLLOW_CHARGE', 200, 105), Object.assign(B.shell('HIGH_EXPLOSIVE', 50, 152), {alpha: 750, spallDamage: 375, mechanics: 'MODERN'})];
shells[0].alpha = 390;

let rays = 0;
for (const flat of [false, true]) {
  const engine = B.build(data, false, flat), pk = B.packEngine(engine), back = B.unpackEngine(structuredClone(pk));
  // The tree travels with the triangles and comes back node for node - the worker does not build one of its own.
  assert.ok(pk.box instanceof Float64Array && pk.pool instanceof Int32Array, 'the packed engine carries its tree');
  assert.equal(json(shape(back.acceleration)), json(shape(engine.acceleration)), 'the same tree' + (flat ? ' (flat)' : ''));
  assert.equal(back.triangles.length, engine.triangles.length);
  assert.equal(back.materialCount, engine.materialCount);
  assert.equal(back.flat, flat);
  for (let i = 0; i < 1500; i++) {
    const th = i * 2.399963, ph = Math.acos(1 - 2 * (i + .5) / 1500), d = [-Math.sin(ph) * Math.cos(th), -Math.cos(ph), -Math.sin(ph) * Math.sin(th)];
    const o = [-d[0] * 12 + (rnd() - .5) * 3, -d[1] * 12 + (rnd() - .5) * 2, -d[2] * 12 + (rnd() - .5) * 4], s = shells[i % shells.length];
    assert.equal(json(back.ray(o, d, s)), json(engine.ray(o, d, s)), 'ray ' + i + (flat ? ' (flat)' : ''));
    rays++;
  }
}
// The tree is not built again: the kd-tree build sorts at every node, the unpacking sorts nothing.
{
  const engine = B.build(data, false), pk = B.packEngine(engine), sort = Array.prototype.sort;
  let sorts = 0; Array.prototype.sort = function () { sorts++; return sort.apply(this, arguments); };
  try { B.unpackEngine(structuredClone(pk)); } finally { Array.prototype.sort = sort; }
  assert.equal(sorts, 0, 'unpacking an engine builds no tree');
}
console.log('ok   packed engines carry their kd-tree and cast the same ' + rays + ' rays, every field (kd-tree and flat)');

// The lean ray (engine.lean, the circle's): the chance, the expected damage and the reason of ray(), on every ray - the
// ricochet continuation included - and no array or object of its own per ray (the same result object every time).
{
  const engine = B.build(data, false);
  let n = 0, bounced = 0, first = null;
  for (let i = 0; i < 4000; i++) {
    const th = i * 2.399963, ph = Math.acos(1 - 2 * (i + .5) / 4000), d = [-Math.sin(ph) * Math.cos(th), -Math.cos(ph), -Math.sin(ph) * Math.sin(th)];
    const o = [-d[0] * 12 + (rnd() - .5) * 3, -d[1] * 12 + (rnd() - .5) * 2, -d[2] * 12 + (rnd() - .5) * 4], s = shells[i % shells.length];
    const full = engine.ray(o, d, s), lean = engine.lean(o, d, s);
    if (!first) first = lean; else assert.equal(lean, first, 'one lean result object');
    assert.equal(json([lean.chance, lean.expected, lean.reason]), json([full.chance, full.expected, full.reason]), 'lean ray ' + i);
    if (full.bounce) bounced++;
    n++;
  }
  assert.ok(bounced > 50, 'ricochet legs among the rays (' + bounced + ')');
  const none = engine.lean([0, 0, -20], [0, 0, 1], null);
  assert.equal(json([none.chance, none.reason, none.expected]), json([null, 'parameters', undefined]));
  console.log('ok   the lean ray gives ray()’s chance, expected damage and reason on ' + n + ' rays (' + bounced + ' after a ricochet)');
}

(async () => {
// The worker's side: the engine once, then circle jobs; the answers equal one-piece and sliced integrals here.
const w = scope(), engine = B.build(data, false), pk = B.packEngine(engine);
assert.deepEqual(w.answers.shift(), {type: 'ready'});
w.send({type: 'engine', id: 1, engine: pk}, [pk.v.buffer, pk.t.buffer]);
let circles = 0;
for (const [count, radius, profile] of [[256, .4, 'empirical-post96'], [1024, .9, 'empirical-post96'], [300, 1.5, 'gauss-r2']]) {
  for (const s of shells) {
    const o = [0.3, 0.2, -30], c = [0.1, 0.05, 0], right = [1, 0, 0], up = [0, 1, 0];
    const here = new B.CircleSampler(engine, s, o, c, right, up, radius, count, profile).step(Infinity);
    const sliced = new B.CircleSampler(engine, s, o, c, right, up, radius, count, profile);
    let r = null; while (!(r = sliced.step(-1))) {}   // one ray a call: the slices' path to the end
    assert.equal(json(r), json(here), 'sliced circle');
    w.send({type: 'circle', id: 100 + circles, engine: 1, shell: s, o: o, center: c, right: right, up: up, radius: radius, count: count, profile: profile});
    const a = await w.answer(100 + circles);
    assert.equal(a.id, 100 + circles);
    assert.equal(json(a.result), json(here), 'worker circle ' + count + ' ' + profile + ' ' + s.kind);
    circles++;
  }
}
console.log('ok   ' + circles + ' circle integrals from the worker equal the main thread’s, in one piece and in slices');
// A job on an engine the worker dropped (or never had) is answered with an error, so the page falls back.
// Cancels (the page's lanes): a job cancelled while queued, or before its first slice, is never answered; the job after it
// is. A job holds its engine from the moment it arrives: a drop after it does not take it away.
const job = (id, count, en) => ({type: 'circle', id: id, engine: en || 1, shell: shells[0], o: [0.3, 0.2, -30], center: [0.1, 0.05, 0], right: [1, 0, 0], up: [0, 1, 0], radius: .9, count: count, profile: 'empirical-post96'});
w.send(job(300, 4000)); w.send(job(301, 4000)); w.send(job(302, 64)); w.send({type: 'cancel', ids: [300, 301]});
w.send({type: 'drop', engines: [1]});
const kept = await w.answer(302); await w.idle();
assert.ok(kept.result && kept.result.samples === 64, 'the job after the cancelled ones is answered');
assert.ok(!w.answers.some((a) => a.id === 300 || a.id === 301), 'cancelled jobs are never answered');
// A job cancelled between its slices: its first slices run, the cancel lands before the next, no answer.
const pk2 = B.packEngine(engine);
w.send({type: 'engine', id: 2, engine: pk2});
w.send(job(303, 400000, 2)); w.send(job(304, 32, 2));
await new Promise((r) => setTimeout(r, 30));
w.send({type: 'cancel', ids: [303]});
assert.equal((await w.answer(304)).result.samples, 32); await w.idle();
assert.ok(!w.answers.some((a) => a.id === 303), 'a running job cancelled between its slices is dropped');
console.log('ok   a cancelled job (queued, or between its slices) is never answered; the next one is; a drop spares queued jobs');
w.send({type: 'drop', engines: [2]});
w.send(job(999, 8, 2));
assert.ok(/no engine/.test((await w.answer(999)).error));
console.log('ok   a job on a dropped engine is answered with an error');

// Verdicts: the models once, the scene by model ids; the answer equals verdicts on the flat engine built here. Points with
// a ricochet in the chain (effect 1/2) take the bounced leg from the previous one.
const pts = [
  {pos: [0, 0.3, -3], line: [0.05, -0.02, 1], part: 1, effect: 1, pi: 0, hitType: 0, source: 'tracer', chordDev: 0.01},
  {pos: [1.9, 0.1, 0.5], line: [0.8, 0.1, 0.6], part: 1, effect: 3, pi: 1, hitType: 0, source: 'segment', chordDev: null},
  {pos: [-2.7, 0, 1], line: [-1, 0, 0.1], part: 2, effect: 2, pi: 2, hitType: 1, source: 'segment', chordDev: 0.2},
  {pos: [-2, 0.5, 2], line: [0.2, -0.1, 1], part: 1, effect: 4, pi: 3, hitType: 0, source: 'segment', chordDev: 0}
];
const m1 = B.packModel(models[1]), m2 = B.packModel(models[2]);
// A packed model is what the worker keeps and builds from: the same engine as the page's models give.
{
  const flatData = {hit: data.hit, models: {1: structuredClone(m1), 2: structuredClone(m2)}}, a = B.build(flatData, false), b = B.build(data, false);
  assert.ok(flatData.models[1].groups[0].v instanceof Float64Array);
  assert.equal(json(a.triangles), json(b.triangles), 'a packed model builds the same triangles');
  assert.equal(json(shape(a.acceleration)), json(shape(b.acceleration)), 'and the same tree');
}
w.send({type: 'model', id: 7, model: m1}); w.send({type: 'model', id: 8, model: m2});
let verdictSets = 0;
for (const s of shells) {
  const here = B.verdicts(B.build(data, false, true), pts, s);
  w.send({type: 'verdicts', id: 200 + verdictSets, scene: {parts: parts.map((p) => ({id: p.id, transform: p.transform, armor: p.armor})), models: {1: 7, 2: 8}}, points: pts, shell: s});
  const a = await w.answer(200 + verdictSets);
  assert.equal(json(a.result), json(here), 'worker verdicts ' + s.kind);
  assert.ok(here.some((v) => v.result && v.result.bounce) || here.some((v) => v.prevEffect === 1), 'a ricochet leg in the chain');
  verdictSets++;
}
console.log('ok   ' + verdictSets + ' verdict sets from the worker equal the main thread’s (' + pts.length + ' points each)');
// Without a worker (Node, a page where Worker fails) a sampler's post() leaves the job on the main thread.
const lone = new B.CircleSampler(engine, shells[0], [0, 0, -30], [0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 16, 'empirical-post96').post();
assert.equal(lone.remote, null);
assert.ok(lone.step(-1) === null || lone.result);
assert.equal(B.remoteVerdicts(data, pts, shells[0]), null);
console.log('ok   no worker: jobs stay on the main thread');
console.log('PASS: ray worker');
})().catch((e) => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
