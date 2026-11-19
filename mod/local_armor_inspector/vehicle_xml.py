# -*- coding: utf-8 -*-
"""The collision parts of a battle's vehicles from the client's own vehicle XML, for the replay viewer: without the player's
recorder the mod knows a vehicle only by its type and compact descriptor. Nothing is decoded but the XML: the page decodes
the .havok bytes itself (copy_havok hands them over as the packages store them).

    vehicle_doc(pk, 'usa:A83_T110E4', client)   every variant of a type (FORMAT below), from
                                                 scripts/item_defs/vehicles/<nation>/<name>.xml, <nation>/list.xml and
                                                 <nation>/components/{chassis,turrets,guns}.xml
    parts(doc, compactDescr)                     the parts of one built vehicle, shaped as Bullba Hits' vehicle file
    copy_havok(pk, doc, resources)               {key: (bytes, path, crc, size)} of the .havok files of those parts

The client's rules followed (items/vehicles.pyc of scripts.pkg, NA 2.4.1.1, read as bytecode):
  - the compact descriptor (_splitVehicleCompactDescr, VehicleDescriptor.__initFromCompactDescr): byte 0 the header
    (nation = header >> 4 & 15), byte 1 the type id, a second type byte when header & 2 (EXTENDED_VEHICLE_TYPE_ID_FLAG);
    the components start right after: chassis, engine, fuel tank, radio as u16 LE, then per turret slot turret and gun as
    u16 LE. So with p = 3 if bytes[0] & 2 else 2: chassis u16 LE at p, turret at p + 8, gun at p + 10.
  - a component in the vehicle XML whose text is 'shared' is the component of <nation>/components/<kind>.xml (its section
    'shared/<name>', its id 'ids/<name>') with a few locals over it (_readInstallableComponents): a turret's local
    'guns' (_readTurretLocals: its gunPosition and hitTester stay the shared ones), a gun's local pitchLimits (merged per
    key: minPitch, maxPitch), staticPitch and hitTester (_readGunLocals). Any other component is read whole where it stands.
  - a gun's absolute pitch is (min of minPitch, max of maxPitch) (_validatePitchLimits 'absolute'); a limit is pairs
    'yaw fraction, degrees' (_readGunPitchConstraints); staticPitch is in degrees in the XML, radians in the client.
  - the chassis' collision is its (first) hitTester; a tracked chassis with trackPairParams has one hitTester per pair,
    each with its trackPairIdx: pair 0 is the chassis, the rest are the extra track pairs in index order (_readChassis,
    _readTrackPairs; a wheeled vehicle - list.xml tag wheeledVehicle - has no track pairs).
  - the hull: 'hull' plus the variants of 'hull/variants' (_readHullVariants: a copy of the default hull, or of its 'base'
    variant, with its own hitTester / turretPositions, matched to a chassis and turrets); the descriptor takes the best
    match (selectBestHull: a variant naming another chassis is skipped, a named chassis weighs 100, each matching turret 1,
    a turret that differs makes the variant -1; the first of the highest weight above 0 wins, else the default hull).
Positions are rounded to float32, as the client's Vector3 holds them.

Carried over 19.11.2026 from the stopped side project C:/Projects/Bullba-Replays (src/bullba_replays/vehicles.py, commit
fa382c3). In Bullba Hits it is the replay viewer's second route for a vehicle (Exporter.playback_vehicle_xml): only a type
whose descriptor the running client cannot build from the replay's compact descriptor (the exporter's own route,
export_vehicle) gets its parts from here; the models are Hits' own (model_extract), copy_havok is not used.
"""
from __future__ import absolute_import
import base64
import math
import struct
import sys

from . import packed_xml
from .map_raw import fnv

FORMAT = 1
WHEEL_SIDES = 16
CLASS_TAGS = ('lightTank', 'mediumTank', 'heavyTank', 'SPG', 'AT-SPG')
BASE = 'scripts/item_defs/vehicles/'
if sys.version_info[0] >= 3:
    text_type = str
else:
    text_type = unicode  # noqa: F821  (Python 2)

_xml_cache = {}   # (package, entry) -> decoded tree: a client update changes the entry, so a stale tree is never used


def f32(x):
    return struct.unpack('<f', struct.pack('<f', float(x)))[0]


def vec3(text):
    v = [f32(x) for x in (text or '').split()]
    if len(v) != 3:
        raise ValueError('not a vector of 3: %r' % (text,))
    return v


def child(node, tag):
    """The first child of that tag (a loop, not ElementTree's path syntax: vehicle names hold '-' and '.')."""
    if node is None:
        return None
    for c in node:
        if c.tag == tag:
            return c
    return None


def kids(node):
    return list(node) if node is not None else []


def text(node, path):
    for tag in path.split('/'):
        node = child(node, tag)
        if node is None:
            return None
    return (node.text or '').strip()


def read_xml(pk, path):
    pkg, entry = pk.find(path)
    if pkg is None:
        raise KeyError('not in the client packages: %s' % path)
    key = (pkg, entry)
    tree = _xml_cache.get(key)
    if tree is None:
        if len(_xml_cache) > 64:
            _xml_cache.clear()
        tree = _xml_cache[key] = packed_xml.decode(pk.read(pkg, entry))
    return tree


class Components(object):
    """One nation's components/<kind>.xml: ids and shared sections."""

    def __init__(self, pk, nation, kind):
        tree = read_xml(pk, '%s%s/components/%s.xml' % (BASE, nation, kind))
        self.ids = dict((c.tag, int((c.text or '').strip())) for c in kids(child(tree, 'ids')))
        self.shared = child(tree, 'shared')

    def resolve(self, node):
        """(id, own node, shared node or None) of a component node of the vehicle XML."""
        cid = self.ids.get(node.tag)
        shared = child(self.shared, node.tag) if (node.text or '').strip() == 'shared' else None
        return cid, node, shared


def pick(local, shared, tag):
    """A field of a component that its locals may set (a gun's hitTester, staticPitch): its own node's, else the shared one's."""
    n = child(local, tag)
    if n is None and shared is not None:
        n = child(shared, tag)
    return n


def collision_model(hit_tester):
    model = text(hit_tester, 'collisionModelClient') if hit_tester is not None else None
    if not model:
        raise ValueError('no hitTester/collisionModelClient')
    return model


def pitch_curve(node):
    """[(yaw fraction, degrees)] of a minPitch / maxPitch (_readGunPitchConstraints: pairs); one bare value holds at any yaw."""
    v = [float(x) for x in (node.text or '').split()] if node is not None else []
    if len(v) == 1:
        return [(0.0, v[0]), (1.0, v[0])]
    return [(v[i], v[i + 1]) for i in range(0, len(v) - 1, 2)]


def curve_at(points, f):
    for (f0, a), (f1, b) in zip(points, points[1:]):
        if f0 <= f <= f1:
            return a if f1 == f0 else a + (b - a) * (f - f0) / (f1 - f0)
    return points[-1][1] if f > points[-1][0] else points[0][1]


def effective_pitch(curves, turret_pitch, joint_pitch):
    """[min, max] radians over every turret yaw of the client's calcPitchLimitsFromDesc (the native
    BigWorld.wg_calcGunPitchLimits(yaw, minPitch, maxPitch, turretPitch, gunJointPitch)): the gun's limit at that yaw plus
    gunJointPitch + turretPitch * (1 - 2 |yaw| / pi) - fitted to the 361 one-degree samples Bullba Hits took of the
    Kunze Panzer (turretPitch 5.2, gunJointPitch -5.26 degrees) within 4e-8 rad; without a tilt it is the gun's own
    absolute (min of minPitch, max of maxPitch: _validatePitchLimits). The sum is piecewise linear in yaw: its extremes
    lie on the curves' knots or at yaw 0 and pi."""
    lo, hi = curves
    knots = sorted(set([0.0, 0.5, 1.0] + [f for f, _ in lo] + [f for f, _ in hi]))

    def offset(f):
        yaw = 2 * math.pi * f
        yaw = 2 * math.pi - yaw if yaw > math.pi else yaw
        return joint_pitch + turret_pitch * (1 - 2 * yaw / math.pi)
    if not turret_pitch and not joint_pitch:
        return [math.radians(min(a for _, a in lo)), math.radians(max(b for _, b in hi))]
    return [min(math.radians(curve_at(lo, f)) + offset(f) for f in knots),
            max(math.radians(curve_at(hi, f)) + offset(f) for f in knots)]


def wheels_of(chassis):
    """The collision wheels of a chassis (Bullba Hits' exporter.wheel_shapes): nonTrack wheels with a procedural body."""
    out = []
    flag = lambda n, key: (text(n, key) or '').lower() == 'true'
    for node in kids(child(chassis, 'wheels')):
        if node.tag != 'wheel':
            continue
        try:
            if not flag(node, 'nonTrack') or not flag(node, 'proceduralCollisionBody'):
                continue
            name = text(node, 'name')
            index = int(text(node, 'index'))
            radius = float(text(node, 'radius') if child(node, 'radius') is not None else text(node, 'geometry/radius'))
            width = float(text(node, 'geometry/width'))
            position = vec3(text(node, 'wheelPos'))
            if not name or not (radius > 0 and width > 0):
                continue
        except (TypeError, ValueError, AttributeError):
            continue
        out.append({'index': index, 'name': name, 'radius': radius, 'width': width, 'position': position})
    out.sort(key=lambda w: w['index'])
    return out


def read_chassis(comp, node, wheeled):
    cid, own, shared = comp.resolve(node)
    body = shared if shared is not None else own      # chassis locals are camouflage and unlocks only
    out = {'name': node.tag}
    try:
        out['hullPosition'] = vec3(text(body, 'hullPosition'))
        if not wheeled and child(body, 'trackPairParams') is not None:
            pairs = dict((int(text(t, 'trackPairIdx')), collision_model(t))
                         for t in body if t.tag == 'hitTester' and child(t, 'trackPairIdx') is not None)
            count = len([c for c in body if c.tag == 'trackPairParams'])
            if sorted(pairs) != list(range(count)):
                raise ValueError('hit testers %s for %d track pairs' % (sorted(pairs), count))
            out['resource'] = pairs[0]
            out['trackPairs'] = [pairs[i] for i in range(1, count)]
        else:
            out['resource'] = collision_model(child(body, 'hitTester'))
            out['trackPairs'] = []
        out['wheels'] = wheels_of(body)
    except (ValueError, KeyError, IndexError, TypeError) as e:
        out['error'] = 'chassis %s: %s' % (node.tag, e)
    return cid, out


def read_gun(comp, node):
    cid, own, shared = comp.resolve(node)
    out = {'name': node.tag}
    try:
        out['resource'] = collision_model(pick(own, shared, 'hitTester'))
        limits = {}
        for key in ('minPitch', 'maxPitch'):
            n = child(child(own, 'pitchLimits'), key)
            if n is None and shared is not None:
                n = child(child(shared, 'pitchLimits'), key)
            limits[key] = pitch_curve(n)
        if not limits['minPitch'] or not limits['maxPitch']:
            raise ValueError('no pitchLimits')
        out['curves'] = (limits['minPitch'], limits['maxPitch'])   # taken out by read_turret
        static = pick(own, shared, 'staticPitch')
        out['staticPitch'] = math.radians(float(static.text)) if static is not None and (static.text or '').strip() else 0
    except (ValueError, TypeError) as e:
        out['error'] = 'gun %s: %s' % (node.tag, e)
    return cid, out


def read_turret(turrets, guns, node, turret_pitch):
    """A turret of slot 0 and its guns; turret_pitch (radians) is the hull's turretPitches[0], what the gun's pitch range
    is taken with (effective_pitch)."""
    cid, own, shared = turrets.resolve(node)
    body = shared if shared is not None else own      # gunPosition and hitTester: never a local of a shared turret
    out = {'name': node.tag, 'guns': {}}
    try:
        out['gunPosition'] = vec3(text(body, 'gunPosition'))
        joint = text(body, 'gunJointPitch')
        out['gunJointPitch'] = math.radians(float(joint)) if joint else 0
        out['resource'] = collision_model(child(body, 'hitTester'))
    except (ValueError, TypeError) as e:
        out['error'] = 'turret %s: %s' % (node.tag, e)
    gun_list = child(own, 'guns')
    if gun_list is None and shared is not None:
        gun_list = child(shared, 'guns')
    for g in kids(gun_list):
        gid, gun = read_gun(guns, g)
        curves = gun.pop('curves', None)
        if curves:
            gun['pitch'] = effective_pitch(curves, turret_pitch, out.get('gunJointPitch', 0))
        if gid is None:
            gun['error'] = 'gun %s: no id in components/guns.xml' % g.tag
            gid = g.tag
        out['guns'][str(gid)] = gun
    return cid, out


def read_hull(node):
    out = {}
    try:
        out['resource'] = collision_model(child(node, 'hitTester'))
        out['turretPositions'] = [vec3(t.text) for t in kids(child(node, 'turretPositions'))]
        out['turretPitches'] = [math.radians(float(t.text)) for t in kids(child(node, 'turretPitches'))]
    except (ValueError, TypeError) as e:
        out['error'] = 'hull: %s' % e
    return out


def read_variants(section, hull, chassis_ids, turret_ids):
    """The hull variants (_readHullVariants): each a copy of the default hull or of its base variant with its own
    hitTester / turretPositions, and its match: a chassis id or None, a turret id or None per turret slot."""
    variants = []
    for v in section:
        base = hull
        name_of_base = text(v, 'base')
        if name_of_base:
            base = next((p for p in variants if p['name'] == name_of_base), hull)
        out = {'name': v.tag, 'chassis': None, 'turrets': [None] * len(hull.get('turretPositions') or [1])}
        for key in ('resource', 'turretPositions', 'error'):
            if key in base:
                out[key] = base[key]
        try:
            if child(v, 'hitTester') is not None:
                out['resource'] = collision_model(child(v, 'hitTester'))
            if child(v, 'turretPositions') is not None:
                out['turretPositions'] = [vec3(t.text) for t in child(v, 'turretPositions')]
            for c in v:
                if c.tag == 'chassis':
                    out['chassis'] = chassis_ids.get((c.text or '').strip())
                elif c.tag.startswith('turret') and c.tag[6:].isdigit():
                    i = int(c.tag[6:])
                    if i < len(out['turrets']):
                        out['turrets'][i] = turret_ids[i].get((c.text or '').strip()) if i < len(turret_ids) else None
        except (ValueError, TypeError) as e:
            out['error'] = 'hull variant %s: %s' % (v.tag, e)
        variants.append(out)
    return variants


def vehicle_doc(pk, type_name, client=''):
    """Every variant's collision parts of one vehicle type ('nation:name'), FORMAT 1:
    {format, type, nation, typeId, class, client,
     chassis: {'<id>': {name, resource, hullPosition, trackPairs [resource...], wheels [{index, name, radius, width,
               position}]}},
     hull: {resource, turretPositions [[3]...], turretPitches [radians...], variants [{name, chassis id|None, turrets [id|None...], resource,
            turretPositions}] (only when the XML has hull/variants)},
     turrets: {'<id>': {name, resource, gunPosition, gunJointPitch, guns: {'<id>': {name, resource, pitch [min, max],
               staticPitch}}}},
     havok: {resource: '%08x-%08x-%d' % (fnv1a32 of the lower-case .havok path, CRC-32, size)}}
    The turrets are those of the first turret slot (turrets0). A gun's pitch is its range over every turret yaw with the
    turret's tilt on the hull (effective_pitch); the player's post-progression modifications of it (modifications.xml
    descrAttrs/gunPitchLimits) are not in the XML of the type, nor in the compact descriptor. A part not found carries 'error' instead of its fields; a
    resource without a .havok in the packages has no havok key."""
    nation, name = type_name.split(':', 1)
    doc = {'format': FORMAT, 'type': type_name, 'nation': nation, 'client': client, 'chassis': {}, 'turrets': {},
           'hull': {}, 'havok': {}}
    listing = child(read_xml(pk, '%s%s/list.xml' % (BASE, nation)), name)
    if listing is not None:
        try:
            doc['typeId'] = int(text(listing, 'id'))
        except (TypeError, ValueError):
            doc['typeId'] = None
        tags = (text(listing, 'tags') or '').split()
        doc['class'] = next((t for t in tags if t in CLASS_TAGS), None)
        wheeled = 'wheeledVehicle' in tags
    else:
        wheeled = False
        doc['typeId'] = doc['class'] = None
        doc['error'] = 'not in %s/list.xml' % nation
    tree = read_xml(pk, '%s%s/%s.xml' % (BASE, nation, name))
    chassis_c = Components(pk, nation, 'chassis')
    turrets_c = Components(pk, nation, 'turrets')
    guns_c = Components(pk, nation, 'guns')
    for node in kids(child(tree, 'chassis')):
        cid, ch = read_chassis(chassis_c, node, wheeled)
        doc['chassis'][str(cid if cid is not None else node.tag)] = ch
        if cid is None:
            ch['error'] = 'chassis %s: no id in components/chassis.xml' % node.tag
    hull_node = child(tree, 'hull')
    doc['hull'] = read_hull(hull_node) if hull_node is not None else {'error': 'no hull'}
    tilt = (doc['hull'].get('turretPitches') or [0])[0]
    for node in kids(child(tree, 'turrets0')):
        tid, tu = read_turret(turrets_c, guns_c, node, tilt)
        doc['turrets'][str(tid if tid is not None else node.tag)] = tu
        if tid is None:
            tu['error'] = 'turret %s: no id in components/turrets.xml' % node.tag
    variants = child(hull_node, 'variants')
    if variants is not None:
        slots = []
        n = 0
        while child(tree, 'turrets%d' % n) is not None:
            slots.append(dict((c.tag, turrets_c.ids.get(c.tag)) for c in child(tree, 'turrets%d' % n)))
            n += 1
        doc['hull']['variants'] = read_variants(variants, doc['hull'], dict((c.tag, chassis_c.ids.get(c.tag))
                                                                            for c in child(tree, 'chassis')), slots)
    resources = set()
    for ch in doc['chassis'].values():
        resources.update([ch.get('resource')] + ch.get('trackPairs', []))
    resources.add(doc['hull'].get('resource'))
    for v in doc['hull'].get('variants', ()):
        resources.add(v.get('resource'))
    for tu in doc['turrets'].values():
        resources.add(tu.get('resource'))
        resources.update(g.get('resource') for g in tu['guns'].values())
    for res in resources:
        if res:
            entry = havok_entry(pk, res)
            if entry:
                doc['havok'][res] = entry[2]
    return doc


def havok_path(resource):
    return (resource[:-6] if resource.lower().endswith('.model') else resource) + '.havok'


def havok_entry(pk, resource):
    """(package, entry, key) of a resource's .havok, None when the packages lack it."""
    path = havok_path(resource)
    pkg, entry = pk.find(path)
    if pkg is None:
        return None
    return pkg, entry, '%08x-%08x-%d' % (fnv(path.lower()), entry[5], entry[4])


def descriptor_ids(compact_b64):
    """(chassis id, turret id, gun id) of a compact descriptor in base64: p = 3 if byte 0 & 2 else 2; chassis u16 LE at
    p, turret at p + 8, gun at p + 10."""
    s = compact_b64.strip()
    if isinstance(s, text_type):
        s = s.encode('ascii')
    b = bytearray(base64.b64decode(s + b'=' * (-len(s) % 4)))
    p = 3 if b[0] & 2 else 2
    u16 = lambda at: b[at] | b[at + 1] << 8
    return u16(p), u16(p + 8), u16(p + 10)


def translation(v):
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, float(v[0]), float(v[1]), float(v[2]), 1.0]


def best_hull(hull, chassis_id, turret_ids):
    """selectBestHull of the client: the default hull unless a variant matches better (weights in the module doc)."""
    best, best_weight = hull, 0
    for v in hull.get('variants', ()):
        weight = 0
        if v['chassis'] is not None:
            if v['chassis'] != chassis_id:
                continue
            weight = 100
        for tid, want in zip(turret_ids, v['turrets']):
            if want is None:
                continue
            if tid == want:
                weight += 1
            else:
                weight = -1
                break
        if best_weight < weight:
            best, best_weight = v, weight
    return best


def parts(doc, compact_b64):
    """{'parts': [...], 'gunPitch': [min, max]} of one built vehicle, shaped as Bullba Hits' vehicle file (its
    exporter.rest_columns and wheel_parts): ids 0-3 chassis, hull, turret, gun, 4.. the extra track pairs
    ('trackPair1'...), then the wheels (-(index+1)); transforms column major in the chassis frame: chassis and track pairs
    at the origin, hull at hullPosition, turret at hull + turretPositions[0], gun at turret + gunPosition, rotated by its
    staticPitch about x (columns 1 and 2 = [0, c, s], [0, -s, c]); a wheel at its wheelPos. modelKey is doc.havok's key."""
    chassis_id, turret_id, gun_id = descriptor_ids(compact_b64)
    ch = doc['chassis'].get(str(chassis_id))
    tu = doc['turrets'].get(str(turret_id))
    gun = tu['guns'].get(str(gun_id)) if tu else None
    hull = best_hull(doc['hull'], chassis_id, [turret_id])
    out = []

    def add(pid, name, comp, transform, what):
        part = {'id': pid, 'name': name}
        if comp is None:
            part['error'] = '%s id %s not in the type %s' % (what, {'chassis': chassis_id, 'turret': turret_id,
                                                                    'gun': gun_id}.get(what, '?'), doc['type'])
        elif 'error' in comp and not comp.get('resource'):
            part['error'] = comp['error']
        elif transform is None:
            part['error'] = 'no place: %s' % (comp.get('error') or 'a part below it is missing')
        else:
            part['resource'] = comp['resource']
            part['transform'] = transform
            key = doc['havok'].get(comp['resource'])
            if key:
                part['modelKey'] = key
            else:
                part['error'] = 'no .havok for %s' % comp['resource']
        out.append(part)

    try:
        h = ch['hullPosition']
    except (TypeError, KeyError):
        h = None
    try:
        t = [h[i] + hull['turretPositions'][0][i] for i in range(3)]
    except (TypeError, KeyError, IndexError):
        t = None
    try:
        g = [t[i] + tu['gunPosition'][i] for i in range(3)]
    except (TypeError, KeyError):
        g = None
    gun_cols = translation(g) if g is not None else None
    if gun_cols is not None and gun and gun.get('staticPitch'):
        c, s = math.cos(gun['staticPitch']), math.sin(gun['staticPitch'])
        gun_cols[4:12] = [0.0, c, s, 0.0, 0.0, -s, c, 0.0]
    add(0, 'chassis', ch, translation((0.0, 0.0, 0.0)), 'chassis')
    add(1, 'hull', hull, translation(h) if h is not None else None, 'hull')
    add(2, 'turret', tu, translation(t) if t is not None else None, 'turret')
    add(3, 'gun', gun, gun_cols, 'gun')
    for n, res in enumerate((ch or {}).get('trackPairs', ())):
        add(4 + n, 'trackPair%d' % (n + 1), {'resource': res}, translation((0.0, 0.0, 0.0)), 'chassis')
    for w in (ch or {}).get('wheels', ()):
        out.append({'id': -(w['index'] + 1), 'name': w['name'],
                    'wheel': {'radius': w['radius'], 'width': w['width'], 'sides': WHEEL_SIDES},
                    'transform': translation(w['position'])})
    return {'parts': out, 'gunPitch': list(gun['pitch']) if gun and 'pitch' in gun else None}


def copy_havok(pk, doc, resources):
    """{key: (bytes, .havok path, crc, size)} of the given resources' collision files, read as the packages store them
    (no decode, no check of the CRC: the key is the index entry's). A resource without a .havok is left out."""
    out = {}
    for res in resources:
        found = havok_entry(pk, res)
        if not found:
            continue
        pkg, entry, key = found
        if key not in out:
            out[key] = (pk.read(pkg, entry), havok_path(res), entry[5], entry[4])
    return out
