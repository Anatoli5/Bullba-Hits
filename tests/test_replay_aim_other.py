# -*- coding: utf-8 -*-
"""Another vehicle's aim circle estimated from the replay (replay_aim_other.py, BACKLOG 82): the one copy of the
dispersion formula against the page's (web/ballistics.js, through node), the block on synthetic tracks, what is not
modelled, the replay's records and the published battle, and - when the 33 battles of 11.11.2026 and the guns table are on
this computer - the measurement's tables made by the product code (tests/replay_aim_other_table.py).

    python -m pytest tests/test_replay_aim_other.py -q
"""
import json
import math
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
from local_armor_inspector import replay_aim_other as ro  # noqa: E402
from local_armor_inspector import replay_battle as rb  # noqa: E402
from local_armor_inspector.replay_scene import RX, RY, mm, world_of  # noqa: E402

NODE = next((p for p in (os.environ.get('BULLBA_NODE'), shutil.which('node'),
                         os.path.expanduser('~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'))
             if p and os.path.isfile(p)), None)
GUN = {'dispersion':0.0035, 'aimingTime':2.0, 'movementFactor':0.2, 'rotationFactor':0.12, 'turretRotationFactor':0.09,
       'afterShotFactor':4.0, 'turretRotationSpeed':0.5, 'gunPitchSpeed':0.3, 'gunTags':[], 'pitchLimits':[-0.2, 0.2],
       'hasSiegeMode':False}
START = 1000.0
PLAYER, SHOOTER = 1, 7


def pitch_of(code):
    return -0.2 + code / 63.0 * 0.4


def code(yaw_k, pitch_c):
    return (yaw_k << 6) | pitch_c


def axis(row, yaw, pitch):
    m = mm(mm(world_of(row), RY(yaw)), RX(pitch))
    return [m[8], m[9], m[10]]


def deviate(direction, right, up):
    basis = ro.frame(direction)
    return ro.direction(basis, [right, up])


def track(seconds=60.0, speed=0.0, yaw_rate=None):
    """A vehicle at 10 packets a second, driving along +z at `speed`; its gun's codes: still (yaw 0, pitch code 32), or
    turning by one yaw code a tick from t = 10 s (`yaw_rate`: 'steady')."""
    times, values, gt, gc = [], [], [], []
    for k in range(int(seconds * 10) + 1):
        t = k * 0.1
        times.append(t)
        values.extend([0.0, 0.0, speed * t, 0.0, 0.0, 0.0])
    gt.append(0.0)
    gc.append(code(512, 32))
    if yaw_rate == 'steady':
        for k in range(1, 400):
            gt.append(10.0 + k * 0.1)
            gc.append(code(512 + k, 32))
    else:
        gt.append(1.0)
        gc.append(code(512, 32))
    return (times, values), (gt, gc)


def tracer(t, direction, shot, origin=None, **extra):
    r = {'type':'shot', 'event':'tracer', 'id':'s%d' % shot, 'gameTime':START + t, 'own':False, 'isRicochet':False,
         'shooterId':SHOOTER, 'gunInstallationIndex':0, 'origin':origin or [0.0, 2.0, 0.0], 'velocity':[v * 900 for v in direction]}
    r.update(extra)
    return r


def poses(positions, guns, compact='C'):
    return {'type':'poses', 'playerVehicleId':PLAYER, 'serverTimeAtStart':START, 'positions':{SHOOTER:positions},
            'guns':{SHOOTER:guns}, 'compact':{SHOOTER:compact}}


def full_size(shooter, shots, clock):
    """The size model over the whole track from its first tick (the measurement's own way): R_est at the clock."""
    t0, n = shooter.grid()
    out = {}
    saved = ro.SETTLE, ro.SETTLE_MIN
    ro.SETTLE, ro.SETTLE_MIN = 1e9, 1e9
    try:
        for _ in shooter.size_steps(shots, [clock], out): pass
    finally:
        ro.SETTLE, ro.SETTLE_MIN = saved
    return out[clock]


class FormulaParity(unittest.TestCase):
    @unittest.skipUnless(NODE, 'node not found')
    def test_the_python_copy_is_ballistics_js(self):
        """The same states through web/ballistics.js (aimFactor's ideal, aimStep, aimShot with the TYPICAL mods) and through
        replay_aim_other.aim_ideal / aim_step / aim_shot: the same factor at every tick, to 1e-12."""
        states = []
        for k in range(160):
            t = k * 0.1
            states.append({'speed':max(0.0, 8.0 * math.sin(t / 3.0)), 'hullTurn':0.3 * abs(math.cos(t)), 'turretTurn':0.2 if 40 <= k < 60 else 0.0,
                           'shot':k in (20, 23, 90), 'dt':0.1 if k != 70 else 0.6})
        script = ("const fs=require('node:fs'),vm=require('node:vm');vm.runInThisContext(fs.readFileSync(%r,'utf8'));"
                  "const B=globalThis.ArmorBallistics,aim=%s,mods=%s,states=%s;let prev=null,out=[];"
                  "for(const s of states){prev=B.aimStep(prev,s,aim,mods,prev?s.dt:0);if(s.shot)prev=B.aimShot(prev,s,aim,mods);out.push(prev.factor);}"
                  "process.stdout.write(JSON.stringify(out));") % (os.path.join(ROOT, 'web', 'ballistics.js').replace('\\', '/'),
                                                                  json.dumps(GUN), json.dumps(ro.TYPICAL), json.dumps(states))
        js = json.loads(subprocess.run([NODE, '-e', script], capture_output=True, text=True, check=True).stdout)
        py, prev = [], None
        for s in states:
            ideal, aiming = ro.aim_ideal(GUN, s['speed'], s['hullTurn'], s['turretTurn'], False, ro.TYPICAL)
            prev = (ideal, ideal, 0.0) if prev is None else ro.aim_step(prev, ideal, aiming, s['dt'])
            if s['shot']: prev = ro.aim_shot(prev, ro.aim_ideal(GUN, s['speed'], s['hullTurn'], s['turretTurn'], True, ro.TYPICAL)[0], ideal)
            py.append(prev[0])
        self.assertEqual(len(js), len(py))
        self.assertLess(max(abs(a - b) for a, b in zip(js, py)), 1e-12)
        self.assertGreater(max(py), 3.0)   # the shots bloomed it


class Block(unittest.TestCase):
    def test_a_standing_vehicle(self):
        """Standing, gun still, three aimed shots 10 s apart: the circle is the fully aimed typical one (0.92 x the gun's
        dispersion), each shell inside it, the centre between the track and the shell (a shell to the right shown right of it), the
        block in the own disc's names and marked an estimate."""
        positions, guns = track()
        row = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        a = axis(row, 0.0, pitch_of(32))
        R = 0.92 * GUN['dispersion']
        tracers = [tracer(20.0, deviate(a, 0.6 * R, 0.0), 1), tracer(30.0, deviate(a, -0.3 * R, 0.2 * R), 2),
                   tracer(40.0, deviate(a, 0.1 * R, -0.5 * R), 3)]
        # right of a shooter looking along +z is +x: the game's world is left-handed (the page flips z for three.js)
        self.assertGreater(tracers[0]['velocity'][0], 0.0)
        report = ro.attach(tracers + [poses(positions, guns)], lambda c: dict(GUN))
        self.assertEqual((report['tracers'], report['circles']), (3, 3))
        b = tracers[0][ro.KEY]
        self.assertTrue(b['estimate'])
        self.assertEqual(sorted(b['circle']), ['dispersionAngle', 'origin', 'vector'])
        self.assertAlmostEqual(b['circle']['dispersionAngle'], R, places=9)
        self.assertEqual(b['basis']['case'], 'still')
        self.assertEqual((b['basis']['gun'], b['basis']['moving'], b['basis']['shotsInStop']), ('still', False, 3))
        for t in tracers:
            s = t[ro.KEY]['shell']
            self.assertLessEqual(math.hypot(s['right'], s['up']), 1.0)
        # the horizontal: the track pulls the centre towards the shell by the share the deviation has of the two spreads
        # (prior 2.11 mrad, deviation 0.327 x 1.148 R): a shell 0.6 R to the right is shown about 0.15 R right of the centre
        sd = ro.DEVIATION_SD * R * ro.SIZE_RATIO2 ** 0.5
        self.assertAlmostEqual(b['shell']['right'], 0.6 * sd ** 2 / (sd ** 2 + 0.00211 ** 2), delta=0.02)
        self.assertTrue(b['limits'] and b['absent'])
        self.assertGreater(b['uncertainty']['centreUp'], b['uncertainty']['centreRight'])

    def test_a_tick_at_the_tracer_is_not_read_bloomed(self):
        """D-119 (13.11): a grid tick within BLOOM_EPS before the tracer clock is the tick the shot blooms; the circle is
        read before it, not on it. The grid starts at the vehicle's first packet and the server's clocks share one 0.1 s
        phase, so in the battles this happened to 650 of 3 627 tracers (the circle shown 3-5x too wide). Standing and aimed:
        the circle is the aimed one whatever the tracer's phase against the grid."""
        positions, guns = track()
        shooter = ro.Shooter(positions, guns, dict(GUN))
        R = 0.92 * GUN['dispersion']
        for c in (20.0 + 5e-5, 20.0, 20.05, 20.0 - 5e-5):
            out = {}
            for _ in shooter.size_steps([10.0, c], [c], out): pass
            self.assertAlmostEqual(out[c], R, places=9, msg='tracer at %r' % c)

    def test_a_steady_turn_and_the_size_on_the_move(self):
        """Driving at 5 m/s with the turret turning one code a tick: the case is a steady turn, the circle is the formula's
        on the move (wider than aimed), and the windowed size model equals the one over the whole track."""
        positions, guns = track(speed=5.0, yaw_rate='steady')
        shooter = ro.Shooter(positions, guns, dict(GUN))
        t = 25.0
        y = shooter.angles(t - 0.1)[0]
        a = axis(shooter.pose(t - 0.1), y, pitch_of(32))
        tracers = [tracer(15.0, a, 1), tracer(t, a, 2)]
        ro.attach(tracers + [poses(positions, guns)], lambda c: dict(GUN))
        b = tracers[1][ro.KEY]
        self.assertEqual(b['basis']['case'], 'steady turn')
        self.assertTrue(b['basis']['moving'])
        self.assertGreater(b['circle']['dispersionAngle'], 1.3 * 0.92 * GUN['dispersion'])
        self.assertAlmostEqual(b['circle']['dispersionAngle'], full_size(shooter, [15.0, t], t), places=8)

    def test_what_is_not_modelled_says_why(self):
        positions, guns = track()
        a = axis([0.0] * 6, 0.0, pitch_of(32))
        cases = [({'gunTags':['autoShoot', 'clip']}, [], 'auto'), ({'gunTags':['dualAccuracy']}, [], 'dual'),
                 ({'hasSiegeMode':True}, [{'siegeState':1}], 'mode')]
        for extra, fields, key in cases:
            gun = dict(GUN, **extra)
            t = tracer(20.0, a, 1, **(fields[0] if fields else {}))
            ro.attach([t, poses(positions, guns)], lambda c: gun)
            self.assertEqual((t[ro.KEY]['reasonKey'], 'circle' in t[ro.KEY]), (key, False), key)
            self.assertTrue(t[ro.KEY]['reason'])
        # a burst of two 0.5 s apart: the first round has its circle, the second not
        burst = dict(GUN, burst=[2, 0.5, False])
        first, second = tracer(20.0, a, 1), tracer(20.5, a, 2)
        ro.attach([first, second, poses(positions, guns)], lambda c: burst)
        self.assertIn('circle', first[ro.KEY])
        self.assertEqual(second[ro.KEY]['reasonKey'], 'burst')
        # the secondary gun, a shooter out of view, a gun the client cannot give, a vehicle the replay never showed
        sec, late = tracer(20.0, a, 1, gunInstallationIndex=1), tracer(70.0, a, 2)
        ro.attach([sec, late, poses(positions, guns)], lambda c: dict(GUN))
        self.assertEqual((sec[ro.KEY]['reasonKey'], late[ro.KEY]['reasonKey']), ('secondary', 'view'))
        failing = tracer(20.0, a, 1)

        def refuse(compact): raise ValueError('no client here')
        ro.attach([failing, poses(positions, guns)], refuse)
        self.assertEqual(failing[ro.KEY]['reasonKey'], 'gun')
        self.assertIn('no client here', failing[ro.KEY]['reason'])
        unseen = tracer(20.0, a, 1)
        p = poses(positions, guns)
        p['positions'] = {}
        ro.attach([unseen, p], lambda c: dict(GUN))
        self.assertEqual(unseen[ro.KEY]['reasonKey'], 'track')

    def test_own_tracers_and_ricochets_get_none(self):
        positions, guns = track()
        a = axis([0.0] * 6, 0.0, pitch_of(32))
        own = tracer(20.0, a, 1, own=True, shooterId=PLAYER)
        ricochet = tracer(20.0, a, 2, isRicochet=True)
        ro.attach([own, ricochet, poses(positions, guns)], lambda c: dict(GUN))
        self.assertNotIn(ro.KEY, own)
        self.assertNotIn(ro.KEY, ricochet)
        records = [own, ricochet]
        ro.attach(records, lambda c: dict(GUN))   # no poses record: nothing
        self.assertFalse(any(ro.KEY in r for r in records))

    def test_the_published_battle_carries_and_counts_it(self):
        """replay_battle.build keeps the block on the published tracer and counts it in the 'replay' block; a battle
        without blocks has nothing more than before (the counts 0)."""
        positions, guns = track()
        a = axis([0.0] * 6, 0.0, pitch_of(32))
        header = {'schema':1, 'type':'battle', 'id':'9-x', 'source':'replay', 'arenaId':'9', 'playerVehicleId':PLAYER,
                  'replayServerTimeAtStart':START}
        roster = {'schema':1, 'type':'roster', 'playerVehicleId':PLAYER, 'vehicles':[{'id':PLAYER}, {'id':SHOOTER}]}
        t = tracer(20.0, a, 1)
        ro.attach([t, poses(positions, guns)], lambda c: dict(GUN))
        battle, report = rb.build([header, roster, t, poses(positions, guns)], None, '9-x')
        shot = next(s for s in battle['shotEvents'] if s.get('event') == 'tracer')
        self.assertIn('circle', shot[ro.KEY])
        self.assertEqual((report['aimEstimates'], report['aimEstimateCircles']), (1, 1))
        plain = dict(t)
        plain.pop(ro.KEY)
        _, report = rb.build([header, roster, plain], None, '9-x')
        self.assertEqual((report['aimEstimates'], report['aimEstimateCircles']), (0, 0))


# ---- the 33 battles of 11.11.2026, when they are on this computer ------------------------------------------------------
def local_battles():
    try:
        import replay_aim_other_table as X
        if not os.path.isdir(os.path.join(X.T.GAME, 'res', 'packages')): return None
        return X.local_ids()
    except Exception:
        return None


@unittest.skipUnless(local_battles(), 'the 33 battles of 11.11.2026 (kept streams), the client or the guns table are absent')
class LocalBattles(unittest.TestCase):
    def test_the_measured_tables(self):
        """The own shots through the other vehicle's path against the server's axis (outputs/aim-circles-other-vehicles-
        2026-11-12.md 4.3: 0.31 / 0.65 R total, 0.14 / 0.43 horizontal, 0.21 / 0.59 vertical, 100 % inside, information
        0.69 / 0.26; R_est / R 0.77-1.30) - without the shots the product leaves out (the automatic Ares 90 C, Type 71's dual
        accuracy, the later rounds of a burst): 151 shots of 24 battles. The others (4.4: 61 / 88 / 97 / 100 % within
        0.25 / 0.5 / 0.75 / 1 R_est, median 0.20)."""
        import replay_aim_other_table as X
        m = X.measure(local_battles())
        own = m['own']
        self.assertGreaterEqual(own['n'], 145)
        self.assertLessEqual(own['total'][0], 0.34)
        self.assertLessEqual(own['total'][1], 0.70)
        self.assertLessEqual(own['h'][0], 0.18)
        self.assertLessEqual(own['h'][1], 0.46)
        self.assertLessEqual(own['v'][0], 0.24)
        self.assertLessEqual(own['v'][1], 0.62)
        self.assertEqual(own['inside'], 1.0)
        self.assertGreaterEqual(own['infoH'], 0.62)
        self.assertGreaterEqual(own['infoV'], 0.15)
        self.assertTrue(0.70 <= own['size'][0] and 0.85 <= own['size'][1] <= 1.05 and own['size'][2] <= 1.40, own['size'])
        others = m['others']
        self.assertGreater(others['n'], 1500)
        self.assertEqual(others['le'][3], 1.0)
        self.assertGreaterEqual(others['le'][1], 0.85)
        self.assertLessEqual(others['median'], 0.24)


if __name__ == '__main__':
    unittest.main()
