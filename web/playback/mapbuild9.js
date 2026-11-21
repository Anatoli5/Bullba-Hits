/* Bullba Hits' 3D replay player (BACKLOG 104), copied from the trial (work/map-playback/mapbuild9.js; the raw
   files now from the mod's map_raw.py); 19.11: plus the rocks (Rocks, the trial's objects_visual.py round 11). Round 9: the rest of the JS map builder - the map stands
   alone on the raw files the copy step wrote (rawcopy.py), with no prebuilt data/<map>.map.js.
   Loaded after mapbuild.js (worker and node). Stages, each named after the Python step it mirrors:
     space.bin  BWST strings, BSMI instances, BSMO models, SpTr plants, WGDE destructibles (spacebin.SpaceBin)
     statics    physical objects and their collision records (build.build_statics; havok: bodies, flags, triangle
                counts only - the collision meshes themselves are a comparison mode, not built here)
     visual     visual models: LOD chain, LOD by budget, BC1 atlas of the game's own blocks (objects_visual.build)
     plants     plant kinds (lowest 3D LOD, textures, hull, crown) and their placements (build.build_trees, plant_kind)
     lookup     the destruction lookup: WGDE member -> object record / plant group (build.build_map's lookup)
   Every parsed resource (a plant kind, a visual LOD, a texture, a havok file, destructibles.xml ...) is a product of
   its own keyed by resource path + zip CRC (opts.cache): built once, then found again by every map that uses it. */
(function (G) {
  'use strict';
  var MB = G.MapBuild, f = Math.fround, C = MB.counts;
  MB.VERSION = 'r9.3';   // r9.2 (19.11): the rock shader's data (atlas.rocks, rec.rock); r9.3 (21.11): the map's scenarios (lookup.scenario)
  var RESV = 'p2';   // version of the per-resource products (p2: a LOD's numeric material properties and uv2)
  MB.RESV = RESV;   // the page names it with its digest of the products it holds (mapbuild-page.js heldDigest)
  var now = (typeof performance !== 'undefined') ? function () { return performance.now(); } : Date.now;
  var reset0 = MB.resetCounts;
  MB.resetCounts = function () { reset0(); C.cacheHit = {}; C.cacheBuilt = {}; C.resLoaded = 0; };
  MB.resetCounts();
  function once(kind, name) { var m = C.parsed[kind] || (C.parsed[kind] = {}); m[name] = (m[name] || 0) + 1; }
  function dvOf(u) { return new DataView(u.buffer, u.byteOffset, u.byteLength); }
  var td = new TextDecoder('utf-8'), latin = function (u) { var s = ''; for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; };
  // Python's round(x, d): the correctly rounded decimal, ties (x = odd / 2^(d+1) exactly) to even
  function pyRound(x, d) {
    if (!isFinite(x)) return x;
    var t = x * Math.pow(2, d + 1);
    if (Number.isInteger(t) && Math.abs(t % 2) === 1) { var s = x * Math.pow(10, d), lo = Math.floor(s); return (lo % 2 === 0 ? lo : lo + 1) / Math.pow(10, d); }
    return Number(x.toFixed(d));
  }
  MB.pyRound = pyRound;
  function rhe(x) { var r = Math.round(x); if (r - x === 0.5 && r % 2) r -= 1; return r; }  // np.round: half to even
  // np.percentile(a float32, q) (linear): lerp in float32 with the weak Python float weight, as numpy 2 does
  function pct32(a, q) {
    var s = Float32Array.from(a).sort(), n = s.length, v = (n - 1) * (q / 100), i0 = Math.floor(v), i1 = Math.min(i0 + 1, n - 1), g = v - i0;
    var A = s[Math.max(0, Math.min(i0, n - 1))], B = s[i1], d = f(B - A);
    return g >= 0.5 ? f(B - f(d * f(1 - g))) : f(A + f(d * f(g)));
  }

  // ---------------------------------------------------------------- raw resources: loaded on first use
  MB.Raw.prototype.resIndex = function () {
    if (!this._res) { var m = {}; (this.manifest.res || []).forEach(function (e) { m[e.path] = e; }); this._res = m; }
    return this._res;
  };
  MB.Raw.prototype.resEntry = function (path) { return path ? this.resIndex()[path.toLowerCase()] || null : null; };
  // 19.11: the resources live in the arena's part scripts (e.name, e.part); one the page said it holds (its products in
  // IndexedDB) is listed `held` and not copied - needing its bytes after all is MB.HeldMissing (the page asks for the map
  // again, holding nothing back)
  MB.Raw.prototype.res = function (path) {
    var e = this.resEntry(path); if (!e) return null;
    var name = e.name || 'res:' + e.path;
    if (!this.has(name)) {
      if (e.held) { var err = new Error('the map needs ' + e.path + ', held back as built before'); err.heldMissing = true; throw err; }
      this.loadRes(e); C.resLoaded++;
    }
    var u = this.get(name);
    // a LOD the builder only counts (map_raw.lod_info): the ranges it reads, laid into a zeroed buffer of the file's size
    if (e.sparse && u && u.length !== e.sourceSize) {
      var full = new Uint8Array(e.sourceSize), q = 0;
      e.sparse.forEach(function (r) { full.set(u.subarray(q, q + r[1]), r[0]); q += r[1]; });
      this.bytes[name] = u = full;
    }
    return u;
  };
  MB.needWhole = function (path) { var err = new Error('the map needs the whole ' + path + ', copied in part'); err.heldMissing = true; return err; };

  // ---------------------------------------------------------------- products keyed by resource path + CRC
  function Products(raw, cache) { this.raw = raw; this.cache = cache || { get: function () {}, put: function () {} }; this.memo = new Map(); }
  Products.prototype.key = function (type, path, extra) {
    var e = this.raw.resEntry(path); if (!e) return null;
    return type + '|' + e.path + '|' + e.crc + (extra != null ? '|' + extra : '') + '|' + RESV;
  };
  Products.prototype.get = function (type, path, extra, make) {
    var k = this.key(type, path, extra); if (!k) return null;
    if (this.memo.has(k)) return this.memo.get(k);
    var v = this.getOnce(type, k, path, make); this.memo.set(k, v); return v;
  };
  Products.prototype.getOnce = function (type, k, path, make) {
    var v = this.cache.get(k);
    if (v !== undefined) { C.cacheHit[type] = (C.cacheHit[type] || 0) + 1; return v; }
    v = make(this.raw.res(path));
    if (v === undefined) v = null;
    this.cache.put(k, v); C.cacheBuilt[type] = (C.cacheBuilt[type] || 0) + 1;
    return v;
  };
  // every product key a manifest can need (the worker reads them from IndexedDB in one transaction before the build)
  MB.productKeys = function (man) {
    var out = [], byPath = {};
    (man.res || []).forEach(function (e) { byPath[e.path] = e; });
    function k(type, e, extra) { out.push(type + '|' + e.path + '|' + e.crc + (extra != null ? '|' + extra : '') + '|' + RESV); }
    (man.res || []).forEach(function (e) {
      var p = e.path;
      if (/\.model$/.test(p)) k('mdl', e);
      else if (/\.visual_processed$/.test(p)) { var pr = byPath[p.replace(/\.visual_processed$/, '.primitives_processed')]; if (pr) { k('lod', e, pr.crc); k('geo', e, pr.crc); } }
      else if (/\.atlas_processed$/.test(p)) k('atl', e);
      else if (/\.dds$/.test(p)) { k('tex', e); k('ptex', e, 128); k('ptex', e, 64); }
      else if (/\.havok$/.test(p)) k('hav', e);
      else if (/\.srt$/.test(p)) k('kind', e);
      else if (/destructibles\.xml$/.test(p)) k('destr', e);
      else if (/bushes\.xml$/.test(p)) k('bush', e);
    });
    return out;
  };

  // ---------------------------------------------------------------- space.bin sections (spacebin.SpaceBin)
  function vec(dv, p) { var size = dv.getUint32(p, true), count = dv.getUint32(p + 4, true); return { size: size, count: count, at: p + 8, end: p + 8 + size * count }; }
  function strings(sec) {
    once('space.bin section', 'BWST');
    var dv = dvOf(sec), v = vec(dv, 0), base = v.end + 4, out = new Map();
    for (var i = 0; i < v.count; i++) {
      var q = v.at + i * v.size, h = dv.getUint32(q, true), off = dv.getUint32(q + 4, true), ln = dv.getUint32(q + 8, true);
      out.set(h, td.decode(sec.subarray(base + off, base + off + ln)));
    }
    return out;
  }
  function bsmi(sec) {
    once('space.bin section', 'BSMI');
    var dv = dvOf(sec), a = vec(dv, 0), b = vec(dv, a.end), c = vec(dv, b.end), d = vec(dv, c.end), n = a.count;
    var t = new Float32Array(n * 16), vis = new Uint32Array(n), model = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < 16; k++) t[i * 16 + k] = dv.getFloat32(a.at + i * a.size + 4 * k, true);
      vis[i] = dv.getUint32(c.at + i * c.size, true); model[i] = dv.getUint32(d.at + i * d.size, true);
    }
    return { n: n, t: t, vis: vis, model: model };
  }
  function bsmo(sec) {
    once('space.bin section', 'BSMO');
    var dv = dvOf(sec), p = vec(dv, 0).end; p = vec(dv, p).end;
    var b = vec(dv, p); p = b.end;
    for (var i = 0; i < 12; i++) p = vec(dv, p).end;
    var c = vec(dv, p), prim = new Uint32Array(b.count), hav = new Uint32Array(b.count);
    for (i = 0; i < b.count; i++) { prim[i] = dv.getUint32(b.at + i * b.size + 24, true); hav[i] = dv.getUint32(c.at + i * c.size, true); }
    return { prim: prim, havok: hav };
  }
  function sptr(sec) {
    once('space.bin section', 'SpTr');
    var dv = dvOf(sec), v = vec(dv, 0), n = v.count, m = new Float32Array(n * 16), res = new Uint32Array(n), mask = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var q = v.at + i * v.size;
      for (var k = 0; k < 16; k++) m[i * 16 + k] = dv.getFloat32(q + 4 * k, true);
      res[i] = dv.getUint32(q + 64, true); mask[i] = dv.getUint32(q + 76, true);
    }
    return { n: n, m: m, res: res, mask: mask };
  }
  function wgde(sec) {
    once('space.bin section', 'WGDE');
    var dv = dvOf(sec), a = vec(dv, 0), b = vec(dv, a.end), c = vec(dv, b.end), i;
    var chunks = new Uint32Array(a.count * 3), ranges = new Uint32Array(b.count * 2), inst = new Uint32Array(c.count);
    for (i = 0; i < a.count; i++) for (var k = 0; k < 3; k++) chunks[i * 3 + k] = dv.getUint32(a.at + i * a.size + 4 * k, true);
    for (i = 0; i < b.count; i++) { ranges[i * 2] = dv.getUint32(b.at + i * b.size, true); ranges[i * 2 + 1] = dv.getUint32(b.at + i * b.size + 4, true); }
    for (i = 0; i < c.count; i++) inst[i] = dv.getUint32(c.at + i * c.size, true);
    return { chunks: chunks, ranges: ranges, inst: inst };
  }
  // 21.11: the map's scenarios (the game's random events; map_raw.space_scenarios -> scenario.json): their standing and
  // ruin models become more BSMI rows - one input for every object -, each with its part, state and the replay's name
  // of its state entity. A ruin model is kept apart from the same model placed as an ordinary object (its own records:
  // drawn only once its whole-object bit is set, the code MOD_WHOLE_REMAINS on every vertex).
  function scenarioRows(raw, S) {
    if (!raw.has('scenario.json')) return;
    once('raw file', 'scenario.json');
    var sc = JSON.parse(td.decode(raw.get('scenario.json'))), list = sc.instances || [];
    if (!list.length) return;
    var I = S.bsmi, M = S.bsmo, n0 = I.n, m0 = M.prim.length, n = n0 + list.length;
    var t = new Float32Array(n * 16), vis = new Uint32Array(n), model = new Uint32Array(n), prim = new Uint32Array(m0 + list.length), hav = new Uint32Array(m0 + list.length);
    t.set(I.t); vis.set(I.vis); model.set(I.model); prim.set(M.prim); hav.set(M.havok);
    var byPath = new Map(), next = 1;
    function hashOf(path) {
      if (byPath.has(path)) return byPath.get(path);
      while (S.st.has(next)) next++;
      S.st.set(next, path); byPath.set(path, next); return next++;
    }
    list.forEach(function (it, j) {
      t.set(it.m, (n0 + j) * 16); vis[n0 + j] = it.mask >>> 0; model[n0 + j] = m0 + j;
      prim[m0 + j] = hashOf(it.prim); hav[m0 + j] = it.havok ? hashOf(it.havok) : 0;
    });
    S.bsmi = { n: n, t: t, vis: vis, model: model }; S.bsmo = { prim: prim, havok: hav };
    S.scen = { n0: n0, list: list };
  }
  function ruinRow(S, n) { return !!(S.scen && n >= S.scen.n0 && S.scen.list[n - S.scen.n0].state === 'ruin'); }
  // the parts of the scenarios for MB.destruction: per part the replay's names of its standing / ruin state entities and
  // the addresses to switch - [code, record, instance] with code 1 a collision record (its linked visual follows) and 2 a
  // visual record -, and the floor objects: the ordinary '*_scenario' objects standing inside the part's standing box
  // (they rest on its floors; the game breaks them with the destruction record when the part falls)
  function scenarioLookup(S, objs, col, vis) {
    if (!S.scen) return [];
    var keyOf = new Map(), parts = new Map(), out = [];
    objs.forEach(function (o, key) { o.bsmi.forEach(function (n) { keyOf.set(n, key); }); });
    S.scen.list.forEach(function (it, j) {
      var n = S.scen.n0 + j, key = keyOf.get(n); if (key === undefined) return;   // not in this gameplay or outside the box
      var p = parts.get(it.part);
      if (!p) { p = { part: it.part, normalNames: [], ruinNames: [], normal: [], ruin: [], floor: [], box: [Infinity, Infinity, -Infinity, -Infinity] }; parts.set(it.part, p); }
      var names = it.state === 'ruin' ? p.ruinNames : p.normalNames; if (names.indexOf(it.name) < 0) names.push(it.name);
      var c = col.bsmiObj.get(n), v = vis.index.get(key), to = it.state === 'ruin' ? p.ruin : p.normal;
      if (c) to.push(1, c[0], c[1]);
      if (v) {
        to.push(2, v[0], v[1]);
        if (it.state === 'normal') {   // the standing model's box in the map (its drawn LOD's local box through the placement)
          var r = vis.recs[v[0]], m = r.m, o = v[1] * 12;
          for (var q = 0; q < 8; q++) {
            var lx = r.pmin[0] + (q & 1 ? r.prange[0] : 0), ly = r.pmin[1] + (q & 2 ? r.prange[1] : 0), lz = r.pmin[2] + (q & 4 ? r.prange[2] : 0);
            var x = lx * m[o] + ly * m[o + 3] + lz * m[o + 6] + m[o + 9], z = lx * m[o + 2] + ly * m[o + 5] + lz * m[o + 8] + m[o + 11];
            p.box[0] = Math.min(p.box[0], x); p.box[1] = Math.min(p.box[1], z); p.box[2] = Math.max(p.box[2], x); p.box[3] = Math.max(p.box[3], z);
          }
        }
      }
    });
    parts.forEach(function (p) { out.push(p); });
    if (!out.length) return out;
    var I = S.bsmi;
    for (var n = 0; n < S.scen.n0; n++) {
      var c = col.bsmiObj.get(n); if (!c) continue;
      var path = S.st.get(S.bsmo.prim[I.model[n]]) || ''; if (path.toLowerCase().indexOf('_scenario.') < 0) continue;
      var x = I.t[n * 16 + 12], z = I.t[n * 16 + 14], best = null, bd = Infinity;
      out.forEach(function (p) {
        var b = p.box; if (!(b[0] - 0.5 <= x && x <= b[2] + 0.5 && b[1] - 0.5 <= z && z <= b[3] + 0.5)) return;
        var d = Math.hypot(x - (b[0] + b[2]) / 2, z - (b[1] + b[3]) / 2); if (d < bd) { bd = d; best = p; }
      });
      if (best) best.floor.push(1, c[0], c[1]);
    }
    out.forEach(function (p) { p.box = p.box.map(function (v) { return pyRound(v, 2); }); });
    return out;
  }
  MB.wgdeTable = function (W) {  // destr_probe.wgde: (chunk id, index) -> members
    var out = new Map();
    for (var i = 0; i < W.chunks.length / 3; i++) {
      var cid = W.chunks[i * 3], first = W.chunks[i * 3 + 1], count = W.chunks[i * 3 + 2];
      for (var j = 0; j < count; j++) { var a = W.ranges[(first + j) * 2], b = W.ranges[(first + j) * 2 + 1]; out.set(cid * 65536 + j, b === 0xffffffff ? [] : Array.prototype.slice.call(W.inst, a, b + 1)); }
    }
    return out;
  };

  // ---------------------------------------------------------------- destructibles.xml, bushes.xml (build.destructibles, bushes)
  var FIRST_MODULE_KIND = 73, MAX_MODULES = 23, MOD_WHOLE_REMAINS = -100, HELPER_MASK = 12, CAMERA_ONLY = 3;
  function destructibles(data) {
    var root = MB.packedXml(data, 'destructibles.xml'), out = {};
    [['trees', 'tree'], ['fallingAtoms', 'fallingAtom'], ['fragiles', 'fragile'], ['structures', 'structure']].forEach(function (sk) {
      var sec = root.find(sk[0]); if (!sec) return;
      sec.findall('entry').forEach(function (e) {
        var fn = (e.findtext('filename') || '').trim(); if (!fn) return;
        var mods = {};
        if (sk[1] === 'structure') {
          var parsed = [], me = e.find('modules');
          (me ? me.kids : []).forEach(function (m) { var name = (m.findtext('matName') || '').trim(), parts = name.split('_'); if (parts.length >= 3 && /^\d+$/.test(parts[2])) parsed.push([name, parseInt(parts[2], 10)]); });
          var ids = Array.from(new Set(parsed.map(function (x) { return x[1]; }))).sort(function (a, b) { return a - b; });
          parsed.forEach(function (x) { mods[x[0]] = FIRST_MODULE_KIND + ids.indexOf(x[1]); });
        }
        var dens = (e.findtext('density') || '').trim(), stem = fn.lastIndexOf('.') >= 0 ? fn.slice(0, fn.lastIndexOf('.')) : fn;
        out[stem.toLowerCase()] = { kind: sk[1], modules: mods, density: dens ? parseFloat(dens) : null };
      });
    });
    return out;
  }
  function bushNames(data) { var root = MB.packedXml(data, 'bushes.xml'); return root.kids.map(function (c) { return c.tag.toLowerCase(); }); }

  // ---------------------------------------------------------------- havok TAG0 (local_armor_inspector.havok, lazy structs)
  function TagFile(data) {
    this.d = data; this.dv = dvOf(data); this.sections = {}; this.cache = {};
    this.chunks(0, data.length);
    if (!this.sections.TAG0) throw new Error('Not a TAG0 file');
    this.ds = this.sections.DATA[0]; this.de = this.sections.DATA[1];
    this.parseTypes();
    var it = this.sections.ITEM; this.itemsAt = it[0]; this.itemsCount = (it[1] - it[0]) / 12;
  }
  TagFile.prototype.chunks = function (a, end) {
    while (a < end) {
      var word = this.dv.getUint32(a, false), size = word & 0x3fffffff, name = String.fromCharCode(this.d[a + 4], this.d[a + 5], this.d[a + 6], this.d[a + 7]);
      if (size < 8 || a + size > end) throw new Error('Invalid chunk size');
      this.sections[name] = [a + 8, a + size];
      if (!(word & 0x40000000)) this.chunks(a + 8, a + size);
      a += size;
    }
  };
  TagFile.prototype.packed = function () {
    var d = this.d, b = d[this.pos++];
    if (b < 0x80) return b;
    if (b < 0xc0) return ((b & 0x3f) << 8) | d[this.pos++];
    if (b < 0xe0) { var v = ((b & 0x1f) << 16) | (d[this.pos] << 8) | d[this.pos + 1]; this.pos += 2; return v; }
    if (b < 0xe8) { v = ((b & 7) << 24) | (d[this.pos] << 16) | (d[this.pos + 1] << 8) | d[this.pos + 2]; this.pos += 3; return v; }
    if (b === 0xe8) { v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }
    throw new Error('Unsupported packed integer');
  };
  TagFile.prototype.section = function (names) { for (var i = 0; i < names.length; i++) { var s = this.sections[names[i]]; if (s) { this.pos = s[0]; return s[1]; } } throw new Error('Missing ' + names.join('/')); };
  TagFile.prototype.strs = function (names) { var end = this.section(names), e = end; while (e > this.pos && this.d[e - 1] === 0xff) e--; return td.decode(this.d.subarray(this.pos, e)).split('\0'); };
  function HType() { this.name = ''; this.parent = null; this.flags = 0; this.sub = 0; this.pointer = null; this.size = 0; this.members = []; this._f = null; }
  HType.prototype.base = function () { return this.flags & 1 ? this : this.parent.base(); };
  HType.prototype.fields = function () {
    if (!this._f) { var all = [], t = this; var chain = []; while (t) { chain.unshift(t); t = t.parent; } chain.forEach(function (x) { all = all.concat(x.members); }); var m = {}; all.forEach(function (x) { m[x[0]] = [x[1], x[2]]; }); this._f = m; }
    return this._f;
  };
  TagFile.prototype.parseTypes = function () {
    var names = this.strs(['TST1', 'TSTR']); this.section(['TNA1', 'TNAM']);
    var n = this.packed(), types = this.types = [null], i, j;
    for (i = 1; i < n; i++) types.push(new HType());
    for (i = 1; i < n; i++) { types[i].name = names[this.packed()]; var k = this.packed(); for (j = 0; j < k; j++) { this.packed(); this.packed(); } }
    var fields = this.strs(['FST1', 'FSTR']), end = this.section(['TBDY', 'TBOD']);
    while (this.pos < end) {
      var ti = this.packed(); if (!ti) continue;
      var t = types[ti]; t.parent = types[this.packed()]; t.flags = this.packed();
      if (t.flags & 1) t.sub = this.packed();
      if (t.flags & 2 && (t.sub & 15) >= 6) t.pointer = types[this.packed()];
      if (t.flags & 4) this.packed();
      if (t.flags & 8) { t.size = this.packed(); this.packed(); }
      if (t.flags & 16) this.packed();
      if (t.flags & 32) { var c = this.packed() & 0xffff; for (j = 0; j < c; j++) { var nm = fields[this.packed()]; this.packed(); var off = this.packed(); t.members.push([nm, off, types[this.packed()]]); } }
      if (t.flags & 64) { c = this.packed(); for (j = 0; j < c; j++) { this.packed(); this.packed(); } }
      if (t.flags & 128) throw new Error('Unsupported type flags');
    }
  };
  function intCode(t) { var s = t.sub; return s & 0x2000 ? 1 : s & 0x4000 ? 2 : s & 0x8000 ? 4 : s & 0x10000 ? 8 : 0; }
  TagFile.prototype.scalarRead = function (t, off) {  // -> value of a plain int / float type, or undefined
    var kind = t.sub & 0x7f, dv = this.dv;
    if (kind === 2 || kind === 4) {
      var w = intCode(t), sg = t.sub & 0x200; if (!w) throw new Error('Unknown integer');
      var v = w === 1 ? (sg ? dv.getInt8(off) : dv.getUint8(off)) : w === 2 ? (sg ? dv.getInt16(off, true) : dv.getUint16(off, true)) : w === 4 ? (sg ? dv.getInt32(off, true) : dv.getUint32(off, true)) : dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296;
      return kind === 2 ? !!v : v;
    }
    if (kind === 5) return t.size === 4 ? dv.getFloat32(off, true) : t.size === 8 ? dv.getFloat64(off, true) : null;
    return undefined;
  };
  TagFile.prototype.item = function (index) {
    if (!index) return [];
    if (this.cache[index]) return this.cache[index];
    if (index >= this.itemsCount) throw new Error('Invalid item index');
    var q = this.itemsAt + 12 * index, flag = this.dv.getUint32(q, true), offset = this.dv.getUint32(q + 4, true), count = this.dv.getUint32(q + 8, true);
    var t = this.types[flag & 0xffffff], b = t.base();
    if (count > 1000000 || offset + count * b.size > this.de - this.ds) throw new Error('Invalid item bounds');
    var start = this.ds + offset, out = [], kind = b.sub & 0x7f;
    this.cache[index] = out;
    for (var i = 0; i < count; i++) out.push(this.object(t, start + i * b.size));
    return out;
  };
  TagFile.prototype.object = function (original, offset) {
    var t = original.base(), kind = t.sub & 0x7f;
    if (kind === 2 || kind === 4 || kind === 5) return this.scalarRead(t, offset);
    if (kind === 3 || kind === 6 || kind === 8) {
      var values = this.item(this.dv.getUint32(offset, true));
      if (kind === 3) { var bytes = values.map(function (v) { return v & 255; }); while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop(); return td.decode(new Uint8Array(bytes)); }
      if (kind === 6) return values.length === 1 ? values[0] : null;
      return values;
    }
    if (kind === 7) return new HStruct(this, original, offset);
    if (kind === 0x28) { var out = [], pb = t.pointer.base().size; for (var i = 0; i < t.sub >> 8; i++) out.push(this.object(t.pointer, offset + i * pb)); return out; }
    if (kind === 0) return null;
    throw new Error('Unsupported subtype ' + kind + ' (' + original.name + ')');
  };
  function HStruct(tag, type, offset) { this._tag = tag; this._type = type; this._off = offset; this._v = { __type: type.name }; }
  HStruct.prototype.get = function (k) {
    if (!(k in this._v)) { var fm = this._type.fields()[k]; if (!fm) throw new Error('KeyError ' + k); this._v[k] = this._tag.object(fm[1], this._off + fm[0]); }
    return this._v[k];
  };
  HStruct.prototype.has = function (k) { return k in this._v || k in this._type.fields(); };
  // build.model_bodies with geometry.compressed_mesh reduced to what the default view needs: per body its variant,
  // name, collisionFlags and triangle count (the triangles themselves only feed the collision mode)
  function havokBodies(data, name) {
    once('havok', name);
    var root = new TagFile(data).item(1)[0], flags = {}, out = [];
    root.get('namedVariants').forEach(function (nv) {
      var bf = nv.get('variant').get('resourceHandles').filter(function (h) { return h.get('name') === 'HKBodyFlagsData'; })[0];
      if (!bf) return; bf = bf.get('variant');
      bf.get('flags_').forEach(function (fl) { var v; try { v = fl.get('collisionFlags'); } catch (e) { v = 0; } flags[fl.get('name')] = v || 0; });
    });
    root.get('namedVariants').forEach(function (nv) {
      var vname = (nv.has('name') ? nv.get('name') : '') || '';
      var sys = nv.get('variant').get('resourceHandles').filter(function (h) { return h.get('name') === 'Collision Physics Data'; })[0];
      if (!sys) return; sys = sys.get('variant');
      sys.get('bodyCinfos').forEach(function (body) {
        var shape = body.get('shape');
        if (shape.get('__type') !== 'hknpCompressedMeshShape') return;
        var tree = shape.get('data').get('meshTree'), prims = tree.get('primitives'), tris = 0;
        tree.get('sections').forEach(function (s) {
          var first = s.get('firstPrimitiveIndex'), np = s.get('numPrimitives');
          for (var q = first; q < first + np && q < prims.length; q++) {
            var ix = prims[q].get('indices'), a = ix[0], b = ix[1], c = ix[2], d = ix[3];
            var abc = a !== b && b !== c && a !== c, acd = a !== c && c !== d && a !== d;
            if (!(abc || acd)) continue;   // a padding primitive (0xDEADDEAD)
            if (abc) tris++;
            if (d !== c && acd) tris++;
          }
        });
        var bn = body.get('name'), fl = flags[bn];
        if (fl === undefined) { fl = flags[bn.replace(/^[sn]_/, '')]; if (fl === undefined) fl = 0; }
        out.push([vname, bn, fl, tris]);
      });
    });
    return out;
  }
  MB.havokBodies = havokBodies;

  // ---------------------------------------------------------------- visual models (visual_model, objects_visual)
  function mdlOf(P, path) {
    return P.get('mdl', path, null, function (b) {
      var m = MB.packedXml(b, path), vis = (m.findtext('nodelessVisual') || m.findtext('nodefullVisual') || '').trim(), ext = (m.findtext('extent') || '').trim();
      return { vis: vis, ext: ext ? parseFloat(ext) : null, parent: (m.findtext('parent') || '').trim() };
    });
  }
  function lodChain(P, stem) {
    var out = [], seen = {};
    while (stem && !seen[stem.toLowerCase()]) {
      seen[stem.toLowerCase()] = 1;
      var m = mdlOf(P, stem + '.model'); if (!m) break;
      out.push([m.vis || stem, m.ext]); stem = m.parent;
    }
    return out;
  }
  function primBlocks(data) {
    var dv = dvOf(data), tsize = dv.getUint32(data.length - 4, true), p = data.length - 4 - tsize, pos = 4, out = {};
    while (p < data.length - 4) {
      var size = dv.getUint32(p, true), nlen = dv.getUint32(p + 20, true), name = latin(data.subarray(p + 24, p + 24 + nlen));
      p += 24 + ((nlen + 3) & ~3); out[name] = [pos, size]; pos += (size + 3) & ~3;
    }
    return out;
  }
  function cstr(u, a, n) { var e = a; while (e < a + n && u[e]) e++; return latin(u.subarray(a, e)); }
  function indexHead(data, pos) { var fmt = cstr(data, pos, 64), dv = dvOf(data), n = dv.getUint32(pos + 64, true), ng = dv.getUint32(pos + 68, true), w = fmt === 'list32' ? 4 : 2, gp = pos + 72 + n * w, g = []; for (var i = 0; i < ng; i++) g.push([dv.getUint32(gp + 16 * i, true), dv.getUint32(gp + 16 * i + 4, true)]); return { n: n, w: w, at: pos + 72, groups: g }; }
  function visualXml(data, path) {
    var v = MB.packedXml(data, path), out = [];
    v.findall('renderSet').forEach(function (rs) {
      rs.findall('geometry').forEach(function (g) {
        var groups = [];
        g.findall('primitiveGroup').forEach(function (pg) {
          var m = pg.find('material'), props = {};
          if (m) m.findall('property').forEach(function (pp) {
            var tex = pp.findtext('Texture');
            if (tex) props[(pp.text || '').trim()] = tex.trim();
            // 19.11 (visual_model.visual, round 11): numeric properties too ('#' + name -> the value's text)
            else pp.kids.forEach(function (ch) { if (ROCK_VALUE_TAGS.indexOf(ch.tag) >= 0) props['#' + (pp.text || '').trim()] = (ch.text || '').trim(); });
          });
          groups.push([parseInt((pg.text || '0').trim() || '0', 10), m ? (m.findtext('identifier') || '').trim() : '', props, m ? (m.findtext('fx') || '').trim() : '']);
        });
        out.push([(g.findtext('vertices') || '').trim(), (g.findtext('primitive') || '').trim(), groups]);
      });
    });
    return out;
  }
  // per visual LOD: its groups (material, textures, fx, triangle count) - the LOD choice needs no vertices
  function lodInfo(P, vs) {
    var pe = P.raw.resEntry(vs + '.primitives_processed');
    if (!P.raw.resEntry(vs + '.visual_processed') || !pe) return null;
    return P.get('lod', vs + '.visual_processed', pe.crc, function (vdata) {
      var vis = visualXml(vdata, vs + '.visual_processed'), data = P.raw.res(vs + '.primitives_processed'); once('primitives', vs);
      var bl = primBlocks(data), groups = [], sets = {};
      vis.forEach(function (r, ri) {
        if (!bl[r[0]] || !bl[r[1]]) return;
        // 19.11: the blocks that may hold the set's second texcoord stream (visual_model.second_uv's names)
        sets[ri] = [bl[r[0]], bl[r[1]], [r[0].split('vertices').join('uv2'), 'uv2', r[0] + '.uv2'].filter(function (nm) { return bl[nm]; }).map(function (nm) { return bl[nm]; })];
        var ih = indexHead(data, bl[r[1]][0]);
        r[2].forEach(function (g) {
          if (g[0] >= ih.groups.length) return;
          var first = ih.groups[g[0]][0], np = ih.groups[g[0]][1], len = Math.max(0, Math.min(ih.n, first + np * 3) - first);
          groups.push({ rs: ri, gi: g[0], material: g[1], tex: g[2], fx: g[3], ntri: Math.floor(len / 3) });
        });
      });
      return { groups: groups, sets: sets };
    });
  }
  // the geometry of a LOD actually drawn (visual_model.geometry): per render set positions / texcoords, per group
  // triangles; the visual's XML and the block table come from the LOD's product (not parsed again)
  function lodGeometry(P, vs) {
    var pe = P.raw.resEntry(vs + '.primitives_processed'), info = lodInfo(P, vs);
    return P.get('geo', vs + '.visual_processed', pe.crc, function () {
      if (pe.sparse) throw MB.needWhole(pe.path);   // the mod judged this LOD never drawn: never draw it from zeros
      var data = P.raw.res(vs + '.primitives_processed'), dv = dvOf(data); once('primitives geometry', vs);
      var sets = {}, heads = {};
      info.groups.forEach(function (g) {
        var ri = g.rs; if (sets[ri]) return;
        var vb = info.sets[ri][0], pos = vb[0], size = vb[1], fmt, n, start;
        if (data[pos] === 0x42 && data[pos + 1] === 0x50 && data[pos + 2] === 0x56 && data[pos + 3] === 0x54) { fmt = cstr(data, pos + 68, 64); n = dv.getUint32(pos + 132, true); start = pos + 136; }
        else { fmt = cstr(data, pos, 64); n = dv.getUint32(pos + 64, true); start = pos + 68; }
        var stride = Math.floor((pos + size - start) / Math.max(1, n)), P3 = new Float32Array(n * 3), UV = null;
        for (var i = 0; i < n; i++) for (var k = 0; k < 3; k++) P3[i * 3 + k] = dv.getFloat32(start + i * stride + 4 * k, true);
        if (fmt.split('/').pop().indexOf('xyznuv') === 0) { UV = new Float32Array(n * 2); for (i = 0; i < n; i++) { UV[i * 2] = dv.getFloat32(start + i * stride + 16, true); UV[i * 2 + 1] = dv.getFloat32(start + i * stride + 20, true); } }
        sets[ri] = { pos: P3, uv: UV, n: n, uv2: secondUv(data, dv, info.sets[ri][2] || [], n) };
        heads[ri] = indexHead(data, info.sets[ri][1][0]);
      });
      var tris = info.groups.map(function (g) {
        var ih = heads[g.rs], first = ih.groups[g.gi][0], np = ih.groups[g.gi][1], end = Math.min(ih.n, first + np * 3), t = new Uint32Array(Math.max(0, end - first));
        for (var q = first; q < end; q++) t[q - first] = ih.w === 4 ? dv.getUint32(ih.at + q * 4, true) : dv.getUint16(ih.at + q * 2, true);
        return { rs: g.rs, tri: t };
      });
      return { sets: sets, tris: tris };
    });
  }
  function atlasFirstTile(P, path) {
    var ap = path.slice(0, path.lastIndexOf('.')) + '.atlas_processed';
    if (P.raw.resEntry(ap)) {
      return P.get('atl', ap, null, function (data) {
        var s = latin(data), i = s.indexOf('content/'); if (i < 0) return { tile: null };
        var name = s.slice(i, s.indexOf('\0', i)); name = name.slice(0, name.lastIndexOf('.')) + '.dds';
        var k = name.lastIndexOf('/'), cands = [name, name.slice(0, k) + '/dds/' + name.slice(k + 1)];
        for (var c = 0; c < 2; c++) if (P.raw.resEntry(cands[c])) return { tile: cands[c] };
        return { tile: null };
      }).tile;
    }
    return /\.dds$/i.test(path) && P.raw.resEntry(path) ? path : null;
  }
  function textureOf(P, g) {
    var t = g.tex;
    if ('diffuseMap' in t) return t.diffuseMap;
    if ('albedoHeightTile0' in t) return t.albedoHeightTile0;
    if ('atlasAlbedoHeight' in t) return atlasFirstTile(P, t.atlasAlbedoHeight);
    return t.diffuseMap2 || null;
  }
  // DDS colour blocks (dds._bc1_colors palette, alpha of BC1 / BC3 / BC2 as dds.decode)
  function ddsHead(data) {
    if (!(data[0] === 0x44 && data[1] === 0x44 && data[2] === 0x53 && data[3] === 0x20)) return null;
    var dv = dvOf(data), h = dv.getUint32(12, true), w = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true)), pf = dv.getUint32(80, true);
    var four = String.fromCharCode(data[84], data[85], data[86], data[87]), p = 128, fmt = null;
    if (four === 'DX10') { fmt = dv.getUint32(128, true); p += 20; }
    return { w: w, h: h, mips: mips, pf: pf, four: four, fmt: fmt, p: p };
  }
  // dds.bc1_levels source: every level from the copied slice (first <= 128 px) as BC1 blocks (BC3 colour half fixed)
  function texLevels(data, path) {
    once('dds', path);
    var H = ddsHead(data); if (!H) return null;
    var four = H.four === 'DX10' ? ({ 71: 'DXT1', 72: 'DXT1', 77: 'DXT5', 78: 'DXT5' })[H.fmt] : H.four, bs = four === 'DXT1' ? 8 : four === 'DXT5' ? 16 : 0;
    if (!bs) return null;
    var out = [], ww = H.w, hh = H.h, p = H.p;
    for (var l = 0; l < H.mips; l++) {
      var bw = Math.max(1, (ww + 3) >> 2), bh = Math.max(1, (hh + 3) >> 2), n = bw * bh, b = new Uint8Array(n * 8);
      for (var i = 0; i < n; i++) {
        var q = p + i * bs + (bs - 8), o = i * 8;
        for (var k = 0; k < 8; k++) b[o + k] = data[q + k];
        if (bs === 16) {  // dds._bc1_from_bc3_colour
          var c0 = b[o] | b[o + 1] << 8, c1 = b[o + 2] | b[o + 3] << 8;
          if (c0 < c1) {
            var t0 = b[o], t1 = b[o + 1]; b[o] = b[o + 2]; b[o + 1] = b[o + 3]; b[o + 2] = t0; b[o + 3] = t1;
            var v = ((b[o + 4] | b[o + 5] << 8 | b[o + 6] << 16 | b[o + 7] << 24) ^ 0x55555555) >>> 0;
            b[o + 4] = v & 255; b[o + 5] = v >>> 8 & 255; b[o + 6] = v >>> 16 & 255; b[o + 7] = v >>> 24;
          } else if (c0 === c1) { b[o + 4] = b[o + 5] = b[o + 6] = b[o + 7] = 0; }
        }
      }
      out.push({ size: Math.max(ww, hh), w: Math.max(1, ww), h: Math.max(1, hh), bw: bw, bh: bh, b: b });
      p += n * bs; ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1);
    }
    return out;
  }
  function pal(c0, c1, P) {
    P[0] = (c0 >> 11 & 31) * 255 / 31; P[1] = (c0 >> 5 & 63) * 255 / 63; P[2] = (c0 & 31) * 255 / 31;
    P[3] = (c1 >> 11 & 31) * 255 / 31; P[4] = (c1 >> 5 & 63) * 255 / 63; P[5] = (c1 & 31) * 255 / 31;
    var four = c0 > c1;
    for (var j = 0; j < 3; j++) { P[6 + j] = four ? (2 * P[j] + P[3 + j]) / 3 : (P[j] + P[3 + j]) / 2; P[9 + j] = four ? (P[j] + 2 * P[3 + j]) / 3 : 0; }
    return four;
  }
  function solidBlock(rgb) {  // dds.solid_block
    var r = rhe(rgb[0]), g = rhe(rgb[1]), b = rhe(rgb[2]);
    var c = (Math.min(31, Math.floor(r * 31 / 255)) << 11) | (Math.min(63, Math.floor(g * 63 / 255)) << 5) | Math.min(31, Math.floor(b * 31 / 255)), c1 = Math.max(0, c - 1);
    return new Uint8Array([c & 255, c >> 8, c1 & 255, c1 >> 8, 0, 0, 0, 0]);
  }
  function bc1Levels(L, size, nlevels) {  // dds.bc1_levels on the stored levels
    var out = [];
    for (var l = 0; l < L.length && out.length < nlevels; l++) if (L[l].size <= size || l === L.length - 1) out.push(L[l]);
    while (out.length < nlevels) {
      var last = out[out.length - 1], P = new Float64Array(12), s = [0, 0, 0], n = 0;
      for (var i = 0; i < last.b.length; i += 8) {
        pal(last.b[i] | last.b[i + 1] << 8, last.b[i + 2] | last.b[i + 3] << 8, P);
        var bits = (last.b[i + 4] | last.b[i + 5] << 8 | last.b[i + 6] << 16 | last.b[i + 7] << 24) >>> 0;
        for (var t = 0; t < 16; t++) { var ci = (bits >>> (2 * t)) & 3; s[0] += P[ci * 3]; s[1] += P[ci * 3 + 1]; s[2] += P[ci * 3 + 2]; n++; }
      }
      out.push({ w: Math.max(1, last.w >> 1), h: Math.max(1, last.h >> 1), bw: 1, bh: 1, b: solidBlock([s[0] / n, s[1] / n, s[2] / n]) });
    }
    return out;
  }
  // ---------------------------------------------------------------- 19.11: rocks (objects_visual.py round 11, Rocks)
  // The game's PBS_tiled_atlas_global (rocks, cliffs): three tiles of the albedo-height atlas at the tile scale (uv1),
  // mixed by the model's blend mask (uv2), tints, dirt, the global texture (the trial's objects_visual.py comment has
  // the formula). The page gets every texture as a layer of one DXT5 array (ROCK_SIZE px, the game's own blocks copied
  // at that mip; the mod's map_raw.py copies each texture from that level down) and per material 5 vec4s.
  var ROCK_VALUE_TAGS = ['Vector4', 'Float', 'Int', 'Bool'];
  var ROCK_FX = 'pbs_tiled_atlas_global', ROCK_SIZE = 128, ROCK_MIN = 4;
  var ROCK_DEFAULTS = { g_atlasSizes: [2, 2, 8, 1], g_tileUVScale: [1, 1, 0, 0], g_atlasIndexes: [0, 0, 0, 0],
    g_tile0Tint: [1, 1, 1, 1], g_tile1Tint: [1, 1, 1, 1], g_tile2Tint: [1, 1, 1, 1], g_dirtColor: [0.47, 0.43, 0.38, 1] };
  // visual_model.second_uv: block 'uv2' ('BPVS', 'set3/uv2pc': n x 2 f32) of a vertex block of n vertices, or null
  function secondUv(data, dv, blocks, n) {
    for (var c = 0; c < blocks.length; c++) {
      var pos = blocks[c][0], size = blocks[c][1];
      if (!(data[pos] === 0x42 && data[pos + 1] === 0x50 && data[pos + 2] === 0x56 && data[pos + 3] === 0x53)) continue;
      var cnt = dv.getUint32(pos + 132, true);
      if (cnt !== n || size - 136 < n * 8) continue;
      var out = new Float32Array(n * 2);
      for (var i = 0; i < n * 2; i++) out[i] = dv.getFloat32(pos + 136 + 4 * i, true);
      return out;
    }
    return null;
  }
  function rockHead(data) {  // objects_visual._dds_head
    if (!data || !(data[0] === 0x44 && data[1] === 0x44 && data[2] === 0x53 && data[3] === 0x20)) return null;
    var dv = dvOf(data), h = dv.getUint32(12, true), w = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true));
    var four = String.fromCharCode(data[84], data[85], data[86], data[87]), p = 128;
    if (four === 'DX10') { four = ({ 71: 'DXT1', 72: 'DXT1', 77: 'DXT5', 78: 'DXT5' })[dv.getUint32(128, true)]; p += 20; }
    var bs = four === 'DXT1' ? 8 : four === 'DXT5' ? 16 : 0;
    return bs ? { w: w, h: h, mips: mips, p: p, bs: bs } : null;
  }
  // objects_visual.dxt5_region: DXT5 blocks of the square region (x0, y0, cw, ch) at the mip where it is `size` px and
  // the levels below down to ROCK_MIN px ([Uint8Array per level]) or null; DXT1 blocks get an opaque alpha block
  function dxt5Region(data, x0, y0, cw, ch, size) {
    size = size || ROCK_SIZE;
    var hd = rockHead(data);
    if (!hd || cw !== ch || cw < size) return null;
    var bs = hd.bs, p = hd.p, ww = hd.w, hh = hd.h, out = [];
    for (var l = 0; l < hd.mips; l++) {
      var bw = Math.max(1, (ww + 3) >> 2), bh = Math.max(1, (hh + 3) >> 2), n = bw * bh, rw = cw >> l;
      if (size >= rw && rw >= ROCK_MIN) {
        if (rw !== size && !out.length) return null;
        var rx = x0 >> l, ry = y0 >> l;
        if (rx % 4 || ry % 4 || rw % 4) return null;
        if (p + n * bs > data.length) return null;
        var nb = rw >> 2, bx = rx >> 2, by = ry >> 2;
        if (by + nb > bh || bx + nb > bw) return null;   // the region's shape check (numpy slicing clips)
        var o = new Uint8Array(nb * nb * 16), k = 0;
        for (var r = 0; r < nb; r++) for (var c = 0; c < nb; c++) {
          var src = p + ((by + r) * bw + bx + c) * bs;
          if (bs === 8) { o[k] = 255; o[k + 1] = 255; o.set(data.subarray(src, src + 8), k + 8); }
          else o.set(data.subarray(src, src + 16), k);
          k += 16;
        }
        out.push(o);
      }
      p += n * bs; ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1);
    }
    var want = 0; for (var s_ = size; s_ >= ROCK_MIN; s_ >>= 1) want++;
    return out.length === want ? out : null;
  }
  function rockVec(props, name) {  // objects_visual._vec
    var v = props['#' + name], d = ROCK_DEFAULTS[name];
    if (v == null) return d.slice();
    var t = String(v).split(/\s+/).filter(Boolean), fv = t.map(Number);
    if (fv.some(function (x) { return isNaN(x); })) return d.slice();
    return fv.concat(d.slice(fv.length));
  }
  function ddsOf(P, path) {  // objects_visual._dds_of
    if (!path) return null;
    var i = path.lastIndexOf('.'), base = i >= 0 ? path.slice(0, i) : path, k = base.lastIndexOf('/');
    var cands = [base + '.dds'].concat(k >= 0 ? [base.slice(0, k) + '/dds/' + base.slice(k + 1) + '.dds'] : []);
    for (var c = 0; c < cands.length; c++) if (P.raw.resEntry(cands[c])) return cands[c];
    return null;
  }
  // objects_visual.atlas_tiles: ['tiles', Map(rect key -> {rect, dds})] for an '.atlas', ['dds', path] for a texture, or null
  function rockAtlasTiles(P, memo, path) {
    if (memo.has(path)) return memo.get(path);
    var out = null;
    if (/\.atlas$/i.test(path)) {
      var data = P.raw.res(path.slice(0, path.lastIndexOf('.')) + '.atlas_processed');
      if (data && data.length > 16) {
        var dv = dvOf(data), W = dv.getUint32(4, true), H = dv.getUint32(8, true), tiles = new Map(), p = 16;
        while (p + 16 < data.length) {
          var x0 = dv.getUint32(p, true), x1 = dv.getUint32(p + 4, true), y0 = dv.getUint32(p + 8, true), y1 = dv.getUint32(p + 12, true); p += 16;
          var e = data.indexOf(0, p); if (e < 0) break;
          var name = latin(data.subarray(p, e)); p = e + 1;
          var dd = ddsOf(P, name);
          if (dd && x1 > x0) tiles.set([x0, x1, y0, y1, W, H].join(','), { r: [x0, x1, y0, y1, W, H], dds: dd });
        }
        out = tiles.size ? ['tiles', tiles] : null;
      }
    } else if (path) {
      var d2 = ddsOf(P, path);
      out = d2 ? ['dds', d2] : null;
    }
    memo.set(path, out);
    return out;
  }
  function Rocks(P) { this.P = P; this.layers = new Map(); this.keys = []; this.mats = new Map(); this.vecs = []; this.stats = {}; this.atlases = new Map(); }
  Rocks.prototype.stat = function (k) { this.stats[k] = (this.stats[k] || 0) + 1; };
  Rocks.prototype.layer = function (key, fn) {
    if (!this.layers.has(key)) {
      var lv = fn();
      if (lv == null) { this.stat('layers unreadable'); return -1; }
      this.layers.set(key, lv); this.keys.push(key);
    }
    return this.keys.indexOf(key);
  };
  Rocks.prototype.full = function (path) {
    var P = this.P;
    return this.layer(JSON.stringify(['full', path.toLowerCase()]), function () {
      var data = P.raw.res(path), hd = rockHead(data);
      return hd ? dxt5Region(data, 0, 0, hd.w, hd.h) : null;
    });
  };
  Rocks.prototype.cell = function (path, cols, rows, i) {
    var P = this.P;
    return this.layer(JSON.stringify(['cell', path.toLowerCase(), cols, rows, i]), function () {
      var data = P.raw.res(path), hd = rockHead(data);
      if (!hd) return null;
      var cw = Math.floor(hd.w / cols), ch = Math.floor(hd.h / rows);
      return dxt5Region(data, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
    });
  };
  // -> material index, or null when its textures cannot be had (the group keeps the atlas look)
  Rocks.prototype.material = function (gr) {
    var t = gr.tex, sizes = rockVec(t, 'g_atlasSizes'), idx = rockVec(t, 'g_atlasIndexes');
    var g4 = sizes.slice(0, 4).map(function (v) { return Math.max(1, rhe(v)); }), cols = g4[0], rows = g4[1], bcols = g4[2], brows = g4[3];
    var own = Object.keys(t).filter(function (k) { return k.charAt(0) === '#'; }).sort().map(function (k) { return [k, t[k]]; });
    var key = JSON.stringify([t.atlasAlbedoHeight, t.atlasBlend, t.globalTex, t.dirtMap].map(function (x) { return x == null ? null : x; }).concat(own));
    if (this.mats.has(key)) return this.mats.get(key);
    var at = rockAtlasTiles(this.P, this.atlases, t.atlasAlbedoHeight || '');
    if (!at) { this.stat('no albedo atlas'); return null; }
    var tl = [];
    for (var k = 0; k < 3; k++) {
      var i = Math.max(0, rhe(idx[k]));
      if (at[0] === 'tiles') {
        var hit = [];
        at[1].forEach(function (x) { var r = x.r; if (Math.floor(r[0] * cols / r[4]) + Math.floor(r[2] * rows / r[5]) * cols === i) hit.push(x.dds); });
        if (!hit.length) { this.stat('tile index missing'); hit = [at[1].values().next().value.dds]; }   // an index past the atlas' tiles: its first tile
        tl.push(this.full(hit[0]));
      } else tl.push(this.cell(at[1], cols, rows, i));
    }
    var inset = at[0] === 'dds' ? 0.0625 : 0.0, bl = ddsOf(this.P, t.atlasBlend);
    if (bl == null || Math.min.apply(null, tl) < 0) { this.stat('no blend or tile'); return null; }
    var bi = this.cell(bl, bcols, brows, Math.max(0, rhe(idx[3])));
    if (bi < 0) return null;
    var gt = ddsOf(this.P, t.globalTex), dt = ddsOf(this.P, t.dirtMap), gi = gt ? this.full(gt) : -1, di = dt ? this.full(dt) : -1;
    var sc = rockVec(t, 'g_tileUVScale'), dc = rockVec(t, 'g_dirtColor'), t0 = rockVec(t, 'g_tile0Tint'), t1 = rockVec(t, 'g_tile1Tint'), t2 = rockVec(t, 'g_tile2Tint');
    var v = [tl[0], tl[1], tl[2], di, bi, gi, sc[0], sc[1], t0[0], t0[1], t0[2], inset, t1[0], t1[1], t1[2], dc[3], t2[0], t2[1], t2[2], 0.0];
    this.vecs.push(v.map(function (x) { return pyRound(x, 5); }));
    this.mats.set(key, this.vecs.length - 1);
    return this.vecs.length - 1;
  };
  Rocks.prototype.out = function () {
    var n = this.keys.length; if (!n) return null;
    var lv = this.keys.map(function (k) { return this.layers.get(k); }, this), levels = [], s_ = ROCK_SIZE;
    for (var l = 0; l < lv[0].length; l++) {
      var len = 0; lv.forEach(function (x) { len += x[l].length; });
      var b = new Uint8Array(len), at = 0; lv.forEach(function (x) { b.set(x[l], at); at += x[l].length; });
      levels.push({ w: s_, h: s_, dxt5: b }); s_ >>= 1;
    }
    var names = this.keys.map(function (k) { var a = JSON.parse(k); return a[1].split('/').pop() + (a[0] === 'full' ? '' : '#' + a[4]); });
    return { size: ROCK_SIZE, n: n, levels: levels, mats: this.vecs, layers: names };
  };
  MB.dxt5Region = dxt5Region;

  var ATLAS_W = 1024, LEVELS = 5;
  function budget(diag, n) { return Math.min(diag > 12 ? 800 : (diag > 4 ? 360 : 160), Math.max(100, Math.floor(50000 / Math.max(1, n)))); }
  function skipPath(p) { var pl = p.toLowerCase(); return pl.indexOf('particles/') === 0 || pl.indexOf('objects/misc/') === 0 || pl.indexOf('system/') === 0 || pl.indexOf('null_model') >= 0; }
  function moduleOf(mid, mods) {
    if (mid.indexOf('n_') === 0 && mid in mods) { var k = mods[mid] - FIRST_MODULE_KIND; return k < MAX_MODULES ? k + 1 : 0; }
    if (mid.indexOf('d_') === 0) { var key = 'n_' + mid.slice(2); if (key in mods) { k = mods[key] - FIRST_MODULE_KIND; return k < MAX_MODULES ? -(k + 1) : 0; } return MOD_WHOLE_REMAINS; }
    return 0;
  }
  function chooseLod(P, stem, diag, count) {
    var chain = lodChain(P, stem); if (!chain.length) return null;
    var tried = [], pick = null;
    for (var c = 0; c < chain.length; c++) {
      var vs = chain[c][0], g = lodInfo(P, vs); if (!g) continue;
      var n = 0; g.groups.forEach(function (x) { if (textureOf(P, x)) n += x.ntri; });
      var parts = vs.split('/'); tried.push([parts[parts.length - 2], n, chain[c][1]]); pick = { vs: vs, info: g };
      if (n <= budget(diag, count)) break;
    }
    return pick ? { pick: pick, tried: tried } : null;
  }
  function visualModels(P, objs, destr, arena, stats) {
    var byprim = new Map();
    objs.forEach(function (o, key) { var p = o.k0; if (p && /\.primitives$/.test(p) && !skipPath(p)) { var pk = o.ruin ? p + '|ruin' : p; if (!byprim.has(pk)) byprim.set(pk, []); byprim.get(pk).push([key, o]); } });
    var tiles = new Map(), pending = [], rocks = new Rocks(P);
    function want(path, size) { var t = tiles.get(path); if (!t || t.want < size) tiles.set(path, { want: size }); }
    byprim.forEach(function (items) {
      var ruin = !!items[0][1].ruin, prim = items[0][1].k0, stem = prim.slice(0, prim.lastIndexOf('.'));
      if (!P.raw.resEntry(stem + '.visual_processed')) { stats['no visual'] = (stats['no visual'] || 0) + 1; return; }
      var c0 = chooseLod(P, stem, 0, 1); if (!c0) { stats['no geometry'] = (stats['no geometry'] || 0) + 1; return; }
      var geo = lodGeometry(P, c0.pick.vs), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      geo.tris.forEach(function (t) { var S = geo.sets[t.rs].pos; for (var i = 0; i < S.length; i++) { var k = i % 3; if (S[i] < lo[k]) lo[k] = S[i]; if (S[i] > hi[k]) hi[k] = S[i]; } });
      var dx = f(hi[0] - lo[0]), dy = f(hi[1] - lo[1]), dz = f(hi[2] - lo[2]), diag = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
      if (diag > 400) { stats['outland giant skipped'] = (stats['outland giant skipped'] || 0) + 1; return; }
      var ch = chooseLod(P, stem, diag, items.length), vs = ch.pick.vs;
      var size = diag > 20 && (prim.toLowerCase().indexOf('/buildings/') >= 0 || prim.toLowerCase().indexOf('/railway/') >= 0) ? 128 : 64;
      var d = destr[stem.toLowerCase()] || {}, mods = d.modules || {}, parts = [];
      ch.pick.info.groups.forEach(function (gr, gi) {
        var tex = textureOf(P, gr);
        if (!tex || gr.fx.toLowerCase().indexOf('distortion') >= 0) { stats['groups without texture'] = (stats['groups without texture'] || 0) + 1; return; }
        want(tex, size);
        // 19.11 (round 11): a group drawn by the rock shader whose render set has a second texcoord stream
        var rm = null;
        if (gr.fx.toLowerCase().indexOf(ROCK_FX) >= 0 && lodGeometry(P, vs).sets[gr.rs].uv2) rm = rocks.material(gr);
        parts.push([gi, tex, ruin ? MOD_WHOLE_REMAINS : moduleOf(gr.material, mods), rm]);
      });
      if (!parts.length) { stats['models without textured groups'] = (stats['models without textured groups'] || 0) + 1; return; }
      pending.push({ prim: prim, items: items, vs: vs, tried: ch.tried, parts: parts, d: d, ruin: ruin });
    });
    if (tiles.size > 100) { tiles.forEach(function (t) { t.want = Math.min(t.want, 64); }); stats['all tiles 64 px (many textures)'] = 1; }
    var bad = 0;
    tiles.forEach(function (t, path) {
      var L = P.get('tex', path, null, function (data) { return texLevels(data, path); });
      if (!L) { tiles.delete(path); bad++; return; }
      t.levels = bc1Levels(L, t.want, LEVELS);
    });
    stats['textures unreadable'] = bad;
    // Atlas.pack
    var big = [], small = [];
    tiles.forEach(function (t, p) { (t.levels[0].w > 64 || t.levels[0].h > 64 ? big : small).push(p); });
    var cells = big.length + Math.ceil(small.length / 4), per = ATLAS_W / 128, rows = Math.max(1, Math.ceil(cells / per)), H = rows * 128, W = ATLAS_W, c = 0;
    big.forEach(function (p) { tiles.get(p).xy = [(c % per) * 128, Math.floor(c / per) * 128]; c++; });
    small.forEach(function (p, i) { var cell = c + Math.floor(i / 4), q = i % 4; tiles.get(p).xy = [(cell % per) * 128 + (q % 2) * 64, Math.floor(cell / per) * 128 + Math.floor(q / 2) * 64]; });
    var levels = [];
    for (var l = 0; l < LEVELS; l++) {
      var w = W >> l, h = H >> l, bw = w >> 2, bh = h >> 2, blk = new Uint8Array(bw * bh * 8);
      tiles.forEach(function (t) {
        var L = t.levels[l], x = t.xy[0] >> l, y = t.xy[1] >> l;
        for (var r = 0; r < L.bh; r++) blk.set(L.b.subarray(r * L.bw * 8, (r + 1) * L.bw * 8), (((y >> 2) + r) * bw + (x >> 2)) * 8);
      });
      levels.push({ w: w, h: h, bc1: blk });
    }
    function rect(p) { var t = tiles.get(p); return [f(t.xy[0] / W), f(t.xy[1] / H), f(t.levels[0].w / W), f(t.levels[0].h / H)]; }
    var recs = [], index = new Map(), ax0 = arena[0], az0 = arena[1], ax1 = arena[2], az1 = arena[3];
    pending.forEach(function (pd) {
      var geo = lodGeometry(P, pd.vs), info = lodInfo(P, pd.vs), Ps = [], Us = [], Rs = [], Ms = [], Is = [], base = 0, nv = 0, ni = 0;
      pd.parts.forEach(function (pt) {
        var tex = pt[1]; if (!tiles.has(tex)) return;
        var gr = info.groups[pt[0]], tri = geo.tris[pt[0]].tri, set = geo.sets[gr.rs];
        var used = Array.from(new Set(tri)).sort(function (a, b) { return a - b; }), remap = new Map();
        used.forEach(function (u, i) { remap.set(u, i); });
        Ps.push({ set: set, used: used, rm: pt[3] }); Rs.push(rect(tex)); Ms.push([pt[2], used.length]);
        var I = new Uint32Array(tri.length); for (var i = 0; i < tri.length; i++) I[i] = remap.get(tri[i]) + base;
        Is.push(I); base += used.length; nv += used.length; ni += tri.length;
      });
      if (!Ps.length) return;
      var Pf = new Float32Array(nv * 3), Uf = new Float32Array(nv * 2), Mi = new Int8Array(nv), Ri = new Array(nv), o = 0;
      var U2 = new Float32Array(nv * 2), RM = new Int16Array(nv);   // 19.11: rocks' uv2 and material per vertex (-1: none)
      Ps.forEach(function (ps, pi) {
        var S = ps.set;
        ps.used.forEach(function (u) {
          Pf[o * 3] = S.pos[u * 3]; Pf[o * 3 + 1] = S.pos[u * 3 + 1]; Pf[o * 3 + 2] = S.pos[u * 3 + 2];
          if (S.uv) { Uf[o * 2] = S.uv[u * 2]; Uf[o * 2 + 1] = S.uv[u * 2 + 1]; }
          Mi[o] = Ms[pi][0]; Ri[o] = pi;
          if (ps.rm != null) { U2[o * 2] = S.uv2[u * 2]; U2[o * 2 + 1] = S.uv2[u * 2 + 1]; RM[o] = ps.rm; } else RM[o] = -1;
          o++;
        });
      });
      // np.unique(R, axis=0): the distinct rects sorted by their float32 rows; tile = index into them
      var rk = Rs.map(function (r, i) { return [r, i]; }).sort(function (a, b) { for (var k = 0; k < 4; k++) if (a[0][k] !== b[0][k]) return a[0][k] - b[0][k]; return 0; });
      var rects = [], of = new Array(Rs.length);
      rk.forEach(function (x) { var last = rects[rects.length - 1]; if (!last || last.some(function (v, k) { return v !== x[0][k]; })) rects.push(x[0]); of[x[1]] = rects.length - 1; });
      var tile = rects.length < 256 ? new Uint8Array(nv) : new Uint16Array(nv);
      for (var v = 0; v < nv; v++) tile[v] = of[Ri[v]];
      var q = quant32(Pf, 3, f(1e-4)), qu = quant32(Uf, 2, f(1e-4));
      var I = nv < 65536 ? new Uint16Array(ni) : new Uint32Array(ni), at = 0; Is.forEach(function (x) { I.set(x, at); at += x.length; });
      var mats = new Float32Array(pd.items.length * 12), out = new Uint8Array(pd.items.length), anyOut = false;
      pd.items.forEach(function (it, k) { var t = it[1].t; [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].forEach(function (j, m) { mats[k * 12 + m] = t[j]; }); if (!(ax0 <= t[12] && t[12] <= ax1 && az0 <= t[14] && t[14] <= az1)) { out[k] = 1; anyOut = true; } });
      var parts = pd.vs.split('/');
      var rec = { name: pd.prim.split('/').pop().split('.primitives').join(''), lod: parts[parts.length - 2], lods: pd.tried, n: pd.items.length, nv: nv, nt: ni / 3,
        pmin: q.min, prange: q.range, umin: qu.min, urange: qu.range, p: q.q, uv: qu.q, tile: tile, tile16: rects.length >= 256,
        rects: rects.map(function (r) { return r.map(function (x) { return pyRound(x, 6); }); }), i: I, i32: nv >= 65536, m: mats,
        collision: pd.items.some(function (it) { return !!it[1].havok; }), destructible: pd.d.kind || null };
      if (Mi.some(function (x) { return x !== 0; })) rec.mod = Mi;
      if (pd.ruin) { rec.ruin = 1; stats['scenario ruin models'] = (stats['scenario ruin models'] || 0) + 1; }
      var allRock = nv > 0, anyRock = false;
      for (v = 0; v < nv; v++) { if (RM[v] >= 0) anyRock = true; else allRock = false; }
      if (allRock) {  // a rock: every group drawn by the rock shader
        var q2 = quant32(U2, 2, f(1e-4));
        rec.rock = { uv2: q2.q, u2min: q2.min, u2range: q2.range, mat: Uint8Array.from(RM) };
        stats['rock models'] = (stats['rock models'] || 0) + 1;
      } else if (anyRock) stats['models with rock and other groups (atlas look kept)'] = (stats['models with rock and other groups (atlas look kept)'] || 0) + 1;
      if (anyOut) rec.out = out;
      pd.items.forEach(function (it, k) { index.set(it[0], [recs.length, k]); });
      recs.push(rec);
      stats.models = (stats.models || 0) + 1; stats.instances = (stats.instances || 0) + pd.items.length;
    });
    stats['atlas tiles'] = tiles.size;
    var atl = { w: W, h: H, levels: levels }, rk = rocks.out();
    if (rk) { atl.rocks = rk; stats['rock materials'] = rocks.vecs.length; stats['rock texture layers'] = rk.n; }   // carried with the atlas (the page's buildVisual gets both)
    Object.keys(rocks.stats).forEach(function (k) { stats['rocks: ' + k] = rocks.stats[k]; });
    return { recs: recs, atlas: atl, index: index };
  }
  // u16 over the float32 range (objects_visual: (P - lo) / rng * 65535 in float32, np.round)
  function quant32(a, k, eps) {
    var n = a.length / k, lo = [], hi = [], rng = [], q = new Uint16Array(a.length), c, i;
    for (c = 0; c < k; c++) { lo[c] = Infinity; hi[c] = -Infinity; }
    for (i = 0; i < a.length; i++) { c = i % k; if (a[i] < lo[c]) lo[c] = a[i]; if (a[i] > hi[c]) hi[c] = a[i]; }
    for (c = 0; c < k; c++) rng[c] = Math.max(f(hi[c] - lo[c]), eps);
    for (i = 0; i < a.length; i++) { c = i % k; q[i] = rhe(f(f(f(a[i] - lo[c]) / rng[c]) * 65535)); }
    return { q: q, min: lo, range: rng };
  }
  // build.quant16: the same in float64
  function quant64(a, k) {
    var lo = [], hi = [], rng = [], q = new Uint16Array(a.length), c, i;
    for (c = 0; c < k; c++) { lo[c] = Infinity; hi[c] = -Infinity; }
    for (i = 0; i < a.length; i++) { c = i % k; if (a[i] < lo[c]) lo[c] = a[i]; if (a[i] > hi[c]) hi[c] = a[i]; }
    for (c = 0; c < k; c++) rng[c] = Math.max(hi[c] - lo[c], 1e-6);
    for (i = 0; i < a.length; i++) { c = i % k; q[i] = rhe((a[i] - lo[c]) / rng[c] * 65535); }
    return { q: q, min: lo, range: rng };
  }

  // ---------------------------------------------------------------- statics (build.build_statics, collision records)
  function key2(t, i) { var s = []; for (var k = 0; k < 16; k++) s.push(String(pyRound(t[i * 16 + k], 2))); return s.join(','); }
  function category(path) {
    var p = path.toLowerCase();
    if (p.indexOf('/hd_bld') >= 0 || p.indexOf('/bld') >= 0 || p.indexOf('house') >= 0 || p.indexOf('building') >= 0) return 0;
    if (p.indexOf('rock') >= 0 || p.indexOf('cliff') >= 0 || p.indexOf('stone') >= 0) return 1;
    if (p.indexOf('fence') >= 0 || p.indexOf('wall') >= 0) return 2;
    if (p.indexOf('bridge') >= 0 || p.indexOf('rail') >= 0 || p.indexOf('road') >= 0 || p.indexOf('pier') >= 0) return 3;
    return 4;
  }
  function physicalObjects(S, bit, box) {
    var objs = new Map(), I = S.bsmi, x0 = box[0], z0 = box[1], x1 = box[2], z1 = box[3];
    for (var n = 0; n < I.n; n++) {
      var tx = I.t[n * 16 + 12], tz = I.t[n * 16 + 14];
      if (!((I.vis[n] >>> bit) & 1 && x0 <= tx && tx <= x1 && z0 <= tz && tz <= z1)) continue;
      var m = I.model[n], ph = S.bsmo.prim[m], hh = S.bsmo.havok[m];
      var prim = S.st.has(ph) ? S.st.get(ph) : null, hav = hh ? (S.st.has(hh) ? S.st.get(hh) : null) : null;
      var k0 = prim || hav, ruin = ruinRow(S, n), key = (ruin ? 'ruin|' : '') + String(k0) + '|' + key2(I.t, n);
      var o = objs.get(key);
      if (!o) { o = { havok: null, t: Array.prototype.slice.call(I.t, n * 16, n * 16 + 16), bsmi: [], k0: k0, ruin: ruin }; objs.set(key, o); }
      o.bsmi.push(n);
      if (hav) o.havok = hav;
    }
    return objs;
  }
  function collisionRecords(P, objs, destr, arena, stats) {
    var placed = new Map(), out = [], bsmiObj = new Map();
    objs.forEach(function (o, key) { if (o.havok) { var pk = o.ruin ? o.havok + '|ruin' : o.havok; if (!placed.has(pk)) placed.set(pk, []); placed.get(pk).push([key, o]); } });
    placed.forEach(function (os) {
      var hav = os[0][1].havok;
      var bodies = P.get('hav', hav, null, function (data) { return havokBodies(data, hav); });
      if (!bodies) { stats.missing_havok = (stats.missing_havok || 0) + 1; return; }
      var d = destr[hav.slice(0, hav.lastIndexOf('.')).toLowerCase()] || {}, mods = d.modules || {}, mainT = 0, helpT = 0;
      bodies.forEach(function (b) {
        var fl = b[2];
        if ((fl & HELPER_MASK) || (fl & CAMERA_ONLY) === CAMERA_ONLY) { if (b[1].indexOf('c_') !== 0) helpT += b[3]; return; }
        mainT += b[3];
      });
      if (!mainT && !helpT) return;
      var mats = new Float32Array(os.length * 12), outF = new Uint8Array(os.length), anyOut = false;
      os.forEach(function (x, k) { var t = x[1].t; [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].forEach(function (j, m) { mats[k * 12 + m] = t[j]; }); if (!(arena[0] <= t[12] && t[12] <= arena[2] && arena[1] <= t[14] && t[14] <= arena[3])) { outF[k] = 1; anyOut = true; } });
      var rec = { name: hav.split('/').pop().split('.havok').join(''), cat: category(hav), n: os.length, m: mats, destructible: d.kind || null, modules: Object.keys(mods).length };
      if (os[0][1].ruin) rec.ruin = 1;   // 21.11: a scenario's ruin (shown once its whole-object bit is set)
      if (anyOut) rec.out = outF;
      if (mainT) rec.nt = mainT;
      rec._keys = os.map(function (x) { return x[0]; });
      os.forEach(function (x, k) { x[1].bsmi.forEach(function (n) { bsmiObj.set(n, [out.length, k]); }); });
      out.push(rec);
    });
    return { recs: out, bsmiObj: bsmiObj };
  }

  // ---------------------------------------------------------------- plants (srt_geom, srt_shape, build.plant_kind)
  var FMT_SIZE = [4, 2, 1, 1];
  // srt_geom.find_decls (port-research2/kernels.js, checked equal on 34 files there); run once per kind (Python: 3 times)
  function entryOk(d, p) {
    var un = true;
    for (var i = 0; i < 9; i++) if (d[p + i] !== 255) { un = false; break; }
    if (un) for (i = 9; i < 14; i++) if (d[p + i] !== 0) { un = false; break; }
    if (un) return 2;
    if (d[p] > 3 || d[p + 13] !== 0) return 0;
    for (var k = 0; k < 4; k++) { var a = d[p + 1 + k], c = d[p + 5 + k]; if (a === 255) { if (c !== 255) return 0; } else if (a > 30 || c > 3) return 0; }
    return 1;
  }
  MB.findDecls = function (d) {
    var out = [], p = 0, n = d.length;
    while (p + 238 <= n) {
      var e1 = p + 14;
      if (d[e1 + 1] === 0 && d[e1 + 9] === 0 && entryOk(d, e1) === 1) {
        var all = true, any = false;
        for (var k = 1; k < 16; k++) { var r = entryOk(d, p + 14 * k); if (!r) { all = false; break; } if (r === 2) any = true; }
        if (all && any) { out.push(p); p += 224; continue; }
      }
      p++;
    }
    return out;
  };
  function decl(d, p) {
    var ents = [];
    for (var k = 0; k < 15; k++) {
      var e = p + 14 * k, un = true;
      for (var i = 0; i < 9; i++) if (d[e + i] !== 255) { un = false; break; }
      if (un) for (i = 9; i < 14; i++) if (d[e + i] !== 0) { un = false; break; }
      if (un) continue;
      ents.push({ fmt: d[e], attr: [d[e + 1], d[e + 2], d[e + 3], d[e + 4]], comp: [d[e + 5], d[e + 6], d[e + 7], d[e + 8]], off: [d[e + 9], d[e + 10], d[e + 11], d[e + 12]] });
    }
    return ents;
  }
  function vsize(ents) { var m = 0; ents.forEach(function (e) { for (var k = 0; k < 4; k++) if (e.attr[k] !== 255) m = Math.max(m, e.off[k] + FMT_SIZE[e.fmt]); }); return m; }
  function srtParse(d, ps) {
    var rs = ps.map(function (p) { return decl(d, p + 14); }), last = ps[ps.length - 1] + 238, dv = dvOf(d);
    function zero(a, b) { for (var i = a; i < b; i++) if (d[i]) return false; return true; }
    function rec(q) {
      if (q + 40 > d.length) return null;
      if (!zero(q, q + 8) || !zero(q + 16, q + 24) || !zero(q + 32, q + 40)) return null;
      var ri = dv.getUint32(q + 8, true), nv = dv.getUint32(q + 12, true), ni = dv.getUint32(q + 24, true), b32 = d[q + 28];
      if (ri >= rs.length || !(nv > 0 && nv < 200000) || ni === 0 || ni % 3 || b32 > 1) return null;
      return [ri, nv, ni, b32];
    }
    for (var q = last; q < d.length - 40; q += 4) {
      var chain = [], r = q, x;
      while ((x = rec(r))) { chain.push(x); r += 40; }
      if (!chain.length) continue;
      var p = r, calls = [];
      chain.forEach(function (c) { var st = vsize(rs[c[0]]), isz = c[3] ? 4 : 2, vb = p; p = (p + c[1] * st + 3) & ~3; var ib = p; p = (p + c[2] * isz + 3) & ~3; calls.push({ rs: c[0], nv: c[1], ni: c[2], b32: c[3], vb: vb, ib: ib, stride: st }); });
      if (p > d.length) continue;
      var ok = calls.every(function (c) { var mx = 0; for (var i = 0; i < c.ni; i++) { var v = c.b32 ? dv.getUint32(c.ib + 4 * i, true) : dv.getUint16(c.ib + 2 * i, true); if (v > mx) mx = v; } return mx < c.nv; });
      if (ok) return { rs: rs, calls: calls, rest: d.length - p };
    }
    throw new Error('no draw calls found');
  }
  function h2f(h) { var s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; if (e === 0) return s * m * Math.pow(2, -24); if (e === 31) return m ? NaN : s * Infinity; return s * (1 + m / 1024) * Math.pow(2, e - 15); }
  function prop(d, c, ents, pid, ncol) {  // srt_geom.prop -> Float32Array nv x ncol (the first ncol columns), or null
    var cols = {}, mx = -1;
    ents.forEach(function (e) { for (var k = 0; k < 4; k++) if (e.attr[k] === pid) { cols[e.comp[k]] = [e.fmt, e.off[k]]; mx = Math.max(mx, e.comp[k]); } });
    if (mx < 0) return null;
    var dv = dvOf(d), out = new Float32Array(c.nv * ncol);
    Object.keys(cols).forEach(function (cc) {
      cc = +cc; if (cc >= ncol) return;
      var fm = cols[cc][0], o = cols[cc][1];
      for (var i = 0; i < c.nv; i++) {
        var a = c.vb + i * c.stride + o;
        out[i * ncol + cc] = fm === 1 ? h2f(dv.getUint16(a, true)) : fm === 0 ? dv.getFloat32(a, true) : f(d[a] / 255);
      }
    });
    return out;
  }
  function hyp32(P, k) { var n = P.length / k, out = new Float32Array(n); for (var i = 0; i < n; i++) out[i] = f(Math.hypot(P[i * k], P[i * k + 2])); return out; }
  function srtLastLod(d, R) {
    var lo = Infinity; R.calls.forEach(function (c) { lo = Math.min(lo, c.rs); });
    var start = 0; R.calls.forEach(function (c, i) { if (c.rs === lo) start = i; });
    var out = [];
    R.calls.slice(start).forEach(function (c) {
      var ents = R.rs[c.rs], pos = prop(d, c, ents, 0, 3), uv = prop(d, c, ents, 3, 2) || new Float32Array(c.nv * 2), dv = dvOf(d);
      var hint = ents.some(function (e) { return e.attr.indexOf(2) >= 0; }), idx = new Uint32Array(c.ni);
      for (var i = 0; i < c.ni; i++) idx[i] = c.b32 ? dv.getUint32(c.ib + 4 * i, true) : dv.getUint16(c.ib + 2 * i, true);
      out.push({ part: hint ? 'leaf' : 'bark', pos: pos, uv: uv, idx: idx, nv: c.nv });
    });
    var all = []; out.forEach(function (p) { hyp32(p.pos, 3).forEach(function (v) { all.push(v); }); });
    var crown = Math.max(0.3, pct32(all, 98)), best = null;
    out.forEach(function (p, i) {
      if (p.part === 'leaf' || p.nv >= 200) return;
      var h = hyp32(p.pos, 3), s = 0; for (var k = 0; k < h.length; k++) s += h[k]; var mean = s / h.length;
      if (mean > 0.45 * crown && (!best || mean >= best[0])) best = [mean, i];
    });
    if (best) out[best[1]].part = 'shell';
    return { parts: out, info: { drawCalls: R.calls.length, lastLodCalls: R.calls.length - start, renderStates: R.rs.length, unreadBytes: R.rest } };
  }
  function interp(x, xp, fp) {
    var n = xp.length; if (x <= xp[0]) return x < xp[0] ? fp[0] : fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    var j = 0; while (xp[j + 1] <= x) j++;
    if (xp[j] === x) return fp[j];
    return (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]) * (x - xp[j]) + fp[j];
  }
  var SECT = 8, RINGS = 8, MIN_POINTS = 300, TWO_PI32 = f(2 * Math.PI);
  function hull(pts, lo, hi) {  // srt_shape.hull
    var n = pts.length / 3, ys = [], step = (hi[1] - lo[1]) / (RINGS - 1), k, s, i;
    for (k = 0; k < RINGS; k++) ys.push(k * step + lo[1]); ys[RINGS - 1] = hi[1];
    var r = []; for (k = 0; k < RINGS; k++) { r.push([]); for (s = 0; s < SECT; s++) r[k].push(0); }
    var half = 0.5 * Math.max(hi[0] - lo[0], hi[2] - lo[2]);
    if (n >= MIN_POINTS) {
      var sec = new Int32Array(n), dist = new Float32Array(n);
      for (i = 0; i < n; i++) {
        var dx = pts[i * 3], dz = pts[i * 3 + 2], a = f(Math.atan2(dz, dx)), m = a % TWO_PI32;
        if (m !== 0 && (m < 0) !== (TWO_PI32 < 0)) m = f(m + TWO_PI32); else if (m === 0) m = 0;
        var ang = f(f(m / TWO_PI32) * SECT); sec[i] = Math.min(SECT - 1, Math.trunc(ang)); dist[i] = f(Math.hypot(dx, dz));
      }
      var band = (hi[1] - lo[1]) / (RINGS - 1), ring = [];
      for (k = 0; k < RINGS; k++) {
        var y = ys[k], sel = [], bySec = []; for (s = 0; s < SECT; s++) bySec.push([]);
        for (i = 0; i < n; i++) if (Math.abs(pts[i * 3 + 1] - y) <= band * 0.75) { sel.push(dist[i]); bySec[sec[i]].push(dist[i]); }
        ring.push(sel.length >= 5 ? pct32(sel, 92) : NaN);
        for (s = 0; s < SECT; s++) r[k][s] = bySec[s].length >= 4 ? pct32(bySec[s], 92) : NaN;
      }
      var good = [], gv = []; ring.forEach(function (v, j) { if (isFinite(v)) { good.push(j); gv.push(v); } });
      ring = ring.map(function (v, j) { return good.length ? interp(j, good, gv) : 0; });
      ring[RINGS - 1] = Math.min(ring[RINGS - 1], 0.25 * ring[RINGS - 2]);
      var rmax = -Infinity;
      for (k = 0; k < RINGS; k++) for (s = 0; s < SECT; s++) { var v = isFinite(r[k][s]) ? r[k][s] : ring[k]; v = 0.5 * v + 0.5 * ring[k]; if (k === RINGS - 1) v = ring[k]; r[k][s] = v; }
      for (k = 0; k < RINGS; k++) for (s = 0; s < SECT; s++) if (r[k][s] > rmax) rmax = r[k][s];
      if (rmax > 0) { var fac = Math.min(2.0, Math.max(1.0, half / rmax)); for (k = 0; k < RINGS; k++) for (s = 0; s < SECT; s++) r[k][s] *= fac; }
    } else {
      for (k = 0; k < RINGS; k++) { var fr = (ys[k] - lo[1]) / Math.max(1e-6, hi[1] - lo[1]), val = half * Math.max(0.15, Math.sqrt(Math.max(0.0, 1 - Math.pow((fr - 0.4) / 0.6, 2)))); for (s = 0; s < SECT; s++) r[k][s] = val; }
    }
    for (s = 0; s < SECT; s++) r[0][s] = Math.max(r[0][s], 0.0);
    return { ys: ys, r: r };
  }
  // the kind's own product (no textures, no map-dependent fields): built once per .srt path + CRC
  function kindProduct(d, path) {
    once('srt', path);
    if (!(d[0] === 0x53 && d[1] === 0x52 && d[2] === 0x54 && d[3] === 0x20 && d[4] === 0x30 && d[5] === 0x36 && d[6] === 0x2e)) throw new Error('not SRT 06: ' + path);
    var dv = dvOf(d), a = [0, 1, 2].map(function (k) { return dv.getFloat32(20 + 4 * k, true); }), b = [0, 1, 2].map(function (k) { return dv.getFloat32(32 + 4 * k, true); });
    var lo = a.map(function (v, k) { return Math.min(v, b[k]); }), hi = a.map(function (v, k) { return Math.max(v, b[k]); });
    var ps = MB.findDecls(d), R = srtParse(d, ps), L = srtLastLod(d, R);
    var head = latin(d.subarray(0, ps[0])), names = [], re = /([A-Za-z0-9_\-.]+\.dds)\x00/g, mm;
    while ((mm = re.exec(head))) names.push(mm[1]);
    var am = names.filter(function (n) { return /_AM\.dds$/.test(n) && n.toLowerCase().indexOf('billboard') < 0; });
    var leaf = am.filter(function (n) { return n.toLowerCase().indexOf('bark') < 0; })[0] || am[0] || null, bark = am.filter(function (n) { return n.toLowerCase().indexOf('bark') >= 0; })[0] || null;
    var shells = L.parts.filter(function (p) { return p.part === 'shell'; }).length, parts = L.parts.filter(function (p) { return p.part !== 'shell'; });
    var geo = parts.map(function (p) {
      var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (var i = 0; i < p.nv; i++) { var u = p.uv[i * 2], v = p.uv[i * 2 + 1]; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
      var m1 = f(-0.1), m2 = f(1.1), qp = quant64(p.pos, 3), qu = quant64(p.uv, 2), i32 = p.nv >= 65536, I = i32 ? Uint32Array.from(p.idx) : Uint16Array.from(p.idx);
      return { part: p.part, smallCard: u0 > m1 && u1 < m2 && v0 > m1 && v1 < m2 && p.nv < 64, n: p.nv, i: I, i32: i32, nt: p.idx.length / 3,
        p: qp.q, pmin: qp.min, prange: qp.range, uv: qu.q, uvmin: qu.min, uvrange: qu.range };
    });
    var all = [];
    R.calls.forEach(function (c) { var pp = prop(d, c, R.rs[c.rs], 0, 3); for (var i = 0; i < pp.length; i++) all.push(pp[i]); });
    var H = hull(all, lo, hi), hz = []; parts.forEach(function (p) { hyp32(p.pos, 3).forEach(function (v) { hz.push(v); }); });
    var crown = pct32(hz, 98), r3 = function (v) { return pyRound(v, 3); };
    return { name: path.split('/').pop().split('.srt').join(''), lo: lo.map(r3), hi: hi.map(r3), ys: H.ys.map(r3), r: H.r.map(function (row) { return row.map(r3); }),
      crown: r3(crown), geo: geo, leafName: leaf, barkName: bark, srt: L.info, shellsDropped: shells, tris: geo.reduce(function (s, g) { return s + g.nt; }, 0) };
  }
  // dds.decode: RGBA of the first level no larger than max_size; the average colour as plant_kind computes it
  function plantTexture(data, size, path) {
    once('dds rgba', path + ' ' + size);
    var H = ddsHead(data); if (!H) return null;
    var four = H.four === 'DX10' ? ({ 71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5' })[H.fmt] : H.four, bs = four === 'DXT1' ? 8 : (four === 'DXT3' || four === 'DXT5') ? 16 : 0;
    if (!(H.pf & 4) || !bs) return null;
    var ww = H.w, hh = H.h, p = H.p, P = new Float64Array(12), A = new Float64Array(8);
    for (var l = 0; l < H.mips; l++) {
      var bw = Math.max(1, (ww + 3) >> 2), bh = Math.max(1, (hh + 3) >> 2);
      if (Math.max(ww, hh) <= size || l === H.mips - 1) {
        var w = Math.max(1, ww), h = Math.max(1, hh), img = new Uint8Array(w * h * 4);
        for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++) {
          var q = p + (by * bw + bx) * bs, c = q + bs - 8, four4 = pal(data[c] | data[c + 1] << 8, data[c + 2] | data[c + 3] << 8, P);
          var bits = (data[c + 4] | data[c + 5] << 8 | data[c + 6] << 16 | data[c + 7] << 24) >>> 0, ab = null;
          if (four === 'DXT5') {
            var a0 = data[q], a1 = data[q + 1], big = a0 > a1; A[0] = a0; A[1] = a1;
            for (var i = 1; i < 7; i++) A[1 + i] = big ? ((7 - i) * a0 + i * a1) / 7 : 0;
            if (!big) { for (i = 1; i < 5; i++) A[1 + i] = ((5 - i) * a0 + i * a1) / 5; A[6] = 0; A[7] = 255; }
            ab = [data[q + 2], data[q + 3], data[q + 4], data[q + 5], data[q + 6], data[q + 7]];
          }
          for (var t = 0; t < 16; t++) {
            var y = by * 4 + (t >> 2), x = bx * 4 + (t & 3); if (x >= w || y >= h) continue;
            var ci = (bits >>> (2 * t)) & 3, o = (y * w + x) * 4, al;
            if (four === 'DXT5') { var bit = 3 * t, v = 0; for (var z = 0; z < 3; z++) { var bb = bit + z; v |= ((ab[bb >> 3] >> (bb & 7)) & 1) << z; } al = A[v]; }
            else if (four === 'DXT3') al = ((data[q + (t >> 1)] >> (4 * (t & 1))) & 15) * 17;
            else al = (ci === 3 && !four4) ? 0 : 255;
            img[o] = Math.min(255, Math.max(0, P[ci * 3])); img[o + 1] = Math.min(255, Math.max(0, P[ci * 3 + 1])); img[o + 2] = Math.min(255, Math.max(0, P[ci * 3 + 2])); img[o + 3] = Math.min(255, Math.max(0, al));
          }
        }
        var sr = 0, sg = 0, sb = 0, sa = 0;
        for (i = 0; i < w * h; i++) { var wa = img[i * 4 + 3] / 255.0; sr += img[i * 4] * wa; sg += img[i * 4 + 1] * wa; sb += img[i * 4 + 2] * wa; sa += img[i * 4 + 3]; }
        var den = Math.max(1.0, sa / 255.0);
        return { w: w, h: h, rgba: img, avg: [sr / den, sg / den, sb / den].map(function (c) { return pyRound(c / 255, 3); }) };
      }
      p += bw * bh * bs; ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1);
    }
    return null;
  }
  MB.plantTexture = plantTexture;
  function plants(P, S, box, arena, destr, bush, bit, numbered, stats) {
    var T = S.sptr, kinds = [], kindIndex = {}, groups = new Map(), rows = [], treeRef = new Map(), kindKeys = [];
    for (var n = 0; n < T.n; n++) {
      var x = T.m[n * 16 + 12], z = T.m[n * 16 + 14];
      if (!(box[0] <= x && x <= box[2] && box[1] <= z && z <= box[3])) continue;
      if (!((T.mask[n] >>> bit) & 1)) { stats['not in this gameplay (mask)'] = (stats['not in this gameplay (mask)'] || 0) + 1; continue; }
      var path = S.st.has(T.res[n]) ? S.st.get(T.res[n]) : '?';
      if (!(path in kindIndex)) {
        var k = P.get('kind', path, null, function (d) { return kindProduct(d, path); });
        if (k) {
          var folder = path.slice(0, path.lastIndexOf('/')), tex = {}, texKeys = {};
          [['leaf', k.leafName, 128], ['bark', k.barkName, 64]].forEach(function (x) {
            if (!x[1]) return;
            var tp = folder + '/' + x[1], img = P.get('ptex', tp, x[2], function (data) { return plantTexture(data, x[2], tp); });
            if (img) { tex[x[0]] = { file: x[1], w: img.w, h: img.h, rgba: img.rgba, avg: img.avg }; texKeys[x[0]] = P.key('ptex', tp, x[2]); }
          });
          var dd = destr[path.slice(0, path.lastIndexOf('.')).toLowerCase()] || {};
          var geo = k.geo.map(function (g) {
            var t = (g.part === 'leaf' || tex.bark) ? g.part : 'leaf';
            if (g.part === 'bark' && tex.bark && g.smallCard) t = 'leaf';
            return { part: g.part, tex: t, n: g.n, i: g.i, i32: g.i32, nt: g.nt, p: g.p, pmin: g.pmin, prange: g.prange, uv: g.uv, uvmin: g.uvmin, uvrange: g.uvrange };
          });
          kindIndex[path] = kinds.length;
          kinds.push({ name: k.name, path: path, lo: k.lo, hi: k.hi, ys: k.ys, r: k.r, crown: k.crown, geo: geo, tex: tex, inBushesXml: bush.indexOf(k.name.toLowerCase()) >= 0,
            density: dd.density == null ? null : dd.density, destructible: dd.kind || null, srt: k.srt, shellsDropped: k.shellsDropped, tris: k.tris });
          kindKeys.push({ kind: P.key('kind', path), tex: texKeys });
        } else kindIndex[path] = null;
      }
      var ki = kindIndex[path];
      if (ki == null) { stats['kind unreadable'] = (stats['kind unreadable'] || 0) + 1; continue; }
      var kk = kinds[ki], cls = kk.inBushesXml ? 'bush' : (numbered.has(n) ? 'tree' : 'fixed');
      var outside = !(arena[0] <= x && x <= arena[2] && arena[1] <= z && z <= arena[3]), gk = ki + '|' + cls + '|' + outside;
      if (!groups.has(gk)) { groups.set(gk, { kind: ki, cls: cls, outside: outside, g: groups.size }); rows.push([]); }
      var g = groups.get(gk).g;
      treeRef.set(n, [g, rows[g].length]);
      var m = T.m, o = n * 16; rows[g].push([m[o], m[o + 1], m[o + 2], m[o + 4], m[o + 5], m[o + 6], m[o + 8], m[o + 9], m[o + 10], x, m[o + 13], z]);
      var sk = cls + ' ' + (outside ? 'outside' : 'inside'); stats[sk] = (stats[sk] || 0) + 1;
    }
    var out = [];
    groups.forEach(function (G) { var r = rows[G.g], a = new Float32Array(r.length * 12); r.forEach(function (row, j) { a.set(row, j * 12); }); out.push({ kind: G.kind, cls: G.cls, outside: G.outside, n: r.length, m: a }); });
    kinds.forEach(function (k, ki) { k.count = {}; ['tree', 'bush', 'fixed'].forEach(function (c) { k.count[c] = out.reduce(function (s, o) { return s + (o.kind === ki && o.cls === c ? o.n : 0); }, 0); }); });
    return { trees: { kinds: kinds, groups: out, stats: stats }, treeRef: treeRef, kindKeys: kindKeys };
  }

  // ---------------------------------------------------------------- the objects, plants and lookup of one gameplay
  MB.buildObjects = function (raw, opts, box, arenaBox, bit, times) {
    var P = new Products(raw, opts.cache), t = now();
    var S = { st: strings(raw.get('space.bin/BWST')), bsmi: bsmi(raw.get('space.bin/BSMI')), bsmo: bsmo(raw.get('space.bin/BSMO')), sptr: sptr(raw.get('space.bin/SpTr')) };
    scenarioRows(raw, S);
    var W = wgde(raw.get('space.bin/WGDE'));
    var destr = P.get('destr', 'scripts/destructibles.xml', null, function (d) { return destructibles(d); }) || {};
    var bush = P.get('bush', 'vegetation/bushes.xml', null, function (d) { return bushNames(d); }) || [];
    times.spaceAndTables = now() - t; t = now();
    var objs = physicalObjects(S, bit, box), ostats = {}, vstats = {};
    times.physicalObjects = now() - t; t = now();
    var col = collisionRecords(P, objs, destr, arenaBox, ostats);
    times.havok = now() - t; t = now();
    var vis = visualModels(P, objs, destr, arenaBox, vstats);
    times.visual = now() - t; t = now();
    var link = { linked: 0, 'not linked': 0 };
    col.recs.forEach(function (rec) {
      var refs = rec._keys.map(function (k) { return vis.index.get(k) || null; }); delete rec._keys;
      if (refs.length && refs.every(function (r) { return r; }) && new Set(refs.map(function (r) { return r[0]; })).size === 1) {
        rec.vis = refs[0][0]; rec.visK = Uint16Array.from(refs.map(function (r) { return r[1]; })); delete rec.m; delete rec.out; link.linked++;
      } else link['not linked']++;
    });
    vstats['collision records linked to a visual'] = link;
    var numbered = new Set(); MB.wgdeTable(W).forEach(function (members) { members.forEach(function (x) { if (x & 0x80000000) numbered.add(x & 0x7fffffff); }); });
    var pl = plants(P, S, box, arenaBox, destr, bush, bit, numbered, {});
    times.plants = now() - t; t = now();
    var bs = [], tr = [];
    Array.from(col.bsmiObj.keys()).sort(function (a, b) { return a - b; }).forEach(function (n) { var r = col.bsmiObj.get(n); bs.push(n, r[0], r[1]); });
    Array.from(pl.treeRef.keys()).sort(function (a, b) { return a - b; }).forEach(function (n) { var r = pl.treeRef.get(n); tr.push(n, r[0], r[1]); });
    var lookup = { visibilityBit: bit, objects: col.recs.length, groups: pl.trees.groups.length, groupCls: pl.trees.groups.map(function (g) { return g.cls; }), bsmi: Int32Array.from(bs), tree: Int32Array.from(tr), wgde: W,
      scenario: scenarioLookup(S, objs, col, vis) };
    // the placements the light map's footprints and the minimap white balance read (light5c.masks, ground5.fit_to_minimap)
    var placements = { kinds: pl.trees.kinds.map(function (k) { return k.crown; }), groups: pl.trees.groups.map(function (g) { return { kind: g.kind, m: g.m }; }),
      visual: vis.recs.map(function (r) { return { name: r.name, pmin: r.pmin, prange: r.prange, m: r.m }; }) };
    times.lookup = now() - t;
    return { objects: col.recs, visual: vis.recs, atlas: vis.atlas, visualStats: vstats, collisionStats: ostats, trees: pl.trees, kindKeys: pl.kindKeys, lookup: lookup, placements: placements };
  };
  // build.build_destruction with the map's lookup: destroyed items [t, initial, chunk id, kind, tuple] -> page events;
  // 21.11: and the scenarios' switches (`scenario`: battle.js's [t, initial, entity name, 'create' | 'leave' | 'start'])
  // as the same whole-object events (type 1; ev[5] 1 = a scenario's collision record, 2 = its visual record)
  MB.destruction = function (destroyed, lookup, scenario) {
    var table = MB.wgdeTable(lookup.wgde), bo = new Map(), tref = new Map(), ev = [], st = {}, i;
    for (i = 0; i < lookup.bsmi.length; i += 3) bo.set(lookup.bsmi[i], [lookup.bsmi[i + 1], lookup.bsmi[i + 2]]);
    for (i = 0; i < lookup.tree.length; i += 3) tref.set(lookup.tree[i], [lookup.tree[i + 1], lookup.tree[i + 2]]);
    var inc = function (k) { st[k] = (st[k] || 0) + 1; }, r3 = function (v) { return pyRound(v, 3); };
    destroyed.forEach(function (d) {
      var t = d[0], initial = d[1] ? 1 : 0, cid = d[2], kind = d[3], tup = d[4], members = table.get(cid * 65536 + (tup[0] << 8 | tup[1]));
      if (!members || !members.length) { inc('unresolved'); return; }
      var tree = members.filter(function (m) { return m & 0x80000000; }).map(function (m) { return m & 0x7fffffff; }), mods = members.filter(function (m) { return !(m & 0x80000000); });
      var yaw = (kind === 'fallenTrees' ? tup[4] : tup[2]) / 256.0 * 2 * Math.PI - Math.PI;
      if (tree.length) {
        var ref = tref.get(tree[0]); if (!ref) { inc('tree outside the page'); return; }
        if (lookup.groupCls[ref[0]] !== 'tree') { ev.push([r3(t), initial, 4, ref[0], ref[1], 0]); inc('bush off'); }
        else { ev.push([r3(t), initial, 3, ref[0], ref[1], r3(yaw)]); inc('tree falls'); }
        return;
      }
      var r = null; for (var q = 0; q < mods.length && !r; q++) r = bo.get(mods[q]) || null;
      if (!r) { inc('object outside the page or without collision'); return; }
      if (kind === 'destroyedModules') { var k = (tup[2] >> 1) - FIRST_MODULE_KIND; if (k >= 0 && k < MAX_MODULES) { ev.push([r3(t), initial, 0, r[0], r[1], k]); inc('module'); } else inc('module out of range'); }
      else if (kind === 'destroyedFragiles') { ev.push([r3(t), initial, 1, r[0], r[1], 0]); inc('fragile'); }
      else { ev.push([r3(t), initial, 2, r[0], r[1], r3(yaw)]); inc('object falls'); }
    });
    scenarioSwitches(scenario || [], lookup.scenario || []).forEach(function (sw) {
      if (sw.t === null) { inc('scenario part standing'); return; }
      inc('scenario part switched');
      [sw.part.normal, sw.part.ruin, sw.part.floor].forEach(function (a) { for (var q = 0; q < a.length; q += 3) ev.push([r3(sw.t), sw.initial, 1, a[q + 1], a[q + 2], a[q]]); });
    });
    ev.sort(function (a, b) { for (var k = 0; k < 6; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; });
    return { events: ev, stats: st };
  };
  // A part switches - standing hidden, ruin shown, its floor objects hidden - when its standing state entity leaves
  // after a scenario started (SequenceNetworkSync.state >= 1), or, failing that, when its ruin state entity appears
  // (the owner's choice 21.11: no gap while the game plays the collapse). A part with neither stays standing (t null).
  function scenarioSwitches(records, parts) {
    var start = Infinity;
    records.forEach(function (r) { if (r[3] === 'start' && r[0] < start) start = r[0]; });
    return parts.map(function (p) {
      var t = null, initial = 0;
      records.forEach(function (r) {
        var hit = (r[3] === 'leave' && r[0] >= start && p.normalNames.indexOf(r[2]) >= 0) || (r[3] === 'create' && p.ruinNames.indexOf(r[2]) >= 0);
        if (hit && (t === null || r[0] < t)) { t = r[0]; initial = r[1] ? 1 : 0; }
      });
      return { part: p, t: t, initial: initial };
    });
  }
  MB.scenarioSwitches = scenarioSwitches;
  // the map record keeps its plant kinds as references to their own products (shared by every map): strip / hydrate
  MB.stripKinds = function (kinds, kindKeys) {
    return kinds.map(function (k, i) {
      var s = Object.assign({}, k, { kindKey: kindKeys[i].kind, texKeys: kindKeys[i].tex, tex: {} });
      s.geo = k.geo.map(function (g) { var c = Object.assign({}, g); delete c.p; delete c.uv; delete c.i; return c; });
      Object.keys(k.tex).forEach(function (t) { var c = Object.assign({}, k.tex[t]); delete c.rgba; s.tex[t] = c; });
      return s;
    });
  };
  MB.kindRecordKeys = function (stubs) { var out = []; stubs.forEach(function (s) { out.push(s.kindKey); Object.keys(s.texKeys).forEach(function (t) { out.push(s.texKeys[t]); }); }); return out; };
  MB.hydrateKinds = function (stubs, rec) {
    return stubs.map(function (s) {
      var kp = rec[s.kindKey], k = Object.assign({}, s, { tex: {} });
      if (!kp) throw new Error('plant kind product missing: ' + s.kindKey);
      k.geo = s.geo.map(function (g, i) { return Object.assign({}, g, { p: kp.geo[i].p, uv: kp.geo[i].uv, i: kp.geo[i].i }); });
      Object.keys(s.tex).forEach(function (t) { var tp = rec[s.texKeys[t]]; if (!tp) throw new Error('plant texture product missing: ' + s.texKeys[t]); k.tex[t] = Object.assign({}, s.tex[t], { rgba: tp.rgba }); });
      delete k.kindKey; delete k.texKeys;
      return k;
    });
  };
  // which maps have a minimap that is a rendered top view (build.MAPS minimapRendered; every map built from a replay: False)
  MB.MINIMAP_RENDERED = { '05_prohorovka': true };
})(typeof globalThis !== 'undefined' ? globalThis : this);
