"""Copy the client's crit and damage-log icons out of the installed game into web/icons/crits/ (22.09, 25.09).
Run by the user, once per client update.

The hit tiles show the client's own pictures: the damaged modules and injured crew (16 px library icons, yellow
damaged / red destroyed) and the battle damage log's own 16 px icons of the damage source (a generic crit, fire,
ram, a fall, a strike ...; the plain variant for damage the player dealt, *_enemy for damage he took - the client's
damage_log_panel builders). They are interface art of the installed client, so they are read from its gui packages
(plain zip files) instead of being kept anywhere else:

    python tools/extract_crit_icons.py [game folder]      (default C:/Games/World_of_Tanks_NA)

The game folder is only read. The library icons are PNG files of their own; the damage-log icons are sprites of
gui/flash/atlases/battleAtlas.dds (DXT5 / BC3, no mipmaps) at the coordinates of battleAtlas.xml, decoded here and
written as 16x16 RGBA PNG (a 15 px wide sprite gets a clear column on the right). Each icon's size is checked, and
a digest other than the one NA 2.4.0.1 had is reported (a client update may redraw an icon; the new one is still
written): SHA-256 of the file for a library icon, of the decoded RGBA pixels for a sprite (the PNG bytes depend on
the zlib at hand). Files already identical are left alone. The output list is CRIT_ICON_FILES of exporter.py
(tools/check.py compares them); tools/build.py refuses to build while one is missing. Nothing but the file names
and counts is printed.
"""
import hashlib
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'web' / 'icons' / 'crits'
GAME = Path('C:/Games/World_of_Tanks_NA')
CRIT_ICONS = [  # (entry in res/packages/gui-part*.pkg, package seen in NA 2.4.0.1, width x height, sha256[:12])
    ('gui/maps/icons/library/crits/engineCriticalSmall.png',          'gui-part3.pkg', '16x16', '38a876d8ed15'),
    ('gui/maps/icons/library/crits/engineDestroyedSmall.png',         'gui-part1.pkg', '16x16', '4c01e2191b9c'),
    ('gui/maps/icons/library/crits/ammoBayCriticalSmall.png',         'gui-part4.pkg', '16x16', 'fd8bcc7347f7'),
    ('gui/maps/icons/library/crits/ammoBayDestroyedSmall.png',        'gui-part2.pkg', '16x16', '641899fd6f02'),
    ('gui/maps/icons/library/crits/fuelTankCriticalSmall.png',        'gui-part1.pkg', '16x16', 'b10794bff2cb'),
    ('gui/maps/icons/library/crits/fuelTankDestroyedSmall.png',       'gui-part1.pkg', '16x16', 'f4c301fb158b'),
    ('gui/maps/icons/library/crits/radioCriticalSmall.png',           'gui-part1.pkg', '16x16', 'd27284ef127c'),
    ('gui/maps/icons/library/crits/radioDestroyedSmall.png',          'gui-part3.pkg', '16x16', 'a016d47ba970'),
    ('gui/maps/icons/library/crits/trackCriticalSmall.png',           'gui-part1.pkg', '16x16', '79c29bb3b317'),
    ('gui/maps/icons/library/crits/trackDestroyedSmall.png',          'gui-part3.pkg', '16x16', 'e5e97b70d8ce'),
    ('gui/maps/icons/library/crits/wheelCriticalSmall.png',           'gui-part3.pkg', '16x16', 'a228139a179e'),
    ('gui/maps/icons/library/crits/wheelDestroyedSmall.png',          'gui-part3.pkg', '16x16', 'e0f6be4623d6'),
    ('gui/maps/icons/library/crits/gunCriticalSmall.png',             'gui-part4.pkg', '16x16', '9fe2ba6058c7'),
    ('gui/maps/icons/library/crits/gunDestroyedSmall.png',            'gui-part3.pkg', '16x16', 'a4ad6eb22346'),
    ('gui/maps/icons/library/crits/turretRotatorCriticalSmall.png',   'gui-part4.pkg', '16x16', '62b2defd37a3'),
    ('gui/maps/icons/library/crits/turretRotatorDestroyedSmall.png',  'gui-part1.pkg', '16x16', 'cb3936159581'),
    ('gui/maps/icons/library/crits/surveyingDeviceCriticalSmall.png', 'gui-part1.pkg', '16x16', '53cd92f94df7'),
    ('gui/maps/icons/library/crits/surveyingDeviceDestroyedSmall.png','gui-part4.pkg', '16x16', '8994bc3da514'),
    ('gui/maps/icons/library/crits/commanderDestroyedSmall.png',      'gui-part1.pkg', '16x16', '6b7040582f2f'),
    ('gui/maps/icons/library/crits/driverDestroyedSmall.png',         'gui-part3.pkg', '16x16', 'd6bd8027e2d1'),
    ('gui/maps/icons/library/crits/radiomanDestroyedSmall.png',       'gui-part1.pkg', '16x16', '26e59dfff732'),
    ('gui/maps/icons/library/crits/gunnerDestroyedSmall.png',         'gui-part4.pkg', '16x16', 'a978ad427f4a'),
    ('gui/maps/icons/library/crits/loaderDestroyedSmall.png',         'gui-part2.pkg', '16x16', '516a4382df87'),
]
ATLAS = ('gui/flash/atlases/battleAtlas.dds', 'gui-part3.pkg')   # (entry, package seen in NA 2.4.0.1)
ATLAS_XML = ('gui/flash/atlases/battleAtlas.xml', 'gui-part1.pkg')
ATLAS_ICONS = [  # (sprite name in battleAtlas.xml, sha256[:12] of its decoded RGBA pixels in NA 2.4.0.1)
    ('damageLog_critical_16x16',              'b8e1899ae659'), ('damageLog_critical_enemy_16x16',        'c8255f03b113'),
    ('damageLog_fire_16x16',                  '47abf20263c2'), ('damageLog_fire_enemy_16x16',            '3aab3ce4302a'),
    ('damageLog_ram_16x16',                   '7d84125bdaf1'), ('damageLog_ram_enemy_16x16',             '964c86d3c30c'),
    ('damageLog_damage_16x16',                '86d9bbc6d806'), ('damageLog_damage_enemy_16x16',          'd012875637bc'),
    ('damageLog_artillery_eq_16x16',          'f64698237a9a'), ('damageLog_artillery_eq_enemy_16x16',    '75fe21bfad9d'),
    ('damageLog_airstrike_eq_16x16',          'ea08f95f0867'), ('damageLog_airstrike_eq_enemy_16x16',    'fd75e82c731f'),
    ('damageLog_airstrike_enemy_16x16',       'da12f605295b'),
    ('damageLog_artillery_16x16',             'b56531acd123'), ('damageLog_artillery_enemy_16x16',       'b5b23e9b46c2'),
    ('damageLog_mine_field_16x16',            '441c3c580b09'), ('damageLog_by_mine_field_16x16',         'a451731d69eb'),
    ('damageLog_spawned_bot_16x16',           '58278e0f8e56'), ('damageLog_by_spawned_bot_16x16',        '3acfa03c6d9b'),
    ('damageLog_by_smoke_16x16',              'de6b1d48fe84'), ('damageLog_berserker_16x16',             '9482998ab4ac'),
    ('damageLog_corroding_shot_16x16',        'e265851a942e'), ('damageLog_corroding_shot_enemy_16x16',  'c4ef8e8b0c80'),
    ('damageLog_fire_circle_16x16',           '8845f15cb126'), ('damageLog_fire_circle_enemy_16x16',     'd85c1a70f1e4'),
    ('damageLog_cling_brander_16x16',         'b340322abe44'), ('damageLog_cling_brander_enemy_16x16',   'ebf33e6f4d92'),
    ('damageLog_thunder_strike_16x16',        'cda862b238f7'), ('damageLog_thunder_strike_enemy_16x16',  '42c249defc77'),
    ('damageLog_he_rocket_16x16',             'a21a4f57f980'), ('damageLog_he_rocket_enemy_16x16',       'f17d19b520b1'),
]
SIZE = 16


def outputs():
    """The files this script writes, as exporter.CRIT_ICON_FILES lists them (tools/check.py compares the two)."""
    return [('web/icons/crits/' + entry.rsplit('/', 1)[1]) for entry, _, _, _ in CRIT_ICONS] + \
           ['web/icons/crits/%s.png' % name for name, _ in ATLAS_ICONS]


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR': return None
    return '%dx%d' % struct.unpack('>II', data[16:24])


def png_rgba(width, height, pixels):
    """An 8-bit RGBA PNG of rows of RGBA bytes, filter 0 on every row."""
    raw = b''.join(b'\x00' + pixels[row * width * 4:(row + 1) * width * 4] for row in range(height))
    def chunk(kind, body): return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def dds_header(data):
    """(width, height, offset of the pixels) of a DXT5 DDS without the DX10 extension, else a ValueError."""
    if data[:4] != b'DDS ' or struct.unpack('<I', data[4:8])[0] != 124: raise ValueError('not a DDS file')
    height, width = struct.unpack('<II', data[12:20])
    if data[84:88] != b'DXT5': raise ValueError('pixel format %r, only DXT5 is read' % data[84:88])
    if len(data) < 128 + ((width + 3) // 4) * ((height + 3) // 4) * 16: raise ValueError('DDS shorter than its size')
    return width, height, 128


def bc3_block(block):
    """The 16 RGBA pixels (row by row) of one 16-byte BC3 block: interpolated alpha, then 4-colour RGB565."""
    a0, a1 = block[0], block[1]
    alphas = [a0, a1] + ([((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)] if a0 > a1
                         else [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255])
    abits = int.from_bytes(block[2:8], 'little')
    c0, c1 = struct.unpack('<HH', block[8:12])
    def rgb(c): return (((c >> 11) & 31) * 255 + 15) // 31, (((c >> 5) & 63) * 255 + 31) // 63, ((c & 31) * 255 + 15) // 31
    p0, p1 = rgb(c0), rgb(c1)
    colours = [p0, p1, tuple((2 * x + y) // 3 for x, y in zip(p0, p1)), tuple((x + 2 * y) // 3 for x, y in zip(p0, p1))]
    cbits = struct.unpack('<I', block[12:16])[0]
    return [colours[(cbits >> (2 * i)) & 3] + (alphas[(abits >> (3 * i)) & 7],) for i in range(16)]


def sprite(data, width, offset, x, y, w, h):
    """The RGBA bytes of a w x h sprite at (x, y) of a BC3 texture, padded with clear pixels to SIZE x SIZE."""
    blocks_wide, cache, out = (width + 3) // 4, {}, bytearray(SIZE * SIZE * 4)
    for row in range(h):
        for col in range(w):
            bx, by = (x + col) // 4, (y + row) // 4
            if (bx, by) not in cache:
                start = offset + (by * blocks_wide + bx) * 16
                cache[(bx, by)] = bc3_block(data[start:start + 16])
            at = (row * SIZE + col) * 4
            out[at:at + 4] = bytes(cache[(bx, by)][((y + row) % 4) * 4 + (x + col) % 4])
    return bytes(out)


def atlas_rects(xml):
    """{sprite name: (x, y, width, height)} of an atlas xml (<SubTexture><name> ... <height>)."""
    rects = {}
    for body in re.findall(r'<SubTexture>(.*?)</SubTexture>', xml, re.S):
        fields = dict((k, v.strip()) for k, v in re.findall(r'<(\w+)>([^<]*)</\1>', body))
        try: rects[fields['name']] = tuple(int(fields[k]) for k in ('x', 'y', 'width', 'height'))
        except (KeyError, ValueError): pass
    return rects


def main(argv):
    if argv and argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    game = Path(argv[0]) if argv else GAME
    packages = sorted((game / 'res' / 'packages').glob('gui-part*.pkg'))
    if not packages:
        print('No res/packages/gui-part*.pkg under %s: give the game folder as the argument.' % game)
        return 1
    archives = {}
    counts = {'written': 0, 'unchanged': 0, 'redrawn': 0, 'missing': 0, 'wrong size': 0}

    def find(entry, seen):
        # An entry is looked for in the package NA 2.4.0.1 had it in first, then in the others.
        order = [seen] + [p for p in archives if p != seen]
        return next((p for p in order if p in archives and entry in archives[p].NameToInfo), None)

    def save(name, data, size, digest, actual_digest, source):
        target = TARGET / name
        same = target.is_file() and target.read_bytes() == data
        if not same: target.write_bytes(data)
        counts['unchanged' if same else 'written'] += 1
        note = ''
        if actual_digest != digest:
            counts['redrawn'] += 1
            note = '  (differs from NA 2.4.0.1: the client has redrawn it)'
        print('%-11s %-40s %s %s%s' % ('unchanged' if same else 'written', name, size, source, note))

    try:
        for path in packages: archives[path.name] = zipfile.ZipFile(str(path))
        TARGET.mkdir(parents=True, exist_ok=True)
        for entry, seen, size, digest in CRIT_ICONS:
            name = entry.rsplit('/', 1)[1]
            source = find(entry, seen)
            if source is None:
                counts['missing'] += 1
                print('missing     %-40s not in any gui package' % name)
                continue
            data = archives[source].read(entry)
            actual = png_size(data)
            if actual != size:
                counts['wrong size'] += 1
                print('wrong size  %-40s %s in %s, expected %s: not written' % (name, actual or 'not a PNG', source, size))
                continue
            save(name, data, size, digest, hashlib.sha256(data).hexdigest()[:12], source)
        # The damage log's sprites: the atlas texture and its coordinates.
        texture, xml = find(*ATLAS), find(*ATLAS_XML)
        if texture is None or xml is None:
            counts['missing'] += len(ATLAS_ICONS)
            print('missing     %-40s not in any gui package: %d damage-log icons not written'
                  % ('battleAtlas.dds' if texture is None else 'battleAtlas.xml', len(ATLAS_ICONS)))
        else:
            data = archives[texture].read(ATLAS[0])
            width, height, offset = dds_header(data)
            rects = atlas_rects(archives[xml].read(ATLAS_XML[0]).decode('utf-8'))
            for sprite_name, digest in ATLAS_ICONS:
                name = sprite_name + '.png'
                rect = rects.get(sprite_name)
                if rect is None:
                    counts['missing'] += 1
                    print('missing     %-40s not in battleAtlas.xml' % name)
                    continue
                x, y, w, h = rect
                if not (14 <= w <= SIZE and 14 <= h <= SIZE) or x + w > width or y + h > height:
                    counts['wrong size'] += 1
                    print('wrong size  %-40s %dx%d at %d,%d in the atlas, expected up to %dx%d: not written' % (name, w, h, x, y, SIZE, SIZE))
                    continue
                pixels = sprite(data, width, offset, x, y, w, h)
                save(name, png_rgba(SIZE, SIZE, pixels), '%dx%d' % (SIZE, SIZE), digest, hashlib.sha256(pixels).hexdigest()[:12],
                     'battleAtlas %s' % texture)
    finally:
        for archive in archives.values(): archive.close()
    total = len(CRIT_ICONS) + len(ATLAS_ICONS)
    print('%d icons: %d written, %d unchanged, %d missing, %d of the wrong size; %d differ from NA 2.4.0.1. Folder: %s'
          % (total, counts['written'], counts['unchanged'], counts['missing'], counts['wrong size'], counts['redrawn'], TARGET))
    return 1 if counts['missing'] or counts['wrong size'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
