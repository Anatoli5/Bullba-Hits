/* Ordinary classic scripts work from file://; no fetch, server or storage API. */
(function () {
  'use strict';
  var pending=Object.create(null), models=Object.create(null), modelOrder=[], serial=0;
  function filename(key){
    if(key==='index')return 'data/index.js';
    if(/^battle:[-a-zA-Z0-9_]{1,100}$/.test(key))return 'data/battles/'+key.slice(7)+'.js';
    if(/^model:[a-f0-9]{64}$/.test(key))return 'data/models/'+key.slice(6)+'.js';
    // The vehicle browser: one catalogue of every client vehicle, and one file per exported vehicle.
    if(key==='vehicles')return 'data/vehicles.js';
    if(/^vehicle:[-a-zA-Z0-9_]{1,100}$/.test(key))return 'data/vehicles/'+key.slice(8)+'.js';
    throw new Error('Invalid record identifier');
  }
  function read(key,retryCount){
    if(pending[key])return pending[key].promise;
    var path;try{path=filename(key);}catch(e){return Promise.reject(e);}
    var entry={value:undefined,received:false,retries:retryCount||0}, script=document.createElement('script');
    entry.promise=new Promise(function(resolve,reject){
      function finish(error){clearTimeout(timer);script.remove();delete pending[key];if(error)reject(error);else resolve(entry.value);}
      var timer=setTimeout(function(){finish(new Error('Could not read the local file.'));},15000);
      script.onload=function(){finish(entry.received?null:new Error('Data file is corrupted: '+path));};
      // A momentary read failure (file being replaced by the recorder, browser hiccup) gets two retries before it is reported.
      script.onerror=function(){if(entry.retries<2){entry.retries++;clearTimeout(timer);script.remove();delete pending[key];setTimeout(function(){read(key,entry.retries).then(resolve,reject);},400);return;}finish(new Error('Not found '+path+'. Open Viewer.html from mods/configs/local.armor_inspector after running the game with the mod.'));};
      // A fresh URL avoids reusing a snapshot between polls.
      script.src=path+'?read='+Date.now()+'-'+(++serial);
    });
    pending[key]=entry;document.head.appendChild(script);return entry.promise;
  }
  // Expand only static armour tables. Per-hit poses/ammo stay on their records.
  // Each battle script is self-contained, including after a recorder restart.
  function expandBattle(value){
    if(!value||value.armorTableFormat===undefined)return value;
    if(value.armorTableFormat!==1)throw new Error('Unsupported battle armor format');
    var tables=value.armorTables||Object.create(null);
    (value.hits||[]).forEach(function(hit){
      ['attacker','target'].forEach(function(side){
        ((hit[side]||{}).parts||[]).forEach(function(part){
          if(!Object.prototype.hasOwnProperty.call(part,'armorRef'))return;
          var ref=part.armorRef;
          if(typeof ref==='string'&&/^[a-f0-9]{64}$/.test(ref)&&Object.prototype.hasOwnProperty.call(tables,ref)&&tables[ref]&&typeof tables[ref]==='object'&&!Array.isArray(tables[ref])){
            part.armor=tables[ref];
          }else{
            part.armor={};part.armorError='Recorded armor table unavailable';
            (hit.warnings||(hit.warnings=[])).push('Recorded armor table unavailable: '+(part.name||'?'));
          }
          delete part.armorRef;
        });
      });
    });
    delete value.armorTables;delete value.armorTableFormat;
    return value;
  }
  function receive(payload){
    if(!Array.isArray(payload)||payload.length!==2)return;
    var entry=pending[payload[0]];
    if(entry){entry.value=String(payload[0]).indexOf('battle:')===0?expandBattle(payload[1]):payload[1];entry.received=true;}
  }
  function model(key){
    var previous=modelOrder.indexOf(key);if(previous!==-1)modelOrder.splice(previous,1);
    modelOrder.push(key);
    while(modelOrder.length>16)delete models[modelOrder.shift()];
    if(!models[key])models[key]=read('model:'+key).catch(function(e){delete models[key];throw e;});
    return models[key];
  }
  // Models for the target of one hit. The hit need not be in the battle's list: the shooter/model swap
  // builds a synthetic hit whose target is the recorded attacker, and its parts load exactly the same way.
  function sceneFor(battle,hit){
    if(!hit)return Promise.reject(new Error('Hit not found'));
    var result={hit:hit,models:{},warnings:(battle.warnings||[]).concat(hit.warnings||[])},parts=(hit.target||{}).parts||[];
    return Promise.all(parts.map(function(part){
      if(part.modelError||!part.modelKey||!part.transform){result.warnings.push(part.name+': '+(part.modelError||'Model or part position not saved'));return;}
      return model(part.modelKey).then(function(data){
        if(data.kind!=='client-shot-collision'||!Array.isArray(data.groups)||!data.groups.some(function(g){return Array.isArray(g.indices)&&g.indices.length>=3;}))throw new Error('Invalid or empty model');
        result.models[String(part.id)]=data;
      }).catch(function(e){result.warnings.push(part.name+': '+e.message);});
    })).then(function(){
      // A gun/track without its hull is not a usable armour scene. Keep the
      // event, but withhold geometry and calculations until every part is ready.
      var extra=(hit.warnings||[]).indexOf('Additional vehicle parts are not yet rendered')!==-1;
      var complete=[0,1,2,3].every(function(id){return parts.some(function(p){return p.id===id;})&&!!result.models[String(id)];})&&parts.every(function(p){return !!result.models[String(p.id)];});
      if(!complete||extra){
        result.models={};result.geometryIncomplete=true;
        result.geometryError=extra?'This vehicle has unsupported collision parts.':'Complete vehicle model unavailable.';
        result.warnings.push(result.geometryError);
      }
      return result;
    });
  }
  function scene(battle,id){
    return sceneFor(battle,(battle.hits||[]).find(function(h){return h.id===id;}));
  }
  window.ArmorInspectorData={receive:receive,index:function(){return read('index');},battle:function(id){return read('battle:'+id);},vehicles:function(){return read('vehicles');},vehicle:function(id){return read('vehicle:'+id);},scene:scene,sceneFor:sceneFor};
}());
