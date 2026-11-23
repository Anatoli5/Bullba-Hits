/* Cheap cross-page routing/state regression. No browser or renderer. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const route = require('../web/shot-route.js');
const row = (index, id, times) => ({shot:{index,shotId:id},hits:times.map((t,i)=>({t,attacker:7,target:9,index:index*10+i}))});
const rapid = [row(0,'100',[10]), row(1,'101',[10,10.1])];
const link = {at:1010,attacker:7,target:9,focus:7,shotId:'101',shotIndex:1};
assert.deepEqual(route.parse(route.encode(link)),link);
assert.equal(route.parse('1010,7,9,7,bad'),null);
assert.equal(route.match(rapid,link,1000).row,rapid[1]);
assert.equal(route.match(rapid,{...link,shotId:'missing'},1000).row,null);
assert.equal(route.match(rapid,{at:1010,attacker:7,target:9,focus:9},1000).row,null);
assert.equal(route.match([rapid[1]],{at:1010,attacker:7,target:9,focus:9},1000).row,rapid[1]);
assert.equal(route.match(rapid,{at:1010.1,attacker:7,target:9,focus:9},1000).row,rapid[1]);
assert.equal(route.match(rapid,{...link,target:8},1000).row,null);
assert.equal(route.match(rapid,link,NaN).row,null);

// Real shared icon widget: both activation paths isolate their parent row.
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.classList={add:()=>{}};}
  appendChild(e){this.children.push(e);return e;}
  setAttribute(k,v){this.attrs[k]=v;}
}
const dom = {window:{},document:{createElement:t=>new Element(t)}};
vm.runInNewContext(fs.readFileSync(path.join(root,'web/hit-rows.js'),'utf8'),dom);
let opened=0,stopped=0,prevented=0;
const icon=dom.window.BullbaRows.openLink('Open shot','Replays\nPlays the shot.',()=>opened++,'span','replays-icon.png');
const event={stopPropagation(){stopped++;},preventDefault(){prevented++;},key:'Enter'};
icon.onclick(event);icon.onkeydown(event);event.key=' ';icon.onkeydown(event);
assert.equal(opened,3);assert.equal(stopped,3);assert.equal(prevented,3);
assert.equal(icon.attrs['aria-label'],'Open shot');assert.equal(icon.children[0].src,'replays-icon.png');

// Exercise the actual selector preflight: cancellation never navigates; acceptance
// carries the pending episode; a second selection supersedes the first.
const source=fs.readFileSync(path.join(root,'web/playback/playback.js'),'utf8');
const choose=source.slice(source.indexOf('  function choose('),source.indexOf('  function navigate('));
const state={Promise,choiceToken:0,BID:'current',entryMetadata:Promise.resolve(),params:{},
  $:()=>({value:''}),sessionStorage:{setItem(){}},navigated:[],opened:0,
  candidateMode:()=>Promise.resolve({name:'Steel Hunter'}),
  finishMode(){if(this.pending){this.pending(false);this.pending=null;}},
  confirmMode(){return new Promise(resolve=>{state.pending=resolve;});},
  navigate(id,shot){state.navigated.push([id,shot]);},openShotParam(){state.opened++;}};
// Bare JS calls do not bind methods to their context in strict mode.
state.finishMode=()=>{if(state.pending){state.pending(false);state.pending=null;}};
vm.createContext(state);vm.runInContext(choose,state);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  state.choose('event',route.encode(link));await flush();state.pending(false);await flush();assert.equal(state.navigated.length,0);
  state.choose('event',route.encode(link));await flush();state.choose('other','1010,7,9,9');await flush();state.pending(true);await flush();
  assert.deepEqual(state.navigated,[['other','1010,7,9,9']]);
  state.choose('current',route.encode(link));assert.equal(state.opened,1);assert.equal(state.params.shot,route.encode(link));
  const app=fs.readFileSync(path.join(root,'web/app.js'),'utf8');
  assert.ok(app.includes('if(h.id!==selected||poseDetached)return;'));
  assert.ok(app.includes('openPlayback(b.id,null)'));
  assert.ok(!app.includes("sendCommand('replayKeep'"));assert.ok(!app.includes("sendCommand('replayLimit'"));
  for(const asset of ['menu-icon.png','replays-icon.png','shot-route.js']){
    assert.ok(fs.existsSync(path.join(root,'web',asset)));
    assert.ok(fs.readFileSync(path.join(root,'mod/local_armor_inspector/exporter.py'),'utf8').includes("'web/"+asset+"'"));
  }
  console.log(JSON.stringify({ok:true,routing:true,icons:true,preflight:true,selectedOnly:true,assets:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
