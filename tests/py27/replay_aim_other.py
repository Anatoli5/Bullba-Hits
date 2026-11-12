# -*- coding: utf-8 -*-
"""Another vehicle's estimated aim circle (replay_aim_other.py, BACKLOG 82) inside the client's own Python 2.7 and items.

    python tests/py27/run27.py tests/py27/replay_aim_other.py            the check
    python tests/py27/run27.py tests/py27/replay_aim_other.py update     write the guns table of the 11.11 battles

On the offline stand of the client's items package (tests/fixtures-local/ttx-offline) the mod's own
exporter.aim_estimate_inputs reads every vehicle's descriptor of the battles of 11.11.2026 (their compact descriptors from
the kept CFG/replay/<id>.records.z, read-only) into GUNS, the table tests/test_replay_aim_other.py and
tests/replay_aim_other_table.py (CPython 3, no client modules) take a vehicle's gun from.

The check: the stand's inputs of a few descriptors equal the table; the estimate of the battle tests/replay_aim_other_table.py
wrote with --fixture (its inputs: every shooter's track and tracers; its result: each block's numbers) made again under
this Python gives the same blocks; the work per battle under Python 2.7 and its longest step are printed. The local
fixtures, the client or the stand absent: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, os, sys, time, traceback, zlib
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
CFG = os.path.join(GAME, 'mods', 'configs', 'local.armor_inspector')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
FIXTURES = os.path.join(REPO, 'tests', 'fixtures-local', 'replay-aim-other-2026-11-12')
GUNS = os.path.join(FIXTURES, 'guns.json')
BATTLE = os.path.join(FIXTURES, 'battle.json')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
UPDATE = 'update' in sys.argv[1:]
DAY = '2026-11-11'
lines, failures = [], []


def finish(code):
    body = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(body.encode('utf-8') if not isinstance(body, bytes) else body)
    else:
        sys.stdout.write(body)


def check(ok, label, detail=''):
    lines.append(('ok   ' if ok else 'FAIL ') + label + ('' if ok or not detail else ' - ' + detail))
    if not ok: failures.append(label)


def plain(value):
    return json.loads(json.dumps(value))


def compacts_of_day():
    """Every compact descriptor of the kept replay records whose stream is of DAY (local time of its file)."""
    folder = os.path.join(CFG, 'replay')
    out = set()
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.records.z'): continue
        stream = os.path.join(folder, name[:-len('.records.z')] + '.stream.z')
        if not os.path.isfile(stream) or time.strftime('%Y-%m-%d', time.localtime(os.path.getmtime(stream))) != DAY: continue
        with open(os.path.join(folder, name), 'rb') as f: value = json.loads(zlib.decompress(f.read()))
        for row in (value.get('poses') or {}).get('compact') or ():
            if row[1]: out.add(str(row[1]))
    return sorted(out)


def close(a, b, tol):
    if isinstance(a, dict) and isinstance(b, dict):
        return sorted(a) == sorted(b) and all(close(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        try: return abs(float(a) - float(b)) <= tol * max(1.0, abs(float(b)))
        except (TypeError, ValueError): return False
    return a == b


def main():
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    if not os.path.isfile(os.path.join(STAND, 'boot27.py')) or not os.path.isdir(os.path.join(CFG, 'replay')):
        lines.append('SKIP: the offline stand or the local replay records are absent')
        return 77
    saved = sys.stdout, sys.stderr
    try:
        import imp
        stand = sys.modules['ttx_stand'] = imp.new_module('ttx_stand')
        execfile(os.path.join(STAND, 'boot27.py'), stand.__dict__)
        stand.__dict__['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        lines.append('SKIP: the stand did not boot on this client:\n' + traceback.format_exc())
        return 77
    sys.stdout, sys.stderr = saved
    import logging
    logging.getLogger('local.armor_inspector').addHandler(logging.NullHandler())
    from local_armor_inspector import exporter, replay_aim_other as ro

    def inputs(compact):
        return plain(exporter.aim_estimate_inputs(exporter.vehicle_descr(compact)))

    if UPDATE:
        compacts = compacts_of_day()
        table, bad = {}, []
        for compact in compacts:
            try: table[compact] = inputs(compact)
            except Exception as exc: bad.append('%s: %s' % (compact[:16], exc))
        if not os.path.isdir(FIXTURES): os.makedirs(FIXTURES)
        with open(GUNS, 'wb') as f: f.write(json.dumps(table, indent=0, sort_keys=True).encode('utf-8'))
        lines.append('written %s: %d descriptors of %s (%d not read%s)' % (GUNS, len(table), DAY, len(bad),
                                                                         ': ' + '; '.join(bad[:5]) if bad else ''))
        return 0 if table else 1
    if not os.path.isfile(GUNS):
        lines.append('SKIP: %s absent (run with update)' % GUNS)
        return 77
    with open(GUNS, 'rb') as f: table = json.loads(f.read().decode('utf-8'))
    some = sorted(table)[:6]
    got = dict((c, inputs(c)) for c in some)
    check(all(got[c] == table[c] for c in some), 'the stand reads the same guns as the table (%d descriptors)' % len(some),
          repr([(c[:12], got[c], table[c]) for c in some if got[c] != table[c]][:1]))
    # The dispersion formula: aim_step / aim_shot equal to their own definition (ballistics.js on the CPython side).
    aim = {'dispersion':0.0005, 'aimingTime':2.0, 'movementFactor':0.2, 'rotationFactor':0.1, 'turretRotationFactor':0.08,
           'afterShotFactor':4.0}
    ideal, at = ro.aim_ideal(aim, 5.0, 0.2, 0.3, False, ro.TYPICAL)
    want = 0.92 * (1 + 0.81 * ((5 * 0.2) ** 2 + (0.2 * 0.1) ** 2 + (0.3 * 0.08 * 0.925) ** 2)) ** 0.5
    check(abs(ideal - want) < 1e-12 and abs(at - 2.0 * 0.874) < 1e-12, 'the formula of ballistics.js under Python 2.7',
          repr((ideal, want, at)))
    if not os.path.isfile(BATTLE):
        lines.append('SKIP the battle: %s absent (tests/replay_aim_other_table.py --fixture)' % BATTLE)
        return 1 if failures else 0
    with open(BATTLE, 'rb') as f: fixture = json.loads(f.read().decode('utf-8'))
    poses = fixture['poses']
    poses['positions'] = dict((int(k), v) for k, v in poses['positions'].items())
    poses['guns'] = dict((int(k), v) for k, v in poses['guns'].items())
    poses['compact'] = dict((int(k), v) for k, v in poses['compact'].items())
    records = fixture['tracers'] + [poses]
    report, steps, longest = {}, 0, 0.0
    clock = getattr(time, 'clock')
    total = clock()
    started = clock()
    for _ in ro.attaching(records, lambda c: table[c], report):
        took = clock() - started
        longest = max(longest, took)
        steps += 1
        started = clock()
    total = clock() - total
    blocks = dict((r['id'], r[ro.KEY]) for r in fixture['tracers'] if ro.KEY in r)
    want = fixture['blocks']
    same = [k for k in want if k in blocks and close(plain(blocks[k]), want[k], 1e-6)]
    check(len(same) == len(want) == len(blocks), '%s: the %d blocks under Python 2.7 are CPython\'s (%d circles)'
          % (fixture['battle'], len(want), report.get('circles', 0)),
          repr([(k, blocks.get(k), want[k]) for k in want if k not in same][:1]))
    lines.append('%s under Python 2.7: %d other tracers, %d circles; %.2f s of work in %d steps, the longest %.3f s'
                 % (fixture['battle'], report.get('tracers', 0), report.get('circles', 0), total, steps, longest))
    return 1 if failures else 0


try:
    code = main()
except Exception:
    lines.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
    code = 1
lines.append('%d checks, %d failed' % (len([l for l in lines if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
finish(code)
