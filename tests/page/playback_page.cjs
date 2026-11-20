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
 * 20.11.2026: R7 the opening view (behind the own vehicle, following it; its angle and distance printed), R6 the page's one
 * type scale (its sizes printed), R9 the top line's groups at 900-1920 px, the sky on by default.
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
    // the battle Bullba Hits published from this replay (tests/page/shot_view.cjs's fixture), when this machine has it: the
    // index below lists the battle, so a shots-panel row's shot view reads it (19.11) - without it that read fails
    const HITS = path.join(ROOT, 'tests', 'fixtures-local', 'shot-view-2026-11-19');
    if (fs.existsSync(HITS)) { copyDir(path.join(HITS, 'data'), path.join(stage, 'data')); copyDir(path.join(HITS, 'definitions'), path.join(stage, 'definitions')); }
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
      // R7 (20.11.2026, the user on 1.14): the opening view - behind the own vehicle at the battle's start, 20 m, following it.
      // The one number: the angle between the camera's view axis (its eye to the point looked at, placeCamera's formula) and
      // the direction from the eye to the own vehicle (its origin 1.2 m up), and that distance. The old rule (the arena's
      // centre from 700 m, a free camera) only when the battle has no own vehicle (MapBench.startView(true)).
      const VIEW = "(() => { const c = MapBench.camera(), v = MapBench.vehiclesAt().filter((x) => x.role === 'own')[0];" +
        " const e = [c.tx + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw), c.ty + c.dist * Math.sin(c.pitch), -c.tz + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw)];" +
        " const a = [c.tx - e[0], c.ty - e[1], -c.tz - e[2]], b = [v.x - e[0], v.y + 1.2 - e[1], -v.z - e[2]], n = (x) => Math.hypot(x[0], x[1], x[2]);" +
        " const own = document.querySelector('.veh.own'), fol = document.querySelectorAll('.veh.follow');" +
        " return {angle: Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n(a) / n(b)) * 180 / Math.PI, dist: n(b), cam: c, hullYaw: v.yaw, t: MapBench.state().t, start: MapBench.battleStart()," +
        "  follows: fol.length === 1 && fol[0] === own, free: document.getElementById('free').classList.contains('on')}; })()";
      const v7 = await page.evaluate(VIEW);
      console.log('R7 at open: the view axis ' + v7.angle.toFixed(1) + ' deg off the own vehicle, ' + v7.dist.toFixed(1) + ' m from it');
      check('R7: the battle opens at its start behind the own vehicle, the camera following it: ' + v7.angle.toFixed(1) + ' deg off its direction, ' + v7.dist.toFixed(1) + ' m away',
        state.view === 'own' && v7.follows && !v7.free && v7.angle <= 10 && v7.dist >= 15 && v7.dist <= 30 && Math.abs(v7.t - v7.start) < 1e-6 &&
        Math.abs(Math.cos(v7.cam.yaw + v7.hullYaw) - 1) < 0.01, JSON.stringify(v7));
      const centre = await page.evaluate("(() => { const k = MapBench.startView(true), c = MapBench.camera(); return {kind: k, cam: c, follows: document.querySelectorAll('.veh.follow').length, free: document.getElementById('free').classList.contains('on')}; })()");
      const back = await page.evaluate("MapBench.startView()");
      check('R7: the map\'s centre from 700 m, free camera, only with no own vehicle; the own view back after it', centre.kind === 'centre' && centre.cam.dist === 700 && centre.follows === 0 && centre.free && back === 'own',
        JSON.stringify({centre: centre, back: back}));
      // R6 (20.11.2026): one type scale - every text shown (the settings, the destruction list and a shots panel open) is
      // 12 px (text), 11 px (a small mark in a row: tier, time, 'shots', the Hits link) or 13 px (a heading), every line 16 px;
      // a team row's text line = the top line's = a shot row's. The sizes and the kinds are printed.
      const types = await page.evaluate("(() => { document.getElementById('settings-btn').click(); document.getElementById('destr').open = true;" +
        " const b = document.querySelector('#list-own .veh .sp-btn'); if (b) b.click(); const kinds = {};" +
        " for (const el of document.body.querySelectorAll('*')) { if (/^(SCRIPT|STYLE|CANVAS|OPTION)$/i.test(el.tagName) || el.closest('svg')) continue;" +
        "  const own = [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim()); if (!own && !/^(BUTTON|SELECT)$/.test(el.tagName)) continue;" +
        "  const cs = getComputedStyle(el), r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0) || !own && el.tagName !== 'SELECT') continue;" +
        "  const k = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '')); (kinds[cs.fontSize + '/' + cs.lineHeight] = kinds[cs.fontSize + '/' + cs.lineHeight] || {})[k] = 1; }" +
        " const out = {}; Object.keys(kinds).forEach((s) => { out[s] = Object.keys(kinds[s]); });" +
        " document.getElementById('settings-btn').click(); document.getElementById('destr').open = false; if (b) b.click(); return out; })()");
      const sizes = [...new Set(Object.keys(types).map((s) => s.split('/')[0]))].sort();
      console.log('R6 font sizes on the page: ' + sizes.join(', ') + '\n' + Object.keys(types).map((s) => '  ' + s + ': ' + types[s].join(' ')).join('\n'));
      check('R6: one type scale - sizes ' + sizes.join(', ') + ' (before: 10, 11, 12, 13, 15 px), every line 16 px but a select\'s own',
        sizes.every((s) => ['11px', '12px', '13px'].includes(s)) && Object.keys(types).every((s) => /\/(16px|normal)$/.test(s)) &&
        Object.keys(types).every((s) => !/normal$/.test(s) || types[s].every((k) => k.indexOf('select') === 0 || k[0] === '#' && /^#sel-/.test(k))), JSON.stringify(types));
      // R9 (20.11.2026, the user on 1.14): the top line in three groups - the battle (Hits, the choice; the battle named once,
      // the former title gone), the view (Settings, the sky to its right a little apart), the window (full screen, close) -
      // and, at 900-1920 px, the open settings never over the sky switch, nothing in the line over another or cut
      const R9 = "(() => { const q = (s) => document.querySelector(s), R = (el) => el.getBoundingClientRect(), sel = q('#sel-battle'), line = q('#topline');" +
        " const text = [...line.querySelectorAll('button, label, span')].filter((e) => !e.closest('select') && !e.contains(sel)).map((e) => e.textContent).join(' ');" +
        " const st = q('#settings'), wasOpen = !st.hidden; if (!wasOpen) q('#settings-btn').click();" +
        " const sky = q('#sw-sky').closest('label'), set = R(q('#settings-btn')), sk = R(sky), pane = R(st), meter = R(q('#meter'));" +
        " const parts = [...line.querySelectorAll('.tl-group > *')].filter((e) => !e.hidden).map(R); let cross = 0;" +
        " for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (parts[i].right > parts[j].left + 0.5 && parts[j].right > parts[i].left + 0.5) cross++;" +
        " const out = {title: !!q('#title'), named: sel.selectedOptions[0] && sel.selectedOptions[0].textContent, nameElsewhere: /Malinovka/.test(text)," +
        "  battle: !!q('.tl-battle #back') && !!q('.tl-battle #sel-battle'), view: q('.tl-view').firstElementChild === q('#settings-btn') && q('.tl-view').contains(sky)," +
        "  window: !!q('.tl-window #fullscreen') && !!q('.tl-window #close-view'), seps: line.querySelectorAll('.tl-sep').length, skyGap: sk.left - set.right," +
        "  over: !(sk.bottom <= pane.top || sk.top >= pane.bottom || sk.right <= pane.left || sk.left >= pane.right), inside: sk.left >= meter.left && sk.right <= meter.right," +
        "  skyCut: sky.scrollWidth > sky.clientWidth + 0.5, cross: cross, width: innerWidth};" +
        " if (!wasOpen) q('#settings-btn').click(); return out; })()";
      const r9 = [];
      for (const w of [900, 1280, 1920]) {
        await page.send('Emulation.setDeviceMetricsOverride', {width: w, height: Math.round(w * 9 / 16), deviceScaleFactor: 1, mobile: false});
        await new Promise(function (r) { setTimeout(r, 200); });
        r9.push(await page.evaluate(R9));
      }
      await page.send('Emulation.clearDeviceMetricsOverride');
      check('R9: the top line by meaning - Hits and the battle | Settings, sky right of it | full screen, close; the battle named once (' + (r9[0] && r9[0].named) + '); at 900, 1280, 1920 px the open settings never over the sky, nothing over another',
        r9.length === 3 && r9.every((x) => !x.title && x.named && /Malinovka/.test(x.named) && !x.nameElsewhere && x.battle && x.view && x.window && x.seps === 2 &&
          x.skyGap >= 4 && x.skyGap <= 16 && !x.over && x.inside && !x.skyCut && x.cross === 0), JSON.stringify(r9));
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
      // 20.11 (the user): no function on the middle button - its drag does not pan (a pan frees the camera), its press
      // kept from the browser's autoscroll
      const mid = await page.evaluate("(() => { const c = document.querySelector('#view canvas') || document.querySelector('canvas'), free = () => document.getElementById('free').classList.contains('on'), was = free();" +
        " const down = new PointerEvent('pointerdown', {button: 1, buttons: 4, clientX: 300, clientY: 300, pointerId: 1, bubbles: true, cancelable: true}); c.dispatchEvent(down);" +
        " c.dispatchEvent(new PointerEvent('pointermove', {buttons: 4, clientX: 360, clientY: 340, pointerId: 1, bubbles: true}));" +
        " c.dispatchEvent(new PointerEvent('pointerup', {button: 1, clientX: 360, clientY: 340, pointerId: 1, bubbles: true}));" +
        " return {followedBefore: !was, followedAfter: !free(), prevented: down.defaultPrevented}; })()");
      check('the middle button does nothing in the viewer: its drag does not pan, its press is kept from autoscroll', mid && mid.followedBefore === mid.followedAfter && mid.prevented, JSON.stringify(mid));
      // the shots panel (19.11, BACKLOG 109): the 'hits' button of the own vehicle's row (the first of the left list) opens
      // the panel beside the list with his rows; a row's click opens its shot view (19.11, tests/page/shot_view.cjs): the battle 2 s
      // before that shot, paused while the view is prepared, the speed kept until the episode starts
      const sp = await page.evaluate("(() => { const row = document.querySelector('#list-own .veh'), b = row && row.querySelector('.sp-btn'); if (!b) return null; b.click();" +
        " const P = MapBench.shotsPanel(), box = P.element, r = box.getBoundingClientRect(), a = document.getElementById('list-own').getBoundingClientRect(), speed = MapBench.state().speed;" +
        " const first = box.querySelector('.sp-row .hit'); const out = {shown: P.shown(), count: P.count(), tile: !!row.querySelector('.vehicle-tile.compact'), beside: r.left - a.right, top: r.top - a.top, height: r.height - a.height};" +
        " if (first) { first.click(); var v = MapBench.shotView(); out.t = MapBench.state().t; out.speed = MapBench.state().speed === speed; out.open = !!(v && v.open); out.start = v && v.start; } return out; })()");
      check('the shots panel: the own row\'s hits button opens it beside the list, his rows in it; a row rewinds the battle, the speed kept', sp && sp.shown === OWN && sp.count > 0 && sp.tile &&
        sp.beside > 0 && sp.beside < 20 && Math.abs(sp.top) < 1 && Math.abs(sp.height) < 1 && Number.isFinite(sp.t) && sp.speed && sp.open && Math.abs(sp.t - sp.start) < 1e-6, JSON.stringify(sp));
      // the shot view made (or its reason said), then left: the checks below see the battle view
      for (let i = 0; i < 120; i++) { const m = await page.evaluate('(MapBench.shotView() || {}).mode'); if (m && m !== 'wait') break; await new Promise(function (r) { setTimeout(r, 500); }); }
      await page.evaluate("(() => { const b = document.querySelector('.sv-leave'); if (b) b.click(); })()");
      // round 13 (19.11.2026): every vehicle mesh drawn with the Hits look (flat faces, seams; a collision model's groups
      // in its group table), the team tint and foliage sliders in place of the see-through checkbox, and the slow speeds
      const r13 = await page.evaluate("(() => { const look = MapBench.vehicleLook();" +
        " document.querySelector('[data-speed=\"0.125\"]').click(); const slow = MapBench.state().speed; document.querySelector('[data-speed=\"1\"]').click();" +
        " return {look: look, tint: !!document.getElementById('rng-tint'), foliage: !!document.getElementById('rng-foliage'), oldBox: !!document.getElementById('sw-foliage'), slow: slow, speed: MapBench.state().speed}; })()");
      check('round 13: vehicles drawn flat with seams from their group tables, tint and foliage sliders, the old checkbox gone, speed 1/8 and back',
        r13 && r13.look.meshes >= 3 && r13.look.flat === r13.look.meshes && r13.look.grouped >= 3 && r13.tint && r13.foliage && !r13.oldBox && r13.slow === 0.125 && r13.speed === 1, JSON.stringify(r13));
      // round 14 (19.11.2026, the user in the game): the sky in the top line (20.11, the user on 1.14: on by default); with it off nothing fades
      // toward a pale colour - a black probe beyond the playable border, looked at above, along and below the horizon
      // through the page's own fog, stays black (it was the pale sky / horizon grey: the rim fade and the haze took the
      // sky's colours by direction whatever the sky switch said); with it on the sky above and the grey below
      const setSky = (on) => page.evaluate("(() => { const s = document.getElementById('sw-sky'); s.checked = " + on + "; s.dispatchEvent(new Event('change')); return MapBench.fogProbe(); })()");
      const skyDefault = await page.evaluate("(() => { const s = document.getElementById('sw-sky'); return s ? {checked: s.checked, top: !!s.closest('#topline'), grey: !!document.getElementById('sw-grey')} : null; })()");
      check('the sky switch in the top line, on by default (20.11); the grey switch gone', skyDefault && skyDefault.checked && skyDefault.top && !skyDefault.grey, JSON.stringify(skyDefault));
      const dark = await setSky(false), lit = await setSky(true);
      await setSky(false);
      const black = (c) => c && Math.max(c[0], c[1], c[2]) < 0.05;
      // (before the fix, sky off: up = the pale sky [0.62, 0.75, 0.89], along = the horizon grey [0.56, 0.58, 0.60])
      check('round 14: sky off (haze on) - the fade beyond the border is black above, along and below the horizon', dark && black(dark.up) && black(dark.horizon) && black(dark.below), JSON.stringify(dark));
      check('round 14: sky on - sky above, grey below the horizon', lit && lit.up && lit.up[2] > 0.6 && lit.below && lit.below[0] > 0.2 && lit.below[0] < 0.5 &&
        Math.abs(lit.below[2] - lit.below[0]) < 0.05, JSON.stringify(lit));
      // round 14: the vehicles' colour - a preset (steel grey by default) and a brightness beside the team tint
      const vc = await page.evaluate("(() => { const s = document.getElementById('sel-vcolor'), b = document.getElementById('rng-vbright'), t = document.getElementById('rng-tint'); if (!s || !b) return null;" +
        " const first = s.value, a = MapBench.vehicleLook().base; s.value = 'khaki'; s.dispatchEvent(new Event('change')); b.value = '1.5'; b.dispatchEvent(new Event('input')); const o = MapBench.vehicleLook().base;" +
        " s.value = first; s.dispatchEvent(new Event('change')); b.value = '1'; b.dispatchEvent(new Event('input'));" +
        " return {preset: first, near: s.parentNode.parentNode === t.parentNode.parentNode, steel: a, khaki: o}; })()");
      const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      check('round 14: vehicle colour by nation by default, steel grey its fallback (neutral, mid-dark), khaki and brightness change it, beside the team tint', vc && vc.preset === 'nation' && vc.near &&
        sat(vc.steel) < 0.03 && vc.steel[1] > 0.08 && vc.steel[1] < 0.3 && vc.khaki[1] > vc.steel[1] && vc.khaki[2] < vc.khaki[0], JSON.stringify(vc));
      // N7 (19.11, the user in 1.13: a wreck looked painted in Germany's grey): the wreck's hull tone is a burnt charcoal -
      // under half the luminance of the darkest nation paint (brightness 1), warm (red > green > blue)
      const look = await page.evaluate('MapBench.vehicleLook()');
      const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], darkest = Math.min.apply(null, look.nations.map((n) => lumOf(n.slice(1))));
      check('N7: a wreck is a warm charcoal, under half the luminance of the darkest nation paint (' + lumOf(look.wreck).toFixed(4) + ' against ' + darkest.toFixed(4) + ', linear)',
        lumOf(look.wreck) < darkest / 2 && look.wreck[0] > look.wreck[1] && look.wreck[1] > look.wreck[2], JSON.stringify({wreck: look.wreck, nations: look.nations}));
      // N8 (19.11, the user in 1.13): (a) the marks' sizes - N12 below; (b) a mark on a plate's edge ends
      // where the armour ends - MapBench.markEdge: a mark on the hull's outermost vertex to each side, drawn from straight
      // above with the hull alone; its pixels outside the hull's silhouette (the same camera) are counted
      // N12 (19.11, his correction of N8a): a mark's hole is its shell's calibre across, and on a sloped plate an ellipse whose
      // long axis over its short one is 1 / cos of the impact angle (the shell's section projected along its path), held to 10 (the user, 19.11)
      const marks = await page.evaluate('MapBench.hitsInfo()'), holes = (marks && marks.holes) || [];
      const withCal = holes.filter((h) => h.cal && h.short != null), cm = withCal.map((h) => h.short * 100);
      const badHole = withCal.filter((h) => Math.abs(h.short * 1000 - h.cal) > 0.01 * h.cal), badRatio = withCal.filter((h) => Math.abs(h.long / h.short - Math.min(1 / h.cos, 10)) > 0.02 * Math.min(1 / h.cos, 10));
      const capped = withCal.filter((h) => 1 / h.cos > 10).length, ratios = withCal.map((h) => h.long / h.short);
      check('N12: each of ' + withCal.length + ' marks with a calibre has a hole of its calibre (' + Math.min.apply(null, cm).toFixed(1) + '..' + Math.max.apply(null, cm).toFixed(1) +
        ' cm), long / short = 1/cos of the impact angle held to 10 (' + Math.min.apply(null, ratios).toFixed(2) + '..' + Math.max.apply(null, ratios).toFixed(2) + ', ' + capped + ' held); ' +
        (holes.length - withCal.length) + ' of ' + holes.length + ' marks without a calibre or a face under the centre (no calibre ' + (marks && marks.noCalibre) +
        ', stickers made out of view ' + (marks && marks.marksFromStickers) + '); cut onto the models in ' + (marks && marks.ms) + ' ms, not placed ' +
        JSON.stringify(marks && marks.notPlaced), withCal.length > 30 && !badHole.length && !badRatio.length,
        JSON.stringify({badHole: badHole.slice(0, 5), badRatio: badRatio.slice(0, 5), noCal: holes.filter((h) => !h.cal).slice(0, 5)}));
      const edge = await page.evaluate('MapBench.markEdge()');
      check('N8b: marks on the hull\'s outermost edges draw ' + (edge && edge.outside) + ' pixels outside its silhouette (' + (edge && edge.inside) + ' on it)',
        edge && edge.probes.length === 4 && edge.inside > 200 && edge.outside === 0, JSON.stringify(edge));
      // N9, N10 (19.11, the user in 1.13): a team row's tile has Hits' frame of a pressable tile, gold and filled while that
      // vehicle is followed; only one is; the 'shots' button beside the tile has its own frame, lit while its panel is open,
      // and pressing it also follows that vehicle; clicking a tile only follows
      const rowsState = "(() => { const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(); const tile = (row) => row.querySelector('.veh-tile') || row;" +
        " const rows = [].slice.call(document.querySelectorAll('.tlist .veh')); return rows.map((row, i) => { const t = tile(row), cs = getComputedStyle(t), l = row.parentNode.getBoundingClientRect(), r = t.getBoundingClientRect(), b = row.querySelector('.sp-btn');" +
        // R3 (20.11): the left side is Hits' team stripe (3 px, the team's colour, kept while followed), the frame the other three
        " const sides = ['Top', 'Right', 'Bottom'].every((s) => parseFloat(cs['border' + s + 'Width']) >= 1 && cs['border' + s + 'Color'] === cs.borderTopColor) && parseFloat(cs.borderLeftWidth) === 3;" +
        " const framed = sides && r.left >= l.left && r.right <= l.right && !t.contains(b);" +
        " return {i: i, follow: row.classList.contains('follow'), framed: framed, gold: framed && cs.borderTopColor === (function () { const d = document.createElement('i'); d.style.color = gold; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; })()," +
        " button: !!b && (b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true')}; }); })()";
      const clickRow = (i, what) => page.evaluate("(() => { const row = document.querySelectorAll('.tlist .veh')[" + i + "]; (" + (what === 'button' ? "row.querySelector('.sp-btn')" : "(row.querySelector('.veh-tile') || row)") + ").click(); })()");
      const summary = (s) => ({followed: s.filter((x) => x.follow).map((x) => x.i), gold: s.filter((x) => x.gold).map((x) => x.i), framed: s.filter((x) => x.framed).length, lit: s.filter((x) => x.button).map((x) => x.i), rows: s.length});
      await page.evaluate('MapBench.follow(null)'); if (await page.evaluate('!!(MapBench.shotsPanel().shown())')) await page.evaluate('MapBench.shotsPanel().close()');
      await clickRow(1, 'tile'); await clickRow(2, 'tile');
      const s1 = summary(await page.evaluate(rowsState));
      check('N9: every team row a framed tile; after clicking two rows only the second carries the followed mark (gold frame)', s1.framed === s1.rows && s1.followed.join() === '2' && s1.gold.join() === '2' && !s1.lit.length, JSON.stringify(s1));
      await clickRow(3, 'button');
      const s2 = summary(await page.evaluate(rowsState));
      check('N10: \'shots\' on a row lights its button and follows that vehicle, nothing else marked', s2.followed.join() === '3' && s2.gold.join() === '3' && s2.lit.join() === '3', JSON.stringify(s2));
      await clickRow(1, 'tile');
      const s3 = summary(await page.evaluate(rowsState));
      check('N10: a tile\'s click then follows its vehicle only; the open panel\'s button stays lit', s3.followed.join() === '1' && s3.gold.join() === '1' && s3.lit.join() === '3', JSON.stringify(s3));
      await clickRow(3, 'button'); await page.evaluate('MapBench.follow(null)');
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
