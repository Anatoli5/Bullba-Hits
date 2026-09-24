"""Batch 1 "data safety" of the 24.09 audit: the exporter's prune, a battle file without its header, and the one
recording gate. Temp folders only; no game, no game files.

    python -m pytest tests/test_exporter_safety.py
The same scenarios under the client's own python27.dll: tests/py27/exporter_safety.py through tests/py27/run27.py
(skipped here when the client or work/game-python27 is missing).
"""
import json
import logging
import os
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
import importlib.util
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector import exporter as ex
from local_armor_inspector.crit_log import CritLog
from local_armor_inspector.telemetry import ShotTelemetry, recording

RESOURCE = 'vehicles/german/G1_Test/collision_client/Hull.model'
OLD = 'old client\n'


def header(battle_id, version='version\n'):
    return {'schema': 1, 'type': 'battle', 'id': battle_id, 'startedAt': 1, 'map': 'Map', 'clientVersion': version}


def hit(number, resource=RESOURCE):
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming',
            'target': {'name': 'T', 'type': 'german:G1_Test',
                       'parts': [{'id': 1, 'name': 'hull', 'resource': resource, 'armor': {'1': 100}}]},
            'attacker': {'name': 'A', 'parts': []}, 'points': []}


def lines(*rows):
    return ''.join(json.dumps(row) + '\n' for row in rows).encode('utf-8')


class Quiet(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = []
        handler = logging.Handler()
        handler.emit = lambda record: self.logs.append(record)
        logger = logging.getLogger('local.armor_inspector')
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        self.old_propagate = logger.propagate
        logger.propagate = False
        self.addCleanup(setattr, logger, 'propagate', self.old_propagate)

    def warnings(self, text):
        return [r for r in self.logs if r.levelno == logging.WARNING and text in r.getMessage()]


class PruneFromCompleteSet(Quiet):
    """EXP-02 / DATA-02: prune() never runs on an incomplete reference set."""

    def setUp(self):
        super().setUp()
        self.game = Path(self.temp.name) / 'game'
        self.folder = self.game / 'mods/configs/local.armor_inspector'
        (self.folder / 'battles').mkdir(parents=True)
        self.archive = self.game / 'test.wotmod'
        with zipfile.ZipFile(self.archive, 'w') as z:
            for asset in ex.ASSETS:
                z.writestr('res/armor_inspector_viewer/' + asset, b'')
        (self.folder / 'battles/10-old.jsonl').write_bytes(lines(header('10-old', OLD), hit(1)))
        self.model = self.folder / 'data/models' / (ex.model_key(RESOURCE, OLD) + '.js')
        self.model.parent.mkdir(parents=True)
        self.model.write_text('ArmorInspectorData.receive(["model:x",{}]);\n')
        self.orphan = self.model.parent / 'orphan.js'
        self.orphan.write_text('ArmorInspectorData.receive(["model:y",{}]);\n')

    def exporter(self):
        return ex.Exporter(str(self.game), str(self.folder), 'new client\n', str(self.archive))

    def test_locked_battle_keeps_every_model(self):
        real = ex.read_battle

        def locked(path, *args, **kwargs):
            if path.endswith('10-old.jsonl'): raise IOError('file is locked by another process')
            return real(path, *args, **kwargs)

        with patch.object(ex, 'read_battle', side_effect=locked):
            self.exporter().setup()
        self.assertTrue(self.model.exists(), 'the only copy of an old-client model was deleted')
        self.assertTrue(self.orphan.exists(), 'nothing is pruned from an incomplete set')
        self.assertEqual(len(self.warnings('Unused models kept')), 1)
        # The next start reads everything: the old model is referenced and stays, the orphan goes.
        second = self.exporter()
        second.setup()
        self.assertTrue(self.model.exists())
        self.assertFalse(self.orphan.exists())
        part = ex.read_data_file(str(self.folder / 'data/battles/10-old.js'))['hits'][0]['target']['parts'][0]
        self.assertIsNone(part.get('modelError'))

    def test_unreadable_vehicle_file_keeps_every_model(self):
        vehicle = self.folder / 'data/vehicles/broken.js'
        vehicle.parent.mkdir(parents=True)
        vehicle.write_text('not an exported data file')
        self.exporter().setup()
        self.assertTrue(self.orphan.exists())
        self.assertTrue(self.model.exists())

    def test_headless_battle_blocks_prune_too(self):
        (self.folder / 'battles/11-headless.jsonl').write_bytes(lines({'schema': 1, 'type': 'roster', 'vehicles': []}))
        self.exporter().setup()
        self.assertTrue(self.orphan.exists())

    def test_battle_file_with_an_unexpected_name_blocks_prune(self):
        # F5: only a copy with a file-manager name is left; its models must survive.
        original = self.folder / 'battles/10-old.jsonl'
        original.rename(self.folder / 'battles/10-old - Copy.jsonl')
        self.exporter().setup()
        self.assertTrue(self.model.exists())
        self.assertTrue(self.orphan.exists())
        self.assertEqual(len(self.warnings('unexpected name')), 1)

    def test_complete_set_still_prunes(self):
        self.exporter().setup()
        self.assertTrue(self.model.exists())
        self.assertFalse(self.orphan.exists())
        self.assertEqual(self.warnings('Unused models kept'), [])


class HeadlessTail(Quiet):
    """EXP-01 / REC-02: a battle file without its header never stalls the export."""

    def setUp(self):
        super().setUp()
        self.root = Path(self.temp.name)
        (self.root / 'battles').mkdir()
        (self.root / 'data/battles').mkdir(parents=True)
        self.ex = ex.Exporter(str(self.root), str(self.root), 'version\n', str(self.root / 'unused.wotmod'))

    def append(self, name, data):
        path = self.root / 'battles' / (name + '.jsonl')
        with open(path, 'ab') as stream: stream.write(data)
        self.ex.record_written(name, 0, path.stat().st_size)

    def test_headless_file_is_skipped_once_and_the_rest_goes_on(self):
        self.append('10-headless', lines({'schema': 1, 'type': 'roster', 'vehicles': [], 'playerVehicleId': 1}))
        self.append('11-ok', lines(header('11-ok')))
        self.ex.queue_job(3, 'ttx', {'vehicleType': 'x:y'})
        for _ in range(20): self.ex.idle()
        self.assertTrue((self.root / 'data/battles/11-ok.js').exists())
        self.assertFalse(self.ex.has_pending_records())
        self.assertEqual(len(self.ex.jobs), 0, 'deferred jobs run again')
        # The recorder keeps appending to the broken file: passed over, no exception, no second warning.
        for number in range(3):
            self.append('10-headless', lines(hit(number)))
            self.ex.idle()
        self.assertFalse(self.ex.has_pending_records())
        self.assertEqual(len(self.warnings('(no header line)')), 1)
        self.assertFalse((self.root / 'data/battles/10-headless.js').exists())

    def test_headless_file_after_a_live_battle(self):
        self.append('10-live', lines(header('10-live'), hit(1)))
        self.ex.idle()
        self.append('11-headless', lines(hit(1), hit(2)))
        for _ in range(5): self.ex.idle()
        self.assertFalse(self.ex.has_pending_records())
        self.assertEqual(len(self.ex.skipped), 1)
        # The live battle keeps being published.
        self.append('10-live', lines(hit(2)))
        self.ex.finish()
        self.assertEqual(len(ex.read_data_file(str(self.root / 'data/battles/10-live.js'))['hits']), 2)

    def test_recovery_file_restores_the_header_in_the_tail(self):
        raw = lines(hit(1))
        path = self.root / 'battles/12-lost.jsonl'
        path.write_bytes(raw)
        import hashlib
        recovery = {'rawSha256': hashlib.sha256(raw).hexdigest(), 'header': header('12-lost'), 'warnings': ['restored']}
        (self.root / 'battles/12-lost.jsonl.recovery.json').write_text(json.dumps(recovery))
        self.ex.record_written('12-lost', 0, len(raw))
        self.ex.finish()
        snapshot = ex.read_data_file(str(self.root / 'data/battles/12-lost.js'))
        self.assertEqual(len(snapshot['hits']), 1)
        self.assertIn('restored', snapshot['warnings'])
        self.assertEqual(self.ex.skipped, set())

    def tick(self, count):
        """idle() as the export thread runs it: an exception is logged and the next tick comes; the retry pause
        and the job pace are skipped so the test needs no clock."""
        errors = 0
        for _ in range(count):
            self.ex.next_publish_retry = self.ex.last_job = 0
            try: self.ex.idle()
            except Exception: errors += 1
        return errors

    def test_publication_that_keeps_failing_is_let_go(self):
        # F3: a battle with its header whose publication fails the same way every time.
        real = ex.Exporter.publish

        def publish(exporter, battle):
            if battle['id'] == '10-bad': raise TypeError('a part is not a dict')
            return real(exporter, battle)

        self.append('10-bad', lines(header('10-bad'), hit(1)))
        self.append('11-ok', lines(header('11-ok'), hit(1)))
        self.ex.queue_job(3, 'ttx', {'vehicleType': 'x:y'})
        with patch.object(ex.Exporter, 'publish', publish):
            errors = self.tick(20)
            self.assertEqual(errors, ex.PUBLISH_GIVE_UP - 1)
            self.assertIn('10-bad', self.ex.skipped)
            self.assertEqual(len(self.warnings('publication failed')), 1)
            self.assertTrue((self.root / 'data/battles/11-ok.js').exists())
            self.assertEqual(len(self.ex.jobs), 0, 'deferred jobs run again')
            # More records of the let-go battle are passed over quietly.
            self.append('10-bad', lines(hit(2)))
            self.assertEqual(self.tick(3), 0)
            self.assertFalse(self.ex.has_pending_records())

    def test_locked_output_is_waited_out(self):
        # A locked or unwritable output (EnvironmentError) is retried as before, never let go.
        real = ex.Exporter.publish
        state = {'locked': True}

        def publish(exporter, battle):
            if state['locked']: raise IOError('locked by an antivirus')
            return real(exporter, battle)

        self.append('10-live', lines(header('10-live'), hit(1)))
        with patch.object(ex.Exporter, 'publish', publish):
            self.assertEqual(self.tick(ex.PUBLISH_GIVE_UP * 3), ex.PUBLISH_GIVE_UP * 3)
            self.assertEqual(self.ex.skipped, set())
            state['locked'] = False
            self.assertEqual(self.tick(2), 0)
        self.assertTrue((self.root / 'data/battles/10-live.js').exists())

    def test_read_battle_still_raises_a_value_error(self):
        path = self.root / 'battles/13-x.jsonl'
        path.write_bytes(lines(hit(1)))
        with self.assertRaises(ValueError):
            ex.read_battle(str(path))


def replay_module(playing=False):
    return types.SimpleNamespace(g_replayCtrl=types.SimpleNamespace(isPlaying=playing))


class RecordingGate(unittest.TestCase):
    """REC-01: every path - roster included - asks the one gate; a replay or observer opens no battle file."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.observer = False
        self.player = types.SimpleNamespace(
            playerVehicleID=1, isObserver=lambda: self.observer,
            arena=types.SimpleNamespace(arenaUniqueID=987, arenaType=types.SimpleNamespace(name='Map'), bonusType=1,
                                        vehicles={1: {'name': 'me', 'team': 1, 'vehicleType': None},
                                                  2: {'name': 'them', 'team': 2, 'vehicleType': None}}))
        self.replay = replay_module()
        self.patch = patch.dict(sys.modules, {'BigWorld': types.SimpleNamespace(player=lambda: self.player,
                                                                                serverTime=lambda: 1.0),
                                              'BattleReplay': self.replay})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        spec = importlib.util.spec_from_file_location('recorder_gate', ROOT / 'mod/mod_local_armor_inspector.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.recorder = module.Recorder(os.path.join(self.temp.name, 'battles'))
        self.addCleanup(self.recorder.writer.close)

    def files(self):
        self.recorder.writer.close()
        folder = Path(self.temp.name) / 'battles'
        return sorted(p.name for p in folder.glob('*.jsonl')) if folder.exists() else []

    def test_replay_roster_writes_nothing(self):
        self.replay.g_replayCtrl.isPlaying = True
        self.recorder.note_roster(self.player.arena, self.player)
        self.assertIsNone(self.recorder.battle)
        self.assertEqual(self.files(), [])

    def test_observer_roster_writes_nothing(self):
        self.observer = True
        self.recorder.note_roster(self.player.arena, self.player)
        self.assertEqual(self.files(), [])

    def test_live_roster_opens_the_battle(self):
        self.recorder.note_roster(self.player.arena, self.player)
        self.assertEqual(self.recorder.battle, '987')
        self.assertEqual(len(self.files()), 1)

    def test_every_path_shares_the_gate(self):
        crit, telemetry = CritLog(self.recorder), ShotTelemetry(self.recorder)
        self.assertTrue(recording(self.recorder, self.player))
        self.assertTrue(crit.active(self.player) and telemetry.active(self.player))
        for replay, observer, enabled in ((True, False, True), (False, True, True), (False, False, False)):
            self.replay.g_replayCtrl.isPlaying, self.observer, self.recorder.enabled = replay, observer, enabled
            self.assertFalse(recording(self.recorder, self.player))
            self.assertFalse(crit.active(self.player))
            self.assertFalse(telemetry.active(self.player))
        self.assertFalse(recording(self.recorder, types.SimpleNamespace(arena=None)))
        self.assertIs(self.recorder.recording, recording)


class UnderClientPython27(unittest.TestCase):
    def test_same_scenarios_in_python27(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tests/py27/run27.py'),
                                 str(ROOT / 'tests/py27/exporter_safety.py')],
                                capture_output=True, text=True, timeout=300)
        if result.returncode == 77: self.skipTest(result.stdout.strip())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ALL OK', result.stdout)


if __name__ == '__main__':
    unittest.main()
