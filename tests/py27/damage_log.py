# -*- coding: utf-8 -*-
"""The damage no shell dealt (damage_log.py, 25.09) under the client's own Python 2.7: the exporter runs it in the game.

Run:  python tests/py27/run27.py tests/py27/damage_log.py

A ram (both vehicles' ticks, the client-physics contact), a fire that destroys, the check - the same shapes as
tests/test_damage_log.py (CPython 3), here only to prove the module runs and answers the same under 2.7.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), 'mod'))
checks = []


def check(name, ok, detail=''):
    checks.append((name, bool(ok), detail))


def health(t, vehicle, old, new, attacker, reason, index, serial):
    return {'event': 'health', 'id': 'c%d' % serial, 'gameTime': t, 'receivedAt': 1000.0 + t, 'vehicleId': vehicle,
            'oldHealth': old, 'newHealth': new, 'attackerId': attacker, 'attackReasonId': index, 'attackReason': reason}


def main():
    from local_armor_inspector.damage_log import damage_log
    events = [health(10.0, 1, 1000, 850, 2, 'ramming', 2, 1), health(10.0, 2, 1200, 1180, 1, 'ramming', 2, 2),
              health(20.0, 1, 850, 800, 2, 'fire', 1, 3), health(20.5, 1, 800, -1, 2, 'fire', 1, 4),
              {'event': 'collision', 'at': 9.9, 'gameTime': 9.9, 'pair': [1, 2],
               'sides': [{'vehicleId': 1, 'local': [1.0, 2.0, 3.0], 'approach': -1.0},
                         {'vehicleId': 2, 'local': [0.0, 1.0, 0.0], 'approach': 4.0}]}]
    hits = [{'id': '1', 'gameTime': 5.0, 'targetId': 2, 'attackerId': 1, 'damage': 0}]
    out, result, held = damage_log(hits, events, [{'id': 1, 'maxHealth': 1000}, {'id': 2, 'maxHealth': 1200}], 1030.0)
    check('a ram and a fire, one event each', [e['kind'] for e in out] == ['ram', 'fire'], [e['kind'] for e in out])
    ram = out[0] if out else {}
    check('the ram: the one who drove into the contact rams, both sides counted, the contact kept',
          (ram.get('attackerId'), ram.get('targetId'), ram.get('damage'), ram.get('selfDamage'), ram.get('rammerFrom')) == (2, 1, 150, 20, 'contact')
          and ram.get('contact', {}).get('sides', {}).get('1', {}).get('local') == [1.0, 2.0, 3.0], json.dumps(ram)[:300])
    fire = out[1] if len(out) > 1 else {}
    check('the fire destroys: its total is the HP it had, closed, at its end',
          (fire.get('damage'), fire.get('killed'), fire.get('out'), fire.get('gameTime')) == (850, True, 'destroyed', 20.5), json.dumps(fire)[:300])
    check('the check: four anchors, all of them add up; nothing held back',
          (result['intervals'], result['matched'], result['mismatched'], held) == (4, 4, 0, 0), json.dumps(result)[:300])


if __name__ == '__main__':
    crashed = None
    try: main()
    except Exception:
        import traceback
        crashed = traceback.format_exc()
    failed = [c for c in checks if not c[1]]
    lines = ['damage log (py2.7): %d checks, %d failed' % (len(checks), len(failed) + bool(crashed))]
    lines += ['FAIL %s -- %s' % (name, detail) for name, ok, detail in failed]
    if crashed: lines.append('FAIL the script crashed:\n' + crashed)
    if not failed and not crashed: lines.append('ALL OK')
    result = os.environ.get('BULLBA_PY27_RESULT')
    if result:
        with open(result, 'w') as stream:
            stream.write('exit %d\n%s\n' % (1 if failed or crashed else 0, '\n'.join(lines)))
    else: print('\n'.join(lines))
