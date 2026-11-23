// NOTEBOOK Y22 (22.11.2026, the user's screenshot of 1.28: a shot of G27_VK3001P at G27_VK3001P, the shot view's dashed
// tracer left the muzzle, curled back like a hook and then ran to the hit). Cause, measured on the user's close-range
// battle of 22.11: 1.28's arc (web/playback/battle.js trajectory) faded the drawn muzzle's whole offset out along the
// flight (offset * (1 - u)^2); the recorded start is the gun's pivot (KNOWLEDGE-client, measured 17.11), so the muzzle lies
// a gun length L AHEAD on the flight and every shot nearer than 2 L ran from the muzzle back toward the pivot first (L = 5 m:
// 8 of its 43 hits). Also: a ricochet's tracer ended in its first tick 600 m behind its start (fixture of 18.11) - its
// own arc turned 180 degrees. Here: no drawn arc turns back - its direction never more than 90 degrees from the chord to
// its end, its progress along that chord never backwards - for every tracer and hit of the two battles (fixture
// tests/fixtures-local/trajectory-2026-11-22, when present) with the muzzle a gun length ahead, and for synthetic cases.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const PB = require(path.join(__dirname, '..', 'web', 'playback', 'battle.js'));
const sub = (a, b) => a.map((x, i) => x - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = (a) => Math.hypot(a[0], a[1], a[2]);

// the hook measure: the widest angle of a drawn segment from the chord (start -> end) and the longest step backwards
// along it, over the 96 samples the page draws
function hook(p) {
  const S = p.samples, a = S[0].p, ch = sub(S[S.length - 1].p, a), cl = len(ch) || 1;
  let angle = 0, back = 0, best = -Infinity;
  for (let i = 1; i < S.length; i++) {
    const d = sub(S[i].p, S[i - 1].p), l = len(d); if (l < 1e-9) continue;
    angle = Math.max(angle, Math.acos(Math.max(-1, Math.min(1, dot(d, ch) / (l * cl)))) * 180 / Math.PI);
    const q = dot(sub(S[i].p, a), ch) / cl; if (q >= best) best = q; else back = Math.max(back, best - q);
  }
  return {angle, back};
}
function noHook(p, what) {
  const h = hook(p);
  assert.ok(h.angle <= 90 && h.back <= 1e-6, what + ': the arc turns back ' + JSON.stringify(h));
}
// a shot row (battle.shots: t, shooter, ricochet, start 3, velocity 3, gravity, tEnd, end 3, ...)
function shot(start, velocity, end, gravity) { return [0, 1, 0].concat(start, velocity, [gravity == null ? 9.81 : gravity, 1], end); }
const ahead = (s, L, sideways) => {
  const v = s.slice(6, 9), n = len(v), d = v.map((x) => x / n), h = Math.hypot(d[0], d[2]) || 1, side = [d[2] / h, 0, -d[0] / h];
  return d.map((x, i) => x * L + side[i] * (sideways || 0));
};

// 1. synthetic: a 4.5 m shot with the muzzle 6 m ahead (1.28: the hook) - the arc starts on the flight past the muzzle
// and runs forward; the sideways part of a muzzle still fades out
const close = shot([0, 1, 0], [900, 0, 0], [4.5, 1, 0]);
const P = PB.trajectory(close, ahead(close, 6, 0.3), [4.5, 1.1, 0.2]);
assert.ok(P, 'a close shot keeps its arc');
noHook(P, 'a 4.5 m shot, muzzle 6 m ahead');
// 95 % of the flight is inside the barrel (capped); 0.3 m sideways over the 0.23 m left would turn it 69 degrees: dropped
assert.ok(Math.abs(P.point(0)[0] - 4.275) < 0.01 && Math.abs(P.point(0)[2] - 0.2 * 0.95 * 0.95) < 1e-6 && P.note, 'it starts at 95 % of the flight, on it: ' + P.point(0));
const far = shot([0, 1, 0], [900, 0, 0], [300, 0.5, 0]);
const F = PB.trajectory(far, ahead(far, 6, 0.3));
noHook(F, 'a 300 m shot, muzzle 6 m ahead');
assert.ok(Math.abs(F.point(0)[0] - 6) < 0.01 && Math.abs(F.point(0)[2] + 0.3) < 1e-6, 'a far shot starts at the drawn muzzle: ' + F.point(0));
assert.ok(Math.abs(F.duration - 300 / 900 * (1 - 6 / 300)) < 1e-9, 'its flight time is the one from the muzzle');
// a muzzle far beside the flight (a wrong pose): the arc starts on the flight, and says so
const sideWhy = {}, Side = PB.trajectory(far, [0, 0, 400], null, sideWhy);
noHook(Side, 'a muzzle 400 m beside the flight');
assert.ok(Side.note && /beside the recorded flight/.test(Side.note) && len(sub(Side.point(0), [0, 1, 0])) < 1e-6, 'a muzzle far beside is dropped: ' + Side.note);
// an end far off the flight (a hit given to the wrong tracer, a ricochet's bogus end): no arc, the reason
const offWhy = {};
assert.strictEqual(PB.trajectory(far, null, [150, 1, 260], offWhy), null, 'an end 60 degrees off the flight gets no arc');
assert.ok(/off the recorded flight/.test(offWhy.text), 'and says why: ' + offWhy.text);
const ric = [159.825, 1, 1, 298.529, 56.807, 479.338, -877.067, 166.191, 331.049, 6.2784, 159.825, 598.894, 0, 365.965];
const ricWhy = {};
assert.strictEqual(PB.trajectory(ric, null, null, ricWhy), null, 'the ricochet of 18.11 ending 600 m behind its start gets no arc');
// a mortar lob keeps its arc: the end on its recorded flight, its fall steep
const lob = shot([0, 0, 0], [200, 200, 0], [0, 0, 0], 9.81), T = 400 / 9.81;
lob.splice(11, 3, 200 * T, 0, 0);
noHook(PB.trajectory(lob, ahead(lob, 5)), 'a 45 degree lob');

// 2. the fixture: every tracer of both battles to its own end, and every hit with a Hits record to its hit point, the
// muzzle a gun length of 3, 5 or 7 m ahead (with 0.3 m of pose error sideways)
const FIX = path.join(__dirname, 'fixtures-local', 'trajectory-2026-11-22', 'shots.json');
let paths = 0, rejected = 0;
if (fs.existsSync(FIX)) {
  const fx = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  Object.keys(fx.shots).forEach((id) => fx.shots[id].forEach((s, i) => [0, 3, 5, 7].forEach((L) => {
    const p = PB.trajectory(s, ahead(s, L, L ? 0.3 : 0));
    if (!p) { rejected++; return; }
    paths++; noHook(p, id + ' tracer ' + i + ' (' + s[16] + '), L ' + L);
  })));
  fx.hits.forEach((h) => [0, 3, 5, 7].forEach((L) => {
    const s = fx.shots[h.battle][h.shot], why = {}, p = PB.trajectory(s, ahead(s, L, L ? 0.3 : 0), h.hit, why);
    assert.ok(p, h.battle + ' hit of tracer ' + h.shot + ' at ' + h.dist + ' m has its arc: ' + why.text);
    paths++; noHook(p, h.battle + ' hit of tracer ' + h.shot + ' at ' + h.dist + ' m, L ' + L);
  }));
  assert.strictEqual(rejected, 4, 'only the ricochet of 18.11 with its end 600 m behind is left without an arc (x4 muzzles)');
}
process.stdout.write('test_trajectory_hook: ok (' + paths + ' fixture arcs' + (fs.existsSync(FIX) ? '' : ', fixture absent') + ')\n');
