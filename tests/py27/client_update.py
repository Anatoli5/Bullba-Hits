# -*- coding: utf-8 -*-
"""The user's client update of 02.10 (BACKLOG 55, B17): 2.4.0.1 -> 2.4.0.2, under the client's own python27.dll.

    python tests/py27/run27.py tests/py27/client_update.py

What happened: the update changed scripts/common/items/components/tankmen_components.pyc (crew tables), two dossier .pyc,
the XML of one vehicle (GB130_FV225_Collector and its _siege_mode) and 47 other members of scripts.pkg - and no collision
.havok. The mod then exported again 888 vehicles' models, all 1343 characteristics files and replayed 196 vehicles inside
setup: the same bytes. This test replays it on fake packages that carry the REAL member names of the client and change
exactly the members the real patch changed (tests/fixtures-local/client-update-2026-10-02, made by its make.py from the
installed client and the user's data: names, CRCs, a sample of 61 of his vehicles - never any byte of the client). A member's
content is its real CRC as text, so two clients differ exactly where the real ones do.

  phase 1  client 2.4.0.1: the mod exports the sample (the model sweep for the catalogue ones, the battle, click and hangar
           ones by their own requests) and every characteristics file - left as 0.9.3 left them: model files named by the
           version text, no keys (the files of 0.9.3 are taken over: their models by the sha256 of the .havok they keep);
  phase 2  client 2.4.0.2 (the real difference): nothing is exported again - 0 models, no vehicle file and no characteristics
           file rewritten, every exported vehicle still flagged as exported, no question of a sweep; the code change is
           executed by no build (client_code.CODE_MODULES): only GB130 is rebuilt, a few others as the sample check;
  phase 3  one more update with ONE collision model changed: exactly that model is exported, exactly its vehicle file is
           written again, no characteristics file is written (the guard builds a sample of them and finds them the same);
  phase 4  the same client again: nothing at all.

The client's descriptors, the model reader and ttx_block are stand-ins, as in models_sweep.py. Without the fixture: SKIP.
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import base64, glob, gzip, json, logging, os, shutil, sys, tempfile, time, types, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'client-update-2026-10-02')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
report, failures = [], []


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text)
    else: sys.stdout.write(text)


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


if not os.path.isfile(os.path.join(FIXTURE, 'scope-2.4.0.2.txt.gz')):
    finish(['SKIP: no fixture %s (run its make.py on a machine with the client and the user\'s data)' % FIXTURE], 77)
else:
    logs = Collect()
    logger = logging.getLogger('local.armor_inspector')
    logger.addHandler(logs)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    def logged(text):
        return [line for line in logs.records if text in line]

    with gzip.open(os.path.join(FIXTURE, 'scope-2.4.0.2.txt.gz'), 'rb') as stream:
        SCOPE = [line.split('\t') for line in stream.read().decode('utf-8').splitlines() if line]
    CHANGED = set(line.split('\t')[0] for line in open(os.path.join(FIXTURE, 'scripts-changed-2.4.0.1-2.4.0.2.txt'))
                  if line.strip())
    SAMPLE = json.load(open(os.path.join(FIXTURE, 'vehicles.json')))
    TYPES = sorted(v['type'] for v in SAMPLE)
    BY_TYPE = dict((v['type'], v) for v in SAMPLE)
    NATIONS = sorted(set(t.split(':')[0] for t in TYPES))

    # ---- the fake client -----------------------------------------------------------------------------------------
    class Component(object):
        def __init__(self, resource):
            self.name = resource.rsplit('/', 1)[-1].split('.')[0]
            self.hitTesterManager = types.ModuleType('manager')
            self.hitTesterManager.activeHitTester = types.ModuleType('tester')
            self.hitTesterManager.activeHitTester.bspModelName = resource

    class Descriptor(object):
        def __init__(self, type_name, compact):
            self.type = types.ModuleType('vtype')
            self.type.name = type_name
            self.type.shortUserString = BY_TYPE[type_name].get('name') or type_name
            self.type.level = int(BY_TYPE[type_name].get('level') or 1)
            self.type.tags = frozenset([str(BY_TYPE[type_name].get('class') or 'mediumTank')])
            self.chassis, self.hull, self.turret, self.gun = [Component(r) for r in BY_TYPE[type_name]['resources'][:4]]
            self.chassis.trackPairs = ()
            self.maxHealth = 1000 + self.type.level
            self.compact = compact

        def makeCompactDescr(self):
            return self.compact

    COMPACT = {}
    for vehicle in SAMPLE:
        if vehicle.get('compactDescriptor'): COMPACT[base64.b64decode(vehicle['compactDescriptor'])] = vehicle['type']

    class Item(object):
        def __init__(self, type_name):
            self.name = type_name
            self.level = int(BY_TYPE[type_name].get('level') or 1)
            self.tags = frozenset([str(BY_TYPE[type_name].get('class') or 'mediumTank')])
            self.i18n = types.ModuleType('i18n')
            self.i18n.shortString = BY_TYPE[type_name].get('name') or type_name

    class GList(object):
        def getIDsByName(self, type_name):
            nation, _ = type_name.split(':')
            return NATIONS.index(nation), [t for t in TYPES if t.startswith(nation + ':')].index(type_name)

        def getList(self, nation_id):
            nation = NATIONS[nation_id]
            return dict((i, Item(t)) for i, t in enumerate(t for t in TYPES if t.startswith(nation + ':')))

    def VehicleDescr(typeID=None, compactDescr=None):
        if compactDescr is not None:
            return Descriptor(COMPACT[compactDescr] if compactDescr in COMPACT else compactDescr.split(' ', 1)[1], compactDescr)
        nation_id, innation_id = typeID
        type_name = [t for t in TYPES if t.startswith(NATIONS[nation_id] + ':')][innation_id]
        return Descriptor(type_name, 'top ' + type_name)

    items = types.ModuleType('items')
    client_vehicles = types.ModuleType('items.vehicles')
    client_vehicles.g_list = GList()
    client_vehicles.g_cache = types.ModuleType('g_cache')
    client_vehicles.VehicleDescr = VehicleDescr
    items.vehicles = client_vehicles
    nations = types.ModuleType('nations')
    nations.NAMES = tuple(NATIONS)
    sys.modules.update({'items': items, 'items.vehicles': client_vehicles, 'nations': nations})

    temp = tempfile.mkdtemp()
    SAVED = []
    try:
        from local_armor_inspector import exporter as ex
        SAVED[:] = [ex.extract, ex.ttx_block, ex.parts_from_descr, ex.top_descriptor, ex.gun_limits, ex.shot_candidates,
                    ex.aim_block]
        game = os.path.join(temp, 'game')
        folder = os.path.join(temp, 'data-folder')
        packages = os.path.join(game, 'res', 'packages')
        os.makedirs(folder)
        os.makedirs(packages)
        ORDER = []
        for path, crc, size, package in SCOPE:
            if package not in ORDER: ORDER.append(package)

        def write_client(label, changed=(), havok=None):
            """The client's packages: every member of the fixture, its content the real CRC (old ones marked)."""
            members = {}
            for path, crc, size, package in SCOPE:
                text = crc + (' 2.4.0.1' if path in changed else '')
                if havok and path in havok: text = havok[path]
                members.setdefault(package, []).append((path, text))
            for package, entries in members.items():
                target = os.path.join(packages, package)
                with zipfile.ZipFile(target + '.tmp', 'w') as z:
                    for path, text in entries: z.writestr(path, text)
                if os.path.exists(target): os.remove(target)
                os.rename(target + '.tmp', target)
            with open(os.path.join(game, 'paths.xml'), 'wb') as stream:
                stream.write('<root><Paths><Packages>%s</Packages></Paths></root>'
                             % ''.join('<Package>./res/packages/%s</Package>' % p for p in ORDER))
            # A new size and time for the packages, as an update leaves them.
            stamp = time.time() + len(label)
            for name in os.listdir(packages): os.utime(os.path.join(packages, name), (stamp, stamp))
            with open(os.path.join(game, 'version.xml'), 'wb') as stream:
                stream.write('<version.xml><version> %s </version></version.xml>\n' % label)
            return '<version.xml><version> %s </version></version.xml>\n' % label

        archive = os.path.join(temp, 'test.wotmod')
        z = zipfile.ZipFile(archive, 'w')
        for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
        z.close()

        extracted, ttx_built = [], []

        def fake_extract(data):
            extracted.append(data)
            return {'kind': 'client-shot-collision', 'groups': [{'material': 'armor', 'vertices': [[0, 0, 0]], 'indices': []}]}

        def fake_ttx(type_name, version, log=True):
            ttx_built.append(type_name)
            return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA,
                    'format': ex.TTX_FORMAT, 'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                    'producedAt': time.time(), 'buildMs': 1.0 + len(ttx_built) % 7,
                    'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [{'turret': 0, 'gun': 'g'}], 'warnings': []}

        def fake_parts(descr, source=None):
            return [{'id': i, 'name': name, 'resource': ex.part_resource(component), 'armor': {},
                     'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}
                    for i, name, component in ex.static_parts(descr)]

        ex.extract, ex.ttx_block, ex.parts_from_descr = fake_extract, fake_ttx, fake_parts
        ex.top_descriptor = lambda type_name: VehicleDescr(typeID=client_vehicles.g_list.getIDsByName(type_name))
        ex.gun_limits = lambda descr: {'samples': []}
        ex.shot_candidates = lambda descr, installation=None: []
        ex.aim_block = lambda descr: None

        class Recorder(object):
            def __init__(self):
                self.in_battle, self.busy_until, self.page_open_until, self.frames_wanted = False, 0.0, time.time() + 3600, False

            def wait_frame(self, timeout):
                pass

        def session(version):
            exporter = ex.Exporter(game, folder, version, archive)
            exporter.recorder = Recorder()
            exporter.setup()
            return exporter

        def drain(exporter, start=True, limit=20000):
            """Everything the mod would do with the page open (the user presses Start on what it asks)."""
            for _ in range(limit):
                if start:
                    for kind in ex.SWEEP_ORDER:
                        sweep = exporter.sweeps.get(kind)
                        if sweep is not None and not sweep.get('confirmed'): exporter.confirm_sweep(kind)
                exporter.last_job = 0
                if not exporter.jobs and not any(exporter.sweeps.get(k) for k in exporter.sweeps): break
                exporter.run_job()
                exporter.idle()

        def files(kind):
            return dict((os.path.basename(p), open(p, 'rb').read())
                        for p in glob.glob(os.path.join(folder, 'data', kind, '*.js')))

        def catalogue():
            return dict((r['type'], r) for r in ex.read_data_file(os.path.join(folder, 'data', 'vehicles.js'))['vehicles'])

        # ---- phase 1: the user's state on 2.4.0.1 ---------------------------------------------------------------
        # The user's data as 0.9.3 left it: model files named by the version text, no keys of the vehicle files, no models'
        # index, no characteristics' keys (only the client's snapshot of this mod is kept: phase 2's log line needs it).
        new_naming = getattr(ex.Exporter, 'model_ref', None)
        if new_naming is not None: ex.Exporter.model_ref = lambda self, resource, version: ex.model_key(resource, version)
        v1 = write_client('v.2.4.0.1 #950', CHANGED)
        first = session(v1)
        for vehicle in SAMPLE:
            if vehicle['source'] != 'catalogue':
                first.export_vehicle({'schema': 1, 'type': 'vehicle', 'vehicleType': vehicle['type'], 'source': vehicle['source'],
                                      'compactDescriptor': vehicle['compactDescriptor'], 'requestedAt': 1.0})
        drain(first)
        if new_naming is not None: ex.Exporter.model_ref = new_naming
        for name in ('vehicle-keys.json', 'models-index.json', 'ttx-sweep.js'):
            if os.path.exists(os.path.join(folder, 'data', name)): os.remove(os.path.join(folder, 'data', name))
        before_models, before_vehicles, before_ttx = files('models'), files('vehicles'), files('ttx')
        check(all(ex.model_key(r, v1) + '.js' in before_models for v in SAMPLE for r in v['resources']),
              'phase 1: the model files are named as 0.9.3 named them (by the version text)')
        resources = set(r for v in SAMPLE for r in v['resources'])
        check(len(before_vehicles) == len(SAMPLE) and len(before_ttx) == len(TYPES) and len(extracted) == len(resources),
              'phase 1 (2.4.0.1): every sampled vehicle, its models and its characteristics are exported',
              '%d vehicles, %d ttx, %d models' % (len(before_vehicles), len(before_ttx), len(extracted)))

        # ---- phase 2: the real update ---------------------------------------------------------------------------
        del extracted[:], ttx_built[:], logs.records[:]
        v2 = write_client('v.2.4.0.2 #964')
        second = session(v2)
        setup_vehicles = files('vehicles')
        check(setup_vehicles == before_vehicles and not extracted,
              'setup after the update exports nothing (02.10: replay 31.36 s - 196 vehicles and their models)',
              '%d models extracted, %d vehicle files rewritten' % (len(extracted), len([k for k in setup_vehicles
                                                                                       if setup_vehicles[k] != before_vehicles.get(k)])))
        drain(second)
        after_vehicles, after_ttx = files('vehicles'), files('ttx')
        check(not extracted, 'the update changed no collision model: 0 models exported (02.10: 888 vehicles\' models)',
              '%d extracted' % len(extracted))
        rewritten = sorted(k for k in after_vehicles if after_vehicles[k] != before_vehicles.get(k))
        check(not rewritten, 'no vehicle file rewritten with the same content', '%d: %s' % (len(rewritten), rewritten[:3]))
        rewritten = sorted(k for k in after_ttx if after_ttx[k] != before_ttx.get(k))
        check(not rewritten, 'no characteristics file rewritten with the same content (02.10: 1343)',
              '%d: %s' % (len(rewritten), rewritten[:3]))
        samples = [t for t in set(ttx_built) if t != 'uk:GB130_FV225_Collector']
        check('uk:GB130_FV225_Collector' in ttx_built and len(samples) <= ex.VERIFY_SAMPLE_TTX and not logged('Missed change'),
              "the crew's code changed (tankmen_components.pyc), which no build executes: only GB130 (its XML changed) is built "
              "again, and the sample check of a few others finds them the same (02.10: all 1343; decision 1A: all compared)",
              '%d built: %s' % (len(set(ttx_built)), sorted(set(ttx_built))[:5]))
        rows = catalogue()
        check(all(rows[t].get('exported') for t in TYPES), 'every vehicle with a file stays "exported" in the catalogue '
              '(02.10: 817 shown as not exported)', [t for t in TYPES if not rows[t].get('exported')][:3])
        check(logged('Model sweep: 0 of') and not logged('TTX sources: %d of' % len(TYPES)),
              'no sweep to ask the user about', (logged('Model sweep:') + logged('TTX sources:'))[:2])
        line = (logged('Client files changed') or [''])[0]
        check('tankmen_components.pyc' in line and 'GB130_FV225_Collector' in line,
              'the log names what changed in the client', line[:300])
        # The battles' helper (client_crc): a file as an earlier client had it - from this mod's snapshot of that client, or
        # (none taken: the user's 2.4.0.1) derived from the next one and what the update changed (client_changes.py).
        tankmen, xml = 'scripts/common/items/components/tankmen_components.pyc', 'scripts/item_defs/vehicles/germany/G04_PzVI_Tiger_I.xml'
        if hasattr(second, 'client_crc'):
            own = second.client_crc(tankmen, v1)
            check(own and own[0] != '?' and own != second.client_crc(tankmen) and second.client_crc(xml, v1) == second.client_crc(xml),
                  'client_crc of 2.4.0.1 from the snapshot this mod took of it: the changed file differs, another is the same')
            for name in glob.glob(os.path.join(folder, 'data', 'client', 'v.2.4.0.1_950~*.txt.gz')): os.remove(name)
            derived = ex.Exporter(game, folder, v2, archive)
            check(derived.client_crc(tankmen, v1)[0] == '?' and derived.client_crc(xml, v1) == derived.client_crc(xml)
                  and derived.client_crc(xml, '<version.xml><version> v.1.0 #1 </version></version.xml>') is None,
                  'without it, derived from 2.4.0.2 and the update\'s list: the changed file unknown, another the same, an '
                  'unknown client None', (derived.client_crc(tankmen, v1), derived.client_crc(xml, v1)))
        else:
            check(False, 'client_crc of an earlier client (the battles\' helper)')

        # ---- phase 3: one collision model changed ---------------------------------------------------------------
        del extracted[:], ttx_built[:], logs.records[:]
        victim = BY_TYPE[[t for t in TYPES if BY_TYPE[t]['source'] == 'catalogue'][3]]
        havok = victim['resources'][1].replace('.model', '.havok')
        users = sorted(ex.vehicle_id(t) + '.js' for t in TYPES if any(r.replace('.model', '.havok') == havok
                                                                         for r in BY_TYPE[t]['resources']))
        v3 = write_client('v.2.4.0.3 #970', havok={havok: 'a new hull'})
        third = session(v3)
        drain(third)
        now_vehicles, now_ttx = files('vehicles'), files('ttx')
        check(len(extracted) == 1 and extracted[0] == 'a new hull', 'one collision model changed: exactly it is exported',
              '%d extracted' % len(extracted))
        rewritten = sorted(k for k in now_vehicles if now_vehicles[k] != after_vehicles.get(k))
        check(rewritten == users, 'and exactly the vehicle files that use it are written again', '%s, expected %s' % (rewritten, users))
        check(now_ttx == after_ttx and len(ttx_built) <= getattr(ex, 'VERIFY_SAMPLE_TTX', 0) and not logged('Missed change'),
              'no characteristics file is written for a collision model - only the guard\'s sample is built and compared '
              '(VERIFY_SAMPLE_TTX), and it finds no missed change', '%d built' % len(ttx_built))

        # ---- phase 4: the same client again ---------------------------------------------------------------------
        del extracted[:], ttx_built[:]
        fourth = session(v3)
        queued = [job[2] for job in fourth.jobs]
        check(not queued, 'an ordinary start queues nothing (0.9.3: one "ttx" job per requested vehicle on every start - 196)',
              queued[:5])
        drain(fourth)
        check(not extracted and not ttx_built and files('vehicles') == now_vehicles,
              'the same client again: nothing built, nothing exported', '%d models, %d ttx' % (len(extracted), len(ttx_built)))
    except Exception:
        import traceback
        report.append('FAIL exception\n' + traceback.format_exc())
        failures.append('exception')
    finally:
        if SAVED:
            (ex.extract, ex.ttx_block, ex.parts_from_descr, ex.top_descriptor, ex.gun_limits, ex.shot_candidates,
             ex.aim_block) = SAVED
        shutil.rmtree(temp, ignore_errors=True)
    report.append('%d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
    finish(report, 1 if failures else 0)
