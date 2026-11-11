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
        for name, arena, folder in four():
            b = published(name, arena, folder)
            for h in b['hits']:
                c = (h.get('replayScene') or {}).get('comparison')
                ref = prototype.get('%s|%s' % (arena, h['id']))
                if not c or not ref: continue
                for key in ('turretYawDiff', 'gunPitchDiff', 'worldShift', 'worldRotation', 'rangeDiff'):
                    if ref.get(key) is None or c.get(key) is None:
                        if (ref.get(key) is None) != (c.get(key) is None): diffs.append((arena, h['id'], key, ref.get(key), c.get(key)))
                        continue
                    # The prototype took the rotation's angle by acos of the trace, which the live matrices' columns (4.5e-6
                    # off unit length) move by up to 0.09 degrees at small angles (MEASURED: median 0.0008, max 0.089 over
                    # 176 hits; 17:42 hit 20: acos 0.283, the mod's axis-and-trace angle 0.226 for the same matrices).
                    if abs(abs(ref[key]) - abs(c[key])) > (0.1 if key == 'worldRotation' else 2e-3):
                        diffs.append((arena, h['id'], key, ref[key], c[key]))
                # A point no further from the snapshot's than the prototype's (better where the prototype had no box).
                for k, (p, q) in enumerate(zip(ref['points'], c.get('points') or ())):
                    if p.get('posErr') is not None and q.get('distance') is not None and q['distance'] > p['posErr'] + 1e-4:
                        diffs.append((arena, h['id'], 'point %d' % k, p['posErr'], q['distance']))
        self.assertEqual(diffs, [])

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
