"""The own aim circles rebuilt from the replay against the recorder's snapshot, on local battles (BACKLOG 82).

    python tests/replay_aim_table.py [CFG]       the table of outputs/aim-circles-from-replay-2026-11-11.md section 3,
                                                 made by the product code (replay_records.Converter + replay_battle.build)

CFG: the mod's run-time folder (default <game>/mods/configs/local.armor_inspector, BULLBA_GAME). Every battle with both
a kept replay stream (CFG/replay/<id>.stream.z) and a live record (CFG/battles/<id>.jsonl) is decoded the way the game
does (the lean decode of replay_run), converted, assembled with its live record, and each own shot's block
(replayAim.comparison) collected. Read-only: nothing under CFG is written. tests/test_replay_aim.py runs measure() on the
33 battles of 11.11 when they are on this computer (skips otherwise).
"""
from __future__ import print_function
import json
import os
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'mod'))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
CFG = os.path.join(GAME, 'mods', 'configs', 'local.armor_inspector')


def battles(cfg=CFG, day=None):
    """Battle ids with a kept stream and a live record; `day` ('YYYY-MM-DD' of the stream's local mtime) narrows them."""
    import time
    folder = os.path.join(cfg, 'replay')
    if not os.path.isdir(folder): return []
    out = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.stream.z'): continue
        bid = name[:-len('.stream.z')]
        if not os.path.isfile(os.path.join(cfg, 'battles', bid + '.jsonl')): continue
        if day and time.strftime('%Y-%m-%d', time.localtime(os.path.getmtime(os.path.join(folder, name)))) != day: continue
        out.append(bid)
    return out


class Decoding(object):
    """The decoder's definitions and package registry once (replay_run.decode's way), for many streams."""

    def __init__(self):
        from local_armor_inspector import replay_stream as rd
        from local_armor_inspector import replay_objects as rc
        self.rd = rd
        self.defs = rd.Defs(rd.Client(rd.DEFAULT_CLIENT))
        self.registry = rc.Registry(self.defs.client, self.defs)

    def records(self, stream):
        from local_armor_inspector import replay_run as rr
        from local_armor_inspector import replay_records as rrec
        decoder = self.rd.Decoder(self.defs, skip=rr.LEAN_TYPES, skip_properties=rr.LEAN_PROPERTIES)
        converter = rrec.Converter(session='check')
        out = []
        for event in rr._events(decoder, stream, self.registry): out.extend(converter.feed(event))
        out.extend(converter.finish())
        return out


def battle(bid, decoding, cfg=CFG):
    """The published shots of one battle as replay_battle.build makes them."""
    from local_armor_inspector import replay_battle as rb
    from local_armor_inspector.exporter import read_battle
    with open(os.path.join(cfg, 'replay', bid + '.stream.z'), 'rb') as f: stream = bytearray(zlib.decompress(f.read()))
    records = decoding.records(stream)
    live = read_battle(os.path.join(cfg, 'battles', bid + '.jsonl'))
    value, report = rb.build(records, live, bid)
    return value, report


def rows(value):
    """One row per own shot with a block: (block, its tracer)."""
    from local_armor_inspector import replay_aim as ra
    return [(s[ra.KEY], s) for s in value.get('shotEvents') or () if s.get('event') == 'tracer' and isinstance(s.get(ra.KEY), dict)]


def quantile(values, q):
    values = sorted(v for v in values if v is not None)
    if not values: return float('nan')
    k = (len(values) - 1) * q
    i = int(k)
    return values[i] if i + 1 >= len(values) else values[i] + (values[i + 1] - values[i]) * (k - i)


def measure(ids, cfg=CFG, decoding=None, progress=None):
    """{'shots', 'battles', 'compared', table rows...} over the battles `ids`: the figures of the report's table."""
    decoding = decoding or Decoding()
    blocks, per_battle = [], {}
    for bid in ids:
        value, report = battle(bid, decoding, cfg)
        found = rows(value)
        per_battle[bid] = (len(found), report.get('aimCompared'))
        blocks.extend(b for b, _ in found)
        if progress: progress(bid, len(found))
    cmp = [b['comparison'] for b in blocks if 'comparison' in b]
    srv = [c['serverMarker'] for c in cmp if 'serverMarker' in c]
    fresh = [s for s in srv if s.get('snapshotAge') is not None and s['snapshotAge'] <= 0.15]
    stale = [s for s in srv if s.get('snapshotAge') is not None and s['snapshotAge'] > 0.15]
    cli = [b['comparison']['clientMarker'] for b in blocks if 'clientMarker' in b.get('comparison', {})
           and b.get('markerSource') == 'server reticle']
    cli_fields = [b['comparison']['clientMarker'] for b in blocks if 'clientMarker' in b.get('comparison', {})
                  and b.get('markerSource') != 'server reticle']
    disc = [c['disc'] for c in cmp if 'disc' in c]

    def figures(group):
        return {'n':len(group),
                'radii':[quantile([g['centreRadii'] for g in group], q) for q in (.5, .9)] + [max([g['centreRadii'] for g in group] or [0])],
                'metres':[quantile([g['centreMetres'] for g in group], q) for q in (.5, .9)] + [max([g['centreMetres'] for g in group] or [0])],
                'size':[quantile([g.get('sizeRatio') for g in group], q) for q in (.1, .5, .9)]}
    out = {'battles':len([b for b in per_battle.values() if b[0]]), 'blocks':len(blocks), 'compared':len(cmp),
           'server':figures(srv), 'serverFresh':figures(fresh), 'serverStale':figures(stale),
           'serverSame':sum(1 for s in srv if s.get('same')), 'freshSame':sum(1 for s in fresh if s.get('same')),
           'client':figures(cli), 'clientFields':figures(cli_fields), 'disc':len(disc), 'discSame':sum(1 for d in disc if d['same']),
           'markerSource':{}, 'perBattle':per_battle}
    for b in blocks:
        key = b.get('markerSource')
        out['markerSource'][key] = out['markerSource'].get(key, 0) + 1
    return out


def table(m):
    def line(name, f):
        return '%-46s n %3d  centre radii med %.4f p90 %.2f max %.1f | metres med %.2f p90 %.2f max %.1f | size p10 %.3f med %.3f p90 %.3f' % (
            (name, f['n']) + tuple(f['radii']) + tuple(f['metres']) + tuple(f['size']))
    return '\n'.join([
        'battles with own shots %d, own shots with a replay block %d, compared with a snapshot %d' % (m['battles'], m['blocks'], m['compared']),
        'reticle fields 3-10: %s' % json.dumps(m['markerSource'], sort_keys=True),
        line('dashed - server reticle at the press', m['server']) + '  same %d' % m['serverSame'],
        line('  snapshot server reticle <= 0.15 s old', m['serverFresh']) + '  same %d (%.0f %%)' % (
            m['freshSame'], 100.0 * m['freshSame'] / max(1, m['serverFresh']['n'])),
        line('  snapshot server reticle > 0.15 s old', m['serverStale']),
        line('solid - client reticle (cursor point)', m['client']),
        line('  the same, no server reticle given', m['clientFields']),
        'thick disc: %d compared, %d identical' % (m['disc'], m['discSame'])])


def main(argv):
    cfg = argv[1] if len(argv) > 1 else CFG
    ids = battles(cfg)
    if not ids:
        print('no battle with a kept stream and a live record under %s' % cfg)
        return 1
    m = measure(ids, cfg, progress=lambda bid, n: sys.stderr.write('%s %d\n' % (bid, n)))
    print(table(m))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
