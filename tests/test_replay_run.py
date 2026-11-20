# -*- coding: utf-8 -*-
"""The replay path at run time (mod/local_armor_inspector/replay_run.py, Exporter.replay_stream): the replay source's
message of a battle -> the published battle, kept across a restart.

    python -m pytest tests/test_replay_run.py -q     the checks (CPython 3)

Synthetic checks run on a clean clone (the chunked decryption, the poses' store, the live file unchanged by the recorder's
new box). The fixture checks need the local fixtures of the replay path (tests/fixtures-local/replay-parity-2026-11-10/:
the kill-cam battles 15.10 and 20.10, replay and live record; the names table of tests/py27/replay_battle.py and the statics
table of tests/py27/replay_scene.py) and the installed client (definitions, part models); they skip without them. The
helpers run under the client's Python 2.7 too: tests/py27/replay_run.py imports them for the times there.
"""
from __future__ import print_function
import copy
import json
import logging
import os
import random
import shutil
import struct
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
import test_replay_records as t  # noqa: E402
import test_replay_battle as T  # noqa: E402
import test_replay_scene as S  # noqa: E402
from local_armor_inspector import replay_run as rr  # noqa: E402
from local_armor_inspector import replay_stream as rd  # noqa: E402

GAME = S.GAME
KILL_CAM = dict((arena, name) for name, arena in t.KILL_CAM)
EXPECTED_WINDOW = {'16434853064049700':9, '30838317949392403':1}
_CACHE = {}
TIMER = getattr(time, 'perf_counter', None) or time.clock


# ---- shared with tests/py27/replay_run.py -----------------------------------------------------------------------------------
def definitions():
    """One Definitions for the whole run, from a snapshot of the installed client taken into a temporary folder (the
    exporter's own ClientSnapshot): what the game builds once a session."""
    if 'defs' not in _CACHE:
        from local_armor_inspector.client_snapshot import ClientSnapshot
        folder = tempfile.mkdtemp(prefix='bullba-replay-snapshot-')
        with open(os.path.join(GAME, 'version.xml'), 'rb') as stream: text = stream.read().decode('utf-8', 'replace')
        snapshot = ClientSnapshot(GAME, folder, text)
        started = TIMER()
        snapshot.refresh()
        snapshot.files()
        took = TIMER() - started
        started = TIMER()
        _CACHE['defs'] = rr.Definitions(GAME, snapshot)
        _CACHE['defs'].snapshot_seconds = took
        _CACHE['defs'].built_in = TIMER() - started
        _CACHE['snapshot folder'] = folder
        _CACHE['snapshot'] = snapshot
    return _CACHE['defs']


def final_stream(name, folder):
    key = ('stream', name)
    if key not in _CACHE: _CACHE[key] = rd.read_replay(os.path.join(folder, name))
    return _CACHE[key]


def packet_cut(stream, share):
    """The stream up to the last whole packet before `share` of its bytes."""
    off, limit = 0, int(len(stream) * share)
    while off + 12 <= len(stream):
        size = struct.unpack_from('<I', stream, off)[0]
        if off + 12 + size > limit: break
        off += 12 + size
    return bytes(stream[:off])


class Stand(object):
    """A mod folder in a temporary directory with one battle's live record (battles/<id>.jsonl); exporters over it as the
    game makes them, with the parts the offline stand cannot give from the game given from the tables: the run-time names
    (the table tests/py27/replay_battle.py wrote on the client's stand), the vehicles' statics (tests/py27/replay_scene.py),
    the part models (extracted from the installed client), the definitions (from a snapshot of the installed client)."""

    def __init__(self, arenas):
        self.root = tempfile.mkdtemp(prefix='bullba-replay-run-')
        os.makedirs(os.path.join(self.root, 'battles'))
        self.names = {}
        for arena in arenas:
            source = t.live_path(arena)
            name = os.path.basename(source)[:-6]
            shutil.copyfile(source, os.path.join(self.root, 'battles', name + '.jsonl'))
            self.names[arena] = name
        self.built = []
        self.current_file = None

    def exporter(self, replay_file=None):
        e = T.exporter(self.root)
        e.replay_defs_value = definitions()
        table = S.statics_table()
        e.scene_source = lambda version: S.make_source(table)
        e.replay_names = lambda: T.table_names(self.current_file) if self.current_file else rr_names()
        self.current_file = replay_file
        self.built.append(e)
        return e

    def stream_file(self, arena, data):
        path = os.path.join(self.root, 'battles', self.names[arena] + rr.RAW_EXT)
        with open(path, 'wb') as stream: stream.write(data)
        return path

    def message(self, arena, path, **extra):
        name = self.names[arena]
        size = os.path.getsize(path) if path else 0
        message = {'schema':1, 'battle':name, 'arenaId':arena, 'stream':os.path.abspath(path) if path else None,
                   'streamBytes':size, 'complete':True, 'end':'battle', 'final':None, 'finalOwned':False}
        message.update(extra)
        return message

    def published(self, arena):
        from local_armor_inspector.exporter import read_data_file
        return read_data_file(os.path.join(self.root, 'data', 'battles', self.names[arena] + '.js'))

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


class Lines(logging.Handler):
    """A logging handler that keeps the formatted messages (the job's cost line)."""

    def __init__(self):
        logging.Handler.__init__(self, logging.INFO)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def rr_names():
    from local_armor_inspector.replay_records import Names
    return Names()


def run_jobs(e, limit=200000):
    """The export thread's turns until the queue is empty (no pace between two: the test does not wait)."""
    turns = 0
    while e.jobs and turns < limit:
        e.last_job = 0
        e.run_job()
        turns += 1
    return turns


def consume(e, message):
    started = TIMER()
    e.replay_stream(message)
    run_jobs(e)
    return TIMER() - started


def strip_rev(value):
    return json.loads(json.dumps(value))


def fixtures_ready():
    return (t.kill_cam_ready() and T.names_table() is not None and S.statics_table() is not None
            and os.path.isdir(os.path.join(GAME, 'res', 'packages')))


# ---- synthetic ---------------------------------------------------------------------------------------------------------------
class SyntheticTests(unittest.TestCase):
    def test_chunked_decryption_equals_the_decoders(self):
        rng = random.Random(7)
        data = bytes(bytearray(rng.randrange(256) for _ in range(rr.CHUNK * 2 + 8 * 37 + 5)))
        whole = rd.decrypt_replay_stream(data)
        parts, chain, at = [], (0, 0), 0
        while at < len(data):
            out, chain = rr.decrypt_blocks(data[at:at + rr.CHUNK], chain)
            parts.append(out)
            at += rr.CHUNK
        self.assertEqual(b''.join(parts), whole)

    def test_the_end_of_the_fight_in_a_stream(self):
        """fight_end (backlog 84): the first packet 0x16 whose period is AFTERBATTLE (4) - by a walk of the packet headers,
        or checked where the replay source saw it; a period-3 packet, a packet cut short or a wrong offset is not it. The
        replay source's StreamCopy notes the same packet while it copies, whatever chunks the bytes come in."""
        from local_armor_inspector import replay_source as rs
        def packet(ptype, clock, payload): return struct.pack('<IIf', len(payload), ptype, clock) + payload
        head = (packet(0x18, 0.0, struct.pack('<I', 5) + b'abcde') + packet(0x16, 30.5, struct.pack('<I', 3))
                + packet(0x0a, 31.0, b'x' * 49))
        end = packet(0x16, 300.25, struct.pack('<I', 4))
        stream = head + end + packet(0x0a, 301.0, b'y' * 49) + packet(0x16, 302.0, struct.pack('<I', 4))
        self.assertEqual(rr.fight_end(stream), (len(head), 300.25))
        self.assertEqual(rr.fight_end(bytearray(stream), len(head)), (len(head), 300.25))
        self.assertIsNone(rr.fight_end(stream, len(head) - 12))
        self.assertIsNone(rr.fight_end(stream, len(stream)))
        self.assertIsNone(rr.fight_end(head))
        self.assertIsNone(rr.fight_end(head + end[:14]))
        folder = tempfile.mkdtemp()
        try:
            for step in (1, 7, 16, len(stream)):
                copied = rs.StreamCopy(folder, 'n', '1', None, 0.0)
                for at in range(0, len(stream), step): copied.take(bytearray(stream[at:at + step]))
                self.assertEqual(copied.fight_end, (len(head), 300.25), step)
            copied = rs.StreamCopy(folder, 'n', '1', None, 0.0)
            copied.take(bytearray(head + end[:14]))
            self.assertIsNone(copied.fight_end)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_a_failed_copy_is_handed_over_and_distrusted(self):
        """The copying itself failing (12.11): an error while writing the copy, or a short read of a source that did not
        shrink, is noted on the copy, nothing more is taken, the hand-over message says it ('copyFailure', not complete),
        and replay_run.distrust reads the final file for it - even for a copy holding the end of the fight. A source the
        game truncated is the normal end, no failure."""
        from local_armor_inspector import replay_source as rs
        def packet(ptype, clock, payload): return struct.pack('<IIf', len(payload), ptype, clock) + payload
        data = (packet(0x18, 0.0, b'abcd') + packet(0x0a, 1.0, b'x' * 49) + packet(0x16, 2.0, struct.pack('<I', 4))
                + packet(0x0a, 3.0, b'y' * 49))
        root = tempfile.mkdtemp()
        folder = os.path.join(root, 'battles')     # the source's state file goes beside it, into root
        os.makedirs(folder)
        try:
            source = os.path.join(folder, 'temp.wotreplay')
            with open(source, 'wb') as f: f.write(data)
            # a write that fails: the copy's path is a folder
            broken = rs.StreamCopy(folder, 'broken', '1', source, 0.0)
            os.makedirs(broken.path)
            self.assertEqual(broken.pull(), 0)
            self.assertTrue(broken.failure and str(broken.failure).startswith(('IOError', 'PermissionError', 'IsADirectoryError', 'OSError')), broken.failure)
            self.assertIsNone(broken.pull())
            # a short read: the source says it holds more than it gives, and still does after
            short = rs.StreamCopy(folder, 'short', '1', source, 0.0)
            real = os.path.getsize
            original = rs.os.path.getsize
            rs.os.path.getsize = lambda path: real(path) + 100 if path == source else real(path)
            try: self.assertEqual(short.pull(), len(data))
            finally: rs.os.path.getsize = original
            self.assertEqual(short.failure, 'a short read: %d of %d bytes of the source' % (len(data), len(data) + 100))
            self.assertEqual(short.fight_end[1], 2.0)
            # the game truncating the source at its stop: no failure
            fine = rs.StreamCopy(folder, 'fine', '1', source, 0.0)
            sizes = [len(data) + 100, 0]
            rs.os.path.getsize = lambda path: sizes.pop(0) if path == source and sizes else real(path)
            try: fine.pull()
            finally: rs.os.path.getsize = original
            self.assertIsNone(fine.failure)
            # the hand-over and distrust
            sent = []
            source_obj = rs.ReplaySource(folder, 'sess', lambda kind, message: sent.append(message), replay_dir=folder,
                                         threaded=False)
            source_obj.handover(short, {'at':0.0, 'reason':'battle'}, None, None)
            message = sent[-1]
            self.assertEqual((message['copyFailure'], message['complete']), (short.failure, False))
            with open(short.path, 'rb') as f: copy = bytearray(f.read())
            shape = rr.copy_shape(copy)
            self.assertIsNotNone(shape[2])          # the copy holds the end of the fight
            self.assertEqual(rr.distrust(message, copy, shape), 'the copying of the stream failed (%s)' % short.failure)
            self.assertIsNone(rr.distrust(dict(message, copyFailure=None), copy, shape))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_the_light_copy_is_deepcopys(self):
        """exporter.json_copy (backlog 84) in place of copy.deepcopy on a hit's record and a vehicle's statics: an equal
        value sharing no list or dict with the original; what is not JSON-shaped (a set) still goes through deepcopy."""
        from local_armor_inspector.exporter import json_copy
        rng = random.Random(5)
        def value(depth):
            kind = rng.randrange(7 if depth < 4 else 4)
            if kind == 0: return rng.randrange(-5, 5)
            if kind == 1: return rng.random()
            if kind == 2: return rng.choice(['a', u'\u00e9', None, True, False])
            if kind == 3: return 'x%d' % rng.randrange(9)
            if kind == 4: return [value(depth + 1) for _ in range(rng.randrange(4))]
            if kind == 5: return dict(('k%d' % k, value(depth + 1)) for k in range(rng.randrange(4)))
            return tuple(value(depth + 1) for _ in range(rng.randrange(3)))
        for _ in range(200):
            original = {'points':[value(1) for _ in range(3)], 'target':value(1), 'tags':set([1, 2])}
            got = json_copy(original)
            self.assertEqual(got, copy.deepcopy(original))
            seen = []
            def containers(v):
                if isinstance(v, (list, dict, set)): seen.append(id(v))
                for item in (v.values() if isinstance(v, dict) else v if isinstance(v, (list, tuple, set)) else ()):
                    containers(item)
            containers(original)
            mine = set(seen)
            del seen[:]
            containers(got)
            self.assertFalse(mine & set(seen))

    def test_poses_survive_the_store(self):
        import array
        poses = {'type':'poses', 'format':1, 'playerVehicleId':7, 'serverTimeAtStart':123.5,
                 'positions':{7:(array.array('f', [0.1, 0.2]), array.array('f', [1, 2, 3, 4, 5, 6] * 2))},
                 'guns':{8:(array.array('f', [0.5]), array.array('l', [123456]))},
                 'ownYaw':(array.array('f', [0.1]), array.array('f', [0.7])),
                 'ownPitch':(array.array('f'), array.array('f')), 'compact':{7:'AAE='}}
        records = [{'type':'battle', 'arenaId':'1'}, {'type':'hit', 'id':'1', 'gameTime':1.5}, poses]
        back, statics, info, scenes = rr.unpack_store(rr.pack_store('1-a', records, {'AAE=':{'parts':[]}}, {'from':'x'}))
        self.assertIsNone(scenes)
        self.assertEqual(back[:2], records[:2])
        got = back[2]
        self.assertEqual(sorted(got['positions']), [7])
        self.assertEqual(list(got['positions'][7][1]), list(poses['positions'][7][1]))
        self.assertEqual(list(got['guns'][8][1]), [123456])
        self.assertEqual(got['compact'], {7:'AAE='})
        self.assertEqual((statics, info), ({'AAE=':{'parts':[]}}, {'from':'x'}))

    def test_the_job_counts_its_slices_and_full_collections(self):
        """Consumption.slice_done / job (what the job cost in the game): the longest slice and its part, a full garbage
        collection inside a slice counted, the totals consistent."""
        import gc
        work = rr.Consumption(None, {'battle':'1-a'})
        work.times = {'decode':0.05}
        work.slice_done(0.05, {}, gc.get_count())
        junk = [[k] for k in range(100000)]           # counts above zero, so a collection shows as a drop
        before, counts = dict(work.times), gc.get_count()
        work.times['publish'] = 0.12
        gc.collect()
        work.slice_done(0.12, before, counts)
        del junk
        job = work.job(work.began + 1.0)
        self.assertEqual((job['slices'], job['longestPart'], job['longestFull'], job['fullCollections']),
                         (2, 'publish', True, 1))
        self.assertAlmostEqual(job['work'], 0.17)
        self.assertLessEqual(job['longest'], job['work'])
        self.assertEqual(job['gcEnabled'], gc.isenabled())
        self.assertEqual(job['gcThreshold'], list(gc.get_threshold()))
        # No probe given (an old caller): no probe figures, nothing estimated.
        self.assertEqual((job['probeMs'], job['contendedSlices'], job['ownWorkEstimate']), (None, 0, None))

    def test_the_probe_figures_separate_waiting_from_work(self):
        """BACKLOG 84, the in-game measurement: the probe's min / median / max, the contended slices (probe above 3x the
        fastest) and their wall, and the own-work ESTIMATE = each slice's wall scaled by fastest / its probe. Numbers of the
        12.11 case's shape: decode slices of 2-7 s that were waiting, publish slices of 0.1 s that were work."""
        pairs = [(0.10, 0.0006), (0.11, 0.0006), (0.10, 0.0007), (3.0, 0.006), (7.5, 0.0030)]
        figures = rr.probe_figures(pairs)
        self.assertEqual(figures['probeMs'], [0.6, 0.7, 6.0])
        self.assertEqual((figures['contendedSlices'], figures['contendedWall']), (2, 10.5))
        # 0.1 + 0.11 + 0.1 * 6/7 + 3.0 * 0.1 + 7.5 * 0.2
        self.assertAlmostEqual(figures['ownWorkEstimate'], 0.1 + 0.11 + 0.1 * 6 / 7.0 + 0.3 + 1.5, places=3)
        self.assertEqual(rr.probe_figures([])['probeMs'], None)
        # An even count: the median is the mean of the middle two.
        self.assertEqual(rr.probe_figures([(0.1, 0.001), (0.1, 0.002)])['probeMs'], [1.0, 1.5, 2.0])

    def test_the_probe_is_short_and_counted_per_slice(self):
        """replay_run.probe: a fixed body, well under a millisecond's order on this machine's Python 3 (the game's 2.7 takes
        ~0.6 ms: tests/py27); Consumption keeps one (wall, probe) pair a slice."""
        import gc
        seconds = rr.probe()
        self.assertTrue(0 < seconds < 0.05, seconds)
        work = rr.Consumption(None, {'battle':'1-a'})
        work.slice_done(0.05, {}, gc.get_count(), seconds)
        work.slice_done(0.07, {}, gc.get_count(), seconds * 4)
        job = work.job(work.began + 1.0)
        self.assertEqual(job['contendedSlices'], 1)
        self.assertAlmostEqual(job['ownWorkEstimate'], 0.05 + 0.07 / 4, delta=0.001)

    def test_the_first_slice_is_timed_against_the_hangar_line(self):
        """The cost line's moment (BACKLOG 84): the first slice after the replay source's hangar line of the return from
        the battle; unknown when that line is older than the battle's end (the job began before it came)."""
        from local_armor_inspector.exporter import Exporter

        class Source(object):
            hangar_at = 1000.0

        class Recorder(object):
            battle_left_at = 990.0
            replay = Source()
        root = tempfile.mkdtemp()
        try:
            e = Exporter(root, root, 'v\n', os.path.join(root, 'none.wotmod'))
            e.recorder = Recorder()
            work = rr.Consumption(None, {'battle':'1-a'})
            work.first_at = 1004.5
            self.assertEqual(e.replay_moments(work)['afterHangarLine'], 4.5)
            work.first_at = 998.0
            self.assertEqual(e.replay_moments(work)['afterHangarLine'], -2.0)
            Recorder.battle_left_at = 1001.0          # the line is the previous return's
            self.assertIsNone(e.replay_moments(work)['afterHangarLine'])
            self.assertEqual(Exporter.replay_moments_text({'afterHangarLine':4.5}), '+4.5 s after the hangar line')
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_the_page_prioritises_while_a_replay_job_is_queued(self):
        """The user's case of 12.11 13:12:26 ('HTML export command failed'): the first battle on 1.07 had its replay job
        queued between two slices when the mods-list button opened the page on the hangar vehicle (page_waits ->
        'prioritise'); Exporter.prioritise read a model's payload from the replay job's dict and raised KeyError 0, so the
        page's vehicle was not lifted. The message is that battle's, as its index entry holds it."""
        from local_armor_inspector.exporter import Exporter, JOB_PAGE
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, 'battles'))
            e = Exporter(root, root, 'v\n', os.path.join(root, 'none.wotmod'))
            message = {'arenaChecked':True, 'arenaId':'2307565181224747078', 'battle':'2307565181224747078-3f3e98ea825e',
                       'complete':False, 'copyFailure':None, 'end':'battle', 'fightEnd':None, 'final':None,
                       'finalOwned':False, 'finalStreamBytes':5215893, 'lastClock':294.32000732421875, 'packets':118317,
                       'partialBytes':50, 'recordingOwned':False, 'schema':1, 'stream':None, 'streamBytes':5206016,
                       'temp':'foreign (shorter)'}
            e.replay_stream(message)
            e.request_vehicle_export({'vehicleType':'germany:G187_Taschenratte', 'source':'battle'})
            self.assertEqual(sorted(job[2] for job in e.jobs), ['replay', 'vehicle'])
            self.assertEqual(e.prioritise(['germany:G187_Taschenratte']), 1)
            self.assertEqual([job[2] for job in e.jobs if job[0] == JOB_PAGE], ['vehicle'])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_the_static_part_box_is_not_published(self):
        from local_armor_inspector.exporter import Exporter
        root = tempfile.mkdtemp()
        try:
            e = Exporter(root, root, 'v\n', os.path.join(root, 'none.wotmod'))
            box = [[0, 0, 0], [1, 1, 1]]
            raw = {'id':'1', 'target':{'type':'x', 'parts':[{'id':0}, {'id':1}, {'id':5, 'prefab':'p'}]},
                   'points':[{'part':1, 'status':'resolved', 'partBounds':box},
                             {'part':0, 'status':'unresolved', 'partBounds':box},
                             {'part':5, 'status':'resolved', 'partBounds':box},
                             {'part':-2, 'status':'resolved', 'partBounds':box},
                             {'part':3, 'status':'unsupported-part', 'partBounds':box}]}
            hit = e.prepare_hit(raw, 0, {'id':'1-a', 'clientVersion':'v\n'})
            self.assertEqual([('partBounds' in p) for p in hit['points']], [False, False, True, True, True])
            self.assertIn('partBounds', raw['points'][0])   # the raw record keeps it for the scene from the replay
        finally:
            shutil.rmtree(root, ignore_errors=True)


# ---- the fixtures ---------------------------------------------------------------------------------------------------------------
@unittest.skipUnless(fixtures_ready(), 'the kill-cam fixtures, the names or statics tables or the client are absent')
class Paced(rr.Consumption):
    """A replay job of `n` steps of ~10 ms each (decode), no stream: the pacing tests run the real run_job/run_replay_job
    around it. `starts` counts how often its steps began - a job started anew would show 2."""
    n = 30
    step = 0.01
    starts = []

    def steps(self):
        Paced.starts.append(self.name)
        for _ in range(self.n):
            started = rr.TIMER()
            while rr.TIMER() - started < Paced.step: pass
            self.lap('decode', started)
            yield
        self.outcome = ('used', [], None)


class GameRecorder(object):
    """The Recorder's floats the export thread reads (mod_local_armor_inspector.Recorder), written here as the game thread
    would: in_battle, battle_left_at, hangar_wait_until / hangar_loaded_at / hangar_signal, page_loading_until."""
    def __init__(self):
        self.in_battle, self.battle_left_at, self.busy_until = False, None, 0.0
        self.hangar_wait_until, self.hangar_loaded_at, self.hangar_signal, self.page_loading_until = 0.0, None, True, 0.0
        self.replay = None

    def leave_battle(self, fallback):
        self.in_battle, self.battle_left_at = False, time.time()
        self.hangar_wait_until = time.time() + fallback

    def hangar_loaded(self, settle=0.0):
        self.hangar_loaded_at = time.time()
        self.hangar_wait_until = time.time() + settle


class PacingTests(unittest.TestCase):
    """BACKLOG 84, step 2: the replay job starts after the hangar is loaded (IHangarSpace.onSpaceCreate), or by the
    fallback when that signal never comes; it runs no slice while the page loads; a battle begun meanwhile loses nothing.
    The 12.11 case: the job's slices overlapped the return to the hangar (2.0-7.5 s each, mostly waiting)."""

    def setUp(self):
        from local_armor_inspector import exporter as ex
        self.ex = ex
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'battles'))
        self.keep = rr.Consumption
        rr.Consumption = Paced
        Paced.starts = []
        self.e = ex.Exporter(self.root, self.root, 'v\n', os.path.join(self.root, 'none.wotmod'))
        self.game = self.e.recorder = GameRecorder()

    def tearDown(self):
        rr.Consumption = self.keep
        shutil.rmtree(self.root, ignore_errors=True)

    def turn(self):
        """One turn of the export loop: the rest after the last job counted as passed."""
        self.e.last_job = 0.0
        return self.e.run_job()

    def queue(self, arena):
        name = '%s-3f3e98ea825e' % arena
        self.assertTrue(self.e.replay_stream({'battle':name, 'arenaId':str(arena), 'end':'battle'}))
        return name

    def finished(self, name):
        return 'job' in (self.e.replay_state().get(name) or {})

    def test_it_starts_after_the_hangar_is_loaded(self):
        self.game.leave_battle(fallback=60.0)
        name = self.queue(2307565181224747078)
        for _ in range(5): self.assertFalse(self.turn())
        self.assertEqual(Paced.starts, [])
        self.game.hangar_loaded()
        while self.turn() and not self.finished(name): pass
        self.assertEqual(Paced.starts, [name])
        job = self.e.replay_state()[name]['job']
        self.assertIsNotNone(job['afterHangarLoaded'])
        self.assertTrue(0 <= job['afterHangarLoaded'] < 5, job)

    def test_it_starts_by_the_fallback_when_the_signal_never_comes(self):
        self.game.leave_battle(fallback=0.3)
        name = self.queue(2307565181224747078)
        self.assertFalse(self.turn())
        self.assertEqual(Paced.starts, [])
        time.sleep(0.35)
        while self.turn() and not self.finished(name): pass
        self.assertTrue(self.finished(name))
        job = self.e.replay_state()[name]['job']
        self.assertIsNone(job['afterHangarLoaded'])
        self.assertIn('the hangar\'s loaded signal did not come', self.e.replay_moments_text(dict(job, afterHangarLine=0.5)))

    def test_it_runs_no_slice_while_the_page_loads(self):
        name = self.queue(2307565181224747078)
        self.assertTrue(self.turn())
        work = self.e.replay_work
        slices = work.slices
        self.game.page_loading_until = time.time() + 60.0     # the window opened
        for _ in range(5): self.assertFalse(self.turn())
        self.assertEqual(work.slices, slices)
        self.game.page_loading_until = time.time() - 0.01     # its load end and the settle passed
        while self.turn() and not self.finished(name): pass
        self.assertTrue(self.finished(name))
        self.assertEqual(Paced.starts, [name])                # one job, not started anew

    def test_a_slice_ends_when_the_page_starts_loading(self):
        """A slice in progress stops at its next step when the page opens (the gate inside the slice, as for a battle)."""
        name = self.queue(2307565181224747078)
        game = self.game
        steps = Paced.steps

        def opening(self_):
            gen = steps(self_)
            yield next(gen)
            game.page_loading_until = time.time() + 60.0
            for step in gen: yield step
        Paced.steps = opening
        try:
            self.assertTrue(self.turn())
            self.assertEqual(self.e.replay_work.slices, 1)
            self.assertLessEqual(self.e.replay_work.times['decode'], 0.05)   # two steps of ~10 ms, not BATTLE_SLICE's ten
        finally:
            Paced.steps = steps

    def test_nothing_is_lost_when_the_next_battle_begins(self):
        """The job half done, the player goes into the next battle: no slice in it; that battle's replay is queued behind;
        back in the hangar (loaded), the first job goes on from where it was, then the second runs."""
        first = self.queue(2307565181224747078)
        for _ in range(3): self.assertTrue(self.turn())
        work = self.e.replay_work
        done = work.slices
        self.game.in_battle = True
        second = self.queue(2307565812584953553)
        for _ in range(5): self.assertFalse(self.turn())
        self.assertEqual(work.slices, done)
        self.game.leave_battle(fallback=60.0)
        self.assertFalse(self.turn())
        self.game.hangar_loaded()
        while not (self.finished(first) and self.finished(second)):
            self.assertTrue(self.turn())
        self.assertEqual(Paced.starts, [first, second])
        self.assertGreater(self.e.replay_state()[first]['job']['slices'], done)

    def test_the_rest_after_a_waiting_slice_is_its_work_share(self):
        """A slice whose probe ran at a quarter of the job's best speed: the rest after it is a quarter of its wall, never
        under one slice's (BATTLE_SLICE); a slice at full speed rests as long as it took (SWEEP_SHARE)."""
        self.queue(2307565181224747078)
        self.assertTrue(self.turn())
        full = self.e.job_rest
        self.assertGreater(full, 0.05)
        self.e.replay_work.probes.append((0.1, 1e-6))          # a faster probe than any real one: this slice runs slow
        self.assertTrue(self.turn())
        self.assertLess(self.e.replay_speed, 0.01)
        # The slice took ~0.1 s: its rest is one slice's at least, not its wall scaled to ~0.
        self.assertTrue(0.05 < self.e.job_rest <= self.ex.BATTLE_SLICE + 1e-9, self.e.job_rest)
        # A slice of 0.4 s (one long step) that ran slow: one slice's rest (0.1 s), not 0.4 s.
        Paced.step = 0.4
        try:
            self.e.replay_work.probes.append((0.1, 1e-6))
            self.assertTrue(self.turn())
        finally:
            Paced.step = 0.01
        self.assertAlmostEqual(self.e.job_rest, self.ex.BATTLE_SLICE, delta=1e-6)


class RunTimeTests(unittest.TestCase):
    def setUp(self):
        self.stands = []

    def tearDown(self):
        for stand in self.stands: stand.close()

    def stand(self, *arenas):
        stand = Stand(arenas)
        self.stands.append(stand)
        return stand

    def copy_of(self, stand, arena, share=1.0):
        _, stream = final_stream(KILL_CAM[arena], t.LIVE)
        return stand.stream_file(arena, bytes(stream) if share >= 1.0 else packet_cut(stream, share))

    def assert_window(self, value, arena):
        """The user's case: the death camera's hits published with their rebuilt scene, the HP check without a gap."""
        window = [h for h in value['hits'] if str(h.get('id', '')).startswith('r')]
        self.assertEqual(len(window), EXPECTED_WINDOW[arena], arena)
        self.assertTrue(all(isinstance(h.get('replayScene'), dict) for h in window), arena)
        check = value['damageCheck']
        self.assertEqual((check['missing'], check['surplus'], check['mismatched']), (0, 0, 0), arena)
        self.assertEqual(value['source'], 'replay')

    def test_end_to_end_the_death_camera_and_a_restart(self):
        """The message of each kill-cam battle -> replay_stream -> the window's hits with their scenes, no HP missing; the
        stream kept compressed, the raw copy gone; a new exporter over the same folder (a restart) publishes it the same
        - from the store, under the page's request too."""
        stand = self.stand(*sorted(KILL_CAM))
        for arena in sorted(KILL_CAM):
            e = stand.exporter(KILL_CAM[arena])
            path = self.copy_of(stand, arena)
            seen = Lines()
            log = logging.getLogger('local.armor_inspector')
            log.addHandler(seen)
            level = log.level
            log.setLevel(logging.INFO)
            try: consume(e, stand.message(arena, path))
            finally:
                log.removeHandler(seen)
                log.setLevel(level)
            first = stand.published(arena)
            self.assert_window(first, arena)
            name = stand.names[arena]
            # What the job cost: one log line and the same figures in the battle's index entry, consistent.
            cost = [l for l in seen.lines if l.startswith('Replay of %s, its cost in the game: ' % name)]
            self.assertEqual(len(cost), 1, seen.lines)
            job = e.replay_state()[name]['job']
            self.assertGreater(job['slices'], 0)
            self.assertGreater(job['longest'], 0)
            self.assertLessEqual(job['longest'], job['work'] + 0.001)
            self.assertLessEqual(job['work'], job['wall'] + 0.01)
            self.assertIn(job['longestPart'], ('read', 'final', 'decrypt', 'definitions', 'decode', 'publish', 'keep'))
            self.assertLessEqual(job['fullCollections'], job['slices'])
            self.assertIn('%d slices, %.2f s of work, the longest slice %.3f s (%s' % (job['slices'], job['work'],
                          job['longest'], job['longestPart']), cost[0])
            # The probe of every slice (BACKLOG 84): min <= median <= max, the estimate never above the slices' wall.
            low, middle, high = job['probeMs']
            self.assertTrue(0 < low <= middle <= high, job['probeMs'])
            self.assertLessEqual(job['contendedSlices'], job['slices'])
            self.assertLessEqual(job['ownWorkEstimate'], job['work'] + 0.001)
            self.assertIn('own work ESTIMATED %.2f s' % job['ownWorkEstimate'], cost[0])
            self.assertIsNone(job['afterHangarLine'])     # no recorder here: not timed
            self.assertIn('not timed against the hangar line', cost[0])
            print(cost[0])
            # 20.11 (the one store of replays): the raw copy is transient and no stream.z is kept; the records are.
            self.assertFalse(os.path.exists(path))
            self.assertFalse(os.path.exists(e.replay_stream_path(name)))
            self.assertTrue(os.path.isfile(e.replay_records_path(name)))
            self.assertEqual(e.replay_state()[name]['status'], 'used')
            self.assertTrue(e.published[name].get('replay'))
            e.write_published()
            # A restart: a new exporter, nothing in memory; a model arriving republishes it (drain_republish's path).
            again = stand.exporter(None)
            again.saved_battles()
            started = TIMER()
            again.republish_saved(name)
            took = TIMER() - started
            self.assertEqual(strip_rev(stand.published(arena)), strip_rev(first), arena)
            # A format change: the battle is stale, the page asks for it, it goes the replay way again.
            later = stand.exporter(None)
            later.stamp = 'd999'
            later.saved_battles()
            self.assertIn(name, later.stale)
            self.assertTrue(later.request_battle(name))
            run_jobs(later)
            self.assertEqual(strip_rev(stand.published(arena)), strip_rev(first), arena)
            print('%s: republished after a restart in %.2f s' % (name, took))

    def test_the_definitions_are_built_in_steps(self):
        """The first replay of a session builds the definitions in stages, a pause between them (Exporter.
        replay_defs_steps; at once they were the longest step of the job, 0.21-0.31 s under the client's Python 2.7):
        the same definitions as at once, in at least five steps, kept by the exporter only once whole."""
        whole = definitions()
        stand = self.stand(sorted(KILL_CAM)[0])
        e = stand.exporter(None)
        e.replay_defs_value = None
        e.client = lambda: _CACHE['snapshot']
        e.game = GAME
        steps = 0
        for _ in e.replay_defs_steps():
            steps += 1
            self.assertIsNone(e.replay_defs_value)
        built = e.replay_defs_value
        self.assertGreaterEqual(steps, 5)
        self.assertEqual(built.source, 'client snapshot')
        self.assertEqual(built.vehicle_names, whole.vehicle_names)
        self.assertEqual(sorted(built.client.files), sorted(whole.client.files))
        self.assertEqual(list(built.registry.dynamic), list(whole.registry.dynamic))
        self.assertIs(e.replay_defs(), built)
        self.assertEqual(list(e.replay_defs_steps()), [])

    def test_the_first_battle_of_a_session_finds_the_definitions_built(self):
        """The user's case of 12.11 13:12 (the first battle on 1.07, the first of its session): its replay job built the
        entity definitions right after the battle, while the game loaded the hangar - 6.82 s of the export thread's clock,
        one step of 6.145 s. Setup now queues them (replay_defs_prepare) and the hangar builds them in slices before the
        battle: the first battle's job spends nothing on them, and their build goes in steps."""
        definitions()
        arena = sorted(KILL_CAM)[0]
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        e.replay_defs_value = None
        e.client = lambda: _CACHE['snapshot']
        e.game = GAME
        seen = Lines()
        log = logging.getLogger('local.armor_inspector')
        log.addHandler(seen)
        level = log.level
        log.setLevel(logging.INFO)
        try:
            e.replay_defs_prepare()                      # setup
            self.assertEqual([job[2] for job in e.jobs], ['definitions'])
            run_jobs(e)                                  # the hangar before the battle
            self.assertIsNotNone(e.replay_defs_value)
            built = [l for l in seen.lines if l.startswith('Replay: entity definitions from the client snapshot in ')]
            self.assertEqual(len(built), 1, seen.lines)
            # Its steps (a clock, so not asserted under the check's parallel load): logged for the game's next battle.
            self.assertGreaterEqual(int(built[0].split(' of work, ', 1)[1].split(' ')[0]), 5, built[0])
            print(built[0])
            consume(e, stand.message(arena, self.copy_of(stand, arena)))
        finally:
            log.removeHandler(seen)
            log.setLevel(level)
        used = [l for l in seen.lines if l.startswith('Replay of %s: used in ' % stand.names[arena])]
        self.assertEqual(len(used), 1, seen.lines)
        self.assertIn('definitions 0.00 s', used[0])
        self.assertEqual(len([l for l in seen.lines if 'entity definitions' in l]), 1, seen.lines)
        self.assertNotEqual(e.replay_state()[stand.names[arena]]['job']['longestPart'], 'definitions')

    def test_a_final_file_with_more_than_the_copy(self):
        """The copy holds 60 % of the stream and cannot be trusted as the battle (backlog 84: no orderly end - the crash
        path -, or a copy on disk shorter than the source copied), the mod's own final file all of it: decrypted, checked,
        used, deleted."""
        arena = '16434853064049700'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        path = self.copy_of(stand, arena, 0.6)
        final = os.path.join(stand.root, 'bullba_hits_battle.wotreplay')
        shutil.copyfile(os.path.join(t.LIVE, KILL_CAM[arena]), final)
        consume(e, stand.message(arena, path, complete=False, final=final, finalOwned=True, end='restart'))
        value = stand.published(arena)
        self.assert_window(value, arena)
        self.assertEqual(value['replay']['stream']['from'], 'final replay file')
        self.assertFalse(value['replay']['stream']['cut'])
        self.assertFalse(os.path.exists(final))
        # 20.11: no stream.z kept and the raw copy removed; the records stored from the final file's whole stream.
        self.assertFalse(os.path.exists(e.replay_stream_path(stand.names[arena])))
        self.assertFalse(os.path.exists(path))
        self.assertTrue(os.path.isfile(e.replay_records_path(stand.names[arena])))
        self.assertEqual(value['replay']['stream']['bytes'], len(final_stream(KILL_CAM[arena], t.LIVE)[1]))
        # The other reasons distrust() can see, each with the final file read for it.
        _, whole = final_stream(KILL_CAM[arena], t.LIVE)
        copy = bytearray(packet_cut(whole, 0.6))
        shape = rr.copy_shape(copy)
        base = {'end':'battle', 'temp':'foreign (shorter)', 'streamBytes':len(copy), 'packets':shape[0],
                'partialBytes':shape[1]}
        self.assertIsNone(rr.distrust(base, copy, shape))
        for change, expected in (({'end':'next battle'}, 'no orderly end'), ({'temp':'foreign (other recording)'}, 'the temp'),
                                 ({'streamBytes':len(copy) + 4096}, 'the copy on disk is shorter'),
                                 ({'packets':shape[0] + 3}, 'the copy\'s packets are not')):
            self.assertTrue(rr.distrust(dict(base, **change), copy, shape).startswith(expected), change)
        broken = copy + struct.pack('<IIf', 10 ** 6, 7, 1.0) + b'x' * (rr.BROKEN_TAIL + 10)
        self.assertTrue(rr.distrust(dict(base, streamBytes=len(broken), packets=None), broken, rr.copy_shape(broken))
                        .startswith('the copy\'s packets break'))
        self.assertEqual(rr.distrust(base, bytearray(), rr.copy_shape(bytearray())), 'no stream copy')
        ended = bytearray(packet_cut(whole, 0.999))
        self.assertIsNone(rr.distrust(dict(base, end='restart'), ended, rr.copy_shape(ended)))

    def test_a_copy_that_reaches_the_end_of_the_fight_needs_no_final_file(self):
        """Backlog 84: the copy holds the packet that ends the fight (arena period 4, rr.fight_end) and the mod's own final
        file the rest: the final file is not read (no decryption), the battle is whole and the final file deleted - and the
        published battle is the one the decrypted final file gives but for the stream's own figures in its replay block.
        A player who left before the end: the copy is the battle up to his exit, the final file's tail not read either.
        Only a copy that cannot be trusted (here: no orderly end, the crash path) has the final file decrypted."""
        arena = '16434853064049700'
        _, stream = final_stream(KILL_CAM[arena], t.LIVE)
        end = rr.fight_end(stream)
        self.assertIsNotNone(end)
        opened = []
        original = rr.FinalFile
        def counted(path, stream=True):
            if stream: opened.append(path)      # decrypted (the header alone is read without decryption)
            return original(path, stream)
        values = {}
        rr.FinalFile = counted
        try:
            before_end = (end[0] - 2000.0) / len(stream)
            for case, share, extra in (('end in the copy', (end[0] + 2000.0) / len(stream), {}),
                                       ('left before the end', before_end, {}),
                                       ('no orderly end', before_end, {'end':'restart'}),
                                       ('the final file', 0.6, {'end':'restart'})):
                del opened[:]
                stand = self.stand(arena)
                e = stand.exporter(KILL_CAM[arena])
                data = packet_cut(stream, share)
                path = stand.stream_file(arena, data)
                final = os.path.join(stand.root, 'bullba_hits_battle.wotreplay')
                shutil.copyfile(os.path.join(t.LIVE, KILL_CAM[arena]), final)
                consume(e, stand.message(arena, path, complete=False, final=final, finalOwned=True,
                                         finalStreamBytes=len(stream), **extra))
                value = strip_rev(stand.published(arena))
                self.assert_window(value, arena)
                info = value['replay']['stream']
                self.assertFalse(info['cut'], case)
                self.assertFalse(any(w.startswith('Replay cut off:') for w in value['warnings']), case)
                self.assertFalse(os.path.exists(final), case)
                if case == 'end in the copy':
                    self.assertEqual((opened, info['from'], info['fightEnd'], info['tail']),
                                     ([], 'stream copy', round(end[1], 3), 'fight ended in the copy'))
                elif case == 'left before the end':
                    self.assertEqual((opened, info['from'], info['tail']), ([], 'stream copy',
                                     'left before the end, tail not read (%d bytes)' % (len(stream) - len(data))))
                else:
                    self.assertEqual((len(opened), info['from'], info['tail']),
                                     (1, 'final replay file', 'final file read: no orderly end of the battle (restart)'), case)
                value['replay'].pop('stream')
                values[case] = value
        finally:
            rr.FinalFile = original
        self.assertEqual(values['end in the copy'], values['the final file'])
        self.assertEqual(values['no orderly end'], values['the final file'])

    def test_the_lean_decode_gives_the_same_records(self):
        """Backlog 84: the run-time decode leaves out what nothing reads (replay_run.LEAN_TYPES, LEAN_PROPERTIES) - the
        aim packets 0x1a, 0x39 and the ping 0x1f still decoded (backlog 82) - and the records, their poses, the event count and the last clock are
        those of the full decoder (checked so on the 33 battles of 11.11 and the 8 local fixtures, 12.11)."""
        from local_armor_inspector import replay_records as rrec
        self.assertFalse({0x1a, 0x39, 0x1f} & set(rr.LEAN_TYPES))
        defs = definitions()
        def run(stream, lean):
            decoder = rd.Decoder(defs.defs, skip=rr.LEAN_TYPES if lean else None,
                                 skip_properties=rr.LEAN_PROPERTIES if lean else ())
            converter = rrec.Converter(session='x', vehicle_names=defs.vehicle_names, poses=True)
            out, count, last, kinds = [], 0, None, set()
            for event in rr._events(decoder, stream, defs.registry):
                out.extend(converter.feed(event))
                count += 1
                last = event.get('t', last)
                kinds.add(event.get('ev'))
            out.extend(converter.finish())
            poses = out.pop()
            shape = dict((k, sorted((vid, list(a), list(b)) for vid, (a, b) in poses[k].items())) for k in ('positions', 'guns'))
            if lean: count, last = count + decoder.skipped, decoder.last_clock
            return out, shape, count, last, kinds
        for arena in sorted(KILL_CAM):
            _, stream = final_stream(KILL_CAM[arena], t.LIVE)
            for data in (stream, packet_cut(stream, 0.7)):
                full, lean = run(data, False), run(data, True)
                self.assertEqual(full[:4], lean[:4], arena)
                self.assertTrue({'client_gun_marker', 'net_stats'} <= lean[4])
                self.assertFalse({'camera'} & lean[4])

    def test_a_cut_off_stream_is_used_as_far_as_it_goes(self):
        """A copy that cannot be trusted as the battle (backlog 84: here no orderly end) and no final file: used as far as it
        goes, said cut off. (A copy of a battle left before its end with an orderly end is the battle: not cut.)"""
        arena = '16434853064049700'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        consume(e, stand.message(arena, self.copy_of(stand, arena, 0.5), complete=False, end='restart'))
        value = stand.published(arena)
        self.assertEqual(value['source'], 'replay')
        self.assertTrue(value['replay']['stream']['cut'])
        self.assertEqual(value['replay']['stream']['tail'], 'final file not given: no orderly end of the battle (restart)')
        self.assertTrue(any(w.startswith('Replay cut off:') for w in value['warnings']), value['warnings'])
        self.assertEqual(e.replay_state()[stand.names[arena]]['status'], 'cut')

    def live_value(self, arena):
        stand = self.stand(arena)
        e = stand.exporter(None)
        e.publishing_final = True
        e.republish_saved(stand.names[arena])
        return stand.published(arena)

    def assert_live_with(self, stand, arena, prefix):
        value = stand.published(arena)
        live = self.live_value(arena)
        self.assertNotEqual(value.get('source'), 'replay')
        notes = [w for w in value['warnings'] if w not in live['warnings']]
        self.assertEqual(len(notes), 1, value['warnings'])
        self.assertTrue(notes[0].startswith(prefix), notes)
        self.assertEqual(dict(value, warnings=None), dict(live, warnings=None))
        return notes[0]

    def test_a_foreign_stream_leaves_the_live_battle_with_its_warning(self):
        arena, other = '16434853064049700', '30838317949392403'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[other])
        _, stream = final_stream(KILL_CAM[other], t.LIVE)
        path = stand.stream_file(arena, bytes(stream))
        consume(e, stand.message(arena, path))
        note = self.assert_live_with(stand, arena, 'Replay not used: its stream belongs to another battle')
        self.assertEqual(e.replay_state()[stand.names[arena]]['status'], 'failed')
        print(note)

    def test_a_stream_that_does_not_decode_leaves_the_live_battle(self):
        arena = '30838317949392403'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        rng = random.Random(3)
        path = stand.stream_file(arena, bytes(bytearray(rng.randrange(256) for _ in range(5000))))
        consume(e, stand.message(arena, path))
        print(self.assert_live_with(stand, arena, 'Replay not used: its stream does not hold the start of this battle'))
        # A decoder that fails inside: the same, with the error named.
        stand2 = self.stand(arena)
        e2 = stand2.exporter(KILL_CAM[arena])
        path = self.copy_of(stand2, arena)
        original = rr.decode
        def broken(definitions, stream):
            decoder, events = original(definitions, stream)
            def failing():
                for k, event in enumerate(events):
                    if k == 5000: raise RuntimeError('a packet the decoder cannot read')
                    yield event
            return decoder, failing()
        rr.decode = broken
        try: consume(e2, stand2.message(arena, path))
        finally: rr.decode = original
        print(self.assert_live_with(stand2, arena, 'Replay not used: its stream could not be read'))

    def test_two_battles_in_a_row_and_the_definitions_once(self):
        stand = self.stand(*sorted(KILL_CAM))
        e = stand.exporter(None)
        e.replay_defs_value = None
        built = []
        original = rr.Definitions
        def counted(game, snapshot, build=True):
            # The session's definitions, built already: counted, their stages (Exporter.replay_defs_steps) nothing to do.
            built.append(1)
            ready = copy.copy(definitions())
            ready.stages = lambda: iter(())
            return ready
        rr.Definitions = counted
        try:
            for arena in sorted(KILL_CAM):
                e.replay_stream(stand.message(arena, self.copy_of(stand, arena)))
            # Both queued before either ran (the second battle's message came while the first waited).
            self.assertEqual(len(e.jobs), 2)
            while e.jobs:
                # Each battle's names are its own table (the stand's ClientNames answers, per replay file).
                work = e.replay_work
                replays = sorted((j[0], j[1], j[3]['battle']) for j in e.jobs if j[2] == 'replay')
                battle = work.name if work is not None else replays[0][2] if replays else None
                if battle: stand.current_file = KILL_CAM[[a for a in KILL_CAM if stand.names[a] == battle][0]]
                e.last_job = 0
                e.run_job()
        finally:
            rr.Definitions = original
        self.assertEqual(len(built), 1)
        for arena in sorted(KILL_CAM): self.assert_window(stand.published(arena), arena)

    def test_a_stream_never_consumed_is_found_at_the_next_start(self):
        arena = '30838317949392403'
        # (a) handed over, the game closed before its job ran: pending in the index.
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        e.replay_stream(stand.message(arena, self.copy_of(stand, arena)))
        again = stand.exporter(KILL_CAM[arena])
        self.assertEqual(again.replay_setup(), 1)
        run_jobs(again)
        self.assert_window(stand.published(arena), arena)
        # (b) the message itself was lost: a raw copy the index does not know.
        stand2 = self.stand(arena)
        self.copy_of(stand2, arena)
        e2 = stand2.exporter(KILL_CAM[arena])
        self.assertEqual(e2.replay_setup(), 1)
        run_jobs(e2)
        value = stand2.published(arena)
        self.assertEqual(value['source'], 'replay')
        # No final file and no message: the copy is walked for the end of the fight (backlog 84) - it holds it, so it is
        # whole.
        self.assertFalse(value['replay']['stream']['cut'])
        self.assertFalse(any(w.startswith('Replay cut off:') for w in value['warnings']))
        self.assertEqual(stand2.exporter(None).replay_setup(), 0)
        # (c) the same with a copy that stops before the end of the fight: whether it is whole is not known - it says it
        # may be cut off.
        stand3 = self.stand(arena)
        self.copy_of(stand3, arena, 0.5)
        e3 = stand3.exporter(KILL_CAM[arena])
        self.assertEqual(e3.replay_setup(), 1)
        run_jobs(e3)
        self.assertTrue(any(w.startswith('Replay cut off:') for w in stand3.published(arena)['warnings']))


if __name__ == '__main__':
    unittest.main()
