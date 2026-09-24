/* A SYNTHETIC data folder for the real page: every file is written here from made-up values, in the formats the
 * exporter publishes and web/local-data.js reads (classic scripts: ArmorInspectorData.receive([key, value]);).
 * No record, model or name of any player is used: the vehicles are "Papa", "Quebec"..., the models are boxes.
 *
 * The cast is the path matrix of tests/page/aim3_dom.cjs (the stub DOM), so both matrices ask the same questions of
 * the same case - the user's own of 24.09: an Onslaught battle where the enemy's roster row names neither his vehicle
 * nor its health, and ⇅ on an incoming hit puts that enemy on screen (his figure then comes from his characteristics
 * file). Battles: pm (two incoming hits), pm2 (one), pm3 (one outgoing on a target whose only figure is in his file).
 * The outgoing hit of pm3 is the player's own shot with its tracer and aim snapshot (BACKLOG 28 step 2, 24.09): the two
 * recorded outlines and the shot disc, whose server update is one tick stale (its origin 1.5 m from the shell's).
 * Its server stop lies 0.8 m along the hull from the recorded point: the flight is carried onto the point, the pose mark shows.
 *
 *   require('./fixture.cjs').write(folder)   // writes folder/data/**
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const D0 = Math.PI / 180;
const AIM_BLOCK = {
  dispersion: 0.00383, aimingTime: 2.0, turretRotationFactor: 0.09 / D0, afterShotFactor: 4.0,
  movementFactor: 0.19 / 0.27778, rotationFactor: 0.19 / D0, turretRotationSpeed: 30 * D0, hullRotationSpeed: 24 * D0,
  speedForward: 50 * 0.27778, speedBackward: 20 * 0.27778, multFactor: 1, additiveFactor: 1, aimingTimeFactor: 1,
  reloadTime: 10, reloadTimeFactor: 1, clip: [1, 0]
};
const SHELL = function (kind, name, pen, alpha, extra) {
  return Object.assign({kind: kind, name: name, caliber: 105, penetration100: pen, penetration500: pen - 20, alpha: alpha,
    randomization: 0.25, randomizationType: 'NORMAL', damageRandomization: 0.25, normalization: kind === 'ARMOR_PIERCING_CR' ? 2 * D0 : 5 * D0,
    ricochetCos: Math.cos(70 * D0), speed: 900, gravity: 9.81, maxDistance: 720, effectsIndex: kind === 'ARMOR_PIERCING' ? 11 : 12,
    gunInstallation: 0, gun: '105 mm single', mechanics: 'LEGACY', source: 'synthetic'}, extra || {});
};
const SHELLS = [SHELL('ARMOR_PIERCING', 'AP shell', 250, 400), SHELL('ARMOR_PIERCING_CR', 'APCR shell', 300, 400)];

// A material of the armour table: the flags the ballistics read, a made-up thickness.
const MATERIAL = function (mm) {
  return {armor: mm, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, collideOnceOnly: false,
    checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true, useArmorHomogenization: true, chanceToHitByProjectile: 1};
};
// An axis-aligned box as one armour group: 8 corners, 12 triangles, outward winding.
function box(min, max, material) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {material: material, vertices: v, indices: f};
}
const translate = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
// One set of four part models per vehicle size, shared by every vehicle of that size (as the exporter shares by hash).
function partSet(scale) {
  const s = scale;
  return [
    {id: 0, name: 'chassis', groups: [box([-1.7 * s, 0, -3.2 * s], [-1.1 * s, 0.9, 3.2 * s], 'leftTrack'), box([1.1 * s, 0, -3.2 * s], [1.7 * s, 0.9, 3.2 * s], 'rightTrack')],
     armor: {leftTrack: MATERIAL(20), rightTrack: MATERIAL(20)}, transform: translate(0, 0, 0)},
    {id: 1, name: 'hull', groups: [box([-1.4 * s, 0.4, -3.0 * s], [1.4 * s, 1.7, 3.0 * s], 'armor_1')], armor: {armor_1: MATERIAL(120)}, transform: translate(0, 0, 0)},
    {id: 2, name: 'turret', groups: [box([-1.1 * s, 0, -1.3 * s], [1.1 * s, 0.9, 1.3 * s], 'armor_2')], armor: {armor_2: MATERIAL(200)}, transform: translate(0, 1.7, -0.2)},
    {id: 3, name: 'gun', groups: [box([-0.1, -0.1, 0], [0.1, 0.1, 4.0 * s], 'armor_3')], armor: {armor_3: MATERIAL(50)}, transform: translate(0, 2.15, 1.0)}
  ];
}

function payload(key, value) {
  // The exporter's escaping: no '<' and no raw line separators in a classic script.
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const json = JSON.stringify([key, value]).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  return 'ArmorInspectorData.receive(' + json + ');\n';
}

function write(folder) {
  const data = path.join(folder, 'data');
  ['battles', 'models', 'vehicles', 'ttx'].forEach(function (d) { fs.mkdirSync(path.join(data, d), {recursive: true}); });
  const put = function (file, key, value) { fs.writeFileSync(path.join(data, file), payload(key, value), 'ascii'); };

  // Models: one file per part geometry, named by the hash of its content.
  const sets = {};
  function parts(scale) {
    if (!sets[scale]) {
      sets[scale] = partSet(scale).map(function (p) {
        const model = {kind: 'client-shot-collision', resource: 'vehicles/synthetic/collision_client/' + p.name + '_' + scale + '.model', groups: p.groups};
        const key = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
        model.sha256 = key;
        put('models/' + key + '.js', 'model:' + key, model);
        return {id: p.id, name: p.name, modelKey: key, resource: model.resource, transform: p.transform, armor: p.armor, armorSource: 'synthetic'};
      });
    }
    return JSON.parse(JSON.stringify(sets[scale]));
  }
  const VEHICLES = {30: {name: 'Papa', type: 'germany:Papa', scale: 1}, 31: {name: 'Romeo', type: 'germany:Romeo', scale: 1.15},
                    32: {name: 'Quebec', type: 'germany:Quebec', scale: 0.9}, 33: {name: 'Sierra', type: 'germany:Sierra', scale: 0.8},
                    34: {name: 'Tango', type: 'germany:Tango', scale: 1.05}};
  const side = function (id, withAim) {
    const v = VEHICLES[id];
    const out = {name: v.name, type: v.type, nation: 'germany', level: 10, 'class': 'heavyTank', role: 'role_HT_break',
      gun: '105 mm single', gunName: '_105_single', gunDispersion: 0.00383, gunHeight: 2.15, gunHeightFrom: 'synthetic',
      parts: parts(v.scale), worldTransform: translate(0, 0, 0)};
    if (withAim) out.aim = AIM_BLOCK;
    return out;
  };
  const HIT = function (id, attackerId, targetId, direction, receivedAt) {
    return {schema: 1, type: 'hit', id: id, attackerId: attackerId, targetId: targetId, direction: direction, damage: 0, damageFactor: 1,
      receivedAt: receivedAt, gameTime: 100, effectsIndex: 11, gunInstallationIndex: 0, shellVelocity: 900, rangeAtImpact: 120,
      attackerPositionAtImpact: [0, 2.1, 120],
      points: [{status: 'resolved', part: 1, effect: 3, hitType: 0, shellType: 2, shellKind: 'ARMOR_PIERCING', caliber: 105,
        start: [0, 1.1, 5], end: [0, 1.1, -5], position: [0, 1.1, 3.0], direction: [0, 0, -1], normal: [0, 0, 1]}],
      shellCandidates: [SHELLS[0]], availableShells: SHELLS, shellStatus: 'matched',
      attacker: side(attackerId, true), target: side(targetId, false), warnings: []};
  };
  const ROSTER = [{id: 30, name: 'Papa', type: 'germany:Papa', team: 2, player: 'me', maxHealth: 2750, defaultMaxHealth: 2100},
    {id: 31, player: 'enemy', team: 1},   // Onslaught: the enemy's row names neither his vehicle nor its figure
    {id: 32, name: 'Quebec', type: 'germany:Quebec', team: 2, player: 'ally', maxHealth: 1500, defaultMaxHealth: 1500},
    {id: 33, name: 'Sierra', type: 'germany:Sierra', team: 2, player: 'idle', maxHealth: 1000, defaultMaxHealth: 1000},
    {id: 34, player: 'enemy2', team: 1}];
  const T0 = 1790000000;
  const BATTLE = function (id, map, startedAt, hits) {
    return {schema: 1, type: 'battle', id: id, source: 'live', map: map, startedAt: startedAt, clientVersion: 'synthetic',
      recorderVersion: 'synthetic', playerVehicleId: 30, playerTeam: 2, roster: ROSTER, shotEvents: [], critEvents: [], warnings: [], hits: hits};
  };
  const pm3hit = HIT('pm3-1', 30, 34, 'outgoing', T0 + 7250);
  // The own shot of pm3: muzzle 117 m out, the shell straight at the contact point; the server's aim 0.2 m right and
  // 0.1 m up of it at the target, its origin a tick behind the shell's.
  const I = [0, 1.1, 3.0], O = [0.3, 2.1, 120], len = Math.hypot(I[0] - O[0], I[1] - O[1], I[2] - O[2]);
  const toward = function (p) { const d = [p[0] - O[0], p[1] - O[1], p[2] - O[2]], l = Math.hypot(d[0], d[1], d[2]); return d.map(function (x) { return x / l; }); };
  const marker = function (t) { return {position: [0.1, 1.2, 3.0], direction: toward([0.1, 1.2, 3.0]), diameter: 0.9, receivedAt: t}; };
  const pm3shots = [
    {schema: 1, type: 'shot', event: 'tracer', id: 's1', shooterId: 30, shotId: '501', isRicochet: false, effectsIndex: 11, shellTypeIdx: 2,
     caliber: 105, origin: O, velocity: toward(I).map(function (x) { return x * 900; }), gravity: 9.81, maxDistance: 720, gunIndex: 0,
     gunInstallationIndex: 0, own: true, source: 'synthetic', receivedAt: T0 + 7249.8, gameTime: 99.8,
     aimAtTracer: {source: 'synthetic', clientMarker: marker(T0 + 7249.7), serverMarker: marker(T0 + 7249.7),
       lastServerGunUpdate: {vehicleId: 30, origin: [O[0] + 1.5, O[1], O[2]], vector: toward([0.2, 1.2, 3.0]), dispersionAngle: 0.004,
         receivedAt: T0 + 7249.72, gameTime: 99.7}}},
    // The server's stop 0.8 m along the hull from the recorded point (shot-line-true, 24.09): the game drew the target
    // 0.8 m off the pose the server hit - the page moves the flight onto the point and shows the pose mark.
    {schema: 1, type: 'shot', event: 'stop', id: 's2', shotId: '501', tracerId: 's1', shooterId: 30, own: true, position: [I[0], I[1], I[2] + 0.8],
     segmentDistance: len, receivedAt: T0 + 7249.98, gameTime: 99.98}];
  const battles = [BATTLE('pm', 'Synthetic field', T0 + 7200, [HIT('pm-1', 31, 30, 'incoming', T0 + 7260), HIT('pm-2', 32, 30, 'incoming', T0 + 7270)]),
                   BATTLE('pm2', 'Synthetic hills', T0 + 3600, [HIT('pm2-1', 32, 30, 'incoming', T0 + 3660)]),
                   Object.assign(BATTLE('pm3', 'Synthetic coast', T0, [pm3hit]), {shotEvents: pm3shots})];
  battles.forEach(function (b) { put('battles/' + b.id + '.js', 'battle:' + b.id, b); });
  put('index.js', 'index', {application: 'local.armor_inspector', version: 'synthetic', updatedAt: T0 + 9000,
    battles: battles.map(function (b) {
      return {id: b.id, map: b.map, startedAt: b.startedAt, hits: b.hits.length,
              vehicle: {name: 'Papa', type: 'germany:Papa', level: 10, 'class': 'heavyTank', nation: 'germany', role: 'role_HT_break'}};
    })});

  // Characteristics files: each type's stock health (Romeo's is the one the swapped enemy gets; Tango's is read only
  // for the vehicle on screen - he never is a shooter).
  const TTX = function (type, hp) {
    const aim = Object.assign({}, AIM_BLOCK, {afterShotFactor: 0, reloadTime: 7, clip: [1, 0]});
    return {schema: 1, id: type.replace(':', '-'), type: type, clientVersion: 'synthetic', warnings: [],
      vehicle: {invisibility: [0.1, 0.2], camouflageBonus: 0.03, projectileSpeedFactor: 0.8, modes: {}},
      modules: {chassis: {terrainResistance: [1, 1.2, 2]}, engine: {power: 600 * 735.5}},
      turrets: [{name: 'TurretX', userString: 'Turret X', level: 8, circularVisionRadius: 380, invisibilityFactor: 1}],
      shells: {_105_single: SHELLS},
      configs: [{turret: 0, gun: '_105_single', gunUserString: '105 mm single', gunLevel: 8, top: true, aim: aim, maxHealth: hp, weight: 40000,
                 pitch: {absolute: [-0.35, 0.14]}, invisibilityFactorAtShot: 0.2}]};
  };
  [['germany:Papa', 2100], ['germany:Romeo', 1950], ['germany:Quebec', 1400], ['germany:Tango', 1234]].forEach(function (t) {
    const id = t[0].replace(':', '-');
    put('ttx/' + id + '.js', 'ttx:' + id, TTX(t[0], t[1]));
  });

  // The vehicle browser: a catalogue and three exported vehicles, each carrying its own health figure.
  const EXPORT = function (id, type, name, hp, scale) {
    return {id: id, type: type, name: name, level: 10, 'class': 'heavyTank', nation: 'germany', role: 'role_HT_break', exportedAt: T0,
      clientVersion: 'synthetic', source: 'synthetic', parts: parts(scale), shells: SHELLS, warnings: [], gun: '105 mm single', gunName: '_105_single',
      gunDispersion: 0.00383, gunHeight: 2.15, aim: AIM_BLOCK, maxHealth: hp,
      tags: ['germany', 'heavyTank', 'tankRammer_class1_user', 'aimingStabilizer_class1_user', 'improvedVentilation_class1_user']};
  };
  const exports_ = [EXPORT('test_vehicle', 'germany:Test', 'Test vehicle', 2000, 1), EXPORT('pm_papa', 'germany:Papa', 'Papa', 2200, 1),
                    EXPORT('pm_quebec', 'germany:Quebec', 'Quebec', 1600, 0.9)];
  exports_.forEach(function (e) { put('vehicles/' + e.id + '.js', 'vehicle:' + e.id, e); });
  put('vehicles.js', 'vehicles', {application: 'local.armor_inspector', clientVersion: 'synthetic', updatedAt: T0,
    vehicles: exports_.map(function (e) {
      return {id: e.id, type: e.type, name: e.name, level: 10, 'class': 'heavyTank', nation: 'germany', role: e.role, premium: false,
              special: false, collector: false, exported: true, exportedAt: T0, source: 'synthetic'};
    })});
  return data;
}

module.exports = {write: write};
