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
 * zone flag only, the light scales the colour).
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
    side: Object.assign({}, main, {armor: 90}),
    back: Object.assign({}, main, {armor: 20})
  };
  const tris = [];
  function quad(part, name, a, b, c, d) { const m = function (p) { return [p[0] * sign, p[1], p[2]]; };
    tris.push(B.triangle(m(a), m(b), m(c), part, name, armor[name]), B.triangle(m(a), m(c), m(d), part, name, armor[name])); }
  // A wall at x, split into strips so the BVH has several leaves along it.
  function wall(part, name, x) { for (let z = -2; z < 2; z += .5) quad(part, name, [x, 0, z], [x, 3, z], [x, 3, z + .5], [x, 0, z + .5]); }
  const hull = function () { quad(1, 'floor', [-3, 0, -2], [-3, 0, 2], [1.2, 0, 2], [1.2, 0, -2]); wall(1, 'side', 1.6); wall(1, 'back', 2.2); };
  const chassis = function () { wall(2, 'track', 1.3); wall(2, 'track', 1.6); };
  if (trackFirst) { chassis(); hull(); } else { hull(); chassis(); }
  const engine = B.fromTriangles(tris);
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  const renderer = new T.WebGLRenderer({canvas: canvas, antialias: false}); renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  const hidden = window.MeshBVHLib; if (options.noBounce) window.MeshBVHLib = undefined;
  let surface;
  try { surface = new BullbaScreenArmor(renderer, engine); } finally { window.MeshBVHLib = hidden; }
  const out = {bounce: surface.bounce, reason: surface.bounceReason, lit: null, compared: 0, zone: 0, mismatches: [], cpuZone: 0};
  if (options.lit) out.lit = surface.setLighting(true);
  const camera = new T.PerspectiveCamera(40, W / H, .1, 100), anchor = new T.Vector3(0, 0, 0);
  camera.position.set(-8 * sign, 1.8, .4); camera.lookAt(anchor); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const shell = B.shell('ARMOR_PIERCING', 140, 100);
  surface.render(camera, anchor, shell, 'accessible', .35, 'high', W, H, 1, 'always', 'chance');
  const data = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(surface.result, 0, 0, W, H, data);
  // The accessible palette's inverse: g rises to .75 on the lower half, only the upper half goes past it.
  const chanceOf = function (r, g) { return g > .75 + 1e-6 ? .5 + (.95 - r) / 1.5 : (g - .18) / 1.14; };
  const o = [camera.position.x, camera.position.y, camera.position.z], v = new T.Vector3();
  for (let py = 0; py < H; py += 2) for (let px = 0; px < W; px += 2) {
    v.set((px + .5) / W * 2 - 1, (py + .5) / H * 2 - 1, -1).unproject(camera).sub(camera.position).normalize();
    const d = [v.x, v.y, v.z], r = engine.ray(o, d, shell);
    const first = r.bounce ? r.bounce.point : null;
    // Only pixels that ricochet off the floor well inside its edges: the case under test, never a silhouette texel.
    if (!first || r.bounce.part !== 1 || first[1] > 1e-6 || Math.abs(first[2]) > 1.5 || first[0] * sign < -2.5 || first[0] * sign > 1) continue;
    const i = (py * W + px) * 4, a = data[i + 3], zone = a - 4 * Math.floor(a / 4) >= 2;
    const cpuZone = r.reason === 'penetration', cpu = cpuZone ? r.chance / 100 : null;
    out.compared++; if (zone) out.zone++; if (cpuZone) out.cpuZone++;
    const gpu = zone ? chanceOf(data[i], data[i + 1]) : null;
    if (zone !== cpuZone || (zone && !options.lit && Math.abs(gpu - cpu) > .02)) { if (out.mismatches.length < 5) out.mismatches.push({px: px, py: py, cpu: cpu, gpu: gpu, layers: (r.layers || []).map(function (l) { return l.material; }).join('+')}); out.bad = (out.bad || 0) + 1; }
  }
  surface.dispose(); renderer.dispose(); canvas.remove();
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
