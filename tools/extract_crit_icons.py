"""Copy the client's crit icons out of the installed game into web/icons/crits/ (22.09). Run by the user, once.

The hit tiles show the client's own pictures of damaged modules and injured crew. They are interface art of the
installed client, so they are read from its gui packages (plain zip files) instead of being kept anywhere else:

    python tools/extract_crit_icons.py [game folder]      (default C:/Games/World_of_Tanks_NA)

The game folder is only read. Each entry is looked up in every res/packages/gui-part*.pkg, its PNG header must
give the size listed below, and a SHA-256 other than the one NA 2.4.0.1 had is reported (a client update may
redraw an icon; the new one is still written). Files already identical are left alone. tools/build.py refuses to
build while one of them is missing. Nothing but the file names and counts is printed.
"""
import hashlib
import struct
import sys
import zipfile
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
    ('gui/maps/icons/library/critical_damage/hit_critical.png',       'gui-part3.pkg', '36x36', '83871fe237eb'),
    ('gui/maps/icons/library/critical_damage/hit_critical_track.png', 'gui-part4.pkg', '36x36', '5d98a19805db'),
    ('gui/maps/icons/library/efficiency/48x48/fire.png',              'gui-part1.pkg', '48x48', '1b034e4ea5ea'),
    ('gui/maps/icons/library/efficiency/48x48/module.png',            'gui-part1.pkg', '48x48', '00cdbdceaf0a'),
]


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR': return None
    return '%dx%d' % struct.unpack('>II', data[16:24])


def main(argv):
    if argv and argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    game = Path(argv[0]) if argv else GAME
    packages = sorted((game / 'res' / 'packages').glob('gui-part*.pkg'))
    if not packages:
        print('No res/packages/gui-part*.pkg under %s: give the game folder as the argument.' % game)
        return 1
    # Every entry is looked for in the package NA 2.4.0.1 had it in first, then in the others.
    archives = {}
    try:
        for path in packages: archives[path.name] = zipfile.ZipFile(str(path))
        TARGET.mkdir(parents=True, exist_ok=True)
        counts = {'written': 0, 'unchanged': 0, 'redrawn': 0, 'missing': 0, 'wrong size': 0}
        for entry, seen, size, digest in CRIT_ICONS:
            name = entry.rsplit('/', 1)[1]
            order = [seen] + [p for p in archives if p != seen]
            source = next((p for p in order if p in archives and entry in archives[p].NameToInfo), None)
            if source is None:
                counts['missing'] += 1
                print('missing     %-36s not in any gui package' % name)
                continue
            data = archives[source].read(entry)
            actual = png_size(data)
            if actual != size:
                counts['wrong size'] += 1
                print('wrong size  %-36s %s in %s, expected %s: not written' % (name, actual or 'not a PNG', source, size))
                continue
            target = TARGET / name
            same = target.is_file() and target.read_bytes() == data
            if not same: target.write_bytes(data)
            counts['unchanged' if same else 'written'] += 1
            note = ''
            if hashlib.sha256(data).hexdigest()[:12] != digest:
                counts['redrawn'] += 1
                note = '  (differs from NA 2.4.0.1: the client has redrawn it)'
            print('%-11s %-36s %s %s%s' % ('unchanged' if same else 'written', name, size, source, note))
    finally:
        for archive in archives.values(): archive.close()
    print('%d icons: %d written, %d unchanged, %d missing, %d of the wrong size; %d differ from NA 2.4.0.1. Folder: %s'
          % (len(CRIT_ICONS), counts['written'], counts['unchanged'], counts['missing'], counts['wrong size'],
             counts['redrawn'], TARGET))
    return 1 if counts['missing'] or counts['wrong size'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
