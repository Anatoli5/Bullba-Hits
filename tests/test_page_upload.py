"""Page -> mod uploads (BACKLOG 131, stage 0): page_upload.Uploads reassembles base64 chunks in order into its own folder,
checks size and CRC32, hands the file to its purpose (the probe's is deleted) and writes ONE line per upload; the
upload thread; and the page channel's checks on the game thread (presentation._handle_web_command)."""
import base64
import os
import tempfile
import time
import unittest
import zlib

import sys
import types
import urllib
import urllib.request
import builtins

# presentation.py is the client's Python 2.7: the names Python 3 lacks, and a stand-in for the client's web API unless
# another test module (test_page_channel.py) put its own there first - one stand-in per run, so its classes stay one.
if not hasattr(urllib, 'pathname2url'): urllib.pathname2url = urllib.request.pathname2url
if not hasattr(builtins, 'basestring'): builtins.basestring = str
if 'web.web_client_api' not in sys.modules:
    class _Field(object):
        def __init__(self, required=False, type=None, default=None):
            self.required, self.type, self.default = required, type, default

    class _Handler(object):
        def __init__(self, name, schema, handler, finiHandler=None):
            self.name, self.schema, self.handler, self.finiHandler = name, schema, handler, finiHandler

    web = sys.modules.setdefault('web', types.ModuleType('web'))
    api = types.ModuleType('web.web_client_api')
    api.W2CSchema, api.Field = type('W2CSchema', (object,), {}), _Field
    api.createCommandHandler = lambda name, schema, handler, fini=None: _Handler(name, schema, handler, fini)
    web.web_client_api = api
    sys.modules['web.web_client_api'] = api

from mod.local_armor_inspector import page_upload, presentation


class Command(object):
    """What instantiateCommand hands a handler: attributes, missing ones None."""

    def __init__(self, **fields):
        self.__dict__.update(fields)

    def __getattr__(self, name):
        return None


def chunks(payload, upload='u1', chars=8, purpose='probe', digest=None, sent=None):
    per = max(3, chars // 4 * 3)
    count = max(1, -(-len(payload) // per))
    digest = digest or 'crc32:%08x' % (zlib.crc32(payload) & 0xffffffff)
    return [{'upload': upload, 'purpose': purpose, 'index': i, 'count': count, 'size': len(payload), 'digest': digest,
             'data': base64.b64encode(payload[i * per:(i + 1) * per]).decode('ascii'), 'sent': sent,
             'received': None, 'game_ms': 0.1} for i in range(count)]


class UploadsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = os.path.join(self.temp.name, 'uploads')
        self.lines = []
        self.now = [1000.0]
        self.uploads = page_upload.Uploads(self.folder, self.lines.append, clock=lambda: self.now[0])
        self.kept = []

    def keep(self):
        """A purpose that keeps its file, to see the bytes that were written."""
        def consume(item, path):
            with open(path, 'rb') as stream: self.kept.append(stream.read())
        self.uploads.consume = consume

    def test_crc_vector_matches_the_page(self):
        self.assertEqual(zlib.crc32(b'123456789') & 0xffffffff, 0xcbf43926)

    def test_in_order_chunks_come_back_equal_over_the_boundaries(self):
        self.keep()
        for n in (0, 1, 2, 3, 5, 6, 7, 31):
            payload = os.urandom(n)
            for chunk in chunks(payload, upload='n%d' % n): self.uploads.chunk(chunk)
            self.assertEqual(self.uploads.status('n%d' % n)['state'], 'done', n)
            self.assertEqual(self.kept[-1], payload)

    def test_the_probe_file_is_removed_and_one_line_says_so(self):
        payload = os.urandom(40)
        for chunk in chunks(payload, sent=999990.0): chunk['received'] = 1000.0; self.uploads.chunk(chunk)
        self.assertEqual(os.listdir(self.folder), [])
        self.uploads.report('u1', {'chunkChars': 8, 'state': 'done', 'next': 'none', 'replyVia': '{"listen":7}'})
        self.assertEqual(len(self.lines), 1)
        line = self.lines[0]
        self.assertTrue(line.startswith('Bullba Hits upload probe u1: 40 bytes, 7/7 chunks of up to 8 chars, written, crc ok, file removed'), line)
        self.assertIn('transit median 10 ms', line)
        self.assertIn('page: chunkChars 8, replyVia {"listen":7}, state done, next none', line)
        self.assertIsNone(self.uploads.status('u1'))

    def test_a_wrong_digest_or_size_fails_and_leaves_no_file(self):
        payload = os.urandom(20)
        for chunk in chunks(payload, upload='bad', digest='crc32:00000000'): self.uploads.chunk(chunk)
        state = self.uploads.status('bad')
        self.assertEqual(state['state'], 'failed')
        self.assertIn('expected crc32:00000000', state['error'])
        for chunk in chunks(payload, upload='big'): chunk['size'] = 30; self.uploads.chunk(chunk)
        self.assertIn('20 bytes, expected 30', self.uploads.status('big')['error'])
        self.assertEqual(os.listdir(self.folder), [])

    def test_out_of_order_duplicate_or_headless_chunks_fail(self):
        parts = chunks(os.urandom(30))
        self.uploads.chunk(parts[0]); self.uploads.chunk(parts[2])
        self.assertIn('chunk 2 out of order (expected 1)', self.uploads.status('u1')['error'])
        self.uploads.chunk(parts[1])
        self.assertEqual(self.uploads.items['u1']['ignored'], 1)
        dup = chunks(os.urandom(30), upload='dup')
        self.uploads.chunk(dup[0]); self.uploads.chunk(dup[0])
        self.assertIn('out of order', self.uploads.status('dup')['error'])
        self.uploads.chunk(chunks(os.urandom(30), upload='late')[1])
        self.assertIn('without its start', self.uploads.status('late')['error'])
        self.assertEqual(os.listdir(self.folder), [])

    def test_no_more_than_two_open_uploads(self):
        for name in ('a', 'b', 'c'): self.uploads.chunk(chunks(os.urandom(30), upload=name)[0])
        self.assertEqual([self.uploads.status(n)['state'] for n in 'abc'], ['open', 'open', 'failed'])

    def test_not_base64_fails(self):
        part = chunks(os.urandom(6))[0]
        part['data'] = u'жжжж'
        self.uploads.chunk(part)
        self.assertIn('not base64', self.uploads.status('u1')['error'])

    def test_a_report_without_chunks_or_before_the_end(self):
        self.uploads.report('never', {'state': 'failed', 'error': 'jsHostQuery failed (-1): too big'})
        self.assertIn('upload ? never: NOT RECEIVED', self.lines[-1])
        self.assertIn('error jsHostQuery failed (-1): too big', self.lines[-1])
        self.uploads.chunk(chunks(os.urandom(30), upload='half')[0])
        self.uploads.report('half', {})
        self.assertIn('FAILED: incomplete: 1 of 5 chunks', self.lines[-1])
        self.assertEqual(os.listdir(self.folder), [])

    def test_stale_uploads_get_their_line_and_lose_their_files(self):
        self.uploads.chunk(chunks(os.urandom(30), upload='stale')[0])
        self.assertEqual(os.listdir(self.folder), ['stale.part'])
        self.now[0] += page_upload.STALE - 1; self.uploads.tick()
        self.assertEqual(self.lines, [])
        self.now[0] += 1; self.uploads.tick()
        self.assertIn('FAILED: no chunk for 60 s; ', self.lines[-1])
        self.assertIn('page report missing', self.lines[-1])
        self.assertEqual(os.listdir(self.folder), [])

    def test_leftovers_are_cleaned(self):
        os.makedirs(self.folder)
        for name in ('x.part', 'y.bin', 'keep.txt'): open(os.path.join(self.folder, name), 'wb').close()
        self.uploads.clean()
        self.assertEqual(os.listdir(self.folder), ['keep.txt'])


class WorkerTests(unittest.TestCase):
    def test_the_thread_writes_and_reports_in_queue_order(self):
        with tempfile.TemporaryDirectory() as temp:
            lines = []
            worker = page_upload.UploadWorker(os.path.join(temp, 'uploads'), lines.append)
            try:
                for chunk in chunks(os.urandom(50)): self.assertTrue(worker.put('chunk', chunk))
                worker.put('report', ('u1', {'state': 'done'}))
                deadline = time.time() + 5
                while not lines and time.time() < deadline: time.sleep(0.01)
            finally: worker.stop()
            self.assertEqual(len(lines), 1)
            self.assertIn('written, crc ok, file removed', lines[0])

    def test_too_much_waiting_is_refused(self):
        worker = page_upload.UploadWorker('unused')
        worker.queued = page_upload.MAX_QUEUED_CHARS
        self.assertFalse(worker.put('chunk', {'data': 'AAAA'}))
        self.assertIsNone(worker.thread)


class ChannelTests(unittest.TestCase):
    """The game thread's part: checks, the queue, the answer through ctx['callback'] (the client's reply path)."""

    def setUp(self):
        self.puts, self.answers = [], []
        presentation.set_upload_request(lambda kind, payload: self.puts.append((kind, payload)) or True,
                                        lambda upload: {'upload': upload, 'state': 'done'} if upload == 'u1' else None)
        self.addCleanup(presentation.set_upload_request, None, None)
        self.ctx = {'callback': self.answers.append, 'browser_id': 1}
        self.handler = presentation.web_handlers()[0].handler

    def test_schema_has_the_upload_fields(self):
        schema = presentation.web_handlers()[0].schema
        for name in ('upload', 'purpose', 'index', 'count', 'size', 'digest', 'data', 'sent'):
            self.assertTrue(hasattr(schema, name), name)

    def test_a_chunk_is_queued_and_answered(self):
        part = chunks(os.urandom(6), sent=1.7e12)[0]
        fields = dict((k, part[k]) for k in ('upload', 'purpose', 'index', 'count', 'size', 'digest', 'data', 'sent'))
        self.handler(Command(action='upload', **fields), self.ctx)
        self.assertEqual(len(self.puts), 1)
        kind, chunk = self.puts[0]
        self.assertEqual(kind, 'chunk')
        self.assertEqual(chunk['data'], part['data'])
        self.assertIsInstance(chunk['received'], float)
        self.assertGreaterEqual(chunk['game_ms'], 0)
        self.assertEqual(self.answers, [{'upload': 'u1', 'index': 0, 'state': 'received'}])

    def test_bad_chunks_are_refused_without_queueing(self):
        good = dict((k, v) for k, v in chunks(os.urandom(6))[0].items() if k not in ('received', 'game_ms'))
        for change in ({'upload': 'bad id!'}, {'index': 5}, {'count': 0}, {'purpose': 'other'}, {'digest': 'md5:x'},
                       {'size': page_upload.MAX_SIZE + 1}, {'data': 'A' * (page_upload.MAX_CHUNK_CHARS + 1)}, {'index': True}):
            fields = dict(good); fields.update(change)
            self.handler(Command(action='upload', **fields), self.ctx)
        self.assertEqual(self.puts, [])

    def test_status_report_listen(self):
        self.handler(Command(action='uploadStatus', upload='u1'), self.ctx)
        self.handler(Command(action='uploadStatus', upload='u2'), self.ctx)
        self.handler(Command(action='uploadListen'), self.ctx)
        self.handler(Command(action='uploadReport', upload='u1', report={'state': 'done'}), self.ctx)
        self.assertEqual(self.answers, [{'upload': 'u1', 'state': 'done'}, {'upload': 'u2', 'state': 'unknown'},
                                        {'listen': True}])
        self.assertEqual(self.puts, [('report', ('u1', {'state': 'done'}))])

    def test_no_recorder_and_no_callback_do_nothing(self):
        presentation.set_upload_request(None, None)
        self.handler(Command(action='upload', **chunks(b'abc')[0]), {})
        self.handler(Command(action='uploadStatus', upload='u1'), {})
        self.assertEqual((self.puts, self.answers), ([], []))


if __name__ == '__main__':
    unittest.main()
