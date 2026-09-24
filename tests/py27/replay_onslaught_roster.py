# -*- coding: utf-8 -*-
"""The recorder driven by the client events of a real Onslaught battle, taken from its replay (24.09.2026).

Run:  python tests/py27/run27.py tests/py27/replay_onslaught_roster.py [MOD_DIR]   (default <repo>/mod)

Needs the local fixture tests/fixtures-local/replay-2026-09-24/onslaught-13506436.json (vehicle ids, teams, types,
maximum health and times of battle 13506436985564280, built from its replay with tools/replay_decode.py and from
its live record of recorder 0.7.33; no player names; private, so not in git). Without it: SKIP (exit 77).

What the replay says the client did, replayed through the stubs of recorder_two_battles.py:
  t = 0       the arena list: the allies with the vehicle they queued with (the live roster's descriptor figures),
              the enemies without a type; the allies' vehicles in view with the server's figure
  switches    five allies choose another vehicle (1.9-41.4 s): their arena info changes (onVehicleUpdated) and the
              vehicle is redrawn with its new maximum (publicInfo)
  creates     each enemy comes into view at its first creation in the replay
  death       the player's vehicle dies (262.6 s); Onslaught marks him an observer (setIsObserver)
  after       the 16 hits (showDamageFromShot) and 16 tracers (showTracer) the replay has after the death
Twice: A with the arena never learning the enemy types (the vehicles alone name them), B with the arena learning
each enemy type when he comes into view. What only a real battle can show: when the arena really learns them, and
whether Vehicle.maxHealth in the running client equals the replay's publicInfo figure (it is that property).
"""
import imp
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'replay-2026-09-24', 'onslaught-13506436.json')
sys.dont_write_bytecode = True


def finish(code, lines):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if isinstance(text, unicode) else text)
    else:
        sys.stdout.write(text)


rrd = rtb = check = note = checks = notes = WORLD = V3 = None


def load():
    """The stubs and helpers of recorder_roster_death.py (and through it recorder_two_battles.py)."""
    global rrd, rtb, check, note, checks, notes, WORLD, V3
    rrd = imp.load_source('recorder_roster_death27', os.path.join(HERE, 'recorder_roster_death.py'))
    rtb = rrd.rtb
    check, note, checks, notes = rtb.check, rtb.note, rtb.checks, rtb.notes
    WORLD, V3 = rtb.WORLD, rtb.V3


def battle(recorder, events, data, arena_id, learn_enemies):
    label = 'B (arena learns enemies)' if learn_enemies else 'A (vehicles alone)'
    own = data['playerVehicleId']
    vehicles = dict((v['id'], v) for v in data['vehicles'])
    own_team = vehicles[own]['team']
    b = rtb.Battle(arena_id, 1)                    # its avatar, input handler and arena shell; the vehicles below
    infos, entities = {}, {}
    for vid, v in vehicles.items():
        info = {'team': v['team'], 'name': 'player%d' % vid, 'avatarSessionID': 'x', 'vehPostProgression': [],
                'customRoleSlotTypeId': 0, 'vehicleType': None}
        if v['team'] == own_team:
            info['vehicleType'] = rrd.descriptor(v['headerType'], v.get('liveDescriptorMaxHealth') or v['headerMaxHealth'])
        infos[vid] = info
    b.arena.vehicles = infos
    b.avatar.playerVehicleID = own
    b.me = own
    timeline = []
    for vid, v in vehicles.items():
        for t in v['creates'][:1]: timeline.append((t, 0, 'create', vid, None))
        for s in v['switches']: timeline.append((s['t'], 1, 'switch', vid, s))
    timeline.append((data['deathT'], 2, 'death', own, None))
    for h in data['hitsAfterDeath']: timeline.append((h['t'], 3, 'hit', h['target'], h))
    for n, s in enumerate(data['tracersAfterDeath']): timeline.append((s['t'], 3, 'tracer', s['shooter'], s))
    timeline.sort(key=lambda e: (e[0], e[1]))
    WORLD.entities = {}
    WORLD.player = b.avatar
    events.onAvatarBecomePlayer()
    calls = dict(rtb.CALLS)
    for t, _, kind, vid, extra in timeline:
        v = vehicles[vid]
        if kind == 'create':
            # What publicInfo says at the creation: the queued vehicle and the header's figure before a switch,
            # else the vehicle and figure of the stream (the header's figure can differ: 4474198 2990 vs 2810).
            before = v['switches'] and t < v['switches'][0]['t']
            kind_type, figure = ((v['headerType'], v['headerMaxHealth']) if before
                                 else (v['finalType'], v['finalMaxHealth']))
            descr = rrd.descriptor(kind_type, figure)
            entity = rtb.make_vehicle(vid, descr)
            entity.maxHealth = figure
            WORLD.entities[vid] = entity
            if learn_enemies and infos[vid]['vehicleType'] is None:
                infos[vid]['vehicleType'] = descr
                b.arena.onVehicleUpdated(vid)
        elif kind == 'switch':
            descr = rrd.descriptor(extra['type'], extra['maxHealth'])
            infos[vid]['vehicleType'] = rrd.descriptor(extra['type'], int(extra['maxHealth'] / 1.1))
            b.arena.onVehicleUpdated(vid)             # the arena info first; the arena descriptor has no equipment
            WORLD.pump(1)
            entity = WORLD.entities.get(vid)
            if entity is not None:                      # then the client redraws the vehicle with its new maximum
                entity.typeDescriptor = descr
                entity.maxHealth = extra['maxHealth']
        elif kind == 'death':
            WORLD.entities[own].isAlive = lambda: False
            b.avatar.observer = True
        elif kind == 'hit':
            hit = {'networkID': 0, 'segment': 18446744073709551615, 'params': 2}
            WORLD.entities[vid].showDamageFromShot(extra['attacker'], [hit], 7, 0, 100, 1.0, False, 1000.0, 0)
        elif kind == 'tracer':
            b.avatar.showTracer(vid, extra['shotId'], extra['ricochet'], 7, 0, 2, 100.0, V3(0, 1, 0), V3(0, 0, 900),
                                9.81, 720.0, 0, 0)
        WORLD.pump(1)
    rows = rrd.records(recorder)
    WORLD.player = rtb.NS(name='account')
    events.onAvatarBecomeNonPlayer()
    WORLD.entities = {}
    group = 'replay ' + label
    rosters = [r for r in rows if r.get('type') == 'roster']
    final = dict((r['id'], r) for r in rosters[-1]['vehicles']) if rosters else {}
    typed = [vid for vid, v in vehicles.items() if final.get(vid, {}).get('type') == v['finalType']]
    check(group, 'the last roster names the vehicle each of the 14 really drove (%d/14)' % len(typed),
          len(typed) == len(vehicles) == 14,
          sorted((vid, final.get(vid, {}).get('type'), v['finalType']) for vid, v in vehicles.items() if vid not in typed))
    health = [vid for vid, v in vehicles.items() if final.get(vid, {}).get('maxHealth') == v['finalMaxHealth']
              and final.get(vid, {}).get('maxHealthFrom') == 'vehicle']
    check(group, 'and its maximum health as the server had it (replay publicInfo) (%d/14)' % len(health),
          len(health) == 14,
          sorted((vid, final.get(vid, {}).get('maxHealth'), v['finalMaxHealth']) for vid, v in vehicles.items()
                 if vid not in health))
    hits = [r for r in rows if r.get('type') == 'hit']
    tracers = [r for r in rows if r.get('type') == 'shot' and r.get('event') == 'tracer']
    check(group, 'the %d hits after the death are recorded, once each' % len(data['hitsAfterDeath']),
          len(hits) == len(data['hitsAfterDeath']) and len(set(h['id'] for h in hits)) == len(hits)
          and rtb.CALLS['Vehicle.showDamageFromShot'] - calls.get('Vehicle.showDamageFromShot', 0) == len(hits),
          len(hits))
    check(group, 'the %d tracers after the death are recorded, none as his own' % len(data['tracersAfterDeath']),
          len(tracers) == len(data['tracersAfterDeath']) and not any(t.get('own') for t in tracers), len(tracers))
    note('%s: %d roster records' % (label, len(rosters)))


def run(temp):
    with open(FIXTURE, 'rb') as stream: data = json.load(stream)
    mod, recorder, events, folder, capture = rrd.start(temp)
    if not check('setup', 'init() created the recorder', recorder is not None): return
    vehicles = data['vehicles']
    own_team = [v for v in vehicles if v['id'] == data['playerVehicleId']][0]['team']
    live_typed = sum(1 for v in vehicles if v['team'] == own_team)
    live_right = sum(1 for v in vehicles if v['team'] == own_team and not v['switches'])
    live_health = sum(1 for v in vehicles if v.get('liveDescriptorMaxHealth') == v['finalMaxHealth'])
    note('the live record of recorder 0.7.33: %d/14 typed (%d right, %d the queued vehicle), %d/14 with the '
         'server figure; it ended at %.1f s with the death, the replay has %d hits and %d tracers after it'
         % (live_typed, live_right, live_typed - live_right, live_health, data['liveLastT'],
            len(data['hitsAfterDeath']), len(data['tracersAfterDeath'])))
    for arena_id, learn in ((13506436985564281, False), (13506436985564282, True)):
        try: battle(recorder, events, data, arena_id, learn)
        except Exception: check('replay', 'ran without an exception', False, traceback.format_exc())
    mod.fini()


def main():
    import tempfile, shutil
    load()
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-replay27-')
    home = os.getcwd()
    crashed = None
    try: run(temp)
    except Exception: crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['replay onslaught roster: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed),
                                                                       time.time() - started)]
    for group, name, ok, detail in failed:
        lines.append('FAIL [%s] %s%s' % (group, name, (' -- %s' % (detail,)) if detail not in ('', None) else ''))
    if crashed: lines.append('FAIL [run] the script crashed:\n' + crashed)
    for text in notes: lines.append('note: ' + text)
    finish(1 if failed or crashed else 0, lines)


if __name__ == '__main__':
    if os.path.isfile(FIXTURE): main()
    else: finish(77, ['SKIP: replay fixture absent (%s)' % os.path.relpath(FIXTURE, REPO)])
