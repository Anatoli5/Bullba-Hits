/* Runs a page in the client's own CEF 109 (tests/page/cef109_host.py) and prints window.__probe as JSON, plus the GPU
   status Chromium reports (DevTools SystemInfo.getInfo). stack-env research 28.09.2026 - NOT wired into tools/check.py.
     node tests/page/cef109_probe.cjs <cefRuntimeCopyDir> <page.html> [--gpu-off-like-game] [extra switches...]
   <cefRuntimeCopyDir> is a copy of the client's CEF files (see cef109_host.py), never the game folder.
   The page sets window.__probe and window.__probeDone (tests/page/probe_features.html does). */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const [dir, page, ...rest] = process.argv.slice(2);
if (!dir || !page) { console.error('usage: node cef109_probe.cjs <cefRuntimeCopyDir> <page.html> [--game-switches] [switches]'); process.exit(2); }
const GAME = ['--in-process-gpu', '--disable-gpu', '--disable-gpu-compositing', '--enable-begin-frame-scheduling',
  '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process', '--user-agent=Chrome/109.0.5414.120 WorldOfTanks/2.4.0.0 (en)'];
const port = 9400 + Math.floor(Math.random() * 400), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cef109-'));
const sw = rest.flatMap(a => a === '--game-switches' ? GAME : [a]);
const url = 'file:///' + path.resolve(page).replace(/\\/g, '/');
const child = spawn(process.env.PYTHON || 'python', [path.join(__dirname, 'cef109_host.py'), url, '--no-sandbox', '--remote-debugging-port=' + port,
  '--browser-subprocess-path=' + path.join(path.resolve(dir), 'cef_subprocess.exe'), '--user-data-dir=' + tmp, '--log-file=' + path.join(tmp, 'cef.log'), '--log-severity=info', ...sw],
  { env: { ...process.env, CEF109_DIR: path.resolve(dir) }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const wait = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
  const open = new Promise(r => ws.onopen = r);
  return { open, ws, send: (method, params) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}
function stop() { try { execSync('taskkill /T /F /PID ' + child.pid, { stdio: 'ignore' }); } catch (e) {} }
(async () => {
  const t0 = Date.now(), limit = 60000; let target;
  while (!target && Date.now() - t0 < limit) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('file:')); } catch (e) {}
    if (!target) await sleep(300);
  }
  if (!target) { console.log('no page target'); stop(); process.exit(3); }
  const page = cdp(target.webSocketDebuggerUrl); await page.open;
  const ev = async x => ((await page.send('Runtime.evaluate', { expression: x, returnByValue: true })).result || {}).result || {};
  while (!(await ev('window.__probeDone===true')).value && Date.now() - t0 < limit) await sleep(300);
  const probe = JSON.parse((await ev('JSON.stringify(window.__probe||null)')).value || 'null');
  const browser = cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl); await browser.open;
  const gpu = ((await browser.send('SystemInfo.getInfo')).result || {}).gpu || {};
  const aux = gpu.auxAttributes || {};
  console.log(JSON.stringify({ switches: sw, probe, gpu: { featureStatus: gpu.featureStatus, glRenderer: aux.glRenderer, inProcessGpu: aux.inProcessGpu, softwareRendering: aux.softwareRendering } }, null, 1));
  stop(); process.exit(0);
})().catch(e => { console.error(e); stop(); process.exit(1); });
