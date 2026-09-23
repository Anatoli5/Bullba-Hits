/* Local collision rays and penetration estimate. No network or worker process. */
(function(root){
  'use strict';
  var EPS=1e-5, RAD=Math.PI/180;
  function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
  function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function unit(v){var n=Math.sqrt(dot(v,v));return n>EPS?v.map(function(x){return x/n;}):[0,0,0];}
  function transform(v,m){return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12],m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13],-(m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14])];}
  function triangle(a,b,c,part,name,armor){
    var e1=sub(b,a),e2=sub(c,a);
    return {a:a,b:b,c:c,e1:e1,e2:e2,normal:unit(cross(e1,e2)),center:a.map(function(x,i){return (x+b[i]+c[i])/3;}),part:part,name:name,armor:armor,
      min:a.map(function(x,i){return Math.min(x,b[i],c[i]);}),max:a.map(function(x,i){return Math.max(x,b[i],c[i]);})};
  }
  function tree(tris){
    if(!tris.length)return null;
    var lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    tris.forEach(function(t){for(var i=0;i<3;i++){lo[i]=Math.min(lo[i],t.min[i]);hi[i]=Math.max(hi[i],t.max[i]);}});
    var node={min:lo,max:hi};if(tris.length<=10){node.tris=tris;return node;}
    var axis=0;for(var i=1;i<3;i++)if(hi[i]-lo[i]>hi[axis]-lo[axis])axis=i;
    tris.sort(function(a,b){return a.center[axis]-b.center[axis];});var half=tris.length>>1;
    node.left=tree(tris.slice(0,half));node.right=tree(tris.slice(half));return node;
  }
  // The distance at which the ray enters the box (0 when it starts inside), or -1 for a miss. Callers test
  // `< 0`, never falsiness: 0 is an ordinary hit - the second leg after a ricochet starts 1 mm off the surface.
  function intersectsBox(node,o,d){
    var near=0,far=Infinity;
    for(var i=0;i<3;i++){
      if(Math.abs(d[i])<1e-12){if(o[i]<node.min[i]-EPS||o[i]>node.max[i]+EPS)return -1;continue;}
      var a=(node.min[i]-o[i])/d[i],b=(node.max[i]-o[i])/d[i];
      near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));if(near>far+EPS)return -1;
    }
    return far>=0?near:-1;
  }
  function intersect(t,o,d){
    // Same intersection arithmetic without temporary vectors for every triangle.
    var e1=t.e1,e2=t.e2,hx=d[1]*e2[2]-d[2]*e2[1],hy=d[2]*e2[0]-d[0]*e2[2],hz=d[0]*e2[1]-d[1]*e2[0];
    var det=e1[0]*hx+e1[1]*hy+e1[2]*hz;if(Math.abs(det)<1e-10)return null;
    var sx=o[0]-t.a[0],sy=o[1]-t.a[1],sz=o[2]-t.a[2],u=(sx*hx+sy*hy+sz*hz)/det;if(u<-1e-8||u>1+1e-8)return null;
    var qx=sy*e1[2]-sz*e1[1],qy=sz*e1[0]-sx*e1[2],qz=sx*e1[1]-sy*e1[0],v=(d[0]*qx+d[1]*qy+d[2]*qz)/det;if(v<-1e-8||u+v>1+1e-8)return null;
    var distance=(e2[0]*qx+e2[1]*qy+e2[2]*qz)/det;return distance>EPS?{distance:distance,triangle:t,cos:Math.abs(dot(d,t.normal))}:null;
  }
  // Every contact of the ray, cut off past the nearest MAIN armour met so far (st.best): walk() below stops at
  // the first main plate, so nothing behind it can change the result, and a box the ray enters beyond it is
  // skipped. The condition that moves st.best is exactly walk()'s exit - armour with a value and a damage
  // factor - so a plate walk() would pass (no armour table, armour null) never cuts anything. A contact at x
  // lies inside every box above it (each is entered at or before x), so the kept contacts are the ones the
  // full walk would have found up to best, in the same order; the stable sort leaves them as they were.
  // Keep this condition and walk()'s exits in step.
  function collisions(node,o,d,out,st){
    if(!node)return;var near=intersectsBox(node,o,d);if(near<0||near>st.best+EPS)return;
    if(node.tris){for(var i=0;i<node.tris.length;i++){var t=node.tris[i],hit=intersect(t,o,d);if(hit){out.push(hit);var a=t.armor;
      if(a&&a.armor!=null&&a.vehicleDamageFactor>EPS&&hit.distance<st.best)st.best=hit.distance;}}}
    else{collisions(node.left,o,d,out,st);collisions(node.right,o,d,out,st);}
  }
  function erf(x){var sign=x<0?-1:1;x=Math.abs(x);var t=1/(1+.3275911*x);return sign*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x));}
  // Same Gaussian scale as the 2.4 #936 client's _computePenetrationChance.
  function chance(remaining,armor,nominal,randomization,type){
    if(!(nominal>0))return null;
    var margin=(remaining-armor)/nominal;
    if(randomization<=EPS)return margin>=0?100:0;
    if(type&&type!=='NORMAL')return null;
    return Math.round(clamp(.5*(1+erf(margin/randomization/.33/Math.sqrt(2)))*100,0,100));
  }
  // --- Aim emulation -------------------------------------------------------------------------
  // The shooter's dispersion circle, by the client's own formula. Source: the saved client source
  // of this branch, Avatar.getOwnVehicleShotDispersionAngle (see outputs/aim-emulation-findings-2026-09-19.md);
  // the field names and units of `aim` come from the installed client's scripts/common/items/vehicles.pyc
  // and are written by the recorder (mod/local_armor_inspector/exporter.py aim_block).
  //
  //   ideal = mult · sqrt(1 + additive² · ((v·cm)² + (ω·cr)² + (ωt·ct)² + (after a shot ? cs² : 0)))
  //   aiming(t) = max(idealNow, start · exp(−t / aimingTime))
  //   circle radius at range R = dispersion · factor · R
  //
  // Everything the crew, the equipment, the perks and the field modification do sits in `mods`, and
  // each multiplier is applied exactly where the client applies it: the full-aim accuracy on mult,
  // the stabiliser on additive, a perk on the single dispersion factor it names, the laying drive on
  // the aiming time. The client's dual accuracy and auto-shoot guns are separate mechanics and are
  // not modelled here.
  //
  // aimFactor() answers a question about one state: "the vehicle was in this state, then everything
  // stopped settledFor seconds ago". The factor decays from the ideal factor of that state towards
  // the resting one (mult, i.e. standing still, turret still, no shot); settledFor = 0 means the
  // shot is taken in the state itself. That is what the manual sliders ask and it stays as it was.
  // aimStep() below is the same formula integrated over real time instead, for the WASD emulation.
  var NO_MODS={mult:1,additive:1,movement:1,rotation:1,turret:1,aimingTime:1,turretSpeed:1,hullSpeed:1,reload:1,clipInterval:1};
  function aimMods(mods){
    var out={},keys=Object.keys(NO_MODS);
    for(var i=0;i<keys.length;i++){
      var v=mods?Number(mods[keys[i]]):NaN;
      out[keys[i]]=isFinite(v)&&v>0?v:NO_MODS[keys[i]];
    }
    return out;
  }
  function aimFactor(aim,state,mods){
    if(!aim||!(aim.dispersion>0))return null;
    var m=aimMods(mods),s=state||{};
    var mult=(aim.multFactor>0?aim.multFactor:1)*m.mult;
    var additive=(aim.additiveFactor>0?aim.additiveFactor:1)*m.additive;
    var cm=(aim.movementFactor>0?aim.movementFactor:0)*m.movement;
    var cr=(aim.rotationFactor>0?aim.rotationFactor:0)*m.rotation;
    var ct=(aim.turretRotationFactor>0?aim.turretRotationFactor:0)*m.turret;
    var cs=aim.afterShotFactor>0?aim.afterShotFactor:0;
    var v=Math.abs(Number(s.speed)||0),w=Math.abs(Number(s.hullTurn)||0),wt=Math.abs(Number(s.turretTurn)||0);
    var sum=(v*cm)*(v*cm)+(w*cr)*(w*cr)+(wt*ct)*(wt*ct)+(s.afterShot?cs*cs:0);
    var ideal=mult*Math.sqrt(1+additive*additive*sum);
    // The laying drive and the field modification scale the aiming time through miscAttrs; the
    // descriptor's own gunAimingTimeFactor is already in the record and is kept.
    var aimingTime=(aim.aimingTime>0?aim.aimingTime:0)*(aim.aimingTimeFactor>0?aim.aimingTimeFactor:1)*m.aimingTime;
    // The resting factor is the same formula with the state at zero, which leaves exactly mult.
    var rest=mult,settled=Math.max(0,Number(s.settledFor)||0),factor=ideal;
    if(settled>0)factor=aimingTime>0?Math.max(rest,ideal*Math.exp(-settled/aimingTime)):rest;
    return {ideal:ideal,rest:rest,factor:factor,aimingTime:aimingTime,radius100:aim.dispersion*factor*100};
  }
  // --- Aim emulation in real time (stage 2) -----------------------------------------------------
  // Everything below is driven frame by frame instead of being asked about a single state, so the
  // page can put the player behind the gun: W A S D move the vehicle, the turret chases the cursor,
  // a click is a shot and the gun has to reload before the next one.
  //
  // CLIENT RULE, not ours: the factor itself. Avatar.getOwnVehicleShotDispersionAngle keeps
  //   aiming(t) = max(idealNow, start · exp(−(t − t0) / aimingTime))
  // and lets the factor fall towards the ideal factor of the current state, while a RISE is
  // instant: the moment the ideal factor climbs above the decaying one (the vehicle sets off, the
  // turret starts turning, the gun fires) the client restarts the exponential from there. aimStep()
  // is exactly that rule with the time advanced by dt, written as a pure step so nothing but the
  // caller holds state.
  function idealOf(aim,state,mods,afterShot){
    // settledFor is deliberately dropped: the settling is what this step function integrates.
    var s=state||{};
    return aimFactor(aim,{speed:s.speed,hullTurn:s.hullTurn,turretTurn:s.turretTurn,afterShot:!!afterShot},mods);
  }
  function aimReading(aim,factor,ideal,start,elapsed,aimingTime){
    return {factor:factor,ideal:ideal,start:start,elapsed:elapsed,aimingTime:aimingTime,
      radius100:aim.dispersion*factor*100,settled:!(factor>ideal*(1+1e-9))};
  }
  // prev is the previous reading (null on the first frame), dt the seconds since it. A dt bigger
  // than a quarter of a second is clamped: a tab that was away for a minute must not settle the
  // circle "for free", and the caller cannot know how long the browser withheld the frame.
  function aimStep(prev,state,aim,mods,dt){
    var now=idealOf(aim,state,mods,false);
    if(!now)return null;
    var step=Math.max(0,Math.min(.25,Number(dt)||0)),at=now.aimingTime;
    var start=prev&&prev.start>0?prev.start:0,elapsed=prev&&prev.elapsed>=0?prev.elapsed+step:0;
    var decayed=start>0&&at>0?start*Math.exp(-elapsed/at):0;
    // The ideal factor caught up with the decaying one (or there is nothing to decay from): the
    // client's instant rise, which also covers the very first frame.
    if(!(decayed>now.ideal))return aimReading(aim,now.ideal,now.ideal,now.ideal,0,at);
    return aimReading(aim,decayed,now.ideal,start,elapsed,at);
  }
  // A shot. CLIENT RULE: the recoil enters the very same formula as one more term under the square
  // root (gun.shotDispersionFactors['afterShot']), so the ideal factor AT THE INSTANT OF THE SHOT
  // is computed with that term and the exponential restarts from it - or from the current factor
  // when the circle was still wider than that, because the client never shrinks the circle instantly.
  function aimShot(prev,state,aim,mods){
    var bloom=idealOf(aim,state,mods,true),after=idealOf(aim,state,mods,false);
    if(!bloom||!after)return prev||null;
    var current=prev&&prev.factor>0?prev.factor:after.ideal;
    var start=Math.max(current,bloom.ideal);
    return aimReading(aim,start,after.ideal,start,0,bloom.aimingTime);
  }
  // Reload. CLIENT RULE, items/utils.pyc getReloadTime:
  //   reload = gun.reloadTime · miscAttrs['gunReloadTimeFactor'] · max(factors['gun/reloadTime'], 0)
  //            + factors['gun/extraReloadTime']
  // factors['gun/reloadTime'] is 1 / f of the LOADER - VehicleDescrCrew._updateLoaderFactors writes
  // exactly `factors['gun/reloadTime'] = 1.0 / a.factor`, and a.factor comes out of the same
  // _processSkills law the gunner uses, f = 0.57 + 0.43 · efficiency. The rammer lives in
  // gunReloadTimeFactor. The record carries reloadTimeFactor as the descriptor gave it, and a
  // descriptor rebuilt from a compact descriptor has no equipment at all, so it is 1.0 there: the
  // page multiplies the rammer and the crew in `mods.reload` and nothing is applied twice. The
  // extra reload term is a battle-time effect (a consumable, a damaged gun) and is not modelled.
  // Clip guns: `shots` rounds inside the magazine at `interval` seconds apart, then the full reload.
  function reloadSeconds(aim,mods){
    if(!aim||!(aim.reloadTime>0))return null;
    var m=aimMods(mods),clip=aim.clip,burst=aim.burst;
    var shots=clip&&clip.length>1&&clip[0]>1?Math.floor(clip[0]):1;
    return {reload:aim.reloadTime*(aim.reloadTimeFactor>0?aim.reloadTimeFactor:1)*m.reload,
      // Mag Mastery (tankmen.xml loader_magMastery) shortens the interval between the rounds of a clip
      // and nothing else; the page reads that interval from here alone, so one factor covers every caller.
      shots:shots,interval:shots>1&&clip[1]>0?clip[1]*m.clipInterval:0,
      burst:burst&&burst.length>1&&burst[0]>1?{count:Math.floor(burst[0]),interval:burst[1]>0?burst[1]:0,sync:!!burst[2]}:null};
  }
  // Movement. OUR APPROXIMATION, and there is no client formula behind any of it: the real vehicle
  // accelerates by engine power against weight, terrain resistance and the gearbox, which the record
  // does not carry and which the dispersion circle does not need - only |v| and |ω| enter the
  // client's formula. So the speed ramps LINEARLY to the vehicle's own top speed over accelSeconds
  // (default 5 s forward, 3 s backward, both configurable), brakes to a stop over brakeSeconds
  // (default 2 s), and the hull turn ramps to the chassis rotation speed over half a second. The
  // limits themselves - speedForward/speedBackward and hullRotationSpeed - are the client's own.
  var MOVE={accel:5,accelBack:3,brake:2,turn:.5};
  function seconds(value,fallback){var v=Number(value);return isFinite(v)&&v>0?v:fallback;}
  function term(value){var v=Number(value);return isFinite(v)?v:0;}
  function approach(value,target,most){
    if(value<target)return Math.min(target,value+most);
    if(value>target)return Math.max(target,value-most);
    return target;
  }
  function moveStep(prev,keys,aim,mods,dt){
    var k=keys||{},s=prev||{},m=aimMods(mods),a=aim||{};
    var step=Math.max(0,Math.min(.25,Number(dt)||0));
    // A turbocharger and the Mobility Improvement System raise the CAP the vehicle accelerates to
    // (optional_devices.xml forwardMaxSpeedKMHTerm / backwardMaxSpeedKMHTerm), which makes the movement
    // term BIGGER, not smaller - the honest answer. The page hands the terms in already converted to the
    // m/s the record uses. A vehicle whose record carries no speed at all gains nothing: 0 means no data,
    // and a term on top of it would be an invented speed.
    var forward=a.speedForward>0?Math.max(0,a.speedForward+term(mods&&mods.speedForwardAdd)):0;
    var back=a.speedBackward>0?Math.max(0,a.speedBackward+term(mods&&mods.speedBackwardAdd)):0;
    var hullMax=(a.hullRotationSpeed>0?a.hullRotationSpeed:0)*m.hullSpeed;
    var accel=seconds(mods&&mods.accelSeconds,MOVE.accel),accelBack=seconds(mods&&mods.accelBackSeconds,MOVE.accelBack);
    var brake=seconds(mods&&mods.brakeSeconds,MOVE.brake),turn=seconds(mods&&mods.turnSeconds,MOVE.turn);
    var speed=Number(s.speed)||0,hullTurn=Number(s.hullTurn)||0;
    var target=k.forward&&!k.back?forward:k.back&&!k.forward?-back:0;
    // BRAKING IS A PHASE OF ITS OWN, as in the game (user, 20.09): while the key pulls against the
    // way the vehicle is going - S with a forward speed, W with a reverse one - the step only brakes,
    // and it stops AT ZERO. The acceleration the other way starts from a standstill on the next step,
    // at its own rate, instead of the brake rate carrying the speed straight through zero.
    var goal=target!==0&&speed*target<0?0:target;
    // Pushing the speed further from zero in the direction it already has is acceleration; anything
    // else - releasing the key, or braking towards zero - is the brake.
    var rising=goal!==0&&speed*goal>=0&&Math.abs(goal)>Math.abs(speed);
    var rate=rising?(goal>0?forward/accel:back/accelBack):Math.max(forward,back)/brake;
    speed=approach(speed,goal,Math.max(0,rate)*step);
    var hullTarget=k.left&&!k.right?-hullMax:k.right&&!k.left?hullMax:0;
    hullTurn=approach(hullTurn,hullTarget,(hullMax>0?hullMax/turn:0)*step);
    return {speed:speed,hullTurn:hullTurn,forward:forward,back:back,hullMax:hullMax,
      resting:Math.abs(speed)<1e-3&&Math.abs(hullTurn)<1e-4&&target===0&&hullTarget===0};
  }
  // The turret chasing the cursor. CLIENT RULE: turret.rotationSpeed is the turret's speed RELATIVE
  // TO THE HULL, and the gunner's crew factor scales it (VehicleDescrCrew._updateGunnerFactors sets
  // factors['turret/rotationSpeed'] = f). OUR APPROXIMATION is what the turret spends that speed on:
  // while the hull turns, holding the aim already costs |hullTurn| of the budget, so only what is
  // left chases the cursor - which is why turretTurn is never below |hullTurn| while A or D is held,
  // and why a fast hull rotation can make the gun fall behind the cursor altogether. `gap` is the
  // angle between where the gun points and where the cursor points, in radians.
  function turretChase(gap,hullTurn,aim,mods,dt,swung){
    var m=aimMods(mods),limit=(aim&&aim.turretRotationSpeed>0?aim.turretRotationSpeed:0)*m.turretSpeed;
    var step=Math.max(1e-4,Math.min(.25,Number(dt)||0)),hull=Math.abs(Number(hullTurn)||0);
    var want=Math.max(0,Number(gap)||0)/step;
    // No turret speed in the record: the gun is simply where the cursor is, and the formula sees the
    // hull's own rotation only. Better than pretending the turret cannot move at all.
    if(!(limit>0))return {rate:want,turretTurn:hull,step:Math.max(0,Number(gap)||0),caught:true};
    // `swung`: the caller has ALREADY carried the aim point around with the hull (stage 6, user 20.09),
    // so the gap handed in contains the hull's own turn. The whole relative budget is then free to close
    // it, and the relative turret speed - the one the dispersion formula asks for - is exactly the rate
    // the gun is pulled back at. Holding the aim against a turning hull therefore still costs |hullTurn|
    // of the budget and leaves limit - |hullTurn| to gain on the cursor, as it did before; counting the
    // hull twice would instead push the ring away faster than the turret could ever fetch it back.
    if(swung){var rel=Math.min(want,limit);return {rate:rel,turretTurn:rel,step:rel*step,caught:rel>=want-1e-9};}
    var budget=Math.max(0,limit-hull),rate=Math.min(want,budget);
    return {rate:rate,turretTurn:Math.min(limit,hull+rate),step:rate*step,caught:rate>=want-1e-9};
  }
  // --- Where a shot lands inside the circle -----------------------------------------------------
  // A profile is one radial CDF, inverted: quantile(u) is r/R for a uniform u in [0,1). The circle
  // sampler fans its rays over the quantiles of whichever profile is chosen, so the shape of the
  // distribution is a setting and not something buried in the sampler.
  //
  // NEITHER profile is a confirmed server law - the server's own sampler is not published and is not
  // in the client - and the page says so wherever it prints a figure.
  var AIM_PROFILES={},DEFAULT_PROFILE='empirical-post96';
  // The measured table of Overlord_Prime ("Ultimate Gun Mechanics", Post-0.9.6 Shot Distribution
  // Probability Table, 380k+ shots): the share of shots in each ring of 0.1 R. It is the author's own
  // measurement, not datamined server code, and it was taken on 9.6.
  //
  // It is the default because it was checked against the user's OWN recorded shots (19.09.2026, 72
  // usable own tracers including misses over 11 battles, bootstrapped by battle): the measured share
  // inside half the radius is 0.68-0.70, the table gives 0.689 - inside that interval - and the old
  // Gaussian gives 0.455, outside it. The scale of the distribution against the circle this page
  // draws came out compatible with 1 (1.04, [0.87; 1.26]), so the table is used directly on the drawn
  // radius; the "1.71x" figure that circulates for the drawn reticle is not supported by those shots.
  // 72 shots cannot settle the shape of the tail, so the author's undecided 0.1 % edge mass is folded
  // into the last ring rather than declared a probability atom on the boundary.
  var POST96=[9.9,16.1,16.1,14.6,12.2,9.9,7.3,5.6,4.4,3.9];
  var POST96_CDF=(function(){var out=[0],sum=0;POST96.forEach(function(m){sum+=m;out.push(sum);});
    return out.map(function(v){return v/sum;});}());
  AIM_PROFILES[DEFAULT_PROFILE]={id:DEFAULT_PROFILE,label:'Empirical table (Overlord_Prime, post-9.6)',
    note:'Empirical table (Overlord_Prime, post-9.6, 380k shots), used at scale 1 on the drawn circle after a check against 72 of your own recorded shots. Still not a confirmed server formula.',
    rings:POST96.slice(),cdf:POST96_CDF.slice(),
    // Inside a ring the radius is interpolated linearly, which assumes a constant radial density
    // there; a table in steps of 0.1 R cannot say what happens inside one ring, least of all the
    // central one, so the very middle of the circle must not be read as an exact figure.
    quantile:function(u){
      var x=Math.max(0,Math.min(1-1e-12,u)),n=POST96_CDF.length-1;
      for(var i=0;i<n;i++){
        var lo=POST96_CDF[i],hi=POST96_CDF[i+1];
        if(x<hi||i===n-1){var mass=hi-lo;return (i+(mass>0?(x-lo)/mass:0))/n;}
      }
      return 1;
    }};
  // The page's own assumption up to 0.7.13: a 2D isotropic Gaussian with sigma = R/2, conditioned on
  // landing inside the disc, F(t) = (1 − exp(−2t²)) / (1 − exp(−2)). Kept so the old figures can be
  // reproduced, but the same 72 shots put it outside the measured interval: it puts far too little
  // weight in the middle of the circle.
  AIM_PROFILES['gauss-r2']={id:'gauss-r2',label:'Previous model (σ = radius / 2)',
    note:'The page’s model up to 0.7.13: a 2D Gaussian clipped to the circle. It does not match the measured shots - it holds 45 % inside half the radius where they show 68-70 %.',
    quantile:function(u){return Math.sqrt(-.5*Math.log(1-Math.max(0,Math.min(1-1e-12,u))*(1-Math.exp(-2))));}};
  function aimProfile(name){return AIM_PROFILES[name]||AIM_PROFILES[DEFAULT_PROFILE];}
  function shell(kind,penetration,caliber){
    var ap=kind==='ARMOR_PIERCING'||kind==='ARMOR_PIERCING_CR';
    return {kind:kind,penetration:penetration,caliber:caliber,randomization:.25,randomizationType:'NORMAL',
      normalization:(kind==='ARMOR_PIERCING'?5:kind==='ARMOR_PIERCING_CR'?2:0)*RAD,
      ricochetCos:Math.cos((ap?70:85)*RAD),checkCaliber:ap,mayRicochet:kind!=='HIGH_EXPLOSIVE',
      jetLossPerMeter:kind==='HOLLOW_CHARGE'?.5:0,shieldPenetration:kind==='HIGH_EXPLOSIVE',
      // No record behind a manual shell, so no damage data: the map falls back to the chance everywhere.
      alpha:null,spallDamage:null,spallAbsorption:null,mechanics:null,nonPiercingArmorDamage:0,liner:1,
      ricochetLoss:ap?.25:0}; // client rule since 9.3: AP and APCR keep 75% of the penetration after a ricochet, HEAT keeps all of it
  }
  function effective(armor,cos,s){
    if(!armor.useHitAngle)return armor.armor;
    var normalization=s.normalization;
    if(armor.checkCaliberForHitAngleNorm&&armor.armor>EPS&&s.caliber>armor.armor*2)
      normalization*=1.4*s.caliber/(armor.armor*2);
    return armor.armor/Math.max(EPS,Math.cos(Math.max(0,Math.acos(clamp(cos,0,1))-normalization)));
  }
  function ricochet(armor,cos,s){
    if(!s.mayRicochet||!armor.mayRicochet||armor.armor<=EPS||cos>s.ricochetCos+1e-12)return false;
    return !armor.checkCaliberForRicochet||!s.checkCaliber||armor.armor*3>=s.caliber;
  }
  // Non-penetration damage of one shot, HP. Modern HE spalls into the hull behind a plate it did not pierce:
  // D_np = spallDamage · min(1, 0.1·spallDamage/(T·C)), T the plate's nominal armour, C the target's spall-liner factor.
  // The spall penetration is taken from the spall damage, not the displayed alpha: for regular HE (spallDamage = α/2)
  // that is the Reddit author's 0.05·α, and it also reproduces his ARES series (α 160, spallDamage 160, 20 mm:
  // 126 HP measured, 128 predicted, 64 with 0.05·α) - outputs/he-law-check-2026-09-19.md.
  // A reconstruction of the server's rule from the client's own armorSpalls data (outputs/he-damage-findings.md),
  // NOT a confirmed formula, and the ±25% damage roll is not in it. Legacy HE (SPG) has no client-side splash
  // model at all, so it stays at 0 and says so; AP/APCR/HEAT take nonPiercingArmorDamage, 0 on every shell today.
  function nonPenetration(s,nominal){
    if(s.kind!=='HIGH_EXPLOSIVE')return {damage:s.nonPiercingArmorDamage>0?s.nonPiercingArmorDamage:0,law:'none'};
    if(s.mechanics!=='MODERN'||!(s.spallDamage>0))return {damage:0,law:'legacy-unknown'};
    // armorSpalls/damageAbsorption (one shell in the client, the Taschenratte ability gun): the recorded series of
    // the Reddit study fit neither law (45 HP measured on 200 mm, 11 by the ratio law), so it stays unmodelled.
    if(s.spallAbsorption!==null&&s.spallAbsorption!==undefined)return {damage:0,law:'special-unknown'};
    return {damage:s.spallDamage*Math.min(1,.1*s.spallDamage/Math.max(EPS,nominal*(s.liner>0?s.liner:1))),law:'ratio'};
  }
  // E = p·α + (1−p)·D_np on main armour; 0 where the shell never reaches it (ricochet, screen, fly-past).
  function withDamage(r,s){
    if(r.reason==='penetration'){
      var np=nonPenetration(s,r.nominal),p=r.chance===null||r.chance===undefined?null:clamp(r.chance/100,0,1);
      r.alpha=s.alpha;r.nonPen=np.damage;r.damageLaw=np.law;
      // One penetration roll serves the whole shot: the shell passes a screen when the roll beats the screen's own
      // plate, pierces the hull when the roll less 3x the screens beats the main plate. Non-penetration damage needs
      // the first without the second, so its weight is P(pass every screen) - p, not 1 - p. A shell stopped by a
      // screen explodes there and deals nothing (client reticle __shotResultModernHE, WG 1.13: "will not cause any
      // damage at all"), which is why a gun mantlet screen so often eats a whole HE shell.
      var pass=r.screenPass===undefined||r.screenPass===null?1:r.screenPass;
      r.expected=p===null?null:p*s.alpha+Math.max(0,pass-p)*np.damage;
      r.expectedShare=r.expected===null?null:clamp(r.expected/s.alpha,0,1);
    }else if(r.reason==='ricochet'||r.reason==='screen'||r.reason==='no-hull'){r.expected=0;r.expectedShare=0;}
    return r;
  }
  function evaluate(hits,s){var r=walk(hits,s);return s&&s.alpha>0?withDamage(r,s):r;}
  function walk(hits,s){
    if(!s||!(s.penetration>0)||!(s.caliber>0))return {chance:null,reason:'parameters',layers:[]};
    var remaining=s.penetration,ignored={},layers=[],jet=false,jetStart=0,jetRate=0,seen={},screenPass=1;
    for(var i=0;i<hits.length;i++){
      var hit=hits[i],t=hit.triangle,a=t.armor,key=t.part+':'+t.name;
      if(seen[key]!==undefined&&Math.abs(hit.distance-seen[key])<EPS)continue;
      seen[key]=hit.distance;
      if(ignored[key])continue;
      if(!a)return {chance:null,reason:'armor',layers:layers};
      if(a.armor===null||a.armor===undefined)continue;
      var cos=a.useHitAngle?hit.cos:1;
      if(!jet&&ricochet(a,cos,s))return {chance:0,reason:'ricochet',layers:layers,nominal:a.armor,angle:Math.acos(clamp(cos,0,1))/RAD,distance:hit.distance,hit:hit,final:!!s.ricocheted};
      // HEAT after the first screen: the jet loses a fixed share of the penetration it had behind that screen per
      // metre flown (client: 0.5/m), linearly along the whole way to the armour. A later screen only subtracts its own
      // plate; it never restarts the decay (user, 19.09: a second screen in the same gap used to raise the chance).
      if(jet)remaining=Math.max(0,remaining-jetRate*Math.max(0,hit.distance-jetStart));
      var plate=effective(a,cos,s);
      // `distance` along this leg and the struck facet's `normal` (a reference, never copied) say WHERE the plate was
      // met: the Hitmarks lay one mark at every plate of the verdict's own path from them, with no second ray.
      layers.push({part:t.part,material:t.name,nominal:a.armor,effective:plate,angle:Math.acos(clamp(cos,0,1))/RAD,main:a.vehicleDamageFactor>EPS,
        distance:hit.distance,normal:t.normal});
      if(a.vehicleDamageFactor>EPS){
        return {chance:chance(remaining,plate,s.penetration,s.randomization,s.randomizationType),reason:'penetration',
          effective:s.penetration-remaining+plate,nominal:a.armor,angle:layers[layers.length-1].angle,layers:layers,distance:hit.distance,screenPass:screenPass};
      }
      if(s.kind==='HIGH_EXPLOSIVE'){
        if(!s.shieldPenetration)return {chance:0,reason:'screen',layers:layers,distance:hit.distance};
        // Chance that the shell gets through this screen at all (its own plate against the penetration left); the
        // thresholds of successive screens nest, so the smallest chance is the chance to pass them all.
        var through=chance(remaining,plate,s.penetration,s.randomization,s.randomizationType);
        if(through!==null)screenPass=Math.min(screenPass,through/100);
        layers[layers.length-1].through=through; // which screen a shell stopped short of the hull died on (Hitmarks)
        remaining-=plate*3; // Modern HE shield penalty
      }else remaining-=plate;
      if(a.collideOnceOnly)ignored[key]=true;
      jet=s.jetLossPerMeter>0;
      if(jet){jetStart=hit.distance+a.armor*.001;if(!jetRate)jetRate=remaining*s.jetLossPerMeter;}
    }
    return {chance:0,reason:'no-hull',layers:layers,screenPass:screenPass};
  }
  // `flat`: one leaf holding every triangle instead of the kd-tree, for a caller that casts only a handful of
  // rays through a throwaway engine (the Statistics log pass: 1-3 rays a hit). Building the tree costs far more
  // than those rays save; the rays and their results are the same either way.
  function build(data,useCurrent,flat){
    var tris=[];
    ((data.hit.target||{}).parts||[]).forEach(function(part){
      var model=data.models[String(part.id)];if(!model||!part.transform)return;
      model.groups.forEach(function(g){
        var vertices=g.vertices.map(function(v){return transform(v,part.transform);});
        var armor=useCurrent?(part.comparisonArmor||part.armor):part.armor;
        for(var i=0;i<g.indices.length;i+=3)tris.push(triangle(vertices[g.indices[i]],vertices[g.indices[i+1]],vertices[g.indices[i+2]],part.id,g.material,(armor||{})[g.material]));
      });
    });
    return fromTriangles(tris,flat);
  }
  function leaf(tris){
    if(!tris.length)return null;
    var lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    tris.forEach(function(t){for(var i=0;i<3;i++){lo[i]=Math.min(lo[i],t.min[i]);hi[i]=Math.max(hi[i],t.max[i]);}});
    return {min:lo,max:hi,tris:tris.slice()};
  }
  function fromTriangles(tris,flat){
    var acceleration=flat?leaf(tris):tree(tris.slice());
    var engine={triangles:tris,acceleration:acceleration};
    engine.ray=function(o,d,s){
      if(!s||!(s.penetration>0)||!(s.caliber>0))return evaluate([],s);
      // A fresh cut-off for every ray, the second leg after a ricochet included (collisions above).
      d=unit(d);var hits=[];collisions(acceleration,o,d,hits,{best:Infinity});hits.sort(function(a,b){return a.distance-b.distance;});
      var r=evaluate(hits,s);r.origin=o;r.direction=d;
      // Client rule since 9.3: after a ricochet the shell flies on along the mirrored direction with the reduced
      // penetration and may hit the same vehicle again; a second ricochet destroys it. The first-contact picture
      // (heat map, GPU cross-check) passes ricochetContinue:false and stops here.
      if(r.reason==='ricochet'&&r.hit&&!s.ricocheted&&s.ricochetContinue!==false&&s.ricochetLoss!==undefined){
        var h=r.hit,n=h.triangle.normal,k=2*dot(d,n),out=unit([d[0]-k*n[0],d[1]-k*n[1],d[2]-k*n[2]]);
        var point=[o[0]+d[0]*h.distance,o[1]+d[1]*h.distance,o[2]+d[2]*h.distance];
        var next=Object.assign({},s,{penetration:s.penetration*(1-s.ricochetLoss),ricocheted:true});
        var second=engine.ray([point[0]+out[0]*1e-3,point[1]+out[1]*1e-3,point[2]+out[2]*1e-3],out,next);
        second.bounce={point:point,normal:n,direction:out,nominal:r.nominal,angle:r.angle,penetration:next.penetration,loss:s.ricochetLoss,layers:r.layers,part:h.triangle.part};
        return second;
      }
      return r;
    };
    return engine;
  }
  function subdivide(t,depth,out,edge,budget){
    edge=edge||.65;budget=budget===undefined?64:budget;
    var points=[t.a,t.b,t.c],edges=[[0,1,2],[1,2,0],[2,0,1]],longest=0,max=0;
    edges.forEach(function(e,i){var v=sub(points[e[0]],points[e[1]]),size=dot(v,v);if(size>max){max=size;longest=i;}});
    if(depth>=14||budget<2||max<=edge*edge){out.push(t);return;}
    var e=edges[longest],a=points[e[0]],b=points[e[1]],c=points[e[2]],mid=a.map(function(x,i){return (x+b[i])/2;});
    subdivide(triangle(a,mid,c,t.part,t.name,t.armor),depth+1,out,edge,Math.floor(budget/2));subdivide(triangle(mid,b,c,t.part,t.name,t.armor),depth+1,out,edge,Math.ceil(budget/2));
  }
  var palettes={accessible:[[.63,.18,.55],[.95,.75,.31],[.20,.84,.76]],classic:[[.90,.20,.18],[.97,.79,.22],[.20,.79,.35]]};
  // The 0…1 quantity a result is coloured by: the penetration chance, or - in damage mode, and only when the
  // shell carries an alpha - the expected damage as a share of it. null means "no estimate": neutral grey.
  function value(result,mode){
    if(mode==='damage')return result.expectedShare===null||result.expectedShare===undefined?null:clamp(result.expectedShare,0,1);
    return result.chance===null||result.chance===undefined?null:clamp(result.chance/100,0,1);
  }
  function color(result,palette,tint,mode){
    var share=value(result,mode);
    if(share===null)return [.34,.42,.49];
    // Ricochet history (a ricochet, or a fly-past after one): the 0 % colour with blue mixed in by 'tint'
    // (0 none, 0.5 default, up to 1.5), the same rule as the GPU map's blued().
    if(result.reason==='ricochet'||(result.reason==='no-hull'&&result.bounce)){
      var lo=(palettes[palette]||palettes.accessible)[0],k=tint===undefined?.5:tint,to=[lo[0]*.8,lo[1]*.95,Math.max(lo[2],.55)];
      return lo.map(function(v,i){return clamp(v+(to[i]-v)*k,0,1);});
    }
    if(result.reason==='no-hull')return [.21,.27,.33];
    var stops=palettes[palette]||palettes.accessible,p=share*2,i=Math.min(1,Math.floor(p)),f=p-i;
    return stops[i].map(function(v,k){return v+(stops[i+1][k]-v)*f;});
  }
  root.ArmorBallistics={build:build,fromTriangles:fromTriangles,triangle:triangle,subdivide:subdivide,evaluate:evaluate,shell:shell,chance:chance,effective:effective,ricochet:ricochet,color:color,value:value,nonPenetration:nonPenetration,transform:transform,unit:unit,sub:sub,aimFactor:aimFactor,
    aimStep:aimStep,aimShot:aimShot,reloadSeconds:reloadSeconds,moveStep:moveStep,turretChase:turretChase,
    aimProfiles:AIM_PROFILES,aimProfile:aimProfile,aimProfileDefault:DEFAULT_PROFILE,moveDefaults:MOVE};
}(typeof window==='undefined'?globalThis:window));
