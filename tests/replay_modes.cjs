// One nonvisual regression check; optionally read an installed data folder:
// node tests/replay_modes.cjs C:/Games/World_of_Tanks_NA/mods/configs/local.armor_inspector/data
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const R = require('../web/replay-mode.js');
const old = {name: 'Onslaught tournament', bonusType: 47, gameplay: 'comp7'};
const index = [{id: 'battle', special: old}];
const prepared = {id: 'battle', record: {gameplay: 'comp7', special: old}};
const fresh = [{id: 'file', battle: 'battle', battleType: 47, gameplay: 'comp7'}];
assert.deepStrictEqual(R.resolve('battle', fresh, index, prepared), {known: true, special: null});
assert.strictEqual(R.resolve('battle', [], index, null).special, null); // orphaned index
assert.strictEqual(R.resolve('battle', [], [], prepared).special, null); // orphaned prepared
assert.strictEqual(prepared.record.special, old); // read normalization, no mutation
for (const bonus of Object.keys(R.policy.standardBonus)) assert.strictEqual(R.classify(+bonus, 'ctf'), null);
assert.strictEqual(R.classify(47, 'comp7'), null);
for (const bonus of [34, 35]) assert.strictEqual(R.classify(bonus, 'ctf').name, 'Steel Hunter tournament');
assert.strictEqual(R.classify(27, 'epic').name, 'Frontline');
assert.ok(R.classify(14, 'event_gameplay')); // standard tournament label cannot mask event gameplay
const event = {id: 'battle', special: {name: 'Steel Hunter tournament', bonusType: 34, gameplay: 'ctf'}};
assert.strictEqual(R.resolve('battle', [], [event], {id: 'battle', record: {gameplay: 'ctf'}}).special.name, 'Steel Hunter tournament');
assert.strictEqual(R.resolve('battle', [], index, {id: 'battle', record: {gameplay: 'ctf'}}).special, null);
assert.ok(R.resolve('battle', [{id: 'battle'}], [event], null).special); // empty row is not ordinary
assert.strictEqual(R.resolve('battle', [{id: 'battle', special: null}], [event], null).special, null);
assert.strictEqual(R.resolve('battle', [{id: 'battle', battleType: 1, gameplay: 'ctf'}], [event], null).special, null);
assert.strictEqual(R.resolve('unknown', [], [], null).known, false);
let installedOnslaught = 0, installedEvents = 0;
const eventModes = new Set();
if (process.argv[2]) {
  const root = process.argv[2];
  function read(file) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))[1];
  }
  const files = read('replay-files.js').files || [], battles = read('index.js').battles || [];
  for (const row of files.filter(x => x.battleType === 47 && x.gameplay === 'comp7')) {
    const id = row.battle || row.id, file = 'playback/' + id + '.js';
    const data = fs.existsSync(path.join(root, file)) ? read(file) : null;
    assert.deepStrictEqual(R.resolve(id, files, battles, data), {known: true, special: null});
    installedOnslaught++;
  }
  for (const row of files) {
    const expected = R.classify(row.battleType, row.gameplay);
    if (!expected) continue;
    const id = row.battle || row.id;
    assert.deepStrictEqual(R.resolve(id, files, battles, null).special, expected);
    installedEvents++; eventModes.add(expected.name);
  }
}
process.stdout.write(JSON.stringify({ok: true, installedOnslaught, installedEvents, eventModes: [...eventModes]}) + '\n');
