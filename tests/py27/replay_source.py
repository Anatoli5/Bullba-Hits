# -*- coding: utf-8 -*-
"""The replay stream's run-time source (mod/local_armor_inspector/replay_source.py) under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/replay_source.py

A stub BattleReplay controller behaves as the client's bytecode says (BattleReplay.record / stop /
setResultingFileName, PlayerAvatar.onBecomeNonPlayer stopping the recording before onAvatarBecomeNonPlayer) and as
was measured (the in-battle replays/temp.wotreplay is the raw stream, flushed in 4 KB multiples; at the stop the
native side writes the final file and removes temp). The native parts it imitates are marked NATIVE below: the final
file's name for the setting `all`, whether temp is removed or kept, whether the stop flushes the tail - each case
runs with the variants the bytecode leaves open. The stream: the raw stream of a real battle,
tests/fixtures-local/replays/2026-11-10-temp-live.wotreplay (arena 2309556418257344269 - the live record of that
battle is named so), fed in steps; without it (a clean clone) a synthetic stream, and a note says so.

Checks, by group:
  last      the player records (setting `last`): the mod starts nothing; the copy is byte-identical to what the
            game flushed to temp; one message: final = replay_last_battle (the rest of the stream), not the mod's
  kept      the variant where the stop flushes everything and temp stays: the copy is the whole stream, complete
  nofinal   no final file appears: the message says cut off, no final
  all       setting `all`: the final file has the native code's own name; found by its time
  none      setting `none`: the mod starts the recording under its own name, the battle's final file is the mod's,
            the player's replay_last_battle and his setting stay untouched, the resulting name is put back
  logout    the mod's hangar recording with no battle is stopped and deleted at the next login, before the game's
            handler could end it as the player's replay_last_battle
  crash     no end; the next start finds the temp file of that battle and takes the rest; message 'restart'
  foreign   the same, but the temp file holds another battle by then: not taken
  replay    a replay being played: nothing recorded, copied or sent
  two       two battles in a row: two copies, two messages, each its own stream
  log       no ERROR logged

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import collections
import json
import logging
import os
import random
import shutil
import struct
import sys
import tempfile
import time
import traceback
import types
import zlib

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
FIXTURE = (os.environ.get('BULLBA_REPLAY_SOURCE_FIXTURE')   # another stream, or a missing path for the synthetic one
           or os.path.join(REPO, 'tests', 'fixtures-local', 'replays', '2026-11-10-temp-live.wotreplay'))
FIXTURE_ARENA = 2309556418257344269
sys.dont_write_bytecode = True

checks = []
notes = []


def check(group, name, ok, detail=''):
    checks.append((group, name, bool(ok), detail))
    return bool(ok)


class Event(object):
    def __init__(self): self.handlers = []
    def __iadd__(self, h):
        self.handlers.append(h)
        return self
    def __isub__(self, h):
        self.handlers.remove(h)
        return self
    def __call__(self, *a):
        for h in list(self.handlers): h(*a)


class World(object):
    def __init__(self):
        self.callbacks = {}
        self.next = 1
        self.player = None
    def callback(self, delay, fn):
        self.next += 1
        self.callbacks[self.next] = fn
        return self.next
    def cancel(self, handle): self.callbacks.pop(handle, None)
    def pump(self):
        pending, self.callbacks = self.callbacks, {}
        for fn in pending.values(): fn()


WORLD = World()
EVENTS = types.ModuleType('PlayerEvents')


def write_final(path, stream):
    """NATIVE: a final .wotreplay - magic, one JSON block, stream and packed sizes, zlib of the stream padded to 8.
    The real file is Blowfish-encrypted after the sizes; the module reads only the plain header."""
    block = json.dumps({'playerName': 'stub'})
    packed = zlib.compress(bytes(stream))
    body = packed + '\0' * (-len(packed) % 8)
    with open(path, 'wb') as f:
        f.write(struct.pack('<II', 0x11343212, 1) + struct.pack('<I', len(block)) + block +
                struct.pack('<II', len(stream), len(packed)) + body)


class ReplayCtrl(object):
    """BattleReplay.g_replayCtrl: the Python side as in the bytecode, the native side imitated (NATIVE)."""
    def __init__(self, setting):
        self.isPlaying = False
        self.isServerSideReplay = False
        self.isRecording = False
        self._BattleReplay__fileName = None
        self._BattleReplay__isAutoRecordingEnabled = setting
        self.result = ('replay_last_battle', True) if setting != 2 else ('', False)
        self.calls = collections.Counter()
        self.stream = bytearray()
        self.flushed = 0
        self.stop_flushes = False       # NATIVE variant: the stop writes the unflushed tail to temp first
        self.stop_keeps_temp = False    # NATIVE variant: temp stays after the stop
        self.stop_writes_final = True   # NATIVE variant: no final file at all
        self.all_name = '20261111_2015_stub.wotreplay'

    # BattleReplay.record(fileName=None): temp, open 'wb', close, remove, startRecording, keep the name
    def record(self, fileName=None):
        self.calls['record'] += 1
        if self.isPlaying: return False
        if self.isRecording and not self.stop(): return False
        if not os.path.isdir('./replays'): os.makedirs('./replays')
        name = os.path.join('./replays', 'temp.wotreplay')
        open(name, 'wb').close()
        os.remove(name)
        self.isRecording = True                      # NATIVE startRecording: the file appears with the stream
        open(name, 'wb').close()
        self._BattleReplay__fileName = name
        self.stream, self.flushed = bytearray(), 0
        return True

    def setResultingFileName(self, fileName, overwriteExisting=False):
        self.calls['setResultingFileName'] += 1
        self.result = (fileName or '', overwriteExisting)

    def enableAutoRecordingBattles(self, enable, delete=False):
        self.calls['enableAutoRecordingBattles'] += 1

    def stop(self, rewindToTime=None, delete=False, isDestroyed=False):
        if not self.isPlaying and not self.isRecording: return False
        self.calls['stop'] += 1
        self.calls['stop delete' if delete else 'stop keep'] += 1
        temp = self._BattleReplay__fileName
        if self.stop_flushes: self.flush(everything=True)
        if not delete and self.stop_writes_final and self.stream:
            name = self.result[0] + '.wotreplay' if self.result[0] else self.all_name
            write_final(os.path.join('./replays', name), self.stream)
        if delete or not self.stop_keeps_temp:
            if temp and os.path.isfile(temp): os.remove(temp)
        self.isRecording = False
        self._BattleReplay__fileName = None
        return True

    def feed(self, data):
        """The battle's packets arrive; NATIVE: temp gets whole 4 KB blocks."""
        self.stream += data
        self.flush()

    def flush(self, everything=False):
        end = len(self.stream) if everything else len(self.stream) // 4096 * 4096
        if end > self.flushed and self.isRecording:
            with open(self._BattleReplay__fileName, 'ab') as f: f.write(bytes(self.stream[self.flushed:end]))
            self.flushed = end


def install_stubs(ctrl):
    m = types.ModuleType('BigWorld')
    m.callback, m.cancelCallback, m.player = WORLD.callback, WORLD.cancel, lambda: WORLD.player
    sys.modules['BigWorld'] = m
    m = types.ModuleType('BattleReplay')
    m.g_replayCtrl = ctrl
    sys.modules['BattleReplay'] = m
    EVENTS.g_playerEvents = types.ModuleType('events')
    for name in ('onAccountBecomePlayer', 'onAccountBecomeNonPlayer', 'onAvatarBecomePlayer', 'onAvatarBecomeNonPlayer'):
        setattr(EVENTS.g_playerEvents, name, Event())
    sys.modules['PlayerEvents'] = EVENTS


def packet(ptype, clock, payload):
    return bytearray(struct.pack('<IIf', len(payload), ptype, clock)) + payload


def synthetic(arena, size=400000, seed=1):
    rnd = random.Random(seed)
    out = packet(0x18, 0.0, bytearray('\x07\x00\x00\x002.4.1.0'))
    out += packet(0x00, 0.0, bytearray('\x21\x79\x0e\x00\x02\x00\x09RedBullba') + bytearray(struct.pack('<Q', arena)) +
                  bytearray(rnd.getrandbits(8) for _ in range(60)))
    clock = 0.0
    while len(out) < size:
        clock += 0.1
        out += packet(rnd.choice((0x08, 0x0a, 0x32, 0x37)), clock,
                      bytearray(rnd.getrandbits(8) for _ in range(rnd.randint(4, 900))))
    return out


class Game(object):
    """The client around one ReplaySource: the game's own handlers subscribed after the mod's (game.init order)."""
    def __init__(self, rs, folder, session, ctrl):
        self.rs, self.folder, self.session, self.ctrl = rs, folder, session, ctrl
        self.messages = []
        self.source = rs.ReplaySource(folder, session, lambda name, payload: self.messages.append((name, payload)),
                                      gate=lambda player: not getattr(player, 'observer', False), threaded=False)
        self.source.install()
        events = EVENTS.g_playerEvents
        events.onAccountBecomePlayer += self.game_account_become_player
        self.clock = 1000.0

    def game_account_become_player(self, *args):
        # BattleReplay.__onAccountBecomePlayer -> enableAutoRecordingBattles(True) -> __startAutoRecord -> record():
        # for the settings `last` and `all` (how `none` survives the login is not determined: it stays off here).
        if self.ctrl._BattleReplay__isAutoRecordingEnabled in (1, 2) and not self.ctrl.isRecording and not self.ctrl.isPlaying:
            self.ctrl.record()

    def login(self):
        WORLD.player = types.ModuleType('account')
        EVENTS.g_playerEvents.onAccountBecomePlayer()
        WORLD.pump()            # the mod's hangar check
        self.source.step()

    def battle(self, arena, stream, steps=12, observer=False):
        EVENTS.g_playerEvents.onAccountBecomeNonPlayer()
        player = types.ModuleType('avatar')
        player.arenaUniqueID, player.observer = arena, observer
        WORLD.player = player
        self.source.on_avatar_become_player(player)
        cut = sorted(set([0, len(stream)] + [len(stream) * i // steps for i in range(1, steps)]))
        for a, b in zip(cut, cut[1:]):
            self.ctrl.feed(stream[a:b])
            self.source.step()

    def leave(self):
        # PlayerAvatar.onBecomeNonPlayer: stop() when recording, then g_playerEvents.onAvatarBecomeNonPlayer.
        if self.ctrl.isRecording: self.ctrl.stop()
        self.source.on_avatar_become_non_player()
        self.source.step()
        if self.source.ending is not None: self.source.step(final=True)

    def replays(self):
        return dict((n, open(os.path.join('replays', n), 'rb').read()) for n in sorted(os.listdir('replays')))


def walk(data):
    """(whole packets, bytes after the last one) of a stream, by the packet headers."""
    off, count = 0, 0
    while off + 12 <= len(data):
        size = struct.unpack_from('<I', data, off)[0]
        if off + 12 + size > len(data): break
        off += 12 + size
        count += 1
    return count, len(data) - off


def read(path):
    with open(path, 'rb') as f: return bytearray(f.read())


def run(temp):
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import replay_source as rs
    logger = logging.getLogger('local.armor_inspector')
    captured = []
    class Capture(logging.Handler):
        def emit(self, record): captured.append(record)
    logger.addHandler(Capture())
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    if os.path.isfile(FIXTURE):
        main_arena, main_stream = FIXTURE_ARENA, read(FIXTURE)
        notes.append('stream: the 10.11 raw battle stream, %d bytes' % len(main_stream))
    else:
        main_arena, main_stream = 1726269409620419, synthetic(1726269409620419, 900000)
        notes.append('stream: synthetic (fixture %s absent on this clone)' % FIXTURE)
    other_arena, other_stream = 1754641962968727, synthetic(1754641962968727, 300000, seed=2)
    check('setup', 'the stream carries its arena id in packet 0x00', rs.arena_in_stream(main_stream, main_arena))
    check('setup', 'another arena id is not found there', rs.arena_in_stream(main_stream, other_arena) is False)

    def case(name, setting):
        game_dir = os.path.join(temp, name)
        os.makedirs(os.path.join(game_dir, 'replays'))
        os.chdir(game_dir)
        ctrl = ReplayCtrl(setting)
        install_stubs(ctrl)
        folder = os.path.join('mods', 'configs', 'local.armor_inspector', 'battles')
        # The player's own last replay from an older battle: must stay as it is unless his setting overwrites it.
        old = os.path.join('replays', 'replay_last_battle.wotreplay')
        write_final(old, bytearray('old battle'))
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        return ctrl, folder, Game(rs, folder, 'sess%s' % name, ctrl)

    def copy_of(game, arena, session=None):
        path = os.path.join(game.folder, '%s-%s.wotstream' % (arena, session or game.session))
        return read(path) if os.path.isfile(path) else None

    def only_message(group, game):
        ok = check(group, 'exactly one message to the export thread', len(game.messages) == 1 and game.messages[0][0] == 'replay',
                   [m[0] for m in game.messages])
        return game.messages[0][1] if ok else {}

    # ---- last: the player records ------------------------------------------------------------------------
    ctrl, folder, game = case('last', 1)
    game.login()
    check('last', 'the game records after the login; the mod started nothing', ctrl.isRecording and ctrl.calls['record'] == 1
          and ctrl.calls['setResultingFileName'] == 0 and game.source.owned is None, dict(ctrl.calls))
    game.battle(main_arena, main_stream)
    flushed = ctrl.flushed
    game.leave()
    copy = copy_of(game, main_arena)
    check('last', 'the copy is byte-identical to what the game flushed to temp', copy is not None and copy == main_stream[:flushed],
          (len(copy or ''), flushed))
    msg = only_message('last', game)
    check('last', 'message: this battle, the copy, its arena checked, not complete (the tail is in the final file only)',
          msg.get('battle') == '%s-%s' % (main_arena, game.session) and msg.get('streamBytes') == flushed
          and msg.get('arenaChecked') is True and msg.get('complete') is False and msg.get('end') == 'battle', msg)
    check('last', 'message: final = the replay_last_battle the game just wrote, the whole stream, not the mod\'s',
          (msg.get('final') or '').endswith('replay_last_battle.wotreplay') and msg.get('finalStreamBytes') == len(main_stream)
          and msg.get('finalOwned') is False and msg.get('recordingOwned') is False, msg)
    check('last', 'message: packets counted to the last whole one, the partial tail named',
          (msg.get('packets'), msg.get('partialBytes')) == walk(copy or bytearray()), (msg.get('packets'), msg.get('partialBytes')))
    check('last', 'the player\'s setting untouched', ctrl.calls['enableAutoRecordingBattles'] == 0
          and ctrl._BattleReplay__isAutoRecordingEnabled == 1)
    game.login()
    check('last', 'back in the hangar: the game records the next one, the mod still owns nothing',
          ctrl.isRecording and game.source.owned is None and len(game.messages) == 1)
    game.source.close()

    # ---- kept: the stop flushes everything and temp stays --------------------------------------------------
    ctrl, folder, game = case('kept', 1)
    ctrl.stop_flushes, ctrl.stop_keeps_temp = True, True
    game.login()
    game.battle(other_arena, other_stream)
    game.leave()
    msg = only_message('kept', game)
    check('kept', 'the copy is the whole stream and the message says complete, no final needed',
          copy_of(game, other_arena) == other_stream and msg.get('complete') is True and msg.get('final') is None
          and msg.get('partialBytes') == 0 and msg.get('temp') == 'kept', msg)
    game.source.close()

    # ---- nofinal: no final file appears ----------------------------------------------------------------------
    ctrl, folder, game = case('nofinal', 1)
    ctrl.stop_writes_final = False
    game.login()
    game.battle(other_arena, other_stream)
    flushed = ctrl.flushed
    game.leave()
    msg = only_message('nofinal', game)
    check('nofinal', 'cut off: the copy of what was flushed, no final, not complete; the old replay_last_battle not taken',
          copy_of(game, other_arena) == other_stream[:flushed] and msg.get('complete') is False and msg.get('final') is None, msg)
    game.source.close()

    # ---- all: the native code names the final file ------------------------------------------------------------
    ctrl, folder, game = case('all', 2)
    game.login()
    game.battle(other_arena, other_stream)
    game.leave()
    msg = only_message('all', game)
    check('all', 'final = the file the native code named, found by its time', (msg.get('final') or '').endswith(ctrl.all_name)
          and msg.get('finalOwned') is False, msg)
    game.source.close()

    # ---- none: the player's setting is off ----------------------------------------------------------------------
    ctrl, folder, game = case('none', 0)
    before = game.replays()
    game.login()
    check('none', 'the game did not record; the mod started it under its own resulting name',
          ctrl.isRecording and game.source.owned is not None and ctrl.result == (rs.OWN_RESULT_NAME, True), ctrl.result)
    game.battle(main_arena, main_stream)
    flushed = ctrl.flushed
    game.leave()
    msg = only_message('none', game)
    own = os.path.join('replays', rs.OWN_RESULT_NAME + '.wotreplay')
    check('none', 'the copy byte-identical; final = the mod\'s own file, to delete after reading',
          copy_of(game, main_arena) == main_stream[:flushed] and os.path.abspath(own) == msg.get('final')
          and msg.get('finalOwned') is True and msg.get('recordingOwned') is True, msg)
    check('none', 'the resulting name is the setting\'s again, the setting itself never written',
          ctrl.result == ('replay_last_battle', True) and ctrl.calls['enableAutoRecordingBattles'] == 0
          and ctrl._BattleReplay__isAutoRecordingEnabled == 0, (ctrl.result, dict(ctrl.calls)))
    after = game.replays()
    check('none', 'the player\'s folder: his replay_last_battle unchanged, no temp left, only the mod\'s final added',
          after.get('replay_last_battle.wotreplay') == before.get('replay_last_battle.wotreplay')
          and sorted(set(after) - set(before)) == [rs.OWN_RESULT_NAME + '.wotreplay'], sorted(after))
    os.remove(own)   # what the export thread does after reading it
    game.login()
    check('none', 'next hangar visit: the mod records again, owned, no battle yet', ctrl.isRecording and game.source.owned
          and not game.source.owned.get('battle'))

    # ---- logout: the mod's hangar recording with no battle -------------------------------------------------------
    EVENTS.g_playerEvents.onAccountBecomeNonPlayer()      # a logout, not a battle
    game.login()
    after = game.replays()
    check('logout', 'stopped with delete before the game\'s handler: no final file, his replay_last_battle unchanged',
          ctrl.calls['stop delete'] == 1 and after.get('replay_last_battle.wotreplay') == before.get('replay_last_battle.wotreplay')
          and rs.OWN_RESULT_NAME + '.wotreplay' not in after, (dict(ctrl.calls), sorted(after)))
    check('logout', 'still one message (none for a hangar recording)', len(game.messages) == 1, len(game.messages))
    game.source.close()
    check('logout', 'client exit with the mod\'s hangar recording: stopped and deleted',
          ctrl.calls['stop delete'] == 2 and not ctrl.isRecording, dict(ctrl.calls))

    # ---- crash: no end, the next start takes the rest of the temp file ---------------------------------------------
    for group, foreign in (('crash', False), ('foreign', True)):
        ctrl, folder, game = case(group, 1)
        game.login()
        game.battle(main_arena, main_stream[:len(main_stream) // 2], steps=5)
        taken = len(copy_of(game, main_arena))
        old_session = game.session
        ctrl.feed(main_stream[len(main_stream) // 2:])          # the game went on writing, then the client died
        on_disk = read(ctrl._BattleReplay__fileName)
        if foreign:
            # The temp file holds another battle by then (a session without the mod, a crash of the next battle).
            with open(ctrl._BattleReplay__fileName, 'wb') as f: f.write(bytes(synthetic(other_arena, len(on_disk) + 50000, seed=3)))
        EVENTS.g_playerEvents.onAccountBecomePlayer.handlers = []
        EVENTS.g_playerEvents.onAccountBecomeNonPlayer.handlers = []
        restarted = Game(rs, folder, 'sessnew', ctrl)
        restarted.source.step()
        msg = only_message(group, restarted)
        copy = copy_of(game, main_arena, old_session)
        if not foreign:
            check(group, 'the copy now holds all the temp file had: byte-identical', copy == on_disk and len(copy) > taken,
                  (len(copy), len(on_disk), taken))
            check(group, 'message: that battle (old session), end restart, no final, not complete',
                  msg.get('battle') == '%s-%s' % (main_arena, old_session) and msg.get('end') == 'restart'
                  and msg.get('complete') is False and msg.get('final') is None and msg.get('streamBytes') == len(on_disk), msg)
        else:
            check(group, 'not taken: the copy is what the crashed session had copied', copy == main_stream[:taken], (len(copy), taken))
            check(group, 'message: the cut-off copy, the temp file named foreign', msg.get('complete') is False
                  and (msg.get('temp') or '').startswith('foreign') and msg.get('streamBytes') == taken, msg)
        restarted.source.step()
        check(group, 'handed over once: a second look and a third start send nothing', len(restarted.messages) == 1)
        third = Game(rs, folder, 'sess3', ctrl)
        third.source.step()
        check(group, 'a third start sends nothing', not third.messages, third.messages)
        game.source.close()
        restarted.source.close()
        third.source.close()

    # ---- replay: a replay being played ------------------------------------------------------------------------
    ctrl, folder, game = case('replay', 1)
    ctrl.isPlaying = True
    game.login()
    game.battle(other_arena, other_stream)
    game.leave()
    check('replay', 'no record() call, no copy, no message', ctrl.calls['record'] == 0 and not os.path.isdir(folder)
          or not os.listdir(folder), (dict(ctrl.calls), os.listdir(folder) if os.path.isdir(folder) else None))
    check('replay', 'no message', not game.messages, game.messages)
    game.source.close()

    # ---- two battles in a row ----------------------------------------------------------------------------------
    ctrl, folder, game = case('two', 1)
    game.login()
    game.battle(main_arena, main_stream)
    first = ctrl.flushed
    game.leave()
    game.login()
    game.battle(other_arena, other_stream)
    second = ctrl.flushed
    game.leave()
    names = [m[1].get('battle') for m in game.messages]
    check('two', 'two messages, one per battle, in order', names == ['%s-%s' % (main_arena, game.session),
                                                                     '%s-%s' % (other_arena, game.session)], names)
    check('two', 'each copy byte-identical to its own stream', copy_of(game, main_arena) == main_stream[:first]
          and copy_of(game, other_arena) == other_stream[:second], (first, second))
    check('two', 'both arenas checked', all(m[1].get('arenaChecked') is True for m in game.messages))
    game.source.close()

    # ---- observer seat with the mod's own recording ------------------------------------------------------------
    ctrl, folder, game = case('observer', 0)
    game.login()
    game.battle(other_arena, other_stream, observer=True)
    game.leave()
    game.source.step(final=True)
    check('observer', 'a spectator seat: no copy, no message, the mod\'s own final removed', not game.messages
          and rs.OWN_RESULT_NAME + '.wotreplay' not in game.replays() and copy_of(game, other_arena) is None,
          (game.messages, sorted(game.replays())))
    game.source.close()

    if os.environ.get('BULLBA_REPLAY_SOURCE_LOG'):   # the module's log lines, to read what a battle will write
        notes.extend('%s %s' % (r.levelname, r.getMessage()) for r in captured)
    errors = [r for r in captured if r.levelno >= logging.ERROR]
    check('log', 'no ERROR logged', not errors, '; '.join(r.getMessage() for r in errors[:5]))
    lines = sorted(set(r.getMessage().split(':')[0] for r in captured))
    check('log', 'every line of the module starts with "Replay source"', lines == ['Replay source'], lines)


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-replaysrc27-')
    home = os.getcwd()
    crashed = None
    try:
        run(temp)
    except Exception:
        crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['replay source: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed), time.time() - started)]
    for group, name, ok, detail in failed:
        lines.append('FAIL [%s] %s%s' % (group, name, (' -- %s' % (detail,))[:600] if detail not in ('', None) else ''))
    if crashed: lines.append('FAIL [run] the script crashed:\n' + crashed)
    for text in notes: lines.append('note: ' + text)
    code = 1 if failed or crashed else 0
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if isinstance(text, unicode) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
