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
  // A task of the page's one frame loop (web/frame.js), asking for the next frame for three seconds.
  var FL=window.BullbaFrame;
  if(FL){var sFrames=0,sStarted=null,sLast=0,sLongest=0,startTask=FL.task('stats','start',function(t){if(sStarted===null)sStarted=t;else sLongest=Math.max(sLongest,t-sLast);sLast=t;sFrames++;if(t-sStarted<3000)startTask.want();else{host.fps=Math.round(sFrames*1000/(t-sStarted));if(window.console)console.info('Bullba Hits host: '+host.fps+' frames/s over '+Math.round(t-sStarted)+' ms ('+(game?'game':'browser')+'), longest frame '+Math.round(sLongest)+' ms');}});startTask.want();}
  // THE STEADY FRAME RATE WHILE THE PAGE IS IN USE (28.09, steady-60). The line above covers the start only. Here a frame
  // clock runs only while something happens - host.activity(label) from the page (the aim loop: 'emulation'), a drag or
  // the wheel over the scene ('orbit'), the cursor over it ('hover') - and stops a second after the last of it, so an idle
  // page costs nothing. Every interval between two animation frames that saw activity is counted under the highest label
  // noted during it (orbit, then emulation, then hover); a stall inside the activity counts in full. Every FRAME_WINDOW ms
  // of counted frames one line goes to the console (game.log in the game): per label its seconds, frames/s, p95, p99 and
  // longest interval and how many exceeded 25 ms (1.5 frames at the game's 60 Hz). Going idle flushes what is left as one
  // line if it holds at least FRAME_FLUSH ms; less is carried into the next activity. A hidden page restarts the clock.
  // HOW THE PICTURE MOVES, NOT ONLY HOW OFTEN (28.09, frame-sync): the page gave 60 frames/s in the game and the rotation
  // still did not look smooth. Per label the same line now says, from the same frames:
  //   input   pointer events per frame (min/median/max), the samples coalesced in one event, the interval between those
  //           samples (the cadence the game forwards the pointer at) and the age of the newest one at the frame;
  //   camera  how evenly the picture moved: for each frame between two moving ones, how far its step lies from the mean of
  //           its neighbours' (0 = even; easing alone stays under ~0.1), median and p95, and the frames that repeated the
  //           last picture while the camera moved;
  //   ring    the same for the live aim ring (its centre and radius), and the largest radius change in one frame;
  //   slow    the worst intervals over 25 ms and what held them: 'page' with the largest named piece of the page's own work
  //           (a task of the frame loop, a named step such as a scene load, or a long task of the browser), or 'host' when
  //           the page was idle for most of it - the game did not ask for the frame.
  // Nothing is written per frame: numbers go into arrays that one line per window reads and empties.
  var FRAME_WINDOW=5000,FRAME_IDLE=1000,FRAME_FLUSH=1000,FRAME_RECENT=250,FRAME_LABELS=['orbit','emulation','hover'],SLOW_MS=25;
  var clockNow=window.performance&&performance.now?function(){return performance.now();}:function(){return Date.now();};
  var fr={task:null,last:null,lastNow:0,seen:-1e9,noted:{},lab:{},ms:0,
    ev:0,co:[],stamps:[],lastStamp:null,prevCost:0,prevTop:'',prevTopMs:0,view:new Float64Array(8),ring:new Float64Array(4),viewAt:0,long:[]};
  function freshLabel(){return {gaps:[],ev:[],co:[],cad:[],age:[],cam:[],ring:[],rad:0,slow:[]};}
  function frameReset(){fr.ms=0;FRAME_LABELS.forEach(function(k){fr.lab[k]=freshLabel();});}
  frameReset();
  host.frameLines=[];   // the lines logged so far, as data: for a harness (tests/page/frame_cost.cjs)
  function q(a,p){return a[Math.min(a.length-1,Math.floor(p/100*a.length))];}
  function r1(x){return Math.round(x*10)/10;}
  function r2(x){return Math.round(x*100)/100;}
  function sorted(a){return a.slice().sort(function(x,y){return x-y;});}
  // How evenly a run of per-frame steps moves: for a frame between two moving ones, |step - mean of the neighbours| / that mean.
  function evenness(steps){
    var j=[],repeats=0,eps=1e-6;
    for(var i=1;i+1<steps.length;i++){var a=steps[i-1],s=steps[i],b=steps[i+1];if(a<0||s<0||b<0)continue;var m=(a+b)/2;
      if(a>eps&&b>eps){if(s>eps)j.push(Math.abs(s-m)/m);else repeats++;}}
    j=sorted(j);return {n:j.length,p50:j.length?r2(q(j,50)):null,p95:j.length?r2(q(j,95)):null,repeats:repeats};
  }
  // The long tasks the browser reports (50 ms and more), kept for the slow intervals' attribution; nothing without the API.
  try{if(window.PerformanceObserver)new PerformanceObserver(function(list){if(!fr.task||fr.last===null)return;list.getEntries().forEach(function(e){if(fr.long.length<64)fr.long.push(e.startTime,e.duration);});}).observe({entryTypes:['longtask']});}catch(e){}
  function attribute(s){
    // The page's own work inside the interval: the tasks of the frame before it, the named steps, the long tasks.
    var named=s.top,namedMs=s.topMs,longMs=0;
    for(var i=0;i<fr.long.length;i+=2){var a=fr.long[i],d=fr.long[i+1];if(a+d>s.t0&&a<s.t1){longMs+=d;if(d>namedMs&&!s.noteMs){named='task';namedMs=d;}}}
    var busy=Math.max(s.cost+s.noteMs,longMs);
    return busy>=s.dt/2?Math.round(s.dt)+' page ('+named+' '+Math.round(namedMs)+')':Math.round(s.dt)+' host';
  }
  function frameFlush(){
    var parts=[],data={ms:Math.round(fr.ms),labels:{}};
    FRAME_LABELS.forEach(function(k){var L=fr.lab[k],a=sorted(L.gaps);if(!a.length)return;var sum=0,slow=0;for(var i=0;i<a.length;i++){sum+=a[i];if(a[i]>SLOW_MS)slow++;}
      var d={seconds:Math.round(sum/100)/10,fps:Math.round(a.length*1000/sum),p95:r1(q(a,95)),p99:r1(q(a,99)),longest:r1(a[a.length-1]),slow:slow,frames:a.length};
      var text=k+' '+d.seconds+' s: '+d.fps+' frames/s, p95 '+d.p95+' ms, p99 '+d.p99+' ms, longest '+d.longest+' ms, '+d.slow+' over 25 ms';
      if(L.ev.length&&L.co.length){var ev=sorted(L.ev),co=sorted(L.co),cad=sorted(L.cad),age=sorted(L.age);
        d.input={perFrame:[ev[0],q(ev,50),ev[ev.length-1]],coalesced:[q(co,50),co[co.length-1]],cadence:cad.length?[r1(q(cad,50)),r1(q(cad,95))]:null,age:age.length?[r1(q(age,50)),r1(q(age,95))]:null};
        text+='; input '+d.input.perFrame.join('/')+' per frame, '+d.input.coalesced[0]+' coalesced (max '+d.input.coalesced[1]+')'+(d.input.cadence?' every '+d.input.cadence[0]+' ms (p95 '+d.input.cadence[1]+')':'')+(d.input.age?', age '+d.input.age[0]+' ms (p95 '+d.input.age[1]+')':'');}
      var cam=evenness(L.cam);if(cam.n||cam.repeats){d.camera=cam;text+='; camera step off '+cam.p50+' (p95 '+cam.p95+'), '+cam.repeats+' repeated';}
      var ring=evenness(L.ring);if(ring.n||ring.repeats){d.ring=ring;d.ring.radius=r1(L.rad*100);text+='; ring step off '+ring.p50+' (p95 '+ring.p95+'), '+ring.repeats+' repeated, radius step max '+d.ring.radius+' %';}
      if(L.slow.length){L.slow.sort(function(x,y){return y.dt-x.dt;});d.slowWhy=L.slow.slice(0,3).map(attribute);text+='; slow: '+d.slowWhy.join(', ');}
      data.labels[k]=d;parts.push(text);});
    frameReset();fr.long.length=0;if(!parts.length)return;
    host.frameLines.push(data);if(host.frameLines.length>50)host.frameLines.shift();
    if(window.console)console.info('Bullba Hits frames ('+(game?'game':'browser')+'): '+parts.join('; '));
  }
  // The picture's step since the last frame that drew: the eye's move, the view direction's turn and the zoom's change as
  // metres at the orbit distance. -1 when there is nothing to compare yet.
  function viewStep(){
    var v=FL.view,o=fr.view,d=v[7]||1;if(!fr.viewAt){o.set(v);fr.viewAt=1;return -1;}
    var s=Math.hypot(v[0]-o[0],v[1]-o[1],v[2]-o[2])+d*Math.hypot(v[3]-o[3],v[4]-o[4],v[5]-o[5])+d*Math.abs(v[6]-o[6]);o.set(v);return s;
  }
  function ringStep(L){
    var v=FL.ring,o=fr.ring;if(!(v[3]>0)){o[3]=NaN;return -1;}if(!(o[3]>0)){o.set(v);return -1;}
    var dr=Math.abs(v[3]-o[3]),s=Math.hypot(v[0]-o[0],v[1]-o[1],v[2]-o[2])+dr;if(dr/v[3]>L.rad)L.rad=dr/v[3];o.set(v);return s;
  }
  function frameTick(t){
    var now=clockNow(),drew=FL.viewSerial===FL.serial;
    if(fr.last!==null){var dt=t-fr.last,label=null;
      for(var i=0;i<FRAME_LABELS.length&&!label;i++){var k=FRAME_LABELS[i];if(fr.noted[k]>=fr.lastNow-FRAME_RECENT)label=k;}
      if(label&&dt>0){var L=fr.lab[label];L.gaps.push(dt);fr.ms+=dt;
        L.ev.push(fr.ev);for(var c=0;c<fr.co.length;c++)L.co.push(fr.co[c]);
        var st=fr.stamps;for(var j=0;j<st.length;j++){var prev=j?st[j-1]:fr.lastStamp;if(prev!==null&&st[j]-prev>0&&st[j]-prev<100)L.cad.push(st[j]-prev);}
        if(st.length){var age=t-st[st.length-1];if(age>=0&&age<100)L.age.push(age);}
        // Steps per 16.7 ms of frame time: at the game's even 60 Hz the step itself, in a browser with uneven frames the motion.
        var per=16.667/dt,cs=drew?viewStep():0,rs=drew?ringStep(L):(fr.ring[3]>0?0:-1);
        L.cam.push(cs>0?cs*per:cs);L.ring.push(rs>0?rs*per:rs);
        if(dt>SLOW_MS&&L.slow.length<32){var notes=FL.notes,noteMs=0,top=fr.prevTop,topMs=fr.prevTopMs;
          for(var n=0;n<notes.length;n+=3){if(notes[n+1]+notes[n+2]>fr.last&&notes[n+1]<t){noteMs+=notes[n+2];if(notes[n+2]>topMs){top=notes[n];topMs=notes[n+2];}}}
          L.slow.push({dt:dt,t0:fr.last,t1:t,cost:fr.prevCost,noteMs:noteMs,top:top,topMs:topMs});}
        if(fr.ms>=FRAME_WINDOW)frameFlush();}}
    else{fr.viewAt=0;if(drew)viewStep();fr.ring.set(FL.ring);}
    if(fr.stamps.length)fr.lastStamp=fr.stamps[fr.stamps.length-1];
    fr.ev=0;fr.co.length=0;fr.stamps.length=0;FL.notes.length=0;
    // This frame's own tasks, for the next interval: their sum and the largest (the stats task itself is not in it yet).
    var costs=FL.costs,sum=0,topName='',topMs=0;for(var m=0;m<costs.length;m+=2){sum+=costs[m+1];if(costs[m+1]>topMs){topMs=costs[m+1];topName=costs[m];}}
    fr.prevCost=sum;fr.prevTop=topName;fr.prevTopMs=topMs;
    if(now-fr.seen>FRAME_IDLE){fr.last=null;fr.lastStamp=null;fr.viewAt=0;if(fr.ms>=FRAME_FLUSH)frameFlush();return;}
    fr.last=t;fr.lastNow=now;fr.task.want();
  }
  // One call per frame or event at most is cheap: a time stamp, and a frame asked for only when the clock is not running.
  host.activity=function(label){var now=clockNow();fr.noted[label]=now;fr.seen=now;if(!FL||document.hidden)return;if(!fr.task)fr.task=FL.task('stats','frames',frameTick);fr.task.want();};
  // Whether the user worked the scene within the last `ms` (an orbit, the aim loop, the cursor over it): background work of
  // the page (the Statistics log's pass) waits for a pause instead of putting a model load into a moving frame.
  host.busy=function(ms){return clockNow()-fr.seen<ms;};
  document.addEventListener('visibilitychange',function(){fr.last=null;fr.lastStamp=null;fr.viewAt=0;});
  function overScene(e){var vp=document.getElementById('viewport');return !!(vp&&e.target&&vp.contains(e.target));}
  // The pointer as the page receives it: one event per frame or fewer, each carrying the samples the browser coalesced.
  document.addEventListener('pointermove',function(e){if(!overScene(e))return;host.activity(e.buttons?'orbit':'hover');if(fr.last===null)return;
    var list=typeof e.getCoalescedEvents==='function'?e.getCoalescedEvents():null,n=list&&list.length?list.length:1;
    fr.ev++;fr.co.push(n);if(fr.stamps.length<64){if(list&&list.length)for(var i=0;i<list.length;i++)fr.stamps.push(list[i].timeStamp);else fr.stamps.push(e.timeStamp);}},{capture:true,passive:true});
  document.addEventListener('wheel',function(e){if(overScene(e))host.activity('orbit');},{capture:true,passive:true});
}());
