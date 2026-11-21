# -*- coding: utf-8 -*-
"""The hit scene rebuilt from the replay beside the recorder's snapshot (replay_scene.py, Exporter.publish_replay).

    python -m pytest tests/test_replay_scene.py -q       the checks (CPython 3)
    python tests/test_replay_scene.py --report           the counts and distributions of the six local battles
    python tests/test_replay_scene.py --write            write the digest table tests/py27/replay_scene.py compares with

The measurement this implements: outputs/replay-scene-recompute-2026-11-11.md. On the four battles with both sources the
mod's 'replayScene' reproduces the prototype (work/replay-scene-2026-11-11, its per-hit result kept in PROTOTYPE); on the
two death-camera battles the 10 replay-only hits get a scene whose points lie on the model; every matched hit carries the
comparison with its snapshot. A vehicle's statics come from STATICS - written by tests/py27/replay_scene.py with the mod's
own exporter.scene_statics on the client's offline stand; the part models are extracted from the installed client's
packages by the exporter's own model_extract. Without these local fixtures the fixture checks skip; the synthetic ones run
on a clean clone.
"""
from __future__ import print_function
import copy
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
from local_armor_inspector import replay_scene as rs  # noqa: E402

FIXTURES = os.path.join(ROOT, 'tests', 'fixtures-local', 'replay-scene-2026-11-11')
STATICS = os.path.join(FIXTURES, 'statics.json')
PROTOTYPE = os.path.join(FIXTURES, 'prototype.json')
DIGESTS = os.path.join(FIXTURES, 'digests.json')
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
MODEL_VERSION = 'replay-scene-test\n'
_CACHE = {}


# ---- shared with tests/py27/replay_scene.py ---------------------------------------------------------------------------
def read_json(path):
    if not os.path.isfile(path): return None
    with open(path, 'rb') as stream: return json.loads(stream.read().decode('utf-8'))


def statics_table():
    return read_json(STATICS)


def model_exporter():
    """One exporter that extracts part models from the installed client into a temporary folder (kept for the run)."""
    if 'models' not in _CACHE:
        from local_armor_inspector.exporter import Exporter
        folder = tempfile.mkdtemp(prefix='bullba-scene-models-')
        _CACHE['models'] = Exporter(GAME, folder, MODEL_VERSION, os.path.join(folder, 'unused.wotmod'))
    return _CACHE['models']


def make_source(table, models=None):
    from local_armor_inspector.exporter import SceneSource

    class TableSource(SceneSource):
        """exporter.SceneSource with each descriptor's statics from the table the stand wrote."""

        def statics(self, compact):
            if compact not in table: raise KeyError('no statics of this descriptor in the table')
            return copy.deepcopy(table[compact])

    return TableSource(models or model_exporter(), MODEL_VERSION)


def digest(battle):
    """What the py27 run and this one must both give: counts, and a hash of the rounded numbers."""
    rows, counts = [], {'scenes':0, 'points':0, 'resolved':0, 'within1cm':0, 'incidence':0, 'nominal':0}
    for hit in battle.get('hits') or ():
        scene = hit.get('replayScene')
        if not scene: continue
        counts['scenes'] += 1
        # the pose at the drawn moment, interpolated (12.11): Python 2.7 and CPython give the same angles and delay
        rows.append([hit['id'], 'pose'] + [round(float(x or 0), 4) for x in (scene.get('poseDelay'), scene['target'].get('turretYaw'),
                                                                             scene['target'].get('gunPitch'))])
        for k, p in enumerate(scene['points']):
            counts['points'] += 1
            counts['resolved'] += p.get('status') == 'resolved'
            rows.append([hit['id'], k, p.get('status'), [round(x, 4) for x in p.get('position') or ()], round(p.get('incidence') or 0, 3)])
            compared = (scene.get('comparison') or {}).get('points') or ()
            c = compared[k] if k < len(compared) else {}
            if c.get('distance') is not None and c['distance'] <= 0.01: counts['within1cm'] += 1
            if c.get('incidenceDiff') is not None and abs(c['incidenceDiff']) <= 1e-4: counts['incidence'] += 1
            if c.get('nominalDiff') == 0: counts['nominal'] += 1
    counts['hash'] = hashlib.sha1(json.dumps(rows, sort_keys=True).encode('utf-8')).hexdigest()[:16]
    return counts


def expected_digest(arena):
    table = read_json(DIGESTS)
    return None if table is None else table.get(arena)


# ---- the battles ------------------------------------------------------------------------------------------------------
def ready():
    import test_replay_battle as T
    import test_replay_records as t
    return (t.fixtures_ready() and t.kill_cam_ready() and T.names_table() is not None and statics_table() is not None
            and os.path.isdir(os.path.join(GAME, 'res', 'packages')))


def published(name, arena, folder):
    """The battle file publish_replay writes from the replay's records (with poses) and the live record."""
    key = ('published', arena)
    if key in _CACHE: return _CACHE[key]
    import test_replay_battle as T
    import test_replay_records as t
    from local_armor_inspector import replay_records as rr
    from local_armor_inspector.exporter import read_data_file
    d = t.defs()
    blocks, stream = t.rd.read_any(os.path.join(folder, name))
    records = rr.convert(t.rd.Decoder(d).decode(stream), header=blocks[0] if blocks else None,
                         vehicle_names=t._CACHE['names'], names=T.table_names(name), poses=True)[0]
    root = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(root, 'battles'))
        source = t.live_path(arena)
        stem = os.path.basename(source)[:-6]
        shutil.copyfile(source, os.path.join(root, 'battles', stem + '.jsonl'))
        e = T.exporter(root)
        table = statics_table()
        e.scene_source = lambda version: make_source(table)
        e.publish_replay(stem, records)
        value = read_data_file(os.path.join(root, 'data', 'battles', stem + '.js'))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    _CACHE[key] = value
    return value


def four():
    import test_replay_battle as T
    return T.FOUR


def kill_cam():
    import test_replay_battle as T
    return T.KILL_CAM


def contact_rows(battle, arena):
    """Per contact point of a hit with both scenes: (arena, hit id, part, comparison row, scene point)."""
    out = []
    for hit in battle['hits']:
        scene = hit.get('replayScene')
        if not scene or 'comparison' not in scene: continue
        for p, c in zip(scene['points'], scene['comparison'].get('points') or ()):
            out.append((arena, hit['id'], p.get('part'), c, p))
    return out


def quantile(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))] if values else None


def summary():
    """The proofs as numbers: per battle and over the four."""
    out = {'four':{'hits':0, 'withScene':0, 'compared':0, 'contacts':0, 'snapshotResolved':0, 'within1cm':0,
                   'incidence':0, 'nominal':0, 'boxes':{}}, 'killCam':{'replayOnly':0, 'withScene':0, 'points':0,
                                                                     'resolvedDirect':0, 'stopDistance':[]},
           'hit':{}}
    yaw = {'own':[], 'other':[]}
    pitch, world, wrot, rng = dict(yaw=[]), {'own':[], 'other':[]}, {'own':[], 'other':[]}, {'own':[], 'other':[]}
    pitch = {'own':[], 'other':[]}
    for name, arena, folder in four():
        b = published(name, arena, folder)
        f = out['four']
        f['hits'] += len(b['hits'])
        f['withScene'] += sum(1 for h in b['hits'] if 'replayScene' in h)
        for k, v in ((b.get('replay') or {}).get('scenes') or {}).get('partBoxes', {}).items():
            f['boxes'][k] = f['boxes'].get(k, 0) + v
        for h in b['hits']:
            s = h.get('replayScene') or {}
            c = s.get('comparison')
            if not c: continue
            f['compared'] += 1
            side = 'own' if h.get('targetId') == b.get('playerVehicleId') else 'other'
            for d, key in ((yaw, 'turretYawDiff'), (pitch, 'gunPitchDiff'), (world, 'worldShift'), (wrot, 'worldRotation'),
                           (rng, 'rangeDiff')):
                if c.get(key) is not None: d[side].append(abs(c[key]))
        for _, hid, part, c, p in contact_rows(b, arena):
            f['contacts'] += 1
            if c.get('distance') is None: continue
            f['snapshotResolved'] += 1
            f['within1cm'] += c['distance'] <= 0.01
            f['incidence'] += c.get('incidenceDiff') is not None and abs(c['incidenceDiff']) <= 1e-4
            f['nominal'] += c.get('nominalDiff') == 0
    for name, d in (('turretYawDiff', yaw), ('gunPitchDiff', pitch), ('worldShift', world), ('worldRotation', wrot),
                    ('rangeDiff', rng)):
        out['four'][name] = dict((side, {'n':len(v), 'median':quantile(v, 0.5), 'p90':quantile(v, 0.9), 'max':max(v) if v else None})
                                 for side, v in d.items())
    for name, arena, folder in kill_cam():
        b = published(name, arena, folder)
        k = out['killCam']
        for h in b['hits']:
            if not str(h['id']).startswith('r'): continue
            k['replayOnly'] += 1
            s = h.get('replayScene')
            if not s: continue
            k['withScene'] += 1
            for p in s['points']:
                k['points'] += 1
                k['resolvedDirect'] += p.get('status') == 'resolved' and p.get('collision') == 'direct'
            if s.get('stopDistance') is not None: k['stopDistance'].append(s['stopDistance'])
    return out


# ---- tests ------------------------------------------------------------------------------------------------------------
def box_model():
    """A unit cube's model file value: 12 triangles, materials by face."""
    v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    faces = {'armor_1':[0, 2, 1, 0, 3, 2], 'armor_2':[4, 5, 6, 4, 6, 7], 'armor_3':[0, 1, 5, 0, 5, 4],
             'armor_4':[3, 7, 6, 3, 6, 2], 'armor_5':[0, 4, 7, 0, 7, 3], 'armor_6':[1, 2, 6, 1, 6, 5]}
    return {'resource':'cube.havok', 'groups':[{'material':m, 'vertices':v, 'indices':ix} for m, ix in sorted(faces.items())]}


def encode(start_q, end_q, part=1, effect=3):
    seg = effect | (part << 8)
    for i in range(3):
        seg |= start_q[i] << (16 + 8 * i)
        seg |= end_q[i] << (40 + 8 * i)
    return seg


class SyntheticTests(unittest.TestCase):
    def test_decode_and_collide_on_a_cube_with_its_true_box(self):
        model = rs.Model(box_model(), 'k')
        box = ([-0.5, -0.5, -0.5], [1.5, 1.5, 1.5])
        seg = encode([127, 127, 0], [127, 127, 255])
        s, e = rs.decode_segment(seg, box)
        found = rs.collide_hit_point(model, box, s, e)
        self.assertIsNotNone(found)
        position, direction, tri, how = found
        self.assertAlmostEqual(position[2], 0.0, 9)
        self.assertEqual((tri[12], how), ('armor_1', 'direct'))
        self.assertLess(rs.dot(rs.facing(tri, direction), direction), 0)

    def test_a_recovered_box_is_the_one_the_client_decoded_with(self):
        box = ([-0.4, -0.81, -2.5], [1.5, 1.26, 1.5])
        hits = []
        for k, (qs, qe) in enumerate((([10, 20, 30], [200, 120, 90]), ([50, 60, 70], [80, 250, 10]))):
            seg = encode(qs, qe)
            s, e = rs.decode_segment(seg, box)
            hits.append({'target':{'parts':[{'id':1, 'resource':'hull.model'}]},
                         'rawHitPoints':[{'segment':str(seg)}], 'points':[{'part':1, 'start':s, 'end':e}]})
        lo, hi, source, residual = rs.recover_boxes(hits)['hull.model']
        self.assertEqual(source, 'recovered')
        for i in range(3):
            self.assertAlmostEqual(lo[i], box[0][i], 9)
            self.assertAlmostEqual(hi[i], box[1][i], 9)

    def test_pose_between_packets_and_packed_angles(self):
        tracks = rs.Tracks()
        tracks.position(7, 1.0, [0, 0, 0], math.pi - 0.1, 0, 0)
        tracks.position(7, 1.1, [1, 0, 0], -math.pi + 0.1, 0, 0)
        rec = tracks.record(1, 100.0)
        row, gap = rs.pose_at(rec['positions'][7], 1.05)
        self.assertEqual(gap, 0.0)
        self.assertAlmostEqual(row[0], 0.5, 6)
        self.assertAlmostEqual(abs(rs.wrap(row[3])), math.pi, 5)   # the short way across +-pi
        yaw, pitch = rs.packed_angles((512 << 6) | 63, [-0.2, 0.1])
        self.assertAlmostEqual(yaw, 0.0, 9)
        self.assertAlmostEqual(pitch, 0.1, 9)

    def test_the_pose_is_the_servers_at_two_moments(self):
        """20.11 (outputs/shot-reconstruction-2026-11-20.md; was the client's drawn moment, drawn_delay): the position and
        hull 0.2 s before the hit packet, the turret and gun 0.1 s before it - the two moments the server collided at,
        measured on 6 036 hits of 276 replays."""
        tracks = rs.Tracks()
        for k in range(100):
            tracks.position(7, k * 0.1, [k * 0.1, 0, 0], k * 0.01, 0, 0)   # 1 m/s along x, the hull turning 0.1 rad/s
        for k in range(100):
            tracks.gun(7, k * 0.1, ((512 + k) << 6) | 0)                    # the turret one packed step every 0.1 s
        tracks.public(7, b'\x01\x02')
        rec = tracks.record(1, 100.0)
        scene = self.scene_of(rec, 7, 5.0)
        self.assertEqual((scene['poseDelay'], scene['anglesDelay']), (0.2, 0.1))
        world = scene['target']['worldTransform']
        self.assertAlmostEqual(world[12], 4.8, 5)                          # x at 5.0 - 0.2 s
        self.assertAlmostEqual(math.atan2(world[8], world[10]), 0.48, 5)   # hull yaw at 4.8 s
        self.assertAlmostEqual(scene['target']['turretYaw'], 49 * 2 * math.pi / 1024, 5)   # angles at 4.9 s

    def scene_of(self, poses, target, when, limits=(-0.2, 0.1)):
        statics = {'type':'x:y', 'hullPosition':[0, 1, 0], 'turretPosition':[0, 1, 0], 'turretPitch':0.0,
                   'gunPosition':[0, 0, 1], 'pitchLimits':list(limits), 'parts':[]}

        class Source(object):
            def statics(self, compact): return statics

            def model(self, resource): raise KeyError(resource)

        scene, why = rs.Scenes(poses, None, Source()).scene({'gameTime':100.0 + when, 'targetId':target, 'attackerId':9,
                                                              'rawHitPoints':[]})
        self.assertIsNone(why)
        return scene

    def test_packed_angles_are_interpolated_to_the_servers_moment(self):
        """Another vehicle's turret between its packed samples, linear (20.11: at the server's moment, SERVER_ANGLES_DELAY
        before the hit; until then at the drawn moment): halfway between two samples, halfway between their angles."""
        tracks = rs.Tracks()
        for k in range(100):
            tracks.position(7, k * 0.1, [0, 0, 0], 0, 0, 0)
        tracks.gun(7, 5.0, (512 << 6) | 0)        # yaw 0, pitch at the lower limit
        tracks.gun(7, 5.1, (522 << 6) | 63)       # yaw 10 steps on, pitch at the upper limit
        tracks.public(7, b'\x01\x02')
        rec = tracks.record(1, 100.0)
        scene = self.scene_of(rec, 7, 5.05 + rs.SERVER_ANGLES_DELAY)
        self.assertAlmostEqual(scene['poseDelay'], rs.SERVER_POSE_DELAY, 9)
        self.assertAlmostEqual(scene['target']['turretYaw'], 5 * 2 * math.pi / 1024, 5)
        self.assertAlmostEqual(scene['target']['gunPitch'], -0.05, 5)
        self.assertTrue(scene['angles']['interpolated'])

    def test_wheels_and_prefabs_as_the_snapshot_carries_them(self):
        """12.11: a wheel is part -k at its rest place with its procedural body (the page draws it from 'wheel' and
        'material'); a contact past the static parts is the wheel maxStaticPartIndex - index, decoded on the wheel's box and
        resolved on its prism; a contact with a network id is on the armoured prefab, posed at its default layer on its parent."""
        tracks = rs.Tracks()
        for k in range(50):
            tracks.position(7, k * 0.1, [0, 0, 0], 0, 0, 0)
        tracks.gun(7, 0.0, 512 << 6)
        tracks.public(7, b'\x01\x02')
        rec = tracks.record(1, 100.0)
        armor = {'wheel':{'armor':10.0}}
        base = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0.0, 0.5, 2.0, 1.0]
        statics = {'type':'x:y', 'hullPosition':[0, 1, 0], 'turretPosition':[0, 1, 0], 'turretPitch':0.0,
                   'gunPosition':[0, 0, 1], 'pitchLimits':[-0.2, 0.1],
                   'parts':[{'id':i, 'name':n, 'resource':'cube.model'} for i, n in enumerate(('chassis', 'hull', 'turret', 'gun'))],
                   'wheels':[{'id':-1, 'name':'W_L0', 'material':'wheel', 'armor':armor,
                              'wheel':{'radius':0.5, 'width':0.4, 'sides':16},
                              'transform':[1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, -1.2, 0.5, 1.5, 1.0]}],
                   'prefabs':[{'name':'crest_module', 'prefab':'p.prefab', 'parentPart':3, 'resource':'cube.model',
                               'armor':{'armor_1':{'armor':5.0}}, 'prefabLayers':[], 'prefabDefault':'0 position layer',
                               'prefabBase':base}]}

        class Source(object):
            def statics(self, compact): return statics

            def model(self, resource): return 'key', box_model()

        # a wheel contact straight down the axle (network 0, index 4 = wheel -1), one on the prefab (a network id)
        wheel_seg = encode([0, 127, 127], [255, 127, 127], part=4)
        prefab_seg = encode([127, 127, 0], [127, 127, 255], part=0)
        scene, why = rs.Scenes(rec, None, Source()).scene({'gameTime':103.0, 'targetId':7, 'attackerId':9, 'rawHitPoints':[
            {'networkID':'0', 'segment':str(wheel_seg), 'params':'0'}, {'networkID':'77', 'segment':str(prefab_seg), 'params':'0'}]})
        self.assertIsNone(why)
        parts = dict((p['id'], p) for p in scene['target']['parts'])
        self.assertEqual((parts[-1]['poseFrom'], parts[-1]['material'], parts[-1]['wheel']['radius']), ('rest', 'wheel', 0.5))
        self.assertEqual(parts[-1]['bounds'], [[-0.2, -0.5, -0.5], [0.2, 0.5, 0.5]])
        self.assertEqual((parts[4]['poseFrom'], parts[4]['parentPart'], parts[4]['modelKey']), ('default', 3, 'key'))
        for a, b in zip(parts[4]['transform'], rs.mm(parts[3]['transform'], base)): self.assertAlmostEqual(a, b, 5)
        wheel, prefab = scene['points']
        self.assertEqual((wheel['part'], wheel['status'], wheel['material'], wheel['nominal']), (-1, 'resolved', 'wheel', 10.0))
        self.assertAlmostEqual(abs(wheel['position'][0]), 0.2, 6)       # the prism's side face, at the axle
        self.assertEqual((prefab['part'], prefab['status']), (4, 'resolved'))

    def test_own_turret_floats_where_it_has_no_packed_angles(self):
        """20.11: the own vehicle takes its packed angles like any other (the server's); its turret_yaw / gun_pitch floats
        only without them, at the same moment (was OWN_TURRET_DELAY 0.09 s, the own pose OWN_POSE_DELAY 0.22 s)."""
        tracks = rs.Tracks()
        for k in range(100):
            tracks.position(1, k * 0.1, [0, 0, 0], 0, 0, 0)
        tracks.own_angle('yaw', 5.0, 0.2)
        tracks.own_angle('yaw', 5.1, 0.4)
        tracks.own_angle('pitch', 5.0, -0.1)
        tracks.own_angle('pitch', 5.1, 0.1)
        tracks.public(1, b'\x01\x02')
        rec = tracks.record(1, 100.0)
        scene = self.scene_of(rec, 1, 5.025 + rs.SERVER_ANGLES_DELAY)
        self.assertAlmostEqual(scene['target']['turretYaw'], 0.25, 5)
        self.assertAlmostEqual(scene['target']['gunPitch'], -0.05, 5)
        self.assertAlmostEqual(scene['poseDelay'], rs.SERVER_POSE_DELAY, 9)
        self.assertEqual(scene['angles']['from'], 'own turret_yaw / gun_pitch')

    def test_a_descriptor_changed_within_a_life_is_kept_from_its_moment(self):
        """20.11: Steel Hunter and Onslaught upgrade a vehicle within one life (the same nation and type, another
        descriptor); until then the last one overwrote the life's and every earlier hit was rebuilt on the later hull
        (2 153 contacts decoded on another box). The arena list's row is still replaced by the entity's first descriptor."""
        tracks = rs.Tracks()
        tracks.public(7, b'listed', 0.0, ('n', 1), listed=True)
        tracks.public(7, b'hull-1', 1.0, ('n', 1))
        tracks.public(7, b'hull-1', 2.0, ('n', 1))
        tracks.public(7, b'hull-3', 50.0, ('n', 1))
        rec = tracks.record(1, 100.0)
        hull1, hull3 = rs.compact_text(b'hull-1'), rs.compact_text(b'hull-3')
        self.assertEqual([c for _, c in rs.lives_of(rec, 7)], [hull1, hull3])
        self.assertEqual((rs.compact_at(rec, 7, 20.0), rs.compact_at(rec, 7, 60.0)), (hull1, hull3))

    def test_the_snapshots_descriptor_wins(self):
        """20.11: a hit with a snapshot is rebuilt on the snapshot's own descriptor (the client's at the hit) - a store
        written before the lives kept upgrades has only the last one."""
        self.assertEqual(rs.snapshot_compact({'target':{'vehicleRef':'kRYjACQA#1:abcdef'}}), 'kRYjACQA')
        self.assertEqual(rs.snapshot_compact({'target':{'compactDescriptor':'QQ=='}}), 'QQ==')
        self.assertIsNone(rs.snapshot_compact({'target':None}))

    def test_the_contact_is_the_servers(self):
        """20.11: the segment ends CONTACT_PAST (+ the decoder's 1 % push) past the server's contact. Two plates: at
        z = 0 (armor_1) and z = 0.6 (armor_2); the shell's line along +z. A segment ending 0.5 m past z = 0 -> the game's
        point is the server's ('segment'); one ending 0.5 m past z = 0.6 - the game stops at z = 0, the server went on to
        0.6 -> the point moves there ('server'); one ending past z = 0.1, where neither model has armour: the plate the tracer's
        line meets in the server's pose when it lies within LINE_REACH of the server's contact ('tracer', an estimate), else
        - no tracer, or its plate farther off - the game's point kept ('client')."""
        def square(z, material):
            v = [[-1, -1, z], [1, -1, z], [1, 1, z], [-1, 1, z]]
            return {'material':material, 'vertices':v, 'indices':[0, 1, 2, 0, 2, 3]}
        model = rs.Model({'resource':'two.model', 'groups':[square(0.0, 'armor_1'), square(0.6, 'armor_2')]}, 'k')
        armor = {'armor_1':{'armor':40.0}, 'armor_2':{'armor':20.0}}
        parts = {1:({'id':1, 'transform':rs.T(0, 0, 0)}, model, None, armor)}

        def point(z_contact):
            # the decoded segment: the 1 % push on both ends included (end = contact + 0.5 + 0.01 L0)
            s0, e0 = [0.1, 0.1, -0.4], [0.1, 0.1, z_contact + 0.5]
            span = e0[2] - s0[2]
            s, e = [s0[0], s0[1], s0[2] - 0.01 * span], [e0[0], e0[1], e0[2] + 0.01 * span]
            position, direction, tri, how = rs.collide_hit_point(model, None, s, e)
            return {'status':'resolved', 'part':1, 'start':s, 'end':e, 'position':position, 'direction':direction,
                    'material':tri[12], 'incidence':0.0, 'nominal':armor[tri[12]]['armor']}

        scenes = rs.Scenes({'playerVehicleId':1, 'serverTimeAtStart':0.0, 'positions':{}, 'guns':{}}, None, None)
        out = {'points':[point(0.0)], 'limits':[]}
        scenes.server_contacts(out, parts, rs.T(0, 0, 0), None)
        self.assertEqual(out['points'][0]['contact'], 'segment')
        self.assertLess(out['points'][0]['contactGap'], 1e-6)
        out = {'points':[point(0.6)], 'limits':[]}
        scenes.server_contacts(out, parts, rs.T(0, 0, 0), None)
        p = out['points'][0]
        self.assertEqual((p['contact'], p['material'], p['nominal']), ('server', 'armor_2', 20.0))
        self.assertAlmostEqual(p['position'][2], 0.6, 6)
        self.assertAlmostEqual(p['contactGap'], 0.6, 6)
        self.assertEqual(p['client']['material'], 'armor_1')
        out = {'points':[point(0.1)], 'limits':[]}
        scenes.server_contacts(out, parts, rs.T(0, 0, 0), None)
        self.assertEqual(out['points'][0]['contact'], 'client')
        # the tracer straight along +z, no gravity: at x = 0.15 its plate (z = 0) is 0.11 m from the server's contact
        # (0.1, 0.1, 0.1) - taken; at x = 0.5 it is 0.42 m off - another plate, the game's point kept
        def flight(x): return ({'origin':[x, 0.1, -50.0], 'velocity':[0.0, 0.0, 800.0], 'gravity':0.0}, {'position':[x, 0.1, 0.1]})
        out = {'points':[point(0.1)], 'limits':[]}
        scenes.server_contacts(out, parts, rs.T(0, 0, 0), flight(0.5))
        self.assertEqual(out['points'][0]['contact'], 'client')
        out = {'points':[point(0.1)], 'limits':[]}
        scenes.server_contacts(out, parts, rs.T(0, 0, 0), flight(0.15))
        p = out['points'][0]
        self.assertEqual((p['contact'], p['material'], p['nominal'], p['segmentPart']), ('tracer', 'armor_1', 40.0, 1))
        self.assertAlmostEqual(p['position'][0], 0.15, 6)
        self.assertAlmostEqual(p['position'][2], 0.0, 6)
        self.assertAlmostEqual(p['incidence'], 0.0, 4)
        self.assertEqual(out['limits'], [rs.LIMIT_TRACER])
        self.assertAlmostEqual(rs.flight_time([0, 0, 0], [100.0, 0, 0], 9.81, [50.0, -0.5 * 9.81 * 0.25, 0]), 0.5, 6)


@unittest.skipUnless(ready(), 'the local replay fixtures, the statics table or the client are absent')
class FixtureTests(unittest.TestCase):
    def test_four_battles_reproduce_the_prototype(self):
        """Proof 1 and 3: every matched hit gets the scene and its comparison; the points, incidence and armour agree
        with the snapshot at least as often as the prototype's (195, 197, 198 of 199); per hit the numbers equal the
        prototype's result (PROTOTYPE) where both used the same box."""
        s = summary()['four']
        self.assertEqual(s['withScene'], s['hits'])
        self.assertEqual(s['compared'], 176)
        self.assertEqual(s['snapshotResolved'], 199)
        self.assertGreaterEqual(s['within1cm'], 195)
        self.assertGreaterEqual(s['incidence'], 197)
        self.assertGreaterEqual(s['nominal'], 198)
        prototype = read_json(PROTOTYPE)
        if prototype is None: self.skipTest('no prototype table')
        diffs = []
        # The pose: the prototype took it 0.2 s before the hit packet and the last packed angles. Since 20.11 the mod takes
        # the SERVER's moments (outputs/shot-reconstruction-2026-11-20.md): the position 0.2 s back, as the prototype - its
        # world difference to the snapshot no larger than the prototype's at p90 -, the turret and gun 0.1 s back, where the
        # snapshot (the game's drawing, ~0.2 s back) is no measure: their difference to it is the game's lag now (turret
        # p90 3.7 / 5.4 degrees other / own on these battles), checked against the tracer instead (the 276-battle measure).
        # The points stay per hit.
        mine, theirs = {}, {}
        for name, arena, folder in four():
            b = published(name, arena, folder)
            for h in b['hits']:
                c = (h.get('replayScene') or {}).get('comparison')
                ref = prototype.get('%s|%s' % (arena, h['id']))
                if not c or not ref: continue
                side = 'own' if h.get('targetId') == b.get('playerVehicleId') else 'other'
                for key in ('worldShift',):
                    if ref.get(key) is not None and c.get(key) is not None:
                        mine.setdefault((side, key), []).append(abs(c[key]))
                        theirs.setdefault((side, key), []).append(abs(ref[key]))
                # A point no further from the snapshot's than the prototype's (better where the prototype had no box).
                for k, (p, q) in enumerate(zip(ref['points'], c.get('points') or ())):
                    if p.get('posErr') is not None and q.get('distance') is not None and q['distance'] > p['posErr'] + 1e-4:
                        diffs.append((arena, h['id'], 'point %d' % k, p['posErr'], q['distance']))
        # The tail (p90) decides the verdicts that flip; the median of the others' turret rose on these four battles from
        # 0.04 to 0.11 degrees (a stationary turret on its packed value against an interpolation at a slightly other
        # moment), still a third of a packed step - and fell on the 33 battles of 11.11 (0.157 -> 0.126).
        for key, values in sorted(mine.items()):
            if quantile(values, 0.9) > quantile(theirs[key], 0.9) + 0.02:
                diffs.append(('pose', key, quantile(theirs[key], 0.9), quantile(values, 0.9)))
        self.assertEqual(diffs, [])

    def test_the_hulls_are_compared_in_the_world(self):
        """12.11: every compared hit with both world transforms says how far apart the two hulls are in the world (the
        packet's orientation is the hull's for a hydropneumatic vehicle, the chassis's otherwise)."""
        for name, arena, folder in four():
            for h in published(name, arena, folder)['hits']:
                c = (h.get('replayScene') or {}).get('comparison') or {}
                if c.get('worldRotation') is not None:
                    self.assertGreaterEqual(c['hullWorld']['rotation'], 0.0)
                    self.assertGreaterEqual(c['hullWorld']['shift'], 0.0)

    def test_death_camera_hits_get_their_only_scene(self):
        """Proof 2: the 10 replay-only hits of the two October battles have a scene, every point on the model."""
        k = summary()['killCam']
        self.assertEqual((k['replayOnly'], k['withScene']), (10, 10))
        self.assertEqual(k['resolvedDirect'], k['points'])

    def test_py27_and_cpython_agree(self):
        for name, arena, folder in four() + kill_cam():
            expected = expected_digest(arena)
            if expected is None: continue
            self.assertEqual(digest(published(name, arena, folder)), expected, arena)


def main():
    if '--write' in sys.argv:
        table = {}
        for name, arena, folder in four() + kill_cam():
            table[arena] = digest(published(name, arena, folder))
        if not os.path.isdir(FIXTURES): os.makedirs(FIXTURES)
        with open(DIGESTS, 'w') as stream: json.dump(table, stream, indent=1, sort_keys=True)
        print('written', DIGESTS)
    if '--report' in sys.argv:
        print(json.dumps(summary(), indent=1, sort_keys=True))


if __name__ == '__main__':
    main()
