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
console.log(JSON.stringify({passed:true,cases:11}));
