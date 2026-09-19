/* Local collision rays and penetration estimate. No network or worker process. */
(function(root){
  'use strict';
  var EPS=1e-5, RAD=Math.PI/180;
  function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
  function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function unit(v){var n=Math.sqrt(dot(v,v));return n>EPS?v.map(function(x){return x/n;}):[0,0,0];}
  function transform(v,m){return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12],m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13],-(m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14])];}
  function triangle(a,b,c,part,name,armor){
    var e1=sub(b,a),e2=sub(c,a);
    return {a:a,b:b,c:c,e1:e1,e2:e2,normal:unit(cross(e1,e2)),center:a.map(function(x,i){return (x+b[i]+c[i])/3;}),part:part,name:name,armor:armor,
      min:a.map(function(x,i){return Math.min(x,b[i],c[i]);}),max:a.map(function(x,i){return Math.max(x,b[i],c[i]);})};
  }
  function tree(tris){
    if(!tris.length)return null;
    var lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    tris.forEach(function(t){for(var i=0;i<3;i++){lo[i]=Math.min(lo[i],t.min[i]);hi[i]=Math.max(hi[i],t.max[i]);}});
    var node={min:lo,max:hi};if(tris.length<=10){node.tris=tris;return node;}
    var axis=0;for(var i=1;i<3;i++)if(hi[i]-lo[i]>hi[axis]-lo[axis])axis=i;
    tris.sort(function(a,b){return a.center[axis]-b.center[axis];});var half=tris.length>>1;
    node.left=tree(tris.slice(0,half));node.right=tree(tris.slice(half));return node;
  }
  function intersectsBox(node,o,d){
    var near=0,far=Infinity;
    for(var i=0;i<3;i++){
      if(Math.abs(d[i])<1e-12){if(o[i]<node.min[i]-EPS||o[i]>node.max[i]+EPS)return false;continue;}
      var a=(node.min[i]-o[i])/d[i],b=(node.max[i]-o[i])/d[i];
      near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));if(near>far+EPS)return false;
    }
    return far>=0;
  }
  function intersect(t,o,d){
    // Same intersection arithmetic without temporary vectors for every triangle.
    var e1=t.e1,e2=t.e2,hx=d[1]*e2[2]-d[2]*e2[1],hy=d[2]*e2[0]-d[0]*e2[2],hz=d[0]*e2[1]-d[1]*e2[0];
    var det=e1[0]*hx+e1[1]*hy+e1[2]*hz;if(Math.abs(det)<1e-10)return null;
    var sx=o[0]-t.a[0],sy=o[1]-t.a[1],sz=o[2]-t.a[2],u=(sx*hx+sy*hy+sz*hz)/det;if(u<-1e-8||u>1+1e-8)return null;
    var qx=sy*e1[2]-sz*e1[1],qy=sz*e1[0]-sx*e1[2],qz=sx*e1[1]-sy*e1[0],v=(d[0]*qx+d[1]*qy+d[2]*qz)/det;if(v<-1e-8||u+v>1+1e-8)return null;
    var distance=(e2[0]*qx+e2[1]*qy+e2[2]*qz)/det;return distance>EPS?{distance:distance,triangle:t,cos:Math.abs(dot(d,t.normal))}:null;
  }
  function collisions(node,o,d,out){
    if(!node||!intersectsBox(node,o,d))return;
    if(node.tris){for(var i=0;i<node.tris.length;i++){var hit=intersect(node.tris[i],o,d);if(hit)out.push(hit);}}
    else{collisions(node.left,o,d,out);collisions(node.right,o,d,out);}
  }
  function erf(x){var sign=x<0?-1:1;x=Math.abs(x);var t=1/(1+.3275911*x);return sign*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x));}
  // Same Gaussian scale as the 2.4 #936 client's _computePenetrationChance.
  function chance(remaining,armor,nominal,randomization,type){
    if(!(nominal>0))return null;
    var margin=(remaining-armor)/nominal;
    if(randomization<=EPS)return margin>=0?100:0;
    if(type&&type!=='NORMAL')return null;
    return Math.round(clamp(.5*(1+erf(margin/randomization/.33/Math.sqrt(2)))*100,0,100));
  }
  function shell(kind,penetration,caliber){
    var ap=kind==='ARMOR_PIERCING'||kind==='ARMOR_PIERCING_CR';
    return {kind:kind,penetration:penetration,caliber:caliber,randomization:.25,randomizationType:'NORMAL',
      normalization:(kind==='ARMOR_PIERCING'?5:kind==='ARMOR_PIERCING_CR'?2:0)*RAD,
      ricochetCos:Math.cos((ap?70:85)*RAD),checkCaliber:ap,mayRicochet:kind!=='HIGH_EXPLOSIVE',
      jetLossPerMeter:kind==='HOLLOW_CHARGE'?.5:0,shieldPenetration:kind==='HIGH_EXPLOSIVE',
      // No record behind a manual shell, so no damage data: the map falls back to the chance everywhere.
      alpha:null,spallDamage:null,mechanics:null,nonPiercingArmorDamage:0,liner:1,
      ricochetLoss:ap?.25:0}; // client rule since 9.3: AP and APCR keep 75% of the penetration after a ricochet, HEAT keeps all of it
  }
  function effective(armor,cos,s){
    if(!armor.useHitAngle)return armor.armor;
    var normalization=s.normalization;
    if(armor.checkCaliberForHitAngleNorm&&armor.armor>EPS&&s.caliber>armor.armor*2)
      normalization*=1.4*s.caliber/(armor.armor*2);
    return armor.armor/Math.max(EPS,Math.cos(Math.max(0,Math.acos(clamp(cos,0,1))-normalization)));
  }
  function ricochet(armor,cos,s){
    if(!s.mayRicochet||!armor.mayRicochet||armor.armor<=EPS||cos>s.ricochetCos+1e-12)return false;
    return !armor.checkCaliberForRicochet||!s.checkCaliber||armor.armor*3>=s.caliber;
  }
  // Non-penetration damage of one shot, HP. Modern HE spalls into the hull behind a plate it did not pierce:
  // D_np = spallDamage · min(1, 0.1·spallDamage/(T·C)), T the plate's nominal armour, C the target's spall-liner factor.
  // The spall penetration is taken from the spall damage, not the displayed alpha: for regular HE (spallDamage = α/2)
  // that is the Reddit author's 0.05·α, and it also reproduces his ARES series (α 160, spallDamage 160, 20 mm:
  // 126 HP measured, 128 predicted, 64 with 0.05·α) - outputs/he-law-check-2026-09-19.md.
  // A reconstruction of the server's rule from the client's own armorSpalls data (outputs/he-damage-findings.md),
  // NOT a confirmed formula, and the ±25% damage roll is not in it. Legacy HE (SPG) has no client-side splash
  // model at all, so it stays at 0 and says so; AP/APCR/HEAT take nonPiercingArmorDamage, 0 on every shell today.
  function nonPenetration(s,nominal){
    if(s.kind!=='HIGH_EXPLOSIVE')return {damage:s.nonPiercingArmorDamage>0?s.nonPiercingArmorDamage:0,law:'none'};
    if(s.mechanics!=='MODERN'||!(s.spallDamage>0))return {damage:0,law:'legacy-unknown'};
    return {damage:s.spallDamage*Math.min(1,.1*s.spallDamage/Math.max(EPS,nominal*(s.liner>0?s.liner:1))),law:'ratio'};
  }
  // E = p·α + (1−p)·D_np on main armour; 0 where the shell never reaches it (ricochet, screen, fly-past).
  function withDamage(r,s){
    if(r.reason==='penetration'){
      var np=nonPenetration(s,r.nominal),p=r.chance===null||r.chance===undefined?null:clamp(r.chance/100,0,1);
      r.alpha=s.alpha;r.nonPen=np.damage;r.damageLaw=np.law;
      r.expected=p===null?null:p*s.alpha+(1-p)*np.damage;
      r.expectedShare=r.expected===null?null:clamp(r.expected/s.alpha,0,1);
    }else if(r.reason==='ricochet'||r.reason==='screen'||r.reason==='no-hull'){r.expected=0;r.expectedShare=0;}
    return r;
  }
  function evaluate(hits,s){var r=walk(hits,s);return s&&s.alpha>0?withDamage(r,s):r;}
  function walk(hits,s){
    if(!s||!(s.penetration>0)||!(s.caliber>0))return {chance:null,reason:'parameters',layers:[]};
    var remaining=s.penetration,ignored={},layers=[],jet=false,jetStart=0,jetRate=0,seen={};
    for(var i=0;i<hits.length;i++){
      var hit=hits[i],t=hit.triangle,a=t.armor,key=t.part+':'+t.name;
      if(seen[key]!==undefined&&Math.abs(hit.distance-seen[key])<EPS)continue;
      seen[key]=hit.distance;
      if(ignored[key])continue;
      if(!a)return {chance:null,reason:'armor',layers:layers};
      if(a.armor===null||a.armor===undefined)continue;
      var cos=a.useHitAngle?hit.cos:1;
      if(!jet&&ricochet(a,cos,s))return {chance:0,reason:'ricochet',layers:layers,nominal:a.armor,angle:Math.acos(clamp(cos,0,1))/RAD,distance:hit.distance,hit:hit,final:!!s.ricocheted};
      // HEAT after the first screen: the jet loses a fixed share of the penetration it had behind that screen per
      // metre flown (client: 0.5/m), linearly along the whole way to the armour. A later screen only subtracts its own
      // plate; it never restarts the decay (user, 19.09: a second screen in the same gap used to raise the chance).
      if(jet)remaining=Math.max(0,remaining-jetRate*Math.max(0,hit.distance-jetStart));
      var plate=effective(a,cos,s);
      layers.push({part:t.part,material:t.name,nominal:a.armor,effective:plate,angle:Math.acos(clamp(cos,0,1))/RAD,main:a.vehicleDamageFactor>EPS});
      if(a.vehicleDamageFactor>EPS){
        return {chance:chance(remaining,plate,s.penetration,s.randomization,s.randomizationType),reason:'penetration',
          effective:s.penetration-remaining+plate,nominal:a.armor,angle:layers[layers.length-1].angle,layers:layers,distance:hit.distance};
      }
      if(s.kind==='HIGH_EXPLOSIVE'){
        if(!s.shieldPenetration)return {chance:0,reason:'screen',layers:layers,distance:hit.distance};
        remaining-=plate*3; // Modern HE shield penalty; this view estimates penetration, not blast damage.
      }else remaining-=plate;
      if(a.collideOnceOnly)ignored[key]=true;
      jet=s.jetLossPerMeter>0;
      if(jet){jetStart=hit.distance+a.armor*.001;if(!jetRate)jetRate=remaining*s.jetLossPerMeter;}
    }
    return {chance:0,reason:'no-hull',layers:layers};
  }
  function build(data,useCurrent){
    var tris=[];
    ((data.hit.target||{}).parts||[]).forEach(function(part){
      var model=data.models[String(part.id)];if(!model||!part.transform)return;
      model.groups.forEach(function(g){
        var vertices=g.vertices.map(function(v){return transform(v,part.transform);});
        var armor=useCurrent?(part.comparisonArmor||part.armor):part.armor;
        for(var i=0;i<g.indices.length;i+=3)tris.push(triangle(vertices[g.indices[i]],vertices[g.indices[i+1]],vertices[g.indices[i+2]],part.id,g.material,(armor||{})[g.material]));
      });
    });
    return fromTriangles(tris);
  }
  function fromTriangles(tris){
    var acceleration=tree(tris.slice());
    var engine={triangles:tris,acceleration:acceleration};
    engine.ray=function(o,d,s){
      if(!s||!(s.penetration>0)||!(s.caliber>0))return evaluate([],s);
      d=unit(d);var hits=[];collisions(acceleration,o,d,hits);hits.sort(function(a,b){return a.distance-b.distance;});
      var r=evaluate(hits,s);r.origin=o;r.direction=d;
      // Client rule since 9.3: after a ricochet the shell flies on along the mirrored direction with the reduced
      // penetration and may hit the same vehicle again; a second ricochet destroys it. The first-contact picture
      // (heat map, GPU cross-check) passes ricochetContinue:false and stops here.
      if(r.reason==='ricochet'&&r.hit&&!s.ricocheted&&s.ricochetContinue!==false&&s.ricochetLoss!==undefined){
        var h=r.hit,n=h.triangle.normal,k=2*dot(d,n),out=unit([d[0]-k*n[0],d[1]-k*n[1],d[2]-k*n[2]]);
        var point=[o[0]+d[0]*h.distance,o[1]+d[1]*h.distance,o[2]+d[2]*h.distance];
        var next=Object.assign({},s,{penetration:s.penetration*(1-s.ricochetLoss),ricocheted:true});
        var second=engine.ray([point[0]+out[0]*1e-3,point[1]+out[1]*1e-3,point[2]+out[2]*1e-3],out,next);
        second.bounce={point:point,normal:n,direction:out,nominal:r.nominal,angle:r.angle,penetration:next.penetration,loss:s.ricochetLoss,layers:r.layers};
        return second;
      }
      return r;
    };
    return engine;
  }
  function subdivide(t,depth,out,edge,budget){
    edge=edge||.65;budget=budget===undefined?64:budget;
    var points=[t.a,t.b,t.c],edges=[[0,1,2],[1,2,0],[2,0,1]],longest=0,max=0;
    edges.forEach(function(e,i){var v=sub(points[e[0]],points[e[1]]),size=dot(v,v);if(size>max){max=size;longest=i;}});
    if(depth>=14||budget<2||max<=edge*edge){out.push(t);return;}
    var e=edges[longest],a=points[e[0]],b=points[e[1]],c=points[e[2]],mid=a.map(function(x,i){return (x+b[i])/2;});
    subdivide(triangle(a,mid,c,t.part,t.name,t.armor),depth+1,out,edge,Math.floor(budget/2));subdivide(triangle(mid,b,c,t.part,t.name,t.armor),depth+1,out,edge,Math.ceil(budget/2));
  }
  var palettes={accessible:[[.63,.18,.55],[.95,.75,.31],[.20,.84,.76]],classic:[[.90,.20,.18],[.97,.79,.22],[.20,.79,.35]]};
  // The 0…1 quantity a result is coloured by: the penetration chance, or - in damage mode, and only when the
  // shell carries an alpha - the expected damage as a share of it. null means "no estimate": neutral grey.
  function value(result,mode){
    if(mode==='damage')return result.expectedShare===null||result.expectedShare===undefined?null:clamp(result.expectedShare,0,1);
    return result.chance===null||result.chance===undefined?null:clamp(result.chance/100,0,1);
  }
  function color(result,palette,tint,mode){
    var share=value(result,mode);
    if(share===null)return [.34,.42,.49];
    // Ricochet history (a ricochet, or a fly-past after one): the 0 % colour with blue mixed in by 'tint'
    // (0 none, 0.5 default, up to 1.5), the same rule as the GPU map's blued().
    if(result.reason==='ricochet'||(result.reason==='no-hull'&&result.bounce)){
      var lo=(palettes[palette]||palettes.accessible)[0],k=tint===undefined?.5:tint,to=[lo[0]*.8,lo[1]*.95,Math.max(lo[2],.55)];
      return lo.map(function(v,i){return clamp(v+(to[i]-v)*k,0,1);});
    }
    if(result.reason==='no-hull')return [.21,.27,.33];
    var stops=palettes[palette]||palettes.accessible,p=share*2,i=Math.min(1,Math.floor(p)),f=p-i;
    return stops[i].map(function(v,k){return v+(stops[i+1][k]-v)*f;});
  }
  root.ArmorBallistics={build:build,fromTriangles:fromTriangles,triangle:triangle,subdivide:subdivide,evaluate:evaluate,shell:shell,chance:chance,effective:effective,ricochet:ricochet,color:color,value:value,nonPenetration:nonPenetration,transform:transform,unit:unit,sub:sub};
}(typeof window==='undefined'?globalThis:window));
