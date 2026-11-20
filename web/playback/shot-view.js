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

   The eye (21.11, NOTEBOOK S2): from the episode's start the camera rides with the shooter, first person (camera()):
   - the replay's own player with his camera recorded over the whole episode (playback.js shotRecordedOk: no gap over
     0.3 s, the eye never under the ground): his camera as the replay has it - eye, turn, field of view (his sniper zoom);
   - anyone else, or a record that does not cover the episode: the gun's view for the whole episode, never the two mixed -
     the tracer's start and first direction put into the gun's frame at the shot (playback.js shotGunAt) and carried with
     the gun each frame, the viewer's own field of view. A row with no tracer: the shooter's place, looking at the target.
   The bar says which. FROM THE SHOT (20.11, NOTEBOOK T1: the tracer's clock) the eye no longer rides with the shooter: it
   glides in GLIDE s onto the shell's line at its start and stays there, looking at the hit (the tracer's end, Hits' hit
   point when the record has it) until the hit and after it; there the wheel moves it along that line towards the target
   and back (lineWheel: the page's own zoom steps, never past LINE_NEAR m short of the hit nor behind the start).
   At the stop the picture stays as the shooter saw it; a drag, a move key or (before the shot) the wheel (release())
   ends the first person: the field of view the viewer had, the camera orbiting the target's FOCUS - Bullba Hits' orbit
   centre (viewer.js vehicleCentre / pivotCentre: over the hull's box, at the turret's height or the shooter's gun
   height), ridden with the target as this page draws it -, the wheel closer / farther as everywhere. A pan or a move
   key frees the centre from the target (panned()). No lens zoom, no Fit (the owner, 1.16).
   The shot's corridor (CORRIDOR): map objects and other vehicles the shell's line (Hits' eye on the shell's axis at its
   origin, to the hit) passes through are not drawn while the view is open (the shell reached the target: nothing solid
   stood there), given back on Leave; the terrain never - where it crosses the line the bar says so. Objects off the
   line occlude as anywhere.
   The shooter: while the eye is inside it (INSIDE: its hull, turret or gun box grown by INSIDE metres) it is veiled - not
   drawn, its shadow kept; flown out of it, it is drawn again.
   The episode: the battle from 2 s before the shot, at x1, stopped at the hit (the row's hit event; a shot with no hit:
   its tracer's end) with the hit line shown from then on; played on, the mode leaves by itself AFTER s past the stop, so
   the heat map's cost does not run on into the battle. Replay episode: the same, in first person again.
   Leave (or Esc): the mode's exit (exit()) - the lens, the user's speed, the target's look, the shooter as before.
   FOLIAGE (T2): for the whole mode the page's foliage slider is forced to FOLIAGE (o.foliage; the user's value back on
   leaving) and the foliage writes stencil 2 (o.plantStencil): the target is drawn once more with Hits' paint, half
   transparent (SILHOUETTE), where a plant stands in front of it - its silhouette through bushes, as the game shows the
   aimed-at vehicle. Solid obstacles are not touched.
   THE HUD (T3, T4; hud()): while the eye is the shooter's, the aim circles a tick over the picture, in screen space as
   the game draws its own: the player's own from the battle's 0x1a / 0x39 series (battle.js aim, server) - the client
   circle (size recorded, centre at the cursor point: approximate), the server circle (recorded, dashed), and from the
   shot the circle the shell left from (the thick ring, the 0x39 update at the shell's origin: replay_aim.py's disc
   rule); another vehicle Hits' estimate (its tracer's replayAimEstimate: the size at the shot, centred on the gun as
   drawn, dashed). From the shot they stand still; at the hit Hits' own circles take over. The game's sight (the centre
   mark at the cursor point - the screen's centre for another vehicle -, the gun tag at the circle's centre) from the
   file the mod reads from the client (o.sight, game_sight.py); without it a thin cross of the page. Hits' own blue
   hit-location crosses are not drawn in the mode (the sight stands for them).

   THE SHOT'S FIGURES (20.11, NOTEBOOK U2; cells()): two cells in the bar, as Bullba Hits' panels read a shot. "Hit line":
   the recorded line (viewer.shotProbability with the shell at the record's range) in Hits' words (web/armor-line.js line)
   and "Circle" over the ring Hits draws for the hit (the own recorded one - viewer.savedAimSampler -, else Hits' estimate -
   estimateAimSampler -, then headed "Circle, estimate"), its figure and words armor-line.js circleFigure / circleText /
   CIRCLE_TITLES; the integral goes to Hits' worker (sampler.post), the frame takes one 3 ms slice of it at most (Hits'
   AIM_EST_SLICE). Not here: Hits' track chip (it reads the characteristics file through app.js).
   WHERE ELSE COULD THE SHOT GO (U3; alt()): once stopped at the hit with the eye at the shell's start (on the line, the
   wheel not moved, the glide done - after the stop it finishes on the wall clock), the right cell reads the point under
   the cursor (Hits' viewer.inspect: one reading a frame, from the eye) and a cyan circle aims there as Hits' live circle
   does in its manual motion: the gun chases the cursor at the turret's speed (viewer.aimGap, ArmorBallistics.turretChase,
   viewer.chaseAim), the circle is ArmorBallistics.aimStep over {the shot's speed, the shot's hull turn, the chase's
   turret term}. It starts as the ring of the "Hit line" (its centre and size, K = its angle / the block's dispersion) and
   settles to the steady size of that motion with the gun held on its aim; the crew and equipment the record's block does
   not hold enter as Hits' `mult` modifier c = min(1, K / that steady size), so it never jumps at the start. The speed and
   the hull turn: the record's `motion` (the client's own figures) where it has them, else this replay's track
   (o.track). Its figure: Hits' live rule (estimateLive): 256 rays at most every ALT_COARSE s while it moves, 1024 once
   at rest, in the worker. A click pins the point (Hits' pin; the circle stays on it, as Hits' Alt + click); the HUD's
   sight follows (the centre mark at the cursor, the gun tag at the circle's centre), the system pointer hidden over the
   picture. Not here: firing, reload, re-placing the tracer, moving the vehicle.

   A replay file Bullba Hits has no battle of: the mod makes it from the replay ('prepareBattle' with the file's id).
   What cannot be had (outside the game; a replay the route refuses; a shot with no hit; a hit the battle does not list; a
   scene without its models; no WebGL 2) is not made up: the episode plays and the bar says what is missing.

   BullbaShotView.create(o) -> {open(row), close(), active(), free(), camera(t), panned(), paint(t, now), overlay(),
   clamp(t0, t1), state()};
   o: {view (the element the canvas is in), camera, renderer, battle, hitsBattle, battleId, dataBase, vehicle(id), name(id),
   clock(t), seek(t), play(on), speed(v | null), orbit(eye, at) (scene coordinates), veil(r, on), look(r, material | null),
   recordedOk(id, t0, t1), recorded(id, t, pos, quat) -> fov | null, gunAt(id, t, matrix) -> matrix | null, delay(id) -> s,
   track(id, t) -> {speed, hullTurn, turretYaw} | null (the shooter's motion at the shot from the replay's track),
   foliage(k | null), plantStencil(on), sight() -> Promise<the sight file's value | null>}. */
(function (root) {
  'use strict';
  var T = root.THREE;
  // s before the shot; the episode's speed (x1, the owner on 1.16: 1/4 too slow); s past the stop after which a battle
  // played on leaves the mode
  var BEFORE = 2, SPEED = 1, AFTER = 1;
  // T1: s the eye takes to reach the shell's line at the shot (a jump from a third-person camera reads as a cut); the
  // nearest the wheel brings it to the hit (m); the wheel's steps: the page's own zoom (playback.js ZOOM)
  var GLIDE = 0.25, LINE_NEAR = 3, WHEEL_IN = 0.23, WHEEL_OUT = 0.30, WHEEL_FLOOR = 0.8;
  // T2: the foliage slider's value forced for the mode (0 solid .. 1 gone; a guess by eye: the bush still reads); the
  // silhouette's opacity over what stands in front (a guess by eye)
  var FOLIAGE = 0.8, SILHOUETTE = 0.5;
  // T3: Hits' colour of a recorded or estimated circle (viewer.js AIM_RING); a 0x1a sample is drawn between two ticks only
  // when they are at most AIM_GAP s apart (ticks are 0.1 s; the measured largest gap in the 2 s before 54 own shots 0.2 s);
  // the disc: the 0x39 strictly before the tracer whose gun stands at the shell's origin (replay_aim.py BEFORE, ORIGIN_GAP,
  // DISC_BACK); below SNIPER rad of field of view the sight is the sniper one (arcade 1.178, sniper 0.295 and less)
  var AIM_COLOUR = '#ff5ad6', AIM_GAP = 0.3, DISC_BEFORE = 1e-4, ORIGIN_GAP = 0.05, DISC_BACK = 3, SNIPER = 0.9;
  // The shooter is not drawn while the eye is within INSIDE m of its hull, turret or gun box (each in its own frame). 0.5 m:
  // Hits' eye stands 0.30 m past the muzzle on the shell's axis (the test's figure), so it starts inside; a step away
  // from the vehicle shows it again.
  var INSIDE = 0.5;
  // CORRIDOR: the radius (m) of the tube round the shot's line from the eye to the hit inside which map objects and other
  // vehicles are not drawn while the view is open (playback.js shotCorridorOpen) - the shell passed there, so nothing solid
  // stood on it. 0.6 m: a shell is under 0.2 m wide, and a little more leaves no plank or post at the gun cutting the view;
  // the target's own half-size (1.5-2 m) would clear whole house walls beside the line.
  var CORRIDOR = 0.6;
  // U2, U3: Hits' cadence of a circle's figure (app.js estimateLive, AIM_EST_SLICE): the coarse figure at most every
  // ALT_COARSE s while the circle moves, of COARSE rays; the fine one of FINE rays once at rest; one SLICE ms a frame on
  // the main thread when there is no worker
  var ALT_COARSE = 0.12, COARSE = 256, FINE = 1024, SLICE = 3;
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
  function wallNow() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
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
  // the silhouette (T2): the same map, half transparent, only where a plant is in front (stencil 2: playback.js
  // shotPlantStencil), drawn over the picture without the depth test
  var SILHOUETTE_FRAGMENT = 'precision highp float;\nuniform highp sampler2D uPaint;\nuniform vec3 uBase;\nuniform float uAlpha;\nout vec4 outColor;\n' +
    'void main(){vec4 p=texelFetch(uPaint,ivec2(gl_FragCoord.xy),0);outColor=vec4(p.rgb+uBase*(1.0-p.a),uAlpha);}';

  function create(o) {
    var Data = root.ArmorInspectorData;
    if (Data && Data.setBase) Data.setBase(o.dataBase || '');
    var S = { row: null, mode: null, start: 0, stop: null, hitT: null, armed: false, target: null, held: null, viewer: null,
      error: null, note: '', hits: null, data: null, rec: null, aim: null, token: 0, haveA: false, veiled: false, extras: [],
      look: null };
    var Z = new T.Matrix4().makeScale(1, 1, -1), M = new T.Matrix4(), N = new T.Matrix4(), A = new T.Matrix4(), AInv = new T.Matrix4();
    var V3 = new T.Vector3(), scaleTmp = new T.Vector3(), box = new T.Box3(), size = new T.Vector2();
    var hitsBattles = {};
    // ---- the bar: what is shown, Replay episode, Leave; the pinned point's reading --------------------------------------
    var bar = node('div', undefined, 'panel sv-bar'), title = node('span', '', 'sv-title'), note = node('div', '', 'sv-note');
    var again = node('button', 'Replay episode', 'sv-again'), leave = node('button', 'Leave', 'sv-leave');
    // U2, U3: the two cells - the recorded shot ("Hit line") and the other point ("Under the cursor" / "Pinned point") - as
    // Bullba Hits' panels: a heading, the chance or the share of alpha with the alpha muted, the circle's tile; the chips
    // of the line below, the screens on a row of their own (app.js fillPanel)
    function cell(cls) {
      var c = { el: node('div', undefined, 'sv-cell ' + cls), head: node('div', undefined, 'sv-cell-head'), name: node('span', '', 'sv-cell-name'),
        chance: node('b', '', 'sv-cell-chance'), alpha: node('span', '', 'sv-cell-alpha'), tile: node('span', undefined, 'sv-circle'),
        tileHead: node('span', 'Circle', 'sv-circle-head'), tileVal: node('b', '', 'sv-circle-val'), chips: node('div', '', 'sv-chips'), extra: node('div', '', 'sv-chips sv-extra') };
      c.alpha.title = 'The shell’s alpha damage, HP';
      c.tile.appendChild(c.tileHead); c.tile.appendChild(c.tileVal); c.tile.hidden = true;
      c.head.appendChild(c.name); c.head.appendChild(c.chance); c.head.appendChild(c.alpha); c.head.appendChild(c.tile);
      c.el.appendChild(c.head); c.el.appendChild(c.chips); c.el.appendChild(c.extra); c.el.hidden = true;
      return c;
    }
    var figs = node('div', undefined, 'sv-figs'), cellA = cell('sv-hitline'), cellB = cell('sv-other'), unpin = node('button', '×', 'sv-unpin');
    again.type = leave.type = unpin.type = 'button';
    again.title = 'Replay episode\nPlays the shot again from ' + BEFORE + ' s before it, seen by the shooter, and stops at the hit.\n• Played on, the shot view closes ' + AFTER + ' s after the hit';
    leave.title = 'Leave the shot view\nBack to the battle view: the free camera and your speed.\n• Esc does the same';
    unpin.title = 'Unpin\nDrops the pinned point.';
    again.onclick = function () { episode(); };
    leave.onclick = function () { close(); };
    unpin.onclick = function () { if (S.viewer) S.viewer.unpin(); };
    cellB.head.appendChild(unpin); unpin.hidden = true;
    figs.appendChild(cellA.el); figs.appendChild(cellB.el);
    bar.appendChild(title); bar.appendChild(again); bar.appendChild(leave); bar.appendChild(figs); bar.appendChild(note); bar.hidden = true;
    document.body.appendChild(bar);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.row) { close(); e.preventDefault(); } });
    // ---- Hits' viewer, hosted on this page's renderer and camera -------------------------------------------------------
    var paintRT = null;
    var paintMat = new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: PAINT_VERTEX, fragmentShader: PAINT_FRAGMENT, side: T.DoubleSide,
      uniforms: { uPaint: { value: null }, uBase: { value: new T.Vector3(0.38, 0.46, 0.54) } },
      stencilWrite: true, stencilRef: 1, stencilFunc: T.AlwaysStencilFunc, stencilZPass: T.ReplaceStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });
    paintMat.userData.shotPaint = true;
    var silMat = new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: PAINT_VERTEX, fragmentShader: SILHOUETTE_FRAGMENT, side: T.DoubleSide,
      uniforms: { uPaint: paintMat.uniforms.uPaint, uBase: paintMat.uniforms.uBase, uAlpha: { value: SILHOUETTE } }, transparent: true, depthTest: false, depthWrite: false,
      stencilWrite: true, stencilRef: 2, stencilFunc: T.EqualStencilFunc, stencilZPass: T.KeepStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });
    // ---- the HUD: the aim circles and the game's sight over the picture (hud()) -------------------------------------------
    var hudCanvas = node('canvas', undefined, 'sv-hud'), hud2d = hudCanvas.getContext('2d');
    hudCanvas.hidden = true; o.view.appendChild(hudCanvas);
    var sightImg = { arcade: null, sniper: null }, sightWhy = null;
    // the sight file's images (straight-alpha RGBA, base64) into canvases once
    function sightCanvas(im) {
      if (!im || !(im.w > 0) || !(im.h > 0) || typeof im.rgba !== 'string') return null;
      var bin = atob(im.rgba), c = document.createElement('canvas'), g = c.getContext('2d'), d = g.createImageData(im.w, im.h);
      if (bin.length !== im.w * im.h * 4) return null;
      for (var i = 0; i < bin.length; i++) d.data[i] = bin.charCodeAt(i);
      c.width = im.w; c.height = im.h; g.putImageData(d, 0, 0);
      return { c: c, x: im.x, y: im.y, w: im.dw || im.w, h: im.dh || im.h };
    }
    function takeSight(v) {
      if (sightImg.arcade || sightWhy) return;
      if (!v) { sightWhy = 'the mod has not read it for this battle (an older battle file, or outside the game)'; return; }
      if (v.error) { sightWhy = String(v.error); return; }
      try {
        ['arcade', 'sniper'].forEach(function (m) { var x = v[m] || {}; sightImg[m] = { centre: sightCanvas(x.centre), tag: sightCanvas(x.tag) }; });
        if (!sightImg.arcade.centre) { sightImg.arcade = sightImg.sniper = null; sightWhy = 'its images are not in the file'; }
      } catch (e) { sightImg.arcade = sightImg.sniper = null; sightWhy = String(e && e.message || e); }
    }
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
      S.viewer.grid.visible = false;
      S.viewer.onPin = pinShown;
      S.viewer.onInspect = altReading;   // U3: the reading under the cursor (Hits' inspect, while the alternative is on)
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
    var press = null, held = null, canvas = o.renderer.domElement, ptr = { clientX: NaN, clientY: NaN, fresh: false };
    // the user takes the camera (release()): the wheel before the shot - caught before this page's own wheel, which then
    // moves the eye closer / farther from where the shooter's eye was -, or a drag past 3 px (a click stays a pin). From
    // the shot on, the wheel moves the eye along the shell's line instead (lineWheel), and this page's zoom is not run.
    canvas.addEventListener('wheel', function (e) {
      if (!S.row) return;
      if (S.fp && onLine()) { e.preventDefault(); e.stopImmediatePropagation(); lineWheel(e.deltaY / (e.deltaMode === 1 ? 3 : 100)); return; }
      release();
    }, { capture: true, passive: false });
    canvas.addEventListener('pointerdown', function (e) {
      held = { x: e.clientX, y: e.clientY };
      press = S.mode === 'hits' && e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey ? { x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (held && S.fp && Math.abs(e.clientX - held.x) + Math.abs(e.clientY - held.y) > 3) release();
      // U3: the pointer for the alternative's one reading a frame (alt(): Hits' frameHover takes the last event of a burst)
      ptr.clientX = e.clientX; ptr.clientY = e.clientY; ptr.fresh = true;
    });
    canvas.addEventListener('pointerup', function (e) {
      var p = press; press = null; held = null;
      if (!p || S.mode !== 'hits' || !S.viewer || !S.haveA || Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 3) return;
      S.viewer.resize(); S.viewer.placeCamera(); S.viewer.pinAt(e);
    });
    // ---- the figures (U2, U3) -------------------------------------------------------------------------------------------
    var AL = root.BullbaArmorLine;
    // Hits' Display of this map: Expected damage with a shell that has an alpha, else the chance; the colour of a figure
    function damageOn() { var L = S.look || hitsLook(), shell = S.viewer && S.viewer.shell; return L['armor-mode'] === 'damage' && !!(shell && shell.alpha > 0); }
    function rgbOf(x) {
      var L = S.look || hitsLook(), tint = L['ricochet-tint-on'] ? num(L['ricochet-tint'], 50) / 100 : 0;
      return 'rgb(' + root.ArmorBallistics.color(x, L.palette, tint, damageOn() ? 'damage' : 'chance').map(function (c) { return Math.round(c * 255); }).join(',') + ')';
    }
    // a ballistic result in Hits' words, with the shell on screen (the shot's, at the record's range)
    function lineOf(r) {
      var shell = S.viewer && S.viewer.shell;
      return AL.line(r, shell ? shell.penetration : null, S.rec ? S.rec.range : null, { damage: damageOn(), shell: shell, rgb: rgbOf,
        parts: S.data && S.data.hit.target ? S.data.hit.target.parts : null });
    }
    function chipsInto(box, groups) { box.replaceChildren(); groups.forEach(function (g) { var c = node('span', g.text, 'chip ' + g.kind); if (g.title) c.title = g.title; box.appendChild(c); }); box.hidden = !groups.length; }
    // one cell: its heading, the line's label in its colour, the alpha muted, the chips (app.js fillPanel's split)
    function fillCell(c, name, line, tip) {
      var shell = S.viewer && S.viewer.shell, alpha = shell && shell.alpha > 0 ? shell.alpha : 0;
      var low = function (g) { return g.kind === 'screen' || g.kind === 'track'; };
      c.name.textContent = name; c.el.title = tip || '';
      c.chance.textContent = line.label; c.chance.style.color = line.color;
      c.alpha.textContent = alpha ? '/ ' + Math.round(alpha) : ''; c.alpha.hidden = !alpha;
      chipsInto(c.chips, line.groups.filter(function (g) { return !low(g); })); chipsInto(c.extra, line.groups.filter(low));
      c.el.hidden = false;
    }
    function placeholder(c, name, text, tip) {
      c.name.textContent = name; c.el.title = tip || ''; c.chance.textContent = '—'; c.chance.style.color = ''; c.alpha.hidden = true;
      chipsInto(c.chips, [{ kind: 'placeholder', text: text }]); chipsInto(c.extra, []); c.el.hidden = false;
    }
    // the circle's tile: Hits' figure (armor-line.js circleText), its colour on the chance scale, Hits' words; `estimate`
    // heads it "Circle, estimate"; `more` the tooltip's own points
    function fillCircle(c, figure, kind, estimate, more) {
      var text = figure ? AL.circleText(figure) : '';
      c.tile.hidden = !text;
      if (!text) return;
      c.tileHead.textContent = estimate ? 'Circle, estimate' : 'Circle';
      c.tileVal.textContent = text;
      var pct = figure.alpha ? figure.damage : figure.low;
      c.tileVal.style.color = pct >= 0 ? rgbOf({ chance: pct, expectedShare: pct / 100 }) : '';
      var prof = root.ArmorBallistics.aimProfile(S.viewer ? S.viewer.aimProfileName : undefined);
      c.tile.title = (AL.CIRCLE_TITLES[kind] || AL.CIRCLE_TITLES.live) + (figure.alpha ? AL.SHARE : AL.NO_ALPHA) + '\n• ' + AL.circleModel(damageOn(), prof.label) + (more || '');
    }
    // THE HIT LINE (U2): the recorded line and the ring Hits draws for the hit, taken again whenever the viewer's engine is
    // another (the pose this page draws the target in commits a new one: app.js shotStats takes its figures again then too)
    var HIT_TIP = 'Hit line\nBullba Hits’ reading of the recorded shot: the shell’s nominal penetration at the recorded range against the armour and screens on the line - the odds the shot had, not the rolled RNG.';
    function hitLine() {
      var v = S.viewer, shell = v && v.shell;
      S.lineEngine = v ? v.engine : null; S.lineJob = null; S.lineFig = null;
      if (!v || !v.engine) return;
      fillCell(cellA, 'Hit line', lineOf(v.shotProbability(shell)), HIT_TIP);
      S.lineKind = v.savedAim ? (v.savedAim.kind === 'fired' ? 'fired' : 'saved') : v.estimateAim ? (v.estimateAim.rebuilt ? 'rebuilt' : 'estimate') : null;
      var s = !shell ? null : v.savedAim ? v.savedAimSampler(shell) : v.estimateAimSampler(shell);
      // the old figure stands until the new one lands (app.js shotStats: a tile that blanks and comes back reads as a fault)
      if (s) S.lineJob = { s: s.post('shot'), shell: shell }; else fillCircle(cellA, null);
    }
    // the figures' jobs, one slice a frame, the shot's first (app.js aimEstSlice)
    function stepJobs() {
      var until = (root.performance ? root.performance.now() : Date.now()) + SLICE, r;
      if (S.lineJob) {
        if ((r = S.lineJob.s.step(until))) { S.lineFig = AL.circleFigure(r, S.lineJob.shell); S.lineJob = null; fillCircle(cellA, S.lineFig, S.lineKind, S.lineKind === 'rebuilt' || S.lineKind === 'estimate'); }
        return;
      }
      var X = S.alt;
      if (!X || !X.job) return;
      if (X.job.s.engine !== S.viewer.engine) { X.job = null; X.fine = false; return; }
      if ((r = X.job.s.step(until))) { X.fig = AL.circleFigure(r, X.job.shell); X.fine = X.job.fine; X.job = null; altCircle(); }
    }
    // the other cell: the pinned point (in the orbit too), else the alternative's point under the cursor, else nothing
    var PIN_TIP = 'Pinned point\nBullba Hits’ reading of the line from the eye through the point you clicked, with this shot’s shell.\n• × drops it';
    var UNDER_TIP = 'Under the cursor\nBullba Hits’ reading of a shot from the shell’s start through the point under the cursor, with this shot’s shell.\n• Click on the target: pin that point';
    function pinShown() {
      var v = S.viewer, on = !!(v && v.pinned);
      unpin.hidden = !on;
      if (S.alt && v) { v.spreadAim = on && v.pinned.point ? v.pinned.point.clone() : null; if (!on) { v.inspectKey = null; ptr.fresh = true; } }
      if (on) { fillCell(cellB, 'Pinned point', lineOf(v.pinResult), PIN_TIP); if (!S.alt) fillCircle(cellB, null); return; }
      if (S.alt) { if (!S.alt.read) placeholder(cellB, 'Under the cursor', 'Hover over the armour', UNDER_TIP); return; }
      cellB.el.hidden = true;
    }
    function altReading(r) {
      if (!S.alt || (S.viewer && S.viewer.pinned)) return;
      S.alt.read = true;
      fillCell(cellB, 'Under the cursor', lineOf(r), UNDER_TIP + (S.alt.why ? S.alt.tip : ''));
    }
    // ---- THE MODE: its entry and its exit, the one place what the shot view changes in this page is set and put back ------
    // Entry: the camera's lens as it was (fov, zoom, near, far) kept; the shot view then sets the clock (the episode, its
    // speed) and the eye (first person: the recorded field of view). Exit: the lens, the user's speed, the target's own
    // look, the shooter, no Hits marks - nothing of the mode stays in the battle view. (A mode that draws less of the map
    // to keep the frame rate would be switched on in enter() and off in exit().)
    function enter() {
      if (S.saved) return;
      var c = o.camera; S.saved = { fov: c.fov, zoom: c.zoom, near: c.near, far: c.far };
      // T2: the foliage see-through and its silhouette for the whole mode
      if (o.foliage) o.foliage(FOLIAGE);
      if (o.plantStencil) o.plantStencil(true);
    }
    function exit() {
      if (!S.saved) return;
      var c = o.camera, k = S.saved; c.fov = k.fov; c.zoom = k.zoom; c.near = k.near; c.far = k.far; c.updateProjectionMatrix();
      S.saved = null;
      if (o.foliage) o.foliage(null);
      if (o.plantStencil) o.plantStencil(false);
      hudCanvas.hidden = true;
      // nothing of the mode stays allocated: the paint target goes (Hits' composition went with viewer.clear)
      if (paintRT) { paintRT.dispose(); paintRT = null; paintMat.uniforms.uPaint.value = null; }
    }
    // ---- the eye: the shooter's first person, then the orbit round the target's focus -------------------------------------
    var G = new T.Matrix4(), GI = new T.Matrix4(), fpPos = new T.Vector3(), fpLook = new T.Vector3(), fpQ = new T.Quaternion(), fpFocus = new T.Vector3();
    var pose = { position: null, quaternion: null, look: null, fov: 55, focus: null };
    // which first person this row gets, decided once for the whole episode: 'camera' (the replay's own), 'gun', 'place'
    function firstPerson(row) {
      var end = (S.stop == null ? row.t : S.stop) + AFTER;
      if (o.recordedOk && o.recordedOk(row.shooter, S.start, end)) return { kind: 'camera', words: 'the view: the player’s own camera from the replay' };
      var s = row.shot, sh = s && o.battle.shots ? o.battle.shots[s.index] : null, me = o.vehicle(row.shooter);
      var why = me && me.v && me.v.own ? 'the replay’s camera does not cover this episode' : 'no camera is recorded for this vehicle';
      if (s && sh) {
        var at = new T.Vector3(s.start[0], s.start[1], -s.start[2]), dir = new T.Vector3(sh[6], sh[7], -sh[8]);
        if (!(dir.lengthSq() > 1e-9)) dir.set(s.end[0] - s.start[0], s.end[1] - s.start[1], -(s.end[2] - s.start[2]));
        dir.normalize();
        if (o.gunAt && o.gunAt(row.shooter, row.t, G)) {
          GI.copy(G).invert();
          return { kind: 'gun', eye: at.applyMatrix4(GI), dir: dir.transformDirection(GI), words: 'the view: from the gun (' + why + ')' };
        }
        return { kind: 'place', eye: at, look: at.clone().add(dir), words: 'the view: from the shell’s start, still (' + why + '; the shooter’s gun is not drawn)' };
      }
      var a = o.vehicle(row.shooter), b = S.target == null ? null : o.vehicle(S.target);
      // the vehicles' groups stand in the root's game axes, as the tracers do
      if (a && b) return { kind: 'place', eye: new T.Vector3(a.group.position.x, a.group.position.y + 2, -a.group.position.z),
        look: new T.Vector3(b.group.position.x, b.group.position.y + 1.5, -b.group.position.z), words: 'the view: from the shooter’s place, still (no tracer of this shot)' };
      return { kind: 'none', words: 'the view: the camera as it was (no tracer of this shot, the shooter or the target not drawn)' };
    }
    // the target's focus in the scene now: Bullba Hits' orbit centre (S.focusGroup, in the target group's frame)
    function focusScene(out) {
      var r = S.target == null ? null : o.vehicle(S.target);
      if (!r || !r.visible) return null;
      if (!S.focusGroup) S.focusGroup = meshCentre(r);
      if (!S.focusGroup) return null;
      r.group.updateWorldMatrix(true, false);
      return out.copy(S.focusGroup).applyMatrix4(r.group.matrixWorld);
    }
    // Hits' rule (viewer.js vehicleCentre) on this page's drawing of the collision model, where Hits' viewer has none:
    // over the hull's box, at the turret's box centre height (no turret: the hull's top)
    function meshCentre(r) {
      var hull = bodyOf(r.group, r); if (!hull) return null;
      if (!hull.geometry.boundingBox) hull.geometry.computeBoundingBox();
      hull.updateMatrix();
      var hb = box.copy(hull.geometry.boundingBox).applyMatrix4(hull.matrix), c = hb.getCenter(new T.Vector3()); c.y = hb.max.y;
      var tm = r.turret ? bodyOf(r.turret, r) : null;
      if (tm) {
        if (!tm.geometry.boundingBox) tm.geometry.computeBoundingBox();
        tm.updateMatrix(); r.turret.updateMatrix();
        c.y = box.copy(tm.geometry.boundingBox).applyMatrix4(tm.matrix).applyMatrix4(r.turret.matrix).getCenter(V3).y;
      }
      return c;
    }
    // T1: the shell's line (scene): from the tracer's start to its end (Hits' hit point once its scene is read, showHits)
    var lineEye = new T.Vector3(), lineQ = new T.Quaternion(), lineM = new T.Matrix4(), UP = new T.Vector3(0, 1, 0);
    function shotLine(row) {
      var s = row.shot;
      if (!s || !s.start || !s.end) return null;
      var a = new T.Vector3(s.start[0], s.start[1], -s.start[2]), b = new T.Vector3(s.end[0], s.end[1], -s.end[2]), len = a.distanceTo(b);
      return len > LINE_NEAR + 0.5 ? { a: a, b: b, len: len, t: row.t } : null;
    }
    // whether the eye is on the shell's line now (from the shot's clock on, in first person)
    function onLine() { return !!(S.line && S.fp && S.t >= S.line.t); }
    // the wheel on the line: n clicks (> 0 away from the target), the page's own zoom steps on the distance to the hit
    function lineWheel(clicks) {
      var L = S.line, n = Math.min(3, Math.abs(clicks)), d = (1 - S.u) * L.len;
      d = clicks > 0 ? d + Math.max(WHEEL_OUT * d, WHEEL_FLOOR) * n : d - Math.max(WHEEL_IN * d, WHEEL_FLOOR) * n;
      d = Math.max(LINE_NEAR, Math.min(L.len, d));
      S.u = 1 - d / L.len;
    }
    // the eye on the line at the clock t: the glide from where the eye was at the shot, then still (moved by the wheel only)
    function linePose(t) {
      var L = S.line;
      lineEye.copy(L.a).lerp(L.b, S.u);
      lineM.lookAt(lineEye, L.b, UP); lineQ.setFromRotationMatrix(lineM);
      if (!S.glide) { o.camera.updateMatrixWorld(); S.glide = { p: o.camera.position.clone(), q: o.camera.quaternion.clone() }; }
      var f = GLIDE > 0 ? Math.max(0, Math.min(1, (t - L.t) / GLIDE)) : 1;
      // stopped at the hit before the glide ended (a shell that flew under GLIDE s): it ends on the wall clock (U3: the eye
      // stands at the shell's start for the alternative)
      if (f < 1 && S.stopAt != null) f = Math.min(1, S.stopF + (wallNow() - S.stopAt) / 1000 / GLIDE);
      S.glided = f >= 1;
      if (f < 1) { fpPos.copy(S.glide.p).lerp(lineEye, f); fpQ.copy(S.glide.q).slerp(lineQ, f); }
      else { fpPos.copy(lineEye); fpQ.copy(lineQ); }
      pose.position = fpPos; pose.quaternion = fpQ; pose.look = null;
      return pose;
    }
    // this page's placeCamera asks: a first-person pose {position, quaternion | look, fov}, or {focus}, or null
    function camera(t) {
      if (!S.row) return null;
      var V = S.view;
      pose.focus = null;
      S.t = t;
      if (S.fp && S.line && t >= S.line.t) return linePose(t);
      if (S.fp && V && V.kind !== 'none') {
        var ok = false, fov = S.saved ? S.saved.fov : o.camera.fov;
        if (V.kind === 'camera') { var f = o.recorded(S.row.shooter, t, fpPos, fpQ); if (f != null) { ok = true; fov = f; } }
        else if (V.kind === 'gun') { if (o.gunAt(S.row.shooter, t, G)) { ok = true; fpPos.copy(V.eye).applyMatrix4(G); fpLook.copy(V.dir).transformDirection(G).add(fpPos); } }
        else { ok = true; fpPos.copy(V.eye); fpLook.copy(V.look); }
        // no pose this frame (the shooter not posed then): the last one held (fpPos, fpQ, fpLook keep it)
        if (!ok && !S.lastPose) return null;
        pose.position = fpPos; pose.quaternion = V.kind === 'camera' ? fpQ : null; pose.look = V.kind === 'camera' ? null : fpLook;
        if (ok) pose.fov = fov;
        S.lastPose = true;
        return pose;
      }
      pose.position = pose.quaternion = pose.look = null;
      if (!S.fp && S.lock && focusScene(fpFocus)) { pose.focus = fpFocus; return pose; }
      return null;
    }
    // the user takes the camera: the first person ends where the eye is; the viewer's field of view; orbiting the focus
    function release() {
      if (!S.fp) return;
      S.fp = false; S.lastPose = null;
      var c = o.camera, k = S.saved;
      if (k) { c.fov = k.fov; c.zoom = k.zoom; c.updateProjectionMatrix(); }
      c.updateMatrixWorld();
      var eye = c.position.clone(), at = focusScene(new T.Vector3()) || eye.clone().add(new T.Vector3(0, 0, -20).applyQuaternion(c.quaternion));
      o.orbit(eye, at);
    }
    function panned() { if (!S.row) return; release(); S.lock = false; }
    // ---- opening a row ----------------------------------------------------------------------------------------------------
    function open(row) {
      close(true);
      enter();
      var h = shownHit(row), tok = ++S.token;
      S.row = row; S.hitT = h ? h.t : null;
      S.stop = h ? h.t : (row.shot ? row.shot.tEnd : row.t);
      S.start = Math.max(0, row.t - BEFORE);
      S.target = h ? h.target : row.target;
      S.mode = 'wait'; S.error = null; S.data = null; S.rec = null; S.aim = null; S.haveA = false;
      S.focusGroup = null; S.view = firstPerson(row); S.fp = true; S.lock = true; S.lastPose = null;
      S.line = shotLine(row); S.u = 0; S.glide = null; S.t = S.start; S.estimate = null; S.disc = undefined;
      S.stopAt = null; S.glided = false; S.lineEngine = null; S.lineJob = null; S.lineFig = null;
      pose.fov = S.saved ? S.saved.fov : o.camera.fov;
      title.textContent = 'Shot view · ' + o.name(row.shooter) + ' → ' + (S.target == null ? 'no hit in the replay' : o.name(S.target)) + ' · ' + o.clock(row.t);
      note.textContent = 'Preparing the shot view… · ' + S.view.words; bar.hidden = false; cellA.el.hidden = cellB.el.hidden = true; unpin.hidden = true;
      o.play(false); o.seek(S.start);
      var sight = o.sight ? o.sight().catch(function () { return null; }) : Promise.resolve(null);
      return Promise.all([hitsScene(row, h), sight]).then(function (both) {
        var got = both[0];
        takeSight(both[1]);
        if (tok !== S.token || !got) return;
        if (got.data) showHits(got); else showReplay(got.why);
        episode();
      }).catch(function (e) {
        if (tok !== S.token) return;
        S.error = String(e && e.message || e);
        sight.then(function (v) { takeSight(v); if (tok === S.token) { showReplay('the shot view could not be made: ' + S.error); } });
        showReplay('the shot view could not be made: ' + S.error); episode();
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
      if (v.reticleLayer) v.reticleLayer.style.visibility = 'hidden';   // T4: the game's sight stands for Hits' crosses here
      S.mode = 'hits'; S.data = data; S.rec = rec; S.hits = got;
      S.posed = !!(r && sameModel(r, hit.target.parts || []));
      if (r && r.md && r.md.model) addExtras(r, data);
      // the orbit's centre: Hits' own (viewer.js pivotCentre), in the target group's frame (the viewer's frame is it with z
      // mirrored: A = the group's world x Z)
      var pc = v.pivotCentre(); S.focusGroup = new T.Vector3(pc.x, pc.y, -pc.z);
      // the shot's corridor: the shell's line - Hits' eye (its focus: the shell's axis at its origin) to the hit point -,
      // by the target's pose at the hit; the camera itself is the shooter's (camera())
      var eye = v.orbitEye(), Ae = Arec || (r && r.visible ? new T.Matrix4().multiplyMatrices(r.group.matrixWorld, Z) : null);
      S.corridor = null;
      if (Ae && v.point && o.corridor) S.corridor = o.corridor.open(eye.applyMatrix4(Ae), v.point.clone().applyMatrix4(Ae), CORRIDOR);
      // T1: the line's end at Hits' hit point (the tracer's end stands for it until now)
      if (S.line && Ae && v.point) {
        var hp = v.point.clone().applyMatrix4(Ae), len = S.line.a.distanceTo(hp);
        if (len > LINE_NEAR + 0.5) { S.line.b.copy(hp); S.line.len = len; }
      }
      // T3: another vehicle's circle while aiming - Hits' estimate of its shot (the tracer's replayAimEstimate)
      if (!own) S.estimate = estimateOf(rec.context);
      S.aim = ready ? 'recorded' : estimate ? (estimate.rebuilt ? 'rebuilt' : 'nominal') : null;
      var c = rec.choice, lines = [];
      if (S.view) lines.push(S.view.words);
      aimWords(own).forEach(function (w) { lines.push(w); });
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
        '\n• Click on the target: pin a line through that point (Bullba Hits’ reading below)\n• Drag turns the camera round the target, the wheel moves it closer or farther (this ends the shooter’s view)\n• The hit’s crosses are marks over the picture: the ground does not hide them, the line it does';
    }
    function showReplay(why) {
      S.mode = 'replay'; S.note = why;
      var words = S.view ? S.view.words : '';
      var me = S.row ? o.vehicle(S.row.shooter) : null;
      words = [words].concat(aimWords(!!(me && me.v && me.v.own))).join(' · ');
      note.textContent = 'No Bullba Hits view: ' + why + '. · ' + words;
      note.title = 'Why there is no heat map here\n' + why + '.\n• ' + words + '\n• Drag turns the camera round the target, the wheel moves it closer or farther (this ends the shooter’s view)';
    }
    // ---- the HUD (T3, T4) ---------------------------------------------------------------------------------------------
    // another vehicle's estimated circle (viewer.js setRebuiltEstimate reads the same block): its axis and size at the
    // shot; in the gun's view the axis is carried in the gun's frame of the shot, so it moves with the gun as drawn
    function estimateOf(context) {
      var tr = context && context.tracer, b = tr && !tr.own && tr.replayAimEstimate, c = b && b.circle;
      if (!c || !Array.isArray(c.vector) || !(c.dispersionAngle > 0) || !Array.isArray(tr.origin)) return { why: b && (b.reason || b.reasonKey) || 'Bullba Hits has no estimate of this shot' };
      var e = { o: new T.Vector3(tr.origin[0], tr.origin[1], -tr.origin[2]), n: new T.Vector3(c.vector[0], c.vector[1], -c.vector[2]).normalize(), angle: c.dispersionAngle,
        D: S.line ? S.line.len : 100, nG: null, oG: null };
      var M2 = new T.Matrix4();
      if (S.view && S.view.kind === 'gun' && o.gunAt(S.row.shooter, S.row.t, M2)) { M2.invert(); e.nG = e.n.clone().transformDirection(M2); e.oG = e.o.clone().applyMatrix4(M2); }
      return e;
    }
    // the bar's words for the circles while aiming (what each circle is, plainly)
    function aimWords(own) {
      var out = [], B = o.battle;
      if (own) {
        if (!(B && B.na > 0)) out.push('No aim circles while aiming: this battle file holds no reticle of the player');
        else {
          // which reticle fields 3-10 hold at the shot (the 0x1a tick of the tracer's clock as drawn)
          var server = sampleAt((S.line ? S.line.t : S.row.t) - (o.delay ? o.delay(S.row.shooter) : 0), AS) ? AS[12] === 1 : true;
          if (server) { out.push('While aiming - client circle: size recorded, centre taken at the cursor point (approximate)'); out.push('server circle (dashed): recorded'); }
          else out.push('While aiming - client circle: the reticle the replay holds (no server circle is recorded at this shot)');
          if (S.line) out.push('the circle of the shot’s moment (thick, dashed): appears at the shot - the server update the shell left from');
        }
      } else if (S.estimate && !S.estimate.why) out.push('While aiming - aim circle: estimate rebuilt from the replay (dashed), not a recorded one; its size at the shot, centred on the gun as drawn');
      else out.push('No aim circle while aiming: ' + (S.estimate && S.estimate.why ? S.estimate.why : 'Bullba Hits has no view of this shot'));
      out.push(sightImg.arcade ? 'Sight: the game’s own (centre mark and gun tag read from your client, the default types)' :
        'Sight: the page’s plain cross - the game’s sight could not be read (' + (sightWhy || 'not read yet') + ')');
      return out;
    }
    // the clock of the shooter's reticle this frame: the drawn one (t - the vehicle's delay), held at the shot
    function shotClock() {
      var t = Math.min(S.t, S.line ? S.line.t : S.row.t);
      return t - (o.delay ? o.delay(S.row.shooter) : 0);
    }
    // the battle's 0x1a sample at the clock tt into out (13 fields, battle.js aimFields), between two ticks when they are
    // at most AIM_GAP apart; false: none
    var AS = new Float32Array(13);
    function sampleAt(tt, out) {
      var B = o.battle, A = B && B.aim, n = (B && B.na) || 0;
      if (!A || n < 1) return false;
      var lo = 0, hi = n - 1, i = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (A[mid * 13] <= tt) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      if (i < 0) return false;
      var a = i * 13, b = i + 1 < n ? a + 13 : a, g = A[b] - A[a];
      if (tt - A[a] > AIM_GAP && !(g > 0 && g <= AIM_GAP)) return false;
      var f = g > 0 && g <= AIM_GAP ? Math.max(0, Math.min(1, (tt - A[a]) / g)) : 0;
      for (var k = 0; k < 12; k++) out[k] = A[a + k] + (A[b + k] - A[a + k]) * f;
      out[12] = A[a + 12];
      return true;
    }
    // the disc: the 0x39 update the shell left from (replay_aim.py Track.disc): among the DISC_BACK + 1 before the tracer
    // the last whose gun stands within ORIGIN_GAP of the shell's start, else the nearest of those and the one after.
    // Found once per row: {g: gun (scene), n: axis (scene), angle}
    function discGap(Sv, k, s) { return Math.hypot(Sv[k * 8 + 1] - s[0], Sv[k * 8 + 2] - s[1], Sv[k * 8 + 3] - s[2]); }
    function discOf() {
      if (S.disc !== undefined) return S.disc;
      S.disc = null;
      var B = o.battle, Sv = B && B.server, n = (B && B.ns) || 0, s = S.row.shot && S.row.shot.start;
      if (!Sv || n < 1 || !s) return null;
      var lo = 0, hi = n - 1, k0 = -1, tt = S.row.t - DISC_BEFORE, k, pick = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (Sv[mid * 8] <= tt) { k0 = mid; lo = mid + 1; } else hi = mid - 1; }
      for (k = k0; k >= 0 && k >= k0 - DISC_BACK; k--) if (discGap(Sv, k, s) <= ORIGIN_GAP) { pick = k; break; }
      if (pick < 0) for (k = Math.max(0, k0 - DISC_BACK); k < Math.min(n, k0 + 2); k++) if (pick < 0 || discGap(Sv, k, s) < discGap(Sv, pick, s)) pick = k;
      if (pick < 0) return null;
      var q = pick * 8;
      S.disc = { g: new T.Vector3(Sv[q + 1], Sv[q + 2], -Sv[q + 3]), n: new T.Vector3(Sv[q + 4], Sv[q + 5], -Sv[q + 6]).normalize(), angle: Sv[q + 7] };
      return S.disc;
    }
    // screen space: a scene point onto the HUD (device pixels) into scr; false behind the eye
    var P3 = new T.Vector3(), Q3 = new T.Vector3(), R3 = new T.Vector3(), scr = { x: 0, y: 0, d: 0 }, hudW = 0, hudH = 0, focal = 1, DPR = 1;
    function toScreen(p) {
      P3.copy(p).applyMatrix4(o.camera.matrixWorldInverse);
      if (P3.z > -0.05) return false;
      scr.d = -P3.z; P3.applyMatrix4(o.camera.projectionMatrix);
      scr.x = (P3.x + 1) / 2 * hudW; scr.y = (1 - P3.y) / 2 * hudH;
      return true;
    }
    var DASH_SERVER = [6, 4], DASH_ESTIMATE = [5, 4], DASH_DISC = [14, 8], DASH_NONE = [];
    function ring(x, y, r, colour, width, alpha, dash) {
      if (!(r > 0.5) || r > 4 * (hudW + hudH)) return;
      var g = hud2d;
      g.globalAlpha = alpha; g.strokeStyle = colour; g.lineWidth = width * DPR; g.setLineDash(dash);
      g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.stroke();
    }
    function mark(x, y, im, which) {
      var g = hud2d;
      g.globalAlpha = 1; g.setLineDash(DASH_NONE);
      if (im && im[which]) { var m = im[which]; g.drawImage(m.c, x + m.x * DPR, y + m.y * DPR, m.w * DPR, m.h * DPR); return; }
      if (which !== 'centre') return;
      // the page's plain thin cross (no sight file)
      var a = 9 * DPR, b = 3 * DPR;
      g.strokeStyle = '#ffffff'; g.lineWidth = DPR;
      g.beginPath(); g.moveTo(x - a, y); g.lineTo(x - b, y); g.moveTo(x + b, y); g.lineTo(x + a, y); g.moveTo(x, y - a); g.lineTo(x, y - b); g.moveTo(x, y + b); g.lineTo(x, y + a); g.stroke();
    }
    var discRgb = AIM_COLOUR, discKey = '';
    function discColour(c) {
      var key = c[0] + ',' + c[1] + ',' + c[2];
      if (key !== discKey) { discKey = key; discRgb = 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')'; }
      return discRgb;
    }
    // every frame after this page's render (overlay): the circles and the sight while the eye is the shooter's
    function hud() {
      var on = !!(S.row && S.fp && S.view && S.view.kind !== 'none');
      if (!on) { if (!hudCanvas.hidden) hudCanvas.hidden = true; return; }
      var el = o.renderer.domElement, dpr = root.devicePixelRatio || 1, w = Math.round(el.clientWidth * dpr), h = Math.round(el.clientHeight * dpr);
      DPR = dpr;
      if (hudCanvas.hidden) hudCanvas.hidden = false;
      if (hudCanvas.width !== w || hudCanvas.height !== h) { hudCanvas.width = w; hudCanvas.height = h; }
      hudW = w; hudH = h;
      hud2d.setTransform(1, 0, 0, 1, 0, 0); hud2d.clearRect(0, 0, w, h);
      focal = h / 2 * o.camera.projectionMatrix.elements[5];
      // at the hit Hits' own circles (at the impact) take over; the sight stays
      var hitsRings = S.stop != null && S.t >= S.stop - 1e-6 && S.mode === 'hits';
      var sniper = o.camera.fov * Math.PI / 180 < SNIPER, im = sightImg.arcade ? (sniper ? sightImg.sniper : sightImg.arcade) : null;
      var me = o.vehicle(S.row.shooter), own = !!(me && me.v && me.v.own), cx = w / 2, cy = h / 2, tx = 0, ty = 0, tag = false;
      var flying = !!(S.line && S.t >= S.line.t);
      if (own && sampleAt(shotClock(), AS)) {
        var server = AS[12] === 1;
        // the client circle: the cursor point (0-2) with the arcade diameter (11) - or, with no server reticle recorded, the
        // reticle the replay holds (fields 3-10)
        if (server) Q3.set(AS[1], AS[2], -AS[3]); else Q3.set(AS[5], AS[6], -AS[7]);
        if (toScreen(Q3)) {
          tx = scr.x; ty = scr.y; tag = true;
          if (!hitsRings) ring(scr.x, scr.y, (server ? AS[11] : AS[4]) / 2 * focal / scr.d, AIM_COLOUR, 1.5, 0.9, DASH_NONE);
        }
        if (server && !hitsRings) { Q3.set(AS[5], AS[6], -AS[7]); if (toScreen(Q3)) ring(scr.x, scr.y, AS[4] / 2 * focal / scr.d, AIM_COLOUR, 1.5, 0.9, DASH_SERVER); }
        // the centre mark at the cursor point, where the game drew it
        Q3.set(AS[1], AS[2], -AS[3]);
        if (toScreen(Q3)) { cx = scr.x; cy = scr.y; }
        // from the shot: the circle the shell left from
        var D = flying && !hitsRings ? discOf() : null;
        if (D) {
          Q3.copy(D.n).multiplyScalar(S.line.len).add(D.g);
          var v = S.viewer, look = v && v.ringLook;
          if (toScreen(Q3)) ring(scr.x, scr.y, Math.tan(D.angle) * focal, look ? discColour(look.color) : AIM_COLOUR, look && look.width > 0 ? look.width : 4,
            Math.max(0.4, v && v.discOpacity > 0 ? v.discOpacity : 0), DASH_DISC);
        }
      } else if (!own && S.estimate && !S.estimate.why) {
        var E = S.estimate;
        if (!flying && E.nG && S.view.kind === 'gun') { Q3.copy(E.nG).transformDirection(G); R3.copy(E.oG).applyMatrix4(G); Q3.multiplyScalar(E.D).add(R3); }
        else Q3.copy(E.n).multiplyScalar(E.D).add(E.o);
        if (toScreen(Q3)) { tx = scr.x; ty = scr.y; tag = true; if (!hitsRings) ring(scr.x, scr.y, Math.tan(E.angle) * focal, AIM_COLOUR, 1.5, 0.8, DASH_ESTIMATE); }
      }
      // U3: the sight follows the alternative - the centre mark at the cursor's point, the gun tag at its circle's centre
      // (the viewer's points, in its frame: A puts them into the scene)
      var X = S.alt, vw = S.viewer;
      if (X && X.a && vw && S.haveA) {
        if (vw.aimCursorPoint) { Q3.copy(vw.aimCursorPoint).applyMatrix4(A); if (toScreen(Q3)) { cx = scr.x; cy = scr.y; } }
        if (vw.liveAim) { Q3.copy(vw.liveAim.center).applyMatrix4(A); if (toScreen(Q3)) { tx = scr.x; ty = scr.y; tag = true; } }
      }
      mark(cx, cy, im, 'centre');
      if (tag) mark(tx, ty, im, 'tag');
      hud2d.globalAlpha = 1;
    }
    // ---- WHERE ELSE COULD THE SHOT GO (U3) --------------------------------------------------------------------------------
    var B = root.ArmorBallistics;
    // whether it may run this frame: stopped at the hit, the eye standing at the shell's start (on the line, the wheel not
    // moved, the glide done), Hits' scene and its shell there
    function altOk() {
      var v = S.viewer;
      return !!(S.row && S.mode === 'hits' && v && v.engine && v.shell && S.haveA && S.fp && S.line && onLine() && S.u === 0 && S.glided &&
        !S.armed && S.stop != null && Math.abs(S.t - S.stop) < 1e-6);
    }
    // the gun's horizontal sector of the block (app.js aimYawLimits without the ✸ layer's static yaw): null turns all round
    function yawLimits(a) {
      var l = a && a.turretYawLimits;
      if (!Array.isArray(l) || l.length !== 2) return null;
      var lo = Number(l[0]), hi = Number(l[1]);
      return isFinite(lo) && isFinite(hi) && hi > lo && hi - lo < 2 * Math.PI - 1e-6 ? l : null;
    }
    // the shooter's motion at the shot: the record's own (motion: the client's speed and hull rotation speed - the own
    // tracer's, or the shooter's of a hit on the player), else this replay's track. {speed, hullTurn, turretYaw, from} | null
    function shotMotion() {
      var hit = S.data.hit, at = hit.attacker || {}, tracer = S.rec && S.rec.context ? S.rec.context.tracer : null, C = root.ArmorShotContext, m = null;
      if (C && C.motionAt) {
        if (tracer && tracer.own && tracer.motion) m = C.motionAt(tracer.motion, Number(tracer.gameTime));
        if (!(m && m.speed !== undefined) && at.motion) {
          var fly = Number(hit.rangeAtImpact) > 0 && Number(hit.shellVelocity) > 0 ? hit.rangeAtImpact / hit.shellVelocity : 0;
          m = C.motionAt(at.motion, Number(hit.gameTime) - fly);
        }
      }
      if (m && isFinite(m.speed) && isFinite(m.hullYawRate)) return { speed: Math.abs(m.speed), hullTurn: Math.abs(m.hullYawRate), turretYaw: m.turretYaw, from: 'the record (the client’s own figures)' };
      var t = o.track ? o.track(S.row.shooter, S.row.t) : null;
      return t ? { speed: t.speed, hullTurn: t.hullTurn, turretYaw: t.turretYaw, from: 'the replay’s positions' } : null;
    }
    function altStart() {
      var v = S.viewer, hit = S.data.hit, a = hit.attacker && hit.attacker.aim, ring = v.savedAim || v.estimateAim;
      var X = S.alt = { read: false, job: null, fig: null, fine: false, estAt: 0, last: 0, cursor: canvas.style.cursor, why: '', a: null };
      v.inspectKey = null; ptr.fresh = true;
      var m = shotMotion();
      if (!(a && a.dispersion > 0)) X.why = 'the record holds no aim block of this shooter';
      else if (!(ring && ring.origin && ring.radius > 0)) X.why = 'Bullba Hits has no circle of this shot to start from';
      else if (!m) X.why = 'neither the record nor the replay gives the shooter’s speed at the shot';
      if (X.why) { X.tip = '\n• No circle here: ' + X.why; pinShown(); return; }
      var range = ring.origin.distanceTo(ring.center), K = ring.radius / range / a.dispersion;
      // the steady state of that motion with the gun held on its aim: Hits' manual motion (app.js aimState) - the turret
      // holding the aim against the hull's turn spends the hull's rate (turretChase with no gap)
      var hold = m.hullTurn ? B.turretChase(0, m.hullTurn, a, null, 1 / 60, false).turretTurn : 0;
      var steady = B.aimFactor(a, { speed: m.speed, hullTurn: m.hullTurn, turretTurn: hold }, null);
      var c = steady && steady.ideal > 0 && K > 0 ? Math.min(1, K / steady.ideal) : 1;
      X.a = a; X.m = m; X.K = K; X.c = c; X.mods = { mult: c }; X.limits = yawLimits(a);
      X.now = { start: K, elapsed: 0 };
      var est = !!v.estimateAim && !v.savedAim;
      X.kind = est ? 'estimate' : 'live';
      X.tip = '\n• Kept as at the shot: the speed (' + Math.round(m.speed * 3.6) + ' km/h) and the hull’s turning (' + (m.hullTurn * 180 / Math.PI).toFixed(1) + '°/s), from ' + m.from +
        '; follows the mouse: the turret and the gun, at the turret’s speed' +
        '\n• Starts as the shot’s own circle and settles to the size of that motion with the gun held on its aim' +
        (c < 1 ? '\n• The crew and equipment the record does not hold: taken from the shot’s own circle (×' + c.toFixed(2) + ')' : '') +
        (est ? '\n• An estimate: it starts from Bullba Hits’ estimate of this shooter’s circle' : '');
      canvas.style.cursor = 'none';   // the game's sight stands at the cursor (hud())
      v.setAimEmulation(true); v.setAimOffset(null);
      v.aimCursorPoint = ring.center.clone(); v.liveAimPoint = ring.center.clone();
      v.aimYaw = isFinite(m.turretYaw) ? m.turretYaw : 0;
      v.spreadAim = v.pinned && v.pinned.point ? v.pinned.point.clone() : null;
      v.setLiveAim(K * a.dispersion * 100);
      pinShown();
    }
    function altStop() {
      var X = S.alt, v = S.viewer;
      if (!X) return;
      S.alt = null;
      canvas.style.cursor = X.cursor;
      if (v) { v.spreadAim = null; v.clearLiveAim(); v.setAimEmulation(false); }
      fillCircle(cellB, null);
      pinShown();
    }
    // Hits' live figure (app.js estimateLive): a coarse one at most every ALT_COARSE s while the circle moves - one running
    // is let finish -, the fine one once at rest
    function altEstimate(fine, now) {
      var X = S.alt, v = S.viewer, shell = v.shell;
      if (X.job) { if (X.job.fine === fine) return; if (!fine) X.fine = false; X.job = null; }
      if (!fine && X.estAt && now - X.estAt < ALT_COARSE) return;
      var s = v.liveAimSampler(shell, fine ? FINE : COARSE, false, 'live');
      X.estAt = now;
      if (!s) { X.fig = null; X.fine = fine; altCircle(); return; }
      X.job = { s: s, fine: fine, shell: shell };
    }
    function altCircle() { var X = S.alt; if (X && X.a) fillCircle(cellB, X.fig, X.kind, X.kind === 'estimate', X.tip); }
    // one frame of it, after Hits' frame (the viewer's camera is this one's): the reading under the cursor, the chase, the
    // circle (app.js aimTickRun in its manual motion)
    function alt(now) {
      var ok = altOk();
      if (!ok) { if (S.alt) altStop(); return; }
      if (!S.alt) altStart();
      var X = S.alt, v = S.viewer, moved = false;
      if (ptr.fresh && isFinite(ptr.clientX)) { ptr.fresh = false; v.resize(); v.inspect(ptr); moved = true; }
      if (!X.a) return;
      var dt = X.last ? Math.max(0, now - X.last) : 0; X.last = now;
      if (!dt) dt = 1 / 60;   // Hits: one nominal frame, never a zero step
      var chase = B.turretChase(v.aimGap(X.limits), X.m.hullTurn, X.a, X.mods, dt, false);
      var turned = (chase.step > 0 || chase.pitchStep > 0) && !!v.chaseAim(chase.step, X.limits, chase.pitchStep);
      X.now = B.aimStep(X.now, { speed: X.m.speed, hullTurn: X.m.hullTurn, turretTurn: chase.turretTurn }, X.a, X.mods, dt) || X.now;
      if (X.now.radius100 > 0) v.setLiveAim(X.now.radius100);
      if (!moved && !turned && chase.caught && X.now.settled) { if (!X.fine) altEstimate(true, now); }
      else altEstimate(false, now);
    }
    // ---- the episode ----------------------------------------------------------------------------------------------------
    function episode() {
      if (!S.row) return;
      altStop(); S.stopAt = null; S.glided = false;
      o.seek(S.start); S.armed = true; S.fp = true; S.lock = true; S.lastPose = null;
      if (S.viewer && S.mode === 'hits') { S.viewer.holdShot(true); S.held = true; }
      S.u = 0; S.glide = null;
      o.speed(SPEED); o.play(true);
    }
    // the replay's clock moved from t0 to t1 in a frame: the episode stops at the hit; played on past it, the mode leaves
    // by itself AFTER s later (its exit: the heat map off, the user's speed and lens back)
    function clamp(t0, t1) {
      if (!S.row || S.stop == null) return t1;
      if (S.armed && t1 >= S.stop && t0 <= S.stop) {
        S.armed = false; o.play(false);
        S.stopAt = wallNow(); S.stopF = S.line && GLIDE > 0 ? Math.max(0, Math.min(1, (S.stop - S.line.t) / GLIDE)) : 1;
        return S.stop;
      }
      if (!S.armed && t1 >= S.stop + AFTER) close(false);
      return t1;
    }
    // ---- this page's frame: paint before its render, overlay after it --------------------------------------------------
    function paint(time, now) {
      if (!S.row) return;
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
      // U2, U3: the figures after Hits' frame (its camera is this one's now)
      if (S.lineEngine !== v.engine) hitLine();
      alt((now != null ? now : wallNow()) / 1000);
      stepJobs();
    }
    // Hits' marks over this page's picture: on the target (stencil 1) through the model, as Hits draws them; elsewhere behind
    // whatever of the map stands in front. The renderer's state is put back.
    var overlayMats = [], silHidden = [], silSwapped = [];
    // T2: the target once more with Hits' paint where a plant is in front of it (stencil 2, written by the foliage while the
    // mode is on) - only the target's painted meshes, nothing else of its group, no shadow pass; all put back
    function silhouetteMesh(x) {
      if (!x.isMesh && !x.isSprite && !x.isPoints && !x.isLine) return;
      if (!x.visible) return;
      if (x.material === paintMat) { x.material = silMat; silSwapped.push(x); } else { x.visible = false; silHidden.push(x); }
    }
    function silhouette(r) {
      var R = o.renderer, auto = R.autoClear, au = R.shadowMap.autoUpdate, nu = R.shadowMap.needsUpdate, i;
      silHidden.length = silSwapped.length = 0;
      r.group.traverse(silhouetteMesh);
      try {
        if (silSwapped.length) { R.autoClear = false; R.shadowMap.autoUpdate = false; R.shadowMap.needsUpdate = false; R.render(r.group, o.camera); }
      } finally {
        R.autoClear = auto; R.shadowMap.autoUpdate = au; R.shadowMap.needsUpdate = nu;
        for (i = 0; i < silSwapped.length; i++) silSwapped[i].material = paintMat;
        for (i = 0; i < silHidden.length; i++) silHidden[i].visible = true;
        silHidden.length = silSwapped.length = 0;
      }
    }
    function overlay() {
      hud();
      var v = S.viewer, r = S.target == null ? null : o.vehicle(S.target);
      if (S.mode !== 'hits' || !v || !r || !r.visible || !S.haveA) return;
      if (v.composed && S.saved) silhouette(r);
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
      S.token++;
      altStop();
      if (S.lineJob || was === 'hits') root.ArmorBallistics.release('circles');   // Hits' emulation off (app.js aimEstStop)
      S.lineJob = null; S.lineEngine = null; S.lineFig = null; S.stopAt = null; S.glided = false;
      release(); S.lock = false; S.view = null;   // the camera handed to the battle view's orbit where the shooter's eye was
      dropExtras();
      if (o.corridor && S.corridor) o.corridor.close(); S.corridor = null;
      if (r) o.look(r, null);
      if (sh && S.veiled) o.veil(sh, false);
      if (S.viewer && was === 'hits') S.viewer.clear();
      if (S.viewer && S.viewer.reticleLayer) S.viewer.reticleLayer.style.visibility = '';
      hudCanvas.hidden = true; S.line = null; S.estimate = null; S.disc = undefined;
      S.mode = null; S.row = null; S.armed = false; S.held = null; S.haveA = false; S.data = null; S.rec = null; S.veiled = false; S.posed = false;
      cellA.el.hidden = cellB.el.hidden = true; unpin.hidden = true; cellA.tile.hidden = cellB.tile.hidden = true;
      if (!reopen) { bar.hidden = true; if (was) o.speed(null); exit(); }
    }
    function state() {
      var v = S.viewer, sf = v && v.surface;
      return { open: !!S.row, mode: S.mode, start: S.start, stop: S.stop, hitT: S.hitT, armed: S.armed, aim: S.aim, error: S.error, note: note.textContent,
        hit: S.hits && S.hits.hit ? S.hits.hit.id : null, posed: !!S.posed, shooterHidden: S.veiled, extras: S.extras.map(function (m) { return m.userData.shotExtra; }),
        shell: S.rec && S.rec.shell ? { kind: S.rec.shell.kind, penetration: S.rec.shell.penetration, guess: S.rec.guess } : null,
        composed: !!(v && v.composed), faces: sf && sf.mesh && sf.mesh.geometry && sf.mesh.geometry.attributes.position ? sf.mesh.geometry.attributes.position.count / 3 : 0,
        ricochetLeg: !!(sf && sf.bounce), shotHeld: !!(v && v.shotHeld), backend: v ? v.backendShown : null,
        pinned: !!(v && v.pinned), pin: v && v.pinned && !cellB.el.hidden ? cellB.chance.textContent + ' ' + cellB.chips.textContent : null,
        hitLine: cellA.el.hidden ? null : { label: cellA.chance.textContent, chips: cellA.chips.textContent, extra: cellA.extra.textContent,
          circle: cellA.tile.hidden ? null : cellA.tileHead.textContent + ' ' + cellA.tileVal.textContent },
        other: cellB.el.hidden ? null : { name: cellB.name.textContent, label: cellB.chance.textContent, chips: cellB.chips.textContent,
          circle: cellB.tile.hidden ? null : cellB.tileHead.textContent + ' ' + cellB.tileVal.textContent },
        alt: S.alt ? { why: S.alt.why || null, speed: S.alt.m ? S.alt.m.speed : null, hullTurn: S.alt.m ? S.alt.m.hullTurn : null, from: S.alt.m ? S.alt.m.from : null,
          K: S.alt.K || null, c: S.alt.c || null, radius100: S.alt.now && S.alt.now.radius100 || null, fine: S.alt.fine } : null, lens: { fov: o.camera.fov, zoom: o.camera.zoom }, inMode: !!S.saved,
        view: S.view ? S.view.kind : null, firstPerson: !!S.fp, focusLocked: !!S.lock,
        line: S.line ? { t: S.line.t, length: S.line.len, along: S.u, on: onLine() } : null, hud: !hudCanvas.hidden,
        sight: sightImg.arcade ? 'game' : (sightWhy || 'not read'), estimate: S.estimate ? (S.estimate.why || 'drawn') : null, disc: S.disc ? S.disc.angle : null,
        corridor: S.corridor ? { radius: CORRIDOR, hidden: S.corridor.hidden, models: S.corridor.models, collision: S.corridor.collision, plants: S.corridor.plants, modeObjects: S.corridor.modeObjects,
          ground: S.corridor.ground, destroyedAlready: S.corridor.destroyedAlready, vehiclesHidden: S.onLine || 0, list: S.corridor.list, t: S.corridor.t, a: S.corridor.a, b: S.corridor.b } : null };
    }
    return { open: open, close: function () { close(false); }, active: function () { return !!S.row; },
      free: function () { return !!S.row; }, camera: camera, panned: panned, paint: paint, overlay: overlay, clamp: clamp, state: state, viewer: function () { return S.viewer; },
      paintMaterial: paintMat, bar: bar };
  }
  root.BullbaShotView = { create: create, BEFORE: BEFORE, SPEED: SPEED, AFTER: AFTER, INSIDE: INSIDE };
})(window);
