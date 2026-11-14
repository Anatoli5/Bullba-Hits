# -*- coding: utf-8 -*-
"""One battle made from its replay, with the live record's two snapshots attached (11.11.2026).

The battle log comes from the saved replay (the user, 09-11.11): the replay is the source of every event of a battle;
in battle the mod keeps only two snapshots - the player's own shot (aim, circles) and the shown hit (the target's pose
and armour the page draws the scene from). build() takes the records replay_records.Converter made of one battle and the
live battle as read_battle reads it, and returns the battle in the shape Exporter.publish takes (the same keys
read_battle gives), so the published file is the one the page reads today:

- Every event is the replay's: hits (identity, raw points), crit records of every kind, the roster with the true maximum
  health, tracers / stops / explosions, the clock (gameTime). A battle takes all its events from one source: the two
  clocks differ by a per-battle constant of 0-0.17 s, and mixing them reorders events of one tick in the damage check
  (MEASURED 10.11, outputs/replay-records-parity-2026-11-10.md section 3).
- Matching. A replay record and a live record are the same event when they have the same key (a hit: attacker,
  target, damage and the raw points; a shot record: its kind and the server's shot id; a crit: its kind and vehicle,
  health figures or list position) and the nearest gameTime within a window - the pairing measured 10.11 (176 of 176
  hits). A matched record keeps the live record's id and receivedAt (the page links shots, commands and hits by those
  ids and times; ids and the wall clock are not events) and gets what only the live record has:
    hit   its scene: the fields replay_records.HIT_ABSENT names (part poses, armour, aim, shell candidates...), the
          resolved points (when their raw fields are the replay's), the warnings of the live record;
    shot  the own shot's snapshot (aimAtTracer, motion, the command link) and the shooter's state at the tracer
          (siegeState, gunState: the page's scene of a hit reads them; a tracer without a live twin has the replay's
          own, replay_records.Converter.shooter_state, since 12.11.2026), and the live 'command' and 'gunAfterShot'
          records, placed where they were among the shot records; an own tracer keeps the replay's own aim block
          (replay_aim.KEY, BACKLOG 82), which replay_aim.attach gives receipt times and the comparison with the snapshot;
    crit  nothing but id and receivedAt: its names come from the run-time Names of the conversion, as everywhere.
- A replay hit without a live one (the death camera: the recorder sees no vehicle event for ~15 s) is published as it
  is: no scene, 'replayAbsent' says what is missing, its points carry status 'replay-raw'. Nothing is guessed.
- A live record without a replay one (the user, 11.11: nothing the recorder saw is lost because the replay lacks it - a
  special mode's events the decoder may miss) is published from the live record, marked LIVE_ONLY (a hit also gets
  source 'live'), its gameTime moved onto the replay clock by the battle's measured clockOffset (the live figure kept
  in 'liveGameTime'), counted per kind in the report's 'livePublished' and said in the warnings. It has no twin of the
  same key in the replay, so it enters the damage log once. Not the ROUTINE_LIVE_ONLY kinds: the replay never carries
  those, they are counted only (measured on the 33 battles of 11.11: 0 live-only hits, health or other crits; 5
  explosions in 4 battles - shells ending at the muzzle tick, whose shot has a replay tracer and no replay end).
- Two scenes per hit (the user, 11.11): the in-game snapshot stays the hit's main scene, its fields where they are today
  (target, attacker, points, aim, ...). A scene rebuilt from the replay is added later beside it, under the one key
  SECOND_SCENE of the hit ('replayScene': a block of its own with the same field names), so the page can compare and
  switch per hit without another format change. Nothing writes that key yet; replay-only hits stay scene-less here.
- The header is the live one (client version, mode names, start time) marked source 'replay', with a 'replay' block:
  what was matched, what is scene-less, what was left out, the measured clock offset.

Pure: no file, no game module; the client's Python 2.7 and CPython 3. The exporter's entry is Exporter.publish_replay.
"""
from __future__ import absolute_import
import copy
import json

from . import replay_aim
from . import replay_aim_other

SOURCE = 'replay'
# Version of this assembly, in the battle's 'replay' block.
FORMAT = 1
HIT_WINDOW = 1.0
CRIT_WINDOW = 1.0
COLLISION_WINDOW = 2.0
SHOT_WINDOW = 5.0
SHOT_KINDS = ('tracer', 'stop', 'explosion')
# Keys of read_battle's result that are not the header.
BODY = ('hits', 'shotEvents', 'critEvents', 'warnings', 'roster', 'playerTeam', 'rosters')
# A matched hit's own fields that the replay hit carries only because it had no scene.
HIT_REPLAY_ONLY = ('replayAbsent', 'source', 'warnings')
POINT_RAW = ('part', 'effect', 'hitType', 'shellType', 'caliber')
# Ids of records with no live counterpart: never one of the recorder's ('1', 's1', 'c1').
NEW_ID = {'hit':'r', 'shot':'rs', 'crit':'rc'}
# Reserved: the key of a hit's second scene, rebuilt from the replay (a later step). The snapshot stays at the top level.
SECOND_SCENE = 'replayScene'
# Live records the replay never carries (measured 10-11.11 on six battles: outputs/replay-records-parity-2026-11-10.md).
ROUTINE_LIVE_ONLY = frozenset(('crit:collision', 'crit:damageInfo', 'crit:damageInfoReplay', 'crit:damagedDevicesVisible',
                               'crit:publicState'))
# The mark of a record published from the live record because the replay has no twin of it; a hit's source value.
LIVE_ONLY = 'liveOnly'
LIVE_SOURCE = 'live'
# The live header's 'recording' of a battle whose recorder kept the two snapshots only (BACKLOG 87,
# mod_local_armor_inspector.RECORDING_SNAPSHOTS): its other vehicles' shots, its shell ends and its crits have no live
# twin, so the receipt time the page links and clocks them by (receivedAt) is made from the replay: the receipt of a
# matched snapshot of the same tick, else the gameTime on the battle's wall clock (the median of live receivedAt - replay
# gameTime over the matched hits and own shots). Measured 12.11 on the four battles with both sources, the live record cut
# to the snapshots: the page's shot of a hit (tracer, stop, aim) the same for 175 of 176 hits; every receipt time but one
# within 0.05 s of the live one. A full battle's records are as before.
# Why a hit's stop can differ (12.11.2026): the page takes a shell's end as a hit's only within 0.1 s of receipt - one
# server tick - and a stop one tick before its hit was received 0.092-0.112 s before it in the live records (the client's
# receipt jitter, which the replay does not have): the one hit's stop came 0.094 s before it live, 0.102 s on the wall
# clock. On the 33 battles of 11.11 (offline names): 2 226 of 2 284 hits keep the full record's shot, 40 gain a stop, 18
# lose one; the stop of the next tick's receipt instead (tried) made it 2 190, 85, 9. Linked by the replay clock
# (gameTime, the same on both records) the page gives both the same shot for 2 284 of 2 284: the cure is the page's.
SNAPSHOTS = 'snapshots'
# The fields of a tracer that say the shooter's state at his shot (telemetry.ShotTelemetry.tracer; the replay's own since
# 12.11.2026, replay_records.Converter.shooter_state): a matched tracer takes the live one's.
SHOOTER_STATE = ('siegeState', 'gunState')


def number(value):
    try: return float(value)
    except (TypeError, ValueError): return None


def hit_key(r):
    return ('hit', r.get('attackerId'), r.get('targetId'), r.get('damage'), json.dumps(r.get('rawHitPoints'), sort_keys=True))


def crit_key(r):
    e = r.get('event')
    if e == 'collision': return (e, tuple(r.get('pair') or ()))
    if e == 'health': return (e, r.get('vehicleId'), r.get('attackerId'), r.get('oldHealth'), r.get('newHealth'))
    if e == 'damageInfo': return (e, r.get('vehicleId'), r.get('position'))
    if e == 'shotResults': return (e, r.get('shooterId'))
    return (e, r.get('vehicleId'))


def shot_key(r):
    return (r.get('event'), r.get('shotId'))


def pair(live, replay, key, window):
    """{id(replay record): live record}: each live record, in its order, takes the replay record of the same key nearest
    in gameTime within the window, which is then taken."""
    pool = {}
    for r in replay: pool.setdefault(key(r), []).append(r)
    out = {}
    for r in live:
        when = number(r.get('gameTime'))
        if when is None: continue
        cands = [c for c in pool.get(key(r), ()) if number(c.get('gameTime')) is not None
                 and abs(number(c['gameTime']) - when) <= window]
        if not cands: continue
        best = min(cands, key=lambda c: abs(number(c['gameTime']) - when))
        pool[key(r)].remove(best)
        out[id(best)] = r
    return out


def points_same(replay_points, live_points):
    """The live record's resolved points describe the replay's raw ones (same count, same raw fields)."""
    if not isinstance(live_points, list) or len(live_points) != len(replay_points or ()): return False
    return all(isinstance(b, dict) and all(a.get(k) == b.get(k) for k in POINT_RAW if k in a)
               for a, b in zip(replay_points, live_points))


def median(values):
    values = sorted(values)
    return round(values[len(values) // 2], 3) if values else None


def kind_name(kind, r):
    return kind if kind == 'hit' else kind + ':' + str(r.get('event'))


def from_live(r, offset):
    """A copy of a live record with no replay twin, marked, its gameTime on the replay clock (offset = replay - live)."""
    out = copy.deepcopy(r)
    out[LIVE_ONLY] = True
    when = number(r.get('gameTime'))
    if offset is not None and when is not None:
        out['liveGameTime'] = r['gameTime']
        out['gameTime'] = when + offset
    return out


def merge(rows, extra):
    """`rows` with each of `extra` put before the first row of a later gameTime (after rows of the same time; a row
    without a time never stops it); a record without a time goes last."""
    rows = list(rows)
    for e in extra:
        when = number(e.get('gameTime'))
        at = len(rows)
        if when is not None:
            for i, r in enumerate(rows):
                t = number(r.get('gameTime'))
                if t is not None and t > when:
                    at = i
                    break
        rows.insert(at, e)
    return rows


def build(records, live=None, battle_id=None):
    """(battle, report) of one battle: `records` the replay's (Converter output, header first), `live` the live battle as
    read_battle returns it or None, `battle_id` the id to publish under when there is no live battle. The battle is
    Exporter.publish's input; `report` is the battle's 'replay' block (counts of what was matched and left out)."""
    header = next((r for r in records if r.get('type') == 'battle'), None)
    if header is None: raise ValueError('Replay records without a battle header')
    rosters = [r for r in records if r.get('type') == 'roster']
    hits = [r for r in records if r.get('type') == 'hit']
    shots = [r for r in records if r.get('type') == 'shot']
    crits = [r for r in records if r.get('type') == 'crit']
    live = live or {}
    l_hits, l_shots, l_crits = live.get('hits') or [], live.get('shotEvents') or [], live.get('critEvents') or []
    l_kept_shots = [r for r in l_shots if r.get('event') in SHOT_KINDS]

    hit_live = pair(l_hits, hits, hit_key, HIT_WINDOW)
    shot_live = pair(l_kept_shots, shots, shot_key, SHOT_WINDOW)
    crit_live = pair([r for r in l_crits if r.get('event') != 'collision'], [r for r in crits if r.get('event') != 'collision'],
                     crit_key, CRIT_WINDOW)
    crit_live.update(pair([r for r in l_crits if r.get('event') == 'collision'], [r for r in crits if r.get('event') == 'collision'],
                          crit_key, COLLISION_WINDOW))
    offsets = [number(r['gameTime']) - number(m['gameTime']) for group, table in ((hits, hit_live), (shots, shot_live))
               for r in group for m in [table.get(id(r))] if m is not None
               and number(r.get('gameTime')) is not None and number(m.get('gameTime')) is not None]
    offset = median(offsets)
    wall, ticks = None, {}
    if live.get('recording') == SNAPSHOTS:
        known = [(number(r['gameTime']), number(m['receivedAt'])) for group, table in ((hits, hit_live), (shots, shot_live))
                 for r in group for m in [table.get(id(r))] if m is not None
                 and number(m.get('receivedAt')) is not None and number(r.get('gameTime')) is not None]
        wall = median([at - when for when, at in known])
        for when, at in known:
            key = round(when, 4)
            ticks[key] = min(at, ticks.get(key, at))
    on_wall = [0]

    def wall_time(record):
        """A record without a live twin of a snapshots-only battle: its receivedAt - the earliest receipt of a matched
        snapshot of the same replay tick (a tracer, its stop and its hit at close range share one; the page links them
        by receipt order), else its gameTime on the battle's wall clock."""
        when = number(record.get('gameTime'))
        if wall is not None and when is not None and 'receivedAt' not in record:
            record['receivedAt'] = ticks.get(round(when, 4), when + wall)
            on_wall[0] += 1

    # ---- what the live record had and the replay has not: published from the live record (not the routine kinds) ----
    matched = set(id(m) for table in (hit_live, shot_live, crit_live) for m in table.values())
    live_only, published_live, extra = {}, {}, {'hit':[], 'shot':[], 'crit':[]}
    for kind, rows in (('hit', l_hits), ('shot', l_kept_shots), ('crit', l_crits)):
        for r in rows:
            if id(r) in matched: continue
            name = kind_name(kind, r)
            live_only[name] = live_only.get(name, 0) + 1
            if name in ROUTINE_LIVE_ONLY: continue
            published_live[name] = published_live.get(name, 0) + 1
            extra[kind].append(from_live(r, offset))

    # ---- shots: the replay's, ids and the snapshot of the live ones ----------------------------------------------
    out_shots, ids, by_live = [], {}, {}
    for r in shots:
        m = shot_live.get(id(r))
        s = copy.deepcopy(r)
        if m is not None:
            # The shooter's state at his shot is the live tracer's where there is one (the in-game read, present or
            # not); the replay's (replay_records.Converter.shooter_state) stands for a tracer the live record lacks.
            for k in SHOOTER_STATE: s.pop(k, None)
            for k, v in m.items():
                if k not in s: s[k] = copy.deepcopy(v)
            s['id'], s['receivedAt'] = m.get('id'), m.get('receivedAt')
            if 'receivedAt' not in m: del s['receivedAt']
            by_live[m.get('id')] = s
        else:
            s['id'] = NEW_ID['shot'] + str(r.get('id', '')).lstrip('s')
            wall_time(s)
        ids[r.get('id')] = s['id']
        out_shots.append(s)
    for s in out_shots:
        if s.get('event') in ('stop', 'explosion') and s.get('tracerId') in ids: s['tracerId'] = ids[s['tracerId']]
    # The live records the replay has no kind of (the own fire command, the gun after the shot): after the record they
    # followed in the live list, or first when none of those is published.
    extras_after, anchor = {}, None
    for r in l_shots:
        if r.get('event') in SHOT_KINDS:
            if r.get('id') in by_live: anchor = r.get('id')
            continue
        extras_after.setdefault(anchor, []).append(copy.deepcopy(r))
    published_shots = list(extras_after.get(None, ()))
    for s in out_shots:
        published_shots.append(s)
        if s['id'] in by_live: published_shots.extend(extras_after.get(s['id'], ()))
    published_shots = merge(published_shots, extra['shot'])
    shot_ids = set(s.get('id') for s in published_shots)
    # The own shots' aim blocks rebuilt from the replay (BACKLOG 82): receipt times, and the comparison with the snapshot
    # the page draws where the live record has one.
    aim_blocks, aim_compared = replay_aim.attach(published_shots)
    # The other vehicles' estimated circles (replay_aim_other, put on the records by the replay job): counted.
    estimates, estimated = replay_aim_other.count(published_shots)

    # ---- hits: the replay's, the scene of the live ones -------------------------------------------------------------
    out_hits, sceneless, points_differ, candidates_dropped = [], 0, 0, 0
    for r in hits:
        m = hit_live.get(id(r))
        h = copy.deepcopy(r)
        if m is None:
            h['id'] = NEW_ID['hit'] + str(r.get('id', ''))
            sceneless += 1
            out_hits.append(h)
            continue
        same = points_same(r.get('points'), m.get('points'))
        for k in HIT_REPLAY_ONLY:
            h.pop(k, None)
        for k, v in m.items():
            if k not in h or k in ('id', 'receivedAt', 'warnings') or (k == 'points' and same): h[k] = copy.deepcopy(v)
        if not same:
            points_differ += 1
            h.setdefault('warnings', []).append('Replay hit: the live record\'s points differ from the replay\'s; the raw points are shown')
        if isinstance(h.get('traceCandidates'), list):
            kept = [c for c in h['traceCandidates'] if c in shot_ids]
            candidates_dropped += len(h['traceCandidates']) - len(kept)
            h['traceCandidates'] = kept
        out_hits.append(h)
    for h in extra['hit']:
        h['source'] = LIVE_SOURCE
        if isinstance(h.get('traceCandidates'), list):
            kept = [c for c in h['traceCandidates'] if c in shot_ids]
            candidates_dropped += len(h['traceCandidates']) - len(kept)
            h['traceCandidates'] = kept
    out_hits = merge(out_hits, extra['hit'])

    # ---- crits: the replay's, with the live ids ---------------------------------------------------------------------
    out_crits = []
    for r in crits:
        m = crit_live.get(id(r))
        c = copy.deepcopy(r)
        if m is not None:
            c['id'] = m.get('id')
            if 'receivedAt' in m: c['receivedAt'] = m['receivedAt']
        else:
            c['id'] = NEW_ID['crit'] + str(r.get('id', '')).lstrip('c')
            wall_time(c)
        out_crits.append(c)
    out_crits = merge(out_crits, extra['crit'])

    # ---- the battle ----------------------------------------------------------------------------------------------------
    base = live if live else header
    battle = dict((k, copy.deepcopy(v)) for k, v in base.items() if k not in BODY)
    if not live:
        battle['id'] = battle_id or header.get('id')
    for k in ('arenaId', 'playerVehicleId'):
        if k not in battle and k in header: battle[k] = header[k]
    battle['source'] = SOURCE
    report = {'format':FORMAT, 'recordsFormat':header.get('replayRecordsFormat'), 'liveRecord':bool(live),
              'hits':len(out_hits), 'hitsWithScene':len(out_hits) - sceneless, 'hitsWithoutScene':sceneless,
              'shots':len(out_shots), 'shotsMatched':len(shot_live),
              'liveShotRecordsAttached':len(published_shots) - len(out_shots) - len(extra['shot']),
              'crits':len(out_crits) - len(extra['crit']), 'critsMatched':len(crit_live), 'liveOnly':live_only,
              'livePublished':published_live, 'clockOffset':offset, 'aimBlocks':aim_blocks, 'aimCompared':aim_compared,
              'aimEstimates':estimates, 'aimEstimateCircles':estimated}
    for k, name in (('replayServerTimeAtStart', 'serverTimeAtStart'), ('replayClientVersion', 'clientVersion')):
        if header.get(k) is not None: report[name] = header[k]
    if wall is not None or live.get('recording') == SNAPSHOTS:
        report['liveRecording'] = SNAPSHOTS
        report['wallClock'] = wall
        report['receivedAtFromReplay'] = on_wall[0]
    if points_differ: report['pointsDiffer'] = points_differ
    if candidates_dropped: report['traceCandidatesDropped'] = candidates_dropped
    battle['replay'] = report
    warnings = list(live.get('warnings') or [])
    if not live:
        warnings.append('No live record of this battle: no hit has its scene (part poses, armour, aim)')
    elif sceneless:
        # Said of the snapshot only: such a hit gets its scene rebuilt from the replay afterwards (replay_scene.attach).
        warnings.append('%d hit(s) come from the replay only and have no in-game snapshot: the recorder did not see '
                        'them (part poses, armour and aim as the client had them were not recorded)' % sceneless)
    # The live records that never have a twin in the replay (contacts of rams between other vehicles, the client's own
    # damage-info echoes) are counted in the report ('liveOnly') and not said to the player: it is so in nearly every
    # battle. Any other live record without a twin (a hit, a shot) is published from the live record, and said.
    if published_live:
        warnings.append('%d record(s) of the live record are not in the replay; they are shown as the recorder had them (%s)'
                        % (sum(published_live.values()), ', '.join('%s %d' % kv for kv in sorted(published_live.items()))))
    roster = rosters[-1] if rosters else None
    battle.update({'hits':out_hits, 'shotEvents':published_shots, 'critEvents':out_crits, 'warnings':warnings})
    if roster is not None:
        battle.update({'roster':copy.deepcopy(roster.get('vehicles') or []), 'playerTeam':roster.get('playerTeam'), 'rosters':rosters})
        if roster.get('playerVehicleId'): battle['playerVehicleId'] = roster['playerVehicleId']
    return battle, report
