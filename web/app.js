(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
  var shellNames={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'},candidates=[],activeHit=null,shotContext=null,manualPen='',lastDistance=null,analysisKey=null;
  // web/host.js: game-host flag, breadcrumb-guarded heavy handlers. Absent in isolated tests.
  var host=window.BullbaHost||{game:false,interrupted:null,guard:function(action,fn){return fn;},done:function(){}};
  var aimReasons={'no-tracer':'No own tracer','no-endpoint':'Tracer did not match the hit point','ambiguous':'Several tracers — the link is ambiguous','foreign':'Someone else’s shot','no-snapshot':'Reticle snapshot not recorded','stale':'Reticle snapshot is stale'};
  function staleEstimate(){if(analysisKey!==null){$('spread-result').textContent='Conditions changed. Press “Estimate” again.';analysisKey=null;}if(viewer)viewer.hideSpread();}
  function node(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function message(text){$('scene-message').textContent=text;$('scene-message').hidden=!text;}
  function warnings(lines){$('warnings').textContent=lines.map(function(line){return line==='Additional vehicle parts are not yet rendered'?'Extra parts of this vehicle are not shown and not included in the estimate.':line;}).join(' · ');$('warnings').hidden=!lines.length;}
  function result(hit){if(hit.damage>0)return 'Damage '+hit.damage+' HP';var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;});return p.length?(effects[p[p.length-1].effect]||'Result '+p[p.length-1].effect):'Result not decoded';}
  function resultIcon(hit){if(hit.damage>0)return '▰ −'+hit.damage;var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;}),effect=p.length?p[p.length-1].effect:null;return effect===2||effect===1?'↪':effect===3?'▰ ×':effect===4?'▰ ✓':effect===5||effect===6?'⚙':effect===0?'▰ 0':'—';}
  function resultVisual(container,hit){
    container.replaceChildren();container.classList.add('result-visual');container.title=result(hit);
    var symbol=node('span');symbol.innerHTML='<svg class="damage-icon" viewBox="0 0 28 20" aria-hidden="true"><path d="M5 11h17l3 3-2 3H5l-3-3ZM9 10V6h9l3 4M18 7h8M7 14h13"/></svg>';
    container.appendChild(symbol);container.appendChild(node('span',resultIcon(hit).replace(/▰ ?/,'')));
  }
  function clock(seconds){if(!Number.isFinite(seconds))return '—';var d=new Date(seconds*1000);return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function detail(label,value,small){var e=node('div');e.appendChild(node('div',label,'detail-label'));e.appendChild(node('div',String(value),'detail-value'));if(small)e.appendChild(node('div',small,'detail-small'));$('details').appendChild(e);}
  function prepareShell(hit){
    activeHit=hit;shotContext=ArmorShotContext.resolve(hit,current&&current.shotEvents||[]);candidates=shotContext.choices;var choice=$('shell-choice');choice.replaceChildren();
    candidates.forEach(function(c,i){var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name);o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — manual');o.value=kind;choice.appendChild(o);});
    if(candidates.length>1){var uncertain=node('option','Pick a shell — several matches');uncertain.value='';choice.insertBefore(uncertain,choice.firstChild);}
    choice.value=shotContext.index>=0?'saved:'+shotContext.index:candidates.length?'':shotContext.kind||'ARMOR_PIERCING';
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,b=node('button',(actual?'● ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100),'shell-chip');b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' mm · '+(actual?'Type from the hit':'Compare with this shell');b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    selectShell();
  }
  function shellAt(c,choice,penetration,caliber,distance){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});var fraction=Math.max(0,Math.min(1,(distance-100)/400));if(c.penetration500>0&&c.penetration100>0)shell.penetration=penetration*(1+fraction*(c.penetration500/c.penetration100-1));}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null;
  function shotStats(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var range=viewer?viewer.distance:100;
    var shell=shellAt(c,choice,Number($('penetration').value),Number($('caliber').value),range),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null,range);fillPanel('shot',line);
    output.title=!r?'No parameters or the pose changed':pinned?'Along the pinned line from the current view':'Along the saved line · flight ≈ '+Math.round(range)+' m · nominal penetration '+Math.round(shell.penetration)+' mm';
    var key=JSON.stringify(shell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'');
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;clearTimeout(totalTimer);$('total-chance').textContent='—';
      if(viewer.savedAim&&shell)totalTimer=setTimeout(function(){var v=viewer.savedAimProbability(shell);$('total-chance').textContent=v?'≈ '+(v.unknown?v.low.toFixed(0)+'–'+v.high.toFixed(0):v.low.toFixed(0))+'%':'—';},100);
    }
  }
  function selectShell(){
    var index=$('shell-choice').value,c=index.indexOf('saved:')===0?candidates[Number(index.slice(6))]:null;
    var point=(activeHit&&activeHit.points||[]).find(function(p){return p.caliber>0;});
    if(!c){manualPen=$('penetration').value||manualPen;} // manual shell keeps the penetration that was on screen
    $('penetration').value=c?c.penetration100:manualPen;$('caliber').value=c?c.caliber:point?point.caliber:100;
    $('penetration-label').textContent=c?'Penetration at 100 m, mm':'Penetration at target, mm';updateShell();
  }
  function updateShell(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var penetration=Number($('penetration').value),caliber=Number($('caliber').value),valid=!!choice&&penetration>0&&penetration<=3000&&caliber>0&&caliber<=1000;
    var distance=viewer?viewer.distance:100,shell=shellAt(c,choice,penetration,caliber,distance);
    var edited=c&&(penetration!==c.penetration100||caliber!==c.caliber);
    var actual=shotContext&&choice==='saved:'+shotContext.index&&!edited;
    $('shell-source').textContent=!choice?'Pick a shell':!valid?'No penetration in the record':(actual?'● From the hit':c?'◇ Comparison':'◇ Manual')+' · '+Math.round(shell.penetration)+' mm at target · ±'+Math.round(shell.randomization*100)+'%';
    $('shell-source').title=(shotContext?shotContext.source:'')+' · Nominal penetration at the current distance, not the rolled RNG. HE: penetration only, no blast damage.';
    document.querySelectorAll('[data-shell]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.shell===choice));});
    var kind=c?c.kind:choice;document.querySelectorAll('#shell-types [data-kind]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.kind===kind));});
    var chanceMode=$('armor-mode').value==='chance';$('legend-gradient').classList.toggle('classic',$('palette').value==='classic');$('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');$('armor-legend').hidden=!chanceMode||!valid;$('parameters-notice').hidden=!chanceMode||valid;
    $('penetration').setAttribute('aria-invalid',String(chanceMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(chanceMode&&!(caliber>0&&caliber<=1000)));
    $('probe-chance').textContent='—';$('probe-chance').style.color='';$('probe-pen').replaceChildren();$('probe-extra').replaceChildren();$('probe-details').replaceChildren(node('span','Hover over the armour','placeholder'));
    staleEstimate();if(viewer)viewer.configure(shell,$('armor-mode').value==='chance',$('palette').value);shotStats();
  }
  function chanceRgb(r){return 'rgb('+ArmorBallistics.color(r,$('palette').value).map(function(v){return Math.round(v*255);}).join(',')+')';}
  // Compact reading of one ballistic result: the chance first, then the numbers that explain it.
  // One ballistic result as readable groups: chance, then "effective ← nominal – angle", then "pen / range", then screens.
  function armorLine(r,pen,range){
    if(!r)return {label:'—',color:'',groups:[]};
    var prefix=[];
    if(r.bounce){var b=r.bounce;pen=b.penetration;prefix.push({kind:'ricochet',text:'ricochet '+Math.round(b.nominal)+' mm – '+Math.round(b.angle)+'°'+(b.loss?' · pen −'+Math.round(b.loss*100)+'%':'')});}
    var layers=r.layers||[],screens=layers.filter(function(l){return !l.main;}),extra=screens.length?[{kind:'screen',text:'+ '+screens.map(function(s){return Math.round(s.nominal)+' mm';}).join(' + ')+' screen'}]:[];
    var shell=pen?[{kind:'pen',text:'pen '+Math.round(pen)+' mm'+(range?' / '+Math.round(range)+' m':'')}]:[];
    var zero=chanceRgb({chance:0});
    if(r.reason==='ricochet')return {label:'Ricochet',color:zero,groups:prefix.concat([{kind:'armor',text:(r.final?'again, shell lost: ':'')+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],shell,extra)};
    if(r.reason==='screen')return {label:'0%',color:zero,groups:prefix.concat([{kind:'armor',text:'stops at the screen'}],shell,extra)};
    if(r.reason==='no-hull')return r.bounce?{label:'0%',color:zero,groups:prefix.concat([{kind:'armor',text:'flies past after the ricochet'}],shell)}:{label:'—',color:'',groups:[{kind:'armor',text:'no main armour on this line'}]};
    if(r.reason==='parameters')return {label:'—',color:'',groups:[{kind:'armor',text:'set penetration and calibre'}]};
    if(r.reason==='armor')return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no armour data for this surface'}])};
    if(r.chance===null)return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no estimate for this penetration distribution'}])};
    return {label:r.chance+'%',color:chanceRgb(r),groups:prefix.concat([{kind:'armor',text:'eff '+Math.round(r.effective)+' mm ← '+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],shell,extra)};
  }
  function chips(container,line){container.replaceChildren();line.groups.forEach(function(g){container.appendChild(node('span',g.text,'chip '+g.kind));});}
  // Fill an info panel: the penetration chip sits in the title row, the chance and the armour chips below it.
  function fillPanel(prefix,line){var by=function(k){return line.groups.filter(function(g){return (g.kind==='screen')===(k==='screen')&&(k==='screen'||(g.kind==='pen')===(k==='pen'));});};
    var chance=$(prefix+'-chance');chance.textContent=line.label;chance.style.color=line.color;chips($(prefix+'-pen'),{groups:by('pen')});chips($(prefix+'-details'),{groups:by('rest')});chips($(prefix+'-extra'),{groups:by('screen')});}
  function inspectArmor(r){
    var range=viewer?viewer.distance:100;
    fillPanel('probe',armorLine(r,viewer&&viewer.shell?viewer.shell.penetration:null,range));
  }
  function display(data,reference){
    var hit=data.hit;$('target-name').textContent=(hit.target||{}).name||'Unknown target';$('scene-kind').textContent=reference?'REFERENCE MODEL · NO BATTLE RECORD':'CLIENT COLLISION MODEL';$('result-badge').hidden=!!reference;$('result-badge').textContent=result(hit);
    $('shot-source').textContent='Hit line';$('unpin').hidden=true;prepareShell(hit);var drawn=viewer&&viewer.load(data,shotContext);message(drawn?'':'Geometry unavailable. The original event is kept.');pivotButtons();warnings(data.warnings||[]);$('details').replaceChildren();
    var aimReady=viewer&&viewer.setShotContext(shotContext),estimate=!aimReady&&viewer?viewer.setAimEstimate(shotContext):null;$('show-aim').disabled=!(aimReady||estimate);
    // The reticle block stays small: what the circles mean and where this one came from lives in the ⓘ tooltip.
    var status=aimReady?'This hit: ● solid green — the client reticle at the shot, ◌ dashed gold — the server reticle.':estimate?'This hit: ◌ dashed blue — nominal full-aim estimate of the '+(estimate.gun||'mounted gun')+': '+(estimate.dispersion*100).toFixed(2)+' m at 100 m × '+Math.round(estimate.range)+' m ('+(estimate.source==='tracer'?'tracer range':'approximate range at impact')+') = ⌀ '+(estimate.radius*2).toFixed(2)+' m. Without crew or equipment, centred on the hit line; not the recorded reticle and not used in the figure.':'This hit: no reticle — '+(hit.direction==='incoming'?'enemy reticle unavailable':(aimReasons[shotContext.aimReason]||'no linked snapshot').toLowerCase())+'.';
    $('aim-metric').title='Reticle circles on the model. '+status+' Nominal chance over the saved circle: Gaussian, σ = radius/2; 256 rays, misses = 0. Server formula not confirmed; no map obstacles, target motion or blast damage.';
    $('aim-toggle').title=aimReady?'The saved client circle is teal; the server one is dashed when received. Linked to the hit by end point and time; the target position is at impact.':'No own reticle is unambiguously linked to this hit: '+(aimReasons[shotContext.aimReason]||'no data')+'.';
    shotStats();
    resultVisual($('result-badge'),hit);
    if(reference){$('details').appendChild(node('p','The model is extracted from the installed client. There are no invented hits here. Once the recorder is installed, new battles appear in the list on the left.'));return;}
    detail('Direction',hit.direction==='incoming'?'Incoming':'Outgoing',clock(hit.receivedAt));detail('Result',result(hit));
    var points=hit.points||[],point=points.find(function(p){return p.status==='resolved';});
    detail('Point on the model',point?['Chassis','Hull','Turret','Gun'][point.part]:'Not restored',point?'Per the client collision handler':'Segment kept for diagnostics');
    detail('Calibre',point&&point.caliber?point.caliber+' mm':'No data',points.length+' points in the event');
    if(hit.rangeAtImpact!=null)detail('To the attacker at impact',hit.rangeAtImpact.toFixed(1)+' m','Position when the hit was received; not a measured flight length.');
  }
  function renderHits(){
    var container=$('hits');container.replaceChildren();var hits=current?current.hits.filter(function(h){return filter==='all'||h.direction===filter;}):[];var own=current?(function(){var inc=current.hits.find(function(h){return h.direction==='incoming'&&h.target&&h.target.name;}),out=current.hits.find(function(h){return h.direction==='outgoing'&&h.attacker&&h.attacker.name;});return inc?inc.target.name:out?out.attacker.name:null;}()):null;$('hit-count').textContent=current?hits.length+' hits'+(own?' · battle in '+own:''):'';
    if(!hits.length){container.appendChild(node('p',current?'No hits for the chosen filter.':'No records yet. Start the game with the recorder and play a battle. The viewer can stay open.','empty'));return;}
    hits.forEach(function(h){var hasDamage=h.damage>0,b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(selected===h.id));b.setAttribute('data-direction',h.direction);b.setAttribute('data-result',hasDamage?'damage':'none');b.title=(h.direction==='incoming'?'Incoming from '+((h.attacker||{}).name||'?'):'Outgoing at '+((h.target||{}).name||'?'))+' · '+result(h);
      var row=node('span',undefined,'hit-row');row.appendChild(node('span',h.direction==='incoming'?'↙':'↗','direction-icon '+h.direction));row.appendChild(node('span',h.direction==='incoming'?((h.attacker||{}).name||'Unknown shooter'):((h.target||{}).name||'Unknown target'),'hit-name'));row.appendChild(node('span',hasDamage?'−'+h.damage:'0','hit-damage'));b.appendChild(row);
      var sub=node('span',undefined,'hit-row hit-sub');sub.appendChild(node('span',clock(h.receivedAt)));sub.appendChild(node('span',hasDamage?'':result(h)));b.appendChild(sub);
      b.onclick=function(){selectHit(h.id).catch(function(){});};container.appendChild(b);});
  }
  function selectHit(id){
    if(!current||!current.hits.some(function(h){return h.id===id;}))return Promise.reject(new Error('Hit not found'));
    selected=id;renderHits();var token=++generation;message('Preparing the model…');if(viewer)viewer.clear();
    return ArmorInspectorData.scene(current,id).then(function(data){if(token!==generation)return;display(data,false);return {battleId:current.id,hitId:id};}).catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}throw e;});
  }
  function loadBattle(id,keep){
    var request=++battleGeneration;if(!current||current.id!==id)++generation;
    return ArmorInspectorData.battle(id).then(function(b){if(request!==battleGeneration)return;current=b;ArmorShotTelemetry.load(b.shotEvents||[]);var existing=keep&&selected&&b.hits.some(function(h){return h.id===selected;});if(!existing)selected=null;renderHits();if(b.hits.length)return selectHit(existing?selected:b.hits[0].id);if(viewer)viewer.clear();message('No hits recorded in this battle yet. Shot details are available below.');});
  }
  function refresh(){
    $('refresh').disabled=true;
    return ArmorInspectorData.index().then(function(index){var pv=$('app-version').getAttribute('data-version');$('app-version').textContent=[pv!=='dev'?pv:'',index.version&&index.version!==pv?'records '+index.version:''].filter(Boolean).join(' · ');if(index.application!=='local.armor_inspector'||!Array.isArray(index.battles))throw new Error('Invalid battle list');$('connection').textContent='Local files · no server';var battles=index.battles,prior=$('battles').value;$('battles').replaceChildren();if(!battles.length){current=null;selected=null;++generation;++battleGeneration;if(viewer)viewer.clear();$('battles').appendChild(node('option','No battles yet'));renderHits();message('New hits appear after a battle. Then press “Refresh”.');warnings([]);return;}
      battles.forEach(function(b){var option=node('option',new Date(b.startedAt*1000).toLocaleDateString('en-GB')+' · '+b.map+' · '+b.hits);option.value=b.id;$('battles').appendChild(option);});var id=battles.some(function(b){return b.id===prior;})?prior:battles[0].id;$('battles').value=id;return loadBattle(id,current&&current.id===id);
    }).catch(function(e){$('connection').textContent='No local records';message(e.message);warnings([e.message]);}).then(function(){$('refresh').disabled=false;});
  }
  try{viewer=new ArmorViewer($('viewport'));}catch(e){message('WebGL unavailable: '+e.message);}
  if(viewer)viewer.onInspect=inspectArmor;
  // Keep a visible reason when the GPU chance map cannot be drawn.
  if(viewer)viewer.onBackend=function(text){$('heatmap-backend').textContent=text;var unavailable=/^Estimate unavailable:/.test(text);$('backend-badge').hidden=!unavailable;$('backend-badge').textContent=unavailable?text:'';};
  if(viewer)viewer.onCamera=function(state){var changed=lastDistance!==state.distance;lastDistance=state.distance;if(document.activeElement!==$('camera-distance-field'))$('camera-distance-field').value=Math.round(state.distance);if(document.activeElement!==$('camera-zoom-field'))$('camera-zoom-field').value=state.zoom.toFixed(2);$('camera-distance').value=Math.round(distanceSlider(state.distance));$('camera-zoom').value=Math.round(Math.max(0,Math.min(1000,Math.log(state.zoom/.1)/Math.log(1000)*1000)));var key=[state.distance,state.yaw,state.pitch,viewer.turretAngle,viewer.gunAngle].join(',');if(analysisKey!==null&&analysisKey!==key)staleEstimate();if(changed)updateShell();else if(totalEngine!==viewer.engine)shotStats();};
  // Logarithmic slider between the viewer's distance limits: fine steps in a clinch, coarse steps far away.
  var limits=(window.ArmorViewer&&ArmorViewer.limits)||{distanceMin:5,distanceMax:1000},span=Math.log(limits.distanceMax/limits.distanceMin);
  function distanceSlider(d){return Math.log(Math.max(limits.distanceMin,d)/limits.distanceMin)/span*1000;}
  $('camera-distance-field').min=limits.distanceMin;$('camera-distance-field').max=limits.distanceMax;
  $('camera-distance').oninput=function(){if(viewer)viewer.setDistance(limits.distanceMin*Math.exp(span*Number(this.value)/1000));};
  $('camera-distance-field').onchange=function(){if(viewer)viewer.setDistance(Number(this.value)||limits.distanceMin);};
  $('camera-zoom').oninput=function(){if(viewer)viewer.setZoom(.1*Math.pow(1000,Number(this.value)/1000));}; // ×0.1 … ×100, ×1 at a third
  $('unpin').onclick=function(){if(!viewer)return;viewer.unpin();viewer.resetPose();};
  function recordedButton(){if(viewer)$('unpin').hidden=!(viewer.pinned||Math.abs(viewer.turretAngle)>=.1||Math.abs(viewer.gunAngle)>=.1);}
  if(viewer)viewer.onPin=function(on){$('shot-source').textContent=on?'Pinned point':'Hit line';recordedButton();$('total-chance').textContent=on?'—':$('total-chance').textContent;shotStats();};
  $('auto-frame').onchange=function(){if(viewer)viewer.setAutoFrame(this.checked);};
  $('track-opacity').oninput=function(){if(viewer)viewer.setTrackOpacity(Number(this.value)/100);};
  $('camera-zoom-field').onchange=function(){if(viewer)viewer.setZoom(Number(this.value));};
  $('heatmap-quality').onchange=host.guard('Detail',function(){if(host.game&&this.value==='high'){this.value=viewer?viewer.quality:'auto';return;}if(viewer)viewer.setQuality(this.value);});
  // One line under the scene: the explored pose (when it differs) and the gun's vertical limits at the current turret angle.
  function poseChanged(){if(!viewer)return;var off=!(Math.abs(viewer.turretAngle)<.1&&Math.abs(viewer.gunAngle)<.1),sign=function(v){return (v>0?'+':'')+Math.round(v)+'°';},g=viewer.gunRange();$('turret-notice').hidden=!off;if(off)$('turret-notice').textContent='Turret '+sign(viewer.turretAngle)+', gun '+sign(viewer.gunAngle)+' from the recorded pose (hit marks hidden)';$('gun-limits').textContent=g.known?'Gun '+sign(g.min)+' … '+sign(g.max)+' at this turret angle':'Gun limits not recorded';recordedButton();staleEstimate();shotStats();}
  function pivotButtons(){if(!viewer)return;$('pivot-hit').disabled=!viewer.point;$('pivot-vehicle').setAttribute('aria-pressed',String(viewer.pivot!=='hit'));$('pivot-hit').setAttribute('aria-pressed',String(viewer.pivot==='hit'));}
  $('pivot-vehicle').onclick=function(){if(viewer)viewer.setPivot('vehicle');pivotButtons();};$('pivot-hit').onclick=function(){if(viewer)viewer.setPivot('hit');pivotButtons();};
  if(viewer)viewer.onTurret=poseChanged;
  if(viewer)viewer.onGun=poseChanged;
  $('fit-camera').onclick=function(){if(viewer)viewer.fit();};
  if(viewer)viewer.onAim=function(text){analysisKey=null;$('spread-result').textContent=text;};
  $('reset-aim').onclick=function(){if(viewer){viewer.spreadAim=null;staleEstimate();}};
  $('spread-radius').oninput=staleEstimate;
  $('estimate-spread').onclick=function(){if(!viewer)return;try{var result=viewer.estimateSpread(Number($('spread-radius').value));analysisKey=[viewer.distance,viewer.yaw,viewer.pitch,viewer.turretAngle,viewer.gunAngle].join(',');$('spread-result').textContent='Nominal total chance: '+(result.unknown?result.low.toFixed(1)+'–'+result.high.toFixed(1):result.low.toFixed(1))+'% · outside the main armour '+result.miss.toFixed(1)+'% · '+result.samples+' rays.'+(result.unknown?' A range because armour data is missing.':'')+' For the chosen dispersion model, without map obstacles or blast damage.';}catch(e){$('spread-result').textContent=e.message;}};
  $('shell-choice').onchange=selectShell;
  $('show-aim').onchange=function(){if(viewer)viewer.showSavedAim(this.checked);};
  ['caliber','palette','armor-mode'].forEach(function(id){$(id).onchange=updateShell;});
  // Shell type switch: the entered penetration and calibre stay, only the type's law changes.
  document.querySelectorAll('#shell-types [data-kind]').forEach(function(b){b.onclick=function(){$('shell-choice').value=b.dataset.kind;selectShell();};});
  $('penetration').oninput=function(){if($('shell-choice').value.indexOf('saved:')!==0)manualPen=this.value;updateShell();};
  $('battles').onchange=function(){loadBattle(this.value,false).catch(function(e){warnings([e.message]);});};
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderHits();};});
  $('refresh').onclick=refresh;$('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);};
  window.addEventListener('armor-context-lost',function(){host.mark('WebGL','context-lost');message('The browser lost its WebGL context. Reload the page.');});
  function outline(){if(viewer)viewer.setOutline(Number($('outline-brightness').value)/100,Number($('outline-opacity').value)/100);}
  $('outline-brightness').oninput=outline;$('outline-opacity').oninput=outline;if(viewer){viewer.wireframe($('wireframe').checked);outline();}
  if(host.interrupted){$('host-note').hidden=false;$('host-note').textContent='The previous session was interrupted during “'+host.interrupted.action+'» ('+(host.interrupted.host==='game'?'in the game':'in the browser')+', '+new Date(host.interrupted.at).toLocaleString('en-GB')+'). Mention this when reporting.';}
  (function(){var pv=$('app-version').getAttribute('data-version');if(pv!=='dev')$('app-version').textContent=pv;}());
  host.done();
  refresh();
  if(document.modelContext&&document.modelContext.registerTool){try{document.modelContext.registerTool({name:'select_saved_hit',description:'Open an existing recorded hit in the local 3D viewer.',inputSchema:{type:'object',properties:{battleId:{type:'string'},hitId:{type:'string'}},required:['battleId','hitId'],additionalProperties:false},execute:function(input){if(!input||!/^[-a-zA-Z0-9_]{1,100}$/.test(input.battleId)||!/^\d+$/.test(input.hitId))throw new Error('Invalid record identifiers');return loadBattle(input.battleId,true).then(function(){return selectHit(input.hitId);});}});}catch(e){console.warn('WebMCP unavailable',e);}}
}());
