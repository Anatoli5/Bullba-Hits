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
