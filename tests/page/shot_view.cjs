/* The replay viewer's shot view (19.11.2026, NOTEBOOK N5, BACKLOG 109) on the user's battle of 14.11 on Malinovka.
 *
 *   node tests/page/shot_view.cjs
 *
 * 1. The mod's code makes the viewer's inputs, as tests/page/playback_page.cjs does (tests/py27/playback_job.py --stage under
 *    the client's python27.dll, tests/fixtures-local/playback-2026-11-18); beside them the battle Bullba Hits published from
 *    this replay (tests/fixtures-local/shot-view-2026-11-19: data/battles/<id>.js with every hit's replayScene, the shared
 *    definitions it names, the models beyond the first fixture's - copies of the game folder's files) and data/index.js
 *    listing it.
 * 2. The page as it ships (web/ copied, the folder layout of CFG) in a local headless Chrome, as in the game (#host=game,
 *    a stand-in jsHostQuery answering as the mod). The player's own vehicle's shots panel is opened and its first shot with
 *    a hit that Hits' record lists is clicked - the panel's own row button.
 * Checks: the shot view opens on Bullba Hits' viewer (mode 'hits'): Hits' heat map composed on the target (the composition
 * ran, its faces > 0, pixels of the overlay coloured), the episode plays at 1/4 and stops paused at the hit event's time,
 * the hit line held before the hit and shown at it; the camera at the hit stands near the tracer's start (the figure
 * printed); Replay episode goes back to 2 s before the shot without moving Hits' camera; Leave gives the free camera and
 * the speed back, the target drawn again; no page or console error.
 * The one number printed: faces of the target in Hits' composition, the coloured pixels, the pause time against the hit
 * time, the eye's distance from the tracer's start.
 * No fixture, no client packages or no browser: SKIP (exit 77).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), {spawnSync} = require('child_process');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTLE = '2315856430906286521-d36eff9b31bb';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures-local', 'playback-2026-11-18');
const HITS = path.join(ROOT, 'tests', 'fixtures-local', 'shot-view-2026-11-19');
const PYTHON = process.env.BULLBA_PYTHON || 'python';
let checks = 0, failed = 0, skipped = null;
function check(name, ok, detail) { checks++; if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); } }
function skip(text) { skipped = text; throw new Error('skip'); }
function copyDir(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const e of fs.readdirSync(from, {withFileTypes: true})) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the game's channel (web/host.js window.jsHostQuery) answering as the mod, as tests/page/playback_page.cjs does
const HOST = `(function () {
  // the test seam of tests/page/gpu_bounce.cjs: WEBGL_debug_renderer_info hidden, so Hits' software-WebGL guard (a performance
  // gate, not a correctness one) lets SwiftShader run Hits' composition; nothing in web/ is changed for the test
  var get = WebGL2RenderingContext.prototype.getExtension;
  WebGL2RenderingContext.prototype.getExtension = function (name) { return name === 'WEBGL_debug_renderer_info' ? null : get.call(this, name); };
  window.__host = [];
  window.jsHostQuery = function (q) {
    var c = JSON.parse(q.request), p = c.params || {};
    window.__host.push(p.action);
    setTimeout(function () { q.onSuccess('ok'); }, 0);
    var say = function (note) { setTimeout(function () { window.BullbaPlayback && window.BullbaPlayback.notify(note); }, 50); };
    if (p.action === 'mapRaw') { say({kind: 'map', arena: p.arena, state: 'queued'}); say({kind: 'map', arena: p.arena, state: 'ready'}); }
    if (p.action === 'playback') say({kind: 'playback', id: p.battleId, state: 'ready'});
  };
})();`;
async function until(page, expr, ms) {
  for (let waited = 0; waited < ms; waited += 250) { let v = null; try { v = await page.evaluate(expr); } catch (e) { v = null; } if (v) return v; await sleep(250); }
  return null;
}

(async function main() {
  if (!fs.existsSync(FIXTURE) || !fs.existsSync(HITS)) { console.log('SKIP no fixture ' + (fs.existsSync(FIXTURE) ? HITS : FIXTURE)); process.exit(77); }
  const stage = path.join(os.tmpdir(), 'bullba-shot-view-' + crypto.randomUUID());
  fs.mkdirSync(stage, {recursive: true});
  let browser = null;
  try {
    const run = spawnSync(PYTHON, ['-I', path.join(ROOT, 'tests', 'py27', 'run27.py'), 'tests/py27/playback_job.py', '--stage', stage],
      {cwd: ROOT, encoding: 'utf-8', timeout: 240000, windowsHide: true});
    if (run.status === 77) skip('the mod job: ' + String(run.stdout || '').trim().split('\n').pop());
    check('the mod job made the playback file and the map raw files', run.status === 0, String(run.stdout || '') + String(run.stderr || '').slice(-600));
    if (run.status !== 0) return;
    copyDir(path.join(ROOT, 'web'), path.join(stage, 'web'));
    copyDir(path.join(HITS, 'data'), path.join(stage, 'data'));
    copyDir(path.join(HITS, 'definitions'), path.join(stage, 'definitions'));
    fs.writeFileSync(path.join(stage, 'data', 'index.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['index', {application: 'local.armor_inspector', version: 'test',
      battles: [{id: BATTLE, startedAt: 1795000000, hits: 37, map: 'Malinovka', vehicle: {name: 'Pz. Neu', type: 'germany:G197_Pz_Kpfw_Neu'}}]}]) + ');\n');
    browser = await launch({width: 1280, height: 720});
    if (!browser) skip('no Chrome or Edge on this machine');
    const page = await browser.open('file:///' + path.join(stage, 'web', 'playback.html').replace(/\\/g, '/') + '#host=game&battle=' + BATTLE, HOST);
    const ready = await until(page, 'window.__error ? {error: window.__error} : (window.__ready || null)', 240000);
    check('the viewer reports ready', ready && !ready.error, ready ? ready.error : 'not ready after 240 s');
    if (!ready || ready.error) return;
    // the own vehicle's shots: the first shot with a hit; the panel's own row button is clicked
    const own = ready.ownId;
    const rows = await page.evaluate('MapBench.shotRows(' + own + ').filter(function (r) { return r.kind === "shot" && r.hits.length && r.hits[0].attacker != null; }).map(function (r) { return {key: r.key, t: r.t, start: r.shot.start, hit: r.hits.filter(function (h) { return h.damage > 0; }).concat(r.hits.slice(-1))[0]}; })');
    check('the own vehicle has shots with a hit in the replay', rows && rows.length > 0, JSON.stringify(rows && rows.length));
    let opened = null, row = null;
    // the panel by the own team row's shots button, which also makes the camera follow that vehicle (playback.js renderList)
    const followed = await page.evaluate('(function () { document.querySelector("#list-own .sp-btn").click(); return !document.getElementById("free").classList.contains("on"); })()');
    check('the shots button opens the panel and follows the vehicle', followed && await page.evaluate('MapBench.shotsPanel().shown() === ' + own));
    for (const r of rows || []) {
      await page.evaluate('document.querySelector(\'.shots-panel .hit[data-key="' + r.key + '"]\').click()');
      const s = await until(page, 'var s = MapBench.shotView(); s && (s.mode === "hits" || s.mode === "replay") ? s : null', 60000);
      if (s && s.mode === 'hits') { opened = s; row = r; break; }
    }
    check('a shot opens in Bullba Hits’ view (its hit found in Hits’ record, its scene rebuilt from the replay)', !!opened, JSON.stringify(opened));
    if (!opened) return;
    const first = await page.evaluate('MapBench.shotView()');
    check('the shot view takes the camera over: no vehicle followed', await page.evaluate('document.getElementById("free").classList.contains("on")'));
    check('the episode starts 2 s before the shot, playing at 1/4, the hit line held', Math.abs(first.start - Math.max(0, row.t - 2)) < 1e-6 && first.speed === 0.25 && first.shotHeld && Math.abs(first.stop - row.hit.t) < 1e-9,
      JSON.stringify({start: first.start, t: row.t, speed: first.speed, held: first.shotHeld, stop: first.stop, hit: row.hit.t}));
    // the stop at the hit
    const stopped = await until(page, 'var s = MapBench.shotView(); s && !s.playing && !s.armed ? s : null', 90000);
    check('the episode stops paused at the hit event’s time, the hit line shown', stopped && Math.abs(stopped.t - stopped.hitT) < 1e-9 && !stopped.shotHeld,
      JSON.stringify(stopped && {t: stopped.t, hit: stopped.hitT, held: stopped.shotHeld}));
    // Hits' heat map on the target: the composition ran; the overlay's pixels drawn now, read back in the same task
    const heat = await page.evaluate('(function () { var V = MapBench.shotViewer(); V.frameId = 1; V.frameRender(); var gl = V.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);' +
      ' gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); var drawn = 0, coloured = 0; for (var i = 0; i < px.length; i += 4) { if (px[i + 3] < 8) continue; drawn++;' +
      ' if (Math.max(px[i], px[i + 1]) > px[i + 2] + 50) coloured++; } var s = MapBench.shotView(); return {drawn: drawn, coloured: coloured, faces: s.faces, composed: s.composed, leg: s.ricochetLeg, backend: s.backend, shell: s.shell, aim: s.aim, note: s.note}; })()');
    check('Hits’ heat map is composed on the target: ' + heat.faces + ' faces in the composition, ' + heat.coloured + ' of ' + heat.drawn + ' overlay pixels coloured', heat.composed && heat.faces > 0 && heat.coloured > 0,
      JSON.stringify(heat));
    const eye = stopped ? await page.evaluate('(function () { var s = MapBench.shotView(); return s.eye; })()') : null;
    const gap = eye ? Math.hypot(eye[0] - row.start[0], eye[1] - row.start[1], eye[2] - row.start[2]) : NaN;
    check('at the hit the camera stands near the tracer’s start: ' + gap.toFixed(2) + ' m', gap < 5, JSON.stringify({eye: eye, start: row.start}));
    // Replay episode: Hits' camera stays
    const camBefore = await page.evaluate('(function () { var V = MapBench.shotViewer(); return [V.yaw, V.pitch, V.distance, V.camera.zoom]; })()');
    await page.evaluate('document.querySelector(".sv-again").click()');
    await sleep(400);
    const again = await page.evaluate('(function () { var s = MapBench.shotView(), V = MapBench.shotViewer(); s.cam = [V.yaw, V.pitch, V.distance, V.camera.zoom]; return s; })()');
    check('Replay episode: back before the hit, playing, the hit line held, Hits’ camera where it was', again.playing && again.t < again.stop && again.t >= again.start && again.shotHeld &&
      again.cam.every((x, i) => Math.abs(x - camBefore[i]) < 1e-9), JSON.stringify({t: again.t, playing: again.playing, held: again.shotHeld, cam: again.cam, before: camBefore}));
    // Leave: the free camera, the user's speed, the target drawn by the replay again
    await page.evaluate('document.querySelector(".sv-leave").click()');
    await sleep(300);
    const left = await page.evaluate('(function () { var s = MapBench.shotView(), c = document.querySelector(".sv-layer"); return {open: s.open, speed: s.speed, layer: c.hidden, bar: document.querySelector(".sv-bar").hidden, cam: MapBench.camera(), free: document.getElementById("free").classList.contains("on")}; })()');
    await sleep(600);
    const stillFree = await page.evaluate('document.getElementById("free").classList.contains("on")');
    check('Leave: the shot view closed, Hits’ layer and the bar hidden, the speed back to x1, the camera free (not following)', !left.open && left.layer && left.bar && left.speed === 1 && left.free && stillFree, JSON.stringify(left));
    // a shot with no hit in the replay: no Hits view; the episode with this page's camera at the tracer's start, stopped at its end
    const miss = await page.evaluate('(function () { var r = MapBench.shotRows(' + own + ').filter(function (r) { return r.kind === "shot" && !r.hits.length && r.shot; })[0]; return r ? {key: r.key, start: r.shot.start, end: r.shot.tEnd} : null; })()');
    if (miss) {
      await page.evaluate('document.querySelector(\'.shots-panel .hit[data-key="' + miss.key + '"]\').click()');
      const m = await until(page, 'var s = MapBench.shotView(); s && s.mode === "replay" && !s.playing && !s.armed ? s : null', 90000);
      const mgap = m ? Math.hypot(m.eye[0] - miss.start[0], m.eye[1] - miss.start[1], m.eye[2] - miss.start[2]) : NaN;
      check('a shot with no hit: the episode without Hits’ view, stopped at its tracer’s end, the camera at its start (' + mgap.toFixed(2) + ' m), the reason said',
        m && Math.abs(m.t - miss.end) < 1e-9 && mgap < 0.5 && /no vehicle this shot hit/.test(m.note), JSON.stringify(m && {t: m.t, end: miss.end, note: m.note, gap: mgap}));
      await page.evaluate('document.querySelector(".sv-leave").click()');
    } else console.log('note no shot without a hit among the own vehicle’s rows: the path without Hits’ view not exercised');
    console.log('note the shot view: ' + heat.faces + ' faces of the target in Hits’ composition, ' + heat.coloured + ' coloured pixels; paused at ' + (stopped ? stopped.t.toFixed(3) : '-') +
      ' s, the hit at ' + (stopped ? stopped.hitT.toFixed(3) : '-') + ' s; the eye ' + gap.toFixed(2) + ' m from the tracer’s start; shell ' + JSON.stringify(heat.shell) + '; aim ' + heat.aim);
    // A REPLAY FILE WITH NO HITS BATTLE (the owner, 19.11: the shot view for any replay the viewer opens): the same battle as
    // a file of the viewer's list ('f-' id, its playback file copied under it, as playback_page.cjs copies one), no Hits battle
    // of it in the index. The row's click asks the mod 'prepareBattle' with the file's id; the mod's route (Exporter.
    // request_battle -> request_replay_battle -> the 'replay' job: tests/py27/replay_file_battle.py) makes the battle from the
    // replay; here the stand-in mod answers that request with what that route writes - the battle file Bullba Hits made from
    // this replay (the fixture, its id the file's) and the index listing it - and the page goes on by its own look at the index.
    const FID = 'f-0123456789abcdef', pbDir = path.join(stage, 'data', 'playback');
    for (const ext of ['.js', '.src.js']) fs.writeFileSync(path.join(pbDir, FID + ext), fs.readFileSync(path.join(pbDir, BATTLE + ext), 'utf8').split(BATTLE).join(FID));
    fs.writeFileSync(path.join(stage, 'data', 'index.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['index', {application: 'local.armor_inspector', version: 'test', battles: []}]) + ');\n');
    await page.evaluate("window.__ready = null; window.__host = []; location.hash = 'host=game&battle=" + FID + "'; location.reload()");
    const ready2 = await until(page, "location.hash.indexOf('" + FID + "') >= 0 ? (window.__error ? {error: window.__error} : (window.__ready || null)) : null", 240000);
    check('a replay file with no Hits battle opens', ready2 && !ready2.error, ready2 ? ready2.error : 'not ready');
    if (ready2 && !ready2.error) {
      await page.evaluate('document.querySelector("#list-own .sp-btn").click()');
      await page.evaluate('document.querySelector(\'.shots-panel .hit[data-key="' + row.key + '"]\').click()');
      const asked = await until(page, '(window.__host || []).indexOf("prepareBattle") >= 0', 20000);
      check('the shot view asks the mod for the Hits battle of the replay file (prepareBattle with its id)', !!asked);
      const waiting = await page.evaluate('MapBench.shotView().note');
      // the mod's route done: its battle file and the index
      fs.writeFileSync(path.join(stage, 'data', 'battles', FID + '.js'), fs.readFileSync(path.join(HITS, 'data', 'battles', BATTLE + '.js'), 'utf8').split(BATTLE).join(FID));
      fs.writeFileSync(path.join(stage, 'data', 'index.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['index', {application: 'local.armor_inspector', version: 'test',
        battles: [{id: FID, startedAt: 1795000000, hits: 37, map: 'Malinovka'}]}]) + ');\n');
      const n = await until(page, 'var s = MapBench.shotView(); s && (s.mode === "hits" || s.mode === "replay") ? s : null', 60000);
      const nstop = n && n.mode === 'hits' ? await until(page, 'var s = MapBench.shotView(); s && !s.playing && !s.armed ? s : null', 90000) : null;
      const nheat = nstop ? await page.evaluate('(function () { var V = MapBench.shotViewer(); V.frameId = 1; V.frameRender(); var gl = V.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);' +
        ' gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); var coloured = 0; for (var i = 0; i < px.length; i += 4) if (px[i + 3] >= 8 && Math.max(px[i], px[i + 1]) > px[i + 2] + 50) coloured++; return coloured; })()') : 0;
      check('then the Hits battle made from the replay: its target carries Hits\u2019 heat map (' + (nstop && nstop.faces) + ' faces, ' + nheat + ' pixels coloured), paused at the hit',
        /making its battle from this replay/.test(waiting) && nstop && nstop.composed && nstop.faces > 0 && nheat > 0 && Math.abs(nstop.t - nstop.hitT) < 1e-9, JSON.stringify({waiting: waiting, state: nstop || n}));
      await page.evaluate('(function () { var b = document.querySelector(".sv-leave"); if (b) b.click(); })()');
    }
    const errors = page.errors.slice(), consoleErrors = page.console.filter(function (l) { return /^(error|assert)|^log error/.test(l); });
    check('no page error', !errors.length, errors.join(' | ').slice(0, 800));
    check('no console error', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 800));
  } catch (e) {
    if (!skipped) check('the harness ran', false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(stage, {recursive: true, force: true}); break; } catch (e) { await sleep(300); } }
    if (skipped) { console.log('SKIP ' + skipped); process.exitCode = 77; return; }
    console.log('shot_view: ' + checks + ' checks, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  }
})();
