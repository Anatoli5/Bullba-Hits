/* The replay viewer's frame log (web/playback/frame-log.js, 20.11.2026, temporary diagnostic) on a fake clock.
 *
 *   node tests/page/frame_log.cjs
 *
 * The module as it ships, in a bare context with a stand-in canvas class; frames are handed as the page hands them
 * (playback.js frameBody: the interval, the page's own CPU time, playing). Checks: the first line at 10 s of playing, with
 * every field; the next at 30 s more; nothing while paused (however long); an interval over 250 ms writes at once, but not
 * twice within 10 s; at most 20 lines; a WebGL context counted once per canvas. The page's own wiring (only with
 * #host=game, the fields from its state) is checked on the real page by tests/page/playback_page.cjs.
 * The one number printed: the first line, as the mod's log would show it after 'Page input: '.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
let checks = 0, failed = 0;
function check(name, ok, detail) { checks++; if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); } }

function Canvas() {}
Canvas.prototype.getContext = function (type) { return type === 'none' ? null : {type: type}; };
const box = {HTMLCanvasElement: Canvas};
box.window = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'playback', 'frame-log.js'), 'utf8'), box, {filename: 'frame-log.js'});
const FL = box.BullbaFrameLog;

const STATE = {canvas: '1920x1080', dpr: '1.25 (drawn at 1.25)', speed: 1, camera: 'follow', canvases: 3, shotViewOpened: false,
  settings: 'shadows sharp 2048, sky on, haze on, halo on, objects visual, trees on, bushes on, water on, outside 1, crowns 1, relief 1, hits on, cost meter off (no wind setting)',
  map: '02_malinovka'};
function make() { const lines = []; return {lines: lines, log: FL.create({send: (l) => lines.push(l), state: () => STATE})}; }
// `seconds` of frames at `ms` each (a 0.5 ms CPU time), playing or not
function run(L, seconds, ms, playing, cpu) { for (let t = 0; t < seconds * 1000; t += ms) L.log.frame(ms, cpu == null ? 0.5 : cpu, playing); }

// 1. paused for a minute: nothing; then 10 s of playing at 60 Hz with one 40 ms and one 120 ms interval
const A = make();
run(A, 60, 16.7, false);
check('paused: nothing collected or written', A.lines.length === 0, String(A.lines.length));
A.log.frame(40, 1.5, true); A.log.frame(120, 2.5, true);
run(A, 10, 16.7, true);
check('one line at 10 s of playing', A.lines.length === 1, String(A.lines.length));
const first = A.lines[0] || '';
const SHAPE = /^playback frames 1\/20 \(10 s after the start\): 10\.0 s played, \d+ frames; interval median 16\.7 \/ p95 16\.7 \/ worst 120\.0 ms, over 33 ms 2, over 100 ms 1; page CPU per frame \(step \+ render\) median 0\.50 \/ p95 0\.50 \/ worst 2\.50 ms; canvas 1920x1080 dpr 1\.25 \(drawn at 1\.25\); playing x1, camera follow; WebGL contexts 0, canvases 3; shot view opened no; shadows sharp 2048, sky on, haze on, .*\(no wind setting\); map 02_malinovka$/;
check('the line holds every field: intervals, counts over 33 and 100 ms, CPU, canvas, dpr, speed, camera, contexts, shot view, settings, map', SHAPE.test(first), first);
run(A, 29, 16.7, true);
check('no second line before 30 s more', A.lines.length === 1, String(A.lines.length));
run(A, 120, 16.7, false);
check('a pause holds the clock: no line while paused', A.lines.length === 1, String(A.lines.length));
run(A, 1.5, 16.7, true);
check('the next line at 30 s more of playing, its window only its own frames', A.lines.length === 2 && /^playback frames 2\/20 \(every 30 s\): 30\.\d s played, .*worst 16\.7 ms, over 33 ms 0, over 100 ms 0;/.test(A.lines[1]), A.lines[1]);

// 2. a stall: a line at once; a second one within 10 s waits for the periodic line (its worst kept)
const B = make();
run(B, 2, 16.7, true);
B.log.frame(400, 3, true);
check('an interval over 250 ms writes at once', B.lines.length === 1 && /\(an interval over 250 ms\): .*worst 400\.0 ms, over 33 ms 1, over 100 ms 1;/.test(B.lines[0]), B.lines[0]);
run(B, 3, 16.7, true); B.log.frame(300, 3, true);
check('a second stall within 10 s does not write', B.lines.length === 1, String(B.lines.length));
run(B, 6, 16.7, true);
check('it shows in the next line\'s worst (10 s after the start)', B.lines.length === 2 && /\(10 s after the start\): .*worst 300\.0 ms/.test(B.lines[1]), B.lines[1]);

// 3. at most 20 lines a page load
const C = make();
for (let i = 0; i < 40; i++) { run(C, 11, 16.7, true); C.log.frame(500, 1, true); }
check('at most 20 lines', C.lines.length === 20 && C.log.sent() === 20, String(C.lines.length));

// 4. WebGL contexts: once per canvas, 2d not counted
const c1 = new Canvas(), c2 = new Canvas();
c1.getContext('webgl2'); c1.getContext('webgl2'); c2.getContext('2d'); new Canvas().getContext('webgl');
check('WebGL contexts counted once per canvas, 2d not', FL.contexts() === 2, String(FL.contexts()));

console.log('line: Page input: ' + first);
console.log(failed ? failed + ' of ' + checks + ' checks FAILED' : checks + ' checks passed');
process.exit(failed ? 1 : 0);
