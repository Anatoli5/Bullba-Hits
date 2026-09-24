# -*- coding: utf-8 -*-
"""The roster of an Onslaught battle and the recording after the player's death, under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/recorder_roster_death.py [MOD_DIR]   (default <repo>/mod)

The real mod with the client stubs and fixtures of recorder_two_battles.py (imported, not run). Defects found by
the replay decoder in the Onslaught battle of 24.09 (outputs/replay-decoder-2026-09-24.md, docs/KNOWLEDGE.md 18):

  onslaught  the first arena list has the allies with the vehicle they queued with and the enemies without a type;
             an ally's choice changes his arena info (arena.onVehicleUpdated), the client redraws him later;
             an enemy comes into view before the arena knows its type, and the arena learns it later. The last
             roster record must follow all of it, carry the server's maximum health of every vehicle in view
             (Vehicle.maxHealth) over the arena descriptor's figure, and no event without a change may add a
             record (REC-11)
  death      the player dies and Onslaught marks him an observer (Comp7BattlePage._switchToPostmortem ->
             setIsObserver): the hits, tracers and health changes between the others are still recorded, once
             each; the sampler keeps running; nothing of his own is invented
  seat       a spectator seat (ussr:Observer), a seat whose type is not known yet with the client's observer
             flag, and a replay being played write no battle file
  reset      two battles in a row with the same vehicle ids and figures: the second battle's roster has its own
             rows from the vehicles in view; nothing of the first is kept

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import glob
import imp
import json
import logging
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
rtb = imp.load_source('recorder_two_battles27', os.path.join(HERE, 'recorder_two_battles.py'))
check, note, checks, notes = rtb.check, rtb.note, rtb.checks, rtb.notes
WORLD, NS, V3 = rtb.WORLD, rtb.NS, rtb.V3


def start(temp):
    """The mod copied to a temp folder, the stubs installed, init() run: (mod, recorder, events, folder, log)."""
    source = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(REPO, 'mod')
    target = os.path.join(temp, 'mod')
    os.makedirs(os.path.join(target, 'local_armor_inspector'))
    for path in glob.glob(os.path.join(source, '*.py')) + glob.glob(os.path.join(source, 'local_armor_inspector', '*.py')):
        shutil.copy(path, os.path.join(target, os.path.relpath(path, source)))
    game = os.path.join(temp, 'game')
    os.makedirs(game)
    os.chdir(game)
    sys.path.insert(0, target)
    rtb.install_stubs()
    logger = logging.getLogger('local.armor_inspector')
    capture = rtb.Capture()
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    mod = imp.load_source('mod_local_armor_inspector', os.path.join(target, 'mod_local_armor_inspector.py'))
    mod.init()
    folder = os.path.join(game, 'mods', 'configs', 'local.armor_inspector', 'battles')
    return mod, mod._recorder, sys.modules['PlayerEvents'].g_playerEvents, folder, capture


def records(recorder, kind=None):
    """The rows written so far to the recorder's current file (the Writer thread drained first)."""
    writer = recorder.writer
    deadline = time.time() + 5
    while not writer.queue.empty() and time.time() < deadline: time.sleep(0.01)
    time.sleep(0.05)
    path = os.path.join(writer.folder, recorder.file + '.jsonl')
    rows = rtb.read_jsonl(path)[0] if os.path.exists(path) else []
    return [r for r in rows if kind is None or r.get('type') == kind]


def row_of(roster, vehicle_id):
    for row in (roster or {}).get('vehicles') or ():
        if row.get('id') == vehicle_id: return row
    return {}


def last_roster(recorder):
    rosters = records(recorder, 'roster')
    return rosters[-1] if rosters else None


def descriptor(type_name, max_health, tags=('mediumTank',)):
    descr = rtb.descriptor(type_name, tags)
    descr.maxHealth = max_health
    return descr


# ---------------------------------------------------------------------------------------------------------
def onslaught(recorder, events):
    group = 'onslaught'
    o = rtb.Battle(7770000000000000001, 41)
    leo = descriptor('germany:G89_Leopard1', 2500)
    o.arena.vehicles[o.ally]['vehicleType'] = leo
    o.entities[o.ally] = rtb.make_vehicle(o.ally, leo)
    enemy_descr = descriptor('czech:Cz17_Vz_55', 2600)
    enemy_entity = rtb.make_vehicle(o.enemy, enemy_descr)
    enemy_entity.maxHealth = 2810              # the server's figure: above the descriptor's (equipment)
    o.arena.vehicles[o.enemy]['vehicleType'] = None
    del o.entities[o.enemy]                    # not in view yet
    o.enter(events)
    WORLD.pump(2)
    first = last_roster(recorder)
    check(group, 'the first roster lists the enemy without a type and the ally with his queued vehicle',
          first is not None and 'type' not in row_of(first, o.enemy)
          and row_of(first, o.ally).get('type') == 'germany:G89_Leopard1', first and first.get('vehicles'))
    check(group, 'a vehicle in view gets the server figure (maxHealthFrom vehicle)',
          row_of(first, o.ally).get('maxHealth') == 2500 and row_of(first, o.ally).get('maxHealthFrom') == 'vehicle'
          and row_of(first, o.me).get('maxHealthFrom') == 'vehicle', row_of(first, o.ally))
    count = len(records(recorder, 'roster'))
    o.arena.onVehicleUpdated(o.me)              # a death flag, a frag count: nothing of the roster changes
    o.arena.onVehicleAdded(o.me)
    WORLD.pump(3)
    check(group, 'an arena event or a tick without a change writes no roster (REC-11)',
          len(records(recorder, 'roster')) == count, (count, len(records(recorder, 'roster'))))

    # The ally chooses another vehicle: the arena info changes at once, the entity is redrawn later.
    e50 = descriptor('germany:G73_E50_Ausf_M', 2750)
    o.arena.vehicles[o.ally]['vehicleType'] = e50
    o.arena.onVehicleUpdated(o.ally)
    switched = last_roster(recorder)
    check(group, 'the choice reaches the roster by arena.onVehicleUpdated (type and descriptor figure)',
          row_of(switched, o.ally).get('type') == 'germany:G73_E50_Ausf_M'
          and row_of(switched, o.ally).get('maxHealth') == 2750
          and row_of(switched, o.ally).get('maxHealthFrom') == 'descriptor', row_of(switched, o.ally))
    WORLD.pump(1)
    check(group, 'the not yet redrawn entity (old type) does not override the new arena type',
          row_of(last_roster(recorder), o.ally).get('type') == 'germany:G73_E50_Ausf_M', row_of(last_roster(recorder), o.ally))
    ally = WORLD.entities[o.ally]
    ally.typeDescriptor = e50
    ally.maxHealth = 3030
    WORLD.pump(1)
    check(group, 'once redrawn, the server figure of the new vehicle replaces the descriptor one',
          row_of(last_roster(recorder), o.ally).get('maxHealth') == 3030
          and row_of(last_roster(recorder), o.ally).get('maxHealthFrom') == 'vehicle', row_of(last_roster(recorder), o.ally))

    # The enemy comes into view before the arena knows his type.
    WORLD.entities[o.enemy] = enemy_entity
    WORLD.pump(1)
    seen = row_of(last_roster(recorder), o.enemy)
    check(group, 'an enemy in view without an arena type gets type, name and the server figure from the vehicle',
          seen.get('type') == 'czech:Cz17_Vz_55' and seen.get('name') == 'Cz17_Vz_55' and seen.get('maxHealth') == 2810
          and seen.get('maxHealthFrom') == 'vehicle' and seen.get('isBot') is False and seen.get('team') == 2, seen)
    # The arena learns the enemy type later.
    o.arena.vehicles[o.enemy]['vehicleType'] = enemy_descr
    o.arena.onVehicleUpdated(o.enemy)
    learnt = row_of(last_roster(recorder), o.enemy)
    check(group, 'the arena type of the enemy keeps the server figure of the same type',
          learnt.get('type') == 'czech:Cz17_Vz_55' and learnt.get('maxHealth') == 2810
          and learnt.get('maxHealthFrom') == 'vehicle' and 'vehPostProgression' in learnt, learnt)
    final = last_roster(recorder)
    check(group, 'the last roster names every vehicle with type and a figure',
          all(r.get('type') and r.get('maxHealth') for r in final['vehicles']), final['vehicles'])
    rosters = records(recorder, 'roster')
    check(group, 'every roster record differs from the one before it',
          all(rosters[i]['vehicles'] != rosters[i - 1]['vehicles'] for i in range(1, len(rosters))), len(rosters))
    note('onslaught: %d roster records for %d changes' % (len(rosters), 6))
    o.leave(events)
    check(group, 'leaving: onVehicleUpdated unsubscribed', not o.arena.onVehicleUpdated.handlers)


def death(recorder, events):
    group = 'death'
    d = rtb.Battle(7770000000000000002, 51)
    d.enter(events)
    d.play()
    hits_before = len(records(recorder, 'hit'))
    samples = dict((k, len(v)) for k, v in recorder.motion.buffers.items())
    calls = dict(rtb.CALLS)
    # The player dies; Onslaught's battle page marks him an observer (Comp7BattlePage._switchToPostmortem).
    WORLD.entities[d.me].isAlive = lambda: False
    d.avatar.observer = True
    t0 = WORLD.time
    d.hit(d.ally, d.enemy)
    d.hit(d.enemy, d.ally)
    d.tracer(d.enemy, 99001)
    d.tracer(d.ally, 99002)
    d.avatar.stopTracer(99001, V3(0, 0, 40))
    d.entities[d.ally].onHealthChanged(500, 700, d.enemy, 1)
    WORLD.pump(2)
    rows = records(recorder)
    after = [r for r in rows if (r.get('gameTime') or 0) >= t0]
    hits = [r for r in after if r.get('type') == 'hit']
    tracers = [r for r in after if r.get('type') == 'shot' and r.get('event') == 'tracer']
    check(group, 'the gate stays open after the death (the seat, not the observer flag)',
          recorder.recording(recorder, d.avatar) and recorder.telemetry.active(d.avatar) and recorder.crits.active(d.avatar))
    check(group, 'the two hits between the others after the death are recorded as other',
          [h.get('direction') for h in hits] == ['other', 'other'], [h.get('direction') for h in hits])
    check(group, 'their tracers and the stop are recorded, none as his own',
          len(tracers) == 2 and not any(t.get('own') for t in tracers)
          and any(r.get('event') == 'stop' for r in after if r.get('type') == 'shot'), [t.get('own') for t in tracers])
    check(group, 'the health change after the death is recorded',
          any(r.get('type') == 'crit' and r.get('event') == 'health' for r in after))
    check(group, 'each after-death event once: hit ids unique, the originals ran once per call',
          len(records(recorder, 'hit')) == hits_before + 2
          and len(set(h.get('id') for h in records(recorder, 'hit'))) == hits_before + 2
          and rtb.CALLS['Vehicle.showDamageFromShot'] - calls.get('Vehicle.showDamageFromShot', 0) == 2
          and rtb.CALLS['PlayerAvatar.showTracer'] - calls.get('PlayerAvatar.showTracer', 0) == 2)
    check(group, 'nothing of his own after the death (no command, no own tracer)',
          not [r for r in after if r.get('type') == 'shot' and (r.get('event') == 'command' or r.get('own'))])
    grown = dict((k, len(v) - samples.get(k, 0)) for k, v in recorder.motion.buffers.items())
    check(group, 'the motion sampler keeps sampling the living, not the wreck',
          recorder.motion.running and grown.get(d.ally, 0) > 0 and grown.get(d.enemy, 0) > 0 and grown.get(d.me, 0) == 0,
          grown)
    d.leave(events)


def seat(recorder, events, folder):
    group = 'seat'
    spectator = rtb.Battle(7770000000000000003, 61, observer=True)
    unknown = rtb.Battle(7770000000000000004, 71)
    unknown.arena.vehicles[unknown.me]['vehicleType'] = None
    unknown.avatar.observer = True
    replay = rtb.Battle(7770000000000000005, 81)
    ctrl = sys.modules['BattleReplay'].g_replayCtrl
    for label, battle in (('spectator seat (ussr:Observer)', spectator),
                          ('seat without a type yet, the client flag set', unknown), ('replay being played', replay)):
        ctrl.isPlaying = battle is replay
        battle.enter(events)
        battle.play()
        battle.leave(events)
        ctrl.isPlaying = False
        names = [n for n in os.listdir(folder) if n.startswith(str(battle.arena_id))] if os.path.isdir(folder) else []
        check(group, 'a %s writes no battle file' % label, not names, names)


def reset(recorder, events):
    group = 'reset'
    first = rtb.Battle(7770000000000000011, 91)
    first.enter(events)
    WORLD.pump(2)
    first.hit(first.enemy, first.me)
    file_first = recorder.file
    first.leave(events)
    second = rtb.Battle(7770000000000000012, 91)      # the same vehicle ids, types and figures
    second.enter(events)
    WORLD.pump(2)
    check(group, 'the second battle keeps only its own vehicle facts',
          recorder.file != file_first and set(recorder.roster_seen) == second.ids
          and all(entry[0][0] == second.arena_id for entry in recorder.roster_seen.values()),
          sorted((k, v[0]) for k, v in recorder.roster_seen.items()))
    roster = last_roster(recorder)
    check(group, 'its roster has every row from its own vehicles in view',
          roster is not None and all(r.get('maxHealthFrom') == 'vehicle' for r in roster['vehicles'])
          and set(r['id'] for r in roster['vehicles']) == second.ids, roster and roster['vehicles'])
    second.leave(events)


def run(temp):
    mod, recorder, events, folder, capture = start(temp)
    if not check('setup', 'init() created the recorder', recorder is not None): return
    for scenario in (onslaught, death, reset):
        try: scenario(recorder, events)
        except Exception: check(scenario.__name__, 'ran without an exception', False, traceback.format_exc())
    try: seat(recorder, events, folder)
    except Exception: check('seat', 'ran without an exception', False, traceback.format_exc())
    mod.fini()
    errors = [r for r in capture.records if r.levelno >= logging.ERROR]
    check('log', 'no ERROR logged', not errors, '; '.join(r.getMessage() for r in errors[:5]))
    failures = sorted(set(r.getMessage() for r in capture.records if r.levelno == logging.DEBUG
                          and ('unavailable' in r.getMessage() or 'skipped' in r.getMessage())))
    check('log', 'no hook callback or roster fact failed (DEBUG)', not failures, failures)


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-roster27-')
    home = os.getcwd()
    crashed = None
    try: run(temp)
    except Exception: crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['recorder roster and death: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed),
                                                                         time.time() - started)]
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
