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
// THE RAY CORE AGAINST BRUTE FORCE (10.11.2026: the core became flat arrays, an explicit stack and a cut-off - this holds
// it to the plain definition, with no tree and no cut-off): every triangle of the scene tested, the contacts beyond EPS
// sorted by distance and, within TIE of the first of a run, by material id - the page's order - then walked (evaluate),
// against engine.ray on the kd-tree and on the one-leaf engine, every field (the struck facet by its distance and cosine:
// two coplanar facets of one material at one distance are the same plate to the walk). Synthetic scenes built here -
// coplanar grids with shared edges and vertices, a coplanar copy of another material, plates TIE apart, stacked main
// plates, a soup - and the local fixture models when present.
{
  const EPS=1e-5,TIE=B.TIE;
  const plate=(armor,vdf,extra)=>({armor:armor,vehicleDamageFactor:vdf,useHitAngle:true,mayRicochet:true,checkCaliberForRicochet:true,checkCaliberForHitAngleNorm:true,collideOnceOnly:false,...extra});
  const KINDS=[plate(60,1),plate(15,0),plate(25,0,{collideOnceOnly:true}),plate(null,1),plate(120,1,{useHitAngle:false}),plate(8,0,{mayRicochet:false}),undefined];
  function unitOf(d){const n=Math.sqrt(d[0]*d[0]+d[1]*d[1]+d[2]*d[2]);return n>EPS?d.map(x=>x/n):[0,0,0];}
  function bruteHits(engine,o,d){
    const u=unitOf(d),hits=[];
    engine.triangles.forEach(t=>{
      const e1=t.e1,e2=t.e2,hx=u[1]*e2[2]-u[2]*e2[1],hy=u[2]*e2[0]-u[0]*e2[2],hz=u[0]*e2[1]-u[1]*e2[0],det=e1[0]*hx+e1[1]*hy+e1[2]*hz;
      if(Math.abs(det)<1e-10)return;
      const sx=o[0]-t.a[0],sy=o[1]-t.a[1],sz=o[2]-t.a[2],a=(sx*hx+sy*hy+sz*hz)/det;if(a<-1e-8||a>1+1e-8)return;
      const qx=sy*e1[2]-sz*e1[1],qy=sz*e1[0]-sx*e1[2],qz=sx*e1[1]-sy*e1[0],b=(u[0]*qx+u[1]*qy+u[2]*qz)/det;if(b<-1e-8||a+b>1+1e-8)return;
      const distance=(e2[0]*qx+e2[1]*qy+e2[2]*qz)/det;
      if(distance>EPS)hits.push({distance:distance,triangle:t,cos:Math.abs(u[0]*t.normal[0]+u[1]*t.normal[1]+u[2]*t.normal[2])});
    });
    const mat=t=>{const m=engine.materialId(t);return m===undefined?engine.materialCount:m;};
    hits.sort((x,y)=>x.distance-y.distance);
    for(let i=0;i<hits.length;){let j=i+1;while(j<hits.length&&hits[j].distance-hits[i].distance<=TIE)j++;
      const run=hits.slice(i,j).sort((x,y)=>mat(x.triangle)-mat(y.triangle));for(let k=i;k<j;k++)hits[k]=run[k-i];i=j;}
    return hits;
  }
  const plain=r=>JSON.stringify(r,(k,v)=>k==='normal'||k==='origin'||k==='direction'?undefined:k==='hit'?[v.distance,v.cos]:v);
  const shells=[B.shell('ARMOR_PIERCING',140,100),B.shell('ARMOR_PIERCING_CR',260,85),B.shell('HOLLOW_CHARGE',300,105),Object.assign(B.shell('HIGH_EXPLOSIVE',50,152),{alpha:750,spallDamage:375,mechanics:'MODERN'})];
  shells[0].alpha=390;shells.forEach(s=>{s.ricochetContinue=false;});
  let checked=0,contacts=0,ties=0;
  function against(name,tris,rays){
    const tree=B.fromTriangles(tris),flat=B.fromTriangles(tris,true);
    // the tree's own shape: pre-order arrays, leaves of at most 10, every triangle in exactly one leaf
    const acc=tree.acceleration,nodes=acc.box.length/6,seen=new Uint8Array(tris.length);
    for(let i=0;i<nodes;i++)if(acc.run[i*2+1]>=0){assert.ok(acc.run[i*2+1]<=10&&acc.kid[i*2]===-1,name+': leaf '+i);for(let k=0;k<acc.run[i*2+1];k++)seen[acc.pool[acc.run[i*2]+k]]++;}
      else assert.ok(acc.kid[i*2]===i+1&&acc.kid[i*2+1]>i+1,name+': pre-order '+i);
    assert.ok(seen.every(x=>x===1),name+': every triangle in one leaf');
    rays.forEach(([o,d],i)=>{
      const hits=bruteHits(tree,o,d);contacts+=hits.length;
      for(let k=1;k<hits.length;k++)if(hits[k].distance-hits[k-1].distance<=TIE)ties++;
      shells.forEach(s=>{
        const want=plain(B.evaluate(hits,s));
        assert.equal(plain(tree.ray(o,d,s)),want,name+': ray '+i+' '+s.kind+' (kd-tree)');
        assert.equal(plain(flat.ray(o,d,s)),want,name+': ray '+i+' '+s.kind+' (one leaf)');
        checked++;
      });
    });
  }
  let seed=11;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  const tri=(a,b,c,part,k)=>B.triangle(a,b,c,part,'armor_'+k,KINDS[k]);
  // 1. Coplanar grids: 20 x 20 quads at z = 0 (shared edges and vertices), the same grid as another material (a track face
  // in the plane of a side plate), a plate 5 um above (within TIE), one 20 um above (beyond it), a main plate 1 m below.
  {
    const tris=[],g=(z,part,k,step)=>{for(let i=0;i<20;i++)for(let j=0;j<20;j++){const x=i*step-10*step,y=j*step-10*step;
      tris.push(tri([x,y,z],[x+step,y,z],[x+step,y+step,z],part,k),tri([x,y,z],[x+step,y+step,z],[x,y+step,z],part,k));}};
    g(0,1,1,.25);g(0,2,0,.25);g(5e-6,3,2,.25);g(2e-5,4,4,.25);g(-1,1,0,.3);
    const rays=[];
    for(let i=0;i<=20;i+=2)for(let j=0;j<=20;j+=3){const x=i*.25-2.5,y=j*.25-2.5;rays.push([[x,y,3],[0,0,-1]],[[x,y,-3],[0,0,1]],[[x+.01,y+.02,3],[0.1,-0.05,-1]]);}
    for(let i=0;i<150;i++){const o=[(rnd()-.5)*8,(rnd()-.5)*8,(rnd()<.5?-1:1)*(2+rnd()*3)];rays.push([o,[(rnd()-.5)*4-o[0],(rnd()-.5)*4-o[1],-o[2]*(rnd()*.5+.6)]]);}
    for(let i=0;i<40;i++)rays.push([[-6,(rnd()-.5)*4,1e-6*(i%5)],[1,(rnd()-.5)*.1,-1e-3*rnd()]]);   // grazing the planes
    against('coplanar grids',tris,rays);
  }
  // 2. Stacked plates along x: screens, main plates (the cut-off), plates behind them, plates TIE apart, tilted plates.
  {
    const tris=[],quad=(x,s,tilt,part,k)=>{tris.push(tri([x,-s,-s],[x+tilt,s,-s],[x+tilt,s,s],part,k),tri([x,-s,-s],[x+tilt,s,s],[x,-s,s],part,k));};
    for(let i=0;i<60;i++)quad(i*.2+(i%7===3?4e-6:0),1+rnd(),(rnd()-.5)*.8,1+(i%4),i%KINDS.length);
    const rays=[];
    for(let i=0;i<250;i++)rays.push([[-3,(rnd()-.5)*2,(rnd()-.5)*2],[1,(rnd()-.5)*.6,(rnd()-.5)*.6]],[[15,(rnd()-.5)*2,(rnd()-.5)*2],[-1,(rnd()-.5)*.6,(rnd()-.5)*.6]]);
    for(let i=0;i<30;i++)rays.push([[-3,(rnd()-.5)*1.5,(rnd()-.5)*1.5],[1,0,0]],[[2+rnd()*5,(rnd()-.5),(rnd()-.5)],[1,0,0]]);   // axis-aligned, some from inside
    against('stacked plates',tris,rays);
  }
  // 3. Twins: main plates along x, each with a screen 5 um behind it (within TIE) of a LOWER material id (its triangles come
  // first), often in a box the ray enters after the main plate has set the cut-off - the box kept within TIE of it, the
  // screen sorted first. Rays from inside the stack, so every plate is the first one some ray meets.
  {
    const twins=[],mains=[],quad=(list,x,s,part,k)=>{list.push(tri([x,-s,-s],[x,s,-s],[x,s,s],part,k),tri([x,-s,-s],[x,s,s],[x,-s,s],part,k));};
    for(let i=0;i<50;i++){const x=i*.25,s=.8+.4*rnd();quad(mains,x,s,1,0);quad(twins,x+5e-6,s,2,1);}
    const rays=[];
    for(let i=0;i<300;i++)rays.push([[-.1+rnd()*12.5,(rnd()-.5)*1.4,(rnd()-.5)*1.4],[1,(rnd()-.5)*.02,(rnd()-.5)*.02]]);
    against('TIE twins',twins.concat(mains),rays);
  }
  // 4. A soup of 600 triangles of every kind, rays from all sides.
  {
    const tris=[];
    for(let i=0;i<600;i++){const c=[(rnd()-.5)*6,(rnd()-.5)*3,(rnd()-.5)*8],e=()=>(rnd()-.5)*1.5;tris.push(tri(c,[c[0]+e(),c[1]+e(),c[2]+e()],[c[0]+e(),c[1]+e(),c[2]+e()],1+i%3,i%KINDS.length));}
    const rays=[];
    for(let i=0;i<400;i++){const z=2*rnd()-1,ph=2*Math.PI*rnd(),q=Math.sqrt(1-z*z),o=[12*q*Math.cos(ph),12*z,12*q*Math.sin(ph)];rays.push([o,[(rnd()-.5)*4-o[0],(rnd()-.5)*2-o[1],(rnd()-.5)*5-o[2]]]);}
    against('soup',tris,rays);
  }
  console.log('PASS: the ray core equals brute force on '+checked+' ray-shell pairs ('+contacts+' contacts, '+ties+' within TIE), kd-tree and one leaf.');
  // 5. The local fixture models (published client models; not tracked): each group a plate of a kind in turn.
  const dir=['tests/fixtures-local/close-range-2026-10-04/data/models','tests/fixtures-local/stats-log-2026-10-04/data/models'].find(p=>fs.existsSync(p));
  if(!dir)console.log('SKIP (no local fixture models: tests/fixtures-local/close-range-2026-10-04/data/models)');
  else{
    const files=fs.readdirSync(dir).filter(f=>f.endsWith('.js')).sort().slice(0,40),before=checked;let used=0;
    for(const f of files){
      const s=fs.readFileSync(dir+'/'+f,'utf8'),m=JSON.parse(s.slice(s.indexOf('['),s.lastIndexOf(']')+1))[1];
      if(!m||!m.groups)continue;const tris=[];
      m.groups.forEach((g,gi)=>{const v=g.vertices;for(let i=0;i<g.indices.length;i+=3)tris.push(tri(v[g.indices[i]],v[g.indices[i+1]],v[g.indices[i+2]],1,gi%KINDS.length));});
      if(tris.length<200)continue;
      const lo=[0,1,2].map(i=>Math.min(...tris.map(t=>t.min[i]))),hi=[0,1,2].map(i=>Math.max(...tris.map(t=>t.max[i]))),c=lo.map((x,i)=>(x+hi[i])/2),R=2*Math.hypot(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2])+5,rays=[];
      for(let i=0;i<300;i++){const z=2*rnd()-1,ph=2*Math.PI*rnd(),q=Math.sqrt(1-z*z),o=[c[0]+R*q*Math.cos(ph),c[1]+R*z,c[2]+R*q*Math.sin(ph)];
        rays.push([o,[0,1,2].map(k=>lo[k]+rnd()*(hi[k]-lo[k])-o[k])]);}
      against('fixture model '+f.slice(0,12),tris,rays);
      if(++used===3)break;
    }
    console.log('PASS: the ray core equals brute force on '+used+' local fixture models ('+(checked-before)+' ray-shell pairs).');
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
