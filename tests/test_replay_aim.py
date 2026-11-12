# -*- coding: utf-8 -*-
"""The own aim circles rebuilt from the replay (replay_aim.py, BACKLOG 82): the block on a small synthetic stream, its
comparison with a snapshot, and - when the 33 battles of 11.11.2026 are on this computer - the table of the measurement
(outputs/aim-circles-from-replay-2026-11-11.md section 3) made by the product code (tests/replay_aim_table.py).

    python -m pytest tests/test_replay_aim.py -q
"""
import copy
import math
import os
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
import replay_aim_synthetic as S  # noqa: E402
from local_armor_inspector import replay_aim as ra  # noqa: E402
from local_armor_inspector import replay_objects as rc  # noqa: E402
from local_armor_inspector import replay_records as rrec  # noqa: E402
from local_armor_inspector import replay_battle as rb  # noqa: E402


def track(data):
    t = ra.Track()
    for ev in S.events(data): t.feed(ev)
    return t


def close(a, b, tol=1e-4):
    return all(abs(x - y) <= tol for x, y in zip(a, b)) and len(a) == len(b)


class DecoderNames(unittest.TestCase):
    def test_0x1a_fields_by_position(self):
        """Packet 0x1a: floats 0-2 the cursor point, 3 the reticle diameter, 4 its dual-accuracy diameter, 5-7 its position,
        8-10 the shell's direction there, 11 the arcade reticle diameter, 12 the dual-accuracy size, 13-14 the SPG pair."""
        ev = rc.small_packet(0x1a, 1.0, struct.pack('<15f', *range(15)))
        self.assertEqual(ev['ev'], 'client_gun_marker')
        self.assertEqual((ev['point'], ev['markerDiameter'], ev['dualAccDiameter'], ev['markerPosition'], ev['markerDirection'],
                          ev['arcadeDiameter'], ev['dualAccSize'], ev['spg']),
                         ([0, 1, 2], 3, 4, [5, 6, 7], [8, 9, 10], 11, 12, [13, 14]))


class Block(unittest.TestCase):
    def test_the_press_the_reticles_and_the_disc(self):
        """Tracer at clock 3.0 from the gun of tick 19 (clock 2.9): press = 3.0 - (0.05 + 0.05) = 2.9 -> tick 19's 0x1a
        and 0x39; the disc is tick 19 (the last update strictly before the tracer, at the shell's origin)."""
        t = track(S.stream())
        b = t.block(3.0, S.gun(19), S.START)
        self.assertAlmostEqual(b['press']['ping'], 0.05)
        self.assertAlmostEqual(b['press']['delta'], 0.10)
        self.assertAlmostEqual(b['press']['gameTime'], S.START + 2.9, places=5)
        self.assertEqual(b['markerSource'], 'server reticle')
        self.assertTrue(close(b['serverMarker']['position'], [0.0, 2.0, 9.5 + S.RANGE]))
        self.assertAlmostEqual(b['serverMarker']['diameter'], 2 * S.dispersion(19) * S.RANGE, places=4)
        self.assertEqual(b['lastServerGunUpdate']['tick'], 100019)
        self.assertTrue(close(b['gunOrigin'], S.gun(19)))
        self.assertTrue(b['clientMarker']['approximate'])
        self.assertTrue(close(b['clientMarker']['position'], [0.3, 2.0, 9.5 + S.RANGE]))
        self.assertAlmostEqual(b['clientMarker']['diameter'], 2.2 * S.dispersion(19) * S.RANGE, places=4)
        self.assertEqual((b['shotUpdate']['tick'], b['shotUpdate']['from']), (100019, 'origin'))
        self.assertAlmostEqual(b['shotUpdate']['dispersionAngle'], S.dispersion(19), places=6)
        self.assertIn('dispersionAngles', b['absent'])
        self.assertTrue(b['limits'])

    def test_the_disc_looks_back_for_the_shells_origin(self):
        """The shell left from tick 17's gun: the update of that origin, two ticks back; a shell from nowhere near any
        update gets the nearest one, said 'nearest'."""
        t = track(S.stream())
        self.assertEqual(t.block(3.0, S.gun(17), S.START)['shotUpdate']['tick'], 100017)
        far = t.block(3.0, [50.0, 2.0, 9.0], S.START)['shotUpdate']
        self.assertEqual(far['from'], 'nearest')
        self.assertGreater(far['gap'], 1.0)

    def test_without_a_ping_and_without_the_server_reticle(self):
        """No 0x1f before the tracer: the press is 0.10 s before it. Fields 3-10 that are no 0x39's reticle (the server
        reticle hidden or not updated): no serverMarker, the client reticle still the cursor point's, the limit said."""
        b = track(S.stream(ping=False)).block(3.0, S.gun(19), S.START)
        self.assertAlmostEqual(b['press']['delta'], ra.PRESS_NO_PING)
        self.assertIsNone(b['press']['ping'])
        hidden = track(S.stream(hidden=True)).block(3.0, S.gun(19), S.START)
        self.assertEqual(hidden['markerSource'], 'client reticle')
        self.assertNotIn('serverMarker', hidden)
        self.assertTrue(close(hidden['clientMarker']['position'], [0.3, 2.0, 9.5 + S.RANGE]))
        self.assertIn(ra.LIMIT_HIDDEN, hidden['limits'])
        self.assertEqual(hidden['shotUpdate']['tick'], 100019)   # the disc is the 0x39's either way

    def test_the_converter_puts_the_block_on_each_own_main_gun_tracer(self):
        """replay_records.Converter: the own tracer of the main gun gets the block (a two-gun salvo's mean origin); a
        ricochet's continuation and another installation's tracer do not."""
        data = S.stream()
        a, b = S.gun(19), S.gun(19)
        a[0] -= 0.2
        b[0] += 0.2
        tracers = [S.tracer_event(3.0, a, 7), S.tracer_event(3.0, b, 8), S.tracer_event(3.2, S.gun(21), 7, ricochet=True),
                   S.tracer_event(3.0, S.gun(19), 9, gun_installation=1)]
        out = rrec.convert(S.battle_events(data, tracers))[0]
        shots = [r for r in out if r.get('type') == 'shot' and r.get('event') == 'tracer']
        self.assertEqual([ra.KEY in s for s in shots], [True, True, False, False])
        block = shots[0][ra.KEY]
        self.assertEqual((block['salvo'], block['shotUpdate']['tick'], block['shotUpdate']['from']), (2, 100019, 'origin'))
        self.assertAlmostEqual(block['press']['tracerGameTime'], S.START + 3.0, places=4)


class Comparison(unittest.TestCase):
    def published(self, snapshot_shift=0.0, after=None):
        """The published shots of a battle whose own tracer has the replay block and a live snapshot equal to the replay's
        reticles at the press (its client reticle moved by `snapshot_shift` m sideways)."""
        records = rrec.convert(S.battle_events(S.stream(), [S.tracer_event(3.0, S.gun(19), 7)]))[0]
        replay = next(r for r in records if r.get('event') == 'tracer')
        block = replay[ra.KEY]
        recv = 5000.0
        def at(game): return recv + (game - replay['gameTime'])
        server = dict(block['serverMarker'], receivedAt=at(block['serverMarker']['gameTime']))
        server.pop('from')
        server.pop('dualAccDiameter')
        client = {'position':[block['clientMarker']['position'][0] + snapshot_shift] + block['clientMarker']['position'][1:],
                  'direction':block['clientMarker']['direction'], 'diameter':block['clientMarker']['diameter'],
                  'receivedAt':at(block['press']['gameTime'])}
        update = dict(block['lastServerGunUpdate'], receivedAt=server['receivedAt'])
        live_tracer = {'type':'shot', 'event':'tracer', 'id':'s5', 'shotId':'7', 'gameTime':replay['gameTime'] + 0.05,
                       'receivedAt':recv, 'own':True, 'isRicochet':False, 'gunInstallationIndex':0, 'shooterId':11,
                       'origin':replay['origin'], 'velocity':replay['velocity'],
                       'aimAtTracer':{'clientMarker':client, 'serverMarker':server, 'lastServerGunUpdate':update,
                                      'gunOrigin':block['gunOrigin']}}
        live_shots = [live_tracer] + ([after] if after else [])
        battle, report = rb.build(records, {'hits':[], 'shotEvents':live_shots, 'critEvents':[]}, 'x')
        return battle['shotEvents'], report

    def test_the_snapshot_equal_to_the_replay(self):
        shots, report = self.published()
        t = next(s for s in shots if s.get('event') == 'tracer')
        c = t[ra.KEY]['comparison']
        self.assertEqual((report['aimBlocks'], report['aimCompared'], c['snapshot']), (1, 1, 'tracer'))
        self.assertTrue(c['serverMarker']['same'])
        self.assertLess(c['serverMarker']['centreRadii'], 1e-6)
        self.assertAlmostEqual(c['serverMarker']['sizeRatio'], 1.0, places=6)
        self.assertLess(c['clientMarker']['centreRadii'], 1e-6)
        self.assertAlmostEqual(c['clientMarker']['sizeRatio'], 1.0, places=6)
        self.assertTrue(c['disc']['same'])
        self.assertEqual(c['disc']['snapshotFrom'], 'last')
        # the receipt of each part: the tracer's, moved by the gameTime difference
        b = t[ra.KEY]
        self.assertAlmostEqual(b['serverMarker']['receivedAt'], 5000.0 + b['serverMarker']['gameTime'] - t['gameTime'], places=6)

    def test_offsets_in_radii_and_metres(self):
        """The snapshot's client reticle 1 m to the side at 300 m: the replay's centre is 1 m / 300 m off - in radii of
        the snapshot's ring and in metres at the shot's range (no shell end: the snapshot reticle's range)."""
        shots, _ = self.published(snapshot_shift=1.0)
        c = next(s for s in shots if s.get('event') == 'tracer')[ra.KEY]['comparison']['clientMarker']
        radius = 2.2 * S.dispersion(19) * S.RANGE / 2 / S.RANGE
        angle = math.atan2(1.0, S.RANGE)
        self.assertAlmostEqual(c['centreRadii'], angle / radius, places=3)
        self.assertAlmostEqual(c['centreMetres'], angle * math.hypot(1.0, S.RANGE), places=3)

    def test_the_snapshot_disc_from_the_update_after_the_shot(self):
        """A stale last update (its origin 1 m behind the shell's): the page takes the gunAfterShot update at the shell's
        origin, and that is what the replay's disc is compared with."""
        stale = None
        shots, _ = self.published()
        t = next(s for s in shots if s.get('event') == 'tracer')
        good = copy.deepcopy(t['aimAtTracer']['lastServerGunUpdate'])
        stale = copy.deepcopy(good)
        stale['origin'] = [stale['origin'][0], stale['origin'][1], stale['origin'][2] - 1.0]
        stale['dispersionAngle'] *= 2
        records = rrec.convert(S.battle_events(S.stream(), [S.tracer_event(3.0, S.gun(19), 7)]))[0]
        live = copy.deepcopy(t)
        live.pop(ra.KEY)
        live['aimAtTracer']['lastServerGunUpdate'] = stale
        after = {'type':'shot', 'event':'gunAfterShot', 'id':'s6', 'tracerId':'s5', 'updates':[good], 'gameTime':live['gameTime']}
        battle, _ = rb.build(records, {'hits':[], 'shotEvents':[live, after], 'critEvents':[]}, 'x')
        c = next(s for s in battle['shotEvents'] if s.get('event') == 'tracer')[ra.KEY]['comparison']['disc']
        self.assertEqual((c['same'], c['snapshotFrom'], c['snapshotStale']), (True, 'after', False))

    def test_a_shot_without_a_snapshot_keeps_the_block_alone(self):
        records = rrec.convert(S.battle_events(S.stream(), [S.tracer_event(3.0, S.gun(19), 7)]))[0]
        battle, report = rb.build(records, None, 'x')
        t = next(s for s in battle['shotEvents'] if s.get('event') == 'tracer')
        self.assertIn(ra.KEY, t)
        self.assertNotIn('comparison', t[ra.KEY])
        self.assertEqual((report['aimBlocks'], report['aimCompared']), (1, 0))


# ---- the 33 battles of 11.11.2026, when they are on this computer ------------------------------------------------------
DAY = '2026-11-11'


def local_battles():
    try:
        import replay_aim_table as C
        if not os.path.isdir(os.path.join(C.GAME, 'res', 'packages')): return None
        ids = C.battles(day=DAY)
        return ids if len(ids) == 33 else None
    except Exception:
        return None


@unittest.skipUnless(local_battles(), 'the 33 battles of 11.11.2026 (kept streams and live records) or the client are absent')
class LocalBattles(unittest.TestCase):
    def test_the_measured_table(self):
        """The report's table by the product code: 321 own shots in 31 battles, each with a block and a snapshot to compare;
        the disc identical (the measurement: 318 - its 3 others took the clock of a ricochet's tracer of the same shot
        id); the server reticle where the replay holds it (273: exactly the shots whose recorded one is <= 0.15 s old)
        exact in 58 %, p90 0.8 radius / 0.36 m, the same size; the client reticle at the cursor point within 0.12 radius
        in the median."""
        import replay_aim_table as C
        m = C.measure(local_battles())
        self.assertEqual((m['battles'], m['blocks'], m['compared']), (31, 321, 321))
        self.assertGreaterEqual(m['discSame'], 318)
        self.assertEqual(m['markerSource'], {'server reticle':273, 'client reticle':48})
        fresh = m['serverFresh']
        self.assertEqual((fresh['n'], m['serverStale']['n']), (273, 0))
        self.assertGreaterEqual(m['freshSame'], 0.55 * 273)
        self.assertLess(fresh['radii'][0], 1e-3)
        self.assertLess(fresh['radii'][1], 0.85)
        self.assertLess(fresh['metres'][1], 0.40)
        self.assertAlmostEqual(fresh['size'][1], 1.0, places=3)
        self.assertLess(m['client']['radii'][0], 0.15)
        self.assertLess(m['client']['metres'][0], 0.10)
        self.assertAlmostEqual(m['client']['size'][1], 0.99, delta=0.02)


if __name__ == '__main__':
    unittest.main()
