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
    var parts=(hit.target||{}).parts||[],hasRecorded=parts.every(function(p){return !!p.armor;}),comparison=parts.find(function(p){return p.comparisonArmor;});
    var armorChoice=$('armor-version');armorChoice.replaceChildren();var original=node('option',hasRecorded?'Battle version':'Battle version — no data');original.value='recorded';armorChoice.appendChild(original);
    if(comparison){var currentArmor=node('option','Current '+comparison.comparisonVersion);currentArmor.value='current';armorChoice.appendChild(currentArmor);}
    armorChoice.value=hasRecorded||!comparison?'recorded':'current';armorChoice.parentElement.hidden=armorChoice.options.length<2; // one version: nothing to choose
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
    var range=shotContext&&shotContext.range||activeHit&&activeHit.rangeAtImpact||100;
    var shell=shellAt(c,choice,Number($('penetration').value),Number($('caliber').value),range),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null);output.textContent=line.label;output.style.color=line.color;$('shot-details').textContent=line.details?line.details+(pinned?'':' · flight ≈ '+Math.round(range)+' m'):'';
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
    $('distance-control').hidden=!c||$('link-distance').checked;$('penetration-label').textContent=c?'Penetration at 100 m, mm':'Penetration at target, mm';$('shot-distance').value=100;updateShell();
  }
  function updateShell(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var penetration=Number($('penetration').value),caliber=Number($('caliber').value),valid=!!choice&&penetration>0&&penetration<=3000&&caliber>0&&caliber<=1000;
    var distance=$('link-distance').checked&&viewer?viewer.distance:Number($('shot-distance').value),shell=shellAt(c,choice,penetration,caliber,distance);
    var edited=c&&(penetration!==c.penetration100||caliber!==c.caliber);
    var actual=shotContext&&choice==='saved:'+shotContext.index&&!edited;
    $('shell-source').textContent=!choice?'Pick a shell':!valid?'No penetration in the record':(actual?'● From the hit':c?'◇ Comparison':'◇ Manual')+' · '+Math.round(shell.penetration)+' mm at target · ±'+Math.round(shell.randomization*100)+'%';
    $('shell-source').title=(shotContext?shotContext.source:'')+' · Nominal penetration, not the rolled RNG. The model colour uses the viewing distance; the hit figure uses the saved line and range. HE: penetration only, no blast damage.';
    document.querySelectorAll('[data-shell]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.shell===choice));});
    var chanceMode=$('armor-mode').value==='chance';$('legend-gradient').classList.toggle('classic',$('palette').value==='classic');$('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');$('armor-legend').hidden=!chanceMode||!valid;$('parameters-notice').hidden=!chanceMode||valid;
    $('penetration').setAttribute('aria-invalid',String(chanceMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(chanceMode&&!(caliber>0&&caliber<=1000)));
    $('armor-probe').textContent='';
    $('distance-control').hidden=!c||$('link-distance').checked;staleEstimate();if(viewer)viewer.configure(shell,$('armor-mode').value==='chance',$('palette').value);shotStats();
  }
  function chanceRgb(r){return 'rgb('+ArmorBallistics.color(r,$('palette').value).map(function(v){return Math.round(v*255);}).join(',')+')';}
  // Compact reading of one ballistic result: the chance first, then the numbers that explain it.
  function armorLine(r,pen){
    if(!r)return {label:'—',color:'',details:''};
    var layers=r.layers||[],screens=layers.filter(function(l){return !l.main;}),extra=screens.length?' · +'+screens.map(function(s){return Math.round(s.nominal)+' mm';}).join(' +')+' screen':'';
    if(r.reason==='ricochet')return {label:'Ricochet',color:chanceRgb({chance:0}),details:Math.round(r.nominal)+' mm @ '+Math.round(r.angle)+'°'+extra};
    if(r.reason==='screen')return {label:'0%',color:chanceRgb({chance:0}),details:'stops at the screen'+extra};
    if(r.reason==='no-hull')return {label:'—',color:'',details:'no main armour on this line'};
    if(r.reason==='parameters')return {label:'—',color:'',details:'set penetration and calibre'};
    if(r.reason==='armor')return {label:'—',color:'',details:'no armour data for this surface'};
    if(r.chance===null)return {label:'—',color:'',details:'no estimate for this penetration distribution'};
    return {label:r.chance+'%',color:chanceRgb(r),details:'eff '+Math.round(r.effective)+' mm · '+Math.round(r.nominal)+' mm @ '+Math.round(r.angle)+'°'+(pen?' · pen '+Math.round(pen)+' mm':'')+extra};
  }
  function inspectArmor(r){
    var line=armorLine(r,viewer&&viewer.shell?viewer.shell.penetration:null),probe=$('armor-probe');probe.replaceChildren();
    var b=node('b',line.label);b.style.color=line.color;probe.appendChild(b);if(line.details)probe.appendChild(document.createTextNode(' · '+line.details));
  }
  function display(data,reference){
    var hit=data.hit;$('target-name').textContent=(hit.target||{}).name||'Unknown target';$('scene-kind').textContent=reference?'REFERENCE MODEL · NO BATTLE RECORD':'CLIENT COLLISION MODEL';$('result-badge').hidden=!!reference;$('result-badge').textContent=result(hit);
    $('shot-source').textContent='Hit line';$('unpin').hidden=true;prepareShell(hit);var drawn=viewer&&viewer.load(data);if(viewer)requestAnimationFrame(function(){viewer.resize();});message(drawn?'':'Geometry unavailable. The original event is kept.');$('focus-hit').disabled=!(viewer&&viewer.point);warnings(data.warnings||[]);$('details').replaceChildren();
    var aimReady=viewer&&viewer.setShotContext(shotContext);$('show-aim').disabled=!aimReady;$('aim-state').textContent=aimReady?'● client · ◌ server':hit.direction==='incoming'?'Enemy reticle unavailable':aimReasons[shotContext.aimReason]||'No linked snapshot';
    $('aim-toggle').title=aimReady?'The saved client circle is teal; the server one is dashed when received. Linked to the hit by end point and time; the target position is at impact.':'No own reticle is unambiguously linked to this hit: '+(aimReasons[shotContext.aimReason]||'no data')+'.';
    if(viewer&&shotContext.range)viewer.setDistance(Math.max(1,Math.min(1500,shotContext.range)));shotStats();
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
    selected=id;renderHits();var token=++generation;message('Preparing the model…');if(viewer)viewer.clear();$('focus-hit').disabled=true;
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
  // The fallback path is visibly labelled in the scene: its stepped sampling must never pass for the exact composition.
  if(viewer)viewer.onBackend=function(text){$('heatmap-backend').textContent=text;var fallback=!/^GPU · layers/.test(text);$('backend-badge').hidden=!fallback;$('backend-badge').textContent=fallback?text:'';};
  $('heatmap-compute').onchange=host.guard('Estimate',function(){if(viewer)viewer.computeMode(this.value);});
  if(viewer)viewer.onCamera=function(state){var changed=lastDistance!==state.distance;lastDistance=state.distance;$('camera-distance-value').textContent=Math.round(state.distance)+' m';$('camera-distance-exact').value=state.distance.toFixed(1);$('camera-zoom-exact').value=state.zoom.toFixed(2);$('camera-distance').value=Math.round(Math.log(Math.max(1,state.distance))/Math.log(1500)*1000);var key=[state.distance,state.yaw,state.pitch,viewer.turretAngle,viewer.gunAngle].join(',');if(analysisKey!==null&&analysisKey!==key)staleEstimate();if(changed&&$('link-distance').checked)updateShell();else if(totalEngine!==viewer.engine)shotStats();};
  $('camera-distance').oninput=function(){if(viewer)viewer.setDistance(Math.max(1,Math.min(1500,Math.pow(1500,Number(this.value)/1000))));};
  $('unpin').onclick=function(){if(viewer)viewer.unpin();};
  if(viewer)viewer.onPin=function(on){$('shot-source').textContent=on?'Pinned point':'Hit line';$('unpin').hidden=!on;$('total-chance').textContent=on?'—':$('total-chance').textContent;shotStats();};
  $('auto-frame').onchange=function(){if(viewer)viewer.setAutoFrame(this.checked);};
  $('track-opacity').oninput=function(){if(viewer)viewer.setTrackOpacity(Number(this.value)/100);};
  $('camera-distance-exact').onchange=function(){if(viewer)viewer.setDistance(Number(this.value));};
  $('camera-zoom-exact').onchange=function(){if(viewer)viewer.setZoom(Number(this.value));};
  $('link-distance').onchange=updateShell;
  $('heatmap-quality').onchange=host.guard('Detail',function(){if(host.game&&this.value==='high'){this.value=viewer?viewer.quality:'auto';return;}if(viewer)viewer.setQuality(this.value);});
  $('surface-mode').onchange=host.guard('Screens and tracks',function(){$('track-overlay-note').hidden=this.value!=='blend';if(viewer)viewer.setSurfaceMode(this.value);});
  if(viewer)viewer.onQuality=function(count){$('quality-info').textContent=count.toLocaleString('en-GB')+' map points';};
  function poseChanged(){if(!viewer)return;$('turret-notice').hidden=Math.abs(viewer.turretAngle)<.1&&Math.abs(viewer.gunAngle)<.1;staleEstimate();shotStats();}
  if(viewer)viewer.onTurret=poseChanged;
  if(viewer)viewer.onGun=function(state){$('gun-notice').textContent=state.known?'Gun limits come from the client and follow the turret rotation. Saved angles are interpolated.':'This record has no gun limits. Vertical movement is free exploration, not the real tank angles.';poseChanged();};
  $('reset-turret').onclick=function(){if(viewer)viewer.resetPose();};
  $('fit-camera').onclick=function(){if(viewer)viewer.fit();};
  if(viewer)viewer.onAim=function(text){analysisKey=null;$('spread-result').textContent=text;};
  $('reset-aim').onclick=function(){if(viewer){viewer.spreadAim=null;staleEstimate();}};
  $('spread-radius').oninput=staleEstimate;
  $('estimate-spread').onclick=function(){if(!viewer)return;try{var result=viewer.estimateSpread(Number($('spread-radius').value));analysisKey=[viewer.distance,viewer.yaw,viewer.pitch,viewer.turretAngle,viewer.gunAngle].join(',');$('spread-result').textContent='Nominal total chance: '+(result.unknown?result.low.toFixed(1)+'–'+result.high.toFixed(1):result.low.toFixed(1))+'% · outside the main armour '+result.miss.toFixed(1)+'% · '+result.samples+' rays.'+(result.unknown?' A range because armour data is missing.':'')+' For the chosen dispersion model, without map obstacles or blast damage.';}catch(e){$('spread-result').textContent=e.message;}};
  $('save-camera').onclick=function(){if(viewer)$('camera-help').textContent=viewer.saveDefaults()?'Start view saved for the next hits and openings.':'View kept until the page closes: the browser refused local storage.';};
  $('shell-choice').onchange=selectShell;
  $('show-aim').onchange=function(){if(viewer)viewer.showSavedAim(this.checked);};
  $('armor-version').onchange=host.guard('Armour version',function(){if(viewer)viewer.armorVersion(this.value==='current');updateShell();});
  $('pivot-mode').onchange=function(){if(viewer)viewer.setPivot(this.value);};
  ['caliber','shot-distance','palette','armor-mode'].forEach(function(id){$(id).onchange=updateShell;});
  $('penetration').oninput=function(){if($('shell-choice').value.indexOf('saved:')!==0)manualPen=this.value;updateShell();};
  $('battles').onchange=function(){loadBattle(this.value,false).catch(function(e){warnings([e.message]);});};
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderHits();};});
  $('refresh').onclick=refresh;$('reset-camera').onclick=function(){if(viewer)viewer.reset();};$('focus-hit').onclick=function(){if(viewer)viewer.focus();};$('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);};
  window.addEventListener('armor-context-lost',function(){host.mark('WebGL','context-lost');message('The browser lost its WebGL context. Reload the page.');});
  function outline(){if(viewer)viewer.setOutline(Number($('outline-brightness').value)/100,Number($('outline-opacity').value)/100);}
  $('outline-brightness').oninput=outline;$('outline-opacity').oninput=outline;if(viewer){viewer.wireframe($('wireframe').checked);outline();}
  if(host.interrupted){$('host-note').hidden=false;$('host-note').textContent='The previous session was interrupted during “'+host.interrupted.action+'» ('+(host.interrupted.host==='game'?'in the game':'in the browser')+', '+new Date(host.interrupted.at).toLocaleString('en-GB')+'). Mention this when reporting.';}
  (function(){var pv=$('app-version').getAttribute('data-version');if(pv!=='dev')$('app-version').textContent=pv;}());
  host.done();
  refresh();
  if(document.modelContext&&document.modelContext.registerTool){try{document.modelContext.registerTool({name:'select_saved_hit',description:'Open an existing recorded hit in the local 3D viewer.',inputSchema:{type:'object',properties:{battleId:{type:'string'},hitId:{type:'string'}},required:['battleId','hitId'],additionalProperties:false},execute:function(input){if(!input||!/^[-a-zA-Z0-9_]{1,100}$/.test(input.battleId)||!/^\d+$/.test(input.hitId))throw new Error('Invalid record identifiers');return loadBattle(input.battleId,true).then(function(){return selectHit(input.hitId);});}});}catch(e){console.warn('WebMCP unavailable',e);}}
}());
