/* The GPU bounced leg against the CPU walk (26.09.2026), in a local headless Chrome/Edge on software WebGL.
 *
 * The REAL web/screen-armor.js composite (peel, contact law, bounceLeg over the three-mesh-bvh BVH) renders a synthetic
 * scene, and every pixel whose first contact is the ricochet plate is compared with ArmorBallistics.ray for the same
 * pixel ray: the "bounced shell penetrates" flag and the chance it is painted with.
 *
 * The scene is the Obj. 430U case (outputs/obj430u-side-pattern-2026-09-26.md): a flat 60 mm plate the shell ricochets
 * from, a collide-once 20 mm track box on the mirrored ray whose inner face lies IN THE PLANE of a 90 mm main plate,
 * and a thin 20 mm main plate behind. The leg that steps past one of two coincident surfaces loses the 90 mm plate and
 * paints ~100 % where the CPU gives ~20 %. Which surface the old first-hit traversal returned depended on the sign of
 * the direction on the BVH split axis, so the scene is run in both x directions and with both material id orders.
 * Also: the composite without the bounced leg (library hidden) and with Soft lighting still compile and render (lit: the
 * zone flag only, the light scales the colour). 26.09: a 30 mm skirt across the first leg - the bounced leg starts with
 * 0.75 x what was left behind it (variant B, engine.bounced), both x directions; a shell with traceRicochet false paints
 * the plain ricochet colour and no zone. 27.09: a ricochet inside a collide-once body - equal once the grey of the screen
 * in front is decoded as grey (the reported 47 % against 99 % was the test reading that grey as a chance).
 *
 * Test seam: an init script hides WEBGL_debug_renderer_info, so the Surface's software-WebGL guard (a performance
 * gate, not a correctness one) lets SwiftShader run the real program. Nothing in web/ is changed for the test.
 *
 *   node tests/page/gpu_bounce.cjs [--verbose]        exit 0 pass, 1 fail, 77 skip (no browser installed)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
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

// Runs in the page. One case: a scene mirrored by `sign` in x, the track listed before or after the side plate.
const PAGE = `
window.__gpuBounce = function (sign, trackFirst, options) {
  options = options || {};
  const B = ArmorBallistics, T = THREE, W = 320, H = 240;
  const main = {vehicleDamageFactor: 1, useHitAngle: true, mayRicochet: true, checkCaliberForRicochet: true, checkCaliberForHitAngleNorm: true, collideOnceOnly: false};
  const armor = {
    floor: Object.assign({}, main, {armor: 60}),
    track: {armor: 20, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, checkCaliberForRicochet: false, checkCaliberForHitAngleNorm: false, collideOnceOnly: true},
    side: Object.assign({}, main, {armor: options.side || 90}),
    back: Object.assign({}, main, {armor: 20}),
    skirt: {armor: options.skirt || 30, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, checkCaliberForRicochet: false, checkCaliberForHitAngleNorm: false, collideOnceOnly: true},
    box: {armor: 5, vehicleDamageFactor: 0, useHitAngle: false, mayRicochet: false, checkCaliberForRicochet: false, checkCaliberForHitAngleNorm: false, collideOnceOnly: true}
  };
  const tris = [];
  function quad(part, name, a, b, c, d) { const m = function (p) { return [p[0] * sign, p[1], p[2]]; };
    tris.push(B.triangle(m(a), m(b), m(c), part, name, armor[name]), B.triangle(m(a), m(c), m(d), part, name, armor[name])); }
  // A wall at x, split into strips so the BVH has several leaves along it.
  function wall(part, name, x) { for (let z = -2; z < 2; z += .5) quad(part, name, [x, 0, z], [x, 3, z], [x, 3, z + .5], [x, 0, z + .5]); }
  const hull = function () { quad(1, 'floor', [-3, 0, -2], [-3, 0, 2], [1.2, 0, 2], [1.2, 0, -2]); wall(1, 'side', 1.6); wall(1, 'back', 2.2); };
  // options.tieGap: one track wall only, that far BEHIND the side plate - inside the old CPU tie window (1e-4), outside
  // the peel's (1e-5).
  const chassis = options.tieGap ? function () { wall(2, 'track', 1.6 + options.tieGap); } : function () { wall(2, 'track', 1.3); wall(2, 'track', 1.6); };
  if (options.noTrack) hull(); else if (trackFirst) { chassis(); hull(); } else { hull(); chassis(); }
  // options.screen: a 30 mm skirt across the first leg, in front of the floor (the mirrored leg never comes back to it):
  // the bounced leg must start with 0.75 x what was left behind it, as the CPU's engine.bounced does.
  if (options.screen) wall(3, 'skirt', -3.5);
  // options.boxes (27.09, review of 5f2bee5): that many collide-once 5 mm bodies of their own (parts 10, 11, ...; a wheel
  // each), both faces across the mirrored leg between the compared ricochets (x < 1) and the side plate - the far face of
  // each must not take one of the leg's eight contacts, or five of them hide the side plate from the GPU (-2, "flies
  // past") while the CPU walks on to it.
  for (let k = 0; k < (options.boxes || 0); k++) { wall(10 + k, 'box', 1.02 + .1 * k); wall(10 + k, 'box', 1.06 + .1 * k); }
  // options.inside (27.09): a closed collide-once 5 mm body (part 20, a wheel's kind) over the floor, from options.inside.bottom (0: its
  // bottom face in the floor plane) to options.inside.top - the shell enters it through its top, ricochets off the floor INSIDE it and
  // leaves through its top or side: both legs count the body once each, as on the CPU.
  if (options.inside) {
    const y0 = options.inside.bottom, y1 = options.inside.top, x0 = -2.6, x1 = 1.1, z0 = -1.6, z1 = 1.6;
    quad(20, 'box', [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); quad(20, 'box', [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad(20, 'box', [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); quad(20, 'box', [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    quad(20, 'box', [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); quad(20, 'box', [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  }
  const engine = B.fromTriangles(tris);
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new T.WebGLRenderer({canvas: canvas, antialias: false}); renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  const hidden = window.MeshBVHLib; if (options.noBounce) window.MeshBVHLib = undefined;
  let surface;
  try { surface = new BullbaScreenArmor(renderer, engine); } finally { window.MeshBVHLib = hidden; }
  const out = {bounce: surface.bounce, reason: surface.bounceReason, lit: null, compared: 0, zone: 0, mismatches: [], cpuZone: 0};
  if (options.lit) out.lit = surface.setLighting(true);
  // options.far: the same view from 200 m through a narrow lens - the capture's near plane then sits far from the eye
  // and the depth buffer parts faces 50 um apart (at 8 m, with the near plane at 0.01 m, its pick there is noise).
  const k = options.far ? 25 : 1, camera = new T.PerspectiveCamera(options.far ? 1.6 : 40, W / H, options.far ? 150 : .1, options.far ? 300 : 100), anchor = new T.Vector3(0, 0, 0);
  camera.position.set(-8 * sign * k, 1.8 * k, .4 * k); camera.lookAt(anchor); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const shell = B.shell('ARMOR_PIERCING', options.pen || 140, 100);
  if (options.noTrace) shell.traceRicochet = false;
  // options.damage: the expected-damage map - an alpha and a non-penetration damage, so the share differs from the chance.
  if (options.damage) { shell.alpha = 300; shell.nonPiercingArmorDamage = 90; }
  out.carryMatters = 0; out.ricochetColour = 0; out.direct = 0; out.directBad = 0;
  // options.moving (28.09, steady-60): first the frame of a camera that has just moved under Ricochet trace "Always" - the
  // leg on its budget of BVH visits (options.budget lowers it: the negative control) - read and kept; then the same camera
  // SETTLE ms later, which must be the exact map again.
  // 28.09 (steady-60-fix): only a camera that MOVED is "moving" - the layers are first peeled for the camera a hair away,
  // then for this one. Layers dropped under a still camera (a pose, a model, a size) are drawn exact at once (moving.dropped).
  let moving = null;
  if (options.moving) {
    if (options.budget) surface.movingBudget = options.budget;
    const x0 = camera.position.x;
    camera.position.x = x0 + .05; camera.updateMatrixWorld();
    surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', 'chance');
    camera.position.x = x0; camera.updateMatrixWorld();
    surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', 'chance');
    moving = {budget: surface.material.uniforms.uLegBudget.value, pending: surface.bouncePending, data: new Float32Array(W * H * 4), agree: 0, zone: 0};
    renderer.readRenderTargetPixels(surface.result, 0, 0, W, H, moving.data);
    surface.movedAt = -1e9;
  }
  surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, options.moving ? 'always' : 'exact', options.damage ? 'damage' : 'chance');
  if (moving) {
    moving.after = surface.material.uniforms.uLegBudget.value; moving.pendingAfter = surface.bouncePending;
    const settled = surface.movedAt;
    surface.key = null;   // the layers dropped, the camera still
    surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', 'chance');
    moving.dropped = {budget: surface.material.uniforms.uLegBudget.value, pending: surface.bouncePending, movedAt: surface.movedAt === settled};
    surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', options.damage ? 'damage' : 'chance');
  }
  const data = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(surface.result, 0, 0, W, H, data);
  // The accessible palette's inverse: g rises to .75 on the lower half, only the upper half goes past it.
  const chanceOf = function (r, g) { return g > .75 + 1e-6 ? .5 + (.95 - r) / 1.5 : (g - .18) / 1.14; };
  const paletteOf = function (p) { const lo = [.63, .18, .55], mid = [.95, .75, .31], hi = [.20, .84, .76];
    return p < .5 ? lo.map(function (c, k) { return c + (mid[k] - c) * p * 2; }) : mid.map(function (c, k) { return c + (hi[k] - c) * (p * 2 - 1); }); };
  const o = [camera.position.x, camera.position.y, camera.position.z], v = new T.Vector3();
  for (let py = 0; py < H; py += 2) for (let px = 0; px < W; px += 2) {
    v.set((px + .5) / W * 2 - 1, (py + .5) / H * 2 - 1, -1).unproject(camera).sub(camera.position).normalize();
    const d = [v.x, v.y, v.z], r = engine.ray(o, d, shell);
    // A no-trace shell has no bounce on record: its ricochet contact is the result's own hit.
    const lost = r.reason === 'ricochet' && r.hit && !r.bounce, dir = r.direction || d;
    const first = r.bounce ? r.bounce.point : lost ? [o[0] + dir[0] * r.hit.distance, o[1] + dir[1] * r.hit.distance, o[2] + dir[2] * r.hit.distance] : null;
    const part = r.bounce ? r.bounce.part : lost ? r.hit.triangle.part : -1;
    // options.tieGap: the direct pixels on the side plate - the first leg's peel against the CPU's tie order.
    if (options.tieGap && !r.bounce && r.reason === 'penetration' && r.layers && r.layers.length && r.layers[r.layers.length - 1].material === 'side') {
      // Behind a screen in front the composite greys the colour by the opacity (as for the skirt below).
      const j = (py * W + px) * 4, c = paletteOf(r.chance / 100), e = r.layers[0].main ? c : c.map(function (v, q) { return v + ([.45, .50, .55][q] - v) * .35; });
      out.direct++; out.directLayers = Math.max(out.directLayers || 0, r.layers.length);
      if (Math.abs(data[j] - e[0]) > .02 || Math.abs(data[j + 1] - e[1]) > .02 || Math.abs(data[j + 2] - e[2]) > .02) { out.directBad++; if ((out.dbg = out.dbg || []).length < 3) out.dbg.push({cpu: r.chance, layers: r.layers.map(function (l) { return l.material; }).join('+'), gpu: Array.from(data.slice(j, j + 3))}); }
      continue;
    }
    // Only pixels that ricochet off the floor well inside its edges: the case under test, never a silhouette texel.
    if (!first || part !== 1 || first[1] > 1e-6 || Math.abs(first[2]) > 1.5 || first[0] * sign < -2.5 || first[0] * sign > 1) continue;
    const i = (py * W + px) * 4, a = data[i + 3], zone = a - 4 * Math.floor(a / 4) >= 2;
    if (lost && !zone && Math.abs(data[i] - .567) < .02 && Math.abs(data[i + 1] - .1755) < .02 && Math.abs(data[i + 2] - .55) < .02) out.ricochetColour++;
    // Where the carried remaining changes the answer: the same leg restarted from 0.75 x P (the rule before 26.09).
    if (r.bounce && r.reason === 'penetration') { const b = r.bounce, restart = engine.bounced([b.point[0] + b.direction[0] * 1e-3, b.point[1] + b.direction[1] * 1e-3, b.point[2] + b.direction[2] * 1e-3], b.direction, shell, shell.penetration);
      if (Math.abs((restart.chance || 0) - r.chance) >= 5) out.carryMatters++; }
    const cpuZone = r.reason === 'penetration', cpu = cpuZone ? (options.damage ? r.expectedShare : r.chance / 100) : null;
    if (options.damage && cpuZone && Math.abs(r.expectedShare - r.chance / 100) > .05) out.damageMatters = (out.damageMatters || 0) + 1;
    if (moving) { const ma = moving.data[i + 3], mz = ma - 4 * Math.floor(ma / 4) >= 2; if (mz) moving.zone++; if (mz === cpuZone) moving.agree++; }
    out.compared++; if (zone) out.zone++; if (cpuZone) { out.cpuZone++; out.cpuMax = Math.max(out.cpuMax || 0, r.chance); }
    const gpu = zone ? chanceOf(data[i], data[i + 1]) : null;
    // Behind a screen - a skirt, the face of a collide-once body the shell ricochets inside - the composite greys the
    // colour (the front layer is a screen: mix with (.45,.50,.55) by 1 - (1 - opacity)^screens, the first leg's screens),
    // so there the CPU chance is turned into that colour instead of the colour into a chance. options.plainDecode: the
    // comparison before 27.09, which read the greyed colour as a chance (the "GPU 47 % where the CPU gives 99 %" of the
    // collide-once body - a misreading, not a mismatch; kept as the negative control).
    const firstLeg = r.bounce ? r.bounce.layers || [] : [], screens = firstLeg.filter(function (l) { return !l.main; }).length;
    let off = zone && !options.lit && Math.abs(gpu - cpu) > .02;
    if (zone && !options.plainDecode && firstLeg.length && !firstLeg[0].main) { const share = 1 - Math.pow(1 - .35, screens), e = paletteOf(cpu).map(function (c, k) { return c + ([.45, .50, .55][k] - c) * share; });
      off = Math.abs(data[i] - e[0]) > .02 || Math.abs(data[i + 1] - e[1]) > .02 || Math.abs(data[i + 2] - e[2]) > .02; }
    if (zone !== cpuZone || off) { if (out.mismatches.length < 5) out.mismatches.push({px: px, py: py, cpu: cpu, gpu: gpu, layers: (r.layers || []).map(function (l) { return l.material; }).join('+')}); out.bad = (out.bad || 0) + 1; }
  }
  surface.dispose(); renderer.dispose(); canvas.remove();
  if (moving) { delete moving.data; out.moving = moving; }
  return out;
};`;

async function main() {
  const started = Date.now();
  const browser = await launch({width: 800, height: 600});
  if (!browser) { console.log('SKIP gpu bounce: no Chrome or Edge installed'); return 77; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-gpu-'));
  try {
    const scripts = ['vendor/three.min.js', 'vendor/three-mesh-bvh.umd.js', 'ballistics.js', 'screen-armor.js'].map(function (p) { return url.pathToFileURL(path.join(WEB, p)).href; });
    const html = '<!doctype html><meta charset="utf-8"><title>gpu bounce</title><body>' + scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('') + '<script>' + PAGE + '</script></body>';
    fs.writeFileSync(path.join(folder, 'page.html'), html);
    const page = await browser.open(url.pathToFileURL(path.join(folder, 'page.html')).href, INIT);
    for (const sign of [1, -1]) for (const trackFirst of [false, true]) {
      const name = 'bounced leg, ' + (sign > 0 ? '+x' : '-x') + ', ' + (trackFirst ? 'track' : 'hull') + ' ids first';
      const r = await page.evaluate('__gpuBounce(' + sign + ',' + trackFirst + ')');
      ok(name + ': the composite carries the bounced leg', r.bounce === true, '(' + r.reason + ')');
      ok(name + ': the scene has bounced pixels that reach the coincident plates', r.compared > 200 && r.cpuZone > 200, '(compared ' + r.compared + ', CPU zone ' + r.cpuZone + ')');
      ok(name + ': GPU zone and chance equal the CPU walk on every pixel', !r.bad, '(' + (r.bad || 0) + ' of ' + r.compared + ' differ, e.g. ' + JSON.stringify(r.mismatches) + ')');
    }
    const off = await page.evaluate('__gpuBounce(1,false,{noBounce:true})');
    ok('without three-mesh-bvh: the composite compiles without the leg and paints no zone', off.bounce === false && off.zone === 0 && off.compared > 200, '(' + off.reason + ', zone ' + off.zone + ')');
    // 26.09: the leg carries what the first leg left behind a screen (variant B), in both x directions.
    for (const sign of [1, -1]) {
      const sc = await page.evaluate('__gpuBounce(' + sign + ',false,{screen:true,pen:200})');
      ok('skirt before the ricochet, ' + (sign > 0 ? '+x' : '-x') + ': GPU zone and chance equal the CPU walk with the carried remaining', sc.compared > 200 && !sc.bad, '(' + (sc.bad || 0) + ' of ' + sc.compared + ' differ, e.g. ' + JSON.stringify(sc.mismatches) + ')');
      ok('skirt before the ricochet, ' + (sign > 0 ? '+x' : '-x') + ': the carried remaining changes the chance on many pixels', sc.carryMatters > 50, '(' + sc.carryMatters + ')');
    }
    // Review 26.09: the second leg in the expected-damage map - CPU withDamage on the leg's result, GPU uDamage at the leg's
    // main plate (the gate is 1 on the leg: only HE changes it, and HE does not ricochet).
    for (const sign of [1, -1]) {
      const dm = await page.evaluate('__gpuBounce(' + sign + ',false,{damage:true})');
      ok('damage map, ' + (sign > 0 ? '+x' : '-x') + ': the expected share of the bounced leg equals the CPU on every pixel', dm.compared > 200 && dm.cpuZone > 200 && dm.damageMatters > 50 && !dm.bad, '(compared ' + dm.compared + ', share differs from chance on ' + dm.damageMatters + ', ' + (dm.bad || 0) + ' differ, e.g. ' + JSON.stringify(dm.mismatches) + ')');
    }
    // Review 26.09 D1: a 101 mm skirt before the ricochet leaves a 100 mm shell -1 mm; the leg starts from max(0, -1) x 0.75
    // = 0 and a 50 mm wall behind is not pierced - on both sides (the CPU used to restart from 0.75 x P: 100 %).
    const neg = await page.evaluate('__gpuBounce(1,false,{screen:true,pen:100,skirt:101,side:50,noTrack:true})');
    ok('skirt thicker than the shell: the leg starts from nothing, GPU equals CPU and the 50 mm wall stays 0 %', neg.compared > 200 && neg.cpuZone > 200 && !neg.cpuMax && !neg.bad, '(compared ' + neg.compared + ', CPU zone ' + neg.cpuZone + ', CPU max ' + neg.cpuMax + ', ' + (neg.bad || 0) + ' differ, e.g. ' + JSON.stringify(neg.mismatches) + ')');
    // Review 26.09 R3: one coincidence tolerance (ArmorBallistics.TIE). A track face 50 um behind the side plate, seen from
    // 200 m: the peel meets the plate first whatever the ids and stops there; the CPU's old 0.1 mm tie put the track's
    // 20 mm in front of the plate when the track had the lower id.
    for (const trackFirst of [true, false]) {
      const tie = await page.evaluate('__gpuBounce(1,' + trackFirst + ',{tieGap:5e-5,far:true})');
      ok('a track face 50 um behind a main plate, ' + (trackFirst ? 'track' : 'hull') + ' ids first: the peel and the CPU meet the plate alone', tie.direct > 200 && tie.directLayers === 1 && !tie.directBad, '(direct ' + tie.direct + ', CPU layers ' + tie.directLayers + ', ' + tie.directBad + ' differ, e.g. ' + JSON.stringify(tie.dbg) + ')');
    }
    // Review of 5f2bee5: five collide-once bodies (ten faces) and the side plate on the leg - GPU equals CPU, both directions.
    for (const sign of [1, -1]) {
      const bx = await page.evaluate('__gpuBounce(' + sign + ',false,{boxes:5,pen:200,noTrack:true})');
      ok('five collide-once bodies on the bounced leg, ' + (sign > 0 ? '+x' : '-x') + ': each costs one contact, the side plate behind is reached as on the CPU', bx.compared > 200 && bx.cpuZone > 200 && !bx.bad, '(compared ' + bx.compared + ', CPU zone ' + bx.cpuZone + ', ' + (bx.bad || 0) + ' differ, e.g. ' + JSON.stringify(bx.mismatches) + ')');
    }
    // 27.09: a ricochet inside a collide-once body (its bottom in the floor's plane, or below it), both x directions: zone
    // and chance as on the CPU once the screen's grey is read as grey. Negative control: the plain decode reads that grey as
    // a chance and reports every zone pixel (GPU ~47 % where the CPU gives 100 %) - what was taken for a GPU mismatch.
    for (const bottom of [0, -.1]) for (const sign of [1, -1]) {
      const inside = await page.evaluate('__gpuBounce(' + sign + ',false,{inside:{bottom:' + bottom + ',top:.3},pen:200,noTrack:true})');
      ok('ricochet inside a collide-once body (bottom ' + bottom + ' m), ' + (sign > 0 ? '+x' : '-x') + ': GPU zone and chance equal the CPU walk', inside.compared > 200 && inside.cpuZone > 200 && !inside.bad, '(compared ' + inside.compared + ', CPU zone ' + inside.cpuZone + ', ' + (inside.bad || 0) + ' differ, e.g. ' + JSON.stringify(inside.mismatches) + ')');
    }
    const plain = await page.evaluate('__gpuBounce(1,false,{inside:{bottom:0,top:.3},pen:200,noTrack:true,plainDecode:true})');
    ok('negative control: the plain decode misreads the screen-greyed zone as ~47 % on every zone pixel', plain.bad === plain.cpuZone && plain.cpuZone > 200
       && plain.mismatches.every(function (m) { return m.cpu === 1 && Math.abs(m.gpu - .4746) < .005; }), '(' + (plain.bad || 0) + ' of ' + plain.cpuZone + ', e.g. ' + JSON.stringify(plain.mismatches.slice(0, 2)) + ')');
    // A shell with enableTraceRicochet false: lost at the ricochet - no zone, the plain ricochet colour, no leg on the CPU.
    const nt = await page.evaluate('__gpuBounce(1,false,{noTrace:true})');
    ok('no-trace shell: no second leg on either side, the ricochet colour everywhere', nt.compared > 200 && nt.zone === 0 && nt.cpuZone === 0 && nt.ricochetColour === nt.compared, '(compared ' + nt.compared + ', zone ' + nt.zone + ', CPU zone ' + nt.cpuZone + ', ricochet colour ' + nt.ricochetColour + ')');
    // 28.09 (steady-60): the leg on a budget of BVH visits while the camera moves, exact again once it stands - both x
    // directions; this scene's legs are short, so the moving frame is the exact one. Negative control: a budget of one
    // visit cuts every leg (no zone while moving), and the frame at rest has it back.
    for (const sign of [1, -1]) {
      const mv = await page.evaluate('__gpuBounce(' + sign + ',false,{moving:true})'), m = mv.moving || {};
      ok('camera moving, ' + (sign > 0 ? '+x' : '-x') + ': the leg runs on its budget and a redraw at rest is asked for', m.budget === 512 && m.pending === true, JSON.stringify(m));
      ok('camera moving, ' + (sign > 0 ? '+x' : '-x') + ': short legs are within the budget - zone as on the CPU on every compared pixel', mv.compared > 200 && m.agree === mv.compared, '(' + m.agree + ' of ' + mv.compared + ')');
      ok('camera at rest, ' + (sign > 0 ? '+x' : '-x') + ': the exact leg again, zone and chance equal the CPU walk on every pixel', m.after > 1e9 && m.pendingAfter === false && mv.compared > 200 && mv.cpuZone > 200 && !mv.bad, '(' + (mv.bad || 0) + ' of ' + mv.compared + ' differ, e.g. ' + JSON.stringify(mv.mismatches) + ')');
      ok('layers dropped under a still camera, ' + (sign > 0 ? '+x' : '-x') + ': drawn exact at once, no settle, no redraw asked for', !!m.dropped && m.dropped.budget > 1e9 && m.dropped.pending === false && m.dropped.movedAt === true, JSON.stringify(m.dropped));
    }
    const cut = await page.evaluate('__gpuBounce(1,false,{moving:true,budget:1})'), cm = cut.moving || {};
    ok('negative control: a budget of one visit leaves no zone while moving, the exact one at rest', cm.budget === 1 && cm.zone === 0 && cut.cpuZone > 200 && !cut.bad, JSON.stringify(cm));
    const lit = await page.evaluate('__gpuBounce(-1,true,{lit:true})');
    ok('Soft lighting with the leg: the lit composite compiles and flags the same zone as the CPU (the light scales the colour)', lit.lit === true && lit.bounce === true && !lit.bad, '(lit ' + lit.lit + ', ' + (lit.bad || 0) + ' differ)');
    ok('no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    fs.rmSync(folder, {recursive: true, force: true});
  }
  console.log('gpu bounce (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
