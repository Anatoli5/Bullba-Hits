# -*- coding: utf-8 -*-
"""A sweep the user started does not stand behind background work (BACKLOG 55, 02.10), under the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/sweep_first.py

The user's case (game.log 02.10): Export all models -> Start, the bar stood at 0 for minutes - a sweep slice ran only with an
empty queue (sweep_ready: not self.jobs), and 222 background 'battle' jobs and 196 'ttx' checks were queued; the model sweep
also waits for the characteristics sweep to end (SWEEP_ORDER). The page did not say why. The decisions of 02.10: what the user
started goes before background work, and the progress file names what it waits for. Checks:

  first    a confirmed sweep's slice runs before queued JOB_BULK jobs; a job the page waits for still goes first
  both     the characteristics and the models, both started: the models get slices too, not only after the other ends
  waiting  while a confirmed sweep cannot run, its progress file says why: 'battle' in a battle, 'jobs' (and how many of each
           kind) behind work above the background's; nothing when it runs or waits behind background work only

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import os, shutil, sys, tempfile, traceback
try: import Queue as queue
except ImportError: import queue

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True
report, failures = [], []


def check(group, name, ok, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + '[%s] %s' % (group, name) + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)
    return ok


class NS(object):
    def __init__(self, **kw): self.__dict__.update(kw)


temp = tempfile.mkdtemp(prefix='bullba-sweepfirst27-')
try:
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    import logging
    logging.getLogger('local.armor_inspector').addHandler(logging.NullHandler())
    logging.getLogger('local.armor_inspector').propagate = False
    from local_armor_inspector import exporter as ex
    clock = [1000.0]
    real_timer = ex.TTX_TIMER
    ex.TTX_TIMER = lambda: clock[0]
    TYPES = ['germany:T%02d' % n for n in range(40)]

    made = []

    def exporter(kinds):
        game = os.path.join(temp, 'game')
        made.append(kinds)
        folder = os.path.join(temp, 'folder-%d' % len(made))
        e = ex.Exporter(game, folder, 'client 1\n')
        e.recorder = NS(in_battle=False, busy_until=0.0, page_open_until=1e12, frames_wanted=False,
                        writer=NS(export_queue=queue.Queue()), wait_frame=lambda timeout=0.1: None)
        steps = dict((kind, []) for kind in kinds)
        for kind in kinds:
            e.sweep_state(kind, {}, len(TYPES))
            e.sweeps[kind] = e.new_sweep(list(TYPES), confirmed=True)

        def stepper(kind):
            def step(type_name, sweep):
                clock[0] += 0.05
                steps[kind].append(type_name)
                return 'built'
            return step
        e.ttx_step, e.models_step = stepper('ttx'), stepper('models')
        ran = []
        e.run_battle_job = lambda payload: ran.append('battle') or False
        e.run_ttx_job = lambda payload: ran.append('ttx')
        e.run_vehicle_job = lambda request, page=False: ran.append('vehicle')
        e.run_model_job = lambda payload: ran.append('model')
        e.run_extras_job = lambda payload: ran.append('extras')
        return e, steps, ran

    def turn(e):
        e.last_job = 0
        clock[0] += 5.0
        return e.run_job()

    def marker(e, kind='models'):
        try: return ex.read_data_file(e.sweep_path(kind))
        except Exception: return {}

    # =================== first: the user's sweep before the background ===================
    group = 'first'
    e, steps, ran = exporter(['models'])
    for n in range(3): e.queue_job(ex.JOB_BULK, 'battle', {'battleId': '1-%d' % n})
    e.queue_job(ex.JOB_BULK, 'ttx', {'vehicleType': 'germany:X'})
    turn(e)
    check(group, 'a slice of the started model sweep runs before the queued background jobs (02.10: the bar at 0)',
          steps['models'] and not ran, (len(steps['models']), ran))
    turn(e)
    check(group, '... and the next turn too, while the sweep has work', len(steps['models']) >= 2 and not ran, (len(steps['models']), ran))
    e.queue_job(ex.JOB_PAGE, 'vehicle', {'vehicleType': 'germany:Clicked', 'source': 'picker'})
    done, was = len(steps['models']), len(ran)
    turn(e)
    check(group, 'a job the page waits for still goes first', ran[was:] == ['vehicle'] and len(steps['models']) == done,
          (ran[was:], len(steps['models']) - done))
    for _ in range(200):
        if e.sweeps['models'] is None and not e.jobs: break
        turn(e)
    check(group, 'the background runs once the sweep is through (nothing lost)', e.sweeps['models'] is None
          and sorted(ran) == ['battle', 'battle', 'battle', 'ttx', 'vehicle'], ran)

    # =================== both: characteristics and models started together ===================
    group = 'both'
    e, steps, ran = exporter(['ttx', 'models'])
    for _ in range(4): turn(e)
    check(group, 'both started: the models get slices before the characteristics are through',
          steps['ttx'] and steps['models'] and e.sweeps['ttx'] is not None, (len(steps['ttx']), len(steps['models'])))

    # =================== waiting: the progress file says why it waits ===================
    group = 'waiting'
    e, steps, ran = exporter(['models'])
    e.recorder.in_battle = True
    turn(e)
    m = marker(e)
    check(group, "in a battle: the progress file says it waits for the battle", (m.get('waiting') or {}).get('for') == 'battle',
          m.get('waiting'))
    e.recorder.in_battle = False
    e.recorder.busy_until = 1e12   # a drag holds the work, not the page's own jobs: queue two above the background's
    e.queue_job(ex.JOB_PLAYER, 'model', ('vehicles/germany/X/collision_client/Hull.model', 'client 1\n'))
    e.queue_job(ex.JOB_OTHER, 'extras', {'vehicleType': 'germany:X'})
    e.sweeps['models']['reported'] = 0.0
    turn(e)
    m = marker(e)
    w = m.get('waiting') or {}
    check(group, "behind work above the background's: 'jobs', with how many of each kind",
          w.get('for') == 'jobs' and (w.get('jobs') or {}).get('model') == 1 and (w.get('jobs') or {}).get('extras') == 1, w)
    e.recorder.busy_until = 0.0
    for _ in range(3): turn(e)
    e.jobs, e.job_index = [], {}
    e.queue_job(ex.JOB_BULK, 'battle', {'battleId': '9-z'})
    e.sweeps['models']['reported'] = 0.0
    turn(e)
    e.write_sweep('models')
    check(group, 'running (only background work queued): no waiting in the file', not marker(e).get('waiting'), marker(e).get('waiting'))
    ex.TTX_TIMER = real_timer
except Exception:
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    shutil.rmtree(temp, ignore_errors=True)
report.append('sweep_first: %d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
