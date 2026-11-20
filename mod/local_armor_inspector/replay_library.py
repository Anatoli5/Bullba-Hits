# -*- coding: utf-8 -*-
"""The replay limit (BACKLOG 107; redone 20.11.2026 as the ONE store of replays): a third recording mode beside the game's
"last battle" and "all" - the replays of the player's last N battles kept as ordinary .wotreplay files directly in the
game's own `replays/` folder, under the mod's mark, older ones removed by the mod. ON by default (N 1..100, 100; 50 before 1.19).

The user (20.11): one store, the game's own folder, files the game plays and the player can send; the game's own file is
LEFT ALONE. After a battle the replay source (replay_source.ReplaySource.handover, the replay thread) calls add():
- the game's setting `last` (1, or unknown): the game's finished `replay_last_battle.wotreplay` is COPIED to the mod's name
  MARK + date_time_vehicle_map (`bh_20261118_2253_ussr-R04_T-34_02_malinovka.wotreplay`); the game's file stays as the game
  wrote it (the newest bh_ file duplicates it - accepted);
- the setting `none` (0): the mod's own recording (replay_source.OWN_RESULT_NAME) is the mod's file: RENAMED to that name;
- the setting `all` (2): the player keeps every replay himself - nothing is made, the limit does not apply; the battle is
  only TIED to the game's own file (state 'game') so Bullba Hits and its 3D player find it.
- a crashed battle (BACKLOG 115): the game wrote no final file; the export thread's replay job builds one from the
  fragment the next start picked up (replay_run.BuiltFile) and add(built=True) renames it into place as
  MARK + date_time_vehicle_map + UNFINISHED (`bh_..._unfinished.wotreplay`) - whatever the game's setting (under `all`
  too: it is the only replay of that battle); a rolling marked file like the others (entry `unfinished`).
Before a file becomes the battle's (the .part copy, the own file before its rename, the game's file before the tie) it is
checked to be THIS battle's replay: its first encrypted chunk decrypted (replay_run.library_matches, ~33 ms under the
client's Python 2.7) carries the battle's arena id in its 0x00 packet and starts with the bytes of the mod's in-battle copy
of the stream - the plain header of replay_last_battle has one JSON block and no arena id, so the header cannot say it.

Ownership is the NAME: a file whose name starts with MARK is under the limit. The limit counts and removes only marked
files directly in `replays/`, oldest first by their time (the game's write time, kept by the copy and the renames); an
unmarked file - the game's, the player's, another mod's - is never counted or touched. Kept forever: the mark is REMOVED
from the name (`bh_X` -> `X`, still in replays/, out of the limit, an ordinary replay of the player); un-kept, it gets the
mark back and counts again. No replays/bullba_hits/ is made any more; a manifest entry of the old layout (format 2, kept
in that folder) still resolves there, read-only.

Which battle a file is: the manifest's file name, else the file's header - the replay files' scan (replay_files, its
cache) gives each file its arena id from its results block when it has one; a file without one is checked by its first
chunk (above) when its time fits the battle's. So a kept file the player renamed is still found.

The manifest (CFG/replay/library.json, FORMAT 3) maps a battle to its file and state, remembers the mode, the game's
setting the replay source last saw and the battles the limit removed; absent, the mode is ON. The page sees it through
data/replays.js (publish). Two threads use it (the replay thread adds and notes the setting, the export thread keeps,
sets the mode, looks up): every change reads the manifest from disk and writes it back under one lock. One code for the
client's Python 2.7 and CPython 3.
"""
from __future__ import absolute_import
import glob
import json
import logging
import os
import re
import shutil
import struct
import threading
import time

LOG = logging.getLogger('local.armor_inspector')

MARK = 'bh_'                      # the name's mark of a replay under the limit
KEPT = 'bullba_hits'              # replays/bullba_hits/: the keep folder of the old layout (format 2), read only
MANIFEST = 'library.json'         # CFG/replay/library.json
FORMAT = 3
OLD_FORMATS = (2,)
DEFAULT_LIMIT = 100
OLD_DEFAULT_LIMIT = 50              # the default before 1.19: written into every manifest, chosen or not
MIN_LIMIT, MAX_LIMIT = 1, 100
DATA_KEY = 'replays'              # data/replays.js: ArmorInspectorData.receive(["replays", value]);
EXT = '.wotreplay'
REPLAY_MAGIC = 0x11343212
STREAM_EXT = '.stream.z'          # replay_run.STREAM_EXT: the older kept streams, listed for the page
SAFE = re.compile(r'[^A-Za-z0-9_.-]+')
LOCK = threading.RLock()          # one for every Library object of the process: the two threads build their own
UNFINISHED = '_unfinished'        # the name's word of a replay the mod built from a crashed battle's fragment
GAME_ALL = 2                      # the game's setting `all` (BattleReplay: enableAutoRecordingBattles(2))
FIT_BEFORE, FIT_AFTER = 120.0, 4 * 3600.0   # a file's time that can be a battle's (its start - before, + after)


def clamp(limit):
    try: value = int(limit)
    except (TypeError, ValueError): return DEFAULT_LIMIT
    return max(MIN_LIMIT, min(MAX_LIMIT, value))


def marked(file):
    """A replay under the limit: its name carries MARK (the name is the owner of that fact)."""
    name = os.path.basename(str(file or '')).lower()
    return name.startswith(MARK) and name.endswith(EXT)


def first_block(path):
    """The first JSON block of a .wotreplay (plain, before the encrypted stream): date, map, vehicle. {} when unreadable."""
    try:
        with open(path, 'rb') as handle:
            magic, count = struct.unpack('<II', handle.read(8))
            if magic != REPLAY_MAGIC or count < 1: return {}
            size, = struct.unpack('<I', handle.read(4))
            if size > (1 << 20): return {}
            value = json.loads(handle.read(size).decode('utf-8'))
        return value if isinstance(value, dict) else {}
    except (IOError, OSError, ValueError, struct.error):
        return {}


def readable_name(path, battle, block=None, suffix=''):
    """The mod's name of a battle's replay: MARK + date_time_vehicle_map as the game names its own under "all", e.g.
    bh_20261118_2253_ussr-R04_T-34_02_malinovka.wotreplay; MARK + the battle id when the header does not say. `block`:
    the header itself instead of the file's; `suffix`: added before the extension (UNFINISHED for a crash's fragment)."""
    block = first_block(path) if block is None else block
    parts = []
    when = str(block.get('dateTime') or '')
    found = re.match(r'(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})', when)
    if found:
        d, m, y, hh, mm = found.groups()
        parts.append('%s%02d%02d_%02d%s' % (y, int(m), int(d), int(hh), mm))
    for key in ('playerVehicle', 'mapName'):
        if block.get(key): parts.append(SAFE.sub('_', str(block[key])).strip('_.'))
    name = '_'.join(p for p in parts if p) if len(parts) == 3 else ''
    return MARK + (name or 'battle_' + SAFE.sub('_', str(battle)))[:120] + suffix + EXT


def this_battle(path, arena, head):
    """True when the .wotreplay at `path` is the battle's: its first chunk carries `arena` and starts with `head` (the
    in-battle copy's first bytes; empty: the arena alone). replay_run.library_matches."""
    if arena is None: return True
    from .replay_run import library_matches
    return library_matches(path, arena, head or b'')


def arena_of(name):
    """The arena id a Hits battle id starts with ('<arena>-<session>'); None for a replay file's 'f-' id."""
    arena = str(name or '').split('-', 1)[0]
    return arena if arena.isdigit() else None


class Library(object):
    """`replays`: the game's replays folder; `cfg`: the mod's CFG folder (the manifest and data/replays.js)."""

    def __init__(self, replays, cfg):
        self.root = replays
        self.kept_root = os.path.join(replays, KEPT)
        self.cfg = cfg
        self.manifest = os.path.join(cfg, 'replay', MANIFEST)

    # ---- the manifest ---------------------------------------------------------------------------------------------
    def read(self):
        state, unreadable = None, False
        try:
            if os.path.isfile(self.manifest):
                with open(self.manifest, 'rb') as handle: state = json.loads(handle.read().decode('utf-8'))
        except (IOError, OSError, ValueError):
            LOG.warning('Replay limit: manifest %s unreadable; nothing is copied or removed until it is written again',
                        self.manifest, exc_info=True)
            unreadable = True
        if not isinstance(state, dict) or state.get('format') not in (None, FORMAT) + OLD_FORMATS: state = {}
        battles = state.get('battles') if isinstance(state.get('battles'), dict) else {}
        for entry in battles.values():
            if not isinstance(entry, dict): continue
            if 'state' not in entry:
                # format 2: kept meant moved into replays/bullba_hits/ under its marked name
                entry['state'] = 'kept' if entry.get('kept') else 'rolling'
                if entry.get('kept'): entry['folder'] = KEPT
            entry.pop('kept', None)
        battles = dict((k, v) for k, v in battles.items() if isinstance(v, dict))
        removed = state.get('removed') if isinstance(state.get('removed'), dict) else {}
        # Absent (or an older manifest that never said): ON. An explicit false is the player's own choice.
        enabled = state.get('enabled') is not False
        # N: the player's own only when the page changed it (limitChosen, 1.19). A manifest before 1.19 wrote the old
        # default 50 whether or not it was chosen: with no flag, 50 reads as today's default; any other N was chosen.
        chosen = state.get('limitChosen') is True
        limit = state.get('limit', DEFAULT_LIMIT)
        if not chosen and limit == OLD_DEFAULT_LIMIT: limit = DEFAULT_LIMIT
        return {'format': FORMAT, 'enabled': enabled and not unreadable, 'limit': clamp(limit), 'limitChosen': chosen,
                'battles': battles, 'removed': removed, 'gameSetting': state.get('gameSetting'), 'unreadable': unreadable}

    def write(self, state):
        from .exporter import atomic_write
        if state.get('unreadable'): return False
        value = dict((k, state.get(k)) for k in ('format', 'enabled', 'limit', 'battles', 'removed', 'gameSetting'))
        if state.get('limitChosen'): value['limitChosen'] = True
        try:
            atomic_write(self.manifest, json.dumps(value, sort_keys=True, ensure_ascii=True,
                                                   separators=(',', ':')).encode('ascii'))
            return True
        except Exception:
            LOG.exception('Replay limit: manifest not written')
            return False

    def where(self, entry):
        folder = self.kept_root if entry.get('folder') == KEPT else self.root
        return os.path.join(folder, str(entry.get('file') or ''))

    def ours(self, entry):
        """The entry's file is where the manifest says, under a name of its state (a rolling one: marked)."""
        if not entry or not entry.get('file') or not os.path.isfile(self.where(entry)): return False
        return entry.get('state') != 'rolling' or marked(entry.get('file'))

    def active(self, state):
        """The limit applies: on, and the game's setting is not `all`."""
        return state['enabled'] and state.get('gameSetting') != GAME_ALL and not state.get('unreadable')

    # ---- what the readers ask -------------------------------------------------------------------------------------
    def enabled(self):
        with LOCK: return self.read()['enabled']

    def limit(self):
        with LOCK: return self.read()['limit']

    def file_of(self, name):
        """The battle's replay file (absolute path): the manifest's, else one the replay files' scan knows by its header
        (find); None when there is none."""
        with LOCK:
            state = self.read()
            entry = state['battles'].get(name)
            gone = state['removed'].get(name) or {}
        if entry and self.ours(entry): return os.path.abspath(self.where(entry))
        if gone.get('why') == 'limit': return None
        found = self.find(name, (entry or {}).get('at') or gone.get('battleAt'))
        return os.path.abspath(found) if found else None

    def find(self, name, at=None):
        """A replay file in replays/ that is this battle's by its header: its results block's arena id (the scan's cache),
        else - a one-block file whose time fits the battle - its first chunk (this_battle). None when none is."""
        arena = arena_of(name)
        if not arena: return None
        try:
            from .replay_files import read_cache
            files = read_cache(self.cfg)
        except Exception:
            files = {}
        if at is None:
            # no manifest entry: the battle's raw record, written up to the battle's end, dates it
            try: at = os.path.getmtime(os.path.join(self.cfg, 'battles', name + '.jsonl')) - FIT_AFTER
            except OSError: at = None
        loose = []
        for rel, item in sorted(files.items()):
            entry = (item or {}).get('entry') or {}
            path = os.path.join(self.root, *rel.split('/'))
            if not entry or not os.path.isfile(path): continue
            if entry.get('arena') is not None:
                if str(entry['arena']) == arena: return path
                continue
            if at is None or not (float(at) - FIT_BEFORE <= float(item.get('mtime') or 0) <= float(at) + 2 * FIT_AFTER):
                continue
            loose.append(path)
        for path in loose:
            if this_battle(path, arena, None): return path
        return None

    def status(self, name):
        """'kept', 'rolling', 'game' (tied to the game's own file), 'removed' (by the limit), 'gone' (the file left or was
        renamed) or None (never taken)."""
        with LOCK:
            state = self.read()
            entry = state['battles'].get(name)
            if entry and self.ours(entry): return entry.get('state') or 'rolling'
            if entry: return 'gone'
            why = (state['removed'].get(name) or {}).get('why')
            return 'removed' if why == 'limit' else 'gone' if why else None

    # ---- the replay thread: a battle's replay ---------------------------------------------------------------------
    def taken(self):
        names = set()
        for folder in (self.root, self.kept_root):
            try: names.update(n.lower() for n in os.listdir(folder))
            except OSError: pass
        return names

    def unique(self, file, taken):
        stem, n = file[:-len(EXT)], 1
        while file.lower() in taken or (file + '.part').lower() in taken:
            n += 1
            file = '%s_%d%s' % (stem, n, EXT)
        return file

    def note_setting(self, setting):
        """The game's replay setting the replay source saw in the hangar (0 none, 1 last, 2 all): kept for the page's words
        and for add(). Written only when it changed."""
        try: setting = int(setting) if setting is not None else None
        except (TypeError, ValueError): setting = None
        with LOCK:
            state = self.read()
            if state.get('unreadable') or state.get('gameSetting') == setting: return False
            state['gameSetting'] = setting
            self.write(state)
        LOG.info('Replay limit: the game\'s replay setting is %s', {0: 'none', 1: 'last battle', 2: 'all'}.get(setting, setting))
        self.publish()
        return True

    def fragment_target(self, name, header):
        """Where the replay the mod builds from a crashed battle's fragment goes (replay_run.BuiltFile writes it as
        <path>.part, add(built=True) renames it): replays/bh_<date_time_vehicle_map>_unfinished.wotreplay, unique."""
        if not os.path.isdir(self.root): os.makedirs(self.root)
        return os.path.join(self.root, self.unique(readable_name(None, name, block=header, suffix=UNFINISHED), self.taken()))

    def add(self, name, source, started, arena=None, head=None, own=False, setting=None, built=False):
        """With the limit on: the battle's whole final file `source` made the battle's replay under the mod's name in
        replays/ - COPIED (the game's file stays), or RENAMED when it is the mod's `own` recording - once it is checked to
        be this battle's (this_battle: arena id and `head`, the in-battle copy's first bytes); then the oldest marked
        replays beyond the limit are removed. Under the game's setting `all` nothing is made: the game's file is tied.
        `built`: `source` is <target>.part the mod built from a crashed battle's fragment (replay_run.BuiltFile): renamed
        to <target> (its name says _unfinished), whatever the game's setting - the game wrote nothing for that battle.
        Returns the file's path; None when the limit is off or the file is not this battle's; raises IOError/OSError when
        the copy or rename failed (the caller retries)."""
        from .replay_source import final_header
        with LOCK:
            state = self.read()
            if setting is not None and setting != state.get('gameSetting') and not state.get('unreadable'):
                try: state['gameSetting'] = int(setting)
                except (TypeError, ValueError): pass
            if not state['enabled'] or state.get('unreadable'): return None
            entry = state['battles'].get(name)
            if entry and self.ours(entry): return os.path.abspath(self.where(entry))
            same_folder = os.path.dirname(os.path.abspath(source)) == os.path.abspath(self.root)
            if state.get('gameSetting') == GAME_ALL and not own and not built:
                if not same_folder or not this_battle(source, arena, head):
                    LOG.warning("Replay limit: %s is not the replay of %s; not tied", source, name)
                    return None
                file, target, how = os.path.basename(source), source, 'tied'
                state['battles'][name] = {'file': file, 'state': 'game', 'at': float(started or time.time()),
                                          'arena': str(arena) if arena is not None else None, 'added': time.time(), 'how': how}
                state['removed'].pop(name, None)
                self.write(state)
                gone = []
            else:
                if built:
                    file = os.path.basename(source)[:-len('.part')]
                    taken = self.taken()
                    taken.discard((file + '.part').lower())
                    file = self.unique(file, taken)
                    target = os.path.join(self.root, file)
                    if not this_battle(source, arena, head):
                        LOG.warning("Replay limit: the replay built for %s does not read back as its own; not taken", name)
                        return None
                    os.rename(source, target)
                    how = 'built'
                elif marked(source) and same_folder:
                    file, target, how = os.path.basename(source), source, 'taken'   # already the mod's (a retry after it landed)
                else:
                    file = self.unique(readable_name(source, name), self.taken())
                    target = os.path.join(self.root, file)
                    if own:
                        if not this_battle(source, arena, head):
                            LOG.warning("Replay limit: the mod's own file %s is not the replay of %s; not taken", source, name)
                            return None
                        os.rename(source, target)
                        how = 'renamed'
                    else:
                        part = target + '.part'
                        try:
                            size = os.path.getsize(source)
                            shutil.copy2(source, part)       # its time kept: the limit orders by it
                            header = final_header(part)
                            if os.path.getsize(part) != size or header is None or not header[2]:
                                raise IOError('the copy is not the whole file (%d of %d bytes)' % (os.path.getsize(part), size))
                            if not this_battle(part, arena, head):
                                os.remove(part)
                                LOG.warning("Replay limit: %s is not the replay of %s (another battle's, or an earlier "
                                            "one); no copy made", source, name)
                                return None
                            os.rename(part, target)
                        except Exception:
                            try:
                                if os.path.isfile(part): os.remove(part)
                            except OSError: pass
                            raise
                        how = 'copied'
                state['battles'][name] = {'file': file, 'state': 'rolling', 'at': float(started or time.time()),
                                          'arena': str(arena) if arena is not None else None, 'added': time.time(), 'how': how}
                if built: state['battles'][name]['unfinished'] = True
                state['removed'].pop(name, None)
                gone = self.prune(state)
                self.write(state)
        LOG.info('Replay limit: the replay of %s %s %s%s', name,
                 {'copied': 'copied from %s to' % source, 'renamed': 'renamed from %s to' % source,
                  'tied': "tied to the game's own file (the game keeps all replays; the limit does not apply)",
                  'taken': 'taken as', 'built': "built from the crashed battle's fragment as"}.get(how, how), target,
                 '; removed by the limit of %d: %s' % (state['limit'], ', '.join(gone)) if gone else '')
        self.publish()
        return os.path.abspath(target)

    def prune(self, state):
        """The oldest marked replays directly in replays/ beyond the limit removed (by their time); entries whose file is
        gone are forgotten. Unmarked files are never counted or touched. Returns the names of the removed files."""
        if not self.active(state): return []
        now, gone = time.time(), []
        for name, entry in list(state['battles'].items()):
            if not self.ours(entry):
                del state['battles'][name]
                # its battle's time kept: a file the player renamed is still found by its header (find)
                state['removed'][name] = {'at': now, 'why': 'gone', 'battleAt': entry.get('at')}
        owner = dict((str(e.get('file')).lower(), n) for n, e in state['battles'].items()
                     if e.get('state') == 'rolling' and not e.get('folder'))
        rolling = []
        try: files = os.listdir(self.root)
        except OSError: files = []
        for file in files:
            path = os.path.join(self.root, file)
            if not marked(file) or not os.path.isfile(path): continue
            try: rolling.append((os.path.getmtime(path), file))
            except OSError: continue
        rolling.sort()
        while len(rolling) > state['limit']:
            _, file = rolling.pop(0)
            try: os.remove(os.path.join(self.root, file))
            except OSError:
                LOG.warning('Replay limit: %s could not be removed; tried again with the next battle', file)
                continue
            gone.append(file)
            name = owner.get(file.lower())
            if name is not None:
                del state['battles'][name]
                state['removed'][name] = {'at': now, 'why': 'limit'}
        return gone

    def drop(self, name, why):
        """The battle's replay turned out not to be its own (the export thread's check): forgotten, the file left as is
        (it is a game's replay, only not this battle's)."""
        with LOCK:
            state = self.read()
            if name not in state['battles']: return False
            del state['battles'][name]
            self.write(state)
        LOG.warning('Replay limit: the replay noted for %s is not its own (%s); forgotten', name, why)
        self.publish()
        return True

    # ---- the export thread: the page's commands ---------------------------------------------------------------------
    def keep(self, name, on):
        """Keep the battle's replay forever - the mark removed from its name, the file stays in replays/ and leaves the
        limit - or give it the mark back (under the limit again). True when its state is the one asked for afterwards."""
        on = bool(on)
        with LOCK:
            state = self.read()
            entry = state['battles'].get(name)
            if not entry or not self.ours(entry) or entry.get('state') not in ('kept', 'rolling'):
                LOG.info('Replay limit: %s has no replay under the limit; keep %s not done', name, on)
                return False
            if (entry.get('state') == 'kept') == on: return True
            source = self.where(entry)
            file = str(entry['file'])
            if on: file = file[len(MARK):] if marked(file) else file
            elif not marked(file): file = MARK + file
            taken = self.taken()
            taken.discard(os.path.basename(source).lower())
            file = self.unique(file, taken)
            target = os.path.join(self.root, file)
            try: os.rename(source, target)
            except OSError:
                LOG.warning('Replay limit: %s could not be renamed to %s', source, target, exc_info=True)
                return False
            entry['state'], entry['file'] = ('kept' if on else 'rolling'), file
            entry.pop('folder', None)
            self.write(state)
        LOG.info('Replay limit: %s %s (%s)', name, 'kept forever: the mark removed' if on else 'back under the limit', file)
        self.publish()
        return True

    def set_mode(self, enabled, limit=None):
        """The page's mode: the limit on or off, and N (clamped to 1..100). Nothing is removed here: the next battle's
        replay applies it."""
        with LOCK:
            state = self.read()
            if state.get('unreadable'): return state['enabled'], state['limit']
            value = (bool(enabled), clamp(limit) if limit is not None else state['limit'])
            exists = os.path.isfile(self.manifest)
            if (state['enabled'], state['limit']) == value and exists: return value
            # the page sends N with every on/off switch: only a changed N is the player's choice
            if value[1] != state['limit']: state['limitChosen'] = True
            state['enabled'], state['limit'] = value
            self.write(state)
        LOG.info('Replay limit: %s, %d replays', 'on' if value[0] else 'off', value[1])
        self.publish()
        return value

    # ---- the page's view ----------------------------------------------------------------------------------------
    def view(self):
        with LOCK:
            state = self.read()
            battles = dict((name, e.get('state') or 'rolling') for name, e in state['battles'].items() if self.ours(e))
            removed = sorted(n for n, r in state['removed'].items() if (r or {}).get('why') == 'limit' and n not in battles)
            enabled, limit, setting = state['enabled'], state['limit'], state.get('gameSetting')
        streams = sorted(os.path.basename(p)[:-len(STREAM_EXT)]
                         for p in glob.glob(os.path.join(self.cfg, 'replay', '*' + STREAM_EXT)))
        return {'format': FORMAT, 'enabled': enabled, 'limit': limit, 'defaultLimit': DEFAULT_LIMIT, 'minLimit': MIN_LIMIT,
                'maxLimit': MAX_LIMIT, 'mark': MARK, 'folder': 'replays', 'gameSetting': setting,
                'battles': battles, 'removed': removed, 'streams': streams}

    def publish(self):
        """data/replays.js for the page (web/local-data.js key 'replays')."""
        from .exporter import write_data_changed
        try:
            write_data_changed(os.path.join(self.cfg, 'data', DATA_KEY + '.js'), DATA_KEY, self.view())
        except Exception:
            LOG.exception('Replay limit: data/replays.js not written')
