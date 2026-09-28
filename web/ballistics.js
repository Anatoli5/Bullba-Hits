/* Local collision rays and penetration estimate. No network; heavy integrals may run in a page-local Web Worker made
   from this very file (remote*, serve below), with the main thread as the fallback. */
(function(root){
  'use strict';
  var EPS=1e-5, RAD=Math.PI/180;
  // This file's own URL, for the worker to import it (the page's classic <script>; empty in a worker and in Node).
  var SELF_URL=typeof document!=='undefined'&&document.currentScript&&document.currentScript.src||'';
  function now(){return typeof performance!=='undefined'&&performance.now?performance.now():Date.now();}
  // Two contacts closer than TIE metres along a ray are one depth: they go in the order of their material id (below).
  // THE one coincidence tolerance (review 26.09 R3): the GPU depth peel and its bounced leg (web/screen-armor.js, TIE_EPS
  // of both shaders) are generated from ArmorBallistics.TIE. 10 um, the peel's figure (the CPU and the leg had 0.1 mm):
  // the peel's first layer is the depth test's nearest face, so a face 50 um behind a main plate with the lower id came
  // first on the CPU (a 0.1 mm tie) and never on the GPU (tests/page/gpu_bounce.cjs, a camera at 200 m). 10 um is still
  // ten float32 steps above the noise of coplanar faces at vehicle size. Limit: at a close camera (the capture near
  // plane at 0.01 m) the depth buffer cannot part faces ~0.4 mm apart and its pick there is noise - a GPU matter.
  var TIE=1e-5;
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
  // The kd-tree over triangle INDICES (28.09: a leaf's idx is what collisions keeps; the split, the sort by centre and
  // the halves are the ones the tree over the triangle objects had - the same stable sort on the same keys).
  function tree(all,idx){
    if(!idx.length)return null;
    var lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    idx.forEach(function(k){var t=all[k];for(var i=0;i<3;i++){lo[i]=Math.min(lo[i],t.min[i]);hi[i]=Math.max(hi[i],t.max[i]);}});
    var node={min:lo,max:hi};if(idx.length<=10){node.idx=Int32Array.from(idx);return node;}
    var axis=0;for(var i=1;i<3;i++)if(hi[i]-lo[i]>hi[axis]-lo[axis])axis=i;
    idx.sort(function(a,b){return all[a].center[axis]-all[b].center[axis];});var half=idx.length>>1;
    node.left=tree(all,idx.slice(0,half));node.right=tree(all,idx.slice(half));return node;
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
  // The distance to triangle t along the ray, or -1: the caller keeps a contact only beyond EPS. No object per triangle.
  function intersect(t,o,d){
    var e1=t.e1,e2=t.e2,hx=d[1]*e2[2]-d[2]*e2[1],hy=d[2]*e2[0]-d[0]*e2[2],hz=d[0]*e2[1]-d[1]*e2[0];
    var det=e1[0]*hx+e1[1]*hy+e1[2]*hz;if(Math.abs(det)<1e-10)return -1;
    var sx=o[0]-t.a[0],sy=o[1]-t.a[1],sz=o[2]-t.a[2],u=(sx*hx+sy*hy+sz*hz)/det;if(u<-1e-8||u>1+1e-8)return -1;
    var qx=sy*e1[2]-sz*e1[1],qy=sz*e1[0]-sx*e1[2],qz=sx*e1[1]-sy*e1[0],v=(d[0]*qx+d[1]*qy+d[2]*qz)/det;if(v<-1e-8||u+v>1+1e-8)return -1;
    return (e2[0]*qx+e2[1]*qy+e2[2]*qz)/det;
  }
  // THE CONTACTS OF ONE RAY WITHOUT GARBAGE (28.09, steady-60: ~1.5 KiB of objects a ray made 4-9 collections in 4 s of
  // emulation). An engine keeps one buffer: the distance, the cosine and the triangle's index of every contact, and an
  // order over them; a cast refills it. `hits` (optional): the contact objects of a caller that brought its own (evaluate).
  function Contacts(cap){this.n=0;this.cap=0;this.hits=null;this.grow(cap||32);}
  Contacts.prototype.grow=function(cap){
    var d=new Float64Array(cap),c=new Float64Array(cap),t=new Int32Array(cap);
    if(this.n){d.set(this.dist.subarray(0,this.n));c.set(this.cos.subarray(0,this.n));t.set(this.tri.subarray(0,this.n));}
    this.dist=d;this.cos=c;this.tri=t;this.order=new Int32Array(cap);this.cap=cap;
  };
  // The walk's per-key marks (seen at a distance, collide-once spent), stamped with a generation per walk: no clearing.
  Contacts.prototype.keys=function(count){if(this.seenGen&&this.seenGen.length>=count)return;count=Math.max(1,count);this.seenGen=new Int32Array(count);this.seenDist=new Float64Array(count);this.ignGen=new Int32Array(count);this.gen=0;};
  Contacts.prototype.stamp=function(){if(++this.gen>1e9){this.seenGen.fill(0);this.ignGen.fill(0);this.gen=1;}return this.gen;};
  Contacts.prototype.push=function(distance,cos,ti){if(this.n===this.cap)this.grow(this.cap*2);var k=this.n++;this.dist[k]=distance;this.cos[k]=cos;this.tri[k]=ti;};
  // Every contact of the ray, cut off past the nearest MAIN armour met so far (st.best): walk() below stops at
  // the first main plate, so nothing behind it can change the result, and a box the ray enters beyond it is
  // skipped. The condition that moves st.best is exactly walk()'s exit - armour with a value and a damage
  // factor - so a plate walk() would pass (no armour table, armour null) never cuts anything. A contact at x
  // lies inside every box above it (each is entered at or before x), so the kept contacts are the ones the
  // full walk would have found up to best, in the same order; the stable sort leaves them as they were.
  // Keep this condition and walk()'s exits in step.
  // The cut-off keeps a box entered within TIE of best: a surface coincident with that plate is still met, whatever order
  // the tree is walked in, and the sort below puts the pair in the order of their material ids.
  // A leaf lists its triangles' indices in `idx` (fromTriangles), which the contacts keep.
  function collisions(node,o,d,C,st,tris){
    if(!node)return;var near=intersectsBox(node,o,d);if(near<0||near>st.best+TIE)return;
    if(node.idx){var idx=node.idx;for(var i=0;i<idx.length;i++){var ti=idx[i],t=tris[ti],distance=intersect(t,o,d);if(distance>EPS){C.push(distance,Math.abs(dot(d,t.normal)),ti);var a=t.armor;
      if(a&&a.armor!=null&&a.vehicleDamageFactor>EPS&&distance<st.best)st.best=distance;}}}
    else{collisions(node.left,o,d,C,st,tris);collisions(node.right,o,d,C,st,tris);}
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
  // the aiming time. The after-shot term is the gun's afterShot unless the caller hands in the one the
  // client really takes for that round (shotTerm below: an automatic gun's controller, a burst's own
  // factor); dual accuracy is a factor on the whole ideal and the ✸ layer of the page applies it on `mult`.
  //
  // aimFactor() answers a question about one state: "the vehicle was in this state, then everything
  // stopped settledFor seconds ago". The factor decays from the ideal factor of that state towards
  // the resting one (mult, i.e. standing still, turret still, no shot); settledFor = 0 means the
  // shot is taken in the state itself. That is what the manual sliders ask and it stays as it was.
  // aimStep() below is the same formula integrated over real time instead, for the WASD emulation.
  // `afterShot` and `speed` (23.09, BACKLOG 37) are written by the ✸ layer of the page only, for a tier-XI mechanic in
  // force: the CS-67 Szakal's turbo stance takes the after-shot term ×1.66 (passiveTurboAfterShotDispersionDebuff),
  // and the Strv 107-12's pillbox stops the vehicle (dynAttrs/vehicle/maxSpeed/forward ×0). Every other caller leaves
  // them out and gets 1. ZERO_MODS: the factors a mechanic may really set to nothing - the XM69's gyro and the Black
  // Rock's Burst mode take the movement, hull and turret terms ×0.0 - where for every other key 0 means "not given".
  // `forwardSpeed` and `backwardSpeed` (23.09): a rocket booster's own caps of the forward and the reverse speed
  // (rocketAcceleration: vehicle/maxSpeed/forward x1.5, backward x0.1 on the BZ-176), where `speed` takes both at once.
  // `afterShotField` (23.09): the field modification's factor of miscAttrs gunShotDispersionFactorsAfterShot, the
  // page's Config block. CLIENT RULE (Avatar.getOwnVehicleShotDispersionAngle 3310-3318): only the plain after-shot
  // term (withShot 1) reads that copy; an automatic gun's controller term and a burst's afterShotInBurst (the gun
  // component's own) never do - so it goes on the recorded afterShot alone, never on a shotTerm handed in.
  // `gunSpeed` (26.09): the gun's elevation speed, gun/rotationSpeed - the gunner scales it with the turret's
  // (VehicleDescrCrew._updateGunnerFactors); no device of the page's catalogue touches it.
  var NO_MODS={mult:1,additive:1,movement:1,rotation:1,turret:1,aimingTime:1,turretSpeed:1,hullSpeed:1,reload:1,magazineReload:1,afterShot:1,afterShotField:1,speed:1,forwardSpeed:1,backwardSpeed:1,gunSpeed:1};
  var ZERO_MODS={movement:1,rotation:1,turret:1,speed:1};
  function aimMods(mods){
    var out={},keys=Object.keys(NO_MODS);
    for(var i=0;i<keys.length;i++){
      var v=mods?Number(mods[keys[i]]):NaN;
      out[keys[i]]=isFinite(v)&&(v>0||(v===0&&ZERO_MODS[keys[i]]&&mods[keys[i]]!==null&&mods[keys[i]]!==''))?v:NO_MODS[keys[i]];
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
    // s.shotTerm replaces afterShot for this state (shotTerm below); s.hold keeps it in the formula between two
    // rounds, as an automatic gun's controller does. Neither given: exactly the term of every earlier build.
    if(typeof s.shotTerm==='number'&&s.shotTerm>=0)cs=s.shotTerm;
    else cs*=m.afterShotField;
    cs*=m.afterShot;
    var v=Math.abs(Number(s.speed)||0),w=Math.abs(Number(s.hullTurn)||0),wt=Math.abs(Number(s.turretTurn)||0);
    var sum=(v*cm)*(v*cm)+(w*cr)*(w*cr)+(wt*ct)*(wt*ct)+(s.afterShot||s.hold?cs*cs:0);
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
    return aimFactor(aim,{speed:s.speed,hullTurn:s.hullTurn,turretTurn:s.turretTurn,afterShot:!!afterShot,shotTerm:s.shotTerm,hold:!!s.hold},mods);
  }
  // THE AFTER-SHOT TERM OF ONE ROUND. CLIENT RULE, Avatar.getOwnVehicleShotDispersionAngle 3310-3318
  // (docs/KNOWLEDGE.md section 6), three branches:
  //   - a vehicle with an AutoShootGunController (aim.autoShoot, the automatic guns): the controller's own
  //     factor in every frame, min(dispersionFactor + (t - updateTime)·shotDispersionPerSec, maxShotDispersion),
  //     and afterShot is not used at all. After n rounds of one stream of fire that is n·shotDispersionPerShot
  //     (perSec ≈ perShot × the rate: derived), so `hold` says the term stays between the rounds;
  //   - withShot 2, a round of a burst that still has rounds after it (vehicle_extras.ShowShooting):
  //     afterShotInBurst, which the record carries only where it differs from afterShot;
  //   - withShot 1, every other round: afterShot.
  // `rounds` is the n of an automatic gun's stream (1 for its first round), `inBurst` that more rounds of the
  // burst follow this one. Returns {term, hold}.
  function shotTerm(aim,rounds,inBurst){
    var a=aim||{},auto=a.autoShoot,per=auto?Number(auto.shotDispersionPerShot):0;
    if(per>0){
      var cap=Number(auto.maxShotDispersion)>0?Number(auto.maxShotDispersion):Infinity,n=Math.max(1,Math.floor(Number(rounds)||1));
      return {term:Math.min(n*per,cap),hold:true};
    }
    if(inBurst&&a.afterShotInBurstFactor>=0)return {term:Number(a.afterShotInBurstFactor),hold:false};
    return {term:a.afterShotFactor>0?a.afterShotFactor:0,hold:false};
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
  // root (gun.shotDispersionFactors['afterShot'], or the term shotTerm gives the round, handed in as
  // state.shotTerm), so the ideal factor AT THE INSTANT OF THE SHOT is computed with that term and the
  // exponential restarts from it - or from the current factor when the circle was still wider than
  // that, because the client never shrinks the circle instantly. With state.hold the term stays in the
  // ideal after the shot too (an automatic gun firing on).
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
  // MAG MASTERY (tankmen.xml loader_magMastery, magazineGunReloadSpeed -0.00025 a level; perks.xml 408) shortens
  // the reload of the WHOLE MAGAZINE, and only of a magazine gun that is neither an autoloader nor an automatic
  // one: the garage multiplies it into the reload in gui params __calcReloadTime 1401-1405 and
  // __calcClipFireRate 1419-1423 (checked 23.09, docs/KNOWLEDGE.md section 17). Until 23.09 the page shortened
  // the interval between the rounds instead, which the client never does - the interval is the gun's own.
  // `magazine` says whether this gun is one Mag Mastery works on, so a caller that orders the factors its own
  // way (the characteristics panel, web/ttx.js) reads the rule here instead of deciding it a second time.
  function magazineGun(aim,shots){
    if(!(shots>1))return false;
    var tags=Array.isArray(aim.gunTags)?aim.gunTags:[];
    return !aim.autoreload&&tags.indexOf('autoreload')<0&&!aim.autoShoot&&tags.indexOf('autoShoot')<0;
  }
  function reloadSeconds(aim,mods){
    if(!aim||!(aim.reloadTime>0))return null;
    var m=aimMods(mods),clip=aim.clip,burst=aim.burst;
    var shots=clip&&clip.length>1&&clip[0]>1?Math.floor(clip[0]):1,magazine=magazineGun(aim,shots);
    return {reload:aim.reloadTime*(aim.reloadTimeFactor>0?aim.reloadTimeFactor:1)*m.reload*(magazine?m.magazineReload:1),
      magazine:magazine,shots:shots,interval:shots>1&&clip[1]>0?clip[1]:0,
      burst:burst&&burst.length>1&&burst[0]>1?{count:Math.floor(burst[0]),interval:burst[1]>0?burst[1]:0,sync:!!burst[2]}:null};
  }
  // An autoloader's per-round times, scaled by the factors of the reload, in the tuple's own order (the LAST entry
  // is the first round into an empty magazine, KNOWLEDGE section 4) - or null when the gun is no autoloader or the
  // record lacks the times. The client multiplies each entry by the factor of getReloadTime (items/utils
  // getClipReloadTime), which is rl.reload / aim.reloadTime here: the rammer and the loader, never Mag Mastery,
  // which spares an autoloader. One helper for the two readers - the emulation's real reload and the
  // characteristics panel - so the scaling is written once.
  function autoreloadScaled(aim,rl){
    var list=aim&&aim.autoreload&&aim.autoreload.reloadTime;
    if(!rl||!Array.isArray(list)||!list.length||!(aim.reloadTime>0))return null;
    var k=rl.reload/aim.reloadTime,out=[],i,v;
    for(i=0;i<list.length;i++){v=Number(list[i]);if(!(v>0))return null;out.push(v*k);}
    return out;
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
  // THE SHOOTER'S TOP MOTION with this build and the mode in force - one owner for the WASD model below, the turret chase
  // and the page's manual motion (26.09), which sets its sliders' ranges from it. m/s and rad/s, 0 = no data.
  // A turbocharger and the Mobility Improvement System raise the CAP the vehicle accelerates to
  // (optional_devices.xml forwardMaxSpeedKMHTerm / backwardMaxSpeedKMHTerm), which makes the movement
  // term BIGGER, not smaller - the honest answer. The page hands the terms in already converted to the
  // m/s the record uses. A vehicle whose record carries no speed at all gains nothing: 0 means no data,
  // and a term on top of it would be an invented speed.
  // m.speed: a tier-XI mode that caps the vehicle's speed outright (the Strv 107-12's pillbox, ×0), 1 otherwise. The
  // brake keeps the vehicle's own rate (forwardCap, backCap), so a vehicle rolling when the cap drops comes to a stop
  // instead of coasting. `turret`: the turret's top speed relative to the hull (turretChase below).
  function motionLimits(aim,mods){
    var m=aimMods(mods),a=aim||{};
    var forwardCap=a.speedForward>0?Math.max(0,a.speedForward+term(mods&&mods.speedForwardAdd)):0;
    var backCap=a.speedBackward>0?Math.max(0,a.speedBackward+term(mods&&mods.speedBackwardAdd)):0;
    return {forward:forwardCap*m.speed*m.forwardSpeed,back:backCap*m.speed*m.backwardSpeed,forwardCap:forwardCap,backCap:backCap,
      hull:(a.hullRotationSpeed>0?a.hullRotationSpeed:0)*m.hullSpeed,turret:(a.turretRotationSpeed>0?a.turretRotationSpeed:0)*m.turretSpeed};
  }
  function moveStep(prev,keys,aim,mods,dt){
    var k=keys||{},s=prev||{};
    var step=Math.max(0,Math.min(.25,Number(dt)||0));
    var lim=motionLimits(aim,mods),forwardCap=lim.forwardCap,backCap=lim.backCap;
    var forward=lim.forward,back=lim.back,hullMax=lim.hull;
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
    var rate=rising?(goal>0?forward/accel:back/accelBack):Math.max(forwardCap,backCap)/brake;
    speed=approach(speed,goal,Math.max(0,rate)*step);
    var hullTarget=k.left&&!k.right?-hullMax:k.right&&!k.left?hullMax:0;
    // THE AUTOROTATION (23.09, the page's ✸ layer): a virtual key with no A or D held - `auto` is the signed angle the
    // cursor lies past the gun's sector, right positive. The hull turns towards it with the keys' own ramp, and never by
    // more in a step than is left, so it does not overshoot; `autoStop` (the step after it got there) stops it at once.
    var auto=!k.left&&!k.right?Number(k.auto)||0:0;
    if(auto)hullTarget=auto>0?hullMax:-hullMax;
    hullTurn=approach(hullTurn,hullTarget,(hullMax>0?hullMax/turn:0)*step);
    if((auto||k.autoStop)&&!k.left&&!k.right){var most=step>0?Math.abs(auto)/step:0;if(Math.abs(hullTurn)>most)hullTurn=hullTurn<0?-most:most;}
    return {speed:speed,hullTurn:hullTurn,forward:forward,back:back,hullMax:hullMax,
      resting:Math.abs(speed)<1e-3&&Math.abs(hullTurn)<1e-4&&target===0&&hullTarget===0};
  }
  // The turret chasing the cursor. CLIENT RULE: turret.rotationSpeed is the turret's speed RELATIVE
  // TO THE HULL, and the gunner's crew factor scales it (VehicleDescrCrew._updateGunnerFactors sets
  // factors['turret/rotationSpeed'] = f). OUR APPROXIMATION is what the turret spends that speed on:
  // while the hull turns, holding the aim already costs |hullTurn| of the budget, so only what is
  // left chases the cursor - which is why turretTurn is never below |hullTurn| while A or D is held,
  // and why a fast hull rotation can make the gun fall behind the cursor altogether.
  // `gap` is how far the gun is from where it can point at the cursor, in radians: {yaw, pitch} - the turn about
  // the world's up axis and the elevation (viewer.aimGap) - or a bare number, which is a yaw alone.
  // CLIENT RULE (26.09, fields audit P2): the gun rotator moves the two apart - the yaw at the turret's speed
  // (getNextTurretYaw), the pitch at the gun's own elevation speed gun.rotationSpeed (getNextGunPitch, the server's
  // maxGunRotationSpeed: the same with the gunner's factor) - and the circle's turret term is |d yaw| / dt ALONE
  // (VehicleGunRotator.__rotate: turretRotationSpeed = |estimatedTurretYaw - prevTurretYaw| / timeDiff). So a cursor
  // going straight up blooms nothing (×1.0; the full angle at the turret's speed gave ×1.41 at 10 °/s with a factor of
  // 0.1 per °/s), and the pitch only takes its time. A block without gunPitchSpeed (a record before 26.09 the
  // exporter could not complete) moves the pitch at once, as a block without a turret speed moves the gun at once:
  // no invented speed, and the circle is the same either way. `pitchStep` is the elevation of this frame.
  function turretChase(gap,hullTurn,aim,mods,dt,swung){
    var m=aimMods(mods),limit=motionLimits(aim,mods).turret;
    var step=Math.max(1e-4,Math.min(.25,Number(dt)||0)),hull=Math.abs(Number(hullTurn)||0);
    var yaw=Math.max(0,Number(gap&&typeof gap==='object'?gap.yaw:gap)||0),pitch=Math.max(0,Number(gap&&typeof gap==='object'?gap.pitch:0)||0);
    var up=(aim&&aim.gunPitchSpeed>0?aim.gunPitchSpeed:0)*m.gunSpeed,pitchStep=up>0?Math.min(pitch,up*step):pitch;
    var pitchCaught=pitchStep>=pitch-1e-12,want=yaw/step,out;
    // No turret speed in the record: the gun is simply where the cursor is, and the formula sees the
    // hull's own rotation only. Better than pretending the turret cannot move at all.
    if(!(limit>0))out={rate:want,turretTurn:hull,step:yaw,caught:true};
    // `swung`: the caller has ALREADY carried the aim point around with the hull (stage 6, user 20.09),
    // so the gap handed in contains the hull's own turn. The whole relative budget is then free to close
    // it, and the relative turret speed - the one the dispersion formula asks for - is exactly the rate
    // the gun is pulled back at. Holding the aim against a turning hull therefore still costs |hullTurn|
    // of the budget and leaves limit - |hullTurn| to gain on the cursor, as it did before; counting the
    // hull twice would instead push the ring away faster than the turret could ever fetch it back.
    else if(swung){var rel=Math.min(want,limit);out={rate:rel,turretTurn:rel,step:rel*step,caught:rel>=want-1e-9};}
    else{var budget=Math.max(0,limit-hull),rate=Math.min(want,budget);out={rate:rate,turretTurn:Math.min(limit,hull+rate),step:rate*step,caught:rate>=want-1e-9};}
    out.pitchStep=pitchStep;out.caught=out.caught&&pitchCaught;
    return out;
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
      // Client rule since 9.3: AP and APCR lose 25 % after a ricochet (client 2.4.0.1 armor_inspector.mo), HEAT keeps all.
      // traceRicochet: the shell's enableTraceRicochet (client default True); false on 28 client shells (AAAC, Charlie 3/
      // Delta 6, JPNh, PG70) - the shell is lost at its first ricochet. A record without the key keeps the default.
      ricochetLoss:ap?.25:0,traceRicochet:true};
  }
  // ---- Penetration and damage over the flight distance -----------------------------------------------------
  // The client has ONE law for both (helpers_common.computePiercingPowerAtDist and computeDamageAtDist, 2.4.0.1:
  // max(0, interpolateLinearly(dist, 50, 500, v0, v1, limitLower=True, limitUpper=False))): the first value up to
  // 50 m, then the line through the second value at 500 m, which goes ON past 500 m and stops at 0. This is the
  // page's only copy: the verdicts, the shell choice, the Statistics log and the characteristics panel all take
  // their figures at a distance from here. A missing second value keeps the first.
  var DIST_FIRST=50,DIST_LAST=500;
  function atDistance(near,far,distance){
    if(!(distance>DIST_FIRST)||!(far>=0)||far===near)return near;
    return Math.max(0,near+(distance-DIST_FIRST)*(far-near)/(DIST_LAST-DIST_FIRST));
  }
  // A recorded shell's penetration at `distance` metres of flight, as the client's reticle has it
  // (gun_marker_ctrl.computePiercingPowerAtDist): the law above over penetration100/penetration500 - the XML pair
  // at up to 50 m and at 500 m, the names are historical - and 0 from the shot's maxDistance on, where the shell
  // flies no further (computeShotMaxDistance: at most 720 m, less where the damage or the penetration reach 0).
  function penetrationAt(c,distance){
    var p0=Number(c&&c.penetration100),p1=Number(c&&c.penetration500);
    if(!(p0>0))return p0;
    if(distance>DIST_FIRST&&c.maxDistance>0&&distance>=c.maxDistance)return 0;
    return atDistance(p0,p1>0?p1:p0,distance);
  }
  // A recorded shell's alpha at `distance`: the same law over alpha/alphaFar (armorDamage). The two differ only
  // on the 18 Polish smoothbore APCR shells (damageMutable: Grom, Kilana, Husarz, Gonkiewicza, Błyskawica, Bzyg);
  // every other shell, and a record without alphaFar, keeps its alpha at every distance.
  function alphaAt(c,distance){
    var a0=Number(c&&c.alpha),a1=Number(c&&c.alphaFar);
    return a0>0&&a1>0?atDistance(a0,a1,distance):a0;
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
  // Split in two (28.09) so the lean ray below takes the damage without an object: the law's name and its figure.
  function npLaw(s){
    if(s.kind!=='HIGH_EXPLOSIVE')return 'none';
    if(s.mechanics!=='MODERN'||!(s.spallDamage>0))return 'legacy-unknown';
    // armorSpalls/damageAbsorption (one shell in the client, the Taschenratte ability gun): the recorded series of
    // the Reddit study fit neither law (45 HP measured on 200 mm, 11 by the ratio law), so it stays unmodelled.
    if(s.spallAbsorption!==null&&s.spallAbsorption!==undefined)return 'special-unknown';
    return 'ratio';
  }
  function npDamage(s,nominal){
    var law=npLaw(s);
    if(law==='none')return s.nonPiercingArmorDamage>0?s.nonPiercingArmorDamage:0;
    if(law!=='ratio')return 0;
    return s.spallDamage*Math.min(1,.1*s.spallDamage/Math.max(EPS,nominal*(s.liner>0?s.liner:1)));
  }
  function nonPenetration(s,nominal){return {damage:npDamage(s,nominal),law:npLaw(s)};}
  // E = p·α + (1−p)·D_np on main armour; 0 where the shell never reaches it (ricochet, screen, fly-past).
  // One penetration roll serves the whole shot: the shell passes a screen when the roll beats the screen's own
  // plate, pierces the hull when the roll less 3x the screens beats the main plate. Non-penetration damage needs
  // the first without the second, so its weight is P(pass every screen) - p, not 1 - p. A shell stopped by a
  // screen explodes there and deals nothing (client reticle __shotResultModernHE, WG 1.13: "will not cause any
  // damage at all"), which is why a gun mantlet screen so often eats a whole HE shell.
  function expectedOf(chanceValue,screenPass,s,np){
    var p=chanceValue===null||chanceValue===undefined?null:clamp(chanceValue/100,0,1),pass=screenPass===undefined||screenPass===null?1:screenPass;
    return p===null?null:p*s.alpha+Math.max(0,pass-p)*np;
  }
  function withDamage(r,s){
    if(r.reason==='penetration'){
      var np=npDamage(s,r.nominal);
      r.alpha=s.alpha;r.nonPen=np;r.damageLaw=npLaw(s);
      r.expected=expectedOf(r.chance,r.screenPass,s,np);
      r.expectedShare=r.expected===null?null:clamp(r.expected/s.alpha,0,1);
    }else if(r.reason==='ricochet'||r.reason==='screen'||r.reason==='no-hull'){r.expected=0;r.expectedShare=0;}
    return r;
  }
  // The same for the lean result: `expected` alone, undefined where withDamage leaves it out.
  function leanDamage(out,s){
    out.expected=undefined;
    if(!(s&&s.alpha>0))return out;
    if(out.reason==='penetration')out.expected=expectedOf(out.chance,out.screenPass,s,npDamage(s,out.nominal));
    else if(out.reason==='ricochet'||out.reason==='screen'||out.reason==='no-hull')out.expected=0;
    return out;
  }
  // `start`: the penetration the shell has left on entering this walk, when it is not the nominal - the leg after a
  // ricochet (engine.bounced). s.penetration stays the walk's NOMINAL: the scale of the chance and of `effective`.
  // `hits`: {distance, triangle, cos} in the order to walk them (the engine sorts its own; this entry does not).
  function evaluate(hits,s,start){
    var n=hits.length,C=new Contacts(Math.max(1,n)),tris=new Array(n),keys=new Int32Array(n),keyOf=new Map();
    for(var k=0;k<n;k++){var h=hits[k],t=h.triangle,key=t.part+':'+t.name,id=keyOf.get(key);if(id===undefined){id=keyOf.size;keyOf.set(key,id);}
      C.push(h.distance,h.cos,k);tris[k]=t;keys[k]=id;}
    for(k=0;k<n;k++)C.order[k]=k;
    C.hits=hits;C.keys(keyOf.size);
    var r=walk(C,s,start,undefined,false,keys,tris,null);
    return s&&s.alpha>0?withDamage(r,s):r;
  }
  function known(x){return typeof x==='number'&&isFinite(x);}
  // What the leg after a ricochet starts with (variant B): (1 - loss) x what the first leg had left there, never below
  // zero - screens thicker than the shell leave it nothing to carry (review 26.09 D1: a negative remainder used to read
  // as "unknown" and restart the leg from 0.75 x P). Unknown (no number): the nominal. The GPU leg clamps the same way.
  function carried(s,remaining){return (known(remaining)?Math.max(0,Math.min(remaining,s.penetration)):s.penetration)*(1-(s.ricochetLoss||0));}
  // Every result carries `remaining`: what the shell had left on reaching the contact it ended on (a ricochet, the main
  // plate - before that plate) or after its last screen (no-hull). The leg after a ricochet starts from it.
  // THE WALK over the contacts C in C.order (28.09: over the engine's buffers, see Contacts): `nominal` is the leg's
  // nominal penetration (the shell's, or (1 - loss) x it after a ricochet - engine.bounced; undefined: the shell's) and
  // `ricocheted` says this leg follows a ricochet. keys[ti]: the triangle's part:material as a number - a duplicate contact
  // and a collide-once body are recognised by it, as by the string before. `out`: the engine's lean result, written in place
  // with chance and reason (and what the caller needs next) and no layers; null: a fresh full result, as it always was.
  function walk(C,s,start,nominal,ricocheted,keys,tris,out){
    if(nominal===undefined)nominal=s&&s.penetration;
    if(!s||!(nominal>0)||!(s.caliber>0)){if(out){out.chance=null;out.reason='parameters';return out;}return {chance:null,reason:'parameters',layers:[]};}
    // `start` unknown is the absence of a number, never its sign: a leg after a ricochet may start with nothing left.
    var remaining=known(start)?start:nominal,layers=out?null:[],jet=false,jetStart=0,jetRate=0,screenPass=1,gen=C.stamp();
    var final=!!ricocheted||!!s.ricocheted||s.traceRicochet===false,seenGen=C.seenGen,seenDist=C.seenDist,ignGen=C.ignGen;
    for(var p=0;p<C.n;p++){
      var k=C.order[p],distance=C.dist[k],ti=C.tri[k],t=tris[ti],a=t.armor,key=keys[ti];
      if(seenGen[key]===gen&&Math.abs(distance-seenDist[key])<EPS)continue;
      seenGen[key]=gen;seenDist[key]=distance;
      if(ignGen[key]===gen)continue;
      if(!a){if(out){out.chance=null;out.reason='armor';return out;}return {chance:null,reason:'armor',layers:layers};}
      if(a.armor===null||a.armor===undefined)continue;
      var cos=a.useHitAngle?C.cos[k]:1;
      // final: the shell is lost here - a second ricochet, or a shell that never flies on (traceRicochet false).
      if(!jet&&ricochet(a,cos,s)){
        if(out){out.chance=0;out.reason='ricochet';out.nominal=a.armor;out.final=final;out.remaining=remaining;out.hitK=k;return out;}
        return {chance:0,reason:'ricochet',layers:layers,nominal:a.armor,angle:Math.acos(clamp(cos,0,1))/RAD,distance:distance,
          hit:C.hits?C.hits[k]:{distance:distance,triangle:t,cos:C.cos[k]},final:final,remaining:remaining};
      }
      // HEAT after the first screen: the jet loses a fixed share of the penetration it had behind that screen per
      // metre flown (client: 0.5/m), linearly along the whole way to the armour. A later screen only subtracts its own
      // plate; it never restarts the decay (user, 19.09: a second screen in the same gap used to raise the chance).
      if(jet)remaining=Math.max(0,remaining-jetRate*Math.max(0,distance-jetStart));
      var plate=effective(a,cos,s),main=a.vehicleDamageFactor>EPS,angle;
      // `distance` along this leg and the struck facet's `normal` (a reference, never copied) say WHERE the plate was
      // met: the Hitmarks lay one mark at every plate of the verdict's own path from them, with no second ray.
      if(layers){angle=Math.acos(clamp(cos,0,1))/RAD;layers.push({part:t.part,material:t.name,nominal:a.armor,effective:plate,angle:angle,main:main,distance:distance,normal:t.normal});}
      if(main){
        var odds=chance(remaining,plate,nominal,s.randomization,s.randomizationType);
        if(out){out.chance=odds;out.reason='penetration';out.nominal=a.armor;out.screenPass=screenPass;out.remaining=remaining;return out;}
        return {chance:odds,reason:'penetration',effective:nominal-remaining+plate,nominal:a.armor,angle:angle,layers:layers,distance:distance,screenPass:screenPass,remaining:remaining};
      }
      if(s.kind==='HIGH_EXPLOSIVE'){
        if(!s.shieldPenetration){if(out){out.chance=0;out.reason='screen';return out;}return {chance:0,reason:'screen',layers:layers,distance:distance};}
        // Chance that the shell gets through this screen at all (its own plate against the penetration left); the
        // thresholds of successive screens nest, so the smallest chance is the chance to pass them all.
        var through=chance(remaining,plate,nominal,s.randomization,s.randomizationType);
        if(through!==null)screenPass=Math.min(screenPass,through/100);
        if(layers)layers[layers.length-1].through=through; // which screen a shell stopped short of the hull died on (Hitmarks)
        remaining-=plate*3; // Modern HE shield penalty
      }else remaining-=plate;
      if(a.collideOnceOnly)ignGen[key]=gen;
      jet=s.jetLossPerMeter>0;
      if(jet){jetStart=distance+a.armor*.001;if(!jetRate)jetRate=remaining*s.jetLossPerMeter;}
    }
    if(out){out.chance=0;out.reason='no-hull';out.screenPass=screenPass;out.remaining=remaining;return out;}
    return {chance:0,reason:'no-hull',layers:layers,screenPass:screenPass,remaining:remaining};
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
    var lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],idx=new Int32Array(tris.length);
    tris.forEach(function(t,k){idx[k]=k;for(var i=0;i<3;i++){lo[i]=Math.min(lo[i],t.min[i]);hi[i]=Math.max(hi[i],t.max[i]);}});
    return {min:lo,max:hi,idx:idx};
  }
  // By distance; contacts within TIE of the first of a run are one depth and go by material id (stable within one id).
  // Before 26.09 a tie went by the order the tree was walked in: coincident plates of two materials (a track face in
  // the plane of a side plate) could come either way round, and CPU and GPU could disagree. Insertion sorts over C.order
  // (28.09, no arrays per ray): stable, so the order is the one the stable Array sort gave - a ray meets a handful of faces.
  function sortContacts(C,mats){
    var n=C.n,o=C.order,d=C.dist,tri=C.tri,i,j,x,m;
    for(i=0;i<n;i++)o[i]=i;
    for(i=1;i<n;i++){x=o[i];j=i-1;while(j>=0&&d[o[j]]>d[x]){o[j+1]=o[j];j--;}o[j+1]=x;}
    for(i=0;i<n;){
      j=i+1;while(j<n&&d[o[j]]-d[o[i]]<=TIE)j++;
      for(var a=i+1;a<j;a++){x=o[a];m=mats[tri[x]];var b=a-1;while(b>=i&&mats[tri[o[b]]]>m){o[b+1]=o[b];b--;}o[b+1]=x;}
      i=j;
    }
  }
  function unitInto(out,v){var n=Math.sqrt(dot(v,v));if(n>EPS){out[0]=v[0]/n;out[1]=v[1]/n;out[2]=v[2]/n;}else{out[0]=0;out[1]=0;out[2]=0;}return out;}
  function fromTriangles(tris,flat){
    var acceleration=flat?leaf(tris):tree(tris,tris.map(function(t,i){return i;}));
    // THE material id of every part:material (review 26.09 R4: one owner), in the order they first appear; triangles
    // with armour null take none. It orders contacts that tie in distance here, and the GPU surface takes the same ids
    // from engine.materialId (Surface.update) for its peel and bounced leg - so both sides break a tie alike.
    var order=Object.create(null),count=0;
    tris.forEach(function(t){var key=t.part+':'+t.name;if(order[key]===undefined&&!(t.armor&&t.armor.armor===null))order[key]=count++;});
    function materialId(t){return order[t.part+':'+t.name];}
    // By triangle index (28.09): its part:material as a number (keys: the walk's duplicate and collide-once rules) and its
    // material id for ties (mats; `count` for one without). Fixed at build, as the string lookups they replace were.
    var n=tris.length,keys=new Int32Array(n),mats=new Int32Array(n),keyOf=new Map();
    for(var i=0;i<n;i++){var t=tris[i],key=t.part+':'+t.name,k=keyOf.get(key);if(k===undefined){k=keyOf.size;keyOf.set(key,k);}
      keys[i]=k;var m=order[key];mats[i]=m===undefined?count:m;}
    // The engine's scratch: the contact buffer, the cut-off, the lean result and its vectors. One thread uses an engine.
    var C=new Contacts(),st={best:Infinity},dir=[0,0,0],bdir=[0,0,0],bo=[0,0,0];
    var lean={chance:null,reason:'',expected:undefined,nominal:0,screenPass:1,remaining:0,final:false,hitK:-1};
    C.keys(keyOf.size);
    // One leg: every contact of the ray, cut off past its first main plate (collisions), walked from `start` against the
    // leg's `nominal`. `out`: the lean result (the direction normalised into scratch), else a full result as before.
    function cast(o,d,s,start,nominal,ricocheted,out){
      var u=out?unitInto(dir,d):unit(d);
      C.n=0;C.hits=null;st.best=Infinity;collisions(acceleration,o,u,C,st,tris);sortContacts(C,mats);
      var r=walk(C,s,start,nominal,ricocheted,keys,tris,out);
      if(out)return leanDamage(out,s);
      if(s&&s.alpha>0)withDamage(r,s);
      r.origin=o;r.direction=u;return r;
    }
    // materialId(triangle): its id, undefined for one that takes none; materialCount: how many ids there are.
    // flat: the one-leaf engine (packEngine hands it on, so the worker builds the same acceleration).
    var engine={triangles:tris,acceleration:acceleration,materialId:materialId,materialCount:count,flat:!!flat};
    // THE LEG AFTER A RICOCHET (user's decision 26.09, variant B of outputs/ricochet-second-leg-2026-09-26.md): the shell
    // flies on from the ricochet point with 75 % of what it had LEFT there - the first leg's screens stay spent -
    // remaining2 = (1 - ricochetLoss) * remaining1, and the chance is scaled by (1 - ricochetLoss) * P, P the shell's
    // penetration at this distance: exactly the pair the report's likelihood analysis took for B (analyze2.py
    // B_carried75: rem = 0.75*(P-S1)-S2, nom = 0.75*P). HEAT loses nothing (ricochetLoss 0). `remaining` unknown: the
    // nominal. The collide-once list starts afresh on this leg (a track met on both legs counts twice) - how the server
    // does it is not known (one recorded case, not informative). Used by the continuation below and by the Statistics
    // log's point after a recorded ricochet (verdicts above): one law for both. The leg's nominal and its "after a
    // ricochet" go to the walk as they are (28.09): no copy of the shell.
    function bouncedLeg(o,d,s,remaining,out){
      if(!s||!(s.penetration>0)||!(s.caliber>0)){if(out){out.chance=null;out.reason='parameters';out.expected=undefined;return out;}return evaluate([],s);}
      return cast(o,d,s,carried(s,remaining),s.penetration*(1-(s.ricochetLoss||0)),true,out);
    }
    engine.bounced=function(o,d,s,remaining){return bouncedLeg(o,d,s,remaining,null);};
    engine.ray=function(o,d,s){
      if(!s||!(s.penetration>0)||!(s.caliber>0))return evaluate([],s);
      // A fresh cut-off for every ray, the second leg after a ricochet included (collisions above).
      var r=cast(o,d,s,undefined,s.penetration,false,null);d=r.direction;
      // Client rule since 9.3: after a ricochet the shell flies on along the mirrored direction (engine.bounced) and may
      // hit the same vehicle again; a second ricochet destroys it, and a shell with traceRicochet false is lost at the
      // first. The first-contact picture (heat map, GPU cross-check) passes ricochetContinue:false and stops here.
      if(r.reason==='ricochet'&&r.hit&&!r.final&&s.ricochetContinue!==false&&s.ricochetLoss!==undefined){
        var h=r.hit,n=h.triangle.normal,k=2*dot(d,n),out=unit([d[0]-k*n[0],d[1]-k*n[1],d[2]-k*n[2]]);
        var point=[o[0]+d[0]*h.distance,o[1]+d[1]*h.distance,o[2]+d[2]*h.distance];
        var second=engine.bounced([point[0]+out[0]*1e-3,point[1]+out[1]*1e-3,point[2]+out[2]*1e-3],out,s,r.remaining);
        // penetration: the leg's nominal (the scale its chance and `effective` are read against); remaining: what the
        // first leg had left at the ricochet; carried: what the second leg starts with.
        var keep=1-s.ricochetLoss;
        second.bounce={point:point,normal:n,direction:out,nominal:r.nominal,angle:r.angle,penetration:s.penetration*keep,remaining:r.remaining,
          carried:carried(s,r.remaining),shell:s.penetration,loss:s.ricochetLoss,layers:r.layers,part:h.triangle.part};
        return second;
      }
      return r;
    };
    // THE LEAN RAY (28.09, steady-60): the same cast, walk and continuation as engine.ray, for a caller that reads only
    // chance, expected and reason (the circle's integral) - no object, array or string per ray. The result is the engine's
    // own object, overwritten by the next lean ray. tests/test_ray_worker.cjs and the golden comparisons hold it to ray().
    engine.lean=function(o,d,s){
      if(!s||!(s.penetration>0)||!(s.caliber>0)){lean.chance=null;lean.reason='parameters';lean.expected=undefined;return lean;}
      var r=cast(o,d,s,undefined,s.penetration,false,lean);
      if(r.reason==='ricochet'&&r.hitK>=0&&!r.final&&s.ricochetContinue!==false&&s.ricochetLoss!==undefined){
        var dist=C.dist[r.hitK],n=tris[C.tri[r.hitK]].normal,k=2*dot(dir,n);
        bdir[0]=dir[0]-k*n[0];bdir[1]=dir[1]-k*n[1];bdir[2]=dir[2]-k*n[2];unitInto(bdir,bdir);
        // the ricochet point, then 1 mm off it along the new way - the arithmetic of engine.ray
        bo[0]=o[0]+dir[0]*dist;bo[1]=o[1]+dir[1]*dist;bo[2]=o[2]+dir[2]*dist;
        bo[0]=bo[0]+bdir[0]*1e-3;bo[1]=bo[1]+bdir[1]*1e-3;bo[2]=bo[2]+bdir[2]*1e-3;
        return bouncedLeg(bo,bdir,s,r.remaining,lean);
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
  // ---- The integral over a dispersion circle (moved here from viewer.js 28.09, steady-60: ONE source for the page and
  // for its worker) ------------------------------------------------------------------------------------------------------
  // ONE point of a circle: the radial quantile of the chosen profile at `u`, at `angle`, written into `out` - the very
  // arithmetic of three.js' center.clone().addScaledVector(right, r cos).addScaledVector(up, r sin) the viewer had, so the
  // points (and every figure over them) are the same to the bit. The integral walks `u` over the stratified (i+.5)/count
  // and the angle over the golden step; a random shot (viewer.liveAimSample) draws both - one law on the page.
  function circlePoint(out,center,right,up,radius,u,angle,quantile){
    var r=radius*quantile(u),a=r*Math.cos(angle),b=r*Math.sin(angle);
    out[0]=center[0]+right[0]*a+up[0]*b;out[1]=center[1]+right[1]*a+up[1]*b;out[2]=center[2]+right[2]*a+up[2]*b;
    return out;
  }
  function vec3(v){return [v[0],v[1],v[2]];}
  // THE SAMPLING MODEL OF A CIRCLE: `count` rays fanned over it at the quantiles of the chosen radial profile (a sunflower
  // spiral: the same count gives the same points), a miss counting as 0 % and 0 HP. Neither profile is a confirmed server
  // distribution; the page says so next to every figure. IN SLICES (27.09, frame-smoothness): step(until) casts rays in the
  // one fixed order until the clock passes `until` (performance.now() ms; Infinity: to the end) - at least one a call - and
  // returns the result once the last ray is in, else null; same rays, order and sums as one piece, so the same result to
  // the bit. The vectors are copied: the live ring's are replaced as it moves. `profile`: a profile id (the worker can take
  // the job) or a quantile function (main thread only).
  // IN THE WORKER (28.09, steady-60): post() hands the job to the page's worker, which runs this same step(Infinity) on the
  // same engine rebuilt there; step(until) then only waits for its answer (null until it lands) - 0 ms of rays on the main
  // thread. A worker that fails or never starts hands the job back to the slices here, from the first ray. step(Infinity)
  // always computes here: a caller that wants the figure now does not wait for a message.
  function CircleSampler(engine,shell,origin,center,right,up,radius,count,profile){
    var fn=typeof profile==='function';
    this.engine=engine;this.shell=shell;this.o=vec3(origin);this.center=vec3(center);this.right=vec3(right);this.up=vec3(up);
    this.radius=radius;this.count=count;this.q=fn?profile:aimProfile(profile).quantile;this.profile=fn?null:aimProfile(profile).id;
    this.i=0;this.sum=0;this.unknown=0;this.miss=0;this.dmg=0;this.result=null;this.remote=null;this.p=[0,0,0];this.dv=[0,0,0];
  }
  CircleSampler.prototype.step=function(until){
    if(this.result)return this.result;
    var job=this.remote;
    if(job&&until!==Infinity){
      if(job.result){this.result=job.result;this.remote=null;return this.result;}
      if(!job.failed&&!remoteStalled())return null;
      this.remote=null;   // the worker let it down: the slices below take it from the start
    }
    // The lean ray (engine.lean: chance, expected and reason, no garbage) where the engine has one; the same figures as ray().
    var count=this.count,shell=this.shell,center=this.center,right=this.right,up=this.up,radius=this.radius,o=this.o,p=this.p,dv=this.dv,en=this.engine,lean=!!en.lean;
    while(this.i<count){
      var i=this.i;circlePoint(p,center,right,up,radius,(i+.5)/count,i*2.399963229728653,this.q);
      dv[0]=p[0]-o[0];dv[1]=p[1]-o[1];dv[2]=p[2]-o[2];
      var hit=lean?en.lean(o,dv,shell):en.ray(o,[dv[0],dv[1],dv[2]],shell);
      if(hit.chance===null)this.unknown++;else this.sum+=hit.chance;
      if(hit.expected>0)this.dmg+=hit.expected;
      if(hit.reason==='no-hull')this.miss++;
      this.i=i+1;
      if(until!==Infinity&&this.i<count&&now()>=until)return null;
    }
    if(!this.result){var sum=this.sum,unknown=this.unknown,dmg=this.dmg;
      this.result={low:sum/count,high:(sum+unknown*100)/count,unknown:unknown,miss:this.miss/count*100,samples:count,
        damage:dmg/count,damageHigh:(dmg+unknown*((shell||{}).alpha||0))/count};}
    return this.result;
  };
  // Hand this job to the worker (no-op without one, with a quantile function, or once started here). Returns this.
  CircleSampler.prototype.post=function(){
    if(!this.profile||this.remote||this.i||this.result)return this;
    this.remote=remoteSend('circle',{shell:this.shell,o:this.o,center:this.center,right:this.right,up:this.up,radius:this.radius,count:this.count,profile:this.profile},this.engine);
    return this;
  };
  // THE VERDICTS AT A HIT'S RECORDED POINTS (the Statistics log; moved here from viewer.js Viewer.verdicts 28.09 so the
  // worker runs the same code). `pts`: {pos, line} as [x,y,z] plus the recorded fields copied onto each verdict. A point's
  // own ray comes from 60 m back along its line, so screens and the gun in front of it count as the server counted them.
  // The point after a recorded ricochet is the bounced leg of the one law (engine.bounced): from the ricochet point with
  // (1 - loss) times what our ray to it had left there - at our own ricochet there, at the main plate we met instead, or
  // after its screens - and a further ricochet ends it (outputs/ricochet-second-leg-2026-09-26.md §3.1).
  function verdicts(engine,pts,shell){
    if(!engine||!shell||!pts)return [];
    var out=[];
    for(var i=0;i<pts.length;i++){var p=pts[i],prev=i?pts[i-1]:null,afterRicochet=prev&&(prev.effect===1||prev.effect===2);
      var base=afterRicochet?prev.pos:p.pos,k=afterRicochet?.02:-60,l=p.line;
      var origin=[base[0]+l[0]*k,base[1]+l[1]*k,base[2]+l[2]*k];
      var r0=afterRicochet?out[i-1].result:null,before=r0?(r0.bounce?r0.bounce.remaining:r0.remaining):undefined;
      var result=null;try{result=afterRicochet?engine.bounced(origin,vec3(l),shell,before):engine.ray(origin,vec3(l),shell);}catch(e){result=null;}
      out.push({index:i,part:p.part,effect:p.effect,pi:p.pi,hitType:p.hitType,prevEffect:prev?prev.effect:null,source:p.source,chordDev:p.chordDev,result:result});}
    return out;
  }
  // ---- The engine and the models as flat arrays: what the worker gets, once per engine / model ---------------------------
  // The triangles in their order (so the worker's kd-tree and material ids come out the same), their corners as float64
  // (exact), and the part, material name and armour table of each by index into small lists. The armour tables go by
  // structured clone; one table shared by many triangles stays one object there too.
  function listIndex(list,map,value){var k=map.get(value);if(k===undefined){k=list.length;list.push(value);map.set(value,k);}return k;}
  function packEngine(engine){
    var tris=engine.triangles,n=tris.length,v=new Float64Array(n*9),t=new Int32Array(n*3),parts=[],names=[],armors=[],pm=new Map(),nm=new Map(),am=new Map();
    for(var i=0;i<n;i++){var tr=tris[i],o=i*9,c=[tr.a,tr.b,tr.c];
      for(var j=0;j<3;j++){v[o+3*j]=c[j][0];v[o+3*j+1]=c[j][1];v[o+3*j+2]=c[j][2];}
      t[i*3]=listIndex(parts,pm,tr.part);t[i*3+1]=listIndex(names,nm,tr.name);t[i*3+2]=tr.armor===undefined?-1:listIndex(armors,am,tr.armor);}
    return {v:v,t:t,parts:parts,names:names,armors:armors,flat:!!engine.flat};
  }
  function unpackEngine(pk){
    var v=pk.v,t=pk.t,n=t.length/3,tris=new Array(n);
    for(var i=0;i<n;i++){var o=i*9;
      tris[i]=triangle([v[o],v[o+1],v[o+2]],[v[o+3],v[o+4],v[o+5]],[v[o+6],v[o+7],v[o+8]],pk.parts[t[i*3]],pk.names[t[i*3+1]],t[i*3+2]<0?undefined:pk.armors[t[i*3+2]]);}
    return fromTriangles(tris,pk.flat);
  }
  function packModel(model){
    return {kind:model.kind,groups:(model.groups||[]).map(function(g){var vs=g.vertices||[],v=new Float64Array(vs.length*3);
      for(var i=0;i<vs.length;i++){v[3*i]=vs[i][0];v[3*i+1]=vs[i][1];v[3*i+2]=vs[i][2];}
      return {material:g.material,v:v,indices:Int32Array.from(g.indices||[])};})};
  }
  function unpackModel(pk){
    return {kind:pk.kind,groups:pk.groups.map(function(g){var v=g.v,vs=new Array(v.length/3);for(var i=0;i<vs.length;i++)vs[i]=[v[3*i],v[3*i+1],v[3*i+2]];
      return {material:g.material,vertices:vs,indices:g.indices};})};
  }
  // ---- The page's worker (28.09, steady-60) -------------------------------------------------------------------------------
  // CEF 109 from file:// (outputs/stack-env-2026-09-28.md): new Worker('x.js') is refused (origin null), a classic blob
  // worker runs, and inside it importScripts(file://…) works. So a two-line blob imports THIS file and serves. One worker,
  // made on the first job; the main thread keeps every job's own fallback. Engines and models are sent once each (the
  // engine when a job first names it, a model when a verdict job first needs it) and dropped past a few.
  var WORKER_WAIT=3000,WORKER_ENGINES=4,WORKER_MODELS=32;
  var remote={off:false,worker:null,ready:false,failed:false,born:0,seq:0,jobs:{},engines:[],models:[],modelIds:typeof WeakMap==='function'?new WeakMap():null};
  function remoteStalled(){return !remote.ready&&(remote.failed||now()-remote.born>WORKER_WAIT);}
  function remoteFail(){
    remote.failed=true;var w=remote.worker;remote.worker=null;if(w)try{w.terminate();}catch(e){}
    var jobs=remote.jobs;remote.jobs={};Object.keys(jobs).forEach(function(k){jobs[k].failed=true;if(jobs[k].done)jobs[k].done(jobs[k]);});
    if(typeof console!=='undefined')console.info('Bullba Hits ballistics: the worker is off, the main thread computes');
  }
  function remoteWorker(){
    if(remote.worker)return remote.worker;
    if(remote.off||remote.failed||root.BULLBA_NO_WORKER===true||!SELF_URL||typeof Worker!=='function'||typeof Blob!=='function'||typeof URL==='undefined'||!URL.createObjectURL)return null;
    try{
      var src='importScripts('+JSON.stringify(SELF_URL)+');ArmorBallistics.serve(self);';
      var w=new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})));
      w.onmessage=function(e){var m=e.data||{};if(m.type==='ready'){remote.ready=true;return;}var job=remote.jobs[m.id];if(!job)return;delete remote.jobs[m.id];
        if(m.error!==undefined){job.failed=true;job.error=m.error;}else job.result=m.result;if(job.done)job.done(job);};
      w.onerror=function(e){if(e&&e.preventDefault)e.preventDefault();remoteFail();};
      w.onmessageerror=function(){remoteFail();};
      remote.worker=w;remote.born=now();return w;
    }catch(e){remote.failed=true;return null;}
  }
  function remotePost(msg,transfer){var w=remoteWorker();if(!w)return false;try{w.postMessage(msg,transfer||[]);return true;}catch(e){return false;}}
  // The engine's id in the worker, sending it first when the worker has not got it; 0 when it cannot go.
  function remoteEngine(engine){
    if(!engine)return 0;if(engine.remoteId&&remote.engines.indexOf(engine.remoteId)>=0)return engine.remoteId;
    if(!remoteWorker())return 0;
    var id=++remote.seq,pk=packEngine(engine);
    if(!remotePost({type:'engine',id:id,engine:pk},[pk.v.buffer,pk.t.buffer]))return 0;
    engine.remoteId=id;remote.engines.push(id);
    while(remote.engines.length>WORKER_ENGINES)remotePost({type:'drop',id:remote.engines.shift()});
    return id;
  }
  function remoteModel(model){
    var id=remote.modelIds&&remote.modelIds.get(model);if(id&&remote.models.indexOf(id)>=0)return id;
    id=++remote.seq;var pk=packModel(model),buffers=[];pk.groups.forEach(function(g){buffers.push(g.v.buffer,g.indices.buffer);});
    if(!remotePost({type:'model',id:id,model:pk},buffers))return 0;
    remote.modelIds.set(model,id);remote.models.push(id);
    while(remote.models.length>WORKER_MODELS)remotePost({type:'dropModel',id:remote.models.shift()});
    return id;
  }
  // One job: {result, failed, done}; null when it cannot go (the caller computes it itself).
  function remoteSend(type,msg,engine){
    if(!remoteWorker())return null;
    if(engine){msg.engine=remoteEngine(engine);if(!msg.engine)return null;}
    var job={id:++remote.seq,result:null,failed:false,done:null};msg.type=type;msg.id=job.id;
    remote.jobs[job.id]=job;
    if(!remotePost(msg)){delete remote.jobs[job.id];return null;}
    return job;
  }
  // The verdicts of a scene the page does not show (the Statistics log's background pass): the flat engine is built in the
  // worker from the models it holds. A promise of the list, or null without a worker (the caller computes it itself).
  function remoteVerdicts(data,pts,shell){
    if(!remoteWorker()||!remote.modelIds)return null;
    var scene={parts:[],models:{}},parts=((data&&data.hit||{}).target||{}).parts||[];
    for(var i=0;i<parts.length;i++){var part=parts[i],model=data.models[String(part.id)];if(!model||!part.transform)continue;
      var mid=remoteModel(model);if(!mid)return null;scene.parts.push({id:part.id,transform:part.transform,armor:part.armor});scene.models[String(part.id)]=mid;}
    var job=remoteSend('verdicts',{scene:scene,points:pts,shell:shell});
    if(!job)return null;
    return new Promise(function(resolve,reject){job.done=function(j){if(j.failed)reject(new Error(j.error||'worker'));else resolve(j.result);};});
  }
  // The worker's side: the same functions over what the page sent.
  function serve(scope){
    var engines={},models={};
    scope.onmessage=function(e){var m=e.data||{},out;
      if(m.type==='engine'){engines[m.id]=unpackEngine(m.engine);return;}
      if(m.type==='drop'){delete engines[m.id];return;}
      if(m.type==='model'){models[m.id]=unpackModel(m.model);return;}
      if(m.type==='dropModel'){delete models[m.id];return;}
      try{
        if(m.type==='circle'){var en=engines[m.engine];if(!en)throw new Error('no engine '+m.engine);
          out=new CircleSampler(en,m.shell,m.o,m.center,m.right,m.up,m.radius,m.count,m.profile).step(Infinity);}
        else if(m.type==='verdicts'){var data={hit:{target:{parts:m.scene.parts}},models:{}};
          Object.keys(m.scene.models).forEach(function(k){var md=models[m.scene.models[k]];if(!md)throw new Error('no model '+m.scene.models[k]);data.models[k]=md;});
          out=verdicts(build(data,false,true),m.points,m.shell);}
        else throw new Error('unknown job '+m.type);
        scope.postMessage({id:m.id,result:out});
      }catch(err){scope.postMessage({id:m.id,error:String(err&&err.message||err)});}
    };
    scope.postMessage({type:'ready'});
  }
  // useWorker(false): every job on the main thread from now on (the fallback; tests measure both). useWorker(): the state.
  function useWorker(on){if(on===false){remote.off=true;if(remote.worker)remoteFail();remote.failed=false;}else if(on===true)remote.off=false;
    return {on:!remote.off&&!remote.failed,running:!!remote.worker,ready:remote.ready};}
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
  root.ArmorBallistics={TIE:TIE,build:build,fromTriangles:fromTriangles,triangle:triangle,subdivide:subdivide,evaluate:evaluate,shell:shell,atDistance:atDistance,penetrationAt:penetrationAt,alphaAt:alphaAt,chance:chance,effective:effective,ricochet:ricochet,color:color,value:value,nonPenetration:nonPenetration,transform:transform,unit:unit,sub:sub,aimFactor:aimFactor,
    aimStep:aimStep,aimShot:aimShot,shotTerm:shotTerm,reloadSeconds:reloadSeconds,autoreloadScaled:autoreloadScaled,moveStep:moveStep,motionLimits:motionLimits,turretChase:turretChase,
    aimProfiles:AIM_PROFILES,aimProfile:aimProfile,aimProfileDefault:DEFAULT_PROFILE,moveDefaults:MOVE,
    circlePoint:circlePoint,CircleSampler:CircleSampler,verdicts:verdicts,packEngine:packEngine,unpackEngine:unpackEngine,packModel:packModel,unpackModel:unpackModel,
    remoteVerdicts:remoteVerdicts,serve:serve,useWorker:useWorker};
}(typeof window==='undefined'?globalThis:window));
