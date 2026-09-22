# -*- coding: utf-8 -*-
"""Tie the client's crit records to the recorded hits (22.09). Pure Python 2.7/3: no client import.

The recorder (crit_log.py) writes what the client received, with times and vehicles; this module decides which
hit each record belongs to and puts the result on the hit as hit['crits']. It runs in the exporter on every
publish and in the offline tools, so a better rule re-ties every recorded battle. Nothing old is guessed: a
battle recorded before the crit log gets only the crit code its own hit record carries.
Design: outputs/crits-design-2026-09-22.md, section 2 (local agent context).
"""
from __future__ import absolute_import
import numbers

# Design choice, to be calibrated by the logging test of one battle (design 6.2): channels sent with the shot
# against state channels. Recorded tracer-to-hit arrival offsets are -0.10...+0.18 s.
WINDOW_EXACT = 0.35
WINDOW_STATE = 1.0
# How long after flames appear a fire tick may name the arsonist (design choice).
FIRE_FOLLOW = 3.0
TIES = ('record', 'unique', 'nearest', 'shared', 'time-only')   # strongest first
CREW = ('commander', 'driver', 'radioman', 'gunner', 'loader')
AT_SHOT = {'DEVICE_CRITICAL_AT_SHOT':'critical', 'DEVICE_DESTROYED_AT_SHOT':'destroyed', 'TANKMAN_HIT_AT_SHOT':'injured',
           'DEATH_FROM_DEVICE_EXPLOSION_AT_SHOT':'detonated'}
# constants.DAMAGE_INFO_CODES of NA 2.4.0.1, only for a record whose code name is missing.
AT_SHOT_INDEX = {3:'DEVICE_CRITICAL_AT_SHOT', 4:'DEVICE_DESTROYED_AT_SHOT', 7:'TANKMAN_HIT_AT_SHOT',
                 8:'DEATH_FROM_DEVICE_EXPLOSION_AT_SHOT'}
DIRECT = ('ATTACK_IS_DIRECT_PROJECTILE', 'ATTACK_IS_RICOCHET_PROJECTILE')
SPLASH_FLAGS = ('DEVICE_DAMAGED_BY_EXPLOSION', 'CHASSIS_DAMAGED_BY_EXPLOSION', 'GUN_DAMAGED_BY_EXPLOSION', 'FIRE_STARTED')
# Bit 8 of the hit indicator's mask is STUN_PLACEHOLDER (the client's critsParserGenerator drops it): not a crit.
STUN = 256
# Records that are only counted in critStats: they never move a tie (moves_tie).
COUNTED = ('explosion', 'extraHit', 'damageInfoReplay', 'damagedDevicesVisible')


def number(value):
    return float(value) if isinstance(value, numbers.Real) and not isinstance(value, bool) else None


def effects(hit):
    return [p.get('effect') for p in hit.get('points') or [] if isinstance(p, dict)
            and isinstance(p.get('effect'), numbers.Integral) and not isinstance(p.get('effect'), bool)]


def last_code(hit):
    """The last decoded point's effect when it is 5 (CRITICAL_HIT) or 6 (ARMOR_PIERCED_DEVICE_DAMAGED)."""
    codes = effects(hit)
    return codes[-1] if codes and codes[-1] in (5, 6) else None


def last_part(hit):
    points = [p for p in hit.get('points') or [] if isinstance(p, dict)]
    return points[-1].get('part') if points else None


def kind_of(kind):
    return 'crew' if kind in CREW else 'device'


def rank(tie):
    return TIES.index(tie) if tie in TIES else len(TIES)


def at_shot(event):
    """The item state of a damage-report entry caused by a shot; None for fire, ramming, world, repair."""
    return AT_SHOT.get(event.get('damageCode') or AT_SHOT_INDEX.get(event.get('damageIndex')))


def fire_at_shot(event):
    note = event.get('notification') or ('DEVICE_STARTED_FIRE_AT_SHOT' if event.get('notificationIndex') == 0 else None)
    return note == 'DEVICE_STARTED_FIRE_AT_SHOT'


def shot_row(row):
    """A CRIT / RECEIVED_CRIT row caused by a shot, not by fire, ramming and the like (details >> 16 & 255)."""
    return row.get('attackReasonId') in (0, None)


def covers(identified, generic):
    """An identified module (it has an extra) stands for a type-level item of the same kind."""
    if identified.get('kind') != generic.get('kind'): return False
    kind = generic.get('type')
    return (identified.get('type') == kind or kind == 'chassis' and identified.get('type') in ('track', 'wheel')
            or kind == 'device' and identified.get('kind') == 'device')


def merge(items):
    """One item per (extra or type, state); a type-level item folds into the identified module it names."""
    kept, keys = [], {}
    for item in items:
        key = ('fire', item['state']) if item['kind'] == 'fire' else (item.get('extra') or item['type'], item['state'])
        first = keys.get(key)
        if first is None:
            keys[key] = item
            kept.append(item)
            continue
        extra = first.get('extra') or item.get('extra')
        # The identified item stands, as in the pass below (engine: the damage report over the hit indicator's
        # type); among equals the stronger tie.
        if (not item.get('extra'), rank(item['tie'])) < (not first.get('extra'), rank(first['tie'])):
            weaker = dict(first)
            first.clear()
            first.update(item)
        else: weaker = item
        confirm(first, weaker)
        if extra: first['extra'] = extra
    identified = [item for item in kept if item.get('extra') and item['kind'] in ('device', 'crew')]
    result = []
    for item in kept:
        if item.get('extra') or item['kind'] not in ('device', 'crew'):
            result.append(item)
            continue
        covering = [other for other in identified if covers(other, item)]
        for other in covering: confirm(other, item)
        if not covering: result.append(item)
    return result


def diff(before, after):
    """The extras of the snapshot after that are new, or moved from damaged to destroyed: ((extra, type), state)."""
    old_damaged, old_destroyed = set(before.get('damagedIdx') or ()), set(before.get('destroyedIdx') or ())
    names = dict(zip(after.get('damagedIdx') or (), zip(after.get('damaged') or (), after.get('damagedTypes') or ())))
    names.update(zip(after.get('destroyedIdx') or (), zip(after.get('destroyed') or (), after.get('destroyedTypes') or ())))
    new = [(index, 'destroyed') for index in after.get('destroyedIdx') or () if index not in old_destroyed]
    new += [(index, 'critical') for index in after.get('damagedIdx') or () if index not in old_damaged and index not in old_destroyed]
    return [(names.get(index, (None, None)), st) for index, st in new]


def confirm(item, other):
    sources = item.setdefault('confirmedBy', [])
    for source in [other['from']] + list(other.get('confirmedBy') or []):
        if source != item['from'] and source not in sources: sources.append(source)
    if not sources: item.pop('confirmedBy', None)


def moves_tie(record, earlier=()):
    """Whether a new crit record can change a tie of attach_crits; earlier = the battle's crit records before it.

    The exporter publishes the others with the next tie or a little later: they change only the critStats counts.
    """
    event = record.get('event')
    if event in COUNTED: return False
    if event == 'hitDirection': return record.get('attackReasonId') == 0
    if event == 'damageInfo': return at_shot(record) is not None
    if event == 'fireInfo': return fire_at_shot(record)
    if event == 'battleEvents': return any(isinstance(row, dict) and shot_row(row) for row in record.get('events') or ())
    if event == 'fire': return record.get('state') == 'appeared'
    if event != 'health': return True   # any other kind, a future one too: publish
    # A fire tick picks the arsonist's hit of flames that appeared on that vehicle up to FIRE_FOLLOW before it.
    when = number(record.get('gameTime'))
    if record.get('attackReasonId') != 1 or when is None: return False
    for other in reversed(earlier):
        at = number(other.get('gameTime')) if isinstance(other, dict) else None
        if at is None: continue
        if when - at > FIRE_FOLLOW + WINDOW_STATE: break   # the file is in time order, give or take
        if (other.get('event') == 'fire' and other.get('state') == 'appeared' and other.get('vehicleId') == record.get('vehicleId')
                and 0 < when - at <= FIRE_FOLLOW): return True
    return False


def attach_crits(hits, events, player_vehicle_id=None, offsets=None):
    """Set hit['crits'] on every hit that has anything; return the battle's critStats. Idempotent.

    offsets: an optional dict; every tie then appends its dt to offsets[event name] (the logging test's tool).
    """
    stats = {'events':{}, 'tied':{}, 'unmatched':{}, 'splash':0, 'publicExtras':{},
             'windows':{'exact':WINDOW_EXACT, 'state':WINDOW_STATE}}
    state = []
    for hit in hits:
        hit.pop('crits', None)
        state.append({'items':[], 'conflicts':[], 'mask':None, 'maskTypes':set(), 'flags':0, 'count':0})
    by_target = {}
    for i, hit in enumerate(hits):
        when = number(hit.get('gameTime'))
        if when is not None: by_target.setdefault(hit.get('targetId'), []).append((when, i))
    for rows in by_target.values(): rows.sort()
    timed = []
    for event in events or ():
        if not isinstance(event, dict): continue
        name = str(event.get('event'))
        stats['events'][name] = stats['events'].get(name, 0) + 1
        if number(event.get('gameTime')) is not None: timed.append(event)
    timed.sort(key=lambda e: float(e['gameTime']))   # stable: file order among equal times

    def of(name): return [e for e in timed if e.get('event') == name]

    def near(target, when, low, high, test=None):
        """(dt, hit index) of the hits on target with dt = event - hit inside [low, high]."""
        return [(when - at, i) for at, i in by_target.get(target, ()) if low <= when - at <= high
                and (test is None or test(hits[i]))]

    def nearest(candidates): return min(candidates, key=lambda c: abs(c[0]))

    def mark(event, tied):
        field = 'tied' if tied else 'unmatched'
        stats[field][event['event']] = stats[field].get(event['event'], 0) + 1

    def add(i, item, event, dt, tie):
        item.update({'tie':tie, 'dt':round(dt, 3), 'event':event.get('id')})
        state[i]['items'].append(item)

    def offset(event, dt):
        if offsets is not None: offsets.setdefault(str(event.get('event')), []).append(round(dt, 3))

    # Hit indicator: one event per hit, pairs taken greedily by the smallest |dt|, a damage match first.
    directions, pairs = of('hitDirection'), []
    explosions = of('explosion')
    for n, event in enumerate(directions):
        if event.get('attackReasonId') != 0: continue   # fire, ramming: not a shot
        when = float(event['gameTime'])
        found = near(event.get('vehicleId'), when, -WINDOW_EXACT, WINDOW_EXACT,
                     lambda h: h.get('attackerId') == event.get('attackerId'))
        same = [c for c in found if hits[c[1]].get('damage') == event.get('damage')]
        for dt, i in same or found: pairs.append((not same, abs(dt), n, i, dt, len(same or found)))
        if not found and event.get('isShellHE') and int(event.get('crits') or 0) & ~STUN and any(
                e.get('attackerId') == event.get('attackerId') and e.get('vehicleId') == event.get('vehicleId')
                and abs(float(e['gameTime']) - when) <= WINDOW_EXACT for e in explosions):
            stats['splash'] += 1
    pairs.sort(key=lambda p: (p[0], p[1]))
    taken_events, taken_hits = set(), set()
    for mismatch, _, n, i, dt, count in pairs:
        if n in taken_events or i in taken_hits: continue
        taken_events.add(n)
        taken_hits.add(i)
        event, s = directions[n], state[i]
        tie = 'unique' if count == 1 else 'nearest'
        offset(event, dt)
        s['mask'] = int(event.get('crits') or 0)
        if mismatch: s['conflicts'].append('damage-mismatch')
        decoded = event.get('critsDecoded') or {}
        for sub, st in (('criticalDevices', 'critical'), ('destroyedDevices', 'destroyed'), ('destroyedTankmen', 'injured')):
            for kind in decoded.get(sub) or ():
                s['maskTypes'].add(kind)
                add(i, {'kind':'crew' if sub == 'destroyedTankmen' else 'device', 'type':kind, 'state':st,
                        'from':'hitDirection'}, event, dt, tie)
    for n, event in enumerate(directions):
        if event.get('attackReasonId') == 0: mark(event, n in taken_events)

    # Damage report of the own (or watched) vehicle: the exact extra, the attacker, a cause "at shot".
    for event in of('damageInfo'):
        st = at_shot(event)
        if st is None: continue   # fire, ramming, world, repair: counted only
        found = near(event.get('vehicleId'), float(event['gameTime']), -WINDOW_EXACT, WINDOW_EXACT,
                     lambda h: h.get('attackerId') == event.get('attackerId'))
        mark(event, bool(found))
        if not found: continue
        kind = event.get('extraType') or 'other'
        pool = [c for c in found if kind in state[c[1]]['maskTypes']] or found
        dt, i = nearest(pool)
        offset(event, dt)
        add(i, {'kind':kind_of(kind), 'type':kind, 'extra':event.get('extra'), 'state':st, 'from':'damageInfo'},
            event, dt, 'unique' if len(pool) == 1 else 'nearest')

    # The fire report of the own vehicle: who set it and which device, at server time.
    for event in of('fireInfo'):
        if not fire_at_shot(event): continue
        start = number(event.get('startTime'))
        found = near(event.get('vehicleId'), float(event['gameTime']) if start is None else start, -WINDOW_EXACT, WINDOW_EXACT,
                     lambda h: h.get('attackerId') == event.get('attackerId'))
        mark(event, bool(found))
        if not found: continue
        dt, i = nearest(found)
        offset(event, dt)
        add(i, {'kind':'fire', 'type':'fire', 'state':'started', 'extra':event.get('device'), 'from':'fireInfo'},
            event, dt, 'unique' if len(found) == 1 else 'nearest')

    # The player's shot results, each entry on its own (corr. 5): type-level only.
    for event in of('shotResults'):
        when, shooter, tied = float(event['gameTime']), event.get('shooterId') or player_vehicle_id, False
        for row in event.get('results') or ():
            names = set(row.get('flagNames') or ())
            if not names.intersection(DIRECT):
                if 'ATTACK_IS_EXTERNAL_EXPLOSION' in names and names.intersection(SPLASH_FLAGS): stats['splash'] += 1
                continue
            gun = row.get('gunInstallationIndex') or 0
            found = near(row.get('vehicleId'), when, -WINDOW_EXACT, WINDOW_EXACT,
                         lambda h: h.get('attackerId') == shooter and (h.get('gunInstallationIndex') or 0) == gun)
            if not found: continue
            tied = True
            dt, i = nearest(found)
            offset(event, dt)
            tie = 'unique' if len(found) == 1 else 'nearest'
            state[i]['flags'] |= int(row.get('hitFlags') or 0)
            chassis, gun_hit = 'CHASSIS_DAMAGED_BY_PROJECTILE' in names, 'GUN_DAMAGED_BY_PROJECTILE' in names
            if chassis: add(i, {'kind':'device', 'type':'chassis', 'state':'damaged', 'from':'shotFlags'}, event, dt, tie)
            if gun_hit: add(i, {'kind':'device', 'type':'gun', 'state':'damaged', 'from':'shotFlags'}, event, dt, tie)
            # Design choice: whether the device bit also covers chassis and gun is not in the client.
            if 'DEVICE_DAMAGED_BY_PROJECTILE' in names and not chassis and not gun_hit:
                add(i, {'kind':'device', 'type':'device', 'state':'damaged', 'from':'shotFlags'}, event, dt, tie)
            if 'FIRE_STARTED' in names: add(i, {'kind':'fire', 'type':'fire', 'state':'started', 'from':'shotFlags'}, event, dt, tie)
        mark(event, tied)

    # Battle feedback: a count of crits only; CRIT is the component vehicle's own, RECEIVED_CRIT from targetId.
    for event in of('battleEvents'):
        when, me, tied = float(event['gameTime']), event.get('vehicleId') or player_vehicle_id, False
        for row in event.get('events') or ():
            name = row.get('eventName') or {6:'CRIT', 9:'RECEIVED_CRIT'}.get(row.get('eventType'))
            if not shot_row(row): continue   # fire, ramming: counted only
            other = row.get('targetId')
            if name == 'CRIT': found = near(other, when, -WINDOW_STATE, WINDOW_STATE, lambda h: h.get('attackerId') == me)
            elif name == 'RECEIVED_CRIT': found = near(me, when, -WINDOW_STATE, WINDOW_STATE, lambda h: h.get('attackerId') == other)
            else: continue
            if not found: continue
            tied = True
            dt, i = nearest(found)
            offset(event, dt)
            state[i]['count'] += int(row.get('critsCount') or 0)
        mark(event, tied)

    # The target's damaged-modules panel: the difference of two snapshots of one run around the hit.
    runs = []
    for event in of('damagedDevices'):
        if runs and runs[-1][0].get('vehicleId') == event.get('vehicleId'): runs[-1].append(event)
        else: runs.append([event])
    for run in runs:
        times = [float(e['gameTime']) for e in run]
        used = set()
        for at, i in by_target.get(run[0].get('vehicleId'), ()):
            before = None   # the last snapshot of the run at or before the hit; none, no diff
            for k, t in enumerate(times):
                if t <= at: before = k
            if before is None: continue
            after = next((k for k in range(before + 1, len(run)) if 0 < times[k] - at <= WINDOW_STATE), None)
            if after is None: continue
            found = diff(run[before], run[after])
            if not found: continue
            used.add(after)
            offset(run[after], times[after] - at)
            between = [j for t, j in by_target[run[0].get('vehicleId')] if times[before] <= t < times[after]]
            for (extra, kind), st in found:
                kind = kind or 'other'
                item = {'kind':kind_of(kind), 'type':kind, 'extra':extra, 'state':'injured' if kind in CREW else st,
                        'from':'snapshotDiff'}
                if len(between) > 1: item['sharedWith'] = [hits[j].get('id') for j in between if j != i]
                add(i, item, run[after], times[after] - at, 'unique' if len(between) <= 1 else 'shared')
        for k in range(1, len(run)):
            if k in used: mark(run[k], True)
            elif diff(run[k - 1], run[k]): mark(run[k], False)

    # Broken tracks and wheels in a vehicle's public state: by vehicle and time only.
    for event in of('publicState'):
        rows = list(zip(event.get('addedIdx') or (), event.get('added') or (), event.get('addedTypes') or ()))
        chassis = [(extra, kind) for _, extra, kind in rows if kind in ('track', 'wheel')]
        for index, extra, kind in rows:
            if kind not in ('track', 'wheel'):
                key = extra or str(index)
                stats['publicExtras'][key] = stats['publicExtras'].get(key, 0) + 1
        if not chassis: continue
        found = near(event.get('vehicleId'), float(event['gameTime']), -WINDOW_STATE, WINDOW_STATE)
        mark(event, bool(found))
        if not found: continue
        dt, i = nearest([c for c in found if last_part(hits[c[1]]) == 0] or found)
        offset(event, dt)
        for extra, kind in chassis:
            add(i, {'kind':'device', 'type':kind, 'extra':extra, 'state':'destroyed', 'from':'publicState'}, event, dt, 'time-only')

    # Flames that appear on a vehicle, and the ammo-rack effect: the last hit on it within the state window.
    ticks = [e for e in of('health') if e.get('attackReasonId') == 1]   # index 1 of ATTACK_REASONS is FIRE
    for event in of('fire'):
        if event.get('state') != 'appeared': continue
        when, vehicle = float(event['gameTime']), event.get('vehicleId')
        found = near(vehicle, when, 0, WINDOW_STATE)
        mark(event, bool(found))
        if not found: continue
        tick = next((e for e in ticks if e.get('vehicleId') == vehicle and 0 < float(e['gameTime']) - when <= FIRE_FOLLOW), None)
        if tick is not None: found = [c for c in found if hits[c[1]].get('attackerId') == tick.get('attackerId')] or found
        dt, i = min(found)
        offset(event, dt)
        add(i, {'kind':'fire', 'type':'fire', 'state':'started', 'from':'fireComponent'}, event, dt, 'time-only')
    for event in of('ammoBay'):
        found = near(event.get('vehicleId'), float(event['gameTime']), 0, WINDOW_STATE)
        mark(event, bool(found))
        if not found: continue
        dt, i = min(found)
        offset(event, dt)
        add(i, {'kind':'ammoBay', 'type':'ammoBay', 'state':'burnOff' if event.get('modeName') == 'burnOff' else 'detonated',
                'from':'ammoBayEffect'}, event, dt, 'time-only')

    for i, hit in enumerate(hits):
        s, code = state[i], last_code(hit)
        conflicts = s['conflicts']
        if s['mask'] is not None:
            conflicts.extend('info-not-in-mask:' + str(item['type']) for item in s['items']
                             if item['from'] == 'damageInfo' and item['type'] not in s['maskTypes'])
            codes = effects(hit)
            if s['mask'] & ~STUN and codes and codes[-1] == 4: conflicts.append('code4-with-mask')
        items = merge(s['items'])
        if code is None and not items and s['mask'] is None and not s['flags'] and not s['count']: continue
        crits = {'schema':1, 'code':code, 'items':items, 'conflicts':conflicts}
        if s['mask'] is not None: crits.update({'mask':s['mask'], 'maskTied':True})
        if s['flags']: crits['flags'] = s['flags']
        if s['count']: crits['count'] = s['count']
        hit['crits'] = crits
    return stats
