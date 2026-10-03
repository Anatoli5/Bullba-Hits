# -*- coding: utf-8 -*-
"""The client's snapshot and the keys built on it, at their edges (BACKLOG 55, review of 02.10), under the client's python27.dll.

    python tests/py27/run27.py tests/py27/client_keys.py

Small fake clients in a temp folder (no byte of the real one). Each section is one finding of the review:

  1  the snapshot is never all-or-nothing: an unreadable .wotmod is left out with a line, a file name outside ASCII (the game's
     folder is a byte string in the client) is read, a damaged stored snapshot is taken again; and without a snapshot nothing is
     taken for current because it once was (a characteristics file of another client, a vehicle file checked under another
     client, a 0.9.3 model file is reused by its bytes, not exported again);
  2  a battle of an earlier client whose .havok is the same as now gets its model exported, by content - not 'Client version
     changed';
  3  the armour cache is keyed by the files it is read from, not the version text;
  4  MODEL_FILE_FORMAT raised: a model file of the previous format is not reused, the new one says its format;
  6  the vehicle file's key moves with material_kinds.pyc and its nation's components;
  7  version.xml changed only in its <meta> (the same version label): the earlier client's snapshot is kept beside.
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, logging, os, shutil, sys, tempfile, zipfile, gzip
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report, failures = [], []


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


logs = Collect()
logger = logging.getLogger('local.armor_inspector')
logger.addHandler(logs)
logger.setLevel(logging.INFO)
logger.propagate = False

HAVOK = 'vehicles/german/G1_A/collision_client/Hull.havok'
RESOURCE = HAVOK.replace('.havok', '.model')
XML = 'scripts/item_defs/vehicles/germany/G1_A.xml'
GUNS = 'scripts/item_defs/vehicles/germany/components/guns.xml'
KINDS = 'scripts/common/material_kinds.pyc'
COMMON = 'scripts/item_defs/vehicles/common/vehicle.xml'


def version(label, meta='1'):
    return '<version.xml><version> %s </version><meta><client> %s </client></meta></version.xml>\n' % (label, meta)


temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    from local_armor_inspector import client_snapshot
    extracted = []
    real_extract = ex.extract
    ex.extract = lambda data: extracted.append(data) or {'kind': 'client-shot-collision', 'groups': []}

    def game_folder(name, files, wotmods=None, ver_folder='2.4.0.2'):
        game = os.path.join(temp, name)
        packages = os.path.join(game, 'res', 'packages')
        if not os.path.isdir(packages): os.makedirs(packages)
        with zipfile.ZipFile(os.path.join(packages, 'scripts.pkg'), 'w') as z:
            for path in sorted(p for p in files if p.startswith('scripts/')): z.writestr(path, files[path])
        with zipfile.ZipFile(os.path.join(packages, 'vehicles.pkg'), 'w') as z:
            for path in sorted(p for p in files if not p.startswith('scripts/')): z.writestr(path, files[path])
        mods = os.path.join(game, 'mods', ver_folder)
        if not os.path.isdir(mods): os.makedirs(mods)
        for name_, data in (wotmods or {}).items():
            with open(os.path.join(mods, name_), 'wb') as stream: stream.write(data)
        with open(os.path.join(game, 'paths.xml'), 'wb') as stream:
            stream.write('<root><Paths><Path mask="*.wotmod" root="res">./mods/%s</Path><Packages>'
                         '<Package>./res/packages/scripts.pkg</Package><Package>./res/packages/vehicles.pkg</Package>'
                         '</Packages></Paths></root>' % ver_folder)
        return game

    FILES = {XML: 'tank 1', GUNS: 'guns 1', KINDS: 'kinds 1', COMMON: 'common 1', 'scripts/common/items/vehicles.pyc': 'code 1',
             HAVOK: 'hull bytes'}

    def exporter(game, text, folder=None):
        e = ex.Exporter(game, folder or os.path.join(game, 'data-folder'), text, os.path.join(temp, 'unused.wotmod'))
        return e


    def section_0():
        global game, summary
        # ---- 1. never all-or-nothing --------------------------------------------------------------------------------
        good = os.path.join(temp, 'good.zip')
        with zipfile.ZipFile(good, 'w') as z: z.writestr('res/scripts/client/gui/mods/other.pyc', 'other mod')
        game = game_folder('g1', FILES, {'broken.wotmod': '', 'good.wotmod': open(good, 'rb').read()})
        e = exporter(game, version('v.2.4.0.2 #964'))
        snapshot = e.client()
        check(snapshot is not None and e.client_crc(XML) is not None and e.client_crc('scripts/client/gui/mods/other.pyc') is not None,
              '1: an unreadable .wotmod is left out, the rest of the snapshot is taken')
        check([l for l in logs.records if 'broken.wotmod' in l], '1: and the log names it',
              [l for l in logs.records if 'Client files' in l][:2])
        # A file name outside ASCII, in a game folder given as bytes (os.getcwd() in the client).
        game = game_folder('g2', FILES, {u'mod_caf\xe9.wotmod'.encode('mbcs'): open(good, 'rb').read()})
        e = exporter(game.encode('mbcs') if isinstance(game, unicode) else game, version('v.2.4.0.2 #964'))
        check(e.client() is not None and e.client_crc('scripts/client/gui/mods/other.pyc') is not None,
              '1: a .wotmod named outside ASCII, the game folder a byte string: the snapshot is taken')
        e2 = exporter(game.encode('mbcs') if isinstance(game, unicode) else game, version('v.2.4.0.2 #964'))
        check(e2.client() is not None and e2.client().diff == {}, '1: and read back unchanged at the next start')
        # A damaged stored snapshot, the client unchanged: taken again.
        game = game_folder('g3', FILES)
        exporter(game, version('v.2.4.0.2 #964')).client()
        folder = os.path.join(game, 'data-folder', 'data', 'client')
        for name in os.listdir(folder):
            if name.endswith('.txt.gz'):
                with open(os.path.join(folder, name), 'wb') as stream: stream.write('not a gzip')
        e = exporter(game, version('v.2.4.0.2 #964'))
        check(e.client() is not None and e.client_crc(XML) is not None, '1: a damaged stored snapshot is taken again')
        # Without a snapshot: nothing is current because it once was.
        game = game_folder('g4', FILES)
        old = exporter(game, version('v.2.4.0.1 #950'))
        old.client_state = False
        ttx = old.ttx_path('germany:G1_A')
        ex.write_data(ttx, 'ttx:germany-G1_A', {'schema': ex.TTX_SCHEMA, 'armorSchema': ex.TTX_ARMOR_SCHEMA, 'format': ex.TTX_FORMAT,
                                               'modesSchema': ex.TTX_MODES_SCHEMA, 'clientVersion': version('v.2.4.0.1 #950'),
                                               'vehicle': {'hasTurret': True, 'modes': {}}, 'configs': []})
        new = exporter(game, version('v.2.4.0.2 #964'))
        new.client_state = False
        new.ttx_state = {'now': None, 'keys': {'germany:G1_A': 'a key of an earlier client'}, 'failed': {}}
        check(not new.ttx_current('germany:G1_A'), '1a: no snapshot, another client: a characteristics file with an old key is not current')
        summary = {'id': 'germany-G1_A', 'type': 'germany:G1_A', 'clientVersion': version('v.2.4.0.1 #950'), 'compactDescriptor': 'x',
                   'parts': [{'resource': RESOURCE}]}
        new.keep_vehicle_key(summary)
        new.write_keys(force=True)
        again = exporter(game, version('v.2.4.0.2 #964'))
        again.client_state = False
        check(again.vehicle_current(summary), '1b: no snapshot: a vehicle file checked under this client stays current (not rebuilt every start)')
        later = exporter(game, version('v.2.4.0.3 #970'))
        later.client_state = False
        check(not later.vehicle_current(summary), '1b: and under the next client it is not')
        # A 0.9.3 model file (named by the earlier version text) is the same .havok: reused, not exported again.
        legacy = ex.model_key(RESOURCE, version('v.2.4.0.1 #950'))
        ex.write_data(old.model_path(legacy), 'model:' + legacy, {'kind': 'client-shot-collision', 'groups': [],
                                                                  'resource': HAVOK, 'sha256': __import__('hashlib').sha256('hull bytes').hexdigest()})
        del extracted[:]
        key, error = again.model_extract(RESOURCE, version('v.2.4.0.2 #964'))
        check(key == legacy and error is None and not extracted, '1c: no snapshot: the 0.9.3 file of the same bytes is the model',
              (key == legacy, error, len(extracted)))

    def section_1():
        global game, summary
        # ---- 2. an earlier client's battle, the same .havok -------------------------------------------------------------
        game = game_folder('g5', FILES)
        e = exporter(game, version('v.2.4.0.2 #964'))
        e.client()
        e.client_snapshots[version('v.2.4.0.1 #950')] = dict(e.client_files())
        del extracted[:]
        key, error = e.model_extract(RESOURCE, version('v.2.4.0.1 #950'))
        check(error is None and len(extracted) == 1 and key == e.model_content(RESOURCE) and os.path.isfile(e.model_path(key)),
              '2: a battle of 2.4.0.1, the same .havok, no model file yet: exported by content', (key, error))
        changed = dict(e.client_files())
        changed[HAVOK] = (12345, 10)
        e.client_snapshots[version('v.2.4.0.0 #945')] = changed
        key, error = e.model_extract(RESOURCE, version('v.2.4.0.0 #945'))
        check(error and error.startswith('Client version changed'), '2: another .havok then: not this client\'s to export', error)

    def section_2():
        global game, summary
        # ---- 3. the armour cache --------------------------------------------------------------------------------------
        game = game_folder('g6', FILES)
        reads = []
        first = exporter(game, version('v.2.4.0.1 #950'))
        first.client()
        first.armor.materials = lambda type_name, resource: reads.append(resource) or {'armor_1': {'armor': 10.0}}
        vehicle = {'type': 'germany:G1_A', 'compactDescriptor': 'x'}
        first.publish_vehicle_parts([{'id': 1, 'resource': RESOURCE}], vehicle, version('v.2.4.0.1 #950'))
        second = exporter(game, version('v.2.4.0.2 #964'))
        second.client()
        second.armor.materials = lambda type_name, resource: reads.append(resource) or {'armor_1': {'armor': 10.0}}
        parts = [{'id': 1, 'resource': RESOURCE}]
        second.publish_vehicle_parts(parts, vehicle, version('v.2.4.0.2 #964'))
        check(len(reads) == 1 and parts[0].get('armor'), '3: the armour table of the same XML is read once across a client update',
              (len(reads), parts[0].get('armorError')))

    def section_3():
        global game, summary
        # ---- 4. MODEL_FILE_FORMAT raised -------------------------------------------------------------------------------
        game = game_folder('g7', FILES)
        e = exporter(game, version('v.2.4.0.2 #964'))
        e.client()
        del extracted[:]
        one, _ = e.model_extract(RESOURCE, version('v.2.4.0.2 #964'))
        saved = ex.MODEL_FILE_FORMAT
        ex.MODEL_FILE_FORMAT = saved + 1
        try:
            raised = exporter(game, version('v.2.4.0.2 #964'))
            raised.client()
            two, error = raised.model_extract(RESOURCE, version('v.2.4.0.2 #964'))
            written = ex.read_data_file(raised.model_path(two)) if two and os.path.isfile(raised.model_path(two)) else {}
            check(two != one and len(extracted) == 2 and written.get('format') == saved + 1,
                  '4: MODEL_FILE_FORMAT raised: the model of the previous format is not reused, the new file says its format',
                  (two == one, len(extracted), written.get('format')))
            check(raised.model_identity(one) != raised.model_identity(two), '4: and a vehicle file referring to the old one is another file')
        finally:
            ex.MODEL_FILE_FORMAT = saved

    def section_4():
        global game, summary
        # ---- 6. the vehicle file's key and the descriptor's inputs ----------------------------------------------------
        game = game_folder('g8', FILES)
        e = exporter(game, version('v.2.4.0.2 #964'))
        e.client()
        base = e.vehicle_key(summary)
        for path, label in ((KINDS, 'material_kinds.pyc'), (GUNS, 'its nation\'s components')):
            moved = dict(FILES, **{path: 'changed'})
            other = exporter(game_folder('g8-%d' % len(label), moved), version('v.2.4.0.2 #964'))
            other.client()
            check(other.vehicle_key(summary) != base, '6: the vehicle file\'s key moves with %s' % label)

    def section_5():
        global game, summary
        # ---- 7. version.xml changed only in its <meta> ----------------------------------------------------------------
        game = game_folder('g9', FILES)
        a = exporter(game, version('v.2.4.0.2 #964', meta='100'))
        a.client()
        game = game_folder('g9', dict(FILES, **{HAVOK: 'hull bytes 2'}))
        b = exporter(game, version('v.2.4.0.2 #964', meta='200'))
        b.client()
        check(b.client_crc(HAVOK, version('v.2.4.0.2 #964', meta='100')) == a.client_crc(HAVOK) != b.client_crc(HAVOK),
              '7: the same version label, another <meta>: the earlier snapshot is kept and answers for its own battles',
              (b.client_crc(HAVOK, version('v.2.4.0.2 #964', meta='100')), a.client_crc(HAVOK), b.client_crc(HAVOK)))

    summary = None
    for section in (section_0, section_1, section_2, section_3, section_4, section_5):
        try:
            section()
        except Exception:
            import traceback
            report.append('FAIL exception in %s\n%s' % (section.__name__, traceback.format_exc()))
            failures.append(section.__name__)
    ex.extract = real_extract
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
