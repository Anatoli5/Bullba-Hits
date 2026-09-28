/* The wheels of a wheeled vehicle on the CPU walk and on the GPU map (BACKLOG 39, 26.09.2026), in a local headless
 * Chrome/Edge on software WebGL - the pattern of gpu_bounce.cjs.
 *
 * A wheel is collision part -k with a procedural body (web/local-data.js wheelModel: a 16-sided prism) and its own
 * material 'wheel' - a screen: vehicleDamageFactor 0, collide once, no angle, no ricochet. The scene is built the way
 * the page builds one (a vehicle block's parts, their transforms, ArmorBallistics.build, the REAL web/screen-armor.js
 * composite on the engine's triangles), and every interior pixel whose CPU ray reaches main armour is compared: the
 * chance painted, greyed by one share per screen layer as the composite does (so the GPU's count of screens is checked
 * too), against ArmorBallistics.ray for the same pixel ray.
 * On the CPU a ray through a wheel meets its 5/10 mm once (both faces of the prism are one collide-once plate), at its
 * nominal thickness, and goes on to the hull.
 *
 *   0. parsing: a published battle whose static part table holds the wheels' rest place (the hit's poses null there)
 *      expands back into parts with their transforms (ArmorInspectorData.expandBattle), and sceneFor builds each wheel's
 *      body without a model file; a wheel without its body (another client's record) is left out with a word and the
 *      scene stays whole;
 *   1. a synthetic hull on four wheels, AP and HEAT, seen from the side and from a quarter;
 *   2. the real exports of the offline bench (tests/fixtures-local/wheels-2026-09-26: EBR 105, EBR 90, Lynx 6x6 - the
 *      client's own collision models and wheels) when that folder is there; without it these checks are left out.
 *
 *   node tests/page/gpu_wheels.cjs [--verbose]        exit 0 pass, 1 fail, 77 skip (no browser installed)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const BENCH = path.join(ROOT, 'tests', 'fixtures-local', 'wheels-2026-09-26', 'folder', 'data');
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

// Runs in the page. `vehicle`: {parts, models} as the page's scene has them; `view`: {eye, at} in the client's frame.
const PAGE = `
window.__gpuWheels = function (vehicle, view, kind, pen) {
  const B = ArmorBallistics, T = THREE, D = ArmorInspectorData, W = 320, H = 240;
  const models = Object.assign({}, vehicle.models);
  vehicle.parts.forEach(function (p) { if (p.id < 0) { const m = D.wheelModel(p); if (m) models[String(p.id)] = m; } });
  const engine = B.build({hit: {target: {parts: vehicle.parts}}, models: models});
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new T.WebGLRenderer({canvas: canvas, antialias: false}); renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  const surface = new BullbaScreenArmor(renderer, engine);
  // The page's frame is the client's with z mirrored (ArmorBallistics.transform).
  const page = function (p) { return new T.Vector3(p[0], p[1], -p[2]); };
  // view.far (the real vehicles): the same view from 25 times as far through a lens 25 times narrower, as gpu_bounce's: the
  // capture's near plane then parts faces 50 um apart - the chassis and hull plates of a client model can lie 0.14 mm apart,
  // which a camera at 8 m with its near plane at 0.1 m cannot order (web/ballistics.js TIE: a GPU matter, not the wheels').
  const k = view.far ? 25 : 1, eye = view.far ? view.eye.map(function (x, i) { return view.at[i] + (x - view.at[i]) * k; }) : view.eye;
  const camera = new T.PerspectiveCamera((view.fov || 30) / k, W / H, view.far ? 150 : .1, view.far ? 300 : 100), anchor = page(view.at);
  view = Object.assign({}, view, {eye: eye});
  camera.position.copy(page(view.eye)); camera.lookAt(anchor); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const shell = B.shell(kind, pen, 100);
  surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'exact', 'chance');
  const data = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(surface.result, 0, 0, W, H, data);
  const paletteOf = function (p) { const lo = [.63, .18, .55], mid = [.95, .75, .31], hi = [.20, .84, .76];
    return p < .5 ? lo.map(function (c, k) { return c + (mid[k] - c) * p * 2; }) : mid.map(function (c, k) { return c + (hi[k] - c) * (p * 2 - 1); }); };
  const o = [camera.position.x, camera.position.y, camera.position.z], v = new T.Vector3();
  const ray = function (px, py) { v.set(px / W * 2 - 1, py / H * 2 - 1, -1).unproject(camera).sub(camera.position).normalize(); return engine.ray(o, [v.x, v.y, v.z], shell); };
  const sign = function (r) { return r.reason + ':' + (r.layers || []).map(function (l) { return l.part + '/' + l.material; }).join('+'); };
  const out = {wheelPixels: 0, hullPixels: 0, bad: 0, mismatches: [], wheelOnce: true, wheelNominal: true, wheels: {}, triangles: engine.triangles.length,
    wheelTriangles: engine.triangles.filter(function (t) { return t.part < 0; }).length, remainingOk: true};
  for (let py = 1; py < H - 1; py += 2) for (let px = 1; px < W - 1; px += 2) {
    const r = ray(px + .5, py + .5);
    if (r.reason !== 'penetration' || r.bounce) continue;
    const s = sign(r);
    // Interior pixels only: the same plates one pixel away on every side - never a silhouette or an edge of a face.
    if (sign(ray(px - .5, py + .5)) !== s || sign(ray(px + 1.5, py + .5)) !== s || sign(ray(px + .5, py - .5)) !== s || sign(ray(px + .5, py + 1.5)) !== s) continue;
    const wheels = r.layers.filter(function (l) { return l.part < 0; }), first = r.layers[0];
    // A quarter view of a real vehicle also sees its gun, whose plates lie a fraction of a millimetre apart - an ordering
    // matter of the GPU's depth, not of the wheels (wheels-2026-09-26 section 3): those pixels are counted, not compared.
    if (view.quarter && r.layers.some(function (l) { return l.part === 3; })) { out.gunSkipped = (out.gunSkipped || 0) + 1; continue; }
    if (first.part < 0) out.wheelPixels++; else if (first.main) out.hullPixels++;
    // Rays through several wheels (a quarter view, a row): each is ONE collide-once layer of the GPU's eight.
    if (wheels.length >= 2) out.multi2 = (out.multi2 || 0) + 1;
    out.maxWheels = Math.max(out.maxWheels || 0, wheels.length);
    if (wheels.length >= 7) out.multi7 = (out.multi7 || 0) + 1;
    out.maxLayers = Math.max(out.maxLayers || 0, r.layers.length);
    const seen = {};
    wheels.forEach(function (l) { if (seen[l.part]) out.wheelOnce = false; seen[l.part] = true; out.wheels[l.part] = l.nominal;
      if (l.material !== 'wheel' || l.main || Math.abs(l.effective - l.nominal) > 1e-9) out.wheelNominal = false; });
    // AP: what reaches the hull is the penetration less every screen's plate.
    if (kind === 'ARMOR_PIERCING' && Math.abs(r.remaining - (pen - r.layers.filter(function (l) { return !l.main; }).reduce(function (a, l) { return a + l.effective; }, 0))) > 1e-6) out.remainingOk = false;
    // Behind screens the composite greys the colour by 1 - (1 - opacity)^screens, one share per screen layer on the ray: the
    // GPU's count of screens must be the CPU's (each collide-once wheel once).
    const screens = r.layers.filter(function (l) { return !l.main; }).length, share = screens ? 1 - Math.pow(1 - .35, screens) : 0;
    const i = (py * W + px) * 4, c = paletteOf(r.chance / 100), e = c.map(function (x, q) { return x + ([.45, .50, .55][q] - x) * share; });
    if (Math.abs(data[i] - e[0]) > .02 || Math.abs(data[i + 1] - e[1]) > .02 || Math.abs(data[i + 2] - e[2]) > .02) {
      out.bad++; if (out.mismatches.length < 4) out.mismatches.push({px: px, py: py, cpu: r.chance, layers: s, gpu: Array.from(data.slice(i, i + 3)).map(function (x) { return +x.toFixed(3); })});
    }
  }
  surface.dispose(); renderer.dispose(); canvas.remove();
  return out;
};`;

// Parsing (runs in the page): a snapshot shaped as exporter.pack_battle writes one, then the page's own reader and scene.
const PARSE = `(async () => {
  const D = ArmorInspectorData, I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
  const statics = ['chassis', 'hull', 'turret', 'gun'].map(function (n, i) { return {id: i, name: n, modelKey: window.__boxKey, resource: 'vehicles/t/' + n + '.model'}; });
  const wheel = function (id, name, x, body) { const p = {id: id, name: name, material: 'wheel', transform: I(x, .55, 0), armorRef: 'a'.repeat(64)};
    if (body) p.wheel = {radius: .55, width: .35, sides: 16}; return p; };
  const battle = {id: 'w', staticTableFormat: 1, armorTableFormat: 1, armorTables: {}, hits: [{id: 'h', points: [],
    target: {vehicleRef: 'cfg:' + '0'.repeat(32), partPoses: [I(0, 0, 0), I(0, .5, 0), I(0, 1.7, 0), I(0, 2.1, 1), null, null, null]}}],
    staticTables: {}};
  battle.armorTables['a'.repeat(64)] = {wheel: {armor: 10, vehicleDamageFactor: 0, collideOnceOnly: true}};
  battle.staticTables['cfg:' + '0'.repeat(32)] = {type: 'france:W', partsRef: 'cfg:' + '1'.repeat(32)};
  battle.staticTables['cfg:' + '1'.repeat(32)] = statics.concat([wheel(-1, 'WD_L1', -1.9, true), wheel(-2, 'WD_R1', 1.9, true), wheel(-3, 'W_X', -1.9, false)]);
  const b = D.expandBattle(battle), parts = b.hits[0].target.parts;
  const scene = await D.sceneFor({warnings: []}, b.hits[0]);
  // The shot's anchor (review of 5f2bee5): a line through wheel -1 (at its rest place) into the hull stands on the hull point.
  const hit = {target: {parts: [{id: 1, transform: I(0, .5, 0)}, {id: -1, transform: I(-1.9, .55, 0), poseFrom: 'rest'}]},
    points: [{part: -1, status: 'resolved', position: [.1, 0, 0], direction: [1, 0, 0]}, {part: 1, status: 'resolved', position: [-.8, .3, 0], direction: [1, 0, 0]}]};
  const pts = ArmorViewer.points(hit, null), alone = ArmorViewer.points({target: hit.target, points: [hit.points[0]]}, null);
  return {ids: parts.map(function (p) { return p.id; }), poses: parts.map(function (p) { return p.transform && p.transform.slice(12, 15); }),
    anchor: [pts.length, pts.anchor, pts[pts.anchor].part, alone.anchor], partial: scene.partial,
    armor: parts[4].armor && parts[4].armor.wheel && parts[4].armor.wheel.armor, models: Object.keys(scene.models).sort(), incomplete: !!scene.geometryIncomplete,
    warnings: scene.warnings, kinds: [scene.models['-1'] && scene.models['-1'].procedural, scene.models['0'] && scene.models['0'].kind]};
})()`;

// The synthetic vehicle: a 40 mm hull box (part 1) on four wheels of the EBR 105's sizes (5 and 10 mm), in the client's frame.
function synthetic() {
  const box = function (min, max) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    return {material: 'armor_1', vertices: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]};
  };
  const I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
  const main = {armor: 40, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, collideOnceOnly: false, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true};
  const wheel = function (mm) { return {wheel: {armor: mm, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, collideOnceOnly: true, checkCaliberForRicochet: false, checkCaliberForHitAngleNorm: false}}; };
  const parts = [{id: 1, name: 'hull', transform: I(0, 0, 0), armor: {armor_1: main}}];
  [[-1, 'WD_L1', -1.0255, .61, -2.14, .609, 5], [-2, 'WD_R1', 1.0255, .61, -2.14, .609, 5], [-3, 'W_L1', -1.0257, .58, -.70, .59, 10], [-4, 'W_R1', 1.0255, .58, -.70, .59, 10]]
    .forEach(function (w) { parts.push({id: w[0], name: w[1], material: 'wheel', wheel: {radius: w[5], width: .35, sides: 16}, transform: I(w[2], w[3], w[4]), armor: wheel(w[6])}); });
  return {parts: parts, models: {1: {kind: 'client-shot-collision', groups: [box([-.9, .3, -2.6], [.9, 1.5, 2.6])]}}};
}

// Seven 5 mm wheels in a row along z (parts -1..-7) and a 40 mm plate behind them (part 1).
function row() {
  const I = function (x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; };
  const main = {armor: 40, vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, collideOnceOnly: false, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true};
  const wheel = {wheel: {armor: 5, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, collideOnceOnly: true, checkCaliberForRicochet: false, checkCaliberForHitAngleNorm: false}};
  const parts = [{id: 1, name: 'hull', transform: I(0, 0, 0), armor: {armor_1: main}}];
  for (let k = 1; k <= 7; k++) parts.push({id: -k, name: 'W' + k, material: 'wheel', wheel: {radius: .59, width: .35, sides: 16}, transform: I(-1, .6, 3.3 - 1.1 * k), armor: wheel});
  const plate = {material: 'armor_1', vertices: [[-2, 0, -5.5], [0, 0, -5.5], [0, 1.4, -5.5], [-2, 1.4, -5.5]], indices: [0, 1, 2, 0, 2, 3]};
  return {parts: parts, models: {1: {kind: 'client-shot-collision', groups: [plate]}}};
}

// A vehicle file of the bench and its models, as the page reads them (ArmorInspectorData.receive([key, value])).
function bench(id) {
  const read = function (file) { const t = fs.readFileSync(file, 'utf8'); return JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1))[1]; };
  const record = read(path.join(BENCH, 'vehicles', id + '.js')), models = {};
  record.parts.forEach(function (p) { if (p.modelKey) models[String(p.id)] = read(path.join(BENCH, 'models', p.modelKey + '.js')); });
  return {record: record, vehicle: {parts: record.parts, models: models}};
}

async function main() {
  const started = Date.now();
  const browser = await launch({width: 800, height: 600});
  if (!browser) { console.log('SKIP gpu wheels: no Chrome or Edge installed'); return 77; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-wheels-'));
  try {
    const scripts = ['vendor/three.min.js', 'vendor/three-mesh-bvh.umd.js', 'ballistics.js', 'screen-armor.js', 'viewer.js', 'local-data.js'].map(function (p) { return url.pathToFileURL(path.join(WEB, p)).href; });
    const html = '<!doctype html><meta charset="utf-8"><title>gpu wheels</title><body>' + scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('') + '<script>' + PAGE + '</script></body>';
    fs.writeFileSync(path.join(folder, 'page.html'), html);
    // One box model file for the four static parts, where the page's reader looks for it (data/models/<sha256>.js).
    const box = {kind: 'client-shot-collision', groups: [synthetic().models[1].groups[0]]};
    const key = require('crypto').createHash('sha256').update(JSON.stringify(box)).digest('hex');
    fs.mkdirSync(path.join(folder, 'data', 'models'), {recursive: true});
    fs.writeFileSync(path.join(folder, 'data', 'models', key + '.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['model:' + key, box]) + ');');
    const page = await browser.open(url.pathToFileURL(path.join(folder, 'page.html')).href, INIT);
    await page.evaluate('window.__boxKey = ' + JSON.stringify(key));
    const parsed = await page.evaluate(PARSE);
    ok('parsing: the wheels expand with their rest place from the static table (null among the poses of the hit), the static parts with the poses of the hit',
       JSON.stringify(parsed.ids) === '[0,1,2,3,-1,-2,-3]' && JSON.stringify(parsed.poses) === '[[0,0,0],[0,0.5,0],[0,1.7,0],[0,2.1,1],[-1.9,0.55,0],[1.9,0.55,0],[-1.9,0.55,0]]'
       && parsed.armor === 10, JSON.stringify(parsed));
    ok('parsing: sceneFor builds the wheel bodies without a model file, leaves a wheel without its body out with a word, and the scene stays whole',
       JSON.stringify(parsed.models) === '["-1","-2","0","1","2","3"]' && !parsed.incomplete && parsed.warnings.length === 1 && parsed.warnings[0] === 'W_X: wheel body not saved'
       && parsed.kinds[0] === 'wheel' && parsed.kinds[1] === 'client-shot-collision', JSON.stringify(parsed));
    ok('parsing: the wheel left out is named in the partial list of the scene (the Statistics log marks the verdicts cast without it)',
       JSON.stringify(parsed.partial) === '[-3]', JSON.stringify(parsed.partial));
    ok('anchor: a line through a wheel at its rest place into the hull stands on the hull point; a wheel point alone is its own anchor',
       JSON.stringify(parsed.anchor) === '[2,1,1,0]', JSON.stringify(parsed.anchor));
    const run = function (vehicle, view, kind, pen) { return page.evaluate('__gpuWheels(' + JSON.stringify(vehicle) + ',' + JSON.stringify(view) + ',"' + kind + '",' + pen + ')'); };
    const body = await page.evaluate(`(() => { const m = ArmorInspectorData.wheelModel({material: 'wheel', wheel: {radius: .59, width: .35, sides: 16}}), g = m.groups[0];
      let vol = 0; for (let i = 0; i < g.indices.length; i += 3) { const a = g.vertices[g.indices[i]], b = g.vertices[g.indices[i + 1]], c = g.vertices[g.indices[i + 2]];
        vol += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]); }
      const n = function (k) { const a = g.vertices[k], b = g.vertices[(k + 1) % 16], y = (a[1] + b[1]) / 2, z = (a[2] + b[2]) / 2, l = Math.hypot(y, z); return [y / l, z / l, l]; };
      const bad = ArmorInspectorData.wheelModel({material: 'wheel', wheel: {radius: .59, width: 0, sides: 16}});
      return {tris: g.indices.length / 3, verts: g.vertices.length, material: g.material, volume: vol / 6, face7: n(7), face14: n(14),
        same: m === ArmorInspectorData.wheelModel({material: 'wheel', wheel: {radius: .59, width: .35, sides: 16}}), bad: bad}; })()`);
    // The prism of the recorded rim contacts: faces centred at 11.25 + k x 22.5 degrees (168.75 is face 7, -33.75 face 14),
    // the apothem r cos(11.25) = 0.5787 - the two contacts' distances along their normals were 0.57874 and 0.57872.
    const prism = Math.PI * .59 * .59 * .35 * (16 / (2 * Math.PI)) * Math.sin(2 * Math.PI / 16);
    ok('wheel body: a closed 16-sided prism, outward, its faces on the recorded normals, the apothem of the recorded contacts',
       body.tris === 60 && body.verts === 32 && body.material === 'wheel' && Math.abs(body.volume - prism) < 1e-9 && body.same && body.bad === null
       && Math.abs(body.face7[0] + .98079) < 1e-4 && Math.abs(body.face7[1] - .19509) < 1e-4 && Math.abs(body.face14[0] - .83147) < 1e-4
       && Math.abs(body.face14[1] + .55557) < 1e-4 && Math.abs(body.face7[2] - .57866) < 1e-4, JSON.stringify(body));
    const cases = [];
    const syn = synthetic();
    // Review of 5f2bee5: seven wheels in a row before a 40 mm plate, seen along the row - with a wheel at one layer the
    // plate is the eighth and last layer of the peel; at two a wheel it would fall past the eighth (-1, unknown).
    cases.push(['synthetic, a row of seven wheels before a plate', row(), {eye: [-1, .62, 14], at: [-1, .6, -5], fov: 5, row: true}, 'ARMOR_PIERCING', 200, {5: true}]);
    for (const kind of ['ARMOR_PIERCING', 'HOLLOW_CHARGE']) {
      cases.push(['synthetic, side, ' + kind, syn, {eye: [-9, 1.0, -1.4], at: [-1, .7, -1.4]}, kind, 120, {5: true, 10: true}]);
      cases.push(['synthetic, quarter, ' + kind, syn, {eye: [-7, 1.2, -6], at: [-1, .6, -1.2]}, kind, 120, {5: true, 10: true}]);
    }
    let real = 0;
    if (fs.existsSync(BENCH)) {
      for (const id of ['france-F108_Panhard_EBR_105', 'france-F100_Panhard_EBR_90', 'france-F110_Lynx_6x6']) {
        const b = bench(id), wheels = b.record.parts.filter(function (p) { return p.id < 0; });
        ok(id + ' (bench): the export carries its wheels as parts -1..-' + wheels.length + ' with body, place and a wheel material',
           wheels.length >= 6 && b.record.wheelParts === wheels.length && wheels.every(function (p, i) { return p.id === -(i + 1) && p.wheel && p.transform && p.material === 'wheel' && p.armor && p.armor.wheel && p.armor.wheel.vehicleDamageFactor === 0; }),
           JSON.stringify(wheels.map(function (p) { return [p.id, p.name, p.wheel, p.armor && p.armor.wheel && p.armor.wheel.armor]; })));
        const w3 = wheels[2], c = w3.transform.slice(12, 15);
        cases.push([id + ' (bench), side at ' + w3.name, b.vehicle, {eye: [c[0] - 8, c[1] + .9, c[2]], at: [c[0], c[1] + .25, c[2]], fov: 25, far: true}, 'ARMOR_PIERCING', 250, null]);
        // Review of 5f2bee5: quarter views along the wheel row, front and rear - rays through two and three wheels and the
        // chassis plates before the hull. A wheel is one collide-once layer (the peel keeps its first face only), so the
        // eight layers still reach the hull there.
        for (const q of [1, -1]) {
          cases.push([id + ' (bench), quarter ' + (q > 0 ? 'front' : 'rear') + ' along the left wheels', b.vehicle,
            {eye: [c[0] - 2.4, c[1] + .35, c[2] + 9 * q], at: [c[0] + .25, c[1] + .1, c[2] - 1.2 * q], fov: 24, far: true, quarter: true}, 'ARMOR_PIERCING', 250, null]);
        }
        real++;
      }
    }
    for (const [name, vehicle, view, kind, pen, want] of cases) {
      const r = await run(vehicle, view, kind, pen);
      ok(name + ': the wheels are in the engine (' + r.wheelTriangles + ' of ' + r.triangles + ' triangles) and in front of the hull on many pixels',
         r.wheelTriangles >= 60 * 4 && r.wheelPixels > 150 && r.hullPixels > 50, '(wheel pixels ' + r.wheelPixels + ', hull pixels ' + r.hullPixels + ')');
      if (view.quarter) ok(name + ': rays pass two wheels and the chassis plates before the hull', (r.multi2 || 0) > 10,
         '(two wheels on ' + (r.multi2 || 0) + ' pixels, most wheels on a ray ' + r.maxWheels + ', most CPU layers ' + r.maxLayers + ', gun pixels left out ' + (r.gunSkipped || 0) + ')');
      if (view.row) ok(name + ': seven wheels and the plate make eight layers on many rays - a wheel costs one', (r.multi7 || 0) > 50 && r.maxLayers === 8,
         '(seven wheels on ' + (r.multi7 || 0) + ' pixels, most CPU layers ' + r.maxLayers + ')');
      ok(name + ': CPU - each wheel once (collide once), at its nominal thickness, a screen; the hull gets what the screens left',
         r.wheelOnce && r.wheelNominal && r.remainingOk && (!want || Object.keys(r.wheels).every(function (k) { return want[r.wheels[k]]; })), JSON.stringify(r.wheels));
      ok(name + ': the GPU map paints every interior pixel as the CPU walk', !r.bad, '(' + r.bad + ' differ, e.g. ' + JSON.stringify(r.mismatches) + ')');
    }
    // Without the bench the real vehicles are not compared: a SKIP line (AGENTS.md), never a silent pass.
    if (!real) console.log('SKIP gpu wheels, real vehicles: tests/fixtures-local/wheels-2026-09-26 is not on this machine (EBR 105, EBR 90, Lynx 6x6 not compared)');
    ok('no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    fs.rmSync(folder, {recursive: true, force: true});
  }
  console.log('gpu wheels (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
