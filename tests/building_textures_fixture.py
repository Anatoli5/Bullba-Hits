"""Makes the local fixture of tests/test_building_textures.cjs (NOTEBOOK A6, 23.11.2026): Fisherman's Bay's raw map
files as the mod copies them (map_raw.copy_steps, nothing held by the page, LODs the builder never draws copied in part),
from the client in C:/Games/World_of_Tanks_NA (read only). The package table is the mod's own (CFG/mapraw/index), copied
into the fixture first so that nothing is written beside the game.

    runtime/python.exe tests/building_textures_fixture.py [client folder]
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'mod'))
from local_armor_inspector import map_raw  # noqa: E402

ARENA = '36_fishing_bay'
OUT = os.path.join(ROOT, 'tests', 'fixtures-local', 'building-textures-2026-11-23')


def main():
    client = sys.argv[1] if len(sys.argv) > 1 else 'C:/Games/World_of_Tanks_NA'
    index = os.path.join(OUT, 'index')
    if not os.path.isdir(index):
        src = os.path.join(client, 'mods', 'configs', 'local.armor_inspector', 'mapraw', 'index')
        shutil.copytree(src, index) if os.path.isdir(src) else os.makedirs(index)
    report = {}
    for _ in map_raw.copy_steps(client, OUT, ARENA, report):
        pass
    with open(os.path.join(OUT, 'README.json'), 'w') as f:
        json.dump(dict(arena=ARENA, source='copied by tests/building_textures_fixture.py from %s (read only)' % client,
                       report=report), f, indent=1)
    print(json.dumps(dict(resources=report.get('resources'), rawBytes=report.get('rawBytes'), written=report.get('written'))))


if __name__ == '__main__':
    main()
