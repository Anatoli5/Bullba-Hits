# -*- coding: utf-8 -*-
"""Every name of the client mod/local_armor_inspector/client_boxes.py leans on exists in the installed client, and the code that puts
the box where boxes.py reads it is still there (WoT-Base W7); no game imports, the client is only read.

    python tests/py27/run27.py tests/py27/client_box_names.py

Carried over 19.11.2026 from the stopped side project C:/Projects/Bullba-Replays (tests/py27/client_names.py, fa382c3).

  WANTED   module inside res/packages/scripts.pkg -> names: present when the module's code binds or reads it (co_names,
           co_varnames) or it is a function / class name anywhere in its code tree
  CODE     module -> code paths ('.Class.function') that must exist: the properties and methods boxes.py calls
  STORES   (module, code path) -> attributes that code stores (STORE_ATTR): who writes the box, who fills the type
  CALLS    (module, code path) -> names that code reads (LOAD_ATTR / LOAD_GLOBAL): the chain from a built vehicle to
           setupCollisions, the descriptor taking the type's own components
  ABSENT   (module, code path) -> names that code must NOT read: the hangar's collider sets no box
Every attribute name boxes.py reads (READ) is in one of the lists and in boxes.py's text. Re-run after every client
patch. Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import io
import marshal
import opcode
import os
import sys
import types
import zipfile

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
DLL = os.environ.get('BULLBA_PY27_DLL', 'C:/Games/World_of_Tanks_NA/win64/python27.dll')
GAME = os.path.dirname(os.path.dirname(DLL))
PKG = os.path.join(GAME, 'res', 'packages', 'scripts.pkg')
BOXES = os.path.join(REPO, 'mod', 'local_armor_inspector', 'client_boxes.py')

VEHICLES = 'scripts/common/items/vehicles.pyc'
ITEMS = 'scripts/common/items/vehicle_items.pyc'
HIT = 'scripts/common/ModelHitTester.pyc'
ASSEMBLER = 'scripts/client/vehicle_systems/model_assembler.pyc'
TANK = 'scripts/client_common/vehicle_appearance/common_tank_appearance.pyc'
HANGAR = 'scripts/client/gui/hangar_vehicle_appearance.pyc'
MODIFIERS = 'scripts/common/battle_modifiers_common/battle_modifiers.pyc'

WANTED = {
    VEHICLES: ('g_cache', 'Cache', 'getVehicles', 'VehicleType', 'chassis', 'hulls', 'turrets', 'guns', 'trackPairs',
               'name', 'hitTesterManager'),
    ITEMS: ('InstallableItem', 'Hull', 'hitTesterManager', 'hitTester', 'activeHitTester'),
    'scripts/common/items/components/chassis_components.pyc': ('hitTesterManager',),
    HIT: ('HitTesterManager', 'modelHitTester', 'crashedModelHitTester', 'activeHitTester', 'ModelHitTester',
          'bspModelName', 'bbox'),
    'scripts/client/Avatar.pyc': ('PlayerAvatar',),
}
CODE = {
    VEHICLES: ('.Cache.getVehicles', '.Cache.vehicle', '.VehicleType.__init__'),
    HIT: ('.HitTesterManager.modelHitTester', '.HitTesterManager.crashedModelHitTester',
          '.ModelHitTester.bspModelName', '.ModelHitTester.__init__'),
    ASSEMBLER: ('.setupCollisions',),
    TANK: ('.CommonTankAppearance._connectCollider',),
}
STORES = {
    (ASSEMBLER, '.setupCollisions'): ('bbox',),                        # collisions.getBoundingBox(part) -> hitTester.bbox
    (HIT, '.ModelHitTester.__init__'): ('bbox',),                      # None until then
    (VEHICLES, '.VehicleType.__init__'): ('chassis', 'hulls', 'turrets', 'name'),
    (VEHICLES, '.VehicleDescriptor.__initFromCompactDescr'): ('chassis', 'turrets', 'hull', 'type'),
}
CALLS = {
    (ASSEMBLER, '.setupCollisions'): ('getBoundingBox', 'hitTester', 'chassis', 'hull', 'turret', 'gun', 'trackPairs'),
    (TANK, '.CommonTankAppearance._connectCollider'): ('model_assembler', 'setupCollisions', 'typeDescriptor'),
    (TANK, '.CommonTankAppearance.onActivate'): ('_connectCollider',),
    (VEHICLES, '.VehicleDescriptor.__initFromCompactDescr'): ('_descrByID', 'getVehicleModification', 'hulls'),
    (VEHICLES, '.VehicleDescriptor.__init__'): ('g_cache', 'vehicle'),
    (VEHICLES, '.Cache.getVehicles'): ('_Cache__vehicles',),
    (ITEMS, '.InstallableItem.hitTester'): ('hitTesterManager', 'activeHitTester'),
    (ITEMS, '.Hull.hitTester'): ('hitTesterManager', 'activeHitTester'),
}
ABSENT = {
    (HANGAR, '.HangarVehicleAppearance._connectCollider'): ('setupCollisions', 'model_assembler', 'bbox', 'super'),
    (MODIFIERS, '.BattleModifiers.getVehicleModification'): ('copy', 'deepcopy'),   # returns the type itself
}
# The attribute names boxes.py reads of the client's objects.
READ = ('g_cache', 'getVehicles', 'chassis', 'trackPairs', 'hulls', 'turrets', 'guns', 'hitTesterManager',
        'modelHitTester', 'crashedModelHitTester', 'bspModelName', 'bbox', 'name', 'PlayerAvatar')
sys.dont_write_bytecode = True


def names_of(code, names):
    names.update(code.co_names)
    names.update(code.co_varnames)
    names.add(code.co_name)
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            names_of(const, names)


def paths(code, prefix, out):
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            p = prefix + '.' + const.co_name
            out.setdefault(p, const)
            paths(const, p, out)
    return out


def ops(code, wanted):
    """Names used by the given opcodes in one code object (not its nested ones)."""
    out, at, raw = set(), 0, code.co_code
    codes = set(opcode.opmap[w] for w in wanted)
    while at < len(raw):
        op = ord(raw[at]) if isinstance(raw, str) else raw[at]
        if op >= opcode.HAVE_ARGUMENT:
            arg = (ord(raw[at + 1]) | (ord(raw[at + 2]) << 8)) if isinstance(raw, str) else (raw[at + 1] | raw[at + 2] << 8)
            at += 3
            if op in codes:
                out.add(code.co_names[arg])
        else:
            at += 1
    return out


def main():
    lines, missing, counted = [], 0, 0
    with zipfile.ZipFile(PKG) as package:
        loaded = {}

        def module(path):
            if path not in loaded:
                try:
                    code = marshal.loads(package.read(path)[8:])
                except KeyError:
                    loaded[path] = None
                    return None
                names = set()
                names_of(code, names)
                loaded[path] = (code, names, paths(code, '', {}))
            return loaded[path]

        def fail(text):
            lines.append(text)

        for path, wanted in sorted(WANTED.items()):
            found = module(path)
            counted += len(wanted)
            absent = list(wanted) if found is None else [n for n in wanted if n not in found[1]]
            if absent:
                missing += len(absent)
                fail('MISSING %s: %s' % (path, ', '.join(absent)))
        for path, wanted in sorted(CODE.items()):
            found = module(path)
            counted += len(wanted)
            absent = list(wanted) if found is None else [p for p in wanted if p not in found[2]]
            if absent:
                missing += len(absent)
                fail('MISSING code in %s: %s' % (path, ', '.join(absent)))
        for table, kinds, present in ((STORES, ('STORE_ATTR',), True),
                                      (CALLS, ('LOAD_ATTR', 'LOAD_GLOBAL', 'LOAD_NAME'), True),
                                      (ABSENT, ('LOAD_ATTR', 'LOAD_GLOBAL', 'LOAD_NAME', 'STORE_ATTR'), False)):
            for (path, where), wanted in sorted(table.items()):
                found = module(path)
                counted += len(wanted)
                code = found[2].get(where) if found else None
                if code is None:
                    missing += len(wanted)
                    fail('MISSING code in %s: %s' % (path, where))
                    continue
                used = ops(code, kinds)
                wrong = [n for n in wanted if (n in used) != present]
                if wrong:
                    missing += len(wrong)
                    fail('%s %s %s: %s' % ('MISSING in' if present else 'NOW PRESENT in', path, where, ', '.join(wrong)))
    listed = set()
    for wanted in WANTED.values():
        listed.update(wanted)
    with io.open(BOXES, encoding='utf-8') as f:
        source = f.read()
    stale = [n for n in READ if n not in listed or n not in source]
    counted += len(READ)
    if stale:
        missing += len(stale)
        fail('READ names not checked or not in boxes.py: %s' % ', '.join(stale))
    text = '\n'.join(['client_names: %d names and code facts in %d modules, %d missing' % (
        counted, len(set([p for p in WANTED] + [p for p in CODE] + [k[0] for k in list(STORES) + list(CALLS) + list(ABSENT)])),
        missing)] + lines)
    if RESULT:
        with open(RESULT, 'w') as stream:
            stream.write('exit %d\n%s\n' % (1 if missing else 0, text))
    else:
        print(text)


main()
