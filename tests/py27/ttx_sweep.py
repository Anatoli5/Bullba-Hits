# -*- coding: utf-8 -*-
"""The background TTX sweep of the exporter (24.09, ttx-all-layout): every catalogue type's characteristics file, built
in the hangar through build_ttx, inside the client's own python27.dll. Temp folders only; ttx_block itself is a stand-in
(the real one needs the client's items.vehicles - the offline stand measured it: 26 ms a type, 1251 types, 9.2 MB).

    python tests/py27/run27.py tests/py27/ttx_sweep.py
Verdict through BULLBA_PY27_RESULT (see run27.py). The same report and failure rules as exporter_safety.py."""
import json, logging, os, shutil, sys, tempfile, time, types
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


# The client's item modules, as far as the sweep touches them: the vehicle list exists, and g_cache keeps the types
# a VehicleDescr parsed (a private dict, name-mangled as in items/vehicles.pyc).
class Cache(object):
    def __init__(self):
        self._Cache__vehicles = {('held', 0): 'the hangar vehicle'}


items = types.ModuleType('items')
client_vehicles = types.ModuleType('items.vehicles')
client_vehicles.g_list = object()
client_vehicles.g_cache = Cache()
items.vehicles = client_vehicles
sys.modules['items'] = items
sys.modules['items.vehicles'] = client_vehicles
CACHE = client_vehicles.g_cache._Cache__vehicles

temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    calls = []
    broken = set(['germany:G3_Broken'])

    def fake_block(type_name, version, log=True):
        """What the real ttx_block leaves behind: a parsed type in g_cache, a log line unless told not to."""
        calls.append(type_name)
        CACHE[(type_name, len(calls))] = 'parsed'
        if type_name in broken: raise ValueError('the client refused this type')
        if log: ex.LOG.info('TTX %s: 1 pairs, 1.0 ms', type_name)
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA,
                'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [{'turret': 0, 'gun': 'g'}], 'warnings': []}

    ex.ttx_block = fake_block
    TYPES = ['germany:G1_A', 'germany:G2_B', 'germany:G3_Broken', 'ussr:R1_C', 'ussr:R2_D', 'usa:A1_E']
    ROWS = [{'type': name} for name in TYPES] + [{'type': 'ussr:R1_C'}, {'type': 'bad type'}]
    folder = os.path.join(temp, 'data-folder')
    os.makedirs(folder)
    # The marker of the first sweep build (24.09, earlier the same day) is removed when a sweep starts.
    with open(os.path.join(folder, 'ttx-sweep.json'), 'wb') as stream: stream.write('{}')

    class Recorder(object):
        in_battle = False
        busy_until = 0.0
        page_open_until = 0.0

    def session(version='client 1\n', recorder=None):
        exporter = ex.Exporter(temp, folder, version, os.path.join(temp, 'unused.wotmod'))
        exporter.recorder = recorder
        exporter.start_ttx_sweep(ROWS)
        return exporter

    def step(exporter):
        """One tick after the pace: what run_job does when the hangar is idle."""
        exporter.last_job = time.time() - ex.TTX_SWEEP_PACE - 0.01
        return exporter.run_job()

    def drain(exporter, limit=50):
        built = 0
        for _ in range(limit):
            if exporter.ttx_sweep is None: break
            if step(exporter): built += 1
        return built

    def progress():
        """The progress file the page reads (data/ttx-sweep.js)."""
        return ex.read_data_file(os.path.join(folder, 'data', 'ttx-sweep.js'))

    def backdate():
        """The files of an earlier session: written well before any sweep of this one began."""
        base = os.path.join(folder, 'data', 'ttx')
        for name in os.listdir(base):
            os.utime(os.path.join(base, name), (time.time() - 3600, time.time() - 3600))

    # --- batching and pace ------------------------------------------------------------------------------------------
    first = session()
    check(first.ttx_sweep is not None and first.ttx_sweep['types'] == TYPES,
          'sweep over the catalogue rows: each type once, a malformed type left out')
    marker = progress()
    check(marker['done'] is False and marker['stamp']['clientVersion'] == 'client 1\n' and marker['count'] == 0 and marker['total'] == 6,
          'progress file written at the start: not done, 0 of the 6 catalogue types')
    check(step(first) and len(calls) == 1, 'one build per step')
    check(not first.run_job() and len(calls) == 1, 'the pace holds: no second build right after the first')
    first.last_job = time.time() - ex.TTX_SWEEP_PACE + 0.5
    check(not first.run_job() and len(calls) == 1, 'nor before TTX_SWEEP_PACE has passed')
    # A queued job goes first: the sweep only runs on an empty queue.
    first.queue_job(ex.JOB_BULK, 'ttx', {'vehicleType': 'usa:A9_Queued'})
    first.last_job = 0
    first.run_job()
    check(calls[-1] == 'usa:A9_Queued' and not first.jobs and first.ttx_sweep['next'] == 1, 'a queued job runs before the sweep')
    # --- never in a battle, never while the page is busy -----------------------------------------------------------
    recorder = Recorder()
    first.recorder = recorder
    recorder.in_battle = True
    before = len(calls)
    for _ in range(5): step(first)
    check(len(calls) == before, 'in a battle: nothing built')
    recorder.in_battle = False
    recorder.busy_until = time.time() + 60
    for _ in range(5): step(first)
    check(len(calls) == before, 'page busy: nothing built')
    recorder.busy_until = 0
    check(step(first) and len(calls) == before + 1, 'back in the hangar: the sweep goes on')
    # --- the client's cache and the log -----------------------------------------------------------------------------
    check(('held', 0) in CACHE and not [k for k in CACHE if k[0] in TYPES], 'types parsed by the sweep dropped from g_cache, the held one kept')
    check(logged('TTX germany:') == 0 and logged('TTX sweep') == 0, 'no log line per type')

    # --- resume: a new session goes on where the last one stopped ---------------------------------------------------
    done_before = [name for name in TYPES if os.path.isfile(first.ttx_path(name))]
    calls[:] = []
    second = session(recorder=Recorder())
    check(all(second.ttx_fresh(name, second.ttx_sweep['started']) for name in done_before),
          'resume: the sweep keeps its own start, so its files are current by their time alone')
    built = drain(second)
    check(not [name for name in calls if name in done_before], 'resume: the files written by this sweep are not built again')
    check(set(calls) == set(TYPES) - set(done_before), 'resume: every remaining type tried once')
    check(second.ttx_sweep is None, 'the sweep ends')
    # --- one vehicle failing stops nothing ---------------------------------------------------------------------------
    marker = progress()
    check(marker['done'] is True and marker['failed'] == ['germany:G3_Broken'], 'marker: done, the failed type named')
    check(all(os.path.isfile(second.ttx_path(name)) for name in TYPES if name not in broken), 'every other file written')
    check(logged('TTX sweep') == 1 and logged('1 failed') == 1 and logged('G3_Broken') == 1,
          'one line for the run, with the failure in it')
    check(marker['count'] == marker['total'] == 6, 'progress file at the end: 6 of 6')
    # --- once per client version: nothing to do, then only the failed type ------------------------------------------
    calls[:] = []
    broken.clear()
    third = session(recorder=Recorder())
    check(third.ttx_sweep is not None and third.ttx_sweep['types'] == ['germany:G3_Broken'], 'next session: only the failed type again')
    check(progress()['done'] is True and progress()['count'] == 6, 'the retry of a failed type is no sweep to the page: done, 6 of 6')
    drain(third)
    marker = progress()
    check(calls == ['germany:G3_Broken'] and marker['done'] and marker['failed'] == [], 'it builds, and the marker is clean')
    calls[:] = []
    fourth = session(recorder=Recorder())
    check(fourth.ttx_sweep is None and not calls, 'the same client again: no sweep at all')
    # --- a new client version: every file again ----------------------------------------------------------------------
    backdate()
    fifth = session('client 2\n', Recorder())
    drain(fifth)
    check(sorted(calls) == sorted(TYPES), 'new client version: every type built again')
    check(all(ex.read_data_file(fifth.ttx_path(name))['clientVersion'] == 'client 2\n' for name in TYPES), 'with the new version')
    # A file schema bump is the same stamp change.
    stamp = fifth.ttx_sweep_stamp()
    stamp['armorSchema'] = ex.TTX_ARMOR_SCHEMA + 1
    check(stamp != fifth.ttx_sweep_stamp(), 'the stamp carries the file schemas')
    # --- the fast pace: the page open in the game ---------------------------------------------------------------------
    backdate()
    calls[:] = []
    open_page = Recorder()
    open_page.page_open_until = time.time() + 60
    fast = session('client 3\n', open_page)
    slow_block = ex.ttx_block
    def slow(type_name, version, log=True):
        time.sleep(0.025)
        return slow_block(type_name, version, log)
    ex.ttx_block = slow
    fast.last_job = time.time()   # just built: the slow pace would wait a second, the fast one does not
    check(fast.run_job() and 2 <= len(calls) <= 4, 'page open: builds back to back within one 60 ms slice (%d built)' % len(calls))
    before = len(calls)
    open_page.in_battle = True
    for _ in range(3): fast.run_job()
    check(len(calls) == before, 'page open but in a battle: nothing')
    open_page.in_battle = False
    open_page.busy_until = time.time() + 60
    fast.run_job()
    check(len(calls) == before, 'page open but being dragged: nothing')
    open_page.busy_until = 0
    open_page.page_open_until = time.time() - 1
    fast.last_job = time.time()
    fast.run_job()
    check(len(calls) == before, 'page closed: back to the slow pace (nothing within the second)')
    fast.last_job = 0
    fast.run_job()
    check(len(calls) == before + 1, 'and one build a second after it')
    ex.ttx_block = slow_block
    open_page.page_open_until = time.time() + 60
    for _ in range(20):
        if fast.ttx_sweep is None: break
        fast.run_job()
    check(fast.ttx_sweep is None and sorted(calls) == sorted(TYPES) and progress()['done'] and 'TTX sweep: 6 types - 6 built' in logs.records[-1].getMessage() and 'of it fast' in logs.records[-1].getMessage(),
          'page open again: the sweep finishes fast, one line with its fast seconds')
    check(not os.path.exists(os.path.join(folder, 'ttx-sweep.json')), 'the old marker beside the settings is gone')
    # --- outside the game --------------------------------------------------------------------------------------------
    del sys.modules['items.vehicles']
    items.vehicles = None
    sys.modules['items'] = types.ModuleType('items')
    offline = ex.Exporter(temp, os.path.join(temp, 'offline'), 'client 1\n', os.path.join(temp, 'unused.wotmod'))
    check(offline.start_ttx_sweep(ROWS) is None and offline.ttx_sweep is None and not offline.run_job(),
          'no client item modules: no sweep')
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
