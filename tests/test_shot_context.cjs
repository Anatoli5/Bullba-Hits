/* Aim fallback: each snapshot source is judged by its own receipt time; reasons name why a circle is absent. */
const path=require('node:path'),assert=require('node:assert/strict');
global.window=global;require(path.join(__dirname,'..','web','shot-context.js'));
const R=ArmorShotContext.resolve;
const target={worldTransform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],parts:[{id:1,transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]};
const hit={id:'1',attackerId:7,effectsIndex:3,receivedAt:100,target,points:[{part:1,status:'resolved',position:[0,0,0],shellType:2,caliber:100}],shellCandidates:[{kind:'ARMOR_PIERCING',name:'AP',caliber:100,penetration100:200,speed:900}]};
const marker=(t)=>({position:[0,0,-100],direction:[0,0,1],diameter:1,receivedAt:t});
function events(extra,tracerExtra){return [
  {event:'command',id:'c1',receivedAt:99.9,...extra},
  {event:'tracer',id:'t1',own:true,shooterId:7,effectsIndex:3,gunInstallationIndex:0,isRicochet:false,receivedAt:99.95,origin:[0,0,-100],velocity:[0,0,900],possibleCommandId:'c1',...tracerExtra},
  {tracerId:'t1',position:[0,0,0],receivedAt:100.05}];}
// Stale command snapshot must not hide a fresh aimAtTracer.
let c=R(hit,events({aim:{clientMarker:marker(90)}},{aimAtTracer:{clientMarker:marker(99.9)}}));
assert.ok(c.aim);assert.equal(c.aimSource,'tracer');assert.equal(c.aimReason,null);
// A valid command snapshot is preferred and the tracer copy is untouched.
c=R(hit,events({aim:{clientMarker:marker(99.8)}},{aimAtTracer:{clientMarker:marker(99.9)}}));
assert.equal(c.aimSource,'command');
// Incomplete command marker (no diameter) falls back too.
c=R(hit,events({aim:{clientMarker:{position:[0,0,0],direction:[0,0,1],receivedAt:99.9}}},{aimAtTracer:{clientMarker:marker(99.9)}}));
assert.equal(c.aimSource,'tracer');
// Reasons: no snapshot at all; stale only; no tracer; no endpoint; ambiguous; foreign.
assert.equal(R(hit,events({},{})).aimReason,'no-snapshot');
assert.equal(R(hit,events({aim:{clientMarker:marker(90)}},{})).aimReason,'stale');
assert.equal(R(hit,[]).aimReason,'no-tracer');
assert.equal(R(hit,events({},{}).slice(0,2)).aimReason,'no-endpoint');
// Two own tracers from different commands stay ambiguous; a salvo (one command, two shells) resolves to the latest shell.
const two=events({},{});two.push({event:'command',id:'c2',receivedAt:99.5},{...two[1],id:'t2',possibleCommandId:'c2'},{tracerId:'t2',position:[0,0,0],receivedAt:100.05});assert.equal(R(hit,two).aimReason,'ambiguous');
const salvo=events({aim:{clientMarker:marker(99.3)},shooterId:7},{});salvo.push({...salvo[1],id:'t2',receivedAt:99.98,possibleCommandId:undefined},{tracerId:'t2',position:[0,0,0],receivedAt:100.05});
c=R(hit,salvo);assert.ok(c.aim);assert.equal(c.tracer.id,'t2');assert.equal(c.aimSource,'salvo');
const foreign=events({},{});foreign[1]={...foreign[1],own:false};assert.equal(R(hit,foreign).aimReason,'foreign');assert.equal(R(hit,foreign).aim,null);
// Timestamps stay bound to the source: tracer aim judged by tracer time, not command time.
c=R(hit,events({receivedAt:50,aim:null},{aimAtTracer:{clientMarker:marker(99.9)}}));assert.equal(c.aimSource,'tracer');
// BACKLOG 28 step 2 (24.09): the circle the server fired from. The last update as is when its origin is the shell's;
// a stale one (origin 1.9 m off) marked, unless a gunAfterShot update names the shell's origin - then that one, exact.
const L=(o,a)=>({origin:o,vector:[0,0,1],dispersionAngle:a||.002,receivedAt:99.9,gameTime:1});
c=R(hit,events({},{aimAtTracer:{clientMarker:marker(99.9),lastServerGunUpdate:L([0,0,-100.01])}}));
assert.equal(c.serverShot.from,'last');assert.equal(c.serverShot.stale,false);assert.ok(c.serverShot.gap<.05);
c=R(hit,events({},{aimAtTracer:{clientMarker:marker(99.9),lastServerGunUpdate:L([0,0,-101.9])}}));
assert.equal(c.serverShot.stale,true);assert.equal(c.serverShot.update.origin[2],-101.9);assert.equal(c.serverShot.afterRecorded,false);
const withAfter=events({},{aimAtTracer:{clientMarker:marker(99.9),lastServerGunUpdate:L([0,0,-101.9])}});
withAfter.push({event:'gunAfterShot',tracerId:'t1',updates:[L([0,0,-100],.003),L([0,0,-98.1],.009)]});
c=R(hit,withAfter);assert.equal(c.serverShot.from,'after');assert.equal(c.serverShot.stale,false);assert.equal(c.serverShot.update.dispersionAngle,.003);
// Updates after the shot that do not name the shell's origin leave it stale, and say they were looked at.
withAfter[withAfter.length-1].updates=[L([0,0,-98.1],.009)];c=R(hit,withAfter);assert.equal(c.serverShot.stale,true);assert.equal(c.serverShot.afterRecorded,true);
// No field (recorder 0.7.6-0.7.12), another's tracer, a ricochet: no disc.
assert.equal(R(hit,events({},{aimAtTracer:{clientMarker:marker(99.9)}})).serverShot,null);
assert.equal(ArmorShotContext.serverShot({...events({},{})[1],own:false,aimAtTracer:{lastServerGunUpdate:L([0,0,-100])}},[]),null);
assert.equal(ArmorShotContext.serverShot({...events({},{})[1],isRicochet:true,aimAtTracer:{lastServerGunUpdate:L([0,0,-100])}},[]),null);
// Review 24.09: a two-gun salvo - both tracers at one gameTime, the server's origin the middle of the barrels. Measured from
// the middle, not stale; one tracer alone at that origin would be (0.195 m). The salvo's one gunAfterShot names its first
// tracer and is found for the second too.
const salvoEvents=function(Lorigin,after){
  const t=(id,x,gun)=>({event:'tracer',id:id,own:true,shooterId:7,effectsIndex:3,gunInstallationIndex:0,gunIndex:gun,isRicochet:false,receivedAt:99.95,gameTime:50,
    origin:[x,0,-100],velocity:[0,0,900],aimAtTracer:{clientMarker:marker(99.9),lastServerGunUpdate:L(Lorigin)}});
  const list=[t('a',.195,0),t('b',-.19,1)];if(after)list.push({event:'gunAfterShot',tracerId:'a',updates:[L([.0025,0,-100],.003)]});return list;};
let ev2=salvoEvents([.0025,0,-100]),s2=ArmorShotContext.serverShot(ev2[1],ev2);
assert.equal(s2.stale,false);assert.equal(s2.salvo,2);assert.ok(s2.gap<.01);
assert.equal(ArmorShotContext.serverShot(ev2[1],[ev2[1]]).stale,true);
ev2=salvoEvents([1.5,0,-100],true);s2=ArmorShotContext.serverShot(ev2[1],ev2);
assert.equal(s2.from,'after');assert.equal(s2.stale,false);assert.equal(s2.update.dispersionAngle,.003);
ev2=salvoEvents([1.5,0,-100],false);s2=ArmorShotContext.serverShot(ev2[0],ev2);assert.equal(s2.stale,true);assert.equal(s2.salvo,2);assert.equal(s2.afterRecorded,false);
console.log(JSON.stringify({passed:true,cases:22}));
