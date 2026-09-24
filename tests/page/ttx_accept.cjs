// The acceptance of the characteristics panel (outputs/ttx-panel-spec-2026-09-22.md section 4): the page's strings
// against the client's own (tools/ttx_reference.py: the garage's VehicleParams and formatParameterValue run on a
// real VehicleDescr of the client, stock and the two builds of spec 4.2).
//
// Two sources of the page's strings, one comparison:
//   - the DOM harness (aim3_dom.cjs) drives the page itself - the panel, ⚙, the Config builds - and hands what the
//     panel prints to compare() below;
//   - this file run on its own takes web/ttx.js with the page's own crew law (aimCrewOf and crewFactors cut out of
//     web/app.js) for the stock only:
//       node ttx_accept.cjs <reference json> <folder of data/ttx files> [--page <strings json>] [--md out.md] [--json out.json]
//     --page compares the strings the harness wrote (BULLBA_TTX_PAGE_OUT) instead.
'use strict';
const HERE = require('node:path').resolve(__dirname).replace(/\\/g, '/') + '/';   // tests/page/: the repository's web/ and mod/ are ../../, the local fixtures ../fixtures-local/
const fs = require('fs');
const WEB = process.env.BULLBA_WEB || HERE + '../../web/';

// ---- The comparison -------------------------------------------------------------------------------------------
// ref: the entries of ttx_reference.json; page: {"<vehicle>|<turret>|<gun>|<mode>": {compact, full, shells}} where
// compact holds the compact rows by slot, full the expanded rows by key and shells the table's rows
// ({avgDamage, avgPiercingPower, shellVelocity, title}). Returns the acceptance rows.
function text(e) { return e && typeof e === 'object' ? (e.text === undefined ? null : e.text) : (e === undefined ? null : e); }
function modes(e) { return e && e.modes ? Object.keys(e.modes).map(function (m) { return e.modes[m]; }) : []; }
function part(e, i) { const s = text(e); return s === null ? null : s.split('/')[i]; }
// The reload line of the panel v2 (23.09, web/ttx.js reloadLine): the parts the client's own lines call for, in the
// page's order - [side, key, the client's string, its entry]. The garage prints each kind of loading with its own keys
// (tools/ttx_reference.py, VehicleParams): reloadTimeSecs, clipFireRate (reload / interval / rounds), autoReloadTime,
// burstFireRate (interval / containers / rounds in one), autoShootClipFireRate (reload / rounds), shellLoadingTime,
// continuousShotsPerMinute, twinGunSwitchFireModeTime, chargeTime (a dual gun's Salvo Preparation).
function expectedLine(R) {
  const out = [], cf = R.clipFireRate, bf = R.burstFireRate, as = R.autoShootClipFireRate;
  const put = function (side, key, client, entry) { if (client !== null && client !== undefined) out.push([side, key, client, entry]); };
  if (text(R.shellLoadingTime) !== null) put('center', 'shellLoadingTime', text(R.shellLoadingTime), R.shellLoadingTime);
  else if (text(as) !== null) { put('left', 'shellsCount', part(as, 1), as); put('center', 'autoShootClipFireRate', part(as, 0), as); }
  else if (text(R.autoReloadTime) !== null) {
    put('left', 'shellsCount', part(cf, 2), cf); put('center', 'autoReloadTime', text(R.autoReloadTime), R.autoReloadTime); put('right', 'shellReloadingTime', part(cf, 1), cf);
  } else if (text(R.reloadTimeSecs) !== null) {
    if (text(cf) !== null) put('left', 'shellsCount', part(cf, 2), cf);
    put('center', 'reloadTimeSecs', text(R.reloadTimeSecs), R.reloadTimeSecs);
    if (text(R.twinGunSwitchFireModeTime) !== null) put('right', 'twinGunSwitchFireModeTime', text(R.twinGunSwitchFireModeTime), R.twinGunSwitchFireModeTime);
    if (text(cf) !== null) put('right', 'shellReloadingTime', part(cf, 1), cf);
    // A dual gun's Salvo Preparation (params 320, key 'chargeTime'; review 23.09): the last part on the right.
    if (text(R.chargeTime) !== null) put('right', 'chargeTime', text(R.chargeTime), R.chargeTime);
  } else if (text(cf) !== null) {
    put('left', 'shellsCount', part(cf, 2), cf); put('center', 'clipFireRate', part(cf, 0), cf);
    if (text(bf) !== null) put('right', 'burstFireRate', part(bf, 0), bf);
    if (text(bf) === null || Number(part(bf, 1)) > 1) put('right', 'shellReloadingTime', part(cf, 1), cf);
  }
  if (text(R.continuousShotsPerMinute) !== null) put('right', 'continuousShotsPerMinute', text(R.continuousShotsPerMinute), R.continuousShotsPerMinute);
  return out;
}
// The client's whole lines of the loading the centre part's tooltip must carry, as the garage prints them.
const LINE_WORDS = ['reloadTimeSecs', 'clipFireRate', 'burstFireRate', 'autoShootClipFireRate', 'autoReloadTime', 'shellLoadingTime',
                    'continuousShotsPerMinute', 'twinGunSwitchFireModeTime', 'temperatureReloadTime', 'chargeTime'];
// add(): one acceptance row. `line` is the page's line, [{side, key, text, title}] in its order.
function lineRows(add, R, line, where) {
  const want = expectedLine(R), got = line || [];
  add('reload line: parts, sides and order', where, want.map(function (w) { return w[0] + ':' + w[1]; }).join(' '),
      got.map(function (g) { return g.side + ':' + g.key; }).join(' '), null, 'rounds | reload | between, as the garage splits its lines');
  want.forEach(function (w) {
    const g = got.filter(function (x) { return x.key === w[1]; })[0];
    add('reload line ' + w[1], where, w[2], g ? g.text : null, w[3]);
  });
  const centre = got.filter(function (x) { return x.side === 'center'; })[0], title = centre ? String(centre.title || '') : '';
  if (where === 'compact') LINE_WORDS.forEach(function (k) {
    const t = text(R[k]);
    if (t === null || t === undefined) return;
    add('reload line tooltip: ' + k, 'tooltip', t, title.indexOf(t) >= 0 ? t : '(not in the tooltip)', R[k], 'the garage\u2019s whole line in the tooltip of the reload');
  });
}
function compare(ref, page) {
  const rows = [];
  ref.forEach(function (r) {
    const P = page[[r.vehicle, r.turret, r.gun, r.mode].join('|')];
    if (!P || r.values.error) return;
    // A gun on two turrets is two pairs: the turret is named when the vehicle has more than one.
    const turrets = {};
    ref.forEach(function (x) { if (x.vehicle === r.vehicle) turrets[x.turret] = true; });
    const R = r.values, mode = r.mode;
    const name = r.vehicle.split(':')[1] + ' ' + r.gun + (Object.keys(turrets).length > 1 ? ' @ ' + r.turret.replace(/_[^_]*$/, '').replace(/^Turret_/, 'T') : '');
    // An Ares gun (temperatureGun): the garage lists the heated figure first and the cold one second; the panel shows
    // the cold one on purpose - the heat is a state of the battle, not a characteristic (spec 3.2). Its DPM and rate
    // are the heat cycle's own keys.
    const heat = text(R.temperatureAvgDamagePerMinute) !== null;
    const cold = function (e) {
      if (!heat || !e || typeof e !== 'object' || text(e) === null || text(e).indexOf('/') < 0) return e;
      const last = function (t) { return t === null ? null : t.split('/').pop(); };
      const m = {};
      Object.keys(e.modes || {}).forEach(function (k) { m[k] = last(e.modes[k]); });
      return {text: last(text(e)), modes: m, ambiguous: e.ambiguous, raw: e.raw};
    };
    const HEATNOTE = 'the garage also lists the heated figure first; the panel shows the cold one (spec 3.2)';
    const dpmOf = function (e, t) { return text(e) !== null ? e : t; };
    function add(key, where, client, shown, entry, note) {
      let match;
      if (shown === undefined) shown = null;
      if (client === null || client === undefined) match = shown === '—' || shown === null ? 'both absent' : 'CLIENT NONE';
      else if (client === shown) match = entry && entry.ambiguous ? 'yes (rounding mode ambiguous)' : 'yes';
      else if (entry && entry.ambiguous && modes(entry).indexOf(shown) >= 0) match = 'yes in one rounding mode (native)';
      else match = 'NO';
      rows.push({vehicle: name, mode: mode, key: key, where: where, client: client === null || client === undefined ? '—' : client,
                 page: shown === null ? '—' : shown, match: match, note: note || ''});
    }
    const C = P.compact || {}, F = P.full || {};
    const kind = text(R.autoReloadTime) !== null ? 'autoreload' : text(R.reloadTimeSecs) !== null ? 'single' : text(R.clipFireRate) !== null ? 'clip' : 'other';
    // Compact: the reload line on top (panel v2), the hit points in the head.
    const DPM = dpmOf(R.avgDamagePerMinute, R.temperatureAvgDamagePerMinute);
    lineRows(add, R, P.line, 'compact');
    add('maxHealth (head)', 'compact', text(R.maxHealth), C.maxHealth, R.maxHealth);
    add('avgDamagePerMinute', 'compact', text(DPM), C.avgDamagePerMinute, DPM, heat ? 'the heat cycle’s DPM (temperatureAvgDamagePerMinute)' : '');
    add('shotDispersionAngle', 'compact', text(cold(R.shotDispersionAngle)), C.shotDispersionAngle, cold(R.shotDispersionAngle), heat ? HEATNOTE : '');
    add('aimingTime', 'compact', text(cold(R.aimingTime)), C.aimingTime, cold(R.aimingTime), heat ? HEATNOTE : '');
    add('turretRotationSpeed', 'compact', text(R.turretRotationSpeed), C.turretRotationSpeed, R.turretRotationSpeed);
    if (text(R.chassisRotationSpeed) !== null) add('hull = chassisRotationSpeed', 'compact', text(R.chassisRotationSpeed), C.hull, R.chassisRotationSpeed);
    else add('hull = maxSteeringLockAngle', 'compact', text(R.maxSteeringLockAngle), C.hull, R.maxSteeringLockAngle, 'wheeled, no turn on the spot');
    add('speedLimits', 'compact', text(R.speedLimits), C.speedLimits, R.speedLimits);
    add('enginePowerPerTon', 'compact', text(R.enginePowerPerTon), C.enginePowerPerTon, R.enginePowerPerTon);
    if (R.stabMovement) {
      add('stabMovement', 'compact', text(R.stabMovement), C.stabMovement, R.stabMovement, 'not a garage figure: XML vehicleMovement, /km/h');
      add('stabRotation', 'compact', text(R.stabRotation), C.stabRotation, R.stabRotation, 'not a garage figure: XML vehicleRotation, /°/s');
      add('stabTurret', 'compact', text(R.stabTurret), C.stabTurret, R.stabTurret, 'not a garage figure: XML turretRotation with the turret override');
    }
    // Expanded.
    add('avgDamagePerMinute', 'expanded', text(DPM), F.avgDamagePerMinute, DPM);
    if (heat) add('shotsPerMinute = temperatureReloadTime', 'expanded', text(R.temperatureReloadTime), F.shotsPerMinute, R.temperatureReloadTime);
    else if (kind !== 'autoreload') add('shotsPerMinute = reloadTime', 'expanded', text(R.reloadTime), F.shotsPerMinute, R.reloadTime);
    // The same reload line on top of the expanded view (one line, no second reload row); an autoloader's whole refill
    // (the garage's clipFireRate) is in the tooltip of its slots.
    if (P.fullLine) lineRows(add, R, P.fullLine, 'expanded');
    add('shotDispersionAngle', 'expanded', text(cold(R.shotDispersionAngle)), F.shotDispersionAngle, cold(R.shotDispersionAngle), heat ? HEATNOTE : '');
    add('aimingTime', 'expanded', text(cold(R.aimingTime)), F.aimingTime, cold(R.aimingTime), heat ? HEATNOTE : '');
    if (R.stabAfterShot) add('stabAfterShot', 'expanded', text(R.stabAfterShot), F.stabAfterShot, R.stabAfterShot, 'not a garage figure: XML afterShot');
    add('pitchLimits', 'expanded', text(R.pitchLimits), F.pitchLimits, R.pitchLimits);
    add('gunYawLimits', 'expanded', text(R.gunYawLimits), F.gunYawLimits === undefined ? null : F.gunYawLimits, R.gunYawLimits);
    add('maxAmmo', 'expanded', text(R.maxAmmo), F.maxAmmo, R.maxAmmo);
    add('speedLimits', 'expanded', text(R.speedLimits), F.speedLimits, R.speedLimits);
    add('enginePower', 'expanded', text(R.enginePower), F.enginePower, R.enginePower);
    add('vehicleWeight', 'expanded', text(R.vehicleWeight), F.vehicleWeight, R.vehicleWeight);
    add('enginePowerPerTon', 'expanded', text(R.enginePowerPerTon), F.enginePowerPerTon, R.enginePowerPerTon);
    if (text(R.chassisRotationSpeed) !== null) add('chassisRotationSpeed', 'expanded', text(R.chassisRotationSpeed), F.chassisRotationSpeed, R.chassisRotationSpeed);
    else add('maxSteeringLockAngle', 'expanded', text(R.maxSteeringLockAngle), F.maxSteeringLockAngle, R.maxSteeringLockAngle);
    add('turretRotationSpeed', 'expanded', text(R.turretRotationSpeed), F.turretRotationSpeed, R.turretRotationSpeed);
    add('terrainResistance', 'expanded', text(R.terrainResistance), F.terrainResistance, R.terrainResistance, 'not a garage figure: chassis × the client’s terrain factors');
    add('maxHealth', 'expanded', text(R.maxHealth), F.maxHealth, R.maxHealth);
    // Survivability (23.09): the garage's whole group in the expanded view - the hull's and the turret's armour (the
    // garage's None without a real turret: the page then has no row) and the suspension's repair time. A reference made
    // before these keys has none of them and is not compared on them.
    if (R.hullArmor !== undefined) {
      add('hullArmor', 'expanded', text(R.hullArmor), F.hullArmor, R.hullArmor);
      add('turretArmor', 'expanded', text(R.turretArmor), F.turretArmor === undefined ? null : F.turretArmor, R.turretArmor,
          text(R.turretArmor) === null ? 'no real turret: the garage has no line, nor has the page' : '');
      add('chassisRepairTime', 'expanded', text(R.chassisRepairTime), F.chassisRepairTime, R.chassisRepairTime,
          mode !== 'stock' ? 'no Repairs skill nor a repair device in the build: the stock’s figure' : '');
    }
    add('circularVisionRadius', 'expanded', text(R.circularVisionRadius), F.circularVisionRadius, R.circularVisionRadius);
    add('invisibilityStillFactor', 'expanded', part(R.invisibilityStillFactor, 0), F.invisibilityStillFactor, R.invisibilityStillFactor);
    add('invisibilityMovingFactor', 'expanded', part(R.invisibilityMovingFactor, 0), F.invisibilityMovingFactor, R.invisibilityMovingFactor);
    add('invisibilityAfterShot', 'expanded', part(R.invisibilityStillFactor, 1), F.invisibilityAfterShot, R.invisibilityStillFactor, 'the garage’s second figure of invisibilityStillFactor');
    // The shells table and its tooltips (the reference has them for the stock).
    (R.shells || []).forEach(function (s, i) {
      const p = (P.shells || [])[i] || {}, tag = 'shell ' + (i + 1) + ' ' + s.kind + ' ';
      const title = String(p.title || '');
      const dm = /\n• Damage: (\d+-\d+) HP/.exec(title), pm = /\n• Penetration: (\d+-\d+) mm/.exec(title), dpm = /\n• DPM with this shell: (\d+)/.exec(title);
      add(tag + 'avgDamage', 'expanded', text(s.avgDamage), p.avgDamage, s.avgDamage);
      add(tag + 'avgPiercingPower', 'expanded', text(s.avgPiercingPower), p.avgPiercingPower, s.avgPiercingPower);
      add(tag + 'shellVelocity', 'expanded', text(s.shellVelocity), p.shellVelocity, s.shellVelocity);
      add(tag + 'damage', 'tooltip', text(s.damage), dm ? dm[1] : null, s.damage);
      add(tag + 'piercingPower', 'tooltip', text(s.piercingPower), pm ? pm[1] : null, s.piercingPower);
      const sd = dpmOf(s.avgDamagePerMinute, s.temperatureAvgDamagePerMinute);
      add(tag + 'DPM', 'tooltip', text(sd), dpm ? dpm[1] : null, sd);
    });
  });
  return rows;
}
function good(r) { return /^yes|both absent/.test(r.match); }
function summary(rows) {
  const by = {};
  rows.forEach(function (r) { const k = r.vehicle + ' · ' + r.mode, b = by[k] = by[k] || {all: 0, ok: 0}; b.all++; if (good(r)) b.ok++; });
  return by;
}
function markdown(rows) {
  return ['| Машина, пушка | Режим | Параметр | Где | Клиент | Страница | Совпадение | Примечание |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
    .concat(rows.map(function (r) {
      return '| ' + [r.vehicle, r.mode, '`' + r.key + '`', r.where, r.client, r.page, r.match, r.note]
        .map(function (x) { return String(x).replace(/\|/g, '\\|'); }).join(' | ') + ' |';
    })).join('\n') + '\n';
}

// ---- The page's strings without the DOM (stock only) ------------------------------------------------------------
function pureStrings(ref, dir) {
  global.window = globalThis;
  require(WEB + 'ballistics.js');
  require(WEB + 'ttx.js');
  const T = window.BullbaTtx;
  // A working copy checked out with CRLF (git's text=auto on Windows) cuts the same functions (23.09).
  const appSrc = fs.readFileSync(WEB + 'app.js', 'utf8').replace(/\r\n/g, '\n');
  const cut = function (name) {
    const start = appSrc.indexOf('  function ' + name + '(');
    if (start < 0) throw new Error('no ' + name + ' in app.js');
    return appSrc.slice(start, appSrc.indexOf('\n  }\n', start) + 4);
  };
  const law = new Function('AIM_CREW_ROLES', 'AIM_BIA_LEVELS', 'AIM_DEFAULT_CREW', cut('aimCrewOf') + cut('crewFactors') + 'return {aimCrewOf: aimCrewOf, crewFactors: crewFactors};')(
    ['commander', 'gunner', 'driver', 'radioman', 'loader'], 0, [['commander'], ['gunner'], ['driver'], ['radioman'], ['loader']]);
  // The shells table prints the velocity the way ttxPaintFull does (read off its source).
  const m = /node\('b', BullbaTtx\.(\w+)\(s\.shellVelocity\)/.exec(appSrc), speed = T[m ? m[1] : 'nice'];
  const files = {};
  fs.readdirSync(dir).forEach(function (f) {
    if (/\.js$/.test(f)) new Function('ArmorInspectorData', fs.readFileSync(dir + '/' + f, 'utf8'))({receive: function (p) { files[p[1].type] = p[1]; }});
  });
  const out = {};
  ref.filter(function (r) { return r.mode === 'stock' && files[r.vehicle]; }).forEach(function (r) {
    const t = files[r.vehicle], ti = t.turrets.map(function (x) { return x.name; }).indexOf(r.turret);
    const pair = t.configs.filter(function (c) { return c.gun === r.gun && c.turret === ti; })[0];
    const crew = law.aimCrewOf(pair.aim), zero = crew.map(function () { return 0; });
    const shells = pair.shells || t.shells[pair.gun] || [];
    const v = T.values({ttx: t, pair: pair, aim: pair.aim, shells: shells, crew: law.crewFactors(crew, zero, 0, zero)}), d = T.display(v);
    const hull = v.chassisRotationSpeed === null && v.maxSteeringLockAngle !== undefined ? d.maxSteeringLockAngle : d.chassisRotationSpeed;
    const full = Object.assign({}, d);
    if (v.chassisRotationSpeed === null) delete full.chassisRotationSpeed;
    if (!v.gunYawLimits) delete full.gunYawLimits;
    // No turret row where the turret is the hull's fake one (ttxPaintFull, the file's vehicle.hasTurret).
    if (t.vehicle && t.vehicle.hasTurret === false) delete full.turretArmor;
    // The reload line without the DOM; the tooltip of its centre holds the garage's whole lines (ttxLoadingWords).
    const words = [d.reloadTimeSecs, d.autoReloadTime, d.clipFireRate, d.burstFireRate, d.autoShootClipFireRate, d.shellLoadingTime,
                   d.continuousShotsPerMinute, d.twinGunSwitchFireModeTime, d.chargeTime, T.nice(v.shotsPerMinute)].join(' ');
    const line = T.reloadLine(v, d).map(function (p) { return {side: p.side, key: p.key, text: p.text, title: p.side === 'center' ? words : ''}; });
    out[[r.vehicle, r.turret, r.gun, r.mode].join('|')] = {line: line, fullLine: line,
      compact: {avgDamagePerMinute: d.avgDamagePerMinute, maxHealth: d.maxHealth, shotDispersionAngle: d.shotDispersionAngle, aimingTime: d.aimingTime,
                turretRotationSpeed: d.turretRotationSpeed, hull: hull, speedLimits: d.speedLimits, enginePowerPerTon: d.enginePowerPerTon,
                stabMovement: d.stabMovement, stabRotation: d.stabRotation, stabTurret: d.stabTurret},
      full: full, clipFireRate: d.clipFireRate,
      shells: v.shells.map(function (s) {
        return {avgDamage: T.nice(s.avgDamage), avgPiercingPower: T.nice(s.avgPiercingPower), shellVelocity: speed(s.shellVelocity),
                title: (s.damage ? '\n• Damage: ' + s.damage.join('-') + ' HP' : '') + (s.piercingPower ? '\n• Penetration: ' + s.piercingPower.join('-') + ' mm' : '')
                       + (s.dpm ? '\n• DPM with this shell: ' + s.dpm : '')};
      })};
  });
  return out;
}

module.exports = {compare: compare, good: good, summary: summary, markdown: markdown, expectedLine: expectedLine, lineRows: lineRows};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = function (k) { const i = args.indexOf(k); return i > 0 ? args[i + 1] : null; };
  const ref = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const page = opt('--page') ? JSON.parse(fs.readFileSync(opt('--page'), 'utf8')) : pureStrings(ref, args[1]);
  const rows = compare(ref, page), by = summary(rows), bad = rows.filter(function (r) { return !good(r); });
  Object.keys(by).forEach(function (k) { console.log(k + ': ' + by[k].ok + '/' + by[k].all); });
  console.log('rows ' + rows.length + ', mismatches ' + bad.length);
  bad.forEach(function (r) { console.log('  MISMATCH ' + r.vehicle + ' ' + r.mode + ' ' + r.where + ' ' + r.key + ': client ' + r.client + ' page ' + r.page); });
  rows.filter(function (r) { return /rounding/.test(r.match); }).forEach(function (r) { console.log('  ambiguous ' + r.vehicle + ' ' + r.mode + ' ' + r.key + ': client ' + r.client + ' page ' + r.page); });
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(rows, null, 1));
  if (opt('--md')) fs.writeFileSync(opt('--md'), markdown(rows));
  process.exitCode = bad.length ? 1 : 0;
}
