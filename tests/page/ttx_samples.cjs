// Runs web/ttx.js over the characteristics files the mod writes (default: the IS-7 of the offline run; BULLBA_TTX_DIR=<folder> for others): the stock of every pair, and the IS-7 against ttx-formulas section 10.
'use strict';
const HERE = require('node:path').resolve(__dirname).replace(/\\/g, '/') + '/';   // tests/page/: the repository's web/ and mod/ are ../../, the local fixtures ../fixtures-local/
const fs = require('fs');
const WEB = process.env.BULLBA_WEB || HERE + '../../web/';
const DIR = process.env.BULLBA_TTX_DIR || HERE + '../fixtures-local/ttx-offline/out/mod/ttx/';
global.window = globalThis;
require(WEB + 'ballistics.js');
require(WEB + 'ttx.js');
const T = window.BullbaTtx;
const files = {};
window.ArmorInspectorData = {receive: function (p) { files[p[0]] = p[1]; }};
fs.readdirSync(DIR).forEach(function (f) { new Function('ArmorInspectorData', fs.readFileSync(DIR + f, 'utf8'))(window.ArmorInspectorData); });
// The page's own crew law (web/app.js crewFactors), for the crew of the pair's block.
function crewOf(roles) {
  const n = roles.length, common = 0, others = common + (100 + common) / 10, out = {};
  ['commander', 'gunner', 'driver', 'radioman', 'loader'].forEach(function (role) {
    let total = 0, count = 0;
    roles.forEach(function (r) { if (r.indexOf(role) < 0) return; total += (100 + (r[0] === 'commander' ? common : others)) / 100; count++; });
    out[role] = 0.57 + 0.43 * (count ? total / count : (100 + others) / 100);
  });
  out.camouflage = 0.57;
  return out;
}
const A10 = {maxHealth: '2400', vehicleWeight: '68.19', enginePower: '1200', enginePowerPerTon: '17.6', speedLimits: '59.6/15',
  chassisRotationSpeed: '29.2', turretRotationSpeed: '26.07', shotsPerMinute: '4.57', reloadTimeSecs: '13.14',
  avgDamagePerMinute: '2238', aimingTime: '2.78', shotDispersionAngle: '0.38', pitchLimits: '-6/18',
  circularVisionRadius: '400', invisibilityStillFactor: '6.61', invisibilityMovingFactor: '3.31', invisibilityAfterShot: '1.01'};
Object.keys(files).sort().forEach(function (key) {
  const t = files[key];
  t.configs.forEach(function (pair, i) {
    const shells = pair.shells || t.shells[pair.gun] || [];
    const v = T.values({ttx: t, pair: pair, aim: pair.aim, shells: shells, crew: crewOf(pair.aim.crewRoles || [['commander'], ['gunner'], ['driver'], ['radioman'], ['loader']])});
    const d = T.display(v);
    console.log('\n' + key + ' pair ' + i + ' ' + pair.gun + (pair.top ? ' (top)' : '') + ' kind=' + v.kind + ' match=' + T.match(t, {gunName: pair.gun, turretName: t.turrets[pair.turret].name}));
    // Panel v2 (23.09): the reload line - the magazine's rounds | the reload | the time between rounds.
    console.log('  line: ' + T.reloadLine(v, d).map(function (p) { return p.side[0] + ':' + p.key + '=' + p.text; }).join(' '));
    console.log('  ' + ['avgDamagePerMinute', 'shotsPerMinute', 'reloadTimeSecs', 'clipFireRate', 'autoReloadTime', 'shotDispersionAngle', 'aimingTime',
      'stabMovement', 'stabRotation', 'stabTurret', 'stabAfterShot', 'turretRotationSpeed', 'chassisRotationSpeed', 'maxSteeringLockAngle', 'speedLimits',
      'enginePower', 'vehicleWeight', 'enginePowerPerTon', 'maxHealth', 'pitchLimits', 'gunYawLimits', 'maxAmmo', 'circularVisionRadius',
      'invisibilityStillFactor', 'invisibilityMovingFactor', 'invisibilityAfterShot', 'terrainResistance'].map(function (k) { return k + '=' + d[k]; }).join(' '));
    console.log('  shells: ' + v.shells.map(function (s) { return s.kind + ' ' + s.avgDamage + '/' + s.avgPiercingPower + '/' + T.nice(s.shellVelocity); }).join(', '));
    if (key === 'ttx:ussr-R45_IS-7') {
      const bad = Object.keys(A10).filter(function (k) { return d[k] !== A10[k]; });
      console.log('  IS-7 against ttx-formulas section 10: ' + (bad.length ? 'DIFFER ' + bad.map(function (k) { return k + ' ' + d[k] + ' want ' + A10[k]; }).join(', ') : 'all ' + Object.keys(A10).length + ' equal'));
    }
  });
});
