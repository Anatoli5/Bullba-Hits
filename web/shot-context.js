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
    var tracer=matches.length===1?matches[0]:null,command=tracer&&tracer.own?events.find(function(e){return e.event==='command'&&e.id===tracer.possibleCommandId;}):null;
    var aim=command&&command.aim||tracer&&tracer.own&&tracer.aimAtTracer||null;
    var kindValues=Array.from(new Set(points.map(function(p){return p.shellKind||kinds[p.shellType];}).filter(Boolean)));
    var recorded=(hit.shellCandidates||[]).slice(),choices=(hit.availableShells||recorded).slice();
    var matching=recorded.filter(function(c){return (kindValues.length===0||kindValues.length===1&&c.kind===kindValues[0])&&points.every(function(p){return !(p.caliber>0)||Math.abs(c.caliber-p.caliber)<.1;});});
    if(matching.length>1&&tracer&&tracer.velocity){var speed=Math.hypot.apply(null,tracer.velocity),narrow=matching.filter(function(c){return c.speed>0&&Math.abs(c.speed-speed)<Math.max(.1,c.speed*.001);});if(narrow.length===1)matching=narrow;}
    var selected=matching.length===1?matching[0]:null;
    if(selected&&!choices.some(function(c){return same(c,selected);}))choices.push(selected);
    var index=selected?choices.findIndex(function(c){return same(c,selected);}):-1;
    var marker=aim&&aim.clientMarker,stamp=command?command.receivedAt:tracer&&tracer.receivedAt;
    if(!marker||!(marker.diameter>0)||!marker.position||!marker.direction||!Number.isFinite(marker.receivedAt)||Math.abs(stamp-marker.receivedAt)>.5)aim=null;
    return {choices:choices,index:index,kind:kindValues.length===1?kindValues[0]:null,tracer:tracer,command:command,aim:aim,
      range:tracer&&world.length?distance(tracer.origin,world[0]):null,
      source:index<0?'Снаряд не определён однозначно':kindValues.length?'Тип и калибр из попадания; характеристики орудия из клиента':'Единственный снаряд с этим эффектом в записи'};
  }
  root.ArmorShotContext={resolve:resolve};
}(typeof window==='undefined'?globalThis:window));
