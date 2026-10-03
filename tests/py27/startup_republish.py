# -*- coding: utf-8 -*-
"""The saved battles at startup (startup-republish-slow and its review, 27.09), inside the client's own python27.dll.
Temp folders only.

    python tests/py27/run27.py tests/py27/startup_republish.py

0.8.7's setup read and published every saved battle before anything else ran (145 battles: ~65 s of CPU offline, 8 min
22 s in the game), and the wheel migration, the TTX sources and every job waited behind it. Checks, by group:

  first      no data/published.json: setup reads no raw battle, lists every battle from the previous index, each stale;
             'battle' job each after the jobs of the vehicle replay (a migration goes first), keeps the prune for the end
  slices     a battle is published in slices: lines, then hits, then the file; the job goes back in its place; the game's
             share of the time after each slice, with no cap; a page job goes first between two slices and the battle
             goes on where it stopped; a battle, a drag and a command of the page end a slice; a battle drops what was read
  backlog    each battle once; the prune and data/published.json after the last; one line for the startup, one for the
             backlog with the MB and slices, one for a battle that is big
  current    the next start takes every battle as it is: no raw read, no job, the index, the references (the prune at
             setup), the raw offsets
  rev        every publish gives its battle a new revision in the index; the next start keeps a current battle's
  changed    only a battle whose raw file grew, whose derived file changed, whose model file is gone, that waited for a
             model, or of another DERIVED_FORMAT is published again - not of another build; a model failure the next start
             may undo, a wheel or a prefab without the XML: published again; a failure for good: not
  truncated  an unfinished last raw line does not publish the battle again at every start
  tail       a queued battle the tail made current and published meanwhile is passed over by its job
  outdated   a click never puts another configuration in place of a file's own request: a queued migration keeps its
             payload, 'prioritise' exports an out-of-date file with no job from its own request, a picker request too

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, logging, os, shutil, sys, tempfile, zipfile
try: import Queue as queue
except ImportError: import queue
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report = []
failures = []


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
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


class NS(object):
    def __init__(self, **kw):
        self.__dict__.update(kw)


VERSION = 'client 1\n'
RESOURCE = 'vehicles/german/G1_Test/collision_client/Hull.model'


def header(battle_id, started, version=VERSION):
    return {'schema': 1, 'type': 'battle', 'id': battle_id, 'startedAt': started, 'map': 'Map', 'clientVersion': version}


def hit(number, resource=RESOURCE, extra=()):
    parts = [{'id': 1, 'name': 'hull', 'resource': resource, 'armor': {'1': 100}}] + list(extra)
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming',
            'target': {'name': 'T', 'type': 'german:G1_Test', 'parts': parts},
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

    # Every raw read of a battle goes through BattleReader (read_battle, the tail, republish_saved, the background).
    reads = []
    real_init = ex.BattleReader.__init__

    def counted(self, path, decoder=None):
        reads.append(os.path.basename(path))
        real_init(self, path, decoder)
    ex.BattleReader.__init__ = counted
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

    def drain(e, limit=200):
        ran = 0
        while e.jobs and ran < limit:
            e.last_job = 0
            if e.run_job(): ran += 1
        return ran

    def index_rows():
        return dict((row['id'], row) for row in ex.read_data_file(os.path.join(folder, 'data', 'index.js'))['battles'])

    def published_file():
        return json.loads(open(os.path.join(folder, 'data', ex.PUBLISHED_FILE), 'rb').read().decode('utf-8'))

    # --- first: no published state ------------------------------------------------------------------------------
    first = exporter()
    first.setup()
    check(reads == [], 'first: setup reads no raw battle', reads)
    kinds = [job[2] for job in sorted(first.jobs)]
    # BACKLOG 55 (02.10): no battle is published at the start or in the background - each when the page opens it.
    check(kinds == ['vehicle'], 'first: no battle job - only the migration', kinds)
    check(sorted(index_rows()) == names and all(index_rows()[n].get('stale') is True for n in names),
          'first: the index lists every battle from the previous one, each stale', index_rows())
    check(os.path.exists(orphan), 'first: no prune before the references are known')
    check(len(logged('Startup in ')) == 1 and 'battles 0 current and 3 stale (prepared when opened)' in logged('Startup in ')[0],
          'first: one startup line with the battles', logged('Startup in '))
    check(first.backlog is None and first.prune_waits is True, 'first: no background backlog; the prune waits for the references')
    for name in names: first.request_battle(name)
    check([(j[0], j[3]['battleId']) for j in sorted(first.jobs) if j[2] == 'battle'] == [(ex.JOB_PAGE, n) for n in names],
          'first: the page opening each battle queues it at the page\'s turn', [(j[0], j[2], j[3]) for j in sorted(first.jobs)])

    # --- slices: a fake clock; a hit costs 0.2 s (BATTLE_SLICE 0.1) ------------------------------------------------------
    clock = [100.0]
    real_timer = ex.TTX_TIMER
    ex.TTX_TIMER = lambda: clock[0]
    cost = {'hit': 0.2}
    real_prepare = first.prepare_hit

    def slow_prepare(raw, index, battle, track=False):
        clock[0] += cost['hit']
        return real_prepare(raw, index, battle, track)
    first.prepare_hit = slow_prepare
    first.last_job = 0
    first.run_job()   # the first slice of the first battle the page asked for: its lines, its first hit
    check(order == ['battle'], 'slices: the page\'s battles before the background\'s migration', order)
    work = first.battle_work
    check(work is not None and work['name'] == '10-a' and work['reader'].done and len(work['prepared']) == 1,
          'slices: the first slice reads the lines and prepares one hit, then stops (0.2 s > BATTLE_SLICE)',
          work and (work['name'], work['reader'].done, len(work['prepared'])))
    check([j[2] for j in sorted(first.jobs)][0] == 'battle' and sorted(first.jobs)[0][3]['battleId'] == '10-a'
          and not os.path.exists(os.path.join(folder, 'data', 'battles', '10-a.js')),
          'slices: the job is back in its own place, nothing written yet', [(j[2], j[3]) for j in sorted(first.jobs)])
    cost['hit'] = 5.0
    check(first.run_job() is True and len(first.battle_work['prepared']) == 2,
          'slices: the page waits for it - the next slice at once, no rest between them', first.battle_work and len(first.battle_work['prepared']))
    first.run_job()   # the file
    check(os.path.exists(os.path.join(folder, 'data', 'battles', '10-a.js')) and first.battle_work is None
          and reads.count('10-a.jsonl') == 1, 'slices: the file in the third slice, the raw file read once', reads)
    check(order == ['battle'] * 3, 'slices: three slices of the first battle', order)
    cost['hit'] = 0.0
    # The gates, with a recorder: a command of the page waiting ends a slice after its first line.
    commands = queue.Queue()
    recorder = NS(in_battle=False, busy_until=0.0, page_open_until=0.0, frames_wanted=False, writer=NS(export_queue=commands),
                  wait_frame=lambda timeout=0.1: None)
    first.recorder = recorder
    commands.put(('prioritise', ['x']))
    first.last_job = 0
    first.run_job()
    work = first.battle_work
    check(work is not None and work['name'] == '11-b' and work['reader'].number == 1 and not work['reader'].done,
          'slices: a command of the page waiting ends the slice after one line', work and work['reader'].number)
    commands.get_nowait()
    # A battle: no slice runs, and what was read is let go at the next tick; after it the battle starts again.
    recorder.in_battle = True
    first.last_job = 0
    check(first.run_job() is False, 'slices: in a battle no slice runs')
    first.idle()
    check(first.battle_work is None, 'slices: a battle drops the battle read halfway')
    recorder.in_battle = False
    # A drag does not hold the battle the page asked for (BACKLOG 55: the user drags the scene of its old file meanwhile).
    recorder.busy_until = 1e12
    first.last_job = 0
    cost['hit'] = 0.2
    check(first.run_job() is True and first.battle_work is not None and first.battle_work['name'] == '11-b'
          and reads.count('11-b.jsonl') == 2, 'slices: a drag does not hold the page\'s battle; the one dropped for the battle is read again',
          reads)
    cost['hit'] = 0.0
    recorder.busy_until = 0.0
    first.recorder = None
    first.last_job = 0
    # A model arrived for it meanwhile (drain_republish publishes it at once): the slices are dropped, its job passes over.
    first.republish_saved('11-b')
    check(first.battle_work is None, 'slices: a publish of that battle at once drops its slices')
    ran = drain(first)
    ex.TTX_TIMER = real_timer
    check(reads.count('11-b.jsonl') == 3, 'slices: ... and its job passes over it - not read a fourth time', reads)

    # --- opened: the battles the page asked for ----------------------------------------------------------------------
    check(all(os.path.exists(os.path.join(folder, 'data', 'battles', n + '.js')) for n in names)
          and not any(index_rows()[n].get('stale') for n in names), 'opened: every battle published, none stale any more')
    check(len(logged('Saved battle 10-a prepared for the page: ')) == 1 and ' MB raw, ' in logged('prepared for the page')[0]
          and ' slices)' in logged('prepared for the page')[0] and not logged('Saved battles published in the background'),
          'opened: one line a battle the page waited for, with the MB and the slices; no background summary', logged('Saved battle'))
    check(os.path.exists(model) and not os.path.exists(orphan), 'opened: the prune once the last references are known (orphan gone, model kept)')
    first.write_published()
    published = published_file()
    check(sorted(published['battles']) == names and published['keys'] == [ex.model_key(RESOURCE, VERSION)],
          'backlog: data/published.json with every battle and the model key once', published.get('keys'))
    entry = published['battles']['11-b']
    check(entry['stamp'] == 'd%d' % ex.DERIVED_FORMAT and entry['rawSize'] == entry['raw']
          == os.path.getsize(os.path.join(folder, 'battles', '11-b.jsonl'))
          and entry['client'] == entry['built'] == ex.version_hash(VERSION),
          'opened: the stamp is the derived format\'s alone (no client), the raw bytes and size, the clients named', entry)

    # --- rev: every publish that changes the file a new revision in the index --------------------------------------------
    rows = index_rows()
    revs = [rows[n].get('rev') for n in names]
    check(all(revs) and len(set(revs)) == 3, 'rev: each battle has its own revision in the index', revs)
    stamp = os.path.getmtime(os.path.join(folder, 'data', 'battles', '10-a.js'))
    os.utime(os.path.join(folder, 'data', 'battles', '10-a.js'), (stamp - 100, stamp - 100))
    first.republish_saved('10-a')
    write(os.path.join(folder, 'battles', '12-c.jsonl'), lines(hit(3)), 'ab')
    first.republish_saved('12-c')
    first.write_index()
    again = index_rows()
    check(again['12-c']['rev'] != rows['12-c']['rev'] and again['10-a']['rev'] == rows['10-a']['rev'],
          'rev: a publish that changes the file changes that battle\'s revision only', (rows['12-c']['rev'], again['12-c']['rev']))
    check(abs(os.path.getmtime(os.path.join(folder, 'data', 'battles', '10-a.js')) - (stamp - 100)) < 1,
          'rev: a publish of the same bytes writes nothing (BACKLOG 55: 138 of 145 were the same on 02.10)')
    first.write_published()

    # --- current: the next start takes them as they are -------------------------------------------------------------
    del reads[:]
    write(orphan, 'ArmorInspectorData.receive(["model:y",{}]);\n')
    second = exporter()
    second.setup()
    check(reads == [] and [j[2] for j in second.jobs] == ['vehicle'], 'current: no raw read, no battle job',
          '%s %s' % (reads, [j[2] for j in second.jobs]))
    check(second.backlog is None and sorted(index_rows()) == names, 'current: every battle in the index')
    check(index_rows()['12-c'].get('rev') == again['12-c']['rev'], 'rev: the next start keeps a current battle\'s revision')
    check(not os.path.exists(orphan) and os.path.exists(model), 'current: references known - the prune at setup')
    size = os.path.getsize(os.path.join(folder, 'battles', '11-b.jsonl'))
    check(second.raw_offsets.get('11-b') == size, 'current: the raw offset of each battle', second.raw_offsets.get('11-b'))
    check('battles 3 current and 0 stale' in logged('Startup in ')[-1], 'current: the startup line says so', logged('Startup in ')[-1])

    def open_stale(e):
        """The page opens every stale battle (request_battle), the export thread runs what that queued; the published state
        written as the idle tick or the game's close writes it."""
        for name in sorted(e.stale): e.request_battle(name)
        drain(e)
        e.write_published()

    # --- changed: only what changed ------------------------------------------------------------------------------------
    write(os.path.join(folder, 'battles', '10-a.jsonl'), lines(hit(3)), 'ab')              # the raw file grew
    write(os.path.join(folder, 'data', 'battles', '11-b.js'), 'ArmorInspectorData.receive(["battle:11-b",{}]);\n')  # derived changed
    third = exporter()
    third.setup()
    queued = sorted(third.stale)
    check(queued == ['10-a', '11-b'] and not [j for j in third.jobs if j[2] == 'battle'],
          'changed: the grown raw file and the changed derived file only are stale (none queued)', queued)
    check(third.prune_waits is True, 'changed: the references of the changed derived file are unknown - the prune waits for them')
    del reads[:]
    open_stale(third)
    check(sorted(reads) == ['10-a.jsonl', '11-b.jsonl'], 'changed: those two read', reads)
    hits = ex.read_data_file(os.path.join(folder, 'data', 'battles', '10-a.js'))['hits']
    check(len(hits) == 3, 'changed: the grown battle published with its new hit', len(hits))

    # A model file deleted since: every battle naming it is published again (one listing of data/models at setup), and its
    # publish queues the model (review of 4b1c8c8 #9: this check used to hold whatever happened).
    os.remove(model)
    fourth = exporter()
    fourth.setup()
    queued = sorted(fourth.stale)
    check(queued == names, 'changed: a battle whose model file was deleted is stale', queued)
    check(not any(j[2] == 'model' for j in fourth.jobs), 'changed: (no model queued before its battle is published)')
    while fourth.run_battle_job({'battleId': '10-a'}): pass
    models = [j for j in fourth.jobs if j[2] == 'model']
    check(len(models) == 1 and models[0][3][0] == RESOURCE and fourth.published['10-a']['waits'] is True,
          'changed: its publish queues the model and the battle waits for it', [(j[2], j[3]) for j in fourth.jobs])
    fourth.jobs, fourth.job_index, fourth.backlog, fourth.waiting = [], {}, None, {}
    write(model, 'ArmorInspectorData.receive(["model:x",{}]);\n')
    for name in names: fourth.republish_saved(name)
    key = ex.model_key(RESOURCE, VERSION)
    # A model failure the next start may undo (a mod overriding it, a package scan): published again then.
    fourth.attempts[key] = 'A mod overrides this collision model'
    fourth.republish_saved('10-a')
    check(fourth.published['10-a']['waits'] is True, 'changed: a model failure that is not for good - published again next start')
    # One for good (this client has no such model): not published again, and its model is not looked for on disk.
    fourth.attempts[key] = 'Collision model not found in client'
    fourth.republish_saved('10-a')
    entry = fourth.published['10-a']
    check(entry['waits'] is False and entry.get('absent') == [key], 'changed: a model failure for good - not published again', entry)
    # A wheel without its body and a prefab without its model because the vehicle XML did not read: published again.
    write(os.path.join(folder, 'battles', '13-d.jsonl'), lines(header('13-d', 4), hit(1, extra=[
        {'id': -1, 'name': 'wheel0'}, {'id': 5, 'name': 'slot', 'prefab': 'content/CGFPrefabs/Vehicle/x.prefab', 'parentPart': 1}])))
    fourth.extras_cache['german:G1_Test'] = {'error': 'not read'}
    fourth.republish_saved('13-d')
    derived = ex.read_data_file(os.path.join(folder, 'data', 'battles', '13-d.js'))['hits'][0]['target']['parts']
    check(fourth.published['13-d']['waits'] is True and any(str(p.get('prefabError', '')).startswith('vehicle XML unavailable') for p in derived),
          'changed: a prefab and a wheel without the vehicle XML - published again next start', derived)
    fourth.extras_cache['german:G1_Test'] = {'wheels': {}, 'prefabs': [], 'prefabErrors': []}
    write(os.path.join(folder, 'battles', '13-d.jsonl'), lines(header('13-d', 4), hit(1, extra=[{'id': -1, 'name': 'wheel0'}])))
    fourth.republish_saved('13-d')
    check(fourth.published['13-d']['waits'] is False, 'changed: a wheel without its body with the XML read - not published again')
    fourth.attempts.pop(key, None)
    for name in names: fourth.republish_saved(name)
    fourth.write_published()

    # --- truncated: an unfinished last raw line ----------------------------------------------------------------------------
    write(os.path.join(folder, 'battles', '11-b.jsonl'), '{"schema": 1, "type": "hit", "id": "9"', 'ab')
    fifth = exporter()
    fifth.setup()
    check(sorted(fifth.stale) == ['11-b'], 'truncated: the grown file is stale', sorted(fifth.stale))
    open_stale(fifth)
    sixth = exporter()
    sixth.setup()
    check(not sixth.stale, 'truncated: once prepared, the next start takes it as it is (its raw size kept)', sorted(sixth.stale))

    # Another build: nothing again (DERIVED_FORMAT says when the files differ); another derived format: every battle again.
    real_version, real_format = ex.VERSION, ex.DERIVED_FORMAT
    ex.VERSION = real_version + '-next'
    try:
        seventh = exporter()
        seventh.setup()
        check(not seventh.stale, 'changed: another build with the same derived format: nothing stale')
    finally:
        ex.VERSION = real_version
    ex.DERIVED_FORMAT = real_format + 1
    try:
        eighth = exporter()
        eighth.setup()
        queued = sorted(eighth.stale)
        check(queued == sorted(names + ['13-d']) and not [j for j in eighth.jobs if j[2] == 'battle'],
              'changed: another derived format - every battle stale, none queued', queued)
        # --- tail: a stale battle made current and published by the tail is current ---------------------------------
        eighth.load_tail('12-c')
        eighth.flush(force=True)
        check('12-c' not in eighth.stale and not index_rows()['12-c'].get('stale'), 'tail: the battle the tail published is not stale')
        del reads[:]
        del order[:]
        open_stale(eighth)
        check('12-c.jsonl' not in reads and order.count('battle') == 3, 'tail: opening the others prepares them alone',
              '%s %s' % (reads, order))
    finally:
        ex.DERIVED_FORMAT = real_format

    # --- outdated: a click never changes a file's configuration --------------------------------------------------------------
    e = ex.Exporter(game, folder, VERSION, archive)
    identifier = ex.vehicle_id('germany:Wheeled')
    record = {'id': identifier, 'type': 'germany:Wheeled', 'name': 'Wheeled', 'source': 'battle', 'clientVersion': VERSION,
              'compactDescriptor': 'OWN', 'exportedAt': 5, 'parts': [{'id': 1, 'resource': RESOURCE}]}
    ex.write_data(os.path.join(folder, 'data', 'vehicles', identifier + '.js'), 'vehicle:' + identifier, record)
    e.remember_vehicle(record)
    e.vehicles[identifier]['descriptorHash'] = None   # load_vehicles found it out of date
    e.queue_job(ex.JOB_BULK, 'vehicle', {'vehicleType': 'germany:Wheeled', 'compactDescriptor': 'OWN', 'source': 'battle', 'replay': True})
    e.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:Wheeled', 'compactDescriptor': 'TOP', 'requestedAt': 7.0})
    job = e.job_index[('vehicle', 'germany:Wheeled')]
    check(job[0] == ex.JOB_PAGE and job[3]['compactDescriptor'] == 'OWN' and job[3]['replay'] is True and job[3]['askedAt'] == 7.0,
          'outdated: a click over its queued migration lifts it and keeps its own request', job)
    e.take_job(e.jobs.index(job))
    check(e.prioritise(['germany:Wheeled']) == 1, 'outdated: the page\'s prioritise with no job queued queues one')
    job = e.job_index.get(('vehicle', 'germany:Wheeled'))
    check(job is not None and job[0] == ex.JOB_PAGE and job[3]['compactDescriptor'] == 'OWN' and job[3]['replay'] is True
          and job[3]['source'] == 'battle', 'outdated: ... from the file\'s own request, at the page\'s turn', job)
    e.take_job(e.jobs.index(job))
    check(e.prioritise(['germany:Wheeled']) == 0, 'outdated: once a session (a failed re-export is not tried on every hit)')
    f = ex.Exporter(game, folder, VERSION, archive)
    f.remember_vehicle(record)
    f.vehicles[identifier]['descriptorHash'] = None
    f.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:Wheeled', 'compactDescriptor': 'TOP', 'requestedAt': 8.0})
    job = f.job_index.get(('vehicle', 'germany:Wheeled'))
    check(job is not None and job[3]['compactDescriptor'] == 'OWN' and job[3]['replay'] is True,
          'outdated: a picker request of an earlier page is turned into the file\'s own request', job)
    g = ex.Exporter(game, folder, VERSION, archive)
    g.remember_vehicle(record)   # current: its hash known
    g.request_vehicle_export({'source': 'picker', 'vehicleType': 'germany:Wheeled', 'compactDescriptor': 'TOP', 'requestedAt': 8.0})
    check(g.job_index[('vehicle', 'germany:Wheeled')][3]['compactDescriptor'] == 'TOP', 'outdated: (a current file: the request as sent)')
    ex.BattleReader.__init__ = real_init
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
