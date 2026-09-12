/* Rasterized depth layers + physical composition. No per-pixel BVH traversal. */
(function(root){
  'use strict';
  var COUNT=8,T=root.THREE;
  var vertex=`precision highp float;
in vec3 position; in vec3 normal; in float materialId;
uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
out vec3 vPosition; flat out vec3 vNormal; flat out float vMaterial;
void main(){vPosition=position;vNormal=normal;vMaterial=materialId;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
  var peel=`precision highp float; precision highp int;
uniform highp sampler2D uPrevious; uniform bool uFirst;
uniform vec3 uOrigin; uniform vec3 uAnchor; uniform vec3 uForward;
in vec3 vPosition; flat in vec3 vNormal; flat in float vMaterial;
out vec4 outputLayer;
void main(){
 vec3 ray=normalize(vPosition-uOrigin);
 // Depth is relative to the target plane, avoiding subtraction of 1500 m values.
 float d=dot(vPosition-uAnchor,uForward)/max(.001,dot(ray,uForward));
 if(!uFirst){vec4 prev=texelFetch(uPrevious,ivec2(gl_FragCoord.xy),0);
   if(prev.z<.5||d<prev.x-.00001||(abs(d-prev.x)<=.00001&&vMaterial<=prev.z))discard;}
 outputLayer=vec4(d,abs(dot(ray,normalize(vNormal))),vMaterial,1.0);
}`;
  var quadVertex=`precision highp float; in vec3 position; out vec2 vUV;
void main(){vUV=position.xy*.5+.5;gl_Position=vec4(position.xy,0.0,1.0);}`;
  var declarations=Array.from({length:COUNT+1},function(_,i){return 'uniform highp sampler2D uLayer'+i+';';}).join('\n');
  var fetches=Array.from({length:COUNT+1},function(_,i){return 'if(index=='+i+')return texture(uLayer'+i+',vUV);';}).join('\n');
  var composite=`precision highp float; precision highp int;
${declarations}
uniform highp sampler2D uMaterials; uniform vec4 uPen; uniform vec4 uShell; uniform ivec4 uFlags;
uniform bool uClassic; uniform float uOpacity;
in vec2 vUV; out vec4 outputColor;
const float EPS=.00001;
vec4 layer(int index){${fetches}return vec4(0.0);}
vec4 material(int id,int row){return texelFetch(uMaterials,ivec2(row,id),0);}
float erfApprox(float x){float s=x<0.0?-1.0:1.0;x=abs(x);float t=1.0/(1.0+.3275911*x);return s*(1.0-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*exp(-x*x));}
float probability(float remaining,float plate){float margin=(remaining-plate)/uPen.x;if(uPen.z<=EPS)return margin>=0.0?1.0:0.0;if(uPen.w<.5)return -1.0;return clamp(.5*(1.0+erfApprox(margin/uPen.z/.33/sqrt(2.0))),0.0,1.0);}
vec3 palette(float p){vec3 lo=uClassic?vec3(.90,.20,.18):vec3(.63,.18,.55),mid=uClassic?vec3(.97,.79,.22):vec3(.95,.75,.31),hi=uClassic?vec3(.20,.79,.35):vec3(.20,.84,.76);return p<.5?mix(lo,mid,p*2.0):mix(mid,hi,p*2.0-1.0);}
vec3 thickness(float mm){float p=clamp(mm/300.0,0.0,1.0);return p<.5?mix(vec3(.25,.65,.9),vec3(.96,.77,.35),p*2.0):mix(vec3(.96,.77,.35),vec3(.75,.28,.65),p*2.0-1.0);}
void main(){
 vec4 first=layer(0);if(first.z<.5){outputColor=vec4(0.0);return;}
 vec4 front=material(int(first.z)-1,0);bool screen=front.y<=EPS;
 float remaining=uPen.x,jetStart=0.0,result=-2.0;bool jet=false,finished=false;
 int ignored[${COUNT}];int ignoredCount=0;
 if(uFlags.w==0){result=-1.0;finished=true;}
 for(int i=0;i<${COUNT};i++){
  if(finished)break;vec4 hit=layer(i);if(hit.z<.5){finished=true;break;}
  int id=int(hit.z)-1;bool skip=false;for(int j=0;j<${COUNT};j++){if(j>=ignoredCount)break;if(ignored[j]==id)skip=true;}if(skip)continue;
  vec4 a=material(id,0),flags=material(id,1);if(a.x<-1.5){result=-1.0;finished=true;break;}if(a.x<0.0)continue;
  float cosine=a.z>.5?hit.y:1.0;
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
 if(!finished&&layer(${COUNT}).z>.5)result=-1.0; // Never silently truncate a ninth layer.
 vec3 tint=front.x>=0.0?thickness(front.x):vec3(.38,.46,.54);
 if(result<-1.5){outputColor=screen?vec4(tint,uOpacity):vec4(.21,.27,.33,1.0);return;}
 vec3 color=result<0.0?vec3(.34,.42,.49):palette(result);
 if(screen)color=mix(color,tint,uOpacity);
 outputColor=vec4(color,1.0);
}`;
  function Surface(renderer,engine){
    if(!renderer.capabilities.isWebGL2)throw new Error('нужен WebGL 2');
    var gl=renderer.getContext();if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('нет цветовых float-текстур');
    if(renderer.capabilities.maxTextures<COUNT+2)throw new Error('недостаточно текстурных блоков');
    var ext=gl.getExtension('WEBGL_debug_renderer_info');if(ext&&/swiftshader|llvmpipe|software|basic render/i.test(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))throw new Error('программный WebGL');
    this.renderer=renderer;this.targets=[];this.key=null;this.width=0;this.height=0;this.materialTexture=null;
    this.captureScene=new T.Scene();this.captureCamera=new T.PerspectiveCamera();
    this.peelMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:vertex,fragmentShader:peel,side:T.DoubleSide,blending:T.NoBlending,toneMapped:false,uniforms:{uPrevious:{value:null},uFirst:{value:true},uOrigin:{value:new T.Vector3()},uAnchor:{value:new T.Vector3()},uForward:{value:new T.Vector3()}}});
    this.mesh=new T.Mesh(new T.BufferGeometry(),this.peelMaterial);this.mesh.frustumCulled=false;this.captureScene.add(this.mesh);
    var uniforms={uMaterials:{value:null},uPen:{value:new T.Vector4()},uShell:{value:new T.Vector4()},uFlags:{value:new Int32Array(4)},uClassic:{value:false},uOpacity:{value:.35}};
    for(var i=0;i<=COUNT;i++){var target=new T.WebGLRenderTarget(1,1,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true,stencilBuffer:false});target.texture.generateMipmaps=false;this.targets.push(target);uniforms['uLayer'+i]={value:target.texture};}
    this.material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:composite,uniforms:uniforms,transparent:true,depthWrite:false,depthTest:false,toneMapped:false});
    this.quad=new T.Mesh(new T.PlaneGeometry(2,2),this.material);this.quad.frustumCulled=false;this.quad.renderOrder=0;
    this.wire=new T.Mesh(this.mesh.geometry,new T.MeshBasicMaterial({color:0xdce5ed,wireframe:true,transparent:true,opacity:.3,depthWrite:false,depthTest:false}));this.wire.renderOrder=3;this.wire.frustumCulled=false;this.wire.visible=false;
    try{this.update(engine);var error=null,previous=renderer.debug.onShaderError;renderer.debug.onShaderError=function(gl,p,v,f){error=gl.getProgramInfoLog(p)||gl.getShaderInfoLog(f)||'ошибка шейдера';};try{renderer.compile(this.captureScene,this.captureCamera);var scene=new T.Scene();scene.add(this.quad);renderer.compile(scene,new T.Camera());scene.remove(this.quad);}finally{renderer.debug.onShaderError=previous;}if(error)throw new Error(error);this.quad.visible=false;}catch(e){this.dispose();throw e;}
  }
  Surface.prototype.update=function(engine){
    var keys=Object.create(null),mats=[],rows=[],position=[],normal=[],ids=[];
    engine.triangles.forEach(function(t){var key=t.part+':'+t.name,id=keys[key],a=t.armor;if(a&&(a.armor===null||(a.armor===0&&a.vehicleDamageFactor<=.00001)))return;
      if(id===undefined){id=mats.length/8;keys[key]=id;mats.push(a?(a.armor==null?-1:a.armor):-2,a?a.vehicleDamageFactor:0,a&&a.useHitAngle?1:0,a&&a.mayRicochet?1:0,a&&a.collideOnceOnly?1:0,a&&a.checkCaliberForRicochet?1:0,a&&a.checkCaliberForHitAngleNorm?1:0,0);}
      rows.push({t:t,id:id});
    });
    if(mats.length/8>this.renderer.capabilities.maxTextureSize)throw new Error('слишком много материалов');
    // Stable material ordering resolves coincident surfaces before depth peeling.
    rows.sort(function(a,b){return b.id-a.id;});rows.forEach(function(row){[row.t.a,row.t.b,row.t.c].forEach(function(p){position.push.apply(position,p);normal.push.apply(normal,row.t.normal);ids.push(row.id+1);});});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(position,3));geometry.setAttribute('normal',new T.Float32BufferAttribute(normal,3));geometry.setAttribute('materialId',new T.Float32BufferAttribute(ids,1));this.mesh.geometry.dispose();this.mesh.geometry=geometry;this.wire.geometry=geometry;
    if(this.materialTexture)this.materialTexture.dispose();this.materialTexture=new T.DataTexture(new Float32Array(mats.length?mats:8),2,Math.max(1,mats.length/8),T.RGBAFormat,T.FloatType);this.materialTexture.minFilter=this.materialTexture.magFilter=T.NearestFilter;this.materialTexture.generateMipmaps=false;this.materialTexture.needsUpdate=true;this.material.uniforms.uMaterials.value=this.materialTexture;
    geometry.computeBoundingSphere();this.radius=geometry.boundingSphere?geometry.boundingSphere.radius:10;this.key=null;
  };
  Surface.prototype.render=function(camera,anchor,shell,palette,opacity,quality,width,height){
    var renderer=this.renderer,limit=quality==='low'?512:quality==='high'?1280:quality==='medium'?900:768,scale=Math.min(1,limit/Math.max(width,height));
    width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));
    if(this.width!==width||this.height!==height){this.width=width;this.height=height;this.targets.forEach(function(t){t.setSize(width,height);});this.key=null;}
    var s=shell||{},u=this.material.uniforms;u.uPen.value.set(s.penetration||0,s.caliber||0,s.randomization||0,!s.randomizationType||s.randomizationType==='NORMAL'?1:0);u.uShell.value.set(s.normalization||0,s.ricochetCos==null?-1:s.ricochetCos,s.jetLossPerMeter||0,s.kind==='HIGH_EXPLOSIVE'?1:0);u.uFlags.value.set([s.mayRicochet?1:0,s.checkCaliber?1:0,s.shieldPenetration?1:0,s.penetration>0&&s.caliber>0?1:0]);u.uClassic.value=palette==='classic';u.uOpacity.value=opacity;
    var key=camera.matrixWorld.elements.join(',')+'|'+camera.projectionMatrix.elements.join(',');
    if(key!==this.key){
      this.captureCamera.copy(camera);var distance=camera.position.distanceTo(anchor),span=Math.max(5,this.radius*3);this.captureCamera.near=Math.max(.01,distance-span);this.captureCamera.far=distance+span;this.captureCamera.updateProjectionMatrix();
      var p=this.peelMaterial.uniforms;p.uOrigin.value.copy(camera.position);p.uAnchor.value.copy(anchor);p.uForward.value.copy(anchor).sub(camera.position).normalize();
      var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(new T.Color()),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(new T.Vector4()),scissor=renderer.getScissor(new T.Vector4()),scissorTest=renderer.getScissorTest();
      try{renderer.autoClear=false;renderer.setScissorTest(false);renderer.setClearColor(0,0);for(var i=0;i<=COUNT;i++){p.uFirst.value=i===0;p.uPrevious.value=this.targets[i===0?COUNT:i-1].texture;renderer.setRenderTarget(this.targets[i]);var gl=renderer.getContext();if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('float-буфер недоступен');renderer.clear(true,true,false);renderer.render(this.captureScene,this.captureCamera);}}finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
      this.key=key;
    }
    this.quad.visible=true;return width+' × '+height+' · до '+COUNT+' слоёв';
  };
  Surface.prototype.dispose=function(){if(this.quad){if(this.quad.parent)this.quad.parent.remove(this.quad);this.quad.geometry.dispose();this.material.dispose();}if(this.wire){if(this.wire.parent)this.wire.parent.remove(this.wire);this.wire.material.dispose();}if(this.mesh)this.mesh.geometry.dispose();if(this.peelMaterial)this.peelMaterial.dispose();if(this.materialTexture)this.materialTexture.dispose();this.targets.forEach(function(t){t.dispose();});};
  root.BullbaScreenArmor=Surface;
}(window));
