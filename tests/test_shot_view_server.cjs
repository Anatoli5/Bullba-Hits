// The replay viewer's shot view (23.11.2026, NOTEBOOK Z5, Z7, Z8), the pure parts of web/playback/shot-view.js
// (BullbaShotView.arty) and one method of web/viewer.js:
// - Z5: the server circle while aiming comes from the server's gun update (0x39) when packet 0x1a's fields 3-10 are not the
//   server reticle (battle.js markerRows' flag 0). The user's case: his Redshire battle of 22.11 21:58, where 5 of 21 own
//   shots had no flag and the view wrote "no server circle is recorded at this shot" though 0x39 was there (the rows in
//   tests/fixtures-local/shot-view-server-2026-11-23, skipped when absent). On the flagged samples the rebuilt ring must
//   be the recorded server ring: radius within 5 %, centre within a tenth of the radius or 10 cm (median).
// - Z7: the wheel's reach back from the hit - the line's length, or BACK_FRAME x the framing distance past the muzzle.
// - Z8: Hits' recorded rings (aimGroup) are hidden while the shot view holds the shot and come back at the hit.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
const sandbox = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(WEB, 'playback', 'shot-view.js'), 'utf8'), sandbox);
const A = sandbox.window.BullbaShotView.arty;
const GAP = 0.3;   // shot-view.js AIM_GAP

// ---- Z5, synthetic: a gun at the origin aiming along +x, dispersion 2 mrad, the cursor 100 m out -------------------------
{
  const server = new Float32Array([10, 0, 1, 0, 1, 0, 0, 0.002, 10.1, 0, 1, 0, 0, 0, 1, 0.004]);
  const r = A.serverRing(server, 2, 10.05, [100, 1, 5], GAP);
  assert.ok(r, 'a ring from the update at or before the clock');
  const d = Math.hypot(100, 0, 5);
  assert.ok(Math.abs(r.radius - 0.002 * d) < 1e-6, 'radius = dispersion x the cursor point\'s distance');
  assert.ok(Math.abs(r.centre[0] - d) < 1e-4 && Math.abs(r.centre[1] - 1) < 1e-6 && Math.abs(r.centre[2]) < 1e-6, 'centre on the server axis');
  assert.strictEqual(A.serverRing(server, 2, 10.3, [100, 1, 5], GAP).k, 1, 'the last update before the clock');
  assert.strictEqual(A.serverRing(server, 2, 9, [100, 1, 5], GAP), null, 'none before the first update');
  assert.strictEqual(A.serverRing(server, 2, 11, [100, 1, 5], GAP), null, 'none from an update older than the gap');
  assert.strictEqual(A.serverRing(null, 0, 10, [100, 1, 5], GAP), null, 'none without 0x39');
}

// ---- Z5, the user's case --------------------------------------------------------------------------------------------
const FIX = path.join(__dirname, 'fixtures-local', 'shot-view-server-2026-11-23', 'rows.json');
if (fs.existsSync(FIX)) {
  const F = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const server = new Float32Array([].concat(...F.server)), ns = F.server.length;
  const before = (rows, t) => { let i = -1; rows.forEach((r, k) => { if (r[0] <= t) i = k; }); return i; };
  let unflagged = 0, rebuilt = 0;
  F.shots.forEach((t) => {
    const i = before(F.aim, t - F.delayOwn), m = F.aim[i];
    if (!m || m[12] === 1) return;
    unflagged++;
    if (A.serverRing(server, ns, t - F.delayOwn, [m[1], m[2], m[3]], GAP)) rebuilt++;
  });
  assert.ok(unflagged >= 4, 'the case is there: own shots whose 0x1a holds no server reticle (' + unflagged + ')');
  assert.strictEqual(rebuilt, unflagged, 'each of them gets the server circle from 0x39');
  // the rule against the recorded server ring (flagged samples, the 0x39 of the same azimuth as 0x1a's direction)
  const ratio = [], off = [];
  F.aim.forEach((m) => {
    if (m[12] !== 1) return;
    const az = Math.atan2(m[8], m[10]);
    for (let k = 0; k < ns; k++) {
      const v = F.server[k]; if (Math.abs(v[0] - m[0]) > 0.7) continue;
      const d = Math.atan2(v[4], v[6]) - az; if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > 2e-5) continue;
      const r = A.serverRing(server, ns, v[0], [m[5], m[6], m[7]], GAP);
      if (!r || r.k !== k) break;
      ratio.push(r.radius / (m[4] / 2));
      off.push(Math.hypot(r.centre[0] - m[5], r.centre[1] - m[6], r.centre[2] - m[7]) / Math.max(r.radius, 1));
      break;
    }
  });
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  assert.ok(ratio.length > 100, 'flagged samples compared: ' + ratio.length);
  assert.ok(Math.abs(med(ratio) - 1) < 0.05, 'radius as recorded: median ratio ' + med(ratio));
  assert.ok(med(off) < 0.1, 'centre as recorded: median ' + med(off));
  process.stdout.write('test_shot_view_server: the user\'s case: ' + unflagged + ' shots without the flag, all rebuilt; ' + ratio.length + ' flagged compared\n');
} else process.stdout.write('test_shot_view_server: no local fixture, the user\'s case skipped\n');

// ---- Z7 -------------------------------------------------------------------------------------------------------------
assert.strictEqual(A.backReach(300, 8), 300, 'a long line: its own length');
assert.strictEqual(A.backReach(2, 8), A.BACK_FRAME * 8, 'point-blank: past the muzzle to frame the tank');
assert.strictEqual(A.backReach(0, 0), 0);

// ---- Z8 -------------------------------------------------------------------------------------------------------------
{
  const win = {performance: {now: () => 0}};
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(WEB, 'viewer.js'), 'utf8'), win);
  const V = win.ArmorViewer;
  const aimGroup = {visible: true}, mark = {visible: true, userData: {}};
  const v = {aimGroup, root: {children: [aimGroup, mark]}, turretAngle: 0, gunAngle: 0, pinned: null, draw() {}};
  Object.setPrototypeOf(v, V.prototype);
  v.refreshPin = () => {}; v.aimReloadPart = null;
  v.holdShot(true);
  assert.strictEqual(aimGroup.visible, false, 'the recorded rings wait while the shot is held');
  assert.strictEqual(mark.visible, false, 'the hit marks wait too');
  // Z13 (23.11): no other path brings the target-frame rings back before the hit
  v.showSavedAim(true);
  assert.strictEqual(aimGroup.visible, false, 'showSavedAim keeps them hidden while held');
  v.unpin();
  assert.strictEqual(aimGroup.visible, false, 'an unpin keeps them hidden while held');
  v.setAimEmulation(false);
  assert.strictEqual(aimGroup.visible, false, 'the emulation switch keeps them hidden while held');
  v.holdShot(false);
  assert.strictEqual(aimGroup.visible, true, 'the rings come at the hit');
  assert.strictEqual(mark.visible, true);
}
process.stdout.write('test_shot_view_server: ok\n');
