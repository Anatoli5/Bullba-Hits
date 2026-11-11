"""Decoder of World of Tanks .wotreplay streams (BACKLOG No. 29); runs under the client's Python 2.7 and CPython 3.

Reads a replay without the game: header JSON blocks -> Blowfish (open-source parsers' public key,
decrypted block XOR previous plain block) -> zlib -> BigWorld packet stream. Method and property ids
are derived from THIS client's entity_defs (scripts.pkg and the extension packages), never from a
table of another version. No game module is imported or executed.

Two readers: read_replay (a final .wotreplay: header blocks, encrypted, compressed) and read_temp_replay (the raw
in-battle replays/temp.wotreplay: the packet stream as it is, no header, no encryption, may end inside a packet);
read_any picks one by the file's first word. The stream is held as a bytearray (indexes as int under both Pythons).
iter_packets drops a partial last packet; Decoder.partial_bytes says how many bytes it dropped.

Components (2.4): packets 0x32/0x37/0x24 and the small client packets are decoded by replay_objects.py
(outputs/replay-components-2026-11-02.md). The command-line tool is tools/replay_decode.py (--summary, --events,
--header); not wired into the recorder yet.

Privacy: the replay carries nicknames and account ids. See outputs/replay-decoder-2026-09-24.md.
"""
from __future__ import absolute_import, division
import binascii
import collections
import io
import json
import math
import os
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

from . import packed_xml  # BigWorld packed XML reader of the project, pure Python

PY3 = sys.version_info[0] >= 3
try:
    BadZip = zipfile.BadZipFile
except AttributeError:   # Python 2.7
    BadZip = zipfile.BadZipfile


def hexs(raw):
    """Hex text of a byte string (bytes.hex() is Python 3 only)."""
    return binascii.hexlify(bytes(raw)).decode('ascii') if PY3 else binascii.hexlify(str(raw))


DEFAULT_CLIENT = 'C:/Games/World_of_Tanks_NA'
REPLAY_MAGIC = 0x11343212
# Public key of the .wotreplay stream (evido/wotreplay-parser src/parser.cpp; kosh04/wotreplay parse.go).
REPLAY_KEY = bytearray(binascii.unhexlify('DE72BEA0DE04BEB1DEFEBEEFDEADBEEF'))


# --------------------------------------------------------------------------------------------
# Blowfish (pure Python; the P-array and S-boxes are the hexadecimal digits of pi, computed here)
# --------------------------------------------------------------------------------------------

def _pi_words(count):
    def arctan_inv(x, one):
        total = term = one // x
        x2, n, sign = x * x, 1, -1
        while term:
            term //= x2
            n += 2
            total += sign * (term // n)
            sign = -sign
        return total
    bits = count * 32 + 64
    one = 1 << (bits + 32)
    pi = 4 * (4 * arctan_inv(5, one) - arctan_inv(239, one))
    frac = (pi >> 32) - (3 << bits)
    return [(frac >> (bits - 32 * (i + 1))) & 0xffffffff for i in range(count)]


def _blowfish_schedule(key):
    words = _pi_words(18 + 4 * 256)
    P = words[:18]
    S = [words[18 + 256 * i:18 + 256 * (i + 1)] for i in range(4)]
    for i in range(18):
        k = 0
        for j in range(4):
            k = (k << 8) | key[(i * 4 + j) % len(key)]
        P[i] ^= k
    S0, S1, S2, S3 = S

    def encrypt(l, r):
        for i in range(16):
            l ^= P[i]
            r ^= ((((S0[l >> 24] + S1[(l >> 16) & 255]) & 0xffffffff) ^ S2[(l >> 8) & 255]) + S3[l & 255]) & 0xffffffff
            l, r = r, l
        l, r = r, l
        return l ^ P[17], r ^ P[16]
    l = r = 0
    for i in range(0, 18, 2):
        l, r = encrypt(l, r)
        P[i], P[i + 1] = l, r
    for box in S:
        for i in range(0, 256, 2):
            l, r = encrypt(l, r)
            box[i], box[i + 1] = l, r
    return P, S


def decrypt_replay_stream(data, key=REPLAY_KEY):
    """Blowfish-ECB, each decrypted 8-byte block XOR the previous *plain* block (first XOR zero)."""
    P, (S0, S1, S2, S3) = _blowfish_schedule(key)
    rounds = P[17:1:-1]
    p0, p1 = P[0], P[1]
    n = len(data) // 8
    vals = struct.unpack('>%dI' % (2 * n), data[:8 * n])
    out = [0] * (2 * n)
    pl = pr = 0
    for b in range(n):
        l = vals[2 * b]
        r = vals[2 * b + 1]
        for k in rounds:
            l ^= k
            r ^= ((((S0[l >> 24] + S1[(l >> 16) & 255]) & 0xffffffff) ^ S2[(l >> 8) & 255]) + S3[l & 255]) & 0xffffffff
            l, r = r, l
        l, r = r, l
        pl ^= l ^ p0
        pr ^= r ^ p1
        out[2 * b] = pl
        out[2 * b + 1] = pr
    return struct.pack('>%dI' % (2 * n), *out)


def read_replay(path):
    """A final .wotreplay -> (json_blocks list, packet stream bytearray)."""
    with open(path, 'rb') as f:
        data = f.read()
    magic, count = struct.unpack_from('<II', data, 0)
    if magic != REPLAY_MAGIC:
        raise ValueError('not a .wotreplay (magic %08x)' % magic)
    off, blocks = 8, []
    for _ in range(count):
        size, = struct.unpack_from('<I', data, off)
        off += 4
        blocks.append(json.loads(data[off:off + size].decode('utf-8')))
        off += size
    if off >= len(data):
        return blocks, bytearray()
    raw_size, packed_size = struct.unpack_from('<II', data, off)
    off += 8
    plain = decrypt_replay_stream(data[off:])
    stream = bytearray(zlib.decompress(plain[:packed_size]))
    if len(stream) != raw_size:
        raise ValueError('stream size %d != header %d' % (len(stream), raw_size))
    return blocks, stream


def read_temp_replay(path):
    """The raw in-battle replays/temp.wotreplay (or a copy of it) -> ([], packet stream bytearray). The game writes
    the packet stream there as it is: no header blocks, no encryption, no compression; while the battle runs the
    file may end inside a packet, which iter_packets drops."""
    with open(path, 'rb') as f:
        return [], bytearray(f.read())


def read_any(path):
    """read_replay for a final file (it starts with REPLAY_MAGIC), read_temp_replay for anything else."""
    with open(path, 'rb') as f:
        head = f.read(4)
    if len(head) == 4 and struct.unpack('<I', head)[0] == REPLAY_MAGIC:
        return read_replay(path)
    return read_temp_replay(path)


# --------------------------------------------------------------------------------------------
# entity_defs of the client -> typed readers and id tables
# --------------------------------------------------------------------------------------------

class Client(object):
    """Reads scripts/*.xml|.def from the client's .pkg archives (zip) without extracting them."""

    def __init__(self, root=DEFAULT_CLIENT):
        self.root = root
        pk = os.path.join(root, 'res', 'packages')
        self.files = {}
        for name in sorted(os.listdir(pk)):
            if not name.endswith('.pkg'):
                continue
            try:
                z = zipfile.ZipFile(os.path.join(pk, name))
            except BadZip:
                continue
            for item in z.namelist():
                if '/scripts/' in '/' + item and (item.endswith('.def') or item.endswith('.xml')) and \
                        ('entity_defs' in item or 'component_defs' in item or item.endswith('scripts/entities.xml')
                         or ('item_defs/vehicles/' in item and item.endswith('/list.xml'))):
                    self.files.setdefault(item, (z, name))
        version = os.path.join(root, 'version.xml')
        self.version = None
        if os.path.exists(version):
            try:
                self.version = ET.parse(version).getroot().findtext('version').strip()
            except Exception:
                pass

    # nations.NAMES of the 2.4.0.1 bytecode (scripts/common/nations.pyc): the compact descriptor's nation index.
    NATIONS = ('ussr', 'germany', 'usa', 'china', 'france', 'uk', 'japan', 'czech', 'sweden', 'poland', 'italy')

    def vehicle_names(self):
        """(nationID, vehicleTypeID) -> 'nation:Name' from every package's item_defs/vehicles/<nation>/list.xml."""
        out = {}
        for name in sorted(self.files):
            if not name.endswith('/list.xml') or 'item_defs/vehicles/' not in name:
                continue
            nation = name.split('/')[-2]
            if nation not in self.NATIONS:
                continue
            for v in self.xml(name):
                vid = (v.findtext('id') or '').strip()
                if vid.isdigit():
                    out.setdefault((self.NATIONS.index(nation), int(vid)), '%s:%s' % (nation, v.tag))
        return out

    def xml(self, name):
        z, _ = self.files[name]
        return packed_xml.decode(z.read(name))

    def find(self, suffix):
        """The first file whose path ends with suffix (extensions live under '<ext>/scripts/...')."""
        if suffix in self.files:
            return suffix
        for name in self.files:
            if name.endswith('/' + suffix):
                return name
        return None


VAR = None  # variable stream size


class Type(object):
    __slots__ = ('name', 'kind', 'size', 'read', 'children')

    def __init__(self, name, kind, size, read, children=None):
        self.name, self.kind, self.size, self.read, self.children = name, kind, size, read, children


def _packed_len(buf, pos):
    n = buf[pos]
    if n == 0xff:
        return buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16), pos + 4
    return n, pos + 1


def _simple(fmt):
    st = struct.Struct('<' + fmt)
    size = st.size
    unpack_from = st.unpack_from
    if len(fmt) == 1:
        def read(buf, pos):
            return unpack_from(buf, pos)[0], pos + size
    else:
        def read(buf, pos):
            return list(unpack_from(buf, pos)), pos + size
    return size, read


SIMPLE = {'INT8': 'b', 'UINT8': 'B', 'INT16': 'h', 'UINT16': 'H', 'INT32': 'i', 'UINT32': 'I',
          'INT64': 'q', 'UINT64': 'Q', 'FLOAT': 'f', 'FLOAT32': 'f', 'FLOAT64': 'd',
          'VECTOR2': 'ff', 'VECTOR3': 'fff', 'VECTOR4': 'ffff'}


def _read_blob(buf, pos):
    n, pos = _packed_len(buf, pos)
    return bytes(buf[pos:pos + n]), pos + n


def _read_string(buf, pos):
    n, pos = _packed_len(buf, pos)
    return bytes(buf[pos:pos + n]), pos + n  # kept as bytes (compact descriptors are binary); text in tools/replay_decode.py jsonable


class Defs(object):
    """Entity types in entities.xml order (1-based ids in EntityCreate), their client properties and
    client methods with the ids the stream uses. Ordering rule verified per replay (see report)."""

    def __init__(self, client):
        self.client = client
        self.alias_xml = {}
        self.types = {}
        for name in ('scripts/entity_defs/alias.xml',):
            for item in client.xml(name):
                self.alias_xml[item.tag] = item
        for name in sorted(client.files):
            if name.endswith('entity_defs/alias.xml') and name != 'scripts/entity_defs/alias.xml':
                for item in client.xml(name):
                    self.alias_xml.setdefault(item.tag, item)
        self.entities = []  # list of names, index 0 -> id 1
        root = client.xml('scripts/entities.xml')
        cs = root.find('ClientServerEntities')
        for e in (cs if cs is not None else root):
            self.entities.append(e.tag)
        self.extra_entities = []
        for name in sorted(client.files):
            if name.endswith('scripts/entities.xml') and name != 'scripts/entities.xml':
                r = client.xml(name)
                cs = r.find('ClientServerEntities')
                for e in (cs if cs is not None else r):
                    self.extra_entities.append(e.tag)
        self._specs = {}

    # ---- types
    def type_of(self, section):
        text = (section.text or '').strip()
        key = None
        if text in self.alias_xml and not len(section):
            key = text
            if key in self.types:
                return self.types[key]
            t = self.type_of(self.alias_xml[key])
            t = Type(key, t.kind, t.size, t.read, t.children)
            self.types[key] = t
            return t
        if text in SIMPLE:
            size, read = _simple(SIMPLE[text])
            return Type(text, 'num', size, read)
        if text in ('STRING', 'UNICODE_STRING'):
            return Type(text, 'str', VAR, _read_string)
        if text in ('BLOB', 'PYTHON'):
            return Type(text, 'blob', VAR, _read_blob)
        if text == 'MAILBOX':
            def read_mb(buf, pos):
                return hexs(buf[pos:pos + 12]), pos + 12
            return Type(text, 'mailbox', 12, read_mb)
        if text in ('ARRAY', 'TUPLE'):
            of = self.type_of(section.find('of'))
            fixed = section.find('size')
            count = int(fixed.text.strip()) if fixed is not None else None
            sub = of.read
            if count is not None:
                def read_fixed(buf, pos, count=count, sub=sub):
                    out = []
                    for _ in range(count):
                        v, pos = sub(buf, pos)
                        out.append(v)
                    return out, pos
                size = of.size * count if of.size is not None else VAR
                return Type(text, 'array', size, read_fixed, [of])

            def read_var(buf, pos, sub=sub):
                n, pos = _packed_len(buf, pos)
                out = []
                for _ in range(n):
                    v, pos = sub(buf, pos)
                    out.append(v)
                return out, pos
            return Type(text, 'array', VAR, read_var, [of])
        if text == 'FIXED_DICT':
            fields = []
            props = section.find('Properties')
            for p in (props if props is not None else []):
                fields.append((p.tag, self.type_of(p.find('Type'))))
            none = section.find('AllowNone')
            allow_none = none is not None and (none.text or '').strip().lower() == 'true'
            names = [f[0] for f in fields]
            readers = [f[1].read for f in fields]

            def read_dict(buf, pos, names=names, readers=readers, allow_none=allow_none):
                if allow_none:
                    flag = buf[pos]
                    pos += 1
                    if not flag:
                        return None, pos
                out = {}
                for n_, r_ in zip(names, readers):
                    out[n_], pos = r_(buf, pos)
                return out, pos
            if allow_none or any(f[1].size is None for f in fields):
                size = VAR
            else:
                size = sum(f[1].size for f in fields)
            return Type(text, 'dict', size, read_dict, fields)
        if text == 'USER_TYPE':
            inner = section.find('Type')
            return self.type_of(inner) if inner is not None else Type(text, 'blob', VAR, _read_blob)
        raise ValueError('unknown type %r' % text)

    # ---- entity spec
    def spec(self, name):
        if name in self._specs:
            return self._specs[name]
        path = self.client.find('entity_defs/%s.def' % name)
        if path is None:
            self._specs[name] = None
            return None
        props, methods = collections.OrderedDict(), collections.OrderedDict()
        volatile = []
        self._collect(self.client.xml(path), props, methods, volatile, set())
        spec = EntitySpec(name, props, methods, volatile)
        self._specs[name] = spec
        return spec

    def _collect(self, root, props, methods, volatile, seen):
        impl = root.find('Implements')
        if impl is not None:
            for it in impl:
                iname = (it.text or '').strip()
                if iname in seen:
                    continue
                seen.add(iname)
                path = self.client.find('entity_defs/interfaces/%s.def' % iname)
                if path is not None:
                    self._collect(self.client.xml(path), props, methods, volatile, seen)
        pr = root.find('Properties')
        if pr is not None:
            for p in pr:
                flags = (p.findtext('Flags') or '').strip()
                t = self.type_of(p.find('Type'))
                props.pop(p.tag, None)
                props[p.tag] = (t, flags)
        vol = root.find('Volatile')
        if vol is not None:
            for v in vol:
                if v.tag not in volatile:
                    volatile.append(v.tag)
        cm = root.find('ClientMethods')
        if cm is not None:
            for m in cm:
                if m.tag in methods:
                    continue
                args = []
                a = m.find('Args')
                if a is not None:
                    for x in a:
                        args.append((x.tag, self.type_of(x)))
                else:
                    for i, x in enumerate(m.findall('Arg')):
                        args.append(('arg%d' % i, self.type_of(x)))
                header = 1
                h = m.find('VariableLengthHeaderSize')
                if h is not None and (h.text or '').strip().isdigit():
                    header = int(h.text.strip())
                methods[m.tag] = (args, header)


CLIENT_FLAGS = ('ALL_CLIENTS', 'OTHER_CLIENTS', 'OWN_CLIENT', 'BASE_AND_CLIENT', 'CELL_PUBLIC_AND_OWN')


def _size_key(size):
    return 0xffff if size is None else size


class EntitySpec(object):
    def __init__(self, name, props, methods, volatile):
        self.name = name
        self.props = props
        self.volatile = volatile
        # Client-visible properties in declaration order (interfaces first), then stably sorted by
        # stream size, variable-sized last: the id order of property updates. Verified per stream.
        cl = [(n, t) for n, (t, f) in props.items() if f in CLIENT_FLAGS]
        self.client_props = sorted(cl, key=lambda x: _size_key(x[1].size))
        # Client methods: declaration order, stably sorted by stream size; a variable-sized method
        # counts as 0xffff + its VariableLengthHeaderSize (default 1), so the four Avatar methods with
        # a 2-byte header come last. Verified: every call in both replays consumes its payload exactly.
        ms = []
        for n, (args, header) in methods.items():
            if any(a[1].size is None for a in args):
                key = 0xffff + header
            else:
                key = sum(a[1].size for a in args) + header
            ms.append((key, n, args))
        ms.sort(key=lambda x: x[0])
        self.client_methods = [(n, args, None if key >= 0xffff else key) for key, n, args in ms]


# --------------------------------------------------------------------------------------------
# Argument names of the client methods, read from the 2.4.0.1 bytecode (co_varnames of
# Vehicle.* and PlayerAvatar.* in scripts/client/*.pyc through the client's own python27.dll, no
# game module executed; the same method as tools/inspect_aim_contract.py). The .def files carry
# only types. A name list longer than the .def argument list means a default argument the server
# never sends (Vehicle.showShooting isPredictedShot).
# --------------------------------------------------------------------------------------------

ARG_NAMES = {
    'Vehicle.onExtraHitted': ['extraIndex', 'hitPoint'],
    'Vehicle.onHealthChanged': ['newHealth', 'oldHealth', 'attackerID', 'attackReasonID', 'attackReasonExtID'],
    'Vehicle.onPushed': ['x', 'z'],
    'Vehicle.onStaticCollision': ['energy', 'point', 'normal', 'miscFlags', 'damage', 'destrEffectIdx', 'destrMaxHealth'],
    'Vehicle.showAmmoBayEffect': ['mode', 'fireballVolume', 'projectedTurretSpeed'],
    'Vehicle.showDamageFromExplosion': ['attackerID', 'center', 'effectsIndex', 'damage', 'damageFactor',
                                       'gunInstallationIndex'],
    'Vehicle.showDamageFromShot': ['attackerID', 'hitPoints', 'effectsIndex', 'prefabEffIndex', 'damage', 'damageFactor',
                                   'lastMaterialIsShield', 'shellVelocity', 'gunInstallationIndex'],
    'Vehicle.showRammingEffect': ['energy', 'speedDiff', 'point'],
    'Vehicle.showShooting': ['burstCount', 'currentGuns', 'shellType', 'isPredictedShot'],
    'Vehicle.updateLaserSight': ['vehicleID', 'isTakesAim', 'beamMode'],
    'Avatar.battleEventsSummary': ['summary'],
    'Avatar.enemySPGHit': ['hitPoint'],
    'Avatar.enemySPGShotSound': ['shooterPosition', 'targetPosition'],
    'Avatar.explodeProjectile': ['shotID', 'effectsIndex', 'prefabEffIndex', 'effectMaterialIndex', 'shellTypeIdx',
                                 'shellCaliber', 'endPoint', 'velocityDir', 'speed', 'damagedDestructibles'],
    'Avatar.onBattleEvents': ['events'],
    'Avatar.onCollisionWithVehicle': ['point', 'energy'],
    'Avatar.onFrictionWithVehicle': ['otherID', 'frictionPoint', 'state'],
    'Avatar.onKickedFromArena': ['reasonCode'],
    'Avatar.onRoundFinished': ['winnerTeam', 'reason'],
    'Avatar.onSwitchViewpoint': ['vehicleID', 'position'],
    'Avatar.showOtherVehicleDamagedDevices': ['vehicleID', 'damagedExtras', 'destroyedExtras'],
    'Avatar.showOwnVehicleHitDirection': ['hitDirYaw', 'attackerID', 'damage', 'crits', 'isBlocked', 'isShellHE',
                                          'damagedID', 'attackReasonID'],
    'Avatar.showShotResults': ['results'],
    'Avatar.showTracer': ['shooterID', 'shotID', 'isRicochet', 'effectsIndex', 'prefabEffIndex', 'shellTypeIdx',
                          'shellCaliber', 'refStartPoint', 'velocity', 'gravity', 'maxShotDist', 'gunIndex',
                          'gunInstallationIndex'],
    'Avatar.stopTracer': ['shotID', 'endPoint'],
    'Avatar.updateArena': ['updateType', 'argStr'],
    'Avatar.updateAvatarPrivateStats': ['stats'],
    'Avatar.updateTargetVehicleID': ['targetID'],
    'Avatar.updateTargetingInfo': ['entityId', 'turretYaw', 'gunPitch', 'maxTurretRotationSpeed', 'maxGunRotationSpeed',
                                   'shotDispMultiplierFactor', 'gunShotDispersionFactorsTurretRotation',
                                   'chassisShotDispersionFactorsMovement', 'chassisShotDispersionFactorsRotation',
                                   'gunShotDispersionFactorsAfterShot', 'aimingTime'],
    'Avatar.updateVehicleAmmo': ['vehicleID', 'compactDescr', 'quantity', 'quantityInClipOrNextStage', 'previousStage',
                                 'timeRemaining', 'totalTime', 'index'],
    'Avatar.updateVehicleHealth': ['vehicleID', 'health', 'deathReasonID', 'isCrewActive', 'isRespawn'],
    'Avatar.updateVehicleQuickShellChanger': ['vehicleID', 'isActive'],
    'Avatar.updateVehicleSetting': ['vehicleID', 'code', 'value'],
}


# --------------------------------------------------------------------------------------------
# Client formulas (read from 2.4.0.1 bytecode, see the report): gun angles and hit points
# --------------------------------------------------------------------------------------------

def decode_gun_angles(code):
    """gun_rotation_shared.decodeGunAngles without the pitch limits: yaw relative to the hull is exact
    to its 10 bits over the full circle; pitch is returned as the 6-bit fraction t of the gun's
    absolute pitch limits (pitch = min + t * (max - min))."""
    yaw = 2.0 * math.pi * ((code >> 6) & 1023) / 1024.0 - math.pi
    return yaw, (code & 63) / 63.0


def decode_hit_point(hp):
    """VehicleEffects.DamageFromShotDecoder.parseHitPoint + helpers_common.getComponentIndexFromEncodedSegment
    and HitParamsEncoder.decode. Start/end need the part's collision bounding box (decode_segment)."""
    seg, params = hp['segment'], hp['params']
    return {
        'networkID': hp['networkID'],
        'part': (seg >> 8) & 255,
        'effect': seg & 255,
        'hitType': params & 15,
        'shellType': (params >> 4) & 15,
        'caliber': round(((params >> 8) & 0xffff) * 0.1, 1),
        'startQ': [(seg >> 16) & 255, (seg >> 24) & 255, (seg >> 32) & 255],
        'endQ': [(seg >> 40) & 255, (seg >> 48) & 255, (seg >> 56) & 255],
        'segment': str(seg), 'params': params,
    }


def decode_segment(segment, bbox_min, bbox_max):
    """helpers_common.decodeSegment: start/end on a 1/255 grid of the part box, each pushed 1 % outwards."""
    delta = [(bbox_max[i] - bbox_min[i]) / 255.0 for i in range(3)]
    s = [bbox_min[i] + delta[i] * ((segment >> (16 + 8 * i)) & 255) for i in range(3)]
    e = [bbox_min[i] + delta[i] * ((segment >> (40 + 8 * i)) & 255) for i in range(3)]
    off = [(e[i] - s[i]) * 0.01 for i in range(3)]
    return [s[i] - off[i] for i in range(3)], [e[i] + off[i] for i in range(3)]


def parse_vehicle_compact_descr(cd):
    """items.vehicles.parseVehicleCompactDescr: header byte (nation in the high nibble; flag 2 =
    EXTENDED_VEHICLE_TYPE_ID_FLAG, the type id takes a second byte), then the type id.
    -> (nationID, vehicleTypeID, typeCompDescr as getVehicleTypeCompactDescr builds it)."""
    if PY3 and isinstance(cd, str):
        cd = cd.encode('latin-1')
    cd = bytearray(cd)
    header, tid = cd[0], cd[1]
    if header & 2:
        tid += cd[2] << 8
    nation = (header >> 4) & 15
    return nation, tid, 1 + (nation << 4) + (tid << 8)


# --------------------------------------------------------------------------------------------
# Python 2 pickles inside PYTHON/STRING values: read with a stub for every class, nothing executed
# --------------------------------------------------------------------------------------------

import pickle  # noqa: E402


class _Stub(object):
    def __init__(self, *a, **k):
        self.args = a

    def __setstate__(self, state):
        self.state = state


class _SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        return type(str('%s.%s' % (module, name)), (_Stub,), {})


def safe_unpickle(raw):
    if not isinstance(raw, (bytes, bytearray)) or raw[:1] != b'\x80':
        return None
    try:
        if PY3:
            return _SafeUnpickler(io.BytesIO(bytes(raw)), encoding='bytes').load()
        return _SafeUnpickler(io.BytesIO(str(raw))).load()
    except Exception:
        return None


# --------------------------------------------------------------------------------------------
# Packet stream
# --------------------------------------------------------------------------------------------

# Frame: u32 payload length, u32 type, f32 clock (seconds since the recording start), payload.
# Names of 0x00-0x0a, 0x0f, 0x24: Monstrofil/replays_unpack clients/wot/network/packets; the rest are
# named here from their payloads in two 2.4.0.1 replays (report section 2).
PACKET_NAMES = {
    0x00: 'player_base', 0x01: 'player_cell', 0x02: 'entity_control', 0x03: 'entity_enter',
    0x04: 'entity_leave', 0x05: 'entity_create', 0x06: 'entity_properties', 0x07: 'property',
    0x08: 'method', 0x0a: 'position', 0x0f: 'space_data', 0x18: 'version', 0x1b: 'camera_mode',
    0x23: 'chat_message', 0x24: 'nested_property', 0x31: 'named_event', 0x32: 'cgf_replication',
    0xffffffff: 'end',
    # 02.11.2026, tools/replay_components.py (meaning measured against camera modes, target changes and removals):
    0x15: 'server_time_at_start', 0x16: 'arena_period', 0x17: 'arena_period_end', 0x1a: 'client_gun_marker',
    0x1c: 'turret_yaw', 0x1d: 'gun_pitch', 0x1f: 'net_stats', 0x20: 'client_reload',
    0x22: 'own_vehicle', 0x26: 'camera', 0x28: 'target_lock', 0x2b: 'period_flag', 0x2d: 'client_tuple',
    0x2e: 'sniper_mode', 0x30: 'client_quality', 0x35: 'object_removed_marker', 0x36: 'tick_marker',
    0x37: 'component_messages', 0x39: 'volatile', 0x3d: 'client_hash',
    # 02.11.2026 evening: the setup packets and the battle results
    0x0d: 'space_data_entry', 0x11: 'battle_results', 0x12: 'flag_0x12', 0x1e: 'ammo_button',
}

# constants.ARENA_UPDATE of the 2.4.0.1 bytecode (scripts/common/constants.pyc)
ARENA_UPDATE = {1: 'VEHICLE_LIST', 2: 'VEHICLE_ADDED', 3: 'PERIOD', 4: 'STATISTICS', 5: 'VEHICLE_STATISTICS',
                6: 'VEHICLE_KILLED', 7: 'AVATAR_READY', 8: 'BASE_POINTS', 9: 'BASE_CAPTURED', 10: 'TEAM_KILLER',
                11: 'VEHICLE_UPDATED', 12: 'COMBAT_EQUIPMENT_USED', 16: 'FLAG_TEAMS', 17: 'FLAG_STATE_CHANGED',
                19: 'INTERACTIVE_STATS', 21: 'RESOURCE_POINT_STATE_CHANGED', 22: 'OWN_VEHICLE_INSIDE_RP',
                23: 'OWN_VEHICLE_LOCKED_FOR_RP', 24: 'SYNC_OBJECTS', 25: 'SYNC_OBJECTS_DIFF', 26: 'VIEW_POINTS',
                27: 'FOG_OF_WAR', 28: 'VEHICLE_RECOVERED', 29: 'RADAR_INFO_RECEIVED', 30: 'SETTINGS',
                31: 'VEHICLE_DESCR'}

_POS = struct.Struct('<ii3f3f3fb')
CELL_CLIENT_FLAGS = ('ALL_CLIENTS', 'OWN_CLIENT', 'CELL_PUBLIC_AND_OWN', 'OTHER_CLIENTS')


def iter_packets(stream, tail=None):
    """(type, clock, payload) per whole packet. A packet the stream cuts short (a raw temp file of a battle still being
    written) is not yielded; tail, a list when given, receives the number of bytes left over (0: the stream ends on a
    packet boundary)."""
    off, n = 0, len(stream)
    while off + 12 <= n:
        size, ptype, clock = struct.unpack_from('<IIf', stream, off)
        if off + 12 + size > n:
            break
        yield ptype, clock, stream[off + 12:off + 12 + size]
        off += 12 + size
    if tail is not None:
        tail.append(n - off)


class Decoder(object):
    def __init__(self, defs):
        self.defs = defs
        self.entities = {}  # entity id -> entity type name
        self.packets = collections.Counter()
        self.members = collections.Counter()  # (entity, name) decoded exactly
        self.failures = collections.Counter()
        self.unmapped = collections.Counter()
        self.player_id = None
        self.values = {}  # entity id -> current property values (create + updates), for nested updates (0x24)
        self.partial_bytes = 0  # bytes of a partial last packet dropped (a raw temp stream still being written)

    def type_name(self, typ):
        i = typ - 1
        if 0 <= i < len(self.defs.entities):
            return self.defs.entities[i]
        return 'entityType%d' % typ

    def _props_blob(self, spec, blob):
        """count byte, then (u8 property id, value) pairs - the blob of EntityCreate and of packet 0x06."""
        n, pos, out = blob[0], 1, {}
        for _ in range(n):
            idx = blob[pos]
            pos += 1
            if idx >= len(spec.client_props):
                raise IndexError('property id %d beyond the %d own properties of %s (dynamic component)'
                                 % (idx, len(spec.client_props), spec.name))
            name, t = spec.client_props[idx]
            out[name], pos = t.read(blob, pos)
        return out, pos

    def decode(self, stream):
        """Yields event dicts {'t': clock, 'ev': kind, ...}; one bad packet never stops the stream."""
        from . import replay_objects as rc   # imported here: replay_objects imports this module
        self.objects = rc.ObjectTable(rc.Registry(self.defs.client, self.defs))
        self.objects.reg.base = rc.calibrate_base(stream, self.objects.reg)
        last = None
        tail = []
        for ptype, clock, p in iter_packets(stream, tail):
            if clock != last and self.objects.pending:
                for ev in self.objects.flush():
                    yield ev
            last = clock
            name = PACKET_NAMES.get(ptype, 'type_0x%02x' % ptype)
            self.packets[name] += 1
            try:
                if ptype == 0x32:
                    evs = self.objects.create(p)
                    for ev in evs:
                        ev['t'] = clock
                    evs += self.objects.retry()
                elif ptype == 0x37:
                    n, = struct.unpack_from('<I', p, 0)
                    evs = self.objects.messages(p[4:4 + n], clock)
                elif ptype == 0x24:
                    evs = [rc.entity_nested(self, clock, p)]
                elif ptype in rc.SMALL:
                    ev = rc.small_packet(ptype, clock, p)
                    if ev is not None:
                        ev['t'] = clock
                    evs = [ev]
                else:
                    evs = [self._decode_one(ptype, clock, p)]
            except Exception as e:
                self.failures[(name, type(e).__name__, str(e)[:90])] += 1
                evs = [{'t': clock, 'ev': 'undecoded', 'type': '0x%02x' % ptype, 'len': len(p), 'error': str(e)[:120]}]
            for ev in evs:
                if ev is not None:
                    if ev['ev'] == 'entity_create' and 'props' in ev:
                        self.values[ev['id']] = ev['props']
                    elif ev['ev'] == 'property' and 'name' in ev:
                        self.values.setdefault(ev['id'], {})[ev['name']] = ev['value']
                    yield ev
        self.partial_bytes = tail[0] if tail else 0
        if self.partial_bytes:
            self.packets['(partial last packet, dropped)'] += 1
        for ev in self.objects.flush():
            yield ev

    def _member(self, kind, eid, mid, data):
        ent = self.entities.get(eid)
        spec = self.defs.spec(ent) if ent else None
        table = None if spec is None else (spec.client_props if kind == 'property' else spec.client_methods)
        if table is None or mid >= len(table):
            self.unmapped[(kind, ent, mid)] += 1
            return None, ent, None
        return spec, ent, table[mid]

    def _decode_one(self, ptype, t, p):
        if ptype == 0x0a:
            # entity, the vehicle an Avatar rides (0 for a vehicle), world position, a second vector (named
            # positionError in open parsers; not verified), hull yaw/pitch/roll in radians, a flag byte (1 in
            # 40655 of 40682 packets; meaning not established)
            eid, vid, x, y, z, ex, ey, ez, yaw, pitch, roll, flag = _POS.unpack_from(p, 0)
            return {'t': t, 'ev': 'position', 'id': eid, 'vehicleId': vid, 'pos': [x, y, z], 'posError': [ex, ey, ez],
                    'yaw': yaw, 'pitch': pitch, 'roll': roll, 'flag': flag}
        if ptype == 0x07:
            eid, mid, ln = struct.unpack_from('<III', p, 0)
            data = p[12:12 + ln]
            spec, ent, member = self._member('property', eid, mid, data)
            if member is None:
                return {'t': t, 'ev': 'property', 'id': eid, 'entity': ent, 'propId': mid, 'raw': hexs(data),
                        'note': 'id beyond the own properties: a dynamic component, not mapped'}
            pname, ty = member
            val, pos = ty.read(data, 0)
            if pos != len(data):
                raise ValueError('%s.%s consumed %d of %d bytes' % (ent, pname, pos, len(data)))
            self.members[(ent, pname)] += 1
            ev = {'t': t, 'ev': 'property', 'id': eid, 'entity': ent, 'name': pname, 'value': val}
            if ent == 'Vehicle' and pname == 'gunAnglesPacked':
                ev['turretYaw'], ev['gunPitchT'] = decode_gun_angles(val)
            return ev
        if ptype == 0x08:
            eid, mid, ln = struct.unpack_from('<III', p, 0)
            data = p[12:12 + ln]
            spec, ent, member = self._member('method', eid, mid, data)
            if member is None:
                return {'t': t, 'ev': 'method', 'id': eid, 'entity': ent, 'methodId': mid, 'raw': hexs(data),
                        'note': 'id beyond the own methods: a dynamic component, not mapped'}
            mname, args, _ = member
            names = ARG_NAMES.get('%s.%s' % (ent, mname)) or [a[0] for a in args]
            out, pos = {}, 0
            for i, (aname, ty) in enumerate(args):
                out[names[i] if i < len(names) else aname], pos = ty.read(data, pos)
            if pos != len(data):
                raise ValueError('%s.%s consumed %d of %d bytes' % (ent, mname, pos, len(data)))
            self.members[(ent, mname)] += 1
            if ent == 'Vehicle' and mname == 'showDamageFromShot':
                out['hitPoints'] = [decode_hit_point(h) for h in out['hitPoints']]
            if ent == 'Avatar' and mname == 'updateArena':
                out['updateTypeName'] = ARENA_UPDATE.get(out['updateType'])
                raw = out['argStr']
                if raw[:1] == b'x':
                    try:
                        raw = zlib.decompress(raw)
                    except zlib.error:
                        pass
                value = safe_unpickle(raw)
                if value is not None:
                    out['arg'] = value
            return {'t': t, 'ev': 'method', 'id': eid, 'entity': ent, 'name': mname, 'args': out}
        if ptype == 0x05:
            eid, typ, vid, space = struct.unpack_from('<iHii', p, 0)
            pos3 = list(struct.unpack_from('<3f', p, 14))
            dir3 = list(struct.unpack_from('<3f', p, 26))
            blen, = struct.unpack_from('<I', p, 42)
            blob = p[46:46 + blen]
            ent = self.type_name(typ)
            self.entities[eid] = ent
            spec = self.defs.spec(ent)
            ev = {'t': t, 'ev': 'entity_create', 'id': eid, 'entity': ent, 'typeId': typ, 'vehicleId': vid,
                  'spaceId': space, 'pos': pos3, 'dir': dir3}
            if spec is None:
                ev['note'] = 'no .def for this entity type id (extension entity, order not derived)'
                self.unmapped[('create', ent, None)] += 1
                return ev
            try:
                ev['props'], used = self._props_blob(spec, blob)
                if used != len(blob):
                    raise ValueError('create blob of %s consumed %d of %d' % (ent, used, len(blob)))
                self.members[(ent, '<create>')] += 1
            except IndexError as e:
                ev['note'] = str(e)
                self.unmapped[('create', ent, None)] += 1
            return ev
        if ptype == 0x06:
            eid, blen = struct.unpack_from('<iI', p, 0)
            ent = self.entities.get(eid) or 'Vehicle'
            props, used = self._props_blob(self.defs.spec(ent), p[8:8 + blen])
            if used != blen:
                raise ValueError('0x06 consumed %d of %d bytes' % (used, blen))
            self.members[(ent, '<own properties 0x06>')] += 1
            return {'t': t, 'ev': 'entity_properties', 'id': eid, 'entity': ent, 'props': props}
        if ptype == 0x00:
            eid, typ, _unk, blen = struct.unpack_from('<iHII', p, 0)
            ent = self.type_name(typ)
            self.entities[eid] = ent
            self.player_id = eid
            blob = p[14:14 + blen]
            out, pos = {}, 0
            for n_, (ty, fl) in self.defs.spec(ent).props.items():
                if fl == 'BASE_AND_CLIENT':
                    out[n_], pos = ty.read(blob, pos)
            return {'t': t, 'ev': 'player_base', 'id': eid, 'entity': ent, 'props': out,
                    'note': 'BASE_AND_CLIENT properties in declaration order; %d trailing byte(s)' % (len(blob) - pos)}
        if ptype == 0x01:
            eid, space, _u, vid = struct.unpack_from('<iiHi', p, 0)
            pos3 = list(struct.unpack_from('<3f', p, 14))
            dir3 = list(struct.unpack_from('<3f', p, 26))
            blen, = struct.unpack_from('<I', p, 38)
            blob = p[42:42 + blen]
            ent = self.entities.get(eid, 'Avatar')
            out, pos = {}, 0
            for n_, (ty, fl) in self.defs.spec(ent).props.items():
                if fl in CELL_CLIENT_FLAGS:
                    out[n_], pos = ty.read(blob, pos)
            return {'t': t, 'ev': 'player_cell', 'id': eid, 'spaceId': space, 'vehicleId': vid, 'pos': pos3,
                    'dir': dir3, 'props': out,
                    'note': 'own cell properties decoded; %d byte(s) of dynamic components not decoded' % (len(blob) - pos)}
        if ptype in (0x03, 0x04):
            eid, = struct.unpack_from('<i', p, 0)
            return {'t': t, 'ev': 'entity_leave' if ptype == 0x04 else 'entity_enter', 'id': eid}
        if ptype in (0x18, 0x1b):
            n, = struct.unpack_from('<I', p, 0)
            key = 'version' if ptype == 0x18 else 'mode'
            return {'t': t, 'ev': PACKET_NAMES[ptype], key: p[4:4 + n].decode('ascii', 'replace')}
        if ptype == 0x0f:
            eid, n = struct.unpack_from('<iI', p, 0)
            return {'t': t, 'ev': 'space_data', 'space': p[8:8 + n].split(b'\0')[0].decode('ascii', 'replace')}
        if ptype == 0x23:
            return {'t': t, 'ev': 'chat_message', 'len': len(p)}  # chat text carries nicknames: never output
        if ptype == 0x31:
            # client-side replay event: u32 name length, name, u32 pickle length, protocol-2 pickle of the arguments
            n, = struct.unpack_from('<I', p, 0)
            name = p[4:4 + n].decode('ascii', 'replace')
            m, = struct.unpack_from('<I', p, 4 + n)
            ev = {'t': t, 'ev': 'named_event', 'name': name}
            if not name.startswith('bw_chat2'):  # chat actions carry nicknames: name only
                ev['args'] = safe_unpickle(p[8 + n:8 + n + m])
            return ev
        if ptype == 0x32:
            return {'t': t, 'ev': PACKET_NAMES[ptype], 'len': len(p), 'note': 'not decoded'}
        if ptype == 0xffffffff:
            return {'t': t, 'ev': 'end', 'len': len(p)}
        return {'t': t, 'ev': 'packet', 'type': '0x%02x' % ptype, 'len': len(p), 'raw': hexs(p[:64])}


# --------------------------------------------------------------------------------------------
# Battle model: what a summary (and milestone 2) needs, gathered while the stream is decoded
# --------------------------------------------------------------------------------------------

class Battle(object):
    def __init__(self, blocks, vehicle_names=None):
        self.names = vehicle_names or {}
        self.header = blocks[0] if blocks else {}
        self.results = blocks[1] if len(blocks) > 1 else None
        self.vehicles = {}  # entity id -> dict
        for vid, v in (self.header.get('vehicles') or {}).items():
            self.vehicles[int(vid)] = {'type': v.get('vehicleType'), 'team': v.get('team'),
                                       'maxHealthHeader': v.get('maxHealth'), 'health': None, 'healthFirst': None,
                                       'healthMin': None, 'created': 0, 'positions': 0, 'gunAngles': 0,
                                       'shotsFired': 0, 'hitsReceived': 0, 'damageReceived': 0}
        self.counts = collections.Counter()
        self.tracers = {}  # shotID -> showTracer args

    def veh(self, eid):
        return self.vehicles.setdefault(eid, {'type': None, 'team': None, 'maxHealthHeader': None, 'health': None,
                                              'healthFirst': None, 'healthMin': None, 'created': 0, 'positions': 0,
                                              'gunAngles': 0, 'shotsFired': 0, 'hitsReceived': 0,
                                              'damageReceived': 0})

    def _public_info(self, eid, t, info):
        if not info or not info.get('compDescr'):
            return
        v = self.veh(eid)
        nation, tid, tcd = parse_vehicle_compact_descr(info['compDescr'])
        name = self.names.get((nation, tid), 'typeCompDescr %d' % tcd)
        history = v.setdefault('typeHistory', [])
        if not history or history[-1][1] != name or history[-1][2] != info.get('maxHealth'):
            history.append((round(t, 3), name, info.get('maxHealth')))
        v['typeStream'] = name
        v['typeCompDescr'] = tcd
        v['maxHealthStream'] = info.get('maxHealth')
        v['team'] = v['team'] or info.get('team')

    def _health(self, eid, value):
        v = self.veh(eid)
        if v['healthFirst'] is None:
            v['healthFirst'] = value
        v['health'] = value
        v['healthMin'] = value if v['healthMin'] is None else min(v['healthMin'], value)

    def feed(self, ev):
        kind = ev['ev']
        if kind in ('method', 'property') and 'name' in ev:
            self.counts['%s %s.%s' % (kind, ev.get('entity'), ev['name'])] += 1
        else:
            self.counts[kind] += 1
        ent = ev.get('entity')
        if kind == 'entity_create' and ent == 'Vehicle':
            v = self.veh(ev['id'])
            v['created'] += 1
            props = ev.get('props') or {}
            if 'health' in props:
                self._health(ev['id'], props['health'])
            self._public_info(ev['id'], ev['t'], props.get('publicInfo'))
        elif kind == 'position' and ev['id'] in self.vehicles:
            self.vehicles[ev['id']]['positions'] += 1
        elif kind == 'property' and ent == 'Vehicle':
            if ev.get('name') == 'health':
                self._health(ev['id'], ev['value'])
            elif ev.get('name') == 'publicInfo':
                # Onslaught's in-battle vehicle switch: a new type and max HP arrive as a property update
                self._public_info(ev['id'], ev['t'], ev['value'])
            elif ev.get('name') == 'gunAnglesPacked':
                self.veh(ev['id'])['gunAngles'] += 1
        elif kind == 'method' and ent == 'Vehicle':
            a = ev.get('args') or {}
            if ev.get('name') == 'onHealthChanged':
                self._health(ev['id'], a['newHealth'])
            elif ev.get('name') == 'showShooting':
                self.veh(ev['id'])['shotsFired'] += 1
            elif ev.get('name') == 'showDamageFromShot':
                v = self.veh(ev['id'])
                v['hitsReceived'] += 1
                v['damageReceived'] += max(0, a.get('damage') or 0)
        elif kind == 'method' and ent == 'Avatar' and ev.get('name') == 'showTracer':
            self.tracers[ev['args']['shotID']] = ev['args']

    def summary(self):
        vehicles = []
        # Results block (only when the player stayed to the end): per vehicle id, the vehicle it ended with.
        results = {}
        if self.results:
            for vid, rows in (self.results[0].get('vehicles') or {}).items():
                if rows:
                    results[int(vid)] = rows[0]
        for eid in sorted(self.vehicles):
            v = self.vehicles[eid]
            r = results.get(eid, {})
            v['healthEnd'], v['maxHealthEnd'] = r.get('health'), r.get('maxHealth')
            row = {'id': eid, 'type': v.get('typeStream') or v['type'], 'typeStream': v.get('typeStream'),
                   'typeHistory': v.get('typeHistory', []),
                   'typeHeader': v['type'], 'team': v['team'], 'maxHealth': v['maxHealthHeader'],
                   'maxHealthStream': v.get('maxHealthStream'),
                   'healthFirstSeen': v['healthFirst'], 'healthLastSeen': v['health'], 'created': v['created'],
                   'positions': v['positions'], 'gunAngleUpdates': v['gunAngles'], 'shotsSeen': v['shotsFired'],
                   'hitsReceived': v['hitsReceived'], 'damageReceivedSeen': v['damageReceived'],
                   'healthEnd': v['healthEnd'], 'maxHealthEnd': v['maxHealthEnd']}
            vehicles.append(row)
        common = (self.results[0].get('common') if self.results else {}) or {}
        return {
            'client': self.header.get('clientVersionFromXml', '').replace(u'\xa0', u' '),
            'map': self.header.get('mapName'), 'gameplay': self.header.get('gameplayID'),
            'battleType': self.header.get('battleType'), 'dateTime': self.header.get('dateTime'),
            'arenaUniqueID': self.results[0].get('arenaUniqueID') if self.results else None,
            'duration': common.get('duration'), 'hasResults': self.results is not None,
            'vehicles': vehicles,
        }
