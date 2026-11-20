/* THE REPLAY LIMIT ON THE PAGES (BACKLOG 107; 20.11.2026, NOTEBOOK S3: moved out of web/app.js, shared with the replay
   viewer). The mod owns the mode and the files (mod replay_library.Library; the page's view of it is data/replays.js:
   {enabled, limit, battles {Hits battle id: 'kept'|'rolling'}, removed [id], streams [id]}); a page only shows it and
   sends a change: 'replayLimit' {on, limit} and 'replayKeep' {battleId (the HITS battle id, never a replay file's 'f-'
   id), keep}. One owner of the rules and the words for Bullba Hits (Settings > Replay limit, the battle list's star) and
   the replay viewer (Settings > Replays, the star beside the battle choice).
   kind(view, asked, id, fileOnly) -> 'kept' | 'rolling' | 'stream' | 'removed' | 'none' | '' (the mod's word unknown);
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
  function kind(v, asked, id, fileOnly) {
    if (!v) return '';
    var a = !fileOnly && asked && asked[id];
    if (a && Date.now() - a.at < WAIT) return a.keep ? 'kept' : 'rolling';
    var s = v.battles && v.battles[id]; if (s === 'kept' || s === 'rolling') return s;
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
    return ['Replay limit', 'Keeps the replays of your last battles in the game’s replays folder, older ones removed: a recording mode beside the game’s “last battle” and “all”.',
      'Where: the game’s replays folder; replays kept forever in replays/bullba_hits',
      'On: each battle’s replay is renamed bh_date_time_vehicle_map; the oldest bh_ replays beyond the number (1 … 100, 50 by default) go when the next battle’s replay is added',
      'Kept forever (★ in the battle list): moved to replays/bullba_hits, never removed',
      'Replays without the bh_ name: never counted, never touched', 'A bh_ replay you rename stops being the mod’s',
      'Off: the game’s own replay setting (last battle or all) decides which replays are kept',
      live ? null : 'Here: shown only; set it in the game',
      !v ? 'Now: not known - the mod has not written its replay state yet'
        : on(v) ? 'Now: on - the mod keeps the replays of your last ' + n + ' battles and removes older bh_ replays'
          : 'Now: off - the mod is not managing replays and removes nothing; the game’s own setting decides'];
  }
  // the battle list's star of a battle whose replay the mod holds (Bullba Hits' row; the viewer's star when it can act)
  function keepTip(k, n, live) {
    var here = live ? null : HERE_KEEP;
    if (k === 'rolling') return ['Keep this replay forever', 'Moves this battle’s replay to replays/bullba_hits, where the limit never removes it.',
      'Now: one of the last ' + n + ' replays the mod keeps', here];
    if (k === 'kept') return ['Replay kept forever', 'This battle’s replay stays in replays/bullba_hits and is never removed.',
      'Click: back to the replays folder, under the limit of the last ' + n + ' replays', 'A replay older than the last ' + n + ' then goes when the next battle’s replay is added', here];
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
    if (reason === 'keptFile') return ['Kept in replays/bullba_hits', 'This replay file is in the keep-forever folder, but it belongs to no battle Bullba Hits recorded, so it cannot be moved back from here.',
      'The replay limit never removes it', 'To let it go, move or delete the file by hand'];
    if (reason === 'file') return ['Not under the replay limit', 'This replay was not saved by the replay limit, so the mod does not move or remove it.',
      'It stays in the game’s replays folder under its own name, as the game or you left it',
      'The limit takes only the replays of your own battles that Bullba Hits recorded while the limit was on'];
    if (reason === 'stream') return ['No replay file kept', 'The replay limit holds no replay file of this battle, so there is nothing to keep.',
      'It plays here from the copy of the battle the mod made at the time'];
    return ['No replay file kept', 'The replay limit holds no replay file of this battle, so there is nothing to keep.',
      'The limit was off for this battle, or its replay file was renamed or moved'];
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
  root.BullbaReplayLimit = { WAIT: WAIT, kind: kind, limit: limit, on: on, join: join, limitTip: limitTip, keepTip: keepTip, offTip: offTip,
    paint: paint, asked: asked, assume: assume };
})(window);
