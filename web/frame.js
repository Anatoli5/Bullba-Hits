/* THE PAGE'S ONE FRAME LOOP (28.09, frame-sync). Input and rendering run apart and meet here, once a frame.
 *
 * Before, every part of the page asked the browser for animation frames of its own: the viewer's draw, its camera easing,
 * its hover reading, the emulation's aim loop and the figure's slices, the slider redraw, the layout pass, the host's frame
 * clock. Their callbacks ran in the order they happened to be asked for, so the camera could be moved AFTER the frame that
 * showed it had already been drawn (the picture then stood still for a frame and caught up the next) and the aim ring was
 * sometimes drawn with this frame's state and sometimes with the last one's.
 *
 * Now there is one requestAnimationFrame. A part registers a TASK with an order and asks for it (want); the frame runs
 * the tasks that were asked for in their order - input, camera, hover, aim, figure, layout, render, stats - so everything
 * a frame shows is computed in that frame, before it is drawn. A task asked for by a task EARLIER in the running frame's
 * order runs in the same frame (the camera moved: the render follows it); asked for by itself or a later one, it runs in
 * the next frame. Event handlers only store what came in (BullbaFrame.Track below) and ask for the task.
 *
 * Tasks are timed (two clock reads each): `costs` is what the last frame's tasks took, for the host's frame telemetry;
 * `note(name, since)` records named work done outside the frames (a scene load in a click handler, a rebuild in a timer).
 *
 * THE INPUT TRACK. The game forwards its cursor to the browser at its own frame rate, not at the page's 60 Hz, and the
 * browser hands the page one coalesced pointermove per frame: a steady hand arrives as 0, 1 or 2 game frames' worth of
 * motion per page frame (game.log 28.09: 16-18 ms apart, the movement per event varying up to 2.5 times). Applied as it
 * comes, the picture moves in uneven steps even at a steady 60 frames/s. A Track keeps the samples with their own time
 * stamps (every coalesced one) and gives, at a frame, the position the pointer had at `lag` ms before the frame - linearly
 * between the two samples around that moment - so each frame moves by what the hand did in one frame's time. `lag` is
 * learnt while the hand moves: how old the newest sample was at each frame (a frame the game sent nothing for counts once
 * the next sample shows the motion went on), the second largest of the last LAG_WINDOW such frames (one lone late event
 * is let through as one uneven step rather than delaying everything), at most LAG_MAX; it falls by at most 1 ms a frame,
 * so the moment looked at never jumps forward. With time stamps that carry nothing (all equal), lag is 0 and the track
 * gives the newest position - the old behaviour. A new gesture keeps the lag learnt, so it is smooth from its start.
 */
(function (root) {
  'use strict';
  var ORDER = {input: 10, camera: 20, hover: 30, aim: 40, figure: 45, layout: 50, render: 60, stats: 90};
  var STALL = 2000, LAG_MAX = 34, LAG_WINDOW = 30, AGE_LIVE = 50;
  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  var tasks = [], serial = 0, running = -1, frameT = null, asked = 0, askedAt = 0;
  var F = {ORDER: ORDER, costs: [], notes: [], serial: 0, probe: null,
    // What the last render put on screen, for the host's telemetry: the eye, the view direction, log zoom, the orbit
    // distance, and the live ring (centre, radius; NaN without one). Written by the viewer's render task.
    view: new Float64Array(8), ring: new Float64Array(4), viewSerial: 0};
  F.ring.fill(NaN);
  function request() {
    if (asked) return;
    askedAt = now();
    var raf = root.requestAnimationFrame;
    asked = raf ? raf.call(root, tick) || -1 : root.setTimeout(function () { tick(now()); }, 16) || -1;
  }
  function report(e) { root.setTimeout(function () { throw e; }, 0); }
  function tick(t) {
    asked = 0; serial++; F.serial = serial; frameT = typeof t === 'number' ? t : now();
    var costs = F.costs; costs.length = 0;
    try {
      for (var i = 0; i < tasks.length; i++) {
        var k = tasks[i];
        if (!k.at || k.at > serial) continue;
        k.at = 0; running = i;
        var s = now();
        try { k.fn(frameT); } catch (e) { report(e); }
        var d = now() - s;
        costs.push(k.name, d);
        if (F.probe) { try { F.probe(k.name, d, frameT); } catch (e2) { /* a harness's */ } }
      }
    } finally {
      running = -1; frameT = null;
      for (var j = 0; j < tasks.length; j++) if (tasks[j].at) { request(); break; }
    }
  }
  function Task(order, name, fn) { this.order = order; this.name = name; this.fn = fn; this.at = 0; }
  // Asked for: in this frame when the running task comes before it, otherwise in the next.
  Task.prototype.want = function () {
    if (this.at && this.at <= serial + 1) return;
    var i = tasks.indexOf(this);
    if (i < 0) return;
    if (running >= 0 && i > running) { this.at = serial; return; }
    this.at = serial + 1; request();
  };
  Task.prototype.cancel = function () { this.at = 0; };
  Task.prototype.pending = function () { return this.at > 0; };
  Task.prototype.drop = function () { this.at = 0; var i = tasks.indexOf(this); if (i >= 0) { tasks.splice(i, 1); if (running >= i) running--; } };
  // A task of the loop, placed after every task of the same or an earlier order.
  F.task = function (order, name, fn) {
    var k = new Task(typeof order === 'number' ? order : ORDER[order] || 0, name, fn), i = 0;
    while (i < tasks.length && tasks[i].order <= k.order) i++;
    tasks.splice(i, 0, k);
    if (running >= i) running++;
    return k;
  };
  // The running frame's time stamp (the animation frame's own), or null outside a frame.
  F.time = function () { return frameT; };
  F.now = now;
  // Named work done outside the frames, since `since` (a now() reading): kept for the next frame's telemetry.
  F.note = function (name, since) { var d = now() - since; if (F.notes.length < 32) F.notes.push(name, since, d); return d; };
  // A frame asked for that never came (a host that stopped painting): asked for again.
  F.kick = function () { if (asked && now() - askedAt >= STALL) { if (root.cancelAnimationFrame && asked > 0) root.cancelAnimationFrame(asked); asked = 0; request(); } };
  // Test seams: the names of the tasks asked for, and one task run by itself (a harness running one timer's worth).
  F.pendingNames = function () { var out = []; tasks.forEach(function (k) { if (k.at) out.push(k.name); }); return out; };
  F.runTask = function (name) { tasks.slice().forEach(function (k) { if (k.at && k.name === name) { k.at = 0; k.fn(now()); } }); };
  // Back on the page: a frame asked for while the host had stopped painting may never fire.
  if (root.document && root.document.addEventListener) root.document.addEventListener('visibilitychange', function () {
    if (root.document.hidden || !asked) return;
    if (root.cancelAnimationFrame && asked > 0) root.cancelAnimationFrame(asked);
    asked = 0; request();
  });

  // ---- the input track -----------------------------------------------------------------------------------------
  function stamp(e) { var s = e && e.timeStamp, n = now(); return typeof s === 'number' && s > 0 && Math.abs(s - n) < 10000 ? s : n; }
  function Track() { this.t = []; this.x = []; this.y = []; this.ages = []; this.lag = 0; this.seen = -Infinity; this.fresh = false; this.gapAge = 0; }
  // A new gesture from (x, y) at the time of `e`: the samples go, the lag learnt so far stays.
  Track.prototype.start = function (e, x, y) { this.t.length = this.x.length = this.y.length = 0; this.seen = -Infinity; this.fresh = false; this.gapAge = 0; this.push(stamp(e), x, y); };
  Track.prototype.push = function (t, x, y) {
    var n = this.t.length;
    if (n && t < this.t[n - 1]) t = this.t[n - 1];
    if (n && t - this.t[n - 1] >= AGE_LIVE) this.gapAge = 0;   // the hand had stopped: the wait before is no late sample
    this.t.push(t); this.x.push(x); this.y.push(y); this.fresh = true;
  };
  // Every sample an event carries: its coalesced ones (the game's own cadence) or itself.
  Track.prototype.add = function (e) {
    var list = e && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (list && list.length) { for (var i = 0; i < list.length; i++) this.push(stamp(list[i]), list[i].clientX, list[i].clientY); }
    else this.push(stamp(e), e.clientX, e.clientY);
  };
  Track.prototype.age = function (a) { if (a >= 0 && a < AGE_LIVE) { this.ages.push(a); if (this.ages.length > LAG_WINDOW) this.ages.shift(); } };
  // The position at the frame T (`out.more`: the track still has motion to give after this frame).
  Track.prototype.at = function (T, out) {
    var n = this.t.length, i;
    out = out || {x: 0, y: 0, more: false};
    if (!n) { out.more = false; return out; }
    var age = T - this.t[n - 1];
    if (this.fresh) { if (this.gapAge > 0) this.age(this.gapAge); this.gapAge = 0; this.age(age); this.fresh = false; }
    else if (age > this.gapAge) this.gapAge = age;   // nothing new this frame: counted once the next sample comes
    var first = 0, second = 0;
    for (i = 0; i < this.ages.length; i++) { var g = this.ages[i]; if (g > first) { second = first; first = g; } else if (g > second) second = g; }
    var want = Math.min(LAG_MAX, this.ages.length > 2 ? second : first);
    this.lag = want >= this.lag ? want : Math.max(want, this.lag - 1);
    var S = Math.max(this.seen, T - this.lag);
    this.seen = S;
    var j = n - 1;
    while (j > 0 && this.t[j - 1] > S) j--;
    if (S >= this.t[n - 1]) { out.x = this.x[n - 1]; out.y = this.y[n - 1]; out.more = false; }
    else if (j === 0) { out.x = this.x[0]; out.y = this.y[0]; out.more = true; }
    else {
      var a = j - 1, span = this.t[j] - this.t[a], f = span > 0 ? (S - this.t[a]) / span : 1;
      out.x = this.x[a] + (this.x[j] - this.x[a]) * f; out.y = this.y[a] + (this.y[j] - this.y[a]) * f; out.more = true;
    }
    // The samples before the one at or before S are not needed again.
    if (j > 9) { this.t.splice(0, j - 1); this.x.splice(0, j - 1); this.y.splice(0, j - 1); }
    return out;
  };
  // The end of a gesture: the newest position, all of it at once.
  Track.prototype.flush = function (out) {
    var n = this.t.length; out = out || {x: 0, y: 0, more: false};
    if (n) { out.x = this.x[n - 1]; out.y = this.y[n - 1]; this.seen = this.t[n - 1]; }
    out.more = false; return out;
  };
  F.Track = Track;
  root.BullbaFrame = F;
}(typeof window !== 'undefined' ? window : this));
