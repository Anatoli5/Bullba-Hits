const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
vm.runInThisContext(fs.readFileSync('web/ballistics.js','utf8'));
const B=globalThis.ArmorBallistics;
const main={armor:100,vehicleDamageFactor:1,useHitAngle:true,mayRicochet:true,checkCaliberForRicochet:true,checkCaliberForHitAngleNorm:true,collideOnceOnly:false};
const shell=B.shell('ARMOR_PIERCING',100,100);
function surface(armor,z=0,part=1,name='armor_1'){
  return B.triangle([-5,-5,z],[5,-5,z],[0,5,z],part,name,armor);
}
function hit(armor,angle=0,distance=1,part=1,name='armor_1'){return {triangle:surface(armor,0,part,name),cos:Math.cos(angle*Math.PI/180),distance};}
assert.equal(B.evaluate([hit(main)],shell).chance,50);
assert.equal(B.evaluate([hit({...main,armor:75})],shell).chance,100);
assert.equal(B.evaluate([hit({...main,armor:125})],shell).chance,0);
assert.equal(B.evaluate([hit(main,70)],shell).reason,'ricochet');
assert.equal(B.evaluate([hit({...main,armor:100/3},70)],shell).reason,'ricochet');
assert.notEqual(B.evaluate([hit({...main,armor:33},70)],shell).reason,'ricochet');
assert.ok(Math.abs(B.effective(main,Math.cos(Math.PI/3),shell)-100/Math.cos(55*Math.PI/180))<1e-9);
assert.ok(Math.abs(B.effective({...main,armor:40},Math.cos(Math.PI/3),shell)-40/Math.cos(51.25*Math.PI/180))<1e-9);
const screen={...main,armor:20,vehicleDamageFactor:0,collideOnceOnly:true};
let result=B.evaluate([hit(screen,0,1,0,'track'),hit(screen,0,1.2,0,'track'),hit(main,0,2)],shell);
assert.equal(result.layers.length,2);assert.equal(result.effective,120);assert.ok(result.chance<5);
result=B.evaluate([hit(main),hit(main)],shell);assert.equal(result.layers.length,1);
assert.equal(B.evaluate([hit(screen)],shell).reason,'no-hull');
assert.equal(B.evaluate([hit(null)],shell).chance,null);
assert.equal(B.evaluate([hit(main)],null).chance,null);
const heat=B.shell('HOLLOW_CHARGE',200,100);
assert.equal(B.evaluate([hit(main,85)],heat).reason,'ricochet');
result=B.evaluate([hit({...screen,armor:10},0,1,0,"track"),hit(main,0,2)],heat);
assert.ok(result.effective>190&&result.effective<210);
// Ricochet continuation (client rule since 9.3): mirrored flight, AP keeps 75% of the penetration, HEAT all of it,
// a second ricochet destroys the shell; first-contact mode stops at the ricochet.
{
  const s75=Math.sin(75*Math.PI/180),c75=Math.cos(75*Math.PI/180),ap=B.shell('ARMOR_PIERCING',200,100);
  const floor=surface(main,0),wall=B.triangle([2,-5,-5],[2,5,-5],[2,0,5],1,'armor_1',main),ceiling=B.triangle([.5,-5,.5],[5,-5,.5],[2.5,5,.5],1,'armor_1',main); // only above the bounce, clear of the first ray
  const origin=[-3*s75,0,3*c75],direction=[s75,0,-c75];
  let r=B.fromTriangles([floor,wall]).ray(origin,direction,ap);
  assert.ok(r.bounce&&Math.abs(r.bounce.angle-75)<1e-6&&Math.abs(r.bounce.penetration-150)<1e-9,'bounce recorded with 25% loss');
  assert.equal(r.reason,'penetration');assert.ok(Math.abs(r.angle-15)<1e-6);assert.ok(r.chance>95);
  assert.ok(Math.abs(r.bounce.point[0])<1e-6&&Math.abs(r.distance-2/s75)<2e-3,'second contact on the wall');
  r=B.fromTriangles([floor,ceiling]).ray(origin,direction,ap);
  assert.equal(r.reason,'ricochet');assert.equal(r.final,true);assert.ok(r.bounce,'second ricochet ends the shell');
  r=B.fromTriangles([floor]).ray(origin,direction,ap);
  assert.equal(r.reason,'no-hull');assert.ok(r.bounce,'flies past after the ricochet');
  r=B.fromTriangles([floor,wall]).ray(origin,direction,{...ap,ricochetContinue:false});
  assert.equal(r.reason,'ricochet');assert.equal(r.bounce,undefined);
  const s87=Math.sin(87*Math.PI/180),c87=Math.cos(87*Math.PI/180);
  r=B.fromTriangles([floor,wall]).ray([-3*s87,0,3*c87],[s87,0,-c87],B.shell('HOLLOW_CHARGE',200,100));
  assert.ok(r.bounce&&r.bounce.loss===0&&Math.abs(r.bounce.penetration-200)<1e-9,'HEAT keeps its penetration');
  // 26.09 (user's decision, variant B): the bounced leg carries what the first leg had LEFT - a screen before the ricochet
  // stays spent: remaining2 = 0.75 x remaining1, the chance scaled by 0.75 x P. Obj. 430U's pinned point: 248 mm, a 30 mm
  // skirt worth 34 mm -> 214 mm at the ricochet -> 160.5 mm on the second leg (186 before 26.09).
  const skirt=B.triangle([-1,-5,-5],[-1,5,-5],[-1,0,5],2,'skirt',{armor:34,vehicleDamageFactor:0,useHitAngle:false,mayRicochet:false,collideOnceOnly:true});
  const p248=B.shell('ARMOR_PIERCING',248,122),thick={...main,armor:150},wall150=B.triangle([2,-5,-5],[2,5,-5],[2,0,5],1,'armor_2',thick);
  r=B.fromTriangles([skirt,floor,wall150]).ray(origin,direction,p248);
  assert.ok(r.bounce&&Math.abs(r.bounce.remaining-214)<1e-9&&Math.abs(r.bounce.carried-160.5)<1e-9&&Math.abs(r.bounce.penetration-186)<1e-9&&r.bounce.shell===248,'430U: 214 left at the ricochet, 160.5 carried, chance scaled by 186');
  assert.equal(r.bounce.layers.length,1,'the skirt is the first leg\'s layer');
  const wallEff=B.effective(thick,Math.cos(15*Math.PI/180),p248);
  assert.equal(r.reason,'penetration');assert.equal(r.remaining,160.5);
  assert.equal(r.chance,B.chance(160.5,wallEff,186,.25,'NORMAL'),'the wall is judged with 160.5 left against a scale of 186');
  assert.ok(Math.abs(r.effective-(186-160.5+wallEff))<1e-9,'eff: the carried loss is part of what the leg must beat');
  assert.ok(r.chance<B.chance(186,wallEff,186,.25,'NORMAL'),'lower than the old restart from 186');
  // The same leg through the one owner the Statistics log uses for the point after a recorded ricochet.
  const eng=B.fromTriangles([skirt,floor,wall150]),again=eng.bounced([r.bounce.point[0]+r.bounce.direction[0]*1e-3,r.bounce.point[1]+r.bounce.direction[1]*1e-3,r.bounce.point[2]+r.bounce.direction[2]*1e-3],r.bounce.direction,p248,214);
  assert.equal(again.chance,r.chance);assert.equal(again.remaining,160.5);
  assert.equal(eng.bounced([0,0,1],[1,0,0],p248).remaining,186,'remaining unknown: the leg starts from 0.75 x P');
  // A shell with enableTraceRicochet false (AAAC, Charlie 3/Delta 6, JPNh, PG70) is lost at its first ricochet.
  r=B.fromTriangles([floor,wall]).ray(origin,direction,{...ap,traceRicochet:false});
  assert.equal(r.reason,'ricochet');assert.equal(r.final,true);assert.equal(r.bounce,undefined,'no second leg for a no-trace shell');
  assert.equal(B.shell('ARMOR_PIERCING',200,100).traceRicochet,true,'the client default: the shell flies on');
  // Review 26.09 D1: screens thicker than the shell leave a NEGATIVE remainder at the ricochet. That is a figure, not
  // "unknown": the leg starts from max(0, remainder) x 0.75 = 0 and a 50 mm wall behind is not pierced (before: the
  // negative sign read as unknown and the leg restarted from 0.75 x P - 99 mm of screen gave 0 %, 101 mm gave 100 %).
  const p100=B.shell('ARMOR_PIERCING',100,100),wall50=B.triangle([2,-5,-5],[2,5,-5],[2,0,5],1,'armor_3',{...main,armor:50});
  for(const [screenMm,left] of [[99,1],[101,-1],[120,-20]]){
    const sk=B.triangle([-1,-5,-5],[-1,5,-5],[-1,0,5],2,'skirt',{armor:screenMm,vehicleDamageFactor:0,useHitAngle:false,mayRicochet:false,collideOnceOnly:true});
    const e=B.fromTriangles([sk,floor,wall50]),q=e.ray(origin,direction,p100);
    assert.ok(q.bounce&&Math.abs(q.bounce.remaining-left)<1e-9,'screen '+screenMm+': '+left+' mm left at the ricochet');
    assert.equal(q.bounce.carried,Math.max(0,left)*.75,'screen '+screenMm+': the leg starts from max(0, left) x 0.75');
    assert.equal(q.reason,'penetration');assert.equal(q.chance,0,'screen '+screenMm+': the 50 mm wall behind is not pierced');
    assert.equal(e.bounced([q.bounce.point[0]+q.bounce.direction[0]*1e-3,q.bounce.point[1]+q.bounce.direction[1]*1e-3,q.bounce.point[2]+q.bounce.direction[2]*1e-3],q.bounce.direction,p100,left).chance,0,'screen '+screenMm+': the Statistics log leg agrees');
  }
  assert.equal(eng.bounced([0,0,1],[1,0,0],p248,null).remaining,186,'null is unknown too: the nominal');
}
// Ties (26.09): two materials met at the same distance go by material id - the order of first appearance, the id the GPU
// surface gives them - whatever order the tree is walked in. Here the tree's leaf holds the screen before the plate (by the
// triangles' centres), the flat engine the other way round; before, the two engines disagreed.
{
  const plate={...main},skin={armor:20,vehicleDamageFactor:0,useHitAngle:false,mayRicochet:false,collideOnceOnly:true};
  const P=B.triangle([0,-5,0],[22,-5,0],[0,5,0],1,'armor_1',plate),S=B.triangle([-20,-5,0],[2,-5,0],[2,5,0],2,'track',skin);
  const far=Array.from({length:11},(_,i)=>B.triangle([50+i,-5,0],[51+i,-5,0],[50+i,5,0],3,'armor_1',plate));
  for(const [list,eff,name] of [[[P,S,...far],100,'plate first'],[[S,P,...far],120,'screen first']]){
    const a=B.fromTriangles(list).ray([1,0,5],[0,0,-1],shell),b=B.fromTriangles(list,true).ray([1,0,5],[0,0,-1],shell);
    assert.equal(a.effective,eff,'tree, '+name);assert.equal(b.effective,eff,'flat, '+name);
  }
}
assert.equal(B.chance(100,100,100,0,'NORMAL'),100);
assert.equal(B.chance(100,100,100,.25,'UNKNOWN'),null);
assert.deepEqual(B.color({chance:0},'accessible'),[.63,.18,.55]);
assert.deepEqual(B.transform([1,2,3],[1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1]),[11,22,-33]);
const model={groups:[{material:'armor_1',vertices:[[-5,-5,0],[5,-5,0],[0,5,0]],indices:[0,1,2]}]};
const data={hit:{target:{parts:[{id:1,armor:{armor_1:main},transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]}},models:{1:model}};
const engine=B.build(data);
assert.equal(engine.ray([0,0,10],[0,0,-1],shell).chance,50);
assert.equal(engine.ray([20,0,10],[0,0,-1],shell).reason,'no-hull');
assert.equal(engine.ray([0,0,-10],[0,0,1],shell).chance,50);
console.log('PASS: probability, normalization, caliber thresholds, ricochet, layered armor, HEAT gap, missing metadata, transformed BVH rays.');
// The client's own figures (tools/verify_penetration_reference.py, run once on the client): a local file, not tracked.
const REFERENCE=['tests/fixtures-local/penetration-reference.json','outputs/penetration-reference.json'].find(p=>fs.existsSync(p));
if(!REFERENCE)console.log('SKIP (the client reference of the penetration functions is not on this machine: tests/fixtures-local/penetration-reference.json)');
else{
  const reference=JSON.parse(fs.readFileSync(REFERENCE,'utf8'));
  for(const row of reference.probability)assert.equal(B.chance(row.pen,row.armor,row.pen,row.randomization,'NORMAL'),row.chance);
  for(const row of reference.normalization)assert.ok(Math.abs(B.effective({...main,armor:row.armor},Math.cos(row.angle*Math.PI/180),B.shell('ARMOR_PIERCING',250,row.caliber))-row.effective)<1e-4);
  console.log('PASS: '+reference.probability.length+' probability and '+reference.normalization.length+' normalization cases match the client functions.');
}
if(process.argv[2]){
  // A battle file is compact since 0.7.17: the page's own reader expands its shared tables.
  global.window=global;vm.runInThisContext(fs.readFileSync('web/local-data.js','utf8'));
  const root=process.argv[2],read=(p)=>JSON.parse(fs.readFileSync(p,'utf8').slice('ArmorInspectorData.receive('.length,-3))[1];
  const index=read(root+'/data/index.js'),battle=window.ArmorInspectorData.expandBattle(read(root+'/data/battles/'+index.battles[0].id+'.js'));
  const hit=battle.hits[0],scene={hit,models:{}};
  hit.target.parts.forEach(p=>{assert.ok(p.armor);scene.models[p.id]=read(root+'/data/models/'+p.modelKey+'.js');});
  const actual=B.build(scene,true),samples=[];actual.triangles.forEach(t=>B.subdivide(t,0,samples));
  const t0=performance.now(),origin=[8,4,12],values=samples.map(t=>actual.ray(origin,B.sub(t.center,origin),B.shell('ARMOR_PIERCING',250,105)));
  assert.ok(values.some(v=>v.chance===100));assert.ok(values.some(v=>v.chance===0));assert.ok(values.some(v=>v.chance>0&&v.chance<100));assert.ok(values.every(v=>v.reason!=='armor'));
  console.log(JSON.stringify({realTriangles:actual.triangles.length,colorSamples:samples.length,elapsedMs:Math.round(performance.now()-t0),allArmorMatched:true}));
}
