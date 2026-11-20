/* The replay viewer's frame log (20.11.2026, temporary diagnostic): the user sees heavy stutter in ordinary playback in
 * the game while a headless run on the same GPU gives a steady 8.3 ms frame for 1.12-1.14 alike, so the cause lies in what
 * the game differs in. In the game only, while the battle plays, the page writes its own frame figures into the mod's log
 * through the page channel the input log already uses ('inputLog' -> 'Page input: ...'): one line 10 s of playing after
 * the start, then one every 30 s of playing, at once when an interval over STALL ms came (not sooner than 10 s after the
 * line before - a run of stalls would spend the lines in seconds; such a stall stays in its window's worst), at most
 * LIMIT lines per page load. Paused: nothing is collected or written.
 *
 * Cost: the page hands each frame's interval and its own CPU time (the figures it already takes for #m-int and #m-cpu);
 * they go into two typed arrays made once; a line sorts them once (every 30 s at most).
 *
 *   var log = BullbaFrameLog.create({ send: function (line) {...}, state: function () { return {...}; } });
 *   log.frame(intervalMs, cpuMs, playing);   // every frame
 *   BullbaFrameLog.contexts()                 // WebGL contexts made on this page so far
 */
(function (root) {
  'use strict';
  var FIRST = 10000, EVERY = 30000, STALL = 250, STALL_GAP = 10000, LIMIT = 20, CAP = 16384;

  // every WebGL context a canvas of this page makes, counted once per canvas (getContext is called once per canvas by
  // three.js; the wrapper costs nothing per frame)
  var made = 0, proto = root.HTMLCanvasElement && root.HTMLCanvasElement.prototype, get = proto && proto.getContext;
  if (get) {
    proto.getContext = function (type) {
      var c = get.apply(this, arguments);
      if (c && /webgl/i.test(String(type)) && !this.__bullbaGl) { this.__bullbaGl = true; made++; }
      return c;
    };
  }

  function q(a, n, p) { return n ? a[Math.min(n - 1, Math.floor(p * n))] : NaN; }
  function f(x, d) { return isFinite(x) ? x.toFixed(d) : '-'; }

  function create(o) {
    var iv = new Float64Array(CAP), cpu = new Float64Array(CAP);
    var n = 0, frames = 0, worst = 0, worstCpu = 0, over33 = 0, over100 = 0, winMs = 0;
    var played = 0, nextAt = FIRST, lastLine = -Infinity, sent = 0;

    function line(why) {
      var s = o.state() || {}, k = Math.min(n, CAP), a = iv.subarray(0, k), c = cpu.subarray(0, k);
      a.sort(); c.sort();
      var text = 'playback frames ' + (sent + 1) + '/' + LIMIT + ' (' + why + '): ' + f(winMs / 1000, 1) + ' s played, ' + frames + ' frames' +
        (frames > CAP ? ' (figures of the first ' + CAP + ')' : '') +
        '; interval median ' + f(q(a, k, 0.5), 1) + ' / p95 ' + f(q(a, k, 0.95), 1) + ' / worst ' + f(worst, 1) + ' ms' +
        ', over 33 ms ' + over33 + ', over 100 ms ' + over100 +
        '; page CPU per frame (step + render) median ' + f(q(c, k, 0.5), 2) + ' / p95 ' + f(q(c, k, 0.95), 2) + ' / worst ' + f(worstCpu, 2) + ' ms' +
        '; canvas ' + (s.canvas || '?') + ' dpr ' + (s.dpr == null ? '?' : s.dpr) +
        '; playing x' + (s.speed == null ? '?' : s.speed) + ', camera ' + (s.camera || '?') +
        '; WebGL contexts ' + made + ', canvases ' + (s.canvases == null ? '?' : s.canvases) +
        '; shot view opened ' + (s.shotViewOpened ? 'yes' : 'no') +
        '; ' + (s.settings || 'settings ?') +
        '; map ' + (s.map || '?');
      sent++; lastLine = played;
      n = 0; frames = 0; worst = 0; worstCpu = 0; over33 = 0; over100 = 0; winMs = 0;
      try { o.send(text); } catch (e) { /* the log is a diagnostic: it never breaks the frame */ }
      return text;
    }

    function frame(gap, ms, playing) {
      if (!playing || sent >= LIMIT || !(gap > 0)) return null;
      if (n < CAP) { iv[n] = gap; cpu[n] = ms; n++; }
      frames++; played += gap; winMs += gap;
      if (gap > worst) worst = gap;
      if (ms > worstCpu) worstCpu = ms;
      if (gap > 33) over33++;
      if (gap > 100) over100++;
      if (gap > STALL && played - lastLine >= STALL_GAP) return line('an interval over ' + STALL + ' ms');
      if (played >= nextAt) { var first = nextAt === FIRST; nextAt = played + EVERY; return line(first ? '10 s after the start' : 'every 30 s'); }
      return null;
    }

    return { frame: frame, sent: function () { return sent; } };
  }

  root.BullbaFrameLog = { create: create, contexts: function () { return made; }, LIMIT: LIMIT };
})(typeof window !== 'undefined' ? window : this);
