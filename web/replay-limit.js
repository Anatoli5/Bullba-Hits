/* THE REPLAY LIMIT ON THE PAGES (BACKLOG 107; 20.11.2026, NOTEBOOK S3: moved out of web/app.js, shared with the replay
   viewer; 20.11 the one store: ON by default, the game's file copied and left alone, kept forever = the bh_ mark removed
   from the name, nothing under the game's "all"). The mod owns the mode and the files (mod replay_library.Library; the
   page's view of it is data/replays.js: {enabled, limit, gameSetting (0 none, 1 last battle, 2 all, null unknown),
   battles {Hits battle id: 'kept'|'rolling'|'game'}, removed [id], streams [id]}); a page only shows it and
   sends a change: 'replayLimit' {on, limit} and 'replayKeep' {battleId (the HITS battle id, never a replay file's 'f-'
   id), keep}. One owner of the rules and the words for Bullba Hits (Settings > Replay limit, the battle list's star) and
   the replay viewer (Settings > Replays, the star beside the battle choice).
   kind(view, asked, id, fileOnly) -> 'kept' | 'rolling' | 'game' | 'stream' | 'removed' | 'none' | '' (the mod's word unknown);
     asked {id: {keep, at}}: a press shown at once for WAIT ms until the mod's file agrees (fileOnly: the file's word alone)
   limit(view), on(view); limitTip(view, live), keepTip(kind, n, live), offTip(reason, n, live) -> lines [title, sentence,
     point...] with the points unmarked: join(lines, mark) makes the tooltip with the page's own point mark
   paint(els, view, live, mark) shows the mode on the controls els {on, number, label}; asked(els, view) -> {on, limit}
     the controls ask for (clamped), null when that is the mode already; assume(view, want) -> the view showing it. */
(function (root) {
  'use strict';
  var WAIT = 10000, MIN = 1, MAX = 100, DEFAULT = 50;
  var HERE_KEEP = 'Here: shown only; it works in the game';
  function limit(v) { var n = v ? Math.round(Number(v.limit)) : NaN; return n >= MIN && n <= MAX ? n : DEFAULT; }
  function on(v) { return !!(v && v.enabled === true); }
  // the game's own replay setting keeps every replay: the limit does not apply
  function all(v) { return !!(v && v.gameSetting === 2); }
  function kind(v, asked, id, fileOnly) {
    if (!v) return '';
    var a = !fileOnly && asked && asked[id];
    if (a && Date.now() - a.at < WAIT) return a.keep ? 'kept' : 'rolling';
    var s = v.battles && v.battles[id]; if (s === 'kept' || s === 'rolling' || s === 'game') return s;
    if ((v.streams || []).indexOf(id) >= 0) return 'stream';
    if ((v.removed || []).indexOf(id) >= 0) return 'removed';
    return 'none';
  }
  // the title, its sentence, then the points, each with the page's mark ('• ' in Bullba Hits, '- ' in the replay viewer)
  function join(lines, mark) {
    return lines.filter(function (l) { return !!l; }).map(function (l, i) { return i < 2 ? l : (mark || '') + l; }).join('\n');
  }
  function limitTip(v, live) {
    var n = limit(v);
    return ['Replay limit', 'Keeps the replays of your last battles in the game’s replays folder, older ones removed: a third replay mode beside the game’s “last battle” and “all”.',
      'On (by default): after each battle a copy of its replay is saved as bh_date_time_vehicle_map in the game’s replays folder; the game’s own file stays as the game wrote it',
      'The oldest bh_ replays beyond the number (1 … 100, 50 by default) are removed when the next battle’s replay is added',
      'Kept forever (★): the bh_ mark is removed from the name; the replay stays in the replays folder and is never removed',
      'Replays without the bh_ name: never counted, never touched',
      'The game set to keep all replays: the limit does nothing, the game keeps every replay',
      'Off: the game’s own replay setting alone decides which replays are kept',
      live ? null : 'Here: shown only; set it in the game',
      !v ? 'Now: not known - the mod has not written its replay state yet'
        : on(v) && all(v) ? 'Now: on, but inactive - the game keeps all replays itself'
          : on(v) ? 'Now: on - the mod keeps the replays of your last ' + n + ' battles and removes older bh_ replays'
            : 'Now: off - the mod saves and removes no replays; the game’s own setting decides'];
  }
  // the battle list's star of a battle whose replay the mod holds (Bullba Hits' row; the viewer's star when it can act)
  function keepTip(k, n, live) {
    var here = live ? null : HERE_KEEP;
    if (k === 'rolling') return ['Keep this replay forever', 'Removes the bh_ mark from this battle’s replay file: it stays in the replays folder and the limit never removes it.',
      'Now: one of the last ' + n + ' replays the mod keeps', here];
    if (k === 'kept') return ['Replay kept forever', 'This battle’s replay is in the replays folder without the bh_ mark and is never removed.',
      'Click: the bh_ mark back, under the limit of the last ' + n + ' replays', 'A replay older than the last ' + n + ' then goes when the next battle’s replay is added', here];
    if (k === 'game') return ['Kept by the game', 'The game keeps all replays itself, so this battle’s replay is the game’s own file.',
      'The replay limit does not touch it'];
    if (k === 'removed') return ['Replay removed', 'The replay limit keeps the replays of the last ' + n + ' battles, and this battle is older.',
      'The battle still opens with its hits', '3D replay: only if it was prepared before'];
    return null;
  }
  // the replay viewer's star when it cannot act on the open battle: why, in the player's words
  function offTip(reason, n, live) {
    var here = live ? null : HERE_KEEP;
    if (reason === 'noBattle') return ['Keep forever', 'Choose a replay in the battle list first.', '★ in the list: kept forever by the replay limit'];
    if (reason === 'unknown') return ['Keep forever', live ? 'The mod has not told yet which replays it keeps; this button wakes up when it does.'
      : 'Which replays the mod keeps is written in the game; it has not been written here.', here];
    if (reason === 'removed') return ['Replay removed', 'The replay limit kept the replays of the last ' + n + ' battles, and this battle is older: its replay file is gone.',
      'It plays here because it was prepared before'];
    if (reason === 'keptFile') return ['Kept forever', 'This replay file was kept forever, but it belongs to no battle Bullba Hits recorded, so it cannot be put back under the limit from here.',
      'The replay limit never removes it', 'To let it go, move or delete the file by hand'];
    if (reason === 'game') return ['Kept by the game', 'The game keeps all replays itself, so this battle’s replay is the game’s own file.',
      'The replay limit does not touch it'];
    if (reason === 'file') return ['Not under the replay limit', 'This replay was not saved by the replay limit, so the mod does not move or remove it.',
      'It stays in the game’s replays folder under its own name, as the game or you left it',
      'The limit takes only the replays of your own battles that Bullba Hits recorded while the limit was on'];
    if (reason === 'stream') return ['No replay file kept', 'The replay limit holds no replay file of this battle, so there is nothing to keep.',
      'It plays here from the copy of the battle the mod made at the time'];
    return ['No replay file kept', 'The replay limit holds no replay file of this battle, so there is nothing to keep.',
      'The limit was off for this battle, or its replay file was moved or removed'];
  }
  function paint(els, v, live, mark) {
    var n = limit(v), enabled = on(v);
    if (document.activeElement !== els.number) els.number.value = String(n);
    els.on.checked = enabled; els.on.disabled = !live; els.number.disabled = !live || !enabled;
    if (els.label) els.label.title = join(limitTip(v, live), mark);
  }
  function asked(els, v) {
    var n = Math.round(Number(els.number.value)), enabled = !!els.on.checked;
    if (!isFinite(n) || els.number.value === '') n = limit(v);
    n = Math.max(MIN, Math.min(MAX, n)); els.number.value = String(n);
    if (n === limit(v) && enabled === on(v)) return null;
    return { on: enabled, limit: n };
  }
  // shown at once; the mod's file says it again
  function assume(v, want) { v = v || { battles: {}, removed: [], streams: [] }; v.limit = want.limit; v.enabled = want.on; return v; }
  root.BullbaReplayLimit = { WAIT: WAIT, kind: kind, limit: limit, on: on, all: all, join: join, limitTip: limitTip, keepTip: keepTip, offTip: offTip,
    paint: paint, asked: asked, assume: assume };
})(window);
