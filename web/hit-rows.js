/* The vehicle tile and the hit row, shared by Bullba Hits (Viewer.html, web/app.js) and the 3D replay viewer
   (playback.html, web/playback/shots-panel.js and its team lists) - BACKLOG 109, 19.11.2026: one implementation, so both
   windows look like one product. Moved out of web/app.js unchanged; the styles are web/rows.css (moved out of style.css).
   No page state here: every function builds markup from what it is handed.
   BullbaRows {node, effects, tierRomans, classNames, roleFamilies, roleNames, nationNames, vehicleNation, vehicleWords,
   vehicleTile, iconColumn, result, resultIcon, hitRow}. */
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
    return (info.name||'Unknown vehicle')+(line?'\n'+line:'');
  }
  // opts.compact (the replay viewer's team lists, 19.11: they lie over the 3D view, so a row stays light - the game's own
  // team lists show the vehicle and the player, no flag): one line - the class mark, the tier, the name; no nation flag and
  // no role mark. The words of the tile stay whole (vehicleWords).
  function vehicleTile(info,bare,opts){
    info=info||{};
    var compact=!!(opts&&opts.compact);
    var tile=node('span',undefined,'vehicle-tile'+(compact?' compact':'')),nation=vehicleNation(info);
    if(nationNames[nation]&&!compact)tile.setAttribute('data-nation',nation);
    var tier=tierRomans[info.level]||'',cls=classNames[info['class']]?info['class']:null,family=roleFamilies[info.role]||null;
    var mark=node('span',undefined,'vt-class');
    if(cls){mark.setAttribute('data-class',cls);mark.title=classNames[cls];}
    if(compact){
      tile.appendChild(mark);tile.appendChild(node('span',tier,'vt-tier'));tile.appendChild(node('span',info.name||'Unknown vehicle','vt-name'));
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
  function hitRow(hit,view,other,o){
    o=o||{};
    var hasDamage=hit.damage>0,b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(!!o.pressed));
    b.setAttribute('data-direction',view);b.setAttribute('data-result',hasDamage?'damage':'none');
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
  root.BullbaRows={node:node,effects:effects,tierRomans:tierRomans,classNames:classNames,roleFamilies:roleFamilies,roleNames:roleNames,
    nationNames:nationNames,vehicleNation:vehicleNation,vehicleWords:vehicleWords,vehicleTile:vehicleTile,iconColumn:iconColumn,
    result:result,resultIcon:resultIcon,hitRow:hitRow};
})(typeof window!=='undefined'?window:this);
