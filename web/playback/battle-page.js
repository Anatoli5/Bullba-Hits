/* Bullba Hits' 3D replay player (19.11.2026): the page side of the battle builder (battle.js), as mapbuild-page.js is the
   map's. BattlePage.obtain(o) -> Promise<{battle, info, effects}>; o: {info (data/playback/<id>.js, the mod's playback.py),
   dataBase (the URL of data/), builderBase (of web/playback/)}:
     1. IndexedDB 'bullba-playback' has the battle under its id with the same source (size, CRC) and builder format -> it
        is the result, hits included (effects is null): nothing else is read and the mod is asked for nothing;
     2. else a classic blob worker loads decoder.js + battle.js and, with importScripts (file:// works there; fetch / XHR
        are blocked in CEF 109), the client's definitions file and the battle's source file the mod wrote; it decrypts or
        inflates the source, decodes it, builds the battle and posts it; effects(docs) - docs[type] = {veh, models}, the
        page's own vehicle and model files - places the hit points there, keeps the whole battle in IndexedDB and
        resolves with the hits, marks and muzzles (also put on `battle`).
   A source or definitions file that cannot be read rejects with err.missing = true (the mod writes them again). */
(function () {
  'use strict';
  var DB = 'bullba-playback', STORE = 'battles';
  var base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  function idb() {
    return new Promise(function (ok, fail) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { fail(r.error); };
    });
  }
  function get(db, key) {
    return new Promise(function (ok, fail) {
      var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { fail(r.error); };
    });
  }
  function workerMain() {
    var DB = 'bullba-playback', STORE = 'battles', got = {}, state = null;
    self.ArmorInspectorData = { receive: function (pair) { got[pair[0]] = pair[1]; } };
    function idb() { return new Promise(function (ok, fail) { var r = indexedDB.open(DB, 1); r.onupgradeneeded = function () { r.result.createObjectStore(STORE); }; r.onsuccess = function () { ok(r.result); }; r.onerror = function () { fail(r.error); }; }); }
    function data(url, key) {
      try { importScripts(url); } catch (e) { var err = new Error('cannot read ' + url); err.missing = true; throw err; }
      if (!(key in got)) { var err2 = new Error('not a data file: ' + url); err2.missing = true; throw err2; }
      var v = got[key]; delete got[key]; return v;
    }
    self.onmessage = async function (e) {
      var d = e.data, T = {}, t = performance.now();
      try {
        if (d.cmd === 'build') {
          importScripts(d.base + 'decoder.js', d.base + 'battle.js');
          var info = d.info;
          var defs = data(d.dataBase + 'playback/' + info.defs + '.js', 'playback-defs:' + info.defs);
          var src = data(d.dataBase + 'playback/' + info.source.file, 'playback-source:' + info.id);
          T.load = performance.now() - t; t = performance.now();
          var bytes = PlaybackBattle.unb64(src); src = null;
          var stream = await PlaybackBattle.source(info.source.kind, bytes, info.id);
          T.source = performance.now() - t; t = performance.now();
          var r = PlaybackBattle.build(defs, info, stream);
          T.decode = performance.now() - t;
          state = { defs: defs, info: info, built: r, sig: d.sig, times: T };
          self.postMessage({ battle: r.battle, times: T });
        } else if (d.cmd === 'effects') {
          var fx = PlaybackBattle.effects(state.built.collector, state.built.battle, state.defs, state.info, d.docs);
          state.times.effects = performance.now() - t; t = performance.now();
          var db = await idb();
          await new Promise(function (ok, fail) {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ sig: state.sig, battle: state.built.battle }, state.info.id);
            tx.oncomplete = ok; tx.onerror = function () { fail(tx.error); };
          });
          state.times.idbWrite = performance.now() - t;
          self.postMessage({ effects: fx, times: state.times });
        }
      } catch (err) { self.postMessage({ error: String(err && err.message || err), stack: String(err && err.stack || ''), missing: !!(err && err.missing) }); }
    };
  }
  function ask(w, msg) {
    return new Promise(function (ok, fail) {
      w.onmessage = function (e) {
        var r = e.data;
        if (r.error) { var err = new Error(r.error); err.missing = r.missing; err.workerStack = r.stack; fail(err); } else ok(r);
      };
      w.onerror = function (e) { fail(new Error('battle worker: ' + (e.message || e))); };
      w.postMessage(msg);
    });
  }
  window.BattlePage = {
    obtain: async function (o) {
      var info = o.info, t0 = performance.now(), sig = [info.source.size, info.source.crc, PlaybackBattle.FORMAT].join(':');
      var db = await idb(), rec = await get(db, info.id);
      if (rec && rec.sig === sig) return { battle: rec.battle, effects: null, info: { source: 'IndexedDB', ms: +(performance.now() - t0).toFixed(0) } };
      var url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')();'], { type: 'text/javascript' }));
      var w = new Worker(url), done = function () { w.terminate(); URL.revokeObjectURL(url); };
      var r;
      try { r = await ask(w, { cmd: 'build', base: new URL(o.builderBase, base).href, dataBase: new URL(o.dataBase, base).href, info: info, sig: sig }); }
      catch (e) { done(); throw e; }
      var result = { battle: r.battle, info: { source: 'built', times: r.times } };
      result.effects = function (docs) {
        return ask(w, { cmd: 'effects', docs: docs }).then(function (x) {
          done(); Object.assign(result.battle, x.effects); result.info.times = x.times;
          result.info.ms = +(performance.now() - t0).toFixed(0);
          return x.effects;
        }, function (e) { done(); throw e; });
      };
      return result;
    }
  };
})();
