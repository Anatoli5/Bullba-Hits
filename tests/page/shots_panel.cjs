/* The replay viewer's shots panel (BACKLOG 109, stage 1, 19.11.2026) on the user's battle of 14.11 on Malinovka.
 *
 *   node tests/page/shots_panel.cjs
 *
 * 1. The mod's code makes the viewer's inputs, as tests/page/playback_page.cjs does: tests/py27/playback_job.py --stage
 *    <folder> under the client's own python27.dll (tests/fixtures-local/playback-2026-11-18): the battle file, its source
 *    (the kept stream.z), the client's definitions file.
 * 2. The page's own battle builder (web/playback/battle.js) under node builds the battle from them, as the viewer's worker
 *    does.
 * 3. The panel as it ships (web/hit-rows.js, web/rows.css, web/playback/shots-panel.js, shots-panel.css) in a local headless
 *    Chrome, beside a stand-in team list, opened for the player's own vehicle and for the enemy with the most shots.
 * The one number: the rows the panel shows for a vehicle = its shots in the replay (its tracers, a ricochet's own tracer not
 * counted) + the hits it took (showDamageFromShot on it) + its hits with no tracer of his ending within 0.15 s - counted
 * here from the battle object directly, not by the panel's code. And (20.11) its height: 15 team rows beside a 2-row
 * tournament list as beside a full one (the team lists stand in with playback.html's own styles and renderList's row
 * markup), held to the lists' bottom in a low window. Also: a row's click asks for the battle 2 s before the
 * shot with a camera; Hits' row markup (a .hit button with the tile, the icon column and the outcome); no page error.
 * No fixture, no client or no browser: SKIP (exit 77).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib'), {spawnSync} = require('child_process');
const {launch} = require('./cdp.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTLE = '2315856430906286521-d36eff9b31bb';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures-local', 'playback-2026-11-18');
const PYTHON = process.env.BULLBA_PYTHON || 'python';
let checks = 0, failed = 0, skipped = null;
function check(name, ok, detail) { checks++; if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); } }
function skip(text) { skipped = text; throw new Error('skip'); }
function received(file) { let v = null; const t = fs.readFileSync(file, 'utf8'); const A = {receive: (p) => { v = p[1]; }}; new Function('ArmorInspectorData', t)(A); return v; }
// the panel's figure counted from the battle object alone
function expected(b, id) {
  const shots = b.shots, tracers = shots.filter((s) => s[1] === id && !s[2]);
  const ends = shots.filter((s) => s[1] === id).map((s) => s[10]);
  const taken = b.hitEvents.filter((h) => h[1] === id);
  const byHim = b.hitEvents.filter((h) => h[2] === id && h[1] !== id && !ends.some((e) => Math.abs(e - h[0]) <= 0.15));
  return {rows: tracers.length + taken.length + byHim.length, shots: tracers.length, taken: taken.length, untraced: byHim.length};
}

(async function main() {
  if (!fs.existsSync(FIXTURE)) { console.log('SKIP no fixture ' + FIXTURE); process.exit(77); }
  const stage = path.join(os.tmpdir(), 'bullba-shots-panel-' + crypto.randomUUID());
  fs.mkdirSync(stage, {recursive: true});
  let browser = null;
  try {
    const run = spawnSync(PYTHON, ['-I', path.join(ROOT, 'tests', 'py27', 'run27.py'), 'tests/py27/playback_job.py', '--stage', stage],
      {cwd: ROOT, encoding: 'utf-8', timeout: 240000, windowsHide: true});
    if (run.status === 77) skip('the mod job: ' + String(run.stdout || '').trim().split('\n').pop());
    check('the mod job made the battle file, its source and the definitions', run.status === 0, String(run.stdout || '') + String(run.stderr || '').slice(-600));
    if (run.status !== 0) return;
    const pb = path.join(stage, 'data', 'playback'), info = received(path.join(pb, BATTLE + '.js'));
    const defs = received(path.join(pb, info.defs + '.js')), src = received(path.join(pb, info.source.file));
    const B = require(path.join(ROOT, 'web', 'playback', 'battle.js'));
    B.setInflate((bytes) => Promise.resolve(new Uint8Array(zlib.inflateSync(bytes))));
    const stream = await B.source(info.source.kind, B.unb64(src), info.id);
    const battle = B.build(defs, info, stream).battle;
    check('the battle keeps every hit event of the replay (hitEvents) and the tracers\' calibre', Array.isArray(battle.hitEvents) && battle.hitEvents.length > 30 &&
      battle.shotFields.indexOf('caliber') === 15 && battle.shots.every((s) => s.length === 16) && Number.isFinite(battle.meta.serverStart),
      JSON.stringify({hitEvents: battle.hitEvents && battle.hitEvents.length, fields: battle.shotFields, serverStart: battle.meta.serverStart}));
    // the link of a shot to the hits it made (the panel's model under node): what share of the shots that met a vehicle
    const S = require(path.join(ROOT, 'web', 'playback', 'shots-panel.js'));
    const links = S.linkHits(battle), linked = links.hitShot.filter((j) => j >= 0).length, traced = battle.hitEvents.filter((h) => battle.shots.some((s) => s[1] === h[2])).length;
    check('hits linked to their shot: ' + linked + ' of ' + battle.hitEvents.length + ' hit events (' + traced + ' have a tracer of their shooter in the replay)', linked > 0 && linked <= traced);
    const own = battle.meta.own, ownTeam = (battle.vehicles.find((v) => v.id === own) || {}).team;
    const enemies = battle.vehicles.filter((v) => v.team !== ownTeam).map((v) => v.id);
    const enemy = enemies.map((id) => [id, expected(battle, id).shots]).sort((a, c) => c[1] - a[1])[0][0];
    // the page: the panel's files as they ship, a stand-in team list as the anchor, the battle as the viewer holds it
    const web = path.join(stage, 'web');
    fs.mkdirSync(path.join(web, 'playback'), {recursive: true});
    for (const f of ['hit-rows.js', 'rows.css', 'playback/shots-panel.js', 'playback/shots-panel.css']) fs.copyFileSync(path.join(ROOT, 'web', f), path.join(web, f));
    const plain = JSON.parse(JSON.stringify(battle, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
    fs.writeFileSync(path.join(web, 'panel-battle.js'), 'window.BATTLE = ' + JSON.stringify(plain) + ';\n');
    // the viewer's own styles (playback.html's inline block: the team rows, the lists' room, the panel's limit), then the
    // shared row styles and the panel's, in the page's order
    const viewerStyle = /<style>([\s\S]*?)<\/style>/.exec(fs.readFileSync(path.join(ROOT, 'web', 'playback.html'), 'utf8'))[1];
    fs.writeFileSync(path.join(web, 'panel-test.html'), '<!doctype html><html><head><meta charset="utf-8"><style>' + viewerStyle + '</style><link rel="stylesheet" href="rows.css">' +
      '<link rel="stylesheet" href="playback/shots-panel.css"></head><body><div id="list-own" class="tlist own"></div><div id="list-enemy" class="tlist enemy"></div>' +
      '<script src="panel-battle.js"></script><script src="hit-rows.js"></script><script src="playback/shots-panel.js"></script></body></html>');
    browser = await launch({width: 1280, height: 720});
    if (!browser) skip('no Chrome or Edge on this machine');
    const page = await browser.open('file:///' + path.join(web, 'panel-test.html').replace(/\\/g, '/'));
    await new Promise((r) => setTimeout(r, 500));
    const setup = "window.__picked = []; window.P = BullbaShotsPanel.create({battle: BATTLE, info: function (id) { var v = BATTLE.vehicles.filter(function (x) { return x.id === id; })[0];" +
      " return v ? {name: v.type.split(':')[1], type: v.type} : null; }, player: function (id) { return ''; }, clock: function (t) { return t.toFixed(1); }," +
      " pick: function (row, jump) { window.__picked.push({t: row.t, jump: jump}); }, hits: function () { return function () {}; }}); true";
    check('the panel is made', await page.evaluate(setup) === true);
    // the team lists as playback.js renderList makes them (the HP fill, the nickname, the compact tile, the panel's button):
    // the own side a tournament team of 2 (20.11: the panel was squeezed to 1.5 rows), the enemy side a full team of 15
    const ownTeamIds = battle.vehicles.filter((v) => v.team === ownTeam).map((v) => v.id).slice(0, 2);
    const enemyIds = Array.from({length: 15}, (x, i) => enemies[i % enemies.length]);
    const lists = await page.evaluate("(function (sides) { Object.keys(sides).forEach(function (side) { var box = document.getElementById('list-' + side);" +
      " sides[side].forEach(function (id) { var el = document.createElement('div'); el.className = 'veh'; var bar = document.createElement('i'); bar.className = 'fill';" +
      " var pl = document.createElement('span'); pl.className = 'pl'; pl.textContent = 'player_' + id; var v = BATTLE.vehicles.filter(function (x) { return x.id === id; })[0];" +
      " var nm = BullbaRows.vehicleTile({name: v.type.split(':')[1], type: v.type}, true, {compact: true}); nm.classList.add('nm');" +
      " var tile = document.createElement('div'); tile.className = 'veh-tile'; tile.appendChild(bar); tile.appendChild(pl); tile.appendChild(nm); el.appendChild(tile);" +
      " el.appendChild(BullbaShotsPanel.button(function () {})); box.appendChild(el); }); });" +
      " var row = document.querySelector('#list-own .veh'), cs = getComputedStyle(row); return {own: document.querySelectorAll('#list-own .veh').length, enemy: document.querySelectorAll('#list-enemy .veh').length," +
      " pitch: row.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom), label: row.querySelector('.sp-btn').textContent}; })(" + JSON.stringify({own: ownTeamIds, enemy: enemyIds}) + ")");
    check('the stand-in team lists: ' + lists.own + ' rows on the left, ' + lists.enemy + ' on the right, a row ' + lists.pitch + ' px with its gap; the row button says \'shots\'',
      lists.own === 2 && lists.enemy === 15 && lists.pitch > 5 && lists.label === 'shots', JSON.stringify(lists));
    for (const [label, id, side] of [['the own vehicle', own, 'own'], ['the enemy with the most shots', enemy, 'enemy']]) {
      const want = expected(battle, id);
      const got = await page.evaluate("(function () { P.open(" + id + ", document.getElementById('list-" + side + "'), '" + side + "'); var box = P.element, r = box.getBoundingClientRect(), a = document.getElementById('list-" + side + "').getBoundingClientRect();" +
        " var row = box.querySelector('.sp-row .hit'), open = box.querySelector('.sp-open'); return {count: P.count(), shown: P.shown(), top: r.top - a.top, height: r.height, list: a.height, beside: '" + side + "' === 'own' ? r.left - a.right : a.left - r.right," +
        " scroll: getComputedStyle(box.querySelector('.sp-list')).overflowY, markup: row ? [].map.call(row.children, function (c) { return c.className; }).join(' ') : null," +
        " link: open ? {icon: !!open.querySelector('svg.sp-open-icon'), text: open.textContent, title: open.title.split('\\n')} : null}; })()");
      check(label + ': the panel shows one row per shot and per hit taken - ' + got.count + ' rows (' + want.shots + ' shots, ' + want.taken + ' hits taken, ' + want.untraced + ' hits with no tracer)',
        got.count === want.rows && got.shown === id, JSON.stringify({got: got, want: want}));
      check(label + ': beside its team list from its top, its own scroll; Hits\' row markup; the Bullba Hits link (the arrow-out icon, the name, a title, what it does, when shown)',
        Math.abs(got.top) < 1 && got.beside > 0 && got.beside < 20 && got.scroll === 'auto' && got.markup === 'vehicle-tile hit-crits hit-outcome' &&
        got.link && got.link.icon && got.link.text === 'Bullba Hits' && got.link.title.length === 3 && /^Opens this shot in the Bullba Hits window/.test(got.link.title[1]), JSON.stringify(got));
      // the one number (20.11): the panel is as tall as a full team list of 15 rows, whatever its own list holds
      const full = 15 * lists.pitch;
      check(label + ': the panel ' + got.height.toFixed(1) + ' px tall = 15 team rows ' + full.toFixed(1) + ' px, beside a list of ' + got.list.toFixed(1) + ' px',
        Math.abs(got.height - Math.round(full)) < 1 && (side === 'own' ? got.list < full / 2 : Math.abs(got.list - full) < 1), JSON.stringify({got: got.height, full: full, list: got.list}));
    }
    const picked = await page.evaluate("(function () { var rows = P.element.querySelectorAll('.sp-row .hit'); rows[rows.length - 1].click(); return {picked: __picked.slice(-1)[0], pressed: P.element.querySelectorAll('.hit[aria-pressed=true]').length}; })()");
    const p = picked.picked;
    check('a row\'s click asks for the battle 2 s before its shot, with a camera on both vehicles; the row pressed', p && Math.abs(p.jump.t - Math.max(0, p.t - 2)) < 1e-6 && p.jump.camera &&
      ['tx', 'ty', 'tz', 'yaw', 'pitch', 'dist'].every((k) => Number.isFinite(p.jump.camera[k])) && picked.pressed === 1, JSON.stringify(picked));
    const closed = await page.evaluate("(function () { P.toggle(" + enemy + ", document.getElementById('list-enemy'), 'enemy'); return {shown: P.shown(), hidden: P.element.hidden}; })()");
    check('the same vehicle\'s button again closes the panel', closed.shown === null && closed.hidden === true, JSON.stringify(closed));
    // a short window: the panel keeps to the lists' bottom (playback.html: the left list's max-height, the window less 72 px, from its top at 8 px)
    await page.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 260, deviceScaleFactor: 1, mobile: false});
    const low = await page.evaluate("(function () { P.open(" + own + ", document.getElementById('list-own'), 'own'); return {bottom: P.element.getBoundingClientRect().bottom, h: innerHeight}; })()");
    check('a 260 px window: the panel ends where the left list may end (' + low.bottom.toFixed(1) + ' px, the window ' + low.h + ' px)', Math.abs(low.bottom - (low.h - 72 + 8)) < 1, JSON.stringify(low));
    await page.send('Emulation.clearDeviceMetricsOverride');
    check('no page error', !page.errors.length, JSON.stringify(page.errors.slice(0, 3)));
  } catch (e) {
    if (e.message !== 'skip') { failed++; console.log('FAIL the test ran: ' + (e && e.stack || e)); }
  } finally {
    if (browser) await browser.close();
    try { fs.rmSync(stage, {recursive: true, force: true}); } catch (e) { /* a locked file of the browser: left in the temp folder */ }
  }
  if (skipped) { console.log('SKIP ' + skipped); process.exit(77); }
  console.log(checks + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
