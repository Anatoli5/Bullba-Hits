# -*- coding: utf-8 -*-
"""A vehicle id that changes its vehicle during a battle (BACKLOG 97): respawn modes (Fort Rush, like Frontline) bring a
player back in ANOTHER vehicle under the same vehicle id. Whatever the replay path takes from a vehicle's descriptor must
be the descriptor the entity had at that moment, not one per vehicle id for the whole battle.

    python -m pytest tests/test_vehicle_swap.py -q

The user's case (13.11, Fort Rush on 1.09, his kept stream and live record in tests/fixtures-local/vehicle-swap-2026-11-13,
local, not in git): the same hit showed one tank in the snapshot and another in the scene rebuilt from the replay - the
rebuilt scene took the vehicle id's LAST publicInfo descriptor (replay_scene.Tracks.compact, one per id). The checks:
- every rebuilt scene's target is the vehicle the live snapshot of the same hit recorded (its vehicleRef's descriptor);
- every other vehicle's estimated aim circle is made with the gun of the vehicle that fired (the live roster at the shot);
- a store written before the lives were kept is not restored for a battle whose roster changes a vehicle (it is decoded
  again from its kept stream), and is restored as before otherwise.
Synthetic checks of the same rules run on a clean clone.
"""
from __future__ import print_function
import array
import base64
import bisect
import json
import os
import sys
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
from local_armor_inspector import replay_scene as rs  # noqa: E402
from local_armor_inspector import replay_aim_other as rao  # noqa: E402
from local_armor_inspector import replay_run  # noqa: E402

FIXTURE = os.path.join(ROOT, 'tests', 'fixtures-local', 'vehicle-swap-2026-11-13')
NAME = '1700001389969250-7a94b9f27f21'
STREAM = os.path.join(FIXTURE, NAME + '.stream.z')
LIVE = os.path.join(FIXTURE, NAME + '.jsonl')
_CACHE = {}


def fixture_ready():
    import test_replay_records as t
    return os.path.isfile(STREAM) and os.path.isfile(LIVE) and t.client_ready()


def replay():
    """The replay records of the user's battle with poses, as the replay job converts them; the vehicle names table."""
    if 'records' not in _CACHE:
        import test_replay_records as t
        from local_armor_inspector import replay_records as rr
        d = t.defs()
        with open(STREAM, 'rb') as f: stream = bytearray(zlib.decompress(f.read()))
        _CACHE['records'] = rr.convert(t.rd.Decoder(d).decode(stream), vehicle_names=t._CACHE['names'], poses=True)[0]
        _CACHE['names'] = t._CACHE['names']
    return _CACHE['records'], _CACHE['names']


def live():
    if 'live' not in _CACHE:
        with open(LIVE, 'rb') as f:
            _CACHE['live'] = [json.loads(line.decode('utf-8')) for line in f if line.strip()]
    return _CACHE['live']


def type_of(compact_text, names):
    from local_armor_inspector.replay_stream import parse_vehicle_compact_descr
    try: nation, tid, _ = parse_vehicle_compact_descr(base64.b64decode(compact_text))
    except Exception: return None
    return names.get((nation, tid))


class Probe(object):
    """A scene source that gives minimal statics and no model: the scene says which descriptor it took."""

    def statics(self, compact):
        return {'type':compact, 'hullPosition':[0, 1, 0], 'turretPosition':[0, 1, 0], 'turretPitch':0.0,
                'gunPosition':[0, 0, 1], 'pitchLimits':[-0.2, 0.1], 'parts':[]}

    def model(self, resource):
        raise KeyError(resource)


def live_rosters():
    """[(receivedAt, {vehicle id: type})] of the live roster records."""
    return sorted((r['receivedAt'], dict((v['id'], v.get('type')) for v in r.get('vehicles') or ()))
                  for r in live() if r.get('type') == 'roster')


def live_changes():
    """{vehicle id: [receivedAt of each roster record that changed its type]}."""
    rosters, changes = live_rosters(), {}
    for (_, a), (when, b) in zip(rosters, rosters[1:]):
        for vid in b:
            if vid in a and a[vid] != b[vid]: changes.setdefault(vid, []).append(when)
    return changes


def live_roster_at(rows, when):
    """{vehicle id: type} of the last live roster record received at or before `when`."""
    i = bisect.bisect_right([r[0] for r in rows], when)
    return rows[i - 1][1] if i else {}


class UserCase(unittest.TestCase):
    """The user's Fort Rush battle of 13.11 16:30 (11 vehicle ids changed their vehicle in it)."""

    @unittest.skipUnless(os.path.isfile(STREAM), 'local fixture absent: %s' % FIXTURE)
    def setUp(self):
        if not fixture_ready(): self.skipTest('the installed client is needed to decode the stream')
        self.records, self.names = replay()
        self.poses = next(r for r in self.records if r.get('type') == 'poses')

    def test_the_rebuilt_scene_is_the_snapshot_vehicle(self):
        """Every replay hit with a live twin: the rebuilt scene's target type = the snapshot's (vehicleRef)."""
        twins = {}
        for h in live():
            if h.get('type') != 'hit' or not isinstance(h.get('target'), dict) or not h['target'].get('vehicleRef'): continue
            key = (h.get('attackerId'), h.get('targetId'), json.dumps(h.get('rawHitPoints'), sort_keys=True))
            twins.setdefault(key, []).append(h)
        scenes = rs.Scenes(self.poses, None, Probe())
        changed = set(live_changes())
        checked, wrong, swapped = 0, [], 0
        for h in self.records:
            if h.get('type') != 'hit': continue
            key = (h.get('attackerId'), h.get('targetId'), json.dumps(h.get('rawHitPoints'), sort_keys=True))
            twin = [x for x in twins.get(key, ()) if abs(float(x['gameTime']) - float(h['gameTime'])) < 0.5]
            if len(twin) != 1: continue
            scene, why = scenes.scene(h)
            if scene is None: continue
            truth = type_of(twin[0]['target']['vehicleRef'].rsplit(':', 1)[0], self.names)
            got = type_of(scene['target']['compactDescriptor'], self.names)
            checked += 1
            if h['targetId'] in changed: swapped += 1
            if got != truth: wrong.append((h['id'], h['targetId'], truth, got))
        self.assertGreater(checked, 150)
        self.assertGreater(swapped, 20)       # hits on a vehicle id that changed its vehicle: the case itself
        self.assertEqual(len(wrong), 0, '%d of %d wrong, first %r' % (len(wrong), checked, wrong[:3]))

    def test_the_estimated_circle_takes_the_gun_that_fired(self):
        """Every other vehicle's main-gun tracer that a live hit snapshot of the same shooter within 5 s names: the estimate
        asks for the gun of THAT vehicle (the snapshot's attacker vehicleRef - the entity's own descriptor). The live
        roster is no truth here: the arena list names the vehicle the player SELECTED for his next life, tens of seconds
        before it enters the battle (measured: 1820451 listed as Centurion at 290.7 s, still firing the VNII at 319 s, the
        Centurion created at 350.9 s)."""
        shots = {}
        for h in live():
            if h.get('type') != 'hit' or not isinstance(h.get('attacker'), dict) or not h['attacker'].get('vehicleRef'): continue
            shots.setdefault(h.get('attackerId'), []).append((float(h['gameTime']), type_of(h['attacker']['vehicleRef'].rsplit(':', 1)[0], self.names)))

        def inputs(compact):
            raise ValueError('type=%s' % type_of(compact, self.names))

        import copy
        records = copy.deepcopy([r for r in self.records if r.get('type') != 'poses']) + [self.poses]
        rao.attach(records, inputs)
        checked, wrong = 0, []
        for r in records:
            block = r.get(rao.KEY)
            if not block or block.get('reasonKey') != 'gun' or 'type=' not in block.get('reason', ''): continue
            near = set(t for when, t in shots.get(r.get('shooterId'), ()) if abs(when - float(r['gameTime'])) < 5.0)
            near.discard(None)
            if len(near) != 1: continue
            truth = near.pop()
            got = block['reason'].split('type=')[1]
            checked += 1
            if got != truth: wrong.append((r['shooterId'], r['shotId'], truth, got))
        self.assertGreater(checked, 100)
        self.assertEqual(len(wrong), 0, '%d of %d wrong, first %r' % (len(wrong), checked, wrong[:3]))


def poses_of(compacts, positions=None):
    """A poses record with each (vehicle id, [(t, descriptor text)]) life list, as Tracks makes it."""
    tracks = rs.Tracks()
    for vid, lives in compacts.items():
        for t, c in lives: tracks.public(vid, base64.b64decode(c), t)
    for vid, rows in (positions or {}).items():
        for t in rows: tracks.position(vid, t, (0.0, 0.0, 0.0), 0.0, 0.0, 0.0)
    return tracks.record(1, 100.0)


A, B = base64.b64encode(b'A-vehicle').decode('ascii'), base64.b64encode(b'B-vehicle').decode('ascii')


class Synthetic(unittest.TestCase):
    def test_the_scene_takes_the_descriptor_in_force_at_the_hit(self):
        poses = poses_of({7:[(1.0, A), (50.0, B)]}, {7:[i * 0.1 for i in range(1000)]})
        scenes = rs.Scenes(poses, None, Probe())
        for when, want in ((20.0, A), (49.9, A), (60.0, B)):
            scene, why = scenes.scene({'gameTime':100.0 + when, 'targetId':7, 'attackerId':9, 'rawHitPoints':[]})
            self.assertIsNone(why)
            self.assertEqual(scene['target']['compactDescriptor'], want, when)

    def test_a_hit_before_the_first_creation_takes_the_first_descriptor(self):
        poses = poses_of({7:[(10.0, A), (50.0, B)]})
        self.assertEqual(rs.compact_at(poses, 7, 2.0), A)
        self.assertEqual(rs.compact_at(poses, 7, 50.0), B)
        self.assertIsNone(rs.compact_at(poses, 8, 2.0))

    def test_the_same_descriptor_again_is_one_life(self):
        poses = poses_of({7:[(1.0, A), (20.0, A), (50.0, B), (70.0, B)]})
        self.assertEqual([c for _, c in rs.lives_of(poses, 7)], [A, B])

    def test_a_store_keeps_the_lives(self):
        poses = poses_of({7:[(1.0, A), (50.0, B)]})
        back = replay_run.json_poses(json.loads(json.dumps(replay_run.poses_json(poses))))
        self.assertEqual(rs.compact_at(back, 7, 20.0), A)
        self.assertEqual(rs.compact_at(back, 7, 60.0), B)

    def test_an_old_store_falls_back_to_the_one_descriptor(self):
        poses = poses_of({7:[(1.0, A), (50.0, B)]})
        value = replay_run.poses_json(poses)
        value.pop('lives')
        back = replay_run.json_poses(value)
        self.assertEqual(rs.compact_at(back, 7, 20.0), B)

    def test_an_old_store_of_a_battle_with_a_swap_is_decoded_again(self):
        roster = lambda t: {'type':'roster', 'vehicles':[{'id':7, 'type':t}, {'id':8, 'type':'x:z'}]}
        poses = replay_run.poses_json(poses_of({7:[(1.0, A)]}))
        poses.pop('lives')
        swap = [roster('x:a'), roster('x:b')]
        same = [roster('x:a'), roster('x:a')]
        self.assertTrue(replay_run.needs_lives(swap, poses))
        self.assertFalse(replay_run.needs_lives(same, poses))
        self.assertFalse(replay_run.needs_lives(swap, replay_run.poses_json(poses_of({7:[(1.0, A)]}))))
        value = json.loads(zlib.decompress(replay_run.pack_store('n', swap + [replay_run.json_poses(poses)], {}, {})).decode('ascii'))
        value['poses'].pop('lives')
        data = zlib.compress(json.dumps(value).encode('ascii'))
        with self.assertRaises(ValueError): replay_run.unpack_store(data)
        value['records'] = same
        self.assertEqual(len(replay_run.unpack_store(zlib.compress(json.dumps(value).encode('ascii')))[0]), 3)

    def test_the_estimate_splits_a_vehicle_id_by_its_lives(self):
        """Two lives of one id: each life's tracers are estimated with its own gun and its own track only."""
        poses = poses_of({7:[(1.0, A), (50.0, B)]}, {7:[1.0 + i * 0.1 for i in range(900)]})
        poses['guns'][7] = (array.array('f', [1.0 + i * 0.1 for i in range(900)]), array.array('l', [0] * 900))
        tracer = lambda t, n: {'type':'shot', 'event':'tracer', 'shooterId':7, 'shotId':n, 'gameTime':100.0 + t,
                               'velocity':[0, 0, 1], 'origin':[0, 0, 0]}
        records = [tracer(20.0, 1), tracer(60.0, 2), poses]
        asked = []

        def inputs(compact):
            asked.append(compact)
            raise ValueError(compact)

        rao.attach(records, inputs)
        self.assertEqual(sorted(asked), sorted([A, B]))
        self.assertIn(A, records[0][rao.KEY]['reason'])
        self.assertIn(B, records[1][rao.KEY]['reason'])
        tracks = rao.life_tracks(poses['positions'][7], poses['guns'][7], 50.0, None)
        self.assertGreaterEqual(min(tracks[0][0]), 50.0)
        self.assertEqual(len(tracks[0][1]), 6 * len(tracks[0][0]))


if __name__ == '__main__':
    unittest.main()
