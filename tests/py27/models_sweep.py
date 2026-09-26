# -*- coding: utf-8 -*-
"""The model sweep of the exporter (25.09, models-sweep; BACKLOG 51): every regular vehicle of the catalogue exported by the
one vehicle export (export_vehicle) in its top configuration, only after the page's Start (Export all models), only while the
page is open in the game, in 60 ms slices with one frame of the game between them, one unit of work (a vehicle's plan, one
collision model, its file) at a time, and on the next run only the vehicles whose sources or collision models changed (CRCs
from the packages' directories). Inside the client's own python27.dll; temp folders only; the client's descriptors and the
model reader are stand-ins (the offline stand measures the real ones: tests/fixtures-local/ttx-offline/models_sweep_run.py).

    python tests/py27/run27.py tests/py27/models_sweep.py
Verdict through BULLBA_PY27_RESULT (see run27.py). The same report and failure rules as ttx_sweep.py."""
import json, logging, os, shutil, sys, tempfile, time, types, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report = []
failures = []


def check(ok, name):
    report.append(('ok   ' if ok else 'FAIL ') + name)
    if not ok: failures.append(name)


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record):
        self.records.append(record)


logs = Collect()
logger = logging.getLogger('local.armor_inspector')
logger.addHandler(logs)
logger.setLevel(logging.INFO)
logger.propagate = False


def logged(text):
    return len([r for r in logs.records if text in r.getMessage()])


class Cache(object):
    def __init__(self):
        self._Cache__vehicles = {}


items = types.ModuleType('items')
client_vehicles = types.ModuleType('items.vehicles')
client_vehicles.g_list = object()
client_vehicles.g_cache = Cache()
items.vehicles = client_vehicles
sys.modules['items'] = items
sys.modules['items.vehicles'] = client_vehicles

# The catalogue: five regular vehicles (G5_Owned is the player's own, exported from the hangar), a battle-mode vehicle, an
# onboarding copy, an event package's vehicle; G4_Broken's gun has no collision model in the client.
REGULAR = ['germany:G1_A', 'germany:G2_B', 'germany:G4_Broken', 'ussr:R1_C', 'usa:A1_E']
OWNED = 'germany:G5_Owned'
ROWS = ([{'id': t.replace(':', '-'), 'type': t} for t in REGULAR + [OWNED]]
        + [{'id': 'germany-G6_Rental_7x7', 'type': 'germany:G6_Rental_7x7', 'modeOnly': True},
           {'id': 'germany-G7_Tiger_NewOnBoarding', 'type': 'germany:G7_Tiger_NewOnBoarding'},
           {'id': 'ussr-R9_Event', 'type': 'ussr:R9_Event'}, {'type': 'bad type'},
           {'id': 'germany-G8_Copy_IGR', 'type': 'germany:G8_Copy_IGR', 'igr': True}])
FOLDERS = {'germany': 'german', 'ussr': 'russian', 'usa': 'american'}


def resources_of(type_name):
    nation, name = type_name.split(':')
    base = 'vehicles/%s/%s/collision_client/' % (FOLDERS[nation], name)
    return [base + part + '.model' for part in ('Chassis', 'Hull', 'Turret_01', 'Gun_01')]


class Component(object):
    def __init__(self, resource):
        self.resource = resource
        self.hitTesterManager = types.ModuleType('manager')
        self.hitTesterManager.activeHitTester = types.ModuleType('tester')
        self.hitTesterManager.activeHitTester.bspModelName = resource
        self.trackPairs = ()


class Descriptor(object):
    """A top configuration's VehicleDescr as far as the sweep and export_vehicle read one."""
    def __init__(self, type_name):
        self.type = types.ModuleType('vtype')
        self.type.name = type_name
        self.type.shortUserString = type_name.split(':')[1]
        self.type.level = 8
        self.type.tags = frozenset(['heavyTank'])
        chassis, hull, turret, gun = [Component(r) for r in resources_of(type_name)]
        self.chassis, self.hull, self.turret, self.gun = chassis, hull, turret, gun
        self.maxHealth = 1500

    def makeCompactDescr(self):
        return ('top ' + self.type.name).encode('ascii')


MODEL = {'kind': 'client-shot-collision', 'groups': [{'material': 'armor', 'vertices': [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 'indices': [0, 1, 2]}]}
temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    game = os.path.join(temp, 'game')
    folder = os.path.join(temp, 'data-folder')
    packages = os.path.join(game, 'res', 'packages')
    os.makedirs(folder)
    os.makedirs(packages)
    # The characteristics' sources (scripts.pkg, an event package) and the collision models (vehicles_*.pkg).
    SOURCES = {'scripts/common/items/vehicles.pyc': 'code 1', 'scripts/item_defs/vehicles/common/vehicle.xml': 'common 1'}
    for type_name in REGULAR + [OWNED, 'germany:G6_Rental_7x7', 'germany:G7_Tiger_NewOnBoarding']:
        nation, name = type_name.split(':')
        SOURCES['scripts/item_defs/vehicles/%s/components/guns.xml' % nation] = nation + ' guns 1'
        SOURCES['scripts/item_defs/vehicles/%s/%s.xml' % (nation, name)] = name + ' 1'
    HAVOK = {}
    for type_name in REGULAR + [OWNED]:
        for resource in resources_of(type_name):
            if type_name == 'germany:G4_Broken' and 'Gun_01' in resource: continue
            HAVOK[resource.replace('.model', '.havok')] = resource + ' 1'

    def write_packages(sources, havok):
        with zipfile.ZipFile(os.path.join(packages, 'scripts.pkg'), 'w') as z:
            for name in sorted(sources): z.writestr(name, sources[name])
        with zipfile.ZipFile(os.path.join(packages, 'last_stand.pkg'), 'w') as z:
            z.writestr('last_stand/scripts/item_defs/vehicles/ussr/R9_Event.xml', 'event 1')
        with zipfile.ZipFile(os.path.join(packages, 'vehicles_level_01.pkg'), 'w') as z:
            for name in sorted(havok): z.writestr(name, havok[name])
        stamp = time.time() + len(logs.records)
        for name in os.listdir(packages): os.utime(os.path.join(packages, name), (stamp, stamp))

    write_packages(SOURCES, HAVOK)
    delay = [0.0]
    extracted = []
    battle_on = [0]

    def fake_extract(data):
        extracted.append(data)
        if delay[0]: time.sleep(delay[0])
        if battle_on[0] and len(extracted) == battle_on[0]: current[0].recorder.in_battle = True
        return dict(MODEL)

    def fake_ttx(type_name, version, log=True):
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA,
                'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [], 'warnings': []}

    def fake_parts(descr, source=None):
        return [{'id': i, 'name': name, 'resource': ex.part_resource(component), 'armor': {},
                 'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}
                for i, name, component in ex.static_parts(descr)]

    built = []

    def fake_top(type_name):
        built.append(type_name)
        return Descriptor(type_name)

    ex.extract, ex.ttx_block, ex.parts_from_descr, ex.top_descriptor = fake_extract, fake_ttx, fake_parts, fake_top
    ex.gun_limits = lambda descr: {'samples': []}
    ex.shot_candidates = lambda descr, installation=None: []
    ex.aim_block = lambda descr: None

    class Recorder(object):
        def __init__(self):
            self.in_battle, self.busy_until, self.page_open_until, self.frames_wanted, self.frames = False, 0.0, time.time() + 600, False, 0

        def wait_frame(self, timeout):
            self.frames += 1

    current = [None]

    def session(version='client 1\n'):
        exporter = ex.Exporter(game, folder, version, os.path.join(temp, 'unused.wotmod'))
        exporter.recorder = Recorder()
        exporter.load_vehicles()
        exporter.start_models_sweep(ROWS)
        current[0] = exporter
        return exporter

    def progress():
        return ex.read_data_file(os.path.join(folder, 'data', 'models-sweep.js'))

    def planned(exporter):
        sweep = exporter.sweeps['models']
        return sorted(sweep['types']) if sweep else []

    def drain(exporter, limit=500):
        for _ in range(limit):
            if exporter.sweeps['models'] is None: break
            exporter.run_job()

    def vehicle_file(type_name):
        return os.path.join(folder, 'data', 'vehicles', ex.vehicle_id(type_name) + '.js')

    # The player's own vehicle, exported from the hangar in HIS configuration (the per-click path).
    owner = ex.Exporter(game, folder, 'client 1\n', os.path.join(temp, 'unused.wotmod'))
    owner.export_vehicle({'schema': 1, 'type': 'vehicle', 'vehicleType': OWNED, 'source': 'hangar',
                          'compactDescriptor': 'aGFuZ2Fy', 'requestedAt': 1.0}, descr=Descriptor(OWNED))
    owned_before = open(vehicle_file(OWNED), 'rb').read()
    requests_log = os.path.join(folder, 'vehicles', 'exports.jsonl')
    log_before = open(requests_log, 'rb').read()
    extracted[:] = []

    # --- the plan: regular vehicles only, nothing runs before Start ---------------------------------------------------
    first = session()
    marker = progress()
    check(planned(first) == sorted(REGULAR), 'the plan: the regular vehicles - no battle-mode, onboarding or event package vehicle, not the player\'s own')
    check(marker['done'] is False and marker['confirmed'] is False and marker['opted'] is False and marker['total'] == 5
          and marker['catalogue'] == 6 and marker['extension'] == ['ussr:R9_Event'], 'progress file: 0 of 5, 6 regular, never started, the event package\'s vehicle named')
    check('germany:G8_Copy_IGR' not in planned(first), 'an internet-cafe copy (premiumIGR) is left out (review 25.09)')
    # 25.09 (user): the same rule marks the catalogue - the page's list of all vehicles leaves these rows out.
    flagged = dict((row['type'], row.get('regular', True)) for row in first.flag_rows([dict(row) for row in ROWS if row.get('id')]))
    check(flagged['germany:G1_A'] is True and not any(flagged[t] for t in ('germany:G6_Rental_7x7', 'germany:G7_Tiger_NewOnBoarding',
          'ussr:R9_Event', 'germany:G8_Copy_IGR')), 'the catalogue: regular:false on the battle-mode, onboarding, event and internet-cafe copies (%s)' % flagged)
    # Review 25.09: a file setup could not read may be the player's own - left alone, never overwritten this session.
    locked = vehicle_file('usa:A1_E')
    with open(locked, 'wb') as stream: stream.write(b'not readable as a record')
    check(first.models_current('usa:A1_E') is True, 'a vehicle file setup could not read is left alone (not overwritten)')
    os.remove(locked)
    for _ in range(5): first.run_job()
    check(not extracted and not built, 'no Start: nothing is read or exported, whatever the page')
    check(first.confirm_sweep('models') and progress()['confirmed'] is True and progress()['opted'] is True, 'Start: running, and from now on the user has opted in')
    check(first.sweep_hurry() and first.recorder.frames_wanted, 'running: the export loop does not wait, the frame callback is wanted')
    # --- slices: one unit of work at a time, a frame between slices ------------------------------------------------------
    # 35 ms a model: the plan (instant), then two models make a slice past 60 ms whatever the system timer (1 ms or 15.6 ms:
    # 35 or 47 ms a sleep, 70 or 94 ms after two) - the third unit never fits (25.09: ttx_sweep flaked at 25 ms).
    delay[0] = 0.035
    first.run_job()
    check(built == ['germany:G1_A'] and len(extracted) == 2 and first.recorder.frames == 0,
          'one slice: the plan and two models (%d), no frame before the first' % len(extracted))
    first.run_job()
    check(first.recorder.frames == 1 and len(extracted) == 4, 'the next slice waits one frame of the game first, then the next two models (%d)' % len(extracted))
    first.run_job()
    check(os.path.isfile(vehicle_file('germany:G1_A')) and built[-1] == 'germany:G2_B' and len(extracted) == 6,
          'the vehicle\'s file follows its models, then the next vehicle\'s plan and models (%s, %d)' % (built, len(extracted)))
    # --- a click meanwhile: first, and the sweep leaves that vehicle alone ----------------------------------------------
    first.request_vehicle_export({'schema': 1, 'type': 'vehicle', 'vehicleType': 'germany:G2_B', 'source': 'picker',
                                  'compactDescriptor': 'cGlja2Vy', 'requestedAt': 2.0})
    check(not first.sweep_hurry(), 'a queued job (a clicked vehicle): the export loop waits as usual')
    real_descr = ex.vehicle_descr
    ex.vehicle_descr = lambda compact: Descriptor('germany:G2_B')
    first.last_job = 0
    first.run_job()
    ex.vehicle_descr = real_descr
    clicked = open(vehicle_file('germany:G2_B'), 'rb').read()
    check(ex.read_data_file(vehicle_file('germany:G2_B'))['source'] == 'picker', 'the clicked vehicle is exported first, as a click exports it')
    first.run_job()
    check(open(vehicle_file('germany:G2_B'), 'rb').read() == clicked and built.count('germany:G2_B') == 1,
          'the sweep then leaves the clicked vehicle alone: no more of its models, its file untouched')
    # --- the gates -------------------------------------------------------------------------------------------------------
    at = len(extracted)
    first.recorder.in_battle = True
    first.run_job()
    check(len(extracted) == at and not first.sweep_hurry(), 'in a battle: nothing (%d)' % (len(extracted) - at))
    first.recorder.in_battle = False
    first.recorder.busy_until = time.time() + 60
    first.run_job()
    check(len(extracted) == at, 'the page being dragged: nothing')
    first.recorder.busy_until = 0
    battle_on[0] = len(extracted) + 1
    delay[0] = 0.01
    first.run_job()
    check(len(extracted) == battle_on[0], 'a battle starting during a model ends the slice before the next unit')
    battle_on[0] = 0
    delay[0] = 0.0
    first.recorder.in_battle = False
    first.ttx_stopped = True
    at = len(extracted)
    first.run_job()
    check(len(extracted) == at and not first.sweep_hurry(), 'the mod shutting down: no unit after it')
    check(progress()['count'] == first.sweeps['models']['next'], 'and what it did since the last report is written once (the resume)')
    first.ttx_stopped = False
    # --- Stop, the page closed -----------------------------------------------------------------------------------------
    done_so_far = first.sweeps['models']['next']
    check(first.stop_sweep('models') and progress()['confirmed'] is False and progress()['count'] == done_so_far, 'Stop: not running, what is done stays (%d)' % done_so_far)
    first.run_job()
    check(len(extracted) == at, 'stopped: nothing')
    first.confirm_sweep('models')
    first.recorder.page_open_until = time.time() - 1
    first.run_job()
    check(len(extracted) == at and progress()['confirmed'] is False, 'the page closed: stopped the same way')

    # --- the next session goes on where this one stopped; the player's file stays his; one vehicle fails ----------------
    extracted[:] = []
    built[:] = []
    second = session()
    check(planned(second) == sorted(t for t in REGULAR if not os.path.isfile(vehicle_file(t)))
          and progress()['confirmed'] is False and progress()['opted'] is True, 'next session: what is not exported yet, waiting for Continue (%s)' % planned(second))
    second.confirm_sweep('models')
    drain(second)
    marker = progress()
    check(second.sweeps['models'] is None and marker['done'] is True, 'resume: the sweep ends')
    check(sorted(marker['keys']) == sorted(set(REGULAR) - set(['germany:G4_Broken', 'germany:G2_B'])) and list(marker['failed']) == ['germany:G4_Broken'],
          'progress file: the keys of the vehicles it exported, the failure by its key (%s / %s)' % (sorted(marker['keys']), list(marker['failed'])))
    check(sorted(marker['parts']) == sorted(set(marker['keys']) | set(marker['failed'])) and len(marker['parts']['germany:G1_A']) == 4,
          'and each one\'s collision models, the next key\'s sources')
    check(logged('Model sweep:') >= 1 and logged('1 failed') == 1 and logged('G4_Broken') >= 1, 'one line for the run, with the failure in it')
    check(open(vehicle_file(OWNED), 'rb').read() == owned_before, 'the player\'s own vehicle file is untouched')
    record = ex.read_data_file(vehicle_file('germany:G1_A'))
    check(record['source'] == 'catalogue' and record['compactDescriptor'] == 'dG9wIGdlcm1hbnk6RzFfQQ==' and len(record['parts']) == 4
          and all(p.get('modelKey') and not p.get('modelError') for p in record['parts']), 'a swept vehicle: its top configuration, every part with its model')
    check(open(requests_log, 'rb').read().count(b'"catalogue"') == 0 and len(open(requests_log, 'rb').read()) > len(log_before),
          'the request log holds the click, not the sweep (a setup replays only the game\'s own requests)')
    rows = second.flag_rows([dict(r) for r in ROWS if 'id' in r])
    check(sorted(r['type'] for r in rows if r['exported']) == sorted(REGULAR + [OWNED]), 'the catalogue: every exported vehicle flagged')

    # --- the same client again: done, only the failure is left (never retried without the user) ------------------------
    extracted[:] = []
    again = session()
    check(planned(again) == ['germany:G4_Broken'] and again.sweeps['models']['confirmed'] is False and progress()['failedOnly'] is True,
          'same client: only the failed vehicle is left, and it waits for the user (no question by itself)')
    for _ in range(5): again.run_job()
    check(not extracted, 'nothing runs without the user')

    # --- a game update: the keys decide -----------------------------------------------------------------------------------
    quiet = session('client 2\n')
    check(planned(quiet) == ['germany:G4_Broken'] and progress()['incremental'] is True, 'new client, nothing changed: nothing to export but the failure')
    rows = quiet.flag_rows([dict(r) for r in ROWS if 'id' in r])
    flagged = sorted(r['type'] for r in rows if r['exported'])
    check('germany:G1_A' in flagged and 'usa:A1_E' in flagged and OWNED not in flagged and 'germany:G2_B' not in flagged,
          'and the files of the old client whose keys held count as this client\'s; the player\'s and the clicked one wait for their own path')
    HAVOK['vehicles/german/G1_A/collision_client/Hull.havok'] = 'hull 2'
    write_packages(SOURCES, HAVOK)
    check(planned(session('client 3\n')) == ['germany:G1_A', 'germany:G4_Broken'], 'one collision model changed: only its vehicle')
    changed = dict(SOURCES, **{'scripts/item_defs/vehicles/usa/A1_E.xml': 'A1_E 2'})
    write_packages(changed, HAVOK)
    check(planned(session('client 4\n')) == ['germany:G1_A', 'germany:G4_Broken', 'usa:A1_E'], 'one vehicle\'s XML changed: it too')
    changed['scripts/item_defs/vehicles/ussr/components/guns.xml'] = 'ussr guns 2'
    write_packages(changed, HAVOK)
    five = planned(session('client 5\n'))
    check(five == ['germany:G1_A', 'germany:G4_Broken', 'usa:A1_E', 'ussr:R1_C'], 'a nation\'s components changed: that nation (%s)' % five)
    full = session('client 5\n')
    full.confirm_sweep('models')
    drain(full)
    check(planned(session('client 6\n')) == ['germany:G4_Broken'], 'all exported again: the next client with the same packages has only the failure left')
    real_format = ex.MODELS_FORMAT
    ex.MODELS_FORMAT = real_format + 1
    check(planned(session('client 6\n')) == sorted(set(REGULAR) - set(['germany:G2_B'])), 'our format raised: every vehicle of the sweep')
    ex.MODELS_FORMAT = real_format
    # --- the keys unreadable: every vehicle of the new client --------------------------------------------------------------
    with open(os.path.join(packages, 'scripts.pkg'), 'wb') as stream: stream.write('not a zip at all')
    broken = session('client 7\n')
    check(planned(broken) == sorted(set(REGULAR) - set(['germany:G2_B'])) + ['ussr:R9_Event'] and logged('Model sweep: the client packages could not be read') >= 1,
          'the packages unreadable: every vehicle of the sweep (the event package\'s told by its tags only), one line (%s)' % planned(broken))
    write_packages(changed, HAVOK)
    # --- a progress file of another shape counts as none; the setup: a sweep that throws, the old setting ---------------
    ex.write_data(os.path.join(folder, 'data', 'models-sweep.js'), ex.MODELS_SWEEP_KEY, {'stamp': {}, 'parts': [], 'keys': {}})
    odd = session('client 8\n')
    check(odd.sweeps['models'] is not None and progress()['opted'] is False, 'a progress file of another shape counts as none (never started)')
    archive = os.path.join(temp, 'test.wotmod')
    z = zipfile.ZipFile(archive, 'w')
    for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
    z.close()
    with open(os.path.join(folder, 'settings.json'), 'wb') as stream: stream.write('{"exportAllVehicles": true}')
    real_start = ex.Exporter.start_models_sweep
    ex.Exporter.start_models_sweep = lambda self, rows: 1 / 0
    try:
        setup_ok = True
        s = ex.Exporter(game, folder, 'client 8\n', archive)
        s.setup()
    except Exception:
        setup_ok = False
    ex.Exporter.start_models_sweep = real_start
    check(setup_ok and logged('Model sweep unavailable this session') == 1 and not [j for j in s.jobs if j[2] == 'vehicle'],
          'a model sweep that throws at setup: the export goes on, one line')
    check(logged('exportAllVehicles is no longer read') == 1 and s.settings == {}, 'settings.json exportAllVehicles: nothing queued, one line')
    # --- outside the game --------------------------------------------------------------------------------------------------
    del sys.modules['items.vehicles']
    items.vehicles = None
    sys.modules['items'] = types.ModuleType('items')
    offline = ex.Exporter(temp, os.path.join(temp, 'offline'), 'client 1\n', os.path.join(temp, 'unused.wotmod'))
    check(offline.start_models_sweep(ROWS) is None and offline.sweeps['models'] is None and not offline.run_job(), 'no client item modules: no sweep')
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    shutil.rmtree(temp, ignore_errors=True)
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
