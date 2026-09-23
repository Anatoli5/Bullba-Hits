/* Client snapshots and received tracer geometry. No inferred enemy reticle. */
(function(root){
  'use strict';
  function dot(a,b){return a.reduce(function(s,v,i){return s+v*b[i];},0);}
  function sub(a,b){return a.map(function(v,i){return v-b[i];});}
  function unit(a){var n=Math.sqrt(dot(a,a));return n>1e-9?a.map(function(v){return v/n;}):null;}
  function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function project(tracer,command){
    var marker=command&&command.aim&&command.aim.clientMarker;
    if(!marker||!(marker.diameter>0)||!tracer.origin||!tracer.velocity)return null;
    var n=unit(marker.direction);if(!n)return null;var g=[0,-tracer.gravity,0],a=.5*dot(g,n),b=dot(tracer.velocity,n),c=dot(sub(tracer.origin,marker.position),n),t;
    if(Math.abs(a)<1e-9){if(Math.abs(b)<1e-9)return null;t=-c/b;}else{var discriminant=b*b-4*a*c;if(discriminant<0)return null;var roots=[(-b-Math.sqrt(discriminant))/(2*a),(-b+Math.sqrt(discriminant))/(2*a)].filter(function(v){return v>=0;});if(!roots.length)return null;t=Math.min.apply(null,roots);}
    if(!Number.isFinite(t)||t<0||t>60)return null;
    var point=tracer.origin.map(function(v,i){return v+tracer.velocity[i]*t+.5*g[i]*t*t;}),right=unit(cross(Math.abs(n[1])>.98?[1,0,0]:[0,1,0],n)),up=cross(n,right),delta=sub(point,marker.position),radius=marker.diameter/2;
    return {x:dot(delta,right)/radius,y:dot(delta,up)/radius,time:t,radius:radius};
  }
  var events=[],byId={},select;
  function text(value){var p=document.createElement('div');p.textContent=value;document.getElementById('telemetry-details').appendChild(p);}
  function format(value){return Number.isFinite(value)?value.toFixed(2):'no data';}
  function coords(v){return Array.isArray(v)?v.map(format).join(', '):'no data';}
  function show(){
    var record=byId[select.value],box=document.getElementById('telemetry-details'),plot=document.getElementById('telemetry-plot');box.replaceChildren();plot.replaceChildren();plot.hidden=true;if(!record){text(events.length?'No own shots in the chosen group for this battle. Other tracers are in the “All received tracers” list.':'This battle has no recorded aim data. Updating the viewer does not recover it for an old record.');return;}
    var tracer=record.event==='tracer'?record:null,command=record.event==='command'?record:byId[record.possibleCommandId],aim=command&&command.aim;
    if(tracer){text((tracer.own?'Own':'Foreign, received by the client')+' tracer · ID '+tracer.shotId+' · calibre '+format(tracer.caliber)+' mm'+(tracer.isRicochet?' · after a ricochet':''));text('Origin, world coordinates: '+coords(tracer.origin)+' m · speed: '+format(Math.sqrt(dot(tracer.velocity,tracer.velocity)))+' m/s');var end=events.filter(function(e){return e.tracerId===tracer.id;}).pop();if(end)text('End point: '+coords(end.position)+' m · straight segment length '+format(end.segmentDistance)+' m. This is not the curved trajectory length.');if(command)text('The reticle below is linked to the tracer only through the single recent command. The exact server link is not confirmed.');else text(tracer.own?'This tracer has no unambiguous link to an aiming command.':'The enemy reticle and current aiming were not received; they are not derived from the tracer.');}
    if(aim){
      text('Own command snapshot: '+new Date(command.receivedAt*1000).toLocaleTimeString('en-GB')+' · a command does not guarantee that a shot was fired.');
      text('Crosshair point in the world: '+coords(aim.desiredPoint));
      if(aim.clientMarker)text('Client marker: '+coords(aim.clientMarker.position)+' · diameter '+format(aim.clientMarker.diameter)+' m · snapshot age '+Math.max(0,Math.round((command.receivedAt-aim.clientMarker.receivedAt)*1000))+' ms');
      if(aim.serverMarker)text('Last server marker: diameter '+format(aim.serverMarker.diameter)+' m · age '+Math.max(0,Math.round((command.receivedAt-aim.serverMarker.receivedAt)*1000))+' ms');
      if(aim.lastServerGunUpdate)text('Last server update: dispersion '+format(aim.lastServerGunUpdate.dispersionAngle*100)+' m at 100 m · age '+Math.max(0,Math.round((command.receivedAt-aim.lastServerGunUpdate.receivedAt)*1000))+' ms');
      else text('No server gun update received. The mod does not change the server reticle settings.');
      if(aim.dispersionAngles&&Number.isFinite(aim.dispersionAngles[0])){var radius=aim.dispersionAngles[0]*100;text('Current aiming: radius '+format(radius)+' m at 100 m');var button=document.createElement('button');button.textContent='Use this dispersion in the nominal estimate';button.onclick=function(){var input=document.getElementById('spread-radius');input.value=radius.toFixed(4);input.dispatchEvent(new Event('input'));};box.appendChild(button);}
      if(aim.selectedShell)text('Shell selected at the command: '+aim.selectedShell.name+' · '+format(aim.selectedShell.penetration100)+' / '+format(aim.selectedShell.penetration500)+' mm at 50 / 500 m');
      if(aim.vehicleSpeeds)text('Vehicle speeds: '+coords(aim.vehicleSpeeds));
      if(aim.unavailable&&aim.unavailable.length)text('Fields not received: '+aim.unavailable.join(', '));
      if(tracer){var offset=project(tracer,command);if(offset){text('Trajectory in the client marker plane: '+format(Math.hypot(offset.x,offset.y)*100)+'% of the radius from the centre. Gravity is included; command and tracer snapshots refer to different moments.');var extent=Math.max(1.4,Math.abs(offset.x)+.2,Math.abs(offset.y)+.2);plot.setAttribute('viewBox',[-extent,-extent,extent*2,extent*2].join(' '));function shape(name,attrs){var node=document.createElementNS('http://www.w3.org/2000/svg',name);Object.keys(attrs).forEach(function(k){node.setAttribute(k,attrs[k]);});plot.appendChild(node);}shape('circle',{cx:0,cy:0,r:1,fill:'none',stroke:'#eac36e','stroke-width':.015});shape('path',{d:'M -.12 0 H .12 M 0 -.12 V .12',fill:'none',stroke:'#96a9bd','stroke-width':.015});shape('circle',{cx:offset.x,cy:-offset.y,r:.04,fill:'#68d7be'});plot.hidden=false;}}
    }
  }
  function rowsFor(values,ownOnly){
    var linked=new Set();values.forEach(function(e){if(e.event==='tracer'&&e.own&&e.possibleCommandId)linked.add(e.possibleCommandId);});
    return values.filter(function(e){if(e.event!=='command'&&e.event!=='tracer')return false;if(!ownOnly)return true;return e.event==='command'?!linked.has(e.id):e.own;}).slice(-300).reverse();
  }
  function populate(){
    select.replaceChildren();var rows=rowsFor(events,document.getElementById('telemetry-filter').value==='own');
    rows.forEach(function(e){var option=document.createElement('option');option.value=e.id;option.textContent=new Date(e.receivedAt*1000).toLocaleTimeString('en-GB')+' · '+(e.event==='command'?'Own fire command':e.own?'Own shot'+(e.possibleCommandId?' · has a reticle snapshot':''):'Visible foreign tracer')+(e.isRicochet?' · ricochet':'')+' · '+e.id;select.appendChild(option);});
    if(!rows.length){var empty=document.createElement('option');empty.textContent='No shot details';select.appendChild(empty);}
    else{var preferred=rows.find(function(e){return e.own&&e.possibleCommandId&&!e.isRicochet;});select.value=(preferred||rows[0]).id;}
    show();
  }
  function load(values){
    events=values;byId=Object.create(null);values.forEach(function(e){byId[e.id]=e;});select=document.getElementById('telemetry-shot');
    var commands=values.filter(function(e){return e.event==='command';}),own=values.filter(function(e){return e.event==='tracer'&&e.own&&!e.isRicochet;}),snapshots=commands.filter(function(e){return e.aim&&e.aim.clientMarker;});
    document.getElementById('telemetry-summary').textContent='This battle: own commands — '+commands.length+', own tracers without ricochet — '+own.length+', client reticle snapshots — '+snapshots.length+'.';
    document.getElementById('telemetry-filter').onchange=populate;select.onchange=show;populate();
  }
  root.ArmorShotTelemetry={load:load,project:project,rowsFor:rowsFor};
}(typeof window==='undefined'?globalThis:window));
