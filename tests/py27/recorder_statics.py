# -*- coding: utf-8 -*-
"""The recorder writes a vehicle's static half once per battle and refers to it (BACKLOG 27, 12.11.2026).

Run:  python tests/py27/run27.py tests/py27/recorder_statics.py [MOD_DIR]

The real mod with the client stubs of recorder_two_battles.py, under the client's own Python 2.7 (the start of
recorder_snapshots.py, imported). Checks, by group:
  once      six hits between three vehicles, each pair twice: one `static` record before the first hit that needs a
            half (three in all), none before the second round; the second round reads none of the static half from
            the client (aim block, armour, shells, identity, pitch table, wheels) and its hits refer to the same halves
  equal     the same hits recorded with the halves kept and with every hit read in full (the recorder of 1.06): the
            records every reader gets (records.RecordDecoder) are the same but for the receipt time, and the file of the
            first is smaller; exporter.read_battle reads it with no warning
  change    a new half - and a new `static` record - when the vehicle changes: another descriptor for the same vehicle id
            (an Onslaught switch, a respawn), the mode of a vehicle built twice, another collision model of a part;
            the decoded hit then carries the new vehicle
  hangar    leaving the battle keeps no half (no descriptor of the battle held in the hangar)

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import imp
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True
rs = imp.load_source('recorder_snapshots27', os.path.join(HERE, 'recorder_snapshots.py'))
rtb = rs.rtb
check, note, checks, notes = rtb.check, rtb.note, rtb.checks, rtb.notes
NS = rtb.NS


class Reads(object):
    """Counts of the client reads that make a static half, by name: wrapped where capture() looks them up."""
    def __init__(self, mod):
        import local_armor_inspector.exporter as exporter
        import local_armor_inspector.armor as armor
        import local_armor_inspector.presentation as presentation
        self.counts = {}
        self.saved = []
        for owner, name in ((exporter, 'aim_block'), (armor, 'live_materials'), (armor, 'shot_candidates'),
                            (presentation, 'gun_limits'), (mod, 'vehicle_identity'), (exporter, 'wheel_parts')):
            self.wrap(owner, name)

    def wrap(self, owner, name):
        original = getattr(owner, name)
        counts = self.counts
        def counted(*args, **kwargs):
            counts[name] = counts.get(name, 0) + 1
            return original(*args, **kwargs)
        self.saved.append((owner, name, original))
        setattr(owner, name, counted)

    def take(self):
        counts = dict(self.counts)
        self.counts.clear()
        return counts

    def close(self):
        for owner, name, original in self.saved: setattr(owner, name, original)


def hits_of(b, rounds=2):
    """Each pair twice: outgoing, incoming, other."""
    for _ in range(rounds):
        b.hit(b.enemy, b.me)
        b.hit(b.me, b.enemy)
        b.hit(b.ally, b.enemy)


def play(recorder, events, folder, arena_id, first, steps, shared=True):
    """One battle: its raw lines as written and its records as every reader gets them."""
    b = rs.battle(arena_id, first, 1, False, rs.CHECKED, recorder)
    saved = recorder.keep_shooter, recorder.keep_target
    if not shared:
        recorder.keep_shooter = lambda *args: None
        recorder.keep_target = lambda *args: None
    try:
        b.enter(events)
        steps(b)
        name = recorder.file
        held = len(recorder.statics)
        b.leave(events)
    finally:
        recorder.keep_shooter, recorder.keep_target = saved
    rows = rs.rows_of(recorder, folder, name)
    path = os.path.join(folder, name + '.jsonl')
    raw = rtb.read_jsonl(path, raw=True)[0]
    return b, name, path, raw, rows, held


def lean(hit):
    out = dict(hit)
    out.pop('receivedAt', None)
    return json.loads(json.dumps(out, sort_keys=True))


def run_checks(temp):
    mod, recorder, events, folder, capture = rs.start(temp)
    from local_armor_inspector.records import STATIC_RECORD, PitchTable
    import local_armor_inspector.presentation as presentation
    # The stub client has no gun_rotation_shared: one pitch table per compact descriptor and mode, as the real one keeps.
    tables = {}
    def stub_limits(descr, key=None):
        key = (key or descr.makeCompactDescr(), presentation.descriptor_mode(descr))
        if key not in tables: tables[key] = PitchTable({'samples': [[0.0, -0.1, 0.3]], 'mode': key[1]})
        return tables[key]
    presentation.gun_limits = stub_limits
    reads = Reads(mod)

    # ---- once ------------------------------------------------------------------------------------------------------
    marks = []
    def steps(b):
        hits_of(b, 1)
        marks.append(reads.take())
        hits_of(b, 1)
        marks.append(reads.take())
    reads.take()
    b, name, path, raw, rows, held = play(recorder, events, folder, 7100000000000000001, 61, steps)
    kinds = [r.get('type') for r in raw if r.get('type') in ('hit', STATIC_RECORD)]
    check('once', 'a static record right before each of the first three hits, none in the second round',
          kinds == [STATIC_RECORD, 'hit', STATIC_RECORD, 'hit', STATIC_RECORD, 'hit', 'hit', 'hit', 'hit'], kinds)
    statics = [r for r in raw if r.get('type') == STATIC_RECORD]
    defined = [k for r in statics for k in (r.get('staticTables') or {})]
    check('once', 'no definition written twice', len(defined) == len(set(defined)), defined)
    raw_hits = [r for r in raw if r.get('type') == 'hit']
    refs = [((h.get('attacker') or {}).get('vehicleRef'), (h.get('target') or {}).get('vehicleRef')) for h in raw_hits]
    check('once', 'every hit refers to its halves; the second round to the very same ones',
          all(a and t for a, t in refs) and refs[3:] == refs[:3], refs)
    check('once', 'the shell lists by reference too',
          all(h.get('availableShellsRef') and h.get('shellCandidatesRef') and 'availableShells' not in h for h in raw_hits),
          [sorted(h) for h in raw_hits[:1]])
    check('once', 'a hit line keeps no part, armour or pitch table of its own',
          all('parts' not in (h.get('target') or {}) and 'armorTables' not in h and 'pitchTables' not in h for h in raw_hits))
    first, second = marks
    check('once', 'the first round read the halves from the client',
          first.get('aim_block') and first.get('live_materials') and first.get('shot_candidates') and first.get('gun_limits'), first)
    check('once', 'the second round read nothing of them again (aim block, armour, shells, identity, pitch table, wheels)',
          not [k for k in ('aim_block', 'live_materials', 'shot_candidates', 'gun_limits', 'vehicle_identity', 'wheel_parts')
               if second.get(k)], second)
    check('once', 'three vehicles: five halves held in the battle (two shooters, three targets)',
          held == 5, held)
    hits = [r for r in rows if r.get('type') == 'hit']
    check('once', 'the decoded second round is the first one\'s scene',
          [lean(h)['target'] for h in hits[3:]] == [lean(h)['target'] for h in hits[:3]]
          and [lean(h)['attacker'] for h in hits[3:]] == [lean(h)['attacker'] for h in hits[:3]])
    check('once', 'the decoded target has its parts, posed, and its pitch table; the shooter his rest parts and aim',
          all(len(h['target']['parts']) == 4 and all('transform' in p and p.get('resource') for p in h['target']['parts'])
              and h['target'].get('gunPitchLimits') and h['attacker'].get('aim') and len(h['attacker']['parts']) == 4
              for h in hits), [sorted(h['target']) for h in hits[:1]])
    check('hangar', 'leaving the battle keeps no half', not recorder.statics, len(recorder.statics))

    # ---- equal -----------------------------------------------------------------------------------------------------
    def both(b): hits_of(b, 2)
    shared = play(recorder, events, folder, 7100000000000000011, 71, both, shared=True)
    full = play(recorder, events, folder, 7100000000000000012, 71, both, shared=False)
    a = [lean(r) for r in shared[4] if r.get('type') == 'hit']
    c = [lean(r) for r in full[4] if r.get('type') == 'hit']
    check('equal', 'six hits each way', len(a) == 6 and len(c) == 6, (len(a), len(c)))
    differ = [i for i, (x, y) in enumerate(zip(a, c)) if x != y]
    check('equal', 'kept halves and full reading: the same records but for the receipt time', not differ and a, differ[:3])
    check('equal', 'the full reading writes no static record and no reference (the recorder of 1.06)',
          not [r for r in full[3] if r.get('type') == STATIC_RECORD]
          and not [r for r in full[3] if r.get('type') == 'hit' and 'vehicleRef' in (r.get('target') or {})])
    size_shared, size_full = os.path.getsize(shared[2]), os.path.getsize(full[2])
    check('equal', 'the file with the halves by reference is smaller', size_shared < size_full, (size_shared, size_full))
    note('stand battle of six hits: %d bytes with the halves by reference, %d read in full' % (size_shared, size_full))
    from local_armor_inspector.exporter import read_battle
    battle = read_battle(shared[2])
    check('equal', 'exporter.read_battle reads it whole, with no warning',
          len(battle['hits']) == 6 and not battle['warnings'], battle['warnings'])

    # ---- change ----------------------------------------------------------------------------------------------------
    def changes(b):
        # Mine is built twice (a siege-mode vehicle), its siege descriptor's shell another: its hits carry the other mode's.
        mine = b.arena.vehicles[b.me]['vehicleType']
        siege = rtb.descriptor('usa:T81')
        siege.gun.shots[0].piercingPower = (250.0, 230.0)
        mine.hasSiegeMode, mine.vehicleMode = True, 0
        mine.defaultVehicleDescr, mine.siegeVehicleDescr = rtb.descriptor('usa:T81'), siege
        b.hit(b.enemy, b.me)                                       # 1: halves of me (shooter) and the enemy (target)
        # An Onslaught switch: the enemy's arena info and entity get another descriptor, another type.
        other = rtb.descriptor('usa:Switched')
        b.arena.vehicles[b.enemy]['vehicleType'] = other
        b.entities[b.enemy].typeDescriptor = other
        b.hit(b.enemy, b.me)                                       # 2: the target's new half
        b.hit(b.me, b.enemy)                                       # 3: the enemy shooting: his new type's half
        # Another collision model of a part on the same descriptor (a crashed hit tester, if the client switches one).
        other.hull.hitTesterManager = NS(activeHitTester=NS(bspModelName='vehicles/t/hull_crash.model'))
        b.hit(b.enemy, b.me)                                       # 4: the target's half again new
        # The mode of my vehicle: siege now.
        mine.vehicleMode = 1
        b.hit(b.enemy, b.me)                                       # 5: my shooter half new (mode 1)
        b.hit(b.enemy, b.me)                                       # 6: nothing new
    b, name, path, raw, rows, held = play(recorder, events, folder, 7100000000000000021, 81, changes)
    kinds = [r.get('type') for r in raw if r.get('type') in ('hit', STATIC_RECORD)]
    check('change', 'a static record before hits 1-5 (each brings a new half), none before 6',
          kinds == [STATIC_RECORD, 'hit'] * 5 + ['hit'], kinds)
    raw_hits = [r for r in raw if r.get('type') == 'hit']
    targets = [h['target']['vehicleRef'] for h in raw_hits]
    shooters = [h['attacker']['vehicleRef'] for h in raw_hits]
    check('change', 'the switched vehicle: a new target half, and another again with the other part model',
          len(set(targets[0:2] + targets[3:4])) == 3 and targets[3:] == [targets[3]] * 3, targets)
    check('change', 'the mode: a new shooter half from then on', shooters[4] != shooters[0] and shooters[5] == shooters[4]
          and shooters[1] == shooters[0], shooters)
    hits = [r for r in rows if r.get('type') == 'hit']
    check('change', 'decoded: the switched type, the new part model, the mode',
          hits[0]['target']['type'] == 'usa:T82' and hits[1]['target']['type'] == 'usa:Switched'
          and hits[2]['attacker']['type'] == 'usa:Switched'
          and [p.get('resource') for p in hits[3]['target']['parts']][1] == 'vehicles/t/hull_crash.model'
          and [p.get('resource') for p in hits[1]['target']['parts']][1] == 'vehicles/t/hull.model'
          and [h['attacker'].get('vehicleMode') for h in hits] == [0, 0, None, 0, 1, 1]
          and [h['attacker'].get('modeShellsMode') for h in hits] == [1, 1, None, 1, 0, 0],
          [(h['target'].get('type'), h['attacker'].get('type'), h['attacker'].get('vehicleMode'),
            h['attacker'].get('modeShellsMode')) for h in hits])

    reads.close()
    mod.fini()


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-statics27-')
    home = os.getcwd()
    crashed = None
    try:
        run_checks(temp)
    except Exception:
        crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['recorder statics: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed), time.time() - started)]
    for group, name, ok, detail in failed:
        lines.append('FAIL [%s] %s%s' % (group, name, (' -- %s' % (detail,)) if detail not in ('', None) else ''))
    if crashed: lines.append('FAIL [run] the script crashed:\n' + crashed)
    for text in notes: lines.append('note: ' + text)
    code = 1 if failed or crashed else 0
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if isinstance(text, unicode) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
