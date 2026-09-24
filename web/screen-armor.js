/* Rasterized depth layers + physical composition at window resolution.
   Every layer is one RGBA float snapshot of the model from the viewer's camera: R = depth along the view
   axis, G = material id (integer part) + cos(angle)/2 (fraction), BA = the octahedral flat normal.
   One depth buffer is shared by all layers. The direct result needs no ray query; only the leg after a
   ricochet is traced per pixel against a GPU BVH (three-mesh-bvh), because the mirrored ray leaves the
   pixel's own line of sight. Nothing is ever read back to the CPU (decision of 0.6.23). */
(function(root){
  'use strict';
  var COUNT=8,T=root.THREE;
  /* Soft lighting (optional, off by default). It is a display feature and nothing else: a second, smoothed
     VISUAL normal per vertex record, used by one extra pass and by no part of the ballistics. The physical
     normal below stays exactly what it is - one flat vector per triangle, the plane of the face - because the
     angle of incidence, the normalization, the overmatch, the ricochet, the bounced leg and the BVH all read
     it. Averaging that one would change the law; averaging a separate one only changes the picture.
     SMOOTH_ANGLE is the crease angle: two neighbouring faces of one material share a corner normal only when
     their planes are closer than this. 35 deg is the starting figure of the design note - a visual setting to
     tune, not a rule of the game. It also rejects the two sides of a thin sheet by itself (their planes are
     ~180 deg apart). LIGHT_MIN..LIGHT_MAX is the brightness multiplier the composite applies: deliberately
     narrow, so a shaded non-penetration can never read as a penetration.
     WELD is the coordinate tolerance, in metres, at which two records of one corner count as the same corner.
     VISUAL_MAX caps the builder: past it the visual normal stays the physical one and the model simply looks
     the way it does today, instead of the page stalling on a model nobody has yet seen. */
  var SMOOTH_ANGLE=35,SMOOTH_COS=Math.cos(SMOOTH_ANGLE*Math.PI/180),LIGHT_MIN=.8,LIGHT_MAX=1,WELD=1e-4,VISUAL_MAX=1500000;
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
  /* The lighting pass, drawn only while Soft lighting is on. One draw of the main armour with the smoothed
     visual normal into a one-channel map of the brightness the composite multiplies the armour colour by.
     It takes no layer, no BVH and no material law - only the nearest visible main-armour surface and one
     light - and it writes nothing the ballistics ever reads back. */
  var lightVertex=`precision highp float;
in vec3 position; in vec3 normal; in vec3 visualNormal; in float materialId;
uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
out vec3 vPosition; out vec3 vVisual; flat out vec3 vFace; flat out float vMaterial;
// The peel geometry is already in world coordinates and the mesh carries no transform of its own, so there is
// no normal matrix to build here: pose() has already turned both normals with the part, and they reach this
// stage in the very frame the CPU computes the light direction in. vVisual is interpolated (that is the whole
// point); vFace stays flat, exactly as it is in the peel.
void main(){vPosition=position;vVisual=visualNormal;vFace=normal;vMaterial=materialId;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
  var lightFragment=`precision highp float; precision highp int;
uniform highp sampler2D uMaterials; uniform vec3 uOrigin; uniform vec3 uLight;
in vec3 vPosition; in vec3 vVisual; flat in vec3 vFace; flat in float vMaterial;
out vec4 outputLight;
void main(){
 vec4 a=texelFetch(uMaterials,ivec2(0,int(floor(vMaterial))-1),0);
 // Main armour only, by the material semantics the composite already uses (vehicleDamageFactor > 0), never by
 // part names: screens, tracks and devices keep the colour and the translucency they have today. A 0 mm device
 // (armour recorded as null, -1 in the table) is walked straight through by contact() and must not paint a
 // patch of light in front of the plate behind it; an unknown thickness (-2) is armour and stays. The discard
 // also drops the depth write, so a screen in front never shades the armour under it - the light on that
 // pixel belongs to the armour, which is what the composite colours there.
 if(a.y<=.00001||(a.x<0.0&&a.x>-1.5))discard;
 // Which way the plate faces is decided by the PHYSICAL normal against the view ray - the peel's own test -
 // because the winding of a collision model is not dependable; the smoothed normal is turned with it.
 vec3 ray=normalize(vPosition-uOrigin);
 // length() before the divide: the builder leaves a degenerate face the physical normal, which ballistics.js
 // reports as (0,0,0), and normalize() of that is a NaN this map must never store. Such a face has no area
 // and rasterizes nothing, but the fallback - a surface turned straight at the camera - keeps the shader total.
 float span=length(vVisual);
 vec3 n=span>1e-6?vVisual/span*(dot(vFace,ray)>0.0?-1.0:1.0):-ray;
 // A wrapped (half-Lambert) term rather than max(0, N.L): the light sits beside the camera, so a hard
 // terminator would only show up as a flat band along the silhouette, while the wrapped one grades the whole
 // visible surface. What is stored is the 0..1 shade; the composite maps it into LIGHT_MIN..LIGHT_MAX, so all
 // 256 levels of the byte fall inside that narrow range and the gradient does not band.
 outputLight=vec4(clamp(.5+.5*dot(n,uLight),0.0,1.0),0.0,0.0,1.0);
}`;
  // Both full-screen passes draw with an identity camera; three needs an object, not a matrix.
  var quadCamera=null;function quadView(){return quadCamera||(quadCamera=new T.Camera());}
  var quadVertex=`precision highp float; in vec3 position; out vec2 vUV;
void main(){vUV=position.xy*.5+.5;gl_Position=vec4(position.xy,0.0,1.0);}`;
  var declarations=Array.from({length:COUNT+1},function(_,i){return 'uniform highp sampler2D uLayer'+i+';';}).join('\n');
  var fetches=Array.from({length:COUNT+1},function(_,i){return 'if(index=='+i+')return texture(uLayer'+i+',uv);';}).join('\n');
  // The composite carries the bounced leg only when three-mesh-bvh is on the page and the units allow it, and
  // the light lookup only while Soft lighting is on - with the switch off the program is the one it was before
  // the feature existed, down to the texture unit it does not ask for.
  function compositeSource(bounce,lit){
    var lightUniforms=lit?'uniform highp sampler2D uLightMap; uniform vec2 uLightRange;\n':'';
    // The armour colour only, and before the screen grey and before the mark pass: the screens keep their own
    // tint and translucency, the seams, the dots and the zone outline are drawn over it in their own colours,
    // and the background, the wireframe and the page's own overlays are never touched. The map is cleared to
    // 1.0 - the top of the range, a neutral multiplier - so wherever the light pass drew nothing (outside the
    // silhouette, a screen with no armour behind it) the colour comes through unchanged. The pixel's own
    // alpha, which carries the front material id and the zone flag, is not touched either.
    var lightApply=lit?`
 color*=uLightRange.x+(uLightRange.y-uLightRange.x)*texture(uLightMap,vUV).r;`:'';
    var lib=root.MeshBVHLib;
    var traversal=bounce?lib.shaderStructs+lib.shaderIntersectFunction+'\nuniform BVH uBVH; uniform highp sampler2D uFaceMaterial;\n':'';
    var bounceLeg=bounce?`
// The leg after a ricochet: the same law walked along the mirrored ray with the reduced penetration.
// -4 = a second ricochet (the shell is lost), -2 = flies past, -1 = unknown, 0..1 = chance on main armour.
float bounceLeg(vec3 origin,vec3 direction,float nominal){
 Walk w;w.remaining=nominal;w.nominal=nominal;w.jetStart=0.0;w.jetRate=0.0;w.jet=false;w.screens=0;w.gate=1.0;
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
${lightUniforms}${traversal}
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
struct Walk{float remaining;float nominal;float jetStart;float jetRate;bool jet;int screens;float gate;};
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
 // unchanged: E = p*alpha + max(0, gate-p)*base*min(1, spallPen/T), T the plate's nominal armour, gate the chance to
 // pass every screen on the way (one roll for the shot; a shell stopped by a screen deals nothing) - ArmorBallistics.withDamage.
 if(a.y>EPS){result=probability(w.remaining,plate,w.nominal);
  if(uDamage.x>.5&&result>=0.0){float np=uDamage.z*min(1.0,uDamage.w/max(EPS,a.x));result=(result*uDamage.y+max(0.0,w.gate-result)*np)/max(EPS,uDamage.y);}
  return 1;}
 if(a.x>EPS)w.screens++;
 if(uShell.w>.5){if(uFlags.z==0){result=0.0;return 1;}float through=probability(w.remaining,plate,w.nominal);if(through>=0.0)w.gate=min(w.gate,through);w.remaining-=plate*3.0;}else w.remaining-=plate;
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
 Walk w;w.remaining=uPen.x;w.nominal=uPen.x;w.jetStart=0.0;w.jetRate=0.0;w.jet=false;w.screens=0;w.gate=1.0;
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
 if(bounced)color=ricochetColor();${bounceMain}${lightApply}
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
// The composed picture as a 2D image while only the zoom changes (Surface.render, ZOOM_SETTLE): the drawing-buffer pixel of
// the screen maps onto the pixel of the result as src = dst * uView.xy + uView.zw. (1, 1, 0, 0) - the layers' own view - is
// every other frame, and then p is exactly the screen pixel, as it always was.
uniform vec4 uView;
out vec4 outputColor;
vec3 palette(float p){vec3 lo=uClassic?vec3(.90,.20,.18):vec3(.63,.18,.55),mid=uClassic?vec3(.97,.79,.22):vec3(.95,.75,.31),hi=uClassic?vec3(.20,.79,.35):vec3(.20,.84,.76);return p<.5?mix(lo,mid,p*2.0):mix(mid,hi,p*2.0-1.0);}
// Blue tint of every ricochet history, uTint from the slider (0 none or unticked, 0.5 default, up to 1.5): red turns crimson,
// green turns teal. The ricochet colour itself is the tinted 0 % end of the palette.
vec3 blued(vec3 c){return clamp(mix(c,vec3(c.r*.8,c.g*.95,max(c.b,.55)),uTint),0.0,1.0);}
vec3 ricochetColor(){return blued(palette(0.0));}
bool inZone(ivec2 p,ivec2 limit){float a=texelFetch(uResult,clamp(p,ivec2(0),limit),0).a;return a-4.0*floor(a/4.0)>=2.0;}
int idAt(ivec2 p,ivec2 limit){return int(floor(texelFetch(uResult,clamp(p,ivec2(0),limit),0).a/4.0))-1;}
void main(){
 ivec2 q=ivec2(gl_FragCoord.xy),limit=textureSize(uResult,0)-ivec2(1);
 ivec2 p=ivec2(floor(gl_FragCoord.xy*uView.xy+uView.zw));
 // Zoomed out past the composed picture: nothing was composed there, so nothing is drawn (the model is inside it).
 if(p.x<0||p.y<0||p.x>limit.x||p.y>limit.y)discard;
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
   // The grid is laid on the SCREEN's pixels (q), so a zoom drawn in 2D keeps one-pixel dots at their pitch.
   if(uDots){int pitch=max(2,int(uHatch.x+.5)),size=max(1,int(uHatch.y+.5));int row=q.y/pitch,sx=(q.x+(row%2)*(pitch/2))%pitch,sy=q.y%pitch;if(sx<size&&sy<size)color=ricochet;}
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
    // What the composition in this.result was made from, beyond the layers themselves: every uniform render()
    // writes, and the drawing-buffer size (renderSignature). A frame that changes none of it - the camera still,
    // the live ring settling - keeps the result and runs only the mark pass. The program and the light map it was
    // made with are held beside it, so a recompiled composite or a new light target is never read as the same.
    this.signature=new Float64Array(26);this.signatureNext=new Float64Array(26);this.signature[0]=NaN;this.composedMaterial=null;this.composedLight=null;
    // The zoom drawn in 2D (render, ZOOM_SETTLE): the projection of the last frame and when it last changed, and whether a
    // sharp composition is still due. bvhStale: the peel geometry has been posed (pose()) since the GPU BVH was built.
    this.projectionSeen=new Float64Array(16);this.projectionAt=-Infinity;this.zoomPending=false;this.bvhStale=false;
    // The peel geometry as update() built it, so a turret drag can pose it in place (Viewer.previewPose).
    this.poseRuns=null;this.basePosition=null;this.baseNormal=null;
    // Soft lighting. `lighting` is what was asked for, `lit` what actually runs (they differ only when the
    // driver declines, and lightingReason then says why); baseVisual is the smoothed normal in the same part
    // space as baseNormal, built lazily and only while the light is on. Everything here is null or false
    // until setLighting() turns it on, so the default costs no memory, no pass and no shader branch.
    this.lighting=false;this.lit=false;this.lightFailed=false;this.lightingReason='';this.baseVisual=null;
    this.lightTarget=null;this.lightMaterial=null;this.lightMesh=null;this.lightScene=null;
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
    // A 1x1 white texture the lit composite falls back to: its red channel is 1.0, the top of the range, so
    // binding it multiplies the armour colour by exactly 1 and the picture is the unlit one. That is what the
    // lit program reads before the first pass has run and after a light pass the driver refused.
    this.neutral=new T.DataTexture(new Uint8Array([255,255,255,255]),1,1,T.RGBAFormat,T.UnsignedByteType);this.neutral.needsUpdate=true;
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
  // Both full-screen quads and their programs. Built once, or again if the bounced leg is dropped or the
  // Soft lighting switch is moved - the composite is compiled with or without the light lookup, so the quad
  // is replaced while it already hangs in the viewer's scene. Its parent and its visibility are therefore
  // carried over to the new quad: losing them would take the whole map off the screen.
  Surface.prototype.compose=function(){
    var parent=null,visible=false;this.composedMaterial=null; // the next render() composes with the new program
    if(this.quad){parent=this.quad.parent;visible=this.quad.visible;if(parent)parent.remove(this.quad);this.quad.geometry.dispose();this.markMaterial.dispose();}
    if(this.compositeQuad){this.compositeScene.remove(this.compositeQuad);this.compositeQuad.geometry.dispose();this.material.dispose();}
    var uniforms={uMaterials:{value:this.materialTexture},uPen:{value:new T.Vector4()},uShell:{value:new T.Vector4()},uFlags:{value:new Int32Array(4)},uClassic:{value:false},uOpacity:{value:.35},
      uOrigin:{value:new T.Vector3()},uAnchor:{value:new T.Vector3()},uForward:{value:new T.Vector3()},
      uCameraWorld:{value:new T.Matrix4()},uInvProjection:{value:new T.Matrix4()},uRicochetLoss:{value:0},uBounce:{value:1},uTint:{value:.5},uDamage:{value:new T.Vector4()}};
    for(var i=0;i<=COUNT;i++)uniforms['uLayer'+i]={value:this.targets[i].texture};
    if(this.bounce){var lib=root.MeshBVHLib;if(!this.bvhStruct){this.bvhStruct=new lib.MeshBVHUniformStruct();this.faceMaterial=new lib.FloatVertexAttributeTexture();}
      uniforms.uBVH={value:this.bvhStruct};uniforms.uFaceMaterial={value:this.faceMaterial};}
    if(this.lit){uniforms.uLightMap={value:this.lightTarget?this.lightTarget.texture:this.neutral};uniforms.uLightRange={value:new T.Vector2(this.lightFloor(),LIGHT_MAX)};}
    // Pass one draws into this.result with blending off, so it is neither transparent nor depth-tested.
    this.material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:compositeSource(this.bounce,this.lit),uniforms:uniforms,blending:T.NoBlending,depthWrite:false,depthTest:false,toneMapped:false});
    if(!this.compositeScene)this.compositeScene=new T.Scene();
    this.compositeQuad=new T.Mesh(new T.PlaneGeometry(2,2),this.material);this.compositeQuad.frustumCulled=false;this.compositeScene.add(this.compositeQuad);
    // Pass two is the quad the viewer keeps in its scene: the blending, depth state and order of the old composite.
    this.markMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:quadVertex,fragmentShader:markSource(),uniforms:{uResult:{value:null},uClassic:{value:false},uHatch:{value:new T.Vector2(5,1)},uDots:{value:false},uEdges:{value:true},uOutline:{value:false},uTint:{value:.5},uView:{value:new T.Vector4(1,1,0,0)}},transparent:true,depthWrite:false,depthTest:false,toneMapped:false});
    this.quad=new T.Mesh(new T.PlaneGeometry(2,2),this.markMaterial);this.quad.frustumCulled=false;this.quad.renderOrder=0;
    this.quad.visible=visible;if(parent)parent.add(this.quad);
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
      // The lighting program is linked here too, so a driver that will not take it says so while setLighting
      // can still fall back, instead of half-way through a frame.
      if(this.lit&&this.lightScene)renderer.compile(this.lightScene,this.captureCamera);
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
    // The smoothed visual attribute belongs to this geometry and goes with it. It is rebuilt here, where the
    // vertices are the ones the last full pose left, and only while the light is on; `normal` above is
    // untouched and stays the one physical normal per triangle that the whole ballistic path reads.
    this.baseVisual=null;if(this.lit)this.ensureVisual();
    if(this.bounce){try{this.updateBounds(geometry);}catch(e){this.bounce=false;this.bounceReason='bvh: '+(e.message||e);console.warn('Bounced leg disabled:',this.bounceReason);}}
    this.bvhStale=false;   // the BVH (if any) is this geometry's again
  };
  /* The visual normal, and nothing but the visual normal. Faces are joined by a shared EDGE - two shared
     corners - never by a single shared coordinate, and only inside one material id. That id is `part:name`
     in update(), so an edge can never join two collision parts, two armour groups, a screen to the hull or
     two coincident surfaces of different parts; the corners are welded per material id, which is why the
     edge key below needs no part or material of its own. Within one material a crease keeps its edge: two
     faces are smoothed together only when the angle between their physical planes is below SMOOTH_ANGLE,
     which also leaves the two sides of a thin sheet apart (~180 deg) and keeps every real plate joint sharp.
     Lookup is bounded - one pass over the corners, one over the edges, one over the corners again - and
     never compares a triangle with every other. Corner normals are weighted by the angle at the corner, so a
     long sliver cannot outvote a fat triangle at the corner they share, and a sum that cancels to nothing
     falls back to the face's own normal, so the result can never be NaN.
     position: 9 floats per triangle. normal: the same physical normal in all three corners of a face.
     ids: one material id per vertex record. Returns one Float32Array of the same length as position. */
  Surface.visualNormals=function(position,normal,ids){
    var faces=Math.floor(position.length/9),out=new Float32Array(position.length),i,f,c;
    for(i=0;i<position.length;i++)out[i]=normal[i]; // the safe answer everywhere until a group overwrites it
    if(!faces||faces*3>VISUAL_MAX)return out;
    // 1. Weld the corners, per material id, on a quantised coordinate. Two records that quantise either side
    // of a cell boundary simply stay apart, and that edge keeps the faceting it has today - a cosmetic miss,
    // never a change of geometry or of a number.
    var corners=faces*3,vertexOf=new Int32Array(corners),welded=new Map(),count=0;
    for(i=0;i<corners;i++){
      var key=ids[i]+':'+Math.round(position[i*3]/WELD)+','+Math.round(position[i*3+1]/WELD)+','+Math.round(position[i*3+2]/WELD);
      var found=welded.get(key);if(found===undefined){found=count++;welded.set(key,found);}
      vertexOf[i]=found;
    }
    welded.clear();
    // 2. Smoothing groups: faces joined across every edge that is not a crease, held in a union-find over
    // face indices. A non-manifold edge (three or more faces, as coincident plates produce) keeps the first
    // face it saw and tests the others against that one: still one comparison per edge, never all pairs.
    var parent=new Int32Array(faces);for(f=0;f<faces;f++)parent[f]=f;
    var root=function(x){while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
    var edges=new Map();
    for(f=0;f<faces;f++){
      for(c=0;c<3;c++){
        var va=vertexOf[f*3+c],vb=vertexOf[f*3+(c+1)%3];
        if(va===vb)continue; // a degenerate edge joins nothing
        var other=edges.get(va<vb?va*corners+vb:vb*corners+va);
        if(other===undefined){edges.set(va<vb?va*corners+vb:vb*corners+va,f);continue;}
        var n=f*9,o=other*9;
        if(normal[n]*normal[o]+normal[n+1]*normal[o+1]+normal[n+2]*normal[o+2]>=SMOOTH_COS){
          var ra=root(f),rb=root(other);if(ra!==rb)parent[rb]=ra;
        }
      }
    }
    edges.clear();
    // 3. Sum the face normals per (welded corner, smoothing group). The group is in the key, so two groups
    // that meet at one position keep their own normals and the crease between them stays sharp.
    var slotOf=new Map(),sx=[],sy=[],sz=[];
    for(f=0;f<faces;f++){
      var group=root(f),base=f*9;
      for(c=0;c<3;c++){
        var k=vertexOf[f*3+c]*faces+group,slot=slotOf.get(k);
        if(slot===undefined){slot=sx.length;slotOf.set(k,slot);sx.push(0);sy.push(0);sz.push(0);}
        var w=Surface.cornerAngle(position,base,c);
        sx[slot]+=normal[base]*w;sy[slot]+=normal[base+1]*w;sz[slot]+=normal[base+2]*w;
      }
    }
    // 4. Normalize into the output, leaving the physical normal wherever the sum came out degenerate.
    for(f=0;f<faces;f++){
      var g=root(f),b=f*9;
      for(c=0;c<3;c++){
        var s=slotOf.get(vertexOf[f*3+c]*faces+g),x=sx[s],y=sy[s],z=sz[s],len=Math.sqrt(x*x+y*y+z*z);
        if(len>1e-6){var at=b+c*3;out[at]=x/len;out[at+1]=y/len;out[at+2]=z/len;}
      }
    }
    return out;
  };
  // The angle at corner c of the face that starts at `base`, used as the weight of that face's normal there.
  Surface.cornerAngle=function(p,base,c){
    var a=base+c*3,b=base+(c+1)%3*3,d=base+(c+2)%3*3;
    var ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[d]-p[a],vy=p[d+1]-p[a+1],vz=p[d+2]-p[a+2];
    var lu=Math.sqrt(ux*ux+uy*uy+uz*uz),lv=Math.sqrt(vx*vx+vy*vy+vz*vz);
    if(!(lu>0&&lv>0))return 0;
    var cos=(ux*vx+uy*vy+uz*vz)/(lu*lv);
    return Math.acos(cos<-1?-1:cos>1?1:cos);
  };
  // Built once per geometry, in the part space update() left it in, and only while the light is on. The
  // attribute starts as a copy of the base: pose() writes the turned direction into the attribute and leaves
  // the base where it is, exactly as it does for the physical normal.
  Surface.prototype.ensureVisual=function(){
    if(this.baseVisual)return this.baseVisual;
    var geometry=this.mesh&&this.mesh.geometry,materialId=geometry&&geometry.getAttribute('materialId');
    if(!geometry||!materialId||!this.basePosition||!this.baseNormal)return null;
    this.baseVisual=Surface.visualNormals(this.basePosition,this.baseNormal,materialId.array);
    geometry.setAttribute('visualNormal',new T.Float32BufferAttribute(new Float32Array(this.baseVisual),3));
    return this.baseVisual;
  };
  // A display-only pose: the peeled geometry is re-transformed from the base update() kept, by one rigid matrix
  // per moved part, and the layers are declared stale so the next render() peels the new pose. The material
  // table, the ids and the row order are untouched, and the BVH is deliberately left where it was - rebuilding it
  // is the very cost this avoids. It is therefore the OLD pose's BVH, so the bounced leg is off (bvhStale, read by
  // render) until update() puts the BVH and everything else back in step at the end of the drag. (Before 24.09 the
  // comment said the leg was off while the layers were stale; it was not - in 'always' mode, the default, the leg
  // was traced through the old turret for the whole drag. Audit VIEW-01.)
  Surface.prototype.pose=function(delta){
    if(!this.poseRuns||!this.mesh||!this.mesh.geometry)return false;
    var geometry=this.mesh.geometry,position=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
    if(!position||!normals||!this.basePosition||position.array.length!==this.basePosition.length)return false;
    // The visual normal rides along when it exists (Soft lighting on): the delta is a rotation conjugated by
    // the z mirror, so its linear part is orthonormal and carries a direction correctly - there is no scale
    // here and so no normal matrix to build, which is the same reason the physical normal above needs none.
    var visual=geometry.getAttribute('visualNormal'),baseVisual=this.baseVisual;
    var outVisual=visual&&baseVisual&&visual.array.length===baseVisual.length?visual.array:null;
    var out=position.array,outNormal=normals.array,base=this.basePosition,baseNormal=this.baseNormal,touched=false;
    this.poseRuns.forEach(function(run){
      var matrix=delta[run.part];if(!matrix)return;var e=matrix.elements,i;
      for(i=run.start;i<run.end;i+=3){
        var x=base[i],y=base[i+1],z=base[i+2];
        out[i]=e[0]*x+e[4]*y+e[8]*z+e[12];out[i+1]=e[1]*x+e[5]*y+e[9]*z+e[13];out[i+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
        var nx=baseNormal[i],ny=baseNormal[i+1],nz=baseNormal[i+2];
        outNormal[i]=e[0]*nx+e[4]*ny+e[8]*nz;outNormal[i+1]=e[1]*nx+e[5]*ny+e[9]*nz;outNormal[i+2]=e[2]*nx+e[6]*ny+e[10]*nz;
        if(outVisual){var vx=baseVisual[i],vy=baseVisual[i+1],vz=baseVisual[i+2];
          outVisual[i]=e[0]*vx+e[4]*vy+e[8]*vz;outVisual[i+1]=e[1]*vx+e[5]*vy+e[9]*vz;outVisual[i+2]=e[2]*vx+e[6]*vy+e[10]*vz;}
      }
      touched=true;
    });
    if(!touched)return false;
    position.needsUpdate=true;normals.needsUpdate=true;if(outVisual)visual.needsUpdate=true;this.key=null;this.bvhStale=true;
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
  /* The Soft lighting switch. Off - the default - the composite is compiled without the light lookup, no
     visual normal is built, no buffer is allocated and no pass runs: the picture is the one from before this
     feature, down to the texture unit the program does not ask for. On, the composite is recompiled with the
     lookup and the next render peels the light map together with the layers. Returns the effective state,
     which differs from the request only when the driver declines; lightingReason then says why. */
  /* How deeply the soft light shades (user, 22.09): 1 is the shading this feature shipped with, 0 leaves the
     picture flat and higher values darken the turned-away faces further. Only the brightness multiplier of
     the composite changes - the normals, the palette, the numbers and the ricochet law are untouched. */
  Surface.prototype.lightFloor=function(){
    var s=Number.isFinite(this.lightStrength)?this.lightStrength:1;
    return Math.max(0,Math.min(1,LIGHT_MAX-(LIGHT_MAX-LIGHT_MIN)*s));
  };
  Surface.prototype.setLightStrength=function(value){
    var s=Math.max(0,Math.min(4,Number(value)||0));
    if(s===this.lightStrength)return s;
    this.lightStrength=s;
    var u=this.material&&this.material.uniforms;
    if(u&&u.uLightRange)u.uLightRange.value.set(this.lightFloor(),LIGHT_MAX);
    // The range is part of renderSignature: the next frame composes again with it, and the layers and the light map,
    // which it does not touch, stay (it used to drop them - nine peels a frame while the slider was dragged; VIEW-15).
    return s;
  };
  Surface.prototype.setLighting=function(enabled){
    var want=!!enabled;this.lighting=want;
    var reason=want?this.lightingBlocked():'';
    var lit=want&&!reason;
    this.lightingReason=reason;
    if(lit===this.lit){if(!lit)this.releaseLight();return this.lit;}
    this.lit=lit;this.lightFailed=false;
    if(lit){this.buildLight();this.ensureVisual();}
    try{this.compose();this.compile();}
    catch(e){
      // A driver that will not take the lit composite must not cost the map: back to the plain program, the
      // same fallback the constructor makes for the bounced leg.
      this.lit=false;this.lightingReason=String(e.message||e).replace(/\s+/g,' ').slice(0,90);
      console.warn('Soft lighting disabled:',this.lightingReason);
      this.compose();this.compile();
    }
    if(!this.lit)this.releaseLight();
    this.key=null; // the light map is peeled with the layers, so the next render redoes both
    return this.lit;
  };
  // One more sampler in the composite than the map needs on its own. WebGL 2 guarantees sixteen image units,
  // so this only ever fires on a driver that already reports fewer than the peel itself asks for - and then
  // the cosmetic light is what gives way, never the bounced leg.
  Surface.prototype.lightingBlocked=function(){
    var units=this.renderer.capabilities.maxTextures,need=COUNT+(this.bounce?8:3);
    return units<need?'only '+units+' texture units':'';
  };
  // Off again: the map, the attribute and the CPU copy go, which is where the memory actually is. The
  // material and its one-mesh scene are kept - a program and three uniforms - so a switch back is a recompile
  // of the composite and nothing else.
  Surface.prototype.releaseLight=function(){
    if(this.lightTarget){this.lightTarget.dispose();this.lightTarget=null;}
    this.baseVisual=null;
    var geometry=this.mesh&&this.mesh.geometry;
    if(geometry&&geometry.getAttribute('visualNormal'))geometry.deleteAttribute('visualNormal');
  };
  Surface.prototype.buildLight=function(){
    if(this.lightMaterial)return;
    this.lightMaterial=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:lightVertex,fragmentShader:lightFragment,side:T.DoubleSide,blending:T.NoBlending,toneMapped:false,
      uniforms:{uMaterials:{value:this.materialTexture},uOrigin:{value:new T.Vector3()},uLight:{value:new T.Vector3(0,1,0)}}});
    this.lightMesh=new T.Mesh(this.mesh.geometry,this.lightMaterial);this.lightMesh.frustumCulled=false;
    this.lightScene=new T.Scene();this.lightScene.add(this.lightMesh);
  };
  // Its own colour buffer and its own depth: the peel's depth texture is shared by all nine layers and is
  // never written here. One channel is the cheap form and every WebGL 2 context must accept R8 as a colour
  // attachment, but the pass checks rather than assumes and falls back to RGBA8; the composite reads .r
  // either way, so the picture is identical.
  Surface.prototype.lightBuffer=function(w,h,format){
    var target=new T.WebGLRenderTarget(w,h,{type:T.UnsignedByteType,format:format,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true,stencilBuffer:false});
    target.texture.generateMipmaps=false;return target;
  };
  /* The extra pass: the same camera, the same pose and the same texel grid as the layers, so the composite
     reads the light of the very texel it reads the layer of - nearest filtering on both, no halo at the
     silhouette. Depth-tested among the main armour alone, which makes the lit surface the nearest main-armour
     surface: the same one the layer walk paints, and the one under a screen when a screen is in front.
     Drawn only when the layers are stale, i.e. never per frame while the camera stands still, and nothing is
     ever read back to the CPU. */
  Surface.prototype.lightPass=function(camera){
    if(this.lightFailed)return false;
    var renderer=this.renderer,w=this.width,h=this.height;
    this.buildLight();
    if(!this.ensureVisual())return false;
    this.lightMesh.geometry=this.mesh.geometry; // update() may have replaced it since the last pass
    var u=this.lightMaterial.uniforms;u.uMaterials.value=this.materialTexture;u.uOrigin.value.copy(camera.position);
    // One diffuse light a little above and beside the camera: the +z, +y and +x columns of the camera's world
    // matrix, so the shading turns with the view and nothing the user is looking at is ever left unlit.
    // Direction only - no position, no attenuation, no specular, no shadow - and the ambient floor is the
    // bottom of the range the composite maps the shade into.
    var m=camera.matrixWorld.elements;
    u.uLight.value.set(m[8]+.30*m[0]+.45*m[4],m[9]+.30*m[1]+.45*m[5],m[10]+.30*m[2]+.45*m[6]).normalize();
    var fresh=false;
    if(this.lightTarget&&(this.lightTarget.width!==w||this.lightTarget.height!==h)){this.lightTarget.setSize(w,h);fresh=true;}
    if(!this.lightTarget){this.lightTarget=this.lightBuffer(w,h,T.RedFormat);fresh=true;}
    var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(this.colorSave),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(this.viewportSave),scissor=renderer.getScissor(this.scissorSave),scissorTest=renderer.getScissorTest();
    try{
      renderer.autoClear=false;renderer.setScissorTest(false);
      // Cleared to white: an untouched pixel reads 1.0, the top of the range, which is the neutral multiplier.
      renderer.setClearColor(0xffffff,1);renderer.setRenderTarget(this.lightTarget);
      // Asked once per allocation, exactly as the layers and the composition buffer ask it, never per frame.
      var gl=renderer.getContext();
      if(fresh&&gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){
        if(this.lightTarget.texture.format===T.RedFormat){this.lightTarget.dispose();this.lightTarget=this.lightBuffer(w,h,T.RGBAFormat);renderer.setRenderTarget(this.lightTarget);}
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('light buffer '+w+'×'+h+' unavailable');
      }
      renderer.clear(true,true,false);renderer.render(this.lightScene,this.captureCamera);
    }
    catch(e){
      // A refused pass leaves the lit composite in place and binds the neutral texture instead, so the map is
      // simply the unlit one for the rest of this instance's life and the reason reaches the status line.
      this.lightFailed=true;this.lightingReason=String(e.message||e).replace(/\s+/g,' ').slice(0,90);
      console.warn('Soft lighting disabled:',this.lightingReason);this.releaseLight();
    }
    finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
    return !this.lightFailed;
  };
  // Layer resolution: the window itself unless the quality setting or a memory budget says otherwise.
  Surface.prototype.size=function(quality,width,height,pixelRatio){
    var pr=Math.max(1,pixelRatio||1),w=Math.max(1,Math.round(width*pr)),h=Math.max(1,Math.round(height*pr)),longest=Math.max(w,h);
    var limit=quality==='low'?Math.max(512,Math.round(longest/2)):quality==='medium'?1200:quality==='high'?Infinity:1600;
    var caps=this.renderer.capabilities,scale=Math.min(1,limit/longest,caps.maxTextureSize/longest);
    // (COUNT+1) float layers of 16 bytes each plus the 4-byte depth they share, and, while Soft lighting is
    // on, its own buffer as well: one byte of colour and a 24-bit depth three allocates as a 32-bit
    // renderbuffer. Counted rather than only noted, so the light shrinks the layers along with everything
    // else on a very large window instead of quietly overrunning the budget. At 1920x1080 both figures are
    // under it (307 MB against 317 MB), so moving the switch changes no resolution there.
    var budget=320*1024*1024,extra=this.lit?5:0,bytes=function(s){return w*s*h*s*((COUNT+1)*16+4+extra);};
    while(bytes(scale)>budget&&scale>.2)scale*=.9;
    return {width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale)),scale:scale,bytes:bytes(scale)};
  };
  // bounceMode: 'always' traces the bounced leg on every draw; 'idle' (default) only once the camera has stood
  // still for SETTLE ms - the caller redraws when bouncePending says the layer is still due. A lighter mode for
  // weaker GPUs: the direct map stays live, the hatched layer catches up after the rotation.
  // ZOOM_SETTLE: how long the zoom must stand still before the picture drawn in 2D is composed again at its own
  // resolution (user, 24.09: a zoom changes nothing in 3D, so while it turns the last picture is only scaled). The
  // caller redraws when zoomPending says the sharp composition is still due, as it does for bouncePending.
  var SETTLE=150,ZOOM_SETTLE=150;
  // Monotonic: Date.now() can step backwards when the system clock is corrected after a resume, and the settle
  // comparison below would then never be satisfied again - a full-screen composition every 160 ms while idle.
  function clock(){return root.performance&&root.performance.now?root.performance.now():Date.now();}
  // How the camera differs from the one the layers were peeled with (cameraCache): 0 not at all, 1 by the ZOOM alone,
  // 2 otherwise. A zoom - camera.zoom, its lens shift, Fit, the Auto-frame scale - moves the eye nowhere: it only changes
  // the x/y scale and the off-centre terms of the projection (elements 0, 5, 8, 9), and then every pixel of the composed
  // picture simply lands elsewhere on the screen, by one scale and one shift per axis (zoomView). Anything else - the
  // eye, the look direction, near/far, the aspect - changes what each layer holds and must be peeled again. Compared
  // element by element, nothing allocated; the cache is written by keepCamera() when the layers are peeled.
  Surface.prototype.cameraChange=function(camera){
    var cache=this.cameraCache,world=camera.matrixWorld.elements,projection=camera.projectionMatrix.elements,zoom=false,i;
    for(i=0;i<16;i++)if(cache[i]!==world[i])return 2;
    for(i=0;i<16;i++)if(cache[i+16]!==projection[i]){if(i===0||i===5||i===8||i===9)zoom=true;else return 2;}
    return zoom?1:0;
  };
  Surface.prototype.keepCamera=function(camera){
    var cache=this.cameraCache,world=camera.matrixWorld.elements,projection=camera.projectionMatrix.elements;
    for(var i=0;i<16;i++){cache[i]=world[i];cache[i+16]=projection[i];}
  };
  // The 2D map from the screen's drawing-buffer pixel to the composed picture's, for a camera that differs from the
  // layers' by the zoom alone. With the layers' projection L and the current C, a direction u = x/-z lands at
  // ndc = P0*u - P8 (x) and P5*u - P9 (y) under either, so ndc_L = s*(ndc_C + C8) - L8 with s = L0/C0, and in pixels
  // (pix = (ndc + 1)/2 * W) src = s*dst + W/2*(1 - s + s*C8 - L8); y the same with 5, 9 and H. Exact: the picture that
  // is composed again once the zoom stands still lands on the very same pixels, only sharper.
  Surface.prototype.zoomView=function(camera,out){
    var L=this.cameraCache,C=camera.projectionMatrix.elements,buffer=this.renderer.getDrawingBufferSize(this.bufferSize);
    var sx=L[16]/C[0],sy=L[21]/C[5];
    return out.set(sx,sy,buffer.x/2*(1-sx+sx*C[8]-L[24]),buffer.y/2*(1-sy+sy*C[9]-L[25]));
  };
  // Whether the projection moved since the last frame; the moment it last did is kept, so the sharp composition waits
  // for ZOOM_SETTLE ms of a still zoom.
  Surface.prototype.projectionMoved=function(camera,now){
    var seen=this.projectionSeen,projection=camera.projectionMatrix.elements,moved=false;
    for(var i=0;i<16;i++)if(seen[i]!==projection[i]){seen[i]=projection[i];moved=true;}
    if(moved)this.projectionAt=now;
    return moved;
  };
  // The composite's own inputs as render() has just written them, compared element by element with the last
  // frame's and stored in place (the same no-garbage discipline as cameraCache), the Soft lighting depth (uLightRange)
  // among them. The layer frame - uOrigin,
  // uAnchor, uForward, uCameraWorld, uInvProjection - changes only together with the layers (`stale`), and the
  // textures only in update(), pose() and setLighting(), which all drop the layers too. Returns true on a change.
  Surface.prototype.renderSignature=function(u){
    var sig=this.signature,next=this.signatureNext,buffer=this.renderer.getDrawingBufferSize(this.bufferSize),flags=u.uFlags.value,changed=false,i;
    var pen=u.uPen.value,shell=u.uShell.value,damage=u.uDamage.value;
    next[0]=pen.x;next[1]=pen.y;next[2]=pen.z;next[3]=pen.w;next[4]=shell.x;next[5]=shell.y;next[6]=shell.z;next[7]=shell.w;
    next[8]=flags[0];next[9]=flags[1];next[10]=flags[2];next[11]=flags[3];
    next[12]=u.uClassic.value?1:0;next[13]=u.uOpacity.value;next[14]=u.uRicochetLoss.value;next[15]=u.uBounce.value;next[16]=u.uTint.value;
    next[17]=damage.x;next[18]=damage.y;next[19]=damage.z;next[20]=damage.w;next[21]=buffer.x;next[22]=buffer.y;
    var range=u.uLightRange?u.uLightRange.value:null;next[23]=range?range.x:0;next[24]=range?range.y:0;
    // NaN never equals itself, so a value that is not a number keeps the old every-frame composite.
    for(i=0;i<25;i++)if(sig[i]!==next[i]){sig[i]=next[i];changed=true;}
    return changed;
  };
  Surface.prototype.render=function(camera,anchor,shell,palette,opacity,quality,width,height,pixelRatio,bounceMode,mode){
    var renderer=this.renderer,size=this.size(quality,width,height,pixelRatio);
    if(this.width!==size.width||this.height!==size.height){this.width=size.width;this.height=size.height;this.targets.forEach(function(t){t.setSize(size.width,size.height);});this.key=null;this.checkPending=true;}
    if(this.checkPending)this.checkTargets();
    var s=shell||{},u=this.material.uniforms;u.uPen.value.set(s.penetration||0,s.caliber||0,s.randomization||0,!s.randomizationType||s.randomizationType==='NORMAL'?1:0);u.uShell.value.set(s.normalization||0,s.ricochetCos==null?-1:s.ricochetCos,s.jetLossPerMeter||0,s.kind==='HIGH_EXPLOSIVE'?1:0);var flags=u.uFlags.value;flags[0]=s.mayRicochet?1:0;flags[1]=s.checkCaliber?1:0;flags[2]=s.shieldPenetration?1:0;flags[3]=s.penetration>0&&s.caliber>0?1:0;u.uClassic.value=palette==='classic';u.uOpacity.value=opacity;
    u.uRicochetLoss.value=s.ricochetLoss||0;
    // Damage mode, and only with an alpha in the record: the non-penetration base is the spall damage of modern
    // HE (nonPiercingArmorDamage for AP/APCR/HEAT, 0 for legacy HE), the spall penetration 0.1·spallDamage / liner (= 0.05·α for regular HE). Off
    // it, or without an alpha, uDamage.x is 0 and the map is the plain penetration chance.
    var modern=s.kind==='HIGH_EXPLOSIVE'&&s.mechanics==='MODERN'&&s.spallDamage>0&&(s.spallAbsorption===null||s.spallAbsorption===undefined); // the special absorption shell is not modelled (ballistics.js)
    var base=s.kind==='HIGH_EXPLOSIVE'?(modern?s.spallDamage:0):(s.nonPiercingArmorDamage>0?s.nonPiercingArmorDamage:0);
    u.uDamage.value.set(mode==='damage'&&s.alpha>0?1:0,s.alpha||0,base,modern?.1*s.spallDamage/(s.liner>0?s.liner:1):1e9);
    var pr=Math.max(1,pixelRatio||1),m=this.markMaterial.uniforms;m.uHatch.value.set(Math.max(2,this.hatch||5)*pr,pr); // dot pitch in CSS px, one CSS px per dot
    m.uDots.value=!!this.dots;m.uEdges.value=this.edges!==false;m.uOutline.value=!!this.outline;var tint=this.tint===undefined?.5:this.tint;m.uTint.value=tint;u.uTint.value=tint;m.uClassic.value=u.uClassic.value;
    // Stale: the camera has moved, or the layers were dropped (a new pose, a new size, a new model). A camera that
    // differs by the zoom alone is not: while the zoom keeps changing (and for ZOOM_SETTLE ms after), the last composed
    // picture is drawn scaled and shifted in 2D by the mark pass (uView) - no peel, no light pass, no composite - and
    // the lines, rings, tracers and crosses over it, which are real geometry, stay sharp. Then one full composition.
    var now=clock(),change=this.cameraChange(camera),zoomMoving=this.projectionMoved(camera,now)||now-this.projectionAt<ZOOM_SETTLE;
    var zoom2d=change===1&&this.key!==null&&!!this.result&&zoomMoving;
    var stale=this.key===null||change===2||(change===1&&!zoom2d);
    this.zoomPending=zoom2d;
    var view=this.markMaterial.uniforms.uView.value;
    if(zoom2d)this.zoomView(camera,view);else view.set(1,1,0,0);
    if(stale){this.movedAt=now;this.keepCamera(camera);}
    var settled=bounceMode==='always'||!(Math.max(0,now-(this.movedAt||0))<SETTLE);
    // The bounced leg is traced through the GPU BVH, which a previewed pose has left behind (pose(), bvhStale): off
    // until update() rebuilds it, however long the drag holds still (VIEW-01).
    u.uBounce.value=this.bounce&&settled&&!this.bvhStale?1:0;this.bouncePending=this.bounce&&!settled;
    if(stale){
      this.captureCamera.copy(camera);var distance=camera.position.distanceTo(anchor),span=Math.max(5,this.radius*3);this.captureCamera.near=Math.max(.01,distance-span);this.captureCamera.far=distance+span;this.captureCamera.updateProjectionMatrix();
      var p=this.peelMaterial.uniforms;p.uOrigin.value.copy(camera.position);p.uAnchor.value.copy(anchor);p.uForward.value.copy(anchor).sub(camera.position).normalize();
      // The composite rebuilds the contact point in exactly the frame the layers were peeled in.
      u.uOrigin.value.copy(p.uOrigin.value);u.uAnchor.value.copy(p.uAnchor.value);u.uForward.value.copy(p.uForward.value);
      u.uCameraWorld.value.copy(camera.matrixWorld);u.uInvProjection.value.copy(camera.projectionMatrix).invert();
      var target=renderer.getRenderTarget(),auto=renderer.autoClear,clearColor=renderer.getClearColor(this.colorSave),clearAlpha=renderer.getClearAlpha(),viewport=renderer.getViewport(this.viewportSave),scissor=renderer.getScissor(this.scissorSave),scissorTest=renderer.getScissorTest();
      try{renderer.autoClear=false;renderer.setScissorTest(false);renderer.setClearColor(0,0);for(var i=0;i<=COUNT;i++){p.uFirst.value=i===0;p.uPass.value=i;p.uPrevious.value=this.targets[i===0?COUNT:i-1].texture;for(var j=0;j<COUNT;j++)p['uPeel'+j].value=j<i?this.targets[j].texture:this.blank;renderer.setRenderTarget(this.targets[i]);renderer.clear(true,true,false);renderer.render(this.captureScene,this.captureCamera);}}finally{renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);renderer.autoClear=auto;}
      // The light map depends on exactly what the layers depend on - the camera and the pose - so it is peeled
      // with them and left alone on every frame that reuses them.
      if(this.lit)this.lightPass(camera);
      this.key=1;
    }
    // The bound texture is re-read every frame: the target is created on the first pass, may be rebuilt once
    // as RGBA8, and is dropped again when the switch goes off or a pass is refused.
    if(this.lit)u.uLightMap.value=this.lightTarget&&!this.lightFailed?this.lightTarget.texture:this.neutral;
    // The heavy full-screen pass only when its inputs moved: fresh layers, a first or recompiled composite, another
    // light map, or a changed uniform or buffer size. A still frame reuses this.result bit for bit - the mark
    // pass already reads it through uResult. debugReadback() calls composite() itself.
    var changed=this.renderSignature(u);
    if(stale||changed||!this.result||this.composedMaterial!==this.material||(this.lit&&u.uLightMap.value!==this.composedLight)){
      this.composedMaterial=null;   // a pass that throws is tried again on the next frame
      this.composite();this.composedMaterial=this.material;this.composedLight=this.lit?u.uLightMap.value:null;
    }
    var light=this.lit&&!this.lightFailed?' · soft lighting':this.lighting?' · soft lighting off: '+(this.lightingReason||'unavailable'):'';
    this.quad.visible=true;return size.width+' × '+size.height+(size.scale<.999?' ('+Math.round(size.scale*100)+'% of the window)':'')+' · up to '+COUNT+' layers'+(this.bounce?(bounceMode==='always'?' · bounce traced':' · bounce traced after the camera stops'):' · bounce off: '+this.bounceReason)+light;
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
  Surface.prototype.dispose=function(){if(this.quad){if(this.quad.parent)this.quad.parent.remove(this.quad);this.quad.geometry.dispose();}if(this.markMaterial)this.markMaterial.dispose();if(this.compositeQuad)this.compositeQuad.geometry.dispose();if(this.material)this.material.dispose();if(this.result)this.result.dispose();if(this.mesh)this.mesh.geometry.dispose();if(this.peelMaterial)this.peelMaterial.dispose();if(this.materialTexture)this.materialTexture.dispose();if(this.bvhStruct)this.bvhStruct.dispose();if(this.faceMaterial)this.faceMaterial.dispose();this.bvh=null;this.targets.forEach(function(t){t.dispose();});if(this.depth)this.depth.dispose();if(this.blank)this.blank.dispose();
    // Soft lighting goes with the instance. The light mesh shares the peel geometry, already disposed above.
    if(this.lightTarget)this.lightTarget.dispose();if(this.lightMaterial)this.lightMaterial.dispose();if(this.neutral)this.neutral.dispose();
    this.lightTarget=null;this.lightMesh=null;this.lightScene=null;this.baseVisual=null;this.composedMaterial=null;this.composedLight=null;};
  root.BullbaScreenArmor=Surface;
}(window));
