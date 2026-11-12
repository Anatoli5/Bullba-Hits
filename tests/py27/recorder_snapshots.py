# -*- coding: utf-8 -*-
"""The recorder in a battle whose replay is confirmed (BACKLOG 87): the two snapshots only; everywhere else in full.

Run:  python tests/py27/run27.py tests/py27/recorder_snapshots.py [MOD_DIR]            the checks
      python tests/py27/run27.py tests/py27/recorder_snapshots.py --measure LIVE.jsonl  the cost, full vs snapshots

The real mod with the client stubs and fixtures of recorder_two_battles.py (imported, not run), under the client's own
Python 2.7. The rule (mod_local_armor_inspector.recording_scope) needs three things the stubs give here: the battle's mode
(constants.ARENA_BONUS_TYPE_IDS names arena.bonusType), the client (Recorder.version, the text of version.xml) and a
replay recording at the battle's start (BattleReplay.g_replayCtrl.isRecording, with the mod's replay source present).

Checks, by group:
  snapshots  a random battle, recording, on the checked client: one log line 'recorder: snapshots only'; the header says
             recording 'snapshots'; the hits (all three, the incoming one with the shooter's motion), the command, the own
             tracers with their aim and the updates after them, the roster - and no other vehicle's tracer, no shell end,
             no crit record; nothing of another vehicle's tracer read (no gun-state read of it) and no crit hook past its
             gate (no record built, no ram contact measured)
  full       a mode not on the list, a battle with no recording, another client: one log line 'recorder: full, because'
             naming that condition; the records of today (recorder_two_battles: command, three tracers, a stop, two
             gunAfterShot; seven crits) and no 'recording' key in the header
  cost       in both: one line 'recorder: cost in this battle (<scope>, battle <id>)' at the battle's end whose calls per
             group (hit snapshots, own shot hooks, other hooks, roster events, sampler ticks) are the stand's own count of
             the calls of the hooks the recorder installed (an outer counting layer, Calls)

--measure drives one live record of the user's (its tracers, ends, commands, server aim updates, hits, health changes,
hit directions, ram, shot results) through the hooks of the stub client, with the motion sampler ticking every 0.2 s of
its gameTime over the 30 vehicles of its roster - first in full, then snapshots only, twice each - and prints the time
the hooks took on the game thread, the process CPU time (both threads), the sampler's share and the raw file size. The
stub client's own work is nearly nothing: the figures are the mod's Python work, not the game's cost of a real read.
It also prints the recorder's own cost line of each mode and what the measurement itself costs a call.

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import collections
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
CHECKED = '<version.xml>\r\n\t<version> v.2.4.1.1 #992 </version>\r\n</version.xml>'
OTHER = '<version.xml>\r\n\t<version> v.2.4.1.1 #993 </version>\r\n</version.xml>'
BONUS = {1: 'REGULAR', 2: 'TRAINING', 14: 'TOURNAMENT_REGULAR', 99: 'EVENT_X'}


class Replay(object):
    """The recorder's replay source as the rule sees it: present; its own work is replay_source's tests'."""
    def on_avatar_become_player(self, player): pass
    def on_avatar_become_non_player(self): pass
    def close(self): pass


def start(temp):
    """The mod copied to a temp folder, the stubs installed, init() run: (mod, recorder, events, folder, log)."""
    args = [a for a in sys.argv[1:] if not a.startswith('--') and not a.endswith('.jsonl')]
    source = os.path.abspath(args[0]) if args else os.path.join(REPO, 'mod')
    target = os.path.join(temp, 'mod')
    os.makedirs(os.path.join(target, 'local_armor_inspector'))
    for path in glob.glob(os.path.join(source, '*.py')) + glob.glob(os.path.join(source, 'local_armor_inspector', '*.py')):
        shutil.copy(path, os.path.join(target, os.path.relpath(path, source)))
    game = os.path.join(temp, 'game')
    os.makedirs(game)
    os.chdir(game)
    sys.path.insert(0, target)
    rtb.install_stubs()
    sys.modules['constants'].ARENA_BONUS_TYPE_IDS = BONUS
    sys.modules['constants'].ATTACK_REASONS = ('shot', 'fire', 'ramming')
    logger = logging.getLogger('local.armor_inspector')
    capture = rtb.Capture()
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    mod = imp.load_source('mod_local_armor_inspector', os.path.join(target, 'mod_local_armor_inspector.py'))
    mod.init()
    recorder = mod._recorder
    # The real replay source's thread and files are replay_source's tests' (tests/py27/replay_source.py).
    if getattr(recorder, 'replay', None) is not None: recorder.replay.close()
    recorder.replay = Replay()
    folder = os.path.join(game, 'mods', 'configs', 'local.armor_inspector', 'battles')
    return mod, recorder, sys.modules['PlayerEvents'].g_playerEvents, folder, capture


def rows_of(recorder, folder, name):
    writer = recorder.writer
    deadline = time.time() + 5
    while not writer.queue.empty() and time.time() < deadline: time.sleep(0.01)
    time.sleep(0.05)
    path = os.path.join(folder, name + '.jsonl')
    return rtb.read_jsonl(path)[0] if os.path.exists(path) else []


def battle(arena_id, first, bonus, recording, version, recorder):
    b = rtb.Battle(arena_id, first)
    b.arena.bonusType = bonus
    ctrl = sys.modules['BattleReplay'].g_replayCtrl
    ctrl.isRecording = recording
    recorder.version = version
    return b


def scope_lines(capture, arena_id):
    return [r.getMessage() for r in capture.records if r.getMessage().startswith('recorder: ')
            and not r.getMessage().startswith(COST_LINE) and str(arena_id) in r.getMessage()]


COST_LINE = 'recorder: cost in this battle ('
COST_NAMES = ('hit snapshots', 'own shot hooks', 'other hooks', 'roster events', 'sampler ticks')


def cost_lines(capture, arena_id):
    return [r.getMessage() for r in capture.records if r.getMessage().startswith(COST_LINE) and str(arena_id) in r.getMessage()]


def cost_counts(line):
    """{group name: (calls, total s, longest ms)} of one cost line."""
    import re
    out = {}
    for name in COST_NAMES:
        found = re.search(re.escape(name) + r' (\d+), total ([0-9.]+) s, longest ([0-9.]+) ms', line)
        if found: out[name] = (int(found.group(1)), float(found.group(2)), float(found.group(3)))
    return out


class Calls(object):
    """The stand's own count of the calls of every hook the recorder installed, by the group telemetry.Cost puts them
    in: an outer counting layer over the mod's wrappers, the sampler's sample() and the roster events. Taken off before
    fini() so the mod's unwrap finds its own wrappers."""
    OTHER_SHOT = ('stopTracer', 'explodeProjectile')

    def __init__(self, mod, recorder):
        self.counts = collections.Counter()
        self.saved = []
        hooks = [('hit snapshots', h) for h in [mod._hit_hook]]
        hooks += [('own shot hooks' if h[1] not in self.OTHER_SHOT else 'other hooks', h) for h in recorder.telemetry.hooks]
        hooks += [('other hooks', h) for h in recorder.crits.hooks]
        for group, (cls, name, _, wrapper) in hooks: self.layer(cls, name, wrapper, group)
        events = mod._events
        for name in ('on_vehicle_list', 'on_vehicle_info'):
            setattr(events, name, self.counting(getattr(events, name), 'roster events'))
        motion = recorder.motion
        motion.sample = self.counting(motion.sample, 'sampler ticks')
        self.events, self.motion = events, motion

    def counting(self, fn, group):
        def run(*args, **kwargs):
            self.counts[group] += 1
            return fn(*args, **kwargs)
        return run

    def layer(self, cls, name, wrapper, group):
        counts = self.counts
        def outer(instance, *args, **kwargs):
            if name == 'showTracer' and args and args[0] != getattr(instance, 'playerVehicleID', None):
                counts['other hooks'] += 1
            else: counts[group] += 1
            return wrapper(instance, *args, **kwargs)
        self.saved.append((cls, name, wrapper))
        setattr(cls, name, outer)

    def close(self):
        for cls, name, wrapper in reversed(self.saved): setattr(cls, name, wrapper)
        for name in ('on_vehicle_list', 'on_vehicle_info'): self.events.__dict__.pop(name, None)
        self.motion.__dict__.pop('sample', None)


def check_cost(capture, arena_id, scope, counts, group):
    """One cost line at the battle's end, its scope, and each group's calls as the stand counted them."""
    lines = cost_lines(capture, arena_id)
    check(group, 'cost: one log line at the battle end', len(lines) == 1, lines)
    if len(lines) != 1: return
    line = lines[0]
    check(group, 'cost: the line names the scope and the battle', line.startswith(COST_LINE + scope + ', battle %s)' % arena_id), line)
    found = cost_counts(line)
    want = dict((name, counts.get(name, 0)) for name in COST_NAMES)
    check(group, "cost: every group's calls are the stand's", dict((k, v[0]) for k, v in found.items()) == want, (found, want))
    check(group, 'cost: the hits, the hooks and the ticks were all called', all(want[k] for k in COST_NAMES if k != 'other hooks'), want)
    check(group, 'cost: the longest call is within the total', all(v[2] <= 1000.0 * v[1] + 0.5 for v in found.values()), found)


def run_checks(temp):
    mod, recorder, events, folder, capture = start(temp)
    telemetry_module = sys.modules['local_armor_inspector.telemetry']
    read_state = []
    original_state = telemetry_module.mechanic_state
    def counted_state(entity, own):
        read_state.append(entity.id)
        return original_state(entity, own)
    telemetry_module.mechanic_state = counted_state
    built, measured = [], []
    crits = recorder.crits
    original_emit, original_side = crits.emit, crits.contact_side
    def counted_emit(*args, **kwargs):
        built.append(args[1] if len(args) > 1 else None)
        return original_emit(*args, **kwargs)
    def counted_side(*args, **kwargs):
        measured.append(1)
        return original_side(*args, **kwargs)
    crits.emit, crits.contact_side = counted_emit, counted_side

    calls = Calls(mod, recorder)

    # ---- snapshots only -------------------------------------------------------------------------------------------
    r = battle(7000000000000000001, 41, 1, True, CHECKED, recorder)
    del read_state[:], built[:], measured[:]
    calls.counts.clear()
    r.enter(events)
    r.play(last_shot=True)
    name = recorder.file
    r.leave(events)
    check_cost(capture, r.arena_id, 'snapshots only', calls.counts, 'snapshots')
    rows = rows_of(recorder, folder, name)
    lines = scope_lines(capture, r.arena_id)
    check('snapshots', 'one log line: snapshots only', len(lines) == 1 and lines[0].startswith('recorder: snapshots only'), lines)
    header = rows[0] if rows else {}
    check('snapshots', 'the header says recording snapshots', header.get('type') == 'battle' and header.get('recording') == 'snapshots',
          header.get('recording'))
    shots = [x for x in rows if x.get('type') == 'shot']
    check('snapshots', 'shots: the command, the own tracers and the updates after them only',
          sorted(x.get('event') for x in shots) == ['command', 'gunAfterShot', 'gunAfterShot', 'tracer', 'tracer']
          and all(x.get('own') for x in shots if x.get('event') == 'tracer'), sorted(x.get('event') for x in shots))
    own = [x for x in shots if x.get('event') == 'tracer']
    check('snapshots', 'the own tracer keeps its aim snapshot and its command link',
          own and own[0].get('aimAtTracer') and own[0].get('possibleCommandId'), own[:1])
    check('snapshots', 'no crit record', not [x for x in rows if x.get('type') == 'crit'])
    hits = [x for x in rows if x.get('type') == 'hit']
    check('snapshots', 'the three hits, the incoming one with the shooter motion',
          [x.get('direction') for x in hits] == ['outgoing', 'incoming', 'other'] and (hits[1].get('attacker') or {}).get('motion'),
          [x.get('direction') for x in hits])
    check('snapshots', 'the hits keep their scene (parts, points resolved, shells)',
          all((x.get('target') or {}).get('parts') and x['points'][0].get('status') == 'resolved'
              and x.get('shellStatus') == 'matched' for x in hits))
    check('snapshots', 'the roster is written', [x for x in rows if x.get('type') == 'roster'])
    check('snapshots', 'no gun-state read of another vehicle\'s tracer (the two own tracers read theirs)',
          read_state == [r.me, r.me], list(read_state))
    check('snapshots', 'no crit hook went past its gate: no record built, no ram contact measured', not built and not measured,
          (list(built), len(measured)))

    # ---- full: each condition ------------------------------------------------------------------------------------
    for label, bonus, recording, version, why in (('a mode not on the list', 99, True, CHECKED, 'mode EVENT_X'),
                                                  ('no replay recording', 1, False, CHECKED, 'no replay recording'),
                                                  ('another client', 14, True, OTHER, 'client v.2.4.1.1 #993')):
        arena = 7000000000000000100 + bonus * 10 + int(bool(recording))
        f = battle(arena, 51, bonus, recording, version, recorder)
        del read_state[:], built[:], measured[:]
        calls.counts.clear()
        f.enter(events)
        f.play(last_shot=True)
        name = recorder.file
        f.leave(events)
        check_cost(capture, arena, 'full', calls.counts, 'full')
        rows = rows_of(recorder, folder, name)
        lines = scope_lines(capture, arena)
        check('full', label + ': one log line "full, because" naming it',
              len(lines) == 1 and lines[0].startswith('recorder: full, because ' + why), lines)
        check('full', label + ': no recording key in the header', rows and 'recording' not in rows[0], rows[:1])
        check('full', label + ': the shots of today',
              sorted(x.get('event') for x in rows if x.get('type') == 'shot')
              == ['command', 'gunAfterShot', 'gunAfterShot', 'stop', 'tracer', 'tracer', 'tracer'],
              sorted(x.get('event') for x in rows if x.get('type') == 'shot'))
        check('full', label + ': the crits of today',
              sorted(x.get('event') for x in rows if x.get('type') == 'crit')
              == ['collision', 'health', 'health', 'health', 'health', 'health', 'hitDirection'],
              sorted(x.get('event') for x in rows if x.get('type') == 'crit'))
        check('full', label + ': the other vehicle\'s tracer read its gun state', f.enemy in read_state and measured, list(read_state))

    telemetry_module.mechanic_state = original_state
    calls.close()
    mod.fini()
    errors = [x for x in capture.records if x.levelno >= logging.ERROR]
    check('log', 'no ERROR logged', not errors, '; '.join(x.getMessage() for x in errors[:5]))


# ---------------------------------------------------------------------------------------------------------------------
# --measure: one live record through the hooks
# ---------------------------------------------------------------------------------------------------------------------
class Driver(object):
    def __init__(self, path):
        self.rows = []
        with open(path, 'rb') as stream:
            for line in stream:
                if line.strip(): self.rows.append(json.loads(line))
        self.header = self.rows[0]
        rosters = [r for r in self.rows if r.get('type') == 'roster']
        self.roster = rosters[-1]['vehicles'] if rosters else []
        self.player_id = rosters[-1].get('playerVehicleId') if rosters else self.header.get('playerVehicleId')
        self.events = sorted((r for r in self.rows if r.get('type') in ('shot', 'crit', 'hit') and r.get('gameTime') is not None),
                             key=lambda r: r['gameTime'])

    def arena(self, arena_id):
        infos, entities = {}, {}
        for row in self.roster:
            vid = row['id']
            infos[vid] = {'vehicleType': rtb.descriptor(str(row.get('type') or 'usa:T%d' % vid)), 'team': row.get('team'),
                          'name': row.get('player'), 'avatarSessionID': 'x', 'vehPostProgression': [], 'customRoleSlotTypeId': 0}
            entities[vid] = rtb.make_vehicle(vid, infos[vid]['vehicleType'])
        arena = NS(arenaUniqueID=arena_id, vehicles=infos, arenaType=NS(name=self.header.get('map')), bonusType=1, guiType=1,
                   extraData={}, onNewVehicleListReceived=rtb.Event(), onVehicleAdded=rtb.Event(), onVehicleUpdated=rtb.Event())
        avatar = rtb.PlayerAvatar.__new__(rtb.PlayerAvatar)
        avatar.arena, avatar.playerVehicleID, avatar.observer = arena, self.player_id, False
        avatar.inputHandler = rtb.AvatarInputHandler.__new__(rtb.AvatarInputHandler)
        avatar.gunRotator = None
        return arena, entities, avatar

    def play(self, arena_id, events, sampler):
        """The battle through the hooks; returns (seconds in the hooks, seconds in the sampler's ticks, ticks, driven)."""
        arena, entities, avatar = self.arena(arena_id)
        WORLD.entities, WORLD.player = dict(entities), avatar
        start = self.events[0]['gameTime'] if self.events else 0.0
        WORLD.time = start
        events.onAvatarBecomePlayer()
        hooks, driven, ticks = 0.0, collections.Counter(), [0]
        sampled = [0.0]
        original = sampler.sample
        def timed():
            t0 = time.clock()
            original()
            sampled[0] += time.clock() - t0
            ticks[0] += 1
        sampler.sample = timed
        next_tick = start + 0.2
        for r in self.events:
            while next_tick <= r['gameTime']:
                WORLD.time = next_tick
                pending, WORLD.callbacks = WORLD.callbacks, {}
                for fn in pending.values(): fn()
                next_tick += 0.2
            WORLD.time = r['gameTime']
            t0 = time.clock()
            kind = self.fire(r, entities, avatar)
            hooks += time.clock() - t0
            driven[kind] += 1
        sampler.sample = original
        WORLD.player = NS(name='account')
        events.onAvatarBecomeNonPlayer()
        WORLD.entities = {}
        return hooks, sampled[0], ticks[0], driven

    def fire(self, r, entities, avatar):
        t, e = r.get('type'), r.get('event')
        try:
            if t == 'shot' and e == 'command':
                avatar._PlayerAvatar__startWaitingForShot(NS(gunIndexDelayed=r.get('gunIndex', 0), predictShooting=False))
            elif t == 'shot' and e == 'tracer':
                avatar.showTracer(r['shooterId'], int(r['shotId']), r.get('isRicochet', False), r.get('effectsIndex', 0), 0,
                                  r.get('shellTypeIdx', 0), r.get('caliber', 100.0), V3(*r['origin']), V3(*r['velocity']),
                                  r.get('gravity', 9.81), r.get('maxDistance', 700.0), r.get('gunIndex', 0),
                                  r.get('gunInstallationIndex', 0))
            elif t == 'shot' and e == 'stop':
                avatar.stopTracer(int(r['shotId']), V3(*r['position']))
            elif t == 'shot' and e == 'explosion':
                avatar.explodeProjectile(int(r['shotId']), 0, 0, r.get('material', 0), 0, 100.0, V3(*r['position']),
                                         V3(*(r.get('direction') or (0, 0, 1))), r.get('speed', 0.0), None)
            elif t == 'shot' and e == 'gunAfterShot':
                for u in r.get('updates') or ():
                    avatar.updateGunMarker(self.player_id, V3(*u['origin']), V3(*u['vector']), u['dispersionAngle'])
            elif t == 'hit':
                target = entities.get(r['targetId'])
                if target is None: return 'skipped'
                points = [{'networkID': 0, 'segment': 18446744073709551615, 'params': 2} for _ in r.get('rawHitPoints') or [0]]
                target.showDamageFromShot(r['attackerId'], points, r.get('effectsIndex', 0), 0, r.get('damage', 0),
                                          r.get('damageFactor', 1.0), r.get('lastMaterialIsShield', False),
                                          r.get('shellVelocity', 1000.0), r.get('gunInstallationIndex', 0))
                if r.get('damage'):   # the hit's own health change (reason 0): the crit hook's early return
                    target.onHealthChanged(1000, 1000 + int(r['damage']), r['attackerId'], 0)
            elif t == 'crit' and e == 'health':
                entities[r['vehicleId']].onHealthChanged(r['newHealth'], r['oldHealth'], r['attackerId'], r['attackReasonId'])
            elif t == 'crit' and e == 'hitDirection':
                avatar.showOwnVehicleHitDirection(r.get('hitDirYaw', 0.0), r['attackerId'], r['damage'], r['crits'],
                                                  r['isBlocked'], r['isShellHE'], r['vehicleId'], r['attackReasonId'])
            elif t == 'crit' and e == 'collision':
                pair = r.get('pair') or ()
                if len(pair) == 2 and pair[0] in entities and pair[1] in entities:
                    a, b = entities[pair[0]], entities[pair[1]]
                    avatar.handleVehicleCollidedVehicle(a, b, V3(*a.position), 1.0)
            elif t == 'crit' and e == 'shotResults':
                avatar.showShotResults([NS(vehicleID=x['vehicleId'], hitFlags=x['hitFlags'],
                                           gunInstallationIndex=x.get('gunInstallationIndex', 0)) for x in r.get('results') or ()])
            else:
                return 'not driven: %s %s' % (t, e)
        except KeyError:
            return 'skipped'
        return '%s %s' % (t, e) if e else t


def measure(temp, path):
    mod, recorder, events, folder, capture = start(temp)
    recorder.version = CHECKED
    ctrl = sys.modules['BattleReplay'].g_replayCtrl
    driver = Driver(path)
    lines, results = [], collections.defaultdict(list)
    for round_ in range(2):
        for label, recording in (('full', False), ('snapshots', True)):
            ctrl.isRecording = recording
            arena_id = 8000000000000000000 + round_ * 10 + int(recording)
            cpu0 = sum(os.times()[:2])
            wall0 = time.time()
            hooks, sampled, ticks, driven = driver.play(arena_id, events, recorder.motion)
            name = recorder.file
            rows = rows_of(recorder, folder, name)
            cpu = sum(os.times()[:2]) - cpu0
            size = os.path.getsize(os.path.join(folder, name + '.jsonl'))
            results[label].append((hooks, sampled, ticks, cpu, size, len(rows)))
            if round_ == 1: lines.extend(cost_lines(capture, arena_id))
            if round_ == 0 and label == 'full':
                lines.append('driven: ' + ', '.join('%s %d' % kv for kv in sorted(driven.items())))
    for label in ('full', 'snapshots'):
        hooks, sampled, ticks, cpu, size, n = results[label][-1]
        lines.append('%-9s hooks %.3f s on the game thread, sampler %.3f s in %d ticks (%.2f ms a tick), process CPU %.2f s '
                     '(incl. the stand\'s own and the writer), raw file %d bytes, %d records'
                     % (label, hooks, sampled, ticks, 1000.0 * sampled / max(ticks, 1), cpu, size, n))
    lines.append(overhead(recorder.cost))
    mod.fini()
    note('\n'.join(lines))


def overhead(cost, n=200000):
    """What the measurement itself costs: two clock reads and Cost.add per call, against the same loop without them."""
    from local_armor_inspector.telemetry import CLOCK, OWN
    add, clock = cost.add, time.clock
    t0 = clock()
    for _ in xrange(n):
        a = CLOCK()
        add(OWN, CLOCK() - a)
    timed_ = clock() - t0
    t0 = clock()
    for _ in xrange(n): pass
    bare = clock() - t0
    per = (timed_ - bare) / n
    cost.reset()
    return 'the measurement itself: %.2f us a call (two clock reads and Cost.add, %d calls)' % (1e6 * per, n)


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-snap27-')
    home = os.getcwd()
    crashed = None
    target = [a for a in sys.argv[1:] if a.endswith('.jsonl')]
    try:
        if '--measure' in sys.argv and target: measure(temp, os.path.abspath(os.path.join(home, target[0])))
        else: run_checks(temp)
    except Exception:
        crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['recorder snapshots: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed), time.time() - started)]
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
