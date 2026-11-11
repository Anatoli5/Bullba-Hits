# -*- coding: utf-8 -*-
"""The run-time source of a battle's replay stream: the game records every live battle, the mod keeps a copy of the
raw stream beside the battle's record and hands it to the export thread once, after the battle or after a crash.

Facts this rests on (client 2.4.1.1 #992, bytecode read without running it; docs/KNOWLEDGE.md section 18,
C:/Projects/WoT-Base/KNOWLEDGE-client.md «Реплеи»):
- `BattleReplay.g_replayCtrl` (game.init) records into './replays'. `record(fileName=None)` takes temp.wotreplay
  (temp1 ... temp99 when that cannot be opened): opens it 'wb', closes, removes it, calls the native
  `startRecording(fileName)` and keeps the name in `_BattleReplay__fileName`. While the battle runs that file is the
  raw packet stream, growing in 4 KB multiples about every 5 s (measured 02.11 and 10.11).
- The game itself starts recording in the hangar (`__onAccountBecomePlayer` -> `enableAutoRecordingBattles(True)` ->
  `__startAutoRecord` -> `record()`), never in the arena. The first stream packets (the version, then 0x00 with the
  avatar's base properties: `arenaUniqueID`) come before the avatar becomes the player, so a recording started at
  `onAvatarBecomePlayer` would miss them (inferred). This module therefore makes sure of the recording in the hangar
  and, last, when the account stops being the player (the way into a battle).
- `PlayerAvatar.onBecomeNonPlayer` calls `g_replayCtrl.stop()` when it records, BEFORE it fires
  `g_playerEvents.onAvatarBecomeNonPlayer`: when our end handler runs the native side has already been told to write
  the final file (name set by `setResultingFileName`: 'replay_last_battle' overwritten for the setting `last`, a name
  of the native code's for `all`). The bytes the native writer still held at that moment are only in the final file.
- `enableAutoRecordingBattles(0)` (the setting `none`) stops the recording and does not change the resulting name, so
  a recording the mod started would otherwise end as the player's replay_last_battle: the mod sets its own resulting
  name before `record()` and puts the setting's name back when the battle ends. The player's setting is never
  written (`enableAutoRecordingBattles` is never called here).
- Mods are initialised in `gui.shared.personality.init` (`guiModsInit`), which game.init runs BEFORE
  `g_replayCtrl.subscribe()`: the mod's handlers of `g_playerEvents.onAccountBecomePlayer` run before the game's,
  i.e. before `record()` truncates the temp file of the last session - and at client start, before any login, the
  temp file of a crashed battle is still on disk.

Threads: the game thread only reads `g_replayCtrl` attributes, calls `record()` / `stop()` / `setResultingFileName`
when the mod owns the recording, and posts a small message to the inbox. All file work (the stat every PERIOD s, the
appended bytes, the end and the hand-over) runs on the thread `ArmorInspectorReplay`; nothing is decoded - the copy
is walked by packet headers only (12 bytes each) to know where the last whole packet ends.

What goes to the export thread, once per battle: `put_export('replay', message)` with the fields of `handover()`.
Every line this module logs starts with 'Replay source:'; the ones that answer what the bytecode could not are named
in docs/map/mod.md (block «Replay source»).
"""
from __future__ import absolute_import
import glob
import json
import logging
import os
import struct
import threading
import time
try:
    import Queue as queue
except ImportError:
    import queue

LOG = logging.getLogger('local.armor_inspector')

STREAM_EXT = '.wotstream'            # the copy: battles/<arenaUniqueID>-<session>.wotstream, the raw stream as is
STATE_FILE = 'replay-source.json'    # CFG/replay-source.json: the battle being copied, kept for the next start (crash)
SCHEMA = 1
OWN_RESULT_NAME = 'bullba_hits_battle'    # resulting name of a recording the mod started (replays/<name>.wotreplay)
FIXED_REPLAY_FILENAME = 'replay_last_battle'   # BattleReplay.FIXED_REPLAY_FILENAME (setting `last`)
REPLAY_EXT = '.wotreplay'
REPLAY_MAGIC = 0x11343212
PERIOD = 2.0          # seconds between two looks at the growing temp file during a battle
FINAL_WAIT = 30.0     # seconds the end waits for the final file before handing over without it
HANGAR_CHECK = 3.0    # seconds after the account becomes the player before the mod looks whether the game records
HEAD = 4096           # first bytes compared to tell this battle's recording from another one in the same file
ARENA_SCAN = 1 << 16  # the 0x00 packet is looked for within the first bytes of the stream (it starts at byte 129)
CHUNK = 1 << 20
PACKET = struct.Struct('<IIf')


def controller():
    """The game's replay controller, None when there is none (tools, a broken client)."""
    try:
        import BattleReplay
        return getattr(BattleReplay, 'g_replayCtrl', None)
    except Exception:
        return None


def playing(ctrl):
    return bool(ctrl is not None and (getattr(ctrl, 'isPlaying', False) or getattr(ctrl, 'isServerSideReplay', False)))


def arena_in_stream(data, arena_id):
    """True when the stream's first 0x00 packet (the avatar's base properties) carries arena_id as a little-endian
    u64, False when it does not or the stream starts otherwise, None while the packet is not whole yet."""
    try: wanted = struct.pack('<Q', int(arena_id))
    except (TypeError, ValueError, struct.error): return False
    off, n = 0, min(len(data), ARENA_SCAN)
    while off + 12 <= n:
        size, ptype, _ = PACKET.unpack_from(data, off)
        if off + 12 + size > len(data):
            return None if len(data) < ARENA_SCAN else False
        if ptype == 0x00:
            return wanted in bytes(data[off + 12:off + 12 + size])
        off += 12 + size
    return None if len(data) < ARENA_SCAN else False


def final_header(path):
    """(stream bytes, packed bytes, whole on disk) of a final .wotreplay from its plain header, or None. Only the
    header is read: the stream itself is encrypted and belongs to the export thread."""
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            head = f.read(8)
            if len(head) < 8: return None
            magic, count = struct.unpack('<II', head)
            if magic != REPLAY_MAGIC or count > 16: return None
            off = 8
            for _ in range(count):
                f.seek(off)
                raw = f.read(4)
                if len(raw) < 4: return None
                off += 4 + struct.unpack('<I', raw)[0]
            f.seek(off)
            raw = f.read(8)
            if len(raw) < 8: return None
            stream_size, packed = struct.unpack('<II', raw)
        # The encrypted part is the packed bytes rounded up to Blowfish's 8-byte blocks.
        return stream_size, packed, size >= off + 8 + packed
    except (IOError, OSError, struct.error):
        return None


def read_json(path):
    try:
        with open(path, 'rb') as f: return json.loads(f.read().decode('utf-8'))
    except (IOError, OSError, ValueError):
        return None


def write_json(path, value):
    try:
        with open(path, 'wb') as f: f.write(json.dumps(value, sort_keys=True).encode('utf-8'))
    except (IOError, OSError):
        LOG.warning('Replay source: state not written to %s', path, exc_info=True)


def remove(path):
    try:
        os.remove(path)
        return True
    except OSError:
        return False


class StreamCopy(object):
    """The copy of one battle's raw stream; used by the replay thread only."""

    def __init__(self, folder, name, arena, source, started, owned=False, result=None, setting=None):
        self.name, self.arena, self.source, self.started = name, str(arena), source, started
        self.owned, self.result, self.setting = owned, result, setting
        self.path = os.path.join(folder, name + STREAM_EXT)
        self.copied = 0          # bytes in the copy
        self.boundary = 0        # where the last whole packet of the copy ends
        self.carry = bytearray()  # the copy's bytes after the boundary (a packet the writer has not finished)
        self.packets = 0
        self.last_clock = None
        self.head = bytearray()  # the copy's first HEAD bytes
        self.arena_ok = None
        self.foreign = None      # why the source stopped being this battle's ('shorter', 'other recording', 'arena')
        self.last_pull = None    # time of the last look that found new bytes

    def resume(self):
        """Take an existing copy (the next start after a crash): its size, head and packet boundary."""
        if not os.path.isfile(self.path): return
        with open(self.path, 'rb') as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk: break
                self.take(bytearray(chunk))
        LOG.info('Replay source: resumed the copy of %s, %d bytes, %d whole packets', self.name, self.copied, self.packets)

    def take(self, chunk):
        """Account for bytes appended to the copy: size, head, the arena check, the packet walk."""
        if len(self.head) < HEAD: self.head += chunk[:HEAD - len(self.head)]
        self.copied += len(chunk)
        buf = self.carry + chunk
        off, n = 0, len(buf)
        while off + 12 <= n:
            size, _, clock = PACKET.unpack_from(buf, off)
            if off + 12 + size > n: break
            off += 12 + size
            self.packets += 1
            self.last_clock = clock
        self.boundary += off
        self.carry = buf[off:]
        if self.arena_ok is None:
            self.arena_ok = arena_in_stream(self.head, self.arena)
            if self.arena_ok is not None:
                LOG.info('Replay source: the stream of %s %s its arena id', self.name,
                         'carries' if self.arena_ok else 'does NOT carry')
                if not self.arena_ok: self.foreign = 'arena'

    def pull(self):
        """Append what the source has beyond the copy. Returns the bytes appended, None when the source is gone or is
        no longer this battle's recording (then nothing more is ever taken from it)."""
        if self.foreign or not self.source: return None
        try: size = os.path.getsize(self.source)
        except OSError: return None
        if size < self.copied:
            self.foreign = 'shorter'
            LOG.info('Replay source: %s is shorter (%d) than the copy of %s (%d): another recording, not taken',
                     self.source, size, self.name, self.copied)
            return None
        if size == self.copied: return 0
        appended = 0
        with open(self.source, 'rb') as src:
            if self.copied:
                same = src.read(min(HEAD, self.copied))
                if bytearray(same) != self.head[:len(same)]:
                    self.foreign = 'other recording'
                    LOG.info('Replay source: %s now starts with another stream than the copy of %s: not taken',
                             self.source, self.name)
                    return None
            src.seek(self.copied)
            with open(self.path, 'ab') as dst:
                while self.copied < size:
                    chunk = src.read(min(CHUNK, size - self.copied))
                    if not chunk: break
                    dst.write(chunk)
                    self.take(bytearray(chunk))
                    appended += len(chunk)
                    if self.foreign: break
        if appended: self.last_pull = time.time()
        return appended

    def state(self):
        return {'schema': SCHEMA, 'battle': self.name, 'arenaId': self.arena, 'source': self.source,
                'startedAt': self.started, 'owned': self.owned, 'result': self.result, 'setting': self.setting}


class ReplaySource(object):
    def __init__(self, folder, session, put_export, replay_dir='replays', gate=None, threaded=True):
        self.folder = folder
        self.session = session
        self.put_export = put_export
        self.replay_dir = replay_dir
        self.gate = gate                 # callable(player) -> bool: this player's own live battle (telemetry.recording)
        self.inbox = queue.Queue()
        self.events = None
        # Game thread: a recording the mod started and its battle flag; None when the game records on its own.
        self.owned = None
        self.callback = None
        # Replay thread: the battle being copied and its end.
        self.copy = None
        self.ending = None               # {'at': time of the end signal, 'deadline': ..., 'reason': ...}
        self.discard = None              # an own final file of a seat that records nothing, removed when it appears
        self.handed = []                 # battle names handed over in this session (tests read it)
        self.lock = threading.Lock()     # one step at a time (thread, close)
        self.stopping = threading.Event()
        self.wake = threading.Event()
        if not os.path.isdir(folder): os.makedirs(folder)
        self.inbox.put(('restart', None))
        self.thread = None
        if threaded:
            self.thread = threading.Thread(target=self.run, name='ArmorInspectorReplay')
            self.thread.daemon = True
            self.thread.start()

    # --- game thread --------------------------------------------------------------------------------------------
    def install(self):
        try:
            from PlayerEvents import g_playerEvents
            g_playerEvents.onAccountBecomePlayer += self.on_account_become_player
            g_playerEvents.onAccountBecomeNonPlayer += self.on_account_become_non_player
            self.events = g_playerEvents
        except Exception:
            LOG.warning('Replay source: account events unavailable; the recording is checked at battle start only',
                        exc_info=True)

    def close(self):
        if self.events is not None:
            try:
                self.events.onAccountBecomePlayer -= self.on_account_become_player
                self.events.onAccountBecomeNonPlayer -= self.on_account_become_non_player
            except Exception: LOG.warning('Replay source: account event cleanup failed', exc_info=True)
            self.events = None
        self.cancel_callback()
        # A recording the mod started in the hangar and no battle came: it ends here, deleted, so the client's own
        # exit does not finalise it into a file in the player's folder.
        if self.owned is not None and not self.owned.get('battle'): self.stop_owned('client exit')
        self.stopping.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(2.0)
            if self.thread.is_alive(): LOG.warning('Replay source: thread still working at shutdown')
        else:
            self.step(final=True)

    def cancel_callback(self):
        if self.callback is None: return
        try:
            import BigWorld
            BigWorld.cancelCallback(self.callback)
        except Exception: pass
        self.callback = None

    def on_account_become_player(self, *args):
        """Back in the hangar (or logged in). Runs before the game's own handler, which may call record() and with
        it end and truncate the current temp file."""
        try:
            if self.owned is not None and not self.owned.get('battle'): self.stop_owned('back in the hangar without a battle')
            self.cancel_callback()
            import BigWorld
            self.callback = BigWorld.callback(HANGAR_CHECK, self.hangar_check)
        except Exception: LOG.warning('Replay source: hangar check not scheduled', exc_info=True)

    def hangar_check(self):
        self.callback = None
        self.ensure_recording('hangar')

    def on_account_become_non_player(self, *args):
        """Leaving the hangar - for a battle, or a logout. The last moment before the battle's first packets."""
        self.cancel_callback()
        self.ensure_recording('leaving the hangar')

    def ensure_recording(self, moment):
        """Make the game record if it does not; returns True when a recording runs afterwards."""
        try:
            ctrl = controller()
            if ctrl is None or playing(ctrl): return False
            recording = getattr(ctrl, 'isRecording', None)
            setting = getattr(ctrl, '_BattleReplay__isAutoRecordingEnabled', None)
            if recording is None:
                LOG.info('Replay source: the replay controller says nothing about recording (%s)', moment)
                return False
            if recording:
                LOG.info('Replay source: %s: the game records (setting %r, file %r, ours %s)', moment, setting,
                         getattr(ctrl, '_BattleReplay__fileName', None), self.owned is not None)
                return True
            ctrl.setResultingFileName(OWN_RESULT_NAME, True)
            started = ctrl.record()
            if not started:
                self.restore_result_name(ctrl)
                LOG.warning('Replay source: %s: record() refused (setting %r); this battle has no stream', moment, setting)
                return False
            self.owned = {'battle': False, 'file': getattr(ctrl, '_BattleReplay__fileName', None), 'setting': setting,
                          'since': moment}
            LOG.info('Replay source: %s: the game did not record (setting %r); the mod started it into %r, final name %r',
                     moment, setting, self.owned['file'], OWN_RESULT_NAME)
            return True
        except Exception:
            LOG.warning('Replay source: the recording could not be ordered (%s)', moment, exc_info=True)
            return False

    def restore_result_name(self, ctrl):
        """The resulting name the player's setting gives (enableAutoRecordingBattles: 1 -> replay_last_battle
        overwritten, 2 -> the native code's own name); for 0 the one the game set before it (at its start, 1's)."""
        try:
            if getattr(ctrl, '_BattleReplay__isAutoRecordingEnabled', None) == 2: ctrl.setResultingFileName(None)
            else: ctrl.setResultingFileName(FIXED_REPLAY_FILENAME, True)
        except Exception: LOG.warning('Replay source: the resulting file name could not be put back', exc_info=True)

    def stop_owned(self, why):
        owned, self.owned = self.owned, None
        ctrl = controller()
        try:
            if ctrl is not None and getattr(ctrl, 'isRecording', False) and not playing(ctrl): ctrl.stop(delete=True)
            if ctrl is not None: self.restore_result_name(ctrl)
            LOG.info('Replay source: the recording the mod started was stopped and deleted (%s)', why)
        except Exception: LOG.warning('Replay source: the mod\'s recording could not be stopped (%s)', why, exc_info=True)
        return owned

    def on_avatar_become_player(self, player):
        """Called by VehicleEvents. Only attribute reads and one message; the copy starts on the replay thread."""
        try:
            if self.gate is not None and not self.gate(player):
                if self.owned is not None:
                    self.owned['battle'] = True
                    self.owned['discard'] = True
                return
            ctrl = controller()
            if ctrl is None or playing(ctrl): return
            recording = getattr(ctrl, 'isRecording', None)
            if recording is False:
                LOG.warning('Replay source: the battle began without a recording; starting it now (its first packets '
                            'are probably missing)')
                recording = self.ensure_recording('battle start')
            setting = getattr(ctrl, '_BattleReplay__isAutoRecordingEnabled', None)
            if self.owned is not None and setting in (1, 2):
                # The player turned recording on while the mod's recording ran: the game renamed it to his setting's
                # file; from here it is his.
                LOG.info('Replay source: the player\'s setting %r took over the recording the mod started', setting)
                self.owned = None
            arena = getattr(player, 'arenaUniqueID', None)
            if arena is None: arena = getattr(getattr(player, 'arena', None), 'arenaUniqueID', None)
            if arena is None:
                LOG.warning('Replay source: no arena id at battle start; no stream copy')
                return
            source = getattr(ctrl, '_BattleReplay__fileName', None)
            owned = self.owned is not None
            if owned: self.owned['battle'] = True
            self.inbox.put(('battle', {'arena': str(arena), 'source': source, 'owned': owned, 'setting': setting,
                                       'recording': recording, 'at': time.time()}))
            self.wake.set()
        except Exception: LOG.warning('Replay source: battle start not noted', exc_info=True)

    def on_avatar_become_non_player(self):
        """Called by VehicleEvents after PlayerAvatar.onBecomeNonPlayer stopped the recording."""
        try:
            ctrl = controller()
            owned, self.owned = self.owned, None
            if owned is not None and ctrl is not None: self.restore_result_name(ctrl)
            recording = getattr(ctrl, 'isRecording', None) if ctrl is not None else None
            if owned is not None and owned.get('discard'):
                self.inbox.put(('discard', {'at': time.time()}))
            else:
                self.inbox.put(('end', {'at': time.time(), 'recording': recording}))
            self.wake.set()
        except Exception: LOG.warning('Replay source: battle end not noted', exc_info=True)

    # --- replay thread -----------------------------------------------------------------------------------------
    def run(self):
        while not self.stopping.is_set():
            try:
                with self.lock: self.step()
            except Exception: LOG.exception('Replay source: step failed; the battle record is not affected')
            self.wake.wait(PERIOD)
            self.wake.clear()
        try:
            with self.lock: self.step(final=True)
        except Exception: LOG.exception('Replay source: last step failed')

    def step(self, final=False, now=None):
        """One pass: the inbox, the growing copy, the end. final: hand over whatever is ending, without waiting."""
        while True:
            try: name, payload = self.inbox.get_nowait()
            except queue.Empty: break
            if name == 'restart': self.restart()
            elif name == 'battle': self.begin(payload)
            elif name == 'end': self.end(payload)
            elif name == 'discard': self.discard = {'at': payload['at'], 'deadline': payload['at'] + FINAL_WAIT}
        if self.copy is not None and self.ending is None: self.copy.pull()
        if self.ending is not None: self.finish(final, now)
        if self.discard is not None: self.drop_own_final(final, now)

    def state_path(self):
        # Beside battles/, not in it: battles/ holds the records and their stream copies only.
        return os.path.join(os.path.dirname(os.path.abspath(self.folder)), STATE_FILE)

    def begin(self, info):
        if self.copy is not None:
            # A battle start with the previous one not ended (no end signal came): hand that one over first.
            self.ending = self.ending or {'at': info['at'], 'reason': 'next battle', 'recording': None}
            self.finish(True)
        name = info['arena'] + '-' + self.session
        self.copy = StreamCopy(self.folder, name, info['arena'], info['source'], info['at'], owned=info['owned'],
                               result=OWN_RESULT_NAME if info['owned'] else None, setting=info['setting'])
        write_json(self.state_path(), self.copy.state())
        size = None
        try: size = os.path.getsize(info['source']) if info['source'] else None
        except OSError: pass
        LOG.info('Replay source: battle %s: recording %s (%s), file %r, %s bytes at start, copy %s', name,
                 info['recording'], 'the mod\'s' if info['owned'] else 'the game\'s', info['source'], size, self.copy.path)
        self.copy.pull()

    def end(self, info):
        if self.copy is None: return
        self.ending = {'at': info['at'], 'deadline': info['at'] + FINAL_WAIT, 'reason': 'battle',
                       'recording': info.get('recording'), 'logged': False}

    def restart(self):
        """At mod start: a battle the last session copied and never handed over (a crash, or an exit right after the
        battle). Its temp file is still there until the next login's record() - taken when it is that battle's."""
        state = read_json(self.state_path())
        if not state or state.get('handed') or not state.get('battle'): return
        copy = StreamCopy(self.folder, state['battle'], state.get('arenaId'), state.get('source'),
                          state.get('startedAt') or 0.0, owned=bool(state.get('owned')), result=state.get('result'),
                          setting=state.get('setting'))
        copy.resume()
        before = copy.copied
        exists = bool(copy.source) and os.path.isfile(copy.source)
        appended = copy.pull() if exists else None
        LOG.info('Replay source: the last session\'s battle %s was not handed over: temp %r %s, %s bytes taken '
                 '(copy %d -> %d)', copy.name, copy.source,
                 'missing' if not exists else ('NOT this battle\'s (%s)' % copy.foreign if copy.foreign else 'this battle\'s'),
                 appended, before, copy.copied)
        self.copy = copy
        self.ending = {'at': time.time(), 'deadline': 0.0, 'reason': 'restart', 'recording': None, 'logged': True}
        self.finish(True)

    def finish(self, final=False, now=None):
        copy, ending = self.copy, self.ending
        now = time.time() if now is None else now
        if not ending.get('logged'):
            # The first look after the end signal answers what the bytecode cannot: is the temp file still there
            # once the avatar's stop() ran, and how many bytes it got after our last periodic copy.
            ending['logged'] = True
            last = copy.last_pull
            exists = bool(copy.source) and os.path.isfile(copy.source)
            size = None
            if exists:
                try: size = os.path.getsize(copy.source)
                except OSError: exists = False
            appended = copy.pull() if exists else None
            LOG.info('Replay source: end of %s: recording after the avatar left %s; temp %r %s (size %s), %s bytes '
                     'after the last copy taken %.1f s before the end', copy.name, ending.get('recording'), copy.source,
                     'still there' if exists else 'gone', size, appended, ending['at'] - last if last else -1.0)
        elif copy.source and os.path.isfile(copy.source):
            grown = copy.pull()
            if grown: LOG.info('Replay source: temp %r still grew by %d bytes %.1f s after the end of %s', copy.source,
                               grown, now - ending['at'], copy.name)
        final_path, header = self.find_final(copy)
        whole = header is not None and header[2]
        if not (whole or final or now >= ending['deadline']): return
        if final_path is not None:
            LOG.info('Replay source: final file %s found %.1f s after the end: stream %s bytes, copy %d (%+d), whole %s',
                     final_path, now - ending['at'], header[0] if header else None, copy.copied,
                     (header[0] - copy.copied) if header else 0, whole)
        else:
            LOG.info('Replay source: no final file of %s %.1f s after the end', copy.name, now - ending['at'])
        self.handover(copy, ending, final_path, header)

    def own_final(self):
        return os.path.join(self.replay_dir, OWN_RESULT_NAME + REPLAY_EXT)

    def find_final(self, copy):
        """The final file this battle's recording became, by the name its setting gives; (path, header) or
        (None, None). Only files written after the battle began count; its arena is not checked here (that needs
        the decryption the export thread does)."""
        if copy.owned: candidates = [self.own_final()]
        elif copy.setting == 1: candidates = [os.path.join(self.replay_dir, FIXED_REPLAY_FILENAME + REPLAY_EXT)]
        else:
            candidates = [p for p in glob.glob(os.path.join(self.replay_dir, '*' + REPLAY_EXT))
                          if not os.path.basename(p).lower().startswith('temp')]
        found = []
        for path in candidates:
            try: mtime = os.path.getmtime(path)
            except OSError: continue
            if mtime + 1.0 < copy.started: continue
            header = final_header(path)
            if header is None: continue
            found.append((mtime, path, header))
        if not found: return None, None
        found.sort()
        return found[-1][1], found[-1][2]

    def handover(self, copy, ending, final_path, header):
        stream_bytes = header[0] if header else None
        complete = bool(copy.arena_ok and not copy.carry and stream_bytes is not None and stream_bytes == copy.copied
                        and header[2])
        give_final = final_path if (header is not None and not complete and stream_bytes >= copy.copied) else None
        temp = 'missing'
        if copy.source and os.path.isfile(copy.source):
            temp = 'kept'
            # The mod's own recording: its temp file is ours to remove once copied (the game would leave it there
            # under the setting `none`; under the other settings the next login's record() truncates it anyway).
            if copy.owned and copy.foreign is None and remove(copy.source): temp = 'removed'
        if copy.foreign: temp = 'foreign (%s)' % copy.foreign
        if complete and copy.owned and final_path and remove(final_path): give_final, final_path = None, None
        message = {'schema': SCHEMA, 'battle': copy.name, 'arenaId': copy.arena,
                   'stream': os.path.abspath(copy.path) if copy.copied else None, 'streamBytes': copy.copied,
                   'packets': copy.packets, 'partialBytes': len(copy.carry), 'lastClock': copy.last_clock,
                   'arenaChecked': copy.arena_ok, 'complete': complete, 'end': ending['reason'],
                   'final': os.path.abspath(give_final) if give_final else None,
                   'finalStreamBytes': stream_bytes if give_final else None,
                   'finalOwned': bool(give_final and copy.owned), 'recordingOwned': copy.owned, 'temp': temp}
        try: self.put_export('replay', message)
        except Exception: LOG.warning('Replay source: hand-over of %s failed', copy.name, exc_info=True)
        self.handed.append(copy.name)
        state = copy.state()
        state['handed'] = True
        write_json(self.state_path(), state)
        LOG.info('Replay source: handed over %s: %d bytes, %d packets (+%d partial), complete %s, final %s, temp %s',
                 copy.name, copy.copied, copy.packets, len(copy.carry), complete, message['final'], temp)
        self.copy, self.ending = None, None

    def drop_own_final(self, final=False, now=None):
        """The own recording of a seat that records nothing (a spectator): its final file is removed when it appears."""
        now = time.time() if now is None else now
        path = self.own_final()
        header = final_header(path) if os.path.isfile(path) else None
        if header is not None and header[2]:
            remove(path)
            LOG.info('Replay source: the mod\'s recording of a seat that records nothing was removed (%s)', path)
        elif not (final or now >= self.discard['deadline']): return
        self.discard = None
