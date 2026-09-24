# -*- coding: utf-8 -*-
"""Python 2.7 half of tests/test_exporter_safety.py (batch 1 "data safety" of the 24.09 audit): the prune from a
complete reference set (EXP-02), a battle file without its header (EXP-01/REC-02) and the one recording gate
(REC-01), inside the client's own python27.dll. Temp folders only.

    python tests/py27/run27.py tests/py27/exporter_safety.py
Verdict through BULLBA_PY27_RESULT (see run27.py)."""
import hashlib, json, logging, os, shutil, sys, tempfile, types, zipfile
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
logger.propagate = False


def warned(text):
    return len([r for r in logs.records if r.levelno == logging.WARNING and text in r.getMessage()])


def lines(*rows):
    return ''.join(json.dumps(row) + '\n' for row in rows)


def header(battle_id, version='version\n'):
    return {'schema': 1, 'type': 'battle', 'id': battle_id, 'startedAt': 1, 'map': 'Map', 'clientVersion': version}


RESOURCE = 'vehicles/german/G1_Test/collision_client/Hull.model'


def hit(number):
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming',
            'target': {'name': 'T', 'type': 'german:G1_Test',
                       'parts': [{'id': 1, 'name': 'hull', 'resource': RESOURCE, 'armor': {'1': 100}}]},
            'attacker': {'name': 'A', 'parts': []}, 'points': []}


def write(path, text):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    with open(path, 'wb') as stream: stream.write(text)


temp = tempfile.mkdtemp()
os.chdir(temp)
try:
    from local_armor_inspector import exporter as ex
    # --- EXP-02: prune only from a complete reference set -------------------------------------------------------
    game = os.path.join(temp, 'game')
    folder = os.path.join(game, 'mods', 'configs', 'local.armor_inspector')
    archive = os.path.join(game, 'test.wotmod')
    os.makedirs(os.path.join(folder, 'battles'))
    z = zipfile.ZipFile(archive, 'w')
    for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
    z.close()
    write(os.path.join(folder, 'battles', '10-old.jsonl'), lines(header('10-old', 'old client\n'), hit(1)))
    model = os.path.join(folder, 'data', 'models', ex.model_key(RESOURCE, 'old client\n') + '.js')
    orphan = os.path.join(folder, 'data', 'models', 'orphan.js')
    write(model, 'ArmorInspectorData.receive(["model:x",{}]);\n')
    write(orphan, 'ArmorInspectorData.receive(["model:y",{}]);\n')
    real = ex.read_battle

    def locked(path, *args, **kwargs):
        if path.endswith('10-old.jsonl'): raise IOError('file is locked by another process')
        return real(path, *args, **kwargs)

    ex.read_battle = locked
    try:
        ex.Exporter(game, folder, 'new client\n', archive).setup()
    finally:
        ex.read_battle = real
    check(os.path.exists(model) and os.path.exists(orphan), 'locked battle at setup: no model deleted')
    check(warned('Unused models kept') == 1, 'one warning for the kept models')
    ex.Exporter(game, folder, 'new client\n', archive).setup()
    check(os.path.exists(model) and not os.path.exists(orphan), 'next complete start: orphan pruned, old model kept')
    # F5: only a copy with a file-manager name is left.
    write(orphan, 'ArmorInspectorData.receive(["model:y",{}]);\n')
    os.rename(os.path.join(folder, 'battles', '10-old.jsonl'), os.path.join(folder, 'battles', '10-old - Copy.jsonl'))
    ex.Exporter(game, folder, 'new client\n', archive).setup()
    check(os.path.exists(model) and os.path.exists(orphan) and warned('unexpected name') == 1,
          'battle file with an unexpected name: prune off, one warning')

    # --- EXP-01 / REC-02: a headless file never stalls the tail ----------------------------------------------
    root = os.path.join(temp, 'tail')
    os.makedirs(os.path.join(root, 'battles'))
    os.makedirs(os.path.join(root, 'data', 'battles'))
    tail = ex.Exporter(root, root, 'version\n', os.path.join(root, 'unused.wotmod'))

    def append(name, text):
        path = os.path.join(root, 'battles', name + '.jsonl')
        with open(path, 'ab') as stream: stream.write(text)
        tail.record_written(name, 0, os.path.getsize(path))

    append('10-headless', lines({'schema': 1, 'type': 'roster', 'vehicles': [], 'playerVehicleId': 1}))
    append('11-ok', lines(header('11-ok'), hit(1)))
    errors = 0
    for _ in range(20):
        try: tail.idle()
        except Exception: errors += 1
    for number in range(3):
        append('10-headless', lines(hit(number)))
        try: tail.idle()
        except Exception: errors += 1
    check(errors == 0, 'no exception on any tick')
    check(os.path.exists(os.path.join(root, 'data', 'battles', '11-ok.js')), 'healthy battle published')
    check(not tail.has_pending_records(), 'nothing left pending')
    check(warned('(no header line)') == 1, 'one warning for the headless file')
    # F3: a battle with its header whose publication fails the same way every time is let go.
    real_publish = ex.Exporter.publish

    def failing(exporter, battle):
        if battle['id'] == '13-bad': raise TypeError('a part is not a dict')
        return real_publish(exporter, battle)

    ex.Exporter.publish = failing
    try:
        append('13-bad', lines(header('13-bad'), hit(1)))
        append('14-ok', lines(header('14-ok'), hit(1)))
        errors = 0
        for _ in range(20):
            tail.next_publish_retry = tail.last_job = 0
            try: tail.idle()
            except Exception: errors += 1
        tail.finish()   # the one-second publish cadence has not passed yet; the end of the session flushes
    finally:
        ex.Exporter.publish = real_publish
    check(errors == ex.PUBLISH_GIVE_UP - 1 and '13-bad' in tail.skipped and warned('publication failed') == 1,
          'publication failing every time: let go after %d tries, one warning' % ex.PUBLISH_GIVE_UP)
    check(os.path.exists(os.path.join(root, 'data', 'battles', '14-ok.js')), 'the next battle published after it')
    raw = lines(hit(1))
    write(os.path.join(root, 'battles', '12-lost.jsonl'), raw)
    write(os.path.join(root, 'battles', '12-lost.jsonl.recovery.json'),
          json.dumps({'rawSha256': hashlib.sha256(raw).hexdigest(), 'header': header('12-lost')}))
    tail.record_written('12-lost', 0, len(raw))
    tail.finish()
    snapshot = ex.read_data_file(os.path.join(root, 'data', 'battles', '12-lost.js'))
    check(len(snapshot['hits']) == 1, 'recovery file restores the header in the tail')

    # --- REC-01: the one recording gate ------------------------------------------------------------------------
    state = {'playing': False, 'observer': False}
    arena = types.ModuleType('arena')
    arena.arenaUniqueID = 987
    arena.arenaType = None
    arena.vehicles = {1: {'name': 'me', 'team': 1, 'vehicleType': None}}
    player = types.ModuleType('player')
    player.playerVehicleID = 1
    player.arena = arena
    player.isObserver = lambda: state['observer']
    ctrl = types.ModuleType('ctrl')
    ctrl.isPlaying = False
    replay = types.ModuleType('BattleReplay')
    replay.g_replayCtrl = ctrl
    bigworld = types.ModuleType('BigWorld')
    bigworld.player = lambda: player
    bigworld.serverTime = lambda: 1.0
    sys.modules['BattleReplay'] = replay
    sys.modules['BigWorld'] = bigworld
    import mod_local_armor_inspector as recorder_module
    from local_armor_inspector.crit_log import CritLog
    from local_armor_inspector.telemetry import ShotTelemetry, recording
    battles = os.path.join(temp, 'rec', 'battles')
    recorder = recorder_module.Recorder(battles)
    crit, telemetry = CritLog(recorder), ShotTelemetry(recorder)
    check(recording(recorder, player) and crit.active(player) and telemetry.active(player), 'live battle passes the gate')
    ctrl.isPlaying = True
    recorder.note_roster(arena, player)
    check(recorder.battle is None, 'replay: roster opens no battle')
    check(not (crit.active(player) or telemetry.active(player)), 'replay: crit log and telemetry closed')
    ctrl.isPlaying = False
    state['observer'] = True
    recorder.note_roster(arena, player)
    check(recorder.battle is None, 'observer: roster opens no battle')
    state['observer'] = False
    recorder.note_roster(arena, player)
    recorder.writer.close()
    files = sorted(os.listdir(battles)) if os.path.isdir(battles) else []
    check(recorder.battle == '987' and len(files) == 1, 'live roster opens exactly one battle file')
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    os.chdir(os.path.dirname(temp))
    shutil.rmtree(temp, ignore_errors=True)
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
