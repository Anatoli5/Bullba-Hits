/* The page's ray worker (28.09, steady-60): the engine and the models as flat arrays and back, and the worker's side
 * (ArmorBallistics.serve) over a scope whose messages go through structuredClone as a real postMessage would. Everything
 * the worker answers must equal the main thread's own result, every field: rays of a full and of a flat engine, a circle
 * integral in one piece and in slices, the Statistics log's verdicts. The real blob worker in Chrome: tests/page/frame_cost.cjs. */
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

// A worker scope in-process: every message through structuredClone (with the transfer list), the answers collected.
function scope() {
  const answers = [], s = {postMessage: (m) => answers.push(structuredClone(m)), answers: answers};
  B.serve(s);
  s.send = (m, transfer) => s.onmessage({data: structuredClone(m, {transfer: transfer || []})});
  return s;
}
const shells = [B.shell('ARMOR_PIERCING', 140, 100), B.shell('ARMOR_PIERCING_CR', 90, 85), B.shell('HOLLOW_CHARGE', 200, 105), Object.assign(B.shell('HIGH_EXPLOSIVE', 50, 152), {alpha: 750, spallDamage: 375, mechanics: 'MODERN'})];
shells[0].alpha = 390;

let rays = 0;
for (const flat of [false, true]) {
  const engine = B.build(data, false, flat), pk = B.packEngine(engine), back = B.unpackEngine(structuredClone(pk));
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
console.log('ok   packed engines cast the same ' + rays + ' rays, every field (kd-tree and flat)');

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
    const a = w.answers.shift();
    assert.equal(a.id, 100 + circles);
    assert.equal(json(a.result), json(here), 'worker circle ' + count + ' ' + profile + ' ' + s.kind);
    circles++;
  }
}
console.log('ok   ' + circles + ' circle integrals from the worker equal the main thread’s, in one piece and in slices');
// A job on an engine the worker dropped (or never had) is answered with an error, so the page falls back.
w.send({type: 'drop', id: 1});
w.send({type: 'circle', id: 999, engine: 1, shell: shells[0], o: [0, 0, -30], center: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], radius: 1, count: 8, profile: 'empirical-post96'});
assert.ok(/no engine/.test(w.answers.shift().error));
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
w.send({type: 'model', id: 7, model: m1}); w.send({type: 'model', id: 8, model: m2});
let verdictSets = 0;
for (const s of shells) {
  const here = B.verdicts(B.build(data, false, true), pts, s);
  w.send({type: 'verdicts', id: 200 + verdictSets, scene: {parts: parts.map((p) => ({id: p.id, transform: p.transform, armor: p.armor})), models: {1: 7, 2: 8}}, points: pts, shell: s});
  const a = w.answers.shift();
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
