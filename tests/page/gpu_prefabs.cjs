/* The armoured prefabs (27.09, task prefab-parts) on the page: the CAV mod. 71's crest and the AS-XX 40 t's containers as
 * collision parts of their own, in a local headless Chrome/Edge on software WebGL - the pattern of gpu_wheels.cjs.
 *
 * A prefab part is exporter.prefab_statics + a transform: its own collision model (like any part's), its own armour
 * (vehicleDamageFactor 1: the crest's 30-150 mm and the containers' 20 mm are the vehicle's armour, not screens; the
 * containers' ammo rack is a device, walked through), its parent (the gun, the hull) and `prefabBase` (the slot and the
 * collider at the default layer in the parent's frame).
 *
 *   0. data: ArmorInspectorData.prefabPose reads a recorded pose back as the crest's position (parent x base x a turn
 *      about x: 3.3 degrees = "1 position layer", 0 mm off the rule) and an export's as the default; sceneFor loads the
 *      part's model, and leaves out a prefab part whose model or armour is not there with a word and in `partial`, the
 *      scene whole; Viewer.points resolves a contact on the part and anchors the line on it (a pose of the hit);
 *      Viewer.prototype.poseExtra turns the crest with the gun;
 *   1. a synthetic gun with a crest on it: rays that meet the crest end there (main armour, its own thickness, angle
 *      and ricochet by its flags); the GPU map paints every interior pixel as the CPU walk;
 *   2. the real exports of the offline bench (tests/fixtures-local/prefabs-2026-09-27: the client's own models and
 *      prefabs) when that folder is there - the crest of the CAV mod. 71 and the containers of the AS-XX 40 t, from the
 *      views where many rays meet them; without it a SKIP line.
 *
 *   node tests/page/gpu_prefabs.cjs [--verbose]        exit 0 pass, 1 fail, 77 skip (no browser installed)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const BENCH = path.join(ROOT, 'tests', 'fixtures-local', 'prefabs-2026-09-27', 'folder', 'data');
const VERBOSE = process.argv.includes('--verbose');

let checks = 0, failures = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else if (VERBOSE) console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}

const INIT = `(() => {
  const get = WebGL2RenderingContext.prototype.getExtension;
  WebGL2RenderingContext.prototype.getExtension = function (name) { return name === 'WEBGL_debug_renderer_info' ? null : get.call(this, name); };
})();`;

// Runs in the page: the CPU walk and the GPU map of one view, compared on every interior pixel; per part, how many rays end
// on it (their main plate) and the thickness and chance there, for the report.
const PAGE = `
window.__gpuPrefabs = function (vehicle, view, kind, pen) {
  const B = ArmorBallistics, T = THREE, W = 320, H = 240;
  const engine = B.build({hit: {target: {parts: vehicle.parts}}, models: vehicle.models});
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new T.WebGLRenderer({canvas: canvas, antialias: false}); renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  const surface = new BullbaScreenArmor(renderer, engine);
  const page = function (p) { return new T.Vector3(p[0], p[1], -p[2]); };
  const k = view.far ? 25 : 1, eye = view.far ? view.eye.map(function (x, i) { return view.at[i] + (x - view.at[i]) * k; }) : view.eye;
  const camera = new T.PerspectiveCamera((view.fov || 30) / k, W / H, view.far ? 150 : .1, view.far ? 300 : 100), anchor = page(view.at);
  camera.position.copy(page(eye)); camera.lookAt(anchor); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const shell = B.shell(kind, pen, view.caliber || 105);
  surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', 'chance');
  const data = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(surface.result, 0, 0, W, H, data);
  const paletteOf = function (p) { const lo = [.63, .18, .55], mid = [.95, .75, .31], hi = [.20, .84, .76];
    return p < .5 ? lo.map(function (c, k) { return c + (mid[k] - c) * p * 2; }) : mid.map(function (c, k) { return c + (hi[k] - c) * (p * 2 - 1); }); };
  const o = [camera.position.x, camera.position.y, camera.position.z], v = new T.Vector3();
  const ray = function (px, py) { v.set(px / W * 2 - 1, py / H * 2 - 1, -1).unproject(camera).sub(camera.position).normalize(); return engine.ray(o, [v.x, v.y, v.z], shell); };
  const sign = function (r) { return r.reason + ':' + (r.layers || []).map(function (l) { return l.part + '/' + l.material; }).join('+'); };
  const out = {bad: 0, compared: 0, mismatches: [], ends: {}, prefab: view.prefab, onPrefab: 0, plates: {}, chances: [], ricochets: 0, triangles: 0};
  out.triangles = engine.triangles.filter(function (t) { return t.part === view.prefab; }).length;
  for (let py = 1; py < H - 1; py += 2) for (let px = 1; px < W - 1; px += 2) {
    const r = ray(px + .5, py + .5);
    const last = r.layers && r.layers[r.layers.length - 1];
    if (r.reason === 'ricochet' && r.hit && r.hit.triangle.part === view.prefab) out.ricochets++;
    if (r.reason !== 'penetration' || r.bounce) continue;
    const s = sign(r);
    if (sign(ray(px - .5, py + .5)) !== s || sign(ray(px + 1.5, py + .5)) !== s || sign(ray(px + .5, py - .5)) !== s || sign(ray(px + .5, py + 1.5)) !== s) continue;
    // A quarter of a real vehicle also sees its gun, whose plates lie a fraction of a millimetre apart (gpu_wheels.cjs):
    // counted, not compared - unless the ray ends on the prefab.
    if (view.skipGun && last.part !== view.prefab && r.layers.some(function (l) { return l.part === 3; })) { out.gunSkipped = (out.gunSkipped || 0) + 1; continue; }
    out.ends[last.part] = (out.ends[last.part] || 0) + 1;
    if (last.part === view.prefab) { out.onPrefab++; out.plates[last.material] = last.nominal; if (out.chances.length < 4000) out.chances.push(r.chance); }
    const screens = r.layers.filter(function (l) { return !l.main; }).length, share = screens ? 1 - Math.pow(1 - .35, screens) : 0;
    const i = (py * W + px) * 4, c = paletteOf(r.chance / 100), e = c.map(function (x, q) { return x + ([.45, .50, .55][q] - x) * share; });
    out.compared++;
    if (Math.abs(data[i] - e[0]) > .02 || Math.abs(data[i + 1] - e[1]) > .02 || Math.abs(data[i + 2] - e[2]) > .02) {
      out.bad++; if (out.mismatches.length < 4) out.mismatches.push({px: px, py: py, cpu: r.chance, layers: s, gpu: Array.from(data.slice(i, i + 3)).map(function (x) { return +x.toFixed(3); })});
    }
  }
  const sorted = out.chances.slice().sort(function (a, b) { return a - b; });
  out.median = sorted.length ? sorted[sorted.length >> 1] : null; delete out.chances;
  surface.dispose(); renderer.dispose(); canvas.remove();
  return out;
};`;

// Data checks in the page: the pose read back, the scene, the contact and the pose of the gun.
const DATA = `(async () => {
  const D = ArmorInspectorData, I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
  const rx = function (deg) { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const mul = function (a, b) { const o = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = v; } return o; };
  const gun = {id: 3, name: 'gun', transform: I(0, 1.95, -.1)}, base = I(0, .324, -.485);
  const layers = [{name: '0 position layer', angle: 0}, {name: '1 position layer', angle: 3.3}, {name: '2 position layer', angle: 6.6}, {name: '3 position layer', angle: 9.9}];
  const crest = {id: 5, name: 'crest_module', prefab: 'p', prefabKind: 'crest', parentPart: 3, prefabBase: base, prefabLayers: layers,
    prefabDefault: '0 position layer', transform: mul(mul(gun.transform, base), rx(3.3))};
  const hit = D.prefabPose(crest, [gun, crest]);
  const between = D.prefabPose(Object.assign({}, crest, {transform: mul(mul(gun.transform, base), rx(5))}), [gun, crest]);
  const shifted = D.prefabPose(Object.assign({}, crest, {transform: mul(I(0, .02, 0), crest.transform)}), [gun, crest]);
  const exported = D.prefabPose(Object.assign({}, crest, {poseFrom: 'default', transform: mul(gun.transform, base)}), [gun, crest]);
  const none = D.prefabPose({id: 1, name: 'hull'}, []);
  // The scene: a box model for every part; the crest's model file, then the same crest with no model yet.
  const statics = ['chassis', 'hull', 'turret', 'gun'].map(function (n, i) { return {id: i, name: n, modelKey: window.__boxKey, transform: I(0, i * .5, 0), armor: {armor_1: {armor: 20, vehicleDamageFactor: 1}}}; });
  const withModel = Object.assign({}, crest, {modelKey: window.__boxKey, armor: {armor_1: {armor: 150, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true}}});
  const scene = await D.sceneFor({warnings: []}, {target: {parts: statics.concat([withModel])}, points: []});
  const pending = await D.sceneFor({warnings: []}, {target: {parts: statics.concat([Object.assign({}, crest, {modelPending: true})])}, points: []});
  // A contact on the crest: resolved through its own pose and the line anchored on it (a pose of the hit).
  const pts = ArmorViewer.points({target: {parts: statics.concat([withModel])}, points: [{part: 5, status: 'resolved', position: [0, .1, -.3], direction: [0, 0, 1]},
    {part: 3, status: 'resolved', position: [0, 0, .5], direction: [0, 0, 1]}]}, null);
  // The gun turned by 10 degrees: the crest turns with it (the same matrix).
  const fake = {loadedData: {hit: {target: {parts: statics.concat([withModel])}, aim: [0, 0]}}, turretAngle: 30, gunAngle: 10};
  const extra = ArmorViewer.prototype.poseExtra.call(fake);
  return {hit: hit, between: between, shifted: shifted, exported: exported, none: none,
    scene: {models: Object.keys(scene.models).sort(), partial: scene.partial, incomplete: !!scene.geometryIncomplete},
    pending: {models: Object.keys(pending.models).sort(), partial: pending.partial, incomplete: !!pending.geometryIncomplete, warnings: pending.warnings},
    points: [pts.length, pts.anchor, pts[0] && pts[0].part], follows: !!extra && extra[5] === extra[3] && !!extra[3] && extra[2] !== extra[3]};
})()`;

// A synthetic gun (part 3, a 40 mm box) with a crest box (part 5, 150 mm on top, 30 mm sides) on it, in the client's frame.
function synthetic() {
  const box = function (material, min, max) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    return {material: material, vertices: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]};
  };
  const I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
  const main = function (mm) { return {armor: mm, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, collideOnceOnly: false, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true}; };
  const parts = [{id: 3, name: 'gun', transform: I(0, 1.9, 0), armor: {armor_1: main(40)}},
    {id: 5, name: 'crest_module', prefab: 'p', prefabKind: 'crest', parentPart: 3, transform: I(0, 2.3, -.6), armor: {armor_1: main(150), armor_3: main(30)}}];
  const crest = box('armor_1', [-.3, 0, -.6], [.3, .25, .6]);
  return {parts: parts, models: {3: {kind: 'client-shot-collision', groups: [box('armor_1', [-.35, -.3, -1.6], [.35, .3, 3])]},
    5: {kind: 'client-shot-collision', groups: [crest]}}};
}

function bench(id) {
  const read = function (file) { const t = fs.readFileSync(file, 'utf8'); return JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1))[1]; };
  const record = read(path.join(BENCH, 'vehicles', id + '.js')), models = {};
  record.parts.forEach(function (p) { if (p.modelKey) models[String(p.id)] = read(path.join(BENCH, 'models', p.modelKey + '.js')); });
  return {record: record, vehicle: {parts: record.parts, models: models}};
}

async function main() {
  const started = Date.now();
  const browser = await launch({width: 800, height: 600});
  if (!browser) { console.log('SKIP gpu prefabs: no Chrome or Edge installed'); return 77; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-prefabs-'));
  const numbers = [];
  try {
    const scripts = ['vendor/three.min.js', 'vendor/three-mesh-bvh.umd.js', 'ballistics.js', 'screen-armor.js', 'viewer.js', 'local-data.js'].map(function (p) { return url.pathToFileURL(path.join(WEB, p)).href; });
    fs.writeFileSync(path.join(folder, 'page.html'), '<!doctype html><meta charset="utf-8"><title>gpu prefabs</title><body>' + scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('') + '<script>' + PAGE + '</script></body>');
    const box = {kind: 'client-shot-collision', groups: [synthetic().models[5].groups[0]]};
    const key = require('crypto').createHash('sha256').update(JSON.stringify(box)).digest('hex');
    fs.mkdirSync(path.join(folder, 'data', 'models'), {recursive: true});
    fs.writeFileSync(path.join(folder, 'data', 'models', key + '.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['model:' + key, box]) + ');');
    const page = await browser.open(url.pathToFileURL(path.join(folder, 'page.html')).href, INIT);
    await page.evaluate('window.__boxKey = ' + JSON.stringify(key));
    const d = await page.evaluate(DATA);
    ok('pose: a recorded crest turned 3.3 degrees on its gun reads as "1 position layer", 0 mm off the rule',
       d.hit.from === 'hit' && Math.abs(d.hit.angle - 3.3) < 1e-9 && d.hit.layer === '1 position layer' && d.hit.fit < 1e-6, JSON.stringify(d.hit));
    ok('pose: 5 degrees is between two positions (no layer); a shifted origin shows in the fit (20 mm); a part of no prefab: null',
       d.between.layer === null && Math.abs(d.between.angle - 5) < 1e-9 && Math.abs(d.shifted.fit - 20) < 1e-6 && d.none === null,
       JSON.stringify([d.between, d.shifted.fit, d.none]));
    ok('pose: an export stands at the default layer and says so', d.exported.from === 'default' && d.exported.layer === '0 position layer' && d.exported.angle === 0,
       JSON.stringify(d.exported));
    ok('scene: the crest loads its model like any part; the scene is whole', JSON.stringify(d.scene.models) === '["0","1","2","3","5"]' && !d.scene.incomplete
       && d.scene.partial.length === 0, JSON.stringify(d.scene));
    ok('scene: a crest whose model is on its way is left out with a word and in partial; the scene stays whole',
       JSON.stringify(d.pending.models) === '["0","1","2","3"]' && !d.pending.incomplete && JSON.stringify(d.pending.partial) === '[5]'
       && d.pending.warnings.indexOf('crest_module: model on its way') !== -1, JSON.stringify(d.pending));
    ok('hit decoding: a contact on the crest is resolved through its pose and anchors the line (a pose of the hit)',
       JSON.stringify(d.points) === '[2,0,5]', JSON.stringify(d.points));
    ok('pose of the model: the crest turns with the gun (its parent), the turret alone does not carry the gun\'s pitch', d.follows);
    const run = function (vehicle, view, kind, pen) { return page.evaluate('__gpuPrefabs(' + JSON.stringify(vehicle) + ',' + JSON.stringify(view) + ',"' + kind + '",' + pen + ')'); };
    const cases = [];
    const syn = synthetic();
    for (const kind of ['ARMOR_PIERCING', 'HOLLOW_CHARGE']) {
      cases.push(['synthetic crest from above-side, ' + kind, syn, {eye: [-4, 4.5, -.6], at: [0, 2.4, -.6], prefab: 5}, kind, 160]);
    }
    let real = 0;
    if (fs.existsSync(BENCH)) {
      const cav = bench('italy-It43_CAV_mod_71'), pod = bench('france-F135_AS_XX_40_t');
      const crest = cav.record.parts.find(function (p) { return p.prefab; }), pods = pod.record.parts.find(function (p) { return p.prefab; });
      ok('CAV mod. 71 (bench): the export carries the crest as part 4 on the gun, its model and 30-150 mm armour of vehicleDamageFactor 1',
         crest && crest.id === 4 && crest.parentPart === 3 && crest.modelKey && crest.poseFrom === 'default' && crest.armor.armor_1.armor === 150
         && Object.keys(crest.armor).every(function (m) { return crest.armor[m].vehicleDamageFactor === 1; }), JSON.stringify(crest && Object.keys(crest)));
      ok('AS-XX 40 t (bench): the containers as part 4 on the hull, 20 mm of vehicleDamageFactor 1, the ammo rack a device',
         pods && pods.id === 4 && pods.parentPart === 1 && pods.modelKey && pods.armor.armor_1.armor === 20 && pods.armor.ammoBay.armor === null,
         JSON.stringify(pods && pods.armor && pods.armor.ammoBay));
      const c = crest.transform.slice(12, 15), p = pods.transform.slice(12, 15);
      cases.push(['CAV mod. 71 (bench), the crest from the side above', cav.vehicle, {eye: [c[0] - 6, c[1] + 4, c[2] - .7], at: [c[0], c[1], c[2] - .7], fov: 20, far: true, prefab: 4, skipGun: true}, 'ARMOR_PIERCING', 250]);
      cases.push(['CAV mod. 71 (bench), the crest from the front above (its 150 mm plate)', cav.vehicle, {eye: [c[0] + .3, c[1] + 2.5, c[2] + 8], at: [c[0], c[1], c[2] - .7], fov: 14, far: true, prefab: 4, skipGun: true, plate: ['armor_1', 150]}, 'ARMOR_PIERCING', 250]);
      cases.push(['CAV mod. 71 (bench), the crest from behind above', cav.vehicle, {eye: [c[0] + .01, c[1] + 3.5, c[2] - 7], at: [c[0], c[1], c[2] - .7], fov: 18, far: true, prefab: 4, skipGun: true}, 'ARMOR_PIERCING', 250]);
      cases.push(['AS-XX 40 t (bench), the containers from behind', pod.vehicle, {eye: [p[0] + 2, p[1] + 1.5, p[2] - 9], at: [p[0], p[1] - .3, p[2] - .5], fov: 24, far: true, prefab: 4, skipGun: true}, 'ARMOR_PIERCING', 250]);
      cases.push(['AS-XX 40 t (bench), the containers from the side', pod.vehicle, {eye: [p[0] - 9, p[1] + 1, p[2] - .5], at: [p[0], p[1] - .3, p[2] - .5], fov: 20, far: true, prefab: 4, skipGun: true}, 'HOLLOW_CHARGE', 250]);
      real = 2;
    }
    for (const [name, vehicle, view, kind, pen] of cases) {
      const r = await run(vehicle, view, kind, pen);
      numbers.push(name + ': ' + r.onPrefab + ' rays end on the prefab (' + JSON.stringify(r.plates) + ', median chance ' + r.median + ' %), ' + r.ricochets + ' ricochet off it; compared ' + r.compared + ', ends ' + JSON.stringify(r.ends));
      ok(name + ': many rays end on the prefab, on its own plates (its model in the engine: ' + r.triangles + ' triangles)', r.triangles > 0 && r.onPrefab > 100,
         '(' + r.onPrefab + ' of ' + r.compared + ', plates ' + JSON.stringify(r.plates) + ')');
      if (view.plate) ok(name + ': the ' + view.plate[1] + ' mm plate (' + view.plate[0] + ') is met', r.plates[view.plate[0]] === view.plate[1], JSON.stringify(r.plates));
      ok(name + ': the GPU map paints every interior pixel as the CPU walk', !r.bad && r.compared > 200, '(' + r.bad + ' of ' + r.compared + ' differ, e.g. ' + JSON.stringify(r.mismatches) + ')');
    }
    if (!real) console.log('SKIP gpu prefabs, real vehicles: tests/fixtures-local/prefabs-2026-09-27 is not on this machine (CAV mod. 71, AS-XX 40 t not compared)');
    if (VERBOSE) numbers.forEach(function (line) { console.log('  ' + line); });
    ok('no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    fs.rmSync(folder, {recursive: true, force: true});
  }
  console.log('gpu prefabs (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
