/* Bullba Hits' 3D replay player (BACKLOG 104): the map builder in JS, copied unchanged from the trial
   (work/map-playback/mapbuild.js, rounds 8-9); the raw set now comes from the mod (map_raw.py, under CFG/mapraw/).
   Round 8's description:
   Runs in a classic blob worker of the page (mapbuild-page.js) and in node (round8/compare.cjs). Input: the raw set the
   copy step wrote (rawcopy.py: raw/<arena>/manifest.js + part-NNN.js, each part a list of MapRaw.put(name, base64)).
   Output: the structures playback.js already reads for the default view, typed arrays instead of base64:
     arena record (per arena + input CRCs): terrain (2 m heights, as build.build_terrain), glob (the game's own DXT5
       colour blocks of global_am.dds passed through as BC1, 3 levels, no re-encode), water, sun, arena box;
     relief record (per arena): the light map's 3 relief terms already weighted and summed (light5c), kept so that a
       second gameplay of the arena does not redo them;
     map record (per arena + gameplay + inputs + placements): mode objects, light map (8-bit, light / 2), the global
       map's minimap white balance where the map has a rendered minimap (ground5.fit_to_minimap).
   Not ported in this slice (the page keeps the prebuilt data for them): plants, object visual models, collision,
   destruction lookup; the light map's plant / object footprints read their placements from the prebuilt map data.
   Kernels: work/map-playback/cache/port-research2/kernels.js (checked bit-equal there), copied here; the 2 m grid kept
   in float64 as build.py does (the research kernel wrote float32). Every step names the Python step it mirrors. */
(function (G) {
  'use strict';
  var MB = { VERSION: 'r8.1' };
  var f = Math.fround;
  // ---------------------------------------------------------------- counters: nothing is done twice
  var C = MB.counts = { rawDecoded: {}, parsed: {}, stages: {} };
  function once(kind, name) { var m = C.parsed[kind] || (C.parsed[kind] = {}); m[name] = (m[name] || 0) + 1; }
  MB.resetCounts = function () { C.rawDecoded = {}; C.parsed = {}; C.stages = {}; };
  var now = (typeof performance !== 'undefined') ? function () { return performance.now(); } : Date.now;

  // ---------------------------------------------------------------- the raw set (MapRaw.put from the part scripts)
  function Raw() { this.b64 = {}; this.bytes = {}; this.manifest = null; }
  Raw.prototype.put = function (name, s) { this.b64[name] = s; };
  Raw.prototype.has = function (name) { return name in this.b64 || name in this.bytes; };
  Raw.prototype.get = function (name) {
    var b = this.bytes[name];
    if (b) return b;
    var s = this.b64[name]; if (s == null) return null;
    var bin = atob(s), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    delete this.b64[name]; this.bytes[name] = u; C.rawDecoded[name] = (C.rawDecoded[name] || 0) + 1;
    return u;
  };
  Raw.prototype.names = function () { return Object.keys(this.b64).concat(Object.keys(this.bytes)); };
  MB.Raw = Raw;

  // keys: the manifest's source zip CRCs (free from the package directory), never the bytes themselves
  function fnv(s, h) { h = h == null ? 0x811c9dc5 : h; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  MB.fnv = fnv;
  MB.inputKey = function (manifest) {
    var parts = manifest.files.map(function (e) { return e.name + ':' + e.path + ':' + e.crc + ':' + (e.memberCrc || '') + ':' + (e.section || '') + ':' + (e.firstLevel || ''); })
      .concat((manifest.res || []).map(function (e) { return 'res:' + e.path + ':' + e.crc; })).sort();
    var h1 = fnv(MB.VERSION + '|' + parts.join('|')), h2 = fnv(parts.join('#'), 0x1234567);
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  };
  MB.keys = function (manifest, gameplay) {
    var k = MB.inputKey(manifest), a = manifest.arena;
    return { arena: 'arena|' + a + '|' + k, relief: 'relief|' + a + '|' + k, fit: 'fit|' + a + '|' + k, map: 'map|' + a + '|' + gameplay + '|' + k };
  };

  // ---------------------------------------------------------------- packed XML (local_armor_inspector/packed_xml.decode)
  function El(tag) { this.tag = tag; this.text = null; this.kids = []; }
  El.prototype.find = function (path) {
    var parts = path.split('/'), cur = [this];
    for (var i = 0; i < parts.length; i++) {
      var nx = [];
      cur.forEach(function (e) { e.kids.forEach(function (k) { if (k.tag === parts[i]) nx.push(k); }); });
      cur = nx; if (!cur.length) return null;
    }
    return cur[0];
  };
  El.prototype.findall = function (path) {
    var parts = path.split('/'), cur = [this];
    for (var i = 0; i < parts.length; i++) {
      var nx = []; cur.forEach(function (e) { e.kids.forEach(function (k) { if (k.tag === parts[i]) nx.push(k); }); }); cur = nx;
    }
    return cur;
  };
  El.prototype.findtext = function (path) { var e = this.find(path); return e ? (e.text == null ? '' : e.text) : null; };
  var td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function utf8(u) { return td.decode(u); }
  MB.packedXml = function (data, name) {
    once('packed xml', name || '?');
    if (!(data[0] === 0x45 && data[1] === 0x4e && data[2] === 0xa1 && data[3] === 0x62 && data[4] === 0)) throw new Error('not a packed XML: ' + name);
    var dv = new DataView(data.buffer, data.byteOffset, data.byteLength), names = [], pos = 5;
    for (;;) { var end = data.indexOf(0, pos); if (end === pos) { pos++; break; } names.push(utf8(data.subarray(pos, end))); pos = end + 1; }
    function value(el, kind, a, b, depth) {
      if (b < a || b > data.length || depth > 100) throw new Error('Invalid packed XML bounds');
      var raw = data.subarray(a, b);
      if (kind === 0) section(el, a, b, depth + 1);
      else if (kind === 1) el.text = utf8(raw);
      else if (kind === 2) { var n = 0; for (var i = raw.length - 1; i >= 0; i--) n = n * 256 + raw[i]; if (raw.length && raw[raw.length - 1] & 128) n -= Math.pow(2, 8 * raw.length); el.text = String(n); }
      else if (kind === 3) { var s = []; for (i = 0; i + 4 <= raw.length; i += 4) s.push(String(dv.getFloat32(a + i, true))); el.text = s.join(' '); }
      else if (kind === 4) el.text = raw.length ? 'true' : 'false';
      else if (kind === 5) { var bin = ''; for (i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]); el.text = btoa(bin); }
      else throw new Error('Unknown packed XML value');
    }
    function section(el, a, b, depth) {
      var count = dv.getUint16(a, true), own = dv.getUint32(a + 2, true), header = a + 6 + count * 6;
      if (header > b) throw new Error('Invalid packed XML header');
      var offset = own & 0xfffffff;
      value(el, own >>> 28, header, header + offset, depth);
      for (var i = 0; i < count; i++) {
        var nm = dv.getUint16(a + 6 + i * 6, true), word = dv.getUint32(a + 8 + i * 6, true), e = word & 0xfffffff, child = new El(names[nm]);
        el.kids.push(child); value(child, word >>> 28, header + offset, header + e, depth); offset = e;
      }
    }
    var root = new El('root'); section(root, pos, data.length, 0); return root;
  };
  var floats = function (s) { return String(s).trim().split(/\s+/).filter(Boolean).map(Number); };

  // ---------------------------------------------------------------- zlib (PNG IDAT) through DecompressionStream
  MB.inflate = async function (z) {
    var ds = new DecompressionStream('deflate');
    var w = ds.writable.getWriter(); w.write(z); w.close();
    var r = ds.readable.getReader(), parts = [], n = 0;
    for (;;) { var x = await r.read(); if (x.done) break; parts.push(x.value); n += x.value.length; }
    if (parts.length === 1) return parts[0];
    var out = new Uint8Array(n), p = 0; parts.forEach(function (a) { out.set(a, p); p += a.length; }); return out;
  };

  // ---------------------------------------------------------------- kernels (port-research2/kernels.js)
  function pngIdat(u8, off) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), p = off + 8, parts = [], w = 0, h = 0, tot = 0;
    while (p < u8.length) {
      var ln = dv.getUint32(p), t = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      if (t === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); }
      else if (t === 'IDAT') { parts.push(u8.subarray(p + 8, p + 8 + ln)); tot += ln; }
      else if (t === 'IEND') break;
      p += 12 + ln;
    }
    var z = parts.length === 1 ? parts[0] : new Uint8Array(tot);
    if (parts.length > 1) { var q = 0; parts.forEach(function (a) { z.set(a, q); q += a.length; }); }
    return { w: w, h: h, z: z };
  }
  MB.pngIdat = pngIdat;
  function unfilter(raw, w, h, bpp, out) {
    var stride = w * bpp, pos = 0, o = 0;
    for (var y = 0; y < h; y++) {
      var ft = raw[pos++], pr = o - stride, i, a, b, c;
      if (ft === 0) { for (i = 0; i < stride; i++) out[o + i] = raw[pos + i]; }
      else if (ft === 1) { for (i = 0; i < bpp; i++) out[o + i] = raw[pos + i]; for (i = bpp; i < stride; i++) out[o + i] = (raw[pos + i] + out[o + i - bpp]) & 255; }
      else if (ft === 2) { for (i = 0; i < stride; i++) out[o + i] = (raw[pos + i] + (y ? out[pr + i] : 0)) & 255; }
      else if (ft === 3) { for (i = 0; i < stride; i++) { a = i >= bpp ? out[o + i - bpp] : 0; b = y ? out[pr + i] : 0; out[o + i] = (raw[pos + i] + ((a + b) >> 1)) & 255; } }
      else if (ft === 4) {
        for (i = 0; i < stride; i++) {
          a = i >= bpp ? out[o + i - bpp] : 0; b = y ? out[pr + i] : 0; c = (y && i >= bpp) ? out[pr + i - bpp] : 0;
          var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          out[o + i] = (raw[pos + i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
        }
      }
      pos += stride; o += stride;
    }
    return out;
  }
  MB.unfilter = unfilter;
  // terrain.read_heights: 'hmp\0', w, h, comp, version 4, min, max, pad, 'qpng' + PNG of int32 millimetres
  async function readHeights(blob, name) {
    once('heights', name);
    var dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength), w = dv.getUint32(4, true), h = dv.getUint32(8, true);
    if (blob[0] !== 0x68 || dv.getUint32(16, true) !== 4) throw new Error('heights: bad header ' + name);
    var I = pngIdat(blob, 36), raw = await MB.inflate(I.z);
    var px = unfilter(raw, w, h, 4, new Uint8Array(w * h * 4)), i32 = new Int32Array(px.buffer), a = new Float64Array(w * h);
    for (var i = 0; i < w * h; i++) a[i] = i32[i] * 0.001;
    return { w: w, h: h, a: a };
  }
  function s16(hex) { var v = parseInt(hex, 16); return v >= 0x8000 ? v - 0x10000 : v; }
  // terrain.Terrain.height_at: the client's two triangles per cell (VIS 2, n = 64 cells per 100 m chunk)
  function heightAt(T, x, z) {
    var cx = Math.floor(x / 100), cz = Math.floor(z / 100), c = T.map[cx * 65536 + cz];
    if (!c) return null;
    var a = c.a, N = c.w, M = c.h, sp = 100 / T.n;
    var xs = (x - cx * 100) / sp + 2, zs = (z - cz * 100) / sp + 2, X = Math.trunc(xs), Z = Math.trunc(zs), xf = xs - X, zf = zs - Z;
    var g = function (i, j) { return a[Math.min(j, M - 1) * N + Math.min(i, N - 1)]; };
    if ((X ^ Z) & 1) {
      var h01 = g(X, Z + 1), h10 = g(X + 1, Z);
      if (1 - xf > zf) { var h00 = g(X, Z); return h00 + (h10 - h00) * xf + (h01 - h00) * zf; }
      var h11 = g(X + 1, Z + 1); return h11 + (h01 - h11) * (1 - xf) + (h10 - h11) * (1 - zf);
    }
    var e00 = g(X, Z), e11 = g(X + 1, Z + 1);
    if (xf > zf) { var e10 = g(X + 1, Z); return e10 + (e00 - e10) * (1 - xf) + (e11 - e10) * zf; }
    var e01 = g(X, Z + 1); return e01 + (e11 - e01) * xf + (e00 - e01) * (1 - zf);
  }
  MB.heightAt = heightAt;
  function rhe(x) { var r = Math.round(x); if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2); return r; }  // numpy round half to even
  // light5c.chunk_mosaic(heights, res 64): a[2:66, 2:66] of every chunk on one grid, zeros where no chunk
  function mosaic(T, res) {
    var ks = T.list, cx0 = 1e9, cz0 = 1e9, cx1 = -1e9, cz1 = -1e9;
    ks.forEach(function (c) { cx0 = Math.min(cx0, c.cx); cz0 = Math.min(cz0, c.cz); cx1 = Math.max(cx1, c.cx); cz1 = Math.max(cz1, c.cz); });
    var nx = cx1 - cx0 + 1, nz = cz1 - cz0 + 1, W = nx * res, out = new Float32Array(nz * res * W);
    ks.forEach(function (c) {
      var ox = (c.cx - cx0) * res, oz = (c.cz - cz0) * res;
      for (var r = 0; r < res; r++) for (var q = 0; q < res; q++) out[(oz + r) * W + ox + q] = c.a[(2 + r) * c.w + 2 + q];
    });
    return { a: out, W: W, H: nz * res, x0: cx0 * 100, z0: cz0 * 100, px: 100 / res };
  }
  // light5c.sample: bilinear of a grid at xs, zs (float32 out)
  function sample(g, gx0, gz0, gpx, xs, zs) {
    var W = xs.length, H = zs.length, out = new Float32Array(W * H), GW = g.W, GH = g.H, a = g.a, I0 = new Int32Array(W), U = new Float64Array(W), i;
    for (i = 0; i < W; i++) { var fi = (xs[i] - gx0) / gpx, i0 = Math.min(Math.max(Math.floor(fi), 0), GW - 2); I0[i] = i0; U[i] = Math.min(Math.max(fi - i0, 0), 1); }
    for (var j = 0; j < H; j++) {
      var fj = (zs[j] - gz0) / gpx, j0 = Math.min(Math.max(Math.floor(fj), 0), GH - 2), v = Math.min(Math.max(fj - j0, 0), 1), r0 = j0 * GW, r1 = r0 + GW, o = j * W;
      for (i = 0; i < W; i++) { var x = I0[i], u = U[i]; out[o + i] = a[r0 + x] * (1 - u) * (1 - v) + a[r0 + x + 1] * u * (1 - v) + a[r1 + x] * (1 - u) * v + a[r1 + x + 1] * u * v; }
    }
    return out;
  }
  // blur: three box passes per axis (Kovesi sizes), edges clamped - in place of light5c.gauss (FFT, edge-padded)
  function boxSizes(sigma, n) {
    var wI = Math.sqrt(12 * sigma * sigma / n + 1), wl = Math.floor(wI); if (wl % 2 === 0) wl--;
    var wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)), s = [];
    for (var i = 0; i < n; i++) s.push(i < m ? wl : wu);
    return s;
  }
  function boxH(src, dst, W, H, r) {
    var inv = 1 / (2 * r + 1);
    for (var y = 0; y < H; y++) {
      var o = y * W, acc = 0, first = src[o], last = src[o + W - 1];
      for (var k = -r; k <= r; k++) acc += src[o + Math.min(Math.max(k, 0), W - 1)];
      for (var x = 0; x < W; x++) { dst[o + x] = acc * inv; var add = x + r + 1, sub = x - r; acc += (add < W ? src[o + add] : last) - (sub > 0 ? src[o + sub] : first); }
    }
  }
  function boxV(src, dst, W, H, r) {
    var inv = 1 / (2 * r + 1), acc = new Float64Array(W), x;
    for (var k = -r; k <= r; k++) { var o = Math.min(Math.max(k, 0), H - 1) * W; for (x = 0; x < W; x++) acc[x] += src[o + x]; }
    for (var y = 0; y < H; y++) {
      var od = y * W, oa = Math.min(y + r + 1, H - 1) * W, os = Math.max(y - r, 0) * W;
      for (x = 0; x < W; x++) { dst[od + x] = acc[x] * inv; acc[x] += src[oa + x] - src[os + x]; }
    }
  }
  function blur(a, W, H, sigma, tmp) {
    C.stages.blurs = (C.stages.blurs || 0) + 1;
    if (sigma <= 0.3) return a.slice();
    var s = boxSizes(sigma, 3), t = tmp || new Float32Array(W * H), b = a.slice();
    for (var i = 0; i < 3; i++) { boxH(b, t, W, H, (s[i] - 1) >> 1); boxV(t, b, W, H, (s[i] - 1) >> 1); }
    return b;
  }
  MB.blur = blur;
  // DDS levels (dds.decode's level walk) and the colour half decode (dds._bc1_colors, RGB truncated as numpy's astype)
  function ddsLevels(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), h = dv.getUint32(12, true), w = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true));
    var four = String.fromCharCode(u8[84], u8[85], u8[86], u8[87]), bs = four === 'DXT1' ? 8 : 16, p = 128, ww = w, hh = h, out = [];
    for (var l = 0; l < mips; l++) {
      var bw = Math.max(1, (ww + 3) >> 2), bh = Math.max(1, (hh + 3) >> 2);
      out.push({ w: ww, h: hh, bw: bw, bh: bh, bs: bs, off: p, four: four });
      p += bw * bh * bs; ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1);
    }
    return out;
  }
  MB.ddsLevels = ddsLevels;
  function decodeColour(u8, L) {  // -> RGBA Uint8 (alpha 255)
    var W = L.bw * 4, out = new Uint8Array(L.bw * 4 * L.bh * 4 * 4), pal = new Float64Array(12), p = L.off + (L.bs - 8);
    for (var by = 0; by < L.bh; by++) for (var bx = 0; bx < L.bw; bx++, p += L.bs) {
      var c0 = u8[p] | u8[p + 1] << 8, c1 = u8[p + 2] | u8[p + 3] << 8;
      pal[0] = (c0 >> 11 & 31) * 255 / 31; pal[1] = (c0 >> 5 & 63) * 255 / 63; pal[2] = (c0 & 31) * 255 / 31;
      pal[3] = (c1 >> 11 & 31) * 255 / 31; pal[4] = (c1 >> 5 & 63) * 255 / 63; pal[5] = (c1 & 31) * 255 / 31;
      var four = c0 > c1;
      for (var j = 0; j < 3; j++) { pal[6 + j] = four ? (2 * pal[j] + pal[3 + j]) / 3 : (pal[j] + pal[3 + j]) / 2; pal[9 + j] = four ? (pal[j] + 2 * pal[3 + j]) / 3 : 0; }
      var bits = (u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16 | u8[p + 7] << 24) >>> 0;
      for (var t = 0; t < 16; t++) {
        var ci = (bits >>> (2 * t)) & 3, o = ((by * 4 + (t >> 2)) * W + bx * 4 + (t & 3)) * 4;
        out[o] = pal[ci * 3]; out[o + 1] = pal[ci * 3 + 1]; out[o + 2] = pal[ci * 3 + 2]; out[o + 3] = 255;
      }
    }
    return { rgba: out, W: W, H: L.bh * 4 };
  }
  MB.decodeColour = decodeColour;
  // the game's own DXT5 colour blocks as BC1: crop at block boundaries, rows flipped (south first), BC3 colour half ->
  // BC1 4-colour as dds._bc1_from_bc3_colour; a block outside the level stays zero (black, as ground5's zero padding)
  function passThrough(u8, L, bc0, br0, bw, bh) {
    var out = new Uint8Array(bw * bh * 8);
    for (var j = 0; j < bh; j++) {
      var srow = br0 + bh - 1 - j;
      for (var i = 0; i < bw; i++) {
        if (srow < 0 || srow >= L.bh || bc0 + i < 0 || bc0 + i >= L.bw) continue;
        var p = L.off + ((srow * L.bw) + bc0 + i) * L.bs + (L.bs - 8), o = (j * bw + i) * 8;
        var c0 = u8[p] | u8[p + 1] << 8, c1 = u8[p + 2] | u8[p + 3] << 8;
        var bits = (u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16 | u8[p + 7] << 24) >>> 0;
        bits = ((bits >>> 24) | ((bits >>> 16 & 255) << 8) | ((bits >>> 8 & 255) << 16) | ((bits & 255) << 24)) >>> 0;
        if (c0 < c1) { var t = c0; c0 = c1; c1 = t; bits = (bits ^ 0x55555555) >>> 0; } else if (c0 === c1) bits = 0;
        out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
        out[o + 4] = bits & 255; out[o + 5] = bits >>> 8 & 255; out[o + 6] = bits >>> 16 & 255; out[o + 7] = bits >>> 24;
      }
    }
    return out;
  }
  // quickselect (the median of light5c without a full sort)
  function kth(a, k) {
    var lo = 0, hi = a.length - 1;
    while (hi > lo) {
      var piv = a[(lo + hi) >> 1], i = lo, j = hi;
      while (i <= j) { while (a[i] < piv) i++; while (a[j] > piv) j--; if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
    }
    return a[k];
  }
  function median32(a) {  // np.median of a float32 array: mean of the two middle values in float32
    var c = a.slice(), n = c.length, m = n >> 1, hi = kth(c, m);
    if (n & 1) return hi;
    var lo = -Infinity; for (var i = 0; i < m; i++) if (c[i] > lo) lo = c[i];
    return f(f(lo + hi) / 2);
  }
  MB.median32 = median32;
  function b64ToU8(s) { var bin = atob(s), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u; }
  function f32of(x) { if (typeof x === 'string') { var u = b64ToU8(x); return new Float32Array(u.buffer); } return x; }

  // ---------------------------------------------------------------- stage 1: terrain (build.build_terrain)
  async function terrainChunks(raw) {
    var t0 = now(), names = raw.names().filter(function (n) { return /^chunk\/[0-9a-f]{8}\/heights$/.test(n); }).sort();
    var list = await Promise.all(names.map(async function (n) {
      var xz = n.slice(6, 14), h = await readHeights(raw.get(n), n);
      return { cx: s16(xz.slice(0, 4)), cz: s16(xz.slice(4, 8)), a: h.a, w: h.w, h: h.h };
    }));
    var map = {}; list.forEach(function (c) { map[c.cx * 65536 + c.cz] = c; });
    C.stages.chunksDecoded = list.length;
    return { list: list, map: map, n: list[0].h - 5, ms: now() - t0 };
  }
  function bwt2(sec) {  // spacebin.SpaceBin.bwt2: bbox only (and the chunk table's size checks)
    once('space.bin section', 'BWT2');
    var dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength), p = 0;
    if (dv.getUint32(p, true) !== 32) throw new Error('BWT2 header size'); p += 4 + 32;
    var sz = dv.getUint32(p, true), n = dv.getUint32(p + 4, true); p += 8 + sz * n;
    sz = dv.getUint32(p, true); n = dv.getUint32(p + 4, true); p += 8 + sz * n;
    if (dv.getUint32(p, true) !== 128) throw new Error('BWT2 settings size'); p += 4;
    var q = p + 128 - 16;
    return [dv.getFloat32(q, true), dv.getFloat32(q + 4, true), dv.getFloat32(q + 8, true), dv.getFloat32(q + 12, true)];
  }
  var CELL = 2.0, MARGIN = 60.0;
  function buildTerrain(T, box) {
    var x0 = box[0], z0 = box[1], x1 = box[2], z1 = box[3];
    var nx = Math.ceil((x1 + 1e-6 - x0) / CELL), nz = Math.ceil((z1 + 1e-6 - z0) / CELL), g = new Float64Array(nx * nz), nan = 0, mn = Infinity, mx = -Infinity;
    for (var j = 0; j < nz; j++) for (var i = 0; i < nx; i++) {
      var h = heightAt(T, x0 + i * CELL, z0 + j * CELL);
      if (h == null) { g[j * nx + i] = NaN; nan++; } else { g[j * nx + i] = h; if (h < mn) mn = h; if (h > mx) mx = h; }
    }
    if (nan) for (var k = 0; k < g.length; k++) if (g[k] !== g[k]) g[k] = mn;
    var q = new Uint16Array(nx * nz);
    for (k = 0; k < g.length; k++) q[k] = rhe((g[k] - mn) * 100) & 0xffff;
    return { x0: x0, z0: z0, cell: CELL, nx: nx, nz: nz, hmin: mn, hmax: mx, heights: q };
  }

  // ---------------------------------------------------------------- stage 3: global colour map (ground5.global_map, pass-through)
  function chunkExtent(T) {
    var xs = T.list.map(function (c) { return c.cx; }), zs = T.list.map(function (c) { return c.cz; });
    return [Math.min.apply(null, xs) * 100, Math.min.apply(null, zs) * 100, (Math.max.apply(null, xs) + 1) * 100, (Math.max.apply(null, zs) + 1) * 100];
  }
  function globalMap(raw, man, ext, box, arena) {
    var data = raw.get('global_am.dds'); once('dds', 'global_am.dds');
    var src = man.files.filter(function (e) { return e.name === 'global_am.dds'; })[0];
    var L = ddsLevels(data), n = L[0].w, px = (ext[2] - ext[0]) / n, ez1 = ext[3], ex0 = ext[0];
    // the Python crop (ground5.global_map), then widened to 16-px boundaries so that 3 levels stay whole blocks
    var c0 = Math.floor((box[0] - ex0) / px), c1 = Math.ceil((box[2] - ex0) / px), r0 = Math.floor((ez1 - box[3]) / px), r1 = Math.ceil((ez1 - box[1]) / px);
    var A = 16, ca = Math.floor(c0 / A) * A, ra = Math.floor(r0 / A) * A, W = Math.ceil((c1 - ca) / A) * A, H = Math.ceil((r1 - ra) / A) * A;
    var levels = [];
    for (var l = 0; l < Math.min(3, L.length); l++) {
      var s = 4 << l;
      levels.push({ w: W >> l, h: H >> l, bc1: passThrough(data, L[l], ca / s, ra / s, W / s, H / s) });
    }
    return { glob: { x0: ex0 + ca * px, z0: ez1 - (ra + H) * px, px: px, w: W, h: H, bc1: levels, source: 'spaces/' + arena + '/global_am.dds', sourceSize: src ? src.sourceSize : null,
      level: n, extent: ext.slice(), method: 'pass-through of the DDS colour blocks (no re-encode)', fit: null },
      py: { c0: c0, c1: c1, r0: r0, r1: r1, n: n, px: px }, L: L, data: data };
  }
  // ground5.fit_to_minimap: per-channel gain that brings the mean colour of the global map to the minimap's
  // round 9: only the blocks of the crop are decoded (round 8 decoded the whole 2048 level for it)
  function decodeRegion(u8, L, bx0, by0, bx1, by1) {
    var bw = L.bw, sub = { bw: bx1 - bx0, bh: by1 - by0, bs: L.bs, off: 0 }, tmp = new Uint8Array(sub.bw * sub.bh * L.bs);
    for (var by = by0; by < by1; by++) tmp.set(u8.subarray(L.off + (by * bw + bx0) * L.bs, L.off + (by * bw + bx1) * L.bs), (by - by0) * sub.bw * L.bs);
    return decodeColour(tmp, sub);
  }
  // the per-cell part of ground5.fit_to_minimap that does not depend on the gameplay: for every minimap pixel inside the
  // rim whose own luminance passes, the mean colour of the global map under it (kept per arena: another gameplay only
  // drops the cells its placements block)
  function minimapCells(raw, G, arena) {
    var mmd = raw.get('mmap.dds'); once('dds', 'mmap.dds');
    var ML = ddsLevels(mmd)[0], mm = decodeColour(mmd, ML), n = ML.h;
    var P = G.py, Wc = Math.floor((P.c1 - P.c0 + 15) / 16) * 16, Hc = Math.floor((P.r1 - P.r0 + 15) / 16) * 16;
    var c1 = Math.min(P.n, P.c0 + Wc), r1 = Math.min(P.n, P.r0 + Hc), ch = r1 - P.r0, cw = c1 - P.c0;
    var bx0 = P.c0 >> 2, by0 = P.r0 >> 2, D0 = decodeRegion(G.data, G.L[0], bx0, by0, (c1 + 3) >> 2, (r1 + 3) >> 2), D = { rgba: D0.rgba, W: D0.W };
    var ox = bx0 * 4, oy = by0 * 4;
    var gx0 = G.glob.extent[0] + P.c0 * P.px, gz0 = G.glob.extent[3] - (P.r0 + Hc) * P.px, gpx = P.px;
    var IW = Wc + 1, I = [new Float64Array((Hc + 1) * IW), new Float64Array((Hc + 1) * IW), new Float64Array((Hc + 1) * IW)];
    for (var c = 0; c < 3; c++) {  // integral image of the padded crop / 255 (float32 values, float64 sums: g.cumsum(0).cumsum(1))
      var Ic = I[c], col = new Float64Array(Wc);
      for (var y = 0; y < Hc; y++) {
        for (var x = 0; x < Wc; x++) {  // cumsum(0) then cumsum(1), both in float32 as numpy does for a float32 array
          var v = 0;
          if (y < ch && x < cw) { var sy = P.r0 + ch - 1 - y; v = f(D.rgba[((sy - oy) * D.W + P.c0 + x - ox) * 4 + c] / 255); }
          col[x] = f(col[x] + v);
        }
        var row = 0;
        for (x = 0; x < Wc; x++) { row = f(row + col[x]); Ic[(y + 1) * IW + x + 1] = row; }
      }
    }
    var ax0 = arena[0], az1 = arena[3], mpx = (arena[2] - arena[0]) / n, rim = Math.trunc(0.05 * n), cells = [], idx = [];
    function sum(Ic, ra, rb, ca, cb) { return Ic[rb * IW + cb] - Ic[ra * IW + cb] - Ic[rb * IW + ca] + Ic[ra * IW + ca]; }
    for (var j = rim; j < n - rim; j++) {
      var zhi = az1 - j * mpx, zlo = zhi - mpx, ra = rhe((zlo - gz0) / gpx), rb = rhe((zhi - gz0) / gpx);
      for (var i = rim; i < n - rim; i++) {
        var ca = rhe((ax0 + i * mpx - gx0) / gpx), cb = rhe((ax0 + (i + 1) * mpx - gx0) / gpx), den = Math.max(1, (rb - ra) * (cb - ca));
        var o = (j * mm.W + i) * 4, Y0 = f(mm.rgba[o] / 255), Y1 = f(mm.rgba[o + 1] / 255), Y2 = f(mm.rgba[o + 2] / 255);
        if (Y0 * 0.299 + Y1 * 0.587 + Y2 * 0.114 <= 0.2) continue;
        idx.push(j * n + i); cells.push(sum(I[0], ra, rb, ca, cb) / den, sum(I[1], ra, rb, ca, cb) / den, sum(I[2], ra, rb, ca, cb) / den, Y0, Y1, Y2);
      }
    }
    return { n: n, idx: Int32Array.from(idx), cells: Float64Array.from(cells) };
  }
  // the gameplay part: cells under objects, plants and water are dropped, then per channel gain = mean minimap / mean map
  function minimapFit(MC, arena, pts, water) {
    var n = MC.n, ax0 = arena[0], az1 = arena[3], mpx = (arena[2] - arena[0]) / n, blocked = new Uint8Array(n * n);
    pts.forEach(function (p) {
      var i = Math.trunc((p[0] - ax0) / mpx), j = Math.trunc((az1 - p[1]) / mpx), k = Math.trunc(p[2] / mpx) + 1;
      for (var jj = Math.max(0, j - k); jj < Math.min(n, Math.max(0, j + k + 1)); jj++) for (var ii = Math.max(0, i - k); ii < Math.min(n, Math.max(0, i + k + 1)); ii++) blocked[jj * n + ii] = 1;
    });
    water.forEach(function (w) {
      var i0 = Math.trunc((w.x0 - ax0) / mpx), i1 = Math.trunc((w.x1 - ax0) / mpx), j0 = Math.trunc((az1 - w.z1) / mpx), j1 = Math.trunc((az1 - w.z0) / mpx);
      for (var jj = Math.max(0, j0); jj < Math.min(n, Math.max(0, j1 + 1)); jj++) for (var ii = Math.max(0, i0); ii < Math.min(n, Math.max(0, i1 + 1)); ii++) blocked[jj * n + ii] = 1;
    });
    var sx = [0, 0, 0], sy2 = [0, 0, 0], cnt = 0, C6 = MC.cells, c;
    for (var q = 0; q < MC.idx.length; q++) {
      if (blocked[MC.idx[q]]) continue;
      for (c = 0; c < 3; c++) { sx[c] += C6[q * 6 + c]; sy2[c] += C6[q * 6 + 3 + c]; }
      cnt++;
    }
    var M = [];
    for (c = 0; c < 12; c++) M.push(0);
    for (c = 0; c < 3; c++) M[c * 3 + c] = Math.round(sy2[c] / cnt / Math.max(1e-6, sx[c] / cnt) * 1e5) / 1e5;
    return { fit: M, pixels: cnt };
  }

  // ---------------------------------------------------------------- stage 4: water, sun, mode (build.build_water, build_sun, build_mode)
  function water(raw, box) {
    var s = raw.get('space.bin/BWWa'); once('space.bin section', 'BWWa');
    var dv = new DataView(s.buffer, s.byteOffset, s.byteLength), size = dv.getUint32(0, true), count = dv.getUint32(4, true), out = [];
    for (var i = 0; i < count; i++) {
      var p = 8 + i * size, F = [0, 1, 2, 3, 4, 5].map(function (k) { return dv.getFloat32(p + 4 * k, true); });
      out.push({ x0: F[0], z0: F[2], x1: F[3], z1: F[5], y: F[1] });
    }
    return out.map(function (w) { return { x0: Math.max(w.x0, box[0]), z0: Math.max(w.z0, box[1]), x1: Math.min(w.x1, box[2]), z1: Math.min(w.z1, box[3]), y: w.y }; })
      .filter(function (w) { return w.x1 > w.x0 && w.z1 > w.z0; });
  }
  function sun(raw) {
    var env = MB.packedXml(raw.get('environments.xml'), 'environments.xml');
    var guid = env.findtext('activeEnvironment').trim().replace(/\./g, '-');
    var e = MB.packedXml(raw.get('environment.xml'), 'environment.xml'), dn = e.find('day_night_cycle');
    var fl = function (path) { return floats(dn.findtext(path) || '0'); };
    return { source: 'environments/' + guid + '/environment.xml day_night_cycle', angle: fl('deferred/angle')[0], angleZ: fl('deferred/angleZ')[0],
      forwardAngle: fl('forward/angle')[0], forwardAngleZ: fl('forward/angleZ')[0], startTime: fl('starttime')[0], color: fl('sunLightColor'), ambientTint: fl('ambientTint') };
  }
  var GAMEPLAY_BIT = { ctf: 0, domination: 1, comp7: 2, assault2: 6, maps_training: 16 };
  function visibilityBit(raw, gameplay) {  // build.visibility_bit
    if (raw.has('space.settings')) {
      var root = MB.packedXml(raw.get('space.settings'), 'space.settings'), ts = root.findall('spaceVisibilityFlags/type');
      for (var i = 0; i < ts.length; i++) if ((ts[i].findtext('tag') || '').trim() === gameplay) return { bit: parseInt(ts[i].findtext('bitIndex'), 10), source: 'space.settings spaceVisibilityFlags' };
    }
    if (gameplay in GAMEPLAY_BIT) return { bit: GAMEPLAY_BIT[gameplay], source: 'default: the Prokhorovka table (this space has no table)' };
    throw new Error('gameplay ' + gameplay + ': no visibility bit known');
  }
  // 19.11: the base / control point circles of the gameplay (build.wtcp_circles): the space's WTCP section, one 124-byte
  // record per point - translation f32 at 48/52/56, radius f32 at 64 (m), team u32 at 68 (0 = a neutral control point),
  // base number u32 at 72, visibility mask u32 at the record's end (bit = gameplay); no section or no record -> []
  function circles(raw, bit) {
    if (!raw.has('space.bin/WTCP')) return [];
    var s = raw.get('space.bin/WTCP'); once('space.bin section', 'WTCP');
    if (s.length < 8) return [];
    var dv = new DataView(s.buffer, s.byteOffset, s.byteLength), size = dv.getUint32(0, true), count = dv.getUint32(4, true), out = [];
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };
    for (var i = 0; i < count; i++) {
      var p = 8 + i * size;
      if (!((dv.getUint32(p + size - 4, true) >>> bit) & 1)) continue;
      out.push({ team: dv.getUint32(p + 68, true), num: dv.getUint32(p + 72, true), x: r3(dv.getFloat32(p + 48, true)),
        y: r3(dv.getFloat32(p + 52, true)), z: r3(dv.getFloat32(p + 56, true)), radius: r3(dv.getFloat32(p + 64, true)) });
    }
    return out;
  }
  // round 9: the heights of every arena_defs point of every gameplay, kept in the arena record, so that another
  // gameplay of the arena needs no terrain chunk (round 8 decoded the 196 chunks again only for these)
  function modeHeights(root, T) {
    var out = {}, gts = root.find('gameplayTypes');
    (gts ? gts.kids : []).forEach(function (gt) {
      gt.kids.forEach(function (sec) {
        var pts = sec.tag === 'controlPoint' ? [sec] : (sec.tag === 'teamBasePositions' || sec.tag === 'teamSpawnPoints') ? [].concat.apply([], sec.kids.map(function (t) { return t.kids; })) : [];
        pts.forEach(function (p) { if (p.text == null) return; var a = floats(p.text), h = heightAt(T, a[0], a[1]); out[a[0] + ',' + a[1]] = h != null ? h : 0.0; });
      });
    });
    return out;
  }
  function mode(raw, heights, gameplay, bit, arena, root) {
    var gt = root.find('gameplayTypes/' + gameplay);
    var out = { gameplay: gameplay, bases: [], spawns: [], controlPoint: null, source: {} };
    var xz = function (t) { var a = floats(t); return [a[0], a[1]]; };
    var y = function (x, z) { var h = heights[x + ',' + z]; if (h === undefined) throw new Error('mode height not kept: ' + x + ',' + z); return h; };
    if (gt) {
      var tb = gt.find('teamBasePositions');
      if (tb) {
        tb.kids.forEach(function (team) { team.kids.forEach(function (p) { var q = xz(p.text); out.bases.push({ team: parseInt(team.tag.replace('team', ''), 10), x: q[0], z: q[1], y: y(q[0], q[1]), name: p.tag }); }); });
        out.source.bases = 'arena_defs teamBasePositions';
      }
      var cp = gt.findtext('controlPoint');
      if (cp) { var q = xz(cp); out.controlPoint = { x: q[0], z: q[1], y: y(q[0], q[1]) }; out.source.controlPoint = 'arena_defs controlPoint'; }
      var ts = gt.find('teamSpawnPoints');
      if (ts) {
        ts.kids.forEach(function (team) { team.kids.forEach(function (p) { var q = xz(p.text); out.spawns.push({ team: parseInt(team.tag.replace('team', ''), 10), x: q[0], z: q[1], y: y(q[0], q[1]), kind: 'arena_defs' }); }); });
        out.source.spawns = 'arena_defs teamSpawnPoints';
      }
    }
    var s = raw.get('space.bin/UDOS'), at = -1;
    for (var i = 0; i + 4 <= s.length; i++) if (s[i] === 0x45 && s[i + 1] === 0x4e && s[i + 2] === 0xa1 && s[i + 3] === 0x62) { at = i; break; }
    once('space.bin section', 'UDOS');
    var udos = MB.packedXml(s.subarray(at), 'space.bin/UDOS'), n = 0;
    udos.kids.forEach(function (u) {
      if (u.findtext('type') !== 'SpawnPoint') return;
      var mask = parseInt(u.findtext('visibilityMask') || 0, 10);
      if (!(Math.floor(mask / Math.pow(2, bit)) & 1)) return;
      var t = floats(u.findtext('transform')), props = u.find('properties');
      var team = props && props.findtext('team') ? parseInt(props.findtext('team'), 10) : 0;
      out.spawns.push({ team: team, x: t[9], z: t[11], y: t[10], kind: 'udo', yaw: Math.atan2(t[6], t[8]) }); n++;
    });
    if (n) out.source.spawnPlaces = 'space.bin UDOS SpawnPoint, visibility bit ' + bit;
    out.circles = circles(raw, bit);
    out.source.circles = out.circles.length ? 'space.bin WTCP, visibility bit ' + bit : 'none: the space has no WTCP record for this gameplay (centre flags only)';
    return out;
  }

  // ---------------------------------------------------------------- stage 2: light map (light5c.features + build5c)
  var PX = 0.5;
  var HAND = { relief3: 0.10, relief10: 0.05, relief30: 0.015, plants1: -0.22, plants4: -0.22, objects1: -0.25, objects4: -0.25 };
  var BAKED = ['relief3', 'relief10', 'relief30', 'plants1', 'plants4', 'objects1', 'objects4'];
  function lightGrid(box) {
    var W = rhe((box[2] - box[0]) / PX), H = rhe((box[3] - box[1]) / PX), xs = new Float64Array(W), zs = new Float64Array(H), i;
    for (i = 0; i < W; i++) xs[i] = box[0] + (i + 0.5) * PX;
    for (i = 0; i < H; i++) zs[i] = box[1] + (i + 0.5) * PX;
    return { W: W, H: H, xs: xs, zs: zs, x0: box[0], z0: box[1] };
  }
  // the relief part of logL (float32 as numpy sums float32 terms): w3 * r3 + w10 * r10 + w30 * r30, r = h - blur(h)
  function relief(T, LG, times) {
    var t = now(), HT = mosaic(T, 64), h = sample(HT, HT.x0, HT.z0, HT.px, LG.xs, LG.zs), N = LG.W * LG.H, sum = new Float32Array(N), tmp = new Float32Array(N);
    times.heightSamples = now() - t; t = now();
    [[3, 'relief3'], [10, 'relief10'], [30, 'relief30']].forEach(function (r, ri) {
      var b = blur(h, LG.W, LG.H, r[0] / PX, tmp), w = f(HAND[r[1]]);  // numpy: a Python float times a float32 array is float32
      for (var k = 0; k < N; k++) { var term = f(h[k] - b[k]), wt = f(w * term); sum[k] = ri === 0 ? f(0 + wt) : f(sum[k] + wt); }
    });
    times.reliefBlurs = now() - t;
    return sum;
  }
  var RECT = ['bld', 'fence', 'gaf', 'rw', 'board', 'bench', 'wall', 'shed', 'house', 'barn', 'table', 'toilet', 'truck', 'machine', 'carriage', 'telega'];
  var SKIP = ['dec_', 'railwaysection', 'sleepers', 'passage', 'pole', 'washingline'];
  // light5c.masks: plant crowns as discs, object boxes as rectangles / ellipses, coverage 0..1 on the 0.5 m grid
  function masks(P, LG) {
    var W = LG.W, H = LG.H, x0 = LG.x0, z0 = LG.z0, plants = new Float32Array(W * H), objs = new Float32Array(W * H), used = 0;
    var kinds = P.kinds;
    P.groups.forEach(function (g) {
      var crown = kinds[g.kind], a = f32of(g.m), n = a.length / 12, rk = Math.max(0.4, crown * 0.85);
      for (var q = 0; q < n; q++) {
        var o = q * 12, sc = f(Math.sqrt(f(f(f(a[o] * a[o]) + f(a[o + 1] * a[o + 1])) + f(a[o + 2] * a[o + 2])))), rr = rk * sc, x = a[o + 9], z = a[o + 11];
        var i0 = Math.trunc((x - rr - x0) / PX), i1 = Math.trunc((x + rr - x0) / PX) + 1, j0 = Math.trunc((z - rr - z0) / PX), j1 = Math.trunc((z + rr - z0) / PX) + 1;
        i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(W, i1); j1 = Math.min(H, j1);
        if (i0 >= i1 || j0 >= j1) continue;
        for (var j = j0; j < j1; j++) {
          var Z = z0 + (j + 0.5) * PX, dz = (Z - z) * (Z - z);
          for (var i = i0; i < i1; i++) {
            var X = x0 + (i + 0.5) * PX, d2 = (X - x) * (X - x) + dz, v = Math.min(Math.max((rr - Math.sqrt(d2)) / PX + 0.5, 0), 1), k = j * W + i;
            if (v > plants[k]) plants[k] = v;
          }
        }
      }
    });
    (P.visual || []).forEach(function (rec) {
      var nm = rec.name.toLowerCase();
      if (SKIP.some(function (s) { return nm.indexOf(s) >= 0; }) || rec.prange[1] < 0.6) return;
      var rect = RECT.some(function (s) { return nm.indexOf(s) >= 0; });
      var lo = rec.pmin, hi = [lo[0] + rec.prange[0], lo[1] + rec.prange[1], lo[2] + rec.prange[2]], a = f32of(rec.m), n = a.length / 12;
      var c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], hx = (hi[0] - lo[0]) / 2, hz = (hi[2] - lo[2]) / 2;
      for (var q = 0; q < n; q++) {
        var o = q * 12;
        // ctr = t + c @ R (R rows: the local x, y, z axes in world coordinates)
        var cx = a[o + 9] + (c[0] * a[o] + c[1] * a[o + 3] + c[2] * a[o + 6]), cz = a[o + 11] + (c[0] * a[o + 2] + c[1] * a[o + 5] + c[2] * a[o + 8]);
        var ax0 = a[o], ax1 = a[o + 2], az0 = a[o + 6], az1 = a[o + 8];
        var e0 = Math.abs(ax0) * hx + Math.abs(az0) * hz, e1 = Math.abs(ax1) * hx + Math.abs(az1) * hz;
        var i0 = Math.max(0, Math.trunc((cx - e0 - x0) / PX)), i1 = Math.min(W, Math.trunc((cx + e0 - x0) / PX) + 2);
        var j0 = Math.max(0, Math.trunc((cz - e1 - z0) / PX)), j1 = Math.min(H, Math.trunc((cz + e1 - z0) / PX) + 2);
        if (i0 >= i1 || j0 >= j1) continue;
        var sx = f(Math.sqrt(f(f(ax0 * ax0) + f(ax1 * ax1)))) || 1, sz = f(Math.sqrt(f(f(az0 * az0) + f(az1 * az1)))) || 1, sx2 = f(sx * sx), sz2 = f(sz * sz);
        var mhx = Math.max(hx, 0.05), mhz = Math.max(hz, 0.05), mm = Math.min(hx * sx, hz * sz);
        for (var j = j0; j < j1; j++) {
          var Z = z0 + (j + 0.5) * PX - cz;
          for (var i = i0; i < i1; i++) {
            var X = x0 + (i + 0.5) * PX - cx, u = (X * ax0 + Z * ax1) / sx2, v = (X * az0 + Z * az1) / sz2, cov;
            if (rect) cov = Math.min(Math.max((hx - Math.abs(u)) * sx / PX + 0.5, 0), 1) * Math.min(Math.max((hz - Math.abs(v)) * sz / PX + 0.5, 0), 1);
            else { var qq = Math.sqrt((u / mhx) * (u / mhx) + (v / mhz) * (v / mhz)); cov = Math.min(Math.max((1 - qq) * mm / PX + 0.5, 0), 1); }
            var k = j * W + i; if (cov > objs[k]) objs[k] = cov;
          }
        }
        used++;
      }
    });
    return { plants: plants, objs: objs, used: used };
  }
  MB.masks = masks;
  // light5c.build5c: logL = sum of the weighted terms (float32), minus its median, exp, value = light / 2 in 8 bits
  function combine(reliefSum, M, LG, times, keepLogL) {
    var t = now(), N = LG.W * LG.H, logL = reliefSum.slice(), tmp = new Float32Array(N);
    [['plants', M.plants], ['objects', M.objs]].forEach(function (m) {
      [[1, m[0] + '1'], [4, m[0] + '4']].forEach(function (r) {
        var b = blur(m[1], LG.W, LG.H, r[0] / PX, tmp), w = f(HAND[r[1]]);
        for (var k = 0; k < N; k++) logL[k] = f(logL[k] + f(w * b[k]));
      });
    });
    times.maskBlurs = now() - t; t = now();
    var keep = keepLogL ? logL.slice() : null;
    var qz = quantise(logL);
    times.combine = now() - t;
    return { r8: qz.r8, median: qz.median, logL: keep };
  }
  function quantise(logL) {
    var N = logL.length, med = median32(logL), r8 = new Uint8Array(N);
    for (var k = 0; k < N; k++) { var light = f(Math.exp(f(logL[k] - med))), v = rhe(f(f(light / 2) * 255)); r8[k] = v < 0 ? 0 : v > 255 ? 255 : v; }
    return { r8: r8, median: med };
  }
  MB.quantise = quantise;

  // ---------------------------------------------------------------- the build
  // opts: { gameplay, minimapFit: bool, cache: {get(key), put(key, value)} (per-resource products),
  //         have: {arena: record|null, relief: Float32Array|null, fit: cells|null}, keepLogL }
  // Round 9: the objects, plants and lookup are built here too (mapbuild9.js); the light map's footprints and the
  // minimap white balance read their placements from them.
  MB.build = async function (raw, opts) {
    var man = raw.manifest, arena = man.arena, times = {}, t0 = now(), t;
    var have = opts.have || {};
    var out = { arena: have.arena || null, relief: null, fit: null, map: null, times: times };
    t = now();
    var sec = raw.get('space.bin/BWT2'), bb = bwt2(sec), box = [bb[0] - MARGIN, bb[1] - MARGIN, bb[2] + MARGIN, bb[3] + MARGIN];
    var A = out.arena, G = null, T = null, root = MB.packedXml(raw.get('arena_defs.xml'), 'arena_defs.xml');
    if (!A || !have.relief) { T = await terrainChunks(raw); times.terrainDecode = now() - t; }   // a second gameplay needs no chunk
    if (!A) {
      t = now(); var terrain = buildTerrain(T, box); times.terrainGrid = now() - t;
      t = now(); G = globalMap(raw, man, chunkExtent(T), box, arena); times.globalMap = now() - t;
      t = now();
      A = out.arena = { arena: arena, arenaBox: bb, box: box, terrain: terrain, glob: G.glob, water: water(raw, box), sun: sun(raw), modeHeights: modeHeights(root, T), version: MB.VERSION };
      times.waterSun = now() - t;
    }
    var LG = lightGrid(box), reliefSum = have.relief;
    if (!reliefSum) { reliefSum = out.relief = relief(T, LG, times); }
    t = now();
    var vb = visibilityBit(raw, opts.gameplay), md = mode(raw, A.modeHeights, opts.gameplay, vb.bit, arena, root);
    times.mode = now() - t;
    var O = MB.buildObjects(raw, opts, box, bb, vb.bit, times), PL = O.placements;
    var mapRec = { arena: arena, gameplay: opts.gameplay, visibilityBit: vb.bit, visibilityBitSource: vb.source, mode: md, version: MB.VERSION,
      objects: O.objects, visual: O.visual, atlas: O.atlas, visualStats: O.visualStats, trees: O.trees, lookup: O.lookup };
    t = now(); var M = masks(PL, LG); times.masks = now() - t;
    var cb = combine(reliefSum, M, LG, times, opts.keepLogL);
    mapRec.light = { x0: LG.x0, z0: LG.z0, px: PX, w: LG.W, h: LG.H, r8: cb.r8, encoding: 'value / 255 * 2 = light (1 = flat open ground)', terms: BAKED, weights: HAND,
      median: cb.median, objectsUsed: M.used, source: 'terrain2/heights (1.5625 m), plant and object placements, all built from the raw set', blur: '3 box passes per axis (light5c: FFT Gaussian)' };
    if (opts.keepLogL) out.debug = { logL: cb.logL, plants: M.plants, objs: M.objs };
    if (opts.minimapFit && raw.has('mmap.dds')) {
      t = now();
      var MC = have.fit;
      if (!MC) { if (!G) G = globalMap(raw, man, A.glob.extent, box, arena); MC = out.fit = minimapCells(raw, G, bb); }
      var pts = [];
      PL.visual.forEach(function (rec) { var a = rec.m; for (var q = 0; q < a.length; q += 12) pts.push([a[q + 9], a[q + 11], 8.0]); });
      PL.groups.forEach(function (g) { var a = g.m; for (var q = 0; q < a.length; q += 12) pts.push([a[q + 9], a[q + 11], 4.0]); });
      var fit = minimapFit(MC, bb, pts, A.water);
      mapRec.globFit = fit.fit; mapRec.globFitPixels = fit.pixels; times.minimapFit = now() - t;
    }
    out.map = mapRec; out.kindKeys = O.kindKeys;
    times.total = now() - t0;
    return out;
  };
  G.MapBuild = MB;
})(typeof globalThis !== 'undefined' ? globalThis : this);
