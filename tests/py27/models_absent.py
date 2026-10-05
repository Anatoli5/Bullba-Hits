# -*- coding: utf-8 -*-
"""A vehicle the client lists but has no collision model of (04.10, the user's J29_Nameless and J30_Edelweiss: their XML is
in scripts.pkg, no package holds their .havok - a mod pack keeps copies in res_mods). The model sweep took them for failures:
"2 vehicles failed ... to try them again" on Export all models every session, and a Start that could never succeed. The user's
decision: do not try to export vehicles that are not in the client, do not ask about them, do not read their models from
res_mods.

1. HIS CASE: the progress file and the two vehicle files 0.9.8 left (failed by their keys, parts kept, opted), the next start
   of the game: nothing to export, no question, "2 not in the client" in the log, the rows flagged, the files kept.
2. A fresh folder: the sweep exports the others and does not try these two (no extraction, no file, no warning, no failure).
3. Keyed by the client's snapshot, not the version text: another version text over the same files - nothing looked at again;
   the packages gain their models - they are offered and exported.
4. No snapshot (the fallback): looked at again once per client version.
5. A transient failure - a package that does not read - stays a failure that is offered for a retry.

    python tests/py27/run27.py tests/py27/models_absent.py
Verdict through BULLBA_PY27_RESULT (see run27.py)."""
import base64, logging, os, shutil, sys, tempfile, time, types, zipfile
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


def logged(text, since=0):
    return len([r for r in logs.records[since:] if text in r.getMessage()])


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

NAMELESS, EDELWEISS = 'japan:J29_Nameless', 'japan:J30_Edelweiss'
GONE = [NAMELESS, EDELWEISS]
HELD = ['germany:G1_A', 'ussr:R1_C']
REGULAR = sorted(HELD + GONE)
ROWS = [{'id': t.replace(':', '-'), 'type': t} for t in REGULAR]
FOLDERS = {'germany': 'german', 'ussr': 'russian', 'japan': 'japan'}
NOT_FOUND = 'Collision model not found in client'


def resources_of(type_name):
    nation, name = type_name.split(':')
    base = 'vehicles/%s/%s/collision_client/' % (FOLDERS[nation], name)
    return [base + part + '.model' for part in ('Chassis', 'Hull', 'Turret_01', 'Gun_01')]


def havoks_of(type_name):
    return [r.replace('.model', '.havok') for r in resources_of(type_name)]


class Component(object):
    def __init__(self, resource):
        self.resource = resource
        self.hitTesterManager = types.ModuleType('manager')
        self.hitTesterManager.activeHitTester = types.ModuleType('tester')
        self.hitTesterManager.activeHitTester.bspModelName = resource
        self.trackPairs = ()


class Descriptor(object):
    def __init__(self, type_name):
        self.type = types.ModuleType('vtype')
        self.type.name = type_name
        self.type.shortUserString = type_name.split(':')[1]
        self.type.level = 8
        self.type.tags = frozenset(['heavyTank'])
        self.chassis, self.hull, self.turret, self.gun = [Component(r) for r in resources_of(type_name)]
        self.maxHealth = 1500

    def makeCompactDescr(self):
        return ('top ' + self.type.name).encode('ascii')


MODEL = {'kind': 'client-shot-collision', 'groups': [{'material': 'armor', 'vertices': [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 'indices': [0, 1, 2]}]}
temp = tempfile.mkdtemp()
SAVED_TIMER = []
try:
    from local_armor_inspector import exporter as ex
    clock = [0.0]
    SAVED_TIMER[:] = [ex.TTX_TIMER]
    ex.TTX_TIMER = lambda: clock[0]
    extracted, built = [], []

    def fake_extract(data):
        extracted.append(data)
        return dict(MODEL)

    def fake_ttx(type_name, version, log=True):
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA, 'format': ex.TTX_FORMAT,
                'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [], 'warnings': []}

    def fake_parts(descr, source=None):
        return [{'id': i, 'name': name, 'resource': ex.part_resource(component), 'armor': {},
                 'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}
                for i, name, component in ex.static_parts(descr)]

    def fake_top(type_name):
        built.append(type_name)
        return Descriptor(type_name)

    ex.extract, ex.ttx_block, ex.parts_from_descr, ex.top_descriptor = fake_extract, fake_ttx, fake_parts, fake_top
    client_vehicles.VehicleDescr = lambda compactDescr=None, typeID=None: Descriptor(compactDescr.split(' ', 1)[1])
    ex.gun_limits = lambda descr: {'samples': []}
    ex.shot_candidates = lambda descr, installation=None: []
    ex.aim_block = lambda descr: None

    class Recorder(object):
        def __init__(self):
            self.in_battle, self.busy_until, self.page_open_until, self.frames_wanted, self.frames = False, 0.0, time.time() + 600, False, 0

        def wait_frame(self, timeout):
            self.frames += 1
            clock[0] += 0.016

    class Client(object):
        """One game folder and one data folder of the mod. The client: scripts.pkg (every listed vehicle's XML), one package
        of collision models a level, and the user's mod pack in res_mods - loose copies of the two vehicles' models."""
        def __init__(self, name):
            self.game = os.path.join(temp, name, 'game')
            self.folder = os.path.join(temp, name, 'data-folder')
            self.packages = os.path.join(self.game, 'res', 'packages')
            os.makedirs(self.folder)
            os.makedirs(self.packages)
            self.stamp = time.time() + 1000 * len(os.listdir(temp))
            self.scripts()
            self.models('vehicles_level_08.pkg', HELD)
            for type_name in GONE:
                for havok in havoks_of(type_name):
                    path = os.path.join(self.game, 'res_mods', '1.0', *havok.split('/'))
                    if not os.path.isdir(os.path.dirname(path)): os.makedirs(os.path.dirname(path))
                    with open(path, 'wb') as stream: stream.write('a mod pack copy of ' + havok)
            self.manifest()

        def scripts(self, changed=()):
            """scripts.pkg: every listed vehicle's XML (those of `changed` with other contents)."""
            path = os.path.join(self.packages, 'scripts.pkg')
            files = {'scripts/common/items/vehicles.pyc': 'code 1', 'scripts/item_defs/vehicles/common/vehicle.xml': 'common 1'}
            for type_name in REGULAR:
                nation, short = type_name.split(':')
                files['scripts/item_defs/vehicles/%s/components/guns.xml' % nation] = nation + ' guns 1'
                files['scripts/item_defs/vehicles/%s/%s.xml' % (nation, short)] = short + (' 2' if type_name in changed else ' 1')
            with zipfile.ZipFile(path, 'w') as z:
                for name in sorted(files): z.writestr(name, files[name])
            self.stamp += 10
            os.utime(path, (self.stamp, self.stamp))

        def manifest(self):
            names = sorted(n for n in os.listdir(self.packages) if n.endswith('.pkg'))
            with open(os.path.join(self.game, 'paths.xml'), 'wb') as stream:
                stream.write('<root><Paths><Path>./res_mods/1.0</Path><Packages>%s</Packages></Paths></root>'
                             % ''.join('<Package>./res/packages/%s</Package>' % n for n in names))

        def models(self, package, type_names):
            """A package of the client with these vehicles' collision models (written, or written over)."""
            path = os.path.join(self.packages, package)
            with zipfile.ZipFile(path, 'w') as z:
                for type_name in type_names:
                    for havok in havoks_of(type_name): z.writestr(havok, havok + ' 1')
            self.stamp += 10
            os.utime(path, (self.stamp, self.stamp))
            self.manifest()

        def session(self, version='client 1\n', snapshot=True):
            exporter = ex.Exporter(self.game, self.folder, version, os.path.join(temp, 'unused.wotmod'))
            exporter.recorder = Recorder()
            if not snapshot: exporter.client_state = False   # the client's files unreadable: the keys fall back to the version
            exporter.load_vehicles()
            exporter.start_models_sweep(ROWS)
            return exporter

        def progress(self):
            return ex.read_data_file(os.path.join(self.folder, 'data', 'models-sweep.js'))

        def vehicle_file(self, type_name):
            return os.path.join(self.folder, 'data', 'vehicles', ex.vehicle_id(type_name) + '.js')

    def planned(exporter):
        sweep = exporter.sweeps['models']
        return sorted(sweep['types']) if sweep else []

    def drain(exporter, limit=500):
        for _ in range(limit):
            if exporter.sweeps['models'] is None: break
            exporter.run_job()
        exporter.write_keys(force=True)

    def start(exporter):
        started = exporter.confirm_sweep('models')
        drain(exporter)
        return started

    def flags(exporter):
        rows = exporter.flag_rows([dict(r) for r in ROWS])
        return dict((r['type'], (bool(r.get('exported')), bool(r.get('notInClient')))) for r in rows)

    # ================= 1. HIS CASE: what 0.9.8 left, and the next start of the game =========================================
    his = Client('his')
    old = his.session()
    start(old)
    # The two vehicle files 0.9.8's sweep wrote (the one vehicle export, 'catalogue': every part with its honest error) and
    # its progress file: the two failed by their keys, their parts kept, not done, the user had started the sweep.
    for type_name in GONE:
        old.export_vehicle({'schema': 1, 'type': 'vehicle', 'vehicleType': type_name, 'source': 'catalogue', 'requestedAt': 1.0,
                            'compactDescriptor': base64.b64encode('top ' + type_name)}, sweep=True, descr=Descriptor(type_name))
    old.write_keys(force=True)
    stale = dict((t, open(his.vehicle_file(t), 'rb').read()) for t in GONE)
    record = ex.read_data_file(his.vehicle_file(NAMELESS))
    check(record['source'] == 'catalogue' and len(record['parts']) == 4 and all(p.get('modelError') == NOT_FOUND for p in record['parts']),
          'his case, the setup: the vehicle file 0.9.8 left - four parts, each "%s"' % NOT_FOUND)
    left = his.progress()
    left.pop('absent', None)
    left.pop('returned', None)
    left.update({'done': False, 'count': 0, 'total': 2, 'opted': True, 'failedOnly': True, 'confirmed': False, 'keys': {},
                 'failed': {NAMELESS: '810749fe.f3846c40dc66.c7305b99', EDELWEISS: '78ea4397.f3846c40dc66.fc68e6ff'},
                 'parts': dict((t, resources_of(t)) for t in GONE)})
    ex.write_data(os.path.join(his.folder, 'data', 'models-sweep.js'), ex.MODELS_SWEEP_KEY, left)
    extracted[:] = []
    built[:] = []
    mark = len(logs.records)
    now = his.session()
    marker = his.progress()
    check(planned(now) == [] and now.sweeps['models'] is None, 'his case: the next start has nothing to export (%s)' % planned(now))
    check(marker['done'] is True and marker['total'] == 0 and marker['failedOnly'] is False and marker['failed'] == {},
          'his case: the progress file - done, nothing failed, no failures to try again (done %r, total %r, failedOnly %r, failed %s)'
          % (marker['done'], marker['total'], marker['failedOnly'], sorted(marker['failed'])))
    check(sorted(marker.get('absent') or {}) == GONE and marker['opted'] is True,
          'his case: the two are kept as not in the client (%s)' % sorted(marker.get('absent') or {}))
    check(logged('Model sweep: 0 of 4 regular vehicles to export, 2 not in the client', mark) == 1
          and logged('failed before', mark) == 0, 'his case: one line - "0 of 4 regular vehicles to export, 2 not in the client" (%s)'
          % [r.getMessage() for r in logs.records[mark:] if 'Model sweep' in r.getMessage()])
    check(now.confirm_sweep('models') is False and not extracted and not built and logged('Model export unavailable', mark) == 0,
          'his case: a Start has nothing to try again - no model read, no warning')
    check(all(open(his.vehicle_file(t), 'rb').read() == stale[t] for t in GONE), 'his case: his two vehicle files stay as they are')
    seen = flags(now)
    check(seen[NAMELESS] == (False, True) and seen[EDELWEISS] == (False, True) and seen['germany:G1_A'] == (True, False),
          'his case: the catalogue rows - the two not in the client and without a model, the others exported (%s)' % seen)
    mark = len(logs.records)
    later = his.session()
    check(planned(later) == [] and sorted(his.progress().get('absent') or {}) == GONE and logged('failed before', mark) == 0
          and flags(later)[NAMELESS] == (False, True), 'his case: the start after it - the same, nothing asked')

    # ================= 2. A fresh folder: the sweep does not try them ========================================================
    fresh = Client('fresh')
    one = fresh.session()
    check(planned(one) == REGULAR, 'fresh: the plan is every regular vehicle - which of them the client has no model of is not known yet')
    extracted[:] = []
    mark = len(logs.records)
    start(one)
    marker = fresh.progress()
    check(sorted(marker['keys']) == sorted(HELD) and marker['failed'] == {} and sorted(marker.get('absent') or {}) == GONE and marker['done'] is True,
          'fresh: the two with models exported, nothing failed, the two others not in the client (keys %s, failed %s, absent %s)'
          % (sorted(marker['keys']), sorted(marker['failed']), sorted(marker.get('absent') or {})))
    check(len(extracted) == 8 and logged('Model export unavailable', mark) == 0 and not any(os.path.isfile(fresh.vehicle_file(t)) for t in GONE),
          'fresh: no extraction tried for them, no warning, no vehicle file (%d models read)' % len(extracted))
    check(logged('Model sweep: 2 not in the client (japan:J29_Nameless, japan:J30_Edelweiss)', mark) == 1 and logged(' 0 failed', mark) == 1,
          'fresh: the run\'s lines - 0 failed, and "2 not in the client" with their names (%s)'
          % [r.getMessage()[:90] for r in logs.records[mark:] if 'Model sweep' in r.getMessage()])
    check(flags(one)[NAMELESS] == (False, True) and flags(one)['ussr:R1_C'] == (True, False), 'fresh: the rows are flagged right after the run')
    two = fresh.session()
    check(planned(two) == [] and two.sweeps['models'] is None, 'fresh: the next start has nothing to export and nothing to ask')
    # The click's path keeps its honest error (a vehicle the page asks for by name, a battle's): unchanged.
    two.export_vehicle({'schema': 1, 'type': 'vehicle', 'vehicleType': EDELWEISS, 'source': 'picker', 'requestedAt': 2.0,
                        'compactDescriptor': base64.b64encode('top ' + EDELWEISS)}, descr=Descriptor(EDELWEISS))
    clicked = ex.read_data_file(fresh.vehicle_file(EDELWEISS))
    check(all(p.get('modelError') == NOT_FOUND for p in clicked['parts']) and flags(two)[EDELWEISS] == (False, True),
          'fresh: a vehicle exported by name still says "%s" on each part, and its row stays not in the client' % NOT_FOUND)

    # ================= 3. Keyed by the snapshot, not by the version text ====================================================
    mark = len(logs.records)
    renamed = fresh.session('client 2\n')
    check(planned(renamed) == [] and sorted(fresh.progress().get('absent') or {}) == GONE,
          'another version text over the same client files: nothing is looked at again (%s)' % planned(renamed))
    # A game update changes their data while their models are still missing: nothing offered, and the background check of
    # the client's change (start_verify) does not build the file a click left again either - the other changed vehicle's it does.
    two.write_keys(force=True)
    fresh.scripts(changed=[EDELWEISS, 'germany:G1_A'])
    updated = fresh.session()
    updated.start_verify()
    checked = sorted(i for i in ((updated.sweeps.get('verify') or {}).get('types') or []) if not i.startswith('sample-'))
    check(planned(updated) == [] and sorted(fresh.progress().get('absent') or {}) == GONE and checked == ['vehicle:germany-G1_A'],
          'their data changed, their models still missing: not offered, and their file is not built again in the background (%s, %s)'
          % (planned(updated), checked))
    # The client gains the two vehicles' models (his folder: the two stale files of the sweep's own are there).
    his.models('vehicles_level_09.pkg', GONE)
    shutil.rmtree(os.path.join(his.game, 'res_mods'))   # the mod pack gone: nothing overrides them
    mark = len(logs.records)
    gained = his.session()
    marker = his.progress()
    check(planned(gained) == GONE and marker['failedOnly'] is False and not marker.get('absent') and marker['total'] == 2 and marker['opted'] is True,
          'the packages gain their models: both are offered - as vehicles to export, not as failures (%s, absent %s)'
          % (planned(gained), sorted(marker.get('absent') or {})))
    check(logged('Model sweep: 2 of 4 regular vehicles to export', mark) == 1 and logged('not in the client', mark) == 0,
          'and the start\'s line says 2 of 4 to export')
    extracted[:] = []
    start(gained)
    record = ex.read_data_file(his.vehicle_file(NAMELESS))
    check(len(extracted) == 8 and all(p.get('modelKey') and not p.get('modelError') for p in record['parts'])
          and flags(gained)[NAMELESS] == (True, False) and his.progress()['failed'] == {} and his.progress()['done'] is True,
          'Start: both exported with their models, the rows exported (%d models read)' % len(extracted))
    check(planned(his.session()) == [], 'and the start after it has nothing left')
    # Only one of a vehicle's models missing: the same - a retry cannot bring it.
    part = Client('part')
    path = os.path.join(part.packages, 'vehicles_level_09.pkg')
    with zipfile.ZipFile(path, 'w') as z:
        for havok in havoks_of(NAMELESS)[:3]: z.writestr(havok, havok + ' 1')
    part.manifest()
    partly = part.session()
    start(partly)
    marker = part.progress()
    check(sorted(marker.get('absent') or {}) == GONE and marker['failed'] == {} and planned(part.session()) == [],
          'a vehicle with one model missing in the packages is not in the client either (absent %s, failed %s)'
          % (sorted(marker.get('absent') or {}), sorted(marker['failed'])))
    check(flags(partly)[NAMELESS] == (False, False) and flags(partly)[EDELWEISS] == (False, True),
          'its row is an ordinary one without a model (a click still exports what the client has); the one with no model at all says so')

    # ================= 4. No snapshot: once per client version ===============================================================
    blind = Client('blind')
    first = blind.session(snapshot=False)
    start(first)
    marker = blind.progress()
    check(sorted(marker.get('absent') or {}) == GONE and marker['failed'] == {} and all(os.path.isfile(blind.vehicle_file(t)) for t in HELD)
          and not any(os.path.isfile(blind.vehicle_file(t)) for t in GONE),
          'no snapshot: the run exports the others and finds the two not in the client all the same (absent %s, failed %s)'
          % (sorted(marker.get('absent') or {}), sorted(marker['failed'])))
    check(planned(blind.session(snapshot=False)) == [], 'no snapshot, the same client version: nothing offered')
    update = blind.session('client 2\n', snapshot=False)
    check(planned(update) == GONE and blind.progress()['failedOnly'] is False, 'no snapshot, another client version: looked at again once (%s)' % planned(update))
    extracted[:] = []
    start(update)
    check(not extracted and sorted(blind.progress().get('absent') or {}) == GONE and planned(blind.session('client 2\n', snapshot=False)) == [],
          'and not in the client again: nothing more for this version')

    # ================= 5. A transient failure stays a failure that is offered again =========================================
    shaky = Client('shaky')
    shaky.models('vehicles_level_09.pkg', GONE)
    shutil.rmtree(os.path.join(shaky.game, 'res_mods'))
    good = open(os.path.join(shaky.packages, 'vehicles_level_09.pkg'), 'rb').read()
    with open(os.path.join(shaky.packages, 'vehicles_level_09.pkg'), 'wb') as stream: stream.write('not a zip at all')
    mark = len(logs.records)
    run = shaky.session()
    start(run)
    marker = shaky.progress()
    check(sorted(marker['failed']) == GONE and not marker.get('absent') and logged('a client package did not read', mark) >= 1,
          'a package that does not read: its vehicles FAILED, not "not in the client" (failed %s, absent %s)'
          % (sorted(marker['failed']), sorted(marker.get('absent') or {})))
    again = shaky.session()
    check(planned(again) == GONE and shaky.progress()['failedOnly'] is True and not shaky.progress().get('absent'),
          'the next start offers them for a retry, as before (%s, failedOnly %r)' % (planned(again), shaky.progress()['failedOnly']))
    with open(os.path.join(shaky.packages, 'vehicles_level_09.pkg'), 'wb') as stream: stream.write(good)
    shaky.stamp += 10
    os.utime(os.path.join(shaky.packages, 'vehicles_level_09.pkg'), (shaky.stamp, shaky.stamp))
    retry = shaky.session()
    check(planned(retry) == GONE, 'the package reads again: still offered (%s)' % planned(retry))
    start(retry)
    record = ex.read_data_file(shaky.vehicle_file(EDELWEISS))
    check(shaky.progress()['failed'] == {} and all(p.get('modelKey') and not p.get('modelError') for p in record['parts'])
          and planned(shaky.session()) == [], 'and the retry exports them (failed %s)' % sorted(shaky.progress()['failed']))
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    if SAVED_TIMER: ex.TTX_TIMER = SAVED_TIMER[0]
    shutil.rmtree(temp, ignore_errors=True)
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
