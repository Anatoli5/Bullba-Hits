// Synthetic check of the gun-state path of web/shot-context.js (no browser, no records touched).
require((process.env.BULLBA_WEB || require('node:path').resolve(__dirname, '../../web') + '/') + 'shot-context.js');
const C = globalThis.ArmorShotContext;
let fail = 0;
function ok(name, cond, extra) { console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' (' + extra + ')' : '')); if (!cond) fail++; }

const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const ap = {kind: 'ARMOR_PIERCING', name: 'AP', caliber: 100, penetration100: 190, penetration500: 160, speed: 900, gravity: 9.81, alpha: 300, damageRandomization: .25};
function hitOf(extra, shells) {
  const list = shells || [ap];
  return Object.assign({attackerId: 7, targetId: 9, effectsIndex: 3, damage: 200, receivedAt: 100,
    availableShells: [list[0]], shellCandidates: list,
    points: [{part: 0, status: 'resolved', shellType: 2, caliber: 100, position: [0, 0, 0]}],
    target: {worldTransform: I, parts: [{id: 0, transform: I}]}}, extra);
}
function shot(gunState, velocity, effectsIndex) {
  const t = {event: 'tracer', id: 't1', shooterId: 7, effectsIndex: effectsIndex === undefined ? 3 : effectsIndex,
    receivedAt: 100, isRicochet: false, gunInstallationIndex: 0, own: true, origin: [0, 0, 0],
    velocity: velocity || [900, 0, 0], gravity: 9.81};
  if (gunState) t.gunState = gunState;
  return [t, {event: 'stop', tracerId: 't1', shooterId: 7, position: [0, 0, 0], receivedAt: 100}];
}

// 1. no state at all -> exactly what it was
let r = C.resolve(hitOf({}), shot(null));
ok('no gun state: no notes, no factor, alpha untouched', r.gunNotes.length === 0 && r.chargeFactor === null && r.choices[0].alpha === 300 && r.index === 0, 'index=' + r.index);

// 2. charge level 2 of Object 432U -> x1.177 on the alpha of every choice, and one tooltip line
r = C.resolve(hitOf({}), shot({chargeShot: {publicState: {flags: 0, level: 2}}}));
ok('chargeShot level 2: alpha 300 -> 353', r.choices[0].alpha === Math.round(300 * 1.177), 'alpha=' + r.choices[0].alpha);
ok('chargeShot level 2: factor and note', r.chargeFactor === 1.177 && r.gunNotes[0] === 'Charge level 3 of 4: ×1.177 alpha', r.gunNotes.join(' | '));
ok('chargeShot: the record array itself is not touched', ap.alpha === 300);

// 3. level 0 changes nothing but still says so
r = C.resolve(hitOf({}), shot({chargeShot: {publicState: {flags: 0, level: 0}}}));
ok('chargeShot level 0: alpha unchanged, note still printed', r.choices[0].alpha === 300 && r.chargeFactor === null && r.gunNotes[0] === 'Charge level 1 of 4: ×1 alpha', r.gunNotes.join(' | '));

// 4. the impact fallback is named as such
r = C.resolve(hitOf({attacker: {gunStateAtImpact: {chargeShot: {publicState: {flags: 0, level: 3}}}}}), shot(null));
ok('gunStateAtImpact is the fallback and says so', r.gunStateFrom === 'impact' && /state at the impact/.test(r.gunNotes[0]), r.gunNotes.join(' | '));

// 5. the Gorilla: the low-charge state names the second descriptor where the ballistics cannot
//    (both sets given the same speed on purpose, and a damage both bands can reach)
const full = {kind: 'ARMOR_PIERCING', name: 'AP', caliber: 152, penetration100: 305, penetration500: 295, speed: 900, gravity: 9.81, alpha: 800, effectsIndex: 42, damageRandomization: .25};
const low = {kind: 'ARMOR_PIERCING', name: 'AP', caliber: 152, penetration100: 255, penetration500: 245, speed: 900, gravity: 9.81, alpha: 390, effectsIndex: 42, damageRandomization: .25};
function gorilla(gunState) {
  return C.resolve({attackerId: 7, targetId: 9, effectsIndex: 42, damage: 300, receivedAt: 100,
    availableShells: [full], shellCandidates: [full],
    points: [{part: 0, status: 'resolved', shellType: 2, caliber: 152, position: [0, 0, 0]}],
    target: {worldTransform: I, parts: [{id: 0, transform: I}]},
    attacker: {vehicleMode: 0, modeShells: [low], modeShellsMode: 1, aim: {gunMechanics: ['lowChargeShot']}}},
    shot(gunState, [900, 0, 0], 42));
}
r = gorilla({lowChargeShot: {privateState: {reloadingState: 2}}});
ok('Gorilla: the recorded low charge names the low-charge shell', r.index >= 0 && r.choices[r.index].alpha === 390,
   'alpha=' + ((r.choices[r.index] || {}).alpha) + ' · ' + r.source);
ok('Gorilla: the note says low charge', r.gunNotes.indexOf('Low charge shot') >= 0, r.gunNotes.join(' | '));
r = gorilla({lowChargeShot: {publicState: {visualState: 4}}});
ok('Gorilla: a full charge names the full shell', r.index >= 0 && r.choices[r.index].alpha === 800, 'alpha=' + ((r.choices[r.index] || {}).alpha));
r = gorilla(null);
ok('Gorilla: no state -> still undetermined, as before', r.index < 0, 'index=' + r.index);

// 6. the switcher's flag is read only after the siege state has had its say
const sd = {kind: 'ARMOR_PIERCING', name: 'AP', caliber: 105, penetration100: 250, penetration500: 220, speed: 1000, gravity: 9.81, alpha: 360, effectsIndex: 9, damageRandomization: .25};
const sg = {kind: 'ARMOR_PIERCING', name: 'AP', caliber: 105, penetration100: 250, penetration500: 220, speed: 1000, gravity: 9.81, alpha: 325, effectsIndex: 9, damageRandomization: .25};
function switcher(gunState, siegeState) {
  const events = shot(gunState, [1000, 0, 0], 9);
  if (siegeState !== undefined) events[0].siegeState = siegeState;
  return C.resolve({attackerId: 7, targetId: 9, effectsIndex: 9, damage: 200, receivedAt: 100,
    availableShells: [sd], shellCandidates: [sd],
    points: [{part: 0, status: 'resolved', shellType: 2, caliber: 105, position: [0, 0, 0]}],
    target: {worldTransform: I, parts: [{id: 0, transform: I}]},
    attacker: {vehicleMode: 0, modeShells: [sg], modeShellsMode: 1, aim: {gunMechanics: ['shellParamsSwitcher']}}}, events);
}
r = switcher({shellParamsSwitcher: {publicStatus: {isActive: true}}});
ok('switcher: isActive true -> the second set', r.index >= 0 && r.choices[r.index].alpha === 325, 'alpha=' + ((r.choices[r.index] || {}).alpha) + ' · ' + r.source);
r = switcher({shellParamsSwitcher: {publicStatus: {isActive: true}}}, 0);
ok('switcher: the siege state at the shot wins over the unconfirmed flag', r.index >= 0 && r.choices[r.index].alpha === 360 && /recorded state at the shot/.test(r.source), r.source);

// 7. every other mechanic is shown and changes no figure
const notes = C.gunNotes({overheatStacks: {curLevel: 7}, chargeableBurst: {isBurstActive: true},
  propellantAfterburnerGun: {status: {chargeStageID: 1, lastShotCharge: .6}},
  shellParamsSwitcher: {publicStatus: {isActive: true}}, secondaryGun: {gunInstallationIndex: 1},
  bustleFeed: {status: {state: 2}}, shellCalibration: {status: 1}}, 'shot');
ok('other mechanics: one line each, no numbers changed', notes.length === 7, notes.join(' | '));
console.log(fail ? fail + ' FAILURES' : 'all passed');
process.exitCode = fail ? 1 : 0;
