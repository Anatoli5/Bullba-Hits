/* Replay-mode classification. POLICY is generated from replay_files.py's current
   constants; tests/test_replay_modes.py guards equivalence. The shipped snapshot
   works with old index/prepared files before any runtime feed is regenerated. */
(function () {
  'use strict';
  var POLICY = {
  "gameplayNames": {
    "bootcamp": "Boot camp",
    "ctf30x30": "Grand Battle",
    "domination30x30": "Grand Battle",
    "epic": "Frontline",
    "maps_training": "Maps training"
  },
  "specialNames": {
    "24": "Grand Battle",
    "25": "Grand Battle training",
    "27": "Frontline",
    "28": "Frontline training",
    "29": "Steel Hunter",
    "30": "Steel Hunter",
    "34": "Steel Hunter tournament",
    "35": "Steel Hunter tournament",
    "100": "Story mode",
    "104": "Story mode"
  },
  "standardBonus": {
    "1": "Random battle",
    "2": "Training room",
    "4": "Tournament",
    "5": "Clan battle",
    "7": "Team battle",
    "13": "Global Map",
    "14": "Tournament",
    "15": "Clan tournament",
    "20": "Stronghold",
    "21": "Stronghold",
    "22": "Ranked battle",
    "31": "Tournament",
    "37": "Mapbox",
    "43": "Onslaught",
    "44": "Winback",
    "46": "Random battle",
    "47": "Onslaught tournament",
    "48": "Onslaught training",
    "49": "Onslaught Light"
  },
  "standardGameplay": [
    "ctf",
    "domination",
    "assault",
    "comp7"
  ]
}; // policy-end
  function bonusOf(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  function classify(bonus, gameplay) {
    bonus = bonusOf(bonus);
    gameplay = typeof gameplay === 'string' && gameplay ? gameplay : null;
    var oddBonus = bonus != null && !Object.prototype.hasOwnProperty.call(POLICY.standardBonus, String(bonus));
    var oddGameplay = gameplay != null && POLICY.standardGameplay.indexOf(gameplay) < 0;
    if (!oddBonus && !oddGameplay) return null;
    return {
      name: POLICY.specialNames[bonus] || POLICY.gameplayNames[gameplay] || (oddBonus ? 'battle type ' + bonus : 'gameplay ' + gameplay),
      bonusType: bonus, gameplay: gameplay
    };
  }
  // a row's battle type and gameplay, whichever of its shapes carries them (a file entry, an index row, a record's mode,
  // a saved special mark)
  function fields(row) {
    var saved = row.special && typeof row.special === 'object' ? row.special : {};
    var mode = row.mode && typeof row.mode === 'object' ? row.mode : {};
    return { bonus: row.battleType != null ? row.battleType : row.bonusType != null ? row.bonusType : mode.bonusType != null ? mode.bonusType : saved.bonusType,
      gameplay: row.gameplay || row.gameplayName || mode.gameplayName || mode.gameplay || saved.gameplay };
  }
  function evidence(row) {
    if (!row || typeof row !== 'object') return { known: false, special: null };
    var f = fields(row), bonus = f.bonus, gameplay = f.gameplay;
    if (bonusOf(bonus) != null) return { known: true, special: classify(bonus, gameplay), authoritative: true };
    // Explicit null is an ordinary classification; mere row existence is not.
    if (Object.prototype.hasOwnProperty.call(row, 'special') && (row.special === null || typeof row.special === 'object')) return { known: true, special: row.special, authoritative: true };
    if (typeof gameplay === 'string' && gameplay) {
      var special = classify(null, gameplay);
      // Common gameplay alone is not proof of ordinary mechanics: an event
      // tournament may also use ctf. Keep it as a fallback, allowing a lower
      // source with a positive event ID to supply the missing classification.
      return { known: true, special: special, authoritative: !!special };
    }
    return { known: false, special: null };
  }
  function resolve(id, files, index, prepared) {
    var candidates = (files || []).filter(function (row) { return row.id === id || row.battle === id; });
    if (prepared && prepared.id === id && prepared.record) candidates.push(prepared.record);
    (index || []).forEach(function (row) { if (row.id === id) candidates.push(row); });
    var partial = null;
    for (var i = 0; i < candidates.length; i++) {
      var result = evidence(candidates[i]);
      if (result.known && result.authoritative) return { known: true, special: result.special };
      if (result.known && !partial) partial = result;
    }
    return partial ? { known: true, special: partial.special } : { known: false, special: null };
  }
  // What the opening warns about (22.11, NOTEBOOK Y15): `prepared` is false before the battle's playback file exists. A
  // battle with no evidence yet (an index row written before rows carried the mode) is not warned about then - its
  // prepared file (the mod's own classification from the arena's bonus type) decides before anything is decoded; only
  // a prepared battle still without evidence is 'Unidentified mode'. Returns the special mode to warn about, or null.
  function opening(resolved, prepared) {
    if (resolved && resolved.known) return resolved.special || null;
    return prepared ? { name: 'Unidentified mode' } : null;
  }
  // 23.11: a battle tile's figures from a replay file's entry (the mod's replay_files: header fields and `results`, the
  // results block's raw outcome) and the table of the client's battle modes (web/battle-modes.js, BULLBA_BATTLE_MODES:
  // tools/build_battle_modes.py - each bonus type's and GUI type's client name, a bonus type's abbr). Nothing is guessed:
  // a field the entry lacks is null. Format or tag follow the data: a battle of two teams shows its players per team; any
  // other (one team, every player on their own, squads, a place-based result) shows its mode's tag.
  //   name    the client's name of the bonus type, of the GUI type (the loading screen's), this policy's, 'Battle type N'.
  //           The bonus type's first: the client's loading-screen text of Grand Battle's GUI type is 'Random Battle'.
  //   format  '15×15' / '14×15' - players per team in team order, as recorded; null when not two teams or no results
  //   tag     the table's abbr of the bonus type; 'FM' for a mode the table lacks (a client newer than the table);
  //           tagName and tagWords its tooltip
  //   result  'victory' / 'defeat' / 'draw' / null: the winning team against the player's, a place-based result's 1st
  //           place a victory; place, places the player's place and the number of places (teams)
  function own(object, key) { return object && key != null && Object.prototype.hasOwnProperty.call(object, String(key)) ? object[String(key)] : null; }
  function modesTable() {
    return typeof window !== 'undefined' && window.BULLBA_BATTLE_MODES || typeof globalThis !== 'undefined' && globalThis.BULLBA_BATTLE_MODES || null;
  }
  function summary(entry, modes) {
    entry = entry || {}; modes = modes || modesTable() || {};
    var results = entry.results && typeof entry.results === 'object' ? entry.results : null;
    var f = fields(entry), bonus = bonusOf(f.bonus), gameplay = f.gameplay, special = classify(bonus, gameplay);
    var row = own(modes.bonus, bonus) || {}, gui = own(modes.gui, results && results.guiType) || {};
    var known = row.name || gui.name || own(POLICY.specialNames, bonus) || own(POLICY.gameplayNames, gameplay) || own(POLICY.standardBonus, bonus);
    var out = { name: known || (bonus != null ? 'Battle type ' + bonus : null), special: special, format: null, tag: null,
      tagName: null, tagWords: null, result: null, place: null, places: null,
      damage: results && isFinite(results.damageDealt) ? results.damageDealt : null,
      kills: results && isFinite(results.kills) ? results.kills : null };
    if (!results) return out;
    var teams = results.teams && typeof results.teams === 'object' ? Object.keys(results.teams).map(Number).filter(Number.isInteger).sort(function (a, b) { return a - b; }) : [];
    var sizes = teams.map(function (t) { return results.teams[String(t)]; });
    var placed = Number.isInteger(results.place) && results.place > 0;
    if (teams.length === 2 && !placed) out.format = sizes.join('×');
    else if (teams.length || placed) {
      out.tag = typeof row.abbr === 'string' && row.abbr ? row.abbr : 'FM'; out.tagName = out.name || 'Fun mode';
      var solo = sizes.every(function (n) { return n === 1; }), even = sizes.every(function (n) { return n === sizes[0]; });
      out.tagWords = !teams.length ? 'A battle of places.' : teams.length === 1 ? 'One team of ' + sizes[0] + '.' :
        solo ? teams.length + ' players, each on their own.' : even ? teams.length + ' squads of ' + sizes[0] + '.' :
        teams.length + ' teams: ' + sizes.join(', ') + ' players.';
    }
    if (placed) {
      out.place = results.place; out.places = teams.length || null;
      out.result = results.place === 1 ? 'victory' : 'defeat';
    } else if (Number.isInteger(results.winnerTeam) && Number.isInteger(results.team)) {
      out.result = results.winnerTeam === 0 ? 'draw' : results.winnerTeam === results.team ? 'victory' : 'defeat';
    }
    return out;
  }
  var RESULT_WORDS = { victory: 'Victory', defeat: 'Defeat', draw: 'Draw' };
  // the result in words: 'Victory', 'Defeat', 'Draw', a place-based mode's '1st place of 20' / 'Place 3 of 20'; '' unknown
  function resultWords(s) {
    if (!s || !s.result) return '';
    if (s.place) return (s.place === 1 ? 'Victory: 1st place' : 'Defeat: place ' + s.place) + (s.places ? ' of ' + s.places : '');
    return RESULT_WORDS[s.result];
  }
  var api = { policy: POLICY, classify: classify, evidence: evidence, resolve: resolve, opening: opening,
    summary: summary, resultWords: resultWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BullbaReplayMode = api;
}());
