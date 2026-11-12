/* Narrow in-memory classic-script adapter checks; no browser or server. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const key='a'.repeat(64), table={front:{armor:100,useHitAngle:true}};
const payloads={},definitions={},requested=[];
const ctx={Promise,Date,setTimeout,clearTimeout,console};ctx.window=ctx;
ctx.document={createElement(){return {remove(){}};},head:{appendChild(script){
  const file=script.src.split('?')[0];requested.push(file);
  // A definition of the shared store (BACKLOG 27): definitions/<kind>/<name>.js; one not there is a missing file.
  const shared=/^definitions\/(\w+)\/(\w+)\.js$/.exec(file);
  if(shared){setImmediate(()=>{const value=definitions[shared[1]+':'+shared[2]];
    if(value===undefined){script.onerror();return;}
    ctx.ArmorInspectorData.receive(['definition:'+shared[1]+':'+shared[2],JSON.parse(JSON.stringify(value))]);script.onload();});return;}
  const id=file.split('/').pop().slice(0,-3);
  setImmediate(()=>{try{ctx.ArmorInspectorData.receive(['battle:'+id,JSON.parse(JSON.stringify(payloads[id]))]);script.onload();}catch(e){script.onload();}});
}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/local-data.js','utf8'),ctx);
function hit(part){return {type:'hit',id:'1',target:{parts:[part]},points:[{position:[1,2,3]}]};}
function plain(v){return JSON.parse(JSON.stringify(v));}
(async()=>{
  payloads.old={id:'old',hits:[hit({id:0,armor:table,transform:[1,2,3]})]};
  let b=await ctx.ArmorInspectorData.battle('old');assert.equal(b.hits[0].target.parts[0].armor.front.armor,100);
  payloads.new={id:'new',armorTableFormat:1,armorTables:{[key]:table},hits:[hit({id:0,armorRef:key,transform:[1,2,3]}),hit({id:0,armorRef:key})]};
  b=await ctx.ArmorInspectorData.battle('new');assert.equal(b.hits[0].target.parts[0].armor.front.armor,100);
  assert.equal(b.hits[0].target.parts[0].armor,b.hits[1].target.parts[0].armor);
  assert.deepEqual(b.hits[0].target.parts[0].transform,[1,2,3]);assert.equal(b.hits[0].target.parts[0].armorRef,undefined);
  payloads.missing={id:'missing',armorTableFormat:1,armorTables:{},hits:[hit({id:0,armorRef:key})]};
  b=await ctx.ArmorInspectorData.battle('missing');assert.equal(b.hits.length,1);assert.equal(Object.keys(b.hits[0].target.parts[0].armor).length,0);assert.equal(b.hits[0].warnings.length,1);
  payloads.invalid={id:'invalid',armorTableFormat:7,hits:[]};await assert.rejects(ctx.ArmorInspectorData.battle('invalid'),/corrupted/);
  payloads.invalidShared={id:'invalidShared',sharedDefinitionsFormat:2,hits:[]};await assert.rejects(ctx.ArmorInspectorData.battle('invalidShared'),/corrupted/);

  // THE SHARED STORE (BACKLOG 27): the same battle with its tables in the file and with them in the store reads the same.
  const vref='C#0:'+'b'.repeat(32),pref='C#0:'+'c'.repeat(32),shells='C#0:'+'d'.repeat(32),pitch='C#0:'+'e'.repeat(32);
  const block={type:'usa:T1',partsRef:pref,gunPitchRef:pitch},parts=[{id:1,name:'hull',armorRef:key}],shellList=[{kind:'AP'}],limits={samples:[[0,-0.1,0.2]]};
  function refHit(id,pose){return {type:'hit',id:id,availableShellsRef:shells,target:{vehicleRef:vref,partPoses:[pose],worldTransform:[1]},points:[]};}
  payloads.own={id:'own',staticTableFormat:1,pitchTableFormat:1,armorTableFormat:1,staticTables:{[vref]:block,[pref]:parts,[shells]:shellList},
    pitchTables:{[pitch]:limits},armorTables:{[key]:table},hits:[refHit('1',[1,0]),refHit('2',[2,0])]};
  const lists={static:[pref,shells,vref],pitch:[pitch],armor:[key]};
  payloads.store1={id:'store1',staticTableFormat:1,pitchTableFormat:1,armorTableFormat:1,sharedDefinitionsFormat:1,sharedDefinitions:lists,
    hits:[refHit('1',[1,0]),refHit('2',[2,0])]};
  payloads.store2=Object.assign({},payloads.store1,{id:'store2'});
  definitions['static:'+'b'.repeat(32)]=block;definitions['static:'+'c'.repeat(32)]=parts;definitions['static:'+'d'.repeat(32)]=shellList;
  definitions['pitch:'+'e'.repeat(32)]=limits;definitions['armor:'+key]=table;
  const own=plain(await ctx.ArmorInspectorData.battle('own'));
  requested.length=0;
  const first=plain(await ctx.ArmorInspectorData.battle('store1'));
  assert.deepEqual(first.hits,own.hits,'the store battle expands to the very hits of the self-contained one');
  assert.equal(first.hits[0].target.parts[0].armor.front.armor,100);assert.deepEqual(first.hits[1].target.parts[0].transform,[2,0]);
  assert.equal(first.sharedDefinitions,undefined);assert.equal(first.warnings,undefined);
  assert.equal(requested.filter(f=>f.indexOf('definitions/')===0).length,5,'each definition read once: '+requested.join());
  requested.length=0;
  await ctx.ArmorInspectorData.battle('store2');
  assert.deepEqual(requested,['data/battles/store2.js'],'a second battle of the same definitions reads none again: '+requested.join());
  // A definition missing from the store: the battle opens, names the key, its hits say what they lack.
  const gone='C#0:'+'f'.repeat(32);
  payloads.lost=Object.assign({},payloads.store1,{id:'lost',sharedDefinitions:{static:[pref,shells,gone],pitch:[pitch],armor:[key]},
    hits:[{type:'hit',id:'1',target:{vehicleRef:gone,worldTransform:[1]},points:[]}]});
  const lost=await ctx.ArmorInspectorData.battle('lost');
  assert.equal(lost.hits.length,1);
  assert.deepEqual(plain(lost.warnings),['Recorded definition unavailable: static '+gone]);
  assert.deepEqual(plain(lost.hits[0].warnings),['Recorded vehicle data unavailable: target']);
  // An offline reader expands from disk through the same rules (sharedTables with a synchronous loader).
  const raw=JSON.parse(JSON.stringify(payloads.store1)),D=ctx.ArmorInspectorData;
  assert.deepEqual(plain(D.expandBattle(raw,D.sharedTables(raw,(kind,name)=>JSON.parse(JSON.stringify(definitions[kind+':'+name]))))).hits,own.hits);
  console.log('PASS: legacy and compact battle data, shared tables, poses preserved, missing table warning, unsupported format rejected; the shared store: the same hits, each definition read once a session, a missing one named.');
})().catch(e=>{console.error(e);process.exitCode=1;});
