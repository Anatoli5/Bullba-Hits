/* host.upload and the bridge probe (BACKLOG 131, stage 0) with window.jsHostQuery stubbed as the mod. No browser, no game.
   The stand-in decodes the chunks as the mod's page_upload.py does (base64, in order, size and CRC32) and answers through
   the persistent 'uploadListen' query - one of the paths the real reply may take. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),zlib=require('node:zlib');

function load(hash,store){
  const sandbox={console,setTimeout,clearTimeout,Promise,JSON,Event:function(){},performance,btoa,atob,Date};
  sandbox.window=sandbox;
  sandbox.location={hash:hash,search:''};
  sandbox.navigator={userAgent:'test'};
  sandbox.screen={width:1920,height:1080};
  const data=store||{};
  sandbox.localStorage={getItem:k=>k in data?data[k]:null,setItem:(k,v)=>{data[k]=String(v);},removeItem:k=>{delete data[k];}};
  sandbox.loads=[];
  sandbox.addEventListener=(name,fn)=>{if(name==='load')sandbox.loads.push(fn);};
  const root={setAttribute(){}};
  sandbox.document={documentElement:root,readyState:'complete',addEventListener(){},
    querySelectorAll:()=>[],getElementById:()=>null,body:{appendChild(){}},createElement:()=>({style:{}})};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('web/host.js','utf8'),sandbox);
  return sandbox;
}

// A stand-in mod: every query answered 'Success' at once (as the browser process does), the mod's answers on the listener.
function mod(win,opts){
  opts=opts||{};
  const m={uploads:{},actions:[],listener:null,reports:[]};
  function reply(data){if(m.listener&&!opts.silent)setTimeout(()=>m.listener.onSuccess(JSON.stringify({command:'bullba_hits',data,web_id:'x'})),0);}
  win.jsHostQuery=q=>{
    const req=JSON.parse(q.request),p=req.params;m.actions.push(p.action);
    if(p.action==='uploadListen'){assert.equal(q.persistent,true);m.listener=q;reply({listen:true});return;}
    if(opts.throwAt!==undefined&&p.action==='upload'&&p.index===opts.throwAt)throw new Error('router gone');
    if(opts.failAt!==undefined&&p.action==='upload'&&p.index===opts.failAt){q.onFailure(-1,'too big');return;}
    if(!opts.noAnswer)setTimeout(()=>q.onSuccess('Success'),0);
    if(p.action==='upload'){
      let u=m.uploads[p.upload];
      if(!u)u=m.uploads[p.upload]={parts:[],count:p.count,size:p.size,digest:p.digest,state:'open',chars:0};
      assert.equal(p.index,u.parts.length,'chunks in order');
      assert.equal(typeof p.sent,'number');
      u.chars=Math.max(u.chars,p.data.length);
      u.parts.push(Buffer.from(p.data,'base64'));
      if(u.parts.length===u.count){const all=Buffer.concat(u.parts);
        u.bytes=all;u.state=all.length===u.size&&'crc32:'+(zlib.crc32?zlib.crc32(all):win.BullbaHost.crc32(all)).toString(16).padStart(8,'0')===u.digest?'done':'failed';}
      reply({upload:p.upload,index:p.index,state:'received'});
    }
    if(p.action==='uploadStatus'){const u=m.uploads[p.upload];reply({upload:p.upload,state:u?u.state:'unknown',chunks:u?u.parts.length:0});}
    if(p.action==='uploadReport')m.reports.push(p);
  };
  return m;
}

(async()=>{
  // 1. CRC32 against the standard vector and node's zlib; base64 cut on whole 3-byte groups.
  const w=load('#host=game');
  assert.equal(w.BullbaHost.crc32(new Uint8Array(Buffer.from('123456789'))),0xcbf43926);
  const sample=w.BullbaHost.probeData(100003);
  if(zlib.crc32)assert.equal(w.BullbaHost.crc32(sample),zlib.crc32(Buffer.from(sample)));
  assert.equal(w.BullbaHost.chunkBytes(262144),196608);
  assert.equal(w.BullbaHost.chunkBytes(1048576),786432);

  // 2. Byte-equal reassembly over the chunk boundaries.
  const chars=16;const per=w.BullbaHost.chunkBytes(chars);
  for(const n of [0,1,2,3,per-1,per,per+1,5*per+2]){
    const win=load('#host=game'),m=mod(win),bytes=win.BullbaHost.probeData(n);
    const res=await win.BullbaHost.upload('probe',bytes,{chunkChars:chars,ackWait:500,statusWait:2000});
    const u=m.uploads[res.upload];
    assert.equal(res.state,'done',n+' bytes: '+res.error);
    assert.equal(res.count,Math.max(1,Math.ceil(n/per)));
    assert.equal(res.sentChunks,res.count);
    assert.ok(u.chars<=chars);
    assert.deepEqual([...u.bytes],[...bytes],n+' bytes come back equal');
    assert.equal(res.replies,res.count,'every chunk answered on the listener');
    assert.equal(res.replyVia.listen>=res.count,true);
    assert.equal(res.ackTimeouts,0);
  }

  // 3. Failures end the upload with the reason and never throw or hang.
  for(const [opts,match] of [[{failAt:2},/too big/],[{throwAt:1},/router gone/]]){
    const win=load('#host=game');mod(win,opts);
    const res=await win.BullbaHost.upload('probe',win.BullbaHost.probeData(200),{chunkChars:16,ackWait:200,statusWait:300});
    assert.equal(res.state,'failed');assert.match(res.error,match);
  }
  // No answer to any query and none from the mod: the first wait runs out, the rest go without waiting, the status wait ends.
  {
    const win=load('#host=game');const m=mod(win,{noAnswer:true,silent:true});
    const t=Date.now();
    const res=await win.BullbaHost.upload('probe',win.BullbaHost.probeData(200),{chunkChars:16,ackWait:100,statusWait:300});
    assert.equal(res.state,'sent, no status answer');assert.equal(res.ackTimeouts,1);assert.equal(res.sentChunks,res.count);
    assert.ok(Date.now()-t<3000,'bounded');assert.ok(m.actions.filter(a=>a==='uploadStatus').length>=1);
  }
  // Without the channel nothing is attempted.
  {const win=load('#nothing');const res=await win.BullbaHost.upload('probe',new Uint8Array(10));assert.equal(res.state,'failed');}

  // 4. The probe: only when the mod asks and once per profile; two runs, each report before the next run's chunks.
  {
    const quietStore={},quiet=load('#host=game',quietStore),base=quiet.loads.length;
    assert.deepEqual(quietStore,{},'no probe without the mod asking');
    const store={};
    const win=load('#host=game&vehicle=x&probe=upload',store);mod(win);
    assert.equal(win.loads.length,base+1);assert.ok(store['bullba-upload-probe-1'],'the flag is set before anything is sent');
    const again=load('#host=game&probe=upload',store);assert.equal(again.loads.length,base,'once per profile');
    const m=mod(win);
    const results=await win.BullbaHost.runUploadProbe({bytes:50000,runs:[400,1600],ackWait:200,statusWait:2000});
    assert.equal(results.map(r=>r.state).join(),'done,done');
    assert.equal(results.map(r=>r.chunkChars).join(),'400,1600');
    assert.equal(m.reports.length,2);
    const firstReport=m.actions.indexOf('uploadReport'),secondUpload=m.actions.lastIndexOf('upload')-results[1].count+1;
    assert.ok(firstReport<secondUpload,'the first run is reported before the second starts');
    assert.equal(m.reports[0].report.next,'1600-char chunks');assert.equal(m.reports[1].report.next,'none');
    assert.match(m.reports[0].report.compression,/CompressionStream|deflate/);
    assert.equal(m.reports[0].report.state,'done');
  }
  // 5. The CompressionStream test with node's own streams (the game's CEF 109 is the real case).
  if(typeof CompressionStream==='function'){
    const win=load('#host=game');Object.assign(win,{CompressionStream,DecompressionStream,Response,Blob,TextEncoder});
    const text=await win.BullbaHost.compressionProbe();
    assert.match(text,/^deflate yes, deflate-raw yes, gzip yes; 1048576 -> \d+ bytes in \d+ ms, round trip ok$/);
  }
  console.log('ok   test_page_upload: crc32, chunk boundaries, failures bounded, probe once with two runs');
})().catch(e=>{console.error(e);process.exit(1);});
