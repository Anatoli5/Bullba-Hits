import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from mod.mod_local_armor_inspector import Writer
from mod.local_armor_inspector.exporter import Exporter, model_key, read_battle
from mod.local_armor_inspector.records import RecordEncoder


HEADER = {'schema': 1, 'type': 'battle', 'id': '12-test', 'startedAt': 1,
          'map': 'Map', 'clientVersion': 'version\n'}


def hit(number, resource=None):
    parts = [] if resource is None else [{'id': 1, 'name': 'hull',
                                           'resource': resource, 'armor': {1: 100}}]
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': 'incoming',
            'target': {'name': 'Target', 'type': 'test:Target', 'parts': parts},
            'attacker': {'name': 'Attacker', 'parts': []}, 'points': []}


def encoded_rows(rows):
    encoder = RecordEncoder()
    data, ends = bytearray(), []
    for row in rows:
        packed = encoder.encode(row)
        line = (json.dumps(packed, separators=(',', ':')) + '\n').encode('utf-8')
        data.extend(line)
        ends.append(len(data))
        encoder.commit()
    return bytes(data), ends


class ExportPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'battles').mkdir()
        (self.root / 'data' / 'battles').mkdir(parents=True)

    def exporter(self):
        return Exporter(str(self.root), str(self.root), 'version\n', str(self.root / 'unused.wotmod'))

    def test_export_backpressure_coalesces_without_losing_raw_rows(self):
        entered, release = threading.Event(), threading.Event()

        class SlowSink(object):
            def __init__(self): self.bounds = []
            def setup(self): pass
            def idle(self):
                entered.set()
                release.wait(2)
            def record_written(self, name, start, end): self.bounds.append((name, start, end))
            def has_pending_records(self): return False
            def has_pending_publish(self): return False
            def finish(self): return True

        sink = SlowSink()
        writer = Writer(str(self.root / 'battles'), sink)
        try:
            self.assertTrue(entered.wait(1))
            rows = [HEADER] + [hit(i) for i in range(1100)]
            for row in rows:
                writer.queue.put(('12-test', row), timeout=2)
            writer.queue.join()
            self.assertEqual(writer.export_queue.qsize(), 0)
        finally:
            release.set()
            writer.close()
        battle = read_battle(str(self.root / 'battles' / '12-test.jsonl'))
        self.assertEqual(len(battle['hits']), 1100)
        self.assertTrue(sink.bounds)
        self.assertEqual(sink.bounds[-1][2], (self.root / 'battles' / '12-test.jsonl').stat().st_size)

    def test_tail_consumption_is_bounded_and_commits_applied_offsets(self):
        rows = [HEADER, hit(1), hit(2), hit(3)]
        payload, ends = encoded_rows(rows)
        path = self.root / 'battles' / '12-test.jsonl'
        path.write_bytes(payload)
        exporter = self.exporter()
        exporter.record_written('12-test', 0, len(payload))
        self.assertEqual(exporter.consume_records(count_budget=2, force=True), 2)
        self.assertEqual(exporter.raw_offsets['12-test'], ends[1])
        self.assertEqual([row['id'] for row in exporter.current['hits']], ['1'])
        self.assertEqual(exporter.consume_records(count_budget=2, force=True), 2)
        self.assertEqual([row['id'] for row in exporter.current['hits']], ['1', '2', '3'])
        self.assertFalse(exporter.has_pending_records())

    def test_incomplete_tail_waits_for_the_rest_of_the_line(self):
        header_data, ends = encoded_rows([HEADER])
        hit_data, _ = encoded_rows([hit(1)])
        split = len(hit_data) // 2
        path = self.root / 'battles' / '12-test.jsonl'
        path.write_bytes(header_data + hit_data[:split])
        exporter = self.exporter()
        exporter.record_written('12-test', 0, path.stat().st_size)
        exporter.consume_records(force=True)
        self.assertEqual(exporter.raw_offsets['12-test'], ends[0])
        self.assertEqual(exporter.current['hits'], [])
        with path.open('ab') as stream:
            stream.write(hit_data[split:])
        exporter.record_written('12-test', ends[0], path.stat().st_size)
        exporter.consume_records(force=True)
        self.assertEqual([row['id'] for row in exporter.current['hits']], ['1'])

    def test_startup_cursor_notification_does_not_duplicate_old_hits(self):
        first, ends = encoded_rows([HEADER, hit(1)])
        path = self.root / 'battles' / '12-test.jsonl'
        path.write_bytes(first)
        exporter = self.exporter()
        recovered, offset = read_battle(str(path), return_offset=True)
        exporter.raw_offsets['12-test'] = offset
        second, _ = encoded_rows([hit(2)])
        with path.open('ab') as stream:
            stream.write(second)
        exporter.record_written('12-test', ends[-1], path.stat().st_size)
        exporter.consume_records(force=True)
        self.assertEqual([row['id'] for row in exporter.current['hits']], ['1', '2'])
        self.assertEqual(recovered['hits'][0]['id'], '1')

    def test_compatibility_record_rejects_unknown_type(self):
        exporter = self.exporter()
        exporter.record('12-test', HEADER)
        with self.assertRaisesRegex(ValueError, 'Unexpected record'):
            exporter.record('12-test', {'schema': 1, 'type': 'future', 'id': 'bad'})
        self.assertEqual(exporter.current['hits'], [])

    def test_failed_battle_switch_publish_retries_without_advancing_tail(self):
        payload, _ = encoded_rows([dict(HEADER, id='13-test'), hit(1)])
        (self.root / 'battles' / '13-test.jsonl').write_bytes(payload)
        exporter = self.exporter()
        exporter.current = dict(HEADER, hits=[], shotEvents=[], warnings=[])
        exporter.pending_publish = True
        exporter.reset_prepared()
        exporter.record_written('13-test', 0, len(payload))
        with patch.object(exporter, 'publish', side_effect=[OSError('locked'), None]), \
                patch.object(exporter, 'write_index'):
            with self.assertRaises(OSError):
                exporter.consume_records(force=True)
            self.assertEqual(exporter.raw_offsets.get('13-test', 0), 0)
            self.assertEqual(exporter.current['id'], '12-test')
            exporter.next_publish_retry = 0
            exporter.consume_records(force=True)
        self.assertEqual(exporter.current['id'], '13-test')
        self.assertEqual([row['id'] for row in exporter.current['hits']], ['1'])

    def test_active_hit_is_prepared_once_then_invalidated_by_model(self):
        resource = 'vehicles/test/collision_client/Hull.model'
        exporter = self.exporter()
        exporter.current = dict(HEADER, hits=[hit(1, resource)], shotEvents=[], warnings=[])
        exporter.reset_prepared()

        def pending_parts(result, row, side, battle_id=None, priority=None, pending=None):
            for part in (row.get(side) or {}).get('parts', []):
                part['modelPending'] = True

        original = exporter.prepare_hit
        with patch.object(exporter, 'publish_parts', side_effect=pending_parts), \
                patch.object(exporter, 'prepare_hit', wraps=original) as prepared:
            exporter.publish(exporter.current)
            exporter.publish(exporter.current)
            self.assertEqual(prepared.call_count, 1)
            exporter.invalidate_model(model_key(resource, HEADER['clientVersion']))
            exporter.publish(exporter.current)
            self.assertEqual(prepared.call_count, 2)


if __name__ == '__main__':
    unittest.main()
