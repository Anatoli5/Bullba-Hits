// BACKLOG 133 (23.11): the replay viewer's smooth camera - web/playback/playback.js easeCam, read from the page's own
// source (CAM_EASE up to the "end easeCam" line). The user's input moves the goal; each rendered frame the camera eases
// toward it with k = 1 - exp(-dt / tau). Checked here:
// - frame-rate independence: one input (a wheel click's jump of the distance, a drag's turn, a pan) followed at 30, 60
//   and 144 fps reaches the same value at the same moments (within 1 % of the move);
// - the total: once settled the camera stands exactly where the input put the goal (the movement per input unchanged);
// - many small inputs (a drag's pointer events spread over frames) add up to their sum;
// - "smooth camera" off: the camera is at the goal on the very frame.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'playback', 'playback.js'), 'utf8');
const a = src.indexOf('  var CAM_EASE'), b = src.indexOf('  // end easeCam');
assert.ok(a > 0 && b > a, 'CAM_EASE and easeCam found in playback.js');
const box = {};
vm.runInNewContext(src.slice(a, b) + '\nthis.easeCam = easeCam; this.CAM_EASE = CAM_EASE;', box);
const { easeCam, CAM_EASE } = box;
let checks = 0;
function ok(cond, what, detail) { assert.ok(cond, what + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks++; }
const KEYS = ['tx', 'ty', 'tz', 'yaw', 'pitch', 'dist'];
const pose = (o) => Object.assign({ tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0.5, dist: 100 }, o || {});

// one input at t = 0 (the goal moved), the camera followed at `fps`; the value of each key sampled at `times` (s)
function follow(fps, goal, times) {
  const cur = pose(), dt = 1 / fps, out = times.map(() => ({}));
  let t = 0, i = 0;
  while (i < times.length) {
    easeCam(cur, goal, dt, true); t += dt;
    while (i < times.length && t >= times[i] - 1e-9) { KEYS.forEach((k) => { out[i][k] = cur[k]; }); i++; }
  }
  return out;
}
// 1 / 30 s is a whole number of frames at 30, 60 fps; 144 fps hits the same instants only at whole 1/48 s - the samples
// are taken where all three have a frame: 1/6 s steps
const times = [1 / 6, 2 / 6, 3 / 6, 1, 3];
const goal = pose({ tx: 12, tz: -7, yaw: 0.8, pitch: 0.2, dist: 77 });  // a pan, a turn and a wheel click in (100 -> 77)
const runs = [30, 60, 144].map((fps) => follow(fps, goal, times));
KEYS.forEach((k) => {
  const move = Math.abs(goal[k] - pose()[k]);
  if (!move) return;
  times.forEach((tt, i) => {
    const v = runs.map((r) => r[i][k]), spread = Math.max(...v) - Math.min(...v);
    ok(spread <= 0.01 * move, 'the same ' + k + ' at ' + tt.toFixed(3) + ' s at 30/60/144 fps', v);
  });
});
// the analytic value: start + move * (1 - exp(-t / tau)) at every frame rate
times.forEach((tt, i) => {
  const want = 100 + (77 - 100) * (1 - Math.exp(-tt / CAM_EASE.dist));
  runs.forEach((r) => ok(Math.abs(r[i].dist - want) < 1e-6, 'dist follows the exponential at ' + tt.toFixed(3) + ' s', [r[i].dist, want]));
});
// the total: settled after 3 s (25 time constants of the zoom) the camera is where the input put it
runs.forEach((r) => KEYS.forEach((k) => ok(r[times.length - 1][k] === goal[k], 'settles exactly on the goal: ' + k, r[times.length - 1][k])));
// the wheel's glide is the slower one (a click's jump spread out), the turn settles first
ok(CAM_EASE.dist > CAM_EASE.yaw && CAM_EASE.yaw === CAM_EASE.pitch && CAM_EASE.tx === CAM_EASE.tz, 'tau: wheel slower than turn and pan', CAM_EASE);
// many small inputs during the glide: a drag's pointer events (0.005 rad a px) between frames add up to their sum
[30, 60, 144].forEach((fps) => {
  const cur = pose(), g = pose(), dt = 1 / fps;
  let sum = 0;
  for (let f = 0; f < fps; f++) { const d = 0.005 * (3 + (f % 5)); g.yaw -= d; sum -= d; easeCam(cur, g, dt, true); }
  for (let f = 0; f < fps * 2; f++) easeCam(cur, g, dt, true);
  ok(cur.yaw === sum, 'a drag at ' + fps + ' fps turns by the sum of its steps', [cur.yaw, sum]);
});
// smooth camera off: at the goal on the frame
const off = pose();
easeCam(off, goal, 1 / 60, false);
KEYS.forEach((k) => ok(off[k] === goal[k], 'off: at the goal at once: ' + k));
console.log('camera ease: ' + checks + ' checks passed');
