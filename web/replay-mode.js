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
  function evidence(row) {
    if (!row || typeof row !== 'object') return { known: false, special: null };
    var saved = row.special && typeof row.special === 'object' ? row.special : {};
    var mode = row.mode && typeof row.mode === 'object' ? row.mode : {};
    var bonus = row.battleType != null ? row.battleType : row.bonusType != null ? row.bonusType : mode.bonusType != null ? mode.bonusType : saved.bonusType;
    var gameplay = row.gameplay || row.gameplayName || mode.gameplayName || mode.gameplay || saved.gameplay;
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
  var api = { policy: POLICY, classify: classify, evidence: evidence, resolve: resolve, opening: opening };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BullbaReplayMode = api;
}());
