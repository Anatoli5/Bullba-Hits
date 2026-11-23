// The replay viewer draws its scene only when something changed (23.11.2026, the plan of
// outputs/stutter-audit-2026-11-23.md, candidate 6: the scene was drawn on every animation frame, paused and still too).
// web/playback/playback.js needsRender, cut out by name: a paused, still scene with no input is not drawn (but for the
// redraw at most 1 s after the last one); playing, a moved camera, the clock moved, an input or a setting, a shadow map
// redrawn or something alive on the wall clock draws the frame.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'playback', 'playback.js'), 'utf8');
function cut(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'playback.js has function ' + name);
  let d = 0, i = SRC.indexOf('{', at);
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
  return SRC.slice(at, i + 1);
}
const box = {};
vm.runInNewContext(cut('needsRender') + '\nthis.needsRender = needsRender;', box);
const still = { asked: false, playing: false, live: false, camMoved: false, timeMoved: false, shadows: false, idleMs: 16 };
let checks = 0;
function ok(cond, what) { assert.ok(cond, what); checks++; }

// a paused, still scene: one minute of frames at 60 fps draws only the once-a-second redraw
let drawn = 0, last = 0;
for (let f = 1; f <= 3600; f++) {
  const now = f * 1000 / 60;
  if (box.needsRender(Object.assign({}, still, { idleMs: now - last }))) { drawn++; last = now; }
}
ok(drawn <= 60, 'paused and still: at most one frame a second drawn (' + drawn + ' of 3600)');
ok(!box.needsRender(still), 'paused and still, drawn 16 ms ago: not drawn');
// each reason alone draws the frame
['asked', 'playing', 'live', 'camMoved', 'timeMoved', 'shadows'].forEach((k) => ok(box.needsRender(Object.assign({}, still, { [k]: true })), k + ' alone draws the frame'));
ok(box.needsRender(Object.assign({}, still, { idleMs: 1000 })), 'a redraw 1 s after the last one');
ok(box.needsRender(Object.assign({}, still, { idleMs: Infinity })), 'never drawn yet: drawn');
// playing: every frame
let play = 0;
for (let f = 0; f < 600; f++) if (box.needsRender(Object.assign({}, still, { playing: true, timeMoved: true }))) play++;
ok(play === 600, 'playing: every frame drawn');
process.stdout.write('test_render_on_demand: ok (' + checks + ' checks)\n');
