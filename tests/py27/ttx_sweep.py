# -*- coding: utf-8 -*-
"""The characteristics sweep of the exporter (24.09, ttx-all-layout): every catalogue type's TTX file, built through
build_ttx only while the page is open in the game and the user said Start, in 60 ms slices with the game alone between
them (at least one frame, and SWEEP_SHARE of the time), with the mod's own wall-clock estimate from the measured pace, and
only for the types whose source files changed (their CRCs in the client's packages). Inside the
client's own python27.dll; temp folders only; ttx_block is a stand-in (the real one needs the client's items.vehicles -
the offline stand measures it).

    python tests/py27/run27.py tests/py27/ttx_sweep.py
Verdict through BULLBA_PY27_RESULT (see run27.py). The same report and failure rules as exporter_safety.py."""
import json, logging, math, os, shutil, sys, tempfile, time, types, zipfile
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

TYPES = ['germany:G1_A', 'germany:G2_B', 'germany:G3_Broken', 'ussr:R1_C', 'ussr:R2_D', 'usa:A1_E']
ROWS = [{'type': name} for name in TYPES] + [{'type': 'ussr:R1_C'}, {'type': 'bad type'}]

temp = tempfile.mkdtemp()
SAVED_TIMER = []
try:
    from local_armor_inspector import exporter as ex
    game = os.path.join(temp, 'game')
    folder = os.path.join(temp, 'data-folder')
    packages = os.path.join(game, 'res', 'packages')
    os.makedirs(folder)
    os.makedirs(packages)
    # The client's packages: scripts.pkg with the items code, the vehicles' common files, each nation's components and
    # list, the vehicles' own XML (and a variant of G1_A, which is G1_A's too); an event package with a vehicle of its
    # own; a package with no characteristics at all.
    SOURCES = {'scripts/common/items/vehicles.pyc': 'code 1', 'scripts/item_defs/vehicles/common/vehicle.xml': 'common 1',
               'scripts/item_defs/vehicles/common/customization.xml': 'paint 1'}
    for nation, names in (('germany', ['G1_A', 'G1_A_7x7', 'G2_B', 'G3_Broken']), ('ussr', ['R1_C', 'R2_D']), ('usa', ['A1_E'])):
        SOURCES['scripts/item_defs/vehicles/%s/components/guns.xml' % nation] = nation + ' guns 1'
        SOURCES['scripts/item_defs/vehicles/%s/list.xml' % nation] = nation + ' list 1'
        for name in names: SOURCES['scripts/item_defs/vehicles/%s/%s.xml' % (nation, name)] = name + ' 1'

    def write_packages(sources, broken=False):
        with zipfile.ZipFile(os.path.join(packages, 'scripts.pkg'), 'w') as z:
            for name in sorted(sources): z.writestr(name, sources[name])
        if broken:
            with open(os.path.join(packages, 'scripts.pkg'), 'wb') as stream: stream.write('not a zip at all')
        with zipfile.ZipFile(os.path.join(packages, 'last_stand.pkg'), 'w') as z:
            z.writestr('last_stand/scripts/item_defs/vehicles/ussr/R9_Event.xml', 'event 1')
        with zipfile.ZipFile(os.path.join(packages, 'maps.pkg'), 'w') as z:
            z.writestr('spaces/01_karelia/space.bin', 'map')
        # A new mtime for every rewrite, as a game update gives.
        stamp = time.time() + len(logs.records)
        for name in os.listdir(packages): os.utime(os.path.join(packages, name), (stamp, stamp))

    write_packages(SOURCES)
    calls = []
    broken = set(['germany:G3_Broken'])
    delay = [0.0]
    # A fake clock for the sweep's slice (review 26.09): time.sleep under the browser suite's load overslept past 60 ms, one
    # build filled a slice and the checks below failed in a cascade. run_sweep reads the module's TTX_TIMER on every call.
    clock = [0.0]
    SAVED_TIMER[:] = [ex.TTX_TIMER]
    ex.TTX_TIMER = lambda: clock[0]
    # A frame of the game on the same fake clock (26.09): 16 ms unless a check says otherwise. The measured pace counts from
    # two vehicles and slices here (the mod: SWEEP_PACE_ITEMS, a session's first vehicles are not its pace).
    frame = [0.016]
    ex.SWEEP_PACE_ITEMS = 2

    class Recorder(object):
        def __init__(self):
            self.in_battle, self.busy_until, self.page_open_until, self.frames_wanted, self.frames = False, 0.0, time.time() + 600, False, 0

        def wait_frame(self, timeout):
            self.frames += 1
            clock[0] += frame[0]

    battle_on_call = [0]

    def fake_block(type_name, version, log=True):
        """What the real ttx_block leaves behind: a parsed type in g_cache, a log line unless told not to."""
        calls.append(type_name)
        CACHE[(type_name, len(calls))] = 'parsed'
        clock[0] += delay[0]  # the fake clock moves by the build's cost: no real sleep, no scheduler in the slice
        if battle_on_call[0] and len(calls) == battle_on_call[0]: current.recorder.in_battle = True
        if type_name in broken: raise ValueError('the client refused this type')
        if log: ex.LOG.info('TTX %s: 1 pairs, 1.0 ms', type_name)
        return {'schema': ex.TTX_SCHEMA, 'modesSchema': ex.TTX_MODES_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA, 'format': ex.TTX_FORMAT,
                'id': ex.vehicle_id(type_name), 'type': type_name, 'clientVersion': version,
                'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': [{'turret': 0, 'gun': 'g'}], 'warnings': []}

    ex.ttx_block = fake_block
    current = None

    def session(version='client 1\n'):
        global current
        exporter = ex.Exporter(game, folder, version, os.path.join(temp, 'unused.wotmod'))
        exporter.recorder = Recorder()
        exporter.start_ttx_sweep(ROWS)
        current = exporter
        return exporter

    def progress():
        return ex.read_data_file(os.path.join(folder, 'data', 'ttx-sweep.js'))

    def drain(exporter, limit=100):
        for _ in range(limit):
            if exporter.ttx_sweep is None: break
            exporter.run_job()

    def planned(exporter):
        return sorted(exporter.ttx_sweep['types']) if exporter.ttx_sweep else []

    # The marker of the first sweep build (24.09, earlier the same day) is removed when a sweep starts.
    with open(os.path.join(folder, 'ttx-sweep.json'), 'wb') as stream: stream.write('{}')

    # --- the first session: every type, waiting for the page's Start -------------------------------------------------
    first = session()
    marker = progress()
    check(planned(first) == sorted(TYPES), 'first session: every catalogue type, each once, a malformed type left out')
    check(marker['done'] is False and marker['confirmed'] is False and marker['count'] == 0 and marker['total'] == 6
          and marker['incremental'] is True and marker['catalogue'] == 6, 'progress file: 0 of 6, not running, by the sources\' keys')
    check(not os.path.exists(os.path.join(folder, 'ttx-sweep.json')), 'the old marker beside the settings is gone')
    # 26.09 (user: the question said ~9 s, the sweep took 74 s): the mod's estimate is the wall-clock time - before this
    # machine has measured anything, SWEEP_MS a vehicle over SWEEP_SHARE of the time.
    check(marker['estimate'] == int(math.ceil(6 * ex.SWEEP_MS['ttx'] / ex.SWEEP_SHARE / 1000.0)) and marker['pace'] == {'target': ex.SWEEP_SHARE},
          'the estimate before any measurement: 6 x %.0f ms over a share of %.2f = %s s' % (ex.SWEEP_MS['ttx'], ex.SWEEP_SHARE, marker['estimate']))
    for _ in range(5): first.run_job()
    check(not calls, 'no Start yet: nothing is built, whatever the page')
    check(first.confirm_sweep('ttx') and progress()['confirmed'] is True, 'Start: running, and the progress file says so')
    # --- slices and frames -----------------------------------------------------------------------------------------
    # 35 ms a build on the fake clock: exactly two builds a 60 ms slice (35 < 60, 70 >= 60).
    delay[0] = 0.035
    check(first.sweep_hurry() and first.recorder.frames_wanted, 'running: the export loop does not wait, the frame callback is wanted')
    first.run_job()
    check(len(calls) == 2 and first.recorder.frames == 0, 'one slice: builds back to back for 60 ms (%d), no frame before the first' % len(calls))
    at = clock[0]
    first.run_job()
    check(first.recorder.frames == 5 and len(calls) == 4, 'the next slice waits for the game first: frames of 16 ms until as long as the slice took (70 ms, SWEEP_SHARE 0.5) - 5 (%d)' % first.recorder.frames)
    # --- the rest between two slices (SWEEP_SHARE, the knob; 26.09) --------------------------------------------------------
    def rest(last, frame_s, share=None, ago=0.0, smoothed=None):
        """One rest after a slice of `last` seconds that ended `ago` s back, with frames of `frame_s`: (frames waited,
        seconds, next slice)."""
        saved = ex.SWEEP_SHARE
        if share is not None: ex.SWEEP_SHARE = share
        probe = first.new_sweep([])
        probe['sliceEnd'], probe['last'], probe['frame'], frame[0] = clock[0] - ago, last, smoothed, frame_s
        frames0, start = first.recorder.frames, clock[0]
        first.sweep_rest(probe)
        ex.SWEEP_SHARE, frame[0] = saved, 0.016
        result = first.recorder.frames - frames0, clock[0] - start, probe['slice']
        clock[0] = start   # a probe, not the sweep's own time
        return result
    waited, spent, next_slice = rest(0.07, 0.016)
    check(waited == 5 and spent >= 0.07 and next_slice == ex.TTX_SWEEP_SLICE, 'rest: as long as the slice at a share of 0.5, frames of 16 ms - 5 frames, %.0f ms; the next slice stays %.0f ms' % (spent * 1000, next_slice * 1000))
    waited, spent, next_slice = rest(0.06, 0.016, share=0.25)
    check(waited == 12 and spent >= 0.18, 'rest: the share constant is the knob - at 0.25 three times the slice (12 frames, %.0f ms)' % (spent * 1000))
    waited, spent, next_slice = rest(0.07, 0.2)
    check(waited == 1 and next_slice == ex.SWEEP_SLICE_MAX, 'slow frames (200 ms): one frame is the rest, the next slice grows to keep the share - up to SWEEP_SLICE_MAX (%.0f ms)' % (next_slice * 1000))
    waited, spent, next_slice = rest(0.07, 0.08)
    check(waited == 1 and abs(next_slice - 0.08) < 1e-9, 'frames of 80 ms: the next slice 80 ms, a share of 0.5 with one frame (%.0f ms)' % (next_slice * 1000))
    # After a pause (a drag, a queued job; review 26.09): the frame is not the pause - the slice stays, the rest is over.
    waited, spent, next_slice = rest(0.07, 0.016, ago=5.0, smoothed=0.016)
    check(waited == 1 and next_slice == ex.TTX_SWEEP_SLICE, 'after a pause of 5 s (a drag): one frame, the frame is 16 ms not the pause - the next slice stays %.0f ms (%.0f)' % (ex.TTX_SWEEP_SLICE * 1000, next_slice * 1000))
    waited, spent, next_slice = rest(0.07, 0.016, ago=60.0, smoothed=0.016)
    check(next_slice == ex.TTX_SWEEP_SLICE, 'after a pause of 60 s: the next slice still %.0f ms (%.0f)' % (ex.TTX_SWEEP_SLICE * 1000, next_slice * 1000))
    # A command of the page waiting (a vehicle, Stop): the rest ends at its first frame, and no slice starts before it is read.
    class Commands(object):
        def __init__(self): self.items = []
        def empty(self): return not self.items
    class Writer(object): pass
    first.recorder.writer = Writer()
    first.recorder.writer.export_queue = Commands()
    first.recorder.writer.export_queue.items.append(('sweepStop', 'ttx'))
    waited, spent, next_slice = rest(0.5, 0.016)
    check(waited == 1, 'a command of the page waiting: the rest ends after one frame (%d), not after the 500 ms of the slice' % waited)
    running = first.sweeps['ttx']
    was_sliced, before = running['sliced'], len(calls)
    running['sliced'] = True
    check(first.run_sweep('ttx') is False and len(calls) == before and not running['sliced'],
          'a command waiting after the rest: no slice before the export loop reads it; the next call slices at once')
    first.recorder.writer.export_queue.items[:] = []
    running['sliced'] = was_sliced
    # --- queued jobs, battle, drag, shutdown ---------------------------------------------------------------------------
    delay[0] = 0.0
    before = len(calls)
    first.queue_job(ex.JOB_BULK, 'ttx', {'vehicleType': 'usa:A9_Queued'})
    check(not first.sweep_hurry() and first.recorder.frames_wanted, 'a queued job: the export loop waits as usual; the frame callback goes on (a chain that stops returns only with the page\'s next open)')
    first.last_job = 0   # the models' PACE after the sweep's last build
    first.run_job()
    check(calls[-1] == 'usa:A9_Queued' and len(calls) == before + 1, 'a queued job (a clicked vehicle) runs before the sweep')
    # 26.09: the exported vehicles' characteristics after a format change waited PACE (0.3 s) each for 0.5 ms of work.
    first.queue_job(ex.JOB_BULK, 'ttx', {'vehicleType': 'usa:A10_Paced'})
    first.queue_job(ex.JOB_BULK, 'ttx', {'vehicleType': 'usa:A11_Paced'})
    delay[0] = 0.035
    first.run_job()
    rested = first.job_rest
    time.sleep(0.05)
    first.run_job()
    check(calls[-2:] == ['usa:A10_Paced', 'usa:A11_Paced'] and abs(rested - 0.035) < 1e-9,
          'characteristics jobs: no PACE between them - after one, the game\'s share of its build time (35 ms at 0.5)')
    first.queue_job(ex.JOB_BULK, 'vehicle', {'vehicleType': 'usa:A12_Model'})
    real_export = first.export_vehicle
    first.export_vehicle = lambda request, **named: None
    first.last_job = 0
    first.run_job()
    first.export_vehicle = real_export
    check(first.job_rest == ex.PACE, 'a vehicle (models: an extraction) keeps PACE after it')
    delay[0] = 0.0
    before = len(calls) - 1
    first.recorder.in_battle = True
    first.run_job()
    check(len(calls) == before + 1 and not first.sweep_hurry() and not first.recorder.frames_wanted, 'in a battle: nothing, and no frame callback')
    first.recorder.in_battle = False
    first.recorder.busy_until = time.time() + 60
    first.run_job()
    check(len(calls) == before + 1, 'the page being dragged: nothing')
    first.recorder.busy_until = 0
    # Review #5: the gates before every build, not only the slice.
    battle_on_call[0] = len(calls) + 1
    delay[0] = 0.01
    first.run_job()
    check(len(calls) == battle_on_call[0], 'a battle starting during a build ends the slice before the next build (review #5)')
    battle_on_call[0] = 0
    delay[0] = 0.0
    first.recorder.in_battle = False
    # Review #6: shutting down.
    first.ttx_stopped = True
    at = len(calls)
    first.run_job()
    check(len(calls) == at and not first.sweep_hurry(), 'the mod shutting down: no build after it (review #6)')
    first.ttx_stopped = False
    # --- Stop, the page closed -------------------------------------------------------------------------------------------
    done_so_far = first.ttx_sweep['next']
    measured = first.ttx_sweep
    check(first.stop_sweep('ttx') and progress()['confirmed'] is False and progress()['count'] == done_so_far,
          'Stop: not running, what is done stays (%d)' % done_so_far)
    marker = progress()
    pace = marker['pace']
    check(abs(pace['ms'] - measured['workMs'] / measured['built']) < 0.01 and pace['ms'] != ex.SWEEP_MS['ttx'] and pace['target'] == ex.SWEEP_SHARE,
          'the measured pace: the slices\' work over the vehicles built (%.1f ms)' % pace['ms'])
    check(0.3 < pace['share'] < 1 and abs(pace['share'] - measured['workMs'] / measured['wallMs']) < 0.001,
          'and the share of the time the work got, the rests between slices counted (%.2f)' % pace['share'])
    check(marker['estimate'] == int(math.ceil((marker['total'] - marker['count']) * pace['ms'] / pace['share'] / 1000.0)),
          'the estimate: what is left x the measured ms over the measured share (%s s)' % marker['estimate'])
    first.run_job()
    check(len(calls) == at, 'stopped: nothing')
    first.confirm_sweep('ttx')
    first.recorder.page_open_until = time.time() - 1
    first.run_job()
    check(len(calls) == at and progress()['confirmed'] is False, 'the page closed: stopped the same way')
    # 25.09: no eviction - the client raises when a type it parsed once is parsed again ("the component is already
    # defined somewhere", items/vehicles.pyc _readInstallableComponents), so a type the sweep parsed stays parsed.
    check(('held', 0) in CACHE and [k for k in CACHE if k[0] in TYPES], 'types parsed by the sweep stay in g_cache (a second parse raises in the client)')
    check(logged('TTX germany:') == 0 and logged('TTX sweep:') == 0, 'no log line per type')

    # --- the next session goes on where this one stopped (asked again), one vehicle failing stops nothing ----------------
    written = [t for t in TYPES if os.path.isfile(first.ttx_path(t))]
    calls[:] = []
    second = session()
    check(planned(second) == sorted(set(TYPES) - set(written)) and progress()['confirmed'] is False,
          'next session: the types not built yet, not running until Start again')
    check(progress()['pace'] == pace and progress()['estimate'] == int(math.ceil(len(planned(second)) * pace['ms'] / pace['share'] / 1000.0)),
          'and its first estimate is at the pace measured the session before')
    second.confirm_sweep('ttx')
    drain(second)
    marker = progress()
    check(not [t for t in calls if t in written] and second.ttx_sweep is None, 'resume: nothing built twice, the sweep ends')
    check(marker['done'] is True and sorted(marker['keys']) == sorted(set(TYPES) - broken) and list(marker['failed']) == ['germany:G3_Broken'],
          'progress file: done, the keys of the 5 current files, the failure by its key')
    check(logged('TTX sweep:') == 1 and logged('1 failed') == 1 and logged('G3_Broken') == 1, 'one line for the run, with the failure in it')

    # --- the same client again: the failed type retried without asking, then nothing at all ---------------------------
    calls[:] = []
    retry = session()
    marker = progress()
    check(planned(retry) == ['germany:G3_Broken'] and retry.ttx_sweep['confirmed'] and marker['done'] and marker['retrying']
          and list(marker['failed']) == ['germany:G3_Broken'], 'same client: only the failed type, retried while the page is open, no question; its failure kept until it is tried (review #4)')
    broken.clear()
    drain(retry)
    check(calls == ['germany:G3_Broken'] and progress()['failed'] == {} and len(progress()['keys']) == 6, 'it builds, and the progress file is clean')
    reads = []
    real_sources = ex.Exporter.ttx_sources
    ex.Exporter.ttx_sources = lambda self, cached: reads.append(1) or real_sources(self, cached)
    calls[:] = []
    again = session()
    check(again.ttx_sweep is None and not calls and not reads, 'the same client, all done: no sweep, no package read at all')

    # --- a game update: only what changed ---------------------------------------------------------------------------------
    quiet = session('client 2\n')
    check(quiet.ttx_sweep is None and reads, 'new client, no source changed: no sweep')
    check(quiet.ttx_current('germany:G1_A') and ex.read_data_file(quiet.ttx_path('germany:G1_A'))['clientVersion'] == 'client 1\n',
          'and a file of the old client with unchanged sources counts as current')
    changed = dict(SOURCES, **{'scripts/item_defs/vehicles/germany/G2_B.xml': 'G2_B 2'})
    write_packages(changed)
    one = session('client 3\n')
    check(planned(one) == ['germany:G2_B'] and progress()['total'] == 1 and progress()['catalogue'] == 6, 'one vehicle\'s XML changed: only it')
    changed['scripts/item_defs/vehicles/germany/G1_A_7x7.xml'] = 'G1_A_7x7 2'
    write_packages(changed)
    check(planned(session('client 4\n')) == ['germany:G1_A', 'germany:G2_B'], 'a variant\'s XML changed: its vehicle too')
    changed['scripts/item_defs/vehicles/ussr/components/guns.xml'] = 'ussr guns 2'
    write_packages(changed)
    check(planned(session('client 5\n')) == ['germany:G1_A', 'germany:G2_B', 'ussr:R1_C', 'ussr:R2_D'], 'a nation\'s components changed: that nation')
    changed['scripts/item_defs/vehicles/common/customization.xml'] = 'paint 2'
    write_packages(changed)
    check(planned(session('client 6\n')) == ['germany:G1_A', 'germany:G2_B', 'ussr:R1_C', 'ussr:R2_D'], 'a paint file changed: nothing more (no characteristic is read from it)')
    changed['scripts/common/items/vehicles.pyc'] = 'code 2'
    write_packages(changed)
    check(planned(session('client 7\n')) == sorted(TYPES), 'the client\'s items code changed: every type')
    SOURCES = changed
    drain_all = session('client 7\n')
    drain_all.confirm_sweep('ttx')
    drain(drain_all)
    check(session('client 8\n').ttx_sweep is None, 'all built: the next client with the same sources has nothing to build')
    real_format = ex.TTX_FORMAT
    ex.TTX_FORMAT = real_format + 1
    check(planned(session('client 8\n')) == sorted(TYPES), 'our format raised: every type')
    ex.TTX_FORMAT = real_format
    session('client 8\n')   # back to the keys of the format in force (its sweep is not run)
    # --- the sources unreadable: every type of the new client, one line ------------------------------------------------
    write_packages(SOURCES, broken=True)
    fallback = session('client 9\n')
    check(planned(fallback) == sorted(TYPES) and progress()['incremental'] is False and logged('TTX sources unreadable') == 1,
          'a package unreadable: every type of this client version, one log line')
    write_packages(SOURCES)
    ex.Exporter.ttx_sources = real_sources

    # --- review #2: a file that cannot be written is one failed vehicle; the sweep goes on ---------------------------------
    real_write = ex.write_data
    def failing(path, key, value):
        if key == 'ttx:germany-G1_A': raise IOError('locked by an antivirus')
        return real_write(path, key, value)
    ex.write_data = failing
    calls[:] = []
    locked = session('client 10\n')
    locked.confirm_sweep('ttx')
    drain(locked)
    ex.write_data = real_write
    check(locked.ttx_sweep is None and len(calls) == 6 and list(progress()['failed']) == ['germany:G1_A'],
          'a file that cannot be written: that vehicle failed, the other five built (review #2)')
    # --- the kept pace: a share measured under another SWEEP_SHARE is not this build's -------------------------------------
    real_write(os.path.join(folder, 'data', 'ttx-sweep.js'), ex.TTX_SWEEP_KEY, {'stamp': {}, 'pace': {'ms': 2000, 'share': 0.3, 'target': 0.25}})
    retuned = session('client 12\n')
    check(progress()['pace'] == {'ms': 2000.0, 'target': ex.SWEEP_SHARE} and progress()['estimate'] == int(math.ceil(6 * 2000 / ex.SWEEP_SHARE / 1000.0)),
          'a share measured under another SWEEP_SHARE is dropped, the ms a vehicle kept (%s)' % progress()['pace'])
    real_write(os.path.join(folder, 'data', 'ttx-sweep.js'), ex.TTX_SWEEP_KEY, {'stamp': {}, 'pace': {'ms': 'fast', 'share': 7}})
    session('client 13\n')
    check(progress()['pace'] == {'target': ex.SWEEP_SHARE}, 'a pace of another shape is none')
    # --- review #1: a progress file of another shape, and a sweep that throws, never cost the export -------------------
    real_write(os.path.join(folder, 'data', 'ttx-sweep.js'), ex.TTX_SWEEP_KEY, {'stamp': {}, 'failed': 5, 'keys': []})
    odd = session('client 11\n')
    check(odd.ttx_sweep is not None and planned(odd) == sorted(TYPES), 'a progress file of another shape counts as none (review #1)')
    archive = os.path.join(temp, 'test.wotmod')
    z = zipfile.ZipFile(archive, 'w')
    for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
    z.close()
    real_start = ex.Exporter.start_ttx_sweep
    ex.Exporter.start_ttx_sweep = lambda self, rows: 1 / 0
    try:
        setup_ok = True
        ex.Exporter(game, folder, 'client 11\n', archive).setup()
    except Exception:
        setup_ok = False
    ex.Exporter.start_ttx_sweep = real_start
    check(setup_ok and logged('TTX sweep unavailable this session') == 1, 'a sweep that throws at setup: the export goes on, one line (review #1)')
    # --- outside the game ------------------------------------------------------------------------------------------------
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
    if SAVED_TIMER: ex.TTX_TIMER = SAVED_TIMER[0]
    shutil.rmtree(temp, ignore_errors=True)
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
