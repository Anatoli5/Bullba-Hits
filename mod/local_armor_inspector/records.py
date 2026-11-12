"""Lossless references to the static data of a record, for JSONL and battle snapshots.

Three kinds of shared block, each with its own key space and its own format marker, so a
reader that understands one of them is never confused by the others:

  * armour materials - `armorTables` / `armorRef` in a part (raw and snapshot, 0.7.17);
  * gun pitch tables - `pitchTables` / `gunPitchRef` (raw and snapshot, build after 0.7.25);
  * the vehicle's own static blocks - `staticTables` with `vehicleRef`, `partsRef`, `posesRef`,
    `availableShellsRef` and `shellCandidatesRef` (published snapshot, build after 0.7.25; the raw
    record too since the build after 1.06, BACKLOG 27: there the definitions travel in a record of
    their own kind, `{'type': 'static'}`, written once per file right before the first hit that
    needs them, and a hit keeps only the references and what happened at that shot).

Each marker is a key of its own and `armorTableFormat` is never raised: a reader that knows
only the armour format keeps reading every record of a file instead of dropping lines.

The raw record's half (12.11.2026): the recorder hands the writer a vehicle block split in two -
its live fields, and under STATIC_FIELD one VehicleStatic object it builds once per vehicle,
configuration and mode in a battle and shares between that vehicle's hits (shell lists likewise as
SharedList). The writer's RecordEncoder takes each such object's references once (they are cached on
the object) and writes its definitions once per file; RecordDecoder.decode puts them back, through
the very expansion the published snapshot uses, so every reader sees the hit in its old shape.

What actually happened in the battle stays on its own record: points, the target's pose, the
verdict, tracers, crits, the gun's state, the siege state, the shot's aim. Readers expand every
reference back into the old in-memory shape, so consumers see the hit exactly as before. A
reference with no definition leaves the field unfilled and adds a warning - never a made-up value.
"""
from __future__ import absolute_import
import hashlib
import json


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False,
                      separators=(',', ':'))


class _SharedTable(dict):
    """An owned, read-only snapshot. Consumers must replace, never mutate it.

    The fingerprint is computed once per distinct table and kept on the object: `_json` sorts
    keys, which in Python 2.7 turns the C encoder off, so hashing the same table again for every
    hit or every publish would cost more than the duplication it removes (plan B1, its cost trap: 2.35-2.76 ms for one pitch table in the game's own 2.7).
    """
    def __deepcopy__(self, memo):
        return self

    def fingerprint(self):
        key = getattr(self, '_fingerprint', None)
        if key is None:
            key = hashlib.sha256(_json(self).encode('ascii')).hexdigest()
            self._fingerprint = key
        return key


class ArmorTable(_SharedTable):
    """Material scalars of one collision part."""


class PitchTable(_SharedTable):
    """Gun pitch limits of one gun configuration: 365 samples, ~22 KB, one per configuration."""


class VehicleStatic(_SharedTable):
    """The static half of one recorded vehicle block (split_vehicle): every field but the live ones,
    and its collision parts without their pose at the shot. One object per vehicle, configuration and
    mode in a battle, shared by all its hits; its references are taken once and kept on it (refs)."""

    def refs(self, config):
        cached = getattr(self, '_refs', None)
        if cached is None:
            refs = {'armor': {}, 'pitch': {}, 'static': {}}
            cached = self._refs = (refs, _side_refs(self, config, refs)['vehicleRef'])
        return cached


class SharedList(list):
    """A shell list of one shooter configuration shared by its hits; its fingerprint is taken once."""
    def __deepcopy__(self, memo):
        return self

    def fingerprint(self):
        key = getattr(self, '_fingerprint', None)
        if key is None:
            key = hashlib.sha256(_json(self).encode('ascii')).hexdigest()
            self._fingerprint = key
        return key


# Everything else of a vehicle block belongs to its configuration and is shared by reference.
# These are the battle's own: the pose, the parts that carry it, the state of the vehicle at this
# very shot, its motion and the Borkenkafer's mark on it (designatorMark, BACKLOG 38). A field
# wrongly left out of this list only costs table entries -
# the tables are content-addressed, so a value that does change still produces its own entry.
LIVE_VEHICLE_KEYS = ('parts', 'worldTransform', 'siegeStateAtImpact', 'vehicleMode',
                     'gunStateAtImpact', 'motion', 'designatorMark')
# Hit-level lists that belong to the gun configuration, not to the shot.
SHELL_LIST_FIELDS = ('availableShells', 'shellCandidates')
# Where the fingerprints of one hit are kept between prepare and publish.
SNAPSHOT_KEY = '_snapshotRefs'
# The raw record's own kind for definitions, and the key under which the recorder hands the writer a
# vehicle's static half (in memory only: the encoder replaces it with `vehicleRef`).
STATIC_RECORD = 'static'
STATIC_FIELD = '_static'


def _sides(record):
    """Copy containers on the edited path; preserve all unrelated fields."""
    result = dict(record)
    for side in ('attacker', 'target'):
        vehicle = record.get(side)
        if not isinstance(vehicle, dict):
            continue
        vehicle = dict(vehicle)
        result[side] = vehicle
        if isinstance(vehicle.get('parts'), list):
            vehicle['parts'] = [dict(p) if isinstance(p, dict) else p
                                for p in vehicle['parts']]
    return result


def _parts(record):
    for side in ('attacker', 'target'):
        vehicle = record.get(side)
        if isinstance(vehicle, dict):
            for part in vehicle.get('parts') or []:
                if isinstance(part, dict):
                    yield part


def _fingerprint(value):
    if isinstance(value, (_SharedTable, SharedList)):
        return value.fingerprint()
    return hashlib.sha256(_json(value).encode('ascii')).hexdigest()


def config_key(vehicle):
    """The configuration a static block belongs to: the compact descriptor plus the mode.

    A vehicle with a siege or wheeled mode has a different gun, hull and shell list per mode, and
    the recorder writes which one the shot was fired in, so the mode is part of the key. An old
    record without a descriptor gets an empty key and is addressed by its contents alone.
    """
    if not isinstance(vehicle, dict):
        return ''
    descriptor = vehicle.get('compactDescriptor')
    if not descriptor or not isinstance(descriptor, (str, type(u''))):
        return ''
    descriptor = str(descriptor).replace(':', '')
    mode = vehicle.get('vehicleMode')
    return descriptor if mode is None else descriptor+'#'+str(mode)


# A battle-level reference is "<configuration>:<half the content hash>". The configuration comes
# first so that a global per-configuration catalogue can later answer the very same references
# without the page changing: it indexes them by what is in front of the colon. The content half
# keeps the reference honest where a configuration does not settle the block - the two recorded
# `aim` exceptions, and the confirmed `gun_limits` defect where one compact descriptor carries two
# different pitch tables. Two contents then simply get two references instead of one wrong answer.
REF_HASH_CHARS = 32


def _reference(config, value):
    return config+':'+_fingerprint(value)[:REF_HASH_CHARS]


def _matches(key, value):
    return isinstance(key, (str, type(u''))) and str(key).endswith(':'+_fingerprint(value)[:REF_HASH_CHARS])


def _define(definitions, config, value):
    key = _reference(config, value)
    if key not in definitions:
        definitions[key] = value
    return key


def _armor_ref(definitions, table):
    key = _fingerprint(table)
    if key not in definitions:
        definitions[key] = table
    return key


def _lookup(tables, key):
    """A definition by reference. Under 2.7 the JSON keys come back as unicode and the reference
    may be a str; the two hash alike for ASCII, so one lookup covers both. A corrupted file may
    put something unhashable there, and that is a missing definition, not a crash."""
    try:
        return tables.get(key)
    except TypeError:
        return None


class RecordEncoder(object):
    """One per raw file. Commit only after the complete encoded line is written.

    After encode(), `definitions` is the `static` record that must be written right before the
    encoded hit (the definitions of its shared halves this file does not hold yet), or None."""
    def __init__(self):
        self.known = set()
        self.pending = set()
        self.known_pitch = set()
        self.pending_pitch = set()
        self.known_static = set()
        self.pending_static = set()
        self.definitions = None

    def shared(self, result):
        """The vehicle halves and shell lists the recorder shares (VehicleStatic, SharedList) -> references; the
        definitions this file lacks go to the `static` record. Each object's references are taken once."""
        armor, pitch, static = {}, {}, {}
        configs = {}
        for side in ('attacker', 'target'):
            vehicle = result.get(side)
            if not isinstance(vehicle, dict):
                continue
            half = vehicle.pop(STATIC_FIELD, None)
            if not isinstance(half, VehicleStatic):
                configs[side] = config_key(vehicle)
                continue
            config = config_key({'compactDescriptor': half.get('compactDescriptor'),
                                 'vehicleMode': vehicle.get('vehicleMode')})
            configs[side] = config
            refs, key = half.refs(config)
            vehicle['vehicleRef'] = key
            for kind, known, pending, out in (('armor', self.known, self.pending, armor),
                                              ('pitch', self.known_pitch, self.pending_pitch, pitch),
                                              ('static', self.known_static, self.pending_static, static)):
                for ref, value in refs[kind].items():
                    if ref not in known and ref not in pending:
                        out[ref] = value
                        pending.add(ref)
        used = 'vehicleRef' in (result.get('attacker') or {}) or 'vehicleRef' in (result.get('target') or {})
        for field in SHELL_LIST_FIELDS:
            value = result.get(field)
            if not isinstance(value, SharedList) or not value:
                continue
            key = _reference(configs.get('attacker', ''), value)
            result.pop(field)
            result[field+'Ref'] = key
            used = True
            if key not in self.known_static and key not in self.pending_static:
                static[key] = value
                self.pending_static.add(key)
        if used:
            result['staticTableFormat'] = 1
        if armor or pitch or static:
            record = {'schema': 1, 'type': STATIC_RECORD}
            for definitions, marker, name in ((armor, 'armorTableFormat', 'armorTables'),
                                              (pitch, 'pitchTableFormat', 'pitchTables'),
                                              (static, 'staticTableFormat', 'staticTables')):
                if definitions:
                    record[marker] = 1
                    record[name] = definitions
            self.definitions = record

    def encode(self, record):
        self.pending = set()
        self.pending_pitch = set()
        self.pending_static = set()
        self.definitions = None
        if record.get('type') != 'hit':
            return record
        result = _sides(record)
        self.shared(result)
        tables = {}
        for part in _parts(result):
            table = part.get('armor')
            if not isinstance(table, dict):
                continue
            key = _fingerprint(table)
            part.pop('armor')
            part['armorRef'] = key
            if key not in self.known and key not in self.pending:
                tables[key] = table
                self.pending.add(key)
        if any('armorRef' in part for part in _parts(result)):
            result['armorTableFormat'] = 1
            if tables:
                result['armorTables'] = tables
        # The pitch table of the target: one object per gun configuration, already memoised by
        # presentation.gun_limits, so the fingerprint is taken once per configuration and never
        # per hit. A plain dict (a record from a client that lost the table) stays inline.
        pitch = {}
        target = result.get('target')
        if isinstance(target, dict) and isinstance(target.get('gunPitchLimits'), PitchTable):
            table = target.pop('gunPitchLimits')
            key = _reference(config_key(target), table)
            target['gunPitchRef'] = key
            if key not in self.known_pitch and key not in self.pending_pitch:
                pitch[key] = table
                self.pending_pitch.add(key)
            result['pitchTableFormat'] = 1
            if pitch:
                result['pitchTables'] = pitch
        return result

    def commit(self):
        self.known.update(self.pending)
        self.known_pitch.update(self.pending_pitch)
        self.known_static.update(self.pending_static)
        self.pending = set()
        self.pending_pitch = set()
        self.pending_static = set()
        self.definitions = None

    def rollback(self):
        self.pending = set()
        self.pending_pitch = set()
        self.pending_static = set()
        self.definitions = None


class RecordDecoder(object):
    def __init__(self):
        self.tables = {}
        self.pitch = {}
        # Old records carry the table inline. Interning them by (hull pitch, joint pitch, sample
        # count) plus an exact comparison shares one object between hits without hashing 22 KB per
        # hit; tables of old battles are never recomputed from the client that runs today.
        self.pitch_intern = {}
        # The static blocks by reference: of the raw file read so far (its `static` records), or of the published
        # snapshot being unpacked (unpack_battle). Not re-fingerprinted: written by the same writer as the references.
        self.static = {}

    def define_static(self, definitions):
        if isinstance(definitions, dict):
            self.static.update(definitions)

    def define(self, definitions):
        if not isinstance(definitions, dict):
            return
        for key, value in definitions.items():
            if not isinstance(value, dict):
                continue
            table = ArmorTable(value)
            if table.fingerprint() == key:
                self.tables[key] = table

    def define_pitch(self, definitions):
        if not isinstance(definitions, dict):
            return
        for key, value in definitions.items():
            if not isinstance(value, dict):
                continue
            table = PitchTable(value)
            if _matches(key, table):
                self.pitch[key] = table
                self.pitch_intern.setdefault(_pitch_shape(table), []).append(table)

    def intern_pitch(self, value):
        bucket = self.pitch_intern.setdefault(_pitch_shape(value), [])
        for table in bucket:
            if table == value:
                return table
        table = PitchTable(value)
        bucket.append(table)
        return table

    def decode(self, record):
        if not isinstance(record, dict):
            raise ValueError('Record must be an object')
        if record.get('armorTableFormat') not in (None, 1):
            raise ValueError('Unknown armor table format')
        if record.get('pitchTableFormat') not in (None, 1):
            raise ValueError('Unknown pitch table format')
        if record.get('staticTableFormat') not in (None, 1):
            raise ValueError('Unknown static table format')
        self.define(record.get('armorTables'))
        self.define_pitch(record.get('pitchTables'))
        self.define_static(record.get('staticTables'))
        if record.get('type') != 'hit':
            return record
        if _has_static_refs(record):
            # The one expansion of static references, raw and published alike: in the shape a raw record had.
            record = _expand_static(record, self.static)
        result = _sides(record)
        for name in ('armorTables', 'armorTableFormat', 'pitchTables', 'pitchTableFormat',
                     'staticTables', 'staticTableFormat'):
            result.pop(name, None)
        warnings = list(record.get('warnings') or [])
        for part in _parts(result):
            key = part.pop('armorRef', None)
            if key is not None:
                table = _lookup(self.tables, key)
                if table is None:
                    part['armor'] = ArmorTable()
                    part['armorError'] = 'Recorded armor table unavailable'
                    warnings.append('Recorded armor table unavailable: '+str(part.get('name', '?')))
                else:
                    part['armor'] = table
            elif isinstance(part.get('armor'), dict):
                # Intern old inline data too; originals on disk are never rewritten.
                table = ArmorTable(part['armor'])
                key = table.fingerprint()
                part['armor'] = self.tables.setdefault(key, table)
        for side in ('attacker', 'target'):
            vehicle = result.get(side)
            if not isinstance(vehicle, dict):
                continue
            key = vehicle.pop('gunPitchRef', None)
            if key is not None:
                table = _lookup(self.pitch, key)
                if table is None:
                    # No table means unknown limits, and the viewer says so by itself
                    # (viewer.js: {min:-45, max:45, known:false}). Never a made-up range, and
                    # never a ValueError: read_battle would drop the whole hit as unreadable.
                    warnings.append('Recorded pitch table unavailable: '+side)
                else:
                    vehicle['gunPitchLimits'] = table
            elif isinstance(vehicle.get('gunPitchLimits'), dict):
                vehicle['gunPitchLimits'] = self.intern_pitch(vehicle['gunPitchLimits'])
        if warnings:
            result['warnings'] = warnings
        return result


def _pitch_shape(table):
    samples = table.get('samples')
    return (repr(table.get('hullTurretPitch')), repr(table.get('gunJointPitch')),
            len(samples) if isinstance(samples, list) else -1)


def snapshot_refs(hit):
    """Every content reference of one hit, computed once - where the hit is prepared.

    Returned as definitions by kind plus the references that replace the blocks. Doing this
    once per prepared hit, instead of on every publish, is the whole point: the publish loop
    then only copies strings (plan B1 cost trap, B5 step 3).
    """
    refs = {'armor': {}, 'pitch': {}, 'static': {}, 'shells': {}, 'sides': {}}
    if not isinstance(hit, dict) or hit.get('type') != 'hit':
        return refs
    # The shells of a shot belong to the shooter's configuration, mode included.
    shooter = config_key(hit.get('attacker'))
    for field in SHELL_LIST_FIELDS:
        value = hit.get(field)
        if isinstance(value, list) and value:
            refs['shells'][field] = _define(refs['static'], shooter, value)
    for side in ('attacker', 'target'):
        vehicle = hit.get(side)
        if not isinstance(vehicle, dict) or not vehicle:
            continue
        refs['sides'][side] = _side_refs(vehicle, config_key(vehicle), refs)
    return refs


def _side_refs(vehicle, config, refs):
    """One vehicle block -> {'vehicleRef'[, 'partPoses']}, its definitions added to `refs` by kind. The published
    snapshot's (snapshot_refs) and the raw record's (VehicleStatic.refs, a block without its live fields)."""
    entry = {}
    static = {}
    for key, value in vehicle.items():
        if key not in LIVE_VEHICLE_KEYS:
            static[key] = value
    table = static.get('gunPitchLimits')
    if isinstance(table, dict):
        static.pop('gunPitchLimits')
        static['gunPitchRef'] = _define(refs['pitch'], config, table)
    parts = vehicle.get('parts')
    if isinstance(parts, list):
        plain, poses = [], []
        for part in parts:
            if not isinstance(part, dict):
                plain.append(part)
                poses.append(None)
                continue
            body = dict(part)
            pose = body.pop('transform', None)
            # A wheel (id < 0) sits at its rest place in the chassis frame (exporter.fill_wheels): its pose belongs
            # to the configuration, so it stays in the static part and the hit's own poses get a null for it.
            if pose is not None and isinstance(part.get('id'), int) and part['id'] < 0 and 'wheel' in part:
                body['transform'] = pose
                pose = None
            poses.append(pose)
            armor = body.pop('armor', None)
            if isinstance(armor, dict):
                # Materials keep the 0.7.17 key space: the full content hash, and no
                # configuration - one table is shared by every vehicle built of that armour.
                body['armorRef'] = _armor_ref(refs['armor'], armor)
            elif armor is not None:
                body['armor'] = armor
            plain.append(body)
        static['partsRef'] = _define(refs['static'], config, plain)
        if vehicle.get('partsFrom') == 'rest pose':
            # Proven static: all 151 shooter configurations of the published set have exactly
            # one set of transforms (record-format audit 2026-09-22 section 2).
            static['posesRef'] = _define(refs['static'], config, poses)
        elif [pose for pose in poses if pose is not None]:
            entry['partPoses'] = poses
    entry['vehicleRef'] = _define(refs['static'], config, static)
    return entry


def split_vehicle(vehicle):
    """(live, static) halves of one recorded vehicle block in its old shape, or None when the block cannot come back
    whole from them (decode puts them together again with _expand_static).

      static  a VehicleStatic: every field but LIVE_VEHICLE_KEYS, and `parts` - the static collision parts and wheels
              without their pose at this shot; a shooter's parts at rest (partsFrom 'rest pose') keep their pose
      live    the live fields; `partPoses` - each static part's pose at this shot, positionally (None: none recorded);
              `parts` - the parts that exist at this shot only (an armoured prefab, 'prefab'), which come after the
              static ones in every record (Recorder.capture) and are put after them again

    One rule for the recorder's own split (it builds the halves the same way) and for a record of an older build
    turned into the reference form (the equality check of BACKLOG 27)."""
    if not isinstance(vehicle, dict):
        return None
    live, static = {}, VehicleStatic()
    for key, value in vehicle.items():
        if key == 'parts':
            continue
        if key in ('partPoses', STATIC_FIELD, 'vehicleRef'):
            return None
        (live if key in LIVE_VEHICLE_KEYS else static)[key] = value
    if 'parts' in vehicle:
        parts = vehicle['parts']
        if not isinstance(parts, list):
            return None
        rest = vehicle.get('partsFrom') == 'rest pose'
        bodies, poses, extras = [], [], []
        for part in parts:
            if isinstance(part, dict) and 'prefab' in part:
                extras.append(part)
                continue
            if extras:
                return None
            if rest or not isinstance(part, dict) or part.get('transform') is None:
                bodies.append(part)
                poses.append(None)
            else:
                body = dict(part)
                poses.append(body.pop('transform'))
                bodies.append(body)
        static['parts'] = bodies
        if [pose for pose in poses if pose is not None]:
            live['partPoses'] = poses
        if extras:
            live['parts'] = extras
    return live, static


def split_hit(hit):
    """A hit of the old shape in the form the recorder hands the writer: each vehicle block split (split_vehicle), the
    shell lists shared. What RecordEncoder then writes is what the recorder would have written for the same hit."""
    if not isinstance(hit, dict) or hit.get('type') != 'hit':
        return hit
    result = dict(hit)
    for side in ('attacker', 'target'):
        halves = split_vehicle(hit.get(side)) if isinstance(hit.get(side), dict) and hit.get(side) else None
        if halves is not None:
            live, static = halves
            live[STATIC_FIELD] = static
            result[side] = live
    for field in SHELL_LIST_FIELDS:
        value = hit.get(field)
        if isinstance(value, list) and value:
            result[field] = SharedList(value)
    return result


def _has_static_refs(hit):
    for side in ('attacker', 'target'):
        vehicle = hit.get(side)
        if isinstance(vehicle, dict) and 'vehicleRef' in vehicle:
            return True
    return any(field+'Ref' in hit for field in SHELL_LIST_FIELDS)


def stamp_snapshot(hit):
    """Keep the fingerprints of this hit on it, for the publishes that follow."""
    if isinstance(hit, dict) and hit.get('type') == 'hit':
        hit[SNAPSHOT_KEY] = snapshot_refs(hit)
    return hit


def pack_hit(hit, armor, pitch, static):
    """One hit with its static blocks replaced by references; definitions go to the battle."""
    refs = hit.get(SNAPSHOT_KEY) if isinstance(hit, dict) else None
    if refs is None:
        refs = snapshot_refs(hit)
    armor.update(refs['armor'])
    pitch.update(refs['pitch'])
    static.update(refs['static'])
    result = dict(hit)
    result.pop(SNAPSHOT_KEY, None)
    for field, key in refs['shells'].items():
        result.pop(field, None)
        result[field+'Ref'] = key
    for side, entry in refs['sides'].items():
        source = hit.get(side) or {}
        vehicle = {}
        for key in LIVE_VEHICLE_KEYS:
            if key != 'parts' and key in source:
                vehicle[key] = source[key]
        vehicle['vehicleRef'] = entry['vehicleRef']
        if 'partPoses' in entry:
            vehicle['partPoses'] = entry['partPoses']
        result[side] = vehicle
    return result


def pack_battle(battle):
    """A complete snapshot carries its own dictionaries; never needs an earlier file."""
    result = dict(battle)
    armor, pitch, static = {}, {}, {}
    hits = []
    for hit in battle.get('hits') or []:
        hits.append(pack_hit(hit, armor, pitch, static))
    result['hits'] = hits
    for definitions, marker, name in ((armor, 'armorTableFormat', 'armorTables'),
                                      (pitch, 'pitchTableFormat', 'pitchTables'),
                                      (static, 'staticTableFormat', 'staticTables')):
        if definitions:
            result[marker] = 1
            result[name] = definitions
        else:
            result.pop(marker, None)
            result.pop(name, None)
    return result


def _expand_static(hit, tables):
    """Put the static blocks of a snapshot back on the hit, in the shape a raw record has.

    Armour and pitch references are left on the record for the decoder to resolve, so that
    path exists once. The definitions are not re-fingerprinted here: they were written in the
    same atomic file as the references, and the page's reader does not verify them either.
    """
    if not isinstance(hit, dict):
        return hit
    result = dict(hit)
    warnings = list(hit.get('warnings') or [])
    for field in SHELL_LIST_FIELDS:
        key = result.pop(field+'Ref', None)
        if key is None:
            continue
        rows = _lookup(tables, key)
        if isinstance(rows, list):
            result[field] = list(rows)
        else:
            warnings.append('Recorded shell list unavailable: '+field)
    for side in ('attacker', 'target'):
        vehicle = result.get(side)
        if not isinstance(vehicle, dict):
            continue
        if 'vehicleRef' not in vehicle:
            continue
        vehicle = dict(vehicle)
        result[side] = vehicle
        poses = vehicle.pop('partPoses', None)
        key = vehicle.pop('vehicleRef')
        # The parts that exist at this shot only (an armoured prefab, split_vehicle): after the static ones.
        extras = vehicle.pop('parts', None)
        extras = extras if isinstance(extras, list) else []
        block = _lookup(tables, key)
        if not isinstance(block, dict):
            warnings.append('Recorded vehicle data unavailable: '+side)
            if extras:
                vehicle['parts'] = extras
            continue
        for name, value in block.items():
            if name not in ('partsRef', 'posesRef'):
                vehicle[name] = value
        parts_ref = block.get('partsRef')
        if parts_ref is None:
            if extras:
                vehicle['parts'] = extras
            continue
        rows = _lookup(tables, parts_ref)
        if not isinstance(rows, list):
            warnings.append('Recorded vehicle parts unavailable: '+side)
            vehicle['parts'] = extras
            continue
        if poses is None and block.get('posesRef') is not None:
            poses = _lookup(tables, block['posesRef'])
            if not isinstance(poses, list):
                warnings.append('Recorded rest pose unavailable: '+side)
                poses = None
        parts = []
        for index, part in enumerate(rows):
            if not isinstance(part, dict):
                parts.append(part)
                continue
            part = dict(part)
            pose = poses[index] if poses is not None and index < len(poses) else None
            if pose is not None:
                part['transform'] = pose
            parts.append(part)
        vehicle['parts'] = parts + extras
    if warnings:
        result['warnings'] = warnings
    return result


def unpack_battle(battle):
    if not isinstance(battle, dict):
        return battle
    if battle.get('armorTableFormat') not in (None, 1):
        raise ValueError('Unknown armor table format')
    if battle.get('pitchTableFormat') not in (None, 1):
        raise ValueError('Unknown pitch table format')
    if battle.get('staticTableFormat') not in (None, 1):
        raise ValueError('Unknown static table format')
    decoder = RecordDecoder()
    decoder.define(battle.get('armorTables'))
    decoder.define_pitch(battle.get('pitchTables'))
    decoder.define_static(battle.get('staticTables'))
    result = dict(battle)
    for name in ('armorTables', 'armorTableFormat', 'pitchTables', 'pitchTableFormat',
                 'staticTables', 'staticTableFormat'):
        result.pop(name, None)
    result['hits'] = [decoder.decode(hit) for hit in battle.get('hits') or []]
    return result
