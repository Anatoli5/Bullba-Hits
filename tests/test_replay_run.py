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
            print(cost[0])
            self.assertFalse(os.path.exists(path))
            self.assertTrue(os.path.isfile(e.replay_stream_path(name)))
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

    def test_a_final_file_with_more_than_the_copy(self):
        """The copy holds 60 % of the stream, the mod's own final file all of it: decrypted, checked, used, deleted."""
        arena = '16434853064049700'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        path = self.copy_of(stand, arena, 0.6)
        final = os.path.join(stand.root, 'bullba_hits_battle.wotreplay')
        shutil.copyfile(os.path.join(t.LIVE, KILL_CAM[arena]), final)
        consume(e, stand.message(arena, path, complete=False, final=final, finalOwned=True))
        value = stand.published(arena)
        self.assert_window(value, arena)
        self.assertEqual(value['replay']['stream']['from'], 'final replay file')
        self.assertFalse(value['replay']['stream']['cut'])
        self.assertFalse(os.path.exists(final))
        import zlib
        with open(e.replay_stream_path(stand.names[arena]), 'rb') as stream: kept = zlib.decompress(stream.read())
        self.assertEqual(kept, bytes(final_stream(KILL_CAM[arena], t.LIVE)[1]))

    def test_a_copy_that_reaches_the_end_of_the_fight_needs_no_final_file(self):
        """Backlog 84: the copy holds the packet that ends the fight (arena period 4, rr.fight_end) and the mod's own final
        file the rest: the final file is not read (no decryption), the battle is whole and the final file deleted - and the
        published battle is the one the decrypted final file gives but for the stream's own figures in its replay block.
        A message whose replay source saw no end in the copy ('fightEnd': None) takes the final file as before."""
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
            for case, share, seen in (('end in the copy', (end[0] + 2000.0) / len(stream), [end[0], end[1]]),
                                      ('no end in the copy', 0.6, None),
                                      ('the source saw none', (end[0] + 2000.0) / len(stream), None)):
                del opened[:]
                stand = self.stand(arena)
                e = stand.exporter(KILL_CAM[arena])
                path = stand.stream_file(arena, packet_cut(stream, share))
                final = os.path.join(stand.root, 'bullba_hits_battle.wotreplay')
                shutil.copyfile(os.path.join(t.LIVE, KILL_CAM[arena]), final)
                consume(e, stand.message(arena, path, complete=False, final=final, finalOwned=True, fightEnd=seen))
                value = strip_rev(stand.published(arena))
                self.assert_window(value, arena)
                info = value['replay']['stream']
                self.assertFalse(info['cut'], case)
                self.assertFalse(any(w.startswith('Replay cut off:') for w in value['warnings']), case)
                self.assertFalse(os.path.exists(final), case)
                if case == 'end in the copy':
                    self.assertEqual((opened, info['from'], info['fightEnd']), ([], 'stream copy', round(end[1], 3)))
                else:
                    self.assertEqual((len(opened), info['from']), (1, 'final replay file'), case)
                value['replay'].pop('stream')
                values[case] = value
        finally:
            rr.FinalFile = original
        self.assertEqual(values['end in the copy'], values['no end in the copy'])

    def test_the_lean_decode_gives_the_same_records(self):
        """Backlog 84: the run-time decode leaves out what nothing reads (replay_run.LEAN_TYPES, LEAN_PROPERTIES) - the
        aim packets 0x1a and 0x39 still decoded - and the records, their poses, the event count and the last clock are
        those of the full decoder (checked so on the 33 battles of 11.11 and the 8 local fixtures, 12.11)."""
        from local_armor_inspector import replay_records as rrec
        self.assertFalse({0x1a, 0x39} & set(rr.LEAN_TYPES))
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
                self.assertIn('client_gun_marker', lean[4])
                self.assertFalse({'net_stats', 'camera'} & lean[4])

    def test_a_cut_off_stream_is_used_as_far_as_it_goes(self):
        arena = '16434853064049700'
        stand = self.stand(arena)
        e = stand.exporter(KILL_CAM[arena])
        consume(e, stand.message(arena, self.copy_of(stand, arena, 0.5), complete=False))
        value = stand.published(arena)
        self.assertEqual(value['source'], 'replay')
        self.assertTrue(value['replay']['stream']['cut'])
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
