// The Statistics log line's part columns (27.09, review of 5f2bee5): the verdict line of web/app.js, cut out of the page
// as tools/verdicts_offline.cjs cuts it, names a wheel wheel<k-1>, an armoured prefab by its kind, and marks a verdict cast in a scene that had to leave a
// part out (sceneFor's `partial`: a wheel without its body) with partial=<names>; a whole scene adds no column.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const {takeFunction, takeLiteral} = require(path.join(__dirname, '..', 'tools', 'verdicts_offline.cjs'));
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const lines = [];
const make = new Function('console', '$', 'ArmorCrits', 'recordsVersion', [
  'var effects=' + takeLiteral(app, /var\s+effects=(\{[^}]*\})/, 'effects') + ';',
  'var partNames=' + takeLiteral(app, /partNames=(\[[^\]]*\])/, 'partNames') + ';',
  'var verdictLines=0;function verdictStatus(){}function shellModeColumns(){return \'\';}function damageColumns(){return \'\';}',
  takeFunction(app, 'logPart'), takeFunction(app, 'verdictLine'), 'return verdictLine;'].join('\n'));
const line = make({info: function (s) { lines.push(s); }}, function () { return {getAttribute: function () { return 'test'; }}; },
  {columns: function () { return ''; }}, 'r');
const shell = {penetration: 200, kind: 'ARMOR_PIERCING'}, v = {index: 0, part: -3, effect: 5, source: 'segment', chordDev: null, result: {chance: 90, reason: 'penetration'}};
line('b', {id: 'h'}, v, shell, 'auto', {partial: [-2, -5]});
line('b', {id: 'h'}, Object.assign({}, v, {part: 1}), shell, 'view', {partial: []});
line('b', {id: 'h'}, v, shell, 'view');
assert.ok(/ part=wheel2 partial=wheel1,wheel4 server=/.test(lines[0]), lines[0]);
assert.ok(/ part=hull server=/.test(lines[1]) && lines[1].indexOf('partial=') < 0, lines[1]);
assert.ok(lines[2].indexOf('partial=') < 0, lines[2]);
// An armoured prefab (27.09): the log names it by its kind - part 4 of the CAV mod. 71 is its crest, not an outer track -
// and names it in partial= when the scene had to leave it out.
const cav = {id: 'h', target: {parts: [{id: 3, name: 'gun'}, {id: 4, name: 'crest_module', prefab: 'p', prefabKind: 'crest'}]}};
line('b', cav, Object.assign({}, v, {part: 4}), shell, 'auto', {partial: []});
line('b', cav, Object.assign({}, v, {part: 3}), shell, 'auto', {partial: [4]});
assert.ok(/ part=crest server=/.test(lines[3]), lines[3]);
assert.ok(/ part=gun partial=crest server=/.test(lines[4]), lines[4]);
console.log(JSON.stringify({passed: true, cases: 5}));
