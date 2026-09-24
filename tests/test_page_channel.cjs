/* host.send: the page -> mod command, with window.jsHostQuery stubbed. No browser, no game. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');

function load(hash,query){
  const sandbox={console,setTimeout,clearTimeout,Promise,JSON,Event:function(){},performance};
  sandbox.window=sandbox;
  sandbox.location={hash:hash,search:query||''};
  sandbox.navigator={userAgent:'test'};
  sandbox.screen={width:1920,height:1080};
  sandbox.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  sandbox.addEventListener=()=>{};
  const root={setAttribute(){}};
  sandbox.document={documentElement:root,readyState:'complete',addEventListener(){},
    querySelectorAll:()=>[],getElementById:()=>null,body:{appendChild(){}},createElement:()=>({style:{}})};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('web/host.js','utf8'),sandbox);
  return sandbox;
}

// 1. In the browser there is no channel at all.
const web=load('#nothing');
assert.equal(web.BullbaHost.game,false);
assert.equal(web.BullbaHost.canSend(),false);
web.jsHostQuery=()=>assert.fail('the browser must never call the game channel');
assert.equal(web.BullbaHost.canSend(),false,'the channel needs the game host, not just the function');

// 2. In the game without the CEF function: canSend is false and send rejects, it never throws.
const bare=load('#host=game');
assert.equal(bare.BullbaHost.game,true);
assert.equal(bare.BullbaHost.canSend(),false);

// 3. In the game with the CEF message-router function present.
const game=load('#host=game&vehicle=germany-G42_Maus');
const seen=[];
game.jsHostQuery=q=>{seen.push(q);q.onSuccess('Success');};
assert.equal(game.BullbaHost.canSend(),true);

const checks=[];
checks.push(bare.BullbaHost.send('bullba_hits',{action:'exportVehicle',vehicleType:'germany:G42_Maus'})
  .then(()=>assert.fail('send must reject without the channel'),e=>assert.match(e.message,/jsHostQuery/)));

checks.push(game.BullbaHost.send('bullba_hits',{action:'exportVehicle',vehicleType:'germany:G42_Maus'})
  .then(response=>{
    assert.equal(response,'Success');
    assert.equal(seen.length,1);
    assert.equal(seen[0].persistent,false);
    const sent=JSON.parse(seen[0].request);
    assert.equal(sent.command,'bullba_hits','the command name the mod registers with createCommandHandler');
    assert.deepEqual(sent.params,{action:'exportVehicle',vehicleType:'germany:G42_Maus'});
    assert.equal(typeof sent.web_id,'string');
    assert.deepEqual(Object.keys(sent).sort(),['command','params','web_id'],'exactly the WebCommandSchema fields');
  }));

// 4. A failing query is reported, not swallowed.
const failing=load('#host=game');
failing.jsHostQuery=q=>q.onFailure(7,'no handler');
checks.push(failing.BullbaHost.send('bullba_hits',{action:'exportVehicle'})
  .then(()=>assert.fail('a failed query must reject'),e=>assert.match(e.message,/\(7\): no handler/)));

// 5. A throwing query is reported too.
const throwing=load('#host=game');
throwing.jsHostQuery=()=>{throw new Error('view is gone');};
checks.push(throwing.BullbaHost.send('bullba_hits',{action:'exportVehicle'})
  .then(()=>assert.fail('a throwing query must reject'),e=>assert.equal(e.message,'view is gone')));

Promise.all(checks).then(()=>console.log('PASS host.send: 5 cases (browser, game without the channel, game with it, failure, throw)'),
  e=>{console.error(e);process.exit(1);});
