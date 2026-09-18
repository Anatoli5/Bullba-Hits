(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
  var shellNames={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'},candidates=[],activeHit=null,shotContext=null,manualPen='',lastDistance=null,analysisKey=null;
  // Fingerprint of the hit record the scene was built from, so an index bump that changed nothing does not
  // rebuild it. Set by selectHit, cleared by display() so that every other scene (a browsed vehicle, a
  // swapped shooter) counts as “not the recorded hit”.
  var currentHitKey=null;
  // web/host.js: game-host flag, breadcrumb-guarded heavy handlers. Absent in isolated tests.
  var host=window.BullbaHost||{game:false,interrupted:null,guard:function(action,fn){return fn;},done:function(){},
    canSend:function(){return false;},send:function(){return Promise.reject(new Error('No channel to the mod'));}};
  function fragment(){return host.params?host.params():{};}
  var aimReasons={'no-tracer':'No own tracer','no-endpoint':'Tracer did not match the hit point','ambiguous':'Several tracers — the link is ambiguous','foreign':'Someone else’s shot','no-snapshot':'Reticle snapshot not recorded','stale':'Reticle snapshot is stale'};
  function staleEstimate(){if(analysisKey!==null){$('spread-result').textContent='Conditions changed. Press “Estimate” again.';analysisKey=null;}if(viewer)viewer.hideSpread();}
  function node(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  // Vehicle tile: tier, name, nation flag, class and role. Any field may be missing in
  // records written before the recorder saved them; missing slots stay empty and keep their size.
  var tierRomans=['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI'];
  var classNames={lightTank:'Light tank',mediumTank:'Medium tank',heavyTank:'Heavy tank','AT-SPG':'Tank destroyer',SPG:'SPG'};
  // WoT class marks: one rhombus LT, two MT, three HT, inverted triangle TD, trapezoid SPG.
  // Role families share one icon each (the client's own roleExp icons); the class mark tells the families apart.
  var roleFamilies={role_SPG:'spg',role_HT_assault:'assault',role_HT_break:'break',role_HT_universal:'universal',role_HT_support:'support',
    role_MT_assault:'assault',role_MT_universal:'universal',role_MT_sniper:'sniper',role_MT_support:'support',
    role_ATSPG_assault:'assault',role_ATSPG_universal:'universal',role_ATSPG_sniper:'sniper',role_ATSPG_support:'support',
    role_LT_universal:'universal',role_LT_scout:'scout',role_LT_support:'support'};
  var roleNames={spg:'SPG',assault:'Assault',break:'Breakthrough',universal:'Universal',support:'Support',sniper:'Sniper',scout:'Scout'};
  var nationNames={ussr:'USSR',germany:'Germany',usa:'USA',china:'China',france:'France',uk:'UK',
    japan:'Japan',czech:'Czechoslovakia',sweden:'Sweden',poland:'Poland',italy:'Italy'};
  function vehicleTile(info){
    info=info||{};
    var tile=node('span',undefined,'vehicle-tile'),nation=info.nation||String(info.type||'').split(':')[0];
    if(nationNames[nation])tile.setAttribute('data-nation',nation);
    var tier=tierRomans[info.level]||'',cls=classNames[info['class']]?info['class']:null,family=roleFamilies[info.role]||null;
    tile.appendChild(node('span',info.name||'Unknown vehicle','vt-name'));
    // Second line: tier, class icon (the client's own outline icon), role icon.
    var meta=node('span',undefined,'vt-meta');
    meta.appendChild(node('span',tier,'vt-tier'));
    var mark=node('span',undefined,'vt-class');
    if(cls){mark.setAttribute('data-class',cls);mark.title=classNames[cls];}
    meta.appendChild(mark);
    var role=node('span',undefined,'vt-role');
    if(family){role.setAttribute('data-role',family);role.title=roleNames[family]+(cls?' \u00b7 '+classNames[cls].toLowerCase():'');}
    meta.appendChild(role);tile.appendChild(meta);
    tile.title=[info.name||'Unknown vehicle',tier?'Tier '+tier:'',nationNames[nation]||'',classNames[cls]||'',family?roleNames[family]:''].filter(Boolean).join(' \u00b7 ');
    return tile;
  }
  // ============================ Vehicles mode =============================
  // The side panel works in two modes. “Battles” is the recorded history, unchanged to the pixel.
  // “Vehicles” is the client's own catalogue: filter pills at the top, every vehicle of the client below,
  // grouped by class. A click on a row fills one of the two roles - the collision model drawn in the scene,
  // or the shooter whose shells are offered - and the role is chosen by clicking the matching scene tile.
  var SIDEBAR_KEY='bullba-sidebar',VEHICLE_ID=/^[-a-zA-Z0-9_]{1,100}$/;
  var CLASS_ORDER=['lightTank','mediumTank','heavyTank','AT-SPG','SPG'];
  var FLAG_KEYS=['premium','collector','special','exported'];
  var FLAG_NAMES={premium:'Premium',collector:'Collector',special:'Special',exported:'Exported'};
  var FLAG_TITLES={premium:'Premium vehicles only',collector:'Collector vehicles only',special:'Special (reward) vehicles only',exported:'Only vehicles whose collision model is already exported'};
  // Flags the client itself draws an icon for (the files are named in style.css). "Exported" is our own
  // idea, not the client's, so that pill keeps its word.
  var FLAG_ICONS={premium:true,collector:true,special:true};
  var SOURCE_TAG={hangar:'from the hangar',battle:'from a battle',catalogue:'from the catalogue',picker:'from this list'};
  var SOURCE_TEXT={hangar:'the hangar',battle:'a battle',catalogue:'the catalogue',picker:'this list'};
  var NO_VEHICLE_MODEL='No collision model of this vehicle yet. Select it in the hangar, meet it in a battle, or right-click it in the hangar and pick Bullba Hits.';
  var EXPORT_TIMEOUT='The model did not arrive in 30 s. See game.log.';
  var VEHICLE_HELP='Models are exported by the mod while the game runs: the vehicle selected in the hangar, every vehicle of a battle you played, or any vehicle via right-click \u2192 Bullba Hits in the hangar. A full export of the whole client can be switched on in settings.json (exportAllVehicles).';
  var sidebarMode='battles',battlesDirty=false;
  var catalogue=null,catalogueStamp=null,catalogueError=null,cataloguePending=false;
  var vehicleFilters={tier:[],nation:[],'class':[],role:[],flag:[],text:''};
  var modelVehicle=null,shooterVehicle=null,shooterPicked=false,activeRole='model';
  var vehicleScene=null,vehicleGeneration=0,vehicleCache=Object.create(null),vehicleOrder=[];
  var listIds=null,listMarks=null,listRoles=null,lastFragment=null;

  // The game's CEF may refuse storage; the mode and the filters are a convenience, never a requirement.
  function storedSidebar(){try{return JSON.parse(window.localStorage.getItem(SIDEBAR_KEY));}catch(e){return null;}}
  function storeSidebar(){try{window.localStorage.setItem(SIDEBAR_KEY,JSON.stringify({mode:sidebarMode,filters:vehicleFilters}));}catch(e){}}

  // ---- filters -----------------------------------------------------------
  function toggleFilter(row,value,button){
    var list=vehicleFilters[row],at=list.indexOf(value);
    if(at<0)list.push(value);else list.splice(at,1);
    button.setAttribute('aria-pressed',String(at<0));storeSidebar();renderVehicles();
  }
  // Nation and flag marks: the client's own icons, embedded in style.css exactly like .vt-class/.vt-role.
  function nationMark(nation){var m=node('span',undefined,'vt-nation');m.setAttribute('data-nation',nation);return m;}
  function flagMark(flag){var m=node('span',undefined,'vt-flag');m.setAttribute('data-flag',flag);return m;}
  // A pill with a mark shows the icon and carries the name in its title; a pill without one shows the word
  // (Tier is Roman numerals, "Exported" has no client icon).
  function filterRow(row,title,items){
    var wrap=node('div',undefined,'filter-row');wrap.appendChild(node('span',title,'filter-label'));
    var pills=node('span',undefined,'filter-pills');pills.setAttribute('role','group');pills.setAttribute('aria-label',title);
    items.forEach(function(item){
      var b=node('button',undefined,'filter-pill');b.type='button';
      b.setAttribute('data-row',row);b.setAttribute('data-value',item.value);b.setAttribute('aria-pressed','false');
      if(item.mark){b.appendChild(item.mark);b.setAttribute('aria-label',item.label);}else b.textContent=item.label;
      b.title=item.title||item.label;
      b.onclick=function(){toggleFilter(row,item.value,b);};
      pills.appendChild(b);
    });
    wrap.appendChild(pills);return wrap;
  }
  function buildFilters(){
    var box=$('vehicle-filters');box.replaceChildren();
    var search=document.createElement('input');search.id='vehicle-search';search.type='search';search.className='vehicle-search';
    search.placeholder='Find\u2026';search.setAttribute('aria-label','Find a vehicle by name');search.autocomplete='off';
    search.oninput=function(){vehicleFilters.text=this.value;storeSidebar();renderVehicles();};
    box.appendChild(search);
    var tiers=[],i;for(i=1;i<=11;i++)tiers.push({value:String(i),label:tierRomans[i],title:'Tier '+tierRomans[i]});
    box.appendChild(filterRow('tier','Tier',tiers));
    box.appendChild(filterRow('nation','Nation',Object.keys(nationNames).map(function(n){
      return {value:n,label:nationNames[n],mark:nationMark(n)};})));
    box.appendChild(filterRow('class','Class',CLASS_ORDER.map(function(c){
      var mark=node('span',undefined,'vt-class');mark.setAttribute('data-class',c);return {value:c,label:classNames[c],mark:mark};})));
    box.appendChild(filterRow('role','Role',Object.keys(roleNames).map(function(f){
      var mark=node('span',undefined,'vt-role');mark.setAttribute('data-role',f);return {value:f,label:roleNames[f],mark:mark};})));
    var flags=host.game?FLAG_KEYS:FLAG_KEYS.filter(function(f){return f!=='exported';});
    box.appendChild(filterRow('flag','Flags',flags.map(function(f){
      return {value:f,label:FLAG_NAMES[f],title:FLAG_TITLES[f],mark:FLAG_ICONS[f]?flagMark(f):null};})));
  }
  function syncFilters(){
    document.querySelectorAll('#vehicle-filters [data-row]').forEach(function(b){
      var list=vehicleFilters[b.getAttribute('data-row')]||[];
      b.setAttribute('aria-pressed',String(list.indexOf(b.getAttribute('data-value'))>=0));});
    var search=$('vehicle-search');if(search)search.value=vehicleFilters.text;
  }
  function vehicleMatches(v){
    var f=vehicleFilters,i;
    if(f.tier.length&&f.tier.indexOf(String(v.level))<0)return false;
    if(f.nation.length&&f.nation.indexOf(v.nation)<0)return false;
    if(f['class'].length&&f['class'].indexOf(v['class'])<0)return false;
    if(f.role.length&&f.role.indexOf(roleFamilies[v.role]||'')<0)return false;
    for(i=0;i<f.flag.length;i++)if(!v[f.flag[i]])return false;
    var text=String(f.text||'').trim().toLowerCase();
    if(text&&String(v.name||'').toLowerCase().indexOf(text)<0)return false;
    return true;
  }

  // ---- the list ----------------------------------------------------------
  // One DOM node per row, up to about a thousand of them: the list is rebuilt only when the set of rows, the
  // roles or the export marks actually change, so the five-second poll of the catalogue costs nothing.
  function renderVehicles(force){
    var list=$('vehicles'),all=(catalogue&&catalogue.vehicles)||[];
    // In the game the mod is running, so every catalogue row is offered and an unexported one exports on
    // click. In the browser nothing can be exported, so only the rows that already have a model are listed
    // and a short note under the count says how models get there.
    if(!host.game)all=all.filter(function(v){return v.exported;});
    var shown=all.filter(vehicleMatches);
    var exported=0;shown.forEach(function(v){if(v.exported)exported++;});
    $('vehicle-count').textContent=catalogue?(host.game?shown.length+' vehicles \u00b7 '+exported+' with models':shown.length+' vehicles with models'):(catalogueError||'Reading the vehicle list\u2026');
    var help=$('vehicle-help');help.textContent=host.game?'':VEHICLE_HELP;help.hidden=host.game;
    var ids=shown.map(function(v){return v.id;}).join(','),marks=shown.map(function(v){return v.exported?'1':'0';}).join('');
    var roles=(modelVehicle?modelVehicle.id:'')+'/'+(shooterVehicle?shooterVehicle.id:'');
    if(!force&&ids===listIds&&roles===listRoles){
      if(marks!==listMarks){listMarks=marks;shown.forEach(function(v){
        var row=list.querySelector('[data-vehicle="'+v.id+'"]');if(row)row.setAttribute('data-exported',String(!!v.exported));});}
      return;
    }
    listIds=ids;listMarks=marks;listRoles=roles;
    var top=list.scrollTop;list.replaceChildren();
    if(!shown.length){list.appendChild(node('p',catalogue?'No vehicles match the filters.':(catalogueError||'Reading the vehicle list\u2026'),'empty'));return;}
    CLASS_ORDER.forEach(function(cls){
      var group=shown.filter(function(v){return v['class']===cls;});
      if(!group.length)return;
      group.sort(function(a,b){return (b.level||0)-(a.level||0)||String(a.name||'').localeCompare(String(b.name||''));});
      list.appendChild(node('div',String(classNames[cls]).toUpperCase(),'vehicle-group'));
      group.forEach(function(v){
        var b=node('button',undefined,'vehicle-row');b.type='button';
        b.setAttribute('data-vehicle',v.id);b.setAttribute('data-exported',String(!!v.exported));
        b.setAttribute('aria-pressed',String(!!modelVehicle&&modelVehicle.id===v.id));
        if(shooterVehicle&&shooterVehicle.id===v.id)b.setAttribute('data-role','shooter');
        b.appendChild(vehicleTile(v));
        b.title=(v.name||'Unknown vehicle')+(v.exported?' \u00b7 model exported '+(SOURCE_TAG[v.source]||''):' \u00b7 no collision model yet');
        b.onclick=function(){chooseVehicle(v);};
        list.appendChild(b);
      });
    });
    list.scrollTop=top;
  }
  function catalogueRow(id){
    var rows=(catalogue&&catalogue.vehicles)||[],i;
    for(i=0;i<rows.length;i++)if(rows[i].id===id)return rows[i];
    return null;
  }
  function loadCatalogue(){
    if(cataloguePending)return Promise.resolve();cataloguePending=true;
    return ArmorInspectorData.vehicles().then(function(data){
      if(!data||!Array.isArray(data.vehicles))throw new Error('Invalid vehicle list');
      catalogueError=null;
      var stamp=String(data.updatedAt||'')+':'+data.vehicles.length;
      if(stamp===catalogueStamp&&catalogue)return;
      catalogueStamp=stamp;
      catalogue={updatedAt:data.updatedAt,vehicles:data.vehicles.filter(function(v){return v&&VEHICLE_ID.test(String(v.id||''));})};
      if(sidebarMode==='vehicles')renderVehicles();
    }).catch(function(){
      catalogueError='No vehicle list yet. Run the game once with the mod: the catalogue is written at export setup.';
      if(!catalogue&&sidebarMode==='vehicles')renderVehicles(true);
    }).then(function(){cataloguePending=false;});
  }

  // ---- picking a vehicle -------------------------------------------------
  // In the game the mod is right here: a row without a model is a request, not a dead end. The export runs
  // on the mod's own thread, so the page waits for data/vehicles/<id>.js exactly as the '#vehicle=' fragment
  // does - 'Exporting the model…', a retry every 2 s for up to 30 s.
  function chooseVehicle(v){
    if(!v.exported&&!host.game)return void message(NO_VEHICLE_MODEL);
    var waiting=!v.exported,options=waiting?{deadline:Date.now()+30000,waiting:'Exporting the model\u2026'}:{};
    if(waiting)requestExport(v);
    pickVehicle(v.id,activeRole,options).catch(function(e){
      var text=waiting?EXPORT_TIMEOUT:e.message;message(text);warnings([text]);});
  }
  function requestExport(v){
    host.send('bullba_hits',{action:'exportVehicle',vehicleType:String(v.type||'')}).catch(function(e){
      if(window.console)console.warn('Bullba Hits export request failed: '+e.message);});
  }
  // The export of a vehicle may still be running when the in-game window opens: retry until the deadline.
  function readVehicle(id,deadline){
    if(!VEHICLE_ID.test(String(id)))return Promise.reject(new Error('Invalid vehicle identifier'));
    var row=catalogueRow(id),key=id+'@'+(row?row.exportedAt:'');
    if(vehicleCache[key])return Promise.resolve(vehicleCache[key]);
    return ArmorInspectorData.vehicle(id).then(function(record){
      if(!record||record.id!==id||!Array.isArray(record.parts))throw new Error('This file is not a collision-model export of '+id+'.');
      vehicleCache[key]=record;vehicleOrder.push(key);
      while(vehicleOrder.length>8)delete vehicleCache[vehicleOrder.shift()];
      return record;
    },function(e){
      if(!deadline||Date.now()>=deadline)throw e;
      message('Exporting the model\u2026');
      return new Promise(function(resolve){window.setTimeout(resolve,2000);}).then(function(){return readVehicle(id,deadline);});
    });
  }
  // A browsed vehicle as a hit the scene loader and the viewer already understand: the model is the target
  // (its parts carry the collision models), the shooter is the attacker without parts, and the shooter's own
  // shells are the available ones. No points, so no hit line and no reticle - an inspector without a shot.
  function vehicleHit(model,shooter){
    var target=shallow(model),attacker=shallow(shooter);
    ['shells','warnings','schema'].forEach(function(k){delete target[k];});
    ['parts','shells','warnings','schema','gunPitchLimits','turretYawLimits'].forEach(function(k){delete attacker[k];});
    // partsFrom is the rest pose, so the recorded turret yaw and gun pitch are both zero: that is the zero
    // the viewer measures turretYawLimits and gunPitchLimits from, and the Turret/Gun readout needs it.
    return {id:'vehicle:'+model.id+'/'+shooter.id,synthetic:true,vehicle:true,direction:'outgoing',aim:[0,0],
      target:target,attacker:attacker,points:[],rawHitPoints:[],warnings:(model.warnings||[]).slice(),
      shellCandidates:[],availableShells:(shooter.shells||[]).slice(),shellStatus:'vehicle browser',receivedAt:model.exportedAt};
  }
  function showVehicleScene(keepCamera){
    if(!modelVehicle)return Promise.resolve(null);
    var hit=vehicleHit(modelVehicle,shooterVehicle||modelVehicle);
    var camera=keepCamera&&viewer&&viewer.cameraState?viewer.cameraState():null,token=++generation;
    message('Preparing the model\u2026');if(viewer)viewer.clear();
    return ArmorInspectorData.sceneFor({warnings:[]},hit).then(function(data){
      if(token!==generation)return null;
      vehicleScene=data;display(data,false);
      if(camera&&viewer)viewer.restoreCamera(camera);
      renderVehicleHeading();renderVehicles(true);
      return data;
    }).catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}throw e;});
  }
  // Changing the model is an ordinary load (camera as for any new hit). Changing the shooter alone leaves the
  // model and the orbit centre where they are, so the camera is taken before the reload and put back after it.
  function pickVehicle(id,role,options){
    role=role==='shooter'?'shooter':'model';options=options||{};
    var token=++vehicleGeneration;
    message(options.waiting||'Preparing the model\u2026');
    return readVehicle(id,options.deadline).then(function(record){
      if(token!==vehicleGeneration)return null;
      var keepCamera=false;
      if(role==='shooter'){
        if(modelVehicle)keepCamera=true;else modelVehicle=record;
        shooterVehicle=record;shooterPicked=true;
      }else{
        modelVehicle=record;
        if(!shooterPicked||!shooterVehicle)shooterVehicle=record;
      }
      return showVehicleScene(keepCamera);
    });
  }
  function renderVehicleHeading(){
    var v=modelVehicle,date=v&&Number.isFinite(v.exportedAt)?new Date(v.exportedAt*1000).toLocaleDateString('en-GB'):'';
    var tag=v?SOURCE_TAG[v.source]||'':'';
    $('scene-kind').textContent='VEHICLE'+(tag?' \u00b7 '+tag:'')+(date?' \u00b7 '+date:'');
    $('battle-map').textContent=v?(v.name||'Unknown vehicle'):'Pick a vehicle';
    var slot=$('heading-vehicle');slot.replaceChildren();if(v)slot.appendChild(vehicleTile(v));
  }

  // ---- the mode switch ---------------------------------------------------
  function setMode(mode){
    scheduleToolbar();
    mode=mode==='vehicles'?'vehicles':'battles';
    var changed=mode!==sidebarMode;sidebarMode=mode;
    document.querySelectorAll('#sidebar-mode [data-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===mode));});
    $('battles-pane').hidden=mode!=='battles';$('vehicles-pane').hidden=mode!=='vehicles';
    storeSidebar();
    if(mode==='vehicles'){
      loadCatalogue();
      if(!changed)return Promise.resolve();
      if(vehicleScene&&modelVehicle){display(vehicleScene,false);renderVehicleHeading();renderVehicles(true);return Promise.resolve();}
      if(modelVehicle)return showVehicleScene(false).catch(function(){});
      ++generation;if(viewer)viewer.clear();sceneTiles(null,false);renderVehicleHeading();renderVehicles(true);
      message('Pick a vehicle from the list.');warnings([]);
      return Promise.resolve();
    }
    ++vehicleGeneration;
    if(!changed)return Promise.resolve();
    if(battlesDirty||!current){battlesDirty=false;indexStamp=null;return refresh();}
    renderHits();
    if(selected)return selectHit(selected).catch(function(){});
    return loadBattle(current.id,true).catch(function(){});
  }
  // #host=game&vehicle=<id>: open the Vehicles mode on that vehicle. The game window may also be navigated to a
  // new fragment while it is open, so the same path serves 'hashchange'.
  function applyFragment(initial){
    var id=String(fragment().vehicle||'');
    if(!id||!VEHICLE_ID.test(id)){if(!initial)lastFragment=null;return;}
    if(!initial&&id===lastFragment)return;
    lastFragment=id;loadCatalogue();setMode('vehicles');shooterPicked=false;
    pickVehicle(id,'model',{deadline:Date.now()+30000,waiting:'Exporting the model\u2026'})
      .catch(function(){message('The model of this vehicle was not exported. See game.log.');});
  }
  function restoreSidebar(){
    buildFilters();
    var saved=storedSidebar();
    if(saved&&saved.filters){
      ['tier','nation','class','role','flag'].forEach(function(k){if(Array.isArray(saved.filters[k]))vehicleFilters[k]=saved.filters[k].filter(function(v){return typeof v==='string';});});
      if(typeof saved.filters.text==='string')vehicleFilters.text=saved.filters.text;
    }
    syncFilters();
    // The page always opens on the battles and their hits (user, 14.09: a newcomer must not think the viewer is
    // empty); only a fragment naming a vehicle opens the Vehicles mode. The filters are remembered, the mode is not.
  }
  document.querySelectorAll('#sidebar-mode [data-mode]').forEach(function(b){
    b.onclick=host.guard('Side panel mode',function(){setMode(b.getAttribute('data-mode'));});});
  $('model-tile').onclick=function(){if(sidebarMode!=='vehicles')return;activeRole='model';roleTiles();};
  // ========================== end of Vehicles mode =========================
  function message(text){$('scene-message').textContent=text;$('scene-message').hidden=!text;}
  function warnings(lines){$('warnings').textContent=lines.map(function(line){return line==='Additional vehicle parts are not yet rendered'?'Extra parts of this vehicle are not shown and not included in the estimate.':line;}).join(' · ');$('warnings').hidden=!lines.length;}
  function result(hit){if(hit.damage>0)return 'Damage '+hit.damage+' HP';var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;});return p.length?(effects[p[p.length-1].effect]||'Result '+p[p.length-1].effect):'Result not decoded';}
  function resultIcon(hit){if(hit.damage>0)return '▰ −'+hit.damage;var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;}),effect=p.length?p[p.length-1].effect:null;return effect===2||effect===1?'↪':effect===3?'▰ ×':effect===4?'▰ ✓':effect===5||effect===6?'⚙':effect===0?'▰ 0':'—';}
  function clock(seconds){if(!Number.isFinite(seconds))return '—';var d=new Date(seconds*1000);return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function detail(label,value,small){var e=node('div');e.appendChild(node('div',label,'detail-label'));e.appendChild(node('div',String(value),'detail-value'));if(small)e.appendChild(node('div',small,'detail-small'));$('details').appendChild(e);}
  function prepareShell(hit){
    // A swapped view has no shot and therefore no shells: keep the shell that is on screen - type,
    // penetration and calibre - instead of falling back to the empty manual defaults.
    var keep=null;
    if(hit&&hit.synthetic&&!hit.vehicle){var was=$('shell-choice').value,c0=was.indexOf('saved:')===0?candidates[Number(was.slice(6))]:null;
      keep={kind:c0?c0.kind:was||'ARMOR_PIERCING',penetration:$('penetration').value,caliber:$('caliber').value};}
    activeHit=hit;shotContext=ArmorShotContext.resolve(hit,hit&&hit.vehicle?[]:(current&&current.shotEvents||[]));candidates=shotContext.choices;var choice=$('shell-choice');choice.replaceChildren();
    candidates.forEach(function(c,i){var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name);o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — manual');o.value=kind;choice.appendChild(o);});
    if(candidates.length>1&&!(hit&&hit.vehicle)){var uncertain=node('option','Pick a shell — several matches');uncertain.value='';choice.insertBefore(uncertain,choice.firstChild);}
    choice.value=shotContext.index>=0?'saved:'+shotContext.index:candidates.length?'':shotContext.kind||'ARMOR_PIERCING';
    // A browsed vehicle has no hit to identify a shell, so resolve() leaves the index at -1. The shooter's own
    // list is nevertheless the right set of choices: preselect the first AP-like shell so the model is coloured
    // the moment a vehicle is picked, instead of “pick a shell”.
    if(hit&&hit.vehicle&&candidates.length){var first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING';});
      if(first<0)first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING_CR';});if(first<0)first=0;choice.value='saved:'+first;}
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,b=node('button',(actual?'● ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100),'shell-chip');b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' mm · '+(actual?'Type from the hit':'Compare with this shell');b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    if(keep){choice.value=keep.kind;manualPen=keep.penetration;$('penetration').value=keep.penetration;$('caliber').value=keep.caliber;penLabel(false);updateShell();}
    else selectShell();
  }
  function shellAt(c,choice,penetration,caliber,distance){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});var fraction=Math.max(0,Math.min(1,(distance-100)/400));if(c.penetration500>0&&c.penetration100>0)shell.penetration=penetration*(1+fraction*(c.penetration500/c.penetration100-1));}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null,verdictKey=null,partNames=['chassis','hull','turret','gun'];
  // Verdict log (user, 14.09): one console line per recorded contact point - the server's result as a fact next to our
  // estimate along the drawn line. The game writes the page's console into game.log; tools/verdicts_from_log.py
  // tabulates the lines. Once per hit and shell, never on camera moves.
  var verdictLines=0,verdictQueue=[],verdictDone={},verdictTimer=null,verdictBusy=false;
  function verdictLine(battleId,hit,v,shell,mode){var r=v.result||{},chance=r.chance;
    var ours=r.reason==='ricochet'?'ricochet':chance===null||chance===undefined?(r.reason||'none'):(chance>=50?'pen':'no-pen')+'_'+chance+'%';
    console.info('Bullba Hits verdict: battle='+battleId+' hit='+hit.id+' point='+v.index+' part='+(partNames[v.part]||v.part)+' server='+String(effects[v.effect]||v.effect).replace(/ /g,'_')+' ours='+ours+' angle='+(r.angle!=null?Math.round(r.angle):'-')+' eff='+(r.effective!=null?Math.round(r.effective):'-')+' pen='+Math.round(shell.penetration)+' shell='+shell.kind+' dir='+v.source+' chordDev='+(v.chordDev==null?'-':(v.chordDev*180/Math.PI).toFixed(1))+' mode='+mode);
    verdictLines++;verdictStatus();}
  // The displayed hit, with whatever shell is on screen: logged once per hit and shell, never on camera moves.
  function logVerdicts(shell){
    if(!viewer||!shell||!activeHit||activeHit.synthetic||!current||!window.console)return;
    var key=current.id+'/'+activeHit.id+'|'+JSON.stringify(shell);if(key===verdictKey)return;
    // Before load() the previous hit's points would be logged under the new id: wait for the points of this hit.
    var verdicts=viewer.pointVerdicts(shell);if(!verdicts.length||viewer.loadedData.hit!==activeHit)return;verdictKey=key;
    verdicts.forEach(function(v){verdictLine(current.id,activeHit,v,shell,'view');});
  }
  // Every hit of a loaded battle, automatically (user, 14.09: the more data the better the analysis): the hit's own
  // shell, its models from the cache, a throwaway ballistics engine, one hit every 150 ms so the page stays responsive.
  // Nothing is displayed and nothing is sent anywhere - the lines go to the console, in the game to game.log.
  function queueVerdicts(battle){
    (battle.hits||[]).forEach(function(h){var key=battle.id+'/'+h.id;if(verdictDone[key]||!(h.points||[]).some(function(p){return p.status==='resolved';}))return;verdictDone[key]=true;verdictQueue.push({battle:battle,hit:h});});
    verdictStatus();if(!verdictTimer)verdictTimer=setTimeout(drainVerdicts,150);
  }
  function drainVerdicts(){
    verdictTimer=null;if(verdictBusy||!verdictQueue.length||!window.ArmorViewer||!window.ArmorBallistics)return;
    // The diagnostics wait while the user is working: a hidden page or a drag gets the frame, not a BVH build.
    if(document.hidden||(viewer&&viewer.dragging)){verdictTimer=setTimeout(drainVerdicts,150);return;}
    verdictBusy=true;
    var job=verdictQueue.shift(),battle=job.battle,hit=job.hit;
    ArmorInspectorData.sceneFor(battle,hit).then(function(data){
      var context=ArmorShotContext.resolve(hit,battle.shotEvents||[]),c=context.index>=0?context.choices[context.index]:context.choices[0]||null;
      var range=context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:100,shell=c?shellAt(c,c.kind,c.penetration100,c.caliber,range):null;
      if(!shell)return;var engine=ArmorBallistics.build(data,false),pts=ArmorViewer.points(hit);
      ArmorViewer.verdicts(engine,pts,shell).forEach(function(v){verdictLine(battle.id,hit,v,shell,context.index>=0?'auto':'auto-shell-guess');});
    }).catch(function(e){if(window.console)console.warn('Bullba Hits verdict: hit '+hit.id+' skipped: '+e.message);})
      .then(function(){verdictBusy=false;verdictStatus();if(verdictQueue.length)verdictTimer=setTimeout(drainVerdicts,150);});
  }
  // Header line: the verdict log is on, with the count so far; the (i) explains what it is for.
  function verdictStatus(){var e=$('connection');if(!e)return;e.textContent='Verdict log \u00b7 '+verdictLines+' points'+(verdictQueue.length?' \u00b7 checking '+verdictQueue.length+' more':'');}
  function shotStats(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var range=viewer?viewer.distance:100;
    var shell=shellAt(c,choice,Number($('penetration').value),Number($('caliber').value),range),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null,range);fillPanel('shot',line);
    logVerdicts(shell);
    output.title=!r?'No parameters or the pose changed':pinned?'Along the pinned line from the current view':'Along the saved line · flight ≈ '+Math.round(range)+' m · nominal penetration '+Math.round(shell.penetration)+' mm';
    var key=JSON.stringify(shell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'');
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;clearTimeout(totalTimer);
      // No saved circle: the nominal ring's diameter, so a 10 cm ring at short range reads as present, not missing.
      $('total-chance').textContent=!viewer.savedAim&&viewer.estimateAim?'\u2300 '+(viewer.estimateAim.radius*2).toFixed(2)+' m':'—';
      if(viewer.savedAim&&shell)totalTimer=setTimeout(function(){var v=viewer.savedAimProbability(shell);$('total-chance').textContent=v?'≈ '+(v.unknown?v.low.toFixed(0)+'–'+v.high.toFixed(0):v.low.toFixed(0))+'%':'—';},100);
    }
  }
  // The heading row has no space for the full wording: the label reads “Pen.” and the sentence lives in its title.
  function penLabel(at100){var e=$('penetration-label');e.textContent='Pen.';e.title=at100?'Penetration at 100 m, mm':'Penetration at target, mm';}
  function selectShell(){
    var index=$('shell-choice').value,c=index.indexOf('saved:')===0?candidates[Number(index.slice(6))]:null;
    var point=(activeHit&&activeHit.points||[]).find(function(p){return p.caliber>0;});
    if(!c){manualPen=$('penetration').value||manualPen;} // manual shell keeps the penetration that was on screen
    $('penetration').value=c?c.penetration100:manualPen;$('caliber').value=c?c.caliber:point?point.caliber:100;
    penLabel(!!c);updateShell();
  }
  function updateShell(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var penetration=Number($('penetration').value),caliber=Number($('caliber').value),valid=!!choice&&penetration>0&&penetration<=3000&&caliber>0&&caliber<=1000;
    var distance=viewer?viewer.distance:100,shell=shellAt(c,choice,penetration,caliber,distance);
    var edited=c&&(penetration!==c.penetration100||caliber!==c.caliber);
    var actual=shotContext&&choice==='saved:'+shotContext.index&&!edited;
    var browsing=!!(activeHit&&activeHit.vehicle);
    // The caption band under the fields is gone (user, 18.09: the line read as noise). Its sentence is now the
    // title of the shell group, and the two states that are a warning keep their words in #parameters-notice.
    var source=!choice?'Pick a shell':!valid?'No penetration in the record':(actual?'● From the hit':c?(browsing?'● Shooter’s shell':'◇ Comparison'):'◇ Manual')+' · '+Math.round(shell.penetration)+' mm at target · ±'+Math.round(shell.randomization*100)+'%';
    var sourceTitle=source+' · '+(shotContext?shotContext.source:'')+' · Nominal penetration at the current distance, not the rolled RNG. HE: penetration only, no blast damage.';
    $('shell-choice').title=sourceTitle;if(shellGroup)shellGroup.title=sourceTitle;
    $('parameters-notice').textContent=!choice?'Pick a shell — the record holds more than one match.':!valid?'No penetration in the record — enter the penetration and calibre to colour the model.':'Pick a shell or enter penetration and calibre to colour the model.';
    document.querySelectorAll('[data-shell]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.shell===choice));});
    var kind=c?c.kind:choice;document.querySelectorAll('#shell-types [data-kind]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.kind===kind));});
    var chanceMode=$('armor-mode').value==='chance';$('legend-gradient').classList.toggle('classic',$('palette').value==='classic');$('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');var hideLegend=!chanceMode||!valid;$('armor-legend').hidden=hideLegend;if(legendHidden!==hideLegend){legendHidden=hideLegend;scheduleToolbar();}$('parameters-notice').hidden=!chanceMode||valid;
    $('penetration').setAttribute('aria-invalid',String(chanceMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(chanceMode&&!(caliber>0&&caliber<=1000)));
    $('probe-chance').textContent='—';$('probe-chance').style.color='';$('probe-pen').replaceChildren();$('probe-extra').replaceChildren();$('probe-details').replaceChildren(node('span','Hover over the armour','placeholder'));
    staleEstimate();if(viewer)viewer.configure(shell,$('armor-mode').value==='chance',$('palette').value);shotStats();
  }
  var shellGroup=document.querySelector('.shell-fields'),legendHidden=null;
  var ricochetTint=.5; // the Ricochet tint row of Settings, 0 (off)..1.5; the panels' ricochet colours follow the map
  function chanceRgb(r){return 'rgb('+ArmorBallistics.color(r,$('palette').value,ricochetTint).map(function(v){return Math.round(v*255);}).join(',')+')';}
  // Compact reading of one ballistic result: the chance first, then the numbers that explain it.
  // One ballistic result as readable groups: chance, then "effective ← nominal – angle", then "pen / range", then screens.
  function armorLine(r,pen,range){
    if(!r)return {label:'—',color:'',groups:[]};
    var prefix=[];
    if(r.bounce){var b=r.bounce;pen=b.penetration;prefix.push({kind:'ricochet',text:'ricochet '+Math.round(b.nominal)+' mm – '+Math.round(b.angle)+'°'+(b.loss?' · pen −'+Math.round(b.loss*100)+'%':'')});}
    var layers=r.layers||[],screens=layers.filter(function(l){return !l.main;}),extra=screens.length?[{kind:'screen',text:'+ '+screens.map(function(s){return Math.round(s.nominal)+' mm';}).join(' + ')+' screen'}]:[];
    var shell=pen?[{kind:'pen',text:'pen '+Math.round(pen)+' mm'+(range?' / '+Math.round(range)+' m':'')}]:[];
    var zero=chanceRgb({chance:0}),bounced=chanceRgb({chance:0,reason:'ricochet'});
    if(r.reason==='ricochet')return {label:'Ricochet',color:bounced,groups:prefix.concat([{kind:'armor',text:(r.final?'again, shell lost: ':'')+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],shell,extra)};
    if(r.reason==='screen')return {label:'0%',color:zero,groups:prefix.concat([{kind:'armor',text:'explodes on the screen (this HE cannot pass screens)'}],shell,extra)};
    if(r.reason==='no-hull')return r.bounce?{label:'0%',color:bounced,groups:prefix.concat([{kind:'armor',text:'flies past after the ricochet'}],shell)}:{label:'—',color:'',groups:[{kind:'armor',text:'no main armour on this line'}]};
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
  // Heading: which battle this is - date and start time, the map, and the vehicle the player was in.
  function battleStamp(seconds){if(!Number.isFinite(seconds))return '';var d=new Date(seconds*1000);return d.toLocaleDateString('en-GB')+' \u00b7 '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
  // The player's own vehicle: the target of any incoming hit, or the attacker of any outgoing one.
  function ownVehicle(){if(!current)return null;var inc=current.hits.find(function(h){return h.direction==='incoming'&&h.target&&h.target.name;});if(inc)return inc.target;var out=current.hits.find(function(h){return h.direction==='outgoing'&&h.attacker&&h.attacker.name;});return out?out.attacker:null;}
  function renderHeading(){
    var stamp=current?battleStamp(current.startedAt):'',own=ownVehicle();
    if(sidebarMode!=='battles')return own; // the Vehicles mode writes its own heading
    $('scene-kind').textContent='BATTLE'+(stamp?' \u00b7 '+stamp:'');
    $('battle-map').textContent=current?(current.map||'Unknown map'):'Pick a hit';
    var slot=$('heading-vehicle');slot.replaceChildren();if(own)slot.appendChild(vehicleTile(own));
    return own;
  }
  // Two overlays inside the scene: the vehicle whose collision model is drawn stays centred over it, the
  // shooter sits underneath. Clicking the shooter swaps the two roles - his collision model is drawn and
  // the vehicle that was drawn becomes the shooter. The swapped view carries no recorded shot (no hit
  // line, no reticle): an inspector without a shot. Clicking again returns to the recorded hit.
  var swapped=null,NO_SHOOTER_MODEL='No collision model of this vehicle recorded yet (recorded from 0.6.34 on; older battles are completed by the exporter on the next game start)';
  function shallow(value){var copy={};if(value)Object.keys(value).forEach(function(k){copy[k]=value[k];});return copy;}
  function swapReady(hit){return !!(hit&&hit.attacker&&(hit.attacker.parts||[]).some(function(p){return p.modelKey;}));}
  // The swapped view as a hit the scene loader and the viewer understand: the recorded shooter becomes the
  // target (his parts carry the models), the recorded target becomes the shooter. No points, so no hit line,
  // no reticle and no shells - the vehicle now on screen never fired in this record.
  function swapHit(hit){
    var attacker=shallow(hit.target);delete attacker.parts;
    return {id:hit.id+':swap',synthetic:true,base:hit.id,direction:hit.direction==='incoming'?'outgoing':'incoming',
      attacker:attacker,target:shallow(hit.attacker),points:[],rawHitPoints:[],warnings:[],
      shellCandidates:[],availableShells:[],receivedAt:hit.receivedAt,rangeAtImpact:hit.rangeAtImpact};
  }
  function sceneTiles(hit,reference){
    var target=hit&&hit.target||null,attacker=hit&&hit.attacker||null,button=$('shooter-tile'),model=$('model-tile');
    $('model-caption').textContent=reference?'Reference model':'Collision model';
    model.hidden=!target;$('model-tile-body').replaceChildren();if(target)$('model-tile-body').appendChild(vehicleTile(target));
    button.hidden=!attacker;$('shooter-tile-body').replaceChildren();if(attacker)$('shooter-tile-body').appendChild(vehicleTile(attacker));
    // In Vehicles mode both tiles are controls: the one pressed last is the role the next list click fills.
    if(sidebarMode==='vehicles'){
      model.disabled=false;button.disabled=false;
      model.title='Pick the vehicle to show from the list';button.title='Pick the shooter from the list';
      roleTiles();return;
    }
    model.disabled=true;model.removeAttribute('aria-pressed');button.removeAttribute('aria-pressed');model.title='';
    var back=!!(hit&&hit.synthetic),ready=swapReady(hit);button.disabled=!(back||ready);
    button.title=back?'Back to the recorded hit and its shot line':ready?'Show this vehicle\u2019s collision model \u00b7 the roles swap, the recorded shot is not carried over':NO_SHOOTER_MODEL;
  }
  function roleTiles(){
    $('model-tile').setAttribute('aria-pressed',String(activeRole!=='shooter'));
    $('shooter-tile').setAttribute('aria-pressed',String(activeRole==='shooter'));
  }
  function display(data,reference){
    currentHitKey=null;var hit=data.hit;swapped=hit.synthetic&&!hit.vehicle?hit:null;sceneTiles(hit,reference);
    $('shot-source').textContent=hit.synthetic?'No recorded shot':'Hit line';prepareShell(hit);var drawn=viewer&&viewer.load(data,shotContext);message(drawn?'':'Geometry unavailable. The original event is kept.');pivotButtons();warnings(data.warnings||[]);$('details').replaceChildren();
    var aimReady=viewer&&viewer.setShotContext(shotContext),estimate=!aimReady&&viewer?viewer.setAimEstimate(shotContext):null;$('show-aim').disabled=!(aimReady||estimate);
    $('total-chance').textContent=estimate?'\u2300 '+(estimate.radius*2).toFixed(2)+' m':'—';
    // Why there is no circle, in full: no resolved impact point to centre on, no gun dispersion in the record,
    // no range, or no own reticle linked to this hit (every incoming hit by design - the enemy's is not recorded).
    var reason=aimReady?'saved reticle':estimate?'nominal estimate':!(viewer&&viewer.point&&viewer.travel)?'no resolved impact point':!(hit.attacker&&hit.attacker.gunDispersion>0)?'no gun dispersion in the record':!(shotContext.range>0||hit.rangeAtImpact>0)?'no range for this hit':hit.direction==='incoming'?'enemy reticle unavailable':(aimReasons[shotContext.aimReason]||'no linked snapshot').toLowerCase();
    // The reticle block stays small: what the circles mean and where this one came from lives in the ⓘ tooltip.
    var status=aimReady?'This hit: ● solid green — the client reticle at the shot, ◌ dashed gold — the server reticle, both slid along the shot line to the impact point.':estimate?'This hit: ◌ dashed blue — nominal full-aim estimate of the '+(estimate.gun||'mounted gun')+': '+(estimate.dispersion*100).toFixed(2)+' m at 100 m × '+Math.round(estimate.range)+' m ('+(estimate.source==='tracer'?'tracer range':'approximate range at impact')+') = ⌀ '+(estimate.radius*2).toFixed(2)+' m. Without crew or equipment, centred on the hit line; not the recorded reticle and not used in the figure.':'This hit: no reticle — '+reason+'.';
    // One line per hit in the page console; the game writes page console lines into game.log, so an in-game
    // report about missing rings can be read there instead of guessed at.
    if(window.console)console.info('Bullba Hits aim: hit '+hit.id+' '+hit.direction+' saved='+!!aimReady+' estimate='+!!estimate+' reason='+reason);
    $('aim-metric').title='Reticle circles on the model. '+status+' Nominal chance over the saved circle: Gaussian, σ = radius/2; 256 rays, misses = 0. Server formula not confirmed; no map obstacles, target motion or blast damage.';
    $('aim-toggle').title=aimReady?'The saved client circle is teal; the server one is dashed when received. Linked to the hit by end point and time; the target position is at impact.':'No own reticle is unambiguously linked to this hit: '+(aimReasons[shotContext.aimReason]||'no data')+'.';
    shotStats();
    if(reference){$('details').appendChild(node('p','The model is extracted from the installed client. There are no invented hits here. Once the recorder is installed, new battles appear in the list on the left.'));return;}
    if(hit.vehicle){
      var mv=hit.target||{},sv=hit.attacker||{},when=Number.isFinite(hit.receivedAt)?new Date(hit.receivedAt*1000).toLocaleDateString('en-GB'):'an unknown date';
      $('details').appendChild(node('p','Client collision model of '+(mv.name||'this vehicle')+', exported from '+(SOURCE_TEXT[mv.source]||'the client')+' on '+when+', rest pose. Shooter: '+(sv.name||'\u2014')+', '+(sv.gun||'gun not recorded')+'. Nothing was fired here: pin a point on the armour to read a line, or Alt + click to estimate a reticle.'));
      return;
    }
    if(hit.synthetic){$('details').appendChild(node('p','The shooter\u2019s collision model, swapped in from the hit at '+clock(hit.receivedAt)+'. Nothing was fired at this vehicle in the record, so there is no hit line, no reticle and no shell of its own. Click the tile below the model to go back to the recorded hit.'));return;}
    detail('Direction',hit.direction==='incoming'?'Incoming':'Outgoing',clock(hit.receivedAt));detail('Result',result(hit));
    var points=hit.points||[],point=points.find(function(p){return p.status==='resolved';});
    detail('Point on the model',point?['Chassis','Hull','Turret','Gun'][point.part]:'Not restored',point?'Per the client collision handler':'Segment kept for diagnostics');
    detail('Calibre',point&&point.caliber?point.caliber+' mm':'No data',points.length+' points in the event');
    if(hit.rangeAtImpact!=null)detail('To the attacker at impact',hit.rangeAtImpact.toFixed(1)+' m','Position when the hit was received; not a measured flight length.');
  }
  function renderHits(){
    var container=$('hits');container.replaceChildren();var hits=current?current.hits.filter(function(h){return filter==='all'||h.direction===filter;}):[];var own=renderHeading();$('hit-count').textContent=current?hits.length+' hits'+(own?' · battle in '+own.name:''):'';
    if(!hits.length){container.appendChild(node('p',current?'No hits for the chosen filter.':'No records yet. Start the game with the recorder and play a battle. The viewer can stay open.','empty'));return;}
    hits.forEach(function(h){var hasDamage=h.damage>0,b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(selected===h.id));b.setAttribute('data-direction',h.direction);b.setAttribute('data-result',hasDamage?'damage':'none');b.title=(h.direction==='incoming'?'Incoming from '+((h.attacker||{}).name||'?'):'Outgoing at '+((h.target||{}).name||'?'))+' · '+result(h);
      b.appendChild(vehicleTile(h.direction==='incoming'?h.attacker:h.target));
      // Outcome column: damage in the direction colour, or the muted result icon; the full result text stays in the button title.
      // Outcome widget: direction arrow in the top-left corner, the figure (damage, or the no-damage result icon)
      // in the top-right, the time underneath - the arrow never glues to the figure.
      var outcome=node('span',undefined,'hit-outcome'),line=node('span',undefined,'outcome-line');
      line.appendChild(node('span',h.direction==='incoming'?'\u2199':'\u2197','outcome-dir'));
      line.appendChild(hasDamage?node('span',String(h.damage),'hit-damage'):node('span',resultIcon(h).replace(/▰ ?/,''),'hit-result'));
      outcome.appendChild(line);outcome.appendChild(node('span',clock(h.receivedAt),'hit-time'));b.appendChild(outcome);
      b.onclick=function(){selectHit(h.id).catch(function(){});};container.appendChild(b);});
  }
  function selectHit(id){
    if(!current||!current.hits.some(function(h){return h.id===id;}))return Promise.reject(new Error('Hit not found'));
    selected=id;renderHits();var token=++generation;message('Preparing the model…');if(viewer)viewer.clear();
    return ArmorInspectorData.scene(current,id).then(function(data){if(token!==generation)return;display(data,false);currentHitKey=hitFingerprint(current.hits.find(function(h){return h.id===id;}));return {battleId:current.id,hitId:id};}).catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}throw e;});
  }
  // The exporter bumps one shared index timestamp on every publish, so a shot in another battle used to reload
  // this battle, re-select the same hit and rebuild the scene from scratch - losing the camera, the pinned line
  // and the explored pose. A fingerprint of the selected hit's own record decides instead. It is a subset, not
  // JSON of the whole hit: one hit carries the full armour descriptor of every part, about 128 KB, and
  // stringifying that on each poll would be exactly the kind of work this removes. Hits are immutable once
  // written except for enrichment, and every enriched field (points, models, shells, attacker, warnings) is in
  // the key.
  function hitFingerprint(hit){
    if(!hit)return null;
    var parts=((hit.target||{}).parts||[]).map(function(p){return [p.id,p.name,p.modelKey,p.armorSource,p.resource,(p.transform||[]).join(' ')].join('~');}).join(';');
    var attacker=hit.attacker||{},target=hit.target||{};
    return [hit.id,hit.receivedAt,hit.damage,hit.direction,hit.rangeAtImpact,hit.shellStatus,hit.effectsIndex,hit.shellVelocity,
      JSON.stringify(hit.points||[]),JSON.stringify(hit.rawHitPoints||[]),JSON.stringify(hit.aim||[]),
      (hit.warnings||[]).join('|'),(hit.shellCandidates||[]).length,(hit.availableShells||[]).length,
      target.name,attacker.name,attacker.gun,attacker.gunDispersion,attacker.gunHeight,attacker.gunHeightFrom,parts].join('\u0001');
  }
  function loadBattle(id,keep){
    var request=++battleGeneration;if(!current||current.id!==id)++generation;
    return ArmorInspectorData.battle(id).then(function(b){
      if(request!==battleGeneration)return;
      var sameBattle=!!current&&current.id===b.id,kept=keep&&selected?b.hits.find(function(h){return h.id===selected;}):null;
      var unchanged=!!kept&&sameBattle&&currentHitKey!==null&&hitFingerprint(kept)===currentHitKey;
      current=b;ArmorShotTelemetry.load(b.shotEvents||[]);queueVerdicts(b);
      var existing=keep&&selected&&b.hits.some(function(h){return h.id===selected;});
      if(!existing)selected=null;
      renderHits();
      // The selected shot is untouched: the list, the shot events and the verdict queue are refreshed, the scene is not.
      if(unchanged)return;
      if(b.hits.length)return selectHit(existing?selected:b.hits[0].id);
      if(viewer)viewer.clear();sceneTiles(null,false);message('No hits recorded in this battle yet. Shot details are available below.');
    });
  }
  // The battle list keeps itself fresh: the index file is re-read every few seconds (a local file, cheap) and the
  // battle is reloaded only when the exporter has written a newer index; the chosen battle and hit are kept.
  var indexStamp=null,polling=false;
  function refresh(){
    if(polling)return Promise.resolve();polling=true;
    return ArmorInspectorData.index().then(function(index){var pv=$('app-version').getAttribute('data-version');$('app-version').textContent=[pv!=='dev'?pv:'',index.version&&index.version!==pv?'records '+index.version:''].filter(Boolean).join(' \u00b7 ');if(index.application!=='local.armor_inspector'||!Array.isArray(index.battles))throw new Error('Invalid battle list');verdictStatus();
      var stamp=String(index.updatedAt||'')+':'+index.battles.map(function(b){return b.id+'/'+b.hits;}).join(',');if(stamp===indexStamp)return;indexStamp=stamp;
      var battles=index.battles,prior=$('battles').value;$('battles').replaceChildren();
      if(!battles.length){current=null;selected=null;++battleGeneration;$('battles').appendChild(node('option','No battles yet'));
        if(sidebarMode!=='battles'){battlesDirty=true;return;}
        ++generation;if(viewer)viewer.clear();sceneTiles(null,false);renderHits();message('New hits appear here after a battle.');warnings([]);return;}
      battles.forEach(function(b){var option=node('option',new Date(b.startedAt*1000).toLocaleDateString('en-GB')+' \u00b7 '+b.map+' \u00b7 '+b.hits);option.value=b.id;$('battles').appendChild(option);});var id=battles.some(function(b){return b.id===prior;})?prior:battles[0].id;$('battles').value=id;
      // The battle list stays fresh while the Vehicles mode is on screen, but the scene there belongs to a
      // vehicle: the reload waits for the switch back.
      if(sidebarMode!=='battles'){battlesDirty=true;return;}
      return loadBattle(id,current&&current.id===id);
    }).catch(function(e){$('connection').textContent='No local records';if(!current&&sidebarMode==='battles'){message(e.message);warnings([e.message]);}}).then(function(){polling=false;});
  }
  try{viewer=new ArmorViewer($('viewport'));}catch(e){message('WebGL unavailable: '+e.message);}
  if(viewer)viewer.setAutoFrame($('auto-frame').checked); // on by default (user, 18.09)
  if(viewer)viewer.onInspect=inspectArmor;
  // The viewer's real frame rate next to the composition's own report: in the game the browser's frame pump
  // decides it, and it is neither 60 nor what a desktop browser shows. Refreshed at most once a second, and
  // left out entirely when there is no fresh sample - a stale figure would be worse than none.
  var backendText='',frameText='',frameAt=0,backendShown=null;
  function backendLine(){var line=backendText+frameText;if(line===backendShown)return;backendShown=line;$('heatmap-backend').textContent=line;}
  function frameBadge(){
    var now=Date.now();
    if(now-frameAt>=1000){frameAt=now;var rate=viewer&&viewer.frameRate?viewer.frameRate():null;frameText=rate?' · ~'+Math.round(rate.fps)+' fps':'';}
    backendLine();
  }
  // Keep a visible reason when the GPU chance map cannot be drawn.
  if(viewer)viewer.onBackend=function(text){backendText=text;frameBadge();var unavailable=/^Estimate unavailable:/.test(text);$('backend-badge').hidden=!unavailable;$('backend-badge').textContent=unavailable?text:'';};
  if(viewer)viewer.onCamera=function(state){var changed=lastDistance!==state.distance;lastDistance=state.distance;if(document.activeElement!==$('camera-distance-field'))$('camera-distance-field').value=Math.round(state.distance);if(document.activeElement!==$('camera-zoom-field'))$('camera-zoom-field').value=state.zoom.toFixed(2);$('camera-distance').value=Math.round(distanceSlider(state.distance));$('camera-zoom').value=Math.round(Math.max(0,Math.min(1000,Math.log(state.zoom/.1)/Math.log(1000)*1000)));var hr=viewer.heightRange(),hy=viewer.target.y;$('pivot-height').max=Math.max(1,Math.round((hr[1]-hr[0])*100));$('pivot-height').value=Math.round((hy-hr[0])*100);$('pivot-height-field').min=hr[0].toFixed(2);$('pivot-height-field').max=hr[1].toFixed(2);if(document.activeElement!==$('pivot-height-field'))$('pivot-height-field').value=hy.toFixed(2);var key=[state.distance,state.yaw,state.pitch,viewer.turretAngle,viewer.gunAngle].join(',');if(analysisKey!==null&&analysisKey!==key)staleEstimate();if(changed)updateShell();else if(totalEngine!==viewer.engine)shotStats();};
  // Logarithmic slider between the viewer's distance limits: fine steps in a clinch, coarse steps far away.
  var limits=(window.ArmorViewer&&ArmorViewer.limits)||{distanceMin:3,distanceMax:1000},span=Math.log(limits.distanceMax/limits.distanceMin);
  function distanceSlider(d){return Math.log(Math.max(limits.distanceMin,d)/limits.distanceMin)/span*1000;}
  $('camera-distance-field').min=limits.distanceMin;$('camera-distance-field').max=limits.distanceMax;
  $('camera-distance').oninput=function(){if(viewer)viewer.setDistance(limits.distanceMin*Math.exp(span*Number(this.value)/1000));};
  $('camera-distance-field').onchange=function(){if(viewer)viewer.setDistance(Number(this.value)||limits.distanceMin);};
  $('camera-zoom').oninput=function(){if(viewer)viewer.setZoom(.1*Math.pow(1000,Number(this.value)/1000));}; // ×0.1 … ×100, ×1 at a third
  // No “back to the recorded shot” button any more (user, 18.09): clicking the hit in the list again
  // re-runs selectHit, which clears the viewer and rebuilds the scene, so the pin and the pose reset with it.
  if(viewer)viewer.onPin=function(on){$('shot-source').textContent=on?'Pinned point':activeHit&&activeHit.synthetic?'No recorded shot':'Hit line';$('total-chance').textContent=on?'—':$('total-chance').textContent;shotStats();};
  $('auto-frame').onchange=function(){if(viewer)viewer.setAutoFrame(this.checked);};
  $('track-opacity').oninput=function(){if(viewer)viewer.setTrackOpacity(Number(this.value)/100);};
  $('camera-zoom-field').onchange=function(){if(viewer)viewer.setZoom(Number(this.value));};
  $('pivot-height').oninput=function(){if(viewer){var r=viewer.heightRange();viewer.setPivotHeight(r[0]+Number(this.value)/100);}};
  $('pivot-height-field').onchange=function(){if(viewer)viewer.setPivotHeight(Number(this.value));};
  // Ricochet trace mode: remembered per browser, so a choice made for a weaker GPU survives the next battle.
  (function(){var select=$('bounce-mode'),stored=null;try{stored=window.localStorage.getItem('bullba-bounce-mode');}catch(e){}
    if(stored==='always'||stored==='idle')select.value=stored;if(viewer)viewer.setBounceMode(select.value);
    select.onchange=function(){if(viewer)viewer.setBounceMode(this.value);try{window.localStorage.setItem('bullba-bounce-mode',this.value);}catch(e){}};})();
  // Ricochet tint: a checkbox and a slider, remembered per browser. Unticked means no blue at all; the slider keeps
  // its value for the next time the tint is switched on. The panels' ricochet labels follow (updateShell).
  (function(){var on=$('ricochet-tint-on'),input=$('ricochet-tint'),out=$('ricochet-tint-value'),row=input.parentNode,stored=NaN,storedOn=null;
    try{var raw=window.localStorage.getItem('bullba-tint');stored=raw===null?NaN:Number(raw);storedOn=window.localStorage.getItem('bullba-tint-on');}catch(e){}
    if(stored>=0&&stored<=150)input.value=stored;if(storedOn==='on'||storedOn==='off')on.checked=storedOn==='on';
    var apply=function(){ricochetTint=on.checked?Number(input.value)/100:0;out.textContent=input.value+' %';row.classList.toggle('off',!on.checked);if(viewer)viewer.setTint(ricochetTint);};apply();
    input.oninput=function(){apply();try{window.localStorage.setItem('bullba-tint',input.value);}catch(e){}updateShell();};
    on.onchange=function(){apply();try{window.localStorage.setItem('bullba-tint-on',on.checked?'on':'off');}catch(e){}updateShell();};})();
  // Ricochet dots: a checkbox and the spacing slider, remembered per browser; a 'Tint + dots' choice made before 0.7.3
  // carries over as the checkbox.
  (function(){var on=$('ricochet-dots-on'),input=$('ricochet-dots'),out=$('ricochet-dots-value'),row=input.parentNode,stored=NaN,storedOn=null;
    try{var ls=window.localStorage,raw=ls.getItem('bullba-dots-spacing')||ls.getItem('bullba-hatch');stored=raw===null?NaN:Number(raw);storedOn=ls.getItem('bullba-dots')||(ls.getItem('bullba-mark')==='dots'?'on':null);}catch(e){}
    if(stored>=3&&stored<=24)input.value=stored;if(storedOn==='on'||storedOn==='off')on.checked=storedOn==='on';
    var apply=function(){out.textContent=input.value+' px';row.classList.toggle('off',!on.checked);if(viewer)viewer.setDots(on.checked,input.value);};apply();
    input.oninput=function(){apply();try{window.localStorage.setItem('bullba-dots-spacing',input.value);}catch(e){}};
    on.onchange=function(){apply();try{window.localStorage.setItem('bullba-dots',on.checked?'on':'off');}catch(e){}};})();
  // Part seams and the zone outline: remembered per browser.
  [['part-edges','bullba-edges','on',function(v){if(viewer)viewer.setPartEdges(v==='on');}],['zone-outline','bullba-outline','off',function(v){if(viewer)viewer.setZoneOutline(v==='on');}]].forEach(function(row){
    var select=$(row[0]),stored=null;try{stored=window.localStorage.getItem(row[1]);}catch(e){}
    if(stored==='on'||stored==='off')select.value=stored;else select.value=row[2];row[3](select.value);
    select.onchange=function(){row[3](this.value);try{window.localStorage.setItem(row[1],this.value);}catch(e){}};});
  $('heatmap-quality').onchange=host.guard('Detail',function(){if(host.game&&this.value==='high'){this.value=viewer?viewer.quality:'auto';return;}if(viewer)viewer.setQuality(this.value);});
  // Last item of the toolbar row: the explored pose (when it differs) and the gun's vertical limits at the
  // current turret angle. Gun readouts: up positive, down negative (the client's pitch is the other way round).
  // The shortcut list that used to sit under the scene is gone; #viewport keeps the same text as its aria-label.
  function poseChanged(){if(!viewer)return;var off=!(Math.abs(viewer.turretAngle)<.1&&Math.abs(viewer.gunAngle)<.1),sign=function(v){return (v>0?'+':'')+Math.round(v)+'°';},g=viewer.gunRange();$('turret-notice').hidden=!off;if(off)$('turret-notice').textContent='Turret '+sign(viewer.turretAngle)+', gun '+sign(-viewer.gunAngle)+' from the recorded pose (hit marks hidden)';$('gun-limits').textContent=g.known?'Gun '+sign(-g.max)+' … '+sign(-g.min)+' at this turret angle':'Gun limits not recorded';staleEstimate();shotStats();}
  function pivotButtons(){if(!viewer)return;$('pivot-hit').disabled=!viewer.point;$('pivot-vehicle').setAttribute('aria-pressed',String(viewer.pivot!=='hit'));$('pivot-hit').setAttribute('aria-pressed',String(viewer.pivot==='hit'));}
  $('pivot-vehicle').onclick=function(){if(viewer)viewer.setPivot('vehicle');pivotButtons();};$('pivot-hit').onclick=function(){if(viewer)viewer.setPivot('hit');pivotButtons();};
  if(viewer)viewer.onTurret=poseChanged;
  if(viewer)viewer.onGun=poseChanged;
  $('fit-camera').onclick=function(){if(viewer)viewer.fit();};
  // The shooter tile swaps the roles; on a swapped view it goes back to the recorded hit. The list
  // selection stays on the recorded hit either way - the swap is a view of it, not another hit.
  $('shooter-tile').onclick=function(){
    if(sidebarMode==='vehicles'){activeRole='shooter';roleTiles();return;}
    if(swapped)return void selectHit(swapped.base).catch(function(){});
    var hit=activeHit;if(!hit||hit.synthetic||!swapReady(hit)||!current)return;
    var synthetic=swapHit(hit),token=++generation;message('Preparing the model\u2026');if(viewer)viewer.clear();
    ArmorInspectorData.sceneFor(current,synthetic).then(function(data){if(token!==generation)return;display(data,false);})
      .catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}});
  };
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
  $('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);};
  var CONTEXT_LOST='The browser lost its WebGL context. Reload the page.';
  window.addEventListener('armor-context-lost',function(){if(host.mark)host.mark('WebGL','context-lost');message(CONTEXT_LOST);});
  // The context came back and the viewer has redrawn: take the reload notice away again, leave any other message.
  window.addEventListener('armor-context-restored',function(){if(host.mark)host.mark('WebGL','context-restored');if($('scene-message').textContent===CONTEXT_LOST)message('');});
  function outline(){if(viewer)viewer.setOutline(Number($('outline-brightness').value)/100,Number($('outline-opacity').value)/100);}
  $('outline-brightness').oninput=outline;$('outline-opacity').oninput=outline;if(viewer){viewer.wireframe($('wireframe').checked);outline();}
  // Toolbar overflow (18.09): the row never wraps. Each group carries data-tb — its keep priority, 1 kept
  // longest — and layoutToolbar() hands the highest numbers to the “More” popover until the rest fit on one
  // line, taking them back when the window widens. insertBefore moves the nodes themselves, so every id and
  // every listener inside a group survives the move.
  var toolbar=document.querySelector('.scene-toolbar'),moreBox=document.querySelector('.toolbar-more');
  var popover=moreBox?moreBox.querySelector('.toolbar-popover'):null,tbWidth={},tbFrame=0;
  var tbGroups=toolbar?[].slice.call(toolbar.querySelectorAll('[data-tb]')):[];
  var tbRank=function(g){return Number(g.getAttribute('data-tb'));};tbGroups.sort(function(a,b){return tbRank(a)-tbRank(b);});
  function tbRow(g){var rank=tbRank(g),before=null;
    tbGroups.forEach(function(o){if(!before&&o.parentNode===toolbar&&tbRank(o)>rank)before=o;});
    toolbar.insertBefore(g,before||moreBox);}
  function layoutToolbar(){
    if(!toolbar||!moreBox||!popover||!toolbar.clientWidth)return;
    tbGroups.forEach(function(g){if(g.parentNode!==toolbar)tbRow(g);});
    moreBox.hidden=true;moreBox.open=false;
    var style=window.getComputedStyle(toolbar),gap=parseFloat(style.columnGap)||0;
    var room=toolbar.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0);
    var live=tbGroups.filter(function(g){return !g.hidden;}),total=0;
    // A group's width is measured in the row and remembered: a group that is in the popover measures 0.
    live.forEach(function(g,i){var key=g.getAttribute('data-tb'),w=g.offsetWidth;if(w)tbWidth[key]=w;total+=(tbWidth[key]||0)+(i?gap:0);});
    if(total<=room)return;
    moreBox.hidden=false;var budget=room-moreBox.offsetWidth-gap;
    for(var i=live.length-1;i>=0&&total>budget;i--){total-=(tbWidth[live[i].getAttribute('data-tb')]||0)+gap;popover.insertBefore(live[i],popover.firstChild);}
  }
  function scheduleToolbar(){if(tbFrame||!toolbar)return;tbFrame=window.requestAnimationFrame(function(){tbFrame=0;layoutToolbar();});}
  window.addEventListener('resize',scheduleToolbar);
  // Closing on a click outside is written out here: the settings menu has no such handler to reuse.
  document.addEventListener('click',function(e){if(moreBox&&moreBox.open&&!moreBox.contains(e.target))moreBox.open=false;});
  layoutToolbar();
  if(host.interrupted){$('host-note').hidden=false;$('host-note').textContent='The previous session was interrupted during “'+host.interrupted.action+'» ('+(host.interrupted.host==='game'?'in the game':'in the browser')+', '+new Date(host.interrupted.at).toLocaleString('en-GB')+'). Mention this when reporting.';}
  (function(){var pv=$('app-version').getAttribute('data-version');if(pv!=='dev')$('app-version').textContent=pv;}());
  host.done();
  // The catalogue is read once at start when the fragment names a vehicle, whatever the remembered mode is.
  restoreSidebar();
  refresh();applyFragment(true);
  window.addEventListener('hashchange',function(){applyFragment(false);});
  // The same poll watches the viewer's frame loop: a frame that the host never delivered is dropped here, and
  // the frame-rate figure is refreshed (or cleared) even when nothing is being drawn.
  window.setInterval(function(){if(viewer){if(viewer.kick)viewer.kick();frameBadge();}refresh();if(sidebarMode==='vehicles')loadCatalogue();},5000);
  if(document.modelContext&&document.modelContext.registerTool){try{document.modelContext.registerTool({name:'select_saved_hit',description:'Open an existing recorded hit in the local 3D viewer.',inputSchema:{type:'object',properties:{battleId:{type:'string'},hitId:{type:'string'}},required:['battleId','hitId'],additionalProperties:false},execute:function(input){if(!input||!/^[-a-zA-Z0-9_]{1,100}$/.test(input.battleId)||!/^\d+$/.test(input.hitId))throw new Error('Invalid record identifiers');return loadBattle(input.battleId,true).then(function(){return selectHit(input.hitId);});}});}catch(e){console.warn('WebMCP unavailable',e);}}
}());
