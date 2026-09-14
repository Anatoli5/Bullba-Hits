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
        catch(e){host.mark(action,'error: '+e.message);if(window.console)console.error('Bullba Hits: '+action,e);var m=document.getElementById('scene-message');if(m){m.textContent='Error during “'+action+'»: '+e.message;m.hidden=false;}}
      }
      if(game)window.setTimeout(run,0);else run();
    };
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
  if(window.requestAnimationFrame){var frames=0,started=null;window.requestAnimationFrame(function tick(t){if(started===null)started=t;frames++;if(t-started<3000)window.requestAnimationFrame(tick);else{host.fps=Math.round(frames*1000/(t-started));if(window.console)console.info('Bullba Hits host: '+host.fps+' frames/s over '+Math.round(t-started)+' ms ('+(game?'game':'browser')+')');}});}
}());
