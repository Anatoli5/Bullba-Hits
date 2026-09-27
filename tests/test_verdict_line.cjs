// The Statistics log line's part columns (27.09, review of 5f2bee5): the verdict line of web/app.js, cut out of the page
// as tools/verdicts_offline.cjs cuts it, names a wheel wheel<k-1>, an armoured prefab by its kind, and marks a verdict cast in a scene that had to leave a
// part out (sceneFor's `partial`: a wheel without its body) with partial=<names>; a whole scene adds no column.
// Review of d1b372b: partialRay=1 when this verdict's shell met a missing part (a recorded contact on it up to the verdict's
// point), 0 when not; an armoured prefab of the target adds prefabPose=<kind>/<from>/<layer> and prefabFit=<mm>, read by
// the real ArmorInspectorData.prefabPose of web/local-data.js.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const {takeFunction, takeLiteral} = require(path.join(__dirname, '..', 'tools', 'verdicts_offline.cjs'));
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const sandbox = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'local-data.js'), 'utf8'), sandbox);
const Data = sandbox.window.ArmorInspectorData;
const lines = [];
const make = new Function('console', '$', 'ArmorCrits', 'recordsVersion', 'ArmorInspectorData', [
  'var effects=' + takeLiteral(app, /var\s+effects=(\{[^}]*\})/, 'effects') + ';',
  'var partNames=' + takeLiteral(app, /partNames=(\[[^\]]*\])/, 'partNames') + ';',
  'var verdictLines=0;function verdictStatus(){}function shellModeColumns(){return \'\';}function damageColumns(){return \'\';}',
  takeFunction(app, 'logPart'), takeFunction(app, 'prefabColumns'), takeFunction(app, 'verdictLine'), 'return verdictLine;'].join('\n'));
const line = make({info: function (s) { lines.push(s); }}, function () { return {getAttribute: function () { return 'test'; }}; },
  {columns: function () { return ''; }}, 'r', Data);
const shell = {penetration: 200, kind: 'ARMOR_PIERCING'}, v = {index: 0, pi: 0, part: -3, effect: 5, source: 'segment', chordDev: null, result: {chance: 90, reason: 'penetration'}};
line('b', {id: 'h'}, v, shell, 'auto', {partial: [-2, -5]});
line('b', {id: 'h'}, Object.assign({}, v, {part: 1}), shell, 'view', {partial: []});
line('b', {id: 'h'}, v, shell, 'view');
assert.ok(/ part=wheel2 partial=wheel1,wheel4 partialRay=0 server=/.test(lines[0]), lines[0]);
assert.ok(/ part=hull server=/.test(lines[1]) && lines[1].indexOf('partial=') < 0, lines[1]);
assert.ok(lines[2].indexOf('partial=') < 0, lines[2]);
// An armoured prefab (27.09): the log names it by its kind - part 4 of the CAV mod. 71 is its crest, not an outer track -
// and names it in partial= when the scene had to leave it out.
const I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
const crest = {id: 4, name: 'crest_module', prefab: 'p', prefabKind: 'crest', parentPart: 3, prefabBase: I(0, .3, -.5),
  prefabLayers: [{name: '0 position layer', angle: 0}, {name: '1 position layer', angle: 3.3}], prefabDefault: '0 position layer', transform: I(0, 2.3, -.5)};
const cav = {id: 'h', target: {parts: [{id: 3, name: 'gun', transform: I(0, 2, 0)}, crest]}, points: [{part: 4}, {part: 3}]};
line('b', cav, Object.assign({}, v, {part: 4}), shell, 'auto', {partial: []});
line('b', cav, Object.assign({}, v, {part: 3, pi: 1}), shell, 'auto', {partial: [4]});
assert.ok(/ part=crest prefabPose=crest\/hit\/0_position_layer prefabFit=0\.0 server=/.test(lines[3]), lines[3]);
// The shell met the crest before the gun point: the missing crest was on its way.
assert.ok(/ part=gun partial=crest partialRay=1 prefabPose=crest\/hit\/0_position_layer prefabFit=0\.0 server=/.test(lines[4]), lines[4]);
// A missing crest the shell did not meet (its only contact on the hull): partialRay=0.
line('b', {id: 'h', target: cav.target, points: [{part: 1}]}, Object.assign({}, v, {part: 1, pi: 0}), shell, 'auto', {partial: [4]});
assert.ok(/ part=hull partial=crest partialRay=0 /.test(lines[5]), lines[5]);
// A recorded crest 120 mm off the rule: settlePrefabs stands it at its default, the line says rejected and the fit.
const off = {target: {parts: [{id: 3, name: 'gun', transform: I(0, 2, 0)}, Object.assign({}, crest, {transform: I(0, 2.42, -.5)})]}};
Data.settlePrefabs(off);
line('b', {id: 'h', target: off.target, points: [{part: 3}]}, Object.assign({}, v, {part: 3}), shell, 'auto', {partial: []});
assert.ok(/ prefabPose=crest\/rejected\/0_position_layer prefabFit=120\.0 /.test(lines[6]) && off.target.parts[1].poseFrom === 'rejected'
  && off.target.parts[1].transform[13] === 2.3, lines[6]);
console.log(JSON.stringify({passed: true, cases: 7}));
