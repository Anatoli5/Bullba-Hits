(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
  var shellNames={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'},candidates=[],activeHit=null,shotContext=null,manualPen='',lastDistance=null,analysisKey=null,recordsVersion='';
  // Fingerprint of the hit record the scene was built from, so an index bump that changed nothing does not
  // rebuild it. Set by selectHit, cleared by display() so that every other scene (a browsed vehicle, a
  // swapped shooter) counts as “not the recorded hit”.
  var currentHitKey=null;
  // The four parts of the layout pass (scheduleLayout, near the end of this file): the heading row, the toolbar
  // row, the modifier groups over the scene and the pose tile. A caller that changed one of them asks for that
  // one; no mask is all four. Declared up here so a call made while the module is still starting sees them.
  var LAYOUT_HEADING=1,LAYOUT_TOOLBAR=2,LAYOUT_MODS=4,LAYOUT_POSE=8,LAYOUT_ALL=15;
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
  // The help of the pane, as the gold badge's popover shows it: three headings, a few lines each. It used to
  // be a paragraph under the count and a two-line foot under the list; both are gone (user, 19.09: the pane
  // is a list, not a leaflet).
  var VEHICLE_INFO=[
    ['What is listed',['Every vehicle your client knows, grouped by class.',
      'With a battle open, \u201cThis battle\u201d lists its roster instead: allies and enemies.',
      'A row without a collision model is dimmed.']],
    ['How models get here',['The mod exports the vehicle you select in the hangar.',
      'Every vehicle of a battle you play is exported after it.',
      'While the game runs, a row clicked here exports on the spot.']],
    ['In the browser',['Only vehicles whose model is already exported can be drawn.',
      'Play a battle, or open this page from the game, to get more of them.']]];
  var sidebarMode='battles',battlesDirty=false;
  var catalogue=null,catalogueStamp=null,catalogueError=null,cataloguePending=false;
  var vehicleFilters={tier:[],nation:[],'class':[],role:[],flag:[],text:''},vehicleScope='battle';
  var modelVehicle=null,shooterVehicle=null,shooterPicked=false,activeRole='model';
  var vehicleScene=null,vehicleGeneration=0,vehicleCache=Object.create(null),vehicleOrder=[];
  var listIds=null,listMarks=null,listRoles=null,lastFragment=null;

  // The game's CEF may refuse storage; the mode and the filters are a convenience, never a requirement.
  function storedSidebar(){try{return JSON.parse(window.localStorage.getItem(SIDEBAR_KEY));}catch(e){return null;}}
  function storeSidebar(){try{window.localStorage.setItem(SIDEBAR_KEY,JSON.stringify({mode:sidebarMode,filters:vehicleFilters,scope:vehicleScope}));}catch(e){}}

  // ---- filters -----------------------------------------------------------
  // No filter means every vehicle is listed - a filter only takes rows away (user, 19.09: an empty filter
  // used to read as an empty list). The filters belong to the catalogue, so touching one while the list shows
  // a battle's roster means "the whole catalogue, narrowed": the scope follows the click.
  function toggleFilter(row,value,button){
    var list=vehicleFilters[row],at=list.indexOf(value);
    if(at<0)list.push(value);else list.splice(at,1);
    button.setAttribute('aria-pressed',String(at<0));leaveBattleScope();storeSidebar();filterSummary();renderVehicles();
  }
  function leaveBattleScope(){if(vehicleScope==='battle')vehicleScope='all';}
  // The caret's badge at the right end of the Class row: how many of the secondary pills (Role, Flags) are
  // pressed. They are out of sight in its popover, so the badge is the only sign that they narrow the list.
  function filterSummary(){
    var fold=$('filter-more');if(!fold)return;
    var n=vehicleFilters.role.length+vehicleFilters.flag.length,mark=fold.querySelector('.filter-count');
    if(mark)mark.textContent=n?String(n):'';
    fold.setAttribute('data-on',String(n>0));
    fold.querySelector('summary').title=(n?n+' of them are pressed. ':'')+'Role and Flags';
  }
  // The search is a magnifier at the right end of the Tier row: a click puts the input where the row's label
  // is, Escape or an empty blur puts the label back. A text that stays shows as a chip on the count line and
  // keeps the magnifier gold, so a narrowed list is never a silent one.
  function searchBox(open,focus){
    var input=$('vehicle-search'),toggle=$('vehicle-search-toggle');if(!input||!toggle)return;
    var label=input.parentNode.querySelector('.filter-label');
    input.hidden=!open;if(label)label.hidden=open;
    toggle.setAttribute('aria-expanded',String(!!open));
    if(open&&focus)input.focus();
  }
  function searchText(value){
    vehicleFilters.text=value;
    if(value)leaveBattleScope();
    storeSidebar();renderVehicles();
  }
  function filterChip(){
    var text=String(vehicleFilters.text||'').trim(),chip=$('vehicle-text-chip'),toggle=$('vehicle-search-toggle');
    if(chip){chip.hidden=!text;chip.textContent=text?'\u201c'+text+'\u201d \u00d7':'';}
    if(toggle)toggle.setAttribute('data-on',String(!!text));
  }
  // Nation and flag marks: the client's own icons, embedded in style.css exactly like .vt-class/.vt-role.
  function nationMark(nation){var m=node('span',undefined,'vt-nation');m.setAttribute('data-nation',nation);return m;}
  function flagMark(flag){var m=node('span',undefined,'vt-flag');m.setAttribute('data-flag',flag);return m;}
  // A pill with a mark shows the icon and carries the name in its title; a pill without one shows the word
  // (Tier is Roman numerals, "Exported" has no client icon).
  // The head line of a row carries the label and, at its right end, a tool that belongs with the caption:
  // the magnifier on Tier. `pillTools` instead sits at the end of the row of pills itself - that is where
  // the caret of the secondary filters belongs (user, 19.09), so Role and Flags open directly under the
  // class pills and not under the caption above them.
  function filterRow(row,title,items,tools,pillTools){
    var wrap=node('div',undefined,'filter-row'),head=node('div',undefined,'filter-head');
    head.appendChild(node('span',title,'filter-label'));
    (tools||[]).forEach(function(t){head.appendChild(t);});
    wrap.appendChild(head);
    var pills=node('span',undefined,'filter-pills');pills.setAttribute('role','group');pills.setAttribute('aria-label',title);
    items.forEach(function(item){
      var b=node('button',undefined,'filter-pill');b.type='button';
      b.setAttribute('data-row',row);b.setAttribute('data-value',item.value);b.setAttribute('aria-pressed','false');
      if(item.mark){b.appendChild(item.mark);b.setAttribute('aria-label',item.label);}else b.textContent=item.label;
      b.title=item.title||item.label;
      b.onclick=function(){toggleFilter(row,item.value,b);};
      pills.appendChild(b);
    });
    if((pillTools||[]).length){
      var line=node('div',undefined,'filter-line');
      line.appendChild(pills);
      pillTools.forEach(function(t){line.appendChild(t);});
      wrap.appendChild(line);
    }else wrap.appendChild(pills);
    return wrap;
  }
  function searchTools(){
    var input=document.createElement('input');input.id='vehicle-search';input.type='search';input.className='vehicle-search';
    input.placeholder='Find\u2026';input.setAttribute('aria-label','Find a vehicle by name');input.autocomplete='off';input.hidden=true;
    input.oninput=function(){searchText(this.value);};
    input.onkeydown=function(e){if(e.key==='Escape'||e.key==='Esc'){this.value='';searchText('');searchBox(false,false);}};
    input.onblur=function(){if(!this.value)searchBox(false,false);};
    var toggle=node('button','\ud83d\udd0d','filter-tool');toggle.type='button';toggle.id='vehicle-search-toggle';
    toggle.setAttribute('aria-label','Find a vehicle by name');toggle.setAttribute('aria-expanded','false');
    toggle.title='Find a vehicle by name';
    toggle.onclick=function(){searchBox(input.hidden,true);};
    return [input,toggle];
  }
  // Role and Flags are the rows nobody opens twice a session: they sit in a popover of the kind the toolbar's
  // "More" and the modifier groups use, so the page keeps its one popover mechanism and its one closing
  // handler. The caret that opens it sits at the end of the row of class pills, so the popover hangs
  // directly under the pills instead of under the caption above them.
  function secondaryFilters(){
    var fold=node('details',undefined,'toolbar-more filter-more');fold.id='filter-more';
    var summary=node('summary','\u25be');summary.appendChild(node('span','','filter-count'));
    summary.setAttribute('aria-label','More filters: role and flags');
    fold.appendChild(summary);
    var pop=node('div',undefined,'toolbar-popover');fold.appendChild(pop);
    pop.appendChild(filterRow('role','Role',Object.keys(roleNames).map(function(f){
      var mark=node('span',undefined,'vt-role');mark.setAttribute('data-role',f);return {value:f,label:roleNames[f],mark:mark};})));
    var flags=host.game?FLAG_KEYS:FLAG_KEYS.filter(function(f){return f!=='exported';});
    pop.appendChild(filterRow('flag','Flags',flags.map(function(f){
      return {value:f,label:FLAG_NAMES[f],title:FLAG_TITLES[f],mark:FLAG_ICONS[f]?flagMark(f):null};})));
    return fold;
  }
  function buildFilters(){
    var box=$('vehicle-filters');box.replaceChildren();
    // Tier, Nation and Class stay on screen: the fold that hid all five (19.09, earlier today) hid exactly
    // the filters that are used. The column is wide enough for Nation in two rows of six.
    var tiers=[],i;for(i=1;i<=11;i++)tiers.push({value:String(i),label:tierRomans[i],title:'Tier '+tierRomans[i]});
    box.appendChild(filterRow('tier','Tier',tiers,searchTools()));
    box.appendChild(filterRow('nation','Nation',Object.keys(nationNames).map(function(n){
      return {value:n,label:nationNames[n],mark:nationMark(n)};})));
    box.appendChild(filterRow('class','Class',CLASS_ORDER.map(function(c){
      var mark=node('span',undefined,'vt-class');mark.setAttribute('data-class',c);return {value:c,label:classNames[c],mark:mark};}),null,[secondaryFilters()]));
  }
  // The gold badge's popover: the help the pane used to print under the count and under the list.
  function buildInfo(){
    var box=document.querySelector('#vehicle-info-box .toolbar-popover');if(!box)return;
    box.replaceChildren();
    VEHICLE_INFO.forEach(function(part){
      var section=node('div');section.appendChild(node('b',part[0]));
      var lines=node('ul');part[1].forEach(function(line){lines.appendChild(node('li',line));});
      section.appendChild(lines);box.appendChild(section);
    });
  }
  function syncFilters(){
    document.querySelectorAll('#vehicle-filters [data-row]').forEach(function(b){
      var list=vehicleFilters[b.getAttribute('data-row')]||[];
      b.setAttribute('aria-pressed',String(list.indexOf(b.getAttribute('data-value'))>=0));});
    var search=$('vehicle-search');if(search)search.value=vehicleFilters.text;
    searchBox(false,false);filterSummary();filterChip();syncScope();
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
  // Two scopes (user, 19.09). "This battle" lists the roster of the battle on screen in the two groups the
  // roster picker uses, so a scene tile is filled from the vehicles that actually fought; "All vehicles" is
  // the client's catalogue grouped by class and narrowed by the filters. Without a roster there is nothing
  // to scope to: the control is hidden and the catalogue is the only list.
  function scopeReady(){return !!current&&rosterRows().length>0;}
  function activeScope(){return scopeReady()&&vehicleScope==='battle'?'battle':'all';}
  function syncScope(){
    var box=$('vehicle-scope');if(!box)return;
    box.hidden=!scopeReady();
    var scope=activeScope();
    box.querySelectorAll('[data-scope]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-scope')===scope));});
  }
  function catalogueByType(type){
    var rows=(catalogue&&catalogue.vehicles)||[],i;
    for(i=0;i<rows.length;i++)if(rows[i].type===type)return rows[i];
    return null;
  }
  // The file id the exporter gives a vehicle type (mod/local_armor_inspector/exporter.py vehicle_id): the
  // first colon becomes a dash, anything outside [-A-Za-z0-9_] an underscore. It is needed for a roster
  // vehicle the catalogue does not carry - in the game a click on it is an export request like any other
  // unexported row, in the browser it is the usual dimmed row with the usual note.
  function typeId(type){return String(type||'').replace(':','-').replace(/[^-A-Za-z0-9_]/g,'_');}
  // What this battle recorded about a vehicle type: its hit descriptor carries the tier, class, role and
  // nation the catalogue would have given.
  function recordedVehicle(type){
    var hits=(current&&current.hits)||[],i,h;
    for(i=0;i<hits.length;i++){h=hits[i];
      if(h.target&&h.target.type===type)return h.target;
      if(h.attacker&&h.attacker.type===type)return h.attacker;}
    return null;
  }
  function rosterVehicle(row){
    var known=catalogueByType(row.type);if(known)return known;
    var d=recordedVehicle(row.type)||{};
    return {id:typeId(row.type),type:row.type,name:row.name||d.name||'Unknown vehicle',level:d.level,'class':d['class'],
      role:d.role,nation:d.nation,premium:false,collector:false,special:false,exported:false,exportedAt:null,source:null};
  }
  // A group is [caption, rows]; a row is the catalogue entry plus the side it fought on. The nickname of the
  // player is not repeated here (user, 19.09): the list is about vehicles, the roster picker about seats.
  function rosterGroups(){
    var groups=pickerList(),out=[];
    [['ALLIES','ally',groups.allies],['ENEMIES','enemy',groups.enemies]].forEach(function(group){
      if(!group[2].length)return;
      out.push([group[0],group[2].map(function(r){return {v:rosterVehicle(r),side:group[1]};})]);
    });
    return out;
  }
  function catalogueGroups(){
    var all=(catalogue&&catalogue.vehicles)||[];
    // In the game the mod is running, so every catalogue row is offered and an unexported one exports on
    // click. In the browser nothing can be exported, so only the rows that already have a model are listed.
    if(!host.game)all=all.filter(function(v){return v.exported;});
    var shown=all.filter(vehicleMatches),out=[];
    CLASS_ORDER.forEach(function(cls){
      var group=shown.filter(function(v){return v['class']===cls;});
      if(!group.length)return;
      group.sort(function(a,b){return (b.level||0)-(a.level||0)||String(a.name||'').localeCompare(String(b.name||''));});
      out.push([String(classNames[cls]).toUpperCase(),group.map(function(v){return {v:v,side:null};})]);
    });
    return out;
  }
  // One row, both scopes: the team stripe of the roster picker when the battle supplies a side, and the gold
  // mark on the vehicle that fills the role a tile click is waiting for.
  function vehicleRow(item){
    var v=item.v,b=node('button',undefined,'vehicle-row');b.type='button';
    var isModel=!!modelVehicle&&modelVehicle.id===v.id,isShooter=!!shooterVehicle&&shooterVehicle.id===v.id;
    b.setAttribute('data-vehicle',v.id);b.setAttribute('data-exported',String(!!v.exported));
    b.setAttribute('aria-pressed',String(isModel));
    if(item.side)b.setAttribute('data-side',item.side);
    if(isShooter)b.setAttribute('data-role','shooter');
    if(activeRole==='shooter'?isShooter:isModel)b.setAttribute('data-active','true');
    b.appendChild(vehicleTile(v));
    b.title=[v.name||'Unknown vehicle',item.side==='ally'?'Ally':item.side==='enemy'?'Enemy':'',
      v.exported?'model exported '+(SOURCE_TAG[v.source]||''):'no collision model yet'].filter(Boolean).join(' \u00b7 ');
    b.onclick=function(){chooseVehicle(v);};
    return b;
  }
  // One DOM node per row, up to about a thousand of them: the list is rebuilt only when the set of rows, the
  // roles or the export marks actually change, so the five-second poll of the catalogue costs nothing.
  function renderVehicles(force){
    var list=$('vehicles'),scope=activeScope();
    syncScope();
    var groups=scope==='battle'?rosterGroups():catalogueGroups(),shown=[];
    groups.forEach(function(group){shown=shown.concat(group[1]);});
    var exported=0;shown.forEach(function(item){if(item.v.exported)exported++;});
    // One line under the filters: how many of the listed vehicles have a model, and how many are listed at
    // all when that is a different figure. The help that used to stand here is behind the badge beside it.
    $('vehicle-count').textContent=catalogue||scope==='battle'
      ?(exported===shown.length?shown.length+' with models':exported+' with models \u00b7 '+shown.length+' total')
      :(catalogueError||'Reading the vehicle list\u2026');
    filterChip();
    var ids=shown.map(function(item){return item.v.id;}).join(','),marks=shown.map(function(item){return item.v.exported?'1':'0';}).join('');
    var roles=(modelVehicle?modelVehicle.id:'')+'/'+(shooterVehicle?shooterVehicle.id:'')+'/'+activeRole+'/'+scope;
    if(!force&&ids===listIds&&roles===listRoles){
      if(marks!==listMarks){listMarks=marks;shown.forEach(function(item){
        var row=list.querySelector('[data-vehicle="'+item.v.id+'"]');if(row)row.setAttribute('data-exported',String(!!item.v.exported));});}
      return;
    }
    listIds=ids;listMarks=marks;listRoles=roles;
    var top=list.scrollTop;list.replaceChildren();
    if(!shown.length){list.appendChild(node('p',scope==='battle'?'No vehicles in this battle.':catalogue?'No vehicles match the filters.':(catalogueError||'Reading the vehicle list\u2026'),'empty'));return;}
    groups.forEach(function(group){
      list.appendChild(node('div',group[0],'vehicle-group'));
      group[1].forEach(function(item){list.appendChild(vehicleRow(item));});
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
      if(sidebarMode==='vehicles'){adoptHitVehicles();renderVehicles();}
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
    // adoptHitVehicles() hands over catalogue rows, and a catalogue row carries no collision parts: the
    // target of the scene must be the vehicle's own export, or the viewer is given an empty model. One step
    // only - readVehicle() rejects anything without parts.
    if(!modelVehicle.parts)return readVehicle(modelVehicle.id).then(function(record){modelVehicle=record;return showVehicleScene(false);});
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
    // Without a browsed vehicle the heading names the hit's target that is still on screen.
    var v=modelVehicle||(activeHit&&!activeHit.vehicle?activeHit.target:null),date=v&&Number.isFinite(v.exportedAt)?new Date(v.exportedAt*1000).toLocaleDateString('en-GB'):'';
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
    // One heading tile in both modes: in Battles it is the battle picker, in Vehicles the same slot carries
    // the vehicle name (renderVehicleHeading) with no caret and nothing to open.
    $('battle-pick').disabled=mode!=='battles';if(mode!=='battles')openBattleList(false);
    storeSidebar();
    if(mode==='vehicles'){
      loadCatalogue();
      if(!changed)return Promise.resolve();
      // A recorded hit on screen stays there (user, 19.09: switching the side panel must not reset the scene).
      // Its two tiles become the role controls, the list adopts its vehicles as the current model and shooter.
      if(activeHit&&!activeHit.vehicle){adoptHitVehicles();sceneTiles(activeHit,false);renderVehicleHeading();renderVehicles(true);return Promise.resolve();}
      if(vehicleScene&&modelVehicle){display(vehicleScene,false);renderVehicleHeading();renderVehicles(true);return Promise.resolve();}
      if(modelVehicle)return showVehicleScene(false).catch(function(){});
      ++generation;if(viewer)viewer.clear();sceneTiles(null,false);renderVehicleHeading();renderVehicles(true);
      message('Pick a vehicle from the list.');warnings([]);
      return Promise.resolve();
    }
    ++vehicleGeneration;
    if(!changed)return Promise.resolve();
    if(battlesDirty||!current){battlesDirty=false;indexStamp=null;return refresh();}
    // Back to the battles: the scene stays as it is - the hit that was on screen, or the browsed vehicle until
    // a hit is clicked. Nothing is reloaded.
    renderHits();sceneTiles(activeHit,false);
    return Promise.resolve();
  }
  // The catalogue rows of the hit's target and attacker (matched by the client's vehicle type name), so the
  // Vehicles list highlights them and a click on a row replaces one of them.
  function adoptHitVehicles(){
    var rows=(catalogue&&catalogue.vehicles)||[],hit=activeHit;if(!hit||hit.vehicle||!rows.length)return;
    function byType(v){var type=v&&v.type;if(!type)return null;var i;for(i=0;i<rows.length;i++)if(rows[i].type===type)return rows[i];return null;}
    var model=byType(hit.target),shooter=byType(hit.attacker);
    if(model)modelVehicle=model;if(shooter)shooterVehicle=shooter;
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
    buildFilters();buildInfo();
    var saved=storedSidebar();
    if(saved&&saved.filters){
      ['tier','nation','class','role','flag'].forEach(function(k){if(Array.isArray(saved.filters[k]))vehicleFilters[k]=saved.filters[k].filter(function(v){return typeof v==='string';});});
      if(typeof saved.filters.text==='string')vehicleFilters.text=saved.filters.text;
    }
    // 'filtersOpen' of an older state is ignored: the fold it belonged to is gone.
    if(saved&&(saved.scope==='battle'||saved.scope==='all'))vehicleScope=saved.scope;
    syncFilters();
    // The page always opens on the battles and their hits (user, 14.09: a newcomer must not think the viewer is
    // empty); only a fragment naming a vehicle opens the Vehicles mode. The filters are remembered, the mode is not.
  }
  document.querySelectorAll('#sidebar-mode [data-mode]').forEach(function(b){
    b.onclick=host.guard('Side panel mode',function(){setMode(b.getAttribute('data-mode'));});});
  // Picking "This battle" again clears nothing: the filters stay where they are, they simply do not apply
  // to a roster.
  document.querySelectorAll('#vehicle-scope [data-scope]').forEach(function(b){
    b.onclick=function(){vehicleScope=b.getAttribute('data-scope')==='battle'?'battle':'all';storeSidebar();renderVehicles();};});
  $('vehicle-text-chip').onclick=function(){var input=$('vehicle-search');if(input)input.value='';searchText('');searchBox(false,false);};
  $('model-tile').onclick=function(){chooseRole('model');};
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
  function resultIcon(hit){if(hit.damage>0)return '▰ −'+hit.damage;var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;}),effect=p.length?p[p.length-1].effect:null;return effect===2||effect===1?'↪':effect===3?'▰ ×':effect===4?'▰ ✓':effect===5||effect===6||effect===0?'▰ 0':'—';}
  function clock(seconds){if(!Number.isFinite(seconds))return '—';var d=new Date(seconds*1000);return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function detail(label,value,small){var e=node('div');e.appendChild(node('div',label,'detail-label'));e.appendChild(node('div',String(value),'detail-value'));if(small)e.appendChild(node('div',small,'detail-small'));$('details').appendChild(e);}
  function prepareShell(hit){
    // A swapped view has no shot and therefore no shells: keep the shell that is on screen - type,
    // penetration and calibre - instead of falling back to the empty manual defaults. A browsed vehicle and a
    // shooter picked from the roster do carry a gun of their own, so they take their own shells instead.
    var browsing=!!(hit&&(hit.vehicle||hit.chosenShooter)),keep=null;
    if(hit&&hit.synthetic&&!browsing){var was=$('shell-choice').value,c0=was.indexOf('saved:')===0?candidates[Number(was.slice(6))]:null;
      keep={kind:c0?c0.kind:was||'ARMOR_PIERCING',penetration:$('penetration').value,caliber:$('caliber').value};}
    activeHit=hit;shotContext=ArmorShotContext.resolve(hit,hit&&hit.vehicle?[]:(current&&current.shotEvents||[]));candidates=shotContext.choices;var choice=$('shell-choice');choice.replaceChildren();
    candidates.forEach(function(c,i){var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name+(c.gunInstallation>0?' · ability gun':''));o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — manual');o.value=kind;choice.appendChild(o);});
    if(candidates.length>1&&!browsing){var uncertain=node('option','Pick a shell — several matches');uncertain.value='';choice.insertBefore(uncertain,choice.firstChild);}
    choice.value=shotContext.index>=0?'saved:'+shotContext.index:candidates.length?'':shotContext.kind||'ARMOR_PIERCING';
    // A browsed vehicle has no hit to identify a shell, so resolve() leaves the index at -1. The shooter's own
    // list is nevertheless the right set of choices: preselect the first AP-like shell so the model is coloured
    // the moment a vehicle is picked, instead of “pick a shell”.
    if(browsing&&candidates.length){var first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING';});
      if(first<0)first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING_CR';});if(first<0)first=0;choice.value='saved:'+first;}
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,b=node('button',(actual?'● ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100)+(c.gunInstallation>0?' ✦':''),'shell-chip');b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' mm · '+(c.gunInstallation>0?'ability gun'+(c.gun?' '+c.gun:'')+' · ':'')+(actual?'Type from the hit':'Compare with this shell');b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    paintGunShells();
    syncTargetMods(hit);syncShooterMods(hit);
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
      // The collapsed summary is the width of the group's button, so the group is placed again beside the tile.
      onChange:function(){if(modsType)modsState[modsType]=targetMods.values();updateShell();scheduleLayout(LAYOUT_MODS);}});
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
    // ...and only for a shell whose non-penetration damage the factor divides: modern HE. For AP/APCR/HEAT the
    // switches would change nothing on screen.
    var s=viewer&&viewer.shell,he=!!(s&&s.kind==='HIGH_EXPLOSIVE'&&s.spallDamage>0);
    var show=!!(damageView&&he&&modsType&&!$('model-tile').hidden);
    if(slot.hidden===!show)return;
    slot.hidden=!show;if(!show)targetMods.close();
    layoutMods(); // placed in the same task it appears in, so it is never painted at the unpositioned corner
  }
  // --- Aim emulation -----------------------------------------------------------------------------------
  // The shooter's own dispersion circle: radius by the client's formula (ArmorBallistics.aimFactor) from the
  // 'aim' block the record carries, driven by W A S D and by the turret chasing the cursor. The switch and
  // the whole configuration sit next to the Shooter tile; the figures of the last shot sit in the corner of
  // the scene. Two states and nothing else (user, 20.09): aiming, then a click fixes the shot, then a click
  // releases it again.
  //
  // Only the multipliers live here; where each one belongs in the formula is decided in ballistics.js. Every
  // number below was read out of the installed client's own data and is quoted with its source, because the
  // page must never invent an equipment bonus. An option whose number could not be found is left out.
  var DEG = Math.PI / 180;
  var shooterModsState = {}, shooterType = '';
  // --- The shooter's configuration -------------------------------------------------------------
  // Laid out the way the garage lays it out (user, 21.09): a SLOT first, then the client's real items
  // grouped BY GRADE - Standard, Bounty, Improved, Experimental - and inside a grade one tile per
  // device. Not by family, which was the first attempt and reads badly: an experimental piece merges
  // two devices and belongs to no family row. And a tile is an icon and its corner badge, nothing
  // else: no name, no grade word, no number. Everything a person might want to read is in the
  // tooltip, which is where the garage keeps it too.
  //
  // Every item, every factor and every restriction below comes from window.AIM_CATALOGUE
  // (web/equipment.js), generated by tools/build_equipment_catalogue.py out of the installed client;
  // the page never invents a bonus and never prints the client's internal word "trophy" - the garage
  // calls those pieces Bounty.
  //
  // Sources, in the research report outputs/equipment-perks-2026-09-20.md: devices and their factors
  // in sections 1-2, the slot rule in section 3, the eligibility filters in section 4, the crew skills
  // in section 6, the directives in section 7 and the consumables in section 8.
  var KMH_TO_MS = 0.27778;   // component_constants.KMH_TO_MS of the client; the record holds m/s
  var CATALOGUE = window.AIM_CATALOGUE || {};
  var AIM_TIERS = CATALOGUE.tiers || [];
  var AIM_FAMILIES = CATALOGUE.families || [];
  var AIM_DEVICES = CATALOGUE.devices || [];
  var AIM_ROLES = CATALOGUE.roles || [];
  var AIM_SKILLS = CATALOGUE.skills || [];
  var AIM_DIRECTIVES = CATALOGUE.directives || [];
  var AIM_CONSUMABLES = CATALOGUE.consumables || [];
  var AIM_SLOTS = [0, 1, 2];               // three plain slots, the most any vehicle in the client has
  var DEVICE_BY_ID = {}, TIER_BY_ID = {}, FAMILY_BY_ID = {}, SKILL_BY_ID = {}, DIRECTIVE_BY_ID = {};
  AIM_DEVICES.forEach(function (d) { DEVICE_BY_ID[d.id] = d; });
  AIM_TIERS.forEach(function (t) { TIER_BY_ID[t.id] = t; });
  AIM_FAMILIES.forEach(function (f) { FAMILY_BY_ID[f.id] = f; });
  AIM_SKILLS.forEach(function (s) { SKILL_BY_ID[s.id] = s; });
  AIM_DIRECTIVES.forEach(function (d) { DIRECTIVE_BY_ID[d.id] = d; });
  // Which page input each effect moves, in words, for the tooltips. The ids are the fields of the
  // recorded aim block (mod/local_armor_inspector/exporter.py aim_block) plus the four the page derives.
  var AIM_INPUT_WORDS = {
    multFactor: 'the whole circle, the fully aimed one included',
    additiveFactor: 'everything the vehicle’s own movement adds to the circle',
    aimingTimeFactor: 'the aiming time, so the circle settles faster',
    reloadTimeFactor: 'the reload',
    turretRotationSpeed: 'the turret’s own rotation speed',
    movementFactor: 'the movement term of the circle',
    rotationFactor: 'the hull-rotation term of the circle',
    turretRotationFactor: 'the turret-rotation term of the circle',
    hullRotationSpeed: 'the hull’s rotation speed',
    clipInterval: 'the interval between the rounds of a clip',
    crewLevel: 'crew levels, which tighten the circle and the aiming time, shorten the reload and speed the turret up',
    enginePower: 'the engine power — the page’s model has no place for it and does not use it',
    speedForward: 'km/h on the top speed, which makes the movement term BIGGER, not smaller',
    speedBackward: 'km/h on the reverse speed'};
  // The archetypes a device occupies (its <incompatibleTags><installed>), in words, for the directive
  // tooltips and for "already fitted in another slot".
  var AIM_ARCHETYPE_WORDS = {
    rammer: 'a Gun Rammer', aimingStabilizer: 'a Vertical Stabilizer',
    enhancedAimDrives: 'an Enhanced Gun Laying Drive', improvedSights: 'Improved Aiming',
    rotationMechanism: 'an Improved Rotation Mechanism', ventilation: 'Improved Ventilation',
    turbocharger: 'a Turbocharger', healthReserve: 'Improved Hardening'};
  var AIM_GRADE_WORDS = {deluxe: 'of the Improved grade', trophyUpgraded: 'a Bounty piece'};
  function aimNum(v) { return String(Math.round(Number(v) * 10000) / 10000); }
  // --- The client's own rules, read off the catalogue -------------------------------------------
  // THE SLOT BONUS, and why the page no longer models it (user, 21.09). The client's rule is real:
  // OptionalDevice.defineActiveLevel hands out valueByLevel[1] instead of [0] when the device's
  // categories meet the SLOT's, which only the standard `_tier*` entries can do. But the two figures
  // differ by a couple of per cent at most, and deciding which of three slots is categorised cost a
  // select, a note and a branch through the whole configuration. So every standard piece is counted
  // as if it sat in its own category slot - the LAST figure the client gives - and the three slots
  // hold a device and nothing else. `cat` and `slotTypes` stay in the catalogue as client data.
  // eff is [op, plain] or [op, plain, bonused]; the second figure exists only where the client has two.
  function aimEffValue(eff) {
    if (!eff) return 1;
    return Number(eff[eff.length - 1]);
  }
  // THE ELIGIBILITY FILTER (report section 4). A vehicle passes a device's <vehicleFilter> when it
  // matches at least one <include> clause - no <include> at all means every vehicle - and no
  // <exclude> clause. A clause matches on any of `tags`, all of `mandatoryTags`, and the tier band.
  // The tags are the client's own per-vehicle list from list.xml, which the recorder now writes
  // (exporter.py fitment_block); a record from an older build carries none, and then nothing can be
  // ruled out and everything is offered, with a line under the slots saying so.
  function aimClause(clause, fit) {
    if (!clause) return false;
    if (clause.tags && clause.tags.length) {
      var any = false;
      for (var i = 0; i < clause.tags.length; i++) if (fit.tags[clause.tags[i]]) { any = true; break; }
      if (!any) return false;
    }
    if (clause.mandatoryTags && clause.mandatoryTags.length) {
      for (var j = 0; j < clause.mandatoryTags.length; j++) if (!fit.tags[clause.mandatoryTags[j]]) return false;
    }
    if (clause.minLevel > 0 && !(fit.level >= clause.minLevel)) return false;
    if (clause.maxLevel > 0 && !(fit.level <= clause.maxLevel)) return false;
    return true;
  }
  function aimFits(dev) {
    if (!dev) return false;
    var fit = shooterFit;
    if (!fit || !fit.tags) return true;   // the record does not say; nothing may be ruled out
    var f = dev.fit;
    if (!f) return true;
    var i;
    if (f.include && f.include.length) {
      var ok = false;
      for (i = 0; i < f.include.length; i++) if (aimClause(f.include[i], fit)) { ok = true; break; }
      if (!ok) return false;
    }
    if (f.exclude && f.exclude.length) {
      for (i = 0; i < f.exclude.length; i++) if (aimClause(f.exclude[i], fit)) return false;
    }
    return true;
  }
  // The Class number of a standard device is a VEHICLE TIER BAND, not a strength: Class 1 and Class 2
  // of one device carry exactly the same factors and differ only in their filter (report section 1).
  // So a preset that names Class 1 is honoured on a tier-V vehicle by fitting Class 2 - the same item
  // by another name - instead of silently dropping the piece.
  function aimResolve(id) {
    var dev = DEVICE_BY_ID[id];
    if (!dev) return '';
    if (aimFits(dev)) return dev.id;
    for (var i = 0; i < AIM_DEVICES.length; i++) {
      var d = AIM_DEVICES[i];
      if (d.family === dev.family && d.tier === dev.tier && aimFits(d)) return d.id;
    }
    return '';
  }
  // What this shooter may mount, read off the record the mod wrote. Both fields are optional: a battle
  // recorded by an older build carries neither, and then nothing can be ruled out. The recorder still
  // writes <supplySlots>; the page stopped reading it when the slot bonus went.
  function aimFitment(vehicle) {
    if (!vehicle) return null;
    var out = {tags: null, level: Number(vehicle.level) > 0 ? Number(vehicle.level) : 0};
    var tags = aimTagList(vehicle);
    if (tags) {
      out.tags = {};
      for (var i = 0; i < tags.length; i++) out.tags[String(tags[i])] = true;
    }
    return out;
  }
  // The recorded tag list, or null when the record does not know it. Since S3 (22.09) the exporter writes
  // `tagsRead`: a list that was read comes even when empty, and tagsRead false says the read failed. A
  // record from before carries a non-empty list or none at all.
  function aimTagList(vehicle) {
    if (!vehicle || vehicle.tagsRead === false || !Array.isArray(vehicle.tags)) return null;
    return vehicle.tags.length || vehicle.tagsRead === true ? vehicle.tags : null;
  }
  // --- Vehicle groups, battle modes and what the client data says about equipment (S3, 22.09) --------
  // outputs/vehicle-classes-modes-2026-09-21.md, with the corrections of its independent check. Two axes,
  // kept apart: the VEHICLE - a type the client ships in an event's own package (web/vehicle-modes.js) or
  // tags as a mode vehicle - and the BATTLE - arena.bonusType, which the recorder writes into the battle
  // header's `mode` block since this build. Unknown stays unknown: a battle recorded before has no mode,
  // not "Random"; and the tag 'special' is no mode marker (100 of the client's 138 'special' vehicles
  // carry no mode tag), so it is not read here at all.
  var VEHICLE_MODES = window.BULLBA_VEHICLE_MODES || {};
  var MODE_LISTED = VEHICLE_MODES.vehicles || {};
  // constants.BATTLE_MODE_VEHICLE_TAGS of the client, plus maps_training (gui Vehicle.isOnlyForMapsTrainingBattles),
  // each with the mode family it makes a vehicle for. event_battles says "an event", not which one.
  var MODE_TAG_FAMILY = {event_battles: 'event', comp7: 'onslaught', comp7_light: 'onslaught_light',
    epic_battles: 'frontline', battle_royale: 'steel_hunter', fun_random: 'fun_random', fallout: 'legacy',
    bob: 'legacy', clanWarsBattles: 'legacy', maps_training: 'maps_training'};
  var MODE_NAMES = {random: 'Random Battle', ranked: 'Ranked Battle', grand_battle: 'Grand Battle',
    onslaught: 'Onslaught', onslaught_light: 'Onslaught Light', frontline: 'Frontline',
    steel_hunter: 'Steel Hunter', white_tiger: 'White Tiger', last_stand: 'Last Stand', story_mode: 'Story Mode',
    fun_random: 'Fun Random', maps_training: 'Topography', mapbox: 'Mapbox', winback: 'Winback',
    training: 'Training Room', tournament: 'Tournament', clan: 'Clan and team battles', event: 'an event',
    legacy: 'a retired mode'};
  // ARENA_BONUS_TYPE by the name the recorder resolved from the client's own constants when it wrote the
  // battle (report 1.2). The ids of an event are injected by its extension and may mean something else in
  // another client, so the name decides and the id table below is only the fallback for this client.
  var BONUS_FAMILY = {REGULAR: 'random', RANDOM_NP2: 'random', RANKED: 'ranked', EPIC_RANDOM: 'grand_battle',
    EPIC_RANDOM_TRAINING: 'grand_battle', TRAINING: 'training', COMP7: 'onslaught', TOURNAMENT_COMP7: 'onslaught',
    TRAINING_COMP7: 'onslaught', COMP7_LIGHT: 'onslaught_light', EPIC_BATTLE: 'frontline',
    EPIC_BATTLE_TRAINING: 'frontline', BATTLE_ROYALE_SOLO: 'steel_hunter', BATTLE_ROYALE_SQUAD: 'steel_hunter',
    BATTLE_ROYALE_TRN_SOLO: 'steel_hunter', BATTLE_ROYALE_TRN_SQUAD: 'steel_hunter', MAPBOX: 'mapbox',
    WINBACK: 'winback', FUN_RANDOM: 'fun_random', MAPS_TRAINING: 'maps_training',
    STORY_MODE_ONBOARDING: 'story_mode', STORY_MODE_REGULAR: 'story_mode', LAST_STAND: 'last_stand',
    LAST_STAND_MEDIUM: 'last_stand', LAST_STAND_HARD: 'last_stand', WHITE_TIGER: 'white_tiger',
    TOURNAMENT: 'tournament', TOURNAMENT_REGULAR: 'tournament', TOURNAMENT_CLAN: 'tournament',
    TOURNAMENT_EVENT: 'tournament', CLAN: 'clan', CYBERSPORT: 'clan', GLOBAL_MAP: 'clan', SORTIE_2: 'clan',
    FORT_BATTLE_2: 'clan', EVENT_BATTLES: 'event', EVENT_BATTLES_2: 'event', FALLOUT_CLASSIC: 'legacy',
    FALLOUT_MULTITEAM: 'legacy', BOB: 'legacy', RTS: 'legacy', RTS_1x1: 'legacy', RTS_BOOTCAMP: 'legacy'};
  var BONUS_ID_FAMILY = {1: 'random', 2: 'training', 22: 'ranked', 24: 'grand_battle', 27: 'frontline',
    29: 'steel_hunter', 30: 'steel_hunter', 37: 'mapbox', 38: 'maps_training', 42: 'fun_random', 43: 'onslaught',
    44: 'winback', 46: 'random', 49: 'onslaught_light', 100: 'story_mode', 104: 'story_mode', 107: 'last_stand',
    108: 'last_stand', 109: 'last_stand', 110: 'white_tiger'};
  // The modes whose client data restricts no ordinary equipment on an ordinary vehicle (report sections
  // 2.4 and 3). That is what the client files say, not proof that the server allows it, and the source
  // line says so. Every other mode - the events, Steel Hunter, Topography - is 'unknown', never 'forbidden':
  // "special modes forbid equipment" is exactly the assumption the page must not make.
  var MODE_EQUIPMENT_OPEN = {random: 1, ranked: 1, grand_battle: 1, onslaught: 1, onslaught_light: 1,
    frontline: 1, mapbox: 1, winback: 1, training: 1, fun_random: 1, tournament: 1, clan: 1};
  // The locks a vehicle's list entry carries, what they fix and whether the client reads them itself
  // (report section 3): a lock means "fixed by the game", not "empty" - the twelve Onslaught rentals come
  // with devices, only which ones is not in the record.
  var LOCK_RULES = {
    lockOptionalDevices: {what: 'devices', reader: 'the client itself reads it (VehicleType.isOptionalDevicesLocked)'},
    lockDevices: {what: 'devices', reader: 'no client code reads it, so what it locks is taken from its name and its place beside lockShells and lockCrewSkills on the event vehicles'},
    lockEquipment: {what: 'consumables', reader: 'the client itself reads it (VehicleType.isEquipmentLocked)'},
    lockCrewSkills: {what: 'crew', reader: 'the client itself reads it (items/tankmen)'}};
  function modeFamilyName(family) {
    var listed = VEHICLE_MODES.families || {};
    return MODE_NAMES[family] || listed[family] || String(family || 'an unknown mode').replace(/_/g, ' ');
  }
  // One recorded vehicle: its group (standard / mode / unknown), the mode family it was made for, its locks.
  // The tags come from the full list the exporter backfills while the client has the type, else from the
  // short `groupTags` list the recorder writes into the record itself since the S3 review (22.09) - its locks
  // and mode tags, all that decides the group - else the locks come from the vehicle table.
  function vehicleClass(vehicle) {
    var type = vehicle && vehicle.type ? String(vehicle.type) : '';
    var listed = type && Object.prototype.hasOwnProperty.call(MODE_LISTED, type) ? MODE_LISTED[type] : null;
    var tags = aimTagList(vehicle);
    if (!tags && vehicle && Array.isArray(vehicle.groupTags)) tags = vehicle.groupTags;
    var out = {group: 'unknown', family: '', listed: !!listed, tags: !!tags, modeTags: [], locks: {}, lockSource: '', client: ''};
    var i;
    if (tags) {
      for (i = 0; i < tags.length; i++) {
        var tag = String(tags[i]);
        if (Object.prototype.hasOwnProperty.call(MODE_TAG_FAMILY, tag)) out.modeTags.push(tag);
        if (/^lock/.test(tag)) out.locks[tag] = true;
      }
      out.lockSource = 'record';
    } else if (listed) {
      // An event vehicle's type leaves the client with its event, and a record made before the recorder wrote
      // groupTags cannot be given its tags any more: its locks come from the table of the client that last
      // listed it (tools/build_vehicle_modes.py keeps every type it has ever seen).
      (listed.locks || []).forEach(function (t) { out.locks[String(t)] = true; });
      out.lockSource = 'table';
      out.client = String(listed.client || VEHICLE_MODES.client || '');
    }
    if (listed) { out.group = 'mode'; out.family = String(listed.mode || ''); }
    else if (out.modeTags.length) { out.group = 'mode'; out.family = MODE_TAG_FAMILY[out.modeTags[0]]; }
    else if (tags) out.group = 'standard';
    return out;
  }
  // The battle's mode: from the header's `mode` block, else guessed from the roster's event vehicles (a
  // guess that only names the mode - it never makes the rules known), else unknown.
  function battleModeOf(battle) {
    var m = battle && battle.mode;
    if (m && typeof m === 'object' && m.read !== false && (m.bonusTypeName || m.bonusType !== undefined)) {
      // The name decides when it was written: an id reused by a later client must not borrow an old event's name.
      var family = (m.bonusTypeName ? BONUS_FAMILY[String(m.bonusTypeName)] : BONUS_ID_FAMILY[m.bonusType]) || 'unknown';
      var name = family === 'unknown' ? 'bonus type ' + (m.bonusTypeName || m.bonusType) : modeFamilyName(family);
      if (family === 'fun_random' && m.guiTypeName && m.guiTypeName !== 'FUN_RANDOM') {
        name += ' (' + String(m.guiTypeName).toLowerCase().replace(/_/g, ' ') + ')';
      }
      return {family: family, source: 'arena', name: name};
    }
    // Why the arena's word is missing: no block (a battle recorded before the mod wrote the mode), a block
    // the mod could not read, or a block whose bonus fields were unavailable.
    var why = !m || typeof m !== 'object' ? 'old' : m.read === false ? 'unreadable' : 'unavailable';
    var counts = {}, best = '';
    ((battle && battle.roster) || []).forEach(function (row) {
      var entry = row && row.type && Object.prototype.hasOwnProperty.call(MODE_LISTED, String(row.type)) ? MODE_LISTED[String(row.type)] : null;
      if (!entry || !entry.mode) return;
      counts[entry.mode] = (counts[entry.mode] || 0) + 1;
      if (!best || counts[entry.mode] > counts[best]) best = entry.mode;
    });
    if (best) return {family: best, source: 'roster', name: modeFamilyName(best), why: why};
    return {family: '', source: 'none', name: '', why: why};
  }
  function aimRule(state, source) { return {state: state, source: source}; }
  var AIM_OPEN_RULE = aimRule('allowed', '');
  var AIM_OPEN_POLICY = {devices: AIM_OPEN_RULE, consumables: AIM_OPEN_RULE, crew: AIM_OPEN_RULE, vehicle: null, mode: null};
  // equipmentPolicy of the shooter on screen, per kind: devices (and the directive, which is fitted like
  // one), consumables and crew skills. allowed / forbidden / unknown, each with the source it rests on.
  // A lock of the vehicle's own is 'forbidden' whatever the battle; otherwise the battle decides: a mode
  // whose client data restricts nothing is 'allowed', anything else - an event, a battle recorded before
  // the mode was written, a vehicle whose tags are not known - 'unknown'.
  function aimPolicyFor(hit) {
    if (!hit || !hit.attacker) return AIM_OPEN_POLICY;
    var klass = vehicleClass(hit.attacker), battle = hit.vehicle ? null : current, mode = battle ? battleModeOf(battle) : null;
    var base;
    if (!battle) {
      base = klass.group === 'standard' ? aimRule('allowed', 'a standard vehicle outside a battle: the garage rules')
        : klass.group === 'mode' ? aimRule('unknown', 'a vehicle made for ' + modeFamilyName(klass.family) + ': what that mode lets it fit is not in the client data')
        : aimRule('unknown', 'this record does not carry the vehicle’s tags, so a mode vehicle cannot be told from a standard one');
    } else if (mode.source !== 'arena') {
      base = aimRule('unknown', (mode.why === 'unreadable' ? 'the mod could not read this battle’s mode'
        : mode.why === 'unavailable' ? 'the client did not give this battle’s mode type'
        : 'this battle was recorded before the mod wrote the battle mode')
        + (mode.source === 'roster' ? ' (its roster has vehicles of ' + mode.name + ')' : ''));
    } else if (!MODE_EQUIPMENT_OPEN[mode.family]) {
      base = aimRule('unknown', 'the client data says nothing about equipment in ' + mode.name);
    } else if (klass.group === 'unknown') {
      base = aimRule('unknown', 'this record does not carry the vehicle’s tags, so a rental with fixed equipment cannot be told from an own vehicle');
    } else {
      base = aimRule('allowed', 'client data: no restriction in ' + mode.name + ' (not proof that the server allows everything)');
    }
    var out = {devices: base, consumables: base, crew: base, vehicle: klass, mode: mode};
    var from = klass.lockSource === 'table'
      ? ' (from the ' + modeFamilyName(klass.family) + ' list of client ' + (klass.client || '?') + ', web/vehicle-modes.js)' : '';
    Object.keys(LOCK_RULES).forEach(function (tag) {
      var rule = LOCK_RULES[tag];
      if (!klass.locks[tag] || out[rule.what].state === 'forbidden') return;
      out[rule.what] = aimRule('forbidden', 'the vehicle carries the client tag ' + tag + from + ' - ' + rule.reader
        + '. The game fixes this for the vehicle; what it fits instead is not in the record');
    });
    return out;
  }
  var shooterPolicy = AIM_OPEN_POLICY;
  function aimForbidden(kind) { return !!(shooterPolicy && shooterPolicy[kind] && shooterPolicy[kind].state === 'forbidden'); }
  var AIM_POLICY_WORDS = {devices: 'Equipment and directive', consumables: 'Consumables', crew: 'Crew skills and perks'};
  // The words the mark beside Config and the locked tiles carry.
  function aimPolicyLine(kind) {
    var rule = shooterPolicy[kind];
    return AIM_POLICY_WORDS[kind] + ': not offered here - ' + rule.source + '.';
  }
  // The gun's reloading system, read off the aim block (exporter.py aim_block, S3): the gun's own tags
  // first, the mechanics sections of a block without a tag list second. Says what the emulation does not.
  // It decides nothing about what the vehicle may fit: no data file of this client uses the gun filters of
  // a device's vehicleFilter, and "a clip gun takes no rammer" is false for five clip vehicles and one dual
  // gun of the client - the eligibility tags above stay the only rule.
  var AIM_MECHANICS_WORDS = {
    autoreload: 'an autoreloading magazine: every round reloads on its own timer. The emulation paces the rounds of a hold at the clip interval and does not model the per-round reload',
    clip: 'a magazine: the rounds go at the clip interval, then the whole clip reloads. The emulation stops a burst when the clip is empty',
    burst: 'a burst gun: one pull of the trigger fires several rounds',
    dualGun: 'a dual gun: its barrels fire one at a time or together as a charged volley. The emulation fires single rounds only',
    twinGun: 'a twin gun: two barrels, each with its own reload. The emulation fires single rounds only',
    autoShoot: 'an automatic gun: it fires while the trigger is held and the circle grows with every round. The emulation does not model the growth',
    single: 'a single-shot gun'};
  function aimMechanics(a) {
    if (!a) return '';
    var tags = {}, list = Array.isArray(a.gunTags) ? a.gunTags : [], i;
    for (i = 0; i < list.length; i++) tags[String(list[i])] = true;
    if (tags.autoreload || a.autoreload) return 'autoreload';
    if (tags.dualGun || a.dualGun) return 'dualGun';
    if (tags.twinGun || a.twinGun) return 'twinGun';
    if (tags.autoShoot || a.autoShoot) return 'autoShoot';
    if (tags.clip || (a.clip && a.clip[0] > 1)) return 'clip';
    if (a.burst && a.burst[0] > 1) return 'burst';
    return list.length || a.clip ? 'single' : '';
  }
  var AIM_GUN_LOAD_TITLE = 'The gun’s state, as the reticle shows it in the game: while a burst is held, the time left to the next round and, for a clip gun, the rounds still in the clip. At rest it reads the gun’s own reload time and clip size.';
  function paintAimMechanics() {
    var time = $('aim-gun-reload'), load = time && time.parentNode;
    if (!load) return;
    var a = aimBlockData(), kind = aimMechanics(a), extra = '';
    if (kind) extra = ' This gun is ' + AIM_MECHANICS_WORDS[kind] + '.';
    if (kind === 'autoreload' && a.autoreload && Array.isArray(a.autoreload.reloadTime)) {
      extra += ' Its per-round reload: ' + a.autoreload.reloadTime.map(function (v) { return aimNum(v); }).join(', ') + ' s.';
    }
    if (a && (a.dualAccuracy || (Array.isArray(a.gunTags) && a.gunTags.indexOf('dualAccuracy') >= 0))) {
      extra += ' It has dual accuracy: the circle right after a shot follows a law of its own, which the page does not model.';
    }
    load.title = AIM_GUN_LOAD_TITLE + extra;
    load.setAttribute('data-mechanics', kind || 'unknown');
  }
  // --- The crew --------------------------------------------------------------------------------
  // A crew is a list of tankmen, each the list of the roles he serves in, his main role first - the
  // client's own descr.type.crewRoles, in slot order: [['commander', 'radioman'], ['gunner'], ...]. The
  // crew maths below runs on such a list and on nothing else, so the vehicle's real crew can be fed in
  // the day the record carries it. Since S3 (22.09) it does: aim_block writes descr.type.crewRoles and
  // fix_aim gives it to every older record from its compact descriptor (outputs/brothers-in-arms-2026-09-21.md
  // section 6), so one Brothers in Arms tile stands for each real tankman. Only a record whose descriptor
  // can no longer be rebuilt - an event vehicle whose event has left the client - still gets the five-man
  // crew below, and the Brothers in Arms tooltips say so. aimCrewOf() is the one place that decides.
  var AIM_DEFAULT_CREW = [['commander'], ['gunner'], ['driver'], ['radioman'], ['loader']];
  var AIM_CREW_ROLES = ['commander', 'gunner', 'driver', 'radioman', 'loader'];   // skills_constants ROLES
  var AIM_BIA = SKILL_BY_ID.brotherhood || null;
  // BrotherhoodSkill.crewLevelIncrease (tankmen.xml), read off the catalogue: 5.
  var AIM_BIA_LEVELS = AIM_BIA && AIM_BIA.eff && AIM_BIA.eff.crewLevel ? Number(AIM_BIA.eff.crewLevel[1]) || 0 : 0;
  // A crew list is taken only when it is one the client would accept (vehicles.pyc _readCrew): every
  // role held by somebody, one commander and never as an extra role, no role twice on one tankman.
  function aimCrewOf(a) {
    var list = a && a.crewRoles;
    if (!list || !list.length || list.length > 8) return AIM_DEFAULT_CREW;
    var crew = [], held = {}, commanders = 0;
    for (var i = 0; i < list.length; i++) {
      var roles = list[i], member = [];
      if (!roles || !roles.length || roles.length > AIM_CREW_ROLES.length) return AIM_DEFAULT_CREW;
      for (var j = 0; j < roles.length; j++) {
        var role = String(roles[j]);
        if (AIM_CREW_ROLES.indexOf(role) < 0 || member.indexOf(role) >= 0) return AIM_DEFAULT_CREW;
        if (role === 'commander') { if (j) return AIM_DEFAULT_CREW; commanders++; }
        member.push(role); held[role] = true;
      }
      crew.push(member);
    }
    if (commanders !== 1) return AIM_DEFAULT_CREW;
    for (var r = 0; r < AIM_CREW_ROLES.length; r++) if (!held[AIM_CREW_ROLES[r]]) return AIM_DEFAULT_CREW;
    return crew;
  }
  function aimCrew() { return aimCrewOf(aimBlockData()); }
  // A crew member's name in a preset: his main role, numbered from the second of that role on ('loader',
  // 'loader2'). A preset is shared between vehicles whose crews differ, so it cannot name slot indices;
  // the role is what carries over.
  var AIM_MEMBER_KEY = /^(commander|gunner|driver|radioman|loader)[2-9]?$/;
  function aimCrewKeys(crew) {
    var seen = {};
    return crew.map(function (roles) {
      var main = roles[0];
      seen[main] = (seen[main] || 0) + 1;
      return seen[main] > 1 ? main + seen[main] : main;
    });
  }
  // THE CREW LAW, per role, from the client's own crew code (items/VehicleDescrCrew.pyc; the report above,
  // sections 1-5, checked by running that bytecode on built crews):
  //   B      = 5 x sum(Brothers in Arms level of each tankman) / (N x 100)   _calculateLevelIncreaseByBrotherhood
  //   common = B + every other crew-level add                                _buildFactors
  //   inc    = common for the commander,                                     _calcLeverIncreaseForNonCommander
  //            common + (100 + common) / 10 for everybody else               (COMMANDER_ADDITION_RATIO)
  //   eff(r) = mean over the tankmen who hold role r of (100 + inc) / 100    _computeSummSkillLevel
  //   f(r)   = 0.57 + 0.43 x eff(r)                                          _processSkills
  // The gunner's f sets shot dispersion x 1/f, aiming time x 1/f and turret speed x f (_updateGunnerFactors);
  // the loader's sets the reload x 1/f (_updateLoaderFactors). N is the number of TANKMEN, not of roles.
  // Brothers in Arms is neither all-or-nothing nor a bonus of the man who has it: it is ONE crew-wide
  // average. Every tankman who has it adds 5/N levels to everybody; one without it adds nothing but still
  // counts in N. A role the commander holds himself gets no commander's tenth, so it is 1.0 with nothing
  // fitted rather than 1.043 - which is why the gunner and the loader have a factor each.
  // 'levels' is every other crew-level add: the ventilation in a slot, the combat rations (+10), the Vent
  // Purge directive (+2.5) and the six situational crew-level perks (equipment report 2.6, 6.1, 7 and 8).
  //
  // THE CREW IS NOT A SETTING (user, 19.09): every tankman is fully trained (role level 100, skills
  // efficiency 1.0), alive and on his own vehicle, because that is what a real vehicle in a battle has. That
  // is why the baseline f is 1.043 and not 1.0 - the bare descriptor the record carries has no crew at all.
  // Only what a player really trains or fits is switchable, Brothers in Arms per member included. `bia` is
  // each tankman's Brothers in Arms level, 0..100, in crew order; the page only ever passes 0 or 100.
  function crewFactors(crew, bia, levels) {
    var n = crew.length, sum = 0, i;
    for (i = 0; i < n; i++) sum += Math.max(0, Math.min(100, Number(bia[i]) || 0));
    var brotherhood = n ? AIM_BIA_LEVELS * sum / (n * 100) : 0;
    var common = brotherhood + (Number(levels) || 0), others = common + (100 + common) / 10;
    var out = {brotherhood: brotherhood, common: common};
    AIM_CREW_ROLES.forEach(function (role) {
      var total = 0, count = 0;
      crew.forEach(function (roles) {
        if (roles.indexOf(role) < 0) return;
        total += (100 + (roles[0] === 'commander' ? common : others)) / 100; count++;
      });
      // A role nobody holds cannot come out of aimCrewOf; it would count as a non-commander's.
      out[role] = 0.57 + 0.43 * (count ? total / count : (100 + others) / 100);
    });
    return out;
  }
  // The factors of the shooter on screen, with the configuration on screen and `levels` added crew levels.
  function aimCrewFactors(levels) {
    // Crew skills the vehicle's own lockCrewSkills fixes (S3) are not the user's to give: nobody has Brothers
    // in Arms then, and the crew is the plain trained one.
    var crew = aimCrew(), keys = aimCrewKeys(crew), locked = aimForbidden('crew');
    return crewFactors(crew, keys.map(function (k) { return !locked && shooterConfig.bia[k] ? 100 : 0; }), levels);
  }
  // --- The configuration object -----------------------------------------------------------------
  // {slots: [device id, '', ''],      one device id per optional-device slot, '' = empty
  //  directive: '',                   one directive id
  //  food: false, fuel: '',           the consumables
  //  skills: {gunner_smoothTurret: true},  the crew skills and perks that are on, Brothers in Arms apart
  //  bia: {commander: true, gunner: true}}  the crew members who have Brothers in Arms, by aimCrewKeys()
  var AIM_PRESET_LIMIT = 40, AIM_NAME_LIMIT = 48;
  // User presets, the preset last chosen per shooter type and the state of the switch, kept in the
  // page's one settings object under its own key. Storage may be refused (the game's CEF, a private
  // window): everything here works without it and the presets then live for the session only.
  // Version 3 is the real-item model; a version 2 store (the kind/variant slots of 0.7.15) is dropped
  // the way v2 dropped v1, because "stabiliser, variant trophyUp" cannot be turned into a client entry
  // id without guessing which Class band the vehicle takes.
  // Brothers in Arms per crew member (21.09) did NOT change the version: a build that gives it to the
  // whole crew is stored as skills.brotherhood exactly as before, and only a partly trained crew adds a
  // `bia` map beside it - which an older page simply does not read. Nothing saved is dropped.
  var aimStore = {presets: {}, chosen: {}};
  var shooterFit = null;
  var shooterConfig = aimValues(null), shooterPreset = '';
  // The one door every configuration comes through, wherever it came from - a preset, the store, a
  // click or a built-in build. A device the vehicle cannot mount and a device whose archetype another
  // slot already holds are both dropped here and nowhere else.
  function aimValues(base) {
    var out = {slots: ['', '', ''], directive: '', food: false, fuel: '', skills: {}, bia: {}};
    if (!base) return out;
    var taken = {};
    AIM_SLOTS.forEach(function (i) {
      var id = aimResolve(base.slots && base.slots[i] ? String(base.slots[i]) : '');
      var dev = DEVICE_BY_ID[id];
      if (!dev) return;
      for (var b = 0; b < dev.blocks.length; b++) if (taken[dev.blocks[b]]) return;
      dev.blocks.forEach(function (tag) { taken[tag] = true; });
      out.slots[i] = id;
    });
    if (DIRECTIVE_BY_ID[String(base.directive || '')]) out.directive = String(base.directive);
    out.food = base.food === true || base.food === '1' || base.food === 1;
    var fuel = String(base.fuel || '');
    if (fuel === 'qualityFuel' || fuel === 'excellentFuel') out.fuel = fuel;
    function flag(v) { return v === true || v === '1'; }
    var skills = base.skills && typeof base.skills === 'object' ? base.skills : {};
    AIM_SKILLS.forEach(function (s) {
      if (s.role !== 'each' && flag(skills[s.id])) out.skills[s.id] = true;
    });
    // Brothers in Arms is one switch per crew member now. The whole-crew flag the store and the built-in
    // presets held until 21.09, skills.brotherhood, means "every member has it" and still does - on
    // whatever crew the vehicle on screen has. A partly trained crew comes as the `bia` map; a key that
    // is no crew member's name is dropped, one this crew does not have is kept for a crew that has him.
    if (flag(skills.brotherhood)) aimCrewKeys(aimCrew()).forEach(function (k) { out.bia[k] = true; });
    else if (base.bia && typeof base.bia === 'object') Object.keys(base.bia).forEach(function (k) {
      if (AIM_MEMBER_KEY.test(k) && flag(base.bia[k])) out.bia[k] = true;
    });
    return out;
  }
  // What a preset holds: the build, never the vehicle's slot categories. Brothers in Arms on every member
  // of the crew is written the way it always was, skills.brotherhood, so the preset still means "the whole
  // crew" on a vehicle whose crew is another size; only a partly trained crew needs the `bia` map.
  function aimPresetValues(cfg) {
    var skills = {}, keys = aimCrewKeys(aimCrew());
    Object.keys(cfg.skills).forEach(function (id) { if (cfg.skills[id]) skills[id] = true; });
    var out = {slots: cfg.slots.slice(), directive: cfg.directive, food: cfg.food, fuel: cfg.fuel, skills: skills};
    var bia = {}, some = false;
    Object.keys(cfg.bia || {}).sort().forEach(function (k) { if (cfg.bia[k]) { bia[k] = true; some = true; } });
    if (keys.length && keys.every(function (k) { return bia[k]; })) skills.brotherhood = true;
    else if (some) out.bia = bia;
    return out;
  }
  function aimSkillKey(cfg) {
    return AIM_SKILLS.filter(function (s) { return !!cfg.skills[s.id]; })
      .map(function (s) { return s.id; }).join(',');
  }
  // Who of the crew on screen has Brothers in Arms, as one comparable string.
  function aimBiaKey(cfg) {
    return aimCrewKeys(aimCrew()).filter(function (k) { return !!(cfg.bia && cfg.bia[k]); }).join(',');
  }
  function aimSame(a, b) {
    return a.slots.join('|') === b.slots.join('|') && a.directive === b.directive
      && !!a.food === !!b.food && a.fuel === b.fuel && aimSkillKey(a) === aimSkillKey(b)
      && aimBiaKey(a) === aimBiaKey(b);
  }
  // The built-in presets are read-only: they are what a player actually fits, so nobody has to
  // assemble a common build slot by slot every time. They name real items of the client; the Class
  // band is picked for the vehicle on screen by aimResolve. brotherhood: true is Brothers in Arms on
  // every member of the crew (aimValues).
  var AIM_BUILT_IN = [
    {name: 'Stock — no equipment', values: {}},
    {name: 'Rammer, stabiliser, vents',
     values: {slots: ['tankRammer_tier1', 'aimingStabilizer_tier1', 'improvedVentilation_tier1'],
              skills: {brotherhood: true, gunner_smoothTurret: true, driver_smoothDriving: true}}},
    {name: 'Improved Aiming, laying drive, stabiliser',
     values: {slots: ['improvedSights_tier1', 'enhancedAimDrives_tier1', 'aimingStabilizer_tier1'],
              directive: 'improvedSightsBattleBooster',
              skills: {brotherhood: true, gunner_smoothTurret: true, gunner_armorer: true}}},
    {name: 'Bounty — rammer, stabiliser, vents',
     values: {slots: ['trophyUpgradedTankRammer', 'trophyUpgradedAimingStabilizer', 'trophyUpgradedImprovedVentilation'],
              food: true,
              skills: {brotherhood: true, gunner_smoothTurret: true, driver_smoothDriving: true}}}];
  shooterPreset = AIM_BUILT_IN[0].name;   // the stock build, until a shooter is on screen
  function aimBuiltIn(name) {
    for (var i = 0; i < AIM_BUILT_IN.length; i++) if (AIM_BUILT_IN[i].name === name) return AIM_BUILT_IN[i];
    return null;
  }
  function aimPreset(name) {
    var built = aimBuiltIn(name);
    if (built) return aimValues(built.values);
    return aimStore.presets[name] ? aimValues(aimStore.presets[name]) : null;
  }
  function aimUserNames() { return Object.keys(aimStore.presets).sort(); }
  // A name the user typed and a preset read back from storage are both data, never markup: they only
  // ever become the text of an <option> or of a list item, and both are length-capped.
  function aimName(raw) { return String(raw === undefined || raw === null ? '' : raw).trim().slice(0, AIM_NAME_LIMIT); }
  // What came back from localStorage is checked field by field: an unknown key is dropped, an item the
  // catalogue does not know falls away, and a name that collides with a built-in preset is refused, so
  // a corrupted or hand-edited store can never put the page in a state it cannot show.
  function adoptAimStore(box) {
    if (!box || typeof box !== 'object') return;
    aimStore = {presets: {}, chosen: {}};
    if (Number(box.v) !== 3) return;   // 0.7.15 presets held kinds and variants, not client entries
    var presets = {}, chosen = {}, count = 0;
    if (box.presets && typeof box.presets === 'object') Object.keys(box.presets).forEach(function (key) {
      var name = aimName(key), row = box.presets[key];
      if (!name || aimBuiltIn(name) || !row || typeof row !== 'object' || count >= AIM_PRESET_LIMIT) return;
      presets[name] = aimStoredPreset(row); count++;
    });
    if (box.chosen && typeof box.chosen === 'object') Object.keys(box.chosen).forEach(function (type) {
      var name = aimName(box.chosen[type]);
      if (name && (aimBuiltIn(name) || presets[name])) chosen[String(type).slice(0, 64)] = name;
    });
    aimStore.presets = presets; aimStore.chosen = chosen;
  }
  // A stored preset, checked field by field and kept in the shape it was SAVED in (S3, 22.09). The load used
  // to run it through aimPresetValues(aimValues(row)), which decides "the whole crew or only some" against
  // the crew ON SCREEN at that moment - at start-up the assumed five. A map saved for five members of a
  // six-man crew covered those five completely, came back as skills.brotherhood, and the next persist wrote
  // that over the preset: Brothers in Arms for all six on the very vehicle it was saved for. Nothing here
  // depends on the vehicle on screen now: device ids are checked against the catalogue, not against what
  // this shooter may mount - that, and the crew, are aimValues' business when the preset is APPLIED.
  function aimStoredPreset(row) {
    function flag(v) { return v === true || v === '1'; }
    var out = {slots: ['', '', ''], directive: '', food: false, fuel: '', skills: {}};
    AIM_SLOTS.forEach(function (i) {
      var id = row.slots && row.slots[i] ? String(row.slots[i]) : '';
      if (DEVICE_BY_ID[id]) out.slots[i] = id;
    });
    if (DIRECTIVE_BY_ID[String(row.directive || '')]) out.directive = String(row.directive);
    out.food = row.food === true || row.food === '1' || row.food === 1;
    var fuel = String(row.fuel || '');
    if (fuel === 'qualityFuel' || fuel === 'excellentFuel') out.fuel = fuel;
    var skills = row.skills && typeof row.skills === 'object' ? row.skills : {};
    AIM_SKILLS.forEach(function (s) {
      if (s.role !== 'each' && flag(skills[s.id])) out.skills[s.id] = true;
    });
    if (flag(skills.brotherhood)) out.skills.brotherhood = true;
    else if (row.bia && typeof row.bia === 'object') {
      var bia = {}, some = false;
      Object.keys(row.bia).sort().forEach(function (k) {
        if (AIM_MEMBER_KEY.test(k) && flag(row.bia[k])) { bia[k] = true; some = true; }
      });
      if (some) out.bia = bia;
    }
    return out;
  }
  function aimStored() { return {v: 3, presets: aimStore.presets, chosen: aimStore.chosen}; }
  // --- Reading the configuration ----------------------------------------------------------------
  // Which slot holds a device that occupies `tag`, or -1. Two devices conflict when their `blocks`
  // lists intersect - the client's own <incompatibleTags><installed> rule, and the reason a Vertical
  // Stabilizer may sit beside a Fire-Control System even though that system also stabilises.
  function aimSlotWith(tag) {
    for (var i = 0; i < AIM_SLOTS.length; i++) {
      var dev = DEVICE_BY_ID[shooterConfig.slots[i]];
      if (!dev) continue;
      for (var b = 0; b < dev.blocks.length; b++) if (dev.blocks[b] === tag) return i;
    }
    return -1;
  }
  function aimConflict(dev, index) {
    if (!dev) return -1;
    for (var b = 0; b < dev.blocks.length; b++) {
      var at = aimSlotWith(dev.blocks[b]);
      if (at >= 0 && at !== index) return at;
    }
    return -1;
  }
  // The tag set a directive's deviceFilter is matched against, PER DEVICE: the archetypes that one
  // piece occupies, plus the grade word the client uses for it (report section 7). Per device and not
  // over the whole build, because battle_boosters.xml asks whether ONE fitted device carries the
  // required tags - over the build, an upgraded Bounty rammer would make the Polished Lens believe the
  // sights were upgraded Bounty as well.
  // The page's Bounty tile IS the client's upgraded piece (one grade, user 21.09), so it carries the
  // trophyUpgraded tag - the one the directives actually ask for.
  var AIM_TIER_TAG = {improved: 'deluxe', bounty: 'trophyUpgraded'};
  function aimDeviceTags(dev) {
    var tags = {};
    dev.blocks.forEach(function (tag) { tags[tag] = true; });
    if (AIM_TIER_TAG[dev.tier]) tags[AIM_TIER_TAG[dev.tier]] = true;
    return tags;
  }
  function aimLevelFits(level, tags) {
    var j;
    for (j = 0; j < (level.needs || []).length; j++) if (!tags[level.needs[j]]) return false;
    for (j = 0; j < (level['not'] || []).length; j++) if (tags[level['not'][j]]) return false;
    return true;
  }
  // An equipment directive picks the first level a fitted device satisfies - the client's own order in
  // battle_boosters.xml. A directive whose device is not fitted has no level at all: it is still
  // offered, and shown inactive.
  function aimDirectiveLevel(dir) {
    if (!dir || !dir.levels) return null;
    for (var i = 0; i < dir.levels.length; i++) {
      for (var s = 0; s < AIM_SLOTS.length; s++) {
        var dev = DEVICE_BY_ID[shooterConfig.slots[s]];
        if (dev && aimLevelFits(dir.levels[i], aimDeviceTags(dev))) return dir.levels[i];
      }
    }
    return null;
  }
  // A crew directive multiplies the boosted skill's TRAINED LEVEL, which doubles that skill's
  // deviation from 1: Snap Shot's x0.925 at skillMult 2 becomes x0.85. It reaches the maths only
  // through a skill that is switched on - what the client grants a crew member who never learned the
  // skill is not in the data (report section 7), so the page does not invent a level for it.
  function aimSkillMult(id) {
    if (aimForbidden('devices') || aimForbidden('crew')) return 1;   // no directive, or no skill, is in force (S3)
    var dir = DIRECTIVE_BY_ID[shooterConfig.directive];
    return dir && dir.skill === id && dir.skillMult > 1 && shooterConfig.skills[id] ? Number(dir.skillMult) : 1;
  }
  function aimBoost(eff, mult) {
    var op = eff[0], v = Number(eff[1]);
    if (mult > 1) v = op === 'add' ? v * mult : 1 - (1 - v) * mult;
    return [op, v];
  }
  // Every multiplier and every added crew level of the configuration, gathered in one pass: the
  // devices in their slots, the crew skills and perks that are on, the directive and the consumables.
  // A kind the vehicle's own lock makes 'forbidden' (S3, aimPolicyFor) is left out here and nowhere else:
  // the configuration itself - and the user's preset - keeps it, so the same build comes back whole on
  // the next vehicle that may fit it.
  function aimEffects() {
    var mul = {}, add = {};
    function apply(input, eff) {
      if (!eff) return;
      var v = Number(eff[1]);
      if (!isFinite(v)) return;
      if (eff[0] === 'add') add[input] = (add[input] || 0) + v;
      else mul[input] = (mul[input] === undefined ? 1 : mul[input]) * v;
    }
    var devices = !aimForbidden('devices');
    if (devices) AIM_SLOTS.forEach(function (i) {
      var dev = DEVICE_BY_ID[shooterConfig.slots[i]];
      if (!dev) return;
      Object.keys(dev.eff).forEach(function (input) {
        apply(input, [dev.eff[input][0], aimEffValue(dev.eff[input])]);
      });
    });
    if (!aimForbidden('crew')) AIM_SKILLS.forEach(function (s) {
      if (!shooterConfig.skills[s.id]) return;
      var mult = aimSkillMult(s.id);
      Object.keys(s.eff).forEach(function (input) { apply(input, aimBoost(s.eff[input], mult)); });
    });
    var level = devices ? aimDirectiveLevel(DIRECTIVE_BY_ID[shooterConfig.directive]) : null;
    if (level && level.eff) Object.keys(level.eff).forEach(function (input) { apply(input, level.eff[input]); });
    if (!aimForbidden('consumables')) AIM_CONSUMABLES.forEach(function (c) {
      if (!(c.slot === 'food' ? shooterConfig.food : shooterConfig.fuel === c.id)) return;
      Object.keys(c.eff).forEach(function (input) { apply(input, c.eff[input]); });
    });
    return {mul: mul, add: add};
  }
  function aimMul(e, input) { return e.mul[input] === undefined ? 1 : e.mul[input]; }
  function aimAdd(e, input) { return e.add[input] === undefined ? 0 : e.add[input]; }
  // The multipliers of the shooter's configuration, each named after the client attribute it
  // multiplies. The gunner and the loader each have their own crew factor: the law is the same, but a
  // role the commander holds himself gets no commander's tenth (crewFactors above).
  function aimModifiers() {
    var e = aimEffects(), crew = aimCrewFactors(aimAdd(e, 'crewLevel')), g = crew.gunner, l = crew.loader;
    return {mult: aimMul(e, 'multFactor') / g,             // multShotDispersionFactor and the gunner
            additive: aimMul(e, 'additiveFactor'),         // additiveShotDispersionFactor: the stabiliser
            movement: aimMul(e, 'movementFactor'),         // chassis/shotDispersionFactors/movement
            rotation: aimMul(e, 'rotationFactor'),         // chassis/shotDispersionFactors/rotation
            turret: aimMul(e, 'turretRotationFactor'),     // gun/shotDispersionFactors/turretRotation
            aimingTime: aimMul(e, 'aimingTimeFactor') / g, // gunAimingTimeFactor and the gunner
            reload: aimMul(e, 'reloadTimeFactor') / l,     // gunReloadTimeFactor and the loader
            turretSpeed: aimMul(e, 'turretRotationSpeed') * g,  // miscAttrs/turretRotationSpeed
            hullSpeed: aimMul(e, 'hullRotationSpeed'),     // Clutch Braking, through the rate
            clipInterval: aimMul(e, 'clipInterval'),       // Mag Mastery, on gun.clip[1]
            // forwardMaxSpeedKMHTerm / backwardMaxSpeedKMHTerm are km/h; the record holds m/s. A
            // turbocharger raises the cap the WASD model accelerates to, so the circle gets BIGGER.
            speedForwardAdd: aimAdd(e, 'speedForward') * KMH_TO_MS,
            speedBackwardAdd: aimAdd(e, 'speedBackward') * KMH_TO_MS};
            // enginePower has no home in the page's model and is deliberately left out: the movement
            // term reads the speed cap, not the power that gets there. It is named in the tooltips.
            // The driving ramps are constants in ballistics.js now (user, 20.09: no seconds in the UI).
  }
  // One place every edit of the configuration goes through, wherever it came from: the preset label is
  // re-decided, the popover is repainted, the state is remembered for this shooter and the circle is
  // recomputed.
  function aimConfigChanged() {
    shooterPreset = aimPresetMatch();
    if (shooterType) {
      shooterModsState[shooterType] = {values: aimValues(shooterConfig), preset: shooterPreset};
      if (shooterPreset) { aimStore.chosen[shooterType] = shooterPreset; persistSettings(); }
    }
    paintAimConfig(true);   // a click inside the open popover: its tiles depend on one another, all are redrawn
    // A different build is a different vehicle, not a moment in the life of this one: the running
    // exponential is dropped and the circle is rebuilt for the new modifiers, so the answer to "what
    // would a stabiliser do here" is on screen at once instead of waiting for the next frame.
    // Its figure goes with it: the 120 ms pace of the coarse estimate is for a ring that moves, not for a
    // new one, so it is taken at once, and the loop is woken to take the fine one when the ring rests -
    // a second click inside 120 ms used to leave the figure of the ring before it on the panel.
    aimNow = null; aimEstAt = 0; aimEstFine = false;
    updateAim(); startAimLoop(); scheduleLayout();
  }
  // Which preset the current values are, if any: a preset the user edited becomes "Custom" without
  // touching the preset it came from.
  function aimPresetMatch() {
    var names = AIM_BUILT_IN.map(function (p) { return p.name; }).concat(aimUserNames());
    for (var i = 0; i < names.length; i++) {
      var values = aimPreset(names[i]);
      if (values && aimSame(values, shooterConfig)) return names[i];
    }
    return '';
  }
  // The collapsed button says "Config" and nothing else (user, 20.09): no preset name, no "custom" or
  // "stock" - what is fitted is in the tiles one click away, and in the button's own tooltip.
  function aimLongSummary() {
    // What is IN FORCE: a kind the vehicle's lock forbids (S3) is not listed, although the configuration
    // still holds it for the next vehicle.
    var out = [];
    if (!aimForbidden('devices')) {
      AIM_SLOTS.forEach(function (i) {
        var dev = DEVICE_BY_ID[shooterConfig.slots[i]];
        if (dev) out.push(dev.name);
      });
      var dir = DIRECTIVE_BY_ID[shooterConfig.directive];
      if (dir) out.push(dir.name + (aimDirectiveActive(dir) ? '' : ' (inactive)'));
    }
    if (!aimForbidden('consumables')) {
      if (shooterConfig.food) out.push('Combat rations');
      AIM_CONSUMABLES.forEach(function (c) { if (c.slot === 'fuel' && shooterConfig.fuel === c.id) out.push(c.name); });
    }
    if (!aimForbidden('crew')) {
      var keys = aimCrewKeys(aimCrew()), have = keys.filter(function (k) { return !!shooterConfig.bia[k]; }).length;
      if (have) out.push('Brothers in Arms' + (have < keys.length ? ' (' + have + ' of ' + keys.length + ')' : ''));
      var skills = AIM_SKILLS.filter(function (s) { return !!shooterConfig.skills[s.id]; });
      if (skills.length) out.push(skills.map(function (s) { return s.name; }).join(', '));
    }
    return out.length ? out.join(' · ') : 'nothing fitted';
  }
  function aimDirectiveActive(dir) {
    if (!dir) return false;
    return dir.skill ? aimSkillMult(dir.skill) > 1 : !!aimDirectiveLevel(dir);
  }
  // A new shooter on screen keeps his own configuration for the session, exactly as the target group
  // does; the preset he was last given is remembered across launches, per vehicle type.
  function syncShooterMods(hit) {
    var a = hit && hit.attacker || null, type = a && a.type ? String(a.type) : '';
    // A different shooter is a different gun: the running exponential, the shot fired and the reload
    // belong to the one that has just left the screen and would otherwise be read as this one's.
    var changed = type !== shooterType;
    shooterType = type;
    // What he may mount is read before anything is normalised: aimValues drops a device this vehicle
    // cannot take, and it has to know which vehicle that is. So is what the battle and the vehicle's own
    // locks allow (S3): it decides which kinds of the configuration are applied at all.
    shooterFit = aimFitment(a);
    shooterPolicy = aimPolicyFor(hit);
    paintAimMechanics();
    var kept = type ? shooterModsState[type] : null;
    if (kept) { shooterConfig = aimValues(kept.values); shooterPreset = kept.preset || aimPresetMatch(); }
    else {
      var chosen = type && aimStore.chosen[type] ? aimStore.chosen[type] : '';
      var values = chosen ? aimPreset(chosen) : null;
      shooterConfig = aimValues(values);
      shooterPreset = values ? chosen : aimPresetMatch();
      if (type) shooterModsState[type] = {values: aimValues(shooterConfig), preset: shooterPreset};
    }
    if (changed) resetAimRun();
    paintAimConfig();
  }
  // --- The Configuration popover ----------------------------------------------------------------
  // The one editor of the configuration, on the page's own popover mechanism: a <details> with a
  // .toolbar-popover, closed by the document click handler like every other one. It hangs under the
  // Shooter tile, so it opens upward. Four sections in the garage's own order: Equipment, Directive,
  // Consumables, Crew.
  var aimConfigControls = {}, aimNameMode = '', aimPickerOpen = '';
  // The icons ship with the page in web/icons (user, 20.09: interface art belongs to the page, a fresh
  // install must look right before the first game start). A missing file still falls back to a short
  // text label instead of a broken image.
  //
  // `badge` is the grade mark the client lays over the icon's corner. All grades of one device share
  // ONE picture in the client - checked over all 47 gunnery entries, 21.09: not one has art of its own
  // - so the badge is the only thing that tells a Bounty rammer from a standard one, and the page
  // copies that rather than captioning the tile. A badge whose file is not there yet simply goes: the
  // grade is still on the tile as the frame colour, and a word in its place is exactly what the tiles
  // are not allowed to carry (user, 21.09). `label` is the last resort for a missing DEVICE icon,
  // which would otherwise leave a blank square nobody can identify; every icon the page names ships
  // with it, so it is a broken-art net and not a caption.
  function aimIcon(name, label, badge) {
    var box = node('span', undefined, 'aim-icon');
    var img = node('img');
    img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.draggable = false;
    img.onerror = function () { this.remove(); box.appendChild(node('span', label, 'aim-icon-text')); };
    img.src = 'web/icons/' + name + '.png';
    box.appendChild(img);
    if (badge) {
      var over = node('img', undefined, 'aim-badge');
      over.alt = ''; over.setAttribute('aria-hidden', 'true'); over.draggable = false;
      over.onerror = function () { this.remove(); };
      over.src = 'web/icons/' + badge + '.png';
      box.appendChild(over);
    }
    return box;
  }
  // The badge of a device's grade. The experimental tier has three of them, one per level, and the
  // level is the trailing digit of the client's own entry id (modernizedAimDrivesAimingStabilizer2 is
  // T2); the catalogue carries the stem and the flag that says to complete it.
  function aimDeviceBadge(dev) {
    var tier = TIER_BY_ID[dev.tier] || {};
    if (!tier.badge) return '';
    if (!tier.badgeLevel) return tier.badge;
    var level = /(\d)$/.exec(dev.id);
    return level ? tier.badge + level[1] : '';
  }
  function aimShort(name) {
    var word = String(name || '').split(' ')[0];
    return word.length > 6 ? word.slice(0, 6) : word;
  }
  // The tooltip of a device: the garage name, the grade, what the family does, every factor with the
  // input it moves, and the client entry id - so every number on screen can be walked straight back
  // into optional_devices.xml. The tile itself says none of this; the hover does.
  function aimDeviceTitle(dev) {
    var tier = TIER_BY_ID[dev.tier] || {}, fam = FAMILY_BY_ID[dev.family] || {}, parts = [];
    Object.keys(dev.eff).forEach(function (input) {
      var eff = dev.eff[input], v = aimEffValue(eff);
      parts.push((eff[0] === 'add' ? (v >= 0 ? '+' : '') + aimNum(v) : '×' + aimNum(v))
                 + ' on ' + (AIM_INPUT_WORDS[input] || input));
    });
    return dev.name + ' · ' + (tier.name || dev.tier) + (fam.what ? ' · it ' + fam.what : '')
      + ' · ' + parts.join('; ') + '. (optional_devices.xml ' + dev.id + ')';
  }
  // A tile of a kind the vehicle's own lock forbids (S3): shown empty, not pressable, and its tooltip says
  // why. aria-disabled rather than `disabled`, so the tooltip still shows on hover.
  function aimLockTile(tile, kind, what) {
    tile.setAttribute('aria-disabled', 'true');
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('data-tier', 'none');
    tile.title = what + aimPolicyLine(kind);
    tile.onclick = function (e) { e.stopPropagation(); };
    return tile;
  }
  function aimSlotTile(index) {
    var dev = DEVICE_BY_ID[shooterConfig.slots[index]], key = 'slot' + index;
    var tile = node('button', undefined, 'aim-tile aim-slot');
    tile.type = 'button';
    if (aimForbidden('devices')) {
      tile.setAttribute('aria-label', 'Slot ' + (index + 1) + ': not offered for this vehicle');
      tile.appendChild(aimIcon('empty_slot', '—'));
      return aimLockTile(tile, 'devices', 'Slot ' + (index + 1) + '. ');
    }
    tile.setAttribute('data-tier', dev ? dev.tier : 'none');
    tile.setAttribute('aria-expanded', String(aimPickerOpen === key));
    var what = 'Slot ' + (index + 1) + '. ';
    tile.title = dev ? what + aimDeviceTitle(dev) + ' Click to change it, or to take it out.'
                     : what + 'Empty. Click to fit a piece of equipment.';
    tile.setAttribute('aria-label', what + (dev ? dev.name : 'Empty'));
    tile.appendChild(dev ? aimIcon(dev.icon, aimShort((FAMILY_BY_ID[dev.family] || {}).name || dev.name),
                                   aimDeviceBadge(dev))
                         : aimIcon('empty_slot', '—'));
    tile.onclick = function (e) { e.stopPropagation(); aimOpenPicker(key); };
    return tile;
  }
  function aimOpenPicker(key) {
    if (aimForbidden('devices')) key = '';   // nothing to pick for a vehicle whose devices the game fixes (S3)
    aimPickerOpen = aimPickerOpen === key ? '' : key; paintAimConfig(true);
  }
  // A tile of the picker: the client's own icon with the client's own grade badge over the corner, and
  // not one word (user, 21.09). `art` is {icon, label, badge}: the label is the tile's accessible name,
  // because a button made of a decorative picture has none otherwise, and everything that used to be
  // printed on the tile is in `title`.
  function aimPickTile(art, title, pressed, disabled, tier) {
    var tile = node('button', undefined, 'aim-pick');
    tile.type = 'button';
    tile.setAttribute('data-tier', tier || 'none');
    tile.setAttribute('aria-pressed', String(!!pressed));
    tile.setAttribute('aria-label', art.label);
    tile.disabled = !!disabled;
    tile.title = title;
    tile.appendChild(aimIcon(art.icon, aimShort(art.short || art.label), art.badge));
    return tile;
  }
  // The picker's four groups, in the garage's own order. The game groups by GRADE and shows the items
  // inside it; Bounty is one grade here and its piece is the upgraded one (user, 21.09), because that
  // is the state a Bounty piece ends up in.
  var AIM_GRADE_GROUPS = [
    {name: 'Standard', tiers: ['standard'], collapse: true},
    {name: 'Bounty', tiers: ['bounty']},
    {name: 'Improved', tiers: ['improved']},
    {name: 'Experimental', tiers: ['experimental']}];
  // What a group offers this vehicle, in catalogue order. In the Standard group the Class bands of one
  // family COLLAPSE into a single tile: tankRammer_tier1 and tankRammer_tier2 are the same item for a
  // different vehicle tier and carry identical factors, so three rammers in a row are three names for
  // one piece. The tooltip names the bands instead. Experimental is not collapsed - T1, T2 and T3 are
  // three genuinely different items.
  function aimGroupItems(group) {
    var out = [], byFamily = {};
    AIM_DEVICES.forEach(function (dev) {
      if (group.tiers.indexOf(dev.tier) < 0 || !aimFits(dev)) return;
      var seen = group.collapse ? byFamily[dev.family] : null;
      if (seen) { seen.band.push(dev); return; }
      var item = {dev: dev, band: [dev]};
      if (group.collapse) byFamily[dev.family] = item;
      out.push(item);
    });
    return out;
  }
  // Everything the tile no longer prints: the device, its grade note, the collapsed Class bands and
  // the reason a piece is greyed out.
  function aimPickTitle(item, clash) {
    var tier = TIER_BY_ID[item.dev.tier] || {};
    var bands = item.band.length > 1
      ? ' One item under ' + item.band.length + ' names here — '
        + item.band.map(function (d) { return d.name; }).join(', ') + ' — for this vehicle.'
      : '';
    return aimDeviceTitle(item.dev) + (tier.note ? ' ' + tier.note : '') + bands
      + (clash >= 0 ? ' Already fitted in another slot.' : '');
  }
  // The equipment picker: one dense grid of icons per grade. Only the pieces THIS vehicle may mount are
  // listed (report section 4); a piece whose archetype another slot already holds is shown disabled
  // instead of vanishing, so the conflict is visible.
  // There is no "empty this slot" tile any more (user, 21.09): it wore the empty slot's own art and dashed
  // frame, so it read as a second copy of the slot just clicked. The piece fitted in THIS slot is the
  // pressed tile, and clicking it takes it out - the way the fuel chips already work. A collapsed Standard
  // tile is pressed for any Class band it stands for, since a preset may have fitted the other band.
  function aimPicker(index) {
    var box = node('div', undefined, 'aim-picker'), fitted = shooterConfig.slots[index];
    AIM_GRADE_GROUPS.forEach(function (group) {
      var items = aimGroupItems(group);
      if (!items.length) return;
      box.appendChild(node('div', group.name, 'aim-pick-grade'));
      var row = node('div', undefined, 'aim-pick-row');
      items.forEach(function (item) {
        var dev = item.dev, clash = aimConflict(dev, index);
        var here = !!fitted && item.band.some(function (d) { return d.id === fitted; });
        var tile = aimPickTile({icon: dev.icon, label: dev.name, badge: aimDeviceBadge(dev),
                                short: (FAMILY_BY_ID[dev.family] || {}).name || dev.name},
                               aimPickTitle(item, clash)
                                 + (here ? ' Fitted in slot ' + (index + 1) + ': click it to take it out.' : ''),
                               here, clash >= 0, dev.tier);
        tile.onclick = function (e) { e.stopPropagation(); aimSetSlot(index, here ? '' : dev.id); };
        row.appendChild(tile);
      });
      box.appendChild(row);
    });
    return box;
  }
  function aimSetSlot(index, id) {
    var dev = DEVICE_BY_ID[id];
    // The client's own rule: two devices whose `blocks` intersect cannot sit together, so fitting this
    // one takes the piece it clashes with out of wherever it was.
    if (dev) {
      var clash = aimConflict(dev, index);
      if (clash >= 0) shooterConfig.slots[clash] = '';
    }
    shooterConfig.slots[index] = dev ? dev.id : '';
    aimPickerOpen = '';
    aimConfigChanged();
  }
  // The directive: one slot, in force for the whole battle. An equipment directive without its device
  // is offered but inactive - the client would not apply it either - and says which device it wants.
  function aimDirectiveTitle(dir) {
    var level = aimDirectiveLevel(dir), parts = [];
    if (dir.skill) {
      var skill = SKILL_BY_ID[dir.skill] || {};
      var on = !!shooterConfig.skills[dir.skill];
      return dir.name + ' · a crew directive: it multiplies ' + (skill.name || dir.skill)
        + '’s trained level by ' + aimNum(dir.skillMult) + ', which doubles that skill’s deviation — '
        + '×0.925 becomes ×0.85. ' + (on ? 'Active: the skill is trained here.'
          : 'Inactive: switch ' + (skill.name || dir.skill) + ' on in Crew below. The client also grants the '
            + 'skill to a crew member who never learned it, but at what level is not in the data, so the page '
            + 'does not guess one.')
        + ' (battle_boosters.xml ' + dir.id + ')';
    }
    var base = (dir.levels && dir.levels[0]) || {};
    if (level) Object.keys(level.eff).forEach(function (input) {
      var eff = level.eff[input], v = Number(eff[1]);
      parts.push((eff[0] === 'add' ? (v >= 0 ? '+' : '') + aimNum(v) : '×' + aimNum(v))
                 + ' on ' + (AIM_INPUT_WORDS[input] || input));
    });
    var needs = (base.needs || []).map(function (tag) {
      return AIM_ARCHETYPE_WORDS[tag] || AIM_GRADE_WORDS[tag] || tag;
    }).join(' ');
    return dir.name + ' · an equipment directive, in force for the whole battle. '
      + (level ? parts.join('; ') + '.' : 'Inactive: it needs ' + (needs || 'its own device') + ' in a slot.')
      + ' (battle_boosters.xml ' + dir.id + ')';
  }
  function aimDirectiveTile() {
    var dir = DIRECTIVE_BY_ID[shooterConfig.directive];
    var tile = node('button', undefined, 'aim-tile aim-slot');
    tile.type = 'button';
    if (aimForbidden('devices')) {
      tile.setAttribute('aria-label', 'Directive: not offered for this vehicle');
      tile.appendChild(aimIcon('empty_slot', '—'));
      return aimLockTile(tile, 'devices', 'The directive slot. ');
    }
    tile.setAttribute('data-tier', dir ? (aimDirectiveActive(dir) ? 'improved' : 'none') : 'none');
    tile.setAttribute('aria-expanded', String(aimPickerOpen === 'directive'));
    tile.title = dir ? aimDirectiveTitle(dir) + ' Click to change the directive, or to take it out.'
                     : 'The directive slot, empty. Click to fit one.';
    tile.setAttribute('aria-label', 'Directive. ' + (dir ? dir.name : 'Empty'));
    tile.appendChild(dir ? aimIcon(dir.icon, aimShort(dir.name)) : aimIcon('empty_slot', '—'));
    tile.onclick = function (e) { e.stopPropagation(); aimOpenPicker('directive'); };
    return tile;
  }
  // The directive picker is the same grid of icons, without badges - a directive has no grade, and its
  // own art already tells the nine of them apart. The frame says whether it is active here. As in the
  // equipment picker, the fitted directive is the pressed tile and a click on it empties the slot: no
  // tile of the slot's own empty art stands in the list.
  function aimDirectivePicker() {
    var box = node('div', undefined, 'aim-picker');
    var row = node('div', undefined, 'aim-pick-row');
    AIM_DIRECTIVES.forEach(function (dir) {
      var active = aimDirectiveActive(dir), here = shooterConfig.directive === dir.id;
      var tile = aimPickTile({icon: dir.icon, label: dir.name},
                             aimDirectiveTitle(dir) + (here ? ' Fitted: click it to take it out.' : ''),
                             here, false, active ? 'improved' : 'none');
      tile.onclick = function (e) { e.stopPropagation(); aimSetDirective(here ? '' : dir.id); };
      row.appendChild(tile);
    });
    box.appendChild(row);
    return box;
  }
  function aimSetDirective(id) {
    shooterConfig.directive = DIRECTIVE_BY_ID[id] ? id : '';
    aimPickerOpen = '';
    aimConfigChanged();
  }
  // Consumables and crew are the same tile as the equipment (user, 21.09): the client's own icon,
  // pressed or not, and the words in the tooltip. A perk is situational - it holds only while its
  // condition does - and is marked by art, a dimmed tile with a dot in the corner, never by a word;
  // a skill is always on for a fully trained crew, which is the crew the page models. `plain` is a
  // grade the frame colours say nothing about: these tiles have no grade.
  function aimChip(icon, label, title, pressed, onclick, situational) {
    var chip = aimPickTile({icon: icon, label: label}, title, pressed, false, 'plain');
    if (situational) chip.setAttribute('data-situational', '1');
    chip.onclick = function (e) { e.stopPropagation(); onclick(); };
    return chip;
  }
  function aimConsumableChips() {
    var row = node('div', undefined, 'aim-chips');
    AIM_CONSUMABLES.forEach(function (c) {
      var parts = [];
      Object.keys(c.eff).forEach(function (input) {
        var eff = c.eff[input], v = Number(eff[1]);
        parts.push((eff[0] === 'add' ? (v >= 0 ? '+' : '') + aimNum(v) : '×' + aimNum(v))
                   + ' on ' + (AIM_INPUT_WORDS[input] || input));
      });
      var on = c.slot === 'food' ? !!shooterConfig.food : shooterConfig.fuel === c.id;
      var title = c.name + ' · ' + parts.join('; ') + '. ' + (c.note || '')
        + (c.slot === 'fuel' ? ' One fuel at a time; click the one that is on to take it off.' : '')
        + ' (vehicle_equipments.xml)';
      var chip = aimChip(c.icon, c.name, title, on, function () {
        if (c.slot === 'food') shooterConfig.food = !shooterConfig.food;
        else shooterConfig.fuel = shooterConfig.fuel === c.id ? '' : c.id;
        aimConfigChanged();
      }, false);
      row.appendChild(aimForbidden('consumables') ? aimLockTile(chip, 'consumables', c.name + '. ') : chip);
    });
    return row;
  }
  function aimSkillTitle(s) {
    var mult = aimSkillMult(s.id), parts = [];
    Object.keys(s.eff).forEach(function (input) {
      var eff = aimBoost(s.eff[input], mult), v = eff[1];
      parts.push((eff[0] === 'add' ? (v >= 0 ? '+' : '') + aimNum(v) : '×' + aimNum(v))
                 + ' on ' + (AIM_INPUT_WORDS[input] || input));
    });
    return s.name + ' · ' + (s.kind === 'perk' ? 'a perk, and it holds only ' + (s.when || 'in its own situation')
                                               : 'a skill, always on for the fully trained crew the page models')
      + ' · ' + parts.join('; ') + '.' + (s.note ? ' ' + s.note + '.' : '')
      + (mult > 1 ? ' A crew directive is doubling its trained level here.' : '')
      + ' (tankmen.xml ' + s.id + ', perks.xml)';
  }
  // A crew member by his roles, for the tooltips: "Commander", "Commander and Radio Operator", "Loader 2".
  function aimMemberName(crew, keys, i) {
    var names = crew[i].map(function (r) {
      for (var j = 0; j < AIM_ROLES.length; j++) if (AIM_ROLES[j].id === r) return AIM_ROLES[j].name;
      return r;
    });
    var number = /(\d)$/.exec(keys[i]);
    return names.join(' and ') + (number ? ' ' + number[1] : '');
  }
  // Brothers in Arms, one tile per crew member, first in his main role's group (user, 21.09). The tile
  // is the skill's icon and nothing else; what one member is worth - and why it is not +5 on its own -
  // is the tooltip's job.
  function aimBiaTitle(crew, keys, i) {
    var n = crew.length, per = AIM_BIA_LEVELS / n;
    var have = keys.filter(function (k) { return !!shooterConfig.bia[k]; }).length;
    var who = crew === AIM_DEFAULT_CREW
      ? 'The record does not carry this vehicle’s crew yet, so the page assumes five tankmen: commander, gunner, driver, radio operator and loader.'
      : 'This vehicle’s crew, from the record: ' + crew.map(function (r, j) { return aimMemberName(crew, keys, j); }).join(', ') + '.';
    return 'Brothers in Arms · ' + aimMemberName(crew, keys, i) + ' · a skill each crew member learns for himself. '
      + 'The client averages it over the whole crew: each of the ' + n + ' tankmen who has it adds '
      + aimNum(AIM_BIA_LEVELS) + '/' + n + ' = ' + aimNum(per) + ' crew level' + (per === 1 ? '' : 's')
      + ' to everybody, one without it adds nothing but still counts, and the full +' + aimNum(AIM_BIA_LEVELS)
      + ' comes only when all ' + n + ' have it. Now ' + have + ' of ' + n + ': +' + aimNum(per * have)
      + ' crew level' + (per * have === 1 ? '' : 's')
      + ', which tighten the circle and the aiming time, shorten the reload and speed the turret up. '
      + who + ' (tankmen.xml brotherhood; VehicleDescrCrew._calculateLevelIncreaseByBrotherhood)';
  }
  function aimBiaTile(crew, keys, i) {
    var key = keys[i];
    return aimChip(AIM_BIA.icon || AIM_BIA.id, AIM_BIA.name + ', ' + aimMemberName(crew, keys, i),
                   aimBiaTitle(crew, keys, i), !!shooterConfig.bia[key], function () {
      if (shooterConfig.bia[key]) delete shooterConfig.bia[key];
      else shooterConfig.bia[key] = true;
      aimConfigChanged();
    }, false);
  }
  function aimCrewSection(body) {
    var crew = aimCrew(), keys = aimCrewKeys(crew), locked = aimForbidden('crew');
    AIM_ROLES.forEach(function (role) {
      var rows = AIM_SKILLS.filter(function (s) { return s.role === role.id; });
      var members = [];
      if (AIM_BIA) crew.forEach(function (roles, i) { if (roles[0] === role.id) members.push(i); });
      if (!rows.length && !members.length) return;
      body.appendChild(node('div', role.name, 'aim-role'));
      var chips = node('div', undefined, 'aim-chips');
      members.forEach(function (i) {
        var tile = aimBiaTile(crew, keys, i);
        chips.appendChild(locked ? aimLockTile(tile, 'crew', 'Brothers in Arms, ' + aimMemberName(crew, keys, i) + '. ') : tile);
      });
      rows.forEach(function (s) {
        var chip = aimChip(s.icon || s.id, s.name, aimSkillTitle(s), !!shooterConfig.skills[s.id], function () {
          if (shooterConfig.skills[s.id]) delete shooterConfig.skills[s.id];
          else shooterConfig.skills[s.id] = true;
          aimConfigChanged();
        }, s.kind === 'perk');
        chips.appendChild(locked ? aimLockTile(chip, 'crew', s.name + '. ') : chip);
      });
      body.appendChild(chips);
    });
  }
  function buildAimConfig() {
    var body = $('aim-config-body');
    if (!body) return;
    body.replaceChildren();
    // Preset first: most of the time it is the only row anybody touches.
    var grid = node('div', undefined, 'aim-config-grid');
    var preset = node('select'); preset.id = 'aim-cfg-preset';
    preset.title = 'A saved build. Change anything below and the preset becomes “Custom” - the preset itself is left alone.';
    preset.onchange = function () {
      var values = aimPreset(this.value);
      if (!values) return;
      shooterConfig = values; shooterPreset = this.value;
      if (shooterType) aimStore.chosen[shooterType] = this.value;
      aimConfigChanged(); persistSettings();
    };
    aimConfigControls.preset = preset;
    aimRow(grid, 'Preset', preset);
    body.appendChild(grid);
    var actions = node('div', undefined, 'aim-config-row');
    [['save', 'Save as…'], ['rename', 'Rename'], ['delete', 'Delete']].forEach(function (row) {
      var kind = row[0], b = node('button', row[1]);
      b.type = 'button'; b.id = 'aim-cfg-' + kind;
      b.onclick = function () { aimPresetAction(kind); };
      aimConfigControls[kind] = b;
      actions.appendChild(b);
    });
    body.appendChild(actions);
    // The name is typed here, never in window.prompt: the game's CEF may not show one at all.
    var namer = node('div', undefined, 'aim-config-row'); namer.id = 'aim-cfg-namer'; namer.hidden = true;
    var field = node('input'); field.type = 'text'; field.id = 'aim-cfg-name'; field.maxLength = AIM_NAME_LIMIT;
    field.placeholder = 'Name of the build';
    field.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); aimPresetCommit(); } else if (e.key === 'Escape' || e.key === 'Esc') aimNameBox(''); };
    var confirm = node('button', 'Save'); confirm.type = 'button'; confirm.onclick = aimPresetCommit;
    var cancel = node('button', 'Cancel'); cancel.type = 'button'; cancel.onclick = function () { aimNameBox(''); };
    namer.appendChild(field); namer.appendChild(confirm); namer.appendChild(cancel);
    aimConfigControls.name = field; aimConfigControls.namer = namer;
    body.appendChild(namer);
    var warn = node('p', '', 'aim-config-note warn'); warn.id = 'aim-cfg-warn'; warn.hidden = true;
    aimConfigControls.warn = warn; body.appendChild(warn);

    body.appendChild(node('div', 'Equipment', 'aim-config-head'));
    var slots = node('div', undefined, 'aim-slots'); slots.id = 'aim-cfg-slots';
    aimConfigControls.slots = slots; body.appendChild(slots);
    var fitNote = node('p', '', 'aim-config-note'); fitNote.id = 'aim-cfg-fit'; fitNote.hidden = true;
    aimConfigControls.fit = fitNote; body.appendChild(fitNote);
    var picker = node('div'); picker.id = 'aim-cfg-picker'; picker.hidden = true;
    aimConfigControls.picker = picker; body.appendChild(picker);

    body.appendChild(node('div', 'Directive', 'aim-config-head'));
    var directive = node('div', undefined, 'aim-slots'); directive.id = 'aim-cfg-directive';
    aimConfigControls.directive = directive; body.appendChild(directive);

    body.appendChild(node('div', 'Consumables', 'aim-config-head'));
    var cons = node('div'); cons.id = 'aim-cfg-consumables';
    aimConfigControls.consumables = cons; body.appendChild(cons);

    body.appendChild(node('div', 'Crew', 'aim-config-head'));
    var crew = node('div'); crew.id = 'aim-cfg-crew';
    aimConfigControls.crew = crew; body.appendChild(crew);
    // No "Fitted: ..." line under the crew any more (user, 21.09): the tiles above already show what is
    // fitted, and the list lives on in the Config button's own tooltip.
    paintAimConfig();
  }
  function aimRow(grid, label, control) { grid.appendChild(node('span', label)); grid.appendChild(control); }
  // The corner readout and its ⓘ popover are gone (user, 20.09): the mode's one-line explanation is the
  // switch's own tooltip, and the figures of the two rings live on the two info panels.
  // `force`: repaint even with the popover closed. Without it a closed popover is only marked out of date and
  // is painted on the click that opens it (the summary's own click handler, which runs before <details>
  // opens): showing a hit rebuilt all of it - about a hundred nodes and two dozen icons - for a menu nobody
  // had open. The button's tooltip lists what is fitted and is on screen either way, so it is always written.
  var aimConfigDirty = false;
  function paintAimConfig(force) {
    var preset = aimConfigControls.preset;
    if (!preset) return;
    $('aim-config').querySelector('summary').title = 'This shooter’s equipment, directive, consumables and crew, with presets. Now: ' + aimLongSummary() + '.';
    paintAimModeMark();
    if (!force && !$('aim-config').open) { aimConfigDirty = true; return; }
    aimConfigDirty = false;
    var names = AIM_BUILT_IN.map(function (p) { return p.name; }).concat(aimUserNames());
    preset.replaceChildren();
    if (!shooterPreset) { var custom = node('option', 'Custom'); custom.value = ''; preset.appendChild(custom); }
    names.forEach(function (name) {
      var o = node('option', name + (aimBuiltIn(name) ? '' : ' · yours'));
      o.value = name; preset.appendChild(o);
    });
    preset.value = shooterPreset;
    var mine = !!(shooterPreset && !aimBuiltIn(shooterPreset));
    aimConfigControls.rename.disabled = !mine;
    aimConfigControls['delete'].disabled = !mine;
    aimConfigControls.slots.replaceChildren();
    AIM_SLOTS.forEach(function (i) { aimConfigControls.slots.appendChild(aimSlotTile(i)); });
    // One honest note instead of a silent assumption: what the record does not know about this vehicle.
    var lines = [];
    if (!(shooterFit && shooterFit.tags)) lines.push('This record does not carry the vehicle’s tags, so what it '
      + 'may mount is unknown and everything is offered. A battle recorded by a current build knows.');
    ['devices', 'consumables', 'crew'].forEach(function (kind) { if (aimForbidden(kind)) lines.push(aimPolicyLine(kind)); });
    var carried = aimCarried();
    if (carried) lines.push(carried);
    aimConfigControls.fit.textContent = lines.join(' ');
    aimConfigControls.fit.hidden = !lines.length;
    if (aimForbidden('devices')) aimPickerOpen = '';   // a picker left open on the previous shooter goes (S3)
    aimConfigControls.picker.replaceChildren();
    aimConfigControls.picker.hidden = !aimPickerOpen;
    if (aimPickerOpen === 'directive') aimConfigControls.picker.appendChild(aimDirectivePicker());
    else if (aimPickerOpen) aimConfigControls.picker.appendChild(aimPicker(Number(aimPickerOpen.slice(4))));
    aimConfigControls.directive.replaceChildren();
    aimConfigControls.directive.appendChild(aimDirectiveTile());
    aimConfigControls.consumables.replaceChildren();
    aimConfigControls.consumables.appendChild(aimConsumableChips());
    aimConfigControls.crew.replaceChildren();
    aimCrewSection(aimConfigControls.crew);
  }
  function aimNameBox(mode, value) {
    aimNameMode = mode;
    aimConfigControls.namer.hidden = !mode;
    aimConfigControls.warn.hidden = true;
    if (!mode) return;
    aimConfigControls.name.value = value || '';
    aimConfigControls.name.focus(); aimConfigControls.name.select();
  }
  function aimWarn(text) { aimConfigControls.warn.textContent = text; aimConfigControls.warn.hidden = !text; }
  function aimPresetAction(kind) {
    if (kind === 'save') return aimNameBox('save', shooterPreset && !aimBuiltIn(shooterPreset) ? shooterPreset : '');
    if (kind === 'rename') return aimNameBox('rename', shooterPreset);
    if (!shooterPreset || aimBuiltIn(shooterPreset)) return;
    delete aimStore.presets[shooterPreset];
    Object.keys(aimStore.chosen).forEach(function (type) { if (aimStore.chosen[type] === shooterPreset) delete aimStore.chosen[type]; });
    shooterPreset = aimPresetMatch();
    aimNameBox(''); aimConfigChanged(); persistSettings();
  }
  function aimPresetCommit() {
    var name = aimName(aimConfigControls.name.value);
    if (!name) return aimWarn('Give the build a name.');
    if (aimBuiltIn(name)) return aimWarn('That is the name of a built-in preset. Pick another one.');
    if (aimNameMode === 'rename') {
      var from = shooterPreset;
      if (!from || aimBuiltIn(from)) return aimWarn('Only your own presets can be renamed.');
      if (name !== from && aimStore.presets[name]) return aimWarn('You already have a preset with that name.');
      delete aimStore.presets[from];
      Object.keys(aimStore.chosen).forEach(function (type) { if (aimStore.chosen[type] === from) aimStore.chosen[type] = name; });
    } else if (!aimStore.presets[name] && aimUserNames().length >= AIM_PRESET_LIMIT) {
      return aimWarn('That is as many presets as the page keeps. Delete one first.');
    }
    aimStore.presets[name] = aimPresetValues(shooterConfig);
    shooterPreset = name;
    if (shooterType) aimStore.chosen[shooterType] = name;
    aimNameBox(''); aimConfigChanged(); persistSettings();
  }
  // THE CONFIGURATOR TAKES OUT WHAT IT APPLIES ITSELF, AND NOTHING ELSE (S3, 22.09 - the open item "equipment
  // double-counted in the recorded aim block"; corrected by the S3 review the same day). The four miscAttrs
  // factors of a recorded block are not always 1.0 (outputs/vehicle-classes-modes-2026-09-21.md 2.5):
  //   aimFrom 'arena'   a LIVE shooter block (recorder 0.7.14 and later), read from the arena's descriptor: the
  //                     battle's field modifications and, for the player's own shots only, his devices - the
  //                     server strips them from everybody else's descriptor (0 of 1938 enemy blocks carry any).
  //   aimFrom 'compact' a block REBUILT from the compact descriptor (every older record, the target side, a
  //                     browsed vehicle): the devices that descriptor packs, no field modifications.
  // The configuration below applies the user's devices, and applying them on top of recorded ones counted a
  // stabiliser twice - the circle on the move some 23 % too tight. Field modifications are another matter:
  // the configurator has none, so a factor they put in must stay, or an enemy's pair (×1.03 on the circle,
  // ×0.95 on the aiming time, found in 445 enemy blocks) is simply lost. So per factor (aimBaseFactors):
  //   - the vehicle's own lock fixes its devices (aimPolicyFor): the configurator applies none, so what the
  //     record holds is what fought, preset devices included - kept as recorded;
  //   - 'compact': the packed devices alone - 1.0;
  //   - 'arena' with `compactFactors` (the exporter's rebuild of the same compact descriptor, stamp_aim_origin):
  //     live / compact - the packed devices out, the field modifications kept;
  //   - otherwise (the descriptor could not be rebuilt, or data published before aimFrom existed): the
  //     player's own shots cannot be split and start from 1.0; anybody else's hold no devices and stay.
  // The component values - the gun's dispersion and aiming time, the chassis and turret factors, the speeds,
  // the reload, where a mode's battle modifiers act - always stay as recorded. That is the configurator's
  // view alone: the recorded reticle rings come from the shot's own telemetry, and the record itself is
  // never changed. The view inherits everything else from the recorded block, so a field the page reads
  // later still comes through.
  var aimBareFrom = null, aimBareKey = '', aimBare = null;
  var AIM_BARE_FACTORS = ['multFactor', 'additiveFactor', 'aimingTimeFactor', 'reloadTimeFactor'];
  // True when the shooter on screen is the player himself: a recorded hit's own direction says it (the
  // recorder sets 'outgoing' when the attacker is the player's vehicle). A browsed vehicle or a swapped view
  // counts as his too: its block is a rebuild, and his garage vehicle is the one that packs devices.
  function aimShooterIsPlayer(hit) { return !!(hit && (hit.synthetic || hit.direction === 'outgoing')); }
  function aimBaseFactors(a, own, fixed) {
    var packed = a.compactFactors && typeof a.compactFactors === 'object' ? a.compactFactors : null, out = {};
    AIM_BARE_FACTORS.forEach(function (k) {
      var v = Number(a[k]), c = packed ? Number(packed[k]) : NaN;
      if (!(v > 0 && isFinite(v))) out[k] = 1;
      else if (fixed) out[k] = v;
      else if (a.aimFrom === 'compact') out[k] = 1;
      else if (c > 0 && isFinite(c)) out[k] = v / c;
      else out[k] = own ? 1 : v;
    });
    return out;
  }
  function aimBlockData() {
    var a = activeHit && activeHit.attacker && activeHit.attacker.aim;
    if (!(a && a.dispersion > 0)) return null;
    var own = aimShooterIsPlayer(activeHit), fixed = aimForbidden('devices'), key = (own ? 'own' : 'other') + (fixed ? '|fixed' : '');
    if (a !== aimBareFrom || key !== aimBareKey) {
      var base = aimBaseFactors(a, own, fixed);
      aimBareFrom = a; aimBareKey = key; aimBare = Object.create(a);
      AIM_BARE_FACTORS.forEach(function (k) { aimBare[k] = base[k]; });
    }
    return aimBare;
  }
  // What the recorded block carried in those four factors, what the configuration keeps of it and what it
  // leaves out, in words, for the note under the slots - or ''.
  var AIM_CARRIED_WORDS = {multFactor: 'the circle', additiveFactor: 'the movement terms',
    aimingTimeFactor: 'the aiming time', reloadTimeFactor: 'the reload'};
  function aimCarried() {
    var a = activeHit && activeHit.attacker && activeHit.attacker.aim, base = aimBlockData();
    if (!(a && base)) return '';
    var carried = [], kept = [], left = [];
    function part(v, k) { return '×' + aimNum(v) + ' on ' + AIM_CARRIED_WORDS[k]; }
    AIM_BARE_FACTORS.forEach(function (k) {
      var v = Number(a[k]), b = Number(base[k]);
      if (!(v > 0 && isFinite(v)) || Math.abs(v - 1) <= 1e-6) return;
      carried.push(part(v, k));
      if (Math.abs(b - 1) > 1e-6) kept.push(part(b, k));
      if (Math.abs(v / b - 1) > 1e-6) left.push(part(v / b, k));
    });
    if (!carried.length) return '';
    var from = a.aimFrom === 'arena' ? 'read live in the battle' : a.aimFrom === 'compact' ? 'rebuilt from the vehicle’s descriptor' : 'as recorded';
    var fieldMods = kept.length ? 'Kept: ' + kept.join(', ') + ' - the vehicle’s field modifications, which the configuration does not set. ' : '';
    var devices = left.length ? 'Left out: ' + left.join(', ') + ' - equipment packed in the vehicle’s descriptor, which is set here instead, so it does not count twice.' : '';
    var why;
    if (aimForbidden('devices')) why = 'The game fixes this vehicle’s equipment, so all of it stays in.';
    else if (a.aimFrom === 'compact' || (a.compactFactors && typeof a.compactFactors === 'object')) why = fieldMods + devices;
    else if (aimShooterIsPlayer(activeHit)) why = 'Your field modifications and your equipment cannot be told apart in it, so the '
      + 'configuration leaves both out and applies only what is set here.';
    else why = fieldMods + 'Another player’s equipment never reaches the record.';
    return 'The record’s own aim block carries ' + carried.join(', ') + ' - ' + from + '. ' + why.replace(/\s+$/, '');
  }
  // The small mark inside the Config button (S3): '?' when the rules of this battle's mode are not known -
  // the configuration then works as in a standard battle - and '⊘' when the vehicle's own lock keeps a kind
  // of equipment out. Nothing for a confirmed standard battle. Its own tooltip says which and why.
  function paintAimModeMark() {
    var mark = $('aim-mode-mark');
    if (!mark) return;
    var locked = [], unknown = '';
    ['devices', 'consumables', 'crew'].forEach(function (kind) {
      var rule = shooterPolicy[kind];
      if (rule.state === 'forbidden') locked.push(aimPolicyLine(kind));
      else if (rule.state === 'unknown' && !unknown) unknown = rule.source;
    });
    var kind = locked.length ? 'forbidden' : unknown ? 'unknown' : '';
    mark.hidden = !kind;
    mark.setAttribute('data-kind', kind || 'none');
    mark.textContent = kind === 'forbidden' ? '⊘' : kind ? '?' : '';
    mark.setAttribute('aria-label', kind === 'forbidden' ? 'Some equipment is fixed by the game for this vehicle'
      : kind ? 'The rules of this battle’s mode are not known' : '');
    mark.title = !kind ? '' : locked.concat(unknown ? ['The rules of this battle are not known: ' + unknown
      + '. The configuration works as in a standard battle, which may be more than the game allowed here.'] : []).join(' ');
  }
  // --- Driving the shooter ----------------------------------------------------------------------
  // With the emulation on, W A S D move the vehicle, the turret chases the cursor at its own rotation
  // speed and a click is a shot. A frame loop runs only while something is actually changing - a key
  // held, the vehicle still rolling, the circle still settling, the turret still catching up, a
  // reload running - and stops itself as soon as everything is at rest. It never touches the GPU
  // composition: only the circle's line and the figures on the two info panels are redrawn.
  var aimOn = false, aimKeys = {}, aimFrame = 0, aimClock = 0, aimMove = null, aimNow = null;
  var aimReload = null, aimClip = 0, aimClipSize = 1, aimShot = null, aimLastState = null;
  // The virtual hull heading, in radians, kept for this session only (user, 20.09): A and D turn it,
  // the gun goes with it and the turret chases back to the crosshair. Reset whenever the run is reset.
  var aimHeading = 0;
  // The live figure of the aiming ring (user, 20.09: 'see the percentage in the circle all the time'). A
  // full integral is 1024 rays - tens of milliseconds - so while anything moves it is a coarse 256-ray one
  // at most every 120 ms, and the fine one runs once when the shooter, the turret and the cursor rest.
  var aimEst = null, aimEstAt = 0, aimEstFine = false;
  // The figure of the STANDING ring of the hit on screen - the recorded reticle, or the nominal estimate
  // when the hit has no reticle of its own (user, 20.09). Computed in shotStats(), where the saved circle
  // is sampled anyway for the reticle tile, and printed on the hit-line panel whenever that ring is the
  // one on the model: an emulated shot replaces the ring and the line together.
  var aimRecorded = null;
  // The pointer: aimDown says the button is down on a shot (not on a drag), aimBurst that the press has
  // grown into a held burst, aimClipDry that the clip ran out and nothing more fires until the release.
  var aimDown = false, aimBurst = false, aimHoldTimer = 0, aimClipDry = false;
  var aimLive = false, aimCursor = '';
  // aimCentred: the Config popover is open and the viewer holds the aim on the middle of the model.
  var aimCentred = false;
  // A press longer than this is a burst, a shorter one a single shot (user, 20.09). Milliseconds of wall
  // clock through window.setTimeout, not a count of frames, so a slow scene does not lengthen the tap.
  var AIM_HOLD_MS = 250;
  var AIM_KEYS = {KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right'};
  // The game's CEF and a non-Latin keyboard layout both have to work, so the physical key is preferred
  // and the typed character is the fallback for a browser without KeyboardEvent.code.
  function aimKeyName(e) {
    if (e.code && AIM_KEYS[e.code]) return AIM_KEYS[e.code];
    var k = String(e.key || '').toLowerCase();
    return k === 'w' ? 'forward' : k === 's' ? 'back' : k === 'a' ? 'left' : k === 'd' ? 'right' : '';
  }
  function aimHeld() { return !!(aimKeys.forward || aimKeys.back || aimKeys.left || aimKeys.right); }
  function aimSeconds() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
  function aimReloadLeft() { return aimReload ? Math.max(0, aimReload.until - aimSeconds()) : 0; }
  // How much of the running reload (or clip interval) is behind us, 0..1 - and that is how much of the
  // aiming ring is drawn (user, 20.09). null means the gun is loaded, so the ring is whole; a reload that
  // has run out is null too, even before the frame loop drops it.
  function aimReloadPart() {
    if (!aimReload || !(aimReload.until > aimReload.at)) return null;
    var part = (aimSeconds() - aimReload.at) / (aimReload.until - aimReload.at);
    return part >= 1 ? null : part > 0 ? part : 0;
  }
  function aimClipRounds() {
    var rl = ArmorBallistics.reloadSeconds(aimBlockData(), aimModifiers());
    return rl && rl.shots > 1 && rl.interval > 0 ? rl.shots : 1;
  }
  function startAimLoop() {
    if (aimFrame || !aimOn) return;
    aimFrame = window.requestAnimationFrame(aimTick);
  }
  function stopAimLoop() { if (aimFrame) window.cancelAnimationFrame(aimFrame); aimFrame = 0; aimClock = 0; }
  // `hullMax` rides along for the turn indicator only: it is the hull's top rotation speed with this
  // build, which is what the arc's length is measured against. The ballistics read speed/hullTurn/turretTurn.
  function aimState() {
    return {speed: aimMove ? aimMove.speed : 0, hullTurn: aimMove ? aimMove.hullTurn : 0,
            hullMax: aimMove ? aimMove.hullMax : 0, turretTurn: 0};
  }
  function aimTick() {
    aimFrame = 0;
    var a = aimBlockData();
    if (!aimLive || !a || !viewer || !viewer.liveRadius100) { aimClock = 0; return; }
    // A DRAG PAUSES THE EMULATION (user, 20.09). While the user turns the model, the turret or the gun,
    // no time passes for the shooter: no key is acted on, the turret does not chase and the circle is
    // left alone. The keys themselves are still tracked, or a key released during the drag would stay
    // down for ever; dropping the clock makes the first frame after the drag a zero-length one, so
    // everything resumes from exactly the state it was paused in.
    // A pointer held for a burst keeps the viewer's `dragging` flag up although nothing is being dragged,
    // so the hold is excluded here or the shooter would freeze for the whole burst.
    if (viewer.dragging && !viewer.aimHold) { aimClock = 0; startAimLoop(); return; }
    var now = aimSeconds(), dt = aimClock ? now - aimClock : 0; aimClock = now;
    // The first frame after the loop slept (settled and caught) has no time span: chasing the cursor over a
    // zero-length step would ask the turret for its full speed and bloom the ring as if it had fired (user,
    // 20.09: 'a shot without a shot, exactly when it had settled and I moved the mouse'). Count that frame
    // as one nominal frame instead.
    if (!dt) dt = 1 / 60;   // one nominal frame, never a zero step
    var mods = aimModifiers();
    aimMove = ArmorBallistics.moveStep(aimMove, aimKeys, a, mods, dt);
    // The hull turns first and TAKES THE GUN WITH IT (user, 20.09): the aim point swings around the
    // shooter by hullTurn·dt, opening a gap to the crosshair, and the turret below spends what the hull
    // left it on closing that gap again. So holding A with the cursor still drags the ring sideways and
    // the turret pulls it back.
    var swung = false;
    if (aimMove.hullTurn) {
      aimHeading += aimMove.hullTurn * dt;
      swung = !!(viewer.turnAim && viewer.turnAim(aimMove.hullTurn * dt));
    }
    var chase = ArmorBallistics.turretChase(viewer.aimGap(), aimMove.hullTurn, a, mods, dt, swung);
    // `turned`: the gun really moved in this frame (chaseAim says so for anything above a micro-radian).
    var turned = chase.step > 0 && !!viewer.chaseAim(chase.step);
    var state = {speed: aimMove.speed, hullTurn: aimMove.hullTurn, hullMax: aimMove.hullMax, turretTurn: chase.turretTurn};
    aimNow = ArmorBallistics.aimStep(aimNow, state, a, mods, dt);
    // The next shot of a held burst, the moment the cooldown is over. The recoil of the shot just fired is
    // already in `aimNow`, so a gun that cannot settle between two rounds fires the second one wider -
    // which is the whole point of the feature for autoloaders.
    if (aimBurst && aimDown && !aimClipDry && aimReloadLeft() <= 0) fireShot();
    paintAim(state);
    var reloading = aimReloadLeft() > 0;
    // A frame in which the turret caught the cursor is not a resting frame, although it reads as one: the
    // turret's speed of this frame rose the ring INSTANTLY to that state's ideal, and aimStep calls a
    // factor sitting on its ideal `settled`. Sleeping here left the ring bloomed and its figure stale
    // until the next mouse move (optimisation plan 21.09, §8.3). So the loop runs on for as long as the
    // gun moves; the next frame has no turret speed, the ring decays from the bloom, and the fine figure
    // is taken once, when it is really at rest - the coarse one keeps its 120 ms pace meanwhile.
    if (aimHeld() || !aimMove.resting || reloading || !chase.caught || turned || (aimBurst && aimDown && !aimClipDry) || (aimNow && !aimNow.settled)) startAimLoop();
    else { aimClock = 0; if (reloadJustFinished()) paintAim(state); if (!aimEstFine) { estimateLive(true); paintCircleLines(); } }
  }
  // The reload is over: drop it so the ring is drawn whole again.
  function reloadJustFinished() {
    if (!aimReload || aimReloadLeft() > 0) return false;
    aimReload = null; return true;
  }
  // The circle, the speed tile and the panel figures for one state. No ray is cast here - the only integral this mode
  // runs is the one a shot asks for.
  function paintAim(state) {
    var a = aimBlockData();
    if (!a || !viewer || !aimNow) return;
    aimLastState = state;
    // The reload first: it decides how much of the ring the redraw below draws.
    if (viewer.setAimReload) viewer.setAimReload(aimReloadPart());
    viewer.setLiveAim(aimNow.radius100);   // the live ring never stops aiming (user, 20.09)
    paintDrive(state);
    paintGunLoad();   // the countdown of a held burst, per frame
    estimateLive(false);
    paintCircleLines();
  }
  // What one shot inside the LIVE ring is worth: ONE figure (user, 20.09), the expected damage over the
  // circle as a share of the shell's alpha, misses counted as 0. `alpha` says whether the shell has one
  // at all - without it the share means nothing and the line prints a dash instead of a false zero.
  function estimateLive(fine) {
    var shell = viewer && viewer.shell, now = aimSeconds();
    if (!shell || !viewer.liveRadius100) { aimEst = null; return; }
    if (!fine && aimEstAt && now - aimEstAt < 0.12) return;
    var r = viewer.liveAimProbability(shell, fine ? 1024 : 256);
    aimEst = r ? {damage: damagePct(r.damage), alpha: shell.alpha > 0} : null;
    aimEstAt = now; aimEstFine = !!fine;
  }
  function circleText(figure) { return 'Circle ' + (figure && figure.alpha ? figure.damage + ' %' : '—'); }
  var SHARE = ', as a share of the shell’s alpha';
  var CIRCLE_TITLES = {
    live: 'Expected damage of a shot inside the live aiming circle' + SHARE,
    shot: 'Expected damage of the shot inside the magenta ring it left on the model' + SHARE,
    // The recorded reticle: the circle the shooter's own client had at the instant of the shot, slid
    // along the shot line onto the impact point - the ring drawn solid magenta on the model.
    saved: 'Expected damage of a shot inside the recorded aiming circle of this hit — the shooter’s client reticle, slid along the shot line to the impact point' + SHARE,
    // No recorded reticle: the dashed magenta ring is the nominal full-aim estimate, and the figure is
    // an estimate with it. Said on the line itself, so the number is never read as a recorded one.
    estimate: 'This hit has no recorded reticle: the figure is for the nominal full-aim circle drawn on the hit line (gun accuracy × range, no crew or equipment). Expected damage of a shot inside it' + SHARE
  };
  // One line per ring, in the colour of the ring it belongs to (user, 20.09): the live cyan one into the
  // "Under the cursor" panel, the STANDING magenta ring into the hit-line panel above it. That ring is
  // the recorded reticle of the hit (or its nominal estimate) until the user fires, and the ring of his
  // own last shot afterwards - which is exactly what has replaced it on the model. No figure twice.
  function circleLine(id, figure, kind) {
    var e = $(id);
    if (!e) return;
    var text = figure ? circleText(figure) : '';
    e.textContent = text;
    e.hidden = !text;
    e.title = text ? CIRCLE_TITLES[kind] || CIRCLE_TITLES.live : '';
  }
  function paintCircleLines() {
    circleLine('probe-circle', aimLive ? aimEst : null, 'live');
    var fired = aimLive && aimShot;
    circleLine('shot-circle', fired ? aimShot : aimRecorded, fired ? 'shot' : aimRecorded ? aimRecorded.kind : 'saved');
  }
  // The small tile at the left end of the shooter row: how fast the shooter is going right now, signed -
  // forward positive, reverse negative - the arc of the hull turn, and the W A S D glyph, which lights
  // the caps that are actually held so the keys read as live.
  function paintDrive(state) {
    var e = $('aim-speed');
    if (!e) return;
    var ms = state && Number.isFinite(state.speed) ? state.speed : 0;
    e.textContent = Math.round(ms / KMH_TO_MS) + ' km/h';
    ['forward', 'left', 'back', 'right'].forEach(function (name) {
      var cap = $('aim-key-' + name);
      if (!cap) return;
      if (aimKeys[name]) cap.setAttribute('data-down', '1'); else cap.removeAttribute('data-down');
    });
    paintTurn(state);
  }
  // The hull turn as a compact arc with an arrowhead (user, 20.09): clockwise for D, counter-clockwise
  // for A, and the longer the arc the faster the hull is coming round - nothing at all when it stands,
  // up to 270° at the hull's top rotation speed. SVG y points down, so a growing angle runs clockwise on
  // screen and the sweep flag is 1 for the D direction.
  var TURN_R = 8, TURN_C = 12, TURN_MAX = 270;
  function turnPoint(deg, radius) {
    var a = deg * Math.PI / 180;
    return [TURN_C + radius * Math.cos(a), TURN_C + radius * Math.sin(a)];
  }
  function paintTurn(state) {
    var box = $('aim-turn'), arc = $('aim-turn-arc'), head = $('aim-turn-head');
    if (!box || !arc || !head) return;
    var rate = state && Number.isFinite(state.hullTurn) ? state.hullTurn : 0;
    var max = state && state.hullMax > 0 ? state.hullMax : 0;
    var span = max > 0 ? Math.min(1, Math.abs(rate) / max) * TURN_MAX : 0;
    if (!(span > 1)) { box.hidden = true; arc.setAttribute('d', ''); head.setAttribute('d', ''); return; }
    var sign = rate > 0 ? 1 : -1, a0 = -90, a1 = a0 + sign * span;
    var p0 = turnPoint(a0, TURN_R), p1 = turnPoint(a1, TURN_R), r = a1 * Math.PI / 180;
    // The arrowhead sits at the far end, pointing the way the hull is coming round: `t` is the tangent
    // there, `n` the radius, and the head is a triangle two units to either side of the line.
    var tx = -Math.sin(r) * sign, ty = Math.cos(r) * sign, nx = Math.cos(r), ny = Math.sin(r);
    var tip = [p1[0] + tx * 3.6, p1[1] + ty * 3.6];
    var b1 = [p1[0] - tx * 1.2 + nx * 2.4, p1[1] - ty * 1.2 + ny * 2.4];
    var b2 = [p1[0] - tx * 1.2 - nx * 2.4, p1[1] - ty * 1.2 - ny * 2.4];
    var fix = function (v) { return v.toFixed(2); };
    arc.setAttribute('d', 'M' + fix(p0[0]) + ' ' + fix(p0[1]) + 'A' + TURN_R + ' ' + TURN_R + ' 0 ' +
      (span > 180 ? 1 : 0) + ' ' + (sign > 0 ? 1 : 0) + ' ' + fix(p1[0]) + ' ' + fix(p1[1]));
    head.setAttribute('d', 'M' + fix(tip[0]) + ' ' + fix(tip[1]) + 'L' + fix(b1[0]) + ' ' + fix(b1[1]) +
      'L' + fix(b2[0]) + ' ' + fix(b2[1]) + 'Z');
    box.hidden = false;
  }
  // --- The gun panel beside the Shooter tile (user, 20.09) ---------------------------------------
  // The shooter's own shells as the client's own icons, and the gun's load state the way the in-game
  // reticle shows it. The shells are the very list the heading's shell chips are built from, and an
  // icon click goes through the SAME selectShell() a chip does, so the two are never out of step: the
  // pressed state of both is set in updateShell(), which marks every [data-shell] control on the page.
  // The icon files ship with the page (web/icons); a missing one falls back to a short text badge.
  // The client names the icon after the shell type, and modern HE has one of its own; the record
  // carries no gold/premium flag, so a premium shell shows the base icon of its kind.
  function shellIconName(c) {
    if (!c || !c.kind) return '';
    return c.kind === 'HIGH_EXPLOSIVE' && c.mechanics === 'MODERN' ? 'HIGH_EXPLOSIVE_MODERN' : c.kind;
  }
  function shellIconTitle(c) {
    var out = [c.name, shellNames[c.kind] || c.kind, Math.round(c.penetration100) + ' mm'];
    if (c.alpha > 0) out.push(Math.round(c.alpha) + ' HP');
    if (c.gunInstallation > 0) out.push('ability gun' + (c.gun ? ' ' + c.gun : ''));
    return out.join(' · ');
  }
  function paintGunShells() {
    var box = $('aim-gun-shells');
    if (!box) return;
    box.replaceChildren();
    candidates.forEach(function (c, i) {
      var b = node('button', undefined, 'aim-shell');
      b.type = 'button';
      b.dataset.shell = 'saved:' + i;
      b.setAttribute('aria-pressed', String($('shell-choice').value === 'saved:' + i));
      b.title = shellIconTitle(c);
      b.appendChild(aimIcon(shellIconName(c), shellNames[c.kind] || c.kind));
      // The ability-gun mark of the heading list, so one glance matches the other.
      if (c.gunInstallation > 0) b.appendChild(node('span', '✦', 'aim-shell-mark'));
      b.onclick = function () { $('shell-choice').value = 'saved:' + i; selectShell(); };
      box.appendChild(b);
    });
    box.hidden = !candidates.length;
  }
  // The load state, small and iconic, no prose: while a burst is held the countdown to the next round
  // (and the rounds left of a clip), otherwise the gun's own reload time and clip size. A record with
  // no reload at all says so with a dash - the cooldown is unknown, and the emulation fires once.
  function paintGunLoad() {
    var time = $('aim-gun-reload'), clip = $('aim-gun-clip');
    if (!time || !clip) return;
    var rl = ArmorBallistics.reloadSeconds(aimBlockData(), aimModifiers());
    if (!rl) { time.textContent = '—'; clip.textContent = ''; clip.hidden = true; return; }
    var left = aimReloadLeft(), running = left > 0;
    time.textContent = (running ? left : rl.reload).toFixed(1) + ' s';
    time.setAttribute('data-running', running ? '1' : '0');
    var rounds = running && aimClipSize > 1 ? aimClip + '/' + aimClipSize : rl.shots > 1 ? String(rl.shots) : '';
    clip.textContent = rounds;
    clip.hidden = !rounds;
  }
  // One shot (user's decision, 19.09: no Alt - it may never reach the page inside the game). The tracer
  // goes exactly down the middle of the LIVE circle, where the gun points: the random offset a real shot
  // gets is the server's, and this page shows the odds, not a rolled die. What the circle was worth at
  // that instant is integrated there and then with 1024 rays and stands on the pinned-shot panel, and a
  // copy of the circle stays on the model beside the tracer until the next shot replaces it (user, 20.09).
  // The live circle itself is never frozen: it goes on aiming through the shot and past it.
  // Whether the gun MAY fire is decided by the caller, not here.
  function fireShot() {
    var a = aimBlockData();
    if (!aimLive || !a || !viewer || !viewer.liveRadius100) return false;
    var centre = viewer.spreadAim || viewer.liveAimPoint;
    if (!centre) return false;
    var mods = aimModifiers(), shell = viewer.shell;
    var chance = shell ? viewer.liveAimProbability(shell, 1024) : null;
    viewer.pinAtPoint(centre);
    if (viewer.setAimShot) viewer.setAimShot();   // the ring left behind, drawn before the recoil widens the live one
    // The shot's own figure, on the pinned-shot panel and in the colour of its ring (user, 20.09): the
    // same single number the live ring prints - the expected damage over the circle, share of alpha.
    aimShot = chance ? {damage: damagePct(chance.damage), alpha: !!(shell && shell.alpha > 0)} : null;
    // The recoil enters the factor for this very instant and the exponential restarts from it, so the
    // next round of a held burst leaves a wider circle unless the gun had time to settle.
    var state = aimLastState || aimState();
    aimNow = ArmorBallistics.aimShot(aimNow, state, a, mods);
    // The cooldown to the next round of the same hold. OVERHEATING GUNS (ARES and the like) are out of
    // scope: their heat/cooling rule is not in the record and not modelled here.
    var rl = ArmorBallistics.reloadSeconds(a, mods), now = aimSeconds();
    aimClipDry = false;
    // No reload in the record: the cooldown is unknown, so a hold fires once and waits for the release
    // instead of emptying a magazine at the frame rate.
    if (!rl) { aimReload = null; aimClipDry = true; }
    else if (aimClipSize > 1) {
      aimClip = Math.max(0, aimClip - 1);
      // An empty clip simply stops the burst: the clip reload is NOT emulated (user, 20.09 - it would
      // only annoy), letting go and pressing again starts from a full clip.
      if (aimClip > 0) aimReload = {at: now, until: now + rl.interval, clip: true};
      else { aimClipDry = true; aimReload = null; }
    } else aimReload = {at: now, until: now + rl.reload, clip: false};
    return true;
  }
  // --- The pointer: a tap is one shot, a hold is a burst on the gun's own cooldown (user, 20.09) ------
  // pointerdown only arms the press - it may still become an orbit or turret drag, and a drag never
  // shoots. Claiming the press here is what tells the viewer this is not a drag.
  function beginShot() {
    if (!aimLive || !aimBlockData() || !viewer || !viewer.liveRadius100) return false;
    // With the Config popover open the aim is parked on the model centre, not under the cursor, so a
    // press in the scene fires nothing: it only closes the popover (the document click handler). It is
    // still claimed, or the viewer would pin a point on its release; a drag still orbits (cancelShot).
    if (aimCentred) return true;
    cancelHoldTimer();
    aimDown = true; aimBurst = false; aimClipDry = false;
    // A fresh press is never blocked by a running reload and starts with a full clip: the reload paces
    // the shots INSIDE one hold and nothing else.
    aimClipSize = aimClipRounds(); aimClip = aimClipSize;
    aimHoldTimer = window.setTimeout(holdFire, AIM_HOLD_MS);
    return true;
  }
  // Held long enough without moving: the burst starts with its first shot at this instant.
  function holdFire() {
    aimHoldTimer = 0;
    if (!aimDown) return;
    aimBurst = true;
    if (fireShot()) paintAim(aimLastState || aimState());
    startAimLoop();
  }
  // Let go. A short press fires its single shot here; a burst has been firing all along and just stops,
  // leaving the ring and the figures of the LAST shot on screen.
  function endShot() {
    cancelHoldTimer();
    if (!aimDown) return;
    var single = !aimBurst;
    aimDown = false; aimBurst = false; aimClipDry = false;
    if (single && fireShot()) paintAim(aimLastState || aimState());
    else paintCircleLines();
    // The reload is shown only while the button is held and the gun fires on its cooldown; a released
    // button leaves a whole ring - the recoil bloom stays, the fill does not (user, 20.09).
    aimReload = null;
    paintAim(aimLastState || aimState());
    startAimLoop();
  }
  // The pointer moved past the drag threshold. Before the first round that is an orbit, turret or gun
  // drag: no shot at all, and the emulation pauses as it did before. Once the burst is firing nothing
  // stops it but the release (user, 20.09) - the mouse then aims it, exactly as it does in the game -
  // so this refuses with false and the viewer keeps the press instead of handing it to the drag.
  function cancelShot() {
    if (aimDown && aimBurst) return false;
    cancelHoldTimer(); aimDown = false; aimBurst = false; aimClipDry = false; paintCircleLines();
    return true;
  }
  function cancelHoldTimer() { if (aimHoldTimer) window.clearTimeout(aimHoldTimer); aimHoldTimer = 0; }
  // Everything the emulation holds, back to a standing, loaded, fully aimed shooter.
  function resetAimRun() {
    cancelHoldTimer();
    aimKeys = {}; aimMove = null; aimNow = null; aimReload = null;
    aimDown = false; aimBurst = false; aimClipDry = false;
    aimShot = null; aimLastState = null; aimHeading = 0;
    if (viewer) { viewer.aimHold = false; if (viewer.clearAimShot) viewer.clearAimShot(); }
    aimClipSize = aimClipRounds(); aimClip = aimClipSize;
  }
  // The switch itself. Off means off: no frame loop, no key handlers, no live circle, no crosshair, and
  // everything recorded is back on the model.
  // The keys are listened for on the DOCUMENT while the mode is on (user, 20.09): W A S D have to drive
  // from the moment the switch goes on, and the viewport only gets them once it has been clicked. They
  // are dropped again the moment the mode goes off, so nothing of this mode listens while it is off.
  function setAimEmulation(on) {
    on = !!on;
    if (on === aimOn) { updateAim(); return; }
    aimOn = on;
    if (on) { document.addEventListener('keydown', aimKeyDown); document.addEventListener('keyup', aimKeyUp); window.addEventListener('blur', aimRelease); }
    else { document.removeEventListener('keydown', aimKeyDown); document.removeEventListener('keyup', aimKeyUp); window.removeEventListener('blur', aimRelease); stopAimLoop(); }
    resetAimRun();
    updateAim();
  }
  // Typed text is text, never driving: a key going into a field, a list box or anything editable is
  // left to that control. Everything else on the page is fair game while the mode is on.
  function aimTyping(e) {
    var t = e && e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = String(t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
  // W A S D only. Every other key - the arrows that orbit, +/- that zoom - is left to the viewer's own
  // handler, so the emulation adds keys instead of taking any away.
  function aimKeyDown(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || aimTyping(e)) return;
    var name = aimKeyName(e);
    if (!name || !aimLive || !aimBlockData()) return;
    e.preventDefault();
    if (aimKeys[name]) return;
    aimKeys[name] = true; startAimLoop();
  }
  // No typing guard here - it belongs to the keydown. A key let go while the focus has moved into a field
  // must still be released, or the hull turns for ever and the loop never stops (inspection, 20.09). A key
  // that was never recorded (because its keydown WAS typing) falls out on the next line, so typing is safe.
  function aimKeyUp(e) {
    var name = aimKeyName(e);
    if (!name || !aimKeys[name]) return;
    e.preventDefault();
    delete aimKeys[name]; startAimLoop();
  }
  // A window that lost the focus never sends the keyup, and the vehicle would drive on for ever.
  function aimRelease() { if (!aimHeld()) return; aimKeys = {}; startAimLoop(); }
  // The pointer over the scene while the mode is on: a game-like crosshair, the shape chosen in
  // Settings. Both are data-URI SVGs in the stylesheet with the hotspot in the middle, and `crosshair`
  // is the fallback for a browser that refuses the image.
  function aimCursorClass() {
    var box = $('viewport'), want = aimLive ? ($('crosshair-style').value === 'dot' ? 'aim-dot' : 'aim-cross') : '';
    if (want === aimCursor) return;
    if (aimCursor) box.classList.remove(aimCursor);
    if (want) box.classList.add(want);
    aimCursor = want;
  }
  // THE CIRCLE GOES TO THE TANK WHILE THE MENU IS OPEN (user, 21.09). With the Config popover open the
  // mouse is on the menu, so the live circle and the crosshair would sit behind it and nobody could see
  // what a tile does to the circle. While it is open the viewer holds the aim on the middle of the model
  // and draws a crosshair there in the Settings shape (viewer.setAimCentre); every configuration change
  // repaints the circle at once (aimConfigChanged), so its size moves while the tiles are clicked. The
  // figures on the info panels follow the circle as always, the keys go on driving, and closing the
  // popover hands the aim back to the cursor. Run on the popover's own toggle, on every pass of
  // updateAim and when the crosshair shape changes.
  function aimCrosshairShape() { return $('crosshair-style').value === 'dot' ? 'dot' : 'cross'; }
  function aimSyncCentre() {
    var want = !!(aimLive && viewer && viewer.setAimCentre && $('aim-config').open);
    if (!want && !aimCentred) return;
    var moved = want !== aimCentred;
    aimCentred = want;
    viewer.setAimCentre(want, aimCrosshairShape());
    if (!moved || !aimLive) return;
    aimRingMoved();
  }
  // The circle stands somewhere else now: its figure is taken again at once, and finely once at rest. Run
  // when the hold starts or ends.
  function aimRingMoved() {
    aimEstAt = 0; aimEstFine = false;
    paintAim(aimLastState || aimState());
    startAimLoop();
  }
  // One pass over everything the mode owns: what is on screen, the circle in the scene and the figures
  // on the two info panels. Cheap - no ray is cast here.
  function updateAim() {
    var tile = $('aim-drive'); if (!tile) return;
    var a = aimBlockData(), mode = $('armor-mode').value, modelled = mode !== 'parts' && !$('model-tile').hidden;
    var live = !!(a && modelled && viewer && aimOn);
    // What the layout pass measures here is which of the four is on screen; it runs again only when that
    // changes (updateAim runs on every shell, distance or pose step, and each pass forces a page layout).
    var shownBefore = [$('aim-config').hidden, tile.hidden, $('aim-gun').hidden, $('aim-block').hidden].join();
    $('aim-config').hidden = !live;
    if (!live) { $('aim-config').open = false; aimPickerOpen = ''; }
    tile.hidden = !live;
    // The gun panel rides with the mode, exactly as the speed tile and Config do: its reload figures are
    // the emulation's own state, and the heading shell list carries the shells when the mode is off.
    $('aim-gun').hidden = !live;
    paintGunLoad();
    // The manual estimate of 0.7.13 is the fallback and nothing more: it appears exactly when the user
    // asked for the emulation and this record cannot give it.
    var fallback = !!(modelled && aimOn && !a), wasHidden = $('aim-block').hidden;
    $('aim-block').hidden = !fallback;
    if ([$('aim-config').hidden, tile.hidden, $('aim-gun').hidden, $('aim-block').hidden].join() !== shownBefore) scheduleLayout();
    // Said once, when the block appears: writing it on every pass would wipe the result of the
    // Estimate button the moment the camera moved.
    if (fallback && wasHidden) $('spread-result').textContent = 'This shooter’s record carries no aiming parameters, so the circle cannot be computed. Old battles get them on the next game start; until then the manual radius above stands.';
    if (live !== aimLive) {
      aimLive = live;
      if (viewer) viewer.setAimEmulation(live);
    }
    aimCursorClass();
    aimSyncCentre();   // a mode going off closed the popover above, and the hold goes with it
    if (!live) {
      if (viewer) viewer.clearLiveAim();
      stopAimLoop();
      paintCircleLines();   // the live line goes with the mode; the hit-line panel returns to the recorded ring
      paintDrive(aimState());   // a tile put away with a key still lit or the turn arc drawn would come back wrong
      return;
    }
    if (!aimNow) {
      aimClipSize = aimClipRounds(); aimClip = aimClipSize;
      aimNow = ArmorBallistics.aimStep(null, aimState(), a, aimModifiers(), 0);
    }
    if (!aimNow) { viewer.clearLiveAim(); return; }
    paintAim(aimState());
  }
  function shellAt(c,choice,penetration,caliber,distance,hit){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    shell.liner=targetFactor(hit);
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration',
      'alpha','spallDamage','spallAbsorption','mechanics','nonPiercingArmorDamage'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});var fraction=Math.max(0,Math.min(1,(distance-100)/400));if(c.penetration500>0&&c.penetration100>0)shell.penetration=penetration*(1+fraction*(c.penetration500/c.penetration100-1));}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null,totalEstimate=null,verdictKey=null,partNames=['chassis','hull','turret','gun'];
  // Verdict log (user, 14.09): one console line per recorded contact point - the server's result as a fact next to our
  // estimate along the drawn line. The game writes the page's console into game.log; tools/verdicts_from_log.py
  // tabulates the lines. Once per hit and shell, never on camera moves.
  var verdictLines=0,verdictQueue=[],verdictDone={},verdictTimer=null,verdictBusy=false;
  function verdictLine(battleId,hit,v,shell,mode){var r=v.result||{},chance=r.chance;
    var ours=r.reason==='ricochet'?'ricochet':chance===null||chance===undefined?(r.reason||'none'):(chance>=50?'pen':'no-pen')+'_'+chance+'%';
    console.info('Bullba Hits verdict: battle='+battleId+' hit='+hit.id+' point='+v.index+' part='+(partNames[v.part]||v.part)+' server='+String(effects[v.effect]||v.effect).replace(/ /g,'_')+' ours='+ours+' angle='+(r.angle!=null?Math.round(r.angle):'-')+' eff='+(r.effective!=null?Math.round(r.effective):'-')+' pen='+Math.round(shell.penetration)+' shell='+shell.kind+' dir='+v.source+' chordDev='+(v.chordDev==null?'-':(v.chordDev*180/Math.PI).toFixed(1))+' mode='+mode+damageColumns(hit,r,shell)+ArmorCrits.columns(hit,v)+' v='+($('app-version').getAttribute('data-version')||'dev').replace(/\s+/g,'_')+' rec='+(recordsVersion||'-'));
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
  // shell, its models from the cache, a throwaway flat ballistics engine, one hit every 150 ms so the page stays responsive.
  // Nothing is displayed and nothing is sent anywhere - the lines go to the console, in the game to game.log.
  function queueVerdicts(battle){
    (battle.hits||[]).forEach(function(h){var key=battle.id+'/'+h.id+'/'+ArmorCrits.key(h);if(verdictDone[key]||!(h.points||[]).some(function(p){return p.status==='resolved';}))return;verdictDone[key]=true;verdictQueue.push({battle:battle,hit:h});});
    // The hits on one set of target models go one after another (stable: the groups in the order they first
    // appear, the hits of a group in queue order). local-data.js keeps the last sixteen models, and a queue in
    // hit order read the same model files again and again as the targets alternated. Written out here and not
    // as a helper: tools/verdicts_offline.cjs cuts this function out of the page as it stands.
    var groups=Object.create(null),count=0;
    verdictQueue=verdictQueue.map(function(job,i){var models=((job.hit.target||{}).parts||[]).map(function(p){return p.modelKey||'';}).join(',');
      if(groups[models]===undefined)groups[models]=count++;return [groups[models],i,job];})
      .sort(function(a,b){return a[0]-b[0]||a[1]-b[1];}).map(function(t){return t[2];});
    verdictStatus();if(!verdictTimer)verdictTimer=setTimeout(drainVerdicts,150);
  }
  function drainVerdicts(){
    verdictTimer=null;if(verdictBusy||!verdictQueue.length||!window.ArmorViewer||!window.ArmorBallistics)return;
    // The diagnostics wait while the user is working: a hidden page or a drag gets the frame, not a BVH build.
    if(document.hidden||(viewer&&viewer.dragging)){verdictTimer=setTimeout(drainVerdicts,150);return;}
    verdictBusy=true;
    var job=verdictQueue.shift(),battle=job.battle,hit=job.hit;
    ArmorInspectorData.sceneFor(battle,hit).then(function(data){
      if(data.geometryIncomplete)return;
      var context=ArmorShotContext.resolve(hit,battle.shotEvents||[]),c=context.index>=0?context.choices[context.index]:context.choices[0]||null;
      var range=context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:100,shell=c?shellAt(c,c.kind,c.penetration100,c.caliber,range,hit):null;
      // A flat engine (one leaf, no kd-tree): the tree would cost far more to build than the one to three rays
      // cast through it here save, and the verdicts are the same.
      if(!shell)return;var engine=ArmorBallistics.build(data,false,true),pts=ArmorViewer.points(hit);
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
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null,range);fillPanel('shot',line,shell&&shell.alpha);
    logVerdicts(shell);
    // The tile's own tooltip says what its number is before it says where the line comes from.
    $('shot-panel').title=damageView?'Expected damage per shot along the saved hit line, as a share of the shell’s alpha: the penetration chance times alpha, plus the reconstructed non-penetration damage for the rest, divided by alpha.\n\nThe record holds what the shot did; this is the expectation it had, not the rolled RNG.':shotPanelTitle;
    aimTitle();
    output.title=!r?'No parameters or the pose changed':pinned?'Along the pinned line from the current view':'Along the saved line · flight ≈ '+Math.round(range)+' m · nominal penetration '+Math.round(shell.penetration)+' mm';
    // The ring on screen is part of the key: a pinned point and the user's first emulated shot both take
    // the recorded rings away, and the line that describes them has to go with them.
    var ringShown=!!(viewer&&viewer.savedAimShown&&viewer.savedAimShown());
    // damageView is part of the key: the figure below is formatted as a share of alpha or as a chance, so a
    // Display switch alone must rebuild it - otherwise the tile keeps the other mode's number (inspection, 20.09).
    var key=JSON.stringify(shell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'')+'|'+ringShown+'|'+damageView;
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim||totalEstimate!==viewer.estimateAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;totalEstimate=viewer.estimateAim;window.clearTimeout(totalTimer);
      // No saved circle: the emulated circle's own figure while it is on screen, else the nominal ring's
      // diameter, so a 10 cm ring at short range reads as present, not missing.
      $('total-chance').textContent=!viewer.savedAim&&viewer.estimateAim?'\u2300 '+(viewer.estimateAim.radius*2).toFixed(2)+' m':'—';
      // The Circle line of the hit-line panel is rebuilt with it and stays away until the integral below
      // has a figure: a stale percentage under a new shell or a new pose would be a lie.
      aimRecorded=null;paintCircleLines();
      // In damage mode the tile reads as a share of alpha: the mean expected damage over the circle, misses
      // counted as 0, divided by what one shot of this shell can do. The same pass feeds the Circle line
      // of the recorded ring (user, 20.09), so the rays are cast once for both.
      // The reticle tile keeps its own number whether the ring is on screen or not - it is about the saved
      // circle, not about what is drawn - so only the panel LINE waits for the ring to be visible.
      if(viewer.savedAim&&shell)totalTimer=window.setTimeout(function(){var v=viewer.savedAimProbability(shell);
        $('total-chance').textContent=!v?'—':damageView?'≈ '+(v.unknown?damagePct(v.damage)+'–'+damagePct(v.damageHigh):damagePct(v.damage))+' %':'≈ '+(v.unknown?v.low.toFixed(0)+'–'+v.high.toFixed(0):v.low.toFixed(0))+'%';
        aimRecorded=v&&ringShown?{damage:damagePct(v.damage,shell),alpha:shell.alpha>0,kind:'saved'}:null;paintCircleLines();},100);
      // A hit with no reticle of its own: the dashed nominal ring is the one on the model, so the line
      // is printed for THAT ring and its tooltip says the figure is an estimate with it.
      else if(viewer.estimateAim&&shell&&ringShown)totalTimer=window.setTimeout(function(){var v=viewer.estimateAimProbability(shell);
        aimRecorded=v?{damage:damagePct(v.damage,shell),alpha:shell.alpha>0,kind:'estimate'}:null;paintCircleLines();},100);
    }
  }
  // The reticle tile's tooltip: what its number means first, then which circles this hit has and how the figure
  // is sampled. The status half is written once per hit by display(); the mode half changes with the Display
  // setting, so the whole title is rebuilt from both.
  var aimStatus='',shotPanelTitle=$('shot-panel').title;
  function aimTitle(){
    $('aim-metric').title=(damageView?'Expected damage per shot from this reticle, as a share of the shell’s alpha: a random shot inside the saved circle, the mean of penetration damage and the reconstructed non-penetration damage.':'Chance to penetrate from this reticle: a random shot inside the saved circle that both hits and penetrates. Nominal penetration, no RNG.')+
      ' Reticle circles on the model. '+aimStatus+' Over the saved circle: '+ArmorBallistics.aimProfile().label+'; 256 rays, misses = 0. Server formula not confirmed'+(damageView?'; the non-penetration part is a reconstruction (ratio law). No map obstacles, target motion or splash onto other parts.':'; no map obstacles, target motion or blast damage.');
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
    var browsing=!!(activeHit&&(activeHit.vehicle||activeHit.chosenShooter));
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
    // The colour legend is gone from the scene (user, 20.09): the corner it stood in is free, and the
    // colours are read off the panels, which print the figure itself.
    $('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');$('parameters-notice').hidden=!mapMode||(valid&&!noAlpha);
    $('penetration').setAttribute('aria-invalid',String(mapMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(mapMode&&!(caliber>0&&caliber<=1000)));
    $('probe-chance').textContent='—';$('probe-chance').style.color='';$('probe-pen').replaceChildren();$('probe-extra').replaceChildren();$('probe-details').replaceChildren(node('span','Hover over the armour','placeholder'));
    modsVisible();
    staleEstimate();if(viewer)viewer.configure(shell,mapMode,$('palette').value,mode);shotStats();updateAim();
  }
  var shellGroup=document.querySelector('.shell-fields');
  var ricochetTint=.5; // the Ricochet tint row of Settings, 0 (off)..1.5; the panels' ricochet colours follow the map
  // Display = Expected damage, with a shell that carries an alpha: the panels read as a share of alpha and take their colours
  // from the same quantity the map is drawn with. Set by updateShell, read everywhere the numbers are written.
  var damageView=false;
  // Mean expected damage over a circle, in HP, read as a share of the current shell's alpha. The samplers
  // in viewer.js still work in HP - that is what a ray returns and what the Statistics log compares with the
  // server - and only the display divides by alpha.
  // Expected damage as a share of alpha. The shell is the one on screen unless a caller hands in the very
  // shell the figure was sampled with (the hit-line panel builds its own at the recorded range).
  function damagePct(hp,shell){var s=shell||(viewer&&viewer.shell);return Math.round(s&&s.alpha>0?Math.max(0,Math.min(100,100*hp/s.alpha)):0);}
  function chanceRgb(r){return 'rgb('+ArmorBallistics.color(r,$('palette').value,ricochetTint,damageView?'damage':'chance').map(function(v){return Math.round(v*255);}).join(',')+')';}
  // Expected damage is read as a share of the shell's own alpha, never in HP (user, 19.09): "50 %" says at a
  // glance how much of what this shell can do a shot at this point is worth, and the same number compares two
  // guns whose alphas differ. The alpha in HP appears once per panel, muted, beside the chance (user, 20.09).
  // A shell whose non-penetration damage has no model (the Taschenratte ability shell) shows the penetration part
  // alone as a lower bound, never as the expectation: the recorded shots of that shell do deal damage without piercing.
  function damageShare(r){
    var s=viewer&&viewer.shell,share=r.expectedShare;
    if(share===null||share===undefined)share=s&&s.alpha>0?r.expected/s.alpha:0;
    return (r.damageLaw==='special-unknown'?'≥ ':'')+Math.round(Math.max(0,Math.min(1,share))*100)+' %';
  }
  // What the expected damage is made of, for the panel under the number: the penetration chance it came from,
  // and the non-penetration damage of the ratio law with the three figures behind it. Legacy HE (SPG) says
  // instead that its splash is not modelled - there is no client-side rule for it to show.
  function damageGroups(r){
    var s=viewer&&viewer.shell;if(!s)return [];
    if(r.damageLaw==='legacy-unknown')return [{kind:'damage',text:'splash not modelled'}];
    if(r.damageLaw==='special-unknown')return [{kind:'damage',text:'non-pen unknown',title:'This shell has its own spall absorption rule and does deal damage without piercing; no law fits the recorded shots, so the number is a lower bound (penetration only).'}];
    if(r.damageLaw!=='ratio'||!(r.nonPen>0)||r.chance===null||r.chance===undefined)return [];
    var liner=s.liner>0?s.liner:1,pass=r.screenPass===undefined||r.screenPass===null?1:r.screenPass;
    var groups=[{kind:'damage',text:'pen '+Math.round(r.chance)+' %'},
      // The non-penetration part is a share of alpha too, so the two numbers of the expectation read on one
      // scale: "pen 40 % · non-pen 5 %" adds up to the 43 % above it without a unit change in the middle.
      {kind:'damage',text:'non-pen '+Math.round(s.alpha>0?100*r.nonPen/s.alpha:0)+' %',
       // Two decimals: the liner is no longer one device factor but the product of the Target switches (1.725).
       title:'Damage without piercing, as a share of alpha: '+Math.round(r.nonPen)+' HP of '+Math.round(s.alpha||0)+' HP · spall '+Math.round(s.spallDamage||0)+' HP · plate '+Math.round(r.nominal)+' mm · liner ×'+liner.toFixed(2)}];
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
    if(r.reason==='screen')return {label:hp?'0 %':'0%',color:zero,groups:prefix.concat([{kind:'armor',text:'explodes on the screen (this HE cannot pass screens)'}],shell,extra)};
    if(r.reason==='no-hull')return r.bounce?{label:hp?'0 %':'0%',color:bounced,groups:prefix.concat(shell)}:{label:'—',color:'',groups:[{kind:'armor',text:'no main armour on this line'}]};
    if(r.reason==='parameters')return {label:'—',color:'',groups:[{kind:'armor',text:'set penetration and calibre'}]};
    if(r.reason==='armor')return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no armour data for this surface'}])};
    if(r.chance===null)return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no estimate for this penetration distribution'}])};
    return {label:hp?damageShare(r):r.chance+'%',color:chanceRgb(r),groups:prefix.concat([{kind:'armor',text:'eff '+Math.round(r.effective)+' mm ← '+Math.round(r.nominal)+' mm – '+Math.round(r.angle)+'°'}],hp?damageGroups(r):[],shell,extra)};
  }
  function chips(container,line){container.replaceChildren();line.groups.forEach(function(g){var chip=node('span',g.text,'chip '+g.kind);if(g.title)chip.title=g.title;container.appendChild(chip);});}
  // Fill an info panel: the title, the chance, then the penetration chip on a row of its own above the armour chips.
  // The shell's alpha rides on the chance line as a muted "/ 390 alpha" (user, 20.09): the line has the room, and
  // the share figures around it are read against that number.
  function fillPanel(prefix,line,alpha){var by=function(k){return line.groups.filter(function(g){return (g.kind==='screen')===(k==='screen')&&(k==='screen'||(g.kind==='pen')===(k==='pen'));});};
    var chance=$(prefix+'-chance');chance.replaceChildren(document.createTextNode(line.label));chance.style.color=line.color;
    if(alpha>0){var a=node('span','/ '+Math.round(alpha),'info-alpha');a.title='The shell’s alpha damage, HP';chance.appendChild(a);}chips($(prefix+'-pen'),{groups:by('pen')});chips($(prefix+'-details'),{groups:by('rest')});chips($(prefix+'-extra'),{groups:by('screen')});}
  function inspectArmor(r){
    var range=viewer?viewer.distance:100;
    fillPanel('probe',armorLine(r,viewer&&viewer.shell?viewer.shell.penetration:null,range),viewer&&viewer.shell&&viewer.shell.alpha);
  }
  // Heading: which battle this is - date and start time, the map, and the vehicle the player was in.
  function battleStamp(seconds){if(!Number.isFinite(seconds))return '';var d=new Date(seconds*1000);return d.toLocaleDateString('en-GB')+' \u00b7 '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
  // ====================== The battle picker in the heading ======================
  // The heading tile IS the battle list again (user, 19.09): the map as the title, the player's vehicle tile
  // next to it, a caret at the end. #battles stays the state holder and is hidden - refresh() fills its
  // options and sets its value, $('battles').onchange loads the battle - and the tile only mirrors it: a row
  // sets the value and dispatches 'change', so every path downstream is the one the native select took.
  // The rows carry index.battles[i].vehicle, written by the exporter since 19.09; an index written before it
  // has none and such a row shows the map alone. The heading tile itself keeps the vehicle renderHeading()
  // reads from the hits, which covers those older indexes too.
  var battleSummaries=[];
  function battleSummary(id){var i;for(i=0;i<battleSummaries.length;i++)if(battleSummaries[i].id===id)return battleSummaries[i];return null;}
  // Secondary in a row: day and month without the year, then the start time. No hit count (user, 19.09).
  function battleWhen(seconds){
    if(!Number.isFinite(seconds))return '';
    var d=new Date(seconds*1000),pad=function(n){return (n<10?'0':'')+n;};
    return pad(d.getDate())+'.'+pad(d.getMonth()+1)+' \u00b7 '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }
  function renderBattleList(){
    var list=$('battle-list'),id=$('battles').value;list.replaceChildren();
    if(!battleSummaries.length){list.appendChild(node('p','No battles yet.','empty'));return;}
    battleSummaries.forEach(function(b){
      var o=node('button',undefined,'battle-option');o.type='button';o.setAttribute('role','option');
      o.setAttribute('data-id',b.id);o.setAttribute('aria-selected',String(b.id===id));
      o.appendChild(node('span',b.map||'Unknown map','battle-option-map'));
      var slot=node('span',undefined,'battle-option-vehicle');if(b.vehicle)slot.appendChild(vehicleTile(b.vehicle));
      o.appendChild(slot);o.appendChild(node('span',battleWhen(b.startedAt),'battle-option-when'));
      o.title=[b.map||'Unknown map',b.vehicle&&b.vehicle.name,battleWhen(b.startedAt)].filter(Boolean).join(' \u00b7 ');
      o.onclick=function(){pickBattle(b.id);};
      list.appendChild(o);
    });
  }
  // The tile's title text and the selected row, from whatever #battles currently holds. In the Vehicles mode
  // the same slot carries the vehicle name (renderVehicleHeading), so it is left alone there.
  function syncBattlePick(){
    var id=$('battles').value,row=battleSummary(id);
    if(sidebarMode==='battles')$('battle-map').textContent=row?(row.map||'Unknown map'):(current&&current.map)||(battleSummaries.length?'Pick a battle':'No battles yet');
    [].forEach.call($('battle-list').querySelectorAll('[role=option]'),function(o){o.setAttribute('aria-selected',String(o.getAttribute('data-id')===id));});
  }
  function openBattleList(open){
    var list=$('battle-list'),button=$('battle-pick');
    if(open&&button.disabled)open=false;
    list.hidden=!open;button.setAttribute('aria-expanded',String(open));
    if(!open)return;
    var row=list.querySelector('[aria-selected=true]')||list.querySelector('[role=option]');
    if(row)row.focus();
  }
  function pickBattle(id){
    openBattleList(false);$('battle-pick').focus();
    var picker=$('battles');
    // The battle already open: a native select fires no change for its own option either.
    if(!id||picker.value===id)return;
    picker.value=id;syncBattlePick();picker.dispatchEvent(new Event('change'));
  }
  $('battle-pick').onclick=function(){openBattleList($('battle-list').hidden);};
  // Arrows walk the rows, Enter picks (the row is a button), Escape and Tab hand the focus back to the tile.
  // Closing on a click elsewhere is the page's one popover handler, at the bottom of this file.
  document.querySelector('.heading-pick').addEventListener('keydown',function(e){
    if(e.key==='Escape'||e.key==='Esc'||e.key==='Tab'){
      if($('battle-list').hidden)return;
      if(e.key!=='Tab')e.preventDefault();
      openBattleList(false);$('battle-pick').focus();return;}
    var rows=[].slice.call($('battle-list').querySelectorAll('[role=option]'));
    if(!rows.length||$('battle-list').hidden)return;
    var at=rows.indexOf(document.activeElement),step=e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0;
    if(step){e.preventDefault();rows[Math.max(0,Math.min(rows.length-1,at+step))].focus();return;}
    if(e.key==='Home'||e.key==='End'){e.preventDefault();rows[e.key==='Home'?0:rows.length-1].focus();}
  });
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
  function pickerRow(row,side,star,focus,shooter){
    var b=node('button',undefined,'picker-row');b.type='button';
    b.setAttribute('data-id',String(row.id));b.setAttribute('data-side',side);
    b.setAttribute('aria-pressed',String(row.id===focus));
    if(shooter)b.setAttribute('data-role','shooter');
    b.appendChild(node('span',row.name||'Unknown vehicle','picker-vehicle'));
    b.appendChild(node('span',row.player||'','picker-player'));
    b.title=[row.name||'Unknown vehicle',row.player,side==='ally'?'Ally':'Enemy',shooter?'in the shooter role':''].filter(Boolean).join(' · ');
    // The roster serves whichever scene tile is the active role: the model tile reads the battle from this
    // vehicle, the shooter tile puts his gun against the model already on screen.
    b.onclick=function(){if(activeRole==='shooter')pickShooter(row);else chooseFocus(row.id);};
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
    var shooter=shooterId();
    var stamp=(current?current.id:'')+'|'+focus+'|'+shooter+'|'+activeRole+'|'+rows.map(function(r){return r.id+':'+(r.name||'')+':'+(r.player||'')+':'+(r.team==null?'':r.team);}).join(',');
    if(stamp!==focusStamp){
      focusStamp=stamp;list.replaceChildren();
      // The same rows serve both scene tiles, so the popover says out loud which role a click fills.
      list.appendChild(node('div',activeRole==='shooter'?'A click picks the SHOOTER: his gun against the model on screen':'A click picks whose seat the battle is read from','picker-note'));
      [['ALLIES','ally',groups.allies],['ENEMIES','enemy',groups.enemies]].forEach(function(group){
        if(!group[2].length)return;
        list.appendChild(node('div',group[0],'picker-group eyebrow'));
        group[2].forEach(function(r){list.appendChild(pickerRow(r,group[1],group[1]==='ally'&&r.id===own&&free,focus,r.id===shooter));});
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
  // ===================== A roster vehicle in the shooter role =====================
  // The shooter tile is a role control in the Battles mode too (user, 19.09): a roster row then puts that
  // vehicle's gun against the model already on screen. It is the very synthetic hit the vehicle browser and
  // the swap build - no hit point, no shot line, no reticle - and his shells come from a hit he fired in this
  // battle, or from his own exported record when the battle holds none of his shots. Neither: nothing moves.
  var NO_GUN_DATA='No data for this vehicle’s gun yet';
  // Who is in the shooter role, as the roster knows him: the attacker of the recorded hit on screen, or the
  // vehicle a roster row was picked for. A swapped view and a browsed vehicle carry no id and mark nobody.
  function shooterId(){var h=activeHit;return h&&h.attackerId!=null?h.attackerId:null;}
  function recordedShooter(id){
    var hits=(current&&current.hits)||[],i,h;
    for(i=0;i<hits.length;i++){h=hits[i];
      if(h.attackerId===id&&h.attacker&&h.attacker.name)return {vehicle:h.attacker,shells:(h.availableShells||h.shellCandidates||[]).slice()};}
    return null;
  }
  function catalogueShooter(type){
    if(!type)return Promise.reject(new Error(NO_GUN_DATA));
    return (catalogue?Promise.resolve():loadCatalogue()).then(function(){
      var entry=((catalogue&&catalogue.vehicles)||[]).find(function(v){return String(v.type||'')===type;});
      if(!entry)throw new Error(NO_GUN_DATA);
      return readVehicle(entry.id,0);
    }).then(function(record){return {vehicle:record,shells:(record.shells||[]).slice()};});
  }
  function shooterHit(model,shooter,shells,id,base,aim){
    var target=shallow(model),attacker=shallow(shooter);
    ['shells','warnings','schema'].forEach(function(k){delete target[k];});
    ['parts','shells','warnings','schema','gunPitchLimits','turretYawLimits'].forEach(function(k){delete attacker[k];});
    var hit={id:'shooter:'+id+'/'+(target.type||''),synthetic:true,chosenShooter:true,direction:'incoming',attackerId:id,
      target:target,attacker:attacker,points:[],rawHitPoints:[],warnings:[],
      shellCandidates:[],availableShells:(shells||[]).slice(),shellStatus:'chosen shooter',receivedAt:model.exportedAt};
    if(base)hit.base=base; // a recorded hit to go back to, so the ⇅ button keeps its way home
    if(aim)hit.aim=aim.slice(); // the model keeps the pose it was recorded in: the same target, the same hit
    return hit;
  }
  // Only the shooter changes, so the camera and the orbit centre stay where they are, as a shooter picked in
  // the Vehicles mode does. A vehicle whose gun is nowhere in the record says so and leaves the scene alone.
  function pickShooter(row){
    $('vehicle-focus').open=false;
    var hit=activeHit,model=hit&&hit.target;
    if(!model||!(model.parts||[]).length)return void message('No collision model on screen to shoot at: pick a hit or a vehicle first.');
    var known=recordedShooter(row.id),base=hit.synthetic?hit.base||null:hit.id,aim=hit.synthetic?null:hit.aim;
    var camera=viewer&&viewer.cameraState?viewer.cameraState():null,token=++generation;
    (known?Promise.resolve(known):catalogueShooter(row.type?String(row.type):'')).then(function(found){
      if(token!==generation)return null;
      message('Preparing the model…');
      var synthetic=shooterHit(model,found.vehicle,found.shells,row.id,base,aim);
      return ArmorInspectorData.sceneFor(current||{warnings:[]},synthetic).then(function(data){
        if(token!==generation)return null;
        display(data,false);if(camera&&viewer)viewer.restoreCamera(camera);renderHits();
        return data;
      });
    }).catch(function(){if(token===generation){message(NO_GUN_DATA);warnings([NO_GUN_DATA]);}});
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
    syncBattlePick();
    var slot=$('heading-vehicle');slot.replaceChildren();if(own)slot.appendChild(vehicleTile(own));
    return own;
  }
  // Two overlays inside the scene: the vehicle whose collision model is drawn stays centred over it, the
  // shooter sits underneath. Each tile picks its role (chooseRole); the ⇅ button next to the shooter swaps
  // the two - his collision model is drawn and the vehicle that was drawn becomes the shooter. The swapped
  // view carries no recorded shot (no hit line, no reticle): an inspector without a shot. The same button
  // then takes it back to the recorded hit.
  var swapped=null;
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
    // Both tiles are role controls in both modes (user, 19.09): the one pressed last is the role the next
    // click in the side panel fills - a catalogue row in Vehicles, a roster row in Battles. The swap that
    // used to sit on the shooter tile has a button of its own next to it.
    model.disabled=false;button.disabled=false;
    model.title=roleHint('model');button.title=roleHint('shooter');
    swapTile(hit);roleTiles();
  }
  // What a click on this tile does: it opens the vehicle list on the vehicle that is in this role, in either
  // mode, and the next row clicked there fills it.
  function roleHint(role){
    return role==='shooter'?'The shooter \u00b7 click to pick him in the vehicle list: his gun against the model on screen'
      :'The collision model on screen \u00b7 click to pick it in the vehicle list';
  }
  function roleTiles(){
    $('model-tile').setAttribute('aria-pressed',String(activeRole!=='shooter'));
    $('shooter-tile').setAttribute('aria-pressed',String(activeRole==='shooter'));
  }
  // The tile click chooses the role and opens the Vehicles panel on it (user, 19.09). The scene stays where
  // it is - setMode keeps the hit that is on screen and hands its two vehicles to the list - and the row that
  // holds the chosen role is marked and scrolled into view, in either scope. The roster picker of the Battles
  // mode is never opened from a tile: the page's own closing handler shut it on the very same click.
  function chooseRole(role){
    activeRole=role==='shooter'?'shooter':'model';roleTiles();
    var ready=sidebarMode==='vehicles'?Promise.resolve():setMode('vehicles');
    ready.then(showActiveRole,showActiveRole);
  }
  function showActiveRole(){
    renderVehicles();
    var v=activeRole==='shooter'?shooterVehicle:modelVehicle;
    var row=v?$('vehicles').querySelector('[data-vehicle="'+v.id+'"]'):null;
    if(row&&row.scrollIntoView)row.scrollIntoView({block:'nearest'});
  }
  // The swap is a button of its own since 19.09 and is offered only where it can do something: a recorded hit
  // whose shooter has a collision model, or a view already swapped, which it takes back to the recorded hit.
  function swapTile(hit){
    var b=$('swap-roles'),back=!!(hit&&hit.synthetic&&!hit.vehicle&&hit.base);
    // Vehicles mode: two different browsed vehicles simply change places (user, 19.09: the button must work there too).
    var browsed=sidebarMode==='vehicles'&&!!(hit&&hit.vehicle)&&!!modelVehicle&&!!shooterVehicle&&shooterVehicle.id!==modelVehicle.id;
    b.hidden=!(browsed||(sidebarMode==='battles'&&!!current&&(back||(!!hit&&!hit.synthetic&&swapReady(hit)))));
    b.title=back?'Back to the recorded hit and its shot line':'Swap the model and the shooter';
  }
  function display(data,reference){
    // The emulated circle of the previous hit goes first: prepareShell() below rebuilds it for the new
    // shooter, and clearing it afterwards would throw that away.
    // aimShot goes with the ring: the figure of a shot fired at the previous hit must not sit on the
    // panel of the new one, where it also hides that hit's own reticle figure (inspection, 20.09).
    currentHitKey=null;aimShot=null;if(viewer)viewer.clearLiveAim();
    var hit=data.hit;swapped=hit.synthetic&&!hit.vehicle?hit:null;sceneTiles(hit,reference);
    var pend=pendingParts(hit);noteModelsPending(hit,pend);
    // The roster's shooter mark reads activeHit, which prepareShell() has only just moved to this hit: every
    // renderHits() before it (selectHit calls one before the scene arrives) still marked the previous
    // hit's shooter, and nothing repainted the roster after a click (optimisation plan 21.09, §8.4).
    $('shot-source').textContent=hit.synthetic?'No recorded shot':'Hit line';prepareShell(hit);renderFocus();var drawn=viewer&&viewer.load(data,shotContext);
    // A part on its way is not a missing model: the spinner outranks both the empty
    // message and the “geometry unavailable” one, which belongs to a broken record.
    if(pend.target)message(EXTRACTING,true);else message(drawn?'':data.geometryError||'Geometry unavailable. The original event is kept.');
    pivotButtons();warnings(pendingWarnings(data.warnings||[],hit));$('details').replaceChildren();
    // The saved reticle exists only for the player's own shots: with an ally in focus his gun has no
    // telemetry at all, so his outgoing hit reads exactly like an incoming one does today - no recorded
    // circle, the nominal estimate if the record allows one. setShotContext(null) still builds the (empty)
    // aim group the estimate is drawn into.
    var view=viewDirection(hit),ownShot=focusIsPlayer()&&view==='outgoing';
    var aimReady=viewer&&viewer.setShotContext(ownShot?shotContext:null),estimate=!aimReady&&viewer?viewer.setAimEstimate(shotContext):null;
    $('total-chance').textContent=estimate?'\u2300 '+(estimate.radius*2).toFixed(2)+' m':'—';
    // Why there is no circle, in full: no resolved impact point to centre on, no gun dispersion in the record,
    // no range, or no own reticle linked to this hit (every incoming hit by design - the enemy's is not recorded).
    var reason=aimReady?'saved reticle':estimate?'nominal estimate':!(viewer&&viewer.point&&viewer.travel)?'no resolved impact point':!(hit.attacker&&hit.attacker.gunDispersion>0)?'no gun dispersion in the record':!(shotContext.range>0||hit.rangeAtImpact>0)?'no range for this hit':!ownShot?'enemy reticle unavailable':(aimReasons[shotContext.aimReason]||'no linked snapshot').toLowerCase();
    // The reticle block stays small: what the circles mean and where this one came from lives in the ⓘ tooltip.
    var status=aimReady?'This hit: ● solid magenta — the client reticle at the shot, ◌ dashed magenta — the server reticle, both slid along the shot line to the impact point. Every standing ring is magenta; only the live emulation ring is cyan.':estimate?'This hit: ◌ dashed magenta — nominal full-aim estimate of the '+(estimate.gun||'mounted gun')+': '+(estimate.dispersion*100).toFixed(2)+' m at 100 m × '+Math.round(estimate.range)+' m ('+(estimate.source==='tracer'?'tracer range':'approximate range at impact')+') = ⌀ '+(estimate.radius*2).toFixed(2)+' m. Without crew or equipment, centred on the hit line; not the recorded reticle and not used in the figure.':'This hit: no reticle — '+reason+'.';
    // One line per hit in the page console; the game writes page console lines into game.log, so an in-game
    // report about missing rings can be read there instead of guessed at.
    if(window.console)console.info('Bullba Hits aim: hit '+hit.id+' '+(view||'other')+' saved='+!!aimReady+' estimate='+!!estimate+' reason='+reason);
    aimStatus=status;aimTitle();
    shotStats();updateAim();
    if(reference){$('details').appendChild(node('p','The model is extracted from the installed client. There are no invented hits here. Once the recorder is installed, new battles appear in the list on the left.'));return;}
    if(hit.vehicle){
      var mv=hit.target||{},sv=hit.attacker||{},when=Number.isFinite(hit.receivedAt)?new Date(hit.receivedAt*1000).toLocaleDateString('en-GB'):'an unknown date';
      $('details').appendChild(node('p','Client collision model of '+(mv.name||'this vehicle')+', exported from '+(SOURCE_TEXT[mv.source]||'the client')+' on '+when+', rest pose. Shooter: '+(sv.name||'\u2014')+', '+(sv.gun||'gun not recorded')+'. Nothing was fired here: pin a point on the armour to read a line, or Alt + click to estimate a reticle.'));
      return;
    }
    if(hit.chosenShooter){
      var shooter=hit.attacker||{},under=hit.target||{};
      $('details').appendChild(node('p',(shooter.name||'This vehicle')+'\u2019s gun against '+(under.name||'the model on screen')+': '+(shooter.gun||'gun not recorded')+'. Nothing was fired between these two in the record, so there is no hit line and no reticle - the shells are his, the armour is the model already loaded. Pin a point to read a line, or pick a hit in the list to go back to a recorded shot.'));
      return;}
    if(hit.synthetic){$('details').appendChild(node('p','The shooter\u2019s collision model, swapped in from the hit at '+clock(hit.receivedAt)+'. Nothing was fired at this vehicle in the record, so there is no hit line, no reticle and no shell of its own. The \u21c5 button next to the shooter tile goes back to the recorded hit.'));return;}
    detail('Direction',view==='incoming'?'Incoming':view==='outgoing'?'Outgoing':'Not this vehicle',clock(hit.receivedAt));detail('Result',result(hit));var critRow=critDetail(hit);if(critRow)$('details').appendChild(critRow);
    var points=hit.points||[],point=points.find(function(p){return p.status==='resolved';});
    detail('Point on the model',point?['Chassis','Hull','Turret','Gun'][point.part]:'Not restored',point?'Per the client collision handler':'Segment kept for diagnostics');
    detail('Calibre',point&&point.caliber?point.caliber+' mm':'No data',points.length+' points in the event');
    if(hit.rangeAtImpact!=null)detail('To the attacker at impact',hit.rangeAtImpact.toFixed(1)+' m','Position when the hit was received; not a measured flight length.');
  }
  // The details row of the critical damage, marked so that a later tie can replace it in place: the exporter ties
  // the client's crit records on its next publish, which can come after the hit is on screen.
  function critDetail(hit){
    var text=ArmorCrits.describe(hit);if(!text)return null;
    var e=node('div');e.setAttribute('data-detail','crits');e.appendChild(node('div','Critical damage','detail-label'));e.appendChild(node('div',text,'detail-value'));
    var from=ArmorCrits.sources(hit);if(from)e.appendChild(node('div',from,'detail-small'));return e;
  }
  function renderCritDetail(hit){
    var box=$('details'),rows=Array.prototype.slice.call(box.children||[]),row=critDetail(hit);
    var old=rows.find(function(r){return r.getAttribute&&r.getAttribute('data-detail')==='crits';});
    var anchor=rows.find(function(r){return r.children&&r.children[0]&&r.children[0].textContent==='Result';});
    if(old){if(row)box.insertBefore(row,old);box.removeChild(old);}
    else if(row&&anchor)box.insertBefore(row,anchor.nextSibling||null);
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
    hits.forEach(function(h){var hasDamage=h.damage>0,view=viewDirection(h),b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(selected===h.id));b.setAttribute('data-direction',view);b.setAttribute('data-result',hasDamage?'damage':'none');b.title=(view==='incoming'?'Incoming from '+((h.attacker||{}).name||'?'):'Outgoing at '+((h.target||{}).name||'?'))+' · '+result(h)+(ArmorCrits.describe(h)?' · '+ArmorCrits.describe(h):'');
      b.appendChild(vehicleTile(view==='incoming'?h.attacker:h.target));
      // Critical damage (22.09): the client's own icons of the damaged modules and injured crew, up to four in a
      // 2x2 grid, every word in the icon's title. Nothing known about the crits of this hit - no element at all.
      // An icon that fails to load (not extracted yet) takes itself away, and the empty box with it.
      var crit=ArmorCrits.badges(h);
      if(crit.length){var box=node('span',undefined,'hit-crits');crit.slice(0,4).forEach(function(c){var i=node('img',undefined,'crit-icon');i.alt='';i.title=c.title;i.onerror=function(){i.remove();if(!box.children.length)box.remove();};i.src=c.src;box.appendChild(i);});b.appendChild(box);}
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
      // Only its critical-damage row follows, since crit ties may have arrived after the hit (they stay out of the
      // fingerprint, which would rebuild the scene).
      // The shot on screen is still the old object: the new ties go onto it, or the Statistics log would write
      // the old crit fields on the next shell change.
      if(unchanged){if(activeHit&&activeHit!==kept&&activeHit.id===kept.id&&!activeHit.synthetic)activeHit.crits=kept.crits;renderCritDetail(kept);return;}
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
      battleSummaries=battles.slice();
      if(!battles.length){current=null;selected=null;++battleGeneration;$('battles').appendChild(node('option','No battles yet'));
        renderBattleList();syncBattlePick();
        if(sidebarMode!=='battles'){battlesDirty=true;return;}
        ++generation;if(viewer)viewer.clear();sceneTiles(null,false);renderHits();message('New hits appear here after a battle.');warnings([]);return;}
      battles.forEach(function(b){var option=node('option',new Date(b.startedAt*1000).toLocaleDateString('en-GB')+' \u00b7 '+b.map+' \u00b7 '+b.hits);option.value=b.id;$('battles').appendChild(option);});var id=battles.some(function(b){return b.id===prior;})?prior:battles[0].id;$('battles').value=id;
      renderBattleList();syncBattlePick();
      // The battle list stays fresh while the Vehicles mode is on screen, but the scene there belongs to a
      // vehicle: the reload waits for the switch back.
      if(sidebarMode!=='battles'){battlesDirty=true;return;}
      return loadBattle(id,current&&current.id===id);
    }).catch(function(e){$('connection').textContent='No local records';if(!current&&sidebarMode==='battles'){message(e.message);warnings([e.message]);}}).then(function(){polling=false;});
  }
  try{viewer=new ArmorViewer($('viewport'));}catch(e){message('WebGL unavailable: '+e.message);}
  if(viewer)viewer.setAutoFrame($('auto-frame').checked); // on by default (user, 18.09)
  if(viewer)viewer.setLighting($('soft-lighting').checked); // on by default (user, 19.09); the checkbox is the switch
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
  var shellTimer=0; // the end of a wheel glide (onCamera below)
  if(viewer)viewer.onCamera=function(state){var changed=lastDistance!==state.distance;lastDistance=state.distance;if(document.activeElement!==$('camera-distance-field'))$('camera-distance-field').value=Math.round(state.distance);if(document.activeElement!==$('camera-zoom-field'))$('camera-zoom-field').value=state.zoom.toFixed(2);$('camera-distance').value=Math.round(distanceSlider(state.distance));$('camera-zoom').value=Math.round(Math.max(0,Math.min(1000,Math.log(state.zoom/.1)/Math.log(1000)*1000)));var hr=viewer.heightRange(),hy=viewer.target.y;$('pivot-height').max=Math.max(1,Math.round((hr[1]-hr[0])*100));$('pivot-height').value=Math.round((hy-hr[0])*100);$('pivot-height-field').min=hr[0].toFixed(2);$('pivot-height-field').max=hr[1].toFixed(2);if(document.activeElement!==$('pivot-height-field'))$('pivot-height-field').value=hy.toFixed(2);var key=[state.distance,state.yaw,state.pitch,viewer.turretAngle,viewer.gunAngle].join(',');if(analysisKey!==null&&analysisKey!==key)staleEstimate();
    // A wheel glide changes the distance on every frame of its way (about sixteen a click). The shell - its
    // penetration at the new distance - and everything built on it are redone once, at the end: the last step
    // clears targetDistance before it renders, so the end runs at once, and a glide cut short (a hidden page)
    // is caught by the timer. The slider, the +/- keys, Fit and a restored camera set the distance directly
    // and are answered at once, as before.
    if(changed&&typeof viewer.targetDistance==='number'){window.clearTimeout(shellTimer);shellTimer=window.setTimeout(function(){shellTimer=0;updateShell();},150);}
    else if(changed){if(shellTimer){window.clearTimeout(shellTimer);shellTimer=0;}updateShell();}
    else if(totalEngine!==viewer.engine)shotStats();// The circle stands across the line from the camera to the aimed point, so a camera that moved needs it
    // redrawn; only the geometry is rebuilt here, the integral still waits for the cursor to rest.
    if(viewer.liveRadius100)viewer.drawLiveAim();};
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
  // The cross at the impact point only (user, 20.09). Stored and restored with every other setting in the
  // menu, so this one line is the whole wiring.
  $('impact-opacity').oninput=function(){if(viewer)viewer.setImpactOpacity(Number(this.value)/100);$('impact-opacity-value').textContent=this.value+' %';};
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
  // One call per pose change (the viewer notifies once per drag step). While a drag lasts only the tile is
  // brought up to date - the figures along the shot line answer for the pose of the last full rebuild anyway, and
  // that rebuild reaches the page through onCamera when the pose is committed (viewer.js commitPose) - except
  // when the pose crosses the recorded one, which hides or brings back the hit marks and the line's figure.
  var poseOff=null,poseShown='';
  function poseChanged(){
    if(!viewer)return;
    var loaded=!!viewer.loadedData;
    // The tile is measured again only when it appears, goes, or its text (and so its width) changes.
    if($('pose-info').hidden!==!loaded){$('pose-info').hidden=!loaded;scheduleLayout(LAYOUT_POSE);}
    if(!loaded)return;
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
    var shown=turret+'|'+gun+'|'+off;if(shown!==poseShown){poseShown=shown;scheduleLayout(LAYOUT_POSE);}
    // The figures vanish at the viewer's own 0.001° (recordedShown, shotProbability), the note at 0.1°.
    var state=off+'|'+(Math.abs(viewer.turretAngle)<.001&&Math.abs(viewer.gunAngle)<.001);
    if(viewer.dragging&&state===poseOff)return;
    poseOff=state;
    // The live ring does not depend on the pose: with the ring up and no manual estimate on screen there is
    // nothing to put away and draw again. Otherwise the estimate goes stale and the ring (if any) is redrawn.
    if(analysisKey!==null||!viewer.liveRadius100){staleEstimate();shotStats();if(viewer.liveRadius100)viewer.drawLiveAim();}
    else shotStats();
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
  // The two tiles only pick the role the side panel fills. The ⇅ button next to the shooter swaps the roles;
  // on a swapped view it goes back to the recorded hit. The list selection stays on the recorded hit either
  // way - the swap is a view of it, not another hit.
  $('shooter-tile').onclick=function(){chooseRole('shooter');};
  $('swap-roles').onclick=function(){
    if(sidebarMode==='vehicles'){if(!modelVehicle||!shooterVehicle)return;var m=modelVehicle;modelVehicle=shooterVehicle;shooterVehicle=m;shooterPicked=true;showVehicleScene(false).catch(function(){});return;}
    if(swapped){if(swapped.base)selectHit(swapped.base).catch(function(){});return;}
    var hit=activeHit;if(!hit||hit.synthetic||!swapReady(hit)||!current)return;
    var synthetic=swapHit(hit),token=++generation;message('Preparing the model\u2026');if(viewer)viewer.clear();
    ArmorInspectorData.sceneFor(current,synthetic).then(function(data){if(token!==generation)return;display(data,false);})
      .catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}});
  };
  if(viewer)viewer.onAim=function(text){analysisKey=null;$('spread-result').textContent=text;};
  // Releasing the pinned centre: the manual estimate goes stale as before, the emulated circle simply
  // goes back to following the cursor.
  $('reset-aim').onclick=function(){if(viewer){viewer.spreadAim=null;staleEstimate();if(viewer.liveRadius100)viewer.drawLiveAim();}};
  $('spread-radius').oninput=staleEstimate;
  // The press in the scene while the emulation is on: armed on pointerdown, fired on release (a tap) or on
  // the gun's cooldown (a hold), dropped when the press turns into a drag. With the emulation off none of
  // it claims the press and the viewer pins a point as before.
  if(viewer){viewer.onShotDown=function(){return beginShot();};viewer.onShotUp=function(){endShot();};viewer.onShotCancel=function(){return cancelShot();};}
  // The cursor moved, so the turret has somewhere to go: the loop decides for itself whether anything
  // is actually left to do and stops again straight away when there is not.
  if(viewer)viewer.onAimMove=function(){if(aimOn)startAimLoop();};
  // The camera came to rest after an orbit while Config holds the aim, and the viewer found the middle of the
  // target again: the ring stands on another point, so its figure is taken again - the coarse one within its
  // 120 ms pace, not at once as aimRingMoved does (a wheel glide or a +/- key can settle again soon after), and
  // the fine one when the woken loop finds everything at rest.
  if(viewer)viewer.onAimCentre=function(){if(!aimLive||!aimCentred)return;aimEstFine=false;paintAim(aimLastState||aimState());startAimLoop();};
  // The mode is ON by default and its switch is an ordinary Settings -> Scene checkbox (user, 20.09):
  // the settings machinery restores it, runs this handler and persists it like every other control, so
  // nothing here writes to storage by hand.
  $('aim-on').onchange=function(){setAimEmulation(this.checked);};
  // The crosshair shape is a Settings control, so the settings machinery stores it; this only re-applies
  // the class while the mode is on.
  $('crosshair-style').onchange=function(){aimCursorClass();aimSyncCentre();};
  // The Config popover opening or closing, whoever did it: its summary, a click elsewhere, the mode going off.
  $('aim-config').addEventListener('toggle',function(){aimSyncCentre();});
  // A popover left out of date while it was closed is painted by the click that opens it - synchronously, before
  // <details> opens (Enter and Space on the summary are clicks too), so it never shows the previous shooter for a
  // frame. The asynchronous toggle event would come too late for that.
  $('aim-config').querySelector('summary').addEventListener('click',function(){if(!$('aim-config').open&&aimConfigDirty)paintAimConfig(true);});
  // The manual estimate, for a shooter whose record carries no aiming parameters. Expected damage is a
  // share of the shell's alpha here too, so the two paths read the same way.
  $('estimate-spread').onclick=function(){if(!viewer)return;try{var result=viewer.estimateSpread(Number($('spread-radius').value));analysisKey=[viewer.distance,viewer.yaw,viewer.pitch,viewer.turretAngle,viewer.gunAngle].join(',');$('spread-result').textContent=(damageView?'Nominal expected damage: '+(result.unknown?damagePct(result.damage)+'–'+damagePct(result.damageHigh):damagePct(result.damage))+' % of alpha':'Nominal total chance: '+(result.unknown?result.low.toFixed(1)+'–'+result.high.toFixed(1):result.low.toFixed(1))+'%')+' · outside the main armour '+result.miss.toFixed(1)+'% · '+result.samples+' rays.'+(result.unknown?' A range because armour data is missing.':'')+(damageView?' For the chosen dispersion model; the non-penetration damage is a reconstruction, without map obstacles or splash onto other parts.':' For the chosen dispersion model, without map obstacles or blast damage.');}catch(e){$('spread-result').textContent=e.message;}};
  $('shell-choice').onchange=selectShell;
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
  $('soft-lighting').onchange=function(){if(viewer)viewer.setLighting(this.checked);};
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
    try{var box=JSON.parse(raw);
      // The shooter presets ride in the same object under their own key, so one read and one write serve
      // the whole page. A stored object that fails the checks in adoptAimStore is simply not adopted.
      if(box&&box.aim)adoptAimStore(box.aim);
      if(box&&box.values&&typeof box.values==='object')return box.values;}catch(e){}
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
    try{window.localStorage.setItem(SETTINGS_KEY,JSON.stringify({v:1,values:values,aim:aimStored()}));}catch(e){}
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
    // The shooter presets a user saved are his own data, not a setting of this menu, so they are kept.
    if(aimUserNames().length)persistSettings();
  };
  // The Target group is built before the settings are restored: restoring the Display setting already runs
  // updateShell(), which asks the group whether it belongs on screen.
  buildTargetMods();
  buildAimConfig();
  restoreSettings();
  // The stored presets are in place now, so the shooter on screen can be given his own again. The mode
  // itself needs no line here any more: restoreSettings() has already run the checkbox's own handler.
  syncShooterMods(activeHit);
  aimConfigChanged();
  // Heading overflow (18.09 round 2): the battle tile and the shell block share one grid row while the two fit;
  // when they do not, .stacked drops the whole shell block to a full-width second row. natural() reads the width
  // a block WANTS — position:absolute plus width:max-content, so a block that is wrapping right now still
  // reports its one-row width — and nothing is painted in between.
  // 20.09: Settings has moved to the header row, so it is no longer measured here (nor in layoutToolbar, which
  // never carried it): the heading is two blocks and one gap.
  var heading=document.querySelector('.scene-heading'),headingBattle=document.querySelector('.heading-battle');
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
    var need=natural(headingBattle)+natural(shellGroup)+gap;
    heading.classList.toggle('stacked',need>room);
  }
  // Toolbar overflow (18.09): the row never wraps. Each group carries data-tb — its keep priority, 1 kept
  // longest — and layoutToolbar() hands the highest numbers to the “More” popover until the rest fit on one
  // line, taking them back when the window widens. insertBefore moves the nodes themselves, so every id and
  // every listener inside a group survives the move.
  var toolbar=document.querySelector('.scene-toolbar'),moreBox=document.querySelector('.scene-toolbar > .toolbar-more');
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
  // The shooter's group does the same in the bottom band, beside the Shooter tile, so each group sits with
  // the vehicle it describes.
  function placeMods(group,slot,tile){
    var box=$('viewport');
    if(!group||!slot||slot.hidden||!box||!box.clientWidth)return;
    // The tile is centred with a transform, which offsetLeft does not see: its painted right edge comes from
    // the rectangles, measured against the viewport's own.
    var edge=14,gap=12,left=edge;
    if(tile&&tile.getBoundingClientRect().width>0){var box0=box.getBoundingClientRect(),t0=tile.getBoundingClientRect();left=Math.max(edge,t0.right-box0.left+gap);}
    slot.style.left=left+'px';
    group.fit(box.clientWidth-edge-left);
    // Collapsed, a group is exactly as wide as its own summary button, which fit() cannot shrink. When even
    // that does not fit beside the tile it is pulled back to the edge of the viewport instead of being
    // painted past it - overlapping the tile is the lesser evil, and only the bottom band ever gets there.
    var width=slot.getBoundingClientRect().width;
    if(left+width>box.clientWidth-edge)slot.style.left=Math.max(edge,box.clientWidth-edge-width)+'px';
  }
  function layoutMods(){
    placeMods(targetMods,$('target-mods-slot'),$('model-tile').hidden?null:$('model-tile'));
  }
  // One rAF debounce for all three: the heading is measured first, because stacking it changes nothing the
  // toolbar measures but a toolbar fold must not race the heading's own reflow.
  // The pose tile sits in the bottom-left corner and the shooter row is centred on the same bottom line; on a
  // narrow page the row's left end (the speed tile) would ride over it, so the pose tile then steps up above
  // the row instead of overlapping (user, 20.09). Measured, not guessed: the row's width depends on what it shows.
  function layoutPose(){
    var pose=$('pose-info'),row=document.querySelector('.shooter-row');if(!pose||pose.hidden)return;
    pose.style.bottom='';
    if(!row||!row.offsetWidth)return;
    var p=pose.getBoundingClientRect(),r=row.getBoundingClientRect();
    if(p.right+10>r.left&&p.bottom>r.top&&p.top<r.bottom)pose.style.bottom=(r.height+20)+'px';
  }
  // `parts` is a mask of the LAYOUT_ constants; the masks asked for before the frame are added up, and the frame
  // lays out exactly those. Every pass writes styles and reads widths in turn, so each one forces the browser to
  // lay the page out: a pose tile that changed its text must not also take the toolbar out of its popover (and
  // close “More” under a slider being dragged there). No argument - a mode switch, a new shell list, a resize,
  // the start - is the whole pass, as it always was.
  var tbParts; // no initialiser: a pass asked for while the module was still starting keeps its mask
  function scheduleLayout(parts){
    tbParts|=parts>0?parts:LAYOUT_ALL;if(tbFrame)return;
    tbFrame=window.requestAnimationFrame(function(){var p=tbParts;tbFrame=0;tbParts=0;
      if(p&LAYOUT_HEADING)layoutHeading();if(p&LAYOUT_TOOLBAR)layoutToolbar();if(p&LAYOUT_MODS)layoutMods();if(p&LAYOUT_POSE)layoutPose();});
  }
  window.addEventListener('resize',function(){scheduleLayout();}); // not the handler itself: the Event would be read as a mask
  // Closing on a click outside is written out here: the settings menu has no such handler to reuse. Every
  // popover of the page is a .toolbar-more <details>, the toolbar's own and the modifier groups' alike, and
  // the battle list of the heading tile rides on the same handler rather than bringing a third mechanism.
  document.addEventListener('click',function(e){document.querySelectorAll('.toolbar-more[open]').forEach(function(d){if(!d.contains(e.target))d.open=false;});
    var pick=document.querySelector('.heading-pick');
    if(pick&&!$('battle-list').hidden&&!pick.contains(e.target))openBattleList(false);});
  layoutHeading();layoutToolbar();layoutMods();layoutPose();
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
