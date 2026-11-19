# -*- coding: utf-8 -*-
"""The raw files of one map for the page's 3D replay player (BACKLOG 104, 18.11.2026): copied out of the client's packages
as classic scripts the page can load under file:// (web/playback/mapbuild-page.js builds the map from them in a worker and
keeps it in IndexedDB). Ported from the trial's work/map-playback/rawcopy.py, its logic unchanged; here it runs in the mod
(the client's Python 2.7 and CPython 3), in steps (copy_steps), on the export thread's 'playback' job (playback.py).

Nothing is computed: bytes are copied as the client stores them; only slices are cut (sections of space.bin, mip levels
of global_am.dds and of the textures, one member of each terrain chunk). Written under CFG/mapraw/:
  <arena>/manifest.js + part-NNN.js   the arena's own inputs (MapRaw.manifest / MapRaw.put(name, base64)), 4 MB a part
  res/<zip crc>-<path crc>-<name>.js  a shared resource (plant, visual model, havok, texture), once by its CRC for every map
  index/                              the packages' directories (one file per package, keyed by its size and mtime) and
                                      the references found in resources (deps.json); a package is read for its directory
                                      only when it is new or changed (a client update)
Measured in the trial (outputs/map-playback-port-research2-2026-11-18.md 12.3): under the client's python27 2.9 s the
first time ever (133 package directories), 0.24 s for a later map; El Hallouf 204 files, 7.2 MB raw.
"""
from __future__ import absolute_import
import io, json, os, re, struct, sys, time, zlib, base64, binascii

PART_BYTES = 4 << 20       # raw bytes per part script (~5.3 MB of base64 text)
INDEX_VERSION = 1
DIRECTORY_LINES = 8000     # index lines read a step (Packages.directory_steps)
# Arenas whose minimap is a rendered top view: the page balances the global colour map on it (the trial's
# mapbuild9.MINIMAP_RENDERED, one table on each side: web/playback/mapbuild9.js has the same).
MINIMAP_RENDERED = ('05_prohorovka',)
COUNT = {'packages scanned (central directory read)': 0, 'packages from the on-disk index': 0,
         'package files opened for reading': 0, 'members read': 0, 'bytes read from packages': 0}


# ---------------------------------------------------------------- zip central directory (own reader: zip64 aware)
def read_directory(path):
    """[(name, local header offset, method, compressed size, size, crc32)] of one zip file."""
    f = open(path, 'rb')
    try:
        f.seek(0, 2); size = f.tell()
        tail = min(size, 65557 + 20)
        f.seek(size - tail); buf = f.read(tail)
        e = buf.rfind(b'PK\x05\x06')
        if e < 0:
            raise ValueError('no end of central directory: %s' % path)
        n, cd_size, cd_off = struct.unpack_from('<HII', buf, e + 10)
        if n == 0xffff or cd_off == 0xffffffff:  # zip64: the locator sits just before the end record
            l = buf.rfind(b'PK\x06\x07', 0, e)
            z64 = struct.unpack_from('<Q', buf, l + 8)[0]
            f.seek(z64); r = f.read(56)
            n, cd_size, cd_off = struct.unpack_from('<QQQ', r, 32)
        f.seek(cd_off); cd = f.read(cd_size)
    finally:
        f.close()
    out, p = [], 0
    for _ in range(n):
        (method, crc, csize, usize, nl, xl, cl) = struct.unpack_from('<10xH4xIIIHHH', cd, p)
        lho = struct.unpack_from('<I', cd, p + 42)[0]
        name = cd[p + 46:p + 46 + nl].decode('utf-8', 'replace')
        if 0xffffffff in (csize, usize, lho):  # zip64 extra field
            x, xe = p + 46 + nl, p + 46 + nl + xl
            while x + 4 <= xe:
                tag, ln = struct.unpack_from('<HH', cd, x)
                if tag == 1:
                    q = x + 4
                    if usize == 0xffffffff: usize = struct.unpack_from('<Q', cd, q)[0]; q += 8
                    if csize == 0xffffffff: csize = struct.unpack_from('<Q', cd, q)[0]; q += 8
                    if lho == 0xffffffff: lho = struct.unpack_from('<Q', cd, q)[0]
                x += 4 + ln
        if not name.endswith('/'):
            out.append((name, lho, method, csize, usize, crc))
        p += 46 + nl + xl + cl
    return out


class Packages(object):
    """The client's packages through an on-disk index (cache/pkgindex2): packages.json holds per package its size,
    mtime and the 2-level path prefixes it contains; <pkg>.idx its directory. A package whose size or mtime changed
    (a client update) is scanned again; the others are never opened for their directory again."""

    def __init__(self, client, index_dir, build=True):
        self.dir = os.path.join(client, 'res', 'packages')
        self.idx_dir = index_dir
        self.meta = {}
        self.dirs = {}
        self.files = {}
        if build:
            for _ in self.scan_steps(): pass

    def scan_steps(self):
        """Read the index; a package new or changed since is read for its directory (one package a step)."""
        index_dir = self.idx_dir
        if not os.path.isdir(index_dir):
            os.makedirs(index_dir)
        p = os.path.join(index_dir, 'packages.json')
        old = {}
        if os.path.isfile(p):
            try:
                with open(p) as f: old = json.load(f)
            except ValueError:
                old = {}
        if old.get('version') != INDEX_VERSION:
            old = {}
        pk = old.get('packages', {})
        changed = False
        for name in sorted(os.listdir(self.dir)):
            if not name.endswith('.pkg'):
                continue
            st = os.stat(os.path.join(self.dir, name))
            m = pk.get(name)
            if m and m['size'] == st.st_size and m['mtime'] == int(st.st_mtime) and os.path.isfile(os.path.join(index_dir, name + '.idx')):
                self.meta[name] = m
                continue
            entries = read_directory(os.path.join(self.dir, name))
            COUNT['packages scanned (central directory read)'] += 1
            prefixes = sorted(set('/'.join(e[0].lower().split('/')[:2]) for e in entries))
            f = io.open(os.path.join(index_dir, name + '.idx'), 'w', encoding='utf-8')
            for e in entries:
                f.write(u'%s\t%d\t%d\t%d\t%d\t%d\n' % e)
            f.close()
            self.meta[name] = dict(size=st.st_size, mtime=int(st.st_mtime), n=len(entries), prefixes=prefixes)
            changed = True
            yield
        if changed or set(pk) != set(self.meta):
            write_text(p, json.dumps(dict(version=INDEX_VERSION, packages=self.meta)))

    def packages_with(self, prefix):
        prefix = prefix.lower()
        return [n for n, m in sorted(self.meta.items()) if prefix in m['prefixes']]

    def directory(self, pkg):
        if pkg not in self.dirs:
            for _ in self.directory_steps(pkg): pass
        return self.dirs[pkg]

    def directory_steps(self, pkg, lines=None):
        """A package's directory read from its index file, yielding every `lines` entries (the largest package's took
        0.4 s in one go under the client's python27, 18.11)."""
        if pkg in self.dirs: return
        lines = lines or DIRECTORY_LINES
        d = {}
        with io.open(os.path.join(self.idx_dir, pkg + '.idx'), encoding='utf-8') as f:
            for n, line in enumerate(f):
                name, lho, method, csize, usize, crc = line.rstrip('\n').split('\t')
                d[name.lower()] = (name, int(lho), int(method), int(csize), int(usize), int(crc))
                if n % lines == lines - 1: yield
        self.dirs[pkg] = d
        COUNT['packages from the on-disk index'] += 1

    def find(self, path):
        """(package, entry) of a client path (first package that has it, by the prefix table)."""
        pre = '/'.join(path.lower().split('/')[:2])
        for pkg in self.packages_with(pre):
            e = self.directory(pkg).get(path.lower())
            if e:
                return pkg, e
        return None, None

    def _file(self, pkg):
        f = self.files.get(pkg)
        if f is None:
            f = self.files[pkg] = open(os.path.join(self.dir, pkg), 'rb')
            COUNT['package files opened for reading'] += 1
        return f

    def read(self, pkg, entry, start=0, length=None):
        """Bytes [start, start + length) of a member (a stored member: read by offset; deflated: inflated whole)."""
        name, lho, method, csize, usize, crc = entry
        f = self._file(pkg)
        f.seek(lho)
        h = f.read(30)
        nl, xl = struct.unpack_from('<HH', h, 26)
        data_at = lho + 30 + nl + xl
        COUNT['members read'] += 1
        if method == 0:
            if length is None:
                length = usize - start
            f.seek(data_at + start)
            b = f.read(length)
        else:
            f.seek(data_at)
            b = zlib.decompressobj(-15).decompress(f.read(csize))
            b = b[start:start + length] if length is not None else b[start:]
        COUNT['bytes read from packages'] += len(b)
        return b

    def close(self):
        for f in self.files.values():
            f.close()


# ---------------------------------------------------------------- a stored zip inside a member (the terrain chunks)
def inner_member(pk, pkg, entry, member):
    """(bytes, crc32) of one member of a zip stored as a package member, reading only its directory and that member."""
    size = entry[4]
    tail = pk.read(pkg, entry, max(0, size - 4096), min(size, 4096))
    e = tail.rfind(b'PK\x05\x06')
    n, cd_size, cd_off = struct.unpack_from('<HII', tail, e + 10)
    cd = pk.read(pkg, entry, cd_off, cd_size)
    p = 0
    for _ in range(n):
        method, crc, csize, usize, nl, xl, cl = struct.unpack_from('<10xH4xIIIHHH', cd, p)
        lho = struct.unpack_from('<I', cd, p + 42)[0]
        name = cd[p + 46:p + 46 + nl].decode('utf-8')
        if name == member:
            h = pk.read(pkg, entry, lho, 30)
            hn, hx = struct.unpack_from('<HH', h, 26)
            b = pk.read(pkg, entry, lho + 30 + hn + hx, csize)
            if method == 8:
                b = zlib.decompressobj(-15).decompress(b)
            return b, crc
        p += 46 + nl + xl + cl
    return None, None


# ---------------------------------------------------------------- packed XML: only what finds activeEnvironment
def packed_text(data, path):
    """Text of the first element at `path` (tags joined by '/') of a BigWorld packed XML (string values only)."""
    if not data.startswith(b'EN\xa1b\x00'):
        return None
    names, pos = [], 5
    while True:
        end = data.index(b'\x00', pos)
        if end == pos:
            pos += 1
            break
        names.append(data[pos:end].decode('utf-8')); pos = end + 1
    want = path.split('/')

    def section(a, depth):
        count, own = struct.unpack_from('<HI', data, a)
        header = a + 6 + count * 6
        offset = own & 0xfffffff
        for i in range(count):
            name, word = struct.unpack_from('<HI', data, a + 6 + i * 6)
            end = word & 0xfffffff
            if names[name] == want[depth]:
                lo, hi = header + offset, header + end
                if depth == len(want) - 1:
                    return data[lo:hi].decode('utf-8') if word >> 28 == 1 else None
                if word >> 28 == 0:
                    return section(lo, depth + 1)
            offset = end
        return None
    return section(pos, 0)


# ---------------------------------------------------------------- round 9: a whole packed XML (only to find references)
class Node(object):
    __slots__ = ('tag', 'text', 'kids')

    def __init__(self, tag):
        self.tag, self.text, self.kids = tag, None, []

    def find(self, path):
        cur = [self]
        for part in path.split('/'):
            cur = [k for e in cur for k in e.kids if k.tag == part]
            if not cur:
                return None
        return cur[0]

    def findtext(self, path):
        e = self.find(path)
        return None if e is None else (e.text or '')

    def walk(self):
        yield self
        for k in self.kids:
            for e in k.walk():
                yield e


def packed_xml(data):
    """A BigWorld packed XML as Node tree; only string values are kept as text (the references are strings)."""
    if not data.startswith(b'EN\xa1b\x00'):
        return None
    names, pos = [], 5
    while True:
        end = data.index(b'\x00', pos)
        if end == pos:
            pos += 1
            break
        names.append(data[pos:end].decode('utf-8')); pos = end + 1

    def value(el, kind, a, b):
        if kind == 0:
            section(el, a, b)
        elif kind == 1:
            el.text = data[a:b].decode('utf-8', 'replace')
        elif kind == 2:   # 19.11: integers and floats too (the rock shader's g_atlasSizes), as packed_xml.decode
            raw = bytearray(data[a:b])
            n = sum(v << (8 * i) for i, v in enumerate(raw))
            el.text = str(n - (1 << (8 * len(raw))) if raw and raw[-1] & 128 else n)
        elif kind == 3:
            el.text = ' '.join(str(struct.unpack_from('<f', data, i)[0]) for i in range(a, b - 3, 4))

    def section(el, a, b):
        count, own = struct.unpack_from('<HI', data, a)
        header = a + 6 + count * 6
        offset = own & 0xfffffff
        value(el, own >> 28, header, header + offset)
        for i in range(count):
            nm, word = struct.unpack_from('<HI', data, a + 6 + i * 6)
            e = word & 0xfffffff
            child = Node(names[nm])
            el.kids.append(child)
            value(child, word >> 28, header + offset, header + e)
            offset = e
    root = Node('root')
    section(root, pos, len(data))
    return root


# ---------------------------------------------------------------- round 9: space.bin sections that name the resources
def vec(d, p):
    size, count = struct.unpack_from('<II', d, p)
    return size, count, p + 8, p + 8 + size * count


def space_strings(d):
    size, n, at, p = vec(d, 0)
    total = struct.unpack_from('<I', d, p)[0]
    base = p + 4
    out = {}
    for i in range(n):
        h, off, ln = struct.unpack_from('<III', d, at + i * size)
        out[h] = d[base + off:base + off + ln].decode('utf-8')
    return out


def space_objects(bsmi, bsmo, st, box):
    """(primitives path, havok path) of every static model instance inside the box, any gameplay (a superset: the
    copy is per arena, the builder picks the gameplay's visibility bit)."""
    s, n, ta, p = vec(bsmi, 0)
    s2, n2, a2, p = vec(bsmi, p)
    s3, n3, va, p = vec(bsmi, p)
    s4, n4, ma, p = vec(bsmi, p)
    p = 0
    p = vec(bsmo, p)[3]; p = vec(bsmo, p)[3]
    bs, bn, ba, p = vec(bsmo, p)
    for _ in range(12):
        p = vec(bsmo, p)[3]
    cs, cn, ca, p = vec(bsmo, p)
    x0, z0, x1, z1 = box
    out = set()
    for i in range(n):
        tx, tz = struct.unpack_from('<f', bsmi, ta + i * s + 48)[0], struct.unpack_from('<f', bsmi, ta + i * s + 56)[0]
        if not (x0 <= tx <= x1 and z0 <= tz <= z1):
            continue
        m = struct.unpack_from('<I', bsmi, ma + i * s4)[0]
        prim = st.get(struct.unpack_from('<I', bsmo, ba + m * bs + 24)[0])
        hh = struct.unpack_from('<I', bsmo, ca + m * cs)[0]
        out.add((prim, st.get(hh) if hh else None))
    return sorted(out, key=lambda x: (x[0] or '', x[1] or ''))


def space_plants(sptr, st, box):
    size, n, at, _ = vec(sptr, 0)
    x0, z0, x1, z1 = box
    out = set()
    for i in range(n):
        x, y, z = struct.unpack_from('<3f', sptr, at + i * size + 48)
        if x0 <= x <= x1 and z0 <= z <= z1:
            out.add(st.get(struct.unpack_from('<I', sptr, at + i * size + 64)[0], '?'))
    return sorted(out)


# objects_visual.texture_of / skip_path, the same rules (the copy step must copy what the builder will read)
SKIP_PREFIX = ('particles/', 'objects/misc/', 'system/')
TEX_MAX = 128          # the builder reads texture mips no larger than this (atlas tiles 128 / 64, leaves 128, bark 64)


class Resources(object):
    """The shared resources of one map (plants, visual models, havok, textures), each copied once into raw/res/ as
    a content-addressed script (<zip crc>-<path crc>-<name>.js): a file already there is neither read nor written
    again; a resource's references (model parent and visual, a visual's textures, an atlas's first tile, a plant's
    textures) are found once and kept in the index folder (deps.json, keyed by path + zip crc)."""

    def __init__(self, pk, res_dir, index_dir):
        self.pk, self.dir = pk, res_dir
        if not os.path.isdir(res_dir):
            os.makedirs(res_dir)
        self.deps_path = os.path.join(index_dir, 'deps.json')
        self.deps = {}
        if os.path.isfile(self.deps_path):
            try: self.deps = json.loads(read_text(self.deps_path))
            except ValueError: self.deps = {}
        self.deps_changed = False
        self.entries = {}       # lower path -> manifest entry
        self.data = {}          # lower path -> bytes read this run
        self.count = dict(resources=0, written=0, alreadyInRawRes=0, bytesRead=0, bytesRaw=0, depsFromCache=0, depsFound=0)

    def entry(self, path):
        pkg, e = self.pk.find(path)
        return pkg, e

    def exists(self, path):
        return self.entry(path)[1] is not None

    def bytes(self, path):
        low = path.lower()
        if low not in self.data:
            pkg, e = self.entry(path)
            self.data[low] = self.pk.read(pkg, e)
            self.count['bytesRead'] += len(self.data[low])
        return self.data[low]

    def add(self, path, texture=False):
        """Copy one resource (once); -> its manifest entry or None when the client has no such file. `texture`: True (the
        mip levels from TEX_MAX px down) or the largest level wanted in px (19.11, the rock stage: a cell of an atlas at
        ROCK_SIZE); a texture already added with smaller levels is copied again with the larger ones (another file)."""
        low = path.lower()
        size = (TEX_MAX if texture is True else int(texture)) if texture else None
        if low in self.entries:
            old = self.entries[low]
            if old is None or size is None or old.get('slice', TEX_MAX) >= size:
                return old
            self.count['resources'] -= 1
            self.count['bytesRaw'] -= old['size'] or 0
            del self.entries[low]
        pkg, e = self.entry(path)
        if e is None:
            self.entries[low] = None
            return None
        name = e[0]
        fn = '%08x-%08x-%s%s.js' % (e[5], binascii.crc32(low.encode('utf-8')) & 0xffffffff, '' if size in (None, TEX_MAX) else '%d-' % size,
                                    re.sub(r'[^A-Za-z0-9_.-]', '_', name.split('/')[-1]))
        ent = dict(path=low, crc=e[5], file=fn, pkg=pkg, sourceSize=e[4])
        if size is not None and size != TEX_MAX:
            ent['slice'] = size
        target = os.path.join(self.dir, fn)
        self.count['resources'] += 1
        if os.path.isfile(target):
            ent['size'] = int(read_text(target + '.size')) if os.path.isfile(target + '.size') else None
            self.count['alreadyInRawRes'] += 1
        else:
            b = self.bytes(path)
            if texture:
                b = dds_slice(b, size)
            write_bytes(target, b'MapRaw.put(' + json.dumps('res:' + low).encode('ascii') + b',"' + base64.b64encode(b) + b'");\n')
            write_text(target + '.size', str(len(b)))
            ent['size'] = len(b)
            self.count['written'] += 1
        self.count['bytesRaw'] += ent['size'] or 0
        self.entries[low] = ent
        return ent

    def refs(self, path, find, kind=None):
        """Cached references of a resource (find(bytes) -> [paths]); the resource itself is added first. `kind` names
        another finder of the same resource (its own cache entry)."""
        ent = self.add(path)
        if ent is None:
            return []
        key = '%s|%08x' % (ent['path'], ent['crc']) + ('|' + kind if kind else '')
        if key in self.deps:
            self.count['depsFromCache'] += 1
            return self.deps[key]
        out = find(self.bytes(path))
        self.deps[key] = out
        self.deps_changed = True
        self.count['depsFound'] += 1
        return out

    def save(self):
        if self.deps_changed:
            write_text(self.deps_path, json.dumps(self.deps, sort_keys=True))


def dds_slice(b, size):
    """A DDS cut to its mip levels from the first no larger than `size` (or the last) down: a DDS of its own (width,
    height and mip count rewritten). Another format than block-compressed: returned whole."""
    if b[:4] != b'DDS ':
        return b
    hdr = bytearray(b[:128])
    h, w = struct.unpack_from('<2I', hdr, 12)
    mips = max(1, struct.unpack_from('<I', hdr, 28)[0])
    flags, four = struct.unpack_from('<I4s', hdr, 80)
    p = 128
    extra = b''
    if four == b'DX10':
        extra = b[128:148]; p = 148
        fmt = struct.unpack_from('<I', b, 128)[0]
        bs = 8 if fmt in (70, 71, 72, 79, 80, 81) else 16
    elif not flags & 4:
        return b
    else:
        bs = 8 if four == b'DXT1' else 16
    ww, hh = w, h
    for level in range(mips):
        nb = max(1, (ww + 3) // 4) * max(1, (hh + 3) // 4) * bs
        if max(ww, hh) <= size or level == mips - 1:
            struct.pack_into('<2I', hdr, 12, hh, ww)
            struct.pack_into('<I', hdr, 28, mips - level)
            return bytes(hdr) + extra + b[p:]
        p += nb; ww, hh = max(1, ww // 2), max(1, hh // 2)
    return b


def model_refs(b):
    m = packed_xml(b)
    if m is None:
        return []
    vis = (m.findtext('nodelessVisual') or m.findtext('nodefullVisual') or '').strip()
    par = (m.findtext('parent') or '').strip()
    return [vis, par]


def visual_textures(b):
    """objects_visual.texture_of per primitive group, before the atlas step: the property it would take."""
    v = packed_xml(b)
    out = []
    if v is None:
        return out
    for rs in [k for k in v.kids if k.tag == 'renderSet']:
        for g in [k for k in rs.kids if k.tag == 'geometry']:
            for pg in [k for k in g.kids if k.tag == 'primitiveGroup']:
                m = pg.find('material')
                if m is None:
                    continue
                props = {}
                for pp in [k for k in m.kids if k.tag == 'property']:
                    tex = pp.findtext('Texture')
                    if tex:
                        props[(pp.text or '').strip()] = tex.strip()
                for k in ('diffuseMap', 'albedoHeightTile0', 'atlasAlbedoHeight', 'diffuseMap2'):
                    if k in props:
                        out.append([k, props[k]])
                        break
    return out


# ---------------------------------------------------------------- 19.11: the rock shader's inputs (objects_visual.Rocks)
ROCK_FX = 'pbs_tiled_atlas_global'
ROCK_SIZE = 128                      # objects_visual.ROCK_SIZE: every layer is copied at the mip where it is 128 px
ROCK_SIZES = (2, 2, 8, 1)            # g_atlasSizes' default (the shader's cbuffer)


def visual_rocks(b):
    """The rock-shader groups' inputs of a visual (objects_visual.Rocks.material reads them): [albedo-height atlas,
    blend mask, global texture, dirt map, cells across the albedo atlas, cells across the blend mask] (the larger of a
    grid's columns and rows: the copy keeps the levels where a cell is ROCK_SIZE px)."""
    v = packed_xml(b)
    out = []
    if v is None:
        return out
    for rs in [k for k in v.kids if k.tag == 'renderSet']:
        for g in [k for k in rs.kids if k.tag == 'geometry']:
            for pg in [k for k in g.kids if k.tag == 'primitiveGroup']:
                m = pg.find('material')
                if m is None or ROCK_FX not in (m.findtext('fx') or '').strip().lower():
                    continue
                props, sizes = {}, list(ROCK_SIZES)
                for pp in [k for k in m.kids if k.tag == 'property']:
                    name = (pp.text or '').strip()
                    tex = pp.findtext('Texture')
                    if tex:
                        props[name] = tex.strip()
                    elif name == 'g_atlasSizes':
                        for ch in pp.kids:
                            if ch.tag in ('Vector4', 'Float', 'Int', 'Bool'):
                                try:
                                    f = [float(x) for x in (ch.text or '').split()]
                                    sizes = f + sizes[len(f):]
                                except ValueError:
                                    sizes = list(ROCK_SIZES)
                cols, rows, bcols, brows = [max(1, int(round(x))) for x in sizes[:4]]
                item = [props.get('atlasAlbedoHeight') or '', props.get('atlasBlend') or '', props.get('globalTex') or '',
                        props.get('dirtMap') or '', max(cols, rows), max(bcols, brows)]
                if item not in out:
                    out.append(item)
    return out


def dds_of(R, path):
    """objects_visual._dds_of: a material's texture path (.png / .dds as named) -> the .dds the packages have, or None."""
    if not path:
        return None
    base = path.rsplit('.', 1)[0]
    if '/' not in base:
        return None
    for cand in (base + '.dds', base.rsplit('/', 1)[0] + '/dds/' + base.rsplit('/', 1)[1] + '.dds'):
        if R.exists(cand):
            return cand
    return None


def atlas_tiles(R, data):
    """objects_visual.atlas_tiles: every tile texture an .atlas_processed lists (u32 1, W, H, 1, then per tile x0, x1,
    y0, y1 and a zero-ended path)."""
    out = []
    if not data or len(data) <= 16:
        return out
    p = 16
    while p + 16 < len(data):
        x0, x1 = struct.unpack_from('<2I', data, p)
        p += 16
        e = data.find(b'\0', p)
        if e < 0:
            break
        name = data[p:e].decode('ascii', 'replace')
        p = e + 1
        dd = dds_of(R, name)
        if dd and x1 > x0 and dd not in out:
            out.append(dd)
    return out


def rock_textures(R, item):
    """Copy what the rock stage reads for one rock material: the atlas' tiles (an .atlas) or the atlas texture (a .dds,
    at the levels where a cell is ROCK_SIZE px), the blend mask (likewise), the global texture and the dirt map."""
    alb, blend, glob, dirt, grid, bgrid = item
    if alb.lower().endswith('.atlas'):
        ap = alb.rsplit('.', 1)[0] + '.atlas_processed'
        if R.exists(ap):
            for t in R.refs(ap, lambda b: atlas_tiles(R, b), 'rock-tiles'):
                R.add(t, texture=ROCK_SIZE)
    elif alb:
        d = dds_of(R, alb)
        if d:
            R.add(d, texture=ROCK_SIZE * grid)
    for p, size in ((blend, ROCK_SIZE * bgrid), (glob, ROCK_SIZE), (dirt, ROCK_SIZE)):
        d = dds_of(R, p)
        if d:
            R.add(d, texture=size)


def collect_resources(R, objects, plants):
    """Every file the builder will read for these objects and plants (objects_visual.build, build.build_statics,
    build.plant_kind): visual LOD chains, their geometry and colour textures, the rock shader's textures (19.11,
    rock_textures), havok, .srt and their textures. A generator:
    it yields after each object and plant kind."""
    for prim, hav in objects:
        yield
        if hav:
            R.add(hav)
        if not prim or not prim.endswith('.primitives') or prim.lower().startswith(SKIP_PREFIX) or 'null_model' in prim.lower():
            continue
        stem = prim.rsplit('.', 1)[0]
        R.add(stem + '.visual_processed')
        seen = set()
        while stem and stem.lower() not in seen:
            seen.add(stem.lower())
            r = R.refs(stem + '.model', model_refs)
            if not r:
                break
            vs = r[0] or stem
            R.add(vs + '.primitives_processed')
            for kind, tex in R.refs(vs + '.visual_processed', visual_textures):
                if kind == 'atlasAlbedoHeight':
                    for t in R.refs(tex.rsplit('.', 1)[0] + '.atlas_processed', lambda b, tex=tex: atlas_tile(R, b)) if R.exists(tex.rsplit('.', 1)[0] + '.atlas_processed') else ([tex] if tex.lower().endswith('.dds') and R.exists(tex) else []):
                        R.add(t, texture=True)
                else:
                    R.add(tex, texture=True)
            for item in R.refs(vs + '.visual_processed', visual_rocks, 'rock1'):   # 19.11: the rock shader's inputs
                rock_textures(R, item)
            stem = r[1]
    for path in plants:
        yield
        if R.add(path) is None:
            continue
        folder = path.rsplit('/', 1)[0]
        for n in R.refs(path, lambda b: sorted(set(m.decode('ascii') for m in re.findall(br'([A-Za-z0-9_\-]+_AM\.dds)\x00', b) if b'billboard' not in m.lower()))):
            R.add(folder + '/' + n, texture=True)
    for p in ('scripts/destructibles.xml', 'vegetation/bushes.xml'):
        R.add(p)


def atlas_tile(R, data):
    """objects_visual.atlas_first_tile: the first tile texture an .atlas_processed lists."""
    i = data.find(b'content/')
    if i < 0:
        return []
    name = data[i:data.find(b'\0', i)].decode('ascii', 'replace').rsplit('.', 1)[0] + '.dds'
    for cand in (name, name.rsplit('/', 1)[0] + '/dds/' + name.rsplit('/', 1)[1]):
        if R.exists(cand):
            return [cand]
    return []


# ---------------------------------------------------------------- the default view's raw set
# terrain table + bbox, water bodies, user data objects (spawn points); round 9: strings, static models and their
# placements, speed trees, destructibles' table
SPACE_SECTIONS = ('BWT2', 'BWWa', 'UDOS', 'BWST', 'BSMI', 'BSMO', 'SpTr', 'WGDE', 'WTCP')  # WTCP: the base circles (19.11)
GLOBAL_LEVELS = 3                          # global_am.dds: the 2048, 1024 and 512 levels


def collect(pk, arena, minimap, out, found):
    """The arena's default-view inputs appended to `out` as (name, bytes, source dict); `found` gets the 'objects' and
    'plants' inside the terrain box. A generator: it yields every 32 terrain chunks and after them."""
    sp = 'spaces/%s/' % arena
    pkgs = pk.packages_with('spaces/' + arena.lower())
    if not pkgs:
        raise RuntimeError('no package holds %s' % sp)

    def get(path, required=True):
        pkg, e = pk.find(path)
        if e is None and required:
            raise RuntimeError('not in the packages: %s' % path)
        return pkg, e
    for pkg in pkgs:
        for _ in pk.directory_steps(pkg): yield
    # terrain chunks: only terrain2/heights of each <x><z>o.cdata_processed (16-bit hex x, z)
    chunks = []
    for pkg in pkgs:
        for low, e in sorted(pk.directory(pkg).items()):
            rest = low[len(sp):] if low.startswith(sp) else None
            if rest and len(rest) == 25 and rest.endswith('o.cdata_processed'):
                chunks.append((pkg, e, rest[:8]))
    for pkg, e, xz in chunks:
        b, crc = inner_member(pk, pkg, e, 'terrain2/heights')
        if b is None:
            continue
        out.append(('chunk/%s/heights' % xz, b, dict(path=e[0], pkg=pkg, crc=e[5], member='terrain2/heights', memberCrc=crc)))
        if len(out) % 32 == 0: yield
    yield
    # space.bin: the table of contents, then only the sections the builder reads
    pkg, e = get(sp + 'space.bin')
    head = pk.read(pkg, e, 0, 24)
    assert head[:4] == b'BWTB', head[:4]
    n = struct.unpack_from('<I', head, 20)[0]
    toc = pk.read(pkg, e, 24, 24 * n)
    secs = {}
    for i in range(n):
        m, v, o, l = struct.unpack_from('<4sIQQ', toc, 24 * i)
        m = m.decode('ascii')
        if m in SPACE_SECTIONS:
            secs[m] = pk.read(pkg, e, o, l)
            out.append(('space.bin/' + m, secs[m], dict(path=e[0], pkg=pkg, crc=e[5], section=m, version=v, offset=o)))
            yield
    # round 9: the objects and plants inside the terrain box (spacebin.bwt2's bbox + build.MARGIN), any gameplay
    b2 = secs['BWT2']
    q = 4 + 32
    q += 8 + struct.unpack_from('<I', b2, q)[0] * struct.unpack_from('<I', b2, q + 4)[0]
    q += 8 + struct.unpack_from('<I', b2, q)[0] * struct.unpack_from('<I', b2, q + 4)[0]
    bb = struct.unpack_from('<4f', b2, q + 4 + 128 - 16)
    box = (bb[0] - 60.0, bb[1] - 60.0, bb[2] + 60.0, bb[3] + 60.0)
    st = space_strings(secs['BWST'])
    yield
    found['objects'] = space_objects(secs['BSMI'], secs['BSMO'], st, box)
    yield
    found['plants'] = space_plants(secs['SpTr'], st, box)
    yield
    for name in ('space.settings',):
        pkg, e = get(sp + name, False)
        if e:
            out.append((name, pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5])))
    # environment: environments.xml names the active one
    pkg, e = get(sp + 'environments/environments.xml')
    env = pk.read(pkg, e)
    out.append(('environments.xml', env, dict(path=e[0], pkg=pkg, crc=e[5])))
    guid = packed_text(env, 'activeEnvironment').strip().replace('.', '-')
    pkg, e = get(sp + 'environments/%s/environment.xml' % guid)
    out.append(('environment.xml', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5], guid=guid)))
    # the arena definition (bases, control point, spawns per gameplay)
    pkg, e = get('scripts/arena_defs/%s.xml' % arena)
    out.append(('arena_defs.xml', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5])))
    yield
    # global colour map: header + the levels from 2048 down (a DDS of its own: width, height, mip count rewritten)
    pkg, e = get(sp + 'global_am.dds')
    hdr = bytearray(pk.read(pkg, e, 0, 128))
    h, w = struct.unpack_from('<2I', hdr, 12)
    mips = max(1, struct.unpack_from('<I', hdr, 28)[0])
    four = bytes(hdr[84:88])
    bs = 8 if four == b'DXT1' else 16
    p, ww, hh, first, lv = 128, w, h, None, 0
    for level in range(mips):
        nb = max(1, (ww + 3) // 4) * max(1, (hh + 3) // 4) * bs
        if first is None and max(ww, hh) <= 2048:
            first, fw, fh, start = level, ww, hh, p
        if first is not None and lv < GLOBAL_LEVELS:
            lv += 1; end = p + nb
        p += nb; ww, hh = max(1, ww // 2), max(1, hh // 2)
    struct.pack_into('<2I', hdr, 12, fh, fw)
    struct.pack_into('<I', hdr, 28, lv)
    out.append(('global_am.dds', bytes(hdr) + pk.read(pkg, e, start, end - start),
                dict(path=e[0], pkg=pkg, crc=e[5], sourceSize=w, firstLevel=first, levels=lv)))
    if minimap:
        pkg, e = get(sp + 'mmap.dds')
        out.append(('mmap.dds', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5])))


def write_set(arena, files, out_dir, res=None):
    """The arena's part scripts, then its manifest (written last: a page that finds the manifest finds every part). A
    generator: it yields after each part."""
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    parts, cur, cur_n = [], [], 0
    for name, b, src in files:
        if cur and cur_n + len(b) > PART_BYTES:
            parts.append(cur); cur, cur_n = [], 0
        cur.append((name, b, src)); cur_n += len(b)
    if cur:
        parts.append(cur)
    manifest = dict(arena=arena, version=2, files=[], parts=[], made=time.strftime('%Y-%m-%d %H:%M:%S'))
    for i, part in enumerate(parts):
        pname = 'part-%03d.js' % i
        chunks = []
        for name, b, src in part:
            chunks.append(b'MapRaw.put(' + json.dumps(name).encode('ascii') + b',"' + base64.b64encode(b) + b'");\n')
            m = dict(name=name, size=len(b), part=i, crc=binascii.crc32(b) & 0xffffffff)
            m.update(src)
            manifest['files'].append(m)
        write_bytes(os.path.join(out_dir, pname), b''.join(chunks))
        manifest['parts'].append(pname)
        yield
    if res is not None:
        manifest['res'] = [e for k, e in sorted(res.items()) if e]
        manifest['resDir'] = '../res/'
    js = 'MapRaw.manifest(' + json.dumps(manifest, separators=(',', ':'), sort_keys=True) + ');\n'
    write_bytes(os.path.join(out_dir, 'manifest.js'), js.encode('utf-8'))


def write_bytes(path, data):
    """The file replaced whole: written beside it, then moved over it (a reader never sees half of it)."""
    temp = path + '.tmp'
    with open(temp, 'wb') as f: f.write(data)
    if os.path.exists(path): os.remove(path)
    os.rename(temp, path)


def write_text(path, text):
    write_bytes(path, text if isinstance(text, bytes) else text.encode('utf-8'))


def read_text(path):
    with open(path, 'rb') as f: return f.read().decode('utf-8')


def manifest_path(root, arena):
    return os.path.join(root, arena, 'manifest.js')


def copy_steps(client, root, arena, report):
    """The whole copy of one arena into `root` (CFG/mapraw): the package index, the arena's own inputs, the shared
    resources, the parts and the manifest. A generator (the export thread's slices); `report` gets the counts."""
    started = time.time()
    for key in COUNT: COUNT[key] = 0
    index_dir = os.path.join(root, 'index')
    pk = Packages(client, index_dir, build=False)
    try:
        for _ in pk.scan_steps(): yield
        files, found = [], {}
        for _ in collect(pk, arena, arena in MINIMAP_RENDERED, files, found): yield
        # the directories the resources are found in, read in steps first (by the prefixes of their paths)
        prefixes = set('/'.join(p.lower().split('/')[:2]) for o in found['objects'] for p in o if p)
        prefixes.update('/'.join(p.lower().split('/')[:2]) for p in found['plants'] if p)
        for pkg in sorted(set(n for pre in prefixes for n in pk.packages_with(pre))):
            for _ in pk.directory_steps(pkg): yield
        R = Resources(pk, os.path.join(root, 'res'), index_dir)
        for _ in collect_resources(R, found['objects'], found['plants']): yield
        R.save()
    finally:
        pk.close()
    for _ in write_set(arena, files, os.path.join(root, arena), R.entries): yield
    report.update(arena=arena, seconds=round(time.time() - started, 3), files=len(files), resources=dict(R.count),
                  rawBytes=sum(len(b) for _, b, _ in files), counts=dict(COUNT))
