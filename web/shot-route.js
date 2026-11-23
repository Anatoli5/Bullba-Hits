/* Shot links use server gameTime and participants, plus the game's tracer ID
   when present. A nearby shot is never an acceptable ambiguity fallback. */
(function () {
  'use strict';
  function parse(value) {
    var p = String(value || '').split(',');
    if (p.length < 4 || p.slice(0, 4).some(function (x) { return x === '' || !Number.isFinite(Number(x)); })) return null;
    var out = {at:Number(p[0]),attacker:Number(p[1]),target:Number(p[2]),focus:Number(p[3])};
    if (p.length > 6 || p[4] && !/^\d+$/.test(p[4]) || p[5] && !/^\d+$/.test(p[5])) return null;
    if (p[4]) out.shotId = p[4];
    if (p[5]) out.shotIndex = Number(p[5]);
    return out;
  }
  function encode(route) {
    var fields = [route.at, route.attacker, route.target, route.focus];
    if (route.shotId != null || route.shotIndex != null) fields.push(route.shotId == null ? '' : String(route.shotId));
    if (route.shotIndex != null) fields.push(route.shotIndex);
    return fields.join(',');
  }
  function match(rows, route, serverStart) {
    if (!route || !Number.isFinite(serverStart)) return {row:null,reason:'The replay has no usable shot time reference.'};
    var at = route.at - serverStart, groups = {}, exact = {};
    rows.forEach(function (row) {
      var shot = row.shot;
      if (route.shotId != null && (!shot || shot.shotId == null || String(shot.shotId) !== String(route.shotId))) return;
      if (route.shotId == null && route.shotIndex != null && (!shot || shot.index !== route.shotIndex)) return;
      row.hits.forEach(function (hit) {
        var gap = Math.abs(hit.t - at);
        if (hit.attacker !== route.attacker || hit.target !== route.target || gap > .5) return;
        var key = shot ? 's:' + shot.index : 'h:' + hit.index;
        groups[key] = row;
        if (gap <= .002) exact[key] = row;
      });
    });
    var keys = Object.keys(exact), pool = keys.length ? exact : groups;
    keys = Object.keys(pool);
    return keys.length === 1 ? {row:pool[keys[0]],reason:null} : {row:null,reason:keys.length ? 'Several recorded shots match this link; no neighbouring shot was selected.' : 'This recorded shot is not available in the replay; no neighbouring shot was selected.'};
  }
  var api = {parse:parse,encode:encode,match:match};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BullbaShotRoute = api;
}());
