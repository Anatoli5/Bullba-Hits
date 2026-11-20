/* The pages' remembered settings (one owner for Viewer.html and the 3D replay player, web/playback.html): every control of
   a page's settings is kept in ONE localStorage object of that page, so nothing resets on the next opening, and a reset
   puts every control back to the default its HTML carries. Storage may be refused (the game's CEF, a private window, a
   full quota): every read and write is guarded and the page works without it. A stored value is applied to the control
   and then the control's OWN handler runs - the page is configured by the same code path a click would take, never by a
   second copy of it. Moved out of web/app.js (18.11.2026) when the player got its settings remembered too. */
(function(){
  'use strict';
  function value(el){return el.type==='checkbox'?el.checked:el.value;}
  // The default is what the HTML carries: defaultChecked, defaultValue, the option marked selected (or the first).
  function byDefault(el){
    if(el.type==='checkbox')return el.defaultChecked;
    if(el.tagName==='SELECT'){var picked=el.querySelector('option[selected]');return picked?picked.value:el.options.length?el.options[0].value:'';}
    return el.defaultValue;
  }
  // A stored value is taken only when it still fits the control: an option that exists, a number inside min..max, a real
  // boolean. Anything else falls back to the default.
  function valid(el,v){
    if(el.type==='checkbox')return typeof v==='boolean';
    if(typeof v!=='string'&&typeof v!=='number')return false;
    var text=String(v);
    if(el.tagName==='SELECT')return [].some.call(el.options,function(o){return o.value===text;});
    if(el.type==='range'||el.type==='number'){var n=Number(text);
      if(!isFinite(text===''?NaN:n))return false;
      return n>=(el.min===''?-Infinity:Number(el.min))&&n<=(el.max===''?Infinity:Number(el.max));}
    return true;
  }
  function set(el,v){if(el.type==='checkbox')el.checked=!!v;else el.value=String(v);}
  function run(el){var fn=(el.type==='range'&&el.oninput)||el.onchange||el.oninput;if(fn)fn.call(el);}
  // One page's store. o: key (the localStorage key), version (written as v), controls (the elements), and optionally
  // read(box) -> the values of a parsed box (the page's migrations; default box.values), legacy() -> values from an older
  // store when there is no box, extra() -> more fields written into the box, keep(el) -> false: the control is saved but
  // not restored, keepOnReset() -> true: a reset writes the box again at once (it holds more than these controls).
  function bind(o){
    var defaults={},timer=null;
    function stored(){
      var raw=null;try{raw=window.localStorage.getItem(o.key);}catch(e){}
      if(raw===null||raw===undefined)return null;
      try{var box=JSON.parse(raw);
        if(o.read)return o.read(box)||null;
        if(box&&box.values&&typeof box.values==='object')return box.values;}catch(e){}
      return null;
    }
    // The save is one write a moment after the last change, not one per event: a slider turned by the wheel sends an
    // 'input' per notch, and serialising every setting into localStorage (a synchronous disk write) on each of them made
    // the wheel stall (user, 24.09). Leaving the page writes a pending save at once.
    function saveNow(){
      if(timer!==null){window.clearTimeout(timer);timer=null;}
      var values={};o.controls.forEach(function(el){values[el.id]=value(el);});
      var box={v:o.version,values:values};
      if(o.extra){var more=o.extra();Object.keys(more).forEach(function(k){box[k]=more[k];});}
      try{window.localStorage.setItem(o.key,JSON.stringify(box));}catch(e){}
    }
    function save(){if(timer===null)timer=window.setTimeout(saveNow,300);}
    window.addEventListener('pagehide',function(){if(timer!==null)saveNow();});
    document.addEventListener('visibilitychange',function(){if(document.hidden&&timer!==null)saveNow();});
    function restore(){
      var s=stored(),migrated=false;
      if(!s&&o.legacy){s=o.legacy();migrated=!!s;}
      o.controls.forEach(function(el){
        defaults[el.id]=byDefault(el);
        if(s&&(!o.keep||o.keep(el))&&Object.prototype.hasOwnProperty.call(s,el.id)&&valid(el,s[el.id]))set(el,s[el.id]);
        run(el);
        // One shared listener per control instead of a save inside every handler; a programmatic change fires no
        // event, so a restore and a reset never write anything back.
        el.addEventListener('change',save);
        if(el.type==='range')el.addEventListener('input',save);
      });
      if(migrated)save();
    }
    function reset(){
      o.controls.forEach(function(el){set(el,defaults[el.id]);run(el);});
      if(timer!==null){window.clearTimeout(timer);timer=null;}
      try{window.localStorage.removeItem(o.key);}catch(e){}
      if(o.keepOnReset&&o.keepOnReset())save();
    }
    // peek(el): the control's remembered value (else its HTML default) before restore runs - a page that needs one
    // setting early (the replay viewer's special-mode warning, 20.11). remember(el, v): that one value written into the
    // stored box at once, the rest of the box left as it is (a saveNow before restore would write every default).
    function peek(el){var s=stored();return s&&Object.prototype.hasOwnProperty.call(s,el.id)&&valid(el,s[el.id])?s[el.id]:byDefault(el);}
    function remember(el,v){
      var box=null;try{box=JSON.parse(window.localStorage.getItem(o.key));}catch(e){}
      if(!box||typeof box!=='object'||!box.values||typeof box.values!=='object')box={v:o.version,values:{}};
      box.values[el.id]=v;
      try{window.localStorage.setItem(o.key,JSON.stringify(box));}catch(e){}
    }
    return {restore:restore,save:save,saveNow:saveNow,reset:reset,defaults:defaults,peek:peek,remember:remember};
  }
  window.BullbaSettings={bind:bind,value:value,byDefault:byDefault,valid:valid,set:set,run:run};
})();
