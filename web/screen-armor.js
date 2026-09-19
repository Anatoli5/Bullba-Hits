/* Rasterized depth layers + physical composition at window resolution.
   Every layer is one RGBA float snapshot of the model from the viewer's camera: R = depth along the view
   axis, G = material id (integer part) + cos(angle)/2 (fraction), BA = the octahedral flat normal.
   One depth buffer is shared by all layers. The direct result needs no ray query; only the leg after a
   ricochet is traced per pixel against a GPU BVH (three-mesh-bvh), because the mirrored ray leaves the
   pixel's own line of sight. Nothing is ever read back to the CPU (decision of 0.6.23). */
(function(root){
  'use strict';
  var COUNT=8,T=root.THREE;
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
out vec4 outputLayer;
// The flat normal rides along with the layer: the bounced leg needs the whole vector, not just |cos|.
vec2 octEncode(vec3 n){n/=abs(n.x)+abs(n.y)+abs(n.z);return n.z>=0.0?n.xy:(1.0-abs(n.yx))*vec2(n.x>=0.0?1.0:-1.0,n.y>=0.0?1.0:-1.0);}
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
 vec3 face=normalize(vNormal);
 outputLayer=vec4(d,vMaterial+abs(dot(ray,face))*.5,octEncode(face));
}`;
  // Both full-screen passes draw with an identity camera; three needs an object, not a matrix.
  var quadCamera=null;function quadView(){return quadCamera||(quadCamera=new T.Camera());}
  var quadVertex=`precision highp float; in vec3 position; out vec2 vUV;
void main(){vUV=position.xy*.5+.5;gl_Position=vec4(position.xy,0.0,1.0);}`;
  var declarations=Array.from({length:COUNT+1},function(_,i){return 'uniform highp sampler2D uLayer'+i+';';}).join('\n');
  var fetches=Array.from({length:COUNT+1},function(_,i){return 'if(index=='+i+')return texture(uLayer'+i+',uv);';}).join('\n');
  // The composite carries the bounced leg only when three-mesh-bvh is on the page and the units allow it.
  function compositeSource(bounce){
    var lib=root.MeshBVHLib;
    var traversal=bounce?lib.shaderStructs+lib.shaderIntersectFunction+'\nuniform BVH uBVH; uniform highp sampler2D uFaceMaterial;\n':'';
    var bounceLeg=bounce?`
// The leg after a ricochet: the same law walked along the mirrored ray with the reduced penetration.
// -4 = a second ricochet (the shell is lost), -2 = flies past, -1 = unknown, 0..1 = chance on main armour.
float bounceLeg(vec3 origin,vec3 direction,float nominal){
 Walk w;w.remaining=nominal;w.nominal=nominal;w.jetStart=0.0;w.jetRate=0.0;w.jet=false;w.screens=0;
 int ignored[${COUNT}];int ignoredCount=0;
 vec3 from=origin;float travelled=0.0,seen=-1.0;int last=-1;
 for(int i=0;i<${COUNT};i++){
  uvec4 faceIndices=uvec4(0u);vec3 faceNormal=vec3(0.0),barycoord=vec3(0.0);float side=0.0,reach=0.0;
  if(!bvhIntersectFirstHit(uBVH,from,direction,faceIndices,faceNormal,barycoord,side,reach))return -2.0;
  float march=max(reach,0.0),at=travelled+march;
  from+=direction*(march+2e-4);travelled=at+2e-4;
  int id=int(texelFetch1D(uFaceMaterial,faceIndices.x).r+.5)-1;
  if(id==last&&at-seen<5e-4)continue; // a coincident repeat of the same surface counts once, as on the CPU
  last=id;seen=at;
  bool skip=false;for(int j=0;j<${COUNT};j++){if(j>=ignoredCount)break;if(ignored[j]==id)skip=true;}if(skip)continue;
  float value=0.0;int status=contact(id,abs(dot(direction,faceNormal)),at,w,value);
  if(status>=3){if(ignoredCount<${COUNT}){ignored[ignoredCount]=id;ignoredCount++;}continue;}
  if(status==2)return -4.0;
  if(status==1)return value;
 }
 return -2.0;
}`:'';
    var bounceMain=bounce?`
 if(bounced&&uBounce!=0){
  vec3 n=dot(ray,face)>0.0?-face:face;
  vec3 mirrored=normalize(ray-2.0*dot(ray,n)*n);
  float after=bounceLeg(spot+n*.002+mirrored*.001,mirrored,uPen.x*(1.0-uRicochetLoss));
  // A bounced shell that still penetrates is painted in its own chance colour and the pixel is flagged for the
  // mark pass. The flag rides in alpha because this composite goes into a float target with blending off; a
  // single pass could never draw the zone's contour, which needs to know whether the neighbour is in the zone.
  if(after>=0.0){color=palette(after);zone=true;}
 }`:'';
    return `precision highp float; precision highp int; precision highp usampler2D; precision highp isampler2D;
${declarations}
uniform highp sampler2D uMaterials; uniform vec4 uPen; uniform vec4 uShell; uniform ivec4 uFlags;
uniform bool uClassic; uniform float uOpacity;
uniform vec3 uOrigin; uniform vec3 uAnchor; uniform vec3 uForward;
uniform mat4 uCameraWorld; uniform mat4 uInvProjection; uniform float uRicochetLoss; uniform int uBounce; uniform float uTint;
// Expected damage instead of the chance: (on 0/1, alpha, non-penetration base HP, spall penetration mm).
uniform vec4 uDamage; // ASCII only in here: this text is compiled as GLSL source
${traversal}
in vec2 vUV; out vec4 outputColor;
const float EPS=.00001;
vec4 layer(int index,vec2 uv){${fetches}return vec4(0.0);}
vec4 material(int id,int row){return texelFetch(uMaterials,ivec2(row,id),0);}
vec3 octDecode(vec2 e){vec3 v=vec3(e,1.0-abs(e.x)-abs(e.y));if(v.z<0.0)v.xy=(1.0-abs(v.yx))*vec2(v.x>=0.0?1.0:-1.0,v.y>=0.0?1.0:-1.0);return normalize(v);}
// The pixel's own camera ray, in the frame the layers were peeled in.
vec3 pixelRay(vec2 uv){vec4 eye=uInvProjection*vec4(uv*2.0-1.0,-1.0,1.0);return normalize(mat3(uCameraWorld)*(eye.xyz/eye.w));}
float erfApprox(float x){float s=x<0.0?-1.0:1.0;x=abs(x);float t=1.0/(1.0+.3275911*x);return s*(1.0-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*exp(-x*x));}
float probability(float remaining,float plate,float nominal){float margin=(remaining-plate)/max(EPS,nominal);if(uPen.z<=EPS)return margin>=0.0?1.0:0.0;if(uPen.w<.5)return -1.0;return clamp(.5*(1.0+erfApprox(margin/uPen.z/.33/sqrt(2.0))),0.0,1.0);}
vec3 palette(float p){vec3 lo=uClassic?vec3(.90,.20,.18):vec3(.63,.18,.55),mid=uClassic?vec3(.97,.79,.22):vec3(.95,.75,.31),hi=uClassic?vec3(.20,.79,.35):vec3(.20,.84,.76);return p<.5?mix(lo,mid,p*2.0):mix(mid,hi,p*2.0-1.0);}
// Blue tint of every ricochet history, uTint from the slider (0 none or unticked, 0.5 default, up to 1.5): red turns crimson,
// green turns teal. The ricochet colour itself is the tinted 0 % end of the palette.
vec3 blued(vec3 c){return clamp(mix(c,vec3(c.r*.8,c.g*.95,max(c.b,.55)),uTint),0.0,1.0);}
vec3 ricochetColor(){return blued(palette(0.0));}
// What a ballistic walk carries from one contact to the next. GLSL has no function pointers, so the two
// drivers below (layers, BVH) call one shared step function with this state.
struct Walk{float remaining;float nominal;float jetStart;float jetRate;bool jet;int screens;};
// One contact, same law as ArmorBallistics.evaluate: 0 = not counted, 1 = finished (result set),
// 2 = ricochet, 3 = passed through and the caller must remember this collide-once material.
// The list of materials already met stays a plain local array in each driver: an array inside an
// inout struct cannot be indexed by a loop variable on ANGLE/D3D11.
int contact(int id,float cosine,float along,inout Walk w,out float result){
 result=-2.0;
 vec4 a=material(id,0),flags=material(id,1);if(a.x<-1.5){result=-1.0;return 1;}if(a.x<0.0)return 0;
 if(a.z<=.5)cosine=1.0;
 bool bounce=uFlags.x!=0&&a.w>.5&&a.x>EPS&&cosine<=uShell.y;
 if(!w.jet&&bounce&&(flags.y<.5||uFlags.y==0||a.x*3.0>=uPen.y)){result=0.0;return 2;}
 if(w.jet)w.remaining=max(0.0,w.remaining-w.jetRate*max(0.0,along-w.jetStart));
 float n=uShell.x;if(flags.z>.5&&a.x>EPS&&uPen.y>a.x*2.0)n*=1.4*uPen.y/(a.x*2.0);
 float plate=a.x;if(a.z>.5)plate/=max(EPS,cos(max(0.0,acos(clamp(cosine,0.0,1.0))-n)));
 // Main armour. In damage mode the chance becomes the expected damage as a share of alpha, so the palette is
 // unchanged: E = p*alpha + (1-p)*base*min(1, spallPen/T), T the plate's nominal armour (ArmorBallistics.withDamage).
 if(a.y>EPS){result=probability(w.remaining,plate,w.nominal);
  if(uDamage.x>.5&&result>=0.0){float np=uDamage.z*min(1.0,uDamage.w/max(EPS,a.x));result=(result*uDamage.y+(1.0-result)*np)/max(EPS,uDamage.y);}
  return 1;}
 if(a.x>EPS)w.screens++;
 if(uShell.w>.5){if(uFlags.z==0){result=0.0;return 1;}w.remaining-=plate*3.0;}else w.remaining-=plate;
 w.jet=uShell.z>0.0;if(w.jet){w.jetStart=along+a.x*.001;if(w.jetRate==0.0)w.jetRate=w.remaining*uShell.z;}
 return flags.x>.5?3:0;
}
// The direct result: -3 = nothing on this pixel, -2 = no main armour, -1 = unknown, 0..1 = chance.
// On a ricochet it also reports the contact, so the bounced leg can start there.
float evaluate(vec2 uv,vec3 ray,out vec4 front,out bool screen,out int screens,out bool bounced,out vec3 spot,out vec3 face){
 vec4 first=layer(0,uv);front=vec4(-2.0);screen=false;screens=0;bounced=false;spot=uOrigin;face=uForward;
 if(first.y<.5)return -3.0;
 front=material(int(floor(first.y))-1,0);screen=front.y<=EPS;
 if(uFlags.w==0){return -1.0;}
 Walk w;w.remaining=uPen.x;w.nominal=uPen.x;w.jetStart=0.0;w.jetRate=0.0;w.jet=false;w.screens=0;
 int ignored[${COUNT}];int ignoredCount=0;
 float result=-2.0;bool finished=false;
 for(int i=0;i<${COUNT};i++){
  vec4 hit=layer(i,uv);if(hit.y<.5){finished=true;break;}
  int id=int(floor(hit.y))-1;bool skip=false;for(int j=0;j<${COUNT};j++){if(j>=ignoredCount)break;if(ignored[j]==id)skip=true;}if(skip)continue;
  float value=0.0;int status=contact(id,fract(hit.y)*2.0,hit.x,w,value);
  if(status>=3){if(ignoredCount<${COUNT}){ignored[ignoredCount]=id;ignoredCount++;}continue;}
  if(status==0)continue;
  result=value;finished=true;
  // The peel keeps the depth relative to the target plane: P = origin + ray * (d - offset).
  if(status==2){spot=uOrigin+ray*(hit.x-dot(uOrigin-uAnchor,uForward)/max(.001,dot(ray,uForward)));face=octDecode(hit.zw);bounced=true;}
  break;
 }
 screens=w.screens;
 if(!finished&&layer(${COUNT},uv).y>.5)result=-1.0; // Never silently truncate a ninth layer.
 return result;
}${bounceLeg}
void main(){
 vec4 front;bool screen;int screens;bool bounced;vec3 spot,face;bool zone=false;
 vec2 texel=1.0/vec2(textureSize(uLayer0,0));vec3 ray=pixelRay((floor(vUV/texel)+.5)*texel); // the peeled texel's own ray, so the contact point sits on the plate even when layers are smaller than the window
 float result=evaluate(vUV,ray,front,screen,screens,bounced,spot,face);
 // Every screen layer on the ray adds its own share of grey: two screens read darker than one.
 float share=1.0-pow(1.0-uOpacity,float(max(1,screens)));
 if(result<-2.5){outputColor=vec4(0.0);return;}
 // The front material's id (part and armour group) rides in alpha as 4*(id+1): the mark pass draws a seam where
 // neighbouring pixels carry different ids. Float target, no blending, so the integer survives intact.
 float idCode=4.0*floor(layer(0,vUV).y);
 // Screens overlay as neutral grey: a probability-looking tint on top of the armour result misled readers.
 vec3 tint=vec3(.45,.50,.55);
 // Screen with nothing behind it: nothing to penetrate, so a neutral translucent grey instead of a probability-looking tint.
 if(result<-1.5){outputColor=screen?vec4(.45,.50,.55,1.0-pow(1.0-uOpacity*.6,float(max(1,screens)))):vec4(.21,.27,.33,1.0);outputColor.a+=idCode;return;}
 vec3 color=result<0.0?vec3(.34,.42,.49):palette(result);
 // Any ricochet history - a plain ricochet, a second ricochet, a fly-past after the bounce - takes the ricochet colour.
 if(bounced)color=ricochetColor();${bounceMain}
 if(screen)color=mix(color,tint,share);
 outputColor=vec4(color,1.0);
 // The zone flag, encoded in alpha: >= 2 means "a bounced shell penetrates here". The mark pass takes it back
 // off, so translucency is untouched - only fully opaque pixels ever reach this line.
 if(zone)outputColor.a+=2.0;
 outputColor.a+=idCode;
}`;
  }
  /* Pass two. The composite lands in a float target; this shader reads it back texel for texel and draws over
     the zone where the bounced shell still penetrates: the blue tint of its chance colour (uTint, 0 = off), a
     staggered grid of one-pixel dots in the ricochet colour (uDots; uHatch = (pitch, pixel ratio) in
     drawing-buffer pixels), an optional one-pixel outline (uOutline), and the seams between parts (uEdges). */
  function markSource(){
    return `precision highp float; precision highp int;
uniform highp sampler2D uResult; uniform bool uClassic; uniform vec2 uHatch; uniform bool uDots; uniform bool uEdges; uniform bool uOutline; uniform float uTint;
out vec4 outputColor;
vec3 palette(float p){vec3 lo=uClassic?vec3(.90,.20,.18):vec3(.63,.18,.55),mid=uClassic?vec3(.97,.79,.22):vec3(.95,.75,.31),hi=uClassic?vec3(.20,.79,.35):vec3(.20,.84,.76);return p<.5?mix(lo,mid,p*2.0):mix(mid,hi,p*2.0-1.0);}
// Blue tint of every ricochet history, uTint from the slider (0 none or unticked, 0.5 default, up to 1.5): red turns crimson,
// green turns teal. The ricochet colour itself is the tinted 0 % end of the palette.
vec3 blued(vec3 c){return clamp(mix(c,vec3(c.r*.8,c.g*.95,max(c.b,.55)),uTint),0.0,1.0);}
vec3 ricochetColor(){return blued(palette(0.0));}
bool inZone(ivec2 p,ivec2 limit){float a=texelFetch(uResult,clamp(p,ivec2(0),limit),0).a;return a-4.0*floor(a/4.0)>=2.0;}
int idAt(ivec2 p,ivec2 limit){return int(floor(texelFetch(uResult,clamp(p,ivec2(0),limit),0).a/4.0))-1;}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy),limit=textureSize(uResult,0)-ivec2(1);
 vec4 src=texelFetch(uResult,p,0);
 int id=int(floor(src.a/4.0))-1;float rest=src.a-4.0*floor(src.a/4.0);bool zone=rest>=2.0;
 vec3 color=src.rgb;float alpha=zone?rest-2.0:rest;bool outlined=false;
 if(zone){
  vec3 ricochet=ricochetColor();
  // The outline: a zone pixel with a neighbour outside the zone. One drawing-buffer pixel wide, never scaled.
  if(uOutline&&(!inZone(p+ivec2(1,0),limit)||!inZone(p-ivec2(1,0),limit)||!inZone(p+ivec2(0,1),limit)||!inZone(p-ivec2(0,1),limit))){color=ricochet;outlined=true;}
  else{
   // Marks in whole device pixels at a whole-pixel pitch. A fractional pitch (5 CSS px at a 1.25 ratio = 6.25 px)
   // beats against the pixel grid: dots land between pixels every few columns and the field comes out banded,
   // which is what the user saw as clusters of lines. One pixel per mark at ratio 1, two at ratio 2.
   // The zone takes its chance colour with the blue tint; the dots add a staggered grid of ricochet-coloured
   // pixels on top, pitch and size in whole device pixels (a fractional pitch bands against the pixel grid).
   color=blued(color);
   if(uDots){int pitch=max(2,int(uHatch.x+.5)),size=max(1,int(uHatch.y+.5));int row=p.y/pitch,sx=(p.x+(row%2)*(pitch/2))%pitch,sy=p.y%pitch;if(sx<size&&sy<size)color=ricochet;}
  }
 }
 // A seam between two parts or armour groups, drawn on the side with the higher id so it stays one pixel wide.
 // The silhouette against the background (neighbour id -1) is left alone. The wireframe cannot show these seams:
 // collision parts overlap, so no triangle edge runs where one part's surface meets another's.
 if(uEdges&&id>=0&&!outlined){int n0=idAt(p+ivec2(1,0),limit),n1=idAt(p-ivec2(1,0),limit),n2=idAt(p+ivec2(0,1),limit),n3=idAt(p-ivec2(0,1),limit);
  if((n0>=0&&n0<id)||(n1>=0&&n1<id)||(n2>=0&&n2<id)||(n3>=0&&n3<id))color=mix(color,vec3(.05,.07,.09),.6);}
 outputColor=vec4(color,alpha);
}`;
  }
  function Surface(renderer,engine){
    if(!renderer.capabilities.isWebGL2)throw new Error('WebGL 2 required');
    var gl=renderer.getContext();if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('no float colour textures');
    if(renderer.capabilities.maxTextures<COUNT+2)throw new Error('not enough texture units');
    var ext=gl.getExtension('WEBGL_debug_renderer_info');if(ext&&/swiftshader|llvmpipe|software|basic render/i.test(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))throw new Error('software WebGL');
    this.renderer=renderer;this.targets=[];this.key=null;this.width=0;this.height=0;this.materialTexture=null;this.result=null;this.compositeScene=null;this.compositeQuad=null;this.checkPending=false;
    // Saved renderer state and the drawing-buffer size: one instance each, so a frame allocates nothing here.
    // The camera is compared element by element against these 32 doubles instead of two joined strings (~500
    // characters of garbage per frame, drawn or not). Float64: the matrices are doubles, and a float32 copy
    // would differ from every original and report a move on every frame.
    this.viewportSave=new T.Vector4();this.scissorSave=new T.Vector4();this.colorSave=new T.Color();this.bufferSize=new T.Vector2();this.cameraCache=new Float64Array(32);
    // The peel geometry as update() built it, so a turret drag can pose it in place (Viewer.previewPose).
    this.poseRuns=null;this.basePosition=null;this.baseNormal=null;
    // The bounced leg needs three-mesh-bvh and five more texture units (four for the BVH, one for the
    // material per vertex). Without them the map keeps working exactly as before, with a reason to show.
    var lib=root.MeshBVHLib;this.bvh=null;this.bvhStruct=null;this.faceMaterial=null;this.bounce=false;this.bounceReason='library not loaded';
    if(lib&&!(lib.MeshBVH&&lib.MeshBVHUniformStruct&&lib.FloatVertexAttributeTexture&&lib.shaderStructs&&lib.shaderIntersectFunction))this.bounceReason='library incomplete';
    else if(lib&&renderer.capabilities.maxTextures<COUNT+7)this.bounceReason='only '+renderer.capabilities.maxTextures+' texture units';
    else if(lib){this.bounce=true;this.bounceReason='';}
    this.captureScene=new T.Scene();this.captureCamera=new T.PerspectiveCamera();
    this.peelMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:vertex,fragmentShader:peel,side:T.DoubleSide,blending:T.NoBlending,toneMapped:false,uniforms:{uPrevious:{value:null},uFirst:{value:true},uPass:{value:0},uMaterials:{value:null},uOrigin:{value:new T.Vector3()},uAnchor:{value:new T.Vector3()},uForward:{value:new T.Vector3()}}});
    this.mesh=new T.Mesh(new T.BufferGeometry(),this.peelMaterial);this.mesh.frustumCulled=false;this.captureScene.add(this.mesh);
    // One depth attachment serves every layer: peeling needs it only within a pass.
    this.blank=new T.DataTexture(new Float32Array(4),1,1,T.RGBAFormat,T.FloatType);this.blank.needsUpdate=true;
    this.depth=new T.DepthTexture(1,1);this.depth.format=T.DepthFormat;this.depth.type=T.UnsignedIntType;
    for(var i=0;i<=COUNT;i++){var target=new T.WebGLRenderTarget(1,1,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true,stencilBuffer:false,depthTexture:this.depth});target.texture.generateMipmaps=false;this.targets.push(target);if(i<COUNT)this.peelMaterial.uniforms['uPeel'+i]={value:this.blank};}
    try{this.checkTargets();this.compose();this.update(engine);this.compile();}
    catch(e){
      // A driver that will not take the traversal must not cost the direct map: rebuild it without the leg.
      if(!this.bounce){this.dispose();throw e;}
      this.bounce=false;this.bounceReason=String(e.message||e).replace(/\s+/g,' ').slice(0,90);
      console.warn('Bounced leg disabled:',this.bounceReason);
      try{this.checkTargets();this.compose();this.update(engine);this.compile();}catch(again){this.dispose();throw again;}
    }
    this.quad.visible=false;
  }
  // Framebuffer completeness is asked once per allocation - creation, a size change, a context restore - and
  // never per pass: the query can synchronise CPU and GPU, and the peel loop used to run nine of them on every
  // frame the camera moved. Checking needs the target bound, so the renderer is left exactly as it was found.
  Surface.prototype.checkTargets=function(){
    var renderer=this.renderer,gl=renderer.getContext(),bad=null;
    var target=renderer.getRenderTarget(),viewport=renderer.getViewport(this.viewportSave),scissor=renderer.getScissor(this.scissorSave),scissorTest=renderer.getScissorTest();
    try{for(var i=0;i<this.targets.length;i++){renderer.setRenderTarget(this.targets[i]);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){bad=this.targets[i];break;}}}
    finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);}
    this.checkPending=false;
    if(bad)throw new Error('float-buffer '+bad.width+'×'+bad.height+' unavailable');
  };
  // A context restore is not repaired in place any more: the constructor asked the driver once for float colour
  // buffers, texture units and a traversal it would accept, and a restored context may answer differently. The
  // viewer disposes the instance and builds a fresh one (Viewer.restoreContext).
  // Both full-screen quads and their programs. Built once, or twice if the bounced leg is dropped.
  Surface.prototype.compose=function(){
    if(this.quad){if(this.quad.parent)this.quad.parent.remove(this.quad);this.quad.geometry.dispose();this.markMaterial.dispose();}
    if(this.compositeQuad){this.compositeScene.remove(this.compositeQuad);this.compositeQuad.geometry.dispose();this.material.dispose();}
    var uniforms={uMaterials:{value:this.materialTexture},uPen:{value:new T.Vector4()},uShell:{value:new T.Vector4()},uFlags:{value:new Int32Array(4)},uClassic:{value:false},uOpacity:{value:.35},
      uOrigin:{value:new T.Vector3()},uAnchor:{value:new T.Vector3()},uForward:{value:new T.Vector3()},
      uCameraWorld:{value:new T.Matrix4()},uInvProjection:{value:new T.Matrix4()},uRicochetLoss:{value:0},uBounce:{value:1},uTint:{value:.5},uDamage:{value:new T.Vector4()}};
    for(var i=0;i<=COUNT;i++)uniforms['uLayer'+i]={value:this.targets[i].texture};
    if(this.bounce){var lib=root.MeshBVHLib;if(!this.bvhStruct){this.bvhStruct=new lib.MeshBVHUniformStruct();this.faceMaterial=new lib.FloatVertexAttributeTexture();}
      uniforms.uBVH={value:this.bvhStruct};uniforms.uFaceMaterial={value:this.faceMaterial};}
    // Pass one draws into this.result with blending off, so it is neither transparent nor depth-tested.
    this.material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:compositeSource(this.bounce),uniforms:uniforms,blending:T.NoBlending,depthWrite:false,depthTest:false,toneMapped:false});
    if(!this.compositeScene)this.compositeScene=new T.Scene();
    this.compositeQuad=new T.Mesh(new T.PlaneGeometry(2,2),this.material);this.compositeQuad.frustumCulled=false;this.compositeScene.add(this.compositeQuad);
    // Pass two is the quad the viewer keeps in its scene: the blending, depth state and order of the old composite.
    this.markMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:markSource(),uniforms:{uResult:{value:null},uClassic:{value:false},uHatch:{value:new T.Vector2(5,1)},uDots:{value:false},uEdges:{value:true},uOutline:{value:false},uTint:{value:.5}},transparent:true,depthWrite:false,depthTest:false,toneMapped:false});
    this.quad=new T.Mesh(new T.PlaneGeometry(2,2),this.markMaterial);this.quad.frustumCulled=false;this.quad.renderOrder=0;
  };
  // Pass one on its own: the whole composition into a float target the size of the drawing buffer, so the mark
  // pass can look at a pixel's neighbours. Same state discipline as the peel loop - the renderer is left as found.
  Surface.prototype.composite=function(){
    var renderer=this.renderer,buffer=renderer.getDrawingBufferSize(this.bufferSize);
    var w=Math.max(1,buffer.x),h=Math.max(1,buffer.y);
    var fresh=false;
    if(!this.result){this.result=new T.WebGLRenderTarget(w,h,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false,stencilBuffer:false});this.result.texture.generateMipmaps=false;fresh=true;}
    else if(this.result.width!==w||this.result.height!==h){this.result.setSize(w,h);fresh=true;}
    var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(this.colorSave),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(this.viewportSave),scissor=renderer.getScissor(this.scissorSave),scissorTest=renderer.getScissorTest();
    try{renderer.autoClear=false;renderer.setScissorTest(false);renderer.setClearColor(0,0);renderer.setRenderTarget(this.result);
      // Checked when the target is made or resized, not on every draw: the query costs about 0.2 ms of CPU.
      var gl=renderer.getContext();if(fresh&&gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('composition buffer '+w+'×'+h+' unavailable');
      renderer.clear(true,false,false);renderer.render(this.compositeScene,quadView());}
    finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
    this.markMaterial.uniforms.uResult.value=this.result.texture;
  };
  Surface.prototype.compile=function(){
    var renderer=this.renderer,error=null,previous=renderer.debug.onShaderError,target=renderer.getRenderTarget();
    renderer.debug.onShaderError=function(gl,p,v,f){error=gl.getProgramInfoLog(p)||gl.getShaderInfoLog(f)||'shader error';};
    // three checks the link only when a program is first used, so the quad is drawn once into a
    // throw-away 1x1 target: otherwise a broken composition would surface later, outside the fallback.
    var probe=new T.WebGLRenderTarget(1,1),scene=new T.Scene(),parent=this.quad.parent,visible=this.quad.visible;
    this.quad.visible=true;scene.add(this.quad);
    var bound=this.markMaterial.uniforms.uResult.value;if(!bound)this.markMaterial.uniforms.uResult.value=this.blank;
    try{renderer.compile(this.captureScene,this.captureCamera);renderer.compile(this.compositeScene,quadView());renderer.compile(scene,quadView());
      renderer.setRenderTarget(probe);renderer.render(this.compositeScene,quadView());renderer.render(scene,quadView());}
    finally{renderer.setRenderTarget(target);renderer.debug.onShaderError=previous;scene.remove(this.quad);if(parent)parent.add(this.quad);this.quad.visible=visible;if(!bound)this.markMaterial.uniforms.uResult.value=null;probe.dispose();}
    if(error)throw new Error(error);
  };
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
    // Vertex runs by collision part, with the vertices as they are now: pose() re-transforms them in place while
    // a turret drag lasts, so the layers follow the turret without this whole method running again.
    var runs=[],last=null;
    rows.forEach(function(row,i){var part=row.t.part;if(last&&last.part===part)last.end=(i+1)*9;else{last={part:part,start:i*9,end:(i+1)*9};runs.push(last);}});
    this.poseRuns=runs;this.basePosition=new Float32Array(position);this.baseNormal=new Float32Array(normal);
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(position,3));geometry.setAttribute('normal',new T.Float32BufferAttribute(normal,3));geometry.setAttribute('materialId',new T.Float32BufferAttribute(ids,1));this.mesh.geometry.dispose();this.mesh.geometry=geometry;
    if(this.materialTexture)this.materialTexture.dispose();this.materialTexture=new T.DataTexture(new Float32Array(mats.length?mats:8),2,Math.max(1,mats.length/8),T.RGBAFormat,T.FloatType);this.materialTexture.minFilter=this.materialTexture.magFilter=T.NearestFilter;this.materialTexture.generateMipmaps=false;this.materialTexture.needsUpdate=true;this.material.uniforms.uMaterials.value=this.materialTexture;this.peelMaterial.uniforms.uMaterials.value=this.materialTexture;
    geometry.computeBoundingSphere();geometry.computeBoundingBox();this.radius=geometry.boundingSphere?geometry.boundingSphere.radius:10;this.key=null;
    if(this.bounce){try{this.updateBounds(geometry);}catch(e){this.bounce=false;this.bounceReason='bvh: '+(e.message||e);console.warn('Bounced leg disabled:',this.bounceReason);}}
  };
  // A display-only pose: the peeled geometry is re-transformed from the base update() kept, by one rigid matrix
  // per moved part, and the layers are declared stale so the next render() peels the new pose. The material
  // table, the ids and the row order are untouched, and the BVH is deliberately left where it was - the bounced
  // leg is off while the layers are stale, and rebuilding it is the very cost this avoids. update() puts the
  // BVH and everything else back in step at the end of the drag.
  Surface.prototype.pose=function(delta){
    if(!this.poseRuns||!this.mesh||!this.mesh.geometry)return false;
    var geometry=this.mesh.geometry,position=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
    if(!position||!normals||!this.basePosition||position.array.length!==this.basePosition.length)return false;
    var out=position.array,outNormal=normals.array,base=this.basePosition,baseNormal=this.baseNormal,touched=false;
    this.poseRuns.forEach(function(run){
      var matrix=delta[run.part];if(!matrix)return;var e=matrix.elements,i;
      for(i=run.start;i<run.end;i+=3){
        var x=base[i],y=base[i+1],z=base[i+2];
        out[i]=e[0]*x+e[4]*y+e[8]*z+e[12];out[i+1]=e[1]*x+e[5]*y+e[9]*z+e[13];out[i+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
        var nx=baseNormal[i],ny=baseNormal[i+1],nz=baseNormal[i+2];
        outNormal[i]=e[0]*nx+e[4]*ny+e[8]*nz;outNormal[i+1]=e[1]*nx+e[5]*ny+e[9]*nz;outNormal[i+2]=e[2]*nx+e[6]*ny+e[10]*nz;
      }
      touched=true;
    });
    if(!touched)return false;
    position.needsUpdate=true;normals.needsUpdate=true;this.key=null;
    return true;
  };
  // A GPU BVH over the same peel geometry. It gets its own index so the peel keeps its draw order;
  // the position attribute is shared, so nothing is duplicated on the CPU.
  Surface.prototype.updateBounds=function(geometry){
    var lib=root.MeshBVHLib,frame=new T.BufferGeometry();
    frame.setAttribute('position',geometry.getAttribute('position'));
    this.bvh=new lib.MeshBVH(frame);
    this.bvhStruct.updateFrom(this.bvh);
    this.faceMaterial.updateFrom(geometry.getAttribute('materialId'));
  };
  // Layer resolution: the window itself unless the quality setting or a memory budget says otherwise.
  Surface.prototype.size=function(quality,width,height,pixelRatio){
    var pr=Math.max(1,pixelRatio||1),w=Math.max(1,Math.round(width*pr)),h=Math.max(1,Math.round(height*pr)),longest=Math.max(w,h);
    var limit=quality==='low'?Math.max(512,Math.round(longest/2)):quality==='medium'?1200:quality==='high'?Infinity:1600;
    var caps=this.renderer.capabilities,scale=Math.min(1,limit/longest,caps.maxTextureSize/longest);
    var budget=320*1024*1024,bytes=function(s){return w*s*h*s*((COUNT+1)*16+4);};
    while(bytes(scale)>budget&&scale>.2)scale*=.9;
    return {width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale)),scale:scale,bytes:bytes(scale)};
  };
  // bounceMode: 'always' traces the bounced leg on every draw; 'idle' (default) only once the camera has stood
  // still for SETTLE ms - the caller redraws when bouncePending says the layer is still due. A lighter mode for
  // weaker GPUs: the direct map stays live, the hatched layer catches up after the rotation.
  var SETTLE=150;
  // Monotonic: Date.now() can step backwards when the system clock is corrected after a resume, and the settle
  // comparison below would then never be satisfied again - a full-screen composition every 160 ms while idle.
  function clock(){return root.performance&&root.performance.now?root.performance.now():Date.now();}
  // Has the camera moved since the layers were peeled? Compared element by element; the cache is refreshed
  // whenever it has, so the next frame compares against what is on screen.
  Surface.prototype.cameraMoved=function(camera){
    var cache=this.cameraCache,world=camera.matrixWorld.elements,projection=camera.projectionMatrix.elements,moved=false,i;
    for(i=0;i<16;i++)if(cache[i]!==world[i]||cache[i+16]!==projection[i]){moved=true;break;}
    if(moved)for(i=0;i<16;i++){cache[i]=world[i];cache[i+16]=projection[i];}
    return moved;
  };
  Surface.prototype.render=function(camera,anchor,shell,palette,opacity,quality,width,height,pixelRatio,bounceMode,mode){
    var renderer=this.renderer,size=this.size(quality,width,height,pixelRatio);
    if(this.width!==size.width||this.height!==size.height){this.width=size.width;this.height=size.height;this.targets.forEach(function(t){t.setSize(size.width,size.height);});this.key=null;this.checkPending=true;}
    if(this.checkPending)this.checkTargets();
    var s=shell||{},u=this.material.uniforms;u.uPen.value.set(s.penetration||0,s.caliber||0,s.randomization||0,!s.randomizationType||s.randomizationType==='NORMAL'?1:0);u.uShell.value.set(s.normalization||0,s.ricochetCos==null?-1:s.ricochetCos,s.jetLossPerMeter||0,s.kind==='HIGH_EXPLOSIVE'?1:0);var flags=u.uFlags.value;flags[0]=s.mayRicochet?1:0;flags[1]=s.checkCaliber?1:0;flags[2]=s.shieldPenetration?1:0;flags[3]=s.penetration>0&&s.caliber>0?1:0;u.uClassic.value=palette==='classic';u.uOpacity.value=opacity;
    u.uRicochetLoss.value=s.ricochetLoss||0;
    // Damage mode, and only with an alpha in the record: the non-penetration base is the spall damage of modern
    // HE (nonPiercingArmorDamage for AP/APCR/HEAT, 0 for legacy HE), the spall penetration 0.05·α / liner. Off
    // it, or without an alpha, uDamage.x is 0 and the map is the plain penetration chance.
    var modern=s.kind==='HIGH_EXPLOSIVE'&&s.mechanics==='MODERN'&&s.spallDamage>0;
    var base=s.kind==='HIGH_EXPLOSIVE'?(modern?s.spallDamage:0):(s.nonPiercingArmorDamage>0?s.nonPiercingArmorDamage:0);
    u.uDamage.value.set(mode==='damage'&&s.alpha>0?1:0,s.alpha||0,base,modern?.05*s.alpha/(s.liner>0?s.liner:1):1e9);
    var pr=Math.max(1,pixelRatio||1),m=this.markMaterial.uniforms;m.uHatch.value.set(Math.max(2,this.hatch||5)*pr,pr); // dot pitch in CSS px, one CSS px per dot
    m.uDots.value=!!this.dots;m.uEdges.value=this.edges!==false;m.uOutline.value=!!this.outline;var tint=this.tint===undefined?.5:this.tint;m.uTint.value=tint;u.uTint.value=tint;m.uClassic.value=u.uClassic.value;
    // Stale: the camera has moved, or the layers were dropped (a new pose, a new size, a new model).
    var stale=this.cameraMoved(camera)||this.key===null,now=clock();
    if(stale)this.movedAt=now;
    var settled=bounceMode==='always'||!(Math.max(0,now-(this.movedAt||0))<SETTLE);
    u.uBounce.value=this.bounce&&settled?1:0;this.bouncePending=this.bounce&&!settled;
    if(stale){
      this.captureCamera.copy(camera);var distance=camera.position.distanceTo(anchor),span=Math.max(5,this.radius*3);this.captureCamera.near=Math.max(.01,distance-span);this.captureCamera.far=distance+span;this.captureCamera.updateProjectionMatrix();
      var p=this.peelMaterial.uniforms;p.uOrigin.value.copy(camera.position);p.uAnchor.value.copy(anchor);p.uForward.value.copy(anchor).sub(camera.position).normalize();
      // The composite rebuilds the contact point in exactly the frame the layers were peeled in.
      u.uOrigin.value.copy(p.uOrigin.value);u.uAnchor.value.copy(p.uAnchor.value);u.uForward.value.copy(p.uForward.value);
      u.uCameraWorld.value.copy(camera.matrixWorld);u.uInvProjection.value.copy(camera.projectionMatrix).invert();
      var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(this.colorSave),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(this.viewportSave),scissor=renderer.getScissor(this.scissorSave),scissorTest=renderer.getScissorTest();
      try{renderer.autoClear=false;renderer.setScissorTest(false);renderer.setClearColor(0,0);for(var i=0;i<=COUNT;i++){p.uFirst.value=i===0;p.uPass.value=i;p.uPrevious.value=this.targets[i===0?COUNT:i-1].texture;for(var j=0;j<COUNT;j++)p['uPeel'+j].value=j<i?this.targets[j].texture:this.blank;renderer.setRenderTarget(this.targets[i]);renderer.clear(true,true,false);renderer.render(this.captureScene,this.captureCamera);}}finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
      this.key=1;
    }
    this.composite();
    this.quad.visible=true;return size.width+' × '+size.height+(size.scale<.999?' ('+Math.round(size.scale*100)+'% of the window)':'')+' · up to '+COUNT+' layers'+(this.bounce?(bounceMode==='always'?' · bounce traced':' · bounce traced after the camera stops'):' · bounce off: '+this.bounceReason);
  };
  /* TEST ONLY. Renders the composition into a temporary float target and returns the listed pixels as
     [r,g,b,a]. Product code never calls it: 0.6.23 removed every synchronous GPU→CPU read from the viewer.
     Pixels are [x,y] in drawing-buffer pixels with y counted from the top. */
  Surface.prototype.debugReadback=function(pixels){
    var renderer=this.renderer,size=renderer.getDrawingBufferSize(new T.Vector2());
    var target=new T.WebGLRenderTarget(size.x,size.y,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false,stencilBuffer:false});
    var scene=new T.Scene(),parent=this.quad.parent,visible=this.quad.visible,previous=renderer.getRenderTarget();
    this.quad.visible=true;scene.add(this.quad);
    try{
      this.composite(); // both passes, so the samples carry the outline and the pattern
      renderer.setRenderTarget(target);renderer.render(scene,quadView());
      var data=new Float32Array(size.x*size.y*4);renderer.readRenderTargetPixels(target,0,0,size.x,size.y,data);
      return pixels.map(function(p){var x=Math.min(size.x-1,Math.max(0,Math.round(p[0]))),y=Math.min(size.y-1,Math.max(0,size.y-1-Math.round(p[1]))),i=(y*size.x+x)*4;
        return [data[i],data[i+1],data[i+2],data[i+3]];});
    }finally{renderer.setRenderTarget(previous);scene.remove(this.quad);if(parent)parent.add(this.quad);this.quad.visible=visible;target.dispose();}
  };
  Surface.prototype.dispose=function(){if(this.quad){if(this.quad.parent)this.quad.parent.remove(this.quad);this.quad.geometry.dispose();}if(this.markMaterial)this.markMaterial.dispose();if(this.compositeQuad)this.compositeQuad.geometry.dispose();if(this.material)this.material.dispose();if(this.result)this.result.dispose();if(this.mesh)this.mesh.geometry.dispose();if(this.peelMaterial)this.peelMaterial.dispose();if(this.materialTexture)this.materialTexture.dispose();if(this.bvhStruct)this.bvhStruct.dispose();if(this.faceMaterial)this.faceMaterial.dispose();this.bvh=null;this.targets.forEach(function(t){t.dispose();});if(this.depth)this.depth.dispose();if(this.blank)this.blank.dispose();};
  root.BullbaScreenArmor=Surface;
}(window));
