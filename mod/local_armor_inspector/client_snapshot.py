# -*- coding: utf-8 -*-
"""The client's files as the mod's keys see them (BACKLOG 55, 02.10): path -> (CRC-32, size).

A client update rebuilt everything on 02.10 because the keys carried the text of version.xml and, in every vehicle's key,
every items/*.pyc; the files that update changed (tankmen_components.pyc, one vehicle's XML) touched no output. The keys now
name the files themselves, and this snapshot is where their CRCs come from:

  - the members of the mounted packages (paths.xml order, the first package that has a path wins) under scripts/ of any
    root, the collision .havok, the vehicles' CGF prefabs and system/data/material_kinds.xml - from the packages' central
    directories, nothing unpacked (the client stores them uncompressed; the CRCs are the data's, outputs/
    rebuild-research-client-2026-10-02.md section 1.3);
  - what overrides them: res_mods/<version>/ and the .wotmod files of mods/<version>/ (the Paths of paths.xml, mounted
    before the packages), the mod's own package left out (its code is the formats' business, not the client's);
  - the texts res/text/lc_messages/*.mo (loose files: their CRC from their bytes, read only when their size or time moved).

The version text of version.xml is only a reason to look again, never part of a key. At each start (setup) the sizes and
times of those sources are compared with the last ones (stats.json, a few hundred stat calls); unchanged - nothing is read.
Changed - a new snapshot is taken (a package with the same size and time is taken from the last one) and one log line says
what changed. One snapshot per client version (<data>/client/<version>.txt.gz, the last KEEP versions, versions.json), so
a battle of an earlier client can be told what that client's files were (files(version_text)); for the client before the
first snapshot this mod took, a snapshot derived from a later one and the paths the update changed (client_changes.py).
Only names, CRCs and sizes - no byte of the client. Export thread only.
"""
from __future__ import absolute_import
import glob
import gzip
import hashlib
import io
import json
import logging
import os
import re
import struct
import sys
import zipfile
import zlib
import xml.etree.ElementTree as ET

LOG = logging.getLogger('local.armor_inspector')
SNAPSHOT_FORMAT = 1
# What the mod's outputs can be read from (the derived research, section 1): everything under scripts/ (the items code,
# the vehicles' XML), the collision models, the vehicles' prefabs, the material names.
SCOPE = re.compile(r'^(?:[^/]+/)?scripts/|/collision_client/[^/]+\.havok$|^content/CGFPrefabs/Vehicle/.+\.prefab$'
                   r'|^system/data/(?:material_kinds|effect_materials)\.xml$|^gui/gui_settings\.xml$'
                   r'|^text/lc_messages/[^/]+\.mo$')
# An override of the texts (res_mods/<v>/text/..., a .wotmod's res/text/...) is named as the client's own file is.
OVERRIDE_TEXTS = 'text/lc_messages/'
# The bytes searched for in a package's raw directory before any record is parsed: a package without one has nothing in scope.
MARKS = (b'scripts/', b'/collision_client/', b'CGFPrefabs/Vehicle/', b'system/data/material_kinds', b'system/data/effect_materials',
         b'gui/gui_settings', b'text/lc_messages/')
TEXTS = 'res/text/lc_messages'
OWN_PACKAGE = re.compile(r'^local\.armor_inspector_.*\.wotmod$', re.I)
ZIP_END = struct.Struct('<4s4H2LH')
ZIP_ENTRY = struct.Struct('<4s6H3L5H2L')
# The kinds of a path for the log line (what changed), most telling first.
KINDS = (('vehicle data', re.compile(r'(?:^|/)scripts/item_defs/vehicles/')),
         ('client code', re.compile(r'(?:^|/)scripts/(?:common|client_common)/.+\.pyc$')),
         ('interface code', re.compile(r'\.pyc$')),
         ('collision models', re.compile(r'\.havok$')),
         ('prefabs', re.compile(r'\.prefab$')),
         ('texts', re.compile(r'\.mo$')),
         ('other scripts', re.compile(r'')))


def directory_bytes(path):
    """The raw central directory of a zip, or None (zip64, a comment over 64 KB): the caller then uses zipfile."""
    with open(path, 'rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        tail_size = min(size, 65536 + ZIP_END.size)
        stream.seek(size - tail_size)
        tail = stream.read(tail_size)
        at = tail.rfind(b'PK\x05\x06')
        if at < 0 or at + ZIP_END.size > len(tail): return None
        fields = ZIP_END.unpack(tail[at:at + ZIP_END.size])
        length, offset = fields[5], fields[6]
        if length == 0xffffffff or offset == 0xffffffff or offset + length > size: return None
        stream.seek(offset)
        return stream.read(length)


def package_members(path, prefix=''):
    """{path: (crc, size)} of the in-scope members of one zip, from its central directory (no data read). `prefix` is cut off
    each name (a .wotmod's 'res/'); names without it are left out."""
    found = {}
    directory = directory_bytes(path)
    if directory is not None and not any(mark in directory for mark in MARKS): return found
    records = None
    if directory is not None:
        records, at, end = [], 0, len(directory)
        try:
            while at < end:
                if directory[at:at + 4] != b'PK\x01\x02': raise ValueError('record')
                fields = ZIP_ENTRY.unpack_from(directory, at)
                start = at + ZIP_ENTRY.size
                name = directory[start:start + fields[10]].decode('utf-8', 'replace')
                if 0xffffffff in (fields[8], fields[9]): raise ValueError('zip64')
                records.append((name, fields[7] & 0xffffffff, fields[9]))
                at = start + fields[10] + fields[11] + fields[12]
        except (ValueError, struct.error):
            records = None
    if records is None:
        with zipfile.ZipFile(path) as archive:
            records = [(info.filename, info.CRC & 0xffffffff, info.file_size) for info in archive.infolist()]
    for name, crc, size in records:
        if name.endswith('/') or not name.startswith(prefix): continue
        name = name[len(prefix):]
        if not SCOPE.search(name): continue
        if name.startswith(OVERRIDE_TEXTS): name = 'res/' + name
        if name not in found: found[name] = (crc, size)
    return found


# A CRC no file has (a derived snapshot's changed path, files): above 32 bits.
UNKNOWN = -1
# Client versions whose snapshot stays in <data>/client (the current and the ones before; battles of them are repaired by it).
KEEP = 4


def version_label(text):
    """The client's version as version.xml names it ('v.2.4.0.2 #964'); the key of its snapshot."""
    match = re.search(r'<version>\s*([^<]*?)\s*</version>', text or '')
    if match: return match.group(1)
    # A text without the element (a test, an odd client): its own hash, never another text's label.
    return 'text-' + hashlib.sha1((text or '').lstrip(u'﻿').replace('\r\n', '\n').encode('utf-8')).hexdigest()[:12]


def text_path(path):
    """A path as text (review 02.10): the client gives its folder as bytes (os.getcwd() in Python 2), and a file name outside
    ASCII there must neither break a walk of it nor the snapshot's text."""
    if isinstance(path, bytes):
        try:
            return path.decode(sys.getfilesystemencoding() or 'mbcs')
        except Exception:
            return path.decode('utf-8', 'replace')
    return path


def text_identity(text):
    """The snapshot's name of a client: its version label and a hash of the whole version text (review 02.10 #7: an update
    that changes only <meta> keeps the label - its snapshot must not take the earlier one's place)."""
    canonical = (text or '').lstrip(u'﻿').replace('\r\n', '\n')
    return '%s~%s' % (version_label(text), hashlib.sha1(canonical.encode('utf-8')).hexdigest()[:8])


def replace_file(temp, path):
    """temp becomes path: os.replace where there is one; else the old file is moved aside first and put back on a failure
    (the client's Python 2 on Windows has neither os.replace nor an atomic rename over a file)."""
    if hasattr(os, 'replace'):
        os.replace(temp, path)
        return
    previous = path + '.previous'
    if os.path.isfile(path):
        if os.path.isfile(previous): os.remove(previous)
        os.rename(path, previous)
    try:
        os.rename(temp, path)
    except Exception:
        if not os.path.isfile(path) and os.path.isfile(previous): os.rename(previous, path)
        raise
    if os.path.isfile(previous): os.remove(previous)


def file_crc(path):
    crc = 0
    with open(path, 'rb') as stream:
        while True:
            chunk = stream.read(1 << 20)
            if not chunk: break
            crc = zlib.crc32(chunk, crc)
    return crc & 0xffffffff


def kind_of(path):
    for name, pattern in KINDS:
        if pattern.search(path): return name
    return 'other scripts'


class ClientSnapshot(object):
    """The client's in-scope files now; `refresh` once a session (setup), then `files`/`crc`/`signature`."""

    def __init__(self, game, folder, version_text=''):
        self.game = text_path(os.path.abspath(game))
        self.root = os.path.join(text_path(os.path.abspath(folder)), u'data', u'client')
        self.version_text = version_text or ''
        self.failed = set()      # sources that did not read this time (left out, read again next start)
        self.sources = None      # [(source, {path: (crc, size)})] in mount order
        self.effective = None    # {path: (crc, size)} - the first source that has a path
        self.id = None
        self.diff = None         # what the last refresh found changed: {'changed', 'added', 'removed'} or None
        self.previous_label = None
        self.others = {}         # {label: files} of other client versions (files)

    # ---- where the sources are and what they look like now (stat only)
    def mount(self):
        """[(source, kind, path)] in the order the client mounts them: the Paths of paths.xml (res_mods/<v>, mods/<v>), then
        its Packages; without a paths.xml (a test, an older layout) the packages of res/packages, sorted."""
        found, paths, packages = [], [], []
        manifest = os.path.join(self.game, 'paths.xml')
        if os.path.isfile(manifest):
            root = ET.parse(manifest).getroot()
            for node in root.iter('Path'):
                paths.append(os.path.normpath(os.path.join(self.game, (node.text or '').strip())))
            for node in root.iter('Package'):
                packages.append(os.path.normpath(os.path.join(self.game, (node.text or '').strip())))
        else:
            packages = sorted(glob.glob(os.path.join(self.game, 'res', 'packages', '*.pkg')))
        for folder in paths:
            if not os.path.isdir(folder): continue
            relative = os.path.relpath(folder, self.game).replace('\\', '/')
            if relative.startswith('res_mods'):
                found.append(('loose:' + relative, 'loose', folder))
            else:
                for base, _, names in sorted(os.walk(folder)):
                    for name in sorted(names):
                        if name.lower().endswith('.wotmod') and not OWN_PACKAGE.match(name):
                            path = os.path.join(base, name)
                            found.append(('wotmod:' + os.path.relpath(path, self.game).replace('\\', '/'), 'wotmod', path))
        seen = set()
        for path in packages:
            if path.lower().endswith('.pkg') and os.path.isfile(path) and path not in seen:
                seen.add(path)
                found.append(('pkg:' + os.path.basename(path), 'pkg', path))
        texts = os.path.join(self.game, *TEXTS.split('/'))
        if os.path.isdir(texts): found.append(('texts', 'texts', texts))
        return found

    def loose_files(self, kind, path):
        """{relative path: (size, mtime)} of a loose source's in-scope files (res_mods: the scope; texts: *.mo)."""
        files = {}
        for base, _, names in os.walk(path):
            for name in names:
                full = os.path.join(base, name)
                relative = os.path.relpath(full, path).replace('\\', '/')
                if kind == 'texts':
                    if not name.endswith('.mo'): continue
                    relative = TEXTS + '/' + relative
                elif not SCOPE.search(relative):
                    continue
                elif relative.startswith(OVERRIDE_TEXTS):
                    relative = 'res/' + relative
                try:
                    stat = os.stat(full)
                except OSError:
                    continue
                files[relative] = (int(stat.st_size), int(stat.st_mtime))
        return files

    def skip(self, source, error):
        """A source that does not read (a broken .wotmod, a locked package): left out of this snapshot with one line, and
        read again at the next start - never the whole snapshot (review 02.10 #1)."""
        if source not in self.failed:
            self.failed.add(source)
            LOG.warning('Client files: %s left out of the snapshot (%r); it is read again next start', source, error)

    def stats(self):
        """What the sources look like now: version.xml, paths.xml, each package's and .wotmod's size and time, each loose
        file's. Cheap: no file is read but the two small manifests."""
        result = {'format': SNAPSHOT_FORMAT, 'version': '%08x' % (zlib.crc32(self.version_text.encode('utf-8')) & 0xffffffff)}
        manifest = os.path.join(self.game, 'paths.xml')
        result['paths'] = '%08x' % file_crc(manifest) if os.path.isfile(manifest) else ''
        sources = []
        for source, kind, path in self.mount():
            try:
                if kind in ('pkg', 'wotmod'):
                    stat = os.stat(path)
                    # The time to the client's precision (a package rewritten within one second, the same size, is not missed).
                    sources.append([source, int(stat.st_size), repr(stat.st_mtime)])
                else:
                    files = self.loose_files(kind, path)
                    sources.append([source, sorted([name, size, mtime] for name, (size, mtime) in files.items())])
            except Exception as error:
                self.skip(source, error)
        result['sources'] = sources
        return result

    # ---- the stored snapshots: one file per client version (its label, `<version>` of version.xml), the last KEEP of them
    def path(self, name):
        return os.path.join(self.root, name)

    @staticmethod
    def file_name(identity):
        return re.sub(r'[^-.~A-Za-z0-9]+', '_', identity or 'unknown').strip('_') + '.txt.gz'

    def read_json(self, name):
        try:
            with open(self.path(name), 'rb') as stream:
                value = json.loads(stream.read().decode('utf-8'))
            return value if isinstance(value, dict) and value.get('format') == SNAPSHOT_FORMAT else None
        except Exception:
            return None

    def write_json(self, name, value):
        if not os.path.isdir(self.root): os.makedirs(self.root)
        temp = self.path(name) + '.tmp'
        with open(temp, 'wb') as stream: stream.write(json.dumps(value, sort_keys=True, ensure_ascii=True).encode('ascii'))
        replace_file(temp, self.path(name))

    def read_stats(self):
        return self.read_json('stats.json')

    @staticmethod
    def load(path):
        """(id, [(source, {path: (crc, size)})]) of a stored snapshot, or (None, None)."""
        try:
            with gzip.open(path, 'rb') as stream:
                text = stream.read().decode('utf-8')
        except Exception:
            return None, None
        lines = text.split('\n')
        if not lines or lines[0] != '#bullba-client-snapshot %d' % SNAPSHOT_FORMAT: return None, None
        # A damaged file (review 02.10 #1): any line that does not read, or no '#end', is no snapshot - it is taken again.
        if '#end' not in lines[-3:]: return None, None
        ident, sources, current = None, [], None
        try:
            for line in lines[1:]:
                if not line or line == '#end' or line.startswith('#client '): continue
                if line.startswith('#id '):
                    ident = line[4:]
                elif line.startswith('@'):
                    current = {}
                    sources.append((line[1:], current))
                elif current is not None:
                    name, crc, size = line.rsplit('\t', 2)
                    current[name] = (int(crc, 16), int(size))
                else:
                    return None, None
        except ValueError:
            return None, None
        return ident, sources

    @staticmethod
    def dump(path, ident, sources, label):
        lines = [u'#bullba-client-snapshot %d' % SNAPSHOT_FORMAT, u'#id ' + ident, u'#client ' + text_path(label)]
        for source, members in sources:
            lines.append(u'@' + text_path(source))
            lines.extend(u'%s\t%s\t%d' % (text_path(name), '%08x' % crc if crc >= 0 else '-1', size)
                         for name, (crc, size) in sorted(members.items()))
        lines.append(u'#end')
        data = (u'\n'.join(lines) + u'\n').encode('utf-8')
        folder = os.path.dirname(path)
        if not os.path.isdir(folder): os.makedirs(folder)
        buffer = io.BytesIO()
        with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0) as stream: stream.write(data)
        temp = path + '.tmp'
        with open(temp, 'wb') as stream: stream.write(buffer.getvalue())
        replace_file(temp, path)

    @staticmethod
    def merge(sources):
        effective = {}
        for source, members in sources:
            for name, entry in members.items():
                if name not in effective: effective[name] = entry
        return effective

    @staticmethod
    def identify(effective):
        digest = hashlib.sha1()
        for name in sorted(effective):
            digest.update((u'%s\t%d\t%d\n' % (text_path(name), effective[name][0], effective[name][1])).encode('utf-8'))
        return digest.hexdigest()[:16]

    def label(self):
        return version_label(self.version_text)

    def identity(self):
        return text_identity(self.version_text)

    # ---- taking it
    def take(self, stats, previous):
        """The sources now, each package or .wotmod with the size and time of the previous snapshot's taken from it; a loose
        file's CRC read only when its size or time moved."""
        old_stats = dict((entry[0], entry[1:]) for entry in (previous[0] or {}).get('sources') or ())
        old_members = dict(previous[1] or ())
        sources = []
        mounts = dict((source, (kind, path)) for source, kind, path in self.mount())
        for entry in stats['sources']:
            source = entry[0]
            kind, path = mounts[source]
            try:
                if kind in ('pkg', 'wotmod'):
                    if old_stats.get(source) == entry[1:] and source in old_members:
                        members = old_members[source]
                    else:
                        members = package_members(path, 'res/' if kind == 'wotmod' else '')
                else:
                    before = dict((name, (size, mtime)) for name, size, mtime in (old_stats.get(source) or [[]])[0])
                    before_members = old_members.get(source) or {}
                    members = {}
                    for name, size, mtime in entry[1]:
                        if before.get(name) == (size, mtime) and name in before_members:
                            members[name] = before_members[name]
                        else:
                            relative = name[len(TEXTS) + 1:] if kind == 'texts' else name[4:] if name.startswith('res/text/') else name
                            try:
                                members[name] = (file_crc(os.path.join(path, *relative.split('/'))), size)
                            except (IOError, OSError):
                                members[name] = (UNKNOWN, size)
            except Exception as error:
                # Left out (skip): what it held last time stays, its CRCs unknown - every key on it changes, nothing is
                # taken for current on it; nothing known of it before - it is simply not there this time.
                self.skip(source, error)
                members = dict((name, (UNKNOWN, old[1])) for name, old in (old_members.get(source) or {}).items())
            sources.append((source, members))
        return sources

    def refresh(self):
        """Once a session (setup): the sources unchanged and the stored snapshot whole - nothing else read; changed - a new
        snapshot of this client (an earlier client's file stays, the last KEEP of them), one log line. A source that does not
        read is left out (skip) and tried again next start; a damaged stored snapshot is taken again. Returns the difference
        with the last snapshot ({} when unchanged, None without an earlier one)."""
        stats = self.stats()
        old_stats = self.read_stats()
        index = self.read_json('versions.json') or {'format': SNAPSHOT_FORMAT, 'current': None, 'order': []}
        identity = self.identity()
        last = index.get('current')
        if (old_stats is not None and last == identity and not self.failed and old_stats.get('sources') == stats['sources']
                and old_stats.get('paths') == stats['paths'] and old_stats.get('version') == stats['version']):
            ident, sources = self.load(self.path(self.file_name(identity)))
            if sources is not None and ident == old_stats.get('id'):
                self.id, self.sources, self.effective = ident, sources, self.merge(sources)
                self.diff = {}
                return self.diff
            LOG.warning('Client files: the stored snapshot does not read; it is taken again')
            old_stats = None
        previous_id, previous_sources = self.load(self.path(self.file_name(last))) if last else (None, None)
        self.sources = self.take(stats, (old_stats if previous_sources is not None else None, previous_sources))
        self.effective = self.merge(self.sources)
        self.id = self.identify(self.effective)
        self.dump(self.path(self.file_name(identity)), self.id, self.sources, self.label())
        order = [name for name in index.get('order') or () if name != identity] + [identity]
        for old in order[:-KEEP]:
            try: os.remove(self.path(self.file_name(old)))
            except OSError: pass
        index.update({'current': identity, 'order': order[-KEEP:]})
        self.write_json('versions.json', index)
        # A source left out is not remembered as read: the next start reads it again.
        stats['sources'] = [entry for entry in stats['sources'] if entry[0] not in self.failed]
        stats['id'], stats['previous'] = self.id, previous_id
        self.write_json('stats.json', stats)
        self.previous_label = last
        if previous_sources is None:
            self.diff = None
            LOG.info('Client files: first snapshot of %s, %d files the mod reads (no earlier one to compare)',
                     self.label(), len(self.effective))
            return None
        old = self.merge(previous_sources)
        self.diff = {'changed': sorted(p for p in self.effective if p in old and old[p] != self.effective[p]),
                     'added': sorted(p for p in self.effective if p not in old),
                     'removed': sorted(p for p in old if p not in self.effective)}
        self.log_diff()
        return self.diff

    def log_diff(self):
        diff = self.diff or {}
        every = diff.get('changed', []) + diff.get('added', []) + diff.get('removed', [])
        if not every:
            LOG.info('Client files changed since the last start: none of the %d the mod reads (%s)', len(self.effective or ()),
                     self.label())
            return
        counts = {}
        for name in every: counts[kind_of(name)] = counts.get(kind_of(name), 0) + 1
        order = [name for name, _ in KINDS]
        first = sorted(every, key=lambda p: (order.index(kind_of(p)), p))[:6]
        LOG.info('Client files changed since the last start (%s): %d changed, %d added, %d removed - %s; first: %s',
                 self.label(), len(diff['changed']), len(diff['added']), len(diff['removed']),
                 ', '.join('%s %d' % (name, counts[name]) for name in order if name in counts), ', '.join(first))

    # ---- reading it
    def files(self, version_text=None):
        """{path: (crc, size)} of the client now (the effective copy of every in-scope path), or - `version_text`, another
        client's version.xml text (a battle's clientVersion) - of that client: its own snapshot when this mod took one, else
        one derived from this snapshot and the paths the update between them changed (client_changes.CHANGES; such a path's
        CRC is UNKNOWN, so it never equals a real one). None when nothing is known of that client."""
        if version_text is not None and text_identity(version_text) != self.identity():
            return self.other(version_text)
        if self.effective is None:
            ident, sources = self.load(self.path(self.file_name(self.identity())))
            if sources is None: raise ValueError('No client snapshot')
            self.sources, self.effective = sources, self.merge(sources)
            if self.id is None: self.id = ident
        return self.effective

    def other(self, version_text):
        identity = text_identity(version_text)
        if identity in self.others: return self.others[identity]
        found = None
        ident, sources = self.load(self.path(self.file_name(identity)))
        if sources is not None:
            found = self.merge(sources)
        else:
            from .client_changes import CHANGES
            label = version_label(version_text)
            for change in CHANGES:
                if change['from'] != label or change['to'] != self.label(): continue
                found = dict(self.files())
                for path in change['changed']:
                    if path in found: found[path] = (UNKNOWN, found[path][1])
                break
        self.others[identity] = found
        return found

    def crc(self, path, version_text=None):
        """('%08x' CRC, size) of one client file as the game reads it (or as the client of `version_text` read it), None when
        that client has no such file in scope or nothing is known of it; an unknown CRC (a derived snapshot) is '?'."""
        files = self.files(version_text)
        entry = None if files is None else files.get(path)
        if entry is None: return None
        return ('?' if entry[0] == UNKNOWN else '%08x' % entry[0], entry[1])

    def signature(self, paths):
        """One CRC-32 ('%08x') over the given files' CRCs and sizes (a missing file counts as missing)."""
        files = self.files()
        text = '\n'.join('%s=%s' % (p, '%08x:%d' % files[p] if p in files else '-') for p in sorted(set(paths)))
        return '%08x' % (zlib.crc32(text.encode('utf-8')) & 0xffffffff)

    def read(self, path):
        """The bytes of one in-scope file of the client now, from the source the snapshot took it from (a package, a .wotmod
        or a loose file); None when there is none. For the code's identity (Exporter.module_identity)."""
        self.files()
        mounts = self.__dict__.get('mounts')
        if mounts is None: mounts = self.__dict__['mounts'] = dict((source, (kind, where)) for source, kind, where in self.mount())
        for source, members in self.sources or ():
            if path not in members: continue
            kind, where = mounts.get(source, (None, None))
            if kind in ('pkg', 'wotmod'):
                # One open archive per source while reading (a package's directory parsed once, not once per module).
                archives = self.__dict__.setdefault('archives', {})
                if where not in archives: archives[where] = zipfile.ZipFile(where)
                return archives[where].read(('res/' if kind == 'wotmod' else '') + path)
            if kind in ('loose', 'texts'):
                relative = path[len(TEXTS) + 1:] if kind == 'texts' else path[4:] if path.startswith('res/text/') else path
                with open(os.path.join(where, *relative.split('/')), 'rb') as stream: return stream.read()
            return None
        return None

    def close(self):
        """Let go of the archives read() opened."""
        self.__dict__.pop('mounts', None)
        for archive in (self.__dict__.pop('archives', None) or {}).values():
            try: archive.close()
            except Exception: pass

    def matching(self, pattern):
        """The in-scope paths a compiled pattern finds (search)."""
        return [p for p in self.files() if pattern.search(p)]
