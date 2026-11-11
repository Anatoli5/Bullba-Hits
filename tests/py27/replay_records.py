# -*- coding: utf-8 -*-
"""Replay events -> records in the recorder's schema (replay_records.py) under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/replay_records.py

The mod runs the conversion under the client's python27; the parity with the live records was measured under CPython 3
(tests/test_replay_records.py, outputs/replay-records-parity-2026-11-10.md). This script converts the same local fixtures
here - the four battles with a live record, the two October kill-cam battles, the 10.11 raw in-battle stream and the
01.11 decoded events - and compares an md5 over every record and the count per record kind with the table
tests/fixtures-local/replay-parity-2026-11-10/records-digest.json, which `python tests/test_replay_records.py --write`
writes from CPython 3. Same table = the same records under both Pythons. Also the synthetic battle of the CPython test,
checked by its own expectations. Fixtures and table are local (replays carry nicknames): absent -> SKIP (exit 77).
"""
import json
import os
import sys
import time
import traceback

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.path.insert(0, os.path.join(REPO, 'tests'))
RESULT = os.environ.get('BULLBA_PY27_RESULT')


def finish(code, lines):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream:
            stream.write(text.encode('utf-8') if not isinstance(text, bytes) else text)
    else:
        sys.stdout.write(text)


def synthetic_checks(t, rr):
    """The rules of the conversion on the synthetic battle, without any fixture."""
    out, stats = rr.convert(t.synthetic(), vehicle_names={(5, 104):'uk:Test', (1, 2):'germany:Bot'})
    fails = []
    head = out[0]
    if (head['type'], head['source'], head['arenaId'], head['playerVehicleId']) != ('battle', 'replay', '555', 10):
        fails.append('header %r' % head)
    health = [(h['attackReasonId'], h['newHealth']) for h in t.of(out, 'crit', 'health')]
    if health != [(1, 480), (2, 400), (2, 1900)]: fails.append('health %r' % health)
    stops = [(s['shotId'], s['segmentDistance']) for s in t.of(out, 'shot', 'stop')]
    if stops != [('77', 5.0)]: fails.append('stops %r' % stops)
    contact = [(c['pair'], c['at']) for c in t.of(out, 'crit', 'collision')]
    if contact != [([10, 20], 1005.0)]: fails.append('contact %r' % contact)
    from local_armor_inspector import damage_log
    events = damage_log.damage_log(t.of(out, 'hit'), t.of(out, 'crit'), t.of(out, 'roster')[-1]['vehicles'])[0]
    got = sorted((e['kind'], e['targetId'], e['damage']) for e in events)
    if got != [('fire', 20, 30), ('ram', 10, 50), ('ram', 20, 80)]: fails.append('damage events %r' % got)
    return fails


def main():
    import test_replay_records as t
    from local_armor_inspector import replay_records as rr
    lines = ['python %s' % sys.version.split()[0]]
    fails = synthetic_checks(t, rr)
    lines.append('synthetic battle: %d failed checks' % len(fails))
    lines.extend('FAIL synthetic ' + f for f in fails)
    if not t.client_ready() or not os.path.isfile(t.TABLE):
        lines.append('SKIP fixtures: the client or %s absent' % t.TABLE)
        return (1 if fails else 77), lines
    with open(t.TABLE, 'rb') as stream:
        table = json.loads(stream.read().decode('utf-8'))
    t0 = time.clock()
    t.defs()
    lines.append('definitions %.2f s' % (time.clock() - t0))
    t0 = time.clock()
    got = json.loads(json.dumps(t.digests()))
    lines.append('decode + convert + digest of %d fixtures %.2f s' % (len(got), time.clock() - t0))
    bad = []
    for name in sorted(set(table) | set(got)):
        if table.get(name) != got.get(name):
            bad.append('%s: table %s, now %s' % (name, json.dumps(table.get(name), sort_keys=True),
                                                 json.dumps(got.get(name), sort_keys=True)))
    lines.extend('DIFF ' + b for b in bad)
    lines.append('%d fixtures, %d differ from the CPython 3 table' % (len(got), len(bad)))
    return (1 if bad or fails else 0), lines


try:
    code, lines = main()
except Exception:
    code, lines = 1, ['FAIL: ' + traceback.format_exc()]
finish(code, lines)
