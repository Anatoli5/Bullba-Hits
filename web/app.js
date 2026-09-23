(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
  var shellNames={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'},candidates=[],activeHit=null,shotContext=null,manualPen='',manualAlpha='',lastDistance=null,analysisKey=null,recordsVersion='';
  // Fingerprint of the hit record the scene was built from, so an index bump that changed nothing does not
  // rebuild it. Set by selectHit, cleared by display() so that every other scene (a browsed vehicle, a
  // swapped shooter) counts as “not the recorded hit”.
  var currentHitKey=null;
  // The five parts of the layout pass (scheduleLayout, near the end of this file): the heading row, the toolbar
  // row, the modifier groups over the scene, the pose tile and the characteristics panel (23.09). A caller that
  // changed one of them asks for that one; no mask is all of them. Declared up here so a call made while the
  // module is still starting sees them.
  var LAYOUT_HEADING=1,LAYOUT_TOOLBAR=2,LAYOUT_MODS=4,LAYOUT_POSE=8,LAYOUT_TTX=16,LAYOUT_ALL=31;
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
  // Which of the candidates the page assumed when the record does not say (22.09); -1 when it does say, or
  // when the assumption is the bare type rather than one of the shooter's shells.
  var shellAssumed=-1,shellAssumedWhy='';
  function prepareShell(hit){
    // A swapped view has no shot and therefore no shells: keep the shell that is on screen - type,
    // penetration and calibre - instead of falling back to the empty manual defaults. A browsed vehicle and a
    // shooter picked from the roster do carry a gun of their own, so they take their own shells instead.
    var browsing=!!(hit&&(hit.vehicle||hit.chosenShooter)),keep=null;
    if(hit&&hit.synthetic&&!browsing){var was=$('shell-choice').value,c0=was.indexOf('saved:')===0?candidates[Number(was.slice(6))]:null;
      keep={kind:c0?c0.kind:was||'ARMOR_PIERCING',penetration:$('penetration').value,caliber:$('caliber').value,alpha:$('alpha').value};}
    activeHit=hit;shotContext=ArmorShotContext.resolve(hit,hit&&hit.vehicle?[]:(current&&current.shotEvents||[]));candidates=shotContext.choices;var choice=$('shell-choice');choice.replaceChildren();
    // The list is the one place a word is needed: the five switchers' two sets share the shell's name,
    // calibre, penetration and speed, so without the mode two entries would read exactly alike.
    candidates.forEach(function(c,i){var mode=ArmorShotContext.modeLabel?ArmorShotContext.modeLabel(hit,c):'';
      var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name+(mode?' · '+mode:'')+(c.gunInstallation>0?' · ability gun':''));o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — manual');o.value=kind;choice.appendChild(o);});
    // Nothing determined (139 of 4284 recorded hits, 22.09): the model used to stay grey, which tells the user
    // nothing (owner, 22.09). It is coloured with the likeliest shell instead - one of the shooter's own of the
    // type the hit names, or, when his list holds none of that type, the type itself on manual figures. Every
    // place this shell is shown says "assumed"; it is never counted as the shell that actually flew.
    shellAssumed=-1;shellAssumedWhy='';
    if(shotContext.index>=0)choice.value='saved:'+shotContext.index;
    else{
      var guess=ArmorShotContext.assume?ArmorShotContext.assume(candidates,shotContext.kind,hit&&hit.damage,shotContext.range,shotContext.mark):{index:-1,reason:''};
      shellAssumed=guess.index;shellAssumedWhy=guess.reason||'';
      // Why the record could not name the shell comes before how the page picked one: the two reasons the
      // resolver knows (22.09) are worth more than "the deepest penetration" - the shot's own ballistics
      // fit no shell the shooter carries, or the vehicle switches its shell parameters and the record does
      // not say which state was on.
      if(shotContext.unresolvedWhy)shellAssumedWhy=shotContext.unresolvedWhy+(guess.reason?', and of the rest '+guess.reason:'');
      choice.value=guess.index>=0?'saved:'+guess.index:shotContext.kind||'ARMOR_PIERCING';
    }
    // A browsed vehicle has no hit to identify a shell, so resolve() leaves the index at -1. The shooter's own
    // list is nevertheless the right set of choices: preselect the first AP-like shell so the model is coloured
    // the moment a vehicle is picked, instead of “pick a shell”.
    if(browsing&&candidates.length){var first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING';});
      if(first<0)first=candidates.findIndex(function(c){return c.kind==='ARMOR_PIERCING_CR';});if(first<0)first=0;choice.value='saved:'+first;shellAssumed=-1;}
    // P2/P4 (22.09): a shooter whose vehicle is built twice brings both sets of shells. The chip of a
    // second-mode shell carries ◐ beside the ● of the shell that flew and the ◌ of an assumed one - no
    // new words on the tile; the client's own name for the state (straight / angled armour, no screen /
    // screen, the Gorilla's low charge) and what it means are in the tooltip.
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,assumed=i===shellAssumed,
      second=c.vehicleMode===1,mode=ArmorShotContext.modeLabel?ArmorShotContext.modeLabel(hit,c):'',
      b=node('button',(actual?'● ':assumed?'◌ ':'')+(second?'◐ ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100)+(c.gunInstallation>0?' ✦':''),'shell-chip');
      b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' mm · '+(c.gunInstallation>0?'ability gun'+(c.gun?' '+c.gun:'')+' · ':'')
        +(mode?mode+' · ':'')
        +(actual?(second?'The shooter fired in his second mode; the client’s numbers for that mode are used':'Type from the hit')
          :assumed?'Assumed: the record does not say which shell it was'+(shellAssumedWhy?', so '+shellAssumedWhy+' was taken':'')
          :second?'The same gun in the vehicle’s second mode':'Compare with this shell')
        // The live state of the shooter's gun at the shot, one short line per mechanic the record carries
        // (22.09). It belongs to the shot, not to one shell, so every chip of this hit says the same.
        +((shotContext.gunNotes||[]).length?' · '+shotContext.gunNotes.join(' · '):'');
      b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    paintGunShells();
    syncTargetMods(hit);syncShooterMods(hit);
    if(keep){choice.value=keep.kind;manualPen=keep.penetration;manualAlpha=keep.alpha;$('penetration').value=keep.penetration;$('caliber').value=keep.caliber;$('alpha').value=keep.alpha;penLabel(false);updateShell();}
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
  var shooterType = '';
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
    magazineReload: 'the reload of the whole magazine - never the interval between its rounds, and not on an autoloader',
    crewLevel: 'crew levels, which tighten the circle and the aiming time, shorten the reload and speed the turret up',
    // The inputs the characteristics panel reads (23.09, spec 3.3): nothing in the circle moves with them.
    enginePower: 'the engine power, on the characteristics panel',
    speedForward: 'km/h on the top speed, which makes the movement term BIGGER, not smaller',
    speedBackward: 'km/h on the reverse speed',
    visionFactor: 'the view range',
    visionStill: 'the view range while the vehicle stands still, in place of the optics',
    visionBoost: 'the view range',
    eagleEye: 'the commander’s view factor',
    finder: 'the view range, on top of everything else',
    invisibilityStill: 'the concealment while standing still (this vehicle’s own figure where its characteristics file has it; with an exhaust fitted the larger of the two counts)',
    invisibilityAdd: 'the concealment, moving or standing',
    terrainResistance: 'the terrain resistance, so the hull turns faster',
    mediumGround: 'the medium ground’s resistance',
    softGround: 'the soft ground’s resistance, brought down to the medium one',
    healthFactor: 'the hit points'};
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
  // The words the locked tiles carry.
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
    autoreload: 'an autoreloading magazine: every spent round loads back on its own timer, one at a time. Under ✸ with real reload ◔ the emulation runs those timers; otherwise a hold fires the rounds at the clip interval and nothing loads back',
    clip: 'a magazine: the rounds go at the clip interval, then the whole clip reloads. Under ✸ with real reload ◔ the emulation runs that reload; otherwise a burst stops when the clip is empty',
    burst: 'a burst gun: one pull of the trigger fires several rounds. Under ✸ one press fires the whole burst, and every round but the last widens the circle by the burst’s own factor, as the game does',
    dualGun: 'a dual gun: its barrels fire one at a time or together as a charged volley. The emulation fires single rounds only',
    twinGun: 'a twin gun: two barrels, each with its own reload. The emulation fires single rounds only',
    autoShoot: 'an automatic gun: it fires while the trigger is held and the circle grows with every round. Under ✸ the growth is the game’s own - the n-th round of a hold adds n × its per-round figure, up to the cap, and the release lets the circle settle; the pause the server may keep after the last round is not modelled',
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
  var AIM_GUN_LOAD_TITLE = 'The gun’s reload, as the reticle shows it in the game: the time left while the next round is loading, the gun’s own reload time at rest. The rounds are in the magazine beside it.';
  function paintAimMechanics() {
    var time = $('aim-gun-reload'), load = time && time.parentNode;
    if (!load) return;
    var a = aimBlockData(), kind = aimMechanics(a), extra = '';
    if (kind) extra = ' This gun is ' + AIM_MECHANICS_WORDS[kind] + '.';
    if (kind === 'autoreload' && a.autoreload && Array.isArray(a.autoreload.reloadTime)) {
      // The client keeps the tuple last-round-first and the garage shows it reversed, in loading order (KNOWLEDGE §4).
      extra += ' Its rounds load back in, from an empty magazine: ' + a.autoreload.reloadTime.slice().reverse().map(function (v) { return aimNum(v); }).join(', ') + ' s.';
    }
    if (a && (a.dualAccuracy || (Array.isArray(a.gunTags) && a.gunTags.indexOf('dualAccuracy') >= 0))) {
      // B3: the factor is the client's; how long it lasts is not in the client (the server switches it).
      var dual = dualParams(a);
      extra += dual ? ' It has dual accuracy: after a shot the game widens the whole circle ×' + aimNum(dual.factor) +
        ' (' + aimNum(Math.round(a.dualAccuracy.afterShotDispersionAngle * 1e5) / 1e3) + ' against ' + aimNum(Math.round(a.dispersion * 1e5) / 1e3) +
        ' m at 100 m). Under ✸ the emulation applies it for ' + aimNum(dual.delay) + ' s after every round - that length is this page’s assumption.'
        : ' It has dual accuracy: the circle right after a shot follows a law of its own, which this record does not carry the numbers of.';
    }
    if (a && Array.isArray(a.gunMechanics) && a.gunMechanics.indexOf('chargeableBurst') >= 0) {
      extra += ' Its burst comes only in the Burst mode of its chargeableBurst: under ✸ the mode button beside this switches it.';
    }
    if (a && a.secondaryFrom) extra += ' This is the vehicle’s second gun, taken up with the ✸ mode button.';
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
  // Concealment, the other skill every tankman learns for himself (23.09), and the paint - a switch of its own.
  var AIM_CAMO = SKILL_BY_ID.camouflage || null, AIM_PAINT = CATALOGUE.paint || null;
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
  // CONCEALMENT (23.09, spec 3.3 point 3) is the same law on the group skill `camouflage`, which the client
  // always runs: `camo` is each tankman's level of it, like `bia`, and out.camouflage = 0.57 + 0.43 x eff with
  // eff = the sum over those who have it of (level + inc) / (100 x N) - inc the same commander's-tenth rule. Nobody
  // gives 0.57 (the stock garage shows the XML concealment x 0.57), a whole five-man crew 1.0344
  // (outputs/ttx-formulas-2026-09-22.md 2.3). No new crew maths: the commander, driver and radio operator the
  // law already returned have consumers now too (the view range, the hull, the terrain).
  function crewFactors(crew, bia, levels, camo) {
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
    var hidden = 0;
    for (i = 0; i < n; i++) {
      var lvl = camo ? Math.max(0, Math.min(100, Number(camo[i]) || 0)) : 0;
      if (lvl > 0) hidden += (lvl + (crew[i][0] === 'commander' ? common : others)) / (100 * n);
    }
    out.camouflage = 0.57 + 0.43 * hidden;
    return out;
  }
  // The factors of the shooter on screen, with the configuration on screen (or `cfg`) and `levels` added crew levels.
  function aimCrewFactors(levels, cfg) {
    // Crew skills the vehicle's own lockCrewSkills fixes (S3) are not the user's to give: nobody has Brothers
    // in Arms then, and the crew is the plain trained one.
    cfg = cfg || shooterConfig;
    var crew = aimCrew(), keys = aimCrewKeys(crew), locked = aimForbidden('crew');
    return crewFactors(crew, keys.map(function (k) { return !locked && cfg.bia[k] ? 100 : 0; }), levels,
                       keys.map(function (k) { return !locked && cfg.camo && cfg.camo[k] ? 100 : 0; }));
  }
  // --- The configuration object -----------------------------------------------------------------
  // {slots: [device id, '', ''],      one device id per optional-device slot, '' = empty
  //  directive: '',                   one directive id
  //  food: false, fuel: '',           the consumables
  //  skills: {gunner_smoothTurret: true},  the crew skills and perks that are on, Brothers in Arms apart
  //  bia: {commander: true, gunner: true},  the crew members who have Brothers in Arms, by aimCrewKeys()
  //  camo: {gunner: true},             the crew members who have Concealment, the same way (23.09)
  //  paint: false}                     a camouflage painted on, which adds the vehicle's own bonus (23.09)
  // The two keys of 23.09 did not change the store's version either, as `bia` and `custom` did not: an older
  // page does not read them, and a store without them has nobody with Concealment and no paint.
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
  // Neither did Custom (user, 22.09): the user's own working build, where every hand edit lands - never in a
  // preset, so a mis-click cannot damage a saved one. It is kept as `custom`, ONE BUILD PER VEHICLE TYPE, in
  // the shape of a stored preset, and an older page ignores the key. Per vehicle because a hand build belongs
  // to the gun it was made for: with one Custom shared by every shooter, an edit made on the next one would
  // write over it without a word, and the first would come back wearing the second's equipment - the very
  // loss Custom exists to end. A store without the key (an older page's) starts Custom empty: that page never
  // kept a hand build, only the name of a preset the build happened to match. A store holding ONE build under
  // the key gives it to every vehicle whose chosen entry is Custom, so nothing made by hand is lost.
  var aimStore = {presets: {}, chosen: {}, custom: {}, pairs: {}, modes: {}};
  var AIM_CUSTOM = 'Custom';   // the entry's name, which no preset of the user's may take
  var shooterFit = null;
  // shooterPreset is the entry in force: Custom, a built-in build or one of the user's presets - always one of them.
  var shooterConfig = aimValues(null), shooterPreset = '';
  // The one door every configuration comes through, wherever it came from - a preset, the store, a
  // click or a built-in build. A device the vehicle cannot mount and a device whose archetype another
  // slot already holds are both dropped here and nowhere else.
  function aimValues(base) {
    var out = {slots: ['', '', ''], directive: '', food: false, fuel: '', skills: {}, bia: {}, camo: {}, paint: false};
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
    // Concealment is kept exactly like Brothers in Arms: skills.camouflage for the whole crew, a map for some.
    if (flag(skills.camouflage)) aimCrewKeys(aimCrew()).forEach(function (k) { out.camo[k] = true; });
    else if (base.camo && typeof base.camo === 'object') Object.keys(base.camo).forEach(function (k) {
      if (AIM_MEMBER_KEY.test(k) && flag(base.camo[k])) out.camo[k] = true;
    });
    out.paint = flag(base.paint) || base.paint === 1;
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
    // Concealment and the paint are written only when set, so a preset without them keeps its old shape.
    var camo = {}, hid = false;
    Object.keys(cfg.camo || {}).sort().forEach(function (k) { if (cfg.camo[k]) { camo[k] = true; hid = true; } });
    if (keys.length && keys.every(function (k) { return camo[k]; })) skills.camouflage = true;
    else if (hid) out.camo = camo;
    if (cfg.paint) out.paint = true;
    return out;
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
    if (name === AIM_CUSTOM) return aimValues(aimStore.custom[shooterType]);
    var built = aimBuiltIn(name);
    if (built) return aimValues(built.values);
    return aimStore.presets[name] ? aimValues(aimStore.presets[name]) : null;
  }
  function aimUserNames() { return Object.keys(aimStore.presets).sort(); }
  // Every entry of the preset list, in its order: Custom, the built-in builds, the user's own.
  function aimEntryNames() {
    return [AIM_CUSTOM].concat(AIM_BUILT_IN.map(function (p) { return p.name; }), aimUserNames());
  }
  // "custom" in any case: a preset of that name would read as the entry itself.
  function aimReserved(name) { return String(name).toLowerCase() === AIM_CUSTOM.toLowerCase(); }
  // `base` and the first number `taken` says is free: "Build 1", "Build 2" ...
  function aimFreeName(base, taken) {
    for (var n = 1; ; n++) if (!taken(base + ' ' + n)) return base + ' ' + n;
  }
  // A name the user typed and a preset read back from storage are both data, never markup: they only
  // ever become the text of a list row or of a field, and both are length-capped.
  function aimName(raw) { return String(raw === undefined || raw === null ? '' : raw).trim().slice(0, AIM_NAME_LIMIT); }
  // What came back from localStorage is checked field by field: an unknown key is dropped, an item the
  // catalogue does not know falls away, and a name that collides with a built-in preset is refused, so
  // a corrupted or hand-edited store can never put the page in a state it cannot show.
  function adoptAimStore(box) {
    if (!box || typeof box !== 'object') return;
    aimStore = {presets: {}, chosen: {}, custom: {}, pairs: {}, modes: {}};
    if (Number(box.v) !== 3) return;
    // `modes` (23.09): the vehicles whose characteristics panel shows the second mode, off ✸ - 1 or nothing.
    if (box.modes && typeof box.modes === 'object') Object.keys(box.modes).forEach(function (type) {
      if (box.modes[type] === 1) aimStore.modes[String(type).slice(0, 64)] = 1;
    });   // 0.7.15 presets held kinds and variants, not client entries
    if (box.pairs && typeof box.pairs === 'object') Object.keys(box.pairs).forEach(function (type) {
      var key = String(box.pairs[type] || '').slice(0, 160);
      if (/^[^|]+\|[^|]+$/.test(key)) aimStore.pairs[String(type).slice(0, 64)] = key;
    });
    // A store written before Custom existed has no `custom` key, and in it a preset named "Custom" was the
    // user's own: it keeps its build under a free name, and the vehicles that had it chosen follow it there.
    var legacy = !Object.prototype.hasOwnProperty.call(box, 'custom');
    var presets = {}, chosen = {}, moved = {}, count = 0;
    function taken(name) { return !!presets[name] || Object.prototype.hasOwnProperty.call(box.presets, name); }
    if (box.presets && typeof box.presets === 'object') Object.keys(box.presets).forEach(function (key) {
      var name = aimName(key), row = box.presets[key];
      if (!name || aimBuiltIn(name) || !row || typeof row !== 'object' || count >= AIM_PRESET_LIMIT) return;
      if (aimReserved(name)) { var free = aimFreeName('My ' + name, taken); moved[name] = free; name = free; }
      presets[name] = aimStoredPreset(row); count++;
    });
    if (box.chosen && typeof box.chosen === 'object') Object.keys(box.chosen).forEach(function (type) {
      var name = aimName(box.chosen[type]);
      if (legacy && moved[name]) name = moved[name];
      if (name && (name === AIM_CUSTOM || aimBuiltIn(name) || presets[name])) chosen[String(type).slice(0, 64)] = name;
    });
    aimStore.presets = presets; aimStore.chosen = chosen;
    // Custom is a build per vehicle type. A store that holds ONE build under the key - the first shape of it,
    // recognised by its own `slots` array - gives that build to every vehicle whose chosen entry is Custom.
    if (box.custom && typeof box.custom === 'object') {
      if (Array.isArray(box.custom.slots)) {
        var one = aimStoredPreset(box.custom);
        Object.keys(chosen).forEach(function (type) { if (chosen[type] === AIM_CUSTOM) aimStore.custom[type] = one; });
      } else Object.keys(box.custom).forEach(function (key) {
        var type = String(key).slice(0, 64), row = box.custom[key];
        if (type && row && typeof row === 'object') aimStore.custom[type] = aimStoredPreset(row);
      });
    }
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
    if (flag(skills.camouflage)) out.skills.camouflage = true;
    else if (row.camo && typeof row.camo === 'object') {
      var camo = {}, hid = false;
      Object.keys(row.camo).sort().forEach(function (k) {
        if (AIM_MEMBER_KEY.test(k) && flag(row.camo[k])) { camo[k] = true; hid = true; }
      });
      if (hid) out.camo = camo;
    }
    if (flag(row.paint)) out.paint = true;
    return out;
  }
  // `pairs` (23.09): the turret and gun the characteristics panel was last set to, per vehicle type, as
  // "turretName|gunName" - written only once there is one, so a store without it keeps its old shape.
  function aimStored() {
    var out = {v: 3, presets: aimStore.presets, chosen: aimStore.chosen, custom: aimStore.custom};
    if (Object.keys(aimStore.pairs).length) out.pairs = aimStore.pairs;
    if (Object.keys(aimStore.modes).length) out.modes = aimStore.modes;
    return out;
  }
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
  function aimDirectiveLevel(dir, cfg) {
    if (!dir || !dir.levels) return null;
    cfg = cfg || shooterConfig;
    for (var i = 0; i < dir.levels.length; i++) {
      for (var s = 0; s < AIM_SLOTS.length; s++) {
        var dev = DEVICE_BY_ID[cfg.slots[s]];
        if (dev && aimLevelFits(dir.levels[i], aimDeviceTags(dev))) return dir.levels[i];
      }
    }
    return null;
  }
  // A crew directive multiplies the boosted skill's TRAINED LEVEL, which doubles that skill's
  // deviation from 1: Snap Shot's x0.925 at skillMult 2 becomes x0.85. It reaches the maths only
  // through a skill that is switched on - what the client grants a crew member who never learned the
  // skill is not in the data (report section 7), so the page does not invent a level for it.
  function aimSkillMult(id, cfg) {
    if (aimForbidden('devices') || aimForbidden('crew')) return 1;   // no directive, or no skill, is in force (S3)
    cfg = cfg || shooterConfig;
    var dir = DIRECTIVE_BY_ID[cfg.directive];
    return dir && dir.skill === id && dir.skillMult > 1 && cfg.skills[id] ? Number(dir.skillMult) : 1;
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
  // `mul`/`add` are what the emulator has always read: every factor of an input multiplied, every addition
  // summed. The SAME pass also keeps them apart the way the garage orders them (23.09, spec 3.3 point 2), for
  // the characteristics panel: `dev`/`devAdd` the devices, the directive and the consumables, `perk`/`perkAdd`
  // the crew's skills and perks, a perk's deviations from 1 SUMMED (params __calcParamWithSkillFactorAmp) - the
  // garage rounds after the devices and applies the perks last. `devices` are the fitted pieces in force and
  // `weight` their mass in kg, which the garage adds to the vehicle's. `cfg` is shooterConfig unless said.
  function aimEffects(cfg) {
    cfg = cfg || shooterConfig;
    var mul = {}, add = {}, dev = {}, devAdd = {}, perk = {}, perkAdd = {}, fitted = [], weight = 0;
    function apply(input, eff, skill) {
      if (!eff) return;
      var v = Number(eff[1]);
      if (!isFinite(v)) return;
      if (eff[0] === 'add') {
        add[input] = (add[input] || 0) + v;
        if (skill) perkAdd[input] = (perkAdd[input] || 0) + v; else devAdd[input] = (devAdd[input] || 0) + v;
      } else {
        mul[input] = (mul[input] === undefined ? 1 : mul[input]) * v;
        if (skill) perk[input] = (perk[input] || 0) + (v - 1); else dev[input] = (dev[input] === undefined ? 1 : dev[input]) * v;
      }
    }
    var devices = !aimForbidden('devices');
    if (devices) AIM_SLOTS.forEach(function (i) {
      var piece = DEVICE_BY_ID[cfg.slots[i]];
      if (!piece) return;
      fitted.push(piece); weight += Number(piece.weight) || 0;
      Object.keys(piece.eff).forEach(function (input) {
        apply(input, [piece.eff[input][0], aimEffValue(piece.eff[input])], false);
      });
    });
    if (!aimForbidden('crew')) AIM_SKILLS.forEach(function (s) {
      if (!cfg.skills[s.id]) return;
      var mult = aimSkillMult(s.id, cfg);
      Object.keys(s.eff).forEach(function (input) { apply(input, aimBoost(s.eff[input], mult), true); });
    });
    var level = devices ? aimDirectiveLevel(DIRECTIVE_BY_ID[cfg.directive], cfg) : null;
    if (level && level.eff) Object.keys(level.eff).forEach(function (input) { apply(input, level.eff[input], false); });
    if (!aimForbidden('consumables')) AIM_CONSUMABLES.forEach(function (c) {
      if (!(c.slot === 'food' ? cfg.food : cfg.fuel === c.id)) return;
      Object.keys(c.eff).forEach(function (input) { apply(input, c.eff[input], false); });
    });
    return {mul: mul, add: add, dev: dev, devAdd: devAdd, perk: perk, perkAdd: perkAdd, devices: fitted, weight: weight,
            paint: !!cfg.paint};
  }
  function aimMul(e, input) { return e.mul[input] === undefined ? 1 : e.mul[input]; }
  function aimAdd(e, input) { return e.add[input] === undefined ? 0 : e.add[input]; }
  // The multipliers of the shooter's configuration, each named after the client attribute it
  // multiplies. The gunner and the loader each have their own crew factor: the law is the same, but a
  // role the commander holds himself gets no commander's tenth (crewFactors above).
  // ONE COMPUTATION PER CHANGE (23.09, spec 3.3 point 1). The effects, the crew and these modifiers are taken
  // once per revision of the configuration - aimRev goes up in aimConfigChanged() and syncShooterMods(), the
  // only two doors a change comes through - and per shooter block, and the frame loop, the gun panel and the
  // characteristics panel all read that one result. The stock of the garage (no equipment, the plain trained
  // crew) is the same functions on aimValues(null), taken once per shooter (shooterRev).
  var aimRev = 0, shooterRev = 0, fxMemo = {build: null, stock: null};
  function shooterEffects(stock) {
    var a = aimBlockData(), slot = stock ? 'stock' : 'build', m = fxMemo[slot];
    var rev = stock ? shooterRev : aimRev;
    if (m && m.a === a && m.rev === rev) return m.value;
    var cfg = stock ? aimValues(null) : shooterConfig, e = aimEffects(cfg);
    var crew = aimCrewFactors(aimAdd(e, 'crewLevel'), cfg);
    fxMemo[slot] = {a: a, rev: rev, value: {e: e, crew: crew, mods: aimModsOf(e, crew)}};
    return fxMemo[slot].value;
  }
  // A copy, because a caller may scale it for the moment (aimHeated multiplies the band of an Ares gun in).
  function aimModifiers() {
    var m = shooterEffects(false).mods, out = {};
    Object.keys(m).forEach(function (k) { out[k] = m[k]; });
    return out;
  }
  function aimModsOf(e, crew) {
    var g = crew.gunner, l = crew.loader;
    return {mult: aimMul(e, 'multFactor') / g,             // multShotDispersionFactor and the gunner
            additive: aimMul(e, 'additiveFactor'),         // additiveShotDispersionFactor: the stabiliser
            movement: aimMul(e, 'movementFactor'),         // chassis/shotDispersionFactors/movement
            rotation: aimMul(e, 'rotationFactor'),         // chassis/shotDispersionFactors/rotation
            turret: aimMul(e, 'turretRotationFactor'),     // gun/shotDispersionFactors/turretRotation
            aimingTime: aimMul(e, 'aimingTimeFactor') / g, // gunAimingTimeFactor and the gunner
            reload: aimMul(e, 'reloadTimeFactor') / l,     // gunReloadTimeFactor and the loader
            turretSpeed: aimMul(e, 'turretRotationSpeed') * g,  // miscAttrs/turretRotationSpeed
            hullSpeed: aimMul(e, 'hullRotationSpeed'),     // Clutch Braking and the hull part of the rotation mechanism
            magazineReload: aimMul(e, 'magazineReload'),   // Mag Mastery: the whole magazine (ballistics.js reloadSeconds)
            // forwardMaxSpeedKMHTerm / backwardMaxSpeedKMHTerm are km/h; the record holds m/s. A
            // turbocharger raises the cap the WASD model accelerates to, so the circle gets BIGGER.
            speedForwardAdd: aimAdd(e, 'speedForward') * KMH_TO_MS,
            speedBackwardAdd: aimAdd(e, 'speedBackward') * KMH_TO_MS};
            // enginePower has no home in the circle's model: the movement term reads the speed cap, not the
            // power that gets there. The characteristics panel reads it (web/ttx.js).
            // The driving ramps are constants in ballistics.js now (user, 20.09: no seconds in the UI).
  }
  // One place every change of the configuration goes through, wherever it came from - an edit, a preset
  // chosen, the start: the popover is repainted and the circle is recomputed.
  function aimConfigChanged() {
    aimRev++;
    paintAimConfig(true);   // a click inside the open popover: its tiles depend on one another, all are redrawn
    // A different build is a different vehicle, not a moment in the life of this one: the running
    // exponential is dropped and the circle is rebuilt for the new modifiers, so the answer to "what
    // would a stabiliser do here" is on screen at once instead of waiting for the next frame.
    // Its figure goes with it: the 120 ms pace of the coarse estimate is for a ring that moves, not for a
    // new one, so it is taken at once, and the loop is woken to take the fine one when the ring rests -
    // a second click inside 120 ms used to leave the figure of the ring before it on the panel.
    aimNow = null; aimEstAt = 0; aimEstFine = false;
    updateAim(); startAimLoop(); scheduleLayout();
    ttxPaint();   // the characteristics panel shows the new build (an event, never a frame)
  }
  // A hand edit - any tile, chip or slot: it lands in Custom, which becomes the entry in force for this
  // shooter and is kept at once. The preset it started from is left as it was.
  function aimEdited() {
    aimStore.custom[shooterType] = aimPresetValues(shooterConfig);
    shooterPreset = AIM_CUSTOM;
    if (shooterType) aimStore.chosen[shooterType] = AIM_CUSTOM;
    persistSettings();
    aimConfigChanged();
  }
  // An entry of the preset list put in force. Custom is only read here, never written: going to another
  // preset and back gives the hand build back.
  function aimChoose(name) {
    var values = aimPreset(name);
    if (!values) return;
    shooterConfig = values; shooterPreset = name;
    if (shooterType) aimStore.chosen[shooterType] = name;
    persistSettings();
    aimConfigChanged();
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
    if (shooterConfig.paint && AIM_PAINT) out.push(AIM_PAINT.name);
    if (!aimForbidden('crew')) {
      var keys = aimCrewKeys(aimCrew()), have = keys.filter(function (k) { return !!shooterConfig.bia[k]; }).length;
      if (have) out.push('Brothers in Arms' + (have < keys.length ? ' (' + have + ' of ' + keys.length + ')' : ''));
      var hid = keys.filter(function (k) { return !!(shooterConfig.camo && shooterConfig.camo[k]); }).length;
      if (hid && AIM_CAMO) out.push(AIM_CAMO.name + (hid < keys.length ? ' (' + hid + ' of ' + keys.length + ')' : ''));
      var skills = AIM_SKILLS.filter(function (s) { return !!shooterConfig.skills[s.id]; });
      if (skills.length) out.push(skills.map(function (s) { return s.name; }).join(', '));
    }
    return out.length ? out.join(' · ') : 'nothing fitted';
  }
  function aimDirectiveActive(dir) {
    if (!dir) return false;
    return dir.skill ? aimSkillMult(dir.skill) > 1 : !!aimDirectiveLevel(dir);
  }
  // A new shooter on screen gets the entry he was last given, remembered across launches per vehicle type
  // (aimStore.chosen), and the stock build when he has none - or when his preset has been deleted since.
  // The entry is applied again every time, and Custom is this vehicle's own hand build: what was made by hand
  // on another shooter stays his, and comes back with him.
  function syncShooterMods(hit) {
    var a = hit && hit.attacker || null, type = a && a.type ? String(a.type) : '';
    // A different shooter is a different gun: the running exponential, the shot fired and the reload
    // belong to the one that has just left the screen and would otherwise be read as this one's.
    var changed = type !== shooterType;
    shooterType = type;
    aimRev++; shooterRev++;
    // What he may mount is read before anything is normalised: aimValues drops a device this vehicle
    // cannot take, and it has to know which vehicle that is. So is what the battle and the vehicle's own
    // locks allow (S3): it decides which kinds of the configuration are applied at all.
    shooterFit = aimFitment(a);
    shooterPolicy = aimPolicyFor(hit);
    paintAimMechanics();
    var name = type && aimStore.chosen[type] ? aimStore.chosen[type] : '';
    var values = name ? aimPreset(name) : null;
    if (!values) { name = AIM_BUILT_IN[0].name; values = aimPreset(name); }
    shooterConfig = values; shooterPreset = name;
    if (changed) resetAimRun();
    paintAimConfig();
    ttxSync(hit);   // the characteristics panel follows the shooter (read once per type, painted here)
  }
  // --- The Configuration popover ----------------------------------------------------------------
  // The one editor of the configuration, on the page's own popover mechanism: a <details> with a
  // .toolbar-popover, closed by the document click handler like every other one. It hangs under the
  // Shooter tile, so it opens upward. The preset row, then four sections in the garage's own order:
  // Equipment, Directive, Consumables, Crew.
  // SUB-PANELS ARE A LAYER OF THEIR OWN (user, 22.09): the equipment picker, the directive picker and the
  // preset list open OVER the popover, on a light scrim, and the element they belong to - the slot row, the
  // preset control - is lifted above the scrim and lit (its aria-expanded, in the stylesheet). No heading:
  // the lit element says what the panel is for. aimLayer is which one is open: 'slot0'..'slot2',
  // 'directive', 'presets' or ''.
  var aimConfigControls = {}, aimLayer = '';
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
    // Every device of the client is offered since 23.09: one whose effect the page does not model still weighs
    // something, and the characteristics panel counts that mass.
    var weight = Number(dev.weight) > 0 ? ' It weighs ' + aimNum(dev.weight) + ' kg, which the characteristics panel adds to the vehicle.' : '';
    return dev.name + ' · ' + (tier.name || dev.tier) + (fam.what ? ' · it ' + fam.what : '')
      + ' · ' + (parts.length ? parts.join('; ') + '.' : 'its effect is not shown here; its weight counts.') + weight
      + ' (optional_devices.xml ' + dev.id + ')';
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
    tile.setAttribute('aria-expanded', String(aimLayer === key));
    var what = 'Slot ' + (index + 1) + '. ';
    tile.title = dev ? what + aimDeviceTitle(dev) + ' Click to change it, or to take it out.'
                     : what + 'Empty. Click to fit a piece of equipment.';
    tile.setAttribute('aria-label', what + (dev ? dev.name : 'Empty'));
    tile.appendChild(dev ? aimIcon(dev.icon, aimShort((FAMILY_BY_ID[dev.family] || {}).name || dev.name),
                                   aimDeviceBadge(dev))
                         : aimIcon('empty_slot', '—'));
    tile.onclick = function (e) { e.stopPropagation(); aimOpenLayer(key); };
    return tile;
  }
  // A click on the element a sub-panel belongs to: its panel opens, or closes when it is the one open. A
  // click on another slot of the lifted row moves the panel - and the light - to that slot.
  function aimOpenLayer(key) {
    if (aimForbidden('devices') && key !== 'presets') key = '';   // nothing to pick for a vehicle whose devices the game fixes (S3)
    var next = aimLayer === key ? '' : key;
    aimDropLayer(!next); aimLayer = next;
    paintAimConfig(true);
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
    aimDropLayer(true);   // fitting the slot is the picker's whole job
    aimEdited();
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
    tile.setAttribute('aria-expanded', String(aimLayer === 'directive'));
    tile.title = dir ? aimDirectiveTitle(dir) + ' Click to change the directive, or to take it out.'
                     : 'The directive slot, empty. Click to fit one.';
    tile.setAttribute('aria-label', 'Directive. ' + (dir ? dir.name : 'Empty'));
    tile.appendChild(dir ? aimIcon(dir.icon, aimShort(dir.name)) : aimIcon('empty_slot', '—'));
    tile.onclick = function (e) { e.stopPropagation(); aimOpenLayer('directive'); };
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
    aimDropLayer(true);
    aimEdited();
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
        aimEdited();
      }, false);
      row.appendChild(aimForbidden('consumables') ? aimLockTile(chip, 'consumables', c.name + '. ') : chip);
    });
    // The paint (23.09): not a consumable, but a switch of the vehicle's look that the garage counts - one tile
    // beside them rather than a section of its own.
    if (AIM_PAINT) row.appendChild(aimChip(AIM_PAINT.icon, AIM_PAINT.name,
      AIM_PAINT.name + ' · ' + AIM_PAINT.note + ' It moves nothing in the circle; the characteristics panel shows it.',
      !!shooterConfig.paint, function () { shooterConfig.paint = !shooterConfig.paint; aimEdited(); }, false));
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
      aimEdited();
    }, false);
  }
  // Concealment, one tile per crew member after his Brothers in Arms (23.09): the same kind of skill, the same
  // widget. What one member is worth is the tooltip's job.
  function aimCamoTitle(crew, keys, i) {
    var n = crew.length, have = keys.filter(function (k) { return !!(shooterConfig.camo && shooterConfig.camo[k]); }).length;
    var f = aimCrewFactors(aimAdd(shooterEffects(false).e, 'crewLevel')).camouflage;
    return AIM_CAMO.name + ' · ' + aimMemberName(crew, keys, i) + ' · ' + (AIM_CAMO.note || '') + '. Now ' + have + ' of ' + n
      + ': the concealment factor is ' + aimNum(f) + '. It moves nothing in the circle; the characteristics panel shows it.'
      + ' (tankmen.xml camouflage; VehicleDescrCrew)';
  }
  function aimCamoTile(crew, keys, i) {
    var key = keys[i];
    return aimChip(AIM_CAMO.icon || AIM_CAMO.id, AIM_CAMO.name + ', ' + aimMemberName(crew, keys, i),
                   aimCamoTitle(crew, keys, i), !!(shooterConfig.camo && shooterConfig.camo[key]), function () {
      if (!shooterConfig.camo) shooterConfig.camo = {};
      if (shooterConfig.camo[key]) delete shooterConfig.camo[key];
      else shooterConfig.camo[key] = true;
      aimEdited();
    }, false);
  }
  function aimCrewSection(body) {
    var crew = aimCrew(), keys = aimCrewKeys(crew), locked = aimForbidden('crew');
    AIM_ROLES.forEach(function (role) {
      var rows = AIM_SKILLS.filter(function (s) { return s.role === role.id; });
      var members = [];
      if (AIM_BIA || AIM_CAMO) crew.forEach(function (roles, i) { if (roles[0] === role.id) members.push(i); });
      if (!rows.length && !members.length) return;
      body.appendChild(node('div', role.name, 'aim-role'));
      var chips = node('div', undefined, 'aim-chips');
      members.forEach(function (i) {
        if (AIM_BIA) {
          var tile = aimBiaTile(crew, keys, i);
          chips.appendChild(locked ? aimLockTile(tile, 'crew', 'Brothers in Arms, ' + aimMemberName(crew, keys, i) + '. ') : tile);
        }
        if (AIM_CAMO) {
          var camo = aimCamoTile(crew, keys, i);
          chips.appendChild(locked ? aimLockTile(camo, 'crew', AIM_CAMO.name + ', ' + aimMemberName(crew, keys, i) + '. ') : camo);
        }
      });
      rows.forEach(function (s) {
        var chip = aimChip(s.icon || s.id, s.name, aimSkillTitle(s), !!shooterConfig.skills[s.id], function () {
          if (shooterConfig.skills[s.id]) delete shooterConfig.skills[s.id];
          else shooterConfig.skills[s.id] = true;
          aimEdited();
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
    // The sections scroll in a box of their own, so the layer over them - the scrim and a sub-panel - stays
    // over the popover wherever they are scrolled to. While a sub-panel is open they do not scroll (the one
    // wheel handler of the popover, at the foot of this file): the wheel on the lifted row would pull it away
    // from the panel under it.
    var main = node('div', undefined, 'aim-config-main');
    // The second click of a double-click that closed a sub-panel falls on whatever lay under the panel: it is
    // dropped, so a double-click on a preset or a picker tile never toggles a tile of the menu by accident.
    main.addEventListener('click', function (e) {
      if (e.detail > 1 && aimSeconds() - aimShutAt < AIM_DOUBLE_CLICK) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // Preset first: most of the time it is the only row anybody touches. One control that names the entry in
    // force: a click opens the list (aimPresetList), the arrow keys step through it without opening it.
    var grid = node('div', undefined, 'aim-config-grid');
    var preset = node('button', undefined, 'aim-preset'); preset.type = 'button'; preset.id = 'aim-cfg-preset';
    preset.setAttribute('aria-haspopup', 'true');
    preset.onclick = function () { aimOpenLayer('presets'); };
    preset.onkeydown = aimPresetKey;
    aimRow(grid, 'Preset', preset);
    main.appendChild(grid);

    main.appendChild(node('div', 'Equipment', 'aim-config-head'));
    var slots = node('div', undefined, 'aim-slots'); slots.id = 'aim-cfg-slots';
    main.appendChild(slots);
    // Nothing is written under the slots any more (user, 22.09): what that note said is in the Config
    // button's tooltip (aimConfigTitle), and a kind the vehicle's lock keeps out says why on its dimmed tiles.

    main.appendChild(node('div', 'Directive', 'aim-config-head'));
    var directive = node('div', undefined, 'aim-slots'); directive.id = 'aim-cfg-directive';
    main.appendChild(directive);

    main.appendChild(node('div', 'Consumables', 'aim-config-head'));
    var cons = node('div'); cons.id = 'aim-cfg-consumables';
    main.appendChild(cons);

    main.appendChild(node('div', 'Crew', 'aim-config-head'));
    var crew = node('div'); crew.id = 'aim-cfg-crew';
    main.appendChild(crew);
    // No "Fitted: ..." line under the crew any more (user, 21.09): the tiles above already show what is
    // fitted, and the list lives on in the Config button's own tooltip.
    body.appendChild(main);
    // The layer. A click on the scrim closes the sub-panel and nothing else: it is inside the popover.
    var scrim = node('div', undefined, 'aim-scrim'); scrim.id = 'aim-cfg-scrim'; scrim.hidden = true;
    scrim.onclick = function () { aimCloseLayer(); };
    var layer = node('div', undefined, 'aim-layer'); layer.id = 'aim-cfg-layer'; layer.hidden = true;
    var close = node('button', '×', 'aim-layer-close'); close.type = 'button';
    close.title = 'Close'; close.setAttribute('aria-label', 'Close');
    close.onclick = function () { aimCloseLayer(); };
    var picker = node('div'); picker.id = 'aim-cfg-picker'; picker.hidden = true;
    layer.appendChild(close); layer.appendChild(picker);
    body.appendChild(scrim); body.appendChild(layer);
    aimConfigControls = {body: body, main: main, preset: preset, slots: slots, directive: directive,
                         consumables: cons, crew: crew, scrim: scrim, layer: layer, picker: picker};
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
    var c = aimConfigControls;
    if (!c.preset) return;
    $('aim-config').querySelector('summary').title = aimConfigTitle();
    if (!force && !$('aim-config').open) { aimConfigDirty = true; return; }
    aimConfigDirty = false;
    if (aimForbidden('devices') && aimLayer !== 'presets') aimDropLayer();   // a picker left open on the previous shooter goes (S3)
    c.preset.textContent = shooterPreset;
    c.preset.title = aimEntryTitle(shooterPreset) + ' Click for the list; the arrow keys step through it.';
    c.preset.setAttribute('aria-expanded', String(aimLayer === 'presets'));
    c.slots.replaceChildren();
    AIM_SLOTS.forEach(function (i) { c.slots.appendChild(aimSlotTile(i)); });
    c.directive.replaceChildren();
    c.directive.appendChild(aimDirectiveTile());
    c.consumables.replaceChildren();
    c.consumables.appendChild(aimConsumableChips());
    c.crew.replaceChildren();
    aimCrewSection(c.crew);
    aimPaintLayer();
  }
  // The layer's own state beside aimLayer: the name of a preset being renamed in place ({from, draft, error})
  // and its field, the timer that closes the preset list after a click on a preset of the user's own, and
  // when a sub-panel last went (the double-click guard in buildAimConfig).
  var aimRenaming = null, aimNameInput = null, aimCloseTimer = 0, aimShutAt = -Infinity;
  var AIM_DOUBLE_CLICK = 0.5;   // s, Windows' own double-click time
  function aimCancelClose() { if (aimCloseTimer) window.clearTimeout(aimCloseTimer); aimCloseTimer = 0; }
  // The sub-panel goes; whoever calls this repaints. `shut` is "a panel really went, and the menu under it is
  // bare again": only then is the moment stamped for the double-click guard. A panel MOVED from one slot to
  // the next leaves another panel in its place, so the second click of a double-click there is the user's own.
  function aimDropLayer(shut) {
    if (aimLayer && shut) aimShutAt = aimSeconds();
    aimCancelClose(); aimLayer = ''; aimRenaming = null;
  }
  // Its ×, the scrim, Escape: the sub-panel closes and the popover stays. The preset list hands the keys back
  // to the preset control, so the arrows go on stepping through the presets.
  function aimCloseLayer() {
    if (!aimLayer) return;
    var presets = aimLayer === 'presets';
    aimDropLayer(true); paintAimConfig(true);
    if (presets) aimConfigControls.preset.focus();
  }
  // A preset of the user's own is also renamed by a double-click on its name, so a click on it leaves the list
  // up for the length of a double-click; the preset is in force at once all the same.
  function aimCloseSoon() {
    aimCancelClose();
    aimCloseTimer = window.setTimeout(function () {
      aimCloseTimer = 0;
      if (aimLayer === 'presets' && !aimRenaming) aimCloseLayer();
    }, AIM_DOUBLE_CLICK * 1000);
  }
  // The layer as aimLayer says: the scrim, the panel and its content, the owner lifted over the scrim. The
  // owner is the whole slot row, so the other slots stay clickable and move the panel to themselves.
  function aimPaintLayer() {
    var c = aimConfigControls, key = aimLayer;
    var owner = key === 'presets' ? c.preset : key === 'directive' ? c.directive : key ? c.slots : null;
    [c.preset, c.slots, c.directive].forEach(function (el) {
      if (el === owner) el.setAttribute('data-owner', 'true'); else el.removeAttribute('data-owner');
    });
    c.scrim.hidden = c.layer.hidden = c.picker.hidden = !key;
    c.picker.replaceChildren(); aimNameInput = null;
    if (!key) return;
    c.picker.appendChild(key === 'presets' ? aimPresetList()
      : key === 'directive' ? aimDirectivePicker() : aimPicker(Number(key.slice(4))));
    aimPlaceLayer(owner);
    if (aimNameInput) { aimNameInput.focus(); if (aimRenaming.draft === aimRenaming.from) aimNameInput.select(); }
  }
  // THE SUB-PANEL'S ONE PLACEMENT RULE (user, 22.09): straight under the element it belongs to, across the
  // popover's width (the stylesheet), down to the popover's bottom at most - so it never covers that element
  // and never opens above it for one slot and below it for the next. The sections are scrolled first when the
  // element is out of sight or the panel wants more room under it than there is, never past the element's own
  // top; what still does not fit scrolls inside the panel.
  function aimPlaceLayer(owner) {
    var c = aimConfigControls, edge = 8;
    var pop = c.body.getBoundingClientRect(), o = owner.getBoundingClientRect();
    // The top of the popover may be off screen: it is bottom-anchored and #viewport clips it. Scrolling the
    // element up to a strip nobody can see would hide the very thing the panel belongs to, so the sections
    // are never scrolled past whichever of the two tops is really on screen.
    var lid = Math.max(pop.top, $('viewport').getBoundingClientRect().top);
    // What the panel WANTS is its content's height plus the panel's own 10px top and bottom padding: the panel
    // itself does not scroll (its × is pinned in the corner), the content box inside it does.
    var shift = o.top - lid - edge;
    if (shift > 0) shift = Math.min(shift, Math.max(0, c.picker.scrollHeight + 20 + 6 + edge - (pop.bottom - o.bottom)));
    if (shift) { c.main.scrollTop = Math.max(0, (c.main.scrollTop || 0) + shift); o = owner.getBoundingClientRect(); }
    var top = Math.round(o.bottom - pop.top + 6);
    c.layer.style.top = top + 'px';
    c.layer.style.maxHeight = 'calc(100% - ' + (top + edge) + 'px)';
  }
  // Arrow Up / Down on the preset control step through the list and put each entry in force, the list open or
  // not - the quick way to compare two builds on the circle. Kept from the viewer, whose arrows orbit.
  function aimPresetKey(e) {
    var step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault(); e.stopPropagation();
    var names = aimEntryNames(), at = names.indexOf(shooterPreset) + step;
    if (at >= 0 && at < names.length) aimChoose(names[at]);
  }
  // The preset list: Custom first, then the built-in builds, then the user's own, the entry in force marked. A
  // click on a name puts that entry in force and closes the list; the popover stays. Only what can be managed
  // has icons: Custom saves itself as a preset, a preset of the user's own is renamed in place (the pencil, or
  // a double-click on its name) and deleted. The built-in builds are read-only.
  function aimPresetList() {
    var list = node('div', undefined, 'aim-presets');
    var full = aimUserNames().length >= AIM_PRESET_LIMIT;
    aimEntryNames().forEach(function (name) {
      var kind = name === AIM_CUSTOM ? 'custom' : aimBuiltIn(name) ? 'builtin' : 'user';
      // A row is not a listbox option: it holds buttons of its own. The mark on it is the stylesheet's, and
      // what a screen reader is told is the pick button's own aria-current.
      var row = node('div', undefined, 'aim-preset-row');
      row.setAttribute('data-selected', String(name === shooterPreset));
      row.setAttribute('data-kind', kind);
      // The pencil and the bin read the name out of `ref` when they are PRESSED, not when they are made. The
      // mousedown of either takes the focus off an open name field, which commits the rename there and then:
      // a closure holding the old name would look up a preset that no longer answers to it and do nothing.
      var ref = {name: name};
      if (aimRenaming && aimRenaming.from === name) aimRenaming.ref = ref;
      row.appendChild(aimRenaming && aimRenaming.from === name ? aimNameField() : aimPresetPick(name, kind));
      if (kind === 'custom') {
        row.appendChild(aimPresetAct('save', 'Save as a preset', aimSaveCustom,
                                     full ? 'That is as many presets as the page keeps. Delete one first.'
                                     : !aimStore.custom[shooterType] ? 'Nothing to save yet: change something in the menu first.' : ''));
      }
      if (kind === 'user') {
        row.appendChild(aimPresetAct('rename', 'Rename', function () { aimStartRename(ref.name); }, ''));
        row.appendChild(aimPresetAct('delete', 'Delete', function () { aimDeletePreset(ref.name); }, ''));
      }
      list.appendChild(row);
    });
    return list;
  }
  function aimEntryTitle(name) {
    return name === AIM_CUSTOM ? 'Custom: your own build. Every change made in this menu lands here and is kept; the presets stay as they are.'
      : aimBuiltIn(name) ? name + ': a built-in build. A change made to it lands in Custom.'
      : name + ': your preset. A change made to it lands in Custom.';
  }
  function aimPresetPick(name, kind) {
    var b = node('button', name, 'aim-preset-pick');
    b.type = 'button';
    if (name === shooterPreset) b.setAttribute('aria-current', 'true');
    b.title = aimEntryTitle(name) + (kind === 'user' ? ' Double-click to rename it.' : '');
    b.onclick = function (e) {
      if (kind === 'user' && e && e.detail > 1) { aimStartRename(name); return; }
      if (kind === 'user') aimCloseSoon(); else aimDropLayer(true);
      aimChoose(name);
      if (!aimLayer) aimConfigControls.preset.focus();
    };
    b.ondblclick = function () { if (kind === 'user') aimStartRename(name); };
    return b;
  }
  // An icon of a row: the glyph is the stylesheet's (data-act), the words are its tooltip. `off` is why it
  // cannot act now, which is then the tooltip.
  function aimPresetAct(act, words, run, off) {
    var b = node('button', undefined, 'aim-preset-act');
    b.type = 'button';
    b.setAttribute('data-act', act); b.setAttribute('aria-label', words);
    b.title = off || words;
    if (off) b.setAttribute('aria-disabled', 'true');
    b.onclick = function () { if (!off) run(); };
    return b;
  }
  // The name of a preset of the user's own, edited in place. Enter or leaving the field keeps it, Escape goes
  // back to the old one; a name that cannot be taken keeps the field open, outlined red, the reason in its
  // tooltip. Every key typed here is the field's own: the viewer's arrows and +/- and the popover's Escape
  // never see it. The name is typed here, never in window.prompt: the game's CEF may not show one at all.
  function aimNameField() {
    var r = aimRenaming, field = node('input', undefined, 'aim-preset-field');
    field.type = 'text'; field.maxLength = AIM_NAME_LIMIT; field.value = r.draft;
    field.setAttribute('aria-label', 'Name of the preset');
    if (r.error) { field.setAttribute('aria-invalid', 'true'); field.title = r.error; }
    field.oninput = function () {
      r.draft = field.value; r.error = '';
      field.removeAttribute('aria-invalid'); field.title = '';
    };
    field.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); aimRenameCommit(field); }
      else if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); aimRenaming = null; aimPaintLayer(); }
    };
    // A field a repaint took away is not a field the user left.
    field.onblur = function () { if (field.isConnected && aimRenaming === r) aimRenameCommit(field); };
    aimNameInput = field;
    return field;
  }
  function aimStartRename(name) {
    if (!aimStore.presets[name]) return;
    aimCancelClose();
    if (!(aimRenaming && aimRenaming.from === name)) aimRenaming = {from: name, draft: name, error: ''};
    aimPaintLayer();
  }
  function aimNameProblem(name, from) {
    return !name ? 'Give the preset a name.'
      : aimReserved(name) ? '“Custom” is the name of your own working build. Pick another one.'
      : aimBuiltIn(name) ? 'That is the name of a built-in preset. Pick another one.'
      : name !== from && aimStore.presets[name] ? 'You already have a preset with that name.' : '';
  }
  function aimRenameCommit(field) {
    var r = aimRenaming, c = aimConfigControls;
    if (!r) return;
    var name = aimName(r.draft), why = aimNameProblem(name, r.from);
    if (why) { r.error = why; field.setAttribute('aria-invalid', 'true'); field.title = why; return; }
    aimRenaming = null; aimNameInput = null;
    if (name !== r.from) {
      aimStore.presets[name] = aimStore.presets[r.from]; delete aimStore.presets[r.from];
      Object.keys(aimStore.chosen).forEach(function (type) { if (aimStore.chosen[type] === r.from) aimStore.chosen[type] = name; });
      if (shooterPreset === r.from) shooterPreset = name;
      persistSettings();
    }
    // THE ROW IS MENDED IN PLACE, NOT REPAINTED. What usually commits a name is the mousedown of the next
    // thing the user presses - the bin of another row - and a repaint here builds every row again, so that
    // button is off the page before its own click is delivered and the press does nothing at all. Only the
    // field becomes a name again; the list finds its new order the next time it is opened.
    if (r.ref) r.ref.name = name;
    field.replaceWith(aimPresetPick(name, 'user'));
    if (shooterPreset === name) {   // the preset control carries the name
      c.preset.textContent = name;
      c.preset.title = aimEntryTitle(name) + ' Click for the list; the arrow keys step through it.';
    }
  }
  // Custom saved as a preset of its own under the first free "Build N", whose name opens for typing at once.
  // The entry in force stays what it was.
  function aimSaveCustom() {
    if (aimUserNames().length >= AIM_PRESET_LIMIT) return;
    var name = aimFreeName('Build', function (n) { return !!aimStore.presets[n]; });
    aimStore.presets[name] = aimStoredPreset(aimStore.custom[shooterType] || {});
    persistSettings();
    aimStartRename(name);
  }
  // A preset of the user's own deleted: the vehicles that had it chosen go back to the stock build, the one on
  // screen at once. The list stays open.
  function aimDeletePreset(name) {
    if (!aimStore.presets[name]) return;
    aimCancelClose();   // the list stays up to be read: the timer of a preset clicked a moment ago is dropped
    delete aimStore.presets[name];
    Object.keys(aimStore.chosen).forEach(function (type) { if (aimStore.chosen[type] === name) delete aimStore.chosen[type]; });
    if (aimRenaming && aimRenaming.from === name) aimRenaming = null;
    persistSettings();
    if (shooterPreset === name) { shooterPreset = AIM_BUILT_IN[0].name; shooterConfig = aimPreset(shooterPreset); aimConfigChanged(); }
    else aimPaintLayer();
  }
  // Escape takes the top layer of the popover away: the sub-panel first, the popover itself next. Listened for
  // on the document while the popover is open and at no other time; a key typed into a field is the field's.
  function aimConfigKey(e) {
    if ((e.key !== 'Escape' && e.key !== 'Esc') || aimTyping(e)) return;
    var box = $('aim-config');
    if (!box.open) return;
    e.preventDefault();
    if (aimLayer) { aimCloseLayer(); return; }
    box.open = false;
    box.querySelector('summary').focus();
  }
  // Run on the popover's toggle and on every updateAim, which may close it: the Escape listener comes and goes
  // with the popover, and a popover closed with a sub-panel open opens again without it.
  var aimConfigHeld = false;
  function aimConfigListen() {
    var open = !!$('aim-config').open;
    if (open === aimConfigHeld) return;
    aimConfigHeld = open;
    if (open) { document.addEventListener('keydown', aimConfigKey); return; }
    document.removeEventListener('keydown', aimConfigKey);
    if (aimLayer || aimRenaming) { aimDropLayer(); aimConfigDirty = true; }
  }
  // The Config button's tooltip: what is fitted, then - only when there is something to say - what the record
  // does not let the page know. The note under the slots and the "?" on the button went here (user, 22.09):
  // nothing in them changes what can be clicked, so none of it is printed in the menu.
  function aimConfigTitle() {
    var out = 'This shooter’s equipment, directive, consumables and crew, with presets. Now: ' + aimLongSummary() + '.';
    var fixed = ['devices', 'consumables', 'crew'].filter(aimForbidden)
      .map(function (kind) { return AIM_POLICY_WORDS[kind].toLowerCase(); });
    if (fixed.length) out += ' The game fixes this vehicle’s ' + fixed.join(', ') + ': what is set here for them is not applied.';
    var unknown = '', why = [];
    ['devices', 'consumables', 'crew'].forEach(function (kind) {
      if (!unknown && shooterPolicy[kind].state === 'unknown') unknown = shooterPolicy[kind].source;
    });
    if (unknown) why.push(unknown);
    if (!(shooterFit && shooterFit.tags) && !/tags/.test(unknown)) why.push('the record does not carry the vehicle’s tags');
    if (why.length) out += ' Everything is offered, which may be more than the game allowed here: ' + why.join('; ') + '.';
    var kept = aimKept();
    if (kept) out += ' Kept from the record: ' + kept + ' (field modifications).';
    out += aimModifierLine();
    return out;
  }
  // --- The battle's own modifiers (Onslaught and the other special modes) -------------------------
  // A special mode changes vehicle parameters through BATTLE MODIFIERS the server sends with the arena;
  // the recorder writes the raw descriptor into the battle header as mode.battleModifiersDescr (0.7.20
  // and later). The wire shape, read out of battle_modifiers.pkg in this client, 22.09:
  //   descr      = [modifier, ...]
  //   modifier   = [paramId, gameplayImpact, tree]   paramId is the parameter's own name, e.g.
  //                                                  'shotDispersionRadius' (BattleParam.readId = config.name)
  //   tree       = [node, ...]; node = ['root', nodeDescr] | ['shell', keys, nodeDescr]
  //                                                       | ['vehicle', keys, nodeDescr]
  //   nodeDescr  = [packed, value, (min), (max)]     useType = (packed >> 2) & 3: 1 val, 2 mul, 3 add;
  //                                                  packed & 2 -> a min follows, packed & 1 -> a max
  // WHAT IS APPLIED HERE and why so little. Measured on the owner's own records, 22.09
  // (outputs/onslaught-modifiers-2026-09-22.md): in the twenty 7v7 battles of 20-21.09 every shooter's
  // gun dispersion is exactly 0.0015 BELOW the same gun's value in a random battle - one additive
  // modifier on shotDispersionRadius - while the aiming time, all four dispersion factors, the rotation
  // and top speeds and the reload are untouched, and so are the shell's penetration, alpha, speed,
  // normalisation and ricochet angle. Only the aiming group is applied (the owner, 22.09: the collision
  // calculation is the same as in a random battle), and a parameter this page does not model is counted
  // and named instead of being applied silently.
  // A LIVE shooter block already carries all of it: ClientArena.getVehicleType builds the attacker's
  // descriptor with the battle's modifiers, which is how they were measured. So the modifiers are applied
  // only to a block REBUILT from the compact descriptor (aimFrom 'compact'), which has none of them.
  var AIM_MODIFIER_FIELD = {shotDispersionRadius: 'dispersion', aimingTime: 'aimingTime',
    dispFactorChassisMovement: 'movementFactor', dispFactorChassisRotation: 'rotationFactor',
    dispFactorTurretRotation: 'turretRotationFactor', dispFactorAfterShot: 'afterShotFactor'};
  var AIM_MODIFIER_WORDS = {dispersion: 'the circle', aimingTime: 'the aiming time',
    movementFactor: 'the movement term', rotationFactor: 'the hull-rotation term',
    turretRotationFactor: 'the turret term', afterShotFactor: 'the term after a shot'};
  var aimModsFrom = null, aimMods = null;
  // One node of a modification tree: [packed, value, (min), (max)]. Returns null for anything else,
  // so a descriptor of a shape this build does not know can never throw and never changes a number.
  function aimModifierNode(descr) {
    if (!Array.isArray(descr) || descr.length < 2) return null;
    var packed = Number(descr[0]), value = Number(descr[1]), at = 2, out;
    if (!isFinite(packed) || !isFinite(value)) return null;
    out = {use: (packed >> 2) & 3, value: value, min: null, max: null};
    if (packed & 2) { out.min = Number(descr[at]); at++; }
    if (packed & 1) out.max = Number(descr[at]);
    return out.use >= 1 && out.use <= 3 ? out : null;
  }
  // The modifiers of a battle, read once per battle object. {rules: [{field, param, node}], unknown: [param]}.
  function aimBattleModifiers(battle) {
    if (aimMods && battle === aimModsFrom) return aimMods;
    aimModsFrom = battle;
    aimMods = {rules: [], unknown: [], any: false};
    var list = battle && battle.mode && battle.mode.battleModifiersDescr;
    if (!Array.isArray(list) || !list.length) return aimMods;
    aimMods.any = true;
    list.forEach(function (mod) {
      if (!Array.isArray(mod) || mod.length < 3) { aimMods.unknown.push('a modifier of an unknown shape'); return; }
      var param = String(mod[0]), tree = mod[2], field = AIM_MODIFIER_FIELD[param];
      if (!field) { aimMods.unknown.push(param); return; }
      // Only the tree's root node is applied: a node under a shell or a vehicle filter selects by
      // something the record does not carry (the shell kind the modifier was written for, the vehicle's
      // class or level), so it is named as unknown rather than applied to everything.
      var root = null, filtered = false;
      (Array.isArray(tree) ? tree : []).forEach(function (node) {
        if (!Array.isArray(node) || !node.length) return;
        if (node[0] === 'root') root = aimModifierNode(node[1]);
        else filtered = true;
      });
      if (!root) { aimMods.unknown.push(param); return; }
      if (filtered) aimMods.unknown.push(param + ' (a filtered node of it)');
      aimMods.rules.push({field: field, param: param, node: root});
    });
    return aimMods;
  }
  // The client's own three ways of using a value (UseType: 1 VAL, 2 MUL, 3 ADD), with the parameter's
  // own limits applied exactly as the client's value limiter does.
  function aimModifierApply(rule, value) {
    var node = rule.node, out = node.use === 1 ? node.value : node.use === 2 ? value * node.value : value + node.value;
    if (!isFinite(out)) return value;
    if (node.min !== null && isFinite(node.min)) out = Math.max(out, node.min);
    if (node.max !== null && isFinite(node.max)) out = Math.min(out, node.max);
    return out;
  }
  // The line the Config tooltip carries when the battle has modifiers of its own.
  function aimModifierLine() {
    var battle = activeHit && activeHit.vehicle ? null : current;
    var mods = aimBattleModifiers(battle);
    if (!mods.any) return '';
    var mode = battle ? battleModeOf(battle) : null, name = mode && mode.name ? mode.name : 'this mode';
    var a = activeHit && activeHit.attacker && activeHit.attacker.aim;
    var live = a && a.aimFrom !== 'compact';
    var applied = mods.rules.map(function (r) { return AIM_MODIFIER_WORDS[r.field]; });
    var out = ' ' + name + ' sent this battle ' + (mods.rules.length + mods.unknown.length) + ' modifier'
      + (mods.rules.length + mods.unknown.length === 1 ? '' : 's') + ' of its own.';
    out += live ? ' The numbers above are the ones this battle was fought with, so they already carry them.'
      : applied.length ? ' This block was rebuilt from the vehicle descriptor, so they are applied here: '
        + applied.join(', ') + '.'
      : ' This block was rebuilt from the vehicle descriptor and carries none of them.';
    if (mods.unknown.length) out += ' Not applied: ' + mods.unknown.join(', ')
      + ' - the page does not model ' + (mods.unknown.length === 1 ? 'it' : 'them') + ' and shows the numbers without.';
    return out;
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
  // THE SHOOTER'S CIRCLE IN THE MODE THE SHOT WAS FIRED IN (B5, 23.09). A vehicle built twice changes its circle in
  // the second mode far more often than its shells - 34 of the client's 79 siege files (the Strv 107-12 0.29 -> 0.24
  // m/100 m and 3.0 -> 1.0 s, the Contriver's salvo 0.33 -> 1.1 and afterShot 4 -> 8) - while the recorded block is the
  // one of the descriptor the client handed over, DEFAULT for anybody else's vehicle. Since the build after 0.7.28 the
  // recorder writes the other descriptor's block beside it (attacker.modeAim, the mode in modeAimMode); the shot's own
  // mode is its siege state - the tracer's, the instant it left the barrel, before the one the impact carries, the
  // precedence the shell's mode already uses (shot-context.js). With or without ✸ (23.09: the recorded ring of a
  // siege shot is the siege circle too); for every record without the block, the recorded block exactly as before. The configurator reads the mode block with the recorded
  // block's provenance (aimFrom, compactFactors): both come from the same descriptor and the same devices.
  // `want` (BACKLOG 37): the mode the ✸ layer puts the shooter in - the Strv 107-12's pillbox is the siege mode whatever
  // the shot was recorded in (xiSiegeMode); undefined, the recorded mode decides as before.
  var aimModeFrom = null, aimModeView = null, modeTtxView = null, modeTtxPair = null;
  // THE OTHER MODE'S BLOCK (23.09, outputs/second-modes-2026-09-23.md 5.2 p. 3): {block, mode, from}, or null.
  //   1. the record's own attacker.modeAim (the recorder since the build after 0.7.28; an older record gets it at
  //      publish, exporter.fix_mode_blocks);
  //   2. under ✸ only, the second block of the shooter's pair in his characteristics file (configs[k].modeAim, the pair
  //      the emulator fires - ttxEmuIndex), with the recorded block's own four miscAttrs factors, aimFrom and
  //      compactFactors laid over it: the field modifications and the battle's modifiers are the same in both modes.
  //      A shot recorded in the siege mode (vehicleMode 1) gets the file's first block as its other one.
  // The block carries everything itself - circle, aiming, stabilisation, after-shot term, top speed, hull and turret
  // traverse, reload, burst - so there is no second formula anywhere: whoever reads a block reads this one too.
  function modeAimOf(hit) {
    var at = hit && hit.attacker, a = at && at.aim, m = at && at.modeAim;
    if (!(a && a.dispersion > 0)) return null;
    if (m && m.dispersion > 0 && (at.modeAimMode === 0 || at.modeAimMode === 1)) return {block: m, mode: at.modeAimMode, from: 'record'};
    if (!funOn() || hit !== activeHit || !ttxData || !TTX) return null;
    // The pair is looked up once per file and shooter, not on every read of the block (several a frame).
    if (!modeTtxPair || modeTtxPair.t !== ttxData || modeTtxPair.at !== at) modeTtxPair = {t: ttxData, at: at, i: ttxEmuIndex()};
    var i = modeTtxPair.i, pair = i >= 0 ? ttxData.configs[i] : null;
    if (!pair || !(pair.modeAim && pair.modeAim.dispersion > 0) || !(pair.aim && pair.aim.dispersion > 0)) return null;
    var own = at.vehicleMode === 1 ? 1 : 0, src = own === 1 ? pair.aim : pair.modeAim;
    if (!modeTtxView || modeTtxView.a !== a || modeTtxView.src !== src) {
      var view = Object.assign({}, src);
      AIM_BARE_FACTORS.forEach(function (k) { if (a[k] !== undefined) view[k] = a[k]; else delete view[k]; });
      if (a.aimFrom) view.aimFrom = a.aimFrom;
      if (a.compactFactors) view.compactFactors = a.compactFactors; else delete view.compactFactors;
      modeTtxView = {a: a, src: src, view: view};
    }
    return {block: modeTtxView.view, mode: 1 - own, from: 'ttx'};
  }
  function aimOfHit(hit, want) {
    var at = hit && hit.attacker, a = at && at.aim, sec = modeAimOf(hit), m = sec && sec.block;
    if (!m || !(m.dispersion > 0) || !(a && a.dispersion > 0)) return a;
    var mode = want;
    if (mode !== 0 && mode !== 1) {
      var tracer = hit === activeHit && shotContext ? shotContext.tracer : null;
      var siege = tracer && Number.isFinite(tracer.siegeState) ? tracer.siegeState : at.siegeStateAtImpact;
      if (!Number.isFinite(siege)) return a;
      // VEHICLE_SIEGE_STATE: 0 and 1 are the default mode, 2 and up the siege one (constants.pyc 4166-4182).
      mode = siege <= 1 ? 0 : 1;
    }
    if (mode !== sec.mode || mode === at.vehicleMode) return a;
    if (aimModeFrom !== m || !aimModeView || aimModeView.base !== a) {
      aimModeFrom = m;
      aimModeView = {base: a, view: Object.assign({}, m, {aimFrom: m.aimFrom || a.aimFrom, compactFactors: m.compactFactors || a.compactFactors})};
    }
    return aimModeView.view;
  }
  function aimBlockData() {
    // Under ✸ a tier-XI shooter's mode or second gun may be in force (xiSiegeMode, xiAim: BACKLOG 37); off it, the
    // recorded block exactly as before.
    var xm = xiNow(), a = xiAim(aimOfHit(activeHit, xiSiegeMode(xm)), xm);
    if (!(a && a.dispersion > 0)) return null;
    var own = aimShooterIsPlayer(activeHit), fixed = aimForbidden('devices'), key = (own ? 'own' : 'other') + (fixed ? '|fixed' : '');
    // A block REBUILT from the compact descriptor knows nothing of the battle's own modifiers, so they go
    // on here (aimModifiers above); a live block was already built with them and is left alone.
    var battle = activeHit && activeHit.vehicle ? null : current;
    var mods = a.aimFrom === 'compact' ? aimBattleModifiers(battle) : null;
    if (mods && !mods.rules.length) mods = null;
    key += mods ? '|mods' : '';
    if (a !== aimBareFrom || key !== aimBareKey) {
      var base = aimBaseFactors(a, own, fixed);
      aimBareFrom = a; aimBareKey = key; aimBare = Object.create(a);
      AIM_BARE_FACTORS.forEach(function (k) { aimBare[k] = base[k]; });
      if (mods) mods.rules.forEach(function (r) {
        var v = Number(aimBare[r.field]);
        if (isFinite(v)) aimBare[r.field] = aimModifierApply(r, v);
      });
    }
    return aimBare;
  }
  // What the configuration KEEPS of the record's own four factors - the field modifications it does not set
  // itself (aimBaseFactors above) - in words, for the Config button's tooltip, or ''. Nothing when the game
  // fixes this vehicle's equipment: the record's own then stays in whole, and the tooltip says so already.
  var AIM_CARRIED_WORDS = {multFactor: 'the circle', additiveFactor: 'the movement terms',
    aimingTimeFactor: 'the aiming time', reloadTimeFactor: 'the reload'};
  function aimKept() {
    var base = aimBlockData(), kept = [];
    if (!base || aimForbidden('devices')) return '';
    AIM_BARE_FACTORS.forEach(function (k) {
      var b = Number(base[k]);
      if (b > 0 && isFinite(b) && Math.abs(b - 1) > 1e-6) kept.push('×' + aimNum(b) + ' on ' + AIM_CARRIED_WORDS[k]);
    });
    return kept.join(', ');
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
  function aimClipRounds() { return clipRoundsOf(ArmorBallistics.reloadSeconds(aimBlockData(), aimModifiers())); }
  // The rounds the emulation loads, off a reload the caller has: a clip needs a gap between its rounds, or it
  // is fired as a single-shot gun.
  function clipRoundsOf(rl) { return rl && rl.shots > 1 && rl.interval > 0 ? rl.shots : 1; }
  // The gun loaded in full with nothing loading: a new shooter, the emulation starting over, a rule switched, a
  // press under the simplified rule. `rounds` when the caller has the clip size already.
  function aimLoadFull(rounds) { aimClipSize = rounds || aimClipRounds(); aimClip = aimClipSize; aimRefill = null; }
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
    var mods = aimHeated(aimModifiers());
    // The gun's sector of this frame (under ✸ a static gun is held on the hull's axis while driving or switching the
    // mode) and the keys the vehicle drives by (aimKeysNow: the second modes' rules and the autorotation past the sector).
    var yawLimits = aimYawLimits(a);
    aimMove = ArmorBallistics.moveStep(aimMove, aimKeysNow(yawLimits), a, mods, dt);
    xiMotion(aimMove.speed);   // the Leopard 120 V's stacks build only below their speed (nothing for other vehicles)
    // The hull turns first and TAKES THE GUN WITH IT (user, 20.09): the aim point swings around the
    // shooter by hullTurn·dt, opening a gap to the crosshair, and the turret below spends what the hull
    // left it on closing that gap again. So holding A with the cursor still drags the ring sideways and
    // the turret pulls it back.
    var swung = false;
    if (aimMove.hullTurn) {
      aimHeading += aimMove.hullTurn * dt;
      swung = !!(viewer.turnAim && viewer.turnAim(aimMove.hullTurn * dt));
    }
    // The gun turns only within the shooter's horizontal sector (BACKLOG 40): the gap is the one to the point it can
    // reach, so a gun stopped at its limit has none to close and puts no turret term into the circle - the hull,
    // turned by A or D, carries it on (viewer.aimReach), under ✸ the autorotation too.
    var chase = ArmorBallistics.turretChase(viewer.aimGap(yawLimits), aimMove.hullTurn, a, mods, dt, swung);
    // `turned`: the gun really moved in this frame (chaseAim says so for anything above a micro-radian).
    var turned = chase.step > 0 && !!viewer.chaseAim(chase.step, yawLimits);
    var state = {speed: aimMove.speed, hullTurn: aimMove.hullTurn, hullMax: aimMove.hullMax, turretTurn: chase.turretTurn};
    autoHold(a, state);   // ✸: an automatic gun's stream keeps its term in the circle (nothing otherwise)
    aimNow = ArmorBallistics.aimStep(aimNow, state, a, mods, dt);
    // ✸: the rest of a gun's burst goes out on its own, one round per burst interval, button down or not.
    if (burstLeft > 0) { if (aimReloadLeft() <= 0 && !heatLocked()) burstNext(); }
    // The next shot of a held burst, the moment the cooldown is over. The recoil of the shot just fired is
    // already in `aimNow`, so a gun that cannot settle between two rounds fires the second one wider -
    // which is the whole point of the feature for autoloaders.
    else if (aimBurst && aimDown && !aimClipDry && aimReloadLeft() <= 0 && gunFree()) fireShot();
    // Under ✸ real reload the reload runs on after the release (without it a released button has no reload
    // at all, so this never happens). A shooter at rest with a settled ring and nothing but that countdown
    // running needs only the ring's fill and the panel each frame: the ring's figure cannot have changed, so
    // the coarse integral paintAim takes every 120 ms is not taken again and again for nothing.
    if (!aimDown && !aimHeld() && aimReloadLeft() > 0 && aimMove.resting && chase.caught && !turned && aimNow && aimNow.settled) {
      if (viewer.setAimReload) viewer.setAimReload(aimReloadPart());
      viewer.setLiveAim(aimNow.radius100);
      paintGunLoad();
      startAimLoop();
      return;
    }
    paintAim(state);
    var reloading = aimReloadLeft() > 0;
    // A frame in which the turret caught the cursor is not a resting frame, although it reads as one: the
    // turret's speed of this frame rose the ring INSTANTLY to that state's ideal, and aimStep calls a
    // factor sitting on its ideal `settled`. Sleeping here left the ring bloomed and its figure stale
    // until the next mouse move (optimisation plan 21.09, §8.3). So the loop runs on for as long as the
    // gun moves; the next frame has no turret speed, the ring decays from the bloom, and the fine figure
    // is taken once, when it is really at rest - the coarse one keeps its 120 ms pace meanwhile.
    if (aimHeld() || !aimMove.resting || reloading || !chase.caught || turned || (aimBurst && aimDown && !aimClipDry) || burstLeft > 0 || (aimNow && !aimNow.settled)) startAimLoop();
    else { aimClock = 0; if (reloadJustFinished()) paintAim(state); if (!aimEstFine) { estimateLive(true); paintCircleLines(); } }
  }
  // The shooter's horizontal sector, [left, right] radians with the left one negative - gun.turretYawLimits of the
  // block in force (exporter.aim_block since 23.09; an older record gets it at publish from its compact descriptor) -
  // or null for a gun that turns all the way round. A pair that spans the whole circle (nine turrets carry -180 180)
  // is no limit either.
  // UNDER ✸, A GUN WITH A STATIC YAW (23.09, the 14 tank destroyers with gun.staticTurretYaw) is held on the hull's
  // axis while a key of W A S D is held or the mode switches - the client's VehicleGunRotator collapses its limits to
  // (staticTurretYaw, staticTurretYaw) then (hasMovingFlags, SWITCHING; a dead engine or track too, not modelled) - and
  // moves in its sector standing. The chase brings it there at the turret's speed, its term in the circle by the block.
  var AIM_STATIC_YAW = [0, 0];
  function aimYawLimits(a) {
    var st = a && funOn() && a.staticTurretYaw !== undefined && a.staticTurretYaw !== null ? Number(a.staticTurretYaw) : NaN;
    if (isFinite(st) && (aimHeld() || xiSwitching())) { AIM_STATIC_YAW[0] = st; AIM_STATIC_YAW[1] = st; return AIM_STATIC_YAW; }
    var l = a && a.turretYawLimits;
    if (!Array.isArray(l) || l.length !== 2) return null;
    var lo = Number(l[0]), hi = Number(l[1]);
    return isFinite(lo) && isFinite(hi) && hi > lo && hi - lo < 2 * Math.PI - 1e-6 ? l : null;
  }
  // THE KEYS THE VEHICLE DRIVES BY, under ✸ (23.09, outputs/second-modes-2026-09-23.md 5.2 p. 4, 6, 10); off ✸ the held
  // keys themselves, as before.
  //   - a mode switch with stopEngineOnSwitch stops the vehicle: no key at all (the speed dies by the brake, the turn by
  //     its own ramp) - updateSiegeStateStatus drops the movement keys;
  //   - a French wheeled vehicle that cannot turn on the spot does not turn standing (below 0.1 km/h A and D do nothing,
  //     the client's help);
  //   - THE AUTOROTATION: with a sector and neither A nor D held, the hull turns itself towards a cursor past the sector -
  //     the client sends the aim to the server (trackRelativePointWithGun) and the server turns the hull, at the hull's
  //     own traverse (derived: the client has no other). A virtual key of moveStep, so the ramp, the fall and the turn's
  //     term in the circle are the keys' own; `auto` is what is left past the sector, so the hull never overshoots it,
  //     and it stops the moment it is there (autoStop). Measured by the viewer (aimBeyond: two directions, no ray).
  var AIM_NO_KEYS = {}, AIM_AUTO_KEYS = {}, aimAutoTurn = false;
  function aimNoSpotTurn() {
    var modes = ttxData && ttxData.vehicle && ttxData.vehicle.modes, a = activeHit && activeHit.attacker && activeHit.attacker.aim;
    if (modes && modes.wheeled !== undefined) return !!modes.wheeled && !modes.onSpotRotation;
    return !!(a && a.siegeMode && a.siegeMode.kind === 'wheeled');
  }
  function aimKeysNow(limits) {
    if (!funOn()) return aimKeys;
    var m = xiMech ? xiNow() : null;
    if (m && m.spec.kind === 'siege' && m.to !== null && m.spec.stop) { aimAutoTurn = false; return AIM_NO_KEYS; }
    var turn = !!(aimKeys.left || aimKeys.right), keys = aimKeys;
    if (turn && !(aimMove && Math.abs(Number(aimMove.speed) || 0) >= 0.1 * KMH_TO_MS) && aimNoSpotTurn()) turn = false;
    if (!turn && limits && viewer && viewer.aimBeyond) {
      var over = Number(viewer.aimBeyond(limits)) || 0;
      if (Math.abs(over) > 1e-4) aimAutoTurn = true;
      else if (aimAutoTurn) { aimAutoTurn = false; over = 0; AIM_AUTO_KEYS.autoStop = true; }
      else over = NaN;
      if (!isNaN(over)) {
        AIM_AUTO_KEYS.forward = aimKeys.forward; AIM_AUTO_KEYS.back = aimKeys.back; AIM_AUTO_KEYS.auto = over;
        if (over) AIM_AUTO_KEYS.autoStop = false;
        return AIM_AUTO_KEYS;
      }
    } else aimAutoTurn = false;
    if (!turn && (aimKeys.left || aimKeys.right)) { AIM_AUTO_KEYS.forward = aimKeys.forward; AIM_AUTO_KEYS.back = aimKeys.back; AIM_AUTO_KEYS.auto = 0; AIM_AUTO_KEYS.autoStop = false; return AIM_AUTO_KEYS; }
    return keys;
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
    aimEst = circleFigure(r, shell);
    aimEstAt = now; aimEstFine = !!fine;
  }
  // The figure one sampled circle is worth (user, 22.09: with a MANUAL shell every Circle line read "—").
  // A shell chosen by hand - a type on the shell-type buttons, or a penetration and a calibre with no
  // saved candidate behind them - has no alpha at all, so a share of alpha is meaningless. It then carries
  // the mean PENETRATION CHANCE over the circle instead, which needs no alpha, and the tooltip says so. A
  // saved shell whose penetration or calibre the user edited keeps its own alpha and its damage figure.
  function circleFigure(r, shell) {
    if (!r) return null;
    if (shell && shell.alpha > 0) return {alpha: true, damage: damagePct(r.damage, shell)};
    return {alpha: false, low: r.low, high: r.high, unknown: !!r.unknown};
  }
  // The figure alone: the word "Circle" is the heading of the tile it is written into (user, 22.09). And no
  // figure to be had is no tile at all - an empty text puts the tile away instead of printing the old dash.
  function circleText(figure) {
    if (!figure) return '';
    if (figure.alpha) return figure.damage + ' %';
    if (!(figure.low >= 0)) return '';
    return (figure.unknown ? Math.round(figure.low) + '–' + Math.round(figure.high) : Math.round(figure.low)) + ' %';
  }
  var SHARE = ', as a share of the shell’s alpha';
  var NO_ALPHA = ': penetration chance over the circle — this shell has no alpha, so no damage figure';
  var CIRCLE_TITLES = {
    live: 'Expected damage of a shot inside the live aiming circle',
    shot: 'Expected damage of the shot inside the magenta ring it left on the model',
    // The recorded reticle: the circle the shooter's own client had at the instant of the shot, slid
    // along the shot line onto the impact point - the ring drawn solid magenta on the model.
    saved: 'Expected damage of a shot inside the recorded aiming circle of this hit — the shooter’s client reticle, slid along the shot line to the impact point',
    // No recorded reticle: the dashed magenta ring is the nominal full-aim estimate, and the figure is
    // an estimate with it. Said on the line itself, so the number is never read as a recorded one.
    estimate: 'This hit has no recorded reticle: the figure is for the nominal full-aim circle drawn on the hit line (gun accuracy × range, no crew or equipment). Expected damage of a shot inside it'
  };
  // One tile per ring, in the colour of the ring it belongs to (user, 20.09; a column of its own at the top
  // RIGHT of the scene since 22.09, each tile on the row of the panel it belongs to): the live cyan one
  // beside "Under the cursor", the STANDING magenta ring beside the hit-line panel above it. That ring is
  // the recorded reticle of the hit (or its nominal estimate) until the user fires, and the ring of his
  // own last shot afterwards - which is exactly what has replaced it on the model. No figure twice.
  // `id` names the VALUE element, `<id>-tile` the tile around it: the tile takes the hidden flag, the ring's
  // colour class and the tooltip, the value element the figure alone. The class is written only when it
  // really changes - the markup already ships each tile with the right one.
  // The colour of the FIGURE (user, 22.09): the heading keeps the ring's colour, the number takes the one
  // the chance scale gives that percentage - the very mapping the armour map and the panels are drawn with,
  // so a tile and the armour under it read as the same scale. ArmorBallistics.color picks the quantity by
  // mode, so both fields are handed in and one percentage means one colour in either Display mode.
  function circleColor(figure) {
    var pct = figure.alpha ? figure.damage : figure.low;
    if (!(pct >= 0)) return '';
    return chanceRgb({chance: pct, expectedShare: pct / 100});
  }
  var circleRgb = {};   // what was last written into each figure: an unchanged colour is not written again per frame
  function circleLine(id, figure, kind) {
    var e = $(id), tile = $(id + '-tile');
    if (!e || !tile) return;
    var text = figure ? circleText(figure) : '';
    e.textContent = text;
    tile.hidden = !text;
    // The sampling sentence of the recorded ring (it used to hang on the toolbar's reticle box, removed on
    // 22.09) is composed by aimTitle() once per hit, not here per frame.
    var extra = kind === 'saved' || kind === 'estimate' ? aimExtra : '';
    tile.title = text ? (CIRCLE_TITLES[kind] || CIRCLE_TITLES.live) + (figure.alpha ? SHARE : NO_ALPHA) + extra : '';
    if (!text) return;
    var rgb = circleColor(figure);
    if (circleRgb[id] !== rgb) { circleRgb[id] = rgb; e.style.color = rgb; }
    var cls = kind === 'live' ? 'aim-circle-tile live' : 'aim-circle-tile shot';
    if (tile.className !== cls) tile.className = cls;
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
  // The load state, small and iconic, no prose: the countdown while the next round is loading, otherwise the
  // gun's own reload time, and the magazine beside it. A record with no reload at all says so with a dash - the
  // cooldown is unknown, and the emulation fires once. Returns the heat it painted, for the panel timer.
  function paintGunLoad() {
    var h = heatNow();
    paintHeat(h);   // the heat bar of an Ares gun under ✸; nothing but a hidden check otherwise
    var time = $('aim-gun-reload');
    if (!time) return h;
    // The reload of a tier-XI mode in force (the Szakal's fight ability, the pillbox, the T803's fury) is the reload.
    var a = aimBlockData(), rl = ArmorBallistics.reloadSeconds(a, xiApply(aimModifiers()));
    paintXi();   // the tier-XI mode button (BACKLOG 37): a hidden check off ✸ and for every other vehicle
    paintMag(a, rl);   // first: it brings an autoloader's load up to now, which the figure below reads
    if (!rl) { time.textContent = '—'; return h; }
    var left = aimReloadLeft(), running = left > 0;
    // An autoloader under real reload counts down the round loading back too, as the reticle does, while the
    // gun may already fire the rounds it has.
    if (!running && aimRefill) { left = Math.max(0, aimRefill.until - aimSeconds()); running = left > 0; }
    time.textContent = (running ? left : restReload(a, rl)).toFixed(1) + ' s';
    time.setAttribute('data-running', running ? '1' : '0');
    return h;
  }
  // The gun's own reload at rest. An autoloader has no single one: the client stands the load of the first round
  // into an empty magazine - the LAST entry of its tuple - in for gun.reloadTime (items/utils getFirstReloadTime,
  // ammo_ctrl _GunSettings), scaled by the same factors, and so does this.
  function restReload(a, rl) {
    var list = a && a.autoreload && a.autoreload.reloadTime;
    var last = Array.isArray(list) && list.length ? Number(list[list.length - 1]) : 0;
    return last > 0 && a.reloadTime > 0 ? last * rl.reload / a.reloadTime : rl.reload;
  }
  // THE MAGAZINE (user, 22.09 ~24:15): the rounds of the gun as a row of slots beside the reload figure -
  // graphics only, every number in its tooltip. It shows the emulation's own load, under whichever rule runs it:
  //   - a single-shot gun is one slot, which empties on the shot and fills with the reload;
  //   - a clip empties slot by slot, and while the whole clip reloads (✸ real reload) every slot shows the one
  //     shared fill, then they are all loaded together;
  //   - an autoloader under real reload loads its spent rounds back one at a time, the loading slot filling;
  //   - under the simplified rule (✸ or ◔ off) a hold empties the clip and nothing loads back; the release
  //     leaves the gun full, as the next press will find it;
  //   - more than MAG_SLOTS rounds (an Ares carries hundreds) is one bar: the rounds left, or the reload.
  // The next round to fire is lit, dimmed while the gap between rounds still runs. It is painted with the panel
  // - every frame while the loop runs, at 10 Hz from the panel timer otherwise - and writes only what changed:
  // the fills are quantised to 2 % and move by transform, so a running reload costs no layout.
  var MAG_SLOTS = 12, magShape = '', magParts = [], magSeen = [], magTitleKey = '';
  function paintMag(a, rl) {
    var box = $('aim-gun-mag');
    if (!box) return;
    var n = rl ? clipRoundsOf(rl) : 0;
    if (box.hidden !== !n) box.hidden = !n;
    if (!n) { magTitleKey = ''; return; }
    var now = aimSeconds(), real = realReload(), gate = aimReloadLeft();
    refillSettle(now);
    // loaded: the rounds in; filling: the slot loading (-1 none, n all of them - the clip reload); fill: its share.
    var loaded, filling = -1, fill = 0, wait = false, loadLeft = 0;
    // A gun whose clip the emulation has not taken yet (a new shooter before the first press) is loaded in full:
    // the press will find it so (beginShot).
    if (n !== aimClipSize) loaded = n;
    else if (n === 1) {
      loaded = gate > 0 ? 0 : 1;
      if (gate > 0) { filling = 0; fill = aimReloadPart() || 0; loadLeft = gate; }
    } else if (aimRefill) {
      loaded = aimClip; filling = aimClip; loadLeft = aimRefill.until - now;
      fill = Math.max(0, Math.min(1, (now - aimRefill.at) / (aimRefill.until - aimRefill.at)));
      wait = gate > 0 && aimClip > 0;
    } else if (aimClip <= 0 && gate > 0 && aimReload && !aimReload.clip) {
      loaded = 0; filling = n; fill = aimReloadPart() || 0; loadLeft = gate;
    } else {
      // A clip emptied under real reload and reloaded since is taken full by the next shot (fireShot): it is full.
      loaded = aimClip <= 0 && real ? n : Math.max(0, Math.min(n, aimClip));
      wait = gate > 0 && loaded > 0;
    }
    var bar = n > MAG_SLOTS, shape = (bar ? 'bar' : 'slots') + n, i;
    if (shape !== magShape) {
      magShape = shape; magParts = []; magSeen = [];
      for (i = 0; i < (bar ? 1 : n); i++) {
        var part = node('i', undefined, bar ? 'aim-mag-bar' : 'aim-mag-slot');
        var inner = node('i', undefined, bar ? 'aim-mag-bar-fill' : 'aim-mag-fill');
        part.appendChild(inner);
        magParts.push({box: part, fill: inner});
      }
      box.replaceChildren.apply(box, magParts.map(function (p) { return p.box; }));
    }
    var q = Math.round(fill * 50) / 50;
    if (bar) {
      var share = filling === n ? q : Math.round((loaded + (filling >= 0 ? fill : 0)) / n * 500) / 500;
      magSet(0, filling === n ? 'fill' : 'on', 'scaleX(' + share + ')');
    } else {
      for (i = 0; i < n; i++) {
        var st = i < loaded ? (i === loaded - 1 ? (wait ? 'wait' : 'next') : 'on') : filling === n || i === filling ? 'fill' : 'off';
        magSet(i, st, 'scaleY(' + (st === 'fill' ? q : 0) + ')');
      }
    }
    var key = shape + '|' + loaded + '|' + filling + '|' + Math.ceil(loadLeft) + '|' + Math.ceil(gate) + '|' + real;
    if (key !== magTitleKey) { magTitleKey = key; box.title = magTitle(a, rl, n, loaded, filling, loadLeft, gate, real); }
  }
  // One slot (or the bar): its state and its fill, each written only when it has changed.
  function magSet(i, state, transform) {
    var p = magParts[i], seen = magSeen[i] || (magSeen[i] = {});
    if (seen.state !== state) { seen.state = state; p.box.setAttribute('data-s', state); }
    if (seen.transform !== transform) { seen.transform = transform; p.fill.style.transform = transform; }
  }
  // The numbers behind the slots, composed only when one of them has changed (paintMag keys it).
  function magTitle(a, rl, n, loaded, filling, loadLeft, gate, real) {
    var sec = function (v) { return aimNum(Math.round(v * 10) / 10); };
    var list = a && a.autoreload && a.autoreload.reloadTime, auto = n > 1 && Array.isArray(list) && list.length > 0;
    var out = n > 1 ? 'Magazine ' + loaded + ' / ' + n + '.'
      : filling === 0 ? 'Loading: ' + Math.ceil(loadLeft) + ' s left of ' + sec(rl.reload) + ' s.' : 'Loaded. The reload takes ' + sec(rl.reload) + ' s.';
    if (n > 1) {
      if (filling === n) out += ' The whole clip is reloading: ' + Math.ceil(loadLeft) + ' s left.';
      else if (filling >= 0) out += ' A round is loading back: ' + Math.ceil(loadLeft) + ' s left.';
      if (gate > 0 && loaded > 0) out += ' The next round in ' + Math.ceil(gate) + ' s.';
      out += ' Rounds ' + sec(rl.interval) + ' s apart';
      if (auto) {
        var k = a.reloadTime > 0 ? rl.reload / a.reloadTime : 1, boost = Number(a.autoreload.boostFraction);
        out += '; each spent round loads back on its own timer, one at a time - from an empty magazine ' +
          list.slice().reverse().map(function (v) { return sec(Number(v) * k); }).join(', ') + ' s.';
        if (boost > 0 && boost < 1) out += ' Improved autoreloader: a round fired once the gun has rested - at least ' +
          sec(rl.interval + (Number(a.autoreload.boostStartTime) || 0)) + ' s into a round’s load and within ' + sec(Number(a.autoreload.boostResidueTime) || 0) +
          ' s of its end, or with the magazine full - loads the next one in ×' + aimNum(boost) + ' of its time under ✸ with ◔.' +
          ' The game’s own numbers; that the cut is ×' + aimNum(boost) + ' rather than less by it is this page’s reading.';
      } else out += '; the whole clip reloads in ' + sec(rl.reload) + ' s once it is empty.';
    }
    if (!real) out += n > 1 ? ' Simplified (✸ or ◔ off): a hold fires what the magazine holds, nothing loads back, and the next press starts full.'
      : ' Simplified (✸ or ◔ off): the reload runs only while the button is held.';
    return out;
  }
  // One shot (user's decision, 19.09: no Alt - it may never reach the page inside the game). The tracer
  // goes exactly down the middle of the LIVE circle, where the gun points: the random offset a real shot
  // gets is the server's, and this page shows the odds, not a rolled die. What the circle was worth at
  // that instant is integrated there and then with 1024 rays and stands on the pinned-shot panel, and a
  // copy of the circle stays on the model beside the tracer until the next shot replaces it (user, 20.09).
  // The live circle itself is never frozen: it goes on aiming through the shot and past it.
  // Whether the gun MAY fire is decided by the caller, not here. `cont`: a round of a burst already on its way (✸).
  function fireShot(cont) {
    var a = aimBlockData();
    if (!aimLive || !a || !viewer || !viewer.liveRadius100) return false;
    var centre = viewer.spreadAim || viewer.liveAimPoint;
    if (!centre) return false;
    var now = aimSeconds();
    dualShot(a, now);   // ✸: a dual-accuracy gun is wider from this very round on (nothing otherwise)
    var mods = aimHeated(aimModifiers()), shell = viewer.shell;
    var chance = shell ? viewer.liveAimProbability(shell, 1024) : null;
    // The fun layer (user, 22.09): with the mode on the shot lands at a point DRAWN inside
    // the live circle instead of at its middle, and the shot line, the pinned panel and the reticle then
    // show that point - it is the same pin, cast down the same line by the same caster. The switch off and
    // this is the centre shot of 0.7.24, call for call.
    var fun = funOn(), point = fun && viewer.liveAimSample ? viewer.liveAimSample(rng) || centre : centre;
    // A pin that refused (no engine, no point) left no verdict of its own, and a shot no line was cast for
    // must not roll damage off the stale one.
    var pinned = viewer.pinAtPoint(point);
    var landed = fun && pinned ? funShot(shell) : null;
    if (viewer.setAimShot) viewer.setAimShot();   // the ring left behind, drawn before the recoil widens the live one
    // The shot's own figure, on the pinned-shot panel and in the colour of its ring (user, 20.09): the
    // same single number the live ring prints - the expected damage over the circle, share of alpha.
    aimShot = circleFigure(chance, shell);
    // The reload first (it names the burst), then the circle: the round's place in a burst decides its term.
    var rl = ArmorBallistics.reloadSeconds(a, mods), real = realReload();
    var times = autoreloadTimes(a, rl);   // an autoloader under real reload, or null
    // Real reload (✸ sub-switch): a clip emptied earlier has been reloaded in full by now - the caller let this
    // round through only once that reload was over - so it starts again from a full clip.
    if (times) refillSettle(now);
    else if (aimClipSize > 1 && real && aimClip <= 0) aimClip = aimClipSize;
    // ✸: the round's place in the gun's burst (a pull starts one of what the magazine holds); the gap after it.
    // A single-shot gun that fires a burst - the Black Rock in its Burst mode, the one such gun of the client - fires the
    // whole burst: its magazine of one does not cap it (BACKLOG 37).
    var burst = burstRule(a, rl), more = burstRound(burst, cont, aimClipSize > 1 ? aimClip : burst ? burst.count : 1);
    var gap = rl ? (more ? burst.interval : rl.interval) : 0;
    // The recoil enters the factor for this very instant and the exponential restarts from it, so the
    // next round of a held burst leaves a wider circle unless the gun had time to settle. Under ✸ the term is
    // the one the client takes for this round (roundState: an automatic gun's stream, a round inside a burst).
    var state = roundState(a, aimLastState || aimState(), more);
    aimNow = ArmorBallistics.aimShot(aimNow, state, a, mods);
    // The round heats an Ares gun under ✸ (gunHeat below) - after the recoil, which is taken in the band
    // the gun was in when it fired; the new band shows from the next frame. Nothing off the ✸ layer.
    heatShot();
    // A tier-XI mechanic takes the round in (BACKLOG 37): the stacks go, the armed designator marks what it hit, a
    // damaging hit feeds the energy or the fury. The reload below was set by the level the round was fired at.
    xiShot(now, landed);
    // The cooldown to the next round of the same hold.
    aimClipDry = false;
    // No reload in the record: the cooldown is unknown, so a hold fires once and waits for the release
    // instead of emptying a magazine at the frame rate.
    if (!rl) { aimReload = null; aimClipDry = true; }
    else if (times) {
      // An autoloader under real reload (the rule is with the ✸ code below): the round leaves the magazine and
      // one starts loading back - or the one already loading goes on - and the next round waits for the gap
      // between rounds or, with the magazine empty, for that load, whose progress the ring then shows. An
      // improved autoloader rested long enough loads that round faster (boostAt).
      var cut = boostAt(a, rl.interval, now);
      aimClip = Math.max(0, aimClip - 1);
      refillShot(times, now, cut);
      aimReload = aimClip > 0 ? {at: now, until: now + gap, clip: true}
        : {at: aimRefill.at, until: Math.max(aimRefill.until, now + gap), clip: false};
    } else if (aimClipSize > 1) {
      aimClip = Math.max(0, aimClip - 1);
      if (aimClip > 0) aimReload = {at: now, until: now + gap, clip: true};
      // The last round of the clip. By default an empty clip simply stops the burst: the clip reload is NOT
      // emulated (user, 20.09 - it would only annoy), letting go and pressing again starts from a full clip.
      // Under real reload the whole reload runs instead, as in the game, and a held burst goes on after it.
      else if (real) aimReload = {at: now, until: now + rl.reload, clip: false};
      else { aimClipDry = true; aimReload = null; }
    } else aimReload = more ? {at: now, until: now + gap, clip: true} : {at: now, until: now + rl.reload, clip: false};
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
    // the shots INSIDE one hold and nothing else. Under ✸ real reload (the sub-switch) the gun keeps its
    // load between presses instead - the clip is refilled here only when this gun's clip size is new.
    // A burst still on its way (✸) keeps its magazine: the press cannot fire before it is out anyway (gunFree).
    var rounds = aimClipRounds();
    if (!(burstLeft > 0) && (!realReload() || rounds !== aimClipSize)) aimLoadFull(rounds);
    aimAutoRounds = 0;   // ✸: an automatic gun's stream starts with the press
    aimHoldTimer = window.setTimeout(holdFire, AIM_HOLD_MS);
    return true;
  }
  // Held long enough without moving: the burst starts with its first shot at this instant - or, when the
  // gun may not fire yet (✸: reloading under real reload, locked by heat), the moment it may: the held
  // burst of aimTick fires it.
  function holdFire() {
    aimHoldTimer = 0;
    if (!aimDown) return;
    aimBurst = true;
    if (gunFree() && fireShot()) paintAim(aimLastState || aimState());
    startAimLoop();
  }
  // Let go. A short press fires its single shot here; a burst has been firing all along and just stops,
  // leaving the ring and the figures of the LAST shot on screen.
  function endShot() {
    cancelHoldTimer();
    if (!aimDown) return;
    var single = !aimBurst;
    aimDown = false; aimBurst = false; aimClipDry = false;
    if (single && gunFree() && fireShot()) paintAim(aimLastState || aimState());
    else paintCircleLines();
    // The reload is shown only while the button is held and the gun fires on its cooldown; a released
    // button leaves a whole ring - the recoil bloom stays, the fill does not (user, 20.09) - and a full clip,
    // which is what the next press starts from (the magazine shows it so). Under ✸ real reload the release
    // changes nothing: the reload runs on and its fill stays on the ring. A gun's burst on its way (✸) runs on
    // through the release, and does this itself once its last round is out (burstNext).
    if (!realReload() && !(burstLeft > 0)) { aimReload = null; aimClip = aimClipSize; }
    aimAutoRounds = 0;   // ✸: the release ends an automatic gun's stream, and its term leaves the circle
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
  // --- ✸: real reload and the heat of an Ares gun (user, 22.09 ~23:30) -----------------------------
  // Both belong to the ✸ layer and nothing of them runs with it off: every entry below asks funOn() first
  // and answers exactly what the page did before (fire at will, no heat, no factor).
  //
  // REAL RELOAD is a sub-switch of ✸, ON by default, kept in the settings box as #real-reload. On, the gun
  // loads as in the game: the reload and the gap between rounds run on after the release, a press before the
  // gun is loaded does not fire, a clip keeps its rounds between presses and is reloaded in full once empty, and
  // an autoloader loads its spent rounds back one at a time (below). Off, the simplified emulation of 20.09: the
  // release resets the cooldown, every press a full clip.
  function realReload() { if (!funOn()) return false; var e = $('real-reload'); return !!(e && e.checked); }
  // May the gun fire at this instant? Asked by the three callers of fireShot() - the tap, the start of a
  // hold and the held burst - beside what they already ask about the reload.
  function gunFree() {
    if (!funOn()) return true;
    // A burst already on its way takes no second pull of the trigger (burstLeft, below): its own rounds go out
    // on their own.
    if (burstLeft > 0) return false;
    // A vehicle switching its mode does not fire, whatever the mode (PlayerAvatar.shoot, siegeState in SWITCHING; 23.09).
    if (xiSwitching()) return false;
    var h = heatNow();
    if (h && h.locked) return false;
    return !realReload() || aimReloadLeft() <= 0;
  }
  // The sub-switch moved: the load starts over under the new rule (a full clip, nothing running).
  function realReloadSettings() {
    aimReload = null; aimClipDry = false; burstLeft = 0;
    if (xiMech && xiMech.stash) xiMech.stash = [null, null];   // a second gun put away starts over too (BACKLOG 37)
    aimLoadFull();
    paintFun();
    if (aimLive && aimNow) paintAim(aimLastState || aimState());
    startAimLoop();
  }
  // AN AUTOLOADER under real reload (user, 22.09 ~24:15): every spent round loads back on its own timer, one
  // round at a time, and the gun fires whatever the magazine holds - a gap of the clip interval between rounds,
  // and with the magazine empty the wait for the round loading. The times are the gun's own tuple,
  // aim.autoreload.reloadTime, scaled by the factors of the reload (rammer, crew: items/utils getClipReloadTime
  // multiplies each entry by the factor of getReloadTime), which is rl.reload / aim.reloadTime here.
  // CLIENT RULE for the order (getFirstReloadTime, ammo_ctrl _GunSettings.fromVehicle, the garage's
  // VehicleParams.autoReloadTime): the LAST entry is the first round into an empty magazine and the garage lists
  // the tuple reversed, in loading order - so with k rounds in, the next one takes reloadTime[N-1-k].
  // OUR APPROXIMATION (the timing itself is the server's): a round fired while another is loading leaves that
  // load its share done, and it goes on at the time of the new count.
  var aimRefill = null;   // {at, until, times} of the round loading now, or null with the magazine full
  // The gun's per-round times, scaled, in the tuple's own order - or null: not under real reload, not an
  // autoloader, no times in the record. `a` and `rl` come from the caller, who has them already.
  // The scaling itself is ArmorBallistics.autoreloadScaled, shared with the characteristics panel (23.09).
  function autoreloadTimes(a, rl) {
    if (!realReload() || !(aimClipSize > 1)) return null;
    return ArmorBallistics.autoreloadScaled(a, rl);
  }
  // The time of the round loaded next with `k` rounds in.
  function refillSeconds(times, k) { var n = times.length; return times[Math.max(0, Math.min(n - 1, n - 1 - k))]; }
  // The magazine brought up to `now`: every round whose load has run out is in, and the next one began loading
  // the instant the last went in. A function of the time alone, so nothing has to run for the rounds to come in.
  function refillSettle(now) {
    while (aimRefill && now >= aimRefill.until) {
      aimClip = Math.min(aimClipSize, aimClip + 1);
      if (aimClip >= aimClipSize) aimRefill = null;
      else aimRefill = {at: aimRefill.until, until: aimRefill.until + refillSeconds(aimRefill.times, aimClip), times: aimRefill.times};
    }
  }
  // A round has just left the magazine (fireShot, after the count went down): one starts loading back, or the
  // one loading goes on at the time of the new count with the share it has done. `fraction` (boostAt below) is
  // the improved autoloader's cut of that load, 1 or nothing for every other round.
  function refillShot(times, now, fraction) {
    var d = refillSeconds(times, aimClip) * (fraction > 0 && fraction < 1 ? fraction : 1), done = 0;
    if (aimRefill) done = Math.max(0, Math.min(1, (now - aimRefill.at) / (aimRefill.until - aimRefill.at)));
    aimRefill = {at: now - done * d, until: now + (1 - done) * d, times: times};
    panelWake();
  }
  // THE IMPROVED AUTOLOADER (C2, 23.09; autoLoaderGunBoost - the seven guns whose aim.autoreload.boostFraction is
  // below 1: Progetto 54 and 66, Bisonte C45, Stone Sentinel, Toro, Rinoceronte, Bélier). CLIENT RULE for the
  // indicator (ammo_ctrl._AutoReloadingBoostStateCtrl): from the start of a round's load it WAITS until the clip
  // interval + boostStartTime, CHARGES until the end of that load - boostResidueTime, and is CHARGED from there on;
  // with the magazine full the last load is long over. A round fired while it is CHARGED "reduces the standard time
  // for autoreloading the next shell" (the client's own text). OUR ASSUMPTION, which only a battle on the Bélier can
  // confirm: the load that shot leaves running takes ×boostFraction of its time - the other reading, less by the
  // fraction, differs only on the Bélier's 0.25 (3.75 s against 11.25 s of a 15 s round). The fraction of this shot,
  // or 1: not an improved autoloader, or not rested long enough. Read before the round leaves the magazine.
  function boostAt(a, interval, now) {
    var r = a && a.autoreload, f = r ? Number(r.boostFraction) : 1;
    if (!(f > 0 && f < 1)) return 1;
    if (!aimRefill) return f;
    var wait = aimRefill.at + (Number(interval) || 0) + (Number(r.boostStartTime) || 0);
    return now >= wait && now >= aimRefill.until - (Number(r.boostResidueTime) || 0) ? f : 1;
  }
  // THE HEAT of the five Ares guns (outputs/gun-overheat-2026-09-22.md; the record carries the gun's own
  // numbers since the build after 0.7.26: aim.temperatureGun and aim.overheatGun). The client's rule:
  //   - every round adds heatingPerShot, and the temperature stays within 0 .. maxTemperature;
  //   - for coolingDelay seconds after a round it stands, then it falls by coolingPerSec a second;
  //   - at tempOverheatOnThreshold the gun is LOCKED: it cools at coolingPerSec × coolingPerSecFactor and
  //     fires again only once it is down to tempOverheatOffThreshold (0 on every Ares);
  //   - the band of thermalStates the temperature lies in multiplies multShotDispersionFactor - the full-aim
  //     circle: none up to 50, ×1.25, then ×1.5 over 88..93 - with the hysteresis on the way down.
  // The simulation is the server's; the numbers and the shape of the rule are the client's
  // (params_utils.getTemperatureRateOfFire, TemperatureMechanicState, OverheatGunAmmoState). Penetration and
  // alpha are untouched.
  // A GUN THAT HEATS WITHOUT EVER LOCKING (B4, 23.09): the STK-2 has temperatureGun and no overheatGun. Its bands
  // are the client's all the same (docs/KNOWLEDGE.md section 4: ×1.227 up to 20 - on the cold gun already -, then
  // ×1.455, ×1.682, ×1.909 and ×2.136; +50 a round, 1 s of rest, 2.8 a second), so it runs the same rule with no
  // lock at all. The choice of 22.09 to leave it alone was caution, not the owner's decision, and the bands are
  // checked against the XML now.
  var gunHeat = null, heatFrom = null, heatSpec = null, panelTimer = 0, heatPaintKey = '', heatTitleKey = '', heatWarnAt = '';
  // A modifier's attribute name as the XML spells it, whatever number of slashes the record joined it with.
  function modName(m) { return String(m && m.name || '').replace(/\/+/g, '/'); }
  // The gun's numbers, normalised once per shooter block.
  function heatParams() {
    var a = aimBlockData();
    if (a === heatFrom) return heatSpec;
    heatFrom = a; heatSpec = null;
    var t = a && a.temperatureGun, o = (a && a.overheatGun) || null;
    if (!t) return null;
    var max = Number(t.maxTemperature), per = Number(t.heatingPerShot), cool = Number(t.coolingPerSec);
    if (!(max > 0) || !(per > 0) || !(cool > 0)) return null;
    // One multiplier of the circle per band, ascending as the client sorts them; a band with no modifier is ×1.
    // Every record since 0.7.27 spells the name 'dynAttrs//multShotDispersionFactor' (the client keeps the kind with its
    // own slash and the mod joined another one on - fixed in the mod 23.09): until then no band was ever applied.
    var states = (Array.isArray(t.thermalStates) ? t.thermalStates : []).map(function (s) {
      var f = 1;
      (s && Array.isArray(s.modifiers) ? s.modifiers : []).forEach(function (m) {
        if (m && m.op === 'mul' && modName(m) === 'dynAttrs/multShotDispersionFactor' && Number(m.value) > 0) f *= Number(m.value);
      });
      return {top: Number(s && s.maxTemperature), factor: f};
    }).filter(function (s) { return s.top > 0; }).sort(function (x, y) { return x.top - y.top; });
    // No overheatGun: no lock (`on` is never reached), no warning mark, and the plain cooling throughout.
    var lock = !!o;
    var on = !lock ? Infinity : Number(o.tempOverheatOnThreshold) > 0 ? Math.min(max, Number(o.tempOverheatOnThreshold)) : max;
    var off = lock && Number(o.tempOverheatOffThreshold) >= 0 ? Math.min(on, Number(o.tempOverheatOffThreshold)) : 0;
    var warn = !lock ? max : Number(o.tempOverheatWarnThreshold) > 0 ? Math.min(on, Number(o.tempOverheatWarnThreshold)) : on;
    var delay = Number(t.coolingDelay) >= 0 ? Number(t.coolingDelay) : 0;
    var slow = lock && Number(o.coolingPerSecFactor) > 0 ? Number(o.coolingPerSecFactor) : 1;
    var hyst = Number(t.thermalStateHysteresis) >= 0 ? Number(t.thermalStateHysteresis) : 0;
    heatSpec = {max: max, per: per, cool: cool, delay: delay, slow: slow, on: on, off: off, warn: warn, hyst: hyst, states: states,
                lock: lock, key: [max, per, cool, delay, slow, on, off].join('|')};
    return heatSpec;
  }
  // The temperature and the lock at `now`, from what the last round left (h.t at h.at) - a pure function of
  // the time, so nothing has to run between two rounds for the gun to cool.
  function heatAt(h, p, now) {
    var t = h.t, locked = h.locked, run = now - h.at - p.delay;
    if (run > 0 && t > 0 && locked) {
      var speed = p.cool * p.slow, need = speed > 0 ? (t - p.off) / speed : Infinity;
      if (run < need) { t -= speed * run; run = 0; }
      else { t = p.off; locked = false; run -= need; }
    }
    if (run > 0 && t > 0 && !locked) t -= p.cool * run;
    return {t: Math.max(0, Math.min(p.max, t)), locked: locked};
  }
  // The band the temperature lies in: up as soon as a band's top is passed, down only once the temperature is
  // the hysteresis below the top of the band beneath. -1 for a gun with no bands.
  function heatBand(p, t, prev) {
    var n = p.states.length;
    if (!n) return -1;
    var i = prev >= 0 && prev < n ? prev : 0;
    while (i < n - 1 && t > p.states[i].top) i++;
    while (i > 0 && t < p.states[i - 1].top - p.hyst) i--;
    return i;
  }
  // The gun's heat right now, or null: off the ✸ layer, and for every gun that does not overheat.
  function heatNow() {
    var p = funOn() ? heatParams() : null;
    if (!p) { gunHeat = null; return null; }
    if (!gunHeat || gunHeat.key !== p.key) gunHeat = {key: p.key, t: 0, at: -Infinity, locked: false, band: -1};
    var now = aimSeconds(), s = heatAt(gunHeat, p, now);
    gunHeat.band = heatBand(p, s.t, gunHeat.band);
    return {p: p, t: s.t, locked: s.locked, band: gunHeat.band, now: now};
  }
  // A round has left the barrel (fireShot).
  function heatShot() {
    var h = heatNow();
    if (!h) return;
    var t = Math.min(h.p.max, h.t + h.p.per);
    gunHeat.t = t; gunHeat.at = h.now; gunHeat.locked = h.locked || t >= h.p.on;
    gunHeat.band = heatBand(h.p, t, gunHeat.band);
    panelWake();
  }
  // The circle's multiplier of the present band, applied where the client applies it: on the full-aim factor
  // (the `mult` of ArmorBallistics.aimFactor). The same object comes back untouched off ✸ or for a cold band.
  // The dual-accuracy factor (dualNow, below) is a factor on the same ideal and goes on the same `mult`.
  function aimHeated(mods) {
    if (!funOn()) return mods;
    var h = heatNow(), f = (h && h.band >= 0 ? h.p.states[h.band].factor : 1) * dualNow();
    if (f !== 1 && mods) mods.mult *= f;
    return xiApply(mods);   // a tier-XI mode or ability in force (BACKLOG 37); nothing for every other vehicle
  }
  // THE GUN PANEL'S OWN TIMER, a light 10 Hz one for what moves on the panel with the frame loop asleep: a warm
  // gun cooling, and a round of an autoloader loading back. It repaints the bar - the whole panel while a round
  // loads, each part of it skipping what has not changed - wakes the loop only when the heat band, and with it
  // the circle, has changed, and stops by itself once the gun is cold and the magazine full. With the emulation
  // off a loading round no longer keeps it going: the load is a function of the time, taken up at the next paint.
  function panelWake() { if (!panelTimer) panelTimer = window.setTimeout(panelTick, 100); }
  function panelTick() {
    panelTimer = 0;
    var band = gunHeat ? gunHeat.band : -1, h;
    if (aimRefill && aimLive) h = paintGunLoad();
    else { h = heatNow(); paintHeat(h); }
    if (h && h.band !== band) startAimLoop();
    if ((h && (h.t > 0 || h.locked)) || (aimRefill && aimLive)) panelWake();
  }
  // ✸ switched, a new shooter, the emulation reset: a cold gun and no timer - and nothing left of a burst, an
  // automatic gun's stream or a dual-accuracy penalty (circleReset, below).
  function gunHeatReset() {
    gunHeat = null;
    if (panelTimer) window.clearTimeout(panelTimer);
    panelTimer = 0;
    paintHeat(null);
    circleReset();
  }
  // Seconds until a locked gun fires again: what is left of the delay, then the slow fall to the unlock mark.
  function heatUnlockIn(h) {
    if (!h || !h.locked || !gunHeat) return 0;
    var speed = h.p.cool * h.p.slow;
    return Math.max(0, gunHeat.at + h.p.delay - h.now) + (speed > 0 ? Math.max(0, h.t - h.p.off) / speed : Infinity);
  }
  var HEAT_COLD = [120, 170, 210], HEAT_WARM = [234, 195, 110], HEAT_HOT = [251, 133, 128];
  function heatRgb(h) {
    if (h.locked || h.t >= h.p.warn) return 'rgb(' + HEAT_HOT.join(',') + ')';
    var k = h.p.warn > 0 ? Math.max(0, Math.min(1, h.t / h.p.warn)) : 0;
    return 'rgb(' + HEAT_COLD.map(function (c, i) { return Math.round(c + (HEAT_WARM[i] - c) * k); }).join(',') + ')';
  }
  // The bar in the gun panel: graphics only, the figures in its tooltip (the owner's rule). Every write is
  // skipped when nothing it shows has changed, so the per-frame call of paintGunLoad costs a comparison.
  function paintHeat(h) {
    var box = $('aim-gun-heat'), fill = $('aim-gun-heat-fill');
    if (!box || !fill) return;
    if (box.hidden !== !h) box.hidden = !h;
    if (!h) { heatPaintKey = ''; heatTitleKey = ''; return; }
    var p = h.p, width = (h.t / p.max * 100).toFixed(1) + '%', key = width + (h.locked ? '|L' : '');
    if (key !== heatPaintKey) {
      heatPaintKey = key;
      fill.style.width = width;
      fill.style.backgroundColor = heatRgb(h);
      box.setAttribute('data-locked', h.locked ? '1' : '0');
    }
    // A gun that never locks has no warning either: the mark is put away (B4).
    var mark = $('aim-gun-heat-warn'), at = p.lock ? (p.warn / p.max * 100).toFixed(1) + '%' : 'none';
    if (mark && at !== heatWarnAt) { heatWarnAt = at; mark.hidden = !p.lock; if (p.lock) mark.style.left = at; }
    var left = heatUnlockIn(h), title = Math.round(h.t) + '|' + h.band + '|' + (h.locked ? Math.ceil(left) : '') + '|' + p.key;
    if (title === heatTitleKey) return;
    heatTitleKey = title;
    var bands = [];
    // The first band carries a factor too on a gun that is wider from the first round (the STK-2's ×1.227).
    p.states.forEach(function (s, i) {
      if (s.factor === 1) return;
      bands.push('×' + aimNum(s.factor) + (i > 0 ? ' above ' + aimNum(p.states[i - 1].top) : ' up to ' + aimNum(s.top)));
    });
    var now = h.band >= 0 ? p.states[h.band].factor : 1;
    box.title = 'Gun heat ' + Math.round(h.t) + ' / ' + aimNum(p.max) + (h.locked ? ' — overheated, fires again in ' + Math.ceil(left) + ' s' : '') +
      '. Each round adds ' + aimNum(p.per) + '; after ' + aimNum(p.delay) + ' s without firing the gun cools ' + aimNum(p.cool) +
      ' a second.' + (p.lock ? ' At ' + aimNum(p.on) + ' it overheats and locks: it cools at ×' + aimNum(p.slow) + ' (' + aimNum(p.cool * p.slow) +
      ' a second) and fires again only at ' + aimNum(p.off) + '. The mark is the warning at ' + aimNum(p.warn) + '.'
        : ' It never overheats: this gun has no lock.') +
      (bands.length ? ' The aiming circle is ' + bands.join(', ') + ' — now ×' + aimNum(now) + '.' : '') +
      ' The game’s own numbers for this gun; the ✸ emulation runs them, the server keeps the real temperature.';
  }
  // --- ✸: the circle after a round, and one pull = the whole burst (23.09, BACKLOG 35-36) --------------------------
  // The client's formula takes the after-shot term by three branches (ArmorBallistics.shotTerm) and multiplies the
  // ideal of a dual-accuracy gun after a shot; the game fires a burst gun's whole burst on one pull of the trigger.
  // All of it belongs to the ✸ layer: every entry asks funOn() first and leaves the old call exactly as it was off
  // the layer and for every gun without the mechanic.
  //
  // THE BURST (C1; gun.burst, 57 vehicles: Donnola 3 × 0.3 s, Char Mle. 75 3 × 0.5 s, Durendal and MBT-B 2 × 0.5 s,
  // 121-2 Ziqiang 2 × 0.75 s, the autocannons of tiers I-IV). One pull fires min(burst count, rounds in the magazine)
  // rounds burst.interval apart, whether the button is still down or not; a pull during it is refused. Every round
  // with more of the burst after it takes afterShotInBurst (B1), the last one afterShot. The next pull waits the clip
  // interval after the last round, or the reload of an empty magazine - OUR READING of the client's two rates (the
  // server times the rounds). `syncReloading` (the Black Rock only) is not modelled: the client stores it and reads
  // it nowhere. The Black Rock fires its burst only in the Burst mode of its chargeableBurst, which the ✸ mode button
  // switches (BACKLOG 37, xiBurstOn below); single rounds otherwise.
  var burstLeft = 0;   // rounds of the running burst still to go after the one just fired
  // The gun's burst under ✸, {count, interval} (ArmorBallistics.reloadSeconds reads it off the record), or null.
  function burstRule(a, rl) {
    var b = rl && rl.burst;
    if (!b || !(b.count > 1) || !funOn()) return null;
    var mech = a && Array.isArray(a.gunMechanics) ? a.gunMechanics : [];
    return mech.indexOf('chargeableBurst') >= 0 && !xiBurstOn() ? null : b;
  }
  // This round's place in the burst: a pull (`cont` false) starts one of what the magazine holds (`have`), a round
  // of a running burst (`cont` true) counts it down. True while more of the burst follow this round.
  function burstRound(b, cont, have) {
    if (!b) { burstLeft = 0; return false; }
    burstLeft = cont ? Math.max(0, burstLeft - 1) : Math.max(0, Math.min(b.count, have > 0 ? have : 1) - 1);
    return burstLeft > 0;
  }
  // THE AUTOMATIC GUN (B2; aim.autoShoot - the five Ares, PGZ-70, Blesk, Šelma, Squall, Tesák): its controller's term
  // grows n·shotDispersionPerShot with the n-th round of a stream (Ares 90: ×1.10 after the first round, ×4.6 after
  // the tenth; the page drew ×4.12 from the first) and stays in the circle while the stream goes on. The stream is
  // one press: it ends with the release, a lock or an empty magazine. The aimingDelay (0.3 s on the Ares) the server
  // may keep the term after the last round has no reader in the client and is not modelled.
  var aimAutoRounds = 0;
  function autoGun(a) { return !!(a && a.autoShoot && Number(a.autoShoot.shotDispersionPerShot) > 0); }
  // The state a round is fired in: the frame's own state when nothing of the above applies (exactly the old call),
  // else a copy with the round's term (and `hold` for an automatic gun).
  function roundState(a, base, more) {
    var s = base || {}, fun = funOn(), auto = fun && autoGun(a);
    if (!auto && !(fun && more && a.afterShotInBurstFactor >= 0)) {
      // A frame state that still carries a stream's term (✸ switched off in the middle of one) is not handed on.
      return s.hold || s.shotTerm !== undefined ? {speed: s.speed, hullTurn: s.hullTurn, hullMax: s.hullMax, turretTurn: s.turretTurn} : base;
    }
    if (auto) aimAutoRounds++;
    var r = ArmorBallistics.shotTerm(a, aimAutoRounds, more);
    return {speed: s.speed, hullTurn: s.hullTurn, hullMax: s.hullMax, turretTurn: s.turretTurn, shotTerm: r.term, hold: r.hold};
  }
  // Every frame of a stream the controller's term stays in the ideal; it goes the moment the stream stops.
  function autoHold(a, state) {
    if (!(aimAutoRounds > 0)) return;
    var h = funOn() && autoGun(a) ? heatNow() : null;
    if (!funOn() || !autoGun(a) || !aimDown || !aimBurst || aimClipDry || (h && h.locked)) { aimAutoRounds = 0; return; }
    state.shotTerm = ArmorBallistics.shotTerm(a, aimAutoRounds, false).term; state.hold = true;
  }
  // DUAL ACCURACY (B3; aim.dualAccuracy - SZDV Vz. 50, Type 63 HT, Type 57, Type 68, Type 71, Kame, Ashigaru,
  // Headshaker). CLIENT RULE (Avatar.getOwnVehicleShotDispersionAngle 3327-3331, DualAccuracy._collectComponentParams):
  // while the component is ACTIVE the ideal factor is multiplied by afterShotDispersionAngle / shotDispersionAngle -
  // Type 71 0.22 -> 0.38 m/100 m, ×1.73; Kame ×2.0. That ACTIVE follows a shot is derived (the factor is above 1 on all
  // nine); that it lasts dualAccuracy.coolingDelay seconds after every round is OUR ASSUMPTION - the server switches
  // the state. It starts with the round itself, so its own bloom is wider by the factor too. A timer wakes the frame
  // loop when it runs out, so a ring that has settled at the wider circle narrows again without a mouse move.
  var dualUntil = -Infinity, dualTimer = 0;
  function dualParams(a) {
    var d = a && a.dualAccuracy, f = d && a.dispersion > 0 ? Number(d.afterShotDispersionAngle) / a.dispersion : 0;
    var delay = d ? Number(d.coolingDelay) : 0;
    return f > 0 && isFinite(f) && f !== 1 && delay > 0 ? {factor: f, delay: delay} : null;
  }
  function dualNow() {
    if (!(dualUntil > -Infinity)) return 1;
    var d = dualParams(aimBlockData());
    return d && aimSeconds() < dualUntil ? d.factor : 1;
  }
  function dualShot(a, now) {
    var d = funOn() ? dualParams(a) : null;
    if (!d) return;
    dualUntil = now + d.delay;
    if (dualTimer) window.clearTimeout(dualTimer);
    dualTimer = window.setTimeout(function () { dualTimer = 0; startAimLoop(); }, d.delay * 1000 + 20);
  }
  function heatLocked() { var h = heatNow(); return !!(h && h.locked); }
  // A round of the running burst (aimTick). Under the simplified reload a burst whose button is already up leaves
  // the gun as a release does - full, nothing running - once its last round is out.
  function burstNext() {
    if (!fireShot(true)) { burstLeft = 0; return; }
    if (!(burstLeft > 0) && !aimDown && !realReload()) { aimReload = null; aimClip = aimClipSize; aimClipDry = false; }
  }
  // Nothing of the above survives ✸ switching, a new shooter or the emulation starting over (gunHeatReset).
  function circleReset() {
    burstLeft = 0; aimAutoRounds = 0; dualUntil = -Infinity;
    if (dualTimer) window.clearTimeout(dualTimer);
    dualTimer = 0;
    xiReset();   // the tier-XI mechanic starts over from the record (below)
    paintXi();
  }
  // --- The fun layer: target HP, a rolled shot and Hitmarks (user, 22.09) --------------------------
  // ONE switch, and it stands ON THE SCENE beside the collision-model tile, not in Settings (user, 22.09:
  // the health bar appears there, and it has to be plain that the switch turns on more than the bar). It
  // lights in the page's accent while it is down and turns the health bar, the RNG shot and the Hitmarks
  // on together; its state is kept by the settings machinery in a hidden control of the Settings menu
  // (#fun-mode), OFF by default. With it off nothing below runs at all and a shot is exactly the shot of
  // 0.7.24, call for call.
  // With it on a shot stops flying through the middle of the ring: the impact point is DRAWN inside the
  // circle from the very law that circle's own figure is integrated with (viewer.liveAimSample -> the
  // profile's quantile), the line is cast and judged by the one path a shot has always taken (pinAtPoint
  // -> refreshPin -> engine.ray, whose result comes back on viewer.pinResult), and the verdict is then
  // rolled instead of read as odds.
  function funOn() { var e = $('fun-mode'); return !!(e && e.checked); }
  // The random source of this layer, Math.random by default. A harness puts its own seeded function on
  // window.BullbaHitsRng and every draw below takes it - one lookup per roll, nothing per frame.
  function rng() { var f = window.BullbaHitsRng; return typeof f === 'function' ? f() : Math.random(); }
  // WHOSE health the bar shows: the vehicle ON SCREEN, which is the target of the hit being displayed -
  // never the hit itself (user, 22.09: picking another shooter does not change the target, so the bar
  // must not go and the ↺ must still fill it). The roster of the battle carries the hit points since
  // 0.7.20: `maxHealth` is the value of THIS battle - Onslaught writes its own through the battle
  // modifiers - and `defaultMaxHealth` the stock one. The row is found, in this order:
  //   - a recorded hit names the vehicle outright (targetId);
  //   - a shooter picked from the roster leaves the model where it is, and pickShooter carries the id of
  //     the vehicle already on screen over on the synthetic hit (modelVehicleId);
  //   - a swapped view has no ids of its own and names the hit it was made from: the vehicle now on
  //     screen is that hit's SHOOTER;
  //   - failing all of them, the roster row of the same vehicle type when the battle holds exactly one.
  // With no row at all - a browsed vehicle, a battle without a roster - the vehicle's OWN export gives the
  // figure since the characteristics build (23.09, spec 2.3): `maxHealth` of the configuration it was exported
  // in (targetMaxHp). An older export has none, and then there is no bar rather than a made-up number.
  function targetRow(hit) {
    var rows = current && Array.isArray(current.roster) ? current.roster : null;
    if (!rows || !hit) return null;
    var id = hit.targetId;
    if (id === undefined || id === null) id = hit.modelVehicleId;
    if ((id === undefined || id === null) && hit.synthetic && hit.base && !hit.chosenShooter) {
      var base = (current.hits || []).find(function (h) { return h.id === hit.base; });
      if (base) id = base.attackerId;
    }
    var row = id === undefined || id === null ? null : rows.find(function (r) { return r.id === id; });
    if (row) return row;
    var type = String((hit.target || {}).type || '');
    var same = type ? rows.filter(function (r) { return String(r.type || '') === type; }) : [];
    return same.length === 1 ? same[0] : null;
  }
  function targetMaxHp(hit) {
    var row = targetRow(hit);
    if (!row) { var own = hit && hit.target ? Number(hit.target.maxHealth) || ttxHealth(hit.target) : 0; return own > 0 ? own : 0; }
    var hp = Number(row.maxHealth) > 0 ? Number(row.maxHealth) : Number(row.defaultMaxHealth);
    return hp > 0 ? hp : 0;
  }
  // What the health belongs to, so a NEW vehicle can be told from the same one under another shooter:
  // the battle plus the roster row, or the vehicle's own type and name when the record has no row for it.
  function targetKey(hit) {
    var row = targetRow(hit), t = (hit && hit.target) || {};
    return (current ? String(current.id) : '-') + '|' +
      (row ? 'r' + row.id : 't' + String(t.type || '') + '/' + String(t.name || ''));
  }
  var hpMax = 0, hpLeft = 0, hpRoll = '', hpTitleKey = '', hpKey = '', hpPressed = '';
  // What the Hitmarks are made of, kept so they can be laid again on a scene the viewer has rebuilt under
  // the SAME vehicle: viewer.load() drops everything the viewer holds, and picking another shooter loads
  // the model again although the target has not changed. ONE record per SHOT (funMark) - every plate it
  // met, each in the coordinates of its own part - handed straight to the viewer and kept as it is:
  // nothing about a mark is worked out or stored twice.
  var funMarks = [];
  // The spread of the damage roll. The shell carries its own `damageRandomization` (0.25 on the stock
  // shells, 0.12 in the Onslaught records), and shellAt puts it on the shell object for a saved candidate
  // as for a manual one, so this is the record's number and not a constant.
  function funRandomization(shell) {
    var s = shell ? Number(shell.damageRandomization) : NaN;
    return s >= 0 && s <= 1 ? s : .25;
  }
  // ASSUMPTION, said out loud in the bar's tooltip and in docs/KNOWLEDGE.md §2: the roll is drawn
  // UNIFORMLY over the band. The client stores the KIND of the roll (`damageRandomizationType`, NORMAL on
  // every shell of this build) but not its arithmetic - the damage roll is made on the cellapp - so the
  // shape of the spread is this page's guess. Nothing else on the page depends on it.
  function funRoll(base, shell) { return base * (1 + (rng() * 2 - 1) * funRandomization(shell)); }
  var FUN_PEN = 'pen', FUN_NONE = 'no-pen', FUN_RICOCHET = 'ricochet', FUN_UNKNOWN = 'unknown';
  // One shot, ONE penetration roll - the very model the figures on screen are built on (ballistics.js
  // withDamage): the shell passes a screen when the roll beats that screen's own plate and pierces the
  // hull when it beats the main plate too. So a uniform u below `chance` is a penetration, u between
  // `chance` and the screen-pass chance is a non-penetration on the main armour (the page's HE law gives
  // what that is worth, `nonPen`), and above it the shell was stopped on a screen and does nothing at all.
  // `u` rides along with the verdict so the Hitmarks can tell WHICH screen stopped a shell (the first whose
  // own pass chance the roll did not beat); nothing else reads it.
  function funVerdict(r, shell) {
    if (!r) return {outcome: FUN_UNKNOWN, base: 0};
    // A shell that glanced off and flew clear of the hull ends as 'no-hull' with the bounce on record: that is
    // a ricochet, not a shot without an estimate (the bar's tooltip said 'no estimate' for it until 22.09).
    if (r.reason === 'ricochet' || (r.reason === 'no-hull' && r.bounce)) return {outcome: FUN_RICOCHET, base: 0};
    if (r.reason === 'screen') return {outcome: FUN_NONE, base: 0};
    if (r.reason === 'no-hull' || r.chance === null || r.chance === undefined) return {outcome: FUN_UNKNOWN, base: 0};
    var p = Math.max(0, Math.min(1, r.chance / 100));
    var pass = r.screenPass === undefined || r.screenPass === null ? 1 : r.screenPass;
    var u = rng();
    if (u < p) return {outcome: FUN_PEN, base: shell && shell.alpha > 0 ? shell.alpha : 0, u: u};
    return {outcome: FUN_NONE, base: u < pass && r.nonPen > 0 ? r.nonPen : 0, u: u};
  }
  // A Hitmark carries NO colour of the chance palette (user, 22.09: the discs of 0.7.26 were painted in the
  // very colours of the hit map and melted into it). The outcome is handed to the viewer as it stands and
  // the viewer cuts the decal that belongs to it - a hole, a scrape or a graze - so there is one outcome
  // word in this page and no second palette beside the map's.
  var FUN_WORDS = {pen: 'penetration', 'no-pen': 'no penetration', ricochet: 'ricochet', unknown: 'no estimate'};
  function hpNumber(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  // What one emulated shot does once its line has been cast and judged. Everything here reads the result
  // of the ONE ray pinAtPoint has just cast: nothing is cast, sampled or evaluated a second time.
  // Returns what the round did - {v, damage, kill} - for the tier-XI mechanics that count hits (xiShot).
  // A Borkenkäfer's mark on the target (BACKLOG 38, xiMarkNow) multiplies the roll by its stock ×1.1.
  function funShot(shell) {
    if (!viewer) return null;
    var r = viewer.pinResult, pin = viewer.pinned, mark = xiMarkNow();
    var v = funVerdict(r, shell), damage = v.base > 0 ? funRoll(v.base, shell) * (mark ? mark.factor : 1) : 0, kill = false;
    if (hpMax > 0) {
      kill = hpLeft > 0 && hpLeft - damage <= 0;
      hpLeft = Math.max(0, hpLeft - damage);
      hpRoll = 'Last shot: ' + FUN_WORDS[v.outcome] + (damage > 0 ? ', ' + hpNumber(damage) + ' HP' + (mark ? ' (×' + mark.factor + ': the target carries a Borkenkäfer mark)' : '') : ', no damage') + '.';
    }
    if (pin && pin.point) funMark(v, shell);
    paintFun();
    return {v: v, damage: damage, kill: kill};
  }
  // One shot's Hitmarks: ONE record, made by the viewer out of the ray this shot has already cast (every
  // plate the path met - a hole in each screen passed, this shot's outcome where it ended, a skid where it
  // glanced off and the plate it flew into next - each with its part and in that part's own coordinates, so
  // the marks turn with the turret and gun and land on the same spot when laid again), handed to the viewer
  // to draw and kept as it is so a scene the viewer rebuilds can have the very same marks back. The verdict
  // goes in as rolled; the shell's calibre gives the footprint (0.7 of it, no floor); the roll that turns a
  // square-on mark round its line is drawn HERE, once, and travels with the record: a mark laid again must
  // be the same mark, vertex for vertex, not a freshly turned one. A shot that met no armour at all has
  // nothing to cut a decal out of, and a shell with no calibre in the record has no size to cut one at: the
  // viewer refuses both, and then nothing is kept either - the shot's verdict and its damage above stand all
  // the same. All the plates of one shot are ONE entry of the cap, which is the viewer's own, asked for.
  function funMark(v, shell) {
    var caliber = shell && Number(shell.caliber) > 0 ? Number(shell.caliber) : 0, roll = rng() * Math.PI * 2;
    var shot = viewer && viewer.hitMarkShot ? viewer.hitMarkShot(v, caliber, roll) : null;
    if (!shot || !viewer.addHitMark || !viewer.addHitMark(shot)) return;
    funMarks.push(shot);
    var cap = viewer.hitMarkLimit ? viewer.hitMarkLimit() : funMarks.length;
    while (funMarks.length > cap) funMarks.shift();
  }
  // The bar is graphics and nothing else (the owner's rule: no words on a tile) - every number is in its
  // tooltip. Called on a shot, on a reset, on a model change and when the switch moves; never per frame.
  function paintFun() {
    var bar = $('target-hp'), fill = $('target-hp-fill'), reset = $('target-hp-reset'), toggle = $('fun-mode-toggle');
    if (!bar || !fill || !reset) return;
    var on = funOn(), model = !$('model-tile').hidden, show = on && model && hpMax > 0;
    // The switch lives with the model: it is there whenever there is something to shoot at, and it is lit
    // while the mode is on. One attribute write, and only when the state has really changed.
    if (toggle) {
      toggle.hidden = !model;
      var pressed = String(on);
      if (pressed !== hpPressed) { hpPressed = pressed; toggle.setAttribute('aria-pressed', pressed); }
    }
    // Its sub-switch, real reload, stands beside it only while the mode is on, lit while it is on itself.
    var sub = $('real-reload-toggle'), subBox = $('real-reload');
    if (sub) {
      sub.hidden = !(on && model);
      var subPressed = String(!!(subBox && subBox.checked));
      if (sub.getAttribute('aria-pressed') !== subPressed) sub.setAttribute('aria-pressed', subPressed);
    }
    bar.hidden = !show;
    reset.hidden = !(on && model);
    if (!show) return;
    var share = Math.max(0, Math.min(1, hpLeft / hpMax)), width = (share * 100).toFixed(1) + '%';
    if (fill.style.width !== width) fill.style.width = width;
    var rgb = chanceRgb({chance: Math.round(share * 100), expectedShare: share});
    if (fill.style.backgroundColor !== rgb) fill.style.backgroundColor = rgb;
    // The sentence is long and paintFun runs on every shell or distance step too: it is composed only when
    // one of the four things in it has really changed.
    var mark = xiMarkNow();
    var key = hpLeft + '/' + hpMax + '|' + hpRoll + '|' + funRandomization(viewer && viewer.shell) + '|' + (mark ? Math.ceil(mark.left) + mark.from : '');
    if (key === hpTitleKey) return;
    hpTitleKey = key;
    bar.title = hpNumber(hpLeft) + ' / ' + hpNumber(hpMax) + ' HP' +
      (hpLeft <= 0 ? ' · destroyed; further shots still leave Hitmarks' : '') + '. ' + (hpRoll || 'Nothing fired yet.') +
      ' Each hit rolls its damage as alpha × (1 ± ' + Math.round(funRandomization(viewer && viewer.shell) * 100) +
      ' %), the shell’s own spread from the record; a hit that does not pierce rolls the reconstructed' +
      ' non-penetration damage the same way. The SHAPE of that roll is drawn uniformly - the client stores' +
      ' the kind of the roll but makes it on the server, so it is this page’s assumption, not a confirmed rule.' +
      (mark ? ' The target carries a leKpz Borkenkäfer mark' + (mark.from === 'record' ? ' (the record’s, at this hit)' : '') + ' - ' + Math.ceil(mark.left) +
        ' s left: every hit on it rolls ×' + mark.factor + ', the stock factor (×1.15 with the marker’s full skill tree, which the record cannot tell).' : '');
  }
  // Full health again and no Hitmarks: the ↺ button, and every change of the vehicle on screen. The
  // health is looked up for the vehicle ON SCREEN, so ↺ brings the bar back whenever the record knows it.
  function funReset() {
    hpKey = targetKey(activeHit);
    hpMax = targetMaxHp(activeHit); hpLeft = hpMax; hpRoll = '';
    xiMarkState = null;   // an emulated Borkenkäfer mark goes with the health; the record's own comes back (BACKLOG 38)
    funMarks.length = 0;
    if (viewer && viewer.clearHitMarks) viewer.clearHitMarks();
    paintFun();
  }
  // The scene has just been rebuilt (display()). A DIFFERENT vehicle starts at full health with no marks;
  // the SAME vehicle under another shooter keeps both - the target did not change (user, 22.09) - and its
  // Hitmarks are laid on the new model again, because viewer.load() clears everything the viewer held.
  function funModel() {
    if (targetKey(activeHit) !== hpKey) { funReset(); return; }
    funMarks.forEach(function (m) { if (viewer && viewer.addHitMark) viewer.addHitMark(m); });
    paintFun();
  }
  // The switch moved: the viewer is told whether an emulated shot leaves a dot or the big cross, the marks
  // of a mode switched off go with it, and a mode switched on starts the target at full health.
  function funSettings() {
    var on = funOn();
    if (viewer) {
      if (viewer.setHitMarks) viewer.setHitMarks(on);
      if (!on && viewer.clearHitMarks) viewer.clearHitMarks();
    }
    if (!on) funMarks.length = 0;
    if (on && !(hpMax > 0)) { hpKey = targetKey(activeHit); hpMax = targetMaxHp(activeHit); hpLeft = hpMax; hpRoll = ''; }
    // The gun under the other rule starts over: cold, loaded, a full clip - and the loop is woken, so the
    // circle drops the heat band it may have been drawn in.
    gunHeatReset();
    aimReload = null; aimClipDry = false; aimLoadFull();
    paintFun();
    startAimLoop();
    // The characteristics panel's mode switch follows ✸ (the emulator's mode under it, the panel's own off it).
    if (ttxData) ttxPaint();
  }
  // Everything the emulation holds, back to a standing, loaded, fully aimed shooter.
  function resetAimRun() {
    cancelHoldTimer();
    aimKeys = {}; aimMove = null; aimNow = null; aimReload = null;
    aimDown = false; aimBurst = false; aimClipDry = false;
    aimShot = null; aimLastState = null; aimHeading = 0;
    // The hull faces the gun again: its yaw in the shooter's sector starts from the middle (BACKLOG 40).
    if (viewer) { viewer.aimHold = false; viewer.aimYaw = 0; if (viewer.clearAimShot) viewer.clearAimShot(); }
    aimLoadFull();
    gunHeatReset();   // a new shooter's gun, or the emulation starting over, is cold
  }
  // --- ✸: the tier XI mechanics, one mode button (23.09, BACKLOG 37-38) ----------------------------------------------
  // Eleven vehicles carry a mechanic of their own that changes the circle, the reload or the gun that fires
  // (outputs/mechanics-impact-2026-09-23.md and -xi.md, docs/KNOWLEDGE.md section 4). Under ✸ ONE button in the gun
  // panel runs the one this shooter has (#aim-gun-mech: the page's lit switch .swap-roles, a glyph per mechanic, every
  // word in its tooltip - the owner's decision of 23.09, docs/CONTEXT.md). It is there only under ✸ and only for these
  // vehicles, and it starts from the state the record gives for the shot - shotContext.gunState, the tracer's before
  // the impact's - or, with none recorded, from the mechanic's default. The numbers are the stock ones of the vehicle
  // files of client 2.4.0.1 (the recorded state carries the battle's own where it has them). Every factor goes on the
  // very `mods` the circle, the movement and the reload are computed with (aimHeated, xiApply), so there is no second
  // circle formula here: a mechanic only scales what ArmorBallistics already takes. The timers are functions of the
  // time (xiAdvance), like the heat, and one timeout (xiWake) wakes the loop at the next change. Off ✸ nothing here
  // runs (xiNow is null) and every caller gets exactly what it got before.
  //
  // The XM69's gyro and the Black Rock's Burst mode share one set of modifiers - the XM69 adds two of its own:
  // A179_Black_Rock.xml chargeableBurst movement, rotation and turretRotation ×0.0, aiming time ×0.3 (and
  // burstDispersionFactor 1); A183_XM69_Hacker.xml the same four plus multShotDispersionFactor ×0.94 and the hull's
  // rotation speed ×1.1 (and engine power ×1.1, which the circle does not read).
  var XI_GYRO = {movement: 0, rotation: 0, turret: 0, aimingTime: 0.3};
  var XI_RAD = Math.PI / 180;
  // The secondary gun of a vehicle whose record carries no aim.secondary (every record before the build after 0.7.29):
  // the gun's own XML (turrets0/<turret>/secondaryGuns). The exported block, when there is one, is used instead.
  var XI_HORI_GUN = {installation: 1, name: '_12_cm_Shisei_Funshinhou', dispersion: Math.atan(0.0015), aimingTime: 1.0,
    turretRotationFactor: 0.10 / XI_RAD, afterShotFactor: 1.0, reloadTime: 60, clip: [1, 0], gunTags: []};
  var XI_TASCHEN_GUN = {installation: 1, name: '_8_cm_8H62_2', dispersion: Math.atan(0.0035), aimingTime: 1.9,
    turretRotationFactor: 0.05 / XI_RAD, afterShotFactor: 1.2, reloadTime: 50, clip: [2, 0.5], burst: [2, 0.5, false], gunTags: ['clip']};
  var XI_MECHANICS = {
    'poland:Pl37_CS_67_Szakal': {mech: 'stanceDance', name: 'CS-67 Szakal', glyph: '⇋', kind: 'stance', switchTime: 3,
      energyMax: 100, energyPerSec: 0.6, energyPerHit: 15, fightTime: 13,
      turbo: {aimingTime: 1.9, movement: 1.9, rotation: 1.9, turret: 1.9, afterShot: 1.66, speedForwardKmh: 15, speedBackwardKmh: 5},
      fight: {mult: 0.8, aimingTime: 0.75, reload: 0.8}},
    'usa:A183_XM69_Hacker': {mech: 'concentrationMode', name: 'XM69 Hacker', glyph: '◎', kind: 'ability', duration: 10, cooldown: 40, deploy: 40,
      mods: {movement: 0, rotation: 0, turret: 0, aimingTime: 0.3, mult: 0.94, hullSpeed: 1.1}},
    'sweden:S36_Strv_107_12': {mech: 'pillboxSiegeMode', name: 'Strv 107-12', glyph: '▣', kind: 'siege',
      pill: {fromDrive: 5, fromSiege: 3, toSiege: 3, toDrive: 4, mods: {mult: 0.85, reload: 0.925, speed: 0, hullSpeed: 0.4}},
      siege: {kind: 'hydraulic', switchOnTime: 2, switchOffTime: 1, switchCancelEnabled: false, stopEngineOnSwitch: true, device: 'engine'}},
    'germany:G188_LeKpz_Borkenkafer': {mech: 'targetDesignator', name: 'leKpz Borkenkäfer', glyph: '⊕', kind: 'designator', deploy: 60, cooldown: 25, markTime: 10},
    'japan:J53_Ho_Ri_Shugo': {mech: 'auxiliaryRocketLauncher', name: 'Ho-Ri Shugo', glyph: '✦', kind: 'weapon', gun: XI_HORI_GUN, what: 'the auxiliary rocket launcher'},
    'germany:G187_Taschenratte': {mech: 'supportWeapon', name: 'Taschenratte', glyph: '✦', kind: 'weapon', gun: XI_TASCHEN_GUN, what: 'the support mortar'},
    'usa:A179_Black_Rock': {mech: 'chargeableBurst', name: 'Black Rock', glyph: '»', kind: 'burst', mods: XI_GYRO},
    'germany:G185_Leopard_120_Verbessert': {mech: 'accuracyStacks', name: 'Leopard 120 Verbessert', glyph: '≡', kind: 'stacks', levelMax: 4, bonus: 0.04, gainTime: 5, gainMaxKmh: 20},
    'usa:A182_T803': {mech: 'battleFury', name: 'T803', glyph: '⇈', kind: 'fury', levelMax: 5, duration: 9.5, bonus: 0.02, perHit: 1, perKill: 2},
    'italy:It43_CAV_mod_71': {mech: 'autoreloaderSurge', name: 'CAV mod. 71', glyph: '↯', kind: 'surge', maxCharges: 3, startCharges: 1, chargeRegular: 50, chargeFull: 18, reloadTime: 8.5},
    'france:F135_AS_XX_40_t': {mech: 'stationaryReload', name: 'AS-XX 40 t', glyph: '⧖', kind: 'skip',
      why: 'The stationary reload: preparingDelay 4.5 s and finishingDelay 3 s (2.5 and 1.5 s in the garage with the full skill tree). The client carries these numbers but not the rule the server runs them by - when the vehicle counts as standing, what the gun lock mask holds - so the emulation does not run it.'},
    'france:F136_AMX_67_Imbattable': {mech: 'extraShotClip', name: 'AMX 67 Imbattable', glyph: '⊞', kind: 'skip',
      why: 'The extra shot: extraReloadTime 4.5 s (2.5 with the full skill tree). The client carries the number, but not what the extra round does to the reload or what the values of its reloadState mean, so the emulation does not run it.'},
    'uk:GB152_AT_FV230_Breaker': {mech: 'powerMode', name: 'AT-FV230 Breaker', glyph: '⇶', kind: 'skip',
      why: 'Direct Drive: after 18 s of driving forward faster than 7 km/h it builds up in 3 s to speed ×1.35, hull traverse ×0.7, engine power ×1.36 and dispersion ×2.0. Which term of the circle that ×2.0 doubles the client does not say (it never reads it) - blocked until a battle on the Breaker shows it in the server’s own factors of the shot (aimAtTracer.targeting).'}
  };
  var XI_SECONDARY_CLEAR = {afterShotInBurstFactor: undefined, burst: undefined, autoreload: undefined, autoShoot: undefined,
    dualAccuracy: undefined, dualGun: undefined, twinGun: undefined, temperatureGun: undefined, overheatGun: undefined,
    heatingZonesGun: undefined, gunMechanics: undefined, clip: [1, 0]};
  var xiMech = null, xiTimer = 0, xiAimView = null, xiShellBack = '', xiPaintKey = '', xiTitleKey = '', xiSpecHit = null, xiSpecVal = null, xiSpecTtx = null;
  // The words of the button's aria-label, by kind (the three the emulation does not run carry their own).
  var XI_LABEL = {stance: 'Stance', ability: 'Gyro-stabiliser', designator: 'Target designator', weapon: 'Second gun',
    burst: 'Burst mode', stacks: 'Accuracy stacks', fury: 'Battle fury', surge: 'Autoloader surge', rocket: 'Rocket booster'};
  // THE SECOND MODES (23.09, outputs/second-modes-2026-09-23.md 5.2): the same button, kind 'siege', for every vehicle
  // whose aim block names its mode switch (aim.siegeMode: the record since the build after 0.7.31, an older record at
  // publish, else the shooter's pair in his characteristics file). A glyph per kind of mode, lit in the second mode, the
  // words in the tooltip: the client's own names of the modes (menu.mo "Siege / Travel", "Rapid / Cruise", the turbine's
  // "engine modes"). The automatic siege is an indicator: the server switches it by the speed. The charged salvo of the
  // dual guns and the shell switchers get no button (section 5.5).
  var SIEGE_KINDS = {
    hydraulic: {glyph: '⤓', label: 'Siege mode', on: 'siege', off: 'travel', switchOn: 'into siege', switchOff: 'into travel'},
    turboshaft: {glyph: '≫', label: 'Engine mode', on: 'the turbine', off: 'the normal engine mode', switchOn: 'to the turbine', switchOff: 'to the normal mode'},
    wheeled: {glyph: '↠', label: 'Speed mode', on: 'Rapid', off: 'Cruise', switchOn: 'to Rapid', switchOff: 'to Cruise'},
    twinGun: {glyph: '∥', label: 'Salvo mode', on: 'the salvo', off: 'single rounds', switchOn: 'to the salvo', switchOff: 'to single rounds'},
    auto: {glyph: '∠', label: 'Hull tilt', on: 'the hull tilting (siege)', off: 'level (travel)'}};
  // The client's defaults of _readSiegeModeParams (vehicles.pyc 11215) for a field the block does not carry.
  function siegeNum(v, fallback) { var n = Number(v); return v !== null && v !== undefined && isFinite(n) && n >= 0 ? n : fallback; }
  // The mode switch of the shooter: the record's block, else his pair's in the characteristics file, else `base`.
  function siegeModeOf(hit, base) {
    var at = hit.attacker, sm = at.aim && at.aim.siegeMode;
    if (sm && SIEGE_KINDS[sm.kind]) return {sm: sm, a: at.aim, from: 'record'};
    if (ttxData && TTX && hit === activeHit) {
      var i = ttxEmuIndex(), pa = i >= 0 ? ttxData.configs[i].aim : null;
      if (pa && pa.siegeMode && SIEGE_KINDS[pa.siegeMode.kind]) return {sm: pa.siegeMode, a: pa, from: 'ttx'};
    }
    return base && base.siege ? {sm: base.siege, a: at.aim || {}, from: 'default'} : null;
  }
  function siegeSpecOf(hit, base) {
    var got = siegeModeOf(hit, base);
    if (!got) return null;
    var sm = got.sm, k = SIEGE_KINDS[sm.kind], at = hit.attacker, name = base ? base.name : String(at.name || at.type || 'This vehicle');
    var second = sm.kind === 'auto' ? null : modeAimOf(hit), hull = got.a.hullAiming && got.a.hullAiming.pitch;
    // No second block anywhere (a record before the build after 0.7.28 published by an older build, no characteristics
    // file): the button is dimmed with the reason - the switch alone would move nothing. The Strv 107-12 keeps its
    // pillbox on the recorded block, as it did before.
    if (!second && sm.kind !== 'auto' && !base) {
      return {mech: 'siegeMode', name: name, glyph: k.glyph, kind: 'skip', label: k.label,
        why: k.label + ': the second mode’s numbers come with the vehicle’s characteristics file, and this vehicle has none yet (the game writes it in the garage), so the emulation cannot switch it.'};
    }
    return {mech: base ? base.mech : 'siegeMode', kind: 'siege', mode: sm.kind, name: name, glyph: base ? base.glyph : k.glyph, label: k.label,
      on: siegeNum(sm.switchOnTime, 2), off: siegeNum(sm.switchOffTime, 2), cancel: sm.switchCancelEnabled === true,
      stop: sm.stopEngineOnSwitch !== false, device: sm.device || 'engine',
      autoOn: siegeNum(sm.autoOn, 0.1 * KMH_TO_MS), autoOff: siegeNum(sm.autoOff, 1.0 * KMH_TO_MS),
      tilt: hull ? {min: Number(hull.min) || 0, max: Number(hull.max) || 0, speed: Number(hull.speed) || 0} : null,
      pill: base ? base.pill : null, rapid: sm.kind === 'wheeled' ? rapidTurnOf(hit) : null, second: second, from: got.from};
  }
  // RAPID TURNS SLOWER (23.09, the user's word): the client narrows the wheels' steering lock in Rapid (EBR 33° -> 15°)
  // and has no hull traverse of its own for the mode. At a given speed a wheeled hull turns as the tangent of its lock
  // (the bicycle model), so in Rapid the hull traverse is x tan(Rapid) / tan(Cruise), 0.413 on the EBR - our estimate,
  // closer to the game than the full traverse. The two locks are the characteristics file's (Cruise on the chassis,
  // Rapid in modeValues); without the file the traverse stays the block's.
  function rapidTurnOf(hit) {
    var ch = ttxData && hit === activeHit && ttxData.modules ? ttxData.modules.chassis : null, mv = ttxData && ttxData.vehicle ? ttxData.vehicle.modeValues : null;
    var cruise = ch ? Number(ch.maxSteeringLockAngle) : NaN, rapid = mv ? Number(mv.maxSteeringLockAngle) : NaN;
    if (!(cruise > 0 && cruise < 90 && rapid > 0 && rapid < cruise)) return null;
    return {hullSpeed: Math.tan(rapid * Math.PI / 180) / Math.tan(cruise * Math.PI / 180), cruise: cruise, rapid: rapid};
  }
  // THE ROCKET BOOSTER (23.09, part 2; rocketAcceleration, sixteen vehicles - docs/KNOWLEDGE.md section 4): an ability
  // like the XM69's gyro. Its numbers are the shooter's characteristics file's (vehicle.rocketAcceleration): the mod
  // writes them from type.rocketAccelerationParams. No record carries them, so without the file there is no button.
  function rocketSpecOf(hit) {
    var at = hit.attacker, r = ttxData && hit === activeHit && ttxData.vehicle ? ttxData.vehicle.rocketAcceleration : null;
    if (!r || !(Number(r.duration) > 0)) return null;
    var mods = {};
    (Array.isArray(r.modifiers) ? r.modifiers : []).forEach(function (m) {
      var v = Number(m && m.value), n = modName(m);
      if (!(m && m.op === 'mul' && v >= 0 && isFinite(v))) return;
      if (n === 'dynAttrs/vehicle/maxSpeed/forward') mods.forwardSpeed = v;
      else if (n === 'dynAttrs/vehicle/maxSpeed/backward') mods.backwardSpeed = v;
      else if (n === 'dynAttrs/vehicle/rotationSpeed') mods.hullSpeed = v;
      else if (n === 'dynAttrs/engine/power') mods.power = v;
    });
    return {mech: 'rocketAcceleration', kind: 'rocket', name: String(at.name || at.type || 'This vehicle'), glyph: '⇮',
      duration: Number(r.duration), cooldown: siegeNum(r.reloadTime, 0), deploy: siegeNum(r.deployTime, 0),
      uses: Number(r.reuseCount) > 0 ? Math.floor(Number(r.reuseCount)) : Infinity, mods: mods};
  }
  // The mechanic of the shooter on screen, or null. A gun whose record names chargeableBurst is the Black Rock's.
  function xiSpecOf(hit) {
    var at = hit && hit.attacker;
    if (!at) return null;
    var s = XI_MECHANICS[String(at.type || '')];
    if (s && s.kind !== 'siege') return s;
    var sg = siegeSpecOf(hit, s);
    if (sg) return sg;
    var list = at.aim && Array.isArray(at.aim.gunMechanics) ? at.aim.gunMechanics : [];
    if (list.indexOf('chargeableBurst') >= 0) return XI_MECHANICS['usa:A179_Black_Rock'];
    return rocketSpecOf(hit);
  }
  // The recorded state the emulation starts from and the server time it belongs to (the tracer's, else the hit's), so
  // a timer the record gives - endTime - runs on for exactly what it had left.
  function xiRecorded(hit) {
    var ctx = shotContext && activeHit === hit ? shotContext : null, st = ctx && ctx.gunState;
    var tr = ctx && ctx.gunStateFrom === 'shot' ? ctx.tracer : null;
    var ref = tr && Number.isFinite(Number(tr.gameTime)) ? Number(tr.gameTime) : Number(hit && hit.gameTime);
    var siege = ctx && ctx.tracer && Number.isFinite(ctx.tracer.siegeState) ? ctx.tracer.siegeState : hit && hit.attacker ? hit.attacker.siegeStateAtImpact : null;
    return {state: st && typeof st === 'object' ? st : {}, ref: Number.isFinite(ref) ? ref : NaN, siege: Number.isFinite(siege) ? siege : null,
            slot: hit ? Number(hit.gunInstallationIndex) : NaN};
  }
  function xiLeft(rec, end) { var e = Number(end); return Number.isFinite(e) && Number.isFinite(rec.ref) && e > rec.ref ? e - rec.ref : 0; }
  function xiNum(v, fallback) { var n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; }
  // A fresh state for this hit: the recorded one where the record has it, the mechanic's default otherwise.
  function xiInit(spec, hit, now) {
    var rec = xiRecorded(hit), st = rec.state, m = {spec: spec, hit: hit, record: false}, g, code, left;
    switch (spec.kind) {
      case 'stance':
        // STANCE_DANCE_STATE bits (constants of client 2.4.0.1): 1 turbo, 2 switching, 4 the fight ability, 8 the turbo one.
        g = st.stanceDance && st.stanceDance.abilityState;
        code = g ? Number(g.state) || 0 : 0;
        m.stance = code & 1 ? 1 : 0; m.to = null; m.until = 0;
        m.energy = g && Number(g.energyFight) >= 0 ? Math.min(spec.energyMax, Number(g.energyFight)) : 0; m.energyAt = now;
        // The ability's own TIME_INTERVAL is not recorded: an ability on at the shot runs its full time from here.
        m.fightUntil = code & 4 ? now + spec.fightTime : 0;
        m.record = !!g;
        break;
      case 'ability':
        // CONCENTRATION_MODE_STATE: 0 idle, 1 deploying, 2 ready, 3 active, 4 cooldown, 5 disabled.
        g = st.concentrationMode && st.concentrationMode.status;
        code = g ? Number(g.state) : NaN; left = g ? xiLeft(rec, g.endTime) : 0;
        m.state = code === 3 && left > 0 ? 'active' : code === 4 && left > 0 ? 'cooldown' : code === 1 && left > 0 ? 'deploy' : 'ready';
        m.until = m.state === 'ready' ? 0 : now + left;
        m.record = !!g;
        break;
      case 'siege':
        // VEHICLE_SIEGE_STATE: 0 DISABLED, 1 SWITCHING_ON, 2 ENABLED, 3 SWITCHING_OFF, 4 PILLBOX_ENABLED (the Strv
        // 107-12's publicStatus carries the same numbers); st 0 travel, 1 the second mode, 2 the pillbox.
        g = spec.pill ? st.pillboxSiegeMode && st.pillboxSiegeMode.publicStatus : null;
        m.st = (g && Number(g.state) === 4) || (spec.pill && rec.siege === 4) ? 2 : rec.siege !== null && rec.siege >= 2 ? 1 : 0;
        m.to = null; m.until = 0; m.refused = 0;
        // The automatic siege: on at a standstill, the recorded state where there is one.
        m.on = spec.mode === 'auto' ? (rec.siege !== null ? rec.siege >= 2 : true) : false;
        m.record = !!g || rec.siege !== null;
        break;
      case 'rocket':
        // ROCKET_ACCELERATION_STATE: 0 NOT_RUNNING, 1 DEPLOYING, 2 PREPARING, 3 READY, 4 ACTIVE, 5 DISABLED, 6 EMPTY.
        g = st.rocketAcceleration && st.rocketAcceleration.stateStatus;
        code = g ? Number(g.status) : NaN; left = g ? xiLeft(rec, g.endTime) : 0;
        m.uses = g && Number(g.reuseCount) >= 0 && Number.isFinite(Number(g.reuseCount)) ? Math.floor(Number(g.reuseCount)) : spec.uses;
        m.state = code === 4 && left > 0 ? 'active' : code === 2 && left > 0 ? 'cooldown' : code === 1 && left > 0 ? 'deploy'
          : code === 6 || !(m.uses > 0) ? 'empty' : 'ready';
        m.until = m.state === 'active' || m.state === 'cooldown' || m.state === 'deploy' ? now + left : 0;
        m.record = !!g;
        break;
      case 'designator':
        // TARGET_DESIGNATOR_STATE: 0 ready, 1 active (the next shot marks), 2 cooldown, 3 pre-battle.
        g = st.targetDesignator && st.targetDesignator.abilityState;
        code = g ? Number(g.state) : NaN; left = g ? xiLeft(rec, g.endTime) : 0;
        m.state = code === 1 ? 'armed' : code === 2 && left > 0 ? 'cooldown' : code === 3 && left > 0 ? 'deploy' : 'ready';
        m.until = m.state === 'cooldown' || m.state === 'deploy' ? now + left : 0;
        m.record = !!g;
        break;
      case 'weapon':
        // The hit's own gun slot names the gun that fired it; the recorded secondaryGun index is the same reading.
        g = st.secondaryGun;
        m.weapon = rec.slot === 1 || (g && Number(g.gunInstallationIndex) === 1) ? 1 : 0;
        m.stash = [null, null];
        m.record = Number.isFinite(rec.slot) || !!g;
        break;
      case 'burst':
        g = st.chargeableBurst;
        m.burst = !!(g && g.isBurstActive === true);
        m.record = !!(g && typeof g.isBurstActive === 'boolean');
        break;
      case 'stacks':
        // The recorded ability state carries the battle's own numbers (the tree's included): taken where it has them.
        g = st.accuracyStacks && st.accuracyStacks.abilityState;
        m.max = Math.round(xiNum(g && g.maxLevel, spec.levelMax));
        m.bonus = xiNum(g && g.aimLevelBonus, spec.bonus);
        m.gainTime = xiNum(g && g.gainTime, spec.gainTime);
        m.gainKmh = xiNum(g && g.gainMaxSpdKmh, spec.gainMaxKmh);
        m.level = g && Number(g.curLevel) >= 0 ? Math.min(m.max, Math.floor(Number(g.curLevel))) : 0;
        m.since = now; m.slow = true;
        m.record = !!g;
        break;
      case 'fury':
        g = st.battleFury && st.battleFury.abilityState;
        m.max = Math.round(xiNum(g && g.maxLevel, spec.levelMax));
        m.level = g && Number(g.currentLevel) >= 0 ? Math.min(m.max, Math.floor(Number(g.currentLevel))) : 0;
        m.at = now;
        m.record = !!g;
        break;
      case 'surge':
        g = st.autoreloaderSurge && st.autoreloaderSurge.abilityState;
        m.charges = g && Number(g.charges) >= 0 ? Math.min(spec.maxCharges, Math.floor(Number(g.charges))) : spec.startCharges;
        m.chargeAt = now; m.boostUntil = 0;
        m.record = !!g;
        break;
    }
    return m;
  }
  // The state brought up to `now`: every switch, ability, cooldown and level whose time has come. A function of the
  // time and of the frame's own speed (the Leopard's stacks), so nothing has to run between two events.
  function xiAdvance(m, now) {
    var s = m.spec, n, guard;
    switch (s.kind) {
      case 'stance':
        // The fight energy builds in the fight stance, not while switching and not while the ability runs (reading).
        for (guard = 0; guard < 16; guard++) {
          var t = m.energyAt, accrue = m.stance === 0 && m.to === null && !(m.fightUntil > t);
          var tSwitch = m.to !== null ? m.until : Infinity, tEnd = m.fightUntil > t ? m.fightUntil : Infinity;
          var tFull = accrue ? t + Math.max(0, s.energyMax - m.energy) / s.energyPerSec : Infinity;
          var next = Math.min(tSwitch, tEnd, tFull);
          if (!(next <= now)) break;
          if (accrue) m.energy = Math.min(s.energyMax, m.energy + (next - t) * s.energyPerSec);
          m.energyAt = next;
          if (next === tSwitch) { m.stance = m.to; m.to = null; }
          else if (next === tEnd) m.fightUntil = 0;
          else { m.fightUntil = next + s.fightTime; m.energy = 0; }
        }
        if (m.stance === 0 && m.to === null && !(m.fightUntil > m.energyAt)) m.energy = Math.min(s.energyMax, m.energy + Math.max(0, now - m.energyAt) * s.energyPerSec);
        m.energyAt = Math.max(m.energyAt, now);
        break;
      case 'ability':
        for (guard = 0; guard < 4 && m.until > 0 && now >= m.until; guard++) {
          if (m.state === 'active') { m.state = 'cooldown'; m.until += s.cooldown; }
          else { m.state = 'ready'; m.until = 0; }
        }
        break;
      case 'siege':
        // The mode changes on the EDGE of the switch (VEHICLE_SIEGE_STATE.getMode): the old one holds until it ends.
        if (m.to !== null && now >= m.until) { m.st = m.to; m.to = null; }
        break;
      case 'rocket':
        for (guard = 0; guard < 4 && m.until > 0 && now >= m.until; guard++) {
          if (m.state === 'active') { if (m.uses > 0) { m.state = 'cooldown'; m.until += s.cooldown; } else { m.state = 'empty'; m.until = 0; } }
          else { m.state = m.uses > 0 ? 'ready' : 'empty'; m.until = 0; }
        }
        break;
      case 'designator':
        if ((m.state === 'cooldown' || m.state === 'deploy') && now >= m.until) { m.state = 'ready'; m.until = 0; }
        break;
      case 'stacks':
        if (m.slow && m.level < m.max) {
          n = Math.floor((now - m.since) / m.gainTime);
          if (n > 0) { m.level = Math.min(m.max, m.level + n); m.since += n * m.gainTime; }
        }
        if (!m.slow || m.level >= m.max) m.since = now;
        break;
      case 'fury':
        if (m.level > 0) {
          n = Math.floor((now - m.at) / s.duration);
          if (n > 0) { m.level = Math.max(0, m.level - n); m.at += n * s.duration; }
        } else m.at = now;
        break;
      case 'surge':
        // One charge every chargeTimeSRegular, or chargeTimeSFullClip with the magazine full - the fullness of now.
        for (guard = 0; guard < 8 && m.charges < s.maxCharges; guard++) {
          var step = aimClipSize > 1 && aimClip >= aimClipSize && !aimRefill ? s.chargeFull : s.chargeRegular;
          if (now - m.chargeAt < step) break;
          m.charges++; m.chargeAt += step;
        }
        if (m.charges >= s.maxCharges) m.chargeAt = now;
        break;
    }
  }
  // The mechanic's state now, or null: off ✸ and for every other vehicle. A new hit starts from its own record.
  function xiNow() {
    if (!funOn()) return null;
    // The spec depends on the shooter's characteristics file too (the second block, the rocket), which may arrive later.
    if (xiSpecHit !== activeHit || xiSpecTtx !== ttxData) { xiSpecHit = activeHit; xiSpecTtx = ttxData; xiSpecVal = xiSpecOf(activeHit); }
    var spec = xiSpecVal;
    if (!spec) { xiMech = null; return null; }
    var now = aimSeconds();
    if (!xiMech || xiMech.hit !== activeHit || xiMech.spec !== spec) {
      xiMech = spec.kind === 'skip' ? {spec: spec, hit: activeHit, record: false} : xiInit(spec, activeHit, now);
      // The circle, the reload and the panel take the new state at the next frame; the timer the next change.
      startAimLoop(); xiWake();
      return xiMech;
    }
    if (spec.kind !== 'skip') xiAdvance(xiMech, now);
    return xiMech;
  }
  // The factor sets in force, or null: they go on the circle's and the reload's own mods (xiApply).
  function xiFactors(m, now) {
    var s = m.spec, out = [];
    switch (s.kind) {
      case 'stance':
        if (m.stance === 1) out.push(s.turbo);
        if (m.fightUntil > now) out.push(s.fight);
        break;
      case 'ability': case 'rocket': if (m.state === 'active') out.push(s.mods); break;
      case 'siege':
        if (m.st === 2 && s.pill) out.push(s.pill.mods);
        if (m.st === 1 && s.rapid) out.push({hullSpeed: s.rapid.hullSpeed});
        break;
      case 'burst': if (m.burst) out.push(s.mods); break;
      case 'stacks': if (m.level > 0) out.push({mult: Math.max(0, 1 - m.bonus * m.level)}); break;
      case 'fury': if (m.level > 0) out.push({reload: Math.max(0, 1 - s.bonus * m.level)}); break;
    }
    return out.length ? out : null;
  }
  // The mechanic's factors multiplied into a copy of the shooter's mods (aimModifiers hands out a copy): the circle's
  // own keys, the after-shot term and the speed cap (ballistics.js aimMods), and the turbo's km/h on the speed terms.
  function xiApply(mods) {
    var m = mods ? xiNow() : null, sets = m && m.spec.kind !== 'skip' ? xiFactors(m, aimSeconds()) : null;
    if (!sets) return mods;
    sets.forEach(function (set) {
      Object.keys(set).forEach(function (k) {
        var v = set[k];
        if (k === 'speedForwardKmh') mods.speedForwardAdd = (Number(mods.speedForwardAdd) || 0) + v * KMH_TO_MS;
        else if (k === 'speedBackwardKmh') mods.speedBackwardAdd = (Number(mods.speedBackwardAdd) || 0) + v * KMH_TO_MS;
        else mods[k] = (mods[k] === undefined || mods[k] === null ? 1 : Number(mods[k])) * v;
      });
    });
    return mods;
  }
  // The mode the emulated vehicle is in: 1 in the second mode and in the Strv 107-12's pillbox, 0 in travel - the
  // switch starts from the recorded state, so until the first press this is the recorded mode. aimOfHit then takes the
  // other descriptor's block (modeAimOf). undefined - the recorded mode decides, as without ✸ - for every other vehicle
  // and for the automatic siege, whose second block differs only in the hull's tilt.
  function xiSiegeMode(m) { return m && m.spec.kind === 'siege' && m.spec.mode !== 'auto' ? (m.st >= 1 ? 1 : 0) : undefined; }
  // A switch of the mode is running (and takes time): the gun does not fire (PlayerAvatar.shoot), and with
  // stopEngineOnSwitch the vehicle stops.
  function xiSwitching() { var m = xiMech && funOn() ? xiNow() : null; return !!(m && m.spec.kind === 'siege' && m.to !== null); }
  // The secondary gun in force (Ho-Ri Shugo, Taschenratte): its own block laid over the vehicle's - the exported
  // aim.secondary, else the gun's own XML figures - with the main gun's own mechanics taken away. The vehicle's
  // factors, the chassis and the crew stay the vehicle's. One view per block, so the aim cache keeps working.
  function xiAim(a, m) {
    if (!a || !m || m.spec.kind !== 'weapon' || m.weapon !== 1) return a;
    var sec = a.secondary && a.secondary.dispersion > 0 ? a.secondary : m.spec.gun;
    if (!xiAimView || xiAimView.base !== a || xiAimView.sec !== sec) {
      xiAimView = {base: a, sec: sec, view: Object.assign({}, a, XI_SECONDARY_CLEAR, sec,
        {gunTags: Array.isArray(sec.gunTags) ? sec.gunTags : [], secondaryFrom: sec === m.spec.gun ? 'xml' : 'record'})};
    }
    return xiAimView.view;
  }
  function xiBurstOn() { var m = xiNow(); return !!(m && m.spec.kind === 'burst' && m.burst); }
  // THE MARK ON THE TARGET (BACKLOG 38): a Borkenkäfer's mark makes every shell deal the vehicle ×1.1 (stock
  // damageIncomeFactor; ×1.15 with the marker's full tree, which only the window of the shell choice allows for). The
  // target on screen carries it when the record says so at this hit (ArmorShotContext.markOf: what it had left then),
  // or when an emulated Borkenkäfer shot marked it. It belongs to the TARGET, like its health: another shooter on the
  // same vehicle keeps it, a new vehicle or a new recorded hit starts from its own record, and ↺ clears it.
  var XI_MARK = 1.1, xiMarkState = null;
  function xiMarkNow() {
    if (!funOn()) return null;
    var now = aimSeconds(), key = targetKey(activeHit), own = activeHit && !activeHit.synthetic ? activeHit.id : null;
    if (!xiMarkState || xiMarkState.target !== key || (own !== null && xiMarkState.hitId !== own)) {
      var rec = own !== null && ArmorShotContext.markOf ? ArmorShotContext.markOf(activeHit) : null;
      xiMarkState = {target: key, hitId: own, until: rec ? now + rec.left : 0, from: rec ? 'record' : ''};
    }
    return xiMarkState.until > now ? {factor: XI_MARK, left: xiMarkState.until - now, from: xiMarkState.from} : null;
  }
  function xiMarkSet(until) { xiMarkNow(); xiMarkState.until = until; xiMarkState.from = 'shot'; }
  // One emulated round has left the barrel (fireShot, after its damage was rolled). `landed`: what funShot made of it.
  function xiShot(now, landed) {
    var m = xiNow();
    if (!m || m.spec.kind === 'skip') return;
    var s = m.spec, v = landed && landed.v, touched = !!(v && v.outcome && v.outcome !== FUN_UNKNOWN), dealt = !!(landed && landed.damage > 0);
    switch (s.kind) {
      case 'stacks':   // levelAfterShot 0: every round takes the stacks away
        m.level = 0; m.since = now;
        break;
      case 'designator':   // the armed round marks what it hit; the cooldown runs from the round
        if (m.state === 'armed') {
          m.state = 'cooldown'; m.until = now + s.cooldown;
          if (touched) { xiMarkSet(now + s.markTime); paintFun(); }   // the health bar's tooltip names the mark
        }
        break;
      case 'stance':   // +15 for a hit that deals damage (passiveFightEnergyBonusPerHit), in the fight stance
        if (dealt && m.stance === 0 && m.to === null && !(m.fightUntil > now)) {
          m.energy = Math.min(s.energyMax, m.energy + s.energyPerHit); m.energyAt = now;
          if (m.energy >= s.energyMax && !(m.fightUntil > now)) { m.fightUntil = now + s.fightTime; m.energy = 0; }
        }
        break;
      case 'fury':   // +1 a damaging hit, +2 more for the one that destroys the target
        if (dealt) { m.level = Math.min(m.max, m.level + s.perHit + (landed.kill ? s.perKill : 0)); m.at = now; }
        break;
    }
    xiWake();
  }
  // The frame's own speed, for the Leopard's stacks: they build only below gainMaxSpd.
  function xiMotion(speed) {
    var m = xiMech && funOn() ? xiNow() : null;
    // The automatic siege: on at or below autoOn, off above autoOff - a hysteresis, as the thresholds' names say (the
    // switching itself is the server's). The circle does not change; only the button and its tooltip follow.
    if (m && m.spec.kind === 'siege' && m.spec.mode === 'auto') {
      var v = Math.abs(Number(speed) || 0), on = m.on ? !(v > m.spec.autoOff) : v <= m.spec.autoOn;
      if (on !== m.on) { m.on = on; paintXi(); }
      return;
    }
    if (!m || m.spec.kind !== 'stacks') return;
    var slow = Math.abs(Number(speed) || 0) < m.gainKmh * KMH_TO_MS;
    if (slow === m.slow) return;
    m.slow = slow; m.since = aimSeconds();
    xiWake();
  }
  // The next moment the state changes by itself, or Infinity.
  function xiNext(m) {
    var s = m.spec;
    switch (s.kind) {
      case 'stance':
        var t = m.to !== null ? m.until : Infinity;
        if (m.fightUntil > m.energyAt) t = Math.min(t, m.fightUntil);
        else if (m.stance === 0 && m.to === null) t = Math.min(t, m.energyAt + Math.max(0, s.energyMax - m.energy) / s.energyPerSec);
        return t;
      case 'ability': case 'designator': case 'rocket': return m.until > 0 ? m.until : Infinity;
      case 'siege': return m.to !== null ? m.until : Infinity;
      case 'stacks': return m.slow && m.level < m.max ? m.since + m.gainTime : Infinity;
      case 'fury': return m.level > 0 ? m.at + s.duration : Infinity;
      case 'surge': return m.charges < s.maxCharges ? m.chargeAt + s.chargeFull : Infinity;
    }
    return Infinity;
  }
  // One timeout at the next change: it wakes the frame loop (the circle and the reload take the new factors) and
  // repaints the panel, then sets itself for the change after. Nothing runs while nothing is due.
  function xiWake() {
    if (xiTimer) window.clearTimeout(xiTimer);
    xiTimer = 0;
    var m = funOn() ? xiMech : null;
    if (!m || m.spec.kind === 'skip') return;
    var due = xiNext(m) - aimSeconds();
    if (!(due < Infinity)) return;
    xiTimer = window.setTimeout(function () { xiTimer = 0; xiNow(); startAimLoop(); paintXi(); xiModePanel(); xiWake(); }, Math.max(0, due) * 1000 + 20);
  }
  // Nothing of it survives ✸ switching, a new shooter or the emulation starting over (circleReset).
  function xiReset() {
    xiMech = null; xiAimView = null; xiMarkState = null; xiSpecHit = null; xiSpecVal = null; xiSpecTtx = null; xiShellBack = '';
    xiHoldCancel();
    if (xiTimer) window.clearTimeout(xiTimer);
    xiTimer = 0;
  }
  // THE PRESS. What it does is the mechanic's: a stance or a mode switched, an ability started, a gun chosen.
  function xiPress(e) {
    var m = xiNow();
    if (!m || m.spec.kind === 'skip') return;
    var s = m.spec, now = aimSeconds();
    switch (s.kind) {
      case 'stance':
        if (m.to === null) { m.to = 1 - m.stance; m.until = now + s.switchTime; m.energyAt = now; }
        break;
      case 'ability':
        if (m.state === 'ready') { m.state = 'active'; m.until = now + s.duration; }
        break;
      case 'rocket':
        if (m.state === 'ready' && m.uses > 0) { m.state = 'active'; m.until = now + s.duration; m.uses--; }
        break;
      case 'siege':
        // The Strv 107-12 tells a touch from a hold on the pointer itself (xiDown/xiUp); its click does nothing, but a
        // click without a pointer (the keyboard: detail 0) is a touch.
        if (s.pill && !(e && e.detail === 0)) return;
        xiSiegeTap(m, now);
        break;
      case 'designator':
        if (m.state === 'ready') m.state = 'armed';
        else if (m.state === 'armed') m.state = 'ready';
        break;
      case 'weapon': xiWeapon(m); break;
      case 'burst': m.burst = !m.burst; break;
      case 'surge': xiSurge(m, now); break;
    }
    xiPressed();
  }
  function xiPressed() {
    paintAimMechanics();
    paintGunLoad();
    startAimLoop();
    xiModePanel();
    xiWake();
  }
  // A second mode switched: the characteristics panel shows the emulator's mode under ✸ (one state), so it is painted
  // again - at the press and at the end of the switch, never per frame.
  function xiModePanel() { if (xiMech && xiMech.spec.kind === 'siege' && ttxData) ttxPaint(); }
  // A TOUCH of the mode key (the key X of the client; SiegeModeControl): the second mode on or off, in the switch
  // time of that direction; during a switch a touch cancels it only where the client allows it (switchCancelEnabled).
  // The turbine switches only standing (the client's help, detailsHelp/engineMode: "requires a full stop"): refused on
  // the move. The automatic siege takes no key at all. From the Strv 107-12's pillbox a touch goes to the siege mode.
  function xiSiegeTap(m, now) {
    var s = m.spec;
    if (s.mode === 'auto') return;
    if (m.to !== null) { if (s.cancel) { m.to = null; m.until = 0; } return; }
    if (s.mode === 'turboshaft' && aimMove && Math.abs(Number(aimMove.speed) || 0) > 0.1 * KMH_TO_MS) { m.refused = now; return; }
    if (m.st === 2) xiSiegeGo(m, 1, s.pill.toSiege, now);
    else if (m.st === 1) xiSiegeGo(m, 0, s.off, now);
    else xiSiegeGo(m, 1, s.on, now);
  }
  // A HOLD of 1 s, the Strv 107-12 only (PillboxSiegeComponent HOLD_TIME): into the pillbox - 5 s from travel, 3 s from
  // siege - or out of it to travel, 4 s.
  function xiSiegeHold(m, now) {
    var p = m.spec.pill;
    if (!p || m.to !== null) return;
    if (m.st === 2) xiSiegeGo(m, 0, p.toDrive, now);
    else xiSiegeGo(m, 2, m.st === 1 ? p.fromSiege : p.fromDrive, now);
  }
  // An instant switch (the French wheeled vehicles, 0 s) is done at once; any other runs its time.
  function xiSiegeGo(m, to, seconds, now) {
    m.refused = 0;
    if (!(seconds > 0)) { m.st = to; m.to = null; m.until = 0; return; }
    m.to = to; m.until = now + seconds;
  }
  // THE TOUCH AND THE HOLD on the button, the client's own times (PillboxSiegeComponent TAP_TIME 0.25 s, HOLD_TIME 1.0 s):
  // released before 0.25 s - a touch; held 1 s - the hold goes off while still held; released in between - nothing, as
  // the client's __onHoldCanceled. Left button only (the game's browser passes no other).
  var XI_TAP = 0.25, XI_HOLD = 1.0, xiHold = null;
  function xiHoldCancel() { if (xiHold && xiHold.timer) window.clearTimeout(xiHold.timer); xiHold = null; }
  function xiDown(e) {
    var m = xiNow();
    if (!m || m.spec.kind !== 'siege' || !m.spec.pill || (e && e.button !== undefined && e.button !== 0)) return;
    xiHoldCancel();
    var hold = {at: aimSeconds(), fired: false, timer: 0};
    hold.timer = window.setTimeout(function () {
      hold.timer = 0;
      if (xiHold !== hold) return;
      hold.fired = true;
      var n = xiNow();
      if (n && n.spec.kind === 'siege' && n.spec.pill) { xiSiegeHold(n, aimSeconds()); xiPressed(); }
    }, XI_HOLD * 1000);
    xiHold = hold;
  }
  function xiUp() {
    var hold = xiHold;
    xiHoldCancel();
    if (!hold || hold.fired) return;
    var m = xiNow(), now = aimSeconds();
    if (!m || m.spec.kind !== 'siege' || !m.spec.pill || now - hold.at >= XI_TAP) return;
    xiSiegeTap(m, now);
    xiPressed();
  }
  // THE OTHER GUN (Ho-Ri Shugo, Taschenratte). Each gun keeps its own load: the one put away goes on loading in the
  // background (its timers are in absolute time), the one taken up comes back as it was left, or loaded when it was
  // never fired. The circle is the new gun's own, rebuilt as a new build is (aimConfigChanged), and the shell on
  // screen follows: the first of that gun's shells, and back to the one the main gun had.
  function xiWeapon(m) {
    m.stash[m.weapon] = {reload: aimReload, clip: aimClip, size: aimClipSize, refill: aimRefill};
    m.weapon = 1 - m.weapon;
    var back = m.stash[m.weapon];
    burstLeft = 0; aimClipDry = false; aimAutoRounds = 0;
    if (back) { aimReload = back.reload; aimClip = back.clip; aimClipSize = back.size; aimRefill = back.refill; }
    else { aimReload = null; aimLoadFull(); }
    var a = aimBlockData();
    if (a) aimNow = ArmorBallistics.aimStep(null, aimLastState || aimState(), a, aimHeated(aimModifiers()), 0);
    aimEstAt = 0; aimEstFine = false;
    xiWeaponShell(m.weapon);
  }
  function xiWeaponShell(weapon) {
    var choice = $('shell-choice'), cur = choice.value, i = cur.indexOf('saved:') === 0 ? Number(cur.slice(6)) : -1;
    var slotOf = function (c) { return c && Number(c.gunInstallation) === 1 ? 1 : 0; };
    if (i >= 0 && candidates[i] && slotOf(candidates[i]) === weapon) return;
    var want = -1, k;
    if (weapon === 0 && xiShellBack.indexOf('saved:') === 0) {
      k = Number(xiShellBack.slice(6));
      if (candidates[k] && slotOf(candidates[k]) === 0) want = k;
    }
    for (k = 0; want < 0 && k < candidates.length; k++) if (slotOf(candidates[k]) === weapon) want = k;
    if (want < 0) return;
    if (weapon === 1) xiShellBack = cur;
    choice.value = 'saved:' + want;
    selectShell();
  }
  // THE CAV mod. 71's SURGE. A press spends a charge on the round loading back: it loads in reloadTime 8.5 s (the tuple's
  // own 10-16 s otherwise), scaled like the rest of the tuple and keeping the share already done. OUR READING: one
  // charge is one round, spent by the press (the client gives the numbers, not how a charge is spent). Only with the
  // autoloader's own timers running (◔); with nothing loading the press is refused.
  function xiSurge(m, now) {
    if (!(m.charges >= 1) || !realReload()) return;
    refillSettle(now);
    if (!aimRefill) return;
    var a = aimBlockData(), rl = a ? ArmorBallistics.reloadSeconds(a, xiApply(aimModifiers())) : null;
    var k = rl && a.reloadTime > 0 ? rl.reload / a.reloadTime : 1, d = m.spec.reloadTime * k;
    var span = aimRefill.until - aimRefill.at, done = span > 0 ? Math.max(0, Math.min(1, (now - aimRefill.at) / span)) : 0;
    if (!(d < span)) return;
    aimRefill = {at: now - done * d, until: now + (1 - done) * d, times: aimRefill.times};
    if (aimReload && !aimReload.clip && aimClip <= 0) aimReload = {at: aimRefill.at, until: aimRefill.until, clip: false};
    if (m.charges >= m.spec.maxCharges) m.chargeAt = now;
    m.charges--; m.boostUntil = aimRefill.until;
    panelWake();
  }
  // THE BUTTON: graphics only, the page's lit switch - lit while the mode or ability is on (or, for a passive
  // mechanic, while it gives anything), dashed while something runs down (a switch, a cooldown, a deployment, the
  // charges building), dimmed for the three the emulation does not run. Written only when something it shows changed.
  function xiLook(m, now) {
    var s = m.spec, on = false, busy = false, glow = false;
    switch (s.kind) {
      case 'stance': on = m.stance === 1; busy = m.to !== null; glow = m.fightUntil > now; break;
      case 'ability': case 'rocket': on = m.state === 'active'; busy = m.state === 'cooldown' || m.state === 'deploy'; break;
      // Lit in the second mode, dashed while it switches; the Strv 107-12's pillbox wears the gold ring on top.
      case 'siege': on = s.mode === 'auto' ? m.on : m.st >= 1; busy = m.to !== null; glow = m.st === 2; break;
      case 'designator': on = m.state === 'armed'; busy = m.state === 'cooldown' || m.state === 'deploy'; glow = !!xiMarkNow(); break;
      case 'weapon': on = m.weapon === 1; break;
      case 'burst': on = m.burst; break;
      case 'stacks': on = m.level > 0; break;
      case 'fury': on = m.level > 0; break;
      case 'surge': on = m.boostUntil > now; busy = m.charges < s.maxCharges; break;
    }
    return {on: on, busy: busy, glow: glow, skip: s.kind === 'skip' || (s.kind === 'rocket' && m.state === 'empty'),
            passive: s.kind === 'stacks' || s.kind === 'fury' || (s.kind === 'siege' && s.mode === 'auto')};
  }
  function paintXi() {
    var b = $('aim-gun-mech');
    if (!b) return;
    var m = xiNow(), show = !!m;
    if (b.hidden !== !show) { b.hidden = !show; scheduleLayout(); }
    if (!m) { xiPaintKey = ''; xiTitleKey = ''; return; }
    var now = aimSeconds(), look = xiLook(m, now);
    var key = [m.spec.glyph, look.on, look.busy, look.glow, look.skip, look.passive].join('|');
    if (key !== xiPaintKey) {
      xiPaintKey = key;
      b.textContent = m.spec.glyph;
      b.setAttribute('aria-pressed', String(look.on));
      b.setAttribute('data-busy', look.busy ? '1' : '0');
      b.setAttribute('data-glow', look.glow ? '1' : '0');
      b.setAttribute('data-passive', look.passive ? '1' : '0');
      b.setAttribute('aria-disabled', String(look.skip || look.passive));
    }
    // The sentence is long and this runs with the panel, every frame of the loop: it is composed only when a figure in
    // it has changed (the countdowns to the whole second).
    var tk = xiKey(m, now);
    if (tk !== xiTitleKey) {
      xiTitleKey = tk; b.title = xiTitle(m, now);
      b.setAttribute('aria-label', m.spec.name + ': ' + (m.spec.pill ? 'Siege mode and pillbox' : m.spec.label || XI_LABEL[m.spec.kind] || m.spec.mech));
    }
  }
  function xiKey(m, now) {
    var s = m.spec, left = function (t) { return t > now ? Math.ceil(t - now) : 0; }, mk;
    switch (s.kind) {
      case 'stance': return [s.mech, m.stance, m.to, left(m.until), left(m.fightUntil), Math.floor(m.energy), m.record].join();
      case 'ability': return [s.mech, m.state, left(m.until), m.record].join();
      case 'rocket': return [s.mech, m.state, left(m.until), m.uses, m.record].join();
      case 'designator': mk = xiMarkNow(); return [s.mech, m.state, left(m.until), mk ? Math.ceil(mk.left) : 0, m.record].join();
      case 'siege': return [s.mech, s.mode, m.st, m.to, left(m.until), m.on, m.refused ? 1 : 0, m.record, s.from].join();
      case 'weapon': return [s.mech, m.weapon, m.record].join();
      case 'burst': return [s.mech, m.burst, m.record].join();
      case 'stacks': return [s.mech, m.level, m.max, m.record].join();
      case 'fury': return [s.mech, m.level, m.level > 0 ? left(m.at + s.duration) : 0, m.record].join();
      case 'surge': return [s.mech, m.charges, left(m.boostUntil), m.record].join();
    }
    return s.mech;
  }
  // The words, all of them here: the state now, what a press does, the client's numbers and this page's readings.
  function xiSec(v) { return String(Math.ceil(Math.max(0, v))); }
  function xiTitle(m, now) {
    var s = m.spec, head = s.name + ' — ', from = m.record ? ' Started from the recorded state of this shot.' : ' No state of it is recorded for this shot: started from the default.';
    var stock = ' The client’s own stock numbers (' + s.mech + ' of client 2.4.0.1); the server applies them - the emulation runs them under ✸.';
    switch (s.kind) {
      case 'stance':
        return head + 'the stance: ' + (m.stance === 1 ? 'turbo' : 'fight') + (m.to !== null ? ', switching to ' + (m.to === 1 ? 'turbo' : 'fight') + ' - ' + xiSec(m.until - now) + ' s' : '') +
          (m.fightUntil > now ? '; the fight ability on - ' + xiSec(m.fightUntil - now) + ' s left' : '') + '. Fight energy ' + Math.floor(m.energy) + ' / ' + s.energyMax + '.' +
          ' Press: switch the stance - ' + s.switchTime + ' s, the new stance takes over at its end. Turbo, the whole stance: aiming time ×1.9, the movement, hull and turret terms of the circle ×1.9, the after-shot term ×1.66, +15 / +5 km/h.' +
          ' Fight: the energy builds ' + s.energyPerSec + ' a second and +' + s.energyPerHit + ' for a hit that deals damage; at ' + s.energyMax + ' the fight ability for ' + s.fightTime + ' s - the circle ×0.8, aiming time ×0.75, reload ×0.8.' +
          stock + ' This page’s readings: the ability goes off the moment the energy is full (the game spends the ' + s.energyMax + ' when the player calls it), the energy does not build while it runs, it runs its time whatever the stance, and the gun is not locked while the stance switches; ×1.66 on the after-shot term has no line in the garage.' + from;
      case 'ability':
        return head + 'the pneumatic gyro-stabiliser: ' + (m.state === 'active' ? 'on - ' + xiSec(m.until - now) + ' s left' : m.state === 'cooldown' ? 'cooling down - ' + xiSec(m.until - now) + ' s'
          : m.state === 'deploy' ? 'deploying - ' + xiSec(m.until - now) + ' s' : 'ready') + '.' +
          ' Press: switch it on for ' + s.duration + ' s, then it cools down ' + s.cooldown + ' s. While on: the movement, hull and turret terms of the circle ×0, aiming time ×0.3, the circle ×0.94, hull traverse ×1.1.' +
          stock + ' The ' + s.deploy + ' s it deploys at the start of a battle are not run here unless the record says so.' + from;
      case 'siege': return xiSiegeTitle(m, now, head, from);
      case 'rocket': return xiRocketTitle(m, now, head, from);
      case 'designator':
        var mark = xiMarkNow();
        return head + 'the target designator: ' + (m.state === 'armed' ? 'armed - the next round marks what it hits' : m.state === 'cooldown' ? 'cooling down - ' + xiSec(m.until - now) + ' s'
          : m.state === 'deploy' ? 'deploying - ' + xiSec(m.until - now) + ' s' : 'ready') + '.' + (mark ? ' The target is marked - ' + xiSec(mark.left) + ' s left.' : '') +
          ' Press: arm it (again: disarm). The armed round marks the vehicle it hits for ' + s.markTime + ' s, and a marked vehicle takes ×' + XI_MARK + ' of the damage of every shell - under ✸ the damage rolled on it; the cooldown, ' + s.cooldown + ' s, runs from the round.' +
          stock + ' This page’s readings: the marking round itself does not get the ×' + XI_MARK + ', and any hit marks, a ricochet too.' + from;
      case 'weapon':
        var sec = activeHit && activeHit.attacker && activeHit.attacker.aim && activeHit.attacker.aim.secondary;
        return head + (m.weapon === 1 ? s.what + ' in hand' : 'the main gun in hand') + '.' +
          ' Press: take up ' + (m.weapon === 1 ? 'the main gun' : s.what) + '. Each gun has its own circle and its own reload: the one put away goes on loading, and the shell on screen follows the gun.' +
          ' ' + (sec ? 'The second gun’s numbers are the record’s (aim.secondary).' : 'This record carries no numbers of the second gun: its stock figures from the vehicle file are used (' + s.gun.name + ': reload ' + s.gun.reloadTime + ' s, aiming ' + s.gun.aimingTime + ' s, ' +
          aimNum(Math.round(Math.tan(s.gun.dispersion) * 1e4) / 100) + ' m at 100 m' + (s.gun.clip[0] > 1 ? ', ' + s.gun.clip[0] + ' rounds ' + s.gun.clip[1] + ' s apart' : '') + ').') + from;
      case 'burst':
        return head + 'the Burst mode: ' + (m.burst ? 'on - one press fires the burst' : 'off - one press, one round') + '.' +
          ' Press: switch it. In the game it charges after two penetrations; here the button switches it. While on: the burst of the gun (2 rounds 1.5 s apart, every round but the last widening the circle by its own factor), the movement, hull and turret terms of the circle ×0, aiming time ×0.3.' +
          stock + from;
      case 'stacks':
        return head + 'accuracy stacks: level ' + m.level + ' of ' + m.max + (m.level > 0 ? ' - the circle ×' + aimNum(Math.round((1 - m.bonus * m.level) * 1e4) / 1e4) : '') + '.' +
          ' It works by itself: a level every ' + aimNum(m.gainTime) + ' s below ' + aimNum(m.gainKmh) + ' km/h, up to ' + m.max + ', and every round takes them all away; a level narrows the circle by ' + aimNum(m.bonus * 100) + ' %.' +
          stock + ' This page’s reading: the level scales the full-aim circle (×(1 − ' + aimNum(m.bonus) + ' × level)); the moving bonus (stabilizeBonus 0.7) and aimBonusCap 0.95 are not applied - when and on what they work the client does not say.' + from;
      case 'fury':
        return head + 'battle fury: level ' + m.level + ' of ' + m.max + (m.level > 0 ? ' - the reload ×' + aimNum(Math.round((1 - s.bonus * m.level) * 1e4) / 1e4) + ', a level lost in ' + xiSec(m.at + s.duration - now) + ' s' : '') + '.' +
          ' It works by itself: +' + s.perHit + ' for a hit that deals damage, +' + s.perKill + ' more for the one that destroys the target, up to ' + m.max + '; every level shortens the reload by ' + aimNum(s.bonus * 100) + ' %.' +
          stock + ' This page’s readings: a level lasts ' + s.duration + ' s and they go one at a time, and the level counts when the reload starts.' + from;
      case 'surge':
        return head + 'the autoloader surge: ' + m.charges + ' of ' + s.maxCharges + ' charges' + (m.boostUntil > now ? ' - a surged round loading, ' + xiSec(m.boostUntil - now) + ' s' : '') + '.' +
          ' Press: spend a charge on the round loading back - it loads in ' + s.reloadTime + ' s instead of its own 10-16 s. A charge builds every ' + s.chargeRegular + ' s, every ' + s.chargeFull + ' s with the magazine full, up to ' + s.maxCharges + '.' +
          stock + ' This page’s reading: one charge is one round, spent by the press (the client gives the numbers, not how a charge is spent); it needs real reload ◔.' + from;
      case 'skip':
        return head + s.why + ' The button does nothing.';
    }
    return head;
  }
  function xiKmh(v) { return aimNum(Math.round(Number(v) * 3.6 * 10) / 10); }
  function xiM100(d) { return aimNum(Math.round(Math.tan(Number(d)) * 1e4) / 100); }
  function xiCap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
  // The words of a second mode: the state and the switch, what a touch (and the 107-12's hold) does, the client's
  // rules while it switches, the two modes' numbers, and what the page does and does not run.
  function xiSiegeTitle(m, now, head, from) {
    var s = m.spec, k = SIEGE_KINDS[s.mode] || SIEGE_KINDS.hydraulic, at = activeHit && activeHit.attacker || {}, a = at.aim || {};
    var sec = s.second, first = sec && sec.mode === 0 ? sec.block : a, second = sec && sec.mode === 1 ? sec.block : sec ? a : null;
    var words = function (st) { return st === 2 ? 'the pillbox' : st === 1 ? k.on : k.off; }, out;
    if (s.mode === 'auto') {
      var t = s.tilt, deg = function (r) { return aimNum(Math.round(Math.abs(r) * 1800 / Math.PI) / 10); };
      return head + k.label + ': ' + (m.on ? k.on : k.off) + '.' +
        ' It works by itself: the server tilts the hull' + (t ? ' ' + deg(t.max) + '° down and ' + deg(t.min) + '° up at ' + deg(t.speed) + '°/s' : '') +
        ' once the vehicle is at or below ' + xiKmh(s.autoOn) + ' km/h, and levels it above ' + xiKmh(s.autoOff) + ' km/h. The circle does not change: the second descriptor differs only in the hull’s tilt, which the dispersion formula does not read. The button takes no press.' + from;
    }
    out = head + k.label + ': ' + words(m.st) + (m.to !== null ? ', switching to ' + words(m.to) + ' - ' + xiSec(m.until - now) + ' s' : '') + '.';
    if (m.refused) out += ' The last press was refused: the engine mode switches only standing - stop first.';
    if (s.pill) {
      out += ' Touch (shorter than ' + XI_TAP + ' s): ' + (m.st === 2 ? 'to siege, ' + s.pill.toSiege + ' s' : m.st === 1 ? 'to travel, ' + s.off + ' s' : 'to siege, ' + s.on + ' s') +
        '; hold ' + XI_HOLD + ' s: ' + (m.st === 2 ? 'out to travel, ' + s.pill.toDrive + ' s' : 'into the pillbox, ' + (m.st === 1 ? s.pill.fromSiege : s.pill.fromDrive) + ' s') +
        '; a press between the two does nothing (the client’s own times).';
    } else {
      out += ' Press: ' + (m.st === 1 ? k.switchOff + (s.off > 0 ? ' - ' + aimNum(s.off) + ' s' : '') : k.switchOn + (s.on > 0 ? ' - ' + aimNum(s.on) + ' s' : '')) +
        (s.cancel ? '; a press while it switches cancels it' : '') + '.';
    }
    out += s.on > 0 || s.off > 0 ? ' While it switches the gun does not fire' + (s.stop ? ' and the vehicle stops - W A S D do nothing' : ' - the engine keeps running (the switch belongs to the gun)') +
      '; the old mode holds until the switch ends.' : ' The switch is instant.';
    if (second && first) {
      out += ' ' + xiCap(k.on) + ': the circle ' + xiM100(second.dispersion) + ' m at 100 m (' + xiM100(first.dispersion) + ' in ' + k.off + '), aiming ' +
        aimNum(second.aimingTime) + ' s (' + aimNum(first.aimingTime) + ')' + (second.speedForward > 0 ? ', top speed ' + xiKmh(second.speedForward) + ' km/h (' + xiKmh(first.speedForward) + ')' : '') + '.';
      out += sec.from === 'ttx' ? ' The second mode’s numbers are the vehicle’s characteristics file’s (its pair), with the recorded block’s own factors.' : ' The second mode’s numbers are the record’s (attacker.modeAim).';
    } else if (s.pill) out += ' This record carries no siege block and the vehicle no characteristics file: the pillbox works on the recorded block.';
    if (s.pill) out += ' In the pillbox, on the siege mode’s own circle: the circle ×0.85, reload ×0.925, no driving, hull traverse ×0.4.';
    if (a.staticTurretYaw !== undefined && a.staticTurretYaw !== null) out += ' The gun is held on the hull’s axis while you drive and while the mode switches; standing, it moves in its sector (the client’s gun rotator).';
    if (aimYawLimits(first) || aimYawLimits(a)) out += ' Past its sector the hull turns by itself towards the cursor at its own traverse speed, as the game’s autorotation does; A and D take over.';
    if (s.mode === 'turboshaft') out += ' The engine mode switches only standing (the client’s help).';
    if (s.mode === 'wheeled') out += ' Standing, a French wheeled vehicle does not turn on the spot: A and D steer only on the move.' + (s.rapid ?
      ' Rapid narrows the wheels’ steering lock from ' + aimNum(s.rapid.cruise) + '° to ' + aimNum(s.rapid.rapid) + '°: the hull turns ×' + aimNum(s.rapid.hullSpeed) +
      ' (our estimate - at a given speed a wheeled hull turns as the tangent of its lock; the game gives no figure).' :
      ' Rapid narrows the wheels’ steering lock (the characteristics panel); without the characteristics file the hull traverse stays the block’s.');
    if (s.mode === 'twinGun') out += ' The salvo’s double damage and double reload are not emulated yet; with one shell left the game refuses the switch - the page’s ammunition is endless.';
    return out + ' Damage to the engine (longer switches) is not modelled.' + from;
  }
  function xiRocketTitle(m, now, head, from) {
    var s = m.spec, a = aimBlockData() || {}, f = s.mods, cap = a.speedForward > 0 ? a.speedForward : 0;
    var state = m.state === 'active' ? 'burning - ' + xiSec(m.until - now) + ' s left' : m.state === 'cooldown' ? 'recharging - ' + xiSec(m.until - now) + ' s'
      : m.state === 'deploy' ? 'deploying - ' + xiSec(m.until - now) + ' s' : m.state === 'empty' ? 'spent' : 'ready';
    return head + 'the rocket booster: ' + state + '.' + (isFinite(s.uses) ? ' Uses left: ' + m.uses + ' of ' + s.uses + '.' : '') +
      ' Press: fire it for ' + aimNum(s.duration) + ' s; it recharges ' + aimNum(s.cooldown) + ' s between two uses.' +
      ' While it burns: top speed ' + (cap ? xiKmh(cap) + ' → ' + xiKmh(cap * (f.forwardSpeed > 0 ? f.forwardSpeed : 1)) + ' km/h' : '×' + aimNum(f.forwardSpeed || 1)) +
      ', reverse ×' + aimNum(f.backwardSpeed !== undefined ? f.backwardSpeed : 1) + ', hull traverse ×' + aimNum(f.hullSpeed !== undefined ? f.hullSpeed : 1) +
      (f.power ? ', engine power ×' + aimNum(f.power) + ' (the page accelerates linearly in time and reads no power)' : '') + '.' +
      ' It has no factor of the dispersion: the circle grows only with the speed and the hull traverse, by the same formula - faster, so wider, and it takes longer to settle.' +
      ' The client’s own numbers (rocketAcceleration of client 2.4.0.1, from the vehicle’s characteristics file); the server applies them - the emulation runs them under ✸. The ' +
      aimNum(s.deploy) + ' s it deploys at the start of a battle are not run here unless the record says so.' + from;
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
    if (!live) $('aim-config').open = false;   // aimConfigListen below takes the sub-panel and the Escape key with it
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
    aimConfigListen();
    if (!live) {
      if (viewer) viewer.clearLiveAim();
      stopAimLoop();
      paintCircleLines();   // the live line goes with the mode; the hit-line panel returns to the recorded ring
      paintDrive(aimState());   // a tile put away with a key still lit or the turn arc drawn would come back wrong
      return;
    }
    if (!aimNow) {
      aimLoadFull();
      aimNow = ArmorBallistics.aimStep(null, aimState(), a, aimModifiers(), 0);
    }
    if (!aimNow) { viewer.clearLiveAim(); return; }
    paintAim(aimState());
  }
  // What a shell chosen BY HAND borrows from the shooter (user, 22.09). A manual shell is a type, a
  // penetration and a calibre the user typed - ArmorBallistics.shell() gives it no alpha at all, and every
  // damage figure on the page then read "—" or 0 %. It is still a shell of the SAME shooter, so the damage
  // side comes from his own shell of that type: his candidate of the kind the user picked, else the shell
  // the record resolved for the hit, else his first shell that has an alpha. What the user typed - kind,
  // penetration, calibre - is never touched. A record whose shells carry no alpha at all (before 0.7.13)
  // has nothing to lend, and the circle then prints the penetration chance instead (circleFigure).
  var MANUAL_DAMAGE_KEYS=['alpha','spallDamage','spallAbsorption','nonPiercingArmorDamage','damageRandomization','mechanics'];
  // The shooter's own shells, best first: the one the record named for this hit (or the one the page
  // assumed), then the rest of the list on screen. Only a manual shell ever reads it.
  function manualPool(){
    var out=[];
    if(shotContext&&shotContext.index>=0&&shotContext.choices[shotContext.index])out.push(shotContext.choices[shotContext.index]);
    else if(shellAssumed>=0&&candidates[shellAssumed])out.push(candidates[shellAssumed]);
    return out.concat(candidates||[]);
  }
  function manualDamageFrom(hit,kind,pool){
    var all=[];
    function add(list){if(Array.isArray(list))list.forEach(function(s){if(s&&s.alpha>0)all.push(s);});}
    add(pool);
    if(hit){add(hit.shellCandidates);add(hit.availableShells);add(hit.shells);
      if(hit.attacker)add(hit.attacker.modeShells);}
    if(!all.length)return null;
    var ofKind=all.filter(function(s){return s.kind===kind;});
    return ofKind.length?ofKind[0]:all[0];
  }
  function shellAt(c,choice,penetration,caliber,distance,hit,pool,alpha){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    shell.liner=targetFactor(hit);
    if(!c){
      var lend=manualDamageFrom(hit,choice,pool);
      if(lend){MANUAL_DAMAGE_KEYS.forEach(function(k){if(lend[k]!==undefined&&lend[k]!==null)shell[k]=lend[k];});
        shell.alphaFrom=lend.name||'';}
    }
    // Every one of these is taken from the shell OBJECT, never from a constant, so a second-mode shell's
    // own normalisation, ricochet angle, jet loss and alpha flow straight into the ballistics (P4).
    // `damageRandomization` rides along for the damage roll of the fun layer (22.09), the same field a
    // manual shell already borrows through MANUAL_DAMAGE_KEYS: the ballistics never read it, so the
    // chances, the colours and the verdict lines are untouched by its being there.
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration',
      'alpha','spallDamage','spallAbsorption','mechanics','nonPiercingArmorDamage','vehicleMode','damageRandomization'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});
      // The penetration at this distance is the client's law in ballistics.js, never a copy of it here (BACKLOG
      // № 32): the field holds the shell's first value (up to 50 m) and falls off by the record's own factor, so
      // a number typed over the record's falls off exactly as the record's would.
      if(c.penetration100>0)shell.penetration=penetration*ArmorBallistics.penetrationAt(c,distance)/c.penetration100;}
    // The alpha falls off with the distance on the Polish smoothbore APCR alone (damageMutable, alphaFar in the
    // record); the factor is exactly 1 on every other shell, which is then what it always was.
    var fall=c&&c.alpha>0?ArmorBallistics.alphaAt(c,distance)/c.alpha:1;
    // The alpha field (user, 22.09): the user's own number wins over the record's and over the borrowed
    // one, exactly as his penetration and calibre do. HE's spall damage is the non-penetration base and
    // moves with the alpha - the record's own ratio is kept when there is one, the ballistics default
    // otherwise. 0 or empty means "no alpha": every damage figure then falls back to the chance.
    if(alpha!==undefined&&alpha!==null&&alpha!==''){
      var want=Number(alpha);
      if(want>0&&want<=5000){
        var ratio=shell.alpha>0&&shell.spallDamage>0?shell.spallDamage/shell.alpha:0;
        shell.alpha=want;
        if(ratio>0)shell.spallDamage=want*ratio;
      }else if(!(want>0))shell.alpha=null;
    }
    // The alpha field, like the penetration field, holds the value up to 50 m; the one that counts at this
    // distance goes on the shell, and the one of the field stays beside it for the tooltips and the log line.
    if(fall!==1&&shell.alpha>0){shell.alphaNear=shell.alpha;shell.alpha*=fall;}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null,totalEstimate=null,verdictKey=null,partNames=['chassis','hull','turret','gun','trackPair1'];
  // Verdict log (user, 14.09): one console line per recorded contact point - the server's result as a fact next to our
  // estimate along the drawn line. The game writes the page's console into game.log; tools/verdicts_from_log.py
  // tabulates the lines. Once per hit and shell, never on camera moves.
  var verdictLines=0,verdictQueue=[],verdictDone={},verdictTimer=null,verdictBusy=false;
  function verdictLine(battleId,hit,v,shell,mode){var r=v.result||{},chance=r.chance;
    var ours=r.reason==='ricochet'?'ricochet':chance===null||chance===undefined?(r.reason||'none'):(chance>=50?'pen':'no-pen')+'_'+chance+'%';
    console.info('Bullba Hits verdict: battle='+battleId+' hit='+hit.id+' point='+v.index+' part='+(partNames[v.part]||v.part)+' server='+String(effects[v.effect]||v.effect).replace(/ /g,'_')+' ours='+ours+' angle='+(r.angle!=null?Math.round(r.angle):'-')+' eff='+(r.effective!=null?Math.round(r.effective):'-')+' pen='+Math.round(shell.penetration)+' shell='+shell.kind+' dir='+v.source+' chordDev='+(v.chordDev==null?'-':(v.chordDev*180/Math.PI).toFixed(1))+' mode='+mode+shellModeColumns(hit,shell)+damageColumns(hit,r,shell)+ArmorCrits.columns(hit,v)+' v='+($('app-version').getAttribute('data-version')||'dev').replace(/\s+/g,'_')+' rec='+(recordsVersion||'-'));
    verdictLines++;verdictStatus();}
  // The shooter's vehicle mode on a log line that already carries the shell (22.09): which of the two
  // modes the shell used belongs to, whether the record held a second set at all and the siege state the
  // recorder read. Only for a shooter whose vehicle really has two modes - a line without these fields
  // says the vehicle has one, which is every vehicle but six in this client. tools/verdicts_from_log.py
  // splits the line into key=value pairs, so new keys cost it nothing.
  function shellModeColumns(hit,shell){
    var a=(hit||{}).attacker||{};
    if(!(a.vehicleMode===0||a.vehicleMode===1))return '';
    var used=shell&&(shell.vehicleMode===0||shell.vehicleMode===1)?shell.vehicleMode:'-';
    return ' vehMode='+a.vehicleMode+' shellMode='+used+' modeShells='+(a.modeShells&&a.modeShells.length?a.modeShells.length:0)+
      ' siegeAtImpact='+(Number.isFinite(a.siegeStateAtImpact)?a.siegeStateAtImpact:'-');
  }
  // HE damage columns of the log line: the server's damage for this hit next to both candidate laws for the
  // non-penetration part - the ratio law the page draws and the linear legacy shape (k = 1.1), which is written
  // here only so recorded hits can decide between them later. Nothing else in the page reads nonPenLin.
  function damageColumns(hit,r,shell){
    // A shell whose alpha falls off with the distance (damageMutable, BACKLOG № 32): the server's damage beside the
    // alpha at this hit's range and the one up to 50 m, so recorded hits can confirm the client's law.
    if(shell.kind!=='HIGH_EXPLOSIVE'&&shell.alphaNear>0)return ' dmg='+(hit.damage>0?hit.damage:'-')+' alpha='+Math.round(shell.alpha)+' alphaNear='+Math.round(shell.alphaNear);
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
    var verdicts=viewer.pointVerdicts(shell)||[];if(!verdicts.length||viewer.loadedData.hit!==activeHit)return;verdictKey=key;
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
      // A hit whose shell the record does not name is logged with the shell THE PAGE WOULD SHOW - the one
      // ArmorShotContext.assume picks (the shells of the hit's own type, the damage band, then the deepest
      // penetration) - not with the first of the list, which was a different shell from the one on screen
      // and made the guessed lines of the Statistics log disagree with the view. Still marked as a guess.
      // The damage window of the assumed shell is taken at the hit's own range, the one prepareShell hands it
      // too: a Polish APCR's alpha falls off with it, and the window at the muzzle threw the right shell out.
      var context=ArmorShotContext.resolve(hit,battle.shotEvents||[]),c=context.choices[context.index]||null;
      var range=context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:100;
      if(!c&&ArmorShotContext.assume){var picked=ArmorShotContext.assume(context.choices,context.kind,hit.damage,context.range,context.mark);c=context.choices[picked.index]||null;}
      if(!c)c=context.choices[0]||null;
      var shell=c?shellAt(c,c.kind,c.penetration100,c.caliber,range,hit):null;
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
    var pen=Number($('penetration').value),cal=Number($('caliber').value),alphaValue=$('alpha').value,pool=manualPool();
    var shell=shellAt(c,choice,pen,cal,range,activeHit,pool,alphaValue),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    var pinned=!!(viewer&&viewer.pinned),line=armorLine(r,shell?shell.penetration:null,range);fillPanel('shot',line,shell&&shell.alpha);
    logVerdicts(shell);
    // The tile's own tooltip says what its number is before it says where the line comes from.
    $('shot-panel').title=(damageView?'Expected damage per shot along the saved hit line, as a share of the shell’s alpha: the penetration chance times alpha, plus the reconstructed non-penetration damage for the rest, divided by alpha.\n\nThe record holds what the shot did; this is the expectation it had, not the rolled RNG.':shotPanelTitle)+markNote(shell&&shell.alpha);
    aimTitle();
    output.title=!r?'No parameters or the pose changed':pinned?'Along the pinned line from the current view':'Along the saved line · flight ≈ '+Math.round(range)+' m · nominal penetration '+Math.round(shell.penetration)+' mm';
    // The ring on screen is part of the key: a pinned point and the user's first emulated shot both take
    // the recorded rings away, and the line that describes them has to go with them.
    var ringShown=!!(viewer&&viewer.savedAimShown&&viewer.savedAimShown());
    // The STANDING ring is the reticle of a shot that was fired at its OWN range: its figure is taken with
    // the shell at that range, never at the one the Distance slider happens to stand on (user, 22.09 - the
    // tile blinked and was recomputed on every move of a slider that changes nothing for it). Only a saved
    // candidate has a penetration that falls off with range at all, and the same object is reused whenever
    // the two ranges agree, so no shell is built twice.
    var ringRange=viewer&&viewer.recordedDistance>0?viewer.recordedDistance:range;
    var ringShell=c&&ringRange!==range?shellAt(c,choice,pen,cal,ringRange,activeHit,null,alphaValue):shell;
    // The key is built from the RING's shell, so the probe distance is not in it. The pose is (the integral
    // is refused off the rest pose), the ring's visibility is, and damageView is: the figure is formatted
    // as a share of alpha or as a chance, so a Display switch alone must rebuild it (inspection, 20.09).
    var key=JSON.stringify(ringShell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'')+'|'+ringShown+'|'+damageView;
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim||totalEstimate!==viewer.estimateAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;totalEstimate=viewer.estimateAim;window.clearTimeout(totalTimer);
      // No ring on screen, or no shell to fire into it: there is genuinely no figure and the tile goes away.
      // While one is being RECOMPUTED the old figure stands (user, 22.09: a tile that blanks for 100 ms and
      // comes back reads as a fault) - the integral below replaces it the moment it has an answer.
      // In damage mode that figure is a share of alpha: the mean expected damage over the circle, misses
      // counted as 0, divided by what one shot of this shell can do.
      if(!(ringShell&&ringShown&&(viewer.savedAim||viewer.estimateAim))){if(aimRecorded){aimRecorded=null;paintCircleLines();}}
      else if(viewer.savedAim)totalTimer=window.setTimeout(function(){var v=viewer.savedAimProbability(ringShell);
        aimRecorded=v?Object.assign(circleFigure(v,ringShell),{kind:'saved'}):null;paintCircleLines();},100);
      // A hit with no reticle of its own: the dashed nominal ring is the one on the model, so the figure is
      // printed for THAT ring and its tooltip says it is an estimate with it.
      else totalTimer=window.setTimeout(function(){var v=viewer.estimateAimProbability(ringShell);
        aimRecorded=v?Object.assign(circleFigure(v,ringShell),{kind:'estimate'}):null;paintCircleLines();},100);
    }
  }
  // BACKLOG 38: the target carried a leKpz Borkenkäfer mark at this hit (ArmorShotContext.markOf, on the resolved
  // context): every shell deals it ×1.1, ×1.15 with the marker's full skill tree - which the record cannot tell. The
  // figures on the panel are shares of the plain alpha, so they stand; what changes is the HP and the window of the
  // shell choice, and the tooltip says both. '' for every hit without an active mark.
  function markNote(alpha){
    var mk=shotContext&&shotContext.mark;
    if(!mk)return '';
    return '\n\nThe target carried a leKpz Borkenkäfer mark at this hit ('+Math.ceil(mk.left)+' s of it left): every shell deals it ×'+mk.low+
      ' (×'+mk.high+' with the marker’s full skill tree, which the record cannot tell)'+(alpha>0?' - '+Math.round(alpha*mk.low)+'…'+Math.round(alpha*mk.high)+' HP for this shell’s '+Math.round(alpha):'')+
      '. The shares here are of the plain alpha, so they stand; the damage window of the shell choice reaches ×'+mk.high+' at the top. The factor is the server’s, the numbers the client’s.';
  }
  // The tail of the recorded ring's tooltip: which circles this hit has and how the figure over them is
  // sampled. The toolbar box that used to carry this text together with the figure is gone (user, 22.09:
  // the number lives on the tile at the right edge and the (i) beside it did nothing), so the sentence
  // moved onto that tile. The status half is written once per hit by display(), the mode half changes with
  // the Display setting - composed HERE, once, because the tile's tooltip is rewritten on every repaint.
  var aimStatus='',aimExtra='',shotPanelTitle=$('shot-panel').title;
  function aimTitle(){
    aimExtra=' Reticle circles on the model. '+aimStatus+' Over the saved circle: '+ArmorBallistics.aimProfile().label+
      '; 256 rays, misses = 0. Server formula not confirmed'+(damageView?'; the non-penetration part is a reconstruction (ratio law). No map obstacles, target motion or splash onto other parts.':'; no map obstacles, target motion or blast damage.');
  }
  // The heading row has no space for the full wording: the label reads “Pen.” and the sentence lives in its title.
  // A saved shell's field holds the client's first value, which holds up to 50 m and falls off beyond (BACKLOG № 32).
  function penLabel(near){var e=$('penetration-label');e.textContent='Pen.';e.title=near?'Penetration up to 50 m, mm — it falls off with the distance':'Penetration at target, mm';}
  function selectShell(){
    var index=$('shell-choice').value,c=index.indexOf('saved:')===0?candidates[Number(index.slice(6))]:null;
    var point=(activeHit&&activeHit.points||[]).find(function(p){return p.caliber>0;});
    if(!c){manualPen=$('penetration').value||manualPen;manualAlpha=$('alpha').value||manualAlpha;} // a manual shell keeps what was on screen
    $('penetration').value=c?c.penetration100:manualPen;$('caliber').value=c?c.caliber:point?point.caliber:100;
    // The alpha field (user, 22.09). A saved shell shows the record's own alpha; a manual type keeps the
    // number the user last typed, and starts from the alpha of the shooter's own shell of that type when
    // he has typed none - the same borrowing shellAt does, so the field shows what is really being used.
    if(c)$('alpha').value=c.alpha>0?Math.round(c.alpha):'';
    else{
      if(!(Number(manualAlpha)>0)){var lend=manualDamageFrom(activeHit,index,manualPool());manualAlpha=lend?String(Math.round(lend.alpha)):'';}
      $('alpha').value=manualAlpha;
    }
    penLabel(!!c);updateShell();
  }
  function updateShell(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var penetration=Number($('penetration').value),caliber=Number($('caliber').value),valid=!!choice&&penetration>0&&penetration<=3000&&caliber>0&&caliber<=1000;
    var alphaField=$('alpha').value,alpha=Number(alphaField);
    var distance=viewer?viewer.distance:100,shell=shellAt(c,choice,penetration,caliber,distance,activeHit,manualPool(),alphaField);
    // An edited alpha is an edit like an edited penetration or calibre: the shell stops being the record's.
    var edited=c&&(penetration!==c.penetration100||caliber!==c.caliber||(alpha>0?Math.round(c.alpha)!==Math.round(alpha):c.alpha>0));
    var actual=shotContext&&choice==='saved:'+shotContext.index&&!edited;
    // The shell the page assumed for a hit whose own is not known: its own marker, never the hit's ●.
    var assumed=!actual&&!edited&&shotContext&&shotContext.index<0
      &&(shellAssumed>=0?choice==='saved:'+shellAssumed:!c&&!!shotContext.kind&&choice===shotContext.kind);
    var browsing=!!(activeHit&&(activeHit.vehicle||activeHit.chosenShooter));
    // The caption band under the fields is gone (user, 18.09: the line read as noise). Its sentence is now the
    // title of the shell group, and the two states that are a warning keep their words in #parameters-notice.
    // A manual shell says whose alpha it is using: the type, the penetration and the calibre are the user's,
    // the damage side is the shooter's own shell of that type (user, 22.09).
    var lent=!c&&shell&&shell.alpha>0?' · alpha of the shooter’s '+(shell.alphaFrom||'shell'):'';
    var source=!choice?'Pick a shell':!valid?'No penetration in the record':(actual?'● From the hit':assumed?'◌ Assumed shell':c?(browsing?'● Shooter’s shell':'◇ Comparison'):'◇ Manual')+lent+' · '+Math.round(shell.penetration)+' mm at target · ±'+Math.round(shell.randomization*100)+'%'+(shell.alphaNear>0?' · alpha '+Math.round(shell.alpha)+' HP at target':'');
    // The alpha field says the same about a shell whose damage falls off with the distance (damageMutable).
    var alphaTitle='Alpha of the shell, HP — the damage figures are shares of it'+(shell&&shell.alphaNear>0?'. This shell’s damage falls off with the distance: the field holds it up to 50 m, '+Math.round(shell.alpha)+' HP at '+Math.round(distance)+' m':'');
    $('alpha-label').title=alphaTitle;$('alpha').title=alphaTitle;
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
    // The alpha may be left empty - that is "no alpha", not a mistake - but a number outside 1..5000 is one.
    $('alpha').setAttribute('aria-invalid',String(!!alphaField&&!(alpha>0&&alpha<=5000)));
    $('probe-chance').textContent='—';$('probe-chance').style.color='';$('probe-pen').replaceChildren();$('probe-extra').replaceChildren();$('probe-details').replaceChildren(node('span','Hover over the armour','placeholder'));
    modsVisible();
    staleEstimate();if(viewer)viewer.configure(shell,mapMode,$('palette').value,mode);shotStats();updateAim();
    paintFun();   // the health bar is painted on the chance scale, so a palette or Display change repaints it
    ttxShellChanged();   // the characteristics panel's DPM and shell row follow the shell - only when it changed
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
      // Only the shooter changes here, so the VEHICLE ON SCREEN is the one that was already there: its
      // roster row travels with the synthetic hit, and the health bar stays on the same target instead of
      // hunting for it in the hit (user, 22.09 - the bar used to go and the ↺ to do nothing).
      var onScreen=targetRow(hit);if(onScreen&&onScreen.id!==undefined&&onScreen.id!==null)synthetic.modelVehicleId=onScreen.id;
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
  // Can the shooter of this hit be put on screen? His own parts carry his collision models - but since the
  // export-by-need change of 0.7.21 a hit is published before they are extracted, so a part marked
  // modelPending is a model ON ITS WAY, not a missing one, and the button is offered: the click waits for the
  // extraction exactly as the target's pending model is waited for. A record that carries no shooter parts at
  // all (an old battle) is still offered when the catalogue knows his vehicle - his own export holds the same
  // collision parts and is read the way the Vehicles panel reads one. Only a shooter with none of the three is
  // genuinely without a model, and only then does the button go.
  function swapParts(hit){
    var parts=(hit&&hit.attacker&&hit.attacker.parts)||[];
    return {key:parts.some(function(p){return p.modelKey;}),pending:parts.some(function(p){return p.modelPending;})};
  }
  // The catalogue row of the shooter's vehicle, matched by the client's own type name (the same match
  // adoptHitVehicles and showFocusEmpty make). Null while the catalogue has not been read - the Battles
  // panel does not need it, and every published record since 0.7.11 carries the parts anyway.
  function swapVehicleRow(hit){
    var type=String((hit&&hit.attacker&&hit.attacker.type)||'');
    if(!type)return null;
    return ((catalogue&&catalogue.vehicles)||[]).find(function(v){return String(v.type||'')===type;})||null;
  }
  function swapReady(hit){
    if(!hit||!hit.attacker)return false;
    var p=swapParts(hit);
    return p.key||p.pending||!!swapVehicleRow(hit);
  }
  // The swapped view as a hit the scene loader and the viewer understand: the recorded shooter becomes the
  // target (his parts carry the models), the recorded target becomes the shooter. No points, so no hit line,
  // no reticle and no shells - the vehicle now on screen never fired in this record.
  function swapHit(hit){
    var attacker=shallow(hit.target);delete attacker.parts;
    return {id:hit.id+':swap',synthetic:true,base:hit.id,direction:viewDirection(hit)==='incoming'?'outgoing':'incoming',
      attacker:attacker,target:shallow(hit.attacker),points:[],rawHitPoints:[],warnings:[],
      shellCandidates:[],availableShells:[],receivedAt:hit.receivedAt,rangeAtImpact:hit.rangeAtImpact};
  }
  // The swapped hit with a model under it, whichever of the three ways this shooter's model can be had.
  // Parts with a key are ready at once; parts still being extracted are asked for at the front of the mod's
  // queue and the battle is read again until they land (the page's own 2 s / 30 s wait, the one a browsed
  // vehicle uses); no parts at all are replaced by the shooter's own vehicle export - the same file and the
  // same reader showVehicleScene() uses - so his recorded name and gun stay and only the parts come from it.
  function swapScene(hit,deadline){
    var parts=swapParts(hit);
    if(parts.key)return Promise.resolve(swapHit(hit));
    if(parts.pending&&current)return swapExtracting(hit,deadline);
    var row=swapVehicleRow(hit);
    if(!row)return Promise.reject(new Error('The shooter’s collision model is not exported yet.'));
    return readVehicle(row.id,deadline).then(function(record){
      var synthetic=swapHit(hit);
      synthetic.target.parts=(record.parts||[]).slice();
      if(record.exportedAt!==undefined)synthetic.target.exportedAt=record.exportedAt;
      if(record.source!==undefined)synthetic.target.source=record.source;
      return synthetic;
    });
  }
  function swapExtracting(hit,deadline){
    var type=String((hit.attacker||{}).type||'');
    if(type)sendCommand('prioritise',{vehicleTypes:[type]});
    message(EXTRACTING,true);
    return ArmorInspectorData.battle(current.id).then(function(b){
      var fresh=((b&&b.hits)||[]).find(function(h){return h.id===hit.id;});
      if(fresh&&swapParts(fresh).key)return swapHit(fresh);
      if(!deadline||Date.now()>=deadline)throw new Error('The shooter’s collision model is still being extracted.');
      return new Promise(function(r){window.setTimeout(r,2000);}).then(function(){return swapExtracting(hit,deadline);});
    });
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
    ttxPaint();   // no Shooter tile, no characteristics panel
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
    // A RECORDED hit keeps its swap in EITHER panel, and so does the way back from a swapped view (22.09:
    // switching the side panel to Vehicles took the button off a hit that was still on screen, which reads
    // exactly like the button having gone for good). The swap of a recorded hit is about the hit, not about
    // which list is open beside it.
    var recorded=!!current&&!!hit&&!hit.synthetic&&swapReady(hit);
    b.hidden=!(browsed||recorded||(!!current&&back));
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
    // Why there is no circle, in full: no resolved impact point to centre on, no gun dispersion in the record,
    // no range, or no own reticle linked to this hit (every incoming hit by design - the enemy's is not recorded).
    var reason=aimReady?'saved reticle':estimate?'nominal estimate':!(viewer&&viewer.point&&viewer.travel)?'no resolved impact point':!(hit.attacker&&hit.attacker.gunDispersion>0)?'no gun dispersion in the record':!(shotContext.range>0||hit.rangeAtImpact>0)?'no range for this hit':!ownShot?'enemy reticle unavailable':(aimReasons[shotContext.aimReason]||'no linked snapshot').toLowerCase();
    // What the circles mean and where this one came from is the tooltip of the Circle tile at the right edge
    // of the scene (the toolbar's own reticle box went with its figure on 22.09).
    var status=aimReady?'This hit: ● solid magenta — the client reticle at the shot, ◌ dashed magenta — the server reticle, both slid along the shot line to the impact point. Every standing ring is magenta; only the live emulation ring is cyan.':estimate?'This hit: ◌ dashed magenta — nominal full-aim estimate of the '+(estimate.gun||'mounted gun')+': '+(estimate.dispersion*100).toFixed(2)+' m at 100 m × '+Math.round(estimate.range)+' m ('+(estimate.source==='tracer'?'tracer range':'approximate range at impact')+') = ⌀ '+(estimate.radius*2).toFixed(2)+' m. Without crew or equipment, centred on the hit line; not the recorded reticle and not used in the figure.':'This hit: no reticle — '+reason+'.';
    // One line per hit in the page console; the game writes page console lines into game.log, so an in-game
    // report about missing rings can be read there instead of guessed at.
    if(window.console)console.info('Bullba Hits aim: hit '+hit.id+' '+(view||'other')+' saved='+!!aimReady+' estimate='+!!estimate+' reason='+reason);
    aimStatus=status;aimTitle();
    shotStats();updateAim();
    // The scene has just been rebuilt. Another VEHICLE on screen is full again with no Hitmarks; the same
    // vehicle under another shooter keeps its health and gets its Hitmarks back (user, 22.09 - the target
    // did not change). Every branch below has already passed through here.
    funModel();
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
    detail('Point on the model',point?['Chassis','Hull','Turret','Gun','Outer track'][point.part]||'Part '+point.part:'Not restored',point?'Per the client collision handler':'Segment kept for diagnostics');
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
  if(viewer)viewer.setAutoFrame($('auto-frame').checked); // OFF by default (user, 22.09; it was on since 18.09)
  if(viewer)viewer.setLighting($('soft-lighting').checked); // on by default (user, 19.09); the checkbox is the switch
  if(viewer)viewer.setLightStrength(Number($('light-strength').value)/100);
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
  if(viewer)viewer.onPin=function(on){$('shot-source').textContent=on?'Pinned point':activeHit&&activeHit.synthetic?'No recorded shot':'Hit line';shotStats();};
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
    // A turret and gun the client holds still (viewer.poseLocks, 23.09): the words only in the tile's tooltip.
    var locks=(viewer.poseLocks&&viewer.poseLocks())||{},held=locks.turret&&locks.gun?'turret and gun':locks.turret?'turret':locks.gun?'gun':'';
    var lockWords=held?'The client holds this '+held+' fixed (the gun’s static angles): the garage draws '+(locks.turret&&locks.gun?'them':'it')+' in that pose and its armour view does not let '+(locks.turret&&locks.gun?'them':'it')+' be dragged - nor does this one.':'';
    if($('pose-info').title!==lockWords)$('pose-info').title=lockWords;
    $('pose-note').textContent=off?'The recorded shot’s own marks are hidden until the recorded pose returns':'';$('pose-note').hidden=!off;
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
    // Two BROWSED vehicles simply change places; a recorded hit below takes its own path in either panel.
    if(sidebarMode==='vehicles'&&activeHit&&activeHit.vehicle){if(!modelVehicle||!shooterVehicle)return;var m=modelVehicle;modelVehicle=shooterVehicle;shooterVehicle=m;shooterPicked=true;showVehicleScene(false).catch(function(){});return;}
    if(swapped){if(swapped.base)selectHit(swapped.base).catch(function(){});return;}
    var hit=activeHit;if(!hit||hit.synthetic||!swapReady(hit)||!current)return;
    var token=++generation;message('Preparing the model\u2026');if(viewer)viewer.clear();
    // In the game the model can still be on its way: the same 30 s the vehicle browser waits. Outside it
    // there is nobody to extract anything, so what is published is all there will be.
    swapScene(hit,host.game?Date.now()+30000:0).then(function(synthetic){
      if(token!==generation)return null;
      return ArmorInspectorData.sceneFor(current,synthetic).then(function(data){if(token!==generation)return;display(data,false);});
    }).catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}});
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
  $('aim-config').addEventListener('toggle',function(){aimSyncCentre();aimConfigListen();});
  // The wheel over the OPEN menu is the menu's: the viewer's own handler sits on #viewport, takes every wheel
  // and zooms the scene with it, so the popover and a sub-panel taller than the room could not be scrolled at
  // all. On the popover and not on the whole <details>, or the wheel over the collapsed "Config" button - a
  // button like any other in the row - would stop zooming the scene. While a sub-panel is open only the panel
  // scrolls: a wheel anywhere else over the menu is swallowed, or the page itself would scroll under it.
  $('aim-config-body').addEventListener('wheel',function(e){e.stopPropagation();if(aimLayer&&!aimConfigControls.layer.contains(e.target))e.preventDefault();},{passive:false});
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
  $('alpha').oninput=function(){if($('shell-choice').value.indexOf('saved:')!==0)manualAlpha=this.value;updateShell();};
  $('battles').onchange=function(){loadBattle(this.value,false).catch(function(e){warnings([e.message]);});};
  // The picker's own handlers. A row click is the change handler (chooseFocus); the rest is what a <details>
  // does not give: no disabled state, so a locked control refuses to open; Escape closes it and hands the
  // focus back to the summary; a click anywhere else closes it, the same pattern the toolbar's More uses.
  (function(){
    var box=$('vehicle-focus'),summary=box.querySelector('summary');
    summary.addEventListener('click',function(e){if(box.classList.contains('is-locked'))e.preventDefault();});
    box.addEventListener('keydown',function(e){if((e.key==='Escape'||e.key==='Esc')&&box.open){box.open=false;summary.focus();}});
    document.addEventListener('click',function(e){if(box.open&&!clickedIn(e,box))box.open=false;});
  }());
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderHits();};});
  $('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);outlineState();};
  $('soft-lighting').onchange=function(){if(viewer)viewer.setLighting(this.checked);lightStrengthState();};
  // ======================= the characteristics panel (23.09) =======================
  // What the garage would show for the vehicle on the Shooter tile - the one Config sets up and the gun panel
  // belongs to (outputs/ttx-panel-spec-2026-09-22.md section 3.4; the arithmetic is web/ttx.js, the formulas
  // outputs/ttx-formulas-2026-09-22.md, the facts docs/KNOWLEDGE.md section 17). Bottom-right corner of the scene,
  // icons and numbers only: every word is in a tooltip. ⚙ switches between the STOCK - top modules, a crew at
  // 100 % with no skills, nothing fitted, as the garage shows a bare vehicle - and THIS BUILD, the Config layers
  // on top, a figure better than the stock in mint and a worse one in red. The pair tile picks the turret and gun
  // where the vehicle has more than one; ▴ opens everything else.
  // NOTHING HERE RUNS ON A FRAME: the panel is painted on an event - another shooter, a Config change, ⚙, a pair,
  // another shell, its file arriving, the expanded view opened - and writes only the text that changed.
  // Field modifications are not modelled in this version (decision of 23.09, docs/CONTEXT.md): a player's own
  // vehicle can differ from his garage by a few per cent, and the tooltips say so.
  // Without the vehicle's characteristics file (data/ttx/<id>.js, written by the mod) the panel is not shown.
  var TTX = window.BullbaTtx || null;
  var ttxCache = {}, ttxOrder = [], ttxPending = {}, ttxAsked = {}, ttxTried = {}, ttxData = null, ttxType = '';
  var ttxShell = '', ttxMemo = {}, ttxMemoKey = '', ttxFolded = false, ttxRows = {};
  var TTX_RETRY_MS = 2000, TTX_WAIT_MS = 30000, TTX_AGAIN_MS = 60000;
  // The panel's own glyphs: small line drawings in the text colour, one per parameter of the garage. The client's
  // own vehParams icons (gui/maps/icons/vehParams, KNOWLEDGE section 17) do not ship with the page; drawn ones
  // stand in, so a fresh install reads the same before any game start. ttxGlyph() is the one place to change it.
  var TTX_GLYPHS = {
    dpm: '<path d="M2.5 13.5V6.5L4 4l1.5 2.5v7zM7.25 13.5V6.5L8.75 4l1.5 2.5v7zM12 13.5V6.5L13.5 4 15 6.5v7z"/>',
    reload: '<path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 2.3v3.2H9.8"/>',
    spm: '<path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 2.3v3.2H9.8"/><circle cx="8" cy="8" r="1.1"/>',
    clip: '<rect x="4.5" y="2" width="7" height="12" rx="1.5"/><path d="M6.5 5h3M6.5 8h3M6.5 11h3"/>',
    autoreload: '<rect x="6.2" y="4.5" width="3.6" height="7" rx="1"/><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.8v2.8h-2.8"/>',
    overheat: '<path d="M8 1.8c1.6 2.6 3.8 4 3.8 7.2a3.8 3.8 0 0 1-7.6 0c0-1.9 1.1-3 1.8-4.3.7 1.2 1.1 1.9 1.8 2.3.4-1.7.4-3.4.2-5.2z"/>',
    dispersion: '<circle cx="8" cy="8" r="4.8"/><circle cx="8" cy="8" r=".9"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/>',
    aiming: '<circle cx="8" cy="9.2" r="5"/><path d="M8 9.2V6.4M6.3 1.8h3.4M8 1.8v2.4"/>',
    stabMovement: '<rect x="1.8" y="9.5" width="12.4" height="4" rx="2"/><path d="M3.5 6h8.5M10 4l2 2-2 2"/>',
    stabRotation: '<rect x="5.2" y="6" width="5.6" height="8" rx="1"/><path d="M2.5 6.5A6 6 0 0 1 12.2 3"/><path d="M12.8 1v2.4h-2.4"/>',
    stabTurret: '<path d="M4 13a4 4 0 0 1 8 0z"/><path d="M8 10.5h6.5"/><path d="M2.5 7A6 6 0 0 1 12.2 3.5"/><path d="M12.8 1.4v2.4h-2.4"/>',
    stabAfterShot: '<path d="M1.5 8h8.5M1.5 10h8.5"/><path d="M11.5 5.5l3-2M12 9h3M11.5 12.5l3 2"/>',
    turretRotationSpeed: '<path d="M3.2 13a4.8 4.8 0 0 1 9.6 0z"/><path d="M8 10h6.8"/><path d="M2.2 7.4A6.2 6.2 0 0 1 12.4 3.6"/><path d="M13 1.4v2.6h-2.6"/>',
    chassisRotationSpeed: '<rect x="4.6" y="4.5" width="6.8" height="10" rx="1"/><path d="M1.8 6.6A6.6 6.6 0 0 1 12.6 2.4"/><path d="M13.2 .6v2.4h-2.4"/>',
    maxSteeringLockAngle: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.4"/><path d="M8 2.4v4.2M3.4 11l3.3-2.1M12.6 11 9.3 8.9"/>',
    speedLimits: '<path d="M2.3 12.2a5.7 5.7 0 1 1 11.4 0"/><path d="M8 12.2l3.2-4.2"/>',
    enginePower: '<path d="M9.2 1.3 3.8 9h4.3l-1.2 5.7 5.3-7.9H7.9z"/>',
    enginePowerPerTon: '<path d="M7.2 1.3 3 7.5h3.2l-.9 4.5L9.5 6H6.3z"/><path d="M14 2.5l-3 11.5"/>',
    vehicleWeight: '<path d="M4.8 6.2h6.4l2.3 7.8h-11z"/><circle cx="8" cy="4" r="1.8"/>',
    maxHealth: '<path d="M8 14s-5.6-3.4-5.6-7.3A3 3 0 0 1 8 5a3 3 0 0 1 5.6 1.7C13.6 10.6 8 14 8 14z"/>',
    pitchLimits: '<path d="M1.5 12.5h13"/><path d="M1.5 12.5 13 6"/><path d="M10.6 3.6 13 6l-3.2.7"/>',
    gunYawLimits: '<path d="M2.4 11A6 6 0 0 1 13.6 11"/><path d="M1.6 8.4 2.4 11l2.6-.7M14.4 8.4 13.6 11 11 10.3"/><path d="M8 11V5"/>',
    maxAmmo: '<path d="M5.8 14.5V6.5L8 2.5l2.2 4v8z"/><path d="M5.8 11.5h4.4"/>',
    circularVisionRadius: '<path d="M1.2 8S3.9 3.4 8 3.4 14.8 8 14.8 8 12.1 12.6 8 12.6 1.2 8 1.2 8z"/><circle cx="8" cy="8" r="2.1"/>',
    invisibilityStillFactor: '<path d="M2.8 14c0-3.2 1.6-5.4 2.6-7C6.4 8.6 7 9.6 8 10.6c.8-2.6 2.2-5.4 4.2-7.4.5 3.7 1 6.4 1 10.8z"/>',
    invisibilityMovingFactor: '<path d="M6 14c0-3.2 1.3-5.3 2.1-6.9.8 1.6 1.3 2.6 2.1 3.7.6-2.1 1.7-4.2 3.3-5.8.4 3.2.8 5.3.8 9z"/><path d="M1.2 7.2h3.2M.8 10.4h3.6"/>',
    invisibilityAfterShot: '<path d="M6 14c0-3.2 1.3-5.3 2.1-6.9.8 1.6 1.3 2.6 2.1 3.7.6-2.1 1.7-4.2 3.3-5.8.4 3.2.8 5.3.8 9z"/><path d="M1.4 5.2l2.2 1.6M.9 9.2h3.2M1.4 13.2l2.2-1.6"/>',
    terrainResistance: '<path d="M1.2 10.3c2.1-2.1 4.3 2.1 6.8 0s4.7 2.1 6.8 0"/><path d="M1.2 13.8c2.1-2.1 4.3 2.1 6.8 0s4.7 2.1 6.8 0"/><path d="M4.3 7 7.2 3l2.9 4"/>',
    avgDamage: '<path d="M8 1.4l1.7 4.2 4.5.4-3.5 2.9 1.1 4.4L8 10.9 4.2 13.3l1.1-4.4L1.8 6l4.5-.4z"/>',
    avgPiercingPower: '<path d="M10.5 1.8v12.4"/><path d="M1.2 8h12M10.2 5.2 13.2 8l-3 2.8"/>',
    shellVelocity: '<path d="M6.8 5.4h5.4L14.8 8l-2.6 2.6H6.8z"/><path d="M1.2 5.8h3.8M1.2 8h3.2M1.2 10.2h3.8"/>',
    turret: '<path d="M2.8 12.5a5.2 5.2 0 0 1 10.4 0z"/><path d="M8 9h6.6"/>',
    // The second modes (23.09): the switch's two times - two arrows meeting; the automatic siege - a hull tilting.
    switchTime: '<path d="M1.2 8h5M4.4 5.4 7 8l-2.6 2.6"/><path d="M14.8 8h-5M11.6 5.4 9 8l2.6 2.6"/>',
    autoSiege: '<path d="M1.5 13.5h13"/><path d="M3 11.5 13 8.2"/><path d="M11 4.2l2 1.8-2 1.8"/>'};
  function ttxGlyph(name) {
    var icon = node('i', undefined, 'ttx-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('data-glyph', name);
    icon.innerHTML = '<svg viewBox="0 0 16 16">' + (TTX_GLYPHS[name] || '') + '</svg>';
    return icon;
  }
  // Every row of the panel: [glyph, name, unit]. The words live in the row's tooltip only.
  var TTX_ROWS = {
    avgDamagePerMinute: ['dpm', 'Damage per minute', 'HP'],
    shotsPerMinute: ['spm', 'Rate of fire', 'rounds a minute'],
    reloadTimeSecs: ['reload', 'Reload', 's'],
    clipFireRate: ['clip', 'Magazine: the whole reload / the interval between rounds / rounds', 's / s / rounds'],
    autoReloadTime: ['autoreload', 'Autoloader: each round, in loading order from an empty magazine', 's'],
    dualGun: ['reload', 'Reload of each barrel', 's'],
    overheat: ['overheat', 'Heat: rounds before the gun overheats / the burst / the cooling', 'rounds / s / s'],
    shotDispersionAngle: ['dispersion', 'Dispersion at 100 m', 'm'],
    aimingTime: ['aiming', 'Aiming time', 's'],
    stabMovement: ['stabMovement', 'Dispersion on the move (not in the garage: the client’s own factor)', 'per km/h'],
    stabRotation: ['stabRotation', 'Dispersion on hull traverse (the client’s own factor)', 'per °/s'],
    stabTurret: ['stabTurret', 'Dispersion on turret traverse (the client’s own factor)', 'per °/s'],
    stabAfterShot: ['stabAfterShot', 'Dispersion after a shot (the client’s own factor)', ''],
    pitchLimits: ['pitchLimits', 'Gun depression / elevation', '°'],
    gunYawLimits: ['gunYawLimits', 'Gun traverse left / right', '°'],
    maxAmmo: ['maxAmmo', 'Ammunition', 'rounds'],
    speedLimits: ['speedLimits', 'Top speed forward / reverse', 'km/h'],
    enginePower: ['enginePower', 'Engine power', 'hp'],
    vehicleWeight: ['vehicleWeight', 'Weight', 't'],
    enginePowerPerTon: ['enginePowerPerTon', 'Specific power', 'hp/t'],
    chassisRotationSpeed: ['chassisRotationSpeed', 'Hull traverse speed', '°/s'],
    maxSteeringLockAngle: ['maxSteeringLockAngle', 'Steering lock of the wheels (a wheeled vehicle that cannot turn on the spot)', '°'],
    turretRotationSpeed: ['turretRotationSpeed', 'Turret traverse speed', '°/s'],
    terrainResistance: ['terrainResistance', 'Terrain resistance: firm / medium / soft (not in the garage; less is better)', ''],
    maxHealth: ['maxHealth', 'Hit points', 'HP'],
    circularVisionRadius: ['circularVisionRadius', 'View range, standing', 'm'],
    invisibilityStillFactor: ['invisibilityStillFactor', 'Concealment standing', '%'],
    invisibilityMovingFactor: ['invisibilityMovingFactor', 'Concealment moving', '%'],
    invisibilityAfterShot: ['invisibilityAfterShot', 'Concealment after a shot (standing)', '%'],
    switchTime: ['switchTime', 'Switching the mode: into the second mode / back', 's'],
    autoSiege: ['autoSiege', 'The hull tilts at or below / levels above (the automatic siege; not in the garage)', 'km/h']};
  // The compact view (spec 3.4.3): fire on the left, mobility on the right, the three stabilisation factors under both.
  var TTX_COMPACT = {fire: ['avgDamagePerMinute', 'reload', 'shotDispersionAngle', 'aimingTime'],
    move: ['turretRotationSpeed', 'hull', 'speedLimits', 'enginePowerPerTon'],
    stab: ['stabMovement', 'stabRotation', 'stabTurret']};
  // The reload row is one figure whatever the gun (spec 3.4.3) and wears the garage's own icon of that figure.
  var TTX_RELOAD_ROW = {single: 'reloadTimeSecs', clip: 'clipFireRate', burst: 'clipFireRate', autoShoot: 'clipFireRate',
    autoreload: 'autoReloadTime', overheat: 'overheat', dualGun: 'dualGun', twinGun: 'dualGun'};
  var TTX_STOCK_WORDS = 'Stock, as the garage shows a bare vehicle: top modules, a crew at 100 % with no skills (+10 % commander’s bonus on every role he does not hold himself), no equipment, directive, consumables or paint';
  var TTX_NO_FIELD = 'Field modifications are not modelled here: the garage of a vehicle that has them may differ by a few per cent.';

  // --- The file ---------------------------------------------------------------------------------------------
  // One read per type and session (eight kept, as the vehicle exports are). In the game a missing file is asked
  // of the mod once a session (exportTtx) and read again every 2 s for up to 30 s, the way a vehicle export is
  // waited for; outside it a missing file is simply not there. A file of another schema counts as missing.
  function readTtx(type) {
    var id = typeId(type);
    if (!id || !TTX || !ArmorInspectorData.ttx) return Promise.resolve(null);
    if (ttxCache[id]) return Promise.resolve(ttxCache[id]);
    if (ttxPending[id]) return ttxPending[id];
    var now = Date.now();
    if (ttxTried[id] && now - ttxTried[id] < TTX_AGAIN_MS) return Promise.resolve(null);
    ttxTried[id] = now;
    if (host.game && !ttxAsked[id]) { ttxAsked[id] = true; sendCommand('exportTtx', {vehicleType: String(type)}); }
    var deadline = host.game ? now + TTX_WAIT_MS : 0;
    function attempt() {
      return ArmorInspectorData.ttx(id).then(function (t) {
        if (!t || Number(t.schema) !== 1 || (t.id && t.id !== id) || !Array.isArray(t.configs) || !t.configs.length) throw new Error('No characteristics of ' + id);
        return t;
      }).catch(function () {
        if (!deadline || Date.now() >= deadline) return null;
        return new Promise(function (r) { window.setTimeout(r, TTX_RETRY_MS); }).then(attempt);
      });
    }
    ttxPending[id] = attempt().then(function (t) {
      delete ttxPending[id];
      if (t) { ttxCache[id] = t; ttxOrder.push(id); delete ttxTried[id]; while (ttxOrder.length > 8) delete ttxCache[ttxOrder.shift()]; }
      return t;
    });
    return ttxPending[id];
  }
  // The hit points of a vehicle from its characteristics file, for the health bar (targetMaxHp): an export made
  // before the characteristics build has no maxHealth, and the file has it for every pair (spec section 8 point 13)
  // once the page has read it - as the shooter's, in the same session. 0 when it has not.
  function ttxHealth(vehicle) {
    var t = vehicle && vehicle.type ? ttxCache[typeId(vehicle.type)] : null, i = t && TTX ? TTX.match(t, vehicle) : -1;
    return i >= 0 && t.configs[i].maxHealth > 0 ? Number(t.configs[i].maxHealth) : 0;
  }
  // A new shooter (syncShooterMods): his file is taken from the cache or read, and the panel painted.
  function ttxSync(hit) {
    var a = hit && hit.attacker, type = a && a.type ? String(a.type) : '';
    ttxType = type;
    ttxData = type ? ttxCache[typeId(type)] || null : null;
    ttxPaint();
    if (type && !ttxData) readTtx(type).then(function (t) {
      if (!t || ttxType !== type) return;
      ttxData = t; ttxPaint();
      // The health bar of a vehicle whose export has no hit points waits for this file too (its own type's).
      if (funOn() && !(hpMax > 0)) { hpMax = targetMaxHp(activeHit); hpLeft = hpMax; paintFun(); }
    });
  }
  // --- Which pair -------------------------------------------------------------------------------------------
  // The emulator's pair: the gun that fired in the record, or the browsed vehicle's exported one (spec 3.1).
  function ttxEmuIndex() { return ttxData && TTX ? TTX.match(ttxData, activeHit && activeHit.attacker) : -1; }
  // The pair on the panel: the one the user last picked for this type, or the emulator's.
  function ttxPairIndex() {
    var stored = ttxType && aimStore.pairs[ttxType], i = stored ? TTX.pairIndex(ttxData, stored) : -1;
    return i >= 0 ? i : ttxEmuIndex();
  }
  function ttxBuildOn() { var e = $('ttx-build'); return !!(e && e.checked); }
  // The page's own shell when it is one of this gun's, else the gun's first - the garage's active shell.
  function ttxShellOf(shells) {
    var choice = $('shell-choice').value, c = choice && choice.indexOf('saved:') === 0 ? candidates[Number(choice.slice(6))] : null;
    if (c) for (var i = 0; i < shells.length; i++) {
      if (shells[i].kind === c.kind && shells[i].name === c.name && Math.abs((Number(shells[i].caliber) || 0) - (Number(c.caliber) || 0)) < 0.5) return shells[i];
    }
    return shells[0] || null;
  }
  // The figures of pair `index` in the stock or in this build, memoised until anything they read changes. For
  // the build of the emulator's own pair the fire figures come from EXACTLY the emulator's inputs - the block of
  // aimBlockData() and the Config memo - so the panel explains the circle on screen (spec 1.3); every other pair
  // is counted from its own bare block in the file. The stock is always the file's (spec 1.4).
  // `mode` 1: the pair's second mode (23.09) - the same values() on the second block and the vehicle's second figures
  // (ttxModeInput); the emulator's own block stands in for the build only when the emulator is in that very mode.
  function ttxValues(build, index, mode) {
    var a = aimBlockData(), key = [ttxType, aimRev, shooterRev, ttxShell].join('|');
    if (key !== ttxMemoKey || ttxMemo.a !== a || ttxMemo.t !== ttxData) { ttxMemo = {a: a, t: ttxData}; ttxMemoKey = key; }
    var slot = (build ? 'b' : 's') + (mode ? 'm' : '') + index;
    if (ttxMemo[slot]) return ttxMemo[slot];
    var t = ttxData, pair = t.configs[index];
    if (mode) { var mi = ttxModeInput(t, index); t = mi.t; pair = mi.pair; }
    var live = build && index === ttxEmuIndex() && (mode ? 1 : 0) === aimModeNow() ? a : null;
    var fx = shooterEffects(!build), shells = ttxShellsOf(t, pair);
    var v = TTX.values({ttx: t, pair: pair, aim: live || pair.aim || null, shells: shells, shell: ttxShellOf(shells),
                        fx: fx.e, crew: fx.crew, paint: build && !!shooterConfig.paint});
    v.source = live ? 'live' : 'file';
    ttxMemo[slot] = v;
    return v;
  }
  // --- The second mode on the panel (23.09, outputs/second-modes-2026-09-23.md 5.3) --------------------------------
  // The mode of the block the emulator fires with now: the recorded block is the recorded mode's, the other one the
  // other's (modeAimOf).
  function aimModeNow() {
    var at = activeHit && activeHit.attacker;
    if (!at) return 0;
    var rec = at.vehicleMode === 1 ? 1 : 0;
    return aimOfHit(activeHit, xiSiegeMode(xiNow())) === at.aim ? rec : 1 - rec;
  }
  function ttxModeKind(pair) { var sm = pair && pair.aim && pair.aim.siegeMode; return sm ? String(sm.kind || '') : ''; }
  // A pair with a second mode worth a switch: its second block, or the vehicle's own second figures - not the automatic
  // siege, whose second block changes only the hull's tilt (the pair tile's ◐ says so).
  function ttxHasMode(pair) {
    // Nor the charged salvo of a dual gun or a shell switcher's state: those are not a mode switch here (5.5).
    var kind = ttxModeKind(pair);
    if (!pair || kind === 'auto' || kind === 'dualGun' || kind === 'gun') return false;
    var mv = ttxData && ttxData.vehicle && ttxData.vehicle.modeValues;
    return !!((pair.modeAim && pair.modeAim.dispersion > 0) || (mv && Object.keys(mv).length));
  }
  // Which mode the panel shows: under ✸ with a mode button the emulator's own - ONE state, the panel explains the circle
  // on the scene - else the user's choice, kept per type beside the pair (aimStore.modes).
  function ttxModeFollows() { var m = funOn() ? xiNow() : null; return m && m.spec.kind === 'siege' && m.spec.mode !== 'auto' ? m : null; }
  function ttxModeOn() {
    var m = ttxModeFollows();
    if (m) return m.st >= 1 ? 1 : 0;
    return ttxType && aimStore.modes[ttxType] === 1 ? 1 : 0;
  }
  // The file and the pair as the second mode sees them: the second block and the siege gun's limits on the pair, the
  // vehicle's second figures (modeValues: engine power, concealment, view range per turret, the wheels' steering lock)
  // on the file - BullbaTtx.values(), the one formula, reads them as it reads the first mode. Built once per file.
  var ttxModeMemo = null;
  function ttxModeInput(t, index) {
    if (!ttxModeMemo || ttxModeMemo.t !== t) ttxModeMemo = {t: t, file: ttxModeFile(t), pairs: {}};
    if (!ttxModeMemo.pairs[index]) {
      var p = t.configs[index];
      ttxModeMemo.pairs[index] = Object.assign({}, p, {aim: p.modeAim && p.modeAim.dispersion > 0 ? p.modeAim : p.aim, pitch: p.modePitch || p.pitch});
    }
    return {t: ttxModeMemo.file, pair: ttxModeMemo.pairs[index]};
  }
  function ttxModeFile(t) {
    var mv = t.vehicle && t.vehicle.modeValues;
    if (!mv) return t;
    var modules = Object.assign({}, t.modules), vehicle = Object.assign({}, t.vehicle), turrets = t.turrets;
    if (mv.enginePower > 0 && modules.engine) modules.engine = Object.assign({}, modules.engine, {power: mv.enginePower});
    if (mv.maxSteeringLockAngle !== undefined && modules.chassis) modules.chassis = Object.assign({}, modules.chassis, {maxSteeringLockAngle: mv.maxSteeringLockAngle});
    if (Array.isArray(mv.invisibility)) vehicle.invisibility = mv.invisibility;
    if (Array.isArray(mv.circularVisionRadius) && Array.isArray(t.turrets)) turrets = t.turrets.map(function (x, i) {
      return mv.circularVisionRadius[i] > 0 ? Object.assign({}, x, {circularVisionRadius: mv.circularVisionRadius[i]}) : x;
    });
    return Object.assign({}, t, {vehicle: vehicle, modules: modules, turrets: turrets});
  }
  // The words of the two modes of this pair's kind (the client's own names, SIEGE_KINDS).
  function ttxModeWords(pair) { var k = SIEGE_KINDS[ttxModeKind(pair)]; return k ? [k.off, k.on] : ['the first mode', 'the second mode']; }
  function ttxModeToggle() {
    if (!ttxData || !ttxType) return;
    var m = ttxModeFollows();
    if (m) { xiPress({detail: 0}); ttxPaint(); return; }   // under ✸: the emulator's mode button, one state
    if (ttxModeOn()) delete aimStore.modes[ttxType]; else aimStore.modes[ttxType] = 1;
    persistSettings();
    ttxPaint();
  }
  // --- Painting ---------------------------------------------------------------------------------------------
  // ONE widget for a row, in both views: a glyph and a figure (spec 3.4.9).
  function ttxRow(key) {
    var row = node('span', undefined, 'ttx-row'), glyph = TTX_ROWS[key] ? TTX_ROWS[key][0] : key;
    var icon = ttxGlyph(glyph), value = node('b', '—', 'ttx-val');
    row.setAttribute('data-key', key);
    row.appendChild(icon); row.appendChild(value);
    row.ttx = {glyph: glyph, icon: icon, value: value, text: '—', cmp: '', title: ''};
    return row;
  }
  // Only what has changed is written.
  function ttxSet(row, glyph, text, cmp, title) {
    var s = row.ttx;
    if (s.glyph !== glyph) { var icon = ttxGlyph(glyph); row.insertBefore(icon, s.icon); s.icon.remove(); s.icon = icon; s.glyph = glyph; }
    if (s.text !== text) { s.text = text; s.value.textContent = text; }
    if (s.cmp !== cmp) { s.cmp = cmp; if (cmp) row.setAttribute('data-cmp', cmp); else row.removeAttribute('data-cmp'); }
    if (s.title !== title) { s.title = title; row.title = title; }
  }
  // What the build holds, in words, for the tooltips.
  function ttxBuildWords() {
    var sit = AIM_SKILLS.some(function (s) { return s.situational && shooterConfig.skills[s.id]; });
    return 'This build: ' + aimLongSummary() + '; top modules, a crew at 100 % with the commander’s bonus'
      + (sit ? '; the situational perks switched on in Config are counted, which the garage’s main figure does not do' : '');
  }
  function ttxSourceWords(v, build) {
    if (!build) return 'From the characteristics file of this vehicle.';
    return v.source === 'live' ? 'The fire figures come from the gun on the scene - the very circle, reload and aiming the emulator uses, with whatever the record carries (field modifications, the battle’s own modifiers); the rest from the characteristics file.'
      : 'From the characteristics file of this vehicle.';
  }
  // What one paint shows, gathered once: both sets of figures, both sets of strings and the words every tooltip
  // shares (the build's summary is composed once, not once a row).
  function ttxContext(index) {
    var pair = ttxData.configs[index], build = ttxBuildOn(), mode = ttxHasMode(pair) ? ttxModeOn() : 0;
    var stock = ttxValues(false, index, mode), cur = build ? ttxValues(true, index, mode) : stock;
    var shownS = TTX.display(stock);
    var ctx = {build: build, mode: mode, stock: stock, cur: cur, shownS: shownS, shownB: build ? TTX.display(cur) : shownS,
               words: (build ? ttxBuildWords() : TTX_STOCK_WORDS) + '.', source: ttxSourceWords(cur, build)};
    // In the second mode a figure is coloured against the FIRST mode of the same view (stock or build): the rows it
    // changes are marked the way the build is marked against the stock.
    if (mode) {
      ctx.first = ttxValues(build, index, 0); ctx.shownF = TTX.display(ctx.first);
      var w = ttxModeWords(pair); ctx.firstWords = w[0]; ctx.modeWords = w[1];
    }
    return ctx;
  }
  // One row's tooltip: the name and unit, the stock and the build, what is counted and where it comes from.
  function ttxTitle(key, stockText, buildText, ctx, extra) {
    var spec = TTX_ROWS[key] || [key, key, ''];
    return spec[1] + (spec[2] ? ', ' + spec[2] : '') + '. '
      + (ctx.build ? 'Stock ' + stockText + ' · this build ' + buildText + '. ' : 'Stock ' + stockText + '. ') + ctx.words
      + (extra ? ' ' + extra : '') + ' ' + ctx.source + ' ' + TTX_NO_FIELD;
  }
  // One row painted from the context: the figure, its colour against the stock, the tooltip. `textKey` is the
  // figure a compact row prints when it is not the row's own (the reload: one figure whatever the gun).
  function ttxPaintRow(row, key, cmpKey, ctx, textKey) {
    var text = ttxText(textKey || key, ctx.shownB, ctx.cur), sText = ttxText(textKey || key, ctx.shownS, ctx.stock);
    var cmp = ctx.mode ? TTX.compare(ctx.first, ctx.cur, cmpKey || key, ctx.shownF, ctx.shownB)
      : ctx.build ? TTX.compare(ctx.stock, ctx.cur, cmpKey || key, ctx.shownS, ctx.shownB) : '';
    var extra = ttxExtra(key, ctx.cur, ctx.build);
    if (ctx.mode) extra = 'These are ' + ctx.modeWords + '’s; ' + ctx.firstWords + ': ' + ttxText(textKey || key, ctx.shownF, ctx.first)
      + ' - a figure better than there is mint, a worse one red.' + (extra ? ' ' + extra : '');
    ttxSet(row, TTX_ROWS[key] ? TTX_ROWS[key][0] : key, text, cmp, ttxTitle(key, sText, text, ctx, extra));
  }
  // The rows' figures by key, with the reload and the hull resolved to the row that stands for them.
  function ttxRowKey(key, v) {
    if (key === 'reload') return TTX_RELOAD_ROW[v.kind] || 'reloadTimeSecs';
    if (key === 'hull') return v.chassisRotationSpeed === null && v.maxSteeringLockAngle !== undefined ? 'maxSteeringLockAngle' : 'chassisRotationSpeed';
    return key;
  }
  function ttxText(key, shown, v) {
    if (key === 'overheat') return v.overheat ? [String(v.overheat.shots), BullbaTtx.nice(v.overheat.burst), BullbaTtx.nice(v.overheat.cooling)].join('/') : '—';
    if (key === 'dualGun') return (v.dualGun || v.twinGun) ? (v.dualGun || v.twinGun).map(BullbaTtx.nice).join('/') : '—';
    return shown[key] !== undefined ? shown[key] : '—';
  }
  // Extra lines a few rows carry in their tooltip.
  function ttxExtra(key, v, build) {
    if (key === 'avgDamagePerMinute') return v.avgDamage ? 'With a ' + BullbaTtx.nice(v.avgDamage) + ' HP shell at ' + BullbaTtx.nice(v.shotsPerMinute) + ' rounds a minute' + (v.kind === 'autoreload' ? ', the fastest slot' : v.kind === 'overheat' ? ' over the whole heat cycle' : '') + '.' : 'The shell’s damage is not in the file.';
    if (key === 'reloadTimeSecs' || key === 'clipFireRate' || key === 'autoReloadTime' || key === 'overheat' || key === 'dualGun') {
      var pair = ttxData && ttxData.configs[ttxPairIndex()];
      return 'Rate of fire ' + BullbaTtx.nice(v.shotsPerMinute) + ' rounds a minute.' + (v.kind === 'clip' ? ' Mag Mastery shortens the whole reload, not the interval.' : '')
        + (pair && !pair.reloadExtra ? ' What the gun’s mechanics add to the reload was not exported, so it is not counted.' : '');
    }
    if (key === 'circularVisionRadius') return 'Moving: ' + BullbaTtx.nice(v.circularVisionRadiusMoving) + ' m (binoculars work only standing).';
    if (key === 'pitchLimits') {
      // With the hull aiming the garage counts the hull's tilt in (23.09): the gun's own limits go to the tooltip.
      if (v.gunPitchOwn) return 'With the hull’s tilt, as the garage counts it; the gun alone: ' + v.gunPitchOwn.map(BullbaTtx.nice).join('/') + '°. The hull tilts only in the second mode.';
      var p = ttxData && ttxData.configs[ttxPairIndex()] && ttxData.configs[ttxPairIndex()].pitch;
      if (p && Array.isArray(p.minPitch) && p.minPitch.length > 2) return 'The limits change around the turret: these are the extremes over the whole circle.';
    }
    if (key === 'gunYawLimits' && v.gunYawSector) return 'The hull aims the gun sideways, so the garage prints 0/0; the gun itself moves ' + v.gunYawSector.map(BullbaTtx.nice).join('/') + '° in its sector, and past it the hull turns.';
    if (key === 'switchTime') return v.modeKind === 'turboshaft' ? 'The turbine switches only standing; the garage prints its times whole, cut short.' : 'While it switches the gun does not fire and the vehicle stops; a damaged engine makes it slower.';
    if (key === 'autoSiege') return 'The server switches it by the speed; the hull tilts, the circle does not change.';
    if ((key === 'shotDispersionAngle' || key === 'aimingTime') && ttxModeOn() && ttxModeKind(ttxData && ttxData.configs[ttxPairIndex()]) === 'hydraulic')
      return 'The garage shows the travel figures only; this is the siege descriptor’s, by the garage’s own formula.';
    if (key === 'maxHealth' && build && mulOf('healthFactor') !== 1) return 'With the hardening the client rounds the hit points UP to whole tens.';
    return '';
  }
  function mulOf(input) { var e = shooterEffects(false).e; return aimMul({mul: e.dev}, input); }
  function ttxPaint() {
    var panel = $('ttx-panel');
    if (!panel) return;
    var show = !!(TTX && ttxData && ttxData.configs && ttxData.configs.length && !$('shooter-tile').hidden);
    if (panel.hidden !== !show) { panel.hidden = !show; scheduleLayout(LAYOUT_TTX); }
    if (!show) { ['ttx-pairs', 'ttx-more', 'ttx-fold'].forEach(function (id) { var d = $(id); if (d) d.open = false; }); return; }
    var index = ttxPairIndex(), ctx = ttxContext(index), toggle = $('ttx-build-toggle');
    if (toggle && toggle.getAttribute('aria-pressed') !== String(ctx.build)) toggle.setAttribute('aria-pressed', String(ctx.build));
    ttxPaintMode(index, ctx);
    ttxPaintPair(index);
    ['fire', 'move', 'stab'].forEach(function (group) {
      TTX_COMPACT[group].forEach(function (slot) {
        if (ttxRows[slot]) ttxPaintRow(ttxRows[slot], ttxRowKey(slot, ctx.cur), slot === 'reload' ? 'reload' : '', ctx, slot === 'reload' ? 'reload' : '');
      });
    });
    if ($('ttx-more').open) ttxPaintFull(ctx);
  }
  // The pair tile: the gun's calibre and its tier, the ▾ only where there is a choice, lit when the pair on the
  // panel is not the gun the emulator fires.
  // A pair's shells: its own list where its turret overrides the gun's (the mod writes configs[k].shells then,
  // spec section 8 point 4), else the gun's.
  function ttxShellsOf(t, pair) { return (pair && Array.isArray(pair.shells) ? pair.shells : t && t.shells && t.shells[pair.gun]) || []; }
  function ttxCaliber(pair) {
    var shells = ttxShellsOf(ttxData, pair), c = shells.length ? Number(shells[0].caliber) : 0;
    return c > 0 ? String(Math.round(c)) : '—';
  }
  // THE PANEL'S MODE SWITCH (23.09, spec 5.3 p. 1): #ttx-mode, the same lit widget as ⚙ beside it, a glyph and no word.
  // There for a pair with a second mode (ttxHasMode); lit while the panel shows it. Under ✸ it is the emulator's mode.
  function ttxPaintMode(index, ctx) {
    var b = $('ttx-mode'), pair = ttxData.configs[index];
    if (!b) return;
    var show = ttxHasMode(pair);
    if (b.hidden !== !show) { b.hidden = !show; scheduleLayout(LAYOUT_TTX); }
    if (!show) return;
    if (b.getAttribute('aria-pressed') !== String(!!ctx.mode)) b.setAttribute('aria-pressed', String(!!ctx.mode));
    var w = ttxModeWords(pair), follows = !!ttxModeFollows();
    var title = 'The second mode: ' + w[1] + '. ' + (ctx.mode ? 'On: the panel shows ' + w[1] + '’s figures - a figure better than in ' + w[0] + ' is mint, a worse one red.' : 'Off: the panel shows ' + w[0] + '’s figures.')
      + (follows ? ' Under ✸ this is the emulator’s own mode: the switch presses its mode button, with the game’s switch time.' : ' Off ✸ only the panel changes, and the choice is kept for this vehicle.');
    if (b.title !== title) b.title = title;
  }
  function ttxPaintPair(index) {
    var tile = $('ttx-pair'), box = $('ttx-pairs'), pair = ttxData.configs[index];
    if (!tile || !pair) return;
    var many = ttxData.configs.length > 1, other = index !== ttxEmuIndex(), turret = (ttxData.turrets || [])[pair.turret] || {};
    var key = [index, many, other, ttxData.id].join('|');
    if (tile.ttxKey === key) return;
    tile.ttxKey = key;
    // The ◐ the shell chips of a second mode wear, for what the panel does not show by its mode switch: the automatic
    // siege (only the hull tilts), the charged salvo of a dual gun, the rocket booster (the ✸ mode button fires it).
    var modes = (ttxData.vehicle && ttxData.vehicle.modes) || {}, notes = [], sm = pair.aim && pair.aim.siegeMode;
    if (sm && sm.kind === 'auto') {
      var hp = pair.aim.hullAiming && pair.aim.hullAiming.pitch;
      notes.push('the hull tilts' + (hp ? ' ' + BullbaTtx.nice(Math.abs(hp.max) * 180 / Math.PI) + '° down / ' + BullbaTtx.nice(Math.abs(hp.min) * 180 / Math.PI) + '° up' : '')
        + ' at or below ' + BullbaTtx.nice(Number(sm.autoOn) * 3.6) + ' km/h (the automatic siege) - the circle does not change');
    }
    if (modes.dualGun) notes.push('the charged salvo of the two barrels is not shown');
    if (modes.rocketAcceleration) {
      var r = ttxData.vehicle.rocketAcceleration;
      notes.push('a rocket booster' + (r ? ' for ' + BullbaTtx.nice(r.duration) + ' s, ' + r.reuseCount + ' uses' : '') + ' - under ✸ the mode button fires it');
    }
    tile.replaceChildren(node('b', ttxCaliber(pair), 'ttx-cal'), node('span', tierRomans[pair.gunLevel] || '', 'vt-tier'));
    if (notes.length) tile.appendChild(node('span', '◐', 'ttx-mode'));
    box.setAttribute('data-many', String(many));
    if (other) box.setAttribute('data-other', 'true'); else box.removeAttribute('data-other');
    tile.title = (pair.gunUserString || pair.gun) + ' on ' + (turret.userString || turret.name || 'the turret')
      + (many ? '. Click for the other turrets and guns of this vehicle.' : '.')
      + (other ? ' The circle and the gun panel keep the gun that fired; these numbers are this gun’s.' : '')
      + (notes.length ? ' This vehicle: ' + notes.join('; ') + '.' : '');
  }
  // The pair list: grouped by turret, a turret's glyph and tier over its guns; the pair on the panel pressed, the
  // emulator's marked with a dot and the top pair with ▲. Built when it opens, never before.
  function ttxPaintPairs() {
    var list = $('ttx-pair-list');
    if (!list || !ttxData) return;
    list.replaceChildren();
    var build = ttxBuildOn(), here = ttxPairIndex(), emu = ttxEmuIndex();
    TTX.groups(ttxData).forEach(function (g, gi) {
      var head = node('div', undefined, 'ttx-pair-turret');
      if (gi) head.setAttribute('data-rule', 'true');
      head.appendChild(ttxGlyph('turret'));
      head.appendChild(node('span', tierRomans[g.info.level] || '', 'vt-tier'));
      head.title = g.info.userString || g.info.name || '';
      list.appendChild(head);
      var row = node('div', undefined, 'aim-pick-row');
      g.pairs.forEach(function (i) {
        var p = ttxData.configs[i], v = ttxValues(build, i), shell = v.shells.filter(function (s) { return s.selected; })[0] || v.shells[0];
        var tile = node('button', undefined, 'aim-pick ttx-pick');
        tile.type = 'button';
        tile.setAttribute('aria-pressed', String(i === here));
        tile.setAttribute('aria-label', p.gunUserString || p.gun);
        tile.setAttribute('data-tier', 'plain');
        tile.appendChild(node('b', ttxCaliber(p), 'ttx-cal'));
        tile.appendChild(node('span', tierRomans[p.gunLevel] || '', 'vt-tier'));
        if (i === emu) tile.appendChild(node('span', '●', 'ttx-mark ttx-emu'));
        if (p.top) tile.appendChild(node('span', '▲', 'ttx-mark ttx-top'));
        tile.title = (p.gunUserString || p.gun) + ' · ' + (g.info.userString || g.info.name || '') + ' · '
          + (shell ? BullbaTtx.nice(shell.avgDamage) + ' HP, ' + BullbaTtx.nice(shell.avgPiercingPower) + ' mm · ' : '')
          + 'DPM ' + BullbaTtx.nice(v.avgDamagePerMinute) + (build ? ' (this build)' : ' (stock)')
          + (i === emu ? ' · the gun on the scene' : '') + (p.top ? ' · the top pair' : '');
        tile.onclick = function (e) { e.stopPropagation(); ttxChoose(i); };
        row.appendChild(tile);
      });
      list.appendChild(row);
    });
  }
  function ttxChoose(i) {
    if (!ttxData || !ttxType) return;
    aimStore.pairs[ttxType] = TTX.pairKey(ttxData, i);
    persistSettings();
    $('ttx-pairs').open = false;
    ttxPaint();
  }
  // The expanded view (spec 3.4.7): sections under thin rules, no headings, the same rows. Rebuilt while it is
  // open, on the same events as the compact rows; a closed one is not touched.
  function ttxSection(box) { var s = node('div', undefined, 'ttx-sec'); box.appendChild(s); return s; }
  function ttxPaintFull(ctx) {
    var box = $('ttx-full'), cur = ctx.cur;
    if (!box) return;
    box.replaceChildren();
    function rows(sec, keys) { keys.forEach(function (k) { if (!k) return; var row = ttxRow(k); ttxPaintRow(row, k, '', ctx); sec.appendChild(row); }); }
    var fire = ttxSection(box), kind = cur.kind;
    rows(fire, ['avgDamagePerMinute', 'shotsPerMinute', TTX_RELOAD_ROW[kind] || 'reloadTimeSecs',
      'shotDispersionAngle', 'aimingTime', 'stabMovement', 'stabRotation', 'stabTurret', 'stabAfterShot',
      'pitchLimits', cur.gunYawLimits ? 'gunYawLimits' : '', 'maxAmmo']);
    // The shells of the gun: a table under the three icons of the garage, the page's own shell lit.
    var table = ttxSection(box);
    table.className = 'ttx-sec ttx-shells';
    var head = node('div', undefined, 'ttx-shell-row ttx-shell-head');
    head.appendChild(node('span', '', 'ttx-shell-kind'));
    [['avgDamage', 'Average damage, HP'], ['avgPiercingPower', 'Average penetration at up to 50 m, mm'], ['shellVelocity', 'Shell velocity, m/s (the garage’s figure)']].forEach(function (h) {
      var g = ttxGlyph(h[0]); g.title = h[1]; head.appendChild(g);
    });
    table.appendChild(head);
    cur.shells.forEach(function (s) {
      var line = node('div', undefined, 'ttx-shell-row');
      if (s.selected) line.setAttribute('data-selected', 'true');
      var kindBox = node('span', undefined, 'ttx-shell-kind'), img = node('img');
      img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.draggable = false;
      img.onerror = function () { this.remove(); kindBox.appendChild(node('span', shellNames[s.kind] || s.kind, 'aim-icon-text')); };
      img.src = 'web/icons/' + shellIconName(s.shell) + '.png';
      kindBox.appendChild(img);
      line.appendChild(kindBox);
      line.appendChild(node('b', BullbaTtx.nice(s.avgDamage), 'ttx-val'));
      line.appendChild(node('b', BullbaTtx.nice(s.avgPiercingPower), 'ttx-val'));
      // The garage prints a shell's speed whole, truncated (formatters FORMAT_SETTINGS 'shotSpeed': _integralFormat).
      line.appendChild(node('b', BullbaTtx.integral(s.shellVelocity), 'ttx-val'));
      line.title = (s.shell.name || s.kind) + ' · ' + (shellNames[s.kind] || s.kind)
        + (s.damage ? ' · damage ' + s.damage.join('-') + ' HP' : '') + (s.piercingPower ? ' · penetration ' + s.piercingPower.join('-') + ' mm' : '')
        + (s.pen500 !== null ? ', ' + BullbaTtx.nice(s.pen500) + ' mm at 500 m' : '')
        + (s.dpm ? ' · DPM with this shell ' + s.dpm : '') + (s.selected ? ' · the shell the page is using' : '');
      table.appendChild(line);
    });
    var move = ttxSection(box);
    rows(move, ['speedLimits', 'enginePower', 'vehicleWeight', 'enginePowerPerTon', ttxRowKey('hull', cur), 'turretRotationSpeed', 'terrainResistance',
      cur.switchTime ? 'switchTime' : '', cur.autoSiege ? 'autoSiege' : '']);
    rows(ttxSection(box), ['maxHealth']);
    rows(ttxSection(box), ['circularVisionRadius', 'invisibilityStillFactor', 'invisibilityMovingFactor', 'invisibilityAfterShot']);
  }
  // The panel's controls, wired once (index.html holds the markup; the settings menu keeps ⚙'s state).
  function buildTtxPanel() {
    var compact = $('ttx-compact');
    if (!compact) return;
    compact.replaceChildren();
    ['fire', 'move', 'stab'].forEach(function (group) {
      var col = node('div', undefined, 'ttx-col ttx-' + group);
      TTX_COMPACT[group].forEach(function (slot) { ttxRows[slot] = ttxRow(slot); col.appendChild(ttxRows[slot]); });
      compact.appendChild(col);
    });
    $('ttx-build').onchange = function () { ttxPaint(); };
    $('ttx-build-toggle').onclick = function () { var box = $('ttx-build'); box.checked = !box.checked; ttxPaint(); persistSettings(); };
    $('ttx-mode').onclick = ttxModeToggle;
    // The list and the expanded view are built by the click that opens them, which runs before <details> opens.
    $('ttx-pair').onclick = function (e) {
      if (!ttxData || ttxData.configs.length < 2) { if (e && e.preventDefault) e.preventDefault(); return; }
      if (!$('ttx-pairs').open) ttxPaintPairs();
    };
    $('ttx-more-button').onclick = function () {
      if ($('ttx-more').open || !ttxData) return;
      ttxPaintFull(ttxContext(ttxPairIndex()));
    };
  }
  // Another shell on the page may change the DPM and the lit row of the shell table: painted only when the shell
  // itself changed, not on every distance step that runs updateShell.
  function ttxShellChanged() {
    var choice = $('shell-choice').value, c = choice && choice.indexOf('saved:') === 0 ? candidates[Number(choice.slice(6))] : null;
    var key = c ? [c.kind, c.name, c.caliber].join('|') : '';
    if (key === ttxShell) return;
    ttxShell = key;
    if (ttxData) ttxPaint();
  }
  // Folded into one button when the scene is small (spec 3.4.2): the same <details> + .toolbar-popover as the
  // modifier groups, the controls moved into it and back, every listener kept.
  function ttxFold(on) {
    var fold = $('ttx-fold'), inner = $('ttx-inner'), panel = $('ttx-panel');
    if (!fold || !inner || on === ttxFolded) return;
    ttxFolded = on;
    fold.hidden = !on;
    if (on) $('ttx-fold-pop').appendChild(inner);
    else { fold.open = false; panel.appendChild(inner); }
  }
  // The fun layer's ONE switch (user, 22.09: the two Settings rows of 0.7.25 are gone). #fun-mode is an
  // ordinary, hidden control of the Settings menu, so the settings machinery stores it, restores it and
  // runs this handler with every other setting - there is no second copy of that logic here. The button
  // the user sees is on the scene beside the model tile: it flips that control, runs the same handler and
  // saves, which is exactly what a change of the control does.
  $('fun-mode').onchange=funSettings;
  $('fun-mode-toggle').onclick=function(){var box=$('fun-mode');box.checked=!box.checked;funSettings();persistSettings();};
  $('target-hp-reset').onclick=funReset;
  // The tier-XI mode button in the gun panel (BACKLOG 37): what a press does is the shooter's mechanic's (xiPress).
  $('aim-gun-mech').onclick=xiPress;
  // The Strv 107-12's touch and hold (23.09): the left button's own down and up, timed (xiDown/xiUp); leaving the button
  // or losing the pointer drops a hold that has not gone off.
  $('aim-gun-mech').onpointerdown=xiDown;
  $('aim-gun-mech').onpointerup=xiUp;
  $('aim-gun-mech').onpointerleave=xiHoldCancel;
  $('aim-gun-mech').onpointercancel=xiHoldCancel;
  // ✸'s sub-switch, real reload: the same pattern - a hidden control of the menu keeps it, the button on the scene flips it.
  $('real-reload').onchange=realReloadSettings;
  $('real-reload-toggle').onclick=function(){var box=$('real-reload');box.checked=!box.checked;realReloadSettings();persistSettings();};
  // How deep the soft light shades (user, 22.09): the slider only scales the composite's brightness range.
  // It sits in the checkbox's own row, like the ricochet tint and dots, so the Settings grid keeps its pairs.
  $('light-strength').oninput=function(){
    $('light-strength-value').textContent=this.value+' %';
    if(viewer)viewer.setLightStrength(Number(this.value)/100);
  };
  // A switch and its own sliders are ONE row of Settings (user, 22.09: the same function is the same widget
  // and the same code). A slider means nothing with its switch off, so it is disabled and its row greyed
  // out with it - one function for every such row, not a copy per checkbox. A checkbox with more sliders
  // than one row holds keeps them in a second .hatch-row under the first, and both rows are named here.
  function rowState(box,ids){
    var on=!!($(box)||{}).checked;
    ids.forEach(function(id){var input=$(id);if(!input)return;input.disabled=!on;
      var row=input.parentNode;if(row&&row.classList)row.classList.toggle('off',!on);});
  }
  function lightStrengthState(){rowState('soft-lighting',['light-strength']);}
  function outlineState(){rowState('wireframe',['outline-brightness','outline-opacity']);}
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
      if(box&&box.values&&typeof box.values==='object'){
        // v2 (user, 22.09): the impact cross was hard to see at the old default of 50 %, so the default is 90.
        // A store written before that keeps the user's own choice and only lets the old default through.
        if(!(box.v>=2)&&String(box.values['impact-opacity'])==='50')delete box.values['impact-opacity'];
        // v3 (user, 22.09): the lighting depth default moves from 100 to 250 %; a stored 100 from the old default follows.
        if(!(box.v>=3)&&String(box.values['light-strength'])==='100')delete box.values['light-strength'];
        // v4 (user, 22.09, same evening): 250 % was too deep after all - the default is 200, and a store
        // holding the 250 it was given by the previous default takes the new one. A depth the user set
        // himself to anything else is his own and is kept.
        if(!(box.v>=4)&&String(box.values['light-strength'])==='250')delete box.values['light-strength'];
        // The fun layer's two rows of 0.7.25 (Target HP, Hit marks) became ONE switch on the scene
        // (user, 22.09). The controls are gone, so their stored values belong to nothing: they are
        // dropped here rather than left to ride along in the box for ever. No version gate - the keys
        // cannot come back, and a store written by any build may still hold them.
        delete box.values['target-hp-on'];delete box.values['hit-marks-on'];
        return box.values;}}catch(e){}
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
    try{window.localStorage.setItem(SETTINGS_KEY,JSON.stringify({v:4,values:values,aim:aimStored()}));}catch(e){}
  }
  function restoreSettings(){
    var stored=settingsStored(),migrated=false;
    if(!stored){stored=settingsLegacy();migrated=!!stored;}
    settingControls.forEach(function(el){
      settingDefaults[el.id]=settingDefault(el);
      // ✸ is not remembered (user, 23.09): every opening of the page shows the recorded shot as it was, the emulation
      // layer (HP bar, RNG shots, Hitmarks) waits for its switch. Its own sub-switches (real reload) still are.
      if(stored&&el.id!=='fun-mode'&&Object.prototype.hasOwnProperty.call(stored,el.id)&&settingValid(el,stored[el.id]))settingSet(el,stored[el.id]);
      settingRun(el);
      // One shared listener per control instead of a save inside every handler; a programmatic change below
      // fires no event, so a restore and a reset never write anything back.
      el.addEventListener('change',persistSettings);
      if(el.type==='range')el.addEventListener('input',persistSettings);
    });
    if(migrated)persistSettings();
  }
  // A slider under the cursor takes the wheel and the arrows (user, 22.09): no click to focus it first, and
  // the step is the slider's own, so 1 % stays 1 % whatever the mouse is set to. Capture phase and
  // stopPropagation, or the same wheel would zoom the scene and the arrows would walk the camera.
  (function(){
    var hovered=null,rolled=0;
    function under(target){for(var n=target;n;n=n.parentNode)if(n.type==='range')return n.disabled?null:n;return null;}
    // `mult` is how many of the slider's own steps this one event is worth (the wheel's run below); it is
    // clamped here to a tenth of the slider's range, so however long the wheel is spun one event never
    // crosses the scale. The value stays on the slider's own grid - Zoom's step is smaller than a whole
    // unit, and adding it up would drift off the grid.
    function step(el,dir,mult){
      var s=Math.abs(Number(el.step))||1,min=el.min===''?0:Number(el.min),max=el.max===''?100:Number(el.max);
      var cap=Math.max(1,Math.floor((max-min)/10/s)),n=Math.max(1,Math.min(mult>0?mult:1,cap));
      var was=Number(el.value),now=was+dir*s*n;
      now=min+Math.round((Math.min(max,Math.max(min,now))-min)/s)*s;
      now=Math.min(max,Math.max(min,Number(now.toFixed(6))));   // 7 × 0.1 is 0.7000000000000001 without this
      if(!isFinite(now)||now===was)return;
      el.value=String(now);
      // The control's own handler draws the change; the shared 'input'/'change' listeners save it.
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    // A continuous turn of the wheel steps further and further (user, 22.09: one unit a notch is too fine,
    // and Zoom's own step is smaller than a whole). The run counts the notches that arrive without a pause
    // and its multiplier walks 1, 1, 2, 3, 5, 8 … - each the sum of the two before it - until step() cuts it
    // to a tenth of the slider's range. A notch after a pause, the other direction or another slider starts
    // the run over at the smallest step there is. Only the wheel grows: an arrow key is a deliberate press
    // each time and keeps the minimal step.
    var runEl=null,runDir=0,runAt=-1,runPrev=0,runStep=1;
    var RUN_FAST=.15,RUN_OVER=.3;   // seconds: under the first the turn is continuous, over the second it is done
    function runMultiplier(el,dir){
      var now=aimSeconds(),gap=now-runAt;
      if(el!==runEl||dir!==runDir||gap>RUN_OVER){runPrev=0;runStep=1;}
      else if(gap<RUN_FAST&&runStep<1e4){var next=runPrev+runStep;runPrev=runStep;runStep=next;}
      runEl=el;runDir=dir;runAt=now;
      return runStep;
    }
    function wheelStep(el,dir){step(el,dir,runMultiplier(el,dir));}
    document.addEventListener('pointerover',function(e){hovered=under(e&&e.target);rolled=0;},true);
    document.addEventListener('pointerout',function(e){if(hovered&&hovered===under(e&&e.target)){hovered=null;rolled=0;}},true);
    document.addEventListener('wheel',function(e){
      var el=under(e&&e.target)||(hovered&&hovered.isConnected!==false?hovered:null);
      if(!el)return;
      var d=e.deltaY||e.deltaX||0;
      if(!d)return;
      e.preventDefault();e.stopPropagation();
      // One notch is one step of the run. A trackpad sends many small deltas instead, so they add up to a
      // notch first - and only a notch counts towards the run, never the deltas that made it.
      if(e.deltaMode!==0||Math.abs(d)>=40){rolled=0;return wheelStep(el,d<0?1:-1);}
      rolled+=d;
      if(Math.abs(rolled)<100)return;
      wheelStep(el,rolled<0?1:-1);rolled=0;
    },{capture:true,passive:false});
    document.addEventListener('keydown',function(e){
      var el=hovered;
      if(!el||el.isConnected===false||document.activeElement===el)return;   // focused: the browser steps it itself
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      var t=e.target;
      if(t&&t!==el&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable))return;
      var dir=e.key==='ArrowUp'||e.key==='ArrowRight'||e.key==='+'||e.key==='='?1:
        e.key==='ArrowDown'||e.key==='ArrowLeft'||e.key==='-'||e.key==='_'?-1:0;
      if(!dir)return;
      e.preventDefault();e.stopPropagation();
      step(el,dir);
    },true);
  }());
  $('reset-settings').onclick=function(){
    settingControls.forEach(function(el){settingSet(el,settingDefaults[el.id]);settingRun(el);});
    try{window.localStorage.removeItem(SETTINGS_KEY);}catch(e){}
    // The shooter presets a user saved and the build he made by hand are his own data, not settings of this
    // menu, so they are kept.
    if(aimUserNames().length||Object.keys(aimStore.custom).length||Object.keys(aimStore.pairs).length)persistSettings();
  };
  // The Target group is built before the settings are restored: restoring the Display setting already runs
  // updateShell(), which asks the group whether it belongs on screen.
  buildTargetMods();
  buildAimConfig();
  buildTtxPanel();
  restoreSettings();
  lightStrengthState();outlineState();   // the stored switches decide whether their own sliders are live
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
  // The hit-line panel's circle tile stands at the right end of the SAME top band as a mod slot (22.09), so
  // the room a group has up there ends where that tile begins. Measured in the layout pass, not per frame;
  // the tile below it is on the next row and never in the way.
  function circleBand(){
    var e=$('shot-circle-tile');
    if(!e||e.hidden)return 0;
    var w=e.getBoundingClientRect().width;
    return w>0?w+12:0;
  }
  function placeMods(group,slot,tile){
    var box=$('viewport');
    if(!group||!slot||slot.hidden||!box||!box.clientWidth)return;
    // The tile is centred with a transform, which offsetLeft does not see: its painted right edge comes from
    // the rectangles, measured against the viewport's own.
    var edge=14,gap=12,left=edge,band=circleBand();
    if(tile&&tile.getBoundingClientRect().width>0){var box0=box.getBoundingClientRect(),t0=tile.getBoundingClientRect();left=Math.max(edge,t0.right-box0.left+gap);}
    slot.style.left=left+'px';
    group.fit(box.clientWidth-edge-band-left);
    // Collapsed, a group is exactly as wide as its own summary button, which fit() cannot shrink. When even
    // that does not fit beside the tile it is pulled back to the edge of the viewport instead of being
    // painted past it - overlapping the tile is the lesser evil, and only the bottom band ever gets there.
    var width=slot.getBoundingClientRect().width;
    if(left+width>box.clientWidth-edge-band)slot.style.left=Math.max(edge,box.clientWidth-edge-band-width)+'px';
  }
  function layoutMods(){
    // Measured against the model tile's whole ROW since 22.09: the health bar and its ↺ stand in it, so
    // the room left for the group starts to the right of them, not of the tile.
    placeMods(targetMods,$('target-mods-slot'),$('model-tile').hidden?null:$('model-row')||$('model-tile'));
  }
  // One rAF debounce for all three: the heading is measured first, because stacking it changes nothing the
  // toolbar measures but a toolbar fold must not race the heading's own reflow.
  // The pose tile sits in the bottom-left corner and the shooter row is centred on the same bottom line; on a
  // narrow page the row's left end (the speed tile) would ride over it, so the pose tile then steps up above
  // the row instead of overlapping (user, 20.09). Measured, not guessed: the row's width depends on what it shows.
  // ONE rule for both bottom corners (23.09): the pose tile on the left and the characteristics panel on the right
  // (its mirror) each step up above the shooter row when the row would ride over them. Returns whether it rose.
  function layoutCorner(el){
    var row=document.querySelector('.shooter-row');if(!el||el.hidden)return false;
    el.style.bottom='';
    if(!row||!row.offsetWidth)return false;
    var p=el.getBoundingClientRect(),r=row.getBoundingClientRect();
    if(p.right+10>r.left&&p.left-10<r.right&&p.bottom>r.top&&p.top<r.bottom){el.style.bottom=(r.height+20)+'px';return true;}
    return false;
  }
  function layoutPose(){layoutCorner($('pose-info'));}
  // The characteristics panel: measured in its full form first; raised over the shooter row on a scene lower than
  // ~420 px or narrower than ~720 px it folds into one button instead (spec 3.4.2), the modifier groups' mechanism.
  function layoutTtx(){
    var panel=$('ttx-panel'),box=$('viewport');if(!panel||panel.hidden)return;
    ttxFold(false);
    var raised=layoutCorner(panel);
    if(raised&&box&&(box.clientHeight<420||box.clientWidth<720)){ttxFold(true);layoutCorner(panel);}
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
      if(p&LAYOUT_HEADING)layoutHeading();if(p&LAYOUT_TOOLBAR)layoutToolbar();if(p&LAYOUT_MODS)layoutMods();if(p&LAYOUT_POSE)layoutPose();
      // The shooter row decides both corners, so what moves the pose tile lays the panel out again too.
      if(p&(LAYOUT_POSE|LAYOUT_TTX))layoutTtx();});
  }
  window.addEventListener('resize',function(){scheduleLayout();}); // not the handler itself: the Event would be read as a mask
  // Closing on a click outside is written out here: the settings menu has no such handler to reuse. Every
  // popover of the page is a .toolbar-more <details>, the toolbar's own and the modifier groups' alike, and
  // the battle list of the heading tile rides on the same handler rather than bringing a third mechanism.
  // WHERE THE CLICK CAME FROM IS THE EVENT'S OWN PATH, not the tree as it stands now (22.09): a control whose
  // own handler repaints the menu around it - choosing a preset, picking a device - is gone from the document
  // by the time this runs, and `contains(e.target)` then read that click as one from outside and closed the
  // menu under the user. composedPath() is taken when the dispatch starts, so it still names the menu.
  function clickedIn(e,box){var path=e.composedPath?e.composedPath():null;return path&&path.length?path.indexOf(box)>=0:box.contains(e.target);}
  document.addEventListener('click',function(e){document.querySelectorAll('.toolbar-more[open]').forEach(function(d){if(!clickedIn(e,d))d.open=false;});
    var pick=document.querySelector('.heading-pick');
    if(pick&&!$('battle-list').hidden&&!clickedIn(e,pick))openBattleList(false);});
  layoutHeading();layoutToolbar();layoutMods();layoutPose();layoutTtx();
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
