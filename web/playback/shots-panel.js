/* The replay viewer's shots panel (BACKLOG 109, stage 1, 19.11.2026): for any vehicle of either team, the list of its shots
   and the hits it took in this battle, in time order, each row as Bullba Hits draws a hit (web/hit-rows.js: the same tile,
   icon column and outcome, the same styles in web/rows.css); a click on a row rewinds the battle to about 2 s before the
   shot and puts the camera where it shows the shooter and the target; a row of a battle with a Hits record also opens that
   shot in Bullba Hits.

   What a row rests on - the battle the page decoded from the replay (web/playback/battle.js), nothing else:
   - a SHOT: a tracer the replay carries (showTracer; 'shots', a ricochet's own tracer not counted as a shot), with the
     hits the server reported for that shooter as the shell ended (showDamageFromShot of the same attacker within
     LINK_WINDOW of the tracer's end - the rule web/shot-context.js links a replay-made battle's tracer, stop and hit by:
     GAME_END_WINDOW 0.15 s on the replay's clock). A tracer with no hit: 'no hit in the replay' - the replay names no
     vehicle it hit, which is not "missed" (a vehicle the recording client did not see is not in it);
   - a HIT TAKEN: every showDamageFromShot on the vehicle ('hitEvents'), with its shooter's tracer when one is linked;
   - a hit BY the vehicle that no tracer of his is linked to (his tracer was not in the replay): a row of its own.
   What a Hits row has and this one has not: the critical damage (Hits ties crits from the crit records the mod writes; the
   page's decode keeps none - the icon column stays empty), the HE splash hits (showDamageFromExplosion - not decoded here),
   the shell (the replay gives the shell's index in the shooter's gun and its calibre; the calibre is in the row's words).
   Nothing is guessed in their place.

   BullbaShotsPanel {rows(battle, id), linkHits(battle), positionAt(vehicle, t), frame(a, b), create(options)}; create ->
   {toggle(id, anchor, side), open(id, anchor, side), close(), shown(), count(), place()}. The page (playback.js) gives the
   anchor (its team list's box) and the side ('own' left, 'enemy' right), and the actions (pick, hits). */
(function (root) {
  'use strict';
  var R = root.BullbaRows;
  var LINK_WINDOW = 0.15;   // s: a hit to its tracer's end (shot-context.js GAME_END_WINDOW for replay-made battles)
  var BEFORE = 2;           // s: the battle rewinds this far before the shot (the user's word, 19.11)
  var SHOT = { t: 0, shooter: 1, ricochet: 2, sx: 3, sy: 4, sz: 5, tEnd: 10, ex: 11, ey: 12, ez: 13, caliber: 15 };

  // ---- the model: rows from the battle object (pure, also under node) ---------------------------------------------------
  // Each hit event to the tracer it ended: [tracer index or -1] by hit event index. A ricochet's own tracer hands its hits
  // to the shot it came from (the same shooter's last non-ricochet tracer before it). Each hit is linked once, to the
  // nearest tracer end of its attacker within LINK_WINDOW.
  function linkHits(b) {
    if (b._shotLinks) return b._shotLinks;
    var shots = b.shots || [], hits = b.hitEvents || [], byShooter = {}, parent = [], i;
    for (i = 0; i < shots.length; i++) {
      var s = shots[i], list = byShooter[s[SHOT.shooter]] || (byShooter[s[SHOT.shooter]] = []);
      if (s[SHOT.ricochet]) { var last = -1; for (var k = list.length - 1; k >= 0; k--) if (!shots[list[k]][SHOT.ricochet] && shots[list[k]][SHOT.t] <= s[SHOT.t]) { last = list[k]; break; } parent[i] = last; }
      else parent[i] = i;
      list.push(i);
    }
    var link = hits.map(function (h) {
      var list = byShooter[h[2]] || [], best = -1, gap = Infinity;
      list.forEach(function (j) { var d = Math.abs(shots[j][SHOT.tEnd] - h[0]); if (d <= LINK_WINDOW && d < gap) { gap = d; best = j; } });
      return best < 0 ? -1 : parent[best];
    });
    var byShot = {};
    link.forEach(function (j, hi) { if (j >= 0) (byShot[j] || (byShot[j] = [])).push(hi); });
    Object.defineProperty(b, '_shotLinks', { value: { hitShot: link, shotHits: byShot }, enumerable: false, configurable: true });
    return b._shotLinks;
  }
  function hitOf(b, hi) {
    var h = b.hitEvents[hi];
    return { index: hi, t: h[0], target: h[1], attacker: h[2] < 0 ? null : h[2], damage: h[3],
      points: h[4].map(function (p) { return { effect: p[0], caliber: p[1], shellType: p[2] }; }) };
  }
  function shotOf(b, si) {
    var s = b.shots[si];
    return { index: si, t: s[SHOT.t], shooter: s[SHOT.shooter], start: [s[SHOT.sx], s[SHOT.sy], s[SHOT.sz]], tEnd: s[SHOT.tEnd],
      end: [s[SHOT.ex], s[SHOT.ey], s[SHOT.ez]], caliber: s.length > SHOT.caliber ? s[SHOT.caliber] : null };
  }
  // The rows of vehicle `id`, in time order: {kind 'shot'|'hit', view 'outgoing'|'incoming', t (the shot's moment: its
  // tracer, else the hit), shooter, target (null: none named), shot (or null), hits [...], key}.
  function rows(b, id) {
    var L = linkHits(b), out = [], shots = b.shots || [], hits = b.hitEvents || [], i;
    for (i = 0; i < shots.length; i++) {
      if (shots[i][SHOT.shooter] !== id || shots[i][SHOT.ricochet]) continue;
      var hs = (L.shotHits[i] || []).map(function (hi) { return hitOf(b, hi); });
      out.push({ kind: 'shot', view: 'outgoing', t: shots[i][SHOT.t], shooter: id, target: hs.length ? hs[0].target : null, shot: shotOf(b, i), hits: hs, key: 's' + i });
    }
    for (i = 0; i < hits.length; i++) {
      var h = hits[i], j = L.hitShot[i];
      if (h[1] === id) out.push({ kind: 'hit', view: 'incoming', t: j >= 0 ? shots[j][SHOT.t] : h[0], shooter: h[2] < 0 ? null : h[2], target: id,
        shot: j >= 0 ? shotOf(b, j) : null, hits: [hitOf(b, i)], key: 'h' + i });
      else if (h[2] === id && h[1] !== id && j < 0) out.push({ kind: 'hit', view: 'outgoing', t: h[0], shooter: id, target: h[1], shot: null, hits: [hitOf(b, i)], key: 'h' + i });
    }
    out.sort(function (a, c) { return a.t - c.t || (a.key < c.key ? -1 : 1); });
    return out;
  }
  // A row as Hits' hit: the damage and the points of the hit it shows - the one with damage, else the last.
  function shownHit(row) {
    if (!row.hits.length) return { damage: 0, points: [] };
    var dealt = row.hits.filter(function (h) { return h.damage > 0; });
    return dealt.length ? dealt[0] : row.hits[row.hits.length - 1];
  }

  // ---- where a vehicle stood (battle.js 'pos': t, x, y, z, yaw, pitch, roll per row) -------------------------------------
  function positionAt(v, t) {
    var p = v && v.pos, n = v ? v.np : 0;
    if (!p || !n) return null;
    var lo = 0, hi = n - 1;
    if (t <= p[0]) return [p[1], p[2], p[3]];
    if (t >= p[hi * 7]) return [p[hi * 7 + 1], p[hi * 7 + 2], p[hi * 7 + 3]];
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (p[m * 7] <= t) lo = m; else hi = m; }
    var a = lo * 7, c = hi * 7, k = (t - p[a]) / ((p[c] - p[a]) || 1);
    return [p[a + 1] + (p[c + 1] - p[a + 1]) * k, p[a + 2] + (p[c + 2] - p[a + 2]) * k, p[a + 3] + (p[c + 3] - p[a + 3]) * k];
  }
  // The shooter's and the target's places for a row: the tracer's start and end when there is one, else where the two
  // vehicles stood at the hit.
  function places(b, row) {
    var byId = function (id) { return (b.vehicles || []).filter(function (v) { return v.id === id; })[0]; };
    var at = row.hits.length ? row.hits[0].t : row.t;
    var a = row.shot ? row.shot.start : positionAt(byId(row.shooter), row.t);
    var c = row.shot ? row.shot.end : positionAt(byId(row.target), at);
    if (!c && row.target != null) c = positionAt(byId(row.target), at);
    return { shooter: a, target: c };
  }
  // A camera of the viewer (playback.js `cam`: the target point tx, ty, tz in game coordinates, yaw, pitch, distance) that
  // shows both points: aimed at their middle from the side of the line between them, a little behind the shooter, far
  // enough for both. One point alone: a close look at it.
  function frame(a, c) {
    if (!a && !c) return null;
    if (!a || !c) { var q = a || c; return { tx: q[0], ty: q[1] + 1.5, tz: q[2], yaw: 0.6, pitch: 0.5, dist: 35 }; }
    var dx = c[0] - a[0], dz = c[2] - a[2], span = Math.sqrt(dx * dx + dz * dz) || 1, ux = dx / span, uz = dz / span;
    // the side of the line, turned 30 degrees toward behind the shooter (game coordinates: z north)
    var ox = -uz * 0.87 - ux * 0.5, oz = ux * 0.87 - uz * 0.5, n = Math.sqrt(ox * ox + oz * oz) || 1;
    ox /= n; oz /= n;
    // playback.js placeCamera: the eye is at (tx + d cos p sin yaw, ty + d sin p, -tz + d cos p cos yaw) in scene
    // coordinates (scene z = -game z): a horizontal offset (ox, oz) in game coordinates is sin yaw = ox, cos yaw = -oz
    return { tx: (a[0] + c[0]) / 2, ty: (a[1] + c[1]) / 2 + 1.5, tz: (a[2] + c[2]) / 2, yaw: Math.atan2(ox, -oz), pitch: 0.42,
      dist: Math.max(30, Math.min(900, span * 0.95 + 15)) };
  }

  // ---- the panel ------------------------------------------------------------------------------------------------------
  // options: {battle, info(id) -> the tile's vehicle {name, level, class, role, nation, type} or null, player(id) -> the
  // nickname or '', clock(t) -> the row's time text, pick(row, jump) - jump: {t, camera} -, hits(row, id) -> a function that
  // opens the row in Bullba Hits, or null when the battle has no Hits record; parent (document.body)}
  function create(o) {
    var b = o.battle, box = R.node('div', undefined, 'shots-panel'), head = R.node('div', undefined, 'sp-head'), list = R.node('div', undefined, 'sp-list');
    var title = R.node('span', '', 'sp-title'), close = R.node('button', '✕', 'sp-close');
    close.type = 'button'; close.title = 'Close\nThe list of this vehicle’s shots and hits.'; close.onclick = function () { hide(); };
    head.appendChild(title); head.appendChild(close); box.appendChild(head); box.appendChild(list);
    box.hidden = true; (o.parent || document.body).appendChild(box);
    var state = { id: null, anchor: null, side: null, rows: [] };
    function name(id) { var v = id == null ? null : o.info(id); return (v && v.name) || (id == null ? 'not named' : 'Unknown vehicle'); }
    function words(row, shown) {
      var who = row.view === 'outgoing' ? (row.target == null ? 'Shot: no hit in the replay' : 'Shot at ' + name(row.target)) : 'Hit by ' + (row.shooter == null ? 'a vehicle the replay does not name' : name(row.shooter));
      var lines = [who];
      if (row.hits.length) lines.push('• Result: ' + R.result(shown).replace(/^Result (\d)/, 'Effect $1').replace(/^Result not/, 'Not'));
      if (row.hits.length > 1) lines.push('• Hits of this shell: ' + row.hits.map(function (h) { return name(h.target) + ' ' + (h.damage > 0 ? h.damage + ' HP' : (R.effects[(h.points[h.points.length - 1] || {}).effect] || 'no effect')); }).join(', '));
      var cal = row.shot && row.shot.caliber ? row.shot.caliber : (row.hits[0] && row.hits[0].points[0] ? row.hits[0].points[0].caliber : 0);
      if (cal) lines.push('• Calibre: ' + Math.round(cal) + ' mm');
      if (!row.shot) lines.push('• Tracer: not in the replay');
      lines.push('• Time: ' + o.clock(row.t), '', '• Click: the battle from ' + BEFORE + ' s before the shot, the camera on both vehicles');
      return lines.join('\n');
    }
    function rowEl(row) {
      var shown = shownHit(row), other = row.view === 'outgoing' ? row.target : row.shooter;
      var tile = other == null ? { name: row.view === 'outgoing' ? 'No hit in the replay' : 'Shooter not named' } : (o.info(other) || { name: 'Unknown vehicle' });
      var b0 = R.hitRow(shown, row.view, tile, { time: o.clock(row.t), crits: [] });
      b0.setAttribute('data-key', row.key); b0.setAttribute('data-kind', row.kind); b0.title = words(row, shown);
      b0.onclick = function () { pick(row); };
      var wrap = R.node('div', undefined, 'sp-row');
      wrap.appendChild(b0);
      var open = o.hits ? o.hits(row, state.id) : null;
      if (open) {
        var h = R.node('button', 'Hits', 'sp-open'); h.type = 'button';
        h.title = 'Open in Bullba Hits\nThis shot in the Bullba Hits window: its armour from the shooter’s point of view.';
        h.onclick = function (e) { e.stopPropagation(); open(); };
        wrap.appendChild(h);
      }
      return wrap;
    }
    function pick(row) {
      Array.prototype.forEach.call(list.querySelectorAll('.hit'), function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-key') === row.key)); });
      var p = places(b, row);
      if (o.pick) o.pick(row, { t: Math.max(0, row.t - BEFORE), camera: frame(p.shooter, p.target) });
    }
    function show(id, anchor, side) {
      state.id = id; state.anchor = anchor; state.side = side;
      state.rows = rows(b, id);
      var pl = o.player ? o.player(id) : '';
      title.textContent = name(id) + (pl ? ' · ' + pl : '');
      title.title = name(id) + '\n' + state.rows.filter(function (r) { return r.view === 'outgoing'; }).length + ' shots and hits by it, ' + state.rows.filter(function (r) { return r.view === 'incoming'; }).length + ' hits on it in the replay.';
      list.replaceChildren();
      if (!state.rows.length) list.appendChild(R.node('p', 'No shots or hits of this vehicle in the replay.', 'sp-empty'));
      state.rows.forEach(function (r) { list.appendChild(rowEl(r)); });
      box.setAttribute('data-side', side === 'enemy' ? 'enemy' : 'own');
      box.hidden = false; place();
      if (o.changed) o.changed(id);
    }
    function hide() { state.id = null; box.hidden = true; if (o.changed) o.changed(null); }
    // beside the team list it belongs to, its height (the list's box on the screen): right of the left list, left of the
    // right one
    function place() {
      if (box.hidden || !state.anchor) return;
      var r = state.anchor.getBoundingClientRect(), gap = 6;
      box.style.top = Math.round(r.top) + 'px'; box.style.height = Math.round(r.height) + 'px';
      if (state.side === 'enemy') { box.style.left = ''; box.style.right = Math.round(window.innerWidth - r.left + gap) + 'px'; }
      else { box.style.right = ''; box.style.left = Math.round(r.right + gap) + 'px'; }
    }
    window.addEventListener('resize', place);
    return {
      open: show, close: hide, place: place, element: box,
      toggle: function (id, anchor, side) { if (state.id === id && !box.hidden) hide(); else show(id, anchor, side); },
      shown: function () { return box.hidden ? null : state.id; },
      count: function () { return box.hidden ? 0 : list.querySelectorAll('.sp-row').length; }
    };
  }
  // The small button of a team-list row that opens the panel (its own click: the row's click follows the vehicle).
  function button(onclick) {
    var b = R.node('button', 'hits', 'sp-btn'); b.type = 'button';
    b.title = 'Shots and hits\nThis vehicle’s shots and the hits it took, in a list beside this one.\n• A row: the battle from ' + BEFORE + ' s before that shot';
    b.onclick = function (e) { e.stopPropagation(); onclick(); };
    return b;
  }

  var api = { rows: rows, linkHits: linkHits, positionAt: positionAt, frame: frame, places: places, create: create, button: button, BEFORE: BEFORE, LINK_WINDOW: LINK_WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BullbaShotsPanel = api;
})(typeof window !== 'undefined' ? window : this);
