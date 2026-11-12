# -*- coding: utf-8 -*-
"""The replay path at run time (11.11.2026): the stream the replay source collected becomes the published battle.

The user (docs/PRODUCT.md «Лог боя из реплея, снимки и реконструкция»): every event of a battle comes from its replay, the
in-game snapshots are attached, every hit also gets a scene rebuilt from the replay. replay_source.ReplaySource hands the
export thread ONE message per battle (Writer.put_export('replay', ...), fields in docs/map/mod.md «Replay source»);
Exporter.replay_stream queues it as a 'replay' job, and the job runs Consumption.steps() in slices under the queue's gates
(nothing in a battle, nothing while the page is dragged, the game's share of the time between two slices):

  1. the stream: the mod's copy (battles/<id>.wotstream, raw) - whole when it reaches the end of the fight (fight_end: 22 of
     the 33 battles of 11.11); else, when the message names a final file that holds more, that file decrypted (pure-Python
     Blowfish, 1.8 s for the 2 MB file of 02.11 17:42 under the client's Python 2.7; CHUNK bytes a step) and taken only
     when its stream carries this battle's arena id and starts with the copy;
  2. the decoder's events fed to replay_records.Converter (poses=True, the run-time names) as they are yielded - a list of
     events taken first loses records (an event's value may be the decoder's own object a later packet changes, 11.11);
  3. Exporter.publish_replay_steps; the converted records with their poses, the statics the scenes used and the scenes are
     stored, compressed, in CFG/replay/<id>.records.z, so every later publish of the battle - a restart, the page's request,
     a format change - builds it again from them (Exporter.replay_restore) instead of from the live record alone;
  4. the stream kept compressed (CFG/replay/<id>.stream.z: the source for decoding again and a future playback), the raw
     copy removed once its compressed copy reads back whole, the mod's own final file deleted (finalOwned), the battle
     marked in CFG/replay/index.json - a stream collected and never consumed (the game closed first) is found at the next
     start (Exporter.replay_setup).

A replay that cannot be used (no stream, a stream of another battle or without the battle's start, a decode failure)
leaves the battle published from the live record exactly as before, with a warning in plain words; a stream that may be
cut short is used as far as it goes and the battle says so.

The entity definitions (Definitions) are built once a session: from the client snapshot the exporter already holds
(client_snapshot.ClientSnapshot: every package's files under scripts/, refreshed at setup) - no package is scanned, 0.23 s
under the client's Python 2.7 (measured 11.11) -, else by the decoder's own scan of every package (3.9-5.9 s there).
One code for the client's Python 2.7 and CPython 3.
"""
from __future__ import absolute_import
import array
import base64
import copy
import gc
import json
import logging
import os
import struct
import time
import zipfile
import zlib
import xml.etree.ElementTree as ET

from . import replay_stream as rd
from . import replay_objects as rc

LOG = logging.getLogger('local.armor_inspector')
TIMER = getattr(time, 'perf_counter', None) or time.clock

STORE = 'replay'                 # CFG/replay/: the stored records, the kept streams, the index
INDEX_FILE = 'index.json'
INDEX_FORMAT = 1
STORE_FORMAT = 1                 # of <id>.records.z
RECORDS_EXT = '.records.z'
STREAM_EXT = '.stream.z'
RAW_EXT = '.wotstream'           # replay_source.STREAM_EXT: the raw copy in battles/
CHUNK = 32 * 1024                # bytes of a final file decrypted per step (~33 ms under the client's Python 2.7)
EVENTS_PER_STEP = 512            # decoder events fed per step
COMPRESS_CHUNK = 1 << 20

# The battle's warnings when its replay is not used or is cut short (the user's rule: nothing is lost silently).
LIVE_ONLY = 'so this battle is shown from the in-game record only'
W_NO_STREAM = 'Replay not used: the game left no replay stream for this battle, ' + LIVE_ONLY
W_UNREADABLE = 'Replay not used: its stream could not be read (%s), ' + LIVE_ONLY
W_FOREIGN = 'Replay not used: its stream belongs to another battle (arena %s; this battle is arena %s), ' + LIVE_ONLY
W_NO_START = 'Replay not used: its stream does not hold the start of this battle (%s), ' + LIVE_ONLY
W_CUT = ('Replay cut off: its stream ends %s into the recording and no complete replay file confirmed that it is whole, '
         'so whatever happened after that moment may be missing')
W_RESTORE = 'Replay records of this battle unreadable (%s), ' + LIVE_ONLY


# ---- the end of the fight in the copy ------------------------------------------------------------------------------------
def fight_end(stream, at=None):
    """(offset, clock) of the stream's first packet 0x16 (the arena period the client switched to) whose period is
    AFTERBATTLE (4): the fight is over - or None. `at`: where the replay source saw it (its message's 'fightEnd'), checked
    there instead of walking the packet headers (~0.05 s for a 6 MB stream under the client's Python 2.7).
    Why nothing the page shows comes after it (measured on the 33 battles of 11.11, docs/KNOWLEDGE.md section 18): the
    server ends the round with Avatar.onRoundFinished, updateArena PERIOD 4 and this packet at one clock; after it the
    streams carried positions, chat, the avatar ids, components, battle results and the end packet - no hit, health
    change, crit, tracer or explosion -, and the records converted from the copy alone were those of the whole stream in
    all 33 battles (22 copies held this packet; the other 11 were left before the end and have none at all)."""
    from .replay_source import ARENA_PERIOD, AFTERBATTLE
    unpack, n = struct.unpack_from, len(stream)
    if at is not None:
        off = int(at)
        if (0 <= off and off + 16 <= n and unpack('<II', stream, off) == (4, ARENA_PERIOD)
                and unpack('<I', stream, off + 12)[0] == AFTERBATTLE):
            return off, unpack('<f', stream, off + 8)[0]
        return None
    off = 0
    while off + 12 <= n:
        size, ptype = unpack('<II', stream, off)
        if off + 12 + size > n: break
        if ptype == ARENA_PERIOD and size >= 4 and unpack('<I', stream, off + 12)[0] == AFTERBATTLE:
            return off, unpack('<f', stream, off + 8)[0]
        off += 12 + size
    return None


# ---- the entity definitions, once a session ------------------------------------------------------------------------
def wanted(item):
    """replay_stream.Client's own choice of the files it reads (entity and component defs, entities.xml, list.xml)."""
    return ('/scripts/' in '/' + item and (item.endswith('.def') or item.endswith('.xml')) and
            ('entity_defs' in item or 'component_defs' in item or item.endswith('scripts/entities.xml')
             or ('item_defs/vehicles/' in item and item.endswith('/list.xml'))))


class LazyPackage(object):
    """A package opened only when one of its files is read, once for the session."""

    def __init__(self, path):
        self.path, self.archive = path, None

    def read(self, name):
        if self.archive is None: self.archive = zipfile.ZipFile(self.path)
        return self.archive.read(name)


class SnapshotClient(rd.Client):
    """replay_stream.Client whose file table comes from the client snapshot instead of a scan of every package: the same
    files from the same packages (sorted package names, the first one that has a path wins - Client's rule)."""

    def __init__(self, root, packages):
        self.root = root
        self.files = {}
        for name, path, members in packages:
            package = None
            for item in members:
                if not wanted(item) or item in self.files: continue
                if package is None: package = LazyPackage(path)
                self.files[item] = (package, name)
        self.version = None
        try: self.version = ET.parse(os.path.join(root, 'version.xml')).getroot().findtext('version').strip()
        except Exception: pass


class FixedRegistry(rc.Registry):
    """replay_objects.Registry with its component list given (from the snapshot, or a registry built before): no scan."""

    def __init__(self, client, defs, dynamic):
        self.client, self.defs = client, defs
        self.dynamic = list(dynamic)
        self.base = self.BASE_2_4_1_1
        self._specs = {}


def snapshot_packages(snapshot):
    """[(package name, path, {member: (crc, size)})] of the client's packages, sorted by name, from the snapshot; None when
    there is no snapshot or a package did not read this session (its members are then not known for sure)."""
    if snapshot is None or getattr(snapshot, 'failed', None): return None
    snapshot.files()
    mounts = dict((source, (kind, path)) for source, kind, path in snapshot.mount())
    out = []
    for source, members in snapshot.sources or ():
        kind, path = mounts.get(source, (None, None))
        if kind == 'pkg' and path: out.append((os.path.basename(path), path, members))
    out.sort(key=lambda row: row[0])
    return out or None


def snapshot_components(packages):
    """Registry's component list from the snapshot: the client .pyc names, and scripts/components.xml of the last package
    that has it (Registry reads every package in name order, the last one wins)."""
    classes, holder = set(), None
    for name, path, members in packages:
        for item in members:
            if item.endswith('.pyc') and '/client' in item: classes.add(item.rsplit('/', 1)[-1][:-4])
        if 'scripts/components.xml' in members: holder = path
    if holder is None: raise ValueError('scripts/components.xml is in no package')
    names = []
    for section in rc.packed_xml_decode(zipfile.ZipFile(holder).read('scripts/components.xml')):
        if section.tag == 'DynamicComponents': names = [child.tag for child in section]
    return rc.numbered_components(names, classes)


class Definitions(object):
    """The decoder's Client, Defs and Registry and the roster's vehicle names, built once a session (Exporter.replay_defs).
    `source`: 'client snapshot' or 'package scan'; `seconds`: what building them took (work only, not the pauses between
    stages). `build=False`: nothing built yet - stages() builds them in steps (the replay job's slices, Exporter.
    replay_defs_steps): at once they took 0.21 s under the client's Python 2.7 with the client idle, 0.31 s with it busy,
    the longest indivisible step of the first replay of a session (measured 11.11)."""

    def __init__(self, game, snapshot=None, build=True):
        self.game, self.snapshot = game, snapshot
        self.source = None
        self.seconds = 0.0
        if build:
            for _ in self.stages(): pass

    def stages(self):
        """Build them, yielding between the parts (on the 17:42 stand, a 0.23 s build: package list 0.03 s, client 0.01,
        Defs 0.05, components 0.05, vehicle names 0.09 - a nation's list.xml a step)."""
        started = TIMER()
        packages = None
        try: packages = snapshot_packages(self.snapshot)
        except Exception: LOG.warning('Replay: the client snapshot does not give the definitions; the packages are scanned', exc_info=True)
        if packages:
            try:
                client = SnapshotClient(self.game, packages)
                if 'scripts/entities.xml' not in client.files: raise ValueError('no scripts/entities.xml in the snapshot')
                self.seconds += TIMER() - started
                yield
                started = TIMER()
                defs = rd.Defs(client)
                self.seconds += TIMER() - started
                yield
                started = TIMER()
                registry = FixedRegistry(client, defs, snapshot_components(packages))
                self.client, self.defs, self.registry = client, defs, registry
                self.source = 'client snapshot'
            except Exception:
                LOG.warning('Replay: definitions from the client snapshot failed; the packages are scanned', exc_info=True)
        if self.source is None:
            # The fallback: the decoder's own scan of every package, 3.9-5.9 s in one go (no snapshot this session).
            self.client = rd.Client(self.game)
            self.defs = rd.Defs(self.client)
            self.registry = rc.Registry(self.client, self.defs)
            self.source = 'package scan'
        self.seconds += TIMER() - started
        yield
        names = {}
        started = TIMER()
        for _ in self.client.vehicle_names_steps(names):
            self.seconds += TIMER() - started
            yield
            started = TIMER()
        self.seconds += TIMER() - started
        self.vehicle_names = names


_DONE = object()


# What the run-time path does not decode (replay_stream.Decoder's skip): packets and Vehicle/Avatar properties neither
# replay_records.Converter nor its Tracks read - per type, the events each would have yielded (the stream info counts
# them all the same). 0.13 s of the 17:42 battle (11.11 profile). The aim packets 0x1a (client_gun_marker) and 0x39
# (volatile, the server's gun marker) stay: the aim circles are to be built from them (backlog 82).
LEAN_TYPES = {0x1f:1, 0x26:1, 0x36:0}   # net_stats, camera, tick_marker (no event)
LEAN_PROPERTIES = ('engineMode', 'isStrafing', 'ownVehicleAuxPhysicsData', 'wheelsScroll')


def decode(definitions, stream):
    """(decoder, events) of one stream with the session's registry. replay_stream.Decoder.decode builds a Registry of its own
    (a scan of every package, 3.09 s under the client's Python 2.7) on its first step; that one step runs with
    replay_objects.Registry answering the session's instead, put back right after it (export thread only). What nothing
    reads is not decoded (LEAN_TYPES, LEAN_PROPERTIES)."""
    decoder = rd.Decoder(definitions.defs, skip=LEAN_TYPES, skip_properties=LEAN_PROPERTIES)
    return decoder, _events(decoder, stream, definitions.registry)


def _events(decoder, stream, registry):
    events = decoder.decode(stream)
    original = rc.Registry
    rc.Registry = lambda client, defs: registry
    try:
        first = next(events, _DONE)
    finally:
        rc.Registry = original
    if first is _DONE: return
    yield first
    for event in events:
        yield event


# ---- a final .wotreplay, decrypted in steps ------------------------------------------------------------------------------
_SCHEDULE = []


def merged_table():
    """S0[a] + S1[b] (mod 2^32) at a << 8 | b: Blowfish's F as one lookup fewer and one addition fewer per round - 1.33x
    faster under the client's Python 2.7 (0.259 -> 0.195 s for 256 KB, measured 12.11; unrolling the rounds besides gained
    nothing measurable). 65 536 entries, 2.56 MB there (the values above 2^31 are long objects on Windows), built in 6 ms:
    a final file being decrypted holds it (FinalFile), nothing keeps it after."""
    if not _SCHEDULE: _SCHEDULE.append(rd._blowfish_schedule(rd.REPLAY_KEY))
    S0, S1 = _SCHEDULE[0][1][0], _SCHEDULE[0][1][1]
    table = [0] * 65536
    for a in range(256):
        x, base = S0[a], a << 8
        for b in range(256): table[base | b] = (x + S1[b]) & 0xffffffff
    return table


def decrypt_blocks(data, chain, table=None):
    """(plain bytes, chain) of whole 8-byte blocks: replay_stream.decrypt_replay_stream's own loop (Blowfish-ECB, each
    decrypted block XOR the previous plain block) with its differences for a stream decrypted in steps - the key
    schedule computed once a session (the decoder's function computes it again on every call, ~0.05 s under the client's
    Python 2.7: 32 chunks of a 2 MB file cost 1.7 s more, measured 11.11), the chain carried from the step before and
    S0 + S1 looked up at once (`table`, merged_table(): built here when not given)."""
    if not _SCHEDULE: _SCHEDULE.append(rd._blowfish_schedule(rd.REPLAY_KEY))
    P, (_, _, S2, S3) = _SCHEDULE[0]
    T01 = table if table is not None else merged_table()
    rounds = P[17:1:-1]
    p0, p1 = P[0], P[1]
    n = len(data) // 8
    vals = struct.unpack('>%dI' % (2 * n), data[:8 * n])
    out = [0] * (2 * n)
    pl, pr = chain
    for b in range(n):
        l = vals[2 * b]
        r = vals[2 * b + 1]
        for k in rounds:
            l ^= k
            r ^= ((T01[l >> 16] ^ S2[(l >> 8) & 255]) + S3[l & 255]) & 0xffffffff
            l, r = r, l
        l, r = r, l
        pl ^= l ^ p0
        pr ^= r ^ p1
        out[2 * b] = pl
        out[2 * b + 1] = pr
    return struct.pack('>%dI' % (2 * n), *out), (pl, pr)


class FinalFile(object):
    """A final .wotreplay read in steps: its JSON blocks at once, the stream decrypted CHUNK bytes a step (decrypt_blocks,
    the chain carried from one step to the next), then unpacked (zlib, in C)."""

    def __init__(self, path, stream=True):
        """`stream=False`: the JSON blocks only."""
        with open(path, 'rb') as handle: data = handle.read()
        magic, count = struct.unpack_from('<II', data, 0)
        if magic != rd.REPLAY_MAGIC: raise ValueError('not a .wotreplay')
        offset, self.blocks = 8, []
        for _ in range(count):
            size, = struct.unpack_from('<I', data, offset)
            offset += 4
            self.blocks.append(json.loads(data[offset:offset + size].decode('utf-8')))
            offset += size
        if not stream: return
        if offset + 8 > len(data): raise ValueError('no stream in the replay file')
        self.raw_size, self.packed_size = struct.unpack_from('<II', data, offset)
        self.cipher = data[offset + 8:]
        self.at, self.chain, self.plain = 0, (0, 0), []
        self.table = None

    def step(self):
        """Decrypt the next chunk; True when all is decrypted."""
        if self.at < len(self.cipher):
            if self.table is None: self.table = merged_table()
            chunk = self.cipher[self.at:self.at + CHUNK]
            self.at += CHUNK
            out, self.chain = decrypt_blocks(chunk, self.chain, self.table)
            self.plain.append(out)
        if self.at >= len(self.cipher):
            self.table = None
            return True
        return False

    def stream(self):
        stream = bytearray(zlib.decompress(b''.join(self.plain)[:self.packed_size]))
        if len(stream) != self.raw_size: raise ValueError('stream size %d, the header says %d' % (len(stream), self.raw_size))
        return stream


# ---- the store: records, poses, statics -------------------------------------------------------------------------------
def array_text(values):
    raw = values.tobytes() if hasattr(values, 'tobytes') else values.tostring()
    return base64.b64encode(raw).decode('ascii')


def text_array(code, text):
    out = array.array(code)
    raw = base64.b64decode(text if isinstance(text, bytes) else text.encode('ascii'))
    if hasattr(out, 'frombytes'): out.frombytes(raw)
    else: out.fromstring(raw)
    return out


def poses_json(poses):
    """The in-memory 'poses' record (replay_scene.Tracks.record) as JSON: float32 arrays as base64 of their bytes (the
    same floats back), integer vehicle ids kept as numbers (pairs, not object keys)."""
    if poses is None: return None
    return {'format':poses.get('format'), 'playerVehicleId':poses.get('playerVehicleId'),
            'serverTimeAtStart':poses.get('serverTimeAtStart'),
            'positions':[[vid, array_text(t), array_text(v)] for vid, (t, v) in sorted(poses['positions'].items())],
            'guns':[[vid, array_text(t), [int(c) for c in codes]] for vid, (t, codes) in sorted(poses['guns'].items())],
            'ownYaw':[array_text(poses['ownYaw'][0]), array_text(poses['ownYaw'][1])],
            'ownPitch':[array_text(poses['ownPitch'][0]), array_text(poses['ownPitch'][1])],
            'compact':[[vid, text] for vid, text in sorted(poses['compact'].items())]}


def json_poses(value):
    if value is None: return None
    return {'type':'poses', 'format':value.get('format'), 'playerVehicleId':value.get('playerVehicleId'),
            'serverTimeAtStart':value.get('serverTimeAtStart'),
            'positions':dict((vid, (text_array('f', t), text_array('f', v))) for vid, t, v in value['positions']),
            'guns':dict((vid, (text_array('f', t), array.array('l', codes))) for vid, t, codes in value['guns']),
            'ownYaw':(text_array('f', value['ownYaw'][0]), text_array('f', value['ownYaw'][1])),
            'ownPitch':(text_array('f', value['ownPitch'][0]), text_array('f', value['ownPitch'][1])),
            'compact':dict((vid, text) for vid, text in value['compact'])}


def pack_store(name, records, statics, stream_info, scenes=None):
    """The bytes of <id>.records.z: zlib of one JSON document. `scenes`: the scenes the first build rebuilt
    ({'format': replay_scene.FORMAT, 'report', 'hits': {hit id: block}}) - a later build of the same records takes them
    instead of rebuilding them (0.5 s of the 17:42 battle under the client's Python 2.7), while their format holds."""
    poses = next((r for r in records if r.get('type') == 'poses'), None)
    value = {'format':STORE_FORMAT, 'battle':name, 'records':[r for r in records if r.get('type') != 'poses'],
             'poses':poses_json(poses), 'statics':statics or {}, 'stream':stream_info or {}, 'scenes':scenes}
    return zlib.compress(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('ascii'), 6)


def unpack_store(data):
    """(records with the poses record last, statics, stream info, scenes or None) of <id>.records.z."""
    value = json.loads(zlib.decompress(data).decode('ascii'))
    if value.get('format') != STORE_FORMAT: raise ValueError('stored records of format %r' % value.get('format'))
    records = list(value['records'])
    poses = json_poses(value.get('poses'))
    if poses is not None: records.append(poses)
    return records, value.get('statics') or {}, value.get('stream') or {}, value.get('scenes')


def battle_scenes(battle, report, key='replayScene'):
    """What pack_store keeps of the scenes a build rebuilt."""
    from .replay_scene import FORMAT
    hits = dict((str(h.get('id')), h[key]) for h in battle.get('hits') or () if isinstance(h, dict) and key in h)
    return {'format':FORMAT, 'report':report.get('scenes'), 'hits':hits}


class StoredSource(object):
    """replay_scene's source with the statics the battle's first build used (kept in its store): a later build gives the
    same scenes whatever the client has built since (the part's client box is the client's only once it built that
    collision). What is not stored, and every model, comes from `inner` (Exporter.scene_source). `known` collects the
    statics given out, for the store."""

    def __init__(self, inner, stored=None):
        self.inner = inner
        self.known = dict(stored or {})

    def statics(self, compact):
        if compact not in self.known: self.known[compact] = self.inner.statics(compact)
        value = self.known[compact]
        # Statics stored before the wheels and prefabs were part of them (12.11): those two are added from the client,
        # the rest (the part boxes the first build had) stays as stored.
        if 'wheels' not in value and 'extrasError' not in value and hasattr(self.inner, 'compact_extras'):
            try: value.update(self.inner.compact_extras(compact))
            except Exception as exc: value['extrasError'] = str(exc) or type(exc).__name__
        return json_copy(value)

    def model(self, resource):
        return self.inner.model(resource)


def json_copy(value):
    from .exporter import json_copy as copier
    return copier(value)


# ---- small file helpers -----------------------------------------------------------------------------------------------
def replace(temp, path):
    try:
        os.rename(temp, path)
    except OSError:
        if os.path.exists(path): os.remove(path)
        os.rename(temp, path)


def write_bytes(path, data):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    temp = path + '.tmp'
    with open(temp, 'wb') as stream: stream.write(data)
    replace(temp, path)


def clock_text(seconds):
    try: seconds = int(float(seconds))
    except (TypeError, ValueError): return 'an unknown time'
    return '%d:%02d' % (seconds // 60, seconds % 60)


def same_start(stream, copy_head):
    return bytes(stream[:len(copy_head)]) == bytes(copy_head)


# ---- one battle's consumption --------------------------------------------------------------------------------------------
class Unusable(Exception):
    """The replay cannot be used; the message is the battle's warning."""


class Consumption(object):
    """One 'replay' job's work: steps() yields between units of work; Exporter.run_replay_job runs it in slices."""

    def __init__(self, exporter, message):
        self.exporter = exporter
        self.message = dict(message or {})
        self.name = str(self.message.get('battle') or '')
        self.arena = str(self.message.get('arenaId') or self.name.split('-', 1)[0])
        self.began = TIMER()
        self.work = 0.0
        self.slices = 0
        self.times = {}
        self.outcome = None
        # What the job cost in the game (slice_done, job): the longest slice, the part of the job it was spent on, whether
        # a full collection of the garbage collector ran in it, and in how many slices one ran.
        self.longest, self.longest_part, self.longest_full = 0.0, None, False
        self.full = 0

    def slice_done(self, seconds, before, counts):
        """One slice of the job ended (Exporter.run_replay_job): `seconds` its work, `before` a copy of `times` and `counts`
        gc.get_count() taken at its start. A full collection (generation 2) ran in it when the generation-2 count went down,
        or stayed 0 while the generation-1 count went down (a generation-1 collection alone would have raised it): at least
        one - two in one slice count once. No clock read here: the caller's two are the measurement."""
        self.work += seconds
        self.slices += 1
        after = gc.get_count()
        full = after[2] < counts[2] or (after[2] == 0 == counts[2] and after[1] < counts[1])
        if full: self.full += 1
        if seconds > self.longest:
            grew = [(self.times.get(k, 0.0) - before.get(k, 0.0), k) for k in self.times]
            self.longest, self.longest_part, self.longest_full = seconds, max(grew)[1] if grew else None, full

    def job(self, now):
        """The 'job' block of the battle's index entry and its log line (Exporter.run_replay_job): what the job cost."""
        return {'slices':self.slices, 'work':round(self.work, 3), 'wall':round(now - self.began, 2),
                'longest':round(self.longest, 3), 'longestPart':self.longest_part, 'longestFull':self.longest_full,
                'fullCollections':self.full, 'gcEnabled':gc.isenabled(), 'gcThreshold':list(gc.get_threshold())}

    def lap(self, key, started):
        self.times[key] = self.times.get(key, 0.0) + (TIMER() - started)

    def raw_path(self):
        return os.path.join(self.exporter.folder, 'battles', self.name + RAW_EXT)

    def steps(self):
        exporter, message, name = self.exporter, self.message, self.name
        stream, source, header, final_used, notes = None, None, None, False, []
        copy_path = message.get('stream')
        if not copy_path or not os.path.isfile(copy_path):
            copy_path = self.raw_path() if os.path.isfile(self.raw_path()) else None
        kept = exporter.replay_stream_path(name)
        started = TIMER()
        if copy_path is not None:
            with open(copy_path, 'rb') as handle: stream = bytearray(handle.read())
            source = 'stream copy'
        elif os.path.isfile(kept):
            # Consumed once already, the raw copy gone (a crash after its compressed copy was written): the kept stream.
            with open(kept, 'rb') as handle: stream = bytearray(zlib.decompress(handle.read()))
            source = 'kept stream'
        # The copy that reaches the end of the fight is the whole battle: the final file's tail (the last 1.5-2 s before
        # the avatar left, never in the temp file the copy is taken from) holds nothing the page shows (fight_end), so it
        # is not decrypted (1.9 s of the 17:42 battle). A copy without the end (the player left before it, or the copy was
        # cut) takes the final file as before. The replay source saw the end while copying ('fightEnd'); a message without
        # that field (found at start, an older message) has the copy walked here.
        ended = None
        if stream is not None and source == 'stream copy':
            if 'fightEnd' not in message: ended = fight_end(stream)
            elif message.get('fightEnd'): ended = fight_end(stream, message['fightEnd'][0])
        self.lap('read', started)
        yield
        # The final file holds the tail only it has (the last seconds before the recording stopped): taken when its stream
        # is this battle's (its arena id) and starts with the copy.
        final = message.get('final')
        final_stream = None
        if ended is not None:
            # Its plain JSON header only (the client version, map and mode names, the start time - no decryption): taken
            # unless its battle-results block names another arena (a file written only at the stop has none yet).
            if final and os.path.isfile(final):
                started = TIMER()
                try:
                    blocks = FinalFile(final, stream=False).blocks
                    results = blocks[1] if len(blocks) > 1 else None
                    other = (results[0].get('arenaUniqueID') if isinstance(results, list) and results
                             and isinstance(results[0], dict) else None)
                    if other is not None and str(other) != self.arena: raise ValueError('its results are arena %s' % other)
                    header = blocks[0] if blocks else None
                except Exception as error:
                    LOG.warning('Replay: the header of the final file %s of %s not used (%s)', final, name, error)
                self.lap('final', started)
            if final: LOG.info('Replay: the copy of %s reaches the end of the fight (%.1f s into the recording); its final '
                               'file is not decrypted', name, ended[1])
        elif final and os.path.isfile(final):
            started = TIMER()
            try:
                reader = FinalFile(final)
                self.lap('final', started)
                yield
                while True:
                    started = TIMER()
                    done = reader.step()
                    self.lap('decrypt', started)
                    if done: break
                    yield
                started = TIMER()
                final_stream = reader.stream()
                arena = arena_check(final_stream, self.arena)
                if arena is not True: raise ValueError('its stream does not carry this battle\'s arena id')
                if stream is not None and not same_start(final_stream, stream[:4096]):
                    raise ValueError('its stream does not start with the copy')
                header = reader.blocks[0] if reader.blocks else None
                stream, source, final_used = final_stream, 'final replay file', True
                self.lap('decrypt', started)
            except Exception as error:
                final_stream = None
                LOG.warning('Replay: final file %s of %s not used (%s); the stream copy is', final, name, error)
            yield
        elif final:
            LOG.info('Replay: final file %s of %s is gone; the stream copy is used', final, name)
        info = {'from':source}
        if ended is not None: info['fightEnd'] = round(ended[1], 3)
        try:
            if stream is None or not len(stream): raise Unusable(W_NO_STREAM)
            # The definitions, once a session, built in steps (the first replay of a session: 0.21-0.31 s at once).
            started = TIMER()
            for _ in exporter.replay_defs_steps():
                self.lap('definitions', started)
                yield
                started = TIMER()
            definitions = exporter.replay_defs()
            self.lap('definitions', started)
            yield
            started = TIMER()
            converter = exporter.replay_converter(name, header, definitions)
            decoder, events = decode(definitions, stream)
            records, count = [], 0
            try:
                for event in events:
                    records.extend(converter.feed(event))
                    count += 1
                    if count % EVENTS_PER_STEP == 0:
                        self.lap('decode', started)
                        yield
                        started = TIMER()
                records.extend(converter.finish())
            except Unusable:
                raise
            except ValueError as error:
                if 'arena' in str(error): raise Unusable(W_NO_START % 'no arena packet')
                raise Unusable(W_UNREADABLE % error)
            except Exception as error:
                raise Unusable(W_UNREADABLE % ('%s: %s' % (type(error).__name__, error)))
            self.lap('decode', started)
            # Whole when the final file gave it, or the copy reaches the end of the fight, or the replay source saw the copy
            # equal to a whole final file and it ends on a packet; anything else may lack the battle's last moments (the
            # copy is taken every 2 s).
            partial = getattr(decoder, 'partial_bytes', 0) or 0
            # The events and the last clock as if every packet were decoded (the skipped ones counted by the decoder).
            last_clock = decoder.last_clock
            info.update({'bytes':len(stream), 'events':count + decoder.skipped, 'lastClock':last_clock,
                         'partialBytes':partial})
            whole = final_used or ended is not None or (message.get('complete') is True and not partial)
            info['cut'] = not whole
            if not whole: notes.append(W_CUT % clock_text(last_clock))
            got = records[0].get('arenaId') if records and records[0].get('type') == 'battle' else None
            if got is None: raise Unusable(W_NO_START % 'no battle header')
            if str(got) != self.arena: raise Unusable(W_FOREIGN % (got, self.arena))
            if not any(r.get('type') == 'roster' for r in records): raise Unusable(W_NO_START % 'no vehicle list')
            yield
            published = {}
            started = TIMER()
            for _ in exporter.publish_replay_steps(name, records, None, info, notes, True, published):
                self.lap('publish', started)
                yield
                started = TIMER()
            self.lap('publish', started)
            self.outcome = ('cut' if info['cut'] else 'used', notes, published.get('report'))
        except Unusable as unusable:
            self.outcome = ('failed', [str(unusable)], None)
            LOG.warning('Replay of %s not used: %s', name, unusable)
        yield
        # The stream kept, compressed; the raw copy removed once that reads back whole; the mod's own final file deleted.
        started = TIMER()
        kept_bytes = None
        if stream is not None and len(stream) and source != 'kept stream':
            try:
                packer, packed = zlib.compressobj(6), []
                for at in range(0, len(stream), COMPRESS_CHUNK):
                    packed.append(packer.compress(bytes(stream[at:at + COMPRESS_CHUNK])))
                    self.lap('keep', started)
                    yield
                    started = TIMER()
                packed.append(packer.flush())
                packed = b''.join(packed)
                write_bytes(kept, packed)
                with open(kept, 'rb') as handle:
                    if zlib.decompress(handle.read()) != bytes(stream): raise ValueError('the kept stream does not read back')
                kept_bytes = len(packed)
                if copy_path is not None and os.path.isfile(copy_path):
                    os.remove(copy_path)
            except Exception:
                LOG.exception('Replay: the stream of %s was not kept compressed; its raw copy stays', name)
        elif source == 'kept stream':
            kept_bytes = os.path.getsize(kept)
        # (also when it was not read: the copy reached the end of the fight - the replay source removes it the same way
        # when the copy is complete)
        if final and message.get('finalOwned') and (final_used or ended is not None) and os.path.isfile(final):
            try: os.remove(final)
            except OSError: LOG.warning('Replay: the mod\'s own final file %s could not be deleted', final)
        self.lap('keep', started)
        status, notes, report = self.outcome
        exporter.replay_consumed(name, status, notes, message, info, kept_bytes)
        if status == 'failed': exporter.replay_live_again(name)
        self.report = report


def arena_check(stream, arena):
    from .replay_source import arena_in_stream
    return arena_in_stream(stream, arena)
