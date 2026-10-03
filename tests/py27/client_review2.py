# -*- coding: utf-8 -*-
"""The second review of the executed-code rule (BACKLOG 55, 02.10), under the client's python27.dll.

    python tests/py27/run27.py tests/py27/client_review2.py

Fake clients in a temp folder (modules compiled here). One section per finding:
  A   the sample check and the check of every file after a 'Missed change' outlive the session that asked for them;
  B   a bad .wotmod does not break the collision index; a rebuild that lost parts' models to a read error never replaces a
      vehicle file, nor takes its key;
  C   what the code set takes from modules outside it (a scalar, a function) is keyed: changed - every file; another name of
      that module changed - nothing;
  C2  the types whose stand output changed (client_code.STAND_CHANGED) are rebuilt once;
  D   a module only the game's recording saw is watched: its change asks for the sample check, raises no generation, keeps
      the fill-in gate;
  E   a battle of another client finds its armour in the cache 0.9.3 named by the version text;
  F   a file is proven only in this build's format;
  G   scripts.pkg unreadable for a session raises no generation.
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, logging, marshal, os, shutil, sys, tempfile, time, types, zipfile, hashlib
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report, failures = [], []


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


logs = Collect()
logger = logging.getLogger('local.armor_inspector')
logger.addHandler(logs)
logger.setLevel(logging.INFO)
logger.propagate = False


def logged(text):
    return [l for l in logs.records if text in l]


items = types.ModuleType('items')
client_vehicles = types.ModuleType('items.vehicles')
client_vehicles.g_list = object()
items.vehicles = client_vehicles
sys.modules['items'] = items
sys.modules['items.vehicles'] = client_vehicles

VEHICLES = 'scripts/common/items/vehicles.pyc'
OUTSIDE = 'scripts/common/outside_helper.pyc'
WATCHED = 'scripts/common/items/readers/a_reader_of_tomorrow.pyc'
CHASSIS = 'scripts/common/items/components/chassis_components.pyc'
SOURCE = 'from outside_helper import LIMIT\ndef armour(x):\n    return x * LIMIT\n'
TYPES = ['germany:G1_A', 'germany:G2_B']
ROWS = [{'id': t.replace(':', '-'), 'type': t} for t in TYPES]
HULL = 'vehicles/german/G1_A/collision_client/Hull.havok'


def pyc(source, name):
    return b'\x03\xf3\r\n\x00\x00\x00\x00' + marshal.dumps(compile(source, name[:-1], 'exec'))


def client(**changes):
    files = {VEHICLES: pyc(SOURCE, VEHICLES), OUTSIDE: pyc('LIMIT = 2\nOTHER = 1\n', OUTSIDE),
             WATCHED: pyc('def read():\n    return 0\n', WATCHED), CHASSIS: pyc('def wheels():\n    return 1\n', CHASSIS),
             'scripts/item_defs/vehicles/common/vehicle.xml': 'common',
             'scripts/item_defs/vehicles/germany/components/guns.xml': 'guns',
             'scripts/item_defs/vehicles/germany/G1_A.xml': 'G1_A', 'scripts/item_defs/vehicles/germany/G2_B.xml': 'G2_B',
             HULL: 'hull bytes'}
    for key, value in changes.items(): files[key] = value
    return files


temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    game, folder = os.path.join(temp, 'game'), os.path.join(temp, 'folder')
    os.makedirs(os.path.join(game, 'res', 'packages'))
    os.makedirs(os.path.join(game, 'win64'))
    os.makedirs(os.path.join(game, 'mods', '2.4.0.2'))
    stamp = [time.time()]
    exe = [b'exe 1']

    def write(files, label, broken=False):
        with zipfile.ZipFile(os.path.join(game, 'res', 'packages', 'scripts.pkg'), 'w') as z:
            for name in sorted(f for f in files if f.startswith('scripts/')): z.writestr(name, files[name])
        with zipfile.ZipFile(os.path.join(game, 'res', 'packages', 'vehicles.pkg'), 'w') as z:
            for name in sorted(f for f in files if not f.startswith('scripts/')): z.writestr(name, files[name])
        if broken:
            with open(os.path.join(game, 'res', 'packages', 'scripts.pkg'), 'wb') as stream: stream.write('not a zip')
        with open(os.path.join(game, 'win64', 'WorldOfTanks.exe'), 'wb') as stream: stream.write(exe[0])
        stamp[0] += 10
        for name in ('res/packages/scripts.pkg', 'res/packages/vehicles.pkg', 'win64/WorldOfTanks.exe'):
            os.utime(os.path.join(game, *name.split('/')), (stamp[0], stamp[0]))
        return '<version.xml><version> %s </version></version.xml>\n' % label

    outputs = {'mark': 1}

    def block(type_name, version, log=True):
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA,
                'format': ex.TTX_FORMAT, 'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [], 'mark': outputs['mark']}
    ex.ttx_block = block

    def session(version):
        e = ex.Exporter(game, folder, version, os.path.join(temp, 'unused.wotmod'))
        if hasattr(e, 'code_generation'): e.code_generation()
        e.start_ttx_sweep(ROWS)
        e.start_verify()
        return e

    def plan(e):
        sweep = e.sweeps.get('verify')
        items_ = sweep['types'] if sweep else []
        return (sorted(i.split(':', 1)[1] for i in items_ if i.startswith('ttx:') or i.startswith('stand-ttx:')),
                len([i for i in items_ if i.startswith('sample-')]))

    def settle(e):
        for t in TYPES: e.build_ttx(t, force=True)
        e.write_sweep('ttx', done=True)
        e.write_keys(force=True)

    def drain(e):
        for _ in range(100):
            if e.sweeps.get('verify') is None: break
            e.last_job = 0
            e.run_job()
        e.write_keys(force=True)

    v = write(client(), 'v.1 #1')
    settle(session(v))
    check(plan(session(v)) == ([], 0), 'the same client again: nothing', plan(session(v)))

    # ---- A: the sample check outlives its session
    exe[0] = b'exe 2'
    v = write(client(), 'v.2 #2')
    first = session(v)
    check(plan(first)[1] > 0, 'A: the exe changed: the sample check is planned', plan(first))
    again = session(v)           # the first session ended before its check ran
    check(plan(again)[1] > 0, 'A: the session ended before it ran: the next start plans it again', plan(again))
    drain(again)
    check(plan(session(v)) == ([], 0), 'A: run to its end: not again', plan(session(v)))
    # a sample differs: 'Missed change' and every file - also after a restart
    exe[0] = b'exe 3'
    outputs['mark'] = 2
    v = write(client(), 'v.3 #3')
    missed = session(v)
    sweep = missed.sweeps.get('verify')
    first_sample = [i for i in sweep['types'] if i.startswith('sample-')][0]
    missed.verify_step(first_sample, sweep)        # one sample built, then the session ends
    check(logged('Missed change'), 'A: a sample differed: Missed change')
    later = session(v)
    sweep = later.sweeps.get('verify')
    check(sweep is not None and sweep.get('everything') and plan(later)[1] >= len(TYPES),
          'A: after a restart the check of every file goes on', plan(later))
    drain(later)
    settle(session(v))

    # ---- C: what the set takes from outside it
    v = write(client(**{OUTSIDE: pyc('LIMIT = 2\nOTHER = 5\n', OUTSIDE)}), 'v.4 #4')
    e = session(v)
    check(plan(e)[0] == [], 'C: another name of the outside module changed: nothing rebuilt', plan(e))
    settle(e)
    v = write(client(**{OUTSIDE: pyc('LIMIT = 3\nOTHER = 5\n', OUTSIDE)}), 'v.5 #5')
    e = session(v)
    check(plan(e)[0] == sorted(TYPES), 'C: the scalar the set takes from it changed: every file is rebuilt', plan(e))
    settle(e)
    base = client(**{OUTSIDE: pyc('LIMIT = 3\nOTHER = 5\n', OUTSIDE)})

    # ---- D: a module only the game's recording saw
    e = session(v)
    if hasattr(e, 'code_record'): e.code_record([WATCHED])
    gate = e.fill_code()
    v = write(dict(base, **{WATCHED: pyc('def read():\n    return 1\n', WATCHED)}), 'v.6 #6')
    e = session(v)
    check(plan(e)[0] == [] and plan(e)[1] > 0, 'D: a watched module changed: no generation, the sample check', plan(e))
    check(e.fill_code() == gate or WATCHED not in getattr(e, 'code_modules')(), 'D: and the fill-in gate keeps open')
    drain(e)
    settle(session(v))
    base = dict(base, **{WATCHED: pyc('def read():\n    return 1\n', WATCHED)})

    # ---- G: scripts.pkg unreadable for a session
    v7 = write(base, 'v.7 #7', broken=True)
    e = session(v7)
    check(plan(e)[0] == [], 'G: scripts.pkg unreadable: no generation raised, nothing rebuilt by code', plan(e))
    v7 = write(base, 'v.7 #7')
    e = session(v7)
    check(plan(e)[0] == [], 'G: readable again, the same code: nothing', plan(e))
    drain(e)

    # ---- C2: the stand's changed types
    saved = getattr(ex, 'STAND_CHANGED', None), getattr(ex, 'STAND_CLIENT', None)
    ex.STAND_CHANGED, ex.STAND_CLIENT = ('germany:G2_B',), 'v.7 #7'
    e = session(v7)
    check(plan(e)[0] == ['germany:G2_B'], 'C2: the type whose stand output changed is rebuilt', plan(e))
    drain(e)
    check(plan(session(v7))[0] == [], 'C2: once', plan(session(v7)))
    ex.STAND_CHANGED, ex.STAND_CLIENT = saved

    # ---- B: a bad .wotmod and a degraded rebuild
    with open(os.path.join(game, 'mods', '2.4.0.2', 'broken.wotmod'), 'wb') as stream: stream.write('')
    e = ex.Exporter(game, folder, v7, os.path.join(temp, 'unused.wotmod'))
    try:
        e.ensure_packages()
        ok = e.packages is not None and HULL in e.packages
    except Exception as error:
        ok = False
    check(ok, 'B: one bad .wotmod: the collision index is still built')
    os.remove(os.path.join(game, 'mods', '2.4.0.2', 'broken.wotmod'))
    path = os.path.join(folder, 'data', 'vehicles', 'germany-G1_A.js')
    good = {'id': 'germany-G1_A', 'type': 'germany:G1_A', 'source': 'hangar', 'compactDescriptor': 'eA==', 'clientVersion': v7,
            'parts': [{'id': 1, 'name': 'hull', 'resource': HULL.replace('.havok', '.model'), 'modelKey': 'a' * 64}]}
    ex.write_data(path, 'vehicle:germany-G1_A', good)
    before = open(path, 'rb').read()
    e = ex.Exporter(game, folder, v7, os.path.join(temp, 'unused.wotmod'))
    e.client()
    e.vehicles['germany-G1_A'] = dict(good, descriptorHash=ex.descriptor_hash('germany:G1_A', 'eA=='))
    key_before = e.vehicle_keys().get('germany-G1_A')

    class Part(object):
        pass
    descr = types.ModuleType('descr')
    descr.type = types.ModuleType('t'); descr.type.name = 'germany:G1_A'
    real = (ex.vehicle_descr, ex.parts_from_descr, ex.Exporter._index_resources)
    ex.vehicle_descr = lambda compact: descr
    ex.parts_from_descr = lambda d, source=None: [{'id': 1, 'name': 'hull', 'resource': HULL.replace('.havok', '.model')}]
    def unreadable(self): raise IOError('a package locked by an antivirus')
    ex.Exporter._index_resources = unreadable
    try:
        e.export_vehicle({'vehicleType': 'germany:G1_A', 'compactDescriptor': 'eA==', 'source': 'hangar'}, replay=True, verify=True)
    except Exception:
        pass
    ex.vehicle_descr, ex.parts_from_descr, ex.Exporter._index_resources = real
    check(open(path, 'rb').read() == before and e.vehicle_keys().get('germany-G1_A') == key_before,
          'B: a rebuild that lost its models to a read error keeps the file and its key', logged('degraded')[-1:] or '')

    # ---- E: the armour cache of 0.9.3
    other = '<version.xml><version> v.0 #0 </version></version.xml>\n'
    identity = '\n'.join((ex.canonical(other), 'germany:G1_A', 'eA==', HULL.replace('.havok', '.model')))
    legacy = os.path.join(folder, 'data', 'armor', hashlib.sha256(identity.encode('utf-8')).hexdigest() + '.json')
    ex.atomic_write(legacy, json.dumps({'armor_1': {'armor': 40.0}}).encode('ascii'))
    parts = [{'id': 1, 'resource': HULL.replace('.havok', '.model')}]
    e.client_snapshots[other] = dict(e.client_files(), **{'scripts/item_defs/vehicles/germany/G1_A.xml': (77, 7)})
    e.publish_vehicle_parts(parts, {'type': 'germany:G1_A', 'compactDescriptor': 'eA=='}, other)
    check(parts[0].get('armor') == {'armor_1': {'armor': 40.0}}, 'E: another client\'s battle finds its armour in the 0.9.3 cache',
          parts[0].get('armorError'))

    # ---- F: proven only in this build's format
    record = dict(good)
    check(e.proven('germany:G1_A', v7, record), 'F: a file of this client and this format is proven')
    real_format = ex.VEHICLE_FORMAT
    ex.VEHICLE_FORMAT = real_format + 1
    try:
        check(not e.proven('germany:G1_A', v7, record), 'F: of another vehicle file format - not, even of this very client')
    finally:
        ex.VEHICLE_FORMAT = real_format
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    shutil.rmtree(temp, ignore_errors=True)
report.append('%d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
