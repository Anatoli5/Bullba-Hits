// NOTEBOOK A1 (23.11.2026, the user in the game on 1.30): in the shot episode the growing dashed tracer and its shell dot
// stopped short of the target (e.g. artillery) - as if tied to the camera's framing stop -, and in some episodes there was
// no tracer at all. Cause (measured on his battles below): the line's end ran on the battle's clock (shot-view.js
// flightLine: tau = S.t - L.t), and the episode stops the battle at the recorded hit. The replay's times come in 0.1 s
// server ticks, so the recorded hit is earlier than the shell's computed flight (the arc's duration): an SPG shot of
// 2.88 s stopped at 2.7 s (reach 0.94), and a close shot whose tracer and hit share one tick stopped at tau = 0 - a line
// of no length. The shell's own clock (shot-view.js shellTau) now goes on past the stop on the wall clock, as the
// camera's travel already did, until the shell reaches the contact. Here: the episode played frame by frame (60 fps, the
// battle to the stop, then the wall clock) for every shot row of his two battles (tests/fixtures-local/
// tracer-reach-2026-11-23, when present) and for synthetic cases: the line reaches the arc's end on the shell's own
// time, and grows there without jumps; a scrub to the hit (no episode stop) shows the whole line.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web', 'playback');
const PB = require(path.join(WEB, 'battle.js'));
const sb = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(WEB, 'shot-view.js'), 'utf8'), sb);
const A = sb.window.BullbaShotView.arty;
const FIXTURE = path.join(__dirname, 'fixtures-local', 'tracer-reach-2026-11-23', 'episodes.json');
const DT = 1 / 60;
let checks = 0;

// the flight flightLine draws for a shot row: its arc's duration (the page passes the drawn muzzle too, which only
// shortens it), else the recorded tracer's flight
function flightOf(shot) {
  const p = PB.trajectory(shot, null, null, {});
  return { p, flight: p ? p.duration : Math.max(0.05, shot[10] - shot[0]) };
}
// one episode as the page plays it: the battle clock from 0.5 s before the shot to the stop (shot-view.js clamp holds it,
// there and notes the wall time), then frames on the wall clock; the reach flightLine draws on each frame
function play(lineT, stop, flight, after) {
  const out = [];
  let t = lineT - 0.5, wall = 1000, arrivedAt = null;
  for (let i = 0; i < 100000; i++) {
    if (arrivedAt == null) { const t1 = t + DT; if (t1 >= stop - 1e-6) { t = stop; arrivedAt = wall + DT * 1000; } else t = t1; }
    wall += DT * 1000;
    const tau = A.shellTau(t, lineT, stop, arrivedAt, wall);
    out.push({ wall, stopped: arrivedAt != null, since: arrivedAt == null ? 0 : (wall - arrivedAt) / 1000, reach: PB.tracerReach(flight, tau), tau });
    if (arrivedAt != null && (wall - arrivedAt) / 1000 > after) break;
  }
  return out;
}
function episode(what, shot, lineT, stop) {
  const { p, flight } = flightOf(shot), frames = play(lineT, stop, flight, flight + 0.5), last = frames[frames.length - 1];
  assert.strictEqual(last.reach, 1, what + ': the line reaches the contact (reach ' + last.reach + ', flight ' + flight.toFixed(3) + ' s, stopped ' + (stop - lineT).toFixed(3) + ' s after the shot)');
  // on the shell's own time: whole when its flight is over, not later (one frame of slack)
  const whole = frames.find((f) => f.reach >= 1), due = Math.max(0, flight - (stop - lineT));
  assert.ok(!whole.stopped || whole.since <= due + 2 * DT, what + ': whole ' + whole.since.toFixed(3) + ' s after the stop, due ' + due.toFixed(3));
  // it flies: no frame grows by more than a frame's share of the flight (no jump to the end)
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].reach - frames[i - 1].reach;
    assert.ok(d >= -1e-12 && d <= DT / flight + 1e-6, what + ': a jump of ' + d.toFixed(3) + ' at frame ' + i);
  }
  // the line drawn at the end is the whole arc (growTracer over the same reach)
  if (p) {
    const buf = new Float32Array(97 * 3), g = PB.growTracer(p.point, flight, last.tau, 96, buf);
    let len = 0; for (let i = 1; i < g.n; i++) len += Math.hypot(buf[i * 3] - buf[i * 3 - 3], buf[i * 3 + 1] - buf[i * 3 - 2], buf[i * 3 + 2] - buf[i * 3 - 1]);
    assert.ok(Math.abs(len - p.length) <= p.length * 1e-3 + 1e-3, what + ': drawn ' + len + ' m of ' + p.length);
  }
  checks++;
}

// 1. synthetic: an SPG arc of 2.88 s whose hit the replay records at 2.7 s (his T92 HMC at 228.045 s of Fisherman's Bay)
const v = [60, 150, 80], g = 45, T = 2.88;
const SPG = [100, 1, 0, 0, 30, 0, v[0], v[1], v[2], g, 102.7, v[0] * T, 30 + v[1] * T - 0.5 * g * T * T, v[2] * T];
episode('synthetic SPG, hit recorded 0.18 s early', SPG, 100, 102.7);
// 2. synthetic: a close shot whose tracer and hit share one tick (tau 0 at the stop: no line at all on 1.30)
const CLOSE = [50, 1, 0, 0, 2, 0, 900, 0, 0, 9.81, 50, 30, 2, 0];
episode('synthetic close shot, hit in the shot\'s tick', CLOSE, 50, 50);
// 3. the straight fallback (no arc: an end far off the flight) on the recorded tracer's own time
const OFF = [20, 1, 0, 0, 2, 0, 900, 0, 0, 9.81, 20, 100, 2, 300];
assert.strictEqual(flightOf(OFF).p, null, 'the off-flight end has no arc');
episode('straight fallback, hit in the shot\'s tick', OFF, 20, 20);
// 4. a scrub to the hit or past it (no episode stop noted): the shell has arrived - the whole line
assert.strictEqual(PB.tracerReach(2.88, A.shellTau(102.7, 100, 102.7, null, 5000)), 1, 'scrubbed to the hit: whole');
assert.strictEqual(PB.tracerReach(2.88, A.shellTau(101, 100, 102.7, null, 5000)), 1 / 2.88, 'before the hit: the battle clock');
checks += 2;

// 5. his battles: every shot row of the two battles as its episode plays
if (fs.existsSync(FIXTURE)) {
  const F = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let n = 0, short = 0, empty = 0;
  Object.keys(F.battles).forEach((id) => F.battles[id].rows.forEach((r) => {
    const { flight } = flightOf(r.shot), before = PB.tracerReach(flight, r.stop - r.t);
    if (before <= 0) empty++; else if (before < 0.999) short++;
    episode(F.battles[id].map + ' ' + r.t + ' s, ' + r.type + ' (' + r.shooter + ')', r.shot, r.t, r.stop);
    n++;
  }));
  console.log('# his battles: ' + n + ' episodes (' + empty + ' with no line at the stop on the battle clock, ' + short + ' short)');
} else console.log('# skip his battles: ' + FIXTURE + ' absent');
console.log('# passed ' + checks);
