# -*- coding: utf-8 -*-
"""The shells' traceRicochet (enableTraceRicochet, 26.09) inside the client's own python27.dll.

  1. The name our code reads is a name the client's shell types have: 'enableTraceRicochet' is among the names of
     items/components/shell_components.pyc in the client's scripts.pkg (a typo in armor.shot_parameters would give
     every shell the default True, silently).
  2. armor.shot_parameters writes the key from the shell type: False when the type says so, True by default.
  3. The repair of older records (exporter.fix_shells -> fix_trace_ricochet) writes it BY POSITION from the shooter's
     stock descriptor into availableShells, the match candidates and the other mode's shells; never over a recorded
     key; nothing when the lists do not line up.

    python tests/py27/run27.py tests/py27/trace_ricochet.py
Verdict through BULLBA_PY27_RESULT (see run27.py)."""
import copy, marshal, os, sys, types, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
report = []
failures = []


def check(ok, name):
    report.append(('ok   ' if ok else 'FAIL ') + name)
    if not ok: failures.append(name)


def names(code):
    """Every name and string constant of a code object and the code objects inside it."""
    found = set(code.co_names) | set(code.co_varnames)
    for const in code.co_consts:
        if isinstance(const, str): found.add(const)
        elif isinstance(const, types.CodeType): found |= names(const)
    return found


# The client's constants module (shell kind -> type index) is imported by shot_parameters; a stand-in here.
sys.modules['constants'] = types.ModuleType('constants')
sys.modules['constants'].SHELL_TYPES_INDICES = {'ARMOR_PIERCING': 0, 'ARMOR_PIERCING_CR': 1, 'HOLLOW_CHARGE': 2, 'HIGH_EXPLOSIVE': 3}


class Obj(object):
    def __init__(self, **kw): self.__dict__.update(kw)


def shot(name, kind, caliber, effects, trace=None):
    kind_type = Obj(normalizationAngle=0.0349, ricochetAngleCos=0.342)
    if trace is not None: kind_type.enableTraceRicochet = trace
    shell = Obj(name=name, userString=name, kind=kind, caliber=caliber, effectsIndex=effects, piercingPowerRandomization=.25,
                piercingPowerRandomizationType='NORMAL', type=kind_type, armorDamage=(100, 100))
    return Obj(shell=shell, piercingPower=(100, 90), speed=900, gravity=9.81, maxDistance=720)


try:
    from local_armor_inspector import armor, exporter as ex

    # --- 1. the client's own name -------------------------------------------------------------------------------------
    pkg = os.path.join(GAME, 'res', 'packages', 'scripts.pkg')
    if not os.path.isfile(pkg):
        report.append('SKIP the client scripts.pkg is not at %s (BULLBA_GAME)' % pkg)
    else:
        with zipfile.ZipFile(pkg) as z:
            member = [n for n in z.namelist() if n.endswith('items/components/shell_components.pyc')]
            code = marshal.loads(z.read(member[0])[8:]) if member else None
        check(code is not None and 'enableTraceRicochet' in names(code),
              "the client's shell_components names enableTraceRicochet - the attribute shot_parameters reads")
        check(armor.shot_parameters.__code__.co_consts and 'enableTraceRicochet' in names(armor.shot_parameters.__code__),
              'shot_parameters reads that very name')

    # --- 2. shot_parameters --------------------------------------------------------------------------------------------
    check(armor.shot_parameters(shot('A', 'ARMOR_PIERCING', 57, 5, False), 'test')['traceRicochet'] is False,
          'shot_parameters: a type with enableTraceRicochet False writes traceRicochet False')
    check(armor.shot_parameters(shot('B', 'ARMOR_PIERCING', 57, 5, True), 'test')['traceRicochet'] is True
          and armor.shot_parameters(shot('C', 'HIGH_EXPLOSIVE', 57, 6), 'test')['traceRicochet'] is True,
          'shot_parameters: True when the type says so, and the client default True without the attribute')

    # --- 3. the repair of older records ----------------------------------------------------------------------------------
    stock = Obj(type=Obj(name='czech:Cz_Test'), hasSiegeMode=False,
                gun=Obj(name='g', shortUserString='57 mm', shots=[shot('JPNh', 'ARMOR_PIERCING', 57, 5, False),
                                                                    shot('HE', 'HIGH_EXPLOSIVE', 57, 6, True)]))
    built = []

    def fake_descr(compact):
        built.append(compact)
        return stock
    ex.vehicle_descr = fake_descr

    def live_list():
        # What the recorder wrote before 26.09: the live descriptor's list, without the key, and figures a battle
        # modifier changed (an effectsIndex, a damage roll) - the position still says which shell is which.
        shells = [dict(s) for s in armor.shot_candidates(stock)]
        for s in shells:
            s.pop('traceRicochet')
            s['effectsIndex'] += 100
            s['damageRandomization'] = .12
        return shells

    def old_hit():
        available = live_list()
        candidate = dict(available[0]); candidate['source'] = 'attacker descriptor matched by effectsIndex'
        return {'attacker': {'compactDescriptor': 'AAAA', 'type': 'czech:Cz_Test'}, 'availableShells': available,
                'shellCandidates': [candidate], 'shellStatus': 'matched', 'effectsIndex': 105}

    hit = old_hit()
    ex.fix_shells(hit)
    check([s.get('traceRicochet') for s in hit['availableShells']] == [False, True],
          'fix_shells: availableShells get the flag by position from the stock descriptor (JPNh False, HE True)')
    check(hit['shellCandidates'][0].get('traceRicochet') is False, 'fix_shells: the match candidate takes the flag of the live shell it equals')
    check(hit['availableShells'][0]['effectsIndex'] == 105 and hit['availableShells'][0]['damageRandomization'] == .12,
          'fix_shells: the live figures stay as recorded (only the key is added)')

    hit = old_hit(); hit['availableShells'][1]['traceRicochet'] = False
    ex.fix_shells(hit)
    check(hit['availableShells'][1]['traceRicochet'] is False, 'fix_shells: a recorded key is never overwritten')

    hit = old_hit(); hit['availableShells'].pop()
    ex.fix_shells(hit)
    check(not any('traceRicochet' in s for s in hit['availableShells'] + hit['shellCandidates']),
          'fix_shells: a list that does not line up with the stock one (length) gets nothing')
    hit = old_hit(); hit['availableShells'].reverse()
    ex.fix_shells(hit)
    check(not any('traceRicochet' in s for s in hit['availableShells']), 'fix_shells: nor one whose kinds differ by position')
    hit = old_hit(); hit['attacker']['type'] = 'czech:Other'
    ex.fix_shells(hit)
    check(not any('traceRicochet' in s for s in hit['availableShells']), 'fix_shells: nor a descriptor of another type')

    # The other mode's shells, read off that mode's descriptor.
    siege = Obj(type=stock.type, hasSiegeMode=False, gun=Obj(name='s', shots=[shot('JPNh', 'ARMOR_PIERCING', 57, 5, False)]))
    composite = Obj(type=stock.type, hasSiegeMode=True, siegeVehicleDescr=siege, defaultVehicleDescr=stock, gun=stock.gun)
    ex.vehicle_descr = lambda compact: composite
    hit = old_hit(); hit['attacker'].update(vehicleMode=0, modeShellsMode=1, modeShells=[dict(s) for s in armor.shot_candidates(siege)])
    hit['attacker']['modeShells'][0].pop('traceRicochet')
    ex.fix_shells(hit)
    check(hit['attacker']['modeShells'][0].get('traceRicochet') is False and [s.get('traceRicochet') for s in hit['availableShells']] == [False, True],
          'fix_shells: the other mode\'s shells from that mode\'s descriptor, the live ones from the recorded mode\'s')

    # A record of today: nothing to do, no descriptor built.
    ex.vehicle_descr = fake_descr
    del built[:]
    hit = old_hit()
    for s in hit['availableShells'] + hit['shellCandidates']: s['traceRicochet'] = True
    ex.fix_shells(hit)
    check(not built, 'fix_shells: a record that has the key builds no descriptor for it')
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
