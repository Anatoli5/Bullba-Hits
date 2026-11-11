# -*- coding: utf-8 -*-
"""A battle published from its replay (replay_battle.py, Exporter.publish_replay) against the same battle published from
its live record today (Exporter.republish_saved), on the local fixtures of the replay-records parity (10.11).

    python -m pytest tests/test_replay_battle.py -q     the checks (CPython 3)
    python tests/test_replay_battle.py --report         every difference, per battle and per published block

The names the live recorder reads from the running client come, for a replay, from replay_records.ClientNames - built
from the client's own modules, so only inside the game or on the offline stand. tests/py27/replay_battle.py runs it there
(the client's Python 2.7 with the ttx-offline stand), checks its names against the live records, and writes every answer
it gave to NAMES_TABLE (`update`); here TableNames answers the same questions from that table, so the conversion below is
the one the game would make. Without the table, the fixtures or the client the fixture checks skip; the synthetic ones
run on a clean clone.
"""
from __future__ import print_function
import collections
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
import test_replay_records as t  # noqa: E402
from local_armor_inspector import replay_records as rr  # noqa: E402
from local_armor_inspector import replay_battle as rb  # noqa: E402

NAMES_TABLE = os.path.join(ROOT, 'tests', 'fixtures-local', 'replay-battle-2026-11-11', 'names.json')
VERSION = 'version\n'
_CACHE = {}


# ---- names ----------------------------------------------------------------------------------------------------------
NAME_METHODS = ('constant', 'extra', 'hit_flags', 'crit_mask', 'ammo_bay_mode', 'short_name')


def name_key(method, args):
    return method + '|' + json.dumps(list(args))


class RecordingNames(rr.Names):
    """Another Names, every answer it gives kept: {key: answer} (tests/py27/replay_battle.py writes them)."""

    def __init__(self, inner):
        self.inner, self.answers = inner, {}
        self.crit_events, self.ram_reason = tuple(inner.crit_events), inner.ram_reason

    def vehicle(self, vehicle_id, compact):
        self.inner.vehicle(vehicle_id, compact)

    def ask(self, method, *args):
        answer = getattr(self.inner, method)(*args)
        self.answers[name_key(method, args)] = answer
        return answer

    def constant(self, table, index): return self.ask('constant', table, index)
    def extra(self, vehicle_id, index): return self.ask('extra', vehicle_id, index)
    def hit_flags(self, flags): return self.ask('hit_flags', flags)
    def crit_mask(self, mask): return self.ask('crit_mask', mask)
    def ammo_bay_mode(self, mode): return self.ask('ammo_bay_mode', mode)
    def short_name(self, type_name): return self.ask('short_name', type_name)

    def table(self):
        return {'critEvents':list(self.crit_events), 'ramReason':self.ram_reason,
                'answers':dict((k, self.answers[k]) for k in sorted(self.answers))}


class TableNames(rr.Names):
    """The answers ClientNames gave for one replay on the client's stand, asked again in the same order."""

    def __init__(self, table):
        self.answers = table['answers']
        self.crit_events, self.ram_reason = tuple(table['critEvents']), table['ramReason']
        self.missed = 0

    def ask(self, method, *args):
        key = name_key(method, args)
        if key not in self.answers:
            self.missed += 1
            return (None, None) if method == 'extra' else None
        answer = self.answers[key]
        return tuple(answer) if method == 'extra' else answer

    def constant(self, table, index): return self.ask('constant', table, index)
    def extra(self, vehicle_id, index): return self.ask('extra', vehicle_id, index)
    def hit_flags(self, flags): return self.ask('hit_flags', flags)
    def crit_mask(self, mask): return self.ask('crit_mask', mask)
    def ammo_bay_mode(self, mode): return self.ask('ammo_bay_mode', mode)
    def short_name(self, type_name): return self.ask('short_name', type_name)


def names_table():
    if 'table' not in _CACHE:
        _CACHE['table'] = None
        if os.path.isfile(NAMES_TABLE):
            with open(NAMES_TABLE, 'rb') as stream: _CACHE['table'] = json.loads(stream.read().decode('utf-8'))
    return _CACHE['table']


# ---- fixtures -------------------------------------------------------------------------------------------------------
FOUR = tuple((name, arena, t.REPLAYS) for name, arena in t.BATTLES)
KILL_CAM = tuple((name, arena, t.LIVE) for name, arena in t.KILL_CAM)


def replay_path(name, folder):
    return os.path.join(folder, name)


def convert(name, folder, names):
    """The replay's records with these names. The decoder's events are fed as it yields them, never kept in a list: an
    event's value may be the decoder's own object, which a later packet changes (a list of events taken first loses the
    damage-info entries - seen 11.11)."""
    d = t.defs()
    blocks, stream = t.rd.read_any(replay_path(name, folder))
    return rr.convert(t.rd.Decoder(d).decode(stream), header=blocks[0] if blocks else None,
                      vehicle_names=t._CACHE['names'], names=names)[0]


def table_names(name):
    table = names_table()
    return TableNames(table[name]) if table and name in table else None


def exporter(root):
    from local_armor_inspector.exporter import Exporter
    return Exporter(root, root, VERSION, os.path.join(root, 'unused.wotmod'))


def published(arena, records=None):
    """The battle file's value: from the live record (records None) or from the replay's records with the live one."""
    from local_armor_inspector.exporter import read_data_file
    root = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(root, 'battles'))
        source = t.live_path(arena)
        name = os.path.basename(source)[:-6]
        shutil.copyfile(source, os.path.join(root, 'battles', name + '.jsonl'))
        e = exporter(root)
        if records is None:
            e.publishing_final = True   # a finished battle, as publish_replay publishes it
            e.republish_saved(name)
        else:
            e.publish_replay(name, records)
        return read_data_file(os.path.join(root, 'data', 'battles', name + '.js'))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def battle_pair(name, arena, folder):
    key = ('pair', name)
    if key not in _CACHE:
        names = table_names(name)
        _CACHE[key] = (published(arena), published(arena, convert(name, folder, names)), names)
    return _CACHE[key]


# ---- comparison -----------------------------------------------------------------------------------------------------
HIT_TIME = ('gameTime',)
SHOT_IGNORED = ('gameTime', 'source')


def diff_fields(a, b, ignored=()):
    """Fields that differ: {field: 'differ' | 'live only' | 'replay only'}."""
    out = {}
    for k in set(a) | set(b):
        if k in ignored: continue
        if k not in b: out[k] = 'live only'
        elif k not in a: out[k] = 'replay only'
        elif a[k] != b[k] and not close(a[k], b[k]): out[k] = 'differ'
    return out


def close(a, b):
    """Two floats one unit in the last place apart (segmentDistance: the client's python27 and the live record give
    ...262, CPython 3 ...263 - MEASURED 10.11): equal here."""
    return (isinstance(a, float) and isinstance(b, float) and abs(a - b) <= 1e-9 * max(1.0, abs(a)))


def count(rows):
    c = collections.Counter()
    for row in rows:
        for k, v in row.items(): c[k + ': ' + v] += 1
    return dict(c)


def crit_view(item):
    """A crit tied to a hit, without its time distance (each source's own clock: equal up to the jitter of 1 ms)."""
    return dict((k, v) for k, v in item.items() if k != 'dt')


def compare(live, replay):
    """Every block of the two published files, as data."""
    out = collections.OrderedDict()
    lh = dict((h['id'], h) for h in live['hits'])
    rh = dict((h['id'], h) for h in replay['hits'])
    matched = [i for i in lh if i in rh]
    scene = [k for k in rr.HIT_ABSENT if k != 'points.resolved'] + ['points']
    out['hits'] = {'live':len(lh), 'replay':len(rh), 'matched':len(matched),
                   'replayOnly':sorted(i for i in rh if i not in lh), 'liveOnly':sorted(i for i in lh if i not in rh),
                   'sceneEqual':sum(1 for i in matched if all(lh[i].get(k) == rh[i].get(k) for k in scene)),
                   'fields':count(diff_fields(lh[i], rh[i], HIT_TIME + ('crits',)) for i in matched)}
    crit_rows = []
    for i in matched:
        a, b = lh[i].get('crits'), rh[i].get('crits')
        if a is None and b is None: continue
        if a is None or b is None:
            crit_rows.append({'block': 'live only' if b is None else 'replay only'})
            continue
        row = diff_fields(a, b, ('items',))
        ai, bi = [crit_view(x) for x in a.get('items') or ()], [crit_view(x) for x in b.get('items') or ()]
        if ai != bi: row['items'] = 'differ'
        crit_rows.append(row)
    out['crits'] = {'hitsWithCrits':sum(1 for i in matched if lh[i].get('crits') or rh[i].get('crits')),
                    'equal':sum(1 for r in crit_rows if not r), 'fields':count(crit_rows),
                    'stats':diff_fields(live.get('critStats') or {}, replay.get('critStats') or {})}
    ekey = lambda e: (e.get('kind'), e.get('targetId'), e.get('attackerId'), e.get('damage'), e.get('ticks'))
    le, re_ = list(live.get('damageEvents') or ()), list(replay.get('damageEvents') or ())
    pool, pairs, lone = list(re_), [], []
    for e in le:
        same = [x for x in pool if ekey(x) == ekey(e)]
        if not same:
            lone.append(ekey(e))
            continue
        pool.remove(same[0])
        pairs.append((e, same[0]))
    out['damageEvents'] = {'live':len(le), 'replay':len(re_), 'matched':len(pairs), 'liveOnly':lone,
                           'replayOnly':[ekey(e) for e in pool],
                           'fields':count(diff_fields(a, b, ('gameTime', 'start', 'end')) for a, b in pairs),
                           'contactLiveOnly':[ekey(a) for a, b in pairs if 'contact' in a and 'contact' not in b]}
    lc, rc = live.get('damageCheck') or {}, replay.get('damageCheck') or {}
    out['damageCheck'] = {'live':dict((k, v) for k, v in lc.items() if k != 'rows'),
                          'replay':dict((k, v) for k, v in rc.items() if k != 'rows'),
                          'rows':count(diff_fields(a, b, ('since', 'at', 'gameTime', 'when', 'from', 'to')) for a, b in zip(lc.get('rows') or (), rc.get('rows') or ()))}
    ls = dict((s['id'], s) for s in live.get('shotEvents') or ())
    rs = dict((s['id'], s) for s in replay.get('shotEvents') or ())
    both = [i for i in ls if i in rs]
    out['shotEvents'] = {'live':len(ls), 'replay':len(rs), 'matched':len(both),
                         'liveOnly':count({ls[i]['event']:'live only'} for i in ls if i not in rs),
                         'replayOnly':count({rs[i]['event']:'replay only'} for i in rs if i not in ls),
                         'fields':count(diff_fields(ls[i], rs[i], SHOT_IGNORED) for i in both),
                         'order':[s['id'] for s in live.get('shotEvents') or () if s['id'] in rs]
                                 == [s['id'] for s in replay.get('shotEvents') or () if s['id'] in ls]}
    lr = dict((r['id'], r) for r in live.get('roster') or ())
    rr_ = dict((r['id'], r) for r in replay.get('roster') or ())
    out['roster'] = {'live':len(lr), 'replay':len(rr_), 'matched':len([i for i in lr if i in rr_]),
                     'fields':count(diff_fields(lr[i], rr_[i]) for i in lr if i in rr_),
                     'maxHealth':[(i, lr[i].get('maxHealth'), rr_[i].get('maxHealth'), lr[i].get('maxHealthFrom'))
                                  for i in lr if i in rr_ and lr[i].get('maxHealth') != rr_[i].get('maxHealth')]}
    out['header'] = diff_fields(dict((k, v) for k, v in live.items() if k not in ('hits', 'shotEvents', 'roster', 'damageEvents', 'damageCheck', 'critStats')),
                                dict((k, v) for k, v in replay.items() if k not in ('hits', 'shotEvents', 'roster', 'damageEvents', 'damageCheck', 'critStats')))
    out['replay'] = replay.get('replay')
    return out


# ---- tests ----------------------------------------------------------------------------------------------------------
def synthetic_pair():
    """The synthetic replay battle of test_replay_records with a live battle that saw only the first hit and the tracer."""
    replay = rr.convert(t.synthetic(), vehicle_names={(5, 104):'uk:Test', (1, 2):'germany:Bot'})[0]
    hits = [r for r in replay if r['type'] == 'hit']
    # A second hit, later: in the death-camera window, so the live battle has none.
    replay.append(dict(hits[0], id=str(len(hits) + 1), damage=77, gameTime=hits[0]['gameTime'] + 5.0))
    shots = [r for r in replay if r['type'] == 'shot']
    live_hit = dict(hits[0], id='1', receivedAt=5000.0, gameTime=hits[0]['gameTime'] - 0.1, warnings=[],
                    target={'parts':[]}, attacker={'parts':[]}, aim=[0.1, 0.2], traceCandidates=['s1'],
                    points=[dict(p, status='resolved', position=[1.0, 2.0, 3.0]) for p in hits[0]['points']])
    for k in ('replayAbsent', 'source'): live_hit.pop(k)
    live_tracer = dict(shots[0], id='s1', receivedAt=4999.0, gameTime=shots[0]['gameTime'] - 0.1,
                       source='received Avatar.showTracer', siegeState=1)
    command = {'schema':1, 'type':'shot', 'event':'command', 'id':'s0', 'receivedAt':4998.0, 'gameTime':1.0}
    live = {'id':'555-abc', 'source':'live', 'clientVersion':VERSION, 'map':'Test', 'playerVehicleId':10,
            'hits':[live_hit], 'shotEvents':[command, live_tracer], 'critEvents':[], 'warnings':[], 'roster':[], 'playerTeam':1}
    return replay, live


class SyntheticTests(unittest.TestCase):
    def setUp(self):
        self.replay, self.live = synthetic_pair()
        self.battle, self.report = rb.build(self.replay, self.live)

    def test_events_are_the_replays_marked_with_their_source(self):
        b = self.battle
        self.assertEqual((b['id'], b['source'], b['map']), ('555-abc', 'replay', 'Test'))
        self.assertEqual(len(b['hits']), len([r for r in self.replay if r['type'] == 'hit']))
        self.assertEqual(len(b['critEvents']), len([r for r in self.replay if r['type'] == 'crit']))
        self.assertEqual(b['roster'], [r for r in self.replay if r['type'] == 'roster'][-1]['vehicles'])

    def test_a_matched_hit_takes_the_live_scene_on_the_replay_clock(self):
        h = self.battle['hits'][0]
        self.assertEqual((h['id'], h['receivedAt'], h['aim'], h['traceCandidates']), ('1', 5000.0, [0.1, 0.2], ['s1']))
        self.assertEqual(h['gameTime'], [r for r in self.replay if r['type'] == 'hit'][0]['gameTime'])
        self.assertEqual(h['points'][0]['status'], 'resolved')
        self.assertNotIn('replayAbsent', h)

    def test_a_hit_the_recorder_did_not_see_is_published_scene_less(self):
        rest = self.battle['hits'][1:]
        self.assertTrue(rest)
        for h in rest:
            self.assertTrue(h['id'].startswith('r'))
            self.assertIn('replayAbsent', h)
            self.assertNotIn('target', h)
            self.assertTrue(all(p['status'] == 'replay-raw' for p in h['points']))
        self.assertEqual(self.report['hitsWithoutScene'], len(rest))
        self.assertTrue(any('have no in-game snapshot' in w for w in self.battle['warnings']))

    def test_the_own_shot_snapshot_and_command_are_attached(self):
        s = self.battle['shotEvents']
        self.assertEqual(s[0]['event'], 'command')   # before the tracer it preceded live
        tracer = [x for x in s if x.get('event') == 'tracer'][0]
        self.assertEqual((tracer['id'], tracer['receivedAt'], tracer['siegeState'], tracer['source']),
                         ('s1', 4999.0, 1, 'replay Avatar.showTracer'))
        ends = [x for x in s if x.get('event') in ('stop', 'explosion')]
        self.assertTrue(ends and all(e['tracerId'] == 's1' for e in ends))

    def test_without_a_live_record_every_hit_is_scene_less(self):
        battle, report = rb.build(self.replay, None, '555-replay')
        self.assertEqual(battle['id'], '555-replay')
        self.assertEqual(report['hitsWithScene'], 0)
        self.assertTrue(any('No live record' in w for w in battle['warnings']))

    def test_a_live_record_the_replay_lacks_is_counted_not_shown(self):
        live = dict(self.live, hits=self.live['hits'] + [dict(self.live['hits'][0], id='2', damage=999)])
        battle, report = rb.build(self.replay, live)
        self.assertEqual(report['liveOnly'], {'hit':1})
        self.assertFalse(any(h['id'] == '2' for h in battle['hits']))
        self.assertTrue(any('not in the replay' in w for w in battle['warnings']))


class ExporterTests(unittest.TestCase):
    """publish_replay writes the replay-made battle, and every later publish of that id keeps it so."""

    def test_publish_replay_and_a_later_republish_keep_the_replay_battle(self):
        from local_armor_inspector.exporter import read_data_file
        replay, live = synthetic_pair()
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, 'battles'))
            e = exporter(root)
            report = e.publish_replay('555-abc', replay, live)
            path = os.path.join(root, 'data', 'battles', '555-abc.js')
            first = read_data_file(path)
            self.assertEqual((first['source'], first['replay']['hits']), ('replay', report['hits']))
            e.publish(dict(live, hits=[], shotEvents=[], critEvents=[]))   # e.g. a model arriving: the live battle again
            again = read_data_file(path)
            self.assertEqual(len(again['hits']), report['hits'])
            self.assertEqual(again['source'], 'replay')
        finally:
            shutil.rmtree(root, ignore_errors=True)


def fixtures_ready():
    return t.fixtures_ready() and names_table() is not None


@unittest.skipUnless(fixtures_ready(), 'local replay and live-record fixtures, the client or the names table are absent')
class FourBattlesTests(unittest.TestCase):
    """Proof 1 (11.11): the four battles with both sources, published both ways."""

    def test_hits_scenes_crits_and_the_damage_log_are_todays(self):
        for name, arena, folder in FOUR:
            live, replay, names = battle_pair(name, arena, folder)
            self.assertEqual(names.missed, 0, name)
            c = compare(live, replay)
            h = c['hits']
            self.assertEqual((h['matched'], h['replayOnly'], h['liveOnly']), (h['live'], [], []), name)
            self.assertEqual(h['sceneEqual'], h['live'], name)
            self.assertEqual(h['fields'], {}, (name, h['fields']))
            self.assertEqual(c['crits']['equal'], c['crits']['hitsWithCrits'], (name, c['crits']))
            d = c['damageEvents']
            self.assertEqual((d['liveOnly'], d['replayOnly']), ([], []), name)
            # The one difference: a ram's contact - the replay has only the own vehicle's (the server's point, no sides).
            self.assertTrue(set(d['fields']) <= set(['contact: differ', 'contact: live only']), (name, d['fields']))
            self.assertEqual(c['damageCheck']['live'], c['damageCheck']['replay'], name)
            self.assertEqual(c['damageCheck']['rows'], {}, name)
            s = c['shotEvents']
            self.assertEqual((s['live'], s['matched'], s['liveOnly'], s['replayOnly'], s['order']), (s['replay'], s['live'], {}, {}, True), name)
            self.assertEqual(s['fields'], {}, (name, s['fields']))
            r = c['roster']
            self.assertEqual(r['matched'], r['live'], name)
            self.assertTrue(set(r['fields']) <= set(['defaultMaxHealth: live only', 'healthFactor: live only', 'maxHealthFrom: differ',
                                                     'maxHealth: differ']), (name, r['fields']))
            self.assertTrue(all(row[3] == 'descriptor' for row in r['maxHealth']), (name, r['maxHealth']))
            self.assertTrue(set(c['header']) <= set(['replay', 'source', 'warnings']), (name, c['header']))


def kill_cam_ready():
    return t.kill_cam_ready() and names_table() is not None


@unittest.skipUnless(kill_cam_ready(), 'the October kill-cam replays, their live records, the client or the names table are absent')
class KillCamTests(unittest.TestCase):
    """Proof 2 (11.11): the death-camera window's hits are published scene-less and the HP check has no gap."""

    def test_window_hits_published_and_no_hp_missing(self):
        expected = {'16434853064049700':9, '30838317949392403':1}
        for name, arena, folder in KILL_CAM:
            live, replay, _ = battle_pair(name, arena, folder)
            c = compare(live, replay)
            self.assertEqual(len(c['hits']['replayOnly']), expected[arena], name)
            self.assertEqual(c['hits']['liveOnly'], [], name)
            self.assertEqual(replay['replay']['hitsWithoutScene'], expected[arena], name)
            self.assertGreater(live['damageCheck']['missing'], 0, name)
            check = replay['damageCheck']
            self.assertEqual((check['missing'], check['surplus'], check['mismatched']), (0, 0, 0), name)


def report():
    for name, arena, folder in FOUR + KILL_CAM:
        live, replay, names = battle_pair(name, arena, folder)
        print('=' * 10, name, 'names missed', names.missed if names else 'no table')
        for k, v in compare(live, replay).items():
            print(' %-13s %s' % (k, json.dumps(v, sort_keys=True, default=str)))


if __name__ == '__main__':
    if '--report' in sys.argv: report()
    else: unittest.main()
