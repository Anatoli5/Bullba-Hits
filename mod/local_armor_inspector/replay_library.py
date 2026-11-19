# -*- coding: utf-8 -*-
"""The replay limit (BACKLOG 107, 18.11.2026): a third recording mode beside the game's "last battle" and "all" - the
replays of the player's last N battles kept in the game's own `replays/` folder, older ones removed by the mod, and the
ones he keeps forever in `replays/bullba_hits/`.

The user: one file per battle, no second copy; the mod works in the game's default folder. With the limit on (the page's
Settings, OFF by default: the game's own setting rules until the player turns it on; N 1..100, 50 by default), after a
battle the replay source (replay_source.ReplaySource.handover, the replay thread) RENAMES the game's finished file -
whatever the game named it (`replay_last_battle`, or its "all" name) - inside `replays/` to the mod's own name: MARK
plus date_time_vehicle_map (`bh_20261118_2253_ussr-R04_T-34_02_malinovka.wotreplay`). A rename the game's open file
refuses is retried by the caller; when it keeps failing the file is copied instead (two files for that battle, said in
the log). With the limit off nothing is renamed, moved or removed, and the battle keeps its stream as before
(CFG/replay/<id>.stream.z).

Ownership is the NAME: a file whose name starts with MARK is the mod's. The limit counts and removes only marked files
directly in `replays/`, oldest first by their time (the game's write time, kept by a rename); a file without the mark -
everything there before, anything the player or another mod puts there - is never counted or touched; a marked file the
player renames stops being the mod's. Kept forever: the marked file moved into `replays/bullba_hits/` (never counted,
never removed); un-kept, it moves back and counts again (removed, if it is the oldest beyond N, when the next battle's
replay is added). The manifest (CFG/replay/library.json) only maps a battle to its file and remembers the mode and the
battles the limit removed; the page sees it all through data/replays.js (publish).

Two threads use it (the replay thread adds, the export thread keeps, sets the mode, checks): every change reads the
manifest from disk and writes it back under one lock. One code for the client's Python 2.7 and CPython 3.
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

MARK = 'bh_'                      # the name's mark of a replay the mod owns
KEPT = 'bullba_hits'              # replays/bullba_hits/: kept forever
MANIFEST = 'library.json'         # CFG/replay/library.json
FORMAT = 2
DEFAULT_LIMIT = 50
MIN_LIMIT, MAX_LIMIT = 1, 100
DATA_KEY = 'replays'              # data/replays.js: ArmorInspectorData.receive(["replays", value]);
EXT = '.wotreplay'
REPLAY_MAGIC = 0x11343212
CHUNK = 1 << 20
STREAM_EXT = '.stream.z'          # replay_run.STREAM_EXT: the older kept streams, listed for the page
SAFE = re.compile(r'[^A-Za-z0-9_.-]+')
LOCK = threading.RLock()          # one for every Library object of the process: the two threads build their own


def clamp(limit):
    try: value = int(limit)
    except (TypeError, ValueError): return DEFAULT_LIMIT
    return max(MIN_LIMIT, min(MAX_LIMIT, value))


def marked(file):
    """A replay of the mod: its name carries MARK (the name is the owner of that fact)."""
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


def readable_name(path, battle):
    """The mod's name of a battle's replay: MARK + date_time_vehicle_map as the game names its own under "all", e.g.
    bh_20261118_2253_ussr-R04_T-34_02_malinovka.wotreplay; MARK + the battle id when the header does not say."""
    block = first_block(path)
    parts = []
    when = str(block.get('dateTime') or '')
    found = re.match(r'(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})', when)
    if found:
        d, m, y, hh, mm = found.groups()
        parts.append('%s%02d%02d_%02d%s' % (y, int(m), int(d), int(hh), mm))
    for key in ('playerVehicle', 'mapName'):
        if block.get(key): parts.append(SAFE.sub('_', str(block[key])).strip('_.'))
    name = '_'.join(p for p in parts if p) if len(parts) == 3 else ''
    return MARK + (name or 'battle_' + SAFE.sub('_', str(battle)))[:120] + EXT


class Library(object):
    """`replays`: the game's replays folder; `cfg`: the mod's CFG folder (the manifest and data/replays.js)."""

    def __init__(self, replays, cfg):
        self.root = replays
        self.kept_root = os.path.join(replays, KEPT)
        self.cfg = cfg
        self.manifest = os.path.join(cfg, 'replay', MANIFEST)

    # ---- the manifest ---------------------------------------------------------------------------------------------
    def read(self):
        state = None
        try:
            if os.path.isfile(self.manifest):
                with open(self.manifest, 'rb') as handle: state = json.loads(handle.read().decode('utf-8'))
        except (IOError, OSError, ValueError):
            LOG.warning('Replay limit: manifest %s unreadable; the mode is off until it is written again', self.manifest,
                        exc_info=True)
            state = {'unreadable': True}
        if not isinstance(state, dict) or state.get('format') not in (None, FORMAT): state = {}
        battles = state.get('battles') if isinstance(state.get('battles'), dict) else {}
        removed = state.get('removed') if isinstance(state.get('removed'), dict) else {}
        return {'format': FORMAT, 'enabled': state.get('enabled') is True and not state.get('unreadable'),
                'limit': clamp(state.get('limit', DEFAULT_LIMIT)), 'battles': battles, 'removed': removed,
                'unreadable': bool(state.get('unreadable'))}

    def write(self, state):
        from .exporter import atomic_write
        if state.get('unreadable'): return False
        value = dict((k, state[k]) for k in ('format', 'enabled', 'limit', 'battles', 'removed'))
        try:
            atomic_write(self.manifest, json.dumps(value, sort_keys=True, ensure_ascii=True,
                                                   separators=(',', ':')).encode('ascii'))
            return True
        except Exception:
            LOG.exception('Replay limit: manifest not written')
            return False

    def where(self, entry):
        return os.path.join(self.kept_root if entry.get('kept') else self.root, str(entry.get('file') or ''))

    def ours(self, entry):
        """The entry's file is where the mod put it, under its marked name: still the mod's."""
        return marked(entry.get('file')) and os.path.isfile(self.where(entry))

    # ---- what the readers ask -------------------------------------------------------------------------------------
    def enabled(self):
        with LOCK: return self.read()['enabled']

    def limit(self):
        with LOCK: return self.read()['limit']

    def file_of(self, name):
        """The battle's replay under the mod's name (absolute path), None when there is none."""
        with LOCK:
            entry = self.read()['battles'].get(name)
            return os.path.abspath(self.where(entry)) if entry and self.ours(entry) else None

    def status(self, name):
        """'kept', 'rolling', 'removed' (by the limit), 'gone' (the file left or was renamed) or None (never taken)."""
        with LOCK:
            state = self.read()
            entry = state['battles'].get(name)
            if entry and self.ours(entry): return 'kept' if entry.get('kept') else 'rolling'
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

    def add(self, name, source, started, arena=None, copy=False):
        """With the limit on: the battle's whole final file `source` renamed (or, `copy`, copied) to the mod's name in
        replays/; then the oldest marked replays beyond the limit are removed. Returns the file's path; None with the
        limit off (nothing done); raises IOError/OSError when the rename or copy failed (the caller retries)."""
        from .replay_source import final_header
        with LOCK:
            state = self.read()
            if not state['enabled']: return None
            entry = state['battles'].get(name)
            if entry and self.ours(entry): return os.path.abspath(self.where(entry))
            if marked(source) and os.path.dirname(os.path.abspath(source)) == os.path.abspath(self.root):
                file, target = os.path.basename(source), source      # already the mod's (a retry after a rename landed)
            else:
                file = self.unique(readable_name(source, name), self.taken())
                target = os.path.join(self.root, file)
                if copy:
                    part = target + '.part'
                    try:
                        size = os.path.getsize(source)
                        shutil.copy2(source, part)       # its time kept: the limit orders by it
                        header = final_header(part)
                        if os.path.getsize(part) != size or header is None or not header[2]:
                            raise IOError('the copy is not the whole file (%d of %d bytes)' % (os.path.getsize(part), size))
                        os.rename(part, target)
                    except Exception:
                        try:
                            if os.path.isfile(part): os.remove(part)
                        except OSError: pass
                        raise
                else:
                    os.rename(source, target)
            state['battles'][name] = {'file': file, 'kept': False, 'at': float(started or time.time()),
                                      'arena': str(arena) if arena is not None else None, 'added': time.time(),
                                      'how': 'copied' if copy else 'renamed'}
            state['removed'].pop(name, None)
            gone = self.prune(state)
            self.write(state)
        LOG.info('Replay limit: the replay of %s %s %s%s', name, 'COPIED (the rename kept failing; the game\'s file %s '
                 'stays) to' % source if copy else 'renamed to', target,
                 '; removed by the limit of %d: %s' % (state['limit'], ', '.join(gone)) if gone else '')
        self.publish()
        return os.path.abspath(target)

    def prune(self, state):
        """The oldest marked replays directly in replays/ beyond the limit removed (by their time); entries whose file is
        gone are forgotten. Unmarked files are never counted or touched. Returns the names of the removed files."""
        if not state['enabled'] or state.get('unreadable'): return []
        now, gone = time.time(), []
        for name, entry in list(state['battles'].items()):
            if not self.ours(entry):
                del state['battles'][name]
                state['removed'][name] = {'at': now, 'why': 'gone'}
        owner = dict((str(e.get('file')).lower(), n) for n, e in state['battles'].items() if not e.get('kept'))
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
        """Keep the battle's replay forever (moved to replays/bullba_hits/, out of the limit) or move it back under the
        limit. True when its state is the one asked for afterwards."""
        on = bool(on)
        with LOCK:
            state = self.read()
            entry = state['battles'].get(name)
            if not entry or not self.ours(entry):
                LOG.info('Replay limit: %s has no replay of the mod; keep %s not done', name, on)
                return False
            if bool(entry.get('kept')) == on: return True
            source = self.where(entry)
            folder = self.kept_root if on else self.root
            if not os.path.isdir(folder): os.makedirs(folder)
            file = str(entry['file'])
            if os.path.exists(os.path.join(folder, file)): file = self.unique(file, self.taken())
            try: os.rename(source, os.path.join(folder, file))
            except OSError:
                LOG.warning('Replay limit: %s could not be moved to %s', source, folder, exc_info=True)
                return False
            entry['kept'], entry['file'] = on, file
            self.write(state)
        LOG.info('Replay limit: %s %s', name, 'kept forever' if on else 'back under the limit')
        self.publish()
        return True

    def set_mode(self, enabled, limit=None):
        """The page's mode: the limit on or off, and N (clamped to 1..100). Nothing is removed here: the next battle's
        replay applies it."""
        with LOCK:
            state = self.read()
            if state.get('unreadable'): return state['enabled'], state['limit']
            value = (bool(enabled), clamp(limit) if limit is not None else state['limit'])
            if (state['enabled'], state['limit']) == value: return value
            state['enabled'], state['limit'] = value
            self.write(state)
        LOG.info('Replay limit: %s, %d replays', 'on' if value[0] else 'off', value[1])
        self.publish()
        return value

    # ---- the page's view ----------------------------------------------------------------------------------------
    def view(self):
        with LOCK:
            state = self.read()
            battles = dict((name, 'kept' if e.get('kept') else 'rolling') for name, e in state['battles'].items()
                           if self.ours(e))
            removed = sorted(n for n, r in state['removed'].items() if (r or {}).get('why') == 'limit' and n not in battles)
            enabled, limit = state['enabled'], state['limit']
        streams = sorted(os.path.basename(p)[:-len(STREAM_EXT)]
                         for p in glob.glob(os.path.join(self.cfg, 'replay', '*' + STREAM_EXT)))
        return {'format': FORMAT, 'enabled': enabled, 'limit': limit, 'defaultLimit': DEFAULT_LIMIT, 'minLimit': MIN_LIMIT,
                'maxLimit': MAX_LIMIT, 'mark': MARK, 'folder': 'replays', 'keptFolder': 'replays/' + KEPT,
                'battles': battles, 'removed': removed, 'streams': streams}

    def publish(self):
        """data/replays.js for the page (web/local-data.js key 'replays')."""
        from .exporter import write_data_changed
        try:
            write_data_changed(os.path.join(self.cfg, 'data', DATA_KEY + '.js'), DATA_KEY, self.view())
        except Exception:
            LOG.exception('Replay limit: data/replays.js not written')
