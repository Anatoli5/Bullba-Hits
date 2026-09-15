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
VERSION = '0.7.0'
RESOURCE = re.compile(r'^vehicles/[A-Za-z0-9_/-]+\.(?:model|havok)\Z')
IDENTIFIER = re.compile(r'^[-a-zA-Z0-9_]{1,100}\Z')
ASSETS = ('Viewer.html', 'web/style.css', 'web/icon.svg', 'web/viewer.js',
          'web/local-data.js', 'web/host.js', 'web/app.js', 'web/ballistics.js', 'web/shot-telemetry.js', 'web/shot-context.js', 'web/screen-armor.js', 'web/vendor/three.min.js',
          'web/vendor/three.LICENSE', 'web/vendor/three-mesh-bvh.umd.js',
          'web/vendor/three-mesh-bvh.LICENSE', 'licenses/TagTools.txt', 'licenses/BattleHits.txt')


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


def read_data_file(path):
    """The value written by write_data, read back from a classic-script payload."""
    with open(path, 'rb') as stream:
        payload = stream.read(64*1024*1024).decode('ascii')
    prefix, suffix = 'ArmorInspectorData.receive(', ');\n'
    if not payload.startswith(prefix) or not payload.endswith(suffix):
        raise ValueError('Not an exported data file')
    return json.loads(payload[len(prefix):-len(suffix)])[1]


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


VEHICLE_CLASS_TAGS = ('lightTank', 'mediumTank', 'heavyTank', 'AT-SPG', 'SPG')


def enrich_vehicle(vehicle):
    """Add tier/class/role/nation to a recorded attacker/target when they are missing.

    Battles written before the recorder learned these fields are re-published on
    every run, so they pick the data up here. Purely additive and fully guarded:
    the export must never fail because a vehicle type cannot be resolved.
    """
    if not isinstance(vehicle, dict):
        return
    type_name = vehicle.get('type')
    if not type_name:
        return
    if vehicle.get('nation') is None:
        try:
            vehicle['nation'] = str(type_name.split(':')[0])
        except Exception:
            pass
    fix_gun_height(vehicle)
    fix_gun_dispersion(vehicle)
    if all(vehicle.get(key) is not None for key in ('level', 'class', 'role')):
        return
    try:
        from items import vehicles
        nation_id, innation_id = vehicles.g_list.getIDsByName(type_name)
        vtype = vehicles.g_cache.vehicle(nation_id, innation_id)
    except Exception:
        return
    if vehicle.get('level') is None:
        try:
            vehicle['level'] = int(vtype.level)
        except Exception:
            pass
    if vehicle.get('class') is None:
        try:
            for tag in vtype.tags:
                if tag in VEHICLE_CLASS_TAGS:
                    vehicle['class'] = str(tag)
                    break
        except Exception:
            pass
    if vehicle.get('role') is None:
        try:
            from constants import ROLE_TYPE_TO_LABEL
            label = ROLE_TYPE_TO_LABEL.get(vtype.role)
            if label and label != 'NotDefined':
                vehicle['role'] = str(label)
        except Exception:
            pass


def fix_gun_height(vehicle):
    """Recompute 'gunHeight' from the ground for records made before 0.6.34.

    Those records summed the turret and gun positions but not the hull's height
    on the chassis, so the orbit centre sat about a metre too low. The compact
    descriptor of the shooter is recorded, so the exact mounted turret and gun
    are known. Guarded like everything else here.
    """
    if vehicle.get('gunHeightFrom') == 'ground' or not vehicle.get('compactDescriptor'):
        return
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        vehicle['gunHeight'] = float((descr.chassis.hullPosition + descr.hull.turretPositions[0] + descr.turret.gunPosition).y)
        vehicle['gunHeightFrom'] = 'ground'
    except Exception:
        pass


def fix_gun_dispersion(vehicle):
    """Recompute 'gunDispersion' for records made before 0.6.29 did not save it.

    The viewer draws the nominal full-aim circle of every hit without a recorded
    reticle from this number, so an old battle would show no estimate ring at all.
    The mounted gun is known exactly from the compact descriptor, and the client's
    own gun.shotDispersionAngle is the same value the recorder writes today.
    Guarded like fix_gun_height next to it.
    """
    existing = vehicle.get('gunDispersion')
    if isinstance(existing, (int, float)) and existing > 0:
        return
    if not vehicle.get('compactDescriptor'):
        return
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        dispersion = float(descr.gun.shotDispersionAngle)
        if dispersion > 0:
            vehicle['gunDispersion'] = dispersion
    except Exception:
        pass


PARTS = ('chassis', 'hull', 'turret', 'gun')


def translation_columns(offset):
    """The column-major layout the recorder's matrix_columns writes, without rotation.

    Three axis columns, each with a trailing 0.0, then the offset with a trailing 1.0.
    """
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            float(offset[0]), float(offset[1]), float(offset[2]), 1.0]


def vehicle_descr(compact_descriptor):
    """The client's own VehicleDescr for a recorded base64 compact descriptor.

    Publishing runs inside the game (the exporter is imported by the mod), so
    items.vehicles is available; outside it this raises, and every caller is guarded.
    """
    import base64
    from items import vehicles
    return vehicles.VehicleDescr(compactDescr=base64.b64decode(compact_descriptor))


def parts_from_descr(descr, armor_source='client descriptor rebuilt from the record'):
    """A vehicle descriptor in, its four collision parts out - no battle record involved.

    The parts are placed in the rest pose in the chassis frame, the way the client
    itself stacks them (vehicles.py VehicleDescr.__updateAttributes) and the way the
    recorder now writes the shooter's parts: chassis at the origin, hull at
    chassis.hullPosition, turret at hull.turretPositions[0] above it, gun at
    turret.gunPosition above that, no rotation.

    Kept as a function of a descriptor alone on purpose: the planned vehicle browser
    (any vehicle of the client, picked by tier / nation / class / role) needs parts for
    a descriptor that never took part in a battle, and this is the whole of what it
    needs. Failures are per part, like the recorder's.
    """
    from .armor import live_materials
    hull = descr.chassis.hullPosition
    turret = hull + descr.hull.turretPositions[0]
    gun = turret + descr.turret.gunPosition
    offsets = ((0.0, 0.0, 0.0), hull, turret, gun)
    parts = []
    for idx, name in enumerate(PARTS):
        component = getattr(descr, name, None)
        part = {'id':idx, 'name':name}
        try:
            part['armor'] = live_materials(component)
            part['armorSource'] = armor_source
        except Exception:
            pass
        try:
            part['resource'] = component.hitTesterManager.activeHitTester.bspModelName
            part['transform'] = translation_columns(offsets[idx])
        except Exception:
            part['error'] = 'Part model or transform unavailable'
        parts.append(part)
    return parts


def synthesize_parts(vehicle):
    """Add the collision parts of a shooter recorded before 0.6.34.

    Only targets had parts then: nothing of the attacker was needed beyond his name
    and gun. His compact descriptor is recorded, so the exact mounted chassis, hull,
    turret and gun are known. Guarded like everything else here: an old record whose
    parts cannot be rebuilt simply keeps none, and the viewer leaves the swap disabled.
    """
    if not isinstance(vehicle, dict) or vehicle.get('parts') or not vehicle.get('compactDescriptor'):
        return
    try:
        vehicle['parts'] = parts_from_descr(vehicle_descr(vehicle['compactDescriptor']))
        vehicle['partsFrom'] = 'rest pose'
    except Exception:
        LOG.exception('Shooter collision parts could not be rebuilt; the hit is published as recorded')


VEHICLE_TAG_PREMIUM = 'premium'
VEHICLE_TAG_PREMIUM_IGR = 'premiumIGR'
VEHICLE_TAG_COLLECTOR = 'collectorVehicle'
VEHICLE_TAG_SPECIAL = 'special'
CATALOGUE_SKIP_TAGS = ('observer', 'bot')
DEFAULT_SETTINGS = {'exportAllVehicles': False}
NON_IDENTIFIER = re.compile(r'[^-a-zA-Z0-9_]')


def vehicle_id(type_name):
    """File id of a client vehicle type name, per the agreed data contract.

    'ussr:R45_IS-7' becomes 'ussr-R45_IS-7': only the first colon turns into a
    dash, everything outside [-A-Za-z0-9_] is replaced. The id is never split
    back apart - the type name travels next to it in every record.
    """
    return NON_IDENTIFIER.sub('_', str(type_name).replace(':', '-', 1))


def descriptor_hash(version, type_name, compact_descriptor):
    """Identity of one exported configuration: client version, type and descriptor."""
    identity = '\n'.join((canonical(version or ''), str(type_name or ''), str(compact_descriptor or '')))
    return hashlib.sha256(identity.encode('utf-8')).hexdigest()


def role_labels():
    """Every defined role label of the client, as the tag strings it uses.

    The client derives a vehicle's role from its tags: VehicleType.__getRoleFromTags
    looks for ROLE_TYPE_TO_LABEL[roleType] among the vehicle's own tags. The
    catalogue is built from g_list items, which carry the tags but not a parsed
    role, so the same rule is applied here instead of building a VehicleType (and
    with it parsing the whole XML) for every vehicle of the client.
    """
    try:
        from constants import ROLE_TYPE_TO_LABEL
        return set(label for label in ROLE_TYPE_TO_LABEL.values() if label and label != 'NotDefined')
    except Exception:
        return set()


def shot_candidates(descr):
    """Every AP/APCR/HEAT/HE shot of the mounted gun, in the shapes a hit uses.

    Kept as a module attribute on purpose: outside the game the client modules are
    missing, and a test can put a fixture in its place.
    """
    from .armor import shot_candidates as candidates
    return candidates(descr)


def gun_limits(descr):
    """Pitch limits of the mounted gun, the same object a hit's target carries."""
    from .presentation import gun_limits as limits
    return limits(descr)


def descr_identity(descr):
    """Identity of a VehicleDescr in the shapes of the vehicle contract.

    Every field is read on its own, exactly like the recorder's vehicle_identity:
    a missing or renamed client attribute must cost one field, never the export.
    The tag names are the client's own (gui Vehicle.isPremium/isSpecial read
    VEHICLE_TAGS.PREMIUM 'premium', PREMIUM_IGR 'premiumIGR', SPECIAL 'special';
    isCollectible reads CollectorVehicleConsts.COLLECTOR_VEHICLES_TAG
    'collectorVehicle').
    """
    identity = {}
    vtype = getattr(descr, 'type', None)
    if vtype is None:
        return identity
    try:
        identity['type'] = str(vtype.name)
    except Exception:
        pass
    try:
        identity['name'] = vtype.shortUserString
    except Exception:
        pass
    try:
        identity['level'] = int(vtype.level)
    except Exception:
        pass
    tags = ()
    try:
        tags = tuple(vtype.tags)
    except Exception:
        pass
    for tag in tags:
        if tag in VEHICLE_CLASS_TAGS:
            identity['class'] = str(tag)
            break
    try:
        from constants import ROLE_TYPE_TO_LABEL
        label = ROLE_TYPE_TO_LABEL.get(vtype.role)
        if label and label != 'NotDefined':
            identity['role'] = str(label)
    except Exception:
        pass
    try:
        identity['nation'] = str(vtype.name.split(':')[0])
    except Exception:
        pass
    identity['premium'] = VEHICLE_TAG_PREMIUM in tags or VEHICLE_TAG_PREMIUM_IGR in tags
    identity['collector'] = VEHICLE_TAG_COLLECTOR in tags
    identity['special'] = VEHICLE_TAG_SPECIAL in tags
    return identity


def catalogue_entry(nation, item, labels):
    """One catalogue row from an items.vehicles.g_list item, or None to skip it.

    g_list items carry name, level, tags and compactDescr, and (on the client)
    an i18n component whose shortString is what VehicleType.shortUserString
    returns. That is everything the catalogue needs, without parsing a vehicle.
    """
    type_name = str(getattr(item, 'name', '') or '')
    if ':' not in type_name:
        return None
    tags = ()
    try:
        tags = tuple(item.tags)
    except Exception:
        pass
    for tag in CATALOGUE_SKIP_TAGS:
        if tag in tags:
            return None
    entry_id = vehicle_id(type_name)
    if not IDENTIFIER.match(entry_id):
        return None
    entry = {'id':entry_id, 'type':type_name, 'nation':nation, 'name':type_name.split(':', 1)[1]}
    try:
        short = item.i18n.shortString
        if short:
            entry['name'] = short
    except Exception:
        pass
    try:
        entry['level'] = int(item.level)
    except Exception:
        return None
    for tag in tags:
        if tag in VEHICLE_CLASS_TAGS:
            entry['class'] = str(tag)
            break
    if 'class' not in entry:
        return None
    for tag in tags:
        if tag in labels:
            entry['role'] = str(tag)
            break
    entry['premium'] = VEHICLE_TAG_PREMIUM in tags or VEHICLE_TAG_PREMIUM_IGR in tags
    entry['collector'] = VEHICLE_TAG_COLLECTOR in tags
    entry['special'] = VEHICLE_TAG_SPECIAL in tags
    return entry


def best_component(components):
    """The highest-level component of a list; ties are won by the last candidate."""
    best = None
    for component in components or ():
        if best is None or float(getattr(component, 'level', 0)) >= float(getattr(best, 'level', 0)):
            best = component
    return best


def top_descriptor(type_name):
    """The client's stock descriptor of a vehicle type, raised to its top configuration.

    Deliberately a simple heuristic, and only used for the optional bulk export of
    the whole catalogue: the highest-level chassis, then the highest-level turret
    of turret position 0 with that turret's highest-level gun. The hull is not an
    installable component in this client - the hull variant follows from the
    installed components - so the chassis is what a 'top hull' means here. Engine,
    radio and fuel tank stay stock: they change nothing in the collision model.
    """
    from items import vehicles as client_vehicles
    nation_id, innation_id = client_vehicles.g_list.getIDsByName(type_name)
    descr = client_vehicles.VehicleDescr(typeID=(nation_id, innation_id))
    vtype = descr.type
    try:
        chassis = best_component(vtype.chassis)
        if chassis is not None:
            descr.installComponent(chassis.compactDescr)
    except Exception:
        LOG.warning('Top chassis unavailable for %s; the stock one is kept', type_name)
    try:
        turret = best_component(vtype.turrets[0])
        gun = best_component(turret.guns) if turret is not None else None
        if turret is not None and gun is not None:
            descr.installTurret(turret.compactDescr, gun.compactDescr)
    except Exception:
        LOG.warning('Top turret or gun unavailable for %s; the stock one is kept', type_name)
    return descr


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
        self.settings = dict(DEFAULT_SETTINGS)
        self.vehicles = {}
        self.bulk = []
        self.catalogue_dirty = False
        self.catalogue_written = 0

    def setup(self):
        archive = self.archive
        if archive is None:
            candidates = glob.glob(os.path.join(self.game, 'mods', '*', 'local.armor_inspector_'+VERSION+'.wotmod'))
            if len(candidates) != 1: raise ValueError('Cannot locate the installed viewer package')
            archive = candidates[0]
        with zipfile.ZipFile(archive) as z:
            for name in ASSETS:
                atomic_write(os.path.join(self.folder, *name.split('/')), z.read('res/armor_inspector_viewer/'+name))
        self.load_settings()
        self.load_vehicles()
        # Rebuild derived records after an interrupted game. Raw JSONL is untouched.
        # Every battle is republished, so one unreadable file must not stop the rest.
        for path in sorted(glob.glob(os.path.join(self.folder, 'battles', '*.jsonl'))):
            try:
                battle = read_battle(path)
                if not IDENTIFIER.match(battle['id']): continue
                self.publish(battle)
            except Exception: LOG.exception('Could not rebuild saved battle: %s', os.path.basename(path))
        self.replay_vehicle_requests()
        self.write_catalogue(force=True)
        self.write_index()
        if self.settings.get('exportAllVehicles'):
            self.queue_catalogue_exports()

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

    def publish_parts(self, result, hit, side):
        """Collision models and armour tables for one side of a recorded hit."""
        vehicle = hit.get(side) or {}
        self.publish_vehicle_parts(vehicle.get('parts', []), vehicle, result['clientVersion'])

    def publish_vehicle_parts(self, parts, vehicle, client_version):
        """Collision models and armour tables for the parts of one vehicle.

        The same work for a hit's target, for its shooter and for a vehicle record
        of the browser: the model is extracted from the client packages once per
        resource, the armour table is cached per client version, vehicle and
        resource - so the cache identity has to follow the vehicle whose parts
        these are, not always the target.
        """
        for part in parts:
            try:
                key, error = self.model(part['resource'], client_version)
                part['modelKey'] = key
                if error: part['modelError'] = error
            except Exception as exc: part['modelError'] = str(exc)
            if 'armor' not in part:
                try:
                    identity = '\n'.join((canonical(client_version), vehicle['type'],
                        vehicle.get('compactDescriptor', ''), part['resource']))
                    key = hashlib.sha256(identity.encode('utf-8')).hexdigest()
                    cache = os.path.join(self.folder, 'data', 'armor', key+'.json')
                    if os.path.isfile(cache):
                        with open(cache, 'rb') as stream: part['armor'] = json.loads(stream.read(1024*1024).decode('ascii'))
                    else:
                        if canonical(client_version) != self.version:
                            raise ValueError('Armor metadata was not saved for the old client version')
                        part['armor'] = self.armor.materials(vehicle['type'], part['resource'])
                        atomic_write(cache, json.dumps(part['armor'], ensure_ascii=True, allow_nan=False).encode('ascii'))
                    part['armorSource'] = 'version-matched client XML (cached)'
                except Exception as exc:
                    part['armorError'] = str(exc)
                    # A separate, visibly labelled comparison is allowed only
                    # when today's mesh is byte-identical to the saved mesh.
                    if canonical(client_version) != self.version and not part.get('modelError'):
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
                            part['comparisonArmor'] = self.armor.materials(vehicle['type'], part['resource'])
                            match = re.search(r'<version>\s*(.*?)\s*</version>', self.version)
                            part['comparisonVersion'] = match.group(1) if match else 'current client'
                        except Exception as comparison_error: part['comparisonError'] = str(comparison_error)

    def publish(self, battle):
        if not IDENTIFIER.match(battle['id']): raise ValueError('Invalid battle id')
        result = copy.deepcopy(battle)
        for hit in result['hits']:
            for side in ('attacker', 'target'):
                try:
                    enrich_vehicle(hit.get(side))
                except Exception:
                    LOG.exception('Vehicle identity unavailable; the hit is published as recorded')
            # Records written before 0.6.34 carry no parts for the shooter; rebuild them here.
            synthesize_parts(hit.get('attacker'))
            for side in ('target', 'attacker'):
                self.publish_parts(result, hit, side)
        write_data(os.path.join(self.folder, 'data', 'battles', battle['id']+'.js'), 'battle:'+battle['id'], result)
        # The shooter's models count as referenced too, or prune() would delete them as unused.
        self.model_refs[battle['id']] = set(part['modelKey'] for hit in result['hits']
                                            for side in ('target', 'attacker')
                                            for part in (hit.get(side) or {}).get('parts', []) if part.get('modelKey'))
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

    def idle(self):
        """Called when nothing is waiting to be recorded, and only then.

        The deferred catalogue and the optional bulk export live here so that a
        recorded hit is never queued behind a vehicle.
        """
        self.flush()
        if self.catalogue_dirty: self.write_catalogue()
        self.drain_bulk()

    def prune(self):
        # Storage hygiene without a battle cap: every recorded battle is kept, raw JSONL and
        # derived file alike. A collision model is removed only when no battle and no exported
        # vehicle references it any more; vehicle records hold their keys under 'vehicle:<id>',
        # which no battle id can collide with (IDENTIFIER has no colon).
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

    # ------------------------------------------------------------------ vehicles

    def load_settings(self):
        """mods/configs/local.armor_inspector/settings.json, read once at setup.

        Written with the defaults when it is absent; a malformed file leaves the
        defaults in place with a warning rather than stopping the export. There is
        no interface for it yet - that is a later step.
        """
        path = os.path.join(self.folder, 'settings.json')
        self.settings = dict(DEFAULT_SETTINGS)
        try:
            if os.path.isfile(path):
                with open(path, 'rb') as stream:
                    stored = json.loads(stream.read(65537).decode('utf-8'))
                if not isinstance(stored, dict): raise ValueError('Settings must be a JSON object')
                for key in DEFAULT_SETTINGS:
                    if key in stored: self.settings[key] = stored[key]
            else:
                atomic_write(path, json.dumps(DEFAULT_SETTINGS, sort_keys=True, indent=2).encode('ascii'))
        except Exception:
            self.settings = dict(DEFAULT_SETTINGS)
            LOG.warning('Settings unreadable; the defaults are used: %s', path)
        return self.settings

    def load_vehicles(self):
        """Pick up the vehicles exported by earlier runs.

        Two things depend on it: the catalogue's 'exported' flags, and prune() -
        a model referenced only by an exported vehicle would otherwise be deleted
        as unused on the next index write.
        """
        for path in sorted(glob.glob(os.path.join(self.folder, 'data', 'vehicles', '*.js'))):
            try:
                self.remember_vehicle(read_data_file(path))
            except Exception:
                LOG.exception('Could not read an exported vehicle: %s', os.path.basename(path))

    def remember_vehicle(self, record):
        """Keep the catalogue summary and the model references of one vehicle record."""
        identifier = record.get('id')
        if not identifier or not IDENTIFIER.match(identifier): return
        summary = dict((key, record.get(key)) for key in
                       ('id', 'type', 'name', 'level', 'class', 'role', 'nation',
                        'premium', 'collector', 'special', 'source', 'exportedAt', 'clientVersion'))
        summary['descriptorHash'] = descriptor_hash(record.get('clientVersion'), record.get('type'),
                                                    record.get('compactDescriptor'))
        self.vehicles[identifier] = summary
        self.model_refs['vehicle:'+identifier] = set(part['modelKey'] for part in record.get('parts') or []
                                                     if part.get('modelKey'))

    def append_vehicle_request(self, request):
        """The raw request line - the vehicle twin of the battle JSONL, and as authoritative.

        Every derived vehicle file can be rebuilt from it after a client update,
        because the model keys carry the client version and are re-extracted then.
        """
        row = {'schema':1, 'type':'vehicle', 'vehicleType':str(request.get('vehicleType') or ''),
               'compactDescriptor':request.get('compactDescriptor'), 'source':request.get('source'),
               'requestedAt':float(request.get('requestedAt') or time.time())}
        folder = os.path.join(self.folder, 'vehicles')
        if not os.path.isdir(folder): os.makedirs(folder)
        line = (json.dumps(row, ensure_ascii=True, allow_nan=False, separators=(',', ':'))+'\n').encode('utf-8')
        with open(os.path.join(folder, 'exports.jsonl'), 'ab') as stream:
            stream.write(line)

    def replay_vehicle_requests(self):
        """Rebuild the derived vehicle files from the raw log, last request per type.

        Same contract as the battles: the JSONL is what survives, the .js files are
        derived. Deduplication skips the ones that are already current.
        """
        path = os.path.join(self.folder, 'vehicles', 'exports.jsonl')
        if not os.path.isfile(path): return
        requests = {}
        try:
            with open(path, 'rb') as stream:
                for number in range(100001):
                    line = stream.readline(1024*1024+1)
                    if not line: break
                    if number == 100000 or len(line) > 1024*1024:
                        raise ValueError('Vehicle request log exceeds the export limit')
                    if not line.endswith(b'\n'): break
                    try:
                        row = json.loads(line.decode('utf-8'))
                    except ValueError:
                        continue
                    if row.get('schema') == 1 and row.get('type') == 'vehicle' and row.get('vehicleType'):
                        requests[str(row['vehicleType'])] = row
        except Exception:
            LOG.exception('Vehicle request log unreadable; exported vehicles are kept as they are')
            return
        for type_name in sorted(requests):
            try:
                self.export_vehicle(requests[type_name], replay=True)
            except Exception:
                LOG.exception('Could not rebuild an exported vehicle: %s', type_name)

    def export_vehicle(self, request, replay=False):
        """One vehicle of the client, exported from its compact descriptor.

        Export thread only: rebuilding the descriptor, reading collision models out
        of the client packages and collecting armour tables is exactly the work the
        game thread must never do. Returns False when the request was a duplicate.
        """
        type_name = str(request.get('vehicleType') or '')
        compact = request.get('compactDescriptor')
        identifier = vehicle_id(type_name)
        if ':' not in type_name or not IDENTIFIER.match(identifier):
            raise ValueError('Invalid vehicle type')
        digest = descriptor_hash(self.version, type_name, compact)
        path = os.path.join(self.folder, 'data', 'vehicles', identifier+'.js')
        known = self.vehicles.get(identifier)
        if known and known.get('descriptorHash') == digest and os.path.isfile(path):
            return False
        if not replay: self.append_vehicle_request(request)
        descr = vehicle_descr(compact)
        record = {'schema':1, 'warnings':[]}
        record.update(descr_identity(descr))
        for key in ('name', 'level', 'class', 'role', 'nation'):
            if record.get(key) is None and (request.get('identity') or {}).get(key) is not None:
                record[key] = request['identity'][key]
        if record.get('name') is None and request.get('name'): record['name'] = request['name']
        record.update({'id':identifier, 'type':type_name, 'source':request.get('source'),
                       'exportedAt':time.time(), 'clientVersion':self.version, 'compactDescriptor':compact})
        try:
            record['gun'] = getattr(descr.gun, 'shortUserString', descr.gun.name)
            record['gunDispersion'] = float(descr.gun.shotDispersionAngle)
        except Exception:
            record['warnings'].append('Gun parameters unavailable')
        try:
            # The client's own sum (vehicles.py VehicleDescr.__updateAttributes), the same
            # one the recorder writes for a shooter: the gun axis above flat ground.
            record['gunHeight'] = float((descr.chassis.hullPosition + descr.hull.turretPositions[0] +
                                         descr.turret.gunPosition).y)
            record['gunHeightFrom'] = 'ground'
        except Exception:
            record['warnings'].append('Gun height unavailable')
        try:
            limits = getattr(descr.gun, 'turretYawLimits', None)
            if limits is not None: record['turretYawLimits'] = [float(x) for x in limits]
        except Exception:
            record['warnings'].append('Turret yaw limits unavailable')
        try:
            record['gunPitchLimits'] = gun_limits(descr)
        except Exception:
            record['warnings'].append('Gun pitch limits unavailable')
        try:
            record['shells'] = shot_candidates(descr)
        except Exception:
            record['shells'] = []
            record['warnings'].append('Shell parameters unavailable')
        try:
            record['parts'] = parts_from_descr(descr, 'client vehicle descriptor')
            record['partsFrom'] = 'rest pose'
            self.publish_vehicle_parts(record['parts'], record, self.version)
        except Exception:
            record['parts'] = []
            record['warnings'].append('Collision parts unavailable')
            LOG.exception('Collision parts unavailable for %s', type_name)
        write_data(path, 'vehicle:'+identifier, record)
        self.remember_vehicle(record)
        self.write_catalogue()
        return True

    def catalogue_rows(self):
        """Every vehicle of the client, with the exported ones flagged.

        Built from items.vehicles.g_list, which the export thread can import (the
        recorded-hit enrichment already proves it). Outside the game the module is
        missing: the catalogue then holds only the vehicles that were exported.
        """
        rows, seen = [], set()
        try:
            import nations
            from items import vehicles as client_vehicles
            labels = role_labels()
            for nation_id, nation in enumerate(nations.NAMES):
                try:
                    listing = client_vehicles.g_list.getList(nation_id)
                except Exception:
                    listing = None
                if not listing: continue
                for item in listing.values():
                    try:
                        entry = catalogue_entry(str(nation), item, labels)
                    except Exception:
                        entry = None
                    if entry is None or entry['id'] in seen: continue
                    seen.add(entry['id'])
                    rows.append(entry)
        except Exception:
            LOG.warning('Client vehicle list unavailable; the catalogue holds exported vehicles only')
        for identifier in sorted(self.vehicles):
            if identifier in seen: continue
            summary = self.vehicles[identifier]
            rows.append(dict((key, summary.get(key)) for key in
                             ('id', 'type', 'name', 'level', 'class', 'role', 'nation',
                              'premium', 'collector', 'special')))
            seen.add(identifier)
        for entry in rows:
            summary = self.vehicles.get(entry['id'])
            current = bool(summary) and canonical(summary.get('clientVersion') or '') == self.version
            entry['exported'] = current
            entry['exportedAt'] = summary.get('exportedAt') if summary else None
            entry['source'] = summary.get('source') if summary else None
            if entry.get('role') is None: entry.pop('role', None)
        rows.sort(key=lambda e:(e.get('nation') or '', -(e.get('level') or 0), e.get('name') or ''))
        return rows

    def write_catalogue(self, force=False):
        """data/vehicles.js. Rebuilt at setup and after every vehicle export.

        The rebuild walks the whole client list, which is fine once per exported
        vehicle but not a thousand times in a row: while the optional bulk export
        is running it is deferred by at most a second and written by the idle tick,
        well inside the page's 5 s poll. A hangar or battle export writes at once.
        """
        self.catalogue_dirty = True
        if not force and self.bulk and time.time()-self.catalogue_written < 1: return
        write_data(os.path.join(self.folder, 'data', 'vehicles.js'), 'vehicles',
                   {'application':'local.armor_inspector', 'clientVersion':self.version,
                    'updatedAt':time.time(), 'vehicles':self.catalogue_rows()})
        self.catalogue_dirty = False
        self.catalogue_written = time.time()

    def queue_catalogue_exports(self):
        """settings.json exportAllVehicles: every catalogue vehicle in its top configuration.

        A one-time bulk export of hundreds of megabytes, so it is off by default and
        drained one vehicle per idle tick - a recorded hit always goes first.
        """
        try:
            self.bulk = [entry['type'] for entry in self.catalogue_rows() if not entry.get('exported')]
            LOG.info('Bulk vehicle export queued: %s vehicles', len(self.bulk))
        except Exception:
            self.bulk = []
            LOG.exception('Bulk vehicle export could not be queued')

    def drain_bulk(self):
        """One queued catalogue vehicle per call; failures drop that vehicle only."""
        if not self.bulk: return
        type_name = self.bulk.pop(0)
        try:
            import base64
            descr = top_descriptor(type_name)
            self.export_vehicle({'schema':1, 'type':'vehicle', 'vehicleType':type_name,
                                 'compactDescriptor':base64.b64encode(descr.makeCompactDescr()).decode('ascii'),
                                 'source':'catalogue', 'requestedAt':time.time()})
        except Exception:
            LOG.exception('Bulk vehicle export failed: %s', type_name)
