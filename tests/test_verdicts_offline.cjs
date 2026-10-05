// tools/verdicts_offline.cjs, END TO END (04.10). The tool cuts the Statistics log's pass out of web/app.js and runs it in
// Node; only its cutters were under test (tests/test_verdict_line.cjs), so when the page's pass began to read `host.busy`
// (28.09, frame-sync) the tool died with "host is not defined" on every run and no check said so until 04.10.
// Here the whole tool runs over the synthetic data folder of tests/page/fixture.cjs: it must exit 0, write its log and
// give every hit with a resolved point its lines - the same lines the page writes, with mode=offline.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), {spawnSync} = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bullba-offline-'));
try {
  require(path.join(__dirname, 'page', 'fixture.cjs')).write(folder, {bulk: 40});
  const out = path.join(folder, 'out');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verdicts_offline.cjs'), '--data', path.join(folder, 'data'), '--out', out], {encoding: 'utf8'});
  const said = (run.stdout || '') + (run.stderr || '');
  assert.strictEqual(run.status, 0, 'the offline pass exits 0: ' + said.trim().split('\n').slice(-3).join(' | '));
  const logs = fs.readdirSync(out).filter((f) => /^verdicts-offline-.*\.log$/.test(f));
  assert.strictEqual(logs.length, 1, 'one log written');
  const lines = fs.readFileSync(path.join(out, logs[0]), 'utf8').split('\n').filter(Boolean);
  // The fixture: pm (2 hits), pm2, pm3, pm7, pm4, pm5, pm6 (1 each) and the bulk battle pmx (40) - one resolved point a hit.
  const per = {};
  lines.forEach((l) => { const m = /^Bullba Hits verdict: battle=(\S+) hit=(\S+) point=0 /.exec(l); assert.ok(m, 'a verdict line: ' + l.slice(0, 80)); per[m[1]] = (per[m[1]] || 0) + 1; });
  assert.deepStrictEqual(per, {pm: 2, pm2: 1, pm3: 1, pm7: 1, pm4: 1, pm5: 1, pm6: 1, pmx: 40}, 'every hit of every battle has its line');
  assert.ok(lines.every((l) => / mode=offline(-shell-guess)? /.test(l) && / v=\S+ rec=synthetic$/.test(l)), 'the lines are marked offline and carry the builds');
  assert.ok(/battles\s+8\b/.test(said) && /lines\s+48\b/.test(said) && /skipped\s+none/.test(said), 'the summary counts them: ' + said.replace(/\s+/g, ' ').slice(0, 300));
  console.log('ok   the offline pass runs end to end on the synthetic folder: 8 battles, 48 lines, none skipped');
} finally {
  try { fs.rmSync(folder, {recursive: true, force: true}); } catch (e) { /* a temp folder */ }
}
