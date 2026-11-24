"""Another vehicle's estimated aim circle (replay_aim_other.py, BACKLOG 82) checked on the own shots of local battles.

    python tests/replay_aim_other_table.py                the tables of outputs/aim-circles-other-vehicles-2026-11-12.md
                                                          (4.3 held-out own shots, 4.4 others) made by the product code
    python tests/replay_aim_other_table.py --fixture      also write the py27 check's battle (tests/py27/replay_aim_other.py)

The 33 battles of 11.11.2026 under CFG (<game>/mods/configs/local.armor_inspector, BULLBA_GAME; read-only): each kept
stream (CFG/replay/<id>.stream.z) decoded the way the game does (the lean decode of replay_run) and converted with the
poses (replay_records.Converter, poses=True). The OWN vehicle's shots go through the very path of another vehicle's
(replay_aim_other.vehicle_steps: its 0x0a track, its packed gun angles, its tracers, its gun from the descriptor - nothing
the replay has for the own vehicle alone) and are scored against the server's truth the own vehicle has: the 0x39 update
the shell left from (replayAim.shotUpdate picked by its origin: its vector is the axis before the deviation, its
dispersion the true R). The other vehicles' tracers go through replay_aim_other.attaching and give the share of shells
by their distance from the estimated centre (no truth exists for them). The guns: tests/fixtures-local/
replay-aim-other-2026-11-12/guns.json (tests/py27/replay_aim_other.py update, the client's descriptors on the stand).
"""
from __future__ import print_function
import json
import math
import os
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
sys.path.insert(0, HERE)
import replay_aim_table as T  # noqa: E402

FIXTURES = os.path.join(HERE, 'fixtures-local', 'replay-aim-other-2026-11-12')
GUNS = os.path.join(FIXTURES, 'guns.json')
BATTLE = os.path.join(FIXTURES, 'battle.json')
DAY = '2026-11-11'


def guns():
    if not os.path.isfile(GUNS): return None
    with open(GUNS, encoding='utf-8') as f: return json.load(f)


class Decoding(T.Decoding):
    def records(self, stream):
        from local_armor_inspector import replay_run as rr
        from local_armor_inspector import replay_records as rrec
        decoder = self.rd.Decoder(self.defs, skip=rr.LEAN_TYPES, skip_properties=rr.LEAN_PROPERTIES)
        converter = rrec.Converter(session='check', poses=True)
        out = []
        for event in rr._events(decoder, stream, self.registry): out.extend(converter.feed(event))
        out.extend(converter.finish())
        return out


def records_of(bid, decoding, cfg=T.CFG):
    with open(os.path.join(T.streams_dir(cfg), bid + '.stream.z'), 'rb') as f: stream = bytearray(zlib.decompress(f.read()))
    return decoding.records(stream)


def own_rows(records, table):
    """One row per own main-gun shot with a truth: the product's block for it made as for another vehicle."""
    from local_armor_inspector import replay_aim as ra
    from local_armor_inspector import replay_aim_other as ro
    poses = records[-1]
    me, start = poses['playerVehicleId'], poses['serverTimeAtStart']
    compact = (poses.get('compact') or {}).get(me)
    gun = table.get(compact)
    if gun is None or start is None: return [], 'no gun'
    tracers = [r for r in records if r.get('type') == 'shot' and r.get('event') == 'tracer' and r.get('own')
               and not r.get('isRicochet') and not r.get('gunInstallationIndex') and isinstance(r.get('velocity'), list)]
    pairs = [(ro.clock_of(r, start), r) for r in tracers]
    out = {}
    for _ in ro.vehicle_steps(poses['positions'].get(me), poses['guns'].get(me), gun, pairs, out): pass
    rows = []
    for r in tracers:
        block, truth = out.get(id(r)), (r.get(ra.KEY) or {}).get('shotUpdate')
        if not block or 'circle' not in block or not truth or truth.get('from') != 'origin': continue
        rows.append(score_row(block, r, truth))
    reason = None if rows else next((b.get('reason') for b in out.values() if 'reason' in b), 'no shot')
    return rows, reason


def score_row(block, tracer, truth):
    from local_armor_inspector import replay_aim_other as ro
    basis = ro.frame(block['track']['vector'])
    est = ro.tangent(basis, block['circle']['vector'])
    tru = ro.tangent(basis, truth['vector'])
    shell = ro.tangent(basis, tracer['velocity'])
    R, Rest = truth['dispersionAngle'], block['circle']['dispersionAngle']
    e = [(est[0] - tru[0]) / R, (est[1] - tru[1]) / R]
    return {'total':math.hypot(e[0], e[1]), 'h':abs(e[0]), 'v':abs(e[1]),
            'inside':math.hypot(shell[0] - est[0], shell[1] - est[1]) <= Rest * (1 + 1e-9),
            'shown':[(shell[0] - est[0]) / Rest, (shell[1] - est[1]) / Rest], 'true':[(shell[0] - tru[0]) / R, (shell[1] - tru[1]) / R],
            'size':Rest / R, 'case':block['basis']['case'], 'gun':block['basis']['gun'],
            'stop':'moving' if block['basis']['moving'] else ('stop 1' if block['basis']['shotsInStop'] == 1 else 'stop 2+')}


def corr(a, b):
    n = len(a)
    if n < 3: return float('nan')
    ma, mb = sum(a) / n, sum(b) / n
    sab = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return sab / (sa * sb) if sa and sb else float('nan')


def summary(rows):
    q = T.quantile
    return {'n':len(rows), 'total':[q([r['total'] for r in rows], .5), q([r['total'] for r in rows], .9)],
            'h':[q([r['h'] for r in rows], .5), q([r['h'] for r in rows], .9)],
            'v':[q([r['v'] for r in rows], .5), q([r['v'] for r in rows], .9)],
            'inside':sum(1 for r in rows if r['inside']) / max(1, len(rows)),
            'infoH':corr([r['shown'][0] for r in rows], [r['true'][0] for r in rows]),
            'infoV':corr([r['shown'][1] for r in rows], [r['true'][1] for r in rows]),
            'size':[q([r['size'] for r in rows], p) for p in (.1, .5, .9)]}


def shares(qs):
    n = max(1, len(qs))
    return {'n':len(qs), 'le':[sum(1 for x in qs if x <= c + 1e-3) / n for c in (.25, .5, .75, 1.0)], 'median':T.quantile(qs, .5)}


def measure(ids, cfg=T.CFG, decoding=None, progress=None, fixture=None):
    """{'own': summary, 'byGun', 'byStop', 'others': shares, 'absent', ...} over the battles `ids`."""
    from local_armor_inspector import replay_aim_other as ro
    decoding = decoding or Decoding()
    table = guns() or {}
    own, skipped, others, reasons, best = [], {}, [], {}, None
    for bid in ids:
        records = records_of(bid, decoding, cfg)
        rows, why = own_rows(records, table)
        own.extend(rows)
        if why: skipped[bid] = why
        report = ro.attach(records, lambda c: table[c])
        for r in records:
            b = r.get(ro.KEY)
            if isinstance(b, dict) and 'circle' in b: others.append(math.hypot(b['shell']['right'], b['shell']['up']))
        for k, n in report['absent'].items(): reasons[k] = reasons.get(k, 0) + n
        if fixture is not None and (best is None or report['circles'] > best[0]): best = (report['circles'], bid, records)
        if progress: progress(bid, len(rows), report)
    out = {'own':summary(own), 'skipped':skipped, 'others':shares(others), 'absent':reasons, 'battles':len(ids)}
    for key in ('gun', 'stop', 'case'):
        groups = {}
        for r in own: groups.setdefault(r[key], []).append(r)
        out['by' + key.title()] = dict((k, summary(v)) for k, v in groups.items())
    if fixture is not None and best is not None: write_fixture(best[1], best[2], fixture)
    return out


def write_fixture(bid, records, path):
    """The py27 check's battle: every other tracer (the fields the estimate reads), the poses of their shooters, the blocks."""
    from local_armor_inspector import replay_aim_other as ro
    poses = records[-1]
    keep = ('id', 'gameTime', 'type', 'event', 'own', 'isRicochet', 'shooterId', 'gunInstallationIndex', 'origin', 'velocity',
            'siegeState')
    tracers = [dict((k, r[k]) for k in keep if k in r) for r in records if ro.KEY in r]
    shooters = set(r['shooterId'] for r in tracers)
    value = {'battle':bid, 'tracers':tracers,
             'poses':{'type':'poses', 'playerVehicleId':poses['playerVehicleId'], 'serverTimeAtStart':poses['serverTimeAtStart'],
                      'positions':dict((str(v), [list(p[0]), list(p[1])]) for v, p in poses['positions'].items() if v in shooters),
                      'guns':dict((str(v), [list(p[0]), list(p[1])]) for v, p in poses['guns'].items() if v in shooters),
                      'compact':dict((str(v), c) for v, c in poses['compact'].items() if v in shooters)},
             'blocks':dict((r['id'], r[ro.KEY]) for r in records if ro.KEY in r)}
    with open(path, 'w', encoding='utf-8') as f: json.dump(value, f, separators=(',', ':'))


def text(m):
    def line(name, s):
        return '%-22s n %4d | centre total %.2f / %.2f | h %.2f / %.2f | v %.2f / %.2f | inside %3.0f %% | information h %.2f v %.2f | R_est / R p10 %.2f med %.2f p90 %.2f' % (
            (name, s['n']) + tuple(s['total']) + tuple(s['h']) + tuple(s['v']) + (100 * s['inside'], s['infoH'], s['infoV']) + tuple(s['size']))
    lines = ['battles %d; own shots scored %d (battles without: %s)' % (m['battles'], m['own']['n'], json.dumps(m['skipped'], sort_keys=True)),
             'own shots as another vehicle\'s, error of the centre in true R (median / p90):', line('all', m['own'])]
    for key in ('byGun', 'byStop', 'byCase'):
        for k in sorted(m[key]): lines.append(line('  ' + k, m[key][k]))
    o = m['others']
    lines.append('others: %d circles; shell within 0.25 / 0.5 / 0.75 / 1 R_est of the centre: %s; median %.2f' % (
        o['n'], ' / '.join('%.0f %%' % (100 * x) for x in o['le']), o['median']))
    lines.append('others without a circle: %s' % json.dumps(m['absent'], sort_keys=True))
    return '\n'.join(lines)


def local_ids():
    ids = T.battles(day=DAY)
    return ids if len(ids) == 33 and guns() else None


def main(argv):
    ids = local_ids()
    if not ids:
        print('the 33 battles of %s or the guns table are absent' % DAY)
        return 1
    m = measure(ids, progress=lambda bid, n, rep: sys.stderr.write('%s own %d others %d\n' % (bid, n, rep['circles'])),
                fixture=BATTLE if '--fixture' in argv else None)
    print(text(m))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
