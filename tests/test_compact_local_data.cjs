/* Narrow in-memory classic-script adapter checks; no browser or server. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const key='a'.repeat(64), table={front:{armor:100,useHitAngle:true}};
const payloads={};
const ctx={Promise,Date,setTimeout,clearTimeout,console};ctx.window=ctx;
ctx.document={createElement(){return {remove(){}};},head:{appendChild(script){
  const id=script.src.split('/').pop().split('?')[0].slice(0,-3);
  setImmediate(()=>{try{ctx.ArmorInspectorData.receive(['battle:'+id,JSON.parse(JSON.stringify(payloads[id]))]);script.onload();}catch(e){script.onload();}});
}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/local-data.js','utf8'),ctx);
function hit(part){return {type:'hit',id:'1',target:{parts:[part]},points:[{position:[1,2,3]}]};}
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
  console.log('PASS: legacy and compact battle data, shared tables, poses preserved, missing table warning, unsupported format rejected.');
})().catch(e=>{console.error(e);process.exitCode=1;});
