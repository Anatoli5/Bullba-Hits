/* Local WebGL scene. Game transforms are serialized by basis vectors, column-major. */
(function () {
  'use strict';
  // Orbit by mouse drag, radians per pixel: 0.004 = about 1570 px for a full turn (user, 24.09 - half the old 0.008, at which a short drag spun the vehicle round several times; smaller steps also look smoother at the game browser's frame rate).
  var ORBIT_PER_PX=.004;
  var DISTANCE_MIN=3,DISTANCE_MAX=1000; // metres: no map is wider than ~1 km; closer than 5 m the camera sits inside the hull
  // POSE_SETTLE: ms without a pose change after which the display-only pose is turned into a full rebuild.
  // FRAME_STALL: ms after which a scheduled frame that never fired counts as lost (kick()).
  // FRAME_SAMPLES: frames kept for the rate readout; FRAME_WINDOW: how fresh they must be.
  var POSE_SETTLE=200,FRAME_STALL=2000,FRAME_SAMPLES=30,FRAME_WINDOW=2000;
  function clampZoom(value){return Math.max(.1,Math.min(150,value));}
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
  // The THIRD recorded figure of an own shot (user, 24.09; BACKLOG 28 step 2) - the circle the server really fired from
  // (ArmorShotContext.serverShot) - stands still too. It is a THICK, translucent ring of LONG dashes, so it reads apart
  // from the two thin outlines (solid: the client reticle, short dashes: the server marker). A filled disc was tried
  // first and dropped (user, 24.09: "a blotch without an edge, unclear what it means"). Its look - colour, opacity,
  // thickness in screen pixels, dashes, placement against the true radius - is tuned in a TEMPORARY Settings lab
  // (setShotRingLook). It is drawn under the tracers (4) and the two outlines (12): renderOrder 3.5, after the heat-map
  // quad (0), the screens (1, 2) and the marks (3). Internally it keeps the disc's names (discAim, shotDisc).
  var AIM_RING=0xff5ad6;
  var DISC_ORDER=3.5;
  // The ring's width is in screen pixels: its vertex shader moves each edge vertex along the ring's radius by
  // width x (world units per pixel at that depth), from the projection the frame is drawn with - so a zoom, the 2D
  // zoom path included, and a distance change keep the width with no work on the CPU. Each vertex is a point of the
  // unit circle (the mesh matrix scales it to the true radius R) and `side` says which edge it belongs to: 0 the inner,
  // 1 the outer. uPlace puts the band against R: 0 inside (outer edge on R), 0.5 centred, 1 outside (inner edge on R).
  var SHOT_RING_VERTEX='attribute float side;uniform float uWidth;uniform float uPlace;uniform float uViewH;'+
    'void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vec3 radial=normalize((modelViewMatrix*vec4(position.xy,0.0,0.0)).xyz);'+
    'float perPx=2.0*max(-mv.z,1e-4)/(projectionMatrix[1][1]*max(uViewH,1.0));mv.xyz+=radial*(side-1.0+uPlace)*uWidth*perPx;'+
    'gl_Position=projectionMatrix*mv;}';
  // The colour is handed over as sRGB and written as is (a ShaderMaterial is not converted), as the page's sliders say it.
  var SHOT_RING_FRAGMENT='uniform vec3 uColor;uniform float uOpacity;void main(){gl_FragColor=vec4(uColor,uOpacity);}';
  // The lab's defaults (the page's Settings controls carry the same): blue 0x3b82ff, 6 px, 12 dashes of 80 %, inside.
  var SHOT_RING_LOOK={color:[.6,1,1],width:6,dashes:12,share:.8,place:0};
  var AIM_LIVE={color:0x5ee0ff,dashed:true,opacity:.95},AIM_FIXED={color:AIM_RING,dashed:false,opacity:1};
  // A press the gun refused (the page's gunBalk, 23.09): the live ring takes the page's red (--red) for a step, then
  // its own colour, twice - the pulse the refused indicator of the page's strip gives at the same time.
  var AIM_BALK={color:0xfb8580,opacity:1},AIM_BALK_STEP=150;
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
    this.impactOpacity=.5;this.setImpactOpacity(.5);this.discOn=true;this.ringAxes=false;this.viewFrom='fired';this.viewPoints=null;this.discOpacity=.25;this.ringLook=Object.assign({},SHOT_RING_LOOK);this.ringAim=this.discAim=this.shotDisc=null;   // the default of the Settings slider, applied before the first cross exists
    this.grid = new T.GridHelper(24, 24, 0x4a5d6f, 0x263746); this.scene.add(this.grid);
    this.root = new T.Group(); this.scene.add(this.root);
    this.target = new T.Vector3(0, 1, 0); this.yaw = 0.7; this.pitch = 0.27; this.distance = 50;
    // The camera defaults are constants (VIEW-18, 24.09): the old 'armor-camera-defaults' key of localStorage had no
    // writer left, and a value from an old build silently set the distance of every hit without a range.
    this.defaults={distance:50,scale:.85};this.pivot='vehicle';this.pivotHeight=null;this.pinned=null;this.pinGroup=null;this.pinReticles=[];this.centre=null;this.pan=new T.Vector2();this.frameCenter=new T.Vector2();this.fitZoom=1;
    this.point = null; this.travel = null; this.shotPath = null; this.horizon = null;
    this.shell=null;this.heatmap=true;this.palette='classic';this.paintMesh=null;this.samples=[];this.engine=null;
    // What the page was last told (notifyCamera, backend) and the notifications held while a scene loads (hold): the
    // page is told once per real change, not once per internal step (VIEW-07). engineGen counts the ballistic engines -
    // a committed pose is a new one, and the page's figures follow it through the camera report.
    // liveRingLine is the live ring's one line for the viewer's life (drawCircle).
    this.cameraSeen=new Float64Array(11);this.cameraSeen[0]=NaN;this.engineGen=0;this.hold=0;this.heldCamera=false;this.heldPose=null;this.backendShown=null;this.liveRingLine=null;
    this.frameId=null;this.fitPending=false;this.zoomLock=false;this.recordedDistance=null;this.estimateAim=null;this.paintedKey=null;this.distanceSet=false;
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
    // aimYaw: the gun's yaw on the emulated hull, radians, right positive - what the chase stops at the shooter's
    // horizontal sector with (aimReach, BACKLOG 40).
    this.aimYaw=0;
    // aimPinned: the pinned line on screen is the emulated shot's own, so dropping that shot releases it
    // and the recorded tracer and reticles come back.
    this.aimShotCircle=null;this.aimReloadPart=null;this.aimHold=false;this.aimPinned=false;
    // The fun layer (user, 22.09). pinResult is the ballistic verdict of the line the pin was last cast
    // along - refreshPin has it anyway, and handing it out here is what keeps the page from casting a
    // second ray for the same shot. markSets are the decal buffers, one group per vehicle PART holding one
    // merged mesh per outcome, markSlots the ONE ring of 500 shots across all of them, markDrawn/markBuilt the
    // parts' world matrices as drawn and as the engine was built (see the Hitmarks block).
    this.pinResult=null;this.hitMarks=false;this.markSets=null;this.markMaterials=null;this.markSlots=null;this.markCount=0;this.markNext=0;this.markDrawn=null;this.markBuilt=null;
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
    this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.trackOpacity=.2;this.trackKey=null;this.pinCache=null;this.liveRingMaterial=null;this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.lighting=false;this.gunAngle=0;this.autoFrame=true;this.frameScale=this.defaults.scale;this.outline=null;this.outlineDepth=null;this.outlineStyle={brightness:.8,opacity:.06};this.showOutline=false;
    var drag = null;
    container.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    /* A selection on the page (a left-button sweep over the panels selects their text, and the scene with it) made a
       press on the scene start the browser's own drag of that selection: pointercancel after a few pixels, and the
       vehicle turned a few degrees and stopped (user, 24.09). The press drops the selection and no drag may start here. */
    container.addEventListener('dragstart', function(e) { e.preventDefault(); });
    container.addEventListener('pointerdown', function(e) { /* The scene tiles and the modifier groups beside them are controls of their own: capturing the pointer here would retarget the click to #viewport and the shooter tile would never fire. Leaving the drag unstarted also keeps the pointerup below from pinning a point under the control. */ if(e.target&&e.target.closest&&e.target.closest('.viewport-tile,.viewport-tiles,.mod-slot,.swap-roles,.aim-gun,.fun-strip,.aim-drive,#aim-config,.ttx-panel'))return; var selection=window.getSelection&&window.getSelection();if(selection&&!selection.isCollapsed)selection.removeAllRanges(); /* pan: right button, or Ctrl + left button (the in-game browser swallows the right button) */ if(e.button===2||(e.button===0&&e.ctrlKey)){drag={pan:true,x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false};self.dragging=true;try{container.setPointerCapture(e.pointerId);}catch(ignore){}return;}if(e.button!==0)return;if(e.altKey){self.aimAt(e);return;}drag={x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false,part:self.pickPart(e)};if(drag.part===2||drag.part===3){/* a turret and gun the client holds still (poseLocks) are not dragged; with both held the drag orbits */drag.locks=self.poseLocks();if(drag.locks.turret&&drag.locks.gun)drag.part=1;}self.dragging=true; try{container.setPointerCapture(e.pointerId);}catch(ignore){} container.focus();
      /* Hold to fire (user, 20.09): the press itself never shoots. The page starts a hold timer and decides -
         a short press is one shot on release, a long one a burst on the gun's cooldown - and a drag past the
         threshold below cancels the whole thing. aimHold marks the press as a shot so the emulation is not
         paused for it the way a real drag is. */
      if(self.onShotDown&&self.onShotDown(e))self.aimHold=true; });
    /* A move past the threshold is a drag - unless the press has already grown into a burst (user, 20.09):
       once the first round is away, moving the mouse AIMS the burst (the turret chases the cursor) and only
       the release stops it. onShotCancel says which it is: false = the burst goes on, so the press is never
       handed to the orbit or the turret drag and the pointer goes back to plain hovering. */
    container.addEventListener('pointermove', function(e) { if (!drag){self.hover(e);return;}if(Math.abs(e.clientX-drag.sx)+Math.abs(e.clientY-drag.sy)>3)drag.moved=true;if(!drag.moved)return;if(self.aimHold){if(self.onShotCancel&&self.onShotCancel()===false){drag=null;self.dragging=false;self.hover(e);return;}self.aimHold=false;}if(drag.pan){/* the pan is accumulated and applied once in the camera's own frame loop, not per event */var p=self.pendingPan||(self.pendingPan={x:0,y:0});p.x+=e.clientX-drag.x;p.y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;self.startOrbit();return;}if(drag.part===2||drag.part===3){/* turret and gun are one module: left/right turns the turret, up/down moves the gun - both applied first, then one markPose and one notification for the step */var dx=drag.locks&&drag.locks.turret?0:e.clientX-drag.x,dy=drag.locks&&drag.locks.gun?0:e.clientY-drag.y;if(self.loadedData&&(dx||dy)){var turned=dx?self.turretTo(self.turretAngle-dx*.5):null,gun=dy?self.gunTo(self.gunAngle+dy*.16):null;self.markPose();if(turned){if(self.onTurret)self.onTurret(turned);}else if(self.onGun)self.onGun(gun);}}else{self.orbitTo(self.targetYaw-(e.clientX-drag.x)*ORBIT_PER_PX,self.targetPitch+(e.clientY-drag.y)*ORBIT_PER_PX);}drag.x=e.clientX;drag.y=e.clientY; });
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
    container.addEventListener('keydown',function(e){var used=true,orbit=true;if(e.key==='ArrowLeft')self.orbitTo(self.targetYaw-.1,self.targetPitch);else if(e.key==='ArrowRight')self.orbitTo(self.targetYaw+.1,self.targetPitch);else if(e.key==='ArrowUp')self.orbitTo(self.targetYaw,self.targetPitch+.1);else if(e.key==='ArrowDown')self.orbitTo(self.targetYaw,self.targetPitch-.1);else{orbit=false;if(e.key==='+'||e.key==='='){if(e.shiftKey)self.setZoom(self.camera.zoom*1.1);else self.setDistance(Math.max(1,self.distance/1.1));}else if(e.key==='-'){if(e.shiftKey)self.setZoom(self.camera.zoom/1.1);else self.setDistance(Math.min(1500,self.distance*1.1));}else used=false;}if(used){e.preventDefault();if(!orbit&&self.aimCentred)self.settleAimSoon();}}); /* setDistance and setZoom render and report themselves */
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
  Viewer.prototype.draw=function(){if(this.contextLost||this.frameId!==null)return;var self=this;this.frameAt=clock();this.frameId=window.requestAnimationFrame(function(){try{self.countFrame();if(self.turretPending&&(!self.poseLive()||!self.previewPose()))self.applyTurret();if(self.fitPending){self.fitPending=false;self.resize();self.fit(self.zoomLock);}if(self.paintMesh)self.paint();self.renderer.render(self.scene,self.camera);self.updateReticles();}finally{self.frameId=null;}});};
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
  // The camera placed from the orbit (target, yaw, pitch, distance) and the pan, without drawing. render() starts
  // with it, and so does fit(): setPivot and the like change the orbit and fit at once, before any render, and a Fit
  // measured through the camera of the old centre put the model off screen (user 23.09, once Auto-frame, which re-zoomed
  // every frame and hid it, was off by default).
  Viewer.prototype.placeCamera=function(){var c=Math.cos(this.pitch);this.camera.position.set(this.target.x+this.distance*c*Math.sin(this.yaw),this.target.y+this.distance*Math.sin(this.pitch),this.target.z+this.distance*c*Math.cos(this.yaw));this.camera.near=Math.max(.05,this.distance*.02);this.camera.far=this.distance*4+200;this.projection();this.camera.lookAt(this.target);this.camera.updateMatrixWorld();if(this.pan.x||this.pan.y){var m=this.camera.matrixWorld,off=new THREE.Vector3().setFromMatrixColumn(m,0).multiplyScalar(this.pan.x).add(new THREE.Vector3().setFromMatrixColumn(m,1).multiplyScalar(this.pan.y));this.camera.position.add(off);this.camera.updateMatrixWorld();}};
  Viewer.prototype.render=function(){this.placeCamera();if(this.autoFrame)this.autoFit();this.draw();this.notifyCamera();};
  // ONE CAMERA REPORT PER REAL CHANGE (audit VIEW-07, 24.09). onCamera runs the page's camera handler - a dozen DOM writes,
  // the live ring, and on a new range the whole shell pipeline - and it used to run on every render(): a hit click sent it
  // six times (the page's clear(), clear() again inside load(), the rebuild with the OLD orbit centre, focus, the first
  // frames), configure() once more with a camera that had not moved. Now it is sent when something it reports has
  // changed: the orbit, the zoom, the centre, the pan, the shot range - or the ballistic engine, because a committed pose
  // reaches the page's figures this way (commitPose). While a scene loads (hold) it is sent once, at the end.
  Viewer.prototype.notifyCamera=function(){
    if(this.hold){this.heldCamera=true;return;}
    var seen=this.cameraSeen||(this.cameraSeen=new Float64Array(11)),t=this.target,range=this.shotRange(),now=[this.distance,this.camera.zoom,this.yaw,this.pitch,t.x,t.y,t.z,this.pan.x,this.pan.y,range,this.engineGen],changed=false;
    for(var i=0;i<now.length;i++)if(seen[i]!==now[i]){seen[i]=now[i];changed=true;}
    if(changed&&this.onCamera)this.onCamera({distance:this.distance,zoom:this.camera.zoom,yaw:this.yaw,pitch:this.pitch,range:range});
  };
  // The pose report (onTurret) the same way: held while a scene loads, sent once at its end.
  Viewer.prototype.notifyPose=function(state){if(this.hold){this.heldPose=state;return;}if(this.onTurret)this.onTurret(state);};
  Viewer.prototype.release=function(){
    if(--this.hold>0)return;this.hold=0;
    var pose=this.heldPose,camera=this.heldCamera;this.heldPose=null;this.heldCamera=false;
    if(pose)this.notifyPose(pose);if(camera)this.notifyCamera();
  };
  // THE SHOT RANGE (user, 24.09; audit VIEW-03): how far the shell flies to the analysed point, which is what the
  // penetration, the alpha, the heat map and every figure built on them are taken at. It is the distance from the eye to
  // the HIT POINT - not to the orbit centre, which is only where the camera turns round: switching the centre between the
  // vehicle and the hit keeps the eye where it is and so keeps this range, and after a hit click it is the recorded range
  // exactly (focus puts the eye there on the shell's axis). Without a point (a vehicle opened without a shot) it is the
  // distance to the orbit centre. Rounded to the millimetre, so the float noise of re-placing one and the same eye never
  // reads as a new range. The ONE owner of the figure: the page reads it here and nowhere else.
  Viewer.prototype.shotRange=function(){var d=this.point?this.camera.position.distanceTo(this.point):this.distance;return Math.round(d*1000)/1000;};
  // The Distance slider and field set the shot range: the camera moves along its line through the orbit centre, as it
  // always did, to the orbit distance that puts the eye `value` metres from the hit point. The eye is centre + pan +
  // d x u with u the unit view direction back from the centre, so |w + d u| = value with w = centre + pan - point, and
  // the far root is the one on the camera's side. A range the line cannot reach (the point lies further off it) takes
  // the nearest the line allows; the report then says what the range really is.
  Viewer.prototype.setShotRange=function(value){
    if(!Number.isFinite(value))return;var range=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,value));
    if(!this.point){this.setDistance(range);return;}
    this.placeCamera();var c=Math.cos(this.pitch),u=new THREE.Vector3(c*Math.sin(this.yaw),Math.sin(this.pitch),c*Math.cos(this.yaw));
    var w=this.camera.position.clone().addScaledVector(u,-this.distance).sub(this.point),b=w.dot(u),disc=b*b-(w.lengthSq()-range*range);
    this.setDistance(disc>=0?-b+Math.sqrt(disc):-b);
  };
  // The camera angles are a target the view eases towards in its own frame loop, so a rotation is time-based
  // instead of event-based: the game's browser delivers pointer events in bursts between its own frames, and
  // turning the model straight from the events made every burst a jump. setOrbit places the camera at once
  // (a load, a reset, a restored state); orbitTo asks for it and lets the loop get there.
  Viewer.prototype.setOrbit=function(yaw,pitch){this.cancelOrbit();this.yaw=this.targetYaw=yaw;this.pitch=this.targetPitch=pitch;};
  Viewer.prototype.orbitTo=function(yaw,pitch){this.targetYaw=yaw;this.targetPitch=Math.max(-1.35,Math.min(1.35,pitch));this.startOrbit();};
  // The wheel sets a target distance / frame scale / zoom; the frame loop eases towards it in log space, so a
  // burst of wheel ticks becomes one smooth glide instead of a staircase (user, 18.09). Programmatic setters
  // (setDistance, setZoom, fit, reset, focus, restoreCamera, clear) drop any pending target.
  Viewer.prototype.distanceTo=function(value){if(!Number.isFinite(value))return;this.targetDistance=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,value));this.startOrbit();};
  Viewer.prototype.scaleTo=function(value){if(!Number.isFinite(value))return;this.targetScale=Math.max(.1,Math.min(10,value));this.startOrbit();};
  Viewer.prototype.zoomTo=function(value){if(!Number.isFinite(value)||value<=0)return;this.targetZoom=Math.max(.1,Math.min(150,value));this.startOrbit();};
  Viewer.prototype.dropTargets=function(){this.targetDistance=null;this.targetScale=null;this.targetZoom=null;};
  // Whether the camera is on its way somewhere: a drag, a wheel glide or an orbit still easing. The page puts the shell off
  // while it is (the shot range now changes as the camera orbits the vehicle or pans, not only with the distance), and the
  // last step of every glide reaches its target before it reports, so the end is never taken for a move.
  Viewer.prototype.cameraGliding=function(){return !!this.dragging||this.targetDistance!==null||this.targetScale!==null||this.targetZoom!==null||this.yaw!==this.targetYaw||this.pitch!==this.targetPitch||!!this.pendingPan;};
  Viewer.prototype.cancelOrbit=function(){if(this.orbitId!==null)window.cancelAnimationFrame(this.orbitId);this.orbitId=null;};
  // After a hidden page or a lost context the easing loop is started again for whatever it had not reached: the
  // angles, and a wheel glide of the distance, frame scale or zoom - one cut short used to stay half way, and the
  // page (which waits for the end of a glide before it redoes its panels) with it.
  Viewer.prototype.resumeOrbit=function(){if(this.yaw!==this.targetYaw||this.pitch!==this.targetPitch||this.targetDistance!==null||this.targetScale!==null||this.targetZoom!==null)this.startOrbit();};
  // One easing step and one accumulated pan per browser frame. The factor follows the frame time, so the same
  // gesture takes the same wall-clock time at 47 frames/s in the game and at 130 in a desktop browser.
  // THE END OF A DISTANCE GLIDE (24.09). A distance change moves the eye, so every frame of the glide is peeled and
  // composed in full - the perspective really changes (user, 24.09) - but the easing tail used to go on for four or five
  // frames that moved nothing on screen by half a pixel, each a full composition. The glide now lands on its target as
  // soon as what is LEFT of it moves no corner of the model's box by half a pixel: the resting picture is the same one.
  // In camera space the eye goes back along its own axis, so a corner (x, y, z) goes to z - dz and its pixel by
  // f x (1/-z - 1/-(z - dz)); the lens shift (frameCenter.x / distance) moves the picture too. A corner at or behind the
  // near plane (a clinch) gives no bound, and the glide then runs to the old 1e-4 as before. Eight corners, nothing allocated.
  Viewer.prototype.dollyLeft=function(target){
    var b=this.bounds;if(!b||!this.viewHeight)return Infinity;
    var camera=this.camera,e=camera.matrixWorldInverse.elements,P=camera.projectionMatrix.elements,dz=target-this.distance,near=Math.max(.05,camera.near),worst=0,i;
    var fx=this.viewWidth/2*P[0],fy=this.viewHeight/2*P[5];
    for(i=0;i<8;i++){
      var X=i&1?b.max.x:b.min.x,Y=i&2?b.max.y:b.min.y,Z=i&4?b.max.z:b.min.z;
      var x=e[0]*X+e[4]*Y+e[8]*Z+e[12],y=e[1]*X+e[5]*Y+e[9]*Z+e[13],z=e[2]*X+e[6]*Y+e[10]*Z+e[14];
      if(-z<near||-(z-dz)<near)return Infinity;
      var k=1/-z-1/-(z-dz),d=Math.hypot(fx*x*k,fy*y*k);if(d>worst)worst=d;
    }
    return worst+Math.abs(this.frameCenter.x*camera.zoom*(1/Math.max(.001,this.distance)-1/Math.max(.001,target)))*this.viewHeight/2;
  };
  Viewer.prototype.startOrbit=function(){
    if(this.orbitId!==null||this.contextLost)return;var self=this,last=null;
    var step=function(time){
      self.orbitId=null;
      var stamp=typeof time==='number'?time:clock(),dt=last===null?16.7:Math.max(1,Math.min(100,stamp-last));last=stamp;
      var k=1-Math.pow(1-.35,dt/16.7);
      self.yaw+=(self.targetYaw-self.yaw)*k;self.pitch+=(self.targetPitch-self.pitch)*k;
      var moving=false,l;
      if(self.targetDistance!==null){l=Math.log(self.targetDistance/self.distance);if(Math.abs(l)<1e-4||self.dollyLeft(self.targetDistance)<.5){self.distance=self.targetDistance;self.targetDistance=null;}else{self.distance*=Math.exp(l*k);moving=true;}}
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
  // THE ZOOM HAS ONE OWNER (audit VIEW-02, 24.09). With Auto frame off it is camera.zoom itself. With it on, the stored
  // figure is frameScale - how much larger than the Fit of the moment the model is shown - and camera.zoom is only ever
  // derived from it, fitZoom x frameScale, by autoFit (every render) or showZoom. fitZoom is taken fresh from framing()
  // wherever frameScale is set from a zoom; it used to be read stale there, and Fit's zoom then jumped on the next render
  // (by the ratio of the old and new distances - tens of per cent in a clinch). showZoom puts a zoom on screen and nothing
  // else.
  Viewer.prototype.showZoom=function(zoom){this.camera.zoom=clampZoom(zoom);this.projection();this.draw();this.notifyCamera();};
  Viewer.prototype.scaleFor=function(zoom){var f=this.framing();if(f)this.fitZoom=f.zoom;this.frameScale=clampZoom(zoom)/Math.max(.1,this.fitZoom);};
  Viewer.prototype.setZoom=function(value){if(!Number.isFinite(value)||value<=0)return;this.targetZoom=null;this.targetScale=null;if(this.autoFrame)this.scaleFor(value);this.showZoom(value);};
  Viewer.prototype.setDistance=function(value){if(!Number.isFinite(value))return;this.targetDistance=null;this.distance=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,value));this.render();};
  Viewer.limits={distanceMin:DISTANCE_MIN,distanceMax:DISTANCE_MAX};
  Viewer.prototype.clear=function(){this.dropTargets();this.clearLiveAim();this.clearHitMarks();this.look=null;this.markDrawn=this.markBuilt=null;this.pinResult=null;this.fitPending=false;this.shotPoints=null;this.shotPath=null;this.horizon=null;this.recordedDistance=null;this.pinned=null;this.disposePin();this.pinCache=null;this.pinReticles=[];if(this.surface)this.surface.dispose();this.surface=null;this.surfaceAttempted=false;this.surfaceError=null;this.gunAngle=0;this.savedAim=this.ringAim=this.discAim=this.shotDisc=null;this.viewPoints=null;this.aimGroup=null;this.estimateAim=null;this.reticles=[];this.reticleLayer.replaceChildren();clearTimeout(this.turretTimer);this.turretTimer=null;this.turretPending=false;this.poseGeometries=null;this.poseBuilt=null;this.poseStale=false;this.spreadAim=null;this.hideSpread();window.clearTimeout(this.aimSettleTimer);this.aimSettleTimer=null;window.cancelAnimationFrame(this.frameId);this.frameId=null;this.cancelHover();this.cancelOrbit();this.pendingPan=null;this.inspectKey=null;this.paintMesh=null;this.outline=null;this.outlineDepth=null;this.engine=null;this.trackGroup=null;this.trackMesh=null;this.trackTriangles=[];this.loadedData=null;this.paintedKey=null;this.samples=[];var disposed=new Set([this.ringGeom]),kept=this.ringMat;this.root.traverse(function(o){var shared=!!(o.parent&&o.parent.type==='ArrowHelper'&&(o===o.parent.line||o===o.parent.cone));if(o.geometry&&!shared&&!disposed.has(o.geometry)){disposed.add(o.geometry);o.geometry.dispose();}if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(function(m){if(m!==kept)m.dispose();});}});while(this.root.children.length)this.root.remove(this.root.children[0]);this.point=null;this.travel=null;this.draw();};
  // clear() draws the empty scene and tells the page nothing: the camera has not moved, and the next load() reports once.
  Viewer.prototype.rebuild=function(){
    if(!this.loadedData)return;var T=THREE,self=this;this.samples=[];this.paintedKey=null;
    // A failed composition is retried on the next rebuild (pose or model) instead of staying off for good.
    if(!this.surface&&this.surfaceAttempted){this.surfaceAttempted=false;}
    this.engine=ArmorBallistics.build(this.posedData||this.loadedData,false);this.engineGen++;
    // Meshes serve picking, vehicle-parts display and neutral unavailable geometry.
    // The chance map is composed from GPU depth layers, without triangle sampling.
    this.samples=this.engine.triangles.filter(function(t){return !externalLayer(t);});
    this.updateTracks();
    if(this.surface){try{this.surface.update(this.engine);}catch(e){this.surface.dispose();this.surface=null;this.surfaceError=e.message;}}
    var positions=[],colors=[];this.samples.forEach(function(t){[t.a,t.b,t.c].forEach(function(v){positions.push(v[0],v[1],v[2]);colors.push(.25,.32,.38);});});
    var geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(positions,3));geom.setAttribute('color',new T.Float32BufferAttribute(colors,3).setUsage(T.DynamicDrawUsage));
    if(this.paintMesh){this.paintMesh.geometry.dispose();this.paintMesh.geometry=geom;}else{this.paintMesh=new T.Mesh(geom,new T.MeshBasicMaterial({vertexColors:true,side:T.DoubleSide}));this.root.add(this.paintMesh);}
    this.updateOutline();
    this.capturePose();
    // The parts' own frames for the Hitmarks: the engine and the drawn model now stand in the same pose.
    this.markBuilt=this.markDrawn=this.markFrames(this.poseBuilt);this.poseHitMarks();
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
    if(!this.trackMesh)return;var key=(this.look?'look:'+this.look.kind+':'+this.look.part:this.heatmap?'map':'parts')+'|'+this.trackOpacity;if(this.trackKey===key)return;this.trackKey=key;
    var self=this,attribute=this.trackMesh.geometry.attributes.color,buffer=attribute.array,map=this.heatmap&&!this.look;
    this.trackTriangles.forEach(function(t,i){
      var opacity=map?self.trackOpacity:1;
      var color=self.look?self.lookColor(t,i+LOOK_TRACKS):map?baseColors[0]:baseColors[t.part%4];
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
  // How deep the soft shading is: 1 is what the feature shipped with, 0 flat, above 1 more contrast. Kept
  // here so a new Surface (a new model, a quality change, a restored context) is given it again.
  Viewer.prototype.setLightStrength=function(value){
    this.lightStrength=Math.max(0,Math.min(4,Number(value)||0));
    if(this.surface&&this.surface.setLightStrength){try{this.surface.setLightStrength(this.lightStrength);}catch(e){this.surfaceError=e.message;}}
    this.draw();
  };
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
  // THE CLIENT HOLDS A STATIC TURRET AND GUN STILL (23.09, outputs/second-modes-2026-09-23.md 5.2 p. 8). Fourteen tank
  // destroyers carry gun.staticTurretYaw (six of them staticPitch too); the garage draws them in that pose and its armour
  // view does not let them be dragged (armor_sub_presenter._ModulesMover, setDragModuleMode(False)) - nor does this one.
  // The angles ride in the target's pitch table (a record since the build after 0.7.31) or at the top of an exported
  // vehicle's file; the recorded pose of a hit is left as it is.
  Viewer.prototype.poseLocks=function(){
    var hit=this.loadedData&&this.loadedData.hit,t=hit&&hit.target||{},info=t.gunPitchLimits||{};
    var has=function(k){var v=info[k]!==undefined&&info[k]!==null?info[k]:t[k];return v!==undefined&&v!==null&&isFinite(Number(v));};
    return {turret:has('staticTurretYaw'),gun:has('staticPitch')};
  };
  // ONE PICKING SERVICE (audit VIEW-05, 24.09). Where a ray meets the drawn model - the painted armour and the tracks, the
  // very surfaces the map is drawn on - was asked in nine places, each with its own list of meshes and its own linear
  // three.js raycast (0.15-1 ms a mesh; the hover, the turret chase and the hull turn cast one each on every frame of the
  // emulation). pick() is the only one now: the first contact along (origin, direction), as three reports it (point,
  // distance, face, faceIndex, object) plus `part`, the collision part of the triangle, or null. It asks a three-mesh-bvh
  // tree built once per geometry (pickTree; the library is on the page for the ricochet leg already): `indirect`, so the
  // geometry is not re-indexed and faceIndex stays the triangle's own record (samples / trackTriangles). A pose that is
  // only previewed moves the vertices under a tree built for the old ones, so it drops the trees (previewPose) and the
  // linear raycast answers until the pose is committed and the new geometry is asked again.
  var pickRay=null,pickInverse=null;
  Viewer.prototype.pickMeshes=function(){var list=[];if(this.paintMesh)list.push(this.paintMesh);if(this.trackMesh)list.push(this.trackMesh);return list;};
  Viewer.prototype.pickTree=function(mesh){
    var geometry=mesh.geometry,lib=window.MeshBVHLib;if(!geometry)return null;if(geometry.boundsTree)return geometry.boundsTree;
    if(this.poseStale||!lib||!lib.MeshBVH)return null;
    try{geometry.boundsTree=new lib.MeshBVH(geometry,{indirect:true});}catch(e){console.warn('Picking tree unavailable:',e.message);return null;}
    return geometry.boundsTree;
  };
  Viewer.prototype.dropPickTrees=function(){this.pickMeshes().forEach(function(m){if(m.geometry&&m.geometry.boundsTree)m.geometry.boundsTree=null;});};
  Viewer.prototype.pick=function(origin,direction){
    var T=THREE,meshes=this.pickMeshes(),best=null,i;if(!meshes.length)return null;
    if(!pickRay){pickRay=new T.Ray();pickInverse=new T.Matrix4();}
    for(i=0;i<meshes.length;i++){
      var mesh=meshes[i],tree=this.pickTree(mesh),hit=null;
      if(tree){
        pickRay.set(origin,direction).applyMatrix4(pickInverse.copy(mesh.matrixWorld).invert());
        hit=tree.raycastFirst(pickRay,mesh.material);
        if(hit){hit.point.applyMatrix4(mesh.matrixWorld);hit.distance=hit.point.distanceTo(origin);hit.object=mesh;}
      }
      else hit=new T.Raycaster(origin,direction).intersectObject(mesh,false)[0]||null;
      if(hit&&(!best||hit.distance<best.distance))best=hit;   // a tie stays with the painted armour, as three's sort kept it
    }
    if(best)best.part=this.partOf(best);
    return best;
  };
  Viewer.prototype.pickPart=function(event){if(event.shiftKey||!this.paintMesh)return 1;var ray=this.pointerRay(event).ray,hit=this.pick(ray.origin,ray.direction);if(!hit)return false;return hit.part===undefined?1:hit.part;};
  // The part a raycast hit on the drawn model belongs to: the drawn meshes are built one entry of samples /
  // trackTriangles per triangle, so the face index is the triangle's own record. undefined for anything else.
  Viewer.prototype.partOf=function(hit){var list=hit.object===this.trackMesh?this.trackTriangles:this.samples,t=list&&list[hit.faceIndex];return t?t.part:undefined;};
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
  // about its OWN vertical axis through its origin, the gun pitches about its own axis afterwards.
  // THE TILTED RING (BACKLOG 40, 23.09). Eight vehicles sit their turret on a ring tilted against the hull - Kunze
  // Panzer 5.26°, Kpz 3 GST Turm 8°, CC 3 and CC 3 7x7 3°, Controcarro 1 Mk. 2 6.47°, CC mod. 64 4°, CC-67 B 11.07°,
  // Object 168N 1.55° (hull turretPitches, docs/KNOWLEDGE.md 4). The client's collision assembly puts the turret node
  // at that pitch and turns the turret RotateY(yaw) UNDER it (model_assembler.attachModels), so the turret's recorded
  // matrix is hull x T x tilt x RotateY(yaw): its own up axis IS the ring's, whatever the yaw, and a turn about it gives
  // exactly hull x T x tilt x RotateY(yaw + turn). The hull's vertical, used until 23.09, carried the tilt round with
  // the turret instead - after half a turn it leaned 2 x turretPitch the wrong way. On every other vehicle the two
  // axes are the same one. A turret with a degenerate matrix falls back to the hull's vertical.
  Viewer.prototype.poseExtra=function(){
    if(!this.loadedData)return null;var T=THREE,source=this.loadedData,parts=source.hit.target.parts,turret=parts.find(function(p){return p.id===2;}),hull=parts.find(function(p){return p.id===1;});if(!turret||!turret.transform)return null;
    var own=new T.Matrix4().fromArray(turret.transform),pivot=new T.Vector3().setFromMatrixPosition(own),axis=new T.Vector3(0,1,0).transformDirection(own);if(!(axis.lengthSq()>.5)){axis.set(0,1,0);if(hull&&hull.transform)axis.transformDirection(new T.Matrix4().fromArray(hull.transform));}
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
    this.dropPickTrees();   // their bounds are the old pose's: pick() goes linear until the commit builds new geometry
    if(this.surface&&this.surface.pose)this.surface.pose(delta);
    this.markDrawn=this.markFrames(extra);this.poseHitMarks();   // the marks go with their turret and gun: two matrices, no vertex
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
  // One report of the camera and one of the pose for the whole load, sent at its end (release): the rebuild inside used
  // to report the camera with the OLD orbit centre, and the pose was reported twice unchanged (VIEW-07).
  Viewer.prototype.load=function(data,context){this.hold++;try{return this.loadScene(data,context);}finally{this.release();}};
  Viewer.prototype.loadScene=function(data,context){
    this.clear();if(data.geometryIncomplete){this.bounds=null;this.render();return false;}var T=THREE,self=this;var hit=data.hit, parts=(hit.target||{}).parts||[], transforms={};
    parts.forEach(function(part){if(part.transform)transforms[part.id]=new T.Matrix4().fromArray(part.transform);});
    var range=context&&context.range;this.recordedDistance=Number.isFinite(range)&&range>0?range:Number.isFinite(hit.rangeAtImpact)&&hit.rangeAtImpact>0?hit.rangeAtImpact:null;
    this.loadedData=data;this.posedData=null;this.poseBuilt=null;this.turretAngle=0;this.gunAngle=0;this.rebuild();
    this.root.updateMatrixWorld(true);
    var box=new T.Box3().setFromObject(this.root);this.bounds=box.isEmpty()?null:box;this.centre=this.vehicleCentre();
    var pts=Viewer.points(hit,context);pts.forEach(function(p){self.addReticle(p.pos);});
    // shotPath: the shell's flight carried onto the first point (Viewer.shellPath), null without a tracer; focus()
    // stands the camera at its origin, the horizon and the page's marks read it.
    this.shotPoints=pts;this.shotPath=pts.path||null;this.drawTracers(pts);if(pts.length){this.point=pts[0].pos.clone();this.travel=pts[0].line.clone();}
    this.drawHorizon(hit.target&&hit.target.worldTransform);
    // The tracers and marks of this hit have just been added to the root: with the aim emulation running
    // they must not be on screen at all, so the recorded rule is applied to them here and not only when
    // the pose or the pin changes.
    this.syncRecorded();
    if(this.bounds)this.grid.position.y=this.bounds.min.y-.025;if(this.point)this.focus();else this.reset();this.notifyPose({angle:0,min:-180,max:180,known:this.gunRange().known});return !!this.bounds;
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
    // The orbit distance, not the eye's distance to the centre: a pan moves the eye sideways, and with Auto frame the
    // model used to "breathe" as it was panned (VIEW-02). projection() reads the same distance.
    if(!this.bounds)return null;var camera=this.camera,sphere=this.bounds.getBoundingSphere(new THREE.Sphere()),radius=Math.max(.5,sphere.radius*.7);
    var distance=Math.max(radius*1.05,this.distance),tangent=Math.tan(camera.fov*Math.PI/360);
    var vertical=2*radius/(distance*tangent),horizontal=vertical/Math.max(.1,camera.aspect);
    return {zoom:clampZoom(1.72/Math.max(horizontal,vertical,.001))};
  };
  Viewer.prototype.autoFit=function(){var frame=this.framing();if(!frame)return;this.fitZoom=frame.zoom;this.camera.zoom=clampZoom(this.fitZoom*this.frameScale);this.projection();};
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
  // vehicle. Fit never moves the camera, a clinch record included: it only zooms (user, 23.09 - backing a 5 m
  // record off to twice the model's radius along the view line took the camera off the shell's axis).
  // keepZoom: the framing of a newly shown shot under Zoom lock (user, 25.09) - the vehicle is centred as always, the
  // zoom the user set stays. The Fit button always picks the zoom.
  var FIT_TOP_BAND=.12,FIT_BOTTOM_BAND=.12,FIT_MARGIN=.08;
  Viewer.prototype.fit=function(keepZoom){this.dropTargets();
    var tris=(this.engine||{}).triangles||[];if(!tris.length)return;var cam=this.camera,held=cam.zoom,v=new THREE.Vector3(),local=new THREE.Vector3(),i,k,t;
    cam.zoom=1;this.frameCenter.set(0,0);this.placeCamera();
    var all=[Infinity,-Infinity,Infinity,-Infinity],main=[Infinity,-Infinity,Infinity,-Infinity];
    function grow(box,x,y){if(x<box[0])box[0]=x;if(x>box[1])box[1]=x;if(y<box[2])box[2]=y;if(y>box[3])box[3]=y;}
    for(i=0;i<tris.length;i++){t=tris[i];var isMain=!!(t.armor&&t.armor.vehicleDamageFactor>0);
      for(k=0;k<3;k++){v.fromArray(k===0?t.a:k===1?t.b:t.c);local.copy(v).applyMatrix4(cam.matrixWorldInverse);if(local.z>-.5)continue;v.project(cam);grow(all,v.x,v.y);if(isMain)grow(main,v.x,v.y);}}
    if(all[0]===Infinity){if(keepZoom)this.showZoom(held);return;}if(main[0]===Infinity)main=all;
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
    var zoom=keepZoom?held:Math.max(.1,Math.min(150,Math.min(limit(main,FIT_MARGIN),limit(all,0))));
    this.frameCenter.set(midY*this.distance,centreY);
    this.scaleFor(zoom);this.showZoom(zoom);
  };
  // Switching auto-frame on holds the size that is on screen right now: the scale is taken from a fresh framing.
  Viewer.prototype.setAutoFrame=function(value){this.dropTargets();this.autoFrame=!!value;if(this.autoFrame)this.scaleFor(this.camera.zoom);this.render();};
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
  // Where the record view stands: the shell's own origin (shotPath), or - for an own shot, by the lab's View from - the
  // gun at the press (the solid ring's apex) or the server's gun then (the dashed ring's apex). `picked`: only a point the
  // pick names, null when it names the shot. Other hits and records without those points: the shot.
  Viewer.prototype.viewEye=function(picked){
    var p=this.viewPoints,own=this.viewFrom!=='fired'&&p&&p[this.viewFrom];
    if(own)return own;if(picked)return null;return this.shotPath?this.shotPath.origin:null;
  };
  Viewer.prototype.setViewFrom=function(mode){this.viewFrom=mode==='gun'||mode==='server'?mode:'fired';if(this.point&&this.recordedShown())this.focus();};
  // The recorded view: the camera stands on the shell's axis at the recorded range — where the shooter was — and
  // looks at the orbit centre. With the hit point as centre that is exactly the shell's line of flight; with the
  // vehicle centre the camera still stands on the axis and merely turns towards the hull (no parallel shift).
  // The axis is the shell's own when the tracer gives it (shotPath): the eye stands where the shell left, carried
  // onto the hit like the flight itself - on the chord from the hit to that origin (shot-line-true, 24.09: the segment
  // line at the tracer's range stood 0.49 / 2.42 m off the real origin, median / p90, in the target's server frame of
  // the replay; this 0.35 / 2.07). Without it the recorded line at the recorded range, as before.
  Viewer.prototype.focus=function(){if(!this.point)return;this.dropTargets();this.pan.set(0,0);this.frameCenter.set(0,0);this.pivotHeight=null;
    var eye=this.viewEye(),back=eye?eye.clone().sub(this.point):null,far=back?back.length():0;
    var dir=far>1e-6?back.divideScalar(far):this.travel.clone().negate().normalize(),range=Math.max(DISTANCE_MIN,Math.min(DISTANCE_MAX,far>1e-6?far:this.recordedDistance||this.defaults.distance));
    this.target.copy(this.pivot==='vehicle'?this.pivotCentre():this.point);
    // A point-blank record puts the eye closer to the centre than the orbit allows: it goes further back along
    // the axis itself (the far root of |point + dir*t - target| = DISTANCE_MIN), so it is clamped onto the line.
    var w=this.point.clone().sub(this.target),b=w.dot(dir),disc=b*b-(w.lengthSq()-DISTANCE_MIN*DISTANCE_MIN);
    if(w.clone().addScaledVector(dir,range).length()<DISTANCE_MIN&&disc>=0)range=Math.max(range,-b+Math.sqrt(disc));
    var eye=this.point.clone().addScaledVector(dir,range);this.lookFrom(eye);this.distanceSet=true;this.fitPending=true;this.render();};
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
  Viewer.prototype.configure=function(shell,heatmap,palette,mode){this.shell=shell;this.heatmap=heatmap;this.palette=palette;this.mapMode=mode==='damage'?'damage':'chance';this.inspectKey=null;if(this.pinned)this.refreshPin();this.updateTrackAppearance();this.draw();}; // the camera has not moved: a frame, no report
  // A pinned point replaces the recorded hit line as the analysed shot until unpinned. It is drawn like a
  // recorded shot: an arrow along the line, a reticle at the point, and a dashed leg where a ricochet goes.
  Viewer.prototype.pinAt=function(event){
    if(!this.engine)return;var caster=this.pointerRay(event),hit=this.pick(caster.ray.origin,caster.ray.direction);
    if(!hit)return;var normal=hit.face?hit.face.normal.clone().transformDirection(hit.object.matrixWorld):null;
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
  // `context` (ArmorShotContext.resolve) is optional: with the hit's tracer and its server stop the first point's line
  // is the shell's own flight (Viewer.shellPath) and pts.path carries it; without them the chain rule alone, as before.
  // The page's view and its verdict log both come here, so the line drawn and the line judged are one.
  Viewer.points=function(hit,context){
    var T=THREE,transforms={};((hit&&hit.target||{}).parts||[]).forEach(function(part){if(part.transform)transforms[part.id]=new T.Matrix4().fromArray(part.transform);});
    // pi: the point's index in hit.points (the log's point= counts resolved points only); hitType as recorded.
    var pts=[];((hit&&hit.points)||[]).forEach(function(p,pi){if(p.status!=='resolved'||!transforms[p.part]||!p.position||!p.direction)return;var pos=new T.Vector3().fromArray(p.position).applyMatrix4(transforms[p.part]);pos.z*=-1;var direction=new T.Vector3().fromArray(p.direction).transformDirection(transforms[p.part]).normalize();direction.z*=-1;pts.push({pos:pos,dir:direction,effect:p.effect,part:p.part,pi:pi,hitType:p.hitType,source:'segment',chordDev:null,line:direction.clone(),stretch:null});});
    Viewer.chain(pts);
    var path=pts.length?Viewer.shellPath(pts,context,hit&&hit.target&&hit.target.worldTransform):null;
    if(path){pts[0].line=path.tangent.clone();pts[0].source='tracer';}
    pts.path=path;
    return pts;
  };
  /* The shell's own flight to the first contact (shot-line-true, user 24.09; outputs/wg-mechanics-check-2026-09-24.md).
     The server flies a shell on the tracer's parabola X(t) = origin + velocity·t + ½·(0, −gravity, 0)·t², no drag, and
     stops it at S (stopTracer) 6 mm from that path. The recorded point I is the server's contact laid on the pose the game
     DREW; on the move that pose stands up to metres from the server's (|I − S|), mostly along the hull - the game's
     lag, not ours. So the path is carried onto I: every point is I + Rm·(X(t) − S) in the target's frame (I: the contact
     the shell stopped at, the one nearest S; drawn up to the first contact). The mark stays
     on the armour where the server hit the part, and the flight reaches it from where the shooter really was.
     Rm: the drawn pose may also be TURNED against the server's (0.5° median, 4° p90, turning vehicles). The recorded
     segment is the server's own direction in the part's frame, quantised (0.48° median). Where the tracer's tangent,
     carried through the drawn pose, and the segment agree within TURN_TRUST (the segment's median quantisation), the
     tracer is taken as is; beyond that the whole flight is turned about I until it is TURN_TRUST from the segment.
     Replay of 24.09 (132 hits, server pose known), against the true origin in the target's server frame: camera
     0.49 / 2.42 m (median / p90, the segment line at the tracer's range) -> 0.35 / 2.07; direction at I 0.52° / 1.54°
     -> 0.44° / 1.26°; the tracer taken as is would be 0.42 / 6.75 m (a turned pose is carried whole).
     Built once per hit: PATH_STEPS chords of the arc, no per-frame work. Null without a tracer, its stop or the target's
     world pose - then the segment line stands, as before. */
  var TURN_TRUST=.5*Math.PI/180,PATH_STEPS=24;
  Viewer.shellPath=function(pts,context,worldTransform){
    var T=THREE,tracer=context&&context.tracer,stop=context&&context.stop,first=pts&&pts[0];
    if(!first||!tracer||!stop||!Array.isArray(worldTransform)||!Array.isArray(tracer.origin)||!Array.isArray(tracer.velocity)||!Array.isArray(stop.position))return null;
    var g=Number(tracer.gravity)>0?Number(tracer.gravity):0,o=new T.Vector3().fromArray(tracer.origin),v=new T.Vector3().fromArray(tracer.velocity),S=new T.Vector3().fromArray(stop.position);
    if(!(v.lengthSq()>1e-6))return null;
    function at(t){return o.clone().addScaledVector(v,t).add(new T.Vector3(0,-.5*g*t*t,0));}
    // The flight time of the closest approach to S: Newton on (X(t) − S)·X'(t) = 0 from the straight-line guess.
    var t=Math.max(0,S.clone().sub(o).dot(v)/v.lengthSq());
    for(var k=0;k<20;k++){var X=at(t),V=v.clone().add(new T.Vector3(0,-g*t,0)),f=X.clone().sub(S).dot(V),df=V.lengthSq()-X.clone().sub(S).y*g;if(!(Math.abs(df)>1e-12))break;var dt=-f/df;t=Math.max(0,t+dt);if(Math.abs(dt)<1e-9)break;}
    if(!(t>0))return null;
    var inverse=new T.Matrix4().fromArray(worldTransform).invert();
    function local(p){var q=p.clone().applyMatrix4(inverse);q.z*=-1;return q;}
    var Sl=local(S),tangent=local(S.clone().add(v.clone().add(new T.Vector3(0,-g*t,0)))).sub(Sl).normalize();
    // The turn that brings the tracer's tangent to within TURN_TRUST of the recorded line (first.line: the segment, or
    // the chord to the next point where the chain rule took it).
    var ref=first.line.clone().normalize(),angle=tangent.angleTo(ref),turn=new T.Quaternion(),turned=0;
    if(angle>TURN_TRUST){var axis=new T.Vector3().crossVectors(tangent,ref);if(axis.lengthSq()>1e-18){turned=angle-TURN_TRUST;turn.setFromAxisAngle(axis.normalize(),turned);}}
    // S is carried onto the contact the shell stopped at - the point nearest to it (a screen-then-armour hit often stops
    // at the last; review 24.09) - and the flight is drawn to the FIRST contact, where the arrow and the camera's axis are:
    // up to the time it reached that one (the stretch between the two at the tangent's speed). The pose gap is measured
    // at the stop's own contact.
    var stopAt=pts.reduce(function(b,p){return p.pos.distanceTo(Sl)<b.pos.distanceTo(Sl)?p:b;},first);
    function carry(p){return local(p).sub(Sl).applyQuaternion(turn).add(stopAt.pos);}
    var reach=Math.max(0,t-stopAt.pos.distanceTo(first.pos)/Math.max(1e-6,v.clone().add(new T.Vector3(0,-g*t,0)).length()));
    var points=[];for(var i=0;i<=PATH_STEPS;i++)points.push(i===PATH_STEPS?first.pos.clone():carry(at(reach*i/PATH_STEPS)));
    var origin=points[0].clone();
    return {points:points,origin:origin,tangent:tangent.applyQuaternion(turn).normalize(),angle:angle,turned:turned,gap:stopAt.pos.distanceTo(Sl),along:Math.abs(stopAt.pos.z-Sl.z),
      stopLocal:Sl,time:t,length:origin.distanceTo(first.pos),tracer:tracer};
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
  /* The FULL TRACER (user, 24.09): with the tracer's flight known (pts.path) the shell's whole path is drawn in place of the
     2.3 m stub - a dashed line along the arc from where it left to the first contact (the drop it really had, up to a metre
     at 300+ m), a dot where it started and an arrowhead at the hit. Made once per hit from the path's PATH_STEPS chords; the
     dashes scale with the flight's length so a 300 m arc is not thousands of them. Stretches after the first contact
     (screens, ricochet continuations) stay as they were drawn. Without a path: the stub, as before. */
  var DOT_PX=7;
  Viewer.prototype.drawTracers=function(pts){
    var T=THREE,path=pts.path;
    if(path){var length=Math.max(path.length,1e-3),dash=Math.max(.15,Math.min(5,length/60));
      var arc=new T.Line(new T.BufferGeometry().setFromPoints(path.points),new T.LineDashedMaterial({color:TRACER,dashSize:dash,gapSize:dash*.6,transparent:true,opacity:.9,depthTest:false,depthWrite:false}));
      arc.computeLineDistances();arc.renderOrder=4;arc.frustumCulled=false;arc.userData.shotArc=true;this.root.add(arc);
      var start=startDot(path.origin,new T.Color(TRACER),DOT_PX,false);start.userData.shotArc=true;this.root.add(start);
      this.root.add(arrowHead(pts[0].pos,pts[0].line,TRACER));}
    for(var i=0;i<pts.length;i++){var p=pts[i];
      if(!i){if(!path)this.root.add(this.shotSegment(p.pos.clone().addScaledVector(p.line,-ARROW_LENGTH),p.pos,TRACER,false));}
      else if(p.stretch)this.root.add(this.shotSegment(p.stretch.from,p.stretch.to,TRACER,p.stretch.dashed));}
  };
  // An arrowhead alone at `tip` along `dir` (the full tracer's end): three's ArrowHelper with its shaft hidden, so the head
  // is the same cone as every other arrow of the scene (its geometry shared, never freed by clear()).
  function arrowHead(tip,dir,color){
    var head=.12,arrow=new THREE.ArrowHelper(dir.clone().normalize(),tip.clone().addScaledVector(dir.clone().normalize(),-head),head,color,head,.045);
    arrow.line.visible=false;[arrow.line.material,arrow.cone.material].forEach(function(m){m.depthTest=false;m.depthWrite=false;m.transparent=true;m.opacity=1;});
    arrow.cone.renderOrder=4;arrow.cone.frustumCulled=false;arrow.userData.shotArc=true;return arrow;
  }
  // A round dot of `px` screen pixels at `at` (a tracer's start, a ring axis' apex): one point with a disc sprite; `hollow`
  // draws a ring instead (the dashed ring's apex). The two sprites are made once for the page and kept (clear() frees the
  // materials, never a map). No depth test: a start point stays readable over the model, like the tracers.
  var dotMaps={};
  function dotMap(hollow){
    var key=hollow?'ring':'disc';if(dotMaps[key])return dotMaps[key];
    var n=32,data=new Uint8Array(n*n*4);
    for(var y=0;y<n;y++)for(var x=0;x<n;x++){var r=Math.hypot(x+.5-n/2,y+.5-n/2)/(n/2),k=(y*n+x)*4,on=hollow?r<=1&&r>=.55:r<=1;data[k]=data[k+1]=data[k+2]=255;data[k+3]=on?255:0;}
    var t=new THREE.DataTexture(data,n,n);t.needsUpdate=true;return dotMaps[key]=t;
  }
  function startDot(at,colour,px,hollow){
    var dot=new THREE.Points(new THREE.BufferGeometry().setFromPoints([at.clone()]),new THREE.PointsMaterial({color:colour,size:px,sizeAttenuation:false,map:dotMap(hollow),
      transparent:true,alphaTest:.5,depthTest:false,depthWrite:false}));
    dot.renderOrder=4;dot.frustumCulled=false;return dot;
  }
  /* The world's horizontal beside the grid (shot-line-true, user 24.09; outputs/wg-mechanics-check-2026-09-24.md §6, §10.2).
     The grid lies on the target's tracks, so a tilted target tilts the whole scene with it: a shooter below the grid
     seems to fire "from under the ground" when the target merely stood on a slope. A dashed square of the grid's size,
     through the grid's centre, level in the world, shows how the target stood. Drawn only where it explains something:
     with the page's height mark (the shooter HEIGHT_MARK or more below the tracks) and a lean of HORIZON_MIN or more.
     Not for every lean: 81 % of the hits with a tracer lean 1° or more, 42 % 5° or more (review 24.09), and there the
     scene misleads nobody. Made once per hit; it belongs to the recorded target's pose, so a pin or a turned turret
     leaves it where it is (syncRecorded skips it). */
  var HORIZON_MIN=1*Math.PI/180,HORIZON_COLOR=0xd8b56a,HEIGHT_MARK=.5;
  Viewer.prototype.drawHorizon=function(worldTransform){
    this.horizon=null;if(!Array.isArray(worldTransform)||!this.bounds)return;var T=THREE;
    var up=new T.Vector3(0,1,0).transformDirection(new T.Matrix4().fromArray(worldTransform).invert());up.z*=-1;up.normalize();
    var base=new T.Vector3(0,this.bounds.min.y-.025,0),tilt=up.angleTo(new T.Vector3(0,1,0));
    this.horizon={up:up,base:base,tilt:tilt,line:null};
    var height=this.shooterHeight();if(tilt<HORIZON_MIN||!height||!height.below)return;
    var e1=new T.Vector3(1,0,0).addScaledVector(up,-up.x);if(e1.lengthSq()<1e-6)e1.set(0,0,1).addScaledVector(up,-up.z);e1.normalize();
    var e2=new T.Vector3().crossVectors(up,e1),h=12,corners=[[1,1],[-1,1],[-1,-1],[1,-1],[1,1]].map(function(c){return base.clone().addScaledVector(e1,c[0]*h).addScaledVector(e2,c[1]*h);});
    var line=new T.Line(new T.BufferGeometry().setFromPoints(corners),new T.LineDashedMaterial({color:HORIZON_COLOR,dashSize:.5,gapSize:.35,transparent:true,opacity:.6}));
    line.computeLineDistances();line.userData.horizon=true;this.root.add(line);this.horizon.line=line;
  };
  // Where the shooter stood against the target, from the tracer's origin carried onto the hit (shotPath): `grid` is its
  // height over the plane of the target's tracks (what the scene shows), `world` over the target's base, straight up in
  // the world; `tilt` = grid - world is what the target's own lean adds. `below`: HEIGHT_MARK or more under the tracks -
  // the page's height mark and the level square (smaller depths read as noise: 130 of the 21.8 % below the tracks were
  // under 0.5 m, 12 would have read "0.0 m"). Null without a tracer. Read on demand, never stored.
  Viewer.prototype.shooterHeight=function(){
    var path=this.shotPath,hz=this.horizon;if(!path||!hz)return null;
    var rel=path.origin.clone().sub(hz.base),grid=rel.y,world=rel.dot(hz.up);
    return {grid:grid,world:world,tilt:grid-world,angle:hz.tilt,range:path.length,below:grid<=-HEIGHT_MARK};
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
      return {index:i,part:p.part,effect:p.effect,pi:p.pi,hitType:p.hitType,prevEffect:prev?prev.effect:null,source:p.source,chordDev:p.chordDev,result:result};});
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
      result=this.shell&&this.engine?this.engine.ray(p.origin.toArray(),p.direction.toArray(),this.shell):null;cast=true;this.pinResult=result;
      if(pinLeg(result)===cache.leg){this.syncRecorded();this.draw();return;}
      point=cache.contact;
    }
    this.disposePin();this.pinCache=null;
    this.pinReticles.forEach(function(r){r.element.remove();});this.reticles=this.reticles.filter(function(r){return !r.pinned;});this.pinReticles=[];
    this.syncRecorded();
    if(!p){this.pinResult=null;return;}
    // The line is fixed in the world; the vehicle under it may have been posed since the click, so find the contact again.
    var contact;
    if(point===undefined){var met=this.pick(p.origin,p.direction);contact=met?met.point.clone():null;}
    else contact=point?point.clone():null;
    // The verdict of this line, kept for the page: the fun layer rolls its outcome and its damage out of
    // THIS result (viewer.pinResult), so an emulated shot never casts or evaluates a second ray.
    if(!cast){result=this.shell&&this.engine?this.engine.ray(p.origin.toArray(),p.direction.toArray(),this.shell):null;this.pinResult=result;}
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
    // The mode on: an EMULATED shot marks its impact with a Hitmark on the armour instead of the cross
    // (user, 22.09 - a burst of crosses turns the model into mush). A pin the user made himself keeps its
    // cross, and so does the marker at the end of a ricochet leg, which is never one of a pile.
    if(contact&&!(this.hitMarks&&this.aimPinned))this.pinReticleAt(contact,'pinned');
    this.draw();
  };
  Viewer.prototype.pinReticleAt=function(position,classes){
    this.addReticle(position);var r=this.reticles[this.reticles.length-1];r.pinned=true;classes.split(' ').forEach(function(c){r.element.classList.add(c);});this.pinReticles.push(r);
  };
  Viewer.prototype.unpin=function(){this.pinned=null;this.refreshPin();this.showSavedAim(aimShown());if(this.onPin)this.onPin(false);this.draw();};
  // Recorded markers (arrows, reticles, aim circles) belong to the saved pose and the saved shot: an explored
  // pose or a pinned shot replaces them until the user returns.
  // The recorded pose, to the viewer's one threshold: the marks, the line's figure and the ring integrals all ask this.
  Viewer.prototype.recordedPose=function(){return Math.abs(this.turretAngle)<.001&&Math.abs(this.gunAngle)<.001;};
  Viewer.prototype.recordedShown=function(){return aimShown()&&this.recordedPose()&&!this.pinned;};
  Viewer.prototype.syncRecorded=function(){var show=this.recordedShown();this.root.children.forEach(function(o){if(o!==this.paintMesh&&o!==this.trackGroup&&o!==this.outline&&o!==this.outlineDepth&&o!==this.aimGroup&&!o.userData.horizon)o.visible=show;},this);};
  Viewer.prototype.shotProbability=function(shell){
    if(this.pinned&&this.engine&&shell)return this.engine.ray(this.pinned.origin.toArray(),this.pinned.direction.toArray(),shell);
    if(!this.engine||!this.point||!this.travel||!shell||!this.recordedPose())return null;
    var span=this.bounds?this.bounds.getSize(new THREE.Vector3()).length():20;
    return this.engine.ray(this.point.clone().addScaledVector(this.travel,-span*2-2).toArray(),this.travel.toArray(),shell);
  };
  Viewer.prototype.setShotContext=function(context){
    var T=THREE,self=this,target=this.loadedData&&this.loadedData.hit.target;
    // The checkbox is read here and in showSavedAim, not once per frame: a hit without recorded circles leaves an
    // empty group behind, and an empty group that is visible costs nothing.
    // ringAim is the solid ring's frame, discAim the disc's; savedAim - what the circle figure is sampled over - is
    // one of the two (shotDiscAim), never a third copy.
    this.savedAim=this.ringAim=this.discAim=this.shotDisc=null;this.viewPoints=null;this.aimGroup=new T.Group();this.aimGroup.visible=aimShown();this.root.add(this.aimGroup);
    if(!context||!(context.aim||context.serverShot)||!target||!target.worldTransform)return false;
    var inverse=new T.Matrix4().fromArray(target.worldTransform).invert();
    function pos(p){var v=new T.Vector3().fromArray(p).applyMatrix4(inverse);v.z*=-1;return v;}
    function dir(p){var v=new T.Vector3().fromArray(p).transformDirection(inverse);v.z*=-1;return v;}
    // A thin ring is where the reticle stood at the PRESS (user, 24.09: what he judges his own aim by). The recorded
    // marker sits wherever the game's trajectory met something, short of or past the armour (up to metres), so it
    // is slid to the plane through the impact point - along the line the game drew that marker on: through its
    // point, along its own direction (the flight's tangent there). The radius grows with the distance from the gun
    // the marker was aimed from (`from`: the gun at the press, or the server update's own origin):
    // r' = r · (span + shift) / span. That gun is also the cone's apex (origin: the figure fans its rays from it).
    // outputs/thin-rings-2026-09-24.md: the ray from the shell's origin at the SHOT through the marker at the
    // press pivoted about the marker by the ~1 m the vehicle drove between the two - 16 % of the solid rings
    // at >= 3 m/s stood > 0.5 R off; along the marker's own line none. Without any origin, as recorded.
    function ring(marker,color,dashed,from){
      if(!marker||!marker.position||!marker.direction||!(marker.diameter>0))return;
      var at=pos(marker.position),normal=dir(marker.direction),center=at,radius=marker.diameter/2,origin=null;
      if(!Array.isArray(from))from=context.tracer&&Array.isArray(context.tracer.origin)?context.tracer.origin:null;
      var span=from?at.distanceTo(pos(from)):0;
      if(span>1e-6){
        origin=at.clone().addScaledVector(normal,-span);
        var shift=self.point?self.point.clone().sub(at).dot(normal):0;
        if(span+shift>1e-6){center=at.clone().addScaledVector(normal,shift);radius*=(span+shift)/span;}
      }
      var up=new T.Vector3(0,1,0);if(Math.abs(up.dot(normal))>.98)up.set(1,0,0);
      var right=new T.Vector3().crossVectors(normal,up).normalize();up.crossVectors(right,normal).normalize();var points=[];
      for(var i=0;i<=96;i++){var a=i/96*Math.PI*2;points.push(center.clone().addScaledVector(right,radius*Math.cos(a)).addScaledVector(up,radius*Math.sin(a)));}
      var options={color:color,depthTest:false,depthWrite:false,transparent:true,opacity:.85},material=dashed?new T.LineDashedMaterial(Object.assign(options,{dashSize:radius*.1,gapSize:radius*.07})):new T.LineBasicMaterial(options);
      var line=new T.Line(new T.BufferGeometry().setFromPoints(points),material);if(dashed)line.computeLineDistances();line.renderOrder=12;line.frustumCulled=false;self.aimGroup.add(line);
      if(!dashed){var size=Math.max(.025,Math.min(.12,radius*.12)),cross=[center.clone().addScaledVector(right,-size),center.clone().addScaledVector(right,size),center.clone().addScaledVector(up,-size),center.clone().addScaledVector(up,size)];var mark=new T.LineSegments(new T.BufferGeometry().setFromPoints(cross),new T.LineBasicMaterial(options));mark.renderOrder=12;self.aimGroup.add(mark);self.ringAim={center:center,normal:normal,right:right,up:up,radius:radius,origin:origin,kind:'saved'};}
      if(origin){axis(origin,center,new T.Color(color),dashed?.012:0,'thin',dashed,dashed?8:7);self.viewPoints=self.viewPoints||{};self.viewPoints[dashed?'server':'gun']=origin.clone();}
    }
    // Ring axes (the lab's switch, user 24.09): each ring's axis from its cone's apex to its centre - the solid ring's
    // from the gun at the press, the dashed one's from its server update's origin, the thick one's from the shell's own
    // origin - in the ring's colour and style. They start where the vehicle stood at each moment and meet at the target.
    // Thin lines in the recorded group (a pin or the first emulated shot hides them with the rings), made with the rings;
    // the switch only shows or hides them. `dash`: the dash as a share of the length, 0 for a solid line.
    // Each apex gets a dot in its ring's style (user, 24.09: the three start points side by side - your gun at the press, filled;
    // the server's gun then, hollow; the shell's real origin, the thick ring's colour and a size up).
    function axis(from,to,colour,dash,kind,hollow,px){
      var length=from.distanceTo(to),o={color:colour,depthTest:false,depthWrite:false,transparent:true,opacity:.8};
      var line=new T.Line(new T.BufferGeometry().setFromPoints([from.clone(),to.clone()]),dash>0?new T.LineDashedMaterial(Object.assign(o,{dashSize:length*dash,gapSize:length*dash*.7})):new T.LineBasicMaterial(o));
      if(dash>0)line.computeLineDistances();line.renderOrder=12;line.frustumCulled=false;line.userData.ringAxis=kind;line.visible=self.axesShown(kind);self.aimGroup.add(line);
      var dot=startDot(from,colour.clone(),px,hollow);dot.renderOrder=12;dot.userData.ringAxis=kind;dot.visible=line.visible;self.aimGroup.add(dot);
    }
    // Both recorded reticles stand still, so both are magenta (user, 20.09); solid is the client's,
    // dashed the server's. Both are the snapshot of the PRESS (what the player aimed with), kept beside the disc.
    // The solid ring's gun is the client's at the press (aim.gunOrigin, every record); the dashed one's is the server
    // update the server marker was made from (the same receipt), else that gun too.
    if(context.aim){
      var gun=context.aim.gunOrigin,update=context.aim.lastServerGunUpdate;
      ring(context.aim.clientMarker,AIM_RING,false,gun);
      var server=context.aim.serverMarker,client=context.aim.clientMarker;
      if(server&&client&&Number.isFinite(server.receivedAt)&&Math.abs(server.receivedAt-client.receivedAt)<.5)
        ring(server,AIM_RING,true,update&&Array.isArray(update.origin)&&Math.abs(update.receivedAt-server.receivedAt)<.02?update.origin:gun);
    }
    // The disc (outputs/own-shot-centre-2026-09-24.md section 9.1): the shell's angular offset from the server's axis
    // n, dx = (v·e1)/(v·n), dy = (v·e2)/(v·n) with e1 = n × up, e2 = e1 × n (world frame, the offline tool's axes),
    // carried to the plane through the impact point I across n: centre C = I − depth·(dx·e1 + dy·e2), radius
    // R = angle·depth, depth = (I − muzzle)·n. The origin is the tracer's own, so the vehicle's move since the update
    // needs no term. Gravity drops the real and the nominal flight alike, to second order.
    var shot=context.serverShot,tracer=context.tracer;
    if(shot&&this.point&&tracer&&Array.isArray(tracer.origin)&&Array.isArray(tracer.velocity)){
      var n=new T.Vector3().fromArray(shot.update.vector).normalize(),v=new T.Vector3().fromArray(tracer.velocity),
        e1=new T.Vector3().crossVectors(n,new T.Vector3(0,1,0)),forward=v.dot(n);
      if(e1.lengthSq()>1e-12&&forward>1e-6){
        e1.normalize();var e2=new T.Vector3().crossVectors(e1,n),dx=v.dot(e1)/forward,dy=v.dot(e2)/forward,
          origin=pos(tracer.origin),normal=dir(n.toArray()),right=dir(e1.toArray()),up=dir(e2.toArray()),
          depth=this.point.clone().sub(origin).dot(normal);
        if(depth>1e-6){
          var center=this.point.clone().addScaledVector(right,-depth*dx).addScaledVector(up,-depth*dy),radius=shot.update.dispersionAngle*depth;
          var disc=new T.Mesh(this.ringGeometry(),this.ringMaterial());disc.matrixAutoUpdate=false;disc.onBeforeRender=this.ringBeforeRender;
          disc.matrix.makeBasis(right.clone().multiplyScalar(radius),up.clone().multiplyScalar(radius),normal.clone().multiplyScalar(radius)).setPosition(center);
          disc.renderOrder=DISC_ORDER;disc.frustumCulled=false;disc.visible=this.discOn;this.aimGroup.add(disc);this.shotDisc=disc;
          // The cone's apex - where the figure fans its rays from and where Ring axes starts the thick ring's axis - is the
          // shell's origin as the flight and the camera have it: carried onto the hit (shotPath) when the tracer's stop is
          // known, so the three start at one point (review 24.09: 0.32 m median, up to 61 m apart before). The ring at the
          // target is built from `origin` and I as before and does not move.
          var apex=this.shotPath&&this.shotPath.tracer===tracer?this.shotPath.origin.clone():origin;
          axis(apex,center,new T.Color().setRGB(this.ringLook.color[0],this.ringLook.color[1],this.ringLook.color[2],T.SRGBColorSpace),.03,'disc',false,9);
          this.viewPoints=this.viewPoints||{};this.viewPoints.fired=apex.clone();
          this.discAim={center:center,normal:normal,right:right,up:up,radius:radius,origin:apex,kind:'fired',
            q:Math.hypot(dx,dy)/shot.update.dispersionAngle,stale:!!shot.stale,from:shot.from,gap:shot.gap,
            salvo:shot.salvo||0,afterRecorded:!!shot.afterRecorded};
        }
      }
    }
    this.savedAim=this.shotDiscAim();
    // View from (the lab, user 24.09): an own shot's record view may stand at the gun at the press or at the server's gun
    // then; those points are known only now, so the camera owner places it again (load() placed it at the shot).
    if(this.viewFrom!=='fired'&&this.viewEye(true))this.focus();
    this.showSavedAim(aimShown());return !!(this.ringAim||this.discAim);
  };
  // The circle the figure is sampled over: the shot ring - the circle the shell really left from - while it is on
  // screen, the solid ring otherwise (a record before the ring's field, or the shot ring switched off in Settings).
  Viewer.prototype.shotDiscAim=function(){return this.discOn&&this.discAim?this.discAim:this.ringAim||null;};
  // One geometry and one material for the viewer's life (clear() leaves both alone): a hit click makes a mesh and
  // nothing else. The geometry is the dashes of the unit circle, two vertices (inner and outer edge) per step, about
  // 128 steps round the whole circle; it is made again only when the lab changes the dashes.
  Viewer.prototype.ringGeometry=function(){
    var look=this.ringLook,key=look.dashes+'/'+look.share;
    if(this.ringGeom&&this.ringGeomKey===key)return this.ringGeom;
    var n=Math.max(1,Math.round(look.dashes)),share=Math.max(.05,Math.min(1,look.share));if(share>.999)n=1;
    var steps=Math.max(2,Math.round(128*share/n)),pos=[],side=[],index=[];
    for(var k=0;k<n;k++){
      var a0=k/n*Math.PI*2,span=share/n*Math.PI*2,base=pos.length/3;
      for(var i=0;i<=steps;i++){var a=a0+span*i/steps,c=Math.cos(a),s=Math.sin(a);pos.push(c,s,0,c,s,0);side.push(0,1);}
      for(i=0;i<steps;i++){var v=base+i*2;index.push(v,v+1,v+3,v,v+3,v+2);}
    }
    var g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('side',new THREE.Float32BufferAttribute(side,1));g.setIndex(index);
    var old=this.ringGeom;this.ringGeom=g;this.ringGeomKey=key;
    if(old){if(this.shotDisc&&this.shotDisc.geometry===old)this.shotDisc.geometry=g;old.dispose();}
    return g;
  };
  Viewer.prototype.ringMaterial=function(){
    if(this.ringMat)return this.ringMat;
    var self=this,look=this.ringLook;
    this.ringMat=new THREE.ShaderMaterial({vertexShader:SHOT_RING_VERTEX,fragmentShader:SHOT_RING_FRAGMENT,transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide,
      uniforms:{uColor:{value:new THREE.Vector3().fromArray(look.color)},uOpacity:{value:this.discOpacity},uWidth:{value:look.width},uPlace:{value:look.place},uViewH:{value:this.viewHeight||1}}});
    // The CSS height of the view, read when the ring is drawn: one assignment, only on frames that draw the ring.
    this.ringBeforeRender=function(){self.ringMat.uniforms.uViewH.value=self.viewHeight||1;};
    return this.ringMat;
  };
  // The lab's Ring axes switch (user, 24.09). The thick ring's axis goes with the thick ring (Shot ring off: no axis).
  Viewer.prototype.axesShown=function(kind){return !!this.ringAxes&&(kind!=='disc'||this.discOn);};
  Viewer.prototype.ringAxisLines=function(){return this.aimGroup?this.aimGroup.children.filter(function(o){return !!o.userData.ringAxis;}):[];};
  Viewer.prototype.setRingAxes=function(on){var self=this;this.ringAxes=!!on;this.ringAxisLines().forEach(function(o){o.visible=self.axesShown(o.userData.ringAxis);});this.draw();};
  // Settings, Shot ring: the switch and the opacity (0..1). The circle figure follows the circle on screen.
  Viewer.prototype.setShotDisc=function(on,opacity){
    var self=this;this.discOn=!!on;if(Number.isFinite(opacity))this.discOpacity=opacity;
    if(this.ringMat)this.ringMat.uniforms.uOpacity.value=this.discOpacity;
    if(this.shotDisc)this.shotDisc.visible=this.discOn;
    this.ringAxisLines().forEach(function(o){o.visible=self.axesShown(o.userData.ringAxis);});
    this.savedAim=this.shotDiscAim();this.draw();
  };
  // The TEMPORARY lab of Settings (user, 24.09): {color:[r,g,b] sRGB 0..1, width px, dashes, share 0..1, place 0/0.5/1}.
  // Uniforms for all but the dashes, which make the one geometry again.
  Viewer.prototype.setShotRingLook=function(look){
    var l=this.ringLook;Object.keys(look||{}).forEach(function(k){if(look[k]!==undefined&&look[k]!==null)l[k]=look[k];});
    if(this.ringMat){var u=this.ringMat.uniforms;u.uColor.value.fromArray(l.color);u.uWidth.value=l.width;u.uPlace.value=l.place;}
    this.ringAxisLines().forEach(function(o){if(o.userData.ringAxis==='disc')o.material.color.setRGB(l.color[0],l.color[1],l.color[2],THREE.SRGBColorSpace);});
    if(this.ringGeom)this.ringGeometry();
    this.draw();
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
    if(!this.savedAim||!this.savedAim.origin||!this.engine||!shell||!this.recordedPose())return null;
    // 'damage' is the mean expected damage over the circle, HP: a miss is 0 HP exactly as it is 0 %.
    var aim=this.savedAim;
    return sampleCircle(this.engine,shell,aim.origin,aim.center,aim.right,aim.up,aim.radius,256,this.aimQuantile());
  };
  // The same integral over the NOMINAL ring of a hit that has no recorded reticle (user, 20.09: the
  // circle figure belongs to every ring on screen). It is an estimate of the circle, so the figure is an
  // estimate too - the panel line says so - and it is still kept out of the reticle tile's own number.
  Viewer.prototype.estimateAimProbability=function(shell){
    var aim=this.estimateAim;
    if(!aim||!aim.origin||!this.engine||!shell||!this.recordedPose())return null;
    return sampleCircle(this.engine,shell,aim.origin,aim.center,aim.right,aim.up,aim.radius,256,this.aimQuantile());
  };
  Viewer.prototype.paint=function(){
    if(!this.paintMesh)return;
    var composed=false;
    if(this.heatmap&&!this.look){
      if(!this.surfaceAttempted){this.surfaceAttempted=true;try{this.surface=new BullbaScreenArmor(this.renderer,this.engine);this.scene.add(this.surface.quad);
        // A fresh composition starts unlit, so the switch is re-applied here - the one path every new
        // instance goes through: the first paint, a new model, a quality change and a restored context.
        // Caught on its own: a cosmetic light the driver will not give must never read as a map that failed.
        if(this.lighting){try{this.surface.setLighting(true);}catch(light){console.warn('Soft lighting unavailable:',light.message);}}
        if(Number.isFinite(this.lightStrength)&&this.surface.setLightStrength){try{this.surface.setLightStrength(this.lightStrength);}catch(light){console.warn('Soft lighting depth unavailable:',light.message);}}}catch(e){this.surfaceError=e.message;console.warn('Screen composition unavailable:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','unavailable: '+e.message);}}
      if(this.surface){try{
        this.surface.hatch=this.dotSpacing;this.surface.dots=this.dots;this.surface.edges=this.partEdges;this.surface.outline=this.zoneOutline;this.surface.tint=this.tint;/* The user's Detail and Ricochet trace settings hold during a drag too: 'Always' means live while rotating (0.7.4 lowered both while dragging; reverted on his feedback). */var size=this.surface.render(this.camera,this.target,this.shell,this.palette,this.trackOpacity,this.quality,this.viewWidth,this.viewHeight,this.renderer.getPixelRatio(),this.bounceMode,this.mapMode);
        composed=true;this.surfaceError=null;
        // The hatched layer is due once the camera has stood still: one redraw later, not a loop.
        if(this.surface.bouncePending&&this.bounceTimer===null){var self=this;this.bounceTimer=setTimeout(function(){self.bounceTimer=null;self.draw();},160);}
        this.backend('GPU · layers at window size · '+size);
      }catch(e){this.surfaceError=e.message;this.surface.dispose();this.surface=null;console.warn('Screen composition disabled:',e.message);if(window.BullbaHost)window.BullbaHost.mark('Layer composition','error: '+e.message);}}
    }
    if(this.surface)this.surface.quad.visible=composed;
    this.paintMesh.visible=!composed;this.trackGroup.visible=!composed;
    if(composed)return;
    // An unavailable GPU map stays neutral; it never switches to triangle estimates.
    this.backend(this.look?'Damage event · no penetration map':this.heatmap?'Estimate unavailable: '+(this.surfaceError||'GPU-composition did not run'):'Vehicle parts · estimate off');
    var key=this.look?'look:'+this.look.kind+':'+this.look.part:this.heatmap?'neutral':'parts';if(this.paintedKey===key)return;
    var buffer=this.paintMesh.geometry.attributes.color.array;
    for(var n=0;n<this.samples.length;n++){
      var color=this.look?this.lookColor(this.samples[n],n):this.heatmap?baseColors[0]:baseColors[this.samples[n].part%4];
      for(var j=0;j<3;j++)for(var k=0;k<3;k++)buffer[n*9+j*3+k]=color[k];
    }
    this.paintedKey=key;this.paintMesh.geometry.attributes.color.needsUpdate=true;
  };
  // ===== A damage event on screen (25.09, BACKLOG 3) =====
  // No penetration map: the damaged vehicle plain grey; after a ram the part that was touched red and a mark (the hit
  // cross, red) at the recorded contact; after a fire a burnt look - charcoal with a few embers, the same on every paint
  // (a hash of the triangle, not a random draw). load() drops the look (clear); the page sets it after load, before the
  // first frame is drawn, so the map never shows under it. The touched part is the one whose triangle lies nearest the
  // contact - the recorded point is the client physics' contact, not a hit point on a part.
  var LOOK_PLAIN=linear([.42,.47,.52]),LOOK_RED=linear([.88,.17,.13]),LOOK_CHAR=linear([.13,.11,.1]),LOOK_EMBER=linear([.66,.22,.06]),LOOK_TRACKS=1000003;
  function lookNoise(i){var s=(i+1)>>>0;s=Math.imul(s^(s>>>16),0x45d9f3b)>>>0;s=Math.imul(s^(s>>>16),0x45d9f3b)>>>0;return ((s^(s>>>16))>>>0)/4294967296;}
  Viewer.prototype.lookColor=function(t,i){
    var look=this.look;
    if(look.kind==='fire'){if(lookNoise(i)<.07)return LOOK_EMBER;var k=.55+.9*lookNoise(i+7919);return [LOOK_CHAR[0]*k,LOOK_CHAR[1]*k,LOOK_CHAR[2]*k];}
    return look.kind==='ram'&&look.part!=null&&t.part===look.part?LOOK_RED:LOOK_PLAIN;
  };
  // Squared distance from p to the triangle (a, b, c) - the closest point by the triangle's regions (Ericson 5.1.5).
  function triangleDistance(p,a,b,c){
    var ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],ap=[p[0]-a[0],p[1]-a[1],p[2]-a[2]];
    var dot=function(u,v){return u[0]*v[0]+u[1]*v[1]+u[2]*v[2];},at=function(o,u,s,v,t){return [o[0]+u[0]*s+v[0]*t,o[1]+u[1]*s+v[1]*t,o[2]+u[2]*s+v[2]*t];};
    var d1=dot(ab,ap),d2=dot(ac,ap),q;
    if(d1<=0&&d2<=0)q=a;else{
      var bp=[p[0]-b[0],p[1]-b[1],p[2]-b[2]],d3=dot(ab,bp),d4=dot(ac,bp);
      if(d3>=0&&d4<=d3)q=b;else{
        var vc=d1*d4-d3*d2;
        if(vc<=0&&d1>=0&&d3<=0)q=at(a,ab,d1/(d1-d3),ac,0);else{
          var cp=[p[0]-c[0],p[1]-c[1],p[2]-c[2]],d5=dot(ab,cp),d6=dot(ac,cp);
          if(d6>=0&&d5<=d6)q=c;else{
            var vb=d5*d2-d1*d6;
            if(vb<=0&&d2>=0&&d6<=0)q=at(a,ab,0,ac,d2/(d2-d6));else{
              var va=d3*d6-d5*d4;
              if(va<=0&&d4-d3>=0&&d5-d6>=0){var w=(d4-d3)/((d4-d3)+(d5-d6));q=[b[0]+(c[0]-b[0])*w,b[1]+(c[1]-b[1])*w,b[2]+(c[2]-b[2])*w];}
              else{var den=1/(va+vb+vc);q=at(a,ab,vb*den,ac,vc*den);}
            }
          }
        }
      }
    }
    return (p[0]-q[0])*(p[0]-q[0])+(p[1]-q[1])*(p[1]-q[1])+(p[2]-q[2])*(p[2]-q[2]);
  }
  // The collision part whose triangle lies nearest the point (scene frame), over the armour and the outer layer (tracks,
  // screens); null for a model without triangles. Once per event scene, not per frame.
  Viewer.prototype.nearestPart=function(point){
    var best=Infinity,part=null,p=[point.x,point.y,point.z];
    [this.samples||[],this.trackTriangles||[]].forEach(function(list){list.forEach(function(t){var d=triangleDistance(p,t.a,t.b,t.c);if(d<best){best=d;part=t.part;}});});
    return part;
  };
  // look: null (a hit: the map as set), {kind:'plain'|'fire'} or {kind:'ram', point:[x,y,z] in the scene frame}.
  // Returns the touched part of a ram (null without a point).
  Viewer.prototype.setLook=function(look){
    this.look=look?{kind:look.kind==='ram'||look.kind==='fire'?look.kind:'plain',part:null}:null;
    if(this.look&&look.point&&look.point.length===3){
      var at=new THREE.Vector3().fromArray(look.point);this.look.part=this.nearestPart(at);this.look.point=at;
      this.addReticle(at);this.reticles[this.reticles.length-1].element.classList.add('contact');
    }
    this.paintedKey=null;this.trackKey=null;this.updateTrackAppearance();this.draw();
    return this.look?this.look.part:null;
  };
  // The status line goes to the page when it changes, not on every frame (VIEW-16); the frame rate beside it is the page's
  // own poll's to refresh.
  Viewer.prototype.backend=function(text){if(text===this.backendShown)return;this.backendShown=text;if(this.onBackend)this.onBackend(text);};
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
    if(!this.engine||!this.onInspect)return;var raycaster=this.pointerRay(event),hit=this.pick(raycaster.ray.origin,raycaster.ray.direction),sample=hit?(hit.object===this.trackMesh?this.trackTriangles:this.samples)[hit.faceIndex]:null,result=this.engine.ray(raycaster.ray.origin.toArray(),raycaster.ray.direction.toArray(),this.shell);if(sample)result.surface={part:sample.part,armor:sample.armor};
    // The emulated circle follows every pointer move, including one that leaves the reading below unchanged,
    // so it is moved before that early return - and it reuses this raycast instead of casting its own.
    if(this.liveRadius100){var moved=this.aimAtPointer(raycaster,hit);if(this.onAimMove)this.onAimMove(moved);}
    var key=Viewer.readingKey(result,sample);if(key===this.inspectKey)return;this.inspectKey=key;this.onInspect(result);
  };
  Viewer.prototype.wireframe=function(value){this.showOutline=!!value;this.applyOutline();this.draw();};
  // Alt + click pins the circle's centre. With the emulation on the circle simply stays there and keeps
  // following the state; with it off the manual estimate waits for the button, as before.
  Viewer.prototype.aimAt=function(event){var ray=this.pointerRay(event).ray,normal=this.target.clone().sub(this.camera.position).normalize(),plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,this.target),point=new THREE.Vector3();if(ray.intersectPlane(plane,point)){this.spreadAim=point;this.hideSpread();
    if(this.liveRadius100){var pinned=this.drawLiveAim();if(this.onAimMove)this.onAimMove(pinned);if(this.onAim)this.onAim('Circle pinned here. It keeps following the shooter’s state; “Centre on the hit” releases it.');}
    else if(this.onAim)this.onAim('Estimate centre moved. Press “Estimate”.');}};
  Viewer.prototype.hideSpread=function(){var line=this.spreadCircle;if(line){this.scene.remove(line);if(line!==this.liveRingLine){line.geometry.dispose();if(line.material!==this.liveRingMaterial)line.material.dispose();}this.spreadCircle=null;this.draw();}};
  // ONE point of a dispersion circle: the radial quantile of the chosen profile at `u`, at the angle
  // `angle`. The integral below walks `u` over the stratified (i+.5)/count and the angle over the golden
  // step; a RANDOM shot (liveAimSample) draws both from the page's own source. Both therefore read the
  // very same law - there is no second distribution anywhere on the page.
  function circlePoint(center,right,up,radius,u,angle,quantile){
    var r=radius*quantile(u);
    return center.clone().addScaledVector(right,r*Math.cos(angle)).addScaledVector(up,r*Math.sin(angle));
  }
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
      var point=circlePoint(center,right,up,radius,(i+.5)/count,i*2.399963229728653,q);
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
  // The points of a ring (or of its arc from..to), written into `position` (x y z each) and their running length into
  // `distance` - what computeLineDistances() would give a dashed line - from index 0; returns how many. At most 97 points,
  // the last on top of the first: a closed T.Line rather than a LineLoop, because a LineLoop's closing segment has no
  // line distance and the dashes break there.
  var RING_POINTS=97;
  function ringPoints(position,distance,center,right,up,radius,from,to){
    var a0=from===undefined?0:from,a1=to===undefined?Math.PI*2:to,steps=Math.max(2,Math.round(96*Math.abs(a1-a0)/(Math.PI*2))),run=0;
    for(var j=0;j<=steps;j++){
      var a=a0+(a1-a0)*j/steps,c=radius*Math.cos(a),n=radius*Math.sin(a),k=j*3;
      position[k]=center.x+right.x*c+up.x*n;position[k+1]=center.y+right.y*c+up.y*n;position[k+2]=center.z+right.z*c+up.z*n;
      if(j)run+=Math.hypot(position[k]-position[k-3],position[k+1]-position[k-2],position[k+2]-position[k-1]);
      distance[j]=run;
    }
    return steps+1;
  }
  function aimLine(center,right,up,radius,style){
    var T=THREE,s=style||{},position=new Float32Array(RING_POINTS*3),distance=new Float32Array(RING_POINTS);
    var count=ringPoints(position,distance,center,right,up,radius);
    var options={color:s.color===undefined?0xf1d18b:s.color,transparent:true,opacity:s.opacity>0?s.opacity:1,depthTest:false,depthWrite:false};
    var material=s.dashed?new T.LineDashedMaterial(Object.assign(options,{dashSize:radius*.09,gapSize:radius*.06})):new T.LineBasicMaterial(options);
    var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(position.subarray(0,count*3),3));
    if(s.dashed)geometry.setAttribute('lineDistance',new T.BufferAttribute(distance.subarray(0,count),1));
    var line=new T.Line(geometry,material);line.frustumCulled=false;
    return line;
  }
  function dropLine(scene,line){if(!line)return;scene.remove(line);line.geometry.dispose();line.material.dispose();}
  // The live ring is redrawn on every frame of the emulation, from the hover, the page's frame loop, the camera report and
  // the chase - up to four times a frame. Its dashed material and its line are one each for the viewer's life and never
  // disposed: three r160 deletes a program whose last material goes, so a fresh material per frame recompiled and relinked
  // the dashed-line program whenever the live ring was the only dashed line on screen, and a fresh geometry per draw
  // freed and allocated a GL buffer each time (VIEW-04, 24.09). The ring is written into the line's own buffers in
  // place and the reload arc is a draw range over them.
  Viewer.prototype.liveRing=function(){
    return this.liveRingMaterial||(this.liveRingMaterial=new THREE.LineDashedMaterial({color:AIM_LIVE.color,transparent:true,opacity:AIM_LIVE.opacity,depthTest:false,depthWrite:false}));
  };
  Viewer.prototype.liveLine=function(){
    if(this.liveRingLine)return this.liveRingLine;var T=THREE,geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(RING_POINTS*3),3).setUsage(T.DynamicDrawUsage));
    geometry.setAttribute('lineDistance',new T.BufferAttribute(new Float32Array(RING_POINTS),1).setUsage(T.DynamicDrawUsage));
    var line=new T.Line(geometry,this.liveRing());line.frustumCulled=false;
    return (this.liveRingLine=line);
  };
  Viewer.prototype.drawCircle=function(center,right,up,radius,style,from,to){
    var line;
    if(style===AIM_LIVE){
      line=this.liveLine();var g=line.geometry,position=g.getAttribute('position'),distance=g.getAttribute('lineDistance');
      g.setDrawRange(0,ringPoints(position.array,distance.array,center,right,up,radius,from,to));position.needsUpdate=true;distance.needsUpdate=true;
      line.material.dashSize=radius*.09;line.material.gapSize=radius*.06;
      if(this.spreadCircle!==line){this.hideSpread();this.spreadCircle=line;this.scene.add(line);}
    }
    else{this.hideSpread();line=this.spreadCircle=aimLine(center,right,up,radius,style);this.scene.add(line);}
    // The live ring (cyan, with the reload on it) is drawn over the magenta ring of the pinned shot: the other way round the
    // reload was hidden whenever the cursor stood still on the pinned circle (user, 24.09).
    line.renderOrder=15;this.draw();
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
  Viewer.prototype.clearLiveAim=function(){this.liveRadius100=null;this.liveAimPoint=null;this.aimCursorPoint=null;this.liveAim=null;this.aimYaw=0;if(this.aimCentred)this.aimCentred={cursor:null,gun:null,seen:null,yaw:0};this.clearAimShot();this.hideSpread();this.updateAimMarker();};
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
    if(on){this.aimCentred={cursor:this.aimCursorPoint,gun:this.liveAimPoint,seen:null,yaw:this.aimYaw||0};this.centreAim();}
    else{
      var held=this.aimCentred,back=held.seen||held.cursor;this.aimCentred=null;
      // Nothing to go back to (the pointer never crossed the scene): the circle stays where it is until it does.
      // The gun given back where it stood keeps its yaw on the hull; one put down on the cursor has the hull facing it.
      if(back){this.aimCursorPoint=back.clone();this.liveAimPoint=(held.seen||held.gun||back).clone();this.aimYaw=!held.seen&&held.gun?held.yaw||0:0;}
    }
    if(this.liveRadius100)this.drawLiveAim();
    this.updateAimMarker();this.draw();
  };
  Viewer.prototype.centreAim=function(){
    var point=this.aimCentrePoint();
    if(point){this.aimCursorPoint=point;this.liveAimPoint=point.clone();this.aimYaw=0;}
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
    this.aimCursorPoint=point;this.liveAimPoint=point.clone();this.aimYaw=0;
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
    var caster=new T.Raycaster(eye,dir.normalize());
    return this.aimSurfacePoint(caster,this.pick(eye,caster.ray.direction))||centre;
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
    this.aimShotCircle.renderOrder=14;this.scene.add(this.aimShotCircle);this.draw();
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
  // A PRESS THE GUN REFUSED (user, 23.09: the gun did not fire and nothing on screen said why). The live ring pulses
  // twice in AIM_BALK: its one material (liveRing) changes colour, so nothing is built, and each step asks for the one
  // frame draw() already renders - coalesced with the emulation's own frame while that runs. Four steps of one
  // timeout each, the last giving the ring its colour back; a new refusal starts the pulse over. No ring, no pulse.
  Viewer.prototype.flashAim=function(){
    var self=this,m=this.liveRingMaterial,step=0;
    if(!m||!this.liveRadius100||!this.spreadCircle)return false;
    window.clearTimeout(this.aimFlashTimer);
    (function next(){
      var lit=step%2===0,s=lit?AIM_BALK:AIM_LIVE;
      m.color.setHex(s.color);m.opacity=s.opacity;self.draw();
      self.aimFlashTimer=++step<4?window.setTimeout(next,AIM_BALK_STEP):null;
    }());
    return true;
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
    if(!this.aimChase||!this.liveAimPoint){this.liveAimPoint=point.clone();this.aimYaw=0;}
    return this.drawLiveAim();
  };
  // The point a ray aims at: the first surface of the model it meets, or else its crossing with the plane
  // through the orbit centre square to the view. The cursor and the held centre both find their point here.
  // `hit` is the pick() of that ray (or a three.js hit list, the first entry of which counts).
  Viewer.prototype.aimSurfacePoint=function(caster,hit){
    var first=Array.isArray(hit)?hit[0]:hit;
    if(first)return first.point.clone();
    var T=THREE,plane=new T.Plane().setFromNormalAndCoplanarPoint(this.target.clone().sub(this.camera.position).normalize(),this.target),p=new T.Vector3();
    return caster.ray.intersectPlane(plane,p)?p:null;
  };
  // The angle between where the gun points and where the cursor points, seen from the shooter (the
  // camera). Both are points in the scene, so the angle is the one the turret actually has to turn
  // through; the distance to them plays no part in it.
  // `limits`: the shooter's horizontal sector, see aimReach; null or nothing for a turret that turns all the way round.
  Viewer.prototype.aimGap=function(limits){
    var pin=this.aimPin(),gun=pin||this.liveAimPoint,cursor=this.aimCursorPoint;
    if(!gun||!cursor||pin)return 0; // a pinned centre is not chasing anything
    var eye=this.camera.position,a=gun.clone().sub(eye),b=cursor.clone().sub(eye);
    if(a.lengthSq()<1e-12||b.lengthSq()<1e-12)return 0;
    a.normalize();b.normalize();
    return a.angleTo(this.aimReach(a,b,limits));
  };
  // THE GUN'S HORIZONTAL SECTOR (BACKLOG 40, 23.09). A turretless tank destroyer or a limited turret turns its gun only
  // within gun.turretYawLimits of the hull - [left, right] in radians, the left one negative, the client's own pair,
  // which its gun rotator clamps the turret's yaw to; for more the hull has to turn. The emulated hull is level and turns
  // about the world's up axis (turnAim), so the gun's yaw on it is one number, aimYaw, right positive: the chase adds
  // what it turns the gun sideways, the hull's own turn carries the gun and leaves it alone, and a gun put down straight
  // on the cursor (the first point, the held centre, a new model) has the hull facing it, 0. The camera orbiting the
  // target moves the shooter, not his gun on the hull, so it leaves the number alone too. The hull never turns on its
  // own here: past the limit the gun simply stops at the cursor's elevation, and A or D bring the rest.
  // aimAzimuth is a direction's heading about the world's up axis, right positive (a right turn is -Y, turnAim).
  Viewer.aimAzimuth=function(d){return Math.atan2(-d.x,d.z);};
  function wrapAngle(a){return Math.atan2(Math.sin(a),Math.cos(a));}
  // The direction the gun can reach towards the cursor: the cursor's own - the very object handed in, so a caller can
  // tell - or, past the sector, the cursor's direction turned back about the up axis onto the limit. `a` and `b` are
  // the unit directions of the gun and the cursor from the eye.
  Viewer.prototype.aimReach=function(a,b,limits){
    if(!limits)return b;
    var yaw=this.aimYaw||0,want=wrapAngle(Viewer.aimAzimuth(b)-Viewer.aimAzimuth(a)),got=Math.max(limits[0]-yaw,Math.min(limits[1]-yaw,want));
    if(Math.abs(got-want)<1e-12)return b;
    return b.clone().applyAxisAngle(new THREE.Vector3(0,1,0),want-got);
  };
  // How far the cursor lies past the sector, signed about the up axis (right positive), radians; 0 inside it, with no
  // sector or nothing to aim. The page's autorotation turns the hull by this (23.09): it is want - got of aimReach, which
  // depends on the cursor and the hull's heading only (the gun's own yaw cancels), and costs two directions, no ray.
  Viewer.prototype.aimBeyond=function(limits){
    if(!limits)return 0;
    var pin=this.aimPin(),gun=pin||this.liveAimPoint,cursor=this.aimCursorPoint;
    if(!gun||!cursor||pin)return 0;
    var eye=this.camera.position,ax=gun.x-eye.x,az=gun.z-eye.z,bx=cursor.x-eye.x,bz=cursor.z-eye.z;
    if(ax*ax+az*az<1e-12||bx*bx+bz*bz<1e-12)return 0;
    var yaw=this.aimYaw||0,want=wrapAngle(Math.atan2(-bx,bz)-Math.atan2(-ax,az)),got=Math.max(limits[0]-yaw,Math.min(limits[1]-yaw,want));
    return want-got;
  };
  // Turn the gun towards the cursor by at most `step` radians and put the circle where it now points.
  // The new point is picked off the model along the rotated ray so the circle keeps lying on the armour;
  // with nothing under that ray it keeps the range it had, which is all the radius needs. Reaching the
  // cursor snaps exactly onto it, so a turret that has caught up reads identically to stage 1. With a
  // sector (`limits`, aimReach) the gun goes only as far as the limit and stays there.
  Viewer.prototype.chaseAim=function(step,limits){
    var T=THREE,gun=this.liveAimPoint,cursor=this.aimCursorPoint;
    if(!gun||!cursor||this.aimPin())return false;
    var eye=this.camera.position.clone(),a=gun.clone().sub(eye),range=a.length(),b=cursor.clone().sub(eye);
    if(range<1e-6||b.lengthSq()<1e-12)return false;
    a.divideScalar(range);b.normalize();
    var goal=this.aimReach(a,b,limits),free=goal===b,gap=a.angleTo(goal),moved;
    if(free&&(!(gap>1e-6)||step>=gap)){this.liveAimPoint=cursor.clone();this.aimYaw=wrapAngle(this.aimYaw+wrapAngle(Viewer.aimAzimuth(b)-Viewer.aimAzimuth(a)));this.drawLiveAim();return gap>1e-6;}
    if(!(gap>1e-6))return false;   // at the limit: nothing to turn
    if(step>=gap)moved=goal;
    else{
      var axis=new T.Vector3().crossVectors(a,goal);
      if(axis.lengthSq()<1e-14)return false;
      moved=a.clone().applyQuaternion(new T.Quaternion().setFromAxisAngle(axis.normalize(),step));
    }
    this.aimYaw=wrapAngle(this.aimYaw+wrapAngle(Viewer.aimAzimuth(moved)-Viewer.aimAzimuth(a)));
    var met=this.pick(eye,moved);
    this.liveAimPoint=met?met.point.clone():eye.clone().addScaledVector(moved,range);
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
    var met=this.pick(eye,dir);
    this.liveAimPoint=met?met.point.clone():eye.clone().addScaledVector(dir,range);
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
    var hit=this.pick(origin,direction);
    var normal=hit&&hit.face?hit.face.normal.clone().transformDirection(hit.object.matrixWorld):null;
    this.pinned={origin:origin,direction:direction,point:hit?hit.point.clone():point.clone(),normal:normal,part:hit?hit.part:undefined};
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
  // A RANDOM impact point inside the live ring (the fun layer, user 22.09): the same radial law the figure
  // over that ring is integrated with (circlePoint above with this viewer's own profile), drawn at a
  // uniform u instead of the stratified one and at a uniform angle. `random` is the page's own source, so
  // a harness can seed it. GEOMETRY ONLY - no ray is cast here: the shot casts the one line it always cast
  // (pinAtPoint), and its verdict comes back on pinResult.
  Viewer.prototype.liveAimSample=function(random){
    var aim=this.liveAim,r=typeof random==='function'?random:Math.random;
    if(!aim)return null;
    return circlePoint(aim.center,aim.right,aim.up,aim.radius,r(),r()*Math.PI*2,this.aimQuantile());
  };
  // --- Hitmarks (user, 22.09) ------------------------------------------------------------------------
  // Every emulated shot leaves a DECAL on the armour, and they pile up: not the impact cross, which is a
  // screen-sized glyph and turns the model into mush after a burst; not the flat coloured disc of 0.7.26,
  // which wore the very colours of the hit map and melted into it; and not the flat calibre-sized plane of
  // the first decal build - the mark is PROJECTED along the shell's own line the way the game does it.
  //
  // So the geometry of a mark is CUT OUT OF THE MODEL, DecalGeometry-style. An oriented box stands at the
  // impact point, which is the MIDDLE of the mark: its Z runs along the shell's travel and its X/Y
  // footprint is 0.7 calibre across. Every triangle of the armour the box catches is clipped against the
  // box's six planes AND against a thin slab round the plane of the facet the shell struck; the pieces keep
  // exactly the surface they were cut from, and the texture is projected on them from the box's own X/Y.
  // A shell arriving at the incidence i covers a footprint stretched by 1 / cos i along the plate - a hole
  // met at an angle is an oval, a ricochet is a skid drawn out edge to edge - and the stretch has NO cap of
  // its own (user, 22.09, 22:50: "if it comes out longer, then longer"): the plate ends it. A mark stops
  // where the armour stops, never hangs over an edge, and never spills onto the next plate round a bend or
  // onto a plate behind, however long a grazing box grows (the slab, MARK_PLANE).
  //
  // A shot leaves a mark at EVERY plate its path met - a hole in each screen it went through, its own
  // outcome where it ended, a skid where it glanced off and the plate it flew into next - all read out of
  // the one ray the shot cast; and each mark lives in the PART it was laid on, so it turns with the turret
  // and pitches with the gun (user, 22.09, 23:15; the two blocks after the cut below).
  //
  // What the game itself does, read from the NA 2.4.0.1 client (outputs/hitmarks-research-2026-09-22.md,
  // docs/KNOWLEDGE.md §9): its hit decals are GPU decals projected orthonormally with a 50-degree cut-off
  // on the receiving surface - the one number taken over here (MARK_FACING); their boxes are about three
  // calibres with chipped paint and soot inside the texture, which this page does not copy: the owner found
  // one calibre already too fat, so the size is his, 0.7 calibre and nothing else.
  //
  // The three textures tell the outcomes apart by what the metal looks like, never by a hue of the chance
  // palette, and each pairs dark with light so it reads on any map colour and on the bare model:
  //   penetration    - a black hole with a dark red glow inside the lip, bare steel round it and a thin
  //                    burnt-paint edge (the glow is INSIDE the lip, not a red ring round the outside);
  //   no penetration - a metallic scrape: bright scored metal inside, paint burnt black round it;
  //   ricochet       - a skid drawn from one edge of the footprint to the other, lighter and greyer: light
  //                    in the middle, dark grey at its sides, so the projection's stretch IS the skid.
  // They are drawn ONCE on a canvas for the life of the page (markSheet below) and shared by every viewer;
  // clearing the marks disposes the meshes, never the three textures.
  var MARK_LIMIT=500,MARK_TEX=256;
  // The footprint's width, in calibres (mm -> m): 0.7, so a hole is about half a calibre with its rim round
  // it. NO floor (user, 22.09, 23:00: "let it be what it is") - a 20 mm gun leaves 14 mm, and a shell the
  // record gives no calibre for leaves no mark at all rather than one of a made-up size.
  var MARK_ENTRY=.7;
  // The one guard the stretch keeps: half the length along the plate is held to MARK_REACH metres, so a
  // near-tangent hit cannot ask for an infinite box. No plate of any vehicle is 2 m of flat armour in the
  // shell's way, so on a real model the plate's edge or its bend always ends the mark first.
  var MARK_REACH=1;
  // The slab round the struck facet's plane, each way, in footprints, with a floor in metres. Everything cut
  // is clipped to it, so a long grazing box cannot pick up a spaced plate behind, the far side of a thin
  // plate or a curved plate once it has turned away from the line - and it holds the few millimetres a
  // gently curved plate bends under a mark.
  var MARK_PLANE=.25,MARK_PLANE_FLOOR=.01;
  // How far a piece is lifted off the facet it was cut from, along that facet's own normal. With the map ON
  // nothing writes depth at all (the composition is a full-screen quad), with the map OFF the painted mesh
  // does, and polygonOffset on top of this lift keeps a decal out of the z-fight either way.
  var MARK_LIFT=.006;
  // Which triangles belong to the plate that was hit: a candidate whose normal is within 50 degrees of the
  // struck facet's - the client's own `cutoffAngle` 50 of its hit decals. It keeps a curved plate and throws
  // away the BACK of the plate, anything standing across it and the next plate round a sharp bend.
  var MARK_FACING=Math.cos(50*Math.PI/180);
  // A hit within this much of square-on (in sin i, so .05 is about 3 degrees) has no slide to line the
  // footprint up with, and is turned round the shot line by the roll the page drew for that very shot.
  var MARK_SLIDE=.05;
  // The model is asked through a box laid out on the record's own normal (the face the ray met). Should the
  // facet found under the point disagree with it, or need a deeper box, it is asked once more on the
  // facet's - a record made by hand, not by a ray; a pinned shot never does.
  var MARK_AGREE=.95;
  var MARK_KINDS=['pen','no-pen','ricochet'];
  // A line with no verdict at all gets the scrape, muted: it is not a stopped shell, it is a shot the page
  // could not judge, and it must not read as one. The only tint there is.
  var MARK_MUTED=0x7f8488,MARK_PLAIN=0xffffff;
  // Vertices one outcome's buffer starts at; it doubles when a mark does not fit.
  var MARK_START=1536,MARK_ATTRIBUTES=['position','normal','uv','color'];
  // The grain of the three textures. Drawn once, so a fixed seed keeps the page's marks the same from run
  // to run; it is NOT the emulation's rng and takes nothing from the page's seeded draws.
  function markNoise(seed){var s=seed>>>0;return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
  // A canvas is a BROWSER thing: under node (the harness) document.createElement gives a bare stub with no
  // 2d context, so the generator degrades to a 1 x 1 transparent DataTexture instead of throwing. The page
  // then still builds its meshes, cuts its decals and answers every question about them.
  function markCanvas(size){
    var doc=typeof document!=='undefined'?document:null,canvas=doc&&doc.createElement?doc.createElement('canvas'):null;
    if(!canvas||typeof canvas.getContext!=='function')return null;
    canvas.width=canvas.height=size;
    var ctx=null;try{ctx=canvas.getContext('2d');}catch(ignore){ctx=null;}
    return ctx&&typeof ctx.createRadialGradient==='function'?{canvas:canvas,ctx:ctx}:null;
  }
  function markStub(){var t=new THREE.DataTexture(new Uint8Array([255,255,255,0]),1,1);t.needsUpdate=true;t.userData.stub=true;return t;}
  function markTexture(draw,size){
    var made=markCanvas(size);
    if(!made)return markStub();
    try{draw(made.ctx,size);}catch(e){console.warn('Hitmark texture unavailable:',e.message);return markStub();}
    var texture=new THREE.CanvasTexture(made.canvas);
    if(THREE.SRGBColorSpace)texture.colorSpace=THREE.SRGBColorSpace;
    texture.userData.stub=false;
    return texture;
  }
  // A round mark: one radial gradient, stops given as [at, colour, at, colour, ...], its light caught at
  // (cx, cy) when given. The impact is at the CENTRE - the projection does all the stretching.
  function markDisc(ctx,S,stops,cx,cy){
    var c=S/2,r=S*.47,g=ctx.createRadialGradient(cx===undefined?c:cx,cy===undefined?c:cy,0,c,c,r),i;
    for(i=0;i<stops.length;i+=2)g.addColorStop(stops[i],stops[i+1]);
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);ctx.fill();
  }
  // A FEW bold strokes, never a fur of fine ones: at 0.7 calibre a mark is a few dozen pixels on screen, and
  // only what is thick enough to survive the mip levels reads there.
  function markSpokes(ctx,S,seed,count,from,to,colours,width){
    var c=S/2,r=S*.47,rnd=markNoise(seed),i,a,r0,r1;ctx.lineCap='round';
    for(i=0;i<count;i++){
      a=i/count*Math.PI*2+rnd()*.5;r0=r*(from+rnd()*.05);r1=r*(to-rnd()*.06);
      ctx.strokeStyle=colours[i%colours.length];ctx.lineWidth=S*width;
      ctx.beginPath();ctx.moveTo(c+Math.cos(a)*r0,c+Math.sin(a)*r0);ctx.lineTo(c+Math.cos(a)*r1,c+Math.sin(a)*r1);ctx.stroke();
    }
  }
  // PENETRATION. Outwards from the middle: the black pit, a dark red glow just inside the lip (hot metal seen
  // THROUGH the hole), a sharp step to bright bare steel, a thin burnt-paint edge. The dark core is about 70 %
  // of the disc - half a calibre of hole in a 0.7-calibre mark - and the steel ring is what makes it read.
  function drawHole(ctx,S){
    markDisc(ctx,S,[0,'rgba(4,3,3,1)',.46,'rgba(9,6,5,1)',.58,'rgba(74,16,6,1)',.67,'rgba(142,40,12,1)',
      .7,'rgba(58,40,34,1)',.74,'rgba(206,210,212,1)',.86,'rgba(176,181,184,.96)',.9,'rgba(30,26,23,.9)',1,'rgba(20,17,15,0)']);
    markSpokes(ctx,S,0x9e3779b9,9,.74,.9,['rgba(22,18,16,.55)','rgba(22,18,16,.55)','rgba(240,243,244,.5)'],.02);
  }
  // NO PENETRATION. A metallic scrape and nothing else: bright scored metal inside, the paint burnt black
  // round it, the light caught a little off-centre so it reads as a dent and not as a printed ring.
  function drawScuff(ctx,S){
    markDisc(ctx,S,[0,'rgba(246,247,247,.96)',.4,'rgba(214,217,219,.94)',.6,'rgba(150,154,157,.92)',
      .7,'rgba(42,38,35,.96)',.88,'rgba(18,16,15,.84)',1,'rgba(18,16,15,0)'],S*.46,S*.45);
    markSpokes(ctx,S,0x85ebca6b,5,.12,.62,['rgba(96,98,100,.55)','rgba(255,255,255,.6)'],.018);
  }
  // A lens along the texture's V axis - the footprint's SLIDE, the way the projection stretches it - from
  // one edge of the picture to the other, `half` of the texture wide at its middle, filled ACROSS by a
  // linear gradient (its sides dark, its middle light).
  function markLens(ctx,S,half,stops){
    var c=S/2,y0=S*.02,y1=S*.98,w=S*half,g=ctx.createLinearGradient(c-w,c,c+w,c),i;
    for(i=0;i<stops.length;i+=2)g.addColorStop(stops[i],stops[i+1]);
    ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(c,y0);
    ctx.quadraticCurveTo(c+2*w,c,c,y1);ctx.quadraticCurveTo(c-2*w,c,c,y0);
    ctx.closePath();ctx.fill();
  }
  // RICOCHET. The classic skid: a scrape drawn from edge to edge of the footprint along the slide, lighter
  // and greyer than the stopped shell's - light in the middle, dark GREY at its sides rather than burnt
  // black, one bold score line down its length. It is a lens in a square: the angle the shell came in at
  // stretches that square along the plate, and the stretch is the length of the skid.
  function drawGraze(ctx,S){
    markLens(ctx,S,.3,[0,'rgba(84,84,83,0)',.12,'rgba(84,84,83,.82)',.34,'rgba(200,202,203,.88)',
      .5,'rgba(250,250,250,.94)',.66,'rgba(200,202,203,.88)',.88,'rgba(84,84,83,.82)',1,'rgba(84,84,83,0)']);
    var c=S/2;ctx.lineCap='round';ctx.strokeStyle='rgba(118,119,120,.5)';ctx.lineWidth=S*.018;
    ctx.beginPath();ctx.moveTo(c+S*.035,S*.2);ctx.lineTo(c+S*.02,S*.8);ctx.stroke();
  }
  // The three textures, for the whole page: built at the first Hitmark and never again, whatever happens
  // to the meshes afterwards. Exposed so a harness can see that asking twice gives the very same objects.
  var markTextures=null;
  function markSheet(){
    if(markTextures)return markTextures;
    markTextures={pen:markTexture(drawHole,MARK_TEX),'no-pen':markTexture(drawScuff,MARK_TEX),ricochet:markTexture(drawGraze,MARK_TEX)};
    return markTextures;
  }
  Viewer.hitMarkTextures=markSheet;
  // The page keeps what a shot's marks were made of so a rebuilt scene can have them back, and it keeps no
  // more shots than the ring does. One number, asked for, never copied into the page.
  Viewer.prototype.hitMarkLimit=function(){return MARK_LIMIT;};
  // ---- cutting one decal out of the model ----------------------------------------------------------
  // The surfaces a decal may be cut from are exactly the meshes the shot itself was cast against (pinAt,
  // pinAtPoint): the painted armour and the tracks. Nothing is rebuilt, re-posed or triangulated a second
  // time - a decal lies on the very geometry the ray met.
  function markSurfaces(viewer){
    var list=[];
    if(viewer.paintMesh)list.push(viewer.paintMesh);
    if(viewer.trackMesh)list.push(viewer.trackMesh);
    return list;
  }
  // The triangle records a surface was built from, one per three vertices (rebuild, updateTracks): where a
  // triangle came from, its PART among it. null for a mesh made any other way.
  function markTriangles(viewer,mesh){return mesh===viewer.paintMesh?viewer.samples:mesh===viewer.trackMesh?viewer.trackTriangles:null;}
  var markM4=null,markQuery=null,markMin=null,markMax=null,markTmp=null;
  function markScratch(){
    var T=THREE;
    if(!markM4){markM4=new T.Matrix4();markQuery=new T.Box3();
      markMin=new T.Vector3();markMax=new T.Vector3();markTmp=new T.Vector3();}
  }
  function markPush(out,e,x,y,z){out.push(e[0]*x+e[4]*y+e[8]*z+e[12],e[1]*x+e[5]*y+e[9]*z+e[13],e[2]*x+e[6]*y+e[10]*z+e[14]);}
  // Every triangle of one surface whose own box meets the query box, in WORLD coordinates and flat - nine
  // numbers a triangle. A geometry that carries a three-mesh-bvh bounds tree is asked through it; otherwise
  // the triangles are walked once with a box reject each, which on the heaviest exported model is a few
  // thousand rejects, ONCE PER SHOT and never per frame (outputs/optimization-plan-2026-09-21.md, the page
  // frame: nothing here runs while the page stands still).
  // ONE PART'S triangles only, when `part` is given (user, 22.09, 23:15): a mark belongs to the part it was
  // laid on and turns with it, so it must stop at that part's edge like at any other - a mark on a mantlet
  // flush with the turret face must not run onto the turret and be left behind when the gun pitches. The
  // part is read from the triangle's own record (`parts`, one entry per three vertices); a mesh made any
  // other way has none, and is not filtered.
  function markGather(mesh,lo,hi,out,parts,part){
    var geometry=mesh&&mesh.geometry,position=geometry&&geometry.getAttribute?geometry.getAttribute('position'):null;
    if(!position||!position.array)return out;
    markScratch();
    var world=mesh.matrixWorld,e=world.elements,tree=geometry.boundsTree,index=geometry.index,idx=index?index.array:null;
    var only=part!==undefined&&part!==null&&parts&&parts.length*3===position.count?part:null;
    markQuery.set(lo,hi).applyMatrix4(markM4.copy(world).invert());
    if(tree&&typeof tree.shapecast==='function'){
      var box=markQuery.clone();
      tree.shapecast({intersectsBounds:function(bounds){return bounds.intersectsBox(box);},
        intersectsTriangle:function(tri,at){
          if(only!==null){var own=parts[((idx?idx[at*3]:at*3)/3)|0];if(!own||own.part!==only)return false;}
          markPush(out,e,tri.a.x,tri.a.y,tri.a.z);markPush(out,e,tri.b.x,tri.b.y,tri.b.z);markPush(out,e,tri.c.x,tri.c.y,tri.c.z);
          return false;}});
      return out;
    }
    var array=position.array,n=idx?idx.length:position.count,q=markQuery,i,a,b,c,t;
    for(i=0;i+2<n;i+=3){
      a=idx?idx[i]:i;
      if(only!==null){t=parts[(a/3)|0];if(!t||t.part!==only)continue;}
      a*=3;b=(idx?idx[i+1]:i+1)*3;c=(idx?idx[i+2]:i+2)*3;
      var ax=array[a],ay=array[a+1],az=array[a+2],bx=array[b],by=array[b+1],bz=array[b+2],cx=array[c],cy=array[c+1],cz=array[c+2];
      if(Math.min(ax,bx,cx)>q.max.x||Math.max(ax,bx,cx)<q.min.x)continue;
      if(Math.min(ay,by,cy)>q.max.y||Math.max(ay,by,cy)<q.min.y)continue;
      if(Math.min(az,bz,cz)>q.max.z||Math.max(az,bz,cz)<q.min.z)continue;
      markPush(out,e,ax,ay,az);markPush(out,e,bx,by,bz);markPush(out,e,cx,cy,cz);
    }
    return out;
  }
  // The triangle's own normal, in the winding the model was exported with. Which way that points is never
  // assumed anywhere below: the FACET THE SHELL STRUCK is the reference, and every other triangle is judged
  // against it, so the marks come out the same whichever way the exporter wound the mesh.
  function markNormal(tri,i,target){
    return target.set(tri[i+3]-tri[i],tri[i+4]-tri[i+1],tri[i+5]-tri[i+2])
      .cross(markTmp.set(tri[i+6]-tri[i],tri[i+7]-tri[i+1],tri[i+8]-tri[i+2])).normalize();
  }
  // The squared distance from a point to one triangle (Ericson, Real-Time Collision Detection): the exact
  // test, so the struck facet is found without a second raycast and without trusting a normal's sign.
  function markDistance(t,i,px,py,pz){
    var ax=t[i],ay=t[i+1],az=t[i+2],abx=t[i+3]-ax,aby=t[i+4]-ay,abz=t[i+5]-az,acx=t[i+6]-ax,acy=t[i+7]-ay,acz=t[i+8]-az;
    var apx=px-ax,apy=py-ay,apz=pz-az,d1=abx*apx+aby*apy+abz*apz,d2=acx*apx+acy*apy+acz*apz,x,y,z,v,w;
    if(d1<=0&&d2<=0)return apx*apx+apy*apy+apz*apz;
    var bpx=apx-abx,bpy=apy-aby,bpz=apz-abz,d3=abx*bpx+aby*bpy+abz*bpz,d4=acx*bpx+acy*bpy+acz*bpz;
    if(d3>=0&&d4<=d3)return bpx*bpx+bpy*bpy+bpz*bpz;
    var vc=d1*d4-d3*d2;
    if(vc<=0&&d1>=0&&d3<=0){v=d1/(d1-d3);x=abx*v-apx;y=aby*v-apy;z=abz*v-apz;return x*x+y*y+z*z;}
    var cpx=apx-acx,cpy=apy-acy,cpz=apz-acz,d5=abx*cpx+aby*cpy+abz*cpz,d6=acx*cpx+acy*cpy+acz*cpz;
    if(d6>=0&&d5<=d6)return cpx*cpx+cpy*cpy+cpz*cpz;
    var vb=d5*d2-d1*d6;
    if(vb<=0&&d2>=0&&d6<=0){w=d2/(d2-d6);x=acx*w-apx;y=acy*w-apy;z=acz*w-apz;return x*x+y*y+z*z;}
    var va=d3*d6-d5*d4;
    if(va<=0&&d4-d3>=0&&d5-d6>=0){w=(d4-d3)/(d4-d3+d5-d6);x=abx+(acx-abx)*w-apx;y=aby+(acy-aby)*w-apy;z=abz+(acz-abz)*w-apz;return x*x+y*y+z*z;}
    var den=1/(va+vb+vc);v=vb*den;w=vc*den;x=abx*v+acx*w-apx;y=aby*v+acy*w-apy;z=abz*v+acz*w-apz;
    return x*x+y*y+z*z;
  }
  // The facet the shell struck: the triangle nearest the impact point.
  function markFacet(tri,point){
    var at=-1,best=Infinity,i,d;
    for(i=0;i<tri.length;i+=9){d=markDistance(tri,i,point.x,point.y,point.z);if(d<best){best=d;at=i;}}
    return at;
  }
  // Sutherland-Hodgman against ONE plane: keep everything with coordinate·sign <= limit. A vertex is FOUR
  // numbers - x, y, z in the shot's box and w, its height over the struck facet's plane - all four linear in
  // the point, so one cut interpolates them alike. The polygon keeps the source triangle's order, so the
  // winding survives the eight cuts and the decal's faces can be turned to the shot side once, by one flag.
  function markClip(poly,axis,limit,sign){
    var out=[],n=poly.length/4,i,j,k,ai,bi,inside,next,t;
    for(i=0;i<n;i++){
      j=(i+1)%n;ai=poly[i*4+axis]*sign;bi=poly[j*4+axis]*sign;inside=ai<=limit;next=bi<=limit;
      if(inside)out.push(poly[i*4],poly[i*4+1],poly[i*4+2],poly[i*4+3]);
      if(inside!==next){
        t=(limit-ai)/(bi-ai);
        for(k=0;k<4;k++)out.push(poly[i*4+k]+(poly[j*4+k]-poly[i*4+k])*t);
      }
    }
    return out;
  }
  // How deep one shot's box reaches along the shell's line, from a facet normal of either sign. A footprint
  // met at the incidence i lies (size / 2) / cos i each way along the plate, which the box holds with a
  // depth of that times sin i - plus the slab, so a square-on box is exactly as deep as the slab is thick.
  // `reach` is that half-length on the plate, held to MARK_REACH by the one guard against infinity.
  function markBox(dir,n,size){
    var cosI=Math.min(1,Math.abs(dir.dot(n))),sinI=Math.sqrt(Math.max(0,1-cosI*cosI));
    var plane=Math.max(MARK_PLANE_FLOOR,MARK_PLANE*size),reach=cosI>0?Math.min(MARK_REACH,size/(2*cosI)):MARK_REACH;
    return {cosI:cosI,sinI:sinI,plane:plane,reach:reach,depth:reach*sinI+plane};
  }
  // The world box that holds the shot's box whichever way it is turned round the shell's line (its square
  // cross-section is bounded by size·√2/2 across the line), and the triangles in it, over every surface:
  // ONE pass over the model per shot.
  function markCollect(viewer,point,dir,size,box,part){
    var lo=markMin,hi=markMax,k,d,e,p;
    for(k=0;k<3;k++){
      d=dir.getComponent(k);p=point.getComponent(k);
      e=size/2*Math.SQRT2*Math.sqrt(Math.max(0,1-d*d))+box.depth*Math.abs(d)+1e-4;
      lo.setComponent(k,p-e);hi.setComponent(k,p+e);
    }
    var tri=[],surfaces=markSurfaces(viewer),s;
    for(s=0;s<surfaces.length;s++)markGather(surfaces[s],lo,hi,tri,markTriangles(viewer,surfaces[s]),part);
    return tri;
  }
  // ONE decal, cut out of the model. `mark` is one contact in WORLD coordinates - {point, normal, from, dir,
  // outcome, caliber, roll, part} - which addHitMark makes out of the page's own record of a shot, and
  // everything this reads comes out of it and out of the geometry, never out of the camera of the moment,
  // so a contact laid again is the SAME decal, vertex for vertex. `part` keeps the cut to that part's own
  // plates; without one every surface counts. Nothing is stored twice: the viewer keeps no copy of the
  // record, the page no copy of this geometry. Returns null when the contact met no armour at all, or when
  // its shell has no calibre in the record (the shot's verdict and damage stand all the same).
  Viewer.prototype.hitMarkGeometry=function(mark){
    if(!mark||!mark.point||!mark.normal)return null;
    var caliber=Number(mark.caliber);
    if(!(caliber>0))return null;
    var T=THREE,point=mark.point,eye=mark.from||this.camera.position;
    var dir=mark.dir?mark.dir.clone():point.clone().sub(eye);
    if(dir.lengthSq()<1e-12)return null;
    dir.normalize();
    var hint=new T.Vector3().copy(mark.normal);
    if(hint.lengthSq()<1e-12)return null;
    hint.normalize();
    var size=MARK_ENTRY*caliber/1000;
    markScratch();
    // ONE pass over the model, through the box the record's own normal lays out; the facet found under the
    // point then gives the decal its normal, the side it is lifted to and the plane everything is cut to.
    var asked=markBox(dir,hint,size),tri=markCollect(this,point,dir,size,asked,mark.part);
    if(!tri.length)return null;
    var at=markFacet(tri,point),ref=markNormal(tri,at,new T.Vector3());
    if(ref.lengthSq()<1e-12)return null;
    var box=markBox(dir,ref,size);
    if(Math.abs(ref.dot(hint))<MARK_AGREE||box.depth>asked.depth+1e-5){
      tri=markCollect(this,point,dir,size,box,mark.part);
      at=markFacet(tri,point);markNormal(tri,at,ref);
    }
    // WHICH WAY A DECAL FACES (user, 22.09: "the hit marks are not visible" - 0.7.25 left not one of them
    // on screen). The exported collision meshes are wound the other way round: measured over 12 files and
    // 13 299 triangles, not ONE face normal points out of the vehicle, which is why the painted mesh is
    // drawn DoubleSide (docs/KNOWLEDGE.md §9). So the decal is turned to the side the shot CAME from, and
    // `sign` carries that turn through the winding of every piece as well - front-face culling then still
    // does the occlusion the depth buffer cannot, and orbiting past the plate takes its marks with it.
    var sign=ref.dot(markTmp.copy(eye).sub(point))<0?-1:1;
    var n=ref.clone().multiplyScalar(sign);
    // The box. Z along the shell's travel; Y along the slide - the normal's own component across the shot,
    // which is the direction the footprint stretches in - and X across it. A square-on hit has no slide, so
    // it is turned by the roll the page drew for that shot and a burst does not stamp one picture twice.
    var up=n.clone().addScaledVector(dir,-n.dot(dir));
    if(up.lengthSq()>MARK_SLIDE*MARK_SLIDE)up.normalize();
    else{
      var roll=Number(mark.roll);
      up=new T.Vector3().crossVectors(dir,Math.abs(dir.y)>.9?new T.Vector3(1,0,0):new T.Vector3(0,1,0)).normalize()
        .applyAxisAngle(dir,Number.isFinite(roll)?roll:0);
    }
    var right=new T.Vector3().crossVectors(up,dir);   // (right, up, dir) is right-handed: windings survive
    var half=size/2,depth=box.depth,plane=box.plane,pos=[],nrm=[],uvs=[],fn=new T.Vector3(),i,k,v,o,m;
    for(i=0;i<tri.length;i+=9){
      markNormal(tri,i,fn);
      if(fn.lengthSq()<1e-12||fn.dot(ref)<MARK_FACING)continue;   // another plate, the back of this one, or across it
      var fx=fn.x*sign,fy=fn.y*sign,fz=fn.z*sign,poly=[];
      for(k=0;k<9;k+=3){
        var dx=tri[i+k]-point.x,dy=tri[i+k+1]-point.y,dz=tri[i+k+2]-point.z;
        poly.push(dx*right.x+dy*right.y+dz*right.z,dx*up.x+dy*up.y+dz*up.z,dx*dir.x+dy*dir.y+dz*dir.z,dx*n.x+dy*n.y+dz*n.z);
      }
      poly=markClip(poly,0,half,1);if(poly.length<12)continue;
      poly=markClip(poly,0,half,-1);if(poly.length<12)continue;
      poly=markClip(poly,1,half,1);if(poly.length<12)continue;
      poly=markClip(poly,1,half,-1);if(poly.length<12)continue;
      poly=markClip(poly,2,depth,1);if(poly.length<12)continue;
      poly=markClip(poly,2,depth,-1);if(poly.length<12)continue;
      // THE PLATE, AND ONLY IT (user, 22.09, 22:50): a long grazing box reaches far past the struck plate,
      // and the normal alone would let it paint a spaced plate behind or a plate parallel to this one. The
      // slab keeps what lies within `plane` of the struck facet's own plane, and nothing else.
      poly=markClip(poly,3,plane,1);if(poly.length<12)continue;
      poly=markClip(poly,3,plane,-1);if(poly.length<12)continue;
      m=poly.length/4;
      for(k=1;k+1<m;k++)for(v=0;v<3;v++){
        o=(v===0?0:sign>0?(v===1?k:k+1):(v===1?k+1:k))*4;
        var x=poly[o],y=poly[o+1],z=poly[o+2];
        pos.push(point.x+right.x*x+up.x*y+dir.x*z+fx*MARK_LIFT,
                 point.y+right.y*x+up.y*y+dir.y*z+fy*MARK_LIFT,
                 point.z+right.z*x+up.z*y+dir.z*z+fz*MARK_LIFT);
        nrm.push(fx,fy,fz);
        uvs.push(Math.min(1,Math.max(0,x/size+.5)),Math.min(1,Math.max(0,y/size+.5)));
      }
    }
    if(!pos.length)return null;
    return {count:pos.length/3,position:new Float32Array(pos),normal:new Float32Array(nrm),uv:new Float32Array(uvs),
            facing:n,across:right,along:up,size:size,depth:depth,plane:plane,reach:box.reach,
            incidence:Math.acos(box.cosI),triangles:tri.length/9};
  };
  // ---- every plate the shell met, from the verdict's own path (user, 22.09, 23:15) ----------------
  // A shell meets more than one plate - a screen, a track, a skirt, then the main armour; or a plate that
  // turns it away and the plate it flies into next - and each contact is a mark of its own, with its own
  // outcome. All of them are read out of the ONE ray the shot has already cast (pinResult): the layers the
  // verdict walked carry how far along the line each plate was met and the facet it was met on
  // (ballistics.js walk), so nothing is cast, walked or evaluated a second time here.
  //   a plate the shell went on past (a screen, a track)  - a hole: the penetration mark;
  //   the plate the verdict ended on                       - the shot's own outcome, as the page rolled it;
  //   a screen an HE shell died on short of the hull       - the stop, and nothing behind it;
  //   a plate that turned the shell away                   - the ricochet mark. The page's engine FOLLOWS a
  //     ricochet (ArmorBallistics ray(), the client rule since 9.3: the shell flies on along the mirrored line
  //     with 75 % of its penetration) and judges the next contact, so that flight's plates are marked too;
  //   the far face of a plate the shell went through       - nothing: it is folded into that plate.
  // A shell that went through its screens and missed the hull leaves the holes and nothing else.
  function markDot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function markAt(o,d,t){return [o[0]+d[0]*t,o[1]+d[1]*t,o[2]+d[2]*t];}
  // The plates of one leg, the far face of each plate folded into it. The next layer of the same part and
  // material met on a facet facing the other way is where the shell LEFT the plate it had just entered -
  // told by the pair's own facets, so it holds whichever way the exporter wound the mesh. `at` maps every
  // layer to its plate.
  function markPlates(layers){
    var plates=[],at=[],last=null,i,l;
    for(i=0;i<layers.length;i++){
      l=layers[i];
      if(last&&last.part===l.part&&last.material===l.material&&last.normal&&l.normal&&markDot(last.normal,l.normal)<0){at.push(plates.length-1);last=null;continue;}
      plates.push(l);at.push(plates.length-1);last=l;
    }
    return {plates:plates,at:at};
  }
  function markContact(out,part,point,normal,o,d,outcome){out.push({part:part,point:point,normal:normal,from:o,dir:d,outcome:outcome});}
  // One leg along o + d·t: every plate before the one layer `end` names was passed - a hole each; a plate
  // with no armour at all is not armour and gets none - and that plate gets `outcome`. end < 0: holes only.
  function markLeg(out,layers,o,d,end,outcome){
    var folded=markPlates(layers||[]),plates=folded.plates,stop=end>=0?folded.at[end]:plates.length,i,l;
    for(i=0;i<plates.length&&i<=stop;i++){
      l=plates[i];
      if(!Number.isFinite(l.distance)||!l.normal)continue;
      if(i===stop){markContact(out,l.part,markAt(o,d,l.distance),l.normal,o,d,outcome);break;}
      if(l.nominal>0)markContact(out,l.part,markAt(o,d,l.distance),l.normal,o,d,'pen');
    }
  }
  // Every contact of one shot, in the coordinates of the engine that judged it. `line` is the pinned line -
  // the first leg, the one a bounce leaves - and `verdict` what the page rolled for the shot ({outcome, u}):
  // it decides nothing here but which plate the shell ended on. The outcome of the shot itself is the
  // page's (funVerdict), untouched; only the marks multiply.
  function markContacts(r,line,verdict){
    var out=[];
    if(!r||!line||!line.origin||!line.direction)return out;
    var outcome=verdict&&verdict.outcome?verdict.outcome:'unknown',u=verdict?Number(verdict.u):NaN;
    var b=r.bounce,o=r.origin,d=r.direction,layers=r.layers||[],last=layers.length-1,end,i;
    if(b){
      var o1=line.origin.toArray(),d1=line.direction.clone().normalize().toArray();
      markLeg(out,b.layers,o1,d1,-1,'pen');
      if(b.point&&b.normal)markContact(out,b.part,b.point,b.normal,o1,d1,'ricochet');
    }
    if(!o||!d)return out;
    if(r.reason==='penetration'&&last>=0){
      end=last;
      // funVerdict: a roll at or above the screen-pass chance is a shell stopped on a screen. The pass
      // chances of successive screens nest, so it died on the first screen whose own chance it did not beat.
      var pass=r.screenPass===undefined||r.screenPass===null?1:r.screenPass;
      if(outcome==='no-pen'&&u>=pass){
        end=-1;
        for(i=0;i<last;i++)if(Number.isFinite(layers[i].through)&&u>=layers[i].through/100){end=i;break;}
        if(end<0)end=last>0?last-1:last;
      }
      markLeg(out,layers,o,d,end,end===last?outcome:'no-pen');
    }else if(r.reason==='ricochet'&&r.hit){
      markLeg(out,layers,o,d,-1,'pen');
      markContact(out,r.hit.triangle.part,markAt(o,d,r.hit.distance),r.hit.triangle.normal,o,d,'ricochet');
    }else if(r.reason==='screen'&&last>=0)markLeg(out,layers,o,d,last,'no-pen');
    else if(r.reason==='no-hull')markLeg(out,layers,o,d,-1,'pen');
    return out;
  }
  // ---- each mark lives in its PART (user, 22.09, 23:15) -----------------------------------------------
  // A mark on the turret turns with the turret and one on the gun pitches with the gun. So a mark is kept in
  // the coordinates of the part it was laid on: the part's world matrix is the mirror the engine puts on z,
  // the pose the turret and gun are turned to (poseExtra), the part's own recorded transform and the mirror
  // again - so the local coordinates are the part's own model coordinates, the same on every hit of this
  // vehicle whatever pose that hit recorded, and a proper rotation, never a mirror. Every part with marks
  // has ONE group in the scene carrying that matrix, and its marks are children of it: turning the turret
  // sets two matrices (previewPose while the drag lasts, rebuild when it settles) and moves no vertex; the
  // page's frame does nothing at all. markDrawn is the pose on screen, markBuilt the one the engine - and so
  // every contact of pinResult - was built in; they differ only while a drag is still being previewed.
  Viewer.prototype.markFrames=function(extra){
    var T=THREE,parts=(((this.loadedData||{}).hit||{}).target||{}).parts||[],mirror=new T.Matrix4().makeScale(1,1,-1),out={};
    parts.forEach(function(p){
      if(!p||!p.transform)return;
      var m=new T.Matrix4().fromArray(p.transform);
      if(extra&&extra[p.id])m.premultiply(extra[p.id]);
      out[p.id]=m.premultiply(mirror).multiply(mirror);
    });
    return out;
  };
  // A part's frame, or null for the world itself (a contact with no part, a model with no transforms).
  Viewer.prototype.markFrame=function(part,built){
    var frames=built?this.markBuilt:this.markDrawn;
    return part===undefined||part===null||!frames?null:frames[part]||null;
  };
  // Every group onto the pose now drawn. Called only when the pose changes, never per frame.
  Viewer.prototype.poseHitMarks=function(){
    var sets=this.markSets,key,set,frame;
    if(!sets)return;
    for(key in sets){
      set=sets[key];frame=this.markFrame(set.part,false);
      if(frame)set.group.matrix.copy(frame);else set.group.matrix.identity();
      set.group.matrixWorldNeedsUpdate=true;
    }
  };
  function markVector(v){return v&&v.isVector3?v.clone():new THREE.Vector3().fromArray(v);}
  // One contact moved by a matrix (or kept as it is, for null) - points as points, directions as directions.
  function markMoved(c,m){
    var point=markVector(c.point),normal=markVector(c.normal),from=c.from?markVector(c.from):null,dir=c.dir?markVector(c.dir):null;
    if(m){point.applyMatrix4(m);normal.transformDirection(m);if(from)from.applyMatrix4(m);if(dir)dir.transformDirection(m);}
    return {part:c.part,point:point,normal:normal,from:from,dir:dir,outcome:c.outcome};
  }
  // ONE SHOT, as the record the page keeps (funMark): {caliber, roll, marks}, one entry of `marks` per
  // contact - its part, its own outcome, and its point, normal, line and origin in that PART's coordinates -
  // so the record laid again after the turret has turned, or on another hit of the same vehicle, lands on the
  // very same spot of the very same plate. `verdict` is the page's roll for the shot ({outcome, u}), `roll`
  // the turn a square-on decal gets round its line, drawn by the page once for the whole shot. A shot the
  // path could not place at all - no shell, no armour table - keeps the one mark it always had, at the
  // pinned point on the drawn model, with the verdict's outcome (the muted scrape of an unjudged shot).
  Viewer.prototype.hitMarkShot=function(verdict,caliber,roll){
    var pin=this.pinned;
    if(!pin||!pin.point)return null;
    var list=markContacts(this.pinResult,pin,verdict),marks=[],i,frame;
    for(i=0;i<list.length;i++){frame=this.markFrame(list[i].part,true);marks.push(markMoved(list[i],frame?new THREE.Matrix4().copy(frame).invert():null));}
    if(!marks.length&&pin.normal){
      frame=this.markFrame(pin.part,false);
      marks.push(markMoved({part:pin.part,point:pin.point,normal:pin.normal,from:pin.origin,dir:pin.direction,
        outcome:verdict&&verdict.outcome?verdict.outcome:'unknown'},frame?new THREE.Matrix4().copy(frame).invert():null));
    }
    return marks.length?{caliber:caliber,roll:roll,marks:marks}:null;
  };
  // ---- the buffers: one merged geometry per PART and outcome -------------------------------------------
  // A mark's texture is its material, so a mesh cannot mix outcomes, and its part is its group, so a mesh
  // cannot mix parts: one merged geometry per (part x outcome), made when that part first takes a mark of
  // that outcome - a hull that was only ever pierced has one mesh. ONE ring of MARK_LIMIT SHOTS runs across
  // all of them: every contact of a shot is a piece in its own buffer, and the shot is one slot, so the cap
  // is on the shots and an evicted shot takes every one of its pieces with it. A piece is APPENDED to its
  // buffer and only the new tail is uploaded; a buffer is rebuilt (in place, by one copyWithin) only when
  // the ring evicts a piece out of the middle of it. Nothing at all happens per frame: a standing page draws
  // meshes that have not changed since the last shot, and an empty one is not drawn at all.
  // DEPTH: the map is composed as a full-screen quad that writes no depth, so a depth-tested decal is not
  // hidden by it; renderOrder 3 puts the marks after that quad (0) and after the screens (1, 2) and before
  // the tracers (4), the recorded rings (12) and the live ring (14). With the map off the painted mesh
  // does write depth, and MARK_LIFT plus polygonOffset keep the decal in front of the plate it lies on.
  // vertexColors AND a colour attribute: the muted tint of an unjudged shot is written into the vertices
  // themselves, which is the one tint there is (0.7.26 lost its palette by leaving vertexColors off).
  // The three materials are shared by every part: one per outcome, wearing its texture.
  function markKey(part){return part===undefined||part===null?'w':String(part);}
  Viewer.prototype.markSet=function(part){
    var sets=this.markSets||(this.markSets={}),key=markKey(part);
    if(sets[key])return sets[key];
    var group=new THREE.Group(),frame=this.markFrame(part,false);
    group.matrixAutoUpdate=false;if(frame)group.matrix.copy(frame);group.matrixWorldNeedsUpdate=true;
    this.scene.add(group);
    return (sets[key]={part:part,group:group,meshes:{}});
  };
  Viewer.prototype.markMesh=function(set,kind){
    if(set.meshes[kind])return set.meshes[kind];
    var materials=this.markMaterials||(this.markMaterials={});
    var material=materials[kind]||(materials[kind]=new THREE.MeshBasicMaterial({map:markSheet()[kind],vertexColors:true,transparent:true,opacity:1,
      depthTest:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4,toneMapped:false}));
    var mesh=new THREE.Mesh(markBuffer(null,MARK_START),material);
    mesh.renderOrder=3;mesh.frustumCulled=false;mesh.visible=false;
    mesh.userData.chunks=[];mesh.userData.vertices=0;
    set.meshes[kind]=mesh;set.group.add(mesh);
    return mesh;
  };
  // The three meshes of one part (the world's own set without one), made if they are not there yet.
  Viewer.prototype.hitMarkMeshes=function(part){
    var set=this.markSet(part),self=this,meshes={};
    MARK_KINDS.forEach(function(kind){meshes[kind]=self.markMesh(set,kind);});
    return meshes;
  };
  // A buffer for `size` vertices, carrying over what an older one held. Growing means a NEW geometry and a
  // dispose of the old one: three frees a geometry's GL buffers on dispose and not on a replaced attribute,
  // so this is the one way to double the room without leaking the old buffers for the life of the page.
  function markBuffer(from,size){
    var T=THREE,geometry=new T.BufferGeometry(),live=from?from.drawRange.count:0;
    MARK_ATTRIBUTES.forEach(function(name){
      var old=from?from.getAttribute(name):null,items=name==='uv'?2:3,array=new Float32Array(size*items);
      if(old)array.set(old.array.subarray(0,live*items));
      var attribute=new T.BufferAttribute(array,items);
      if(attribute.setUsage&&T.DynamicDrawUsage)attribute.setUsage(T.DynamicDrawUsage);
      if(attribute.onUpload)attribute.onUpload(markUploaded);
      geometry.setAttribute(name,attribute);
    });
    geometry.setDrawRange(0,live);
    if(from)from.dispose();
    return geometry;
  }
  // The uploads: an append touches only its own tail (addUpdateRange), a rebuilt buffer goes up whole.
  // three uploads ONLY the listed ranges whenever there is one, so a buffer that owes a whole upload - a
  // mark slid out of its middle - stays owed one until three has really sent it (onUpload): otherwise the
  // ring's usual step, evict the oldest and append the newest to the same buffer before the next frame,
  // would send the new tail alone and leave the slid-down marks stale on the GPU.
  function markUploaded(){this.markWhole=false;}
  function markTouch(geometry,from,count,whole){
    MARK_ATTRIBUTES.forEach(function(name){
      var a=geometry.getAttribute(name);
      if(whole||a.markWhole){a.markWhole=true;if(a.clearUpdateRanges)a.clearUpdateRanges();}
      else if(a.addUpdateRange)a.addUpdateRange(from*a.itemSize,count*a.itemSize);
      a.needsUpdate=true;
    });
  }
  // Which outcome a mark wears. Anything the page could not judge takes the scrape, muted.
  function markKind(outcome){return outcome==='pen'?'pen':outcome==='ricochet'?'ricochet':'no-pen';}
  // A piece is cut in world coordinates, off the model as it is drawn, and kept in its part's own: the
  // inverse of the very matrix its group is drawn with. With no frame it is written as it was cut, bit for
  // bit. A frame that mirrors would turn the winding inside out, so each triangle is then written the
  // other way round (0, 2, 1) and still faces the side the shot came from.
  var MARK_FLIP=[0,2,1];
  function markWrite(geometry,at,piece,frame){
    var pos=geometry.getAttribute('position').array,nrm=geometry.getAttribute('normal').array,uv=geometry.getAttribute('uv').array;
    if(!frame){pos.set(piece.position,at*3);nrm.set(piece.normal,at*3);uv.set(piece.uv,at*2);return;}
    markScratch();
    var inv=markM4.copy(frame).invert(),e=inv.elements,flip=inv.determinant()<0,P=piece.position,N=piece.normal,i,k,s,d,x,y,z,l;
    for(i=0;i<piece.count;i++){
      k=flip?i-i%3+MARK_FLIP[i%3]:i;s=k*3;d=(at+i)*3;
      x=P[s];y=P[s+1];z=P[s+2];
      pos[d]=e[0]*x+e[4]*y+e[8]*z+e[12];pos[d+1]=e[1]*x+e[5]*y+e[9]*z+e[13];pos[d+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
      x=N[s];y=N[s+1];z=N[s+2];
      var nx=e[0]*x+e[4]*y+e[8]*z,ny=e[1]*x+e[5]*y+e[9]*z,nz=e[2]*x+e[6]*y+e[10]*z;l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      nrm[d]=nx/l;nrm[d+1]=ny/l;nrm[d+2]=nz/l;
      uv[(at+i)*2]=piece.uv[k*2];uv[(at+i)*2+1]=piece.uv[k*2+1];
    }
  }
  // ONE SHOT on the model: every contact of the record is cut out of the drawn model in the pose of the
  // moment (its part's frame puts the kept coordinates back into the world) and appended, as a piece, to
  // the buffer of its part and outcome - and the whole shot takes ONE slot of the ring. A record of one
  // contact with no `marks` list is its own contact. Returns false when not one contact met armour, or the
  // shell had no calibre: then there is nothing to keep.
  Viewer.prototype.addHitMark=function(shot){
    if(!shot)return false;
    var list=Array.isArray(shot.marks)?shot.marks:[shot],cut=[],i,c,frame,world,piece;
    for(i=0;i<list.length;i++){
      c=list[i];frame=this.markFrame(c.part,false);
      if(c===shot&&!frame)world=c;   // already in the world, as it stands
      else{world=markMoved(c,frame);world.caliber=c.caliber!==undefined?c.caliber:shot.caliber;world.roll=c.roll!==undefined?c.roll:shot.roll;}
      piece=this.hitMarkGeometry(world);
      if(piece)cut.push({part:c.part,outcome:c.outcome,piece:piece,frame:frame});
    }
    if(!cut.length)return false;
    if(!this.markSlots){this.markSlots=new Array(MARK_LIMIT);this.markCount=0;this.markNext=0;}
    var slot=this.markNext;
    if(this.markSlots[slot])this.dropHitMark(slot);
    for(i=0;i<cut.length;i++)cut[i]=this.markAppend(slot,cut[i]);
    this.markSlots[slot]=cut;
    this.markNext=(slot+1)%MARK_LIMIT;this.markCount++;
    this.draw();return true;
  };
  Viewer.prototype.markAppend=function(slot,c){
    var set=this.markSet(c.part),mesh=this.markMesh(set,markKind(c.outcome)),piece=c.piece;
    var at=mesh.userData.vertices,need=at+piece.count,room=mesh.geometry.getAttribute('position').count,grown=need>room;
    if(grown){while(room<need)room*=2;mesh.geometry=markBuffer(mesh.geometry,room);}
    var geometry=mesh.geometry,colour=new THREE.Color(c.outcome==='pen'||c.outcome==='no-pen'||c.outcome==='ricochet'?MARK_PLAIN:MARK_MUTED);
    markWrite(geometry,at,piece,c.frame);
    var tint=geometry.getAttribute('color').array,i;
    for(i=at;i<need;i++){tint[i*3]=colour.r;tint[i*3+1]=colour.g;tint[i*3+2]=colour.b;}
    markTouch(geometry,at,piece.count,grown);
    mesh.userData.vertices=need;geometry.setDrawRange(0,need);mesh.visible=true;
    var chunk={slot:slot,start:at,count:piece.count,mesh:mesh};
    mesh.userData.chunks.push(chunk);
    return chunk;
  };
  // A shot leaves the ring: each of its pieces leaves its own buffer - everything after it slides down by
  // one copyWithin an attribute - and a buffer left empty is no longer drawn. The buffers keep their room,
  // so a burst past the cap allocates nothing at all.
  function markCut(gone){
    var mesh=gone.mesh,chunks=mesh.userData.chunks,index=chunks.indexOf(gone);
    if(index<0)return;
    var geometry=mesh.geometry,live=mesh.userData.vertices,from=gone.start+gone.count,i;
    MARK_ATTRIBUTES.forEach(function(name){
      var a=geometry.getAttribute(name),items=a.itemSize;
      if(live>from)a.array.copyWithin(gone.start*items,from*items,live*items);
    });
    markTouch(geometry,0,0,true);
    chunks.splice(index,1);
    for(i=index;i<chunks.length;i++)chunks[i].start-=gone.count;
    mesh.userData.vertices=live-gone.count;geometry.setDrawRange(0,mesh.userData.vertices);mesh.visible=mesh.userData.vertices>0;
  }
  Viewer.prototype.dropHitMark=function(slot){
    var slots=this.markSlots,pieces=slots&&slots[slot];
    if(!pieces)return false;
    pieces.forEach(markCut);
    slots[slot]=null;this.markCount=Math.max(0,this.markCount-1);
    return true;
  };
  // The groups, their meshes and the three materials go; the three textures stay: they belong to the page,
  // not to this model.
  Viewer.prototype.clearHitMarks=function(){
    var sets=this.markSets,materials=this.markMaterials,self=this;
    this.markCount=0;this.markNext=0;this.markSlots=null;this.markSets=null;this.markMaterials=null;
    if(materials)MARK_KINDS.forEach(function(kind){if(materials[kind])materials[kind].dispose();});
    if(!sets)return false;
    Object.keys(sets).forEach(function(key){
      var set=sets[key];self.scene.remove(set.group);
      MARK_KINDS.forEach(function(kind){if(set.meshes[kind])set.meshes[kind].geometry.dispose();});
    });
    this.draw();return true;
  };
  // With the mode on, an emulated shot leaves a Hitmark instead of the big cross (refreshPin). The
  // recorded hit's own crosses and a manual Alt + click pin keep theirs: only the emulated shot changes.
  Viewer.prototype.setHitMarks=function(on){this.hitMarks=!!on;};
  window.ArmorViewer=Viewer;
}());
