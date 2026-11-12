# -*- coding: utf-8 -*-
"""The recorder's two snapshots in a battle whose replay is confirmed (BACKLOG 87), on the consumer's side (CPython 3).

    python -m pytest tests/test_recorder_scope.py -q

  rule        mod_local_armor_inspector.recording_scope: each condition (mode id and name, the client, the recording)
              and the client it names is tools/client_version.py's
  build       replay_battle.build with a live record cut to the snapshots: the matched hits and own shots keep the live
              snapshot; the other records get their receipt time from the battle's wall clock; a full battle is as before
  four        the four local battles with both sources (fixtures of test_replay_battle): the replay-made battle published
              from the full live record and from the same record cut to what the recorder now writes - the same but for
              the ids of the records the live record no longer has (and what names them), their receipt times (within
              0.05 s for all but at most 1 of each battle), the hits' trace candidates, another vehicle's gun state at
              his shot (the replay's tracer has none; the page then takes the state at impact) and the report's counts
  fallback    a snapshots-only live record whose replay cannot be used is published and listed from what it has

The recorder's own side (what it writes, what it no longer reads) runs under the client's Python 2.7:
tests/py27/recorder_snapshots.py.
"""
import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, HERE)
import mod_local_armor_inspector as m  # noqa: E402
from local_armor_inspector import replay_battle as rb  # noqa: E402

CHECKED = '<version.xml>\r\n\t<version> v.2.4.1.1 #992 </version>\r\n</version.xml>'
RANDOM = {'read':True, 'bonusType':1, 'bonusTypeName':'REGULAR', 'guiType':1}


def snapshot_record(row):
    """What the recorder writes in a snapshots-only battle, of one record of a full one (None: not written)."""
    kind, event = row.get('type'), row.get('event')
    if kind == 'battle': return dict(row, recording=m.RECORDING_SNAPSHOTS)
    if kind in ('hit', 'roster'): return row
    if kind == 'shot' and (event in ('command', 'gunAfterShot') or (event == 'tracer' and row.get('own'))): return row
    return None


def cut_file(source, target):
    """The raw file a snapshots-only battle would have written: its kept lines byte for byte, the header marked."""
    with open(source, 'rb') as src, open(target, 'wb') as dst:
        for line in src:
            row = snapshot_record(json.loads(line.decode('utf-8')))
            if row is None: continue
            dst.write(json.dumps(row).encode('utf-8') + b'\n' if row.get('type') == 'battle' else line)


class RuleTests(unittest.TestCase):
    def test_the_three_conditions(self):
        self.assertEqual(m.recording_scope(RANDOM, CHECKED, True)[0], True)
        for mode in (dict(RANDOM, bonusType=2, bonusTypeName='TRAINING'), dict(RANDOM, bonusType=14, bonusTypeName='TOURNAMENT_REGULAR')):
            self.assertTrue(m.recording_scope(mode, CHECKED, True)[0], mode)
        cases = ((dict(RANDOM, bonusType=99, bonusTypeName='EVENT'), CHECKED, True, 'mode EVENT (bonusType 99)'),
                 (dict(RANDOM, bonusTypeName='TRAINING'), CHECKED, True, 'mode TRAINING (bonusType 1)'),   # id and name disagree
                 ({'read':False, 'error':'Battle mode unavailable'}, CHECKED, True, 'mode None'),
                 (None, CHECKED, True, 'mode None'),
                 (RANDOM, CHECKED.replace('#992', '#993'), True, 'client v.2.4.1.1 #993'),
                 (RANDOM, 'unknown', True, 'client None'),
                 (RANDOM, CHECKED, False, 'no replay recording'),
                 (RANDOM, CHECKED, None, 'no replay recording'),
                 (RANDOM, CHECKED, 'no replay source', 'no replay recording'))
        for mode, version, recording, why in cases:
            reduced, text = m.recording_scope(mode, version, recording)
            self.assertFalse(reduced, (mode, version, recording))
            self.assertTrue(text.startswith(why), (text, why))

    def test_the_client_is_the_one_the_build_tools_name(self):
        import client_version
        self.assertEqual(m.REPLAY_CONFIRMED_CLIENT, client_version.VERSION_XML)
        self.assertEqual(m.client_build(CHECKED), 'v.2.4.1.1 #992')

    def test_the_header_mark_is_the_one_build_reads(self):
        self.assertEqual(m.RECORDING_SNAPSHOTS, rb.SNAPSHOTS)


class CostTests(unittest.TestCase):
    """The recorder's per-battle cost line (telemetry.Cost, Recorder.log_cost); the hooks that feed it run under the
    client's Python in tests/py27/recorder_snapshots.py."""

    def logged(self, recorder, arena_id):
        import logging
        records = []
        handler = logging.Handler()
        handler.emit = records.append
        logger = logging.getLogger('local.armor_inspector')
        logger.addHandler(handler)
        level, logger.level = logger.level, logging.INFO
        try: m.Recorder.log_cost(recorder, arena_id)
        finally:
            logger.removeHandler(handler)
            logger.level = level
        return [r.getMessage() for r in records]

    def test_the_line_counts_totals_and_longest_per_group(self):
        from local_armor_inspector import telemetry as t
        cost = t.Cost()
        for group, seconds in ((t.HIT, 0.002), (t.HIT, 0.004), (t.OWN, 0.0001), (t.SAMPLER, 0.0005), (t.SAMPLER, 0.0003)):
            cost.add(group, seconds)
        cost.started -= 360.0
        stand = type('Stand', (), {})()
        stand.cost, stand.cost_scope, stand.scope = cost, None, ('77', True, 'mode REGULAR')
        lines = self.logged(stand, '77')
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertTrue(line.startswith('recorder: cost in this battle (snapshots only, battle 77): '), line)
        for part in ('hit snapshots 2, total 0.006 s, longest 4.00 ms', 'own shot hooks 1, total 0.000 s, longest 0.10 ms',
                     'other hooks 0, total 0.000 s, longest 0.00 ms', 'roster events 0,',
                     'sampler ticks 2, total 0.001 s, longest 0.50 ms', 'game thread total 0.007 s', 'battle length 360 s'):
            self.assertIn(part, line)
        # A battle no record path asked about (a replay played): the scope of the battle before is not claimed.
        stand.cost_scope = stand.scope
        self.assertIn('(not recorded)', self.logged(stand, '78')[0])
        self.assertIn('(snapshots only, battle 77)', self.logged(stand, '77')[0])   # the same battle entered again
        stand.scope, stand.cost_scope = ('79', False, 'client'), None
        self.assertIn('(full, battle 79)', self.logged(stand, None)[0])


def synthetic():
    import test_replay_battle as tb
    replay, live = tb.synthetic_pair()
    shots = [r for r in replay if r['type'] == 'shot']
    crits = [r for r in replay if r['type'] == 'crit']
    return replay, live, shots, crits


class BuildTests(unittest.TestCase):
    def test_snapshots_only_records_get_the_wall_clock_and_a_full_battle_none(self):
        replay, live, shots, crits = synthetic()
        full, report = rb.build(replay, live)
        self.assertNotIn('wallClock', report)
        self.assertFalse(any('receivedAt' in c for c in full['critEvents']))
        battle, report = rb.build(replay, dict(live, recording=rb.SNAPSHOTS))
        # Matched: the hit (live 5000.0 at replay gameTime g) and the own tracer (4999.0): one wall offset.
        hit = [r for r in replay if r['type'] == 'hit'][0]
        wall = round(5000.0 - hit['gameTime'], 3)
        self.assertAlmostEqual(report['wallClock'], wall, places=3)
        self.assertEqual(report['liveRecording'], rb.SNAPSHOTS)
        self.assertEqual(battle['recording'], rb.SNAPSHOTS)
        for c in battle['critEvents']:
            self.assertAlmostEqual(c['receivedAt'], c['gameTime'] + report['wallClock'])
        ends = [s for s in battle['shotEvents'] if s.get('event') in ('stop', 'explosion')]
        self.assertTrue(ends and all(abs(s['receivedAt'] - (s['gameTime'] + report['wallClock'])) < 1e-9 for s in ends))
        tracer = [s for s in battle['shotEvents'] if s.get('event') == 'tracer'][0]
        self.assertEqual((tracer['id'], tracer['receivedAt']), ('s1', 4999.0))   # the live snapshot's own
        self.assertEqual(report['receivedAtFromReplay'], len(battle['critEvents']) + len(ends))
        # Everything else is the full battle's.
        strip = lambda b: dict((k, v) for k, v in b.items() if k not in ('critEvents', 'shotEvents', 'replay', 'recording'))
        self.assertEqual(strip(battle), strip(full))


def fixtures_ready():
    try:
        import test_replay_battle as tb
        return tb.fixtures_ready()
    except Exception:
        return False


TOLERANCE = 0.05


def keyed(rows, key):
    out = {}
    for r in rows or (): out.setdefault(key(r), []).append(r)
    return out


def shot_key(r):
    return (r.get('event'), r.get('shotId') if r.get('event') in rb.SHOT_KINDS else r.get('id'))


def differences(full, cut):
    """{what: count} between the two published battles; receipt times within TOLERANCE are counted apart."""
    out = {}
    def add(k): out[k] = out.get(k, 0) + 1
    def walk(a, b, path):
        if isinstance(a, dict) and isinstance(b, dict):
            for k in set(a) | set(b): walk(a.get(k), b.get(k), path + '.' + str(k))
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for x, y in zip(a, b): walk(x, y, path + '[]')
        elif a != b:
            if path.endswith('receivedAt') and isinstance(a, float) and isinstance(b, float):
                add(path + (' within' if abs(a - b) <= TOLERANCE else ' beyond'))
            else: add(path)
    a, b = keyed(full.get('shotEvents'), shot_key), keyed(cut.get('shotEvents'), shot_key)
    for k in set(a) | set(b):
        if len(a.get(k, ())) != len(b.get(k, ())): add('shotEvents count ' + str(k[0]))
        else:
            for x, y in zip(a[k], b[k]): walk(x, y, 'shot')
    rest = lambda d: dict((k, v) for k, v in d.items() if k != 'shotEvents')
    walk(rest(full), rest(cut), '')
    return out


# What may differ: the ids of the records the live record no longer has and what names them, their receipt time, the
# hits' trace candidates, another vehicle's state at his shot, the header's mark and the report's counts.
ALLOWED = set(['shot.id', 'shot.tracerId', 'shot.gunState', 'shot.siegeState', 'shot.receivedAt within', 'shot.receivedAt beyond',
               '.hits[].traceCandidates', '.hits[].crits.items[].event', '.damageEvents[].id', '.damageEvents[].collision',
               '.damageEvents[].receivedAt within', '.recording'])


@unittest.skipUnless(fixtures_ready(), 'local replay and live-record fixtures, the client or the names table are absent')
class FourBattlesTests(unittest.TestCase):
    def test_published_from_the_snapshots_as_from_the_full_record(self):
        import test_replay_battle as tb
        import test_replay_records as t
        folder = tempfile.mkdtemp()
        try:
            for name, arena, source_folder in tb.FOUR:
                records = tb.convert(name, source_folder, tb.table_names(name))
                source = t.live_path(arena)
                cut = os.path.join(folder, os.path.basename(source))
                cut_file(source, cut)
                full = self.published(source, copy.deepcopy(records))
                reduced = self.published(cut, copy.deepcopy(records))
                d = differences(full, reduced)
                other = dict((k, v) for k, v in d.items() if k not in ALLOWED and not k.startswith('.replay.'))
                self.assertEqual(other, {}, name)
                self.assertLessEqual(d.get('shot.receivedAt beyond', 0), 1, (name, d))
                self.assertEqual((len(full['hits']), len(reduced['hits'])), (len(full['hits']),) * 2)
                self.assertEqual(full['damageCheck'], reduced['damageCheck'], name)
                self.assertEqual(reduced['replay']['liveRecording'], rb.SNAPSHOTS)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    @staticmethod
    def published(source, records):
        import test_replay_battle as tb
        from local_armor_inspector.exporter import read_data_file
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, 'battles'))
            name = os.path.basename(source)[:-6]
            shutil.copyfile(source, os.path.join(root, 'battles', name + '.jsonl'))
            tb.exporter(root).publish_replay(name, records)
            return read_data_file(os.path.join(root, 'data', 'battles', name + '.js'))
        finally:
            shutil.rmtree(root, ignore_errors=True)


def live_fixture():
    import test_replay_records as t
    for name, arena in t.BATTLES:
        path = t.live_path(arena)
        if path: return path
    return None


@unittest.skipUnless(live_fixture(), 'no local live record')
class FallbackTests(unittest.TestCase):
    def test_a_snapshots_only_battle_without_its_replay_is_published_and_listed(self):
        import test_replay_battle as tb
        from local_armor_inspector.exporter import read_data_file
        source = live_fixture()
        name = os.path.basename(source)[:-6]
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, 'battles'))
            cut_file(source, os.path.join(root, 'battles', name + '.jsonl'))
            e = tb.exporter(root)
            e.publishing_final = True
            e.republish_saved(name)
            battle = read_data_file(os.path.join(root, 'data', 'battles', name + '.js'))
            e.write_index()
            index = read_data_file(os.path.join(root, 'data', 'index.js'))
            with open(source, 'rb') as stream:
                hits = sum(1 for line in stream if b'"type": "hit"' in line or b'"type":"hit"' in line)
            self.assertEqual(len(battle['hits']), hits)
            self.assertEqual(battle['recording'], rb.SNAPSHOTS)
            self.assertTrue(all(s.get('event') in ('command', 'tracer', 'gunAfterShot') for s in battle.get('shotEvents') or ()))
            listed = json.dumps(index)
            self.assertIn(name, listed)
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
