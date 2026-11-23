// A greyed team row's words (23.11.2026, NOTEBOOK Z15: the user saw an ally greyed in the replay viewer's list and did not
// know why; a click sent the camera to an empty place). The row is greyed while the replay has no position of the vehicle;
// its mark's words (playback.js outWhy) and the camera's "last seen" place (playback.js followPoint) both come from
// PlaybackBattle.sightAt(v, t): {seen, last: the end of the last sight interval that ended by t, next: the start of the
// first one after t}. Checked here on a vehicle spotted twice: before, inside, between, after, at the edges, and with no
// sight at all.
'use strict';
const path = require('path'), assert = require('assert');
const PB = require(path.join(__dirname, '..', 'web', 'playback', 'battle.js'));

const v = {sight: [[30, 50], [80, 95]]};
const at = (t) => PB.sightAt(v, t);
assert.deepStrictEqual(at(10), {seen: false, last: null, next: 30}, 'not seen yet: first seen at 30');
assert.deepStrictEqual(at(30), {seen: true, last: null, next: 80}, 'an interval starts seen');
assert.deepStrictEqual(at(49.9).seen, true, 'inside the first interval');
assert.deepStrictEqual(at(50), {seen: false, last: 50, next: 80}, 'an interval ends unseen: last seen at its end');
assert.deepStrictEqual(at(60), {seen: false, last: 50, next: 80}, 'between the two: last 50, next 80');
assert.deepStrictEqual(at(90), {seen: true, last: 50, next: null}, 'inside the second');
assert.deepStrictEqual(at(200), {seen: false, last: 95, next: null}, 'after both: last seen at 95, not again');
// the intervals in any order (the recorder writes them in time order; nothing here relies on it)
assert.deepStrictEqual(PB.sightAt({sight: [[80, 95], [30, 50]]}, 60), {seen: false, last: 50, next: 80}, 'order does not matter');
assert.deepStrictEqual(PB.sightAt({sight: []}, 60), {seen: false, last: null, next: null}, 'never seen');
assert.deepStrictEqual(PB.sightAt({}, 60), {seen: false, last: null, next: null}, 'no sight list');
process.stdout.write('test_team_list_sight: ok\n');
