# -*- coding: utf-8 -*-
"""The replay viewer's list of replay files (19.11.2026, the user's 'want a replay - go to replays'): every .wotreplay in
the game's replays/ folder (and in replays/bullba_hits/, the keep folder of the replay limit's old layout, if a machine
still has one), by its plain first JSON block - whoever recorded it, whether Bullba Hits has a record of the battle or
not. The cache also keeps each file's arena id from its results block (results_arena; None for a one-block file): the
replay limit finds a battle's file by it (replay_library.Library.find).

    Scan(folder, replays, library).steps()   the export thread's job (Exporter.run_replay_files_job), one file a step:
                                             headers read once per (name, size, mtime) - the rest from CFG/replay/files.json
    entry_of(path, ...)                      one file's entry (None and a log line for a file that is not a replay)
    file_id(block, size)                     the entry's id, from the file's own content (see below)

The id ('f-' + 16 hex) is the hash of the header's own fields - dateTime, playerName, playerID, mapName, gameplayID - and
the file's size as a tie-breaker (coordinator 19.11): never the path or the name, which the replay limit's rename, "keep
forever" and the player's own renames and copies change - so the same battle stays one entry and its battle built in the
page's IndexedDB (keyed by this id) is found again. Two files of one id are one battle listed once: the kept copy first,
then the newest file. A Hits battle id is digits-hex: no clash with 'f-'.
A file the replay limit's manifest (replay_library: battles {id: file}) ties to a battle Bullba Hits recorded - or whose
results block names the arena of such a battle - is listed with that battle's id in `battle`: the page opens it under
that id (its record, roster and part boxes). `kept`: kept forever (the limit's mark removed, or the old keep folder);
`mark`: the name carries the limit's mark (bh_).

data/replay-files.js: ArmorInspectorData.receive(["replayFiles", {format, client, scanned, files: [entry...] newest first,
broken: [name...]}]); entry {id, file (relative to replays/), kept, size, mtime, when ('YYYY-MM-DD HH:MM:SS' from the
header's 'dd.mm.yyyy hh:mm:ss'), map, mapTitle, gameplay, battleType, player, vehicle (type 'nation:name'), client,
vehicles (the header's count), battle (Hits id or absent), special ({name, bonusType, gameplay} of a special battle
mode - special_mode, BACKLOG 112 - or absent)}. The header's per-vehicle rows (roster) are kept in the cache
only; the playback job reads them for the battle file (roster_of). Python 2.7 and 3.
"""
from __future__ import absolute_import
import hashlib
import json
import logging
import os
import re
import struct

from .replay_library import first_block, marked, EXT, KEPT, REPLAY_MAGIC

LOG = logging.getLogger('local.armor_inspector')
FORMAT = 1
DATA_KEY = 'replayFiles'
DATA_FILE = 'replay-files'       # CFG/data/replay-files.js
CACHE = 'files.json'             # CFG/replay/files.json
CACHE_FORMAT = 2                 # 2 (20.11): each entry's 'arena' from its results block
PREFIX = 'f-'
SKIP = ('temp.wotreplay',)       # the game's growing in-battle file
WHEN = re.compile(r'(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?')


# --- special battle modes (BACKLOG 112, 20.11.2026): the replay viewer marks them in its battle list and warns on opening -
# The viewer draws a battle on the map's standard picture (its bases and spawns for the gameplay, ordinary vehicles); a
# mode with its own maps, rules or vehicles may not look as drawn. The battle type is the authority (the replay header's
# 'battleType' = arena bonus type, the live record's mode.bonusType - outputs/vehicle-classes-modes-2026-09-21.md 1.2;
# measured: the fixture replays carry 1, 14 and 47 there), the gameplay a second test (Grand Battle is a random-range
# type on 30x30 maps, an event map may carry plain 'ctf' under its own type). Standard: the random-like types below
# AND a standard gameplay; a field that is absent decides nothing; both absent: not marked (unknown).
STANDARD_BONUS = {1: 'Random battle', 2: 'Training room', 14: 'Tournament', 15: 'Clan tournament', 22: 'Ranked battle',
                  37: 'Mapbox', 44: 'Winback', 46: 'Random battle'}
STANDARD_GAMEPLAY = ('ctf', 'domination', 'assault')
# names of the special types this client knows (2.4.1.1 constants, the report above); another type is named by its id
SPECIAL_NAMES = {24: 'Grand Battle', 25: 'Grand Battle training', 27: 'Frontline', 28: 'Frontline training',
                 29: 'Steel Hunter', 30: 'Steel Hunter', 34: 'Steel Hunter tournament', 35: 'Steel Hunter tournament',
                 43: 'Onslaught', 47: 'Onslaught tournament', 48: 'Onslaught training', 49: 'Onslaught Light',
                 100: 'Story mode', 104: 'Story mode'}
GAMEPLAY_NAMES = {'ctf30x30': 'Grand Battle', 'domination30x30': 'Grand Battle', 'epic': 'Frontline',
                  'comp7': 'Onslaught', 'maps_training': 'Maps training', 'bootcamp': 'Boot camp'}


def special_mode(bonus_type, gameplay):
    """None for a standard battle (or one whose mode is unknown), else {name, bonusType, gameplay} - the mark's words."""
    try: bonus = None if bonus_type is None or bonus_type == '' else int(bonus_type)
    except (TypeError, ValueError): bonus = None
    gameplay = text(gameplay) if gameplay else None
    odd_bonus = bonus is not None and bonus not in STANDARD_BONUS
    odd_gameplay = gameplay is not None and gameplay not in STANDARD_GAMEPLAY
    if not odd_bonus and not odd_gameplay: return None
    name = SPECIAL_NAMES.get(bonus) or GAMEPLAY_NAMES.get(gameplay) or (
        'battle type %d' % bonus if odd_bonus else 'gameplay %s' % gameplay)
    return {'name': name, 'bonusType': bonus, 'gameplay': gameplay}


def text(value):
    try: return value if isinstance(value, type(u'')) else str(value).decode('utf-8', 'replace')
    except AttributeError: return str(value)


def file_id(block, size):
    """'f-' + 16 hex of the header's own fields and the file size (module doc)."""
    key = u'|'.join(text(block.get(k) if block.get(k) is not None else u'') for k in
                    ('dateTime', 'playerName', 'playerID', 'mapName', 'gameplayID')) + u'|%d' % int(size)
    return PREFIX + hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]


def when_of(block):
    found = WHEN.match(str(block.get('dateTime') or ''))
    if not found: return None
    d, m, y, hh, mm, ss = found.groups()
    return '%s-%02d-%02d %02d:%s:%02d' % (y, int(m), int(d), int(hh), mm, int(ss or 0))


def roster_of(block):
    """[{id, type, team, maxHealth, player}] of the header's vehicles (the battle file's roster shape)."""
    out = []
    vehicles = block.get('vehicles') if isinstance(block.get('vehicles'), dict) else {}
    for key, row in sorted(vehicles.items()):
        if isinstance(row, list): row = row[0] if row and isinstance(row[0], dict) else {}
        if not isinstance(row, dict): continue
        try: vid = int(key)
        except (TypeError, ValueError): continue
        out.append({'id': vid, 'type': row.get('vehicleType'), 'team': row.get('team'), 'maxHealth': row.get('maxHealth'),
                    'player': row.get('fakeName') or row.get('name')})
    return out


def own_vehicle(block):
    """(vehicle id, type) of the recording player from the header (its vehicles' row named playerName), else (None, None)."""
    name = block.get('playerName')
    for row in roster_of(block):
        if name and row.get('player') == name: return row['id'], row.get('type')
    return None, None


def results_arena(path):
    """The arena id from a .wotreplay's second JSON block (the battle's results the game appends at the end; a file
    written without them, e.g. replay_last_battle of a battle left early, has one block): a string, or None."""
    try:
        with open(path, 'rb') as handle:
            magic, count = struct.unpack('<II', handle.read(8))
            if magic != REPLAY_MAGIC or count < 2: return None
            size, = struct.unpack('<I', handle.read(4))
            handle.seek(size, 1)
            size, = struct.unpack('<I', handle.read(4))
            if size > (16 << 20): return None
            value = json.loads(handle.read(size).decode('utf-8'))
        arena = value[0].get('arenaUniqueID') if isinstance(value, list) and value and isinstance(value[0], dict) else None
        return str(int(arena)) if arena is not None else None
    except (IOError, OSError, ValueError, TypeError, struct.error):
        return None


def entry_of(path, rel, size, mtime):
    """One file's entry and its roster, or (None, reason) when it is no readable replay."""
    block = first_block(path)
    if not block: return None, 'no readable first JSON block'
    if not block.get('mapName'): return None, 'the header names no map'
    vid, vtype = own_vehicle(block)
    entry = {'id': file_id(block, size), 'file': rel, 'kept': rel.split('/')[0] == KEPT, 'size': size, 'mtime': mtime,
             'arena': results_arena(path),
             'when': when_of(block), 'map': block.get('mapName'), 'mapTitle': block.get('mapDisplayName'),
             'gameplay': block.get('gameplayID'), 'battleType': block.get('battleType'), 'player': block.get('playerName'),
             'vehicle': vtype or (str(block.get('playerVehicle') or '').replace('-', ':', 1) or None),
             'playerVehicleId': vid, 'client': block.get('clientVersionFromXml') or block.get('clientVersionFromExe'),
             'vehicles': len(roster_of(block)), 'dateTime': block.get('dateTime')}
    return entry, roster_of(block)


def listing(replays):
    """[(relative name, absolute path, size, mtime)] of the replay files: replays/*.wotreplay and replays/bullba_hits/*."""
    out = []
    for sub in ('', KEPT):
        folder = os.path.join(replays, sub) if sub else replays
        try: names = os.listdir(folder)
        except OSError: continue
        for name in names:
            if not name.lower().endswith(EXT) or (not sub and name.lower() in SKIP): continue
            path = os.path.join(folder, name)
            try:
                st = os.stat(path)
                if not os.path.isfile(path): continue
            except OSError:
                continue
            out.append(((sub + '/' + name) if sub else name, path, int(st.st_size), int(st.st_mtime)))
    return out


def cache_path(folder):
    return os.path.join(folder, 'replay', CACHE)


def read_cache(folder):
    try:
        with open(cache_path(folder), 'rb') as handle: value = json.loads(handle.read().decode('utf-8'))
        if isinstance(value, dict) and value.get('format') == CACHE_FORMAT and isinstance(value.get('files'), dict):
            return value['files']
    except (IOError, OSError, ValueError):
        pass
    return {}


def write_cache(folder, files):
    path = cache_path(folder)
    try:
        if not os.path.isdir(os.path.dirname(path)): os.makedirs(os.path.dirname(path))
        with open(path + '.tmp', 'wb') as handle:
            handle.write(json.dumps({'format': CACHE_FORMAT, 'files': files}, sort_keys=True).encode('utf-8'))
        if os.path.exists(path): os.remove(path)
        os.rename(path + '.tmp', path)
    except (IOError, OSError):
        LOG.warning('Replay files: the header cache was not written to %s', path, exc_info=True)


def find(folder, file_id_):
    """(absolute path under replays/, cached item {entry, roster}) of a listed file, None when the last scan did not see it.
    `folder` is CFG; the path is rebuilt from the game's replays folder the cache was made for."""
    for rel, item in read_cache(folder).items():
        entry = (item or {}).get('entry') or {}
        if entry.get('id') == file_id_: return rel, item
    return None


class Scan(object):
    """One pass over the replay files (module doc): steps() yields after each header read; `value` is the published view,
    `read` / `cached` / `broken` its counts. `library`: the replay limit (bh_ files tied to Hits battles), may be None."""

    def __init__(self, folder, replays, library=None, client=None):
        self.folder, self.replays, self.library, self.client = folder, replays, library, client
        self.read = self.cached = 0
        self.broken = []
        self.value = None
        self.name = 'files'

    def battles_of(self):
        """({file basename (lower case): Hits battle id}, {basename kept forever}) of the replay limit's battles that Bullba
        Hits has a record of (its manifest: the limit's files, kept ones, the game's files tied under `all`)."""
        out, kept = {}, set()
        if self.library is None: return out, kept
        try: battles = self.library.read().get('battles') or {}
        except Exception: return out, kept
        for battle, item in battles.items():
            name = os.path.basename(str((item or {}).get('file') or '')).lower()
            if not name: continue
            if (item or {}).get('state') == 'kept': kept.add(name)
            if os.path.isfile(os.path.join(self.folder, 'battles', battle + '.jsonl')): out[name] = battle
        return out, kept

    def arenas(self):
        """{arena id: Hits battle id} of the battles Bullba Hits has a record of (battles/<arena>-<session>.jsonl)."""
        out = {}
        try: names = os.listdir(os.path.join(self.folder, 'battles'))
        except OSError: return out
        for name in sorted(names):
            if name.endswith('.jsonl'):
                battle = name[:-len('.jsonl')]
                arena = battle.split('-', 1)[0]
                if arena.isdigit(): out[arena] = battle
        return out

    def steps(self):
        old = read_cache(self.folder)
        files = {}
        for rel, path, size, mtime in listing(self.replays):
            item = old.get(rel)
            if item and item.get('size') == size and item.get('mtime') == mtime:
                files[rel] = item
                self.cached += 1
                if item.get('broken'): self.broken.append(rel)
                continue
            entry, roster = entry_of(path, rel, size, mtime)
            self.read += 1
            if entry is None:
                LOG.info('Replay files: %s skipped: %s', rel, roster)
                files[rel] = {'size': size, 'mtime': mtime, 'broken': roster}
                self.broken.append(rel)
            else:
                files[rel] = {'size': size, 'mtime': mtime, 'entry': entry, 'roster': roster}
            yield
        write_cache(self.folder, files)
        tied, kept = self.battles_of()
        arenas = self.arenas()
        chosen = {}
        for rel, item in files.items():
            entry = item.get('entry')
            if not entry: continue
            base = os.path.basename(rel).lower()
            entry = dict(entry, kept=rel.split('/')[0] == KEPT or base in kept, file=rel, mark=marked(rel))
            entry.pop('arena', None)
            # tied by the limit's manifest, else by the arena id of the file's results block (a file the player renamed)
            if base not in tied and item['entry'].get('arena') in arenas: tied[base] = arenas[item['entry']['arena']]
            # BACKLOG 112: decided at every publish from the cached header fields (no cache format change)
            special = special_mode(entry.get('battleType'), entry.get('gameplay'))
            if special: entry['special'] = special
            else: entry.pop('special', None)
            battle = tied.get(os.path.basename(rel).lower())
            if battle: entry['battle'] = battle
            else: entry.pop('battle', None)
            have = chosen.get(entry['id'])
            if have is None or (entry['kept'], entry['mtime'], rel) > (have['kept'], have['mtime'], have['file']):
                if have is not None and have.get('battle') and not entry.get('battle'): entry['battle'] = have['battle']
                chosen[entry['id']] = entry
            elif entry.get('battle') and not have.get('battle'):
                have['battle'] = entry['battle']
        listed = sorted(chosen.values(), key=lambda e: (e.get('when') or '', e['mtime']), reverse=True)
        self.value = {'format': FORMAT, 'client': self.client, 'files': listed, 'broken': sorted(self.broken)}
        yield
