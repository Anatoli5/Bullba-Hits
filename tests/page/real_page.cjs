/* The REAL page in a local headless browser (Chrome or Edge, no window, no network): web/index.html as Viewer.html,
 * the real web/ scripts and stylesheet, the real three.js viewer on software WebGL, and a SYNTHETIC data folder
 * (tests/page/fixture.cjs - no player's record, name or model).
 *
 * 1. The path matrix. Every path that puts a scene on screen - a hit clicked, ⇅ and back, the side panel to Vehicles
 *    and back, another shooter from the roster, a vehicle browsed, another shooter from the Vehicles list, ⇅ of two
 *    browsed vehicles, another battle, a seat with no hits (the scene emptied) - is driven by CLICKS, with ⌖ off and on,
 *    and after each the same invariants are asked of the rendered page (layout and computed style, not the markup):
 *      - the tiles show the scene;
 *      - the ⌖ switch stands with a model, lit with the mode; the strip and ↺ only under ⌖ with a model;
 *      - the health bar iff ⌖, a model and a known figure - the figure inside it, the tooltip's source line;
 *      - the emulation's controls (speed tile, gun panel, Config) go with the model;
 *      - every help dot is laid out iff at least one control it lists is laid out;
 *      - no uncaught exception in the page.
 *    The same cast and the same expectations as the stub-DOM matrix of aim3_dom.cjs; that one also counts the painters.
 * 2. The leak counter: 50 scene switches round the same paths, then the same state as before them, after a forced
 *    garbage collection: DOM nodes and JS event listeners (CDP Memory.getDOMCounters, which counts detached but live
 *    nodes too), live WebGL objects (buffers, textures, programs, framebuffers, renderbuffers - counted by wrapping the
 *    context's create/delete calls from an init script) and the viewer's three.js renderer.info must not grow.
 *
 *   node tests/page/real_page.cjs [--verbose] [--keep]      exit 0 pass, 1 fail, 77 skip (no browser installed)
 *
 * Test seam: an init script (Page.addScriptToEvaluateOnNewDocument) wraps window.ArmorViewer in a Proxy that keeps the
 * instances and wraps the WebGL create/delete calls. Nothing in web/ is changed for the test.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');
const fixture = require('./fixture.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const VERBOSE = process.argv.includes('--verbose'), KEEP = process.argv.includes('--keep');
const SWITCHES = 50;

let checks = 0, failures = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else if (VERBOSE) console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}

function stage() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-page-'));
  fs.cpSync(WEB, path.join(folder, 'web'), {recursive: true});
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(folder, 'Viewer.html'));
  fixture.write(folder);
  return folder;
}

// Runs in the page before its own scripts.
const INIT = `(() => {
  const viewers = [];
  let wrapped;
  Object.defineProperty(window, '__bullbaViewers', {value: viewers});
  Object.defineProperty(window, 'ArmorViewer', {configurable: true, enumerable: true,
    get() { return wrapped; },
    set(V) { wrapped = new Proxy(V, {construct(t, args, nt) { const v = Reflect.construct(t, args, nt); viewers.push(v); return v; }}); }});
  const gl = {};
  Object.defineProperty(window, '__bullbaGl', {value: gl});
  ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach((name) => {
    const P = window[name] && window[name].prototype; if (!P) return;
    ['Buffer', 'Texture', 'Program', 'Shader', 'Framebuffer', 'Renderbuffer', 'VertexArray'].forEach((kind) => {
      const make = P['create' + kind], drop = P['delete' + kind];
      if (!make || !drop) return;
      gl[kind] = gl[kind] || 0;
      P['create' + kind] = function () { const o = make.apply(this, arguments); if (o) gl[kind]++; return o; };
      P['delete' + kind] = function (o) { if (o) gl[kind]--; return drop.apply(this, arguments); };
    });
  });
})();`;

// Installed in the page after load: the clicks and the reading of the rendered page.
const DRIVER = `(() => {
  const $ = (id) => document.getElementById(id);
  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  let last = performance.now();
  new MutationObserver(() => { last = performance.now(); }).observe(document.body, {subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'aria-pressed', 'title', 'data-tip', 'open']});
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Settled: two frames drawn and no change to the page's structure, visibility or words for 250 ms.
  async function settle(max) {
    const t0 = performance.now(); await frame(); await frame();
    while (performance.now() - t0 < (max || 6000)) { if (performance.now() - last > 250) return true; await wait(50); }
    return false;
  }
  const must = (el, what) => { if (!el) throw new Error('not on the page: ' + what); return el; };
  const act = {
    hit: (i) => must(document.querySelectorAll('#hits [data-hit]')[i], 'hit row ' + i).click(),
    event: (i) => must(document.querySelectorAll('#hits [data-event]')[i], 'damage event row ' + i).click(),
    swap: () => $('swap-roles').click(),
    shooterTile: () => $('shooter-tile').click(),
    modelTile: () => $('model-tile').click(),
    side: (mode) => must(document.querySelector('#sidebar-mode [data-mode="' + mode + '"]'), 'side mode ' + mode).click(),
    roster: (id) => {
      const d = $('vehicle-focus'); if (!d.open) d.querySelector('summary').click();
      must($('focus-list').querySelector('[data-id="' + id + '"]'), 'roster row ' + id).click();
    },
    list: (id) => must(document.querySelector('#vehicles [data-vehicle="' + id + '"]'), 'vehicle row ' + id).click(),
    scope: (s) => must(document.querySelector('#vehicle-scope [data-scope="' + s + '"]'), 'scope ' + s).click(),
    battle: (id) => {
      if ($('battle-list').hidden) $('battle-pick').click();
      must(document.querySelector('#battle-list [data-id="' + id + '"]'), 'battle ' + id).click();
    },
    fun: (on) => { if ($('fun-mode-toggle').getAttribute('aria-pressed') !== String(on)) $('fun-mode-toggle').click(); },
    mode: () => $('ttx-mode').click()
  };
  const words = (s) => String(s || '').replace(/[\\s\\u00a0\\u2009\\u202f]+/g, ' ').trim();
  const tip = (el) => el ? (el.getAttribute('data-tip') || el.getAttribute('title') || '') : '';
  function sig() {
    const dots = [].slice.call(document.querySelectorAll('[data-help-for]'));
    const wrong = dots.filter((d) => shown(d) !== d.getAttribute('data-help-for').split(/\\s+/).some((id) => shown($(id))))
      .map((d) => d.getAttribute('data-help-for').split(/\\s+/)[0] + (shown(d) ? ' shown' : ' hidden'));
    const funDot = dots.filter((d) => d.getAttribute('data-help-for').split(/\\s+/).indexOf('fun-mode-toggle') >= 0)[0];
    return {model: shown($('model-tile')), shooter: shown($('shooter-tile')),
      funToggle: shown($('fun-mode-toggle')), funPressed: $('fun-mode-toggle').getAttribute('aria-pressed'),
      strip: shown($('fun-strip')), reset: shown($('target-hp-reset')),
      hp: shown($('target-hp')), hpText: words($('target-hp-text').textContent), hpTip: words(tip($('target-hp'))),
      drive: shown($('aim-drive')), config: shown($('aim-config')), gun: shown($('aim-gun')), funGun: shown($('fun-gun')),
      dots: dots.length, dotsShown: dots.filter(shown).length, wrong: wrong, funDot: funDot ? shown(funDot) : null,
      message: words(shown($('scene-message')) ? $('scene-message').textContent : ''), panel: shown($('ttx-panel'))};
  }
  // The compact characteristics panel as laid out (24.09): each row's box by its key.
  function panelRects() {
    const out = {};
    document.querySelectorAll('#ttx-compact .ttx-row, #ttx-hp .ttx-row').forEach((r) => { const b = r.getBoundingClientRect(); out[r.getAttribute('data-key')] = {l: b.left, r: b.right, t: b.top, b: b.bottom}; });
    return out;
  }
  function counters() {
    const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], info = v && v.renderer && v.renderer.info;
    return {viewers: window.__bullbaViewers.length, gl: Object.assign({}, window.__bullbaGl),
      three: info ? {geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs ? info.programs.length : null} : null,
      elements: document.getElementsByTagName('*').length};
  }
  // The page's data reads (local-data.js: a <script> in <head> per file, with its onload and onerror, removed when done):
  // how many were started, or null while one is in flight. The leak counter's GC must not straddle one (the index poll).
  let started = 0;
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.tagName === 'SCRIPT') started++; }))).observe(document.head, {childList: true});
  const reads = () => document.head.querySelector('script[src*="?read="]') ? null : started;
  window.__bt = {act, settle, sig, counters, panelRects, reads};
  return true;
})()`;

// What the viewer paints for a damage event (25.09): its look, the part it lit, the map, the contact cross, the colours.
const LOOK = `(() => {
  const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], look = v.look || null;
  const rows = [].slice.call(document.querySelectorAll('#hits > .hit')).map((r) => r.hasAttribute('data-event') ? 'event' : 'hit').join();
  const cross = v.reticles.filter((m) => m.element.classList.contains('contact'));
  let red = 0, dark = 0, n = 0;
  if (v.paintMesh) { const c = v.paintMesh.geometry.attributes.color.array; n = v.samples.length;
    for (let i = 0; i < n; i++) { const r = c[i * 9], g = c[i * 9 + 1], b = c[i * 9 + 2]; if (r > .6 && g < .1) red++; if (Math.max(r, g, b) < .05) dark++; } }
  return {order: rows, kind: look ? look.kind : null, part: look ? look.part : null, map: !!(v.surface && v.surface.quad.visible),
    contact: cross.length > 0 && !cross[0].element.hidden, red: red, dark: n ? dark / n : 0,
    details: [].slice.call(document.querySelectorAll('#details > div')).map((d) => d.textContent).join(' | ')};
})()`;

const HP = {ROSTER: 'this battle’s roster', FILE: 'the vehicle’s characteristics, stock', OWN: 'the vehicle’s own export'};

// ---- THE SIDE PANEL'S MODE IS THE PICKER ONLY (03.10, the user after 0.9.4) ---------------------------------------------------
// The user: "from Hits to Vehicles the state is not kept - the tank may be the same, but it comes back in the default
// position". His rule: the mode of the left panel is what you pick FROM; the scene on the right is not connected to it.
// A switch changes neither the scene nor its camera, pose, shell or pin - only a pick does: a vehicle, a hit, a tile.
// (Investigation: outputs/mode-state-2026-10-03.md.) What was wrong in 0.9.4, each a check here that was red on it:
//   A. the page opened from the game on a vehicle: the first click on Hits read the battle and put its first hit over the
//      vehicle on screen - nobody clicked a hit;
//   B. the hit on screen changed in the record (its models arrived, the game prepared the saved battle again): the scene
//      was built again in the record's view - and in the Vehicles panel only on the click back to Hits;
//   C. a ram or a fire tile clicked after a hit the user had turned: the camera angles went to the default - asked in
//      the walk of every entry path above ('inherit matrix'), with the rest of what a new scene inherits.
// Pages of their own: the main run's page is not touched; the data file written here is put back.
async function modeState(browser, folder) {
  const LV = 'window.__bullbaViewers[window.__bullbaViewers.length - 1]';
  const VIEW = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, rows = [].slice.call(document.querySelectorAll('#hits > .hit'));
    return {side: document.querySelector('#sidebar-mode [aria-pressed="true"]').getAttribute('data-mode'), scene: h ? String(h.id) : null,
      model: h && h.target ? h.target.name : null, yaw: v.yaw, pitch: v.pitch, distance: v.distance, zoom: v.camera.zoom, turret: v.turretAngle, gun: v.gunAngle,
      pinned: !!v.pinned, shell: document.getElementById('shell-choice').value, source: document.getElementById('shot-source').textContent,
      rows: rows.length, pressed: rows.filter((r) => r.getAttribute('aria-pressed') === 'true').map((r) => r.getAttribute('data-hit') || r.getAttribute('data-event')).join(),
      armour: h && h.target && h.target.parts && h.target.parts[0] ? h.target.parts[0].armorSource : null}; })()`;
  // What the user does by hand: the camera round the tank, its distance and zoom, the turret and the gun.
  const TURN = (yaw, pitch, distance, zoom, turret, gun) => `(() => { const v = ${LV}; v.setOrbit(${yaw}, ${pitch}); v.setDistance(${distance}); v.setZoom(${zoom});
    v.setTurret(${turret}); v.setGun(${gun}); v.render(); })()`;
  const PIN = `(() => { const v = ${LV}, r = v.container.getBoundingClientRect(); v.pinAt({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}); return !!v.pinned; })()`;
  const CAMERA = ['yaw', 'pitch', 'distance', 'zoom'], FIGURES = CAMERA.concat(['turret', 'gun']);
  const near = (a, b, keys) => keys.every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  const same = (a, b) => a.scene === b.scene && a.model === b.model && near(a, b, FIGURES);
  // The whole state a switch must leave alone: the scene, the camera, the pose, the pin, the shell and the pressed row.
  const whole = (a, b) => same(a, b) && a.pinned === b.pinned && a.shell === b.shell && a.source === b.source && a.pressed === b.pressed;
  const brief = (list) => JSON.stringify(list.map((s) => { const o = {side: s.side, scene: s.scene, model: s.model, pinned: s.pinned, shell: s.shell, pressed: s.pressed};
    FIGURES.forEach((k) => { o[k] = Math.round(s[k] * 1000) / 1000; }); return o; }));
  const open = async (hash, extra, ready) => {
    const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href + hash, INIT + (extra || ''));
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 100 && !(${ready}); i++) await new Promise((r) => setTimeout(r, 100)); await __bt.settle(); })()`);
    return p;
  };
  const go = async (p, js) => { await p.evaluate(js); await p.evaluate('__bt.settle()'); return p.evaluate(VIEW); };
  const HOSTQ = `;window.jsHostQuery = function (q) { setTimeout(function () { q.onSuccess('ok'); }, 0); };`;

  // A. THE PAGE AS THE GAME OPENS IT (the mods list button, 25.09): the Vehicles panel on the hangar's vehicle, no battle
  // read yet. The first click on Hits reads the newest battle for the LIST; the vehicle stands as the user left it, there
  // and after the click back. The hit's target here is that very vehicle (the player's own, as after his battle).
  const game = await open('#host=game&vehicle=pm_papa', HOSTQ, `window.__bullbaViewers.length && ${LV}.loadedData && ${LV}.loadedData.hit.vehicle`);
  const G0 = await go(game, TURN(1.1, .2, 16, 1.7, 40, 3));
  const G1 = await go(game, "__bt.act.side('battles')");
  ok('mode state: opened from the game on a vehicle, the user turns it (camera 1.1 / 0.2, 16 m, zoom 1.7, turret 40°, gun 3°); the first click on Hits fills the list - its hits, none pressed - and leaves the vehicle as it stands',
     G0.model === 'Papa' && G0.scene.indexOf('vehicle:pm_papa/') === 0 && same(G1, G0) && G1.rows > 0 && G1.pressed === '', brief([G0, G1]) + ' rows ' + G1.rows);
  const G2 = await go(game, "__bt.act.side('vehicles')");
  ok('mode state: ... and back to Vehicles the vehicle stands as he left it', same(G2, G0), brief([G0, G2]));
  const G3 = await go(game, '__bt.act.hit(0)');
  ok('mode state: ... a hit clicked there is a pick: it takes the scene, in the shot\'s own view', G3.scene === 'pm-1' && G3.pressed === 'pm-1' && Math.abs(G3.distance - 123.004) < .01, brief([G3]));
  ok('mode state: (the page opened from the game) no uncaught exception', game.errors.length === 0, game.errors.slice(0, 3).join(' | '));
  await browser.send('Target.closeTarget', {targetId: game.targetId});

  // THE PAGE OPENED AS A FILE: Hits first, the newest battle's first hit on screen (nothing was there: the default).
  const file = await open('', '', `document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length && ${LV}.loadedData`);
  // Ten switches with a hit on screen that the user turned, pinned a point on and changed the shell of: the scene, the
  // camera, the pose, the pin, the shell and the pressed row are the same after each of them.
  await go(file, '__bt.act.hit(1)');
  await go(file, TURN(.9, .3, 18, 1.5, 25, 2));
  const pinned = await file.evaluate(PIN); await file.evaluate('__bt.settle()');
  const L0 = await go(file, `(() => { const c = document.getElementById('shell-choice'); c.value = 'saved:1'; c.dispatchEvent(new Event('change')); })()`);
  const flips = [];
  for (let i = 0; i < 10; i++) flips.push(await go(file, "__bt.act.side('" + (i % 2 ? 'battles' : 'vehicles') + "')"));
  ok('mode state: ten switches of the side panel with a hit on screen (turned, a point pinned, APCR picked) - the scene, the camera, the pose, the pin, the shell and the pressed row never change',
     pinned && L0.scene === 'pm-2' && L0.pinned && L0.shell === 'saved:1' && L0.pressed === 'pm-2' && flips.every((s) => whole(s, L0)) && flips[9].side === 'battles',
     brief([L0].concat(flips.filter((s) => !whole(s, L0)).slice(0, 2))));
  // A vehicle browsed and turned; Hits with no hit clicked and back - it stands as it was (the battle was read at the start).
  await go(file, "__bt.act.side('vehicles')");
  await go(file, "__bt.act.list('pm_quebec')");
  const V0 = await go(file, TURN(1.1, .2, 16, 1.7, 40, 3));
  const V1 = await go(file, "__bt.act.side('battles')");
  const V2 = await go(file, "__bt.act.side('vehicles')");
  ok('mode state: a vehicle browsed and turned, Hits with no hit clicked and back - it stands as it was', V0.model === 'Quebec' && same(V1, V0) && same(V2, V0), brief([V0, V1, V2]));
  // A hit clicked IS a pick (the user, 03.10 - not a defect): it takes the scene, in the shot's view (his rule of 26.09);
  // the Vehicles panel then shows what is on the scene, not the vehicle browsed before.
  await go(file, "__bt.act.side('battles')");
  const P0 = await go(file, '__bt.act.hit(1)');
  const H0 = await go(file, TURN(.9, .3, 18, 1.5, 25, 2));
  const V3 = await go(file, "__bt.act.side('vehicles')");
  ok('mode state: a hit clicked is a pick - it takes the scene in the shot\'s own view, and the Vehicles panel then shows that scene as the user left it',
     P0.scene === 'pm-2' && Math.abs(P0.distance - 123.004) < .01 && H0.scene === 'pm-2' && same(V3, H0), brief([P0, H0, V3]));

  // B. THE BATTLE'S FILE WRITTEN AGAIN under a view the user built: the hit on screen changed in the record (here a part's
  // armour source), so its scene is built again (hitFingerprint) - in the camera and the pose on screen, with the pin,
  // and in EITHER panel: the read used to wait for the click back to Hits, and the view went on that click.
  const dataFile = (name) => path.join(folder, 'data', name), sources = {};
  const rewrite = (name, change) => { const text = fs.readFileSync(dataFile(name), 'utf8'); if (!(name in sources)) sources[name] = text;
    const value = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); change(value[1]);
    fs.writeFileSync(dataFile(name), 'ArmorInspectorData.receive(' + JSON.stringify(value) + ');\n'); };
  const poll = () => file.evaluate('new Promise((r) => setTimeout(r, 6500)).then(() => __bt.settle())');   // one index poll (5 s)
  try {
    const pinnedB = await file.evaluate(PIN); await file.evaluate('__bt.settle()');
    const B0 = await file.evaluate(VIEW);
    rewrite('battles/pm.js', (b) => { b.hits[1].target.parts[0].armorSource = 'synthetic, prepared again'; });
    rewrite('index.js', (i) => { i.updatedAt += 1; });
    await poll();
    const B1 = await file.evaluate(VIEW);
    ok('mode state: the battle\'s file written again with the hit on screen changed - the scene is built again in the Vehicles panel too (the new record on it), in the user\'s camera and pose, the pinned point kept',
       pinnedB && B0.pinned && B0.armour === 'synthetic' && B1.side === 'vehicles' && B1.armour === 'synthetic, prepared again' && same(B1, B0) && B1.pinned && B1.source === 'Pinned point',
       brief([B0, B1]) + ' armour ' + B1.armour);
    const B2 = await go(file, "__bt.act.side('battles')");
    ok('mode state: ... and the click back to Hits changes nothing', whole(B2, B1), brief([B1, B2]));
  } finally { Object.keys(sources).forEach((name) => fs.writeFileSync(dataFile(name), sources[name])); }
  ok('mode state: (the page opened as a file) no uncaught exception', file.errors.length === 0, file.errors.slice(0, 3).join(' | '));
  await browser.send('Target.closeTarget', {targetId: file.targetId});
}

// ---- THE INHERITANCE MATRIX (03.10): every way a scene is built, and what it takes from the scene before -----------------------
// The user: a scene needs its view angle, its turret's turn and its gun's elevation anyway - from the scene before, not from
// a made-up default; the default only when there is no scene before. One owner gives them (web/app.js sceneFrom), and
// THIS WALK is its guard: every entry path is driven by clicks from a scene the user turned (a camera with a pan, a turret
// and a gun of that path's own figures, a point pinned), and after it the camera and the pose are asked for. A path added
// to the page belongs here; one that builds its scene without the owner throws in display() and fails here.
//   carry    another model: the camera and the pose are the ones on screen; the pin goes with the model that went
//   camera   a record with a pose of its own and no view: the camera on screen, the record's pose
//   side     the other side of a hit under the swap (04.10): the camera on screen, that side's own pose
//   same     the same model: the camera, the pose and the pin stay
//   record   a record picked with a view of its own - the shot's: that view and the record's pose (not a reset)
//   none     not a scene at all (a switch, a tile, a mode, another gun): nothing of the scene changes
//   default  no scene before (the page just opened): the viewer's own default, the only one there is
//   node tests/page/real_page.cjs --matrix    only this walk, twice (a pinned point, then a ⌖ shot), and the table as JSON
const MATRIX_ONLY = process.argv.includes('--matrix');
async function inheritMatrix(browser, folder) {
  const LV = 'window.__bullbaViewers[window.__bullbaViewers.length - 1]';
  const VIEW = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, cfg = document.getElementById('aim-config');
    return {scene: h ? String(h.id) : null, model: h && h.target ? h.target.name : null, shooter: h && h.attacker ? h.attacker.name : null,
      yaw: v.yaw, pitch: v.pitch, distance: v.distance, zoom: v.camera.zoom, panX: v.pan.x, panY: v.pan.y, turret: v.turretAngle, gun: v.gunAngle,
      pinned: !!v.pinned, ring: !!v.aimShotCircle, shell: document.getElementById('shell-choice').value, kind: (v.shell || {}).kind || null,
      armour: h && h.target && h.target.parts && h.target.parts[0] ? h.target.parts[0].armorSource : null,
      gunOf: (document.getElementById('ttx-pair') || {}).title || '', config: cfg ? (cfg.getAttribute('data-tip') || cfg.title || '') : ''}; })()`;
  const TURN = (s) => `(() => { const v = ${LV}; v.setOrbit(${s.yaw}, ${s.pitch}); v.setDistance(${s.distance}); v.setZoom(${s.zoom});
    v.setTurret(${s.turret}); v.setGun(${s.gun}); v.pan.set(${s.panX}, ${s.panY}); v.projection(); v.render(); })()`;
  const PIN = `(() => { const v = ${LV}, r = v.container.getBoundingClientRect(); v.pinAt({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}); return !!v.pinned; })()`;
  const FIRE = `(() => { const v = ${LV}, r = v.container.getBoundingClientRect(), caster = v.pointerRay({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}),
    hit = v.pick(caster.ray.origin, caster.ray.direction); if (!hit) return false;
    v.liveAimPoint = hit.point.clone(); v.aimCursorPoint = hit.point.clone(); v.drawLiveAim();
    const down = v.onShotDown({}); v.onShotUp({}); return down && !!v.aimShotCircle; })()`;
  const CAMERA = ['yaw', 'pitch', 'distance', 'zoom', 'panX', 'panY'], POSE = ['turret', 'gun'];
  const near = (a, b, keys) => keys.every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  const brief = (s) => { const o = {scene: s.scene, model: s.model, pinned: s.pinned}; CAMERA.concat(POSE).forEach((k) => { o[k] = Math.round(s[k] * 1000) / 1000; }); return o; };
  const HIT = (n) => ["side('battles')", "battle('pm')", 'hit(' + n + ')'];
  // Papa on screen, shot by Quebec; the model's role in the list.
  const VEH = ["side('vehicles')", "scope('all')", 'modelTile()', "list('pm_papa')", 'shooterTile()', "list('pm_quebec')", 'modelTile()'];
  const TICK = (id) => `(() => { const e = document.getElementById('${id}'); e.checked = !e.checked; e.dispatchEvent(new Event('change')); })()`;
  // The characteristics panel's quick list of guns: the one that is not the shooter's now.
  const OTHER_GUN = ["(document.getElementById('ttx-pair').click())",
    `(() => { const t = [].slice.call(document.querySelectorAll('#ttx-pair-list .ttx-pick')).filter((e) => e.getAttribute('aria-pressed') !== 'true')[0];
      if (!t) throw new Error('the panel lists no other gun'); t.click(); })()`];
  // The files this walk writes, put back at its end.
  const dataFile = (name) => path.join(folder, 'data', name), sources = {};
  const rewrite = (name, change) => { const text = fs.readFileSync(dataFile(name), 'utf8'); if (!(name in sources)) sources[name] = text;
    const value = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); change(value[1]);
    fs.writeFileSync(dataFile(name), 'ArmorInspectorData.receive(' + JSON.stringify(value) + ');\n'); };
  let written = 0;
  // The battle's file written again with the hit on screen changed, and one index poll (5 s).
  const REREAD = async (p) => { const mark = 'synthetic, read again ' + (++written);
    rewrite('battles/pm.js', (b) => { b.hits[1].target.parts[0].armorSource = mark; });
    rewrite('index.js', (i) => { i.updatedAt += 1; });
    await p.evaluate('new Promise((r) => setTimeout(r, 6500))'); };
  const GAME = '#host=game&vehicle=pm_papa';
  const PATHS = [
    {name: 'a vehicle picked in the Vehicles list, a browsed vehicle on screen', from: VEH, act: ["list('pm_quebec')"], want: 'carry', model: 'Quebec'},
    {name: 'a vehicle picked in the Vehicles list, a recorded hit on screen (the Model tile, then its row)', from: HIT(1), act: ['modelTile()', "list('pm_quebec')"], want: 'carry', model: 'Quebec'},
    {name: 'the game asks for a vehicle (#vehicle=) with a scene on screen', from: VEH, act: ["(location.hash = '#vehicle=test_vehicle')"], want: 'carry', model: 'Test vehicle',
     after: ["(location.hash = '')"]},
    {name: 'the ⇅ of two browsed vehicles', from: VEH, act: ['swap()'], want: 'carry', model: 'Quebec'},
    {name: 'the ⇅ of a recorded hit whose record has no motion of the shooter', from: HIT(1), act: ['swap()'], want: 'carry', model: 'Quebec'},
    {name: 'a seat with no hits in the battle - its own model', from: ["side('battles')", "battle('pm3')", 'hit(0)'], act: ['modelTile()', "side('battles')", 'roster(32)'], want: 'carry', model: 'Quebec'},
    {name: 'a ram tile (its record has no pose of the parts)', from: HIT(1), act: ['event(0)'], want: 'carry', model: 'Papa'},
    {name: 'a fire tile', from: HIT(1), act: ['event(1)'], want: 'carry', model: 'Papa'},
    {name: 'a hit whose point was not restored (another battle picked: its first hit)', from: HIT(1), act: ["battle('pm2')"], want: 'camera', model: 'Papa'},
    {name: 'another shooter from the Vehicles list', from: VEH, act: ['shooterTile()', "list('pm_papa')"], want: 'same', shooter: 'Papa'},
    {name: 'another shooter from the battle\'s roster, a recorded hit on screen', from: HIT(0), act: ['shooterTile()', "side('battles')", 'roster(32)'], want: 'same', shooter: 'Quebec'},
    {name: 'the same hit read again after its battle\'s file changed', from: HIT(1), act: [REREAD], want: 'same', shooter: 'Quebec', reread: true},
    {name: 'another hit picked, its shot recorded', from: HIT(1), act: ['hit(0)'], want: 'record', scene: 'pm-1', view: {distance: 123.004}, pose: {turret: 0, gun: 0}},
    {name: 'another battle picked: its first hit, the shot recorded', from: HIT(1), act: ["battle('pm3')"], want: 'record', scene: 'pm3-1', pose: {turret: 0, gun: 0}},
    {name: 'the ⇅ of a recorded hit with the shooter\'s motion', from: HIT(0), act: ['swap()'], want: 'side', model: 'Romeo', pose: {turret: .2 * 180 / Math.PI, gun: -.02 * 180 / Math.PI}},
    {name: 'the ⇅ back to the recorded hit', from: HIT(1).concat(['swap()']), act: ['swap()'], want: 'side', scene: 'pm-2', model: 'Papa', pose: {turret: 0, gun: 0}},
    {name: 'the side panel switched to Vehicles', from: HIT(1), act: ["side('vehicles')"], want: 'none'},
    {name: 'the side panel switched to Hits', from: VEH, act: ["side('battles')"], want: 'none'},
    {name: 'the first click on Hits after the game opened the page on a vehicle', fresh: GAME, from: [], act: ["side('battles')"], want: 'none', model: 'Papa'},
    {name: 'a role tile clicked (Shooter, then Model)', from: HIT(1), act: ['shooterTile()', 'modelTile()'], want: 'none'},
    {name: 'another gun of the shooter picked on the characteristics panel', from: HIT(1), act: OTHER_GUN, want: 'none', gun: true, shell: true, after: OTHER_GUN},
    {name: 'the ⌖ mode switched', from: HIT(1), act: ["(document.getElementById('fun-mode-toggle').click())"], want: 'none'},
    {name: 'the aim emulation switched off and on (Settings)', from: HIT(1), act: [TICK('aim-on'), TICK('aim-on')], want: 'none'},
    {name: 'real reload ◔ switched', from: HIT(1), act: [TICK('real-reload')], want: 'none', after: [TICK('real-reload')]},
    {name: 'another shell picked', from: HIT(1), act: [`(() => { const c = document.getElementById('shell-choice'); c.value = 'saved:1'; c.dispatchEvent(new Event('change')); })()`], want: 'none', shell: true}
  ];
  // The hit without a point: battle pm2's only hit loses its points for this walk. Another gun for Quebec: his
  // characteristics file gains a second pair on the same turret.
  rewrite('battles/pm2.js', (b) => { b.hits[0].points = []; });
  rewrite('ttx/germany-Quebec.js', (t) => { t.configs.push(Object.assign({}, t.configs[0], {gun: '_105_alt', gunUserString: '105 mm alt', gunLevel: 7, top: false}));
    t.shells._105_alt = t.shells._105_single; });
  const table = [], pages = [];
  const open = async (hash) => {
    const game = hash.indexOf('host=game') >= 0;
    const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href + hash,
      INIT + (game ? `;window.jsHostQuery = function (q) { setTimeout(function () { q.onSuccess('ok'); }, 0); };` : ''));
    pages.push(p);
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 100 && !(window.__bullbaViewers.length && ${LV}.loadedData && (${game} || document.querySelector('#hits [data-hit]'))); i++) await new Promise((r) => setTimeout(r, 100)); await __bt.settle(); })()`);
    return p;
  };
  const close = async (p) => { pages.splice(pages.indexOf(p), 1); await browser.send('Target.closeTarget', {targetId: p.targetId}); };
  const run = async (p, list) => { for (const js of list) { if (typeof js === 'function') await js(p); else await p.evaluate(js.charAt(0) === '(' ? js : '__bt.act.' + js); await p.evaluate('__bt.settle()'); } };
  try {
    // No scene before: the page the game opens on the hangar's vehicle starts in the viewer's default view and the rest pose.
    const first = await open(GAME), F = await first.evaluate(VIEW);
    ok('inherit matrix: opened from the game on a vehicle, no scene before - the default view (the nose towards the viewer and to the right) and the rest pose',
       F.model === 'Papa' && Math.abs(F.yaw - (.65 + Math.PI / 2)) < 1e-6 && Math.abs(F.pitch - .25) < 1e-6 && F.turret === 0 && F.gun === 0 && F.panX === 0 && F.panY === 0, JSON.stringify(brief(F)));
    table.push({path: 'opened from the game on a vehicle, no scene before', want: 'default', shot: false});
    await close(first);
    const main = await open('');
    for (const shot of MATRIX_ONLY ? [false, true] : [false]) {
      for (let i = 0; i < PATHS.length; i++) {
        const path_ = PATHS[i], tag = 'inherit matrix' + (shot ? ', ⌖ shot' : '') + ': ' + path_.name + ' - ';
        const p = path_.fresh ? await open(path_.fresh) : main;
        await run(p, ['fun(' + shot + ')'].concat(path_.from));
        // The scene the user left: figures of this path's own, so a view that merely stayed from the path before fails.
        const set = {yaw: .7 + .02 * i, pitch: .12 + .005 * i, distance: 15 + .5 * i, zoom: 1.3 + .02 * i, panX: .3 + .01 * i, panY: -.2 - .01 * i, turret: 20 + i, gun: 1 + .1 * i};
        await p.evaluate(TURN(set)); await p.evaluate('__bt.settle()');
        const marked = await p.evaluate(shot ? FIRE : PIN); await p.evaluate('__bt.settle(1500)');
        const a = await p.evaluate(VIEW);
        await run(p, path_.act);
        const b = await p.evaluate(VIEW);
        const cam = near(b, a, CAMERA), pose = near(b, a, POSE);
        table.push({path: path_.name, want: path_.want, shot: shot, camera: near(b, a, ['yaw', 'pitch', 'distance', 'zoom']), pan: near(b, a, ['panX', 'panY']),
          turret: Math.abs(b.turret - a.turret) < 1e-6, gun: Math.abs(b.gun - a.gun) < 1e-6,
          shell: b.kind === a.kind, config: b.config === a.config, pin: a.pinned ? b.pinned : null, ring: a.ring ? b.ring : null, model: a.model === b.model ? 'same' : 'other',
          shooter: a.shooter === b.shooter ? 'same' : 'other'});
        if (!shot) {
          const extra = JSON.stringify([brief(a), brief(b)]);
          ok(tag + '(the user\'s scene is set: turned, panned, a point pinned)', near(a, set, CAMERA.concat(POSE)) && marked === true && a.pinned, extra);
          if (path_.want === 'carry') ok(tag + 'the camera with its pan and the pose of the scene before, on ' + path_.model + '; the pin went with the scene that went',
            cam && pose && b.model === path_.model && b.scene !== a.scene && !b.pinned, extra);
          else if (path_.want === 'camera') ok(tag + 'the camera of the scene before; the pose is the record\'s own',
            cam && b.scene !== a.scene && b.turret === 0 && b.gun === 0, extra);
          else if (path_.want === 'side') ok(tag + 'the camera of the scene before stays; the pose is that side\'s own (' + Math.round(path_.pose.turret) + '° / ' + Math.round(path_.pose.gun) + '°), on ' + path_.model,
            cam && b.scene !== a.scene && b.model === path_.model && (!path_.scene || b.scene === path_.scene) && Math.abs(b.turret - path_.pose.turret) < 1e-6 && Math.abs(b.gun - path_.pose.gun) < 1e-6 && !b.pinned, extra);
          else if (path_.want === 'same') ok(tag + 'the same model: the camera, the pose and the pinned point stay; the shooter is ' + path_.shooter + (path_.reread ? '; the new record is on the scene' : ''),
            cam && pose && b.pinned && b.model === a.model && b.shooter === path_.shooter && (!path_.reread || (b.scene === a.scene && b.armour !== a.armour)), extra + ' ' + b.shooter + ' ' + b.armour);
          else if (path_.want === 'record') ok(tag + 'the record\'s own view and pose (the pick\'s data, not a reset)',
            (!path_.scene || b.scene === path_.scene) && (!path_.model || b.model === path_.model) && (!path_.view || Math.abs(b.distance - path_.view.distance) < 1.5)
            && Math.abs(b.turret - path_.pose.turret) < 1e-6 && Math.abs(b.gun - path_.pose.gun) < 1e-6 && !cam, extra);
          else ok(tag + 'no scene is built: the scene, the camera, the pose and the pin are as they were' + (path_.shell ? '' : ', the shell too') + (path_.gun ? '; the panel shows the other gun, the shells are its own' : ''),
            cam && pose && b.scene === a.scene && b.pinned === a.pinned && (path_.shell || b.shell === a.shell) && (!path_.model || b.model === path_.model) && (!path_.gun || b.gunOf !== a.gunOf),
            extra + (path_.gun ? ' ' + JSON.stringify([a.gunOf.split('\n')[0], b.gunOf.split('\n')[0]]) : ''));
        }
        if (path_.after) await run(p, path_.after);
        if (path_.fresh) { ok(tag + '(no uncaught exception in that page)', p.errors.length === 0, p.errors.slice(0, 3).join(' | ')); await close(p); }
      }
    }
    ok('inherit matrix: no uncaught exception in the page', main.errors.length === 0, main.errors.slice(0, 3).join(' | '));
    if (MATRIX_ONLY) console.log('MATRIX ' + JSON.stringify(table));
  } finally {
    Object.keys(sources).forEach((name) => fs.writeFileSync(dataFile(name), sources[name]));
    for (const p of pages.slice()) await close(p);
  }
}

// ---- THE TWO SIDES OF A HIT UNDER ⇅, AND THE SHOOTER ROW (04.10, the user after 0.9.6) -------------------------------------------
// The user, on his own battles: "after the swap the vehicle that was the shooter gets some nonsense; the swap button jumps,
// because the shell icons beside the Shooter tile go somewhere; the position changes as it likes". What 0.9.6 did:
//   - ⇅ to the shooter put the camera at the hit point looking back at him (26.09), ⇅ back put the shot's view and the
//     record's pose - so every ⇅ moved the camera, and a turret the user had turned came back as recorded;
//   - the swapped hit had no aim, no limits and no shells: the pose tile said "from the recorded pose", the gun turned a
//     free ±45°, the shell icons went - and the row, centred as a whole, moved ⇅ by half their width.
// The rule now (web/app.js sideFrom, layoutShooterRow): the camera stays in both directions; each side has its pose - the
// record's first (the shooter's from his motion, else the one on screen), then the one the user left on it; a hit row
// clicked is a pick again, the record's view and pose; the shells are the shooter's in both states; ⇅ and the Shooter tile
// stand in one place whatever is in the row. The same case on the user's own battle: tests/page/real_scene.cjs.
async function swapSides(browser, folder) {
  const LV = 'window.__bullbaViewers[window.__bullbaViewers.length - 1]';
  const VIEW = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, $ = (id) => document.getElementById(id);
    const at = (id) => { const e = $(id); if (!e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.width * 10) / 10]; };
    return {scene: h ? String(h.id) : null, model: h && h.target ? h.target.name : null, shooter: h && h.attacker ? h.attacker.name : null,
      yaw: v.yaw, pitch: v.pitch, distance: v.distance, zoom: v.camera.zoom, turret: v.turretAngle, gun: v.gunAngle,
      tile: $('pose-turret').textContent + ' | ' + $('pose-gun').textContent, note: $('pose-note').hidden ? '' : $('pose-note').textContent,
      swap: at('swap-roles'), shooterTile: at('shooter-tile'), gunPanel: at('aim-gun'), shells: $('aim-gun-shells').children.length,
      listed: [].filter.call($('shell-choice').options, (o) => o.value.indexOf('saved:') === 0).length, choice: $('shell-choice').value}; })()`;
  const TURN = (yaw, pitch, distance, zoom, turret, gun) => `(() => { const v = ${LV}; v.setOrbit(${yaw}, ${pitch}); v.setDistance(${distance}); v.setZoom(${zoom});
    v.setTurret(${turret}); v.setGun(${gun}); v.render(); })()`;
  const TICK = (id) => `(() => { const e = document.getElementById('${id}'); e.checked = !e.checked; e.dispatchEvent(new Event('change')); })()`;
  const CAMERA = ['yaw', 'pitch', 'distance', 'zoom'];
  const near = (a, b, keys) => keys.every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  const posed = (s, turret, gun) => Math.abs(s.turret - turret) < 1e-6 && Math.abs(s.gun - gun) < 1e-6;
  const brief = (list) => JSON.stringify(list.map((s) => ({scene: s.scene, model: s.model, yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3), distance: +s.distance.toFixed(2), zoom: +s.zoom.toFixed(2),
    turret: +s.turret.toFixed(3), gun: +s.gun.toFixed(3), swap: s.swap, shells: s.shells})));
  const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
  try {
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 100 && !(document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length && ${LV}.loadedData); i++) await new Promise((r) => setTimeout(r, 100)); await __bt.settle(); })()`);
    const go = async (js) => { await p.evaluate(js.charAt(0) === '(' ? js : '__bt.act.' + js); await p.evaluate('__bt.settle()'); return p.evaluate(VIEW); };
    const REC = {turret: .2 * 180 / Math.PI, gun: -.02 * 180 / Math.PI};   // pm-1's shooter at the shot: his motion
    // pm-1: Romeo's hit on Papa, the shooter's motion on record.
    await go("battle('pm')"); await go('hit(0)');
    const T1 = await go(TURN(.9, .3, 18, 1.5, 30, 2));
    const S1 = await go('swap()');
    ok('swap sides: ⇅ to the shooter - the camera on screen stays (it used to jump to the hit point), and he stands as the record has him at the shot: turret 11.5°, gun 1.1° up',
       S1.model === 'Romeo' && S1.scene === 'pm-1:swap' && near(S1, T1, CAMERA) && posed(S1, REC.turret, REC.gun), brief([T1, S1]));
    ok('swap sides: ... he is a vehicle like any other - the pose tile gives his angles from the hull, not "from the recorded pose", and no note of a recorded shot\'s marks',
       /^Turret \+11° \| Gun \+1°/.test(S1.tile) && S1.tile.indexOf('from the recorded pose') < 0 && S1.note === '', S1.tile + ' / ' + S1.note);
    const S2 = await go(TURN(.5, .2, 16, 1.4, 50, -3));
    ok('swap sides: (the shooter turned by hand: still no note of a recorded shot - this scene has none)', S2.note === '' && posed(S2, 50, -3), S2.tile + ' / ' + S2.note);
    const T2 = await go('swap()');
    ok('swap sides: ⇅ back - the camera stays again (it used to return to the shot\'s view), and the target stands as the user left it: turret 30°, gun 2°',
       T2.scene === 'pm-1' && T2.model === 'Papa' && near(T2, S2, CAMERA) && posed(T2, 30, 2), brief([S2, T2]));
    const S3 = await go('swap()');
    ok('swap sides: ⇅ again - the shooter as the user left him (turret 50°, gun 3° up), not the record\'s pose over his', S3.model === 'Romeo' && near(S3, S2, CAMERA) && posed(S3, 50, -3), brief([S2, S3]));
    const T3 = await go('swap()');
    const R1 = await go('hit(0)');
    ok('swap sides: the hit\'s row clicked is a pick - the shot\'s own view and the record\'s pose', R1.scene === 'pm-1' && Math.abs(R1.distance - 123.004) < .01 && posed(R1, 0, 0) && posed(T3, 30, 2), brief([T3, R1]));
    const S4 = await go('swap()');
    ok('swap sides: ... and nothing is kept from before the pick: ⇅ gives the shooter the record\'s pose again, in the camera on screen', S4.model === 'Romeo' && near(S4, R1, CAMERA) && posed(S4, REC.turret, REC.gun), brief([R1, S4]));
    // pm-2: Quebec's hit on Papa, no motion of the shooter on record - his pose is the one on screen.
    await go('swap()'); await go('hit(1)');
    const T4 = await go(TURN(1.1, .25, 20, 1.6, 35, 1));
    const S5 = await go('swap()');
    ok('swap sides: a record without the shooter\'s motion - the camera stays, his turret and gun are the ones on screen', S5.model === 'Quebec' && near(S5, T4, CAMERA) && posed(S5, 35, 1), brief([T4, S5]));
    const T5 = await go('swap()');
    // THE ROW: ⇅ and the Shooter tile in one place through all of it, the shells the shooter's own in both states.
    const states = [T1, S1, S2, T2, S3, T3, R1, S4, T4, S5, T5];
    ok('shooter row: the shell icons stand in both states of ⇅ - the shooter\'s own (the swapped view used to have none), the list the same',
       states.every((s) => s.gunPanel && s.shells === 2 && s.listed === 2 && s.choice.indexOf('saved:') === 0), JSON.stringify(states.map((s) => [s.scene, s.gunPanel, s.shells, s.listed, s.choice])));
    ok('shooter row: ⇅ stands in one place through every swap - the same button under the pointer',
       states.every((s) => s.swap && s.swap[0] === T1.swap[0] && s.swap[1] === T1.swap[1]) && states.every((s) => s.shooterTile && s.shooterTile[0] === T1.shooterTile[0]),
       JSON.stringify(states.map((s) => [s.swap, s.shooterTile])));
    // ... and whatever is in the row: without the emulation its speed tile, shell icons and Config go, ⇅ stays put.
    const E0 = await go(TICK('aim-on'));
    ok('shooter row: the emulation switched off - the speed tile, the shells and Config go, ⇅ and the tile stay where they were',
       !E0.gunPanel && !!E0.swap && E0.swap[0] === T1.swap[0] && E0.shooterTile[0] === T1.shooterTile[0], JSON.stringify([T1.swap, E0.swap, T1.shooterTile, E0.shooterTile, E0.gunPanel]));
    await go(TICK('aim-on'));
    // A browsed pair: the tile of a vehicle that is its own shooter has no ⇅, and the tile is where it was.
    await go("side('vehicles')"); await go("scope('all')"); await go('modelTile()');
    const V1 = await go("list('pm_papa')");
    ok('shooter row: a browsed vehicle - the Shooter tile where it stood beside ⇅', !!V1.shooterTile && V1.shooterTile[0] === T1.shooterTile[0] && (!V1.swap || V1.swap[0] === T1.swap[0]), JSON.stringify([T1.shooterTile, V1.shooterTile, V1.swap]));
    ok('swap sides: no uncaught exception in the page', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } finally { await browser.send('Target.closeTarget', {targetId: p.targetId}); }
}

// ---- THE FIRST VIEW OF A SHOT FIRED POINT-BLANK (04.10, the user on 0.9.7) -------------------------------------------------------
// The user: his shots from a few metres were "centred strangely at first: the shot is outside the view, and the camera turns
// round a point on the floor under the tank". Fit centres the middle of the armour's projected box, which is right while
// the armour fits the frame; in a clinch it cannot fit (Fit stops at zoom x1 and never backs the camera off), the near
// edge of the box is projected from under a metre, and its "middle" lay screens below the vehicle - the orbit centre and
// the contact point went off the top of the frame. Now, when the armour does not fit, the ORBIT CENTRE stands mid-screen
// (web/viewer.js fit). Here on synthetic hits on the turret's face - the shooter in front of the hull, his gun at the
// turret's height - from 4, 6 and 12 m; the same on the user's own battle: tests/page/real_scene.cjs.
async function closeRange(browser, folder) {
  const LV = 'window.__bullbaViewers[window.__bullbaViewers.length - 1]';
  const USABLE = 1 - 2 * .12;   // the frame between the tiles' bands (viewer.js FIT_TOP_BAND, FIT_BOTTOM_BAND), in screen half-heights
  const FRAME = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, r3 = (x) => Math.round(x * 1000) / 1000;
    const ndc = (p) => { const q = p.clone().project(v.camera); return [r3(q.x), r3(q.y)]; };
    return {scene: h ? String(h.id) : null, range: h && h.rangeAtImpact, zoom: r3(v.camera.zoom), pivot: v.pivot, distance: r3(v.distance), yaw: r3(v.yaw), pitch: r3(v.pitch),
      eyeToPoint: v.point ? r3(v.camera.position.distanceTo(v.point)) : null, atCentre: r3(v.target.distanceTo(v.pivotCentre())), atPoint: v.point ? r3(v.target.distanceTo(v.point)) : null,
      orbit: ndc(v.target), contact: v.point ? ndc(v.point) : null, shift: r3(v.frameCenter.x / v.distance)}; })()`;
  const inFrame = (xy) => !!xy && Math.abs(xy[0]) <= USABLE && Math.abs(xy[1]) <= USABLE;
  // The three hits of this walk: battle pm's two and pm2's one, moved onto the turret's face (part 2, in its own frame:
  // 0.45 m up its 0.9 m, on the front plate) and fired from 4, 12 and 6 m. The files are put back.
  const dataFile = (name) => path.join(folder, 'data', name), sources = {};
  const rewrite = (name, change) => { const text = fs.readFileSync(dataFile(name), 'utf8'); sources[name] = text;
    const value = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))); change(value[1]);
    fs.writeFileSync(dataFile(name), 'ArmorInspectorData.receive(' + JSON.stringify(value) + ');\n'); };
  const onTurret = (hit, range) => { hit.rangeAtImpact = range; hit.attackerPositionAtImpact = [0, 2.15, range + 1.1];
    Object.assign(hit.points[0], {part: 2, start: [0, .45, 6], end: [0, .45, -5], position: [0, .45, 1.3], direction: [0, 0, -1], normal: [0, 0, 1]}); };
  rewrite('battles/pm.js', (b) => { onTurret(b.hits[0], 4); onTurret(b.hits[1], 12); });
  rewrite('battles/pm2.js', (b) => { onTurret(b.hits[0], 6); });
  let p;
  try {
    p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 100 && !(document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length && ${LV}.loadedData); i++) await new Promise((r) => setTimeout(r, 100)); await __bt.settle(); })()`);
    const go = async (js) => { await p.evaluate(js.charAt(0) === '(' ? js : '__bt.act.' + js); await p.evaluate('__bt.settle()'); return p.evaluate(FRAME); };
    const words = (s) => JSON.stringify({scene: s.scene, zoom: s.zoom, pivot: s.pivot, orbit: s.orbit, contact: s.contact, shift: s.shift, eyeToPoint: s.eyeToPoint});
    await go("battle('pm')");
    for (const shot of [{pick: 'hit(0)', range: 4}, {pick: "battle('pm2')", range: 6}]) {
      const tag = 'close range: a hit on the turret\'s face from ' + shot.range + ' m, ';
      const A = await go(shot.pick);
      ok(tag + 'the first view - the orbit centre is the vehicle\'s centre, on the screen\'s axis and inside the frame; the contact point is inside the frame; zoom x1; the camera on the shot\'s line at its range',
         A.range === shot.range && A.pivot === 'vehicle' && A.atCentre < 1e-6 && Math.abs(A.orbit[0]) < 1e-6 && Math.abs(A.orbit[1]) <= USABLE && inFrame(A.contact) && A.zoom === 1
         && Math.abs(A.eyeToPoint - shot.range) < 1e-3, words(A));
      const H = await go("(document.getElementById('pivot-hit').click())");
      // (Not dead centre: the frame is not moved past the armour's top - no empty band above the turret - so the point
      // stands a third of the way up; continuous with the framing of a hit whose armour just fits.)
      ok(tag + 'the orbit round the hit point - the point is the centre and stands inside the frame, nearer its middle than its edge; the camera has not moved',
         H.pivot === 'hit' && H.atPoint < 1e-6 && Math.abs(H.orbit[0]) < 1e-6 && Math.abs(H.orbit[1]) <= .5 && Math.abs(H.eyeToPoint - shot.range) < 1e-3, words(H));
      const T = await go(`(() => { const v = ${LV}; v.setOrbit(v.yaw + .6, .3); v.render(); })()`);
      ok(tag + '... turned by hand - it turns round the point, which stays where it stood', T.atPoint < 1e-6 && Math.abs(T.orbit[0] - H.orbit[0]) < 1e-6 && Math.abs(T.orbit[1] - H.orbit[1]) < 1e-6, words(T));
      const F = await go("(document.getElementById('fit-camera').click())");
      ok(tag + '... Fit - still the point, inside the frame, zoom not below x1', F.atPoint < 1e-6 && inFrame(F.orbit) && F.zoom >= 1, words(F));
      const V = await go("(document.getElementById('pivot-vehicle').click())");
      ok(tag + '... back round the vehicle\'s centre - the centre and the contact point inside the frame', V.pivot === 'vehicle' && V.atCentre < 1e-6 && Math.abs(V.orbit[1]) <= USABLE && inFrame(V.contact), words(V));
    }
    // An ordinary short range: the armour fits the frame, and the framing is what it was - its middle mid-screen.
    await go("battle('pm')");
    const N = await go('hit(1)');
    ok('close range: a hit from 12 m - the armour fits, framed as before: zoomed in past x1, the orbit centre and the contact point inside the frame',
       N.range === 12 && N.zoom > 1 && N.atCentre < 1e-6 && Math.abs(N.orbit[1]) <= USABLE && inFrame(N.contact), words(N));
    // A browsed vehicle brought to 4 m and fitted: the same rule, no shot in it.
    await go('modelTile()'); await go("scope('all')"); await go("list('pm_papa')");
    await go(`(${LV}.setOrbit(.3, .05), ${LV}.setDistance(4))`);
    const B = await go("(document.getElementById('fit-camera').click())");
    ok('close range: a browsed vehicle brought to 4 m and fitted - its centre is the orbit centre and stands inside the frame', B.zoom >= 1 && B.atCentre < 1e-6 && Math.abs(B.orbit[1]) <= USABLE, words(B));
    ok('close range: no uncaught exception in the page', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } finally {
    Object.keys(sources).forEach((name) => fs.writeFileSync(dataFile(name), sources[name]));
    if (p) await browser.send('Target.closeTarget', {targetId: p.targetId});
  }
}

async function main() {
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  const folder = stage();
  let page;
  try {
    // --close: only the first view of a shot fired point-blank.
    if (process.argv.includes('--close')) { await closeRange(browser, folder); console.log('real page, the close range only (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed'); return failures ? 1 : 0; }
    // --sides: only the swap's two sides and the shooter row (a quick run while that rule is worked on).
    if (process.argv.includes('--sides')) { await swapSides(browser, folder); console.log('real page, the swap sides only (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed'); return failures ? 1 : 0; }
    await inheritMatrix(browser, folder);
    if (MATRIX_ONLY) { console.log('real page, the inheritance matrix only (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed'); return failures ? 1 : 0; }
    await modeState(browser, folder);
    await swapSides(browser, folder);
    await closeRange(browser, folder);
    page = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    const ev = (js) => page.evaluate(js);
    await ev(DRIVER);
    // Ready: the battle list read from the synthetic index, and the viewer made.
    const ready = await ev(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length) break; await new Promise((r) => setTimeout(r, 100)); } await __bt.settle(); return {hits: document.querySelectorAll('#hits [data-hit]').length, viewers: window.__bullbaViewers.length, webgl: !!(window.__bullbaViewers[0] && window.__bullbaViewers[0].renderer)}; })()`);
    ok('the page starts on the synthetic data: hits listed, the viewer made with WebGL', ready.hits > 0 && ready.webgl, JSON.stringify(ready));
    if (!ready.webgl) throw new Error('no WebGL viewer - the matrix would mean nothing');
    // The sweep of every vehicle's characteristics (24.09): the mod's progress file drawn beside the Statistics log.
    const sweep = await ev(`(() => { const b = document.getElementById('ttx-sweep'), f = document.getElementById('ttx-sweep-fill');
      return {shown: b.getClientRects().length > 0, text: document.getElementById('ttx-sweep-count').textContent, fill: f.style.width,
        tip: b.getAttribute('data-tip') || b.title, quiet: document.getElementById('ttx-sweep-ask').hidden && document.getElementById('ttx-sweep-stop').hidden, left: b.getBoundingClientRect().right <= document.querySelector('header .connection').getBoundingClientRect().left}; })()`);
    ok('sweep indicator: the progress file drawn in the header - 340 / 1343, the bar a quarter full, left of the Statistics log, its words in the tooltip; outside the game no question and no ■',
       sweep.shown && sweep.quiet && sweep.text === '340 / 1343' && sweep.fill === '25.3%' && sweep.left
       && sweep.tip.indexOf('Characteristics of every vehicle\nThe game prepares the characteristics files once after a game update, only of the vehicles that changed.\n• Now: 340 of 1343\n') === 0, JSON.stringify(sweep).slice(0, 300));
    const step = async (js, max) => { await ev('__bt.act.' + js); await ev('__bt.settle(' + (max || 6000) + ')'); return ev('__bt.sig()'); };

    function expectScene(label, fun, want, s) {
      const tag = 'matrix, ⌖ ' + (fun ? 'on' : 'off') + ', ' + label + ': ';
      ok(tag + 'the tiles show the scene', s.model === want.model && s.shooter === want.shooter, '(model ' + s.model + ', shooter ' + s.shooter + ')');
      // A model DRAWN: the tile, unless it is a vehicle browsed without its model (want.drawn false, 24.09).
      const drawn = s.model && want.drawn !== false;
      ok(tag + 'the ⌖ switch stands with a model, lit with the mode; the strip and ↺ only under ⌖ with a model',
         s.funToggle === drawn && s.funPressed === String(fun) && s.strip === (fun && drawn) && s.reset === (fun && drawn),
         '(switch ' + s.funToggle + ' pressed ' + s.funPressed + ', strip ' + s.strip + ', ↺ ' + s.reset + ')');
      const bar = fun && drawn && !!want.hp;
      ok(tag + (bar ? 'the health bar stands with ' + want.hp + ' inside it, from ' + want.source : 'no health bar'),
         s.hp === bar && (!bar || (s.hpText === want.hp && s.hpTip.indexOf('• Left: ' + want.hp + ' HP • Source: ' + want.source) >= 0)),
         '(shown ' + s.hp + ', "' + s.hpText + '", tip "' + s.hpTip.slice(0, 160) + '")');
      ok(tag + 'the emulation’s controls go with the model' + (want.drawn === false ? ' - Config stays for the panel’s build' : ''),
         drawn || (!s.drive && !s.gun && !s.funGun && s.config === (want.drawn === false)),
         '(drive ' + s.drive + ', config ' + s.config + ', gun ' + s.gun + ', strip gun ' + s.funGun + ')');
      ok(tag + 'every help dot is laid out iff a control it lists is (the ⌖ one with the model)',
         s.wrong.length === 0 && s.funDot === drawn, '(' + s.dotsShown + '/' + s.dots + ' shown; wrong: ' + s.wrong.join(', ') + ')');
      ok(tag + 'no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
      page.errors.length = 0;
    }

    // Warm up as the stub matrix does: every shooter's characteristics file read once.
    await step("side('battles')"); await step("battle('pm')"); await step('hit(1)'); await step('swap()'); await step('swap()');

    // 25.09: the icon column stands on every row of the list (hits and damage events) at one width, so the vehicle
    // tiles and their flags end in one line; at the narrowest list (250 px, a window under 900 px) no row overflows.
    for (const w of [1600, 800]) {
      if (w !== 1600) await page.send('Emulation.setDeviceMetricsOverride', {width: w, height: 1000, deviceScaleFactor: 1, mobile: false});
      await ev('__bt.settle()');
      const rows = await ev(`(() => [].slice.call(document.querySelectorAll('#hits > .hit')).map((r) => {
        const c = r.querySelector(':scope > .hit-crits'), t = r.querySelector(':scope > .vehicle-tile'), b = c && c.getBoundingClientRect();
        return {event: r.hasAttribute('data-event'), left: b ? Math.round(b.left) : null, width: b ? Math.round(b.width) : null,
          tile: t ? Math.round(t.getBoundingClientRect().right) : null, list: Math.round(r.getBoundingClientRect().width), over: r.scrollWidth > r.clientWidth};
      }))()`);
      const same = (k) => rows.every((r) => r[k] !== null && r[k] === rows[0][k]);
      ok('list at ' + w + ' px: every hit and event row has the icon column at one place and width, the vehicle tiles end in one line, nothing overflows',
         rows.length >= 4 && rows.some((r) => r.event) && same('left') && same('tile') && rows.every((r) => r.width === 34 && !r.over), JSON.stringify(rows));
    }
    await page.send('Emulation.clearDeviceMetricsOverride'); await ev('__bt.settle()');

    async function loop(fun) {
      await ev('__bt.act.fun(' + fun + ')'); await ev('__bt.settle()');
      expectScene('a hit clicked', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('hit(0)'));
      // 25.09: the damage no shell dealt - its rows among the hits by time, and a scene with no penetration map.
      expectScene('a ram tile clicked', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('event(0)'));
      const ram = await ev(LOOK);
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (the ram: rows in time order, no map, the turret it touched red, the red cross on the contact, drawn)',
         ram.order === 'event,hit,hit,event' && ram.kind === 'ram' && ram.part === 2 && ram.map === false && ram.contact === true
         && ram.red > 0 && ram.details.indexOf('ContactTurret') >= 0, JSON.stringify(ram));
      expectScene('a fire tile clicked', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('event(1)'));
      const fire = await ev(LOOK);
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (the fire: the model burnt, no map, no contact cross)',
         fire.kind === 'fire' && fire.map === false && fire.contact === false && fire.dark > .7, JSON.stringify(fire));
      expectScene('a hit clicked after the tiles', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('hit(0)'));
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (a hit after them: the look gone, the map back)', (await ev(LOOK)).kind === null);
      expectScene('⇅ puts the Onslaught enemy on screen', fun, {model: true, shooter: true, hp: '1 950 / 1 950', source: HP.FILE}, await step('swap()'));
      expectScene('⇅ back', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('swap()'));
      expectScene('the side panel to Vehicles, the scene kept', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('shooterTile()'));
      expectScene('the side panel back to Hits', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step("side('battles')"));
      expectScene('another shooter from the roster', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('roster(32)'));
      expectScene('the side panel to Vehicles again', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('modelTile()'));
      expectScene('a vehicle browsed', fun, {model: true, shooter: true, hp: '1 600 / 1 600', source: HP.OWN}, await step("list('pm_quebec')"));
      await step('shooterTile()');   // the shooter's role in the list: no scene of its own
      expectScene('another shooter from the Vehicles list', fun, {model: true, shooter: true, hp: '1 600 / 1 600', source: HP.OWN}, await step("list('pm_papa')"));
      expectScene('⇅ of two browsed vehicles', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: HP.OWN}, await step('swap()'));
      // 24.09: a catalogue row without a model (not in this battle: the list on "All vehicles"). In the shooter's role its
      // file's gun fires at the model on screen; in the model's role it is its characteristics alone, and the scene says so.
      await step("scope('all')");
      if (!fun) {
        const listed = await ev(`(() => ({plain: !!document.querySelector('#vehicles [data-vehicle="germany-Uniform"]'), copy: !!document.querySelector('#vehicles [data-vehicle="germany-Uniform_SM"]')}))()`);
        ok('the list of all vehicles leaves out a copy the mod marks regular:false (25.09: no event or Story Mode copy)', listed.plain && !listed.copy, JSON.stringify(listed));
      }
      expectScene('a shooter without a model from the Vehicles list', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: HP.OWN}, await step("list('germany-Uniform')"));
      await step('modelTile()');
      const bare = await step("list('germany-Uniform')");
      expectScene('a vehicle without a model browsed', fun, {model: true, drawn: false, shooter: true, hp: null}, bare);
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (a vehicle without a model - the scene says so and the panel shows its file)',
         bare.message === 'No model yet: models come from the game. Open this viewer in the game and click the vehicle, or use Export all models there.' && bare.panel, '("' + bare.message + '", panel ' + bare.panel + ')');
      if (!fun) {
        // The compact panel as the user laid it out (24.09, two columns), on the rendered page: ⚙ ▴ ? on a row of their own;
        // the HP beside the gun chip under them; the DPM first with the reload beside it (a single-shot gun); dispersion |
        // aiming; the stabilisation three two and one; speed | specific power; hull | turret; view range; standing | moving.
        const R = await ev('__bt.panelRects()'), row = (a, b) => !!(R[a] && R[b]) && Math.abs(R[a].t - R[b].t) < 2;
        const col = (a, b) => !!(R[a] && R[b]) && Math.abs(R[a].l - R[b].l) < 1;
        const box = (sel) => ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return {l: b.left, r: b.right, t: b.top, b: b.bottom}; })()`);
        const tools = await box('#ttx-panel .ttx-tools'), chip = await box('#ttx-pair');
        ok('panel layout: the controls on a row of their own above the HP and the gun chip, and the HP and the chip above every figure',
           tools.b <= R.maxHealth.t && tools.b <= chip.t && Math.abs((R.maxHealth.t + R.maxHealth.b) / 2 - (chip.t + chip.b) / 2) < 4 && R.maxHealth.r < chip.l
           && R.maxHealth.b <= R.avgDamagePerMinute.t, JSON.stringify([tools, R.maxHealth, chip]));
        ok('panel layout: two columns - the DPM first, the reload beside it; dispersion | aiming under them',
           row('avgDamagePerMinute', 'reloadTimeSecs') && R.avgDamagePerMinute.r < R.reloadTimeSecs.l && row('shotDispersionAngle', 'aimingTime')
           && col('avgDamagePerMinute', 'shotDispersionAngle') && col('reloadTimeSecs', 'aimingTime') && R.shotDispersionAngle.t > R.avgDamagePerMinute.b - 1,
           JSON.stringify([R.avgDamagePerMinute, R.reloadTimeSecs]));
        const above = (top, low) => col(top, low) && R[low].t > R[top].b - 1 && R[low].t - R[top].b < 10;
        ok('panel layout: the stabilisation as column blocks - on the move above on hull traverse, on turret traverse beside them, under dispersion | aiming',
           above('stabMovement', 'stabRotation') && row('stabMovement', 'stabTurret') && col('stabMovement', 'shotDispersionAngle') && col('stabTurret', 'aimingTime')
           && R.stabMovement.t > R.shotDispersionAngle.b - 1, JSON.stringify([R.stabMovement, R.stabRotation, R.stabTurret]));
        ok('panel layout: Mobility as column blocks - speed above specific power, turret traverse above hull traverse',
           above('speedLimits', 'enginePowerPerTon') && above('turretRotationSpeed', 'hull') && row('speedLimits', 'turretRotationSpeed')
           && col('speedLimits', 'avgDamagePerMinute') && col('turretRotationSpeed', 'aimingTime'), JSON.stringify([R.speedLimits, R.enginePowerPerTon, R.turretRotationSpeed, R.hull]));
        ok('panel layout: Concealment - view range on the left, standing above moving on the right',
           row('circularVisionRadius', 'invisibilityStillFactor') && above('invisibilityStillFactor', 'invisibilityMovingFactor')
           && col('invisibilityStillFactor', 'aimingTime') && col('circularVisionRadius', 'avgDamagePerMinute') && R.circularVisionRadius.t > R.hull.b - 1,
           JSON.stringify([R.circularVisionRadius, R.invisibilityStillFactor, R.invisibilityMovingFactor]));
        // The panel's help opens UPWARD, over the empty scene (user 24.09): the "?" and a figure's own words, both above the panel.
        // Real clicks (the page's own tooltips.js takes trusted presses only): the "?", then again to leave the help mode,
        // then a figure's own words.
        const centre = (sel) => ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
        const press = async (xy) => { for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', {type, x: xy[0], y: xy[1], button: 'left', clickCount: 1}); await ev('__bt.settle(1500)'); };
        const tipBox = () => ev(`(() => { const t = document.getElementById('page-tip'); if (!t || t.hidden) return null; const b = t.getBoundingClientRect(); return {t: b.top, b: b.bottom}; })()`);
        const panelTop = await ev("document.getElementById('ttx-panel').getBoundingClientRect().top");
        await press(await centre('#ttx-panel .help-dot'));
        const dotTip = await tipBox();
        await press(await centre('#ttx-panel .help-dot'));
        await press(await centre('#ttx-compact .ttx-row[data-key=stabTurret] .ttx-val'));
        const figTip = await tipBox();
        await press([700, 300]);
        const help = {panel: panelTop, dot: dotTip, figure: figTip};
        ok('panel help: the "?" and a figure\'s words open above the panel, not over it',
           !!help.dot && !!help.figure && help.dot.b <= help.panel && help.figure.b <= help.panel, JSON.stringify(help));
      }
      expectScene('a vehicle with a model after one without', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: HP.OWN}, await step("list('pm_papa')"));
      await step("scope('battle')");
      const back = await step("side('battles')");
      expectScene('back to Hits with the browsed vehicle kept', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: HP.OWN}, back);
      // 03.10: the ⇅ of two browsed vehicles is the scene's own button - it read the side panel's mode and went in Hits.
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (the ⇅ of two browsed vehicles stands in the Hits panel as it stood in Vehicles)', await ev("(() => { const e = document.getElementById('swap-roles'); return e.getClientRects().length > 0; })()"));
      expectScene('another battle', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step("battle('pm2')"));
      await step('modelTile()'); await step("side('battles')");
      expectScene('a seat with no hits and no model - the scene emptied', fun, {model: false, shooter: false, hp: null}, await step('roster(33)'));
      await step("battle('pm')");
    }
    await loop(false);
    await loop(true);
    // Wheels (BACKLOG 39, 26.09): a hit on a wheeled vehicle's wheel, and that vehicle browsed. The wheels are parts -1..-4 of
    // the scene, each a procedural body (web/local-data.js wheelModel, 60 triangles), the contact on -3 lies on its wheel, and
    // its verdict meets the wheel first as a screen at its nominal 10 mm and goes on; the details name it Wheel 3.
    const WHEELS = `(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], parts = {};
      ((v.engine && v.engine.triangles) || []).forEach((t) => { if (t.part < 0) parts[t.part] = (parts[t.part] || 0) + 1; });
      const r = v.engine && v.shotPoints ? v.pointVerdicts(ArmorBallistics.shell('ARMOR_PIERCING', 250, 105)) : [], first = r[0] && r[0].result;
      // The parts' own colours with the map off (the wheels take the chassis'), then the map back.
      let plain = true; try { const map = v.heatmap; v.configure(v.shell, false, v.palette, v.mapMode); v.configure(v.shell, map, v.palette, v.mapMode); } catch (e) { plain = String(e); }
      return {parts: parts, points: (v.shotPoints || []).map((p) => p.part), reason: first && first.reason, plain: plain,
        layers: ((first && first.layers) || []).map((l) => [l.part, l.material, l.nominal, +l.effective.toFixed(3), l.main]),
        details: [].slice.call(document.querySelectorAll('#details > div')).map((d) => d.textContent).join(' | ')}; })()`;
    for (const fun of [false, true]) {
      await ev('__bt.act.fun(' + fun + ')'); await ev('__bt.settle()');
      await step("battle('pm5')");
      expectScene('a hit on a wheel (pm5)', fun, {model: true, shooter: true, hp: '1 400 / 1 400', source: HP.ROSTER}, await step('hit(0)'));
      const onWheel = await ev(WHEELS), four = (w) => [-1, -2, -3, -4].every((id) => w.parts[id] === 60) && Object.keys(w.parts).length === 4;
      ok('wheels, ⌖ ' + (fun ? 'on' : 'off') + ': the scene of the hit has the four wheels, the contact on -3, its verdict through the wheel as a screen',
         four(onWheel) && onWheel.points.indexOf(-3) >= 0 && onWheel.reason === 'penetration' && JSON.stringify(onWheel.layers[0]) === '[-3,"wheel",10,10,false]'
         && onWheel.layers.length >= 2 && onWheel.layers[onWheel.layers.length - 1][4] === true && onWheel.details.indexOf('Wheel 3') >= 0 && onWheel.plain === true, JSON.stringify(onWheel).slice(0, 400));
      await step('modelTile()');
      expectScene('the wheeled vehicle browsed', fun, {model: true, shooter: true, hp: '1 400 / 1 400', source: HP.OWN}, await step("list('pm_whiskey')"));
      const browsed = await ev(WHEELS);
      ok('wheels, ⌖ ' + (fun ? 'on' : 'off') + ': the browsed export draws its four wheels', four(browsed), JSON.stringify(browsed.parts));
      await step("side('battles')"); await step("battle('pm')"); await step('hit(0)');
    }
    // Armoured prefabs (27.09, prefab-parts): a hit on Xray's crest - part 4 of its own model on the gun, recorded in its
    // "1 position layer". The scene has it, the contact resolves on it and its verdict ends on its 150 mm; the details call
    // it the crest and say where it stood; the browsed export puts it at the default layer and turns it with the gun.
    const CREST = `(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], parts = {};
      ((v.engine && v.engine.triangles) || []).forEach((t) => { parts[t.part] = (parts[t.part] || 0) + 1; });
      const r = v.engine && v.shotPoints ? v.pointVerdicts(ArmorBallistics.shell('ARMOR_PIERCING', 250, 105)) : [], first = r[0] && r[0].result;
      const last = first && first.layers && first.layers[first.layers.length - 1];
      return {crest: parts[4] || 0, points: (v.shotPoints || []).map((p) => p.part), end: last ? [last.part, last.material, last.nominal] : null,
        follows: ((e) => !!(e && e[4] && e[4] === e[3]))(v.poseExtra()),
        details: [].slice.call(document.querySelectorAll('#details > div')).map((d) => d.textContent).join(' | ')}; })()`;
    for (const fun of [false, true]) {
      await ev('__bt.act.fun(' + fun + ')'); await ev('__bt.settle()');
      await step("battle('pm6')");
      expectScene('a hit on an armoured crest (pm6)', fun, {model: true, shooter: true, hp: '1 900 / 1 900', source: HP.ROSTER}, await step('hit(0)'));
      const onCrest = await ev(CREST);
      ok('prefabs, ⌖ ' + (fun ? 'on' : 'off') + ': the crest is in the scene, the contact on it, its verdict ends on its own 150 mm; the details say Crest, position 2 of 4 at the hit',
         onCrest.crest === 12 && onCrest.points[0] === 4 && JSON.stringify(onCrest.end) === '[4,"armor_1",150]' && onCrest.follows
         && onCrest.details.indexOf('Crest') >= 0 && onCrest.details.indexOf('At the hit: position 2 of 4 · 3.3°') >= 0, JSON.stringify(onCrest).slice(0, 400));
      await step('modelTile()');
      expectScene('the crested vehicle browsed', fun, {model: true, shooter: true, hp: '1 900 / 1 900', source: HP.OWN}, await step("list('pm_xray')"));
      const browsed = await ev(CREST);
      ok('prefabs, ⌖ ' + (fun ? 'on' : 'off') + ': the browsed export draws its crest and turns it with the gun', browsed.crest === 12 && browsed.follows, JSON.stringify(browsed).slice(0, 300));
      await step("side('battles')"); await step("battle('pm')"); await step('hit(0)');
    }
    // A target picked by hand inherits the view (user, 26.09): Papa shoots, Papa -> Quebec -> Papa as the model by clicks
    // in the Vehicles list. The camera, the pose and the shooter's shell carry over, and Papa comes back as he was.
    await ev('__bt.act.fun(false)'); await ev('__bt.settle()');
    await step('shooterTile()'); await step("list('pm_papa')"); await step('modelTile()'); await step("list('pm_papa')");
    const VIEW = `(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], p = v.camera.position;
      return {yaw: v.yaw, pitch: v.pitch, distance: v.distance, zoom: v.camera.zoom, turret: v.turretAngle, gun: v.gunAngle, eye: [p.x, p.y, p.z],
        shell: document.getElementById('shell-choice').value, tile: document.getElementById('pose-turret').textContent}; })()`;
    await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; v.setTurret(100); v.setGun(4); v.setOrbit(1.2, .35);
      v.setDistance(21); v.setZoom(1.7); const c = document.getElementById('shell-choice'); c.value = 'saved:1'; c.dispatchEvent(new Event('change')); })()`);
    await ev('__bt.settle()');
    const viewA = await ev(VIEW);
    await step("list('pm_quebec')");
    const viewB = await ev(VIEW);
    await step("list('pm_papa')");
    const viewA2 = await ev(VIEW);
    const close = (a, b) => Math.abs(a - b) < 1e-6;
    ok('target picked by hand: Quebec keeps the camera angles, the distance, the zoom, the turret 100° and the gun, and the shooter\'s APCR',
       close(viewB.yaw, 1.2) && close(viewB.pitch, .35) && close(viewB.distance, 21) && close(viewB.zoom, 1.7) && close(viewB.turret, 100) && close(viewB.gun, 4)
       && viewB.shell === 'saved:1' && viewB.tile.indexOf('+100°') >= 0, JSON.stringify([viewA, viewB]));
    ok('target picked by hand: back to Papa - the very first picture', ['yaw', 'pitch', 'distance', 'zoom', 'turret', 'gun'].every((k) => close(viewA2[k], viewA[k]))
       && viewA2.eye.every((x, i) => close(x, viewA.eye[i])) && viewA2.shell === viewA.shell && viewA.shell === 'saved:1', JSON.stringify([viewA, viewA2]));
    ok('target picked by hand: no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    page.errors.length = 0;
    // The wheel over the Distance and Zoom sliders (user, 26.09): the scene's own eased glide (viewer.wheel) at the slider's
    // gain - real wheel events at the slider, a burst of 20 notches - and the shell redone once at its end, not per notch.
    const at = (sel) => ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    const roll = async (sel, n, dy) => { const xy = await at(sel); for (let i = 0; i < n; i++) await page.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: xy[0], y: xy[1], deltaX: 0, deltaY: dy});
      // The glide ends in the viewer's own frame loop (the page's words do not change on the way), then the shell's 150 ms.
      await ev(`(async () => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; for (let i = 0; i < 300 && v.cameraGliding(); i++) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 400)); })()`); await ev('__bt.settle()'); };
    const W0 = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; v.__shells = 0; const c = v.configure; v.configure = function () { v.__shells++; return c.apply(this, arguments); };
      v.setAutoFrame(false); document.getElementById('auto-frame').checked = false; return {d: v.distance, z: v.camera.zoom}; })()`);
    await roll('#camera-distance', 20, 100);
    const W1 = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; return {d: v.distance, z: v.camera.zoom, shells: v.__shells, gliding: v.cameraGliding(),
      field: document.getElementById('camera-distance-field').value}; })()`);
    ok('slider wheel: 20 notches over Distance - the scene\'s glide at half its step (x e^2), the box following, the shell redone once at the end',
       Math.abs(W1.d / W0.d - Math.exp(2)) < 1e-6 && !W1.gliding && W1.shells === 1 && W1.field === String(Math.round(W1.d)), JSON.stringify([W0, W1]));
    await roll('#camera-zoom', 1, -100);
    const W2 = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], z = v.camera.zoom; delete v.configure; return {z: z}; })()`);
    ok('slider wheel: a notch over Zoom zooms by the scene\'s Ctrl + wheel step (x1.221), no modifier needed', Math.abs(W2.z / W1.z - Math.exp(.2)) < 1e-6, JSON.stringify([W1, W2]));
    await roll('#camera-distance-field', 3, -100);
    const W3 = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; return {range: v.shotRange(), field: document.getElementById('camera-distance-field').value}; })()`);
    ok('box wheel: three notches over the Distance box - three whole metres, on the metre grid', W3.range === Math.floor(W1.d + 1e-6) + 3 && W3.field === String(W3.range), JSON.stringify([W1, W3]));

    // ---- the inherit sweep (26.09): what the user did not change is not reset ------------------------------------------
    // State now: the Vehicles panel, Papa shoots Papa, ⌖ off.
    const LV = 'window.__bullbaViewers[window.__bullbaViewers.length - 1]';
    const STATE = `(() => { const v = ${LV}, c = document.getElementById('shell-choice'); return {yaw: v.yaw, pitch: v.pitch, distance: v.distance,
      turret: v.turretAngle, gun: v.gunAngle, pinned: !!v.pinned, ring: !!v.aimShotCircle, source: document.getElementById('shot-source').textContent,
      shell: c.value, shells: [].filter.call(c.options, (o) => o.value.indexOf('saved:') === 0).length, figure: document.getElementById('shot-circle').textContent,
      model: document.getElementById('model-tile').title, shooter: document.getElementById('shooter-tile').title}; })()`;
    // A point pinned by a click in the middle of the scene (the viewer's own pinAt, the ray through the screen centre).
    const PIN = `(() => { const v = ${LV}, r = v.container.getBoundingClientRect(); v.pinAt({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}); return !!v.pinned; })()`;
    const ORBIT = (yaw, pitch, dist) => ev(`(() => { const v = ${LV}; v.setOrbit(${yaw}, ${pitch}); v.setDistance(${dist}); v.render(); })()`);
    const who = (title, name) => title.indexOf('Vehicle: ' + name) >= 0;
    // 2, 3, 7: another shooter from the Vehicles list - the camera, the pose, the pinned point and the shell's type stay.
    await ev(`(() => { const v = ${LV}; v.setTurret(35); v.setGun(2); const c = document.getElementById('shell-choice'); c.value = 'saved:1'; c.dispatchEvent(new Event('change')); })()`);
    await ORBIT(.9, .3, 18); await ev('__bt.settle()');
    const pinned0 = await ev(PIN); await ev('__bt.settle()');
    await step('shooterTile()'); await step("list('pm_quebec')");
    const I1 = await ev(STATE);
    ok('inherit: another shooter from the Vehicles list keeps the camera, the turret 35° and the gun 2°', close(I1.yaw, .9) && close(I1.pitch, .3) && close(I1.distance, 18)
       && close(I1.turret, 35) && close(I1.gun, 2) && who(I1.shooter, 'Quebec'), JSON.stringify(I1));
    ok('inherit: ... the pinned point stays (the model did not change), and the shell is his of the same type (APCR, not his first AP)',
       pinned0 && I1.pinned && I1.source === 'Pinned point' && I1.shell === 'saved:1', JSON.stringify(I1));
    // 5: the fragment from the game names the model; the shooter picked stays.
    await ev("location.hash = '#vehicle=test_vehicle'"); await ev('__bt.settle()');
    const I2 = await ev(STATE);
    ok('inherit: #vehicle= from the game puts its vehicle on screen and keeps the shooter picked (Quebec), with the camera', who(I2.model, 'Test vehicle') && who(I2.shooter, 'Quebec')
       && close(I2.yaw, .9) && close(I2.distance, 18) && I2.shells === 2, JSON.stringify(I2));
    await ev("history.replaceState(null, '', location.pathname + location.search)");
    // click-export-fast (26.09): the offline viewer never waits for an export nobody makes - #vehicle= of a vehicle without a
    // model says so at once, no spinner on the scene or on a row; a row that waits in the game wears the scene's own ring.
    await ev("location.hash = '#vehicle=germany-Uniform'");
    const CE = await ev(`(async () => {
      const m = document.getElementById('scene-message');
      for (let i = 0; i < 40 && !/not exported/.test(m.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      const row = document.querySelector('#vehicles [data-vehicle]');
      let ring = null;
      if (row) { row.setAttribute('data-loading', 'true'); const a = getComputedStyle(row, '::after');
        ring = {anim: a.animationName, w: a.width, op: getComputedStyle(row).opacity}; row.removeAttribute('data-loading'); }
      return {text: m.textContent, busy: m.classList.contains('busy'), loading: document.querySelectorAll('#vehicles [data-loading]').length, ring: ring};
    })()`);
    ok('click export: offline #vehicle= of a vehicle without a model says so at once - no spinner on the scene or a row',
       /not exported/.test(CE.text) && !CE.busy && CE.loading === 0, JSON.stringify(CE));
    ok('click export: a row waiting for its export wears the scene\'s ring (bullba-spin, 14 px) at full strength',
       !!CE.ring && CE.ring.anim === 'bullba-spin' && CE.ring.w === '14px' && CE.ring.op === '1', JSON.stringify(CE.ring));
    await ev("history.replaceState(null, '', location.pathname + location.search)");
    // 1: a model picked in the list after a hit: the hit's shooter (Papa, pm3) goes on shooting, read from his own export.
    await step("side('battles')"); await step("battle('pm3')"); await step('hit(0)');
    await step('modelTile()'); await step("list('pm_quebec')");
    const I3 = await ev(STATE);
    ok('inherit: a model picked after a hit keeps the hit\'s shooter (Papa) with his shells - not the model as its own shooter', who(I3.model, 'Quebec') && who(I3.shooter, 'Papa') && I3.shells === 2, JSON.stringify(I3));
    // 6: ⇅ of a recorded hit - the shooter's vehicle in the camera on screen, round its own centre.
    await step("side('battles')"); await step("battle('pm')"); await step('hit(1)');
    await ORBIT(.8, .25, 25); await ev('__bt.settle()');
    await step('swap()');
    const I4 = await ev(STATE);
    ok('inherit: ⇅ of a recorded hit opens the shooter\'s vehicle in the camera on screen', close(I4.yaw, .8) && close(I4.pitch, .25) && close(I4.distance, 25) && who(I4.model, 'Quebec'), JSON.stringify(I4));
    await step('swap()');
    // ... and where the record has the shooter at the shot (pm-1: his motion - 120 m out facing the player, turret 0.2 rad
    // right, gun 0.02 rad up), he stands in that pose - in the camera on screen (04.10; from 26.09 the view started from
    // the shot, the eye at the hit point looking back at him, and every ⇅ moved the camera).
    await step('hit(0)');
    const I4a = await ev(STATE);
    await step('swap()');
    const I4b = await ev(STATE);
    ok('inherit: ⇅ of a recorded hit with the shooter\'s motion - the camera on screen stays, his turret 11.5° and gun 1.1° up',
       close(I4b.yaw, I4a.yaw) && close(I4b.pitch, I4a.pitch) && close(I4b.distance, I4a.distance) && close(I4b.turret, .2 * 180 / Math.PI) && close(I4b.gun, -.02 * 180 / Math.PI) && who(I4b.model, 'Romeo'),
       JSON.stringify([I4a, I4b]));
    await step('swap()');
    // 2 in Hits: another shooter from the roster over a recorded hit - the record's pose with the user's turn on it, the pin.
    await step('hit(0)'); await step('shooterTile()'); await step("side('battles')");
    await ev(`(() => { const v = ${LV}; v.setTurret(20); v.setGun(1); })()`); await ORBIT(1.1, .2, 16); await ev('__bt.settle()');
    const pinned1 = await ev(PIN); await ev('__bt.settle()');
    await step('roster(32)');
    const I5 = await ev(STATE);
    ok('inherit: another shooter from the roster keeps the camera, the turret 20° and the gun 1° on the record\'s pose, and the pinned point',
       pinned1 && close(I5.yaw, 1.1) && close(I5.distance, 16) && close(I5.turret, 20) && close(I5.gun, 1) && I5.pinned && I5.source === 'Pinned point' && who(I5.shooter, 'Quebec'), JSON.stringify(I5));
    // 4: the Vehicles panel over an empty scene. The switch itself changes nothing (03.10: the side panel is the picker
    // only - it used to bring back the vehicle the panel showed last); a vehicle PICKED there comes in the view of the last
    // scene, not the default one.
    await step('modelTile()'); await step("side('battles')"); await ORBIT(.6, .15, 22); await ev('__bt.settle()');
    await step('roster(33)');   // Sierra: no hits, no model - the scene emptied
    const emptied = await ev('__bt.sig()'), said = await step("side('vehicles')");
    ok('inherit: the switch to Vehicles over an empty scene leaves it empty, with its words', !emptied.model && !said.model && !said.shooter && said.message === emptied.message && said.message !== '',
       JSON.stringify([emptied.message, said.message, said.model]));
    await step("list('pm_quebec')");
    const I6m = await ev(STATE);
    await step('shooterTile()'); await step("list('pm_papa')");
    const I6 = await ev(STATE);
    ok('inherit: a vehicle picked over an empty scene comes in the last scene\'s view', who(I6m.model, 'Quebec') && close(I6m.yaw, .6) && close(I6m.pitch, .15) && close(I6m.distance, 22)
       && who(I6.shooter, 'Papa') && close(I6.yaw, .6) && close(I6.distance, 22), JSON.stringify([I6m, I6]));
    // 8: an emulated shot, then the same model under the same gun again - its ring, its pin and its figure stay; another model
    // takes the shot away, while the run (the reload of that shot) goes on for the shooter.
    const FIRE = `(() => { const v = ${LV}, r = v.container.getBoundingClientRect(), caster = v.pointerRay({clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}),
      hit = v.pick(caster.ray.origin, caster.ray.direction); if (!hit) return 'no model under the centre';
      v.liveAimPoint = hit.point.clone(); v.aimCursorPoint = hit.point.clone(); v.drawLiveAim();
      const down = v.onShotDown({}); v.onShotUp({}); return down && !!v.aimShotCircle; })()`;
    const shooterNow = I6.shooter.indexOf('Vehicle: Papa') >= 0 ? 'pm_papa' : 'pm_quebec';
    const fired = await ev(FIRE); await ev('__bt.settle(1500)');
    const I7a = await ev(STATE);
    await step('shooterTile()', 1500); await step("list('" + shooterNow + "')", 1500);
    const I7 = await ev(STATE);
    ok('inherit: the same model under the same gun again keeps the ⌖ shot - its ring, its pin and its figure', fired === true && I7a.ring && I7.ring && I7.pinned && I7.figure !== '' && I7.figure === I7a.figure,
       JSON.stringify([fired, I7a, I7]));
    await step('modelTile()', 1500); await step("list('pm_papa')", 1500);
    const I8 = await ev(`(() => { const v = ${LV}; return {ring: !!v.aimShotCircle, pinned: !!v.pinned, live: v.liveRadius100 > 0, reload: v.aimReloadPart}; })()`);
    ok('inherit: another model takes the shot away (its ring and pin), the shooter\'s ⌖ ring stands on', !I8.ring && !I8.pinned && I8.live, JSON.stringify(I8));
    // 1: the last shooter used is kept with the side panel's state; a page opened on a vehicle from the game (nothing on
    // screen) gives it to him - not the model as its own shooter. The vehicle list is held back 400 ms, so the vehicle's
    // file arrives first - the order that, under load, left the page re-reading the list every 50 ms on "Preparing the
    // model..." for good (27.09; this check was flaky: about 1 run in 5 with 5 pages in parallel).
    const kept = await ev("(() => { try { return JSON.parse(localStorage.getItem('bullba-sidebar')).shooter; } catch (e) { return null; } })()");
    const LIST_LATE = `;(() => { const append = Node.prototype.appendChild; let held = false;
      Node.prototype.appendChild = function (n) { if (!held && n && n.tagName === 'SCRIPT' && String(n.src).indexOf('/data/vehicles.js') >= 0) { held = true; const self = this;
        setTimeout(() => append.call(self, n), 400); return n; } return append.call(this, n); }; })();`;
    const page2 = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href + '#vehicle=pm_quebec', INIT + LIST_LATE);
    const fresh = await page2.evaluate(`(async () => { const t = (id) => document.getElementById(id).title;
      for (let i = 0; i < 100 && t('model-tile').indexOf('Vehicle: Quebec') < 0; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500)); return {model: t('model-tile'), shooter: t('shooter-tile'), message: document.getElementById('scene-message').textContent}; })()`);
    ok('inherit: the last shooter used is stored (' + kept + ') and a page opened on a vehicle from the game shoots with him',
       kept === 'germany:Papa' && who(fresh.model, 'Quebec') && who(fresh.shooter, 'Papa') && page2.errors.length === 0, JSON.stringify([kept, fresh, page2.errors.slice(0, 2)]));
    await browser.send('Target.closeTarget', {targetId: page2.targetId});
    // EXPORT ALL MODELS IN THE GAME (28.09: the user saw no button in 0.9.0 - not reproduced, this path had no check on
    // the real page). The page as the game opens it from the hangar (#host=game&vehicle=..., the mod's channel stubbed:
    // jsHostQuery records the commands), the progress file as the mod writes it before any Start (opted false, 917 of
    // 1060, the user's own file of 28.09 01:36 in shape). The button stands laid out in the Vehicles panel with nothing
    // over it; its click asks in the header; Start sends the command, the bar and the button count; the mod's next
    // progress file moves both and the button shows the time left.
    const sweepFile = (v) => fs.writeFileSync(path.join(folder, 'data', 'models-sweep.js'), 'ArmorInspectorData.receive(' + JSON.stringify(['modelsSweep', v]) + ');\n');
    const plan = {stamp: {format: 1}, startedAt: 1, done: false, count: 0, total: 917, catalogue: 1060, confirmed: false, retrying: false,
      built: 0, builtMs: 0, keys: {}, failed: {}, incremental: false, updatedAt: 1, estimate: 312, parts: {}, extension: [], bytes: 0, opted: false, failedOnly: false};
    sweepFile(plan);
    const HOSTQ = `;window.__sent = []; window.jsHostQuery = function (q) { try { window.__sent.push(JSON.parse(q.request)); } catch (e) {}
      setTimeout(function () { q.onSuccess('ok'); }, 0); };`;
    const page3 = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href + '#host=game&vehicle=pm_quebec', INIT + HOSTQ);
    const SWEEP_UI = `(() => { const $ = (id) => document.getElementById(id), b = $('models-all'), r = b.getBoundingClientRect(),
      laid = (e) => e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0, top = laid(b) ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {button: laid(b), onTop: top === b, text: b.textContent, disabled: b.disabled, pane: !$('vehicles-pane').hidden, ask: laid($('models-sweep-ask')),
        head: $('models-sweep-ask-head').textContent, words: $('models-sweep-ask-text').textContent, bar: laid($('models-sweep')), count: $('models-sweep-count').textContent,
        stop: laid($('models-sweep-stop')), sent: window.__sent.filter((m) => m.params && /^sweep/.test(m.params.action)).map((m) => m.params.action + ':' + m.params.kind)}; })()`;
    const until = (cond, ms) => page3.evaluate(`(async () => { const t = Date.now(); let s; while (Date.now() - t < ${ms}) { s = ${SWEEP_UI}; if (${cond}) break;
      await new Promise((r) => setTimeout(r, 100)); } return s; })()`);
    const E0 = await until('s.button', 10000);
    ok('models in the game: Export all models stands in the Vehicles panel, nothing over it, before any Start (opted false)',
       E0.pane && E0.button && E0.onTop && E0.text === 'Export all models' && !E0.disabled && !E0.bar && !E0.ask, JSON.stringify(E0));
    await page3.evaluate(`document.getElementById('models-all').click()`);
    const E1 = await until('s.ask', 3000);
    ok('models in the game: its click asks in the header - all 917 of 1060, the size and the mod\'s time',
       E1.ask && E1.head === 'Export all models' && E1.words.indexOf('917 of 1060 regular vehicles') === 0 && E1.words.indexOf('about 5 min 10 s') > 0, JSON.stringify(E1));
    await page3.evaluate(`document.getElementById('models-sweep-go').click()`);
    const E2 = await until('s.bar && s.sent.length', 3000);
    ok('models in the game: Start sends the models\' sweepStart; the bar 0 / 917 with ■, the button counts and waits',
       E2.sent.join() === 'sweepStart:models' && E2.bar && E2.stop && E2.count === '0 / 917' && !E2.ask && E2.disabled
       && E2.text.indexOf('Exporting models… 0 / 917') === 0, JSON.stringify(E2));
    sweepFile(Object.assign({}, plan, {count: 40, confirmed: true, opted: true, built: 40, bytes: 7000000, estimate: 290}));
    const E3 = await until("s.count === '40 / 917'", 8000);
    ok('models in the game: the mod\'s next progress file moves the bar and the button, with the time left',
       E3.count === '40 / 917' && E3.bar && E3.text === 'Exporting models… 40 / 917 · about 4 min 50 s left' && page3.errors.length === 0,
       JSON.stringify([E3, page3.errors.slice(0, 2)]));
    await browser.send('Target.closeTarget', {targetId: page3.targetId});
    // NOT IN THE GAME CLIENT (04.10, the user's Nameless and Edelweiss: "2 vehicles failed ... to try them again", and a
    // Start that could never succeed). His progress file as the mod writes it now (1060 regular, the two 'absent', the user
    // had started the sweep) and a catalogue row flagged 'notInClient' (Uniform: no model, its characteristics file is
    // there). The page opened in the game asks nothing about the models and shows no bar; the row is dimmed and says why; a click asks the
    // game for no export and the scene says why there is no model.
    sweepFile({stamp: {client: 'x', format: 1}, startedAt: 1, done: true, count: 0, total: 0, catalogue: 1060, confirmed: false, retrying: false,
      built: 1778, builtMs: 112134.6, keys: {}, failed: {}, incremental: false, updatedAt: 2, estimate: 0, parts: {}, extension: [], bytes: 298016148,
      opted: true, failedOnly: false, returned: [], absent: {'japan:J29_Nameless': {resources: ['a', 'b', 'c', 'd'], whole: true, client: 'x'},
                                                             'japan:J30_Edelweiss': {resources: ['a', 'b', 'c', 'd'], whole: true, client: 'x'}}});
    const listFile = path.join(folder, 'data', 'vehicles.js'), listWas = fs.readFileSync(listFile, 'utf8');
    fs.writeFileSync(listFile, listWas.replace('{"id":"germany-Uniform",', '{"notInClient":true,"id":"germany-Uniform",'));
    const page4 = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href + '#host=game&vehicle=pm_quebec', INIT + HOSTQ);
    const GONE_UI = `(() => { const $ = (id) => document.getElementById(id), laid = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0,
      row = document.querySelector('#vehicles [data-vehicle="germany-Uniform"]');
      return {ask: laid($('models-sweep-ask')), ttxAsk: laid($('ttx-sweep-ask')), bar: laid($('models-sweep')), all: $('models-all').textContent, allLaid: laid($('models-all')),
        row: !!row, opacity: row ? getComputedStyle(row).opacity : '', tip: row ? (row.getAttribute('data-tip') || row.title || '') : '',
        message: $('scene-message').textContent, spinning: document.querySelectorAll('#vehicles [data-loading]').length,
        model: $('model-tile').getAttribute('data-tip') || $('model-tile').title || '',
        sent: window.__sent.map((m) => m.params && m.params.action).filter((a) => a && a !== 'open')}; })()`;
    const untilGone = (cond, ms) => page4.evaluate(`(async () => { const t = Date.now(); let s; while (Date.now() - t < ${ms}) { s = ${GONE_UI}; if (${cond}) break;
      await new Promise((r) => setTimeout(r, 100)); } return s; })()`);
    const N0 = await untilGone("s.allLaid && s.row && s.model.indexOf('Quebec') >= 0", 10000);
    await page4.evaluate('new Promise((r) => setTimeout(r, 1500))');   // a question would be up by now
    const N1 = await page4.evaluate(GONE_UI);
    ok('not in the client, in the game: the page asks nothing about the models and shows no bar - the export is complete',
       N0.allLaid && !N1.ask && !N1.bar && N1.all === 'All models exported ✓' && N1.sent.every((a) => !/^sweep/.test(a)), JSON.stringify(N1));
    ok('not in the client: its row is dimmed like any row without a model, and its words say why',
       N1.row && N1.opacity === '0.45' && /\n• Collision model: not in the game client$/.test(N1.tip), JSON.stringify([N1.opacity, N1.tip]));
    await page4.evaluate(`document.querySelector('#vehicles [data-vehicle="germany-Uniform"]').click()`);
    const N2 = await untilGone("s.model.indexOf('Uniform') >= 0 && s.message !== ''", 5000);
    await page4.evaluate('new Promise((r) => setTimeout(r, 600))');   // an export's poll would have come by now
    const N3 = await page4.evaluate(GONE_UI);
    ok('not in the client: a click asks the game for no export and waits for nothing - the scene says why there is no model',
       N3.message === 'No model: the game client has no collision model of this vehicle.' && N3.model.indexOf('Uniform') >= 0 && !N3.spinning
       && N3.sent.indexOf('exportVehicle') < 0 && N3.sent.indexOf('prioritise') < 0 && page4.errors.length === 0,
       JSON.stringify([N2.message, N3.message, N3.model.split('\n')[1], N3.spinning, N3.sent, page4.errors.slice(0, 2)]));
    await browser.send('Target.closeTarget', {targetId: page4.targetId});
    fs.writeFileSync(listFile, listWas);
    fs.rmSync(path.join(folder, 'data', 'models-sweep.js'), {force: true});
    // keep-onscreen-model (26.09, the Panther II of the Waffenträger event): pm4's target Victor has the complete model in
    // the record, while his export lacks the gun's model. Hits -> the Shooter tile -> another shooter in "This battle": the
    // model ON SCREEN stays (no re-read of the export), in the record's pose with the user's turn, the pinned point kept;
    // the Vehicles ⇅ there and back puts the same model on screen again.
    const KEEP = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : {target: {}}, p = v.loadedData ? v.poseNow() : {}; return {vehicle: !!h.vehicle,
      keys: (h.target.parts || []).map((x) => x.modelKey || 'none').join(), yaw: p.yaw, pitch: p.pitch, pinned: !!v.pinned,
      source: document.getElementById('shot-source').textContent, message: document.getElementById('scene-message').textContent,
      warnings: document.getElementById('warnings').textContent, model: document.getElementById('model-tile').title,
      shooter: document.getElementById('shooter-tile').title}; })()`;
    await step("side('battles')"); await step("battle('pm4')"); await step('hit(0)');
    await ev(`(() => { const v = ${LV}; v.setTurret(10); })()`); await ev('__bt.settle()');
    const pinnedK = await ev(PIN); await ev('__bt.settle()');
    const K0 = await ev(KEEP);
    await step('shooterTile()'); await step("scope('battle')"); await step("list('pm_quebec')");
    const K1 = await ev(KEEP);
    const whole = (k) => k.keys !== '' && k.keys.indexOf('none') < 0 && !/Complete vehicle model unavailable/.test(k.message) && !/not found in client/.test(k.warnings);
    ok('keep on-screen model: another shooter via the Shooter tile keeps the recorded model (not its export without the gun model)',
       pinnedK && whole(K0) && K1.vehicle && whole(K1) && K1.keys === K0.keys && who(K1.model, 'Victor') && who(K1.shooter, 'Quebec'), JSON.stringify([K0, K1]));
    ok('keep on-screen model: ... in the recorded pose with the turn on it, and the pinned point stays',
       close(K1.yaw, K0.yaw) && close(K1.pitch, K0.pitch) && close(K0.yaw, .3 + 10 * Math.PI / 180) && K1.pinned && K1.source === 'Pinned point', JSON.stringify([K0, K1]));
    await step('swap()'); await step('swap()');
    const K2 = await ev(KEEP);
    ok('keep on-screen model: the Vehicles ⇅ there and back puts the same recorded model on screen, shot by Quebec',
       whole(K2) && K2.keys === K0.keys && who(K2.model, 'Victor') && who(K2.shooter, 'Quebec'), JSON.stringify(K2));
    await ev('__bt.act.fun(true)'); const K3 = await ev('__bt.settle().then(() => __bt.sig())'); await ev('__bt.act.fun(false)'); await ev('__bt.settle()');
    ok('keep on-screen model: ... still that battle’s seat - its health is the roster’s figure', K3.hpText.indexOf('3 000 / 3 000') >= 0 && K3.hpTip.indexOf(HP.ROSTER) >= 0, JSON.stringify([K3.hpText, K3.hpTip]));
    ok('inherit: no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    page.errors.length = 0;
    await step("side('battles')"); await ev('__bt.act.fun(true)'); await ev('__bt.settle()');
    // A target whose only figure is in his own characteristics file: that file is read for him and the bar comes with it.
    const pm3 = await step("battle('pm3')");
    ok('matrix, ⌖ on: a target whose only figure is in his own characteristics file gets the bar from it',
       pm3.hp && pm3.hpText === '1 234 / 1 234' && pm3.hpTip.indexOf('• Source: ' + HP.FILE) >= 0, '(shown ' + pm3.hp + ', "' + pm3.hpText + '")');
    await ev('__bt.act.fun(false)'); await ev('__bt.settle()');

    // ---- the shot ring of an own shot (BACKLOG 28 step 2, 24.09) ----------------------------------------------
    // pm3's hit is the player's own shot with its tracer: two thin magenta outlines and the thick long-dashed ring, whose
    // server update is one tick stale - the ⚠ beside the circle tile. The Settings switch hides the ring and the ⚠, the
    // slider sets its opacity, the temporary lab its look, all stored (the first emulated shot hiding it with the
    // outlines: viewer_batch.cjs).
    const disc = () => ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], e = document.getElementById('shot-disc-stale');
      let stored = null; try { stored = JSON.parse(localStorage.getItem('bullba-settings')).values; } catch (x) {}
      return {disc: !!(v.discAim && v.shotDisc && v.shotDisc.visible && v.aimGroup && v.aimGroup.visible), ring: !!v.ringAim, stale: !!(v.discAim && v.discAim.stale),
        figure: v.savedAim === v.discAim ? 'disc' : v.savedAim === v.ringAim ? 'ring' : String(v.savedAim), opacity: v.shotDisc ? v.shotDisc.material.uniforms.uOpacity.value : null,
        width: v.shotDisc ? v.shotDisc.material.uniforms.uWidth.value : null,
        prog: (() => { const p = v.shotDisc && v.renderer.properties.get(v.shotDisc.material).currentProgram; return p ? (p.diagnostics && !p.diagnostics.runnable ? 'failed' : 'ok') : 'none'; })(),
        icon: e.getClientRects().length > 0, tip: e.title, stored: stored && [stored['shot-ring'], stored['shot-ring-opacity'], stored['ring-width']],
        legend: document.getElementById('shot-circle-tile').title}; })()`);
    await step('hit(0)');
    let d = await disc();
    ok('shot ring: an own shot shows both thin outlines and the thick ring (6 px, 25 %), the figure over it; its shader compiled and ran', d.disc && d.ring && d.figure === 'disc' && d.prog === 'ok' && d.width === 6 && Math.abs(d.opacity - .25) < 1e-9, JSON.stringify(d));
    ok('shot disc: a stale update puts the ⚠ beside the circle tile, its words say what and how far', d.stale && d.icon && d.tip.indexOf('one tick uncertain') >= 0 && d.tip.indexOf('1.50 m') >= 0, '(' + d.icon + ', "' + d.tip.slice(0, 80) + '")');
    await ev("(() => { document.getElementById('shot-ring').click(); return true; })()"); await ev('__bt.settle()');
    await new Promise((r) => setTimeout(r, 400));
    d = await disc();
    ok('shot disc: switched off in Settings - no disc, no ⚠, the figure back on the solid ring, stored', !d.disc && !d.icon && d.figure === 'ring' && d.stored && d.stored[0] === false, JSON.stringify(d));
    ok('shot ring: and the Circle tile names neither the thick ring nor the ⚠ any more (review 24.09)',
       d.legend.indexOf('Solid') >= 0 && d.legend.indexOf('Thick') < 0 && d.legend.indexOf('⚠') < 0 && d.legend.indexOf('No thick ring') < 0, '("' + d.legend.slice(0, 200) + '")');
    await ev("(() => { document.getElementById('shot-ring').click(); const s = document.getElementById('shot-ring-opacity'); s.value = '35'; s.dispatchEvent(new Event('input')); const w = document.getElementById('ring-width'); w.value = '9'; w.dispatchEvent(new Event('input')); return true; })()");
    await ev('__bt.settle()'); await new Promise((r) => setTimeout(r, 400));
    d = await disc();
    ok('shot ring: back on, the Circle tile names the thick ring again', d.legend.indexOf('Thick') >= 0 && d.legend.indexOf('⚠') >= 0, '("' + d.legend.slice(0, 200) + '")');
    ok('shot ring: back on, the slider sets its opacity and the lab its thickness, all stored', d.disc && d.icon && Math.abs(d.opacity - .35) < 1e-9 && d.width === 9
       && d.stored && d.stored[0] === true && d.stored[1] === '35' && d.stored[2] === '9', JSON.stringify(d));
    await ev("(() => { const s = document.getElementById('shot-ring-opacity'); s.value = '60'; s.dispatchEvent(new Event('input')); const w = document.getElementById('ring-width'); w.value = '6'; w.dispatchEvent(new Event('input')); return true; })()");
    await ev('__bt.settle()');

    // ---- the shell's own flight and the game's oddities (shot-line-true, 24.09) ------------------------------------
    // pm3's own shot carries its tracer and the server's stop 0.8 m along the hull from the recorded point: the page draws the
    // flight as an arc from the real origin carried onto the point, the camera stands at that origin, and the hit-line panel
    // shows the pose mark (> 0.5 m) with its words and its own help dot; the shooter stands above the tracks - no height mark.
    // Ring axes (the lab's switch): three lines, off by default, shown by the switch.
    await step("battle('pm3')"); await step('hit(0)');
    const flight = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], p = v.shotPath, g = document.getElementById('pose-gap'), h = document.getElementById('shooter-height');
      const dot = document.querySelector('#hit-marks .help-dot'), arc = v.root.children.find((o) => o.userData && o.userData.shotArc);
      return {path: !!p, gap: p ? p.gap : null, eye: p ? v.camera.position.distanceTo(p.origin) : null, arc: !!arc && arc.visible,
        pose: g.getClientRects().length > 0, tip: g.title, height: h.getClientRects().length > 0, dot: !!dot && dot.getClientRects().length > 0,
        axes: v.ringAxisLines().filter((a) => a.type === 'Line').map((a) => a.visible), dots: v.ringAxisLines().filter((a) => a.type === 'Points').length}; })()`);
    ok('flight: an own shot with its tracer gets the arc from the real origin, and the camera stands there', flight.path && flight.arc && flight.eye < 1e-6, JSON.stringify(flight).slice(0, 200));
    ok('flight: 0.8 m between the recorded point and the server\'s - the pose mark on the hit-line panel, with its words and its "?"',
       Math.abs(flight.gap - .8) < 1e-6 && flight.pose && flight.tip.indexOf('Pose diverged: 0.80 m') === 0 && flight.dot && !flight.height, '("' + flight.tip.split('\n')[0] + '")');
    ok('ring axes: three with their start dots, hidden until the lab\'s switch', flight.axes.length === 3 && flight.axes.every((x) => !x) && flight.dots === 3);
    await ev("(() => { document.getElementById('ring-axes').click(); return true; })()"); await ev('__bt.settle()'); await new Promise((r) => setTimeout(r, 400));
    const axesOn = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; let st = null; try { st = JSON.parse(localStorage.getItem('bullba-settings')).values['ring-axes']; } catch (x) {} return {vis: v.ringAxisLines().map((a) => a.visible), stored: st}; })()`);
    ok('ring axes: the switch shows all three and their dots, and is stored', axesOn.vis.length === 6 && axesOn.vis.every((x) => x) && axesOn.stored === true, JSON.stringify(axesOn));
    await ev("(() => { document.getElementById('ring-axes').click(); return true; })()"); await ev('__bt.settle()');

    // The full tracer: a dashed arc, a dot at its start, an arrowhead - no stub. View from (the lab): your gun at the press
    // puts the camera at the solid ring's apex, stored; back to the shot, at the carried origin.
    const tracerLook = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], k = v.root.children;
      return {dashed: k.some((o) => o.userData.shotArc && o.type === 'Line' && o.material.type === 'LineDashedMaterial'), dot: k.some((o) => o.userData.shotArc && o.type === 'Points'),
        head: k.some((o) => o.userData.shotArc && o.type === 'ArrowHelper'), stub: k.some((o) => o.type === 'Group' && o.children.some((a) => a.type === 'ArrowHelper'))}; })()`);
    ok('full tracer: dashed along the arc, a dot at its start, an arrowhead, no stub', tracerLook.dashed && tracerLook.dot && tracerLook.head && !tracerLook.stub, JSON.stringify(tracerLook));
    const pick = (value) => ev(`(() => { const s = document.getElementById('view-from'); s.value = '${value}'; s.dispatchEvent(new Event('change')); return true; })()`);
    const where = () => ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; let st = null; try { st = JSON.parse(localStorage.getItem('bullba-settings')).values['view-from']; } catch (x) {}
      return {gun: v.viewPoints && v.viewPoints.gun ? v.camera.position.distanceTo(v.viewPoints.gun) : null, shot: v.shotPath ? v.camera.position.distanceTo(v.shotPath.origin) : null, stored: st}; })()`);
    const pickDefault = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; return document.getElementById('view-from').value === 'fired' && v.viewFrom === 'fired' && v.camera.position.distanceTo(v.shotPath.origin) < 1e-3; })()`);
    ok('view from: the shot by default, the camera at the carried origin', pickDefault);
    await pick('gun'); await ev('__bt.settle()'); await new Promise((r) => setTimeout(r, 400));
    const fromGun = await where();
    await pick('fired'); await ev('__bt.settle()'); await new Promise((r) => setTimeout(r, 400));
    const fromShot = await where();
    ok('view from: your gun at the press - the camera at the solid ring\'s apex, stored; back to the shot', fromGun.gun !== null && fromGun.gun < 1e-3 && fromGun.stored === 'gun'
       && fromShot.shot < 1e-3 && fromShot.stored === 'fired', JSON.stringify([fromGun, fromShot]));

    // ---- a drag over a page with text selected (user, 24.09) --------------------------------------------------
    // With a selection on the page (a left-button sweep over the panels selects their text and the scene with it), a
    // press on the scene used to start the browser's own drag of that selection: the page got pointercancel after a
    // few pixels and the vehicle turned a few degrees and stopped. Real mouse input (CDP), not synthetic events.
    await step("battle('pm')"); await step('hit(0)');
    const box = await ev(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    const yaw = () => ev('window.__bullbaViewers[window.__bullbaViewers.length - 1].targetYaw');
    const mouse = (type, x, y, extra) => page.send('Input.dispatchMouseEvent', Object.assign({type: type, x: x, y: y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1}, extra || {}));
    for (const selected of [false, true]) {
      if (selected) await ev('(() => { getSelection().selectAllChildren(document.body); return getSelection().toString().length; })()');
      await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1]; window.__bt.cancels = 0; v.container.addEventListener('pointercancel', () => { window.__bt.cancels++; }); return true; })()`);
      const y0 = await yaw();
      await mouse('mousePressed', box.x, box.y);
      for (let i = 1; i <= 20; i++) await mouse('mouseMoved', box.x + i * 12, box.y, {button: 'left', buttons: 1});
      await mouse('mouseReleased', box.x + 240, box.y);
      await ev('__bt.settle()');
      const turned = Math.abs(await yaw() - y0), cancels = await ev('window.__bt.cancels');
      ok('a left drag over the scene turns the vehicle all the way' + (selected ? ' with the page’s text selected' : ''), cancels === 0 && turned > .8,   // 240 px at 0.004 rad/px = 0.96 rad; the cut-short drag turned 0.1
         '(turned ' + turned.toFixed(3) + ' rad, pointercancel ' + cancels + ')');
    }
    await ev('getSelection().removeAllRanges(), true');

    // ---- a click on a circle tile is the tile's, not the scene's (user, 24.09) ------------------------------------
    // The tiles band lies over the scene: a left click on the Circle tile showed the help cursor and then fired the
    // emulated gun (or pinned a point) under it. It must show the tile's words and leave the scene alone.
    await ev('__bt.act.fun(true)'); await ev('__bt.settle()');
    let tileAt = null;
    for (let i = 0; i < 6 && !tileAt; i++) {
      await step('hit(' + i + ')');
      tileAt = await ev(`(() => { const t = document.getElementById('shot-circle-tile'); if (!t || !t.getClientRects().length) return null; const r = t.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    }
    ok('a hit with a Circle tile is on screen', !!tileAt);
    if (tileAt) {
      const before = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], t = document.getElementById('shot-circle-tile'); return {pinned: !!v.pinned, tip: t.getAttribute('data-tip') || t.getAttribute('title') || ''}; })()`);
      await mouse('mousePressed', tileAt.x, tileAt.y); await mouse('mouseReleased', tileAt.x, tileAt.y);
      await ev('__bt.settle()');
      const after = await ev(`(() => { const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], t = document.getElementById('shot-circle-tile'), b = document.getElementById('page-tip'); return {pinned: !!v.pinned, tip: t.getAttribute('data-tip') || t.getAttribute('title') || '', bubble: !!b && !b.hidden && b.textContent.length > 0, text: b ? b.textContent.slice(0, 40) : ''}; })()`);
      ok('a click on the Circle tile shows its words', after.bubble, '(' + after.text + ')');
      ok('... and fires no shot and pins no point under it', !after.pinned && !before.pinned && after.tip === before.tip && after.tip.indexOf('Last shot') !== 0,
         '(pinned ' + after.pinned + ', tile "' + after.tip.split('\n')[0] + '")');
      const dot = await ev(`(() => { const d = document.querySelector('.circle-help'); return !!d && d.getClientRects().length > 0; })()`);
      ok('the circle tiles have their own "?"', dot);
      // 25.09 (user): that "?" stands at the right end of the heading row, clear of the shell fields, and the Circle
      // tile's bubble draws its heading in the tile's own colour.
      const place = await ev(`(() => { const d = document.querySelector('.circle-help').getBoundingClientRect(), h = document.querySelector('.scene-heading').getBoundingClientRect();
        const clear = [].slice.call(document.querySelectorAll('.shell-fields *')).every(function (e) { const r = e.getBoundingClientRect(); return !r.width || r.right <= d.left || r.left >= d.right || r.bottom <= d.top || r.top >= d.bottom; });
        return {inRow: d.top >= h.top && d.bottom <= h.bottom, atEnd: h.right - d.right < 20, clear: clear, shellDot: !!document.querySelector('#shell-types .help-dot')}; })()`);
      ok('... at the right end of the heading row, over none of the shell fields; the shell row has no "?" of its own', place.inRow && place.atEnd && place.clear && !place.shellDot, JSON.stringify(place));
      const tint = await ev(`(() => { const t = document.getElementById('shot-circle-tile'), r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: r.left + 5, clientY: r.top + 5}));
        const h = document.querySelector('#page-tip .tip-h'); const out = {attr: t.getAttribute('data-tip-tint'), cls: h ? h.className : ''}; document.getElementById('page-tip').hidden = true; return out; })()`);
      ok('... and the Circle tile\'s heading is drawn in its ring colour', /tip-(magenta|cyan)/.test(tint.cls) && tint.cls.indexOf('tip-' + tint.attr) >= 0, JSON.stringify(tint));
      await ev("document.getElementById('page-tip') && (document.getElementById('page-tip').hidden = true), true");
    }
    await ev('__bt.act.fun(false)'); await ev('__bt.settle()');

    // ---- manual motion (27.09): the drive tile's popover on the rendered page ---------------------------------------
    // It opens to the LEFT of the tile, inside the window and clear of the tile; at a narrow width it goes above the tile.
    // Its sliders drive the live circle as if the shooter moved steadily; a scene path (another battle's hit, its shooter
    // another vehicle) keeps them for the new shooter (inherit); W ends it and drives from there.
    await step("side('battles')"); await step("battle('pm')"); await step('hit(0)');
    const MANUAL = `(() => { const d = document.getElementById('aim-drive'), s = document.getElementById('aim-drive-summary'), p = document.getElementById('aim-manual-body');
      const v = ${LV}, b = s.getBoundingClientRect(), q = p.getBoundingClientRect(), h = document.getElementById('aim-manual-hull-value');
      return {open: d.open, shown: s.getClientRects().length > 0, manual: d.getAttribute('data-manual'), tile: {l: b.left, r: b.right, t: b.top, b: b.bottom},
        pop: {l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width}, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        live: v.liveRadius100, speed: document.getElementById('aim-speed').textContent, hull: h ? h.textContent : '', place: p.getAttribute('data-place')}; })()`;
    const clearOf = (m) => m.pop.w > 0 && m.pop.l >= 0 && m.pop.r <= m.vw && m.pop.t >= 0 && m.pop.b <= m.vh && (m.pop.r <= m.tile.l || m.pop.b <= m.tile.t);
    await ev("document.getElementById('aim-drive-summary').click()"); await ev('__bt.settle()');
    const M0 = await ev(MANUAL);
    ok('manual: the drive tile opens its popover to the left of the tile, inside the window and clear of the tile',
       M0.open && M0.shown && clearOf(M0) && M0.pop.r <= M0.tile.l && M0.place === null && M0.manual === 'false' && M0.live > 0, JSON.stringify(M0));
    await ev(`(() => { const s = document.getElementById('aim-manual-speed'), h = document.getElementById('aim-manual-hull');
      s.value = '100'; s.dispatchEvent(new Event('input')); h.value = '50'; h.dispatchEvent(new Event('input')); return true; })()`);
    await ev('__bt.settle()');
    const M1 = await ev(MANUAL);
    ok('manual: the sliders turn it on - the gold frame, the tile at the top speed, the hull\'s °/s beside its slider, the live circle as if driving',
       M1.manual === 'true' && /^[1-9]\d* km\/h$/.test(M1.speed) && /^[\d.]+ °\/s$/.test(M1.hull) && M1.hull !== '0 °/s' && M1.live > M0.live * 1.5, JSON.stringify([M0.live, M1]));
    await step("battle('pm2')"); await step('hit(0)');
    const M2 = await ev(MANUAL);
    ok('manual: another battle\'s hit keeps it - its shooter drives by hand at his own top speed, the gold frame on', M2.manual === 'true' && /^[1-9]\d* km\/h$/.test(M2.speed) && M2.live > 0, JSON.stringify(M2));
    await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyW', key: 'w', bubbles: true}));
      document.dispatchEvent(new KeyboardEvent('keyup', {code: 'KeyW', key: 'w', bubbles: true})); return true; })()`);
    const M3 = await ev(`(async () => { const read = ${MANUAL.replace(/^\(/, '(function () { return (').replace(/\)\(\)$/, ')(); })')};
      for (let i = 0; i < 150; i++) { const m = read(); if (m.speed === '0 km/h' && m.live < ${M2.live} / 1.5) return m; await new Promise((r) => setTimeout(r, 100)); } return read(); })()`);
    ok('manual: W ends it - no gold frame, the vehicle brakes to a stop and the circle settles from the manual one', M3.manual === 'false' && M3.speed === '0 km/h' && M3.live < M2.live / 1.5,
       JSON.stringify([M2.live, M3]));
    await step("battle('pm')"); await step('hit(0)');
    // A narrow window: no room on the left any more - above the tile, still inside the window and clear of it.
    await page.send('Emulation.setDeviceMetricsOverride', {width: 640, height: 900, deviceScaleFactor: 1, mobile: false});
    await ev('__bt.settle()');
    if (!(await ev("document.getElementById('aim-drive').open"))) { await ev("document.getElementById('aim-drive-summary').click()"); await ev('__bt.settle()'); }
    const M4 = await ev(MANUAL);
    ok('manual: at 640 px the popover moves above the tile, inside the window and clear of the tile', M4.open && M4.shown && clearOf(M4) && (M4.place === 'above' || M4.pop.r <= M4.tile.l), JSON.stringify(M4));
    await ev("document.getElementById('aim-drive-summary').click()");
    await page.send('Emulation.clearDeviceMetricsOverride'); await ev('__bt.settle()');
    ok('manual: no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    page.errors.length = 0;

    // ---- THE ONE MODE BUTTON (mode-button-both, 27.09) on the scene path --------------------------------------------
    // pm7: a Taschenratte's hit, no characteristics file for its type - the panel stands for the button (and its "?")
    // alone. Plain view takes the second gun up at once (its shell and penetration), ⌖ keeps what the user took up.
    const MODE = `(() => { const $ = (id) => document.getElementById(id), b = $('ttx-mode'), p = $('ttx-panel'), cs = getComputedStyle(b);
      const laid = (el) => !!el && el.getClientRects().length > 0;
      const dot = [].slice.call(p.querySelectorAll('[data-help-for]')).filter((d) => d.getAttribute('data-help-for').split(' ')[0] === 'ttx-mode')[0];
      return {shown: laid(b), inPanel: p.contains(b), glyph: b.textContent, pressed: b.getAttribute('aria-pressed'), border: cs.borderTopColor,
        only: p.getAttribute('data-mode-only'), figures: laid(p.querySelector('.ttx-head')), help: laid(dot), shell: $('shell-choice').value,
        pen: $('penetration').value, strip: !!document.querySelector('#fun-strip #ttx-mode, #aim-gun #ttx-mode'), buttons: document.querySelectorAll('#ttx-mode').length}; })()`;
    await step('fun(false)'); await step("side('battles')"); await step("battle('pm7')"); await step('hit(0)');
    const B0 = await ev(MODE);
    ok('mode button: a Taschenratte in plain view - ONE button, on the characteristics panel (standing alone: no file), its "?" beside it, in its own accent',
       B0.shown && B0.inPanel && B0.buttons === 1 && !B0.strip && B0.glyph === '✦' && B0.pressed === 'false' && B0.only === '1' && !B0.figures && B0.help
       && B0.border === 'rgb(185, 166, 255)' && B0.shell === 'saved:0', JSON.stringify(B0));
    const B1 = await step('mode()') && await ev(MODE);
    ok('mode button: plain view - a press takes the mortar up at once: lit, its shell and its penetration (60) on the page', B1.pressed === 'true' && B1.shell === 'saved:2' && B1.pen === '60', JSON.stringify(B1));
    const B2 = await step('fun(true)') && await ev(MODE);
    ok('mode button: ⌖ on - the same one button, the mortar still in hand (inherited)', B2.shown && B2.pressed === 'true' && B2.shell === 'saved:2', JSON.stringify(B2));
    const B3 = await step('mode()') && await ev(MODE);
    ok('mode button: under ⌖ a press takes the main gun back', B3.pressed === 'false' && B3.shell === 'saved:0' && B3.pen === '250', JSON.stringify(B3));
    await step('fun(false)'); await step("battle('pm')"); await step('hit(0)');
    const B4 = await ev(MODE);
    ok('mode button: a plain shooter - no mode button', !B4.shown, JSON.stringify(B4));
    ok('mode button: no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    page.errors.length = 0;

    // ---- the leak counter ----------------------------------------------------------------------------------
    const CYCLE = ["side('battles')", "battle('pm')", 'hit(0)', 'swap()', 'swap()', 'roster(32)', "battle('pm2')", 'hit(0)',
                   'modelTile()', "list('pm_quebec')", "side('battles')", "battle('pm')", 'hit(1)', 'event(0)', 'event(1)', "battle('pm3')", 'hit(0)', 'roster(33)'];
    const home = async () => { await step("side('battles')"); await step("battle('pm')"); await step('hit(0)'); };
    // Counted at a quiet moment: the page settled, and no data read in flight or started between the GC and the count -
    // the 5-second index poll's two reads (two <script>s, four listeners) caught by the GC were counted as growth.
    const measure = async () => {
      await home();
      for (let tries = 0; tries < 50; tries++) {
        await ev('__bt.settle(3000)');
        const reads = await ev('__bt.reads()');
        if (reads !== null) {
          await page.send('HeapProfiler.collectGarbage'); await page.send('HeapProfiler.collectGarbage');
          const dom = await page.send('Memory.getDOMCounters');
          const c = await ev('__bt.counters()');
          if (await ev('__bt.reads()') === reads) return {nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents, elements: c.elements, gl: c.gl, three: c.three, viewers: c.viewers};
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('leak counter: the page never stood still between its data reads');
    };
    for (let i = 0; i < CYCLE.length; i++) await step(CYCLE[i], 3000);   // one round of warm-up
    const before = await measure();
    const t0 = Date.now();
    for (let i = 0; i < SWITCHES; i++) await step(CYCLE[i % CYCLE.length], 3000);
    const switchMs = Date.now() - t0;
    const after = await measure();
    const growth = function (a, b) { const out = {}; Object.keys(b || {}).forEach(function (k) { if (typeof b[k] === 'number') out[k] = b[k] - ((a || {})[k] || 0); }); return out; };
    const g = {nodes: after.nodes - before.nodes, listeners: after.listeners - before.listeners, documents: after.documents - before.documents,
               elements: after.elements - before.elements, gl: growth(before.gl, after.gl), three: growth(before.three, after.three), viewers: after.viewers - before.viewers};
    const line = 'before ' + JSON.stringify(before) + ' after ' + JSON.stringify(after);
    ok('leaks: ' + SWITCHES + ' scene switches leave no DOM nodes (live or detached) behind', g.nodes <= 0 && g.elements <= 0, '(nodes ' + g.nodes + ', elements ' + g.elements + ')');
    ok('leaks: ... no event listeners', g.listeners <= 0, '(listeners ' + g.listeners + ')');
    ok('leaks: ... no WebGL objects', Object.keys(g.gl).every(function (k) { return g.gl[k] <= 0; }), '(' + JSON.stringify(g.gl) + ')');
    ok('leaks: ... no three.js geometries, textures or programs', !after.three || Object.keys(g.three).every(function (k) { return g.three[k] <= 0; }), '(' + JSON.stringify(g.three) + ')');
    ok('leaks: ... one viewer for the page, never a second', after.viewers === 1 && g.viewers === 0 && g.documents <= 0, '(viewers ' + after.viewers + ')');
    ok('leaks: no uncaught exception during the switches', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    console.log('real page: leak counter ' + SWITCHES + ' switches in ' + (switchMs / 1000).toFixed(1) + ' s; growth ' + JSON.stringify(g));
    if (VERBOSE) console.log('  ' + line);
  } catch (e) {
    ok('the run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
    if (page && page.errors.length) console.log('  page errors: ' + page.errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if (!KEEP) fs.rmSync(folder, {recursive: true, force: true}); else console.log('kept: ' + folder);
  }
  console.log('real page (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
