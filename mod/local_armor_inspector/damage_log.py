# -*- coding: utf-8 -*-
"""Every HP a vehicle lost that no shell took: rams, fire, and the rest, as the page's damage events (25.09).

The recorder writes each health change that is not a shot as a small crit record 'health' with the client's own
attack reason (crit_log.health, since 0.7.20). One such record is one tick of the server: a fire burns in ticks of
0.5 s, a ram pushed on for a second is several. This module, run by the exporter on every publish (the one publish
owner, Exporter.publish) and by the offline tools, turns them into one event per episode - a ram, a fire, an
artillery strike - and checks per vehicle that the damage the battle file holds adds up to the HP it lost. Pure
Python 2.7/3, no client import; nothing is guessed for records older than the crit log (they have no 'health').
Design and figures: docs/KNOWLEDGE.md section 10, docs/CONTEXT.md 25.09 (local agent context).
"""
from __future__ import absolute_import
import numbers

# ATTACK_REASONS of NA 2.4.0.1, only for a record whose reason name is missing (crit_log writes the name).
REASON_NAMES = {1:'fire', 2:'ramming', 3:'world_collision', 13:'artillery_eq', 16:'none', 36:'ultimate',
                56:'circuit_overload'}
SHOT, FIRE, RAM, HEAL = 'shot', 'fire', 'ramming', 'none'
# The ticks of one episode: a fire or a charge that ticks every 0.5 s, a ram pushed on. A longer pause starts a new one.
TICK_GAP = 1.5
RAM_GAP = 1.0
# A client-physics contact of the pair counts for a ram up to this long before its first or after its last tick
# (the remote vehicles' physics lags the server by the interpolation, the own vehicle's leads it).
CONTACT_WINDOW = 1.0
# The hit that set a vehicle on fire: at most this long before the first tick (crit_tie.FIRE_FOLLOW).
FIRE_CAUSE = 3.0
# An episode is over once no tick came for this long after its last one (wall clock of the publish, receivedAt).
HOLD_MARGIN = 0.5
# A reason-0 health record (the recorder writes one only when a shot destroys the vehicle) and its hit share a tick.
SAME_TICK = 0.05
CHECK_ROWS = 60


def number(value):
    return float(value) if isinstance(value, numbers.Real) and not isinstance(value, bool) else None


def integer(value):
    return int(value) if isinstance(value, numbers.Integral) and not isinstance(value, bool) else None


def reason_of(record):
    name = record.get('attackReason')
    if name: return str(name)
    index = integer(record.get('attackReasonId'))
    if index == 0: return SHOT
    return REASON_NAMES.get(index, 'reason%s' % index)


def kind_of(reason):
    return 'ram' if reason == RAM else 'fire' if reason == FIRE else 'other'


def health_rows(events):
    """The health records with a time and both HP figures, in time order (file order among equal times)."""
    rows = []
    for order, event in enumerate(events or ()):
        if not isinstance(event, dict) or event.get('event') != 'health': continue
        when, old, new = number(event.get('gameTime')), integer(event.get('oldHealth')), integer(event.get('newHealth'))
        vehicle = event.get('vehicleId')
        if when is None or old is None or new is None or vehicle is None: continue
        rows.append((when, order, event, reason_of(event), old, new))
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows


def dealt(old, new):
    """HP taken by one tick: a destroyed vehicle reports -1/-2 and the like, and loses only what it had."""
    return max(0, old - max(new, 0))


class Episode(object):
    def __init__(self, reason, key, row):
        self.reason, self.key, self.rows = reason, key, [row]
        self.closed = False

    @property
    def first(self): return self.rows[0]

    @property
    def last(self): return self.rows[-1]


def group(rows):
    """Episodes of damage (heals and shots left out) and the closed flag of each: a ram by the pair of vehicles,
    anything else by (reason, vehicle, attacker)."""
    open_, done = {}, []
    for row in rows:
        when, _, event, reason, old, new = row
        if reason in (SHOT, HEAL) or dealt(old, new) <= 0: continue
        vehicle, attacker = event.get('vehicleId'), event.get('attackerId')
        if reason == RAM: key, gap = (RAM, frozenset((vehicle, attacker))), RAM_GAP
        else: key, gap = (reason, vehicle, attacker), TICK_GAP
        episode = open_.get(key)
        # A pause longer than the gap, or a tick on a vehicle this episode already destroyed (a new life in a
        # respawn mode), starts a new episode.
        if episode is not None and (when - episode.last[0] > gap or any(
                r[5] <= 0 and r[2].get('vehicleId') == vehicle for r in episode.rows)):
            episode.closed = True
            done.append(episode)
            episode = None
        if episode is None:
            open_[key] = Episode(reason, key, row)
        else: episode.rows.append(row)
    done.extend(open_.values())
    done.sort(key=lambda e: (e.first[0], e.first[1]))
    return done


def ram_contact(pair, start, end, collisions):
    """The client-physics contact of this pair nearest the ram's first tick, within the window; None when none."""
    best = None
    for record in collisions:
        at = number(record.get('at'))
        if at is None: at = number(record.get('gameTime'))
        ids = frozenset(s.get('vehicleId') for s in record.get('sides') or () if isinstance(s, dict))
        if at is None or ids != pair or not (start - CONTACT_WINDOW <= at <= end + CONTACT_WINDOW): continue
        score = abs(at - start)
        if best is None or score < best[0]: best = (score, at, record)
    if best is None: return None
    _, at, record = best
    contact = {'at':round(at, 3), 'dt':round(at - start, 3), 'source':record.get('source') or 'client physics'}
    speed = number(record.get('closingSpeed'))
    if speed is not None: contact['closingSpeed'] = round(speed, 2)
    sides = {}
    for side in record.get('sides') or ():
        if not isinstance(side, dict): continue
        out = dict((k, side[k]) for k in ('local', 'parts', 'aim', 'approach') if side.get(k) is not None)
        sides[str(side.get('vehicleId'))] = out
    contact['sides'] = sides
    return contact


def fire_cause(hits, vehicle, attacker, start):
    """The hit that set the fire: the one the crit ties marked 'fire started' on this vehicle shortly before the
    first tick, else the arsonist's last hit on it in that window. (hit id, how) or (None, None)."""
    marked, fallback = None, None
    for hit in hits:
        if hit.get('targetId') != vehicle: continue
        at = number(hit.get('gameTime'))
        if at is None or not (start - FIRE_CAUSE <= at <= start + SAME_TICK): continue
        items = ((hit.get('crits') or {}).get('items')) or ()
        if any(isinstance(i, dict) and i.get('kind') == 'fire' for i in items):
            if marked is None or at > marked[0]: marked = (at, hit.get('id'))
        if hit.get('attackerId') == attacker and (fallback is None or at > fallback[0]): fallback = (at, hit.get('id'))
    if marked is not None: return marked[1], 'crit'
    if fallback is not None: return fallback[1], 'time'
    return None, None


def fire_marks(events):
    """(time, 'appeared'|'removed') of the fire component, per vehicle, in time order."""
    marks = {}
    for event in events or ():
        if not isinstance(event, dict) or event.get('event') != 'fire': continue
        when = number(event.get('gameTime'))
        if when is None: continue
        marks.setdefault(event.get('vehicleId'), []).append((when, event.get('state')))
    for rows in marks.values(): rows.sort()
    return marks


def build_events(hits, events, now=None, held=None):
    """The battle's damage events, one per ram, fire and other episode, in time order.

    now: the wall clock of a live publish (time.time()); an episode whose last tick is younger than its gap may still
    grow, so it is held back and counted in held['count'] - the tile of a fire goes out at its end, with the total.
    None (a finished battle, the offline tools): every episode is over."""
    rows = health_rows(events)
    if not rows: return []
    collisions = [e for e in events or () if isinstance(e, dict) and e.get('event') == 'collision']
    marks = fire_marks(events)
    out = []
    for episode in group(rows):
        first, last = episode.first, episode.last
        start, end = first[0], last[0]
        reason, kind = episode.reason, kind_of(episode.reason)
        event = {'id':kind + ':' + str(first[2].get('id') or '%.3f' % start), 'kind':kind, 'reason':reason,
                 'start':round(start, 3), 'end':round(end, 3), 'ticks':len(episode.rows)}
        if kind == 'ram':
            taken = {}
            for row in episode.rows:
                vehicle = row[2].get('vehicleId')
                side = taken.setdefault(vehicle, {'damage':0, 'killed':False, 'healthAfter':None, 'by':row[2].get('attackerId')})
                side['damage'] += dealt(row[4], row[5])
                side['killed'] = side['killed'] or row[5] <= 0
                side['healthAfter'] = max(row[5], 0)
            pair = episode.key[1]
            contact = ram_contact(pair, start, end, collisions)
            ids = sorted(pair, key=lambda v: (v is None, v))
            if len(ids) == 1: ids = ids * 2
            # The rammer: the one who drove INTO the contact (its speed toward the point), when the contact is
            # recorded; else the one whose side took less (the server spares the rammer, KNOWLEDGE 10).
            approach = dict((v, number(((contact or {}).get('sides') or {}).get(str(v), {}).get('approach'))) for v in ids)
            if all(approach[v] is not None for v in ids) and approach[ids[0]] != approach[ids[1]]:
                rammer = max(ids, key=lambda v: approach[v])
                event['rammerFrom'] = 'contact'
            else:
                rammer = min(ids, key=lambda v: (taken.get(v, {}).get('damage', 0), ids.index(v)))
                event['rammerFrom'] = 'damage'
            target = ids[1] if rammer == ids[0] else ids[0]
            mine, theirs = taken.get(rammer) or {}, taken.get(target) or {}
            event.update({'attackerId':rammer, 'targetId':target, 'damage':theirs.get('damage', 0),
                          'selfDamage':mine.get('damage', 0)})
            if theirs.get('killed'): event['killed'] = True
            if mine.get('killed'): event['attackerKilled'] = True
            if theirs.get('healthAfter') is not None: event['healthAfter'] = theirs['healthAfter']
            if mine.get('healthAfter') is not None: event['attackerHealthAfter'] = mine['healthAfter']
            if contact: event['contact'] = contact
            when_row = first
        else:
            vehicle, attacker = first[2].get('vehicleId'), first[2].get('attackerId')
            event.update({'attackerId':attacker, 'targetId':vehicle,
                          'damage':sum(dealt(r[4], r[5]) for r in episode.rows), 'healthAfter':max(last[5], 0)})
            if last[5] <= 0: event['killed'] = True
            when_row = first
            if kind == 'fire':
                # The flames' own start and end, when the fire component told them: appeared up to FIRE_CAUSE
                # before the first tick, removed from the last tick up to one gap after it.
                vehicle_marks = marks.get(vehicle) or []
                began = [t for t, st in vehicle_marks if st == 'appeared' and start - FIRE_CAUSE <= t <= start]
                ended = [t for t, st in vehicle_marks if st == 'removed' and end - SAME_TICK <= t <= end + TICK_GAP]
                if began: event['start'] = round(began[-1], 3)
                if ended: event['end'] = round(ended[0], 3)
                event['out'] = 'destroyed' if event.get('killed') else 'extinguished' if ended else 'unknown'
                if ended or event.get('killed'): episode.closed = True
                cause, how = fire_cause(hits or (), vehicle, attacker, event['start'] if began else start)
                if cause is not None: event['cause'] = {'hitId':cause, 'from':how}
                # The tile stands at the END of the fire, with the total (user, 25.09).
                when_row = last
        if event.get('killed'): episode.closed = True
        # An episode still ticking in a live battle waits: its tile goes out once it is over.
        gap = RAM_GAP if kind == 'ram' else TICK_GAP
        last_seen = number(last[2].get('receivedAt'))
        if not episode.closed and now is not None and last_seen is not None and now - last_seen <= gap + HOLD_MARGIN:
            if held is not None: held['count'] = held.get('count', 0) + 1
            continue
        event['gameTime'] = round(event['end'] if kind == 'fire' else when_row[0], 3)
        received = number(when_row[2].get('receivedAt'))
        if received is not None: event['receivedAt'] = received
        out.append(event)
    out.sort(key=lambda e: e['gameTime'])
    return out


def check(hits, events, roster=None):
    """Per vehicle: does the logged damage (hits and every non-shot tick) add up to the HP it lost?

    The HP is known exactly at every health record (old before, new after) and at the start (the roster's maximum):
    between two such anchors the drop must equal the damage of the hits logged in between. After the last anchor a
    vehicle whose logged hits reach its HP was destroyed, and they must add up to exactly that HP. A gap means damage
    the file does not hold (the vehicle out of view, a splash no hook reports) or, negative, logged damage it did not
    lose. Logged hits worth more than the HP left, followed by a later anchor, are a death and a new life (respawn
    modes, which restore the HP without a health record): that stretch is counted as such and not compared.
    """
    maximum = {}
    for row in roster or ():
        if isinstance(row, dict) and integer(row.get('maxHealth')) and row.get('id') is not None:
            maximum[row['id']] = integer(row['maxHealth'])
    timeline = {}
    for hit in hits or ():
        when, damage = number(hit.get('gameTime')), integer(hit.get('damage'))
        if when is None or not damage or damage <= 0 or hit.get('targetId') is None or hit.get('synthetic'): continue
        timeline.setdefault(hit['targetId'], []).append((when, 0, 'hit', damage))
    for when, order, event, reason, old, new in health_rows(events):
        timeline.setdefault(event['vehicleId'], []).append((when, 1, reason, (old, new)))
    result = {'schema':1, 'vehicles':0, 'intervals':0, 'matched':0, 'mismatched':0, 'missing':0, 'surplus':0,
              'respawns':0, 'destroyed':0, 'rows':[]}

    def compare(vehicle, since, when, lost, logged, at):
        result['intervals'] += 1
        gap = lost - logged
        if not gap:
            result['matched'] += 1
            return
        result['mismatched'] += 1
        result['missing' if gap > 0 else 'surplus'] += abs(gap)
        if len(result['rows']) < CHECK_ROWS:
            result['rows'].append({'vehicleId':vehicle, 'from':None if since is None else round(since, 3),
                                   'to':None if when is None else round(when, 3), 'lost':lost, 'logged':logged, 'at':at})

    for vehicle, items in timeline.items():
        items.sort(key=lambda r: (r[0], r[1]))
        full = maximum.get(vehicle)
        hp, pending, since, counted = full, 0, None, False
        for when, _, reason, value in items:
            if reason == 'hit':
                pending += value
                continue
            old, new = value
            # The shot that destroyed the vehicle (a record the recorder writes since 25.09) shares its hit's tick,
            # and that hit is already in 'pending': the anchor is the HP after it.
            before = max(new, 0) if reason == SHOT else old
            if hp is not None:
                if pending and pending >= hp and hp - before < pending and reason != SHOT:
                    result['respawns'] += 1   # destroyed by the logged hits, then back with new HP
                else:
                    compare(vehicle, since, when, hp - before, pending, 'start' if since is None else reason)
                    if reason == SHOT: result['destroyed'] += 1
                counted = True
            hp, pending, since = max(new, 0), 0, when
            if new <= 0: hp = full   # a respawn mode brings the vehicle back at full HP; otherwise nothing follows
        if hp is not None and pending and pending >= hp:
            # The logged hits after the last anchor reach the HP it had: it was destroyed, and they must equal it.
            compare(vehicle, since, None, hp, pending, 'destroyed')
            result['destroyed'] += 1
            counted = True
        if counted: result['vehicles'] += 1
    return result


def damage_log(hits, events, roster=None, now=None):
    """(damageEvents, damageCheck, held) of one battle: held counts the episodes a live publish holds back (the
    exporter publishes again soon). ([], None, 0) for a battle with no health records."""
    if not any(isinstance(e, dict) and e.get('event') == 'health' for e in events or ()): return [], None, 0
    held = {}
    events_out = build_events(hits, events, now, held)
    return events_out, check(hits, events, roster), held.get('count', 0)
