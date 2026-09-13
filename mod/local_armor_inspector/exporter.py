# -*- coding: utf-8 -*-
"""Produce ordinary local HTML + classic-script data. No sockets or processes.

Runs only on the recorder's worker thread. Game objects and ResMgr are never used.
JSONL is authoritative; every file written here can be regenerated from it and
the matching client resources. Models are retained across game updates.
"""
from __future__ import absolute_import
import copy
import glob
import hashlib
import json
import logging
import os
import re
import sys
import time
import zipfile
from .geometry import extract
from .armor import ArmorCatalog

LOG = logging.getLogger('local.armor_inspector')
VERSION = '0.6.22'
KEEP_BATTLES = 5
RESOURCE = re.compile(r'^vehicles/[A-Za-z0-9_/-]+\.(?:model|havok)\Z')
IDENTIFIER = re.compile(r'^[-a-zA-Z0-9_]{1,100}\Z')
ASSETS = ('Viewer.html', 'web/style.css', 'web/icon.svg', 'web/viewer.js',
          'web/local-data.js', 'web/host.js', 'web/app.js', 'web/ballistics.js', 'web/heatmap-gpu.js', 'web/shot-telemetry.js', 'web/shot-context.js', 'web/screen-armor.js', 'web/vendor/three.min.js',
          'web/vendor/three.LICENSE', 'licenses/TagTools.txt', 'licenses/BattleHits.txt')


def canonical(version):
    return version.lstrip(u'\ufeff').replace('\r\n', '\n')


def model_key(resource, version):
    if not RESOURCE.match(resource) or '..' in resource:
        raise ValueError('Invalid collision resource')
    return hashlib.sha256((canonical(version)+'\n'+resource).encode('utf-8')).hexdigest()


def atomic_write(path, data):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    temp = path + '.tmp'
    with open(temp, 'wb') as stream: stream.write(data)
    if hasattr(os, 'replace'):
        os.replace(temp, path)
    elif os.name == 'nt':
        # The client does not ship _ctypes or os.replace. Retain the last good
        # file until rename succeeds; JSONL also permits rebuilding after exit.
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
    else:
        os.rename(temp, path)


def write_data(path, key, value):
    # JSON is serialized, never interpolated into executable text unescaped.
    payload = json.dumps([key, value], ensure_ascii=True, allow_nan=False, separators=(',', ':'))
    payload = payload.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    atomic_write(path, ('ArmorInspectorData.receive('+payload+');\n').encode('ascii'))


def read_battle(path):
    header, hits, warnings, shot_events = None, [], [], []
    with open(path, 'rb') as stream:
        for number in range(20001):
            line = stream.readline(2*1024*1024+1)
            if not line: break
            if number == 20000 or len(line) > 2*1024*1024:
                raise ValueError('Battle exceeds export limit')
            if not line.endswith(b'\n'): break
            try:
                row = json.loads(line.decode('utf-8'))
                if row.get('schema') != 1: raise ValueError('Unknown schema')
                if row.get('type') == 'battle' and header is None: header = row
                elif row.get('type') == 'hit': hits.append(row)
                elif row.get('type') == 'shot': shot_events.append(row)
                else: raise ValueError('Unexpected record')
            except (ValueError, AttributeError): warnings.append('Unreadable record at line '+str(number+1))
    if header is None:
        # Explicit, hash-bound metadata can recover the header lost by 0.2.0.
        # Never guess the client version from whatever client is installed now.
        sidecar = path + '.recovery.json'
        if not os.path.isfile(sidecar): raise ValueError('Battle header unavailable')
        with open(sidecar, 'rb') as stream:
            recovery = json.loads(stream.read(65537).decode('utf-8'))
        digest = hashlib.sha256()
        with open(path, 'rb') as stream:
            while True:
                chunk = stream.read(65536)
                if not chunk: break
                digest.update(chunk)
        if recovery.get('rawSha256') != digest.hexdigest():
            raise ValueError('Recovery metadata does not match the raw battle')
        header = recovery['header']
        if (header.get('schema') != 1 or header.get('type') != 'battle' or
                header.get('id') != os.path.basename(path)[:-6] or not header.get('clientVersion')):
            raise ValueError('Invalid recovery header')
        warnings.extend(recovery.get('warnings', []))
    result = dict(header)
    result.update({'id':os.path.basename(path)[:-6], 'hits':hits, 'shotEvents':shot_events, 'warnings':warnings})
    return result


class Exporter(object):
    def __init__(self, game, folder, version, archive=None):
        self.game = os.path.abspath(game)
        self.folder = os.path.abspath(folder)
        self.version = canonical(version)
        self.archive = archive
        self.packages = None
        self.overrides = None
        self.attempts = {}
        self.summaries = {}
        self.model_refs = {}
        self.current = None
        self.armor = ArmorCatalog(self.game)

    def setup(self):
        archive = self.archive
        if archive is None:
            candidates = glob.glob(os.path.join(self.game, 'mods', '*', 'local.armor_inspector_'+VERSION+'.wotmod'))
            if len(candidates) != 1: raise ValueError('Cannot locate the installed viewer package')
            archive = candidates[0]
        with zipfile.ZipFile(archive) as z:
            for name in ASSETS:
                atomic_write(os.path.join(self.folder, *name.split('/')), z.read('res/armor_inspector_viewer/'+name))
        # Rebuild derived records after an interrupted game. Raw JSONL is untouched.
        for path in sorted(glob.glob(os.path.join(self.folder, 'battles', '*.jsonl'))):
            try:
                battle = read_battle(path)
                if not IDENTIFIER.match(battle['id']): continue
                self.publish(battle)
            except Exception: LOG.exception('Could not rebuild saved battle: %s', os.path.basename(path))
        self.write_index()

    def _index_resources(self):
        self.packages, self.overrides = {}, set()
        for path in sorted(glob.glob(os.path.join(self.game, 'res', 'packages', 'vehicles*.pkg'))):
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    if '/collision_client/' in name and name.endswith('.havok'): self.packages[name] = path
        for path in glob.glob(os.path.join(self.game, 'mods', '*', '*.wotmod')):
            with zipfile.ZipFile(path) as z:
                self.overrides.update(n[4:] for n in z.namelist() if n.startswith('res/vehicles/'))

    def model(self, resource, version):
        key = model_key(resource, version)
        path = os.path.join(self.folder, 'data', 'models', key+'.js')
        if key in self.attempts: return key, self.attempts[key]
        if os.path.isfile(path):
            self.attempts[key] = None
            return key, None
        try:
            if canonical(version) != self.version:
                raise ValueError('Client version changed; model was not saved before the update')
            name = resource.rsplit('.', 1)[0]+'.havok'
            if self.packages is None: self._index_resources()
            if name not in self.packages: raise ValueError('Collision model not found in client')
            if name in self.overrides or resource in self.overrides:
                raise ValueError('A mod overrides this collision model')
            for root in glob.glob(os.path.join(self.game, 'res_mods', '*')):
                if os.path.isfile(os.path.join(root, name)) or os.path.isfile(os.path.join(root, resource)):
                    raise ValueError('res_mods overrides this collision model')
            with zipfile.ZipFile(self.packages[name]) as z:
                if z.getinfo(name).file_size > 32*1024*1024: raise ValueError('Model too large')
                data = z.read(name)
            model = extract(data)
            model.update({'resource':name, 'sha256':hashlib.sha256(data).hexdigest()})
            write_data(path, 'model:'+key, model)
            self.attempts[key] = None
        except Exception as exc:
            self.attempts[key] = str(exc)
            LOG.warning('Model export unavailable: %s: %s', resource, exc)
        return key, self.attempts[key]

    def publish(self, battle):
        if not IDENTIFIER.match(battle['id']): raise ValueError('Invalid battle id')
        result = copy.deepcopy(battle)
        for hit in result['hits']:
            for part in hit.get('target', {}).get('parts', []):
                try:
                    key, error = self.model(part['resource'], result['clientVersion'])
                    part['modelKey'] = key
                    if error: part['modelError'] = error
                except Exception as exc: part['modelError'] = str(exc)
                if 'armor' not in part:
                    try:
                        identity = '\n'.join((canonical(result['clientVersion']), hit['target']['type'],
                            hit['target'].get('compactDescriptor', ''), part['resource']))
                        key = hashlib.sha256(identity.encode('utf-8')).hexdigest()
                        cache = os.path.join(self.folder, 'data', 'armor', key+'.json')
                        if os.path.isfile(cache):
                            with open(cache, 'rb') as stream: part['armor'] = json.loads(stream.read(1024*1024).decode('ascii'))
                        else:
                            if canonical(result['clientVersion']) != self.version:
                                raise ValueError('Armor metadata was not saved for the old client version')
                            part['armor'] = self.armor.materials(hit['target']['type'], part['resource'])
                            atomic_write(cache, json.dumps(part['armor'], ensure_ascii=True, allow_nan=False).encode('ascii'))
                        part['armorSource'] = 'version-matched client XML (cached)'
                    except Exception as exc:
                        part['armorError'] = str(exc)
                        # A separate, visibly labelled comparison is allowed only
                        # when today's mesh is byte-identical to the saved mesh.
                        if canonical(result['clientVersion']) != self.version and not part.get('modelError'):
                            try:
                                if self.packages is None: self._index_resources()
                                havok = part['resource'].rsplit('.', 1)[0]+'.havok'
                                if havok in self.overrides or part['resource'] in self.overrides:
                                    raise ValueError('Current collision model is overridden')
                                for override_root in glob.glob(os.path.join(self.game, 'res_mods', '*')):
                                    if any(os.path.isfile(os.path.join(override_root, r)) for r in (havok, part['resource'])):
                                        raise ValueError('Current collision model is overridden')
                                current_key, error = self.model(part['resource'], self.version)
                                if error: raise ValueError(error)
                                meshes = []
                                for model_id in (part['modelKey'], current_key):
                                    with open(os.path.join(self.folder, 'data', 'models', model_id+'.js'), 'rb') as stream:
                                        payload = stream.read(32*1024*1024).decode('ascii')
                                    meshes.append(json.loads(payload[len('ArmorInspectorData.receive('):-3])[1])
                                if meshes[0]['sha256'] != meshes[1]['sha256']:
                                    raise ValueError('Current geometry differs from this battle')
                                with zipfile.ZipFile(self.packages[havok]) as resource_zip:
                                    if resource_zip.getinfo(havok).file_size > 32*1024*1024: raise ValueError('Model too large')
                                    current_hash = hashlib.sha256(resource_zip.read(havok)).hexdigest()
                                if current_hash != meshes[0]['sha256']:
                                    raise ValueError('Current geometry differs from the cached mesh')
                                part['comparisonArmor'] = self.armor.materials(hit['target']['type'], part['resource'])
                                match = re.search(r'<version>\s*(.*?)\s*</version>', self.version)
                                part['comparisonVersion'] = match.group(1) if match else 'current client'
                            except Exception as comparison_error: part['comparisonError'] = str(comparison_error)
        write_data(os.path.join(self.folder, 'data', 'battles', battle['id']+'.js'), 'battle:'+battle['id'], result)
        self.model_refs[battle['id']] = set(part['modelKey'] for hit in result['hits']
                                            for part in hit.get('target', {}).get('parts', []) if part.get('modelKey'))
        self.summaries[battle['id']] = dict((k, battle.get(k)) for k in ('id', 'startedAt', 'map'))
        self.summaries[battle['id']]['hits'] = len(battle['hits'])

    def record(self, name, record):
        if record['type'] == 'battle':
            self.flush(force=True)
            self.current = dict(record)
            self.current.update({'id':name, 'hits':[], 'shotEvents':[], 'warnings':[]})
        elif self.current is not None and self.current['id'] == name:
            self.current.setdefault('shotEvents' if record['type'] == 'shot' else 'hits', []).append(record)
        else:
            self.current = read_battle(os.path.join(self.folder, 'battles', name+'.jsonl'))
        self.pending_publish = True
        self.flush(force=record['type'] != 'shot')

    def flush(self, force=False):
        if not getattr(self, 'pending_publish', False): return
        if not force and time.time()-getattr(self, 'last_published', 0) < 1: return
        self.publish(self.current)
        self.write_index()
        self.pending_publish = False
        self.last_published = time.time()

    def prune(self):
        # Storage hygiene: only the newest KEEP_BATTLES battles stay, raw JSONL and derived files alike;
        # models stay while any kept battle references them. The battle being recorded is never dropped.
        current = self.current['id'] if self.current else None
        ordered = sorted(self.summaries.values(), key=lambda b:(b['id'] == current, b.get('startedAt') or 0), reverse=True)
        for old in ordered[KEEP_BATTLES:]:
            for path in (os.path.join(self.folder, 'battles', old['id']+'.jsonl'),
                         os.path.join(self.folder, 'data', 'battles', old['id']+'.js')):
                try:
                    if os.path.isfile(path): os.remove(path)
                except Exception: LOG.exception('Could not remove old battle file: %s', path)
            self.summaries.pop(old['id'], None)
            self.model_refs.pop(old['id'], None)
        referenced = set()
        for keys in self.model_refs.values(): referenced.update(keys)
        for path in glob.glob(os.path.join(self.folder, 'data', 'models', '*.js')):
            key = os.path.basename(path)[:-3]
            if key in referenced: continue
            try: os.remove(path)
            except Exception: LOG.exception('Could not remove unreferenced model: %s', path)
            self.attempts.pop(key, None)

    def write_index(self):
        self.prune()
        battles = sorted(self.summaries.values(), key=lambda b:b.get('startedAt') or 0, reverse=True)
        write_data(os.path.join(self.folder, 'data', 'index.js'), 'index',
                   {'application':'local.armor_inspector', 'version':VERSION, 'updatedAt':time.time(), 'battles':battles})
