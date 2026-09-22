/* Local WebGL scene. Game transforms are serialized by basis vectors, column-major. */
(function () {
  'use strict';
  var DISTANCE_MIN=3,DISTANCE_MAX=1000; // metres: no map is wider than ~1 km; closer than 5 m the camera sits inside the hull
  // POSE_SETTLE: ms without a pose change after which the display-only pose is turned into a full rebuild.
  // FRAME_STALL: ms after which a scheduled frame that never fired counts as lost (kick()).
  // FRAME_SAMPLES: frames kept for the rate readout; FRAME_WINDOW: how fresh they must be.
  var POSE_SETTLE=200,FRAME_STALL=2000,FRAME_SAMPLES=30,FRAME_WINDOW=2000;
  // A monotonic clock. Date.now() steps backwards when the system clock is corrected after a resume, which used
  // to leave the settle comparisons below permanently unsatisfied.
  function clock(){return window.performance&&window.performance.now?window.performance.now():Date.now();}
  // Whether the RECORDED markers belong on screen. There is no checkbox any more (0.7.15): the recorded
  // circles are always shown, and switching the emulation on no longer takes them away (user, 20.09).
  // They make way for the USER'S FIRST SHOT - the same rule as pinning a point on a hit - and come back
  // when the mode goes off or the emulated shot is dropped.
  var aimFired=false;
  function aimShown(){return !aimFired;}
  // ONE COLOUR RULE FOR EVERY RING (user, 20.09). A ring that STANDS STILL is MAGENTA: the recorded
  // client reticle (solid), the recorded server reticle (dashed), the nominal full-aim estimate of a hit
  // (dashed) and the ring an emulated shot leaves behind (solid). The LIVE emulation ring is the only
  // one that moves, so it is the only cyan one - and cyan reads over the red-green heat map, where
  // yellow is lost. The line style is what tells the magenta rings apart, not the colour.
  // The reload IS the live ring: while the gun reloads the ring is drawn only as far as the reload has
  // run, so a whole ring means a loaded gun.
  var AIM_RING=0xff5ad6;
  var AIM_LIVE={color:0x5ee0ff,dashed:true,opacity:.95},AIM_FIXED={color:AIM_RING,dashed:false,opacity:1};
  function linear(color){return color.map(function(c){return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);});}
  var baseColors=[[.38,.46,.54],[.65,.73,.8],[.75,.83,.87],[.55,.65,.72]].map(linear);
  function externalLayer(t){return t.part===0||!!(t.armor&&Number.isFinite(t.armor.vehicleDamageFactor)&&t.armor.vehicleDamageFactor<=1e-5);}
  function Viewer(container) {
    var self = this, T = THREE;
    this.container = container;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);
    this.reticles=[];this.reticleLayer=document.createElement('div');this.reticleLayer.className='hit-reticle-layer';container.appendChild(this.reticleLayer);
    this.impactOpacity=.5;this.setImpactOpacity(.5);   // the default of the Settings slider, applied before the first cross exists
    this.grid = new T.GridHelper(24, 24, 0x4a5d6f, 0x263746); this.scene.add(this.grid);
    this.root = new T.Group(); this.scene.add(this.root);
    this.target = new T.Vector3(0, 1, 0); this.yaw = 0.7; this.pitch = 0.27; this.distance = 50;
    this.defaults={distance:50,scale:.85};this.pivot='vehicle';this.pivotHeight=null;this.pinned=null;this.pinGroup=null;this.pinReticles=[];this.centre=null;this.pan=new T.Vector2();this.frameCenter=new T.Vector2();this.fitZoom=1;
    try{var saved=JSON.parse(window.localStorage.getItem('armor-camera-defaults'));if(saved&&saved.distance>=1&&saved.distance<=1500&&saved.scale>=.1&&saved.scale<=10)this.defaults=saved;}catch(ignore){}
    this.materials = []; this.point = null; this.travel = null;
    this.shell=null;this.heatmap=true;this.palette='classic';this.paintTimer=null;this.paintMesh=null;this.samples=[];this.engine=null;
    this.frameId=null;this.fitPending=false;this.recordedDistance=null;this.estimateAim=null;this.paintedKey=null;this.distanceSet=false;
    // Aim emulation: the circle that follows the cursor. liveRadius100 is the radius at 100 m the page
    // computes from the shooter's state (null = the feature is off and the manual estimate stands),
    // liveAimPoint the centre it was last drawn at, liveAim the drawn circle the integral samples.
    // aimCursorPoint is where the cursor points, liveAimPoint where the GUN points: with the turret
    // emulation on they are the same only once the turret has caught up (see chaseAim).
    // The live ring is NEVER frozen (user, 20.09): a shot leaves a second, solid ring behind it
    // (aimShotCircle) and the live one goes on aiming. aimReloadPart is how much of the reload has run,
    // 0..1, and it is how much of the live ring is drawn; null = loaded, the whole ring. aimHold says
    // the pointer is down on a shot, not on a drag.
    this.liveRadius100=null;this.liveAimPoint=null;this.aimCursorPoint=null;this.liveAim=null;this.aimChase=false;this.aimProfileName=ArmorBallistics.aimProfileDefault;
    // aimPinned: the pinned line on screen is the emulated shot's own, so dropping that shot releases it
    // and the recorded tracer and reticles come back.
    this.aimShotCircle=null;this.aimReloadPart=null;this.aimHold=false;this.aimPinned=false;
    // aimCentred: the aim held on the model centre while the page's Config popover is open (setAimCentre),
    // null otherwise; aimMarker the crosshair drawn there, in aimMarkerShape; aimSettleTimer the wait after a
    // +/- key before the held point is looked for again (settleAimSoon).
    this.aimCentred=null;this.aimMarker=null;this.aimMarkerShape='cross';this.aimSettleTimer=null;
    this.frameAt=0;this.frameTimes=[]; // when the pending frame was asked for, and the cadence of the frames that ran
    this.contextLost=false;this.dragging=false;this.hoverId=null;this.hoverEvent=null;this.inspectKey=null;
    // The camera is driven by its own frame loop: pointer and key events only move the target.
    this.targetYaw=this.yaw;this.targetPitch=this.pitch;this.orbitId=null;this.pendingPan=null;this.targetDistance=null;this.targetScale=null;this.targetZoom=null; // wheel targets, null = nothing pending
    // Layout read once per resize instead of once per frame, and the geometry of the drawn pose.
    this.viewWidth=0;this.viewHeight=0;this.viewRect=null;this.poseGeometries=null;this.poseBuilt=null;this.poseStale=false;this.poseAt=0;
    this.quality='auto';this.bounceMode='always';this.bounceTimer=null;this.dots=true;this.dotSpacing=3;this.tint=.5;this.partEdges=true;this.zoneOutline=false;this.turretAngle=0;this.turretTimer=null;this.turretPending=false;
    this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.trackOpacity=.12;this.trackKey=null;this.pinCache=null;this.liveRingMaterial=null;this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.lighting=false;this.gunAngle=0;this.autoFrame=true;this.frameScale=this.defaults.scale;this.outline=null;this.outlineDepth=null;this.outlineStyle={brightness:.8,opacity:.06};this.showOutline=false;
    var drag = null;
    container.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    container.addEventListener('pointerdown', function(e) { /* The scene tiles and the modifier groups beside them are controls of their own: capturing the pointer here would retarget the click to #viewport and the shooter tile would never fire. Leaving the drag unstarted also keeps the pointerup below from pinning a point under the control. */ if(e.target&&e.target.closest&&e.target.closest('.viewport-tile,.mod-slot,.swap-roles,.aim-gun,.aim-drive,#aim-config'))return; /* pan: right button, or Ctrl + left button (the in-game browser swallows the right button) */ if(e.button===2||(e.button===0&&e.ctrlKey)){drag={pan:true,x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false};self.dragging=true;try{container.setPointerCapture(e.pointerId);}catch(ignore){}return;}if(e.button!==0)return;if(e.altKey){self.aimAt(e);return;}drag={x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false,part:self.pickPart(e)};self.dragging=true; try{container.setPointerCapture(e.pointerId);}catch(ignore){} container.focus();
      /* Hold to fire (user, 20.09): the press itself never shoots. The page starts a hold timer and decides -
         a short press is one shot on release, a long one a burst on the gun's cooldown - and a drag past the
         threshold below cancels the whole thing. aimHold marks the press as a shot so the emulation is not
         paused for it the way a real drag is. */
      if(self.onShotDown&&self.onShotDown(e))self.aimHold=true; });
    /* A move past the threshold is a drag - unless the press has already grown into a burst (user, 20.09):
       once the first round is away, moving the mouse AIMS the burst (the turret chases the cursor) and only
       the release stops it. onShotCancel says which it is: false = the burst goes on, so the press is never
       handed to the orbit or the turret drag and the pointer goes back to plain hovering. */
    container.addEventListener('pointermove', function(e) { if (!drag){self.hover(e);return;}if(Math.abs(e.clientX-drag.sx)+Math.abs(e.clientY-drag.sy)>3)drag.moved=true;if(!drag.moved)return;if(self.aimHold){if(self.onShotCancel&&self.onShotCancel()===false){drag=null;self.dragging=false;self.hover(e);return;}self.aimHold=false;}if(drag.pan){/* the pan is accumulated and applied once in the camera's own frame loop, not per event */var p=self.pendingPan||(self.pendingPan={x:0,y:0});p.x+=e.clientX-drag.x;p.y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;self.startOrbit();return;}if(drag.part===2||drag.part===3){/* turret and gun are one module: left/right turns the turret, up/down moves the gun - both applied first, then one markPose and one notification for the step */var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(self.loadedData&&(dx||dy)){var turned=dx?self.turretTo(self.turretAngle-dx*.5):null,gun=dy?self.gunTo(self.gunAngle+dy*.16):null;self.markPose();if(turned){if(self.onTurret)self.onTurret(turned);}else if(self.onGun)self.onGun(gun);}}else{self.orbitTo(self.targetYaw-(e.clientX-drag.x)*0.008,self.targetPitch+(e.clientY-drag.y)*0.008);}drag.x=e.clientX;drag.y=e.clientY; });
    // The end of a drag: the pose the drag only previewed is rebuilt in full, and one frame is asked for so the
    // map comes back at full quality with the ricochet trace (paint() draws a drag at half resolution).
    // The end of a press: a press the emulation claimed is handed back to it (a tap fires one shot, a
    // hold has been firing all along and simply stops), anything else pins the point under the cursor
    // as it always did. A drag that moved the camera while the aim is held looks for the middle again now,
    // once, and not on each frame of it (settleAim).
    container.addEventListener('pointerup', function(e) { var d=drag,hold=self.aimHold;drag=null;self.aimHold=false;self.dragging=false;self.commitPose();self.draw();if(d&&d.moved)self.settleAim();if(hold&&self.onShotUp){self.onShotUp(e);return;}if(d&&!d.moved&&!e.altKey&&!e.ctrlKey&&e.button===0)self.pinAt(e); });
    /* A pointer that is taken away never sends its pointerup, so a burst has to be ENDED here, not
       cancelled: onShotCancel refuses a running burst (false) and the release path stops it instead. */
    container.addEventListener('pointercancel', function() { var d=drag;drag=null;self.dragging=false;if(self.aimHold){self.aimHold=false;if(self.onShotCancel&&self.onShotCancel()===false&&self.onShotUp)self.onShotUp();}self.cancelHover();self.commitPose();self.draw();if(d&&d.moved)self.settleAim(); });
    container.addEventListener('wheel', function(e) {e.preventDefault();var delta=e.deltaY||e.deltaX,amount=Math.max(-200,Math.min(200,delta*(e.deltaMode===1?16:e.deltaMode===2?300:1)));if(!(e.shiftKey||e.ctrlKey||e.altKey))self.distanceTo((self.targetDistance!==null?self.targetDistance:self.distance)*Math.exp(amount*.002));else if(self.autoFrame)self.scaleTo((self.targetScale!==null?self.targetScale:self.frameScale)*Math.exp(-amount*.002));else self.zoomTo((self.targetZoom!==null?self.targetZoom:self.camera.zoom)*Math.exp(-amount*.002));}, {passive:false});
    container.addEventListener('keydown',function(e){var used=true,orbit=true;if(e.key==='ArrowLeft')self.orbitTo(self.targetYaw-.1,self.targetPitch);else if(e.key==='ArrowRight')self.orbitTo(self.targetYaw+.1,self.targetPitch);else if(e.key==='ArrowUp')self.orbitTo(self.targetYaw,self.targetPitch+.1);else if(e.key==='ArrowDown')self.orbitTo(self.targetYaw,self.targetPitch-.1);else{orbit=false;if(e.key==='+'||e.key==='='){if(e.shiftKey)self.setZoom(self.camera.zoom*1.1);else self.setDistance(Math.max(1,self.distance/1.1));}else if(e.key==='-'){if(e.shiftKey)self.setZoom(self.camera.zoom/1.1);else self.setDistance(Math.min(1500,self.distance*1.1));}else used=false;}if(used){e.preventDefault();if(!orbit){self.render();if(self.aimCentred)self.settleAimSoon();}}});
    // A lost context stops the frame loop: three ignores render() while the context is gone, but a pending
    // frame of ours would still walk the whole paint path. Restoring clears the flag and redraws once.
    if(this.renderer.domElement.addEventListener){
      this.renderer.domElement.addEventListener('webglcontextlost',function(e){e.preventDefault();self.contextLost=true;window.cancelAnimationFrame(self.frameId);self.frameId=null;self.cancelHover();self.cancelOrbit();window.dispatchEvent(new Event('armor-context-lost'));});
      this.renderer.domElement.addEventListener('webglcontextrestored',function(){self.restoreContext();});
    }
    // Returning to the page asks for one frame and nothing else: no rebuild, no re-creation. A frame requested
    // while the host had stopped painting may never fire, and draw() would then decline every later frame
    // forever (a frozen picture over working panels), so the pending ids are dropped first.
    document.addEventListener('visibilitychange',function(){if(document.hidden)return;window.cancelAnimationFrame(self.frameId);self.frameId=null;self.cancelHover();self.cancelOrbit();self.draw();self.resumeOrbit();});
    window.addEventListener('resize', function(){self.resize();});
    // The cached rect follows a scrolled page: scroll events do not bubble, so they are caught in the capture phase.
    window.addEventListener('scroll',function(){if(self.viewRect)self.viewRect=self.container.getBoundingClientRect();},true);
    if(window.ResizeObserver){this.resizeObserver=new ResizeObserver(function(){self.resize();});this.resizeObserver.observe(container);}
    this.resize();
  }
  // Lens shift: frameCenter.x is the vehicle's middle above the orbit centre as (zoom-1 NDC x metres), so its
  // on-screen position at the current distance is x/distance*zoom; frameCenter.y is where that middle must sit
  // (NDC). Scaling the whole shift by the zoom, as before 0.7.6, drove the model up the screen under Auto frame:
  // the zoom grows with the distance there while the screen-anchored part must not (user, 18.09).
  Viewer.prototype.projection=function(){var w=this.viewWidth||1,h=this.viewHeight||1,z=this.camera.zoom,mid=this.frameCenter.x/Math.max(.001,this.distance);this.camera.setViewOffset(w,h,0,-(mid*z-this.frameCenter.y)*h/2,w,h);};
  // The only place that reads the container's layout: clientWidth/Height and getBoundingClientRect() force a
  // style recalculation, which used to happen several times per frame in paint(), the reticles and every hover.
  Viewer.prototype.resize=function(){var w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));this.viewWidth=w;this.viewHeight=h;this.viewRect=this.container.getBoundingClientRect();this.renderer.setSize(w,h,false);this.projection();this.render();};
  // A restored context: three rebuilds its own property cache and re-uploads textures, geometries and render
  // targets by itself. The composition is not kept: it asked the driver once, in its constructor, for the float
  // colour buffers and the texture units it needs, and a restored context need not grant them again - a kept
  // instance would fail its framebuffer check and leave a flat grey model behind. A fresh Surface is built by
  // the next paint(), with its own checks and its own reason to show when the driver has changed its mind.
  Viewer.prototype.restoreContext=function(){
    this.contextLost=false;this.paintedKey=null;this.inspectKey=null;
    if(this.surface){try{this.surface.dispose();}catch(e){this.surfaceError=e.message;}this.surface=null;}
    this.surfaceAttempted=false;
    this.resize();this.draw();this.resumeOrbit();
    window.dispatchEvent(new Event('armor-context-restored'));
  };
  // Coalesce input and color updates into one draw at the next browser frame.
  Viewer.prototype.draw=function(){if(this.contextLost||this.frameId!==null)return;var self=this;this.frameAt=clock();this.frameId=window.requestAnimationFrame(function(){try{self.countFrame();if(self.turretPending&&(!self.poseLive()||!self.previewPose()))self.applyTurret();if(self.fitPending){self.fitPending=false;self.resize();self.fit();}if(self.paintMesh)self.paint();self.renderer.render(self.scene,self.camera);self.updateReticles();}finally{self.frameId=null;}});};
  // The real cadence of the frames that ran, for the status line: the game's browser pumps its own BeginFrames
  // and the figure there is neither 60 nor the desktop browser's rate.
  Viewer.prototype.countFrame=function(){var ring=this.frameTimes;ring.push(clock());if(ring.length>FRAME_SAMPLES)ring.shift();};
  Viewer.prototype.frameRate=function(){
    var now=clock(),ring=this.frameTimes,first=0,i;
    for(i=0;i<ring.length;i++){if(now-ring[i]<=FRAME_WINDOW)break;first=i+1;}
    var count=ring.length-first;if(count<10)return null;
    var span=ring[ring.length-1]-ring[first];if(!(span>0))return null;
    var ms=span/(count-1);return {fps:1000/ms,ms:ms};
  };
  // A frame that was asked for and never fired blocks every later draw(), because draw() declines while one is
  // pending. The page's own poll calls this; a frame long overdue is dropped and asked for again.
  Viewer.prototype.kick=function(){if(this.contextLost||this.frameId===null)return;if(clock()-this.frameAt<FRAME_STALL)return;window.cancelAnimationFrame(this.frameId);this.frameId=null;this.draw();};
  Viewer.prototype.render=function(){var c=Math.cos(this.pitch);this.camera.position.set(this.target.x+this.distance*c*Math.sin(this.yaw),this.target.y+this.distance*Math.sin(this.pitch),this.target.z+this.distance*c*Math.cos(this.yaw));this.camera.near=Math.max(.05,this.distance*.02);this.camera.far=this.distance*4+200;this.projection();this.camera.lookAt(this.target);this.camera.updateMatrixWorld();if(this.pan.x||this.pan.y){var m=this.camera.matrixWorld,off=new THREE.Vector3().setFromMatrixColumn(m,0).multiplyScalar(this.pan.x).add(new THREE.Vector3().setFromMatrixColumn(m,1).multiplyScalar(this.pan.y));this.camera.position.add(off);this.camera.updateMatrixWorld();}if(this.autoFrame)this.autoFit();this.draw();if(this.onCamera)this.onCamera({distance:this.distance,zoom:this.camera.zoom,yaw:this.yaw,pitch:this.pitch});};
  // The camera angles are a target the view eases towards in its own frame loop, so a rotation is time-based
  // instead of event-based: the game's browser delivers pointer events in bursts between its own frames, and
  // turning the model straight from the events made every burst a jump. setOrbit places the camera at once
  // (a load, a reset, a restored state); orbitTo asks for it and lets the loop get there.
  Viewer.prototype.setOrbit=function(yaw,pitch){this.cancelOrbit();this.yaw=this.targetYaw=yaw;this.pitch=this.targetPitch=pitch;};
  Viewer.prototype.orbitTo=function(yaw,pitch){this.targetYaw=yaw;this.targetPitch=Math.max(-1.35,Math.min(1.35,pitch));this.startOrbit();};
  // The wheel sets a target distance / frame scale / zoom; the frame loop eases towards it in log space, so a
  // burst of wheel ticks becomes one smooth glide instead of a staircase (user, 18.09). Programmatic setters
  // (setDistance, setZoom, setScale, fit, reset, focus, restoreCamera, clear) drop any pending target.
  Viewer.prototype.distanceTo=function(value){if(!Number.isFinite(value))return;this.targetDistance=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,value));this.startOrbit();};
  Viewer.prototype.scaleTo=function(value){if(!Number.isFinite(value))return;this.targetScale=Math.max(.1,Math.min(10,value));this.startOrbit();};
  Viewer.prototype.zoomTo=function(value){if(!Number.isFinite(value)||value<=0)return;this.targetZoom=Math.max(.1,Math.min(150,value));this.startOrbit();};
  Viewer.prototype.dropTargets=function(){this.targetDistance=null;this.targetScale=null;this.targetZoom=null;};
  Viewer.prototype.cancelOrbit=function(){if(this.orbitId!==null)window.cancelAnimationFrame(this.orbitId);this.orbitId=null;};
  // After a hidden page or a lost context the easing loop is started again for whatever it had not reached: the
  // angles, and a wheel glide of the distance, frame scale or zoom - one cut short used to stay half way, and the
  // page (which waits for the end of a glide before it redoes its panels) with it.
  Viewer.prototype.resumeOrbit=function(){if(this.yaw!==this.targetYaw||this.pitch!==this.targetPitch||this.targetDistance!==null||this.targetScale!==null||this.targetZoom!==null)this.startOrbit();};
  // One easing step and one accumulated pan per browser frame. The factor follows the frame time, so the same
  // gesture takes the same wall-clock time at 47 frames/s in the game and at 130 in a desktop browser.
  Viewer.prototype.startOrbit=function(){
    if(this.orbitId!==null||this.contextLost)return;var self=this,last=null;
    var step=function(time){
      self.orbitId=null;
      var stamp=typeof time==='number'?time:clock(),dt=last===null?16.7:Math.max(1,Math.min(100,stamp-last));last=stamp;
      var k=1-Math.pow(1-.35,dt/16.7);
      self.yaw+=(self.targetYaw-self.yaw)*k;self.pitch+=(self.targetPitch-self.pitch)*k;
      var moving=false,l;
      if(self.targetDistance!==null){l=Math.log(self.targetDistance/self.distance);if(Math.abs(l)<1e-4){self.distance=self.targetDistance;self.targetDistance=null;}else{self.distance*=Math.exp(l*k);moving=true;}}
      if(self.targetScale!==null){l=Math.log(self.targetScale/self.frameScale);if(Math.abs(l)<1e-4){self.frameScale=self.targetScale;self.targetScale=null;}else{self.frameScale*=Math.exp(l*k);moving=true;}}
      if(self.targetZoom!==null){l=Math.log(self.targetZoom/self.camera.zoom);if(Math.abs(l)<1e-4){self.camera.zoom=self.targetZoom;self.targetZoom=null;}else{self.camera.zoom*=Math.exp(l*k);moving=true;}}
      var done=Math.abs(self.targetYaw-self.yaw)<1e-4&&Math.abs(self.targetPitch-self.pitch)<1e-4&&!moving;
      if(done){self.yaw=self.targetYaw;self.pitch=self.targetPitch;}
      var pan=self.pendingPan;self.pendingPan=null;
      if(pan)self.panBy(pan.x,pan.y);else self.render(); // panBy renders itself
      if(!done||self.pendingPan)self.orbitId=window.requestAnimationFrame(step);
      else self.settleAim(); // the camera is at rest: the held aim finds the middle again, unless a drag goes on
    };
    this.orbitId=window.requestAnimationFrame(step);
  };
  Viewer.prototype.setZoom=function(value){if(!Number.isFinite(value)||value<=0)return;this.targetZoom=null;this.targetScale=null;this.camera.zoom=Math.max(.1,Math.min(150,value));if(this.autoFrame)this.frameScale=this.camera.zoom/Math.max(.1,this.fitZoom);this.projection();this.draw();if(this.onCamera)this.onCamera({distance:this.distance,zoom:this.camera.zoom,yaw:this.yaw,pitch:this.pitch});};
  Viewer.prototype.setDistance=function(value){if(!Number.isFinite(value))return;this.targetDistance=null;this.distance=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,value));this.render();};
  Viewer.limits={distanceMin:DISTANCE_MIN,distanceMax:DISTANCE_MAX};
  Viewer.prototype.saveDefaults=function(){var frame=this.framing();this.defaults={distance:this.distance,scale:Math.max(.1,Math.min(10,this.camera.zoom/(frame?frame.zoom:this.fitZoom)))};try{window.localStorage.setItem('armor-camera-defaults',JSON.stringify(this.defaults));return true;}catch(ignore){return false;}};
  Viewer.prototype.clear=function(){this.dropTargets();this.clearLiveAim();this.fitPending=false;this.shotPoints=null;this.recordedDistance=null;this.pinned=null;this.disposePin();this.pinCache=null;this.pinReticles=[];if(this.surface)this.surface.dispose();this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.gunAngle=0;this.savedAim=null;this.aimGroup=null;this.reticles=[];this.reticleLayer.replaceChildren();clearTimeout(this.turretTimer);this.turretTimer=null;this.turretPending=false;this.poseGeometries=null;this.poseBuilt=null;this.poseStale=false;this.spreadAim=null;this.hideSpread();clearTimeout(this.paintTimer);this.paintTimer=null;window.clearTimeout(this.aimSettleTimer);this.aimSettleTimer=null;window.cancelAnimationFrame(this.frameId);this.frameId=null;this.cancelHover();this.cancelOrbit();this.pendingPan=null;this.inspectKey=null;this.paintMesh=null;this.outline=null;this.outlineDepth=null;this.engine=null;this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.loadedData=null;this.paintedKey=null;this.samples=[];var disposed=new Set();this.root.traverse(function(o){var shared=!!(o.parent&&o.parent.type==='ArrowHelper'&&(o===o.parent.line||o===o.parent.cone));if(o.geometry&&!shared&&!disposed.has(o.geometry)){disposed.add(o.geometry);o.geometry.dispose();}if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(function(m){m.dispose();});}});while(this.root.children.length)this.root.remove(this.root.children[0]);this.materials=[];this.point=null;this.travel=null;this.render();};
  Viewer.prototype.rebuild=function(){
    if(!this.loadedData)return;var T=THREE,self=this;this.samples=[];this.paintedKey=null;
    // A failed composition is retried on the next rebuild (pose or model) instead of staying off for good.
    if(!this.surface&&this.surfaceAttempted){this.surfaceAttempted=false;}
    this.engine=ArmorBallistics.build(this.posedData||this.loadedData,false);
    // Meshes serve picking, vehicle-parts display and neutral unavailable geometry.
    // The chance map is composed from GPU depth layers, without triangle sampling.
    this.samples=this.engine.triangles.filter(function(t){return !externalLayer(t);});
    this.updateTracks();
    if(this.surface){try{this.surface.update(this.engine);}catch(e){this.surface.dispose();this.surface=null;this.surfaceError=e.message;}}
    var positions=[],colors=[];this.samples.forEach(function(t){[t.a,t.b,t.c].forEach(function(v){positions.push(v[0],v[1],v[2]);colors.push(.25,.32,.38);});});
    var geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(positions,3));geom.setAttribute('color',new T.Float32BufferAttribute(colors,3).setUsage(T.DynamicDrawUsage));
    if(this.paintMesh){this.paintMesh.geometry.dispose();this.paintMesh.geometry=geom;}else{var mat=new T.MeshBasicMaterial({vertexColors:true,side:T.DoubleSide});this.materials.push(mat);this.paintMesh=new T.Mesh(geom,mat);this.root.add(this.paintMesh);}
    this.updateOutline();
    this.capturePose();
    this.render();
  };
  // The drawn pose, vertex by vertex, as the last full rebuild left it: a copy of every position and the runs of
  // vertices that belong to one collision part. previewPose() transforms those bases while a drag lasts, so the
  // drag never rebuilds the ballistic engine and never accumulates rounding either.
  Viewer.prototype.capturePose=function(){
    var records=[];
    function add(mesh,triangles){if(!mesh||!mesh.geometry)return;var attribute=mesh.geometry.getAttribute('position');if(!attribute)return;records.push({attribute:attribute,base:new Float32Array(attribute.array),runs:Viewer.partRuns(triangles)});}
    add(this.paintMesh,this.samples);
    add(this.trackMesh,this.trackTriangles); // the depth twin shares this geometry
    add(this.outline,(this.engine||{}).triangles||[]);
    add(this.outlineDepth,this.samples);
    this.poseGeometries=records;this.poseStale=false;
  };
  // Runs of vertices with one part id. build() walks the parts in order, so a part's triangles are contiguous;
  // the run list is built by comparison all the same and would simply be longer if that ever changed.
  Viewer.partRuns=function(triangles){
    var runs=[],last=null,i;
    for(i=0;i<triangles.length;i++){var part=triangles[i].part;if(last&&last.part===part)last.end=(i+1)*9;else{last={part:part,start:i*9,end:(i+1)*9};runs.push(last);}}
    return runs;
  };
  // One geometry posed in place: every run of a moved part is read from the base and written through the delta.
  Viewer.poseArray=function(record,delta){
    var array=record.attribute.array,base=record.base,touched=false;
    record.runs.forEach(function(run){
      var matrix=delta[run.part];if(!matrix)return;var e=matrix.elements,i;
      for(i=run.start;i<run.end;i+=3){
        var x=base[i],y=base[i+1],z=base[i+2];
        array[i]=e[0]*x+e[4]*y+e[8]*z+e[12];array[i+1]=e[1]*x+e[5]*y+e[9]*z+e[13];array[i+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
      }
      touched=true;
    });
    if(touched)record.attribute.needsUpdate=true;
    return touched;
  };
  Viewer.prototype.updateTracks=function(){
    var T=THREE,positions=[],colors=[];
    this.trackTriangles=this.engine.triangles.filter(function(t){return externalLayer(t)&&(!t.armor||t.armor.armor!==0);});
    this.trackTriangles.forEach(function(t){[t.a,t.b,t.c].forEach(function(p){positions.push(p[0],p[1],p[2]);colors.push(1,1,1,1);});});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new T.Float32BufferAttribute(colors,4).setUsage(T.DynamicDrawUsage));
    if(!this.trackGroup){
      // First keep only the closest visible external layer depth. Equal-depth blending
      // then applies one tint, rather than accumulating all overlapping faces.
      var depth=new T.Mesh(geometry,new T.MeshBasicMaterial({colorWrite:false,transparent:true,depthWrite:true,depthTest:true,side:T.DoubleSide,stencilWrite:true,stencilRef:1,stencilFunc:T.AlwaysStencilFunc,stencilZPass:T.ReplaceStencilOp}));depth.renderOrder=1;
      var material=new T.MeshBasicMaterial({vertexColors:true,transparent:true,depthWrite:false,depthTest:true,depthFunc:T.EqualDepth,side:T.DoubleSide,stencilWrite:true,stencilRef:1,stencilFunc:T.EqualStencilFunc,stencilZPass:T.ZeroStencilOp});material.forceSinglePass=true;
      this.trackMesh=new T.Mesh(geometry,material);this.trackMesh.renderOrder=2;
      this.trackGroup=new T.Group();this.trackGroup.add(depth,this.trackMesh);this.root.add(this.trackGroup);
    }else{this.trackMesh.geometry.dispose();this.trackGroup.children.forEach(function(mesh){mesh.geometry=geometry;});}
    this.trackGroup.visible=true;this.trackKey=null;this.updateTrackAppearance(); // a new buffer is always filled
  };
  // The colours depend on the map switch and the track opacity alone - not on the shell or the distance - so a
  // buffer already filled for both is left as it is (configure() runs on every shell or distance change).
  Viewer.prototype.updateTrackAppearance=function(){
    if(!this.trackMesh)return;var key=(this.heatmap?'map':'parts')+'|'+this.trackOpacity;if(this.trackKey===key)return;this.trackKey=key;
    var self=this,attribute=this.trackMesh.geometry.attributes.color,buffer=attribute.array;
    this.trackTriangles.forEach(function(t,i){
      var opacity=self.heatmap?self.trackOpacity:1;
      var color=self.heatmap?baseColors[0]:baseColors[t.part%4];
      for(var j=0;j<3;j++){var offset=(i*3+j)*4;for(var k=0;k<3;k++)buffer[offset+k]=color[k];buffer[offset+3]=opacity;}
    });
    attribute.needsUpdate=true;
  };
  // Outline: the collision triangles as lines over the opaque model. A colour-less depth pass of the main
  // armour hides the far side in every mode, including the screen-space composition. Screens and tracks are
  // left out of that pass, and the lines are drawn before the screens' own depth pass (renderOrder 1, in the
  // transparent list like the lines): the wireframe stays visible through a translucent screen, tinted by
  // it, and hidden only by the hull.
  Viewer.prototype.updateOutline=function(){
    var T=THREE,positions=[],solid=[],push=function(list,t){list.push(t.a[0],t.a[1],t.a[2],t.b[0],t.b[1],t.b[2],t.c[0],t.c[1],t.c[2]);};
    this.engine.triangles.forEach(function(t){push(positions,t);});this.samples.forEach(function(t){push(solid,t);});
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    var depthGeometry=new T.BufferGeometry();depthGeometry.setAttribute('position',new T.Float32BufferAttribute(solid,3));
    if(!this.outline){
      this.outlineDepth=new T.Mesh(depthGeometry,new T.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:T.DoubleSide}));this.outlineDepth.renderOrder=.4;
      this.outline=new T.Mesh(geometry,new T.MeshBasicMaterial({wireframe:true,transparent:true,depthWrite:false,depthTest:true,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));this.outline.renderOrder=.5;
      this.root.add(this.outlineDepth,this.outline);
    }else{this.outline.geometry.dispose();this.outlineDepth.geometry.dispose();this.outline.geometry=geometry;this.outlineDepth.geometry=depthGeometry;}
    this.applyOutline();
  };
  Viewer.prototype.applyOutline=function(){if(!this.outline)return;var b=this.outlineStyle.brightness;this.outline.material.color.setRGB(b,b,b);this.outline.material.opacity=this.outlineStyle.opacity;this.outline.visible=this.showOutline;this.outlineDepth.visible=this.showOutline;};
  Viewer.prototype.setOutline=function(brightness,opacity){this.outlineStyle={brightness:Math.max(0,Math.min(1,brightness)),opacity:Math.max(.05,Math.min(1,opacity))};this.applyOutline();this.draw();};
  Viewer.prototype.setQuality=function(value){this.quality=value;if(!this.surface)this.surfaceAttempted=false;this.draw();};
  Viewer.prototype.setBounceMode=function(value){this.bounceMode=value==='idle'?'idle':'always';this.draw();};
  // Soft lighting: the one Settings checkbox. A smoothed visual normal per vertex lights the main armour in
  // one extra pass, so a rounded turret reads as rounded instead of as a field of triangles, while the plate
  // joints stay sharp. It changes brightness and nothing else - the palette, the numbers, the zones, the
  // material choice and the ricochet law are untouched, and the composition never lights the screens, the
  // tracks, the wireframe, the seams or the background.
  // The contract for the page: setLighting(boolean), default off; `viewer.lighting` reads back exactly what
  // was last asked for, so a stored setting can be written from it, and off is the previous picture with no
  // extra pass, buffer or attribute. Whether the driver actually granted it is reported in the backend line,
  // not here - a device that declines must not silently rewrite the user's setting.
  Viewer.prototype.setLighting=function(value){
    this.lighting=!!value;
    // The visual normals are built from the geometry of the last full rebuild, so a pose that is only drawn
    // is committed first; otherwise the light would follow the pre-drag turret until the drag settled.
    this.commitPose();
    if(this.surface&&this.surface.setLighting){try{this.surface.setLighting(this.lighting);}catch(e){this.surfaceError=e.message;console.warn('Soft lighting unavailable:',e.message);}}
    this.draw();
  };
  // Ricochet dots over the zones where the bounced shell still penetrates: on/off and their spacing in CSS px.
  Viewer.prototype.setDots=function(enabled,spacing){this.dots=!!enabled;if(spacing!==undefined)this.dotSpacing=Math.max(2,Math.min(40,Number(spacing)||5));this.draw();};
  Viewer.prototype.setPartEdges=function(value){this.partEdges=!!value;this.draw();};
  Viewer.prototype.setZoneOutline=function(value){this.zoneOutline=!!value;this.draw();}
  // Blue tint of every ricochet colour, 0 (off) .. 1.5; the Ricochet tint row of Settings.
  Viewer.prototype.setTint=function(value){var v=Number(value);this.tint=Math.max(0,Math.min(1.5,isFinite(v)?v:.5));this.draw();};
  Viewer.prototype.pointerRay=function(event){var rect=this.viewRect||this.container.getBoundingClientRect(),mouse=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),caster=new THREE.Raycaster();this.camera.updateMatrixWorld();caster.setFromCamera(mouse,this.camera);return caster;};
  Viewer.prototype.pickPart=function(event){if(event.shiftKey||!this.paintMesh)return 1;var objects=[this.paintMesh];if(this.trackGroup)objects.push(this.trackMesh);var hits=this.pointerRay(event).intersectObjects(objects);if(!hits.length)return false;var sample=(hits[0].object===this.trackMesh?this.trackTriangles:this.samples)[hits[0].faceIndex];return sample?sample.part:1;};
  // The pose moves in two quiet steps - turretTo() and gunTo() only clamp and store - and every caller sends ONE
  // notification for the whole change once both are in (onTurret, or onGun when only the gun moved). A drag step
  // used to notify two or three times, each a full pass of the page's pose handler, the first of them with a gun
  // angle not yet clamped against the new turret angle.
  Viewer.prototype.turretTo=function(degrees){
    var hit=this.loadedData.hit,limits=(hit.target||{}).turretYawLimits,initial=(hit.aim||[])[0],lo=-180,hi=180;
    if(Array.isArray(limits)&&limits.length===2&&Number.isFinite(initial)){lo=Math.max(-180,(limits[0]-initial)*180/Math.PI);hi=Math.min(180,(limits[1]-initial)*180/Math.PI);}
    var limited=Array.isArray(limits)&&limits.length===2&&Number.isFinite(initial);
    this.turretAngle=limited?Math.max(lo,Math.min(hi,degrees)):((degrees+180)%360+360)%360-180;
    this.gunTo(this.gunAngle); // the gun's range follows the turret angle
    return {angle:this.turretAngle,min:lo,max:hi,limited:limited};
  };
  Viewer.prototype.setTurret=function(degrees){
    if(!this.loadedData)return;var state=this.turretTo(degrees);this.markPose();if(this.onTurret)this.onTurret(state);
  };
  // The pose the viewer holds is a delta from the recorded one, so gunRange() reports the vertical limits in
  // that same delta - setGun() clamps against them. gunRangeAbsolute() is the very same interpolation with the
  // recorded pitch left in: the gun's own range at this turret angle, which is what the scene tile prints.
  // Both are the one function, so a change to the sample lookup cannot drift between them.
  Viewer.prototype.gunSpan=function(absolute){
    var hit=this.loadedData&&this.loadedData.hit,info=hit&&(hit.target||{}).gunPitchLimits,initial=hit&&(hit.aim||[])[1];
    if(!info||!Array.isArray(info.samples)||!Number.isFinite(initial))return {min:-45,max:45,known:false};
    var yaw=((hit.aim||[])[0]||0)+this.turretAngle*Math.PI/180;yaw=Math.atan2(Math.sin(yaw),Math.cos(yaw));var rows=info.samples,a=rows[0],b=rows[rows.length-1];
    for(var i=1;i<rows.length;i++)if(rows[i][0]>=yaw){a=rows[i-1];b=rows[i];break;}
    var f=Math.max(0,Math.min(1,(yaw-a[0])/Math.max(1e-9,b[0]-a[0]))),base=absolute?0:initial;
    return {min:(a[1]+(b[1]-a[1])*f-base)*180/Math.PI,max:(a[2]+(b[2]-a[2])*f-base)*180/Math.PI,known:true};
  };
  Viewer.prototype.gunRange=function(){return this.gunSpan(false);};
  Viewer.prototype.gunRangeAbsolute=function(){return this.gunSpan(true);};
  Viewer.prototype.gunTo=function(degrees){var limits=this.gunRange();this.gunAngle=Math.max(limits.min,Math.min(limits.max,degrees));return {angle:this.gunAngle,known:limits.known};};
  Viewer.prototype.setGun=function(degrees){if(!this.loadedData)return;var state=this.gunTo(degrees);this.markPose();if(this.onGun)this.onGun(state);};
  Viewer.prototype.resetPose=function(){this.turretAngle=0;this.gunAngle=0;this.setTurret(0);};
  // A pose change asks for a frame and starts the settle timer: while the drag lasts the frame only re-transforms
  // the drawn geometry, and POSE_SETTLE ms after the last change (or at the end of the drag) everything else
  // catches up in one full rebuild.
  Viewer.prototype.markPose=function(){
    var self=this;this.turretPending=true;this.poseAt=clock();
    clearTimeout(this.turretTimer);this.turretTimer=window.setTimeout(function(){self.turretTimer=null;self.commitPose();},POSE_SETTLE);
    this.draw();
  };
  Viewer.prototype.poseLive=function(){return !!this.poseGeometries&&(this.dragging||clock()-this.poseAt<POSE_SETTLE);};
  // The extra matrix the current turret and gun angles put in front of a part's own transform: the turret turns
  // about the hull's vertical axis through the turret's origin, the gun pitches about its own axis afterwards.
  Viewer.prototype.poseExtra=function(){
    if(!this.loadedData)return null;var T=THREE,source=this.loadedData,parts=source.hit.target.parts,turret=parts.find(function(p){return p.id===2;}),hull=parts.find(function(p){return p.id===1;});if(!turret||!turret.transform)return null;
    var pivot=new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(turret.transform)),axis=new T.Vector3(0,1,0);if(hull&&hull.transform)axis.transformDirection(new T.Matrix4().fromArray(hull.transform));
    var rotation=new T.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z).multiply(new T.Matrix4().makeRotationAxis(axis,this.turretAngle*Math.PI/180)).multiply(new T.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
    var gun=parts.find(function(p){return p.id===3;}),gunRotation=null;
    if(gun&&gun.transform){var g=new T.Matrix4().fromArray(gun.transform).premultiply(rotation),gp=new T.Vector3().setFromMatrixPosition(g),ga=new T.Vector3(1,0,0).transformDirection(g);var info=source.hit.target.gunPitchLimits,yaw0=(source.hit.aim||[])[0]||0,yaw=yaw0+this.turretAngle*Math.PI/180;var correction=function(y){y=Math.atan2(Math.sin(y),Math.cos(y));return info?info.hullTurretPitch*(1-2*Math.abs(y)/Math.PI)+info.gunJointPitch:0;};var delta=this.gunAngle*Math.PI/180+correction(yaw0)-correction(yaw);gunRotation=new T.Matrix4().makeTranslation(gp.x,gp.y,gp.z).multiply(new T.Matrix4().makeRotationAxis(ga,delta)).multiply(new T.Matrix4().makeTranslation(-gp.x,-gp.y,-gp.z));}
    return {2:rotation,3:gunRotation?gunRotation.clone().multiply(rotation):rotation};
  };
  Viewer.prototype.applyTurret=function(){
    this.turretPending=false;this.poseStale=false;clearTimeout(this.turretTimer);this.turretTimer=null;
    if(!this.loadedData)return;var T=THREE,source=this.loadedData,parts=source.hit.target.parts,extra=this.poseExtra();if(!extra)return;
    var changed=parts.map(function(p){var copy=Object.assign({},p),m=extra[p.id];if(m&&p.transform)copy.transform=m.clone().multiply(new T.Matrix4().fromArray(p.transform)).toArray();return copy;});
    this.posedData={hit:Object.assign({},source.hit,{target:Object.assign({},source.hit.target,{parts:changed})}),models:source.models};
    this.poseBuilt=extra;
    this.syncRecorded();this.rebuild();
    // The pinned line is fixed in the world; the posed vehicle under it gives a new contact and a new result.
    if(this.pinned){this.refreshPin();if(this.onPin)this.onPin(true);}
  };
  // A pose while the drag lasts: only what is needed to draw the model is redone. The paint, track and outline
  // geometries and the composition's peel geometry are re-transformed from the base of the last full rebuild;
  // ArmorBallistics.build with its kd-tree, the GPU BVH and the pinned line are not. Everything read from the
  // engine during the drag - the hover panel, the pinned line, the shot chance - therefore still answers for
  // the pose of the last full rebuild, and catches up when commitPose() runs at the end of the drag.
  Viewer.prototype.previewPose=function(){
    if(!this.poseGeometries||!this.poseGeometries.length)return false;
    var T=THREE,extra=this.poseExtra();if(!extra)return false;
    var mirror=new T.Matrix4().makeScale(1,1,-1),built=this.poseBuilt,delta={};
    // The engine mirrors z when it transforms a part's vertices, so a model-space pose matrix M is F·M·F on screen.
    [2,3].forEach(function(id){
      var matrix=new T.Matrix4().copy(extra[id]);
      if(built&&built[id])matrix.multiply(new T.Matrix4().copy(built[id]).invert());
      delta[id]=new T.Matrix4().copy(mirror).multiply(matrix).multiply(mirror);
    });
    this.poseGeometries.forEach(function(record){Viewer.poseArray(record,delta);});
    if(this.surface&&this.surface.pose)this.surface.pose(delta);
    this.turretPending=false;this.poseStale=true;this.syncRecorded();
    return true;
  };
  // The drawn pose and everything derived from it back in step, once per drag instead of once per frame.
  // The page relies on this for its figures: while a drag lasts its pose handler only updates the pose tile, and
  // the shot figure of the committed pose reaches it through applyTurret -> rebuild -> render -> onCamera (a new
  // engine; with a pinned line also through onPin). Nothing is sent from here.
  Viewer.prototype.commitPose=function(){
    clearTimeout(this.turretTimer);this.turretTimer=null;
    if(!this.turretPending&&!this.poseStale)return;
    this.applyTurret();
  };
  Viewer.prototype.load=function(data,context){
    this.clear();if(data.geometryIncomplete){this.bounds=null;this.render();return false;}var T=THREE,self=this;var hit=data.hit, parts=(hit.target||{}).parts||[], transforms={};
    parts.forEach(function(part){if(part.transform)transforms[part.id]=new T.Matrix4().fromArray(part.transform);});
    var range=context&&context.range;this.recordedDistance=Number.isFinite(range)&&range>0?range:Number.isFinite(hit.rangeAtImpact)&&hit.rangeAtImpact>0?hit.rangeAtImpact:null;
    this.loadedData=data;this.posedData=null;this.poseBuilt=null;this.turretAngle=0;this.gunAngle=0;this.rebuild();if(this.onTurret)this.onTurret({angle:0,min:-180,max:180});
    this.root.updateMatrixWorld(true);
    var box=new T.Box3().setFromObject(this.root);this.bounds=box.isEmpty()?null:box;this.centre=this.vehicleCentre();
    var pts=Viewer.points(hit);pts.forEach(function(p){self.addReticle(p.pos);});
    this.shotPoints=pts;this.drawTracers(pts);if(pts.length){this.point=pts[0].pos.clone();this.travel=pts[0].line.clone();}
    // The tracers and marks of this hit have just been added to the root: with the aim emulation running
    // they must not be on screen at all, so the recorded rule is applied to them here and not only when
    // the pose or the pin changes.
    this.syncRecorded();
    if(this.bounds)this.grid.position.y=this.bounds.min.y-.025;if(this.point)this.focus();else this.reset();if(this.onGun)this.onGun({angle:0,known:this.gunRange().known});return !!this.bounds;
  };
  Viewer.prototype.addReticle=function(position){
    var element=document.createElement('span');element.className='hit-reticle';element.hidden=true;
    element.innerHTML='<svg viewBox="0 0 96 96" role="img" aria-label="Hit location"><title>Hit location</title><path class="reticle-stroke" d="M48 3V34M48 62V93M3 48H34M62 48H93"/></svg>';
    this.reticleLayer.appendChild(element);this.reticles.push({position:position.clone(),element:element});
  };
  // How strongly the cross at an impact point is drawn (user, 20.09): from the shooter's seat the tracer is
  // a dot and a full-strength cross around it covers the armour it stands on. One custom property on the
  // layer, which every cross inherits - the ones already on screen and the ones added later - so nothing
  // else changes: not the tracer, not the rings, not the crosshair cursor.
  Viewer.prototype.setImpactOpacity=function(value){
    var v=Number(value);
    this.impactOpacity=isFinite(v)?Math.max(.1,Math.min(1,v)):.5;
    if(this.reticleLayer)this.reticleLayer.style.setProperty('--impact-opacity',String(this.impactOpacity));
  };
  // Reticle size follows the vehicle on screen (a fifth of its projected diameter), never below 80 px nor above 300 px.
  Viewer.prototype.reticleSize=function(){
    if(!this.bounds)return 120;var sphere=this.bounds.getBoundingSphere(new THREE.Sphere()),depth=Math.max(1,this.camera.position.distanceTo(sphere.center));
    var perMetre=(this.viewHeight||1)/(2*depth*Math.tan(this.camera.fov*Math.PI/360))*this.camera.zoom;
    return Math.round(Math.max(80,Math.min(300,2*sphere.radius*perMetre*.2)));
  };
  Viewer.prototype.updateReticles=function(){
    var self=this,w=this.viewWidth,h=this.viewHeight,size=this.reticleSize()+'px';
    this.reticles.forEach(function(marker){var behind=marker.position.clone().applyMatrix4(self.camera.matrixWorldInverse).z>-.01,p=marker.position.clone().project(self.camera);marker.element.hidden=(!marker.pinned&&!self.recordedShown())||behind||Math.abs(p.x)>1||Math.abs(p.y)>1;if(!marker.element.hidden){var s=marker.element.style;s.left=(p.x+1)*w/2+'px';s.top=(1-p.y)*h/2+'px';if(s.width!==size){s.width=size;s.height=size;}}});
    this.updateAimMarker();   // the crosshair of an aim held on the model follows the camera the same way
  };
  // Fit the actual projected mesh, including off-centre impacts. Only the lens
  // changes: the camera remains on the recorded shot line at the chosen distance.
  // Frame by the bounding sphere seen from the current distance: the same zoom from every angle, so
  // orbiting never pulses, while a distance change is compensated in the same frame.
  Viewer.prototype.framing=function(){
    if(!this.bounds)return null;var camera=this.camera,sphere=this.bounds.getBoundingSphere(new THREE.Sphere()),radius=Math.max(.5,sphere.radius*.7);
    var distance=Math.max(radius*1.05,camera.position.distanceTo(this.target)),tangent=Math.tan(camera.fov*Math.PI/360);
    var vertical=2*radius/(distance*tangent),horizontal=vertical/Math.max(.1,camera.aspect);
    return {center:new THREE.Vector2(0,0),zoom:Math.max(.1,Math.min(150,1.72/Math.max(horizontal,vertical,.001)))};
  };
  Viewer.prototype.autoFit=function(){var frame=this.framing();if(!frame)return;this.fitZoom=frame.zoom;this.camera.zoom=Math.max(.1,Math.min(150,this.fitZoom*this.frameScale));this.projection();};
  // Fit: the orbit centre stays in the middle of the screen (a shifted rotation centre feels wrong — user, 13.09)
  // and the camera stays where it is, so Fit only picks the zoom. Two boxes are projected at zoom 1: the main
  // armour (materials with vehicleDamageFactor > 0: hull, turret, an oscillating turret's upper half) and everything
  // (tracks, gun barrel, screens, surveying devices). The main box gets the FIT_MARGIN; the whole model merely has to
  // stay on screen — a barrel or a screen that already pushed the zoom out earns no extra margin. The top
  // FIT_TOP_BAND of the viewport is kept free for the "Under the cursor" panel and the model tile, FIT_BOTTOM_BAND
  // at the foot for the shooter tile. The two bands are equal since 19.09 (user): a top band of .35 pushed the
  // middle of the armour 11.5 % of the height below the screen centre, and the tank looked dropped every time
  // Fit ran and on the first render of a hit. Equal bands leave centreY at 0, so the middle lands mid-screen
  // exactly as it does when the pivot is switched; the top-left tiles may now cover the upper corner of a wide
  // vehicle. A clinch record (5 m) first backs off along the view line to twice the model's radius about the
  // orbit centre.
  var FIT_TOP_BAND=.12,FIT_BOTTOM_BAND=.12,FIT_MARGIN=.08;
  Viewer.prototype.fit=function(){this.dropTargets();
    var tris=(this.engine||{}).triangles||[];if(!tris.length)return;var cam=this.camera,v=new THREE.Vector3(),local=new THREE.Vector3(),radius=0,i,k,t;
    for(i=0;i<tris.length;i++){t=tris[i];for(k=0;k<3;k++)radius=Math.max(radius,v.fromArray(k===0?t.a:k===1?t.b:t.c).distanceTo(this.target));}
    var minDistance=Math.min(DISTANCE_MAX,radius*2+1);if(this.distance<minDistance){this.distance=minDistance;this.render();}
    cam.zoom=1;this.frameCenter.set(0,0);this.projection();cam.updateMatrixWorld();
    var all=[Infinity,-Infinity,Infinity,-Infinity],main=[Infinity,-Infinity,Infinity,-Infinity];
    function grow(box,x,y){if(x<box[0])box[0]=x;if(x>box[1])box[1]=x;if(y<box[2])box[2]=y;if(y>box[3])box[3]=y;}
    for(i=0;i<tris.length;i++){t=tris[i];var isMain=!!(t.armor&&t.armor.vehicleDamageFactor>0);
      for(k=0;k<3;k++){v.fromArray(k===0?t.a:k===1?t.b:t.c);local.copy(v).applyMatrix4(cam.matrixWorldInverse);if(local.z>-.5)continue;v.project(cam);grow(all,v.x,v.y);if(isMain)grow(main,v.x,v.y);}}
    if(all[0]===Infinity)return;if(main[0]===Infinity)main=all;
    // Horizontally the orbit centre stays on the screen's vertical axis. Vertically the view is shifted so that the
    // middle of the main armour's height sits mid-way in the usable band (user, 13.09): the orbit centre then lands
    // above or below the screen centre by however much it is above or below the vehicle's middle, and the tank sits
    // between the tiles whatever height the centre was given. The shift is a lens shift: frameCenter.x keeps the
    // middle's zoom-1 NDC height times the distance (so it follows the model when the distance changes),
    // frameCenter.y the NDC height the middle must land on; projection() combines them at the current zoom.
    var top=1-2*FIT_TOP_BAND,bottom=1-2*FIT_BOTTOM_BAND,centreY=(top-bottom)/2,halfUsable=(top+bottom)/2,midY=(main[2]+main[3])/2;
    // Largest zoom at which a box stays inside the usable area with the given margin, measured from the pivot axis
    // horizontally and from the main armour's middle vertically.
    function limit(box,margin){var z=150,w=Math.max(-box[0],box[1]),h=Math.max(midY-box[2],box[3]-midY);if(w>0)z=Math.min(z,(1-margin)/w);if(h>0)z=Math.min(z,(halfUsable-margin)/h);return z;}
    var zoom=Math.max(.1,Math.min(150,Math.min(limit(main,FIT_MARGIN),limit(all,0))));
    this.frameCenter.set(midY*this.distance,centreY);
    var f=this.framing();this.frameScale=zoom/Math.max(.1,f?f.zoom:1);this.setZoom(zoom);
  };
  // Switching auto-frame on holds the size that is on screen right now: the scale is taken from a fresh framing.
  Viewer.prototype.setAutoFrame=function(value){this.dropTargets();this.autoFrame=!!value;if(this.autoFrame){var f=this.framing();if(f)this.frameScale=this.camera.zoom/Math.max(.1,f.zoom);}this.render();};
  Viewer.prototype.setScale=function(value){this.targetScale=null;this.frameScale=Math.max(.1,Math.min(10,value));if(this.autoFrame)this.render();else this.setZoom(this.fitZoom*this.frameScale);};
  Viewer.prototype.setTrackOpacity=function(value){this.trackOpacity=Math.max(.05,Math.min(.85,value));this.updateTrackAppearance();this.draw();};
  // Reset is the path for a hit without a point on the model (the shooter/model swap: an inspector
  // without a shot). A distance a loaded hit already chose is kept - jumping back to the default
  // distance on a swap would move the camera for no reason; only the first load starts from it.
  Viewer.prototype.reset=function(){this.dropTargets();this.pan.set(0,0);this.frameCenter.set(0,0);if(this.bounds){this.target.copy(this.pivotCentre());this.grid.position.y=this.bounds.min.y-.025;}if(!this.distanceSet)this.distance=this.defaults.distance;/* default view: the nose towards the viewer and to the right (user, 14.09). The models face -z here: checked by the barrel's extent, not by eye */this.setOrbit(.65+Math.PI/2,.25);this.fitPending=true;this.render();};
  // Orbit centre: over the hull's own box (the whole-model box includes the barrel and drifts to the bow),
  // at turret height — in a clinch the camera sits turret to turret, so approaching should tend there.
  Viewer.prototype.vehicleCentre=function(){var hull=new THREE.Box3(),turret=new THREE.Box3(),v=new THREE.Vector3();
    ((this.engine||{}).triangles||[]).forEach(function(t){var box=t.part===1?hull:t.part===2?turret:null;if(!box)return;box.expandByPoint(v.fromArray(t.a));box.expandByPoint(v.fromArray(t.b));box.expandByPoint(v.fromArray(t.c));});
    if(hull.isEmpty())return this.bounds?this.bounds.getCenter(new THREE.Vector3()):new THREE.Vector3();
    var centre=hull.getCenter(new THREE.Vector3());centre.y=turret.isEmpty()?hull.max.y:turret.getCenter(v).y;return centre;};
  // Pan in metres at the orbit-centre depth (screen-aligned). Re-selecting a centre clears it.
  Viewer.prototype.panBy=function(dx,dy){var mpp=2*this.distance*Math.tan(this.camera.fov*Math.PI/360)/(Math.max(1,this.viewHeight)*this.camera.zoom);this.pan.x-=dx*mpp;this.pan.y+=dy*mpp;this.render();};
  // Vehicle orbit centre: hull centre in plan, at the shooter's gun height when the record has it (a clinch on flat
  // ground looks the way it does in the game), otherwise at turret height.
  // Orbit-centre height: the shooter's gun axis above the ground (the model's y=0 is the chassis origin), when the
  // record carries the ground-based figure; older records (gun height without the hull's height on the chassis,
  // about a metre too low) fall back to the turret centre until the exporter has recomputed them.
  Viewer.prototype.pivotCentre=function(){var c=(this.centre||(this.bounds?this.bounds.getCenter(new THREE.Vector3()):new THREE.Vector3())).clone(),a=this.loadedData&&this.loadedData.hit.attacker;if(a&&a.gunHeightFrom==='ground'&&a.gunHeight>0)c.y=a.gunHeight;return c;};
  // Orbit centre. Switching it turns the view instead of moving the camera: the camera keeps its place (on the
  // shell's axis after focus) and only looks at the new centre. Clicking the active centre again returns to the
  // shooter's viewpoint.
  Viewer.prototype.setPivot=function(mode){var next=mode==='hit'&&this.point?'hit':'vehicle';this.pivotHeight=null;
    if(next===this.pivot){if(this.point)this.focus();else{this.pan.set(0,0);this.frameCenter.set(0,0);this.render();}return;}
    // The camera keeps its eye and turns to the new centre; then the same Fit a hit click ends with, so the
    // vehicle is framed the same way whichever point it orbits (user, 19.09: with the hit as centre the model
    // sat wherever the hit point put it).
    var eye=this.camera.position.clone();this.pivot=next;this.pan.set(0,0);this.frameCenter.set(0,0);this.target.copy(next==='hit'?this.point:this.pivotCentre());this.lookFrom(eye);this.fit();};
  // Place the camera at a world point without moving it: yaw, pitch and distance are read off the vector to the target.
  // Orbit-centre height set by hand (the Height slider): the centre moves straight up or down within the model's
  // height and the camera follows it, so the view slides along the vehicle — a pan for the in-game browser, where
  // the right button is unavailable. Cleared whenever the centre is chosen anew.
  Viewer.prototype.heightRange=function(){var b=this.bounds;return b?[b.min.y,b.max.y]:[0,4];};
  Viewer.prototype.setPivotHeight=function(y){if(!Number.isFinite(y))return;var r=this.heightRange();this.pivotHeight=Math.max(r[0],Math.min(r[1],y));this.target.y=this.pivotHeight;this.render();};
  Viewer.prototype.lookFrom=function(eye){var v=eye.clone().sub(this.target),len=v.length();if(len<1e-6)return;v.divideScalar(len);this.setOrbit(Math.atan2(v.x,v.z),Math.asin(Math.max(-1,Math.min(1,v.y))));this.distance=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,len));};
  // The recorded view: the camera stands on the shell's axis at the recorded range — where the shooter was — and
  // looks at the orbit centre. With the hit point as centre that is exactly the shell's line of flight; with the
  // vehicle centre the camera still stands on the axis and merely turns towards the hull (no parallel shift).
  Viewer.prototype.focus=function(){if(!this.point)return;this.dropTargets();this.pan.set(0,0);this.frameCenter.set(0,0);this.pivotHeight=null;
    var dir=this.travel.clone().negate().normalize(),range=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,this.recordedDistance||this.defaults.distance));
    var eye=this.point.clone().addScaledVector(dir,range);this.target.copy(this.pivot==='vehicle'?this.pivotCentre():this.point);this.lookFrom(eye);this.distanceSet=true;this.fitPending=true;this.render();};
  // The vehicle browser can change the shooter alone: the collision model on screen and the orbit centre
  // stay as they are, so the camera must not move either. load() always re-frames (reset() sets fitPending,
  // the next frame runs fit()), so the state is read before the reload and put back straight after it -
  // still inside the same task, before the pending animation frame fires, so no fit is ever seen.
  Viewer.prototype.cameraState=function(){return {yaw:this.yaw,pitch:this.pitch,distance:this.distance,zoom:this.camera.zoom,
    target:this.target.clone(),pan:this.pan.clone(),frameCenter:this.frameCenter.clone(),frameScale:this.frameScale,pivotHeight:this.pivotHeight};};
  Viewer.prototype.restoreCamera=function(state){
    if(!state)return;this.setOrbit(state.yaw,state.pitch);this.distance=state.distance;this.target.copy(state.target);
    this.dropTargets();this.pan.copy(state.pan);this.frameCenter.copy(state.frameCenter);this.frameScale=state.frameScale;this.pivotHeight=state.pivotHeight;
    this.fitPending=false;this.camera.zoom=Math.max(.1,Math.min(150,state.zoom));this.projection();this.render();};
  // 'mode' is the Display setting: 'chance' or 'damage' (expected damage per shot). Both colour the armour on
  // the same palette, so 'heatmap' stays the single "is the map on" flag.
  Viewer.prototype.configure=function(shell,heatmap,palette,mode){this.shell=shell;this.heatmap=heatmap;this.palette=palette;this.mapMode=mode==='damage'?'damage':'chance';this.inspectKey=null;if(this.pinned)this.refreshPin();this.updateTrackAppearance();this.render();};
  // A pinned point replaces the recorded hit line as the analysed shot until unpinned. It is drawn like a
  // recorded shot: an arrow along the line, a reticle at the point, and a dashed leg where a ricochet goes.
  Viewer.prototype.pinAt=function(event){
    if(!this.engine)return;var caster=this.pointerRay(event),objects=this.paintMesh?[this.paintMesh]:[];if(this.trackGroup)objects.push(this.trackMesh);
    var hits=caster.intersectObjects(objects);if(!hits.length)return;var hit=hits[0],normal=hit.face?hit.face.normal.clone().transformDirection(hit.object.matrixWorld):null;
    this.pinned={origin:caster.ray.origin.clone(),direction:caster.ray.direction.clone(),point:hit.point.clone(),normal:normal};
    // The recorded aim circles belong to the recorded shot line: a tracer pinned elsewhere is another shot, so
    // they leave with the recorded tracer and come back when the pin is dropped (user, 20.09).
    this.refreshPin(hit.point);this.showSavedAim(false);if(this.onPin)this.onPin(true); // the contact is the one just cast
  };
  // Tracer: a 2.3 m arrow ending at the hit point. A WebGL line is always one pixel wide, so the line is backed by a
  // thin cylinder (6 mm radius: a pixel or two at a Fit zoom, a visible dot end-on) — the user could barely find the
  // one-pixel tracer when looking along it. Brighter than the reticle, which is a large thin cross and reads fine.
  // Tracers as one chain through the recorded contact points (user, 14.09). The points are exact - the client
  // re-collides the server's segment with the model - while each point's own direction is the server's 8-byte
  // segment (start on a 1/255 grid of the part's box, end in 1 cm steps) and wanders by a degree or two, up to
  // ten. So a stretch between two points follows the chord, checked against both recorded directions; when the
  // chord disagrees with both by more than CHORD_TOLERANCE the suspect is the point (the client's nearest-point
  // fallback), and the stretch is drawn along the recorded direction, dashed. A ricochet (effect 1 or 2) ends a
  // chain: the next stretch leaves exactly from the ricochet point, dashed when it disagrees with the recorded
  // direction. The first tracer arrives from afar along the first stretch's direction. Single points: as before.
  var CHORD_TOLERANCE=5*Math.PI/180,ARROW_LENGTH=2.3,TRACER=0xa8dfff;
  // The resolved contact points of a hit in the viewer's frame (part transforms applied, z mirrored), as plain data.
  Viewer.points=function(hit){
    var T=THREE,transforms={};((hit&&hit.target||{}).parts||[]).forEach(function(part){if(part.transform)transforms[part.id]=new T.Matrix4().fromArray(part.transform);});
    var pts=[];((hit&&hit.points)||[]).forEach(function(p){if(p.status!=='resolved'||!transforms[p.part]||!p.position||!p.direction)return;var pos=new T.Vector3().fromArray(p.position).applyMatrix4(transforms[p.part]);pos.z*=-1;var direction=new T.Vector3().fromArray(p.direction).transformDirection(transforms[p.part]).normalize();direction.z*=-1;pts.push({pos:pos,dir:direction,effect:p.effect,part:p.part,source:'segment',chordDev:null,line:direction.clone(),stretch:null});});
    return Viewer.chain(pts);
  };
  // The chain rule, as data: every point gets `line` (the direction drawn through it), `source` (chord / segment /
  // chord-unchecked), `chordDev` (radians) and `stretch` ({from,to,dashed} or null for a first point).
  Viewer.chain=function(pts){
    var ricochet=function(q){return q.effect===1||q.effect===2;};
    for(var i=0;i<pts.length;i++){
      var p=pts[i],prev=i?pts[i-1]:null;p.line=p.dir.clone();p.stretch=null;
      if(!prev){
        var next=pts[1],chord0=next&&!ricochet(p)?next.pos.clone().sub(p.pos):null;
        if(chord0&&chord0.length()>=.05){var c0=chord0.normalize(),a0=c0.angleTo(p.dir),a1=c0.angleTo(next.dir);p.chordDev=Math.max(a0,a1);if(a0<=CHORD_TOLERANCE&&a1<=CHORD_TOLERANCE){p.line=c0;p.source='chord';}}
        continue;
      }
      var chord=p.pos.clone().sub(prev.pos),span=chord.length();
      if(span<.05)continue; // the same contact twice (a second verdict at one point): nothing between them
      var c=chord.normalize(),dev=c.angleTo(p.dir),devPrev=ricochet(prev)?0:c.angleTo(prev.dir);p.chordDev=Math.max(dev,devPrev);
      var agrees=dev<=CHORD_TOLERANCE&&devPrev<=CHORD_TOLERANCE;
      if(agrees||ricochet(prev)){p.line=c;p.source=agrees?'chord':'chord-unchecked';p.stretch={from:prev.pos.clone(),to:p.pos.clone(),dashed:!agrees};}
      else p.stretch={from:p.pos.clone().addScaledVector(p.dir,-span),to:p.pos.clone(),dashed:true};
    }
    return pts;
  };
  Viewer.prototype.drawTracers=function(pts){
    for(var i=0;i<pts.length;i++){var p=pts[i];
      if(!i)this.root.add(this.shotSegment(p.pos.clone().addScaledVector(p.line,-ARROW_LENGTH),p.pos,TRACER,false));
      else if(p.stretch)this.root.add(this.shotSegment(p.stretch.from,p.stretch.to,TRACER,p.stretch.dashed));}
  };
  // One tracer stretch from one point to another, the head at the end; dashed marks an approximate stretch.
  Viewer.prototype.shotSegment=function(from,to,color,dashed){
    var T=THREE,group=new T.Group(),dir=to.clone().sub(from),length=dir.length();if(length<1e-4)return group;dir.normalize();
    var head=Math.min(.12,length*.4),arrow=new T.ArrowHelper(dir,from,length,color,head,.045);group.add(arrow);
    [arrow.line.material,arrow.cone.material].forEach(function(m){m.depthTest=false;m.depthWrite=false;m.transparent=true;m.opacity=1;});
    arrow.line.renderOrder=4;arrow.cone.renderOrder=4;arrow.line.frustumCulled=false;arrow.cone.frustumCulled=false;
    if(dashed){arrow.line.visible=false;var line=new T.Line(new T.BufferGeometry().setFromPoints([from.clone(),to.clone().addScaledVector(dir,-head)]),new T.LineDashedMaterial({color:color,dashSize:.08,gapSize:.05,transparent:true,opacity:1,depthTest:false,depthWrite:false}));line.computeLineDistances();line.renderOrder=4;line.frustumCulled=false;group.add(line);}
    else{var body=new T.Mesh(new T.CylinderGeometry(.006,.006,length-head,8),new T.MeshBasicMaterial({color:color,transparent:true,opacity:.9,depthTest:false,depthWrite:false}));body.position.set(0,(length-head)/2,0);body.renderOrder=4;body.frustumCulled=false;arrow.add(body);}
    return group;
  };
  // Our verdict at every recorded contact point along the drawn line, for the verdict log (server fact vs our
  // estimate). After a ricochet the ray starts at the ricochet point; otherwise it comes from afar, so screens and
  // the gun in front of the point count as the server counted them.
  Viewer.verdicts=function(engine,pts,shell){
    if(!engine||!shell||!pts)return [];
    return pts.map(function(p,i){var prev=i?pts[i-1]:null,afterRicochet=prev&&(prev.effect===1||prev.effect===2);
      var origin=afterRicochet?prev.pos.clone().addScaledVector(p.line,.02):p.pos.clone().addScaledVector(p.line,-60);
      var result=null;try{result=engine.ray(origin.toArray(),p.line.toArray(),shell);}catch(e){result=null;}
      return {index:i,part:p.part,effect:p.effect,source:p.source,chordDev:p.chordDev,result:result};});
  };
  Viewer.prototype.pointVerdicts=function(shell){return Viewer.verdicts(this.engine,this.shotPoints,shell);};
  Viewer.prototype.shotArrow=function(direction,tip,color){
    var length=2.3,head=.12,arrow=new THREE.ArrowHelper(direction,tip.clone().addScaledVector(direction,-length),length,color,head,.045);
    var body=new THREE.Mesh(new THREE.CylinderGeometry(.006,.006,length-head,8),new THREE.MeshBasicMaterial({color:color,transparent:true,opacity:.9,depthTest:false,depthWrite:false}));
    body.position.set(0,(length-head)/2,0);body.renderOrder=4;body.frustumCulled=false;arrow.add(body);
    [arrow.line.material,arrow.cone.material].forEach(function(m){m.depthTest=false;m.depthWrite=false;m.transparent=true;m.opacity=1;});arrow.line.renderOrder=4;arrow.cone.renderOrder=4;arrow.line.frustumCulled=false;arrow.cone.frustumCulled=false;
    Viewer.own(arrow,[body.geometry,body.material,arrow.line.material,arrow.cone.material]);return arrow;
  };
  // The pinned line owns exactly what was made for it. ArrowHelper shares one line geometry and one cone
  // geometry between every instance (module-level in three 0.160.1, created on the first arrow), and its own
  // dispose() would free those for every other arrow too; only the two materials it makes per instance are
  // ours. Each owner records its list here and disposePin() frees exactly that list when the group is dropped.
  Viewer.own=function(object,resources){var owned=object.userData.ownedResources||(object.userData.ownedResources=[]);resources.forEach(function(r){if(r)owned.push(r);});return object;};
  Viewer.prototype.disposePin=function(){
    var group=this.pinGroup;if(!group)return;this.scene.remove(group);
    group.traverse(function(o){var owned=o.userData&&o.userData.ownedResources;if(!owned)return;owned.forEach(function(r){if(r&&r.dispose)r.dispose();});o.userData.ownedResources=null;});
    this.pinGroup=null;
  };
  // What of a pinned line's drawing depends on the shell: the flight after a ricochet (its start, direction and
  // length) and whether it ends in a second contact or is lost. Everything else - the contact on the model, the
  // arrow, the crosshair - depends on the line and the model alone.
  function pinLeg(result){var b=result&&result.bounce;return b?b.point.join(',')+'|'+b.direction.join(',')+'|'+result.distance+'|'+result.reason:'';}
  // `point`: the contact the caller has just found along this very line (pinAt, pinAtPoint cast it already), or
  // null when that cast met nothing; left out, the line is cast here.
  Viewer.prototype.refreshPin=function(point){
    var self=this,p=this.pinned,cache=this.pinCache,result=null,cast=false;
    // The same line on the same engine - a new shell, palette or distance through configure(): the contact, the
    // arrow and the crosshair stand. The ray is cast again for the shell, and the drawing is redone only when the
    // flight after a ricochet changed with it. rebuild() makes a new engine, so a new pose never lands here.
    if(p&&cache&&cache.pinned===p&&cache.engine===this.engine&&this.pinGroup){
      result=this.shell&&this.engine?this.engine.ray(p.origin.toArray(),p.direction.toArray(),this.shell):null;cast=true;
      if(pinLeg(result)===cache.leg){this.syncRecorded();this.draw();return;}
      point=cache.contact;
    }
    this.disposePin();this.pinCache=null;
    this.pinReticles.forEach(function(r){r.element.remove();});this.reticles=this.reticles.filter(function(r){return !r.pinned;});this.pinReticles=[];
    this.syncRecorded();
    if(!p)return;
    // The line is fixed in the world; the vehicle under it may have been posed since the click, so find the contact again.
    var contact;
    if(point===undefined){var caster=new THREE.Raycaster(p.origin,p.direction),objects=this.paintMesh?[this.paintMesh]:[];if(this.trackMesh)objects.push(this.trackMesh);
      var hits=caster.intersectObjects(objects);contact=hits.length?hits[0].point.clone():null;}
    else contact=point?point.clone():null;
    if(!cast)result=this.shell&&this.engine?this.engine.ray(p.origin.toArray(),p.direction.toArray(),this.shell):null;
    this.pinCache={pinned:p,engine:this.engine,contact:contact,leg:pinLeg(result)};
    var group=new THREE.Group(),tip=contact||(result&&result.bounce?new THREE.Vector3().fromArray(result.bounce.point):p.point);
    group.add(this.shotArrow(p.direction,tip,0x9fdcff));
    if(result&&result.bounce){
      // The flight after the ricochet: dashed leg to the second contact (or 2.3 m into the air) and its own reticle.
      var b=result.bounce,start=new THREE.Vector3().fromArray(b.point),out=new THREE.Vector3().fromArray(b.direction),end=start.clone().addScaledVector(out,result.distance!==undefined?result.distance:2.3);
      var leg=new THREE.Line(new THREE.BufferGeometry().setFromPoints([start,end]),new THREE.LineDashedMaterial({color:0xfb8580,dashSize:.12,gapSize:.08,depthTest:false,depthWrite:false,transparent:true}));
      leg.computeLineDistances();leg.renderOrder=4;leg.frustumCulled=false;group.add(leg);Viewer.own(leg,[leg.geometry,leg.material]);
      if(result.distance!==undefined)this.pinReticleAt(end,result.reason==='ricochet'?'pinned lost':'pinned second');
    }
    this.pinGroup=group;this.scene.add(group);
    if(contact)this.pinReticleAt(contact,'pinned');
    this.draw();
  };
  Viewer.prototype.pinReticleAt=function(position,classes){
    this.addReticle(position);var r=this.reticles[this.reticles.length-1];r.pinned=true;classes.split(' ').forEach(function(c){r.element.classList.add(c);});this.pinReticles.push(r);
  };
  Viewer.prototype.unpin=function(){this.pinned=null;this.refreshPin();this.showSavedAim(aimShown());if(this.onPin)this.onPin(false);this.draw();};
  // Recorded markers (arrows, reticles, aim circles) belong to the saved pose and the saved shot: an explored
  // pose or a pinned shot replaces them until the user returns.
  Viewer.prototype.recordedShown=function(){return aimShown()&&Math.abs(this.turretAngle)<.001&&Math.abs(this.gunAngle)<.001&&!this.pinned;};
  Viewer.prototype.syncRecorded=function(){var show=this.recordedShown();this.root.children.forEach(function(o){if(o!==this.paintMesh&&o!==this.trackGroup&&o!==this.outline&&o!==this.outlineDepth&&o!==this.aimGroup)o.visible=show;},this);};
  Viewer.prototype.shotProbability=function(shell){
    if(this.pinned&&this.engine&&shell)return this.engine.ray(this.pinned.origin.toArray(),this.pinned.direction.toArray(),shell);
    if(!this.engine||!this.point||!this.travel||!shell||Math.abs(this.turretAngle)>.001||Math.abs(this.gunAngle)>.001)return null;
    var span=this.bounds?this.bounds.getSize(new THREE.Vector3()).length():20;
    return this.engine.ray(this.point.clone().addScaledVector(this.travel,-span*2-2).toArray(),this.travel.toArray(),shell);
  };
  Viewer.prototype.setShotContext=function(context){
    var T=THREE,self=this,target=this.loadedData&&this.loadedData.hit.target;
    // The checkbox is read here and in showSavedAim, not once per frame: a hit without recorded circles leaves an
    // empty group behind, and an empty group that is visible costs nothing.
    this.savedAim=null;this.aimGroup=new T.Group();this.aimGroup.visible=aimShown();this.root.add(this.aimGroup);
    if(!context||!context.aim||!target||!target.worldTransform)return false;
    var inverse=new T.Matrix4().fromArray(target.worldTransform).invert();
    function pos(p){var v=new T.Vector3().fromArray(p).applyMatrix4(inverse);v.z*=-1;return v;}
    function dir(p){var v=new T.Vector3().fromArray(p).transformDirection(inverse);v.z*=-1;return v;}
    // The recorded marker sits wherever the client put it on the aim ray, short of or past the armour it was
    // aimed at: 0.02-0.49 m along the ray on the stage battle, up to metres on the records measured on 14.09.
    // Drawn there with depthTest off, the hoop reads as "floating away from the tank". The reticle is a solid
    // angle out of the muzzle, so the honest place to draw it is where the shell met the armour: slide the
    // centre along the ray from tracer.origin through marker.position onto the plane through the impact point
    // perpendicular to that ray, and scale the radius by the same distance ratio (the circle grows linearly
    // with distance): r' = r · |origin→plane| / |origin→marker|. The cone is unchanged, so savedAim keeps the
    // moved centre and radius with the unchanged origin and savedAimProbability still fans its rays over the
    // identical solid angle. Without a tracer origin the marker is drawn exactly as recorded.
    function ring(marker,color,dashed){
      if(!marker||!marker.position||!marker.direction||!(marker.diameter>0))return;
      var center=pos(marker.position),normal=dir(marker.direction),radius=marker.diameter/2;
      var origin=context.tracer&&Array.isArray(context.tracer.origin)?pos(context.tracer.origin):null;
      if(origin&&self.point){
        var ray=center.clone().sub(origin),span=ray.length();
        if(span>1e-6){
          ray.divideScalar(span);
          var depth=self.point.clone().sub(origin).dot(ray);
          if(depth>1e-6){center=origin.clone().addScaledVector(ray,depth);radius*=depth/span;normal=ray;}
        }
      }
      var up=new T.Vector3(0,1,0);if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
      var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();var points=[];
      for(var i=0;i<=96;i++){var a=i/96*Math.PI*2;points.push(center.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
      var options={color:color,depthTest:false,depthWrite:false,transparent:true,opacity:.85},material=dashed?new T.LineDashedMaterial(Object.assign(options,{dashSize:radius*.1,gapSize:radius*.07})):new T.LineBasicMaterial(options);
      var line=new T.Line(new T.BufferGeometry().setFromPoints(points),material);if(dashed)line.computeLineDistances();line.renderOrder=12;line.frustumCulled=false;self.aimGroup.add(line);
      if(!dashed){var size=Math.max(.025,Math.min(.12,radius*.12)),cross=[center.clone().addScaledVector(right,-size),center.clone().addScaledVector(right,size),center.clone().addScaledVector(up,-size),center.clone().addScaledVector(up,size)];var mark=new T.LineSegments(new T.BufferGeometry().setFromPoints(cross),new T.LineBasicMaterial(options));mark.renderOrder=12;self.aimGroup.add(mark);self.savedAim={center:center,normal:normal,right:right,up:up,radius:radius,origin:origin};}
    }
    // Both recorded reticles stand still, so both are magenta (user, 20.09); solid is the client's,
    // dashed the server's.
    ring(context.aim.clientMarker,AIM_RING,false);
    var server=context.aim.serverMarker,client=context.aim.clientMarker;
    if(server&&Number.isFinite(server.receivedAt)&&Math.abs(server.receivedAt-client.receivedAt)<.5)ring(server,AIM_RING,true);
    this.showSavedAim(aimShown());return !!this.savedAim;
  };
  // Without a recorded reticle (every incoming hit, own hits without a snapshot) draw the nominal full-aim circle:
  // gun accuracy × range, centred on the hit line. An estimate — it never enters the probability figures.
  Viewer.prototype.setAimEstimate=function(context){
    var T=THREE,self=this,hit=this.loadedData&&this.loadedData.hit,attacker=hit&&hit.attacker;this.estimateAim=null;
    if(!hit||!attacker||!(attacker.gunDispersion>0)||!this.point||!this.travel||!this.aimGroup)return null;
    var range=context&&context.range>0?context.range:hit.rangeAtImpact>0?hit.rangeAtImpact:null;if(!range)return null;
    var radius=attacker.gunDispersion*range,normal=this.travel.clone().normalize(),up=new T.Vector3(0,1,0);if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
    var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();var points=[];
    for(var i=0;i<=96;i++){var a=i/96*Math.PI*2;points.push(this.point.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
    var line=new T.Line(new T.BufferGeometry().setFromPoints(points),new T.LineDashedMaterial({color:AIM_RING,depthTest:false,depthWrite:false,transparent:true,opacity:.75,dashSize:radius*.12,gapSize:radius*.08}));
    line.computeLineDistances();line.renderOrder=12;line.frustumCulled=false;this.aimGroup.add(line);
    // The frame is kept so the ring can be sampled like any other (estimateAimProbability): the shooter
    // stands `range` back along the line of flight, which is where the cone this circle is the base of
    // starts. Geometry only - the estimate still never enters the figures of the recorded shot.
    this.estimateAim={radius:radius,range:range,dispersion:attacker.gunDispersion,gun:attacker.gun||null,source:context&&context.rangeSource||'impact',
      center:this.point.clone(),right:right,up:up,origin:this.point.clone().addScaledVector(normal,-range)};
    this.showSavedAim(aimShown());return this.estimateAim;
  };
  // The rings depend only on the shot line (muzzle, impact point, dispersion) and live in the root frame,
  // so turning the turret or the gun does not move them and must not hide them: only the checkbox does.
  // The hit marks and arrows keep their pose rule in syncRecorded.
  Viewer.prototype.showSavedAim=function(value){if(this.aimGroup)this.aimGroup.visible=!!value;this.draw();};
  // Whether the recorded rings are on screen at this moment. A pinned point and the user's first emulated
  // shot both take them away, and the page prints a figure only for a ring the user can actually see.
  Viewer.prototype.savedAimShown=function(){return !!(this.aimGroup&&this.aimGroup.visible);};
  Viewer.prototype.savedAimProbability=function(shell){
    if(!this.savedAim||!this.savedAim.origin||!this.engine||!shell||Math.abs(this.turretAngle)>.001||Math.abs(this.gunAngle)>.001)return null;
    // 'damage' is the mean expected damage over the circle, HP: a miss is 0 HP exactly as it is 0 %.
    var aim=this.savedAim;
    return sampleCircle(this.engine,shell,aim.origin,aim.center,aim.right,aim.up,aim.radius,256,this.aimQuantile());
  };
  // The same integral over the NOMINAL ring of a hit that has no recorded reticle (user, 20.09: the
  // circle figure belongs to every ring on screen). It is an estimate of the circle, so the figure is an
  // estimate too - the panel line says so - and it is still kept out of the reticle tile's own number.
  Viewer.prototype.estimateAimProbability=function(shell){
    var aim=this.estimateAim;
    if(!aim||!aim.origin||!this.engine||!shell||Math.abs(this.turretAngle)>.001||Math.abs(this.gunAngle)>.001)return null;
    return sampleCircle(this.engine,shell,aim.origin,aim.center,aim.right,aim.up,aim.radius,256,this.aimQuantile());
  };
  Viewer.prototype.paint=function(){
    if(!this.paintMesh)return;
    var composed=false;
    if(this.heatmap){
      if(!this.surfaceAttempted){this.surfaceAttempted=true;try{this.surface=new BullbaScreenArmor(this.renderer,this.engine);this.scene.add(this.surface.quad);
        // A fresh composition starts unlit, so the switch is re-applied here - the one path every new
        // instance goes through: the first paint, a new model, a quality change and a restored context.
        // Caught on its own: a cosmetic light the driver will not give must never read as a map that failed.
        if(this.lighting){try{this.surface.setLighting(true);}catch(light){console.warn('Soft lighting unavailable:',light.message);}}}catch(e){this.surfaceError=e.message;console.warn('Screen composition unavailable:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','unavailable: '+e.message);}}
      if(this.surface){try{
        this.surface.hatch=this.dotSpacing;this.surface.dots=this.dots;this.surface.edges=this.partEdges;this.surface.outline=this.zoneOutline;this.surface.tint=this.tint;/* The user's Detail and Ricochet trace settings hold during a drag too: 'Always' means live while rotating (0.7.4 lowered both while dragging; reverted on his feedback). */var size=this.surface.render(this.camera,this.target,this.shell,this.palette,this.trackOpacity,this.quality,this.viewWidth,this.viewHeight,this.renderer.getPixelRatio(),this.bounceMode,this.mapMode);
        composed=true;this.surfaceError=null;
        // The hatched layer is due once the camera has stood still: one redraw later, not a loop.
        if(this.surface.bouncePending&&this.bounceTimer===null){var self=this;this.bounceTimer=setTimeout(function(){self.bounceTimer=null;self.draw();},160);}
        if(this.onBackend)this.onBackend('GPU · layers at window size · '+size);
      }catch(e){this.surfaceError=e.message;this.surface.dispose();this.surface=null;console.warn('Screen composition disabled:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','error: '+e.message);}}
    }
    if(this.surface)this.surface.quad.visible=composed;
    this.paintMesh.visible=!composed;this.trackGroup.visible=!composed;
    if(composed)return;
    // An unavailable GPU map stays neutral; it never switches to triangle estimates.
    if(this.onBackend)this.onBackend(this.heatmap?'Estimate unavailable: '+(this.surfaceError||'GPU-composition did not run'):'Vehicle parts · estimate off');
    var key=this.heatmap?'neutral':'parts';if(this.paintedKey===key)return;
    var buffer=this.paintMesh.geometry.attributes.color.array;
    for(var n=0;n<this.samples.length;n++){
      var color=this.heatmap?baseColors[0]:baseColors[this.samples[n].part%4];
      for(var j=0;j<3;j++)for(var k=0;k<3;k++)buffer[n*9+j*3+k]=color[k];
    }
    this.paintedKey=key;this.paintMesh.geometry.attributes.color.needsUpdate=true;
  };
  // Hovering is coalesced to one reading per animation frame: a pointermove burst used to cost a Three.js
  // raycast plus a ballistic ray each, and only the last event of the burst is still under the cursor.
  Viewer.prototype.hover=function(event){
    var self=this;this.hoverEvent=event;if(this.hoverId!==null)return;
    this.hoverId=window.requestAnimationFrame(function(){self.hoverId=null;var last=self.hoverEvent;self.hoverEvent=null;if(last)self.inspect(last);});
  };
  Viewer.prototype.cancelHover=function(){if(this.hoverId!==null)window.cancelAnimationFrame(this.hoverId);this.hoverId=null;this.hoverEvent=null;};
  // Everything the “Under the cursor” panel prints, as one short string: an unchanged reading is not redrawn.
  Viewer.readingKey=function(result,sample){
    var r=result||{},b=r.bounce,round=function(v){return v===undefined||v===null?'-':Math.round(v);};
    return [sample?sample.part:'-',sample?sample.name||'':'',r.reason||'',r.chance===null||r.chance===undefined?'-':r.chance,
      round(r.nominal),round(r.effective),round(r.angle),r.final?'f':'',
      b?[round(b.nominal),round(b.angle),round(b.penetration),round((b.loss||0)*100)].join('/'):'-',
      (r.layers||[]).map(function(l){return (l.main?'m':'s')+round(l.nominal)+'@'+round(l.angle);}).join('+')].join('|');
  };
  Viewer.prototype.inspect=function(event){
    if(!this.engine||!this.onInspect)return;var raycaster=this.pointerRay(event),objects=this.paintMesh?[this.paintMesh]:[];if(this.trackGroup)objects.push(this.trackMesh);var hits=raycaster.intersectObjects(objects),sample=hits.length?(hits[0].object===this.trackMesh?this.trackTriangles:this.samples)[hits[0].faceIndex]:null,result=this.engine.ray(raycaster.ray.origin.toArray(),raycaster.ray.direction.toArray(),this.shell);if(sample)result.surface={part:sample.part,armor:sample.armor};
    // The emulated circle follows every pointer move, including one that leaves the reading below unchanged,
    // so it is moved before that early return - and it reuses this raycast instead of casting its own.
    if(this.liveRadius100){var moved=this.aimAtPointer(raycaster,hits);if(this.onAimMove)this.onAimMove(moved);}
    var key=Viewer.readingKey(result,sample);if(key===this.inspectKey)return;this.inspectKey=key;this.onInspect(result);
  };
  Viewer.prototype.wireframe=function(value){this.showOutline=!!value;this.applyOutline();this.draw();};
  // Alt + click pins the circle's centre. With the emulation on the circle simply stays there and keeps
  // following the state; with it off the manual estimate waits for the button, as before.
  Viewer.prototype.aimAt=function(event){var ray=this.pointerRay(event).ray,normal=this.target.clone().sub(this.camera.position).normalize(),plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,this.target),point=new THREE.Vector3();if(ray.intersectPlane(plane,point)){this.spreadAim=point;this.hideSpread();
    if(this.liveRadius100){var pinned=this.drawLiveAim();if(this.onAimMove)this.onAimMove(pinned);if(this.onAim)this.onAim('Circle pinned here. It keeps following the shooter’s state; “Centre on the hit” releases it.');}
    else if(this.onAim)this.onAim('Estimate centre moved. Press “Estimate”.');}};
  Viewer.prototype.hideSpread=function(){if(this.spreadCircle){this.scene.remove(this.spreadCircle);this.spreadCircle.geometry.dispose();if(this.spreadCircle.material!==this.liveRingMaterial)this.spreadCircle.material.dispose();this.spreadCircle=null;this.draw();}};
  // The sampling model of a dispersion circle, in one place: 'count' rays fanned over the circle at the
  // quantiles of the chosen radial distribution (a sunflower spiral, so the same count always gives the
  // same points), a miss counting as 0 % and 0 HP. The distribution itself is a setting - the page's own
  // Gaussian with sigma = radius/2, or the empirical post-9.6 table - and NEITHER is a confirmed WoT
  // server distribution; the page says so next to every figure it feeds. Used by the button estimate, by
  // the saved client reticle and by the emulated circle alike, so all three read the same way.
  function sampleCircle(engine,shell,origin,center,right,up,radius,count,quantile){
    var sum=0,unknown=0,miss=0,dmg=0,o=origin.toArray();
    var q=typeof quantile==='function'?quantile:ArmorBallistics.aimProfile().quantile;
    for(var i=0;i<count;i++){
      var r=radius*q((i+.5)/count),angle=i*2.399963229728653;
      var point=center.clone().addScaledVector(right,r*Math.cos(angle)).addScaledVector(up,r*Math.sin(angle));
      var hit=engine.ray(o,point.sub(origin).toArray(),shell);
      if(hit.chance===null)unknown++;else sum+=hit.chance;
      if(hit.expected>0)dmg+=hit.expected;
      if(hit.reason==='no-hull')miss++;
    }
    return {low:sum/count,high:(sum+unknown*100)/count,unknown:unknown,miss:miss/count*100,samples:count,
      damage:dmg/count,damageHigh:(dmg+unknown*((shell||{}).alpha||0))/count};
  }
  // The frame a circle standing across a shot line is drawn in: the line itself is the normal, the other two
  // axes are any pair perpendicular to it.
  function circleFrame(origin,center){
    var T=THREE,normal=center.clone().sub(origin).normalize(),up=new T.Vector3(0,1,0);
    if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
    var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();
    return {normal:normal,right:right,up:up};
  }
  // One dispersion circle in the scene. It must always be READABLE OVER THE MODEL (user, 20.09): an
  // opaque line with depthTest off is still drawn in three's opaque pass, which runs BEFORE the
  // heat map's own full-screen quad (transparent, renderOrder 0) - so the quad painted over it and the
  // model appeared to occlude the circle. Transparent, depth off and a renderOrder above the recorded
  // rings (12) and the tracers (4) puts it last of all, on top of everything.
  // `style` is {color, dashed, opacity}; without one the circle is the gold manual estimate of 0.7.13.
  // `from`/`to` in radians cut an arc out of it (the reload); the full circle is the default.
  // `material`: a dashed material the caller keeps (the live ring's own, drawCircle); its dashes are sized here
  // for this radius, and dropping the line leaves it alone.
  function aimLine(center,right,up,radius,style,from,to,material){
    var T=THREE,points=[],s=style||{},a0=from===undefined?0:from,a1=to===undefined?Math.PI*2:to;
    // 97 points, the last on top of the first: a closed T.Line rather than a LineLoop, because
    // computeLineDistances() has no distance for a LineLoop's closing segment and the dashes break there.
    var steps=Math.max(2,Math.round(96*Math.abs(a1-a0)/(Math.PI*2)));
    for(var j=0;j<=steps;j++){var a=a0+(a1-a0)*j/steps;points.push(center.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
    var options={color:s.color===undefined?0xf1d18b:s.color,transparent:true,opacity:s.opacity>0?s.opacity:1,depthTest:false,depthWrite:false};
    if(material){material.dashSize=radius*.09;material.gapSize=radius*.06;}
    else material=s.dashed?new T.LineDashedMaterial(Object.assign(options,{dashSize:radius*.09,gapSize:radius*.06})):new T.LineBasicMaterial(options);
    var line=new T.Line(new T.BufferGeometry().setFromPoints(points),material);
    if(s.dashed)line.computeLineDistances();
    line.frustumCulled=false;
    return line;
  }
  function dropLine(scene,line){if(!line)return;scene.remove(line);line.geometry.dispose();line.material.dispose();}
  // The live ring is redrawn on every frame of the emulation. Its dashed material is one for the viewer's life
  // and is never disposed: three r160 deletes a program whose last material goes, so a fresh material per frame
  // recompiled and relinked the dashed-line program on every frame whenever the live ring was the only dashed
  // line on screen (the Vehicles mode, a swapped view). The geometry is still new per frame.
  Viewer.prototype.liveRing=function(){
    return this.liveRingMaterial||(this.liveRingMaterial=new THREE.LineDashedMaterial({color:AIM_LIVE.color,transparent:true,opacity:AIM_LIVE.opacity,depthTest:false,depthWrite:false}));
  };
  Viewer.prototype.drawCircle=function(center,right,up,radius,style,from,to){
    this.hideSpread();
    this.spreadCircle=aimLine(center,right,up,radius,style,from,to,style===AIM_LIVE?this.liveRing():null);
    this.spreadCircle.renderOrder=14;this.scene.add(this.spreadCircle);this.draw();
  };
  Viewer.prototype.estimateSpread=function(radius100){
    this.commitPose(); // the rays are cast against the engine, so a pose that is only drawn must be built first
    if(!this.engine||!this.shell)throw new Error('Pick a shell and penetration first.');
    if(!Number.isFinite(radius100)||radius100<0||radius100>10)throw new Error('The radius must be between 0 and 10 m at 100 m.');
    var aim=this.spreadAim||this.point||this.target,origin=this.camera.position.clone(),frame=circleFrame(origin,aim);
    var radius=origin.distanceTo(aim)*radius100/100;
    var result=sampleCircle(this.engine,this.shell,origin,aim,frame.right,frame.up,radius,1024,this.aimQuantile());
    this.drawCircle(aim,frame.right,frame.up,radius);
    return result;
  };
  // --- Aim emulation (0.7.14) ------------------------------------------------------------------------
  // The shooter's own dispersion circle, following the cursor over the model like the game reticle. The
  // radius comes from the page (ArmorBallistics.aimFactor over the recorded 'aim' block, the shooter's
  // state and his modifiers) as a radius at 100 m; here it only becomes geometry. The shot leaves the
  // camera - the page's shooter viewpoint - so the circle stands on the plane through the aimed point,
  // across that ray, and grows with the distance flown exactly as it does in the game.
  Viewer.prototype.setLiveAim=function(radius100){
    var value=Number.isFinite(radius100)&&radius100>0&&radius100<=50?radius100:null;
    this.liveRadius100=value;
    if(value===null){this.liveAim=null;this.hideSpread();return;}
    if(this.aimCentred&&!this.liveAimPoint)this.centreAim();   // a new model arrived while the aim is held
    this.drawLiveAim();
  };
  // A new model (clear) or the mode going off drops the points; a hold on the model survives it, but what it
  // would hand back belonged to the previous model, so it forgets that and stays on the centre.
  Viewer.prototype.clearLiveAim=function(){this.liveRadius100=null;this.liveAimPoint=null;this.aimCursorPoint=null;this.liveAim=null;if(this.aimCentred)this.aimCentred={cursor:null,gun:null,seen:null};this.clearAimShot();this.hideSpread();this.updateAimMarker();};
  // THE AIM HELD ON THE MODEL (user, 21.09). While the page's Config popover is open the mouse is on the
  // menu, so the circle would sit behind it and nobody could see what a tile does to it. The aim is parked
  // in the middle of the target instead: the point on the model's surface along the view ray through the
  // centre of its bounds, found with the same raycast and the same fallback the cursor uses. The gun and
  // the cursor point both go there, so the turret has nothing to chase and the ring does not bloom for the
  // jump, and a drawn crosshair marks the spot, because the real crosshair is the mouse pointer and cannot
  // be moved. Pointer moves meanwhile only remember where the cursor is, and letting go puts the aim there
  // (or back where it was, if the pointer never moved). A pinned centre (Alt + click) is left alone and is
  // in force again once the hold ends. `shape` is the Settings crosshair, 'cross' or 'dot'.
  Viewer.prototype.setAimCentre=function(on,shape){
    this.aimMarkerShape=shape==='dot'?'dot':'cross';
    if(!!on===!!this.aimCentred){this.updateAimMarker();return;}
    if(on){this.aimCentred={cursor:this.aimCursorPoint,gun:this.liveAimPoint,seen:null};this.centreAim();}
    else{
      var held=this.aimCentred,back=held.seen||held.cursor;this.aimCentred=null;
      // Nothing to go back to (the pointer never crossed the scene): the circle stays where it is until it does.
      if(back){this.aimCursorPoint=back.clone();this.liveAimPoint=(held.seen||held.gun||back).clone();}
    }
    if(this.liveRadius100)this.drawLiveAim();
    this.updateAimMarker();this.draw();
  };
  Viewer.prototype.centreAim=function(){
    var point=this.aimCentrePoint();
    if(point){this.aimCursorPoint=point;this.liveAimPoint=point.clone();}
    return point;
  };
  // The held point is found once, when the hold starts, so an orbit (the arrow keys still turn the camera
  // while the menu has the focus, and the wheel still glides the distance) would leave it on the surface point
  // of the old view - off the middle, or round the back of the model. When the camera comes to rest the same
  // raycast runs again (settleAim). The gun goes with the crosshair, as it does when the hold starts, and the
  // page is told so it can take the ring's figure again (onAimCentre). No ring, no hold to move: between a
  // clear() and the next model the bounds are the old model's, and setLiveAim centres the new one itself.
  Viewer.prototype.recentreAim=function(){
    if(!this.aimCentred||!this.liveRadius100)return false;
    var was=this.aimCursorPoint,point=this.aimCentrePoint();
    // The same point: nothing moves, and a gun the hull has swung off it is left to the turret's chase.
    if(!point||(was&&was.distanceToSquared(point)<1e-12))return false;
    this.aimCursorPoint=point;this.liveAimPoint=point.clone();
    this.drawLiveAim();this.updateAimMarker();this.draw();
    if(this.onAimCentre)this.onAimCentre();
    return true;
  };
  // WHEN the held point is looked for again: at rest, once per move. Never in the middle of a drag - a drag
  // pauses the emulation, and a pan's loop settles on every frame, so the page would take a new figure of the
  // ring per frame - the release does it instead; and never while the camera loop still eases (orbitId), which
  // does it itself when it settles.
  Viewer.prototype.settleAim=function(){if(this.aimCentred&&!this.dragging&&this.orbitId===null)this.recentreAim();};
  // The +/- keys set the distance at once and a held key repeats thirty times a second: the held point is
  // looked for once the key rests, POSE_SETTLE ms after the last step, not on every repeat.
  Viewer.prototype.settleAimSoon=function(){
    var self=this;window.clearTimeout(this.aimSettleTimer);
    this.aimSettleTimer=window.setTimeout(function(){self.aimSettleTimer=null;self.settleAim();},POSE_SETTLE);
  };
  Viewer.prototype.aimCentrePoint=function(){
    if(!this.bounds||!this.camera)return null;
    var T=THREE,centre=this.bounds.getCenter(new T.Vector3()),eye=this.camera.position.clone(),dir=centre.clone().sub(eye);
    if(dir.lengthSq()<1e-12)return centre;
    var caster=new T.Raycaster(eye,dir.normalize()),objects=this.paintMesh?[this.paintMesh]:[];if(this.trackMesh)objects.push(this.trackMesh);
    return this.aimSurfacePoint(caster,objects.length?caster.intersectObjects(objects):[])||centre;
  };
  // The centre a pin holds the circle on, or null. The hold on the model outranks a pin while it lasts.
  Viewer.prototype.aimPin=function(){return this.aimCentred?null:this.spreadAim;};
  // The crosshair drawn where the held aim points: the Settings shape, the very picture of the mouse pointer
  // (style.css .aim-marker), put on the projected point every frame so it stays on the model while the
  // camera moves. Hidden whenever the aim is not held.
  Viewer.prototype.updateAimMarker=function(){
    var m=this.aimMarker,p=this.aimCentred?this.aimCursorPoint:null;
    if(!p){if(m)m.hidden=true;return;}
    if(!m){m=this.aimMarker=document.createElement('span');m.className='aim-marker';m.setAttribute('aria-hidden','true');}
    if(m.parentNode!==this.reticleLayer)this.reticleLayer.appendChild(m);   // clear() empties the layer
    var behind=p.clone().applyMatrix4(this.camera.matrixWorldInverse).z>-.01,q=p.clone().project(this.camera);
    m.setAttribute('data-shape',this.aimMarkerShape||'cross');
    m.hidden=behind||Math.abs(q.x)>1||Math.abs(q.y)>1;
    if(!m.hidden){m.style.left=(q.x+1)*this.viewWidth/2+'px';m.style.top=(1-q.y)*this.viewHeight/2+'px';}
  };
  // The ring the LAST SHOT left behind (user, 20.09): a copy of the live ring frozen where and as wide
  // as it was, solid and magenta, standing next to its own tracer until the next shot replaces it. The
  // live ring is untouched by this and goes on aiming. This is also the moment everything RECORDED
  // leaves the scene (user, 20.09): until the first shot the battle's own reticles and tracers stay.
  Viewer.prototype.setAimShot=function(){
    var aim=this.liveAim;
    if(!aim)return false;
    aimFired=true;
    if(this.aimGroup)this.aimGroup.visible=false;
    this.syncRecorded();
    dropLine(this.scene,this.aimShotCircle);
    this.aimShotCircle=aimLine(aim.center,aim.right,aim.up,aim.radius,AIM_FIXED);
    this.aimShotCircle.renderOrder=15;this.scene.add(this.aimShotCircle);this.draw();
    return true;
  };
  // The emulated shot is dropped: its ring goes, and with it the reason the recorded markers were
  // hidden. The pinned line it left behind is released too (it is the shot's own), so the battle's
  // tracer and reticles are back exactly as they were before the first shot.
  Viewer.prototype.clearAimShot=function(){
    var had=!!this.aimShotCircle,reloading=this.aimReloadPart!==null,fired=aimFired;
    this.aimReloadPart=null;aimFired=false;
    if(had){dropLine(this.scene,this.aimShotCircle);this.aimShotCircle=null;}
    var released=false;
    if(this.aimPinned){this.aimPinned=false;if(this.pinned){this.unpin();released=true;}}
    if(fired&&!released){if(this.aimGroup)this.aimGroup.visible=aimShown();this.syncRecorded();}
    if(reloading&&this.liveRadius100)this.drawLiveAim();   // the ring is whole again
    else if(had||fired)this.draw();
  };
  // How much of the reload (or of the clip interval) has run, 0..1, which is how much of the live ring is
  // drawn; null (or nothing) means the gun is loaded and the ring is whole. Stored only: the page calls
  // this immediately before setLiveAim on every frame of the emulation, and that draws the ring once.
  Viewer.prototype.setAimReload=function(part){
    var p=Number(part);
    this.aimReloadPart=part===null||part===undefined||!(p>=0)?null:Math.min(1,p);
  };
  // The emulation as a whole. Switching it on leaves the battle's own reticles and tracers where they
  // are (user, 20.09): they make way for the USER'S FIRST SHOT and for nothing else, and clearAimShot
  // below brings them back - on the way in as on the way out, so a mode switched off and on again shows
  // the recorded shot until the next round leaves.
  Viewer.prototype.setAimEmulation=function(on){
    this.aimChase=!!on;
    if(!on)this.aimHold=false;
    this.clearAimShot();
    if(this.aimGroup)this.aimGroup.visible=aimShown();
    this.syncRecorded();
    this.draw();
  };
  // Which radial distribution the samplers fan their rays over. A name the page does not know falls
  // back to the Gaussian, so a stored setting from a later build can never break the figures.
  Viewer.prototype.setAimProfile=function(name){this.aimProfileName=ArmorBallistics.aimProfile(name).id;};
  Viewer.prototype.aimQuantile=function(){return ArmorBallistics.aimProfile(this.aimProfileName).quantile;};
  // A pinned centre (Alt + click, or "Centre on the hit") outranks the cursor: the circle then stays where
  // the user put it and only its radius follows the state, which is what the Estimate button needs too.
  Viewer.prototype.drawLiveAim=function(){
    var center=this.aimPin()||this.liveAimPoint;
    if(!this.liveRadius100||!center){this.liveAim=null;return null;}
    var origin=this.camera.position.clone(),range=origin.distanceTo(center),frame=circleFrame(origin,center);
    var radius=range*this.liveRadius100/100;
    this.liveAim={center:center.clone(),right:frame.right,up:frame.up,radius:radius,origin:origin,range:range};
    // The reload as the game draws it, on the ring itself (user, 20.09): while it runs the ring is only
    // drawn as far as it has come, filling clockwise from the top, so at half the reload half the ring is
    // there and a whole ring means the gun is ready. `right` is screen-right and `up` screen-up in the
    // circle's frame (right x up points back at the camera), so clockwise from the top runs from +pi/2
    // DOWNWARDS. The geometry of `liveAim` above is the WHOLE circle either way: the integral of a shot
    // fans over the circle the gun would fire into, not over the part of it that is drawn.
    var part=this.aimReloadPart,top=Math.PI/2;
    if(part===null)this.drawCircle(center,frame.right,frame.up,radius,AIM_LIVE);
    else this.drawCircle(center,frame.right,frame.up,radius,AIM_LIVE,top,top-Math.PI*2*part);
    return this.liveAim;
  };
  // Called from inspect() with the raycast it already did, so a pointer move costs no second cast. Without a
  // surface under the cursor the circle rests on the plane through the orbit centre, as aimAt() does.
  // With the turret emulation on this only records where the CURSOR is; the gun is moved towards it by
  // chaseAim() in the frame loop, at the turret's own rotation speed.
  Viewer.prototype.aimAtPointer=function(caster,hits){
    if(!this.liveRadius100)return null;
    var point=this.aimSurfacePoint(caster,hits);
    if(!point)return null;
    // The aim is held on the model while the page's menu is open (setAimCentre): the pointer is on the
    // menu, so where it points is only remembered for the moment the hold ends.
    if(this.aimCentred){this.aimCentred.seen=point;return null;}
    this.aimCursorPoint=point;
    if(!this.aimChase||!this.liveAimPoint)this.liveAimPoint=point.clone();
    return this.drawLiveAim();
  };
  // The point a ray aims at: the first surface of the model it meets, or else its crossing with the plane
  // through the orbit centre square to the view. The cursor and the held centre both find their point here.
  Viewer.prototype.aimSurfacePoint=function(caster,hits){
    if(hits&&hits.length)return hits[0].point.clone();
    var T=THREE,plane=new T.Plane().setFromNormalAndCoplanarPoint(this.target.clone().sub(this.camera.position).normalize(),this.target),p=new T.Vector3();
    return caster.ray.intersectPlane(plane,p)?p:null;
  };
  // The angle between where the gun points and where the cursor points, seen from the shooter (the
  // camera). Both are points in the scene, so the angle is the one the turret actually has to turn
  // through; the distance to them plays no part in it.
  Viewer.prototype.aimGap=function(){
    var pin=this.aimPin(),gun=pin||this.liveAimPoint,cursor=this.aimCursorPoint;
    if(!gun||!cursor||pin)return 0; // a pinned centre is not chasing anything
    var eye=this.camera.position,a=gun.clone().sub(eye),b=cursor.clone().sub(eye);
    if(a.lengthSq()<1e-12||b.lengthSq()<1e-12)return 0;
    return a.normalize().angleTo(b.normalize());
  };
  // Turn the gun towards the cursor by at most `step` radians and put the circle where it now points.
  // The new point is picked off the model along the rotated ray so the circle keeps lying on the armour;
  // with nothing under that ray it keeps the range it had, which is all the radius needs. Reaching the
  // cursor snaps exactly onto it, so a turret that has caught up reads identically to stage 1.
  Viewer.prototype.chaseAim=function(step){
    var T=THREE,gun=this.liveAimPoint,cursor=this.aimCursorPoint;
    if(!gun||!cursor||this.aimPin())return false;
    var eye=this.camera.position.clone(),a=gun.clone().sub(eye),range=a.length(),b=cursor.clone().sub(eye);
    if(range<1e-6||b.lengthSq()<1e-12)return false;
    a.divideScalar(range);b.normalize();
    var gap=a.angleTo(b);
    if(!(gap>1e-6)||step>=gap){this.liveAimPoint=cursor.clone();this.drawLiveAim();return gap>1e-6;}
    var axis=new T.Vector3().crossVectors(a,b);
    if(axis.lengthSq()<1e-14)return false;
    var moved=a.clone().applyQuaternion(new T.Quaternion().setFromAxisAngle(axis.normalize(),step));
    var objects=this.paintMesh?[this.paintMesh]:[];if(this.trackMesh)objects.push(this.trackMesh);
    var hits=objects.length?new T.Raycaster(eye,moved).intersectObjects(objects):[];
    this.liveAimPoint=hits.length?hits[0].point.clone():eye.clone().addScaledVector(moved,range);
    this.drawLiveAim();
    return true;
  };
  // The HULL carries the gun with it (user, 20.09): A and D turn a virtual hull heading, and the gun,
  // sitting on that hull, swings around the SHOOTER (the camera position) about the world up axis by
  // the same angle. The cursor stays where it is, so the gap opens and chaseAim() pulls the turret back
  // towards the crosshair with whatever of its speed the hull rotation left it. A POSITIVE angle is a
  // turn to the right, which about +Y (three.js is right-handed and the scene is Y-up) is a negative
  // rotation. A pinned centre is not being aimed at all, so it is left alone.
  Viewer.prototype.turnAim=function(angle){
    var T=THREE,gun=this.liveAimPoint,a=Number(angle)||0;
    if(!gun||!a||this.aimPin()||!this.liveRadius100)return false;
    var eye=this.camera.position.clone(),dir=gun.clone().sub(eye),range=dir.length();
    if(range<1e-6)return false;
    dir.divideScalar(range).applyQuaternion(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),-a));
    var objects=this.paintMesh?[this.paintMesh]:[];if(this.trackMesh)objects.push(this.trackMesh);
    var hits=objects.length?new T.Raycaster(eye,dir).intersectObjects(objects):[];
    this.liveAimPoint=hits.length?hits[0].point.clone():eye.clone().addScaledVector(dir,range);
    this.drawLiveAim();
    return true;
  };
  // A shot: pin the line the gun is actually pointing along, not the one under the cursor. Same record
  // as a click on the armour (pinAt), so the "Pinned point" panel reads the shot exactly as before.
  Viewer.prototype.pinAtPoint=function(point){
    if(!this.engine||!point)return false;
    var T=THREE,origin=this.camera.position.clone(),direction=point.clone().sub(origin);
    if(direction.lengthSq()<1e-12)return false;
    direction.normalize();
    var objects=this.paintMesh?[this.paintMesh]:[];if(this.trackGroup)objects.push(this.trackMesh);
    var hits=new T.Raycaster(origin,direction).intersectObjects(objects),hit=hits.length?hits[0]:null;
    var normal=hit&&hit.face?hit.face.normal.clone().transformDirection(hit.object.matrixWorld):null;
    this.pinned={origin:origin,direction:direction,point:hit?hit.point.clone():point.clone(),normal:normal};
    this.aimPinned=true;   // this pin belongs to the emulated shot: dropping the shot releases it
    this.refreshPin(hit?hit.point:null);if(this.onPin)this.onPin(true);   // the same line was just cast above
    return true;
  };
  Viewer.prototype.liveAimProbability=function(shell,count){
    var aim=this.liveAim;
    if(!aim||!this.engine||!shell)return null;
    this.commitPose();
    return sampleCircle(this.engine,shell,aim.origin,aim.center,aim.right,aim.up,aim.radius,count>0?count:256,this.aimQuantile());
  };
  window.ArmorViewer=Viewer;
}());
