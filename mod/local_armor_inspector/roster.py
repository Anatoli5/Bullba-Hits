# -*- coding: utf-8 -*-
"""A vehicle id's vehicles over one battle (BACKLOG 99, 13.11.2026). Pure Python 2.7/3: no client import.

In a respawn mode (Fort Rush, Frontline) a player comes back in ANOTHER vehicle under the same vehicle id. Every roster
record is the whole roster as known at that moment (the recorder's note_roster, the replay Converter's roster), so the
battle's roster records in file order are the history of every id. The published battle keeps the LAST roster, as it
always did; a row whose id drove another vehicle earlier in the battle, and took part in a hit or a health change in that
life, gets 'earlier': the rows of those lives, oldest first, each with 'until' - the battle clock (gameTime, server time)
at which the next one began. One owner: this module writes it (Exporter.publish); the page reads it with
ArmorInspectorData.rosterAt (web/local-data.js), damage_log.check with max_health_at.

A life begins when an id's row names another vehicle type than its previous one (a row without a type - an Onslaught
enemy, a vehicle the arena does not tell yet - starts none). The record's time: its own 'gameTime' (the recorder and the
replay Converter write it since 13.11); a live record of before has only 'receivedAt', the wall clock, which every other
live record also carries beside its gameTime: their difference is taken from those records (MEASURED on the user's Fort
Rush battle of 13.11: 985 records, the difference within 0.044 s over the battle; a life changes while the id is dead,
tens of seconds between its last event and the switch). A record with neither leaves the id without 'earlier', as before.
A life that left no event is not kept (an Onslaught vehicle chosen in the first seconds): it changes nothing shown, and an
ordinary battle's file stays byte for byte what it was.
"""
from __future__ import absolute_import
import copy
import numbers


def number(value):
    return float(value) if isinstance(value, numbers.Real) and not isinstance(value, bool) else None


def clock_offset(records):
    """receivedAt - gameTime of the live records that carry both (the median), None when none does."""
    offsets = sorted(number(r.get('receivedAt')) - number(r.get('gameTime')) for r in records or ()
                     if isinstance(r, dict) and number(r.get('receivedAt')) is not None and number(r.get('gameTime')) is not None)
    return offsets[len(offsets) // 2] if offsets else None


def record_time(record, offset):
    when = number(record.get('gameTime'))
    if when is not None: return when
    received = number(record.get('receivedAt'))
    return received - offset if received is not None and offset is not None else None


def event_times(hits, events):
    """{vehicle id: [gameTime]} of every hit it took or fired and every health record it is named in."""
    times = {}
    for record in list(hits or ()) + [e for e in events or () if isinstance(e, dict) and e.get('event') == 'health']:
        if not isinstance(record, dict): continue
        when = number(record.get('gameTime'))
        if when is None: continue
        for key in ('targetId', 'attackerId', 'vehicleId'):
            vid = record.get(key)
            if vid is not None: times.setdefault(vid, []).append(when)
    return times


def lives(rosters, hits=(), events=()):
    """The rows of the battle's last roster record, a row of an id that drove another vehicle before with 'earlier' (see
    the module). None when no row gets one - the caller keeps the roster it has."""
    rosters = [r for r in rosters or () if isinstance(r, dict) and isinstance(r.get('vehicles'), list)]
    if not rosters: return None
    offset = None
    if any(number(r.get('gameTime')) is None for r in rosters):
        offset = clock_offset(list(hits or ()) + list(events or ()))
    seen = {}   # id -> [{'type', 'row', 'from'}], oldest first
    for record in rosters:
        when = record_time(record, offset)
        for row in record['vehicles']:
            if not isinstance(row, dict) or row.get('id') is None: continue
            known = seen.setdefault(row['id'], [])
            kind = row.get('type') or None
            if not known:
                known.append({'type':kind, 'row':row, 'from':None})
            elif kind and known[-1]['type'] and kind != known[-1]['type']:
                known.append({'type':kind, 'row':row, 'from':when, 'timed':when is not None})
            else:
                if kind and not known[-1]['type']: known[-1]['type'] = kind
                known[-1]['row'] = row
    times = event_times(hits, events)
    out, changed = [], False
    for row in rosters[-1]['vehicles']:
        known = seen.get(row.get('id')) if isinstance(row, dict) else None
        if not known or len(known) < 2 or not all(life.get('timed') for life in known[1:]):
            out.append(row)
            continue
        at = times.get(row['id']) or ()
        earlier = []
        for index, life in enumerate(known[:-1]):
            start, until = life['from'], known[index + 1]['from']
            if not any((start is None or t >= start) and t < until for t in at): continue
            entry = dict((k, copy.deepcopy(v)) for k, v in life['row'].items() if k not in ('id', 'earlier'))
            entry['until'] = round(until, 3)
            earlier.append(entry)
        if not earlier:
            out.append(row)
            continue
        row = dict(row)
        row['earlier'] = earlier
        out.append(row)
        changed = True
    return out if changed else None


def row_at(row, when):
    """The row of the life in force at `when` (gameTime): an earlier one whose 'until' is later, else the row itself."""
    if not isinstance(row, dict): return row
    when = number(when)
    if when is not None:
        for life in row.get('earlier') or ():
            if isinstance(life, dict) and number(life.get('until')) is not None and when < life['until']:
                out = dict((k, v) for k, v in life.items() if k != 'until')
                out['id'] = row.get('id')
                return out
    if 'earlier' not in row: return row
    return dict((k, v) for k, v in row.items() if k != 'earlier')
