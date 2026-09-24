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
    swap: () => $('swap-roles').click(),
    shooterTile: () => $('shooter-tile').click(),
    modelTile: () => $('model-tile').click(),
    side: (mode) => must(document.querySelector('#sidebar-mode [data-mode="' + mode + '"]'), 'side mode ' + mode).click(),
    roster: (id) => {
      const d = $('vehicle-focus'); if (!d.open) d.querySelector('summary').click();
      must($('focus-list').querySelector('[data-id="' + id + '"]'), 'roster row ' + id).click();
    },
    list: (id) => must(document.querySelector('#vehicles [data-vehicle="' + id + '"]'), 'vehicle row ' + id).click(),
    battle: (id) => {
      if ($('battle-list').hidden) $('battle-pick').click();
      must(document.querySelector('#battle-list [data-id="' + id + '"]'), 'battle ' + id).click();
    },
    fun: (on) => { if ($('fun-mode-toggle').getAttribute('aria-pressed') !== String(on)) $('fun-mode-toggle').click(); }
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
      message: words(shown($('scene-message')) ? $('scene-message').textContent : '')};
  }
  function counters() {
    const v = window.__bullbaViewers[window.__bullbaViewers.length - 1], info = v && v.renderer && v.renderer.info;
    return {viewers: window.__bullbaViewers.length, gl: Object.assign({}, window.__bullbaGl),
      three: info ? {geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs ? info.programs.length : null} : null,
      elements: document.getElementsByTagName('*').length};
  }
  window.__bt = {act, settle, sig, counters};
  return true;
})()`;

const HP = {ROSTER: 'this battle’s roster', FILE: 'the vehicle’s characteristics, stock', OWN: 'the vehicle’s own export'};

async function main() {
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  const folder = stage();
  let page;
  try {
    page = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    const ev = (js) => page.evaluate(js);
    await ev(DRIVER);
    // Ready: the battle list read from the synthetic index, and the viewer made.
    const ready = await ev(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelector('#hits [data-hit]') && window.__bullbaViewers.length) break; await new Promise((r) => setTimeout(r, 100)); } await __bt.settle(); return {hits: document.querySelectorAll('#hits [data-hit]').length, viewers: window.__bullbaViewers.length, webgl: !!(window.__bullbaViewers[0] && window.__bullbaViewers[0].renderer)}; })()`);
    ok('the page starts on the synthetic data: hits listed, the viewer made with WebGL', ready.hits > 0 && ready.webgl, JSON.stringify(ready));
    if (!ready.webgl) throw new Error('no WebGL viewer - the matrix would mean nothing');
    const step = async (js, max) => { await ev('__bt.act.' + js); await ev('__bt.settle(' + (max || 6000) + ')'); return ev('__bt.sig()'); };

    function expectScene(label, fun, want, s) {
      const tag = 'matrix, ⌖ ' + (fun ? 'on' : 'off') + ', ' + label + ': ';
      ok(tag + 'the tiles show the scene', s.model === want.model && s.shooter === want.shooter, '(model ' + s.model + ', shooter ' + s.shooter + ')');
      ok(tag + 'the ⌖ switch stands with a model, lit with the mode; the strip and ↺ only under ⌖ with a model',
         s.funToggle === s.model && s.funPressed === String(fun) && s.strip === (fun && s.model) && s.reset === (fun && s.model),
         '(switch ' + s.funToggle + ' pressed ' + s.funPressed + ', strip ' + s.strip + ', ↺ ' + s.reset + ')');
      const bar = fun && s.model && !!want.hp;
      ok(tag + (bar ? 'the health bar stands with ' + want.hp + ' inside it, from ' + want.source : 'no health bar'),
         s.hp === bar && (!bar || (s.hpText === want.hp && s.hpTip.indexOf('• Left: ' + want.hp + ' HP • Source: ' + want.source) >= 0)),
         '(shown ' + s.hp + ', "' + s.hpText + '", tip "' + s.hpTip.slice(0, 160) + '")');
      ok(tag + 'the emulation’s controls go with the model', s.model || (!s.drive && !s.config && !s.gun && !s.funGun),
         '(drive ' + s.drive + ', config ' + s.config + ', gun ' + s.gun + ', strip gun ' + s.funGun + ')');
      ok(tag + 'every help dot is laid out iff a control it lists is (the ⌖ one with the model)',
         s.wrong.length === 0 && s.funDot === s.model, '(' + s.dotsShown + '/' + s.dots + ' shown; wrong: ' + s.wrong.join(', ') + ')');
      ok(tag + 'no uncaught exception in the page', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
      page.errors.length = 0;
    }

    // Warm up as the stub matrix does: every shooter's characteristics file read once.
    await step("side('battles')"); await step("battle('pm')"); await step('hit(1)'); await step('swap()'); await step('swap()');

    async function loop(fun) {
      await ev('__bt.act.fun(' + fun + ')'); await ev('__bt.settle()');
      expectScene('a hit clicked', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step('hit(0)'));
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
      const back = await step("side('battles')");
      expectScene('back to Hits with the browsed vehicle kept', fun, {model: true, shooter: true, hp: '2 200 / 2 200', source: HP.OWN}, back);
      ok('matrix, ⌖ ' + (fun ? 'on' : 'off') + ': (no ⇅ for browsed vehicles in the Hits panel)', !(await ev("(() => { const e = document.getElementById('swap-roles'); return e.getClientRects().length > 0; })()")));
      expectScene('another battle', fun, {model: true, shooter: true, hp: '2 750 / 2 750', source: HP.ROSTER}, await step("battle('pm2')"));
      await step('modelTile()'); await step("side('battles')");
      expectScene('a seat with no hits and no model - the scene emptied', fun, {model: false, shooter: false, hp: null}, await step('roster(33)'));
      await step("battle('pm')");
    }
    await loop(false);
    await loop(true);
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
      await ev("document.getElementById('page-tip') && (document.getElementById('page-tip').hidden = true), true");
    }
    await ev('__bt.act.fun(false)'); await ev('__bt.settle()');

    // ---- the leak counter ----------------------------------------------------------------------------------
    const CYCLE = ["side('battles')", "battle('pm')", 'hit(0)', 'swap()', 'swap()', 'roster(32)', "battle('pm2')", 'hit(0)',
                   'modelTile()', "list('pm_quebec')", "side('battles')", "battle('pm')", 'hit(1)', "battle('pm3')", 'hit(0)', 'roster(33)'];
    const home = async () => { await step("side('battles')"); await step("battle('pm')"); await step('hit(0)'); };
    const measure = async () => {
      await home();
      await page.send('HeapProfiler.collectGarbage'); await page.send('HeapProfiler.collectGarbage');
      await ev('__bt.settle(3000)');
      const dom = await page.send('Memory.getDOMCounters');
      const c = await ev('__bt.counters()');
      return {nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents, elements: c.elements, gl: c.gl, three: c.three, viewers: c.viewers};
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
