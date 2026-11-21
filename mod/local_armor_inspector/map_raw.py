# -*- coding: utf-8 -*-
"""The raw files of one map for the page's 3D replay player (BACKLOG 104, 18.11.2026): copied out of the client's packages
as classic scripts the page can load under file:// (web/playback/mapbuild-page.js builds the map from them in a worker and
keeps it in IndexedDB). Ported from the trial's work/map-playback/rawcopy.py, its choice of files unchanged; here it runs
in the mod (the client's Python 2.7 and CPython 3), in steps (copy_steps), on the export thread's 'mapraw' job, which the
page asks for only when its IndexedDB lacks the map (exporter.request_map_raw).

Nothing is computed: bytes are copied as the client stores them; only slices are cut (sections of space.bin, mip levels
of global_am.dds and of the textures - a stored texture is read from its first wanted level on, nothing before it -, one
member of each terrain chunk). Written under CFG/mapraw/:
  <arena>/part-NNN.js + manifest.js   the arena's own inputs and every resource its objects and plants read (plant, visual
                                      model, havok, texture), PART_BYTES of raw bytes a part (MapRaw.put(name, base64)),
                                      the manifest last (MapRaw.manifest); made in <arena>.tmp/ and renamed at the end
  index/                              the packages' directories as one sorted table (entries.bin: path hashes and
                                      the zip entries, Index), the terrain chunks' names (chunks.txt) and the references
                                      found in resources (deps.json); made again only when a package's size or mtime
                                      changed (a client update)
19.11 profile under the client's python27 on the stand: the per-resource files (two of them each) and the per-package text
index were most of the 8-19 s the game spent; one table and few large parts replace them.
"""
from __future__ import absolute_import
import array, bisect, io, json, math, os, re, shutil, struct, sys, time, zlib, base64, binascii

PART_BYTES = 8 << 20       # raw bytes per part script (~11 MB of base64 text)
INDEX_VERSION = 3
MANIFEST_VERSION = 4       # of <arena>/manifest.js; an older one is copied again (exporter.request_map_raw); 4 (21.11): scenario.json
HASH_STEP = 20000          # index entries hashed a step (Packages.build_steps)
SORT_BITS = 6              # the table sorted in 2**SORT_BITS runs, a run a step (Packages.build_steps)
# Arenas whose minimap is a rendered top view: the page balances the global colour map on it (the trial's
# mapbuild9.MINIMAP_RENDERED, one table on each side: web/playback/mapbuild9.js has the same).
MINIMAP_RENDERED = ('05_prohorovka',)
COUNT = {'packages scanned (central directory read)': 0, 'index read': 0,
         'package files opened for reading': 0, 'members read': 0, 'bytes read from packages': 0}
if sys.version_info[0] >= 3:
    xrange = range


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


def path_key(low):
    """The index's key of a lower-case client path: crc32 << 32 | adler32 of its UTF-8 (490 698 paths of the 2.4.1.1
    client, no two alike, 19.11)."""
    b = low.encode('utf-8') if not isinstance(low, bytes) else low
    return (binascii.crc32(b) & 0xffffffff) << 32 | (zlib.adler32(b) & 0xffffffff)


FIELDS = (('k1', 'I'), ('k2', 'I'), ('lho', 'I'), ('csize', 'I'), ('usize', 'I'), ('crc', 'I'), ('pkg', 'H'), ('method', 'B'))


class Packages(object):
    """The client's packages through one on-disk table (index/entries.bin: every member's path key, package, offset,
    method, sizes and CRC, sorted by key; packages.json the packages' sizes and mtimes; chunks.txt the terrain chunks'
    names). A package whose size or mtime changed (a client update) makes the table again; else it is read in one go
    (12 MB, arrays) and a path is found by bisection."""

    def __init__(self, client, index_dir, build=True):
        self.dir = os.path.join(client, 'res', 'packages')
        self.idx_dir = index_dir
        self.names = []
        self.cols = None
        self.chunk_names = None
        self.files = {}
        if build:
            for _ in self.scan_steps(): pass

    def scan_steps(self):
        """Read the table, or make it again when a package is new or changed (one package's directory a step)."""
        if not os.path.isdir(self.idx_dir):
            os.makedirs(self.idx_dir)
        meta_path = os.path.join(self.idx_dir, 'packages.json')
        old = {}
        if os.path.isfile(meta_path):
            try:
                with open(meta_path) as f: old = json.load(f)
            except ValueError:
                old = {}
        now = {}
        for name in sorted(os.listdir(self.dir)):
            if name.endswith('.pkg'):
                st = os.stat(os.path.join(self.dir, name))
                now[name] = [st.st_size, int(st.st_mtime)]
        if (old.get('version') == INDEX_VERSION and old.get('packages') == now
                and os.path.isfile(os.path.join(self.idx_dir, 'entries.bin'))):
            self.names = old['order']
            self.load(old['count'])
            return
        for _ in self.build_steps(sorted(now)): yield
        write_text(meta_path, json.dumps(dict(version=INDEX_VERSION, packages=now, order=self.names, count=len(self.cols['k1']))))

    def load(self, n):
        cols = {}
        with open(os.path.join(self.idx_dir, 'entries.bin'), 'rb') as f:
            for key, code in FIELDS:
                a = array.array(code)
                a.fromfile(f, n)
                cols[key] = a
        self.cols = cols
        COUNT['index read'] += 1

    def build_steps(self, names):
        """Every package's directory into the table: read and hashed in steps, sorted in SORT_BUCKETS runs by the top
        bits of the path's crc32 (a run a step; the runs in bucket order are the whole table in key order), written a
        column a step. 19.11: one sort of all 490k keys was a single C call of 0.24 s on the stand's python27 - the
        interpreter lock held, the game stood still for it; a run is a few ms (the longest step of the build 0.03 s)."""
        self.names = list(names)
        raw = dict((key, array.array(code)) for key, code in FIELDS)
        chunks = []
        for pid, name in enumerate(self.names):
            entries = read_directory(os.path.join(self.dir, name))
            COUNT['packages scanned (central directory read)'] += 1
            yield
            for at in xrange(0, len(entries), HASH_STEP):
                part = entries[at:at + HASH_STEP]
                lows = [e[0].lower().encode('utf-8') for e in part]
                raw['k1'].extend([binascii.crc32(b) & 0xffffffff for b in lows])
                raw['k2'].extend([zlib.adler32(b) & 0xffffffff for b in lows])
                raw['lho'].extend([e[1] for e in part])
                raw['method'].extend([e[2] for e in part])
                raw['csize'].extend([e[3] for e in part])
                raw['usize'].extend([e[4] for e in part])
                raw['crc'].extend([e[5] for e in part])
                raw['pkg'].extend([pid] * len(part))
                chunks.extend(e[0] for e in part if e[0].endswith('o.cdata_processed') and e[0].lower().startswith('spaces/'))
                yield
        n = len(raw['k1'])
        k1, k2 = raw['k1'], raw['k2']
        shift = 32 - SORT_BITS
        runs = [[] for _ in xrange(1 << SORT_BITS)]
        for at in xrange(0, n, HASH_STEP):
            for i in xrange(at, min(n, at + HASH_STEP)):
                runs[k1[i] >> shift].append(k1[i] << 52 | k2[i] << 20 | i)   # i < 2**20
            yield
        cols = dict((key, array.array(code)) for key, code in FIELDS)
        for run in runs:
            run.sort()
            order = [v & 0xfffff for v in run]
            for key, _ in FIELDS:
                col = raw[key]
                cols[key].extend(array.array(cols[key].typecode, [col[i] for i in order]))
            yield
        del runs, raw
        self.cols = cols
        temp = os.path.join(self.idx_dir, 'entries.bin.tmp')
        with open(temp, 'wb') as f:
            for key, code in FIELDS:
                cols[key].tofile(f)
                yield
        target = os.path.join(self.idx_dir, 'entries.bin')
        if os.path.exists(target): os.remove(target)
        os.rename(temp, target)
        write_text(os.path.join(self.idx_dir, 'chunks.txt'), u'\n'.join(sorted(chunks)) + u'\n')
        yield

    def find(self, path):
        """(package, entry) of a client path; entry = (lower path, local header offset, method, compressed size,
        size, crc32), or (None, None)."""
        low = path.lower()
        key = path_key(low)
        h, l = key >> 32, key & 0xffffffff
        c = self.cols
        k1, k2 = c['k1'], c['k2']
        i = bisect.bisect_left(k1, h)
        n = len(k1)
        while i < n and k1[i] == h:
            if k2[i] == l:
                return (self.names[c['pkg'][i]], (low, c['lho'][i], c['method'][i], c['csize'][i], c['usize'][i], c['crc'][i]))
            i += 1
        return None, None

    def chunks(self, arena):
        """The terrain chunks' paths of one arena (spaces/<arena>/<x><z>o.cdata_processed), as the packages name them."""
        if self.chunk_names is None:
            with io.open(os.path.join(self.idx_dir, 'chunks.txt'), encoding='utf-8') as f:
                self.chunk_names = [line.rstrip('\n') for line in f if line.strip()]
        sp = ('spaces/%s/' % arena).lower()
        return [p for p in self.chunk_names if p.lower().startswith(sp) and len(p) - len(sp) == 25]

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
        self.files = {}


class Parts(object):
    """The part scripts of one arena: a resource or an arena input goes into the current part, a part is written when
    the next would pass PART_BYTES. -> the part's number of each."""

    def __init__(self, out_dir):
        self.dir, self.cur, self.n, self.names, self.written = out_dir, [], 0, [], 0
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)

    def put(self, name, b):
        if self.cur and self.n + len(b) > PART_BYTES:
            self.flush()
        self.cur.append(b'MapRaw.put(' + json.dumps(name).encode('ascii') + b',"' + base64.b64encode(b) + b'");\n')
        self.n += len(b)
        return len(self.names)

    def flush(self):
        if not self.cur:
            return
        pname = 'part-%03d.js' % len(self.names)
        data = b''.join(self.cur)
        write_bytes(os.path.join(self.dir, pname), data)
        self.written += len(data)
        self.names.append(pname)
        self.cur, self.n = [], 0


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
        elif kind == 4:   # 19.11: kinds 4 and 5 as the page's builder reads them (mapbuild.js packedXml)
            el.text = 'true' if b > a else 'false'
        elif kind == 5:   # base64: a visual's block name 'vertices' is stored as those six bytes
            el.text = base64.b64encode(data[a:b]).decode('ascii')

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


def space_text(raw):
    """A string of space.bin's table. UTF-8 as a rule; 95_lost_city_ctf (20.11.2026) carries a name in a one-byte
    Cyrillic code page (byte 0xd1 where UTF-8 wants a continuation) - one such string must not stop the whole map."""
    try: return raw.decode('utf-8')
    except UnicodeDecodeError:
        try: return raw.decode('cp1251', 'replace')
        except LookupError: return raw.decode('latin-1')


def space_strings(d):
    size, n, at, p = vec(d, 0)
    total = struct.unpack_from('<I', d, p)[0]
    base = p + 4
    out = {}
    for i in range(n):
        h, off, ln = struct.unpack_from('<III', d, at + i * size)
        out[h] = space_text(d[base + off:base + off + ln])
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


# ---------------------------------------------------------------- 21.11: map scenarios (the game's random events)
# A scenario (a building bombed, a plane crashing, ...) is not in BSMI: space.bin's GOBJ places a CGF prefab (JSON) whose
# tree holds, per part (a '*_complete' prefab), a '*_normal.prefab' (standing) and a '*_destroyed.prefab' (ruin) state
# besides the collapse itself; the replay switches a part by its state entities (outputs/map-random-events-2026-11-21.md).
SCENARIO_PREFIX = 'content/cgfprefabs/map_scenarios/'


def space_game_objects(gobj, st):
    """space.bin GOBJ's first vector: [(prefab path, gameplay visibility mask, 4x4 transform in BSMI's layout)]; an
    88-byte element = transform (64 B, translation at floats 12-14), the object's uuid (16 B), u32 mask, u32 BWST hash
    of the prefab path (measured 21.11.2026 on the 15 maps with scenarios)."""
    size, n, at, _ = vec(gobj, 0)
    out = []
    if size < 88:
        return out
    for i in range(n):
        q = at + i * size
        mask, h = struct.unpack_from('<II', gobj, q + 80)
        out.append((st.get(h), mask, list(struct.unpack_from('<16f', gobj, q))))
    return out


def prefab_json(raw):
    """A CGF prefab's JSON (UTF-8, a BOM allowed; a one-byte code page read as space_text does)."""
    if raw[:3] == b'\xef\xbb\xbf':
        raw = raw[3:]
    return json.loads(space_text(raw))


def euler_matrix(pos, rot, scale):
    """4x4 (column vectors) of a cgf::TransformComponent: R = Ry(y) Rx(x) Rz(z), angles in degrees, then the scale.
    The order and signs are measured: 9 of 9 server hit points of the 20.11 Lost City replay lie on the collision mesh
    composed so (largest distance < 0.5 mm; the other 11 orders / signs miss by up to 0.33 m)."""
    x, y, z = [math.radians(a) for a in rot]
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    r = [[cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
         [cx * sz, cx * cz, -sx],
         [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx]]
    return [[r[0][0] * scale[0], r[0][1] * scale[1], r[0][2] * scale[2], pos[0]],
            [r[1][0] * scale[0], r[1][1] * scale[1], r[1][2] * scale[2], pos[1]],
            [r[2][0] * scale[0], r[2][1] * scale[1], r[2][2] * scale[2], pos[2]],
            [0.0, 0.0, 0.0, 1.0]]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def local_transform(comps):
    """The object's own matrix: its cgf::TransformComponent and the reference's overrides ('.../position/x')."""
    t = comps.get('cgf::TransformComponent') if isinstance(comps, dict) else None
    t = t if isinstance(t, dict) else {}
    parts = {'position': dict(t.get('position') or {}), 'rotation': dict(t.get('rotation') or {}),
             'scale': dict(t.get('scale') or {})}
    if isinstance(comps, dict):
        for k, v in comps.items():
            if k.startswith('cgf::TransformComponent/'):
                bits = k.split('/')
                if len(bits) == 3 and bits[1] in parts:
                    parts[bits[1]][bits[2]] = v
    p, r, s = parts['position'], parts['rotation'], parts['scale']
    return euler_matrix([float(p.get(a, 0.0)) for a in 'xyz'], [float(r.get(a, 0.0)) for a in 'xyz'],
                        [float(s.get(a, 1.0)) for a in 'xyz'])


def scenario_instances(read, path, mask, t, counts):
    """The standing and ruin models of one scenario prefab: [dict(part, state 'normal' | 'ruin', name (the state
    prefab's file name, as the replay names its entity), model, collider (the mesh collider's model or None), m (16
    floats, BSMI's layout), mask)]. `read(path)` gives a client file's bytes or None. A standing model under an inactive
    object (SelfInactive) is not drawn standing; a ruin's own reference is inactive by design. A part without both
    states (a moving train) is left out and counted."""
    world = [[t[4 * c + r] for c in range(4)] for r in range(4)]
    out = []

    def walk(o, m, part, state, name, off):
        comps = o.get('components') or {}
        m = mat_mul(m, local_transform(comps))
        if 'SelfInactive' in (o.get('flags') or []):
            off = True
        ref = o.get('prefab')
        if ref:
            low = ref.rsplit('/', 1)[-1].lower()
            if low.endswith('_normal.prefab'):
                state, name = 'normal', low
                if off: state = 'inactive'
            elif low.endswith('_destroyed.prefab'):
                state, name, off = 'ruin', low, False
            elif '_complete' in low:
                part = low[:-len('.prefab')] if low.endswith('.prefab') else low
            raw = read(ref)
            if raw is None:
                counts['prefabs missing'] = counts.get('prefabs missing', 0) + 1
            else:
                walk(prefab_json(raw).get('objects') or {}, m, part, state, name, off)
        dm = comps.get('BW::DynamicModel') if isinstance(comps, dict) else None
        if isinstance(dm, dict) and dm.get('modelName') and state in ('normal', 'ruin'):
            if state == 'normal' and off:
                counts['standing models inactive'] = counts.get('standing models inactive', 0) + 1
            else:
                col = None
                for cd in ((comps.get('BW::Colliders') or {}).get('colliders') or []):
                    if isinstance(cd, dict) and cd.get('__ctype__') == 'BW::MeshColliderDesc':
                        col = (cd.get('__cvalue__') or {}).get('modelName') or None
                out.append(dict(part=part, state=state, name=name, model=dm['modelName'], collider=col,
                                m=[round(m[r][c], 5) for c in range(4) for r in range(4)], mask=mask))
        for ch in o.get('children') or []:
            walk(ch, m, part, state, name, off)
    raw = read(path)
    if raw is None:
        counts['prefabs missing'] = counts.get('prefabs missing', 0) + 1
        return []
    root = prefab_json(raw).get('objects') or {}
    walk(root, world, root.get('name') or path.rsplit('/', 1)[-1], None, None, False)
    have = {}
    for it in out:
        have.setdefault(it['part'], set()).add(it['state'])
    keep = [it for it in out if have[it['part']] == set(('normal', 'ruin'))]
    dropped = [p for p, s in have.items() if s != set(('normal', 'ruin'))]
    if dropped:
        counts['parts without both states (left out)'] = counts.get('parts without both states (left out)', 0) + len(dropped)
    return keep


def space_scenarios(pk, gobj, st):
    """Every scenario of the space (GOBJ prefabs under content/CGFPrefabs/Map_scenarios/) with its instances; and the
    counts for the copy's report."""
    counts = {}
    scen = []

    def read(path):
        pkg, e = pk.find(path)
        return pk.read(pkg, e) if e is not None else None
    for path, mask, t in space_game_objects(gobj, st) if gobj else []:
        if not path or not path.lower().startswith(SCENARIO_PREFIX):
            continue
        items = scenario_instances(read, path, mask, t, counts)
        if not items:
            counts['scenarios without standing and ruin models (left out)'] = counts.get('scenarios without standing and ruin models (left out)', 0) + 1
            continue
        scen.append(dict(path=path, mask=mask, parts=len(set(it['part'] for it in items)),
                         normal=sum(1 for it in items if it['state'] == 'normal'),
                         ruin=sum(1 for it in items if it['state'] == 'ruin'), instances=items))
    return scen, counts


def scenario_objects(pk, scen):
    """(primitives path, havok path) of the scenarios' models, as space_objects gives the BSMI ones (one copy of them)."""
    out = set()
    for s in scen:
        for it in s['instances']:
            stem = it['model'][:-len('.model')] if it['model'].lower().endswith('.model') else it['model']
            hav = None
            if it['collider']:
                cs = it['collider'][:-len('.model')] if it['collider'].lower().endswith('.model') else it['collider']
                if pk.find(cs + '.havok')[1] is not None:
                    hav = cs + '.havok'
            it['prim'], it['havok'] = stem + '.primitives', hav
            out.add((it['prim'], hav))
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
    """The resources of one map (plants, visual models, havok, textures), each copied once into the arena's parts
    (Parts) under the name 'res:<path>' ('res:<path>@<px>' for a texture cut at another level than TEX_MAX); a
    resource's references (model parent and visual, a visual's textures, an atlas's first tile, a plant's textures) are
    found once and kept in the index folder (deps.json, keyed by path + zip crc).
    `held`: the page's word on what its IndexedDB holds (19.11) - the FNV-1a hashes of its builder's product keys
    (mapbuild9.js Products.key: '<type>|<path>|<zip crc>[|<extra>]|<resv>'); a resource whose every product the builder
    would read is held is listed in the manifest (path, crc, held) but not copied. The rock shader's inputs are read raw
    by the builder (no product of their own): always copied."""

    def __init__(self, pk, parts, index_dir, held=None, resv=None, whole_only=False):
        self.pk, self.parts, self.whole_only = pk, parts, whole_only
        self.held, self.resv = held or set(), resv
        self.deps_path = os.path.join(index_dir, 'deps2.json')   # 2: packed XML kinds 4, 5 read (19.11)
        self.deps = {}
        if os.path.isfile(self.deps_path):
            try: self.deps = json.loads(read_text(self.deps_path))
            except ValueError: self.deps = {}
        self.deps_changed = False
        self.entries = {}       # lower path -> manifest entry
        self.found = {}         # lower path -> (package, entry)
        self.last = (None, None)  # the last whole resource read: its references are found on the same bytes
        self.count = dict(resources=0, bytesRead=0, bytesRaw=0, depsFromCache=0, depsFound=0, texturesCut=0, held=0,
                          heldSourceBytes=0)

    def key(self, kind, path, extra=None):
        """The builder's product key of a resource (Products.key), or None when the client has no such file."""
        e = self.entry(path)[1]
        if e is None or self.resv is None:
            return None
        return u'%s|%s|%d%s|%s' % (kind, e[0], e[5], u'' if extra is None else u'|%s' % extra, self.resv)

    def covered(self, cover):
        """True when the page holds every product of `cover` (a list of keys; a tuple inside it: any one of them)."""
        if not cover or not self.held:
            return False
        for k in cover:
            alts = k if isinstance(k, tuple) else (k,)
            if not any(a is not None and fnv(a) in self.held for a in alts):
                return False
        return True

    def lod_cover(self, vs):
        """The products of one visual LOD (mapbuild9.js lodInfo, lodGeometry): its groups and its geometry."""
        pe = self.entry(vs + '.primitives_processed')[1]
        if pe is None:
            return None
        return [self.key('lod', vs + '.visual_processed', pe[5]), self.key('geo', vs + '.visual_processed', pe[5])]

    def entry(self, path):
        low = path.lower()
        got = self.found.get(low)
        if got is None:
            got = self.found[low] = self.pk.find(low)
        return got

    def exists(self, path):
        return self.entry(path)[1] is not None

    def bytes(self, path):
        low = path.lower()
        if self.last[0] == low:
            return self.last[1]
        pkg, e = self.entry(path)
        b = self.pk.read(pkg, e)
        self.count['bytesRead'] += len(b)
        self.last = (low, b)
        return b

    def texture(self, path, size):
        """A texture's levels from the first no larger than `size` px down (dds_slice): a stored member is read from
        that level on, its header first; a deflated one whole."""
        pkg, e = self.entry(path)
        if e[2] == 0:
            head = self.pk.read(pkg, e, 0, min(e[4], 148))
            cut = dds_cut(head, size)
            if cut is not None:
                hdr, start = cut
                b = hdr + self.pk.read(pkg, e, start, e[4] - start)
                self.count['bytesRead'] += len(b)
                self.count['texturesCut'] += 1
                return b
        return dds_slice(self.bytes(path), size)

    def add(self, path, texture=False, cover=None):
        """Copy one resource (once); -> its manifest entry or None when the client has no such file. `texture`: True (the
        mip levels from TEX_MAX px down) or the largest level wanted in px (19.11, the rock stage: a cell of an atlas at
        ROCK_SIZE); a texture already added with smaller levels is copied again with the larger ones (another name).
        `cover`: the builder's products made of it (covered); when the page holds them all, it is listed, not copied - a
        later use the page does not hold copies it after all."""
        low = path.lower()
        size = (TEX_MAX if texture is True else int(texture)) if texture else None
        held = self.covered(cover)
        if low in self.entries:
            old = self.entries[low]
            if old is None or (old.get('held') and held):
                return old
            if not old.get('held') and not old.get('sparse') and (size is None or old.get('slice', TEX_MAX) >= size):
                return old
            if old.get('sparse'):
                self.count['sparse'] -= 1
                self.count['sparseSourceBytes'] -= old['sourceSize']
                self.count['resources'] -= 1
                self.count['bytesRaw'] -= old['size']
            elif old.get('held'):
                self.count['held'] -= 1
                self.count['heldSourceBytes'] -= old['sourceSize']
            else:
                self.count['resources'] -= 1
                self.count['bytesRaw'] -= old['size']
            del self.entries[low]
        pkg, e = self.entry(path)
        if e is None:
            self.entries[low] = None
            return None
        if held:
            ent = self.entries[low] = dict(path=low, crc=e[5], held=True, sourceSize=e[4])
            self.count['held'] += 1
            self.count['heldSourceBytes'] += e[4]
            return ent
        b = self.texture(path, size) if texture else self.bytes(path)
        name = 'res:' + low + ('' if size in (None, TEX_MAX) else '@%d' % size)
        ent = dict(path=low, crc=e[5], name=name, part=self.parts.put(name, b), size=len(b), sourceSize=e[4])
        if size is not None and size != TEX_MAX:
            ent['slice'] = size
        self.count['resources'] += 1
        self.count['bytesRaw'] += len(b)
        self.entries[low] = ent
        return ent

    def add_sparse(self, path, ranges, cover=None):
        """A resource of which the builder reads only `ranges` ([offset, length], from the start of the member): those bytes
        copied one after the other; the manifest entry's `sparse` says where they go (the page lays them into a zeroed
        buffer of the member's size). A resource copied whole already stays whole."""
        if self.whole_only:
            return self.add(path)
        low = path.lower()
        held = self.covered(cover)
        old = self.entries.get(low)
        if old is not None and (not old.get('held') or held):
            return old
        if old is not None:
            self.count['held'] -= 1
            self.count['heldSourceBytes'] -= old['sourceSize']
            del self.entries[low]
        pkg, e = self.entry(path)
        if e is None:
            self.entries[low] = None
            return None
        if held:
            ent = self.entries[low] = dict(path=low, crc=e[5], held=True, sourceSize=e[4])
            self.count['held'] += 1
            self.count['heldSourceBytes'] += e[4]
            return ent
        whole = None if e[2] == 0 else self.bytes(path)
        b = b''.join(self.pk.read(pkg, e, o, n) if whole is None else whole[o:o + n] for o, n in ranges)
        name = 'res:' + low
        ent = dict(path=low, crc=e[5], name=name, part=self.parts.put(name, b), size=len(b), sourceSize=e[4],
                   sparse=[list(r) for r in ranges])
        self.count['resources'] += 1
        self.count['sparse'] = self.count.get('sparse', 0) + 1
        self.count['sparseSourceBytes'] = self.count.get('sparseSourceBytes', 0) + e[4]
        self.count['bytesRead'] += len(b)
        self.count['bytesRaw'] += len(b)
        self.entries[low] = ent
        return ent

    def refs(self, path, find, kind=None, cover=None):
        """Cached references of a resource (find(bytes) -> [paths]); the resource itself is added first (`cover` as
        add's). `kind` names another finder of the same resource (its own cache entry)."""
        ent = self.add(path, cover=cover)
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


def fnv(text):
    """FNV-1a 32 of a text's characters (mapbuild.js MB.fnv, the page's digest of its product keys)."""
    h = 0x811c9dc5
    for c in text:
        h = ((h ^ ord(c)) * 0x01000193) & 0xffffffff
    return h


def dds_cut(head, size):
    """(the cut DDS's header, the offset of its first level) of a DDS whose first 148 bytes are `head`: its mip levels
    from the first no larger than `size` (or the last) down, width, height and mip count rewritten; None when it is
    not a block-compressed DDS (kept whole)."""
    if head[:4] != b'DDS ' or len(head) < 128:
        return None
    hdr = bytearray(head[:128])
    h, w = struct.unpack_from('<2I', hdr, 12)
    mips = max(1, struct.unpack_from('<I', hdr, 28)[0])
    flags, four = struct.unpack_from('<I4s', hdr, 80)
    p = 128
    extra = b''
    if four == b'DX10':
        if len(head) < 148:
            return None
        extra = bytes(head[128:148]); p = 148
        fmt = struct.unpack_from('<I', head, 128)[0]
        bs = 8 if fmt in (70, 71, 72, 79, 80, 81) else 16
    elif not flags & 4:
        return None
    else:
        bs = 8 if four == b'DXT1' else 16
    ww, hh = w, h
    for level in range(mips):
        nb = max(1, (ww + 3) // 4) * max(1, (hh + 3) // 4) * bs
        if max(ww, hh) <= size or level == mips - 1:
            struct.pack_into('<2I', hdr, 12, hh, ww)
            struct.pack_into('<I', hdr, 28, mips - level)
            return bytes(hdr) + extra, p
        p += nb; ww, hh = max(1, ww // 2), max(1, hh // 2)
    return None


def dds_slice(b, size):
    """A DDS cut to its mip levels from the first no larger than `size` (or the last) down: a DDS of its own (width,
    height and mip count rewritten). Another format than block-compressed: returned whole."""
    cut = dds_cut(b[:148], size)
    if cut is None:
        return b
    return cut[0] + b[cut[1]:]


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


# 19.11: the builder's LOD choice (mapbuild9.js chooseLod): along a model's LOD chain, the first LOD whose textured
# triangles fit a budget - 160 for its size probe, then budget(diag, count), always within [BUDGET_LO, BUDGET_HI] - or the
# last one. Only the LODs that can be chosen for some budget there are drawn (their geometry read: lodGeometry); of the
# others the builder reads only the triangle counts (lodInfo: the block table, each index block's header and groups).
BUDGET_LO, BUDGET_HI = 100, 800


def visual_groups(b):
    """mapbuild9.js visualXml, what the LOD choice needs: per geometry [vertices block, primitive block, [[primitive
    group, the texture property texture_of takes, its texture]]]."""
    v = packed_xml(b)
    out = []
    if v is None:
        return out
    for rs in [k for k in v.kids if k.tag == 'renderSet']:
        for g in [k for k in rs.kids if k.tag == 'geometry']:
            groups = []
            for pg in [k for k in g.kids if k.tag == 'primitiveGroup']:
                m = pg.find('material')
                props = {}
                if m is not None:
                    for pp in [k for k in m.kids if k.tag == 'property']:
                        tex = pp.findtext('Texture')
                        if tex:
                            props[(pp.text or '').strip()] = tex.strip()
                pick = ['', '']
                for k in ('diffuseMap', 'albedoHeightTile0', 'atlasAlbedoHeight', 'diffuseMap2'):
                    if k in props:
                        pick = [k, props[k]]
                        break
                n = re.match(r'\s*([-+]?\d+)', (pg.text or '0').strip() or '0')
                groups.append([int(n.group(1)) if n else 0] + pick)
            out.append([(g.findtext('vertices') or '').strip(), (g.findtext('primitive') or '').strip(), groups])
    return out


def textured(R, kind, tex):
    """mapbuild9.js textureOf: whether a group has the texture the builder draws it with."""
    if kind == 'atlasAlbedoHeight':
        ap = tex.rsplit('.', 1)[0] + '.atlas_processed'
        if R.exists(ap):
            return bool(R.refs(ap, lambda b: atlas_tile(R, b), cover=[R.key('atl', ap)]))
        return tex.lower().endswith('.dds') and R.exists(tex)
    return bool(tex)


def lod_info(R, vs):
    """(textured triangles, ranges of the primitives file lodInfo reads) of one visual LOD, or None when it has no visual
    or no primitives (lodInfo: null). Kept in deps.json by both files' CRCs."""
    pkg, pe = R.entry(vs + '.primitives_processed')
    ve = R.entry(vs + '.visual_processed')[1]
    if pe is None or ve is None:
        return None
    key = '%s|%08x|%08x|lod1' % (pe[0], pe[5], ve[5])
    got = R.deps.get(key)
    if got is None:
        groups = R.refs(vs + '.visual_processed', visual_groups, 'groups', cover=[R.key('lod', vs + '.visual_processed', pe[5])])
        size = pe[4]
        whole = None if pe[2] == 0 else R.bytes(vs + '.primitives_processed')

        def read(o, n):
            return R.pk.read(pkg, pe, o, n) if whole is None else whole[o:o + n]
        tsize = struct.unpack('<I', read(size - 4, 4))[0]
        tp = size - 4 - tsize
        table = read(tp, tsize)
        ranges = [[tp, tsize + 4]]
        blocks, p, pos = {}, 0, 4
        while p < tsize:
            bsize, nlen = struct.unpack_from('<I', table, p)[0], struct.unpack_from('<I', table, p + 20)[0]
            blocks[table[p + 24:p + 24 + nlen].decode('latin-1')] = (pos, bsize)
            p += 24 + ((nlen + 3) & ~3)
            pos += (bsize + 3) & ~3
        ntri = []
        heads = {}
        for vname, pname, gl in groups:
            if vname not in blocks or pname not in blocks:
                ntri.append(None)
                continue
            if pname not in heads:
                at = blocks[pname][0]
                h = read(at, 72)
                fmt = h[:64].split(b'\0', 1)[0].decode('latin-1')
                n, ng = struct.unpack_from('<2I', h, 64)
                w = 4 if fmt == 'list32' else 2
                gp = at + 72 + n * w
                gt = read(gp, 16 * ng)
                heads[pname] = (n, [struct.unpack_from('<2I', gt, 16 * i) for i in range(ng)])
                ranges += [[at, 72], [gp, 16 * ng]]
            n, ig = heads[pname]
            ntri.append([[gi, (max(0, min(n, ig[gi][0] + ig[gi][1] * 3) - ig[gi][0]) // 3) if gi < len(ig) else None]
                         for gi, _, _ in gl])
        got = R.deps[key] = dict(ntri=ntri, ranges=sorted(set(tuple(r) for r in ranges)))
        R.deps_changed = True
    groups = R.refs(vs + '.visual_processed', visual_groups, 'groups', cover=[R.key('lod', vs + '.visual_processed', pe[5])])
    total = 0
    for (vname, pname, gl), counts in zip(groups, got['ntri']):
        if counts is None:
            continue
        for (gi, kind, tex), (_, nt) in zip(gl, counts):
            if nt is not None and textured(R, kind, tex):
                total += nt
    return total, [list(r) for r in got['ranges']]


def lod_drawn(chain):
    """Of [(visual, textured triangles)] along a chain, the LODs chooseLod can pick for some budget in [BUDGET_LO,
    BUDGET_HI]: each first to fit a budget there, and the last one when none fits the smallest."""
    out, best = set(), None
    for vs, n in chain:
        if n <= BUDGET_HI and (best is None or (n < best and best > BUDGET_LO)):
            out.add(vs)
        best = n if best is None else min(best, n)
    if chain and best > BUDGET_LO:
        out.add(chain[-1][0])
    return out


def collect_resources(R, objects, plants):
    """Every file the builder will read for these objects and plants (objects_visual.build, build.build_statics,
    build.plant_kind): visual LOD chains, their geometry and colour textures, the rock shader's textures (19.11,
    rock_textures), havok, .srt and their textures. A generator:
    it yields after each object and plant kind."""
    for prim, hav in objects:
        yield
        if hav:
            R.add(hav, cover=[R.key('hav', hav)])
        if not prim or not prim.endswith('.primitives') or prim.lower().startswith(SKIP_PREFIX) or 'null_model' in prim.lower():
            continue
        stem = prim.rsplit('.', 1)[0]
        R.add(stem + '.visual_processed', cover=(R.lod_cover(stem) or [])[:1] or None)
        seen, chain = set(), []
        while stem and stem.lower() not in seen:
            seen.add(stem.lower())
            r = R.refs(stem + '.model', model_refs, cover=[R.key('mdl', stem + '.model')])
            if not r:
                break
            vs = r[0] or stem
            lod = R.lod_cover(vs)
            info = lod_info(R, vs)
            if info is not None:
                chain.append((vs, info))
            for kind, tex in R.refs(vs + '.visual_processed', visual_textures, cover=lod[:1] if lod else None):
                if kind == 'atlasAlbedoHeight':
                    ap = tex.rsplit('.', 1)[0] + '.atlas_processed'
                    for t in R.refs(ap, lambda b, tex=tex: atlas_tile(R, b), cover=[R.key('atl', ap)]) if R.exists(ap) else ([tex] if tex.lower().endswith('.dds') and R.exists(tex) else []):
                        R.add(t, texture=True, cover=[R.key('tex', t)])
                else:
                    R.add(tex, texture=True, cover=[R.key('tex', tex)])
            for item in R.refs(vs + '.visual_processed', visual_rocks, 'rock1', cover=lod[:1] if lod else None):   # 19.11: the rock shader's inputs
                rock_textures(R, item)
            stem = r[1]
        # the LODs that can be drawn whole (and their visual for the geometry product), the others' counts only
        drawn = lod_drawn([(vs, info[0]) for vs, info in chain])
        for vs, info in chain:
            if vs in drawn:
                lod = R.lod_cover(vs)
                R.add(vs + '.visual_processed', cover=lod)
                R.add(vs + '.primitives_processed', cover=lod)
            else:
                R.add_sparse(vs + '.primitives_processed', info[1], cover=R.lod_cover(vs)[:1])
    for path in plants:
        yield
        if R.add(path, cover=[R.key('kind', path)]) is None:
            continue
        folder = path.rsplit('/', 1)[0]
        for n in R.refs(path, lambda b: sorted(set(m.decode('ascii') for m in re.findall(br'([A-Za-z0-9_\-]+_AM\.dds)\x00', b) if b'billboard' not in m.lower())), cover=[R.key('kind', path)]):
            t = folder + '/' + n   # a leaf (128 px) or a bark (64 px) texture: the kind says which (mapbuild9.js plants)
            R.add(t, texture=True, cover=[(R.key('ptex', t, 128), R.key('ptex', t, 64))])
    for p, kind in (('scripts/destructibles.xml', 'destr'), ('vegetation/bushes.xml', 'bush')):
        R.add(p, cover=[R.key(kind, p)])


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
    """The arena's default-view inputs, each handed to out(name, bytes, source dict); `found` gets the 'objects' and
    'plants' inside the terrain box. A generator: it yields every 32 terrain chunks and after them."""
    sp = 'spaces/%s/' % arena

    def get(path, required=True):
        pkg, e = pk.find(path)
        if e is None and required:
            raise RuntimeError('not in the packages: %s' % path)
        return pkg, e
    names = pk.chunks(arena)
    if not names and get(sp + 'space.bin', False)[1] is None:
        raise RuntimeError('no package holds %s' % sp)
    # terrain chunks: only terrain2/heights of each <x><z>o.cdata_processed (16-bit hex x, z)
    for i, path in enumerate(names):
        pkg, e = get(path)
        b, crc = inner_member(pk, pkg, e, 'terrain2/heights')
        if b is not None:
            out('chunk/%s/heights' % path[len(sp):len(sp) + 8].lower(), b, dict(path=path, pkg=pkg, crc=e[5], member='terrain2/heights', memberCrc=crc))
        if i % 32 == 31: yield
    yield
    # space.bin: the table of contents, then only the sections the builder reads
    pkg, e = get(sp + 'space.bin')
    head = pk.read(pkg, e, 0, 24)
    assert head[:4] == b'BWTB', head[:4]
    n = struct.unpack_from('<I', head, 20)[0]
    toc = pk.read(pkg, e, 24, 24 * n)
    secs = {}
    gobj = None
    for i in range(n):
        m, v, o, l = struct.unpack_from('<4sIQQ', toc, 24 * i)
        m = m.decode('ascii')
        if m == 'GOBJ':     # 21.11: read here, its scenarios written as scenario.json (the builder needs no GOBJ)
            gobj = pk.read(pkg, e, o, l)
        if m in SPACE_SECTIONS:
            secs[m] = pk.read(pkg, e, o, l)
            out('space.bin/' + m, secs[m], dict(path=e[0], pkg=pkg, crc=e[5], section=m, version=v, offset=o))
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
    # 21.11: the scenarios' standing and ruin models - their files through the same per-model copy, their placements
    # in scenario.json (the builder adds them to the BSMI instances)
    scen, counts = space_scenarios(pk, gobj, st)
    extra = scenario_objects(pk, scen)
    have = set(found['objects'])
    found['objects'] = found['objects'] + [x for x in extra if x not in have]
    js = json.dumps(dict(format=1, scenarios=[dict((k, v) for k, v in s.items() if k != 'instances') for s in scen],
                         instances=[dict(part=it['part'], state=it['state'], name=it['name'], prim=it['prim'],
                                         havok=it['havok'], m=it['m'], mask=it['mask'])
                                    for s in scen for it in s['instances']]),
                    separators=(',', ':'), sort_keys=True)
    jb = js if isinstance(js, bytes) else js.encode('utf-8')
    out('scenario.json', jb, dict(path='scenario.json', crc=zlib.crc32(jb) & 0xffffffff, scenarios=len(scen)))
    found['scenarios'] = dict(counts, scenarios=len(scen), parts=sum(s['parts'] for s in scen),
                              standing=sum(s['normal'] for s in scen), ruin=sum(s['ruin'] for s in scen))
    yield
    found['plants'] = space_plants(secs['SpTr'], st, box)
    yield
    for name in ('space.settings',):
        pkg, e = get(sp + name, False)
        if e:
            out(name, pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5]))
    # environment: environments.xml names the active one
    pkg, e = get(sp + 'environments/environments.xml')
    env = pk.read(pkg, e)
    out('environments.xml', env, dict(path=e[0], pkg=pkg, crc=e[5]))
    guid = packed_text(env, 'activeEnvironment').strip().replace('.', '-')
    pkg, e = get(sp + 'environments/%s/environment.xml' % guid)
    out('environment.xml', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5], guid=guid))
    # the arena definition (bases, control point, spawns per gameplay)
    pkg, e = get('scripts/arena_defs/%s.xml' % arena)
    out('arena_defs.xml', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5]))
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
    out('global_am.dds', bytes(hdr) + pk.read(pkg, e, start, end - start),
        dict(path=e[0], pkg=pkg, crc=e[5], sourceSize=w, firstLevel=first, levels=lv))
    if minimap:
        pkg, e = get(sp + 'mmap.dds')
        out('mmap.dds', pk.read(pkg, e), dict(path=e[0], pkg=pkg, crc=e[5]))


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


def manifest_current(root, arena):
    """True when the arena's raw set is there in this module's format (its manifest's first bytes say so)."""
    path = manifest_path(root, arena)
    try:
        with open(path, 'rb') as f: head = f.read(64)
    except (IOError, OSError):
        return False
    return head.startswith(b'MapRaw.manifest({"arena":') and (b'"version":%d' % MANIFEST_VERSION) in head


def remove_set(root, arena):
    """The arena's raw set removed (the page holds the map built from it). True when there was one."""
    path = os.path.join(root, arena)
    if not os.path.isdir(path): return False
    shutil.rmtree(path)
    return True


def copy_steps(client, root, arena, report, held=None, resv=None, whole=False):
    """The whole copy of one arena into `root` (CFG/mapraw): the package table, the arena's own inputs, the resources of
    its objects and plants the page does not hold (`held`, `resv`: Resources), the parts and the manifest. A generator
    (the export thread's slices); `report` gets the counts, and while it runs 'stage' with 'done' and 'total' (the
    page's progress line). `whole`: every resource whole and none held back (the page's second asking, after its build
    needed one of them: MB.HeldMissing)."""
    started = time.time()
    for key in COUNT: COUNT[key] = 0
    index_dir = os.path.join(root, 'index')
    target = os.path.join(root, arena)
    temp = target + '.tmp'
    if os.path.isdir(temp): shutil.rmtree(temp)
    report.update(stage='index', done=0, total=0)
    pk = Packages(client, index_dir, build=False)
    parts = Parts(temp)
    files = []

    def put(name, b, src):
        m = dict(name=name, size=len(b), part=parts.put(name, b))
        m.update(src)
        files.append(m)
    try:
        for _ in pk.scan_steps(): yield
        found = {}
        report.update(stage='terrain')
        for _ in collect(pk, arena, arena in MINIMAP_RENDERED, put, found): yield
        R = Resources(pk, parts, index_dir, None if whole else held, resv, whole_only=whole)
        report.update(stage='objects', done=0, total=len(found['objects']) + len(found['plants']))
        for _ in collect_resources(R, found['objects'], found['plants']):
            report['done'] += 1
            yield
        R.save()
    finally:
        pk.close()
    report.update(stage='writing')
    parts.flush()
    yield
    manifest = dict(files=files, parts=parts.names,
                    res=[e for k, e in sorted(R.entries.items()) if e], made=time.strftime('%Y-%m-%d %H:%M:%S'))
    js = ('MapRaw.manifest({"arena":%s,"version":%d,' % (json.dumps(arena), MANIFEST_VERSION)
          + json.dumps(manifest, separators=(',', ':'), sort_keys=True)[1:] + ');\n')
    write_bytes(os.path.join(temp, 'manifest.js'), js.encode('utf-8'))
    if os.path.isdir(target): shutil.rmtree(target)
    os.rename(temp, target)
    report.update(stage='ready', arena=arena, seconds=round(time.time() - started, 3), files=len(files),
                  parts=len(parts.names), written=parts.written + len(js), resources=dict(R.count),
                  rawBytes=sum(f['size'] for f in files), counts=dict(COUNT), scenarios=found.get('scenarios') or {})
