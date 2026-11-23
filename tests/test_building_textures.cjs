// NOTEBOOK A6 (23.11.2026, the user's screenshot of Fisherman's Bay): two houses side by side, one sharp, the other
// extremely blurred. Cause: the LOD choice fell through to the game's far impostor LOD (one baked whole-building
// texture, 128 px in the client) on some houses and kept the tiled materials on others, and every texture got the same
// 64 px atlas tile whatever ground it covers. Here: the map as the page builds it from the mod's copy (the local
// fixture, made by tests/building_textures_fixture.py), the texel density of every building's texture as built
// (sqrt(uv area x tile pixels / world area), area-weighted per model, px per metre) - the spread must be small and at
// the target. Before the fix: 0.6 .. 30.4 px/m (outputs/building-textures-2026-11-23.md).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..'), FIX = path.join(ROOT, 'tests', 'fixtures-local', 'building-textures-2026-11-23', '36_fishing_bay');
if (!fs.existsSync(path.join(FIX, 'manifest.js'))) { console.log('SKIP the Fisherman\'s Bay copy is not on this machine (tests/building_textures_fixture.py makes it)'); process.exit(0); }
['mapbuild.js', 'mapbuild9.js'].forEach(f => vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'web', 'playback', f), 'utf8'), { filename: f }));
const MB = globalThis.MapBuild;
let passed = 0;
function ok(what, fn) { fn(); passed++; console.log('ok - ' + what); }

function loadRaw() {
  const raw = new MB.Raw();
  const ctx = { MapRaw: { put: (n, s) => raw.put(n, s), manifest: m => { raw.manifest = m; } } }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FIX, 'manifest.js'), 'utf8'), ctx);
  raw.manifest.parts.forEach(p => vm.runInContext(fs.readFileSync(path.join(FIX, p), 'utf8'), ctx));
  raw.loadRes = e => { throw new Error('not in the parts: ' + e.path); };
  return raw;
}
// per visual model: area-weighted geometric mean of px per metre over its triangles (first instance's scale)
function densities(map) {
  const W = map.atlas.w, H = map.atlas.h, out = [];
  map.visual.forEach(rec => {
    if (rec.rock) return;
    const nv = rec.nv, P = new Float64Array(nv * 3), U = new Float64Array(nv * 2), m = rec.m;
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++) P[i * 3 + k] = rec.pmin[k] + rec.p[i * 3 + k] / 65535 * rec.prange[k];
      for (let k = 0; k < 2; k++) U[i * 2 + k] = rec.umin[k] + rec.uv[i * 2 + k] / 65535 * rec.urange[k];
    }
    const tr = v => [v[0] * m[0] + v[1] * m[3] + v[2] * m[6], v[0] * m[1] + v[1] * m[4] + v[2] * m[7], v[0] * m[2] + v[1] * m[5] + v[2] * m[8]];
    const per = new Map();
    for (let q = 0; q < rec.i.length; q += 3) {
      const a = rec.i[q], b = rec.i[q + 1], c = rec.i[q + 2];
      const e1 = tr([0, 1, 2].map(k => P[b * 3 + k] - P[a * 3 + k])), e2 = tr([0, 1, 2].map(k => P[c * 3 + k] - P[a * 3 + k]));
      const wa = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      const ua = 0.5 * Math.abs((U[b * 2] - U[a * 2]) * (U[c * 2 + 1] - U[a * 2 + 1]) - (U[c * 2] - U[a * 2]) * (U[b * 2 + 1] - U[a * 2 + 1]));
      if (wa < 1e-6) continue;
      const t = rec.tile[a]; let s = per.get(t); if (!s) per.set(t, s = { wa: 0, ua: 0 });
      s.wa += wa; s.ua += ua;
    }
    let A = 0, X = 0;
    per.forEach((s, t) => { const r = rec.rects[t], px = r[2] * W * r[3] * H; if (s.ua > 0) { A += s.wa; X += s.wa * Math.log(Math.sqrt(s.ua * px / s.wa)); } });
    if (A > 0) out.push({ name: rec.name, area: A, d: Math.exp(X / A) });
  });
  return out;
}

(async () => {
  const res = await MB.build(loadRaw(), { gameplay: 'ctf', minimapFit: false, cache: null });
  const all = densities(res.map), bld = all.filter(x => /^hd_bld/i.test(x.name) && x.area > 20);
  const ds = bld.map(x => x.d).sort((a, b) => a - b), lo = ds[0], hi = ds[ds.length - 1];
  console.log('# buildings over 20 m2: ' + ds.length + ', px/m min ' + lo.toFixed(1) + ' median ' + ds[ds.length >> 1].toFixed(1) + ' max ' + hi.toFixed(1)
    + '; lowest: ' + bld.sort((a, b) => a.d - b.d).slice(0, 3).map(x => x.name + ' ' + x.d.toFixed(1)).join(', ') + '; atlas ' + res.map.atlas.w + 'x' + res.map.atlas.h);
  ok('every building drawn (more than 30 over 20 m2)', () => assert.ok(ds.length > 30, String(ds.length)));
  ok('no building blurred: at least 16 px per metre (before: 0.6)', () => assert.ok(lo >= 16, 'min ' + lo.toFixed(2)));
  ok('one level for all: the sharpest at most 2.5 x the softest (before: 50 x)', () => assert.ok(hi / lo <= 2.5, (hi / lo).toFixed(1)));
  ok('at the target: the median within 24 .. 40 px per metre', () => { const md = ds[ds.length >> 1]; assert.ok(md >= 24 && md <= 40, md.toFixed(1)); });
  console.log('# ' + passed + ' passed');
})().catch(e => { console.error('not ok - ' + (e && e.stack || e)); process.exit(1); });
