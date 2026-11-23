// NOTEBOOK Y19 (22.11): a ricochet's camera must end at the armour. Measured on tests/fixtures-local/playback-2026-11-18
// (both ricochets of that battle): the server's ricochet goes on under its shot's own shotID - the shot's stopTracer at
// the contact, then showTracer(isRicochet) from that very point 0.1 s later. The page's decoder (web/playback/battle.js
// Collector) kept tracers by shotID, so the ricochet overwrote the shot: the shot was lost and its hit was linked to the
// shooter's previous shot. Here the decoder's own Collector on the fixture's events (the first ricochet, game axes).
'use strict';
const path = require('path'), assert = require('assert');
const PB = require(path.join(__dirname, '..', 'web', 'playback', 'battle.js'));
const c = new PB.Collector();
const ID = 117797002, SHOOTER = 540509653, START = [425.46, 65.76, 427.12], CONTACT = [298.53, 56.81, 479.34], AWAY = [10, 50, 700];
function tracer(t, start, ricochet) {
  c.feed({ev: 'method', t: t, entity: 'Avatar', name: 'showTracer', args: {shotID: ID, shooterID: SHOOTER, refStartPoint: start,
    velocity: [-900, 0, 370], gravity: 9.81, isRicochet: ricochet, shellTypeIdx: 0, shellCaliber: 122}});
}
function stop(t, end) { c.feed({ev: 'method', t: t, entity: 'Avatar', name: 'stopTracer', args: {shotID: ID, endPoint: end}}); }
tracer(159.725, START, false);
stop(159.725, CONTACT);
tracer(159.825, CONTACT, true);
stop(160.2, AWAY);
const keys = [...c.tracers.keys()];
assert.deepStrictEqual(keys.map(String), [String(ID), ID + 'r1'], 'the shot and its ricochet are two tracers: ' + JSON.stringify(keys));
assert.deepStrictEqual(c.tracers.get(ID)[2], START, 'the shot keeps its start at the gun');
assert.strictEqual(c.tracers.get(ID)[5], 0, 'the shot is no ricochet');
assert.deepStrictEqual(c.ends.get(ID)[1], CONTACT, 'the shot ends at the armour contact (the camera stops there)');
assert.deepStrictEqual(c.ends.get(ID + 'r1')[1], AWAY, 'the ricochet keeps its own end');
// an end that comes after the ricochet started still goes to the shot first
const d = new PB.Collector();
d.feed({ev: 'method', t: 1, entity: 'Avatar', name: 'showTracer', args: {shotID: 5, shooterID: 1, refStartPoint: [0, 0, 0], velocity: [1, 0, 0], gravity: 9.81, isRicochet: false}});
d.feed({ev: 'method', t: 1.1, entity: 'Avatar', name: 'showTracer', args: {shotID: 5, shooterID: 1, refStartPoint: [9, 0, 0], velocity: [0, 1, 0], gravity: 9.81, isRicochet: true}});
d.feed({ev: 'method', t: 1.1, entity: 'Avatar', name: 'stopTracer', args: {shotID: 5, endPoint: [9, 0, 0]}});
assert.deepStrictEqual(d.ends.get(5)[1], [9, 0, 0], 'a late shot end is the shot\'s, not the ricochet\'s');
assert.strictEqual(d.ends.has('5r1'), false);
assert.ok(PB.FORMAT >= 8, 'kept battles are decoded again (FORMAT 8)');
process.stdout.write('test_playback_ricochet: ok\n');
