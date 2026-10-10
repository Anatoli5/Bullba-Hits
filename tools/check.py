"""One command for every check of the project: python tools/check.py

Quiet: one line per suite and only the failures (and skips) below it; the exit code is 1 on any red. tools/build.py runs
it before a build and refuses to build on red. Suites (they run side by side, ~1 min in all, the real page the longest):

  lists     the build lists against the disk and the page: ASSETS entries exist and are well-formed; every web/ file
            and every script/stylesheet index.html loads is in ASSETS (web/modifiers.js once shipped without it);
            the icons on disk = ICON_FILES + CRIT_ICON_FILES; CRIT_ICON_FILES = what tools/extract_crit_icons.py
            writes; the icon names of web/equipment.js are in ICON_FILES; web/aim-sound-samples.js is what the mod
            Bullba Countdown's synthesis renders (tools/build_aim_sounds.py; that project absent: SKIP)
  client    the installed client is the one tools/client_version.py names (another version or realm: another mods
            folder; the same version with another build number: a micro-update) and every client name the recorder
            hooks is in its bytecode (tools/inspect_hook_names.py, rule W7). No client or no game Python: SKIP
  version   VERSION equal in exporter.py and mod_local_armor_inspector.py; CHANGELOG.md has its section and no
            heading twice
  pytest    tests/test_*.py under CPython 3 (the exporter, the records, the page channel, the recorder on stubs)
  node      tests/*.cjs: ballistics against the client's functions, shot context, page channel, compact data reader,
            tools/verdicts_offline.cjs end to end on a synthetic folder (it was dead from 28.09 to 04.10, unnoticed)
  page      tests/page/*: aim3_dom (app.js on a stub DOM: wiring, emulation, Config, the path matrix with painter
            counts), tooltips_dom, gs_page, viewer_batch (the real viewer.js + screen-armor.js on a counting fake
            renderer: passes per zoom/distance notch, shot range, camera reports, picking), ttx_samples and ttx_accept
            (the panel against the client's own strings)
  browser   tests/page/real_page.cjs: the REAL page in a local headless Chrome/Edge on synthetic data - the path
            matrix on the rendered DOM and a leak counter over 50 scene switches; tests/page/real_scene.cjs: the real
            page on the user's own battles (local fixtures: the swap's two sides and the shooter row; the first view of a
            shot fired point-blank); tests/page/gpu_bounce.cjs: the real
            screen-armor.js composite on software WebGL against the CPU walk, pixel by pixel, on the bounced leg
            (coincident plates, both directions), and the composite without the leg and with Soft lighting;
            tests/page/gpu_wheels.cjs: the same for the wheels of a wheeled vehicle (synthetic, and the bench's EBRs);
            tests/page/gpu_prefabs.cjs: the armoured prefabs (the CAV mod. 71's crest, the AS-XX 40 t's containers)
            tests/page/frame_cost.cjs: the emulation's frame cost - the live ring's JS per frame while the cursor and the
            shooter move and at rest, on a heavy model's ray cost, within a budget; its figure the exact integral at rest;
            the Statistics log's pass under an orbit;
            tests/page/stats_pass.cjs: the Statistics log's pass - a battle written once (the mark, a reload), its pace,
            the aim loop alive, what computes a battle again; and the user's battle of 04.10 (a local fixture)
  py27      tests/py27/*.py under the client's own python27.dll (the recorder through two battles, ...)
  installer (only with --installer) tests/installer_cleanup_check.py: a test build of the installer into a fake game

A check that needs something only this machine has (the client's reference figures in tests/fixtures-local/, the
game's python27.dll, a browser) says SKIP, never ok; a skip does not fail the run but is listed.

    python tools/check.py [--verbose] [--no-browser] [--installer] [--only lists,version,...]
"""
import concurrent.futures
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_EXIT = 77
NODE_CANDIDATES = [os.environ.get('BULLBA_NODE'), shutil.which('node'),
                   os.path.expanduser('~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')]


def node():
    return next((p for p in NODE_CANDIDATES if p and os.path.isfile(p)), None)


class Result(object):
    def __init__(self, name):
        self.name, self.passed, self.failed, self.skipped = name, 0, 0, 0
        self.fails, self.skips, self.seconds, self.note = [], [], 0.0, ''

    def fail(self, text):
        self.failed += 1
        self.fails.append(text)

    def skip(self, text):
        self.skipped += 1
        self.skips.append(text)


def read(path):
    with io.open(os.path.join(ROOT, path), encoding='utf-8') as stream:
        return stream.read()


# ---------------------------------------------------------------------------------------------------- lists, version

def exporter_lists():
    """ASSETS, ICON_FILES, CRIT_ICON_FILES and VERSION of the exporter, read without importing the mod package."""
    source = read('mod/local_armor_inspector/exporter.py')
    scope = {}
    for name in ('ICON_FILES', 'CRIT_ICON_FILES', 'ASSETS'):
        match = re.search(r'^%s = .*?(?=^\S)' % name, source, re.M | re.S)
        if not match: raise ValueError('exporter.py: %s not found' % name)
        exec(match.group(0), {}, scope)
    version = re.search(r"^VERSION = '([^']+)'", source, re.M).group(1)
    return scope['ASSETS'], scope['ICON_FILES'], scope['CRIT_ICON_FILES'], version


def check_lists(result):
    assets, icons, crit_icons, _ = exporter_lists()
    listed = set(assets)
    for asset in assets:
        path = 'web/index.html' if asset == 'Viewer.html' else asset
        if asset != 'Viewer.html' and not re.match(r'^(web|licenses)/[A-Za-z0-9_./-]+$', asset):
            result.fail('ASSETS entry malformed (a missing comma joins two names): %r' % asset)
        elif not os.path.isfile(os.path.join(ROOT, path)):
            result.fail('ASSETS entry is not a file: ' + asset)
        else:
            result.passed += 1
    if len(listed) != len(assets): result.fail('ASSETS lists a file twice')
    html = read('web/index.html')
    for ref in re.findall(r'(?:src|href)="(web/[^"?#]+)"', html):
        if ref in listed: result.passed += 1
        else: result.fail('index.html loads %s, ASSETS does not ship it' % ref)
    # Every file of web/ ships, except the page itself (Viewer.html), the mods-list icon (build.py packs it apart)
    # and the icons (compared with their own lists below).
    apart = {'web/index.html', 'web/menu-icon.png'}
    for folder, _, files in os.walk(os.path.join(ROOT, 'web')):
        for name in files:
            rel = os.path.relpath(os.path.join(folder, name), ROOT).replace(os.sep, '/')
            if rel in apart or rel.startswith('web/icons/'): continue
            if rel in listed: result.passed += 1
            else: result.fail('web/ file not in ASSETS (the package would lack it): ' + rel)
    on_disk = set(p.replace(os.sep, '/') for p in glob.glob('web/icons/**/*.png', root_dir=ROOT, recursive=True))
    wanted = set(icons) | set(crit_icons)
    for missing in sorted(wanted - on_disk): result.fail('icon listed but missing: ' + missing)
    for extra in sorted(on_disk - wanted): result.fail('icon on disk but not listed (would not ship): ' + extra)
    result.passed += len(wanted & on_disk)
    # The crit icons have one list: tools/extract_crit_icons.py writes exactly what CRIT_ICON_FILES ships (25.09).
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    import extract_crit_icons
    extracted = extract_crit_icons.outputs()
    if sorted(extracted) == sorted(crit_icons) and len(set(extracted)) == len(extracted): result.passed += 1
    else: result.fail('tools/extract_crit_icons.py writes other files than CRIT_ICON_FILES: only extracted %s; only listed %s'
                      % (sorted(set(extracted) - set(crit_icons)), sorted(set(crit_icons) - set(extracted))))
    names = set(os.path.basename(p)[:-4] for p in icons)
    for icon in sorted(set(re.findall(r'"icon":\s*"([^"]+)"', read('web/equipment.js')))):
        if icon in names: result.passed += 1
        else: result.fail('web/equipment.js names icon %s, ICON_FILES lacks it' % icon)
    # The emulation's sounds are the mod Bullba Countdown's own samples (08.10): web/aim-sound-samples.js is what that
    # project's synthesis renders now, byte for byte. The other project is local to this machine: absent, SKIP.
    import build_aim_sounds
    if not build_aim_sounds.available():
        result.skip('lists: Bullba Countdown is not at %s - web/aim-sound-samples.js not compared with its samples' % build_aim_sounds.COUNTDOWN)
    elif build_aim_sounds.text() == io.open(build_aim_sounds.TARGET, encoding='utf-8', newline='').read(): result.passed += 1
    else: result.fail('web/aim-sound-samples.js is not what Bullba Countdown renders now: run tools/build_aim_sounds.py')


def check_version(result):
    _, _, _, version = exporter_lists()
    recorder = re.search(r"^VERSION = '([^']+)'", read('mod/mod_local_armor_inspector.py'), re.M).group(1)
    if recorder == version: result.passed += 1
    else: result.fail('VERSION differs: exporter.py %s, mod_local_armor_inspector.py %s' % (version, recorder))
    headings = re.findall(r'^## (.+?)\s*$', read('CHANGELOG.md'), re.M)
    if any(h == version or h.startswith(version + ' ') for h in headings): result.passed += 1
    else: result.fail('CHANGELOG.md has no section "## %s"' % version)
    seen = set()
    for heading in headings:
        key = heading.split(' ')[0]
        if key in seen: result.fail('CHANGELOG.md has the section "## %s" twice' % heading)
        seen.add(key)
    result.passed += 1
    result.note = version


# ---------------------------------------------------------------------------------------------------- processes

def run(args, timeout=600, env=None):
    started = time.time()
    try:
        done = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=timeout,
                              env=dict(os.environ, **(env or {})), encoding='utf-8', errors='replace')
        return done.returncode, (done.stdout or '') + (done.stderr or ''), time.time() - started
    except subprocess.TimeoutExpired as e:
        return -1, (e.stdout or '') + '\nTIMEOUT after %ds' % timeout, time.time() - started


def tail(text, lines=6):
    return ' | '.join(l.strip() for l in text.strip().splitlines()[-lines:])


def check_pytest(result):
    code, out, _ = run([sys.executable, '-m', 'pytest', 'tests', '-q', '-p', 'no:cacheprovider', '-o', 'console_output_style=classic'])
    summary = re.search(r'(\d+) passed', out)
    result.passed = int(summary.group(1)) if summary else 0
    for line in out.splitlines():
        if line.startswith(('FAILED ', 'ERROR ')): result.fail(line)
    skipped = re.search(r'(\d+) skipped', out)
    if skipped: result.skip('%s pytest tests skipped' % skipped.group(1))
    if code not in (0, 5) and not result.fails: result.fail('pytest exit %s: %s' % (code, tail(out)))


def harness_lines(result, name, code, out):
    """A harness prints `ok   ...`, `FAIL ...` and `SKIP ...` lines; the exit code has the last word."""
    oks = sum(1 for l in out.splitlines() if l.startswith('ok'))
    fails = [l for l in out.splitlines() if l.startswith('FAIL')]
    for line in out.splitlines():
        if line.startswith('SKIP'): result.skip(name + ': ' + line[4:].strip())
    for line in fails: result.fail(name + ': ' + line[4:].strip())
    if code == SKIP_EXIT and not fails:
        if not any(l.startswith('SKIP') for l in out.splitlines()): result.skip(name + ': ' + tail(out, 2))
        return
    if code != 0 and not fails: result.fail('%s exit %s: %s' % (name, code, tail(out)))
    result.passed += max(oks, 1 if code == 0 else 0)


def check_node(result):
    exe = node()
    if not exe: return result.fail('node not found: set BULLBA_NODE to node.exe')
    for test in sorted(glob.glob('tests/*.cjs', root_dir=ROOT)):
        code, out, _ = run([exe, test.replace(os.sep, '/')])
        harness_lines(result, os.path.basename(test), code, out)


def check_page(result):
    exe = node()
    if not exe: return result.fail('node not found: set BULLBA_NODE to node.exe')
    for name in ('aim3_dom', 'tooltips_dom', 'gs_page', 'viewer_batch'):
        code, out, _ = run([exe, 'tests/page/%s.cjs' % name])
        harness_lines(result, name, code, out)
    local = os.path.join(ROOT, 'tests', 'fixtures-local')
    ttx = os.path.join(local, 'ttx-offline', 'out', 'mod', 'ttx')
    ref = os.path.join(local, 'ttx-reference', 'ttx_reference.json')
    if not os.path.isdir(ttx) or not os.path.isfile(ref):
        result.skip('ttx_samples, ttx_accept: the client-extracted characteristics are not on this machine (tests/fixtures-local/ttx-*)')
        return
    code, out, _ = run([exe, 'tests/page/ttx_samples.cjs'])
    harness_lines(result, 'ttx_samples', code, out)
    code, out, _ = run([exe, 'tests/page/ttx_accept.cjs', ref, ttx + os.sep])
    rows = re.search(r'rows (\d+), mismatches (\d+)', out)
    if code == 0 and rows and rows.group(2) == '0': result.passed += int(rows.group(1))
    else: result.fail('ttx_accept: ' + tail(out, 4))
    # The tier-XI vehicles with their whole skill tree (09.10, D-112): the page's strings from the files the mod's ttx_block
    # writes for them against the garage's with the tree researched (tools/ttx_reference.py), every vehicle that has one. The
    # rows that mismatch on the bare vehicle too - one mode printed of two - are listed with their reason (known.json).
    xi, xi_ref = os.path.join(local, 'ttx-offline', 'out', 'mod', 'ttx-xi'), os.path.join(local, 'ttx-reference', 'xi')
    if not os.path.isdir(xi) or not os.path.isfile(os.path.join(xi_ref, 'ttx_reference.json')):
        result.skip('ttx_accept, the skill trees: the tier-XI characteristics are not on this machine (tests/fixtures-local/ttx-*/xi)')
        return
    command = [exe, 'tests/page/ttx_accept.cjs', os.path.join(xi_ref, 'ttx_reference.json'), xi + os.sep]
    if os.path.isfile(os.path.join(xi_ref, 'known.json')): command += ['--known', os.path.join(xi_ref, 'known.json')]
    code, out, _ = run(command)
    rows = re.search(r'rows (\d+), mismatches (\d+)(?:, known (\d+))?', out)
    if code == 0 and rows and rows.group(2) == '0': result.passed += int(rows.group(1)) - int(rows.group(3) or 0)
    else: result.fail('ttx_accept, the skill trees: ' + tail(out, 4))


def check_browser(result):
    exe = node()
    if not exe: return result.fail('node not found: set BULLBA_NODE to node.exe')
    code, out, _ = run([exe, 'tests/page/real_page.cjs'], timeout=480)   # ~3 min alone since the inheritance matrix (03.10)
    harness_lines(result, 'real_page', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = int(total.group(1)) - int(total.group(2))
    leak = re.search(r'leak counter .*', out)
    if leak: result.note = leak.group(0)[:160]
    # The user's own battles of 04.10 (rule B17): the swap's two sides and the shooter row, and the first view of his shots
    # fired point-blank, on his real records. The fixtures are local (tests/fixtures-local/scene-state-2026-10-04,
    # close-range-2026-10-04): one that is absent says SKIP.
    code, out, _ = run([exe, 'tests/page/real_scene.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'real_scene', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))
    code, out, _ = run([exe, 'tests/page/gpu_bounce.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'gpu_bounce', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))
    # The wheels of a wheeled vehicle on the CPU walk and the GPU map (BACKLOG 39, 26.09): the same pattern.
    code, out, _ = run([exe, 'tests/page/gpu_wheels.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'gpu_wheels', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))
    # The armoured prefabs (27.09): the scene, the pose read back, the contact and CPU = GPU on the crest and the containers.
    code, out, _ = run([exe, 'tests/page/gpu_prefabs.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'gpu_prefabs', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))
    # The emulation's frame cost (27.09): the ring's JS per frame on a heavy model's ray cost, and its figure exact at rest.
    code, out, _ = run([exe, 'tests/page/frame_cost.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'frame_cost', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))
    # The Statistics log's pass (04.10): written once, its pace, no waiting for the user; and the user's own battle of
    # 04.10 (tests/fixtures-local/stats-log-2026-10-04: absent, that part of the test says SKIP).
    code, out, _ = run([exe, 'tests/page/stats_pass.cjs'], timeout=300)
    passed = result.passed
    harness_lines(result, 'stats_pass', code, out)
    total = re.search(r'(\d+) checks, (\d+) failed', out)
    if total: result.passed = passed + int(total.group(1)) - int(total.group(2))


def check_py27(result):
    scripts = [p for p in sorted(glob.glob('tests/py27/*.py', root_dir=ROOT)) if os.path.basename(p) != 'run27.py']
    for script in scripts:
        code, out, _ = run([sys.executable, 'tests/py27/run27.py', script.replace(os.sep, '/')], timeout=120)
        name = os.path.basename(script)
        if code == SKIP_EXIT:
            result.skip(name + ': ' + tail(out, 1))
            continue
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith('FAIL')]
        counts = re.search(r'(\d+) checks, (\d+) failed', out)
        if counts: result.passed += int(counts.group(1)) - int(counts.group(2))
        for line in fails: result.fail(name + ': ' + line[4:].strip(' :'))
        if code != 0 and not fails: result.fail('%s exit %s: %s' % (name, code, tail(out)))
        elif code == 0 and not counts: result.passed += max(1, sum(1 for l in out.splitlines() if l.startswith('ok')))


def check_client(result):
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    import client_version
    found = client_version.installed()
    if found is None:
        return result.skip('client: no client at %s' % client_version.GAME)
    problem = client_version.problem(found=found)
    if problem: result.fail('client: ' + problem)
    else: result.passed += 1
    result.note = '%s %s' % (found[1], found[0])
    if not os.path.isdir(os.path.join(ROOT, 'work', 'game-python27')):
        return result.skip('client: no work/game-python27 to read the bytecode with (hooked names not looked up)')
    code, out, _ = run([sys.executable, 'tools/inspect_hook_names.py'], timeout=300)
    names = len(re.findall(r"^\('ok     '", out, re.M))
    if code != 0 or 'MISSING' in out or not names:
        result.fail('client: hooked names: %s' % tail(out))
    else: result.passed += names


def check_installer(result):
    code, out, _ = run([sys.executable, 'tests/installer_cleanup_check.py'], timeout=600)
    harness_lines(result, 'installer_cleanup_check', code, out)


SUITES = [('lists', check_lists), ('client', check_client), ('version', check_version), ('pytest', check_pytest), ('node', check_node),
          ('page', check_page), ('browser', check_browser), ('py27', check_py27), ('installer', check_installer)]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    verbose = '--verbose' in argv
    only = None
    if '--only' in argv: only = set(argv[argv.index('--only') + 1].split(','))
    chosen = [s for s in SUITES if (only is None or s[0] in only)
              and not (s[0] == 'browser' and '--no-browser' in argv)
              and not (s[0] == 'installer' and '--installer' not in argv and not (only and 'installer' in only))]
    started = time.time()

    def one(suite):
        result = Result(suite[0])
        t0 = time.time()
        try: suite[1](result)
        except Exception as e: result.fail('%s crashed: %s: %s' % (suite[0], type(e).__name__, e))
        result.seconds = time.time() - t0
        return result

    # The browser run is the long one: everything runs side by side, the order of the report is fixed.
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chosen) or 1) as pool:
        results = list(pool.map(one, chosen))
    failed = sum(r.failed for r in results)
    lines = []
    for r in results:
        state = 'FAIL' if r.failed else ('ok  ' if r.passed else 'SKIP')
        lines.append('%s %-9s %5d passed%s%s  %5.1f s%s' % (state, r.name, r.passed, ', %d failed' % r.failed if r.failed else '',
                     ', %d skipped' % r.skipped if r.skipped else '', r.seconds, '  ' + r.note if r.note else ''))
        for text in r.fails[:25 if not verbose else None]: lines.append('       FAIL ' + text)
        if len(r.fails) > 25 and not verbose: lines.append('       ... %d more (--verbose)' % (len(r.fails) - 25))
        for text in r.skips: lines.append('       SKIP ' + text)
    print('\n'.join(lines))
    print('check: %d suites, %d passed, %d failed, %d skipped, %.0f s -> %s' % (
        len(results), sum(r.passed for r in results), failed, sum(r.skipped for r in results), time.time() - started,
        'RED' if failed else 'GREEN'))
    summary = {'green': not failed, 'failed': failed, 'suites': {r.name: {'passed': r.passed, 'failed': r.failed, 'skipped': r.skipped} for r in results}}
    return (1 if failed else 0), summary


if __name__ == '__main__':
    sys.exit(main()[0])
