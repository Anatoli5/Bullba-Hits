/* Interpret recorded evidence without changing the original battle files. */
(function(root){
  'use strict';
  // Client 2.4 SHELL_TYPES_LIST; new records also carry shellKind explicitly.
  var kinds=['HOLLOW_CHARGE','HIGH_EXPLOSIVE','ARMOR_PIERCING','ARMOR_PIERCING_HE','ARMOR_PIERCING_CR','SMOKE'];
  function point(m,p){return [0,1,2].map(function(i){return m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12];});}
  function distance(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);}
  function same(a,b){return a.kind===b.kind&&a.name===b.name&&a.caliber===b.caliber&&a.penetration100===b.penetration100&&a.speed===b.speed;}
  function resolve(hit,events){
    var target=hit.target||{},parts=target.parts||[],points=hit.points||[],world=[];
    if(target.worldTransform)points.forEach(function(p){var part=parts.find(function(v){return v.id===p.part;});if(p.status==='resolved'&&p.position&&part&&part.transform)world.push(point(target.worldTransform,point(part.transform,p.position)));});
    var possible=events.filter(function(e){return e.event==='tracer'&&!e.isRicochet&&e.gunInstallationIndex===0&&e.shooterId===hit.attackerId&&e.effectsIndex===hit.effectsIndex&&e.receivedAt<=hit.receivedAt&&hit.receivedAt-e.receivedAt<10;});
    // Damage callback lacks shotId. Accept only one endpoint close in BOTH space
    // and time; do not associate an arbitrary newest tracer during a burst.
    var matches=possible.filter(function(t){return events.some(function(e){return e.tracerId===t.id&&e.position&&Math.abs(e.receivedAt-hit.receivedAt)<=.1&&world.some(function(p){return distance(e.position,p)<=.75;});});});
    // A salvo fires several own tracers from one command; the second shell has no command of its own.
    function commandOf(t){if(!t||!t.own)return null;var own=events.find(function(e){return e.event==='command'&&e.id===t.possibleCommandId;});if(own)return own;
      var before=events.filter(function(e){return e.event==='command'&&e.shooterId===t.shooterId&&e.receivedAt<=t.receivedAt&&t.receivedAt-e.receivedAt<=1.5;});return before.length?before[before.length-1]:null;}
    var sameCommand=matches.length>1&&matches.every(function(t){return t.own;})&&matches.every(function(t){var c=commandOf(t);return c&&c===commandOf(matches[0]);});
    var tracer=matches.length===1?matches[0]:sameCommand?matches.slice().sort(function(a,b){return b.receivedAt-a.receivedAt;})[0]:null,command=commandOf(tracer);
    // Each aim snapshot is judged against the receipt time of its own source:
    // a stale or incomplete command snapshot must not hide a usable aimAtTracer.
    function usable(aim,stamp,window){var m=aim&&aim.clientMarker;return !!(m&&m.diameter>0&&m.position&&m.direction&&Number.isFinite(m.receivedAt)&&Number.isFinite(stamp)&&Math.abs(stamp-m.receivedAt)<=window);}
    var sources=[];if(command&&command.aim)sources.push({aim:command.aim,from:'command',stamp:command.receivedAt,window:.5});if(tracer&&tracer.own&&tracer.aimAtTracer)sources.push({aim:tracer.aimAtTracer,from:'tracer',stamp:tracer.receivedAt,window:.5});
    // The salvo's second shell leaves up to ~1.5 s after the command; its snapshot is the aim at the first shell.
    if(command&&command.aim&&tracer)sources.push({aim:command.aim,from:'salvo',stamp:tracer.receivedAt,window:1.5});
    var chosen=sources.find(function(s){return usable(s.aim,s.stamp,s.window);})||null,aim=chosen?chosen.aim:null;
    var aimReason=aim?null:!possible.length?'no-tracer':!matches.length?'no-endpoint':!tracer?'ambiguous':!tracer.own?'foreign':!sources.length?'no-snapshot':'stale';
    var kindValues=Array.from(new Set(points.map(function(p){return p.shellKind||kinds[p.shellType];}).filter(Boolean)));
    // shellCandidates is what the record narrowed down; when it is empty (39 of 181 unresolved hits in the
    // 60 recorded battles, 22.09) the shells the shooter could load are the only list there is, and a single
    // one of them that agrees with the hit is an answer, not a blank.
    var recorded=((hit.shellCandidates&&hit.shellCandidates.length?hit.shellCandidates:hit.availableShells)||[]).slice();
    var choices=(hit.availableShells||hit.shellCandidates||[]).slice();
    var matching=recorded.filter(function(c){return (kindValues.length===0||kindValues.length===1&&c.kind===kindValues[0])&&points.every(function(p){return !(p.caliber>0)||Math.abs(c.caliber-p.caliber)<.1;});});
    if(matching.length>1&&tracer&&tracer.velocity){var speed=Math.hypot.apply(null,tracer.velocity),narrow=matching.filter(function(c){return c.speed>0&&Math.abs(c.speed-speed)<Math.max(.1,c.speed*.001);});if(narrow.length===1)matching=narrow;}
    var selected=matching.length===1?matching[0]:null;
    if(selected&&!choices.some(function(c){return same(c,selected);}))choices.push(selected);
    var index=selected?choices.findIndex(function(c){return same(c,selected);}):-1;
    var range=tracer&&Array.isArray(tracer.origin)&&world.length?distance(tracer.origin,world[0]):null,rangeSource='tracer';
    if(!(Number.isFinite(range)&&range>0)){range=Number.isFinite(hit.rangeAtImpact)&&hit.rangeAtImpact>0?hit.rangeAtImpact:null;rangeSource=range===null?null:'impact';}
    return {choices:choices,index:index,kind:kindValues.length===1?kindValues[0]:null,tracer:tracer,command:command,aim:aim,aimSource:chosen?chosen.from:null,aimReason:aimReason,
      range:range,rangeSource:rangeSource,
      source:index<0?'Shell not determined unambiguously':kindValues.length?'Type and calibre from the hit; gun data from the client':'The only shell with this effect in the record'};
  }
  root.ArmorShotContext={resolve:resolve};
}(typeof window==='undefined'?globalThis:window));
