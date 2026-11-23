// 23.11.2026 (NOTEBOOK A6 follow-up): the objects' atlas must fit the renderer's largest texture (gl
// MAX_TEXTURE_SIZE, which the page hands to the builder; 4096 by default). mapbuild9.js fitAtlas picks each tile at the
// texel density (32 px per metre) and, while the packed atlas is larger than that limit, lowers the density for the
// whole map by sqrt(2) steps - a map never fails to build for its atlas. Synthetic textures: each covers ground so that
// 512 px gives 32 px/m, 256 px 16 px/m and so on.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
['mapbuild.js', 'mapbuild9.js'].forEach(f => vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'web', 'playback', f), 'utf8'), { filename: f }));
const MB = globalThis.MapBuild;
let passed = 0;
function ok(what, fn) { fn(); passed++; console.log('ok - ' + what); }

function levels(top) {   // a square BC1 texture's stored levels from `top` px down to 4
  const L = [];
  for (let s = top; s >= 4; s >>= 1) { const bw = s >> 2; L.push({ size: s, w: s, h: s, bw: bw, bh: bw, b: new Uint8Array(bw * bw * 8) }); }
  return L;
}
// n textures, each with 1 repeat over (512 / 32)^2 = 256 m2: 512 px is 32 px/m
function tiles(n) {
  const m = new Map();
  for (let i = 0; i < n; i++) m.set('t' + String(i).padStart(3, '0') + '.dds', { L: levels(512), aw: 256, au: 1 });
  return m;
}
const inside = (r, max) => r.w <= max && r.h <= max;
const top = m => Math.max(...Array.from(m.values()).map(t => t.levels[0].w));

ok('within the default 4096: the full density, 512 px tiles', () => {
  const m = tiles(20), r = MB.fitAtlas(m);
  assert.strictEqual(r.density, MB.TEXEL_DENSITY); assert.ok(inside(r, 4096), r.w + 'x' + r.h); assert.strictEqual(top(m), 512);
});
ok('20 textures of 512 px do not fit 2048: the density lowered until they do', () => {
  const m = tiles(20), r = MB.fitAtlas(m, 2048);   // 20 x 512^2 = 5.2 M texels > 2048^2 = 4.2 M
  assert.ok(inside(r, 2048), r.w + 'x' + r.h);
  assert.ok(r.density < MB.TEXEL_DENSITY && r.density > MB.TEXEL_DENSITY / 4, String(r.density));
  assert.ok(top(m) <= 256, String(top(m)));
  Array.from(m.values()).forEach(t => { assert.ok(t.xy[0] + t.levels[0].w <= r.w && t.xy[1] + t.levels[0].h <= r.h, 'tile inside'); assert.strictEqual(t.xy[0] % 64, 0); assert.strictEqual(t.xy[1] % 64, 0); });
});
ok('the highest density that fits: one step up would not', () => {
  const m = tiles(20), r = MB.fitAtlas(m, 2048), up = r.density * Math.SQRT2;
  m.forEach(t => { t.want = MB.tileSize(t.L, t.aw, t.au, up); });
  const texels = Array.from(m.values()).reduce((s, t) => s + t.want * t.want, 0);
  assert.ok(texels > 2048 * 2048 || Math.max(...Array.from(m.values()).map(t => t.want)) === 512, 'one step up fits: ' + texels);
});
ok('a tiny limit (1024) still builds: many textures, everything smaller', () => {
  const m = tiles(150), r = MB.fitAtlas(m, 1024);
  assert.ok(inside(r, 1024), r.w + 'x' + r.h); assert.ok(r.density < 4, String(r.density));
});
ok('an odd limit below the atlas widths (800): the width is its 64 px grid', () => {
  const m = tiles(3), r = MB.fitAtlas(m, 800);
  assert.ok(inside(r, 800), r.w + 'x' + r.h); assert.strictEqual(r.w % 64, 0);
});
console.log('# ' + passed + ' passed');
