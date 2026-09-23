/* Critical damage of a hit (22.09): the crit code of the hit record and what the exporter tied to it (hit.crits).
   Icons are the client's own; every word goes into the hover title, in the page's tooltip markup (a heading
   line, then bullet points "Key: text"; web/tooltips.js). Nothing known about a hit's crits gives nothing at all -
   a missing crit code does not mean "no crit" (a splash crit comes without one). */
(function(root){
  'use strict';
  var BASE='web/icons/crits/';
  var DEVICES={engine:'Engine',ammoBay:'Ammo rack',fuelTank:'Fuel tanks',radio:'Radio',track:'Track',wheel:'Wheel',gun:'Gun',turretRotator:'Turret ring',surveyingDevice:'Vision devices'};
  var CREW={commander:'Commander',driver:'Driver',radioman:'Radio operator',gunner:'Gunner',loader:'Loader'};
  var STATES={damaged:'damaged',critical:'damaged (critical)',destroyed:'destroyed',injured:'injured',detonated:'detonated',burnOff:'burned off',started:'started'};
  var ORDER={destroyed:0,detonated:0,burnOff:0,injured:1,critical:2,damaged:3,started:4};
  var SOURCES={damageInfo:'the vehicle\u2019s damage report',hitDirection:'the hit indicator',fireInfo:'the fire report',shotFlags:'your shot result',
    snapshotDiff:'the target\u2019s damaged-modules panel, before/after',publicState:'the vehicle\u2019s public state',fireComponent:'flames on the vehicle',ammoBayEffect:'the ammo-rack effect'};
  var TIES=['record','unique','nearest','shared','time-only'];
  // How a crit is tied to this hit: the words after "Matched:".
  var TIE_TEXT={unique:'by shooter and time',nearest:'the nearest of several hits',shared:'shared with other hits between two panel updates','time-only':'by vehicle and time only'};
  var LOG_SOURCES={hitDirection:'mask',damageInfo:'info',fireInfo:'fire',fireComponent:'fire',shotFlags:'flags',snapshotDiff:'diff',publicState:'state',ammoBayEffect:'state'};
  function decoded(hit){return ((hit&&hit.points)||[]).filter(function(p){return p&&typeof p.effect==='number';});}
  // The last decoded point's effect when it is 5 or 6: the rule result() and crit_tie.py use for the hit's outcome.
  function lastCode(hit){var p=decoded(hit),e=p.length?p[p.length-1].effect:null;return e===5||e===6?e:null;}
  function lastPart(hit){var p=decoded(hit);return p.length?p[p.length-1].part:null;}
  function raw(hit){return hit&&hit.crits&&Array.isArray(hit.crits.items)?hit.crits.items.filter(function(it){return it&&it.type&&it.state;}):[];}
  function renderable(it){
    if(it.kind==='fire')return it.state==='started';
    if(it.kind==='ammoBay')return true;
    if(it.kind==='crew')return !!CREW[it.type];
    return it.kind==='device'&&(!!DEVICES[it.type]||it.type==='chassis'||it.type==='device');
  }
  function items(hit){
    var seen={};
    return raw(hit).filter(function(it){var k=(it.kind==='fire'?'fire':it.extra||it.type)+'/'+it.state;if(!renderable(it)||seen[k])return false;seen[k]=true;return true;})
      .sort(function(a,b){return (ORDER[a.state]===undefined?9:ORDER[a.state])-(ORDER[b.state]===undefined?9:ORDER[b.state]);});
  }
  function name(it){
    var x=String(it.extra||''),m;
    if(it.kind==='fire')return 'Fire';
    if(it.kind==='ammoBay')return 'Ammo rack';
    if(it.kind==='crew'){m=/(\d+)$/.exec(x);return (CREW[it.type]||'A crew member')+(m?' '+m[1]:'');}
    if(it.type==='track'&&(m=/^(left|right)Track(\d+)$/.exec(x)))return (m[1]==='left'?'Left ':'Right ')+(m[2]==='0'?'track':m[2]==='1'?'outer track':'track '+m[2]);
    if(it.type==='wheel'&&(m=/^wheel(\d+)$/.exec(x)))return 'Wheel '+(Number(m[1])+1);
    return it.type==='chassis'?'Tracks or wheels':it.type==='device'?'A module':DEVICES[it.type]||'A module';
  }
  function phrase(it){
    if(it.kind==='fire')return 'Fire started'+(it.extra&&DEVICES[it.extra]?' ('+DEVICES[it.extra].toLowerCase()+')':'');
    return name(it)+' '+(STATES[it.state]||it.state);
  }
  function tieText(it){return it.tie==='unique'&&it.from==='snapshotDiff'?'the only hit between two panel updates':TIE_TEXT[it.tie]||'';}
  function origin(it){return [it.from].concat(it.confirmedBy||[]).map(function(f){return SOURCES[f];}).filter(Boolean).join(' and ');}
  function title(it){
    var from=origin(it),tie=tieText(it);
    return phrase(it)+(from?'\n\u2022 From: '+from:'')+(tie?'\n\u2022 Matched: '+tie:'');
  }
  function icon(it){
    if(it.kind==='fire')return 'fire.png';
    if(it.kind==='ammoBay')return 'ammoBayDestroyedSmall.png';
    if(it.kind==='crew')return it.type+'DestroyedSmall.png';   // the client has only this state for crew
    if(it.type==='chassis')return 'hit_critical_track.png';
    if(it.type==='device'||!DEVICES[it.type])return 'module.png';
    return it.type+(it.state==='destroyed'||it.state==='detonated'||it.state==='burnOff'?'DestroyedSmall.png':'CriticalSmall.png');
  }
  function count(hit){return hit&&hit.crits&&hit.crits.count>0?hit.crits.count:0;}
  // A crit without an identified module: the crit code of the record, or a count from the battle feedback.
  function chassis(hit){return lastCode(hit)===5&&lastPart(hit)===0;}
  function unreported(hit){
    var n=count(hit);
    return n>1?n+' modules or crew members were damaged; which ones were not reported':'a module or crew member was damaged; which one was not reported';
  }
  function generic(hit){var s=unreported(hit);return 'Critical hit'+(chassis(hit)?' on the chassis':'')+'\n'+s.charAt(0).toUpperCase()+s.slice(1)+'.';}
  // The same in one line, after "Critical damage:" in the hit row's tooltip.
  function unnamed(hit){var n=count(hit);return 'Not named'+(n>1?' ('+n+' modules or crew members)':'')+(chassis(hit)?', on the chassis':'');}
  // The tile's icons, at most four: more than four items give three and the generic crit icon listing them all.
  function badges(hit){
    var list=items(hit);
    if(!list.length)return lastCode(hit)||count(hit)?[{src:BASE+(chassis(hit)?'hit_critical_track.png':'hit_critical.png'),title:generic(hit)}]:[];
    var all=list.map(function(it){return {src:BASE+icon(it),title:title(it)};});
    // The fourth icon lists every item (23.09: five full titles in a row were a wall of text): the first three by name
    // only - their own icons carry the source and the tie - the rest with theirs after the name.
    return all.length<=4?all:all.slice(0,3).concat([{src:BASE+'hit_critical.png',title:'Critical damage'+list.map(function(it,i){
      var more=i<3?'':[origin(it)&&'from '+origin(it),tieText(it)&&'matched: '+tieText(it)].filter(Boolean).join('; ');
      return '\n\u2022 '+phrase(it)+(more?': '+more:'');}).join('')}]);
  }
  // The critical damage in one line: the details row (a sentence when nothing is named), or, short, the hit row's tooltip.
  function describe(hit,short){
    var list=items(hit);
    return list.length?list.map(phrase).join(', '):!(lastCode(hit)||count(hit))?'':short?unnamed(hit):'Critical hit'+(chassis(hit)?' on the chassis':'')+': '+unreported(hit);
  }
  // The small line of the details row: what the damage rests on.
  function sources(hit){
    var list=items(hit),seen={},from=[],weakest=null,code=lastCode(hit),out=[];
    list.forEach(function(it){[it.from].concat(it.confirmedBy||[]).forEach(function(f){if(SOURCES[f]&&!seen[f]){seen[f]=true;from.push(SOURCES[f]);}});
      if(!weakest||TIES.indexOf(it.tie)>TIES.indexOf(weakest.tie))weakest=it;});
    if(from.length)out.push('From '+from.join(', ')+(weakest&&tieText(weakest)?'; matched: '+tieText(weakest):''));
    if(code)out.push('Effect code '+code+' in the hit record ('+(code===5?'critical hit':'penetration with module damage')+')');
    if(count(hit))out.push('Battle feedback: '+count(hit)+' damaged');
    return out.join('. ');
  }
  // Statistics log fields (design 4.1), appended before v= on every line of the hit.
  function columns(hit,v){
    v=v||{};var list=raw(hit),c=hit&&hit.crits||{},src=[],weakest='-';
    var chain=((hit&&hit.points)||[]).map(function(p){return p&&typeof p.effect==='number'?p.effect:'?';}).join(',');
    if(lastCode(hit))src.push('code');
    list.forEach(function(it){[it.from].concat(it.confirmedBy||[]).forEach(function(f){var s=LOG_SOURCES[f];if(s&&src.indexOf(s)<0)src.push(s);});
      if(TIES.indexOf(it.tie)>TIES.indexOf(weakest))weakest=it.tie;});
    if(c.maskTied&&src.indexOf('mask')<0)src.push('mask');
    if(c.flags&&src.indexOf('flags')<0)src.push('flags');
    if(count(hit))src.push('count');
    src.sort(function(a,b){return ['code','mask','info','fire','flags','count','diff','state'].indexOf(a)-['code','mask','info','fire','flags','count','diff','state'].indexOf(b);});
    return ' hp='+(hit&&typeof hit.damage==='number'?hit.damage:'-')+' pi='+(v.pi!=null?v.pi:'-')+' prev='+(v.prevEffect!=null?v.prevEffect:'-')+
      ' chain='+(chain||'-')+' ht='+(v.hitType!=null?v.hitType:'-')+' critCode='+(lastCode(hit)||'-')+
      ' crit='+(list.length?list.map(function(it){return (it.kind==='fire'?'fire':it.extra||it.type)+':'+it.state;}).join(','):'-')+
      ' critSrc='+(src.length?src.join('+'):'-')+' critTie='+weakest;
  }
  // A short signature of hit.crits: the verdict queue logs a hit again when its ties change.
  function key(hit){
    var c=hit&&hit.crits;if(!c)return '';
    return [c.code||'',c.mask==null?'':c.mask,c.flags||'',c.count||''].concat(raw(hit).map(function(it){return (it.extra||it.type)+':'+it.state+':'+it.tie;})).join('|');
  }
  root.ArmorCrits={lastCode:lastCode,items:items,badges:badges,describe:describe,sources:sources,columns:columns,key:key};
}(typeof window==='undefined'?globalThis:window));
