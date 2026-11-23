/* The vehicle tile and the hit row, shared by Bullba Hits (Viewer.html, web/app.js) and the 3D replay viewer
   (playback.html, web/playback/shots-panel.js and its team lists) - BACKLOG 109, 19.11.2026: one implementation, so both
   windows look like one product. Moved out of web/app.js unchanged; the styles are web/rows.css (moved out of style.css).
   No page state here: every function builds markup from what it is handed.
   BullbaRows {node, effects, tierRomans, classNames, roleFamilies, roleNames, nationNames, vehicleNation, vehicleWords,
   vehicleNamer, vehicleTile, iconColumn, result, resultIcon, hitRow, openLink, modeMark, modeOption, modeWords}. */
(function (root) {
  'use strict';
  function node(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  // The server's effect of a hit point (the low byte of its segment): the words of a row's result. Tools cut this literal
  // out of this file by its name (tools/verdicts_offline.cjs, tests/test_verdict_line.cjs).
  var effects={0:'Penetration without damage',1:'Intermediate ricochet',2:'Ricochet',3:'No penetration',4:'Penetration',5:'Critical hit',6:'Penetration with module damage'};
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
  function vehicleNation(info){return info.nation||String(info.type||'').split(':')[0];}
  // The tile's words in the page's tooltip markup: the name as the heading, then tier, nation, class and role in
  // one line. A list row that carries its own tooltip takes these words into it and asks for a bare tile
  // (bare = true), so the tile, which covers most of the row, does not hide the row's words under its own.
  function vehicleWords(info){
    info=info||{};
    var cls=classNames[info['class']]?info['class']:null,family=roleFamilies[info.role]||null;
    var line=[tierRomans[info.level]?'Tier '+tierRomans[info.level]:'',nationNames[vehicleNation(info)]||'',classNames[cls]||'',
      family&&family!=='spg'?roleNames[family]+' role':''].filter(Boolean).join(' · ');
    // a name the vehicle list could not give (vehicleNamer): the game's code name, and why
    if(info.unnamed)line=(line?line+' · ':'')+'Game code name: '+info.unnamed;
    return (info.name||'Unknown vehicle')+(line?'\n'+line:'');
  }
  // THE NAME OF A VEHICLE TYPE (23.11, the user's Redshire battle of 22.11 on the VK 30.01 P: one row named 'VK 30.01 P',
  // tier VI, the three others of the same type 'G27_VK3001P' with no tier - the replay viewer took the name from the 3D
  // model file of the row's module configuration, and only one configuration had its file). The one resolver of the
  // replay viewer: rows - the client's vehicle list (data/vehicles.js, the catalogue Hits' Vehicles list shows; null when
  // it could not be read) -> name(type 'nation:Code', also) -> the tile's {name, level, class, role, nation, type}. A type
  // the list lacks takes `also` (a record of the same type that names it: a vehicle file's tile) and else its code name,
  // marked `unnamed` (the tile's words say why). Every configuration of a type gets the same answer.
  function vehicleNamer(rows){
    var byType={},read=Array.isArray(rows);
    (rows||[]).forEach(function(r){if(r&&r.type&&r.name&&!byType[r.type])byType[String(r.type)]=r;});
    return function(type,also){
      type=String(type||'');
      var r=byType[type];
      if(!r&&also&&also.name&&(!also.type||String(also.type)===type))r=also;
      if(r)return {name:String(r.name),level:r.level,'class':r['class'],role:r.role,nation:r.nation||type.split(':')[0],type:type};
      var code=type.split(':').pop();
      return {name:code||'Unknown vehicle',nation:type.indexOf(':')>0?type.split(':')[0]:undefined,type:type,
        unnamed:read?'not in the client\'s vehicle list':'the vehicle list was not read'};
    };
  }
  // opts.compact (the replay viewer's team lists, 19.11: they lie over the 3D view, so a row stays light - the game's own
  // team lists show the vehicle and the player, no flag): the tier, the class mark, the name on one line (the tier first
  // and at one width, as in the full tile's second line, so the tiers of a list stand in one column - 23.11, NOTEBOOK Z16);
  // no nation flag and no role mark. opts.player (Z16): a second line, the player's name, under the vehicle's name.
  // The words of the tile stay whole (vehicleWords).
  function vehicleTile(info,bare,opts){
    info=info||{};
    var compact=!!(opts&&opts.compact);
    var tile=node('span',undefined,'vehicle-tile'+(compact?' compact':'')),nation=vehicleNation(info);
    if(nationNames[nation]&&!compact)tile.setAttribute('data-nation',nation);
    var tier=tierRomans[info.level]||'',cls=classNames[info['class']]?info['class']:null,family=roleFamilies[info.role]||null;
    var mark=node('span',undefined,'vt-class');
    if(cls){mark.setAttribute('data-class',cls);mark.title=classNames[cls];}
    if(compact){
      var line=node('span',undefined,'vt-line');
      line.appendChild(node('span',tier,'vt-tier'));line.appendChild(mark);line.appendChild(node('span',info.name||'Unknown vehicle','vt-name'));
      tile.appendChild(line);
      if(opts.player!=null){tile.classList.add('two-line');tile.appendChild(node('span',opts.player,'vt-player'));}
      if(!bare)tile.title=vehicleWords(info);
      return tile;
    }
    tile.appendChild(node('span',info.name||'Unknown vehicle','vt-name'));
    // Second line: tier, class icon (the client's own outline icon), role icon.
    var meta=node('span',undefined,'vt-meta');
    meta.appendChild(node('span',tier,'vt-tier'));
    meta.appendChild(mark);
    var role=node('span',undefined,'vt-role');
    if(family){role.setAttribute('data-role',family);role.title='Role: '+roleNames[family]+(cls&&family!=='spg'?' ('+classNames[cls].toLowerCase()+')':'');}
    meta.appendChild(role);tile.appendChild(meta);
    if(!bare)tile.title=vehicleWords(info);
    return tile;
  }
  // The icon column of a list row (25.09): one fixed width on every hit and event row, so the flags of the vehicle
  // tiles stand in one line. Up to four icons ({src,title} - web/crits.js decides every file), centred: one alone,
  // two side by side, three or four 2x2. An icon's words are its own: a click shows them, not the row (data-tip-own).
  // An icon that fails to load takes itself away; the column stays.
  function iconColumn(list){
    var box=node('span',undefined,'hit-crits');box.setAttribute('data-n',String(list.length));
    list.forEach(function(c){var i=node('img',undefined,'crit-icon');i.alt='';i.title=c.title;i.setAttribute('data-tip-own','');
      i.onerror=function(){i.remove();box.setAttribute('data-n',String(box.children.length));};i.src=c.src;box.appendChild(i);});
    return box;
  }
  // A hit's result: its damage, else the server's effect of its last decoded point.
  function result(hit){if(hit.damage>0)return 'Damage '+hit.damage+' HP';var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;});return p.length?(effects[p[p.length-1].effect]||'Result '+p[p.length-1].effect):'Result not decoded';}
  function resultIcon(hit){if(hit.damage>0)return '▰ −'+hit.damage;var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;}),effect=p.length?p[p.length-1].effect:null;return effect===2||effect===1?'↪':effect===3?'▰ ×':effect===4?'▰ ✓':effect===5||effect===6||effect===0?'▰ 0':'—';}
  // The row of one hit in a list (Hits' hit list, the viewer's shots panel): the other party's tile (bare: the row carries
  // the words), the icon column, the outcome - the direction arrow, the damage or the no-damage result icon, the time
  // under it. hit: {damage, points:[{effect}]} - whatever else it has is the caller's; view 'incoming' | 'outgoing';
  // other: the tile's vehicle (null: an empty tile); o: {crits: [{src,title}] (up to four), time: the text under the
  // figure, mark: a node put before that text (Hits' replay-only mark), pressed}. The caller sets the row's own attributes,
  // title and click.
  // o.side 'ally' | 'enemy' | 'unknown' (the replay viewer's shots panel, 20.11): the shooter's team as the player whose
  // battle it is sees it - rows.css colours the edge, arrow and figure by it. Hits sets none and keeps its colours by
  // direction, which in Hits are the same thing: its outgoing shots are the player's own, its incoming ones an enemy's.
  function hitRow(hit,view,other,o){
    o=o||{};
    var hasDamage=hit.damage>0,b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(!!o.pressed));
    b.setAttribute('data-direction',view);b.setAttribute('data-result',hasDamage?'damage':'none');
    if(o.side)b.setAttribute('data-side',o.side);
    b.appendChild(vehicleTile(other,true));
    // Critical damage (22.09): the client's own icons of the damaged modules and injured crew, up to four, every
    // word in the icon's title. The column is on every row, empty when nothing is known about the crits (25.09).
    b.appendChild(iconColumn((o.crits||[]).slice(0,4)));
    // Outcome widget: direction arrow in the top-left corner, the figure (damage, or the no-damage result icon)
    // in the top-right, the time underneath - the arrow never glues to the figure.
    var outcome=node('span',undefined,'hit-outcome'),line=node('span',undefined,'outcome-line');
    line.appendChild(node('span',view==='incoming'?'↙':'↗','outcome-dir'));
    line.appendChild(hasDamage?node('span',String(hit.damage),'hit-damage'):node('span',resultIcon(hit).replace(/▰ ?/,''),'hit-result'));
    var time=node('span',o.time===undefined?'—':o.time,'hit-time');if(o.mark)time.insertBefore(o.mark,time.firstChild);
    outcome.appendChild(line);outcome.appendChild(time);b.appendChild(outcome);
    return b;
  }
  // A row's link to the other page (21.11, BACKLOG 118; moved out of web/playback/shots-panel.js): an arrow leaving a box
  // ("opens elsewhere"; not ↗, which a row's outcome uses for an outgoing shot) over the other page's name - the viewer's
  // 'Bullba Hits' beside its shot rows, Hits' 'Replays' inside its selected hit row. tag 'button' (a control of its own
  // beside the row) or 'span' (inside the row's own button: role button, the click kept from the row); rows.css .sp-open.
  var OUT_ICON='<svg class="sp-open-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3H3v10h10V9" fill="none" stroke="currentColor" stroke-width="1.5"/>'+
    '<path d="M9 2h5v5M14 2 7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  function openLink(name,title,open,tag,icon){
    var h=node(tag||'button',undefined,'sp-open');
    if(h.tagName==='BUTTON')h.type='button';else{h.setAttribute('role','button');h.tabIndex=0;}
    if(icon){h.classList.add('mod-link');var image=node('img',undefined,'sp-open-icon mod-icon');image.src=icon;image.alt='';h.appendChild(image);}
    else {h.innerHTML=OUT_ICON;h.appendChild(node('span',name,'sp-open-name'));}
    h.setAttribute('aria-label',name);h.title=title;
    h.onclick=function(e){e.stopPropagation();e.preventDefault();open();};
    h.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.stopPropagation();e.preventDefault();open();}};
    return h;
  }
  // THE SPECIAL-MODE MARK (22.11, BACKLOG 129: the 1.28 sign turned white where a place wrote the text without its span):
  // the one place that writes the warning of a battle of a special mode (replay_files.special_mode / web/replay-mode.js:
  // {name}). modeMark: the yellow sign as an element (rows.css .mode-mark), its words in its title; null for no special mode.
  // modeOption: a native <option> (which holds text only) gets the sign as its text's first character, data-special (the
  // mode's name), data-label (its text without the sign: what a page's own list draws beside modeMark) and the title.
  var MODE_SIGN='⚠';
  function modeWords(special){return 'Special battle mode: '+(special.name||'unknown')+'\nThe picture may be wrong for this mode.';}
  function modeMark(special){
    if(!special)return null;
    var e=node('span',MODE_SIGN,'mode-mark');e.setAttribute('data-special',special.name||'');e.title=modeWords(special);e.setAttribute('aria-label','Special battle mode');
    return e;
  }
  function modeOption(option,label,special){
    option.textContent=(special?MODE_SIGN+' ':'')+label;
    if(special){option.setAttribute('data-special',special.name||'');option.setAttribute('data-label',label);option.title=modeWords(special);}
    return option;
  }
  root.BullbaRows={modeMark:modeMark,modeOption:modeOption,modeWords:modeWords,node:node,effects:effects,tierRomans:tierRomans,classNames:classNames,roleFamilies:roleFamilies,roleNames:roleNames,
    nationNames:nationNames,vehicleNation:vehicleNation,vehicleWords:vehicleWords,vehicleNamer:vehicleNamer,vehicleTile:vehicleTile,iconColumn:iconColumn,
    result:result,resultIcon:resultIcon,hitRow:hitRow,openLink:openLink};
})(typeof window!=='undefined'?window:this);
