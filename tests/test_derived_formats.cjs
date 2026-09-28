/* Every derived battle format the mod has written reads on the current page (startup-review-fixes, 27.09).

   The mod publishes a saved battle again only when its DERIVED_FORMAT changed (data/published.json), and it does so in the
   background after the start: until its turn comes, the page reads the file an earlier build wrote. tests/golden/ keeps the
   file publish() writes for one fixture battle in each format (tests/py27/derived_golden.py stores it); this reads each of
   them through the page's own reader (web/local-data.js) and builds the scene of every hit from it, as the page does.
   No browser, no server. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const GOLDEN = path.join(__dirname, 'golden');
const files = fs.readdirSync(GOLDEN).filter(function (n) { return /^derived-battle-\d+\.js$/.test(n); }).sort();
// A model file as the mod writes it (one triangle), for every model key the battle names.
const MODEL = {kind: 'client-shot-collision', groups: [{material: 1, indices: [0, 1, 2]}], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]]};
let source = null;
const ctx = {Promise, Date, setTimeout, clearTimeout, console};
ctx.window = ctx;
ctx.document = {createElement() { return {remove() {}}; }, head: {appendChild(script) {
  const file = script.src.split('?')[0];
  setImmediate(function () {
    try {
      if (/^data\/battles\//.test(file)) vm.runInContext(source, ctx);
      else if (/^data\/models\/[a-f0-9]{64}\.js$/.test(file)) ctx.ArmorInspectorData.receive(['model:' + file.slice(12, -3), JSON.parse(JSON.stringify(MODEL))]);
      script.onload();
    } catch (e) { script.onerror(); }
  });
}}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'local-data.js'), 'utf8'), ctx);
let failures = 0;
function ok(cond, name, detail) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : ' (' + detail + ')'));
  if (!cond) failures++;
}
(async function () {
  ok(files.length > 0, 'tests/golden holds the derived battle of at least one format', files.join());
  for (const name of files) {
    source = fs.readFileSync(path.join(GOLDEN, name), 'utf8');
    const id = /receive\(\["battle:([-a-zA-Z0-9_]+)"/.exec(source)[1];
    const battle = await ctx.ArmorInspectorData.battle(id);
    const hits = battle.hits || [];
    ok(hits.length === 2 && hits.every(function (h) { return (h.target.parts || []).length === 4 && (h.attacker.parts || []).length === 4; }),
       name + ': the page reads its hits with the parts of both vehicles', hits.length);
    ok(hits.every(function (h) { return h.target.parts.every(function (p) { return p.armor && Object.keys(p.armor).length && p.modelKey && p.transform; }); }),
       name + ': every part has its armour, its model and its place', JSON.stringify(hits[0].target.parts[0]));
    ok(Array.isArray(battle.damageEvents) && battle.damageEvents.length > 0 && Array.isArray(battle.roster),
       name + ': the damage events and the roster are there', Object.keys(battle).join());
    for (const h of hits) {
      const scene = await ctx.ArmorInspectorData.sceneFor(battle, h);
      ok(!scene.geometryIncomplete && Object.keys(scene.models).length === 4,
         name + ': hit ' + h.id + ' builds its whole scene', scene.geometryError || Object.keys(scene.models).join());
    }
  }
  console.log(failures ? failures + ' FAILURES' : 'all passed');
  process.exitCode = failures ? 1 : 0;
})().catch(function (e) { console.log('FAIL exception ' + (e && e.stack)); process.exitCode = 1; });
