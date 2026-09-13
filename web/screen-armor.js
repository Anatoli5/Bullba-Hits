/* Rasterized depth layers + physical composition at window resolution. No per-pixel BVH traversal.
   Every layer is one 2-channel float snapshot of the model from the viewer's camera: R = depth along the view
   axis, G = material id (integer part) + cos(angle)/2 (fraction). One depth buffer is shared by all layers. */
(function(root){
  'use strict';
  var COUNT=8,CHECK=48,T=root.THREE;
  var vertex=`precision highp float;
in vec3 position; in vec3 normal; in float materialId;
uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
out vec3 vPosition; flat out vec3 vNormal; flat out float vMaterial;
void main(){vPosition=position;vNormal=normal;vMaterial=materialId;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
  var peelDeclarations=Array.from({length:COUNT},function(_,i){return 'uniform highp sampler2D uPeel'+i+';';}).join('\n');
  var peelFetches=Array.from({length:COUNT},function(_,i){return 'if(index=='+i+')return texelFetch(uPeel'+i+',p,0).g;';}).join('\n');
  var peel=`precision highp float; precision highp int;
uniform highp sampler2D uPrevious; uniform bool uFirst; uniform int uPass;
uniform highp sampler2D uMaterials;
${peelDeclarations}
uniform vec3 uOrigin; uniform vec3 uAnchor; uniform vec3 uForward;
in vec3 vPosition; flat in vec3 vNormal; flat in float vMaterial;
out vec2 outputLayer;
float earlier(int index,ivec2 p){${peelFetches}return 0.0;}
void main(){
 vec3 ray=normalize(vPosition-uOrigin);
 // Depth is relative to the target plane, avoiding subtraction of 1500 m values.
 float d=dot(vPosition-uAnchor,uForward)/max(.001,dot(ray,uForward));
 if(!uFirst){ivec2 p=ivec2(gl_FragCoord.xy);vec2 prev=texelFetch(uPrevious,p,0).rg;
  if(prev.y<.5||d<prev.x-.00001||(abs(d-prev.x)<=.00001&&vMaterial<=floor(prev.y)))discard;
  // A collide-once material (tracks, screens) counts once per ray: its further surfaces take no layer,
  // exactly as the ballistic law ignores them. Otherwise a track seen along its length eats every layer.
  int id=int(floor(vMaterial))-1;
  if(texelFetch(uMaterials,ivec2(1,id),0).x>.5){for(int j=0;j<${COUNT};j++){if(j>=uPass)break;float y=earlier(j,p);if(y>.5&&int(floor(y))-1==id)discard;}}}
 outputLayer=vec2(d,vMaterial+abs(dot(ray,normalize(vNormal)))*.5);
}`;
  var quadVertex=`precision highp float; in vec3 position; out vec2 vUV;
void main(){vUV=position.xy*.5+.5;gl_Position=vec4(position.xy,0.0,1.0);}`;
  var declarations=Array.from({length:COUNT+1},function(_,i){return 'uniform highp sampler2D uLayer'+i+';';}).join('\n');
  var fetches=Array.from({length:COUNT+1},function(_,i){return 'if(index=='+i+')return texture(uLayer'+i+',uv).rg;';}).join('\n');
  var composite=`precision highp float; precision highp int;
${declarations}
uniform highp sampler2D uMaterials; uniform vec4 uPen; uniform vec4 uShell; uniform ivec4 uFlags;
uniform bool uClassic; uniform float uOpacity; uniform bool uCheck; uniform vec2 uCheckUV[${CHECK}];
in vec2 vUV; out vec4 outputColor;
const float EPS=.00001;
vec2 layer(int index,vec2 uv){${fetches}return vec2(0.0);}
vec4 material(int id,int row){return texelFetch(uMaterials,ivec2(row,id),0);}
float erfApprox(float x){float s=x<0.0?-1.0:1.0;x=abs(x);float t=1.0/(1.0+.3275911*x);return s*(1.0-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*exp(-x*x));}
float probability(float remaining,float plate){float margin=(remaining-plate)/uPen.x;if(uPen.z<=EPS)return margin>=0.0?1.0:0.0;if(uPen.w<.5)return -1.0;return clamp(.5*(1.0+erfApprox(margin/uPen.z/.33/sqrt(2.0))),0.0,1.0);}
vec3 palette(float p){vec3 lo=uClassic?vec3(.90,.20,.18):vec3(.63,.18,.55),mid=uClassic?vec3(.97,.79,.22):vec3(.95,.75,.31),hi=uClassic?vec3(.20,.79,.35):vec3(.20,.84,.76);return p<.5?mix(lo,mid,p*2.0):mix(mid,hi,p*2.0-1.0);}
// Same law as ArmorBallistics.evaluate: -3 = nothing on this pixel, -2 = no main armour, -1 = unknown, 0..1 = chance.
float evaluate(vec2 uv,out vec4 front,out bool screen){
 vec2 first=layer(0,uv);front=vec4(-2.0);screen=false;if(first.y<.5)return -3.0;
 front=material(int(floor(first.y))-1,0);screen=front.y<=EPS;
 float remaining=uPen.x,jetStart=0.0,result=-2.0;bool jet=false,finished=false;
 int ignored[${COUNT}];int ignoredCount=0;
 if(uFlags.w==0){return -1.0;}
 for(int i=0;i<${COUNT};i++){
  if(finished)break;vec2 hit=layer(i,uv);if(hit.y<.5){finished=true;break;}
  int id=int(floor(hit.y))-1;float cosine=fract(hit.y)*2.0;bool skip=false;for(int j=0;j<${COUNT};j++){if(j>=ignoredCount)break;if(ignored[j]==id)skip=true;}if(skip)continue;
  vec4 a=material(id,0),flags=material(id,1);if(a.x<-1.5){result=-1.0;finished=true;break;}if(a.x<0.0)continue;
  if(a.z<=.5)cosine=1.0;
  bool bounce=uFlags.x!=0&&a.w>.5&&a.x>EPS&&cosine<=uShell.y;
  if(!jet&&bounce&&(flags.y<.5||uFlags.y==0||a.x*3.0>=uPen.y)){result=0.0;finished=true;break;}
  if(jet)remaining*=max(0.0,1.0-max(0.0,hit.x-jetStart)*uShell.z);
  float n=uShell.x;if(flags.z>.5&&a.x>EPS&&uPen.y>a.x*2.0)n*=1.4*uPen.y/(a.x*2.0);
  float plate=a.x;if(a.z>.5)plate/=max(EPS,cos(max(0.0,acos(clamp(cosine,0.0,1.0))-n)));
  if(a.y>EPS){result=probability(remaining,plate);finished=true;break;}
  if(uShell.w>.5){if(uFlags.z==0){result=0.0;finished=true;break;}remaining-=plate*3.0;}else remaining-=plate;
  if(flags.x>.5){ignored[ignoredCount]=id;ignoredCount++;}
  jet=uShell.z>0.0;if(jet)jetStart=hit.x+a.x*.001;
 }
 if(!finished&&layer(${COUNT},uv).y>.5)result=-1.0; // Never silently truncate a ninth layer.
 return result;
}
void main(){
 vec4 front;bool screen;
 if(uCheck){int i=int(gl_FragCoord.x);float r=evaluate(uCheckUV[i],front,screen);outputColor=vec4(r,front.x,0.0,1.0);return;}
 float result=evaluate(vUV,front,screen);
 if(result<-2.5){outputColor=vec4(0.0);return;}
 // Screens overlay as neutral grey: a probability-looking tint on top of the armour result misled readers.
 vec3 tint=vec3(.45,.50,.55);
 // Screen with nothing behind it: nothing to penetrate, so a neutral translucent grey instead of a probability-looking tint.
 if(result<-1.5){outputColor=screen?vec4(.45,.50,.55,uOpacity*.6):vec4(.21,.27,.33,1.0);return;}
 vec3 color=result<0.0?vec3(.34,.42,.49):palette(result);
 if(screen)color=mix(color,tint,uOpacity);
 outputColor=vec4(color,1.0);
}`;
  function Surface(renderer,engine){
    if(!renderer.capabilities.isWebGL2)throw new Error('WebGL 2 required');
    var gl=renderer.getContext();if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('no float colour textures');
    if(renderer.capabilities.maxTextures<COUNT+2)throw new Error('not enough texture units');
    var ext=gl.getExtension('WEBGL_debug_renderer_info');if(ext&&/swiftshader|llvmpipe|software|basic render/i.test(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))throw new Error('software WebGL');
    this.renderer=renderer;this.targets=[];this.key=null;this.width=0;this.height=0;this.materialTexture=null;this.checked=null;
    this.captureScene=new T.Scene();this.captureCamera=new T.PerspectiveCamera();
    this.peelMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:vertex,fragmentShader:peel,side:T.DoubleSide,blending:T.NoBlending,toneMapped:false,uniforms:{uPrevious:{value:null},uFirst:{value:true},uPass:{value:0},uMaterials:{value:null},uOrigin:{value:new T.Vector3()},uAnchor:{value:new T.Vector3()},uForward:{value:new T.Vector3()}}});
    this.mesh=new T.Mesh(new T.BufferGeometry(),this.peelMaterial);this.mesh.frustumCulled=false;this.captureScene.add(this.mesh);
    var checkUV=[];for(var c=0;c<CHECK;c++)checkUV.push(new T.Vector2());
    var uniforms={uMaterials:{value:null},uPen:{value:new T.Vector4()},uShell:{value:new T.Vector4()},uFlags:{value:new Int32Array(4)},uClassic:{value:false},uOpacity:{value:.35},uCheck:{value:false},uCheckUV:{value:checkUV}};
    // One depth attachment serves every layer: peeling needs it only within a pass.
    this.blank=new T.DataTexture(new Float32Array(4),1,1,T.RGBAFormat,T.FloatType);this.blank.needsUpdate=true;
    this.depth=new T.DepthTexture(1,1);this.depth.format=T.DepthFormat;this.depth.type=T.UnsignedIntType;
    for(var i=0;i<=COUNT;i++){var target=new T.WebGLRenderTarget(1,1,{type:T.FloatType,format:T.RGFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true,stencilBuffer:false,depthTexture:this.depth});target.texture.generateMipmaps=false;this.targets.push(target);uniforms['uLayer'+i]={value:target.texture};if(i<COUNT)this.peelMaterial.uniforms['uPeel'+i]={value:this.blank};}
    this.material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:composite,uniforms:uniforms,transparent:true,depthWrite:false,depthTest:false,toneMapped:false});
    this.quad=new T.Mesh(new T.PlaneGeometry(2,2),this.material);this.quad.frustumCulled=false;this.quad.renderOrder=0;
    this.checkTarget=new T.WebGLRenderTarget(CHECK,1,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false,stencilBuffer:false});
    this.checkScene=new T.Scene();this.checkCamera=new T.Camera();
    try{this.update(engine);var error=null,previous=renderer.debug.onShaderError;renderer.debug.onShaderError=function(gl,p,v,f){error=gl.getProgramInfoLog(p)||gl.getShaderInfoLog(f)||'shader error';};try{renderer.compile(this.captureScene,this.captureCamera);var scene=new T.Scene();scene.add(this.quad);renderer.compile(scene,this.checkCamera);scene.remove(this.quad);}finally{renderer.debug.onShaderError=previous;}if(error)throw new Error(error);this.quad.visible=false;}catch(e){this.dispose();throw e;}
  }
  Surface.prototype.update=function(engine){
    var keys=Object.create(null),mats=[],rows=[],position=[],normal=[],ids=[];
    engine.triangles.forEach(function(t){var key=t.part+':'+t.name,id=keys[key],a=t.armor;if(a&&a.armor===null)return; // 0 mm devices stay: the law starts a HEAT jet on them exactly as the CPU path does
      if(id===undefined){id=mats.length/8;keys[key]=id;mats.push(a?(a.armor==null?-1:a.armor):-2,a?a.vehicleDamageFactor:0,a&&a.useHitAngle?1:0,a&&a.mayRicochet?1:0,a&&a.collideOnceOnly?1:0,a&&a.checkCaliberForRicochet?1:0,a&&a.checkCaliberForHitAngleNorm?1:0,0);}
      rows.push({t:t,id:id});
    });
    if(mats.length/8>this.renderer.capabilities.maxTextureSize)throw new Error('too many materials');
    if(mats.length/8>4000)throw new Error('too many materials for the packed layer');
    // Stable material ordering resolves coincident surfaces before depth peeling.
    rows.sort(function(a,b){return b.id-a.id;});rows.forEach(function(row){[row.t.a,row.t.b,row.t.c].forEach(function(p){position.push.apply(position,p);normal.push.apply(normal,row.t.normal);ids.push(row.id+1);});});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(position,3));geometry.setAttribute('normal',new T.Float32BufferAttribute(normal,3));geometry.setAttribute('materialId',new T.Float32BufferAttribute(ids,1));this.mesh.geometry.dispose();this.mesh.geometry=geometry;
    if(this.materialTexture)this.materialTexture.dispose();this.materialTexture=new T.DataTexture(new Float32Array(mats.length?mats:8),2,Math.max(1,mats.length/8),T.RGBAFormat,T.FloatType);this.materialTexture.minFilter=this.materialTexture.magFilter=T.NearestFilter;this.materialTexture.generateMipmaps=false;this.materialTexture.needsUpdate=true;this.material.uniforms.uMaterials.value=this.materialTexture;this.peelMaterial.uniforms.uMaterials.value=this.materialTexture;
    geometry.computeBoundingSphere();geometry.computeBoundingBox();this.radius=geometry.boundingSphere?geometry.boundingSphere.radius:10;this.engine=engine;this.key=null;this.checked=null;
  };
  // Layer resolution: the window itself unless the quality setting or a memory budget says otherwise.
  Surface.prototype.size=function(quality,width,height,pixelRatio){
    var pr=Math.max(1,pixelRatio||1),w=Math.max(1,Math.round(width*pr)),h=Math.max(1,Math.round(height*pr)),longest=Math.max(w,h);
    var limit=quality==='low'?Math.max(512,Math.round(longest/2)):quality==='medium'?1200:quality==='high'?Infinity:1600;
    var caps=this.renderer.capabilities,scale=Math.min(1,limit/longest,caps.maxTextureSize/longest);
    var budget=320*1024*1024,bytes=function(s){return w*s*h*s*((COUNT+1)*8+4);};
    while(bytes(scale)>budget&&scale>.2)scale*=.9;
    return {width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale)),scale:scale,bytes:bytes(scale)};
  };
  Surface.prototype.render=function(camera,anchor,shell,palette,opacity,quality,width,height,pixelRatio){
    var renderer=this.renderer,size=this.size(quality,width,height,pixelRatio);
    if(this.width!==size.width||this.height!==size.height){this.width=size.width;this.height=size.height;this.targets.forEach(function(t){t.setSize(size.width,size.height);});this.key=null;}
    var s=shell||{},u=this.material.uniforms;u.uPen.value.set(s.penetration||0,s.caliber||0,s.randomization||0,!s.randomizationType||s.randomizationType==='NORMAL'?1:0);u.uShell.value.set(s.normalization||0,s.ricochetCos==null?-1:s.ricochetCos,s.jetLossPerMeter||0,s.kind==='HIGH_EXPLOSIVE'?1:0);u.uFlags.value.set([s.mayRicochet?1:0,s.checkCaliber?1:0,s.shieldPenetration?1:0,s.penetration>0&&s.caliber>0?1:0]);u.uClassic.value=palette==='classic';u.uOpacity.value=opacity;u.uCheck.value=false;
    var key=camera.matrixWorld.elements.join(',')+'|'+camera.projectionMatrix.elements.join(',');
    if(key!==this.key){
      this.captureCamera.copy(camera);var distance=camera.position.distanceTo(anchor),span=Math.max(5,this.radius*3);this.captureCamera.near=Math.max(.01,distance-span);this.captureCamera.far=distance+span;this.captureCamera.updateProjectionMatrix();
      var p=this.peelMaterial.uniforms;p.uOrigin.value.copy(camera.position);p.uAnchor.value.copy(anchor);p.uForward.value.copy(anchor).sub(camera.position).normalize();
      var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(new T.Color()),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(new T.Vector4()),scissor=renderer.getScissor(new T.Vector4()),scissorTest=renderer.getScissorTest();
      try{renderer.autoClear=false;renderer.setScissorTest(false);renderer.setClearColor(0,0);for(var i=0;i<=COUNT;i++){p.uFirst.value=i===0;p.uPass.value=i;p.uPrevious.value=this.targets[i===0?COUNT:i-1].texture;for(var j=0;j<COUNT;j++)p['uPeel'+j].value=j<i?this.targets[j].texture:this.blank;renderer.setRenderTarget(this.targets[i]);var gl=renderer.getContext();if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('float-buffer '+size.width+'×'+size.height+' unavailable');renderer.clear(true,true,false);renderer.render(this.captureScene,this.captureCamera);}}finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
      this.key=key;this.checked=null;
    }
    this.quad.visible=true;return size.width+' × '+size.height+(size.scale<.999?' ('+Math.round(size.scale*100)+'% of the window)':'')+' · up to '+COUNT+' layers';
  };
  // Cross-check: the same pixels are evaluated by the JavaScript law through the same camera rays.
  // Screen-space sampling and ray casting meet at pixel centres, so only a few edge pixels may differ.
  Surface.prototype.verify=function(camera,shell){
    var shellKey=JSON.stringify(shell);if(this.checked&&this.checked.shellKey===shellKey)return this.checked;
    var renderer=this.renderer,u=this.material.uniforms,box=this.mesh.geometry.boundingBox,uvs=u.uCheckUV.value,min=new T.Vector2(1,1),max=new T.Vector2(-1,-1),v=new T.Vector3();
    if(!box||!shell||!(shell.penetration>0)||!(shell.caliber>0))return null;
    for(var c=0;c<8;c++){v.set(c&1?box.max.x:box.min.x,c&2?box.max.y:box.min.y,c&4?box.max.z:box.min.z).project(camera);if(v.z>-1&&v.z<1){min.min(new T.Vector2(v.x,v.y));max.max(new T.Vector2(v.x,v.y));}}
    min.clampScalar(-1,1);max.clampScalar(-1,1);if(!(max.x>min.x&&max.y>min.y))return null;
    var cols=8,rows=CHECK/cols;
    for(var i=0;i<CHECK;i++){var fx=((i%cols)+.5)/cols,fy=(Math.floor(i/cols)+.5)/rows,x=min.x+(max.x-min.x)*fx,y=min.y+(max.y-min.y)*fy;
      // Snap to layer texel centres so the GPU sample and the CPU ray describe the same pixel.
      uvs[i].set((Math.floor((x*.5+.5)*this.width)+.5)/this.width,(Math.floor((y*.5+.5)*this.height)+.5)/this.height);}
    var target=renderer.getRenderTarget(),auto=renderer.autoClear,wasVisible=this.quad.visible,parent=this.quad.parent,pixels=new Float32Array(CHECK*4),scene=new T.Scene();
    u.uCheck.value=true;this.quad.visible=true;scene.add(this.quad);
    try{renderer.autoClear=true;renderer.setRenderTarget(this.checkTarget);renderer.render(scene,this.checkCamera);renderer.readRenderTargetPixels(this.checkTarget,0,0,CHECK,1,pixels);}
    finally{scene.remove(this.quad);if(parent)parent.add(this.quad);renderer.setRenderTarget(target);renderer.autoClear=auto;u.uCheck.value=false;this.quad.visible=wasVisible;}
    var origin=camera.position.clone(),compared=0,mismatches=[],code=function(r){return r.chance===null?'unknown':r.reason==='no-hull'?'no-hull':String(r.chance);};
    for(var n=0;n<CHECK;n++){var g=pixels[n*4];if(g<-2.5)continue;var p=new T.Vector3(uvs[n].x*2-1,uvs[n].y*2-1,.5).unproject(camera),dir=p.sub(origin).normalize();
      var cpu=this.engine.ray(origin.toArray(),dir.toArray(),shell),gpu=g<-1.5?'no-hull':g<-.5?'unknown':String(Math.round(g*100));compared++;
      var ok=gpu===code(cpu)||(!isNaN(Number(gpu))&&cpu.chance!==null&&Math.abs(Number(gpu)-cpu.chance)<=1);
      if(!ok)mismatches.push({pixel:n,gpu:gpu,cpu:code(cpu)});}
    var failed=compared>=8&&mismatches.length>Math.max(2,Math.floor(compared*.06));
    this.checked={compared:compared,mismatches:mismatches,shellKey:shellKey,failed:failed,
      message:failed?'GPU-composition disagrees with the CPU: '+mismatches.length+' of '+compared+' pixels ('+mismatches.slice(0,3).map(function(m){return m.gpu+'≠'+m.cpu;}).join(', ')+')':null};
    return this.checked;
  };
  Surface.prototype.dispose=function(){if(this.quad){if(this.quad.parent)this.quad.parent.remove(this.quad);this.quad.geometry.dispose();this.material.dispose();}if(this.mesh)this.mesh.geometry.dispose();if(this.peelMaterial)this.peelMaterial.dispose();if(this.materialTexture)this.materialTexture.dispose();this.targets.forEach(function(t){t.dispose();});if(this.checkTarget)this.checkTarget.dispose();if(this.depth)this.depth.dispose();if(this.blank)this.blank.dispose();};
  root.BullbaScreenArmor=Surface;
}(window));
