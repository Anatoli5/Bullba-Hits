// Modifier groups: a small block of segmented switches that sits next to a scene tile and says what the
// player on the other side has fitted - things the record cannot know (a crew skill) or knows only partly
// (the spall liner). The component knows nothing about the target or the shooter: it renders the options it
// is handed and reports a change, so the same builder serves the group next to the Collision model tile and
// a later one next to the Shooter tile.
//
// Two forms of the same controls. Inline: a labelled block styled like the scene tiles. Collapsed: one
// "Modifiers ▾" button with a short summary, opening the toolbar's own <details> + .toolbar-popover - the
// page has exactly one popover mechanism and this is it, closed by the document click handler in app.js.
// The controls themselves are built once and moved between the two places, so every listener survives the
// switch. Which form is used is decided by the host through fit(room): only the host knows how much room
// the scene has next to its tiles.
//
// set()/setDefaults() are silent - they put the switches where the host says and never call back; onChange
// fires for a click by the user only.
(function(){
  'use strict';
  function node(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function create(spec){
    spec=spec||{};
    var host=spec.host;if(!host)return null;
    var element=node('div',undefined,'mod-group');if(spec.id)element.id=spec.id;
    var caption=node('span',spec.title||'','tile-caption mod-title');
    var body=node('div',undefined,'mod-body');
    // The collapsed form: the same summary/popover pair the toolbar's "More" uses, so it opens, closes and
    // looks like that one. Only the direction differs (it hangs below the button), which is one CSS rule.
    var more=node('details',undefined,'toolbar-more mods-more');more.hidden=true;
    var summary=node('summary','Modifiers'),brief=node('span','','mod-brief');
    summary.appendChild(brief);
    var popover=node('div',undefined,'toolbar-popover');
    more.appendChild(summary);more.appendChild(popover);
    element.appendChild(caption);element.appendChild(body);element.appendChild(more);
    host.appendChild(element);
    var state={},buttons={},order=[],form='inline',wide=0;
    (spec.options||[]).forEach(function(o){
      var choices=o.choices||[];if(!choices.length)return;
      order.push(o.id);buttons[o.id]=[];
      var row=node('span',undefined,'mod-option');if(o.title)row.title=o.title;
      if(o.label)row.appendChild(node('span',o.label,'mod-label'));
      var sw=node('span',undefined,'type-switch mod-switch'+(o.kind==='toggle'?' mod-toggle':''));
      sw.setAttribute('role','group');sw.setAttribute('aria-label',o.label||o.id);
      choices.forEach(function(ch){
        var b=node('button',ch.label);b.type='button';if(ch.title)b.title=ch.title;
        b.onclick=function(){if(state[o.id]===String(ch.value))return;state[o.id]=String(ch.value);paint();
          if(spec.onChange)spec.onChange(o.id,state[o.id],values());};
        buttons[o.id].push({value:String(ch.value),button:b});sw.appendChild(b);
      });
      row.appendChild(sw);body.appendChild(row);
      state[o.id]=String(o.value!==undefined&&o.value!==null?o.value:choices[0].value);
    });
    function values(){var out={};order.forEach(function(id){out[id]=state[id];});return out;}
    function paint(){
      order.forEach(function(id){buttons[id].forEach(function(b){b.button.setAttribute('aria-pressed',String(b.value===state[id]));});});
      brief.textContent=spec.summary?' · '+spec.summary(values()):'';
    }
    function set(id,value){if(!buttons[id])return;var v=String(value);
      if(!buttons[id].some(function(b){return b.value===v;}))return;
      state[id]=v;paint();}
    function setDefaults(map){if(!map)return;Object.keys(map).forEach(function(id){set(id,map[id]);});}
    // Inline needs the controls between the caption and the button, collapsed needs them in the popover;
    // insertBefore moves the nodes themselves, exactly as the toolbar moves its groups.
    function setForm(next){
      if(next===form)return;
      form=next;element.classList.toggle('collapsed',next==='collapsed');
      more.hidden=next!=='collapsed';caption.hidden=next==='collapsed';
      if(next==='collapsed')popover.appendChild(body);else element.insertBefore(body,more);
    }
    // The inline width is measured in the inline form and remembered (a group that is collapsed measures its
    // button, not its controls); a hidden group measures 0 and keeps whatever form it had.
    function fit(room){
      var before=form;setForm('inline');
      var w=element.offsetWidth;if(w>0)wide=w;
      if(!wide){setForm(before);return before;}
      setForm(wide<=room?'inline':'collapsed');
      return form;
    }
    paint();
    return {element:element,set:set,get:function(id){return state[id];},values:values,setDefaults:setDefaults,
      fit:fit,form:function(){return form;},close:function(){more.open=false;}};
  }
  window.ModifierGroup={create:create};
}());
