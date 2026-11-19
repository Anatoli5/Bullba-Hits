# -*- coding: utf-8 -*-
"""The replay viewer's list of replay files (19.11.2026, the user's 'want a replay - go to replays'): every .wotreplay in
the game's replays/ folder and in the replay limit's keep folder replays/bullba_hits/, by its plain first JSON block -
whoever recorded it, whether Bullba Hits has a record of the battle or not.

    Scan(folder, replays, library).steps()   the export thread's job (Exporter.run_replay_files_job), one file a step:
                                             headers read once per (name, size, mtime) - the rest from CFG/replay/files.json
    entry_of(path, ...)                      one file's entry (None and a log line for a file that is not a replay)
    file_id(block, size)                     the entry's id, from the file's own content (see below)

The id ('f-' + 16 hex) is the hash of the header's own fields - dateTime, playerName, playerID, mapName, gameplayID - and
the file's size as a tie-breaker (coordinator 19.11): never the path or the name, which the replay limit's rename, "keep
forever" and the player's own renames and copies change - so the same battle stays one entry and its battle built in the
page's IndexedDB (keyed by this id) is found again. Two files of one id are one battle listed once: the kept copy first,
then the newest file. A Hits battle id is digits-hex: no clash with 'f-'.
A file the replay limit's manifest (replay_library: battles {id: file}) ties to a battle Bullba Hits recorded is listed
with that battle's id in `battle`: the page opens it under that id (its record, roster and part boxes).

data/replay-files.js: ArmorInspectorData.receive(["replayFiles", {format, client, scanned, files: [entry...] newest first,
broken: [name...]}]); entry {id, file (relative to replays/), kept, size, mtime, when ('YYYY-MM-DD HH:MM:SS' from the
header's 'dd.mm.yyyy hh:mm:ss'), map, mapTitle, gameplay, battleType, player, vehicle (type 'nation:name'), client,
vehicles (the header's count), battle (Hits id or absent)}. The header's per-vehicle rows (roster) are kept in the cache
only; the playback job reads them for the battle file (roster_of). Python 2.7 and 3.
"""
from __future__ import absolute_import
import hashlib
import json
import logging
import os
import re

from .replay_library import first_block, EXT, KEPT

LOG = logging.getLogger('local.armor_inspector')
FORMAT = 1
DATA_KEY = 'replayFiles'
DATA_FILE = 'replay-files'       # CFG/data/replay-files.js
CACHE = 'files.json'             # CFG/replay/files.json
CACHE_FORMAT = 1
PREFIX = 'f-'
SKIP = ('temp.wotreplay',)       # the game's growing in-battle file
WHEN = re.compile(r'(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?')


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


def entry_of(path, rel, size, mtime):
    """One file's entry and its roster, or (None, reason) when it is no readable replay."""
    block = first_block(path)
    if not block: return None, 'no readable first JSON block'
    if not block.get('mapName'): return None, 'the header names no map'
    vid, vtype = own_vehicle(block)
    entry = {'id': file_id(block, size), 'file': rel, 'kept': rel.split('/')[0] == KEPT, 'size': size, 'mtime': mtime,
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
        """{file basename (lower case): Hits battle id} of the replay limit's battles that Bullba Hits has a record of."""
        out = {}
        if self.library is None: return out
        try: battles = self.library.read().get('battles') or {}
        except Exception: return out
        for battle, item in battles.items():
            name = os.path.basename(str((item or {}).get('file') or '')).lower()
            if name and os.path.isfile(os.path.join(self.folder, 'battles', battle + '.jsonl')): out[name] = battle
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
        tied = self.battles_of()
        chosen = {}
        for rel, item in files.items():
            entry = item.get('entry')
            if not entry: continue
            entry = dict(entry, kept=rel.split('/')[0] == KEPT, file=rel)
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
