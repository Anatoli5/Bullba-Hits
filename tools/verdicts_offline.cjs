/* The Statistics log without the game: the page's own verdict pass, run over the exported records in node.
 *
 * The server's fact (the effect of every recorded contact point) is already in data/battles/*.js, and the
 * page's estimate is pure computation, so the comparison does not need the game client at all. In the game
 * the lines reach game.log only while the viewer is open in the client; here the same lines are written to a
 * file that tools/verdicts_from_log.py reads unchanged.
 *
 *     node tools/verdicts_offline.cjs [--data <folder>] [--out work/statistics] [--battle <id>] [--version]
 *
 *     --data     the exporter's folder (default: the game's own); read only, never written
 *     --out      where the log is written (default: work/statistics)
 *     --battle   one battle id instead of every battle of the index
 *     --version  print the page build and the records build the pass would stamp, then stop
 *
 * Nothing here re-implements the verdict: web/ballistics.js, web/viewer.js, web/shot-context.js, web/crits.js and
 * web/local-data.js are loaded as they are, and the verdict functions of web/app.js (shellAt, verdictLine,
 * damageColumns, queueVerdicts, drainVerdicts and the helpers they call) are cut out of the file at run time
 * and evaluated, so a change to the page's line is a change to this log too. If one of those functions is
 * renamed or reshaped, the extraction fails loudly instead of drifting into a private copy.
 *
 * The only difference from an in-game line is mode=offline / mode=offline-shell-guess in place of
 * auto / auto-shell-guess, so the two sources can be told apart in one pile of lines.
 *
 * The records are private: nothing but the verdict lines and counts is printed - no nicknames, no vehicles.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DEFAULT_DATA = 'C:\\Games\\World_of_Tanks_NA\\mods\\configs\\local.armor_inspector\\data';

// ---- arguments -----------------------------------------------------------------------------------------
function options(argv) {
  const out = {data: DEFAULT_DATA, out: path.join(ROOT, 'work', 'statistics'), battle: null, version: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') out.data = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--battle') out.battle = argv[++i];
    else if (arg === '--version') out.version = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!out.data) throw new Error('--data needs a folder');
  out.data = path.resolve(out.data);
  out.out = path.resolve(out.out);
  return out;
}

// ---- the browser the page expects ----------------------------------------------------------------------
// Just enough of one for three.js, web/viewer.js and web/local-data.js: no rendering happens here, and the
// scene is never built - only the collision geometry and the rays through it.
function Script() { this.src = ''; this.onload = null; this.onerror = null; }
Script.prototype.remove = function () {};
Script.prototype.setAttribute = function () {};
Script.prototype.getAttribute = function () { return null; };

function element() {
  return {style: {}, dataset: {}, children: [], setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function () {}, removeChild: function () {}, addEventListener: function () {},
    removeEventListener: function () {}, getContext: function () { return null; }, remove: function () {}};
}

// `base` is the folder the page itself sits in - the parent of data/ - because local-data.js asks for
// 'data/index.js', 'data/battles/<id>.js' and so on, exactly as a <script src> would.
function browser(base) {
  const head = {
    appendChild: function (script) {
      const rel = String(script.src || '').split('?')[0];
      const file = path.join(base, rel);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (script.onerror) script.onerror(); return script; }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      try {
        // The data file is one call to ArmorInspectorData.receive([key, payload]) - the page's own contract.
        new Function('ArmorInspectorData', text)(global.window.ArmorInspectorData);
      } catch (e) { if (script.onerror) script.onerror(); return script; }
      if (script.onload) script.onload();
      return script;
    }
  };
  const document = {
    head: head, body: element(), hidden: false,
    createElement: function (tag) { return String(tag).toLowerCase() === 'script' ? new Script() : element(); },
    createElementNS: function () { return element(); },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}, removeEventListener: function () {}
  };
  const window = {
    document: document, console: console, addEventListener: function () {}, removeEventListener: function () {},
    performance: {now: function () { return Date.now(); }},
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    getComputedStyle: function () { return {}; },
    location: {hash: '', href: 'about:blank'}
  };
  window.window = window;
  global.window = window;
  global.document = document;
  global.self = window;
  return window;
}

// ---- the page's own verdict code, cut out of web/app.js ------------------------------------------------
// A scanner that knows strings and comments, so the brace that closes a function is found and not a brace
// inside a message. Whatever comes out is compiled below; a mis-cut fails there rather than silently.
function closingBrace(src, from) {
  let i = src.indexOf('{', from);
  if (i < 0) throw new Error('no body');
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); if (end < 0) throw new Error('unterminated comment'); i = end + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces');
}

function takeFunction(src, name) {
  const at = src.search(new RegExp('(^|[^\\w$.])function\\s+' + name + '\\s*\\('));
  if (at < 0) throw new Error('web/app.js has no function ' + name + ' any more: this tool must be re-pointed at the page\'s verdict code.');
  const open = src.indexOf('function', at);
  return src.slice(open, closingBrace(src, src.indexOf(')', open)) + 1);
}

function takeLiteral(src, pattern, what) {
  const m = pattern.exec(src);
  if (!m) throw new Error('web/app.js no longer declares ' + what + ': this tool must be re-pointed at the page\'s verdict code.');
  return m[1];
}

// The extracted functions get exactly the collaborators they name, as arguments, so nothing of this file
// leaks into them and nothing of them leaks out: `viewer`, `activeHit` and the Target switches are the
// values the automatic pass sees in the page (no viewer yet, no hit open, no switch moved by hand), which is
// what "the record's own liner factor, no user modifiers" means.
function verdictModule(appSource, deps) {
  const parts = [
    '\'use strict\';',
    'var effects=' + takeLiteral(appSource, /var\s+effects=(\{[^}]*\})/, 'the server effect names') + ';',
    'var partNames=' + takeLiteral(appSource, /partNames=(\[[^\]]*\])/, 'the part names') + ';',
    'var modsState={},modsType=\'\',viewer=null,activeHit=null;',
    takeFunction(appSource, 'modsFactor'),
    takeFunction(appSource, 'linerFactor'),
    takeFunction(appSource, 'targetFactor'),
    // A manual shell borrows the shooter's alpha (22.09); shellAt reaches for both of these, and although
    // this pass only ever hands it a saved candidate, the cut-out copy must still be able to run.
    'var MANUAL_DAMAGE_KEYS=' + takeLiteral(appSource, /var\s+MANUAL_DAMAGE_KEYS=(\[[^\]]*\])/, 'the manual-shell damage keys') + ';',
    takeFunction(appSource, 'manualDamageFrom'),
    takeFunction(appSource, 'shellAt'),
    takeLiteral(appSource, /(var\s+verdictLines=[^\n]*)\n/, 'the verdict counters'),
    takeFunction(appSource, 'verdictLine'),
    // The shooter's vehicle mode on the line (22.09): verdictLine calls it, so it has to come along.
    takeFunction(appSource, 'shellModeColumns'),
    takeFunction(appSource, 'damageColumns'),
    takeFunction(appSource, 'queueVerdicts'),
    takeFunction(appSource, 'drainVerdicts'),
    takeFunction(appSource, 'verdictStatus'),
    'return {queueVerdicts:queueVerdicts,pending:function(){return verdictQueue.length>0||verdictBusy;},lines:function(){return verdictLines;}};'
  ];
  const names = ['$', 'console', 'document', 'window', 'setTimeout', 'ArmorInspectorData', 'ArmorShotContext',
    'ArmorViewer', 'ArmorBallistics', 'ArmorCrits', 'recordsVersion'];
  let make;
  try { make = new Function(names.join(','), parts.join('\n')); }
  catch (e) { throw new Error('the verdict code of web/app.js could not be compiled on its own: ' + e.message); }
  return make.apply(null, names.map(function (n) { return deps[n]; }));
}

// ---- the run -------------------------------------------------------------------------------------------
function main(argv) {
  const opt = options(argv);
  if (opt.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*|^ \* ?|^ \*/gm, '') + '\n'); return 0; }

  const dataFolder = opt.data;
  if (!fs.existsSync(path.join(dataFolder, 'index.js'))) throw new Error('No index.js in ' + dataFolder);
  const base = path.dirname(dataFolder);
  if (path.basename(dataFolder) !== 'data') throw new Error('--data must point at the exporter\'s data folder');

  // The page build: web/index.html carries "dev" in the source tree and the real number only after a build,
  // so the exporter's VERSION is the fallback - the same string tools/build.py stamps into Viewer.html.
  let pageVersion = (/data-version="([^"]*)"/.exec(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')) || [])[1] || '';
  if (!pageVersion || pageVersion === 'dev') {
    const m = /^VERSION\s*=\s*'([^']+)'/m.exec(fs.readFileSync(path.join(ROOT, 'mod', 'local_armor_inspector', 'exporter.py'), 'utf8'));
    pageVersion = m ? m[1] : 'dev';
  }

  const window = browser(base);
  // three.min.js greets its own deprecation on load; that notice belongs to the page, not to this summary.
  const say = console.warn;
  console.warn = function () {};
  const three = require(path.join(WEB, 'vendor', 'three.min.js'));
  console.warn = say;
  global.THREE = (three && three.Vector3) ? three : window.THREE;
  require(path.join(WEB, 'ballistics.js'));
  require(path.join(WEB, 'viewer.js'));
  require(path.join(WEB, 'shot-context.js'));
  // The crit fields of the line (22.09): without this module the cut-out verdictLine would throw at the first line.
  require(path.join(WEB, 'crits.js'));
  require(path.join(WEB, 'local-data.js'));
  const ArmorBallistics = window.ArmorBallistics, ArmorShotContext = window.ArmorShotContext, ArmorCrits = window.ArmorCrits;
  const RealViewer = window.ArmorViewer, Data = window.ArmorInspectorData;

  // What the pass did with each hit, read off the calls the page's own code makes. Nothing is inferred
  // twice: the shell, the points and the verdicts are counted where they are produced.
  const tally = {battles: 0, hits: 0, queued: 0, lines: 0, skipped: {}, failed: {}};
  let job = null;
  function close() {
    if (!job) return;
    const reason = job.error ? 'scene could not be read' : job.points === null ? 'no shell determined'
      : job.points === 0 ? 'no point with a model and a direction' : job.verdicts === 0 ? 'no verdict at any point' : null;
    if (reason) tally.skipped[reason] = (tally.skipped[reason] || 0) + 1;
    job = null;
  }
  const probeData = {
    index: Data.index, battle: Data.battle, vehicles: Data.vehicles, vehicle: Data.vehicle, scene: Data.scene,
    sceneFor: function (battle, hit) {
      close();
      job = {points: null, verdicts: null, error: null};
      const here = job;
      return Data.sceneFor(battle, hit).then(function (d) { return d; }, function (e) { here.error = e; throw e; });
    }
  };
  const probeViewer = {
    points: function (hit, context) { const p = RealViewer.points(hit, context); if (job) job.points = p.length; return p; },
    verdicts: function (engine, pts, shell) { const v = RealViewer.verdicts(engine, pts, shell); if (job) job.verdicts = v.length; return v; }
  };

  // The page paces itself at 150 ms a hit so the user keeps his frames; offline the queue is drained as fast
  // as the CPU allows, so the timers are a plain list that the loop below empties.
  const timers = [];
  let timerId = 0;
  const fakeTimeout = function (fn) { timers.push(fn); return ++timerId; };

  const lines = [];
  const warnings = [];
  const pen = {
    info: function (text) {
      const line = String(text);
      if (line.indexOf('Bullba Hits verdict: ') !== 0) return;
      lines.push(line.replace(' mode=auto-shell-guess', ' mode=offline-shell-guess').replace(' mode=auto ', ' mode=offline '));
      tally.lines++;
    },
    // The page's own catch turns a hit it could not finish into one console line; here that line is the
    // reason a hit produced nothing, counted by its message so a broken record and broken code look different.
    warn: function (text) {
      const line = String(text), at = line.indexOf(' skipped: ');
      const reason = at < 0 ? line : line.slice(at + 10);
      tally.failed[reason] = (tally.failed[reason] || 0) + 1;
      warnings.push(line);
    },
    error: function (text) { pen.warn(text); },
    log: function () {}
  };

  // The page reads two elements in this code path: the version badge and the header counter. Everything else
  // of the document belongs to the interface, which is not running.
  const versionBadge = {getAttribute: function (k) { return k === 'data-version' ? pageVersion : null; }, textContent: ''};
  const sandboxWindow = {console: pen, ArmorViewer: probeViewer, ArmorBallistics: ArmorBallistics};

  const appSource = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

  return Data.index().then(function (index) {
    if (index.application !== 'local.armor_inspector' || !Array.isArray(index.battles)) throw new Error('Invalid battle list');
    const recordsVersion = index.version || '';
    if (opt.version) {
      process.stdout.write('page build ' + pageVersion + ' \u00b7 records ' + recordsVersion + '\n');
      return 0;
    }
    const api = verdictModule(appSource, {
      $: function (id) { return id === 'app-version' ? versionBadge : null; },
      console: pen, document: window.document, window: sandboxWindow, setTimeout: fakeTimeout,
      ArmorInspectorData: probeData, ArmorShotContext: ArmorShotContext, ArmorViewer: probeViewer,
      ArmorBallistics: ArmorBallistics, ArmorCrits: ArmorCrits, recordsVersion: recordsVersion
    });

    let ids = index.battles.map(function (b) { return b.id; });
    if (opt.battle) {
      if (ids.indexOf(opt.battle) < 0) throw new Error('No such battle in the index: ' + opt.battle);
      ids = [opt.battle];
    }

    const started = Date.now();
    let peak = 0;
    // One battle at a time: the battle record is dropped before the next is read, and the models are held by
    // the page's own cache in web/local-data.js, which keeps the last sixteen and no more.
    let chain = Promise.resolve();
    ids.forEach(function (id, n) {
      chain = chain.then(function () {
        return Data.battle(id).then(function (battle) {
          tally.battles++;
          tally.hits += (battle.hits || []).length;
          tally.queued += (battle.hits || []).filter(function (h) {
            return (h.points || []).some(function (p) { return p.status === 'resolved'; });
          }).length;
          api.queueVerdicts(battle);
          return drain(api, timers).then(function () {
            close();
            peak = Math.max(peak, process.memoryUsage().rss);
            process.stderr.write('  ' + (n + 1) + '/' + ids.length + ' battles \u00b7 ' + tally.lines + ' lines\r');
          });
        });
      });
    });

    return chain.then(function () {
      process.stderr.write('\n');
      if (!fs.existsSync(opt.out)) fs.mkdirSync(opt.out, {recursive: true});
      const stamp = new Date();
      const day = stamp.getFullYear() + '-' + String(stamp.getMonth() + 1).padStart(2, '0') + '-' + String(stamp.getDate()).padStart(2, '0');
      const target = path.join(opt.out, 'verdicts-offline-' + day + '.log');
      fs.writeFileSync(target, lines.length ? lines.join('\n') + '\n' : '', {encoding: 'utf8'});
      const seconds = (Date.now() - started) / 1000;
      process.stdout.write('Offline verdict pass \u00b7 page build ' + pageVersion + ' \u00b7 records ' + recordsVersion + '\n');
      process.stdout.write('  data      ' + dataFolder + '\n');
      process.stdout.write('  battles   ' + tally.battles + '\n');
      process.stdout.write('  hits      ' + tally.hits + ' recorded, ' + tally.queued + ' with a resolved point\n');
      process.stdout.write('  lines     ' + tally.lines + ' (one per contact point)\n');
      const listed = function (counts) {
        return Object.keys(counts).map(function (r) { return counts[r] + ' \u00d7 ' + r; }).join(', ');
      };
      const reasons = Object.keys(tally.skipped);
      process.stdout.write('  skipped   ' + (reasons.length ? listed(tally.skipped) : 'none') + '\n');
      if (Object.keys(tally.failed).length) process.stdout.write('  failed    ' + listed(tally.failed) + '\n');
      process.stdout.write('  time      ' + seconds.toFixed(1) + ' s \u00b7 peak memory ' + Math.round(peak / 1048576) + ' MB\n');
      process.stdout.write('  written   ' + target + '\n');
      // Hits that carry a resolved point and yet produced no line at all: the pass did not run, whatever the
      // reason - a wrong data folder, or verdict code of the page this tool can no longer drive.
      if (tally.queued > 0 && tally.lines === 0) {
        process.stderr.write('verdicts_offline: no verdict line was produced for any of the ' + tally.queued + ' hits with a resolved point.\n');
        return 1;
      }
      return 0;
    });
  });
}

// Empty the page's own queue: run whatever it has scheduled, and let the promises of a hit settle in between.
function drain(api, timers) {
  return new Promise(function (resolve, reject) {
    (function step() {
      if (timers.length) {
        const fn = timers.shift();
        try { fn(); } catch (e) { reject(e); return; }
        setImmediate(step);
        return;
      }
      if (!api.pending()) { resolve(); return; }
      setImmediate(step);
    }());
  });
}

Promise.resolve().then(function () { return main(process.argv.slice(2)); }).then(function (code) {
  process.exitCode = code || 0;
}, function (e) {
  process.stderr.write('verdicts_offline: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exitCode = 1;
});
