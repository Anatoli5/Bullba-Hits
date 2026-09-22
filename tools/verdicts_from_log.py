"""Tabulate the viewer's Statistics log lines from game.log: the server's result per contact point against our estimate.

The page prints one console line per recorded contact point ("Bullba Hits verdict: key=value ..."); when the page
runs inside the game client, the client copies the page's console into game.log. This script reads only those
lines (game.log holds private tokens elsewhere - nothing else is printed) and summarises where the server's fact
and our estimate disagree. The protocol for reading the numbers is docs/ANALYTICS.md (local agent context).

    runtime/python.exe tools/verdicts_from_log.py [game.log or snapshot ...] [options]

    --save DIR       copy the verdict lines of the inputs into DIR/verdicts-<date>.log (a snapshot that this
                     script reads like game.log; game.log itself is never copied)
    --version V      keep only the lines the page build V wrote (v=V); lines before 0.7.13 carry no version
    --he-rows        print every HE line with the server's damage and a plate: the fact against both laws
    --crits          crit tables on the last point of each hit: code x part, sources, items, and effect 4/5/6
                     against what the own vehicle's hit indicator and damage report named (lines of 22.09 on)
    --ricochets      hits by their chain of effects, and the server against us on the point after a ricochet
    --rows           print every line with its class

Several inputs are merged in order; for the same battle/hit/point/shell the last line read wins.
"""
import io
import os
import re
import sys
import time
from collections import Counter

LOG = r'C:\Games\World_of_Tanks_NA\game.log'
MARK = 'Bullba Hits verdict: '
PEN = ('Penetration', 'Penetration_without_damage', 'Critical_hit', 'Penetration_with_module_damage')
RICOCHET = ('Ricochet', 'Intermediate_ricochet')
NOPEN = ('No_penetration',)
CRIT_SERVER = ('Critical_hit', 'Penetration_with_module_damage')


def verdict_lines(path):
    with io.open(path, encoding='utf-8', errors='replace') as stream:
        for line in stream:
            if MARK in line:
                yield line.rstrip('\r\n')


def parse(paths):
    rows = {}
    for path in paths:
        for line in verdict_lines(path):
            at = line.find(MARK)
            fields = dict(pair.split('=', 1) for pair in line[at + len(MARK):].split() if '=' in pair)
            if 'battle' not in fields or 'hit' not in fields or 'point' not in fields:
                continue
            stamp = line[1:24] if line.startswith('[') else ''
            fields['at'] = stamp
            # The last line for a point and shell wins: the same hit is re-logged when the shell changes or the
            # hit is opened again; 'mode' says whether the line came from the automatic pass or from viewing.
            rows[(fields['battle'], fields['hit'], fields['point'], fields.get('shell', ''))] = fields
    return list(rows.values())


def save(paths, folder):
    if not os.path.isdir(folder):
        os.makedirs(folder)
    target = os.path.join(folder, 'verdicts-%s.log' % time.strftime('%Y-%m-%d'))
    count = 0
    with io.open(target, 'a', encoding='utf-8', newline='\n') as out:
        for path in paths:
            for line in verdict_lines(path):
                out.write(line + u'\n')
                count += 1
    print('Saved %d verdict lines to %s' % (count, target))


def classify(row):
    server, ours = row.get('server', ''), row.get('ours', '')
    expected = 'pen' if server in PEN else 'ricochet' if server in RICOCHET else 'no-pen' if server in NOPEN else None
    if expected is None:
        return 'unknown-server-effect'
    # A pass-through of the tracks or the gun ("penetration without damage" on the chassis or gun part) is not a
    # verdict on the main armour; the next point of the same hit carries that verdict.
    if server == 'Penetration_without_damage' and row.get('part') in ('chassis', 'gun'):
        return 'pass-through'
    # A module crit without HP damage (crit code 5/6 and 0 HP) against our "no penetration" is not a verdict on the
    # main armour either. Lines without hp= (pages before 22.09) keep their old class.
    if row.get('critCode') in ('5', '6') and row.get('hp') == '0' and server in CRIT_SERVER and ours.startswith('no-pen_'):
        return 'module-crit'
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


def ours_class(row):
    ours = row.get('ours', '')
    return 'ricochet' if ours == 'ricochet' else 'pen' if ours.startswith('pen_') else 'no-pen' if ours.startswith('no-pen_') else ours or '-'


def main(argv):
    paths, skip = [], False
    for arg in argv:
        if skip:
            skip = False
        elif arg in ('--save', '--version'):
            skip = True
        elif not arg.startswith('--'):
            paths.append(arg)
    if not paths:
        paths = [LOG]
    if '--save' in argv:
        save(paths, argv[argv.index('--save') + 1])
    rows = parse(paths)
    if not rows:
        print('No verdict lines in ' + ', '.join(paths))
        return 1
    if '--version' in argv:
        wanted = argv[argv.index('--version') + 1]
        rows = [r for r in rows if r.get('v', '?') == wanted]
        if not rows:
            print('No verdict lines from page build ' + wanted)
            return 1
    counts = Counter(classify(r) for r in rows)
    print('Verdict lines: %d (unique battle/hit/point/shell; modes %s)' % (len(rows), dict(Counter(r.get('mode', '?') for r in rows))))
    stamps = sorted(r['at'] for r in rows if r['at'])
    if stamps:
        print('Logged between %s and %s' % (stamps[0][:16], stamps[-1][:16]))
    # Every line is stamped with the page build (v=) and the records build (rec=) that produced our estimate; the
    # server's fact never changes, our estimate does with every release, so old lines are compared per version.
    print('Page versions: %s; records versions: %s' % (dict(Counter(r.get('v', '?') for r in rows)), dict(Counter(r.get('rec', '?') for r in rows))))
    print('Shells: %s' % dict(Counter(r.get('shell', '?') for r in rows)))
    for key in ('agree', 'coin-flip', 'DISAGREE', 'pass-through', 'module-crit', 'no-main-armour', 'no-estimate', 'unknown-server-effect'):
        if counts.get(key):
            print('  %-22s %d' % (key, counts[key]))
    bad = [r for r in rows if classify(r) == 'DISAGREE']
    if bad:
        devs = [float(r['chordDev']) for r in bad if r.get('chordDev', '-') != '-']
        print('Disagreements by direction source: %s' % dict(Counter(r.get('dir', '?') for r in bad)))
        # A pattern (the same server effect against the same class of ours, on the same part) is a rule we miss;
        # single cases are the dice or a bad line.
        patterns = Counter((r.get('part', '?'), r.get('server', '?'), ours_class(r)) for r in bad)
        print('Disagreement patterns (part, server, ours):')
        for (part, server, ours), n in sorted(patterns.items(), key=lambda kv: -kv[1]):
            print('  %2d  %-8s %-30s %s' % (n, part, server, ours))
        if devs:
            print('Mean chord deviation among disagreements: %.1f deg (%d with a chord)' % (sum(devs) / len(devs), len(devs)))
        print('')
        print('%-10s %-4s %-3s %-8s %-30s %-16s %-6s %-6s %-14s %-8s %s' % ('battle', 'hit', 'pt', 'part', 'server', 'ours', 'angle', 'pen', 'dir', 'chordDev', 'v'))
        for r in bad:
            print('%-10s %-4s %-3s %-8s %-30s %-16s %-6s %-6s %-14s %-8s %s' % (r['battle'][:10], r['hit'], r['point'], r.get('part', ''), r.get('server', ''), r.get('ours', ''), r.get('angle', ''), r.get('pen', ''), r.get('dir', ''), r.get('chordDev', ''), r.get('v', '?')))
    # HE non-penetrations with the server's damage: how far each candidate law lands from the fact, per page version.
    he = [r for r in rows if r.get('dmg', '-') != '-' and r.get('ours', '').startswith('no-pen') and r.get('expRatio', '-') != '-']
    print('')
    print('HE non-penetrations with server damage: %d (HE lines in all: %d)' % (len(he), sum(1 for r in rows if r.get('shell') == 'HIGH_EXPLOSIVE')))
    if he:
        print('Laws: %s' % dict(Counter(r.get('law', '?') for r in he)))
        for version in sorted(set(r.get('v', '?') for r in he)):
            group = [r for r in he if r.get('v', '?') == version]
            ratio = [abs(float(r['dmg']) - float(r['expRatio'])) for r in group]
            linear = [abs(float(r['dmg']) - float(r['expLin'])) for r in group if r.get('expLin', '-') != '-']
            print('  %-10s n=%-3d mean |server - ratio| = %5.1f HP   mean |server - linear| = %5.1f HP' % (
                version, len(group), sum(ratio) / len(ratio), (sum(linear) / len(linear)) if linear else float('nan')))
        print('  (one shot carries a +-25%% damage roll: only the means over many hits say which law is closer)')
    if '--he-rows' in argv:
        print('')
        print('%-10s %-4s %-3s %-8s %-30s %-12s %-5s %-5s %-5s %-5s %-8s %-8s %-6s %-15s %s' % ('battle', 'hit', 'pt', 'part', 'server', 'ours', 'dmg', 'alpha', 'plate', 'liner', 'expRatio', 'expLin', 'nonPen', 'law', 'v'))
        for r in sorted((r for r in rows if r.get('shell') == 'HIGH_EXPLOSIVE' and r.get('dmg', '-') != '-'), key=lambda r: (r['battle'], int(r['hit']), int(r['point']))):
            print('%-10s %-4s %-3s %-8s %-30s %-12s %-5s %-5s %-5s %-5s %-8s %-8s %-6s %-15s %s' % (
                r['battle'][:10], r['hit'], r['point'], r.get('part', ''), r.get('server', ''), r.get('ours', ''), r.get('dmg', '-'), r.get('alpha', '-'),
                r.get('plate', '-'), r.get('liner', '-'), r.get('expRatio', '-'), r.get('expLin', '-'), r.get('nonPenRatio', '-'), r.get('law', '-'), r.get('v', '?')))
    if '--crits' in argv:
        crit_tables(rows)
    if '--ricochets' in argv:
        ricochet_tables(rows)
    if '--rows' in argv:
        print('')
        for r in sorted(rows, key=lambda r: (r['battle'], int(r['hit']), int(r['point']))):
            print('%s %s/%s/%s %s server=%s ours=%s angle=%s dir=%s chordDev=%s critCode=%s crit=%s chain=%s v=%s -> %s' % (r['at'], r['battle'][:8], r['hit'], r['point'], r.get('part', ''), r.get('server', ''), r.get('ours', ''), r.get('angle', ''), r.get('dir', ''), r.get('chordDev', ''), r.get('critCode', '-'), r.get('crit', '-'), r.get('chain', '-'), r.get('v', '?'), classify(r)))
    return 0


def per_hit(rows):
    """One line per battle/hit, the one on its last point (pi = length of the chain - 1); pages from 22.09 on."""
    hits = {}
    for r in rows:
        chain, pi = r.get('chain', '-'), r.get('pi', '-')
        if chain != '-' and pi.isdigit() and int(pi) == len(chain.split(',')) - 1:
            hits[(r['battle'], r['hit'])] = r
    return list(hits.values())


def crit_tables(rows):
    hits = per_hit(rows)
    print('')
    print('Crits: %d hits with a line on their last point (pages from 22.09; the log has lines only for hits with a model,' % len(hits))
    print('  so crit counts, the 5-vs-6 test and the logging test read the records: tools/crits_from_records.py)')
    if not hits:
        return
    print('Crit code x part: %s' % dict(Counter((r.get('critCode', '-'), r.get('part', '?')) for r in hits if r.get('critCode', '-') != '-')))
    print('Sources: %s' % dict(Counter(r.get('critSrc', '-') for r in hits)))
    items = Counter(item for r in hits if r.get('crit', '-') != '-' for item in r['crit'].split(','))
    print('Items: %s' % dict(items.most_common()))
    # The 5-vs-6 test (corr. 6): the last effect against what the own vehicle's channels named, code 4 included.
    named = [r for r in hits if set(r.get('critSrc', '-').split('+')) & set(('mask', 'info'))]
    print('Effect 4/5/6 against the named damage (%d hits with the hit indicator or the damage report):' % len(named))
    columns = ('device critical', 'device destroyed', 'crew injured', 'fire', 'none')
    print('  %-6s %s' % ('last', ' '.join('%-16s' % c for c in columns)))
    for code in ('4', '5', '6'):
        table = Counter()
        for r in named:
            if r.get('chain', '-').split(',')[-1] != code:
                continue
            states = [item.rsplit(':', 1)[-1] for item in r.get('crit', '-').split(',') if ':' in item]
            found = set()
            for state in states:
                found.add('crew injured' if state == 'injured' else 'fire' if state == 'started' else
                          'device destroyed' if state in ('destroyed', 'detonated', 'burnOff') else 'device critical')
            for column in found or ('none',):
                table[column] += 1
        print('  %-6s %s' % (code, ' '.join('%-16d' % table[c] for c in columns)))


def ricochet_tables(rows):
    hits = per_hit(rows)
    print('')
    print('Hits by chain of effects (%d hits, pages from 22.09): %s' % (len(hits), dict(Counter(r.get('chain', '-') for r in hits).most_common())))
    after = [r for r in rows if r.get('prev') == '1']
    print('After an intermediate ricochet (prev=1, our ray starts at the ricochet point with the full penetration): %d lines' % len(after))
    if after:
        print('  %s' % dict(Counter(classify(r) for r in after)))
        print('  by server effect: %s' % dict(Counter((r.get('server', '?'), ours_class(r)) for r in after)))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
