# -*- coding: utf-8 -*-
"""The saved battles at startup (startup-republish-slow, 27.09), inside the client's own python27.dll. Temp folders only.

    python tests/py27/run27.py tests/py27/startup_republish.py

0.8.7's setup read and published every saved battle before anything else ran (145 battles: ~65 s of CPU offline, 8 min
22 s in the game), and the wheel migration, the TTX sources and every job waited behind it. Checks, by group:

  first      no data/published.json: setup reads no raw battle, lists every battle from the previous index, queues one
             'battle' job each after the jobs of the vehicle replay (a migration goes first), keeps the prune for the end
  backlog    the jobs publish each battle once; the game's share of the time after each (job_rest, a fake clock); the
             prune and data/published.json after the last; one line in the log for the startup, one for the backlog
  current    the next start takes every battle as it is: no raw read, no job, the index, the references (the prune at
             setup), the raw offsets
  changed    only a battle whose raw file grew, whose derived file changed, that waited for a model, or of another build
             is published again
  tail       a queued battle the tail made current and published meanwhile is passed over by its job

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, logging, os, shutil, sys, tempfile, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report = []
failures = []


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % detail if detail and not ok else ''))
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


def logged(text, level=logging.INFO):
    return [r.getMessage() for r in logs.records if r.levelno == level and text in r.getMessage()]


VERSION = 'client 1\n'
RESOURCE = 'vehicles/german/G1_Test/collision_client/Hull.model'


def header(battle_id, started):
    return {'schema': 1, 'type': 'battle', 'id': battle_id, 'startedAt': started, 'map': 'Map', 'clientVersion': VERSION}


def hit(number, resource=RESOURCE):
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming',
            'target': {'name': 'T', 'type': 'german:G1_Test',
                       'parts': [{'id': 1, 'name': 'hull', 'resource': resource, 'armor': {'1': 100}}]},
            'attacker': {'name': 'A', 'parts': []}, 'points': []}


def lines(*rows):
    return ''.join(json.dumps(row) + '\n' for row in rows)


def write(path, text, mode='wb'):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    with open(path, mode) as stream: stream.write(text)


temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    game = os.path.join(temp, 'game')
    folder = os.path.join(game, 'mods', 'configs', 'local.armor_inspector')
    archive = os.path.join(game, 'test.wotmod')
    os.makedirs(os.path.join(folder, 'battles'))
    z = zipfile.ZipFile(archive, 'w')
    for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
    z.close()
    names = ['10-a', '11-b', '12-c']
    for number, name in enumerate(names):
        write(os.path.join(folder, 'battles', name + '.jsonl'), lines(header(name, number + 1), hit(1), hit(2)))
    model = os.path.join(folder, 'data', 'models', ex.model_key(RESOURCE, VERSION) + '.js')
    orphan = os.path.join(folder, 'data', 'models', 'orphan.js')
    write(model, 'ArmorInspectorData.receive(["model:x",{}]);\n')
    write(orphan, 'ArmorInspectorData.receive(["model:y",{}]);\n')
    # The index of the previous run (0.8.7 had no published state): the page's list until the backlog is done.
    ex.write_data(os.path.join(folder, 'data', 'index.js'), 'index', {'battles': [
        {'id': name, 'startedAt': number + 1, 'map': 'Map', 'hits': 2} for number, name in enumerate(names)]})

    reads = []
    real_read = ex.read_battle

    def counted(path, *args, **kwargs):
        reads.append(os.path.basename(path))
        return real_read(path, *args, **kwargs)

    ex.read_battle = counted
    order = []

    def exporter():
        e = ex.Exporter(game, folder, VERSION, archive)
        replay = e.replay_vehicle_requests

        def replay_with_migration():
            # A migration of a wheeled vehicle's file, as replay_vehicle_requests queues it (JOB_BULK, replay).
            replay()
            e.queue_job(ex.JOB_BULK, 'vehicle', {'vehicleType': 'france:F108_Test', 'replay': True})
        e.replay_vehicle_requests = replay_with_migration
        e.run_vehicle_job = lambda request, page=False: order.append('vehicle')
        real_battle = e.run_battle_job

        def battle_job(payload):
            order.append('battle')
            return real_battle(payload)
        e.run_battle_job = battle_job
        return e

    def drain(e, limit=50):
        ran = 0
        while e.jobs and ran < limit:
            e.last_job = 0
            if e.run_job(): ran += 1
        return ran

    def index_ids():
        return sorted(row['id'] for row in ex.read_data_file(os.path.join(folder, 'data', 'index.js'))['battles'])

    # --- first: no published state ------------------------------------------------------------------------------
    first = exporter()
    first.setup()
    check(reads == [], 'first: setup reads no raw battle', reads)
    kinds = [job[2] for job in sorted(first.jobs)]
    check(kinds == ['vehicle', 'battle', 'battle', 'battle'], 'first: one battle job each, after the migration', kinds)
    check(index_ids() == names, 'first: the index lists every battle from the previous one', index_ids())
    check(os.path.exists(orphan), 'first: no prune before the references are known')
    check(len(logged('Startup in ')) == 1 and 'battles 0 current and 3 to publish in the background' in logged('Startup in ')[0],
          'first: one startup line with the battles', logged('Startup in '))
    check(first.backlog is not None and first.backlog['count'] == 3, 'first: a backlog of three')

    # --- backlog -----------------------------------------------------------------------------------------------------
    clock = [100.0]
    real_timer, real_republish = ex.TTX_TIMER, first.republish_saved
    ex.TTX_TIMER = lambda: clock[0]

    def slow_republish(battle_id):
        clock[0] += 0.4
        real_republish(battle_id)
    first.republish_saved = slow_republish
    first.last_job = 0
    first.run_job()   # the migration
    first.last_job = 0
    first.run_job()   # the first battle
    check(abs(first.job_rest - 0.4) < 1e-9, 'backlog: after a battle the game gets its share of the time (0.4 s)', first.job_rest)
    check(first.run_job() is False, 'backlog: the next job waits for that share')
    first.last_job = 0
    ran = drain(first)
    ex.TTX_TIMER = real_timer
    check(order == ['vehicle', 'battle', 'battle', 'battle'], 'backlog: the migration ran first, then each battle once', order)
    check(sorted(reads) == sorted(n + '.jsonl' for n in names), 'backlog: each raw battle read once', reads)
    check(all(os.path.exists(os.path.join(folder, 'data', 'battles', n + '.js')) for n in names), 'backlog: every battle published')
    check(first.backlog is None and len(logged('Saved battles published in the background: 3')) == 1,
          'backlog: one line when the last is done', logged('Saved battles'))
    check(os.path.exists(model) and not os.path.exists(orphan), 'backlog: the prune after the last (orphan gone, model kept)')
    published = json.loads(open(os.path.join(folder, 'data', ex.PUBLISHED_FILE), 'rb').read().decode('utf-8'))
    check(sorted(published['battles']) == names and published['keys'] == [ex.model_key(RESOURCE, VERSION)],
          'backlog: data/published.json with every battle and the model key once', published.get('keys'))

    # --- current: the next start takes them as they are -------------------------------------------------------------
    del reads[:]
    write(orphan, 'ArmorInspectorData.receive(["model:y",{}]);\n')
    second = exporter()
    second.setup()
    check(reads == [] and [j[2] for j in second.jobs] == ['vehicle'], 'current: no raw read, no battle job',
          '%s %s' % (reads, [j[2] for j in second.jobs]))
    check(second.backlog is None and index_ids() == names, 'current: every battle in the index')
    check(not os.path.exists(orphan) and os.path.exists(model), 'current: references known - the prune at setup')
    size = os.path.getsize(os.path.join(folder, 'battles', '11-b.jsonl'))
    check(second.raw_offsets.get('11-b') == size, 'current: the raw offset of each battle', second.raw_offsets.get('11-b'))
    check('battles 3 current and 0 to publish' in logged('Startup in ')[-1], 'current: the startup line says so', logged('Startup in ')[-1])

    # --- changed: only what changed ------------------------------------------------------------------------------------
    write(os.path.join(folder, 'battles', '10-a.jsonl'), lines(hit(3)), 'ab')              # the raw file grew
    write(os.path.join(folder, 'data', 'battles', '11-b.js'), 'ArmorInspectorData.receive(["battle:11-b",{}]);\n')  # derived changed
    third = exporter()
    third.setup()
    queued = sorted(j[3]['battleId'] for j in third.jobs if j[2] == 'battle')
    check(queued == ['10-a', '11-b'], 'changed: the grown raw file and the changed derived file only', queued)
    check(third.backlog['prune'] is True, 'changed: the references of the changed derived file are unknown - the prune waits for the backlog')
    del reads[:]
    drain(third)
    check(sorted(reads) == ['10-a.jsonl', '11-b.jsonl'], 'changed: those two read', reads)
    hits = ex.read_data_file(os.path.join(folder, 'data', 'battles', '10-a.js'))['hits']
    check(len(hits) == 3, 'changed: the grown battle published with its new hit', len(hits))

    # A battle that waited for a model (its model file gone): published again at the next start, which queues the model.
    os.remove(model)
    fourth = exporter()
    fourth.setup()
    drain(fourth, limit=0)
    fourth.jobs, fourth.job_index = [], {}
    for name in names:
        fourth.republish_saved(name)
    fourth.write_published()
    fifth = exporter()
    fifth.setup()
    queued = sorted(j[3]['battleId'] for j in fifth.jobs if j[2] == 'battle')
    check(queued == names, 'changed: a battle that waited for a model is published again', queued)
    check(any(j[2] == 'model' for j in fifth.jobs) is False and fifth.backlog is not None, 'changed: (the model is queued by its publish)')
    write(model, 'ArmorInspectorData.receive(["model:x",{}]);\n')
    drain(fifth)
    check(any(j[2] == 'battle' for j in fifth.jobs) is False, 'changed: the backlog done')

    # Another build: every battle again.
    real_stamp = ex.VERSION
    ex.VERSION = real_stamp + '-next'
    try:
        sixth = exporter()
        sixth.setup()
        queued = sorted(j[3]['battleId'] for j in sixth.jobs if j[2] == 'battle')
        check(queued == names, 'changed: another build publishes every battle again', queued)
        # --- tail: a queued battle made current and published meanwhile is passed over -----------------------------
        path = os.path.join(folder, 'battles', '12-c.jsonl')
        sixth.load_tail('12-c')
        sixth.flush(force=True)
        del reads[:]
        del order[:]
        drain(sixth)
        check('12-c.jsonl' not in reads and order.count('battle') == 3, 'tail: its job passes over the battle the tail published',
              '%s %s' % (reads, order))
    finally:
        ex.VERSION = real_stamp
    ex.read_battle = real_read
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
