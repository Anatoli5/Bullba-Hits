(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
  var shellNames={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'},candidates=[],activeHit=null,shotContext=null,manualPen='',lastDistance=null,analysisKey=null,recordsVersion='';
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
  function requestExport(v){sendCommand('exportVehicle',{vehicleType:String(v.type||'')});}
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
    scheduleLayout();
    mode=mode==='vehicles'?'vehicles':'battles';
    var changed=mode!==sidebarMode;sidebarMode=mode;
    document.querySelectorAll('#sidebar-mode [data-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===mode));});
    $('battles-pane').hidden=mode!=='battles';$('vehicles-pane').hidden=mode!=='vehicles';
    // The heading carries the battle picker in the Battles mode and a plain vehicle name in the other:
    // one of the two is on screen at a time, both keep their ids and their listeners.
    $('battles').hidden=mode!=='battles';$('battle-map').hidden=mode==='battles';
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
  // ================= collision models that are still coming =================
  // Since 0.7.11 the exporter publishes a hit the moment it is recorded and
  // extracts the collision models afterwards, one at a time, never during a
  // battle. A part with 'modelPending' is therefore not missing, it is on its
  // way: the page shows a spinner instead of a warning, asks the mod to put this
  // hit's vehicles at the front of its queue, and reads the index every 2 s
  // instead of 5 until the models land (the exporter rewrites the battle and
  // bumps the index stamp, and hitFingerprint then rebuilds the scene).
  var EXTRACTING='Extracting the collision model…',modelsPending=false,prioritisedHit=null;
  function partsOf(vehicle){return (vehicle&&vehicle.parts)||[];}
  function pendingParts(hit){
    var target=partsOf(hit&&hit.target).some(function(p){return p.modelPending;});
    var attacker=partsOf(hit&&hit.attacker).some(function(p){return p.modelPending;});
    return {target:target,attacker:attacker,any:target||attacker};
  }
  // local-data.js turns a part without a modelKey into a warning. A pending part is
  // no fault of the record, so its line is dropped here and the spinner says it.
  function pendingWarnings(lines,hit){
    var dropped={};
    partsOf(hit&&hit.target).forEach(function(p){if(p.modelPending)dropped[p.name+': Model or part position not saved']=true;});
    return lines.filter(function(line){return !dropped[line];});
  }
  // One page -> mod command, fire and forget. Outside the game there is no channel
  // and nothing is attempted; the external browser simply waits for the files.
  function sendCommand(action,params){
    if(!host.canSend())return;
    var payload={action:action};
    if(params)Object.keys(params).forEach(function(k){payload[k]=params[k];});
    host.send('bullba_hits',payload).catch(function(e){
      if(window.console)console.warn('Bullba Hits '+action+' command failed: '+e.message);});
  }
  // The mod holds its extractions back while the user is working in the page: one
  // message a second is enough for the two-second window on the mod's side.
  var busySentAt=0;
  function sendBusy(){var now=Date.now();if(now-busySentAt<1000)return;busySentAt=now;sendCommand('busy',null);}
  function noteModelsPending(hit,pend){
    var key=(current?current.id:'')+'/'+(hit?hit.id:'');
    if(pend.any&&key!==prioritisedHit){
      prioritisedHit=key;
      var types=[(hit.target||{}).type,(hit.attacker||{}).type].filter(Boolean).slice(0,8);
      if(types.length)sendCommand('prioritise',{vehicleTypes:types});
    }else if(!pend.any&&key===prioritisedHit)prioritisedHit=null;
    if(pend.any!==modelsPending){modelsPending=pend.any;schedulePoll();}
  }
  function message(text,spinner){var e=$('scene-message');e.textContent=text;e.hidden=!text;e.classList.toggle('busy',!!(text&&spinner));}
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
    candidates.forEach(function(c,i){var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name+(c.gunInstallation>0?' · ability gun':''));o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — manual');o.value=kind;choice.appendChild(o);});
    if(candidates.length>1&&!(hit&&hit.vehicle)){var uncertain=node('option','Pick a shell — several matches');uncertain.value='';choice.insertBefore(uncertain,choice.firstChild);}
    choice.value=shotContext.index>=0?'saved:'+shotContext.index:candidates.length?'':shotContext.kind||'ARMOR_PIERCING';
    // A browsed vehicle has no hit to identify a shell, so resolve() leaves the index at -1. The shooter's own
    // list is nevertheless the right set of choices: preselect the first AP-like shell so the model is coloured
    // the moment a vehicle is picked, instead of “pick a shell”.
    if(hit&&hit.vehicle&&candidates.length){var first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING';});
      if(first<0)first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING_CR';});if(first<0)first=0;choice.value='saved:'+first;}
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,b=node('button',(actual?'● ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100)+(c.gunInstallation>0?' ✦':''),'shell-chip');b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' mm · '+(c.gunInstallation>0?'ability gun'+(c.gun?' '+c.gun:'')+' · ':'')+(actual?'Type from the hit':'Compare with this shell');b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    syncTargetMods(hit);
    if(keep){choice.value=keep.kind;manualPen=keep.penetration;$('penetration').value=keep.penetration;$('caliber').value=keep.caliber;penLabel(false);updateShell();}
    else selectShell();
    // The shooter's chips just changed, so the shell block wants a different width: re-measure the heading.
    scheduleLayout();
  }
  // The spall-liner factor of the vehicle under fire: the hit's target, or the browsed vehicle's own record.
  // Records written before 0.7.13 carry none, and without one the law reads the target as unlined (1.0).
  function linerFactor(hit){var t=(hit||activeHit||{}).target;return t&&t.linerFactor>0?t.linerFactor:1;}
  // Target modifiers (19.09): three things of the client multiply miscAttrs/antifragmentationLiningFactor and
  // the record cannot tell them apart - the mounted spall liner, the field modification “Spalling resistance”
  // and the driver's Reliable Placement. C = liner x field x (1 + 0.15 x skill), and the non-penetration
  // damage of HE divides by C. The recorded factor certainly carries the liner, may carry the field
  // modification and never carries the crew skill, so it only sets the switches' starting position. The
  // choice is kept per vehicle type for the session: the next hit on the same vehicle keeps what the user
  // set, a new vehicle starts from its own record. Nothing is written to localStorage in this version.
  var targetMods=null,modsState={},modsType='',modsRecorded=0;
  function modsDefaults(rec){return {liner:rec>=1.55?'1.6':rec>=1.4?'1.5':'1',fieldmod:'1',skill:'0'};}
  function modsFactor(v){var f=Number(v.liner)*Number(v.fieldmod)*(1+.15*Number(v.skill));return f>0?f:1;}
  // Every shell is built for the vehicle it is fired at: the displayed target follows the switches, any other
  // vehicle of the automatic verdict pass keeps the factor its own record carries.
  function targetFactor(hit){
    var t=(hit||activeHit||{}).target,type=t&&t.type?String(t.type):'',state=type?modsState[type]:null;
    return state?modsFactor(state):linerFactor(hit);
  }
  function buildTargetMods(){
    var slot=$('target-mods-slot');
    if(!slot||!window.ModifierGroup)return;
    targetMods=ModifierGroup.create({id:'target-mods',title:'Target',host:slot,
      summary:function(v){var out=['liner ×'+Number(v.liner).toFixed(1)];
        if(Number(v.fieldmod)!==1)out.push('field ×'+Number(v.fieldmod).toFixed(2));
        if(v.skill==='1')out.push('driver +15 %');return out.join(' · ');},
      options:[
        {id:'liner',label:'Liner',kind:'choice',value:'1',
         title:'Spall liner (optional device): none ×1.0, mounted ×1.5, the same liner in the bonus slot ×1.6. The light, medium, heavy and superheavy variants all carry the same factor (optional_devices.xml, antifragmentationLining tiers 1–4).',
         choices:[{value:'1',label:'None',title:'No spall liner · ×1.0'},
           {value:'1.5',label:'Liner ×1.5',title:'Spall liner in an ordinary slot · ×1.5'},
           {value:'1.6',label:'Improved ×1.6',title:'The same liner in the bonus slot (improved) · ×1.6'}]},
        {id:'fieldmod',label:'Field mod.',kind:'choice',value:'1',
         title:'Field modification “Spalling resistance”, HT assault / HT universal / LT roles (post_progression/field_modifications.xml). It is one side of a pair — the other side takes speed instead — and no other role has it.',
         choices:[{value:'0.85',label:'−',title:'The other side of the pair · ×0.85'},
           {value:'1',label:'default',title:'No such field modification · ×1.00'},
           {value:'1.15',label:'+',title:'Spalling resistance · ×1.15'}]},
        {id:'skill',label:'Driver skill',kind:'toggle',value:'0',
         title:'Driver skill “Reliable Placement”: +15 % at 100 % skill (tankmen.xml driver_reliablePlacement → perks.xml id 304, antifragmentationLining 0.0015 per point). The per-point scaling is a reading of the client XML, not a verified rule.',
         choices:[{value:'0',label:'Off',title:'Not trained · ×1.00'},
           {value:'1',label:'+15 %',title:'Trained to 100 % · ×1.15 · the scaling is read from the client XML, not verified'}]}],
      onChange:function(){if(modsType)modsState[modsType]=targetMods.values();updateShell();}});
  }
  // A new vehicle on screen: its own remembered switches, or fresh ones read from the factor of its record.
  function syncTargetMods(hit){
    if(!targetMods)return;
    var t=hit&&hit.target||null,type=t&&t.type?String(t.type):'';
    modsType=type;modsRecorded=t&&t.linerFactor>0?t.linerFactor:0;
    if(type&&!modsState[type])modsState[type]=modsDefaults(modsRecorded);
    targetMods.setDefaults(modsState[type]||modsDefaults(0));
    targetMods.element.title='What this vehicle has fitted against spalling: C = liner × field modification × (1 + 0.15 × driver skill). The non-penetration damage of HE divides by C. '+
      (modsRecorded>0?'recorded ×'+modsRecorded.toFixed(2)+' — the factor the client’s descriptor carried here: it holds the mounted liner, may hold the field modification, never the crew skill.':'This record carries no factor — the switches start unlined.')+
      ' Kept per vehicle type until the page is reloaded.';
  }
  // The switches have something to change only while a model is on screen and the map is drawn in damage: in
  // chance mode the factor is a no-op, so they leave with the damage caption instead of sitting dead.
  function modsVisible(){
    var slot=$('target-mods-slot');
    if(!slot||!targetMods)return;
    var show=!!(damageView&&modsType&&!$('model-tile').hidden);
    if(slot.hidden===!show)return;
    slot.hidden=!show;if(!show)targetMods.close();
    layoutMods(); // placed in the same task it appears in, so it is never painted at the unpositioned corner
  }
  function shellAt(c,choice,penetration,caliber,distance,hit){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    shell.liner=targetFactor(hit);
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration',
      'alpha','spallDamage','mechanics','nonPiercingArmorDamage'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});var fraction=Math.max(0,Math.min(1,(distance-100)/400));if(c.penetration500>0&&c.penetration100>0)shell.penetration=penetration*(1+fraction*(c.penetration500/c.penetration100-1));}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null,verdictKey=null,partNames=['chassis','hull','turret','gun'];
  // Verdict log (user, 14.09): one console line per recorded contact point - the server's result as a fact next to our
  // estimate along the drawn line. The game writes the page's console into game.log; tools/verdicts_from_log.py
  // tabulates the lines. Once per hit and shell, never on camera moves.
  var verdictLines=0,verdictQueue=[],verdictDone={},verdictTimer=null,verdictBusy=false;
  function verdictLine(battleId,hit,v,shell,mode){var r=v.result||{},chance=r.chance;
    var ours=r.reason==='ricochet'?'ricochet':chance===null||chance===undefined?(r.reason||'none'):(chance>=50?'pen':'no-pen')+'_'+chance+'%';
    console.info('Bullba Hits verdict: battle='+battleId+' hit='+hit.id+' point='+v.index+' part='+(partNames[v.part]||v.part)+' server='+String(effects[v.effect]||v.effect).replace(/ /g,'_')+' ours='+ours+' angle='+(r.angle!=null?Math.round(r.angle):'-')+' eff='+(r.effective!=null?Math.round(r.effective):'-')+' pen='+Math.round(shell.penetration)+' shell='+shell.kind+' dir='+v.source+' chordDev='+(v.chordDev==null?'-':(v.chordDev*180/Math.PI).toFixed(1))+' mode='+mode+damageColumns(hit,r,shell)+' v='+($('app-version').getAttribute('data-version')||'dev').replace(/\s+/g,'_')+' rec='+(recordsVersion||'-'));
    verdictLines++;verdictStatus();}
  // HE damage columns of the log line: the server's damage for this hit next to both candidate laws for the
  // non-penetration part - the ratio law the page draws and the linear legacy shape (k = 1.1), which is written
  // here only so recorded hits can decide between them later. Nothing else in the page reads nonPenLin.
  function damageColumns(hit,r,shell){
    if(shell.kind!=='HIGH_EXPLOSIVE'||!(shell.alpha>0))return '';
    var plate=r.reason==='penetration'&&r.nominal>0?r.nominal:null,liner=shell.liner>0?shell.liner:1;
    // liner= is the factor the numbers were computed with (the switches of the Target group); linerRec= is what
    // the record carried, so a line is still readable when the user has moved the switches by hand.
    var rec=hit&&hit.target&&hit.target.linerFactor>0?hit.target.linerFactor:0;
    var p=r.chance===null||r.chance===undefined?null:r.chance/100;
    var ratio=plate?ArmorBallistics.nonPenetration(shell,plate).damage:0;
    var lin=plate?Math.max(0,(shell.spallDamage>0?shell.spallDamage:0)-1.1*plate*liner):0;
    var expected=function(np){return p===null?'-':Math.round(p*shell.alpha+(1-p)*np);};
    return ' dmg='+(hit.damage>0?hit.damage:'-')+' alpha='+Math.round(shell.alpha)+' plate='+(plate?Math.round(plate):'-')+
      ' liner='+liner.toFixed(2)+' linerRec='+(rec>0?rec.toFixed(2):'-')+' nonPenRatio='+Math.round(ratio)+' nonPenLin='+Math.round(lin)+
      ' expRatio='+expected(ratio)+' expLin='+expected(lin)+' law='+(r.damageLaw||'ratio');
  }
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
      var range=context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:100,shell=c?shellAt(c,c.kind,c.penetration100,c.caliber,range,hit):null;
      if(!shell)return;var engine=ArmorBallistics.build(data,false),pts=ArmorViewer.points(hit);
      ArmorViewer.verdicts(engine,pts,shell).forEach(function(v){verdictLine(battle.id,hit,v,shell,context.index>=0?'auto':'auto-shell-guess');});
    }).catch(function(e){if(window.console)console.warn('Bullba Hits verdict: hit '+hit.id+' skipped: '+e.message);})
      .then(function(){verdictBusy=false;verdictStatus();if(verdictQueue.length)verdictTimer=setTimeout(drainVerdicts,150);});
  }
  // Header line: the verdict log is on, with the count so far; the (i) explains what it is for.
  function verdictStatus(){var e=$('connection');if(!e)return;e.textContent='Statistics log \u00b7 '+verdictLines+' points'+(verdictQueue.length?' \u00b7 checking '+verdictQueue.length+' more':'');}
  function shotStats(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var range=viewer?viewer.distance:100;
    var shell=shellAt(c,choice,Number($('penetration').value),Number($('caliber').value),range),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null,range);fillPanel('shot',line);
    logVerdicts(shell);
    // The tile's own tooltip says what its number is before it says where the line comes from.
    $('shot-panel').title=damageView?'Expected damage per shot along the saved hit line: the penetration chance times alpha, plus the reconstructed non-penetration damage for the rest.\n\nThe record holds what the shot did; this is the expectation it had, not the rolled RNG.':shotPanelTitle;
    aimTitle();
    output.title=!r?'No parameters or the pose changed':pinned?'Along the pinned line from the current view':'Along the saved line · flight ≈ '+Math.round(range)+' m · nominal penetration '+Math.round(shell.penetration)+' mm';
    var key=JSON.stringify(shell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'');
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;clearTimeout(totalTimer);
      // No saved circle: the nominal ring's diameter, so a 10 cm ring at short range reads as present, not missing.
      $('total-chance').textContent=!viewer.savedAim&&viewer.estimateAim?'\u2300 '+(viewer.estimateAim.radius*2).toFixed(2)+' m':'—';
      // In damage mode the tile reads in HP: the mean expected damage over the circle, misses counted as 0.
      if(viewer.savedAim&&shell)totalTimer=setTimeout(function(){var v=viewer.savedAimProbability(shell);
        $('total-chance').textContent=!v?'—':damageView?'≈ '+(v.unknown?Math.round(v.damage)+'–'+Math.round(v.damageHigh):Math.round(v.damage))+' HP':'≈ '+(v.unknown?v.low.toFixed(0)+'–'+v.high.toFixed(0):v.low.toFixed(0))+'%';},100);
    }
  }
  // The reticle tile's tooltip: what its number means first, then which circles this hit has and how the figure
  // is sampled. The status half is written once per hit by display(); the mode half changes with the Display
  // setting, so the whole title is rebuilt from both.
  var aimStatus='',shotPanelTitle=$('shot-panel').title;
  function aimTitle(){
    $('aim-metric').title=(damageView?'Expected damage per shot from this reticle, HP: a random shot inside the saved circle, the mean of penetration damage and the reconstructed non-penetration damage.':'Chance to penetrate from this reticle: a random shot inside the saved circle that both hits and penetrates. Nominal penetration, no RNG.')+
      ' Reticle circles on the model. '+aimStatus+' Over the saved circle: Gaussian, σ = radius/2; 256 rays, misses = 0. Server formula not confirmed'+(damageView?'; the non-penetration part is a reconstruction (ratio law). No map obstacles, target motion or splash onto other parts.':'; no map obstacles, target motion or blast damage.');
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
    // Damage mode says out loud that the non-penetration part is a reconstruction; without an alpha in the
    // record the old sentence stands, because then nothing but the penetration is drawn anyway.
    var damageNote=(c?c.kind:choice)==='HIGH_EXPLOSIVE'&&shell&&shell.alpha>0?'HE non-penetration damage: reconstruction (ratio law), not a confirmed server formula.':'HE: penetration only, no blast damage.';
    var sourceTitle=source+' · '+(shotContext?shotContext.source:'')+' · Nominal penetration at the current distance, not the rolled RNG. '+damageNote;
    $('shell-choice').title=sourceTitle;if(shellGroup)shellGroup.title=sourceTitle;
    document.querySelectorAll('[data-shell]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.shell===choice));});
    var kind=c?c.kind:choice;document.querySelectorAll('#shell-types [data-kind]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.kind===kind));});
    // 'chance' and 'damage' both colour the armour on the same palette and share every check below; only the
    // labels differ. A record without an alpha cannot be coloured by damage: the page falls back to the chance
    // and says so where the missing-parameter notice already is.
    var mode=$('armor-mode').value,mapMode=mode!=='parts';
    damageView=mode==='damage'&&!!(shell&&shell.alpha>0);
    var noAlpha=mode==='damage'&&valid&&!damageView;
    $('parameters-notice').textContent=noAlpha?'No damage data in this record — showing penetration chance':!choice?'Pick a shell — the record holds more than one match.':!valid?'No penetration in the record — enter the penetration and calibre to colour the model.':'Pick a shell or enter penetration and calibre to colour the model.';
    $('legend-gradient').classList.toggle('classic',$('palette').value==='classic');$('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');$('armor-legend').hidden=!mapMode||!valid;$('parameters-notice').hidden=!mapMode||(valid&&!noAlpha);
    var caption=$('legend-caption');caption.hidden=!damageView;caption.textContent=damageView?'Expected damage per shot, % of α (α = '+Math.round(shell.alpha)+' HP)':'';
    caption.title=damageView?'Non-penetration damage of HE is a reconstruction (ratio law), not a confirmed server formula':'';
    $('penetration').setAttribute('aria-invalid',String(mapMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(mapMode&&!(caliber>0&&caliber<=1000)));
    $('probe-chance').textContent='—';$('probe-chance').style.color='';$('probe-pen').replaceChildren();$('probe-extra').replaceChildren();$('probe-details').replaceChildren(node('span','Hover over the armour','placeholder'));
    modsVisible();
    staleEstimate();if(viewer)viewer.configure(shell,mapMode,$('palette').value,mode);shotStats();
  }
  var shellGroup=document.querySelector('.shell-fields');
  var ricochetTint=.5; // the Ricochet tint row of Settings, 0 (off)..1.5; the panels' ricochet colours follow the map
  // Display = Expected damage, with a shell that carries an alpha: the panels read in HP and take their colours
  // from the same quantity the map is drawn with. Set by updateShell, read everywhere the numbers are written.
  var damageView=false;
  function chanceRgb(r){return 'rgb('+ArmorBallistics.color(r,$('palette').value,ricochetTint,damageView?'damage':'chance').map(function(v){return Math.round(v*255);}).join(',')+')';}
  function damageHp(r){return Math.round(r.expected)+' HP';}
  // What the expected damage is made of, for the panel under the number: the penetration chance it came from,
  // and the non-penetration damage of the ratio law with the three figures behind it. Legacy HE (SPG) says
  // instead that its splash is not modelled - there is no client-side rule for it to show.
  function damageGroups(r){
    var s=viewer&&viewer.shell;if(!s)return [];
    if(r.damageLaw==='legacy-unknown')return [{kind:'damage',text:'splash not modelled'}];
    if(r.damageLaw==='special-unknown')return [{kind:'damage',text:'non-pen not modelled',title:'This shell has its own spall absorption rule; the recorded shots of the Reddit study fit no law we can check.'}];
    if(r.damageLaw!=='ratio'||!(r.nonPen>0)||r.chance===null||r.chance===undefined)return [];
    var liner=s.liner>0?s.liner:1,pass=r.screenPass===undefined||r.screenPass===null?1:r.screenPass;
    var groups=[{kind:'damage',text:'pen '+Math.round(r.chance)+' %'},
      {kind:'damage',text:'non-pen '+Math.round(r.nonPen)+' HP',
       // Two decimals: the liner is no longer one device factor but the product of the Target switches (1.725).
       title:'spall '+Math.round(s.spallDamage||0)+' HP · plate '+Math.round(r.nominal)+' mm · liner ×'+liner.toFixed(2)}];
    // A screen on the way: the chance the shell gets through it at all; below it the shell explodes on the screen
    // and deals nothing, so the non-penetration damage only counts in the gap between passing and piercing.
    if(pass<.995)groups.push({kind:'damage',text:'through screen '+Math.round(pass*100)+' %',title:'Chance to pass the screen(s); stopped there, the shell deals no damage at all'});
    return groups;
  }
  // Compact reading of one ballistic result: the chance first, then the numbers that explain it.
  // One ballistic result as readable groups: chance, then "effective ← nominal – angle", then "pen / range", then screens.
  function armorLine(r,pen,range){
    if(!r)return {label:'—',color:'',groups:[]};
    var prefix=[],hp=damageView&&r.expected!==null&&r.expected!==undefined;
    if(r.bounce){var b=r.bounce;pen=b.penetration;prefix.push({kind:'ricochet',text:'ricochet '+Math.round(b.nominal)+' mm – '+Math.round(b.angle)+'°'+(b.loss?' · pen −'+Math.round(b.loss*100)+'%':'')});}
    var layers=r.layers||[],screens=layers.filter(function(l){return !l.main;}),extra=screens.length?[{kind:'screen',text:'+ '+screens.map(function(s){return Math.round(s.nominal)+' mm';}).join(' + ')+' screen'}]:[];
    var shell=pen?[{kind:'pen',text:'pen '+Math.round(pen)+' mm'+(range?' / '+Math.round(range)+' m':'')}]:[];
    var zero=chanceRgb({chance:0,expectedShare:0}),bounced=chanceRgb({chance:0,expectedShare:0,reason:'ricochet'});
    if(r.reason==='ricochet')return {label:'Ricochet',color:bounced,groups:prefix.concat([{kind:'armor',text:(r.final?'again, shell lost: ':'')+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],shell,extra)};
    if(r.reason==='screen')return {label:hp?'0 HP':'0%',color:zero,groups:prefix.concat([{kind:'armor',text:'explodes on the screen (this HE cannot pass screens)'}],shell,extra)};
    if(r.reason==='no-hull')return r.bounce?{label:hp?'0 HP':'0%',color:bounced,groups:prefix.concat([{kind:'armor',text:'flies past after the ricochet'}],shell)}:{label:'—',color:'',groups:[{kind:'armor',text:'no main armour on this line'}]};
    if(r.reason==='parameters')return {label:'—',color:'',groups:[{kind:'armor',text:'set penetration and calibre'}]};
    if(r.reason==='armor')return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no armour data for this surface'}])};
    if(r.chance===null)return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no estimate for this penetration distribution'}])};
    return {label:hp?damageHp(r):r.chance+'%',color:chanceRgb(r),groups:prefix.concat([{kind:'armor',text:'eff '+Math.round(r.effective)+' mm ← '+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],hp?damageGroups(r):[],shell,extra)};
  }
  function chips(container,line){container.replaceChildren();line.groups.forEach(function(g){var chip=node('span',g.text,'chip '+g.kind);if(g.title)chip.title=g.title;container.appendChild(chip);});}
  // Fill an info panel: the penetration chip sits in the title row, the chance and the armour chips below it.
  function fillPanel(prefix,line){var by=function(k){return line.groups.filter(function(g){return (g.kind==='screen')===(k==='screen')&&(k==='screen'||(g.kind==='pen')===(k==='pen'));});};
    var chance=$(prefix+'-chance');chance.textContent=line.label;chance.style.color=line.color;chips($(prefix+'-pen'),{groups:by('pen')});chips($(prefix+'-details'),{groups:by('rest')});chips($(prefix+'-extra'),{groups:by('screen')});}
  function inspectArmor(r){
    var range=viewer?viewer.distance:100;
    fillPanel('probe',armorLine(r,viewer&&viewer.shell?viewer.shell.penetration:null,range));
  }
  // Heading: which battle this is - date and start time, the map, and the vehicle the player was in.
  function battleStamp(seconds){if(!Number.isFinite(seconds))return '';var d=new Date(seconds*1000);return d.toLocaleDateString('en-GB')+' \u00b7 '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
  // ====================== The vehicle the battle is read from ======================
  // The recorder writes every hit the client showed, not only the player's own, and a roster of the battle's
  // vehicles. The picker chooses whose seat the list is read from: his hits and the hits on him - any vehicle
  // of either team, since an enemy's hits and the hits on him read exactly the same way (his aim is never
  // recorded, so his outgoing hits carry no reticle, as an incoming one does). 'direction' in the record stays
  // relative to the player, so the page reads the direction of the focused vehicle instead (viewDirection).
  // Battles recorded before this carry no roster and no vehicle ids: the focus is then the player's own
  // vehicle and the stored 'direction' is used, which is exactly the old behaviour.
  var focusVehicle=null,focusStamp=null,focusNote='',focusScene=null,focusSceneKey=null;
  function rosterRows(){
    if(!current||!Array.isArray(current.roster))return [];
    return current.roster.filter(function(r){return r&&r.id!=null;});
  }
  function rosterRow(id){return id==null?null:(rosterRows().find(function(r){return r.id===id;})||null);}
  // The player's own vehicle id. The header's figure is not trusted on its own: an arena list that reached the
  // recorder before the client knew its own vehicle used to stamp playerVehicleId 0 into the header (fixed in
  // the recorder; records written earlier keep the 0), and 0 is no vehicle - it matches no hit, so the whole
  // page reads an empty battle. A positive id the roster confirms is taken as it is; otherwise it comes from
  // the hits, whose stored 'direction' is relative to the player: the attacker of the first outgoing hit, or
  // the target of the first incoming one.
  function playerId(){
    if(!current)return null;
    var own=current.playerVehicleId,rows=rosterRows(),hits=current.hits||[],i,h;
    if(Number.isFinite(own)&&own>0&&(!rows.length||rows.some(function(r){return r.id===own;})))return own;
    for(i=0;i<hits.length;i++){h=hits[i];if(h.direction==='outgoing'&&h.attackerId!=null)return h.attackerId;}
    for(i=0;i<hits.length;i++){h=hits[i];if(h.direction==='incoming'&&h.targetId!=null)return h.targetId;}
    return null;
  }
  // The player's team, which splits the picker in two: his own roster row first, the header's figure after it
  // (it is written in the same record as the roster, so it is missing exactly when the roster is).
  function playerTeam(){var row=rosterRow(playerId());return row&&row.team!=null?row.team:(current&&current.playerTeam!=null?current.playerTeam:null);}
  // Unknown teams count as allies: a roster row without a team is no reason to paint a vehicle red.
  function isAlly(row){var team=playerTeam();return team==null||row.team==null||row.team===team;}
  function focusId(){var own=playerId();return focusVehicle!=null?focusVehicle:own;}
  function focusIsPlayer(){var f=focusId();return !current||f==null||f===playerId();}
  // The direction of a hit as the focused vehicle sees it; null - the hit does not involve him and is not shown.
  // A synthetic hit (a browsed vehicle, a swapped shooter) carries no ids and keeps its own direction.
  function viewDirection(h){
    if(!h)return null;
    var focus=focusId();
    if(focus==null||h.attackerId==null||h.targetId==null)return h.direction||null;
    return h.attackerId===focus?'outgoing':h.targetId===focus?'incoming':null;
  }
  // The rows of the picker: the whole roster in two groups, the player first among the allies, the rest of
  // each group by vehicle name and then nickname.
  function pickerList(){
    var own=playerId(),allies=[],enemies=[];
    var byName=function(a,b){return String(a.name||'').localeCompare(String(b.name||''))||String(a.player||'').localeCompare(String(b.player||''));};
    rosterRows().forEach(function(r){if(r.id!==own)(isAlly(r)?allies:enemies).push(r);});
    allies.sort(byName);enemies.sort(byName);
    if(own!=null)allies.unshift(rosterRow(own)||{id:own,name:(ownVehicle()||{}).name||'My vehicle',player:''});
    return {allies:allies,enemies:enemies};
  }
  function pickerRow(row,side,star,focus){
    var b=node('button',undefined,'picker-row');b.type='button';
    b.setAttribute('data-id',String(row.id));b.setAttribute('data-side',side);
    b.setAttribute('aria-pressed',String(row.id===focus));
    b.appendChild(node('span',row.name||'Unknown vehicle','picker-vehicle'));
    b.appendChild(node('span',row.player||'','picker-player'));
    b.title=[row.name||'Unknown vehicle',row.player,side==='ally'?'Ally':'Enemy'].filter(Boolean).join(' · ');
    b.onclick=function(){chooseFocus(row.id);};
    return b;
  }
  // The control itself: a <details>, because a native <option> can neither push the nickname to the right edge
  // nor carry the team colour. The summary is the row in focus, the popover the two groups. Without a roster
  // (every battle recorded before 0.7.9) there is nothing to pick: the summary shows the player's vehicle as
  // read from the hits and the control stays shut, exactly as the disabled select did.
  function renderFocus(){
    var box=$('vehicle-focus'),list=$('focus-list'),own=playerId(),focus=focusId(),groups=pickerList();
    var rows=groups.allies.concat(groups.enemies),free=rows.length>1;
    var chosen=rows.find(function(r){return r.id===focus;});
    // A focus the roster no longer carries (another battle, a rewritten roster) falls back to the player.
    if(!chosen&&focusVehicle!=null){focusVehicle=null;focus=own;chosen=rows.find(function(r){return r.id===own;});}
    if(!chosen)chosen={id:own,name:(ownVehicle()||{}).name||'My vehicle',player:''};
    var stamp=(current?current.id:'')+'|'+focus+'|'+rows.map(function(r){return r.id+':'+(r.name||'')+':'+(r.player||'')+':'+(r.team==null?'':r.team);}).join(',');
    if(stamp!==focusStamp){
      focusStamp=stamp;list.replaceChildren();
      [['ALLIES','ally',groups.allies],['ENEMIES','enemy',groups.enemies]].forEach(function(group){
        if(!group[2].length)return;
        list.appendChild(node('div',group[0],'picker-group eyebrow'));
        group[2].forEach(function(r){list.appendChild(pickerRow(r,group[1],group[1]==='ally'&&r.id===own&&free,focus));});
      });
    }
    $('focus-vehicle').textContent=chosen.name||'Unknown vehicle';
    $('focus-player').textContent=chosen.player||'';
    box.setAttribute('data-side',(own!=null&&chosen.id===own)||isAlly(chosen)?'ally':'enemy');
    box.classList.toggle('is-locked',!free);
    box.querySelector('summary').setAttribute('aria-disabled',String(!free));
    if(!free)box.open=false;
  }
  // The focused vehicle: the target of any hit on it, or the attacker of any hit by it - his own hits and
  // nothing else, never another battle, the catalogue or the vehicle last browsed. A vehicle that is in the
  // roster but in no hit has no recorded descriptor: his roster row carries the name.
  function ownVehicle(){
    if(!current)return null;
    var inc=current.hits.find(function(h){return viewDirection(h)==='incoming'&&h.target&&h.target.name;});
    if(inc)return inc.target;
    var out=current.hits.find(function(h){return viewDirection(h)==='outgoing'&&h.attacker&&h.attacker.name;});
    if(out)return out.attacker;
    var row=rosterRow(focusId());
    return row&&row.name?{name:row.name,type:row.type}:null;
  }
  function focusName(){var own=ownVehicle();return (own&&own.name)||'this vehicle';}
  // A focused vehicle with no hits in this battle: his own collision model instead of an empty scene, with
  // himself as the shooter, so the chance map is his armour against his own gun. It is the very same synthetic
  // hit the Vehicles mode builds, read through the same loader - no hit point, no reticle, no shot line. The
  // heading stays the battle's; the hit list says in one muted line what is on screen. A vehicle the exporter
  // has not written yet (no catalogue row, no data file) leaves the scene cleared with the reason.
  function showFocusEmpty(){
    var id=focusId(),row=rosterRow(id),name=focusName(),base='No hits for '+name+' in this battle';
    var key=(current?current.id:'')+'/'+id;
    // Already on screen: an index bump that changed nothing must not reload the model and reset the camera.
    if(focusSceneKey===key&&focusScene&&activeHit&&activeHit.id===focusScene.hit.id){renderHits();return Promise.resolve();}
    var token=++generation;
    focusScene=null;focusSceneKey=null;focusNote='';
    if(viewer)viewer.clear();sceneTiles(null,false);warnings([]);$('details').replaceChildren();
    var type=row&&row.type?String(row.type):'';
    function fallback(reason){
      if(token!==generation)return;
      focusScene=null;focusSceneKey=null;focusNote='';
      if(viewer)viewer.clear();sceneTiles(null,false);message(reason);renderHits();
    }
    // No roster row, so no vehicle type to look up: the old battles' own wording, unchanged.
    if(!type){fallback(current&&current.hits.length?'No hits of this vehicle in the record. Shot details are available below.':'No hits recorded in this battle yet. Shot details are available below.');return Promise.resolve();}
    message('Preparing the model…');renderHits();
    // The catalogue may be half-read when a poll is running; one more read settles it before the row is missed.
    return (catalogue?Promise.resolve():loadCatalogue().then(function(){return catalogue?null:loadCatalogue();})).then(function(){
      var entry=((catalogue&&catalogue.vehicles)||[]).find(function(v){return String(v.type||'')===type;});
      if(!entry)throw new Error('not in the catalogue');
      return readVehicle(entry.id,0);
    }).then(function(record){
      if(token!==generation)return;
      var hit=vehicleHit(record,record);
      return ArmorInspectorData.sceneFor({warnings:[]},hit).then(function(data){
        if(token!==generation)return;
        focusScene=data;focusSceneKey=key;focusNote=base+' · model shown with its own gun';
        display(data,false);renderHits();
      });
    }).catch(function(){fallback(base+' · model not exported yet');});
  }
  // Another seat in the same battle: the list is rebuilt around that vehicle and a hit of his is opened at
  // once - a pick never leaves the scene empty (user, 19.09). With no hits at all his model is shown instead.
  function chooseFocus(id){
    var box=$('vehicle-focus');box.open=false;
    var wanted=!current||id==null||id===playerId()?null:id;
    if(wanted===focusVehicle)return; // the row already in focus: the camera and the open hit stay
    focusVehicle=wanted;
    selected=null;currentHitKey=null;++generation;swapped=null;focusScene=null;focusSceneKey=null;focusNote='';
    if(viewer)viewer.clear();sceneTiles(null,false);warnings([]);$('details').replaceChildren();
    renderHits();
    var first=current?current.hits.find(function(h){return !!viewDirection(h);}):null;
    if(first)return void selectHit(first.id).catch(function(){});
    showFocusEmpty();
  }
  function renderHeading(){
    var stamp=current?battleStamp(current.startedAt):'',own=ownVehicle();
    if(sidebarMode!=='battles')return own; // the Vehicles mode writes its own heading
    $('scene-kind').textContent='BATTLE'+(stamp?' \u00b7 '+stamp:'');
    // The battle name IS the picker now. refresh() and $('battles').onchange already leave it on the
    // open battle; this only catches the paths that reach loadBattle() another way (the mode switch,
    // the WebMCP tool), and never sets a value the list does not carry - that would blank the heading.
    var picker=$('battles');
    if(current&&picker.value!==current.id&&[].some.call(picker.options,function(o){return o.value===current.id;}))picker.value=current.id;
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
    return {id:hit.id+':swap',synthetic:true,base:hit.id,direction:viewDirection(hit)==='incoming'?'outgoing':'incoming',
      attacker:attacker,target:shallow(hit.attacker),points:[],rawHitPoints:[],warnings:[],
      shellCandidates:[],availableShells:[],receivedAt:hit.receivedAt,rangeAtImpact:hit.rangeAtImpact};
  }
  function sceneTiles(hit,reference){
    // The pose tile belongs to the model on screen: it goes as soon as there is none, and poseChanged()
    // brings it back with the figures of the next one.
    if(!hit)$('pose-info').hidden=true;
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
    // A focused vehicle without hits is shown against his own gun: there is no other role to swap to, so the
    // tile is a label. A swapped shooter goes back to the recorded hit; a recorded hit offers the swap.
    var solo=!!(hit&&hit.vehicle),back=!!(hit&&hit.synthetic&&!solo),ready=swapReady(hit);
    button.disabled=solo||!(back||ready);
    button.title=solo?'This vehicle\u2019s own gun \u00b7 no shot was recorded against him here':back?'Back to the recorded hit and its shot line':ready?'Show this vehicle\u2019s collision model \u00b7 the roles swap, the recorded shot is not carried over':NO_SHOOTER_MODEL;
  }
  function roleTiles(){
    $('model-tile').setAttribute('aria-pressed',String(activeRole!=='shooter'));
    $('shooter-tile').setAttribute('aria-pressed',String(activeRole==='shooter'));
  }
  function display(data,reference){
    currentHitKey=null;var hit=data.hit;swapped=hit.synthetic&&!hit.vehicle?hit:null;sceneTiles(hit,reference);
    var pend=pendingParts(hit);noteModelsPending(hit,pend);
    $('shot-source').textContent=hit.synthetic?'No recorded shot':'Hit line';prepareShell(hit);var drawn=viewer&&viewer.load(data,shotContext);
    // A part on its way is not a missing model: the spinner outranks both the empty
    // message and the “geometry unavailable” one, which belongs to a broken record.
    if(pend.target)message(EXTRACTING,true);else message(drawn?'':'Geometry unavailable. The original event is kept.');
    pivotButtons();warnings(pendingWarnings(data.warnings||[],hit));$('details').replaceChildren();
    // The saved reticle exists only for the player's own shots: with an ally in focus his gun has no
    // telemetry at all, so his outgoing hit reads exactly like an incoming one does today - no recorded
    // circle, the nominal estimate if the record allows one. setShotContext(null) still builds the (empty)
    // aim group the estimate is drawn into.
    var view=viewDirection(hit),ownShot=focusIsPlayer()&&view==='outgoing';
    var aimReady=viewer&&viewer.setShotContext(ownShot?shotContext:null),estimate=!aimReady&&viewer?viewer.setAimEstimate(shotContext):null;$('show-aim').disabled=!(aimReady||estimate);
    $('total-chance').textContent=estimate?'\u2300 '+(estimate.radius*2).toFixed(2)+' m':'—';
    // Why there is no circle, in full: no resolved impact point to centre on, no gun dispersion in the record,
    // no range, or no own reticle linked to this hit (every incoming hit by design - the enemy's is not recorded).
    var reason=aimReady?'saved reticle':estimate?'nominal estimate':!(viewer&&viewer.point&&viewer.travel)?'no resolved impact point':!(hit.attacker&&hit.attacker.gunDispersion>0)?'no gun dispersion in the record':!(shotContext.range>0||hit.rangeAtImpact>0)?'no range for this hit':!ownShot?'enemy reticle unavailable':(aimReasons[shotContext.aimReason]||'no linked snapshot').toLowerCase();
    // The reticle block stays small: what the circles mean and where this one came from lives in the ⓘ tooltip.
    var status=aimReady?'This hit: ● solid green — the client reticle at the shot, ◌ dashed gold — the server reticle, both slid along the shot line to the impact point.':estimate?'This hit: ◌ dashed blue — nominal full-aim estimate of the '+(estimate.gun||'mounted gun')+': '+(estimate.dispersion*100).toFixed(2)+' m at 100 m × '+Math.round(estimate.range)+' m ('+(estimate.source==='tracer'?'tracer range':'approximate range at impact')+') = ⌀ '+(estimate.radius*2).toFixed(2)+' m. Without crew or equipment, centred on the hit line; not the recorded reticle and not used in the figure.':'This hit: no reticle — '+reason+'.';
    // One line per hit in the page console; the game writes page console lines into game.log, so an in-game
    // report about missing rings can be read there instead of guessed at.
    if(window.console)console.info('Bullba Hits aim: hit '+hit.id+' '+(view||'other')+' saved='+!!aimReady+' estimate='+!!estimate+' reason='+reason);
    aimStatus=status;aimTitle();
    $('aim-toggle').title=aimReady?'The saved client circle is teal; the server one is dashed when received. Linked to the hit by end point and time; the target position is at impact.':'No own reticle is unambiguously linked to this hit: '+(aimReasons[shotContext.aimReason]||'no data')+'.';
    shotStats();
    if(reference){$('details').appendChild(node('p','The model is extracted from the installed client. There are no invented hits here. Once the recorder is installed, new battles appear in the list on the left.'));return;}
    if(hit.vehicle){
      var mv=hit.target||{},sv=hit.attacker||{},when=Number.isFinite(hit.receivedAt)?new Date(hit.receivedAt*1000).toLocaleDateString('en-GB'):'an unknown date';
      $('details').appendChild(node('p','Client collision model of '+(mv.name||'this vehicle')+', exported from '+(SOURCE_TEXT[mv.source]||'the client')+' on '+when+', rest pose. Shooter: '+(sv.name||'\u2014')+', '+(sv.gun||'gun not recorded')+'. Nothing was fired here: pin a point on the armour to read a line, or Alt + click to estimate a reticle.'));
      return;
    }
    if(hit.synthetic){$('details').appendChild(node('p','The shooter\u2019s collision model, swapped in from the hit at '+clock(hit.receivedAt)+'. Nothing was fired at this vehicle in the record, so there is no hit line, no reticle and no shell of its own. Click the tile below the model to go back to the recorded hit.'));return;}
    detail('Direction',view==='incoming'?'Incoming':view==='outgoing'?'Outgoing':'Not this vehicle',clock(hit.receivedAt));detail('Result',result(hit));
    var points=hit.points||[],point=points.find(function(p){return p.status==='resolved';});
    detail('Point on the model',point?['Chassis','Hull','Turret','Gun'][point.part]:'Not restored',point?'Per the client collision handler':'Segment kept for diagnostics');
    detail('Calibre',point&&point.caliber?point.caliber+' mm':'No data',points.length+' points in the event');
    if(hit.rangeAtImpact!=null)detail('To the attacker at impact',hit.rangeAtImpact.toFixed(1)+' m','Position when the hit was received; not a measured flight length.');
  }
  function renderHits(){
    renderFocus();
    var container=$('hits');container.replaceChildren();var hits=current?current.hits.filter(function(h){var d=viewDirection(h);return !!d&&(filter==='all'||d===filter);}):[];var own=renderHeading();$('hit-count').textContent=current?hits.length+' hits'+(own?' · battle in '+own.name:''):'';
    // The empty list says which emptiness it is: no records at all, a filter that hides them, or a focused
    // vehicle this battle never recorded a hit for - and then whether his own model is the scene on screen.
    if(!hits.length){
      var any=!!current&&current.hits.some(function(h){return !!viewDirection(h);});
      container.appendChild(node('p',!current?'No records yet. Start the game with the recorder and play a battle. The viewer can stay open.':any?'No hits for the chosen filter.':focusNote||'No hits for '+focusName()+' in this battle','empty'));
      return;}
    hits.forEach(function(h){var hasDamage=h.damage>0,view=viewDirection(h),b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(selected===h.id));b.setAttribute('data-direction',view);b.setAttribute('data-result',hasDamage?'damage':'none');b.title=(view==='incoming'?'Incoming from '+((h.attacker||{}).name||'?'):'Outgoing at '+((h.target||{}).name||'?'))+' · '+result(h);
      b.appendChild(vehicleTile(view==='incoming'?h.attacker:h.target));
      // Outcome column: damage in the direction colour, or the muted result icon; the full result text stays in the button title.
      // Outcome widget: direction arrow in the top-left corner, the figure (damage, or the no-damage result icon)
      // in the top-right, the time underneath - the arrow never glues to the figure.
      var outcome=node('span',undefined,'hit-outcome'),line=node('span',undefined,'outcome-line');
      line.appendChild(node('span',view==='incoming'?'\u2199':'\u2197','outcome-dir'));
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
  // the key. The shooter's parts are in it too (0.7.11): his models arrive after the hit is published, and both
  // the swap tile and the spinner read them, so their arrival has to count as a change.
  function hitFingerprint(hit){
    if(!hit)return null;
    var stamp=function(p){return [p.id,p.name,p.modelKey,p.modelPending,p.modelError,p.armorSource,p.resource,(p.transform||[]).join(' ')].join('~');};
    var parts=((hit.target||{}).parts||[]).map(stamp).join(';')+'/'+((hit.attacker||{}).parts||[]).map(stamp).join(';');
    var attacker=hit.attacker||{},target=hit.target||{};
    return [hit.id,hit.receivedAt,hit.damage,viewDirection(hit),hit.rangeAtImpact,hit.shellStatus,hit.effectsIndex,hit.shellVelocity,
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
      // Another battle is read from its own player's seat again, and the model of a vehicle without hits in
      // the battle that is being left goes with it.
      if(!sameBattle){focusVehicle=null;focusStamp=null;focusScene=null;focusSceneKey=null;focusNote='';}
      current=b;ArmorShotTelemetry.load(b.shotEvents||[]);queueVerdicts(b);
      var existing=keep&&selected&&b.hits.some(function(h){return h.id===selected;});
      if(!existing)selected=null;
      renderHits();
      // The selected shot is untouched: the list, the shot events and the verdict queue are refreshed, the scene is not.
      if(unchanged)return;
      // The first hit of the list, which is the first hit the focused vehicle took part in: a record also
      // holds the hits between two other vehicles, and those are not on the list.
      var first=b.hits.find(function(h){return !!viewDirection(h);});
      if(existing||first)return selectHit(existing?selected:first.id);
      // No hit of the focused vehicle in this record: his own collision model takes the place of the empty
      // scene, and only a vehicle the exporter never wrote falls back to a message.
      return showFocusEmpty();
    });
  }
  // The battle list keeps itself fresh: the index file is re-read every few seconds (a local file, cheap) and the
  // battle is reloaded only when the exporter has written a newer index; the chosen battle and hit are kept.
  var indexStamp=null,polling=false,pollTimer=null;
  function refresh(){
    if(polling)return Promise.resolve();polling=true;
    return ArmorInspectorData.index().then(function(index){var pv=$('app-version').getAttribute('data-version');recordsVersion=index.version||'';$('app-version').textContent=[pv!=='dev'?pv:'',index.version&&index.version!==pv?'records '+index.version:''].filter(Boolean).join(' \u00b7 ');if(index.application!=='local.armor_inspector'||!Array.isArray(index.battles))throw new Error('Invalid battle list');verdictStatus();
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
  $('track-opacity').oninput=function(){if(viewer)viewer.setTrackOpacity(Number(this.value)/100);$('track-opacity-value').textContent=this.value+' %';};
  $('camera-zoom-field').onchange=function(){if(viewer)viewer.setZoom(Number(this.value));};
  $('pivot-height').oninput=function(){if(viewer){var r=viewer.heightRange();viewer.setPivotHeight(r[0]+Number(this.value)/100);}};
  $('pivot-height-field').onchange=function(){if(viewer)viewer.setPivotHeight(Number(this.value));};
  // Ricochet trace mode: a choice made for a weaker GPU survives the next battle (restoreSettings below).
  $('bounce-mode').onchange=function(){if(viewer)viewer.setBounceMode(this.value);};
  // Ricochet tint: a checkbox and a slider. Unticked means no blue at all; the slider keeps its value for the
  // next time the tint is switched on. The panels' ricochet labels follow (updateShell).
  (function(){var on=$('ricochet-tint-on'),input=$('ricochet-tint'),out=$('ricochet-tint-value'),row=input.parentNode;
    var apply=function(){ricochetTint=on.checked?Number(input.value)/100:0;out.textContent=input.value+' %';row.classList.toggle('off',!on.checked);if(viewer)viewer.setTint(ricochetTint);};
    input.oninput=function(){apply();updateShell();};
    on.onchange=function(){apply();updateShell();};})();
  // Ricochet dots: a checkbox and the spacing slider.
  (function(){var on=$('ricochet-dots-on'),input=$('ricochet-dots'),out=$('ricochet-dots-value'),row=input.parentNode;
    var apply=function(){out.textContent=input.value+' px';row.classList.toggle('off',!on.checked);if(viewer)viewer.setDots(on.checked,input.value);};
    input.oninput=apply;on.onchange=apply;})();
  // Part seams and the zone outline.
  $('part-edges').onchange=function(){if(viewer)viewer.setPartEdges(this.value==='on');};
  $('zone-outline').onchange=function(){if(viewer)viewer.setZoneOutline(this.value==='on');};
  $('heatmap-quality').onchange=host.guard('Detail',function(){if(host.game&&this.value==='high'){this.value=viewer?viewer.quality:'auto';return;}if(viewer)viewer.setQuality(this.value);});
  // The pose tile at the bottom right of the scene: where the turret and the gun POINT, not how far they have
  // been dragged (user, 18.09: a turret that was turned at the hit was read as 0°). The viewer keeps the pose as
  // a delta from the record - everything else depends on that - so the figures here are the recorded pose plus
  // the delta: hit.aim = [turret yaw, gun pitch] in radians at the hit, yaw 0 = hull forward, pitch positive =
  // down, which is why the gun is printed with the sign flipped (up positive). The limits come from
  // gunRangeAbsolute(), the same samples without the recorded pitch subtracted. A record with no hit.aim - an
  // old battle, a vehicle opened without a shot - has nothing absolute to add to and keeps the delta wording.
  // Gun readouts: up positive, down negative. #viewport keeps the drag hints in its aria-label.
  function poseChanged(){
    if(!viewer)return;
    var loaded=!!viewer.loadedData;$('pose-info').hidden=!loaded;if(!loaded)return;
    var hit=viewer.loadedData.hit||{},aim=hit.aim||[],absolute=Number.isFinite(aim[0])&&Number.isFinite(aim[1]);
    var off=!(Math.abs(viewer.turretAngle)<.1&&Math.abs(viewer.gunAngle)<.1),DEG=180/Math.PI;
    var sign=function(v){return (v>0?'+':'')+Math.round(v)+'°';},wrap=function(v){return ((v+180)%360+360)%360-180;};
    var g=viewer.gunRangeAbsolute(),turret,gun;
    if(absolute){
      var yawLimits=(hit.target||{}).turretYawLimits,limited=Array.isArray(yawLimits)&&yawLimits.length===2;
      turret='Turret '+sign(wrap(aim[0]*DEG+viewer.turretAngle))+(limited?' · limits '+sign(yawLimits[0]*DEG)+' … '+sign(yawLimits[1]*DEG):'');
      gun='Gun '+sign(-(aim[1]*DEG+viewer.gunAngle))+(g.known?' · '+sign(-g.max)+' … '+sign(-g.min):' · limits not recorded');
    }else{
      turret='Turret '+sign(viewer.turretAngle)+' from the recorded pose';
      gun='Gun '+sign(-viewer.gunAngle)+' from the recorded pose';
    }
    $('pose-turret').textContent=turret;$('pose-gun').textContent=gun;
    $('pose-note').textContent=off?'Hit marks hidden until the recorded pose returns':'';$('pose-note').hidden=!off;
    staleEstimate();shotStats();
  }
  function pivotButtons(){if(!viewer)return;$('pivot-hit').disabled=!viewer.point;$('pivot-vehicle').setAttribute('aria-pressed',String(viewer.pivot!=='hit'));$('pivot-hit').setAttribute('aria-pressed',String(viewer.pivot==='hit'));}
  $('pivot-vehicle').onclick=function(){if(viewer)viewer.setPivot('vehicle');pivotButtons();};$('pivot-hit').onclick=function(){if(viewer)viewer.setPivot('hit');pivotButtons();};
  if(viewer)viewer.onTurret=poseChanged;
  if(viewer)viewer.onGun=poseChanged;
  $('fit-camera').onclick=function(){if(viewer)viewer.fit();};
  // Dragging and wheeling the scene tell the mod that the page is being used, so no
  // collision model is extracted under the user's hand. Listeners of their own, in
  // the capture phase: the viewer's handlers keep doing exactly what they did.
  (function(){
    var vp=$('viewport');if(!vp)return;
    vp.addEventListener('wheel',sendBusy,{passive:true});
    vp.addEventListener('pointerdown',sendBusy,true);
    vp.addEventListener('pointermove',function(e){if(e.buttons||(viewer&&viewer.dragging))sendBusy();},true);
  }());
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
  $('estimate-spread').onclick=function(){if(!viewer)return;try{var result=viewer.estimateSpread(Number($('spread-radius').value));analysisKey=[viewer.distance,viewer.yaw,viewer.pitch,viewer.turretAngle,viewer.gunAngle].join(',');$('spread-result').textContent=(damageView?'Nominal expected damage: '+(result.unknown?Math.round(result.damage)+'–'+Math.round(result.damageHigh):Math.round(result.damage))+' HP':'Nominal total chance: '+(result.unknown?result.low.toFixed(1)+'–'+result.high.toFixed(1):result.low.toFixed(1))+'%')+' · outside the main armour '+result.miss.toFixed(1)+'% · '+result.samples+' rays.'+(result.unknown?' A range because armour data is missing.':'')+(damageView?' For the chosen dispersion model; the non-penetration damage is a reconstruction, without map obstacles or splash onto other parts.':' For the chosen dispersion model, without map obstacles or blast damage.');}catch(e){$('spread-result').textContent=e.message;}};
  $('shell-choice').onchange=selectShell;
  $('show-aim').onchange=function(){if(viewer)viewer.showSavedAim(this.checked);};
  ['caliber','palette','armor-mode'].forEach(function(id){$(id).onchange=updateShell;});
  // Shell type switch: the entered penetration and calibre stay, only the type's law changes.
  document.querySelectorAll('#shell-types [data-kind]').forEach(function(b){b.onclick=function(){$('shell-choice').value=b.dataset.kind;selectShell();};});
  $('penetration').oninput=function(){if($('shell-choice').value.indexOf('saved:')!==0)manualPen=this.value;updateShell();};
  $('battles').onchange=function(){loadBattle(this.value,false).catch(function(e){warnings([e.message]);});};
  // The picker's own handlers. A row click is the change handler (chooseFocus); the rest is what a <details>
  // does not give: no disabled state, so a locked control refuses to open; Escape closes it and hands the
  // focus back to the summary; a click anywhere else closes it, the same pattern the toolbar's More uses.
  (function(){
    var box=$('vehicle-focus'),summary=box.querySelector('summary');
    summary.addEventListener('click',function(e){if(box.classList.contains('is-locked'))e.preventDefault();});
    box.addEventListener('keydown',function(e){if((e.key==='Escape'||e.key==='Esc')&&box.open){box.open=false;summary.focus();}});
    document.addEventListener('click',function(e){if(box.open&&!box.contains(e.target))box.open=false;});
  }());
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderHits();};});
  $('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);};
  var CONTEXT_LOST='The browser lost its WebGL context. Reload the page.';
  window.addEventListener('armor-context-lost',function(){if(host.mark)host.mark('WebGL','context-lost');message(CONTEXT_LOST);});
  // The context came back and the viewer has redrawn: take the reload notice away again, leave any other message.
  window.addEventListener('armor-context-restored',function(){if(host.mark)host.mark('WebGL','context-restored');if($('scene-message').textContent===CONTEXT_LOST)message('');});
  function outline(){if(viewer)viewer.setOutline(Number($('outline-brightness').value)/100,Number($('outline-opacity').value)/100);
    $('outline-brightness-value').textContent=$('outline-brightness').value+' %';$('outline-opacity-value').textContent=$('outline-opacity').value+' %';}
  $('outline-brightness').oninput=outline;$('outline-opacity').oninput=outline;
  // ------------------------------ Settings --------------------------------
  // Every control of the Settings menu is remembered in one localStorage object, so nothing resets on the next
  // launch; the per-control keys of 0.7.x are folded into it once and removed. Storage may be refused (the
  // game's CEF, a private window, a full quota): every read and write is guarded and the page works without it.
  // The stored value is applied to the control and then the control's OWN handler runs - the viewer is
  // configured by the same code path a click would take, never by a second copy of it.
  var SETTINGS_KEY='bullba-settings';
  var SETTINGS_LEGACY=[['bullba-bounce-mode','bounce-mode',String],['bullba-tint','ricochet-tint',String],
    ['bullba-tint-on','ricochet-tint-on',legacyFlag],['bullba-dots-spacing','ricochet-dots',String],
    ['bullba-dots','ricochet-dots-on',legacyFlag],['bullba-edges','part-edges',String],['bullba-outline','zone-outline',String]];
  function legacyFlag(v){return v==='on'||v==='1'||v==='true';}
  var settingsBox=document.querySelector('.settings-menu .settings-content');
  var settingControls=settingsBox?[].slice.call(settingsBox.querySelectorAll('input[id],select[id]')):[];
  var settingDefaults={};
  function settingValue(el){return el.type==='checkbox'?el.checked:el.value;}
  // The default is what the HTML carries: defaultChecked, defaultValue, the option marked selected (or the first).
  function settingDefault(el){
    if(el.type==='checkbox')return el.defaultChecked;
    if(el.tagName==='SELECT'){var picked=el.querySelector('option[selected]');return picked?picked.value:el.options.length?el.options[0].value:'';}
    return el.defaultValue;
  }
  // A stored value is taken only when it still fits the control: an option that exists, a number inside
  // min..max, a real boolean. Anything else falls back to the default.
  function settingValid(el,v){
    if(el.type==='checkbox')return typeof v==='boolean';
    if(typeof v!=='string'&&typeof v!=='number')return false;
    var text=String(v);
    if(el.tagName==='SELECT')return [].some.call(el.options,function(o){return o.value===text;});
    if(el.type==='range'||el.type==='number'){var n=Number(text);
      if(!isFinite(text===''?NaN:n))return false;
      return n>=(el.min===''?-Infinity:Number(el.min))&&n<=(el.max===''?Infinity:Number(el.max));}
    return true;
  }
  function settingSet(el,v){if(el.type==='checkbox')el.checked=!!v;else el.value=String(v);}
  function settingRun(el){var fn=(el.type==='range'&&el.oninput)||el.onchange||el.oninput;if(fn)fn.call(el);}
  function settingsStored(){
    var raw=null;try{raw=window.localStorage.getItem(SETTINGS_KEY);}catch(e){}
    if(raw===null||raw===undefined)return null;
    try{var box=JSON.parse(raw);if(box&&box.values&&typeof box.values==='object')return box.values;}catch(e){}
    return null;
  }
  // The keys of 0.7.x, read once and dropped.
  function settingsLegacy(){
    var values=null;
    SETTINGS_LEGACY.forEach(function(row){
      var raw=null;try{raw=window.localStorage.getItem(row[0]);}catch(e){}
      if(raw===null||raw===undefined)return;
      (values=values||{})[row[1]]=row[2](raw);
      try{window.localStorage.removeItem(row[0]);}catch(e){}
    });
    return values;
  }
  function persistSettings(){
    var values={};settingControls.forEach(function(el){values[el.id]=settingValue(el);});
    try{window.localStorage.setItem(SETTINGS_KEY,JSON.stringify({v:1,values:values}));}catch(e){}
  }
  function restoreSettings(){
    var stored=settingsStored(),migrated=false;
    if(!stored){stored=settingsLegacy();migrated=!!stored;}
    settingControls.forEach(function(el){
      settingDefaults[el.id]=settingDefault(el);
      if(stored&&Object.prototype.hasOwnProperty.call(stored,el.id)&&settingValid(el,stored[el.id]))settingSet(el,stored[el.id]);
      settingRun(el);
      // One shared listener per control instead of a save inside every handler; a programmatic change below
      // fires no event, so a restore and a reset never write anything back.
      el.addEventListener('change',persistSettings);
      if(el.type==='range')el.addEventListener('input',persistSettings);
    });
    if(migrated)persistSettings();
  }
  $('reset-settings').onclick=function(){
    settingControls.forEach(function(el){settingSet(el,settingDefaults[el.id]);settingRun(el);});
    try{window.localStorage.removeItem(SETTINGS_KEY);}catch(e){}
  };
  // The Target group is built before the settings are restored: restoring the Display setting already runs
  // updateShell(), which asks the group whether it belongs on screen.
  buildTargetMods();
  restoreSettings();
  // Heading overflow (18.09 round 2): the battle tile, the shell block and Settings share one grid row while the
  // three fit; when they do not, .stacked drops the whole shell block to a full-width second row and Settings
  // keeps the top right. natural() reads the width a block WANTS — position:absolute plus width:max-content, so
  // a block that is wrapping right now still reports its one-row width — and nothing is painted in between.
  var heading=document.querySelector('.scene-heading'),headingBattle=document.querySelector('.heading-battle');
  var settingsMenu=document.querySelector('.scene-heading .settings-menu');
  function natural(el){
    if(!el)return 0;
    var s=el.style,pos=s.position,w=s.width,vis=s.visibility,wrap=s.flexWrap;
    s.position='absolute';s.visibility='hidden';s.width='max-content';s.flexWrap='nowrap';
    var out=el.offsetWidth;
    s.position=pos;s.width=w;s.visibility=vis;s.flexWrap=wrap;
    return out;
  }
  function layoutHeading(){
    if(!heading||!shellGroup||!heading.clientWidth)return;
    var style=window.getComputedStyle(heading),gap=parseFloat(style.columnGap)||0;
    var room=heading.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0);
    heading.classList.remove('stacked');
    var need=natural(headingBattle)+natural(shellGroup)+(settingsMenu?settingsMenu.offsetWidth:0)+gap*2;
    heading.classList.toggle('stacked',need>room);
  }
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
  // Target modifiers over the scene: the group shares the top band with the Collision model tile and is given
  // the room to the right of it, up to the edge of the viewport. Neither tile is ever narrowed for it - when
  // its inline block does not fit, the group folds into its own “Modifiers” button instead. Measured in the
  // same frame as the two rows above, never per frame.
  function layoutMods(){
    var slot=$('target-mods-slot'),box=$('viewport'),tile=$('model-tile');
    if(!targetMods||!slot||slot.hidden||!box||!box.clientWidth)return;
    // The tile is centred with a transform, which offsetLeft does not see: its painted right edge comes from
    // the rectangles, measured against the viewport's own.
    var edge=14,gap=12,left=edge;
    if(!tile.hidden){var box0=box.getBoundingClientRect(),t0=tile.getBoundingClientRect();left=Math.max(edge,t0.right-box0.left+gap);}
    slot.style.left=left+'px';
    targetMods.fit(box.clientWidth-edge-left);
  }
  // One rAF debounce for all three: the heading is measured first, because stacking it changes nothing the
  // toolbar measures but a toolbar fold must not race the heading's own reflow.
  function scheduleLayout(){if(tbFrame)return;tbFrame=window.requestAnimationFrame(function(){tbFrame=0;layoutHeading();layoutToolbar();layoutMods();});}
  window.addEventListener('resize',scheduleLayout);
  // Closing on a click outside is written out here: the settings menu has no such handler to reuse. Every
  // popover of the page is a .toolbar-more <details>, the toolbar's own and the modifier groups' alike, so one
  // handler closes them all.
  document.addEventListener('click',function(e){document.querySelectorAll('.toolbar-more[open]').forEach(function(d){if(!d.contains(e.target))d.open=false;});});
  layoutHeading();layoutToolbar();layoutMods();
  if(host.interrupted){$('host-note').hidden=false;$('host-note').textContent='The previous session was interrupted during “'+host.interrupted.action+'» ('+(host.interrupted.host==='game'?'in the game':'in the browser')+', '+new Date(host.interrupted.at).toLocaleString('en-GB')+'). Mention this when reporting.';}
  (function(){var pv=$('app-version').getAttribute('data-version');if(pv!=='dev')$('app-version').textContent=pv;}());
  host.done();
  // The catalogue is read once at start when the fragment names a vehicle, whatever the remembered mode is.
  restoreSidebar();
  refresh();applyFragment(true);
  window.addEventListener('hashchange',function(){applyFragment(false);});
  // The same poll watches the viewer's frame loop: a frame that the host never delivered is dropped here, and
  // the frame-rate figure is refreshed (or cleared) even when nothing is being drawn. It is a chain of
  // timeouts rather than one interval because the period changes: 2 s while a collision model is still being
  // extracted (noteModelsPending reschedules it), 5 s otherwise.
  function pollTick(){
    pollTimer=null;
    if(viewer){if(viewer.kick)viewer.kick();frameBadge();}
    refresh();if(sidebarMode==='vehicles')loadCatalogue();
    schedulePoll();
  }
  function schedulePoll(){if(pollTimer)window.clearTimeout(pollTimer);pollTimer=window.setTimeout(pollTick,modelsPending?2000:5000);}
  schedulePoll();
  if(document.modelContext&&document.modelContext.registerTool){try{document.modelContext.registerTool({name:'select_saved_hit',description:'Open an existing recorded hit in the local 3D viewer.',inputSchema:{type:'object',properties:{battleId:{type:'string'},hitId:{type:'string'}},required:['battleId','hitId'],additionalProperties:false},execute:function(input){if(!input||!/^[-a-zA-Z0-9_]{1,100}$/.test(input.battleId)||!/^\d+$/.test(input.hitId))throw new Error('Invalid record identifiers');return loadBattle(input.battleId,true).then(function(){return selectHit(input.hitId);});}});}catch(e){console.warn('WebMCP unavailable',e);}}
}());
