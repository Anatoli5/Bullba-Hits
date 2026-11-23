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
     pixel ratio, never outside it, and the depth test hides it wherever the map stands in front. PAINT blends the map
     as Hits shows it (1.19, the user on 1.18): its see-through parts - the tracks, the wheels, the spaced screens at Hits'
     Screen opacity - show what stands behind them (the battlefield, where Hits shows its background), drawn once a pixel.
   - Hits' marks of the hit (the hit line through the model, its crosses, the aim circles, a pinned line) are the viewer's
     own objects, drawn over this page's picture (overlay) in two passes: where the target is on screen (stencil 1, written
     by PAINT) through the model as Hits draws them; elsewhere depth-tested against the map, so a wall or the ground in
     front hides them. Hits' Grid (the user's own setting) is drawn in a third pass with its own depth test, as Hits draws
     it.
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
   - an SPG (22.11) with no recorded camera over the episode: the game's artillery trajectory view rebuilt (artyView: the
     eye behind the aim point along the shell's fall, 25-95 m out - a reconstruction), still until the shot.
   The bar says which. FROM THE SHOT (20.11, NOTEBOOK T1: the tracer's clock) the eye no longer rides with the shooter: it
   travels forward on the shell's line, ending far enough from the contact to frame the collision target; on a recorded
   arc (22.11) looking along the arc's tangent from the first frame (a cut at release), at the eased pace or - Settings'
   experimental "camera at the shell's speed" (#sv-shell-clock) - at the shell's own clock. A short
   flight's camera presentation may finish after the battle stops at impact. Before release, another shooter's lens is
   a simulated framing chosen once from the client's zoom steps; own recorded pre-shot camera is preserved. The lens
   returns smoothly to the viewer's normal field of view during the trip. There the wheel moves it
   along that line towards the target and back (lineWheel: the page's own zoom steps, never past LINE_NEAR m short of the
   hit - the line's length for a shorter shot - nor behind the start). A shot of any length has its line; one of no
   length looks along the shell's own direction (the gun's at the shot).
   THE SHOT'S FLIGHT, DRAWN (1.21, the user on 1.20): from the shot for as long as the view holds it, ONE dashed line from
   the line's start to its end - the very line the eye stands on and the wheel moves along (flightLine) - in the dashed
   style of Hits' flight arc; the replay's own tracer of this shot is not drawn meanwhile (drawsShot, asked by playback.js
   poseTracers: a shell stopped at the hit within its first tick had a tracer of no length there). Hits' own flight arc
   and its start dot are not drawn here: Hits turns its flight about the contact onto the recorded segment, which in the
   replay's world put its start metres off the gun (4.5 m on the user's shot of 19.11); Hits' hit line through the model,
   its arrowhead, crosses and circles stay - they meet this line at that turn's angle.
   THE SHOOTER AT THE SHOT (1.20): from the shot until play goes on past the hit the shooter is drawn as it was when it
   fired (hull, turret, gun: heldPose, asked by playback.js poseVehicles), so the tracer starts at its muzzle seen from
   anywhere; the target stays at the replay's clock.
   At the stop the picture stays as the shooter saw it; a drag, a move key or (before the shot) the wheel (release())
   ends the first person: the field of view the viewer had, the camera orbiting the target's FOCUS - Bullba Hits' orbit
   centre (viewer.js vehicleCentre / pivotCentre: over the hull's box, at the turret's height or the shooter's gun
   height), ridden with the target as this page draws it -, the wheel closer / farther as everywhere. The target not
   drawn at that moment: its last focus, else the hit point, else the line's end - never under the ground (o.ground;
   1.20: before it, a point 20 m along the view, often under the ground). The eye's floor is the page's (placeCamera). A pan or a move
   key frees the centre from the target (panned()). Manual camera input restores the viewer's lens immediately.
   Map objects on the shell's line occlude as anywhere (the corridor that hid them, 20.11, was taken out 22.11: recorded
   arcs and ordinary scene depth decide).
   The shooter: while the eye is inside it (INSIDE: its hull, turret or gun box grown by INSIDE metres) it is veiled - not
   drawn, its shadow kept; flown out of it, it is drawn again.
   The episode: the battle from 2 s before the shot, at x1, stopped at the hit (the row's hit event; a shot with no hit:
   its tracer's end) with the hit line shown from then on; played on, the mode leaves by itself AFTER s past the stop, so
   the heat map's cost does not run on into the battle. Replay episode: the same, the camera left as the user put it.
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
   drawn, dashed). Foreign size is reconstructed on the existing size-model grid from the browser's tracks and descriptor
   inputs; where available the Hits release circle anchors its scale and axis. At the hit Hits' own circles take over.
   No foreign mouse position is invented: only the gun tag identifies that estimated centre. The game's sight (own centre
   mark at the recorded cursor point, the gun tag at the circle's centre) from the
   file the mod reads from the client (o.sight, game_sight.py); without it a thin cross of the page. One Hits hit-location
   cross marks the visible shot line's endpoint after a confirmed hit, independently of the mouse/gun HUD tags.
   An SPG shooter (22.11): instead of these, the SPG mark (spgMarkDraw) - the dispersion circle square to the shell's
   fall at the aim point, carried along the fall onto the target's boxes or the ground: a circle seen along the fall.

   THE SHOT'S FIGURES (20.11, NOTEBOOK U2; cells()): two cells in the bar, as Bullba Hits' panels read a shot. A fixed
   size (1.19, the user on 1.18): each figure has its own one-line place - the heading with the figure, the alpha and the
   circle; the armour (pen, eff, screens); the damage parts; the ricochet -, an empty place keeps its height, a long text
   is cut with its whole in the tooltip; both cells always there. "Hit line":
   the recorded line (viewer.shotProbability with the shell at the record's range) in Hits' words (web/armor-line.js line)
   and "Circle" over the ring Hits draws for the hit (the own recorded one - viewer.savedAimSampler -, else Hits' estimate -
   estimateAimSampler -, then headed "Circle, estimate"), its figure and words armor-line.js circleFigure / circleText /
   CIRCLE_TITLES; the integral goes to Hits' worker (sampler.post), the frame takes one 3 ms slice of it at most (Hits'
   AIM_EST_SLICE). Not here: Hits' track chip (it reads the characteristics file through app.js).
   WHERE ELSE COULD THE SHOT GO (U3; a plain screen tool since 1.19, the user on 1.18; alt()): the option "aim circle"
   in the bar (o.aimToggle, off by default, kept with the page's settings). On, once stopped at the hit with the eye at
   any position on the line (the glide done), the right cell reads the point under the cursor
   (Hits' viewer.inspect: one reading a frame, from the eye) and a cyan ring stands at the cursor on the HUD, over
   everything, as wide as the shot's own circle at the shot (the ring of the "Hit line": its angle, constant). It
   pretends nothing - no turret turn, gun limits or motion. The rays keep the real shot origin when the camera moves;
   the HUD projects the resulting world circle. Its figure: Hits' live circle (viewer.liveAim, its own line not
   drawn) over that ring, Hits' live rule (estimateLive): 256 rays at most every ALT_COARSE s while it moves, 1024 once at
   rest, in the worker. A click pins the point (Hits' pin; the ring stays on it); the HUD's sight follows, the system
   pointer hidden over the picture. Off: no ring; the right cell is the pinned point, or its place with how to pin one.

   A replay file Bullba Hits has no battle of: the mod makes it from the replay ('prepareBattle' with the file's id).
   What cannot be had (outside the game; a replay the route refuses; a shot with no hit; a hit the battle does not list; a
   scene without its models; no WebGL 2) is not made up: the episode plays and the bar says what is missing.

   BullbaShotView.create(o) -> {open(row), close(), active(), free(), camera(t), panned(), paint(t, now), overlay(),
   clamp(t0, t1), state()};
   o: {view (the element the canvas is in), camera, renderer, battle, hitsBattle, battleId, dataBase, vehicle(id), name(id),
   clock(t), seek(t), play(on), speed(v | null), orbit(eye, at) (scene coordinates), veil(r, on), look(r, material | null),
   recordedOk(id, t0, t1), recorded(id, t, pos, quat) -> fov | null, gunAt(id, t, matrix) -> matrix | null, delay(id) -> s,
   aimToggle (the option's checkbox, moved into the bar), ground(x, z) -> the ground's y | null (scene), foliage(k | null),
   plantStencil(on), sight() -> Promise<the sight file's value | null>}; heldPose(id, t) -> the clock to pose vehicle id at,
   or null (the shooter held at the shot); targetPose(id, t) -> {world, yaw, pitch} or null (the target at the server's
   moment from the hit on); drawsShot(index, t) -> whether the view draws that shot's flight itself.
   21.11: o.contact(hit event index, t) -> {point, dir} (scene: the page's placed hit point and the server segment's direction
   at the hit's clock t) or null, o.seen(id, t) -> whether the replay has the vehicle in sight then (the stub, BACKLOG 119);
   row() -> the row on screen or null; heldHits() -> its hit events' indices (the contact dot, BACKLOG 121) or null.
   The top line also holds Look back (BACKLOG 120: the eye on the line turned to its source) and the gun's shell chips
   (BACKLOG 122: Bullba Hits' shell switch; another shell's figures an estimate, said by a ⚠). */
(function (root) {
  'use strict';
  var T = root.THREE;
  // s before the shot; the episode's speed (x1, the owner on 1.16: 1/4 too slow); s past the stop after which a battle
  // played on leaves the mode
  var BEFORE = 2, SPEED = 1, AFTER = 1;
  // The nearest the wheel brings it to the hit (m); the wheel's steps: the page's own zoom (playback.js ZOOM).
  var LINE_NEAR = 3, WHEEL_IN = 0.23, WHEEL_OUT = 0.30, WHEEL_FLOOR = 0.8;
  // 1.20: a line shorter than LINE_MIN m has no direction of its own (the shell's is taken); an orbit centre stays at least
  // FOCUS_FLOOR m over the ground
  var LINE_MIN = 0.05, FOCUS_FLOOR = 0.5;
  // 21.11 (BACKLOG 119): a shot whose shooter the replay does not place at the shot (no tracer, the shooter out of sight):
  // the line is a STUB of STUB m arriving at the contact along the hit's own direction (the server's hit segment), the eye
  // STUB_EYE m out on it - a CONVENTION (the owner's numbers), marked by the bar's ⚠; where the shooter stood is not known
  var STUB = 100, STUB_EYE = 30;
  // T2: the foliage slider's value forced for the mode (0 solid .. 1 gone; a guess by eye: the bush still reads); the
  // silhouette's opacity over what stands in front (a guess by eye)
  var FOLIAGE = 0.5 /* 21.11, the user: 0.5 is already a strong see-through, no more */, SILHOUETTE = 0.5;
  // T3: Hits' colour of a recorded or estimated circle (viewer.js AIM_RING); a 0x1a sample is drawn between two ticks only
  // when they are at most AIM_GAP s apart (ticks are 0.1 s; the measured largest gap in the 2 s before 54 own shots 0.2 s);
  // the disc: the 0x39 strictly before the tracer whose gun stands at the shell's origin (replay_aim.py BEFORE, ORIGIN_GAP,
  // DISC_BACK); below SNIPER rad of field of view the sight is the sniper one (arcade 1.178, sniper 0.295 and less)
  var AIM_COLOUR = '#ff5ad6', AIM_GAP = 0.3, DISC_BEFORE = 1e-4, ORIGIN_GAP = 0.05, DISC_BACK = 3, SNIPER = 0.9;
  // The shooter is not drawn while the eye is within INSIDE m of its hull, turret or gun box (each in its own frame). 0.5 m:
  // Hits' eye stands 0.30 m past the muzzle on the shell's axis (the test's figure), so it starts inside; a step away
  // from the vehicle shows it again.
  var INSIDE = 0.5;
  // U2, U3: Hits' cadence of a circle's figure (app.js estimateLive, AIM_EST_SLICE): the coarse figure at most every
  // ALT_COARSE s while the circle moves, of COARSE rays; the fine one of FINE rays once at rest; one SLICE ms a frame on
  // the main thread when there is no worker
  var ALT_COARSE = 0.12, COARSE = 256, FINE = 1024, SLICE = 3;
  // Hits' live ring's colour (viewer.js AIM_LIVE, cyan), the alternative's ring on the HUD
  var ALT_COLOUR = '#5ee0ff';
  // Adopt Hits' existing look where this origin can read it; file:// sharing is
  // browser-dependent. Impact look has one canonical helper and local controls
  // in both pages, so it also works when those file origins are isolated.
  var HITS_LOOK = { 'armor-mode': 'damage', palette: 'classic', 'soft-lighting': true, 'light-strength': '200',
    'track-opacity': '20', 'impact-opacity': '100', 'impact-color': '#258cff', 'bounce-mode': 'always',
    'ricochet-tint-on': true, 'ricochet-tint': '50', 'ricochet-dots-on': true, 'ricochet-dots': '3', 'part-edges': 'on',
    'zone-outline': 'off', 'heatmap-quality': 'auto', wireframe: true, 'outline-brightness': '15', 'outline-opacity': '6' };
  function hitsLook() {
    var out = {}, box = null;
    try { box = JSON.parse(root.localStorage.getItem('bullba-settings') || 'null'); } catch (e) { box = null; }
    var v = box && box.values && typeof box.values === 'object' ? box.values : {};
    Object.keys(HITS_LOOK).forEach(function (k) { out[k] = typeof v[k] === typeof HITS_LOOK[k] ? v[k] : HITS_LOOK[k]; });
    var impact = root.BullbaSettings.impact.get();
    out['impact-opacity'] = String(impact.opacity); out['impact-color'] = impact.color;
    return out;
  }
  function num(s, d) { var n = Number(s); return isFinite(n) ? n : d; }
  function wallNow() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  // Size only: replay_aim_other.Shooter's 0.1 s grid, lagged central differences,
  // held rotation samples and typical unknown build. The direction estimator stays
  // in Hits. Formula integration uses its existing JavaScript owner.
  function sizeSeries(v, aim, shots, release) {
    var B = root.ArmorBallistics, tags = aim && aim.gunTags || [];
    if (!B || !aim || !(aim.dispersion > 0) || !aim.pitchLimits || v.np < 10 || v.ng < 2 ||
        aim.reason || aim.autoShoot || aim.dualAccuracy || aim.hasSiegeMode || tags.indexOf('autoShoot') >= 0 || tags.indexOf('dualAccuracy') >= 0) return null;
    var burst = aim.burst;
    if (burst && burst[0] > 1 && shots.some(function (t) { return t < release - .001 && release - t <= (burst[0] - 1) * burst[1] + .3; })) return null;
    function track(data, stride, col, angular, holds) {
      var ts = [], vs = [], last = null, shift = 0;
      for (var i = 0; i < data.length; i += stride) {
        var t = data[i], x = data[i + col];
        if (angular && last != null) { var d = x - last; if (d > Math.PI) shift -= 2 * Math.PI * Math.floor((d + Math.PI) / (2 * Math.PI)); else if (d < -Math.PI) shift += 2 * Math.PI * Math.floor((-d + Math.PI) / (2 * Math.PI)); }
        last = x; x += shift;
        if (ts.length && t <= ts[ts.length - 1] + 1e-6) { vs[vs.length - 1] = x; continue; }
        if (holds && ts.length && t - ts[ts.length - 1] > .45) { ts.push(t - .1); vs.push(vs[vs.length - 1]); }
        ts.push(t); vs.push(x);
      }
      return { t: ts, v: vs };
    }
    function index(a, t) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (a[m] <= t) lo = m + 1; else hi = m; } return lo - 1; }
    function value(a, t) { var i = index(a.t, t); if (i < 0) return a.v[0]; if (i + 1 === a.t.length) return a.v[i]; return a.v[i] + (a.v[i + 1] - a.v[i]) * (t - a.t[i]) / (a.t[i + 1] - a.t[i]); }
    var xyz = [1, 2, 3].map(function (c) { return track(v.pos, 7, c, false, false); });
    var hull = track(v.pos, 7, 4, true, true), turret = track(v.gun, 3, 1, true, true), pt = xyz[0].t;
    function fresh(t) { var i = index(pt, t); return i >= 0 && t - pt[i] <= 1 && (i + 1 >= pt.length || pt[i + 1] - pt[i] <= 1 || t <= pt[i] + .1); }
    if (!fresh(release)) return null;
    var mods = { mult: .92, aimingTime: .92 * .95, additive: .9, turret: .925 };
    var a = {}; ['dispersion', 'aimingTime', 'movementFactor', 'rotationFactor', 'turretRotationFactor', 'afterShotFactor'].forEach(function (k) { a[k] = aim[k]; });
    var aiming = B.aimFactor(a, {}, mods).aimingTime, base = pt[0], n = Math.max(1, Math.ceil((pt[pt.length - 1] - base) / .1 - 1e-9));
    function tickBefore(t) { var k = Math.floor((t - .0001 - base) / .1); while (base + (k + 1) * .1 < t - .0001) k++; while (base + k * .1 >= t - .0001) k--; return Math.max(0, Math.min(n - 1, k)); }
    var first = tickBefore(release - BEFORE), end = tickBefore(release), back = Math.ceil(Math.max(6 * aiming, 5) / .1), bloom = {};
    shots.forEach(function (t) { var k = Math.max(0, Math.ceil((t - .0001 - base) / .1 - 1e-9)); while (k > 0 && base + (k - 1) * .1 >= t - .0001) k--; while (k < n && base + k * .1 < t - .0001) k++; bloom[k] = true; });
    var state = null, values = {};
    for (var k = Math.max(0, first - back); k <= end; k++) {
      var t = base + k * .1, lo = t - .4, hi = t - .2;
      var speed = Math.hypot.apply(Math, xyz.map(function (p) { return value(p, hi) - value(p, lo); })) / .2;
      var s = { speed: speed, hullTurn: Math.abs(value(hull, hi) - value(hull, lo)) / .2, turretTurn: Math.abs(value(turret, hi) - value(turret, lo)) / .2 };
      state = B.aimStep(state, s, a, mods, .1);
      if (bloom[k]) state = B.aimShot(state, s, a, mods);
      if (k >= first) values[k] = a.dispersion * state.factor;
    }
    return { release: values[end], at: function (t) {
      if (!fresh(t)) return null;
      var sample = (Math.min(t, release) - base) / .1, k = Math.max(first, Math.min(end, Math.floor(sample + 1e-8))), next = Math.min(end, k + 1);
      // Settle continuously between valid ticks, but never smear a previous shot's
      // instantaneous bloom backwards, bridge an unseen gap, or include own bloom.
      if (k === next || bloom[next] || !fresh(base + k * .1) || !fresh(base + next * .1)) return values[k];
      var blend = Math.max(0, Math.min(1, sample - k));
      return values[k] + (values[next] - values[k]) * blend;
    } };
  }
  // The row's hit as the panel's row shows it (shots-panel.js shownHit: the one with damage, else the last); null: none
  function shownHit(row) { return row.hits && row.hits.length ? root.BullbaShotsPanel.shownHit(row) : null; }
  function node(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  // PAINT: Hits' composed map (premultiplied colour + coverage, Surface.markInto) at this fragment's pixel, blended over the
  // picture as Hits' quad blends over its scene: where the map is see-through (Hits' Screen opacity on the tracks, wheels
  // and screens) what stands behind shows (1.19; before it the rest was filled with Hits' grey, so they read solid). Drawn
  // after the opaque scene (transparent), once a pixel: the first fragment writes stencil 1 and the target's other faces
  // on that pixel fail it (the map already holds every layer) - stencil 1 is also the overlay's "on the target" test.
  // GLSL 3 - the map exists only on WebGL 2, and without it the target keeps its own look.
  var PAINT_VERTEX = 'precision highp float;\nin vec3 position;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\n' +
    'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
  var PAINT_FRAGMENT = 'precision highp float;\nuniform highp sampler2D uPaint;\nout vec4 outColor;\n' +
    'void main(){outColor=texelFetch(uPaint,ivec2(gl_FragCoord.xy),0);}';
  // the silhouette (T2): the same map, half transparent, only where a plant is in front (stencil 2: playback.js
  // shotPlantStencil), drawn over the picture without the depth test
  var SILHOUETTE_FRAGMENT = 'precision highp float;\nuniform highp sampler2D uPaint;\nuniform float uAlpha;\nout vec4 outColor;\n' +
    'void main(){outColor=texelFetch(uPaint,ivec2(gl_FragCoord.xy),0)*uAlpha;}';

  // ---- THE ARTILLERY VIEW AND THE SHELL'S TANGENT (22.11, outputs/arty-shot-view-2026-11-22.md): pure maths on [x, y, z]
  // arrays in the scene's axes (no THREE), exposed as BullbaShotView.arty for tests/test_shot_view_arty.cjs.
  // The game's trajectory view (ArtyCamera, gui/avatar_input_handler.xml <artyMode><camera>, read): the eye behind and above
  // the aim point on the line the shell arrives along - yaw = the fall's heading, pitch = max(the fall's pitch, 10 deg) -,
  // at the player's scroll distance clamped to 25-95 m (the scroll is not recorded: the nearest that frames the target -
  // a reconstruction). The SPG mark (gun_marker_ctrl _makeSPGProvider, read): 37 launch directions on the dispersion cone
  // flown with the shot's gravity to where they meet the world; here (22.11, the user) the dispersion circle square to the fall at the
  // aim point carried along the fall onto the target's boxes or the ground - as the trajectory view sees it, a circle.
  var ARTY_DIST = [25, 95], ARTY_STEP = 0.5, ARTY_MIN_PITCH = 10 * Math.PI / 180, ARTY_USABLE = 0.72, MARK_N = 37;
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vnorm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1]; }
  // the unit direction of the drawn path at u (pt(u) -> scene point): a central difference, one-sided at the ends
  function tangentAt(pt, u) {
    var h = 1e-3, a = Math.max(0, u - h), b = Math.min(1, u + h);
    if (b - a < h) { a = Math.max(0, b - h); b = Math.min(1, a + h); }
    return vnorm(vsub(pt(b), pt(a)));
  }
  // arc length <-> u over the path's samples ({u, d}, battle.js trajectory: lengths do not change with the z mirror)
  function arcD(path, u) {
    var s = path.samples, i = 1; u = Math.max(0, Math.min(1, u));
    while (i < s.length - 1 && s[i].u < u) i++;
    var a = s[i - 1], b = s[i], f = b.u > a.u ? (u - a.u) / (b.u - a.u) : 0;
    return a.d + (b.d - a.d) * Math.max(0, Math.min(1, f));
  }
  function arcU(path, d) {
    var s = path.samples, i = 1; d = Math.max(0, Math.min(path.length, d));
    while (i < s.length - 1 && s[i].d < d) i++;
    var a = s[i - 1], b = s[i], f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return a.u + (b.u - a.u) * f;
  }
  // the eye on the recorded arc at the shell's own clock (f = elapsed / duration), stopping at the arc fraction endU, and
  // its forward along the arc's tangent there: {u (arc fraction), eye, fwd}
  function lineFrame(path, pt, f, endU) {
    var uArc = Math.min(endU, arcD(path, f) / path.length), uc = arcU(path, uArc * path.length);
    return { u: uArc, eye: pt(uc), fwd: tangentAt(pt, uc), uc: uc };
  }
  // the same with 1.28's pace: the eye at the arc fraction endU x smooth (smooth = smoothstep of the eased clock), never
  // past the shell (23.11, the user: shellF - the shell's flight fraction now, its arc fraction caps the eye's; lagging it
  // stays allowed)
  function easedFrame(path, pt, smooth, endU, shellF) {
    var uArc = endU * smooth;
    if (shellF != null) uArc = Math.min(uArc, arcD(path, shellF) / path.length);
    var uc = arcU(path, uArc * path.length);
    return { u: uArc, eye: pt(uc), fwd: tangentAt(pt, uc), uc: uc };
  }
  // the game's trajectory view at aim point `aim` with the shell falling along `fall`: the nearest distance in 25-95 m
  // that frames `points` (vertical fov in degrees, aspect, ARTY_USABLE of the frame), pulled nearer while the eye stands
  // under the ground (ground(x, z) -> y | null; never under 25 m: the game's collision floor)
  function artyFrame(aim, fall, points, fovDeg, aspect, ground) {
    var h = Math.hypot(fall[0], fall[2]), yaw = Math.atan2(fall[0], fall[2]);
    var hx = h > 1e-9 ? fall[0] / h : 0, hz = h > 1e-9 ? fall[2] / h : 1;
    var pitch = Math.max(Math.asin(Math.max(-1, Math.min(1, -fall[1]))), ARTY_MIN_PITCH);
    var dir = [Math.cos(pitch) * hx, -Math.sin(pitch), Math.cos(pitch) * hz];
    var right = vnorm(vcross(dir, [0, 1, 0])), up = vcross(right, dir), tan = Math.tan(fovDeg * Math.PI / 360), k = aspect || 1;
    function eyeAt(d) { return [aim[0] - dir[0] * d, aim[1] - dir[1] * d, aim[2] - dir[2] * d]; }
    function fits(e) {
      return (points || []).every(function (p) {
        var r = vsub(p, e), z = vdot(r, dir);
        return z > 0.5 && Math.abs(vdot(r, up)) <= tan * ARTY_USABLE * z && Math.abs(vdot(r, right)) <= tan * k * ARTY_USABLE * z;
      });
    }
    var dist = ARTY_DIST[1], ok = false;
    for (var d = ARTY_DIST[0]; d <= ARTY_DIST[1] + 1e-9; d += ARTY_STEP) if (fits(eyeAt(d))) { dist = d; ok = true; break; }
    if (ground) for (; dist > ARTY_DIST[0]; dist -= ARTY_STEP) { var e = eyeAt(dist), g = ground(e[0], e[2]); if (g == null || !isFinite(g) || e[1] >= g + 1) break; }
    dist = Math.max(ARTY_DIST[0], dist);
    return { eye: eyeAt(dist), look: aim.slice(), dir: dir, pitch: pitch, yaw: yaw, dist: dist, fits: ok };
  }
  // a segment a->b (scene) against a box {inv (16, column-major: scene -> box frame), min, max}: the first fraction in
  // [0, 1] where it enters, or -1 (the slab test)
  function segBox(a, b, bx) {
    var m = bx.inv, la = [0, 0, 0], lb = [0, 0, 0], i;
    for (i = 0; i < 3; i++) {
      la[i] = m[i] * a[0] + m[4 + i] * a[1] + m[8 + i] * a[2] + m[12 + i];
      lb[i] = m[i] * b[0] + m[4 + i] * b[1] + m[8 + i] * b[2] + m[12 + i];
    }
    var t0 = 0, t1 = 1;
    for (i = 0; i < 3; i++) {
      var d = lb[i] - la[i];
      if (Math.abs(d) < 1e-12) { if (la[i] < bx.min[i] || la[i] > bx.max[i]) return -1; continue; }
      var u = (bx.min[i] - la[i]) / d, v = (bx.max[i] - la[i]) / d;
      if (u > v) { var w = u; u = v; v = w; }
      t0 = Math.max(t0, u); t1 = Math.min(t1, v);
      if (t0 > t1) return -1;
    }
    return t0;
  }
  // where a shell from `origin` with velocity `vel` and gravity g (down) first meets the world while it descends: the
  // target's boxes (each {inv, min, max, top: its highest scene y}) or the ground (ground(x, z) -> y); null: never
  function flyToGround(origin, vel, g, ground, boxes) {
    if (!(g > 0)) return null;
    function at(t) { return [origin[0] + vel[0] * t, origin[1] + vel[1] * t - 0.5 * g * t * t, origin[2] + vel[2] * t]; }
    function down(h) { var c = vel[1] * vel[1] + 2 * g * (origin[1] - h); return c < 0 ? null : (vel[1] + Math.sqrt(c)) / g; }
    var h = ground ? ground(origin[0], origin[2]) : 0, t = null;
    if (h == null || !isFinite(h)) h = 0;
    for (var k = 0; k < 5; k++) {
      t = down(h); if (t == null) return null;
      var p = at(t), gh = ground ? ground(p[0], p[2]) : 0;
      if (gh == null || !isFinite(gh)) break;
      if (Math.abs(gh - h) < 1e-4) { h = gh; break; }
      h = gh;
    }
    t = down(h); if (t == null || !(t > 0)) return null;
    var hit = at(t);
    if (boxes && boxes.length) {
      var top = -Infinity; boxes.forEach(function (b) { top = Math.max(top, b.top); });
      var t0 = top > h ? down(top) : null;
      if (t0 != null && t0 < t) {
        var n = 24, a = at(t0);
        for (var i = 1; i <= n; i++) {
          var tb = t0 + (t - t0) * i / n, b = at(tb), best = -1;
          for (var j = 0; j < boxes.length; j++) { var f = segBox(a, b, boxes[j]); if (f >= 0 && (best < 0 || f < best)) best = f; }
          if (best >= 0) return [a[0] + (b[0] - a[0]) * best, a[1] + (b[1] - a[1]) * best, a[2] + (b[2] - a[2]) * best];
          a = b;
        }
      }
    }
    return hit;
  }
  // the velocity's direction where a shell from `origin` with velocity `vel` and gravity g reaches `point` (its fall there)
  function fallAt(origin, vel, g, point) {
    var hs = Math.hypot(vel[0], vel[2]), t = hs > 1e-6 ? Math.hypot(point[0] - origin[0], point[2] - origin[2]) / hs : 0;
    return vnorm([vel[0], vel[1] - g * t, vel[2]]);
  }
  // a straight ray from p0 along the unit `dir` (descending): the first entry into a box, else where it crosses the
  // ground (2 m steps, then halving); null: no crossing within `reach` m
  var MARK_BACK = 40, MARK_STEP = 2;
  function rayHit(p0, dir, ground, boxes, reach) {
    function at(s) { return [p0[0] + dir[0] * s, p0[1] + dir[1] * s, p0[2] + dir[2] * s]; }
    function under(s) { var p = at(s), g = ground ? ground(p[0], p[2]) : 0; if (g == null || !isFinite(g)) g = 0; return p[1] <= g; }
    var lo = 0, hi = null, s;
    // the start already under the ground (it rises against the fall): back up the ray to where it is above
    if (under(0)) { for (s = -MARK_STEP; s >= -reach; s -= MARK_STEP) if (!under(s)) { lo = s; hi = s + MARK_STEP; break; } if (hi == null) return null; }
    else for (s = MARK_STEP; s <= reach; s += MARK_STEP) { if (under(s)) { hi = s; break; } lo = s; }
    if (hi == null) return null;
    var from = Math.min(0, lo);
    for (var k = 0; k < 30; k++) { var m = (lo + hi) / 2; if (under(m)) hi = m; else lo = m; }
    var a = at(from), hit = at(hi), best = -1;
    (boxes || []).forEach(function (b) { var f = segBox(a, hit, b); if (f >= 0 && (best < 0 || f < best)) best = f; });
    return best >= 0 ? at(from + (hi - from) * best) : hit;
  }
  // the SPG mark (22.11, the user: the aim circle itself, as the trajectory view looking along the fall sees it): the
  // dispersion circle of `radius` round the aim point `centre` in the plane square to the shell's `fall`, each of its
  // MARK_N points carried along the fall onto the target's boxes or the ground (rayHit) - on the ground its oblique
  // projection; an array of points (null where one meets nothing)
  function fallMark(centre, fall, radius, ground, boxes) {
    var n = vnorm(fall), r = vcross(n, [0, 1, 0]);
    r = Math.hypot(r[0], r[1], r[2]) < 1e-9 ? [1, 0, 0] : vnorm(r);
    var u = vcross(r, n), out = [], back = MARK_BACK + radius;
    for (var i = 0; i < MARK_N; i++) {
      var a = i * 2 * Math.PI / MARK_N, ca = Math.cos(a) * radius, sa = Math.sin(a) * radius;
      out.push(rayHit([centre[0] + r[0] * ca + u[0] * sa - n[0] * back, centre[1] + r[1] * ca + u[1] * sa - n[1] * back, centre[2] + r[2] * ca + u[2] * sa - n[2] * back],
        n, ground, boxes, 3 * back + 200));
    }
    return out;
  }
  var ARTY = { DIST: ARTY_DIST, MIN_PITCH: ARTY_MIN_PITCH, USABLE: ARTY_USABLE, MARK_N: MARK_N, tangentAt: tangentAt, arcD: arcD, arcU: arcU,
    lineFrame: lineFrame, easedFrame: easedFrame, artyFrame: artyFrame, flyToGround: flyToGround, fallAt: fallAt, rayHit: rayHit, fallMark: fallMark, segBox: segBox };

  // THE SERVER CIRCLE FROM THE SERVER'S GUN UPDATE (23.11, NOTEBOOK Z5). The dashed ring was taken only from packet 0x1a's
  // fields 3-10, and those hold the server reticle only while the game keeps it updated (battle.js markerRows' flag); at
  // other shots they hold the client reticle and the ring was dropped, though every server tick's 0x39 - gun position,
  // shot vector, dispersion half-angle - is in the replay. MEASURED 23.11 on the user's Redshire battle of 22.11 21:58
  // (5 of 22 own shots without the flag) and Fisherman's Bay of 23.11 (3776 flagged 0x1a samples of both): the server
  // reticle's diameter is 2 x dispersion x its distance from the gun (ratio median 1.0000, p10 0.956) and its centre lies on
  // the 0x39 axis (median 1-4 cm off it). So: the last 0x39 at the clock `tt` (at most `gap` s old), its axis taken out to
  // the distance of `point` (the 0x1a cursor point: where the reticle stands along the axis is not in the replay - the one
  // reconstructed figure, said by the bar's ⚠). Rows of 8 floats (battle.js serverFields), game axes.
  // -> {centre, radius, gun, k} or null
  function serverRing(server, ns, tt, point, gap) {
    var lo = 0, hi = (ns || 0) - 1, k = -1;
    if (!server || !(ns > 0) || !point) return null;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (server[mid * 8] <= tt) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0 || tt - server[k * 8] > gap) return null;
    var q = k * 8, g = [server[q + 1], server[q + 2], server[q + 3]], n = vnorm([server[q + 4], server[q + 5], server[q + 6]]);
    var d = Math.hypot(point[0] - g[0], point[1] - g[1], point[2] - g[2]), angle = server[q + 7];
    if (!(d > 1) || !(angle > 0)) return null;
    return { centre: [g[0] + n[0] * d, g[1] + n[1] * d, g[2] + n[2] * d], radius: angle * d, gun: g, k: k };
  }
  // THE WHEEL'S REACH BACK FROM THE HIT (23.11, NOTEBOOK Z7): the eye goes back along the shot up to the line's length and, past
  // the muzzle, straight on backwards along the launch direction (not drawn) - as far as BACK_FRAME times the distance at which
  // the target fills the frame's usable part (prepareLens' `need`): at that the tank stands at about a quarter of the frame's
  // height, an ordinary view of it at point-blank range. -> the largest distance from the hit
  var BACK_FRAME = 3;
  function backReach(len, need) { return Math.max(len || 0, BACK_FRAME * (need > 0 ? need : 0)); }
  ARTY.serverRing = serverRing; ARTY.backReach = backReach; ARTY.BACK_FRAME = BACK_FRAME;

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
    var bar = node('div', undefined, 'panel sv-bar'), title = node('span', '', 'sv-title');
    var again = node('button', 'Replay episode', 'sv-again'), leave = node('button', 'Leave', 'sv-leave');
    // U2, U3: the two cells - the recorded shot ("Hit line") and the other point ("Under the cursor" / "Pinned point") - as
    // Bullba Hits' panels: a heading, the chance or the share of alpha with the alpha muted, the circle's tile; then the
    // line's chips in places of their own, one line each whatever the shot (1.19, the user on 1.18: nothing moves): the
    // armour (pen, eff, screens, contact) and the outcome's details (the ricochet, then the damage parts). A place with
    // nothing keeps its height. 23.11 (NOTEBOOK Z2): two places, not three - no empty line between two of text.
    function cell(cls) {
      var c = { el: node('div', undefined, 'sv-cell ' + cls), head: node('div', undefined, 'sv-cell-head'), name: node('span', '', 'sv-cell-name'),
        chance: node('b', '', 'sv-cell-chance'), alpha: node('span', '', 'sv-cell-alpha'), tile: node('span', undefined, 'sv-circle'),
        tileHead: node('span', 'Circle', 'sv-circle-head'), tileVal: node('b', '', 'sv-circle-val'),
        arm: node('div', '', 'sv-row'), out: node('div', '', 'sv-row') };
      c.alpha.title = 'The shell’s alpha damage, HP';
      c.tile.appendChild(c.tileHead); c.tile.appendChild(c.tileVal); shown(c.tile, false); shown(c.alpha, false);
      c.head.appendChild(c.name); c.head.appendChild(c.chance); c.head.appendChild(c.alpha); c.head.appendChild(c.tile);
      [c.head, c.arm, c.out].forEach(function (x) { c.el.appendChild(x); });
      return c;
    }
    // a thing of a cell shown or not, its place kept
    function shown(el, on) { el.style.visibility = on ? '' : 'hidden'; }
    // the project's yellow warning triangle (Bullba Hits' #shot-disc-stale: viewer.css .disc-stale), its words in its title
    function warnMark(label) {
      var s = node('span', undefined, 'disc-stale sv-warn'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); s.title = label;
      s.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2 19 18H1Z"/><path class="mark" d="M10 7.5v5M10 15.2v.2"/></svg>';
      return s;
    }
    var figs = node('div', undefined, 'sv-figs'), cellA = cell('sv-hitline'), cellB = cell('sv-other'), unpin = node('button', '×', 'sv-unpin');
    again.type = leave.type = unpin.type = 'button';
    again.title = 'Replay episode\nPlays the shot again from ' + BEFORE + ' s before it and stops at the hit.\n• The camera stays as you left it; click the shot’s row for the shooter’s view again\n• Played on, the shot view closes ' + AFTER + ' s after the hit';
    leave.title = 'Leave the shot view\nBack to the battle view: the free camera and your speed.\n• Esc does the same';
    unpin.title = 'Unpin\nDrops the pinned point.';
    again.onclick = function () { episode(true); };
    leave.onclick = function () { close(); };
    unpin.onclick = function () { if (S.viewer) S.viewer.unpin(); };
    // 23.11 (NOTEBOOK Z4): no note line under the figures. What the view is - the eye, the heat map, the circles, the sight,
    // how to pin and turn - is the title's tooltip; progress and why there is no Bullba Hits view stand in the Hit line's
    // place (progress()); what is rebuilt rather than recorded is the ⚠ beside the title (reconShow).
    function say(text, tip) { S.said = text; title.title = tip || title.textContent + '\n' + text; reconShow(); }
    function progress(text, tip) { placeholder(cellA, 'Hit line', text, tip || HIT_TIP); fillCircle(cellA, null); }
    // 22.11 (NOTEBOOK Y17), 23.11 (Z1): one ⚠ beside the title, its words in its tooltip, shown only when THIS shot has
    // something rebuilt that nothing else on screen marks: the simulated framing, the artillery view, a straight line for
    // want of an arc or an arc moved off the drawn muzzle, the server circle taken from the server's gun update, the target's
    // turret and gun as this viewer cannot pose them, an assumed shell. Not listed (always so, or marked elsewhere): the arc
    // starting at the drawn muzzle, another vehicle's circle (dashed, its tile says "estimate").
    var reconWarn = warnMark('Reconstructed, not recorded');
    function reconItems() {
      var out = [];
      if (S.view && S.view.detail) out.push(S.view.detail);
      if (S.line && !S.line.stub && S.data) {
        if (!S.line.path) out.push('Trajectory: ' + (S.line.why && S.line.why.text ? S.line.why.text + ', ' : 'no usable recorded arc, ') + 'a straight line to the end point');
        else if (S.line.path.note) out.push('Trajectory: the recorded launch velocity and gravity, its end put on the hit point; ' + S.line.path.note);
      }
      if (S.reconFraming) out.push(S.reconFraming);
      if (S.serverFromGun) out.push('Server circle (dashed): taken from the server’s gun update - the game was not showing it then; its distance is the cursor point’s');
      if (S.data && !S.posed) out.push('Target: its turret and gun as the record has them - this viewer’s model of it differs');
      if (S.rec && S.rec.guess) out.push('Shell: assumed - the record does not name the shell this shot fired');
      return out;
    }
    function reconShow() {
      var items = S.row ? reconItems() : [];
      shown(reconWarn, items.length > 0);
      reconWarn.title = 'Reconstructed, not recorded\nParts of this shot’s view are rebuilt by Bullba Replays; the replay does not record them.\n• ' + items.join('\n• ');
    }
    cellB.head.appendChild(unpin); shown(unpin, false);
    figs.appendChild(cellA.el); figs.appendChild(cellB.el);
    // 21.11 (BACKLOG 119, 120, 122): the top line is one line whatever it holds (.sv-top: no wrap, the title cut first) -
    // the title, the unknown shooter's ⚠, the gun's shell chips with the estimate's ⚠, the aim option, Look back, Replay
    // episode, Leave. The two ⚠ keep their places when hidden, so nothing moves when one shows.
    var top = node('div', undefined, 'sv-top'), stubWarn = warnMark('Shooter’s place unknown'), shells = node('span', undefined, 'sv-shells');
    var shellWarn = warnMark('Estimate: another shell'), back = node('button', 'Look back', 'sv-back');
    back.type = 'button'; back.setAttribute('aria-pressed', 'false');
    back.title = 'Look back along the shot\nTurns the eye on the shot’s line to face where the shell came from: its source in the centre, the wheel forward flies to it.\n' +
      '• Click again: towards the target\n• From the free camera: back onto the shot’s line first\n• The aim circles and the sight are not drawn while looking back';
    back.onclick = function () { lookBack(); };
    shown(stubWarn, false); shown(shellWarn, false); shown(reconWarn, false);
    top.appendChild(title); top.appendChild(reconWarn); top.appendChild(stubWarn); top.appendChild(shells); top.appendChild(shellWarn);
    // U3: the option of the aim circle at the cursor (the page's control, remembered with its settings), in the bar
    var aimLabel = o.aimToggle ? o.aimToggle.closest('label') || o.aimToggle : null;
    if (aimLabel) { top.appendChild(aimLabel); aimLabel.hidden = false; }
    top.appendChild(back); top.appendChild(again); top.appendChild(leave);
    bar.appendChild(top); bar.appendChild(figs); bar.hidden = true;
    document.body.appendChild(bar);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.row) { close(); e.preventDefault(); } });
    // ---- Hits' viewer, hosted on this page's renderer and camera -------------------------------------------------------
    var paintRT = null;
    var paintMat = new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: PAINT_VERTEX, fragmentShader: PAINT_FRAGMENT, side: T.DoubleSide,
      uniforms: { uPaint: { value: null } }, transparent: true, premultipliedAlpha: true, depthTest: true, depthWrite: true,
      stencilWrite: true, stencilRef: 1, stencilFunc: T.NotEqualStencilFunc, stencilZPass: T.ReplaceStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });
    paintMat.forceSinglePass = true;   // one pass of both sides (three draws a transparent double side twice)
    paintMat.userData.shotPaint = true;
    var silMat = new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: PAINT_VERTEX, fragmentShader: SILHOUETTE_FRAGMENT, side: T.DoubleSide,
      uniforms: { uPaint: paintMat.uniforms.uPaint, uAlpha: { value: SILHOUETTE } }, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
      stencilWrite: true, stencilRef: 2, stencilFunc: T.EqualStencilFunc, stencilZPass: T.KeepStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });
    // ---- the HUD: the aim circles and the game's sight over the picture (hud()) -------------------------------------------
    var hudCanvas = node('canvas', undefined, 'sv-hud'), hud2d = hudCanvas.getContext('2d');
    hudCanvas.hidden = true; o.view.appendChild(hudCanvas);
    // One recorded-impact marker, made by Hits' own shape factory. This layer
    // exists even when the shot has no loaded Hits scene/viewer.
    var impactLayer = node('div', undefined, 'hit-reticle-layer'), impactMarker = root.ArmorViewer.reticleElement();
    impactLayer.appendChild(impactMarker); o.view.appendChild(impactLayer);
    root.BullbaSettings.impact.subscribe(function (v) {
      impactLayer.style.setProperty('--impact-opacity', String(v.opacity / 100)); impactLayer.style.setProperty('--impact-color', v.color);
      if (S.look) { S.look['impact-opacity'] = String(v.opacity); S.look['impact-color'] = v.color; }
      if (S.viewer) { S.viewer.setImpactOpacity(v.opacity / 100); S.viewer.setImpactColor(v.color); }
    });
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
        // A missing cursor sprite must not discard an available sniper gun tag.
        if (!sightImg.arcade.centre) sightWhy = 'its centre image is not in the file';
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
    var host = { renderer: o.renderer, camera: hostCamera, paintTarget: paintTarget, want: function () {},
      aimOrigin: function () { return S.alt && S.line && S.haveA ? (S.line.server || S.line.a).clone().applyMatrix4(AInv) : null; } };
    function viewer() {
      if (S.viewer) return S.viewer;
      S.viewer = new root.ArmorViewer(o.view, host);
      S.viewer.grid.visible = false;
      S.viewer.onPin = pinShown;
      S.viewer.onInspect = altReading;   // U3: the reading under the cursor (Hits' inspect, while the alternative is on)
      // U3 (1.19): the live circle is the figure's only; its ring is the HUD's, over everything, never hidden by the map
      S.viewer.liveRing().visible = false;
      return S.viewer;
    }
    // Hits' look (its setters, as Hits' page calls them from its controls), the Grid included (1.19)
    function applyLook(v) {
      var L = hitsLook(), game = !!(root.BullbaHost && root.BullbaHost.game);
      v.setLighting(!!L['soft-lighting']); v.setLightStrength(num(L['light-strength'], 200) / 100);
      // Hits' Grid as the user set it there (its brightness and opacity), drawn by overlay() with its own depth test
      v.setOutline(num(L['outline-brightness'], 15) / 100, num(L['outline-opacity'], 6) / 100); v.wireframe(!!L.wireframe);
      v.setTrackOpacity(num(L['track-opacity'], 20) / 100); v.setImpactOpacity(num(L['impact-opacity'], 100) / 100); v.setImpactColor(L['impact-color']);
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
      // Z6 (b): the aim circle on, a click places no second line - the ring follows the cursor with its live figures
      if (S.alt && S.alt.on) return;
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
    // one place of a cell: its chips on one line; what does not fit is cut, the whole line in the place's tooltip
    function chipsInto(box, groups) {
      box.replaceChildren();
      groups.forEach(function (g) { var c = node('span', g.text, 'chip ' + g.kind); if (g.title) c.title = g.title; box.appendChild(c); });
      box.title = groups.map(function (g) { return g.text; }).join(' · ');
    }
    // the line's groups into the cell's places by their kind (armor-line.js line: ricochet, pen, armor, damage, screen)
    var ARM = ['pen', 'armor', 'screen', 'track'], OUT = ['ricochet', 'damage'];
    function kinds(groups, list) { return groups.filter(function (g) { return list.indexOf(g.kind) >= 0; }); }
    // one cell: its heading, the line's label in its colour, the alpha muted, the chips in their places
    function fillCell(c, name, line, tip) {
      var shell = S.viewer && S.viewer.shell, alpha = shell && shell.alpha > 0 ? shell.alpha : 0, g = line.groups;
      c.name.textContent = name; c.el.title = tip || '';
      c.chance.textContent = line.label; c.chance.style.color = line.color;
      c.alpha.textContent = alpha ? '/ ' + Math.round(alpha) : ''; shown(c.alpha, !!alpha);
      var other = g.filter(function (x) { return ARM.indexOf(x.kind) < 0 && OUT.indexOf(x.kind) < 0; });
      chipsInto(c.arm, kinds(g, ARM).concat(other)); chipsInto(c.out, kinds(g, OUT));
    }
    function placeholder(c, name, text, tip) {
      c.name.textContent = name; c.el.title = tip || ''; c.chance.textContent = '—'; c.chance.style.color = ''; shown(c.alpha, false);
      chipsInto(c.arm, [{ kind: 'placeholder', text: text }]); chipsInto(c.out, []);
    }
    // the circle's tile: Hits' figure (armor-line.js circleText), its colour on the chance scale, Hits' words; `estimate`
    // heads it "Circle, estimate"; `more` the tooltip's own points
    function fillCircle(c, figure, kind, estimate, more) {
      var text = figure ? AL.circleText(figure) : '';
      shown(c.tile, !!text);
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
    var UNDER_TIP = 'Under the cursor\nBullba Hits’ reading of a shot from the shell’s start through the point under the cursor, with this shot’s shell.\n• The cyan ring follows the cursor; a click pins nothing while it is on';
    // the other cell is always there (its place kept): the pinned point, the point under the cursor, or how to get one
    function pinShown() {
      var v = S.viewer, on = !!(v && v.pinned);
      shown(unpin, on);
      if (S.alt && v) { v.spreadAim = on && v.pinned.point ? v.pinned.point.clone() : null; if (!on) { v.inspectKey = null; ptr.fresh = true; } }
      if (on) { fillCell(cellB, 'Pinned point', lineOf(v.pinResult), PIN_TIP); if (!S.alt) fillCircle(cellB, null); return; }
      if (S.alt && S.alt.on) { if (!S.alt.read) placeholder(cellB, 'Under the cursor', 'Hover over the armour', UNDER_TIP + S.alt.tip); return; }
      fillCircle(cellB, null);
      placeholder(cellB, 'Pinned point', S.mode === 'hits' ? 'Click the target to pin a point' : 'no Bullba Hits reading', PIN_TIP);
    }
    function altReading(r) {
      if (!S.alt || (S.viewer && S.viewer.pinned)) return;
      S.alt.read = true;
      fillCell(cellB, 'Under the cursor', lineOf(r), UNDER_TIP + S.alt.tip);
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
      if (o.cutaway) o.cutaway(null);
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
      if (S.line && S.line.stub) return { kind: 'stub', words: 'the view: on the line the shot came in along, ' + STUB_EYE + ' m out (where the shooter stood is not in the replay)' };
      var end = row.t; // only pre-shot coverage is required: later the camera travels along the shot
      if (o.recordedOk && o.recordedOk(row.shooter, S.start, end)) return { kind: 'camera', words: 'the view: the player’s own camera from the replay' };
      // an SPG with no recorded camera: the game's artillery trajectory view rebuilt (artyView)
      var arty = spgShooter(row) ? artyView(row) : null;
      if (arty) return arty;
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
    // whether the shooter is an SPG at the shot (its configuration then)
    function spgShooter(row) {
      var config = o.vehicleAt ? o.vehicleAt(row.shooter, row.t) : o.vehicle(row.shooter);
      return !!(config && config.md && config.md.cls === 'SPG');
    }
    // Settings' "camera at the shell's speed" (playback.html #sv-shell-clock, experimental; remembered with the page's
    // settings): the eye's pace along a recorded arc after the shot
    function shellClock() { var el = root.document && root.document.getElementById('sv-shell-clock'); return !!(el && el.checked); }
    function groundAt(x, z) { return o.ground ? o.ground(x, z) : null; }
    function arr(v) { return [v.x, v.y, v.z]; }
    // the recorded path's drawn point at u in the scene's axes
    function scenePt(path) { return function (u) { var p = path.point(u); return [p[0], p[1], -p[2]]; }; }
    // the target's hull, turret and gun boxes as drawn now (the SPG mark lands on them): {inv, min, max, top}; null: none
    function targetBoxes() {
      var r = S.target == null ? null : o.vehicle(S.target);
      if (!r || !r.visible) return null;
      var out = [];
      [r.group, r.turret, r.gun].forEach(function (g) {
        var m = g && bodyOf(g, r); if (!m) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        m.updateWorldMatrix(true, false);
        var bb = m.geometry.boundingBox;
        out.push({ inv: N.copy(m.matrixWorld).invert().elements.slice(), min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z],
          top: box.copy(bb).applyMatrix4(m.matrixWorld).max.y });
      });
      return out.length ? out : null;
    }
    // THE ARTILLERY TRAJECTORY VIEW (22.11): the game's ArtyCamera rebuilt for an SPG shot with no recorded camera - the
    // eye behind and above the aim point along the shell's fall (the arc's tangent at its end), pitch at least 10 deg,
    // the nearest distance in 25-95 m that frames the target (the player's scroll is not recorded), the normal field of
    // view (ArtyCamera keeps the arcade one). The aim point: the player's own 0x1a marker place at the shot; another
    // shooter's Bullba Hits estimate (its centre direction flown with the shot's speed and gravity to the target or the
    // ground; showHits makes the view again once it is there); else the arc's end. null: no tracer of the shot.
    function artyView(row) {
      var L = S.line, sh = row.shot && o.battle.shots ? o.battle.shots[row.shot.index] : null;
      if (!L || L.stub) return null;
      var pt = L.path ? scenePt(L.path) : null, fall = pt ? ARTY.tangentAt(pt, 1) : arr(L.dir), end = pt ? pt(1) : arr(L.b);
      var aim = end, from = 'the shell’s landing', me = o.vehicle(row.shooter);
      if (me && me.v && me.v.own) {
        if (sampleAt(row.t - (o.delay ? o.delay(row.shooter) : 0), AS)) { aim = [AS[5], AS[6], -AS[7]]; from = 'your recorded marker at the shot'; }
      } else {
        var E = S.estimate;
        if (E && !E.why && !E.sizeOnly && sh) {
          var speed = Math.hypot(sh[6], sh[7], sh[8]), n = arr(E.n);
          var p = ARTY.flyToGround(arr(E.o), [n[0] * speed, n[1] * speed, n[2] * speed], sh[9], groundAt, targetBoxes());
          if (p) { aim = p; from = 'Bullba Hits’ estimate of the aim'; }
        }
      }
      var points = o.targetBounds && S.target != null ? o.targetBounds(S.target, S.stop == null ? row.t : S.stop) : null;
      points = points && points.length ? points.map(arr) : [end];
      var F = ARTY.artyFrame(aim, fall, points, S.saved ? S.saved.fov : o.camera.fov, o.camera.aspect || 1, o.ground ? groundAt : null);
      return { kind: 'arty', eye: new T.Vector3().fromArray(F.eye), look: new T.Vector3().fromArray(F.look), frame: F,
        words: 'the view: the artillery view, rebuilt',
        detail: 'Artillery view: no recorded camera - behind the aim point along the shell’s fall, pitch ' +
          Math.round(F.pitch * 180 / Math.PI) + '°, ' + Math.round(F.dist) + ' m out (the player’s scroll distance is not recorded); aim: ' + from +
          (pt ? '' : '; no recorded arc: the straight line’s direction') };
    }
    // the target's focus in the scene now: Bullba Hits' orbit centre (S.focusGroup, in the target group's frame)
    function focusScene(out) {
      var r = S.target == null ? null : o.vehicle(S.target);
      if (!r || !r.visible) return null;
      if (!S.focusGroup) S.focusGroup = meshCentre(r);
      if (!S.focusGroup) return null;
      r.group.updateWorldMatrix(true, false);
      grounded(out.copy(S.focusGroup).applyMatrix4(r.group.matrixWorld), FOCUS_FLOOR);
      S.lastFocus = (S.lastFocus || new T.Vector3()).copy(out);
      return out;
    }
    // a point kept at least k m over the ground under it (o.ground: the page's drawn ground)
    function grounded(p, k) {
      var g = o.ground ? o.ground(p.x, p.z) : null;
      if (g != null && isFinite(g) && p.y < g + k) p.y = g + k;
      return p;
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
    // any length (1.20: a shot under 3.5 m had none, and the eye stayed off it): `dir` the way it looks - towards the end,
    // or with no length the shell's own direction at the shot (its velocity: the gun's), never a zero vector
    function shotLine(row) {
      var s = row.shot;
      if (!s || !s.start || !s.end) return null;
      var a = new T.Vector3(s.start[0], s.start[1], -s.start[2]), b = new T.Vector3(s.end[0], s.end[1], -s.end[2]), len = a.distanceTo(b);
      var sh = o.battle && o.battle.shots ? o.battle.shots[s.index] : null, dir = new T.Vector3();
      if (sh) dir.set(sh[6], sh[7], -sh[8]);
      if (len > LINE_MIN) dir.copy(b).sub(a);
      if (!(dir.lengthSq() > 1e-12)) dir.set(0, 0, -1);
      var path=o.trajectory?o.trajectory(s.index):null;
      var L={ a: a, server:a.clone(), b: b, len: len, t: row.t, dir: dir.normalize(), path:path,shotIndex:s.index };
      if(path){var p=path.point(0);L.a.set(p[0],p[1],-p[2]);L.len=path.length;var q=path.point(.99);L.dir.copy(b).sub(new T.Vector3(q[0],q[1],-q[2])).normalize();}
      return L;
    }
    // the point the eye on the line looks at: the hit, or one metre along the shell's direction for a line of no length
    var lineAt = new T.Vector3(), lineBack = new T.Vector3();
    function lineLook(L) { return L.len > LINE_MIN ? L.b : lineAt.copy(L.a).add(L.dir); }
    // the distance the shot's circles are drawn at along the line (no length: Hits' 100 m)
    function lineDepth() { var d=S.line?(S.line.server||S.line.a).distanceTo(S.line.b):0;return d>1?d:100; }
    // whether the eye is on the shell's line now (from the shot's clock on, in first person)
    function onLine() { return !!(S.line && S.fp && (S.line.stub || S.lookLine || S.t >= S.line.t)); }
    // T2 (BACKLOG 119): the stub of a shot whose shooter the replay does not place at the shot - no tracer, the shooter out
    // of sight then (o.seen) or not named: STUB m arriving at the hit's contact along its own direction (o.contact: the
    // page's placed hit point and the server segment's direction, at the hit's clock), the eye STUB_EYE m out. null: no stub.
    function unseen(row) { return !row.shot && !(row.shooter != null && o.seen && o.seen(row.shooter, row.t)); }
    function stubLine(row, b, dir) {
      if (!b || !dir || !(dir.lengthSq() > 1e-12)) return null;
      dir = dir.clone().normalize(); b = b.clone();
      return { a: b.clone().addScaledVector(dir, -STUB), b: b, len: STUB, t: row.t, dir: dir, stub: true };
    }
    function stubOf(row) {
      var h = shownHit(row);
      if (!h || !unseen(row) || !o.contact) return null;
      var c = o.contact(h.index, h.t);
      return c ? stubLine(row, c.point, c.dir) : null;
    }
    // the eye's start along the line: the shell's start, or STUB_EYE m short of the hit on a stub
    function lineStart() { return S.line && S.line.stub ? 1 - STUB_EYE / STUB : 0; }
    function syncTop() {
      var stub = !!(S.line && S.line.stub);
      shown(stubWarn, stub);
      if (stub) stubWarn.title = 'Shooter’s place unknown\nThe replay does not place ' + (S.row && S.row.shooter != null ? o.name(S.row.shooter) : 'the shooter') +
        ' at this shot: the line comes in along the hit’s own direction, and the eye stands ' + STUB_EYE + ' m out on it by convention.\n' +
        '• Known: the direction at the contact (the server’s hit segment)' + (S.row && S.row.shooter != null ? ', the shooter’s vehicle' : '') +
        '\n• Not known: where it fired from, and the range\n• The line drawn is ' + STUB + ' m long, a convention too';
      back.disabled = !S.line;
      back.setAttribute('aria-pressed', String(!!S.flip)); back.classList.toggle('on', !!S.flip);
    }
    // T3 (BACKLOG 120): Look back - the eye on the shot's line turned to face the shot's source along the line; again: back
    // towards the target. From the free camera (released): the eye goes back onto the line where it was on it, looking back.
    function lookBack() {
      if (!S.row || !S.line) return;
      if (!S.fp) { S.fp = true; S.lastPose = null; S.glide = null; S.flip = true; altStop(); pose.fov = S.saved ? S.saved.fov : o.camera.fov; }
      else S.flip = !S.flip;
      S.manualLine = true; S.lookLine = true; S.stopAt = null;
      syncTop();
    }
    // the wheel on the line: n clicks (> 0 away from the target), the page's own zoom steps on the distance to the hit
    function lineWheel(clicks) {
      if (S.flip) clicks = -clicks;   // T3 (BACKLOG 120): looking back, the wheel forward flies towards the shot's source
      var L = S.line, n = Math.min(3, Math.abs(clicks)), d = (1 - S.u) * L.len, near = Math.min(LINE_NEAR, L.len);
      if (!(L.len > LINE_MIN)) return;
      d = clicks > 0 ? d + Math.max(WHEEL_OUT * d, WHEEL_FLOOR) * n : d - Math.max(WHEEL_IN * d, WHEEL_FLOOR) * n;
      // Z7: past the muzzle straight back along the launch direction, up to backReach (S.backMax, prepareLens)
      d = Math.max(near, Math.min(L.stub ? L.len : S.backMax || L.len, d));
      S.u = 1 - d / L.len;
      S.endU = S.u; S.manualLine = true; S.stopAt = null;
    }
    // Fit uses the real perspective metric, tan(FOV/2), as the client's
    // setFovByMultiplier does. A zoom step scales that metric, not FOV degrees.
    function prepareLens() {
      if (S.zoomFov != null || !S.line) return;
      var L = S.line, normal = S.saved ? S.saved.fov : o.camera.fov, tangent = Math.tan(normal * Math.PI / 360);
      if(L.path){var entry=L.path.point(.99);L.dir.copy(L.b).sub(new T.Vector3(entry[0],entry[1],-entry[2])).normalize();}
      S.zoomFov = normal;
      var points = o.targetBounds && S.target != null ? o.targetBounds(S.target, S.stop == null ? S.row.t : S.stop) : null;
      var mat = new T.Matrix4().lookAt(L.a, lineLook(L), UP), inv = new T.Quaternion().setFromRotationMatrix(mat).invert();
      var need = LINE_NEAR, extent = 0, usable = .72, aspect = o.camera.aspect || 1;
      (points || []).forEach(function (p) {
        var local = p.clone().sub(L.b).applyQuaternion(inv), along = -local.z;
        need = Math.max(need, Math.abs(local.y) / (tangent * usable) - along, Math.abs(local.x) / (tangent * aspect * usable) - along, .5 - along);
        var from = p.clone().sub(L.a).applyQuaternion(inv), depth = -from.z;
        extent = depth > .5 ? Math.max(extent, Math.abs(from.y) / (depth * tangent), Math.abs(from.x) / (depth * tangent * aspect)) : Infinity;
      });
      S.endU = L.stub ? lineStart() : L.len > LINE_MIN ? 1 - Math.min(L.len, need) / L.len : 0;
      S.backMax = backReach(L.len, need);
      var me = o.vehicle(S.row.shooter), foreign = !(me && me.v && me.v.own);
      if (foreign && S.view && S.view.kind === 'gun' && points && extent > 0 && isFinite(extent)) {
        var steps = [2, 4, 8, 16, 25], zoom = 1;
        steps.forEach(function (z) { if (extent * z <= usable) zoom = z; });
        S.zoomFov = 2 * Math.atan(tangent / zoom) * 180 / Math.PI;
        S.reconFraming = zoom > 1 ? 'Framing: a simulated ' + zoom + '× sight zoom chosen by the viewer; the replay does not record this vehicle’s camera' : null;
        reconShow();
      }
    }
    // Travel starts at release. Only a too-short flight's camera presentation
    // continues on the wall clock after the episode stops; the battle stays at hit.
    function linePose(t) {
      var L = S.line;
      prepareLens();
      if (S.travelLast != null && t < S.travelLast - 1e-6) { S.stopAt = null; S.glide = null; S.shellPace = null; }
      S.travelLast = t;
      // 22.11: the eye's pace on a recorded arc - Settings' "camera at the shell's speed" (experimental, taken once a
      // release): on - the shell's own clock (its duration); off (default) - 1.28's eased glide, smoothstep over
      // max(0.6 s, the flight) along the arc's length; the straight fallback always the latter
      if (S.shellPace == null) S.shellPace = !!(L.path && shellClock());
      var flight = L.path?L.path.duration:Math.max(0, (S.stop == null ? L.t : S.stop) - L.t), duration = S.shellPace && flight > 1e-6 ? flight : Math.max(.6, flight);
      if (!L.stub && S.stop != null && t >= S.stop - 1e-6 && S.stopAt == null && !S.manualLine) S.stopAt = wallNow();
      var elapsed = Math.max(0, t - L.t);
      if (S.stopAt != null && S.stop != null && t >= S.stop - 1e-6) elapsed += Math.max(0, wallNow() - S.stopAt) / 1000;
      var f = L.stub || S.manualLine ? 1 : Math.max(0, Math.min(1, elapsed / duration)), smooth = f * f * (3 - 2 * f);
      var endU = S.endU == null ? 0 : S.endU;
      // 22.11 (outputs/arty-shot-view-2026-11-22.md §3): on a recorded arc the eye travels at the pace above (until endU,
      // the framing stop) and looks along the arc's tangent where it is, from the first frame to the end - no turn
      // mid-flight, no switch to the hit point at the end
      if (L.path) {
        var pt = scenePt(L.path), lf = S.manualLine ? null : S.shellPace ? ARTY.lineFrame(L.path, pt, f, endU) : ARTY.easedFrame(L.path, pt, smooth, endU, flight > 1e-6 ? Math.min(1, elapsed / flight) : 1);
        if (lf) S.u = lf.u;
        var uc = lf ? lf.uc : ARTY.arcU(L.path, S.u * L.len), e = lf ? lf.eye : pt(uc), fw = lf ? lf.fwd : ARTY.tangentAt(pt, uc);
        // Z7: behind the muzzle (the wheel back past it) - on the launch tangent's straight line backwards, looking along it
        if (!lf && S.u < 0) { var back = -S.u * L.len; e = [e[0] - fw[0] * back, e[1] - fw[1] * back, e[2] - fw[2] * back]; }
        lineEye.set(e[0], e[1], e[2]); L.dir.set(fw[0], fw[1], fw[2]); fpLook.copy(lineEye).add(L.dir);
      } else {
        if (!S.manualLine) S.u = L.stub ? lineStart() : endU * smooth;
        lineEye.copy(L.a).lerp(L.b, S.u);
      }
      // T3 (BACKLOG 120): looking back - exactly along the line, its reverse direction: the source in the centre
      lineM.lookAt(lineEye, S.flip ? lineBack.copy(lineEye).sub(L.dir) : L.path ? fpLook : lineLook(L), UP); lineQ.setFromRotationMatrix(lineM);
      if (!S.glide) {
        var p0 = L.a.clone(), q0 = lineQ.clone(), lens0 = S.zoomFov, V = S.view;
        if (V && V.kind === 'camera') {
          var recordedFov = o.recorded(S.row.shooter, L.t, p0, q0);
          if (recordedFov != null) lens0 = recordedFov;
        } else if (V && V.kind === 'gun' && o.gunAt(S.row.shooter, L.t, G)) {
          p0.copy(V.eye).applyMatrix4(G);
          var look0 = V.dir.clone().transformDirection(G).add(p0);
          q0.setFromRotationMatrix(new T.Matrix4().lookAt(p0, look0, UP));
        } else if (V && V.kind === 'arty') { p0.copy(V.eye); q0.setFromRotationMatrix(new T.Matrix4().lookAt(p0, V.look, UP)); }
        S.glide = { p: p0, q: q0, fov: lens0 };
      }
      // the stub (BACKLOG 119): the eye stands on it from the episode's start, no glide
      S.glided = f >= 1;
      // 22.11: a recorded arc cuts at release - the position onto the arc, the look along its tangent (a blend of the look
      // would turn the camera mid-flight: the user's fault on 1.28); only the straight fallback still glides
      if (f < 1 && !L.path) {
        fpPos.copy(lineEye);
        fpPos.addScaledVector(lineAt.copy(S.glide.p).sub(L.a), 1 - smooth);
        fpQ.copy(S.glide.q).slerp(lineQ, smooth);
      }
      else { fpPos.copy(lineEye); fpQ.copy(lineQ); }
      pose.position = fpPos; pose.quaternion = fpQ; pose.look = null;
      var fromFov = S.glide.fov, normal = S.saved ? S.saved.fov : o.camera.fov;
      pose.fov = 2 * Math.atan(Math.tan(fromFov * Math.PI / 360) * (1 - smooth) + Math.tan(normal * Math.PI / 360) * smooth) * 180 / Math.PI;
      return pose;
    }
    // this page's placeCamera asks: a first-person pose {position, quaternion | look, fov}, or {focus}, or null
    function camera(t) {
      if (!S.row) return null;
      var V = S.view;
      pose.focus = null;
      S.t = t;
      if (S.line && t < S.line.t && S.travelLast != null && !S.lookLine) { S.glide = null; S.shellPace = null; S.travelLast = null; S.stopAt = null; S.manualLine = false; }
      if (S.fp && S.line && (S.line.stub || S.lookLine || t >= S.line.t)) return linePose(t);
      if (S.fp && V && V.kind !== 'none') {
        var ok = false, fov = S.saved ? S.saved.fov : o.camera.fov;
        if (V.kind === 'camera') { var f = o.recorded(S.row.shooter, t, fpPos, fpQ); if (f != null) { ok = true; fov = f; } }
        else if (V.kind === 'gun') { if (o.gunAt(S.row.shooter, t, G)) { ok = true; fpPos.copy(V.eye).applyMatrix4(G); fpLook.copy(V.dir).transformDirection(G).add(fpPos); prepareLens(); fov = S.zoomFov; } }
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
      S.fp = false; S.lastPose = null; S.flip = false; syncTop();
      S.stopAt = null; S.manualLine = true;
      var c = o.camera, k = S.saved;
      if (k) { c.fov = k.fov; c.zoom = k.zoom; c.updateProjectionMatrix(); }
      c.updateMatrixWorld();
      // the target's focus; not drawn now: its last one, else the hit point (the line's end: Hits' hit point once read,
      // else the tracer's end), else 20 m along the view - never under the ground
      var eye = c.position.clone(), at = focusScene(new T.Vector3()) || (S.lastFocus ? S.lastFocus.clone() : null) ||
        (S.line ? S.line.b.clone() : null) || eye.clone().add(new T.Vector3(0, 0, -20).applyQuaternion(c.quaternion));
      o.orbit(eye, grounded(at, FOCUS_FLOOR));
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
      // the line first (a stub for a shot whose shooter the replay does not place: BACKLOG 119), the eye by it
      S.line = shotLine(row) || stubOf(row); S.flip = false; S.shellI = null; S.heatLine = -1;
      S.spg = spgShooter(row); S.markGun = null; S.shellPace = null;
      S.focusGroup = null; S.lastFocus = null; S.view = firstPerson(row); S.fp = true; S.lock = true; S.lastPose = null;
      S.u = lineStart(); S.glide = null; S.t = S.start; S.estimate = null; S.disc = undefined;
      S.series = null; S.reconFraming = null; S.serverFromGun = false; S.backMax = null; S.zoomFov = null; S.endU = null; S.manualLine = false; S.travelAt = null; S.travelLast = null;
      S.targetVariant=null;
      S.lookLine = false;
      S.stopAt = null; S.glided = false; S.lineEngine = null; S.lineJob = null; S.lineFig = null;
      pose.fov = S.saved ? S.saved.fov : o.camera.fov;
      title.textContent = 'Shot view · ' + o.name(row.shooter,row.t) + ' → ' + (S.target == null ? 'no hit in the replay' : o.name(S.target,S.hitT||row.t)) + ' · ' + o.clock(row.t);
      say(S.view.words.charAt(0).toUpperCase() + S.view.words.slice(1)); bar.hidden = false; shown(unpin, false); syncTop(); paintShells();
      placeholder(cellA, 'Hit line', 'preparing…', HIT_TIP); fillCircle(cellA, null); placeholder(cellB, 'Pinned point', 'preparing…', PIN_TIP); fillCircle(cellB, null);
      o.play(false); o.seek(S.start);
      var shooter = o.vehicle(row.shooter);
      if (o.aimInputs && !(shooter && shooter.v && shooter.v.own)) o.aimInputs().then(function (inputs) {
        if (tok !== S.token || !S.line || S.line.stub) return;
        var v = (o.battle.vehicles || []).filter(function (x) { return x.id === row.shooter; })[0];
        if (!v || v.own) return;
        // the shooter's configuration at the shot and its track then (battle.js: the one owner of a vehicle's lives)
        var config = root.PlaybackBattle.lifeAt(v, row.t);
        if (!config) return;
        var track = root.PlaybackBattle.trackOf(v, config, true), from = track.from, until = track.until;
        var shots = o.battle.shots.filter(function (x) {
          return x[1] === row.shooter && !x[2] && x[0] >= from - 1e-6 && x[0] < until - 1e-6;
        }).map(function (x) { return x[0]; });
        S.series = sizeSeries(track, inputs[config.compDescr], shots, row.t);
        if (!S.estimate || S.estimate.why) S.estimate = gunEstimate();
        reconShow();
      }).catch(function () {});
      // 22.11: another SPG shooter's aim - Bullba Hits' estimate (the mod's replay_aim_other.py, kept on the tracer in Hits'
      // battle file) read from the battle file at once, not after the hit's scene (its models): the artillery view and the
      // mark take it before the episode plays
      var meta0 = o.battle.meta || {};
      if (S.view && S.view.kind === 'arty' && !(shooter && shooter.v && shooter.v.own) && h && h.attacker != null && o.hitsBattle && Number.isFinite(meta0.serverStart)) {
        var idE = o.hitsBattle, readE = hitsBattles[idE] || (hitsBattles[idE] = Data.battle(idE).catch(function (e) { delete hitsBattles[idE]; throw e; }));
        readE.then(function (battle) {
          if (tok !== S.token || S.mode === 'hits') return;
          var hit = Data.hitAt(battle, meta0.serverStart + h.t, h.attacker, h.target, row.shot && row.shot.shotId);
          if (!hit) return;
          var e = estimateOf(root.BullbaShotShell.recorded(hit, battle).context);
          if (e && !e.why && !e.sizeOnly) { S.estimate = e; var av = artyView(row); if (av) { S.view = av; S.glide = null; } }
        }).catch(function () {});
      }
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
      var MAKING = 'Bullba Hits is making its battle\nThe mod builds the shell, the armour and every hit’s scene from this replay in the game.'; progress('Bullba Hits is making its battle from this replay…', MAKING);
      var began = Date.now();
      return new Promise(function (ok) {
        (function look() {
          if (tok !== S.token) return ok({ why: 'left' });
          Data.index().then(function (ix) {
            var row = ((ix && ix.battles) || []).filter(function (b) { return b && b.id === id; })[0];
            if (row && !row.stale) { o.hitsBattle = id; delete hitsBattles[id]; return ok(null); }
            if (Date.now() - began > MADE_MS) return ok({ why: 'Bullba Hits did not make its battle from this replay within ' + MADE_MS / 60000 + ' min' });
            progress('Bullba Hits is making its battle from this replay… ' + Math.round((Date.now() - began) / 1000) + ' s', MAKING);
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
        var at = meta.serverStart + h.t, hit = Data.hitAt(battle, at, h.attacker, h.target, row.shot&&row.shot.shotId);
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
      if (v.reticleLayer) v.reticleLayer.style.visibility = 'hidden';   // the host owns the single impact cross at its exact visible line endpoint
      S.mode = 'hits'; S.data = data; S.rec = rec; S.hits = got;
      S.posed = !!(r && sameModel(r, hit.target.parts || []));
      if (r && r.md && r.md.model) addExtras(r, data);
      // the orbit's centre: Hits' own (viewer.js pivotCentre), in the target group's frame (the viewer's frame is it with z
      // mirrored: A = the group's world x Z)
      var pc = v.pivotCentre(); S.focusGroup = new T.Vector3(pc.x, pc.y, -pc.z);
      // the target's pose at the hit (Hits' frame in the scene); the camera itself is the shooter's (camera())
      var Ae = Arec || (r && r.visible ? new T.Matrix4().multiplyMatrices(r.group.matrixWorld, Z) : null);
      // T1: the line's end at Hits' hit point (the tracer's end stands for it until now)
      if (S.line && Ae && v.point) {
        var hp = v.point.clone().applyMatrix4(Ae), len = S.line.a.distanceTo(hp);
        if (len > LINE_MIN) { S.line.b.copy(hp);S.line.why={};S.line.path=o.trajectory?o.trajectory(S.line.shotIndex,[hp.x,hp.y,-hp.z],S.line.why):null; S.line.len = S.line.path?S.line.path.length:len; S.line.dir.copy(hp).sub(S.line.a).normalize(); }
      }
      // T2 (BACKLOG 119): no stub from the page's own hit point (not placed there) - Hits' hit point and its shell's axis
      // (Hits' eye on it) give the direction instead
      if (!S.line && Ae && v.point && unseen(S.row)) {
        var hp2 = v.point.clone().applyMatrix4(Ae), e2 = v.orbitEye().applyMatrix4(Ae);
        S.line = stubLine(S.row, hp2, hp2.clone().sub(e2));
        if (S.line) { S.view = firstPerson(S.row); S.u = lineStart(); S.glide = null; syncTop(); }
      }
      // T3: another vehicle's circle while aiming - Hits' estimate of its shot (the tracer's replayAimEstimate)
      if (!own) S.estimate = estimateOf(rec.context);
      // 22.11: the artillery view again on Hits' hit point and, for another shooter, Hits' estimate of the aim (before
      // the episode plays; the still pre-shot picture may shift a little)
      if (S.view && S.view.kind === 'arty') { var av = artyView(S.row); if (av) { S.view = av; S.glide = null; } }
      S.aim = ready ? 'recorded' : estimate ? (estimate.rebuilt ? 'rebuilt' : 'nominal') : null;
      var c = rec.choice, lines = [];
      if (S.view) lines.push(S.view.words);
      aimWords(own).forEach(function (w) { lines.push(w); });
      S.heatLine = lines.length;
      lines.push(heatWords(rec.shell, c, rec.guess));
      lines.push(S.aim === 'recorded' ? 'Aim circles: the player’s own, recorded' : S.aim === 'rebuilt' ? 'Aim circle: estimate rebuilt from the replay (dashed), not a recorded one' :
        S.aim === 'nominal' ? 'Aim circle: nominal estimate (dashed) - the gun’s dispersion x range, no crew or equipment; the replay has no reticle of this shooter' :
          'No aim circle: ' + (!(hit.attacker && hit.attacker.gunDispersion > 0) ? 'no gun dispersion in the record' : 'no range for this hit'));
      S.lines = lines; sayHits();
      S.shellI = rec.context.index >= 0 ? rec.context.index : rec.choice ? rec.context.choices.indexOf(rec.choice) : -1;
      paintShells();
      pinShown();
    }
    function sayHits() {
      var lines = S.lines || [];
      say(lines.join(' · '), 'Bullba Hits’ view of this hit\nThe target painted by Bullba Hits from the scene rebuilt from the replay, for the camera’s eye.\n• ' + lines.join('\n• ') +
        '\n• Click on the target: pin a line through that point (Bullba Hits’ reading below)\n• Drag turns the camera round the target, the wheel moves it closer or farther (this ends the shooter’s view)\n• The hit’s crosses are marks over the picture: the ground does not hide them, the line it does');
    }
    function heatWords(shell, c, guess) {
      return shell ? 'Heat map: ' + (c && c.name ? c.name + ', ' : '') + Math.round(shell.penetration) + ' mm at ' + Math.round(S.rec.range) + ' m - nominal, not the rolled value' +
        (guess ? ' (assumed: the record does not name this shot’s shell)' : '') : 'No heat map: the record holds no shell for this shot';
    }
    // ---- THE SHELL SWITCH (21.11, BACKLOG 122): Bullba Hits' shell chips of the shooter's gun (web/shot-shell.js chip, the
    // same widget as Hits' scene heading); a chip re-reads everything for that shell by Hits' own path - the shell at the
    // record's range (BullbaShotShell.shellAt, as Hits' updateShell and recorded() make it), viewer.configure (the heat map),
    // the hit line and its circle (hitLine), the other cell (pinShown, the alternative's figure). A shell this shot did not
    // fire: an estimate, said by the ⚠ after the chips only. A new row starts again from the shot's own shell.
    function paintShells() {
      shells.replaceChildren();
      var rec = S.rec, ctx = rec && rec.context, list = (ctx && ctx.choices) || [];
      if (S.mode !== 'hits' || !rec || !rec.shell || list.length < 2) { shown(shellWarn, false); return; }
      var assumedI = ctx.index < 0 && rec.choice ? list.indexOf(rec.choice) : -1, hit = S.data && S.data.hit;
      list.forEach(function (c, i) {
        var b = root.BullbaShotShell.chip(c, { actual: i === ctx.index, assumed: i === assumedI, second: c.vehicleMode === 1,
          mode: root.ArmorShotContext && root.ArmorShotContext.modeLabel && hit ? root.ArmorShotContext.modeLabel(hit, c) : '', gunNotes: ctx.gunNotes },
          function () { pickShell(i); });
        b.type = 'button'; b.setAttribute('aria-pressed', String(i === S.shellI));
        shells.appendChild(b);
      });
      var other = S.shellI !== ctx.index && S.shellI >= 0, c = list[S.shellI];
      shown(shellWarn, other);
      if (other) shellWarn.title = 'Estimate: another shell\nThe heat map and the figures are for the ' + (c ? c.name : 'chosen shell') +
        (ctx.index >= 0 ? ', which this shot did not fire.' : '; the record does not name the shell this shot fired.') +
        '\n• Nominal penetration at the recorded range, not the rolled value\n• The server’s outcome of this hit is the fired shell’s';
    }
    function pickShell(i) {
      var rec = S.rec, v = S.viewer, list = rec && rec.context ? rec.context.choices : [], c = list[i], hit = S.data && S.data.hit;
      if (i === S.shellI || !c || !v || S.mode !== 'hits' || !hit) return;
      var shell = root.BullbaShotShell.shellAt(c, c.kind, c.penetration100, c.caliber, rec.range, hit, undefined, undefined, root.BullbaShotShell.linerFactor(hit));
      if (!shell) return;
      S.shellI = i;
      var look = S.look || hitsLook(), mode = look['armor-mode'];
      v.configure(shell, mode !== 'parts', look.palette, mode);
      if (S.lines && S.heatLine >= 0) { S.lines[S.heatLine] = heatWords(shell, c, false); sayHits(); }
      hitLine();
      if (S.alt) { S.alt.job = null; S.alt.fig = null; S.alt.fine = false; ptr.fresh = true; }
      pinShown();
      paintShells();
    }
    function showReplay(why) {
      S.mode = 'replay'; S.note = why;
      var words = S.view ? S.view.words : '';
      var me = S.row ? o.vehicle(S.row.shooter) : null;
      words = [words].concat(aimWords(!!(me && me.v && me.v.own))).join(' · ');
      say('No Bullba Hits view: ' + why + '. · ' + words, 'Why there is no heat map here\n' + why + '.\n• ' + words + '\n• Drag turns the camera round the target, the wheel moves it closer or farther (this ends the shooter’s view)');
      placeholder(cellA, 'Hit line', 'No Bullba Hits view: ' + why, 'No Bullba Hits view\n' + why + '.'); fillCircle(cellA, null); pinShown(); paintShells();
    }
    // ---- the HUD (T3, T4) ---------------------------------------------------------------------------------------------
    // another vehicle's estimated circle (viewer.js setRebuiltEstimate reads the same block): its axis and size at the
    // shot; in the gun's view the axis is carried in the gun's frame of the shot, so it moves with the gun as drawn
    function estimateOf(context) {
      var tr = context && context.tracer, b = tr && !tr.own && tr.replayAimEstimate, c = b && b.circle;
      if (!c || !Array.isArray(c.vector) || !(c.dispersionAngle > 0) || !Array.isArray(tr.origin)) return gunEstimate() || { why: b && (b.reason || b.reasonKey) || 'Bullba Hits has no estimate of this shot' };
      var e = { o: new T.Vector3(tr.origin[0], tr.origin[1], -tr.origin[2]), n: new T.Vector3(c.vector[0], c.vector[1], -c.vector[2]).normalize(), angle: c.dispersionAngle,
        D: lineDepth(), nG: null, oG: null };
      var M2 = new T.Matrix4();
      if (S.view && S.view.kind === 'gun' && o.gunAt(S.row.shooter, S.row.t, M2)) { M2.invert(); e.nG = e.n.clone().transformDirection(M2); e.oG = e.o.clone().applyMatrix4(M2); }
      return e;
    }
    function gunEstimate() {
      if (!S.series || !S.line || S.line.stub) return null;
      var e = { o: (S.line.server||S.line.a).clone(), n: S.line.dir.clone(), angle: S.series.release, D: lineDepth(), sizeOnly: true, nG: null, oG: null };
      if (S.view && S.view.kind === 'gun' && o.gunAt(S.row.shooter, S.row.t, G)) {
        e.n.set(0, 0, 1).transformDirection(G);
        GI.copy(G).invert(); e.nG = e.n.clone().transformDirection(GI); e.oG = e.o.clone().applyMatrix4(GI);
      }
      return e;
    }
    // the bar's words for the circles while aiming (what each circle is, plainly)
    function aimWords(own) {
      var out = [], B = o.battle;
      if (S.spg && S.line && !S.line.stub && S.row && S.row.shot) {
        out.push('Artillery mark: the aim circle square to the shell’s fall (' + (own ? 'the recorded dispersion' : S.estimate && !S.estimate.why ? 'Bullba Hits’ estimated dispersion, dashed' : 'no dispersion known: not drawn') +
          ') laid along the fall onto the target or the ground - other vehicles and buildings are not tested');
        return out;
      }
      if (own) {
        if (!(B && B.na > 0)) out.push('No aim circles while aiming: this battle file holds no reticle of the player');
        else {
          // which reticle fields 3-10 hold at the shot (the 0x1a tick of the tracer's clock as drawn)
          // which reticle fields 3-10 hold at the shot; without the server's there, the server circle from 0x39 (Z5)
          var tt = (S.line ? S.line.t : S.row.t) - (o.delay ? o.delay(S.row.shooter) : 0), got = sampleAt(tt, AS), server = got ? AS[12] === 1 : true;
          S.serverFromGun = !!(got && !server && serverRing(B.server, B.ns, tt, [AS[1], AS[2], AS[3]], AIM_GAP));
          if (server) out.push('While aiming: the client circle (solid; size recorded, centre at the cursor point) and the server circle (dashed, recorded)');
          else out.push('While aiming: the client circle (solid, the reticle the replay holds) and ' + (S.serverFromGun ? 'the server circle (dashed, from the server’s gun update)' : 'no server circle (no server gun update at this shot)'));
          if (S.line) out.push('the circle of the shot’s moment (thick, dashed): appears at the shot - the server update the shell left from - and takes the server circle’s place');
        }
      } else if (S.estimate && !S.estimate.why) out.push('Dashed circle: estimated dispersion, not recorded aim or mouse position; ' + (S.series ? 'size reconstructed over time' : 'release size only: no time series available') + (S.estimate.sizeOnly ? '; centre follows the drawn gun (no Hits direction estimate)' : '; Hits release estimate carried with the gun'));
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
    var circlePoint = new T.Vector3(), circleRight = new T.Vector3(), circleUp = new T.Vector3(), circleAxis = new T.Vector3();
    function worldRing(center, right, up, radius, colour, dash) {
      if (!(radius > 0)) return;
      var g = hud2d, connected = false;
      g.globalAlpha = .9; g.strokeStyle = colour; g.lineWidth = 1.5 * DPR; g.setLineDash(dash); g.beginPath();
      for (var i = 0; i <= 64; i++) {
        var a = i * Math.PI / 32;
        circlePoint.copy(center).addScaledVector(right, Math.cos(a) * radius).addScaledVector(up, Math.sin(a) * radius);
        if (!toScreen(circlePoint)) { connected = false; continue; }
        if (connected) g.lineTo(scr.x, scr.y); else g.moveTo(scr.x, scr.y);
        connected = true;
      }
      g.stroke();
    }
    function mark(x, y, im, which) {
      var g = hud2d;
      g.globalAlpha = 1; g.setLineDash(DASH_NONE);
      // Every gun tag uses the same stock sniper chevron; the independent
      // cursor/centre below still follows its existing arcade/sniper selection.
      if (which === 'tag') {
        var tag = sightImg.sniper && sightImg.sniper.tag;
        if (tag) { g.drawImage(tag.c, x + tag.x * DPR, y + tag.y * DPR, tag.w * DPR, tag.h * DPR); return; }
        g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(x - 6 * DPR, y + 4 * DPR); g.lineTo(x, y - 4 * DPR); g.lineTo(x + 6 * DPR, y + 4 * DPR);
        g.strokeStyle = '#202020'; g.lineWidth = 3 * DPR; g.stroke();
        g.strokeStyle = '#a0a0a0'; g.lineWidth = DPR; g.stroke(); g.restore(); return;
      }
      if (im && im[which]) { var m = im[which]; g.drawImage(m.c, x + m.x * DPR, y + m.y * DPR, m.w * DPR, m.h * DPR); return; }
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
    // THE SPG MARK (22.11; the user: the aim circle itself, as the trajectory view - looking along the fall - shows it): the
    // dispersion circle (radius = the angle x the distance from the gun to the aim point, the circles' size rule) square to
    // the shell's fall at the aim point, each point carried along the fall onto the target's boxes as drawn now or the
    // ground (o.ground; other vehicles and buildings are not tested), one closed line. The aim point: own - the 0x1a
    // marker place at the clock, else the axis flown; another - its axis flown with the shot's speed and gravity. The fall:
    // the axis's flight at the aim point. Before the shot: own - the 0x39 update at the clock (gun, shot vector,
    // dispersion), another - the gun as drawn with Hits' estimated angle (its size series); from the shot: own - the
    // recorded launch velocity with the release disc, another - Hits' estimate (its centre direction) or the velocity.
    var MG = new T.Matrix4(), MGI = new T.Matrix4();
    function serverAt(tt) {
      var B = o.battle, Sv = B && B.server, n = (B && B.ns) || 0, lo = 0, hi = n - 1, k = -1;
      if (!Sv || n < 1) return -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (Sv[mid * 8] <= tt) { k = mid; lo = mid + 1; } else hi = mid - 1; }
      return k >= 0 && tt - Sv[k * 8] <= AIM_GAP ? k : -1;
    }
    function spgMarkDraw(own, flying) {
      var s = S.row.shot, sh = o.battle.shots ? o.battle.shots[s.index] : null;
      if (!sh || !o.ground) return;
      var speed = Math.hypot(sh[6], sh[7], sh[8]), start = [s.start[0], s.start[1], -s.start[2]], origin = null, axis = null, angle = null, dash = DASH_NONE;
      var E = S.estimate && !S.estimate.why ? S.estimate : null;
      if (flying) {
        origin = start; axis = [sh[6], sh[7], -sh[8]];
        if (own) { var D = discOf(); angle = D ? D.angle : null; }
        else if (E) { angle = E.angle; dash = DASH_ESTIMATE; if (!E.sizeOnly) { origin = arr(E.o); axis = arr(E.n); } }
      } else if (own) {
        var k = serverAt(Math.min(S.t, S.row.t)), Sv = o.battle.server, q = k * 8;
        if (k >= 0) { origin = [Sv[q + 1], Sv[q + 2], -Sv[q + 3]]; axis = [Sv[q + 4], Sv[q + 5], -Sv[q + 6]]; angle = Sv[q + 7]; }
      } else if (E && o.gunAt && o.gunAt(S.row.shooter, S.t, MG)) {
        if (!S.markGun && o.gunAt(S.row.shooter, S.row.t, MGI)) S.markGun = new T.Vector3().fromArray(start).applyMatrix4(MGI.invert());
        var o3 = S.markGun ? S.markGun.clone().applyMatrix4(MG) : new T.Vector3().fromArray(start), ax = new T.Vector3(0, 0, 1).transformDirection(MG);
        var dynamic = S.series ? S.series.at(S.t) : null;
        if (!S.series || dynamic != null) {
          origin = arr(o3); axis = arr(ax); angle = E.angle;
          if (dynamic != null && S.series.release > 0) angle *= dynamic / S.series.release;
        }
        dash = DASH_ESTIMATE;
      }
      if (!origin || !(angle > 0) || !(speed > 0)) return;
      var boxes = targetBoxes(), n = vnorm(axis), vel = [n[0] * speed, n[1] * speed, n[2] * speed], centre = null;
      if (own && sampleAt(shotClock(), AS)) centre = [AS[5], AS[6], -AS[7]];
      if (!centre) centre = ARTY.flyToGround(origin, vel, sh[9], groundAt, boxes);
      if (!centre) return;
      var radius = angle * Math.hypot(centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]);
      var pts = ARTY.fallMark(centre, ARTY.fallAt(origin, vel, sh[9], centre), radius, groundAt, boxes), g = hud2d, prev = false;
      g.globalAlpha = .9; g.strokeStyle = AIM_COLOUR; g.lineWidth = 1.5 * DPR; g.setLineDash(dash); g.beginPath();
      for (var i = 0; i <= pts.length; i++) {
        var p = pts[i % pts.length];
        if (!p || !toScreen(Q3.set(p[0], p[1], p[2]))) { prev = false; continue; }
        if (prev) g.lineTo(scr.x, scr.y); else g.moveTo(scr.x, scr.y);
        prev = true;
      }
      g.stroke();
      S.markPts = pts;
    }
    // every frame after this page's render (overlay): the circles and the sight while the eye is the shooter's
    function hud() {
      // not on the stub (no shooter's eye) nor looking back (T3: the circles would stand behind the eye)
      var on = !!(S.row && S.fp && S.view && S.view.kind !== 'none' && S.view.kind !== 'stub' && !S.flip);
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
      // 22.11: an SPG's mark as the game builds it (spgMarkDraw), not the direct-fire circles and sight
      if (S.spg && S.line && !S.line.stub && S.row.shot) { if (!hitsRings) spgMarkDraw(own, flying); }
      else if (own && sampleAt(shotClock(), AS)) {
        var server = AS[12] === 1;
        // the client circle: the cursor point (0-2) with the arcade diameter (11) - or, with no server reticle recorded, the
        // reticle the replay holds (fields 3-10)
        if (server) Q3.set(AS[1], AS[2], -AS[3]); else Q3.set(AS[5], AS[6], -AS[7]);
        if (toScreen(Q3)) {
          tx = scr.x; ty = scr.y; tag = true;
          if (!hitsRings) ring(scr.x, scr.y, (server ? AS[11] : AS[4]) / 2 * focal / scr.d, AIM_COLOUR, 1.5, 0.9, DASH_NONE);
        }
        // Z13 (23.11): from the shot the thick disc is this shot's server circle - the live server circle (recorded or from
        // 0x39) is not drawn beside it; the client circle stays live (it blooms as in the game, T3)
        if (server && !hitsRings && !flying) { Q3.set(AS[5], AS[6], -AS[7]); if (toScreen(Q3)) ring(scr.x, scr.y, AS[4] / 2 * focal / scr.d, AIM_COLOUR, 1.5, 0.9, DASH_SERVER); }
        // Z5: fields 3-10 not the server's - the server circle from its gun update at the same clock (serverRing)
        var SR = !server && !hitsRings && !flying ? serverRing(o.battle.server, o.battle.ns, shotClock(), [AS[1], AS[2], AS[3]], AIM_GAP) : null;
        if (SR) { Q3.set(SR.centre[0], SR.centre[1], -SR.centre[2]); if (toScreen(Q3)) ring(scr.x, scr.y, SR.radius * focal / scr.d, AIM_COLOUR, 1.5, 0.9, DASH_SERVER); }
        // the centre mark at the cursor point, where the game drew it
        Q3.set(AS[1], AS[2], -AS[3]);
        if (toScreen(Q3)) { cx = scr.x; cy = scr.y; }
        // from the shot: the circle the shell left from
        var D = flying && !hitsRings ? discOf() : null;
        if (D) {
          Q3.copy(D.n).multiplyScalar(lineDepth()).add(D.g);
          var v = S.viewer, look = v && v.ringLook;
          if (toScreen(Q3)) ring(scr.x, scr.y, Math.tan(D.angle) * focal, look ? discColour(look.color) : AIM_COLOUR, look && look.width > 0 ? look.width : 4,
            Math.max(0.4, v && v.discOpacity > 0 ? v.discOpacity : 0), DASH_DISC);
        }
      } else if (!own && S.estimate && !S.estimate.why) {
        var E = S.estimate;
        if (!flying && E.nG && S.view.kind === 'gun') { Q3.copy(E.nG).transformDirection(G); R3.copy(E.oG).applyMatrix4(G); Q3.multiplyScalar(E.D).add(R3); }
        else Q3.copy(E.n).multiplyScalar(E.D).add(E.o);
        if (toScreen(Q3)) {
          tx = scr.x; ty = scr.y; tag = true;
          var a = E.angle, dynamic = !flying && S.series ? S.series.at(S.t) : null;
          if (dynamic != null && S.series.release > 0) a *= dynamic / S.series.release;
          // A gap is not a frozen reconstruction; only a release estimate may remain.
          if (!hitsRings && (flying || !S.series || dynamic != null)) {
            circleAxis.copy(!flying && E.nG ? E.nG : E.n);
            if (!flying && E.nG) circleAxis.transformDirection(G);
            circleRight.crossVectors(circleAxis, UP); if (circleRight.lengthSq() < 1e-9) circleRight.set(1, 0, 0); else circleRight.normalize();
            circleUp.crossVectors(circleRight, circleAxis).normalize();
            worldRing(Q3, circleRight, circleUp, a * E.D, AIM_COLOUR, DASH_ESTIMATE);
          }
        }
      }
      // U3: the alternative's ring at its centre (the cursor's point; the viewer's frame: A puts it into the scene), its
      // constant angle. 23.11 (NOTEBOOK Z6): no centre mark and no gun tag there - the cursor (a crosshair) is its centre -
      // and the shot's own marks give way to it
      var X = S.alt, vw = S.viewer, alt = !!(X && X.on);
      if (alt && vw && S.haveA && vw.liveAim) {
        Q3.copy(vw.liveAim.center).applyMatrix4(A);
        if (toScreen(Q3)) {
          circleRight.copy(vw.liveAim.right).transformDirection(A); circleUp.copy(vw.liveAim.up).transformDirection(A);
          worldRing(Q3, circleRight, circleUp, vw.liveAim.radius, ALT_COLOUR, DASH_NONE);
        }
      }
      if (own && !S.spg && !alt) mark(cx, cy, im, 'centre');
      if (tag && !alt) mark(tx, ty, im, 'tag');
      hud2d.globalAlpha = 1;
    }
    // ---- WHERE ELSE COULD THE SHOT GO (U3; a plain screen tool since 1.19) ----------------------------------------------
    function aimOn() { return !!(o.aimToggle && o.aimToggle.checked); }
    // The option on, stopped at the hit and camera travel complete, Hits' scene and shell there.
    function altOk() {
      var v = S.viewer;
      return !!(aimOn() && S.row && S.mode === 'hits' && v && v.engine && v.shell && S.haveA && S.fp && S.line && !S.line.stub && !S.flip && onLine() && S.glided &&
        !S.armed && S.stop != null && Math.abs(S.t - S.stop) < 1e-6);
    }
    // the ring's size: the shot's own circle at the shot (the recorded ring, else Hits' estimate), as an angle - radius100,
    // the radius at 100 m - kept as it is; the circle stands at the cursor at once (no chase: Hits' emulation stays off)
    function altStart() {
      var v = S.viewer, ring = v.savedAim || v.estimateAim;
      var X = S.alt = { read: false, job: null, fig: null, fine: false, estAt: 0, cursor: canvas.style.cursor, why: '', tip: '', on: false, r100: 0 };
      v.inspectKey = null; ptr.fresh = true;
      var range = ring && ring.origin && ring.center ? ring.origin.distanceTo(ring.center) : 0;
      if (!(ring && ring.radius > 0 && range > 0)) { X.why = 'Bullba Hits has no circle of this shot to take its size from'; X.tip = '\n• No circle here: ' + X.why; pinShown(); return; }
      var est = !!v.estimateAim && !v.savedAim;
      X.r100 = Math.min(50, ring.radius / range * 100); X.on = true; X.kind = est ? 'estimate' : 'live';
      X.tip = '\n• The cyan ring: as wide as this shot’s own circle at the shot (' + (est ? 'Bullba Hits’ estimate' : 'recorded') + '), kept so' +
        '\n• A screen tool: no turret turn, gun limits or movement; rays still leave the shot’s real origin, wherever the camera stands';
      canvas.style.cursor = 'crosshair';   // Z6: the cursor is the ring's centre (no sight drawn there)
      v.setAimOffset(null);
      v.aimCursorPoint = ring.center.clone(); v.liveAimPoint = ring.center.clone(); v.aimYaw = 0;
      v.spreadAim = v.pinned && v.pinned.point ? v.pinned.point.clone() : null;
      v.setLiveAim(X.r100);
      pinShown();
    }
    function altStop() {
      var X = S.alt, v = S.viewer;
      if (!X) return;
      S.alt = null;
      canvas.style.cursor = X.cursor;
      if (v) { v.spreadAim = null; v.clearLiveAim(); }
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
    function altCircle() { var X = S.alt; if (X && X.on) fillCircle(cellB, X.fig, X.kind, X.kind === 'estimate', X.tip); }
    // one frame of it, after Hits' frame (the viewer's camera is this one's): the reading under the cursor (it moves the
    // live circle to the cursor's point too), the figure - coarse while the cursor moves, fine once it rests
    function alt(now) {
      if (!altOk()) { if (S.alt) altStop(); return; }
      if (!S.alt) altStart();
      var X = S.alt, v = S.viewer, moved = false;
      if (ptr.fresh && isFinite(ptr.clientX)) { ptr.fresh = false; v.resize(); v.inspect(ptr); moved = true; }
      if (!X.on) return;
      if (moved) altEstimate(false, now);
      else if (!X.fine) altEstimate(true, now);
    }
    // ---- the episode ----------------------------------------------------------------------------------------------------
    // keep (the Replay episode button, the user 20.11): the camera is left as the user put it - a free camera stays free where
    // it stands, a first-person one keeps its place along the shell's line; only opening a row puts the default view back
    function episode(keep) {
      if (!S.row) return;
      altStop(); S.stopAt = null; S.glided = false;
      if (keep && S.fp && S.line && S.t >= S.line.t && S.manualLine) S.endU = Math.max(0, S.u);   // the flight ends on the line, not behind the gun
      S.manualLine = false; S.travelLast = null;
      if (keep && S.lookLine) S.manualLine = true;
      o.seek(S.start); S.armed = true;
      if (!keep) { S.fp = true; S.lock = true; S.lastPose = null; S.u = lineStart(); S.flip = false; S.lookLine = false; syncTop(); }
      if (S.viewer && S.mode === 'hits') { S.viewer.holdShot(true); S.held = true; }
      S.glide = null;
      o.speed(SPEED); o.play(true);
    }
    // the replay's clock moved from t0 to t1 in a frame: the episode stops at the hit; played on past it, the mode leaves
    // by itself AFTER s later (its exit: the heat map off, the user's speed and lens back)
    function clamp(t0, t1) {
      if (!S.row || S.stop == null) return t1;
      if (S.armed && t1 >= S.stop && t0 <= S.stop) {
        S.armed = false; o.play(false);
        S.stopAt = wallNow();
        return S.stop;
      }
      if (!S.armed && t1 >= S.stop + AFTER) close(false);
      return t1;
    }
    // ---- this page's frame: paint before its render, overlay after it --------------------------------------------------
    var cutBox = new T.Box3(), cutSphere = new T.Sphere();
    function paint(time, now) {
      if (!S.row) return;
      var sh = o.vehicle(S.row.shooter), inside = !!(sh && sh.visible && eyeInside(sh));
      if (sh && (inside || S.veiled)) o.veil(sh, inside);
      S.veiled = inside;
      var v = S.viewer, r = S.target == null ? null : o.vehicle(S.target);
      // Y14 (22.11): map objects between the eye and the target drawn see-through (playback.js shotCutaway), each frame
      // on the target's bounding sphere as drawn now; none without a drawn target
      if (o.cutaway) {
        if (r && r.visible) { r.group.updateWorldMatrix(true, true); cutBox.setFromObject(r.group); }
        if (r && r.visible && !cutBox.isEmpty()) { cutBox.getBoundingSphere(cutSphere); o.cutaway(cutSphere.center, cutSphere.radius); }
        else o.cutaway(null);
      }
      if (S.mode !== 'hits' || !v || !r) return;
      if (S.hitT != null) { var held = time < S.stop - 1e-6; if (held !== S.held) { S.held = held; v.holdShot(held); } }
      if (!r.visible) return;
      if(S.targetVariant!==r.life){
        dropExtras();S.focusGroup=null;S.targetVariant=r.life;S.posed=sameModel(r,S.data.hit.target.parts||[]);
        if(r.md&&r.md.model)addExtras(r,S.data);
      }
      if(r.parts&&r.parts.length>1&&!S.posed){o.look(r,null);S.extras.forEach(function(x){x.visible=false;});return;}
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
    var overlayMats = [], gridShown = [], silHidden = [], silSwapped = [];
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
    // ---- THE SHOT'S FLIGHT (1.21): the line's start to its end, dashed as Hits' arc (viewer.js drawTracers: TRACER colour,
    // its dash scale, over everything); in this page's scene coordinates, drawn after its render ------------------------------
    var FLIGHT_COLOUR = 0xa8dfff, flightScene = new T.Scene(), flightPos = new Float32Array(97*3);
    var flightGeo = new T.BufferGeometry(); flightGeo.setAttribute('position', new T.BufferAttribute(flightPos, 3));
    flightGeo.setAttribute('lineDistance', new T.BufferAttribute(new Float32Array(97), 1));
    var flightMat = new T.LineDashedMaterial({ color: FLIGHT_COLOUR, dashSize: 1, gapSize: 0.6, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    var flight = new T.Line(flightGeo, flightMat); flight.frustumCulled = false; flightScene.add(flight);
    // Z18: the shell at the line's growing end - a small bright glowing dot (a tracer round glows), the replay's flash and
    // spark glow (playback.js glowMaterial, o.glow) over everything as the line is: DOT_K x the calibre across in the world,
    // DOT_MIN..DOT_MAX px on screen (the muzzle flash is 2.2 m); not drawn within DOT_NEAR m of the eye (the eye riding the
    // shell would put it over the whole view) nor from the shell's arrival on (the contact)
    var DOT_K = 2, DOT_MIN = 4, DOT_MAX = 14, DOT_NEAR = 3, DOT_RGB = [0.66, 0.87, 1];
    var dotGeo = new T.BufferGeometry(), dot = null;
    dotGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(3), 3));
    dotGeo.setAttribute('fxc', new T.BufferAttribute(new Float32Array([DOT_RGB[0], DOT_RGB[1], DOT_RGB[2], 1]), 4));
    dotGeo.setAttribute('fxs', new T.BufferAttribute(new Float32Array(1), 1));
    if (o.glow) { dot = new T.Points(dotGeo, o.glow(DOT_MIN, DOT_MAX, false)); dot.frustumCulled = false; dot.visible = false; flightScene.add(dot); }
    function shellDot(L, gr) {
      if (!dot) return;
      var k = (gr.n - 1) * 3, p = dotGeo.getAttribute('position'), cal = S.row && S.row.shot && S.row.shot.caliber;
      p.array[0] = flightPos[k]; p.array[1] = flightPos[k + 1]; p.array[2] = flightPos[k + 2]; p.needsUpdate = true;
      dotGeo.getAttribute('fxs').array[0] = DOT_K * (cal > 0 ? cal : 75) / 1000; dotGeo.getAttribute('fxs').needsUpdate = true;
      dot.material.uniforms.uScale.value = o.glowScale ? o.glowScale(o.camera) : 500;
      dot.visible = !L.stub && gr.reach < 1 && o.camera.position.distanceTo(V3.set(p.array[0], p.array[1], p.array[2])) > DOT_NEAR;
    }
    // whether the view draws the shot's flight now: its line, from the shot's clock on
    function flightOn(t) { return !!(S.row && S.line && S.line.len > LINE_MIN && (S.line.stub || t >= S.line.t - 1e-6)); }
    function drawsShot(index, t) { return !!(S.row && S.row.shot && S.row.shot.index === index && flightOn(t)); }
    // 23.11 (NOTEBOOK Z18): the line grows from the muzzle to the shell's place now, as the replay's tracers do - the same
    // procedure (battle.js growTracer), its end the shell on the shell's own clock (the arc's duration; the straight
    // fallback the recorded tracer's flight), back on a rewind or Replay episode. The user's rule (23.11): the line's end
    // and the shell's dot always follow the shell's real clock, never the camera's pace - with "camera at the shell's
    // speed" the eye rides the end; with the eased glide (default) the eye lags it early in the flight, never passes it
    // (easedFrame's cap), and stops at the framing stop. The stub (no shot of the replay) is drawn whole.
    function flightLine() {
      if (!flightOn(S.t)) return;
      var L = S.line, d = flightGeo.getAttribute('lineDistance'), dash = Math.max(0.15, Math.min(5, L.len / 60));
      var PB = root.PlaybackBattle, sh = L.shotIndex != null && o.battle && o.battle.shots ? o.battle.shots[L.shotIndex] : null;
      var flight = L.path ? L.path.duration : sh ? Math.max(.05, sh[10] - sh[0]) : 0, tau = L.stub ? Infinity : S.t - L.t;
      var at = L.path ? function (f) { var p = L.path.point(f); return [p[0], p[1], -p[2]]; }
        : function (f) { return [L.a.x + (L.b.x - L.a.x) * f, L.a.y + (L.b.y - L.a.y) * f, L.a.z + (L.b.z - L.a.z) * f]; };
      var gr = PB.growTracer(at, flight, tau, L.path ? 96 : 1, flightPos);
      if (gr.n < 2) return;
      shellDot(L, gr);
      d.array[0] = 0;
      for (var i = 1; i < gr.n; i++) d.array[i] = d.array[i - 1] + Math.hypot(flightPos[i * 3] - flightPos[i * 3 - 3], flightPos[i * 3 + 1] - flightPos[i * 3 - 2], flightPos[i * 3 + 2] - flightPos[i * 3 - 1]);
      flightGeo.setDrawRange(0, gr.n);
      d.needsUpdate = true; flightGeo.getAttribute('position').needsUpdate = true;
      flightMat.dashSize = dash; flightMat.gapSize = dash * 0.6;
      var R = o.renderer, auto = R.autoClear;
      try { R.autoClear = false; R.render(flightScene, o.camera); } finally { R.autoClear = auto; }
    }
    var impactScreen = new T.Vector3();
    function impactCross() {
      impactMarker.hidden = true;
      // A tracer ending in empty space is not an impact. Require the row's
      // recorded hit and exactly the same visible line lifecycle as flightLine.
      if (!flightOn(S.t) || S.hitT == null || S.t < S.hitT - 1e-6 || !shownHit(S.row)) return;
      impactScreen.copy(S.line.b).applyMatrix4(o.camera.matrixWorldInverse);
      if (impactScreen.z > -.01) return;
      impactScreen.copy(S.line.b).project(o.camera);
      if (Math.abs(impactScreen.x) > 1 || Math.abs(impactScreen.y) > 1) return;
      var el = o.renderer.domElement, v = S.viewer, impact = root.BullbaSettings.impact.get();
      impactLayer.style.setProperty('--impact-opacity', String(impact.opacity / 100)); impactLayer.style.setProperty('--impact-color', impact.color);
      var size = (v && S.mode === 'hits' ? v.reticleSize() : 120) + 'px', style = impactMarker.style;
      style.left = (impactScreen.x + 1) * el.clientWidth / 2 + 'px';
      style.top = (1 - impactScreen.y) * el.clientHeight / 2 + 'px';
      style.width = style.height = size; impactMarker.hidden = false;
    }
    // Hits' flight arc and its start dot (viewer.js drawTracers: the root's children marked shotArc - the arc a line, the
    // dot a point; the arrowhead at the hit stays) are not drawn in this view
    function hideHitsArc(v) {
      v.root.children.forEach(function (c) { if (c.userData && c.userData.shotArc && (c.isLine || c.isPoints) && c.visible) c.visible = false; });
    }
    function overlay() {
      hud();
      flightLine();
      impactCross();
      var v = S.viewer, r = S.target == null ? null : o.vehicle(S.target);
      if (S.mode !== 'hits' || !v || !r || !r.visible || !S.haveA) return;
      hideHitsArc(v);
      if (v.composed && S.saved) silhouette(r);
      var R = o.renderer, auto = R.autoClear;
      // Hits' Grid (its lines and their colour-less depth pass of the main armour) is not in the two passes: it is drawn
      // last with its own depth test, as Hits draws it - its depth pass over this page's depth of the target, the lines
      // behind the hull hidden by it, the ground or a wall in front hiding them
      gridShown.length = 0;
      [v.outlineDepth, v.outline].forEach(function (g) { if (g && g.visible) { gridShown.push(g); g.visible = false; } });
      overlayMats.length = 0;
      v.scene.traverseVisible(function (x) { if (!x.material) return; (Array.isArray(x.material) ? x.material : [x.material]).forEach(function (m) { if (overlayMats.indexOf(m) < 0) overlayMats.push(m); }); });
      if (!overlayMats.length) { grid(); return; }
      var saved = overlayMats.map(function (m) { return [m.depthTest, m.stencilWrite, m.stencilFunc, m.stencilRef, m.stencilFail, m.stencilZFail, m.stencilZPass, m.stencilFuncMask]; });
      function rule(func, depth) { overlayMats.forEach(function (m) { m.stencilWrite = true; m.stencilFunc = func; m.stencilRef = 1; m.stencilFuncMask = 0xff; m.stencilFail = m.stencilZFail = m.stencilZPass = T.KeepStencilOp; m.depthTest = depth; }); }
      try {
        R.autoClear = false;
        rule(T.EqualStencilFunc, false); R.render(v.scene, v.camera);
        rule(T.NotEqualStencilFunc, true); R.render(v.scene, v.camera);
      } finally {
        R.autoClear = auto;
        overlayMats.forEach(function (m, i) { var s = saved[i]; m.depthTest = s[0]; m.stencilWrite = s[1]; m.stencilFunc = s[2]; m.stencilRef = s[3]; m.stencilFail = s[4]; m.stencilZFail = s[5]; m.stencilZPass = s[6]; m.stencilFuncMask = s[7]; });
        grid();   // also shows the Grid's objects again
      }
    }
    // the Grid's own pass: everything else of Hits' scene hidden for it, all put back
    var gridHidden = [];
    function grid() {
      if (!gridShown.length) return;
      var v = S.viewer, R = o.renderer, auto = R.autoClear, i;
      gridHidden.length = 0;
      v.scene.traverseVisible(function (x) { if (x.material && gridShown.indexOf(x) < 0) gridHidden.push(x); });
      for (i = 0; i < gridHidden.length; i++) gridHidden[i].visible = false;
      for (i = 0; i < gridShown.length; i++) gridShown[i].visible = true;
      try { R.autoClear = false; R.render(v.scene, v.camera); }
      finally { R.autoClear = auto; for (i = 0; i < gridHidden.length; i++) gridHidden[i].visible = true; gridHidden.length = 0; gridShown.length = 0; }
    }
    function close(reopen) {
      var was = S.mode, r = S.target == null ? null : o.vehicle(S.target), sh = S.row ? o.vehicle(S.row.shooter) : null;
      S.token++;
      altStop();
      if (S.lineJob || was === 'hits') root.ArmorBallistics.release('circles');   // Hits' emulation off (app.js aimEstStop)
      S.lineJob = null; S.lineEngine = null; S.lineFig = null; S.stopAt = null; S.glided = false;
      release(); S.lock = false; S.view = null;   // the camera handed to the battle view's orbit where the shooter's eye was
      dropExtras();
      if (r) o.look(r, null);
      if (sh && S.veiled) o.veil(sh, false);
      if (S.viewer && was === 'hits') S.viewer.clear();
      if (S.viewer && S.viewer.reticleLayer) S.viewer.reticleLayer.style.visibility = '';
      hudCanvas.hidden = true; S.line = null; S.estimate = null; S.disc = undefined;
      impactMarker.hidden = true;
      S.mode = null; S.row = null; S.armed = false; S.held = null; S.haveA = false; S.data = null; S.rec = null; S.veiled = false; S.posed = false;
      shown(unpin, false); shown(cellA.tile, false); shown(cellB.tile, false);
      if (!reopen) { bar.hidden = true; if (was) o.speed(null); exit(); }
    }
    // THE SHOOTER AT THE SHOT (1.20): the clock playback.js poses vehicle `id` at, at the replay's clock t - the shooter's
    // own at the shot (the tracer's clock less its drawing delay, as the tracer's muzzle is taken: playback.js
    // computeMuzzles) from the shot until the hit's stop; null: the replay's
    function heldPose(id, t) {
      var r = S.row;
      if (!r || id !== r.shooter || !r.shot || S.stop == null || t < r.t - 1e-6 || t > S.stop + 1e-6) return null;
      return r.t - (o.delay ? o.delay(id) : 0);
    }
    // THE TARGET AT THE HIT (20.11, outputs/shot-reconstruction-2026-11-20.md): from the hit's clock until the mode leaves,
    // the target stands where the SERVER had it when the shell struck - the scene Bullba Hits rebuilt from this replay
    // (mod replay_scene.py, format 3: hull 0.2 s, turret and gun 0.1 s before the hit packet), its world pose, turret yaw
    // and gun pitch - not this page's drawing 0.15 s back: Hits' hit line, the shell's line and the model then meet.
    // {world (16, game axes), yaw, pitch} for playback.js poseVehicles, or null: the replay's own pose.
    function targetPose(id, t) {
      var hit = S.data && S.data.hit, tg = hit && hit.target;
      if (!S.row || id !== S.target || S.hitT == null || t < S.hitT - 1e-6 || !tg || tg.poseAt !== 'server') return null;
      if (!Array.isArray(tg.worldTransform) || tg.worldTransform.length !== 16 || !Number.isFinite(tg.turretYaw) || !Number.isFinite(tg.gunPitch)) return null;
      return { world: tg.worldTransform, yaw: tg.turretYaw, pitch: tg.gunPitch, at:S.hitT };
    }
    function rowsText(c) { return [c.arm, c.out].map(function (r) { return r.textContent; }).filter(Boolean).join(' '); }
    function kindText(c, kind) { return Array.prototype.map.call(c.out.querySelectorAll('.chip.' + kind), function (x) { return x.textContent; }).join(''); }
    function state() {
      var v = S.viewer, sf = v && v.surface;
      return { open: !!S.row, mode: S.mode, start: S.start, stop: S.stop, hitT: S.hitT, armed: S.armed, aim: S.aim, error: S.error, note: S.said || '',
        hit: S.hits && S.hits.hit ? S.hits.hit.id : null, posed: !!S.posed, shooterHidden: S.veiled, extras: S.extras.map(function (m) { return m.userData.shotExtra; }),
        shell: S.rec && S.rec.shell ? { kind: S.rec.shell.kind, penetration: S.rec.shell.penetration, guess: S.rec.guess } : null,
        composed: !!(v && v.composed), faces: sf && sf.mesh && sf.mesh.geometry && sf.mesh.geometry.attributes.position ? sf.mesh.geometry.attributes.position.count / 3 : 0,
        ricochetLeg: !!(sf && sf.bounce), shotHeld: !!(v && v.shotHeld), backend: v ? v.backendShown : null,
        pinned: !!(v && v.pinned), pin: v && v.pinned ? cellB.chance.textContent + ' ' + rowsText(cellB) : null,
        hitLine: bar.hidden ? null : { label: cellA.chance.textContent, chips: rowsText(cellA), armour: cellA.arm.textContent, damage: kindText(cellA, 'damage'), ricochet: kindText(cellA, 'ricochet'),
          circle: cellA.tile.style.visibility === 'hidden' ? null : cellA.tileHead.textContent + ' ' + cellA.tileVal.textContent },
        other: bar.hidden ? null : { name: cellB.name.textContent, label: cellB.chance.textContent, chips: rowsText(cellB),
          circle: cellB.tile.style.visibility === 'hidden' ? null : cellB.tileHead.textContent + ' ' + cellB.tileVal.textContent },
        aimOption: aimOn(), alt: S.alt ? { why: S.alt.why || null, radius100: S.alt.r100 || null, fine: S.alt.fine } : null, lens: { fov: o.camera.fov, zoom: o.camera.zoom }, inMode: !!S.saved,
        view: S.view ? S.view.kind : null, firstPerson: !!S.fp, focusLocked: !!S.lock,
        line: S.line ? { t: S.line.t, length: S.line.len, along: S.u, on: onLine(), stub: !!S.line.stub } : null, hud: !hudCanvas.hidden, lookBack: !!S.flip,
        shellChosen: S.shellI, shellEstimate: shellWarn.style.visibility !== 'hidden',
        sight: sightImg.arcade ? 'game' : (sightWhy || 'not read'), estimate: S.estimate ? (S.estimate.why || 'drawn') : null, disc: S.disc ? S.disc.angle : null };
    }
    // 21.11: the row on screen (playback.js viewState and the back control carry its shot, BACKLOG 118); the hit events whose
    // contact dot the page keeps while the view holds the shot (BACKLOG 121: playback.js fxStep)
    function heldHits() { return S.row ? S.row.hits.map(function (h) { return h.index; }) : null; }
    return { open: open, close: function () { close(false); }, active: function () { return !!S.row; }, row: function () { return S.row; }, heldHits: heldHits,
      free: function () { return !!S.row; }, heldPose: heldPose, targetPose: targetPose, drawsShot: drawsShot, camera: camera, panned: panned, paint: paint, overlay: overlay, clamp: clamp, state: state, viewer: function () { return S.viewer; },
      paintMaterial: paintMat, bar: bar };
  }
  root.BullbaShotView = { create: create, BEFORE: BEFORE, SPEED: SPEED, AFTER: AFTER, INSIDE: INSIDE, arty: ARTY };
})(window);
