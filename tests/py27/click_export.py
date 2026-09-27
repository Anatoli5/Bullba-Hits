# -*- coding: utf-8 -*-
"""A click on a vehicle the game has not exported yet (click-export-fast, 26.09; the user: "he clicks and nothing happens").

The chain on the export thread, inside the client's own python27.dll, with a fake clock and stand-in jobs (no client):
  - the page's click ('picker'), its characteristics ('exportTtx') and the models of an opened hit ('prioritise') are JOB_PAGE;
  - they run back to back: no PACE between them, not held by a drag of the page, and the export loop takes the next one
    without its 50 ms wait for a message (export_hurry); the vehicle job says in the log how long it took;
  - background work keeps its pace: after them a roster model waits for the drag to end and for PACE;
  - a battle holds everything, the click included;
  - a sweep yields: a waiting command ends its slice after the step under way, and no slice runs while a job is queued;
  - the game thread: a second click of the same vehicle reaches the export thread (the hangar's repeats are still dropped),
    and a page opened on a vehicle (the mods list button, the context menu) puts it first (page_waits);
  - the export loop itself (Writer.run_export): no wait while export_hurry says so, its 50 ms otherwise.

    python tests/py27/run27.py tests/py27/click_export.py
Verdict through BULLBA_PY27_RESULT (see run27.py)."""
import imp, logging, os, shutil, sys, tempfile, time, types
try:
    import Queue as queue
except ImportError:
    import queue
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report = []
failures = []


def check(ok, name, extra=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' ' + str(extra) if extra and not ok else ''))
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


class Clock(object):
    """The exporter's time.time() and TTX_TIMER, moved by hand."""
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def timer(self):
        return self.now


class NS(object):
    def __init__(self, **kw):
        self.__dict__.update(kw)


temp = tempfile.mkdtemp()
saved = {}
try:
    from local_armor_inspector import exporter as ex
    clock = Clock()
    saved['time'], saved['timer'] = ex.time, ex.TTX_TIMER
    ex.time = NS(time=clock.time)
    ex.TTX_TIMER = clock.timer
    game, folder = os.path.join(temp, 'game'), os.path.join(temp, 'data-folder')
    os.makedirs(game)
    os.makedirs(folder)
    e = ex.Exporter(game, folder, 'client 1\n')
    commands = queue.Queue()
    rec = NS(in_battle=False, busy_until=0.0, page_open_until=0.0, frames_wanted=False, writer=NS(export_queue=commands),
             wait_frame=lambda timeout=0.1: None)
    e.recorder = rec
    ran = []
    e.run_model_job = lambda payload: ran.append(('model', payload[0], clock.now))
    e.run_ttx_job = lambda payload: ran.append(('ttx', payload.get('vehicleType'), clock.now))

    def export_vehicle(request):
        ran.append(('vehicle', request.get('vehicleType'), clock.now))
        return True
    e.export_vehicle = export_vehicle
    V = 'client 1\n'
    # --- the queue before the click: a battle's roster models (background), the pace just started after one of them ---------
    for n in range(3):
        e.queue_model('vehicles/german/Bulk/collision_client/Part_%d.model' % n, V, 'k%d' % n, {'type': 'germany:Bulk'}, None, ex.JOB_BULK)
    e.last_job, e.job_rest = clock.now, ex.PACE
    rec.busy_until = clock.now + 2.0   # the user is dragging the scene
    # --- the click: the page's vehicle, its characteristics, the models of a hit of it the page opened -------------------------
    e.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:Clicked', 'compactDescriptor': 'x', 'requestedAt': clock.now - 0.25})
    e.request_ttx('germany:Clicked')
    for n in range(2):
        e.queue_model('vehicles/german/Clicked/collision_client/Part_%d.model' % n, V, 'c%d' % n, {'type': 'germany:Clicked'}, None, ex.JOB_BULK)
    check(e.prioritise(['germany:Clicked']) == 2, 'prioritise: the opened vehicle\'s two queued models are lifted')
    pages = [j for j in e.jobs if j[0] == ex.JOB_PAGE]
    check(len(pages) == 4 and set(j[2] for j in pages) == set(['vehicle', 'ttx', 'model'])
          and all(j[0] == ex.JOB_BULK for j in e.jobs if j not in pages),
          'priorities: the click (picker), its characteristics and its models are JOB_PAGE, the roster stays JOB_BULK',
          [(j[0], j[2]) for j in e.jobs])
    check(ex.VEHICLE_PRIORITY['picker'] == ex.JOB_PAGE and ex.VEHICLE_PRIORITY['battle'] == ex.JOB_BULK
          and ex.VEHICLE_PRIORITY['catalogue'] == ex.JOB_BULK and ex.VEHICLE_PRIORITY['hangar'] == ex.JOB_PLAYER,
          'the sources\' turns are unchanged')
    # --- they run back to back at the same instant: no PACE, no drag gate, the loop does not wait between them --------------------
    follows = []
    for n in range(4):
        check(e.run_job(), 'the page\'s job %d runs at once (within PACE of the last job, during a drag)' % (n + 1))
        follows.append(e.export_hurry())
    check([r[0] for r in ran] == ['vehicle', 'ttx', 'model', 'model'] and all(r[2] == ran[0][2] for r in ran),
          'the clicked vehicle first, then its characteristics and models - all at one instant', ran)
    check(follows == [True, True, True, False], 'export_hurry: no wait for a message while another page job is queued, then the usual wait', follows)
    check(logged('Vehicle germany:Clicked for the page: exported in') == 1 and logged('0.25 s after the request') == 1,
          'the page\'s vehicle job says in the log how long it took and how long after the click')
    # --- background work keeps its pace -----------------------------------------------------------------------------------------
    check(not e.run_job() and len(ran) == 4, 'a roster model: held while the page is dragged')
    rec.busy_until = 0.0
    check(not e.run_job() and len(ran) == 4, 'a roster model: then PACE after the last job')
    clock.now += ex.PACE + 0.001
    check(e.run_job() and ran[-1][0] == 'model' and 'Bulk' in ran[-1][1], 'a roster model: runs once PACE has passed')
    check(not e.export_hurry(), 'no page job queued: the loop waits as before')
    clock.now += 0.1
    check(not e.run_job(), 'the next roster model waits PACE again')
    # --- a battle holds everything, the click included ---------------------------------------------------------------------------
    rec.in_battle = True
    e.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:InBattle', 'compactDescriptor': 'y'})
    before = len(ran)
    clock.now += 5.0
    check(not e.run_job() and len(ran) == before and not e.export_hurry(), 'in a battle: not even the page\'s vehicle, and no hurry')
    rec.in_battle = False
    check(e.run_job() and ran[-1][1] == 'germany:InBattle', 'after the battle: the page\'s vehicle first')
    while e.jobs:
        clock.now += ex.PACE + 0.001
        e.run_job()
    # --- a sweep yields to a click --------------------------------------------------------------------------------------------------
    rec.page_open_until = clock.now + 100.0
    steps = []

    def step(type_name, sweep):
        steps.append(type_name)
        clock.now += 0.005
        if len(steps) == 3: commands.put(('vehicle', {}))   # the page's click arrives during the slice
        return 'built'
    e.ttx_step = step
    e.sweeps['ttx'] = e.new_sweep(['germany:T%02d' % n for n in range(40)], confirmed=True)
    e.sweeps['ttx']['reported'] = clock.now
    check(e.sweep_ready('ttx'), 'a confirmed sweep with nothing queued may slice')
    e.run_sweeps()
    check(len(steps) == 3, 'the slice ends after the step under way when a command of the page waits (not after its 60 ms)', len(steps))
    commands.get_nowait()
    e.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:DuringSweep', 'compactDescriptor': 'z'})
    check(not e.sweep_ready('ttx') and not e.sweep_hurry(), 'a queued job: no slice, and the loop is not hurried by the sweep')
    check(e.run_job() and ran[-1][1] == 'germany:DuringSweep', 'the click\'s job runs before the next slice')
    check(e.sweep_ready('ttx'), 'with the queue empty the sweep goes on')
    e.sweeps['ttx'] = None
    ex.time, ex.TTX_TIMER = saved.pop('time'), saved.pop('timer')

    # --- the game thread ---------------------------------------------------------------------------------------------------------
    mod = imp.load_source('mod_local_armor_inspector_click', os.path.join(REPO, 'mod', 'mod_local_armor_inspector.py'))
    sent = []
    fake = NS(last_vehicle=None, writer=NS(put_vehicle=lambda request: sent.append(request['source'])))
    descr = NS(type=NS(name='germany:G1_A', shortUserString='A'), makeCompactDescr=lambda: b'cd')
    request = mod.Recorder.request_vehicle.im_func
    request(fake, descr, 'hangar'); request(fake, descr, 'hangar')
    check(sent == ['hangar'], 'the hangar\'s repeated change event: one request', sent)
    request(fake, descr, 'picker'); request(fake, descr, 'picker')
    check(sent == ['hangar', 'picker', 'picker'], 'a click, and a second click of the same vehicle: both reach the export thread', sent)
    request(fake, descr, 'hangar')
    check(sent == ['hangar', 'picker', 'picker'], 'the hangar repeating the clicked configuration: dropped as before', sent)
    asked = []
    saved_recorder = mod._recorder
    mod._recorder = NS(prioritise=lambda types: asked.append(list(types)))
    mod.page_waits('germany:G1_A'); mod.page_waits(None)
    mod._recorder = saved_recorder
    check(asked == [['germany:G1_A']], 'a page opened on a vehicle: its queued export goes first (the page\'s prioritise)', asked)

    # --- the export loop: no wait while export_hurry says so --------------------------------------------------------------------
    class Loop(object):
        def __init__(self):
            self.hurries = [True, True, True, False, False]
            self.idles = []

        def setup(self):
            pass

        def export_hurry(self):
            return self.hurries.pop(0) if self.hurries else False

        def idle(self):
            self.idles.append(time.time())
    loop = Loop()
    writer = mod.Writer(os.path.join(temp, 'records'), loop)
    deadline = time.time() + 5.0
    while len(loop.idles) < 5 and time.time() < deadline: time.sleep(0.01)
    writer.close()
    gaps = [b - a for a, b in zip(loop.idles, loop.idles[1:])]
    check(len(gaps) >= 3 and gaps[0] < 0.025 and gaps[1] < 0.04 and gaps[2] >= 0.04,
          'Writer.run_export: back to back while hurried, its 50 ms wait for a message otherwise', ['%.3f' % g for g in gaps])
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    try:
        if saved: ex.time, ex.TTX_TIMER = saved.get('time', ex.time), saved.get('timer', ex.TTX_TIMER)
    except Exception: pass
    shutil.rmtree(temp, ignore_errors=True)
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
