/* Bullba Hits' 3D replay player (BACKLOG 104): the page side of the map builder (ported from the trial's
   work/map-playback/mapbuild-page.js). MapBuildPage.obtain(o) -> Promise<{arena, map, info}>:
     1. <rawRoot><arena>/manifest.js (a classic script the mod's map_raw.py writes: names, sizes, the source entries' zip
        CRCs, the shared resources <rawRoot>res/<crc>-...js the map reads) gives the keys;
     2. IndexedDB 'bullba-map-build' has the arena and map records -> they are the result (a map built before); the map's
        plant kinds and their textures are records of their own (shared by every map), read by the keys the map lists;
     3. else a classic blob worker loads mapbuild.js + mapbuild9.js (from o.builderBase) and the arena's raw part scripts
        with importScripts (file:// works there; fetch / XHR and new Worker(file) are blocked in CEF 109); a shared
        resource's script is loaded only when its product (plant kind, visual LOD, texture, havok bodies ...) is not in
        IndexedDB yet; the worker builds what is missing, stores it, posts it back.
   The main thread only waits: the build never runs on it. o: {arena, gameplay, minimapFit, rawRoot, builderBase}.
   MapBuildPage.manifest(arena, rawRoot) -> Promise: the arena's manifest loaded (rejects when its raw set is missing). */
(function () {
  'use strict';
  var DB = 'bullba-map-build', STORE = 'products';
  var base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  function idb() {
    return new Promise(function (ok, fail) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { fail(r.error); };
    });
  }
  function getAll(db, keys) {
    return new Promise(function (ok, fail) {
      var tx = db.transaction(STORE, 'readonly'), st = tx.objectStore(STORE), out = {};
      keys.forEach(function (k) { var r = st.get(k); r.onsuccess = function () { if (r.result !== undefined) out[k] = r.result; }; });
      tx.oncomplete = function () { ok(out); }; tx.onerror = function () { fail(tx.error); };
    });
  }
  function script(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script'); s.src = src; s.onload = function () { s.remove(); ok(); };
      s.onerror = function () { fail(new Error('cannot load ' + src)); }; document.head.appendChild(s);
    });
  }
  // the worker: everything heavy happens here (base64 decode, inflate, parsing, grids, blurs, the IndexedDB writes)
  function workerMain() {
    var DB = 'bullba-map-build', STORE = 'products';
    function idb() { return new Promise(function (ok, fail) { var r = indexedDB.open(DB, 1); r.onupgradeneeded = function () { r.result.createObjectStore(STORE); }; r.onsuccess = function () { ok(r.result); }; r.onerror = function () { fail(r.error); }; }); }
    function getAll(db, keys) { return new Promise(function (ok, fail) { var tx = db.transaction(STORE, 'readonly'), st = tx.objectStore(STORE), out = {}; keys.forEach(function (k) { var r = st.get(k); r.onsuccess = function () { if (r.result !== undefined) out[k] = r.result; }; }); tx.oncomplete = function () { ok(out); }; tx.onerror = function () { fail(tx.error); }; }); }
    function buffers(v, set, seen) {  // every ArrayBuffer reachable from v (transferred, not copied)
      if (!v || typeof v !== 'object' || seen.has(v)) return; seen.add(v);
      if (ArrayBuffer.isView(v)) { set.add(v.buffer); return; }
      Object.keys(v).forEach(function (k) { buffers(v[k], set, seen); });
    }
    self.onmessage = async function (e) {
      var d = e.data, T = {}, t = performance.now(), t0 = t;
      try {
        importScripts(d.base + 'mapbuild.js', d.base + 'mapbuild9.js'); T.loadBuilder = performance.now() - t; t = performance.now();
        var raw = new MapBuild.Raw(); raw.manifest = d.manifest;
        self.MapRaw = { put: function (n, s) { raw.put(n, s); }, manifest: function () {} };
        var resMs = 0;
        raw.loadRes = function (en) { var q = performance.now(); importScripts(d.rawBase + d.manifest.resDir + en.file); resMs += performance.now() - q; };
        d.manifest.parts.forEach(function (p) { importScripts(d.rawBase + p); });
        T.loadRawScripts = performance.now() - t; t = performance.now();
        var db = await idb(), pkeys = MapBuild.productKeys(d.manifest);
        var have = await getAll(db, [d.keys.arena, d.keys.relief, d.keys.fit].concat(pkeys));
        T.idbReadHave = performance.now() - t; T.productKeys = pkeys.length; t = performance.now();
        var newProducts = [];
        var cache = { get: function (k) { return have[k]; }, put: function (k, v) { have[k] = v; newProducts.push(k); } };
        MapBuild.resetCounts();
        var res = await MapBuild.build(raw, { gameplay: d.gameplay, minimapFit: d.minimapFit, cache: cache,
          have: { arena: have[d.keys.arena] || null, relief: have[d.keys.relief] || null, fit: have[d.keys.fit] || null } });
        T.build = performance.now() - t; T.resScriptsLoad = resMs; t = performance.now();
        var rawDecodedTwice = Object.keys(MapBuild.counts.rawDecoded).filter(function (k) { return MapBuild.counts.rawDecoded[k] > 1; });
        var stored = Object.assign({}, res.map, { trees: Object.assign({}, res.map.trees, { kinds: MapBuild.stripKinds(res.map.trees.kinds, res.kindKeys) }) });
        await new Promise(function (ok, fail) {
          var tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
          if (!have[d.keys.arena]) st.put(res.arena, d.keys.arena);
          if (res.relief) st.put(res.relief, d.keys.relief);
          if (res.fit) st.put(res.fit, d.keys.fit);
          newProducts.forEach(function (k) { st.put(have[k], k); });
          st.put(stored, d.keys.map);
          tx.oncomplete = ok; tx.onerror = function () { fail(tx.error); };
        });
        T.idbWrite = performance.now() - t; T.productsWritten = newProducts.length; T.workerTotal = performance.now() - t0;
        var tr = new Set(); buffers({ a: res.arena, m: res.map }, tr, new Set());
        var parsed = {}; Object.keys(MapBuild.counts.parsed).forEach(function (k) { var m = MapBuild.counts.parsed[k], v = Object.keys(m).map(function (n) { return m[n]; }); parsed[k] = { files: v.length, maxTimes: Math.max.apply(null, v) }; });
        self.postMessage({ arena: res.arena, map: res.map, times: T, buildTimes: res.times, built: { arena: !have[d.keys.arena], relief: !!res.relief, fit: !!res.fit, map: true },
          counts: { rawDecoded: Object.keys(MapBuild.counts.rawDecoded).length, rawDecodedTwice: rawDecodedTwice, resScriptsLoaded: MapBuild.counts.resLoaded, resInManifest: (d.manifest.res || []).length,
            parsed: parsed, stages: MapBuild.counts.stages, productsBuilt: MapBuild.counts.cacheBuilt, productsReused: MapBuild.counts.cacheHit } }, Array.from(tr));
      } catch (err) { self.postMessage({ error: String(err && err.stack || err) }); }
    };
  }
  var manifests = {};
  window.MapRaw = { manifest: function (m) { manifests[m.arena] = m; }, put: function () {} };
  function manifest(arena, rawRoot) {
    delete manifests[arena];
    return script(new URL(rawRoot, base).href + arena + '/manifest.js?read=' + Date.now()).then(function () {
      if (!manifests[arena]) throw new Error('the map files of ' + arena + ' are not readable');
      return manifests[arena];
    });
  }
  window.MapBuildPage = {
    manifest: manifest,
    obtain: async function (o) {
      var T = {}, t = performance.now(), t0 = t, rawBase = new URL(o.rawRoot, base).href + o.arena + '/', builder = new URL(o.builderBase, base).href;
      var man = await manifest(o.arena, o.rawRoot);
      var keys = MapBuild.keys(man, o.gameplay);
      T.manifestAndKeys = performance.now() - t; t = performance.now();
      var db = await idb(), got = await getAll(db, [keys.arena, keys.map]);
      if (got[keys.arena] && got[keys.map]) {
        var M = got[keys.map], rec = await getAll(db, MapBuild.kindRecordKeys(M.trees.kinds));
        M.trees.kinds = MapBuild.hydrateKinds(M.trees.kinds, rec);
        T.idbRead = performance.now() - t; T.total = performance.now() - t0;
        return { arena: got[keys.arena], map: M, info: { source: 'IndexedDB', keys: keys, times: T, kindRecords: Object.keys(rec).length } };
      }
      T.idbRead = performance.now() - t; t = performance.now();
      var url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')();'], { type: 'text/javascript' }));
      var w = new Worker(url), ticks = 0, tick = setInterval(function () { ticks++; }, 16);
      window.__mapWorker = { started: performance.now() };
      var r = await new Promise(function (ok, fail) {
        w.onmessage = function (e) { ok(e.data); }; w.onerror = function (e) { fail(new Error('map build worker: ' + (e.message || e))); };
        w.postMessage({ base: builder, rawBase: rawBase, manifest: man, keys: keys, gameplay: o.gameplay, minimapFit: !!o.minimapFit });
      });
      clearInterval(tick); w.terminate(); URL.revokeObjectURL(url); window.__mapWorker.done = performance.now();
      if (r.error) throw new Error('map build: ' + r.error);
      T.worker = performance.now() - t; T.total = performance.now() - t0;
      // the main thread's 16 ms timer kept firing during the build: the page stayed responsive
      return { arena: r.arena, map: r.map, info: { source: 'built', keys: keys, times: T, worker: r.times, build: r.buildTimes, built: r.built, counts: r.counts, mainThreadTicks: ticks, expectedTicks: Math.floor(T.worker / 16) } };
    }
  };
})();
