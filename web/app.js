(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);},viewer=null,current=null,selected=null,filter='all',generation=0,battleGeneration=0;
  var effects={0:'Пробитие без урона',1:'Промежуточный рикошет',2:'Рикошет',3:'Непробитие',4:'Пробитие',5:'Критическое попадание',6:'Пробитие с повреждением модуля'};
  var shellNames={ARMOR_PIERCING:'ББ',ARMOR_PIERCING_CR:'БП',HOLLOW_CHARGE:'КС',HIGH_EXPLOSIVE:'ОФ'},candidates=[],activeHit=null,shotContext=null,manualPen='',lastDistance=null,analysisKey=null;
  // web/host.js: game-host flag, breadcrumb-guarded heavy handlers. Absent in isolated tests.
  var host=window.BullbaHost||{game:false,interrupted:null,guard:function(action,fn){return fn;},done:function(){}};
  var aimReasons={'no-tracer':'Нет своего трассера','no-endpoint':'Трассер не совпал с точкой попадания','ambiguous':'Несколько трассеров — связь неоднозначна','foreign':'Чужой выстрел','no-snapshot':'Снимок прицела не записан','stale':'Снимок прицела устарел'};
  function staleEstimate(){if(analysisKey!==null){$('spread-result').textContent='Условия изменились. Нажмите «Рассчитать» ещё раз.';analysisKey=null;}if(viewer)viewer.hideSpread();}
  function node(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function message(text){$('scene-message').textContent=text;$('scene-message').hidden=!text;}
  function warnings(lines){$('warnings').textContent=lines.map(function(line){return line==='Additional vehicle parts are not yet rendered'?'Дополнительные части этой машины не показаны и не участвуют в расчёте.':line;}).join(' · ');$('warnings').hidden=!lines.length;}
  function result(hit){if(hit.damage>0)return 'Урон '+hit.damage+' HP';var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;});return p.length?(effects[p[p.length-1].effect]||'Результат '+p[p.length-1].effect):'Результат не расшифрован';}
  function resultIcon(hit){if(hit.damage>0)return '▰ −'+hit.damage;var p=(hit.points||[]).filter(function(p){return p.effect!==undefined;}),effect=p.length?p[p.length-1].effect:null;return effect===2||effect===1?'↪':effect===3?'▰ ×':effect===4?'▰ ✓':effect===5||effect===6?'⚙':effect===0?'▰ 0':'—';}
  function resultVisual(container,hit){
    container.replaceChildren();container.classList.add('result-visual');container.title=result(hit);
    var symbol=node('span');symbol.innerHTML='<svg class="damage-icon" viewBox="0 0 28 20" aria-hidden="true"><path d="M5 11h17l3 3-2 3H5l-3-3ZM9 10V6h9l3 4M18 7h8M7 14h13"/></svg>';
    container.appendChild(symbol);container.appendChild(node('span',resultIcon(hit).replace(/▰ ?/,'')));
  }
  function clock(seconds){if(!Number.isFinite(seconds))return '—';var d=new Date(seconds*1000);return d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function detail(label,value,small){var e=node('div');e.appendChild(node('div',label,'detail-label'));e.appendChild(node('div',String(value),'detail-value'));if(small)e.appendChild(node('div',small,'detail-small'));$('details').appendChild(e);}
  function prepareShell(hit){
    activeHit=hit;shotContext=ArmorShotContext.resolve(hit,current&&current.shotEvents||[]);candidates=shotContext.choices;var choice=$('shell-choice');choice.replaceChildren();
    var parts=(hit.target||{}).parts||[],hasRecorded=parts.every(function(p){return !!p.armor;}),comparison=parts.find(function(p){return p.comparisonArmor;});
    var armorChoice=$('armor-version');armorChoice.replaceChildren();var original=node('option',hasRecorded?'Версия боя':'Версия боя — нет данных');original.value='recorded';armorChoice.appendChild(original);
    if(comparison){var currentArmor=node('option','Текущая '+comparison.comparisonVersion);currentArmor.value='current';armorChoice.appendChild(currentArmor);}
    armorChoice.value=hasRecorded||!comparison?'recorded':'current';armorChoice.parentElement.hidden=armorChoice.options.length<2; // one version: nothing to choose
    candidates.forEach(function(c,i){var o=node('option',(shellNames[c.kind]||c.kind)+' · '+c.name);o.value='saved:'+i;choice.appendChild(o);});
    Object.keys(shellNames).forEach(function(kind){var o=node('option',shellNames[kind]+' — ручной расчёт');o.value=kind;choice.appendChild(o);});
    if(candidates.length>1){var uncertain=node('option','Выберите снаряд — несколько совпадений');uncertain.value='';choice.insertBefore(uncertain,choice.firstChild);}
    choice.value=shotContext.index>=0?'saved:'+shotContext.index:candidates.length?'':shotContext.kind||'ARMOR_PIERCING';
    $('shell-quick').replaceChildren();candidates.forEach(function(c,i){var actual=i===shotContext.index,b=node('button',(actual?'● ':'')+(shellNames[c.kind]||c.kind)+' '+Math.round(c.penetration100),'shell-chip');b.dataset.shell='saved:'+i;b.title=c.name+' · '+c.caliber+' мм · '+(actual?'Тип из попадания':'Сравнить с этим снарядом');b.onclick=function(){choice.value='saved:'+i;selectShell();};$('shell-quick').appendChild(b);});
    selectShell();
  }
  function shellAt(c,choice,penetration,caliber,distance){
    if(!choice||!(penetration>0)||penetration>3000||!(caliber>0)||caliber>1000)return null;
    var shell=ArmorBallistics.shell(c?c.kind:choice,penetration,caliber);
    if(c){['normalization','ricochetCos','jetLossPerMeter','randomization','randomizationType','shieldPenetration'].forEach(function(k){if(c[k]!==undefined)shell[k]=c[k];});var fraction=Math.max(0,Math.min(1,(distance-100)/400));if(c.penetration500>0&&c.penetration100>0)shell.penetration=penetration*(1+fraction*(c.penetration500/c.penetration100-1));}
    return shell;
  }
  var totalTimer=null,totalKey=null,totalEngine=null,totalAim=null;
  function shotStats(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var range=shotContext&&shotContext.range||activeHit&&activeHit.rangeAtImpact||100;
    var shell=shellAt(c,choice,Number($('penetration').value),Number($('caliber').value),range),r=viewer&&viewer.shotProbability(shell),output=$('shot-chance');
    output.textContent=r&&r.chance!==null?r.chance+'%':'—';output.style.color=r&&r.chance!==null?'rgb('+ArmorBallistics.color(r,$('palette').value).map(function(v){return Math.round(v*255);}).join(',')+')':'';
    output.title=!r?'Нет параметров или изменена поза':r.reason==='no-hull'?'На сохранённой линии нет основной брони':r.chance===null?'Недостаточно данных для расчёта':'По сохранённой линии · полёт ≈ '+Math.round(range)+' м · номинальное пробитие '+Math.round(shell.penetration)+' мм';
    var key=JSON.stringify(shell)+'|'+(viewer?viewer.turretAngle+','+viewer.gunAngle:'');
    if(viewer&&(totalKey!==key||totalEngine!==viewer.engine||totalAim!==viewer.savedAim)){
      totalKey=key;totalEngine=viewer.engine;totalAim=viewer.savedAim;clearTimeout(totalTimer);$('total-chance').textContent='—';
      if(viewer.savedAim&&shell)totalTimer=setTimeout(function(){var v=viewer.savedAimProbability(shell);$('total-chance').textContent=v?'≈ '+(v.unknown?v.low.toFixed(0)+'–'+v.high.toFixed(0):v.low.toFixed(0))+'%':'—';},100);
    }
  }
  function selectShell(){
    var index=$('shell-choice').value,c=index.indexOf('saved:')===0?candidates[Number(index.slice(6))]:null;
    var point=(activeHit&&activeHit.points||[]).find(function(p){return p.caliber>0;});
    if(!c){manualPen=$('penetration').value||manualPen;} // manual shell keeps the penetration that was on screen
    $('penetration').value=c?c.penetration100:manualPen;$('caliber').value=c?c.caliber:point?point.caliber:100;
    $('distance-control').hidden=!c||$('link-distance').checked;$('penetration-label').textContent=c?'Пробитие на 100 м, мм':'Пробитие у цели, мм';$('shot-distance').value=100;updateShell();
  }
  function updateShell(){
    var choice=$('shell-choice').value,c=choice.indexOf('saved:')===0?candidates[Number(choice.slice(6))]:null;
    var penetration=Number($('penetration').value),caliber=Number($('caliber').value),valid=!!choice&&penetration>0&&penetration<=3000&&caliber>0&&caliber<=1000;
    var distance=$('link-distance').checked&&viewer?viewer.distance:Number($('shot-distance').value),shell=shellAt(c,choice,penetration,caliber,distance);
    var edited=c&&(penetration!==c.penetration100||caliber!==c.caliber);
    var actual=shotContext&&choice==='saved:'+shotContext.index&&!edited;
    $('shell-source').textContent=!choice?'Выберите боеприпас':!valid?'Нет пробития в записи':(actual?'● Из попадания':c?'◇ Сравнение':'◇ Вручную')+' · '+Math.round(shell.penetration)+' мм у цели · ±'+Math.round(shell.randomization*100)+'%';
    $('shell-source').title=(shotContext?shotContext.source:'')+' · Номинальное пробитие, не выпавшее RNG. Цвет модели учитывает расстояние просмотра; показатель попадания — сохранённую линию и дистанцию. ОФ: только пробитие, без урона взрывом.';
    document.querySelectorAll('[data-shell]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.shell===choice));});
    var chanceMode=$('armor-mode').value==='chance';$('legend-gradient').classList.toggle('classic',$('palette').value==='classic');$('track-overlay-note').classList.toggle('classic',$('palette').value==='classic');$('armor-legend').hidden=!chanceMode||!valid;$('parameters-notice').hidden=!chanceMode||valid;
    $('penetration').setAttribute('aria-invalid',String(chanceMode&&!(penetration>0&&penetration<=3000)));$('caliber').setAttribute('aria-invalid',String(chanceMode&&!(caliber>0&&caliber<=1000)));
    $('armor-probe').textContent='';
    $('distance-control').hidden=!c||$('link-distance').checked;staleEstimate();if(viewer)viewer.configure(shell,$('armor-mode').value==='chance',$('palette').value);shotStats();
  }
  function inspectArmor(r){
    var text=r.reason==='parameters'?'Укажите пробитие и калибр снаряда.':r.reason==='armor'?'Для этой поверхности не сохранены параметры брони.':r.reason==='no-hull'?'На этой линии нет основной брони корпуса или башни.':r.reason==='ricochet'?'Рикошет · 0%':r.reason==='screen'?'Снаряд остановится на экране · 0%':r.chance===null?'Расчёт для такого распределения пробития пока недоступен.':r.chance+'% · броня '+r.nominal.toFixed(1)+' мм · угол '+r.angle.toFixed(1)+'° · приведённая '+r.effective.toFixed(1)+' мм';
    if(r.surface&&(r.surface.part===0||(r.surface.armor&&r.surface.armor.vehicleDamageFactor<=1e-5)))text=(r.surface.part===0?'Ходовая':'Экран / внешний модуль')+' · '+(r.surface.armor&&r.surface.armor.armor!=null?r.surface.armor.armor+' мм · ':'')+'шанс относится к основной броне за ней: '+text;
    if(r.layers&&r.layers.length>1)text+=' · слоёв: '+r.layers.length;$('armor-probe').textContent=text;
  }
  function display(data,reference){
    var hit=data.hit;$('target-name').textContent=(hit.target||{}).name||'Цель неизвестна';$('scene-kind').textContent=reference?'КОНТРОЛЬНАЯ МОДЕЛЬ · БЕЗ ЗАПИСИ БОЯ':'КОЛЛИЗИОННАЯ МОДЕЛЬ КЛИЕНТА';$('result-badge').hidden=!!reference;$('result-badge').textContent=result(hit);
    prepareShell(hit);var drawn=viewer&&viewer.load(data);if(viewer)requestAnimationFrame(function(){viewer.resize();});message(drawn?'':'Геометрия недоступна. Исходное событие сохранено.');$('focus-hit').disabled=!(viewer&&viewer.point);warnings(data.warnings||[]);$('details').replaceChildren();
    var aimReady=viewer&&viewer.setShotContext(shotContext);$('show-aim').disabled=!aimReady;$('aim-state').textContent=aimReady?'● клиент · ◌ сервер':hit.direction==='incoming'?'Прицел противника недоступен':aimReasons[shotContext.aimReason]||'Нет связанного снимка';
    $('aim-toggle').title=aimReady?'Сохранённый клиентский круг — бирюзовый; серверный — пунктир, если получен. Связь с попаданием по конечной точке и времени; положение цели — при попадании.':'Для этого попадания нет однозначно связанного собственного прицела: '+(aimReasons[shotContext.aimReason]||'нет данных')+'.';
    if(viewer&&shotContext.range)viewer.setDistance(Math.max(1,Math.min(1500,shotContext.range)));shotStats();
    resultVisual($('result-badge'),hit);
    if(reference){$('details').appendChild(node('p','Модель извлечена из установленного клиента. Здесь нет вымышленных попаданий. После установки регистратора новые бои появятся в списке слева.'));return;}
    detail('Направление',hit.direction==='incoming'?'Входящее':'Исходящее',clock(hit.receivedAt));detail('Результат',result(hit));
    var points=hit.points||[],point=points.find(function(p){return p.status==='resolved';});
    detail('Точка на модели',point?['Ходовая','Корпус','Башня','Орудие'][point.part]:'Не восстановлена',point?'По обработчику столкновений клиента':'Сегмент сохранён для диагностики');
    detail('Калибр',point&&point.caliber?point.caliber+' мм':'Нет данных',points.length+' точек в событии');
    if(hit.rangeAtImpact!=null)detail('До атакующего при попадании',hit.rangeAtImpact.toFixed(1)+' м','Положение при получении попадания; не измеренная длина полёта.');
  }
  function renderHits(){
    var container=$('hits');container.replaceChildren();var hits=current?current.hits.filter(function(h){return filter==='all'||h.direction===filter;}):[];var own=current?(function(){var inc=current.hits.find(function(h){return h.direction==='incoming'&&h.target&&h.target.name;}),out=current.hits.find(function(h){return h.direction==='outgoing'&&h.attacker&&h.attacker.name;});return inc?inc.target.name:out?out.attacker.name:null;}()):null;$('hit-count').textContent=current?hits.length+' попаданий'+(own?' · бой на '+own:''):'';
    if(!hits.length){container.appendChild(node('p',current?'Нет попаданий для выбранного фильтра.':'Пока нет записей. Запустите игру с регистратором и сыграйте бой. Просмотрщик можно оставить открытым.','empty'));return;}
    hits.forEach(function(h){var hasDamage=h.damage>0,b=node('button',undefined,'hit');b.setAttribute('aria-pressed',String(selected===h.id));b.setAttribute('data-direction',h.direction);b.setAttribute('data-result',hasDamage?'damage':'none');b.title=(h.direction==='incoming'?'Входящее от '+((h.attacker||{}).name||'?'):'Исходящее по '+((h.target||{}).name||'?'))+' · '+result(h);
      var row=node('span',undefined,'hit-row');row.appendChild(node('span',h.direction==='incoming'?'↙':'↗','direction-icon '+h.direction));row.appendChild(node('span',h.direction==='incoming'?((h.attacker||{}).name||'Стрелявший неизвестен'):((h.target||{}).name||'Цель неизвестна'),'hit-name'));row.appendChild(node('span',hasDamage?'−'+h.damage:'0','hit-damage'));b.appendChild(row);
      var sub=node('span',undefined,'hit-row hit-sub');sub.appendChild(node('span',clock(h.receivedAt)));sub.appendChild(node('span',hasDamage?'':result(h)));b.appendChild(sub);
      b.onclick=function(){selectHit(h.id).catch(function(){});};container.appendChild(b);});
  }
  function selectHit(id){
    if(!current||!current.hits.some(function(h){return h.id===id;}))return Promise.reject(new Error('Попадание не найдено'));
    selected=id;renderHits();var token=++generation;message('Подготовка модели…');if(viewer)viewer.clear();$('focus-hit').disabled=true;
    return ArmorInspectorData.scene(current,id).then(function(data){if(token!==generation)return;display(data,false);return {battleId:current.id,hitId:id};}).catch(function(e){if(token===generation){message(e.message);warnings([e.message]);}throw e;});
  }
  function loadBattle(id,keep){
    var request=++battleGeneration;if(!current||current.id!==id)++generation;
    return ArmorInspectorData.battle(id).then(function(b){if(request!==battleGeneration)return;current=b;ArmorShotTelemetry.load(b.shotEvents||[]);var existing=keep&&selected&&b.hits.some(function(h){return h.id===selected;});if(!existing)selected=null;renderHits();if(b.hits.length)return selectHit(existing?selected:b.hits[0].id);if(viewer)viewer.clear();message('В этом бою пока нет записанных попаданий. Сведения выстрелов доступны ниже.');});
  }
  function refresh(){
    $('refresh').disabled=true;
    return ArmorInspectorData.index().then(function(index){var pv=$('app-version').getAttribute('data-version');$('app-version').textContent=(pv!=='dev'?pv:'')+(index.version&&index.version!==pv?' · записи '+index.version:'');if(index.application!=='local.armor_inspector'||!Array.isArray(index.battles))throw new Error('Некорректный список боёв');$('connection').textContent='Локальные файлы · без сервера';var battles=index.battles,prior=$('battles').value;$('battles').replaceChildren();if(!battles.length){current=null;selected=null;++generation;++battleGeneration;if(viewer)viewer.clear();$('battles').appendChild(node('option','Пока нет боёв'));renderHits();message('Новые попадания появятся после боя. Затем нажмите «Обновить».');warnings([]);return;}
      battles.forEach(function(b){var option=node('option',new Date(b.startedAt*1000).toLocaleDateString('ru-RU')+' · '+b.map+' · '+b.hits);option.value=b.id;$('battles').appendChild(option);});var id=battles.some(function(b){return b.id===prior;})?prior:battles[0].id;$('battles').value=id;return loadBattle(id,current&&current.id===id);
    }).catch(function(e){$('connection').textContent='Нет локальных записей';message(e.message);warnings([e.message]);}).then(function(){$('refresh').disabled=false;});
  }
  try{viewer=new ArmorViewer($('viewport'));}catch(e){message('WebGL недоступен: '+e.message);}
  if(viewer)viewer.onInspect=inspectArmor;
  // The fallback path is visibly labelled in the scene: its stepped sampling must never pass for the exact composition.
  if(viewer)viewer.onBackend=function(text){$('heatmap-backend').textContent=text;var fallback=!/^GPU · слои/.test(text);$('backend-badge').hidden=!fallback;$('backend-badge').textContent=fallback?text:'';};
  $('heatmap-compute').onchange=host.guard('Расчёт',function(){if(viewer)viewer.computeMode(this.value);});
  if(viewer)viewer.onCamera=function(state){var changed=lastDistance!==state.distance;lastDistance=state.distance;$('camera-distance-value').textContent=Math.round(state.distance)+' м';$('camera-distance-exact').value=state.distance.toFixed(1);$('camera-zoom-exact').value=state.zoom.toFixed(2);$('camera-zoom').value=Math.max(0,Math.min(1000,500+Math.log(state.zoom/Math.max(.1,viewer.fitZoom))/Math.log(10)*500));var key=[state.distance,state.yaw,state.pitch,viewer.turretAngle,viewer.gunAngle].join(',');if(analysisKey!==null&&analysisKey!==key)staleEstimate();if(changed&&$('link-distance').checked)updateShell();else if(totalEngine!==viewer.engine)shotStats();};
  $('camera-zoom').oninput=function(){if(viewer)viewer.setScale(Math.pow(10,(Number(this.value)-500)/500));};
  $('auto-frame').onchange=function(){if(viewer)viewer.setAutoFrame(this.checked);};
  $('track-opacity').oninput=function(){if(viewer)viewer.setTrackOpacity(Number(this.value)/100);};
  $('camera-distance-exact').onchange=function(){if(viewer)viewer.setDistance(Number(this.value));};
  $('camera-zoom-exact').onchange=function(){if(viewer)viewer.setZoom(Number(this.value));};
  $('link-distance').onchange=updateShell;
  $('heatmap-quality').onchange=host.guard('Детализация',function(){if(host.game&&this.value==='high'){this.value=viewer?viewer.quality:'auto';return;}if(viewer)viewer.setQuality(this.value);});
  $('surface-mode').onchange=host.guard('Экраны и гусеницы',function(){$('track-overlay-note').hidden=this.value!=='blend';if(viewer)viewer.setSurfaceMode(this.value);});
  if(viewer)viewer.onQuality=function(count){$('quality-info').textContent=count.toLocaleString('ru-RU')+' точек карты';};
  function poseChanged(){if(!viewer)return;$('turret-notice').hidden=Math.abs(viewer.turretAngle)<.1&&Math.abs(viewer.gunAngle)<.1;staleEstimate();shotStats();}
  if(viewer)viewer.onTurret=poseChanged;
  if(viewer)viewer.onGun=function(state){$('gun-notice').textContent=state.known?'Пределы орудия — из клиента, с учётом поворота башни. Между сохранёнными углами применяется интерполяция.':'В этой записи нет пределов орудия. Вертикальное движение — свободное исследование, не реальные углы танка.';poseChanged();};
  $('reset-turret').onclick=function(){if(viewer)viewer.resetPose();};
  $('fit-camera').onclick=function(){if(viewer)viewer.fit();};
  if(viewer)viewer.onAim=function(text){analysisKey=null;$('spread-result').textContent=text;};
  $('reset-aim').onclick=function(){if(viewer){viewer.spreadAim=null;staleEstimate();}};
  $('spread-radius').oninput=staleEstimate;
  $('estimate-spread').onclick=function(){if(!viewer)return;try{var result=viewer.estimateSpread(Number($('spread-radius').value));analysisKey=[viewer.distance,viewer.yaw,viewer.pitch,viewer.turretAngle,viewer.gunAngle].join(',');$('spread-result').textContent='Условная суммарная вероятность: '+(result.unknown?result.low.toFixed(1)+'–'+result.high.toFixed(1):result.low.toFixed(1))+'% · вне основной брони '+result.miss.toFixed(1)+'% · '+result.samples+' луча.'+(result.unknown?' Диапазон из-за недостающих данных брони.':'')+' Для выбранной модели разброса, без препятствий карты и урона взрывом.';}catch(e){$('spread-result').textContent=e.message;}};
  $('save-camera').onclick=function(){if(viewer)$('camera-help').textContent=viewer.saveDefaults()?'Стартовый вид сохранён для следующих попаданий и открытий.':'Вид запомнен до закрытия страницы: браузер запретил локальное сохранение.';};
  $('shell-choice').onchange=selectShell;
  $('show-aim').onchange=function(){if(viewer)viewer.showSavedAim(this.checked);};
  $('armor-version').onchange=host.guard('Версия брони',function(){if(viewer)viewer.armorVersion(this.value==='current');updateShell();});
  $('pivot-mode').onchange=function(){if(viewer)viewer.setPivot(this.value);};
  ['caliber','shot-distance','palette','armor-mode'].forEach(function(id){$(id).onchange=updateShell;});
  $('penetration').oninput=function(){if($('shell-choice').value.indexOf('saved:')!==0)manualPen=this.value;updateShell();};
  $('battles').onchange=function(){loadBattle(this.value,false).catch(function(e){warnings([e.message]);});};
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderHits();};});
  $('refresh').onclick=refresh;$('reset-camera').onclick=function(){if(viewer)viewer.reset();};$('focus-hit').onclick=function(){if(viewer)viewer.focus();};$('wireframe').onchange=function(){if(viewer)viewer.wireframe(this.checked);};
  window.addEventListener('armor-context-lost',function(){host.mark('WebGL','context-lost');message('Браузер потерял WebGL-контекст. Обновите страницу.');});
  function outline(){if(viewer)viewer.setOutline(Number($('outline-brightness').value)/100,Number($('outline-opacity').value)/100);}
  $('outline-brightness').oninput=outline;$('outline-opacity').oninput=outline;if(viewer){viewer.wireframe($('wireframe').checked);outline();}
  if(host.interrupted){$('host-note').hidden=false;$('host-note').textContent='Прошлый сеанс прервался во время действия «'+host.interrupted.action+'» ('+(host.interrupted.host==='game'?'в игре':'в браузере')+', '+new Date(host.interrupted.at).toLocaleString('ru-RU')+'). Сообщите об этом при разборе.';}
  (function(){var pv=$('app-version').getAttribute('data-version');if(pv!=='dev')$('app-version').textContent=pv;}());
  host.done();
  refresh();
  if(document.modelContext&&document.modelContext.registerTool){try{document.modelContext.registerTool({name:'select_saved_hit',description:'Open an existing recorded hit in the local 3D viewer.',inputSchema:{type:'object',properties:{battleId:{type:'string'},hitId:{type:'string'}},required:['battleId','hitId'],additionalProperties:false},execute:function(input){if(!input||!/^[-a-zA-Z0-9_]{1,100}$/.test(input.battleId)||!/^\d+$/.test(input.hitId))throw new Error('Invalid record identifiers');return loadBattle(input.battleId,true).then(function(){return selectHit(input.hitId);});}});}catch(e){console.warn('WebMCP unavailable',e);}}
}());
