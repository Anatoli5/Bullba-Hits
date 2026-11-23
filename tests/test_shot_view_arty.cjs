// The replay viewer's shot view on an artillery shot (22.11, outputs/arty-shot-view-2026-11-22.md): the pure maths of
// web/playback/shot-view.js (BullbaShotView.arty) on arcs made by the page's own web/playback/battle.js trajectory.
// - the pre-shot artillery trajectory view (the game's ArtyCamera rule): the eye on the line through the aim point along
//   the shell's fall, pitch at least 10 deg, distance 25-95 m, the target in frame;
// - from release the camera rides the arc at the shell's clock looking along its tangent: within 2 deg of the analytic
//   tangent on every frame, for an SPG arc and a direct-fire one;
// - the SPG mark: the aim circle square to the fall, laid along it: 37 points on the ground (flat and sloped) and on a box
//   (the target) standing under part of it - its top or sides, no ground point under it -, seen along the fall a circle of
//   the expected radius.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web', 'playback');
const sandbox = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(WEB, 'shot-view.js'), 'utf8'), sandbox);
const A = sandbox.window.BullbaShotView.arty;
const PB = require(path.join(WEB, 'battle.js'));
const DEG = Math.PI / 180;
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) / DEG;
let checks = 0;
function ok(cond, what, detail) { assert.ok(cond, what + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks++; }

// a shot row as battle.js keeps it: t, shooter, flag, start 3-5, velocity 6-8, gravity 9, tEnd 10, end 11-13 (game axes)
function shot(start, v, g, groundY, nudge) {
  const T = (v[1] + Math.sqrt(v[1] * v[1] + 2 * g * (start[1] - groundY))) / g;
  const end = [start[0] + v[0] * T + nudge[0], groundY + nudge[1], start[2] + v[2] * T + nudge[2]];
  return [0, 1, 0].concat(start, v, [g, T], end);
}
const scenePt = (p) => (u) => { const q = p.point(u); return [q[0], q[1], -q[2]]; };
// the analytic derivative of battle.js point(u) (scene axes), independent of the code under test
function tangent(s, p, u) {
  const d = p.duration, t = u * d, v = s.slice(6, 9), g = s[9], off = [0, 0, 0];
  const r = [0, 1, 2].map((i) => d * (v[i] - (i === 1 ? g * t : 0)) + 2 * u * p.alignment[i] - 2 * (1 - u) * off[i]);
  return [r[0], r[1], -r[2]];
}

const SPG = shot([100, 60, 200], [90, 170, 160], 45, 0, [2, 0, -1.5]);
const DF = shot([0, 3, 0], [700, 2, 380], 9.81, 0, [0.4, 0.8, 0.2]);
const flat = () => 0, slope = (x) => 0.05 * x;

// ---- 1. the pre-shot artillery view ----------------------------------------------------------------------------------
for (const [name, s, minPitchOnly] of [['SPG arc', SPG, false], ['shallow arc', DF, true]]) {
  const p = PB.trajectory(s), pt = scenePt(p), end = pt(1), fall = A.tangentAt(pt, 1);
  const aim = [end[0] + 1, end[1], end[2] - 1];
  const box = [];
  for (const dx of [-3.5, 3.5]) for (const dy of [0, 2.5]) for (const dz of [-1.7, 1.7]) box.push([end[0] + dx, end[1] + dy, end[2] + dz]);
  const F = A.artyFrame(aim, fall, box, 67.5, 16 / 9, flat);
  const fallPitch = Math.asin(-fall[1]), want = Math.max(fallPitch, 10 * DEG);
  const h = Math.hypot(fall[0], fall[2]), dirWant = [Math.cos(want) * fall[0] / h, -Math.sin(want), Math.cos(want) * fall[2] / h];
  const look = [aim[0] - F.eye[0], aim[1] - F.eye[1], aim[2] - F.eye[2]];
  ok(angle(look, dirWant) < 0.1, name + ': the eye on the line through the aim point along the fall (pitch max(fall, 10 deg))', {off: angle(look, dirWant)});
  ok(F.pitch >= 10 * DEG - 1e-9, name + ': pitch at least 10 deg', F.pitch / DEG);
  ok(F.dist >= 25 && F.dist <= 95 && Math.abs(Math.hypot(look[0], look[1], look[2]) - F.dist) < 1e-6, name + ': distance 25-95 m', F.dist);
  ok(F.fits, name + ': the target box in frame');
  if (minPitchOnly) ok(Math.abs(F.pitch - 10 * DEG) < 1e-9 && fallPitch < 10 * DEG, name + ': a fall under 10 deg is viewed at exactly 10 deg', fallPitch / DEG);
  else ok(F.pitch > 30 * DEG && Math.abs(F.pitch - fallPitch) < 1e-9, name + ': a steep fall is viewed at its own pitch', [F.pitch / DEG, fallPitch / DEG]);
}

// ---- 2. from release: on the arc at the shell's clock, looking along the tangent ------------------------------------
for (const [name, s] of [['SPG arc', SPG], ['direct fire', DF]]) {
  const p = PB.trajectory(s), pt = scenePt(p), endU = 1 - 15 / p.length;
  let worst = 0, frames = 0, clockOff = 0;
  for (let e = 0; e <= p.duration + 0.3; e += 1 / 60) {
    const f = Math.min(1, e / p.duration), lf = A.lineFrame(p, pt, f, endU), q = pt(lf.uc);
    ok(Math.hypot(lf.eye[0] - q[0], lf.eye[1] - q[1], lf.eye[2] - q[2]) < 1e-9 && lf.u <= endU + 1e-9, name + ': the eye on the arc, never past the framing stop');
    worst = Math.max(worst, angle(lf.fwd, tangent(s, p, lf.uc)));
    if (A.arcD(p, f) / p.length < endU - 1e-6) clockOff = Math.max(clockOff, Math.abs(lf.uc - f));
    frames++;
  }
  ok(worst < 2, name + ': the forward within 2 deg of the arc tangent on every one of ' + frames + ' frames', worst);
  ok(clockOff < 2e-3, name + ': the eye at the shell\'s clock until the framing stop', clockOff);
  const last = A.lineFrame(p, pt, 1, endU);
  ok(angle(last.fwd, tangent(s, p, last.uc)) < 2, name + ': at the end the look stays on the tangent');
  // the default pace (Settings' "camera at the shell's speed" off): 1.28's eased glide - smoothstep over max(0.6 s, flight)
  // of the arc's length up to endU -, the same tangent look
  const dur = Math.max(0.6, p.duration);
  let worstB = 0, paceOff = 0;
  for (let e = 0; e <= dur + 0.3; e += 1 / 60) {
    const f = Math.min(1, e / dur), sm = f * f * (3 - 2 * f), lf = A.easedFrame(p, pt, sm, endU);
    worstB = Math.max(worstB, angle(lf.fwd, tangent(s, p, lf.uc)));
    paceOff = Math.max(paceOff, Math.abs(A.arcD(p, lf.uc) - endU * sm * p.length));
  }
  ok(worstB < 2, name + ', eased pace: the forward within 2 deg of the arc tangent on every frame', worstB);
  ok(paceOff < 0.05, name + ', eased pace: the eye at smoothstep x endU of the arc\'s length (1.28\'s rule)', paceOff);
}

// ---- 3. the SPG mark: the aim circle square to the fall, laid along the fall --------------------------------------
{
  const origin = [100, 60, -200], v = [90, 170, -160], g = 45, ang = 0.004;
  const centre = A.flyToGround(origin, v, g, flat, null), fall = A.fallAt(origin, v, g, centre);
  const R = ang * Math.hypot(centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]);
  ok(fall[1] < -0.5 && Math.abs(centre[1]) < 1e-6, 'the aim point on the ground, the fall descending', {centre, fall});
  // carried back along the fall into the plane square to it through the aim point: the circle of radius R (within 1 %)
  const back = (q) => { const d = [q[0] - centre[0], q[1] - centre[1], q[2] - centre[2]], k = dot(d, fall); return Math.hypot(d[0] - fall[0] * k, d[1] - fall[1] * k, d[2] - fall[2] * k); };
  // each ground with its own aim point and fall; the slope rising against the fall too (the ray's start under the ground)
  for (const [name, ground] of [['flat ground', flat], ['sloped ground', slope], ['ground rising against the fall', (x) => -0.6 * x]]) {
    const c = A.flyToGround(origin, v, g, ground, null), fl = A.fallAt(origin, v, g, c), r = ang * Math.hypot(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
    const bk = (q) => { const d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]], k = dot(d, fl); return Math.hypot(d[0] - fl[0] * k, d[1] - fl[1] * k, d[2] - fl[2] * k); };
    const pts = A.fallMark(c, fl, r, ground, null);
    ok(pts.length === 37 && pts.every((q) => q && Math.abs(q[1] - ground(q[0], q[2])) < 1e-3), name + ': 37 points on the ground', pts.map((q) => q && q[1] - ground(q[0], q[2])));
    ok(pts.every((q) => Math.abs(bk(q) - r) < 0.01 * r), name + ': seen along the fall, a circle of the expected radius ' + r.toFixed(2) + ' m', pts.map(bk));
  }
  // a box (the target) standing on the ground under part of the circle, 0.6 R off the centre across the fall
  const hz = norm([fall[0], 0, fall[2]]), across = [-hz[2], 0, hz[0]], half = [0.5 * R, 0, 0.5 * R], top = 2.5;
  const bc = [centre[0] + across[0] * 0.6 * R, 0, centre[2] + across[2] * 0.6 * R];
  const bx = {inv: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bc[0], -bc[1], -bc[2], 1], min: [-half[0], 0, -half[2]], max: [half[0], top, half[2]], top: top};
  const hits = A.fallMark(centre, fall, R, flat, [bx]), e = 1e-6;
  const inXZ = (q) => Math.abs(q[0] - bc[0]) <= half[0] + e && Math.abs(q[2] - bc[2]) <= half[2] + e;
  const onBox = hits.filter((q) => q[1] > 1e-3), onGround = hits.filter((q) => q[1] <= 1e-3);
  ok(onBox.length > 0 && onGround.length > 0, 'part of the mark on the box, part on the ground', {box: onBox.length, ground: onGround.length});
  ok(onBox.every((q) => inXZ(q) && q[1] <= top + e && (Math.abs(q[1] - top) < 1e-6 || Math.abs(Math.abs(q[0] - bc[0]) - half[0]) < 1e-6 || Math.abs(Math.abs(q[2] - bc[2]) - half[2]) < 1e-6)),
    'the points over the box lie on its top or sides', onBox);
  ok(onGround.every((q) => !inXZ(q)), 'no ground point under the box (the first hit along the fall wins)');
  ok(hits.every((q) => Math.abs(back(q) - R) < 0.01 * R), 'on the box too, seen along the fall, the same circle', hits.map(back));
}
console.log('test_shot_view_arty: ' + checks + ' checks passed');
