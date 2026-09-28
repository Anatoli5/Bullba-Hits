/* Host detection, crash breadcrumbs and popup-free choice lists. Local page state only; no server, service or file writes. */
(function(){
  'use strict';
  var game=/(^|[#&?])host=game(&|$)/.test(window.location.hash+window.location.search);
  document.documentElement.setAttribute('data-host',game?'game':'browser');
  var KEY='bullba-last-action';
  function read(){try{return JSON.parse(window.localStorage.getItem(KEY));}catch(e){return null;}}
  function write(value){try{if(value)window.localStorage.setItem(KEY,JSON.stringify(value));else window.localStorage.removeItem(KEY);}catch(e){}}
  var previous=read();
  var host={game:game,interrupted:previous&&previous.stage==='start'?previous:null};
  host.mark=function(action,stage){write({action:action,stage:stage,at:Date.now(),host:game?'game':'browser',agent:String(window.navigator.userAgent||'').slice(0,160),href:String(window.location.href).slice(-80)});};
  host.done=function(){write(null);};
  // The fragment carries key=value pairs joined by '&': '#host=game&vehicle=germany-G42_Maus'.
  // Values are percent-decoded; a malformed escape is kept raw instead of throwing.
  host.params=function(){
    var out={};String(window.location.hash||'').replace(/^#/,'').split('&').forEach(function(pair){
      if(!pair)return;var i=pair.indexOf('='),k=i<0?pair:pair.slice(0,i),v=i<0?'':pair.slice(i+1);
      try{out[decodeURIComponent(k)]=decodeURIComponent(v);}catch(e){out[k]=v;}
    });return out;
  };
  // The breadcrumb names the last risky action if the browser dies before it
  // finishes. In the game the work is deferred one tick so the list closes and
  // the frame is presented before the heavy synchronous rebuild starts.
  host.guard=function(action,fn){
    return function(){
      if(this&&this.disabled)return;
      var self=this,args=arguments;host.mark(action,'start');
      function run(){
        try{fn.apply(self,args);host.mark(action,'done');}
        catch(e){host.mark(action,'error: '+e.message);if(window.console)console.error('Bullba Hits: '+action,e);var m=document.getElementById('scene-message');if(m){m.textContent='Error during “'+action+'»: '+e.message;m.hidden=false;m.classList.remove('busy');}}
      }
      if(game)window.setTimeout(run,0);else run();
    };
  };
  // ---- page -> mod ------------------------------------------------------
  // The game's CEF registers the message-router functions window.jsHostQuery /
  // window.jsHostQueryCancel (the names are literals in cef_browser_process.exe,
  // beside browser_process\cef_handler.cpp). The request string reaches
  // WebBrowser.onJsHostQuery, then the client's own w2c WebCommandHandler, which
  // looks the command name up among the handlers the mod passed to
  // BrowserController.load(handlers=[...]). Outside the game the function does not
  // exist, so host.canSend() is false and nothing is attempted.
  var sendId=0;
  host.canSend=function(){return !!(game&&typeof window.jsHostQuery==='function');};
  host.send=function(command,params){
    return new Promise(function(resolve,reject){
      if(!host.canSend())return void reject(new Error('The game browser offers no jsHostQuery channel'));
      var payload;
      try{payload=JSON.stringify({command:command,params:params||{},web_id:'bullba-'+(++sendId)});}catch(e){return void reject(e);}
      try{window.jsHostQuery({request:payload,persistent:false,
        onSuccess:function(response){resolve(response);},
        onFailure:function(code,text){reject(new Error('jsHostQuery failed ('+code+'): '+text));}});}
      catch(e){reject(e);}
    });
  };
  window.BullbaHost=host;
  // The game's CEF renders offscreen; a native <select> popup is a separate
  // window it may not support. An ordinary DOM list replaces the popup while the
  // <select> stays the value holder and event source for the rest of the page.
  var open=null;
  function close(){if(open){if(open.list.parentNode)open.list.parentNode.removeChild(open.list);open.select.setAttribute('aria-expanded','false');open=null;}}
  function show(select){
    close();var options=Array.prototype.slice.call(select.options);if(!options.length||select.disabled)return;
    var list=document.createElement('div');list.className='choice-list';list.setAttribute('role','listbox');
    options.forEach(function(option){
      var item=document.createElement('button');item.type='button';item.className='choice-item';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.disabled=option.disabled;item.textContent=option.textContent;
      item.onclick=function(){var value=option.value;close();if(select.value!==value){select.value=value;select.dispatchEvent(new Event('change'));}select.focus();};
      list.appendChild(item);
    });
    list.onkeydown=function(e){
      var items=Array.prototype.slice.call(list.querySelectorAll('.choice-item:not(:disabled)')),index=items.indexOf(document.activeElement);
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();var next=items[Math.max(0,Math.min(items.length-1,index+(e.key==='ArrowDown'?1:-1)))];if(next)next.focus();}
      else if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();close();select.focus();}
    };
    var rect=select.getBoundingClientRect();list.style.left=Math.max(4,rect.left)+'px';list.style.top=(rect.bottom+2)+'px';list.style.minWidth=Math.round(rect.width)+'px';
    document.body.appendChild(list);
    var height=list.offsetHeight;if(rect.bottom+2+height>window.innerHeight&&rect.top-height-2>0)list.style.top=(rect.top-height-2)+'px';
    select.setAttribute('aria-expanded','true');open={select:select,list:list};
    var current=list.querySelector('[aria-selected="true"]:not(:disabled)')||list.querySelector('.choice-item:not(:disabled)');if(current)current.focus();
  }
  function install(select){
    if(select.getAttribute('data-choice'))return;select.setAttribute('data-choice','list');
    select.addEventListener('mousedown',function(e){if(e.button!==0)return;e.preventDefault();if(open&&open.select===select)close();else{select.focus();show(select);}});
    select.addEventListener('keydown',function(e){if(e.key===' '||e.key==='Enter'||e.key==='F4'||(e.altKey&&(e.key==='ArrowDown'||e.key==='ArrowUp'))){e.preventDefault();if(open&&open.select===select)close();else show(select);}});
  }
  document.addEventListener('mousedown',function(e){if(open&&!open.list.contains(e.target)&&e.target!==open.select)close();},true);
  document.addEventListener('keydown',function(e){if(open&&e.key==='Escape'){var select=open.select;close();select.focus();}},true);
  window.addEventListener('resize',close);window.addEventListener('blur',close);
  function ready(){if(game)Array.prototype.forEach.call(document.querySelectorAll('select'),install);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
  host.installChoice=install;
  // One three-second frame-rate sample; the number lands in the console (game.log in the game) and in host.fps.
  host.fps=null;
  // Window geometry and drag events, for comparing the game's browser with a desktop one via game.log.
  function geometry(){var vp=document.getElementById('viewport'),c=vp&&vp.querySelector('canvas'),r=vp&&vp.getBoundingClientRect(),vv=window.visualViewport;
    return 'window '+window.innerWidth+'x'+window.innerHeight+' outer '+window.outerWidth+'x'+window.outerHeight+' dpr '+window.devicePixelRatio+' screen '+window.screen.width+'x'+window.screen.height+(vv?' visual '+Math.round(vv.width)+'x'+Math.round(vv.height)+' scale '+vv.scale:'')+(vp?' viewport '+vp.clientWidth+'x'+vp.clientHeight+' rect '+Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height):'')+(c?' canvas '+c.width+'x'+c.height+' css '+c.clientWidth+'x'+c.clientHeight:'');}
  host.geometry=geometry;
  function logGeometry(tag){if(window.console)console.info('Bullba Hits host geometry ('+tag+'): '+geometry());}
  window.addEventListener('load',function(){window.setTimeout(function(){logGeometry('load');},1500);});
  var resizeTimer=null;window.addEventListener('resize',function(){window.clearTimeout(resizeTimer);resizeTimer=window.setTimeout(function(){logGeometry('resize');},500);});
  var pointerLogged=0,lastMove=0;
  document.addEventListener('pointermove',function(e){if(pointerLogged>=4||!e.buttons)return;var vp=document.getElementById('viewport');if(!vp||!vp.contains(e.target))return;pointerLogged++;var now=window.performance?performance.now():Date.now();
    if(window.console)console.info('Bullba Hits host pointer: '+e.pointerType+' buttons '+e.buttons+' client '+Math.round(e.clientX)+','+Math.round(e.clientY)+' movement '+e.movementX+','+e.movementY+' dt '+(lastMove?Math.round(now-lastMove):0)+' ms');lastMove=now;},true);
  // The sample starts with the page and so takes in the first scene's shader compile, a stall of one to three seconds on
  // the D3D11 path (27.09: 0.8.7 read 1-2 frames/s for it); the longest frame says how much of the sample it was.
  if(window.requestAnimationFrame){var frames=0,started=null,last=0,longest=0;window.requestAnimationFrame(function tick(t){if(started===null)started=t;else longest=Math.max(longest,t-last);last=t;frames++;if(t-started<3000)window.requestAnimationFrame(tick);else{host.fps=Math.round(frames*1000/(t-started));if(window.console)console.info('Bullba Hits host: '+host.fps+' frames/s over '+Math.round(t-started)+' ms ('+(game?'game':'browser')+'), longest frame '+Math.round(longest)+' ms');}});}
  // THE STEADY FRAME RATE WHILE THE PAGE IS IN USE (28.09, steady-60). The line above covers the start only. Here a frame
  // clock runs only while something happens - host.activity(label) from the page (the aim loop: 'emulation'), a drag or
  // the wheel over the scene ('orbit'), the cursor over it ('hover') - and stops a second after the last of it, so an idle
  // page costs nothing. Every interval between two animation frames that saw activity is counted under the highest label
  // noted during it (orbit, then emulation, then hover); a stall inside the activity counts in full. Every FRAME_WINDOW ms
  // of counted frames one line goes to the console (game.log in the game): per label its seconds, frames/s, p95, p99 and
  // longest interval and how many exceeded 25 ms (1.5 frames at the game's 60 Hz). Going idle flushes what is left as one
  // line if it holds at least FRAME_FLUSH ms; less is carried into the next activity. A hidden page restarts the clock.
  var FRAME_WINDOW=5000,FRAME_IDLE=1000,FRAME_FLUSH=1000,FRAME_RECENT=250,FRAME_LABELS=['orbit','emulation','hover'];
  var clockNow=window.performance&&performance.now?function(){return performance.now();}:function(){return Date.now();};
  var fr={loop:0,last:null,lastNow:0,seen:-1e9,noted:{},gaps:{},ms:0};
  function frameReset(){fr.ms=0;FRAME_LABELS.forEach(function(k){fr.gaps[k]=[];});}
  frameReset();
  host.frameLines=[];   // the lines logged so far, as data: for a harness (tests/page/frame_cost.cjs)
  function q(a,p){return a[Math.min(a.length-1,Math.floor(p/100*a.length))];}
  function frameFlush(){
    var parts=[],data={ms:Math.round(fr.ms),labels:{}};
    FRAME_LABELS.forEach(function(k){var a=fr.gaps[k];if(!a.length)return;a.sort(function(x,y){return x-y;});var sum=0,slow=0;for(var i=0;i<a.length;i++){sum+=a[i];if(a[i]>25)slow++;}
      var d={seconds:Math.round(sum/100)/10,fps:Math.round(a.length*1000/sum),p95:Math.round(q(a,95)*10)/10,p99:Math.round(q(a,99)*10)/10,longest:Math.round(a[a.length-1]*10)/10,slow:slow,frames:a.length};data.labels[k]=d;
      parts.push(k+' '+d.seconds+' s: '+d.fps+' frames/s, p95 '+d.p95+' ms, p99 '+d.p99+' ms, longest '+d.longest+' ms, '+d.slow+' over 25 ms');});
    frameReset();if(!parts.length)return;
    host.frameLines.push(data);if(host.frameLines.length>50)host.frameLines.shift();
    if(window.console)console.info('Bullba Hits frames ('+(game?'game':'browser')+'): '+parts.join('; '));
  }
  function frameTick(t){
    fr.loop=0;var now=clockNow();
    if(fr.last!==null){var dt=t-fr.last,label=null;
      for(var i=0;i<FRAME_LABELS.length&&!label;i++){var k=FRAME_LABELS[i];if(fr.noted[k]>=fr.lastNow-FRAME_RECENT)label=k;}
      if(label&&dt>0){fr.gaps[label].push(dt);fr.ms+=dt;if(fr.ms>=FRAME_WINDOW)frameFlush();}}
    if(now-fr.seen>FRAME_IDLE){fr.last=null;if(fr.ms>=FRAME_FLUSH)frameFlush();return;}
    fr.last=t;fr.lastNow=now;fr.loop=window.requestAnimationFrame(frameTick);
  }
  // One call per frame or event at most is cheap: a time stamp, and a frame asked for only when the clock is not running.
  host.activity=function(label){var now=clockNow();fr.noted[label]=now;fr.seen=now;if(!fr.loop&&window.requestAnimationFrame&&!document.hidden)fr.loop=window.requestAnimationFrame(frameTick);};
  document.addEventListener('visibilitychange',function(){fr.last=null;});
  function overScene(e){var vp=document.getElementById('viewport');return !!(vp&&e.target&&vp.contains(e.target));}
  document.addEventListener('pointermove',function(e){if(overScene(e))host.activity(e.buttons?'orbit':'hover');},{capture:true,passive:true});
  document.addEventListener('wheel',function(e){if(overScene(e))host.activity('orbit');},{capture:true,passive:true});
}());
