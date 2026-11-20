/* THE SHOT VIEW of the replay viewer (19.11.2026, NOTEBOOK N5, BACKLOG 109; redone 20.11.2026, NOTEBOOK R1): a row of the
   shots panel shows that shot as Bullba Hits shows a shot - in the battle's own scene, one picture.

   The target is THIS PAGE'S vehicle (playback.js: its collision model, at its place and pose on the map, in this page's
   renderer and camera, hidden by the ground, the buildings and the other vehicles like anything else), painted by Bullba
   Hits' rules. What is Bullba Hits' and is used as it is, not copied:
   - Hits' viewer (web/viewer.js ArmorViewer) in its HOSTED mode: no canvas, no camera and no input of its own - this page's
     renderer, this page's camera seen from the viewer's frame (hostCamera), its frame run inside this page's (paint). It
     loads the hit's scene, builds Hits' ballistic engine (web/ballistics.js) in the pose this page draws the target in
     (partTransforms -> hostPose: Hits' own drag-then-commit path), and composes Hits' heat map (web/screen-armor.js
     Surface: the layers, the chance or damage palette, the ricochet leg, its tint and dots, the seams) for THIS camera's eye
     into a texture of this canvas's size (Surface.markInto). The target's meshes are then drawn with PAINT, which reads that
     texture at the fragment's own pixel: the map lies exactly on this page's drawing of the vehicle at any zoom, size or
     pixel ratio, never outside it, and the depth test hides it wherever the map stands in front.
   - Hits' marks of the hit (the hit line through the model, its crosses, the aim circles, a pinned line) are the viewer's
     own objects, drawn over this page's picture (overlay) in two passes: where the target is on screen (stencil 1, written
     by PAINT) through the model as Hits draws them; elsewhere depth-tested against the map, so a wall or the ground in
     front hides them.
   - A click on the target pins a point (Hits' pinAt, through this camera), read in Hits' own words (web/armor-line.js).
   - the hit's scene rebuilt from the replay (web/local-data.js scene(battle, id, 'replay')), found by local-data.js hitAt;
     the shot's tracer, stop and aim blocks (web/shot-context.js) and the shell at the hit's range (web/shot-shell.js).
   Parts of the target this page does not draw (an outer track pair, an armoured prefab) are drawn for the shot view from
   the scene's own models (extras), so the paint and the geometry agree.

   The eye: Hits' focus (the shell's axis at its origin, looking at the vehicle) mapped into the scene by the target's pose
   at the hit (the record's world transform), then this page's own free camera (orbit, pan, wheel, keys; no ground floor).
   The shot's corridor (CORRIDOR): map objects and other vehicles the line from the eye to the hit passes through are not
   drawn while the view is open (the shell reached the target: nothing solid stood there), given back on Leave; the
   terrain never - where it crosses the line the bar says so. Objects off the line occlude as anywhere.
   The shooter: while the eye is inside it (INSIDE: its hull, turret or gun box grown by INSIDE metres) it is veiled - not
   drawn, its shadow kept; flown out of it, it is drawn again.
   The episode: the battle from 2 s before the shot, at 1/4 speed, stopped at the hit (the row's hit event; a shot with no
   hit: its tracer's end) with the hit line shown from then on. Replay episode: the same, the camera left where it is.
   The lens: Hits' field of view and the zoom Hits' Fit picks for that eye (the target framed for reading the map, the eye
   not moved); the wheel zooms by Hits' rule, Fit frames again; dragging orbits round the target as in the battle view.
   Leave (or Esc): the mode's exit (exit()) - the lens, the user's speed, the target's look, the shooter as before. Each opening writes one line of the episode's frame
   times to the mod's log in the game (o.log).

   A replay file Bullba Hits has no battle of: the mod makes it from the replay ('prepareBattle' with the file's id).
   What cannot be had (outside the game; a replay the route refuses; a shot with no hit; a hit the battle does not list; a
   scene without its models; no WebGL 2) is not made up: the episode plays and the bar says what is missing.

   BullbaShotView.create(o) -> {open(row), close(), active(), free(), paint(t, now), overlay(), clamp(t0, t1), state()};
   o: {view (the element the canvas is in), camera, renderer, battle, hitsBattle, battleId, dataBase, vehicle(id), name(id),
   clock(t), seek(t), play(on), speed(v | null), orbit(eye, at) (scene coordinates), veil(r, on), look(r, material | null),
   log(line)}. */
(function (root) {
  'use strict';
  var T = root.THREE;
  var BEFORE = 2, SLOW = 0.25;   // s before the shot; the episode's speed (the brief: "slow motion", 1/4 a guess)
  // The shooter is not drawn while the eye is within INSIDE m of its hull, turret or gun box (each in its own frame). 0.5 m:
  // Hits' eye stands 0.30 m past the muzzle on the shell's axis (the test's figure), so it starts inside; a step away
  // from the vehicle shows it again.
  var INSIDE = 0.5;
  // CORRIDOR: the radius (m) of the tube round the shot's line from the eye to the hit inside which map objects and other
  // vehicles are not drawn while the view is open (playback.js shotCorridorOpen) - the shell passed there, so nothing solid
  // stood on it. 0.6 m: a shell is under 0.2 m wide, and a little more leaves no plank or post at the gun cutting the view;
  // the target's own half-size (1.5-2 m) would clear whole house walls beside the line.
  var CORRIDOR = 0.6;
  // Hits' look of the heat map: the user's own settings of Bullba Hits (its remembered box, 'bullba-settings', which both
  // file:// pages share) where they are, else the defaults Hits' page carries (web/index.html, the controls of these ids).
  var HITS_LOOK = { 'armor-mode': 'damage', palette: 'classic', 'soft-lighting': true, 'light-strength': '200',
    'track-opacity': '20', 'impact-opacity': '90', 'bounce-mode': 'always',
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
  // PAINT: Hits' composed map (premultiplied, Surface.markInto) at this fragment's pixel over Hits' neutral grey (viewer.js
  // baseColors[0], as it shows on screen) where the map has nothing; unlit, as Hits draws it. Writes stencil 1: the
  // overlay's "on the target" test. GLSL 3 - the map exists only on WebGL 2, and without it the target keeps its own look.
  var PAINT_VERTEX = 'precision highp float;\nin vec3 position;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\n' +
    'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
  var PAINT_FRAGMENT = 'precision highp float;\nuniform highp sampler2D uPaint;\nuniform vec3 uBase;\nout vec4 outColor;\n' +
    'void main(){vec4 p=texelFetch(uPaint,ivec2(gl_FragCoord.xy),0);outColor=vec4(p.rgb+uBase*(1.0-p.a),1.0);}';

  function create(o) {
    var Data = root.ArmorInspectorData;
    if (Data && Data.setBase) Data.setBase(o.dataBase || '');
    var S = { row: null, mode: null, start: 0, stop: null, hitT: null, armed: false, target: null, held: null, viewer: null,
      error: null, note: '', hits: null, data: null, rec: null, aim: null, token: 0, haveA: false, veiled: false, extras: [],
      frames: [], lastNow: null, logged: false, look: null };
    var Z = new T.Matrix4().makeScale(1, 1, -1), M = new T.Matrix4(), N = new T.Matrix4(), A = new T.Matrix4(), AInv = new T.Matrix4();
    var V3 = new T.Vector3(), scaleTmp = new T.Vector3(), box = new T.Box3(), size = new T.Vector2();
    var hitsBattles = {};
    // ---- the bar: what is shown, Replay episode, Leave; the pinned point's reading --------------------------------------
    var bar = node('div', undefined, 'panel sv-bar'), title = node('span', '', 'sv-title'), note = node('div', '', 'sv-note');
    var again = node('button', 'Replay episode', 'sv-again'), leave = node('button', 'Leave', 'sv-leave'), fit = node('button', 'Fit', 'sv-fit');
    var pin = node('div', undefined, 'sv-pin'), pinLabel = node('b', '', 'sv-pin-label'), pinChips = node('span', '', 'sv-pin-chips'), unpin = node('button', '×', 'sv-unpin');
    again.type = leave.type = unpin.type = fit.type = 'button';
    fit.title = 'Fit\nFrames the target as Bullba Hits frames it: the lens zooms, the eye stays where it is.\n• The wheel zooms in and out (the lens, as in Bullba Hits)';
    fit.onclick = function () { fitLens(); };
    again.title = 'Replay episode\nPlays the shot again from ' + BEFORE + ' s before it, slowed down, and stops at the hit.\n• The camera stays where you put it';
    leave.title = 'Leave the shot view\nBack to the battle view: the free camera and your speed.\n• Esc does the same';
    unpin.title = 'Unpin\nDrops the pinned line: the recorded hit line comes back.';
    pin.title = 'Pinned line\nBullba Hits’ reading of the line from the camera through the point you clicked on the target.';
    again.onclick = function () { episode(); };
    leave.onclick = function () { close(); };
    unpin.onclick = function () { if (S.viewer) S.viewer.unpin(); };
    pin.appendChild(pinLabel); pin.appendChild(pinChips); pin.appendChild(unpin); pin.hidden = true;
    bar.appendChild(title); bar.appendChild(fit); bar.appendChild(again); bar.appendChild(leave); bar.appendChild(note); bar.appendChild(pin); bar.hidden = true;
    document.body.appendChild(bar);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.row) { close(); e.preventDefault(); } });
    // ---- Hits' viewer, hosted on this page's renderer and camera -------------------------------------------------------
    var paintRT = null;
    var paintMat = new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: PAINT_VERTEX, fragmentShader: PAINT_FRAGMENT, side: T.DoubleSide,
      uniforms: { uPaint: { value: null }, uBase: { value: new T.Vector3(0.38, 0.46, 0.54) } },
      stencilWrite: true, stencilRef: 1, stencilFunc: T.AlwaysStencilFunc, stencilZPass: T.ReplaceStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });
    paintMat.userData.shotPaint = true;
    // the texture the map is composed into: this canvas's drawing buffer, texel for texel
    function paintTarget() {
      o.renderer.getDrawingBufferSize(size);
      var w = Math.max(1, size.x), h = Math.max(1, size.y);
      if (!paintRT) { paintRT = new T.WebGLRenderTarget(w, h, { type: T.UnsignedByteType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false, stencilBuffer: false }); paintRT.texture.generateMipmaps = false; }
      else if (paintRT.width !== w || paintRT.height !== h) paintRT.setSize(w, h);
      paintMat.uniforms.uPaint.value = paintRT.texture;
      return paintRT;
    }
    // this page's camera in the viewer's frame: A maps the viewer's frame (the target's own, z mirrored) into the scene
    function hostCamera(c) {
      if (!S.haveA) return;
      var cam = o.camera; cam.updateMatrixWorld();
      M.multiplyMatrices(AInv, cam.matrixWorld); M.decompose(c.position, c.quaternion, scaleTmp); c.scale.set(1, 1, 1);
      c.fov = cam.fov; c.aspect = cam.aspect; c.zoom = cam.zoom; c.near = cam.near; c.far = cam.far;
      if (cam.view && cam.view.enabled) c.setViewOffset(cam.view.fullWidth, cam.view.fullHeight, cam.view.offsetX, cam.view.offsetY, cam.view.width, cam.view.height); else c.clearViewOffset();
      c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    }
    var host = { renderer: o.renderer, camera: hostCamera, paintTarget: paintTarget, want: function () {} };
    function viewer() {
      if (S.viewer) return S.viewer;
      S.viewer = new root.ArmorViewer(o.view, host);
      S.hitsFov = S.viewer.camera.fov;   // Hits' lens (38°), before the host's camera is copied into it
      S.viewer.grid.visible = false;
      S.viewer.onPin = pinShown;
      return S.viewer;
    }
    // Hits' look (its setters, as Hits' page calls them from its controls); the model's wireframe is not drawn - this page's
    // model carries the seams of its parts, and the map its own
    function applyLook(v) {
      var L = hitsLook(), game = !!(root.BullbaHost && root.BullbaHost.game);
      v.setLighting(!!L['soft-lighting']); v.setLightStrength(num(L['light-strength'], 200) / 100);
      v.wireframe(false);
      v.setTrackOpacity(num(L['track-opacity'], 20) / 100); v.setImpactOpacity(num(L['impact-opacity'], 90) / 100);
      v.setBounceMode(L['bounce-mode']); v.setTint(L['ricochet-tint-on'] ? num(L['ricochet-tint'], 50) / 100 : 0);
      v.setDots(!!L['ricochet-dots-on'], L['ricochet-dots']); v.setPartEdges(L['part-edges'] === 'on'); v.setZoneOutline(L['zone-outline'] === 'on');
      v.setQuality(game && L['heatmap-quality'] === 'high' ? 'auto' : L['heatmap-quality']);   // Hits refuses 'high' in the game too
      return L;
    }
    // ---- a click on the target: Hits' pin ----------------------------------------------------------------------------------
    var press = null, canvas = o.renderer.domElement;
    // THE WHEEL ZOOMS in the shot view, by Bullba Hits' wheel rule (ArmorViewer.wheelStep, clampZoom): the lens, not the
    // distance - the eye stays at the shot's origin. Caught before this page's own wheel (the orbit distance).
    canvas.addEventListener('wheel', function (e) {
      if (!S.row || S.mode !== 'hits') return;
      e.preventDefault(); e.stopImmediatePropagation();
      var k = root.ArmorViewer.wheelStep(e, 1); if (!k) return;
      o.camera.zoom = root.ArmorViewer.clampZoom(o.camera.zoom * Math.exp(-k)); o.camera.updateProjectionMatrix();
    }, { capture: true, passive: false });
    canvas.addEventListener('pointerdown', function (e) { press = S.mode === 'hits' && e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey ? { x: e.clientX, y: e.clientY } : null; });
    canvas.addEventListener('pointerup', function (e) {
      var p = press; press = null;
      if (!p || S.mode !== 'hits' || !S.viewer || !S.haveA || Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 3) return;
      S.viewer.resize(); S.viewer.placeCamera(); S.viewer.pinAt(e);
    });
    function pinShown() {
      var v = S.viewer, r = v && v.pinned ? v.pinResult : null;
      pin.hidden = !(v && v.pinned);
      if (pin.hidden) return;
      var shell = v.shell, L = S.look || hitsLook(), mode = L['armor-mode'] === 'damage' && shell && shell.alpha > 0 ? 'damage' : 'chance', tint = L['ricochet-tint-on'] ? num(L['ricochet-tint'], 50) / 100 : 0;
      var line = root.BullbaArmorLine.line(r, shell ? shell.penetration : null, S.rec ? S.rec.range : null, { damage: mode === 'damage', shell: shell,
        parts: S.data && S.data.hit.target ? S.data.hit.target.parts : null,
        rgb: function (x) { return 'rgb(' + root.ArmorBallistics.color(x, L.palette, tint, mode).map(function (c) { return Math.round(c * 255); }).join(',') + ')'; } });
      pinLabel.textContent = line.label; pinLabel.style.color = line.color;
      pinChips.replaceChildren(); line.groups.forEach(function (g) { var c = node('span', g.text, 'chip ' + g.kind); if (g.title) c.title = g.title; pinChips.appendChild(c); });
    }
    // ---- THE MODE: its entry and its exit, the one place what the shot view changes in this page is set and put back ------
    // Entry: the camera's lens as it was (fov, zoom, near, far) kept; the shot view then sets Hits' lens (HITS_FOV, the
    // zoom of Hits' Fit), the clock (the episode, its speed), the eye. Exit: the lens, the user's speed, the target's own
    // look, the shooter, no Hits marks - nothing of the mode stays in the battle view. (A mode that draws less of the map
    // to keep the frame rate would be switched on in enter() and off in exit().)
    function enter() {
      if (S.saved) return;
      var c = o.camera; S.saved = { fov: c.fov, zoom: c.zoom, near: c.near, far: c.far };
    }
    function exit() {
      if (!S.saved) return;
      var c = o.camera, k = S.saved; c.fov = k.fov; c.zoom = k.zoom; c.near = k.near; c.far = k.far; c.updateProjectionMatrix();
      S.saved = null;
      // nothing of the mode stays allocated: the paint target goes (Hits' composition went with viewer.clear)
      if (paintRT) { paintRT.dispose(); paintRT = null; paintMat.uniforms.uPaint.value = null; }
    }
    // Hits' lens on this camera where it stands: Hits' field of view and the zoom of Hits' Fit (viewer.js hostFit)
    function fitLens() {
      var v = S.viewer, c = o.camera;
      if (S.mode !== 'hits' || !v || !S.haveA) return;
      c.fov = S.hitsFov; c.zoom = 1; c.updateProjectionMatrix(); if (o.place) o.place(); c.updateMatrixWorld();
      var z = v.hostFit();
      c.zoom = z > 0 ? z : 1; c.updateProjectionMatrix();
    }
    // ---- opening a row ----------------------------------------------------------------------------------------------------
    function open(row) {
      close(true);
      enter();
      var h = shownHit(row), tok = ++S.token;
      S.row = row; S.hitT = h ? h.t : null;
      S.stop = h ? h.t : (row.shot ? row.shot.tEnd : row.t);
      S.start = Math.max(0, row.t - BEFORE);
      S.target = h ? h.target : row.target;
      S.mode = 'wait'; S.error = null; S.data = null; S.rec = null; S.aim = null; S.haveA = false; S.frames = []; S.lastNow = null; S.logged = false;
      title.textContent = 'Shot view · ' + o.name(row.shooter) + ' → ' + (S.target == null ? 'no hit in the replay' : o.name(S.target)) + ' · ' + o.clock(row.t);
      note.textContent = 'Preparing the shot view…'; bar.hidden = false; pin.hidden = true;
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
    // ---- the target's parts as this page draws them --------------------------------------------------------------------
    function mat(a) { return new T.Matrix4().fromArray(a); }
    function shift(p) { return new T.Matrix4().makeTranslation(-p[0], -p[1], -p[2]); }
    function partOf(parts, id) { for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].id === id) return parts[i]; return null; }
    // Whether this page's model of the target is the scene's (the same collision model for the turret and the gun): only
    // then is the pose read off this page's drawing.
    function sameModel(r, parts) {
      var R = r.md && r.md.rest;
      return !!(R && r.turret && r.gun && R[2] && R[3] && [2, 3].every(function (id) { var p = partOf(parts, id); return p && p.transform && (!p.modelKey || !R[id].modelKey || p.modelKey === R[id].modelKey); }));
    }
    // {part id: transform} in the record's convention (the game's axes, the vehicle's frame) of the target as this page
    // draws it now (playback.js buildVehicles / vehicleModel): the hull's parts at rest, the turret about its pivot by this
    // page's turret yaw, the gun by its pitch, a prefab riding its parent as the record had it on that parent.
    function partTransforms(r, parts) {
      var R = r.md.rest, out = {};
      r.turret.updateMatrix(); r.gun.updateMatrix();
      var n2 = new T.Matrix4().multiplyMatrices(r.turret.matrix, shift(r.md.turretAt)).multiply(mat(R[2].transform));
      var g = R[3].transform, n3 = new T.Matrix4().multiplyMatrices(r.turret.matrix, r.gun.matrix).multiply(shift([g[12], g[13], g[14]])).multiply(mat(g));
      var by = { 2: n2, 3: n3 };
      (r.md.drawn || []).forEach(function (id) { if (id !== 2 && id !== 3 && R[id] && partOf(parts, id)) out[id] = R[id].transform.slice(); });
      out[2] = n2.toArray(); out[3] = n3.toArray();
      parts.forEach(function (p) {
        if (!p || p.id === 2 || p.id === 3 || !(p.parentPart === 2 || p.parentPart === 3) || !p.transform) return;
        var parent = partOf(parts, p.parentPart); if (!parent || !parent.transform) return;
        out[p.id] = new T.Matrix4().copy(by[p.parentPart]).multiply(mat(parent.transform).invert()).multiply(mat(p.transform)).toArray();
      });
      return out;
    }
    // The scene's parts this page does not draw (an outer track pair, an armoured prefab): meshes of their own for the shot
    // view, in the frame of what carries them here (the hull's group, the turret, the gun), drawn with PAINT.
    function addExtras(r, data) {
      var parts = data.hit.target.parts || [], drawn = r.md.drawn || [], R = r.md.rest || {};
      parts.forEach(function (p) {
        if (!p || drawn.indexOf(p.id) >= 0 || !p.transform) return;
        var model = data.models[String(p.id)]; if (!model || !model.groups) return;
        var carrier = r.group, local = mat(p.transform), parent = p.parentPart === 2 || p.parentPart === 3 ? partOf(parts, p.parentPart) : null;
        if (parent && parent.transform && R[p.parentPart] && (p.parentPart === 2 ? r.turret : r.gun)) {
          var rest = R[p.parentPart].transform, at = p.parentPart === 2 ? r.md.turretAt : [rest[12], rest[13], rest[14]];
          carrier = p.parentPart === 2 ? r.turret : r.gun;
          local = shift(at).multiply(mat(rest)).multiply(mat(parent.transform).invert()).multiply(mat(p.transform));
        }
        var pos = [], idx = [], e = local.elements;
        model.groups.forEach(function (gr) {
          var base = pos.length / 3, v = gr.v, n = v ? v.length / 3 : gr.vertices.length;
          for (var i = 0; i < n; i++) {
            var x = v ? v[i * 3] : gr.vertices[i][0], y = v ? v[i * 3 + 1] : gr.vertices[i][1], z = v ? v[i * 3 + 2] : gr.vertices[i][2];
            pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
          }
          gr.indices.forEach(function (k) { idx.push(base + k); });
        });
        if (!idx.length) return;
        var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeBoundingSphere();
        var mesh = new T.Mesh(geo, paintMat); mesh.castShadow = true; mesh.userData.shotExtra = p.id; mesh.visible = false;
        carrier.add(mesh); S.extras.push(mesh);
      });
    }
    function dropExtras() {
      S.extras.forEach(function (m) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); });
      S.extras = [];
    }
    // ---- the shooter: veiled while the eye is inside it --------------------------------------------------------------------
    function bodyOf(g, r) { for (var i = 0; i < g.children.length; i++) { var c = g.children[i]; if (c.isMesh && (c.material === r.mat || (c.material.userData && c.material.userData.shotPaint)) && !c.userData.shotExtra) return c; } return null; }
    function eyeInside(r) {
      var eye = o.camera.position;
      return [r.group, r.turret, r.gun].some(function (g) {
        var m = g && bodyOf(g, r); if (!m) return false;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        g.updateWorldMatrix(true, false);
        V3.copy(eye).applyMatrix4(N.copy(g.matrixWorld).invert());
        return box.copy(m.geometry.boundingBox).expandByScalar(INSIDE).containsPoint(V3);
      });
    }
    function showHits(got) {
      var v = viewer(), data = got.data, hit = data.hit, r = S.target == null ? null : o.vehicle(S.target);
      v.resize();
      var look = S.look = applyLook(v);
      var rec = root.BullbaShotShell.recorded(hit, got.battle);
      // the target's pose at the hit by the record (worldTransform, game axes): scene = mirror x world x mirror x viewer frame;
      // it stands the eye, and the viewer's camera until this page draws the target
      var W = hit.target && hit.target.worldTransform, Arec = null;
      if (Array.isArray(W) && W.length === 16) { Arec = new T.Matrix4().multiplyMatrices(Z, mat(W)).multiply(Z); A.copy(Arec); AInv.copy(A).invert(); S.haveA = true; }
      v.load(data, rec.context);
      var mode = look['armor-mode'];
      v.configure(rec.shell, mode !== 'parts', look.palette, mode);
      // Hits' rule (app.js display): the recorded circles only for the player's own shot; else Hits' estimate
      var own = hit.attackerId === got.battle.playerVehicleId;
      var ready = v.setShotContext(own ? rec.context : null), estimate = ready ? null : v.setAimEstimate(rec.context);
      v.root.traverse(function (x) { if (x.userData && x.userData.horizon) x.visible = false; });   // the map has its own horizon
      v.holdShot(true); S.held = true;
      S.mode = 'hits'; S.data = data; S.rec = rec; S.hits = got;
      S.posed = !!(r && sameModel(r, hit.target.parts || []));
      if (r && r.md && r.md.model) addExtras(r, data);
      // the eye where Hits' focus put Hits' camera, in the scene by the target's pose at the hit
      var at = v.target.clone(), eye = v.orbitEye(), Ae = Arec || (r && r.visible ? new T.Matrix4().multiplyMatrices(r.group.matrixWorld, Z) : null);
      if (Ae) o.orbit(eye.applyMatrix4(Ae), at.applyMatrix4(Ae));
      fitLens();
      // the shot's corridor: from the eye (placed by fitLens) to the hit point, by the target's pose at the hit
      S.corridor = null;
      if (Ae && v.point && o.corridor) { o.camera.updateMatrixWorld(); S.corridor = o.corridor.open(o.camera.position.clone(), v.point.clone().applyMatrix4(Ae), CORRIDOR); }
      S.aim = ready ? 'recorded' : estimate ? (estimate.rebuilt ? 'rebuilt' : 'nominal') : null;
      var c = rec.choice, lines = [];
      lines.push(rec.shell ? 'Heat map: ' + (c && c.name ? c.name + ', ' : '') + Math.round(rec.shell.penetration) + ' mm at ' + Math.round(rec.range) + ' m - nominal, not the rolled value' +
        (rec.guess ? ' (assumed: the record does not name this shot’s shell)' : '') : 'No heat map: the record holds no shell for this shot');
      lines.push(S.aim === 'recorded' ? 'Aim circles: the player’s own, recorded' : S.aim === 'rebuilt' ? 'Aim circle: estimate rebuilt from the replay (dashed), not a recorded one' :
        S.aim === 'nominal' ? 'Aim circle: nominal estimate (dashed) - the gun’s dispersion x range, no crew or equipment; the replay has no reticle of this shooter' :
          'No aim circle: ' + (!(hit.attacker && hit.attacker.gunDispersion > 0) ? 'no gun dispersion in the record' : 'no range for this hit'));
      if (!S.posed) lines.push('the target’s turret and gun as the record has them: this viewer’s model of it differs');
      if (S.corridor && S.corridor.hidden) lines.push(S.corridor.hidden + ' object' + (S.corridor.hidden > 1 ? 's' : '') + ' on the shot’s line not drawn');
      if (S.corridor && S.corridor.ground != null) lines.push('the ground crosses the shot’s line ' + S.corridor.ground + ' m from the eye: the replay’s positions and the shot disagree there');
      note.textContent = lines.join(' · ');
      note.title = 'Bullba Hits’ view of this hit\nThe target painted by Bullba Hits from the scene rebuilt from the replay, for the camera’s eye.\n• ' + lines.join('\n• ') +
        '\n• Click on the target: pin a line through that point (Bullba Hits’ reading below)\n• Drag, wheel and keys move the camera as in the battle view\n• The hit’s crosses are marks over the picture: the ground does not hide them, the line it does';
    }
    function showReplay(why) {
      S.mode = 'replay'; S.note = why;
      var row = S.row, s = row.shot, eye = s ? s.start : null, at = s ? s.end : null;
      if (!eye || !at) {
        var a = o.vehicle(row.shooter), b = S.target == null ? null : o.vehicle(S.target);
        // the vehicles' groups stand in the root's game axes, as the tracers do
        if (a && b) { eye = [a.group.position.x, a.group.position.y + 2, a.group.position.z]; at = [b.group.position.x, b.group.position.y + 1.5, b.group.position.z]; }
      }
      if (eye && at) o.orbit(new T.Vector3(eye[0], eye[1], -eye[2]), new T.Vector3(at[0], at[1], -at[2]));
      note.textContent = 'No Bullba Hits view: ' + why + '. The episode plays with the camera at the shot’s start.';
      note.title = 'Why there is no heat map here\n' + why + '.\n• The camera stands at the tracer’s start, looking along it; no minimum height';
    }
    // ---- the episode ----------------------------------------------------------------------------------------------------
    function episode() {
      if (!S.row) return;
      o.seek(S.start); S.armed = true; S.lastNow = null;
      if (S.viewer && S.mode === 'hits') { S.viewer.holdShot(true); S.held = true; }
      o.speed(SLOW); o.play(true);
    }
    // the replay's clock moved from t0 to t1 in a frame: the episode stops at the hit
    function clamp(t0, t1) {
      if (!S.row || !S.armed || S.stop == null || t1 < S.stop || t0 > S.stop) return t1;
      S.armed = false; o.play(false); logFrames();
      return S.stop;
    }
    // One line per opening into the mod's log (the game's figure of this view's cost): the episode's frame intervals.
    function frameStats() {
      var d = S.frames.slice().sort(function (a, b) { return a - b; });
      return d.length ? { frames: d.length, median: +d[d.length >> 1].toFixed(1), worst: +d[d.length - 1].toFixed(1) } : null;
    }
    function logFrames() {
      if (S.logged || !S.row) return; var f = frameStats(); if (!f) return; S.logged = true;
      if (o.log) o.log('shot view ' + (S.mode === 'hits' ? 'with Hits’ map' : 'without Hits’ map') + ', ' + o.name(S.row.shooter) + ' -> ' + (S.target == null ? '-' : o.name(S.target)) + ' at ' + o.clock(S.row.t) +
        ': episode ' + f.frames + ' frames, frame time median ' + f.median + ' ms, worst ' + f.worst + ' ms' + (S.viewer && S.viewer.backendShown ? ' (' + S.viewer.backendShown + ')' : ''));
    }
    // ---- this page's frame: paint before its render, overlay after it --------------------------------------------------
    function paint(time, now) {
      if (!S.row) return;
      if (S.armed && now != null) { if (S.lastNow != null) S.frames.push(now - S.lastNow); S.lastNow = now; }
      var sh = o.vehicle(S.row.shooter), inside = !!(sh && sh.visible && eyeInside(sh));
      if (sh && (inside || S.veiled)) o.veil(sh, inside);
      S.veiled = inside;
      var v = S.viewer, r = S.target == null ? null : o.vehicle(S.target);
      if (S.mode !== 'hits' || !v || !r) return;
      if (S.corridor && o.corridor) { o.corridor.keep(); S.onLine = o.corridor.vehicles([S.row.shooter, S.target]); }
      if (S.hitT != null) { var held = time < S.stop - 1e-6; if (held !== S.held) { S.held = held; v.holdShot(held); } }
      if (!r.visible) return;
      r.group.updateWorldMatrix(true, true);
      A.multiplyMatrices(r.group.matrixWorld, Z); AInv.copy(A).invert(); S.haveA = true;
      if (S.posed) v.hostPose(partTransforms(r, S.data.hit.target.parts || []));
      v.hostFrame();
      var on = !!v.composed;
      S.extras.forEach(function (m) { m.visible = on; });
      o.look(r, on ? paintMat : null);
    }
    // Hits' marks over this page's picture: on the target (stencil 1) through the model, as Hits draws them; elsewhere behind
    // whatever of the map stands in front. The renderer's state is put back.
    var overlayMats = [];
    function overlay() {
      var v = S.viewer, r = S.target == null ? null : o.vehicle(S.target);
      if (S.mode !== 'hits' || !v || !r || !r.visible || !S.haveA) return;
      var R = o.renderer, auto = R.autoClear;
      overlayMats.length = 0;
      v.scene.traverseVisible(function (x) { if (!x.material) return; (Array.isArray(x.material) ? x.material : [x.material]).forEach(function (m) { if (overlayMats.indexOf(m) < 0) overlayMats.push(m); }); });
      if (!overlayMats.length) return;
      var saved = overlayMats.map(function (m) { return [m.depthTest, m.stencilWrite, m.stencilFunc, m.stencilRef, m.stencilFail, m.stencilZFail, m.stencilZPass, m.stencilFuncMask]; });
      function rule(func, depth) { overlayMats.forEach(function (m) { m.stencilWrite = true; m.stencilFunc = func; m.stencilRef = 1; m.stencilFuncMask = 0xff; m.stencilFail = m.stencilZFail = m.stencilZPass = T.KeepStencilOp; m.depthTest = depth; }); }
      try {
        R.autoClear = false;
        rule(T.EqualStencilFunc, false); R.render(v.scene, v.camera);
        rule(T.NotEqualStencilFunc, true); R.render(v.scene, v.camera);
      } finally {
        R.autoClear = auto;
        overlayMats.forEach(function (m, i) { var s = saved[i]; m.depthTest = s[0]; m.stencilWrite = s[1]; m.stencilFunc = s[2]; m.stencilRef = s[3]; m.stencilFail = s[4]; m.stencilZFail = s[5]; m.stencilZPass = s[6]; m.stencilFuncMask = s[7]; });
      }
    }
    function close(reopen) {
      var was = S.mode, r = S.target == null ? null : o.vehicle(S.target), sh = S.row ? o.vehicle(S.row.shooter) : null;
      if (S.row && !S.logged) logFrames();
      S.token++;
      dropExtras();
      if (o.corridor && S.corridor) o.corridor.close(); S.corridor = null;
      if (r) o.look(r, null);
      if (sh && S.veiled) o.veil(sh, false);
      if (S.viewer && was === 'hits') S.viewer.clear();
      S.mode = null; S.row = null; S.armed = false; S.held = null; S.haveA = false; S.data = null; S.rec = null; S.veiled = false; S.posed = false;
      pin.hidden = true;
      if (!reopen) { bar.hidden = true; if (was) o.speed(null); exit(); }
    }
    function state() {
      var v = S.viewer, sf = v && v.surface;
      return { open: !!S.row, mode: S.mode, start: S.start, stop: S.stop, hitT: S.hitT, armed: S.armed, aim: S.aim, error: S.error, note: note.textContent,
        hit: S.hits && S.hits.hit ? S.hits.hit.id : null, posed: !!S.posed, shooterHidden: S.veiled, extras: S.extras.map(function (m) { return m.userData.shotExtra; }),
        shell: S.rec && S.rec.shell ? { kind: S.rec.shell.kind, penetration: S.rec.shell.penetration, guess: S.rec.guess } : null,
        composed: !!(v && v.composed), faces: sf && sf.mesh && sf.mesh.geometry && sf.mesh.geometry.attributes.position ? sf.mesh.geometry.attributes.position.count / 3 : 0,
        ricochetLeg: !!(sf && sf.bounce), shotHeld: !!(v && v.shotHeld), backend: v ? v.backendShown : null, frames: frameStats(), logged: S.logged,
        pinned: !!(v && v.pinned), pin: pin.hidden ? null : pinLabel.textContent + ' ' + pinChips.textContent, lens: { fov: o.camera.fov, zoom: o.camera.zoom }, inMode: !!S.saved,
        corridor: S.corridor ? { radius: CORRIDOR, hidden: S.corridor.hidden, models: S.corridor.models, collision: S.corridor.collision, plants: S.corridor.plants, modeObjects: S.corridor.modeObjects,
          ground: S.corridor.ground, destroyedAlready: S.corridor.destroyedAlready, vehiclesHidden: S.onLine || 0, list: S.corridor.list, t: S.corridor.t, a: S.corridor.a, b: S.corridor.b } : null };
    }
    return { open: open, close: function () { close(false); }, active: function () { return !!S.row; },
      free: function () { return !!S.row; }, paint: paint, overlay: overlay, clamp: clamp, state: state, viewer: function () { return S.viewer; },
      paintMaterial: paintMat, bar: bar };
  }
  root.BullbaShotView = { create: create, BEFORE: BEFORE, SLOW: SLOW, INSIDE: INSIDE };
})(window);
