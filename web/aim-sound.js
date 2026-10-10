// THE SOUND OF THE AIM EMULATION (08.10.2026) - a listening bench for the countdown scheme of the mod Bullba Countdown:
// the user hears, on the page's emulated guns with their own timings, what that scheme would play in a battle.
// ONE OWNER: this object alone holds the audio context, schedules, cancels and plays. The emulation (web/app.js,
// aimSoundTell) only TELLS it the state of the gun's load whenever that state is changed by something other than the
// plain passing of time - a round fired, a release, a reset, a rule or a gun switched, the page hidden - and the plan
// of everything that will sound is made again from it; what is scheduled and no longer planned is cancelled. Nothing
// here runs on a frame: a readiness is known ahead, so its sounds are put on the audio clock ahead.
//
// THE RULE (the user's own, as it stood at the end of 08.10: "the signal always marks readiness to fire" - only the
// readiness of a shot is marked, never the shot; the triggers differ: the shot before, a reload, the gun cooling):
//   STOCK      how many shots can be fired now, the critical one - the shot that brings the penalty - counted: a gun
//              that locks by heat (the Ares) its shots left before the lock, the one that overheats included; a
//              magazine its rounds - its PULLS where one pull fires a burst (user, 10.10: a burst on one pull "is in
//              essence one shot"); a single-shot gun 1 (web/app.js counts it).
//   THE BELL   sounds when a shot becomes ready; its pitch is the stock at that moment, the lower the more: 1 the
//              DOUBLE strike at 4186 Hz - the critical shot is ready - then one bell a step, down one chord: 2 3136,
//              3 2637, 4 2093, 5 1568, 6 1319, 7 1047, 8 784, 9 and anything above 659 Hz. The same stock is the same
//              tone whichever way it was reached.
//                RAPID FIRE (the next round ready after a gap between rounds too short for a countdown - an
//                automatic gun's fire interval, a fast drum: under 1.1 s): only with the stock down to SIGNALS (3
//                by default; 2 or 4), silence above - "the three last ones set the interval"; so a machine gun's
//                magazine is silent down to its last rounds (user, 10.10, having heard every round of it rung as
//                an option: "that is too much ... the three last ticks for a machine gun, as it was"). The count is for
//                such guns alone (user, 09.10, on a drum of five whose second round came ready in silence after
//                its ticks: "the readiness of every round must be marked"): a gap long enough to be COUNTED
//                (below) always ends in its sound, whatever the stock - no countdown is left without its final;
//                THE WAY BACK (a heat gun cooling: one more shot is there; a round of an autoreloader loaded) and the
//                end of any other wait the player sat through (a reload, a magazine reload, an Ares gun unlocking):
//                always, every step, whatever SIGNALS is - "back it may count as long as you like".
//   FULL       the stock is all back - a cold gun, a full magazine: instead of its bell the LOW double, 523 Hz, the
//              high double itself three octaves down - "everything is reloaded". A single-shot gun is full and at its
//              critical shot at once: it keeps the high double, as the mod plays it today.
//   TIME TICKS before a readiness that ends a wait of 1 s or more: at whole seconds before the end, never within 0.1 s
//              of the wait's start (or of the moment a running wait was moved); none before the bells of a cooling
//              gun. How many is COUNTDOWN - 3, 4 or 5 sounds of a wait, its final bell counted (4 by default, as the
//              mod has it: ticks at -3, -2, -1 s; "marking every second would be a constant nagging sound") - fewer in
//              a shorter wait. Their pitch never rises by the second (user, 08.10 and 09.10: ticks repeating the
//              tones of the rounds are "a mess"). A wait that gets a tick is a COUNTED wait - by its length alone
//              (1.1 s and more), so its final sound is one and the same however often the plan is made again. How a
//              counted wait sounds is one of two:
//                'shot' - THE TONE OF THE SHOT, the default (user, 09.10: "the doubled one must mark exactly the
//                         readiness of the next round - it must differ from the preliminary ticks not by tone but
//                         by form"): every tick is the bell of the readiness' pitch, struck once; the final is that
//                         bell struck TWICE. A double here ends a countdown - "this shot is ready" - on every gun
//                         with a wait, whatever the stock: at 4186 Hz it is the mod's own final double, at 523 Hz
//                         the low double of a full stock, between them the double of that stock's bell;
//                'one'  - ONE tone: the dry tick at 880 Hz before any shot (it lies between two bells of the stock,
//                         two semitones from the nearer); the final is the ordinary sound of the stock.
//              A wait that is not counted (an Ares gun's 0.3 s between rounds), a shot a cooling gun gets back and the
//              round of the simplified rule sound the same in both: the ordinary sound of the stock - a single bell,
//              the high double when only the critical shot is left, the low double at full.
// The samples are the mod's own and its proposal's (web/aim-sound-samples.js, generated by tools/build_aim_sounds.py):
// the dry tick, and the bell of each of the ten pitches struck once (bellNNNN) and twice (bellNNNNx2). Every double
// is the mod's final double at another pitch - two short strikes 48 ms apart, 98 ms, levelled by ear's weight - the
// low double of a full stock too (user, 09.10: built wider it was "like two separate sounds"). No other sound is
// made (user, 09.10: "too many different sounds will throw people off").
//
// The state told: null (nothing to sound: the emulation is off, the page hidden) or
//   {now,                       the emulation's clock, seconds (performance.now() / 1000)
//    full,                      the stock when everything is back
//    shot,                      a round has just left a gun whose next round is ready at once (the simplified rule,
//                               which has no interval to wait): the stock now; null otherwise
//    waits: [{from, at, stock, zone}],   each readiness ahead that ends a wait: it began at `from` and ends at `at`,
//                                        the stock then; zone: a readiness of the firing side (within SIGNALS only -
//                                        unless the wait is long enough to be counted: then always)
//    back: [{at, stock}]}       each shot a cooling gun gets back: the second, the stock then (no time ticks)
// ES5, like the rest of the page; no listener, no timer, no frame.
(function () {
  'use strict';
  var win = window;
  if (win.BullbaAimSound) return;

  var LEVEL = 0.7;            // of full scale: a bell and a tick may fall together
  var WAIT_MIN = 1.0;         // s: a shorter wait has no time ticks
  var CLEAR = 0.1;            // s: no time tick this close after the wait's start - so a counted wait is 1.1 s or more
  var GONE = 0.5;             // s: a sound that began this long ago is forgotten
  var EPS = 1e-6;
  // The bell of a stock, by the stock: C8 twice, then G7 E7 C7 G6 E6 C6 G5 E5 - and E5 for anything above.
  var LADDER = ['', 'bell4186x2', 'bell3136', 'bell2637', 'bell2093', 'bell1568', 'bell1319', 'bell1047', 'bell784', 'bell659'];
  var FULL = 'bell523x2';     // everything is back
  function bellOf(stock) { return LADDER[stock < LADDER.length ? stock : LADDER.length - 1]; }
  var ONE = 'dry880';         // the time tick of the 'one' position
  // The bell of a readiness' pitch struck once, by its ordinary sound: the two doubles are bells of their pitch struck twice.
  function struckOnce(bell) { return bell.replace(/x2$/, ''); }
  // The sounds of a counted wait whose readiness ordinarily sounds as `bell`: its tick `s` whole seconds before the
  // end, and its final (s = 0), in the position `ticks`.
  function counted(bell, s) {
    if (ticks === 'one') return s ? ONE : bell;
    return s ? struckOnce(bell) : struckOnce(bell) + 'x2';
  }

  // signals: the firing side's count; countdown: the sounds of a wait, its final one counted; ticks: their sound.
  var on = false, signals = 3, countdown = 4, ticks = 'shot';
  var ctx = null, out = null, buffers = null;
  var told = null;            // the state last told, kept for a plan made again (an option changed, the context woke)
  var queue = [];             // what is scheduled and not yet forgotten: {key, at, src}

  function seconds() { return (win.performance && performance.now ? performance.now() : Date.now()) / 1000; }

  // Everything the rule plays for one state: [{at, id, tick, key}] in the emulation's seconds.
  function plan(state) {
    var list = [], i, s, w, t, bell, timed;
    if (!state) return list;
    // The firing side: the stock within SIGNALS.
    function fired(stock) { return stock >= 1 && stock <= signals; }
    // The way back and the end of a wait: every stock, and the low double when it is all there (a stock of one shot
    // in all is a single-shot gun's: the high double).
    function back(stock) { return stock > 1 && stock === state.full ? FULL : bellOf(stock); }
    if (state.shot !== null && state.shot !== undefined && fired(state.shot)) add(list, state.now, bellOf(state.shot), false);
    for (i = 0; i < state.waits.length; i++) {
      w = state.waits[i];
      if (!(w.at > state.now) || !(w.stock >= 1)) continue;
      // The bell of this readiness - the one its ticks count to, whether the firing side's count lets it ring or not.
      bell = w.zone ? bellOf(w.stock) : back(w.stock);
      // A counted wait: long enough for the tick one second before its end.
      timed = w.at - w.from >= WAIT_MIN - EPS && w.at - 1 >= w.from + CLEAR - EPS;
      if (timed) {
        for (s = countdown - 1; s >= 1; s--) {
          t = w.at - s;
          if (t >= w.from + CLEAR - EPS) add(list, t, counted(bell, s), true);
        }
        bell = counted(bell, 0);
      }
      // The count of SIGNALS has its say only over a readiness that comes without a countdown.
      if (!w.zone || timed || fired(w.stock)) add(list, w.at, bell, false);
    }
    for (i = 0; state.back && i < state.back.length; i++) {
      w = state.back[i];
      if (w.at > state.now && w.stock >= 1) add(list, w.at, back(w.stock), false);
    }
    return list;
  }
  function add(list, at, id, tick) {
    var key = id + '@' + Math.round(at * 1000), i;
    for (i = 0; i < list.length; i++) if (list[i].key === key) return;   // one sound at one instant, once
    list.push({at: at, id: id, tick: tick, key: key});
  }

  // The audio clock's time for the emulation's second `at`. With the context's output timestamp the sound is HEARD
  // at that second (the output's latency is in it); without one it is started at it.
  function when(at, now) {
    var base = ctx.currentTime - now, ts, b;
    if (ctx.getOutputTimestamp) {
      ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
        b = ts.contextTime - ts.performanceTime / 1000;
        if (Math.abs(b - base) < 0.5) base = b;
      }
    }
    return Math.max(0, base + at);
  }
  function start(item, now) {
    var src = ctx.createBufferSource();
    src.buffer = buffers[item.id];
    src.connect(out);
    src.start(when(item.at, now));
    queue.push({key: item.key, at: item.at, src: src});
  }
  function stop(entry) {
    try { entry.src.stop(); } catch (e) {}
    try { entry.src.disconnect(); } catch (e) {}
  }
  // The plan put in force: what is scheduled and not in it is cancelled - unless it has begun, a sound that rings is
  // let ring out - and what is in it and not scheduled is scheduled. A sound already scheduled is never touched, so
  // telling the same state twice calls nothing.
  function apply(list) {
    var now = seconds(), keep = [], i, j, entry, item, planned;
    for (i = 0; i < queue.length; i++) {
      entry = queue[i]; planned = false;
      for (j = 0; j < list.length; j++) if (list[j].key === entry.key) { list[j].have = true; planned = true; }
      if (entry.at <= now) { if (entry.at > now - GONE) keep.push(entry); }
      else if (planned) keep.push(entry);
      else stop(entry);
    }
    queue = keep;
    for (j = 0; j < list.length; j++) {
      item = list[j];
      if (item.have) continue;
      // A time tick newly planned this close ahead belongs to a wait that has just begun or has just been moved.
      if (item.tick && item.at < now + CLEAR - EPS) continue;
      start(item, now);
    }
  }
  function cancel() { apply([]); }
  function again() { if (on && ctx && ctx.state === 'running') apply(plan(told)); }

  function decode(text) {
    var bin = win.atob(text), n = bin.length >> 1, data = new Float32Array(n), i, v;
    for (i = 0; i < n; i++) {
      v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      data[i] = (v >= 32768 ? v - 65536 : v) / 32767;
    }
    return data;
  }
  // The context and the samples, made on the first switching on - a user's action, as the browsers require.
  function open() {
    var Context = win.AudioContext || win.webkitAudioContext, lib = win.BullbaAimSamples, name, data, buffer;
    if (!Context || !lib || !lib.samples || !win.atob) return false;
    try {
      ctx = new Context();
      out = ctx.createGain();
      out.gain.value = LEVEL;
      out.connect(ctx.destination);
      buffers = {};
      for (name in lib.samples) if (Object.prototype.hasOwnProperty.call(lib.samples, name)) {
        data = decode(lib.samples[name].pcm16);
        buffer = ctx.createBuffer(1, data.length, lib.rate);
        buffer.getChannelData(0).set(data);
        buffers[name] = buffer;
      }
    } catch (e) { ctx = null; out = null; buffers = null; return false; }
    return true;
  }
  function wake() {
    var p;
    if (ctx.state === 'running' || !ctx.resume) return;
    try { p = ctx.resume(); } catch (e) { return; }
    if (p && p.then) p.then(again, function () {});
  }

  win.BullbaAimSound = {
    // The switch. true: sound is on (the context exists); false: off, or this browser gives the page no sound.
    on: function (flag) {
      flag = !!flag;
      if (flag === on) return on;
      if (flag) {
        if (!ctx && !open()) return false;
        on = true;
        wake();
      } else {
        on = false; told = null;
        cancel();
        if (ctx && ctx.suspend) { try { ctx.suspend(); } catch (e) {} }
      }
      return on;
    },
    // 'signals': 2, 3 or 4; 'countdown': 3, 4 or 5; 'ticks': 'shot' or 'one'. What is scheduled follows at once.
    set: function (name, value) {
      if (name === 'signals') { value = Number(value); if (value !== 2 && value !== 3 && value !== 4 || value === signals) return; signals = value; }
      else if (name === 'countdown') { value = Number(value); if (value !== 3 && value !== 4 && value !== 5 || value === countdown) return; countdown = value; }
      else if (name === 'ticks') { if (value !== 'one' && value !== 'shot' || value === ticks) return; ticks = value; }
      else return;
      again();
    },
    // The emulation's state (the head of this file). Off, it is not even kept.
    tell: function (state) {
      if (!on) return;
      told = state;
      // A context still starting (or put to sleep by the browser) plays nothing now: the plan is made when it runs.
      if (ctx.state !== 'running') { cancel(); wake(); }
      else apply(plan(state));
      if (state) state.shot = null;   // the round's own sound is played at the round or not at all, never with a later plan
    },
    // For the page's tests: how many sounds are scheduled and have not begun.
    pending: function () {
      var now = seconds(), n = 0, i;
      for (i = 0; i < queue.length; i++) if (queue[i].at > now) n++;
      return n;
    }
  };
}());
