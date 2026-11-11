# -*- coding: utf-8 -*-
"""Records in the recorder's schema made from a replay (mod/local_armor_inspector/replay_records.py), against the live
records of the same battles.

    python -m pytest tests/test_replay_records.py -q     the checks (CPython 3)
    python tests/test_replay_records.py --report        print the parity tables (outputs/replay-records-parity-2026-11-10.md)
    python tests/test_replay_records.py --write         rewrite the digest table tests/py27/replay_records.py compares

Synthetic events check the conversion rules on a clean clone. The fixture checks need local files, not in git (replays
and records carry nicknames), and skip without them: the replays of tests/fixtures-local/replays/, the live records of
the same battles copied to tests/fixtures-local/replay-parity-2026-11-10/ (with the two October kill-cam replays of the
game's replays/ folder, KILL_CAM), and the installed client's definitions.
The helpers below run under Python 2.7 too: tests/py27/replay_records.py imports them.
"""
from __future__ import print_function
import collections
import glob
import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
from local_armor_inspector import replay_records as rr  # noqa: E402
from local_armor_inspector import replay_stream as rd  # noqa: E402
from local_armor_inspector import damage_log  # noqa: E402
from local_armor_inspector.records import RecordDecoder  # noqa: E402

REPLAYS = os.path.join(ROOT, 'tests', 'fixtures-local', 'replays')
LIVE = os.path.join(ROOT, 'tests', 'fixtures-local', 'replay-parity-2026-11-10')
TABLE = os.path.join(LIVE, 'records-digest.json')
# The four battles with both a replay and a live record (02.11 x3, 09.11).
BATTLES = (('2026-11-02-1742-arena1755080049627192.wotreplay', '1755080049627192'),
           ('2026-11-02-1902-arena2307494640681034755.wotreplay', '2307494640681034755'),
           ('2026-11-02-1913-arena1754641962968727.wotreplay', '1754641962968727'),
           ('2026-11-09-2025-arena1726269409620419.wotreplay', '1726269409620419'))
TEMP_LIVE = '2026-11-10-temp-live.wotreplay'
DECODED_0111 = '2026-11-01-1848-redshire-decoded.jsonl'
ARENA_0111 = '2344208308889975564'
# Battles with a kill-cam window, both a replay and a live record (copied to LIVE with the replays): 15.10 and 20.10.
KILL_CAM = (('2026-10-15-2155-arena16434853064049700.wotreplay', '16434853064049700'),
            ('2026-10-20-2132-arena30838317949392403.wotreplay', '30838317949392403'))
IGNORED = ('schema', 'id', 'type', 'event', 'receivedAt', 'gameTime', 'tracerId')
HIT_IDENTITY = ('attackerId', 'targetId', 'damage', 'damageFactor', 'effectsIndex', 'prefabEffectsIndex',
                'lastMaterialIsShield', 'shellVelocity', 'gunInstallationIndex', 'direction', 'rawHitPoints')
POINT_RAW = ('part', 'effect', 'hitType', 'shellType', 'caliber')
_CACHE = {}


# ---- fixtures ---------------------------------------------------------------------------------------------------
def client_ready():
    return os.path.isdir(os.path.join(rd.DEFAULT_CLIENT, 'res', 'packages'))


def defs():
    if 'defs' not in _CACHE:
        client = rd.Client()
        _CACHE['defs'] = rd.Defs(client)
        _CACHE['names'] = client.vehicle_names()
    return _CACHE['defs']


def replay_records(name, folder=REPLAYS):
    """(records, stats, blocks) of one replay fixture, converted with the offline Names."""
    if name not in _CACHE:
        d = defs()
        blocks, stream = rd.read_any(os.path.join(folder, name))
        dec = rd.Decoder(d)
        out, stats = rr.convert(dec.decode(stream), header=blocks[0] if blocks else None,
                                vehicle_names=_CACHE['names'])
        stats['decoderFailures'] = sum(dec.failures.values())
        stats['frameFailures'] = sum(n for k, n in dec.objects.failures.items() if k[0] == 'frame')
        _CACHE[name] = (out, stats, blocks)
    return _CACHE[name]


def live_path(arena):
    paths = glob.glob(os.path.join(LIVE, '%s-*.jsonl' % arena))
    return paths[0] if paths else None


def live_records(arena):
    """The live raw records of one battle, read as the exporter reads them (RecordDecoder), or None."""
    path = live_path(arena)
    if path is None: return None
    decoder, out = RecordDecoder(), []
    with open(path, 'rb') as stream:
        for line in stream:
            if line.strip(): out.append(decoder.decode(json.loads(line.decode('utf-8'))))
    return out


def unhex(value):
    """The decoded-events JSON of tools/replay_decode.py writes byte strings as {'hex', 'len'}."""
    if isinstance(value, dict):
        if set(value) == set(('hex', 'len')): return bytearray(bytearray.fromhex(value['hex']))
        return dict((k, unhex(v)) for k, v in value.items())
    if isinstance(value, list): return [unhex(v) for v in value]
    return value


def decoded_0111():
    """The 01.11 decoded events (written 02.11 by the decoder of then): the small packets were raw then, so 0x15
    (server time at start) and 0x22 (own vehicle) are read here from their bytes, as the decoder reads them now."""
    import struct
    path = os.path.join(REPLAYS, DECODED_0111)
    if not os.path.isfile(path): return None
    out = []
    with open(path, 'rb') as stream:
        for line in stream:
            ev = unhex(json.loads(line.decode('utf-8')))
            if ev.get('ev') == 'packet' and ev.get('type') in ('0x15', '0x22'):
                raw = bytearray.fromhex(ev['raw'])
                if ev['type'] == '0x15': ev = {'t':ev['t'], 'ev':'server_time_at_start', 'serverTime':struct.unpack('<d', bytes(raw[:8]))[0]}
                else: ev = {'t':ev['t'], 'ev':'own_vehicle', 'vehicleId':struct.unpack('<I', bytes(raw[:4]))[0]}
            out.append(ev)
    return out


# ---- comparison -------------------------------------------------------------------------------------------------
def of(records, kind, event=None):
    return [r for r in records if r.get('type') == kind and (event is None or r.get('event') == event)]


def crit_key(r):
    e = r.get('event')
    if e == 'collision': return tuple(r.get('pair') or ())
    if e == 'health': return (r.get('vehicleId'), r.get('attackerId'), r.get('oldHealth'), r.get('newHealth'))
    if e == 'damageInfo': return (r.get('vehicleId'), r.get('position'))
    if e == 'shotResults': return (r.get('shooterId'),)
    return (r.get('vehicleId'),)


def match(live, replay, key, window=1.0):
    """Pairs (live, replay) of the same key nearest in gameTime within the window; then the unmatched of each side."""
    pool = collections.defaultdict(list)
    for r in replay: pool[key(r)].append(r)
    pairs, lone = [], []
    for r in live:
        cands = [c for c in pool[key(r)] if abs((c.get('gameTime') or 0) - (r.get('gameTime') or 0)) <= window]
        if not cands:
            lone.append(r)
            continue
        best = min(cands, key=lambda c: abs(c['gameTime'] - r['gameTime']))
        pool[key(r)].remove(best)
        pairs.append((r, best))
    rest = [r for rs in pool.values() for r in rs]
    return pairs, lone, rest


def field_diff(pairs, ignored=IGNORED, only=None):
    """Per field: equal, differ, live only, replay only - over the matched pairs."""
    table = collections.defaultdict(collections.Counter)
    for a, b in pairs:
        keys = set(a) | set(b)
        if only is not None: keys &= set(only)
        for k in keys:
            if k in ignored: continue
            if k not in b: table[k]['live only'] += 1
            elif k not in a: table[k]['replay only'] += 1
            elif a[k] == b[k]: table[k]['equal'] += 1
            elif rows_of_dicts(a[k], b[k]):
                # Rows (shot results, battle events): per field of the rows, so a name the replay lacks is named.
                for sub, counts in field_diff(list(zip(a[k], b[k])), ignored=()).items():
                    table[k + '[].' + sub].update(counts)
            else: table[k]['differ'] += 1
    return table


def rows_of_dicts(a, b):
    return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(
        isinstance(x, dict) for x in a + b)


def time_offsets(pairs):
    d = sorted(b['gameTime'] - a['gameTime'] for a, b in pairs if a.get('gameTime') is not None and b.get('gameTime') is not None)
    if not d: return None
    return {'n':len(d), 'min':round(d[0], 3), 'median':round(d[len(d) // 2], 3), 'max':round(d[-1], 3)}


def hit_view(h):
    v = dict((k, h.get(k)) for k in HIT_IDENTITY if k in h)
    v['points.raw'] = [dict((k, p.get(k)) for k in POINT_RAW) for p in h.get('points') or ()]
    v['gameTime'] = h.get('gameTime')
    return v


def compare_battle(live, replay):
    """Everything the parity report states for one battle, as plain data."""
    out = collections.OrderedDict()
    lh, rh = of(live, 'battle'), of(replay, 'battle')
    out['battle'] = field_diff([(lh[0], rh[0])], ignored=('schema', 'type')) if lh and rh else None
    lr, rrs = of(live, 'roster'), of(replay, 'roster')
    if lr and rrs:
        a = dict((r['id'], r) for r in lr[-1]['vehicles'])
        b = dict((r['id'], r) for r in rrs[-1]['vehicles'])
        pairs = [(a[i], b[i]) for i in a if i in b]
        out['roster'] = {'live':len(a), 'replay':len(b), 'matched':len(pairs), 'fields':field_diff(pairs, ignored=()),
                         'maxHealth':[(i, a[i].get('maxHealth'), b[i].get('maxHealth'), a[i].get('maxHealthFrom'))
                                      for i in a if i in b and a[i].get('maxHealth') != b[i].get('maxHealth')],
                         'playerTeam':(lr[-1].get('playerTeam'), rrs[-1].get('playerTeam'))}
    crits = collections.OrderedDict()
    for event in sorted(set(r.get('event') for r in of(live, 'crit') + of(replay, 'crit'))):
        L, R = of(live, 'crit', event), of(replay, 'crit', event)
        pairs, lone, rest = match(L, R, crit_key, 2.0 if event == 'collision' else 1.0)
        crits[event] = {'live':len(L), 'replay':len(R), 'matched':len(pairs), 'liveOnly':len(lone), 'replayOnly':len(rest),
                        'equal':sum(1 for a, b in pairs if all(a.get(k) == b.get(k) for k in set(a) | set(b) if k not in IGNORED + ('playerVehicleId',))),
                        'fields':field_diff(pairs), 'time':time_offsets(pairs)}
    out['crit'] = crits
    shots = collections.OrderedDict()
    for event in ('tracer', 'stop', 'explosion'):
        L, R = of(live, 'shot', event), of(replay, 'shot', event)
        pairs, lone, rest = match(L, R, lambda r: r.get('shotId'), 5.0)
        shots[event] = {'live':len(L), 'replay':len(R), 'matched':len(pairs), 'liveOnly':len(lone), 'replayOnly':len(rest),
                        'equal':sum(1 for a, b in pairs if all(a.get(k) == b.get(k) for k in set(a) | set(b) if k not in IGNORED)),
                        'fields':field_diff(pairs), 'time':time_offsets(pairs)}
    out['shot'] = shots
    out['shot other live events'] = dict(collections.Counter(r['event'] for r in of(live, 'shot') if r['event'] not in shots))
    L, R = [hit_view(h) for h in of(live, 'hit')], [hit_view(h) for h in of(replay, 'hit')]
    hkey = lambda v: (v.get('attackerId'), v.get('targetId'), v.get('damage'), json.dumps(v.get('rawHitPoints'), sort_keys=True))
    pairs, lone, rest = match(L, R, hkey, 1.0)
    out['hit'] = {'live':len(L), 'replay':len(R), 'matched':len(pairs), 'liveOnly':len(lone), 'replayOnly':len(rest),
                  'equal':sum(1 for a, b in pairs if all(a.get(k) == b.get(k) for k in set(a) | set(b) if k != 'gameTime')),
                  'fields':field_diff(pairs, ignored=('gameTime',)), 'time':time_offsets(pairs),
                  'liveOnlyFields':sorted(set(k for h in of(live, 'hit') for k in h) - set(k for h in of(replay, 'hit') for k in h)),
                  'replayOnlyFields':sorted(set(k for h in of(replay, 'hit') for k in h) - set(k for h in of(live, 'hit') for k in h))}
    return out


def event_key(e):
    return (e.get('kind'), e.get('targetId'), e.get('attackerId'), e.get('damage'), e.get('ticks'))


def compare_damage_log(live, replay, replay_hits=False):
    """damage_log with the live hits and the live crits and roster, against the live hits (replay_hits: the replay's
    hits) with the replay's crits and roster; offline (now=None) on both sides, as for a finished battle."""
    hits = of(live, 'hit')
    lr, rrs = of(live, 'roster'), of(replay, 'roster')
    a_events, a_check, _ = damage_log.damage_log(hits, of(live, 'crit'), lr[-1]['vehicles'] if lr else None)
    b_events, b_check, _ = damage_log.damage_log(of(replay, 'hit') if replay_hits else hits, of(replay, 'crit'),
                                                 rrs[-1]['vehicles'] if rrs else None)
    pool = list(b_events)
    pairs, lone = [], []
    for e in a_events:
        same = [x for x in pool if event_key(x) == event_key(e)]
        if not same:
            lone.append(e)
            continue
        best = min(same, key=lambda x: abs(x['gameTime'] - e['gameTime']))
        pool.remove(best)
        pairs.append((e, best))
    fields = field_diff(pairs, ignored=('id', 'collision', 'receivedAt', 'gameTime', 'start', 'end'))
    check_diff = dict((k, (a_check.get(k), b_check.get(k))) for k in set(a_check or {}) | set(b_check or {})
                      if (a_check or {}).get(k) != (b_check or {}).get(k)) if (a_check or b_check) else {}
    return {'live':len(a_events), 'replay':len(b_events), 'matched':len(pairs), 'liveOnly':[event_key(e) for e in lone],
            'replayOnly':[event_key(e) for e in pool], 'fields':fields, 'time':time_offsets(pairs),
            'check':(dict((k, a_check[k]) for k in a_check if k != 'rows') if a_check else None,
                     dict((k, b_check[k]) for k in b_check if k != 'rows') if b_check else None),
            'checkDiff':check_diff}


# ---- digest for the two Pythons -----------------------------------------------------------------------------------
def digest(records):
    import replay_digest
    md5 = hashlib.md5()
    for r in records:
        if 'segmentDistance' in r:
            # The one float the two Pythons compute apart: the client's python27 gives sqrt(sum of squares) one unit
            # in the last place off CPython 3 in 4 of ~700 shot ends - and equal to the live record's value (MEASURED
            # 10.11: 306.9172025889262 live and py27, ...263 CPython 3). Compared to 1e-9 m here; records unchanged.
            r = dict(r, segmentDistance=round(r['segmentDistance'], 9))
        md5.update(replay_digest.norm(r).encode('utf-8') + b'\n')
    kinds = collections.Counter((r['type'] + (':' + r['event'] if 'event' in r else '')) for r in records)
    return collections.OrderedDict([('records', len(records)), ('md5', md5.hexdigest()),
                                    ('kinds', collections.OrderedDict(sorted(kinds.items())))])


def digests():
    out = collections.OrderedDict()
    for name in [b for b, _ in BATTLES] + [TEMP_LIVE]:
        if os.path.isfile(os.path.join(REPLAYS, name)): out[name] = digest(replay_records(name)[0])
    for name, _ in KILL_CAM:
        if os.path.isfile(os.path.join(LIVE, name)): out[name] = digest(replay_records(name, LIVE)[0])
    events = decoded_0111()
    if events is not None: out[DECODED_0111] = digest(rr.convert(events)[0])
    return out


# ---- tests ----------------------------------------------------------------------------------------------------------
def synthetic():
    """A small battle: the own vehicle 10, an enemy 20 burning and ramming, a shot, a damage-info list."""
    return [
        {'t':0.0, 'ev':'player_base', 'id':1, 'entity':'Avatar', 'props':{'arenaUniqueID':555, 'sessionID':b'10',
                                                                            'arenaTypeID':5, 'arenaBonusType':1, 'arenaGuiType':1}},
        {'t':0.0, 'ev':'own_vehicle', 'vehicleId':10},
        {'t':0.0, 'ev':'server_time_at_start', 'serverTime':1000.0},
        {'t':0.0, 'ev':'component', 'cid':5, 'owner':1, 'component':'AvatarVehiclesInfo', 'state':{'vehiclesInfo':[
            {'vehicleID':10, 'name':b'me', 'team':1, 'compDescr':b'\x51\x68', 'maxHealth':1950, 'avatarSessionID':b'10',
             'vehPostProgression':[], 'customRoleSlotTypeId':0},
            {'vehicleID':20, 'name':b'bot', 'team':2, 'compDescr':b'\x11\x02', 'maxHealth':900, 'avatarSessionID':b''}]}},
        {'t':0.0, 'ev':'component', 'cid':7, 'owner':10, 'component':'OwnVehicle', 'state':{'vehicleDamageInfoList':[]}},
        {'t':1.0, 'ev':'entity_create', 'id':20, 'entity':'Vehicle', 'props':{'publicStateModifiers':[]}},
        {'t':2.0, 'ev':'method', 'id':1, 'entity':'Avatar', 'name':'showTracer', 'args':{'shooterID':10, 'shotID':77,
            'isRicochet':0, 'effectsIndex':4, 'prefabEffIndex':0, 'shellTypeIdx':1, 'shellCaliber':120.0,
            'refStartPoint':[0.0, 0.0, 0.0], 'velocity':[1.0, 0.0, 0.0], 'gravity':9.8, 'maxShotDist':720.0, 'gunIndex':0,
            'gunInstallationIndex':0}},
        {'t':2.5, 'ev':'method', 'id':1, 'entity':'Avatar', 'name':'stopTracer', 'args':{'shotID':77, 'endPoint':[3.0, 4.0, 0.0]}},
        {'t':2.5, 'ev':'method', 'id':1, 'entity':'Avatar', 'name':'stopTracer', 'args':{'shotID':78, 'endPoint':[3.0, 4.0, 0.0]}},
        {'t':2.5, 'ev':'method', 'id':20, 'entity':'Vehicle', 'name':'showDamageFromShot', 'args':{'attackerID':10,
            'hitPoints':[{'networkID':0, 'part':1, 'effect':4, 'hitType':4, 'shellType':1, 'caliber':120.0,
                          'segment':'123', 'params':307268}], 'effectsIndex':4, 'prefabEffIndex':0, 'damage':390,
            'damageFactor':40, 'lastMaterialIsShield':0, 'shellVelocity':900.0, 'gunInstallationIndex':0}},
        {'t':2.5, 'ev':'method', 'id':20, 'entity':'Vehicle', 'name':'onHealthChanged', 'args':{'newHealth':510,
            'oldHealth':900, 'attackerID':10, 'attackReasonID':0, 'attackReasonExtID':-1}},
        {'t':2.5, 'ev':'nested_property', 'id':20, 'entity':'Vehicle', 'name':'publicStateModifiers',
         'path':['publicStateModifiers'], 'slice':[0, 0], 'value':[67]},
        {'t':3.0, 'ev':'component', 'cid':9, 'owner':20, 'component':'Fire', 'state':{'fireInfo':None}},
        {'t':3.5, 'ev':'method', 'id':20, 'entity':'Vehicle', 'name':'onHealthChanged', 'args':{'newHealth':480,
            'oldHealth':510, 'attackerID':10, 'attackReasonID':1, 'attackReasonExtID':0}},
        {'t':4.0, 'ev':'component_removed', 'cid':9, 'owner':20, 'component':'Fire'},
        {'t':5.0, 'ev':'method', 'id':1, 'entity':'Avatar', 'name':'onCollisionWithVehicle', 'args':{'point':[1.0, 2.0, 3.0], 'energy':50.0}},
        {'t':5.2, 'ev':'method', 'id':20, 'entity':'Vehicle', 'name':'onHealthChanged', 'args':{'newHealth':400,
            'oldHealth':480, 'attackerID':10, 'attackReasonID':2, 'attackReasonExtID':0}},
        {'t':5.2, 'ev':'method', 'id':10, 'entity':'Vehicle', 'name':'onHealthChanged', 'args':{'newHealth':1900,
            'oldHealth':1950, 'attackerID':20, 'attackReasonID':2, 'attackReasonExtID':0}},
        {'t':6.0, 'ev':'component_property', 'owner':10, 'component':'OwnVehicle', 'name':'vehicleDamageInfoList',
         'path':['vehicleDamageInfoList'], 'slice':[0, 0], 'value':[{'extraIndex':67, 'damageIndex':3, 'entityID':20,
                                                                   'equipmentID':0, 'damageExtIndex':-1}]},
        {'t':6.1, 'ev':'component_property', 'owner':10, 'component':'OwnVehicle', 'name':'vehicleDamageInfoList',
         'value':[{'extraIndex':67, 'damageIndex':3, 'entityID':20, 'equipmentID':0, 'damageExtIndex':-1}]},
    ]


class SyntheticTests(unittest.TestCase):
    def setUp(self):
        self.out, self.stats = rr.convert(synthetic(), vehicle_names={(5, 104):'uk:Test', (1, 2):'germany:Bot'})

    def test_header_first_marked_replay(self):
        head = self.out[0]
        self.assertEqual((head['type'], head['source'], head['arenaId'], head['playerVehicleId'], head['id']),
                         ('battle', 'replay', '555', 10, '555-replay'))
        self.assertEqual((head['mode']['bonusType'], head['mode']['arenaTypeId']), (1, 5))
        self.assertNotIn('clientVersion', head)   # not given, so left out

    def test_roster_from_vehicles_info(self):
        rows = dict((r['id'], r) for r in of(self.out, 'roster')[-1]['vehicles'])
        self.assertEqual((rows[10]['type'], rows[10]['maxHealth'], rows[10]['maxHealthFrom'], rows[10]['isBot']),
                         ('uk:Test', 1950, 'vehiclesInfo', False))
        self.assertTrue(rows[20]['isBot'])
        self.assertNotIn('name', rows[10])   # the short user name needs the client: left out

    def test_events_on_server_clock_without_wall_clock(self):
        for r in self.out[1:]:
            if r['type'] in ('crit', 'shot', 'hit'):
                self.assertNotIn('receivedAt', r)
        self.assertEqual(of(self.out, 'shot', 'tracer')[0]['gameTime'], 1002.0)

    def test_health_rule_of_the_live_recorder(self):
        health = of(self.out, 'crit', 'health')
        self.assertEqual([(h['attackReasonId'], h['newHealth']) for h in health], [(1, 480), (2, 400), (2, 1900)])
        self.assertTrue(all('attackReason' not in h for h in health))   # names need the client

    def test_shot_end_needs_its_tracer(self):
        stops = of(self.out, 'shot', 'stop')
        self.assertEqual([(s['shotId'], s['segmentDistance']) for s in stops], [('77', 5.0)])
        self.assertEqual(self.stats['skipped'], {'stop without its tracer':1})

    def test_hit_carries_its_identity_and_marks_what_is_absent(self):
        hit = of(self.out, 'hit')[0]
        self.assertEqual((hit['direction'], hit['damage'], hit['rawHitPoints']),
                         ('outgoing', 390, [{'networkID':'0', 'segment':'123', 'params':'307268'}]))
        # The calibre from the raw params as the client computes it: 1200 tenths of mm * 0.1, not rounded.
        self.assertEqual(hit['points'], [{'part':1, 'effect':4, 'hitType':4, 'shellType':1, 'caliber':1200 * 0.1,
                                          'status':'replay-raw'}])
        self.assertNotIn('target', hit)
        self.assertIn('target', hit['replayAbsent'])

    def test_public_state_fire_damage_info_and_ram_contact(self):
        ps = of(self.out, 'crit', 'publicState')
        self.assertEqual([(p['addedIdx'], p['removedIdx']) for p in ps], [([67], [])])
        self.assertEqual([f['state'] for f in of(self.out, 'crit', 'fire')], ['appeared', 'removed'])
        info = of(self.out, 'crit', 'damageInfo')
        self.assertEqual([(i['position'], i['extraIndex']) for i in info], [(0, 67)])   # the whole set again: not twice
        contact = of(self.out, 'crit', 'collision')
        self.assertEqual([(c['pair'], c['at']) for c in contact], [([10, 20], 1005.0)])

    def test_damage_log_accepts_the_records(self):
        events, check, held = damage_log.damage_log(of(self.out, 'hit'), of(self.out, 'crit'),
                                                    of(self.out, 'roster')[-1]['vehicles'])
        self.assertEqual(sorted((e['kind'], e['targetId'], e['damage']) for e in events),
                         [('fire', 20, 30), ('ram', 10, 50), ('ram', 20, 80)])
        self.assertEqual(held, 0)
        ram = [e for e in events if e['kind'] == 'ram'][0]
        self.assertEqual(sorted(ram['contact']['sides']), ['10', '20'])


def fixtures_ready():
    return client_ready() and all(os.path.isfile(os.path.join(REPLAYS, b)) and live_path(a) for b, a in BATTLES)


@unittest.skipUnless(fixtures_ready(), 'local replay and live-record fixtures or the client are absent')
class ParityTests(unittest.TestCase):
    """The acceptance of 10.11: the converted records against the live ones, four battles (MEASURED, the report)."""

    def battle(self, arena):
        name = [b for b, a in BATTLES if a == arena][0]
        return live_records(arena), replay_records(name)[0]

    def test_every_live_hit_tracer_stop_and_crit_has_its_replay_record(self):
        for _, arena in BATTLES:
            live, replay = self.battle(arena)
            result = compare_battle(live, replay)
            self.assertEqual((result['hit']['liveOnly'], result['hit']['replayOnly']), (0, 0), arena)
            self.assertEqual(result['hit']['equal'], result['hit']['live'], arena)
            for event in ('tracer', 'stop', 'explosion'):
                self.assertEqual(result['shot'][event]['liveOnly'], 0, (arena, event))
            for event, row in result['crit'].items():
                if event in ('collision',): continue   # contacts between other vehicles: live only (report)
                self.assertEqual(row['liveOnly'], 0, (arena, event, row))

    def test_roster_types_teams_and_true_max_health(self):
        for _, arena in BATTLES:
            live, replay = self.battle(arena)
            r = compare_battle(live, replay)['roster']
            self.assertEqual(r['matched'], r['live'], arena)
            for field in ('type', 'team', 'player'):
                self.assertEqual(r['fields'][field]['differ'], 0, (arena, field))
            # A max HP that differs is only ever the live 'descriptor' figure (the arena's, without equipment).
            self.assertTrue(all(row[3] == 'descriptor' for row in r['maxHealth']), (arena, r['maxHealth']))

    def test_damage_log_from_replay_crits_holds_every_live_event(self):
        for _, arena in BATTLES:
            live, replay = self.battle(arena)
            d = compare_damage_log(live, replay)
            self.assertEqual(d['liveOnly'], [], arena)


def kill_cam_ready():
    return client_ready() and all(os.path.isfile(os.path.join(LIVE, b)) and live_path(a) for b, a in KILL_CAM)


@unittest.skipUnless(kill_cam_ready(), 'the October kill-cam replays, their live records or the client are absent')
class KillCamTests(unittest.TestCase):
    """The user's case (01.11, outputs/hits-failures-diagnosis-2026-11-02.md section 1): the hits and HP losses the
    live recorder lost while the death camera withheld the vehicles. The 18:50 battle's own replay was overwritten; these
    are the two battles that have both a replay with a kill-cam window and a live record (15.10, 20.10; their replays
    are of client 2.4.1.0, decoded with the installed client's definitions - entity methods read, a few component
    frames do not). MEASURED 10.11."""

    def test_window_hits_and_hp_losses_are_in_the_replay_records(self):
        expected = {'16434853064049700':(9, 3819), '30838317949392403':(1, 710)}
        for name, arena in KILL_CAM:
            live, replay = live_records(arena), replay_records(name, LIVE)[0]
            w = death_window(live, replay)
            self.assertEqual(w['liveHitsMissingInReplay'], 0, arena)
            self.assertEqual((len(w['replayOnlyHits']), w['replayOnlyDamage']), expected[arena], (arena, w))

    def test_damage_check_has_no_gap_with_replay_records_alone(self):
        for name, arena in KILL_CAM:
            live, replay = live_records(arena), replay_records(name, LIVE)[0]
            before = damage_log.check(of(live, 'hit'), of(live, 'crit'), of(live, 'roster')[-1]['vehicles'])
            after = damage_log.check(of(replay, 'hit'), of(replay, 'crit'), of(replay, 'roster')[-1]['vehicles'])
            self.assertGreater(before['missing'], 0, arena)   # the live record: the window's HP are missing
            self.assertEqual((after['missing'], after['surplus'], after['mismatched']), (0, 0, 0), (arena, after['rows']))


@unittest.skipUnless(os.path.isfile(os.path.join(REPLAYS, DECODED_0111)), 'the 01.11 decoded-events fixture is absent')
class Battle0111Tests(unittest.TestCase):
    """The 01.11 decoded-events fixture is the random battle of 18:48 (arena 2344208308889975564), not the tournament
    battle of the user's case (37909019530612681, 18:50). Its live record lost nothing after the death (no kill-cam
    window in it): the replay records hold the same hits there."""

    def test_after_death_same_hits(self):
        live = live_records(ARENA_0111)
        if live is None: self.skipTest('the live record of %s is absent' % ARENA_0111)
        w = death_window(live, rr.convert(decoded_0111())[0])
        self.assertEqual((w['liveHitsMissingInReplay'], w['replayHits']), (0, w['liveHits']))


def death_window(live, replay):
    """Hits and HP losses after the player's death: live against replay records."""
    player = of(live, 'battle')[0]['playerVehicleId']
    died = [h['gameTime'] for h in of(replay, 'crit', 'health') if h['vehicleId'] == player and h['newHealth'] <= 0]
    if not died: return None
    death = died[0]
    lh = [h for h in of(live, 'hit') if h['gameTime'] > death]
    rh = [h for h in of(replay, 'hit') if h['gameTime'] > death]
    key = lambda h: (h['attackerId'], h['targetId'], h['damage'], json.dumps(h['rawHitPoints'], sort_keys=True))
    rkeys = collections.Counter(key(h) for h in rh)
    missing = 0
    for h in lh:
        if rkeys[key(h)]: rkeys[key(h)] -= 1
        else: missing += 1
    extra = [h for h in rh if not any(key(h) == key(x) and abs(h['gameTime'] - x['gameTime']) < 1 for x in lh)]
    return {'death':death, 'liveHits':len(lh), 'replayHits':len(rh), 'liveHitsMissingInReplay':missing,
            'replayOnlyHits':[(round(h['gameTime'] - death, 1), h['attackerId'], h['targetId'], h['damage']) for h in extra],
            'replayOnlyDamage':sum(h['damage'] for h in extra)}


@unittest.skipUnless(client_ready() and os.path.isfile(os.path.join(REPLAYS, TEMP_LIVE)), 'the 10.11 raw stream or the client is absent')
class TempStreamTests(unittest.TestCase):
    def test_raw_in_battle_stream_converts(self):
        out, stats, _ = replay_records(TEMP_LIVE)
        head = out[0]
        self.assertEqual((head['type'], head['source'], head['map']), ('battle', 'replay', 'Unknown map'))
        self.assertGreater(len(of(out, 'hit')), 0)
        self.assertGreater(len(of(out, 'roster')), 0)


@unittest.skipUnless(client_ready() and os.path.isfile(TABLE), 'the records digest table is absent')
class DigestTableTests(unittest.TestCase):
    def test_same_records_as_the_table_tests_py27_checks(self):
        with open(TABLE, 'rb') as stream: table = json.loads(stream.read().decode('utf-8'))
        got = json.loads(json.dumps(digests()))
        self.assertEqual(got, table)


def changed(fields):
    return dict((k, dict(c)) for k, c in sorted(fields.items()) if set(c) != set(['equal']))


def report_battle(live, replay):
    res = compare_battle(live, replay)
    print(' battle', changed(res['battle']) if res['battle'] else None)
    r = res.get('roster')
    if r:
        print(' roster live %d replay %d matched %d; fields %s; maxHealth differ %s' % (
            r['live'], r['replay'], r['matched'], changed(r['fields']), r['maxHealth']))
    for kind in ('crit', 'shot'):
        for ev, row in res[kind].items():
            print(' %s %-22s live %4d replay %4d matched %4d equal %4d liveOnly %3d replayOnly %3d time %s %s' % (
                kind, ev, row['live'], row['replay'], row['matched'], row['equal'], row['liveOnly'], row['replayOnly'],
                row['time'], changed(row['fields'])))
    h = res['hit']
    print(' hit live %d replay %d matched %d equal %d liveOnly %d replayOnly %d time %s %s; live-only fields %s' % (
        h['live'], h['replay'], h['matched'], h['equal'], h['liveOnly'], h['replayOnly'], h['time'], changed(h['fields']),
        h['liveOnlyFields']))
    for hits in (False, True):
        d = compare_damage_log(live, replay, hits)
        print(' damage log (%s hits): events live %d replay %d matched %d liveOnly %s replayOnly %s %s; check %s' % (
            'replay' if hits else 'live', d['live'], d['replay'], d['matched'], d['liveOnly'], d['replayOnly'],
            changed(d['fields']), d['checkDiff'] or 'equal'))


def report():
    for name, arena in BATTLES:
        print('=' * 10, name, replay_records(name)[1])
        report_battle(live_records(arena), replay_records(name)[0])
    for name, arena in KILL_CAM:
        print('=' * 10, name, replay_records(name, LIVE)[1])
        live, replay = live_records(arena), replay_records(name, LIVE)[0]
        print(' death window', death_window(live, replay))
        report_battle(live, replay)
    print('=' * 10, DECODED_0111)
    live, replay = live_records(ARENA_0111), rr.convert(decoded_0111(), vehicle_names=_CACHE['names'])[0]
    print(' death window', death_window(live, replay))
    report_battle(live, replay)
    print('=' * 10, TEMP_LIVE, replay_records(TEMP_LIVE)[1])
    out = replay_records(TEMP_LIVE)[0]
    live = live_records(out[0]['arenaId'])
    if live: report_battle(live, out)


if __name__ == '__main__':
    if '--report' in sys.argv: report()
    elif '--write' in sys.argv:
        with open(TABLE, 'w') as stream: stream.write(json.dumps(digests(), indent=1) + '\n')
        print('written', TABLE)
    else: unittest.main()
