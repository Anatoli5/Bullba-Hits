// A vehicle id's vehicle at a moment (BACKLOG 99, 13.11.2026): in a respawn mode a player comes back in another vehicle under
// the same id, and the battle file's roster row of such an id carries its earlier vehicles ('earlier', each with 'until',
// written by mod roster.py). web/local-data.js reads them - rosterAt / rosterLife - and the page names a hit, a damage event
// and the target's health by the life in force at its battle time. A roster without 'earlier' reads as before.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const sandbox = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'local-data.js'), 'utf8'), sandbox);
const Data = sandbox.window.ArmorInspectorData;

const battle = {roster: [
  {id: 1, type: 'ussr:C', name: 'C', maxHealth: 3000, player: 'p',
   earlier: [{type: 'ussr:A', name: 'A', maxHealth: 1000, player: 'p', until: 100}, {type: 'ussr:B', name: 'B', maxHealth: 2000, player: 'p', until: 200}]},
  {id: 2, type: 'usa:X', name: 'X', maxHealth: 1500}]};

// Each moment its own vehicle, with the id; the last one from the last switch on and without a time.
assert.strictEqual(Data.rosterAt(battle, 1, 50).name, 'A');
assert.strictEqual(Data.rosterAt(battle, 1, 50).id, 1);
assert.strictEqual(Data.rosterAt(battle, 1, 50).until, undefined);
assert.strictEqual(Data.rosterAt(battle, 1, 100).name, 'B');
assert.strictEqual(Data.rosterAt(battle, 1, 199.9).maxHealth, 2000);
assert.strictEqual(Data.rosterAt(battle, 1, 250).name, 'C');
assert.strictEqual(Data.rosterAt(battle, 1, 250).earlier, undefined);
assert.strictEqual(Data.rosterAt(battle, 1, undefined).name, 'C');
assert.strictEqual(Data.rosterAt(battle, 1, Infinity).name, 'C');
const life = Data.rosterLife(battle, 1, 150);
assert.deepStrictEqual([life.index, life.from, life.until], [1, 100, 200]);
assert.deepStrictEqual([Data.rosterLife(battle, 1, 10).from, Data.rosterLife(battle, 1, 300).until], [-Infinity, Infinity]);

// An ordinary row: itself, the same object, one life over the whole battle.
assert.strictEqual(Data.rosterAt(battle, 2, 50), battle.roster[1]);
assert.deepStrictEqual([Data.rosterLife(battle, 2, 50).index, Data.rosterLife(battle, 2, 50).until], [0, Infinity]);
assert.strictEqual(Data.rosterAt(battle, 3, 50), null);
assert.strictEqual(Data.rosterAt({}, 1, 50), null);

console.log('roster lives: ok');
