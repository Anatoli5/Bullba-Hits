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
            consume(e, stand.message(arena, path))
            first = stand.published(arena)
            self.assert_window(first, arena)
            name = stand.names[arena]
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
        rr.Definitions = lambda game, snapshot: built.append(1) or definitions()
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
        # No final file and no message: whether the copy is whole is not known - it says it may be cut off.
        self.assertTrue(any(w.startswith('Replay cut off:') for w in value['warnings']))
        self.assertEqual(stand2.exporter(None).replay_setup(), 0)


if __name__ == '__main__':
    unittest.main()
