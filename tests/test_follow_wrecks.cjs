// The replay viewer's team-list follow, wrecks and HP after death (23.11.2026, the user in the game on 1.31; diagnosis
// outputs/follow-wrecks-2026-11-23.md). His words decoded: (b) a click on a team row sometimes sends the camera to a
// place with no vehicle, above all for a vehicle not seen or beyond the draw range; (c) a destroyed vehicle's row does
// not take the camera to its wreck; (d) fewer wrecks are drawn than vehicles died; (e) a dead vehicle's HP bar fills up
// again. Checked on two of his battles (tests/fixtures-local/follow-wrecks-2026-11-23, skipped when absent): El Halluf
// 21.11 16:53 (id 8104287255270072) and Highway 21.11 17:37 (id 4242119518723363) - each built by web/playback/battle.js
// from its .wotreplay as the page builds it, then played by the page's own functions cut out of
// web/playback/playback.js by name (poseVehicles, showLife, followPoint, setFollow, followFromList ...) over stubbed
// three.js objects, 10 frames a second.
// What is known of a vehicle's place, independently of the page: its position samples, the place in each of its
// create packets (x = pos[1], y = pos[2], z = dir[0]: measured against the next position sample, 43 of 43 equal on
// Highway) and the arena list's 2D position (AvatarVehiclesInfo.vehiclesInfo[i].position, game metres x, z; about every
// 2 s while spotted beyond the area of interest).
// RED on 1.31 (the defects as he saw them); green once the fix lands.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib'), assert = require('assert');
const WEB = path.join(__dirname, '..', 'web', 'playback');
const FIX = path.join(__dirname, 'fixtures-local', 'follow-wrecks-2026-11-23');
const BATTLES = ['8104287255270072-da8c78fa78ef', '4242119518723363-da8c78fa78ef'];
if (!fs.existsSync(path.join(FIX, BATTLES[0] + '.wotreplay'))) { process.stdout.write('test_follow_wrecks: skipped (no local fixture)\n'); process.exit(0); }
const PB = require(path.join(WEB, 'battle.js')), DEC = require(path.join(WEB, 'decoder.js'));
PB.setInflate((b) => Promise.resolve(new Uint8Array(zlib.inflateSync(b))));
const SRC = fs.readFileSync(path.join(WEB, 'playback.js'), 'utf8');

function data(file) { let out; vm.runInNewContext(fs.readFileSync(file, 'utf8'), { ArmorInspectorData: { receive: (kv) => { out = kv[1]; } } }); return out; }
function cut(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'playback.js has function ' + name);
  let d = 0, i = SRC.indexOf('{', at);
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
  return SRC.slice(at, i + 1);
}
// three.js stand-ins: what poseInto, poseGiven and followPoint touch
function V3() { return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, clone() { return V3().set(this.x, this.y, this.z); }, setFromMatrixPosition() { return this; } }; }
function O3() { return { position: V3(), rotation: { x: 0, y: 0, z: 0, copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; } }, visible: false }; }
const T = { Object3D: function () { return O3(); }, Vector3: function (x, y, z) { return V3().set(x || 0, y || 0, z || 0); },
  Euler: function (x, y, z) { return { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; }, setFromRotationMatrix() {} }; },
  Matrix4: function () { return { fromArray() {} }; } };

// the page over one built battle: buildVehicles' records without the drawing (one part per life with its track)
function page(battle) {
  const box = { PlaybackBattle: PB, T, battle, vehicles: [], fxById: {}, shotView: null, delayOn: true, t: 0, follow: null,
    lastKnown: null, lastObj: O3(), tmpEuler: new T.Euler(0, 0, 0), heldM: new T.Matrix4(), drawMarker() {}, poseHalo() {},
    cam: { tx: 0, ty: 30, tz: 0, yaw: 0.6, pitch: 0.75, dist: 700, tyOff: 1, tyGoal: null }, camGoal: {},
    followSmooth: false, followKey: undefined, followGlide: null, smoothCam: () => true, renderList() {},
    followSrc: null, followAt: null, followSrcShown: undefined, followZoom: false, miniPt: null, heightAt: null, followWarn() {},
    $: () => ({ classList: { toggle() {} } }), Math, Number, Infinity };
  vm.runInNewContext(['search', 'angLerp', 'delayOf', 'poseInto', 'poseGiven', 'showLife', 'poseVehicles', 'followPoint', 'maxHp',
    'camSnap', 'setFollow', 'followFromList', 'rowHp'].map(cut).join('\n'), box);
  battle.vehicles.forEach((v) => {
    const rec = { v, role: v.own ? 'own' : 'other', pos: v.pos, gunT: v.gun, hp: v.hp, parts: [], part: null, lastHp: null, visible: false, dead: false };
    rec.whole = { pos: rec.pos, np: v.np, gun: rec.gunT, ng: v.ng, hp: rec.hp, nh: v.nh };
    ['group', 'turret', 'gun', 'mat', 'md', 'bar', 'canvas', 'tex', 'foot', 'life', 'track'].forEach((k) => Object.defineProperty(rec, k, { get() { return this.part ? this.part[k] : null; } }));
    PB.lives(v).forEach((life) => rec.parts.push({ life, md: { pitch: [0, 1] }, group: O3(), turret: null, gun: null, mat: { userData: { u: { uDead: { value: 0 } } } },
      bar: { visible: true }, tex: {}, track: PB.trackOf(rec.whole, life), rec }));
    rec.part = rec.parts[0] || null; box.vehicles.push(rec); box.fxById[v.id] = rec;
  });
  return box;
}
// the HP a team row shows: playback.js rowHp (renderList's and the marker's one function since the fix)
function rowHp(box, r) { return box.rowHp(r); }

// what the replay knows of each vehicle's place, read apart from the page's path: create packets, the arena list
function knowledge(defs, info, stream) {
  const schema = new DEC.Schema(defs.schema); DEC.setInflate(() => { throw new Error('no inflate'); });
  const V = new PB.Vehicles(info.roster, defs.vehicleNames), creates = [], list = new Map(), alive = new Map(), seen = {};
  new DEC.Decoder(schema, { skip: new Map([[0x36, 0]]) }).decode(stream, (ev) => {
    V.feed(ev);
    if (ev.ev === 'entity_create' && ev.entity === 'Vehicle') creates.push({ t: ev.t, id: ev.id, health: (ev.props || {}).health, p: [ev.pos[1], ev.pos[2], ev.dir[0]] });
    if (ev.component === 'AvatarVehiclesInfo') (V.listed || []).forEach((r) => {
      const p = r.position, k = r.vehicleID, s = JSON.stringify([p && Number(p[0]), p && Number(p[1])]);
      if (seen[k] !== s) { seen[k] = s; if (!list.has(k)) list.set(k, []); list.get(k).push([ev.t, p && Number(p[0]) !== -32768 ? [Number(p[0]), Number(p[1])] : null]); }
      if (!r.isAlive && !alive.has(k)) alive.set(k, ev.t);
    });
  });
  return { creates, list, deadAt: alive };
}
// the latest 3D place known by time x: a position sample or a create packet's place
function placeBy(v, k, x) {
  let best = null;
  for (let i = 0; i < v.np && v.pos[i * 7] <= x; i++) best = { t: v.pos[i * 7], p: [v.pos[i * 7 + 1], v.pos[i * 7 + 2], v.pos[i * 7 + 3]] };
  k.creates.forEach((c) => { if (c.id === v.id && c.t <= x && (!best || c.t > best.t)) best = { t: c.t, p: c.p, create: true }; });
  return best;
}
const dist = (p, q) => Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);

(async () => {
  const defs = data(path.join(FIX, 'defs-56b4b1d7.js')), fails = { d: [], e: [], c: [], bFar: [], bNone: [] };
  for (const id of BATTLES) {
    const info = data(path.join(FIX, id + '.js'));
    const stream = await PB.source('wotreplay', new Uint8Array(fs.readFileSync(path.join(FIX, id + '.wotreplay'))), info.id);
    const b = PB.build(defs, info, stream).battle, k = knowledge(defs, info, stream), box = page(b), end = b.meta.end;
    const name = info.record.mapTitle;
    // a vehicle's recorded death: its first HP of 0 or less (any life)
    const deathOf = (v) => { for (let i = 0; i < v.nh; i++) if (v.hp[i * 2 + 1] <= 0) return v.hp[i * 2]; return null; };
    const hpBad = {}, farBad = {};
    for (let i = 0; i * 0.1 <= end; i++) {
      const t = i * 0.1; box.t = t; box.poseVehicles(t);
      box.vehicles.forEach((r) => {
        // (e) a vehicle dead in the record shows no HP after its death, on every frame
        const td = deathOf(r.v);
        if (td != null && t >= td + 0.2 && !hpBad[r.v.id]) { const hp = rowHp(box, r); if (hp > 0) hpBad[r.v.id] = name + ' ' + r.v.id + ' ' + r.v.type + ': dead at ' + td.toFixed(1) + ' s, its row shows ' + hp + ' HP at ' + t.toFixed(1) + ' s'; }
        // (b) not drawn (beyond the draw range, not seen): the follow has no place - the camera stays, nothing drawn there
        // (the user 23.11: never fly to a minimap or last-seen place)
        if (i % 10 || r.visible) return;
        const p = box.followPoint(r);
        if (p) { const f = farBad[r.v.id] || (farBad[r.v.id] = { n: 0, first: t, d: 0 }); f.n++; }
      });
    }
    Object.values(hpBad).forEach((s) => fails.e.push(s));
    Object.keys(farBad).forEach((vid) => fails.bFar.push(name + ' ' + vid + ': not drawn on ' + farBad[vid].n + ' s, yet the follow has a place (first at ' + farBad[vid].first.toFixed(0) + ' s)'));
    // (d) and (c) at the battle's end: every destroyed vehicle whose wreck's place the replay has is drawn there, and its
    // row's follow goes there
    box.t = end - 0.01; box.poseVehicles(box.t);
    box.vehicles.forEach((r) => {
      const deadAt = k.deadAt.get(r.v.id); if (deadAt == null) return;
      const place = placeBy(r.v, k, box.t), td = deathOf(r.v);
      if (!place || (td == null && place.t < deadAt) || (td != null && place.t < td - 1)) return;   // its wreck's place is not in the replay
      if (!r.visible || dist(r.group.position, place.p) > 5) fails.d.push(name + ' ' + r.v.id + ' ' + r.v.type + ': wreck ' + (r.visible ? 'drawn ' + dist(r.group.position, place.p).toFixed(0) + ' m from its place' : 'not drawn') + ' at the end');
      const f = box.followPoint(r);
      if (!f || dist(f, place.p) > 5) fails.c.push(name + ' ' + r.v.id + ': follow ' + (f ? dist(f, place.p).toFixed(0) + ' m from the wreck' : 'has no place (the camera stays)'));
    });
    // (b) a row whose vehicle's place is not known at all: the click keeps the camera (centre and distance) as it is
    const unknown = box.vehicles.find((r) => !placeBy(r.v, k, 30) && !(k.list.get(r.v.id) || []).some((x) => x[0] <= 30 && x[1]));
    if (unknown) {
      box.t = 30; box.poseVehicles(30); box.follow = null;
      Object.assign(box.cam, { tx: 100, ty: 30, tz: 200, dist: 700 }); box.camSnap();
      box.followFromList(unknown);
      const g = box.camGoal;
      if (g.dist !== 700 || g.tx !== 100 || g.tz !== 200) fails.bNone.push(name + ' ' + unknown.v.id + ' at 30 s (no place known): the camera goal moved to distance ' + g.dist + ' m at the same centre');
    }
  }
  const lines = [];
  for (const [what, list] of Object.entries({ 'd wrecks': fails.d, 'c follow a wreck': fails.c, 'e HP after death': fails.e, 'b follow place for a vehicle not drawn': fails.bFar, 'b no place known': fails.bNone }))
    if (list.length) lines.push('(' + what + ') ' + list.length + ':\n  ' + list.join('\n  '));
  assert.ok(!lines.length, '\n' + lines.join('\n'));
  process.stdout.write('test_follow_wrecks: ok\n');
})().catch((e) => { process.stderr.write(String(e && e.message || e) + '\n'); process.exit(1); });
