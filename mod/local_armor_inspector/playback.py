# -*- coding: utf-8 -*-
"""What the page's 3D replay player needs from the mod for one battle (BACKLOG 104; since 19.11.2026 the page builds the
battle itself): data/playback/<id>.js and the files it names.

The user opens a recorded battle in the player (web/playback.html); the page asks the mod ('playback', Exporter.
request_playback), and the export thread's 'playback' job (Job.steps, in slices) writes, the first time only:
  1. the battle's source as it is kept, unread - its older stream (CFG/replay/<id>.stream.z, zlib), the raw copy not
     consumed yet, or - a battle taken by the replay limit (BACKLOG 107) - its .wotreplay under the mod's name
     (replay_library) - as base64 in a classic script, data/playback/<id>.src.js; nothing is decrypted or decoded here
     (the client's Python 2.7 decrypts at 0.72-0.80 s per MB, the page's JS at 4.9 ms per MB: outputs/decoder-rust-vs-js-
     2026-11-12.md);
  2. the client's definitions for the page's decoder (definitions_value: the entities and components of the session's
     replay_run.Definitions - the export of work/decoder-probe/py/ref.py -, the roster's vehicle names, the damage sticker
     kinds of damage_stickers.xml), once per client: data/playback/defs-<crc>.js, shared by every battle;
  3. the battle file last, so a page that finds it finds the others too: the battle record's map, mode, start, own vehicle
     and roster (nicknames), the client's version (the page keeps the maps it built under it), the client's part boxes
     of this battle (its stored records' statics: the hit points are decoded on them), the source's kind, size and CRC
     (the page's IndexedDB key) and the definitions file's name.
A replay FILE (19.11: the replay viewer's list, replay_files; id 'f-...') is played the same way with no record of
Bullba Hits: its map, mode, own vehicle and roster from the file's plain header (the cached scan), its source the file
itself, its part boxes from the client's own box table (client_boxes, CFG/data/playback/boxes.js) - a battle with stored
records keeps its own boxes, and takes the table's only for the models those lack.
The map's raw files are not this job's (19.11): the page asks for them ('mapRaw') only when its IndexedDB lacks the map,
and MapJob copies them (map_raw.copy_steps).
The page (web/playback/battle-page.js, battle.js) decrypts or inflates the source, decodes it and builds the battle - the
port of this module's Collector, assemble and Effects of 18.11 (recycle/mod/local_armor_inspector/playback.py) - and keeps
it in IndexedDB. A battle that cannot be played (no kept source, no battle record) gets a file with `error` in plain
words, so the page stops waiting and says why. One code for the client's Python 2.7 and CPython 3.
"""
from __future__ import absolute_import
import base64
import collections
import json
import logging
import os
import re
import time
import zlib

from . import map_raw

LOG = logging.getLogger('local.armor_inspector')
TIMER = getattr(time, 'perf_counter', None) or time.clock

FORMAT = 2                      # of data/playback/<id>.js; the page asks again for a file of another format
DATA_FOLDER = 'playback'        # CFG/data/playback/
RAW_FOLDER = 'mapraw'           # CFG/mapraw/ (map_raw)
KEY = 'playback:'
SOURCE_KEY = 'playback-source:'
DEFS_KEY = 'playback-defs:'
SOURCE_EXT = '.src.js'
HEAD_LINES = 400                # lines of the raw record read for the battle record and the first roster
HEAD_BYTES = 1024               # of the battle file read by current(): format, id, defs, source and record come first
STICKERS_XML = 'scripts/item_defs/vehicles/common/damage_stickers.xml'
TEXT = type(u'')

W_NO_RECORD = 'This battle has no record of its own on this computer, so its map is unknown'
W_NO_MAP = 'The battle record does not name the map of this battle'
W_NO_STREAM = 'No replay of this battle is kept: the game left no replay stream for it'
W_REMOVED = ('The replay of this battle was removed: the replay limit keeps the replays of the last %d battles '
             '(Settings, Replay limit), and this battle is older')
W_GONE = 'The replay of this battle is no longer in the game\'s replays folder under the name Bullba Hits gave it'
W_MAP = 'The map of this battle could not be copied from the game files (%s)'
W_FAILED = 'The replay of this battle could not be prepared (%s)'
W_NO_FILE = 'This replay file is no longer in the game\'s replays folder (it was moved, renamed or removed)'
BOXES_FILE = 'boxes'            # CFG/data/playback/boxes.js (client_boxes.Table)
VEHICLES_FOLDER = 'vehicles'    # CFG/data/playback/vehicles/<id>.js: a vehicle from the client's XML (vehicle_xml)


def is_file(name):
    """A replay file's id (replay_files.file_id), not a battle of Bullba Hits."""
    from .replay_files import PREFIX
    return str(name).startswith(PREFIX)


def boxes_path(folder):
    return data_path(folder, BOXES_FILE)


def vehicle_files(folder):
    """{'hits': [ids of data/vehicles/*.js], 'viewer': [ids of data/playback/vehicles/*.js]}: the page reads a vehicle
    from the file that is there instead of trying paths (a missing file is an error in the page's console)."""
    out = {}
    for key, sub in (('hits', ('data', 'vehicles')), ('viewer', ('data', DATA_FOLDER, VEHICLES_FOLDER))):
        try: names = os.listdir(os.path.join(folder, *sub))
        except OSError: names = []
        out[key] = sorted(n[:-3] for n in names if n.endswith('.js') and not n.endswith(SOURCE_EXT))
    return out


def client_box_table(folder, client):
    """{resource: box} of the client's own box table (client_boxes) when it is of this client, else {}."""
    from .client_boxes import read_file
    value = read_file(boxes_path(folder)) or {}
    if client and value.get('client') not in (None, client): return {}
    return dict(value.get('boxes') or {})


def data_path(folder, name):
    return os.path.join(folder, 'data', DATA_FOLDER, name + '.js')


def source_path(folder, name):
    return os.path.join(folder, 'data', DATA_FOLDER, name + SOURCE_EXT)


def raw_root(folder):
    return os.path.join(folder, RAW_FOLDER)


def current(folder, name, arena):
    """True when the battle's playback file is of this format, made (not an error), its record names the client, and its
    source and its definitions file are on disk: nothing to do. Reads the file's first bytes only. (The map's raw set is
    MapJob's.)"""
    path = data_path(folder, name)
    if not arena or not os.path.isfile(path): return False
    try:
        with open(path, 'rb') as handle: head = handle.read(HEAD_BYTES).decode('ascii', 'replace')
    except (IOError, OSError): return False
    prefix = 'ArmorInspectorData.receive(["%s%s",{"format":%d,"id":' % (KEY, name, FORMAT)
    found = re.search(r'"defs":"(defs-[0-9a-f]{8})"', head)
    # 19.11: a file of an earlier build has no client in its record; without it the page cannot find the map it built under
    # this client in its IndexedDB and asks for the map's raw files (23_westfeld in the game: 25.5 MB copied for nothing)
    record = re.search(r'"record":\{[^}]*\}', head)
    return (head.startswith(prefix) and found is not None and os.path.isfile(data_path(folder, found.group(1)))
            and record is not None and '"client":"' in record.group(0) and os.path.isfile(source_path(folder, name)))


def battle_arena(folder, name):
    """The arena (geometry name) of a battle from its raw record's first line, or None."""
    path = os.path.join(folder, 'battles', name + '.jsonl')
    try:
        with open(path, 'rb') as handle: record = json.loads(handle.readline().decode('utf-8'))
        return (record.get('mode') or {}).get('geometryName')
    except (IOError, OSError, ValueError, AttributeError):
        return None


# ---- the client's definitions for the page's decoder (work/decoder-probe/py/ref.py schema(), 12.11) ---------------------
class Types(object):
    """The decoder's types as a table: each type once, referred to by its index."""

    def __init__(self):
        self.table, self.index = [], {}

    def ref(self, t):
        from . import replay_stream as rd
        if t.kind == 'num':
            d = {'k': 'num', 'f': rd.SIMPLE[t.name] if t.name in rd.SIMPLE else None}
            if d['f'] is None: d['f'] = alias_format(t)   # an alias of a simple type: its format by size and reading
        elif t.kind in ('str', 'blob', 'mailbox'):
            d = {'k': t.kind}
        elif t.kind == 'array':
            d = {'k': 'array', 'of': self.ref(t.children[0]), 'n': fixed_count(t)}
        elif t.kind == 'dict':
            d = {'k': 'dict', 'fields': [[n, self.ref(x)] for n, x in t.children], 'none': bool(t.read.__defaults__[2])}
        else:
            raise ValueError(t.kind)
        d['size'] = t.size
        key = json.dumps(d, sort_keys=True)
        if key not in self.index:
            self.index[key] = len(self.table)
            self.table.append(d)
        return self.index[key]


def alias_format(t):
    from . import replay_stream as rd
    for name, fmt in sorted(rd.SIMPLE.items()):
        size, read = rd._simple(fmt)
        if size == t.size:
            probes = [bytearray(range(1, 1 + size)), bytearray(range(0x81, 0x81 + size)), bytearray([0xff] * size)]
            if all(repr(read(p, 0)) == repr(t.read(p, 0)) for p in probes): return fmt
    raise ValueError('alias format of %s' % t.name)


def fixed_count(t):
    # read_fixed(buf, pos, count=count, sub=sub); read_var(buf, pos, sub=sub) (replay_stream.Defs._type)
    return (t.read.__defaults__ or (None,))[0] if t.read.__name__ == 'read_fixed' else None


def definitions_value(defs, registry, vehicle_names, stickers):
    """The page decoder's definitions (web/playback/decoder.js Schema) from the decoder's Defs and Registry, with the
    roster's vehicle names {"nation,type id": "nation:name"} and the damage sticker kinds [[name, size m]]."""
    from . import replay_stream as rd
    types = Types()
    ents = {}
    for name in defs.entities:
        spec = defs.spec(name)
        if spec is None:
            ents[name] = None
            continue
        ents[name] = {'clientProps': [[n, types.ref(t)] for n, t in spec.client_props],
                      'clientMethods': [[n, [[a, types.ref(t)] for a, t in args]] for n, args, _ in spec.client_methods],
                      'props': [[n, types.ref(t), f] for n, (t, f) in spec.props.items()]}
    comps = {}
    for name in registry.dynamic:
        try:
            spec = registry.spec(name)
        except Exception as error:
            comps[name] = {'error': str(error)}
            continue
        if spec is None:
            comps[name] = None
            continue
        comps[name] = {'props': [[n, types.ref(t)] for n, t in spec.props],
                       'methods': [[n, [[a, types.ref(t)] for a, t in args]] for n, args in spec.sorted_methods],
                       'detail': sorted(spec.detail), 'iface': sorted(spec.iface), 'members': spec.members}
    schema = {'client': getattr(defs.client, 'version', None), 'entities': defs.entities, 'entitySpecs': ents,
              'argNames': rd.ARG_NAMES, 'dynamic': registry.dynamic, 'base': registry.BASE_2_4_1_1, 'components': comps,
              'types': types.table, 'arenaUpdate': dict((str(k), v) for k, v in rd.ARENA_UPDATE.items()),
              'packetNames': dict((str(k), v) for k, v in rd.PACKET_NAMES.items())}
    names = dict(('%d,%d' % key, value) for key, value in vehicle_names.items())
    return {'schema': schema, 'vehicleNames': names, 'stickers': [[n, s] for n, s in stickers]}


def sticker_kinds(folder, game, pk=None):
    """[(name, size m)] in the order of damage_stickers.xml: a sticker's index (the low byte of its segment) points into it
    (the trial: 109 of 109). Size = the variant's modelSizes. Read through map_raw's package index (`pk`: one read
    already, else read - or made, the first time - here in one go)."""
    from . import packed_xml
    if pk is None:
        pk = map_raw.Packages(game, os.path.join(raw_root(folder), 'index'), build=False)
        for _ in pk.scan_steps(): pass
    try:
        pkg, entry = pk.find(STICKERS_XML)
        if entry is None: return []
        root = packed_xml.decode(pk.read(pkg, entry))
    finally:
        pk.close()
    out = []
    for c in root:
        v = c.find('variant1')
        out.append((c.tag, float(((v.findtext('modelSizes') if v is not None else None) or '0.2').split()[0])))
    return out


def part_boxes(folder, name):
    """{collision model resource: [lo x, y, z, hi x, y, z]}: the client's own part box (hitTester.bbox) as the replay job
    stored it with this battle's records (CFG/replay/<id>.records.z, statics with 'bounds')."""
    from .replay_run import RECORDS_EXT
    path = os.path.join(folder, 'replay', name + RECORDS_EXT)
    out = {}
    if not os.path.isfile(path): return out
    try:
        with open(path, 'rb') as handle: statics = json.loads(zlib.decompress(handle.read()).decode('ascii')).get('statics')
    except Exception:
        LOG.warning('Playback of %s: the stored part boxes are unreadable', name, exc_info=True)
        return out
    stack = [statics]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            if o.get('bounds') and isinstance(o.get('resource'), (TEXT, str)):
                try: b = [float(x) for x in list(o['bounds'][0]) + list(o['bounds'][1])]
                except (TypeError, ValueError, IndexError): continue
                # a zero box appears on a few turret/gun models among the same real box (the trial, 232 stores)
                if all(b[3 + j] - b[j] > 1e-6 for j in range(3)) and o['resource'] not in out: out[o['resource']] = b
                continue
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
    return out


class Job(object):
    """One battle's playback files (the export thread's 'playback' job, Exporter.run_playback_job). `defs` gives the
    session's entity definitions (replay_defs_steps, replay_defs: the exporter)."""

    def __init__(self, folder, game, name, defs):
        self.folder, self.game, self.name, self.defs = folder, game, name, defs
        self.began = TIMER()
        self.work = 0.0
        self.slices = 0
        self.times = {}
        self.outcome = None

    def lap(self, key, started):
        self.times[key] = self.times.get(key, 0.0) + (TIMER() - started)

    def steps(self):
        try:
            for _ in self.make(): yield
        except Exception as error:
            why = str(error) if isinstance(error, Unplayable) else W_FAILED % ('%s: %s' % (type(error).__name__, error))
            if not isinstance(error, Unplayable): LOG.exception('Playback of %s failed', self.name)
            else: LOG.warning('Playback of %s: %s', self.name, why)
            self.outcome = why
            self.write(data_path(self.folder, self.name), KEY + self.name,
                       collections.OrderedDict([('format', FORMAT), ('error', why), ('id', self.name)]))

    def write(self, path, key, value):
        from .exporter import write_data
        if not os.path.isdir(os.path.dirname(path)): os.makedirs(os.path.dirname(path))
        write_data(path, key, value)

    def head(self):
        """(battle record, first roster record) of the battle's raw record (battles/<id>.jsonl; read only)."""
        path = os.path.join(self.folder, 'battles', self.name + '.jsonl')
        if not os.path.isfile(path): raise Unplayable(W_NO_RECORD)
        battle = roster = None
        with open(path, 'rb') as handle:
            for number, line in enumerate(handle):
                if number >= HEAD_LINES: break
                try: record = json.loads(line.decode('utf-8'))
                except ValueError: continue
                kind = record.get('type')
                if kind == 'battle' and battle is None: battle = record
                elif kind == 'roster' and roster is None: roster = record
                if battle is not None and roster is not None: break
        if battle is None: raise Unplayable(W_NO_RECORD)
        return battle, roster or {}

    def file_item(self):
        """(absolute path, cached item {entry, roster}) of a replay file of the viewer's list (Exporter.replay_file)."""
        maker = getattr(self.defs, 'replay_file', None)
        found = maker(self.name) if maker is not None else None
        if found is None or not os.path.isfile(found[0]): raise Unplayable(W_NO_FILE)
        return found

    def library(self):
        """The replay limit (the exporter's, replay_library.Library), None without one (a bare test stand)."""
        maker = getattr(self.defs, 'replay_library', None)
        return maker() if maker is not None else None

    def source(self):
        """(kind, path) of the battle's source: its older kept stream ('zlib'), the raw copy ('raw'), else its replay under
        the mod's name ('wotreplay'). A battle whose replay the limit removed says so."""
        from .replay_run import STREAM_EXT, RAW_EXT
        kept = os.path.join(self.folder, 'replay', self.name + STREAM_EXT)
        if os.path.isfile(kept): return 'zlib', kept
        raw = os.path.join(self.folder, 'battles', self.name + RAW_EXT)
        if os.path.isfile(raw): return 'raw', raw
        library = self.library()
        replay = library.file_of(self.name) if library is not None else None
        if replay is None:
            state = library.status(self.name) if library is not None else None
            if state == 'removed': raise Unplayable(W_REMOVED % library.limit())
            if state == 'gone': raise Unplayable(W_GONE)
            raise Unplayable(W_NO_STREAM)
        return 'wotreplay', replay

    def drop_sources(self):
        """Every other battle's source file removed (data/playback/*.src.js; their battle files stay): one player page is
        open at a time, a battle it built is in its IndexedDB, and a battle it did not keep gets its source written again
        on its next request (current() wants it). So only the battle asked for last keeps a copy of its replay here."""
        folder = os.path.dirname(source_path(self.folder, self.name))
        mine = os.path.basename(source_path(self.folder, self.name))
        try: names = os.listdir(folder)
        except OSError: return
        for item in names:
            if item.endswith(SOURCE_EXT) and item != mine:
                try: os.remove(os.path.join(folder, item))
                except OSError: LOG.warning('Playback: %s not removed', item, exc_info=True)

    def definitions_steps(self, out):
        """The client's definitions file (data/playback/defs-<crc>.js) into out['name']: made once a session (kept on the
        session's replay_run.Definitions), written when this folder lacks it."""
        started = TIMER()
        for _ in self.defs.replay_defs_steps():
            self.lap('definitions', started)
            yield
            started = TIMER()
        definitions = self.defs.replay_defs()
        made = getattr(definitions, 'playback_defs', None)
        if made is None:
            # the package index first, in steps (made the first time ever: the packages' directories, map_raw)
            self.lap('definitions', started)
            pk = map_raw.Packages(self.game, os.path.join(raw_root(self.folder), 'index'), build=False)
            started = TIMER()
            for _ in pk.scan_steps():
                self.lap('package index', started)
                yield
                started = TIMER()
            self.lap('package index', started)
            started = TIMER()
            value = definitions_value(definitions.defs, definitions.registry, definitions.vehicle_names,
                                      sticker_kinds(self.folder, self.game, pk))
            text = json.dumps(value, sort_keys=True, separators=(',', ':'))
            made = definitions.playback_defs = ('defs-%08x' % (zlib.crc32(text.encode('utf-8')) & 0xffffffff), value)
        self.lap('definitions', started)
        yield
        started = TIMER()
        path = data_path(self.folder, made[0])
        if not os.path.isfile(path): self.write(path, DEFS_KEY + made[0], made[1])
        self.lap('definitions', started)
        out['name'] = made[0]
        out['client'] = (made[1].get('schema') or {}).get('client')

    def make(self):
        started = TIMER()
        if is_file(self.name):
            path, item = self.file_item()
            entry = item.get('entry') or {}
            record = {'mode': {'geometryName': entry.get('map'), 'gameplayName': entry.get('gameplay')},
                      'map': entry.get('mapTitle'), 'startedAt': None, 'playerVehicleId': entry.get('playerVehicleId')}
            roster = {'vehicles': item.get('roster') or []}
            kind = 'wotreplay'
        else:
            record, roster = self.head()
        mode = record.get('mode') or {}
        arena, gameplay = mode.get('geometryName'), mode.get('gameplayName')
        if not arena or not gameplay: raise Unplayable(W_NO_MAP)
        if not is_file(self.name): kind, path = self.source()
        self.lap('read', started)
        yield
        started = TIMER()
        self.drop_sources()
        with open(path, 'rb') as handle: data = handle.read()
        source = collections.OrderedDict([('file', self.name + SOURCE_EXT), ('kind', kind), ('size', len(data)),
                                          ('crc', zlib.crc32(data) & 0xffffffff)])
        self.write(source_path(self.folder, self.name), SOURCE_KEY + self.name, base64.b64encode(data).decode('ascii'))
        del data
        self.lap('source', started)
        yield
        started = TIMER()
        boxes = part_boxes(self.folder, self.name)
        # the client's own box table for the models this battle's records lack (all of them for a replay file)
        table = client_box_table(self.folder, getattr(self.defs, 'version', None))
        for resource, box in table.items():
            if resource not in boxes: boxes[resource] = box
        self.lap('boxes', started)
        yield
        got = {}
        for _ in self.definitions_steps(got): yield
        started = TIMER()
        vehicles = []
        for row in roster.get('vehicles') or ():
            if row.get('id') is None: continue
            vehicles.append({'id': row['id'], 'type': row.get('type'), 'team': row.get('team'),
                             'maxHealth': row.get('maxHealth'), 'player': row.get('player')})
        meta = {'map': arena, 'gameplay': gameplay, 'mapTitle': record.get('map'), 'startedAt': record.get('startedAt'),
                'playerVehicleId': record.get('playerVehicleId'), 'client': got.get('client')}
        # format, id and defs first: current() reads them from the file's first bytes
        value = collections.OrderedDict([
            ('format', FORMAT), ('id', self.name), ('defs', got['name']), ('source', source), ('record', meta),
            ('roster', vehicles), ('boxes', boxes), ('vehicleFiles', vehicle_files(self.folder)),
            ('made', {'seconds': dict((k, round(v, 3)) for k, v in self.times.items())})])
        self.write(data_path(self.folder, self.name), KEY + self.name, value)
        self.lap('write', started)
        self.outcome = 'made'


class MapJob(object):
    """The raw files of one map (map_raw.copy_steps into CFG/mapraw/<arena>/): the export thread's 'mapraw' job, asked for
    by the page when its IndexedDB lacks the map (Exporter.request_map_raw). `report` holds the copy's stage while it runs
    (the page's progress line) and its counts after."""

    def __init__(self, folder, game, arena, held=None, resv=None, whole=False):
        self.folder, self.game, self.arena = folder, game, arena
        self.held, self.resv, self.whole = held, resv, whole
        self.name = arena
        self.began = TIMER()
        self.work = 0.0
        self.slices = 0
        self.times = {}
        self.report = {}
        self.outcome = None
        self.error = None

    def steps(self):
        started = TIMER()
        try:
            for _ in map_raw.copy_steps(self.game, raw_root(self.folder), self.arena, self.report, self.held,
                                            self.resv, self.whole):
                self.lap('map', started)
                yield
                started = TIMER()
            self.lap('map', started)
            self.outcome = 'made'
        except Exception as error:
            LOG.exception('Map raw files of %s not copied', self.arena)
            self.error = W_MAP % ('%s: %s' % (type(error).__name__, error))
            self.outcome = 'failed'

    def lap(self, key, started):
        self.times[key] = self.times.get(key, 0.0) + (TIMER() - started)


class Unplayable(Exception):
    """Why a battle cannot be played (its file says so to the page)."""
