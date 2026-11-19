# -*- coding: utf-8 -*-
"""The replay limit (BACKLOG 107, 18.11.2026: replay_library.py, its use in replay_source / replay_run / playback) under
the client's own Python 2.7, on a staged folder - the game's folder is only read (the client's packages for the
definitions).

    python tests/py27/run27.py tests/py27/replay_library.py

The user: a third recording mode beside the game's "last battle" and "all" - the replays of his last N battles in the
game's own replays/ folder, one file per battle under the mod's marked name (bh_...), older ones removed by the mod, one
action keeps an important one forever (replays/bullba_hits/). Those same files are what Bullba Hits and its 3D player
decode again: such battles keep no stream.z. Off by default; off, nothing is renamed or removed.

Checks, by group:
  mode      off by default; N clamped to 1..100
  rename    after a battle (the replay source's own path: the battle's message, the copy of temp, its end, the final file
            found whole, the hand-over) the game's finished file is RENAMED in replays/ to bh_date_time_vehicle_map; no
            second copy; the hand-over names it
  retry     a rename the game refuses (its file held) is tried again at the next step and lands
  fallback  a rename that keeps failing for COPY_RETRY s: the file is copied instead (with its time), the game's file
            stays, the log says so; the copy counts like the others
  limit     at N = 3 the 4th battle's replay removes the oldest marked one
  keep      a kept replay moves to replays/bullba_hits/ and survives the battles after it; un-kept it is back in
            replays/ (nothing removed at once) and the next battle's replay removes it as the oldest
  foreign   unmarked files - the player's own (older than every marked one), another mod's, a file in bullba_hits/ the
            mod did not put there - and a marked replay the user renamed are never counted or touched; raw records untouched
  off       with the limit off nothing is renamed or removed
  page      data/replays.js: the mode, each battle's state, the battles the limit removed
  source    (the 3D player's fixture battle, its stream encrypted into a .wotreplay here, renamed by the limit) the replay
            job writes no stream.z and removes the raw copy, the file checked to be this battle's by its first chunk;
            decoded again later it reads that file (source 'kept replay')
  playback  the 3D player gets that file as it is (its source file; no stream.z, no raw copy); a battle whose replay the limit
            removed gets a file that says so in plain words
  log       no ERROR logged

The source and playback groups need tests/fixtures-local/playback-2026-11-18 and the client's packages (else SKIP of those
groups, said in the verdict). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
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
import zlib

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18')
BATTLE = '2315856430906286521-d36eff9b31bb'
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import replay_source as rs, replay_library as rl, replay_run as rr, replay_stream as rd

checks = []
notes = []


def check(group, name, ok, detail=''):
    checks.append((group, name, bool(ok), detail))
    return bool(ok)


class Lines(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self, logging.INFO)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class Errors(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self, logging.ERROR)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


# ---- files -------------------------------------------------------------------------------------------------------------
def packet(ptype, clock, payload):
    return bytearray(struct.pack('<IIf', len(payload), ptype, clock)) + payload


def synthetic(arena, size=60000, seed=1):
    """A raw stream: the version packet, the 0x00 packet with the arena id, filler packets."""
    rnd = random.Random(seed)
    out = packet(0x18, 0.0, bytearray('\x07\x00\x00\x002.4.1.1'))
    out += packet(0x00, 0.0, bytearray('\x21\x79\x0e\x00\x02\x00\x09RedBullba') + bytearray(struct.pack('<Q', int(arena)))
                  + bytearray(rnd.getrandbits(8) for _ in range(60)))
    clock = 0.0
    while len(out) < size:
        clock += 0.1
        out += packet(rnd.choice((0x08, 0x0a, 0x32)), clock, bytearray(rnd.getrandbits(8) for _ in range(rnd.randint(4, 900))))
    return out


def encrypt(plain):
    """The game's replay cipher: Blowfish-ECB of each 8-byte block XOR the previous plain block (replay_stream's decrypt
    undone), the client's key."""
    P, (S0, S1, S2, S3) = rd._blowfish_schedule(rd.REPLAY_KEY)

    def enc(l, r):
        for i in range(16):
            l ^= P[i]
            r ^= ((((S0[l >> 24] + S1[(l >> 16) & 255]) & 0xffffffff) ^ S2[(l >> 8) & 255]) + S3[l & 255]) & 0xffffffff
            l, r = r, l
        l, r = r, l
        return l ^ P[17], r ^ P[16]
    n = len(plain) // 8
    vals = struct.unpack('>%dI' % (2 * n), plain[:8 * n])
    out = [0] * (2 * n)
    pl = pr = 0
    for b in range(n):
        l, r = vals[2 * b], vals[2 * b + 1]
        out[2 * b], out[2 * b + 1] = enc(l ^ pl, r ^ pr)
        pl, pr = l, r
    return struct.pack('>%dI' % (2 * n), *out)


def write_final(path, stream, block, cipher=False):
    """A final .wotreplay: magic, one JSON block, the stream's and the packed sizes, zlib of the stream padded to 8 -
    encrypted as the game does when `cipher` (the replay source reads the plain header only)."""
    head = json.dumps(block)
    packed = zlib.compress(bytes(stream))
    body = packed + '\0' * (-len(packed) % 8)
    if cipher: body = encrypt(body)
    with open(path, 'wb') as f:
        f.write(struct.pack('<II', 0x11343212, 1) + struct.pack('<I', len(head)) + head
                + struct.pack('<II', len(stream), len(packed)) + body)


def read(path):
    with open(path, 'rb') as f: return f.read()


def listing(folder):
    try: return sorted(n for n in os.listdir(folder) if os.path.isfile(os.path.join(folder, n)))
    except OSError: return []


# ---- the replay source's path, battle by battle ------------------------------------------------------------------------
class Battles(object):
    def __init__(self, root):
        self.root = root
        self.replays = os.path.join(root, 'game', 'replays')
        self.cfg = os.path.join(root, 'cfg')
        for folder in (self.replays, os.path.join(self.cfg, 'battles')): os.makedirs(folder)
        self.messages = []
        self.library = rl.Library(self.replays, self.cfg)
        self.source = rs.ReplaySource(os.path.join(self.cfg, 'battles'), 'sess01', self.put, replay_dir=self.replays,
                                      threaded=False, library=self.library)
        self.now = time.time()
        self.names = {}

    def put(self, name, message):
        self.messages.append((name, message))

    def battle(self, k):
        """Battle k: arena 1000 + k, the setting `last` (the game's file replay_last_battle)."""
        self.now += 300.0
        arena = str(1000 + k)
        temp = os.path.join(self.replays, 'temp.wotreplay')
        stream = synthetic(arena, seed=k)
        with open(temp, 'wb') as f: f.write(bytes(stream))
        self.source.inbox.put(('battle', {'arena': arena, 'source': temp, 'owned': False, 'setting': 1, 'recording': True,
                                          'at': self.now}))
        self.source.step(now=self.now)
        final = os.path.join(self.replays, 'replay_last_battle.wotreplay')
        write_final(final, stream, {'dateTime': '18.11.2026 %02d:%02d:07' % (10 + k // 60, k % 60),
                                    'playerVehicle': 'ussr-R04_T-34', 'mapName': '02_malinovka'})
        os.utime(final, (self.now + 5, self.now + 5))
        self.written = read(final)
        self.source.inbox.put(('end', {'at': self.now + 1, 'recording': False}))
        self.source.step(now=self.now + 2)
        self.names[k] = arena + '-sess01'
        return self.names[k]

    def manifest(self):
        return self.library.read()

    def where(self, k):
        entry = self.manifest()['battles'].get(self.names[k])
        return self.library.where(entry) if entry and self.library.ours(entry) else None


def library_checks(root):
    b = Battles(root)
    replays = b.replays
    kept_dir = b.library.kept_root
    os.makedirs(kept_dir)
    old = os.path.join(replays, 'players_own.wotreplay')
    foreign = {old: 'the player\'s own replay, older than every replay of the mod',
               os.path.join(replays, '20261001_1200_other_mod.wotreplay'): 'a replay another mod or the game put there',
               os.path.join(kept_dir, 'kept_by_hand.wotreplay'): 'a file the mod did not put in bullba_hits/'}
    for path, text in foreign.items():
        with open(path, 'wb') as f: f.write(text)
    os.utime(old, (1e9, 1e9))
    record = os.path.join(b.cfg, 'battles', 'raw-record.jsonl')
    with open(record, 'wb') as f: f.write('{"type":"battle"}\n')
    game_file = os.path.join(replays, 'replay_last_battle.wotreplay')
    marked = lambda: sorted(n for n in listing(replays) if n.startswith(rl.MARK))

    check('mode', 'the replay limit is off by default', b.library.enabled() is False and b.library.limit() == 50)
    b.library.set_mode(True, 3)

    first = b.battle(1)
    path1 = b.where(1)
    message = b.messages[-1][1]
    check('rename', 'after the battle the game\'s finished file is RENAMED in replays/ to the mod\'s marked, readable name',
          path1 and os.path.dirname(path1) == replays and os.path.basename(path1) == 'bh_20261118_1001_ussr-R04_T-34_02_malinovka.wotreplay'
          and read(path1) == b.written and not os.path.exists(game_file), repr(listing(replays)))
    check('rename', 'one file per battle: no copy anywhere else', marked() == [os.path.basename(path1)] and listing(kept_dir) == ['kept_by_hand.wotreplay'])
    check('rename', 'the hand-over names the renamed file', message.get('library') == os.path.abspath(path1) and message.get('battle') == first,
          repr(message.get('library')))

    # A rename the game refuses (its file still open): tried again at the next step.
    real_add, failed = b.library.add, []

    def held(*args, **kw):
        if not failed:
            failed.append(args[0])
            raise IOError('the file is held by the game (simulated)')
        return real_add(*args, **kw)
    b.library.add = held
    b.battle(2)
    check('retry', 'a rename that failed has not happened yet and is waiting', b.where(2) is None and len(b.source.copies) == 1
          and os.path.isfile(game_file), '%r %r' % (b.where(2), b.source.copies))
    b.source.step(now=b.now + 4)
    check('retry', 'tried again at the next step, it is renamed', b.where(2) is not None and not b.source.copies
          and failed == [b.names[2]] and not os.path.exists(game_file))
    b.library.add = real_add

    b.battle(3)
    check('limit', 'three battles, three marked replays (N = 3)', all(b.where(k) for k in (1, 2, 3)) and len(marked()) == 3, repr(marked()))
    b.battle(4)
    check('limit', 'the 4th battle\'s replay removes the oldest marked one', not os.path.exists(path1) and b.where(1) is None
          and all(b.where(k) for k in (2, 3, 4)) and b.library.status(b.names[1]) == 'removed', repr(marked()))

    check('keep', 'keep forever: the marked file moves to replays/bullba_hits/', b.library.keep(b.names[2], True)
          and os.path.dirname(b.where(2)) == kept_dir and b.library.status(b.names[2]) == 'kept', repr(b.where(2)))
    b.battle(5)
    check('keep', 'a kept one does not count: the 5th battle removes nothing (2 kept; 3, 4, 5 under the limit)',
          all(b.where(k) for k in (2, 3, 4, 5)))
    renamed = os.path.join(replays, 'my_best_game.wotreplay')
    os.rename(b.where(3), renamed)
    b.battle(6)
    check('foreign', 'a marked replay the user renamed stops being the mod\'s: not counted, not removed, its battle says gone',
          os.path.isfile(renamed) and b.library.status(b.names[3]) == 'gone' and all(b.where(k) for k in (4, 5, 6)), repr(marked()))
    check('keep', 'the kept one survives the battles after it', os.path.isfile(b.where(2)))
    path2 = b.where(2)
    check('keep', 'un-kept: back in replays/, nothing removed at once', b.library.keep(b.names[2], False)
          and os.path.dirname(b.where(2)) == replays and b.library.status(b.names[2]) == 'rolling' and not os.path.exists(path2)
          and all(b.where(k) for k in (4, 5, 6)), repr(marked()))
    path2, path4 = b.where(2), b.where(4)
    b.battle(7)
    check('keep', 'back under the limit: the next battle\'s replay removes it as the oldest (with the 4th)',
          not os.path.exists(path2) and not os.path.exists(path4) and all(b.where(k) for k in (5, 6, 7)) and len(marked()) == 3,
          repr(marked()))

    # The rename keeps failing until COPY_RETRY: the file is copied instead, and the log says so.
    seen = Lines()
    log = logging.getLogger('local.armor_inspector')
    log.addHandler(seen)
    level = log.level
    log.setLevel(logging.INFO)

    def refused(*args, **kw):
        if not kw.get('copy'): raise IOError('the file is held by the game (simulated)')
        return real_add(*args, **kw)
    b.library.add = refused
    b.battle(8)
    b.source.step(now=b.now + 10)
    waiting = b.where(8) is None and len(b.source.copies) == 1
    b.source.step(now=b.now + 2 + rs.COPY_RETRY + 1)
    b.library.add = real_add
    log.removeHandler(seen)
    log.setLevel(level)
    check('fallback', 'a rename that keeps failing: the file is copied instead, the game\'s file stays, the log says so',
          waiting and b.where(8) is not None and read(b.where(8)) == b.written and os.path.isfile(game_file)
          and any('COPIED' in line and 'the rename kept failing' in line for line in seen.lines), repr(seen.lines[-3:]))
    check('fallback', 'the copied one counts like the others (N = 3: the 5th went)', b.where(5) is None
          and all(b.where(k) for k in (6, 7, 8)) and len(marked()) == 3, repr(marked()))

    # The limit off: the game's own setting rules - nothing renamed, nothing removed.
    b.library.set_mode(False, 3)
    before = marked()
    b.battle(9)
    check('off', 'with the limit off nothing is renamed or removed: the game\'s file stays where it lies',
          marked() == before and b.where(9) is None and read(game_file) == b.written and not b.source.copies
          and b.messages[-1][1].get('library') is None, repr(marked()))

    for path, text in foreign.items():
        check('foreign', 'never counted, never touched: %s' % text, os.path.isfile(path) and read(path) == text, path)
    check('foreign', 'the raw battle records are untouched', read(record) == '{"type":"battle"}\n')
    check('foreign', 'unmarked files in replays/ are exactly those that were there, the user\'s renamed one and the game\'s',
          sorted(n for n in listing(replays) if not n.startswith(rl.MARK)) == sorted(['20261001_1200_other_mod.wotreplay', 'my_best_game.wotreplay',
                                                                                    'players_own.wotreplay', 'replay_last_battle.wotreplay', 'temp.wotreplay']),
          repr(listing(replays)))

    from local_armor_inspector.exporter import read_data_file
    view = read_data_file(os.path.join(b.cfg, 'data', 'replays.js'))
    check('page', 'data/replays.js: the mode, each battle\'s state, the battles the limit removed',
          view['enabled'] is False and view['limit'] == 3 and view['battles'] == {b.names[6]: 'rolling', b.names[7]: 'rolling', b.names[8]: 'rolling'}
          and view['removed'] == sorted([b.names[1], b.names[2], b.names[4], b.names[5]]) and view['streams'] == [], repr(view))
    check('mode', 'N is clamped to 1..100', b.library.set_mode(True, 500) == (True, 100) and b.library.set_mode(False, 0) == (False, 1)
          and b.library.set_mode(False, 'x') == (False, 50))
    return b


# ---- the replay job and the 3D player on a kept copy ---------------------------------------------------------------------
def stage(folder):
    for sub in ('battles', 'replay', os.path.join('data', 'vehicles'), os.path.join('data', 'models')):
        source = os.path.join(FIXTURE, sub)
        target = os.path.join(folder, sub)
        if not os.path.isdir(target): os.makedirs(target)
        for name in os.listdir(source):
            if name.endswith(rr.STREAM_EXT): continue      # the battle has no stream.z: its replay is the folder's copy
            shutil.copyfile(os.path.join(source, name), os.path.join(target, name))


def source_checks(root):
    from local_armor_inspector import exporter, playback, map_raw
    arena = BATTLE.split('-', 1)[0]
    cfg = os.path.join(root, 'cfg2')
    replays = os.path.join(root, 'game2', 'replays')
    os.makedirs(replays)
    stage(cfg)
    stream = bytearray(zlib.decompress(read(os.path.join(FIXTURE, 'replay', BATTLE + rr.STREAM_EXT))))
    final = os.path.join(replays, 'replay_last_battle.wotreplay')
    started = time.time()
    write_final(final, stream, {'dateTime': '14.11.2026 21:58:12', 'playerVehicle': 'germany-G_Test', 'mapName': '02_malinovka'},
                cipher=True)
    notes.append('the fixture\'s stream encrypted into a .wotreplay in %.1f s' % (time.time() - started))
    library = rl.Library(replays, cfg)
    library.set_mode(True, 50)
    copy = library.add(BATTLE, final, started, arena)
    check('source', 'the limit on: the game\'s file renamed, one file of the battle', not os.path.exists(final)
          and os.path.basename(copy).startswith(rl.MARK) and os.path.dirname(copy) == os.path.abspath(replays), repr(copy))
    check('source', 'the copy is this battle\'s by its first chunk (arena id, the start of the stream used)',
          rr.library_matches(copy, arena, stream[:4096]) and not rr.library_matches(copy, '12345', stream[:4096])
          and not rr.library_matches(copy, arena, bytearray(4096)))

    class Converter(object):
        """Records of the battle: its header and a roster - what the job checks; the conversion itself is not this test's."""
        def feed(self, event): return []
        def finish(self): return [{'type': 'battle', 'arenaId': arena}, {'type': 'roster', 'vehicles': []}]

    class Stand(exporter.Exporter):
        def client(self): return None
        def replay_converter(self, name, header, definitions): return Converter()
        def replay_estimates_steps(self, battle_id, records, out=None): return iter(())
        def replay_live_again(self, name): pass
        def publish_replay_steps(self, name, records, live, info, notes, store, out):
            out['report'] = {}
            self.published_info = dict(info)
            return iter(())

    stand = Stand(GAME, cfg, '2.4.1.1')
    stand.recorder = None
    stand.replays_folder = replays
    stand.replay_defs()

    def drain():
        began = time.time()
        while stand.jobs and time.time() - began < 150:
            stand.last_job = 0
            stand.run_job()

    raw = os.path.join(cfg, 'battles', BATTLE + rr.RAW_EXT)
    with open(raw, 'wb') as f: f.write(bytes(stream))
    stand.replay_stream({'schema': 1, 'battle': BATTLE, 'arenaId': arena, 'stream': raw, 'streamBytes': len(stream),
                         'complete': True, 'end': 'battle', 'final': None, 'finalOwned': False, 'library': copy})
    drain()
    entry = stand.replay_state().get(BATTLE) or {}
    kept = stand.replay_stream_path(BATTLE)
    check('source', 'the replay job of a battle whose replay the limit took: no stream.z, the raw copy removed, the replay kept',
          entry.get('status') == 'used' and (entry.get('stream') or {}).get('kept') == 'replay folder' and not os.path.exists(kept)
          and not os.path.exists(raw) and os.path.isfile(copy), repr((entry.get('status'), entry.get('stream'), os.listdir(os.path.join(cfg, 'replay')))))
    # Decoded again later (its stored records unreadable, a store older than a format): pending without a stream.
    entry['status'] = 'pending'
    stand.write_replay_state()
    stand.replay_stream({'battle': BATTLE, 'arenaId': arena})
    drain()
    entry = stand.replay_state().get(BATTLE) or {}
    check('source', 'decoded again later it reads that replay (source \'kept replay\'), still no stream.z',
          entry.get('status') == 'used' and (entry.get('stream') or {}).get('from') == 'kept replay' and not os.path.exists(kept),
          repr((entry.get('status'), entry.get('stream'))))

    # The 3D player's file from the kept copy (the map's raw files are tests/py27/playback_job.py's: not copied here).
    copy_steps = map_raw.copy_steps
    map_raw.copy_steps = lambda game, root, arena, report: iter(())
    try:
        stand.request_playback(BATTLE)
        drain()
        path = playback.data_path(cfg, BATTLE)
        value = exporter.read_data_file(path) if os.path.isfile(path) else None
        import base64
        source = (value or {}).get('source') or {} if isinstance(value, dict) else {}
        held = exporter.read_data_file(playback.source_path(cfg, BATTLE)) if os.path.isfile(playback.source_path(cfg, BATTLE)) else None
        check('playback', 'the 3D player gets that replay as it is (no stream.z, no raw copy): its source file holds it',
              isinstance(value, dict) and not value.get('error') and source.get('kind') == 'wotreplay'
              and source.get('size') == os.path.getsize(copy) and held is not None and base64.b64decode(held) == read(copy)
              and not os.path.exists(kept) and not os.path.exists(raw),
              repr((value or {}).get('error') or source if isinstance(value, dict) else value))
        # A battle whose replay the limit removed: its record is there, its replay is not.
        other = '2315856430906286522-aaaaaaaaaaaa'
        shutil.copyfile(os.path.join(cfg, 'battles', BATTLE + '.jsonl'), os.path.join(cfg, 'battles', other + '.jsonl'))
        state = library.read()
        state['removed'][other] = {'at': time.time(), 'why': 'limit'}
        library.write(state)
        stand.request_playback(other)
        drain()
        value = exporter.read_data_file(playback.data_path(cfg, other))
        check('playback', 'a battle whose replay the limit removed: its file says so in plain words',
              (value or {}).get('error') == playback.W_REMOVED % library.limit(), repr(value))
    finally:
        map_raw.copy_steps = copy_steps


def main():
    errors = Errors()
    log = logging.getLogger('local.armor_inspector')
    log.addHandler(errors)
    root = tempfile.mkdtemp(prefix='bullba-replay-library-')
    started = time.time()
    try:
        try:
            library_checks(root)
            if os.path.isdir(FIXTURE) and os.path.isdir(os.path.join(GAME, 'res', 'packages')):
                source_checks(root)
            else:
                notes.append('SKIP of the groups source and playback: no fixture %s or no client packages at %s' % (FIXTURE, GAME))
        except Exception:
            return finish(['FAIL [run] the script crashed:\n' + traceback.format_exc()], 1)
        check('log', 'no ERROR logged', not errors.lines, repr(errors.lines[:3]))
    finally:
        log.removeHandler(errors)
        shutil.rmtree(root, True)
    failed = [c for c in checks if not c[2]]
    lines = ['replay_library: %d checks, %d failed (%.1f s)%s' % (len(checks), len(failed), time.time() - started,
                                                                  ''.join('; ' + n for n in notes))]
    lines += ['FAIL [%s] %s -- %s' % (g, n, d) for g, n, _, d in failed]
    return finish(lines, 1 if failed else 0)


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if not isinstance(text, bytes) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
