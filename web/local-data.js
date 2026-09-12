/* Ordinary classic scripts work from file://; no fetch, server or storage API. */
(function () {
  'use strict';
  var pending=Object.create(null), models=Object.create(null), modelOrder=[], serial=0;
  function filename(key){
    if(key==='index')return 'data/index.js';
    if(/^battle:[-a-zA-Z0-9_]{1,100}$/.test(key))return 'data/battles/'+key.slice(7)+'.js';
    if(/^model:[a-f0-9]{64}$/.test(key))return 'data/models/'+key.slice(6)+'.js';
    throw new Error('Некорректный идентификатор записи');
  }
  function read(key){
    if(pending[key])return pending[key].promise;
    var path;try{path=filename(key);}catch(e){return Promise.reject(e);}
    var entry={value:undefined,received:false}, script=document.createElement('script');
    entry.promise=new Promise(function(resolve,reject){
      function finish(error){clearTimeout(timer);script.remove();delete pending[key];if(error)reject(error);else resolve(entry.value);}
      var timer=setTimeout(function(){finish(new Error('Не удалось прочитать локальный файл. Нажмите «Обновить».'));},15000);
      script.onload=function(){finish(entry.received?null:new Error('Файл данных повреждён: '+path));};
      script.onerror=function(){finish(new Error('Не найден '+path+'. Откройте Viewer.html из папки mods/configs/local.armor_inspector после запуска игры с модом.'));};
      // A fresh URL avoids reusing a snapshot when the user presses Refresh.
      script.src=path+'?read='+Date.now()+'-'+(++serial);
    });
    pending[key]=entry;document.head.appendChild(script);return entry.promise;
  }
  function receive(payload){
    if(!Array.isArray(payload)||payload.length!==2)return;
    var entry=pending[payload[0]];
    if(entry){entry.value=payload[1];entry.received=true;}
  }
  function model(key){
    var previous=modelOrder.indexOf(key);if(previous!==-1)modelOrder.splice(previous,1);
    modelOrder.push(key);
    while(modelOrder.length>16)delete models[modelOrder.shift()];
    if(!models[key])models[key]=read('model:'+key).catch(function(e){delete models[key];throw e;});
    return models[key];
  }
  function scene(battle,id){
    var hit=battle.hits.find(function(h){return h.id===id;});
    if(!hit)return Promise.reject(new Error('Попадание не найдено'));
    var result={hit:hit,models:{},warnings:(battle.warnings||[]).concat(hit.warnings||[])};
    return Promise.all(((hit.target||{}).parts||[]).map(function(part){
      if(part.modelError||!part.modelKey||!part.transform){result.warnings.push(part.name+': '+(part.modelError||'Модель или положение части не сохранены'));return;}
      return model(part.modelKey).then(function(data){
        if(data.kind!=='client-shot-collision'||!Array.isArray(data.groups))throw new Error('Некорректная модель');
        result.models[String(part.id)]=data;
      }).catch(function(e){result.warnings.push(part.name+': '+e.message);});
    })).then(function(){return result;});
  }
  window.ArmorInspectorData={receive:receive,index:function(){return read('index');},battle:function(id){return read('battle:'+id);},scene:scene};
}());
