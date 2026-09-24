/* A local headless Chrome (or Edge) driven over the DevTools protocol on a pipe - no npm package, no port, no window.
 *
 * The approach of tools/verify_gpu_browser.cjs: a temporary profile of its own, --remote-debugging-pipe (fd 3/4),
 * nothing of the user's browser profile is read. Network is cut off with a resolver rule, so a page can reach nothing
 * but file:// - the product is a local page and must work that way.
 *
 *   const {launch} = require('./cdp.cjs');
 *   const b = await launch({width: 1600, height: 1000});    // null when no browser is installed (the caller SKIPs)
 *   const page = await b.open(fileUrl, initScript);          // {send, evaluate, sessionId, errors, console}
 *   await page.evaluate('1+1');                              // Runtime.evaluate, awaited, by value
 *   await b.close();
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), {spawn} = require('child_process');

const CANDIDATES = [
  process.env.BULLBA_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

function findBrowser() { return CANDIDATES.find(function (p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null; }

async function launch(options) {
  options = options || {};
  const exe = findBrowser();
  if (!exe) return null;
  const profile = path.join(os.tmpdir(), 'bullba-cdp-' + crypto.randomUUID());
  fs.mkdirSync(profile, {recursive: true});
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-default-apps', '--disable-breakpad', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    // Software WebGL: the viewer is three.js; without a GPU in headless mode Chrome needs SwiftShader allowed.
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--allow-file-access-from-files', '--window-size=' + (options.width || 1600) + ',' + (options.height || 1000),
    '--user-data-dir=' + profile, 'about:blank'];
  const child = spawn(exe, args, {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true});
  let counter = 0, buffer = Buffer.alloc(0), stderr = '', exited = false;
  const pending = new Map(), listeners = [];
  child.stderr.on('data', function (d) { stderr = (stderr + d).slice(-4000); });
  child.on('exit', function (code) {
    exited = true;
    const error = new Error('browser exited ' + code + ' ' + stderr.slice(-800));
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  child.on('error', function () {});
  child.stdio[4].on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    let at;
    while ((at = buffer.indexOf(0)) >= 0) {
      const text = buffer.subarray(0, at).toString(); buffer = buffer.subarray(at + 1);
      if (!text) continue;
      const m = JSON.parse(text);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(p.method + ': ' + JSON.stringify(m.error))); else p.resolve(m.result);
      } else if (m.method) listeners.forEach(function (fn) { fn(m); });
    }
  });
  function send(method, params, sessionId) {
    if (exited) return Promise.reject(new Error('browser is gone'));
    return new Promise(function (resolve, reject) {
      const id = ++counter;
      pending.set(id, {resolve: resolve, reject: reject, method: method});
      child.stdio[3].write(JSON.stringify(Object.assign({id: id, method: method, params: params || {}}, sessionId ? {sessionId: sessionId} : {})) + '\0');
    });
  }
  const version = await send('Browser.getVersion');
  // initScript (optional) runs in the page before any of its own scripts, on every load: a test seam from outside.
  async function open(url, initScript) {
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId: targetId, flatten: true});
    const page = {sessionId: sessionId, targetId: targetId, console: [], errors: []};
    listeners.push(function (m) {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') page.errors.push(m.params.exceptionDetails.exception ? (m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text) : m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled') page.console.push(m.params.type + ': ' + m.params.args.map(function (a) { return a.value !== undefined ? String(a.value) : (a.description || a.type); }).join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') page.console.push('log error: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    });
    page.send = function (method, params) { return send(method, params, sessionId); };
    page.evaluate = async function (expression) {
      const r = await send('Runtime.evaluate', {expression: expression, awaitPromise: true, returnByValue: true, userGesture: true}, sessionId);
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
    if (initScript) await page.send('Page.addScriptToEvaluateOnNewDocument', {source: initScript});
    const loaded = new Promise(function (resolve) {
      listeners.push(function (m) { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') resolve(); });
    });
    await page.send('Page.navigate', {url: url});
    await Promise.race([loaded, new Promise(function (r) { setTimeout(r, 20000); })]);
    return page;
  }
  async function close() {
    try { if (!exited) await Promise.race([send('Browser.close'), new Promise(function (r) { setTimeout(r, 3000); })]); } catch (e) { /* gone */ }
    await new Promise(function (r) { if (exited) r(); else { child.once('exit', r); setTimeout(function () { try { child.kill(); } catch (e) {} r(); }, 3000); } });
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profile, {recursive: true, force: true}); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 300); }); } }
  }
  return {exe: exe, product: version.product, send: send, open: open, close: close};
}

module.exports = {launch: launch, findBrowser: findBrowser};
