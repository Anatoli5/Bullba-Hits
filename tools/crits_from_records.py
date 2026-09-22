"""What the client's crit records of the recorded battles say (22.09): the logging test of the crit design, counts only.

    python tools/crits_from_records.py [battle .jsonl or folder ...]   (default: the game's battles folder)

Reads the raw battle logs, ties the crit records to the hits with the exporter's own rules
(mod/local_armor_inspector/crit_tie.py) and prints what the tie windows and the open questions need: how many
records of each kind came and tied, the time offsets of the ties, whether the hit indicator's damage is the hit's,
effect 4/5/6 against the damage the own vehicle's channels named, which extras other vehicles' public state and
extra hits carry, whether the records follow the watched ally after the player's death, and whether the target's
damaged-modules panel arrived at all. Battles recorded before the crit log give the crit codes only.

Read only. The records are private: nothing but counts, time offsets and module names (engine, leftTrack0 ...) is
printed - no player name, no vehicle, no battle id. The same reader is where a later module-position tool starts.
"""
import io
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector.crit_tie import WINDOW_EXACT, attach_crits, effects  # noqa: E402

BATTLES = Path(r'C:\Games\World_of_Tanks_NA\mods\configs\local.armor_inspector\battles')
BINS = (-1.0, -0.35, -0.2, -0.1, 0.0, 0.1, 0.2, 0.35, 1.0)


def files(args):
    paths = []
    for arg in args or [str(BATTLES)]:
        path = Path(arg)
        paths.extend(sorted(path.glob('*.jsonl')) if path.is_dir() else [path])
    return paths


def read(path):
    """Header, hits and crit records of one raw battle log; a line that does not parse is skipped."""
    header, hits, crits = {}, [], []
    with io.open(str(path), 'rb') as stream:
        for line in stream:
            try: row = json.loads(line.decode('utf-8'))
            except ValueError: continue
            kind = row.get('type') if isinstance(row, dict) else None
            if kind == 'battle' and not header: header = row
            elif kind == 'hit': hits.append(row)
            elif kind == 'crit': crits.append(row)
    return header, hits, crits


def spread(values):
    if not values: return 'none'
    values = sorted(values)
    bins = Counter()
    for v in values:
        for low, high in zip(BINS, BINS[1:]):
            if low <= v < high or high == BINS[-1] and v == high:
                bins['[%+.2f,%+.2f)' % (low, high)] += 1
                break
        else: bins['outside'] += 1
    return 'n=%d min %+.3f median %+.3f max %+.3f; %s' % (len(values), values[0], values[len(values) // 2], values[-1],
                                                        ', '.join('%s %d' % kv for kv in sorted(bins.items())))


def main(argv):
    if argv and argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    paths = files(argv)
    if not paths:
        print('No battle logs found')
        return 1
    total = Counter()
    events, tied, unmatched, public, extra_hits, codes = Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
    # Every tie's record - hit offset by record kind, from the tie itself: a merged item keeps only one dt.
    offsets = {}
    ties, items, conflicts, table = Counter(), Counter(), Counter(), Counter()
    watched, replays, panel, visible, near_miss, routes = Counter(), [], Counter(), Counter(), [], Counter()
    for path in paths:
        header, hits, crits = read(path)
        player = header.get('playerVehicleId') or next((c.get('playerVehicleId') for c in crits if c.get('playerVehicleId')), None)
        stats = attach_crits(hits, crits, player, offsets)
        total['battles'] += 1
        total['hits'] += len(hits)
        total['with crit records'] += 1 if crits else 0
        total['splash'] += stats['splash']
        events.update(stats['events'])
        tied.update(stats['tied'])
        unmatched.update(stats['unmatched'])
        public.update(stats['publicExtras'])
        for hit in hits:
            c = hit.get('crits')
            if not c: continue
            total['hits with crits'] += 1
            if c.get('code'): codes[c['code']] += 1
            conflicts.update(x.split(':')[0] for x in c.get('conflicts') or ())
            for item in c.get('items') or ():
                items['%s %s %s' % (item['kind'], item.get('extra') or item['type'], item['state'])] += 1
                ties['%s/%s' % (item['from'], item['tie'])] += 1
            # The 5-vs-6 test on the own (or watched) vehicle: the last effect against what the channels named.
            named = [i for i in c.get('items') or () if i['from'] in ('hitDirection', 'damageInfo')
                     or 'hitDirection' in (i.get('confirmedBy') or ()) or 'damageInfo' in (i.get('confirmedBy') or ())]
            if c.get('maskTied') or named:
                last = (effects(hit) or ['-'])[-1]
                found = set('crew injured' if i['state'] == 'injured' else 'device destroyed'
                            if i['state'] in ('destroyed', 'detonated') else 'device critical' for i in named)
                if any(i['kind'] == 'fire' for i in c.get('items') or ()): found.add('fire')
                for column in found or ('none',): table[(str(last), column)] += 1
        for record in crits:
            event = record.get('event')
            if event in ('hitDirection', 'damageInfo') and player and record.get('vehicleId') != player:
                watched[event] += 1
            if event == 'damageInfoReplay': replays.append(record.get('vehicleId') == player)
            if event in ('hitDirection', 'battleEvents'): routes['%s %s' % (event, record.get('route') or '?')] += 1
            if event == 'extraHit' and record.get('vehicleId') != player: extra_hits[record.get('extraType') or '?'] += 1
            if event == 'damagedDevices': panel['target' if record.get('isTarget') else 'not the target'] += 1
            if event == 'damagedDevicesVisible': visible[record.get('status')] += 1
        # How far an untied hit-indicator record is from the nearest hit by the same shooter: a window too small?
        for record in crits:
            if record.get('event') != 'hitDirection' or record.get('attackReasonId') != 0: continue
            if not isinstance(record.get('gameTime'), (int, float)): continue
            same = [record['gameTime'] - h['gameTime'] for h in hits if h.get('targetId') == record.get('vehicleId')
                    and h.get('attackerId') == record.get('attackerId') and isinstance(h.get('gameTime'), (int, float))]
            if same and min(abs(d) for d in same) > WINDOW_EXACT: near_miss.append(min(same, key=abs))
    print('Battle logs: %d, %d with crit records; hits %d, %d of them with crits' % (
        total['battles'], total['with crit records'], total['hits'], total['hits with crits']))
    print('Crit code on the hit record: %d hits (5: %d, 6: %d)' % (sum(codes.values()), codes[5], codes[6]))
    print('Records by kind: %s' % dict(events.most_common()))
    print('  tied: %s' % dict(tied.most_common()))
    print('  not tied: %s' % dict(unmatched.most_common()))
    print('  splash crits (no direct hit, an explosion by the same shooter): %d' % total['splash'])
    print('Items: %d; by source and tie: %s' % (sum(items.values()), dict(ties.most_common())))
    for name, count in items.most_common(): print('  %4d  %s' % (count, name))
    print('Conflicts: %s' % (dict(conflicts) or 'none'))
    print('Time offsets record - hit of the ties, s (sets WINDOW_EXACT = %.2f):' % WINDOW_EXACT)
    kinds = ('hitDirection', 'damageInfo', 'fireInfo', 'shotResults', 'battleEvents', 'damagedDevices', 'publicState', 'fire', 'ammoBay')
    for kind in kinds + tuple(sorted(set(offsets) - set(kinds))): print('  %-14s %s' % (kind, spread(offsets.get(kind))))
    print('  untied hit indicator, nearest hit by the same shooter: %s' % spread(near_miss))
    print('Effect 4/5/6 against the damage the hit indicator and the damage report named:')
    columns = ('device critical', 'device destroyed', 'crew injured', 'fire', 'none')
    print('  %-5s %s' % ('last', ' '.join('%-16s' % c for c in columns)))
    for code in sorted(set(k[0] for k in table)):
        print('  %-5s %s' % (code, ' '.join('%-16d' % table[(code, c)] for c in columns)))
    print('Public state of vehicles, extras other than tracks and wheels: %s' % (dict(public.most_common()) or 'none'))
    print('Extra hits on other vehicles, by type: %s' % (dict(extra_hits.most_common()) or 'none'))
    print('Hit indicator / damage report on a vehicle other than the player\'s (the watched ally): %s' % (dict(watched) or 'none'))
    print('Damage-list replays: %d (%d on the player\'s own vehicle)' % (len(replays), sum(replays)))
    print('Routes, the vehicle component or the avatar directly: %s' % (dict(sorted(routes.items())) or 'none'))
    print('Damaged-modules panel snapshots: %s; switched on/off: %s' % (dict(panel) or 'none', dict(visible) or 'never'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
