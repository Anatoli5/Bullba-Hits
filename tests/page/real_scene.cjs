/* THE USER'S OWN CASE ON HIS OWN BATTLE (rule B17; 04.10, after 0.9.6): "after the swap the vehicle that was the shooter
 * gets some nonsense; the swap button jumps, because the shell icons beside the Shooter tile go; the position changes as
 * it likes". The REAL page in a local headless browser on a copy of his battle of 04.10 - an M6 against two VK 30.01 P with
 * an ally VK 36.01 H - kept in tests/fixtures-local/scene-state-2026-10-04 (local, never committed; its make.py copies
 * it from the installed mod's data). No fixture on this machine: SKIP (exit 77).
 *
 * Three hits, each walked  target -> ⇅ -> shooter -> ⇅ -> target -> ⇅ -> shooter, the user turning both vehicles:
 *   - an incoming hit with the shooter's motion on record;
 *   - the player's own shot (its tracer gives the shooter at the shot);
 *   - an ally's hit the record has no shooter's motion for.
 * Asked after every step: the camera stays; the shooter stands as the record has him at the shot, else as the vehicle on
 * screen stood; what the user set on either vehicle is there when he comes back to it; the vehicle that was the shooter
 * has its own angles and limits on the pose tile; the shells beside the Shooter tile are the shooter's in both states; ⇅
 * and the Shooter tile stand in one place. On 0.9.6 (BULLBA_WEB=<its web/>) 19 of these are red.
 *
 * The second case (04.10, on 0.9.7): the first view of his shots fired point-blank - the comment of closeCase below; its
 * fixture is tests/fixtures-local/close-range-2026-10-04.
 *
 * The third case (09.10): a recorded ricochet is drawn as a ricochet - the comment of ricochetCase below; the same fixture.
 *
 *   node tests/page/real_scene.cjs [--verbose] [--only=ricochetCase]      exit 0 pass, 1 fail, 77 skip (no fixture at all, or no browser)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'tests', 'fixtures-local', 'scene-state-2026-10-04', 'data');
const VERBOSE = process.argv.includes('--verbose');

let checks = 0, failures = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else if (VERBOSE) console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}

// Runs in the page before its own scripts: the viewer the page makes is kept for the checks.
const INIT = `(() => { const viewers = []; let wrapped; Object.defineProperty(window, '__viewers', {value: viewers});
  Object.defineProperty(window, 'ArmorViewer', {configurable: true, enumerable: true, get() { return wrapped; },
    set(V) { wrapped = new Proxy(V, {construct(t, args, nt) { const v = Reflect.construct(t, args, nt); viewers.push(v); return v; }}); }}); })();`;
const LV = 'window.__viewers[window.__viewers.length - 1]';
// Settled: two frames drawn and no change to the page's structure, visibility or words for 250 ms.
const DRIVER = `(() => { let last = performance.now();
  new MutationObserver(() => { last = performance.now(); }).observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-pressed', 'title']});
  const frame = () => new Promise((r) => requestAnimationFrame(() => r())), wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__settle = async (max) => { const t0 = performance.now(); await frame(); await frame();
    while (performance.now() - t0 < (max || 15000)) { if (performance.now() - last > 250) return true; await wait(50); } return false; };
  return true; })()`;
const VIEW = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, $ = (id) => document.getElementById(id), D = 180 / Math.PI;
  const at = (id) => { const e = $(id); if (!e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.width * 10) / 10]; };
  const start = h && !h.synthetic ? ArmorShotContext.swapStart(h, null) : null;
  return {swapped: !!(h && h.synthetic), model: h && h.target ? h.target.type : null, shooter: h && h.attacker ? h.attacker.type : null,
    yaw: v.yaw, pitch: v.pitch, distance: v.distance, zoom: v.camera.zoom, turret: v.turretAngle, gun: v.gunAngle,
    absolute: h ? [v.poseNow().yaw * D, v.poseNow().pitch * D] : null, motion: start ? [start.pose.yaw * D, start.pose.pitch * D] : null,
    tile: $('pose-turret').textContent + ' | ' + $('pose-gun').textContent, note: $('pose-note').hidden ? '' : $('pose-note').textContent,
    swap: at('swap-roles'), shooterTile: at('shooter-tile'), gunPanel: at('aim-gun'), shells: $('aim-gun-shells').children.length,
    calibre: $('caliber').value, choice: $('shell-choice').value}; })()`;
const TURN = (yaw, pitch, distance, zoom, turret, gun) => `(() => { const v = ${LV}; v.setOrbit(${yaw}, ${pitch}); v.setDistance(${distance}); v.setZoom(${zoom});
  v.setTurret(${turret}); v.setGun(${gun}); v.render(); })()`;
const HIT = (n) => `document.querySelectorAll('#hits [data-hit]')[${n}].click()`;
const SWAP = "document.getElementById('swap-roles').click()";
const CAMERA = ['yaw', 'pitch', 'distance', 'zoom'];
const near = (a, b, keys) => keys.every((k) => Math.abs(a[k] - b[k]) < 1e-6);
const pose = (s, p) => !!p && Math.abs(s.absolute[0] - p[0]) < 1e-4 && Math.abs(s.absolute[1] - p[1]) < 1e-4;
const brief = (list) => JSON.stringify(list.map((s) => ({swapped: s.swapped, yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3), distance: +s.distance.toFixed(2), zoom: +s.zoom.toFixed(2),
  pose: s.absolute.map((x) => +x.toFixed(2)), motion: s.motion ? s.motion.map((x) => +x.toFixed(2)) : null, swap: s.swap, shells: s.shells, calibre: s.calibre})));

// The page as the user has it, on a copy of one of his battles: web/ as Viewer.html beside that battle's data folder.
function stage(data) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-scene-'));
  fs.cpSync(WEB, path.join(folder, 'web'), {recursive: true});
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(folder, 'Viewer.html'));
  fs.cpSync(data, path.join(folder, 'data'), {recursive: true});
  return folder;
}

async function swapCase(browser) {
  const folder = stage(DATA);
  try {
    const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 300 && !(document.querySelector('#hits [data-hit]') && window.__viewers.length && ${LV}.loadedData); i++) await new Promise((r) => setTimeout(r, 100)); await __settle(); })()`);
    const go = async (js) => { await p.evaluate(js); await p.evaluate('__settle()'); return p.evaluate(VIEW); };
    const row = [], calibreOf = {};
    // One hit walked: target -> ⇅ -> shooter -> ⇅ -> target -> ⇅ -> shooter, both turned by hand on the way.
    async function walk(label, pick, from) {
      const tag = 'the user\'s battle, ' + label + ': ';
      const T0 = await go(pick);
      ok(tag + '(the hit is on screen with its ⇅)', !T0.swapped && !!T0.swap && (from !== 'motion' || !!T0.motion), brief([T0]));
      calibreOf[T0.shooter] = T0.calibre;
      const T1 = await go(TURN(.9, .3, 18, 1.5, 40, 3));
      const S1 = await go(SWAP);
      ok(tag + '⇅ to the shooter - the camera on screen stays', S1.swapped && S1.model === T0.shooter && near(S1, T1, CAMERA), brief([T1, S1]));
      if (from === 'motion') ok(tag + '... he stands as the record has him at the shot (his motion: turret ' + T0.motion[0].toFixed(1) + '°, gun ' + T0.motion[1].toFixed(1) + '°)', pose(S1, T0.motion), brief([T0, S1]));
      else if (from === 'tracer') ok(tag + '... he stands as the own shot\'s tracer has him - not as the target on screen stood', !pose(S1, T1.absolute) && Math.abs(S1.turret) > .5, brief([T1, S1]));
      else ok(tag + '... the record has no pose of his: he stands as the vehicle on screen stood (turret ' + T1.absolute[0].toFixed(1) + '°)', pose(S1, T1.absolute), brief([T1, S1]));
      ok(tag + '... a vehicle like any other on the pose tile: its angles from the hull with the gun\'s own range, no "from the recorded pose", no note of a recorded shot',
         S1.tile.indexOf('from the recorded pose') < 0 && /Gun [+-]?\d+° · [+-]?\d+° … [+-]?\d+°/.test(S1.tile) && S1.note === '', S1.tile + ' / ' + S1.note);
      ok(tag + '... the shells beside the Shooter tile are there, and they are the new shooter\'s own', !!S1.gunPanel && S1.shells > 0 && S1.choice.indexOf('saved:') === 0, JSON.stringify([S1.gunPanel, S1.shells, S1.choice, S1.calibre]));
      const T2 = await go(SWAP);
      ok(tag + '⇅ back - the camera stays, the target stands as the user left it (turret turned 40°)', !T2.swapped && near(T2, S1, CAMERA) && pose(T2, T1.absolute), brief([T1, T2]));
      const S2 = await go(SWAP);
      ok(tag + '⇅ again - the shooter as he stood the first time, the camera where it was', S2.swapped && near(S2, T2, CAMERA) && pose(S2, S1.absolute), brief([S1, S2]));
      const S3 = await go(TURN(.5, .2, 16, 1.4, 25, 2));
      const T3 = await go(SWAP);
      const S4 = await go(SWAP);
      ok(tag + 'the shooter turned by hand (turret 25°), ⇅ away and back - he stands as the user left him, and so does the target', pose(S4, S3.absolute) && pose(T3, T1.absolute) && near(S4, S3, CAMERA) && near(T3, S3, CAMERA), brief([S3, T3, S4]));
      calibreOf[S1.shooter + ' after ⇅'] = S1.calibre;
      [T0, T1, S1, T2, S2, S3, T3, S4].forEach((s) => row.push(s));
      await go(SWAP);
    }
    await walk('an incoming hit with the shooter\'s motion', HIT(3), 'motion');
    await walk('the player\'s own shot', HIT(0), 'tracer');
    // The shell on screen is the shooter's own in both states. The player's vehicle is the one of its type in the battle
    // (the two enemies are of one type with different guns): the calibre it has as the recorded shooter of its own shot
    // is the one it has after ⇅ made it the shooter of the incoming hit - not the enemy's that stood there before; and
    // the enemy ⇅ made the shooter of the own shot does not keep the player's.
    const types = Object.keys(calibreOf).filter((k) => k.indexOf(' after ⇅') < 0), own = types.filter((k) => calibreOf[k + ' after ⇅'] !== undefined && k === row[8].shooter)[0];
    const enemy = types.filter((k) => k !== own)[0];
    ok('the user\'s battle: the shell beside the Shooter tile is of the shooter\'s own gun in both states - the player\'s vehicle has its own calibre after ⇅ made it the shooter, and the enemy does not keep the player\'s',
       !!own && !!enemy && calibreOf[own] !== calibreOf[enemy] && calibreOf[own + ' after ⇅'] === calibreOf[own] && calibreOf[enemy + ' after ⇅'] !== calibreOf[own], JSON.stringify(calibreOf));
    // The ally: his hits are the list of his seat in the battle's roster.
    await go(`(() => { const d = document.getElementById('vehicle-focus'); if (!d.open) d.querySelector('summary').click();
      [].slice.call(document.querySelectorAll('#focus-list [data-id]')).filter((x) => /VK 36\\.01/.test(x.textContent))[0].click(); })()`);
    await walk('an ally\'s hit without the shooter\'s motion', HIT(0), 'screen');
    ok('the user\'s battle: ⇅ stands in one place through all ' + row.length + ' steps of the three hits - the same button under the pointer - and so does the Shooter tile',
       row.every((s) => s.swap && s.swap[0] === row[0].swap[0] && s.swap[1] === row[0].swap[1] && s.shooterTile && s.shooterTile[0] === row[0].shooterTile[0]),
       JSON.stringify(row.map((s) => [s.swap && s.swap[0], s.shooterTile && s.shooterTile[0]])));
    ok('the user\'s battle: no uncaught exception in the page', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
}

// ---- THE FIRST VIEW OF A SHOT FIRED POINT-BLANK (04.10, on 0.9.7) --------------------------------------------------------------
// The user: "in my last battle I shot from the TVP at a Blyskawica from very close. Those shots are centred strangely at
// first: the shot is outside the view, and the point the camera turns round seems to lie on the floor under the tank - not
// the tank's centre and not the contact point". His battle on Cliff: three of his shots there were fired from 4.8, 5.0 and
// 6.1 m. What put the floor mid-screen: Fit centres the middle of the armour's projected box - right while the armour fits
// the frame; since Fit stops at zoom x1 (25.09) and never backs the camera off (23.09) it does not fit in a clinch, the
// near edge of the box is projected from half a metre, and its "middle" lay 2.6 screen half-heights below the vehicle.
// Asked of EVERY hit of the battle at its first view: the orbit centre is the chosen one and stands inside the frame, the
// contact point is inside the frame, the zoom is not below x1; of the three clinch shots also with the orbit round the hit
// point, after Fit, and of a browsed vehicle brought to 4 m.
const CLOSE = path.join(ROOT, 'tests', 'fixtures-local', 'close-range-2026-10-04', 'data');
const USABLE = 1 - 2 * .12;   // the frame between the tiles' bands (viewer.js FIT_TOP_BAND, FIT_BOTTOM_BAND), in screen half-heights
const FRAME = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, r3 = (x) => Math.round(x * 1000) / 1000;
  const ndc = (p) => { const q = p.clone().project(v.camera); return [r3(q.x), r3(q.y)]; };
  return {scene: h ? (h.vehicle ? 'vehicle' : h.synthetic ? 'swap' : 'hit') : null, direction: h && h.direction, range: h && h.rangeAtImpact, zoom: r3(v.camera.zoom), pivot: v.pivot, distance: r3(v.distance),
    eyeToPoint: v.point ? r3(v.camera.position.distanceTo(v.point)) : null, atCentre: r3(v.target.distanceTo(v.pivotCentre())), atPoint: v.point ? r3(v.target.distanceTo(v.point)) : null,
    orbit: ndc(v.target), contact: v.point ? ndc(v.point) : null, shift: r3(v.frameCenter.x / v.distance)}; })()`;
const inFrame = (xy) => !!xy && Math.abs(xy[0]) <= USABLE && Math.abs(xy[1]) <= USABLE;
async function closeCase(browser) {
  const folder = stage(CLOSE);
  try {
    const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 300 && !(document.querySelector('#hits [data-hit]') && window.__viewers.length && ${LV}.loadedData); i++) await new Promise((r) => setTimeout(r, 100)); await __settle(); })()`);
    const go = async (js) => { await p.evaluate(js); await p.evaluate('__settle()'); return p.evaluate(FRAME); };
    const count = await p.evaluate("document.querySelectorAll('#hits [data-hit]').length");
    const first = [];
    for (let i = 0; i < count; i++) first.push(Object.assign(await go(HIT(i)), {row: i}));
    const shown = first.filter((s) => s.contact), clinch = shown.filter((s) => s.direction === 'outgoing' && s.range < 7), far = shown.filter((s) => s.range > 100);
    const words = (s) => 'row ' + s.row + ' ' + s.range.toFixed(1) + ' m: zoom ' + s.zoom + ', orbit centre on screen ' + JSON.stringify(s.orbit) + ', contact ' + JSON.stringify(s.contact) + ', shift ' + s.shift;
    ok('the user\'s battle on Cliff: (its hits are on screen - ' + shown.length + ' with a contact point, three of his own shots from under 7 m, others from over 100 m)',
       shown.length >= 20 && clinch.length === 3 && far.length >= 5, JSON.stringify(shown.map((s) => +s.range.toFixed(1))));
    clinch.forEach((s) => {
      const tag = 'the user\'s battle on Cliff, his shot from ' + s.range.toFixed(1) + ' m, the first view: ';
      ok(tag + 'the orbit centre is the vehicle\'s centre and stands inside the frame, on the screen\'s axis - not two screens above it, with the floor mid-screen',
         s.pivot === 'vehicle' && s.atCentre < 1e-6 && Math.abs(s.orbit[0]) < 1e-6 && Math.abs(s.orbit[1]) <= USABLE, words(s));
      ok(tag + 'the contact point is inside the frame', inFrame(s.contact), words(s));
      ok(tag + 'the zoom is not below x1, and the camera stands on the shot\'s line where it stood', s.zoom >= 1 && s.eyeToPoint >= 3 - 1e-6 && s.eyeToPoint < s.range, words(s));
    });
    ok('the user\'s battle on Cliff: every hit\'s first view has the orbit centre and the contact point inside the frame, at a zoom of x1 or more',
       shown.every((s) => s.zoom >= 1 && Math.abs(s.orbit[0]) < 1e-6 && Math.abs(s.orbit[1]) <= USABLE && inFrame(s.contact)),
       shown.filter((s) => !(s.zoom >= 1 && Math.abs(s.orbit[1]) <= USABLE && inFrame(s.contact))).map(words).join(' | '));
    ok('the user\'s battle on Cliff: (a shot from over 100 m is framed as before - the armour\'s middle mid-screen, the orbit centre a little above it)',
       far.every((s) => s.zoom > 10 && Math.abs(s.orbit[1]) < .5 && s.shift < 0), far.map(words).join(' | '));
    // Both orbit centres, as he says: round the hit point the same shift put the point off the frame.
    for (const s of clinch) {
      const tag = 'the user\'s battle on Cliff, his shot from ' + s.range.toFixed(1) + ' m: ';
      await go(HIT(s.row));
      const H = await go("document.getElementById('pivot-hit').click()");
      ok(tag + 'the orbit round the hit point - the point is the orbit centre and stands mid-frame', H.pivot === 'hit' && H.atPoint < 1e-6 && inFrame(H.orbit) && Math.abs(H.orbit[0]) < 1e-6, words(Object.assign({row: s.row}, H)));
      const F = await go("document.getElementById('fit-camera').click()");
      ok(tag + '... Fit keeps it there', F.atPoint < 1e-6 && inFrame(F.orbit) && F.zoom >= 1, words(Object.assign({row: s.row}, F)));
      const V = await go("document.getElementById('pivot-vehicle').click()");
      ok(tag + '... and back round the vehicle\'s centre: the centre and the contact point inside the frame', V.pivot === 'vehicle' && V.atCentre < 1e-6 && Math.abs(V.orbit[1]) <= USABLE && inFrame(V.contact), words(Object.assign({row: s.row}, V)));
    }
    // Not the shot's own trouble: any vehicle brought that close and fitted had the floor mid-screen.
    await go(HIT(far[0].row));
    await go("document.getElementById('model-tile').click()");
    await go("document.querySelector('#vehicles [data-vehicle][data-exported=\"true\"]').click()");
    await go(`${LV}.setDistance(4)`);
    const B = await go("document.getElementById('fit-camera').click()");
    ok('the user\'s battle on Cliff: a browsed vehicle brought to 4 m and fitted - its centre is the orbit centre and stands inside the frame',
       B.scene === 'vehicle' && B.zoom >= 1 && B.atCentre < 1e-6 && Math.abs(B.orbit[1]) <= USABLE, JSON.stringify(B));
    ok('the user\'s battle on Cliff: no uncaught exception in the page', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the close-range run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
}

// ---- A RICOCHET IS DRAWN AS A RICOCHET (09.10) ----------------------------------------------------------------------------------
// The user: "when a ricochet is drawn, the second arrow, the dashed one that shows the bounce, is drawn only if the shell
// meets the armour again after the ricochet ... make the reflected arrow be drawn even if the shell goes off into the
// blue - a dashed bounce arrow at the angle of entry, purely decorative ... so that one can see it is a ricochet".
// The same battle on Cliff has them all: recorded ricochets whose shell left the vehicle (the last point is effect 1,
// INTERMEDIATE_RICOCHET, or 2, FINAL_RICOCHET), two with a real second leg (1 then 3; 1 then 4), plain hits, and one
// "final ricochet" recorded on a plate the line meets at 79 degrees - no plate a shell bounces off, so nothing to mirror.
// Asked: the arrow starts at the ricochet point, leaves the plate at the angle the shot came in at (the plate's normal
// taken a second way here - the page's own pick, not the code that draws), is the decorative length, dashed, with a
// head; a real second leg and a plain hit get nothing new. And the analysed shot (a pinned line - what the vehicle mode
// and the aim emulation draw) goes through the same owner: its leg into the air is that very arrow.
const BOUNCE = `(() => { const v = ${LV}, h = v.loadedData ? v.loadedData.hit : null, pts = v.shotPoints || [], last = pts[pts.length - 1], D = 180 / Math.PI, r4 = (x) => Math.round(x * 1e4) / 1e4;
  const legs = (root) => { const out = []; if (root) root.traverse((o) => { if (o.userData && o.userData.bounceLeg) out.push(o); }); return out; };
  const shape = (o) => { let dashed = false, head = false, from = null; o.traverse((c) => { if (c.material && c.material.isLineDashedMaterial && c.visible) { dashed = true; const a = c.geometry.getAttribute('position'); from = [a.getX(0), a.getY(0), a.getZ(0)]; }
    if (c.type === 'ArrowHelper' && c.cone.visible) head = true; });
    let shown = true; for (let q = o; q; q = q.parent) if (!q.visible) shown = false;
    const b = o.userData.bounceLeg; return {start: b.start.toArray(), out: b.out.toArray(), length: b.length, air: b.air, dashed: dashed, head: head, from: from, shown: shown}; };
  const res = {id: h && h.id, effects: pts.map((x) => x.effect), kids: v.root.children.length, legs: legs(v.root).map(shape), pinLegs: legs(v.pinGroup).map(shape)};
  if (last) { const d = last.line.clone().normalize(), met = v.pick(last.pos.clone().addScaledVector(d, -0.05), d), n = met && met.face ? met.face.normal.clone().transformDirection(met.object.matrixWorld).normalize() : null;
    res.point = last.pos.toArray(); res.line = d.toArray(); res.normal = n && met.point.distanceTo(last.pos) < 0.02 ? n.toArray() : null; res.plateDeg = res.normal ? r4(Math.asin(Math.abs(d.dot(n))) * D) : null; }
  const r = v.pinResult; res.pin = r ? {reason: r.reason, bounce: r.bounce ? {point: r.bounce.point, direction: r.bounce.direction} : null, distance: r.distance === undefined ? null : r.distance, final: !!r.final} : null;
  return res; })()`;
const PIN_LINE = `(() => { const v = ${LV}, pts = v.shotPoints || [], last = pts[pts.length - 1], d = last.line.clone().normalize();
  v.pinned = {origin: last.pos.clone().addScaledVector(d, -5), direction: d, point: last.pos.clone(), normal: null}; v.refreshPin(); })()`;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const BOUNCE_LENGTH = 2.3;   // the incoming arrow's own (viewer.js ARROW_LENGTH)
async function ricochetCase(browser) {
  const folder = stage(CLOSE);
  try {
    const p = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    await p.evaluate(DRIVER);
    await p.evaluate(`(async () => { for (let i = 0; i < 300 && !(document.querySelector('#hits [data-hit]') && window.__viewers.length && ${LV}.loadedData); i++) await new Promise((r) => setTimeout(r, 100)); await __settle(); })()`);
    const go = async (js) => { await p.evaluate(js); await p.evaluate('__settle()'); return p.evaluate(BOUNCE); };
    // The hits of another vehicle of the battle: its row of the roster first.
    const focus = (id) => go(`(() => { const d = document.getElementById('vehicle-focus'); if (!d.open) d.querySelector('summary').click(); document.querySelector('#focus-list [data-id="${id}"]').click(); })()`);
    const hit = (id) => go(`document.querySelector('#hits [data-hit="${id}"]').click()`);
    const tag = 'the user\'s battle on Cliff, ';
    // The arrow of one leg against the plate: [angle in, angle out, leaves the plate, lies in the plane of the shot and the normal].
    const mirror = (s, leg) => { const D = 180 / Math.PI, n = s.normal, d = s.line, o = leg.out, cross = [d[1] * n[2] - d[2] * n[1], d[2] * n[0] - d[0] * n[2], d[0] * n[1] - d[1] * n[0]];
      return {inDeg: Math.asin(Math.abs(dot(d, n))) * D, outDeg: Math.asin(Math.abs(dot(o, n))) * D, leaves: dot(d, n) * dot(o, n) < 0, plane: Math.abs(dot(o, cross)), unit: Math.hypot(o[0], o[1], o[2])}; };
    let airPins = 0;
    // The recorded ricochets whose shell left the vehicle: [the roster row, the hit, the effect of its last point].
    for (const c of [['5250486', '5', 1], ['5250486', '13', 1], ['5250485', '19', 1], ['5250481', '24', 2]]) {
      await focus(c[0]);
      const s = await hit(c[1]), leg = s.legs[0], m = leg && s.normal ? mirror(s, leg) : null;
      const words = JSON.stringify({effects: s.effects, plateDeg: s.plateDeg, legs: s.legs.length, mirror: m, leg: leg});
      ok(tag + 'hit ' + c[1] + ' (a recorded ricochet, effect ' + c[2] + ', the shell left the vehicle; the shot meets the plate at ' + s.plateDeg + ' degrees): (the record is as the fixture has it)',
         s.id === c[1] && s.effects[s.effects.length - 1] === c[2] && !!s.normal && s.plateDeg < 35, words);
      ok(tag + 'hit ' + c[1] + ': ONE bounce arrow, from the ricochet point, of the decorative length ' + BOUNCE_LENGTH + ' m, ending in the air - dashed, with a head, on screen with the recorded shot',
         s.legs.length === 1 && gap(leg.start, s.point) < 1e-6 && leg.length === BOUNCE_LENGTH && leg.air === true && leg.dashed && leg.head && leg.shown && gap(leg.from, s.point) < 1e-6, words);
      ok(tag + 'hit ' + c[1] + ': it is the shot mirrored in the plate - the angle between the plate and the bounce arrow equals the angle between the plate and the shot (to 0.01 degrees), it leaves the plate, and it lies in the plane of the shot and the plate\'s normal',
         !!m && Math.abs(m.inDeg - m.outDeg) < 0.01 && m.leaves && m.plane < 1e-6 && Math.abs(m.unit - 1) < 1e-9, words);
      // The same line as an analysed shot (a pin: the vehicle mode's own shot and the aim emulation's go this way).
      const pinned = await go(PIN_LINE), pl = pinned.pinLegs[0], r = pinned.pin;
      const ricochets = !!r && (!!r.bounce || r.reason === 'ricochet');
      if (ricochets) {
        const air = r.distance === null || !r.bounce;
        if (air) airPins++;
        ok(tag + 'hit ' + c[1] + ', its line pinned (our law says ' + r.reason + (r.bounce ? ', a bounce' : '') + (air ? ', into the air' : ', a second contact ' + r.distance.toFixed(2) + ' m on') + '): the leg comes from the same owner - '
           + (air ? 'the decorative arrow, ' + BOUNCE_LENGTH + ' m, dashed, with a head' : 'dashed to the second contact, no head, as before') + ', along the bounce our law gives; the recorded arrow is put away with the recorded shot',
           pinned.pinLegs.length === 1 && pl.dashed && pl.air === air && pl.head === air && (air ? pl.length === BOUNCE_LENGTH : Math.abs(pl.length - r.distance) < 1e-9)
           && (!r.bounce || (gap(pl.out, r.bounce.direction) < 1e-9 && gap(pl.start, r.bounce.point) < 1e-9)) && pinned.legs.length === 1 && pinned.legs[0].shown === false,
           JSON.stringify({pin: r, pinLegs: pinned.pinLegs, recorded: pinned.legs}));
      } else ok(tag + 'hit ' + c[1] + ', its line pinned (our law says ' + (r ? r.reason : 'nothing') + ' - no ricochet): no bounce leg on the pin', pinned.pinLegs.length === 0, JSON.stringify(pinned.pin));
      const back = await go(`${LV}.unpin()`);
      ok(tag + 'hit ' + c[1] + ': the pin dropped - its leg is gone, the recorded arrow is back', back.pinLegs.length === 0 && back.legs.length === 1 && back.legs[0].shown === true, JSON.stringify(back.legs));
    }
    ok(tag + '(of those four lines our law sends at least one off the vehicle after its ricochet - the pinned leg into the air was really asked)', airPins >= 1, '(' + airPins + ')');
    // A real second leg: nothing new.
    for (const c of [['5250486', '1', [1, 3], 9], ['5250485', '30', [1, 4], 10]]) {
      await focus(c[0]);
      const s = await hit(c[1]);
      ok(tag + 'hit ' + c[1] + ' (a ricochet with a real second leg, effects ' + c[2].join(' then ') + '): unchanged - no decorative arrow, the scene holds what it held (' + c[3] + ' objects)',
         JSON.stringify(s.effects) === JSON.stringify(c[2]) && s.legs.length === 0 && s.kids === c[3], JSON.stringify({effects: s.effects, legs: s.legs.length, kids: s.kids}));
    }
    // Not a ricochet plate: a "final ricochet" recorded where the line meets the plate at 79 degrees.
    await focus('5250481');
    const odd = await hit('50');
    ok(tag + 'hit 50 (effects 0 then 2, but the line meets the plate at its point at ' + odd.plateDeg + ' degrees - no plate a shell bounces off): nothing is mirrored, no arrow',
       JSON.stringify(odd.effects) === '[0,2]' && odd.plateDeg > 60 && odd.legs.length === 0, JSON.stringify({effects: odd.effects, plateDeg: odd.plateDeg, legs: odd.legs.length}));
    // Plain hits: every row of this vehicle's list whose last point is no ricochet.
    const rows = JSON.parse(await p.evaluate("JSON.stringify([].slice.call(document.querySelectorAll('#hits [data-hit]')).map((e) => e.getAttribute('data-hit')))"));
    const plain = [];
    for (const id of rows.slice(0, 8)) { const s = await hit(id), e = s.effects[s.effects.length - 1]; if (e !== 1 && e !== 2) plain.push(s); }
    ok(tag + 'plain hits (' + plain.length + ' of the first rows of that list, none ending in a ricochet): no bounce arrow on any',
       plain.length >= 4 && plain.every((s) => s.legs.length === 0 && s.pinLegs.length === 0), JSON.stringify(plain.map((s) => [s.id, s.effects, s.legs.length])));
    ok(tag + 'the ricochet walk: no uncaught exception in the page', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the ricochet run completes', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
}

// Each case runs on its own fixture; one that is not on this machine says SKIP, and with none the run is a skip (77).
async function main() {
  const only = process.argv.filter((a) => a.indexOf('--only=') === 0).map((a) => a.slice(7))[0];   // one case by its function's name, for a quick run
  const cases = [[DATA, 'scene-state-2026-10-04', swapCase], [CLOSE, 'close-range-2026-10-04', closeCase], [CLOSE, 'close-range-2026-10-04', ricochetCase]].filter(function (c) {
    if (only && c[2].name !== only) return false;
    if (fs.existsSync(path.join(c[0], 'index.js'))) return true;
    console.log('SKIP: the user\'s battle of ' + c[1] + ' is not on this machine (python tests/fixtures-local/' + c[1] + '/make.py)');
    return false;
  });
  if (!cases.length) return 77;
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  try { for (const c of cases) await c[2](browser); }
  finally { await browser.close(); }
  console.log('real scene (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
