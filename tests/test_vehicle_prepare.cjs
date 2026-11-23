// The replay viewer asks the mod to prepare a vehicle model it already made (23.11.2026). The user's case: every switch
// between full screen and window reloads web/playback.html, and each time the message line says "Preparing the models of
// 1 vehicle..." (the game's log: 'Playback of <battle>: 1 vehicle types without a file asked for by the page' then
// '0 by the exporter descriptor route, 0 from the client XML' - the mod had nothing to make, the file was there).
// Cause: loadVehicles is given the battle file's vehicleFiles (data/playback/<battle>.js), a listing the mod wrote once
// when it made that file - before the variants it made afterwards (data/playback/vehicles/<type>--<crc>.js). Their
// current listing is data/playback/variants-<battle>.js, which the page reads only after asking the mod again.
// Data: his Redshire battle 17895352401374170-24bc765e94f3 (22.11 21:58), four VK 30.01 P; three in the configuration
// ERw9ABwBywAIADEAIQEA (variant germany-G27_VK3001P--fe32de5d, made 22.11 22:04), one in ERw9ABwBywAIADEAIAEA (the
// Hits file data/vehicles/germany-G27_VK3001P.js). The battle file's viewer listing: 2 entries without the VK variants;
// the variants file: both. The code under test is cut out of web/playback/playback.js by name.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'playback', 'playback.js'), 'utf8');
function cut(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'playback.js has ' + name);
  let depth = 0, i = src.indexOf('{', at);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const BID = '17895352401374170-24bc765e94f3', TYPE = 'germany:G27_VK3001P';
const IQ = 'ERw9ABwBywAIADEAIQEA', IA = 'ERw9ABwBywAIADEAIAEA';
const conf = (d, key) => ({ t: 0, type: TYPE, key: key, compDescr: d });
const battle = { vehicles: [
  { id: 5570381, configs: [conf(IQ, 'germany-G27_VK3001P--fe32de5d')] },
  { id: 5570382, configs: [conf(IQ, 'germany-G27_VK3001P--fe32de5d')] },  // his own
  { id: 5570383, configs: [conf(IQ, 'germany-G27_VK3001P--fe32de5d')] },
  { id: 5570384, configs: [conf(IA, 'germany-G27_VK3001P--e2147d2d')] }] };
// the files in the game's data folder at 23.11 04:06 (listings as written there)
const viewerNow = ['germany-G27_VK3001P--e2147d2d', 'germany-G27_VK3001P--fe32de5d', 'usa-A179_Black_Rock', 'usa-A179_Black_Rock--285d73ac'];
const battleFileListing = { hits: ['germany-G27_VK3001P'], viewer: ['usa-A179_Black_Rock', 'usa-A179_Black_Rock--285d73ac'] };
const disk = {
  'data/vehicles/germany-G27_VK3001P.js': { compactDescriptor: IA, parts: [] },
  'data/playback/vehicles/germany-G27_VK3001P--e2147d2d.js': { compactDescriptor: IA, parts: [] },
  'data/playback/vehicles/germany-G27_VK3001P--fe32de5d.js': { compactDescriptor: IQ, parts: [] },
  ['data/playback/variants-' + BID + '.js']: { files: { hits: ['germany-G27_VK3001P'], viewer: viewerNow } },
};

function open(inGame) {
  const sent = [], msg = { textContent: '' };
  const box = {
    BID: BID, VEHICLES_MS: 120000, FILE: { vehicleFiles: battleFileListing }, console: console, Promise: Promise, Set: Set,
    PlaybackBattle: { lives: (v) => v.configs },
    vehicleModel: (veh) => ({ model: true, compactDescriptor: veh.compactDescriptor }),
    loadData: (src) => (src in disk ? Promise.resolve(JSON.parse(JSON.stringify(disk[src]))) : Promise.reject(new Error('not a data file: ' + src))),
    $: () => msg,
    host: { canSend: () => inGame, send: (to, c) => { sent.push(c); return Promise.resolve(); } },
    // the in-game wait: the mod's word never comes (no executeJavascript), the look reads the variants file
    waitFor: (test, look) => look(),
  };
  vm.runInNewContext(cut(SRC, 'loadVehicles') + '\n' + cut(SRC, 'vehiclesFor'), box);
  return box.vehiclesFor(battle, null).then((m) => ({ m: m, sent: sent, msg: msg.textContent }));
}

(async function () {
  let failed = 0;
  function check(name, ok, detail) { if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + ' -- ' + detail); } }
  // in the game: a reload of a battle whose variants the mod made earlier
  const g = await open(true);
  const asked = g.sent.filter((c) => c.action === 'playbackVehicles');
  check('in the game, a reload asks the mod for nothing it already made', asked.length === 0, JSON.stringify(asked));
  check('in the game, the message line does not say "Preparing the models"', !/Preparing the models/.test(g.msg), g.msg);
  check('in the game, both VK 30.01 P configurations get their model', Object.keys(g.m).length === 2 && Object.values(g.m).every((x) => x.model), JSON.stringify(g.m));
  // outside the game (the mod cannot be asked): the files on disk are drawn all the same
  const o = await open(false);
  const drawn = (k) => o.m[k] && o.m[k].model;
  check('outside the game, the three VK 30.01 P in ' + IQ + ' get the variant the mod made (germany-G27_VK3001P--fe32de5d)',
    drawn('germany-G27_VK3001P--fe32de5d'), JSON.stringify(o.m));
  console.log('test_vehicle_prepare: ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
