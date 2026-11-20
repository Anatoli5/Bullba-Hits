# -*- coding: utf-8 -*-
"""The replay limit as the one store of replays (BACKLOG 107; redone 20.11.2026: replay_library.py, its use in
replay_source / replay_run / replay_files / playback) under the client's own Python 2.7, on a staged folder - the game's
folder is only read (the client's packages for the definitions).

    python tests/py27/run27.py tests/py27/replay_library.py

The user (20.11): one store - ordinary .wotreplay files in the game's own replays/ folder, the mod's marked bh_; a third
replay mode beside the game's "last battle" and "all", ON by default (N = 50); the game's own file left alone (the mod
COPIES it); kept forever = the bh_ mark removed from the name; which battle a file is, by its header; no lasting stream
copy in the mod's folder; a crashed battle's temp file picked up.

Checks, by group:
  mode      on by default (no manifest), N 50; N clamped to 1..100; an old (format 2) manifest's explicit off kept
  copy      after a battle under the game's `last` (the replay source's own path: its message, the copy of temp, its end,
            the final file found whole, the hand-over) the game's replay_last_battle is COPIED to bh_date_time_vehicle_map;
            the game's file stays byte for byte; the hand-over names the copy
  verify    a replay_last_battle that belongs to another battle (its first chunk: another arena id, another start) is
            never copied; no .part left
  retry     a copy that fails (the file held) is tried again at the next step and lands
  limit     N + 3 battles at N = 3: exactly N marked files (the ACCEPTANCE number), the game's file untouched beside them
            and the one kept forever unmarked beside them
  keep      kept forever: the mark removed, the file stays in replays/, not counted; un-kept: the mark back, counted again,
            removed as the oldest by the next battle
  header    a bh_ file the player renamed: not counted, its battle 'gone' for the limit - but still found as the battle's
            replay by its header (the replay files' scan, the file's first chunk)
  own       the game's setting `none`: the mod's own recording RENAMED to bh_ (no duplicate)
  all       the game's setting `all`: nothing made, nothing removed; the battle tied to the game's own file ('game')
  off       with the limit off nothing is copied, renamed or removed
  old       a format-2 entry kept in replays/bullba_hits/ is still the battle's; un-kept it comes back marked into replays/
  foreign   unmarked files are never counted or touched; raw records untouched
  crash     a battle not handed over (a crash): the next start takes its temp.wotreplay into the copy and hands it over
  page      data/replays.js: the mode, the game's setting, each battle's state, the battles the limit removed
  store     no stream.z made in the mod's folder by any of it
  source    (the 3D player's fixture battle, its stream encrypted into a .wotreplay here, copied by the limit) the replay
            job writes no stream.z and removes the raw copy; with no replay file and its records stored it removes the raw
            copy too (ACCEPTANCE: neither a stream.z nor a .wotstream of a consumed battle is left); decoded again later it
            reads the replay file (source 'kept replay')
  fragment  (BACKLOG 115) a crashed battle's fragment, 40 % of the fixture's stream cut inside a packet: ACCEPTANCE one
            bh_..._unfinished.wotreplay in replays/ whose decoded stream equals the fragment's whole packets, its header
            from the mod's record, in the manifest under the limit, read by playback.Job.source; built under the game's
            "all" too; none with the limit off; a build failure is one log line, no .part, the battle as published
  playback  the 3D player gets that file as it is; a battle whose replay the limit removed gets a file that says so
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
LAST = 'replay_last_battle.wotreplay'
OWN = rs.OWN_RESULT_NAME + rs.REPLAY_EXT


class Battles(object):
    def __init__(self, root):
        self.root = root
        self.replays = os.path.join(root, 'game', 'replays')
        self.cfg = os.path.join(root, 'cfg')
        for folder in (self.replays, os.path.join(self.cfg, 'battles')): os.makedirs(folder)
        self.messages = []
        self.library = rl.Library(self.replays, self.cfg)
        self.source = self.new_source()
        self.now = time.time() - 100000.0
        self.names = {}
        self.written = None

    def new_source(self):
        return rs.ReplaySource(os.path.join(self.cfg, 'battles'), 'sess01', self.put, replay_dir=self.replays,
                               threaded=False, library=self.library)

    def put(self, name, message):
        self.messages.append((name, message))

    def battle(self, k, setting=1, wrong=False, owned=False, game_name=None, end=True):
        """Battle k: arena 1000 + k. The game's setting `last` (1: its file replay_last_battle), `none` (0, `owned`: the
        mod's own recording) or `all` (2: a file the game names, `game_name`). `wrong`: the final file the game leaves is
        another battle's replay. `end`: False for a battle that never ends (a crash)."""
        self.now += 300.0
        arena = str(1000 + k)
        temp = os.path.join(self.replays, 'temp.wotreplay')
        stream = synthetic(arena, size=20000, seed=k)
        with open(temp, 'wb') as f: f.write(bytes(stream))
        self.source.inbox.put(('battle', {'arena': arena, 'source': temp, 'owned': owned, 'setting': setting,
                                          'recording': True, 'at': self.now}))
        self.source.step(now=self.now)
        self.names[k] = arena + '-sess01'
        self.stream = stream
        if not end: return self.names[k]
        if owned: final = os.path.join(self.replays, OWN)
        elif setting == 2: final = os.path.join(self.replays, game_name or '20261118_%04d_all.wotreplay' % k)
        else: final = os.path.join(self.replays, LAST)
        written = synthetic(str(9000 + k), size=20000, seed=100 + k) if wrong else stream
        write_final(final, written, {'dateTime': '18.11.2026 %02d:%02d:07' % (10 + k // 60, k % 60),
                                     'playerVehicle': 'ussr-R04_T-34', 'mapName': '02_malinovka'}, cipher=True)
        os.utime(final, (self.now + 5, self.now + 5))
        self.final, self.written = final, read(final)
        self.source.inbox.put(('end', {'at': self.now + 1, 'recording': False}))
        self.source.step(now=self.now + 2)
        return self.names[k]

    def manifest(self):
        return self.library.read()

    def where(self, k):
        entry = self.manifest()['battles'].get(self.names[k])
        return self.library.where(entry) if entry and self.library.ours(entry) else None


def library_checks(root):
    from local_armor_inspector import replay_files
    b = Battles(root)
    replays = b.replays
    old = os.path.join(replays, 'players_own.wotreplay')
    foreign = {old: 'the player\'s own replay, older than every replay of the mod',
               os.path.join(replays, '20261001_1200_other_mod.wotreplay'): 'a replay another mod or the game put there'}
    for path, text in foreign.items():
        with open(path, 'wb') as f: f.write(text)
    os.utime(old, (1e9, 1e9))
    record = os.path.join(b.cfg, 'battles', 'raw-record.jsonl')
    with open(record, 'wb') as f: f.write('{"type":"battle"}\n')
    game_file = os.path.join(replays, LAST)
    marked = lambda: sorted(n for n in listing(replays) if n.startswith(rl.MARK))

    check('mode', 'the replay limit is ON by default (no manifest), N 100', b.library.enabled() is True and b.library.limit() == 100
          and not os.path.exists(b.library.manifest))
    b.library.set_mode(True, 3)

    # 1: the game's file copied, left alone.
    first = b.battle(1)
    path1 = b.where(1)
    message = b.messages[-1][1]
    check('copy', 'after the battle the game\'s replay_last_battle is COPIED in replays/ to the mod\'s marked, readable name',
          path1 and os.path.dirname(path1) == replays and os.path.basename(path1) == 'bh_20261118_1001_ussr-R04_T-34_02_malinovka.wotreplay'
          and read(path1) == b.written, repr(listing(replays)))
    check('copy', 'the game\'s own file stays as the game wrote it', read(game_file) == b.written)
    check('copy', 'the hand-over names the copy', message.get('library') == os.path.abspath(path1) and message.get('battle') == first,
          repr(message.get('library')))

    # 2: a copy the game refuses (its file held): tried again at the next step.
    real_add, failed = b.library.add, []

    def held(*args, **kw):
        if not failed:
            failed.append(args[0])
            raise IOError('the file is held by the game (simulated)')
        return real_add(*args, **kw)
    b.library.add = held
    b.battle(2)
    check('retry', 'a copy that failed has not happened yet and is waiting', b.where(2) is None and len(b.source.copies) == 1,
          '%r %r' % (b.where(2), b.source.copies))
    b.source.step(now=b.now + 4)
    check('retry', 'tried again at the next step, it is copied', b.where(2) is not None and not b.source.copies
          and failed == [b.names[2]] and read(game_file) == b.written)
    b.library.add = real_add

    # 3: the game's file is another battle's replay (overwritten meanwhile, or an earlier one): never copied.
    before = marked()
    b.battle(3, wrong=True)
    check('verify', 'a replay_last_battle of another battle (its first chunk: another arena id and start) is not copied',
          b.where(3) is None and marked() == before and b.messages[-1][1].get('library') is None
          and not [n for n in listing(replays) if n.endswith('.part')] and not b.source.copies, repr(listing(replays)))
    check('verify', 'the check itself: this battle\'s file passes, another\'s fails', rl.this_battle(path1, '1001', b'')
          and not rl.this_battle(path1, '1002', b'') and not rl.this_battle(game_file, '1003', bytes(b.stream[:4096])))

    b.battle(4)
    check('keep', 'keep forever: the mark removed, the file stays in replays/', b.library.keep(b.names[2], True)
          and os.path.dirname(b.where(2)) == replays and os.path.basename(b.where(2)) == '20261118_1002_ussr-R04_T-34_02_malinovka.wotreplay'
          and b.library.status(b.names[2]) == 'kept' and not os.path.isdir(os.path.join(replays, rl.KEPT)), repr(b.where(2)))
    kept2 = b.where(2)
    b.battle(5)
    b.battle(6)
    check('limit', 'the 6th battle removes the oldest marked one (1); the kept one does not count',
          b.where(1) is None and not os.path.exists(path1) and b.library.status(b.names[1]) == 'removed'
          and all(b.where(k) for k in (2, 4, 5, 6)), repr(marked()))
    renamed = os.path.join(replays, 'my_best_game.wotreplay')
    os.rename(b.where(4), renamed)
    b.battle(7)
    check('header', 'a marked replay the player renamed: not counted, not removed, its battle \'gone\' for the limit',
          os.path.isfile(renamed) and b.library.status(b.names[4]) == 'gone' and all(b.where(k) for k in (5, 6, 7)), repr(marked()))
    for _ in replay_files.Scan(b.cfg, replays, b.library).steps(): pass
    check('header', 'still found as its battle\'s replay by its header (the scan, the file\'s first chunk)',
          b.library.file_of(b.names[4]) == os.path.abspath(renamed) and b.library.file_of(b.names[5]) == os.path.abspath(b.where(5)),
          repr(b.library.file_of(b.names[4])))
    b.battle(8)
    # ACCEPTANCE: N + 3 (and more) battles copied at N = 3 under `last`.
    names = marked()
    check('limit', 'ACCEPTANCE: after %d battles copied at N = 3: exactly 3 marked files, the game\'s replay_last_battle untouched '
          '(the last battle\'s, byte for byte), the kept one unmarked beside them' % 7,
          len(names) == 3 and all(b.where(k) for k in (6, 7, 8)) and read(game_file) == b.written
          and os.path.isfile(kept2) and not rl.marked(kept2), repr(names))
    notes.append('acceptance: %d marked .wotreplay at N = 3 after 7 copied battles, + %s, + kept %s'
                 % (len(names), LAST, os.path.basename(kept2)))

    check('keep', 'un-kept: the mark back, in replays/, nothing removed at once', b.library.keep(b.names[2], False)
          and rl.marked(b.where(2)) and os.path.dirname(b.where(2)) == replays and not os.path.exists(kept2)
          and b.library.status(b.names[2]) == 'rolling' and len(marked()) == 4, repr(marked()))
    path2, path6 = b.where(2), b.where(6)
    b.battle(9)
    check('keep', 'back under the limit: the next battle\'s replay removes it as the oldest (with the 6th)',
          not os.path.exists(path2) and not os.path.exists(path6) and all(b.where(k) for k in (7, 8, 9)) and len(marked()) == 3,
          repr(marked()))

    # The game's setting `none`: the mod's own recording is the mod's file - renamed, no duplicate.
    b.battle(10, setting=0, owned=True)
    check('own', 'the setting `none`: the mod\'s own recording RENAMED to bh_ (no duplicate), the oldest marked one removed',
          b.where(10) is not None and not os.path.exists(os.path.join(replays, OWN)) and read(b.where(10)) == b.written
          and all(b.where(k) for k in (8, 9, 10)) and b.where(7) is None and len(marked()) == 3, repr(listing(replays)))

    # The game's setting `all`: the game keeps every replay - nothing made, the battle tied to the game's file.
    b.source.inbox.put(('setting', 2))
    before = marked()
    b.battle(11, setting=2)
    all_file = b.final
    check('all', 'the setting `all`: no bh_ file made, none removed; the battle tied to the game\'s own file',
          marked() == before and b.library.status(b.names[11]) == 'game' and b.library.file_of(b.names[11]) == os.path.abspath(all_file)
          and read(all_file) == b.written and b.library.keep(b.names[11], True) is False, repr(listing(replays)))
    check('all', 'the page is told the game keeps all', b.library.view()['gameSetting'] == 2)
    b.source.inbox.put(('setting', 1))

    # The limit off: the game's own setting rules - nothing copied, nothing removed.
    b.library.set_mode(False, 3)
    before = marked()
    b.battle(12)
    check('off', 'with the limit off nothing is copied or removed', marked() == before and b.where(12) is None
          and read(game_file) == b.written and not b.source.copies and b.messages[-1][1].get('library') is None, repr(marked()))

    # A crash: the battle began, the client died; the next start takes its temp file.
    b.library.set_mode(True, 3)
    crashed = b.battle(13, end=False)
    temp_bytes = bytes(b.stream)
    b.source = b.new_source()
    b.source.step(now=b.now + 50)
    message = b.messages[-1][1]
    check('crash', 'after a crash the next start takes the battle\'s temp.wotreplay and hands it over (no final file: no replay file)',
          message.get('battle') == crashed and message.get('end') == 'restart' and message.get('stream')
          and read(message['stream']) == temp_bytes and message.get('final') is None and b.where(13) is None, repr(message))

    for path, text in foreign.items():
        check('foreign', 'never counted, never touched: %s' % text, os.path.isfile(path) and read(path) == text, path)
    check('foreign', 'the raw battle records are untouched', read(record) == '{"type":"battle"}\n')

    from local_armor_inspector.exporter import read_data_file
    view = read_data_file(os.path.join(b.cfg, 'data', 'replays.js'))
    check('page', 'data/replays.js: the mode, the game\'s setting, each battle\'s state, the battles the limit removed',
          view['enabled'] is True and view['limit'] == 3 and view['gameSetting'] == 1
          and view['battles'] == {b.names[8]: 'rolling', b.names[9]: 'rolling', b.names[10]: 'rolling', b.names[11]: 'game'}
          and b.names[1] in view['removed'] and b.names[4] not in view['removed'] and view['streams'] == [] and 'keptFolder' not in view,
          repr(view))
    check('store', 'no stream.z in the mod\'s folder', not [n for n in listing(os.path.join(b.cfg, 'replay')) if n.endswith(rr.STREAM_EXT)])
    check('mode', 'N is clamped to 1..100', b.library.set_mode(True, 500) == (True, 100) and b.library.set_mode(False, 0) == (False, 1)
          and b.library.set_mode(False, 'x') == (False, 100))
    # 1.19: the default N 100; a manifest before it wrote 50 whether or not it was chosen
    def manifest_n(value):
        state = json.loads(open(b.library.manifest, 'rb').read().decode('utf-8'))
        state.pop('limitChosen', None); state.update(value)
        with open(b.library.manifest, 'wb') as f: f.write(json.dumps(state).encode('utf-8'))
        return b.library.limit()
    check('mode', 'a 1.18 manifest: 50 with no limitChosen reads as the new default 100; another N is kept; a chosen 50 stays',
          manifest_n({'limit': 50}) == 100 and manifest_n({'limit': 30}) == 30 and manifest_n({'limit': 50, 'limitChosen': True}) == 50)
    old_checks(root)
    return b


def old_checks(root):
    """A manifest of the old layout (format 2): kept replays moved into replays/bullba_hits/."""
    replays = os.path.join(root, 'game3', 'replays')
    cfg = os.path.join(root, 'cfg3')
    os.makedirs(os.path.join(replays, rl.KEPT))
    os.makedirs(os.path.join(cfg, 'replay'))
    with open(os.path.join(replays, rl.KEPT, 'bh_old.wotreplay'), 'wb') as f: f.write('old')
    library = rl.Library(replays, cfg)
    with open(library.manifest, 'wb') as f:
        f.write(json.dumps({'format': 2, 'enabled': True, 'limit': 5,
                            'battles': {'777-s': {'file': 'bh_old.wotreplay', 'kept': True}}}))
    check('old', 'an old entry kept in replays/bullba_hits/ is still the battle\'s', library.status('777-s') == 'kept'
          and library.file_of('777-s') == os.path.abspath(os.path.join(replays, rl.KEPT, 'bh_old.wotreplay')))
    check('old', 'un-kept it comes back marked into replays/', library.keep('777-s', False) and library.status('777-s') == 'rolling'
          and os.path.isfile(os.path.join(replays, 'bh_old.wotreplay')), repr(listing(replays)))
    with open(library.manifest, 'wb') as f: f.write(json.dumps({'format': 2, 'enabled': False, 'limit': 5, 'battles': {}}))
    check('mode', 'an old manifest\'s explicit off is kept', library.enabled() is False)


# ---- the replay job and the 3D player on a kept copy ---------------------------------------------------------------------
def stage(folder):
    for sub in ('battles', 'replay', os.path.join('data', 'vehicles'), os.path.join('data', 'models')):
        source = os.path.join(FIXTURE, sub)
        target = os.path.join(folder, sub)
        if not os.path.isdir(target): os.makedirs(target)
        for name in os.listdir(source):
            if name.endswith(rr.STREAM_EXT): continue      # the battle has no stream.z: its replay is the folder's copy
            shutil.copyfile(os.path.join(source, name), os.path.join(target, name))


def whole_packets(data):
    """The bytes of `data` up to the end of its last whole packet (12-byte header + payload)."""
    off = 0
    while off + 12 <= len(data):
        size = struct.unpack_from('<I', data, off)[0]
        if off + 12 + size > len(data): break
        off += 12 + size
    return bytes(data[:off])


def fragment_checks(stand, drain, library, cfg, replays, arena, stream):
    """BACKLOG 115 (20.11): a crashed battle's fragment (the next start took the game's temp file, no final file) becomes a
    replay file: bh_<date_time_vehicle_map>_unfinished.wotreplay in replays/, its stream the fragment's whole packets."""
    from local_armor_inspector import playback
    raw_of = lambda n: os.path.join(cfg, 'battles', n + rr.RAW_EXT)
    cut = bytearray(stream[:int(len(stream) * 0.4)])         # the battle cut in the middle of a packet
    expected = whole_packets(cut)

    def crash(name):
        shutil.copyfile(os.path.join(cfg, 'battles', BATTLE + '.jsonl'), os.path.join(cfg, 'battles', name + '.jsonl'))
        with open(raw_of(name), 'wb') as f: f.write(bytes(cut))
        stand.replay_stream({'schema': 1, 'battle': name, 'arenaId': arena, 'stream': raw_of(name), 'streamBytes': len(cut),
                             'complete': False, 'end': 'restart', 'final': None, 'finalOwned': False, 'library': None})
        began = time.time()
        drain()
        return time.time() - began

    crashed = arena + '-cccccccccccc'
    took = crash(crashed)
    built = [n for n in os.listdir(replays) if n.endswith(rl.UNFINISHED + rl.EXT)]
    path = os.path.join(replays, built[0]) if len(built) == 1 else None
    plain = None
    if path:
        reader = rr.FinalFile(path)
        while not reader.step(): pass
        plain = bytes(reader.stream())
    entry = stand.replay_state().get(crashed) or {}
    check('fragment', 'ACCEPTANCE: after a crash pick-up replays/ holds one bh_..._unfinished.wotreplay whose decoded stream '
          'equals the fragment\'s whole packets', path is not None and built[0].startswith(rl.MARK) and plain == expected
          and len(expected) < len(cut), repr((built, len(plain or ''), len(expected), len(cut))))
    head = rl.first_block(path) if path else {}
    check('fragment', 'its header names the battle from the mod\'s record (date, map, own vehicle and player, the roster)',
          head.get('mapName') and head.get('dateTime') and head.get('playerVehicle') and head.get('playerName')
          and len(head.get('vehicles') or {}) > 10 and (head.get('bullbaHits') or {}).get('unfinished') is True
          and built[0] == rl.readable_name(None, crashed, block=head, suffix=rl.UNFINISHED), repr(sorted(head)))
    check('fragment', 'entered in the manifest as a marked replay under the limit; the raw copy removed',
          library.status(crashed) == 'rolling' and library.file_of(crashed) == os.path.abspath(path)
          and (entry.get('stream') or {}).get('kept') == 'replay folder' and not os.path.exists(raw_of(crashed))
          and entry.get('status') in ('used', 'cut'), repr((library.status(crashed), entry.get('stream'))))
    try: kind, found = playback.Job(cfg, GAME, crashed, stand).source()
    except Exception as error: kind, found = repr(error), None
    check('fragment', 'the page\'s source path (playback.Job.source) reads it', kind == 'wotreplay'
          and os.path.abspath(found) == os.path.abspath(path), repr((kind, found)))
    notes.append('a crashed fragment of %.1f MB built into %s (%.0f KB) in %.1f s of the job (stand)'
                 % (len(expected) / 1e6, built[0] if built else '?', os.path.getsize(path) / 1e3 if path else 0, took))

    # The game set to keep all replays: still built (the game wrote nothing for this battle).
    library.note_setting(2)
    crash(arena + '-dddddddddddd')
    check('fragment', 'under the game\'s "all" it is built too', library.status(arena + '-dddddddddddd') == 'rolling'
          and rl.marked(library.file_of(arena + '-dddddddddddd') or ''))
    library.note_setting(1)

    # A failure while building: one log line, no .part left, the battle as published.
    seen = Lines()
    log = logging.getLogger('local.armor_inspector')
    log.addHandler(seen)
    level = log.level
    log.setLevel(logging.INFO)
    step = rr.BuiltFile.step

    def broken(self): raise IOError('disk full (simulated)')
    rr.BuiltFile.step = broken
    failed = arena + '-eeeeeeeeeeee'
    try: crash(failed)
    finally:
        rr.BuiltFile.step = step
        log.removeHandler(seen)
        log.setLevel(level)
    lines = [l for l in seen.lines if 'was not built' in l]
    check('fragment', 'a failure while building: one log line, no .part, the battle published from its records',
          len(lines) == 1 and not [n for n in os.listdir(replays) if n.endswith('.part')]
          and (stand.replay_state().get(failed) or {}).get('status') in ('used', 'cut') and library.file_of(failed) is None,
          repr(lines))


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
    game_bytes = read(final)
    copy = library.add(BATTLE, final, started, arena, head=bytes(stream[:4096]))
    check('source', 'the limit on: the game\'s file copied under the mod\'s name and left alone', copy is not None
          and read(final) == game_bytes and read(copy) == game_bytes
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
            if store: self.replay_entry(name)['records'] = 1     # the store written (its own tests are elsewhere)
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
    # A battle with no replay file at all (the limit off and the game's file gone, or a crash): its records stored, its raw
    # copy removed all the same - no lasting stream copy.
    lone = arena + '-bbbbbbbbbbbb'
    lone_raw = os.path.join(cfg, 'battles', lone + rr.RAW_EXT)
    with open(lone_raw, 'wb') as f: f.write(bytes(stream))
    library.set_mode(False, 50)        # the limit off: a crash's fragment gets no replay file either
    before = sorted(os.listdir(replays))
    stand.replay_stream({'schema': 1, 'battle': lone, 'arenaId': arena, 'stream': lone_raw, 'streamBytes': len(stream),
                         'complete': True, 'end': 'restart', 'final': None, 'finalOwned': False, 'library': None})
    drain()
    library.set_mode(True, 50)
    lone_entry = stand.replay_state().get(lone) or {}
    left = [n for n in os.listdir(os.path.join(cfg, 'replay')) if n.endswith(rr.STREAM_EXT)]
    left += [n for n in os.listdir(os.path.join(cfg, 'battles')) if n.endswith(rr.RAW_EXT)]
    check('source', 'ACCEPTANCE: neither a stream.z nor a .wotstream of a consumed battle is left in the mod\'s folder (one with '
          'its replay file, one with none)', lone_entry.get('status') in ('used', 'cut') and not left
          and (lone_entry.get('stream') or {}).get('kept') == 'none', repr((lone_entry.get('stream'), left)))
    check('fragment', 'the limit off: a crashed battle\'s fragment gets no replay file', sorted(os.listdir(replays)) == before,
          repr(sorted(os.listdir(replays))))
    fragment_checks(stand, drain, library, cfg, replays, arena, stream)
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
