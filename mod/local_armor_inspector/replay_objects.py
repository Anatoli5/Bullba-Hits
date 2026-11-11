"""Component layer of the .wotreplay stream (2.4.x): replicated objects (0x32), their member messages (0x37),
nested updates, and the small client packets. Used by replay_stream.py (Decoder.decode); measured on 2.4.1.1
replays (outputs/replay-components-2026-11-02.md). Runs under the client's Python 2.7 and CPython 3: byte strings
are indexed as ints only when they are bytearrays (Python 2), so every copy that is indexed later is a bytearray.

Model (each rule below was found on the replays and checked against them; the report gives the counts):
- 0x32 creates objects: u32 length, then records [u16be id][u16be parent][u8 kind]. Kind 1 = an entity
  ([u32 entity id][u8 has-state]; with state: [u16be id again][child ids: a byte = delta from the previous id,
  or 0x80|hi, lo = an absolute id; 00][the children as kind-2 bodies in that order]). Kind 2 = a component
  ([u8 type][u16be name length][name][state]).
- Component type numbers: scripts/components.xml <DynamicComponents> in file order, skipping the entries
  that have no client class (scripts/client/<Name>.pyc) and the second occurrence of a repeated name, from a
  base that is 53 in 2.4.1.1. The base is
  re-derived per replay from the player's OwnVehicle (dynamic component 0, the only one with 34 members).
- State: [ids][0x82][mask][values] (outputs/replay-state-header-2026-11-10.md, 676 of 676 states):
  - ids: members + 1 ids, counted from the instance id: a byte < 0x80 = the id at that delta, 80 hi lo = an
    absolute id, 0x80|n (n >= 3) = the next n - 2 consecutive ids; 0x82 (a run of 0) ends the list. The
    members come first in order; the last id is no member (it never receives a message and is never another
    object's id; its meaning is unknown). Usually one run, [0x80 | (members + 3)], so member i has id
    instance + 1 + i; the server keeps an object's ids, and ids it skipped leave gaps (05 83 = instance + 5, + 6).
  - mask: one bit per listed id, little-endian, ceil(ids / 8) bytes; the last id's bit is always set and carries
    no value. For every member whose bit is set, in order: a property's value (the property type's stream
    form), or for a method one byte = its index in the size-sorted method table. Members are the client
    properties (interfaces first, stably sorted by stream size, as for entities) and then the client methods in
    the order the state lists them.
- 0x37 = member messages: u32 length, then messages [u16be id][body], id = a member id of an instance.
  A message may come before the 0x32 frame of the same tick that creates its instance; it is held until
  that frame. id == instance id: no body (the instance is removed; packet 0x35 marks each removal). A simple-typed
  property: the raw value. Any other property: [u8 mode][packed length][payload]; mode 0 sets the whole
  value; mode 1 replaces a slice of an array, mode 2 sets one element or field, both with a bit path.
  A method: its arguments, self-delimiting.
- Bit path (MSB first): 1 bit 'descend' (1 at the property level, always), the property index
  (bits for the component's property count), then per level: 1 bit descend; descend -> the index of the
  array element (bits for the array length) or of the dict field (bits for the field count); stop -> the
  leaf index (array: bits for the length; slice: two indexes, bits for length + 1); the value starts at
  the next byte.
"""
from __future__ import absolute_import, division
import collections
import io
import os
import pickle
import struct
import zipfile
import zlib

from . import replay_stream as rd


def _le(b):
    """Little-endian unsigned int of a byte string (int.from_bytes is Python 3 only)."""
    v = 0
    for i, x in enumerate(bytearray(b)):
        v |= x << (8 * i)
    return v


def _bits_for(n):
    """next_power_of_two(n).trailing_zeros(): the index width for n choices (0 for 0 or 1)."""
    return max(0, (n - 1).bit_length())


class BitReader(object):
    def __init__(self, buf):
        self.buf, self.pos = buf, 0

    def read(self, n):
        v = 0
        for _ in range(n):
            byte = self.buf[self.pos >> 3]
            v = (v << 1) | ((byte >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v

    def aligned(self):
        return (self.pos + 7) >> 3


class ComponentSpec(object):
    def __init__(self, name, props, methods, detail=(), iface=()):
        self.name = name
        cl = [(n, t) for n, (t, f) in props.items() if f in rd.CLIENT_FLAGS]
        self.props = sorted(cl, key=lambda x: rd._size_key(x[1].size))
        # Properties with <DetailLevel> (MY_VEHICLE) reach only the owner's client: another vehicle's instance
        # has fewer members. The stream's member count picks the variant (props_for).
        self.detail, self.iface = set(detail), set(iface)
        ms = []
        for n, (args, header) in methods.items():
            key = 0xffff + header if any(a[1].size is None for a in args) else sum(a[1].size for a in args) + header
            ms.append((key, n, args))
        ms.sort(key=lambda x: x[0])
        self.sorted_methods = [(n, args) for key, n, args in ms]
        self.members = len(self.props) + len(self.sorted_methods)

    def props_for(self, members):
        nm = len(self.sorted_methods)
        for drop in (set(), self.detail, self.iface, self.detail | self.iface):
            props = [x for x in self.props if x[0] not in drop]
            if len(props) + nm == members:
                return props
        return None


class Registry(object):
    """Component type number -> name, from the client's components.xml and its client classes."""

    BASE_2_4_1_1 = 53

    def __init__(self, client, defs):
        self.client, self.defs = client, defs
        self.dynamic = []      # names, file order, entries without a client class removed
        pk = os.path.join(client.root, 'res', 'packages')
        names, classes = [], set()
        for name in sorted(os.listdir(pk)):
            if not name.endswith('.pkg'):
                continue
            try:
                z = zipfile.ZipFile(os.path.join(pk, name))
            except rd.BadZip:
                continue
            for item in z.namelist():
                if item.endswith('.pyc') and '/client' in item:
                    classes.add(item.rsplit('/', 1)[-1][:-4])
                if item == 'scripts/components.xml':
                    for sec in packed_xml_decode(z.read(item)):
                        if sec.tag == 'DynamicComponents':
                            names = [ch.tag for ch in sec]
        self.dynamic = numbered_components(names, classes)
        self.base = self.BASE_2_4_1_1
        self._specs = {}

    def name(self, typ):
        i = typ - self.base
        return self.dynamic[i] if 0 <= i < len(self.dynamic) else None

    def spec(self, name):
        if name in self._specs:
            return self._specs[name]
        path = self.client.find('component_defs/%s.def' % name)
        spec = None
        if path is not None:
            props, methods, vol = collections.OrderedDict(), collections.OrderedDict(), []
            client = self.defs.client
            find = client.find

            def find_iface(suffix):   # component interfaces live in component_defs/interfaces
                r = find(suffix)
                if r is None and suffix.startswith('entity_defs/interfaces/'):
                    r = find(suffix.replace('entity_defs/', 'component_defs/'))
                return r
            client.find = find_iface
            try:
                self.defs._collect(client.xml(path), props, methods, vol, set())
            finally:
                client.find = find
            root = self.client.xml(path)
            sec = root.find('Properties')
            detail = [p.tag for p in (sec if sec is not None else []) if p.find('DetailLevel') is not None]
            own = set(p.tag for p in (sec if sec is not None else []))
            spec = ComponentSpec(name, props, methods, detail, [n for n in props if n not in own])
        self._specs[name] = spec
        return spec


def numbered_components(names, classes):
    """The numbered dynamic components: file order, without the entries that have no client class and without the
    second occurrence of a name (three names occur twice in 2.4.1.1: SecondaryGunComponent,
    NetworkReplicationPointComponent, NetworkVehicleHierarchy; the stream numbers only the first)."""
    out, seen = [], set()
    for n in names:
        if n in classes and n not in seen:
            out.append(n)
            seen.add(n)
    return out


def packed_xml_decode(raw):
    return rd.packed_xml.decode(raw)


class Instance(object):
    __slots__ = ('cid', 'owner', 'typ', 'name', 'label', 'spec', 'methods', 'values', 'members', 'props', 'ids')

    def __init__(self, cid, owner, typ, name, label, spec):
        self.cid, self.owner, self.typ, self.name, self.label, self.spec = cid, owner, typ, name, label, spec
        self.methods = list(spec.sorted_methods) if spec else []   # wire order, replaced by the state's table
        self.props = list(spec.props) if spec else []
        self.values = {}
        self.members = spec.members if spec else 0
        self.ids = []


def default_value(ty):
    """The value of a property the state leaves out (its presence bit is 0)."""
    if ty.kind == 'array':
        return []
    if ty.kind == 'num':
        return 0
    return None


class ObjectTable(object):
    """Replicated objects and component instances, updated in stream order (ids are reused)."""

    def __init__(self, registry):
        self.reg = registry
        self.entities = {}     # object id -> entity id
        self.instances = {}    # component instance id -> Instance
        self.ids = {}          # live id -> (Instance, member index; None = the instance itself)
        self.pending = []      # (clock, bytes): messages whose instance was not created yet
        self.failures = collections.Counter()

    # ---- 0x32
    def create(self, p):
        out = []
        off = 0
        while off + 4 <= len(p):
            n, = struct.unpack_from('<I', p, off)
            b = p[off + 4:off + 4 + n]
            off += 4 + n
            try:
                out.extend(self._frame(b))
            except Exception as e:  # noqa: BLE001 - one bad frame never stops the stream
                self.failures[('frame', type(e).__name__, str(e)[:80])] += 1
        return out

    def retry(self):
        """After a 0x32 frame: the held messages, read now that their instances may exist."""
        held, self.pending = self.pending, []
        out = []
        for t, b in held:
            out.extend(self.messages(b, t))
        return out

    def flush(self):
        """At a new tick: held messages whose instance never came are read with resynchronisation."""
        held, self.pending = self.pending, []
        out = []
        for t, b in held:
            out.extend(self.messages(b, t, hold=False))
        return out

    def _frame(self, b):
        out, pos = [], 0
        while pos + 5 <= len(b):
            oid, par = struct.unpack_from('>HH', b, pos)
            kind = b[pos + 4]
            if kind == 1:
                eid, = struct.unpack_from('<I', b, pos + 5)
                self.entities[oid] = eid
                out.append({'ev': 'object', 'oid': oid, 'entityId': eid})
                pos += 9
                if pos < len(b):          # a record that ends here has no state byte
                    has_state = b[pos]
                    pos += 1
                    if has_state:
                        pos = self._entity_state(b, pos, oid, eid, out)
            elif kind == 2:
                pos = self._component(b, pos + 5, oid, self.entities.get(par, par), out)
            else:
                if any(b[pos:]):
                    raise ValueError('record kind %d at %d' % (kind, pos))
                break
        return out

    def _entity_state(self, b, pos, oid, eid, out):
        if struct.unpack_from('>H', b, pos)[0] != oid:
            raise ValueError('entity state of %04x names another object' % oid)
        pos += 2
        ids, cur = [], oid
        while b[pos] != 0:
            if b[pos] & 0x80:
                cur = (b[pos + 1] << 8) | b[pos + 2]
                pos += 3
            else:
                cur += b[pos]
                pos += 1
            ids.append(cur)
        pos += 1
        for cid in ids:
            if b[pos] != 2:
                raise ValueError('child %04x of %04x: kind %d' % (cid, oid, b[pos]))
            pos = self._component(b, pos + 1, cid, eid, out)
        return pos

    def _component(self, b, pos, cid, owner, out):
        typ = b[pos]
        ln, = struct.unpack_from('>H', b, pos + 1)
        label = b[pos + 3:pos + 3 + ln].decode('latin-1')
        pos += 3 + ln
        name = self.reg.name(typ)
        spec = self.reg.spec(name) if name else None
        inst = Instance(cid, owner, typ, name, label, spec)
        ids, pos = self._member_ids(b, pos, cid)
        members = len(ids) - 1
        inst.members, inst.ids = members, ids[:members]   # the last id is no member
        nmask = (len(ids) + 7) // 8
        mask = _le(b[pos + 1:pos + 1 + nmask])
        pos += 1 + nmask
        for i in [cid] + inst.ids:
            self._drop(i)
        self.ids[cid] = (inst, None)
        for j, i in enumerate(inst.ids):
            self.ids[i] = (inst, j)
        ev = {'ev': 'component', 'cid': cid, 'owner': owner, 'type': typ, 'component': name, 'label': label,
              'members': members}
        props = spec.props_for(members) if spec else None
        if props is None:
            # Unknown type or a member count other than the .def gives: the values cannot be walked.
            ev['note'] = 'state not decoded (%s members in the stream, %s in the .def)' % (
                members, spec.members if spec else None)
            self.failures[('state', name, members, spec.members if spec else None)] += 1
            self.instances[cid] = inst
            out.append(ev)
            raise ValueError('cannot skip the state of %04x %s' % (cid, name))
        inst.props = props
        np = len(props)
        table = []
        for j in range(members):
            if not (mask >> j) & 1:
                if j < np:
                    inst.values[props[j][0]] = default_value(props[j][1])
                continue
            if j < np:
                pname, ty = props[j]
                inst.values[pname], pos = ty.read(b, pos)
            else:
                table.append(b[pos])
                pos += 1
        if table:
            inst.methods = [spec.sorted_methods[i] for i in table]
        ev['state'] = dict(inst.values)
        self.instances[cid] = inst
        out.append(ev)
        return pos

    @staticmethod
    def _member_ids(b, pos, cid):
        """The id list of a state (module docstring): members + 1 ids; returns (ids, position of the closing 0x82)."""
        ids, cur = [], cid
        while True:
            c = b[pos]
            if c == 0x82:
                if not ids:
                    raise ValueError('id list of %04x is empty' % cid)
                return ids, pos
            if c == 0x80:
                cur = (b[pos + 1] << 8) | b[pos + 2]
                ids.append(cur)
                pos += 3
            elif c == 0x81:
                raise ValueError('id list of %04x: byte 0x81 (never seen)' % cid)
            elif c & 0x80:
                ids.extend(range(cur + 1, cur + 1 + (c & 0x7f) - 2))
                cur = ids[-1]
                pos += 1
            else:
                cur += c
                ids.append(cur)
                pos += 1
            if len(ids) > 256:
                raise ValueError('member ids of %04x do not end' % cid)

    def _drop(self, i):
        """Forget every id of the instance that holds id i (the id is being reused or removed)."""
        hit = self.ids.get(i)
        if hit is not None:
            inst = hit[0]
            for k in [inst.cid] + inst.ids:
                if self.ids.get(k, (None,))[0] is inst:
                    del self.ids[k]

    # ---- 0x37
    def lookup(self, mid):
        return self.ids.get(mid, (None, None))

    def messages(self, b, t, dry=False, hold=True):
        """dry: parse without changing any stored value (used to test a resynchronisation point).
        hold: keep the rest of the packet for retry() when an id names no live instance."""
        out, pos = [], 0
        while pos + 2 <= len(b):
            mid = (b[pos] << 8) | b[pos + 1]
            inst, m = self.lookup(mid)
            if inst is not None and m is None:
                out.append({'t': t, 'ev': 'component_removed', 'cid': mid, 'owner': inst.owner, 'component': inst.name})
                if not dry:
                    self._drop(mid)
                pos += 2
                continue
            if inst is None or inst.spec is None or m >= inst.members:
                if dry:
                    return None
                if inst is None and hold:
                    self.pending.append((t, bytearray(b[pos:])))
                    return out
                self.failures[('message id', hex(mid), inst.name if inst else None,
                               None if inst is None else m - inst.members)] += 1
                return out + self._resync(b, pos, t, mid)
            start = pos
            pos += 2
            spec = inst.spec
            try:
                if m < len(inst.props):
                    ev, pos = self._property(inst, m, b, pos, t, dry)
                else:
                    mname, args = inst.methods[m - len(inst.props)]
                    vals = collections.OrderedDict()
                    for an, ty in args:
                        vals[an], pos = ty.read(b, pos)
                    ev = {'t': t, 'ev': 'component_method', 'owner': inst.owner, 'component': inst.name,
                          'name': mname, 'args': vals}
            except Exception as e:  # noqa: BLE001
                if dry:
                    return None
                self.failures[('decode', inst.name, str(e)[:80])] += 1
                return out + self._resync(b, start, t, mid, str(e)[:120])
            out.append(ev)
        return out

    def _resync(self, b, pos, t, mid, error=None):
        """After a message that cannot be read: the first later offset from which the rest of the packet reads
        to its end becomes the next message; the bytes skipped are reported as one undecoded message."""
        for k in range(pos + 2, len(b) - 1):
            if self.messages(b[k:], t, dry=True) is not None:
                ev = {'t': t, 'ev': 'component_undecoded', 'id': mid, 'raw': rd.hexs(b[pos:k]), 'resynced': True}
                if error:
                    ev['error'] = error
                return [ev] + self.messages(b[k:], t)
        ev = {'t': t, 'ev': 'component_undecoded', 'id': mid, 'raw': rd.hexs(b[pos:])}
        if error:
            ev['error'] = error
        return [ev]

    def _property(self, inst, m, b, pos, t, dry=False):
        pname, ty = inst.props[m]
        ev = {'t': t, 'ev': 'component_property', 'owner': inst.owner, 'component': inst.name, 'name': pname}
        if ty.kind == 'num':
            ev['value'], pos = ty.read(b, pos)
            if not dry:
                inst.values[pname] = ev['value']
            return ev, pos
        mode = b[pos]
        ln, q = rd._packed_len(b, pos + 1)
        raw = bytearray(b[q:q + ln])
        pos = q + ln
        if mode == 0:
            ev['value'], used = ty.read(raw, 0)
            if used != ln:
                raise ValueError('%s.%s used %d of %d' % (inst.name, pname, used, ln))
            if not dry:
                inst.values[pname] = ev['value']
        else:
            ev.update(nested_update(_Copy(inst) if dry else inst, m, mode, raw))
        return ev, pos


class _Copy(object):
    """An instance whose values may be changed by a trial parse without touching the real one."""

    def __init__(self, inst):
        import copy
        self.props, self.values = inst.props, copy.deepcopy(inst.values)


def nested_update(inst, m, mode, raw):
    """Mode 1 (slice of an array) or 2 (one element/field), path as in the module docstring."""
    props = inst.props
    br = BitReader(raw)
    if br.read(1) != 1:
        raise ValueError('path does not enter the property')
    if br.read(_bits_for(len(props))) != m:
        raise ValueError('path names another property')
    pname, ty = props[m]
    value = inst.values.get(pname)
    if value is None and ty.kind == 'array':
        value = inst.values[pname] = []
    path = [pname]
    holder, key = None, None
    while True:
        descend = br.read(1)
        if ty.kind == 'array':
            length = len(value) if isinstance(value, list) else None
            if length is None:
                raise ValueError('array length of %s unknown' % '.'.join(map(str, path)))
            if descend:
                i = br.read(_bits_for(length))
                path.append(i)
                holder, key = value, i
                value, ty = value[i], ty.children[0]
                continue
            sub = ty.children[0]
            if mode == 1:
                w = _bits_for(length + 1)
                a, z = br.read(w), br.read(w)
                pos, items = br.aligned(), []
                while pos < len(raw):
                    v, pos = sub.read(raw, pos)
                    items.append(v)
                value[a:z] = items
                return {'path': path, 'slice': [a, z], 'value': items}
            i = br.read(_bits_for(length))
            v, pos = sub.read(raw, br.aligned())
            if pos != len(raw):
                raise ValueError('element used %d of %d' % (pos, len(raw)))
            if i < length:
                value[i] = v
            return {'path': path + [i], 'value': v}
        if ty.kind == 'dict':
            fields = ty.children
            i = br.read(_bits_for(len(fields)))
            fname, fty = fields[i]
            if descend:
                path.append(fname)
                if value is None:
                    raise ValueError('field of None %s' % '.'.join(map(str, path)))
                value, ty = value[fname], fty
                continue
            v, pos = fty.read(raw, br.aligned())
            if pos != len(raw):
                raise ValueError('field used %d of %d' % (pos, len(raw)))
            if isinstance(value, dict):
                value[fname] = v
            return {'path': path + [fname], 'value': v}
        raise ValueError('cannot descend into %s' % ty.kind)


# ---- small packets of the client (meaning measured in the report; layout = what the stream carries)
def small_packet(ptype, t, p):
    f = lambda fmt, off=0: struct.unpack_from(fmt, p, off)
    if ptype == 0x15:
        return {'ev': 'server_time_at_start', 'serverTime': f('<d')[0]}
    if ptype == 0x16:
        return {'ev': 'arena_period', 'period': f('<I')[0]}
    if ptype == 0x17:
        return {'ev': 'arena_period_end', 'endTime': f('<f')[0]}
    if ptype == 0x1a:
        v = f('<15f')
        return {'ev': 'client_gun_marker', 'point': list(v[0:3]), 'size': list(v[3:5]), 'gunPosition': list(v[5:8]),
                'direction': list(v[8:11]), 'arcadeSize': v[11], 'spg': list(v[12:15])}
    if ptype in (0x1c, 0x1d):
        # the own turret yaw (to the hull) and gun pitch (+ = down), radians, per tick: their ranges equal the
        # vehicle's limits (AMX 50 Foch B yaw +-10.00 deg, depression 6.000; E 100 depression 7.000)
        return {'ev': 'turret_yaw' if ptype == 0x1c else 'gun_pitch', 'value': f('<f')[0]}
    if ptype == 0x02:
        return {'ev': 'entity_control', 'entityId': f('<I')[0], 'flag': p[4] if len(p) > 4 else None}
    if ptype == 0x0d:
        # [u32 space id][u32 key][u32 length][value]: 3 entries at the start (keys 0, 2, 1)
        space, key, n = f('<3I')
        return {'ev': 'space_data_entry', 'spaceId': space, 'key': key, 'value': rd.hexs(p[12:12 + n])}
    if ptype == 0x12:
        return {'ev': 'flag_0x12', 'value': p[0]}
    if ptype == 0x1e:
        # an ammo key: each one comes with OwnVehicle.vehicleSettings (code 1 = next shell, 0 = current)
        return {'ev': 'ammo_button', 'index': f('<I')[0]}
    if ptype == 0x11:
        return battle_results(p)
    if ptype == 0x1f:
        v = f('<I')[0]
        return {'ev': 'net_stats', 'fps': v & 255, 'ping': (v >> 8) & 0xffff, 'lag': v >> 24}
    if ptype == 0x20:
        return {'ev': 'client_reload', 'values': list(f('<2f'))}
    if ptype == 0x22:
        return {'ev': 'own_vehicle', 'vehicleId': f('<I')[0]}
    if ptype == 0x26:
        v = f('<10f')
        return {'ev': 'camera', 'rotation': list(v[0:4]), 'offset': list(v[4:7]), 'fov': v[7], 'extra': list(v[8:10])}
    if ptype == 0x28:
        return {'ev': 'target_lock', 'state': f('<I')[0]}
    if ptype == 0x2b:
        # 1 with each arena period change (two at the battle start), then 0 right after the end; meaning unknown
        return {'ev': 'period_flag', 'value': p[0]}
    if ptype == 0x2e:
        return {'ev': 'sniper_mode', 'on': bool(p[0])}
    if ptype == 0x35:
        return {'ev': 'object_removed_marker'}
    if ptype == 0x36:
        return None   # empty marker, ~3.5 per 0.1 s tick; meaning not established
    if ptype in (0x2d, 0x30, 0x3d):
        n = f('<I')[0]
        return {'ev': {0x2d: 'client_tuple', 0x30: 'client_quality', 0x3d: 'client_hash'}[ptype],
                'text': p[4:4 + n].decode('ascii', 'replace')}
    if ptype == 0x39 and len(p) >= 15:
        tick, = f('<I', 15)
        ev = {'ev': 'volatile', 'tick': tick, 'len': len(p)}
        if len(p) == 72 and p[41] == 1:   # GunMarkerComponent.gunMarker of the own vehicle (KNOWLEDGE-client)
            ev.update({'ev': 'server_gun_marker', 'gunPosition': list(f('<3f', 42)), 'shotVector': list(f('<3f', 54)),
                       'dispersion': f('<f', 66)[0]})
        return ev
    return None


SMALL = (0x02, 0x0d, 0x11, 0x12, 0x15, 0x16, 0x17, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x22, 0x26, 0x28, 0x2b, 0x2d,
         0x2e, 0x30, 0x35, 0x36, 0x39, 0x3d)


class _ResultsUnpickler(pickle.Unpickler):
    """Battle results are Python 2 pickles; only the builtin set types are let through."""

    def find_class(self, module, name):
        if module in ('__builtin__', 'builtins') and name in ('set', 'frozenset'):
            return {'set': set, 'frozenset': frozenset}[name]
        raise pickle.UnpicklingError('%s.%s' % (module, name))


def _unpickle(raw):
    if rd.PY3:
        return _ResultsUnpickler(io.BytesIO(bytes(raw)), encoding='latin1').load()
    return _ResultsUnpickler(io.BytesIO(str(raw))).load()


def battle_results(p):
    """0x11, at the battle end: [header][zlib(pickle (arena id, zlib(pickle) x 3))]: the results as the server
    sends them, fields by index, not named here. The replay's second JSON block carries the same results with
    the field names (personal, players, vehicles, common)."""
    i = p.find(b'\x78\x01')
    outer = _unpickle(zlib.decompress(bytes(p[i:])))
    parts = [_unpickle(zlib.decompress(x.encode('latin1') if rd.PY3 and isinstance(x, str) else x)) for x in outer[1:]]
    return {'ev': 'battle_results', 'arenaUniqueID': outer[0], 'parts': parts}


def calibrate_base(stream, reg):
    """The type number of OwnVehicle (dynamic component 0) = the base: the component whose state header says
    34 members (one run of 35 ids = 0x80 | 37), the member count of OwnVehicle in this client; default 53 (2.4.1.1)."""
    own = reg.spec('OwnVehicle')
    head = 0x80 | (own.members + 1 + 2) if own else None   # a run byte 0x80|n holds n - 2 ids
    for ptype, clock, p in rd.iter_packets(stream):
        if ptype != 0x32 or head is None:
            continue
        i = p.find(bytearray([0, 0, head, 0x82]))
        while i >= 2:
            if p[i - 2] == 2:
                return p[i - 1]
            i = p.find(bytearray([0, 0, head, 0x82]), i + 1)
    return reg.BASE_2_4_1_1


class _EntityProps(object):
    """An entity seen through the instance interface of nested_update."""

    def __init__(self, props, values):
        self.props = props
        self.values = values


def entity_nested(dec, t, p):
    """0x24: nested update of an entity property. [i32 entity][u8 1 = slice][u32 length][bit path + value]."""
    eid, flag, ln = struct.unpack_from('<iBI', p, 0)
    raw = bytearray(p[9:9 + ln])
    ent = dec.entities.get(eid)
    spec = dec.defs.spec(ent) if ent else None
    ev = {'t': t, 'ev': 'nested_property', 'id': eid, 'entity': ent}
    if spec is None:
        ev['raw'] = rd.hexs(raw)
        return ev
    holder = _EntityProps(spec.client_props, dec.values.setdefault(eid, {}))
    br = BitReader(raw)
    br.read(1)
    m = br.read(_bits_for(len(spec.client_props)))
    ev['name'] = spec.client_props[m][0]
    ev.update(nested_update(holder, m, 1 if flag & 1 else 2, raw))
    return ev
