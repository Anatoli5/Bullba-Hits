/* THE STATISTICS LOG'S BACKGROUND PASS (04.10, the user after 0.9.6: "131 points... it writes them as slowly as it exports
 * collision models, and it stands still while the mouse is over the scene"). The REAL page in a local headless browser.
 *
 * Measured before the change (outputs/stats-log-pass-2026-10-04.md): a hit's work is 2-3 ms, and the pass spent its time
 * waiting - 150 ms between two hits, and for as long as the aim loop of ⌖ was alive (it told the page "busy" every frame).
 * His battle of 104 hits took 74.9 s in the game and 16.2 s on the stand with nothing else going on; every opening of the
 * page wrote the same lines again.
 *
 * Asked of the page, on the synthetic folder of fixture.cjs (a battle of 300 hits, a revision on every battle, a hit
 * whose model is not on disk):
 *   - a battle's points are written once: the mark in localStorage (bullba-verdicts) names the battle's revision and the
 *     builds, and after a reload nothing is computed again - the header still says how many points the battle has;
 *   - the pace: one hit per frame-sized step - 300 hits in 4.5 to 9 s, never all at once;
 *   - the aim loop alive (W held under ⌖, the cursor resting on the scene) does not stop the pass;
 *   - what makes a battle be computed again: its revision in the index (in the open page too), the page's build; an index
 *     without revisions marks nothing; a hit whose scene was incomplete is the only one tried again, and is written when
 *     its model has come;
 *   - localStorage that throws: the pass works as it did, nothing is remembered, nothing breaks.
 * And THE USER'S OWN CASE ON HIS OWN BATTLE (rule B17): a copy of his two battles of 04.10 in
 * tests/fixtures-local/stats-log-2026-10-04 (local, never committed; its make.py copies them from the installed mod's
 * data). With ⌖ on, the cursor on the scene and W held, his battle of 104 hits is opened: its 125 points are written
 * within 4 s, and after a reload none again. No fixture on this machine: that part says SKIP.
 * The pass while the scene is orbited, and the frames meanwhile: tests/page/frame_cost.cjs.
 *
 *   node tests/page/stats_pass.cjs [--verbose]      exit 0 pass, 1 fail, 77 skip (no browser installed)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const {launch} = require('./cdp.cjs');
const fixture = require('./fixture.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.BULLBA_WEB ? path.resolve(process.env.BULLBA_WEB) : path.join(ROOT, 'web');
const REAL = path.join(ROOT, 'tests', 'fixtures-local', 'stats-log-2026-10-04', 'data');
const BIG = '6644634025496629-5bd54babf858', BIG_POINTS = 125, FIRST = '16395493982790178-3b8bc4ed2b13', FIRST_POINTS = 30;
const VERBOSE = process.argv.includes('--verbose');
const BULK = 300, STORE = 'bullba-verdicts';

let checks = 0, failures = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (extra ? ' ' + extra : '')); }
  else if (VERBOSE) console.log('ok   ' + name + (extra ? ' ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Before the page's scripts, on every load: the verdict lines with the time they were written; with #nostore in the
// address, a localStorage that throws on every access.
const INIT = `(() => {
  const lines = []; Object.defineProperty(window, '__lines', {value: lines});
  const info = console.info;
  console.info = function (text) { const s = String(text); if (s.indexOf('Bullba Hits verdict: ') === 0) lines.push([performance.now(), s]); return info.apply(this, arguments); };
  if (/nostore/.test(location.hash)) { const no = function () { throw new Error('storage is off'); };
    Storage.prototype.getItem = no; Storage.prototype.setItem = no; Storage.prototype.removeItem = no; }
})();`;

function stage(write) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-stats-'));
  fs.cpSync(WEB, path.join(folder, 'web'), {recursive: true});
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(folder, 'Viewer.html'));
  write(folder);
  return folder;
}
// The index of a staged folder, changed in place as the mod would write it.
function editIndex(folder, change) {
  const file = path.join(folder, 'data', 'index.js'), text = fs.readFileSync(file, 'utf8');
  const payload = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  change(payload[1]);
  fs.writeFileSync(file, 'ArmorInspectorData.receive(' + JSON.stringify(payload) + ');\n', 'ascii');
}

async function main() {
  const started = Date.now();
  const browser = await launch({width: 1600, height: 1000});
  if (!browser) { console.log('SKIP: no Chrome or Edge found (set BULLBA_BROWSER)'); return 77; }
  const options = {revs: true, bulk: BULK, broken: true}, folders = [];
  const folder = stage((f) => fixture.write(f, options)); folders.push(folder);
  try {
    const page = await browser.open(url.pathToFileURL(path.join(folder, 'Viewer.html')).href, INIT);
    // A reload tears the page's context down under a call now and then: asked again.
    const ev = async (js) => { for (let i = 0; ; i++) { try { return await page.evaluate(js); } catch (e) { if (i > 40) throw e; await sleep(100); } } };
    const listed = () => ev(`(async () => { for (let i = 0; i < 200; i++) { if (window.__lines && document.querySelector('#hits [data-hit]')) return true; await new Promise((r) => setTimeout(r, 50)); } return false; })()`);
    const status = () => ev(`document.getElementById('connection').textContent`);
    const lines = (battle) => ev(`window.__lines.filter((l) => / mode=auto/.test(l[1]) && l[1].indexOf('battle=${battle} ') > 0).map((l) => [Math.round(l[0]), /hit=(\\S+)/.exec(l[1])[1], l[1]])`);
    const total = () => ev(`window.__lines.filter((l) => / mode=auto/.test(l[1])).length`);
    const mark = () => ev(`(() => { try { return JSON.parse(localStorage.getItem('${STORE}')); } catch (e) { return 'threw'; } })()`);
    // The pass at rest: nothing queued, and no new line for `quiet` ms (a hit whose model file is missing is read three times).
    const settled = async (limit, quiet) => { const t0 = Date.now(); let last = -1, since = Date.now();
      while (Date.now() - t0 < (limit || 15000)) { const n = await ev('window.__lines.length'), s = await status();
        if (n !== last) { last = n; since = Date.now(); } else if (!/checking/.test(s) && Date.now() - since >= (quiet || 700)) return true; await sleep(50); } return false; };
    const reload = async () => { await page.send('Page.reload'); await sleep(150); await listed(); };
    const openBattle = (id) => ev(`(() => { if (document.getElementById('battle-list').hidden) document.getElementById('battle-pick').click(); document.querySelector('#battle-list [data-id="${id}"]').click(); return true; })()`);
    const key = (type, code, k, vk) => page.send('Input.dispatchKeyEvent', {type: type, code: code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk});
    // ⌖ on, the cursor on the middle of the scene, W held: the aim loop runs every frame without a pointer event.
    const aimAlive = async () => {
      await ev(`(() => { const b = document.getElementById('fun-mode-toggle'); if (b && !b.hidden && b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
      const box = await ev(`(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
      await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: box.x - 30, y: box.y, button: 'none'}); await sleep(60);
      await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: box.x, y: box.y, button: 'none'});
      await ev(`(document.getElementById('viewport').focus(), true)`);
      await key('keyDown', 'KeyW', 'w', 87);
    };
    const aimTicking = () => ev(`window.BullbaFrame.pendingNames().indexOf('aimTick') >= 0`);

    // ---- 1. a battle's points are written once ------------------------------------------------------------------
    ok('the page starts on the synthetic folder', await listed());
    await settled();
    let pm = await lines('pm');
    ok('the open battle is checked: its two points are written', pm.length === 2, '(' + pm.length + ')');
    ok('the header counts the open battle\'s points', (await status()) === 'Statistics log · 2 points', JSON.stringify(await status()));
    let m = await mark();
    ok('the mark: the battle, its revision and its points, under the builds of the page and of the records',
       !!m && m.v === 1 && m.stamp === 'dev|synthetic' && !!m.battles && !!m.battles.pm && m.battles.pm.r === 'fx.1' && m.battles.pm.n === 2 && !m.battles.pm.left, JSON.stringify(m));
    await reload(); await settled(4000, 1500);
    ok('reload: nothing is computed again', (await total()) === 0, '(' + (await total()) + ' lines written again)');
    ok('reload: the header still says what the battle has in the log', (await status()) === 'Statistics log · 2 points', JSON.stringify(await status()));

    // ---- 2. the pace: one hit per frame-sized step ----------------------------------------------------------------
    await openBattle('pmx');
    await sleep(700);
    const during = await status();
    for (let i = 0; i < 240 && (await ev(`window.__lines.length`)) < BULK; i++) await sleep(50);
    await settled();
    const px = await lines('pmx'), gaps = [];
    for (let i = 1; i < px.length; i++) gaps.push(px[i][0] - px[i - 1][0]);
    gaps.sort((a, b) => a - b);
    const span = px.length ? px[px.length - 1][0] - px[0][0] : 0, median = gaps.length ? gaps[gaps.length >> 1] : 0;
    ok('the pace: ' + BULK + ' hits written in 4.5 to 9 s (before: one hit every 150 ms, 45 s)', px.length === BULK && span >= 4500 && span <= 9000, '(' + px.length + ' lines over ' + span + ' ms)');
    ok('the pace: a frame-sized step between two hits (median 15 to 25 ms), never all at once', median >= 15 && median <= 25, '(median ' + median + ' ms)');
    ok('the header says how many hits are still queued while the pass runs', /^Statistics log · \d+ points · checking \d+ more$/.test(during), JSON.stringify(during));
    ok('the header after the pass: the battle\'s points', (await status()) === 'Statistics log · ' + BULK + ' points', JSON.stringify(await status()));
    await reload(); await settled(4000, 800); await openBattle('pmx'); await sleep(300); await settled(4000, 1200);
    ok('reload, the big battle opened again: nothing is computed, its ' + BULK + ' points are in the header',
       (await total()) === 0 && (await status()) === 'Statistics log · ' + BULK + ' points', '(' + (await total()) + ' lines, ' + JSON.stringify(await status()) + ')');

    // ---- 3. what computes a battle again ------------------------------------------------------------------------------
    // Its revision in the index, in the open page: the poll reads the battle again and the pass writes it again.
    await reload(); await settled(4000, 800);
    editIndex(folder, (index) => { index.battles[0].rev = 'fx.1b'; index.updatedAt += 1; });
    for (let i = 0; i < 180 && (await total()) < 2; i++) await sleep(50);
    await settled();
    pm = await lines('pm'); m = await mark();
    ok('a new revision of the open battle: it is written again, once', pm.length === 2 && (await total()) === 2, '(' + pm.length + ' lines)');
    ok('a new revision: the header counts the battle\'s points, not both passes; the mark names the new revision',
       (await status()) === 'Statistics log · 2 points' && !!m && m.battles.pm.r === 'fx.1b' && m.battles.pm.n === 2 && !!m.battles.pmx, JSON.stringify([await status(), m && m.battles.pm]));
    // An index without revisions (an earlier build's): nothing says the file is the same, so nothing is marked.
    editIndex(folder, (index) => { delete index.battles[0].rev; index.updatedAt += 1; });
    await reload(); await settled();
    const bare1 = await total();
    await reload(); await settled();
    m = await mark();
    ok('a battle without a revision in the index is checked on every opening, as before', bare1 === 2 && (await total()) === 2 && !!m && (!m.battles.pm || m.battles.pm.r === 'fx.1b'), '(' + bare1 + ', ' + (await total()) + ' lines; ' + JSON.stringify(m && m.battles.pm) + ')');
    editIndex(folder, (index) => { index.battles[0].rev = 'fx.1c'; index.updatedAt += 1; });
    // The page's build: every mark goes.
    const viewer = path.join(folder, 'Viewer.html');
    fs.writeFileSync(viewer, fs.readFileSync(viewer, 'utf8').replace('data-version="dev"', 'data-version="t2"'));
    await reload(); await settled();
    pm = await lines('pm'); m = await mark();
    ok('another build of the page: the battle is written again, by that build', pm.length === 2 && pm.every((l) => / v=t2 /.test(l[2])), '(' + pm.length + ')');
    ok('another build of the page: the marks of the build before are gone', !!m && m.stamp === 't2|synthetic' && Object.keys(m.battles).join() === 'pm', JSON.stringify(m && [m.stamp, Object.keys(m.battles)]));

    // ---- 4. the aim loop alive does not stop the pass (the user's "stands still while the mouse is over the scene") ----
    await aimAlive(); await sleep(300);
    await openBattle('pmx'); await sleep(500);
    const a0 = (await lines('pmx')).length; let alive = 0;
    for (let i = 0; i < 6; i++) { if (await aimTicking()) alive++; await sleep(250); }
    const a1 = (await lines('pmx')).length;
    await key('keyUp', 'KeyW', 'w', 87);
    ok('⌖ on, the cursor resting on the scene, W held: the aim loop runs every frame (the stand)', alive >= 5, '(' + alive + ' of 6 samples)');
    ok('the aim loop alive: the pass goes on (at least 40 hits in 1.5 s)', a1 - a0 >= 40, '(' + (a1 - a0) + ' hits)');
    for (let i = 0; i < 240 && (await lines('pmx')).length < BULK; i++) await sleep(50);
    await settled();

    // ---- 5. a hit whose scene was incomplete -----------------------------------------------------------------------------
    await openBattle('pmb'); await sleep(300); await settled(15000, 2500);
    let pb = await lines('pmb'); m = await mark();
    ok('a hit whose model is not on disk writes nothing; the battle\'s other hit is written', pb.length === 1 && pb[0][1] === 'pmb-1', JSON.stringify(pb.map((l) => l[1])));
    ok('the mark names the hit left for later', !!m && !!m.battles.pmb && m.battles.pmb.n === 1 && JSON.stringify(m.battles.pmb.left) === '["pmb-2"]', JSON.stringify(m && m.battles.pmb));
    await reload(); await settled(4000, 800); await openBattle('pmb'); await sleep(300); await settled(15000, 2500);
    pb = await lines('pmb'); m = await mark();
    ok('reload: only that hit is tried again - no line, the mark as it was, 1 point in the header',
       pb.length === 0 && (await total()) === 0 && !!m && JSON.stringify(m.battles.pmb.left) === '["pmb-2"]' && (await status()) === 'Statistics log · 1 points', JSON.stringify([pb.length, await total(), m && m.battles.pmb, await status()]));
    fs.writeFileSync(options.late.file, options.late.text, 'ascii');
    await reload(); await settled(4000, 800); await openBattle('pmb'); await sleep(300); await settled(15000, 1500);
    pb = await lines('pmb'); m = await mark();
    ok('its model has come: that hit is written, and nothing else of the battle',
       pb.length === 1 && pb[0][1] === 'pmb-2' && !!m && m.battles.pmb.n === 2 && !m.battles.pmb.left && (await status()) === 'Statistics log · 2 points', JSON.stringify([pb.map((l) => l[1]), m && m.battles.pmb, await status()]));

    // ---- 6. localStorage that throws ---------------------------------------------------------------------------------------
    await page.send('Page.navigate', {url: url.pathToFileURL(viewer).href + '#nostore'}); await sleep(200);
    await reload(); await settled();
    const off1 = await total(), offMark = await mark();
    await reload(); await settled();
    ok('localStorage that throws: the pass works as before - the battle is checked on every opening, nothing is remembered',
       off1 === 2 && (await total()) === 2 && offMark === 'threw' && (await status()) === 'Statistics log · 2 points', JSON.stringify([off1, await total(), offMark, await status()]));
    ok('no uncaught exception in the page (synthetic folder)', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

    // ---- 7. the user's own battle ----------------------------------------------------------------------------------------------
    if (!fs.existsSync(path.join(REAL, 'index.js'))) console.log('SKIP the user\'s battle of 04.10 is not on this machine (python tests/fixtures-local/stats-log-2026-10-04/make.py)');
    else {
      const real = stage((f) => fs.cpSync(REAL, path.join(f, 'data'), {recursive: true})); folders.push(real);
      const errors = page.errors.length;
      await page.send('Page.navigate', {url: url.pathToFileURL(path.join(real, 'Viewer.html')).href}); await sleep(300);
      await ev(`(localStorage.removeItem('${STORE}'), true)`);
      await reload(); await settled(30000, 1200);
      const first = await lines(FIRST);
      ok('his data: the battle the page opens is checked (' + FIRST_POINTS + ' points)', first.length === FIRST_POINTS, '(' + first.length + ')');
      await aimAlive(); await sleep(300);
      const clicked = await ev('performance.now()');
      await openBattle(BIG);
      // The click took the keyboard to the battle list and a new scene came: the cursor is put on it and W held again.
      await sleep(250); await aimAlive();
      const r0 = (await lines(BIG)).length; let live = 0, big = [];
      for (let i = 0; i < 4; i++) { await sleep(200); if (await aimTicking()) live++; }
      const r1 = (await lines(BIG)).length;
      for (let i = 0; i < 160; i++) { big = await lines(BIG); if (big.length >= BIG_POINTS) break; await sleep(50); }
      await key('keyUp', 'KeyW', 'w', 87);
      const took = big.length ? big[big.length - 1][0] - clicked : -1;
      ok('his data: the aim loop is alive while his battle is checked (the stand)', live >= 3, '(' + live + ' of 4 samples)');
      ok('his data: with the aim loop alive the pass goes on (at least 20 points in 0.8 s)', r1 - r0 >= 20, '(' + (r1 - r0) + ' points)');
      ok('his battle of 104 hits, opened with ⌖ on and the cursor on the scene: its ' + BIG_POINTS + ' points written within 4 s of the click (in the game 74.9 s, on the stand 16.2 s)',
         big.length === BIG_POINTS && took > 0 && took <= 4000, '(' + big.length + ' points, ' + Math.round(took) + ' ms)');
      console.log('his battle of 104 hits: ' + big.length + ' points ' + Math.round(took) + ' ms after the click (' + (big.length ? Math.round(big[big.length - 1][0] - big[0][0]) : -1) + ' ms from the first line to the last)');
      await settled();
      ok('his battle: the header counts its points', (await status()) === 'Statistics log · ' + BIG_POINTS + ' points', JSON.stringify(await status()));
      await reload(); await settled(6000, 1200); await openBattle(BIG); await sleep(500); await settled(6000, 1500);
      ok('his battle after a reload: nothing is written again, the header says ' + BIG_POINTS + ' points',
         (await total()) === 0 && (await status()) === 'Statistics log · ' + BIG_POINTS + ' points', '(' + (await total()) + ' lines, ' + JSON.stringify(await status()) + ')');
      ok('no uncaught exception in the page (his data)', page.errors.length === errors, page.errors.slice(errors, errors + 3).join(' | '));
    }
  } finally {
    await browser.close();
    folders.forEach((f) => { try { fs.rmSync(f, {recursive: true, force: true}); } catch (e) { /* a temp folder */ } });
  }
  console.log('stats pass (' + browser.product + '): ' + checks + ' checks, ' + failures + ' failed, ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.log('FAIL stats_pass: ' + (e && e.stack || e)); process.exit(1); });
