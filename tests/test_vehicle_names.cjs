// The replay viewer's vehicle names (23.11.2026): every row of one vehicle type is named the same, from the client's
// vehicle list (web/hit-rows.js BullbaRows.vehicleNamer), whatever 3D model its module configuration got.
// The user's case: his Redshire battle of 22.11 21:58, four VK 30.01 P. Only the teammate's configuration matched the
// model file Hits had exported (its compact descriptor), so only his row read 'VK 30.01 P' with tier VI; the player's own
// row and both enemies' read the code 'G27_VK3001P' with no tier, and the shots panel 'G27_VK3001P -> G27_VK3001P'.
// The battle's roster and configurations (built by web/playback/battle.js from his replay), the list's row and the model
// file's descriptor are in tests/fixtures-local/vehicle-names-2026-11-23 (skipped when absent).
// The code under test is cut out of web/playback/playback.js by name: tileOf (the team lists, the shots panel, the shot
// view's title, the vehicle markers) and battleView (the battle menu's tile), with what they call.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
const rowsBox = {};
vm.runInNewContext(fs.readFileSync(path.join(WEB, 'hit-rows.js'), 'utf8'), { window: rowsBox });
const R = rowsBox.BullbaRows;
assert.ok(R && typeof R.vehicleNamer === 'function', 'web/hit-rows.js has the resolver BullbaRows.vehicleNamer');

// a top-level function of playback.js by its name: from 'function name(' to its closing brace
function cut(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let depth = 0, i = src.indexOf('{', at);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const SRC = fs.readFileSync(path.join(WEB, 'playback', 'playback.js'), 'utf8');
function page(catalogue, index) {
  const box = { BullbaRows: R, BullbaReplayMode: require('../web/replay-mode.js'), FILES: null, NAMES: R.vehicleNamer(catalogue), INDEX: index || null, specialOf: () => null };
  const code = ['typeOf', 'tileOf', 'vehicleShort', 'fileWhen', 'battleWhen', 'battleView'].map((n) => cut(SRC, n)).filter(Boolean).join('\n');
  vm.runInNewContext(code, box);
  return box;
}
// what loadVehicles makes of a configuration: the type's model file when its compact descriptor is the configuration's,
// else no model ('recorded variant not prepared' - the case of the three rows)
function md(file, config) {
  if (file && config.compDescr === file.compactDescriptor) return { model: true, name: file.name,
    tile: { name: file.name, level: file.level, 'class': file['class'], role: file.role, nation: file.nation, type: file.type } };
  return { model: false, missing: true, reason: 'recorded variant not prepared' };
}
function record(v, config, file) { return { v: v, life: config, md: md(file, config) }; }

// ---- synthetic: one type in three configurations (one with its model), one type the list lacks -----------------------
{
  const cat = [{ type: 'ussr:R04_T-34', name: 'T-34', level: 5, 'class': 'mediumTank', role: 'role_MT_universal', nation: 'ussr' }];
  const file = { compactDescriptor: 'A', name: 'T-34', level: 5, 'class': 'mediumTank', role: 'role_MT_universal', nation: 'ussr', type: 'ussr:R04_T-34' };
  const P = page(cat);
  const rows = ['A', 'B', 'C'].map((d, i) => record({ id: i, type: 'ussr:R04_T-34' }, { type: 'ussr:R04_T-34', compDescr: d }, file));
  const tiles = rows.map((r) => P.tileOf(r));
  tiles.forEach((t, i) => {
    assert.strictEqual(t.name, 'T-34', 'configuration ' + i + ' is named from the list (got ' + t.name + ')');
    assert.strictEqual(t.level, 5, 'configuration ' + i + ' has its tier');
    assert.strictEqual(t['class'], 'mediumTank', 'configuration ' + i + ' has its class');
  });
  const odd = P.tileOf(record({ id: 9, type: 'usa:A99_Nothing' }, { type: 'usa:A99_Nothing', compDescr: 'Z' }, null));
  assert.strictEqual(odd.name, 'A99_Nothing', 'a type the list lacks keeps its code name');
  assert.ok(/Game code name: not in the client's vehicle list/.test(R.vehicleWords(odd)), 'and its words say why');
  assert.ok(!/Game code name/.test(R.vehicleWords(tiles[0])), 'a listed type has no such note');
  const none = page(null).tileOf(rows[1]);
  assert.ok(/the vehicle list was not read/.test(R.vehicleWords(none)), 'no list read: the words say so');
  assert.strictEqual(page(null).tileOf(rows[0]).name, 'T-34', 'no list read: the model file still names its own configuration');
  // the battle menu: a replay file no Hits battle holds, named by its type
  const menu = P.battleView('f-1', { vehicle: 'ussr:R04_T-34', map: 'm', when: '2026-11-22 21:58:44' }, true);
  assert.strictEqual(menu.vehicle.name, 'T-34', 'the menu names an untied file\'s vehicle from the list');
  assert.strictEqual(menu.vehicle.level, 5, 'with its tier');
}

// ---- the user's case -----------------------------------------------------------------------------------------------
const FIX = path.join(__dirname, 'fixtures-local', 'vehicle-names-2026-11-23', 'battle.json');
if (fs.existsSync(FIX)) {
  const F = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const P = page(F.catalogue);
  const keys = new Set();
  const named = [];
  F.vehicles.forEach((v) => v.configs.forEach((c) => {
    keys.add(c.compDescr);
    const t = P.tileOf(record(v, c, F.vehicleFile));
    named.push([v.player, t.name, t.level]);
  }));
  assert.ok(keys.size >= 2 && F.vehicles.length === 4, 'the case is there: four VK 30.01 P in more than one configuration');
  named.forEach(([who, name, level]) => {
    assert.strictEqual(name, 'VK 30.01 P', who + '\'s row is named as the list names it (got ' + name + ')');
    assert.strictEqual(level, 6, who + '\'s row has tier VI (got ' + level + ')');
  });
  console.log('vehicle names, the user\'s case: ' + named.map((n) => n[0] + ' ' + n[1] + ' ' + n[2]).join('; '));
} else console.log('vehicle names: the user\'s case skipped (no ' + path.relative(process.cwd(), FIX) + ')');
console.log('vehicle names ok');
