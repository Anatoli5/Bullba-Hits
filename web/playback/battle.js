/* Bullba Hits' 3D replay player (19.11.2026): the battle the player draws, built in the page from the battle's replay.
   The port of the mod's playback.py of 18.11 (Collector, Job.assemble, Effects; recycle/mod/local_armor_inspector/
   playback.py), translated as directly as possible; the decoder is decoder.js (ReplayDecoder). Runs in the battle worker
   (battle-page.js) and under node (tests). Inputs, all from the mod (playback.py): the battle's source as it is kept
   (a .wotreplay - decrypted here -, the kept stream.z - inflated here -, or the raw copy), the decoder's definitions and
   the client's vehicle names and damage sticker kinds (one file per client), the battle record's map, mode, start, own
   vehicle and roster, the client's part boxes of this battle (its stored records' statics); and the page's own vehicle
   and model files (data/vehicles, data/models) for the hit points.
   PlaybackBattle.source(kind, bytes, name) -> Promise<stream>; build(defs, info, stream) -> {battle, collector};
   effects(collector, battle, defs, info, docs) -> adds hits, marks, muzzles to the battle. */
(function () {
  'use strict';
  var FORMAT = 5;                 // of the battle object kept in IndexedDB (battle-page.js): a change builds it again; 5 (21.11): scenario
                                  // (2, 19.11: hitEvents and the tracers' shell fields, for the shots panel - BACKLOG 109;
                                  // 3, 21.11: the player's camera (0x26), for the shot view's first person - NOTEBOOK S2;
                                  // 4, 20.11: the player's reticles a tick (0x1a, 0x39), for the shot view's aim circles - T3)
  var DELAY_OWN = 0.20, DELAY_OTHER = 0.15;
  var DESTRUCTION_KINDS = ['destroyedFragiles', 'destroyedModules', 'fallenTrees', 'fallenColumns'];
  var PIERCED_EFFECTS = [0, 4, 5, 6];
  var CAL_CLASS = [[50, 'small'], [75, 'medium'], [108, 'main'], [1e9, 'large']];
  var NUDGES = [[1, -1], [1, 1], [0, -1], [0, 1], [2, -1], [2, 1]];
  var REPLAY_MAGIC = 0x11343212, ARENA_SCAN = 1 << 16;
  // the run-time decode's skips (replay_run.LEAN_TYPES, LEAN_PROPERTIES): what nothing here reads
  // (0x26, the player's camera, is read since 21.11: the shot view's first person)
  var LEAN_TYPES = [[0x36, 0]];
  var LEAN_PROPERTIES = ['engineMode', 'isStrafing', 'ownVehicleAuxPhysicsData', 'wheelsScroll'];
  var W_DECODE = 'The replay of this battle could not be read (%s)';
  // Whether a 0x1a sample's fields 3-10 are the SERVER reticle: the shell's direction there (8-10) has the azimuth of the shot
  // vector of a 0x39 near it to float precision. The rule and its constants are the mod's (replay_aim.py Track.from_server,
  // SERVER_SPREAD, SAME_AZIMUTH; measured 12.11.2026 on 321 own shots), applied here to the page's own decode.
  var SERVER_SPREAD = [6, 4], SAME_AZIMUTH = 2e-5;

  var D = typeof ReplayDecoder !== 'undefined' ? ReplayDecoder : (typeof require === 'function' ? require('./decoder.js') : null);

  function words(w, s) { return w.replace('%s', s); }
  function r3n(x) { return Math.round(x * 1000) / 1000; }
  function r3(a) { return a.map(r3n); }
  function num(x) { return typeof x === 'bigint' ? Number(x) : x; }
  function latin(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; }
  function isDict(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array); }
  function b64(u) {
    var s = '', k;
    for (k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    var t = atob(s), n = t.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = t.charCodeAt(i);
    return u;
  }
  function floats(rows, width) {
    var out = new Float32Array(rows.length * width);
    for (var i = 0; i < rows.length; i++) for (var j = 0; j < width; j++) out[i * width + j] = rows[i][j];
    return out;
  }
  function cmpArr(a, b) {
    for (var i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  }
  function chunkId(x, z) { return ((Math.floor(x / 100) + 127) << 8) | (Math.floor(z / 100) + 127); }
  function turretGun(cd) {
    // (turret id, gun id) of a compact descriptor (base64): header, type id, chassis, engine, fuel tank, radio, turret, gun
    if (!cd) return null;
    var s = atob(cd), p = (s.charCodeAt(0) & 2 ? 3 : 2) + 8;
    if (s.length < p + 4) return null;
    return [s.charCodeAt(p) | s.charCodeAt(p + 1) << 8, s.charCodeAt(p + 2) | s.charCodeAt(p + 3) << 8];
  }

  // ---- the source: as the mod hands it over ---------------------------------------------------------------------------
  var inflate = function (bytes) {  // zlib -> bytes (DecompressionStream: CEF 109 has it; node sets its own)
    var s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  };
  var schedule = null;
  function arenaInStream(data, arena) {
    // replay_source.arena_in_stream: the first 0x00 packet carries the arena id as a little-endian u64
    var want = BigInt(arena), pat = new Uint8Array(8), off = 0, n = Math.min(data.length, ARENA_SCAN), i;
    for (i = 0; i < 8; i++) pat[i] = Number((want >> BigInt(8 * i)) & 255n);
    var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (off + 12 <= n) {
      var size = dv.getUint32(off, true), ptype = dv.getUint32(off + 4, true);
      if (off + 12 + size > data.length) return data.length < ARENA_SCAN ? null : false;
      if (ptype === 0) {
        var p = data.subarray(off + 12, off + 12 + size);
        outer: for (var a = 0; a + 8 <= p.length; a++) { for (var b = 0; b < 8; b++) if (p[a + b] !== pat[b]) continue outer; return true; }
        return false;
      }
      off += 12 + size;
    }
    return data.length < ARENA_SCAN ? null : false;
  }
  function source(kind, bytes, name) {
    if (kind === 'raw') return Promise.resolve(bytes);
    if (kind === 'zlib') return inflate(bytes);
    if (kind !== 'wotreplay') return Promise.reject(new Error(words(W_DECODE, 'a source of kind ' + kind)));
    // replay_run.FinalFile: magic, the JSON blocks, the stream's and the packed sizes, Blowfish, zlib
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== REPLAY_MAGIC) return Promise.reject(new Error(words(W_DECODE, 'not a .wotreplay')));
    var count = dv.getUint32(4, true), off = 8;
    for (var i = 0; i < count; i++) off += 4 + dv.getUint32(off, true);
    if (off + 8 > bytes.length) return Promise.reject(new Error(words(W_DECODE, 'no stream in the replay file')));
    var rawSize = dv.getUint32(off, true), packed = dv.getUint32(off + 4, true);
    if (!schedule) schedule = D.blowfishSchedule(D.REPLAY_KEY);
    var plain = D.decryptStream(bytes.subarray(off + 8), schedule);
    return inflate(plain.subarray(0, packed)).then(function (stream) {
      if (stream.length !== rawSize) throw new Error(words(W_DECODE, 'stream size ' + stream.length + ', the header says ' + rawSize));
      // a replay FILE of the viewer's list (id 'f-...', 19.11) is no battle of Bullba Hits: no arena id to hold it to
      if (!/^f-/.test(name) && arenaInStream(stream, name.split('-', 1)[0]) !== true) throw new Error(words(W_DECODE, 'the kept replay file is of another battle'));
      return stream;
    });
  }

  // ---- what the player draws, from the decoder's events (playback.py Collector) ----------------------------------------
  function Collector() {
    this.created = new Set(); this.pos = new Map(); this.gun = new Map(); this.hp = new Map(); this.sight = new Map();
    this.comp = new Map(); this.tracers = new Map(); this.ends = new Map(); this.periods = []; this.own = null; this.tmax = 0; this.serverStart = null;
    this.area = new Map(); this.destroyed = []; this.hits = []; this.shooting = []; this.stickers = []; this.camera = [];
    this.marker = []; this.server = [];
    this.netName = new Map(); this.scenario = [];   // 21.11: the map scenarios' state entities (NetworkEntity) and starts
  }
  function list(m, k) { var v = m.get(k); if (!v) m.set(k, v = []); return v; }
  Collector.prototype.feed = function (ev) {
    var k = ev.ev, t = ev.t || 0, ent = ev.entity, p, a, name, self = this;
    if (t > this.tmax) this.tmax = t;
    if (k === 'entity_create' && ent === 'Vehicle') {
      var vid = ev.id; p = ev.props || {};
      this.created.add(vid);
      list(this.sight, vid).push([t, null]);
      if ('health' in p) list(this.hp, vid).push([t, p.health]);
      var pi = p.publicInfo || {};
      if (pi.compDescr && !this.comp.has(vid)) this.comp.set(vid, pi.compDescr);
      if ('gunAnglesPacked' in p) { var g = D.decodeGunAngles(p.gunAnglesPacked); list(this.gun, vid).push([t, g[0], g[1]]); }
      (p.damageStickers || []).forEach(function (st) { self.stickers.push([t, vid, BigInt(st.segment), 'create']); });
    } else if (k === 'entity_create' && ent === 'AreaDestructibles') {
      // the create packet's position: x in the decoder's pos[1], z in dir[0] for this entity (measured in the trial)
      var cid = chunkId(ev.pos[1], ev.dir[0]);
      this.area.set(ev.id, cid);
      DESTRUCTION_KINDS.forEach(function (n) {
        ((ev.props || {})[n] || []).forEach(function (tup) { self.destroyed.push([r3n(t), 1, cid, n, tup.map(function (x) { return Math.trunc(num(x)); })]); });
      });
    } else if (k === 'nested_property' && ent === 'AreaDestructibles' && DESTRUCTION_KINDS.indexOf(ev.name) >= 0) {
      ev.value.forEach(function (tup) {
        self.destroyed.push([r3n(t), 0, self.area.has(ev.id) ? self.area.get(ev.id) : null, ev.name, tup.map(function (x) { return Math.trunc(num(x)); })]);
      });
    } else if (k === 'entity_create' && ent === 'NetworkEntity') {
      // 21.11: a map scenario's state entity is named by its prefab ('..._normal.prefab', '..._destroyed.prefab'):
      // its leave / appearance switches the part (mapbuild9.js scenarioSwitches)
      name = (ev.props || {}).name; name = (name && typeof name !== 'string' ? latin(name) : String(name || '')).toLowerCase();   // the decoder gives a STRING as its bytes
      if (/_(normal|destroyed)\.prefab$/.test(name)) { this.netName.set(ev.id, name); this.scenario.push([r3n(t), t <= 0 ? 1 : 0, name, 'create']); }
    } else if (k === 'entity_leave' && this.netName.has(ev.id)) {
      this.scenario.push([r3n(t), 0, this.netName.get(ev.id), 'leave']); this.netName.delete(ev.id);
    } else if ((k === 'component_property' && ev.component === 'SequenceNetworkSync' && ev.name === 'state' && num(ev.value) >= 1) ||
               (k === 'component' && ev.component === 'SequenceNetworkSync' && ev.state && num(ev.state.state) >= 1)) {
      this.scenario.push([r3n(t), 0, '', 'start']);
    } else if (k === 'entity_leave' && this.created.has(ev.id)) {
      var s = this.sight.get(ev.id);
      if (s && s.length && s[s.length - 1][1] === null) s[s.length - 1][1] = t;
    } else if (k === 'position' && this.created.has(ev.id) && !ev.vehicleId) {
      list(this.pos, ev.id).push([t, ev.pos[0], ev.pos[1], ev.pos[2], ev.yaw, ev.pitch, ev.roll]);
    } else if (k === 'property' && ent === 'Vehicle') {
      name = ev.name;
      if (name === 'gunAnglesPacked' && 'turretYaw' in ev) list(this.gun, ev.id).push([t, ev.turretYaw, ev.gunPitchT]);
      else if (name === 'health') list(this.hp, ev.id).push([t, ev.value]);
      else if (name === 'publicInfo' && isDict(ev.value) && ev.value.compDescr) { if (!this.comp.has(ev.id)) this.comp.set(ev.id, ev.value.compDescr); }
      else if (name === 'damageStickers') this.stickerValue(t, ev, 'property');
    } else if (k === 'nested_property' && ent === 'Vehicle' && ev.name === 'damageStickers') {
      this.stickerValue(t, ev, 'nested_property');
    } else if (k === 'method' && ev.name === 'showTracer') {
      a = ev.args;
      this.tracers.set(a.shotID, [t, a.shooterID, a.refStartPoint.slice(), a.velocity.slice(), a.gravity, a.isRicochet || 0,
        a.shellTypeIdx === undefined ? -1 : a.shellTypeIdx, +(a.shellCaliber || 0)]);
    } else if (k === 'method' && (ev.name === 'explodeProjectile' || ev.name === 'stopTracer')) {
      a = ev.args;
      if (!this.ends.has(a.shotID)) this.ends.set(a.shotID, [t, a.endPoint.slice()]);
    } else if (k === 'method' && ent === 'Vehicle' && ev.name === 'showDamageFromShot') {
      a = ev.args;
      var points = (a.hitPoints || []).map(function (q) { return [BigInt(q.segment), +(q.caliber || 0), Math.trunc(num(q.networkID || 0)), q.shellType === undefined ? -1 : q.shellType]; });
      this.hits.push([t, ev.id, a.attackerID === undefined ? null : a.attackerID, points, a.damage]);
    } else if (k === 'method' && ent === 'Vehicle' && ev.name === 'showShooting') {
      a = ev.args;
      this.shooting.push([t, ev.id, a.burstCount, a.shellType]);
    } else if (k === 'server_time_at_start') {
      // packet 0x15: the server's clock at the recording start - a Hits battle made from this replay stamps each event
      // gameTime = this + the packet clock (replay_records.game_time): how a row of the shots panel finds its Hits hit
      if (this.serverStart === null) this.serverStart = ev.serverTime;
    } else if (k === 'arena_period') {
      this.periods.push([r3n(t), ev.period]);
    } else if (k === 'camera') {
      // packet 0x26, one a tick: the replay's own camera - rotation (a unit quaternion x, y, z, w, the game's axes; its
      // +z is the view), offset (the eye minus the followed vehicle's position, world axes), fov (radians: 1.178 arcade,
      // 0.295 / 0.147 / 0.074 sniper). MEASURED 21.11 on Karelia 18.11: in sniper mode the view from vehicle + offset
      // points at the 0x1a cursor point to a dot of 1.0000; the fov taken as vertical (BigWorld's projection) - inferred
      this.camera.push([t].concat(ev.rotation, ev.offset, [ev.fov]));
    } else if (k === 'client_gun_marker') {
      // packet 0x1a, one a tick: the replay controller's gun-marker state (replay_aim.py; docs/KNOWLEDGE.md section 18):
      // 0-2 the point under the cursor, 3 the diameter of the reticle last given to the game, 5-7 its place, 8-10 the
      // shell's direction there (the SERVER reticle while it is shown and updated), 11 the arcade (client) reticle's diameter
      this.marker.push([t].concat(ev.point, [ev.markerDiameter], ev.markerPosition, ev.markerDirection, [ev.arcadeDiameter]));
    } else if (k === 'server_gun_marker') {
      // packet 0x39 of the own vehicle, one a server tick: gun position, shot vector, dispersion half-angle (rad)
      this.server.push([t].concat(ev.gunPosition, ev.shotVector, [ev.dispersion]));
    } else if (k === 'own_vehicle') {
      // the first: after his death 0x22 names the ally his camera watches (MEASURED 19.11 on Karelia 18.11:
      // 2996243 at 0 s, dead at 354.85 s, 2996248 at 389.25 s; tests/test_playback_own.py)
      if (this.own === null) this.own = ev.vehicleId;
    }
  };
  Collector.prototype.stickerValue = function (t, ev, how) {
    var v = ev.value || [], self = this;
    (isDict(v) ? [v] : v).forEach(function (st) { self.stickers.push([t, ev.id, BigInt(st.segment), how]); });
  };

  // ---- the battle's vehicles (replay_stream.Battle: the parts of summary() the player reads) ---------------------------
  function Vehicles(roster, names) {
    this.names = names || {}; this.v = new Map();
    var self = this;
    roster.forEach(function (row) { if (row.id !== null && row.id !== undefined) self.v.set(+row.id, { type: row.type, team: row.team, maxHealthHeader: row.maxHealth }); });
  }
  Vehicles.prototype.veh = function (eid) {
    var v = this.v.get(eid); if (!v) this.v.set(eid, v = { type: null, team: null, maxHealthHeader: null }); return v;
  };
  Vehicles.prototype.publicInfo = function (eid, info) {
    if (!isDict(info) || !info.compDescr) return;
    var v = this.veh(eid), cd = info.compDescr, header = cd[0], tid = cd[1];
    if (header & 2) tid += cd[2] << 8;
    var nation = (header >> 4) & 15, tcd = 1 + (nation << 4) + (tid << 8);
    v.typeStream = this.names[nation + ',' + tid] || ('typeCompDescr ' + tcd);
    v.maxHealthStream = info.maxHealth;
    v.team = v.team || info.team;
  };
  Vehicles.prototype.feed = function (ev) {
    if (ev.entity !== 'Vehicle') return;
    if (ev.ev === 'entity_create') this.publicInfo(ev.id, (ev.props || {}).publicInfo);
    else if (ev.ev === 'property' && ev.name === 'publicInfo') this.publicInfo(ev.id, ev.value);  // Onslaught's switch
  };
  Vehicles.prototype.summary = function () {
    var self = this;
    return Array.from(this.v.keys()).sort(function (a, b) { return a - b; }).map(function (eid) {
      var v = self.v.get(eid);
      return { id: eid, type: v.typeStream || v.type, team: v.team, maxHealth: v.maxHealthHeader, maxHealthStream: v.maxHealthStream };
    });
  };

  function dateTime(started) {
    if (!started) return '';
    var d = new Date(started * 1000), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ---- decode + assemble (playback.py Job.make, Job.assemble) -------------------------------------------------------
  function build(defs, info, stream) {
    var schema = defs.schemaObject || (defs.schemaObject = new D.Schema(defs.schema));
    var rec = info.record || {}, players = {};
    (info.roster || []).forEach(function (row) { if (row.id !== null && row.id !== undefined && row.player) players[String(row.id)] = row.player; });
    var vehicles = new Vehicles(info.roster || [], defs.vehicleNames);
    var c = new Collector();
    D.setInflate(function () { throw new Error('no synchronous inflate in the page'); });  // battle results, arena updates: not read here
    try {
      new D.Decoder(schema, { skip: new Map(LEAN_TYPES), skipProperties: LEAN_PROPERTIES }).decode(stream, function (ev) { vehicles.feed(ev); c.feed(ev); });
    } catch (e) { throw new Error(words(W_DECODE, (e && e.name || 'Error') + ': ' + (e && e.message || e))); }
    var tmax = c.tmax, own = c.own !== null ? c.own : rec.playerVehicleId;
    var vlist = [];
    vehicles.summary().forEach(function (v) {
      var vid = v.id;
      if (!v.type) return;
      var sight = c.sight.get(vid) || [];
      sight.forEach(function (iv) { if (iv[1] === null) iv[1] = tmax; });
      var pos = c.pos.get(vid) || [], gun = c.gun.get(vid) || [], hp = c.hp.get(vid) || [], cd = c.comp.get(vid);
      vlist.push({ id: vid, team: v.team, type: v.type, own: vid === own, player: players[String(vid)],
        maxHealth: v.maxHealth || v.maxHealthStream, compDescr: cd ? b64(cd) : null,
        sight: sight.map(function (iv) { return [r3n(iv[0]), r3n(iv[1])]; }),
        np: pos.length, pos: floats(pos, 7), ng: gun.length, gun: floats(gun, 3), nh: hp.length, hp: floats(hp, 2) });
    });
    var shots = [];
    c.tracers.forEach(function (tr, sid) {
      var e = c.ends.get(sid);
      if (e === undefined) return;
      shots.push([r3n(tr[0]), tr[1], tr[5]].concat(r3(tr[2]), r3(tr[3]), [Math.round(tr[4] * 1e4) / 1e4, r3n(e[0])], r3(e[1]), [tr[6], tr[7]]));
    });
    shots.sort(cmpArr);
    // every showDamageFromShot as the server sent it (19.11, the shots panel): the placed points of 'hits' (effects) leave
    // out a hit whose point the page cannot place; this list keeps each hit - its time, target, attacker (-1: none named),
    // damage and the effect, calibre and shell kind index (shellType of the point's params, -1 unknown) of every point
    var hitEvents = c.hits.slice().sort(function (a, b) { return a[0] - b[0]; }).map(function (h) {
      return [r3n(h[0]), h[1], h[2] === null ? -1 : h[2], Math.trunc(num(h[4] || 0)), h[3].map(function (p) { return [Number(p[0] & 255n), Math.round(p[1] * 10) / 10, p[3]]; })];
    });
    var meta = { map: rec.map, gameplay: rec.gameplay, mapTitle: rec.mapTitle, dateTime: dateTime(rec.startedAt),
      periods: c.periods, end: tmax, own: own, serverStart: c.serverStart, delayOwn: DELAY_OWN, delayOther: DELAY_OTHER, id: info.id };
    return { collector: c, battle: { format: FORMAT, id: info.id, meta: meta, vehicles: vlist, shots: shots,
      shotFields: ['t', 'shooter', 'ricochet', 'sx', 'sy', 'sz', 'vx', 'vy', 'vz', 'gravity', 'tEnd', 'ex', 'ey', 'ez', 'shellTypeIdx', 'caliber'],
      hitEvents: hitEvents, hitEventFields: ['t', 'target', 'attacker', 'damage', 'points'], hitPointFields: ['effect', 'caliber', 'shellType'],
      destroyed: c.destroyed, destroyedFields: ['t', 'initial', 'chunk', 'kind', 'tuple'],
      scenario: c.scenario, scenarioFields: ['t', 'initial', 'name', 'what'],
      nc: c.camera.length, camera: floats(c.camera, 9), cameraFields: ['t', 'qx', 'qy', 'qz', 'qw', 'ox', 'oy', 'oz', 'fov'],
      na: c.marker.length, aim: floats(markerRows(c), 13), aimFields: ['t', 'cx', 'cy', 'cz', 'diameter', 'mx', 'my', 'mz', 'dx', 'dy', 'dz', 'arcadeDiameter', 'server'],
      ns: c.server.length, server: floats(c.server, 8), serverFields: ['t', 'gx', 'gy', 'gz', 'vx', 'vy', 'vz', 'dispersion'] } };
  }
  // the 0x1a rows with their last field: 1 when fields 3-10 are the server reticle (SERVER_SPREAD, SAME_AZIMUTH above)
  function markerRows(c) {
    var S = c.server, k = -1;
    return c.marker.map(function (m) {
      while (k + 1 < S.length && S[k + 1][0] <= m[0] + 1e-6) k++;
      var server = 0;
      if (Math.hypot(m[8], m[10]) >= 1e-6) {
        var az = Math.atan2(m[8], m[10]);
        for (var kk = Math.max(0, k - SERVER_SPREAD[0]); kk < Math.min(S.length, k + SERVER_SPREAD[1] + 1); kk++) {
          var v = S[kk]; if (Math.hypot(v[4], v[6]) < 1e-6) continue;
          var d = Math.atan2(v[4], v[6]) - az;
          if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) <= SAME_AZIMUTH) { server = 1; break; }
        }
      }
      return m.concat([server]);
    });
  }

  // ---- the hit points on the drawn part (playback.py Effects; replay_scene Model, decode_segment, collide_hit_point) ---
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function unit(a) { var n = Math.sqrt(dot(a, a)); return [a[0] / n, a[1] / n, a[2] / n]; }
  function Model(doc) {
    var tris = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    (doc.groups || []).forEach(function (g) {
      var vs = g.vertices, ids = g.indices, mat = g.material;
      vs.forEach(function (v) { for (var i = 0; i < 3; i++) { if (v[i] < lo[i]) lo[i] = v[i]; if (v[i] > hi[i]) hi[i] = v[i]; } });
      for (var k = 0; k + 2 < ids.length; k += 3) {
        var a = vs[ids[k]], b = vs[ids[k + 1]], c = vs[ids[k + 2]], e1 = sub(b, a), e2 = sub(c, a);
        var n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], ln = Math.sqrt(dot(n, n));
        if (!(ln > 0)) continue;
        tris.push([a[0], a[1], a[2], e1[0], e1[1], e1[2], e2[0], e2[1], e2[2], n[0] / ln, n[1] / ln, n[2] / ln, mat]);
      }
    });
    this.tris = tris; this.vertexBox = [lo, hi];
  }
  Model.prototype.collide = function (s, e) {
    var dx = e[0] - s[0], dy = e[1] - s[1], dz = e[2] - s[2], span = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(span > 0)) return null;
    var ux = dx / span, uy = dy / span, uz = dz / span, sx = s[0], sy = s[1], sz = s[2], best = span, found = null;
    for (var i = 0; i < this.tris.length; i++) {
      var tr = this.tris[i], ax = tr[0], ay = tr[1], az = tr[2], e1x = tr[3], e1y = tr[4], e1z = tr[5], e2x = tr[6], e2y = tr[7], e2z = tr[8];
      var px = uy * e2z - uz * e2y, py = uz * e2x - ux * e2z, pz = ux * e2y - uy * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      var inv = 1 / det, tx = sx - ax, ty = sy - ay, tz = sz - az, u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (ux * qx + uy * qy + uz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var d = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (d < 0 || d > best) continue;
      best = d; found = tr;
    }
    return found === null ? null : [best, found];
  };
  function decodeSegment(seg, box) {
    var lo = box[0], hi = box[1], s = [], e = [], i;
    for (i = 0; i < 3; i++) {
      var step = (hi[i] - lo[i]) / 255;
      s.push(lo[i] + step * Number((seg >> BigInt(16 + 8 * i)) & 255n));
      e.push(lo[i] + step * Number((seg >> BigInt(40 + 8 * i)) & 255n));
    }
    var off = [0, 1, 2].map(function (j) { return (e[j] - s[j]) * 0.01; });
    return [[s[0] - off[0], s[1] - off[1], s[2] - off[2]], [e[0] + off[0], e[1] + off[1], e[2] + off[2]]];
  }
  function collideHitPoint(model, box, s, e) {
    var hit = model.collide(s, e), how = 'direct';
    if (hit === null) {
      var size = [0, 1, 2].map(function (i) { return (box[1][i] - box[0][i]) / 256; });
      for (var k = 0; k < NUDGES.length; k++) {
        var shift = [0, 0, 0]; shift[NUDGES[k][0]] = NUDGES[k][1] * size[NUDGES[k][0]];
        var s2 = [s[0] + shift[0], s[1] + shift[1], s[2] + shift[2]], e2 = [e[0] + shift[0], e[1] + shift[1], e[2] + shift[2]];
        hit = model.collide(s2, e2);
        if (hit !== null) { s = s2; e = e2; how = 'nudged'; break; }
      }
    }
    if (hit === null) return null;
    var dir = unit(sub(e, s)), dist = hit[0];
    return [[s[0] + dir[0] * dist, s[1] + dir[1] * dist, s[2] + dir[2] * dist], dir, hit[1], how];
  }
  function facing(tri, d) { var n = [tri[9], tri[10], tri[11]]; return dot(n, d) > 0 ? [-n[0], -n[1], -n[2]] : n; }
  function xf(tr, v, off) {
    var r = [tr[0] * v[0] + tr[4] * v[1] + tr[8] * v[2], tr[1] * v[0] + tr[5] * v[1] + tr[9] * v[2], tr[2] * v[0] + tr[6] * v[1] + tr[10] * v[2]];
    if (!off) { var ln = Math.sqrt(dot(r, r)) || 1; return [r[0] / ln, r[1] / ln, r[2] / ln]; }
    return [r[0] + tr[12] - off[0], r[1] + tr[13] - off[1], r[2] + tr[14] - off[2]];
  }
  function calibreSize(kinds, cal, pierced) {
    var cls = CAL_CLASS.filter(function (c) { return cal < c[0]; })[0][1], name = cls + '_' + (pierced ? 'hole' : 'ricochet');
    var k = kinds.filter(function (x) { return x[0] === name; })[0];
    return k ? k[1] : 0.2;
  }
  // a vehicle type's parts with their collision models (Effects.parts_steps); docs[typ] = {veh, models} (the page's loads)
  function partsOf(doc, boxes) {
    if (!doc || !doc.veh) return null;
    var veh = doc.veh, pl = (veh.parts || []).filter(function (p) { return 'modelKey' in p && 'id' in p; });
    var tt = (pl.filter(function (p) { return p.name === 'turret'; })[0] || {}).transform, gt = (pl.filter(function (p) { return p.name === 'gun'; })[0] || {}).transform;
    if (!tt || !gt) return null;
    var out = { _cd: turretGun(veh.compactDescriptor || ''), parts: {} }, ids = [];
    pl.forEach(function (p) {
      var md = (doc.models || {})[p.modelKey];
      if (!md) return;
      var m = new Model(md), res = p.resource || md.resource, box = boxes[res];
      var grp = p.name === 'turret' ? 1 : (p.name === 'gun' ? 2 : 0);
      var off = grp === 1 ? tt.slice(12, 15) : (grp === 2 ? gt.slice(12, 15) : [0, 0, 0]);
      out.parts[p.id] = { model: m, box: box || m.vertexBox, approx: !box, tr: p.transform, off: off, grp: grp };
      ids.push(p.id);
    });
    out._max = ids.length ? Math.max.apply(null, ids) : -1;
    return out;
  }
  function effects(c, battle, defs, info, docs) {
    var stats = {}, count = function (k) { stats[k] = (stats[k] || 0) + 1; };
    var boxes = {}, kinds = defs.stickers || [];
    Object.keys(info.boxes || {}).forEach(function (k) { var b = info.boxes[k]; boxes[k] = [b.slice(0, 3), b.slice(3, 6)]; });
    var types = {}, vtype = new Map();
    battle.vehicles.forEach(function (v) { vtype.set(v.id, v); });
    Array.from(new Set(battle.vehicles.map(function (v) { return v.type; }))).sort().forEach(function (typ) { types[typ] = partsOf(docs[typ], boxes); });
    // the battle's turret and gun against the exported file's (another one: its points are not placed on them)
    battle.vehicles.forEach(function (v) {
      var P = types[v.type], bt = v.compDescr ? turretGun(v.compDescr) : null;
      v.modulesMatch = !P || bt === null || P._cd === null ? null : bt[0] === P._cd[0] && bt[1] === P._cd[1];
    });
    function resolve(vid, seg, network) {
      var v = vtype.get(vid);
      if (v === undefined) return [null, 'target not in the vehicle list'];
      var P = types[v.type];
      if (!P) return [null, 'no exported vehicle file'];
      var pid = Number((seg >> 8n) & 255n);
      if (network) return [null, 'armoured prefab (no model on the page)'];
      if (pid > P._max) return [null, 'wheel (no box for it)'];
      var part = P.parts[pid];
      if (!part) return [null, 'part ' + pid + ' not in the vehicle file'];
      if (part.grp && v.modulesMatch === false) return [null, 'turret/gun differ from the exported file'];
      var se = decodeSegment(seg, part.box), s = se[0], e = se[1];
      if (s[0] === e[0] && s[1] === e[1] && s[2] === e[2]) return [null, 'empty segment'];
      var found = collideHitPoint(part.model, part.box, s, e);
      if (found === null) return [null, 'segment meets no triangle'];
      var n = facing(found[2], found[1]);
      return [[part.grp, xf(part.tr, found[0], part.off), xf(part.tr, n), xf(part.tr, found[1]), part.approx], null];
    }
    var key = function (vid, seg) { return vid + ':' + (seg >> 8n).toString(); };
    var stByKey = new Map();
    c.stickers.forEach(function (s) { var k = key(s[1], s[2]); if (!stByKey.has(k)) stByKey.set(k, [s[0], Number(s[2] & 255n), s[3]]); });
    var ric = []; c.tracers.forEach(function (tr) { if (tr[5]) ric.push([tr[0], tr[1], tr[3]]); });
    ric.sort(function (a, b) { return a[0] - b[0]; });
    var hits = [], seen = new Map();
    c.hits.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (h, hi) {
      var t = h[0], vid = h[1], att = h[2], pts = h[3], dmg = h[4];
      count('hit events');
      pts.forEach(function (pt, pi) {
        var seg = pt[0], cal = pt[1], network = pt[2];
        count('hit points');
        var eff = Number(seg & 255n), k = key(vid, seg);
        if (!seen.has(k)) seen.set(k, t);
        var r = resolve(vid, seg, network);
        if (r[0] === null) { count('point not placed: ' + r[1]); return; }
        var grp = r[0][0], pos = r[0][1], n = r[0][2], d = r[0][3], approx = r[0][4];
        var st = stByKey.get(k), size, fromSt;
        if (st !== undefined && st[1] < kinds.length) { size = kinds[st[1]][1]; fromSt = 1; }
        else { size = calibreSize(kinds, cal, PIERCED_EFFECTS.indexOf(eff) >= 0); fromSt = 0; }
        var out = [0, 0, 0];
        if (eff === 1 || eff === 2) {
          // the ricochet's own tracer (isRicochet, same shooter, the next tick: +0.1 s, 3 of 4 in the trial)
          var near = ric.filter(function (x) { return x[1] === att && x[0] - t >= -0.01 && x[0] - t <= 0.15; });
          if (near.length) {
            var best = near.reduce(function (m, x) { return Math.abs(x[0] - t) < Math.abs(m[0] - t) ? x : m; });
            var vel = best[2], ln = Math.sqrt(dot(vel, vel)) || 1;
            out = vel.map(function (x) { return r3n(x / ln); });
          }
        }
        hits.push([r3n(t), vid, att !== null ? att : -1, hi, pi, pts.length, eff, grp].concat(r3(pos), r3(n), r3(d), [r3n(size)], out,
          [(approx ? 1 : 0) | fromSt << 1, Math.trunc(dmg || 0), Math.round(cal * 10) / 10]));
        count('points placed');
      });
    });
    var marks = [], done = new Set();
    c.stickers.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (s) {
      var t = s[0], vid = s[1], seg = s[2], k = key(vid, seg);
      if (done.has(k)) return;
      done.add(k);
      if (seen.has(k) && seen.get(k) <= t + 0.01) { count('stickers of a hit seen'); return; }
      var r = resolve(vid, (seg >> 8n) << 8n, 0);
      if (r[0] === null) { count('sticker not placed: ' + r[1]); return; }
      var idx = Number(seg & 255n), kind = idx < kinds.length ? kinds[idx] : ['unknown', 0.2];
      marks.push([r3n(t), vid, r[0][0], kind[0].indexOf('hole') >= 0 ? 0 : 1].concat(r3(r[0][1]), r3(r[0][2]), [r3n(kind[1]), r[0][4] ? 1 : 0]));
      count('sticker marks placed');
    });
    var muzzles = c.shooting.slice().sort(function (a, b) { return a[0] - b[0]; }).map(function (m) { return [r3n(m[0]), m[1], Math.trunc(m[2] || 1), Math.trunc(m[3] || 0)]; });
    var fx = { hits: hits, marks: marks, muzzles: muzzles, effectStats: stats,
      hitFields: ['t', 'target', 'attacker', 'hit', 'point', 'points', 'effect', 'grp', 'px', 'py', 'pz', 'nx', 'ny', 'nz', 'dx', 'dy', 'dz', 'size', 'rx', 'ry', 'rz', 'flags', 'damage', 'caliber'],
      markFields: ['t', 'target', 'grp', 'kind', 'px', 'py', 'pz', 'nx', 'ny', 'nz', 'size', 'approx'],
      muzzleFields: ['t', 'shooter', 'burstCount', 'shellType'] };
    Object.assign(battle, fx);
    return fx;
  }

  var api = { FORMAT: FORMAT, source: source, build: build, effects: effects, Collector: Collector, unb64: unb64,
    setInflate: function (fn) { inflate = fn; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else self.PlaybackBattle = api;
})();
