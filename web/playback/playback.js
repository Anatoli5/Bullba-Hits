/* Bullba Hits' 3D replay player (BACKLOG 104; web/playback.html#battle=<id>): a recorded battle played over its map -
   the map's terrain, ground colours, light, objects and plants built in the page from the game's own files, the
   vehicles as their collision models from the product's vehicle files, their tracks, shots, hits and the destruction
   from the battle's replay. Ported from the trial work/map-playback/playback.js (rounds 2-9, the user's look settings
   kept); the trial's comparison modes and benches have no switch here. Inputs: data/playback/<id>.js (the mod's
   playback.py, asked for with the page command 'playback'), mapraw/ (the mod's map_raw.py) -> mapbuild-page.js, and
   data/vehicles, data/models. three.js r160 / WebGL 2 like the product's viewer, an engine of its own (web/viewer.js is
   not used). Coordinates: the game's world (left-handed: x east, y up, z north) inside one root group mirrored in z, as
   web/viewer.js mirrors the vehicle models. */
(function () {
  'use strict';
  var T = window.THREE;
  var store = {};
  window.MapPlayback = { receive: function (key, value) { store[key] = value; } };

  var params = {};
  (location.hash.slice(1) + '&' + location.search.slice(1)).split('&').forEach(function (kv) {
    var p = kv.split('='); if (p[0]) params[p[0]] = decodeURIComponent(p[1] || '');
  });
  // #battle=<id> (the start block below); MAP is the key of this battle's map records in `store`
  var MAP = '', BID = '', BATTLES = [];
  // The trial's comparison controls (other grounds, sun readings, collision objects, benches, the numbers) are not on
  // this page: what the code still writes into them goes to a detached stand-in, so the shared code paths stay as tested.
  var standIns = {};
  var $ = function (id) { return document.getElementById(id) || standIns[id] || (standIns[id] = document.createElement('input')); };

  function load(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script'); s.src = src; s.onload = ok;
      s.onerror = function () { fail(new Error('cannot load ' + src)); }; document.head.appendChild(s);
    });
  }
  function bytes(b64) {
    // round 8: the JS map builder (#build=js) hands typed arrays, not base64
    if (typeof b64 !== 'string') return b64.byteOffset === 0 && b64.byteLength === b64.buffer.byteLength ? b64.buffer : b64.slice().buffer;
    var s = atob(b64), n = s.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }
  var f32 = function (b) { return new Float32Array(bytes(b)); };
  var u16 = function (b) { return new Uint16Array(bytes(b)); };
  var u32 = function (b) { return new Uint32Array(bytes(b)); };
  var u8 = function (b) { return new Uint8Array(bytes(b)); };
  var i8 = function (b) { return new Int8Array(bytes(b)); };
  // u16 quantised over a range (build.py quant16 / objects_visual): -> Float32Array of k components
  function deq(b, min, range) {
    var q = u16(b), k = min.length, out = new Float32Array(q.length);
    for (var i = 0; i < q.length; i++) { var c = i % k; out[i] = min[c] + q[i] / 65535 * range[c]; }
    return out;
  }

  // ------------------------------------------------------------------ renderer, scene, light
  var renderer = new T.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  $('view').appendChild(renderer.domElement);
  var gl = renderer.getContext();
  var scene = new T.Scene();
  var SKY = 0xa9bccb;
  scene.background = new T.Color(SKY);
  scene.fog = new T.Fog(SKY, 700, 2600);
  var camera = new T.PerspectiveCamera(55, 1, 0.25, 4000);  // round 5d: near 0.25 m (was 0.5) for the eye at ~1 m
  var root = new T.Group(); root.scale.set(1, 1, -1); scene.add(root);
  // Sun: the map's environment.xml day_night_cycle angle (elevation) and angleZ, in one of 4 readings of angleZ
  // (the client's convention is not known; the page offers them, see setSun). Brighter than round 2.
  var hemi = new T.HemisphereLight(0xe4ecf4, 0x6a6452, 1.35); scene.add(hemi);
  var sun = new T.DirectionalLight(0xfff4e0, 2.3);
  var SUN_DIR = new T.Vector3(-0.55, 0.62, -0.56).normalize();
  function setSun(mode) {
    var s = mapData.sun || { angle: 45, angleZ: 0 }, e = s.angle * Math.PI / 180, az = 0;
    mode = +mode;
    if (mode === 4) { SUN_DIR.set(0.15, 1, 0.1).normalize(); sun.intensity = 1.1; hemi.intensity = 2.1; }
    else {
      az = [s.angleZ, s.angleZ + 180, 90 - s.angleZ, 270 - s.angleZ][mode] * Math.PI / 180;
      // toward the sun in game axes (x east, z north, azimuth clockwise from north), then the scene's mirrored z
      SUN_DIR.set(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e)).normalize();
      sun.intensity = 2.3; hemi.intensity = 1.35;
    }
    reliefU.uSunObj.value.set(SUN_DIR.x, SUN_DIR.y, -SUN_DIR.z);  // the scene mirrors z: back to game axes
    skyU.uSunD.value.copy(SUN_DIR);
    if (s.color) sun.color.setRGB(s.color[0], s.color[1], s.color[2]);
    $('sun-info').textContent = mode === 4 ? '' : 'elev. ' + s.angle.toFixed(1) + ', angleZ ' + s.angleZ.toFixed(1) +
      ' -> sun at azimuth ' + Math.round(((az * 180 / Math.PI) % 360 + 360) % 360);
    shadowHalf = 0;
  }
  // ---- round 5d: sky, and an optional distance haze. Sky (switch «sky», default on): a background by the view
  // direction's height - light sky overhead, darker toward the horizon into a dull grey haze band, below the horizon a
  // darker neutral grey (no sky under the map); colours by eye. The ground outside the playable box fades into the band
  // colour by the terrain's end (the game's own edge fog fades between an inner and an outer box), the playable ground
  // stays clear. Haze (switch «haze», default off, the user's word: the map must stay clear): exponential height fog
  // along the view ray with the map's environment.xml Fog values (deferred path: density per m D, height H,
  // heightFalloff F, startDistance S - read from the client's files; strength k by eye). Every material on the page takes
  // part through three.js's own fog chunks (patched before any program compiles). Both off = round 5's linear fog
  // 700-2600 m and the flat sky colour.
  var HAZE_ENV = {
    prohorovka: { D: 0.0004, H: 1, F: 0.004, S: 100, k: 1.0 },
    lakeville: { D: 0.0012, H: 50, F: 0.005, S: 25, k: 0.5 } };
  var SKY_FN = '';
  var SKY_COL = { zen: [0.62, 0.75, 0.90], band: [0.56, 0.58, 0.60], below: [0.33, 0.34, 0.35], black: [0.012, 0.014, 0.016] };  // display (sRGB) values
  // round 14 (the user, 19.11): two looks only - sky off (the default): black all round, the map hangs in the dark, and
  // nothing fades toward a sky colour; sky on: the sky above, the grey below the horizon. The in-between (sky over black)
  // and its grey switch are gone.
  var hazeOn = false, skyOn = false, skyMesh = null, skyU = { uHor: { value: new T.Vector3() }, uZen: { value: new T.Vector3() }, uLow: { value: new T.Vector3() }, uSunD: { value: new T.Vector3(0, 1, 0) } };
  function setupHaze() {
    var E = HAZE_ENV[MAP] || mapData.haze || HAZE_ENV.prohorovka, ar = mapData.arena, bx = mapData.box || ar, margin = Math.max(5, Math.min(bx[2] - ar[2], ar[0] - bx[0], bx[3] - ar[3], ar[1] - bx[1]));
    var num = function (x) { var s = String(+x); return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s; };
    var C = T.ShaderChunk;
    C.fog_pars_vertex += '\n#ifdef USE_FOG\nvarying vec3 vHazeW;\n#endif\n';
    C.fog_vertex = C.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z;\n\tvHazeW = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;');
    var v3 = function (c) { return 'vec3( ' + c.map(num).join(', ') + ' )'; };
    // the background colour by view direction: the haze and the rim fade toward exactly what lies behind them
    // round 14: g = the sky switch (fogFar carries it to the fog chunk). Off: black in every direction - before, the haze
    // and the rim fade took the sky's colours by direction whatever the switch said, so with the sky off whatever stood
    // beyond the border or far up a height still faded toward the pale sky (above) or the horizon grey (along it)
    SKY_FN = ['vec3 skyCol5d( vec3 d, float g ) { float e = d.y;',
      ' if ( g < 0.5 ) return ' + v3(SKY_COL.black) + ';',
      // above: the grey band (to ~2 deg) lightening into the sky by ~27 deg; below: the band darkening into the grey by ~6 deg down
      ' return e >= 0.0 ? mix( ' + v3(SKY_COL.band) + ', ' + v3(SKY_COL.zen) + ', pow( smoothstep( 0.03, 0.45, e ), 0.8 ) ) : mix( ' + v3(SKY_COL.band) + ', ' + v3(SKY_COL.below) + ', smoothstep( 0.0, 0.10, - e ) ); }'].join('\n');
    C.fog_pars_fragment += ['', '#ifdef USE_FOG', 'varying vec3 vHazeW;', SKY_FN,
      'float hazeFactor( float k ) {',
      ' vec3 w = vHazeW; float L = length( w ); vec3 P = cameraPosition + w;',
      ' float fd = ' + num(E.F) + ' * w.y; float ie = abs( fd ) > 1e-3 ? ( 1.0 - exp( - fd ) ) / fd : 1.0;',
      ' float od = ' + num(E.D) + ' * exp( min( 3.0, - ' + num(E.F) + ' * ( cameraPosition.y - ' + num(E.H) + ' ) ) ) * ie * max( L - ' + num(E.S) + ', 0.0 );',
      ' float f = 1.0 - exp( - k * od );',
      ' vec2 g = vec2( P.x, - P.z );',  // game axes (the root mirrors z)
      ' float dOut = max( max( ' + num(ar[0]) + ' - g.x, g.x - ' + num(ar[2]) + ' ), max( ' + num(ar[1]) + ' - g.y, g.y - ' + num(ar[3]) + ' ) );',
      ' return max( f, smoothstep( ' + num(margin * 0.25) + ', ' + num(margin) + ', dOut ) ); }',
      '#endif', ''].join('\n');
    C.fog_fragment = C.fog_fragment.replace('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
      'float fogFactor = fogNear >= 0.0 ? smoothstep( fogNear, fogFar, vFogDepth ) : hazeFactor( - fogNear );');
    C.fog_fragment = C.fog_fragment.replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
      'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogNear >= 0.0 ? fogColor : skyCol5d( normalize( vHazeW ), fogFar ), fogFactor );');
    if (C.fog_fragment.indexOf('hazeFactor') < 0 || C.fog_fragment.indexOf('skyCol5d') < 0 || C.fog_vertex.indexOf('vHazeW') < 0) console.warn('haze: three.js fog chunks not patched');
    // the sky: a sphere round the camera, drawn first, written in display (sRGB) values like three.js's fog colour, so
    // the band at the horizon is exactly the colour the outer rim fades into
    skyU.uHor.value.fromArray(SKY_COL.band); skyU.uZen.value.fromArray(SKY_COL.zen); skyU.uLow.value.fromArray(SKY_COL.below);
    var sm = new T.MeshBasicMaterial({ side: T.BackSide, depthTest: false, depthWrite: false, fog: false });
    sm.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, skyU);
      sh.vertexShader = 'varying vec3 vSkyD;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vSkyD = position;');
      sh.fragmentShader = 'varying vec3 vSkyD;\nuniform vec3 uHor, uZen, uLow, uSunD;\n' + SKY_FN + '\n' + sh.fragmentShader.replace('#include <colorspace_fragment>', [
        '#include <colorspace_fragment>',
        ' vec3 sd = normalize( vSkyD ); float e = sd.y; vec3 sc = skyCol5d( sd, 1.0 );',  // drawn only while the sky is on
        ' sc += vec3( 1.0, 0.95, 0.85 ) * 0.06 * pow( max( dot( sd, uSunD ), 0.0 ), 8.0 ) * step( 0.0, e );',
        ' gl_FragColor = vec4( sc, 1.0 );'].join('\n'));
    };
    sm.customProgramCacheKey = function () { return 'sky14'; };
    skyMesh = new T.Mesh(new T.SphereGeometry(3000, 32, 16), sm);
    skyMesh.frustumCulled = false; skyMesh.renderOrder = -1000; skyMesh.matrixAutoUpdate = true;
    skyMesh.onBeforeRender = function (r, s, c) { skyMesh.position.copy(c.position); skyMesh.updateMatrixWorld(); };
    scene.add(skyMesh);
  }
  // fog uniforms (three.js's own): fogNear < 0 selects the round-5d fog, -fogNear = the haze strength (0: the outer rim
  // fade alone); fogNear >= 0 = round 5's linear fog
  function applySky() {
    if (skyMesh) skyMesh.visible = skyOn;
    scene.background = skyOn ? null : new T.Color().setRGB(SKY_COL.black[0], SKY_COL.black[1], SKY_COL.black[2], T.SRGBColorSpace);  // round 12: no sky = black, the pale fill is gone
    if (skyOn || hazeOn) { var c = skyOn ? SKY_COL.band : SKY_COL.black; scene.fog.color.setRGB(c[0], c[1], c[2], T.SRGBColorSpace); scene.fog.near = hazeOn ? -(HAZE_ENV[MAP] || mapData.haze || HAZE_ENV.prohorovka).k : -1e-6; scene.fog.far = skyOn ? 1 : 0; }  // fogFar is free in this mode: it carries the sky switch to skyCol5d
    else { scene.fog.color.setRGB(SKY_COL.black[0], SKY_COL.black[1], SKY_COL.black[2], T.SRGBColorSpace); scene.fog.near = 700; scene.fog.far = 2600; }
  }
  function setHaze(on) { hazeOn = !!on; $('sw-haze').checked = hazeOn; applySky(); }
  function setSky(on) { skyOn = !!on; $('sw-sky').checked = skyOn; applySky(); }
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 2400;
  scene.add(sun); scene.add(sun.target);
  // round 5b: shadows fade out over the outer 4 % of the shadow box instead of ending at a hard line (three.js's
  // getShadow, patched before any material compiles)
  (function () {
    var c = T.ShaderChunk.shadowmap_pars_fragment, i = c.indexOf('float getShadow( sampler2D'), j = c.indexOf('return shadow;', i);
    if (i >= 0 && j > i) c = c.slice(0, j) +
      'vec2 eK = min(shadowCoord.xy, 1.0 - shadowCoord.xy); return mix(1.0, shadow, smoothstep(0.0, 0.04, min(eK.x, eK.y)));' + c.slice(j + 14);
    // soft (shadow radius > 2.5): 5 depth reads (centre and 4 diagonals) instead of PCF's 17 - the receivers' cost
    var p = c.indexOf('#if defined( SHADOWMAP_TYPE_PCF )', i), q = c.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )', p);
    if (i >= 0 && p > i && q > p) c = c.slice(0, p) + '#if defined( SHADOWMAP_TYPE_PCF )\n if ( shadowRadius > 2.5 ) {\n' +
      '  vec2 o5 = 0.5 * shadowRadius / shadowMapSize;\n' +
      '  shadow = ( 2.0 * texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +\n' +
      '   texture2DCompare( shadowMap, shadowCoord.xy + vec2( o5.x, o5.y ), shadowCoord.z ) + texture2DCompare( shadowMap, shadowCoord.xy + vec2( -o5.x, o5.y ), shadowCoord.z ) +\n' +
      '   texture2DCompare( shadowMap, shadowCoord.xy + vec2( o5.x, -o5.y ), shadowCoord.z ) + texture2DCompare( shadowMap, shadowCoord.xy - o5, shadowCoord.z ) ) / 6.0;\n' +
      ' } else {\n' + c.slice(p + '#if defined( SHADOWMAP_TYPE_PCF )'.length, q) + ' }\n' + c.slice(q);
    // round 5c: cascaded soft shadows. With exactly 3 shadow-casting directional lights (the sun and two copies of it
    // at intensity 0, each holding one cascade) the sun's light takes the shadow of the finest cascade whose map
    // covers the point (map-based selection, blended over 5 % of a cascade's edge), each read as a smooth 3-texel box
    // over bilinear compares (16 reads: no texel steps), faded out with view depth between the cascade light 0's and
    // light 1's shadowRadius (used here as the fade start / end in metres; the PCF radius is not used by this path).
    c += ['', '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS == 3',
      'float csmCmp( sampler2D m, vec2 uv, float z ) { return step( z, unpackRGBAToDepth( textureLod( m, uv, 0.0 ) ) ); }',
      'float csmPcf( sampler2D m, vec2 size, float bias, vec4 c ) {',
      ' vec3 q = c.xyz / c.w; q.z += bias; if ( q.z > 1.0 ) return 1.0;',
      ' vec2 tx = 1.0 / size; vec2 t = q.xy * size - 0.5; vec2 b = floor( t ); vec2 f = t - b; vec2 o = ( b - 0.5 ) * tx; float s = 0.0;',
      ' if ( directionalLightShadows[ 2 ].shadowRadius < 0.5 ) { vec2 o2 = ( b + 0.5 ) * tx;',  // sharp: a one-texel bilinear compare, 4 reads
      '  return mix( mix( csmCmp( m, o2, q.z ), csmCmp( m, o2 + vec2( tx.x, 0.0 ), q.z ), f.x ), mix( csmCmp( m, o2 + vec2( 0.0, tx.y ), q.z ), csmCmp( m, o2 + tx, q.z ), f.x ), f.y ); }',
      ' for ( int j = 0; j < 4; j ++ ) { float wy = j == 0 ? 1.0 - f.y : ( j == 3 ? f.y : 1.0 );',
      '  for ( int i = 0; i < 4; i ++ ) { float wx = i == 0 ? 1.0 - f.x : ( i == 3 ? f.x : 1.0 );',
      '   s += wx * wy * csmCmp( m, o + vec2( float( i ), float( j ) ) * tx, q.z ); } }',
      ' return s / 9.0; }',
      'float csmEdge( vec4 c ) { vec2 q = c.xy / c.w; vec2 e = min( q, 1.0 - q ); return min( e.x, e.y ); }',
      'float csmShadow( float depth ) {',
      ' float fade = 1.0 - smoothstep( directionalLightShadows[ 0 ].shadowRadius, directionalLightShadows[ 1 ].shadowRadius, depth );',
      ' if ( fade <= 0.0 ) return 1.0;',
      ' float w0 = smoothstep( 0.02, 0.07, csmEdge( vDirectionalShadowCoord[ 0 ] ) ), w1 = 0.0, w2 = 0.0, s0 = 1.0, s1 = 1.0, s2 = 1.0;',
      ' if ( w0 > 0.0 ) s0 = csmPcf( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowBias, vDirectionalShadowCoord[ 0 ] );',
      ' if ( w0 < 1.0 ) {',
      '  w1 = smoothstep( 0.02, 0.07, csmEdge( vDirectionalShadowCoord[ 1 ] ) );',
      '  if ( w1 > 0.0 ) s1 = csmPcf( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowBias, vDirectionalShadowCoord[ 1 ] );',
      '  if ( w1 < 1.0 ) { w2 = smoothstep( 0.0, 0.03, csmEdge( vDirectionalShadowCoord[ 2 ] ) );',
      '   if ( w2 > 0.0 ) s2 = csmPcf( directionalShadowMap[ 2 ], directionalLightShadows[ 2 ].shadowMapSize, directionalLightShadows[ 2 ].shadowBias, vDirectionalShadowCoord[ 2 ] ); }',
      ' }',
      ' return mix( 1.0, mix( mix( mix( 1.0, s2, w2 ), s1, w1 ), s0, w0 ), fade ); }',
      '#endif', ''].join('\n');
    T.ShaderChunk.shadowmap_pars_fragment = c;
    var L = T.ShaderChunk.lights_fragment_begin, a0 = L.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'),
      a1 = L.indexOf('#endif', L.indexOf('#pragma unroll_loop_end', a0)) + 6;
    if (a0 >= 0 && a1 > a0) T.ShaderChunk.lights_fragment_begin = L.slice(0, a0) +
      '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS == 3\n' +
      ' DirectionalLight directionalLight = directionalLights[ 0 ];\n getDirectionalLightInfo( directionalLight, directLight );\n' +
      ' if ( directLight.visible && receiveShadow ) directLight.color *= csmShadow( - geometryPosition.z );\n' +
      ' RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n' +
      '#else\n' + L.slice(a0, a1) + '\n#endif' + L.slice(a1);
    else console.warn('cascaded shadows: three.js light chunk not recognised');
  })();
  // the cascades' lights: copies of the sun at intensity 0 (only their shadow maps are used), same target
  var csmSuns = [sun];
  for (var ci0 = 1; ci0 < 3; ci0++) {
    var sl = new T.DirectionalLight(0xffffff, 0); sl.target = sun.target; sl.castShadow = false;
    sl.shadow.mapSize.set(1024, 1024); scene.add(sl); csmSuns.push(sl);
  }
  // Shadow quality (round 5b). soft: 2048 map, wide PCF, plants cast from a shadow-only copy of their low hull (solid,
  // the plant's rough outline, at any distance); sharp: 4096 map, plants cast from their 3D LOD near and cards far (round 5's look).
  // Both: the box fitted to the ground the camera sees (capped at SHADOW_CAP m), the map re-rendered only when the box,
  // the sun, the battle time or a caster changed. old: round 5 exactly (box on the target, every frame) - bench only.
  // round 5c: soft = 3 cascades (1024 each), soft5b = round 5b's one 2048 map (its box fit kept as it was, for comparison),
  // sharp = one 4096 map fitted like the cascades (round 5b's box fit replaced: it missed ground lower than the camera target)
  var SH_Q = { soft: { size: 1024, radius: 3, proxy: true, csm: true }, soft5b: { size: 2048, radius: 3, proxy: true, r5b: true },
    // round 6: sharp = the same 3 cascades at twice the detail (2048 near and middle, near box from 110 m: about 5 cm a
    // texel close up), plants cast their 3D shape; sharp1 = the one 4096 map over all the ground in view (kept for comparison:
    // its texel grows with the ground in view, so a tilted camera coarsens it and small shadows drop out)
    sharp: { size: 2048, mid: 2048, radius: 1, proxy: false, csm: true, minK: 0.5, crisp: true, detail: true, nearD: 45 },
    sharp1: { size: 4096, radius: 1, proxy: false },
    old: { size: 4096, radius: 1, proxy: false, every: true, oldBox: true } };
  // sharp's near map size, picked on the page (shDetail): 4096 = the old one-map sharp's detail close up. Its maps larger
  // than 1024 keep no static copy (memory): they are drawn whole, vehicles included, when the time moved with a vehicle in the box
  var shDetail = 2048;
  function csmCached(c) { return c < 2 && (!SH_Q[SHQ].detail || csmSuns[c].shadow.mapSize.x <= 1024); }
  var SHQ = 'sharp', SHADOW_CAP = 1100, shKey = '', shT = null;
  var shCam = new T.OrthographicCamera(), shO = new T.Vector3(), shC = new T.Vector3(), shD = new T.Vector3(), shP = new T.Vector3(), shPts = [];
  // cascades: view depth reaches CSM.far m beyond the nearest visible ground (faded over its last CSM.fadeK), split
  // between log and uniform by lambda; minimum box sides keep the near blur at about 0.4 m or more
  var CSM = { n: 3, far: 1200, fadeK: 0.18, minSide: [220, 500, 1000], keys: ['', '', ''], dirty: [true, true, true],
    sunKeys: ['', '', ''], hadVeh: [false, false, false], frame: 0, redraws: [0, 0, 0], overlays: [0, 0, 0], info: [], d: [] };
  function shadowDirty() { shKey = ''; CSM.dirty = [true, true, true]; }
  function setShadowQuality(q) {
    SHQ = SH_Q[q] ? q : 'soft'; var o = SH_Q[SHQ];
    csmSuns.forEach(function (l, k) {
      var sz = k === 0 ? (o.detail ? shDetail : o.size) : (k === 2 ? 2048 : (o.detail ? (shDetail >= 4096 ? 2048 : 1024) : (o.mid || 1024)));
      if (l.shadow.mapSize.x !== sz) { l.shadow.mapSize.set(sz, sz); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
      l.shadow.autoUpdate = !o.csm; l.shadow.needsUpdate = !o.csm;  // cascades: drawn by placeSunFit, never by three.js's own pass
    });
    for (var cc = 0; cc < csmCache.length; cc++) if (csmCache[cc]) { csmCache[cc].dispose(); csmCache[cc] = null; }
    shadowDirty();
    csmSuns[2].shadow.radius = o.crisp ? 0 : 1;  // read by csmPcf: 0 = the one-texel filter
    sun.shadow.radius = o.radius; renderer.shadowMap.autoUpdate = !!(o.every || o.csm);
    applyShadowLights();
    shadowHalf = 0; applyShadowCasters();
    if ($('sel-shadowq') && SHQ !== 'old') $('sel-shadowq').value = SHQ;
  }
  function applyShadowLights() {
    var o = SH_Q[SHQ];
    csmSuns.forEach(function (l, k) { l.castShadow = shadowsOn && (k === 0 || !!o.csm); });
  }
  // every shadow map redrawn at the next frame (benches; casters changed)
  function shadowsRedrawAll() { renderer.shadowMap.needsUpdate = true; if (!SH_Q[SHQ].csm) csmSuns.forEach(function (l) { l.shadow.needsUpdate = true; }); CSM.dirty = [true, true, true]; }
  var layers = { terrain: new T.Group(), visual: new T.Group(), objects: new T.Group(), helpers: new T.Group(), trees: new T.Group(),
    bushes: new T.Group(), water: new T.Group(), mode: new T.Group(), vehicles: new T.Group(), tracers: new T.Group() };
  Object.keys(layers).forEach(function (k) { root.add(layers[k]); });
  layers.helpers.visible = false;
  layers.objects.visible = false;  // collision: on the 'objects' switch; the game model is drawn by default
  var shadowsOn = true, delayOn = true;

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    $('m-size').textContent = w + 'x' + h + ' @' + renderer.getPixelRatio();
  }
  window.addEventListener('resize', resize);

  var shadowHalf = 0;
  function placeSun() {
    var o = SH_Q[SHQ];
    if (o.oldBox) return placeSunOld();
    if (o.r5b) return placeSunR5b();
    return placeSunFit(!!o.csm);
  }
  // ---- round 5c box fit. The ground in view = the camera's view slice cut to the band of heights the terrain has
  // under it (50 m tiles: lowest - 2 m .. highest + 35 m, so crowns and roofs receive too): the 12 edges of the slice
  // clipped to that band, their end points bounded in the light's view. No plane at the camera target's height (round
  // 5b's fit): ground lower than the target - an embankment, a slope, a panned camera whose target height stayed - lies
  // farther along the view rays than that plane and fell outside the box.
  var fA = [], fB = [], fP = [], fT1 = new T.Vector3(), fT2 = new T.Vector3();
  for (var fi = 0; fi < 4; fi++) { fA.push(new T.Vector3()); fB.push(new T.Vector3()); }
  var tiles50 = null;  // {x0, z0, n, m, lo[], hi[]} in game coordinates (buildTerrain)
  function slabOf(x0, x1, z0, z1) {  // scene x / scene z ranges -> [lo, hi] or null (no terrain there)
    var T5 = tiles50; if (!T5) return null;
    var gz0 = -z1, gz1 = -z0;  // the scene mirrors z
    var i0 = Math.max(0, Math.floor((x0 - T5.x0) / 50)), i1 = Math.min(T5.n - 1, Math.floor((x1 - T5.x0) / 50));
    var j0 = Math.max(0, Math.floor((gz0 - T5.z0) / 50)), j1 = Math.min(T5.m - 1, Math.floor((gz1 - T5.z0) / 50));
    if (i0 > i1 || j0 > j1) return null;
    var lo = 1e9, hi = -1e9;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) { var k = j * T5.n + i; lo = Math.min(lo, T5.lo[k]); hi = Math.max(hi, T5.hi[k]); }
    return [lo - 2, hi + 35];
  }
  function sliceCorners(d0, d1) {
    var ty = Math.tan(camera.fov * Math.PI / 360), tx = ty * camera.aspect;
    for (var k = 0; k < 4; k++) {
      var sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1;
      fA[k].set(sx * d0 * tx, sy * d0 * ty, -d0).applyMatrix4(camera.matrixWorld);
      fB[k].set(sx * d1 * tx, sy * d1 * ty, -d1).applyMatrix4(camera.matrixWorld);
    }
  }
  // the clipped end points of the slice [d0, d1] (scene coordinates) into fP; returns their count (0: no ground)
  function slicePoints(d0, d1, slab) {
    sliceCorners(d0, d1);
    if (!slab) {
      var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (var k = 0; k < 4; k++) [fA[k], fB[k]].forEach(function (p) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); });
      slab = slabOf(x0, x1, z0, z1); if (!slab) return 0;
    }
    var n = 0, lo = slab[0], hi = slab[1];
    function clip(p, q) {
      var dy = q.y - p.y, t0 = 0, t1 = 1;
      if (Math.abs(dy) < 1e-9) { if (p.y < lo || p.y > hi) return; }
      else { var a = (lo - p.y) / dy, b = (hi - p.y) / dy; t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(1, Math.max(a, b)); if (t0 > t1) return; }
      (fP[n] || (fP[n] = new T.Vector3())).copy(p).lerp(q, t0); n++;
      (fP[n] || (fP[n] = new T.Vector3())).copy(p).lerp(q, t1); n++;
    }
    var E = [[0, 1], [1, 3], [3, 2], [2, 0]];
    for (var k = 0; k < 4; k++) { clip(fA[k], fB[k]); clip(fA[E[k][0]], fA[E[k][1]]); clip(fB[E[k][0]], fB[E[k][1]]); }
    return n;
  }
  var csmVehPt = new T.Vector3();
  // round 5c: per cascade a cached copy of the static casters' map (colour = packed depth, and its depth buffer);
  // the vehicles are drawn over a copy of it (depth-tested), so playing redraws only the vehicles
  var csmCache = [], csmVehCam = new T.OrthographicCamera(), csmVehMat = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, side: T.BackSide }), VEH_LAYER = 5;
  function csmBlit(src, dst) {
    var ps = renderer.properties.get(src), pd = renderer.properties.get(dst), w = src.width;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, ps.__webglFramebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, pd.__webglFramebuffer);
    gl.blitFramebuffer(0, 0, w, w, 0, 0, w, w, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    renderer.resetState();
  }
  var csmPending = null, csmHelper = new T.Scene(), csmDummyRT = new T.WebGLRenderTarget(1, 1);
  (function () {
    var hm = new T.Mesh(new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)), new T.MeshBasicMaterial());
    hm.frustumCulled = false;
    hm.onBeforeRender = function () { if (csmPending) { var l = csmPending; csmPending = null; renderer.shadowMap.render(l, scene, camera); } };
    csmHelper.add(hm);
  })();
  function csmStatic(c, whole) {  // whole: the vehicles too, no static copy
    var L = csmSuns[c], vis = layers.vehicles.visible, rt0 = renderer.getRenderTarget();
    scene.updateMatrixWorld();
    if (!whole) layers.vehicles.visible = false; L.shadow.needsUpdate = true;
    // three.js's own shadow pass for this light only (it creates the map). Called from inside a render of a helper
    // scene: the pass needs the renderer's per-render state, which exists only during render()
    csmPending = [L]; renderer.setRenderTarget(csmDummyRT); renderer.render(csmHelper, camera);
    layers.vehicles.visible = vis;
    var m = L.shadow.map;
    if (c === 2 || whole) { renderer.setRenderTarget(rt0); return; }
    if (!csmCache[c] || csmCache[c].width !== m.width) {
      if (csmCache[c]) csmCache[c].dispose();
      csmCache[c] = new T.WebGLRenderTarget(m.width, m.height, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
      renderer.setRenderTarget(csmCache[c]); renderer.setRenderTarget(rt0);  // allocates it
    }
    csmBlit(m, csmCache[c]); renderer.setRenderTarget(rt0);
  }
  function csmVehicles(c) {
    var L = csmSuns[c], m = L.shadow.map; if (!m || !csmCache[c]) return;
    csmBlit(csmCache[c], m);
    if (!layers.vehicles.visible || !shadowsOn) return;
    var n = 0;
    layers.vehicles.traverse(function (o) { if (o.isMesh && o.castShadow && o.visible) { o.layers.enable(VEH_LAYER); n++; } else o.layers.disable(VEH_LAYER); });
    if (!n) return;
    var rt0 = renderer.getRenderTarget(), ac = renderer.autoClear, bg = scene.background, ov = scene.overrideMaterial, sa = renderer.shadowMap.autoUpdate;
    csmVehCam.copy(L.shadow.camera); csmVehCam.layers.set(VEH_LAYER);
    var sn = renderer.shadowMap.needsUpdate;
    renderer.autoClear = false; scene.background = null; scene.overrideMaterial = csmVehMat; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(m); renderer.render(scene, csmVehCam);
    renderer.autoClear = ac; scene.background = bg; scene.overrideMaterial = ov; renderer.shadowMap.autoUpdate = sa; renderer.shadowMap.needsUpdate = sn; renderer.setRenderTarget(rt0);
  }
  function placeSunFit(csm) {
    var a = mapData.arena;
    shO.set((a[0] + a[2]) / 2, 0, -(a[1] + a[3]) / 2);
    sun.target.position.copy(shO); sun.position.copy(shO).addScaledVector(SUN_DIR, 1500);
    for (var k = 1; k < 3; k++) csmSuns[k].position.copy(sun.position);
    shCam.position.copy(sun.position); shCam.lookAt(shO); shCam.updateMatrixWorld();
    camera.updateMatrixWorld();
    // the view depth that holds ground: [dmin, dmax], shadows to dmin + CSM.far (csm) or SHADOW_CAP along the view
    var n = slicePoints(camera.near, 4000, tiles50 ? [tiles50.gLo - 2, tiles50.gHi + 35] : [-1e4, 1e4]), dmin = 1e9, dmax = 0;
    var fw = fT1.set(0, 0, -1).transformDirection(camera.matrixWorld);
    for (k = 0; k < n; k++) { var dd = fT2.copy(fP[k]).sub(camera.position).dot(fw); dmin = Math.min(dmin, dd); dmax = Math.max(dmax, dd); }
    if (!n) { dmin = camera.near; dmax = 100; }
    dmin = Math.max(camera.near, dmin);
    var reach = csm ? CSM.far : SHADOW_CAP * 1.3, dEnd = Math.min(dmax, dmin + reach), capped = dmax > dEnd + 1;
    var fadeA = capped ? dEnd * (1 - CSM.fadeK) : 1e6, fadeB = capped ? dEnd : 1e6 + 1;
    var nc = csm ? CSM.n : 1, ds = [dmin];
    // splits: the near cascade ends at a depth set by the nearest ground alone (dmin + 90 m, at least 1.6 dmin), so its
    // texel size and blur near the camera do not change when the horizon enters the view; the middle one at 20 % of the rest
    if (nc === 3) { var d1 = Math.min(dEnd, Math.max(dmin * 1.6, dmin + (SH_Q[SHQ].nearD || 90))); ds.push(d1, d1 + (dEnd - d1) * 0.2); }
    ds.push(dEnd); CSM.d = ds;
    var timeMoved = t !== shT; shT = t;
    var all = renderer.shadowMap.needsUpdate; CSM.frame++;
    for (var c = 0; c < nc; c++) {
      var L = csmSuns[c], cam2 = L.shadow.camera, size = L.shadow.mapSize.x;
      var m = slicePoints(ds[c], ds[c + 1] * (c < nc - 1 ? 1.08 : 1), null);
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (k = 0; k < m; k++) { var p = fT2.copy(fP[k]).applyMatrix4(shCam.matrixWorldInverse); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      // round 6, sharp: the boxes are squares around the point the camera turns about, their sides set by the camera's
      // distance to it alone (2, 8, 32 x; the far one at least 2400 m) - a shadow's detail follows the zoom, never the tilt.
      // (A box fitted to a slice of the view grows when the tilt brings more ground into that slice: the same shadow coarsened.)
      var radial = csm && !!SH_Q[SHQ].detail;
      if (!radial && (!m || ds[c + 1] - ds[c] < 0.5)) {
        // no ground in this slice: its box goes far off the map, so no point selects its (stale) map
        if (CSM.keys[c] !== 'empty') { CSM.keys[c] = 'empty'; cam2.left = 1e5; cam2.right = 1e5 + 10; cam2.bottom = 1e5; cam2.top = 1e5 + 10; cam2.updateProjectionMatrix(); if (csm) L.shadow.needsUpdate = true; }
        CSM.info[c] = { d0: +ds[c].toFixed(1), d1: +ds[c + 1].toFixed(1), empty: true }; continue;
      }
      var minS = csm ? CSM.minSide[c] * (SH_Q[SHQ].minK || 1) : 60, need = Math.max((x1 - x0) * 1.2, (y1 - y0) * 1.2), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (radial) { var tp = fT2.set(cam.tx, cam.ty, -cam.tz).applyMatrix4(shCam.matrixWorldInverse); mx = tp.x; my = tp.y; need = Math.min([2, 8, 32][c] * cam.dist, 2100); minS = [60, 240, 2400][c]; }  // no box larger than the map needs
      var sunKey = SUN_DIR.x + ',' + SUN_DIR.y + ',' + SUN_DIR.z + ',' + size, S = cam2.right - cam2.left, tex = S / size;
      // stable boxes (hysteresis): the box stays while the ground it must cover (+20 %) fits inside it and it is not more
      // than twice too large; a new one has 25 % slack, its side in 2^(1/4) steps, its centre on whole texels
      var fits = CSM.keys[c] && CSM.keys[c] !== 'empty' && CSM.sunKeys[c] === sunKey && mx - need / 2 >= cam2.left && mx + need / 2 <= cam2.right &&
        my - need / 2 >= cam2.bottom && my + need / 2 <= cam2.top && S <= 2.2 * Math.max(minS, need * 1.15);
      var redraw = false;
      if (!fits) {
        var ext = Math.max(minS, need * 1.15); S = 60 * Math.pow(2, Math.ceil(Math.log2(ext / 60) * 4) / 4); tex = S / size;
        var cx = Math.round(mx / tex) * tex, cy = Math.round(my / tex) * tex;
        CSM.keys[c] = S.toFixed(2) + ',' + cx.toFixed(2) + ',' + cy.toFixed(2); CSM.sunKeys[c] = sunKey; redraw = true;
        cam2.left = cx - S / 2; cam2.right = cx + S / 2; cam2.bottom = cy - S / 2; cam2.top = cy + S / 2; cam2.near = 1; cam2.far = 3000; cam2.updateProjectionMatrix();
        L.shadow.bias = csm ? -0.00006 : -0.0003; L.shadow.normalBias = csm ? Math.max(0.06, 0.45 * tex) : Math.max(0.4, 1.2 * tex);  // soft: ~0.1 m toward the sun (was 0.3 m: a vehicle's shadow began under the hull, a track's width in)
        // round 5e: soft's receiver offsets were 0.0003 depth (0.9 m toward the sun) + 0.4-0.47 m along the normal - more than
        // the gap between the ground and a low caster's far faces as the near cascade sees them (its map holds the vehicles:
        // measured): vehicles, bushes, fences cast nothing near the camera. Offsets 0 brought them back (seen); now 0.3 m + 0.6 texel
      }
      if (all || CSM.dirty[c]) redraw = true;
      if (!csm) { if (timeMoved || redraw) { renderer.shadowMap.needsUpdate = true; CSM.dirty[c] = false; if (redraw) CSM.redraws[c]++; } }
      else {
        // the static casters are drawn into a cached copy only when the box or a static caster changed; the vehicles
        // are drawn over a copy of it whenever the battle time moved and a vehicle is (or was) in the box
        var veh = false;
        if (timeMoved || redraw) for (var v = 0; v < vehicles.length; v++) {
          var r = vehicles[v]; if (!r.visible || !r.group.visible) continue;
          var q = r.group.getWorldPosition(csmVehPt).applyMatrix4(shCam.matrixWorldInverse);  // world: the root mirrors z (round 5e)
          if (q.x > cam2.left - 12 && q.x < cam2.right + 12 && q.y > cam2.bottom - 12 && q.y < cam2.top + 12) { veh = true; break; }
        }
        var cached = csmCached(c), whole = c < 2 && !cached && (redraw || (timeMoved && (veh || CSM.hadVeh[c])));
        if (whole) { csmStatic(c, true); CSM.dirty[c] = false; CSM.redraws[c]++; }
        else if (redraw) { csmStatic(c); CSM.dirty[c] = false; CSM.redraws[c]++; }
        // the far cascade (selected only beyond the middle one's box) holds the static casters alone: no cache, no vehicles
        if (cached && (redraw || (timeMoved && (veh || CSM.hadVeh[c])))) { csmVehicles(c); CSM.overlays[c]++; }
        if (timeMoved || redraw) CSM.hadVeh[c] = veh;
        L.shadow.needsUpdate = false;
      }
      CSM.info[c] = { d0: +ds[c].toFixed(1), d1: +ds[c + 1].toFixed(1), side: +S.toFixed(1), texel: +tex.toFixed(3) };
    }
    if (csm) { sun.shadow.radius = fadeA; csmSuns[1].shadow.radius = fadeB; }
    CSM.fade = [fadeA, fadeB]; CSM.depth = [dmin, dmax];
  }
  function placeSunR5b() {
    // round 5b exactly: the light looks from a fixed point (the arena centre + 1500 m toward the sun): its view only turns with the sun
    var a = mapData.arena, c = sun.shadow.camera;
    shO.set((a[0] + a[2]) / 2, 0, -(a[1] + a[3]) / 2);
    sun.target.position.copy(shO); sun.position.copy(shO).addScaledVector(SUN_DIR, 1500);
    shCam.position.copy(sun.position); shCam.lookAt(shO); shCam.updateMatrixWorld();
    // the ground the camera sees: the 4 corner rays on the plane at the target's height, each at most SHADOW_CAP m away
    // along the ground (rays above the horizon: SHADOW_CAP along their direction), and the point under the camera
    camera.updateMatrixWorld(); shC.copy(camera.position);
    var yG = cam.ty, n = 0;
    function addPt(x, z) { for (var h = 0; h < 2; h++) { (shPts[n] || (shPts[n] = new T.Vector3())).set(x, yG + (h ? 45 : -30), z).applyMatrix4(shCam.matrixWorldInverse); n++; } }
    addPt(shC.x, shC.z);
    for (var k = 0; k < 4; k++) {
      shD.set(k & 1 ? 1 : -1, k & 2 ? 1 : -1, 1).unproject(camera).sub(shC).normalize();
      var hx = shD.x, hz = shD.z, hl = Math.hypot(hx, hz) || 1e-6, s = shD.y < -1e-4 ? (yG - shC.y) / shD.y : Infinity;
      if (s * hl > SHADOW_CAP || s < 0) s = SHADOW_CAP / hl;
      addPt(shC.x + hx * s, shC.z + hz * s);
    }
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (k = 0; k < n; k++) { var p = shPts[k]; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    // a square box, its side in steps of 2^(1/4) and its centre on whole texels (no shimmer while the camera moves),
    // 10 % larger than the footprint so the edge fade falls outside the view except at the cap
    var ext = Math.max(60, x1 - x0, y1 - y0) * 1.1, S = 60 * Math.pow(2, Math.ceil(Math.log2(ext / 60) * 4) / 4);
    var tex = S / sun.shadow.mapSize.x, cx = Math.round((x0 + x1) / 2 / tex) * tex, cy = Math.round((y0 + y1) / 2 / tex) * tex;
    var key = S.toFixed(2) + ',' + cx.toFixed(2) + ',' + cy.toFixed(2) + ',' + SUN_DIR.x + ',' + SUN_DIR.y + ',' + SUN_DIR.z + ',' + sun.shadow.mapSize.x;
    if (key !== shKey) {
      shKey = key;
      c.left = cx - S / 2; c.right = cx + S / 2; c.bottom = cy - S / 2; c.top = cy + S / 2; c.near = 1; c.far = 3000; c.updateProjectionMatrix();
      sun.shadow.bias = -0.0003; sun.shadow.normalBias = Math.max(0.4, 1.2 * tex);
      renderer.shadowMap.needsUpdate = true;
    }
    if (t !== shT) { shT = t; renderer.shadowMap.needsUpdate = true; }  // vehicles, tracers, falling trees
  }
  function placeSunOld() {
    // round 5: the shadow box follows the camera target; its size follows the view distance (sharper close up)
    var tx = cam.tx, ty = cam.ty, tz = -cam.tz;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 2400; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
    var half = Math.max(40, Math.min(720, cam.dist * 1.1));
    if (Math.abs(half - shadowHalf) > shadowHalf * 0.05) {
      shadowHalf = half; var c = sun.shadow.camera;
      c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.updateProjectionMatrix();
    }
    // snap the box centre to shadow texels: no shimmer while the camera moves
    var step = 2 * shadowHalf / sun.shadow.mapSize.x;
    tx = Math.round(tx / step) * step; tz = Math.round(tz / step) * step;
    sun.target.position.set(tx, ty, tz);
    sun.position.set(tx + SUN_DIR.x * 1000, ty + SUN_DIR.y * 1000, tz + SUN_DIR.z * 1000);
  }

  // ------------------------------------------------------------------ BC1 (DXT1) textures: the client's own compressed blocks
  // levels [{w, h, bc1 base64}]. Uploaded as they are where WEBGL_compressed_texture_s3tc exists (ANGLE D3D11: the
  // game's CEF and desktop Chrome); otherwise decoded here to RGBA. Stored as sRGB values in a linear texture: the
  // shaders that sample them decode (pow 2.2), see SRGB_DECODE.
  var s3tc = renderer.extensions.has('WEBGL_compressed_texture_s3tc');
  function bc1Decode(src, w, h) {
    var out = new Uint8Array(w * h * 4), bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2), p = 0, pal = new Uint8Array(16);
    for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++, p += 8) {
      var c0 = src[p] | src[p + 1] << 8, c1 = src[p + 2] | src[p + 3] << 8;
      [c0, c1].forEach(function (c, k) { pal[k * 4] = (c >> 11) * 255 / 31; pal[k * 4 + 1] = (c >> 5 & 63) * 255 / 63; pal[k * 4 + 2] = (c & 31) * 255 / 31; pal[k * 4 + 3] = 255; });
      for (var j = 0; j < 3; j++) {
        pal[8 + j] = c0 > c1 ? (2 * pal[j] + pal[4 + j]) / 3 : (pal[j] + pal[4 + j]) / 2;
        pal[12 + j] = c0 > c1 ? (pal[j] + 2 * pal[4 + j]) / 3 : 0;
      }
      pal[11] = 255; pal[15] = c0 > c1 ? 255 : 0;
      var bits = (src[p + 4] | src[p + 5] << 8 | src[p + 6] << 16 | src[p + 7] << 24) >>> 0;
      for (var t = 0; t < 16; t++) {
        var x = bx * 4 + (t & 3), y = by * 4 + (t >> 2), ix = (bits >>> (2 * t)) & 3;
        if (x >= w || y >= h) continue;
        var o = (y * w + x) * 4; out[o] = pal[ix * 4]; out[o + 1] = pal[ix * 4 + 1]; out[o + 2] = pal[ix * 4 + 2]; out[o + 3] = pal[ix * 4 + 3];
      }
    }
    return out;
  }
  function bc1Texture(levels, repeat) {
    if (!repeat && levels.__tex) return levels.__tex;  // round 8: the JS path's first ground and its colour map are one texture
    var mips = levels.map(function (l) { return { data: u8(l.bc1), width: l.w, height: l.h }; }), tex;
    if (s3tc) tex = new T.CompressedTexture(mips, levels[0].w, levels[0].h, T.RGB_S3TC_DXT1_Format);
    else {
      tex = new T.DataTexture(bc1Decode(mips[0].data, mips[0].width, mips[0].height), levels[0].w, levels[0].h, T.RGBAFormat);
      tex.mipmaps = mips.map(function (m) { return { data: bc1Decode(m.data, m.width, m.height), width: m.width, height: m.height }; });
    }
    tex.minFilter = T.LinearMipmapLinearFilter; tex.magFilter = T.LinearFilter; tex.generateMipmaps = false;
    tex.colorSpace = T.NoColorSpace; tex.flipY = false;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (repeat) tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.needsUpdate = true;
    if (!repeat) Object.defineProperty(levels, '__tex', { value: tex, configurable: true });
    return tex;
  }

  // ------------------------------------------------------------------ helpers
  var info = { terrainTris: 0, objectTris: 0, objectInstances: 0, treeTris: 0, treeInstances: 0 };
  function noiseTexture() {
    // tileable value noise, 3 octaves: the ground's "simple texture" (not the game's)
    var N = 256, c = document.createElement('canvas'); c.width = c.height = N;
    var ctx = c.getContext('2d'), img = ctx.createImageData(N, N), seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var acc = new Float32Array(N * N);
    [[8, 0.5], [32, 0.3], [128, 0.2]].forEach(function (o) {
      var g = o[0], w = o[1], grid = new Float32Array(g * g);
      for (var i = 0; i < g * g; i++) grid[i] = rnd();
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var fx = x / N * g, fy = y / N * g, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
        u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
        var a = grid[(y0 % g) * g + x0 % g], b = grid[(y0 % g) * g + (x0 + 1) % g], cc = grid[((y0 + 1) % g) * g + x0 % g], d = grid[((y0 + 1) % g) * g + (x0 + 1) % g];
        acc[y * N + x] += w * ((a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v);
      }
    });
    for (var k = 0; k < N * N; k++) { var q = Math.round(acc[k] * 255); img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = q; img.data[k * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    var t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.NoColorSpace;
    return t;
  }

  // ------------------------------------------------------------------ relief light (round 5): how strongly the relief
  // shows, shared by every ground mode. uRelief: exponent on the per-vertex hollow/ridge shade (1 = rounds 3-4);
  // uReliefK: exponent on the sun's slope term n.L / n.L of flat ground (0 = only the lighting itself).
  var RELIEF = { off: [0, 0], game: [1, 0], strong: [2.6, 1.6] };
  var reliefU = { uRelief: { value: 1 }, uReliefK: { value: 0 }, uSunObj: { value: new T.Vector3(0, 1, 0) } };
  // round 5c: the baked light map (light5c.py: relief shade at 3 radii from the client's 1.5625 m heights, soft contact
  // shade around plants and objects; texture value = light / 2) times the live sun-facing slope term, both to the power
  // uLightK (the strength slider); uLightK 0 = off. While it is on the relief switch's own terms are off (no double shade).
  var lightU = { uLight: { value: null }, uLightBox: { value: new T.Vector4(0, 0, 1, 1) }, uLightK: { value: 0 }, uLightSlope: { value: 4 } };
  // the slope term: log(n.L / n.L flat) x uLightSlope, compressed to +-0.4 (tanh): gentle slopes of a few degrees show
  // about 4x stronger than the sun alone shows them, steep ones never go darker than x0.67 at strength 1
  // round 5d: the vehicles' halo on the ground. Per vehicle in view (up to HALO_N): uHvP = (x, z, cos yaw, sin yaw) of its
  // hull box centre (game coordinates), uHvS = (half width, half length, alive, cut-off radius^2), uHvC = its drawn colour
  // (linear). The distance to the hull's rounded box (an oval along the hull) gives (a) a soft darkening within ~1.4 m
  // (the sky it hides) and (b) a tint of its colour within ~3.5 m, strong on the side facing the sun, faint on the far
  // side (sunlight bounced off the hull); dead vehicles darken only. uHalo = (count, strength, sun x, sun z).
  var skirtMat = new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false }); skirtMat.shadowSide = T.DoubleSide;
  var HALO_N = 32, haloU = { uHalo: { value: new T.Vector4(0, 0, 1, 0) }, uHvP: { value: [] }, uHvS: { value: [] }, uHvC: { value: [] }, uHvK: { value: [] }, uHaloT: { value: new T.Vector3(1, 0, 0.6) } };
  for (var hk = 0; hk < HALO_N; hk++) { haloU.uHvP.value.push(new T.Vector4()); haloU.uHvS.value.push(new T.Vector4()); haloU.uHvC.value.push(new T.Vector3()); haloU.uHvK.value.push(new T.Vector2()); }
  var HALO_FRAG = [
    // sun side: round 5d's bounce exactly (the hull's colour added as light, the user's preferred look);
    // shaded side: a dark tone of the hull's colour - the ground's hue moved toward it at the ground's own brightness
    ' if (uHalo.y > 0.0) { float hOcc = 1.0; vec3 hB = vec3(0.0), hT = vec3(0.0); float hW = 0.0, hL = 0.0; int hN = int(uHalo.x + 0.5);',
    '  for (int i = 0; i < ' + HALO_N + '; i++) { if (i >= hN) break;',
    '   vec4 A = uHvP[i], S = uHvS[i]; vec2 d = vLPos - A.xy; if (dot(d, d) > S.w) continue;',
    '   vec2 q = vec2(d.x * A.z - d.y * A.w, d.x * A.w + d.y * A.z);',
    '   float rr = 0.8 * min(S.x, S.y); vec2 e = abs(q) - (S.xy - rr), eo = max(e, 0.0);',
    '   float sd = length(eo) + min(max(e.x, e.y), 0.0) - rr;',
    '   vec2 nl = length(eo) > 1e-4 ? normalize(sign(q) * eo) : normalize(q + 1e-4);',
    '   vec2 n = vec2(nl.x * A.z + nl.y * A.w, -nl.x * A.w + nl.y * A.z);',
    '   vec2 e2 = abs(q) - (uHvK[i] - 0.12); float sdR = length(max(e2, 0.0)) + min(max(e2.x, e2.y), 0.0) - 0.12; float rch = max(uHaloT.z, 0.05) * mix(0.3, 1.0, smoothstep(0.35, -0.45, dot(n, uHalo.zw))); float a = 1.0 - clamp((sdR + 0.25) / (rch + 0.25), 0.0, 1.0); hOcc *= 1.0 - 0.45 * a * a;',
    '   float sf = dot(n, uHalo.zw); float b = 1.0 - clamp(sd / 3.5, 0.0, 1.0); float bw = b * b * S.z;',
    '   float ob = smoothstep(-0.25, 0.05, sdR); hB += uHvC[i] * (bw * ob * (0.1 + 0.9 * max(sf, 0.0)));',
    '   float ws = bw * 0.5 * smoothstep(0.7, -0.3, sf); hT += uHvC[i] * ws; hW += ws;',
    // brightness gradient across the halo: a little lighter toward the sun, darker on the far side (uHaloT.y)
    '   float gs = clamp(dot(d, uHalo.zw) / (max(S.x, S.y) + 3.5), -1.0, 1.0); hL += bw * 0.2 * gs * (gs > 0.0 ? ob : 1.0);',
    '  }',
    '  vec3 hc = diffuseColor.rgb; const vec3 LW = vec3(0.2126, 0.7152, 0.0722);',
    '  if (hW > 1e-4) { vec3 tn = hT / hW; vec3 tc = min(tn * (dot(hc, LW) / max(dot(tn, LW), 1e-3)), vec3(1.0));',
    '   hc = mix(hc, tc, clamp(0.45 * uHalo.y * min(hW, 1.0), 0.0, 0.8)); }',
    '  hc *= 1.0 + uHaloT.y * clamp(hL, -0.25, 0.22);',
    '  diffuseColor.rgb = hc * pow(hOcc, uHaloT.x) * (1.0 + 1.3 * uHalo.y * hB); }'].join('\n');
  var RELIEF_DECL = 'uniform float uRelief;\nuniform float uReliefK;\nuniform vec3 uSunObj;\nvarying vec3 vONrm;\n' +
    'uniform sampler2D uLight;\nuniform vec4 uLightBox;\nuniform float uLightK;\nuniform float uLightSlope;\nvarying vec2 vLPos;\n' +
    'uniform vec4 uHalo;\nuniform vec3 uHaloT;\nuniform vec4 uHvP[' + HALO_N + '];\nuniform vec4 uHvS[' + HALO_N + '];\nuniform vec3 uHvC[' + HALO_N + '];\nuniform vec2 uHvK[' + HALO_N + '];\n';
  var RELIEF_FRAG = [
    '#if defined( USE_COLOR )',
    ' diffuseColor.rgb *= pow(vColor, vec3(uRelief));',
    '#endif',
    ' { float rr = max(dot(normalize(vONrm), uSunObj), 0.0) / max(uSunObj.y, 0.2);',
    '   diffuseColor.rgb *= pow(clamp(rr, 0.35, 2.0), uReliefK);',
    '   if (uLightK > 0.0) { float lm = texture2D(uLight, (vLPos - uLightBox.xy) / uLightBox.zw).r * 2.0;',
    '     diffuseColor.rgb *= pow(max(lm, 0.05), uLightK) * exp(uLightK * 0.4 * tanh(uLightSlope * log(clamp(rr, 0.35, 2.0)) / 0.4)); } }',
    HALO_FRAG].join('\n');
  var reliefKey = 'game';
  function setRelief(k) {
    reliefKey = RELIEF[k] ? k : 'game';
    var r = lightU.uLightK.value > 0 ? [0, 0] : RELIEF[reliefKey]; reliefU.uRelief.value = r[0]; reliefU.uReliefK.value = r[1];
    $('sel-relief').value = reliefKey; $('sel-relief').disabled = lightU.uLightK.value > 0;
  }
  // the light switch (round 5c): on at strength k (the slider), off = the relief switch as before
  var lightOk = false, lightInfo = null;
  function setLight(on, k) {
    if (k != null) $('rng-light').value = k;
    on = on && lightOk; $('sw-light').checked = on;
    var v = +$('rng-light').value; lightU.uLightK.value = on ? Math.max(1e-3, v) : 0;
    $('light-v').textContent = v.toFixed(2); setRelief(reliefKey);
  }
  function buildLight() {
    var d = store['light5c:' + MAP];
    if (!d) { $('sw-light').disabled = true; $('sw-light').parentNode.title += '\n(not available: data/' + MAP + '.light5c.js missing)'; return; }
    // one channel on the GPU (R8 + mips): the PNG is decoded once into its grey values; light 1 until it has decoded
    var one = new T.DataTexture(new Uint8Array([128]), 1, 1, T.RedFormat, T.UnsignedByteType); one.needsUpdate = true;
    lightU.uLight.value = one; lightU.uLightBox.value.set(d.x0, d.z0, d.w * d.px, d.h * d.px); lightOk = true;
    lightInfo = { w: d.w, h: d.h, px: d.px, dataBytes: d.r8 ? d.r8.length : b64Bytes(d.png), gpuBytes: Math.round(d.w * d.h * 4 / 3) };
    function lightTex(r) {
      var tex = new T.DataTexture(r, d.w, d.h, T.RedFormat, T.UnsignedByteType);
      tex.flipY = false; tex.colorSpace = T.NoColorSpace; tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter; tex.magFilter = T.LinearFilter;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex.unpackAlignment = 1; tex.needsUpdate = true;
      return tex;
    }
    if (d.r8) { lightU.uLight.value = lightTex(d.r8); lightInfo.decodeMs = 0; return; }  // round 8: the JS builder's grey values as they are (no PNG)
    var im = new Image(); im.src = 'data:image/png;base64,' + d.png;
    im.decode().then(function () {
      var cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
      var cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0);
      var px = cx.getImageData(0, 0, d.w, d.h).data, r = new Uint8Array(d.w * d.h);
      for (var i = 0; i < r.length; i++) r[i] = px[i * 4];
      lightU.uLight.value = lightTex(r); lightInfo.decodeMs = Math.round(performance.now() - t0l);
    });
    var t0l = performance.now();
  }

  // ------------------------------------------------------------------ round-5 ground: the game's own pictures per pixel
  // data/<map>.ground5.js (ground5.py), loaded when one of these modes is first chosen:
  //  g5full   the space's global colour map (global_am.dds; fitted to the minimap where that is a rendered top view)
  //           x the detail of the blended layer textures (<layer>_fwd.dds at their own tiling, height-blended)
  //  g5global the global colour map alone (one texture read)
  //  g5layers the layer textures alone, each tinted to the round-4 layer colour of the map's default
  var G5_MODES = { g5full: { G5_GLOBAL: '', G5_DETAIL: '' }, g5global: { G5_GLOBAL: '' }, g5layers: { G5_DETAIL: '' } };
  var g5 = null, g5State = 'absent', g5Mats = {}, terrainMeshes = [];
  function b64Bytes(s) { return s ? (typeof s === 'string' ? Math.floor(s.length * 3 / 4) : s.byteLength) : 0; }
  async function gunzip(b64) {
    var ds = new DecompressionStream('gzip'), blob = new Blob([new Uint8Array(bytes(b64))]);
    return new Uint8Array(await new Response(blob.stream().pipeThrough(ds)).arrayBuffer());
  }
  // DXT5 -> RGBA (only without the S3TC extension)
  function dxt5Decode(src, w, h) {
    var out = new Uint8Array(w * h * 4), bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2), p = 0, pal = new Float32Array(12), al = new Float32Array(8);
    for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++, p += 16) {
      var a0 = src[p], a1 = src[p + 1]; al[0] = a0; al[1] = a1;
      for (var i = 1; i < 7; i++) al[1 + i] = a0 > a1 ? ((7 - i) * a0 + i * a1) / 7 : (i < 5 ? ((5 - i) * a0 + i * a1) / 5 : (i === 5 ? 0 : 255));
      var c0 = src[p + 8] | src[p + 9] << 8, c1 = src[p + 10] | src[p + 11] << 8;
      pal[0] = (c0 >> 11) * 255 / 31; pal[1] = (c0 >> 5 & 63) * 255 / 63; pal[2] = (c0 & 31) * 255 / 31;
      pal[3] = (c1 >> 11) * 255 / 31; pal[4] = (c1 >> 5 & 63) * 255 / 63; pal[5] = (c1 & 31) * 255 / 31;
      for (var j = 0; j < 3; j++) { pal[6 + j] = (2 * pal[j] + pal[3 + j]) / 3; pal[9 + j] = (pal[j] + 2 * pal[3 + j]) / 3; }
      var bits = (src[p + 12] | src[p + 13] << 8 | src[p + 14] << 16 | src[p + 15] << 24) >>> 0;
      var abl = src[p + 2] | src[p + 3] << 8 | src[p + 4] << 16, abh = src[p + 5] | src[p + 6] << 8 | src[p + 7] << 16;
      for (var t = 0; t < 16; t++) {
        var x = bx * 4 + (t & 3), y = by * 4 + (t >> 2); if (x >= w || y >= h) continue;
        var ci = (bits >>> (2 * t)) & 3, ai = t < 8 ? (abl >> (3 * t)) & 7 : (abh >> (3 * (t - 8))) & 7, o = (y * w + x) * 4;
        out[o] = pal[ci * 3]; out[o + 1] = pal[ci * 3 + 1]; out[o + 2] = pal[ci * 3 + 2]; out[o + 3] = al[ai];
      }
    }
    return out;
  }
  var g5Info = { bytesLoaded: 0, gpuBytes: 0, loadMs: null };
  function ensureG5(key) {
    var pre = store['ground5:' + MAP], layersNeeded = key !== 'g5global';
    // round 8: the JS map builder's colour map alone serves «game colour map»; a layer mode loads the prebuilt layers then
    if (g5State === 'built' && layersNeeded && g5 && !g5.data.layers) g5State = 'absent';
    if (g5State !== 'absent') return g5State === 'built' ? Promise.resolve() : g5State;
    var t0 = performance.now();
    var src = pre && pre.jsOnly && !layersNeeded ? Promise.resolve() : load('data/' + MAP + '.ground5.js').then(function () {
      if (pre && pre.jsOnly) { var o = store['ground5:' + MAP]; o.glob = pre.glob; o.jsGlob = true; }
    });
    g5State = src.then(async function () {
      var d = store['ground5:' + MAP], L = d.layers, B = d.blend, G = d.glob, gpu = 0, loaded = 0;
      if (!L) {  // round 8: no layer data (the JS path): 1-texel stand-ins, never sampled by «game colour map»
        var z4 = new Uint8Array(4);
        B = { idx: z4, wgt: z4, w: 1, h: 1, x0: 0, z0: 0, px: 1, wmax: 63 };
        L = { levels: [{ dxt5: new Uint8Array(16), w: 4, h: 4 }], size: 4, n: 1, proj: new Float32Array(8), chunks: { ncx: 1, ncz: 1, cx0: 0, cz0: 0 }, mean: [], target: [], blendHeight: 0.3, stub: true };
      }
      var tGlob = bc1Texture(G.bc1);
      G.bc1.forEach(function (l) { var n = b64Bytes(l.bc1); gpu += n; loaded += n; });
      var idx = L.stub ? B.idx : await gunzip(B.idx), wgt = L.stub ? B.wgt : await gunzip(B.wgt);
      loaded += b64Bytes(B.idx) + b64Bytes(B.wgt); gpu += idx.length + wgt.length;
      function dataTex(arr) {
        var t = new T.DataTexture(arr, B.w, B.h, T.RGBAFormat, T.UnsignedByteType);
        t.minFilter = t.magFilter = T.NearestFilter; t.generateMipmaps = false; t.flipY = false; t.colorSpace = T.NoColorSpace; t.needsUpdate = true; return t;
      }
      var tIdx = dataTex(idx), tWgt = dataTex(wgt), tLay;
      var mips = L.levels.map(function (l) { var u = u8(l.dxt5); loaded += u.length; gpu += u.length; return { data: u, width: l.w, height: l.h }; });
      if (s3tc && !L.stub) tLay = new T.CompressedArrayTexture(mips, L.size, L.size, L.n, T.RGBA_S3TC_DXT5_Format);
      else {
        var per = mips[0].data.length / L.n, rgba = new Uint8Array(L.size * L.size * 4 * L.n);
        for (var k = 0; k < L.n; k++) rgba.set(dxt5Decode(mips[0].data.subarray(k * per, (k + 1) * per), L.size, L.size), k * L.size * L.size * 4);
        tLay = new T.DataArrayTexture(rgba, L.size, L.size, L.n); tLay.generateMipmaps = true; gpu += rgba.length / 3;
      }
      tLay.wrapS = tLay.wrapT = T.RepeatWrapping; tLay.minFilter = T.LinearMipmapLinearFilter; tLay.magFilter = T.LinearFilter;
      tLay.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tLay.colorSpace = T.NoColorSpace; tLay.needsUpdate = true;
      var P = f32(L.proj); loaded += P.length * 4; gpu += P.length * 4;
      var tProj = new T.DataTexture(P, L.n * 2, L.chunks.ncx * L.chunks.ncz, T.RGBAFormat, T.FloatType);
      tProj.minFilter = tProj.magFilter = T.NearestFilter; tProj.generateMipmaps = false; tProj.needsUpdate = true;
      var fit = params.gcol === 'raw' ? null : G.fit, F = fit || [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
      var mean = [], tint = [];
      for (k = 0; k < 16; k++) {
        var m = L.mean[k] || [0.5, 0.5, 0.5, 0.5], tg = L.target[k] || m;
        mean.push(new T.Vector4(m[0], m[1], m[2], m[3]));
        tint.push(new T.Vector3(tg[0] / Math.max(1e-3, m[0]), tg[1] / Math.max(1e-3, m[1]), tg[2] / Math.max(1e-3, m[2])));
      }
      var ar = mapData.arena;
      g5 = { data: d, u: {
        uGlob: { value: tGlob }, uGlobBox: { value: new T.Vector4(G.x0, G.z0, G.w * G.px, G.h * G.px) },
        uFitR: { value: new T.Vector3(F[0], F[1], F[2]) }, uFitG: { value: new T.Vector3(F[3], F[4], F[5]) },
        uFitB: { value: new T.Vector3(F[6], F[7], F[8]) }, uFitC: { value: new T.Vector3(F[9], F[10], F[11]) },
        uIdx: { value: tIdx }, uWgt: { value: tWgt }, uWBox: { value: new T.Vector4(B.x0, B.z0, B.px, 255 / B.wmax) },
        uWSize: { value: new T.Vector2(B.w, B.h) }, uLay: { value: tLay }, uProj: { value: tProj },
        uChunk: { value: new T.Vector4(L.chunks.cx0, L.chunks.cz0, L.chunks.ncx, L.chunks.ncz) },
        uMean: { value: mean }, uTint: { value: tint }, uHB: { value: L.blendHeight }, uFade: { value: new T.Vector4(60, 250, 0.35, 700) },
        uArena: { value: new T.Vector4(ar[0], ar[1], ar[2], ar[3]) }, uOutside: groundUniforms.uOutside } };
      g5Info.bytesLoaded = loaded; g5Info.gpuBytes = gpu; g5Info.loadMs = Math.round(performance.now() - t0);
      g5State = 'built';
    });
    return g5State;
  }
  var G5_FRAG = [
    'vec3 P5 = vWPos; vec2 p5 = P5.xz; vec3 col5 = vec3(0.5); vec3 dX = dFdx(P5), dY = dFdy(P5);  // outside any branch',
    '#ifdef G5_GLOBAL',
    ' vec3 gc = texture2D(uGlob, (p5 - uGlobBox.xy) / uGlobBox.zw).rgb;',
    ' gc = clamp(gc.r * uFitR + gc.g * uFitG + gc.b * uFitB + uFitC, 0.0, 1.0); col5 = gc;',
    '#endif',
    '#ifdef G5_DETAIL',
    ' float dist5 = length(vViewPosition);',
    // with the colour map, detail ends at uFade.w m (ours): far ground is the colour map alone, and costs only its read
    '#ifdef G5_GLOBAL',
    ' if (dist5 < uFade.w)',
    '#endif',
    ' {',
    // the 4 strongest layers of the 4 nearest 2 m texels, bilinear, merged by layer
    '  int ids[8]; float ws[8]; int n = 0;',
    '  for (int q = 0; q < 8; q++) { ids[q] = -1; ws[q] = 0.0; }',
    '  ivec2 sz = ivec2(uWSize); vec2 f = (p5 - uWBox.xy) / uWBox.z - 0.5; vec2 fl = floor(f); vec2 fr = f - fl; ivec2 i0 = ivec2(fl);',
    '  for (int k = 0; k < 4; k++) {',
    '   ivec2 o = ivec2(k & 1, k >> 1); ivec2 c = clamp(i0 + o, ivec2(0), sz - 1);',
    '   float bw = (o.x == 1 ? fr.x : 1.0 - fr.x) * (o.y == 1 ? fr.y : 1.0 - fr.y);',
    '   vec4 id = texelFetch(uIdx, c, 0) * 255.0; vec4 w = texelFetch(uWgt, c, 0) * uWBox.w;',
    '   for (int j = 0; j < 4; j++) {',
    '    float wj = w[j] * bw; if (wj < 1e-4) continue;',
    '    int Lr = int(id[j] + 0.5); int m = 0;',
    '    for (m = 0; m < n; m++) if (ids[m] == Lr) break;',
    '    if (m == n) { if (n == 8) continue; ids[n] = Lr; n++; }',
    '    ws[m] += wj;',
    '   }',
    '  }',
    // each layer at its own projection (terrain2/layers of the fragment's chunk), height blend (terrain2.xml blendHeight)
    '  ivec2 cc = ivec2(floor(p5 / 100.0)) - ivec2(uChunk.xy);',
    '  int ci = clamp(cc.y, 0, int(uChunk.w) - 1) * int(uChunk.z) + clamp(cc.x, 0, int(uChunk.z) - 1);',
    '  vec4 P4 = vec4(P5, 1.0);',
    '  vec4 smp[8]; float hb[8]; float hmax = -10.0;',
    '  for (int m = 0; m < 8; m++) {',
    '   if (m >= n) break;',
    '   vec4 pu = texelFetch(uProj, ivec2(2 * ids[m], ci), 0), pv = texelFetch(uProj, ivec2(2 * ids[m] + 1, ci), 0);',
    '   vec2 uv = vec2(dot(pu, P4), dot(pv, P4));',
    '   smp[m] = textureGrad(uLay, vec3(uv, float(ids[m])), vec2(dot(pu.xyz, dX), dot(pv.xyz, dX)), vec2(dot(pu.xyz, dY), dot(pv.xyz, dY)));',
    '   hb[m] = ws[m] + smp[m].a; hmax = max(hmax, hb[m]);',
    '  }',
    '  vec3 acc = vec3(0.0), accM = vec3(0.0), accT = vec3(0.0), accMT = vec3(0.0); float wsum = 0.0;',
    '  for (int m = 0; m < 8; m++) {',
    '   if (m >= n) break;',
    '   float wh = max(hb[m] - hmax + uHB, 0.0) * step(1e-3, ws[m]);',
    '   acc += wh * smp[m].rgb; accM += wh * uMean[ids[m]].rgb; accT += wh * smp[m].rgb * uTint[ids[m]]; accMT += wh * uMean[ids[m]].rgb * uTint[ids[m]]; wsum += wh;',
    '  }',
    // the detail's contrast fades with distance (ours: the game blends to its macro textures there; their scale is not
    // decoded): full within uFade.x m, uFade.z of it beyond uFade.y m - long rows of a tiled texture read as a grid otherwise
    '  float dk = mix(1.0, uFade.z, smoothstep(uFade.x, uFade.y, dist5));',
    '#ifdef G5_GLOBAL',
    '  dk *= 1.0 - smoothstep(uFade.y, uFade.w, dist5);',
    '#endif',
    '#ifdef G5_GLOBAL',
    '  if (wsum > 1e-4) col5 = gc * mix(vec3(1.0), acc / max(accM, vec3(1e-3)), dk);',
    '#else',
    '  if (wsum > 1e-4) col5 = mix(accMT, accT, dk) / wsum;',
    '#endif',
    ' }',
    '#endif',
    ' diffuseColor.rgb *= pow(clamp(col5, 0.0, 1.0), vec3(2.2));',
    // the grain switch (round 5b): the fine neutral grain of «texture kinds» (its three noise scales) at strength uGrain
    // (0 = off, 0.72 = «texture kinds»), the same in every ground mode
    ' if (uGrain > 0.0) { float dn5 = texture2D(detailMap, p5 / 1.9).r * 0.35 + texture2D(detailMap, p5 / 7.3).r * 0.35 + texture2D(detailMap, p5 / 41.0).r * 0.3;',
    '   diffuseColor.rgb *= max(0.0, 1.0 - 0.5 * uGrain + uGrain * dn5); }',
    ' float dOut = max(max(uArena.x - p5.x, p5.x - uArena.z), max(uArena.y - p5.y, p5.y - uArena.w));',
    ' if (dOut > 0.0 && uOutside > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.33))), 0.7) * 0.55;',
    ' if (abs(dOut) < 0.6) diffuseColor.rgb = vec3(0.85, 0.12, 0.08);'].join('\n');
  var G5_DECL = ['uniform sampler2D uGlob; uniform vec4 uGlobBox; uniform vec3 uFitR, uFitG, uFitB, uFitC;',
    'uniform sampler2D uIdx, uWgt; uniform vec4 uWBox; uniform vec2 uWSize; uniform mediump sampler2DArray uLay; uniform highp sampler2D uProj;',
    'uniform vec4 uChunk; uniform vec4 uMean[16]; uniform vec3 uTint[16]; uniform float uHB; uniform vec4 uFade; uniform vec4 uArena; uniform float uOutside;',
    'uniform sampler2D detailMap; uniform float uGrain;', 'varying vec3 vWPos;', ''].join('\n');
  function g5Material(key) {
    if (g5Mats[key]) return g5Mats[key];
    var mat = new T.MeshLambertMaterial({ vertexColors: true });
    mat.defines = Object.assign({}, G5_MODES[key]);
    mat.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, g5.u, reliefU, lightU, haloU, { detailMap: groundUniforms.detailMap, uGrain: groundUniforms.uGrain });
      sh.vertexShader = 'varying vec3 vWPos;\nvarying vec3 vONrm;\nvarying vec2 vLPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = position; vONrm = normal; vLPos = position.xz;');
      sh.fragmentShader = G5_DECL + RELIEF_DECL + sh.fragmentShader.replace('#include <color_fragment>', RELIEF_FRAG).replace('#include <map_fragment>', G5_FRAG);
    };
    mat.customProgramCacheKey = function () { return 'ground5-' + key; };
    return (g5Mats[key] = mat);
  }
  function setGround5(key) {
    return ensureG5(key).then(function () {
      if (groundKey !== key) return;  // another mode was chosen meanwhile
      var mat = g5Material(key);
      terrainMeshes.forEach(function (m) { m.material = mat; });
    }).catch(function (e) {
      // without data/<map>.ground5.js (or if it fails) the round-4 default ground stays, and the page says why
      console.warn('round-5 ground not available: ' + (e && e.message)); g5State = 'absent';
      setGround(mapData.terrain.groundDefault || 'groundLayers'); $('sun-info').textContent += '  (round-5 ground: ' + (e && e.message) + ')';
    });
  }

  // ------------------------------------------------------------------ terrain
  var heightAt, groundMat = null, groundUniforms = null, groundTex = {};
  function groundTexture(g) {
    if (g.bc1) return bc1Texture(g.bc1);
    var tex = new T.TextureLoader().load(g.png ? 'data:image/png;base64,' + g.png : 'data:' + g.mime + ';base64,' + g.b64);
    tex.flipY = !!g.flipY; tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  // the StratSketch picture (data/<map>.ref.js, an outside picture, optional look comparison): draped over the arena
  // box north up (picture row 0 = north)
  function refGround() {
    var r = store['ref:' + MAP]; if (!r) return null;
    return { x0: r.x0, z0: r.z0, W: r.x1 - r.x0, H: r.z1 - r.z0, mime: r.mime, b64: r.b64, flipY: true };
  }
  var groundKey = null;
  function setGround(key) {
    if (G5_MODES[key]) { groundKey = key; $('sel-ground').value = key; return setGround5(key); }
    var g = key === 'stratsketch' ? refGround() : mapData.terrain[key]; if (!g || !groundMat) return;
    groundKey = key;
    terrainMeshes.forEach(function (m) { m.material = groundMat; });
    var tex = groundTex[key] || (groundTex[key] = groundTexture(g));
    groundMat.map = tex; groundMat.needsUpdate = true;
    groundUniforms.uGround.value.set(g.x0, g.z0, g.W || g.w * g.px, g.H || g.h * g.px);
    groundUniforms.uSrgb.value = g.bc1 ? 1 : 0;
    $('sel-ground').value = key;
  }
  function buildTerrain(t) {
    var h = u16(t.heights), nx = t.nx, nz = t.nz, TILE = 100;
    var lo = t.hmin;
    var H = new Float32Array(nx * nz);
    for (var q = 0; q < H.length; q++) H[q] = lo + h[q] / 100;
    // relief shading (the fallback the user named, kept with the light): a hollow darker, a ridge lighter, from the
    // height against its 10 m and 40 m neighbourhood mean (box blur over an integral image)
    function blur(r) {
      var I = new Float64Array((nx + 1) * (nz + 1));
      for (var j = 0; j < nz; j++) { var row = 0; for (var i = 0; i < nx; i++) { row += H[j * nx + i]; I[(j + 1) * (nx + 1) + i + 1] = I[j * (nx + 1) + i + 1] + row; } }
      var out = new Float32Array(nx * nz);
      for (j = 0; j < nz; j++) for (i = 0; i < nx; i++) {
        var a0 = Math.max(0, i - r), a1 = Math.min(nx, i + r + 1), b0 = Math.max(0, j - r), b1 = Math.min(nz, j + r + 1);
        var s = I[b1 * (nx + 1) + a1] - I[b0 * (nx + 1) + a1] - I[b1 * (nx + 1) + a0] + I[b0 * (nx + 1) + a0];
        out[j * nx + i] = s / ((a1 - a0) * (b1 - b0));
      }
      return out;
    }
    // round 5c: lowest / highest height per 50 m tile (game coordinates), for the shadow boxes' height band
    (function () {
      var n = Math.ceil((nx - 1) * t.cell / 50), m = Math.ceil((nz - 1) * t.cell / 50), lo = new Float32Array(n * m).fill(1e9), hi = new Float32Array(n * m).fill(-1e9), gLo = 1e9, gHi = -1e9;
      for (var j = 0; j < nz; j++) for (var i = 0; i < nx; i++) {
        var h = H[j * nx + i], ti = Math.min(n - 1, Math.floor(i * t.cell / 50)), tj = Math.min(m - 1, Math.floor(j * t.cell / 50)), k = tj * n + ti;
        // a sample on a tile edge belongs to both tiles
        for (var dj = 0; dj < 2; dj++) for (var di = 0; di < 2; di++) {
          var ii = Math.min(n - 1, Math.floor(Math.max(0, i * t.cell - di * 0.01) / 50)), jj = Math.min(m - 1, Math.floor(Math.max(0, j * t.cell - dj * 0.01) / 50)), kk = jj * n + ii;
          if (h < lo[kk]) lo[kk] = h; if (h > hi[kk]) hi[kk] = h;
        }
        if (h < gLo) gLo = h; if (h > gHi) gHi = h;
      }
      tiles50 = { x0: t.x0, z0: t.z0, n: n, m: m, lo: lo, hi: hi, gLo: gLo, gHi: gHi };
    })();
    var B5 = blur(5), B20 = blur(20);
    var shade = new Float32Array(nx * nz);
    for (q = 0; q < H.length; q++) shade[q] = Math.max(0.62, Math.min(1.18, 1 + 0.07 * (H[q] - B5[q]) + 0.012 * (H[q] - B20[q])));
    var g0 = t[t.groundDefault] || t.groundLayers || t.ground, tex = groundTexture(g0);
    var detail = noiseTexture();
    var mat = groundMat = new T.MeshLambertMaterial({ vertexColors: true, map: tex });
    var ar = mapData.arena;
    groundUniforms = { detailMap: { value: detail }, uGround: { value: new T.Vector4(g0.x0, g0.z0, g0.w * g0.px, g0.h * g0.px) },
      uArena: { value: new T.Vector4(ar[0], ar[1], ar[2], ar[3]) }, uOutside: { value: 1 }, uGrain: { value: 1.5 }, uSrgb: { value: 0 } };
    mat.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, groundUniforms, reliefU, lightU, haloU);
      sh.vertexShader = 'varying vec2 vGPos;\nvarying vec3 vONrm;\nvarying vec2 vLPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vGPos = position.xz; vONrm = normal; vLPos = position.xz;');
      sh.fragmentShader = 'uniform sampler2D detailMap;\nuniform vec4 uGround;\nuniform vec4 uArena;\nuniform float uOutside;\nuniform float uGrain;\nuniform float uSrgb;\nvarying vec2 vGPos;\n' + RELIEF_DECL +
        sh.fragmentShader.replace('#include <color_fragment>', RELIEF_FRAG).replace('#include <map_fragment>', [
          ' vec4 sampledDiffuseColor = texture2D(map, clamp((vGPos - uGround.xy) / uGround.zw, 0.0, 1.0));',
          ' if (uSrgb > 0.5) sampledDiffuseColor.rgb = pow(sampledDiffuseColor.rgb, vec3(2.2));',
          ' diffuseColor *= sampledDiffuseColor;',
          ' float dn = texture2D(detailMap, vGPos / 1.9).r * 0.35 + texture2D(detailMap, vGPos / 7.3).r * 0.35 + texture2D(detailMap, vGPos / 41.0).r * 0.3;',
          ' diffuseColor.rgb *= max(0.0, 1.0 - 0.5 * uGrain + uGrain * dn);',
          // outside the playable box: dimmed (or as is); the border itself a red line on the ground, 1.2 m wide
          ' float dOut = max(max(uArena.x - vGPos.x, vGPos.x - uArena.z), max(uArena.y - vGPos.y, vGPos.y - uArena.w));',
          ' if (dOut > 0.0 && uOutside > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.33))), 0.7) * 0.55;',
          ' if (abs(dOut) < 0.6) diffuseColor.rgb = vec3(0.85, 0.12, 0.08);'].join('\n'));
    };
    var GW = g0.w * g0.px, GH = g0.h * g0.px;
    for (var tj = 0; tj < nz - 1; tj += TILE) {
      for (var ti = 0; ti < nx - 1; ti += TILE) {
        var w = Math.min(TILE, nx - 1 - ti) + 1, d = Math.min(TILE, nz - 1 - tj) + 1;
        var pos = new Float32Array(w * d * 3), col = new Float32Array(w * d * 3), uv = new Float32Array(w * d * 2), idx = new Uint32Array((w - 1) * (d - 1) * 6);
        var k = 0, ku = 0;
        for (var j = 0; j < d; j++) for (var i = 0; i < w; i++) {
          var gi = (tj + j) * nx + ti + i, x = t.x0 + (ti + i) * t.cell, z = t.z0 + (tj + j) * t.cell;
          pos[k] = x; pos[k + 1] = H[gi]; pos[k + 2] = z;
          col[k] = col[k + 1] = col[k + 2] = shade[gi];
          uv[ku] = (x - g0.x0) / GW; uv[ku + 1] = (z - g0.z0) / GH;
          k += 3; ku += 2;
        }
        k = 0;
        for (j = 0; j < d - 1; j++) for (i = 0; i < w - 1; i++) {
          var a = j * w + i, b = a + 1, c = a + w, e = c + 1;
          if (((ti + i) ^ (tj + j)) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = e; }
          else { idx[k++] = a; idx[k++] = c; idx[k++] = e; idx[k++] = a; idx[k++] = e; idx[k++] = b; }
        }
        var g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('color', new T.BufferAttribute(col, 3));
        g.setAttribute('uv', new T.BufferAttribute(uv, 2));
        g.setIndex(new T.BufferAttribute(idx, 1));
        g.computeVertexNormals(); g.computeBoundingSphere();
        var m = new T.Mesh(g, mat); m.receiveShadow = true; m.castShadow = true;
        layers.terrain.add(m); terrainMeshes.push(m);
        info.terrainTris += idx.length / 3;
      }
    }
    heightAt = function (x, z) {
      var fi = (x - t.x0) / t.cell, fj = (z - t.z0) / t.cell, i = Math.max(0, Math.min(nx - 2, Math.floor(fi))), j = Math.max(0, Math.min(nz - 2, Math.floor(fj)));
      var u = Math.min(1, Math.max(0, fi - i)), v = Math.min(1, Math.max(0, fj - j));
      return (H[j * nx + i] * (1 - u) + H[j * nx + i + 1] * u) * (1 - v) + (H[(j + 1) * nx + i] * (1 - u) + H[(j + 1) * nx + i + 1] * u) * v;
    };
  }

  // ------------------------------------------------------------------ objects with destruction
  function meshGeometry(m) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(m.vmin ? deq(m.v, m.vmin, m.vrange) : f32(m.v), 3));
    if (m.c) g.setAttribute('color', new T.BufferAttribute(u8(m.c), 3, true));
    g.setIndex(new T.BufferAttribute(m.i32 ? u32(m.i) : u16(m.i), 1));
    g.computeVertexNormals();
    return g;
  }
  function placementMatrix(a, o) {
    return new T.Matrix4().fromArray([a[o], a[o + 1], a[o + 2], 0, a[o + 3], a[o + 4], a[o + 5], 0, a[o + 6], a[o + 7], a[o + 8], 0, a[o + 9], a[o + 10], a[o + 11], 1]);
  }
  // Module code per vertex (build.py module_code): 0 always (gone when the whole object is destroyed), k+1 intact
  // module k, -(k+1) remains of module k, -100 remains of the whole. Per instance a destroyed-mask: bits 0..22
  // modules, bit 23 the whole object.
  var MOD_SHADER = [
    '{ uint dm = uint(iDead + 0.5); bool whole = ((dm >> 23u) & 1u) == 1u; bool vis;',
    '  if (aMod > 0.5) { uint mk = uint(aMod - 0.5); vis = !whole && ((dm >> mk) & 1u) == 0u; }',
    '  else if (aMod < -99.0) vis = whole;',
    '  else if (aMod < -0.5) { uint mk = uint(-aMod - 0.5); vis = whole || ((dm >> mk) & 1u) == 1u; }',
    '  else vis = !whole;',
    '  if (!vis) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }'].join('\n');
  // outside the playable box: uOutside 0 as is, 1 dimmed, 2 hidden (per instance flag iOut)
  var outsideU = { value: 1 };
  function withModules(material, depth) {
    material.onBeforeCompile = function (sh) {
      sh.uniforms.uOutside = outsideU;
      sh.vertexShader = 'attribute float aMod;\nattribute float iDead;\nattribute float iOut;\nuniform float uOutside;\nvarying float vOutDim;\n' +
        sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' + MOD_SHADER +
          '\n vOutDim = (iOut > 0.5 && uOutside > 0.5) ? 0.5 : 1.0;\n if (iOut > 0.5 && uOutside > 1.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
      if (!depth) sh.fragmentShader = 'varying float vOutDim;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vOutDim;');
      else sh.fragmentShader = 'varying float vOutDim;\n' + sh.fragmentShader;
    };
    material.customProgramCacheKey = function () { return depth ? 'modules-depth' : 'modules'; };
    return material;
  }
  var objRecs = [];
  // Collision records (what blocks a shot) are in the map file; their meshes in data/<map>.collision.js, loaded the
  // first time the 'objects' switch asks for collision (round 4: not needed to draw the map).
  function buildObjects(objects) {
    objects.forEach(function (rec, ri) {
      var base = [], outFlags = new Float32Array(rec.n), k;
      if (rec.m) {
        var a = f32(rec.m);
        for (k = 0; k < rec.n; k++) base.push(placementMatrix(a, k * 12));
        if (rec.out) outFlags = new Float32Array(u8(rec.out));
      } else {
        // linked to a visual model (build.py): the same physical objects, their transforms held once there
        var vr = visRecs[rec.vis], vk = u16(rec.visK), vo = vr.rec.out ? u8(vr.rec.out) : null;
        for (k = 0; k < rec.n; k++) { base.push(vr.base[vk[k]]); if (vo) outFlags[k] = vo[vk[k]]; }
      }
      objRecs[ri] = { rec: rec, base: base, mesh: null, dead: new Float32Array(rec.n), out: outFlags };
    });
  }
  var collisionState = 'absent';
  function ensureCollision() {
    if (collisionState !== 'absent') return collisionState === 'built' ? Promise.resolve() : collisionState;
    collisionState = load('data/' + MAP + '.collision.js').then(function () {
      var meshes = store['collision:' + MAP] || [];
      var mat = withModules(new T.MeshLambertMaterial({ vertexColors: true }));
      var depth = withModules(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking }), true);
      var hmat = new T.MeshBasicMaterial({ color: 0xff30ff, wireframe: true });
      objRecs.forEach(function (entry, ri) {
        var rec = entry.rec, cm = meshes[ri] || {}, base = entry.base, k;
        if (cm.mesh) {
          var g = meshGeometry(cm.mesh);
          var mod = cm.mesh.mod ? i8(cm.mesh.mod) : new Int8Array(cm.mesh.nv);
          g.setAttribute('aMod', new T.BufferAttribute(new Float32Array(mod), 1));
          var im = new T.InstancedMesh(g, mat, rec.n);
          im.customDepthMaterial = depth;
          g.setAttribute('iDead', new T.InstancedBufferAttribute(entry.dead, 1));
          g.setAttribute('iOut', new T.InstancedBufferAttribute(entry.out, 1));
          for (k = 0; k < rec.n; k++) im.setMatrixAt(k, base[k]);
          im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.name = rec.name;
          im.castShadow = true; im.receiveShadow = true;
          layers.objects.add(im); entry.mesh = im;
          info.objectTris += cm.mesh.nt * rec.n; info.objectInstances += rec.n;
        }
        if (cm.helper) {
          var hm = new T.InstancedMesh(meshGeometry(cm.helper), hmat, rec.n);
          for (k = 0; k < rec.n; k++) hm.setMatrixAt(k, base[k]);
          hm.instanceMatrix.needsUpdate = true; hm.computeBoundingSphere(); layers.helpers.add(hm);
        }
      });
      collisionState = 'built';
      resetDestruction(); dTime = -1e9;  // replay the destruction so far onto the new meshes
    });
    return collisionState;
  }

  // ------------------------------------------------------------------ objects as the game draws them: the visual model
  // Data (objects_visual.py): visual[] per model: a LOD's positions / texcoords (u16 over ranges), a tile per vertex
  // (rects[] of one BC1 atlas: x, y, w, h in 0..1), module code per vertex (as the collision's), placements. The atlas
  // tile is sampled at fract(uv): the game's textures repeat (walls, planks), the atlas cannot wrap by itself.
  var visRecs = [];
  function withAtlas(material, depth) {
    material.onBeforeCompile = function (sh) {
      sh.uniforms.uOutside = outsideU; sh.uniforms.uTexel = atlasTexel;
      sh.vertexShader = 'attribute float aMod;\nattribute float iDead;\nattribute float iOut;\nattribute vec4 aRect;\nuniform float uOutside;\nvarying float vOutDim;\nvarying vec4 vRect;\n' +
        sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' + MOD_SHADER +
          '\n vRect = aRect; vOutDim = (iOut > 0.5 && uOutside > 0.5) ? 0.5 : 1.0;\n if (iOut > 0.5 && uOutside > 1.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
      if (!depth) sh.fragmentShader = 'uniform vec2 uTexel;\nvarying float vOutDim;\nvarying vec4 vRect;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', [
          ' vec2 tUv = vRect.xy + uTexel + fract(vMapUv) * (vRect.zw - 2.0 * uTexel);',
          ' vec4 tc = textureGrad(map, tUv, dFdx(vMapUv) * vRect.zw, dFdy(vMapUv) * vRect.zw);',
          ' diffuseColor.rgb *= pow(tc.rgb, vec3(2.2));'].join('\n'))
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vOutDim;');
    };
    material.customProgramCacheKey = function () { return depth ? 'atlas-depth' : 'atlas'; };
    return material;
  }
  // round 11: rocks and cliffs (the game's PBS_tiled_atlas_global, objects_visual.py Rocks): three tiles of the game's
  // albedo-height atlas repeated at the material's tile scale (first texcoord), mixed by the model's blend mask (second
  // texcoord: R, G, 1 - R - G times each tile's height, ^8), dirt by the mask's B, brightness and normal from the
  // global texture, occlusion from the mask's alpha; every texture a layer of one DXT5 array, 5 vec4s per material
  // (atlas.rocks.mats: layers t0 t1 t2 dirt | blend global scale.xy | tint0 + cell inset | tint1 + dirt strength | tint2).
  function withRock(material, tex, mats) {
    var vecs = [];
    mats.forEach(function (m) { for (var j = 0; j < 20; j += 4) vecs.push(new T.Vector4(m[j], m[j + 1], m[j + 2], m[j + 3])); });
    var u = { uRockTex: { value: tex }, uRockM: { value: vecs } };
    material.onBeforeCompile = function (sh) {
      sh.uniforms.uOutside = outsideU; Object.assign(sh.uniforms, u);
      sh.vertexShader = 'attribute float aMod;\nattribute float iDead;\nattribute float iOut;\nattribute vec2 aUv2;\nattribute float aRockMat;\nuniform float uOutside;\nvarying float vOutDim;\nvarying vec2 vUv2;\nvarying float vRockMat;\n' +
        sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' + MOD_SHADER +
          '\n vUv2 = aUv2; vRockMat = aRockMat; vOutDim = (iOut > 0.5 && uOutside > 0.5) ? 0.5 : 1.0;\n if (iOut > 0.5 && uOutside > 1.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
      sh.fragmentShader = 'precision highp sampler2DArray;\nuniform sampler2DArray uRockTex;\nuniform vec4 uRockM[' + vecs.length + '];\nvarying float vOutDim;\nvarying vec2 vUv2;\nvarying float vRockMat;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', [
          ' float rAO = 1.0; vec3 rMapN = vec3(0.0, 0.0, 1.0);',
          ' { int rmi = int(vRockMat + 0.5) * 5;',
          '   vec4 rm0 = uRockM[rmi], rm1 = uRockM[rmi + 1], rt0 = uRockM[rmi + 2], rt1 = uRockM[rmi + 3], rt2 = uRockM[rmi + 4];',
          '   vec2 rTu = vMapUv * rm1.zw; float rIn = rt0.w, rK = 1.0 - 2.0 * rIn;',
          '   vec2 rF = rIn + fract(rTu) * rK, rGx = dFdx(rTu) * rK, rGy = dFdy(rTu) * rK;',
          '   vec4 rA0 = textureGrad(uRockTex, vec3(rF, rm0.x), rGx, rGy);',
          '   vec4 rA1 = textureGrad(uRockTex, vec3(rF, rm0.y), rGx, rGy);',
          '   vec4 rA2 = textureGrad(uRockTex, vec3(rF, rm0.z), rGx, rGy);',
          '   vec4 rBl = texture(uRockTex, vec3(vUv2, rm1.x));',
          '   vec3 rH = vec3(rA0.a, rA1.a, rA2.a);',
          '   vec3 rW = clamp(vec3(rBl.r, rBl.g, clamp(1.0 - rBl.r - rBl.g, 0.0, 1.0)) * rH, 0.0, 1.0);',
          '   rW.z += 0.01; rW *= rW; rW *= rW; rW *= rW; rW /= max(1e-6, rW.x + rW.y + rW.z);',
          '   vec3 rAlb = pow(rA0.rgb, vec3(2.2)) * rt0.rgb * rW.x + pow(rA1.rgb, vec3(2.2)) * rt1.rgb * rW.y + pow(rA2.rgb, vec3(2.2)) * rt2.rgb * rW.z;',
          '   float rHb = dot(rW, rH);',
          '   if (rm0.w >= 0.0) {',
          '     vec4 rD = textureGrad(uRockTex, vec3(fract(rTu), rm0.w), dFdx(rTu), dFdy(rTu));',
          '     float rb = rBl.b * 2.0 - 1.0, rMix = mix(1.0 - rHb, rHb, clamp(rb * 10.0, 0.0, 1.0));',
          '     rAlb = mix(rAlb, pow(rD.rgb, vec3(2.2)), clamp((rb * rb - rMix) * 6.0 * rt1.w + rb * rb, 0.0, 1.0) * rD.a);',
          '   }',
          '   vec4 rG = rm1.y >= 0.0 ? texture(uRockTex, vec3(vUv2, rm1.y)) : vec4(0.5, 0.5, 0.25, 0.5);',
          '   rAlb *= 2.0 * rG.b; rAO = rBl.a;',
          '   rMapN.xy = vec2(rG.a * 2.0 - 1.0, 1.0 - rG.g * 2.0); rMapN.z = sqrt(max(0.0, 1.0 - dot(rMapN.xy, rMapN.xy)));',
          '   diffuseColor.rgb *= rAlb; }'].join('\n'))
        .replace('#include <normal_fragment_maps>', [
          ' { vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition); vec2 s0 = dFdx(vUv2), s1 = dFdy(vUv2);',
          '   vec3 q1p = cross(q1, normal), q0p = cross(normal, q0);',
          '   vec3 rT = q1p * s0.x + q0p * s1.x, rB = q1p * s0.y + q0p * s1.y;',
          '   float rDet = max(dot(rT, rT), dot(rB, rB)), rS = rDet == 0.0 ? 0.0 : inversesqrt(rDet);',
          '   normal = normalize(rT * (rS * rMapN.x) + rB * (rS * rMapN.y) + normal * rMapN.z); }'].join('\n'))
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n reflectedLight.indirectDiffuse *= rAO; reflectedLight.directDiffuse *= 0.5 + 0.5 * rAO;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vOutDim;');
    };
    material.customProgramCacheKey = function () { return 'rock'; };
    return material;
  }
  var rockTex = null;   // 19.11: the rock layers' array texture once made (MapBench.rocks)
  function rockTexture(R) {
    var mips = R.levels.map(function (l) { return { data: u8(l.dxt5), width: l.w, height: l.h }; });
    var t = new T.CompressedArrayTexture(mips, R.size, R.size, R.n, T.RGBA_S3TC_DXT5_Format);
    t.wrapS = t.wrapT = T.RepeatWrapping; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.colorSpace = T.NoColorSpace; t.needsUpdate = true;
    rockTex = t;
    return t;
  }
  var atlasTexel = { value: new T.Vector2(0, 0) };
  function buildVisual(visual, atlas) {
    if (!visual || !atlas) return;
    var tex = bc1Texture(atlas.levels);
    atlasTexel.value.set(0.5 / atlas.w, 0.5 / atlas.h);
    var mat = withAtlas(new T.MeshLambertMaterial({ map: tex }));
    var R = atlas.rocks, rockMat = R && s3tc ? withRock(new T.MeshLambertMaterial({ map: tex }), rockTexture(R), R.mats) : null;
    var depth = withModules(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking }), true);
    visual.forEach(function (rec, vi) {
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(deq(rec.p, rec.pmin, rec.prange), 3));
      g.setAttribute('uv', new T.BufferAttribute(deq(rec.uv, rec.umin, rec.urange), 2));
      var tile = rec.tile16 ? u16(rec.tile) : u8(rec.tile), rect = new Float32Array(rec.nv * 4);
      for (var v = 0; v < rec.nv; v++) { var r = rec.rects[tile[v]]; rect[v * 4] = r[0]; rect[v * 4 + 1] = r[1]; rect[v * 4 + 2] = r[2]; rect[v * 4 + 3] = r[3]; }
      g.setAttribute('aRect', new T.BufferAttribute(rect, 4));
      g.setAttribute('aMod', new T.BufferAttribute(new Float32Array(rec.mod ? i8(rec.mod) : new Int8Array(rec.nv)), 1));
      g.setIndex(new T.BufferAttribute(rec.i32 ? u32(rec.i) : u16(rec.i), 1));
      g.computeVertexNormals();
      var a = f32(rec.m), base = [];
      for (var k = 0; k < rec.n; k++) base.push(placementMatrix(a, k * 12));
      var rock = rockMat && rec.rock;
      if (rock) {
        g.setAttribute('aUv2', new T.BufferAttribute(deq(rec.rock.uv2, rec.rock.u2min, rec.rock.u2range), 2));
        g.setAttribute('aRockMat', new T.BufferAttribute(new Float32Array(u8(rec.rock.mat)), 1));
        info.rockModels = (info.rockModels || 0) + 1;
      }
      var im = new T.InstancedMesh(g, rock ? rockMat : mat, rec.n), dead = new Float32Array(rec.n);
      im.customDepthMaterial = depth;
      g.setAttribute('iDead', new T.InstancedBufferAttribute(dead, 1));
      g.setAttribute('iOut', new T.InstancedBufferAttribute(rec.out ? new Float32Array(u8(rec.out)) : new Float32Array(rec.n), 1));
      for (k = 0; k < rec.n; k++) im.setMatrixAt(k, base[k]);
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.name = rec.name;
      im.castShadow = true; im.receiveShadow = true;
      layers.visual.add(im);
      visRecs[vi] = { rec: rec, base: base, mesh: im, dead: dead };
      info.visualTris = (info.visualTris || 0) + rec.nt * rec.n; info.visualInstances = (info.visualInstances || 0) + rec.n;
    });
  }
  // the visual instance of a collision instance (build.py links them by the same physical object), or null
  function visOf(ri, k) {
    var e = objRecs[ri]; if (!e || e.rec.vis == null) return null;
    if (!e.visK) e.visK = u16(e.rec.visK);
    var vr = visRecs[e.rec.vis]; return vr ? { r: vr, k: e.visK[k] } : null;
  }
  function setObjectsMode(m) {
    if (m !== 'visual') ensureCollision();
    layers.visual.visible = m !== 'collision'; layers.objects.visible = m !== 'visual';
    $('sel-objects').value = m;
    var cb = document.querySelector('[data-layer="objects"]'); if (cb) cb.checked = true;
    shadowDirty();
  }

  // ------------------------------------------------------------------ plants: each kind's lowest 3D LOD from its .srt
  // Data (build.py plant_kind / build_trees): kinds[] with geo parts (leaf / bark, positions, texcoords, indices),
  // their textures (leaf alpha cut-out), a hull for the simple mode; groups[] = (kind, class, outside) placements.
  // Foliage near the camera fades out (dithered between NEAR0 and NEAR1 metres), so a close camera is never inside
  // a plant's leaves.
  var treeRecs = [], NEAR0 = 4.0, NEAR1 = 9.0, plantMats = [], crownMode = 'lod';
  var fadeU = { uNear0: { value: NEAR0 }, uNear1: { value: NEAR1 }, uSee: { value: 0 } };
  function hullGeometry(k) {
    var R = k.ys.length, S = k.r[0].length, pos = [], col = [], idx = [], lf = [];
    var leaf = (k.tex.leaf && k.tex.leaf.avg) || [0.3, 0.38, 0.2], bark = (k.tex.bark && k.tex.bark.avg) || [0.33, 0.28, 0.23];
    var rmax = 0; k.r.forEach(function (row) { row.forEach(function (v) { rmax = Math.max(rmax, v); }); });
    for (var i = 0; i < R; i++) {
      var ringR = k.r[i].reduce(function (a, b) { return a + b; }, 0) / S;
      var c = ringR < 0.22 * rmax && i < R - 1 ? bark : leaf;
      for (var s = 0; s < S; s++) {
        var ang = (s + 0.5) / S * Math.PI * 2, r = Math.max(0.05, k.r[i][s]);
        pos.push(Math.cos(ang) * r, k.ys[i], Math.sin(ang) * r);
        col.push(c[0], c[1], c[2]); lf.push(c === bark ? 0 : 1);
      }
    }
    for (i = 0; i < R - 1; i++) for (s = 0; s < S; s++) {
      var a = i * S + s, b = i * S + (s + 1) % S, cc = a + S, d = b + S;
      idx.push(a, cc, b, b, cc, d);
    }
    var top = pos.length / 3; pos.push(0, k.hi[1], 0); col.push(leaf[0], leaf[1], leaf[2]); lf.push(1);
    for (s = 0; s < S; s++) idx.push((R - 1) * S + s, top, (R - 1) * S + (s + 1) % S);
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.setAttribute('aLeaf', new T.Float32BufferAttribute(lf, 1));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  // round 13: the foliage slider - uSee 0 solid .. 1 gone: that share of a crown's or bush's pixels is left out on a fixed
  // 4x4 ordered pattern (no sorting, the cost of solid; 0.5 is the former see-through checkbox's look). `see`: 0 never
  // (bark: trunks stay), 1 always (leaves; the far pictures, whose trunk is in the picture), 2 by the vertex's aLeaf (the
  // simple crowns: leaf rings 1, trunk rings 0). The shadow pass is not touched: crowns still cast their shadows.
  function setFoliage(k) {
    if (k != null) $('rng-foliage').value = k;
    fadeU.uSee.value = +$('rng-foliage').value; $('foliage-v').textContent = fadeU.uSee.value.toFixed(2);
  }
  function withFade(material, depth, see) {
    material.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, fadeU);
      var useAttr = !depth && see === 2, useSee = !depth && (see === 1 || see === 2);
      sh.vertexShader = 'varying float vCamDist;\n' + (useAttr ? 'attribute float aLeaf;\nvarying float vLeaf;\n' : '') +
        sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vCamDist = -mvPosition.z;' + (useAttr ? ' vLeaf = aLeaf;' : ''));
      sh.fragmentShader = 'uniform float uNear0;\nuniform float uNear1;\nuniform float uSee;\nvarying float vCamDist;\n' + (useAttr ? 'varying float vLeaf;\n' : '') +
        (useSee ? 'const float SEE_BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);\n' : '') +
        sh.fragmentShader.replace('void main() {', 'void main() {\n float fadeK = clamp((vCamDist - uNear0) / (uNear1 - uNear0), 0.0, 1.0);\n' +
          ' float dith = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);\n' +
          ' if (fadeK < dith) discard;\n' + (useSee ? ' { ivec2 sq = ivec2(mod(floor(gl_FragCoord.xy), 4.0)); if ((SEE_BAYER[sq.x + sq.y * 4] + 0.5) / 16.0 < uSee' +
          (useAttr ? ' * step(0.5, vLeaf)' : '') + ') discard; }\n' : ''));
    };
    material.customProgramCacheKey = function () { return (depth ? 'fade-depth-' : 'fade-' + (see | 0) + '-') + material.uuid; };
    return material;
  }
  var plantTexLoads = [];  // the impostors are rendered once every plant texture has decoded
  function plantTexture(t, repeat) {
    if (t.rgba) {  // round 9: the JS map builder hands the decoded RGBA of the game's DDS (no PNG round trip)
      var dt = new T.DataTexture(t.rgba, t.w, t.h, T.RGBAFormat); dt.colorSpace = T.SRGBColorSpace; dt.flipY = false;
      dt.magFilter = T.LinearFilter; dt.minFilter = T.LinearMipmapLinearFilter; dt.generateMipmaps = true;
      if (repeat) dt.wrapS = dt.wrapT = T.RepeatWrapping;
      dt.anisotropy = 4; dt.needsUpdate = true;
      return dt;
    }
    var done, tex = new T.TextureLoader().load('data:image/png;base64,' + t.png, function () { done(); }, undefined, function () { done(); });
    plantTexLoads.push(new Promise(function (r) { done = r; }));
    tex.colorSpace = T.SRGBColorSpace; tex.flipY = false;
    if (repeat) tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }
  var kindParts = [];
  function kindGeometry(k) {
    // one geometry per texture of the kind (leaf / bark), the .srt's own positions and texcoords
    var byTex = {};
    k.geo.forEach(function (p) {
      var o = byTex[p.tex] || (byTex[p.tex] = { pos: [], uv: [], idx: [], n: 0 });
      var P = deq(p.p, p.pmin, p.prange), U = deq(p.uv, p.uvmin, p.uvrange), I = p.i32 ? u32(p.i) : u16(p.i);
      for (var i = 0; i < P.length; i++) o.pos.push(P[i]);
      for (i = 0; i < U.length; i++) o.uv.push(U[i]);
      for (i = 0; i < I.length; i++) o.idx.push(I[i] + o.n);
      o.n += p.n;
    });
    return Object.keys(byTex).map(function (key) {
      var o = byTex[key], g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(o.pos, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(o.uv, 2));
      g.setIndex(o.idx); g.computeVertexNormals(); g.computeBoundingSphere();
      var t = k.tex[key] || k.tex.leaf, leaf = key === 'leaf';
      var map = t ? plantTexture(t, !leaf) : null;
      var mat = withFade(new T.MeshLambertMaterial({ map: map, color: map ? 0xffffff : 0x56663a, alphaTest: leaf ? 0.4 : 0,
        side: T.DoubleSide }), false, leaf ? 1 : 0);
      var dm = withFade(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: leaf ? map : null, alphaTest: leaf ? 0.4 : 0 }), true);
      plantMats.push(mat);
      return { geo: g, mat: mat, depth: dm };
    });
  }
  function buildTrees(data) {
    var kinds = data.kinds;
    kinds.forEach(function (k, ki) { kindParts[ki] = { lod: kindGeometry(k), hull: null, k: k }; });
    data.groups.forEach(function (g, gi) {
      var a = f32(g.m), base = [];
      for (var j = 0; j < g.n; j++) base.push(placementMatrix(a, j * 12));
      treeRecs[gi] = { group: g, kind: kinds[g.kind], base: base, cur: base.slice(), meshes: [], ki: g.kind };
      makeGroupMeshes(gi);
      info.treeInstances += g.n;
    });
    applyOutside();
  }
  var hullMat = null;
  // Far plants: beyond FAR metres from the camera a kind is drawn as an impostor - two crossed upright cards and one
  // flat card, textured with pictures of the kind's own 3D LOD rendered here at load (side and top views). The game
  // ships no billboard textures for these kinds (the .srt names *_Billboards_AM.dds; no such file in the packages).
  var impostorRT = null;
  var FAR = 160, impostorTex = null, impostorMat = null, impostorDepth = null, IMP_TILE = 128;
  function buildImpostors(kinds) {
    var cols = 8, rows = Math.ceil(kinds.length * 2 / cols), W = cols * IMP_TILE, H = rows * IMP_TILE;
    var rt = new T.WebGLRenderTarget(W, H, { generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
    rt.texture.colorSpace = T.SRGBColorSpace;
    var sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xffffff, 0x9a9488, 2.2));
    var dl = new T.DirectionalLight(0xffffff, 1.3); dl.position.set(0.3, 1, 0.6); sc.add(dl);
    var cam = new T.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    var oldSee = fadeU.uSee.value, oldN0 = fadeU.uNear0.value, oldN1 = fadeU.uNear1.value, oldClear = renderer.getClearAlpha(), oldColor = renderer.getClearColor(new T.Color());
    fadeU.uNear0.value = -1e6; fadeU.uNear1.value = -1e6 + 1; fadeU.uSee.value = 0;  // the pictures of whole plants
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.setScissorTest(true);
    kinds.forEach(function (k, i) {
      var grp = new T.Group(); kindParts[i].lod.forEach(function (p) { grp.add(new T.Mesh(p.geo, p.mat)); }); sc.add(grp);
      var R = Math.max(0.3, k.crown * 1.05), y0 = Math.min(0, k.lo[1]), y1 = k.hi[1];
      [0, 1].forEach(function (view) {
        var t = i * 2 + view, x = (t % cols) * IMP_TILE, y = Math.floor(t / cols) * IMP_TILE;
        renderer.setViewport(x, y, IMP_TILE, IMP_TILE); renderer.setScissor(x, y, IMP_TILE, IMP_TILE);
        if (view === 0) { cam.left = -R; cam.right = R; cam.top = y1; cam.bottom = y0; cam.position.set(0, 0, 50); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); }
        else { cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.position.set(0, 100, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); }
        cam.near = -1000; cam.far = 1000; cam.updateProjectionMatrix();
        renderer.render(sc, cam);
      });
      sc.remove(grp);
      kindParts[i].imp = impostorGeometry(k, i, cols, rows, R, y0, y1);
    });
    renderer.setScissorTest(false); renderer.setRenderTarget(null); renderer.setClearColor(oldColor, oldClear);
    renderer.setViewport(0, 0, renderer.domElement.width / renderer.getPixelRatio(), renderer.domElement.height / renderer.getPixelRatio());
    fadeU.uNear0.value = oldN0; fadeU.uNear1.value = oldN1; fadeU.uSee.value = oldSee;
    impostorTex = rt.texture; impostorRT = rt;
    impostorMat = withFade(new T.MeshLambertMaterial({ map: impostorTex, alphaTest: 0.45, side: T.DoubleSide }), false, 1);
    // the cards' normals point up (lit like a crown from above) on both faces: no flip on the back face
    var fadeCompile = impostorMat.onBeforeCompile;
    impostorMat.onBeforeCompile = function (sh) { fadeCompile(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>' + String.fromCharCode(10) + ' normal = normalize(vNormal);'); };
    impostorDepth = withFade(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: impostorTex, alphaTest: 0.45 }), true);
    plantMats.push(impostorMat);
    // the shadow-only copy (soft shadows): each plant's low hull (the 'simple' crowns' geometry, solid, no texture),
    // drawn into the shadow map only - in the view its vertices leave the clip box
    proxyMat = new T.MeshBasicMaterial({ side: T.DoubleSide, colorWrite: false, depthWrite: false });
    proxyMat.onBeforeCompile = function (sh) { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n gl_Position = vec4(0.0, 0.0, 2.0, 1.0);'); };
    proxyMat.customProgramCacheKey = function () { return 'shadow-proxy'; };
  }
  var proxyMat = null;
  function applyShadowCasters() {
    var proxy = SH_Q[SHQ].proxy;
    treeRecs.forEach(function (r) {
      if (!r) return; var p = !!(proxy && r.proxy);
      r.meshes.forEach(function (m) { m.castShadow = !p; });
      // the copy costs its vertices in the view pass too: present only while it casts
      if (r.proxy) { r.proxy.castShadow = p; r.proxy.visible = p && shadowsOn && !(r.group.outside && outsideMode === 2); }
    });
    // soft: the ground receives but does not cast (627 k triangles of the shadow pass on Prokhorovka; with the sun at
    // 46 deg only slopes steeper than that would shade themselves, and the relief light already darkens them)
    terrainMeshes.forEach(function (m) { m.castShadow = !proxy; });
    shadowDirty();
  }
  // the shadow copy's geometry: the hull profile at 4 heights x 6 directions plus a top point (~42 triangles)
  function lowHull(k) {
    var R = k.ys.length, S = k.r[0].length, rows = [0, Math.round((R - 1) / 3), Math.round(2 * (R - 1) / 3), R - 1], pos = [], idx = [], N = 6;
    rows.forEach(function (i) {
      for (var s = 0; s < N; s++) {
        var si = Math.floor((s + 0.5) / N * S), ang = (si + 0.5) / S * Math.PI * 2, r = Math.max(0.05, k.r[i][si]);
        pos.push(Math.cos(ang) * r, k.ys[i], Math.sin(ang) * r);
      }
    });
    for (var i = 0; i < 3; i++) for (var s = 0; s < N; s++) {
      var a = i * N + s, b = i * N + (s + 1) % N; idx.push(a, a + N, b, b, a + N, b + N);
    }
    var top = pos.length / 3; pos.push(0, k.hi[1], 0);
    for (s = 0; s < N; s++) idx.push(3 * N + s, top, 3 * N + (s + 1) % N);
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    return g;
  }
  function syncProxy(r) {
    if (!r.proxy) return;
    for (var k = 0; k < r.cur.length; k++) r.proxy.setMatrixAt(k, r.cur[k]);
    r.proxy.count = r.cur.length; r.proxy.instanceMatrix.needsUpdate = true;
  }
  function impostorGeometry(k, i, cols, rows, R, y0, y1) {
    // tile rectangles in 0..1 (render target row 0 = bottom: v up)
    function tile(t) { var x = (t % cols) / cols, y = Math.floor(t / cols) / rows; return [x, y, 1 / cols, 1 / rows]; }
    var s = tile(i * 2), tp = tile(i * 2 + 1), pos = [], uv = [], nrm = [], idx = [];
    function quad(a, b, c, d, r, n) { // corners bottom-left, bottom-right, top-right, top-left
      var o = pos.length / 3;
      [a, b, c, d].forEach(function (p) { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); });
      uv.push(r[0], r[1], r[0] + r[2], r[1], r[0] + r[2], r[1] + r[3], r[0], r[1] + r[3]);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    var up = [0, 1, 0];
    quad([-R, y0, 0], [R, y0, 0], [R, y1, 0], [-R, y1, 0], s, up);
    quad([0, y0, R], [0, y0, -R], [0, y1, -R], [0, y1, R], s, up);
    var ym = y0 + (y1 - y0) * 0.62;
    quad([-R, ym, R], [R, ym, R], [R, ym, -R], [-R, ym, -R], tp, up);
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeBoundingSphere();
    return g;
  }
  function addPlantMesh(r, geo, mat, depth, far) {
    var g = r.group, im = new T.InstancedMesh(geo, mat, g.n);
    if (depth) im.customDepthMaterial = depth;
    im.count = 0; im.frustumCulled = false; im.name = r.kind.name + ' ' + g.cls + (far ? ' far' : '');
    im.castShadow = true; im.receiveShadow = true; im.userData.outside = g.outside; im.userData.far = far;
    (g.cls === 'tree' ? layers.trees : layers.bushes).add(im);
    r.meshes.push(im);
    return im;
  }
  function makeGroupMeshes(gi) {
    var r = treeRecs[gi], kp = kindParts[r.ki], g = r.group;
    r.meshes.forEach(function (m) { m.parent && m.parent.remove(m); });
    r.meshes = [];
    var parts;
    if (crownMode === 'hull') {
      if (!kp.hull) kp.hull = hullGeometry(kp.k);
      hullMat = hullMat || withFade(new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }), false, 2);
      parts = [{ geo: kp.hull, mat: hullMat, depth: null }];
    } else parts = kp.lod;
    parts.forEach(function (p) { addPlantMesh(r, p.geo, p.mat, p.depth, false); });
    if (crownMode === 'lod' && kp.imp) addPlantMesh(r, kp.imp, impostorMat, impostorDepth, true);
    if (r.proxy && r.proxy.parent) r.proxy.parent.remove(r.proxy);
    r.proxy = null;
    if (proxyMat) {
      if (!kp.low) kp.low = lowHull(kp.k);
      var pm = r.proxy = new T.InstancedMesh(kp.low, proxyMat, g.n);
      pm.frustumCulled = false; pm.name = r.kind.name + ' ' + g.cls + ' shadow';
      (g.cls === 'tree' ? layers.trees : layers.bushes).add(pm);
      syncProxy(r);
    }
    r.dirty = true;
  }
  // near / far split of every group by the distance from the camera (game coordinates), redone when the camera moves
  // more than 4 m or a plant moved (falls, bushes switched off)
  var lastSplit = new T.Vector3(1e9, 0, 0), camGame = new T.Vector3(), tmpV = new T.Vector3();
  function splitPlants(force) {
    camGame.set(camera.position.x, camera.position.y, -camera.position.z);
    var moved = force || camGame.distanceTo(lastSplit) > 4;
    if (moved) { lastSplit.copy(camGame); if (!SH_Q[SHQ].proxy) renderer.shadowMap.needsUpdate = true; }  // sharp: LOD / card casters swap
    var far2 = FAR * FAR;
    treeRecs.forEach(function (r) {
      if (!r || !(moved || r.dirty)) return;
      if (r.dirty) { syncProxy(r); renderer.shadowMap.needsUpdate = true; }  // a plant fell / was hidden: casters changed
      r.dirty = false;
      var near = r.meshes.filter(function (m) { return !m.userData.far; }), farM = r.meshes.filter(function (m) { return m.userData.far; })[0];
      var nn = 0, nf = 0;
      for (var k = 0; k < r.cur.length; k++) {
        var m = r.cur[k]; tmpV.setFromMatrixPosition(m);
        if (!farM || tmpV.distanceToSquared(camGame) < far2) { for (var q = 0; q < near.length; q++) near[q].setMatrixAt(nn, m); nn++; }
        else { farM.setMatrixAt(nf, m); nf++; }
      }
      near.forEach(function (im) { im.count = nn; im.instanceMatrix.needsUpdate = true; });
      if (farM) { farM.count = nf; farM.instanceMatrix.needsUpdate = true; }
    });
  }
  function setCrowns(mode) {
    FAR = mode === 'lodall' ? 1e6 : 160;
    crownMode = mode === 'lodall' ? 'lod' : mode; info.treeTris = 0;
    treeRecs.forEach(function (r, gi) { makeGroupMeshes(gi); });
    resetDestruction(); dTime = -1e9; applyOutside(); splitPlants(true);
  }
  var outsideMode = 1;
  function applyOutside() {
    outsideU.value = outsideMode;
    if (groundUniforms) groundUniforms.uOutside.value = outsideMode;
    treeRecs.forEach(function (r) {
      r.meshes.forEach(function (m) {
        if (!r.group.outside) return;
        m.visible = outsideMode !== 2;
        if (!m.userData.dimMat) { m.userData.dimMat = m.material.clone(); m.userData.dimMat.color = new T.Color(0x7a7a7a);
          m.userData.dimMat.onBeforeCompile = m.material.onBeforeCompile; m.userData.dimMat.customProgramCacheKey = function () { return 'fade-dim-' + m.userData.dimMat.uuid; };
          m.userData.baseMat = m.material; }
        m.material = outsideMode === 1 ? m.userData.dimMat : m.userData.baseMat;
      });
    });
    applyShadowCasters();
  }
  function setTreeMatrix(r, k, m) { r.cur[k] = m === r.base[k] ? m : m.clone(); r.dirty = true; }

  function buildWater(water) {
    var mat = new T.MeshLambertMaterial({ color: 0x3a6f9a, transparent: true, opacity: 0.78, side: T.DoubleSide });
    water.forEach(function (w) {
      var g = new T.PlaneGeometry(w.x1 - w.x0, w.z1 - w.z0); g.rotateX(-Math.PI / 2);
      var m = new T.Mesh(g, mat); m.position.set((w.x0 + w.x1) / 2, w.y, (w.z0 + w.z1) / 2); m.receiveShadow = true; layers.water.add(m);
    });
  }

  // ------------------------------------------------------------------ destruction over the battle
  var dEvents = [], dApplied = 0, dTime = -1e9, falling = [], FALL = 1.6;
  var tmpM = new T.Matrix4(), tmpR = new T.Matrix4(), tmpA = new T.Vector3(), tmpP = new T.Vector3();
  function fallMatrix(base, yaw, angle, out) {
    // rotate about the foot (the placement's origin), towards yaw (atan2(x, z) in game coordinates)
    tmpP.setFromMatrixPosition(base);
    tmpA.set(Math.cos(yaw), 0, -Math.sin(yaw)); // up x dir, dir = (sin yaw, 0, cos yaw)
    tmpR.makeRotationAxis(tmpA, angle);
    out.makeTranslation(-tmpP.x, -tmpP.y, -tmpP.z).premultiply(tmpR).premultiply(tmpM.makeTranslation(tmpP.x, tmpP.y, tmpP.z));
    return out.multiply(base);
  }
  function resetDestruction() {
    objRecs.concat(visRecs).forEach(function (e) {
      if (!e) return;
      e.dead.fill(0);
      if (!e.mesh) return;
      e.mesh.geometry.attributes.iDead.needsUpdate = true;
      for (var k = 0; k < e.base.length; k++) e.mesh.setMatrixAt(k, e.base[k]);
      e.mesh.instanceMatrix.needsUpdate = true;
    });
    treeRecs.forEach(function (r) {
      if (!r) return;
      for (var k = 0; k < r.base.length; k++) setTreeMatrix(r, k, r.base[k]);
    });
    dApplied = 0; falling = [];
  }
  var HIDDEN = new T.Matrix4().makeScale(0, 0, 0);
  function poseFall(ev, t) {
    var f = ev[1] ? 1 : Math.min(1, Math.max(0, (t - ev[0]) / FALL)), ang = Math.PI / 2 * 0.97 * f * f;
    var target = ev[2] === 2 ? objRecs[ev[3]] : treeRecs[ev[3]];
    if (!target) return;
    var fm = fallMatrix(target.base[ev[4]], ev[5], ang, new T.Matrix4());
    if (ev[2] === 2) {
      var vo = visOf(ev[3], ev[4]);
      if (vo) { vo.r.mesh.setMatrixAt(vo.k, fallMatrix(vo.r.base[vo.k], ev[5], ang, new T.Matrix4())); vo.r.mesh.instanceMatrix.needsUpdate = true; }
      if (!target.mesh) return; target.mesh.setMatrixAt(ev[4], fm); target.mesh.instanceMatrix.needsUpdate = true;
    }
    else setTreeMatrix(target, ev[4], fm);
    return f >= 1;
  }
  function stepDestruction(t) {
    if (t < dTime) resetDestruction();
    dTime = t;
    while (dApplied < dEvents.length && dEvents[dApplied][0] <= t) {
      var ev = dEvents[dApplied++], type = ev[2];
      if (type === 0 || type === 1) {
        var e = objRecs[ev[3]];
        var bit = type === 1 ? 23 : ev[5];
        if (e) {
          e.dead[ev[4]] = (e.dead[ev[4]] | (1 << bit)) >>> 0;
          if (e.mesh) e.mesh.geometry.attributes.iDead.needsUpdate = true;
        }
        var vo = visOf(ev[3], ev[4]);
        if (vo) { vo.r.dead[vo.k] = (vo.r.dead[vo.k] | (1 << bit)) >>> 0; vo.r.mesh.geometry.attributes.iDead.needsUpdate = true; }
      } else if (type === 2 || type === 3) {
        if (!poseFall(ev, t)) falling.push(ev);
      } else if (type === 4) {
        var r = treeRecs[ev[3]];
        if (r) setTreeMatrix(r, ev[4], HIDDEN);
      }
    }
    falling = falling.filter(function (ev) { return !poseFall(ev, t); });
  }

  // ------------------------------------------------------------------ round 5f: destruction list and flash
  // The list names every change the battle file records (repeats of an already applied item left out); a click seeks
  // to just before it and moves the camera there. While an event is fresh (FLASH_S after its time) a box outline marks
  // its object, drawn over everything, so a change under a vehicle's hull is seen.
  var FLASH_S = 1.2, flashOn = true, dRows = [], flashBoxes = [], flashGeo = null, flashMat = null;
  function destrKind(ev) {
    var tp = ev[2];
    if (tp === 3) return 'tree';
    if (tp === 4) return 'bush';
    if (tp === 2) return 'lamp post';
    if (tp === 0) return 'house part';
    var r = mapData.objects[ev[3]], n = r ? r.name.toLowerCase() : '';
    return /fence|gaf|wall|gate|hedge/.test(n) ? 'fence-like' : 'fragile';
  }
  function destrName(ev) {
    if (ev[2] >= 3) { var tr = treeRecs[ev[3]]; return tr ? tr.kind.name : 'plant'; }
    var r = mapData.objects[ev[3]]; if (!r) return '?';
    return r.name.replace(/^hd_/, '') + (ev[2] === 0 ? ' (module ' + (ev[5] + 1) + ')' : '');
  }
  // the event's object: placement matrix and its local box (visual model's, else the tree kind's, else 3 m)
  function destrBox(ev) {
    var base, lo, hi;
    if (ev[2] >= 3) {
      var tr = treeRecs[ev[3]]; if (!tr) return null; base = tr.base[ev[4]];
      var k = tr.kind; lo = k.lo || [-1.5, 0, -1.5]; hi = k.hi || [1.5, 6, 1.5];
    } else {
      var vo = visOf(ev[3], ev[4]), e = objRecs[ev[3]];
      if (vo) { base = vo.r.base[vo.k]; lo = vo.r.rec.pmin; hi = vo.r.rec.pmin.map(function (v, i) { return v + vo.r.rec.prange[i]; }); }
      else if (e) { base = e.base[ev[4]]; lo = [-1.5, 0, -1.5]; hi = [1.5, 3, 1.5]; }
      else return null;
    }
    return { base: base, lo: lo, hi: hi };
  }
  function destrAt(ev) { var b = destrBox(ev); return b ? new T.Vector3().setFromMatrixPosition(b.base) : null; }
  function buildDestrList() {
    var seen = {}, box = $('destr-rows'); if (!box) return;
    box.innerHTML = ''; dRows = [];
    dEvents.forEach(function (ev) {
      var key = ev[2] + ':' + ev[3] + ':' + ev[4] + ':' + (ev[2] === 0 ? ev[5] : '');
      if (seen[key]) return; seen[key] = 1;
      var el = document.createElement('div'); el.className = 'drow' + (ev[1] ? ' init' : '');
      var kind = destrKind(ev), name = destrName(ev);
      var when = ev[1] ? (ev[0] <= 0.01 ? 'start' : fmt(ev[0] - tBattle)) : fmt(ev[0] - tBattle);
      el.innerHTML = '<span class="dt"></span><span class="dk"></span><span class="dn"></span>';
      el.children[0].textContent = when; el.children[1].textContent = kind; el.children[2].textContent = name;
      el.title = name + '\n' + (ev[1] ? (ev[0] <= 0.01 ? 'Already broken when the replay starts (ruins by design, or broken before the recording).'
        : 'Found broken when this area came into the recorder\'s view; when it broke is not known.') : 'Broken at ' + fmt(ev[0] - tBattle) + ' battle time.') +
        '\n- click: go to 2 s before it and look at it';
      el.onclick = function () {
        t = Math.max(0, ev[0] - 2);
        var p = destrAt(ev); if (!p) return;
        setFollow(null); cam.tx = p.x; cam.tz = p.z; cam.ty = heightAt(p.x, p.z) + 1; cam.tyGoal = null;
        cam.dist = ev[2] === 0 ? 30 : 18; cam.pitch = Math.max(cam.pitch, 0.45);
      };
      box.appendChild(el); dRows.push({ ev: ev, el: el });
    });
    $('destr-n').textContent = dRows.length;
  }
  function tickDestrList() {
    dRows.forEach(function (r) {
      var ev = r.ev, done = ev[0] <= t, fresh = done && t < ev[0] + FLASH_S;
      var c = 'drow' + (ev[1] ? ' init' : '') + (done ? ' done' : '') + (fresh ? ' fresh' : '');
      if (r.el.className !== c) r.el.className = c;
    });
  }
  function stepFlash(time) {
    if (!flashGeo) {
      flashGeo = new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1));
      flashMat = new T.LineBasicMaterial({ color: 0xffe14a, depthTest: false, transparent: true });
    }
    var n = 0;
    if (flashOn) for (var i = 0; i < dRows.length; i++) {
      var ev = dRows[i].ev; if (ev[0] > time || time >= ev[0] + FLASH_S || (ev[1] && ev[0] <= 0.01)) continue;
      var b = dRows[i].box || (dRows[i].box = destrBox(ev) || 0); if (!b) continue;
      var L = flashBoxes[n];
      if (!L) { L = new T.LineSegments(flashGeo, flashMat.clone()); L.renderOrder = 999; L.matrixAutoUpdate = false; root.add(L); flashBoxes[n] = L; }  // root: game coordinates (z mirrored)
      var pad = 0.3, s = [b.hi[0] - b.lo[0] + pad, b.hi[1] - b.lo[1] + pad, b.hi[2] - b.lo[2] + pad];
      L.matrix.copy(b.base).multiply(tmpM.makeTranslation((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2))
        .multiply(tmpR.makeScale(s[0], s[1], s[2]));
      L.material.opacity = 0.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, (time - ev[0]) / FLASH_S)));  // one soft pulse per event
      L.matrixWorldNeedsUpdate = true; L.visible = true; n++;
    }
    for (var j = n; j < flashBoxes.length; j++) flashBoxes[j].visible = false;
  }
  // ------------------------------------------------------------------ mode objects
  var TEAM_COLOR = { own: 0xe0b44a, ally: 0x58b04a, enemy: 0xc8463c, dead: 0x3a3a3a };
  // vehicle marker (round 7; round 10: subdued, the user: the markers outshone the vehicles): MARKER_W x MARKER_H screen px
  // at a 720 px tall view (the size follows the view's height, as before), drawn MARKER_PX times finer; MARKER_K turns px
  // into the sprite's scale for the 55 degree camera. Its bottom edge sits MARKER_GAP m above the model's top and
  // MARKER_LIFT px higher on screen, so a look from above does not lay it over the vehicle either.
  var MARKER_W = 104, MARKER_H = 20, MARKER_PX = 3, MARKER_K = 2 * Math.tan(55 / 2 * Math.PI / 180) / 720, MARKER_GAP = 2.5, MARKER_LIFT = 8;
  var MARKER_COL = { own: { name: '#d8c78f', bar: 'rgba(200,168,84,.75)' }, ally: { name: '#b2cfa4', bar: 'rgba(104,160,84,.75)' }, enemy: { name: '#e2aa9f', bar: 'rgba(190,92,78,.75)' } };
  function drawMarker(r, hp) {
    var c = r.canvas, ctx = c.getContext('2d'), k = MARKER_PX, W = MARKER_W * k, col = MARKER_COL[r.role] || MARKER_COL.ally;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    function fit(text, width) { while (text.length > 3 && ctx.measureText(text).width > width) text = text.slice(0, -2) + '…'; return text; }
    function line(text, y, color) { ctx.lineWidth = k; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.strokeText(text, W / 2, y); ctx.fillStyle = color; ctx.fillText(text, W / 2, y); }
    // the player's nickname on top (when the battle file names him), small and dim
    ctx.font = (7 * k) + 'px system-ui,Segoe UI,Arial,sans-serif';
    if (r.v.player) line(fit(String(r.v.player), W - 4 * k), 4 * k, 'rgba(225,228,232,.72)');
    // the vehicle's short name and its HP, in the team's colour
    var veh = r.md.name || r.v.type.split(':')[1] || '', txt = String(Math.max(0, Math.round(hp)));
    ctx.font = '600 ' + (7.5 * k) + 'px system-ui,Segoe UI,Arial,sans-serif';
    line(fit(veh, W - 4 * k - ctx.measureText('  ' + txt).width) + '  ' + txt, 11.5 * k, col.name);
    // a thin HP bar under them
    var bw = 52 * k, bh = 2.5 * k, bx = (W - bw) / 2, by = 16 * k, f = Math.max(0, Math.min(1, hp / (r.v.maxHealth || 1)));
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = col.bar; ctx.fillRect(bx, by, bw * f, bh);
  }
  function buildMode(mode, ownTeam) {
    function teamColor(team) { return team === ownTeam ? TEAM_COLOR.ally : (team ? TEAM_COLOR.enemy : 0xe8e8e8); }
    function flag(x, y, z, color, label) {
      var g = new T.Group(); g.position.set(x, y, z);
      var pole = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, 16, 8), new T.MeshLambertMaterial({ color: 0xdddddd }));
      pole.position.y = 8; pole.castShadow = true; g.add(pole);
      var fl = new T.Mesh(new T.PlaneGeometry(6, 3.6), new T.MeshLambertMaterial({ color: color, side: T.DoubleSide }));
      fl.position.set(3, 14, 0); fl.castShadow = true; g.add(fl);
      var disc = new T.Mesh(new T.RingGeometry(3.5, 5, 32), new T.MeshBasicMaterial({ color: color, side: T.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.4; g.add(disc);
      g.userData.label = label;
      layers.mode.add(g);
    }
    mode.bases.forEach(function (b) { flag(b.x, b.y, b.z, teamColor(b.team), 'base team ' + b.team); });
    if (mode.controlPoint) flag(mode.controlPoint.x, mode.controlPoint.y, mode.controlPoint.z, 0xf2f2f2, 'control point');
    var tri = new T.ConeGeometry(1.6, 0.6, 3); tri.rotateX(Math.PI / 2);
    mode.spawns.forEach(function (s) {
      var big = s.kind === 'arena_defs';
      var m = new T.Mesh(big ? new T.CylinderGeometry(9, 9, 0.4, 24, 1, true) : tri,
        new T.MeshBasicMaterial({ color: teamColor(s.team), transparent: true, opacity: big ? 0.55 : 0.9, side: T.DoubleSide, depthWrite: false }));
      m.position.set(s.x, s.y + 0.5, s.z); if (!big && s.yaw != null) m.rotation.y = s.yaw;
      layers.mode.add(m);
    });
    // 19.11: the base / control point circles of this gameplay from the map's own file (space.bin WTCP: centre, radius,
    // team - build.wtcp_circles, mapbuild circles): a ring of that radius on the ground in the team's colour, neutral
    // for a control point (team 0); a map with no record for its mode keeps the centre flags alone
    var rings = mode.circles || [];
    rings.forEach(function (c) {
      groundRing(c.x, c.z, c.radius - RING_WIDTH, c.radius, teamColor(c.team)).userData = { circle: true, team: c.team, radius: c.radius };
    });
    $('capture-info').textContent = rings.length ? 'capture circle: ' + rings.map(function (c) { return c.radius.toFixed(0); }).join(', ') + ' m (from the map file)' :
      'no capture circle for this map and mode in the game files - centre flag only';
  }
  var RING_WIDTH = 1.0;  // m, inward from the radius (the game's ring is a thin textured annulus; its width on screen not measured)
  function drawnCircles() {  // the rings drawn (for the checks): team and radius of each
    return layers.mode.children.filter(function (m) { return m.userData && m.userData.circle; }).map(function (m) { return { team: m.userData.team, radius: m.userData.radius }; });
  }
  function groundRing(x, z, r0, r1, color) {
    var N = 256, pos = [], idx = [];
    r1 = Math.max(r1, r0 + 0.8);
    for (var i = 0; i <= N; i++) {
      var a = i / N * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      [r0, r1].forEach(function (r) { var px = x + c * r, pz = z + s * r; pos.push(px, (heightAt ? heightAt(px, pz) : 0) + 0.35, pz); });
      if (i < N) { var k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    var m = new T.Mesh(g, new T.MeshBasicMaterial({ color: color, side: T.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4 }));
    layers.mode.add(m);
    return m;
  }

  // ------------------------------------------------------------------ round 13: vehicles drawn as Bullba Hits draws them
  // What makes Hits' parts view read well (outputs/render-compare-2026-11-19.md §3), without its heat map and without its
  // camera-side light (the user, 19.11: a vehicle sits in the map's light like everything else - the scene's sun, sky
  // and shadows, as before round 13): flat faces with Hits' own visual normals (BullbaScreenArmor.visualNormals:
  // smoothed only inside one group and below 35 degrees, so plates stay plates), one grey-blue tone per part (viewer.js
  // baseColors / partColor: chassis, hull, turret, gun), and Hits' 1 px dark seams (.05,.07,.09 at 60 %) where one
  // collision group meets another or a face has no neighbour - drawn in the same pass from a per-corner edge attribute,
  // no extra draw. Unlike Hits the outer layer (tracks, wheels, spaced screens: viewer.js externalLayer) is opaque, a
  // greyer, darker shade of its part.
  // The team: the markers and the rows tell it, as in the game; the "team tint" slider mixes the model toward its team
  // colour (0 the neutral Hits look, the default; 1 the team colour of before), and the halo takes the model's colour
  // (hitsHaloColor), so it is neutral when the model is. Destroyed: grey and dark, the part tones still apart.
  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  // viewer.js baseColors, the same sRGB figures made linear the same way (viewer.js linear); not exported by viewer.js
  var HITS_PART = [[.38, .46, .54], [.65, .73, .8], [.75, .83, .87], [.55, .65, .72]].map(function (c) { return c.map(srgbToLinear); });
  // round 14 (the user in the game, 19.11: light blue and too bright, unnatural for a tank): Hits' tones are a light
  // grey-blue (sRGB blue 0.15 above red, hull 0.73 bright) made for Hits' dark background and camera-side light; under the
  // map's sun and sky they come out pale blue. Now the model's colour is a chosen base (a preset, sRGB, mid luminance,
  // low saturation) times a brightness; Hits' part tones stay as each part's brightness against the hull's (chassis
  // darker, turret lighter, gun between), the outer layer greyer and darker, the groups a shade apart and the seams.
  var VEHICLE_COLORS = { steel: [0.45, 0.46, 0.47], khaki: [0.42, 0.39, 0.26], green: [0.29, 0.34, 0.21], panzer: [0.29, 0.31, 0.33] };
  // The game's own base paint of each nation (19.11): scripts/item_defs/customization/default.xml, the first colour of
  // the nation's list - what every tech-tree vehicle wears (outputs/nation-paint-colours-2026-11-19.md); sRGB.
  var NATION_COLORS = { ussr: [0.298, 0.298, 0.235], germany: [0.353, 0.353, 0.353], usa: [0.412, 0.384, 0.302],
    china: [0.239, 0.322, 0.247], france: [0.200, 0.286, 0.294], uk: [0.459, 0.439, 0.365], japan: [0.255, 0.302, 0.220],
    czech: [0.318, 0.290, 0.235], sweden: [0.243, 0.267, 0.212], poland: [0.310, 0.286, 0.204], italy: [0.502, 0.443, 0.325] };
  var LUM = function (c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  var HITS_TONE = HITS_PART.map(function (c) { return LUM(c) / LUM(HITS_PART[1]); });
  var hitsTintU = { value: 0 }, hitsBaseU = { value: new T.Vector3() }, HITS_SEAM = [0.05, 0.07, 0.09, 0.6];
  function setVehicleColor() {
    var sel = $('sel-vcolor').value, key = VEHICLE_COLORS[sel] ? sel : 'steel', c = VEHICLE_COLORS[key], k = +$('rng-vbright').value;
    hitsBaseU.value.set(srgbToLinear(c[0]) * k, srgbToLinear(c[1]) * k, srgbToLinear(c[2]) * k);
    // each vehicle's own base: the preset, or with 'nation' its nation's paint (a nation not in the table: the grey)
    vehicles.forEach(function (r) {
      var n = sel === 'nation' ? NATION_COLORS[String(r.v.type).split(':')[0]] : null, b = r.mat.userData.u.uBase.value;
      if (n) b.set(srgbToLinear(n[0]) * k, srgbToLinear(n[1]) * k, srgbToLinear(n[2]) * k); else b.copy(hitsBaseU.value);
    });
    $('vbright-v').textContent = k.toFixed(2);
    if (typeof poseHalo === 'function' && vehicles.length) poseHalo();
  }
  // the halo's colour of a vehicle: its hull tone mixed toward its team colour as the model is
  function hitsHaloColor(r, out) {
    var c = r.mat.userData.u.uTeam.value, h = r.mat.userData.u.uBase.value, k = hitsTintU.value;
    return out.set(h.x + (c.r - h.x) * k, h.y + (c.g - h.y) * k, h.z + (c.b - h.z) * k);
  }
  function setTeamTint(k) {
    if (k != null) $('rng-tint').value = k;
    hitsTintU.value = +$('rng-tint').value; $('tint-v').textContent = hitsTintU.value.toFixed(2);
    if (typeof poseHalo === 'function' && vehicles.length) poseHalo();
  }
  // P positions (xyz per vertex), I indices, G group per vertex and gt [part id, outer] per group (build.py geo), or
  // none (an older file, a box): every face then the part `part`
  function hitsGeometry(P, I, G, gt, part) {
    var nf = I.length / 3, pos = new Float32Array(nf * 9), nor = new Float32Array(nf * 9), ids = new Float32Array(nf * 3);
    var col = new Float32Array(nf * 9), seam = new Float32Array(nf * 9), fg = new Int32Array(nf), f, k, j;
    var ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, l;
    for (f = 0; f < nf; f++) {
      var a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2], o = f * 9;
      pos[o] = P[a * 3]; pos[o + 1] = P[a * 3 + 1]; pos[o + 2] = P[a * 3 + 2];
      pos[o + 3] = P[b * 3]; pos[o + 4] = P[b * 3 + 1]; pos[o + 5] = P[b * 3 + 2];
      pos[o + 6] = P[c * 3]; pos[o + 7] = P[c * 3 + 1]; pos[o + 8] = P[c * 3 + 2];
      ax = pos[o + 3] - pos[o]; ay = pos[o + 4] - pos[o + 1]; az = pos[o + 5] - pos[o + 2];
      bx = pos[o + 6] - pos[o]; by = pos[o + 7] - pos[o + 1]; bz = pos[o + 8] - pos[o + 2];
      nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx; l = Math.hypot(nx, ny, nz) || 1;
      for (k = 0; k < 3; k++) { nor[o + k * 3] = nx / l; nor[o + k * 3 + 1] = ny / l; nor[o + k * 3 + 2] = nz / l; }
      fg[f] = G ? G[a] : 0; ids[f * 3] = ids[f * 3 + 1] = ids[f * 3 + 2] = fg[f];
    }
    var SA = window.BullbaScreenArmor, vis = SA && SA.visualNormals ? SA.visualNormals(pos, nor, ids) : nor;
    // the seams: corners welded across groups (1 mm); an edge is a seam when its faces are not all of one group, or it
    // has one face only. Per corner a vec3: component k is the corner's barycentric k plus 0 when the edge opposite
    // corner k is a seam, plus 10 when it is not - the fragment's distance to the nearest seam edge in pixels is then
    // min(v / fwidth(v)).
    var weld = new Map(), vid = new Int32Array(nf * 3), nv = 0, edges = new Map();
    for (k = 0; k < nf * 3; k++) {
      var key = Math.round(pos[k * 3] * 1000) + ',' + Math.round(pos[k * 3 + 1] * 1000) + ',' + Math.round(pos[k * 3 + 2] * 1000);
      var w = weld.get(key); if (w === undefined) { w = nv++; weld.set(key, w); } vid[k] = w;
    }
    weld.clear();
    function ekey(p, q) { return p < q ? p * nv + q : q * nv + p; }
    for (f = 0; f < nf; f++) for (k = 0; k < 3; k++) {
      var e = ekey(vid[f * 3 + (k + 1) % 3], vid[f * 3 + (k + 2) % 3]), rec = edges.get(e);
      if (!rec) edges.set(e, { n: 1, g: fg[f], mixed: false }); else { rec.n++; if (rec.g !== fg[f]) rec.mixed = true; }
    }
    for (f = 0; f < nf; f++) {
      var off = [0, 0, 0];
      for (k = 0; k < 3; k++) { var r = edges.get(ekey(vid[f * 3 + (k + 1) % 3], vid[f * 3 + (k + 2) % 3])); off[k] = r.n === 1 || r.mixed ? 0 : 10; }
      // round 14: the colour attribute is (part tone x group shade, outer layer 0/1, 0); the base colour is the shader's
      var info = gt && gt[fg[f]], pid = info ? info[0] : part, outer = info && info[1] ? 1 : 0;
      var h = Math.sin((fg[f] + 1) * 12.9898) * 43758.5453, jit = 1 + 0.035 * (2 * (h - Math.floor(h)) - 1);  // groups a shade apart
      var cc = [HITS_TONE[pid > 0 ? pid % 4 : 0] * jit, outer, 0];  // viewer.js partColor: track pairs (4) and wheels (-1) take the chassis'
      for (k = 0; k < 3; k++) for (j = 0; j < 3; j++) {
        col[f * 9 + k * 3 + j] = cc[j];
        seam[f * 9 + k * 3 + j] = (j === k ? 1 : 0) + off[j];
      }
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(vis, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setAttribute('aSeam', new T.BufferAttribute(seam, 3));
    g.userData.groupTable = !!gt;
    g.computeBoundingSphere();
    return g;
  }
  function vehicleGeometry(m, part) { return hitsGeometry(m.vmin ? deq(m.v, m.vmin, m.vrange) : f32(m.v), m.i32 ? u32(m.i) : u16(m.i), m.gv ? u16(m.gv) : null, m.gt || null, part); }
  // one material per vehicle (its team and its death are its own uniforms), one program for all
  function hitsMaterial(team) {
    var mat = new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide });
    var u = mat.userData.u = { uTeam: { value: new T.Color(team) }, uTint: hitsTintU, uBase: { value: hitsBaseU.value.clone() }, uDead: { value: 0 } };
    mat.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'attribute vec3 aSeam;\nvarying vec3 vSeam;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vSeam = aSeam;');
      // the colour only (base x part tone, outer layer, tint, death, seams); the scene's lights and shadows then light it as any other object
      sh.fragmentShader = 'uniform vec3 uTeam;\nuniform float uTint;\nuniform vec3 uBase;\nuniform float uDead;\nvarying vec3 vSeam;\n' + sh.fragmentShader.replace(
        '#include <color_fragment>', ['#include <color_fragment>',
          'vec3 hc = uBase * diffuseColor.r;',
          'float hl = dot(hc, vec3(0.2126, 0.7152, 0.0722));',
          'if (diffuseColor.g > 0.5) { hc = mix(hc, vec3(hl), 0.55) * 0.78; hl *= 0.78; }',  // the outer layer: greyer and darker than its part
          'hc = mix(hc, uTeam, uTint);',
          'hc = mix(hc, vec3(diffuseColor.r * (diffuseColor.g > 0.5 ? 0.78 : 1.0) * 0.083), uDead);',  // destroyed: as dark a grey as before round 14, whatever the base
          'vec3 hd = vSeam / max(fwidth(vSeam), vec3(1e-6));',
          'float hk = 1.0 - smoothstep(0.35, 1.0, min(min(hd.x, hd.y), hd.z));',
          'diffuseColor.rgb = mix(hc, vec3(' + HITS_SEAM.slice(0, 3).join(', ') + '), ' + HITS_SEAM[3] + ' * hk);'].join('\n '));
    };
    mat.customProgramCacheKey = function () { return 'hits-vehicle14'; };
    return mat;
  }

  // ------------------------------------------------------------------ battle, vehicles
  var battle, vehicles = [], shots = [], tEnd = 0, tBattle = 0;
  function buildVehicles(b, models) {
    var own = b.vehicles.filter(function (v) { return v.own; })[0];
    var ownTeam = own ? own.team : 1;
    var geos = {};
    var box0 = new T.BoxGeometry(3.4, 2.2, 7); box0.translate(0, 1.1, 0);
    var box = hitsGeometry(box0.attributes.position.array, box0.index.array, null, null, 1);
    b.vehicles.forEach(function (v) {
      var md = models[v.type] || { model: false };
      var role = v.own ? 'own' : (v.team === ownTeam ? 'ally' : 'enemy');
      var mat = hitsMaterial(TEAM_COLOR[role]);
      var g = new T.Group(), turret = null, gun = null;
      function add(parent, geo) { var m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); }
      if (md.model) {
        var gg = geos[v.type] || (geos[v.type] = { hull: vehicleGeometry(md.hull, 1), turret: vehicleGeometry(md.turret, 2), gun: vehicleGeometry(md.gun, 3) });
        add(g, gg.hull);
        turret = new T.Group(); turret.position.fromArray(md.turretAt); add(turret, gg.turret); g.add(turret);
        gun = new T.Group(); gun.position.fromArray(md.gunAt); add(gun, gg.gun); turret.add(gun);
      } else {
        add(g, box);
      }
      // round 7: the marker over the vehicle, a constant size on screen (sizeAttenuation off); round 10: the nickname, the
      // vehicle's name with its HP, a thin bar, half transparent; its bottom edge MARKER_GAP m above the model's top and
      // MARKER_LIFT px higher on screen (the sprite's centre below its own bottom edge)
      var canvas = document.createElement('canvas'); canvas.width = MARKER_W * MARKER_PX; canvas.height = MARKER_H * MARKER_PX;
      var tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace;
      var bar = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true, opacity: 0.78 }));
      bar.scale.set(MARKER_W * MARKER_K, MARKER_H * MARKER_K, 1); bar.center.set(0.5, -MARKER_LIFT / MARKER_H); bar.renderOrder = 10; g.add(bar);
      layers.vehicles.add(g);
      // round 5d: the hull's footprint for the halo (its model's bounds in the vehicle's frame: x right, z forward)
      var hg = md.model ? geos[v.type].hull : box; if (!hg.boundingBox) hg.computeBoundingBox();
      var bb = hg.boundingBox, top = bb.max.y;
      if (md.model) { var tg = geos[v.type].turret; if (!tg.boundingBox) tg.computeBoundingBox(); top = Math.max(top, md.turretAt[1] + tg.boundingBox.max.y); }
      bar.position.set(0, top + MARKER_GAP, 0);
      var foot ={ cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, hx: (bb.max.x - bb.min.x) / 2, hz: (bb.max.z - bb.min.z) / 2 };
      (function () { var P = hg.attributes.position, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, yl = bb.min.y + 0.15;
        for (var q = 0; q < P.count; q++) if (P.getY(q) < yl) { var X = P.getX(q), Z = P.getZ(q); if (X < x0) x0 = X; if (X > x1) x1 = X; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z; }
        if (x1 > x0 && z1 > z0) { foot.kx = Math.max(Math.abs(x0 - foot.cx), Math.abs(x1 - foot.cx)); foot.kz = Math.max(Math.abs(z0 - foot.cz), Math.abs(z1 - foot.cz)); } else { foot.kx = foot.hx; foot.kz = foot.hz; } })();
      // a shadow-only block under the hull (not drawn): from 0.3 m below the lowest point of the hull model to 0.7 m above it,
      // over the footprint. The collision model's tracks do not seal the gap to the ground and the shadow offsets let light
      // through at the contact line - the ground under the sun-side track stayed lit and the vehicle seemed to float (the user's case)
      var skirt = new T.Mesh(new T.BoxGeometry(Math.max(0.2, 2 * foot.kx - 0.1), 0.3, Math.max(0.2, 2 * foot.kz - 0.5)), skirtMat);
      skirt.position.set(foot.cx, bb.min.y + 0.3, foot.cz); skirt.castShadow = true; skirt.receiveShadow = false; g.add(skirt);  // 0.15-0.65 m: the shadow pass draws back faces, and a bottom face lying on the ground casts nothing
      var rec = { v: v, md: md, role: role, group: g, turret: turret, gun: gun, mat: mat, bar: bar, canvas: canvas, tex: tex,
        pos: f32(v.pos), gunT: f32(v.gun), hp: f32(v.hp), lastHp: null, visible: false, dead: false, foot: foot };
      vehicles.push(rec);
    });
    return ownTeam;
  }

  function search(arr, stride, n, t) { // last index with arr[i*stride] <= t, -1 if none
    var lo = 0, hi = n - 1, r = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (arr[mid * stride] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    return r;
  }
  function angLerp(a, b, f) { var d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * f; }
  function delayOf(r) { return delayOn ? (r.v.own ? battle.meta.delayOwn : battle.meta.delayOther) : 0; }

  var tmpEuler = new T.Euler(0, 0, 0, 'YXZ');
  // pose of one vehicle at track time t into (group, turret, gun) objects; false when it has no sample
  function poseInto(r, t, group, turret, gun) {
    var v = r.v, i = search(r.pos, 7, v.np, t);
    if (i < 0) return false;
    var p = r.pos, a = i * 7, f = 0, b = a;
    if (i + 1 < v.np && p[a + 7] - p[a] < 1.0) { b = a + 7; f = Math.max(0, Math.min(1, (t - p[a]) / (p[b] - p[a]))); }
    group.position.set(p[a + 1] + (p[b + 1] - p[a + 1]) * f, p[a + 2] + (p[b + 2] - p[a + 2]) * f, p[a + 3] + (p[b + 3] - p[a + 3]) * f);
    tmpEuler.set(angLerp(p[a + 5], p[b + 5], f), angLerp(p[a + 4], p[b + 4], f), angLerp(p[a + 6], p[b + 6], f), 'YXZ');
    group.rotation.copy(tmpEuler);
    if (turret && v.ng) {
      var gi = search(r.gunT, 3, v.ng, t), q = r.gunT;
      if (gi < 0) gi = 0;
      var c = gi * 3, d = c, g = 0;
      if (gi + 1 < v.ng && q[c + 3] - q[c] < 0.5 && t > q[c]) { d = c + 3; g = Math.min(1, (t - q[c]) / (q[d] - q[c])); }
      turret.rotation.y = angLerp(q[c + 1], q[d + 1], g);
      var pt = q[c + 2] + (q[d + 2] - q[c + 2]) * g;
      gun.rotation.x = r.md.pitch[0] + pt * (r.md.pitch[1] - r.md.pitch[0]);
    }
    return true;
  }
  function poseVehicles(t) {
    vehicles.forEach(function (r) {
      var v = r.v, inSight = false, tt = t - delayOf(r);
      for (var s = 0; s < v.sight.length; s++) if (t >= v.sight[s][0] && t < v.sight[s][1]) { inSight = true; break; }
      // a wreck stays where it was destroyed: the client drops a destroyed vehicle's entity after a while (the replay's
      // entity_leave), but the wreck does not move. Only when the destruction itself was in sight (the place is known).
      if (r.deathT === undefined) {
        r.deathT = null;
        for (var hk2 = 0; hk2 < v.nh; hk2++) if (r.hp[hk2 * 2 + 1] <= 0) { r.deathT = r.hp[hk2 * 2]; break; }
        r.wreckSeen = false;
        if (r.deathT != null) for (var s2 = 0; s2 < v.sight.length; s2++) if (r.deathT >= v.sight[s2][0] && r.deathT <= v.sight[s2][1]) r.wreckSeen = true;
      }
      if (!inSight && r.wreckSeen && t >= r.deathT) inSight = true;
      if (!inSight || !poseInto(r, tt, r.group, r.turret, r.gun)) { r.group.visible = false; r.visible = false; return; }
      r.group.visible = true; r.visible = true;
      var hi = search(r.hp, 2, v.nh, t), hp = hi < 0 ? v.maxHealth : r.hp[hi * 2 + 1];
      if (hp !== r.lastHp) {
        r.lastHp = hp; r.dead = hp <= 0;
        r.mat.userData.u.uDead.value = r.dead ? 1 : 0;
        drawMarker(r, hp);
        r.tex.needsUpdate = true; r.bar.visible = !r.dead;
      }
    });
    poseHalo();
  }
  // round 5d: the halo uniforms from the vehicles as drawn this frame (visible ones, up to HALO_N)
  function poseHalo() {
    var H = haloU.uHalo.value, n = 0;
    H.z = reliefU.uSunObj.value.x; H.w = reliefU.uSunObj.value.z;
    var sl = Math.hypot(H.z, H.w) || 1; H.z /= sl; H.w /= sl;  // toward the sun, horizontal, game axes
    // only hulls whose halo can be on screen (the camera's last frustum, the halo's radius around the hull)
    camera.updateMatrixWorld(); haloMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); haloFr.setFromProjectionMatrix(haloMat);
    if (H.y > 0 && layers.vehicles.visible) for (var i = 0; i < vehicles.length && n < HALO_N; i++) {
      var r = vehicles[i]; if (!r.visible && !haloBenchAll) continue;  // the bench may count every vehicle (its last pose)
      var p = r.group.position, yw = r.group.rotation.y, c = Math.cos(yw), s = Math.sin(yw), f = r.foot;
      // the footprint's centre: the vehicle's origin plus its hull box offset (x right = (c, -s), z forward = (s, c))
      haloU.uHvP.value[n].set(p.x + f.cx * c + f.cz * s, p.z - f.cx * s + f.cz * c, c, s);
      var R = Math.max(f.hx, f.hz) + 3.6;
      haloSph.center.set(haloU.uHvP.value[n].x, p.y, -haloU.uHvP.value[n].y); haloSph.radius = R + 3;
      if (!haloBenchAll && !haloFr.intersectsSphere(haloSph)) continue;
      haloU.uHvS.value[n].set(f.hx, f.hz, r.dead ? 0 : 1, R * R);
      hitsHaloColor(r, haloCol); haloU.uHvC.value[n].set(haloCol.r, haloCol.g, haloCol.b); haloU.uHvK.value[n].set(f.kx, f.kz);
      n++;
    }
    // bench only: a full battle's 30 hulls - the replay's vehicles plus copies on a 60 x 50 m grid round the arena centre
    for (var q = 0; haloBenchAll && n > 0 && n < 30; q++, n++) {
      haloU.uHvP.value[n].set(-150 + (q % 6) * 60, -100 + Math.floor(q / 6) * 50, 1, 0);
      haloU.uHvS.value[n].copy(haloU.uHvS.value[0]); haloU.uHvC.value[n].copy(haloU.uHvC.value[0]); haloU.uHvK.value[n].copy(haloU.uHvK.value[0]);
    }
    H.x = n;
  }
  var haloCol = new T.Color(), haloOn = true, haloBenchAll = false, haloFr = new T.Frustum(), haloMat = new T.Matrix4(), haloSph = new T.Sphere();
  function setHalo(on, k) {
    if (k != null) $('rng-halo').value = k;
    haloOn = !!on; $('sw-halo').checked = haloOn;
    var v = +$('rng-halo').value, m = +$('rng-halo-all').value; haloU.uHalo.value.y = haloOn ? Math.max(1e-3, v * m) : 0;  // m: overall strength, scales colour, shade and gradient
    $('halo-all-v').textContent = m.toFixed(2);
    $('halo-v').textContent = v.toFixed(2);
    haloU.uHaloT.value.set(m * +$('rng-halo-shade').value, m * +$('rng-halo-grad').value, +$('rng-halo-reach').value); $('halo-reach-v').textContent = (+$('rng-halo-reach').value).toFixed(2);
    $('halo-shade-v').textContent = (+$('rng-halo-shade').value).toFixed(2); $('halo-grad-v').textContent = (+$('rng-halo-grad').value).toFixed(2); poseHalo();
  }

  // muzzle of the drawn model at each shot's time (the same pose the page draws then): tracers start there
  var scratch = { g: new T.Object3D(), t: new T.Object3D(), k: new T.Object3D() };
  scratch.g.add(scratch.t); scratch.t.add(scratch.k);
  var muzzleOffsets = [];
  function computeMuzzles() {
    var byId = {}; vehicles.forEach(function (r) { byId[r.v.id] = r; });
    muzzleOffsets = [];
    var diag = [];
    shots.forEach(function (x, n) {
      var r = byId[x[1]], m = null;
      if (r && r.md.model) {
        scratch.t.position.fromArray(r.md.turretAt); scratch.k.position.fromArray(r.md.gunAt);
        scratch.t.rotation.set(0, 0, 0); scratch.k.rotation.set(0, 0, 0);
        if (poseInto(r, x[0] - delayOf(r), scratch.g, scratch.t, scratch.k)) {
          scratch.g.updateMatrixWorld(true);
          var p = new T.Vector3(0, 0, r.md.gunLength).applyMatrix4(scratch.k.matrixWorld);
          var pivot = new T.Vector3(0, 0, 0).applyMatrix4(scratch.k.matrixWorld);
          var fwd = p.clone().sub(pivot).normalize(), vel = new T.Vector3(x[6], x[7], x[8]).normalize();
          m = [p.x - x[3], p.y - x[4], p.z - x[5]];
          diag.push({ angle: Math.acos(Math.max(-1, Math.min(1, fwd.dot(vel)))) * 180 / Math.PI,
            pivot: Math.hypot(pivot.x - x[3], pivot.y - x[4], pivot.z - x[5]),
            along: (x[3] - pivot.x) * fwd.x + (x[4] - pivot.y) * fwd.y + (x[5] - pivot.z) * fwd.z });
        }
      }
      muzzleOffsets[n] = m;
    });
    var d = muzzleOffsets.filter(Boolean).map(function (m) { return Math.hypot(m[0], m[1], m[2]); }).sort(function (a, b) { return a - b; });
    window.__muzzle = { shots: shots.length, withMuzzle: d.length, medianOffset: d.length ? +d[d.length >> 1].toFixed(2) : null,
      p90: d.length ? +d[Math.floor(d.length * 0.9)].toFixed(2) : null,
      // the drawn gun's direction against the shot's velocity, and where the server's start lies from the gun pivot
      gunVsVelocityDeg: med(diag.map(function (q) { return q.angle; })), startFromPivot: med(diag.map(function (q) { return q.pivot; })),
      startAlongGun: med(diag.map(function (q) { return q.along; })) };
    function med(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? +a[a.length >> 1].toFixed(2) : null; }
  }

  // tracers: one LineSegments, rebuilt for the shots in flight
  var MAXSEG = 2048, SEG = 12, FADE = 1.2;
  var trPos = new Float32Array(MAXSEG * 6), trCol = new Float32Array(MAXSEG * 6);
  var trGeo = new T.BufferGeometry();
  trGeo.setAttribute('position', new T.BufferAttribute(trPos, 3).setUsage(T.DynamicDrawUsage));
  trGeo.setAttribute('color', new T.BufferAttribute(trCol, 3).setUsage(T.DynamicDrawUsage));
  var trLines = new T.LineSegments(trGeo, new T.LineBasicMaterial({ vertexColors: true, depthTest: true }));
  trLines.frustumCulled = false; layers.tracers.add(trLines);
  var shotColors = {};
  function poseTracers(t) {
    var n = 0;
    for (var s = 0; s < shots.length; s++) {
      var x = shots[s];
      if (x[0] > t) break;
      var sx = x[3], sy = x[4], sz = x[5], vx = x[6], vy = x[7], vz = x[8], g = x[9], ex = x[11], ey = x[12], ez = x[13];
      var hv = Math.hypot(vx, vz), flight = hv > 1 ? Math.hypot(ex - sx, ez - sz) / hv : 0.05;
      var tau = t - x[0];
      if (tau > flight + FADE) continue;
      var upto = Math.min(tau, flight), fade = tau > flight ? 1 - (tau - flight) / FADE : 1;
      var c = shotColors[x[1]] || [1, 1, 0.6], k = x[2] ? [1, 0.6, 0.2] : c;
      var mo = muzzleOffsets[s] || [0, 0, 0];
      // the server's arc, its start moved to the drawn muzzle and the move fading out along the flight
      var px = sx + mo[0], py = sy + mo[1], pz = sz + mo[2];
      for (var i = 1; i <= SEG && n < MAXSEG; i++) {
        var u = upto * i / SEG, w = flight > 0 ? 1 - Math.min(1, u / flight) : 0, qx, qy, qz;
        if (tau >= flight && i === SEG) { qx = ex; qy = ey; qz = ez; }
        else { qx = sx + vx * u + mo[0] * w; qy = sy + vy * u - 0.5 * g * u * u + mo[1] * w; qz = sz + vz * u + mo[2] * w; }
        var o = n * 6;
        trPos[o] = px; trPos[o + 1] = py; trPos[o + 2] = pz; trPos[o + 3] = qx; trPos[o + 4] = qy; trPos[o + 5] = qz;
        for (var j = 0; j < 2; j++) { trCol[o + j * 3] = k[0] * fade; trCol[o + j * 3 + 1] = k[1] * fade; trCol[o + j * 3 + 2] = k[2] * fade; }
        px = qx; py = qy; pz = qz; n++;
      }
    }
    trGeo.setDrawRange(0, n * 2);
    trGeo.attributes.position.needsUpdate = true; trGeo.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------------ round 6: shot and hit effects
  // Every effect is one replay event (build.py build_effects): a muzzle flash = Vehicle.showShooting; a hit flash and its
  // mark = a point of Vehicle.showDamageFromShot, placed on the drawn part (hull / turret / gun) in that part's frame, so
  // it moves with it; a mark without a flash = a Vehicle.damageStickers entry with no hit seen (made out of view, it
  // arrives when the vehicle comes into view). The outcome is the point's effect: 0 pierced without damage, 4 pierced,
  // 5 critical hit, 6 pierced with a device damaged -> penetration; 3 -> not pierced; 1, 2 -> ricochet.
  // Cost: the flashes and sparks are one Points draw (a pool of FX_MAX, rewritten each frame for the effects alive, none
  // when nothing is alive); the marks are one mesh per vehicle part that has any (every mark of the battle in it, the
  // shader shows those born by now); no lights, no shadow casters, no post-processing.
  var FX_PEN = { 0: 1, 4: 1, 5: 1, 6: 1 }, FX_RIC = { 1: 1, 2: 1 };
  function fxClass(eff) { return FX_PEN[eff] ? 0 : (FX_RIC[eff] ? 2 : 1); }  // 0 penetration, 1 not pierced, 2 ricochet
  var hitsOn = true, fxHits = [], fxMuzzles = [], fxById = {}, fxMarkMeshes = [], fxMarkInfo = null;
  var FX_MAX = 512, MUZ_LIFE = 0.14, HIT_LIFE = 0.6, SPARKS = 10;
  var fxPos = new Float32Array(FX_MAX * 3), fxCol = new Float32Array(FX_MAX * 4), fxSz = new Float32Array(FX_MAX);
  var fxGeo = new T.BufferGeometry();
  fxGeo.setAttribute('position', new T.BufferAttribute(fxPos, 3).setUsage(T.DynamicDrawUsage));
  fxGeo.setAttribute('fxc', new T.BufferAttribute(fxCol, 4).setUsage(T.DynamicDrawUsage));
  fxGeo.setAttribute('fxs', new T.BufferAttribute(fxSz, 1).setUsage(T.DynamicDrawUsage));
  fxGeo.setDrawRange(0, 0);
  var fxU = { uScale: { value: 500 } };
  var fxPoints = new T.Points(fxGeo, new T.ShaderMaterial({ uniforms: fxU, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: 'attribute vec4 fxc; attribute float fxs; uniform float uScale; varying vec4 vC;\n' +
      'void main() { vC = fxc; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;\n' +
      ' gl_PointSize = clamp(fxs * uScale / max(0.25, -mv.z), 1.5, 256.0); }',  // size in metres; at least 1.5 px so far sparks still show
    fragmentShader: 'varying vec4 vC;\n' +
      'void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; float r = dot(d, d); if (r > 1.0) discard;\n' +
      ' float a = vC.a * (1.0 - r) * (1.0 - r); gl_FragColor = vec4(mix(vC.rgb, vec3(1.0), smoothstep(0.25, 0.0, r) * 0.7), a); }' }));
  fxPoints.frustumCulled = false; fxPoints.renderOrder = 20; scene.add(fxPoints);  // world coordinates (the root's mirror applied here)
  var fxV = new T.Vector3(), fxN = new T.Vector3(), fxF = new T.Vector3(), fxR = new T.Vector3();
  function fxRand(i) { var x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }  // stable per index: a seek repeats it
  function fxPart(r, grp) { return grp === 1 ? r.turret : (grp === 2 ? r.gun : r.group); }
  function fxFirst(arr, t0) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m][0] < t0) lo = m + 1; else hi = m; } return lo; }
  function fxPut(n, x, y, z, r, g, b, a, s) {
    if (n >= FX_MAX) return n;
    fxPos[n * 3] = x; fxPos[n * 3 + 1] = y; fxPos[n * 3 + 2] = z;
    fxCol[n * 4] = r; fxCol[n * 4 + 1] = g; fxCol[n * 4 + 2] = b; fxCol[n * 4 + 3] = a; fxSz[n] = s;
    return n + 1;
  }
  // why an event draws nothing now: null = it draws
  function fxWhyNot(r) { return !r ? 'vehicle not in the battle file' : (!r.md.model ? 'vehicle drawn as a box' : (!r.visible ? 'vehicle not in sight' : null)); }
  // the flashes and sparks alive at time t; `count` (optional) collects which events drew and why the others did not
  function fxStep(t, count) {
    var n = 0;
    if (hitsOn || count) {
      for (var i = fxFirst(fxMuzzles, t - MUZ_LIFE); i < fxMuzzles.length && fxMuzzles[i][0] <= t; i++) {
        var m = fxMuzzles[i], r = fxById[m[1]], why = fxWhyNot(r);
        if (count) { if (why) count.muzzleWhy[i] = count.muzzleWhy[i] || why; else count.muzzle[i] = 1; }
        if (why) continue;
        var k = 1 - (t - m[0]) / MUZ_LIFE;
        r.gun.updateWorldMatrix(true, false);
        fxV.set(0, 0, r.md.gunLength).applyMatrix4(r.gun.matrixWorld);
        fxF.set(0, 0, r.md.gunLength + 1).applyMatrix4(r.gun.matrixWorld).sub(fxV);  // 1 m along the drawn gun
        n = fxPut(n, fxV.x, fxV.y, fxV.z, 1, 0.8, 0.45, k, 2.2);
        var u = 1.2 + 4 * (t - m[0]);
        n = fxPut(n, fxV.x + fxF.x * u, fxV.y + fxF.y * u, fxV.z + fxF.z * u, 1, 0.5, 0.15, 0.8 * k, 1.6);
      }
      for (var j = fxFirst(fxHits, t - HIT_LIFE); j < fxHits.length && fxHits[j][0] <= t; j++) {
        var h = fxHits[j], rv = fxById[h[1]], wn = fxWhyNot(rv), tau = t - h[0], c = fxClass(h[6]);
        var life = c === 0 ? 0.3 : HIT_LIFE;
        if (tau > life) continue;
        if (count) { if (wn) count.hitWhy[j] = count.hitWhy[j] || wn; else count.hit[j] = 1; }
        if (wn) continue;
        var part = fxPart(rv, h[7]); part.updateWorldMatrix(true, false);
        fxV.set(h[8], h[9], h[10]).applyMatrix4(part.matrixWorld);
        fxN.set(h[11], h[12], h[13]).transformDirection(part.matrixWorld);
        var s = 0.6 + Math.min(1.5, (h[23] || 100) / 100);  // calibre in mm -> flash size
        if (c === 0) {  // penetration: a hot orange flash, a little off the plate
          var kk = 1 - tau / 0.3;
          n = fxPut(n, fxV.x + fxN.x * 0.15, fxV.y + fxN.y * 0.15, fxV.z + fxN.z * 0.15, 1, 0.55, 0.15, kk, 2.4 * s);
        } else {  // not pierced: a short white flash and sparks off the plate (local); ricochet: a small flash and sparks
          // along the ricochet's own tracer when the replay has it, else off the plate
          if (c === 1) { if (tau < 0.18) n = fxPut(n, fxV.x + fxN.x * 0.1, fxV.y + fxN.y * 0.1, fxV.z + fxN.z * 0.1, 1, 0.92, 0.75, 1 - tau / 0.18, 1.4 * s); }
          else if (tau < 0.12) n = fxPut(n, fxV.x, fxV.y, fxV.z, 1, 0.9, 0.6, 1 - tau / 0.12, 1.1 * s);
          var has = c === 2 && (h[18] || h[19] || h[20]);
          if (has) fxR.set(h[18], h[19], -h[20]); else fxR.copy(fxN);  // the tracer's velocity is in game axes: z mirrored
          for (var q = 0; q < SPARKS; q++) {
            var a1 = fxRand(j * 31 + q) * Math.PI * 2, sp = (has ? 0.25 : 0.8) * Math.sqrt(fxRand(j * 31 + q + 0.5)), v0 = (c === 1 ? 0.45 : 1) * (18 + 22 * fxRand(j * 17 + q));
            // a direction within `sp` radians of fxR
            fxF.set(Math.cos(a1), Math.sin(a1), 0.37).normalize(); fxF.cross(fxR).normalize();
            var dx = fxR.x + fxF.x * Math.tan(sp), dy = fxR.y + fxF.y * Math.tan(sp), dz = fxR.z + fxF.z * Math.tan(sp), dl = Math.hypot(dx, dy, dz) || 1;
            var fade = 1 - tau / HIT_LIFE;
            n = fxPut(n, fxV.x + dx / dl * v0 * tau, fxV.y + dy / dl * v0 * tau - 4.9 * tau * tau, fxV.z + dz / dl * v0 * tau, 1, 0.75, 0.35, fade, 0.22);
          }
        }
      }
    }
    fxGeo.setDrawRange(0, hitsOn ? n : 0);
    if (n) { fxGeo.attributes.position.needsUpdate = true; fxGeo.attributes.fxc.needsUpdate = true; fxGeo.attributes.fxs.needsUpdate = true; }
    fxU.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    markU.uTime.value = t;
    for (var mm = 0; mm < fxMarkMeshes.length; mm++) fxMarkMeshes[mm].visible = hitsOn && t >= fxMarkMeshes[mm].userData.first;
    return n;
  }

  // lasting marks: quads on the part's surface (1.2 cm off it along the plate's normal), coloured by the outcome in the shader;
  // aI = (birth time, kind, seed, 0): kind 0 penetration, 1 not pierced, 2 ricochet, 3 hole made out of view, 4 resisted made out of view
  var markU = { uTime: { value: 0 } };
  var markMat = new T.ShaderMaterial({ uniforms: markU, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    vertexShader: 'attribute vec2 aUv; attribute vec4 aI; uniform float uTime; varying vec2 vUv; varying vec4 vI; varying float vAge;\n' +
      'void main() { vUv = aUv; vI = aI; vAge = uTime - aI.x;\n' +
      ' gl_Position = vAge < 0.0 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',  // not born yet: off screen
    fragmentShader: 'uniform float uTime; varying vec2 vUv; varying vec4 vI; varying float vAge;\n' +
      'void main() { float k = vI.y; float r = length(vUv); float an = atan(vUv.y, vUv.x);\n' +
      ' float rr = r * (1.0 + 0.12 * sin(an * 5.0 + vI.z * 6.3) + 0.06 * sin(an * 11.0 + vI.z * 2.1));\n' +  // a ragged edge, per mark
      ' vec3 col; float a;\n' +
      ' if (k < 0.5 || (k > 2.5 && k < 3.5)) {\n' +  // penetration: a ragged crater with an ember flickering inside it, in a scorch that fades out from the crater's edge; fresh, a wide hot glow
      '  float H = k < 0.5 ? exp(-vAge / 3.0) : 0.0;\n' +
      '  vec3 hot = mix(vec3(0.45, 0.04, 0.0), mix(vec3(1.0, 0.42, 0.05), vec3(1.0, 0.92, 0.65), clamp(H * 2.0 - 1.0, 0.0, 1.0)), clamp(H * 2.0, 0.0, 1.0));\n' +
      '  float core = 1.0 - smoothstep(0.175, 0.2, rr);\n' +  // the crater: a hard ragged edge
      '  float fl = 0.78 + 0.22 * sin(uTime * 5.0 + vI.z * 40.0) * sin(uTime * 1.7 + vI.z * 9.0);\n' +  // the ember's flicker
      '  vec3 ember = vec3(0.95, 0.25, 0.03) * fl * mix(0.5, 1.2, 1.0 - clamp(rr / 0.2, 0.0, 1.0));\n' +
      '  col = mix(vec3(0.07, 0.055, 0.045), ember, core);\n' +
      '  float glow = H * (1.0 - smoothstep(0.12, 0.95, rr));\n' +
      '  col = col * (1.0 - glow) + hot * glow * 1.6;\n' +
      '  float sc = 1.0 - clamp((rr - 0.2) / 0.24, 0.0, 1.0);\n' +  // the scorch: dense at the crater, gone 0.24 further out
      '  a = max(max(core, 0.85 * sc * sqrt(sc)), glow);\n' +
      ' } else if (k < 1.5 || k > 3.5) {\n' +  // not pierced: a ragged gouge of bare metal, light and darker grey streaks from its centre, a grey smear fading out; briefly hot
      '  float F = k < 1.5 ? max(0.0, 1.0 - vAge / 1.2) : 0.0;\n' +
      '  float core = 1.0 - smoothstep(0.17, 0.2, rr);\n' +
      '  float stv = 0.5 + 0.5 * sin(an * 9.0 + vI.z * 11.0) * sin(an * 4.0 + vI.z * 3.0);\n' +
      '  vec3 metal = mix(vec3(0.4, 0.41, 0.43), vec3(0.86, 0.87, 0.89), stv * (1.0 - 0.5 * clamp(rr / 0.2, 0.0, 1.0)) + 0.25);\n' +
      '  metal = mix(metal, vec3(1.0, 0.65, 0.25), F);\n' +
      '  col = mix(vec3(0.3, 0.31, 0.33), metal, core);\n' +
      '  float sc = 1.0 - clamp((rr - 0.2) / 0.14, 0.0, 1.0);\n' +
      '  a = max(core, 0.6 * sc * sqrt(sc));\n' +
      ' } else {\n' +  // ricochet: a thin tapered scratch along the shell's path (the quad is long along it) and a fainter one beside it; bare metal, briefly hot
      '  float F = max(0.0, 1.0 - vAge / 1.2);\n' +
      '  float x = vUv.x, y = vUv.y - 0.05 * sin(x * 6.0 + vI.z * 5.0);\n' +
      '  float w1 = 0.15 * pow(max(0.0, 1.0 - x * x / 0.8), 0.7) * (1.0 + 0.25 * sin(x * 17.0 + vI.z * 8.0));\n' +
      '  float y2 = y - 0.3 - 0.04 * sin(x * 4.0 + vI.z * 3.0), x2 = (x + 0.15) / 0.55;\n' +
      '  float w2 = 0.07 * max(0.0, 1.0 - x2 * x2);\n' +
      '  float m1 = w1 > 0.001 ? 1.0 - clamp(abs(y) / w1, 0.0, 1.0) : 0.0, m2 = w2 > 0.001 ? 1.0 - clamp(abs(y2) / w2, 0.0, 1.0) : 0.0;\n' +
      '  float m = max(m1, 0.7 * m2);\n' +
      '  col = mix(mix(vec3(0.36, 0.37, 0.39), vec3(0.9, 0.91, 0.93), m), vec3(1.0, 0.6, 0.2), F);\n' +
      '  a = smoothstep(0.0, 0.3, m);\n' +
      ' }\n' +
      ' if (a < 0.01) discard; gl_FragColor = vec4(col, a); }' });
  // all marks of one vehicle part in one geometry
  function buildMarks() {
    var per = {}, info = { hitPoints: fxHits.length, marksFromHits: 0, marksFromStickers: 0, notPlaced: {}, meshes: 0, byKind: [0, 0, 0, 0, 0] };
    function note(why) { info.notPlaced[why] = (info.notPlaced[why] || 0) + 1; }
    function add(r, grp, t, kind, p, nrm, d, size, seed) {
      var key = r.v.id + ':' + grp, L = per[key] || (per[key] = { r: r, grp: grp, pos: [], uv: [], inf: [], first: 1e9 });
      var N = new T.Vector3(nrm[0], nrm[1], nrm[2]).normalize(), U = new T.Vector3(d[0], d[1], d[2]);
      var dl0 = U.length(), st = dl0 > 1e-6 ? Math.min(3, dl0 / Math.max(Math.abs(U.dot(N)), 1e-3)) : 1;  // 1 / cos of the impact angle: head-on round, glancing long (up to 3x)
      U.addScaledVector(N, -U.dot(N));  // the shell's direction along the plate
      if (U.lengthSq() < 1e-6) { U.set(Math.abs(N.y) < 0.9 ? 0 : 1, Math.abs(N.y) < 0.9 ? 1 : 0, 0).cross(N); }
      U.normalize();
      if (kind !== 2 && st < 1.15) U.applyAxisAngle(N, seed * Math.PI * 2);  // a round mark: any turn (the client's randomYaw)
      var V = new T.Vector3().crossVectors(N, U), hu = kind === 2 ? size * 1.5 : size * st, hv = kind === 2 ? size * 0.5 : size;
      var c = new T.Vector3(p[0], p[1], p[2]).addScaledVector(N, 0.012);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) {
        L.pos.push(c.x + U.x * hu * q[0] + V.x * hv * q[1], c.y + U.y * hu * q[0] + V.y * hv * q[1], c.z + U.z * hu * q[0] + V.z * hv * q[1]);
        L.uv.push(q[0], q[1]); L.inf.push(t, kind, seed, 0);
      });
      L.first = Math.min(L.first, t); info.byKind[kind]++;
    }
    fxHits.forEach(function (h, i) {
      var r = fxById[h[1]];
      if (!r) return note('vehicle not in the battle file'); if (!r.md.model) return note('vehicle drawn as a box');
      add(r, h[7], h[0], fxClass(h[6]), [h[8], h[9], h[10]], [h[11], h[12], h[13]], [h[14], h[15], h[16]], h[17], fxRand(i * 3 + 1)); info.marksFromHits++;
    });
    (battle.marks || []).forEach(function (m, i) {
      var r = fxById[m[1]];
      if (!r) return note('vehicle not in the battle file'); if (!r.md.model) return note('vehicle drawn as a box');
      add(r, m[2], m[0], m[3] ? 4 : 3, [m[4], m[5], m[6]], [m[7], m[8], m[9]], [0, 0, 0], m[10], fxRand(i * 3 + 2)); info.marksFromStickers++;
    });
    Object.keys(per).forEach(function (key) {
      var L = per[key], g = new T.BufferGeometry(), nq = L.pos.length / 12, idx = [];
      for (var q = 0; q < nq; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
      g.setAttribute('position', new T.Float32BufferAttribute(L.pos, 3));
      g.setAttribute('aUv', new T.Float32BufferAttribute(L.uv, 2));
      g.setAttribute('aI', new T.Float32BufferAttribute(L.inf, 4));
      g.setIndex(idx);
      var mesh = new T.Mesh(g, markMat); mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 5;
      mesh.userData.first = L.first; mesh.visible = false;
      fxPart(L.r, L.grp).add(mesh); fxMarkMeshes.push(mesh); info.meshes++;
    });
    fxMarkInfo = info;
  }
  function setHits(on) { hitsOn = !!on; $('sw-hits').checked = hitsOn; fxStep(t); }
  // the counts check: data events against the effects the page draws over the whole battle (a sweep of the battle in
  // steps of dt, default 1/30 s; every flash lives 0.14 s or more), then the time put back
  function hitsSweep(dt) {
    dt = dt || 1 / 30;
    var t0 = t, on = hitsOn, cnt = { muzzle: {}, muzzleWhy: {}, hit: {}, hitWhy: {} };
    for (var x = 0; x <= tEnd + 1; x += dt) { poseVehicles(x); fxStep(x, cnt); }
    hitsOn = on; poseVehicles(t0); fxStep(t0);
    function tally(drawn, why, total) {
      var o = { events: total, drawn: Object.keys(drawn).length, notDrawn: {} };
      Object.keys(why).forEach(function (i) { if (!drawn[i]) o.notDrawn[why[i]] = (o.notDrawn[why[i]] || 0) + 1; });
      o.unaccounted = total - o.drawn - Object.keys(o.notDrawn).reduce(function (a, k) { return a + o.notDrawn[k]; }, 0);
      return o;
    }
    var byClass = [0, 0, 0], drawnByClass = [0, 0, 0];
    fxHits.forEach(function (h, i) { var c = fxClass(h[6]); byClass[c]++; if (cnt.hit[i]) drawnByClass[c]++; });
    return { dt: dt, muzzleFlashes: tally(cnt.muzzle, cnt.muzzleWhy, fxMuzzles.length), hitFlashes: tally(cnt.hit, cnt.hitWhy, fxHits.length),
      hitPointsByClass: { penetration: byClass[0], notPierced: byClass[1], ricochet: byClass[2] },
      hitFlashesDrawnByClass: { penetration: drawnByClass[0], notPierced: drawnByClass[1], ricochet: drawnByClass[2] },
      marks: fxMarkInfo, data: { hitEvents: new Set(fxHits.map(function (h) { return h[3]; })).size, hitPoints: fxHits.length,
        stickerMarks: (battle.marks || []).length, muzzles: fxMuzzles.length, build: battle.effectStats } };
  }

  // ------------------------------------------------------------------ camera
  // round 5d: tyOff = the free camera's target height above the ground (R/F change it); tyGoal = the height the target
  // glides to after a pan (the ground under the new target + tyOff), so orbit and zoom pivot on the ground looked at
  var cam = { tx: 0, ty: 30, tz: 0, yaw: 0.6, pitch: 0.75, dist: 700, tyOff: 1, tyGoal: null }, follow = null, keys = {};
  function glideTarget(dt) {
    if (follow || cam.tyGoal == null) return;
    var d = cam.tyGoal - cam.ty;
    if (Math.abs(d) < 0.005) { cam.ty = cam.tyGoal; cam.tyGoal = null; return; }
    cam.ty += d * (1 - Math.exp(-dt / 0.12));  // time constant 0.12 s: no jump over a cliff edge, no lag felt
  }
  function placeCamera() {
    if (follow && follow.visible) {
      var p = follow.group.position; cam.tx = p.x; cam.ty = p.y + 2.5; cam.tz = p.z;
    }
    var x = cam.tx + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), y = cam.ty + cam.dist * Math.sin(cam.pitch),
      z = -cam.tz + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw);
    // never below the ground (round 2 could put the ground camera into the terrain on slopes)
    if (heightAt) y = Math.max(y, heightAt(x, -z) + 0.9);  // round 5d: 0.9 m (was 1.2): a driver's eye level
    camera.position.set(x, y, z); camera.lookAt(cam.tx, cam.ty, -cam.tz);
  }
  var drag = null;
  renderer.domElement.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // round 14: pan by the right or the middle button, or Shift + left (the game's browser gives the right and middle
  // buttons and Shift + click only when the mod switches them on); orbit by the left button alone
  renderer.domElement.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, b: e.button === 0 && e.shiftKey ? 2 : e.button }; renderer.domElement.setPointerCapture(e.pointerId); if (e.button === 1) e.preventDefault(); });
  renderer.domElement.addEventListener('pointerup', function () { drag = null; });
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.b === 0) { cam.yaw -= dx * 0.005; cam.pitch = Math.max(0.02, Math.min(1.55, cam.pitch + dy * 0.005)); }
    else { setFollow(null); var s = Math.max(cam.dist, PAN.floor) * 0.0015; move(-dx * s, dy * s); }  // round 5e: the ground follows the cursor; below 12 m the 12 m rate
  });
  // round 5d: one wheel click (deltaY 100) moves 23 % of the distance to the point looked at in, 30 % out (the same
  // ratio back), at least 0.8 m: 300 m -> 2 m in about 19 clicks; down to 1 m from the target (an eye ~1 m over the ground)
  var ZOOM = { inFrac: 0.23, outFrac: 0.30, floor: 0.8, min: 1.0, max: 2500 };
  function zoomBy(clicks) {
    var n = Math.min(3, Math.abs(clicks)), d = cam.dist;
    d = clicks > 0 ? d + Math.max(ZOOM.outFrac * d, ZOOM.floor) * n : d - Math.max(ZOOM.inFrac * d, ZOOM.floor) * n;
    cam.dist = Math.max(ZOOM.min, Math.min(ZOOM.max, d));
  }
  renderer.domElement.addEventListener('wheel', function (e) { e.preventDefault(); zoomBy(e.deltaY / (e.deltaMode === 1 ? 3 : 100)); }, { passive: false });
  // round 5e (the user's word): WASD speed grows with the camera distance much less steeply than zoom and never dies
  // near the ground: 150 m/s x (max(dist, 12 m) / 150 m)^0.6 - 150 m/s at 150 m as before, 33 m/s at 12 m and below
  // (was 20), 78 m/s at 50 m (was 50), 810 m/s at 2500 m (was 2500)
  var PAN = { floor: 12, ref: 150, pow: 0.6 };
  function panSpeed(d) { return PAN.ref * Math.pow(Math.max(d, PAN.floor) / PAN.ref, PAN.pow); }
  function move(right, fwd) { // in the screen's ground plane, game coordinates (z north = scene -z)
    var sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
    cam.tx += right * cy - fwd * sy; cam.tz += right * sy + fwd * cy;
    if (heightAt) cam.tyGoal = heightAt(cam.tx, cam.tz) + cam.tyOff;
  }
  // round 14: the arrows by e.key as well as e.code - the game's browser may hand an arrow with the code of its numpad
  // twin (Numpad8 ...) and the key ArrowUp (unverified, outputs/game-browser-input-2026-11-19.md section 5); keyup clears
  // the same two names, so no key sticks
  function keyNames(e) { var n = [e.code]; if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && e.key !== e.code) n.push(e.key); return n; }
  window.addEventListener('keydown', function (e) { keyNames(e).forEach(function (k) { keys[k] = true; }); if (e.code === 'Space') { togglePlay(); e.preventDefault(); } if (keyNames(e).some(function (k) { return k.indexOf('Arrow') === 0; }) && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) e.preventDefault(); });
  var NUMPAD_ARROW = { Numpad8: 'ArrowUp', Numpad2: 'ArrowDown', Numpad4: 'ArrowLeft', Numpad6: 'ArrowRight' };
  window.addEventListener('keyup', function (e) { keyNames(e).forEach(function (k) { keys[k] = false; }); if (NUMPAD_ARROW[e.code]) keys[NUMPAD_ARROW[e.code]] = false; });
  window.addEventListener('blur', function () { keys = {}; });
  function keyMove(dt) {
    var s = panSpeed(cam.dist) * dt, any = false;
    if (keys.KeyW || keys.ArrowUp) { move(0, s); any = true; } if (keys.KeyS || keys.ArrowDown) { move(0, -s); any = true; }
    if (keys.KeyA || keys.ArrowLeft) { move(-s, 0); any = true; } if (keys.KeyD || keys.ArrowRight) { move(s, 0); any = true; }
    if (keys.KeyR || keys.KeyF) {
      cam.ty += (keys.KeyR ? 1 : -1) * s * 0.5; cam.tyGoal = null;
      if (heightAt && !follow) cam.tyOff = cam.ty - heightAt(cam.tx, cam.tz);
    }
    if (any) setFollow(null);
    glideTarget(dt);
  }
  // round 14, temporary: the input log (Settings > input log, off on every opening, not remembered) - what the page
  // receives, to settle what the game's browser delivers (outputs/game-browser-input-2026-11-19.md section 7): every key,
  // button, wheel, double click and context menu on the page (no pointer moves), the last 12 lines in a corner and, in the
  // game, to the mod's log through the page channel ('inputLog', {lines}), at most one send a second
  var inputLog = { on: false, shown: [], queue: [], timer: null, t0: performance.now() };
  function inputLine(e) {
    var m = (e.shiftKey ? 'S' : '-') + (e.ctrlKey ? 'C' : '-') + (e.altKey ? 'A' : '-') + (e.metaKey ? 'M' : '-'), s = ((performance.now() - inputLog.t0) / 1000).toFixed(2) + ' ' + e.type + ' ';
    if (e.type === 'keydown' || e.type === 'keyup') s += 'key=' + JSON.stringify(e.key) + ' code=' + e.code + ' keyCode=' + e.keyCode + ' loc=' + e.location + (e.repeat ? ' repeat' : '');
    else if (e.type === 'wheel') s += 'dY=' + e.deltaY + ' dX=' + e.deltaX + ' mode=' + e.deltaMode;
    else s += 'button=' + e.button + ' buttons=' + e.buttons;
    s += ' mods=' + m + ' on=' + ((e.target && (e.target.id || e.target.tagName)) || '?');
    inputLog.shown.push(s); if (inputLog.shown.length > 12) inputLog.shown.shift();
    $('inputlog').textContent = inputLog.shown.join('\n');
    if (host.game && host.canSend()) {
      if (inputLog.queue.length < 200) inputLog.queue.push(s);
      if (!inputLog.timer) inputLog.timer = setTimeout(inputFlush, 1000);
    }
  }
  function inputFlush() {
    inputLog.timer = null; var lines = inputLog.queue.splice(0, 50);
    if (lines.length) host.send('bullba_hits', { action: 'inputLog', lines: lines }).catch(function (err) { console.warn('Bullba Hits inputLog failed: ' + err.message); });
    if (inputLog.queue.length) inputLog.timer = setTimeout(inputFlush, 1000);
  }
  ['keydown', 'keyup', 'pointerdown', 'pointerup', 'wheel', 'dblclick', 'contextmenu'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (inputLog.on) inputLine(e); }, { capture: true, passive: true });
  });
  $('sw-inputlog').onchange = function () {
    inputLog.on = this.checked; $('inputlog').hidden = !inputLog.on;
    if (inputLog.on) { inputLog.shown = []; $('inputlog').textContent = 'input log: press keys, click, turn the wheel'; }
  };
  function setFollow(r) {
    if (follow === r) return; follow = r;
    if (r) cam.dist = Math.min(cam.dist, 30);
    $('free').classList.toggle('on', !r);
    renderList(true);
  }

  // ------------------------------------------------------------------ playback, meter, switches
  var t = 0, playing = false, speed = 1, lastFrame = 0;
  var intervals = [], cpuTimes = [];
  function togglePlay() { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; }
  $('play').onclick = togglePlay;
  $('slider').oninput = function () { t = +this.value; };
  // the speed is a setting (remembered with the others): the hidden #speed-value holds it, the 1/8..x8 buttons set it
  // (round 13: 1/2, 1/4, 1/8 - every effect runs on the battle clock t, so it slows with it)
  var SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
  $('speed-value').onchange = function () {
    speed = SPEEDS.indexOf(+this.value) >= 0 ? +this.value : 1;
    Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (x) { x.classList.toggle('on', +x.dataset.speed === speed); });
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) {
    b.onclick = function () { var v = $('speed-value'); v.value = b.dataset.speed; v.dispatchEvent(new Event('change')); };
  });
  $('free').onclick = function () { setFollow(null); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-layer]'), function (c) {
    c.onchange = function () {
      if (c.dataset.layer === 'objects') { if (c.checked) setObjectsMode($('sel-objects').value); else { layers.visual.visible = false; layers.objects.visible = false; } }
      else { if (c.dataset.layer === 'helpers' && c.checked) ensureCollision(); layers[c.dataset.layer].visible = c.checked; }
      shadowDirty();
    };
  });
  function setShadows(on) { shadowsOn = on; applyShadowLights(); $('sw-shadows').checked = on; applyShadowCasters(); }
  $('sw-shadows').onchange = function () { setShadows(this.checked); };
  $('sw-hits').onchange = function () { setHits(this.checked); };
  $('sel-shadowq').onchange = function () { setShadowQuality(this.value); };
  $('sel-shadowd').onchange = function () { shDetail = +this.value; setShadowQuality(SHQ); };
  $('sw-delay').onchange = function () { delayOn = this.checked; computeMuzzles(); shadowDirty(); };
  // ground grain (round 5b): one strength for every ground mode, 0 when the box is off
  function setGrain(on, k) {
    if (k != null) $('rng-grain').value = k;
    $('sw-grain').checked = on;
    var v = +$('rng-grain').value; groundUniforms.uGrain.value = on ? v : 0;
    $('grain-v').textContent = v.toFixed(2);
  }
  $('sw-grain').onchange = function () { setGrain(this.checked); };
  $('rng-grain').oninput = function () { setGrain($('sw-grain').checked); };
  $('rng-tint').oninput = function () { setTeamTint(); };
  $('sel-vcolor').onchange = function () { setVehicleColor(); };
  $('rng-vbright').oninput = function () { setVehicleColor(); };
  $('rng-foliage').oninput = function () { setFoliage(); };
  $('sel-ground').onchange = function () { setGround(this.value); };
  $('sel-outside').onchange = function () { outsideMode = +this.value; applyOutside(); };  // applyOutside marks the shadows
  $('sel-crowns').onchange = function () { setCrowns(this.value); };
  $('sel-sun').onchange = function () { setSun(this.value); };
  $('sel-relief').onchange = function () { setRelief(this.value); };
  $('sw-halo').onchange = function () { setHalo(this.checked); };
  $('rng-halo').oninput = $('rng-halo-all').oninput = $('rng-halo-reach').oninput = $('rng-halo-shade').oninput = $('rng-halo-grad').oninput = function () { setHalo($('sw-halo').checked); };
  $('sw-haze').onchange = function () { setHaze(this.checked); };
  $('sw-sky').onchange = function () { setSky(this.checked); };
  $('sw-light').onchange = function () { setLight(this.checked); };
  $('rng-light').oninput = function () { setLight($('sw-light').checked); };
  $('sw-cost').onchange = function () { costOn = this.checked; $('cost').style.display = costOn ? 'block' : 'none'; gpuHist.length = 0; };
  $('sel-objects').onchange = function () { setObjectsMode(this.value); };
  $('sw-flash').onchange = function () { flashOn = this.checked; };
  $('destr').addEventListener('toggle', function () { document.body.classList.toggle('dopen', this.open); });
  $('settings-btn').onclick = function () { var s = $('settings'); s.hidden = !s.hidden; this.classList.toggle('on', !s.hidden); };

  function fmt(s) { var neg = s < 0; s = Math.abs(s); var m = Math.floor(s / 60), r = Math.floor(s % 60); return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r; }
  function quant(a, q) { if (!a.length) return NaN; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
  function window3s(list, now) { while (list.length && now - list[0][0] > 3000) list.shift(); return list.map(function (x) { return x[1]; }); }

  // ------------------------------------------------------------------ the shots panel (BACKLOG 109, stage 1, 19.11)
  // web/playback/shots-panel.js: a vehicle's shots and the hits it took, as Bullba Hits' rows, beside its team list; a row
  // rewinds the battle to 2 s before the shot, the camera on the shooter and the target, and plays on
  function tileOf(r) { return r.md.tile || { name: r.md.name || r.v.type.split(':')[1], type: r.v.type }; }
  var panel = null;
  function shotsPanel() {
    if (!panel) panel = BullbaShotsPanel.create({ battle: battle,
      info: function (id) { var r = fxById[id]; return r ? tileOf(r) : null; },
      player: function (id) { var r = fxById[id]; return (r && r.v.player) || ''; },
      clock: function (s) { return fmt(s - tBattle); },
      pick: function (row, j) { jumpTo(j); },
      hits: hitsOpener,
      changed: function () { renderList(false); } });
    return panel;
  }
  // 'Hits' on a row: that shot in Bullba Hits' window - only for a battle Hits has (its index, data/index.js) and a row with
  // a hit (Hits lists hits, not shots that met nothing). 'at' is the hit on the server's clock: the replay's server start +
  // the replay's time, the gameTime a Hits battle made from this replay stamps (replay_records.game_time); Hits looks the
  // hit up by attacker, target and that time (web/app.js openShot). In the game the mod opens or tells Hits' window
  // ('openHits'), outside it this window goes to Hits' page.
  function hitsOpener(row, id) {
    var known = INDEX && Array.isArray(INDEX.battles) && INDEX.battles.some(function (x) { return x && x.id === BID; });
    var h = row.hits[0], start = battle && battle.meta && battle.meta.serverStart;
    if (!known || !h || h.attacker == null || !Number.isFinite(start)) return null;
    var shot = { battleId: BID, at: +(start + h.t).toFixed(3), attacker: h.attacker, target: h.target, focus: id };
    return function () {
      if (host.game && host.canSend()) { host.send('bullba_hits', Object.assign({ action: 'openHits' }, shot)).catch(function (e) { console.warn('Bullba Hits openHits failed: ' + e.message); }); return; }
      location.href = BASE + 'Viewer.html#' + (host.game ? 'host=game&' : '') + 'battle=' + encodeURIComponent(BID) + '&at=' + shot.at + '&attacker=' + shot.attacker + '&target=' + shot.target + '&focus=' + shot.focus;
    };
  }
  function jumpTo(j) {
    t = Math.min(tEnd, Math.max(0, j.t)); $('slider').value = t;
    if (j.camera) {
      setFollow(null); var c = j.camera;
      cam.tx = c.tx; cam.ty = c.ty; cam.tz = c.tz; cam.yaw = c.yaw; cam.pitch = c.pitch; cam.dist = c.dist; cam.tyGoal = null;
      if (heightAt) cam.tyOff = cam.ty - heightAt(cam.tx, cam.tz);
    }
    if (!playing) togglePlay();
  }

  var listRows = [];
  function renderList(force) {
    if (!force && listRows.length) {
      listRows.forEach(function (row) {
        var r = row.r, hp = r.lastHp == null ? r.v.maxHealth : r.lastHp;
        row.el.className = row.base + (r.visible ? '' : ' out') + (r.dead ? ' dead' : '') + (follow === r ? ' follow' : '');
        row.bar.style.width = Math.max(0, Math.min(100, 100 * hp / (r.v.maxHealth || 1))) + '%';
        if (row.hb) row.hb.classList.toggle('on', !!panel && panel.shown() === r.v.id);
      });
      return;
    }
    var boxOwn = $('list-own'), boxEnemy = $('list-enemy'); boxOwn.innerHTML = ''; boxEnemy.innerHTML = ''; listRows = [];
    var sorted = vehicles.slice().sort(function (a, b) { return (a.role === 'enemy') - (b.role === 'enemy') || (b.role === 'own') - (a.role === 'own') || a.v.type.localeCompare(b.v.type); });
    sorted.forEach(function (r) {
      var el = document.createElement('div'), base = 'veh' + (r.role === 'own' ? ' own' : '');
      // round 10: the player's nickname and the vehicle at the row's two edges; the HP is the row's own background - a
      // fill in the team's colour as wide as the HP left (from the outer edge: the enemy list is mirrored)
      var bar = document.createElement('i'); bar.className = 'fill';
      var pl = document.createElement('span'); pl.className = 'pl'; pl.textContent = r.v.player || '';
      // 19.11 (BACKLOG 109): the vehicle as Bullba Hits' tile in its compact one-line mode (class mark, tier, name - no flag:
      // the list lies over the 3D view), and the 'hits' button that opens the shots panel beside this list
      var nm = BullbaRows.vehicleTile(tileOf(r), true, { compact: true }); nm.classList.add('nm');
      nm.querySelector('.vt-name').textContent += (r.md.model ? '' : ' [box]') + (r.v.modulesMatch === false ? ' [other turret/gun]' : '');
      nm.title = r.v.type + (r.v.modulesMatch == null ? ' - turret/gun of the battle not compared' : (r.v.modulesMatch ? ' - turret/gun as in the battle' : ' - the battle had another turret/gun'));
      var side = r.role === 'enemy' ? 'enemy' : 'own', box = side === 'enemy' ? boxEnemy : boxOwn;
      var hb = BullbaShotsPanel.button(function () { shotsPanel().toggle(r.v.id, box, side); });
      el.appendChild(bar); el.appendChild(pl); el.appendChild(nm); el.appendChild(hb);
      el.onclick = function () { setFollow(follow === r ? null : r); };
      box.appendChild(el); listRows.push({ r: r, el: el, bar: bar, base: base, hb: hb });
    });
    if (listRows.length) renderList(false);  // round 9: a map alone has no vehicles
  }

  var lastList = 0, lastMeter = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
    if (lastFrame) intervals.push([now, now - lastFrame]);
    lastFrame = now;
    if (playing) { t += dt * speed; if (t >= tEnd) { t = tEnd; togglePlay(); } }
    keyMove(dt);
    var c0 = performance.now(), cq = null;
    if (costOn && timerExt && !benchBusy && costQ.length < 6) { cq = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, cq); }
    step(t);  // inside the timers: the cascades' shadow maps are drawn here
    if (sheetOn) renderer.render(sheetOn.scene, sheetOn.cam); else renderer.render(scene, camera);
    if (cq) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); costQ.push(cq); }
    cpuTimes.push([now, performance.now() - c0]);
    if (costOn) costTick(now);
    if (now - lastList > 250) { lastList = now; renderList(false); tickDestrList(); $('slider').value = t; $('time').textContent = fmt(t) + '  (battle ' + fmt(t - tBattle) + ')'; }
    if (now - lastMeter > 500) {
      lastMeter = now;
      var iv = window3s(intervals, now), cp = window3s(cpuTimes, now);
      var sum = iv.reduce(function (a, b) { return a + b; }, 0);
      $('m-fps').textContent = sum ? (1000 * iv.length / sum).toFixed(1) : '-';
      $('m-int').textContent = quant(iv, 0.5).toFixed(1) + ' / ' + quant(iv, 0.95).toFixed(1) + ' ms';
      $('m-cpu').textContent = quant(cp, 0.5).toFixed(2) + ' / ' + quant(cp, 0.95).toFixed(2) + ' ms';
      $('m-calls').textContent = renderer.info.render.calls;
      $('m-tris').textContent = renderer.info.render.triangles.toLocaleString('en');
      $('m-destr').textContent = dApplied + ' / ' + dEvents.length;
    }
  }
  function step(time) {
    var d0 = dApplied, rs = dTime > time;
    stepDestruction(time); if (dApplied !== d0 || rs) shadowDirty();  // objects broke / the battle went back: casters changed
    stepFlash(time);
    poseVehicles(time); poseTracers(time); fxStep(time); placeCamera(); splitPlants(false); placeSun();  // placeSun last: it reads the casters' redraw flag
  }

  // ------------------------------------------------------------------ bench: synchronised frame cost per layer set
  // Each frame: render, then readPixels of one pixel, which waits for the GPU (gl.finish does not in Chrome: KNOWLEDGE
  // client, steady-60). The time is CPU + GPU of one frame at the current canvas size, independent of vsync. With
  // shadows on a frame is two passes (shadow map + view).
  var px = new Uint8Array(4);
  function syncedFrame() {
    var a = performance.now(); renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return performance.now() - a;
  }
  var ALL = { terrain: 1, visual: 1, objects: 0, trees: 1, bushes: 1, vehicles: 1, tracers: 1, water: 1, mode: 1 };
  function cfg(over, shadows) { var o = {}; Object.keys(ALL).forEach(function (k) { o[k] = k in over ? over[k] : ALL[k]; }); return [o, shadows]; }
  var CONFIGS = [
    ['all', cfg({}, true)],
    ['all, no shadows', cfg({}, false)],
    ['no objects', cfg({ visual: 0, objects: 0 }, true)],
    ['collision instead of models', cfg({ visual: 0, objects: 1 }, true)],
    ['no trees/bushes', cfg({ trees: 0, bushes: 0 }, true)],
    ['no terrain', cfg({ terrain: 0 }, true)],
    ['vehicles only', cfg({ terrain: 0, visual: 0, objects: 0, trees: 0, bushes: 0, water: 0, mode: 0 }, true)],
    ['nothing', cfg({ terrain: 0, visual: 0, objects: 0, trees: 0, bushes: 0, vehicles: 0, tracers: 0, water: 0, mode: 0 }, false)]
  ];
  function views() {
    var own = vehicles.filter(function (r) { return r.v.own; })[0] || vehicles[0];
    var a = mapData.arena, cx = (a[0] + a[2]) / 2, cz = (a[1] + a[3]) / 2;
    return [
      ['overview', function () { setFollow(null); cam.tx = cx; cam.tz = cz; cam.ty = 20; cam.yaw = 0.6; cam.pitch = 0.75; cam.dist = 850; }],
      ['ground, behind own', function () { setFollow(own); cam.yaw = 0.3; cam.pitch = 0.18; cam.dist = 22; }]
    ];
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // GPU execution time of one frame (all its passes) by EXT_disjoint_timer_query_webgl2: what this page's own work
  // costs the GPU, apart from the time it waits behind another program on the same GPU (the game, here)
  var timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'), lastCpu = [];
  async function gpuTimes(n, pre) {
    if (!timerExt) return [];
    var qs = []; lastCpu = [];
    for (var i = 0; i < n; i++) {
      var q = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
      if (pre) pre();  // round 5c: inside the timed span (the cascades draw their maps in step())
      var c0 = performance.now(); renderer.render(scene, camera); lastCpu.push(performance.now() - c0);
      gl.endQuery(timerExt.TIME_ELAPSED_EXT); qs.push(q);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    var out = [], tries = 0;
    while (qs.length && tries++ < 200) {
      await sleep(5);
      if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) { qs.forEach(function (q) { gl.deleteQuery(q); }); return out; }
      qs = qs.filter(function (q) {
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
        out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); return false;
      });
    }
    return out;
  }
  async function runBench(frames) {
    frames = frames || 60;
    await ensureCollision(); benchBusy = true;
    var was = playing; if (playing) togglePlay();
    var saved = {}; Object.keys(layers).forEach(function (k) { saved[k] = layers[k].visible; });
    var savedShadows = shadowsOn;
    var tb = Math.min(tEnd, tBattle + 120);
    t = tb; var out = { map: MAP, time: tb, frames: frames, canvas: renderer.domElement.width + 'x' + renderer.domElement.height,
      gpu: gpuName(), ua: navigator.userAgent, shadowMap: sun.shadow.mapSize.x, rows: [] };
    var vs = views();
    for (var v = 0; v < vs.length; v++) {
      vs[v][1]();
      for (var c = 0; c < CONFIGS.length; c++) {
        var conf = CONFIGS[c][1];
        Object.keys(conf[0]).forEach(function (k) { layers[k].visible = !!conf[0][k]; });
        layers.helpers.visible = false;
        setShadows(conf[1]);
        step(t);
        for (var w = 0; w < 5; w++) syncedFrame();
        var ts = [];
        for (var f = 0; f < frames; f++) ts.push(syncedFrame());
        var gt = await gpuTimes(Math.min(frames, 60));
        out.rows.push({ view: vs[v][0], layers: CONFIGS[c][0], median: +quant(ts, 0.5).toFixed(2), p95: +quant(ts, 0.95).toFixed(2),
          gpuMedian: gt.length ? +quant(gt, 0.5).toFixed(2) : null, gpuP95: gt.length ? +quant(gt, 0.95).toFixed(2) : null,
          cpuMedian: lastCpu.length ? +quant(lastCpu, 0.5).toFixed(2) : null, cpuP95: lastCpu.length ? +quant(lastCpu, 0.95).toFixed(2) : null,
          calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
        await sleep(0);
      }
    }
    out.vehiclesInSight = vehicles.filter(function (r) { return r.visible; }).length;
    Object.keys(saved).forEach(function (k) { layers[k].visible = saved[k]; });
    setShadows(savedShadows);
    Array.prototype.forEach.call(document.querySelectorAll('[data-layer]'), function (c) { c.checked = c.dataset.layer === 'objects' ? (layers.visual.visible || layers.objects.visible) : layers[c.dataset.layer].visible; });
    if (was) togglePlay();
    showBench(out); benchBusy = false;
    window.__bench = out;
    return out;
  }
  function showBench(o) {
    var h = '<div><b>Bench</b> ' + o.map + ', t=' + fmt(o.time) + ', ' + o.canvas + ', ' + o.frames + ' synced frames, ' + o.vehiclesInSight + ' vehicles in sight, shadow map ' + o.shadowMap + '</div>' +
      '<table><tr><th>view / layers</th><th>synced median ms</th><th>p95</th><th>GPU median ms</th><th>CPU median ms</th><th>calls</th><th>triangles</th></tr>';
    o.rows.forEach(function (r) { h += '<tr><td>' + r.view + ' / ' + r.layers + '</td><td>' + r.median + '</td><td>' + r.p95 + '</td><td>' + r.gpuMedian + '</td><td>' + r.cpuMedian + '</td><td>' + r.calls + '</td><td>' + r.triangles.toLocaleString('en') + '</td></tr>'; });
    $('bench').innerHTML = h + '</table>'; $('bench').style.display = 'block';
  }
  async function runPlayback(seconds, from) {
    t = from == null ? tBattle + 60 : from; if (!playing) togglePlay();
    intervals.length = 0; cpuTimes.length = 0;
    var start = performance.now();
    await sleep(seconds * 1000);
    var all = intervals.filter(function (x) { return x[0] >= start; }).map(function (x) { return x[1]; });
    var c = cpuTimes.filter(function (x) { return x[0] >= start; }).map(function (x) { return x[1]; });
    if (playing) togglePlay();
    var sum = all.reduce(function (a, b) { return a + b; }, 0);
    return { map: MAP, seconds: seconds, frames: all.length, fps: +(1000 * all.length / sum).toFixed(1), intervalMedian: +quant(all, 0.5).toFixed(2),
      intervalP95: +quant(all, 0.95).toFixed(2), renderCpuMedian: +quant(c, 0.5).toFixed(2), renderCpuP95: +quant(c, 0.95).toFixed(2),
      calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, canvas: renderer.domElement.width + 'x' + renderer.domElement.height };
  }
  // ------------------------------------------------------------------ cost readout (round 5, off by default): what the
  // current view costs, apart from the frame cap. GPU time by EXT_disjoint_timer_query_webgl2 (queries read back a few
  // frames later; a disjoint event drops them).
  var costOn = false, costQ = [], gpuHist = [], benchBusy = false, lastCost = 0, shRedrawHist = [];
  function groundCost() {
    // bytes on the GPU of the current ground mode's own textures (estimate: compressed bytes as stored, RGBA x 4/3 with
    // generated mips) and the bytes of its data
    var k = groundKey, g, gpu = 0, data = 0;
    if (G5_MODES[k]) return g5State === 'built' ? { gpu: g5Info.gpuBytes, data: g5Info.bytesLoaded, file: MAP + '.ground5.js', load: g5Info.loadMs } : { gpu: 0, data: 0 };
    g = k === 'stratsketch' ? refGround() : mapData.terrain[k];
    if (!g) return { gpu: 0, data: 0 };
    if (g.bc1) g.bc1.forEach(function (l) { gpu += b64Bytes(l.bc1); data += b64Bytes(l.bc1); });
    else { var tex = groundTex[k], im = tex && tex.image; gpu = im && im.width ? Math.round(im.width * im.height * 4 * 4 / 3) : 0; data = b64Bytes(g.png || g.b64); }
    gpu += Math.round(256 * 256 * 4 * 4 / 3);  // the shared noise detail texture
    return { gpu: gpu, data: data, file: k === 'stratsketch' ? MAP + '.ref.js' : MAP + '.map.js (always loaded)' };
  }
  function costTick(now) {
    costQ = costQ.filter(function (q) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) gpuHist.push([now, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6]);
      gl.deleteQuery(q); return false;
    });
    while (gpuHist.length && now - gpuHist[0][0] > 1000) gpuHist.shift();
    if (now - lastCost < 250) return;
    lastCost = now;
    var iv = intervals.filter(function (x) { return now - x[0] <= 1000; }).map(function (x) { return x[1]; });
    var cp = cpuTimes.filter(function (x) { return now - x[0] <= 1000; }).map(function (x) { return x[1]; });
    var gp = gpuHist.map(function (x) { return x[1]; }), gc = groundCost(), mb = function (b) { return (b / 1048576).toFixed(2) + ' MB'; };
    $('c-int').textContent = quant(iv, 0.5).toFixed(1) + ' / ' + quant(iv, 0.95).toFixed(1) + ' ms';
    $('c-cpu').textContent = quant(cp, 0.5).toFixed(2) + ' / ' + quant(cp, 0.95).toFixed(2) + ' ms';
    $('c-gpu').textContent = !timerExt ? 'not available here' : (gp.length ? quant(gp, 0.5).toFixed(2) + ' / ' + quant(gp, 0.95).toFixed(2) + ' ms' : 'waiting');
    $('c-tris').textContent = renderer.info.render.triangles.toLocaleString('en') + ' / ' + renderer.info.render.calls;
    $('c-ground').textContent = mb(gc.gpu) + ' on GPU, ' + mb(gc.data) + ' data' + (gc.load != null ? ', load ' + gc.load + ' ms' : '');
    var rdN = CSM.redraws[0] + CSM.redraws[1] + CSM.redraws[2]; shRedrawHist.push([now, rdN]);
    while (shRedrawHist.length > 1 && now - shRedrawHist[0][0] > 1000) shRedrawHist.shift();
    $('c-shadow').textContent = shadowsOn ? mb(shadowBytes()) + ' (on' + (SH_Q[SHQ].csm ? ', 3 maps' : '') + '), ' + (rdN - shRedrawHist[0][1]) + ' full redraws / s' : 'off';
  }

  // ------------------------------------------------------------------ ground bench (round 5): every ground mode x
  // shadows on / off at the close, mid and top views (the views of the round-5 screenshots), synced frames
  var GROUND_KEYS = ['g5full', 'g5global', 'g5layers', 'groundLayers', 'groundLayersRaw', 'ground', 'minimap', 'stratsketch'];
  function views5() {
    var P = MAP === 'prohorovka', at = tBattle + 120;
    return {
      close: function () { t = at; setFollow(vehicles.filter(function (r) { return r.v.own; })[0] || vehicles[0]); cam.yaw = 2.4; cam.pitch = 0.08; cam.dist = 12; },
      mid: function () { t = at; setFollow(null); cam.tx = 0; cam.tz = 0; cam.ty = heightAt(0, 0) + 1; cam.yaw = 0.6; cam.pitch = 0.55; cam.dist = 260; },
      closeTilted: function () { t = at; setFollow(null); var x = P ? 90 : 0, z = P ? -150 : 0; cam.tx = x; cam.tz = z; cam.ty = heightAt(x, z) + 1; cam.yaw = 1.57; cam.pitch = 1.0; cam.dist = 8; },
      top: function () { t = at; setFollow(null); cam.tx = 0; cam.tz = 0; cam.ty = heightAt(0, 0) + 1; cam.yaw = 0; cam.pitch = 1.55; cam.dist = P ? 1250 : 1000; }
    };
  }
  async function runGroundBench(frames, keys, viewNames) {
    frames = frames || 60; benchBusy = true;
    var was = playing; if (playing) togglePlay();
    var savedGround = groundKey, savedShadows = shadowsOn, vs = views5();
    keys = (keys || GROUND_KEYS).filter(function (k) { return k !== 'stratsketch' || store['ref:' + MAP]; });
    var out = { map: MAP, frames: frames, canvas: renderer.domElement.width + 'x' + renderer.domElement.height, gpu: gpuName(), ua: navigator.userAgent,
      timer: !!timerExt, shadowMap: sun.shadow.mapSize.x, relief: $('sel-relief').value, rows: [] };
    for (var vi = 0, vn = viewNames || ['close', 'mid', 'top']; vi < vn.length; vi++) {
      vs[vn[vi]]();
      for (var ki = 0; ki < keys.length; ki++) {
        await setGround(keys[ki]);
        for (var s = 0; s < 2; s++) {
          setShadows(s === 0); step(t); shadowHalf = 0; placeSun();
          for (var w = 0; w < 5; w++) syncedFrame();
          var ts = []; for (var f = 0; f < frames; f++) ts.push(syncedFrame());
          var gt = await gpuTimes(Math.min(frames, 60)), gc = groundCost();
          out.rows.push({ view: vn[vi], ground: keys[ki], shadows: s === 0, median: +quant(ts, 0.5).toFixed(2), p95: +quant(ts, 0.95).toFixed(2),
            gpuMedian: gt.length ? +quant(gt, 0.5).toFixed(3) : null, gpuP95: gt.length ? +quant(gt, 0.95).toFixed(3) : null,
            cpuMedian: lastCpu.length ? +quant(lastCpu, 0.5).toFixed(2) : null, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
            groundGpuBytes: gc.gpu, groundDataBytes: gc.data, groundLoadMs: gc.load == null ? null : gc.load });
          await sleep(0);
        }
      }
    }
    await setGround(savedGround); setShadows(savedShadows);
    if (was) togglePlay();
    benchBusy = false;
    var h = '<div><b>Ground bench</b> ' + out.map + ', ' + out.canvas + ', ' + frames + ' synced frames per row, ' + out.gpu + '</div><table><tr><th>view / ground / shadows</th><th>synced median</th><th>p95</th><th>GPU median</th><th>GPU p95</th><th>triangles</th><th>ground GPU MB</th></tr>';
    out.rows.forEach(function (r) { h += '<tr><td>' + r.view + ' / ' + r.ground + ' / ' + (r.shadows ? 'on' : 'off') + '</td><td>' + r.median + '</td><td>' + r.p95 + '</td><td>' + r.gpuMedian + '</td><td>' + r.gpuP95 + '</td><td>' + r.triangles.toLocaleString('en') + '</td><td>' + (r.groundGpuBytes / 1048576).toFixed(2) + '</td></tr>'; });
    $('bench').innerHTML = h + '</table>'; $('bench').style.display = 'block';
    window.__gbench = out;
    return out;
  }
  // shadow bench (round 5b): GPU time per frame at the mid and top views, shadows off / round 5 / soft / sharp, the
  // shadow map re-rendered every frame (as while playing or moving the camera) or not (a still view)
  async function runShadowBench(frames, viewNames) {
    frames = frames || 60; benchBusy = true;
    var was = playing; if (playing) togglePlay();
    var savedQ = SHQ, savedOn = shadowsOn, vs = views5();
    var out = { map: MAP, frames: frames, canvas: renderer.domElement.width + 'x' + renderer.domElement.height, gpu: gpuName(), timer: !!timerExt, ground: groundKey, rows: [] };
    // round 5c: 'playing' = the battle time advances 1/60 s per frame and step() runs (each mode's own redraw policy);
    // 'every frame' = every shadow map redrawn every frame (the camera moving)
    var confs = [['off', 'soft', false, 0], ['soft 5b (one 2048 map), still', 'soft5b', true, 0], ['soft 5b, playing', 'soft5b', true, 2],
      ['soft (3 cascades), still', 'soft', true, 0], ['soft (3 cascades), playing', 'soft', true, 2], ['soft (3 cascades), camera orbiting 0.6 deg/frame', 'soft', true, 3], ['soft (3 cascades), all maps redrawn every frame', 'soft', true, 1],
      ['soft 5b, camera orbiting', 'soft5b', true, 3],
      ['sharp, still', 'sharp', true, 0], ['sharp, playing', 'sharp', true, 2]];
    var vn = viewNames || ['mid', 'top'];
    for (var vi = 0; vi < vn.length; vi++) {
      for (var ci = 0; ci < confs.length; ci++) {
        var cf = confs[ci]; vs[vn[vi]](); setShadowQuality(cf[1]); setShadows(cf[2]);
        step(t); shadowsRedrawAll(); syncedFrame();
        for (var w = 0; w < 5; w++) { step(t); syncedFrame(); }
        var mode = cf[3], t0b = t, y0b = cam.yaw, pre = function () { if (mode === 3) { cam.yaw += 0.01; step(t); } else if (mode === 2) { t += 1 / 60; step(t); } else if (mode === 1) { shadowsRedrawAll(); step(t); } else step(t); };
        var r0 = CSM.redraws.slice();
        var gt = await gpuTimes(frames, pre); t = t0b; cam.yaw = y0b;
        out.rows.push({ view: vn[vi], shadows: cf[0], gpuMedian: gt.length ? +quant(gt, 0.5).toFixed(3) : null, gpuP95: gt.length ? +quant(gt, 0.95).toFixed(3) : null,
          cpuMedian: lastCpu.length ? +quant(lastCpu, 0.5).toFixed(2) : null, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
          shadowMapMB: cf[2] ? +(shadowBytes() / 1048576).toFixed(1) : 0, boxSide: SH_Q[SHQ].csm ? CSM.info.map(function (c) { return c.side; }).join('/') : +(sun.shadow.camera.right - sun.shadow.camera.left).toFixed(1),
          cascadeRedraws: CSM.redraws.map(function (n, k) { return n - r0[k]; }).join('/') });
        await sleep(0);
      }
    }
    setShadowQuality(savedQ); setShadows(savedOn);
    if (was) togglePlay();
    benchBusy = false;
    var h = '<div><b>Shadow bench</b> ' + out.map + ', ' + out.canvas + ', ' + frames + ' frames per row, ' + out.gpu + '</div><table><tr><th>view / shadows</th><th>GPU median</th><th>GPU p95</th><th>shadow map MB</th><th>box m</th></tr>';
    out.rows.forEach(function (r) { h += '<tr><td>' + r.view + ' / ' + r.shadows + '</td><td>' + r.gpuMedian + '</td><td>' + r.gpuP95 + '</td><td>' + r.shadowMapMB + '</td><td>' + r.boxSide + '</td></tr>'; });
    $('bench').innerHTML = h + '</table>'; $('bench').style.display = 'block';
    return out;
  }
  // colour bytes of the shadow maps in use (each also has a depth buffer of the same size, not counted)
  function shadowBytes() { var o = SH_Q[SHQ], n = 0; csmSuns.forEach(function (l, k) { if (k === 0 || o.csm) n += l.shadow.mapSize.x * l.shadow.mapSize.y * 4; if (o.csm && csmCache[k]) n += csmCache[k].width * csmCache[k].height * 4; }); return n; }  // + the cascades' static copies
  // round 5c: how much of the ground in view the shadow maps cover - a grid of 32 x 18 screen rays marched to the
  // terrain, each hit tested against the boxes (inside by more than 4 % of a box: where the edge fade does not reach)
  function shadowCoverage() {
    camera.updateMatrixWorld(); var hits = 0, inside = 0, dir = new T.Vector3(), p = new T.Vector3(), q = new T.Vector3();
    var o = SH_Q[SHQ], cams = o.csm ? csmSuns.map(function (l) { return l.shadow.camera; }) : [sun.shadow.camera];
    var V = new T.Matrix4().copy(o.r5b || o.oldBox ? sun.shadow.camera.matrixWorldInverse : shCam.matrixWorldInverse);
    if (o.oldBox) { sun.shadow.camera.position.copy(sun.position); sun.shadow.camera.lookAt(sun.target.position); sun.shadow.camera.updateMatrixWorld(); V.copy(sun.shadow.camera.matrixWorldInverse); }
    if (o.r5b) V.copy(shCam.matrixWorldInverse);
    for (var j = 0; j < 18; j++) for (var i = 0; i < 32; i++) {
      dir.set((i + 0.5) / 16 - 1, (j + 0.5) / 9 - 1, 1).unproject(camera).sub(camera.position).normalize();
      var s = 0.5, hit = false;
      while (s < 3000) { p.copy(camera.position).addScaledVector(dir, s); if (p.y < heightAt(p.x, -p.z)) { hit = true; break; } s += 0.25 + s * 0.01; }
      if (!hit) continue;
      var ax = -p.z, bx = mapData.box; if (p.x < bx[0] || p.x > bx[2] || ax < bx[1] || ax > bx[3]) continue;
      if (o.csm && (CSM.fade[0] < 1e5) && fT1.set(0, 0, -1).transformDirection(camera.matrixWorld).dot(q.copy(p).sub(camera.position)) > CSM.fade[0]) continue;
      hits++; q.copy(p).applyMatrix4(V);
      if (cams.some(function (c) { var mx = (c.right - c.left) * 0.04, my = (c.top - c.bottom) * 0.04; return q.x > c.left + mx && q.x < c.right - mx && q.y > c.bottom + my && q.y < c.top - my; })) inside++;
    }
    return { groundRays: hits, covered: hits ? +(inside / hits).toFixed(3) : null };
  }
  function shadowInfo() {
    var o = SH_Q[SHQ];
    return { mode: SHQ, camTargetY: +cam.ty.toFixed(1), groundUnderTarget: +heightAt(cam.tx, cam.tz).toFixed(1), coverage: shadowCoverage(),
      cascades: o.csm ? CSM.info : null, depth: CSM.depth, fade: CSM.fade, box: o.csm ? null : +(sun.shadow.camera.right - sun.shadow.camera.left).toFixed(1), redraws: CSM.redraws.slice() };
  }
  // round 5e: does each cascade's map hold the vehicles? Per visible vehicle and cascade, the packed depth of the map
  // and of the static cache at the texel above the vehicle's centre (1.5 m up): unequal = the vehicle is drawn in
  function vehicleShadowInfo(progs) {
    var o = SH_Q[SHQ], px4 = new Uint8Array(4), out = [];
    if (progs) return renderer.info.programs.map(function (p) {
      var sh = gl.getAttachedShaders(p.program), fs = sh.map(function (s) { return gl.getShaderSource(s); }).join('\n');
      var m = /#define NUM_DIR_LIGHT_SHADOWS (\d+)/.exec(fs);
      return { name: p.name, users: p.usedTimes, dirShadows: m ? +m[1] : null, csm: fs.indexOf('directLight.color *= csmShadow') >= 0, receive: fs.indexOf('USE_SHADOWMAP') >= 0 };
    });
    function depthAt(rt, ix, iy) { renderer.readRenderTargetPixels(rt, ix, iy, 1, 1, px4); return px4[3] / 255 + px4[2] / 65280 + px4[1] / 16711680 + px4[0] / 4278190080; }  // three's RGBA packing: alpha the coarsest
    vehicles.forEach(function (r, i) {
      if (!r.visible || !r.group.visible) return;
      var row = { i: i, role: r.role, cascades: [] };
      for (var c = 0; c < (o.csm ? 3 : 1); c++) {
        var L = csmSuns[c], m = L.shadow.map; if (!m) { row.cascades.push(null); continue; }
        var p = r.group.getWorldPosition(new T.Vector3()); p.y += 1.5; p.project(L.shadow.camera);  // the root mirrors z: world, not group position
        if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) { row.cascades.push('outside'); continue; }
        var ix = Math.floor((p.x + 1) / 2 * m.width), iy = Math.floor((p.y + 1) / 2 * m.height);
        var dm = depthAt(m, ix, iy), dc = o.csm && csmCache[c] ? depthAt(csmCache[c], ix, iy) : null;
        row.cascades.push({ map: +dm.toFixed(5), cache: dc == null ? null : +dc.toFixed(5), vehicleIn: dc == null ? null : Math.abs(dm - dc) > 1e-4 });
        if (c === 0 && r.role === 'own') {  // ground points along the shadow's direction: map depth vs the receiver's own depth
          row.walk = [];
          var g = r.group.getWorldPosition(new T.Vector3()), dir = SUN_DIR.clone().setY(0).normalize().negate();
          for (var s = 0; s <= 8; s += 1) {
            var w = g.clone().addScaledVector(dir, s); w.y = heightAt(w.x, -w.z) + 0.05;
            var q = w.clone().project(L.shadow.camera), jx = Math.floor((q.x + 1) / 2 * m.width), jy = Math.floor((q.y + 1) / 2 * m.height);
            row.walk.push([s, +((q.z + 1) / 2).toFixed(5), +depthAt(m, jx, jy).toFixed(5)]);
          }
        }
      }
      out.push(row);
    });
    return out;
  }
  function gpuName() {
    var ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  // ------------------------------------------------------------------ the map built in the page
  // ../mapraw/<arena>/ + ../mapraw/res/ (the mod's map_raw.py: the game's own files, copied) -> mapbuild.js + mapbuild9.js
  // in a blob worker -> IndexedDB (mapbuild-page.js): terrain, global colour map, light map, water, sun, mode objects,
  // object visual models and atlas, collision records, plants, destruction lookup.
  var jsBuild = null;
  function jsMap(b) {
    var arena = b.meta.map, gameplay = b.meta.gameplay;
    return MapBuildPage.obtain({ arena: arena, gameplay: gameplay, minimapFit: !!MapBuild.MINIMAP_RENDERED[arena], rawRoot: BASE + 'mapraw/', builderBase: PAGE_BASE + 'playback/',
      client: FILE && FILE.record && FILE.record.client || null, ask: host.canSend() ? askMap : null,
      progress: function (text) { $('msg').textContent = text; } }).then(function (r) {
      var A = r.arena, M = r.map;
      var t = Object.assign({}, A.terrain, { groundGlobal: { x0: A.glob.x0, z0: A.glob.z0, px: A.glob.px, w: A.glob.w, h: A.glob.h, bc1: A.glob.bc1 }, groundDefault: 'groundGlobal' });
      store['map:' + MAP] = { key: MAP, title: b.meta.mapTitle || arena.replace(/^\d+_/, '').replace(/_/g, ' '), arena: A.arenaBox, box: A.box, gameplay: gameplay,
        visibilityBit: M.visibilityBit, terrain: t, objects: M.objects, visual: M.visual, atlas: M.atlas, visualStats: M.visualStats, trees: M.trees,
        water: A.water, mode: M.mode, sun: A.sun, lookup: M.lookup,
        haze: HAZE_ENV[{ '05_prohorovka': 'prohorovka', '07_lakeville': 'lakeville' }[arena]] };  // the two maps the trial read fog values of
      store['ground5:' + MAP] = { key: MAP, glob: Object.assign({}, A.glob, { fit: M.globFit || null }), jsOnly: true };
      if (M.light) store['light5c:' + MAP] = Object.assign({ key: MAP }, M.light);
      // destruction: the mod keeps it raw (playback.py), the map's lookup resolves it (the trial's build_destruction)
      var d = MapBuild.destruction(b.destroyed || [], M.lookup);
      b.destruction = d.events; b.destructionStats = d.stats;
      jsBuild = r.info;
    });
  }

  // ------------------------------------------------------------------ the battle's vehicles from the product's own files
  // data/vehicles/<type>.js and data/models/<key>.js (the exporter's; contract: docs/contract-vehicles.md): each part's
  // collision model in its rest transform, hull + chassis + wheels in one mesh, turret and gun about their pivots (the
  // trial's build.build_vehicles). A vehicle without a file is drawn as a box.
  function wheelMesh(w) {
    var n = Math.max(6, (w.sides | 0) || 12), r = w.radius, hw = w.width / 2, vs = [], ids = [], k, a;
    [-hw, hw].forEach(function (side) { for (k = 0; k < n; k++) { a = 2 * Math.PI * k / n; vs.push([side, r * Math.cos(a), r * Math.sin(a)]); } });
    for (k = 0; k < n; k++) { a = k; var b2 = (k + 1) % n; ids.push(a, b2, n + a, b2, n + b2, n + a); }
    [[0, 0], [1, n]].forEach(function (cb) {
      vs.push([cb[0] === 0 ? -hw : hw, 0, 0]); var ctr = vs.length - 1;
      for (k = 0; k < n; k++) { if (cb[0] === 0) ids.push(ctr, cb[1] + (k + 1) % n, cb[1] + k); else ids.push(ctr, cb[1] + k, cb[1] + (k + 1) % n); }
    });
    return { groups: [{ vertices: vs, indices: ids }] };
  }
  function turretGun(cd) {
    if (!cd) return null;
    var s = atob(cd), p = (s.charCodeAt(0) & 2 ? 3 : 2) + 8;
    if (s.length < p + 4) return null;
    return [s.charCodeAt(p) | s.charCodeAt(p + 1) << 8, s.charCodeAt(p + 2) | s.charCodeAt(p + 3) << 8];
  }
  function vehicleModel(veh, docs) {
    var parts = {}, wheels = [];
    veh.parts.forEach(function (p) {
      if (p.wheel) { parts[p.name] = [p.transform, wheelMesh(p.wheel)]; wheels.push(p.name); return; }
      var m = docs[p.modelKey]; if (m) parts[p.name] = [p.transform, m];
    });
    ['chassis', 'hull', 'turret', 'gun'].forEach(function (n) { if (!parts[n]) throw new Error('part ' + n + ' missing'); });
    var tt = parts.turret[0], gt = parts.gun[0];
    // round 13: gv - each vertex's entry in gt; gt - one [part id, outer layer] per collision group; outer as Hits'
    // viewer.externalLayer: the chassis (tracks), wheels, an outer track pair, or armour with vehicleDamageFactor ~0
    // (a spaced screen) - for the Hits look (hitsGeometry)
    var pinfo = {};
    veh.parts.forEach(function (p) { pinfo[p.name] = [p.wheel ? -1 : (p.id == null ? -1 : p.id), p.armor || {}]; });
    function geo(names, off) {
      var vs = [], ids = [], gv = [], gt = [];
      names.forEach(function (n) {
        var tr = parts[n][0], pid = pinfo[n][0], armor = pinfo[n][1];
        parts[n][1].groups.forEach(function (g) {
          var a = armor[g.material] || {}, vdf = a.vehicleDamageFactor;
          gt.push([pid, pid <= 0 || pid >= 4 || (typeof vdf === 'number' && vdf <= 1e-5) ? 1 : 0]);
          for (var q = 0; q < g.vertices.length; q++) gv.push(gt.length - 1);
          var base = vs.length / 3;
          g.vertices.forEach(function (v) {
            vs.push(tr[0] * v[0] + tr[4] * v[1] + tr[8] * v[2] + tr[12] - off[0], tr[1] * v[0] + tr[5] * v[1] + tr[9] * v[2] + tr[13] - off[1],
              tr[2] * v[0] + tr[6] * v[1] + tr[10] * v[2] + tr[14] - off[2]);
          });
          g.indices.forEach(function (i) { ids.push(base + i); });
        });
      });
      var big = vs.length / 3 >= 65536;
      return { v: new Float32Array(vs), i: big ? new Uint32Array(ids) : new Uint16Array(ids), i32: big, nt: ids.length / 3, gv: new Uint16Array(gv), gt: gt };
    }
    var samples = (veh.gunPitchLimits || {}).samples || [], pmin = -0.2, pmax = 0.1;
    if (samples.length) { pmin = Math.min.apply(null, samples.map(function (s) { return s[1]; })); pmax = Math.max.apply(null, samples.map(function (s) { return s[2]; })); }
    var gun = geo(['gun'], gt.slice(12, 15)), gl0 = 0;
    for (var q = 2; q < gun.v.length; q += 3) if (gun.v[q] > gl0) gl0 = gun.v[q];
    // tile: what Bullba Hits' vehicle tile shows (web/hit-rows.js) - the team lists and the shots panel (BACKLOG 109)
    return { model: true, name: veh.name, cls: veh['class'], tile: { name: veh.name, level: veh.level, 'class': veh['class'], role: veh.role, nation: veh.nation, type: veh.type }, turretAt: tt.slice(12, 15), gunAt: [gt[12] - tt[12], gt[13] - tt[13], gt[14] - tt[14]],
      pitch: [pmin, pmax], wheels: wheels.length, gunLength: gl0, turretGun: turretGun(veh.compactDescriptor),
      hull: geo(['chassis', 'hull'].concat(wheels), [0, 0, 0]), turret: geo(['turret'], tt.slice(12, 15)), gun: gun };
  }
  // files (the battle file's vehicleFiles, 19.11): {hits: [ids of data/vehicles], viewer: [ids of data/playback/vehicles -
  // the mod's vehicles from the client's XML]}; a type in neither is not read (a missing file is a console error) but
  // marked `missing`, for the mod to make (vehiclesFor). Without it (an older battle file) data/vehicles is tried.
  function loadVehicles(b, raw, files) {
    // raw (optional): each type's files as read, {veh, models} - the battle worker places the hit points with them
    var out = {}, types = {};
    var hits = files && files.hits ? new Set(files.hits) : null, viewer = new Set((files && files.viewer) || []);
    b.vehicles.forEach(function (v) { types[v.type] = true; });
    return Promise.all(Object.keys(types).map(function (typ) {
      var id = typ.replace(':', '-');
      var src = !hits || hits.has(id) ? 'data/vehicles/' : viewer.has(id) ? 'data/playback/vehicles/' : null;
      if (!src) { out[typ] = { model: false, missing: true, reason: 'no vehicle file' }; return null; }
      return loadData(src + id + '.js', 'vehicle:' + id).then(function (veh) {
        var keys = {}; veh.parts.forEach(function (p) { if (p.modelKey) keys[p.modelKey] = true; });
        return Promise.all(Object.keys(keys).map(function (k) { return loadData('data/models/' + k + '.js', 'model:' + k); })).then(function (docs) {
          var byKey = {}; Object.keys(keys).forEach(function (k, i) { byKey[k] = docs[i]; });
          if (raw) raw[typ] = { veh: veh, models: byKey };
          out[typ] = vehicleModel(veh, byKey);
        });
      }).catch(function (e) { out[typ] = { model: false, reason: String(e && e.message || e) }; });
    })).then(function () { return out; });
  }
  // The battle's vehicles with no file (a replay of another player, 19.11): the mod makes them ('playbackVehicles', with
  // the compact descriptor the battle's stream carries - the exporter's own route, else the client's XML) and says so
  // with the files there now; meanwhile the message line says it. Outside the game, or no word in VEHICLES_MS: boxes.
  var VEHICLES_MS = 120000;
  function vehiclesFor(b, raw) {
    var files = FILE && FILE.vehicleFiles;
    return loadVehicles(b, raw, files).then(function (m) {
      var missing = Object.keys(m).filter(function (t) { return m[t].missing; });
      if (!missing.length || !host.canSend()) return m;
      $('msg').textContent = 'Preparing the models of ' + missing.length + ' vehicle' + (missing.length > 1 ? 's' : '') + '...';
      var rows = missing.map(function (t) {
        var v = b.vehicles.filter(function (x) { return x.type === t && x.compDescr; })[0];
        return { type: t, descr: v ? v.compDescr : null };
      });
      var w = waitFor(function (n) { return n.kind === 'vehicles' && n.id === BID ? { value: n.files || files } : null; },
        function () { return Promise.reject(new Error('waiting')); }, VEHICLES_MS);
      host.send('bullba_hits', { action: 'playbackVehicles', battleId: BID, vehicles: rows }).catch(function (e) { console.warn('Bullba Hits playbackVehicles failed: ' + e.message); });
      return w.then(function (f) { return loadVehicles(b, raw, f); }, function () { return m; });
    });
  }

  // ------------------------------------------------------------------ the battle file: data/playback/<id>.js
  // written by the mod the first time a battle is opened here (playback.py: the battle record's parts, the names of its
  // source file and of the client's definitions file): the page reads it; missing, it asks the mod ('playback') and waits
  // for the mod's word that it is made (19.11: window.BullbaPlayback.notify, the mod's presentation.notify_page - no
  // polling of a missing file; a look every FALLBACK_MS only in case the word does not come). Outside the game nobody can
  // make it. The battle itself is built from the source in the page (battle-page.js, battle.js) and kept in IndexedDB.
  var host = window.BullbaHost || { game: false, canSend: function () { return false; } };
  var BASE = '../', PAGE_BASE = '', FORMAT = 2, FALLBACK_MS = 250 /* 19.11: in the game the mod's word never comes (the client has no executeJavascript), the look is how the page learns */, WAIT_MS = 10 * 60 * 1000;
  var received = {}, FILE = null, waited = { mod: 0 };
  window.ArmorInspectorData = { receive: function (pair) { received[pair[0]] = pair[1]; } };
  function loadData(src, key) {
    delete received[key];
    return load(BASE + src + '?read=' + Date.now()).then(function () {
      if (!(key in received)) throw new Error('not a data file: ' + src);
      var v = received[key]; delete received[key]; return v;
    });
  }
  // the mod's words to the page (19.11): {kind: 'playback', id, state} and {kind: 'map', arena, state, stage, done, total,
  // error}; waitFor(test, look) -> Promise: test(note) returns {value} or {error} to end the wait; look() (a Promise) is
  // tried every FALLBACK_MS meanwhile
  var listeners = [];
  window.BullbaPlayback = { notify: function (note) { listeners.slice().forEach(function (f) { try { f(note || {}); } catch (e) { console.warn(e); } }); } };
  function waitFor(test, look, maxMs) {
    var began = performance.now();
    return new Promise(function (ok, fail) {
      var timer = null, done = false;
      function finish(f, v) { if (done) return; done = true; clearTimeout(timer); listeners.splice(listeners.indexOf(listen), 1); waited.mod += performance.now() - began; f(v); }
      function listen(note) { var r = test(note); if (!r) return; if (r.error) finish(fail, new Error(r.error)); else finish(ok, r.value); }
      function again() {
        timer = setTimeout(function () {
          if (done) return;
          if (performance.now() - began > (maxMs || WAIT_MS)) return finish(fail, new Error('The game did not prepare this battle in time.'));
          look().then(function (v) { finish(ok, v); }, again);
        }, FALLBACK_MS);
      }
      listeners.push(listen); again();
    });
  }
  function ask(bid) {
    if (!host.canSend()) return Promise.resolve(false);
    return host.send('bullba_hits', { action: 'playback', battleId: bid }).then(function () { return true; }, function (e) { console.warn('Bullba Hits playback command failed: ' + e.message); return false; });
  }
  function readFile(bid) {
    return loadData('data/playback/' + bid + '.js', 'playback:' + bid).then(function (b) {
      // In the game a file of an earlier build (no client in its record) is asked for again (19.11, westfeld).
      if (b && b.format === FORMAT && (!host.canSend() || (b.record && b.record.client))) return b;
      throw new Error('format');
    });
  }
  function untilMade(bid) {
    $('msg').textContent = 'Preparing the replay of this battle...';
    var w = waitFor(function (n) { return n.kind === 'playback' && n.id === bid ? { value: null } : null; }, function () { return readFile(bid); });
    ask(bid);
    return w.then(function (v) { return v || readFile(bid); });
  }
  function battleFile(bid) {
    return readFile(bid).catch(function () {
      if (!host.canSend()) throw new Error('This battle is not prepared for the 3D replay yet. Open it here from Bullba Hits in the game once.');
      return untilMade(bid);
    }).then(function (b) { FILE = b; return b; });
  }
  // the battle from its source (BattlePage.obtain); its source or definitions file gone (removed by hand): the mod writes
  // them again (playback.current checks they are there) and says so
  function battleBuilt(info) {
    return BattlePage.obtain({ info: info, dataBase: BASE + 'data/', builderBase: PAGE_BASE + 'playback/' }).catch(function (e) {
      if (!e.missing) throw e;
      if (!host.canSend()) throw new Error('The replay files of this battle are missing. Open it here from Bullba Hits in the game once.');
      return untilMade(info.id).then(function () { $('msg').textContent = 'Reading the replay...'; return BattlePage.obtain({ info: info, dataBase: BASE + 'data/', builderBase: PAGE_BASE + 'playback/' }); });
    });
  }
  // the map's raw files (MapBuildPage.obtain's ask): the mod copies them ('mapRaw'), its words are the progress line
  var STAGES = { index: 'reading the game\'s package index', terrain: 'the terrain', objects: 'the objects and plants', writing: 'writing the files' };
  function askMap(params) {
    var arena = params.arena;
    var w = waitFor(function (n) {
      if (n.kind !== 'map' || n.arena !== arena) return null;
      if (n.state === 'ready') return { value: null };
      if (n.state === 'error') return { error: n.error || 'The map files could not be copied from the game.' };
      var st = STAGES[n.stage] || (n.state === 'queued' ? 'waiting for its turn' : 'starting');
      $('msg').textContent = 'Copying the map files from the game: ' + st + (n.stage === 'objects' && n.total ? ' (' + (n.done || 0) + ' / ' + n.total + ')' : '') + '...';
      return null;
    }, function () { return MapBuildPage.manifest(arena, BASE + 'mapraw/'); });
    host.send('bullba_hits', Object.assign({ action: 'mapRaw' }, params)).catch(function (e) { console.warn('Bullba Hits mapRaw command failed: ' + e.message); });
    return w;
  }
  // the page's one report of an opening (19.11): the mod writes it as one line of its log
  function report(r) {
    if (!host.canSend()) return;
    var J = r.jsBuild || {}, JT = J.times || {}, W = (J.worker || {}), B = r.battleBuild || {};
    var s = function (ms) { return ms == null || !isFinite(ms) ? null : +(ms / 1000).toFixed(3); };
    var rep = { battleId: BID, map: FILE && FILE.record && FILE.record.map, mapFrom: J.source || null, mapBuiltAt: J.builtAt || null, battleFrom: B.source || null,
      waitMod: s(waited.mod), loadRaw: J.source === 'built' ? s((W.loadRawScripts || 0) + (W.resScriptsLoad || 0)) : 0, buildMap: J.source === 'built' ? s(W.build) : 0,
      buildBattle: s(B.ms), total: s(r.total), webgl: !!(renderer && renderer.getContext && renderer.getContext()) };
    host.send('bullba_hits', { action: 'playbackReport', report: rep }).catch(function (e) { console.warn('Bullba Hits report failed: ' + e.message); });
    window.__report = rep;
  }

  // ------------------------------------------------------------------ the battle selector (top line)
  // The battles of the hits page (data/index.js, the list app.js shows), newest first; choosing one opens it as the hits
  // page's 3D button does - this page with #battle=<id> (the host kept), the mod preparing it if it is not ready yet.
  function battleWhen(seconds) {
    if (!isFinite(seconds)) return '';
    var d = new Date(seconds * 1000), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  // 19.11: the list is the replay FILES first (data/replay-files.js, the mod's replay_files: the game's replays folder and
  // the replay limit's keep folder, any player's, newest first; a file tied to a Hits battle opens under that battle's id),
  // then the Hits battles that have no file listed. Choosing either opens it the same way.
  var INDEX = null, FILES = null;
  function vehicleShort(type) {
    var n = String(type || '').split(':').pop();
    return n.replace(/^[A-Za-z]{1,4}\d+[a-zA-Z]?_/, '').replace(/_/g, ' ');
  }
  function fileWhen(f) {
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(f.when || '');
    return m ? m[3] + '.' + m[2] + ' · ' + m[4] + ':' + m[5] : '';
  }
  // round 14: a client's version as both spellings carry it - the list's client is the whole text of version.xml in the
  // user's game ('<version> v.2.4.1.1 #992 </version>'), a file's is its header's ('World of Tanks v.2.4.1.1 #992'):
  // compared as text they always differed, and every entry said "older client"
  function clientVersion(s) { var m = /(\d+(?:\.\d+)+)\s*#\s*(\d+)/.exec(String(s || '')); return m ? m[1] + '#' + m[2] : null; }
  // a file tied to a Hits battle takes what its own entry lacks (map, vehicle) from that battle's row
  function fileText(f, client) {
    var hb = f.battle && INDEX && Array.isArray(INDEX.battles) ? INDEX.battles.filter(function (b) { return b && b.id === f.battle; })[0] : null;
    var cv = clientVersion(client), fv = clientVersion(f.client);
    return [fileWhen(f), f.mapTitle || (hb && hb.map) || f.map, f.vehicle ? vehicleShort(f.vehicle) : hb && hb.vehicle && hb.vehicle.name, f.player].filter(Boolean).join(' · ') +
      (f.kept ? ' ★' : '') + (cv && fv && cv !== fv ? ' (older client)' : '');
  }
  function fileRows() { return FILES && Array.isArray(FILES.files) ? FILES.files.filter(function (f) { return f && f.id; }) : []; }
  function battleSelect(index) {
    if (index !== undefined) INDEX = index;
    var sel = $('sel-battle'), list = (INDEX && Array.isArray(INDEX.battles) ? INDEX.battles : []).filter(function (b) { return b && b.id; });
    var files = fileRows(), tied = {};
    files.forEach(function (f) { if (f.battle) tied[f.battle] = true; });
    BATTLES = list.filter(function (b) { return !tied[b.id]; }).sort(function (a, b) { return (+b.startedAt || 0) - (+a.startedAt || 0); });
    var known = files.some(function (f) { return (f.battle || f.id) === BID; }) || BATTLES.some(function (b) { return b.id === BID; });
    sel.replaceChildren();
    function add(parent, value, text) {
      var o = document.createElement('option'); o.value = value; o.textContent = text; o.selected = value === BID; parent.appendChild(o);
    }
    if (!BID) add(sel, '', 'Choose a replay');
    else if (!known) add(sel, BID, 'This battle');
    if (files.length) {
      var g = document.createElement('optgroup'); g.label = 'Replay files';
      files.forEach(function (f) { add(g, f.battle || f.id, fileText(f, FILES.client)); });
      sel.appendChild(g);
    }
    var parent = sel;
    if (files.length && BATTLES.length) { parent = document.createElement('optgroup'); parent.label = 'Bullba Hits battles'; sel.appendChild(parent); }
    BATTLES.forEach(function (b) {
      add(parent, b.id, b.map ? [battleWhen(+b.startedAt), b.map, b.vehicle && b.vehicle.name].filter(Boolean).join(' · ') : 'This battle');
    });
    sel.value = BID;
    noBattle();
  }
  // Opened with no battle (the viewer's own button): round 14 (the user, 19.11) - one list only, the selector at the top;
  // the separate panel of replays is gone (its rows, buttons with overflow:hidden in a flex column of 1200+ entries,
  // shrank to empty strips). The message in the middle points at the selector.
  function noBattle() {
    if (BID) return;
    var n = fileRows().length + BATTLES.length;
    $('msg').textContent = n ? 'Choose a replay in the battle list at the top: newest first, ★ kept forever by the replay limit.'
      : (FILES ? 'No replays in the game\'s replays folder yet.' : 'Reading the replays folder...');
  }
  function choose(id) {
    if (!/^[-a-zA-Z0-9_]{1,100}$/.test(id) || id === BID) return;
    location.hash = (host.game ? 'host=game&' : '') + 'battle=' + encodeURIComponent(id);
    location.reload();
  }
  // the replay files: in the game the mod reads their headers again first ('replayFiles', a cached scan) and says when
  // data/replay-files.js is written; outside it the file is read as it is (a missing one is left unread)
  var FILES_MS = 60000;
  function loadFiles() {
    if (!host.canSend()) return loadData('data/replay-files.js', 'replayFiles').catch(function () { return null; });
    var w = waitFor(function (n) { return n.kind === 'files' ? { value: null } : null; }, function () { return Promise.reject(new Error('waiting')); }, FILES_MS);
    host.send('bullba_hits', { action: 'replayFiles' }).catch(function (e) { console.warn('Bullba Hits replayFiles failed: ' + e.message); });
    return w.then(function () { return loadData('data/replay-files.js', 'replayFiles'); }).catch(function () { return null; });
  }
  $('sel-battle').onchange = function () { choose(this.value); };

  // ------------------------------------------------------------------ remembered settings
  // Every control of the settings panel, the destruction panel's outline switch and the speed: one localStorage object
  // of this page through the pages' one store (web/settings-store.js, as Viewer.html keeps its own); restored once the
  // scene is built (each control's own handler runs), the defaults are this page's HTML.
  // version 2 (round 14): the sky's default turned to off and its switch moved to the top line - a box of version 1 holds
  // the sky as the old default left it (every control is written), so its sky value is dropped and the new default holds
  var settingStore = BullbaSettings.bind({ key: 'bullba-playback-settings', version: 2,
    read: function (box) {
      var v = box && box.values && typeof box.values === 'object' ? box.values : null;
      if (v && !(box.v >= 2)) { v = Object.assign({}, v); delete v['sw-sky']; }
      return v;
    },
    controls: [].slice.call(document.querySelectorAll('#settings input[id], #settings select[id], #sw-sky, #sw-flash, #speed-value')).filter(function (el) { return el.id !== 'sw-inputlog'; }) });

  // ------------------------------------------------------------------ start
  var mapData, battleInfo = null;
  var loadStart = performance.now();
  // in the game Hits has a window of its own (19.11): the mod opens it if it is not open, this window stays
  $('back').onclick = function () {
    if (host.game && host.canSend()) { host.send('bullba_hits', { action: 'openHits' }).catch(function (e) { console.warn('Bullba Hits openHits failed: ' + e.message); }); return; }
    location.href = BASE + 'Viewer.html' + (host.game ? '#host=game' : '');
  };
  Promise.resolve().then(function () {
    BID = params.battle || '';
    // the selector is filled beside the load, whatever becomes of it: another battle can be chosen from an error too
    battleSelect(null);
    loadData('data/index.js', 'index').then(battleSelect, function () {});
    loadFiles().then(function (f) { FILES = f; battleSelect(); });
    if (!BID) { window.__list = true; noBattle(); return new Promise(function () {}); }
    if (!/^[-a-zA-Z0-9_]{1,100}$/.test(BID)) throw new Error('No battle named.');
    MAP = BID;
    return battleFile(BID);
  }).then(function (info) {
    if (info.error) throw new Error(info.error);
    $('msg').textContent = 'Reading the replay...';
    return battleBuilt(info);
  }).then(function (r) {
    var b = r.battle;
    battleInfo = r.info;
    store['battle:' + BID] = b;
    $('msg').textContent = 'Building the map...';
    var raw = r.effects ? {} : null;
    return Promise.all([jsMap(b), vehiclesFor(b, raw).then(function (m) { store['vehicles:' + BID] = m; return raw && r.effects(raw); })]);
  }).then(function () {
    var tLoaded = performance.now();
    mapData = store['map:' + MAP]; battle = store['battle:' + BID];
    var models = store['vehicles:' + BID];
    // the battle's turret and gun against the exported file's (the list marks a vehicle drawn with others)
    battle.vehicles.forEach(function (v) {
      var md = models[v.type], bt = turretGun(v.compDescr);
      v.modulesMatch = md && md.model && bt && md.turretGun ? bt[0] === md.turretGun[0] && bt[1] === md.turretGun[1] : null;
    });
    $('mapname').textContent = mapData.title + ' (' + battle.meta.gameplay + ')' + (battle.meta.dateTime ? ' ' + battle.meta.dateTime : '');
    $('title').textContent = mapData.title + (battle.meta.dateTime ? ' · ' + battle.meta.dateTime : '');
    setupHaze();  // before any material compiles (it patches three.js's fog chunks)
    buildTerrain(mapData.terrain);
    buildVisual(mapData.visual, mapData.atlas);
    buildObjects(mapData.objects);
    setObjectsMode(mapData.visual ? 'visual' : 'collision');
    buildTrees(mapData.trees);
    setGround(mapData.terrain.groundDefault);
    setSun(1);
    setRelief('game');
    buildLight();
    setLight(true, null);
    setGround('g5global');
    setGrain(true, null);
    setShadowQuality('sharp');
    buildWater(mapData.water);
    var ownTeam = buildVehicles(battle, models);
    buildMode(mapData.mode, ownTeam);
    shots = battle.shots;
    dEvents = battle.destruction || [];
    var own = battle.vehicles.filter(function (v) { return v.own; })[0];
    vehicles.forEach(function (r) { shotColors[r.v.id] = r.role === 'enemy' ? [1, 0.45, 0.35] : (r.role === 'own' ? [1, 0.9, 0.4] : [0.7, 1, 0.6]); });
    computeMuzzles();
    fxHits = battle.hits || []; fxMuzzles = battle.muzzles || [];
    vehicles.forEach(function (r) { fxById[r.v.id] = r; });
    buildMarks(); hitsOn = true; $('sw-hits').checked = hitsOn;
    tEnd = battle.meta.end;
    var p3 = battle.meta.periods.filter(function (p) { return p[1] === 3; })[0];
    tBattle = p3 ? p3[0] : 0;
    $('slider').max = tEnd; t = tBattle;
    buildDestrList();
    setFoliage(null);
    setVehicleColor();  // round 14: before the tint and the halo (the halo takes the model's colour)
    setTeamTint(null);  // round 13: the slider's value (its default or the remembered one)
    setHalo(true, null);
    setHaze(true); setSky(false);
    var a = mapData.arena; cam.tx = (a[0] + a[2]) / 2; cam.tz = (a[1] + a[3]) / 2;
    cam.ty = heightAt(cam.tx, cam.tz) + cam.tyOff;
    resize(); renderList(true); setFollow(null);
    var tBuilt = performance.now();
    $('msg').style.display = 'none';
    requestAnimationFrame(frame);
    return Promise.all(plantTexLoads).then(function () {
      buildImpostors(mapData.trees.kinds);
      settingStore.restore();  // runs every control's handler, the crowns' setCrowns among them
      $('reset-settings').onclick = settingStore.reset;
      window.__ready = { jsBuild: jsBuild, battleBuild: battleInfo, load: +(tLoaded - loadStart).toFixed(0), build: +(tBuilt - tLoaded).toFixed(0), impostors: +(performance.now() - tBuilt).toFixed(0), total: +(performance.now() - loadStart).toFixed(0),
        vehicles: vehicles.length, boxes: vehicles.filter(function (r) { return !r.md.model; }).length, shots: shots.length, own: own && own.type, ownId: own && own.id, owned: battle.vehicles.filter(function (v) { return v.own; }).length,
        destructionEvents: dEvents.length, s3tc: s3tc,
        hits: { points: fxHits.length, muzzles: fxMuzzles.length, stickerMarks: (battle.marks || []).length, marks: fxMarkInfo } };
      report(window.__ready);
    });
  }).catch(function (e) { $('msg').textContent = e.message; window.__error = String(e && e.stack || e); });

  // a sheet of every plant kind of the map: its LOD geometry and textures from the side, each scaled to its cell,
  // with name, size and how many of each class the map has (for the report's check by eye)
  function plantSheet(cols) {
    cols = cols || 7;
    var kinds = mapData.trees.kinds, n = kinds.length, rows = Math.ceil(n / cols);
    var sc = new T.Scene(); sc.background = new T.Color(0xf2f0ea);
    sc.add(new T.HemisphereLight(0xffffff, 0x888070, 1.6));
    var dl = new T.DirectionalLight(0xffffff, 1.6); dl.position.set(-1, 1.2, 2); sc.add(dl);
    var W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight, cw = W / cols, ch = H / rows;
    var oc = new T.OrthographicCamera(0, W, 0, -H, -1000, 1000);
    var box = document.getElementById('sheet') || document.createElement('div');
    box.id = 'sheet'; box.innerHTML = ''; box.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:11px system-ui;color:#222';
    document.body.appendChild(box);
    kinds.forEach(function (k, i) {
      var c = i % cols, r = Math.floor(i / cols);
      var hgt = k.hi[1] - Math.min(0, k.lo[1]), wid = Math.max(k.hi[0] - k.lo[0], k.hi[2] - k.lo[2]);
      var s = Math.min((ch - 30) / Math.max(0.5, hgt), (cw - 10) / Math.max(0.5, wid));
      var grp = new T.Group();
      kindParts[i].lod.forEach(function (p) { var m = new T.Mesh(p.geo, p.mat); grp.add(m); });
      grp.scale.set(s, s, s); grp.position.set(c * cw + cw / 2, -(r + 1) * ch + 8 - Math.min(0, k.lo[1]) * s, 0);
      sc.add(grp);
      var lab = document.createElement('div');
      lab.style.cssText = 'position:absolute;left:' + (c * cw + 4) + 'px;top:' + (r * ch + 2) + 'px;width:' + (cw - 8) + 'px';
      var cnt = k.count, cls = ['tree', 'bush', 'fixed'].filter(function (x) { return cnt[x]; }).map(function (x) { return x + ' ' + cnt[x]; }).join(', ');
      lab.innerHTML = '<b>' + k.name + '</b><br>' + hgt.toFixed(1) + ' m high, ' + wid.toFixed(1) + ' m wide; ' + cls;
      box.appendChild(lab);
    });
    fadeU.uNear0.value = -1; fadeU.uNear1.value = 0;
    renderer.render(sc, oc);
    sheetOn = { scene: sc, cam: oc };
  }
  var sheetOn = null;

  // where the visual model whose name contains `name` stands (first placement inside the arena), game coordinates
  function whereVisual(name) {
    for (var i = 0; i < visRecs.length; i++) {
      var r = visRecs[i]; if (!r || r.rec.name.toLowerCase().indexOf(name.toLowerCase()) < 0) continue;
      var out = r.rec.out ? u8(r.rec.out) : null;
      for (var k = 0; k < r.base.length; k++) if (!out || !out[k]) { var p = new T.Vector3().setFromMatrixPosition(r.base[k]); return [p.x, p.y, p.z, r.rec.n]; }
    }
    return null;
  }
  // 19.11: the rocks as built (the map's rock materials, layers and rock models) and as drawn (the array texture, the models on the rock material)
  function rockInfo() {
    var R = mapData && mapData.atlas && mapData.atlas.rocks;
    return { materials: R ? R.mats.length : 0, layers: R ? R.n : 0, models: mapData ? mapData.visual.filter(function (r) { return r.rock; }).length : 0,
      texture: !!(rockTex && rockTex.isCompressedArrayTexture), textureLayers: rockTex ? rockTex.image.depth : 0, drawn: info.rockModels || 0, s3tc: s3tc };
  }
  // round 14: what the page's own fog (scene.fog through the patched chunks: the haze, the rim fade beyond the border)
  // makes of a black card beyond the playable border, looked at from inside it above, along and below the horizon -
  // display values 0..1 (fog is mixed after the colour-space step); nothing else drawn
  function fogProbe() {
    var ar = mapData.arena, bx = mapData.box || ar, margin = Math.max(5, Math.min(bx[2] - ar[2], ar[0] - bx[0], bx[3] - ar[3], ar[1] - bx[1]));
    var cx = ar[2] - 30, cz = (ar[1] + ar[3]) / 2, cy = heightAt(cx, cz) + 2;
    var rt = new T.WebGLRenderTarget(4, 4), sc = new T.Scene(), cm = new T.PerspectiveCamera(5, 1, 0.5, 4000);
    sc.fog = scene.fog;
    var card = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshBasicMaterial({ color: 0x000000, side: T.DoubleSide })); sc.add(card);
    var rt0 = renderer.getRenderTarget(), oc = renderer.getClearColor(new T.Color()), oa = renderer.getClearAlpha(), out = {}, px = new Uint8Array(64);
    [['up', 0.4], ['horizon', 0.01], ['below', -0.3]].forEach(function (p) {
      var e = p[1], h = Math.sqrt(1 - e * e), L = (30 + margin + 40) / h, dir = new T.Vector3(h, e, 0);
      cm.position.set(cx, cy, -cz); var at = cm.position.clone().addScaledVector(dir, L);
      card.position.copy(at); card.lookAt(cm.position); cm.lookAt(at); cm.updateMatrixWorld(); card.updateMatrixWorld();
      renderer.setRenderTarget(rt); renderer.setClearColor(0xff00ff, 1); renderer.clear(); renderer.render(sc, cm);
      renderer.readRenderTargetPixels(rt, 0, 0, 4, 4, px);
      out[p[0]] = [px[40] / 255, px[41] / 255, px[42] / 255];
    });
    renderer.setRenderTarget(rt0); renderer.setClearColor(oc, oa); rt.dispose(); card.geometry.dispose(); card.material.dispose();
    return out;
  }
  window.MapBench = { shotsPanel: function () { return shotsPanel(); }, camera: function () { return { tx: cam.tx, ty: cam.ty, tz: cam.tz, yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist }; }, rocks: rockInfo, fogProbe: fogProbe, circles: drawnCircles, mapCircles: function () { return (mapData && mapData.mode && mapData.mode.circles) || []; }, gpu: async function (n, every) { var g = await gpuTimes(n || 40, function () { if (every) shadowsRedrawAll(); step(t); }); return +quant(g, 0.5).toFixed(3); }, shadowInfo: shadowInfo, vehicleShadowInfo: vehicleShadowInfo, render: function () { step(t); renderer.render(scene, camera); }, run: runBench, groundBench: runGroundBench, shadowBench: runShadowBench, shadowQuality: setShadowQuality, grain: setGrain, ground: setGround, relief: setRelief, light: setLight, lightInfo: function () { return lightInfo; }, g5Info: function () { return g5Info; },
    view5: function (name) { views5()[name](); }, cost: groundCost, sheet: plantSheet, playback: runPlayback, whereVisual: whereVisual, ensureCollision: ensureCollision,
    split: function () { splitPlants(true); },
    // round 6: the hits switch and the counts check (data events against the effects drawn over the whole battle)
    hits: setHits, hitsSweep: hitsSweep, hitsInfo: function () { return fxMarkInfo; },
    // the impostor pictures as a PNG data URL (for the report's check)
    impostorPng: function () {
      var w = impostorRT.width, h = impostorRT.height, px = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(impostorRT, 0, 0, w, h, px);
      var c = document.createElement('canvas'); c.width = w; c.height = h; var ctx = c.getContext('2d'), im = ctx.createImageData(w, h);
      for (var y = 0; y < h; y++) im.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      ctx.fillStyle = '#ccc'; ctx.fillRect(0, 0, w, h); var c2 = document.createElement('canvas'); c2.width = w; c2.height = h; c2.getContext('2d').putImageData(im, 0, 0); ctx.drawImage(c2, 0, 0);
      return c.toDataURL('image/png');
    }, state: function () { return { t: t, playing: playing, speed: speed }; },
    // round 13: the vehicles' meshes drawn with the Hits look (flat faces with the seam attribute) and those whose model had a group table
    vehicleLook: function () { var n = 0, flat = 0, grouped = 0; layers.vehicles.traverse(function (o) { if (!o.isMesh || !o.material.userData.u) return; n++; var g = o.geometry; if (g.attributes.aSeam && !g.index) flat++; if (g.userData.groupTable) grouped++; }); return { meshes: n, flat: flat, grouped: grouped, base: hitsBaseU.value.toArray() }; },
    seek: function (x) { t = x; }, follow: function (i) { setFollow(i == null ? null : vehicles[i]); },
    followOwn: function () { setFollow(vehicles.filter(function (r) { return r.v.own; })[0] || vehicles[0]); },
    battleStart: function () { return tBattle; },
    teams: function () { return vehicles.map(function (r) { return { id: r.v.id, team: r.v.team, role: r.role }; }); },
    followId: function (id) { setFollow(vehicles.filter(function (r) { return r.v.id === id; })[0] || null); },
    mode: function () { var m = mapData.mode; return m.controlPoint || m.bases[0] || { x: 0, z: 0 }; },
    look: function (x, z, yaw, pitch, dist) { setFollow(null); cam.tx = x; cam.tz = z; cam.ty = heightAt ? heightAt(x, z) + 1 : 0; cam.tyGoal = null; cam.yaw = yaw; cam.pitch = pitch; cam.dist = dist; },
    // round 5d
    halo: setHalo, haloAll: function (on) { haloBenchAll = !!on; poseHalo(); }, haze: setHaze, sky: setSky, zoom: zoomBy, pan: function (right, fwd) { setFollow(null); move(right, fwd); },
    sunGame: function () { var v = reliefU.uSunObj.value; return [v.x, v.y, v.z]; },
    haloInfo: function () { var H = haloU.uHalo.value; return { n: H.x, k: H.y, sun: [H.z, H.w], first: haloU.uHvS.value.slice(0, Math.max(1, H.x)).map(function (s, i) { var p = haloU.uHvP.value[i]; return [+p.x.toFixed(1), +p.y.toFixed(1), +s.x.toFixed(2), +s.y.toFixed(2), s.z]; }) }; },
    vehiclesAt: function () { return vehicles.map(function (r, i) { var p = r.group.position; return { i: i, role: r.role, visible: r.visible, dead: r.dead, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), yaw: +r.group.rotation.y.toFixed(2), foot: r.foot }; }); },
    camInfo: function () { return { tx: cam.tx, ty: cam.ty, tz: cam.tz, ground: heightAt(cam.tx, cam.tz), tyGoal: cam.tyGoal, dist: cam.dist, camY: camera.position.y }; },
    cam: cam, layers: layers, shadows: setShadows, events: function () { return dEvents; }, objects: function () { return mapData.objects; },
    // where a destruction event's object stands (game coordinates)
    eventAt: function (i) {
      var ev = dEvents[i], tg = (ev[2] <= 2 ? objRecs : treeRecs)[ev[3]];
      if (!tg) return null; var p = new T.Vector3().setFromMatrixPosition(tg.base[ev[4]]); return [p.x, p.y, p.z];
    },
    // the 40 m square with the most trees and bushes together (both present): for the foliage close-up
    foliageSpot: function () {
      var cells = {};
      treeRecs.forEach(function (r) {
        if (!r) return;
        r.base.forEach(function (m) {
          var p = new T.Vector3().setFromMatrixPosition(m), key = Math.floor(p.x / 40) + ',' + Math.floor(p.z / 40);
          var c = cells[key] || (cells[key] = { tree: 0, bush: 0, kinds: {}, x: Math.floor(p.x / 40) * 40 + 20, z: Math.floor(p.z / 40) * 40 + 20 });
          c[r.group.cls === 'tree' ? 'tree' : 'bush']++; c.kinds[r.kind.name] = 1;
        });
      });
      var best = null;
      Object.keys(cells).forEach(function (k) { var c = cells[k], s = Math.min(c.tree, c.bush) * Object.keys(c.kinds).length; if (c.tree && c.bush && (!best || s > best.s)) best = { s: s, x: c.x, z: c.z, tree: c.tree, bush: c.bush, kinds: Object.keys(c.kinds) }; });
      return best;
    } };
})();
