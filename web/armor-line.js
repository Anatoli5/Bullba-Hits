/* THE READING OF ONE SHOT LINE (20.11.2026; moved out of web/app.js unchanged in its words): a ballistic result
   (ArmorBallistics engine.ray, a viewer's pinResult) as Bullba Hits' panel shows it - the chance or the expected damage
   first, then "pen", "eff <- nominal ∠ angle", a ricochet, screens, the damage parts. One owner for Bullba Hits' panels
   (app.js armorLineOf, shotStats, inspectArmor) and the replay viewer's shot view (its pinned point).
   BullbaArmorLine.line(r, pen, range, c) -> {label, color, groups: [{kind, text, title?}]};
   c: {damage (the Display is Expected damage and the shell carries an alpha), shell (the shell the line was judged with),
   rgb(r) (the chance colour, CSS), parts (the scene's target parts, for an armoured prefab), prefabTitle(part, parts)}. */
(function (root) {
  'use strict';
  // Expected damage is read as a share of the shell's own alpha, never in HP (user, 19.09): "50 %" says at a
  // glance how much of what this shell can do a shot at this point is worth, and the same number compares two
  // guns whose alphas differ. The alpha in HP appears once per panel, muted, beside the chance (user, 20.09).
  // A shell whose non-penetration damage has no model (the Taschenratte ability shell) shows the penetration part
  // alone as a lower bound, never as the expectation: the recorded shots of that shell do deal damage without piercing.
  function damageShare(r,s){
    var share=r.expectedShare;
    if(share===null||share===undefined)share=s&&s.alpha>0?r.expected/s.alpha:0;
    return (r.damageLaw==='special-unknown'?'≥ ':'')+Math.round(Math.max(0,Math.min(1,share))*100)+' %';
  }
  // What the expected damage is made of, for the panel under the number: the penetration chance it came from,
  // and the non-penetration damage of the ratio law with the three figures behind it. Legacy HE (SPG) says
  // instead that its splash is not modelled - there is no client-side rule for it to show.
  function damageGroups(r,s){
    if(!s)return [];
    if(r.damageLaw==='legacy-unknown')return [{kind:'damage',text:'splash not modelled'}];
    if(r.damageLaw==='special-unknown')return [{kind:'damage',text:'non-pen unknown',title:'Non-penetration damage unknown\nThis shell has its own spall rule and does deal damage without piercing, but no law fits the recorded shots: the figure is a lower bound (penetration only).'}];
    if(r.damageLaw!=='ratio'||!(r.nonPen>0)||r.chance===null||r.chance===undefined)return [];
    var liner=s.liner>0?s.liner:1,pass=r.screenPass===undefined||r.screenPass===null?1:r.screenPass;
    var groups=[{kind:'damage',text:'pen '+Math.round(r.chance)+' %'},
      // The non-penetration part is a share of alpha too, so the two numbers of the expectation read on one
      // scale: "pen 40 % · non-pen 5 %" adds up to the 43 % above it without a unit change in the middle.
      {kind:'damage',text:'non-pen '+Math.round(s.alpha>0?100*r.nonPen/s.alpha:0)+' %',
       // Two decimals: the liner is no longer one device factor but the product of the Target switches (1.725).
       title:'Non-penetration damage, share of alpha\n• Damage: '+Math.round(r.nonPen)+' HP of '+Math.round(s.alpha||0)+' HP\n• Spall: '+Math.round(s.spallDamage||0)+' HP\n• Plate: '+Math.round(r.nominal)+' mm\n• Liner: ×'+liner.toFixed(2)}];
    // A screen on the way: the chance the shell gets through it at all; below it the shell explodes on the screen
    // and deals nothing, so the non-penetration damage only counts in the gap between passing and piercing.
    if(pass<.995)groups.push({kind:'damage',text:'through screen '+Math.round(pass*100)+' %',title:'Chance to pass the screens\nStopped there, the shell deals no damage at all.'});
    return groups;
  }
  // Compact reading of one ballistic result: the chance first, then the numbers that explain it.
  // One ballistic result as readable groups: chance, then "pen" and "effective ← nominal ∠ angle" side by side (12.11, BACKLOG
  // 91: the angle sign, not a dash, binds the plate to its angle; the penetration next to the armour it is read against),
  // then screens.
  function line(r,pen,range,c){
    c=c||{};var rgb=c.rgb||function(){return '';};
    if(!r)return {label:'—',color:'',groups:[]};
    var prefix=[],hp=!!c.damage&&r.expected!==null&&r.expected!==undefined;
    // After a ricochet (ballistics.js engine.bounced): the chip names what the shell had left at the ricochet and what the
    // bounced leg starts with; `pen` below becomes the leg's own scale, (1 - loss) of the shell's, which `eff` is read against.
    // A negative remainder (screens thicker than the shell) is a figure too: "pen −1 → 0 mm"; only a missing one hides it.
    if(r.bounce){var b=r.bounce,known=typeof b.remaining==='number'&&typeof b.carried==='number',carried=b.loss&&known;pen=b.penetration;
      var spent=b.shell>0&&known?b.shell-b.remaining:0,firstScreens=(b.layers||[]).filter(function(l){return !l.main;});
      prefix.push({kind:'ricochet',text:'ricochet '+Math.round(b.nominal)+' mm ∠ '+Math.round(b.angle)+'°'+(carried?' · pen '+Math.round(b.remaining)+' → '+Math.round(b.carried)+' mm':''),
        title:'Ricochet\nThe shell flies on along the mirrored line'+(b.loss?' with '+Math.round((1-b.loss)*100)+' % of the penetration it had left.':', penetration unchanged (HEAT).')+
          '\n• Plate: '+Math.round(b.nominal)+' mm at '+Math.round(b.angle)+'°'+
          (carried?'\n\n• Shell: '+Math.round(b.shell)+' mm'+(firstScreens.length?'\n• Screens before it: '+firstScreens.map(function(l){return Math.round(l.nominal)+' mm';}).join(' + ')+' (−'+Math.round(spent)+' mm)':'')+
            '\n• Left at the ricochet: '+Math.round(b.remaining)+' mm\n• After it: '+Math.round(b.carried)+' mm (×'+(1-b.loss).toFixed(2)+')'+
            '\n\n• The chance is scaled by '+Math.round(b.penetration)+' mm ('+Math.round((1-b.loss)*100)+' % of the shell)':'')});}
    var layers=r.layers||[],screens=layers.filter(function(l){return !l.main;}),extra=screens.length?[{kind:'screen',text:'+ '+screens.map(function(s){return Math.round(s.nominal)+' mm';}).join(' + ')+' screen'}]:[];
    // The penetration stands on the armour's line, next to the effective armour it is read against (12.11, BACKLOG 91: the
    // block one line shorter); the range it is taken at is no longer written on the line - its tooltip says it.
    var shell=pen?[{kind:'pen',text:'pen '+Math.round(pen)+' mm',title:'Penetration\nThe shell’s nominal penetration at the range the line is judged at.'+(range?'\n• Range: '+Math.round(range)+' m':'')}]:[];
    var zero=rgb({chance:0,expectedShare:0}),bounced=rgb({chance:0,expectedShare:0,reason:'ricochet'});
    if(r.reason==='ricochet')return {label:'Ricochet',color:bounced,groups:prefix.concat(shell,[{kind:'armor',text:(r.final?(r.bounce?'again, shell lost: ':'shell lost: '):'')+Math.round(r.nominal)+' mm ∠ '+Math.round(r.angle)+'°'}],extra)};
    if(r.reason==='screen')return {label:hp?'0 %':'0%',color:zero,groups:prefix.concat(shell,[{kind:'armor',text:'explodes on the screen (this HE cannot pass screens)'}],extra)};
    if(r.reason==='no-hull')return r.bounce?{label:hp?'0 %':'0%',color:bounced,groups:prefix.concat(shell)}:{label:'—',color:'',groups:[{kind:'armor',text:'no main armour on this line'}]};
    if(r.reason==='parameters')return {label:'—',color:'',groups:[{kind:'armor',text:'set penetration and calibre'}]};
    if(r.reason==='armor')return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no armour data for this surface'}])};
    if(r.chance===null)return {label:'—',color:'',groups:prefix.concat([{kind:'armor',text:'no estimate for this penetration distribution'}])};
    // The plate on an armoured prefab (27.09): the chip says whose it is and where the part stands, on a click.
    var main=layers[layers.length-1],parts=c.parts||null,
      prefab=main&&parts?parts.find(function(p){return p&&p.id===main.part;})||null:null,armor={kind:'armor',text:'eff '+Math.round(r.effective)+' mm ← '+Math.round(r.nominal)+' mm ∠ '+Math.round(r.angle)+'°'};
    if(prefab&&prefab.prefab&&c.prefabTitle)armor.title=c.prefabTitle(prefab,parts);
    return {label:hp?damageShare(r,c.shell):r.chance+'%',color:rgb(r),groups:prefix.concat(shell,[armor],hp?damageGroups(r,c.shell):[],extra)};
  }
  root.BullbaArmorLine={line:line,damageShare:damageShare,damageGroups:damageGroups};
})(window);
