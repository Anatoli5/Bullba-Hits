/* THE SHOT VIEW of the replay viewer (19.11.2026, NOTEBOOK N5, BACKLOG 109): a row of the shots panel shows that shot as
   Bullba Hits shows a shot, inside the battle's scene.

   What is Bullba Hits' and is used as it is, not copied:
   - Hits' own 3D viewer (web/viewer.js ArmorViewer, with web/screen-armor.js and web/ballistics.js): the target's collision
     model with Hits' heat map for this shell from this shooter's place (the ricochet leg included), the hit line through the
     model and its crosses, Hits' aim circles (setShotContext / setAimEstimate, Hits' own rules for whose circle may be
     drawn), Hits' centring (focus: the eye on the shell's axis at its origin, looking at the vehicle) and Hits' controls
     (orbit round the target, wheel zoom, right / Ctrl + left drag pan, a click pins a point). It draws into a transparent
     canvas laid exactly over the replay's canvas, the target alone (its grid and horizon hidden);
   - the hit's scene rebuilt from the replay (web/local-data.js scene(battle, id, 'replay')), found by local-data.js hitAt
     (the rule Hits' own row link uses) in the battle Bullba Hits published from this replay;
   - the shot's tracer, stop and aim blocks (web/shot-context.js resolve) and the shell at the hit's range
     (web/shot-shell.js recorded: the shell the record names, else the one Hits would assume, with the record's liner).
   The replay viewer keeps the map, the other vehicles and the tracers. Its camera follows Hits' camera every frame: the
   viewer's frame is the target's own with z mirrored (viewer.js Viewer.points), so the replay camera's world matrix is
   (the target's drawn pose) x mirror x (Hits' camera); the field of view, zoom and lens shift are copied. The camera is
   held in the target's frame: during the episode it rides with the target, at the hit it stands where Hits puts it. The
   replay's own drawing of the target is veiled (invisible, its shadow kept: playback.js veil). In the shot view the
   replay's frame runs as a task of Hits' frame loop (web/frame.js) between Hits' camera and Hits' render, so the map and
   the model move in the same frame.

   The episode: the battle from 2 s before the shot, at 1/4 speed (the brief's figure; the user's speed is not changed and
   comes back on leaving), stopped at the hit (the row's hit event; a shot with no hit: its tracer's end) with the hit line
   shown from then on (viewer.holdShot before the hit). Replay episode: the same again, the camera left where it is. Leave
   (or Esc): the replay's own camera orbits the target from where the shot view's eye was.

   A replay file Bullba Hits has no battle of (another player's replay): in the game the mod makes that battle from the
   replay by its own replay route (hitsBattleMade: 'prepareBattle' with the file's id), and the view is then the same as for
   a recorded battle. What cannot be had (outside the game; a replay the route refuses; a shot with no hit; a hit the
   battle does not list; a scene without its models) is not made up: the episode plays with the replay's camera at the
   tracer's start looking along it, and the bar says what is missing.

   BullbaShotView.create(o) -> {open(row), close(), active(), drives(), free(), want(), place(t), clamp(t0, t1), state()};
   o: {view (the element the replay's canvas is in), camera, battle, hitsBattle (Hits' battle id or null), dataBase,
   vehicle(id), name(id), clock(t), seek(t), play(on), speed(v | null), orbit(eye, at) (scene coordinates), veil(r, on),
   frame(T) (the replay's frame body)}. */
(function (root) {
  'use strict';
  var T = root.THREE;
  var BEFORE = 2, SLOW = 0.25;   // s before the shot; the episode's speed (the brief: "slow motion", 1/4 a guess)
  var ORDER = 55;                // Hits' frame loop: after 'layout' (50), before Hits' 'render' (60), after its 'camera' (20)
  // Hits' look of the heat map: the user's own settings of Bullba Hits (its remembered box, 'bullba-settings', which both
  // file:// pages share) where they are, else the defaults Hits' page carries (web/index.html, the controls of these ids).
  var HITS_LOOK = { 'armor-mode': 'damage', palette: 'classic', 'soft-lighting': true, 'light-strength': '200', wireframe: true,
    'outline-brightness': '15', 'outline-opacity': '6', 'track-opacity': '20', 'impact-opacity': '90', 'bounce-mode': 'always',
    'ricochet-tint-on': true, 'ricochet-tint': '50', 'ricochet-dots-on': true, 'ricochet-dots': '3', 'part-edges': 'on',
    'zone-outline': 'off', 'heatmap-quality': 'auto' };
  function hitsLook() {
    var out = {}, box = null;
    try { box = JSON.parse(root.localStorage.getItem('bullba-settings') || 'null'); } catch (e) { box = null; }
    var v = box && box.values && typeof box.values === 'object' ? box.values : {};
    Object.keys(HITS_LOOK).forEach(function (k) { out[k] = typeof v[k] === typeof HITS_LOOK[k] ? v[k] : HITS_LOOK[k]; });
    return out;
  }
  function num(s, d) { var n = Number(s); return isFinite(n) ? n : d; }
  // The row's hit as the panel's row shows it (shots-panel.js shownHit: the one with damage, else the last); null: none
  function shownHit(row) { return row.hits && row.hits.length ? root.BullbaShotsPanel.shownHit(row) : null; }
  function node(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

  function create(o) {
    var Data = root.ArmorInspectorData, F = root.BullbaFrame;
    if (Data && Data.setBase) Data.setBase(o.dataBase || '');
    var S = { row: null, mode: null, start: 0, stop: null, hitT: null, armed: false, target: null, held: null, viewer: null,
      error: null, note: '', hits: null, data: null, rec: null, aim: null, token: 0, A: new T.Matrix4(), haveA: false };
    var Z = new T.Matrix4().makeScale(1, 1, -1), M = new T.Matrix4(), scaleTmp = new T.Vector3(), V3 = new T.Vector3();
    var hitsBattles = {};
    // ---- the bar: what is shown, Replay episode, Leave ---------------------------------------------------------------
    var bar = node('div', undefined, 'panel sv-bar'), title = node('span', '', 'sv-title'), note = node('div', '', 'sv-note');
    var again = node('button', 'Replay episode', 'sv-again'), leave = node('button', 'Leave', 'sv-leave');
    again.type = leave.type = 'button';
    again.title = 'Replay episode\nPlays the shot again from ' + BEFORE + ' s before it, slowed down, and stops at the hit.\n• The camera stays where you put it';
    leave.title = 'Leave the shot view\nBack to the battle view: the free camera and your speed.\n• Esc does the same';
    again.onclick = function () { episode(); };
    leave.onclick = function () { close(); };
    bar.appendChild(title); bar.appendChild(again); bar.appendChild(leave); bar.appendChild(note); bar.hidden = true;
    document.body.appendChild(bar);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.row) { close(); e.preventDefault(); } });
    // ---- Hits' viewer, over the replay's canvas -------------------------------------------------------------------------
    var layer = node('div', undefined, 'sv-layer'); layer.tabIndex = 0; layer.hidden = true; o.view.appendChild(layer);
    function viewer() {
      if (S.viewer) return S.viewer;
      S.viewer = new root.ArmorViewer(layer);
      S.viewer.grid.visible = false;
      return S.viewer;
    }
    // Hits' look (its setters, as Hits' page calls them from its controls)
    function applyLook(v) {
      var L = hitsLook(), game = !!(root.BullbaHost && root.BullbaHost.game);
      v.setLighting(!!L['soft-lighting']); v.setLightStrength(num(L['light-strength'], 200) / 100);
      v.wireframe(!!L.wireframe); v.setOutline(num(L['outline-brightness'], 15) / 100, num(L['outline-opacity'], 6) / 100);
      v.setTrackOpacity(num(L['track-opacity'], 20) / 100); v.setImpactOpacity(num(L['impact-opacity'], 90) / 100);
      v.setBounceMode(L['bounce-mode']); v.setTint(L['ricochet-tint-on'] ? num(L['ricochet-tint'], 50) / 100 : 0);
      v.setDots(!!L['ricochet-dots-on'], L['ricochet-dots']); v.setPartEdges(L['part-edges'] === 'on'); v.setZoneOutline(L['zone-outline'] === 'on');
      v.setQuality(game && L['heatmap-quality'] === 'high' ? 'auto' : L['heatmap-quality']);   // Hits refuses 'high' in the game too
      return L;
    }
    var task = F ? F.task(ORDER, 'replay frame', function (time) { if (!drives()) return; o.frame(time); task.want(); }) : null;
    function drives() { return S.mode === 'hits'; }
    function want() { if (task) task.want(); }
    // ---- opening a row ----------------------------------------------------------------------------------------------------
    function open(row) {
      close(true);
      var h = shownHit(row), tok = ++S.token;
      S.row = row; S.hitT = h ? h.t : null;
      S.stop = h ? h.t : (row.shot ? row.shot.tEnd : row.t);
      S.start = Math.max(0, row.t - BEFORE);
      S.target = h ? h.target : row.target;
      S.mode = 'wait'; S.error = null; S.data = null; S.rec = null; S.aim = null; S.haveA = false;
      title.textContent = 'Shot view · ' + o.name(row.shooter) + ' → ' + (S.target == null ? 'no hit in the replay' : o.name(S.target)) + ' · ' + o.clock(row.t);
      note.textContent = 'Preparing the shot view…'; bar.hidden = false;
      o.play(false); o.seek(S.start);
      return hitsScene(row, h).then(function (got) {
        if (tok !== S.token || !got) return;
        if (got.data) showHits(got); else showReplay(got.why);
        episode();
      }).catch(function (e) {
        if (tok !== S.token) return;
        S.error = String(e && e.message || e); showReplay('the shot view could not be made: ' + S.error); episode();
      });
    }
    // The hit's scene from Bullba Hits' record of this battle - or why there is none
    // A replay file Bullba Hits has no battle of yet (19.11, the owner: the shot view for any replay the viewer opens): the
    // mod makes that battle from the replay by its own route ('prepareBattle' with the file's id -> Exporter.request_battle
    // -> request_replay_battle -> the 'replay' job), and the index lists it when it is there. Waited for here (a look at
    // data/index.js every MADE_LOOK ms, MADE_MS at most); outside the game nobody can make it.
    var MADE_LOOK = 2000, MADE_MS = 300000, asked = {};
    function hitsBattleMade(tok) {
      var id = o.battleId, H = root.BullbaHost;
      if (!id || id.indexOf('f-') !== 0) return Promise.resolve({ why: 'Bullba Hits has no battle of this replay' });
      if (!(H && H.game && H.canSend && H.canSend())) return Promise.resolve({ why: 'Bullba Hits has no battle of this replay file yet: the mod makes it from the replay in the game' });
      if (!asked[id]) { asked[id] = true; H.send('bullba_hits', { action: 'prepareBattle', battleId: id }).catch(function (e) { console.warn('Bullba Hits prepareBattle failed: ' + e.message); }); }
      note.textContent = 'Bullba Hits is making its battle from this replay (the shell, the armour, every hit’s scene)…';
      var began = Date.now();
      return new Promise(function (ok) {
        (function look() {
          if (tok !== S.token) return ok({ why: 'left' });
          Data.index().then(function (ix) {
            var row = ((ix && ix.battles) || []).filter(function (b) { return b && b.id === id; })[0];
            if (row && !row.stale) { o.hitsBattle = id; delete hitsBattles[id]; return ok(null); }
            if (Date.now() - began > MADE_MS) return ok({ why: 'Bullba Hits did not make its battle from this replay within ' + MADE_MS / 60000 + ' min' });
            note.textContent = 'Bullba Hits is making its battle from this replay… ' + Math.round((Date.now() - began) / 1000) + ' s';
            setTimeout(look, MADE_LOOK);
          }, function () { setTimeout(look, MADE_LOOK); });
        })();
      });
    }
    function hitsScene(row, h) {
      var meta = o.battle.meta || {};
      if (!h) return Promise.resolve({ why: 'the replay names no vehicle this shot hit' });
      if (!o.hitsBattle) return hitsBattleMade(S.token).then(function (w) { return w || hitsScene(row, h); });
      if (h.attacker == null) return Promise.resolve({ why: 'the replay does not name the shooter' });
      if (!Number.isFinite(meta.serverStart)) return Promise.resolve({ why: 'the replay has no server start: its hits cannot be matched to the record' });
      var id = o.hitsBattle, read = hitsBattles[id] || (hitsBattles[id] = Data.battle(id).catch(function (e) { delete hitsBattles[id]; throw e; }));
      return read.then(function (battle) {
        var at = meta.serverStart + h.t, hit = Data.hitAt(battle, at, h.attacker, h.target);
        if (!hit) return { why: 'Bullba Hits’ record of this battle has no hit by this shooter on this target within ' + Data.HIT_AT + ' s of it' };
        return Data.scene(battle, hit.id, 'replay').then(function (data) {
          if (data.geometryIncomplete) return { why: data.geometryError || 'the scene of this hit is incomplete' };
          return { data: data, battle: battle, hit: hit };
        });
      });
    }
    function showHits(got) {
      var v = viewer(), data = got.data, hit = data.hit;
      layer.hidden = false; v.resize();
      var look = applyLook(v);
      var rec = root.BullbaShotShell.recorded(hit, got.battle);
      v.load(data, rec.context);
      var mode = look['armor-mode'];
      v.configure(rec.shell, mode !== 'parts', look.palette, mode);
      // Hits' rule (app.js display): the recorded circles only for the player's own shot; else Hits' estimate
      var own = hit.attackerId === got.battle.playerVehicleId;
      var ready = v.setShotContext(own ? rec.context : null), estimate = ready ? null : v.setAimEstimate(rec.context);
      v.root.traverse(function (x) { if (x.userData && x.userData.horizon) x.visible = false; });   // the map has its own horizon
      v.holdShot(true);
      // until the replay draws the target (out of sight: no pose), its pose is the record's (worldTransform, game axes):
      // scene = mirror x world x mirror x Hits' frame
      var W = hit.target && hit.target.worldTransform;
      if (Array.isArray(W) && W.length === 16) { S.A.multiplyMatrices(Z, M.fromArray(W)).multiply(Z); S.haveA = true; }
      S.mode = 'hits'; S.data = data; S.rec = rec; S.hits = got;
      S.aim = ready ? 'recorded' : estimate ? (estimate.rebuilt ? 'rebuilt' : 'nominal') : null;
      var c = rec.choice, lines = [];
      lines.push(rec.shell ? 'Heat map: ' + (c && c.name ? c.name + ', ' : '') + Math.round(rec.shell.penetration) + ' mm at ' + Math.round(rec.range) + ' m - nominal, not the rolled value' +
        (rec.guess ? ' (assumed: the record does not name this shot’s shell)' : '') : 'No heat map: the record holds no shell for this shot');
      lines.push(S.aim === 'recorded' ? 'Aim circles: the player’s own, recorded' : S.aim === 'rebuilt' ? 'Aim circle: estimate rebuilt from the replay (dashed), not a recorded one' :
        S.aim === 'nominal' ? 'Aim circle: nominal estimate (dashed) - the gun’s dispersion x range, no crew or equipment; the replay has no reticle of this shooter' :
          'No aim circle: ' + (!(hit.attacker && hit.attacker.gunDispersion > 0) ? 'no gun dispersion in the record' : 'no range for this hit'));
      note.textContent = lines.join(' · ');
      note.title = 'Bullba Hits’ view of this hit\nThe target as Bullba Hits draws it, from the scene rebuilt from the replay.\n• ' + lines.join('\n• ') +
        '\n• Drag: orbit the target · wheel: zoom · right or Ctrl + drag: pan · click: pin a point\n• Hits’ model is drawn over the map: ground in front of it does not hide it';
      place(null);
      want();
    }
    function showReplay(why) {
      layer.hidden = true;
      S.mode = 'replay'; S.note = why;
      var row = S.row, s = row.shot, eye = s ? s.start : null, at = s ? s.end : null;
      if (!eye || !at) {
        var a = o.vehicle(row.shooter), b = S.target == null ? null : o.vehicle(S.target);
        // the vehicles' groups stand in the root's game axes, as the tracers do
        if (a && b) { eye = [a.group.position.x, a.group.position.y + 2, a.group.position.z]; at = [b.group.position.x, b.group.position.y + 1.5, b.group.position.z]; }
      }
      if (eye && at) o.orbit(new T.Vector3(eye[0], eye[1], -eye[2]), new T.Vector3(at[0], at[1], -at[2]));
      note.textContent = 'No Bullba Hits view: ' + why + '. The episode plays with the replay’s camera at the shot’s start.';
      note.title = 'Why there is no heat map here\n' + why + '.\n• The camera stands at the tracer’s start, looking along it; no minimum height';
    }
    // ---- the episode ----------------------------------------------------------------------------------------------------
    function episode() {
      if (!S.row) return;
      o.seek(S.start); S.armed = true;
      if (S.viewer && S.mode === 'hits') S.viewer.holdShot(true);
      o.speed(SLOW); o.play(true);
    }
    // the replay's clock moved from t0 to t1 in a frame: the episode stops at the hit
    function clamp(t0, t1) {
      if (!S.row || !S.armed || S.stop == null || t1 < S.stop || t0 > S.stop) return t1;
      S.armed = false; o.play(false);
      return S.stop;
    }
    // the replay camera from Hits' camera (scene coordinates); true when it was placed. The hit line shows from the hit on.
    function place(t) {
      if (S.mode !== 'hits' || !S.viewer) return false;
      var r = S.target == null ? null : o.vehicle(S.target), v = S.viewer;
      if (r) {
        o.veil(r, true);
        if (r.visible) { r.group.updateWorldMatrix(true, false); S.A.multiplyMatrices(r.group.matrixWorld, Z); S.haveA = true; }
      }
      if (!S.haveA) return false;
      if (t != null && S.hitT != null) { var held = t < S.stop - 1e-6; if (held !== S.held) { S.held = held; v.holdShot(held); } }
      var c = o.camera, vc = v.camera;
      M.multiplyMatrices(S.A, vc.matrixWorld); M.decompose(c.position, c.quaternion, scaleTmp);
      c.fov = vc.fov; c.zoom = vc.zoom;
      if (vc.view && vc.view.enabled) c.setViewOffset(vc.view.fullWidth, vc.view.fullHeight, vc.view.offsetX, vc.view.offsetY, vc.view.width, vc.view.height); else c.clearViewOffset();
      c.updateProjectionMatrix(); c.updateMatrixWorld();
      return true;
    }
    function close(reopen) {
      var was = S.mode, r = S.target == null ? null : o.vehicle(S.target);
      S.token++;
      if (was === 'hits' && S.viewer) {
        // the replay's camera orbits the target from where the shot view's eye was
        var eye = o.camera.position.clone(), at = S.haveA ? V3.copy(S.viewer.target).applyMatrix4(S.A).clone() : null;
        var c = o.camera; c.fov = 55; c.zoom = 1; c.clearViewOffset(); c.updateProjectionMatrix();
        if (at) o.orbit(eye, at);
        S.viewer.clear();
      }
      if (r) o.veil(r, false);
      layer.hidden = true;
      S.mode = null; S.row = null; S.armed = false; S.held = null; S.haveA = false; S.data = null; S.rec = null;
      if (!reopen) { bar.hidden = true; if (was) o.speed(null); }
    }
    function state() {
      var v = S.viewer, sf = v && v.surface;
      return { open: !!S.row, mode: S.mode, start: S.start, stop: S.stop, hitT: S.hitT, armed: S.armed, aim: S.aim, error: S.error, note: note.textContent,
        hit: S.hits && S.hits.hit ? S.hits.hit.id : null,
        pose: S.viewer && S.viewer.loadedData ? S.viewer.poseNow() : null, shell: S.rec && S.rec.shell ? { kind: S.rec.shell.kind, penetration: S.rec.shell.penetration, guess: S.rec.guess } : null,
        composed: !!(sf && sf.quad && sf.quad.visible), faces: sf && sf.mesh && sf.mesh.geometry && sf.mesh.geometry.attributes.position ? sf.mesh.geometry.attributes.position.count / 3 : 0,
        ricochetLeg: !!(sf && sf.bounce), shotHeld: !!(v && v.shotHeld), backend: v ? v.backendShown : null };
    }
    return { open: open, close: function () { close(false); }, active: function () { return !!S.row; }, drives: drives, want: want,
      free: function () { return S.mode === 'replay'; }, place: place, clamp: clamp, state: state, viewer: function () { return S.viewer; },
      layer: layer, bar: bar };
  }
  root.BullbaShotView = { create: create, BEFORE: BEFORE, SLOW: SLOW };
})(window);
