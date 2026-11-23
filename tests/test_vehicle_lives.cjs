// One object per vehicle in the replay viewer (BACKLOG 128, 22.11.2026; the user after 1.28: his own vehicle was lost at the
// battle's start because each vehicle existed in up to six copied forms and the start view compared one copy with
// another). web/playback/battle.js is the one place that says which vehicle an id was at a moment: the battle keeps ONE
// vehicle per id with its recorded descriptor rows, PlaybackBattle.lives(v) reads them into spans (a configuration of a
// life), lifeAt(v, t) gives the span standing at t and trackOf(v, span) its life's track as views, never copies.
// Here a synthetic respawn battle through battle.js' own Vehicles (the descriptor events a replay carries): the own id
// dies at 100 s, comes back at 120 s as another vehicle, and is upgraded within that life at 200 s (Steel Hunter's way).
'use strict';
const path = require('path'), assert = require('assert');
const PB = require(path.join(__dirname, '..', 'web', 'playback', 'battle.js'));

const NAMES = {'0,5': 'ussr:A', '0,6': 'ussr:B', '0,7': 'ussr:C'};
const cd = (tid, extra) => new Uint8Array([0x01, tid].concat(extra || []));
const info = (tid, hp, extra) => ({compDescr: cd(tid, extra), maxHealth: hp, team: 1});
const OWN = 1, OTHER = 2;
const vs = new PB.Vehicles([{id: OWN, type: 'ussr:A', team: 1, maxHealth: 1000}, {id: OTHER, type: 'ussr:C', team: 2, maxHealth: 700}], NAMES);
const ev = (o) => vs.feed(Object.assign({entity: 'Vehicle'}, o));
ev({ev: 'entity_create', id: OWN, t: 0, props: {publicInfo: info(5, 1000)}});
ev({ev: 'entity_create', id: OTHER, t: 0, props: {publicInfo: info(7, 700)}});
ev({ev: 'property', name: 'health', id: OWN, t: 100, value: 0});
ev({ev: 'entity_create', id: OWN, t: 120, props: {publicInfo: info(6, 2000)}});
ev({ev: 'property', name: 'publicInfo', id: OWN, t: 200, value: info(6, 2400, [9, 9])});

// the battle's vehicles as build() makes them: one per id, each with its track (7 floats a row) and HP (2 a row)
function track(times) {
  const pos = new Float32Array(times.length * 7), hp = new Float32Array(times.length * 2);
  times.forEach((t, i) => { pos[i * 7] = t; pos[i * 7 + 1] = t; hp[i * 2] = t; hp[i * 2 + 1] = t < 100 ? 1000 - t : t < 120 ? 0 : 2000; });
  return {pos: pos, np: times.length, gun: new Float32Array(0), ng: 0, hp: hp, nh: times.length};
}
const times = []; for (let t = 0; t <= 300; t += 10) times.push(t);
const vehicles = vs.summary().map((v) => Object.assign({id: v.id, type: v.type, configs: v.configs, maxHealth: v.maxHealth, own: v.id === OWN}, track(times)));

// one vehicle object per id
assert.deepStrictEqual(vehicles.map((v) => v.id), [OWN, OTHER], 'one battle vehicle per id');
const own = vehicles[0], other = vehicles[1];

// its lives, read once (the same array and the same span objects on every call)
const L = PB.lives(own);
assert.strictEqual(PB.lives(own), L, 'lives are derived once per vehicle');
assert.deepStrictEqual(L.map((s) => [s.life, s.type, s.from, s.until, s.lifeFrom, s.lifeUntil]),
  [[0, 'ussr:A', 0, 120, 0, 120], [1, 'ussr:B', 120, 200, 120, Infinity], [1, 'ussr:B', 200, Infinity, 120, Infinity]], JSON.stringify(L));
assert.strictEqual(L[1].newLife, true, 'the respawn starts a new life');
assert.strictEqual(L[2].newLife, false, 'the upgrade stays in its life');
assert.notStrictEqual(L[2].key, L[1].key, 'the upgrade is another configuration (model key) of the same life');
assert.strictEqual(L[2].maxHealth, 2400);

// the own vehicle at the battle's start: its first life, found by id and time
assert.strictEqual(PB.lifeAt(own, 0), L[0], 'own vehicle found at the battle start');
assert.strictEqual(PB.lifeAt(own, 99.5).type, 'ussr:A');
assert.strictEqual(PB.lifeAt(own, -5), null, 'nothing before its first descriptor');
// the configuration switch at its time (the same 1e-6 window as before: from - 1e-6 <= t < until - 1e-6)
assert.strictEqual(PB.lifeAt(own, 119.99), L[0]);
assert.strictEqual(PB.lifeAt(own, 120), L[1], 'the respawn at its moment');
assert.strictEqual(PB.lifeAt(own, 199.9), L[1]);
assert.strictEqual(PB.lifeAt(own, 200), L[2], 'the upgrade at its moment');
assert.strictEqual(PB.lifeAt(own, 1e6), L[2]);
assert.strictEqual(PB.lifeAt(own, 150), PB.lifeAt(own, 150), 'a caller compares spans by identity');

// an id that never changes: one life over the battle
assert.strictEqual(PB.lives(other).length, 1);
assert.strictEqual(PB.lifeAt(other, 250).type, 'ussr:C');
// an older battle with no descriptor rows: one span over all time, its own type
const legacy = {id: 9, type: 'ussr:A', compDescr: 'AQU=', configs: []};
assert.deepStrictEqual([PB.lifeAt(legacy, -1e9).type, PB.lifeAt(legacy, 1e9).from], ['ussr:A', -Infinity]);

// trackOf: the life's samples as views into the vehicle's own arrays (no copies); the upgrade does not cut the track
const k0 = PB.trackOf(own, L[0]), k2 = PB.trackOf(own, L[2]), k2own = PB.trackOf(own, L[2], true);
assert.strictEqual(k0.pos.buffer, own.pos.buffer, 'a view, not a copy');
assert.deepStrictEqual([k0.np, k0.pos[0], k0.pos[(k0.np - 1) * 7]], [12, 0, 110], 'life 0: 0..110 s');
assert.deepStrictEqual([k2.np, k2.pos[0], k2.hp[1]], [19, 120, 2000], 'life 1 from the respawn, its HP its own');
assert.deepStrictEqual([k2own.np, k2own.pos[0]], [11, 200], 'the span alone: from the upgrade');

// the worker's own users (effects: a hit's configuration) go through the same lookup
assert.strictEqual(typeof PB.configurationAt, 'undefined', 'no second lookup of a configuration');
process.stdout.write('test_vehicle_lives: ok\n');
