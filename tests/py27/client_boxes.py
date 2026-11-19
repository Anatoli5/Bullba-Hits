# -*- coding: utf-8 -*-
"""The client's part boxes (mod/local_armor_inspector/client_boxes.py) on stubs shaped as the client's objects, under the client's own
Python 2.7 (runs under CPython 3 as well).

    python tests/py27/run27.py tests/py27/client_boxes.py

Carried over 19.11.2026 from the stopped side project C:/Projects/Bullba-Replays (tests/py27/boxes.py, fa382c3) with its
module; the fixture's boxes now read by Bullba Hits' own playback.part_boxes.

Stubs, as the bytecode of NA 2.4.1.1 shows them: a VehicleType with chassis [..], hulls (..), turrets ((..), ..); a
chassis with trackPairs, a turret with guns; each component a hitTesterManager whose modelHitTester and
crashedModelHitTester are ModelHitTester objects with bspModelName and bbox (None until model_assembler.setupCollisions
sets (Vector3 min, Vector3 max)). Checked: boxes read and merged over types, a model shared by two types read once, the
crashed model's box under its own name, a zero and a flat box dropped, a part without a box skipped, a type that raises
not stopping the rest, the step budget and the pause in battle, g_cache read through a stub items.vehicles; the table's
round trip (file text, other client, another writer's boxes kept, merge counts).

The number: the vehicles of the Bullba Hits fixture (BULLBA_BOXES_FIXTURE, default
C:/Projects/Bullba-Hits/tests/fixtures-local/playback-2026-11-18: data/vehicles/*.js, replay/*.records.z) whose every
static part has its client box in that fixture's stored records (statics with 'bounds', read as Hits'
playback.part_boxes reads them), after those boxes went through a Table save and load unchanged. No fixture: that part
is skipped. Verdict through BULLBA_PY27_RESULT.
"""
import glob
import io
import json
import os
import shutil
import sys
import tempfile
import traceback
import types
import zlib

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE = os.environ.get('BULLBA_BOXES_FIXTURE', os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18'))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import client_boxes as boxes
from local_armor_inspector import playback

failures = []
lines = []


def check(what, ok, detail=''):
    if not ok:
        failures.append('%s %s' % (what, detail))


# ---- stubs of the client objects ----

class Vector3(object):
    def __init__(self, x, y, z):
        self.v = (x, y, z)

    def __getitem__(self, i):
        return self.v[i]


class ModelHitTester(object):
    def __init__(self, name, box=None):
        self.bspModelName = name
        self.bbox = None if box is None else (Vector3(*box[:3]), Vector3(*box[3:]))


class HitTesterManager(object):
    def __init__(self, normal, crashed=None):
        self._t = {0: normal, 1: crashed}

    @property
    def modelHitTester(self):
        return self._t[0]

    @property
    def crashedModelHitTester(self):
        return self._t[1]


class Component(object):
    def __init__(self, normal, crashed=None, **kw):
        self.hitTesterManager = HitTesterManager(normal, crashed)
        self.__dict__.update(kw)


class VehicleType(object):
    def __init__(self, name, chassis, hulls, turrets):
        self.name, self.chassis, self.hulls, self.turrets = name, chassis, hulls, turrets


class Broken(VehicleType):
    @property
    def turrets(self):
        raise RuntimeError('turrets unreadable')

    @turrets.setter
    def turrets(self, value):
        pass


B = lambda k: [-1.0 * k, 0.0, -2.0 * k, 1.0 * k, 1.5 * k, 2.0 * k]
ZERO = [0.0] * 6
FLAT = [-1.0, 0.0, -1.0, 1.0, 0.0, 1.0]


def stub_types():
    shared_gun = Component(ModelHitTester('v/shared/Gun.model', B(5)))
    pair0 = Component(ModelHitTester('v/a/Chassis_0.model', B(1)))
    pair1 = Component(ModelHitTester('v/a/Chassis_1.model', B(1.1)))
    a = VehicleType('usa:A', [Component(pair0.hitTesterManager.modelHitTester, trackPairs=(pair0, pair1))],
                    (Component(ModelHitTester('v/a/Hull.model', B(2)), ModelHitTester('v/a/Hull_crash.model', B(2.2))),),
                    ((Component(ModelHitTester('v/a/Turret.model', B(3)),
                                guns=[shared_gun, Component(ModelHitTester('v/a/Gun_zero.model', ZERO)),
                                      Component(ModelHitTester('v/a/Gun_flat.model', FLAT))]),),))
    b = VehicleType('usa:B', [Component(ModelHitTester('v/b/Chassis.model'))],          # not built: no box
                    (Component(ModelHitTester('v/b/Hull.model', B(4))),),
                    ((Component(ModelHitTester('v/b/Turret.model', B(4.5)), guns=[shared_gun]),),))
    broken = Broken('usa:Broken', [Component(ModelHitTester('v/x/Chassis.model', B(9)))], (), ())
    nobox = Component(ModelHitTester('v/c/Hull.model'))
    del nobox.hitTesterManager.modelHitTester.bbox                                       # releaseBspModel's del
    c = VehicleType('usa:C', [], (nobox,), ())
    return [a, broken, b, c]


def harvest_all(job):
    for _ in range(100):
        got = job.step()
        if got is not None:
            return got
    raise AssertionError('the harvest did not finish in 100 steps')


def test_harvest():
    job = boxes.Harvest(stub_types())
    got = harvest_all(job)
    want = {'v/shared/Gun.model': B(5), 'v/a/Chassis_0.model': B(1), 'v/a/Chassis_1.model': B(1.1),
            'v/a/Hull.model': B(2), 'v/a/Hull_crash.model': B(2.2), 'v/a/Turret.model': B(3),
            'v/b/Hull.model': B(4), 'v/b/Turret.model': B(4.5)}
    check('harvest boxes', got == want, 'got %r' % sorted(got))
    check('harvest zero/flat dropped', 'v/a/Gun_zero.model' not in got and 'v/a/Gun_flat.model' not in got)
    check('harvest part without box skipped', 'v/b/Chassis.model' not in got and 'v/c/Hull.model' not in got)
    check('harvest broken type', [e[0] for e in job.errors] == ['usa:Broken'] and 'v/x/Chassis.model' not in got,
          repr(job.errors))
    check('harvest types read', job.types == 3, str(job.types))
    check('harvest no conflicts', job.conflicts == 0, str(job.conflicts))
    check('harvest finished returns the same', job.step() is got)
    lines.append('harvest: %d boxes from %d of 4 stub types, errors %r' % (len(got), job.types, job.errors))


def test_budget():
    ticks = [0.0]

    def clock():
        ticks[0] += 0.005       # every reading 5 ms later: each type spends the whole 4 ms budget
        return ticks[0]
    job = boxes.Harvest(stub_types(), budget=0.004, clock=clock)
    steps = 0
    while job.step() is None:
        steps += 1
        check('budget bounded', steps < 10)
        if steps >= 10:
            break
    check('budget one type per step', steps == 3, str(steps))      # 4 types: 3 steps return None, the 4th the boxes


def test_battle_pause():
    fake = types.ModuleType('BigWorld')
    PlayerAvatar = type('PlayerAvatar', (object,), {})
    PlayerAccount = type('PlayerAccount', (object,), {})
    state = {'player': PlayerAvatar()}
    fake.player = lambda: state['player']
    sys.modules['BigWorld'] = fake
    try:
        job = boxes.Harvest(stub_types())
        check('pause in battle', job.step() is None and job.types == 0 and not job.boxes)
        state['player'] = PlayerAccount()
        got = harvest_all(job)
        check('resume in the lobby', len(got) == 8, str(len(got)))
    finally:
        del sys.modules['BigWorld']


def test_cache():
    items = types.ModuleType('items')
    vehicles = types.ModuleType('items.vehicles')
    listed = stub_types()

    class Cache(object):
        def getVehicles(self):
            return iter(listed)          # a view in the client: the harvest takes its own list
    vehicles.g_cache = Cache()
    items.vehicles = vehicles
    sys.modules['items'], sys.modules['items.vehicles'] = items, vehicles
    try:
        got = harvest_all(boxes.Harvest())
        check('g_cache read', len(got) == 8, str(len(got)))
    finally:
        del sys.modules['items'], sys.modules['items.vehicles']
    check('no client: nothing', harvest_all(boxes.Harvest()) == {})


def test_table(folder):
    path = os.path.join(folder, 'bullba.common', boxes.FILE)
    t = boxes.Table(path, '2.4.1.1')
    check('table empty load', t.load() == 0)
    check('table merge', t.merge({'m/a.model': B(1), 'm/z.model': ZERO, '': B(2)}) == (1, 0))
    check('table merge again', t.merge({'m/a.model': B(1), 'm/b.model': B(2)}) == (1, 0))
    check('table merge changed', t.merge({'m/b.model': B(3)}) == (0, 1))
    check('table save', t.save() > 0)
    with io.open(path, 'rb') as f:
        text = f.read().decode('utf-8')
    check('table file text', text.startswith('ArmorInspectorData.receive(["boxes",') and text.endswith(');\n'), text[:60])
    value = boxes.read_file(path)
    check('table file value', value == {'format': 1, 'client': '2.4.1.1', 'boxes': {'m/a.model': B(1), 'm/b.model': B(3)}},
          repr(value))
    u = boxes.Table(path, '2.4.1.1')
    check('table round trip', u.load() == 2 and u.boxes == t.boxes)
    # another writer adds a box meanwhile: a save keeps it
    other = boxes.Table(path, '2.4.1.1')
    other.load()
    other.merge({'m/c.model': B(4)})
    other.save()
    t.merge({'m/d.model': B(5)})
    t.save()
    check('table keeps another writer', sorted(boxes.read_file(path)['boxes']) == ['m/a.model', 'm/b.model', 'm/c.model',
                                                                                  'm/d.model'])
    # a new client starts a new table
    n = boxes.Table(path, '2.5.0.0')
    check('table other client not read', n.load() == 0)
    n.merge({'m/e.model': B(6)})
    n.save()
    check('table other client written', boxes.read_file(path) == {'format': 1, 'client': '2.5.0.0',
                                                                  'boxes': {'m/e.model': B(6)}})
    check('table old client gone', boxes.Table(path, '2.4.1.1').load() == 0)


def fixture_boxes(folder):
    """playback.part_boxes of Bullba Hits over every stored records file of the fixture."""
    out = {}
    for path in sorted(glob.glob(os.path.join(folder, 'replay', '*.records.z'))):
        name = os.path.basename(path)[:-len('.records.z')]
        for resource, box in playback.part_boxes(folder, name).items():
            out.setdefault(str(resource), box)
    return out


def load_js(path):
    with io.open(path, encoding='utf-8') as f:
        t = f.read()
    return json.loads(t[t.index('(') + 1:t.rindex(')')])[1]


def test_fixture(folder):
    files = sorted(glob.glob(os.path.join(FIXTURE, 'data', 'vehicles', '*.js')))
    if not files or not glob.glob(os.path.join(FIXTURE, 'replay', '*.records.z')):
        lines.append('fixture: SKIPPED (no %s)' % FIXTURE)
        return
    seed = fixture_boxes(FIXTURE)
    path = os.path.join(folder, 'seed', boxes.FILE)
    t = boxes.Table(path, 'fixture')
    added, changed = t.merge(seed)
    t.save()
    back = boxes.Table(path, 'fixture')
    back.load()
    check('fixture boxes survive the table', back.boxes == seed and added == len(seed) and changed == 0,
          '%d of %d' % (len(back.boxes), len(seed)))
    full, partial, names = 0, 0, []
    for f in files:
        doc = load_js(f)
        res = [p['resource'] for p in doc.get('parts', ()) if p.get('id', -1) >= 0 and p.get('resource')]
        have = [r for r in res if back.get(r)]
        if res and len(have) == len(res):
            full += 1
            names.append(str(doc.get('type')))
        elif have:
            partial += 1
    lines.append('fixture: %d boxes seeded; %d of %d vehicles have the client box of every static part, %d some: %s'
                 % (len(seed), full, len(files), partial, ', '.join(sorted(names))))


def main():
    folder = tempfile.mkdtemp(prefix='bullba-boxes-')
    try:
        for test in (test_harvest, test_budget, test_battle_pause, test_cache, lambda: test_table(folder),
                     lambda: test_fixture(folder)):
            try:
                test()
            except Exception:
                failures.append(traceback.format_exc())
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    text = '\n'.join(['boxes: %s' % ('%d failures' % len(failures) if failures else 'all checks pass')] + lines
                     + failures)
    if RESULT:
        with open(RESULT, 'w') as stream:
            stream.write('exit %d\n%s\n' % (1 if failures else 0, text))
    else:
        print(text)
        sys.exit(1 if failures else 0)


main()
