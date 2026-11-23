/* The replay viewer opened by its own button (19.11.2026, 'one mod, two entries'): the list of replay FILES, and a replay of
 * another player that Bullba Hits has no record of.
 *
 *   node tests/page/playback_files.cjs          (tools/check.py runs it in the browser suite)
 *
 * 1. The mod's code makes the inputs under the client's own python27.dll: tests/py27/playback_job.py --stage (the map's
 *    raw files of Malinovka, the client's definitions file) and then tests/py27/replay_files.py --stage on the same
 *    folder: a staged game replays folder (the user's battle of 14.11 as his own replay, kept by hand, and as another
 *    player's), data/replay-files.js, the other player's battle file made from its header (no record), one vehicle type
 *    without a vehicle file whose file the client's XML route made in data/playback/vehicles/.
 * 2. web/playback.html#host=game (no battle: the viewer's own button) in a local headless Chrome with a new profile. A
 *    stand-in for the game's jsHostQuery answers as the mod does, through window.BullbaPlayback.notify: 'replayFiles' (the
 *    list written), 'mapRaw' (the raw set ready), 'playback' (made), 'playbackVehicles' (the files now there - the stage's
 *    listing, as Exporter.run_playback_vehicles_job says them).
 * Checks: with no battle the top selector lists the replays (the two files once each, the kept one marked, then the Hits
 * battle without a file; 19.11 round 14: no separate panel, each entry date, map, vehicle, player, the list's client as
 * the game writes it - the whole version.xml - not read as an older client) and the mod was asked for the list; choosing the other player's replay opens it: ready, built in the
 * page from its .wotreplay, every vehicle drawn with its model (the one without a Hits file from the XML route after the
 * page asked for it once), the shots and hit points through, the own vehicle the recording player's; no page error and no
 * console error. The figure printed: the time from the choice to ready.
 * No fixture, no client packages or no browser: SKIP (exit 77).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), {spawnSync} = require('child_process');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTLE = '2315856430906286521-d36eff9b31bb';
const MISSING = 'usa-A83_T110E4';
const REPLAY = '2315856430906286521-0000000000aa';  // playback_job.py --stage: the same battle from the replay limit's bh_ file
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
function py27(script, stage) {
  return spawnSync(PYTHON, ['-I', path.join(ROOT, 'tests', 'py27', 'run27.py'), script, '--stage', stage],
    {cwd: ROOT, encoding: 'utf-8', timeout: 240000, windowsHide: true});
}
const ids = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.js')).map((n) => n.slice(0, -3)).sort(); } catch (e) { return []; } };
const HOST = (files) => `(function () {
  window.__host = [];
  window.jsHostQuery = function (q) {
    var c = JSON.parse(q.request), p = c.params || {};
    window.__host.push(p.action === 'mapRaw' ? {action: p.action, arena: p.arena} : p);
    setTimeout(function () { q.onSuccess('ok'); }, 0);
    var say = function (note) { setTimeout(function () { window.BullbaPlayback && window.BullbaPlayback.notify(note); }, 50); };
    if (p.action === 'replayFiles') say({kind: 'files', state: 'ready'});
    if (p.action === 'mapRaw') { say({kind: 'map', arena: p.arena, state: 'queued'}); say({kind: 'map', arena: p.arena, state: 'ready'}); }
    if (p.action === 'playback') say({kind: 'playback', id: p.battleId, state: 'ready'});
    if (p.action === 'playbackVehicles') say({kind: 'vehicles', id: p.battleId, state: 'ready', files: ${JSON.stringify(files)}});
  };
})();`;

(async function main() {
  if (!fs.existsSync(FIXTURE)) { console.log('SKIP no fixture ' + FIXTURE); process.exit(77); }
  const stage = path.join(os.tmpdir(), 'bullba-playback-files-' + crypto.randomUUID());
  fs.mkdirSync(stage, {recursive: true});
  let browser = null;
  try {
    // 1. the mod's jobs, under the client's Python 2.7
    const t0 = Date.now();
    let run = py27('tests/py27/playback_job.py', stage);
    if (run.status === 77) skip('the mod job: ' + String(run.stdout || '').trim().split('\n').pop());
    check('the mod made the map raw files and the definitions', run.status === 0, String(run.stdout || '') + String(run.stderr || '').slice(-600));
    if (run.status !== 0) return;
    run = py27('tests/py27/replay_files.py', stage);
    check('the mod listed the replay files and made the other player\'s battle file', run.status === 0, String(run.stdout || '') + String(run.stderr || '').slice(-600));
    if (run.status !== 0) return;
    const modSeconds = (Date.now() - t0) / 1000;
    const listPath = path.join(stage, 'data', 'replay-files.js');
    const listing = JSON.parse((t => t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')))(fs.readFileSync(listPath, 'utf8')))[1];
    const other = listing.files.filter((f) => f.player === 'SomeoneElse')[0];
    // the user's game (19.11) writes the list's client as the whole text of version.xml and each file's as its header
    // gives it ('World of Tanks v.2.4.1.1 #992'): the same client in two spellings - the stage takes that shape
    listing.client = '<version.xml>\n\t<appname>\t#menu:login/version\t</appname>\n\t<version> v.2.4.1.1 #992 </version>\n</version.xml>';
    listing.files.forEach((f) => { f.client = 'World of Tanks v.2.4.1.1 #992'; });
    // R4 (BACKLOG 112, 20.11): the other player's replay stands in for a battle of a special mode, as the mod marks one
    // (replay_files.special_mode - its rule and an Onslaught header are checked in tests/py27/replay_files.py)
    other.battleType = 34; other.gameplay = 'ctf';
    other.special = {name: 'Steel Hunter tournament', bonusType: 34, gameplay: 'ctf'};
    fs.writeFileSync(listPath, 'ArmorInspectorData.receive(' + JSON.stringify(['replayFiles', listing]) + ');\n');
    // 2. the page as it ships; the hits page's battle list holds the recorded battle (it has no replay file here)
    copyDir(path.join(ROOT, 'web'), path.join(stage, 'web'));
    fs.writeFileSync(path.join(stage, 'data', 'index.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['index', {application: 'local.armor_inspector', version: 'test',
      battles: [{id: BATTLE, startedAt: 1795000000, hits: 10, map: 'Malinovka', vehicle: {name: 'Pz. Neu', type: 'germany:G197_Pz_Kpfw_Neu'}}]}]) + ');\n');
    const files = {hits: ids(path.join(stage, 'data', 'vehicles')), viewer: ids(path.join(stage, 'data', 'playback', 'vehicles'))};
    check('the stage: one type without a Hits vehicle file, made by the XML route', !files.hits.includes(MISSING) && files.viewer.includes(MISSING), JSON.stringify(files.viewer));
    browser = await launch({width: 1280, height: 720});
    if (!browser) skip('no Chrome or Edge on this machine');
    const page = await browser.open('file:///' + path.join(stage, 'web', 'playback.html').replace(/\\/g, '/') + '#host=game', HOST(files));
    // 19.11 (the user, in the game): one list only - the battle selector at the top; the separate panel of replays (its
    // rows had collapsed to empty strips) is gone
    let list = null;
    for (let i = 0; i < 40 && !(list && list.rows.length > 1); i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      list = await page.evaluate("({list: !!window.__list, panel: !!document.getElementById('files'), rows: [].map.call(document.getElementById('sel-battle').options, (o) => [o.value, o.textContent, o.parentNode.label || '']), host: window.__host, error: window.__error || null})");
    }
    check('opened with no battle: no separate panel, the selector at the top lists the replays, the mod asked for them', list && list.list && !list.panel && !list.error &&
      list.host.map((c) => c.action).join(',') === 'replayFiles', JSON.stringify(list && {panel: list.panel, host: list.host, error: list.error}));
    // the entries: the other player's replay first (the newest), the own one once and marked kept, the replay limit's bh_
    // file of the battle REPLAY (playback_job.py's) under that Hits battle's id, last the Hits battle without a file
    const rows = list ? list.rows.filter((r) => r[0]) : [];
    const own = rows.filter((r) => / · Bullba/.test(r[1]));
    check('the selector: the other player\'s replay first, the own one once and marked kept, the Hits battle without a file last', rows.length === 4 &&
      rows[0][0] === other.id && /SomeoneElse/.test(rows[0][1]) && /Malinovka/.test(rows[0][1]) && own.length === 1 && /★/.test(own[0][1]) &&
      rows[3][0] === BATTLE && rows[3][2] === 'Bullba Hits battles', JSON.stringify(rows));
    check('a file the replay limit ties to a Hits battle is listed under that battle\'s id', rows.some((r) => r[0] === REPLAY && r[2] === 'Replay files'), JSON.stringify(rows));
    // (the stage's bh_ file of REPLAY has no player or vehicle in its listing entry: only the two full ones are read here)
    const files3 = rows.filter((r) => r[2] === 'Replay files'), full = files3.filter((r) => r[0] !== REPLAY);
    check('each replay entry: date and time, map, vehicle, player; the same client in two spellings is not called older', files3.length === 3 && full.length === 2 &&
      full.every((r) => /^(⚠ )?\d\d\.\d\d · \d\d:\d\d · Malinovka · \S.* · \S+/.test(r[1])) && files3.every((r) => !/older client/.test(r[1])), JSON.stringify(files3));
    // R4: the special mode's mark - on that entry alone
    const marked = rows.filter((r) => /^⚠ /.test(r[1]));
    check('R4: a battle of a special mode is marked in the battle list: ' + marked.length + ' of ' + rows.length + ' entries (the event tournament one)',
      marked.length === 1 && marked[0][0] === other.id, JSON.stringify(rows));
    const chose = Date.now();
    await page.evaluate("(() => { const s = document.getElementById('sel-battle'); s.value = '" + other.id + "'; s.dispatchEvent(new Event('change')); })()");
    await page.waitForFunction("!document.getElementById('special-warn').hidden");
    // R4: confirmation BEFORE navigation/decode, with "Don't show again"; ticked and OK - remembered in the page's settings box
    const warn = await page.evaluate("(() => { const w = document.getElementById('special-warn'); return {shown: !w.hidden, mode: document.getElementById('special-mode').textContent, text: w.textContent," +
      " box: !!document.getElementById('special-again')}; })()");
    check('R4: opening it shows the warning, the mode named, with a "Don\'t show again" box', warn.shown && warn.mode === 'Steel Hunter tournament' && warn.box && /picture may be wrong/.test(warn.text), JSON.stringify(warn));
    const kept = await page.evaluate("(() => { document.getElementById('special-again').checked = true; document.getElementById('special-ok').click();" +
      " let box = null; try { box = JSON.parse(localStorage.getItem('bullba-playback-settings')); } catch (e) {} return {hidden: document.getElementById('special-warn').hidden," +
      " stored: box && box.values ? box.values['sw-special-warn'] : null, others: box && box.values ? Object.keys(box.values).length : 0, setting: document.getElementById('sw-special-warn').checked}; })()");
    check('R4: "Don\'t show again" + OK: the warning goes, the settings switch off and remembered (' + kept.others + ' settings in the box)', kept.hidden && kept.stored === false && kept.setting === false, JSON.stringify(kept));
    let state = null;
    for (let i = 0; i < 360 && !state; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      try { state = await page.evaluate("location.hash.indexOf('" + other.id + "') >= 0 ? (window.__error ? {error: window.__error} : (window.__ready || null)) : null"); } catch (e) { state = null; }
    }
    const wall = (Date.now() - chose) / 1000;
    check('the other player\'s replay (no record of Bullba Hits) opens', state && !state.error, state ? state.error : 'not ready after 180 s');
    if (state && !state.error) {
      check('built in the page from the .wotreplay', state.battleBuild && state.battleBuild.source === 'built', JSON.stringify(state.battleBuild));
      check('every vehicle drawn with its model', state.vehicles === 30 && state.boxes === 0, 'vehicles ' + state.vehicles + ', boxes ' + state.boxes);
      check('shots and hit points come through', state.shots > 40 && state.hits.points > 30, JSON.stringify({shots: state.shots, hits: state.hits}));
      check('the own vehicle is the recording player\'s (the first own-vehicle packet)', state.owned === 1, JSON.stringify({ownId: state.ownId, owned: state.owned}));
      const host = await page.evaluate('window.__host');
      const asked = host.filter((c) => c.action === 'playbackVehicles');
      check('the vehicle without a Hits file was asked for once, with its compact descriptor', asked.length === 1 && asked[0].battleId === other.id &&
        asked[0].vehicles.length === 1 && asked[0].vehicles[0].type === MISSING.replace('-', ':') && typeof asked[0].vehicles[0].descr === 'string', JSON.stringify(asked));
      const sel = await page.evaluate("(() => { const s = document.getElementById('sel-battle'); return {value: s.value, groups: [].map.call(s.querySelectorAll('optgroup'), (g) => g.label)}; })()");
      check('the selector stands on the replay, files first', sel.value === other.id && sel.groups[0] === 'Replay files', JSON.stringify(sel));
      // R5 in the game: the full-screen button asks the mod for the frameless view with the page's state
      const fs = await page.evaluate("(() => { window.__host.length = 0; document.getElementById('fullscreen').click(); return new Promise((r) => setTimeout(() => r({host: window.__host.slice(), cam: MapBench.camera(), st: MapBench.state(), close: document.getElementById('close-view').hidden}), 100)); })()");
      const cmd = (fs.host || []).filter((c) => c.action === 'fullscreen')[0] || {};
      const kv = {}; String(cmd.state || '').split('&').forEach((p) => { const i = p.indexOf('='); if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1); });
      const camNums = String(kv.cam || '').split(',').map(Number);
      check('R5 in the game: the button sends fullscreen on with the battle, time, camera, speed and play state (' + cmd.state + '); no close button in the window',
        cmd.on === true && kv.battle === other.id && Math.abs(+kv.at - fs.st.t) < 0.05 && camNums.length === 6 && Math.abs(camNums[5] - fs.cam.dist) < 0.01 &&
        +kv.speed === fs.st.speed && kv.play === (fs.st.playing ? '1' : '0') && !('host' in kv) && !('view' in kv) && fs.close === true, JSON.stringify({cmd: cmd, cam: fs.cam, st: fs.st}));
      // R5 outside the game, in a second tab of the same browser (the same page storage): opened as the mod reopens it,
      // with the carried state; the in-page full screen on and off by the button; the warning not shown again
      const carried = 'battle=' + other.id + '&at=100.00&cam=' + [fs.cam.tx + 5, fs.cam.ty, fs.cam.tz - 5, 0.5, 0.4, 123].map((v) => (+v).toFixed(2)).join(',') + '&speed=2&play=0';
      const page2 = await browser.open('file:///' + path.join(stage, 'web', 'playback.html').replace(/\\/g, '/') + '#' + carried);
      let ready2 = null;
      for (let i = 0; i < 240 && !ready2; i++) { await new Promise((r) => setTimeout(r, 500)); ready2 = await page2.evaluate('window.__error ? {error: window.__error} : (window.__ready || null)'); }
      const back = ready2 && !ready2.error ? await page2.evaluate("({st: MapBench.state(), cam: MapBench.camera(), warn: !document.getElementById('special-warn').hidden})") : null;
      check('R5: the page opened with the carried state takes it back: time 100 s, the camera, speed x2, paused; R4: no warning again', back && Math.abs(back.st.t - 100) < 0.01 &&
        Math.abs(back.cam.dist - 123) < 0.01 && Math.abs(back.cam.yaw - 0.5) < 1e-6 && back.st.speed === 2 && back.st.playing === false && back.warn === false, JSON.stringify(ready2 && ready2.error ? ready2 : back));
      // (headless Chrome enters the page's full screen but never finishes leaving it - no window to restore - so the way
      // out is checked as the call the button makes: document.exitFullscreen)
      const inPage = await page2.evaluate("(async () => { const b = document.getElementById('fullscreen'), out = {};" +
        " b.click(); await new Promise((r) => setTimeout(r, 1000)); out.on = document.fullscreenElement === document.documentElement; out.pressed = b.getAttribute('aria-pressed');" +
        " const exit = document.exitFullscreen.bind(document); out.exits = 0; document.exitFullscreen = function () { out.exits++; return exit(); };" +
        " b.click(); await new Promise((r) => setTimeout(r, 300)); return out; })()");
      check('R5 outside the game: the button puts the page in full screen (document.fullscreenElement = the page, the button pressed); pressed again it calls exitFullscreen',
        inPage.on && inPage.pressed === 'true' && inPage.exits === 1, JSON.stringify(inPage));
      const errors2 = page2.errors.slice();
      check('the second tab: no page error', !errors2.length, errors2.join(' | ').slice(0, 800));
      console.log('note the other player\'s replay ready ' + wall.toFixed(1) + ' s after the choice (battle built in ' + (state.battleBuild.ms / 1000).toFixed(2) +
        ' s, map built in the page); the mod jobs before it ' + modSeconds.toFixed(1) + ' s (stand, python27)');
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
    console.log('playback_files: ' + checks + ' checks, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  }
})();
