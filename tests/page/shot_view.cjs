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
  // ONE PICTURE (20.11): every WebGL context a canvas of the page makes is counted
  var getContext = HTMLCanvasElement.prototype.getContext; window.__contexts = 0;
  HTMLCanvasElement.prototype.getContext = function (type) { var c = getContext.apply(this, arguments); if (c && /webgl/.test(String(type)) && !this.__counted) { this.__counted = true; window.__contexts++; } return c; };
  window.__host = []; window.__lines = [];
  window.jsHostQuery = function (q) {
    var c = JSON.parse(q.request), p = c.params || {};
    window.__host.push(p.action);
    if (p.action === 'inputLog') window.__lines = window.__lines.concat(p.lines || []);
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
    // the battle view as it is before the shot view opens: the lens, every shadow-casting mesh's material, the colour writes
    const LOOKS = '(function () { var O = MapBench.shotObjects(-1), c = O.camera, mats = {}, writes = 0; O.scene.traverse(function (m) { if (m.isMesh && m.castShadow && m.material) { mats[m.uuid] = m.material.uuid; if (m.material.colorWrite) writes++; } });' +
      ' return {lens: {fov: c.fov, zoom: c.zoom, near: c.near, far: c.far}, mats: mats, writes: writes}; })()';
    const before = await page.evaluate(LOOKS);
    for (const r of rows || []) {
      await page.evaluate('document.querySelector(\'.shots-panel .hit[data-key="' + r.key + '"]\').click()');
      const s = await until(page, 'var s = MapBench.shotView(); s && (s.mode === "hits" || s.mode === "replay") ? s : null', 60000);
      if (s && s.mode === 'hits') { opened = s; row = r; break; }
    }
    check('a shot opens in Bullba Hits’ view (its hit found in Hits’ record, its scene rebuilt from the replay)', !!opened, JSON.stringify(opened));
    if (!opened) return;
    const first = await page.evaluate('MapBench.shotView()');
    const TARGET = row.hit.target, SHOOTER = own;
    check('the shot view takes the camera over: no vehicle followed', await page.evaluate('document.getElementById("free").classList.contains("on")'));
    check('the episode starts 2 s before the shot, playing at 1/4, the hit line held', Math.abs(first.start - Math.max(0, row.t - 2)) < 1e-6 && first.speed === 0.25 && first.shotHeld && Math.abs(first.stop - row.hit.t) < 1e-9,
      JSON.stringify({start: first.start, t: row.t, speed: first.speed, held: first.shotHeld, stop: first.stop, hit: row.hit.t}));
    // the lens: Hits' field of view and the zoom of Hits' Fit, the eye not moved off the shot's origin
    check('the lens is Hits’: field of view ' + first.lens.fov + '°, zoom ×' + first.lens.zoom.toFixed(2) + ' by Hits’ Fit', first.lens.fov === 38 && first.lens.zoom >= 1, JSON.stringify(first.lens));
    // the stop at the hit
    const stopped = await until(page, 'var s = MapBench.shotView(); s && !s.playing && !s.armed ? s : null', 90000);
    check('the episode stops paused at the hit event’s time, the hit line shown', stopped && Math.abs(stopped.t - stopped.hitT) < 1e-9 && !stopped.shotHeld,
      JSON.stringify(stopped && {t: stopped.t, hit: stopped.hitT, held: stopped.shotHeld}));
    await sleep(500);   // the pose has stood still: Hits' engine committed in this page's pose (hostPose)
    // ONE PICTURE: one WebGL context on the page, one canvas drawing the scene
    const one = await page.evaluate('({contexts: window.__contexts, canvases: Array.prototype.filter.call(document.querySelectorAll("canvas"), function (c) { return !!c.__counted; }).length})');
    check('one renderer: ' + one.contexts + ' WebGL context(s), ' + one.canvases + ' canvas(es) drawing the scene', one.contexts === 1 && one.canvases === 1, JSON.stringify(one));
    // THE PAINT LIES ON THE REPLAY'S OWN DRAWING OF THE TARGET. Frames of the same moment, read back in one task: P the shot
    // view (no Hits marks), R the target in its own look, Q the target flat magenta, H the target not drawn (its shadow kept).
    // The silhouette = Q differs from H (antialiased edges included); painted = P differs from R.
    const DIFF = 'function diff(a, b, i) { return Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6; }';
    const SETUP = '(function () { var T = THREE, id = ' + TARGET + '; ' + DIFF + ' var mask = new T.MeshBasicMaterial({color: 0xff00ff, fog: false}), none = new T.MeshBasicMaterial({colorWrite: false, depthWrite: false});' +
      ' function sil(add) { var Q = MapBench.shotFrame(id, {mask: mask, add: add}), H = MapBench.shotFrame(id, {mask: none, add: add}), s = new Uint8Array(Q.length / 4); for (var i = 0; i < Q.length; i += 4) s[i / 4] = diff(Q, H, i) ? (Q[i] > 250 && Q[i + 1] < 5 && Q[i + 2] > 250 ? 2 : 1) : 0; return s; }';
    const reg = await page.evaluate(SETUP + ' var s = sil(), P = MapBench.shotFrame(id, {overlay: false}), P2 = MapBench.shotFrame(id, {overlay: false}), R = MapBench.shotFrame(id, {paint: false, overlay: false}),' +
      ' rt = MapBench.shotViewer().hosted.paintTarget(), w = rt.width, h = rt.height, tex = new Uint8Array(w * h * 4); MapBench.shotObjects(id).renderer.readRenderTargetPixels(rt, 0, 0, w, h, tex);' +
      ' var o = {silhouette: 0, painted: 0, outside: 0, coloured: 0, noise: 0, mapOutside: 0, size: [w, h]};' +
      ' for (var i = 0; i < P.length; i += 4) { var k = s[i / 4]; if (k) o.silhouette++; if (diff(P, P2, i)) o.noise++; if (diff(P, R, i)) { o.painted++; if (!k) o.outside++; }' +
      '  if (k && Math.max(P[i], P[i + 1]) > P[i + 2] + 50) o.coloured++; if (!k && tex[i + 3] > 8) o.mapOutside++; } return o; })()');
    check('Hits’ heat map lies on the replay’s own target: ' + reg.painted + ' pixels painted (' + reg.coloured + ' in heat colours) inside its silhouette of ' + reg.silhouette + ', ' + reg.outside + ' outside it' +
      ' (a layer over the picture would have shown ' + reg.mapOutside + ' map pixels outside)', reg.silhouette > 0 && reg.painted > 0 && reg.coloured > 0 && reg.outside === 0 && reg.noise === 0, JSON.stringify(reg));
    // THE SHOT'S CORRIDOR: what of the map is drawn on the shot's line, from the eye to the hit (a ray along it, the drawn
    // objects only - every ancestor visible; the terrain, the water, the tracers, the shooter and the target not counted)
    const ON_LINE = '(function () { var T = THREE, O = MapBench.shotObjects(' + TARGET + '), c = MapBench.shotView().corridor || window.__line; if (!c) return null; window.__line = c;' +
      ' var a = new T.Vector3().fromArray(c.a), b = new T.Vector3().fromArray(c.b), L = O.layers, ray = new T.Raycaster(a, b.clone().sub(a).normalize(), 0, a.distanceTo(b) - 0.3); ray.camera = O.camera;' +
      ' var skip = [L.terrain, L.water, L.tracers, L.helpers, O.group, MapBench.shotObjects(' + SHOOTER + ').group];' +
      ' function drawn(x) { for (var p = x; p; p = p.parent) { if (!p.visible || skip.indexOf(p) >= 0) return false; } return true; }' +
      ' var hits = ray.intersectObject(O.scene, true).filter(function (h) { return !h.object.isSprite && !h.object.isLine && drawn(h.object); });' +
      ' return {count: hits.length, names: hits.slice(0, 6).map(function (h) { return (h.object.name || h.object.type) + (h.instanceId != null ? "#" + h.instanceId : "") + " @" + h.distance.toFixed(1); })}; })()';
    const cor = await page.evaluate('MapBench.shotView().corridor'), lineNow = await page.evaluate(ON_LINE);
    check('the shot’s corridor (' + (cor && cor.radius) + ' m round the line from the eye to the hit): ' + (cor && cor.hidden) + ' objects not drawn (' + JSON.stringify(cor && {models: cor.models, plants: cor.plants, mode: cor.modeObjects, vehicles: cor.vehiclesHidden}) +
      '), ' + (lineNow && lineNow.count) + ' drawn objects left on the line', cor && cor.hidden > 0 && lineNow && lineNow.count === 0, JSON.stringify({cor: cor, line: lineNow}));
    console.log('note the corridor hid: ' + JSON.stringify(cor && cor.list) + '; the ground across the line: ' + (cor && cor.ground) + '; broken before this moment by the replay: ' + (cor && cor.destroyedAlready) + ' (time ' + (cor && cor.t) + ' s)');
    // the painted target at Fit against the target alone on the terrain (no map objects, no other vehicle). Round the hit, inside
    // the corridor's own width as it is seen at the target (R at the hit's distance, in screen pixels), every pixel the
    // target covers whole there is painted in the shot view: nothing on the shot's line hides it. Beyond that width the
    // map's objects off the line still stand in front, as anywhere (the figure printed).
    const bare = await page.evaluate(SETUP + ' var O = MapBench.shotObjects(id), c = O.camera, cr = MapBench.shotView().corridor, gl = O.renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;' +
      ' var b = new T.Vector3().fromArray(cr.b), d = b.distanceTo(c.position), q = b.clone().project(c), cx = (q.x + 1) / 2 * W, cy = (q.y + 1) / 2 * H;' +
      ' var rpx = cr.radius / (d * Math.tan(c.fov * Math.PI / 360) / c.zoom) * H / 2;' +
      ' var Q = MapBench.shotFrame(id, {mask: mask, bare: true}), P = MapBench.shotFrame(id, {overlay: false}), R = MapBench.shotFrame(id, {paint: false, overlay: false}), o = {core: 0, painted: 0, discCore: 0, discPainted: 0, discRadius: +rpx.toFixed(1)};' +
      ' for (var i = 0; i < Q.length; i += 4) { var whole = Q[i] > 250 && Q[i + 1] < 5 && Q[i + 2] > 250, p = diff(P, R, i), x = (i / 4) % W, y = Math.floor(i / 4 / W), inDisc = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rpx;' +
      '  if (whole) o.core++; if (p) o.painted++; if (whole && inDisc) { o.discCore++; if (p) o.discPainted++; } } return o; })()');
    check('the painted target at Fit: round the hit (the corridor seen at the target, ' + bare.discRadius + ' px) ' + bare.discPainted + ' of ' + bare.discCore + ' pixels the target covers painted; in all ' + bare.painted +
      ' painted of ' + bare.core + ' the target alone on the terrain covers', bare.discCore > 0 && bare.discPainted === bare.discCore, JSON.stringify(bare));
    // A WALL between the eye and the target hides it: an opaque board half-way, square to the view, 60 m wide
    const wall = await page.evaluate(SETUP + ' var O = MapBench.shotObjects(id), c = O.camera, g = O.group.getWorldPosition(new T.Vector3()), d = g.clone().sub(c.position);' +
      ' var board = new T.Mesh(new T.PlaneGeometry(60, 60), new T.MeshBasicMaterial({color: 0x404040, side: T.DoubleSide})); board.position.copy(c.position).addScaledVector(d, 0.5); board.lookAt(c.position); board.updateMatrixWorld(true);' +
      ' var s = sil([board]), P = MapBench.shotFrame(id, {overlay: false, add: [board]}), R = MapBench.shotFrame(id, {paint: false, overlay: false, add: [board]}), n = 0, sn = 0;' +
      ' for (var i = 0; i < P.length; i += 4) { if (s[i / 4]) sn++; if (diff(P, R, i)) n++; } return {silhouetteSeen: sn, paintedSeen: n, distance: d.length()}; })()');
    check('a wall between the eye and the target hides it: ' + wall.paintedSeen + ' painted pixels and ' + wall.silhouetteSeen + ' of its silhouette seen behind a board ' + (wall.distance / 2).toFixed(1) + ' m from the eye',
      wall.paintedSeen === 0 && wall.silhouetteSeen === 0, JSON.stringify(wall));
    // A TRANSPARENT SHEET BEHIND the target does not show through it; around it, it is seen
    const sheet = await page.evaluate(SETUP + ' var O = MapBench.shotObjects(id), c = O.camera, g = O.group.getWorldPosition(new T.Vector3()), d = g.clone().sub(c.position).normalize();' +
      ' var b = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshBasicMaterial({color: 0x00ff40, transparent: true, opacity: 0.6, depthWrite: false, side: T.DoubleSide})); b.position.copy(g).addScaledVector(d, 8); b.lookAt(c.position); b.updateMatrixWorld(true);' +
      ' var s = sil(), P = MapBench.shotFrame(id, {overlay: false}), B = MapBench.shotFrame(id, {overlay: false, add: [b]}), inside = 0, outside = 0;' +
      ' for (var i = 0; i < P.length; i += 4) if (diff(P, B, i)) { if (s[i / 4] === 2) inside++; else if (!s[i / 4]) outside++; } return {inside: inside, outside: outside}; })()');
    // (the target's own pixels: those it covers whole; an antialiased edge pixel is part background and shows what is behind)
    check('a transparent sheet behind the target does not show through it: ' + sheet.inside + ' target pixels changed (' + sheet.outside + ' around it)', sheet.inside === 0 && sheet.outside > 0, JSON.stringify(sheet));
    // Hits' marks over the picture: the hit line through the model (on the target's pixels)
    const marks = await page.evaluate(SETUP + ' var s = sil(), P = MapBench.shotFrame(id, {overlay: false}), L = MapBench.shotFrame(id), on = 0, off = 0;' +
      ' for (var i = 0; i < P.length; i += 4) if (diff(P, L, i)) { if (s[i / 4]) on++; else off++; } return {onTarget: on, elsewhere: off}; })()');
    check('Hits’ hit line is drawn over the painted target: ' + marks.onTarget + ' pixels on it, ' + marks.elsewhere + ' beside it', marks.onTarget > 0, JSON.stringify(marks));
    // the target still casts its shadow with the paint on: this page's own check of the cascades' maps (vehicleShadowInfo:
    // the map's depth above the vehicle against the static cache's - unequal = the vehicle is drawn into the shadow map)
    const shadow = await page.evaluate('(function () { MapBench.shotFrame(' + TARGET + ', {overlay: false}); var i = MapBench.shotObjects(' + TARGET + ').index, row = MapBench.vehicleShadowInfo().filter(function (r) { return r.i === i; })[0]; return row || null; })()');
    check('the painted target casts its shadow: ' + JSON.stringify(shadow && shadow.cascades), !!(shadow && shadow.cascades.some((c) => c && c.vehicleIn === true)), JSON.stringify(shadow));
    if (process.env.BULLBA_SHOT_PNG) { const png = await page.evaluate('(function () { MapBench.shotFrame(' + TARGET + '); return MapBench.shotObjects(' + TARGET + ').renderer.domElement.toDataURL("image/png"); })()'); fs.writeFileSync(process.env.BULLBA_SHOT_PNG, Buffer.from(png.split(',')[1], 'base64')); }
    const heat = await page.evaluate('MapBench.shotView()');
    check('Hits’ composition for this camera: ' + heat.faces + ' faces, the engine in this page’s pose: ' + heat.posed + ', backend: ' + heat.backend, heat.composed && heat.faces > 0 && heat.posed, JSON.stringify(heat));
    const eye = stopped ? await page.evaluate('(function () { var s = MapBench.shotView(); return s.eye; })()') : null;
    const gap = eye ? Math.hypot(eye[0] - row.start[0], eye[1] - row.start[1], eye[2] - row.start[2]) : NaN;
    check('at the hit the camera stands near the tracer’s start: ' + gap.toFixed(2) + ' m; the shooter not drawn (the eye inside it)', gap < 5 && heat.shooterHidden === true, JSON.stringify({eye: eye, start: row.start, hidden: heat.shooterHidden}));
    // the episode's frame times: in the state, and one line to the mod's log
    const lines = await page.evaluate('window.__lines || []');
    check('the episode’s frame times are logged once: ' + JSON.stringify(heat.frames), heat.logged && heat.frames && heat.frames.frames > 0 &&
      lines.filter((l) => /^shot view with Hits’ map/.test(l) && /frame time median/.test(l)).length === 1, JSON.stringify(lines));
    // the wheel zooms the lens by Hits' rule; the eye stays
    const z0 = await page.evaluate('MapBench.shotView()');
    await page.evaluate('MapBench.shotObjects(' + TARGET + ').renderer.domElement.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true, deltaY: -100, clientX: 400, clientY: 300}))');
    const z1 = await page.evaluate('(function () { var s = MapBench.shotView(); s.cam = MapBench.camera(); return s; })()');
    check('the wheel zooms the lens (×' + z0.lens.zoom.toFixed(2) + ' -> ×' + z1.lens.zoom.toFixed(2) + '), the eye stays', z1.lens.zoom > z0.lens.zoom * 1.1 && Math.hypot(z1.eye[0] - z0.eye[0], z1.eye[1] - z0.eye[1], z1.eye[2] - z0.eye[2]) < 1e-6,
      JSON.stringify({before: z0.lens, after: z1.lens}));
    await page.evaluate('document.querySelector(".sv-fit").click()');
    const zf = await page.evaluate('MapBench.shotView().lens');
    await page.evaluate('document.querySelector(".sv-fit").click()');
    const zf2 = await page.evaluate('MapBench.shotView().lens');
    // (at the opening Fit frames the target where the record has it at the hit; now where this page draws it)
    check('Fit frames the target again by Hits’ Fit: ×' + zf.zoom.toFixed(2) + ' (the wheel’s ×' + z1.lens.zoom.toFixed(2) + ' undone, the same on a second press)', zf.zoom >= 1 && Math.abs(zf.zoom - z1.lens.zoom) > 1e-3 && Math.abs(zf2.zoom - zf.zoom) < 1e-9, JSON.stringify({fit: zf, again: zf2, first: z0.lens}));
    // A CLICK ON THE TARGET pins a line through it: Hits' pinAt through this camera, its reading in Hits' words
    const at = await page.evaluate('(function () { var V = MapBench.shotViewer(), p = V.point.clone().project(V.camera), r = MapBench.shotObjects(' + TARGET + ').renderer.domElement.getBoundingClientRect();' +
      ' return {x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height}; })()');
    await page.evaluate('(function () { var c = MapBench.shotObjects(' + TARGET + ').renderer.domElement, o = {bubbles: true, clientX: ' + at.x + ', clientY: ' + at.y + ', button: 0, pointerId: 1, isPrimary: true};' +
      ' c.dispatchEvent(new PointerEvent("pointerdown", o)); c.dispatchEvent(new PointerEvent("pointerup", o)); })()');
    const pinned = await page.evaluate('MapBench.shotView()');
    check('a click on the target pins a line, read in Hits’ words: "' + pinned.pin + '"', pinned.pinned && /(%|Ricochet|—)/.test(pinned.pin || '') && /mm/.test(pinned.pin || ''), JSON.stringify({pinned: pinned.pinned, pin: pinned.pin}));
    await page.evaluate('document.querySelector(".sv-unpin").click()');
    // Replay episode: the camera stays
    const camBefore = await page.evaluate('(function () { var c = MapBench.camera(); c.zoom = MapBench.shotView().lens.zoom; return c; })()');
    await page.evaluate('document.querySelector(".sv-again").click()');
    await sleep(400);
    const again = await page.evaluate('(function () { var s = MapBench.shotView(); s.cam = MapBench.camera(); s.cam.zoom = s.lens.zoom; return s; })()');
    check('Replay episode: back before the hit, playing, the hit line held, the camera and its lens where they were, no pin', again.playing && again.t < again.stop && again.t >= again.start && again.shotHeld && !again.pinned &&
      Object.keys(camBefore).every((k) => camBefore[k] === again.cam[k]), JSON.stringify({t: again.t, playing: again.playing, held: again.shotHeld, cam: again.cam, before: camBefore}));
    await until(page, 'var s = MapBench.shotView(); s && !s.playing && !s.armed ? s : null', 90000);
    // the camera flown out of the shooter (an orbit drag of 300 px): the shooter is drawn again
    await page.evaluate('(function () { var c = MapBench.shotObjects(' + TARGET + ').renderer.domElement, x = 400, y = 300, o = function (t) { c.dispatchEvent(new PointerEvent(t, {bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true})); };' +
      ' o("pointerdown"); for (var i = 0; i < 10; i++) { x += 30; o("pointermove"); } o("pointerup"); })()');
    const out = await until(page, 'var s = MapBench.shotView(); s && s.shooterHidden === false ? s : null', 5000);
    check('the camera flown out of the shooter: the shooter drawn again', !!out, JSON.stringify(await page.evaluate('MapBench.shotView().shooterHidden')));
    // Leave: the mode's exit - the user's speed, the free camera, the lens and every vehicle's material as before the opening
    await page.evaluate('document.querySelector(".sv-leave").click()');
    await sleep(300);
    const left = await page.evaluate('(function () { var s = MapBench.shotView(); return {open: s.open, inMode: s.inMode, speed: s.speed, bar: document.querySelector(".sv-bar").hidden, cam: MapBench.camera(), free: document.getElementById("free").classList.contains("on"), crosses: document.querySelectorAll(".hit-reticle").length}; })()');
    const after = await page.evaluate(LOOKS);
    const lineAfter = await page.evaluate(ON_LINE);
    check('Leave: the objects on the shot’s line drawn again: ' + (lineAfter && lineAfter.count) + ' on the line ' + JSON.stringify(lineAfter && lineAfter.names), !(cor && cor.hidden > 0) || (lineAfter && lineAfter.count > 0), JSON.stringify(lineAfter));
    await sleep(600);
    const stillFree = await page.evaluate('document.getElementById("free").classList.contains("on")');
    check('Leave: the shot view closed, the bar hidden, the speed back to x1, the camera free, no crosses', !left.open && !left.inMode && left.bar && left.speed === 1 && left.free && stillFree && left.crosses === 0, JSON.stringify(left));
    const changed = Object.keys(before.mats).filter((k) => before.mats[k] !== after.mats[k]);
    check('Leave: the lens (fov ' + after.lens.fov + ', zoom ' + after.lens.zoom + ') and the materials of all ' + Object.keys(before.mats).length + ' vehicle meshes as before the opening, the shooter drawn',
      JSON.stringify(after.lens) === JSON.stringify(before.lens) && !changed.length && Object.keys(after.mats).length === Object.keys(before.mats).length && after.writes === before.writes,
      JSON.stringify({before: before.lens, after: after.lens, changed: changed.length, writes: [before.writes, after.writes]}));
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
    console.log('note the shot view: ' + reg.painted + ' painted pixels inside a silhouette of ' + reg.silhouette + ', ' + reg.outside + ' outside; ' + heat.faces + ' faces in Hits’ composition; paused at ' + (stopped ? stopped.t.toFixed(3) : '-') +
      ' s, the hit at ' + (stopped ? stopped.hitT.toFixed(3) : '-') + ' s; the eye ' + gap.toFixed(2) + ' m from the tracer’s start, zoom x' + first.lens.zoom.toFixed(2) + '; shell ' + JSON.stringify(heat.shell) + '; aim ' + heat.aim +
      '; parts drawn for the shot view only: ' + JSON.stringify(heat.extras) + '; episode frames ' + JSON.stringify(heat.frames) + ' (headless software WebGL)');
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
      const nheat = nstop ? await page.evaluate('(function () { var P = MapBench.shotFrame(' + row.hit.target + ', {overlay: false}), R = MapBench.shotFrame(' + row.hit.target + ', {paint: false, overlay: false}), n = 0;' +
        ' for (var i = 0; i < P.length; i += 4) if (Math.abs(P[i] - R[i]) + Math.abs(P[i + 1] - R[i + 1]) + Math.abs(P[i + 2] - R[i + 2]) > 6) n++; return n; })()') : 0;
      check('then the Hits battle made from the replay: its target carries Hits\u2019 heat map (' + (nstop && nstop.faces) + ' faces, ' + nheat + ' pixels painted), paused at the hit',
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
