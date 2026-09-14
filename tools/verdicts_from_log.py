"""Tabulate the viewer's verdict lines from game.log: the server's result per contact point against our estimate.

The page prints one console line per recorded contact point ("Bullba Hits verdict: key=value ..."), and the game
copies the page's console into game.log. This script reads only those lines (game.log holds private tokens
elsewhere - nothing else is printed) and summarises where the server's fact and our estimate disagree.

    runtime/python.exe tools/verdicts_from_log.py [path\\to\\game.log] [--rows]
"""
import io
import re
import sys
from collections import Counter

LOG = r'C:\Games\World_of_Tanks_NA\game.log'
MARK = 'Bullba Hits verdict: '
PEN = ('Penetration', 'Penetration_without_damage', 'Critical_hit', 'Penetration_with_module_damage')
RICOCHET = ('Ricochet', 'Intermediate_ricochet')
NOPEN = ('No_penetration',)


def parse(path):
    rows = {}
    with io.open(path, encoding='utf-8', errors='replace') as stream:
        for line in stream:
            at = line.find(MARK)
            if at < 0:
                continue
            fields = dict(pair.split('=', 1) for pair in line[at + len(MARK):].split() if '=' in pair)
            if 'battle' not in fields or 'hit' not in fields or 'point' not in fields:
                continue
            stamp = line[1:24] if line.startswith('[') else ''
            fields['at'] = stamp
            # The last line for a point and shell wins: the same hit is re-logged when the shell changes or the
            # hit is opened again; 'mode' says whether the line came from the automatic pass or from viewing.
            rows[(fields['battle'], fields['hit'], fields['point'], fields.get('shell', ''))] = fields
    return list(rows.values())


def classify(row):
    server, ours = row.get('server', ''), row.get('ours', '')
    expected = 'pen' if server in PEN else 'ricochet' if server in RICOCHET else 'no-pen' if server in NOPEN else None
    if expected is None:
        return 'unknown-server-effect'
    # A pass-through of the tracks or the gun ("penetration without damage" on the chassis or gun part) is not a
    # verdict on the main armour; the next point of the same hit carries that verdict.
    if server == 'Penetration_without_damage' and row.get('part') in ('chassis', 'gun'):
        return 'pass-through'
    if row.get('angle', '-') == '-' and not ours.startswith('ricochet'):
        return 'no-main-armour'
    mine = 'ricochet' if ours == 'ricochet' else 'pen' if ours.startswith('pen_') else 'no-pen' if ours.startswith('no-pen_') else 'none'
    if mine == 'none':
        return 'no-estimate'
    chance = re.search(r'_(\d+)%', ours)
    coin = chance is not None and 25 <= int(chance.group(1)) <= 75 and expected != 'ricochet' and mine != 'ricochet'
    if mine == expected:
        return 'agree'
    return 'coin-flip' if coin else 'DISAGREE'


def main(argv):
    path = next((a for a in argv if not a.startswith('--')), LOG)
    rows = parse(path)
    if not rows:
        print('No verdict lines in ' + path)
        return 1
    counts = Counter(classify(r) for r in rows)
    print('Verdict lines: %d (unique battle/hit/point/shell; modes %s)' % (len(rows), dict(Counter(r.get('mode', '?') for r in rows))))
    for key in ('agree', 'coin-flip', 'DISAGREE', 'pass-through', 'no-main-armour', 'no-estimate', 'unknown-server-effect'):
        if counts.get(key):
            print('  %-22s %d' % (key, counts[key]))
    bad = [r for r in rows if classify(r) == 'DISAGREE']
    if bad:
        devs = [float(r['chordDev']) for r in bad if r.get('chordDev', '-') != '-']
        print('Disagreements by direction source: %s' % dict(Counter(r.get('dir', '?') for r in bad)))
        if devs:
            print('Mean chord deviation among disagreements: %.1f deg (%d with a chord)' % (sum(devs) / len(devs), len(devs)))
        print('')
        print('%-10s %-4s %-3s %-8s %-30s %-16s %-6s %-6s %-14s %s' % ('battle', 'hit', 'pt', 'part', 'server', 'ours', 'angle', 'pen', 'dir', 'chordDev'))
        for r in bad:
            print('%-10s %-4s %-3s %-8s %-30s %-16s %-6s %-6s %-14s %s' % (r['battle'][:10], r['hit'], r['point'], r.get('part', ''), r.get('server', ''), r.get('ours', ''), r.get('angle', ''), r.get('pen', ''), r.get('dir', ''), r.get('chordDev', '')))
    if '--rows' in argv:
        print('')
        for r in sorted(rows, key=lambda r: (r['battle'], int(r['hit']), int(r['point']))):
            print('%s %s/%s/%s %s server=%s ours=%s angle=%s dir=%s chordDev=%s -> %s' % (r['at'], r['battle'][:8], r['hit'], r['point'], r.get('part', ''), r.get('server', ''), r.get('ours', ''), r.get('angle', ''), r.get('dir', ''), r.get('chordDev', ''), classify(r)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
