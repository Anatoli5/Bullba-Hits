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
// NOTEBOOK Y15 (22.11): his ordinary Westfield battle, an index row of the old shape (no mode fields), no replay-file row,
// not prepared yet - the viewer warned "Unidentified mode". Not prepared: no warning yet; prepared: its record decides.
const hisRow = {id: '1701423024682059-c02263efff0e', map: 'Westfield', startedAt: 1795142733.571, hits: 12};
const before = R.resolve(hisRow.id, [], [hisRow], null);
assert.strictEqual(R.opening(before, false), null);
assert.strictEqual(R.opening(R.resolve(hisRow.id, [], [hisRow], {id: hisRow.id, record: {gameplay: 'ctf', map: '05_prohorovka'}}), true), null);
assert.strictEqual(R.opening(R.resolve(hisRow.id, [], [hisRow], {id: hisRow.id, record: {gameplay: 'epic'}}), true).name, 'Frontline');
assert.strictEqual(R.opening(before, true).name, 'Unidentified mode'); // prepared and still no evidence: a real unknown
// the new index rows (exporter summary_mode): an ordinary battle known from the index alone, a special one marked
assert.deepStrictEqual(R.resolve('b', [], [{id: 'b', battleType: 14, gameplay: 'domination'}], null), {known: true, special: null});
assert.strictEqual(R.resolve('b', [], [{id: 'b', battleType: 29, gameplay: 'ctf'}], null).special.name, 'Steel Hunter');
// 23.11: a battle tile's figures (summary) - shapes of his replay files' entries (results as the mod's results_of keeps
// them) and the shipped table of the client's battle modes (web/battle-modes.js). Format or tag and the result follow the
// data; the tag is the table's abbreviation.
const MODES = require('../web/battle-modes.js');
const bonusRows = Object.entries(MODES.bonus);
assert.ok(bonusRows.length >= 40, 'the table holds the client\'s bonus types');
for (const [value, row] of bonusRows) assert.ok(/^[A-Z0-9]{2,3}$/.test(row.abbr || ''), 'bonus type ' + value + ' ' + row.const + ' has an abbr');
const abbrs = bonusRows.map(([, row]) => row.abbr);
assert.strictEqual(new Set(abbrs).size, abbrs.length, 'abbreviations are unique');
const solo = (n) => Object.fromEntries(Array.from({length: n}, (_, i) => [String(i + 1), 1]));
// two teams: players per team, winner against the player's team; names from the table
const random = R.summary({battleType: 1, gameplay: 'ctf', results: {winnerTeam: 2, team: 2, guiType: 1, damageDealt: 7339, kills: 2, teams: {'1': 15, '2': 15}}}, MODES);
assert.deepStrictEqual([random.name, random.format, random.tag, random.result, random.damage, random.kills], ['Random Battle', '15×15', null, 'victory', 7339, 2]);
assert.strictEqual(R.resultWords(random), 'Victory');
// Onslaught tournament: the header lists 3 of the 6 vehicles; the results' players give 3x3; its name the GUI type's
const onslaught = R.summary({battleType: 47, gameplay: 'comp7', vehicles: 3, results: {winnerTeam: 1, team: 2, guiType: 33, teams: {'2': 3, '1': 3}}}, MODES);
assert.deepStrictEqual([onslaught.name, onslaught.format, onslaught.result], ['Onslaught', '3×3', 'defeat']);
assert.strictEqual(R.summary({battleType: 1, results: {teams: {'2': 15, '1': 14}}}, MODES).format, '14×15'); // uneven, team order
assert.strictEqual(R.summary({battleType: 1, results: {winnerTeam: 0, team: 1, teams: {'1': 15, '2': 15}}}, MODES).result, 'draw');
// any mode with two teams shows its format, not its tag
assert.strictEqual(R.summary({battleType: 110, gameplay: 'ctf', results: {teams: {'1': 1, '2': 14}}}, MODES).format, '1×14');
// no results (a one-block file): no stripe, no format, no tag
const cut = R.summary({battleType: 29, gameplay: 'ctf'}, MODES);
assert.deepStrictEqual([cut.result, cut.format, cut.tag, cut.name], [null, null, null, 'Steel Hunter']);
// every player on their own, places: the table's tag; 1st place a victory, any other a defeat
const sh = R.summary({battleType: 29, gameplay: 'ctf', results: {winnerTeam: 15, team: 15, place: 1, guiType: 23, teams: solo(15)}}, MODES);
assert.deepStrictEqual([sh.tag, sh.tagName, sh.tagWords, sh.format, sh.result, sh.place, sh.places],
  ['SH', 'Steel Hunter', '15 players, each on their own.', null, 'victory', 1, 15]);
const sh13 = R.summary({battleType: 29, results: {winnerTeam: 13, team: 15, place: 13, teams: solo(15)}}, MODES);
assert.deepStrictEqual([sh13.result, R.resultWords(sh13)], ['defeat', 'Defeat: place 13 of 15']);
const squads = R.summary({battleType: 30, gameplay: 'ctf', results: {teams: {'1': 2, '2': 2, '3': 2}}}, MODES);
assert.deepStrictEqual([squads.tag, squads.tagWords], [MODES.bonus['30'].abbr, '3 squads of 2.']);
// one team
assert.deepStrictEqual(R.summary({battleType: 111, results: {teams: {'1': 5}}}, MODES).tagWords, 'One team of 5.');
assert.strictEqual(R.summary({battleType: 110, results: {teams: {'1': 5}}}, MODES).tag, 'WT');
// a mode the table lacks (a client newer than the table): FM, the tooltip names what is known
const unknown = R.summary({battleType: 250, results: {teams: {'1': 2, '2': 2, '3': 2}}}, MODES);
assert.deepStrictEqual([unknown.name, unknown.tag, unknown.tagName], ['Battle type 250', 'FM', 'Battle type 250']);
assert.strictEqual(R.summary({battleType: 29, results: {teams: solo(3)}}, {}).tag, 'FM'); // no table at all
// the name's order: the table's bonus-type name, its GUI-type name, the policy's, 'Battle type N'; none unknown
assert.strictEqual(R.summary({battleType: 14, results: {guiType: 0}}, MODES).name, 'Special Battle');
assert.strictEqual(R.summary({battleType: 24, results: {guiType: 19}}, MODES).name, 'Grand Battle');
assert.strictEqual(R.summary({battleType: 14}, {}).name, 'Tournament');
assert.strictEqual(R.summary({battleType: 250}, {}).name, 'Battle type 250');
assert.strictEqual(R.summary({special: {bonusType: 29, name: 'Steel Hunter'}}, MODES).name, 'Steel Hunter'); // an old index row
assert.strictEqual(R.summary({}, MODES).name, null);
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
