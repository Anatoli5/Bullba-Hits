/* Local WebGL scene. Game transforms are serialized by basis vectors, column-major. */
(function () {
  'use strict';
  function linear(color){return color.map(function(c){return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);});}
  var baseColors=[[.38,.46,.54],[.65,.73,.8],[.75,.83,.87],[.55,.65,.72]].map(linear),colorTables={};
  // Screen tint is relative to the selected shell: nominal plate thickness against
  // nominal penetration at the target, HE counting screens threefold. A visual
  // mask in the probability palette, not the per-pixel chance of the armour behind.
  function screenColor(mm,shell,palette){var factor=shell.kind==='HIGH_EXPLOSIVE'&&shell.shieldPenetration?3:1,ratio=Math.max(0,Math.min(1,mm*factor/shell.penetration));return colorTable(palette)[Math.round((1-ratio)*100)];}
  function externalLayer(t){return t.part===0||!!(t.armor&&Number.isFinite(t.armor.vehicleDamageFactor)&&t.armor.vehicleDamageFactor<=1e-5);}
  function colorTable(palette){
    if(!colorTables[palette]){var table=[];for(var i=0;i<=100;i++)table.push(linear(ArmorBallistics.color({chance:i},palette)));table.push(linear(ArmorBallistics.color({chance:null},palette)),linear(ArmorBallistics.color({chance:0,reason:'no-hull'},palette)));colorTables[palette]=table;}
    return colorTables[palette];
  }
  function Viewer(container) {
    var self = this, T = THREE;
    this.container = container;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);
    this.reticles=[];this.reticleLayer=document.createElement('div');this.reticleLayer.className='hit-reticle-layer';container.appendChild(this.reticleLayer);
    this.grid = new T.GridHelper(24, 24, 0x4a5d6f, 0x263746); this.scene.add(this.grid);
    this.root = new T.Group(); this.scene.add(this.root);
    this.target = new T.Vector3(0, 1, 0); this.yaw = 0.7; this.pitch = 0.27; this.distance = 50;
    this.defaults={distance:50,scale:.85};this.pivot='hit';this.frameCenter=new T.Vector2();this.fitZoom=1;
    try{var saved=JSON.parse(window.localStorage.getItem('armor-camera-defaults'));if(saved&&saved.distance>=1&&saved.distance<=1500&&saved.scale>=.1&&saved.scale<=10)this.defaults=saved;}catch(ignore){}
    this.materials = []; this.point = null; this.travel = null;
    this.shell=null;this.heatmap=true;this.palette='classic';this.paintTimer=null;this.paintMesh=null;this.samples=[];this.engine=null;
    this.frameId=null;this.cachedEngine=null;this.cachedRaysKey=null;this.cachedResults=null;this.paintedKey=null;
    this.gpu=null;this.gpuAttempted=false;this.gpuMode='auto';this.gpuError=null;
    this.quality='auto';this.surfaceMode='blend';this.turretAngle=0;this.turretTimer=null;this.turretPending=false;this.currentArmor=false;
    this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.heatEngine=null;this.trackOpacity=.4;this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.gunAngle=0;this.autoFrame=true;this.frameScale=this.defaults.scale;this.outline=null;this.outlineDepth=null;this.outlineStyle={brightness:.8,opacity:.6};this.showOutline=false;
    var drag = null;
    container.addEventListener('pointerdown', function(e) { if(e.button!==0)return;if(e.altKey){self.aimAt(e);return;}drag={x:e.clientX,y:e.clientY,part:self.pickPart(e)}; container.setPointerCapture(e.pointerId); container.focus(); });
    container.addEventListener('pointermove', function(e) { if (!drag){self.inspect(e);return;}if(drag.part===3){self.setGun(self.gunAngle+(e.clientY-drag.y)*.16);}else if(drag.part===2){self.setTurret(self.turretAngle-(e.clientX-drag.x)*.5);}else{self.yaw -= (e.clientX-drag.x)*0.008; self.pitch = Math.max(-1.35,Math.min(1.35,self.pitch+(e.clientY-drag.y)*0.008));self.render();}drag.x=e.clientX;drag.y=e.clientY; });
    container.addEventListener('pointerup', function() { drag=null; });
    container.addEventListener('pointercancel', function() { drag=null; });
    container.addEventListener('wheel', function(e) {e.preventDefault();var delta=e.deltaY||e.deltaX,amount=Math.max(-200,Math.min(200,delta*(e.deltaMode===1?16:e.deltaMode===2?300:1)));if(e.shiftKey||e.ctrlKey)self.setZoom(self.camera.zoom*Math.exp(-amount*.002));else self.setDistance(Math.max(1,Math.min(1500,self.distance*Math.exp(amount*.002))));}, {passive:false});
    container.addEventListener('keydown',function(e){var used=true;if(e.key==='ArrowLeft')self.yaw-=.1;else if(e.key==='ArrowRight')self.yaw+=.1;else if(e.key==='ArrowUp')self.pitch=Math.min(1.35,self.pitch+.1);else if(e.key==='ArrowDown')self.pitch=Math.max(-1.35,self.pitch-.1);else if(e.key==='+'||e.key==='='){if(e.shiftKey)self.setZoom(self.camera.zoom*1.1);else self.setDistance(Math.max(1,self.distance/1.1));}else if(e.key==='-'){if(e.shiftKey)self.setZoom(self.camera.zoom/1.1);else self.setDistance(Math.min(1500,self.distance*1.1));}else used=false;if(used){e.preventDefault();self.render();}});
    if(this.renderer.domElement.addEventListener)this.renderer.domElement.addEventListener('webglcontextlost',function(e){e.preventDefault();window.dispatchEvent(new Event('armor-context-lost'));});
    window.addEventListener('resize', function(){self.resize();});
    if(window.ResizeObserver){this.resizeObserver=new ResizeObserver(function(){self.resize();});this.resizeObserver.observe(container);}
    this.resize();
  }
  Viewer.prototype.projection=function(){var w=this.container.clientWidth||1,h=this.container.clientHeight||1,z=this.camera.zoom;this.camera.setViewOffset(w,h,this.frameCenter.x*z*w/2,-this.frameCenter.y*z*h/2,w,h);};
  Viewer.prototype.resize=function(){var w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h,false);this.projection();this.render();};
  // Coalesce input and color updates into one draw at the next browser frame.
  Viewer.prototype.draw=function(){if(this.frameId!==null)return;var self=this;this.frameId=window.requestAnimationFrame(function(){try{if(self.turretPending)self.applyTurret();if(self.paintMesh)self.paint();if(self.aimGroup)self.aimGroup.visible=!!document.getElementById('show-aim').checked&&Math.abs(self.turretAngle)<.001&&Math.abs(self.gunAngle)<.001;self.renderer.render(self.scene,self.camera);self.updateReticles();}finally{self.frameId=null;}});};
  Viewer.prototype.render=function(){var c=Math.cos(this.pitch);this.camera.position.set(this.target.x+this.distance*c*Math.sin(this.yaw),this.target.y+this.distance*Math.sin(this.pitch),this.target.z+this.distance*c*Math.cos(this.yaw));this.camera.lookAt(this.target);this.camera.updateMatrixWorld();if(this.autoFrame)this.autoFit();this.draw();if(this.onCamera)this.onCamera({distance:this.distance,zoom:this.camera.zoom,yaw:this.yaw,pitch:this.pitch});};
  Viewer.prototype.setZoom=function(value){if(!Number.isFinite(value)||value<=0)return;this.camera.zoom=Math.max(.1,Math.min(150,value));if(this.autoFrame)this.frameScale=this.camera.zoom/Math.max(.1,this.fitZoom);this.projection();this.draw();if(this.onCamera)this.onCamera({distance:this.distance,zoom:this.camera.zoom,yaw:this.yaw,pitch:this.pitch});};
  Viewer.prototype.setDistance=function(value){if(!Number.isFinite(value)||value<1||value>1500)return;this.distance=value;this.render();};
  Viewer.prototype.saveDefaults=function(){var frame=this.framing();this.defaults={distance:this.distance,scale:Math.max(.1,Math.min(10,this.camera.zoom/(frame?frame.zoom:this.fitZoom)))};try{window.localStorage.setItem('armor-camera-defaults',JSON.stringify(this.defaults));return true;}catch(ignore){return false;}};
  Viewer.prototype.clear=function(){if(this.surface)this.surface.dispose();this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.gunAngle=0;this.savedAim=null;this.aimGroup=null;this.reticles=[];this.reticleLayer.replaceChildren();clearTimeout(this.turretTimer);this.turretTimer=null;this.turretPending=false;this.spreadAim=null;this.hideSpread();clearTimeout(this.paintTimer);this.paintTimer=null;window.cancelAnimationFrame(this.frameId);this.frameId=null;this.resetGPU();this.paintMesh=null;this.outline=null;this.outlineDepth=null;this.engine=null;this.heatEngine=null;this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.loadedData=null;this.cachedEngine=null;this.cachedRaysKey=null;this.cachedResults=null;this.paintedKey=null;this.samples=[];var disposed=new Set();this.root.traverse(function(o){if(o.geometry&&!disposed.has(o.geometry)){disposed.add(o.geometry);o.geometry.dispose();}if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(function(m){m.dispose();});}});while(this.root.children.length)this.root.remove(this.root.children[0]);this.materials=[];this.point=null;this.travel=null;this.render();};
  Viewer.prototype.rebuild=function(){
    if(!this.loadedData)return;var T=THREE,self=this;this.samples=[];this.cachedRaysKey=null;this.paintedKey=null;
    // A failed composition is retried on the next rebuild (quality, mode, pose) instead of staying off for good.
    if(!this.surface&&this.surfaceAttempted){this.surfaceAttempted=false;this.surfaceRetryReason=this.surfaceError;}
    this.engine=ArmorBallistics.build(this.posedData||this.loadedData,this.currentArmor);
    // One law everywhere: rays cross screens and tracks in every mode. In the mask mode only the main
    // armour is sampled for the CPU fallback; screens are drawn as the tinted overlay above it.
    this.heatEngine=this.engine;var sampled=this.surfaceMode==='blend'?this.engine.triangles.filter(function(t){return !externalLayer(t);}):this.engine.triangles;
    this.updateTracks();
    if(this.surface){try{this.surface.update(this.engine);}catch(e){this.surface.dispose();this.surface=null;this.surfaceError=e.message;}}
    var accelerated=this.gpuMode==='auto'&&(this.renderer.capabilities||{}).isWebGL2;
    var edge=this.quality==='low'?.85:this.quality==='high'?.18:this.quality==='medium'?.4:accelerated?.35:.65;
    var total=this.quality==='high'?100000:40000,budget=Math.max(1,Math.floor(total/Math.max(1,this.engine.triangles.length)));
    sampled.forEach(function(t){ArmorBallistics.subdivide(t,0,self.samples,edge,budget);});
    var positions=[],colors=[];this.samples.forEach(function(t){[t.a,t.b,t.c].forEach(function(v){positions.push(v[0],v[1],v[2]);colors.push(.25,.32,.38);});});
    var geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(positions,3));geom.setAttribute('color',new T.Float32BufferAttribute(colors,3).setUsage(T.DynamicDrawUsage));
    if(this.paintMesh){this.paintMesh.geometry.dispose();this.paintMesh.geometry=geom;}else{var mat=new T.MeshBasicMaterial({vertexColors:true,side:T.DoubleSide});this.materials.push(mat);this.paintMesh=new T.Mesh(geom,mat);this.root.add(this.paintMesh);}
    this.updateOutline();
    if(this.gpu){try{this.gpu.update(this.heatEngine,this.samples);}catch(e){this.gpu.dispose();this.gpu=null;this.gpuAttempted=true;this.gpuError=e.message;}}
    if(this.onQuality)this.onQuality(this.samples.length);this.render();
  };
  Viewer.prototype.updateTracks=function(){
    var T=THREE,positions=[],colors=[];
    this.trackTriangles=this.engine.triangles.filter(function(t){return externalLayer(t)&&(!t.armor||t.armor.armor!==0);});
    this.trackTriangles.forEach(function(t){[t.a,t.b,t.c].forEach(function(p){positions.push(p[0],p[1],p[2]);colors.push(1,1,1,1);});});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new T.Float32BufferAttribute(colors,4).setUsage(T.DynamicDrawUsage));
    if(!this.trackGroup){
      // First keep only the closest visible external layer depth. Equal-depth blending
      // then applies one tint, rather than accumulating all overlapping faces.
      var depth=new T.Mesh(geometry,new T.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:T.DoubleSide,stencilWrite:true,stencilRef:1,stencilFunc:T.AlwaysStencilFunc,stencilZPass:T.ReplaceStencilOp}));depth.renderOrder=1;
      var material=new T.MeshBasicMaterial({vertexColors:true,transparent:true,depthWrite:false,depthTest:true,depthFunc:T.EqualDepth,side:T.DoubleSide,stencilWrite:true,stencilRef:1,stencilFunc:T.EqualStencilFunc,stencilZPass:T.ZeroStencilOp});material.forceSinglePass=true;
      this.trackMesh=new T.Mesh(geometry,material);this.trackMesh.renderOrder=2;
      this.trackGroup=new T.Group();this.trackGroup.add(depth,this.trackMesh);this.root.add(this.trackGroup);
    }else{this.trackMesh.geometry.dispose();this.trackGroup.children.forEach(function(mesh){mesh.geometry=geometry;});}
    this.trackGroup.visible=this.surfaceMode==='blend';this.updateTrackAppearance();
  };
  Viewer.prototype.updateTrackAppearance=function(){
    if(!this.trackMesh)return;var self=this,attribute=this.trackMesh.geometry.attributes.color,buffer=attribute.array;
    var colored=this.heatmap&&this.shell&&this.shell.penetration>0;
    this.trackTriangles.forEach(function(t,i){
      var known=t.armor&&Number.isFinite(t.armor.armor)&&t.armor.armor>=0;
      // Deliberately nominal thickness against the shell: a stable visual mask,
      // not a per-triangle penetration probability or a second ray calculation.
      var opacity=self.heatmap?self.trackOpacity:1;
      var color=known&&colored?screenColor(t.armor.armor,self.shell,self.palette):baseColors[t.part%4];
      for(var j=0;j<3;j++){var offset=(i*3+j)*4;for(var k=0;k<3;k++)buffer[offset+k]=color[k];buffer[offset+3]=opacity;}
    });
    attribute.needsUpdate=true;
  };
  // Outline: the collision triangles as lines over the opaque model. A colour-less depth pass of the
  // same triangles hides the far side in every mode, including the screen-space composition.
  Viewer.prototype.updateOutline=function(){
    var T=THREE,positions=[];this.engine.triangles.forEach(function(t){positions.push(t.a[0],t.a[1],t.a[2],t.b[0],t.b[1],t.b[2],t.c[0],t.c[1],t.c[2]);});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    if(!this.outline){
      this.outlineDepth=new T.Mesh(geometry,new T.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:T.DoubleSide}));this.outlineDepth.renderOrder=2.5;
      this.outline=new T.Mesh(geometry,new T.MeshBasicMaterial({wireframe:true,transparent:true,depthWrite:false,depthTest:true,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));this.outline.renderOrder=3;
      this.root.add(this.outlineDepth,this.outline);
    }else{this.outline.geometry.dispose();this.outline.geometry=geometry;this.outlineDepth.geometry=geometry;}
    this.applyOutline();
  };
  Viewer.prototype.applyOutline=function(){if(!this.outline)return;var b=this.outlineStyle.brightness;this.outline.material.color.setRGB(b,b,b);this.outline.material.opacity=this.outlineStyle.opacity;this.outline.visible=this.showOutline;this.outlineDepth.visible=this.showOutline;};
  Viewer.prototype.setOutline=function(brightness,opacity){this.outlineStyle={brightness:Math.max(0,Math.min(1,brightness)),opacity:Math.max(.05,Math.min(1,opacity))};this.applyOutline();this.draw();};
  Viewer.prototype.setQuality=function(value){this.quality=value;this.rebuild();};
  Viewer.prototype.setSurfaceMode=function(value){this.surfaceMode=value;this.rebuild();};
  Viewer.prototype.pointerRay=function(event){var rect=this.container.getBoundingClientRect(),mouse=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),caster=new THREE.Raycaster();this.camera.updateMatrixWorld();caster.setFromCamera(mouse,this.camera);return caster;};
  Viewer.prototype.pickPart=function(event){if(event.shiftKey||!this.paintMesh)return 1;var objects=[this.paintMesh];if(this.trackGroup&&this.surfaceMode==='blend')objects.push(this.trackMesh);var hits=this.pointerRay(event).intersectObjects(objects);if(!hits.length)return false;var sample=(hits[0].object===this.trackMesh?this.trackTriangles:this.samples)[hits[0].faceIndex];return sample?sample.part:1;};
  Viewer.prototype.setTurret=function(degrees){
    if(!this.loadedData)return;var hit=this.loadedData.hit,limits=(hit.target||{}).turretYawLimits,initial=(hit.aim||[])[0],lo=-180,hi=180;
    if(Array.isArray(limits)&&limits.length===2&&Number.isFinite(initial)){lo=Math.max(-180,(limits[0]-initial)*180/Math.PI);hi=Math.min(180,(limits[1]-initial)*180/Math.PI);}
    this.turretAngle=Math.max(lo,Math.min(hi,degrees));if(this.onTurret)this.onTurret({angle:this.turretAngle,min:lo,max:hi});
    this.setGun(this.gunAngle);this.turretPending=true;this.draw();
  };
  Viewer.prototype.gunRange=function(){
    var hit=this.loadedData&&this.loadedData.hit,info=hit&&(hit.target||{}).gunPitchLimits,initial=hit&&(hit.aim||[])[1];
    if(!info||!Array.isArray(info.samples)||!Number.isFinite(initial))return {min:-45,max:45,known:false};
    var yaw=((hit.aim||[])[0]||0)+this.turretAngle*Math.PI/180;yaw=Math.atan2(Math.sin(yaw),Math.cos(yaw));var rows=info.samples,a=rows[0],b=rows[rows.length-1];
    for(var i=1;i<rows.length;i++)if(rows[i][0]>=yaw){a=rows[i-1];b=rows[i];break;}
    var f=Math.max(0,Math.min(1,(yaw-a[0])/Math.max(1e-9,b[0]-a[0])));
    return {min:(a[1]+(b[1]-a[1])*f-initial)*180/Math.PI,max:(a[2]+(b[2]-a[2])*f-initial)*180/Math.PI,known:true};
  };
  Viewer.prototype.setGun=function(degrees){if(!this.loadedData)return;var limits=this.gunRange();this.gunAngle=Math.max(limits.min,Math.min(limits.max,degrees));this.turretPending=true;this.draw();if(this.onGun)this.onGun({angle:this.gunAngle,known:limits.known});};
  Viewer.prototype.resetPose=function(){this.turretAngle=0;this.gunAngle=0;this.setTurret(0);};
  Viewer.prototype.applyTurret=function(){
    this.turretPending=false;if(!this.loadedData)return;var T=THREE,source=this.loadedData,parts=source.hit.target.parts,turret=parts.find(function(p){return p.id===2;}),hull=parts.find(function(p){return p.id===1;});if(!turret||!turret.transform)return;
    var pivot=new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(turret.transform)),axis=new T.Vector3(0,1,0);if(hull&&hull.transform)axis.transformDirection(new T.Matrix4().fromArray(hull.transform));
    var rotation=new T.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z).multiply(new T.Matrix4().makeRotationAxis(axis,this.turretAngle*Math.PI/180)).multiply(new T.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
    var gun=parts.find(function(p){return p.id===3;}),gunRotation=null;
    if(gun&&gun.transform){var g=new T.Matrix4().fromArray(gun.transform).premultiply(rotation),gp=new T.Vector3().setFromMatrixPosition(g),ga=new T.Vector3(1,0,0).transformDirection(g);var info=source.hit.target.gunPitchLimits,yaw0=(source.hit.aim||[])[0]||0,yaw=yaw0+this.turretAngle*Math.PI/180;var correction=function(y){y=Math.atan2(Math.sin(y),Math.cos(y));return info?info.hullTurretPitch*(1-2*Math.abs(y)/Math.PI)+info.gunJointPitch:0;};var delta=this.gunAngle*Math.PI/180+correction(yaw0)-correction(yaw);gunRotation=new T.Matrix4().makeTranslation(gp.x,gp.y,gp.z).multiply(new T.Matrix4().makeRotationAxis(ga,delta)).multiply(new T.Matrix4().makeTranslation(-gp.x,-gp.y,-gp.z));}
    var changed=parts.map(function(p){var copy=Object.assign({},p);if((p.id===2||p.id===3)&&p.transform)copy.transform=rotation.clone().multiply(new T.Matrix4().fromArray(p.transform)).toArray();if(p.id===3&&gunRotation&&copy.transform)copy.transform=gunRotation.clone().multiply(new T.Matrix4().fromArray(copy.transform)).toArray();return copy;});
    this.posedData={hit:Object.assign({},source.hit,{target:Object.assign({},source.hit.target,{parts:changed})}),models:source.models};
    // Recorded hit markers belong to the saved pose, not the exploratory pose.
    this.root.children.forEach(function(o){if(o!==this.paintMesh&&o!==this.trackGroup&&o!==this.outline&&o!==this.outlineDepth)o.visible=Math.abs(this.turretAngle)<.001&&Math.abs(this.gunAngle)<.001;},this);this.rebuild();
  };
  Viewer.prototype.load=function(data){
    this.clear();var T=THREE,self=this;var hit=data.hit, parts=(hit.target||{}).parts||[], transforms={};
    parts.forEach(function(part){if(part.transform)transforms[part.id]=new T.Matrix4().fromArray(part.transform);});
    this.loadedData=data;this.posedData=null;this.turretAngle=0;this.gunAngle=0;this.currentArmor=document.getElementById('armor-version').value==='current';this.rebuild();if(this.onTurret)this.onTurret({angle:0,min:-180,max:180});
    this.root.updateMatrixWorld(true);
    var box=new T.Box3().setFromObject(this.root);this.bounds=box.isEmpty()?null:box;
    (hit.points||[]).forEach(function(p){if(p.status!=='resolved'||!transforms[p.part]||!p.position||!p.direction)return;var pos=new T.Vector3().fromArray(p.position).applyMatrix4(transforms[p.part]);pos.z*=-1;var direction=new T.Vector3().fromArray(p.direction).transformDirection(transforms[p.part]);direction.z*=-1;var color=0xfaf3cf;self.addReticle(pos);var arrow=new T.ArrowHelper(direction,pos.clone().addScaledVector(direction,-2.3),2.3,color,.12,.045);arrow.line.material.depthTest=false;arrow.cone.material.depthTest=false;arrow.line.material.depthWrite=false;arrow.cone.material.depthWrite=false;arrow.line.material.transparent=true;arrow.cone.material.transparent=true;arrow.line.renderOrder=4;arrow.cone.renderOrder=4;self.root.add(arrow);if(!self.point){self.point=pos.clone();self.travel=direction.clone();}});
    this.reset();if(this.point)this.focus();if(this.onGun)this.onGun({angle:0,known:this.gunRange().known});return !!this.bounds;
  };
  Viewer.prototype.addReticle=function(position){
    var element=document.createElement('span');element.className='hit-reticle';element.hidden=true;
    element.innerHTML='<svg viewBox="0 0 32 32" role="img" aria-label="Hit location"><path class="reticle-outline" d="M16 1V10M16 22V31M1 16H10M22 16H31"/><path class="reticle-stroke" d="M16 1V10M16 22V31M1 16H10M22 16H31"/></svg>';
    this.reticleLayer.appendChild(element);this.reticles.push({position:position.clone(),element:element});
  };
  Viewer.prototype.updateReticles=function(){
    var self=this,w=this.container.clientWidth,h=this.container.clientHeight;
    this.reticles.forEach(function(marker){var p=marker.position.clone().project(self.camera);marker.element.hidden=(Math.abs(self.turretAngle)>.001||Math.abs(self.gunAngle)>.001)||p.z<-1||p.z>1||Math.abs(p.x)>1||Math.abs(p.y)>1;if(!marker.element.hidden){marker.element.style.left=(p.x+1)*w/2+'px';marker.element.style.top=(1-p.y)*h/2+'px';}});
  };
  // Fit the actual projected mesh, including off-centre impacts. Only the lens
  // changes: the camera remains on the recorded shot line at the chosen distance.
  Viewer.prototype.framing=function(){if(!this.engine)return null;var min=new THREE.Vector2(Infinity,Infinity),max=new THREE.Vector2(-Infinity,-Infinity),v=new THREE.Vector3(),camera=this.camera,tangent=Math.tan(camera.fov*Math.PI/360);this.engine.triangles.forEach(function(t){[t.a,t.b,t.c].forEach(function(p){v.fromArray(p).applyMatrix4(camera.matrixWorldInverse);if(v.z>=-camera.near)return;v.x/=(-v.z*tangent*camera.aspect);v.y/=(-v.z*tangent);min.min(v);max.max(v);});});if(!Number.isFinite(min.x))return null;return {center:min.clone().add(max).multiplyScalar(.5),zoom:Math.max(.1,Math.min(150,1.72/Math.max(max.x-min.x,max.y-min.y,.001)))};};
  Viewer.prototype.autoFit=function(){var frame=this.framing();if(!frame)return;this.frameCenter.copy(frame.center);this.fitZoom=frame.zoom;this.camera.zoom=Math.max(.1,Math.min(150,this.fitZoom*this.frameScale));this.projection();};
  Viewer.prototype.fit=function(){this.frameScale=1;this.render();this.autoFit();this.draw();};
  Viewer.prototype.setAutoFrame=function(value){this.autoFrame=!!value;this.render();};
  Viewer.prototype.setScale=function(value){this.frameScale=Math.max(.1,Math.min(10,value));if(this.autoFrame)this.render();else this.setZoom(this.fitZoom*this.frameScale);};
  Viewer.prototype.setTrackOpacity=function(value){this.trackOpacity=Math.max(.05,Math.min(.85,value));this.updateTrackAppearance();this.draw();};
  Viewer.prototype.reset=function(){if(this.bounds){this.bounds.getCenter(this.target);this.grid.position.y=this.bounds.min.y-.025;}this.distance=this.defaults.distance;this.yaw=.65;this.pitch=.25;this.render();if(!this.autoFrame){this.autoFit();this.draw();}};
  Viewer.prototype.setPivot=function(mode){this.pivot=mode==='vehicle'?'vehicle':'hit';if(this.point)this.focus();else this.reset();};
  Viewer.prototype.focus=function(){if(!this.point)return;if(this.pivot==='vehicle'&&this.bounds)this.bounds.getCenter(this.target);else this.target.copy(this.point);var v=this.travel.clone().negate().normalize();this.yaw=Math.atan2(v.x,v.z);this.pitch=Math.asin(Math.max(-1,Math.min(1,v.y)));this.distance=this.defaults.distance;this.render();if(!this.autoFrame){this.autoFit();this.draw();}};
  Viewer.prototype.configure=function(shell,heatmap,palette){this.shell=shell;this.heatmap=heatmap;this.palette=palette;this.updateTrackAppearance();this.render();};
  Viewer.prototype.shotProbability=function(shell){
    if(!this.engine||!this.point||!this.travel||!shell||Math.abs(this.turretAngle)>.001||Math.abs(this.gunAngle)>.001)return null;
    var span=this.bounds?this.bounds.getSize(new THREE.Vector3()).length():20;
    return this.engine.ray(this.point.clone().addScaledVector(this.travel,-span*2-2).toArray(),this.travel.toArray(),shell);
  };
  Viewer.prototype.setShotContext=function(context){
    var T=THREE,self=this,target=this.loadedData&&this.loadedData.hit.target;
    this.savedAim=null;this.aimGroup=new T.Group();this.root.add(this.aimGroup);
    if(!context||!context.aim||!target||!target.worldTransform)return false;
    var inverse=new T.Matrix4().fromArray(target.worldTransform).invert();
    function pos(p){var v=new T.Vector3().fromArray(p).applyMatrix4(inverse);v.z*=-1;return v;}
    function dir(p){var v=new T.Vector3().fromArray(p).transformDirection(inverse);v.z*=-1;return v;}
    function ring(marker,color,dashed){
      if(!marker||!marker.position||!marker.direction||!(marker.diameter>0))return;
      var center=pos(marker.position),normal=dir(marker.direction),up=new T.Vector3(0,1,0);if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
      var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();var radius=marker.diameter/2,points=[];
      for(var i=0;i<=96;i++){var a=i/96*Math.PI*2;points.push(center.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
      var options={color:color,depthTest:false,depthWrite:false,transparent:true,opacity:.85},material=dashed?new T.LineDashedMaterial(Object.assign(options,{dashSize:radius*.1,gapSize:radius*.07})):new T.LineBasicMaterial(options);
      var line=new T.Line(new T.BufferGeometry().setFromPoints(points),material);if(dashed)line.computeLineDistances();line.renderOrder=12;self.aimGroup.add(line);
      if(!dashed){var size=Math.max(.025,Math.min(.12,radius*.12)),cross=[center.clone().addScaledVector(right,-size),center.clone().addScaledVector(right,size),center.clone().addScaledVector(up,-size),center.clone().addScaledVector(up,size)];var mark=new T.LineSegments(new T.BufferGeometry().setFromPoints(cross),new T.LineBasicMaterial(options));mark.renderOrder=12;self.aimGroup.add(mark);self.savedAim={center:center,normal:normal,right:right,up:up,radius:radius,origin:pos(context.tracer.origin)};}
    }
    ring(context.aim.clientMarker,0x68d7be,false);
    var server=context.aim.serverMarker,client=context.aim.clientMarker;
    if(server&&Number.isFinite(server.receivedAt)&&Math.abs(server.receivedAt-client.receivedAt)<.5)ring(server,0xeac36e,true);
    this.showSavedAim(document.getElementById('show-aim').checked);return !!this.savedAim;
  };
  Viewer.prototype.showSavedAim=function(value){if(this.aimGroup)this.aimGroup.visible=!!value&&Math.abs(this.turretAngle)<.001&&Math.abs(this.gunAngle)<.001;this.draw();};
  Viewer.prototype.savedAimProbability=function(shell){
    if(!this.savedAim||!this.engine||!shell||Math.abs(this.turretAngle)>.001||Math.abs(this.gunAngle)>.001)return null;
    var aim=this.savedAim,count=256,sum=0,unknown=0,origin=aim.origin.toArray();
    for(var i=0;i<count;i++){var r=aim.radius*Math.sqrt(-.5*Math.log(1-(i+.5)/count*(1-Math.exp(-2)))),angle=i*2.399963229728653,p=aim.center.clone().addScaledVector(aim.right,r*Math.cos(angle)).addScaledVector(aim.up,r*Math.sin(angle)),hit=this.engine.ray(origin,p.sub(aim.origin).toArray(),shell);if(hit.chance===null)unknown++;else sum+=hit.chance;}
    return {low:sum/count,high:(sum+unknown*100)/count,unknown:unknown};
  };
  Viewer.prototype.armorVersion=function(current){this.currentArmor=current;this.rebuild();};
  Viewer.prototype.resetGPU=function(){if(this.gpu)this.gpu.dispose();this.gpu=null;this.gpuAttempted=false;this.gpuError=null;};
  Viewer.prototype.computeMode=function(mode){if(this.surface)this.surface.dispose();this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.gpuMode=mode==='cpu'?'cpu':'auto';this.resetGPU();this.rebuild();};
  Viewer.prototype.computeResults=function(origin){
    var B=ArmorBallistics,self=this,code=function(r){return r.chance===null?101:r.reason==='no-hull'?102:r.chance;},at=function(i){return code(self.heatEngine.ray(origin,B.sub(self.samples[i].center,origin),self.shell));};
    if(this.gpuMode==='auto'&&!this.gpuAttempted){this.gpuAttempted=true;try{if(!window.ArmorHeatmapGPU)throw new Error('GPU-module unavailable');this.gpu=new ArmorHeatmapGPU(this.renderer,this.heatEngine,this.samples);}catch(e){this.gpuError=e.message;}}
    if(this.gpu){try{
      var results=this.gpu.compute(origin,this.shell),resolved=0;
      for(var i=0;i<results.length;i++)if(results[i]===103){results[i]=at(i);resolved++;}
      // A small CPU spot check also catches driver/compiler problems. Float32
      // may change a rounded probability by one point; larger differences fail.
      var count=Math.min(16,results.length);
      for(var k=0;k<count;k++){var n=Math.floor(k*(results.length-1)/Math.max(1,count-1)),expected=at(n),actual=results[n];if(actual!==expected&&!(actual<=100&&expected<=100&&Math.abs(actual-expected)<=1))throw new Error('GPU result failed the CPU cross-check');}
      this.backendText='GPU · WebGL 2'+(resolved?' · complex rays on CPU':'');return results;
    }catch(e){this.gpuError=e.message;this.gpu.dispose();this.gpu=null;console.warn('Armor heatmap uses CPU:',e.message);}}
    var output=new Uint8Array(this.samples.length);for(var j=0;j<output.length;j++)output[j]=at(j);
    this.backendText=this.gpuMode==='cpu'?'CPU · chosen manually':'CPU · '+(this.gpuError||'GPU unavailable');return output;
  };
  Viewer.prototype.paint=function(){
    if(!this.paintMesh)return;
    var composed=false;if(this.surfaceMode==='blend'&&this.heatmap&&this.gpuMode==='auto'){
      if(!this.surfaceAttempted){this.surfaceAttempted=true;try{this.surface=new BullbaScreenArmor(this.renderer,this.engine);this.scene.add(this.surface.quad);}catch(e){this.surfaceError=e.message;console.warn('Screen composition unavailable:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','unavailable: '+e.message);}}
      if(this.surface){try{var size=this.surface.render(this.camera,this.target,this.shell,this.palette,this.trackOpacity,this.quality,this.container.clientWidth,this.container.clientHeight,this.renderer.getPixelRatio());var check=this.surface.verify(this.camera,this.shell);
        // A failed cross-check hides this frame only; the next camera key is verified afresh. Nothing here is sticky.
        if(check&&check.failed){this.surfaceError=check.message;if(this.surfaceLogged!==check.message){this.surfaceLogged=check.message;console.warn('Screen composition hidden:',check.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','mismatch: '+check.message);}}
        else{composed=true;this.surfaceError=null;if(this.onBackend)this.onBackend('GPU · layers at window size · '+size+(check?' · CPU cross-check '+(check.compared-check.mismatches.length)+'/'+check.compared:''));}}
        catch(e){this.surfaceError=e.message;this.surface.dispose();this.surface=null;console.warn('Screen composition disabled:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','error: '+e.message);}}
    }
    if(this.surface)this.surface.quad.visible=composed;this.paintMesh.visible=!composed;this.trackGroup.visible=!composed&&this.surfaceMode==='blend';if(composed)return;
    if(this.surfaceMode==='blend'&&this.heatmap&&this.gpuMode==='auto'){
      // No sample-based substitute in the mask mode: a neutral model and the reason instead of a coarse picture.
      var neutral=this.paintMesh.geometry.attributes.color.array;for(var q=0;q<neutral.length;q+=3){neutral[q]=baseColors[0][0];neutral[q+1]=baseColors[0][1];neutral[q+2]=baseColors[0][2];}
      this.paintedKey=null;this.paintMesh.geometry.attributes.color.needsUpdate=true;
      if(this.onBackend)this.onBackend('Estimate unavailable: '+(this.surfaceError||'GPU-composition did not run'));return;
    }
    var B=ArmorBallistics,origin=this.camera.position.toArray(),buffer=this.paintMesh.geometry.attributes.color.array;
    var raysKey=origin.join(',')+'|'+JSON.stringify(this.shell),paintedKey=this.heatmap?raysKey+'|'+this.palette:'parts';
    if(this.cachedEngine!==this.engine){this.cachedEngine=this.engine;this.cachedRaysKey=null;this.paintedKey=null;}
    if(this.paintedKey===paintedKey)return;
    if(this.heatmap&&this.cachedRaysKey!==raysKey){
      if(!this.cachedResults||this.cachedResults.length!==this.samples.length)this.cachedResults=new Uint8Array(this.samples.length);
      if(!this.shell){this.cachedResults.fill(101);this.backendText='Waiting for shell parameters';}
      else this.cachedResults=this.computeResults(origin);
      this.cachedRaysKey=raysKey;
    }
    var table=this.heatmap?colorTable(this.palette):null;
    if(this.onBackend)this.onBackend(this.heatmap?this.backendText:'Vehicle parts · estimate off');
    for(var n=0;n<this.samples.length;n++){var sample=this.samples[n],module=sample.part===0||(sample.armor&&sample.armor.vehicleDamageFactor<=1e-5);var color=this.heatmap?(this.surfaceMode!=='through'&&module?baseColors[0]:table[this.cachedResults[n]]):baseColors[sample.part%4];for(var j=0;j<3;j++)for(var k=0;k<3;k++)buffer[n*9+j*3+k]=color[k];}
    this.paintedKey=paintedKey;this.paintMesh.geometry.attributes.color.needsUpdate=true;this.draw();
  };
  Viewer.prototype.inspect=function(event){
    if(!this.engine||!this.onInspect)return;var raycaster=this.pointerRay(event),objects=this.paintMesh?[this.paintMesh]:[];if(this.trackGroup&&this.surfaceMode==='blend')objects.push(this.trackMesh);var hits=raycaster.intersectObjects(objects),sample=hits.length?(hits[0].object===this.trackMesh?this.trackTriangles:this.samples)[hits[0].faceIndex]:null,result=this.engine.ray(raycaster.ray.origin.toArray(),raycaster.ray.direction.toArray(),this.shell);if(sample)result.surface={part:sample.part,armor:sample.armor};this.onInspect(result);
  };
  Viewer.prototype.wireframe=function(value){this.showOutline=!!value;this.applyOutline();this.draw();};
  Viewer.prototype.aimAt=function(event){var ray=this.pointerRay(event).ray,normal=this.target.clone().sub(this.camera.position).normalize(),plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,this.target),point=new THREE.Vector3();if(ray.intersectPlane(plane,point)){this.spreadAim=point;this.hideSpread();if(this.onAim)this.onAim('Estimate centre moved. Press “Estimate”.');}};
  Viewer.prototype.hideSpread=function(){if(this.spreadCircle){this.scene.remove(this.spreadCircle);this.spreadCircle.geometry.dispose();this.spreadCircle.material.dispose();this.spreadCircle=null;this.draw();}};
  Viewer.prototype.estimateSpread=function(radius100){
    if(this.turretPending)this.applyTurret();
    if(!this.engine||!this.shell)throw new Error('Pick a shell and penetration first.');
    if(!Number.isFinite(radius100)||radius100<0||radius100>10)throw new Error('The radius must be between 0 and 10 m at 100 m.');
    var T=THREE,aim=this.spreadAim||this.point||this.target,origin=this.camera.position.clone(),normal=aim.clone().sub(origin).normalize(),up=new T.Vector3(0,1,0);if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
    var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();var radius=origin.distanceTo(aim)*radius100/100,points=[],count=1024,sum=0,unknown=0,miss=0,o=origin.toArray();
    for(var i=0;i<count;i++){var r=radius*Math.sqrt(-.5*Math.log(1-(i+.5)/count*(1-Math.exp(-2)))),angle=i*2.399963229728653,point=aim.clone().addScaledVector(right,r*Math.cos(angle)).addScaledVector(up,r*Math.sin(angle)),hit=this.engine.ray(o,point.sub(origin).toArray(),this.shell);if(hit.chance===null)unknown++;else sum+=hit.chance;if(hit.reason==='no-hull')miss++;}
    for(var j=0;j<96;j++){var a=j/96*Math.PI*2;points.push(aim.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
    this.hideSpread();this.spreadCircle=new T.LineLoop(new T.BufferGeometry().setFromPoints(points),new T.LineBasicMaterial({color:0xf1d18b,depthTest:false}));this.spreadCircle.renderOrder=10;this.scene.add(this.spreadCircle);this.draw();
    return {low:sum/count,high:(sum+unknown*100)/count,unknown:unknown,miss:miss/count*100,samples:count};
  };
  window.ArmorViewer=Viewer;
}());
