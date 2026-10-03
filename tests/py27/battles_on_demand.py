# -*- coding: utf-8 -*-
"""Saved battles after a client update (BACKLOG 55, 02.10), under the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/battles_on_demand.py

The user's case (game.log 02.10): client 2.4.0.1 -> 2.4.0.2, nothing of the battles' inputs changed, and the start queued all
222 saved battles for the background (296 s, 633 MB read); the republish under the new client lost what only the battle's
own client may fill - 7 battles their outer track pair, 15 the bodies of their wheels, 1 its armoured prefab
(outputs/rebuild-research-battles-2026-10-02.md). The user's decisions of 02.10: a battle is prepared only when the page
opens it (the old file meanwhile), the fill-ins pass by the CRC of the inputs they read (not by the client's version text),
the battles damaged on 02.10 are repaired. A made-up client in a temp folder: real packages (scripts.pkg with a wheeled
vehicle's and a crested vehicle's XML, a vehicles package with the .havok files and the prefab JSON), descriptors stubbed.

  update   a client update with the same raw, format and models: no battle job at the start, no raw read, the derived files
           and the index rows as they were (not stale)
  open     a format raised after the update: still no battle job at the start, the rows say 'stale', the old files stay;
           the page's command prepares that battle alone, at JOB_PAGE, through a drag, complete (its wheels); the page ->
           mod wiring (presentation 'prepareBattle' + battleId, the export thread's 'battle' message)
  gate     the format raised after the update: the outer track pair, the wheels' bodies and the prefab are not lost when
           the files they read have the same CRC; a vehicle XML that changed gives no guessed wheel
  repair   the 02.10 state (published.json of 0.9.3, built under the new client without the fill-ins): those battles are
           stale, prepared on open with the fill-ins back - the same hits as under their own client; a battle with nothing to
           fill is not rewritten; a battle built under its own client and one of the running client stay current

An earlier client's files are given as a test gives them (Exporter.client_snapshots, give_previous); in the game they come
from the mod's own snapshot of that client or one derived from the update's changes (client_snapshot.py).
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import copy, hashlib, imp, json, logging, os, shutil, sys, tempfile, time, traceback, types, zipfile
try: import Queue as queue
except ImportError: import queue

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
PY27 = HERE
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True
report, failures = [], []


def check(group, name, ok, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + '[%s] %s' % (group, name) + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)
    return ok


class NS(object):
    def __init__(self, **kw): self.__dict__.update(kw)


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record): self.records.append(record)


logs = Collect()
logger = logging.getLogger('local.armor_inspector')
logger.addHandler(logs)
logger.setLevel(logging.INFO)
logger.propagate = False


def logged(text): return [r.getMessage() for r in logs.records if text in r.getMessage()]


# The fixtures of wheels.py and prefabs.py (their XML, wheels and prefab JSON), loaded without running them.
wheels27 = imp.load_source('wheels27_ondemand', os.path.join(PY27, 'wheels.py'))
prefabs27 = imp.load_source('prefabs27_ondemand', os.path.join(PY27, 'prefabs.py'))
C1, C2, C3 = 'client 1\n', 'client 2\n', 'client 3\n'
W, D, P, N = 'france:W_Test', 'germany:D_Track', 'italy:T_Crest', 'usa:N_Plain'
XML_W = wheels27.XML
XML_P = prefabs27.XML.replace('<Gun_B><slotPrefabs><nowhere>' + prefabs27.PATH + '</nowhere></slotPrefabs></Gun_B>', '')
PREFAB_PATH, PREFAB_MODEL = prefabs27.PATH, prefabs27.MODEL
EXTRA = 'vehicles/germany/D_Track/collision_client/Chassis_2.model'
WARNING = 'Additional vehicle parts are not yet rendered'


def xml_path(type_name):
    nation, name = type_name.split(':')
    return 'scripts/item_defs/vehicles/%s/%s.xml' % (nation, name)


def statics(type_name):
    nation, name = type_name.split(':')
    return [{'id': i, 'name': n, 'resource': 'vehicles/%s/%s/collision_client/%s.model' % (nation, name, n.capitalize()),
             'armor': {'armor_1': {'armor': 20.0 + i}}, 'armorSource': 'live',
             'transform': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0.0, 0.5 * i, 0.0, 1.0]}
            for i, n in enumerate(('chassis', 'hull', 'turret', 'gun'))]


RESOURCES = [p['resource'] for t in (W, D, P, N) for p in statics(t)] + [EXTRA, PREFAB_MODEL]


def target(type_name, compact, extra=()):
    return {'name': type_name.split(':')[1], 'type': type_name, 'compactDescriptor': compact, 'worldTransform': [1] * 16,
            'parts': statics(type_name) + list(extra)}


def wheel_parts():
    return [{'id': -(index + 1), 'name': name, 'material': 'wheel', 'armor': {'wheel': {'armor': mm}}}
            for name, index, mm in sorted(wheels27.WHEELS, key=lambda w: w[1])]


def hit(number, tgt, warnings=(), points=()):
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming', 'target': tgt,
            'attacker': {'name': 'A', 'parts': []}, 'warnings': list(warnings), 'points': list(points)}


def raw_battle(name, kind, version, started):
    head = {'schema': 1, 'type': 'battle', 'id': name, 'startedAt': started, 'map': 'Map', 'clientVersion': version,
            'recorderVersion': '0.9.3'}
    if kind == 'W':
        hits = [hit(1, target(W, 'W', wheel_parts()), points=[{'status': 'resolved', 'part': -3, 'position': [0, 0, 0]}])]
    elif kind == 'D':
        hits = [hit(1, target(D, 'D'), [WARNING], [{'status': 'unsupported-part', 'part': 4, 'position': [0.1, 0.2, 0.3]}])]
    elif kind == 'P':
        hits = [hit(1, target(P, 'C', [{'id': 5, 'name': 'crest_module', 'prefab': PREFAB_PATH, 'parentPart': 3,
                                         'transform': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 1.8, -0.5, 1.0]}]),
                    points=[{'status': 'resolved', 'part': 5, 'position': [0, 0.1, -0.3]}])]
    else:
        hits = [hit(1, target(N, 'N'))]
    return ''.join(json.dumps(row) + '\n' for row in [head] + hits)


# The descriptors the fixes build (vehicle_descr): what the fill-ins read of them - type, chassis - and the extra track pair
# of the double-track type (parts_from_descr).
DESCRS = {'W': NS(type=NS(name=W), chassis=NS(name='Chassis_W')), 'D': NS(type=NS(name=D), chassis=NS(name='Chassis_D')),
          'C': NS(type=NS(name=P), chassis=NS(name='Chassis_T')), 'N': NS(type=NS(name=N), chassis=NS(name='Chassis_N')),
          # A descriptor that decodes to another type than the record names (ids that moved between clients).
          'V': NS(type=NS(name='france:W_Other'), chassis=NS(name='Chassis_W'))}


def fake_descr(compact):
    if compact not in DESCRS: raise ValueError('no such descriptor')
    return DESCRS[compact]


def fake_parts(descr, armor_source='x'):
    parts = statics(descr.type.name)
    if descr.type.name == D:
        parts.append({'id': 4, 'name': 'chassis', 'resource': EXTRA, 'armor': {'armor_1': {'armor': 15.0}}, 'armorSource': armor_source})
    return parts


temp = tempfile.mkdtemp(prefix='bullba-ondemand27-')


def write(path, data, mode='wb'):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    with open(path, mode) as stream: stream.write(data)


# The client's code and the nations' tables that decode a compact descriptor (review #7, 02.10): changed in a client, they
# close the fill-ins' gate; the crew's code (tankmen_components.pyc, what 2.4.0.2 changed) does not.
CODE = {'scripts/common/items/vehicles.pyc': b'vehicles code', 'scripts/common/items/components/tankmen_components.pyc': b'crew code',
        'scripts/common/items/components/chassis_components.pyc': b'chassis code', 'scripts/common/material_kinds.pyc': b'kinds code'}
TABLES = dict(('scripts/item_defs/vehicles/%s/%s' % (nation, name), b'<root>' + name.encode('ascii') + b'</root>')
              for nation in ('france', 'germany', 'italy', 'usa') for name in ('list.xml', 'components/chassis.xml'))


def packages(game, xml_w=XML_W, xml_d='<root/>', xml_p=XML_P, changed=()):
    """The client's packages: scripts.pkg (the XMLs, the code, the nations' tables) and a vehicles package (the .havok files,
    the prefab JSON). `changed`: client paths whose bytes this client has otherwise."""
    root = os.path.join(game, 'res', 'packages')
    if not os.path.isdir(root): os.makedirs(root)
    with zipfile.ZipFile(os.path.join(root, 'scripts.pkg'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(xml_path(W), xml_w)
        z.writestr(xml_path(P), xml_p)
        z.writestr(xml_path(D), xml_d)
        z.writestr(xml_path(N), '<root/>')
        z.writestr(xml_path('france:W_Other'), XML_W)
        for path, data in sorted(list(CODE.items()) + list(TABLES.items())):
            z.writestr(path, data + (b' changed' if path in changed else b''))
    with zipfile.ZipFile(os.path.join(root, 'vehicles.pkg'), 'w', zipfile.ZIP_DEFLATED) as z:
        for resource in RESOURCES:
            z.writestr(resource[:-len('.model')] + '.havok', b'havok ' + resource.encode('ascii'))
        z.writestr(PREFAB_PATH, json.dumps(prefabs27.prefab()))


def crcs_now(game):
    """{path: (crc, size)} of every member of the made-up client: what an earlier client's snapshot would hold."""
    found = {}
    for name in ('scripts.pkg', 'vehicles.pkg'):
        with zipfile.ZipFile(os.path.join(game, 'res', 'packages', name)) as z:
            for info in z.infolist(): found[info.filename] = (info.CRC, info.file_size)
    return found


def first_diff(a, b, at=''):
    """Where two published values first differ (a check's detail)."""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key): return first_diff(a.get(key), b.get(key), at + '.' + str(key))
        return None
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for n, (x, y) in enumerate(zip(a, b)):
            if x != y: return first_diff(x, y, '%s[%d]' % (at, n))
        return None
    return None if a == b else (at, a, b)


def give_previous(e, version, crcs):
    """The CRCs of an earlier client's files, as the client snapshot provides them (Exporter.client_snapshots: a test's)."""
    snapshots = getattr(e, 'client_snapshots', None)
    if not isinstance(snapshots, dict):
        snapshots = {}
        e.client_snapshots = snapshots
    snapshots[version] = dict(crcs)


try:
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    kinds = types.ModuleType('material_kinds')
    kinds.NAMES_BY_IDS = prefabs27.NAMES
    kinds.IDS_BY_NAMES = dict((v, k) for k, v in prefabs27.NAMES.items())
    sys.modules['material_kinds'] = kinds
    from local_armor_inspector import exporter as ex
    ex.vehicle_descr = fake_descr
    ex.parts_from_descr = fake_parts
    REAL_FORMAT = ex.DERIVED_FORMAT

    reads = []
    real_init = ex.BattleReader.__init__

    def counted(self, path, decoder=None):
        reads.append(os.path.basename(path))
        real_init(self, path, decoder)
    ex.BattleReader.__init__ = counted

    def make(game_name, folder_name):
        game = os.path.join(temp, game_name)
        folder = os.path.join(game, 'mods', 'configs', folder_name)
        archive = os.path.join(game, 'test.wotmod')
        if not os.path.isfile(archive):
            write(archive, b'')
            with zipfile.ZipFile(archive, 'w') as z:
                for asset in ex.ASSETS: z.writestr('res/armor_inspector_viewer/' + asset, '')
            packages(game)
        # The models on disk: as 0.9.3 named them for each client (by the version text) and by their content (BACKLOG 55).
        names = [ex.model_key(resource, version) for version in (C1, C2) for resource in RESOURCES]
        with zipfile.ZipFile(os.path.join(game, 'res', 'packages', 'vehicles.pkg')) as z:
            for resource in RESOURCES:
                info = z.getinfo(resource[:-len('.model')] + '.havok')
                names.append(ex.model_content_key(info.filename, '%08x' % info.CRC, info.file_size))
        for name in names:
            write(os.path.join(folder, 'data', 'models', name + '.js'), 'ArmorInspectorData.receive(["model:x",{}]);\n')
        return game, folder, archive

    def settle(e, limit=400):
        """Run what the export thread would after setup, until nothing is left: jobs, then the battles they asked for."""
        for _ in range(limit):
            e.last_job = 0
            e.republished = {}
            if e.jobs: e.run_job()
            elif e.republish: e.drain_republish()
            else: break

    def derived(folder, name):
        return ex.read_data_file(os.path.join(folder, 'data', 'battles', name + '.js'))

    def raw_bytes(folder, name):
        with open(os.path.join(folder, 'data', 'battles', name + '.js'), 'rb') as stream: return stream.read()

    def rows(folder):
        return dict((r['id'], r) for r in ex.read_data_file(os.path.join(folder, 'data', 'index.js'))['battles'])

    def parts_of(folder, name):
        return derived(folder, name)['hits'][0]['target']['parts']

    def bodies(folder, name):
        wheels = [p for p in parts_of(folder, name) if isinstance(p.get('id'), int) and p['id'] < 0]
        return len(wheels), len([p for p in wheels if p.get('wheel') and p.get('transform')])

    def extra_pair(folder, name):
        h = derived(folder, name)['hits'][0]
        return (any(p.get('id') == 4 and p.get('resource') == EXTRA for p in h['target']['parts']), WARNING in (h.get('warnings') or []),
                h['points'][0]['status'])

    def prefab_filled(folder, name):
        part = [p for p in parts_of(folder, name) if p.get('id') == 5][0]
        return part.get('resource') == PREFAB_MODEL and 'prefabError' not in part, part.get('prefabError')

    def battle_jobs(e): return sorted(j[3]['battleId'] for j in e.jobs if j[2] == 'battle')

    # =================== update: a client update with the same raw, format and models ===================
    group = 'update'
    game, folder, archive = make('game', 'local.armor_inspector')
    names = ['w-1', 'd-1', 'p-1']
    for number, (name, kind) in enumerate(zip(names, 'WDP')):
        write(os.path.join(folder, 'battles', name + '.jsonl'), raw_battle(name, kind, C1, number + 1))
    first = ex.Exporter(game, folder, C1, archive)
    first.setup()
    for name in names: first.request_battle(name)   # the page opened each (no battle is published at the start)
    settle(first)
    first.write_published()
    check(group, "a battle of the running client keeps what its fill-ins read too - the outer track pair's XML and .havok (review #5)",
          set([xml_path(D), EXTRA[:-len('.model')] + '.havok']) <= set((first.published['d-1'].get('inputs') or {}))
          and xml_path(W) in (first.published['w-1'].get('inputs') or {}) and PREFAB_PATH in (first.published['p-1'].get('inputs') or {}),
          dict((n, sorted(first.published[n].get('inputs') or {})) for n in names))
    check(group, '(client 1: every battle published with its fill-ins - the wheels, the outer track pair, the prefab)',
          bodies(folder, 'w-1') == (4, 4) and extra_pair(folder, 'd-1') == (True, False, 'resolved')
          and prefab_filled(folder, 'p-1')[0], (bodies(folder, 'w-1'), extra_pair(folder, 'd-1'), prefab_filled(folder, 'p-1')))
    before = dict((n, raw_bytes(folder, n)) for n in names)
    old_rows = rows(folder)
    del reads[:]
    logs.records[:] = []
    second = ex.Exporter(game, folder, C2, archive)
    second.setup()
    check(group, 'the new client: no battle job at the start (02.10: 222 queued)', battle_jobs(second) == [], battle_jobs(second))
    check(group, 'the startup line: 3 current and 0 stale', bool(logged('battles 3 current and 0 stale')), logged('Startup in'))
    check(group, 'no raw battle read', reads == [], reads)
    settle(second)
    check(group, 'nothing published again afterwards either: the derived files byte for byte as they were',
          all(raw_bytes(folder, n) == before[n] for n in names), [n for n in names if raw_bytes(folder, n) != before[n]])
    now_rows = rows(folder)
    check(group, 'the index rows: the same revisions, none stale',
          all(now_rows[n].get('rev') == old_rows[n].get('rev') and not now_rows[n].get('stale') for n in names),
          [(n, now_rows[n].get('rev'), now_rows[n].get('stale')) for n in names])
    second.write_published()

    # =================== open: a format raised after the update; the page opens one battle ===================
    group = 'open'
    ex.DERIVED_FORMAT = REAL_FORMAT + 1
    try:
        del reads[:]
        third = ex.Exporter(game, folder, C2, archive)
        third.setup()
        check(group, 'a raised format: still no battle job at the start - nothing prepared before it is opened',
              battle_jobs(third) == [], battle_jobs(third))
        stale_rows = rows(folder)
        check(group, "the index says which battles are stale ('stale' on each row)", all(stale_rows[n].get('stale') is True for n in names),
              [(n, stale_rows[n].get('stale')) for n in names])
        check(group, 'the old files stay on disk for the page meanwhile', all(raw_bytes(folder, n) == before[n] for n in names))
        # The page's command arrives during a drag (busy_until in the future).
        third.recorder = NS(in_battle=False, busy_until=1e12, page_open_until=0.0, frames_wanted=False,
                            writer=NS(export_queue=queue.Queue()), wait_frame=lambda timeout=0.1: None)
        asked = getattr(third, 'request_battle', None)
        if check(group, 'Exporter.request_battle exists (the page command\'s entry on the export thread)', asked is not None):
            asked('w-1')
            job = third.job_index.get(('battle', 'w-1'))
            check(group, "that battle alone is queued, at the page's priority", battle_jobs(third) == ['w-1'] and job is not None
                  and job[0] == ex.JOB_PAGE, (battle_jobs(third), job and job[0]))
            for _ in range(200):
                third.last_job = 0
                third.republished = {}
                if third.jobs: third.run_job()
                elif third.republish: third.drain_republish()
                else: break
            entry = third.published.get('w-1') or {}
            check(group, 'a drag does not stop it: prepared in the raised format, its raw file read once, no other battle read',
                  reads == ['w-1.jsonl'] and entry.get('stamp') == 'd%d' % ex.DERIVED_FORMAT and entry.get('waits') is False,
                  (reads, entry.get('stamp'), entry.get('waits')))
            check(group, 'complete through the drag: its wheels have their bodies', bodies(folder, 'w-1') == (4, 4), bodies(folder, 'w-1'))
            after = rows(folder)
            # The raised format writes these same bytes here (the test raises the number only): the file is not rewritten and
            # its revision stays - the page has nothing to read again.
            check(group, 'its row: not stale; the same bytes - not rewritten, the same revision; the others still stale',
                  not after['w-1'].get('stale') and after['w-1'].get('rev') == stale_rows['w-1'].get('rev')
                  and raw_bytes(folder, 'w-1') == before['w-1']
                  and after['d-1'].get('stale') is True and after['p-1'].get('stale') is True
                  and raw_bytes(folder, 'd-1') == before['d-1'], dict((n, (after[n].get('stale'), after[n].get('rev'))) for n in names))
        third.recorder = None

        # The wiring page -> mod: presentation's 'prepareBattle' with a battleId, the export thread's 'battle' message.
        from local_armor_inspector import presentation
        setter = getattr(presentation, 'set_battle_request', None)
        if check(group, 'presentation.set_battle_request exists', setter is not None):
            got = []
            setter(got.append)
            presentation._handle_web_command(NS(action='prepareBattle', battleId='w-1'), None)
            presentation._handle_web_command(NS(action='prepareBattle', battleId='../x'), None)
            presentation._handle_web_command(NS(action='prepareBattle'), None)
            check(group, "'prepareBattle' hands its battle id on; a bad or missing id is dropped on the game thread", got == ['w-1'], got)
            setter(None)
        source = open(os.path.join(REPO, 'mod', 'local_armor_inspector', 'presentation.py'), 'rb').read().decode('utf-8')
        check(group, 'the page command schema carries battleId', 'battleId = Field(' in source)
        mod_source = open(os.path.join(REPO, 'mod', 'mod_local_armor_inspector.py'), 'rb').read().decode('utf-8')
        check(group, 'the mod registers the battle request with the page channel', 'set_battle_request(' in mod_source)
        import mod_local_armor_inspector as mod
        calls = []
        stub = NS(setup=lambda: None, idle=lambda: None, request_battle=calls.append)
        writer = mod.Writer(os.path.join(temp, 'writer-battles'), stub)
        writer.put_export('battle', 'w-1')
        deadline = time.time() + 3.0
        while not calls and time.time() < deadline: time.sleep(0.02)
        writer.close()
        check(group, "the export thread hands the 'battle' message to Exporter.request_battle", calls == ['w-1'], calls)

        # =================== gate: the fill-ins pass by the CRC of what they read ===================
        group = 'gate'
        fourth = ex.Exporter(game, folder, C2, archive)
        fourth.setup()
        for name in names:
            fourth.republish_saved(name)
            settle(fourth)
        check(group, 'the same .havok: the outer track pair is kept (02.10: 7 battles lost it)',
              extra_pair(folder, 'd-1') == (True, False, 'resolved'), extra_pair(folder, 'd-1'))
        check(group, 'the same vehicle XML: the wheels keep their bodies (02.10: 15 battles lost them)',
              bodies(folder, 'w-1') == (4, 4), bodies(folder, 'w-1'))
        check(group, 'the same XML and prefab JSON: the armoured prefab keeps its model and armour',
              prefab_filled(folder, 'p-1')[0], prefab_filled(folder, 'p-1'))
        fourth.write_published()
        check(group, "every fill-in keeps what it read: the outer track pair's XML and .havok too (review #5)",
              set([xml_path(D), EXTRA[:-len('.model')] + '.havok']) <= set((fourth.published['d-1'].get('inputs') or {}))
              and xml_path(W) in (fourth.published['w-1'].get('inputs') or {})
              and PREFAB_PATH in (fourth.published['p-1'].get('inputs') or {}),
              dict((n, sorted(fourth.published[n].get('inputs') or {})) for n in names))
        # Client 3: the three vehicles' XML changed. Not read from it (never guessed) - and never dropped either: the battle's
        # file holds them as its own client filled them, and that client is gone (review #5, 02.10).
        packages(game, xml_w=XML_W.replace('<radius>0.609</radius>', '<radius>0.7</radius>'), xml_d='<root><x/></root>',
                 xml_p=XML_P.replace('<root>', '<root><x/>'))
        ex.DERIVED_FORMAT = REAL_FORMAT + 2
        fifth = ex.Exporter(game, folder, C3, archive)
        fifth.setup()
        del logs.records[:]
        for name in names:
            fifth.republish_saved(name)
            settle(fifth)
        check(group, "changed vehicle XMLs: the wheels, the outer track pair and the prefab kept from the battle's file",
              bodies(folder, 'w-1') == (4, 4) and extra_pair(folder, 'd-1') == (True, False, 'resolved') and prefab_filled(folder, 'p-1')[0],
              (bodies(folder, 'w-1'), extra_pair(folder, 'd-1'), prefab_filled(folder, 'p-1')))
        check(group, "... the wheels as their own client made them, not from the changed XML",
              ([p.get('wheel') for p in parts_of(folder, 'w-1') if p.get('id') == -1][0] or {}).get('radius') == 0.609,
              [p.get('wheel') for p in parts_of(folder, 'w-1') if p.get('id') == -1])
        check(group, '... and said so in the log, one line a battle', len(logged('fill-ins kept from its file')) == 3, logged('kept'))
        check(group, '... and the battle does not wait for ever for them', fifth.published.get('w-1', {}).get('waits') is False,
              fifth.published.get('w-1'))
        # No file to keep them from (deleted): the part as recorded - nothing guessed.
        os.remove(os.path.join(folder, 'data', 'battles', 'w-1.js'))
        fifth.republish_saved('w-1')
        settle(fifth)
        check(group, 'a changed XML and no file to keep them from: the wheels as recorded', bodies(folder, 'w-1') == (4, 0),
              bodies(folder, 'w-1'))
        packages(game)
    finally:
        ex.DERIVED_FORMAT = REAL_FORMAT

    # =================== repair: the battles damaged on 02.10 ===================
    group = 'repair'
    game2, folder2, archive2 = make('game2', 'local.armor_inspector')
    damaged = ['w-1', 'd-1', 'p-1', 'n-1']
    for number, (name, kind) in enumerate(zip(damaged, 'WDPN')):
        write(os.path.join(folder2, 'battles', name + '.jsonl'), raw_battle(name, kind, C1, number + 1))
    write(os.path.join(folder2, 'battles', 'o-1.jsonl'), raw_battle('o-1', 'W', C1, 5))   # built under its own client
    write(os.path.join(folder2, 'battles', 'c-2.jsonl'), raw_battle('c-2', 'W', C2, 6))   # of the running client
    good = ex.Exporter(game2, folder2, C1, archive2)
    for name in damaged + ['o-1']:
        good.republish_saved(name)
        settle(good)
    good_hits = dict((n, derived(folder2, n)['hits']) for n in damaged)
    entries = dict((n, dict(good.published[n])) for n in ['o-1'])
    # The 02.10 publication: under client 2, the fill-ins of client 1's battles left out (0.9.3's non-running branch).
    bad = ex.Exporter(game2, folder2, C2, archive2)
    real_extra, real_wheels, real_prefabs = ex.fix_extra_parts, bad.fix_wheels, bad.fix_prefabs
    ex.fix_extra_parts = lambda h: False
    bad.fix_wheels = lambda vehicle, defer=None: 0

    def no_prefab(vehicle, defer=None):
        for part in (vehicle or {}).get('parts') or ():
            if isinstance(part, dict) and part.get('prefab') and 'resource' not in part:
                part['prefabError'] = 'recorded by another client version'
        return 0
    bad.fix_prefabs = no_prefab
    bad.keep_fills = lambda battle, hit, kind: False   # 0.9.3 kept nothing of the file it replaced
    try:
        for name in damaged:
            bad.republish_saved(name)
            settle(bad)
    finally:
        ex.fix_extra_parts = real_extra
    del bad.fix_wheels, bad.fix_prefabs, bad.keep_fills
    bad.republish_saved('c-2')
    settle(bad)
    check(group, '(the 02.10 state: no wheel body, no outer pair, the prefab in error)', bodies(folder2, 'w-1') == (4, 0)
          and extra_pair(folder2, 'd-1') == (False, True, 'unsupported-part') and not prefab_filled(folder2, 'p-1')[0]
          and bodies(folder2, 'c-2') == (4, 4), (bodies(folder2, 'w-1'), extra_pair(folder2, 'd-1'), bodies(folder2, 'c-2')))
    for n in damaged + ['c-2']: entries[n] = dict(bad.published[n])

    def legacy(entry, version):
        """An entry as 0.9.3 wrote it (PUBLISHED_FORMAT 2): the stamp of DERIVED_FORMAT 1 and the client it was built under."""
        keep = dict((k, entry[k]) for k in ('raw', 'rawSize', 'size', 'refs', 'waits', 'summary') if k in entry)
        keep['stamp'] = 'd1:%s' % hashlib.sha1(version.encode('utf-8')).hexdigest()[:16]
        if entry.get('absent'): keep['absent'] = sorted(entry['absent'])
        return keep
    built = dict((n, legacy(entries[n], C1 if n == 'o-1' else C2)) for n in entries)
    keys, battles = [], {}
    for name, entry in built.items():
        refs = []
        for key in entry['refs']:
            if key not in keys: keys.append(key)
            refs.append(keys.index(key))
        battles[name] = dict(entry, refs=sorted(refs))
    write(os.path.join(folder2, 'data', 'published.json'), json.dumps({'format': 2, 'keys': keys, 'battles': battles}).encode('ascii'))
    bad.write_index()
    times = dict((n, os.path.getmtime(os.path.join(folder2, 'data', 'battles', n + '.js'))) for n in built)
    for n in built: os.utime(os.path.join(folder2, 'data', 'battles', n + '.js'), (times[n] - 100, times[n] - 100))
    times = dict((n, os.path.getmtime(os.path.join(folder2, 'data', 'battles', n + '.js'))) for n in built)
    fixer = ex.Exporter(game2, folder2, C2, archive2)
    give_previous(fixer, C1, crcs_now(game2))   # the client agent's diff: 2.4.0.2 changed none of these files
    fixer.setup()
    # (setup may read the first line of a raw file whose entry predates the stamp change: which client recorded it)
    del reads[:]
    check(group, 'no battle job at the start: the repair waits for the page', battle_jobs(fixer) == [], battle_jobs(fixer))
    marked = rows(folder2)
    check(group, "the battles built under another client than their own are 'stale'",
          all(marked[n].get('stale') is True for n in damaged), [(n, marked[n].get('stale')) for n in damaged])
    check(group, 'a battle built under its own client and one of the running client: not stale',
          not marked['o-1'].get('stale') and not marked['c-2'].get('stale'), (marked['o-1'].get('stale'), marked['c-2'].get('stale')))
    asked = getattr(fixer, 'request_battle', None)
    if check(group, '(Exporter.request_battle exists)', asked is not None):
        for name in damaged:
            asked(name)
            settle(fixer)
        def keyless(hits):
            # The model files by name: the running client's by content, another client's as that client named them - the
            # same model either way (model_ref); every part must still have one.
            hits = copy.deepcopy(hits)
            for h in hits:
                for side in ('target', 'attacker'):
                    for part in (h.get(side) or {}).get('parts') or ():
                        if part.get('resource'): part['modelKey'] = bool(part.get('modelKey')) and not part.get('modelPending')
            return hits
        check(group, 'opened: the wheels, the outer pair and the prefab are back - the same hits as under their own client',
              all(keyless(derived(folder2, n)['hits']) == keyless(good_hits[n]) for n in ['w-1', 'd-1', 'p-1']),
              [(n, first_diff(keyless(good_hits[n]), keyless(derived(folder2, n)['hits']))) for n in ['w-1', 'd-1', 'p-1']])
        check(group, 'a battle with nothing to fill is not rewritten (the same bytes stay as they were)',
              os.path.getmtime(os.path.join(folder2, 'data', 'battles', 'n-1.js')) == times['n-1'])
        done = rows(folder2)
        check(group, 'every opened battle stops being stale; the others are untouched',
              not any(done[n].get('stale') for n in damaged + ['o-1', 'c-2'])
              and os.path.getmtime(os.path.join(folder2, 'data', 'battles', 'o-1.js')) == times['o-1'],
              [(n, done[n].get('stale')) for n in done])
        check(group, 'only the opened battles were read', sorted(reads) == sorted(n + '.jsonl' for n in damaged), sorted(reads))
    # =================== code: what decodes the descriptor is an input of the fill-ins too (review #7) ===================
    group = 'code'

    def filled(changed):
        """A battle of the earlier client prepared under the running one, that client's files differing only in `changed`:
        (the wheels with a body, whether the outer track pair was added)."""
        e = ex.Exporter(game2, folder2, C2, archive2)
        e.client()
        previous = crcs_now(game2)
        for path in changed: previous[path] = (previous[path][0] ^ 1, previous[path][1])
        give_previous(e, C1, previous)
        e.preparing_page = True
        battle = {'id': 'zz', 'clientVersion': C1, 'hits': []}
        wheels = e.prepare_hit(json.loads(raw_battle('x', 'W', C1, 1).splitlines()[1]), 0, battle)['target']['parts']
        pair = e.prepare_hit(json.loads(raw_battle('x', 'D', C1, 1).splitlines()[1]), 0, battle)['target']['parts']
        return (len([p for p in wheels if p.get('id') < 0 and p.get('wheel')]), any(p.get('id') == 4 for p in pair))
    check(group, '(the same files: wheels and outer pair filled)', filled([]) == (4, True), filled([]))
    crew = ['scripts/common/items/components/tankmen_components.pyc']
    check(group, "only the crew's code changed (as in 2.4.0.2): still filled - the repair stands", filled(crew) == (4, True), filled(crew))
    code = ['scripts/common/items/vehicles.pyc']
    check(group, 'the code that decodes a descriptor changed (items/vehicles.pyc): nothing filled', filled(code) == (0, False), filled(code))
    code = ['scripts/common/items/components/chassis_components.pyc']
    check(group, "the chassis' code changed: nothing filled", filled(code) == (0, False), filled(code))
    tables = ['scripts/item_defs/vehicles/%s/components/chassis.xml' % n for n in ('france', 'germany')]
    check(group, "the nation's chassis table (components/chassis.xml: id -> chassis) changed: nothing filled",
          filled(tables) == (0, False), filled(tables))
    tables = ['scripts/item_defs/vehicles/%s/list.xml' % n for n in ('france', 'germany')]
    check(group, "the nation's list (list.xml: id -> type) changed: nothing filled", filled(tables) == (0, False), filled(tables))
    e = ex.Exporter(game2, folder2, C2, archive2)
    e.preparing_page = True
    moved = json.loads(raw_battle('x', 'W', C2, 1).splitlines()[1])
    moved['target']['compactDescriptor'] = 'V'
    parts = e.prepare_hit(moved, 0, {'id': 'zv', 'clientVersion': C2, 'hits': []})['target']['parts']
    check(group, 'a descriptor that decodes to another type than the record: no wheel body from that type',
          not [p for p in parts if p.get('id') < 0 and p.get('wheel')], [p.get('wheel') for p in parts if p.get('id') < 0])
    ex.BattleReader.__init__ = real_init
except Exception:
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    shutil.rmtree(temp, ignore_errors=True)
report.append('battles_on_demand: %d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
