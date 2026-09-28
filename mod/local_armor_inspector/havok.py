"""Read the self-describing TAG0 collision files used by WoT 2.4.

Type decoding follows Skyth's MIT-licensed TagTools (see THIRD_PARTY.md).
Only the read path is implemented; unsupported shapes fail explicitly.

A struct is read lazily (28.09, havok-lazy): TagFile.root is a Struct whose members are decoded on first access, so a
caller that walks one branch (geometry.extract: 'Collision Physics Data') never decodes the physics, triggers and the
other variants of the file - most of a large file's bytes. The output of what is read is unchanged (tools/havok_parity.py:
every collision model of the client, byte for byte, under python27.dll); an error in a branch nobody reads is no longer
raised.
"""
import struct


class FormatError(ValueError):
    pass


class Type(object):
    def __init__(self):
        self.name, self.parent, self.flags, self.sub, self.pointer, self.size = '', None, 0, 0, None, 0
        self.members = []

    @property
    def base(self):
        return self if self.flags & 1 else self.parent.base

    @property
    def all_members(self):
        return (self.parent.all_members if self.parent else []) + self.members

    @property
    def fields(self):
        """{member name: (offset, type)} of the struct, own members over inherited ones; built once a type."""
        try: return self._fields
        except AttributeError:
            self._fields = dict((n, (off, mt)) for n, off, mt in self.all_members)
            return self._fields


class TagFile(object):
    def __init__(self, data):
        if len(data) > 32 * 1024 * 1024:
            raise FormatError('Collision resource too large')
        self.data, self.pos, self.sections, self.cache = data, 0, {}, {}
        self._chunks(0, len(data))
        if 'TAG0' not in self.sections:
            raise FormatError('Not a TAG0 file')
        self.data_start, self.data_end = self.sections['DATA']
        self._types()
        a, b = self.sections['ITEM']
        if (b-a) % 12: raise FormatError('Invalid ITEM table')
        # The ITEM table is read by index when an item is first reached, not unpacked whole up front.
        self.items_at, self.items_count = a, (b-a) // 12

    def _chunks(self, a, end):
        while a < end:
            if a + 8 > end:
                raise FormatError('Truncated chunk')
            word = struct.unpack_from('>I', self.data, a)[0]
            size = word & 0x3fffffff
            if size < 8 or a + size > end:
                raise FormatError('Invalid chunk size')
            name = self.data[a+4:a+8].decode('ascii')
            self.sections[name] = (a+8, a+size)
            if not word & 0x40000000:
                self._chunks(a+8, a+size)
            a += size

    def read(self, fmt):
        result = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += struct.calcsize(fmt)
        return result[0] if len(result) == 1 else result

    def packed(self):
        b = self.read('B')
        if b < 0x80: return b
        if b < 0xc0: return ((b & 0x3f) << 8) | self.read('B')
        if b < 0xe0: return ((b & 0x1f) << 16) | self.read('>H')
        if b < 0xe8: return ((b & 7) << 24) | (self.read('B') << 16) | self.read('>H')
        if b == 0xe8: return self.read('>I')
        raise FormatError('Unsupported packed integer')

    def section(self, *names):
        for n in names:
            if n in self.sections:
                self.pos, end = self.sections[n]
                return end
        raise FormatError('Missing ' + '/'.join(names))

    def strings(self, *names):
        end = self.section(*names)
        return self.data[self.pos:end].rstrip(b'\xff').decode('utf-8').split('\0')

    def _types(self):
        names = self.strings('TST1', 'TSTR')
        self.section('TNA1', 'TNAM')
        self.types = [Type() for _ in range(self.packed())]
        self.types[0] = None
        for t in self.types[1:]:
            t.name = names[self.packed()]
            for _ in range(self.packed()): self.packed(); self.packed()
        fields = self.strings('FST1', 'FSTR')
        end = self.section('TBDY', 'TBOD')
        while self.pos < end:
            i = self.packed()
            if not i: continue
            t = self.types[i]
            t.parent, t.flags = self.types[self.packed()], self.packed()
            if t.flags & 1: t.sub = self.packed()
            if t.flags & 2 and (t.sub & 15) >= 6: t.pointer = self.types[self.packed()]
            if t.flags & 4: self.packed()
            if t.flags & 8: t.size = self.packed(); self.packed()
            if t.flags & 16: self.packed()
            if t.flags & 32:
                # WoT's TBDY packs the inherited-member count in the high bits.
                for _ in range(self.packed() & 0xffff):
                    name = fields[self.packed()]
                    self.packed()
                    t.members.append((name, self.packed(), self.types[self.packed()]))
            if t.flags & 64:
                for _ in range(self.packed()): self.packed(); self.packed()
            if t.flags & 128: raise FormatError('Unsupported type flags')

    def item(self, index):
        if not index: return []
        if index in self.cache: return self.cache[index]
        if index >= self.items_count: raise FormatError('Invalid item index')
        flag, offset, count = struct.unpack_from('<III', self.data, self.items_at + 12*index)
        t = self.types[flag & 0xffffff]
        if count > 1000000 or offset + count * t.base.size > self.data_end-self.data_start:
            raise FormatError('Invalid item bounds')
        start = self.data_start+offset
        code = self.scalar(t.base)
        if code:
            # An array of plain numbers (vertices, indices, the characters of a string): one unpack, the same values
            # object() gives one by one.
            out = list(struct.unpack_from('<%d%s' % (count, code), self.data, start))
            if t.base.sub & 0x7f == 2: out = [bool(v) for v in out]
            self.cache[index] = out
            return out
        out = []
        self.cache[index] = out
        out.extend(self.object(t, start+i*t.base.size) for i in range(count))
        return out

    @staticmethod
    def scalar(t):
        """The struct code of a plain boolean, integer or float type whose size is its stride, else None."""
        kind = t.sub & 0x7f
        if kind in (2, 4):
            code = next((c for flag, c in [(0x2000,'B'),(0x4000,'H'),(0x8000,'I'),(0x10000,'Q')] if t.sub & flag), None)
            if code and t.sub & 0x200: code = code.lower()
        elif kind == 5: code = {4: 'f', 8: 'd'}.get(t.size)
        else: return None
        return code if code and struct.calcsize('<' + code) == t.size else None

    def object(self, original, offset):
        t = original.base
        kind = t.sub & 0x7f
        self.pos = offset
        if kind in (2, 4):
            fmt = next((c for flag, c in [(0x2000,'B'),(0x4000,'H'),(0x8000,'I'),(0x10000,'Q')] if t.sub & flag), None)
            if not fmt: raise FormatError('Unknown integer')
            value = self.read('<' + (fmt.lower() if t.sub & 0x200 else fmt))
            return bool(value) if kind == 2 else value
        if kind == 5:
            if t.size == 4: return self.read('<f')
            if t.size == 8: return self.read('<d')
            # Half-width fields occur in physics materials, outside shot geometry.
            return None
        if kind in (3, 6, 8):
            # The item index from this field's own offset: a lazy struct's member may be read long after, from
            # anywhere, so nothing may rely on self.pos left by an earlier read.
            values = self.item(struct.unpack_from('<I', self.data, offset)[0])
            if kind == 3: return bytearray((v & 255) for v in values).rstrip(b'\0').decode('utf-8')
            if kind == 6: return values[0] if len(values) == 1 else None
            return values
        if kind == 7:
            return Struct(self, original, offset)
        if kind == 0x28:
            return [self.object(t.pointer, offset+i*t.pointer.base.size) for i in range(t.sub >> 8)]
        if kind == 0: return None
        raise FormatError('Unsupported subtype %s (%s)' % (kind, original.name))

    @property
    def root(self):
        return self.item(1)[0]


class Struct(object):
    """A struct of the file, its members decoded on first access and kept (the same object on every access).

    Deliberately not a dict: only s[name], s.get(name) and `name in s`, so nothing can iterate or serialise a half-read
    struct by mistake. '__type' is the type's name, as the eager reader gave it."""
    __slots__ = ('_tag', '_type', '_offset', '_values')

    def __init__(self, tag, original, offset):
        self._tag, self._type, self._offset, self._values = tag, original, offset, {'__type': original.name}

    def __getitem__(self, key):
        values = self._values
        if key not in values:
            off, member = self._type.fields[key]
            values[key] = self._tag.object(member, self._offset + off)
        return values[key]

    def get(self, key, default=None):
        return self[key] if key in self else default

    def __contains__(self, key):
        return key in self._values or key in self._type.fields

    def __iter__(self):
        # Without it Python would iterate through __getitem__(0), (1)... and fail with a KeyError.
        raise TypeError('A havok struct is read member by member, never iterated')
