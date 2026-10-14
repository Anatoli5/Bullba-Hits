# -*- coding: utf-8 -*-
"""The modules' durability in a characteristics file (12.10, TTX_FORMAT 5), on the offline stand.

    python tests/py27/run27.py tests/py27/ttx_devices.py

exporter.ttx_block writes what the client holds about a vehicle's devices: the suspension's, the engine's, the radio's and the
fuel tank's durability (modules.*.health), the engine's fireStartingChance, the sizes of the two driving wheels
(modules.chassis.drivingWheelsSizes) and, per pair, the gun's, the turret ring's, the vision devices' and the ammunition
rack's (configs[].devices). Each figure is compared here with the client's own XML, read on its own from scripts.pkg
(packed_xml, not the client's readers), so no figure of the client is kept in this file:

  - the Tiger I (the user's reference vehicle of the research of 12.10): every device of its top pair and of the top modules;
  - the M-VI-Yoh: two pairs of tracks, each pair's own durability (modules.chassis.pairsHealth);
  - the Panhard EBR 105: wheels - a durability, no driving wheels;
  - bulkHealthFactor stays out: the client does not load it (the descriptor holds 0.0) while the XML has it.
No stand, no client, no python27 stdlib: SKIP. Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import os, sys, traceback, zipfile
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
WHEEL_SIZE_COEF = 2.2
lines, counts = [], [0, 0]


def finish(text, code):
    body = 'exit %d\n%s\n' % (code, '\n'.join(text))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(body)
    else:
        sys.stdout.write(body)


def check(ok, label, detail=''):
    counts[0 if ok else 1] += 1
    lines.append(('ok   ' if ok else 'FAIL ') + label + ('' if ok or not detail else ' - ' + detail))


def pair_of(health):
    """(maxHealth, maxRegenHealth) of a file's health block; None when it is not there."""
    return None if not isinstance(health, dict) else (health.get('maxHealth'), health.get('maxRegenHealth'))


def xml_health(node):
    """The same two figures of an XML section that carries maxHealth and maxRegenHealth."""
    return None if node is None else (float(node.findtext('maxHealth')), float(node.findtext('maxRegenHealth')))


def main():
    if not os.path.isfile(os.path.join(STAND, 'boot27.py')) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no offline stand (%s) or no client (%s)' % (STAND, GAME)], 77)
    saved = sys.stdout, sys.stderr
    try:
        import imp
        stand = sys.modules['ttx_stand'] = imp.new_module('ttx_stand')
        execfile(os.path.join(STAND, 'boot27.py'), stand.__dict__)
        vehicles = stand.__dict__['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        return finish(['SKIP: the stand did not boot on this client:\n' + traceback.format_exc()], 77)
    sys.stdout, sys.stderr = saved
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import exporter as ex
    from local_armor_inspector.packed_xml import decode
    package = zipfile.ZipFile(os.path.join(GAME, 'res', 'packages', 'scripts.pkg'))

    def xml(path):
        return decode(package.read('scripts/item_defs/vehicles/' + path))

    def components(nation, name):
        """{module name: its section} of a nation's components file (the 'shared' block)."""
        return dict((node.tag, node) for node in xml('%s/components/%s.xml' % (nation, name)).find('shared'))

    def built(type_name):
        block = ex.ttx_block(type_name, 'devices', log=False)
        nation, name = type_name.split(':')
        return block, xml('%s/%s.xml' % (nation, name)), nation

    check(ex.TTX_FORMAT >= 5, 'TTX_FORMAT is raised for the modules\' durability', 'it is %s' % ex.TTX_FORMAT)

    # ---- the Tiger I: every device against the client's XML
    block, tree, nation = built('germany:G04_PzVI_Tiger_I')
    check(block.get('format') == ex.TTX_FORMAT and not [w for w in block['warnings'] if 'durability' in w or 'fire' in w or 'wheels' in w],
          'Tiger I: the file is of the current format and no device was refused', repr(block['warnings']))
    modules = block['modules']
    chassis = modules['chassis']
    node = tree.find('chassis').find(chassis['name'])
    check(node is not None and pair_of(chassis.get('health')) == xml_health(node),
          'Tiger I: the suspension\'s durability is the top chassis\'s of the XML', '%r' % (chassis.get('health'),))
    check(node is not None and node.findtext('bulkHealthFactor') is not None and 'bulkHealthFactor' not in chassis,
          'Tiger I: the XML has bulkHealthFactor and the file does not (the client does not load it)')
    descr = vehicles.VehicleDescr(typeID=vehicles.g_list.getIDsByName('germany:G04_PzVI_Tiger_I'))
    check(float(getattr(descr.chassis, 'bulkHealthFactor', 0.0)) == 0.0,
          'the client\'s descriptor holds no bulkHealthFactor (0.0): were it loaded, the file should carry it',
          '%r' % getattr(descr.chassis, 'bulkHealthFactor', None))
    # The two driving wheels the XML names, front then rear: their radius x 2.2, the client's own arithmetic.
    names = (node.findtext('drivingWheels') or '').split()
    radius = dict(((wheel.findtext('name') or '').strip(), float(wheel.findtext('radius'))) for wheel in node.find('wheels')
                  if wheel.tag == 'wheel')
    sizes = chassis.get('drivingWheelsSizes') or []
    check(len(names) == 2 and len(sizes) == 2 and all(n in radius and abs(radius[n] * WHEEL_SIZE_COEF - s) < 1e-4 for n, s in zip(names, sizes)),
          'Tiger I: drivingWheelsSizes are the radii of the XML\'s two driving wheels x 2.2', '%r of %r' % (sizes, names))
    engine = components(nation, 'engines').get(modules['engine']['name'])
    check(pair_of(modules['engine'].get('health')) == xml_health(engine), 'Tiger I: the engine\'s durability is the top engine\'s of the XML',
          '%r' % (modules['engine'].get('health'),))
    check(engine is not None and modules['engine'].get('fireStartingChance') is not None
          and abs(modules['engine']['fireStartingChance'] - float(engine.findtext('fireStartingChance'))) < 1e-6,
          'Tiger I: the engine\'s fire chance is the XML\'s', '%r' % modules['engine'].get('fireStartingChance'))
    for key, listing in (('radio', 'radios'), ('fuelTank', 'fuelTanks')):
        check(key in modules and pair_of(modules[key].get('health')) == xml_health(components(nation, listing).get(modules[key]['name'])),
              'Tiger I: the %s\'s durability is the XML\'s' % key, '%r' % (modules.get(key),))
    top = [c for c in block['configs'] if c.get('top')][0]
    devices = top.get('devices') or {}
    turret = tree.find('turrets0').find(block['turrets'][top['turret']]['name'])
    check(pair_of(devices.get('ammoBay')) == xml_health(tree.find('hull').find('ammoBayHealth')),
          'Tiger I: the ammunition rack\'s durability is the hull\'s ammoBayHealth', '%r' % (devices.get('ammoBay'),))
    check(pair_of(devices.get('turretRotator')) == xml_health(turret.find('turretRotatorHealth')),
          'Tiger I: the turret ring\'s durability is the turret\'s turretRotatorHealth', '%r' % (devices.get('turretRotator'),))
    check(pair_of(devices.get('surveyingDevice')) == xml_health(turret.find('surveyingDeviceHealth')),
          'Tiger I: the vision devices\' durability is the turret\'s surveyingDeviceHealth', '%r' % (devices.get('surveyingDevice'),))
    check(pair_of(devices.get('gun')) == xml_health(components(nation, 'guns').get(top['gun'])),
          'Tiger I: the gun\'s durability is the XML\'s', '%r' % (devices.get('gun'),))
    check(all(isinstance(c.get('devices'), dict) and len(c['devices']) == 4 for c in block['configs']),
          'Tiger I: every pair carries its four devices')
    regen = [pair_of(devices.get(k)) for k in ('ammoBay', 'turretRotator', 'surveyingDevice', 'gun')] + [pair_of(chassis.get('health'))]
    check(all(p and p[0] > 0 and 0 < p[1] <= p[0] for p in regen), 'Tiger I: every durability is positive and its field-repair figure no bigger',
          '%r' % (regen,))

    # ---- two pairs of tracks: each pair's own durability
    block, tree, nation = built('usa:A144_M_VI_Y')
    chassis = block['modules']['chassis']
    pairs = [xml_health(p) for p in tree.find('chassis').find(chassis['name']).findall('trackPairParams')]
    check(len(pairs) == 2 and [pair_of(h) for h in chassis.get('pairsHealth') or []] == pairs,
          'M-VI-Yoh: each of the two track pairs carries its own durability', '%r against %r' % (chassis.get('pairsHealth'), pairs))
    check(pair_of(chassis.get('health')) in pairs, 'M-VI-Yoh: the suspension\'s own figure is one of the two pairs\'')

    # ---- wheels: a durability, no driving wheels
    block, tree, nation = built('france:F108_Panhard_EBR_105')
    chassis = block['modules']['chassis']
    check(pair_of(chassis.get('health')) == xml_health(tree.find('chassis').find(chassis['name']))
          and 'drivingWheelsSizes' not in chassis and 'pairsHealth' not in chassis,
          'Panhard EBR 105: the wheels\' durability, and no driving wheels or track pairs', '%r' % (chassis.get('health'),))
    lines.append('%d passed, %d failed' % (counts[0], counts[1]))
    return finish(lines, 1 if counts[1] else 0)


try:
    main()
except Exception:
    finish(lines + ['FAIL exception\n' + traceback.format_exc()], 1)
