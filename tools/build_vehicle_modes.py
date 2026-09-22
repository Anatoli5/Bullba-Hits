"""Write web/vehicle-modes.js: which vehicle types this client lists for an event mode, and their locks.

The client ships the vehicles of some modes in the mode's own extension package, not in the common
vehicle list: white_tiger.pkg, last_stand.pkg and story_mode.pkg of NA 2.4.0.1 each carry
<mode>/scripts/item_defs/vehicles/<nation>/list.xml (outputs/vehicle-classes-modes-2026-09-21.md,
section 4). Being on such a list is the one mark every vehicle of those modes has: nine Story Mode
vehicles (*_SM_SCC) carry no mode tag at all, and 'special' is not a mode marker. So the page takes
membership from here, beside the tags a record carries. The table also keeps the lock tags of each
listed vehicle (lockOptionalDevices, lockDevices, lockEquipment, lockCrewSkills, ...), because an event
vehicle's type - and with it the tags a record can be given later - leaves the client with its event.

Every package of the client is scanned, so a future event that ships its vehicles the same way is
picked up without a code change; its family is the package's own folder name.

The table is CUMULATIVE (S3 review, 22.09): the existing web/vehicle-modes.js is read first, and a type
the scanned client no longer lists is kept as it was, so the entries an ended event leaves behind - the
very ones the table exists for - survive every re-run. Rows are only ever added or updated; each says in
'client' which client listed it last. Families and packages are merged the same way. An existing table
that cannot be read stops the tool before anything is written.

Run it with runtime/python.exe after a client update:
    runtime/python.exe tools/build_vehicle_modes.py [client folder]
The default folder is C:/Games/World_of_Tanks_NA. Read-only on the client; writes web/vehicle-modes.js.
"""
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'mod', 'local_armor_inspector'))
import packed_xml  # noqa: E402  (the mod's own reader of BigWorld packed XML)

TARGET = os.path.join(ROOT, 'web', 'vehicle-modes.js')
DEFAULT_CLIENT = 'C:/Games/World_of_Tanks_NA'
# <mode folder>/scripts/item_defs/vehicles/<nation>/list.xml inside an extension package. The common
# list lives in scripts.pkg as scripts/item_defs/vehicles/..., without a mode folder, and is not matched.
LIST_PATH = re.compile(r'^([A-Za-z0-9_]+)/scripts/item_defs/vehicles/([A-Za-z0-9_]+)/list\.xml$')
# The garage's name of a mode, where this client has one we know. Anything else is shown by its folder.
FAMILY_NAMES = {'white_tiger': 'White Tiger', 'last_stand': 'Last Stand', 'story_mode': 'Story Mode'}


TABLE = re.compile(r'window\.BULLBA_VEHICLE_MODES\s*=\s*(\{.*\})\s*;\s*$', re.S)


def read_table(path):
    """The table a previous run wrote, as a dict; an empty one when there is no file yet."""
    if not os.path.exists(path):
        return {}
    with io.open(path, encoding='utf-8') as stream:
        text = stream.read()
    match = TABLE.search(text)
    try:
        table = json.loads(match.group(1)) if match else None
    except ValueError:
        table = None
    if not isinstance(table, dict) or not isinstance(table.get('vehicles', {}), dict):
        raise SystemExit('Cannot read the existing ' + path + '; not overwriting it (fix or remove it first)')
    return table


def client_version(folder):
    """The <version> of the client's version.xml, e.g. 'v.2.4.0.1 #950'."""
    with open(os.path.join(folder, 'version.xml'), 'rb') as stream:
        root = ET.fromstring(stream.read())
    return (root.findtext('version') or '').strip()


def decode(data):
    tree = packed_xml.decode(data)
    return tree.getroot() if hasattr(tree, 'getroot') else tree


def scan(folder):
    packages = os.path.join(folder, 'res', 'packages')
    vehicles, sources = {}, {}
    for name in sorted(os.listdir(packages)):
        if not name.endswith('.pkg'):
            continue
        try:
            archive = zipfile.ZipFile(os.path.join(packages, name))
        except (zipfile.BadZipfile, OSError):
            continue
        with archive:
            for member in sorted(archive.namelist()):
                match = LIST_PATH.match(member)
                if not match:
                    continue
                family, nation = match.group(1), match.group(2)
                sources.setdefault(family, name)
                for entry in decode(archive.read(member)):
                    if not isinstance(entry.tag, str) or entry.tag.startswith('xmlns'):
                        continue
                    tags = (entry.findtext('tags') or '').split()
                    row = {'mode': family}
                    locks = sorted(tag for tag in tags if tag.startswith('lock'))
                    if locks:
                        row['locks'] = locks
                    vehicles[nation + ':' + entry.tag] = row
    return vehicles, sources


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CLIENT
    version = client_version(folder)
    vehicles, sources = scan(folder)
    if not vehicles:
        raise SystemExit('No extension vehicle list found under ' + folder)
    previous = read_table(TARGET)
    kept = dict((key, row) for key, row in (previous.get('vehicles') or {}).items()
                if key not in vehicles and isinstance(row, dict))
    for key, row in kept.items():
        # A row written before rows carried their client was listed by the table's own client.
        row.setdefault('client', previous.get('client') or '')
    for row in vehicles.values():
        row['client'] = version
    merged = dict(kept)
    merged.update(vehicles)
    families = dict(previous.get('families') or {})
    families.update((family, FAMILY_NAMES.get(family, family.replace('_', ' ').title())) for family in sources)
    packages = dict(previous.get('packages') or {})
    packages.update(sources)

    def compact(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
    rows = [' ' + compact(key) + ':' + compact(merged[key]) for key in sorted(merged)]
    lines = ['// Generated by tools/build_vehicle_modes.py, last from the installed client ' + version + '.',
             '// The vehicle types a client ships in an event mode\'s own package (<mode>/scripts/item_defs/',
             '// vehicles/<nation>/list.xml), with their lock tags. Membership is the one mark every vehicle of',
             '// those modes has; nine Story Mode vehicles carry no mode tag. Re-run after a client update: the',
             '// table is cumulative, a type a later client drops stays with the client that listed it last.',
             'window.BULLBA_VEHICLE_MODES = {',
             '"client":' + compact(version) + ',',
             '"families":' + compact(families) + ',',
             '"packages":' + compact(packages) + ',',
             '"vehicles":{',
             ',\n'.join(rows),
             '}};',
             '']
    with io.open(TARGET, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(u'\n'.join(lines))
    counts = {}
    for row in vehicles.values():
        counts[row['mode']] = counts.get(row['mode'], 0) + 1
    print('web/vehicle-modes.js: %d vehicles listed by client %s (%s), %d kept from earlier clients, %d in all' % (
        len(vehicles), version, ', '.join('%s %d' % (k, counts[k]) for k in sorted(counts)), len(kept), len(merged)))


if __name__ == '__main__':
    main()
