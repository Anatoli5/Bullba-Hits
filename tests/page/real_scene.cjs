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
 *   node tests/page/real_scene.cjs [--verbose]      exit 0 pass, 1 fail, 77 skip (no fixture, or no browser)
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

async function main() {
  if (!fs.existsSync(path.join(DATA, 'index.js'))) { console.log('SKIP: the user\'s battle is not on this machine (python tests/fixtures-local/scene-state-2026-10-04/make.py)'); return 77; }
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-scene-'));
  fs.cpSync(WEB, path.join(folder, 'web'), {recursive: true});
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(folder, 'Viewer.html'));
  fs.cpSync(DATA, path.join(folder, 'data'), {recursive: true});
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
  } finally {
    await browser.close();
    fs.rmSync(folder, {recursive: true, force: true});
  }
  console.log('real scene (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
