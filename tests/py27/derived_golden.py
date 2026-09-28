# -*- coding: utf-8 -*-
"""What publish() writes for a saved battle, pinned (startup-review-fixes, 27.09), inside the client's own python27.dll.

    python tests/py27/run27.py tests/py27/derived_golden.py            the check
    python tests/py27/run27.py tests/py27/derived_golden.py update     store the output of a raised DERIVED_FORMAT

data/published.json stamps a battle's derived file with DERIVED_FORMAT (not the build): the next start publishes a battle
again only when that stamp changed. So a change of publish()'s output that does not raise DERIVED_FORMAT would leave every
saved battle in its old form for good. This test publishes one synthetic battle (every block publish() fills: the hits with
their four parts and armour, the shooter's parts, a roster, a shot, crit ties, a fire and a ram) and compares the file byte
for byte with tests/golden/derived-battle-<DERIVED_FORMAT>.js:

  - the same: ok;
  - different: raise DERIVED_FORMAT in exporter.py, then run with 'update' - the file of the new format is stored beside the
    old one, which stays: tests/test_derived_formats.cjs checks that the page still reads every earlier format (the users'
    battles stay in it until the background has published them again);
  - no file for this DERIVED_FORMAT: run with 'update'.

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, logging, os, shutil, sys, tempfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
UPDATE = 'update' in sys.argv[1:]
GOLDEN = os.path.join(REPO, 'tests', 'golden')
report = []
failures = []
logging.getLogger('local.armor_inspector').addHandler(logging.NullHandler())
logging.getLogger('local.armor_inspector').propagate = False


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


VERSION = 'client 1\n'
BATTLE = 'golden-battle'
ME, ENEMY, ALLY = 101, 202, 303
FOLDER = 'vehicles/german/G1_Test/collision_client/'
NAMES = ('Chassis', 'Hull', 'Turret', 'Gun')
IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def parts(lift):
    found = []
    for number, name in enumerate(NAMES):
        pose = list(IDENTITY)
        pose[13] = lift * number
        found.append({'id': number, 'name': name.lower(), 'resource': FOLDER + name + '.model', 'transform': pose,
                      'armor': {'1': {'armor': 20.0 + 10 * number, 'useHitAngle': True, 'mayRicochet': True},
                                '2': {'armor': 5.0, 'vehicleDamageFactor': 0.0}}})
    return found


def vehicle(name, type_name, lift):
    return {'name': name, 'type': type_name, 'compactDescriptor': 'EX8kATkB0AAZAf0ASQEA', 'gun': '105 mm test',
            'gunDispersion': 0.00383, 'maxHealth': 1500, 'parts': parts(lift)}


def hit(number, direction, attacker, target, damage, t):
    return {'schema': 1, 'type': 'hit', 'id': str(number), 'direction': direction, 'gameTime': t, 'receivedAt': 1000.0 + t,
            'attackerId': attacker, 'targetId': target, 'damage': damage, 'effectsIndex': 5, 'shellVelocity': 900.0,
            'rangeAtImpact': 180.5, 'points': [{'position': [0.25, 1.5, 2.0], 'partId': 1, 'normal': [0.0, 0.0, 1.0]}],
            'aim': [0.01, -0.02],
            'target': vehicle('Target', 'german:G1_Test', 0.5 if target == ME else 0.6),
            'attacker': vehicle('Shooter', 'german:G1_Test', 0.7)}


def health(serial, t, target, old, new, attacker, reason, reason_id):
    return {'schema': 1, 'type': 'crit', 'event': 'health', 'id': 'c%d' % serial, 'gameTime': t, 'receivedAt': 1000.0 + t,
            'vehicleId': target, 'oldHealth': old, 'newHealth': new, 'attackerId': attacker, 'attackReasonId': reason_id,
            'attackReason': reason, 'attackReasonExtId': -1}


def raw_battle():
    rows = [{'schema': 1, 'type': 'battle', 'id': BATTLE, 'startedAt': 1700000000, 'map': 'Golden', 'clientVersion': VERSION,
             'playerVehicleId': ME, 'recorderVersion': '0.8.7'},
            {'schema': 1, 'type': 'roster', 'playerTeam': 1, 'playerVehicleId': ME, 'vehicles': [
                {'id': ME, 'name': 'Target', 'type': 'german:G1_Test', 'team': 1, 'player': 'me', 'maxHealth': 1500},
                {'id': ENEMY, 'name': 'Shooter', 'type': 'german:G1_Test', 'team': 2, 'player': 'enemy', 'maxHealth': 1500},
                {'id': ALLY, 'name': 'Ally', 'type': 'german:G1_Test', 'team': 1, 'player': 'ally', 'maxHealth': 1000}]},
            {'schema': 1, 'type': 'shot', 'gameTime': 9.5, 'attackerId': ENEMY, 'shotId': 7, 'position': [0, 2, 0],
             'velocity': [0, 0, 900.0], 'gravity': 9.81, 'effectsIndex': 5},
            hit(1, 'incoming', ENEMY, ME, 320, 10.0),
            health(1, 10.0, ME, 1500, 1180, ENEMY, None, 0),
            {'schema': 1, 'type': 'crit', 'event': 'fire', 'id': 'c2', 'gameTime': 10.1, 'vehicleId': ME, 'state': 'started'},
            health(3, 11.0, ME, 1180, 1150, ENEMY, 'fire', 1),
            health(4, 12.0, ME, 1150, 1120, ENEMY, 'fire', 1),
            {'schema': 1, 'type': 'crit', 'event': 'fire', 'id': 'c5', 'gameTime': 12.5, 'vehicleId': ME, 'state': 'stopped'},
            hit(2, 'outgoing', ME, ENEMY, 0, 20.0),
            health(6, 30.0, ME, 1120, 1100, ALLY, 'ramming', 2),
            health(7, 30.0, ALLY, 1000, 990, ME, 'ramming', 2)]
    return ''.join(json.dumps(row, sort_keys=True) + '\n' for row in rows)


temp = tempfile.mkdtemp()
try:
    from local_armor_inspector import exporter as ex
    folder = os.path.join(temp, 'data-folder')
    os.makedirs(os.path.join(folder, 'battles'))
    os.makedirs(os.path.join(folder, 'data', 'models'))
    with open(os.path.join(folder, 'battles', BATTLE + '.jsonl'), 'wb') as stream: stream.write(raw_battle())
    for name in NAMES:
        key = ex.model_key(FOLDER + name + '.model', VERSION)
        with open(os.path.join(folder, 'data', 'models', key + '.js'), 'wb') as stream:
            stream.write('ArmorInspectorData.receive(["model:%s",{}]);\n' % key)
    e = ex.Exporter(os.path.join(temp, 'game'), folder, VERSION)
    e.republish_saved(BATTLE)
    with open(os.path.join(folder, 'data', 'battles', BATTLE + '.js'), 'rb') as stream: data = stream.read()
    value = ex.read_data_file(os.path.join(folder, 'data', 'battles', BATTLE + '.js'))
    check(len(value['hits']) == 2 and value.get('damageEvents') and value.get('critStats') is not None
          and all(p.get('modelKey') for h in value['hits'] for p in h['target']['parts']),
          'the fixture battle fills every block (hits with their models, crit ties, damage events)',
          sorted(value))
    path = os.path.join(GOLDEN, 'derived-battle-%d.js' % ex.DERIVED_FORMAT)
    if UPDATE:
        if os.path.exists(path):
            with open(path, 'rb') as stream: stored = stream.read()
            check(stored == data, 'update: the file of DERIVED_FORMAT %d is kept as it is - raise DERIVED_FORMAT first'
                  % ex.DERIVED_FORMAT)
        else:
            if not os.path.isdir(GOLDEN): os.makedirs(GOLDEN)
            with open(path, 'wb') as stream: stream.write(data)
            report.append('stored %s (%d bytes)' % (os.path.relpath(path, REPO), len(data)))
    elif not os.path.exists(path):
        check(False, 'tests/golden/derived-battle-%d.js exists: DERIVED_FORMAT was raised - run this test with "update"'
              % ex.DERIVED_FORMAT)
    else:
        with open(path, 'rb') as stream: stored = stream.read()
        check(stored == data, 'publish() writes the fixture battle as tests/golden/derived-battle-%d.js - if the change is '
              'meant, raise DERIVED_FORMAT in exporter.py and run this test with "update" (the saved battles are published '
              'again only then)' % ex.DERIVED_FORMAT, '%d bytes against %d' % (len(data), len(stored)))
except Exception:
    import traceback
    report.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
finally:
    shutil.rmtree(temp, ignore_errors=True)
report.append('%d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
