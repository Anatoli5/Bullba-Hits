# -*- coding: utf-8 -*-
"""The client's code as a key of the characteristics and vehicle files (BACKLOG 55, 02.10), under the client's python27.dll.

    python tests/py27/run27.py tests/py27/code_identity.py

The user: when a formula changes, check the formula, not every value run through it. A file is current while its own data
and the client code its build EXECUTES (client_code.CODE_MODULES, made on the offline stand by tools/client_code_set.py,
plus what the game itself records) did not change - by the code's identity, not its bytes (a line shift is no change).
Fake clients in a temp folder, the modules compiled here from tiny sources:

  1  2.4.0.2's change (the crew's tankmen_components.pyc, a dossier .pyc, GB130's XML): only that vehicle is rebuilt; the
     code change outside the set asks for the sample check only;
  2  a function of a module of the set changed: every file is rebuilt;
  3  a line shift only in such a module: nothing is rebuilt (the sample check only);
  4  the game's executable changed: the sample check only;
  5  the fill-ins' gate the same rule: the crew's change keeps a battle's repair, the chassis code's closes it;
  6  a module the game records for the first time invalidates nothing.
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import logging, marshal, os, shutil, sys, tempfile, types, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report, failures = [], []


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


logging.getLogger('local.armor_inspector').addHandler(logging.NullHandler())
logging.getLogger('local.armor_inspector').propagate = False

items = types.ModuleType('items')
client_vehicles = types.ModuleType('items.vehicles')
client_vehicles.g_list = object()
items.vehicles = client_vehicles
sys.modules['items'] = items
sys.modules['items.vehicles'] = client_vehicles

VEHICLES = 'scripts/common/items/vehicles.pyc'
CHASSIS = 'scripts/common/items/components/chassis_components.pyc'
CREW = 'scripts/common/items/components/tankmen_components.pyc'
DOSSIER = 'scripts/common/dossiers2/custom/records.pyc'
NEW = 'scripts/common/items/readers/a_reader_of_tomorrow.pyc'
SOURCE = 'def armour(x):\n    return x * 2\n\nTABLE = {"a": 1}\n'


def pyc(source, name):
    return b'\x03\xf3\r\n\x00\x00\x00\x00' + marshal.dumps(compile(source, name[:-1], 'exec'))


TYPES = ['germany:G1_A', 'germany:G2_B', 'uk:GB130_FV225_Collector']
ROWS = [{'id': t.replace(':', '-'), 'type': t} for t in TYPES]


def client(code=None, data=None):
    files = {VEHICLES: pyc(SOURCE, VEHICLES), CHASSIS: pyc('def wheels():\n    return 1\n', CHASSIS),
             CREW: pyc('RANKS = ("a",)\n', CREW), DOSSIER: pyc('RECORDS = 1\n', DOSSIER),
             NEW: pyc('def read():\n    return 0\n', NEW),
             'scripts/item_defs/vehicles/common/vehicle.xml': 'common',
             'scripts/item_defs/vehicles/germany/components/guns.xml': 'guns', 'scripts/item_defs/vehicles/uk/components/guns.xml': 'guns',
             'scripts/item_defs/vehicles/germany/G1_A.xml': 'G1_A', 'scripts/item_defs/vehicles/germany/G2_B.xml': 'G2_B',
             'scripts/item_defs/vehicles/uk/GB130_FV225_Collector.xml': 'GB130 1'}
    files.update(code or {})
    files.update(data or {})
    return files


temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    game, folder = os.path.join(temp, 'game'), os.path.join(temp, 'folder')
    os.makedirs(os.path.join(game, 'res', 'packages'))
    os.makedirs(os.path.join(game, 'win64'))
    exe = [b'exe 1']
    import time
    stamp = [time.time()]

    def write(files, label):
        with zipfile.ZipFile(os.path.join(game, 'res', 'packages', 'scripts.pkg'), 'w') as z:
            for name in sorted(files): z.writestr(name, files[name])
        with open(os.path.join(game, 'win64', 'WorldOfTanks.exe'), 'wb') as stream: stream.write(exe[0])
        # An update leaves other times on what it changed (here: the next ten seconds, whatever the size).
        stamp[0] += 10
        for name in ('res/packages/scripts.pkg', 'win64/WorldOfTanks.exe'):
            os.utime(os.path.join(game, *name.split('/')), (stamp[0], stamp[0]))
        version = '<version.xml><version> %s </version></version.xml>\n' % label
        return version

    def block(type_name, version, log=True):
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA,
                'format': ex.TTX_FORMAT, 'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': []}
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
        return sorted(i.split(':', 1)[1] for i in items_ if i.startswith('ttx:')), any(i.startswith('sample-') for i in items_)

    def settle(e):
        for t in TYPES: e.build_ttx(t, force=True)
        e.write_sweep('ttx', done=True)
        if hasattr(e, 'write_keys'): e.write_keys(force=True)

    # the first client: every file built, its keys kept
    v = write(client(), 'v.1 #1')
    settle(session(v))
    check(plan(session(v)) == ([], False), 'the same client again: nothing to rebuild, no sample', plan(session(v)))

    # 1. the 2.4.0.2 change
    v = write(client(code={CREW: pyc('RANKS = ("a", "b")\n', CREW), DOSSIER: pyc('RECORDS = 2\n', DOSSIER)},
                     data={'scripts/item_defs/vehicles/uk/GB130_FV225_Collector.xml': 'GB130 2'}), 'v.2 #2')
    e = session(v)
    check(plan(e)[0] == ['uk:GB130_FV225_Collector'], '1: the crew\'s code and a dossier changed, one vehicle\'s XML: only it is rebuilt',
          plan(e))
    check(plan(e)[1], '1: the code outside the set changed: the sample check runs (the guard of what the set misses)')
    settle(e)

    # 2. a function of the set changed
    changed = client(code={CREW: pyc('RANKS = ("a", "b")\n', CREW), DOSSIER: pyc('RECORDS = 2\n', DOSSIER),
                           VEHICLES: pyc(SOURCE.replace('x * 2', 'x * 3'), VEHICLES)},
                     data={'scripts/item_defs/vehicles/uk/GB130_FV225_Collector.xml': 'GB130 2'})
    v = write(changed, 'v.3 #3')
    e = session(v)
    check(plan(e)[0] == sorted(TYPES), '2: a function of a module the builds execute changed: every file is rebuilt', plan(e))
    settle(e)

    # 3. a line shift only
    shifted = dict(changed, **{VEHICLES: pyc('\n\n\n' + SOURCE.replace('x * 2', 'x * 3'), VEHICLES)})
    v = write(shifted, 'v.4 #4')
    e = session(v)
    check(plan(e) == ([], True), '3: the same code a few lines lower (other bytes): nothing rebuilt, the sample check only', plan(e))
    settle(e)

    # 4. the executable
    exe[0] = b'exe 2'
    v = write(shifted, 'v.5 #5')
    e = session(v)
    check(plan(e) == ([], True), '4: the game\'s executable changed: the sample check only', plan(e))
    settle(e)

    # 5. the fill-ins' gate
    now = e.client_files()
    old = '<version.xml><version> v.0 #0 </version></version.xml>\n'
    e.client_snapshots[old] = dict(now, **{CREW: (12345, 9)})
    check(e.fill_code(old) == e.fill_code(), '5: a battle of a client whose crew code differed: the fill-in gate stays open')
    e.client_snapshots[old] = dict(now, **{CHASSIS: (12345, 9)})
    check(e.fill_code(old) != e.fill_code(), '5: whose chassis code differed: the gate closes')

    # 6. a module recorded for the first time
    e = session(v)
    check(NEW not in e.code_modules(), "6: the module is not in the shipped set (the test's premise)")
    if hasattr(e, 'code_record'): e.code_record([NEW])
    again = session(v)
    watched = (again.code_state().get('watch') or {})
    check(hasattr(e, 'code_record') and NEW in watched and NEW not in again.code_modules() and plan(again)[0] == [],
          '6: a module the game records for the first time is watched (second review D), not added to the set: invalidates '
          'nothing', plan(again))
    # ... and when it changes: the sample check (kept until it ran), never a generation (second review D)
    changed_new = dict(shifted, **{NEW: pyc('def read():\n    return 1\n', NEW),
                                    'scripts/common/items/readers/another.pyc': pyc('X = 1\n', 'scripts/common/items/readers/another.pyc')})
    v = write(changed_new, 'v.6 #6')
    e = session(v)
    check(plan(e) == ([], True), '6: a watched module changed: the sample check, no file rebuilt by its key', plan(e))
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
