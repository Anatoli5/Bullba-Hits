/* Interpret recorded evidence without changing the original battle files. */
(function(root){
  'use strict';
  // Client 2.4 SHELL_TYPES_LIST; new records also carry shellKind explicitly.
  var kinds=['HOLLOW_CHARGE','HIGH_EXPLOSIVE','ARMOR_PIERCING','ARMOR_PIERCING_HE','ARMOR_PIERCING_CR','SMOKE'];
  function point(m,p){return [0,1,2].map(function(i){return m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12];});}
  function distance(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);}
  function same(a,b){return a.kind===b.kind&&a.name===b.name&&a.caliber===b.caliber&&a.penetration100===b.penetration100&&a.speed===b.speed&&a.vehicleMode===b.vehicleMode;}
  /* --- The shooter's two modes (outputs/mode-shell-modifiers-2026-09-22.md, P2-P4) -----------------
     Six vehicles of client 2.4.0.1 are built twice and really fire another shell in their second mode:
     five German tanks with the mechanic `shellParamsSwitcher` (AP/APCR normalisation 5/2 -> 10/7 deg,
     ricochet 70 -> 75 deg, HEAT jet loss 0.5 -> 0.2 per metre, alpha 40-45 lower) and the Gorilla with
     `lowChargeShot` (alpha 800 -> 390, penetration 305 -> 255, speed 900 -> 700, and another effects id).
     Since 22.09 the recorder writes the other mode's list beside the one the client handed it:
     attacker.modeShells with attacker.modeShellsMode, and attacker.vehicleMode for availableShells.
     VEHICLE_MODE: 0 default, 1 siege. A record without those fields behaves exactly as it did. */
  var MODE_DEFAULT=0,MODE_SIEGE=1;
  // VEHICLE_SIEGE_STATE (constants.pyc 4166-4182, read in this client): DEFAULT_MODE = {0 DISABLED,
  // 1 SWITCHING_ON}, SIEGE_MODE = {2 ENABLED, 3 SWITCHING_OFF, 4 PILLBOX_ENABLED}. The mode flips at the
  // END of switching on and the START of switching off, and the gun is blocked while switching, so no
  // shot can straddle the change.
  function modeOfSiegeState(state){return state<=1?MODE_DEFAULT:MODE_SIEGE;}
  /* --- The live state of the shooter's gun (outputs/own-gun-state-2026-09-22.md, owner 22.09) --------
     From 0.7.25 the recorder writes the state of the gun mechanics the shooter's vehicle
     really carries: `gunState` on the tracer - the instant the shell leaves the barrel - and
     `attacker.gunStateAtImpact` up to a second later, exactly the pair and the precedence the siege state
     already uses. Private fields are written for the player's own shot only ("you know whether you pressed
     the ability or not"); for every other vehicle it is the half the server replicates to everybody. A
     record without the fields is read exactly as it was. */
  // Object 432U is the one vehicle of client 2.4.0.1 with chargeShot. damageFactorsPerLevel = 1 1.045
  // 1.177 1.244 comes from its own <mechanics> section, and the client multiplies the shell's base damage
  // by damageFactorsPerLevel[level] - `level` is the 0-based index into that list, and maxLevel is
  // len(timePerLevel) - 1 = 3 (ChargeShotMechanicWidget and ChargeShotParams of client 2.4.0.1).
  var CHARGE_SHOT_FACTORS=[1,1.045,1.177,1.244];
  // LowChargeShotReloadingState (constants.pyc 5905, read in this client): 0 NONE, 1 INITIAL_RELOAD,
  // 2 LOW_CHARGE, 3 ALMOST_FINISHED, 4 FULL_CHARGE, 5 QUICK_RELOAD, 6 EMPTY. The public half carries the
  // same numbers in `visualState` (LOW_CHARGE_SHOT_CONSTS). Only the two that name a charge are used.
  var LOW_CHARGE=2,FULL_CHARGE=4;
  function chargeStateOf(state){var s=state&&state.chargeShot;return s?(s.privateState||s.publicState||null):null;}
  function lowChargeOf(state){
    var s=state&&state.lowChargeShot;if(!s)return null;
    var v=s.privateState?Number(s.privateState.reloadingState):s.publicState?Number(s.publicState.visualState):NaN;
    return v===LOW_CHARGE?LOW_CHARGE:v===FULL_CHARGE?FULL_CHARGE:null;
  }
  // Which of the two descriptors a recorded gun state names, or null when it names neither. The Gorilla's
  // low charge is its second descriptor and LowChargeShotReloadingState is the client's own named constant,
  // so that reading is as good as the siege state. The five German switchers' publicStatus.isActive is a
  // plain flag whose DIRECTION is still to confirm in a real battle, so it is kept apart and read only
  // after the siege state of the shot and of the impact have both had their say.
  function modeOfGunState(state){
    var low=state&&typeof state==='object'?lowChargeOf(state):null;
    return low===null?null:low===LOW_CHARGE?MODE_SIEGE:MODE_DEFAULT;
  }
  function modeOfSwitcher(state){
    var sw=state&&typeof state==='object'&&state.shellParamsSwitcher&&state.shellParamsSwitcher.publicStatus;
    return sw&&typeof sw.isActive==='boolean'?(sw.isActive?MODE_SIEGE:MODE_DEFAULT):null;
  }
  // One short line per mechanic the record carries. Nothing here invents a meaning for a packed status:
  // the charge level and the low/full charge are the client's own named values, everything else is shown
  // as the number the client gave, and the page changes no figure for it.
  function gunNotes(state,from){
    if(!state||typeof state!=='object')return [];
    var out=[],tail=from==='impact'?' (state at the impact)':'';
    var charge=chargeStateOf(state);
    if(charge&&Number.isFinite(Number(charge.level))){
      var lvl=Number(charge.level),f=CHARGE_SHOT_FACTORS[lvl];
      out.push(f>0?'Charge level '+(lvl+1)+' of '+CHARGE_SHOT_FACTORS.length+': ×'+f+' alpha'
        :'Charge level '+(lvl+1));
    }
    var low=lowChargeOf(state);
    if(low!==null)out.push(low===LOW_CHARGE?'Low charge shot':'Full charge shot');
    var sw=state.shellParamsSwitcher&&state.shellParamsSwitcher.publicStatus;
    if(sw&&typeof sw.isActive==='boolean')out.push(sw.isActive?'Shell parameters switched on':'Shell parameters switched off');
    var heat=state.overheatStacks;
    if(heat&&Number.isFinite(Number(heat.curLevel)))out.push('Overheat level '+Number(heat.curLevel)+' (no change to penetration or alpha)');
    var prop=state.propellantAfterburnerGun&&state.propellantAfterburnerGun.status;
    if(prop&&Number.isFinite(Number(prop.chargeStageID)))out.push('Propellant charge stage '+Number(prop.chargeStageID));
    var burst=state.chargeableBurst;
    if(burst&&typeof burst.isBurstActive==='boolean')out.push(burst.isBurstActive?'Burst active':'Burst not active');
    var bustle=state.bustleFeed&&state.bustleFeed.status;
    if(bustle&&Number.isFinite(Number(bustle.state)))out.push('Bustle feed state '+Number(bustle.state));
    var calib=state.shellCalibration;
    if(calib&&Number.isFinite(Number(calib.status)))out.push('Shell calibration state '+Number(calib.status));
    var second=state.secondaryGun;
    if(second&&Number.isFinite(Number(second.gunInstallationIndex)))out.push('Secondary gun installation '+Number(second.gunInstallationIndex));
    return tail?out.map(function(line){return line+tail;}):out;
  }
  // A copy of a candidate with the charge's factor on its alpha. The recorded arrays are never touched:
  // they belong to the battle file and the page reads them again for the next hit.
  function withCharge(c,factor){
    var out={},k;for(k in c)if(Object.prototype.hasOwnProperty.call(c,k))out[k]=c[k];
    if(Number(out.alpha)>0){out.alpha=Math.round(Number(out.alpha)*factor);out.chargeFactor=factor;}
    // The far value goes with it, or a shell whose two values were equal would seem to lose damage with range.
    if(Number(out.alphaFar)>0&&out.chargeFactor)out.alphaFar=Math.round(Number(out.alphaFar)*factor);
    return out;
  }
  // A candidate's alpha at the shot's range: the client's law, which lives in ballistics.js (the page loads it
  // first; BACKLOG № 32). Only the Polish smoothbore APCR lose damage with range; a shell without alphaFar, a hit
  // without a range and a caller that has not loaded ballistics.js all get the shell's own alpha.
  function alphaAt(c,range){var B=root.ArmorBallistics;return B&&B.alphaAt?B.alphaAt(c,range):Number(c.alpha)||0;}
  /* THE BORKENKÄFER'S MARK ON THE TARGET (BACKLOG 38, 23.09). The leKpz Borkenkäfer's targetDesignator arms its next
     shot; a hit on a spotted target marks it for spottedMarkedTime 10 s (12.5 with the full skill tree), and a marked
     vehicle takes damageIncomeFactor ×1.1 of the damage of every shell - from ANY shooter - ×1.15 with the marker's
     full tree (client 2.4.0.1 G188_LeKpz_Borkenkafer.xml and common/vehicle_mechanics.xml, docs/KNOWLEDGE.md section 4).
     The factor is applied by the server (IncomingDamageModifier is empty in the client); whose tree the marker had,
     the record cannot tell, so the window is ×1.1…×1.15. Since the build after 0.7.29 the recorder reads the mark the
     target carries at the impact (target.designatorMark {creatorID, startTime, endTime}, server time); it is active
     when it ends after the hit's own gameTime. Whether the marking shot itself gets the bonus is not known - so the
     damage window only WIDENS: its top rises ×1.15, its bottom stays. Returns null for every hit without an active mark,
     which is every record written before that build. */
  var MARK_FACTOR=1.1,MARK_FACTOR_TREE=1.15;
  function markOf(hit){
    var m=hit&&hit.target&&hit.target.designatorMark,at=hit&&hit.gameTime!==null&&hit.gameTime!==undefined?Number(hit.gameTime):NaN;
    if(!m||!Number.isFinite(at))return null;
    var end=Number(m.endTime);
    if(!(Number.isFinite(end)&&end>at))return null;
    return {creatorID:m.creatorID,startTime:Number(m.startTime),endTime:end,left:end-at,low:MARK_FACTOR,high:MARK_FACTOR_TREE};
  }
  // The top of a damage window on a marked target: ×MARK_FACTOR_TREE, else ×1.
  function markTop(mark){return mark&&mark.high>1?mark.high:1;}
  // The server scales every shot's (velocity, gravity) by some k, so |v| alone does not name a shell -
  // but v/sqrt(g) cancels k and equals the descriptor's speed/sqrt(gravity) exactly. Measured over the
  // owner's 5352 tracers, 22.09: 94.5 % match one of the shooter's own shells inside 0.1 %. The tolerance
  // is 2.5 %, not the 0.5 % first tried: the Tesak's tracers sit a flat 2 % off its descriptor (114 hits of
  // 60 battles, cause unknown), and every real mismatch measured is far outside - the Gorilla's charge
  // 14 %, event shells more. At 0.5 % the pass called 255 hits assumed, at 2.5 % 139, and the difference
  // was the Tesak plus two B-C 155 58 hits (offline pass, 22.09).
  var BALLISTIC_TOLERANCE=.025;
  function ratioOf(c){return c&&c.speed>0&&c.gravity>0?c.speed/Math.sqrt(c.gravity):null;}
  /* The shell velocity nodes of the tier-XI skill trees (B6, 23.09): client 2.4.0.1
     common/post_progression/veh_skill_configs/<Vehicle>_modifications.xml, `descrAttrs/shot<N>/speed`, N the index of
     the shot in the gun's own list (components/guns.xml of the nation). A node adds its value to the shell's XML speed
     and shotSpeedProcessor scales it by projectileSpeedFactor 0.8, as _readShot scales the speed itself (the Gorilla's
     low-charge APCR records 760 = 900·0.8 + 50·0.8), so the descriptor's speed rises by 0.8 × the node while gravity
     stays - and v/sqrt(g) by (v + 0.8·node) / v. The tree is the player's own progress: nothing in a record says
     whether he had the node, so a tracer that matches either the stock shell or the shell with the node names it.
     Measured on the owner's records, to four places: Breaker APDS Mk. 2B ×1.0400 = (1000 + 40) / 1000, KR-1 BR-79
     ×1.1000 = (800 + 80) / 800, Taschenratte Hl. Gr. ×1.1429 = (560 + 80) / 560 - 17 hits that were 'assumed' until this
     check (docs/KNOWLEDGE.md section 3). Per vehicle: [the shot's XML speed, the node], the XML speed ×0.8
     being the `speed` the record carries. The same trees add alpha (+10) and penetration (+5) to most shells as well;
     those only go into the words, because the record cannot tell either. */
  var XI_TREE_SPEED={
    'china:Ch70_PTZ_78':[[960,40],[760,40]],
    'czech:Cz46_Vz_63P':[[980,50],[1150,50],[870,50]],
    'france:F143_Fauteur':[[970,50],[1250,50]],
    'germany:G185_Leopard_120_Verbessert':[[1400,100]],
    'germany:G187_Taschenratte':[[1050,100],[700,100]],
    'germany:G197_Pz_Kpfw_Neu':[[1150,50],[990,50]],
    'italy:It43_CAV_mod_71':[[1470,50]],
    'japan:J52_STK_2':[[1050,50],[1380,50]],
    'japan:J53_Ho_Ri_Shugo':[[1100,50]],
    'sweden:S41_BV_111':[[1050,100],[850,50]],
    'uk:GB147_FV4025_Contriver':[[1050,100],[1250,100]],
    'uk:GB152_AT_FV230_Breaker':[[1000,50],[1250,50]],
    'uk:GB158_Executor':[[1250,50],[1500,50],[1150,50]],
    'usa:A191_Ares_90_C':[[1000,50],[1300,50]],
    'usa:A195_Gorilla':[[900,50],[1100,50]],
    'ussr:R228_KR_1':[[1000,100]],
    'ussr:R230_Object_432U':[[1050,50]]};
  var PROJECTILE_SPEED_FACTOR=.8;
  // The rise in m/s of the recorded speed a node of this shooter's tree gives this shell, or 0.
  function treeSpeed(type,c){
    var list=XI_TREE_SPEED[String(type||'')];
    if(!list||!(c&&c.speed>0))return 0;
    for(var i=0;i<list.length;i++)if(Math.abs(c.speed-list[i][0]*PROJECTILE_SPEED_FACTOR)<.5)return list[i][1]*PROJECTILE_SPEED_FACTOR;
    return 0;
  }
  function copyShell(c,mode){var out={},k;for(k in c)if(Object.prototype.hasOwnProperty.call(c,k))out[k]=c[k];out.vehicleMode=mode;return out;}
  function tagged(list,mode){return (list||[]).map(function(c){return copyShell(c,mode);});}
  // The same shell in both modes: 76 of this client's 79 second descriptors change no shell at all, and
  // the five switchers leave their HE alone, so the second list is mostly a copy of the first. Everything
  // the recorder writes is compared except the mode tag and the provenance string.
  function identical(a,b){
    if(!a||!b)return false;
    var keys={},k;
    for(k in a)if(Object.prototype.hasOwnProperty.call(a,k))keys[k]=1;
    for(k in b)if(Object.prototype.hasOwnProperty.call(b,k))keys[k]=1;
    for(k in keys){
      if(k==='vehicleMode'||k==='source')continue;
      if(a[k]!==b[k])return false;
    }
    return true;
  }
  /* The client's own name for the state a mode shell was fired in (common/vehicle_mechanics.xml):
     AP and APCR basic = straight_armor, modified = angled_armor; HEAT basic = noscreen,
     modified = screen. The Gorilla's second mode is its low charge, not a shell switch. Returns '' for
     the vehicle's own default mode and for every vehicle that has only one. */
  function modeLabel(hit,shell){
    if(!shell||!(shell.vehicleMode===MODE_DEFAULT||shell.vehicleMode===MODE_SIEGE))return '';
    var aim=((hit||{}).attacker||{}).aim||{},mechanics=Array.isArray(aim.gunMechanics)?aim.gunMechanics:[];
    if(mechanics.indexOf('lowChargeShot')>=0)return shell.vehicleMode===MODE_SIEGE?'low charge':'';
    if(mechanics.indexOf('shellParamsSwitcher')<0&&mechanics.length)return shell.vehicleMode===MODE_SIEGE?'siege':'';
    var kind=String(shell.kind||'');
    if(kind==='HOLLOW_CHARGE')return shell.vehicleMode===MODE_SIEGE?'screen':'no screen';
    if(kind==='ARMOR_PIERCING'||kind==='ARMOR_PIERCING_CR')return shell.vehicleMode===MODE_SIEGE?'angled armour':'straight armour';
    return shell.vehicleMode===MODE_SIEGE?'siege':'';
  }
  /* --- The circle the server fired the player's own shot from (BACKLOG 28 step 2, user 24.09) ----------------
     outputs/own-shot-centre-2026-09-24.md: the shell leaves by the server's aim of the tick BEFORE the shot - the
     last server gun update the client held when the tracer came (aimAtTracer.lastServerGunUpdate), taken as is,
     with its own dispersion angle. The update is a tick STALE when the shell's origin is not its origin (more than
     STALE_GAP apart: the vehicle moved on a tick); then 38 % of the shells fall outside it (0.3 % otherwise).
     From the build after 0.8.0 the recorder also keeps the first two updates AFTER each own tracer (event
     gunAfterShot): the one whose origin IS the shell's origin is the state the shell left from, exact. No
     estimate is made for a stale update of an older record: a one-tick turn by the recorded motion made the 26
     stale shots no better (3 of 8 outside either way) and one fresh shot in five worse (the same report,
     section 14). Returns null without the field (recorder 0.7.6-0.7.12, other shooters' shots).
     A TWO-GUN SALVO (review 24.09): both barrels' tracers carry the same gameTime, and the server's origin is the
     middle between the barrels (0.19-0.20 m from each), so the shell's own origin is the wrong reference - 4 of the 26
     "stale" shots of 91 battles were salvos of a vehicle standing still. The reference is the MEAN origin of the own
     tracers of that instant (for one tracer, its own): every salvo then matches (0.003-0.004 m), nothing else changes.
     The recorder writes one gunAfterShot per salvo, naming its first tracer; it is found through the same group. */
  var STALE_GAP=.05,SAME_INSTANT=1e-3,NEAR_END=.75,FAR_END=5,END_WINDOW=.1,BURST_WINDOW=.3;
  function serverShot(tracer,events){
    var last=tracer&&tracer.own&&!tracer.isRicochet&&tracer.aimAtTracer&&tracer.aimAtTracer.lastServerGunUpdate;
    function valid(u){return !!(u&&Array.isArray(u.vector)&&Array.isArray(u.origin)&&u.dispersionAngle>0);}
    if(!valid(last)||!Array.isArray(tracer.origin)||!Array.isArray(tracer.velocity))return null;
    var salvo=Number.isFinite(tracer.gameTime)?(events||[]).filter(function(e){return e.event==='tracer'&&e.own&&!e.isRicochet&&
      e.gunInstallationIndex===tracer.gunInstallationIndex&&Array.isArray(e.origin)&&Number.isFinite(e.gameTime)&&Math.abs(e.gameTime-tracer.gameTime)<SAME_INSTANT;}):[];
    if(salvo.indexOf(tracer)<0)salvo=[tracer].concat(salvo);
    var origin=[0,1,2].map(function(i){return salvo.reduce(function(s,e){return s+e.origin[i];},0)/salvo.length;}),
      many=salvo.length>1?salvo.length:0,gap=distance(last.origin,origin);
    if(gap<=STALE_GAP)return {update:last,from:'last',stale:false,gap:gap,salvo:many};
    var ids=salvo.map(function(e){return e.id;}),
      after=(events||[]).find(function(e){return e.event==='gunAfterShot'&&ids.indexOf(e.tracerId)>=0;}),
      exact=after&&(after.updates||[]).find(function(u){return valid(u)&&distance(u.origin,origin)<=STALE_GAP;});
    if(exact)return {update:exact,from:'after',stale:false,gap:gap,salvo:many};
    return {update:last,from:'last',stale:true,gap:gap,salvo:many,afterRecorded:!!after};
  }
  function resolve(hit,events){
    var target=hit.target||{},parts=target.parts||[],points=hit.points||[],world=[];
    if(target.worldTransform)points.forEach(function(p){var part=parts.find(function(v){return v.id===p.part;});if(p.status==='resolved'&&p.position&&part&&part.transform)world.push(point(target.worldTransform,point(part.transform,p.position)));});
    var possible=events.filter(function(e){return e.event==='tracer'&&!e.isRicochet&&e.gunInstallationIndex===0&&e.shooterId===hit.attackerId&&e.effectsIndex===hit.effectsIndex&&e.receivedAt<=hit.receivedAt&&hit.receivedAt-e.receivedAt<10;});
    // Damage callback lacks shotId. Accept only one endpoint close in BOTH space
    // and time; do not associate an arbitrary newest tracer during a burst.
    // The end of a tracer that can be this hit's: received within `window` s of it (0.1 s), within `gate` metres of a
    // contact point; of several, the one nearest to a point; `stopOnly`: stopTracer ends only (not explosions).
    // A tracer whose end lies 0.75-5 m off is taken only when it is the only one (shot-line-true, 24.09): the recorded
    // point is the server's contact laid on the pose the game DREW, and on the move that pose stands up to 3 m from the
    // server's (outputs/wg-mechanics-check-2026-09-24.md §4). In a burst the damage message often comes a tick after its
    // own shell stopped, so the true tracer falls out of the 0.1 s window and a neighbour of the burst is the only one
    // left (review 24.09: 89 of 794 such picks doubtful, 12 tracers given to two hits): the far rule therefore needs a
    // stopTracer end and NO other end of this shooter's shells (same effects, no ricochet) within 0.3 s and 5 m.
    // Past 5 m the report found only mismatches.
    function endOf(t,gate,window,stopOnly){var best=null,bd=Infinity;events.forEach(function(e){if(e.tracerId!==t.id||!e.position||Math.abs(e.receivedAt-hit.receivedAt)>window||stopOnly&&e.event!=='stop')return;
      var d=Math.min.apply(null,world.map(function(p){return distance(e.position,p);}));if(d<=gate&&d<bd){bd=d;best=e;}});return best;}
    var matches=possible.filter(function(t){return !!endOf(t,NEAR_END,END_WINDOW);});
    if(!matches.length){var far=possible.filter(function(t){return !!endOf(t,FAR_END,END_WINDOW,true);});
      if(far.length===1&&!events.some(function(t){return t.event==='tracer'&&t!==far[0]&&!t.isRicochet&&t.shooterId===hit.attackerId&&t.effectsIndex===hit.effectsIndex&&t.receivedAt<=hit.receivedAt+BURST_WINDOW&&hit.receivedAt-t.receivedAt<10&&!!endOf(t,FAR_END,BURST_WINDOW);}))matches=far;}
    // A salvo fires several own tracers from one command; the second shell has no command of its own.
    function commandOf(t){if(!t||!t.own)return null;var own=events.find(function(e){return e.event==='command'&&e.id===t.possibleCommandId;});if(own)return own;
      var before=events.filter(function(e){return e.event==='command'&&e.shooterId===t.shooterId&&e.receivedAt<=t.receivedAt&&t.receivedAt-e.receivedAt<=1.5;});return before.length?before[before.length-1]:null;}
    var sameCommand=matches.length>1&&matches.every(function(t){return t.own;})&&matches.every(function(t){var c=commandOf(t);return c&&c===commandOf(matches[0]);});
    var tracer=matches.length===1?matches[0]:sameCommand?matches.slice().sort(function(a,b){return b.receivedAt-a.receivedAt;})[0]:null,command=commandOf(tracer);
    // Where the server stopped that shell (stopTracer): the world contact S, on the tracer's parabola to 6 mm (explosions
    // are not measured on it). `stopPoint`: the contact point it stopped at - on a screen-then-armour hit often the last,
    // not the first (review 24.09: 48 hits) - the one nearest to S; the offset I - S is measured there.
    var stop=tracer?endOf(tracer,FAR_END,END_WINDOW,true):null,stopPoint=0;
    if(stop)world.forEach(function(p,i){if(distance(stop.position,p)<distance(stop.position,world[stopPoint]))stopPoint=i;});
    // Each aim snapshot is judged against the receipt time of its own source:
    // a stale or incomplete command snapshot must not hide a usable aimAtTracer.
    function usable(aim,stamp,window){var m=aim&&aim.clientMarker;return !!(m&&m.diameter>0&&m.position&&m.direction&&Number.isFinite(m.receivedAt)&&Number.isFinite(stamp)&&Math.abs(stamp-m.receivedAt)<=window);}
    var sources=[];if(command&&command.aim)sources.push({aim:command.aim,from:'command',stamp:command.receivedAt,window:.5});if(tracer&&tracer.own&&tracer.aimAtTracer)sources.push({aim:tracer.aimAtTracer,from:'tracer',stamp:tracer.receivedAt,window:.5});
    // The salvo's second shell leaves up to ~1.5 s after the command; its snapshot is the aim at the first shell.
    if(command&&command.aim&&tracer)sources.push({aim:command.aim,from:'salvo',stamp:tracer.receivedAt,window:1.5});
    var chosen=sources.find(function(s){return usable(s.aim,s.stamp,s.window);})||null,aim=chosen?chosen.aim:null;
    var aimReason=aim?null:!possible.length?'no-tracer':!matches.length?'no-endpoint':!tracer?'ambiguous':!tracer.own?'foreign':!sources.length?'no-snapshot':'stale';
    var kindValues=Array.from(new Set(points.map(function(p){return p.shellKind||kinds[p.shellType];}).filter(Boolean)));
    // The shot's own calibre, when its points agree (a spall or blast point carries 0): pick() below falls back on it.
    var calibers=Array.from(new Set(points.map(function(p){return Number(p.caliber);}).filter(function(c){return c>0;})));
    // shellCandidates is what the record narrowed down; when it is empty (39 of 181 unresolved hits in the
    // 60 recorded battles, 22.09) the shells the shooter could load are the only list there is, and a single
    // one of them that agrees with the hit is an answer, not a blank.
    var recorded=((hit.shellCandidates&&hit.shellCandidates.length?hit.shellCandidates:hit.availableShells)||[]).slice();
    var choices=(hit.availableShells||hit.shellCandidates||[]).slice();
    // P2: the shooter's other mode, when the record carries it. Each candidate is copied and tagged with
    // the mode it belongs to, so the two sets can never be confused - for the five switchers they share
    // name, calibre, penetration and speed, and only alpha, normalisation, ricochet and the HEAT jet loss
    // differ. A mode shell the mode did not change (the switchers' HE) is dropped: it is the same shell.
    var attacker=hit.attacker||{},extra=Array.isArray(attacker.modeShells)?attacker.modeShells:[];
    var ownMode=attacker.vehicleMode===MODE_DEFAULT||attacker.vehicleMode===MODE_SIEGE?attacker.vehicleMode:null;
    var otherMode=attacker.modeShellsMode===MODE_DEFAULT||attacker.modeShellsMode===MODE_SIEGE?attacker.modeShellsMode:null;
    var modeSet=[],hasModes=false;
    if(extra.length&&otherMode!==null&&ownMode!==null&&otherMode!==ownMode){
      modeSet=tagged(extra.filter(function(c){return !(hit.availableShells||[]).some(function(d){return identical(c,d);});}),otherMode);
      if(modeSet.length){hasModes=true;recorded=tagged(recorded,ownMode).concat(modeSet);choices=tagged(choices,ownMode).concat(modeSet);}
    }
    var matching=recorded.filter(function(c){return (kindValues.length===0||kindValues.length===1&&c.kind===kindValues[0])&&points.every(function(p){return !(p.caliber>0)||Math.abs(c.caliber-p.caliber)<.1;});});
    // The Gorilla's low charge changes the shell's own effects id (hugeAPCR 50 -> largeAPCR 42), so the
    // hit names its mode outright. Only for a record that carries the second set: for every other record
    // shellCandidates was already narrowed by this very field and the step is a no-op.
    if(hasModes&&matching.length>1&&Number.isFinite(hit.effectsIndex)){
      var byEffect=matching.filter(function(c){return c.effectsIndex===hit.effectsIndex;});
      if(byEffect.length)matching=byEffect;
    }
    if(matching.length>1&&tracer&&tracer.velocity){var speed=Math.hypot.apply(null,tracer.velocity),narrow=matching.filter(function(c){return c.speed>0&&Math.abs(c.speed-speed)<Math.max(.1,c.speed*.001);});if(narrow.length===1)matching=narrow;}
    // The k-free ballistic invariant (see BALLISTIC_TOLERANCE above): it names the Gorilla's charge -
    // 351.20 against 303.30, a 14 % gap - where the raw speed test cannot.
    var flight=tracer&&Array.isArray(tracer.velocity)&&tracer.gravity>0?Math.hypot.apply(null,tracer.velocity)/Math.sqrt(tracer.gravity):null;
    function ballistics(c){var r=ratioOf(c);return flight===null||r===null?null:Math.abs(r-flight)<=flight*BALLISTIC_TOLERANCE;}
    // Narrowing by it is kept to a record that carries the second mode: on every older record the page
    // must answer exactly as it did, P1 below apart. (It would name the shell of 9 more contact points of
    // the 4794 in the owner's 60 battles - the owner's call, not this build's.)
    if(hasModes&&matching.length>1&&flight!==null){var fit=matching.filter(function(c){return ballistics(c)===true;});if(fit.length===1)matching=fit;}
    // P3: the five switchers fire the same speed, gravity, penetration and effects id in both modes, so
    // nothing above can tell their two sets apart. Strongest evidence first: the gun state and the siege
    // state recorded at the tracer (the moment of the shot), then the two the impact carries, then the
    // switcher's own flag, and last the recorded damage when only one of the two alpha bands could have
    // produced it - an upper bound only, because a shell can always do less than its band (the last hit
    // on a vehicle is capped by what is left of it).
    // The gun state of this shot, read once: the tracer's own (the instant the shell left the barrel)
    // before the one the impact carries, exactly the precedence the siege state already uses.
    var gunState=(tracer&&tracer.gunState)||attacker.gunStateAtImpact||null,
      gunFrom=tracer&&tracer.gunState?'shot':attacker.gunStateAtImpact?'impact':null,
      shotState=tracer&&tracer.gunState||null,impactState=attacker.gunStateAtImpact||null;
    // The flight range: the tracer's muzzle to the hit, else the one the impact carries. The damage band below
    // and the page's penetration and alpha are taken at it.
    // With the server's stop known the flight is the tracer's own (review 24.09, one range owner): origin to S, less the
    // stretch from the first contact to the one it stopped at, as drawn - |origin - (S - (world[k] - world[0]))|, the
    // distance the page's camera stands from the first point (Viewer.shellPath carries the flight onto the points).
    var range=tracer&&Array.isArray(tracer.origin)&&world.length?(stop?distance(tracer.origin,[0,1,2].map(function(i){return stop.position[i]-world[stopPoint][i]+world[0][i];})):distance(tracer.origin,world[0])):null,rangeSource='tracer';
    if(!(Number.isFinite(range)&&range>0)){range=Number.isFinite(hit.rangeAtImpact)&&hit.rangeAtImpact>0?hit.rangeAtImpact:null;rangeSource=range===null?null:'impact';}
    var modeSource='';
    if(hasModes&&matching.length>1){
      // Every reading the record can hold, strongest first - by WHEN it was taken, the shot's own instant
      // before the impact's, and with the two confirmed readings before the switcher's unconfirmed flag.
      // A record that carries none of them narrows nothing, exactly as before.
      var evidence=[[modeOfGunState(shotState),'the shooter’s recorded gun state at the shot'],
        [Number.isFinite(tracer&&tracer.siegeState)?modeOfSiegeState(tracer.siegeState):null,'the shooter’s recorded state at the shot'],
        [modeOfGunState(impactState),'the shooter’s recorded gun state at the impact'],
        [Number.isFinite(attacker.siegeStateAtImpact)?modeOfSiegeState(attacker.siegeStateAtImpact):null,'the shooter’s recorded state at the impact'],
        [modeOfSwitcher(shotState),'the shooter’s recorded shell switch at the shot'],
        [modeOfSwitcher(impactState),'the shooter’s recorded shell switch at the impact']];
      evidence.forEach(function(e){
        if(e[0]===null||matching.length<2)return;
        var byState=matching.filter(function(c){return c.vehicleMode===e[0];});
        if(byState.length){matching=byState;modeSource=e[1];}
      });
      if(matching.length>1&&Number(hit.damage)>0){
        var dmg=Number(hit.damage),top=markTop(markOf(hit)),could=matching.filter(function(c){
          var r=Number.isFinite(c.damageRandomization)?c.damageRandomization:.25,a=alphaAt(c,range);
          return !(a>0)||dmg<=a*(1+r)*1.001*top;});
        if(could.length===1){matching=could;modeSource='only this state’s damage band reaches the recorded damage';}
      }
    }
    var selected=matching.length===1?matching[0]:null;
    // P1: a single candidate is still only a candidate. When the tracer's own ballistics contradict it -
    // the three measured Gorilla low-charge hits of 22.09 were shown as a determined full-charge shell,
    // penetration 385 instead of ~325 and alpha 800 instead of 390 - the shell is NOT determined.
    // B6: unless the shooter's tier-XI tree speeds exactly that shell up to what the tracer flew (treeSpeed above).
    var treeDv=selected&&ballistics(selected)===false?treeSpeed(attacker.type,selected):0,byTree=false;
    if(treeDv>0&&flight!==null){var tr=ratioOf(selected)*(selected.speed+treeDv)/selected.speed;byTree=Math.abs(tr-flight)<=flight*BALLISTIC_TOLERANCE;}
    var contradicted=!!(selected&&ballistics(selected)===false&&!byTree);
    if(contradicted)selected=null;
    if(selected&&!choices.some(function(c){return same(c,selected);}))choices.push(selected);
    var index=selected?choices.findIndex(function(c){return same(c,selected);}):-1;
    // The charge of the shot multiplies the shell's damage, whichever shell it was, so it belongs to the
    // whole list and not to one entry of it: the client's own widget shows damageFactorsPerLevel[level]
    // times the base damage of the shell that is loaded. Level 0 is x1 and changes nothing, so a record
    // whose state says "not charged" answers exactly as a record without the state at all. The spall
    // damage of HE is left alone: the client's own law for it is not this factor.
    var charge=chargeStateOf(gunState),chargeFactor=charge?CHARGE_SHOT_FACTORS[Number(charge.level)]:null;
    if(chargeFactor>1)choices=choices.map(function(c){return withCharge(c,chargeFactor);});
    // Why the shell stayed unknown, in the words the shell chips and the tooltip use.
    var why=contradicted?'no shell of this shooter fits the shot’s ballistics'
      :hasModes&&index<0?'this vehicle switches its shell parameters; the record does not say which state was on':'';
    return {choices:choices,index:index,kind:kindValues.length===1?kindValues[0]:null,caliber:calibers.length===1?calibers[0]:null,tracer:tracer,stop:stop,command:command,aim:aim,aimSource:chosen?chosen.from:null,aimReason:aimReason,
      serverShot:serverShot(tracer,events),
      range:range,rangeSource:rangeSource,modes:hasModes,unresolvedWhy:why,
      gunState:gunState,gunStateFrom:gunFrom,gunNotes:gunNotes(gunState,gunFrom),chargeFactor:chargeFactor>1?chargeFactor:null,
      treeSpeed:byTree?treeDv:null,mark:markOf(hit),
      source:index<0?'Shell not determined unambiguously'
        :modeSource?'The shooter’s second mode: '+modeSource
        :(kindValues.length?'Type and calibre from the hit; gun data from the client':'The only shell with this effect in the record')+
          (byTree?'; XI skill tree: the tracer flew '+Math.round(treeDv)+' m/s faster, the velocity node of the shooter’s tree - which may add to its alpha and penetration too, unknown to the record':'')};
  }
  /* Which shell to assume when resolve() could not name one (user, 22.09: a grey model has no logic, and of
     two shells the record cannot tell apart the one that pierces deeper is the likelier - it had the better
     chance of making the hit that was recorded). Order: the shells of the type the hit names; those whose
     own maximum can account for the damage (a shell cannot do more than its maximum; less it can, because
     the last hit on a vehicle is capped by what is left of it); the one whose damage window alone contains
     the recorded damage, if exactly one does; otherwise the deepest penetration. In the 60 recorded battles
     of 22.09 the type left two shells 65 times, always of different penetration and only 5 times of
     different damage, and the damage decided 2 of them. Returns {index, reason}; index -1 when the list
     holds nothing of that type - the page then falls back to the bare type. `range` (metres, optional) is the
     shot's flight: the window is built from the alpha AT that range, which on a Polish smoothbore APCR is far
     below the muzzle's (Błyskawica at 300 m: 522, not 800), and the window at the muzzle threw such a shell out. */
  function assume(choices,kind,damage,range,mark){
    var all=(choices||[]).map(function(c,i){return {c:c,i:i};});
    var same=kind?all.filter(function(e){return e.c.kind===kind;}):all;
    if(!same.length)return {index:-1,reason:''};
    var dmg=Number(damage)||0,top=markTop(mark);
    // `mark` (markOf above; resolve() hands it on as context.mark): on a marked target the window's top is ×1.15.
    var band=function(e){var r=Number.isFinite(e.c.damageRandomization)?e.c.damageRandomization:.25,a=alphaAt(e.c,range);
      return a>0?[a*(1-r)*.999,a*(1+r)*1.001*top]:null;};
    var could=dmg>0?same.filter(function(e){var b=band(e);return !b||dmg<=b[1];}):same;
    if(!could.length)could=same;
    var exact=dmg>0?could.filter(function(e){var b=band(e);return b&&dmg>=b[0]&&dmg<=b[1];}):[];
    var marked=top>1&&dmg>0?' (the target carried a Borkenkäfer mark: its damage window reaches ×'+top+')':'';
    if(exact.length===1)return {index:exact[0].i,reason:'the recorded damage fits this shell alone'+marked};
    var best=could.reduce(function(a,b){return (Number(b.c.penetration100)||0)>(Number(a.c.penetration100)||0)?b:a;},could[0]);
    return {index:best.i,reason:(could.length>1?'the deepest penetration of the shells that fit':
      same.length>1?'the deepest penetration of this type':'the only shell of this type the record lists')+marked};
  }
  /* THE SHELL SHOWN FOR A HIT WHOSE SHELL THE RECORD DOES NOT NAME (unknown-shell-grey, 25.09) - one owner for the
     scene (app.js prepareShell) and the Statistics log (drainVerdicts). assume() over the shells of the type the hit
     names first; when the shooter's list holds none of that type, his shell of the shot's calibre, else his first -
     never a manual figure: a manual type is only ever the user's own choice. The case: the White Tiger event's special
     shots - effects 89 is the stun shell `_128mm_HE_Waffentrager_E100_WT` (HE 128 mm, stun), which no gun of the client
     fires (docs/KNOWLEDGE.md section 3); the page left such a hit on the manual HE with empty or the previous hit's
     figures. Over the owner's 102 battles of 25.09: 167 such hits, all coloured now; 28 more have no shooter's list at
     all. Returns {index, reason, fallback, shotKind, shotCaliber, special, event}: index -1 only for an empty list;
     `reason` ends the sentence "…, so <reason> was taken"; `fallback` 'caliber' | 'first' when the type found nothing;
     `special` when the hit's effects id is none of his shells' (an ability's shot), `event` when he is an event vehicle. */
  function pick(context,hit){
    var ctx=context||{},choices=ctx.choices||[],attacker=(hit&&hit.attacker)||{};
    var guess=assume(choices,ctx.kind,hit&&hit.damage,ctx.range,ctx.mark),fallback='',index=guess.index,reason=guess.reason||'';
    if(index<0&&choices.length){
      var cal=Number(ctx.caliber),k=cal>0?choices.findIndex(function(c){return Math.abs(Number(c.caliber)-cal)<.1;}):-1;
      fallback=k>=0?'caliber':'first';index=k>=0?k:0;
      reason=k>=0?'his shell of the same calibre':'his first shell';
    }
    // Why the record could not name it comes before how one was picked (22.09): the shot's ballistics fit none of his
    // shells, or the vehicle switches its shell parameters and the record does not say which state was on.
    if(ctx.unresolvedWhy)reason=ctx.unresolvedWhy+(reason?', and of the rest '+reason:'');
    var effects=hit?Number(hit.effectsIndex):NaN;
    var special=Number.isFinite(effects)&&choices.length>0&&choices.every(function(c){return Number.isFinite(Number(c.effectsIndex))&&Number(c.effectsIndex)!==effects;});
    return {index:index,reason:reason,fallback:fallback,shotKind:ctx.kind||null,shotCaliber:Number(ctx.caliber)>0?Number(ctx.caliber):null,
      special:special,event:Array.isArray(attacker.tags)&&attacker.tags.indexOf('event_battles')>=0};
  }
  root.ArmorShotContext={resolve:resolve,serverShot:serverShot,assume:assume,pick:pick,modeLabel:modeLabel,identical:identical,gunNotes:gunNotes,markOf:markOf};
}(typeof window==='undefined'?globalThis:window));
