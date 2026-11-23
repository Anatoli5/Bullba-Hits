# -*- coding: utf-8 -*-
"""Page -> mod uploads over the page channel (BACKLOG 131, stage 0): the page sends a payload in base64 chunks
('upload': upload id, purpose, index, count, size, digest 'crc32:<8 hex>', data, sent), the game thread only checks
and queues them (presentation._handle_web_command), and this module's own thread appends each chunk to
<folder>/<id>.part, checks size and CRC32 at the last one, renames the file to <id>.bin and hands it to the purpose's
consumer. Its own thread, not the record Writer's: an upload bug never touches the raw records (B12).

The one purpose today is 'probe' (the bridge measurement of stage 0): its file is deleted once checked, and the page's
'uploadReport' turns the upload's figures and the page's own into ONE log line. Everything in the folder is the mod's own
scratch: leftovers are removed when the thread starts.

Python 2.7 (the client) and 3 (the tests)."""
from __future__ import absolute_import
import binascii
import logging
import os
import re
import threading
import time
import zlib

try: import Queue as queue
except ImportError: import queue

LOG = logging.getLogger('local.armor_inspector')
UPLOAD_ID = re.compile(r'^[-A-Za-z0-9_]{1,64}\Z')
DIGEST = re.compile(r'^crc32:[0-9a-f]{8}\Z')
PURPOSES = ('probe',)
MAX_COUNT = 4096
MAX_SIZE = 16 * 1024 * 1024
MAX_CHUNK_CHARS = 8 * 1024 * 1024
# Uploads open at once, and the characters waiting in the thread's queue (a bound on the memory a page can hold here).
MAX_OPEN = 2
MAX_QUEUED_CHARS = 24 * 1024 * 1024
# An upload with no chunk for this long, or finished with no page report for this long, is closed with its line.
STALE = 60.0
# The page's report values the line prints, in this order (a value is cut to REPORT_TEXT characters).
REPORT_KEYS = ('chunkChars', 'sentChunks', 'sendMs', 'ackMedian', 'ackMax', 'ackTimeouts', 'replies', 'replyVia',
               'replyMedian', 'state', 'statusMs', 'listen', 'error', 'compression', 'next')
REPORT_TEXT = 160
# A fine clock for one chunk's write (time.clock on the client's Python 2.7 on Windows; time.time ticks in ms there).
CLOCK = getattr(time, 'perf_counter', None) or time.clock


def valid_chunk(chunk):
    """None when the chunk's fields are well-formed (game thread, no decode), else the reason."""
    upload, purpose = chunk.get('upload'), chunk.get('purpose')
    index, count, size = chunk.get('index'), chunk.get('count'), chunk.get('size')
    digest, data = chunk.get('digest'), chunk.get('data')
    if not upload or not UPLOAD_ID.match(str(upload)): return 'no upload id'
    if purpose not in PURPOSES: return 'unknown purpose %r' % (purpose,)
    for name, value in (('index', index), ('count', count), ('size', size)):
        if isinstance(value, bool) or not isinstance(value, int): return 'no %s' % name
    if not 1 <= count <= MAX_COUNT or not 0 <= index < count: return 'index %r of %r' % (index, count)
    if not 0 <= size <= MAX_SIZE: return 'size %r' % (size,)
    if not digest or not DIGEST.match(str(digest)): return 'no digest'
    if not isinstance(data, (type(u''), type(b''), str)) or len(data) > MAX_CHUNK_CHARS: return 'no data'
    return None


def _median(values):
    if not values: return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _ms(value):
    return '-' if value is None else ('%.1f' % value if value < 10 else '%d' % round(value))


class Uploads(object):
    """The uploads in progress; one thread calls chunk/report/tick, any thread status (under the lock)."""

    def __init__(self, folder, emit=None, clock=time.time):
        self.folder = folder
        self.emit = emit or (lambda line: LOG.info('%s', line))
        self.clock = clock
        self.lock = threading.Lock()
        self.items = {}

    def path(self, upload, ext):
        return os.path.join(self.folder, str(upload) + ext)

    def clean(self):
        """Leftovers of an earlier session (the mod's own scratch, never a record)."""
        if not os.path.isdir(self.folder):
            os.makedirs(self.folder)
            return
        for name in os.listdir(self.folder):
            if name.endswith('.part') or name.endswith('.bin'):
                try: os.remove(os.path.join(self.folder, name))
                except OSError: LOG.warning('Bullba Hits upload: leftover %s not removed', name)

    def status(self, upload):
        """What the page may ask about one upload: a small dict, or None when it is not known."""
        with self.lock:
            item = self.items.get(upload)
            if item is None: return None
            return {'upload': upload, 'state': item['state'], 'chunks': item['next'], 'count': item['count'],
                    'error': item['error']}

    def _remove(self, item):
        for ext in ('.part', '.bin'):
            try: os.remove(self.path(item['upload'], ext))
            except OSError: pass

    def _fail(self, item, error):
        with self.lock:
            if item['state'] == 'open':
                item['state'], item['error'] = 'failed', error
        self._remove(item)

    def chunk(self, chunk):
        """One chunk, in order: decode, append, and at the last one check and hand over."""
        now = self.clock()
        upload, index = chunk['upload'], chunk['index']
        item = self.items.get(upload)
        if item is None:
            item = {'upload': upload, 'purpose': chunk['purpose'], 'count': chunk['count'], 'size': chunk['size'],
                    'digest': chunk['digest'], 'next': 0, 'written': 0, 'crc': 0, 'state': 'open', 'error': None,
                    'first': chunk.get('received') or now, 'done_at': None, 'touched': now, 'chars': 0,
                    'transit': [], 'game': [], 'writer': [], 'ignored': 0}
            with self.lock:
                opened = sum(1 for other in self.items.values() if other['state'] == 'open')
                self.items[upload] = item
            if index != 0: return self._fail(item, 'chunk %d without its start' % index)
            if opened >= MAX_OPEN: return self._fail(item, 'more than %d uploads open' % MAX_OPEN)
            if not os.path.isdir(self.folder): os.makedirs(self.folder)
            self._remove(item)
        item['touched'] = now
        if item['state'] != 'open':
            item['ignored'] += 1
            return
        if (chunk['purpose'], chunk['count'], chunk['size'], chunk['digest']) != (
                item['purpose'], item['count'], item['size'], item['digest']):
            return self._fail(item, 'chunk %d of another upload under the same id' % index)
        if index != item['next']:
            return self._fail(item, 'chunk %d out of order (expected %d)' % (index, item['next']))
        sent, received = chunk.get('sent'), chunk.get('received')
        if sent is not None and received is not None: item['transit'].append(received * 1000.0 - sent)
        if chunk.get('game_ms') is not None: item['game'].append(chunk['game_ms'])
        t0 = CLOCK()
        data = chunk['data']
        try:
            if not isinstance(data, bytes): data = data.encode('ascii')
            raw = binascii.a2b_base64(data)
        except (UnicodeError, binascii.Error, ValueError) as error:
            return self._fail(item, 'chunk %d not base64: %s' % (index, error))
        if item['written'] + len(raw) > item['size']:
            return self._fail(item, 'chunk %d goes past the size %d' % (index, item['size']))
        try:
            with open(self.path(upload, '.part'), 'ab') as stream: stream.write(raw)
        except (IOError, OSError) as error:
            return self._fail(item, 'chunk %d not written: %s' % (index, error))
        item['crc'] = zlib.crc32(raw, item['crc']) & 0xffffffff
        item['written'] += len(raw)
        item['chars'] = max(item['chars'], len(data))
        item['writer'].append((CLOCK() - t0) * 1000.0)
        with self.lock: item['next'] = index + 1
        if index + 1 < item['count']: return
        if item['written'] != item['size']:
            return self._fail(item, '%d bytes, expected %d' % (item['written'], item['size']))
        if 'crc32:%08x' % item['crc'] != item['digest']:
            return self._fail(item, 'crc32:%08x, expected %s' % (item['crc'], item['digest']))
        try:
            os.rename(self.path(upload, '.part'), self.path(upload, '.bin'))
            self.consume(item, self.path(upload, '.bin'))
        except Exception as error:
            return self._fail(item, 'not handed over: %s: %s' % (type(error).__name__, error))
        with self.lock:
            item['state'], item['done_at'] = 'done', self.clock()

    def consume(self, item, path):
        """The finished, checked file to its purpose. 'probe': nothing keeps it."""
        if item['purpose'] == 'probe': os.remove(path)

    def report(self, upload, page):
        """The page's report of one upload: the line, and the upload is forgotten."""
        item = self.items.get(upload)
        if item is not None and item['state'] == 'open':
            self._fail(item, 'incomplete: %d of %d chunks' % (item['next'], item['count']))
        self.emit(self.line(upload, item, page))
        with self.lock: self.items.pop(upload, None)

    def tick(self):
        """Uploads nobody reports on: their line after STALE seconds, their files removed."""
        now = self.clock()
        for upload, item in list(self.items.items()):
            if now - item['touched'] >= STALE:
                if item['state'] == 'open': self._fail(item, 'no chunk for %d s' % STALE)
                self.emit(self.line(upload, item, None))
                with self.lock: self.items.pop(upload, None)

    @staticmethod
    def line(upload, item, page):
        """ONE line per upload: the mod's figures and the page's (None: no page report came)."""
        purpose = item['purpose'] if item else (page or {}).get('purpose', '?')
        parts = []
        if item is None:
            parts.append('NOT RECEIVED (no chunk reached the mod)')
        else:
            state = {'done': 'written, crc ok, file removed' if item['purpose'] == 'probe' else 'written, crc ok',
                     'failed': 'FAILED: %s' % item['error'], 'open': 'open'}[item['state']]
            parts.append('%d bytes, %d/%d chunks of up to %d chars, %s' % (
                item['size'], item['next'], item['count'], item['chars'], state))
            if item['done_at'] is not None:
                parts.append('mod first receipt -> last written %s ms' % _ms((item['done_at'] - item['first']) * 1000.0))
            parts.append('transit median %s ms max %s ms' % (_ms(_median(item['transit'])),
                                                             _ms(max(item['transit']) if item['transit'] else None)))
            parts.append('game thread per chunk median %s ms max %s ms' % (
                _ms(_median(item['game'])), _ms(max(item['game']) if item['game'] else None)))
            parts.append('writer per chunk median %s ms max %s ms' % (
                _ms(_median(item['writer'])), _ms(max(item['writer']) if item['writer'] else None)))
            if item['ignored']: parts.append('%d chunks after its end ignored' % item['ignored'])
        if page is None: parts.append('page report missing')
        else:
            shown = []
            for key in REPORT_KEYS:
                if key in page and page[key] is not None:
                    text = page[key] if isinstance(page[key], (type(u''), str)) else repr(page[key])
                    shown.append('%s %s' % (key, text[:REPORT_TEXT]))
            parts.append('page: ' + ', '.join(shown))
        return 'Bullba Hits upload %s %s: %s' % (purpose, upload, '; '.join(parts))


class UploadWorker(object):
    """The uploads' own thread. put() and status() are for the game thread and never block."""

    def __init__(self, folder, emit=None):
        self.uploads = Uploads(folder, emit)
        self.queue = queue.Queue()
        self.queued = 0
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread = None

    def put(self, kind, payload):
        """('chunk', chunk dict) or ('report', (upload id, report dict)). False when refused (too much waiting)."""
        size = len(payload.get('data') or '') if kind == 'chunk' else 0
        with self.lock:
            if self.queued + size > MAX_QUEUED_CHARS: return False
            self.queued += size
            if self.thread is None:
                self.thread = threading.Thread(target=self.run, name='ArmorInspectorUpload')
                self.thread.daemon = True
                self.thread.start()
        self.queue.put((kind, payload, size))
        return True

    def status(self, upload):
        return self.uploads.status(upload)

    def run(self):
        try: self.uploads.clean()
        except Exception: LOG.exception('Bullba Hits upload folder not cleaned')
        while not self.stopping.is_set():
            try: kind, payload, size = self.queue.get(timeout=1.0)
            except queue.Empty:
                try: self.uploads.tick()
                except Exception: LOG.exception('Bullba Hits upload tick failed')
                continue
            try:
                if kind == 'chunk': self.uploads.chunk(payload)
                elif kind == 'report': self.uploads.report(payload[0], payload[1])
            except Exception: LOG.exception('Bullba Hits upload %s failed', kind)
            finally:
                with self.lock: self.queued -= size
            try: self.uploads.tick()
            except Exception: LOG.exception('Bullba Hits upload tick failed')

    def stop(self):
        self.stopping.set()
        thread = self.thread
        if thread is not None: thread.join(1.0)
