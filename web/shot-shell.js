/* THE SHELL OF A SHOT AT ITS RANGE - one owner for Bullba Hits (web/app.js) and the replay viewer's shot view
   (web/playback/shot-view.js). Moved out of web/app.js unchanged (19.11.2026, BACKLOG 109 / NOTEBOOK N5): shellAt,
   manualDamageFrom and MANUAL_DAMAGE_KEYS were app.js's own; the one difference is that the target's liner factor is
   handed in (app.js passes targetFactor(hit), which reads its Target switches; the replay page passes the record's own,
   linerFactor - the factor the verdict pass uses). `recorded` is the chooser app.js's drainVerdicts used: the shell the
   record names for the hit, else the one the page would assume (ArmorShotContext.pick), at the hit's own range.
   tools/verdicts_offline.cjs loads this file beside the functions it cuts out of app.js. */
(function(root){
  'use strict';
  // What a shell chosen BY HAND borrows from the shooter (user, 22.09). A manual shell is a type, a
  // penetration and a calibre the user typed - ArmorBallistics.shell() gives it no alpha at all, and every
  // damage figure on the page then read "—" or 0 %. It is still a shell of the SAME shooter, so the damage
  // side comes from his own shell of that type: his candidate of the kind the user picked, else the shell
  // the record resolved for the hit, else his first shell that has an alpha. What the user typed - kind,
  // penetration, calibre - is never touched. A record whose shells carry no alpha at all (before 0.7.13)
  // has nothing to lend, and the circle then prints the penetration chance instead (circleFigure).
  var MANUAL_DAMAGE_KEYS=['alpha','spallDamage','spallAbsorption','nonPiercingArmorDamage','damageRandomization','mechanics'];
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
  // liner: the target's liner factor (app.js targetFactor(hit); 1 when not passed).
  function shellAt(c,choice,penetration,caliber,distance,hit,pool,alpha,liner){
    var B=root.ArmorBallistics;
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=B.shell(c?c.kind:choice,penetration,caliber);
    shell.liner=liner!==undefined?liner:1;
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
    if(c){['normalization','ricochetCos','jetLossPerMeter','traceRicochet','randomization','randomizationType','shieldPenetration',
      'alpha','spallDamage','spallAbsorption','mechanics','nonPiercingArmorDamage','vehicleMode','damageRandomization'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});
      // The penetration at this distance is the client's law in ballistics.js, never a copy of it here (BACKLOG
      // № 32): the field holds the shell's first value (up to 50 m) and falls off by the record's own factor, so
      // a number typed over the record's falls off exactly as the record's would.
      if(c.penetration100>0)shell.penetration=penetration*B.penetrationAt(c,distance)/c.penetration100;}
    // The alpha falls off with the distance on the Polish smoothbore APCR alone (damageMutable, alphaFar in the
    // record); the factor is exactly 1 on every other shell, which is then what it always was.
    var fall=c&&c.alpha>0?B.alphaAt(c,distance)/c.alpha:1;
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
  // The shell a hit is cast with when nobody picks one (the automatic verdict pass; the replay viewer's shot view).
  // A hit whose shell the record does not name gets the shell THE PAGE WOULD SHOW - the one ArmorShotContext.assume picks
  // (the shells of the hit's own type, the damage band, then the deepest penetration) - not the first of the list, and is
  // marked as a guess (guess: true). The damage window of the assumed shell is taken at the hit's own range: a Polish
  // APCR's alpha falls off with it. {context, choice (the candidate or null), range, shell (or null), guess}.
  // The target's liner factor as the record has it (app.js linerFactor until 19.11.2026; app.js's targetFactor starts from
  // it and its Target switches change it).
  function linerFactor(hit){var t=(hit||{}).target;return t&&t.linerFactor>0?t.linerFactor:1;}
  // liner: not passed - the record's own (linerFactor).
  function recorded(hit,battle,liner){
    if(liner===undefined)liner=linerFactor(hit);
    var S=root.ArmorShotContext,context=S.resolve(hit,(battle&&battle.shotEvents)||[],battle),c=context.choices[context.index]||null;
    var range=context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:100;
    // ArmorShotContext.pick: the same shell prepareShell shows - of the hit's type, else of its calibre, else the first.
    if(!c)c=context.choices[S.pick(context,hit).index]||null;
    var shell=c?shellAt(c,c.kind,c.penetration100,c.caliber,range,hit,undefined,undefined,liner):null;
    return {context:context,choice:c,range:range,shell:shell,guess:context.index<0};
  }
  // THE SHELL CHIP (21.11, BACKLOG 122; moved out of app.js paintShellLists): one button of a gun's shell - Hits' scene heading
  // and the replay viewer's shot bar, one widget. f: {actual (the shell that flew: ●), assumed (◌, with assumedWhy and
  // assumedNotes), second (◐ - the vehicle's second mode), mode (its client name), gunNotes (the gun at the shot)}. The label
  // and the tooltip are app.js's unchanged; style.css/viewer.css .shell-chip.
  var SHELL_NAMES={ARMOR_PIERCING:'AP',ARMOR_PIERCING_CR:'APCR',HOLLOW_CHARGE:'HEAT',HIGH_EXPLOSIVE:'HE'};
  function chipLabel(c,f){return (f.actual?'● ':f.assumed?'◌ ':'')+(f.second?'◐ ':'')+(SHELL_NAMES[c.kind]||c.kind)+' '+Math.round(c.penetration100)+(c.gunInstallation>0?' ✦':'')+(c.emuGun?' ⇆':'');}
  function chipTitle(c,f){
    // Tooltip markup (tooltips.js): the shell is the heading, then whose it is, then its points.
    return c.name+', '+c.caliber+' mm\n'
      +(c.emuGun?'A shell of the gun picked on the characteristics panel - the gun the emulation fires.\n• Gun: '+c.emuGunName
        :f.actual?(f.second?'The shooter fired in his second mode; the client’s numbers for that mode are used.':'Type from the hit.')
        :f.assumed?'Assumed: the record does not name this shot’s shell'+(f.assumedWhy?', so '+f.assumedWhy+' was taken':'')+'.'
          +(f.assumedNotes||[]).map(function(n){return '\n• '+n;}).join('')
        :f.second?'The same gun in the vehicle’s second mode.':'Compare with this shell.')
      +(c.gunInstallation>0?'\n• Ability gun'+(c.gun?': '+c.gun:''):'')
      +(f.mode?'\n• Mode: '+f.mode:'')
      // The live state of the shooter's gun at the shot, one short line per mechanic the record carries
      // (22.09). It belongs to the shot, not to one shell, so every chip of this hit says the same.
      +(!c.emuGun&&(f.gunNotes||[]).length?'\n\nGun at the shot:\n• '+f.gunNotes.join('\n• '):'');
  }
  function chip(c,f,onclick){
    var b=document.createElement('button');b.className='shell-chip';b.textContent=chipLabel(c,f);b.title=chipTitle(c,f);
    if(onclick)b.onclick=onclick;
    return b;
  }
  root.BullbaShotShell={shellAt:shellAt,manualDamageFrom:manualDamageFrom,recorded:recorded,linerFactor:linerFactor,MANUAL_DAMAGE_KEYS:MANUAL_DAMAGE_KEYS,
    SHELL_NAMES:SHELL_NAMES,chip:chip,chipLabel:chipLabel,chipTitle:chipTitle};
})(typeof window!=='undefined'?window:this);
