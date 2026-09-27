# -*- coding: utf-8 -*-
"""The wheels of a wheeled vehicle as collision parts (BACKLOG 39, 26.09), under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/wheels.py [MOD_DIR]   (default <repo>/mod)

The real mod with the client stubs and fixtures of recorder_two_battles.py (imported, not run), and a made-up wheeled
vehicle: four collision wheels of 5 and 10 mm (the client's MaterialInfo shape, kind 254 'wheel', extra wheel<i>Health),
a track wheel with no armour, the chassis XML in the client's layout. Checks, by group:

  parts      exporter.wheel_parts: part -k is the wheel of index k-1 (its extra's number), in that order, with the
             'wheel' material and its own armour over the common table (a screen: vehicleDamageFactor 0, collide once);
             one table object per material (the quick check of live_materials); a tracked vehicle has none
  shapes     wheel_shapes from the XML: the nonTrack procedural wheels only, `radius` or `geometry/radius`, the width,
             16 sides, at wheelPos; fill_wheels gives a part its body only when the XML's index is the part's
  snapshot   the published snapshot keeps a wheel's rest place in the static part (the hit's poses carry null there)
             and unpacks it back; the page's poses of the other parts are untouched
  publish    publish_vehicle_parts leaves a wheel alone (no model, no XML armour); prepare_hit gives the recorded
             wheels their body in a battle of the running client, not in another client's; a record without wheels
             is published as it was
  vehicles   load_vehicles: a wheeled vehicle's file from before the wheels is exported again once by the replay (its
             own source kept) even with no request line; a tracked one is marked and written back
  recorder   a hit on a wheeled target: its wheels are parts -1..-4 with their armour (armorRef in the raw line), a
             contact on -3 is 'resolved' with the collision's name for it; the wheeled shooter's rest parts carry his;
             a collision whose names disagree gets no wheels and its contact stays 'unsupported-part'

Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import glob
import imp
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import traceback
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True
rtb = imp.load_source('recorder_two_battles27', os.path.join(HERE, 'recorder_two_battles.py'))
check, checks = rtb.check, rtb.checks
WORLD, NS, V3 = rtb.WORLD, rtb.NS, rtb.V3

MaterialInfo = namedtuple('MaterialInfo', 'kind armor extra multipleExtra vehicleDamageFactor useArmorHomogenization '
                          'useHitAngle useAntifragmentationLining mayRicochet collideOnceOnly checkCaliberForRicochet '
                          'checkCaliberForHitAngleNorm damageKind chanceToHitByProjectile chanceToHitByExplosion '
                          'continueTraceIfNoHit tags')


def material(kind, armor, extra=None, damage=0.0, main=False):
    return MaterialInfo(kind, armor, extra, not main, damage, main, main, main, main, not main, main, main, 0, 1.0, 1.0,
                        False, frozenset())


NAMES = {1: 'armor_1', 2: 'armor_2', 254: 'wheel'}
COMMON = {1: material(1, None, None, 1.0, True), 2: material(2, None, None, 1.0, True), 254: material(254, None, 'wheelHealth')}
# name, XML index, thickness - listed out of index order on purpose (the client keeps them in a dict).
WHEELS = [('W_R1', 3, 10.0), ('WD_L1', 0, 5.0), ('W_L1', 2, 10.0), ('WD_R1', 1, 5.0)]
POSITIONS = {'WD_L1': (-1.02, 0.61, -2.14), 'WD_R1': (1.02, 0.61, -2.14), 'W_L1': (-1.03, 0.58, -0.70), 'W_R1': (1.03, 0.58, -0.70)}
XML = ('<root><chassis><Chassis_W><wheels><lodDist>MEDIUM</lodDist>' +
       ''.join('<wheel><index>%d</index><name>%s</name><nonTrack>true</nonTrack>%s<proceduralCollisionBody>true'
               '</proceduralCollisionBody><armor><wheel>%g</wheel></armor><wheelPos>%s</wheelPos></wheel>' % (
                   index, name, ('<radius>0.609</radius><geometry><width>0.35</width></geometry>' if name.startswith('WD') else
                                 '<geometry><radius>0.59</radius><width>0.35</width><pivotXOffset>0.1</pivotXOffset></geometry>'),
                   mm, ' '.join('%g' % v for v in POSITIONS[name])) for name, index, mm in WHEELS) +
       # a track wheel (no nonTrack, no body, no armour): not a collision part
       '<wheel><index>4</index><name>W_T</name><geometry><radius>0.3</radius></geometry></wheel>'
       '</wheels></Chassis_W></chassis></root>')


def wheeled(type_name):
    descr = rtb.descriptor(type_name)
    descr.chassis.name = 'Chassis_W'
    descr.chassis.wheelsArmor = dict((name, material(254, mm, 'wheel%dHealth' % index)) for name, index, mm in WHEELS)
    descr.chassis.generalWheelsAnimatorConfig = NS(getNonTrackWheelsCount=lambda: len(WHEELS))
    return descr


def stubs():
    rtb.module('material_kinds', NAMES_BY_IDS=NAMES, IDS_BY_NAMES=dict((v, k) for k, v in NAMES.items()))
    sys.modules['items.vehicles'].g_cache.commonConfig['materials'] = COMMON


def exporter_checks(ex, records, temp):
    import xml.etree.ElementTree as ET
    group = 'parts'
    descr = wheeled('france:W_Test')
    parts = ex.wheel_parts(descr)
    check(group, 'part -k is the wheel of index k-1, in index order', [(p['id'], p['name']) for p in parts] ==
          [(-1, 'WD_L1'), (-2, 'WD_R1'), (-3, 'W_L1'), (-4, 'W_R1')], [(p['id'], p['name']) for p in parts])
    wheel = dict((p['name'], p) for p in parts)
    table = wheel['W_L1'].get('armor') or {}
    check(group, 'each wheel: the client material name and its own thickness over the common table',
          all(p.get('material') == 'wheel' for p in parts) and table.get('wheel', {}).get('armor') == 10.0
          and wheel['WD_L1']['armor']['wheel']['armor'] == 5.0 and 'armor_1' in table, table.get('wheel'))
    w = table.get('wheel', {})
    check(group, 'a wheel is a screen: no damage, collide once, no angle, no ricochet',
          w.get('vehicleDamageFactor') == 0.0 and w.get('collideOnceOnly') is True and w.get('useHitAngle') is False
          and w.get('mayRicochet') is False, w)
    again = ex.wheel_parts(descr)
    check(group, 'one table object per material on the next call (the quick check of live_materials holds)',
          all(a['armor'] is b['armor'] for a, b in zip(parts, again)))
    check(group, 'a tracked vehicle has no wheel parts', ex.wheel_parts(rtb.descriptor('usa:T_Tracked')) == [])
    odd = wheeled('france:W_Odd')
    odd.chassis.wheelsArmor['W_X'] = material(254, 5.0, 'wheelHealth')
    check(group, 'a material without its index is left out', [p['name'] for p in ex.wheel_parts(odd)] ==
          ['WD_L1', 'WD_R1', 'W_L1', 'W_R1'])

    group = 'shapes'
    tree = ET.fromstring(XML)
    shapes = ex.wheel_shapes(tree, 'Chassis_W')
    check(group, 'the collision wheels only (the track wheel is none)', sorted(shapes) == sorted(n for n, _, _ in WHEELS), sorted(shapes))
    check(group, '`radius` or `geometry/radius`, the width, 16 sides',
          shapes['WD_L1']['wheel'] == {'radius': 0.609, 'width': 0.35, 'sides': 16}
          and shapes['W_L1']['wheel'] == {'radius': 0.59, 'width': 0.35, 'sides': 16}, shapes['W_L1'])
    check(group, 'at wheelPos, no rotation (pivotXOffset is no shift of the body)',
          shapes['W_L1']['transform'] == [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, -1.03, 0.58, -0.70, 1.0]
          and shapes['W_L1']['index'] == 2, shapes['W_L1']['transform'])
    check(group, 'another chassis or no wheels: nothing', ex.wheel_shapes(tree, 'Chassis_Other') == {})
    block = {'parts': [dict(p) for p in parts] + [{'id': 0, 'name': 'chassis'}]}
    check(group, 'fill_wheels: every wheel gets its body and place', ex.fill_wheels(block, shapes) == 4
          and all('wheel' in p and p['transform'][12:15] == list(POSITIONS[p['name']]) for p in block['parts'] if p['id'] < 0)
          and 'wheel' not in block['parts'][-1], block['parts'][0])
    swapped = dict(shapes)
    swapped['W_L1'] = dict(shapes['W_L1'], index=3)
    block = {'parts': [dict(p) for p in parts]}
    check(group, 'fill_wheels: an XML index other than the part stands for leaves the part as recorded',
          ex.fill_wheels(block, swapped) == 3 and 'wheel' not in [p for p in block['parts'] if p['name'] == 'W_L1'][0])

    group = 'snapshot'
    ex.fill_wheels(block, shapes)
    statics = [{'id': i, 'name': n, 'resource': 'vehicles/t/%s.model' % n, 'transform': rtb.Matrix and
                [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0.0, 0.1 * i, 0.0, 1.0], 'armor': {'armor_1': {'armor': 20.0}}}
               for i, n in enumerate(('chassis', 'hull', 'turret', 'gun'))]
    hit = {'type': 'hit', 'id': 'h1', 'target': {'type': 'france:W_Test', 'compactDescriptor': 'd',
           'parts': statics + [dict(p) for p in block['parts']], 'worldTransform': [1] * 16}, 'points': []}
    packed = records.pack_battle({'id': 'b', 'hits': [hit]})
    poses = packed['hits'][0]['target'].get('partPoses') or []
    check(group, 'the hit\'s poses: the static parts\' own, null for every wheel',
          len(poses) == 8 and all(p is not None for p in poses[:4]) and all(p is None for p in poses[4:]), poses[4:])
    back = records.unpack_battle(packed)['hits'][0]['target']['parts']
    check(group, 'unpacked: every wheel back at its place with its body, the static parts at theirs',
          [p.get('transform') for p in back] == [p.get('transform') for p in hit['target']['parts']]
          and all(p.get('wheel') for p in back[4:]), [p.get('transform') for p in back][4:5])

    group = 'publish'
    game, folder = os.path.join(temp, 'game'), os.path.join(temp, 'data-folder')
    os.makedirs(game)
    os.makedirs(folder)
    e = ex.Exporter(game, folder, 'client 1\n')
    e.model_cached = lambda resource, version: ('k' + resource[-7:-6], None)
    e.armor.xml = lambda name: ET.fromstring(XML)
    wheels = [dict(p) for p in block['parts']]
    e.publish_vehicle_parts(wheels, {'type': 'france:W_Test'}, e.version)
    check(group, 'publish_vehicle_parts leaves a wheel alone: no model key, no pending, no error, its armour as it was',
          all(not any(k in p for k in ('modelKey', 'modelPending', 'modelError', 'armorError')) for p in wheels)
          and all(p['armor'] is q['armor'] for p, q in zip(wheels, block['parts'])))
    saved = ex.vehicle_descr
    ex.vehicle_descr = lambda compact: descr
    try:
        def raw(with_wheels):
            target = {'type': 'france:W_Test', 'compactDescriptor': 'd', 'worldTransform': [1] * 16,
                      'parts': [dict(p) for p in statics] + ([dict(p) for p in parts] if with_wheels else [])}
            attacker = {'type': 'france:W_Test', 'compactDescriptor': 'd', 'partsFrom': 'rest pose',
                        'parts': [dict(p) for p in statics] + ([dict(p) for p in parts] if with_wheels else [])}
            return {'type': 'hit', 'id': 'h', 'target': target, 'attacker': attacker, 'warnings': [],
                    'points': [{'status': 'resolved', 'part': -3, 'position': [-0.175, 0.2, 0.1]}]}
        battle = {'id': 'b1', 'clientVersion': 'client 1\n', 'hits': []}
        # The publication never reads the XML itself, in the hangar too (review of d1b372b): the extras job does.
        calls = []
        e.armor.xml = lambda name: calls.append(name) or ET.fromstring(XML)
        e.jobs, e.job_index, e.waiting, e.republish = [], {}, {}, set()
        first = e.prepare_hit(raw(True), 0, battle)
        e.prepare_hit(raw(True), 1, battle)
        check(group, 'the hangar: the publication reads no XML, the wheels wait for the one extras job',
              calls == [] and not any('wheel' in p for p in first['target']['parts'] if p['id'] < 0)
              and [j[2] for j in e.jobs] == ['extras'], (list(calls), [j[2] for j in e.jobs]))
        e.run_extras_job(e.take_job(0)[3])
        check(group, 'the job reads the vehicle XML once a session per type and asks for the battle again',
              calls == ['scripts/item_defs/vehicles/france/W_Test.xml'] and e.republish == set(['b1']), (list(calls), e.republish))
        hit = e.prepare_hit(raw(True), 0, battle)
        tw = [p for p in hit['target']['parts'] if p['id'] < 0]
        aw = [p for p in hit['attacker']['parts'] if p['id'] < 0]
        check(group, 'prepare_hit: the recorded wheels of both sides get body and rest place (the running client)',
              len(tw) == 4 and all(p.get('wheel') and p.get('transform') for p in tw + aw) and len(aw) == 4
              and tw[2]['transform'][12:15] == list(POSITIONS['W_L1']), [p.get('transform') for p in tw][:1])
        check(group, 'the contact on -3 stays resolved', hit['points'][0]['status'] == 'resolved')
        other = e.prepare_hit(raw(True), 0, {'id': 'b2', 'clientVersion': 'client 0\n', 'hits': []})
        check(group, 'another client\'s battle: the wheels stay as recorded (no XML of that version)',
              not any('wheel' in p for p in other['target']['parts']))
        old = e.prepare_hit(raw(False), 0, battle)
        check(group, 'a record without wheels is published as it was: four parts, no wheel',
              [p['id'] for p in old['target']['parts']] == [0, 1, 2, 3])
        e.prepare_hit(raw(True), 1, battle)
        check(group, 'the vehicle XML is read once a session per type', calls ==
              ['scripts/item_defs/vehicles/france/W_Test.xml'], calls)

        # Review of 5f2bee5: no XML during a battle - the hit goes out without the wheels' bodies, waits under the type's
        # key, the extras job reads the XML after the battle and the battle is published again with them.
        group = 'battle'
        calls[:] = []
        e.extras_cache = {}
        e.recorder = NS(in_battle=True, busy_until=0)
        e.jobs, e.job_index, e.waiting, e.republish = [], {}, {}, set()
        e.current = battle
        e.reset_prepared()
        hit = e.prepare_hit(raw(True), 0, battle, track=True)
        check(group, 'in a battle: the XML is not read, the wheels go out without body, the hit is published',
              calls == [] and not any('wheel' in p for p in hit['target']['parts'] if p['id'] < 0)
              and hit['points'][0]['status'] == 'resolved', calls)
        key = ex.EXTRAS_KEY + 'france:W_Test'
        check(group, "the extras job is queued once, the battle and the hit wait under the type's key",
              [j[2] for j in e.jobs] == ['extras'] and e.waiting.get(key) == set(['b1']) and 0 in e.prepared_models.get(key, ()),
              ([j[2] for j in e.jobs], e.waiting, e.prepared_models.get(key)))
        e.prepare_hit(raw(True), 1, battle, track=True)
        check(group, 'a second hit of the type queues no second job', len(e.jobs) == 1, len(e.jobs))
        check(group, 'no job runs during the battle', e.run_job() is False and len(e.jobs) == 1)
        e.recorder.in_battle = False
        e.prepared_hits = [dict(hit), dict(hit)]
        e.last_job = 0
        e.run_job()
        check(group, 'after the battle: the job reads the XML once, drops the waiting hits and asks for the battle again',
              calls == ['scripts/item_defs/vehicles/france/W_Test.xml'] and e.prepared_hits == [None, None]
              and 'b1' in e.republish and key not in e.waiting, (calls, e.prepared_hits, e.republish))
        again = e.prepare_hit(raw(True), 0, battle)
        check(group, 'published again: the wheels have their body', all('wheel' in p for p in again['target']['parts'] if p['id'] < 0))
        e.recorder, e.current = None, None

        # A failed XML read is kept (with its reason) and never repeated: no XML scan per hit, one warning a session.
        group = 'failure'
        tries = []
        def broken(name):
            tries.append(name)
            raise ValueError('Armor definitions overridden by a mod')
        e.armor.xml = broken
        e.extras_cache = {}
        e.jobs, e.job_index = [], {}
        e.prepare_hit(raw(True), 0, battle)
        e.run_extras_job(e.take_job(0)[3])
        for n in range(3):
            failed = e.prepare_hit(raw(True), n, battle)
        check(group, 'an XML that does not read is tried once a session, not per hit', len(tries) == 1 and not e.jobs, tries)
        check(group, 'the wheels then go out without body, the contact stays resolved',
              not any('wheel' in p for p in failed['target']['parts'] if p['id'] < 0) and failed['points'][0]['status'] == 'resolved')

        group = 'vehicles'
        vehicles = os.path.join(folder, 'data', 'vehicles')
        if not os.path.isdir(vehicles): os.makedirs(vehicles)
        for ident, type_name, source in (('france-W_Test', 'france:W_Test', 'catalogue'), ('usa-T_Tracked', 'usa:T_Tracked', 'hangar')):
            ex.write_data(os.path.join(vehicles, ident + '.js'), 'vehicle:' + ident,
                          {'schema': 1, 'id': ident, 'type': type_name, 'compactDescriptor': type_name, 'source': source,
                           'clientVersion': e.version, 'name': ident, 'level': 8, 'staticParts': 4,
                           'parts': [dict((k, v) for k, v in p.items() if k != 'armor') for p in statics]})
        tracked = rtb.descriptor('usa:T_Tracked')
        built = []
        def descr_of(compact):
            built.append(compact)
            return descr if compact == 'france:W_Test' else tracked
        ex.vehicle_descr = descr_of
        tracked_path = os.path.join(vehicles, 'usa-T_Tracked.js')
        stamp = os.path.getmtime(tracked_path)
        os.utime(tracked_path, (stamp - 100, stamp - 100))
        # The client's list says which types are wheeled (its tags): no descriptor per file.
        # (fix_aim and fix_fitment, which fill these stub files' missing blocks from a descriptor, are left out here: the
        # check is the wheels' alone.)
        saved = ex.wheeled_types, ex.fix_aim, ex.fix_fitment
        ex.wheeled_types, ex.fix_aim, ex.fix_fitment = lambda: set(['france:W_Test']), lambda r: False, lambda r: False
        try:
            e.load_vehicles()
        finally:
            ex.wheeled_types, ex.fix_aim, ex.fix_fitment = saved
        read = ex.read_data_file(tracked_path)
        check(group, "a tracked vehicle's old file: left as it is - no wheelParts, not written back (review of 5f2bee5)",
              'wheelParts' not in read and abs(os.path.getmtime(tracked_path) - (stamp - 100)) < 1,
              (read.get('wheelParts'), os.path.getmtime(tracked_path) - stamp))
        check(group, "wheeled or not from the client's list: no descriptor built for the check", built == [], list(built))
        check(group, "a wheeled vehicle's old file: no hash, so it is exported again",
              e.vehicles['france-W_Test']['descriptorHash'] is None and e.vehicles['usa-T_Tracked']['descriptorHash'] is not None)
        exported = []
        e.export_vehicle = lambda request, replay=False: exported.append((request, replay))
        e.jobs, e.job_index = [], {}
        e.catalogue_dirty = False
        e.replay_vehicle_requests()
        check(group, 'setup exports nothing inline: the wheeled file is a background job at the bulk pace',
              exported == [] and [(j[0], j[2], j[3].get('vehicleType'), j[3].get('replay')) for j in e.jobs if j[2] == 'vehicle'] ==
              [(ex.JOB_BULK, 'vehicle', 'france:W_Test', True)], [(j[0], j[2], j[3]) for j in e.jobs])
        e.jobs = [j for j in e.jobs if j[2] == 'vehicle']   # the prefab check job of the same files is prefabs.py's
        e.last_job = 0
        e.run_job()
        check(group, 'the job: exported again from the file itself as a replay, its source kept; the catalogue once, after it',
              len(exported) == 1 and exported[0][0]['vehicleType'] == 'france:W_Test' and exported[0][0]['source'] == 'catalogue'
              and exported[0][0]['compactDescriptor'] == 'france:W_Test' and exported[0][1] is True and e.catalogue_dirty is True
              and not e.migrating, (exported, e.catalogue_dirty, e.migrating))
        del e.export_vehicle

        # export_vehicle: the XML failed - no wheelParts (the next start looks again); read - the count of wheels with body.
        group = 'export'
        e.armor.xml = broken
        e.extras_cache = {}
        e.ensure_ttx = lambda *a, **k: None
        e.publish_vehicle_parts = lambda *a, **k: None
        e.vehicles = {}
        parts_saved = ex.parts_from_descr
        ex.parts_from_descr = lambda d, source='x': [dict(p) for p in statics]
        try:
            e.export_vehicle({'vehicleType': 'france:W_Test', 'compactDescriptor': 'france:W_Test', 'source': 'hangar'}, replay=True)
            rec = ex.read_data_file(os.path.join(vehicles, 'france-W_Test.js'))
            check(group, 'the XML did not read: the file has no wheelParts and says so', 'wheelParts' not in rec
                  and 'Wheel bodies unavailable' in rec.get('warnings', []) and [p['id'] for p in rec['parts']] == [0, 1, 2, 3],
                  (rec.get('wheelParts'), rec.get('warnings')))
            e.armor.xml = lambda name: ET.fromstring(XML)
            e.extras_cache = {}
            e.vehicles = {}
            e.export_vehicle({'vehicleType': 'france:W_Test', 'compactDescriptor': 'france:W_Test', 'source': 'hangar'}, replay=True)
            rec = ex.read_data_file(os.path.join(vehicles, 'france-W_Test.js'))
            check(group, 'the XML read: wheelParts 4, the wheels with body and their rest place marked as such',
                  rec.get('wheelParts') == 4 and all(p.get('wheel') and p.get('poseFrom') == 'rest' for p in rec['parts'][4:]),
                  (rec.get('wheelParts'), [sorted(p) for p in rec['parts'][4:5]]))
        finally:
            ex.parts_from_descr = parts_saved
    finally:
        ex.vehicle_descr = saved


def recorder_checks(temp):
    group = 'recorder'
    target = os.path.join(temp, 'mod')
    os.makedirs(os.path.join(target, 'local_armor_inspector'))
    source = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(REPO, 'mod')
    for path in glob.glob(os.path.join(source, '*.py')) + glob.glob(os.path.join(source, 'local_armor_inspector', '*.py')):
        shutil.copy(path, os.path.join(target, os.path.relpath(path, source)))
    game = os.path.join(temp, 'game-rec')
    os.makedirs(game)
    os.chdir(game)
    sys.path.insert(0, target)
    rtb.install_stubs()
    stubs()
    logger = logging.getLogger('local.armor_inspector')
    logger.addHandler(rtb.Capture())
    logger.propagate = False
    mod = imp.load_source('mod_local_armor_inspector', os.path.join(target, 'mod_local_armor_inspector.py'))
    mod.init()
    recorder, events = mod._recorder, sys.modules['PlayerEvents'].g_playerEvents
    b = rtb.Battle(7770000000000000009, 61)
    enemy = wheeled('france:W_Test')
    b.arena.vehicles[b.enemy]['vehicleType'] = enemy
    b.entities[b.enemy] = rtb.make_vehicle(b.enemy, enemy)
    names = dict((index, name) for name, index, _ in WHEELS)
    collisions = b.entities[b.enemy].appearance.collisions
    # THE HYPOTHESIS, not a finding of this test: the stub names part -k after the wheel of XML index k-1, the mapping
    # measured on two named contacts of the records (docs/KNOWLEDGE.md 9). The checks below show the recorder follows
    # the collision's own names; that the client really numbers its wheels so is only what those contacts say.
    collisions.getPartName = lambda idx: names.get(-idx - 1, '') if idx < 0 else ''
    collisions.getBoundingBox = lambda idx: (V3(-0.175, -0.59, -0.59), V3(0.175, 0.59, 0.59))
    b.entities[b.enemy].appearance.compoundModel = NS(node=lambda name: rtb.Matrix())
    decoder = sys.modules['VehicleEffects'].DamageFromShotDecoder
    parse = decoder.parseHitPoint
    decoder.parseHitPoint = staticmethod(lambda hit, c: (-3, 5, (0.2, 0.0, 0.0), (-0.2, 0.0, 0.0), 0, 0, 100.0))
    try:
        b.enter(events)
        b.hit(b.enemy, b.me)                  # outgoing: on the wheeled enemy's wheel -3
        b.hit(b.me, b.enemy)                  # incoming: the wheeled enemy is the shooter
        # Another collision component (the names are asked once per component) whose names disagree.
        b.entities[b.enemy].appearance.collisions = NS(getPartTransform=collisions.getPartTransform, maxStaticPartIndex=3,
                                                       getPartName=lambda idx: 'X%d' % -idx, getBoundingBox=collisions.getBoundingBox)
        b.hit(b.enemy, b.me)
        # Review of 5f2bee5: a collision whose wheels are not attached yet at the first hit (no names) is asked again later
        # - not on the very next hit (WHEEL_RETRY), but after it.
        asked = []
        late = {'ready': False}
        def late_name(idx):
            asked.append(idx)
            return (names.get(-idx - 1, '') if late['ready'] else '') if idx < 0 else ''
        b.entities[b.enemy].appearance.collisions = NS(getPartTransform=collisions.getPartTransform, maxStaticPartIndex=3,
                                                       getPartName=late_name, getBoundingBox=collisions.getBoundingBox)
        b.hit(b.enemy, b.me)                  # 4: not attached - no wheels
        late['ready'] = True
        before = asked.count(-1)
        b.hit(b.enemy, b.me)                  # 5: within WHEEL_RETRY - not asked again, still no wheels
        # The list is asked from -1 on; the contact's own name (-3, extra_part_info) is another question.
        again = asked.count(-1) - before
        mod._WHEEL_NAMES[(id(b.entities[b.enemy].appearance.collisions), 'france:W_Test')] = (False, time.time() - 1)
        b.hit(b.enemy, b.me)                  # 6: the retry is due - asked again, the wheels are there
        writer = recorder.writer
        deadline = time.time() + 5
        while not writer.queue.empty() and time.time() < deadline: time.sleep(0.01)
        time.sleep(0.1)
        rows = rtb.read_jsonl(os.path.join(writer.folder, recorder.file + '.jsonl'))[0]
        hits = [r for r in rows if r.get('type') == 'hit']
        check(group, 'six hits written', len(hits) == 6, len(hits))
        if len(hits) == 6:
            first, incoming, other, early, soon, retried = hits
            ids = lambda h: [p['id'] for p in h['target']['parts']]
            check(group, 'wheels not attached at the first hit: none recorded, the contact unsupported',
                  ids(early) == [0, 1, 2, 3] and early['points'][0].get('status') == 'unsupported-part', ids(early))
            check(group, 'the next hit within WHEEL_RETRY: the collision is not asked again (cheap)', again == 0 and ids(soon) == [0, 1, 2, 3],
                  (again, ids(soon)))
            check(group, 'the retry once due: asked again, and the wheels are recorded from then on',
                  ids(retried) == [0, 1, 2, 3, -1, -2, -3, -4] and retried['points'][0].get('status') == 'resolved', ids(retried))
            parts = first['target']['parts']
            check(group, 'the wheeled target (under the -k/index k-1 hypothesis of the stub): parts 0-3 then -1..-4 by name, each with its armour reference',
                  [(p['id'], p['name']) for p in parts][4:] == [(-1, 'WD_L1'), (-2, 'WD_R1'), (-3, 'W_L1'), (-4, 'W_R1')]
                  and all(p.get('armorRef') and p.get('material') == 'wheel' and 'transform' not in p for p in parts[4:]),
                  [(p['id'], p['name'], sorted(p)) for p in parts][4:6])
            point = first['points'][0]
            check(group, 'the contact on -3 is resolved and keeps the collision\'s name for it',
                  point.get('status') == 'resolved' and point.get('part') == -3 and point.get('partName') == 'W_L1', point)
            check(group, 'no extra-parts warning on a wheeled target', 'Additional vehicle parts are not yet rendered'
                  not in (first.get('warnings') or []), first.get('warnings'))
            shooter = incoming['attacker']['parts']
            check(group, 'the wheeled shooter\'s rest parts carry his wheels', [p['id'] for p in shooter] == [0, 1, 2, 3, -1, -2, -3, -4],
                  [p['id'] for p in shooter])
            check(group, 'names that disagree: no wheels, the contact stays unsupported',
                  [p['id'] for p in other['target']['parts']] == [0, 1, 2, 3] and other['points'][0].get('status') == 'unsupported-part',
                  ([p['id'] for p in other['target']['parts']], other['points'][0].get('status')))
    finally:
        decoder.parseHitPoint = parse
        b.leave(events)
        mod.fini()


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-wheels27-')
    home = os.getcwd()
    crashed = None
    try:
        sys.path.insert(0, os.path.join(REPO, 'mod'))
        rtb.install_stubs()
        stubs()
        from local_armor_inspector import exporter as ex, records
        exporter_checks(ex, records, temp)
        for name in [n for n in sys.modules if n == 'local_armor_inspector' or n.startswith('local_armor_inspector.')]:
            del sys.modules[name]
        sys.path.remove(os.path.join(REPO, 'mod'))
        recorder_checks(temp)
    except Exception:
        crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['wheels: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed), time.time() - started)]
    for group, name, ok, detail in failed:
        lines.append('FAIL [%s] %s%s' % (group, name, (' -- %s' % (detail,)) if detail not in ('', None) else ''))
    if crashed: lines.append('FAIL [run] the script crashed:\n' + crashed)
    code = 1 if failed or crashed else 0
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if isinstance(text, unicode) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
