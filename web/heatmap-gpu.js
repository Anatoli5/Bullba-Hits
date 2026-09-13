/* WebGL 2 heatmap compute pass. Core Three only; no worker, network or runtime. */
(function(root){
  'use strict';
  var MAX_HITS=64;
  function textureData(values,maxSize){
    var count=Math.max(1,Math.ceil(values.length/4)),width=Math.min(maxSize,Math.ceil(Math.sqrt(count))),height=Math.ceil(count/width);
    if(height>maxSize)throw new Error('The model exceeds the WebGL texture size');
    var data=new Float32Array(width*height*4);data.set(values);return {data:data,width:width,height:height};
  }
  function pack(engine,samples,maxSize){
    var nodes=[],triangles=[],materials=[],centers=[],keys=Object.create(null),materialCount=0,nodeCount=0;
    function material(t){
      var key=t.part+':'+t.name;if(keys[key]!==undefined)return keys[key];
      var id=materialCount++,a=t.armor;keys[key]=id;
      materials.push(a?(a.armor==null?-1:a.armor):-2,a?a.vehicleDamageFactor:0,a&&a.useHitAngle?1:0,a&&a.mayRicochet?1:0,
        a&&a.collideOnceOnly?1:0,a&&a.checkCaliberForRicochet?1:0,a&&a.checkCaliberForHitAngleNorm?1:0,0);
      return id;
    }
    function visit(node){
      var id=nodeCount++,offset=nodes.length;nodes.push(node.min[0],node.min[1],node.min[2],0,node.max[0],node.max[1],node.max[2],-1);
      if(node.tris){
        // Leaves in the CPU tree contain at most ten triangles. Both traversals
        // retain their order, including coincident intersections.
        if(node.tris.length>15)throw new Error('Unsupported collision tree leaf');
        nodes[offset+7]=(triangles.length/16)*16+node.tris.length;
        node.tris.forEach(function(t){triangles.push(t.a[0],t.a[1],t.a[2],material(t),t.e1[0],t.e1[1],t.e1[2],0,t.e2[0],t.e2[1],t.e2[2],0,t.normal[0],t.normal[1],t.normal[2],0);});
      }else{visit(node.left);visit(node.right);}
      nodes[offset+3]=nodeCount;return id;
    }
    if(engine.acceleration)visit(engine.acceleration);
    samples.forEach(function(t){centers.push(t.center[0],t.center[1],t.center[2],0);});
    if(nodeCount>16384||triangles.length/16>65535)throw new Error('The model exceeds the GPU estimate limit');
    return {nodes:textureData(nodes,maxSize),triangles:textureData(triangles,maxSize),materials:textureData(materials,maxSize),samples:textureData(centers,maxSize),nodeCount:nodeCount,sampleCount:samples.length};
  }
  var vertexShader='precision highp float;\nin vec3 position;\nvoid main(){gl_Position=vec4(position,1.0);}';
  var fragmentShader=`
precision highp float;
precision highp int;
uniform highp sampler2D uNodes;
uniform highp sampler2D uTriangles;
uniform highp sampler2D uMaterials;
uniform highp sampler2D uSamples;
uniform int uNodeCount;
uniform int uSampleCount;
uniform int uWidth;
uniform vec3 uOrigin;
uniform vec4 uPen; // penetration, caliber, RNG fraction, NORMAL distribution
uniform vec4 uShell; // normalization, ricochet cosine, jet loss/m, HE flag
uniform ivec4 uFlags; // ricochet, caliber rule, HE shield penetration, valid input
out vec4 resultColor;
const float EPS=0.00001;
const float HALF_PI=1.5707963267948966;
const int MAX_HITS=${MAX_HITS};
vec4 value(highp sampler2D image,int index){int width=textureSize(image,0).x;return texelFetch(image,ivec2(index%width,index/width),0);}
bool boxHit(vec3 lo,vec3 hi,vec3 origin,vec3 direction){
  float nearValue=0.0,farValue=1e30;
  for(int axis=0;axis<3;axis++){
    if(abs(direction[axis])<1e-12){if(origin[axis]<lo[axis]-EPS||origin[axis]>hi[axis]+EPS)return false;}
    else{float a=(lo[axis]-origin[axis])/direction[axis],b=(hi[axis]-origin[axis])/direction[axis];nearValue=max(nearValue,min(a,b));farValue=min(farValue,max(a,b));if(nearValue>farValue+EPS)return false;}
  }
  return farValue>=0.0;
}
bool triangleHit(int index,vec3 origin,vec3 direction,out float distance,out float cosine,out bool uncertain){
  uncertain=false;
  vec3 a=value(uTriangles,index*4).xyz,e1=value(uTriangles,index*4+1).xyz,e2=value(uTriangles,index*4+2).xyz;
  vec3 h=cross(direction,e2);float det=dot(e1,h);if(abs(det)<1e-10)return false;
  // Borderline float32 intersections are resolved by the existing CPU path.
  // Do not widen the actual triangle, which could introduce extra armor layers.
  const float edgeBand=0.00001;
  vec3 s=origin-a;float u=dot(s,h)/det;if(u<-edgeBand||u>1.0+edgeBand)return false;
  vec3 q=cross(s,e1);float v=dot(direction,q)/det;if(v<-edgeBand||u+v>1.0+edgeBand)return false;
  distance=dot(e2,q)/det;if(distance<=EPS)return false;
  uncertain=min(min(abs(u),abs(v)),abs(1.0-u-v))<=edgeBand;
  if(uncertain)return false;
  if(u<-1e-8||u>1.00000001||v<-1e-8||u+v>1.00000001)return false;
  cosine=abs(dot(direction,value(uTriangles,index*4+3).xyz));return true;
}
float erfApprox(float x){float signValue=x<0.0?-1.0:1.0;x=abs(x);float t=1.0/(1.0+0.3275911*x);return signValue*(1.0-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*exp(-x*x));}
int probability(float remaining,float plate){
  float margin=(remaining-plate)/uPen.x;if(uPen.z<=EPS)return margin>=0.0?100:0;
  if(uPen.w<0.5)return 101;
  return int(floor(clamp(0.5*(1.0+erfApprox(margin/uPen.z/0.33/sqrt(2.0)))*100.0,0.0,100.0)+0.5));
}
int computeHeat(int sampleIndex){
  if(uFlags.w==0)return 101;
  vec3 center=value(uSamples,sampleIndex).xyz,origin=uOrigin,direction=normalize(center-origin);
  // Anchor distant rays at their sample instead of subtracting large world
  // coordinates. A full bounding-box diagonal places the origin outside the
  // model on the same ray; layer-to-layer distances and perspective are kept.
  if(uNodeCount>0){vec3 lo=value(uNodes,0).xyz,hi=value(uNodes,1).xyz;float span=length(hi-lo)+1.0;if(length(center-origin)>span)origin=center-direction*span;}
  float distances[MAX_HITS],cosines[MAX_HITS];int ids[MAX_HITS];int count=0,node=0;
  for(int step=0;step<uNodeCount;step++){
    if(node>=uNodeCount)break;
    vec4 lo=value(uNodes,node*2),hi=value(uNodes,node*2+1);
    if(!boxHit(lo.xyz,hi.xyz,origin,direction)){node=int(lo.w);continue;}
    if(hi.w<0.0){node++;continue;}
    int code=int(hi.w),first=code/16,size=code%16;
    for(int j=0;j<15;j++){
      if(j>=size)break;float distance,cosine;bool uncertain;int id=first+j;
      bool hit=triangleHit(id,origin,direction,distance,cosine,uncertain);
      if(uncertain)return 103;
      if(!hit)continue;
      if(count>=MAX_HITS)return 103; // CPU resolves overflow, never truncate armor.
      int at=count;
      for(int k=MAX_HITS-1;k>0;k--){if(k>at)continue;if(distances[k-1]<=distance)break;distances[k]=distances[k-1];cosines[k]=cosines[k-1];ids[k]=ids[k-1];at--;}
      distances[at]=distance;cosines[at]=cosine;ids[at]=id;count++;
    }
    node=int(lo.w);
  }
  int seenIds[MAX_HITS];float seenDist[MAX_HITS];bool ignored[MAX_HITS];int seenCount=0;
  float remaining=uPen.x,jetStart=0.0;bool jet=false;
  for(int i=0;i<MAX_HITS;i++){
    if(i>=count)break;
    int mid=int(value(uTriangles,ids[i]*4).w),seen=-1;
    for(int j=0;j<MAX_HITS;j++){if(j>=seenCount)break;if(seenIds[j]==mid){seen=j;break;}}
    if(seen>=0&&abs(distances[i]-seenDist[seen])<EPS)continue;
    if(seen<0){seen=seenCount++;seenIds[seen]=mid;ignored[seen]=false;}
    seenDist[seen]=distances[i];if(ignored[seen])continue;
    vec4 armor=value(uMaterials,mid*2),flags=value(uMaterials,mid*2+1);
    if(armor.x<-1.5)return 101;if(armor.x<0.0)continue;
    float cosine=armor.z>0.5?cosines[i]:1.0;
    bool bounce=uFlags.x!=0&&armor.w>0.5&&armor.x>EPS&&cosine<=uShell.y;
    if(!jet&&bounce&&(flags.y<0.5||uFlags.y==0||armor.x*3.0>=uPen.y))return 0;
    if(jet)remaining*=max(0.0,1.0-max(0.0,distances[i]-jetStart)*uShell.z);
    float normalization=uShell.x;
    if(flags.z>0.5&&armor.x>EPS&&uPen.y>armor.x*2.0)normalization*=1.4*uPen.y/(armor.x*2.0);
    float plate=armor.x;
    if(armor.z>0.5)plate/=max(EPS,cos(max(0.0,acos(clamp(cosine,0.0,1.0))-normalization)));
    if(armor.y>EPS)return probability(remaining,plate);
    if(uShell.w>0.5){if(uFlags.z==0)return 0;remaining-=plate*3.0;}else remaining-=plate;
    if(flags.x>0.5)ignored[seen]=true;
    jet=uShell.z>0.0;if(jet)jetStart=distances[i]+armor.x*0.001;
  }
  return 102;
}
void main(){int index=int(gl_FragCoord.y)*uWidth+int(gl_FragCoord.x);int code=index<uSampleCount?computeHeat(index):101;resultColor=vec4(float(code)/255.0,0.0,0.0,1.0);}
`;
  function uniforms(origin,shell){
    var valid=shell&&shell.penetration>0&&shell.caliber>0,s=valid?shell:{};
    return {origin:origin,pen:[s.penetration||0,s.caliber||0,s.randomization||0,!s.randomizationType||s.randomizationType==='NORMAL'?1:0],
      shell:[s.normalization||0,s.ricochetCos==null?-1:s.ricochetCos,s.jetLossPerMeter||0,s.kind==='HIGH_EXPLOSIVE'?1:0],flags:[s.mayRicochet?1:0,s.checkCaliber?1:0,s.shieldPenetration?1:0,valid?1:0]};
  }
  function HeatmapGPU(renderer,engine,samples){
    if(!renderer.capabilities||!renderer.capabilities.isWebGL2)throw new Error('WebGL 2 unavailable');
    var gl=renderer.getContext(),extension=gl.getExtension('WEBGL_debug_renderer_info'),driver=extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):'';
    if(/swiftshader|llvmpipe|software|basic render/i.test(driver))throw new Error('WebGL uses a software renderer');
    this.renderer=renderer;this.textures=[];this.target=null;this.material=null;this.geometry=null;
    var T=THREE,self=this;
    try{
      var data=pack(engine,samples,renderer.capabilities.maxTextureSize),u={};this.data=data;
      ['nodes','triangles','materials','samples'].forEach(function(name){var d=data[name],texture=new T.DataTexture(d.data,d.width,d.height,T.RGBAFormat,T.FloatType);texture.minFilter=texture.magFilter=T.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;self.textures.push(texture);u['u'+name[0].toUpperCase()+name.slice(1)]={value:texture};});
      u.uNodeCount={value:data.nodeCount};u.uSampleCount={value:data.sampleCount};u.uWidth={value:data.samples.width};u.uOrigin={value:new T.Vector3()};u.uPen={value:new T.Vector4()};u.uShell={value:new T.Vector4()};u.uFlags={value:new Int32Array(4)};
      this.target=new T.WebGLRenderTarget(data.samples.width,data.samples.height,{format:T.RGBAFormat,type:T.UnsignedByteType,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false,stencilBuffer:false});
      this.material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:vertexShader,fragmentShader:fragmentShader,uniforms:u,depthTest:false,depthWrite:false,blending:T.NoBlending,toneMapped:false});
      this.geometry=new T.PlaneGeometry(2,2);var quad=new T.Mesh(this.geometry,this.material);quad.frustumCulled=false;this.scene=new T.Scene();this.scene.add(quad);this.camera=new T.Camera();
      this.bytes=new Uint8Array(data.samples.width*data.samples.height*4);this.codes=new Uint8Array(samples.length);
      var error=null,previous=renderer.debug.onShaderError;
      renderer.debug.onShaderError=function(gl,program,vs,fs){error=gl.getProgramInfoLog(program)||gl.getShaderInfoLog(fs)||'GPU compilation error';};
      try{renderer.compile(this.scene,this.camera);}finally{renderer.debug.onShaderError=previous;}
      if(error)throw new Error(error);
    }catch(e){this.dispose();throw e;}
  }
  // Pose changes upload data while retaining the compiled shader and draw pass.
  HeatmapGPU.prototype.update=function(engine,samples){
    var T=THREE,self=this,data=pack(engine,samples,this.renderer.capabilities.maxTextureSize),u=this.material.uniforms;
    ['nodes','triangles','materials','samples'].forEach(function(name,index){
      var d=data[name],texture=self.textures[index];
      if(texture.image.width!==d.width||texture.image.height!==d.height){
        texture.dispose();texture=new T.DataTexture(d.data,d.width,d.height,T.RGBAFormat,T.FloatType);
        texture.minFilter=texture.magFilter=T.NearestFilter;texture.generateMipmaps=false;self.textures[index]=texture;
      }else texture.image.data=d.data;
      texture.needsUpdate=true;u['u'+name[0].toUpperCase()+name.slice(1)].value=texture;
    });
    u.uNodeCount.value=data.nodeCount;u.uSampleCount.value=data.sampleCount;u.uWidth.value=data.samples.width;
    this.target.setSize(data.samples.width,data.samples.height);
    var bytes=data.samples.width*data.samples.height*4;
    if(this.bytes.length!==bytes)this.bytes=new Uint8Array(bytes);
    if(this.codes.length!==samples.length)this.codes=new Uint8Array(samples.length);
    this.data=data;
  };
  HeatmapGPU.prototype.compute=function(origin,shell){
    if(this.renderer.getContext().isContextLost())throw new Error('Graphics context lost');
    var values=uniforms(origin,shell),u=this.material.uniforms;u.uOrigin.value.fromArray(values.origin);u.uPen.value.fromArray(values.pen);u.uShell.value.fromArray(values.shell);u.uFlags.value.set(values.flags);
    var previous=this.renderer.getRenderTarget();
    this.bytes.fill(0);
    try{this.renderer.setRenderTarget(this.target);this.renderer.render(this.scene,this.camera);this.renderer.readRenderTargetPixels(this.target,0,0,this.data.samples.width,this.data.samples.height,this.bytes);}finally{this.renderer.setRenderTarget(previous);}
    for(var i=0;i<this.codes.length;i++){if(this.bytes[i*4+3]!==255||this.bytes[i*4]>103)throw new Error('Invalid GPU result');this.codes[i]=this.bytes[i*4];}
    return this.codes;
  };
  HeatmapGPU.prototype.dispose=function(){this.textures.forEach(function(t){t.dispose();});this.textures=[];if(this.target)this.target.dispose();if(this.material)this.material.dispose();if(this.geometry)this.geometry.dispose();};
  HeatmapGPU.pack=pack;HeatmapGPU.uniforms=uniforms;HeatmapGPU.vertexShader=vertexShader;HeatmapGPU.fragmentShader=fragmentShader;
  root.ArmorHeatmapGPU=HeatmapGPU;
}(typeof window==='undefined'?globalThis:window));
