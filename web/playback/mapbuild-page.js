/* Bullba Hits' 3D replay player (BACKLOG 104): the page side of the map builder (ported from the trial's
   work/map-playback/mapbuild-page.js). MapBuildPage.obtain(o) -> Promise<{arena, map, info}>:
     1. IndexedDB 'bullba-map-build' has the map built before for this arena, gameplay and client (record 'built|<arena>|
        <gameplay>': the keys and the client version it was built under) -> the arena and map records are the result; the
        map's plant kinds and their textures are records of their own (shared by every map), read by the keys the map
        lists. Nothing is asked of the mod and no raw file is read (19.11).
     2. else the mod's raw set: in the game, o.ask({arena, held, resv}) asks the mod for it ('mapRaw') and resolves when the
        mod says it is ready - `held` the digest of the builder's products this IndexedDB holds (FNV-1a of each key), so
        the mod leaves out the resources they cover; outside the game the files must be there. <rawRoot><arena>/
        manifest.js (a classic script the mod's map_raw.py writes: names, sizes, the source entries' zip CRCs, every
        resource with its part) gives the keys; a map stored under them is the result (and gets its 'built|' record);
     3. else a classic blob worker loads mapbuild.js + mapbuild9.js (from o.builderBase), the part scripts of the arena's own
        inputs and, when the builder first needs one of its resources, that resource's part, with importScripts (file://
        works there; fetch / XHR and new Worker(file) are blocked in CEF 109); the worker builds what is missing, stores it,
        posts it back. A build that needed a resource held back (or a LOD the mod copied in part) asks the mod once more for
        the whole set (o.ask({..., whole: true})) and builds again.
   The main thread only waits: the build never runs on it. o: {arena, gameplay, minimapFit, rawRoot, builderBase, client,
   ask, progress(text)}. MapBuildPage.manifest(arena, rawRoot) -> Promise: the arena's manifest loaded. */
(function () {
  'use strict';
  var DB = 'bullba-map-build', STORE = 'products', MAP_RECORDS = /^(arena|relief|fit|map|built)\|/;
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
  function put(db, key, value) {
    return new Promise(function (ok, fail) {
      var tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(value, key);
      tx.oncomplete = ok; tx.onerror = function () { fail(tx.error); };
    });
  }
  // the builder's per-resource products this IndexedDB holds: base64 of their keys' FNV-1a hashes (u32 little-endian)
  function heldDigest(db) {
    return new Promise(function (ok, fail) {
      var r = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      r.onsuccess = function () {
        var keys = r.result.filter(function (k) { return typeof k === 'string' && !MAP_RECORDS.test(k); });
        var u = new Uint32Array(keys.map(function (k) { return MapBuild.fnv(k); })), b = new Uint8Array(u.buffer), bin = '';
        for (var i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
        ok({ held: btoa(bin), count: keys.length });
      };
      r.onerror = function () { fail(r.error); };
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
        var loaded = {}, resMs = 0;
        function part(i) { if (!loaded[i]) { loaded[i] = true; importScripts(d.rawBase + d.manifest.parts[i]); } }
        raw.loadRes = function (en) { var q = performance.now(); part(en.part); resMs += performance.now() - q; };
        d.manifest.files.forEach(function (f) { part(f.part); });
        T.loadRawScripts = performance.now() - t; t = performance.now();
        var db = await idb(), pkeys = MapBuild.productKeys(d.manifest);
        var have = await getAll(db, [d.keys.arena, d.keys.fit].concat(pkeys));
        T.idbReadHave = performance.now() - t; T.productKeys = pkeys.length; t = performance.now();
        var newProducts = [];
        var cache = { get: function (k) { return have[k]; }, put: function (k, v) { have[k] = v; newProducts.push(k); } };
        MapBuild.resetCounts();
        var res = await MapBuild.build(raw, { gameplay: d.gameplay, minimapFit: d.minimapFit, cache: cache,
          have: { arena: have[d.keys.arena] || null, relief: have[d.keys.relief] || null, fit: have[d.keys.fit] || null } });
        T.build = performance.now() - t - resMs; T.resScriptsLoad = resMs; t = performance.now();
        var rawDecodedTwice = Object.keys(MapBuild.counts.rawDecoded).filter(function (k) { return MapBuild.counts.rawDecoded[k] > 1; });
        var stored = Object.assign({}, res.map, { trees: Object.assign({}, res.map.trees, { kinds: MapBuild.stripKinds(res.map.trees.kinds, res.kindKeys) }) });
        await new Promise(function (ok, fail) {
          var tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
          if (!have[d.keys.arena]) st.put(res.arena, d.keys.arena);
          // 19.11: the relief terms (19.6 MB an arena, ~0.2 s to compute) are not kept - only a second gameplay of the
          // arena would read them, and it computes them again; the ones an older build kept go
          st.delete(IDBKeyRange.bound('relief|', 'relief|￿'));
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
            resHeld: (d.manifest.res || []).filter(function (x) { return x.held; }).length, partsLoaded: Object.keys(loaded).length, parts: d.manifest.parts.length,
            parsed: parsed, stages: MapBuild.counts.stages, productsBuilt: MapBuild.counts.cacheBuilt, productsReused: MapBuild.counts.cacheHit } }, Array.from(tr));
      } catch (err) { self.postMessage({ error: String(err && err.stack || err), heldMissing: !!(err && err.heldMissing) }); }
    };
  }
  // the raw set's format the builder reads (map_raw.MANIFEST_VERSION): an older set on disk is the one the mod is copying
  // again - read meanwhile (the page's look while it waits), it would be built from the old files
  var RAW_VERSION = 4;   // 4 (21.11): the map's scenarios (scenario.json)
  var manifests = {};
  window.MapRaw = { manifest: function (m) { manifests[m.arena] = m; }, put: function () {} };
  function manifest(arena, rawRoot) {
    delete manifests[arena];
    return script(new URL(rawRoot, base).href + arena + '/manifest.js?read=' + Date.now()).then(function () {
      if (!manifests[arena] || manifests[arena].version !== RAW_VERSION) throw new Error('the map files of ' + arena + ' are not readable');
      return manifests[arena];
    });
  }
  function hydrated(db, M) {
    return getAll(db, MapBuild.kindRecordKeys(M.trees.kinds)).then(function (rec) { M.trees.kinds = MapBuild.hydrateKinds(M.trees.kinds, rec); return Object.keys(rec).length; });
  }
  function build(o, man, keys) {
    var rawBase = new URL(o.rawRoot, base).href + o.arena + '/', builder = new URL(o.builderBase, base).href;
    var url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')();'], { type: 'text/javascript' }));
    var w = new Worker(url);
    window.__mapWorker = { started: performance.now() };
    return new Promise(function (ok, fail) {
      w.onmessage = function (e) { ok(e.data); }; w.onerror = function (e) { fail(new Error('map build worker: ' + (e.message || e))); };
      w.postMessage({ base: builder, rawBase: rawBase, manifest: man, keys: keys, gameplay: o.gameplay, minimapFit: !!o.minimapFit });
    }).then(function (r) { w.terminate(); URL.revokeObjectURL(url); window.__mapWorker.done = performance.now(); return r; });
  }
  window.MapBuildPage = {
    manifest: manifest,
    heldDigest: function () { return idb().then(heldDigest); },
    obtain: async function (o) {
      var T = { waitMod: 0 }, t = performance.now(), t0 = t, progress = o.progress || function () {};
      var db = await idb(), builtKey = 'built|' + o.arena + '|' + o.gameplay;
      // 1. built before under this client: no raw file, no word to the mod
      var rec = o.client ? (await getAll(db, [builtKey]))[builtKey] : null;
      // 21.11: the record also names the builder it was made by - a newer builder (new kinds of objects) never reuses an
      // older builder's map (1.24: the scenario buildings were not drawn, the map of 1.23 came from here)
      if (rec && rec.client === o.client && rec.builder === MapBuild.VERSION) {
        var g = await getAll(db, [rec.keys.arena, rec.keys.map]);
        if (g[rec.keys.arena] && g[rec.keys.map]) {
          var n = await hydrated(db, g[rec.keys.map]);
          T.idbRead = performance.now() - t; T.total = performance.now() - t0;
          return { arena: g[rec.keys.arena], map: g[rec.keys.map], info: { source: 'IndexedDB', keys: rec.keys, builtAt: rec.builtAt, times: T, kindRecords: n } };
        }
      }
      async function raw(whole) {
        if (o.ask) {
          progress('Asking the game for the map files...');
          var q = performance.now(), dg = whole ? null : await heldDigest(db);
          await o.ask(whole ? { arena: o.arena, whole: true } : { arena: o.arena, held: dg.held, resv: MapBuild.RESV });
          T.waitMod += performance.now() - q;
        }
        return manifest(o.arena, o.rawRoot);
      }
      var man = await raw(false), keys = MapBuild.keys(man, o.gameplay);
      T.manifestAndKeys = performance.now() - t; t = performance.now();
      // 2. stored under the raw set's keys (built before this record existed, or under another client's record)
      var got = await getAll(db, [keys.arena, keys.map]);
      if (got[keys.arena] && got[keys.map]) {
        var kr = await hydrated(db, got[keys.map]);
        await put(db, builtKey, { keys: keys, client: o.client || null, builder: MapBuild.VERSION, builtAt: Date.now() });
        T.idbRead = performance.now() - t; T.total = performance.now() - t0;
        return { arena: got[keys.arena], map: got[keys.map], info: { source: 'IndexedDB', keys: keys, times: T, kindRecords: kr } };
      }
      T.idbRead = performance.now() - t; t = performance.now();
      // 3. built here; once more from the whole set when it needed what was held back
      progress('Building the map...');
      var r = await build(o, man, keys);
      if (r.error && r.heldMissing && o.ask) {
        man = await raw(true); keys = MapBuild.keys(man, o.gameplay);
        progress('Building the map...');
        r = await build(o, man, keys); T.rebuiltWhole = true;
      }
      if (r.error) throw new Error('map build: ' + r.error);
      var builtAt = Date.now();
      await put(db, builtKey, { keys: keys, client: o.client || null, builder: MapBuild.VERSION, builtAt: builtAt });
      T.worker = performance.now() - t; T.total = performance.now() - t0;
      return { arena: r.arena, map: r.map, info: { source: 'built', keys: keys, builtAt: builtAt, times: T, worker: r.times, build: r.buildTimes, built: r.built, counts: r.counts } };
    }
  };
})();
