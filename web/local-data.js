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
    // The characteristics of a vehicle type (23.09): every turret and gun on the top modules, one file per type.
    if(/^ttx:[-a-zA-Z0-9_]{1,100}$/.test(key))return 'data/ttx/'+key.slice(4)+'.js';
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
  // Expand the shared blocks of a battle back into the hits, so app.js, shot-context.js and
  // viewer.js see exactly the objects they saw before. Three kinds, three key spaces, three
  // markers of their own: `staticTables` (the vehicle's passport and live aim block, its static
  // part data, the rest pose, the shell lists), `pitchTables` (the gun's pitch limits, one per
  // configuration) and `armorTables` (materials, since 0.7.17). A file that carries only some of
  // them reads exactly as it did, and no reader ever drops a hit over a marker it does not know.
  // What happened in the battle - points, the target's pose, the verdict, the gun's state - was
  // never shared and stays on its record. Each battle script is self-contained, including after
  // a recorder restart.
  // A material reference is the content hash alone, as it has been since 0.7.17. A battle-level
  // reference is "<configuration>:<half the content hash>": the configuration first, so a global
  // per-configuration catalogue can answer the same references later without this page changing;
  // the content half keeps two different blocks of one configuration apart.
  var ARMOR_REF=/^[a-f0-9]{64}$/,TABLE_REF=/^[^:]{0,120}:[a-f0-9]{32}$/;
  function has(value,key){return Object.prototype.hasOwnProperty.call(value,key);}
  function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
  function definition(tables,ref,pattern){return typeof ref==='string'&&pattern.test(ref)&&has(tables,ref)?tables[ref]:undefined;}
  function warn(hit,text){(hit.warnings||(hit.warnings=[])).push(text);}
  // A missing definition leaves the field unfilled and says so. Nothing is invented: the viewer
  // falls back to its own "limits unknown" on its own, and an empty armour table blocks the
  // exporter's stock fallback by design.
  function expandStatic(hit,tables){
    ['availableShells','shellCandidates'].forEach(function(field){
      if(!has(hit,field+'Ref'))return;
      var rows=definition(tables,hit[field+'Ref'],TABLE_REF);delete hit[field+'Ref'];
      // The lists are handed out as copies, so a consumer that sorts or filters in place cannot
      // reach the shared definition.
      if(Array.isArray(rows))hit[field]=rows.slice();
      else warn(hit,'Recorded shell list unavailable: '+field);
    });
    ['attacker','target'].forEach(function(side){
      var vehicle=object(hit[side]);if(!vehicle)return;
      var poses=vehicle.partPoses;delete vehicle.partPoses;
      if(!has(vehicle,'vehicleRef'))return;
      var block=object(definition(tables,vehicle.vehicleRef,TABLE_REF));delete vehicle.vehicleRef;
      if(!block){warn(hit,'Recorded vehicle data unavailable: '+side);return;}
      Object.keys(block).forEach(function(key){if(key!=='partsRef'&&key!=='posesRef')vehicle[key]=block[key];});
      if(!has(block,'partsRef'))return;
      var rows=definition(tables,block.partsRef,TABLE_REF);
      if(!Array.isArray(rows)){warn(hit,'Recorded vehicle parts unavailable: '+side);vehicle.parts=[];return;}
      if(poses===undefined&&has(block,'posesRef')){
        poses=definition(tables,block.posesRef,TABLE_REF);
        if(!Array.isArray(poses)){warn(hit,'Recorded rest pose unavailable: '+side);poses=undefined;}
      }
      // A part gets its own object per hit: its pose is the battle's, and the armour pass below
      // writes the material table into it.
      vehicle.parts=rows.map(function(part,index){
        if(!object(part))return part;
        var out=Object.assign({},part),pose=poses?poses[index]:undefined;
        if(pose!==undefined&&pose!==null)out.transform=pose;
        return out;
      });
    });
  }
  function expandPitch(hit,tables){
    ['attacker','target'].forEach(function(side){
      var vehicle=object(hit[side]);if(!vehicle||!has(vehicle,'gunPitchRef'))return;
      var table=object(definition(tables,vehicle.gunPitchRef,TABLE_REF));delete vehicle.gunPitchRef;
      if(table)vehicle.gunPitchLimits=table;
      else warn(hit,'Recorded pitch table unavailable: '+side);
    });
  }
  function expandArmor(hit,tables){
    ['attacker','target'].forEach(function(side){
      ((hit[side]||{}).parts||[]).forEach(function(part){
        if(!has(part,'armorRef'))return;
        var table=object(definition(tables,part.armorRef,ARMOR_REF));
        if(table){part.armor=table;}
        else{
          part.armor={};part.armorError='Recorded armor table unavailable';
          warn(hit,'Recorded armor table unavailable: '+(part.name||'?'));
        }
        delete part.armorRef;
      });
    });
  }
  function expandBattle(value){
    if(!value)return value;
    ['staticTableFormat','pitchTableFormat','armorTableFormat'].forEach(function(marker){
      if(value[marker]!==undefined&&value[marker]!==1)throw new Error('Unsupported battle format: '+marker);
    });
    var hits=value.hits||[];
    // Order matters: the static tables hold the parts, so the armour and pitch references they
    // carry are resolved after those parts exist (optimisation plan B5 step 4).
    [['staticTableFormat','staticTables',expandStatic],
     ['pitchTableFormat','pitchTables',expandPitch],
     ['armorTableFormat','armorTables',expandArmor]].forEach(function(pass){
      if(value[pass[0]]===undefined)return;
      var tables=value[pass[1]]||Object.create(null);
      hits.forEach(function(hit){if(hit)pass[2](hit,tables);});
      delete value[pass[1]];delete value[pass[0]];
    });
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
  // expandBattle is published so the offline tools that read a battle file straight from disk
  // (tools/make_gpu_fixtures.cjs, verify_gpu_browser.cjs, check_shot_selection.cjs) use this one
  // reader instead of a second copy of the rules.
  window.ArmorInspectorData={receive:receive,index:function(){return read('index');},battle:function(id){return read('battle:'+id);},vehicles:function(){return read('vehicles');},vehicle:function(id){return read('vehicle:'+id);},ttx:function(id){return read('ttx:'+id);},scene:scene,sceneFor:sceneFor,expandBattle:expandBattle};
}());
