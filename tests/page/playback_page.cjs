/* The 3D replay player opens a recorded battle through the product's own path (BACKLOG 104, 18.11.2026).
 *
 *   node tests/page/playback_page.cjs          (tools/check.py runs it in the browser suite)
 *
 * 1. The mod's code makes the player's inputs: tests/py27/playback_job.py --stage <folder> runs, under the client's own
 *    python27.dll, the exporter's 'playback' job on the user's battle of 14.11 on Malinovka (tests/fixtures-local/
 *    playback-2026-11-18): data/playback/<id>.js, its source (the kept stream.z as it is), the client's definitions file,
 *    mapraw/<arena>/ and mapraw/res/ copied from the client's packages (read only); and the same battle as REPLAY, its
 *    source a .wotreplay (the stream encrypted, renamed by the replay limit).
 * 2. The page as it ships (web/ copied beside the staged data, the folder layout of CFG) opens web/playback.html#battle=<id>
 *    in a local headless Chrome with a new profile: an empty IndexedDB, so the battle is built in the page's worker from
 *    its source (19.11) and the map from the raw files (a map never built before), then the scene.
 * The page runs as in the game (#host=game, 19.11): a stand-in for the game's jsHostQuery records the page's commands and
 * answers as the mod does - 'mapRaw' with the mod's word that the map's raw set is ready (the raw set the mod job made),
 * 'playback' with the battle file's - through window.BullbaPlayback.notify, the call the mod makes.
 * Checks: the page reports ready with the battle and the map built (not read back), every vehicle of the battle, its
 * shots, hit points and destruction resolved, the own vehicle the record's; the first opening asked the mod for the map
 * with its digest of held products, and sent one report (map and battle built); no page error and no console error (no
 * failed read of a missing file); the frame loop runs (the battle clock moves on Play). Every later opening of a battle
 * on that map asks the mod for nothing about the map; the reopened battle asks nothing at all, its report says both came
 * from IndexedDB.
 * 4. The same battle opened again with its source file removed: read from IndexedDB.
 * 5. REPLAY, never opened: built from its .wotreplay with the same vehicles, shots, hit points, muzzles, destruction and
 *    own vehicle as from the stream.z; its time from opening to ready is printed (the map already in IndexedDB).
 * 3. The battle selector and the remembered settings (18.11.2026): the stage gets the hits page's battle list (data/index.js,
 *    written oldest first) with a second battle - a copy of the same playback file under another id, so the switch needs no
 *    second mod job. The selector lists both newest first with the current one chosen; a setting (haze) and the speed (x4)
 *    are changed, the other battle is chosen: the page opens it (ready again, its id in the fragment, the selector on it),
 *    the haze and the speed came back as they were left; Reset to defaults puts them back and empties the store.
 * The base circles (19.11.2026): the rings drawn equal the map file's WTCP records of the battle's mode (two of 50 m).
 * The rocks (19.11.2026): the JS-built map has the rock shader's materials (Malinovka's cliffs), its rock models drawn
 * with them and their DXT5 array texture created with one layer per texture the map lists.
 * The one figure printed: the time from opening the page to ready, and the mod job's time before it.
 * No fixture, no client packages or no browser: SKIP (exit 77).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), {spawnSync} = require('child_process');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTLE = '2315856430906286521-d36eff9b31bb';
const OTHER = '9315856430906286521-d36eff9b31bb';   // the same battle's file under another id (step 3)
const REPLAY = '2315856430906286521-0000000000aa';  // the same battle from a .wotreplay (playback_job.py --stage; step 5)
const FIXTURE = path.join(ROOT, 'tests', 'fixtures-local', 'playback-2026-11-18');
const PYTHON = process.env.BULLBA_PYTHON || 'python';
let checks = 0, failed = 0;
function check(name, ok, detail) { checks++; if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); } }
let skipped = null;
function skip(text) { skipped = text; throw new Error('skip'); }
function copyDir(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const e of fs.readdirSync(from, {withFileTypes: true})) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

// the game's channel as the page sees it (web/host.js: window.jsHostQuery): the commands kept in window.__host, the mod's
// answers by window.BullbaPlayback.notify (the mod: presentation.notify_page -> executeJavascript)
const HOST = `(function () {
  window.__host = [];
  window.jsHostQuery = function (q) {
    var c = JSON.parse(q.request), p = c.params || {};
    window.__host.push(p.action === 'mapRaw' ? {action: p.action, arena: p.arena, held: typeof p.held, resv: p.resv, whole: p.whole} : p);
    setTimeout(function () { q.onSuccess('ok'); }, 0);
    var say = function (note) { setTimeout(function () { window.BullbaPlayback && window.BullbaPlayback.notify(note); }, 50); };
    if (p.action === 'mapRaw') { say({kind: 'map', arena: p.arena, state: 'queued'}); say({kind: 'map', arena: p.arena, state: 'ready'}); }
    if (p.action === 'playback') say({kind: 'playback', id: p.battleId, state: 'ready'});
  };
})();`;
// opens battle `id` in the open page (the fragment, a reload) and waits for it: {state, wall, host}
async function openBattle(page, id) {
  const began = Date.now();
  await page.evaluate("window.__ready = null; window.__error = null; location.hash = 'host=game&battle=" + id + "'; location.reload()");
  let state = null;
  for (let i = 0; i < 360 && !state; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    try { state = await page.evaluate("location.hash.indexOf('" + id + "') >= 0 ? (window.__error ? {error: window.__error} : (window.__ready || null)) : null"); } catch (e) { state = null; }
  }
  const host = state ? await page.evaluate('window.__host') : null;
  return {state: state, wall: (Date.now() - began) / 1000, host: host};
}
// (19.11) every opening also asks for the list of replay files ('replayFiles', tests/page/playback_files.cjs): not a word
// about this battle or its map, so it is left out here
const actions = (host) => (host || []).map((c) => c.action).filter((a) => a !== 'replayFiles').sort().join(',');
const reported = (host) => (host || []).filter((c) => c.action === 'playbackReport').map((c) => c.report);

(async function main() {
  if (!fs.existsSync(FIXTURE)) { console.log('SKIP no fixture ' + FIXTURE); process.exit(77); }
  const stage = path.join(os.tmpdir(), 'bullba-playback-page-' + crypto.randomUUID());
  fs.mkdirSync(stage, {recursive: true});
  let browser = null;
  try {
    // 1. the mod's job, under the client's Python 2.7
    const t0 = Date.now();
    const run = spawnSync(PYTHON, ['-I', path.join(ROOT, 'tests', 'py27', 'run27.py'), 'tests/py27/playback_job.py', '--stage', stage],
      {cwd: ROOT, encoding: 'utf-8', timeout: 240000, windowsHide: true});
    const modSeconds = (Date.now() - t0) / 1000;
    if (run.status === 77) skip('the mod job: ' + String(run.stdout || '').trim().split('\n').pop());
    check('the mod job made the playback file and the map raw files', run.status === 0, String(run.stdout || '') + String(run.stderr || '').slice(-600));
    if (run.status !== 0) return;
    // 2. the page as it ships
    copyDir(path.join(ROOT, 'web'), path.join(stage, 'web'));
    // 3's inputs: the battle list of the hits page (oldest first, as no order is promised) and the second battle's file
    const pbDir = path.join(stage, 'data', 'playback');
    for (const ext of ['.js', '.src.js']) fs.writeFileSync(path.join(pbDir, OTHER + ext), fs.readFileSync(path.join(pbDir, BATTLE + ext), 'utf8').split(BATTLE).join(OTHER));
    const recordOf = (id) => { const t = fs.readFileSync(path.join(pbDir, id + '.js'), 'utf8'); return JSON.parse(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')))[1]; };
    const OWN = recordOf(BATTLE).record.playerVehicleId;
    fs.writeFileSync(path.join(stage, 'data', 'index.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['index', {application: 'local.armor_inspector', version: 'test',
      battles: [{id: BATTLE, startedAt: 1795000000, hits: 10, map: 'Malinovka', vehicle: {name: 'Pz. Neu', type: 'germany:G197_Pz_Kpfw_Neu'}},
        {id: OTHER, startedAt: 1795003600, hits: 5, map: 'Malinovka', vehicle: {name: 'STK-2', type: 'japan:J52_STK_2'}}]}]) + ');\n');
    fs.copyFileSync(path.join(ROOT, 'web', 'index.html'), path.join(stage, 'Viewer.html'));
    browser = await launch({width: 1280, height: 720});
    if (!browser) skip('no Chrome or Edge on this machine');
    const url = 'file:///' + path.join(stage, 'web', 'playback.html').replace(/\\/g, '/') + '#host=game&battle=' + BATTLE;
    const opened = Date.now();
    const page = await browser.open(url, HOST);
    let state = null;
    for (let i = 0; i < 360 && !state; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      state = await page.evaluate('window.__error ? {error: window.__error} : (window.__ready || null)');
    }
    const wall = (Date.now() - opened) / 1000;
    check('the player reports ready', state && !state.error, state ? state.error : 'not ready after 180 s');
    if (state && !state.error) {
      check('the map was built in the page (a map never built: no IndexedDB record)', state.jsBuild && state.jsBuild.source === 'built', JSON.stringify(state.jsBuild && state.jsBuild.source));
      check('the battle was built in the page from its stream.z (no IndexedDB record yet)', state.battleBuild && state.battleBuild.source === 'built', JSON.stringify(state.battleBuild));
      const host1 = await page.evaluate('window.__host'), ask1 = host1.filter((c) => c.action === 'mapRaw'), rep1 = reported(host1);
      check('the first opening asked the mod for the map once, with its digest of held products', ask1.length === 1 && ask1[0].arena === '02_malinovka' &&
        ask1[0].held === 'string' && ask1[0].resv && actions(host1) === 'mapRaw,playbackReport', JSON.stringify(host1));
      check('one report of the opening: map and battle built, the times, WebGL', rep1.length === 1 && rep1[0].mapFrom === 'built' && rep1[0].battleFrom === 'built' &&
        rep1[0].map === '02_malinovka' && rep1[0].total > 0 && rep1[0].buildMap > 0 && rep1[0].webgl === true && rep1[0].mapBuiltAt > 0, JSON.stringify(rep1));
      check('the own vehicle is the battle record\'s (the first own_vehicle packet), one vehicle marked own', state.ownId === OWN && state.owned === 1,
        JSON.stringify({ownId: state.ownId, owned: state.owned, record: OWN}));
      check('every vehicle of the battle is drawn, with its model', state.vehicles === 30 && state.boxes === 0, 'vehicles ' + state.vehicles + ', boxes ' + state.boxes);
      check('shots, hit points and destruction come through', state.shots > 40 && state.hits.points > 30 && state.destructionEvents > 0,
        JSON.stringify({shots: state.shots, hits: state.hits, destruction: state.destructionEvents}));
      // the base circles (19.11): from the map's own space.bin WTCP section, copied by the mod and read by the page's
      // builder - Malinovka's standard battle (ctf) has both teams' bases of 50 m (cache/base-circle/wtcp_all.json)
      const rings = await page.evaluate('({drawn: MapBench.circles(), data: MapBench.mapCircles()})');
      const pairs = (a) => JSON.stringify((a || []).map((c) => [c.team, c.radius]).sort());
      check('a ring of the map file radius at each base of the battle mode', pairs(rings.drawn) === '[[1,50],[2,50]]' && pairs(rings.data) === pairs(rings.drawn),
        JSON.stringify(rings));
      // the rocks (19.11): materials of PBS_tiled_atlas_global built from the raw files, and drawn with their array texture
      const rocks = await page.evaluate('MapBench.rocks()');
      check('the map has rock materials, its rock models drawn with their array texture', rocks.materials > 0 && rocks.layers > 0 && rocks.models > 0 &&
        rocks.texture && rocks.textureLayers === rocks.layers && rocks.drawn === rocks.models, JSON.stringify(rocks));
      // the battle clock moves when played (software WebGL in headless Chrome draws this scene slowly: frames are waited for)
      await page.send('Page.bringToFront');   // a background target gets no animation frames
      const before = await page.evaluate('MapBench.state().t');
      await page.evaluate("document.getElementById('play').click()");
      let after = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        after = await page.evaluate('MapBench.state()');
        if (after.t > before) break;
      }
      check('Play moves the battle clock', after && after.playing && after.t > before, JSON.stringify({before: before, after: after}));
      // 3. the battle selector and the remembered settings
      const pick = await page.evaluate("(() => { const s = document.getElementById('sel-battle'); return s ? {value: s.value, options: [].map.call(s.options, (o) => [o.value, o.textContent])} : null; })()");
      check('the selector lists the battles newest first, the current one chosen', pick && pick.value === BATTLE && pick.options.length === 2 &&
        pick.options[0][0] === OTHER && pick.options[1][0] === BATTLE && /Malinovka/.test(pick.options[1][1]) && /Pz\. Neu/.test(pick.options[1][1]), JSON.stringify(pick));
      await page.evaluate("document.getElementById('settings-btn').click(); document.getElementById('sw-haze').click(); document.querySelector('[data-speed=\"4\"]').click()");
      await new Promise(function (r) { setTimeout(r, 700); });
      const kept = await page.evaluate("JSON.parse(localStorage.getItem('bullba-playback-settings') || 'null')");
      check('a changed setting and the speed are saved', kept && kept.values && kept.values['sw-haze'] === false && kept.values['speed-value'] === '4', JSON.stringify(kept && kept.values));
      await page.evaluate("(() => { const s = document.getElementById('sel-battle'); s.value = '" + OTHER + "'; s.dispatchEvent(new Event('change')); })()");
      let again = null;
      for (let i = 0; i < 240 && !again; i++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        try { again = await page.evaluate("location.hash.indexOf('" + OTHER + "') >= 0 ? (window.__error ? {error: window.__error} : (window.__ready || null)) : null"); } catch (e) { again = null; }
      }
      check('choosing another battle opens it', again && !again.error && again.vehicles === 30, again ? JSON.stringify(again.error || again.vehicles) : 'not ready after 120 s');
      const host3 = await page.evaluate('window.__host');
      check('another battle on the same map: its map from IndexedDB, nothing asked about it', again && again.jsBuild && again.jsBuild.source === 'IndexedDB' &&
        !(host3 || []).some((c) => c.action === 'mapRaw'), JSON.stringify(host3));
      if (again && !again.error) {
        const after = await page.evaluate("({battle: document.getElementById('sel-battle').value, haze: document.getElementById('sw-haze').checked, speed: MapBench.state().speed, on: (document.querySelector('[data-speed].on') || {}).textContent})");
        check('the selector stands on the opened battle', after.battle === OTHER, JSON.stringify(after));
        check('the setting and the speed are kept on the next opening', after.haze === false && after.speed === 4 && after.on === 'x4', JSON.stringify(after));
        const reset = await page.evaluate("document.getElementById('reset-settings').click(); ({haze: document.getElementById('sw-haze').checked, speed: MapBench.state().speed, on: (document.querySelector('[data-speed].on') || {}).textContent, store: localStorage.getItem('bullba-playback-settings')})");
        check('Reset to defaults returns the defaults and empties the store', reset.haze === true && reset.speed === 1 && reset.on === 'x1' && reset.store === null, JSON.stringify(reset));
      }
      // 4. a second opening reads IndexedDB: the battle's source file is gone, and nothing asks for it
      fs.renameSync(path.join(pbDir, BATTLE + '.src.js'), path.join(stage, BATTLE + '.src.js.away'));
      const reopened = await openBattle(page, BATTLE);
      check('a second opening reads the battle from IndexedDB (its source file removed)', reopened.state && !reopened.state.error &&
        reopened.state.battleBuild && reopened.state.battleBuild.source === 'IndexedDB' && reopened.state.vehicles === 30 && reopened.state.hits.points === state.hits.points,
        JSON.stringify(reopened.state && (reopened.state.error || reopened.state.battleBuild)));
      const rep4 = reported(reopened.host);
      check('the second opening asks the mod for nothing: its one command is the report (map and battle from IndexedDB)', actions(reopened.host) === 'playbackReport' &&
        rep4[0].mapFrom === 'IndexedDB' && rep4[0].battleFrom === 'IndexedDB' && rep4[0].mapBuiltAt === rep1[0].mapBuiltAt && rep4[0].waitMod === 0,
        JSON.stringify(reopened.host));
      // 5. a never-opened battle whose source is a .wotreplay (the replay limit's file): decrypted, decoded, built here
      const replayed = await openBattle(page, REPLAY);
      const r = replayed.state;
      check('a battle from its .wotreplay opens: built in the page', r && !r.error && r.battleBuild && r.battleBuild.source === 'built', JSON.stringify(r && (r.error || r.battleBuild)));
      if (r && !r.error) {
        check('from the .wotreplay: every vehicle, the shots, hit points and destruction as from the stream.z', r.vehicles === 30 && r.boxes === 0 &&
          r.shots === state.shots && r.hits.points === state.hits.points && r.hits.muzzles === state.hits.muzzles && r.destructionEvents === state.destructionEvents,
          JSON.stringify({shots: r.shots, hits: r.hits, destruction: r.destructionEvents}));
        check('from the .wotreplay: the own vehicle is the record\'s', r.ownId === OWN && r.owned === 1, JSON.stringify({ownId: r.ownId, owned: r.owned}));
        console.log('note a never-opened battle from its .wotreplay ready ' + (r.total / 1000).toFixed(2) + ' s after opening (map already in IndexedDB; battle built in ' +
          (r.battleBuild.ms / 1000).toFixed(2) + ' s: ' + JSON.stringify(r.battleBuild.times) + ')');
      }
      console.log('note page ready ' + (state.total / 1000).toFixed(1) + ' s after opening (load ' + state.load + ' ms, scene ' + state.build +
        ' ms, plants ' + state.impostors + ' ms; wall ' + wall.toFixed(1) + ' s); the mod job before it ' + modSeconds.toFixed(1) + ' s (stand, python27)');
    }
    const errors = page.errors.slice(), consoleErrors = page.console.filter(function (l) { return /^(error|assert)|^log error/.test(l); });
    check('no page error', !errors.length, errors.join(' | ').slice(0, 800));
    check('no console error', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 800));
  } catch (e) {
    if (!skipped) check('the harness ran', false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(stage, {recursive: true, force: true}); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 300); }); } }
    if (skipped) { console.log('SKIP ' + skipped); process.exitCode = 77; return; }
    console.log('playback_page: ' + checks + ' checks, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  }
})();
