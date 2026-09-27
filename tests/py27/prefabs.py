# -*- coding: utf-8 -*-
"""The armoured prefabs as collision parts (27.09, task prefab-parts), under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/prefabs.py [MOD_DIR]   (default <repo>/mod)

The real mod with the client stubs and fixtures of recorder_two_battles.py (imported, not run) and a made-up prefab in the
shape of the client's it43_CAV_mod_71_crest.prefab: a root with a state switcher, a sequence (an unnamed layer, "0 position
layer" at 0 degrees, "1 position layer" at 3.3), a node follower, an offset and the armoured collider of the 'normal'
state (BW::Colliders, BW::ArmorComponent with a device, the client's DynamicCollisionLinker), and the same collider in
the 'crash' state. Checks, by group:

  spec       prefab_spec: the collider of the normal state, its model, the armour by the client's kind names (a device
             walked through: no thickness), the layers' turns, the default place; a prefab without armour gives None,
             a node turned about y is refused
  slots      slot_prefabs: the gun's slot with its place; a slot without a place is kept without one
  index      the package index finds the prefab in a package (the raw directory path) and read_prefab reads it; one
             a mod replaces is refused
  export     type_extras reads the XML and the prefab once; export_vehicle adds the crest as part 4 on the gun's rest
             pose, at the default layer, with prefabParts 1; a prefab that does not read: no prefabParts, a warning
  publish    prepare_hit fills the recorder's prefab part (model, armour, layers, base) in a battle of the running client;
             during a battle nothing is read and the hit waits for the extras job
  migrate    a file from before the prefabs: the check job exports again only the vehicle whose models lie in the
             folder of an armoured prefab's collider; nothing else is written
  recorder   a contact on the dynamic index above the static parts: the part with its slot, prefab, parent and pose,
             the point resolved; a later hit elsewhere records the part's pose again (remembered index); a vehicle
             without a slot keeps its contact unsupported

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
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(HERE))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True
rtb = imp.load_source('recorder_two_battles27p', os.path.join(HERE, 'recorder_two_battles.py'))
check, checks = rtb.check, rtb.checks
NS, V3 = rtb.NS, rtb.V3

NAMES = {1: 'armor_1', 3: 'armor_3', 22: 'ammoBay', 51: 'armor_21'}
PATH = 'content/CGFPrefabs/Vehicle/dynamic_parts/italy/t_crest.prefab'
MODEL = 'vehicles/italy/T_Crest/collision_client/Gun_02_animated.model'


def material(kind, mm, device=False):
    return {'kind': str(kind), 'armor': str(mm), 'vehicleDamageFactor': '1', 'useHitAngle': '0' if device else '1',
            'mayRicochet': '0' if device else '1', 'collideOnceOnly': '1' if device else '0', 'checkCaliberForRicochet': '1',
            'checkCaliberForHitAngleNorm': '1', 'chanceToHitByProjectile': 0.27 if device else '1',
            'damageKind': 'DEVICE' if device else 'ARMOR'}


def collider(uuid, name):
    return {'uuid': uuid, 'name': name, 'components': {
        'BW::Colliders': {'colliders': [{'__ctype__': 'BW::MeshColliderDesc', '__cvalue__': {'modelName': MODEL}}]},
        'BW::ArmorComponent': {'materials': [material(1, 150), material(51, 60), material(22, 0, True)]},
        'BW::DynamicCollisionLinker': {'disabledDomains': ['Editor', 'Server']},
        'cgf::TransformComponent': {}}}


def layer(name, degrees):
    key = {'time': 0.1, 'type': 'SpecialRotation', 'value': {'__ctype__': 'BW::Vector3', '__cvalue__': {'x': degrees, 'y': 0, 'z': 0}}}
    return {'name': name, 'duration': 0.1, 'tracks': [{'object': 'n', 'parameters': [{'component': 'cgf::TransformComponent',
            'keys': [key], 'property': [{'__ctype__': 'std::string', '__cvalue__': 'rotation'}]}]}]}


def prefab(turn=None, armour=True):
    normal = collider('n', 'normal') if armour else {'uuid': 'n', 'name': 'normal', 'components': {'cgf::TransformComponent': {}}}
    crash = collider('c', 'crash') if armour else {'uuid': 'c', 'name': 'crash', 'components': {'cgf::TransformComponent': {}}}
    # `turn`: a rotation of the offset node, which no sequence track sets.
    offset = {'uuid': 'o', 'name': 'offset', 'components': {'cgf::TransformComponent': dict({'position': {'x': 0, 'y': 0.3, 'z': -0.5}},
              **({'rotation': turn} if turn else {}))}, 'children': [normal]}
    follower = {'uuid': 'f', 'name': 'follower', 'components': {'BW::LocalTransformNodeFollowerComponent': {'nodeName': 'Gun'},
                'cgf::TransformComponent': {}}, 'children': [offset]}
    crashed = {'uuid': 'x', 'name': 'crashed', 'components': {'cgf::TransformComponent': {'position': {'x': 0, 'y': 0.3, 'z': -0.5}}},
               'children': [crash]}
    root = {'uuid': '00000000-0000-0000-0000-000000000000', 'name': 't_crest', 'components': {
        'BW::StateSwitcherComponent': {'normal': 'f', 'critical': 'x', 'damaged': 'x'},
        'BW::SequenceComponent': {'activeLayer': 1, 'layers': [layer(None, 0)] + [layer('%d position layer' % k, 3.3 * k) for k in (0, 1)]},
        'script::CrestMovingSequenceParamsComponent': {}, 'cgf::TransformComponent': {}},
        'children': [follower, crashed]}
    return {'__type__': 'cgf::PrefabResource::RawData', 'objects': root}


XML = ('<root><hull><hitTester><collisionModelClient>vehicles/t/hull.model</collisionModelClient></hitTester></hull>'
       '<turrets0><Turret_T><guns><Gun_T><slotPrefabs><crest_module>' + PATH + '</crest_module></slotPrefabs>'
       '<objectSlots><slot><name>crest_module</name><type>attachment</type><position>0 0 0</position><rotation>0 0 0</rotation>'
       '</slot></objectSlots></Gun_T><Gun_B><slotPrefabs><nowhere>' + PATH + '</nowhere></slotPrefabs></Gun_B></guns>'
       '</Turret_T></turrets0></root>')


def crested(type_name):
    descr = rtb.descriptor(type_name)
    descr.turret.name, descr.gun.name, descr.chassis.name = 'Turret_T', 'Gun_T', 'Chassis_T'
    descr.gun.slotPrefabs = [('crest_module', PATH)]
    descr.hull.slotPrefabs, descr.turret.slotPrefabs, descr.chassis.slotPrefabs = [], [], []
    return descr


def near(a, b, eps=1e-9):
    return len(a) == len(b) and all(abs(x - y) <= eps for x, y in zip(a, b))


def exporter_checks(ex, temp):
    import xml.etree.ElementTree as ET
    group = 'spec'
    spec = ex.prefab_spec(prefab(), NAMES)
    check(group, "the normal state's collider, its model, the crest kind, the default layer",
          spec['resource'] == MODEL and spec['kind'] == 'crest' and spec['layer'] == '0 position layer', spec and spec['resource'])
    armour = spec['armor']
    check(group, "the armour by the client's kind names: 150 and 60 mm armour, vehicleDamageFactor 1; the device walked through",
          sorted(armour) == ['ammoBay', 'armor_1', 'armor_21'] and armour['armor_1']['armor'] == 150.0
          and armour['armor_21']['armor'] == 60.0 and armour['armor_1']['vehicleDamageFactor'] == 1.0
          and armour['armor_1']['useHitAngle'] is True and armour['armor_1']['mayRicochet'] is True
          and armour['ammoBay']['armor'] is None and armour['ammoBay']['collideOnceOnly'] is True, armour)
    check(group, 'the layers turn it about x: 0 and 3.3 degrees; the default place is the offset',
          spec['layers'] == [{'name': '0 position layer', 'angle': 0.0}, {'name': '1 position layer', 'angle': 3.3}]
          and near(spec['transform'][12:15], [0, 0.3, -0.5]), (spec['layers'], spec['transform'][12:15]))
    turned = ex.multiply_columns(ex.translation_columns([0, 0.3, -0.5]), ex.rotation_x_columns(3.3))
    check(group, 'a positive turn about x lowers +z and lifts -z (the client gun pitch sense)',
          turned[6] > 0 and near([ex.turn_x(turned)], [3.3], 1e-9), turned[4:12])
    check(group, 'a prefab without an armoured collider gives None', ex.prefab_spec(prefab(armour=False), NAMES) is None)
    try:
        ex.prefab_spec(prefab(turn={'x': 0, 'y': 90, 'z': 0}), NAMES)
        refused = False
    except ValueError:
        refused = True
    check(group, 'a node turned about y on the way is refused, never guessed', refused)

    group = 'slots'
    tree = ET.fromstring(XML)
    slots = ex.slot_prefabs(tree)
    check(group, "the gun's slot with its place; a slot without a place has none",
          [(s[0], s[1], s[2], s[3]) for s in slots] == [(3, 'Gun_T', 'crest_module', PATH), (3, 'Gun_B', 'nowhere', PATH)]
          and near(slots[0][4], ex.translation_columns([0, 0, 0])) and slots[1][4] is None, slots)

    group = 'index'
    game = os.path.join(temp, 'game')
    os.makedirs(os.path.join(game, 'res', 'packages'))
    with zipfile.ZipFile(os.path.join(game, 'res', 'packages', 'vehicles_level_11.pkg'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(PATH, json.dumps(prefab()))
        z.writestr('vehicles/italy/T_Crest/collision_client/Gun_02_animated.havok', b'havok')
    folder = os.path.join(temp, 'data-folder')
    os.makedirs(folder)
    e = ex.Exporter(game, folder, 'client 1\n')
    e.ensure_packages()
    check(group, 'the package index knows the prefab and the collider', PATH in (e.prefab_entries or {})
          and 'vehicles/italy/T_Crest/collision_client/Gun_02_animated.havok' in e.packages, sorted(e.prefab_entries or {}))
    check(group, 'read_prefab reads its JSON', e.read_prefab(PATH).get('objects', {}).get('name') == 't_crest')
    e.overrides = set([PATH])
    try:
        e.read_prefab(PATH)
        refused = False
    except ValueError:
        refused = True
    check(group, 'a prefab a mod replaces is refused', refused)
    e.overrides = set()

    group = 'export'
    reads = []
    e.armor.xml = lambda name: reads.append(name) or ET.fromstring(XML)
    extras = e.type_extras('italy:T_Crest')
    check(group, 'type_extras: the XML once, the armoured prefab of the gun slot; the slot without a place named as an error',
          [p['slot'] for p in extras['prefabs']] == ['crest_module'] and extras['prefabs'][0]['parent'] == 3
          and len(extras['prefabErrors']) == 1 and 'nowhere' in extras['prefabErrors'][0] and len(reads) == 1,
          (extras['prefabs'], extras['prefabErrors'], reads))
    descr = crested('italy:T_Crest')
    saved = ex.vehicle_descr, ex.parts_from_descr
    ex.vehicle_descr = lambda compact: descr
    try:
        e.ensure_ttx = lambda *a, **k: None
        e.publish_vehicle_parts = lambda *a, **k: None
        vehicles = os.path.join(folder, 'data', 'vehicles')
        # The gun of Gun_B's slot has no place: only the mounted gun's slot counts - still, an error of the XML keeps the
        # count out (conservative). A clean XML first:
        clean = XML.replace('<Gun_B><slotPrefabs><nowhere>' + PATH + '</nowhere></slotPrefabs></Gun_B>', '')
        e.armor.xml = lambda name: ET.fromstring(clean)
        e.extras_cache = {}
        e.export_vehicle({'vehicleType': 'italy:T_Crest', 'compactDescriptor': 'c', 'source': 'hangar'}, replay=True)
        rec = ex.read_data_file(os.path.join(vehicles, 'italy-T_Crest.js'))
        crest = [p for p in rec['parts'] if p.get('prefab')]
        gun = [p for p in rec['parts'] if p['id'] == 3][0]
        want = ex.multiply_columns(gun['transform'], ex.translation_columns([0, 0.3, -0.5]))
        check(group, 'export: the crest is part 4 on the gun, at the default layer, its model and armour, prefabParts 1',
              len(crest) == 1 and crest[0]['id'] == 4 and crest[0]['parentPart'] == 3 and crest[0]['poseFrom'] == 'default'
              and crest[0]['resource'] == MODEL and crest[0]['armor']['armor_1']['armor'] == 150.0
              and crest[0]['prefabDefault'] == '0 position layer' and near(crest[0]['transform'], want) and rec.get('prefabParts') == 1,
              (crest, rec.get('prefabParts'), rec.get('warnings')))
        e.armor.xml = lambda name: ET.fromstring(XML)
        e.extras_cache = {}
        e.vehicles = {}
        e.export_vehicle({'vehicleType': 'italy:T_Crest', 'compactDescriptor': 'c', 'source': 'hangar'}, replay=True)
        rec = ex.read_data_file(os.path.join(vehicles, 'italy-T_Crest.js'))
        check(group, 'a prefab of the XML that could not be placed: no prefabParts (looked at again next start), a warning',
              'prefabParts' not in rec and any('Armoured prefabs unavailable' in w for w in rec.get('warnings', [])),
              (rec.get('prefabParts'), rec.get('warnings')))

        group = 'publish'
        e.armor.xml = lambda name: ET.fromstring(clean)
        e.extras_cache = {}
        e.model_cached = lambda resource, version: ('k', None)
        del e.publish_vehicle_parts
        statics = [{'id': i, 'name': n, 'resource': 'vehicles/t/%s.model' % n, 'armor': {'armor_1': {'armor': 20.0}},
                    'transform': ex.translation_columns([0, 0.5 * i, 0])} for i, n in enumerate(('chassis', 'hull', 'turret', 'gun'))]
        recorded = ex.multiply_columns(ex.multiply_columns(statics[3]['transform'], ex.translation_columns([0, 0.3, -0.5])),
                                       ex.rotation_x_columns(3.3))

        def raw():
            target = {'type': 'italy:T_Crest', 'compactDescriptor': 'c', 'worldTransform': [1] * 16,
                      'parts': [dict(p) for p in statics] + [{'id': 5, 'name': 'crest_module', 'prefab': PATH, 'parentPart': 3,
                                                              'transform': list(recorded)}]}
            return {'type': 'hit', 'id': 'h', 'target': target, 'attacker': {'type': 'usa:T', 'parts': []}, 'warnings': [],
                    'points': [{'status': 'resolved', 'part': 5, 'position': [0, 0.1, -0.3]}]}
        battle = {'id': 'b1', 'clientVersion': 'client 1\n', 'hits': []}
        hit = e.prepare_hit(raw(), 0, battle)
        part = [p for p in hit['target']['parts'] if p['id'] == 5][0]
        base = ex.multiply_columns(ex.translation_columns([0, 0, 0]), ex.translation_columns([0, 0.3, -0.5]))
        check(group, "the recorder's prefab part gets its model, armour, layers and base; its pose stays the recorded one",
              part.get('resource') == MODEL and part.get('modelKey') == 'k' and part['armor']['armor_21']['armor'] == 60.0
              and part.get('prefabKind') == 'crest' and near(part.get('prefabBase') or [], base)
              and len(part.get('prefabLayers') or []) == 2 and near(part['transform'], recorded) and 'poseFrom' not in part,
              sorted(part))
        e.recorder = NS(in_battle=True, busy_until=0)
        e.extras_cache = {}
        e.jobs, e.job_index, e.waiting = [], {}, {}
        waiting = e.prepare_hit(raw(), 0, battle)
        part = [p for p in waiting['target']['parts'] if p['id'] == 5][0]
        check(group, 'in a battle: nothing read, the part as recorded, the extras job queued and the battle waiting',
              'resource' not in part and [j[2] for j in e.jobs] == ['extras'] and e.waiting.get(ex.EXTRAS_KEY + 'italy:T_Crest') == set(['b1']),
              (sorted(part), [j[2] for j in e.jobs], e.waiting))
        e.recorder = None

        group = 'migrate'
        for ident, type_name, resource in (('italy-T_Crest', 'italy:T_Crest', 'vehicles/italy/T_Crest/collision_client/Hull.model'),
                                           ('usa-T_Other', 'usa:T_Other', 'vehicles/american/T_Other/collision_client/Hull.model')):
            ex.write_data(os.path.join(vehicles, ident + '.js'), 'vehicle:' + ident,
                          {'schema': 1, 'id': ident, 'type': type_name, 'compactDescriptor': type_name, 'source': 'catalogue',
                           'clientVersion': e.version, 'name': ident, 'level': 8, 'staticParts': 4, 'wheelParts': 0,
                           'parts': [{'id': 1, 'name': 'hull', 'resource': resource}]})
        other = os.path.join(vehicles, 'usa-T_Other.js')
        stamp = os.path.getmtime(other) - 100
        os.utime(other, (stamp, stamp))
        kept = ex.wheeled_types, ex.fix_aim, ex.fix_fitment
        ex.wheeled_types, ex.fix_aim, ex.fix_fitment = lambda: set(), lambda r: False, lambda r: False
        try:
            e.load_vehicles()
        finally:
            ex.wheeled_types, ex.fix_aim, ex.fix_fitment = kept
        check(group, 'both files from before the prefabs are noted, neither rewritten',
              sorted(e.prefab_unchecked) == ['italy:T_Crest', 'usa:T_Other'] and abs(os.path.getmtime(other) - stamp) < 1,
              sorted(e.prefab_unchecked))
        e.jobs, e.job_index = [], {}
        e.replay_vehicle_requests()
        check(group, 'setup queues one check job, nothing else', [(j[2], j[0]) for j in e.jobs] == [('prefabs', ex.JOB_BULK)],
              [(j[2], j[3]) for j in e.jobs])
        e.prefab_entries = {PATH: e.prefab_entries[PATH]}
        e.last_job = 0
        e.run_job()
        queued = [(j[2], j[3].get('vehicleType'), j[3].get('replay')) for j in e.jobs]
        check(group, "the check: only the vehicle whose models lie in the armoured prefab's collider folder is exported again",
              queued == [('vehicle', 'italy:T_Crest', True)] and e.vehicles['italy-T_Crest']['descriptorHash'] is None
              and e.vehicles['usa-T_Other']['descriptorHash'] is not None and abs(os.path.getmtime(other) - stamp) < 1, queued)
    finally:
        ex.vehicle_descr, ex.parts_from_descr = saved


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
    rtb.module('material_kinds', NAMES_BY_IDS=NAMES, IDS_BY_NAMES=dict((v, k) for k, v in NAMES.items()))
    logger = logging.getLogger('local.armor_inspector')
    logger.addHandler(rtb.Capture())
    logger.propagate = False
    mod = imp.load_source('mod_local_armor_inspector', os.path.join(target, 'mod_local_armor_inspector.py'))
    mod.init()
    recorder, events = mod._recorder, sys.modules['PlayerEvents'].g_playerEvents
    b = rtb.Battle(7770000000000000010, 71)
    enemy = crested('italy:T_Crest')
    b.arena.vehicles[b.enemy]['vehicleType'] = enemy
    b.entities[b.enemy] = rtb.make_vehicle(b.enemy, enemy)
    collisions = b.entities[b.enemy].appearance.collisions
    asked = []
    collisions.getParentPartIndex = lambda idx: asked.append(idx) or (3 if idx == 5 else None)
    collisions.getBoundingBox = lambda idx: (V3(-0.4, -0.3, -1.3), V3(0.4, 0.2, 0))
    decoder = sys.modules['VehicleEffects'].DamageFromShotDecoder
    parse = decoder.parseHitPoint
    part_index = {'value': 5}
    decoder.parseHitPoint = staticmethod(lambda hit, c: (part_index['value'], 4, (0.2, 0.0, 0.0), (-0.2, 0.0, 0.0), 0, 2, 105.0))
    try:
        b.enter(events)
        b.hit(b.enemy, b.me)                  # 1: on the crest, index 5
        part_index['value'] = 1
        b.hit(b.enemy, b.me)                  # 2: on the hull - the crest's pose recorded again
        # A vehicle with no slot: a contact above the static parts stays unsupported.
        plain = rtb.descriptor('usa:T_Plain')
        plain.gun.slotPrefabs, plain.hull.slotPrefabs, plain.turret.slotPrefabs, plain.chassis.slotPrefabs = [], [], [], []
        b.entities[b.ally] = rtb.make_vehicle(b.ally, plain)
        b.entities[b.ally].appearance.collisions.getParentPartIndex = lambda idx: 1
        part_index['value'] = 6
        b.hit(b.ally, b.enemy)                # 3
        writer = recorder.writer
        deadline = time.time() + 5
        while not writer.queue.empty() and time.time() < deadline: time.sleep(0.01)
        time.sleep(0.1)
        rows = rtb.read_jsonl(os.path.join(writer.folder, recorder.file + '.jsonl'))[0]
        hits = [r for r in rows if r.get('type') == 'hit']
        check(group, 'three hits written', len(hits) == 3, len(hits))
        if len(hits) == 3:
            first, second, third = hits
            part = [p for p in first['target']['parts'] if p['id'] == 5]
            check(group, 'a contact on index 5: the crest part with its slot, prefab, parent and pose at the hit',
                  len(part) == 1 and part[0].get('name') == 'crest_module' and part[0].get('prefab') == PATH
                  and part[0].get('parentPart') == 3 and len(part[0].get('transform') or []) == 16 and 'armor' not in part[0],
                  part)
            point = first['points'][0]
            check(group, 'the contact is resolved and keeps what the collision says of it (parent, pose, box)',
                  point.get('status') == 'resolved' and point.get('part') == 5 and point.get('parentPart') == 3
                  and len(point.get('partTransform') or []) == 16 and point.get('partBounds'), point)
            again = [p for p in second['target']['parts'] if p['id'] == 5]
            check(group, 'a later hit on the hull: the remembered index gives the crest its pose at that hit',
                  len(again) == 1 and len(again[0].get('transform') or []) == 16 and second['points'][0].get('status') == 'resolved',
                  [p['id'] for p in second['target']['parts']])
            check(group, 'a vehicle without a slot: the contact above the static parts stays unsupported, no part added',
                  [p['id'] for p in third['target']['parts']] == [0, 1, 2, 3] and third['points'][0].get('status') == 'unsupported-part',
                  ([p['id'] for p in third['target']['parts']], third['points'][0].get('status')))
    finally:
        decoder.parseHitPoint = parse
        b.leave(events)
        mod.fini()


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-prefabs27-')
    home = os.getcwd()
    crashed = None
    try:
        sys.path.insert(0, os.path.join(REPO, 'mod'))
        rtb.install_stubs()
        rtb.module('material_kinds', NAMES_BY_IDS=NAMES, IDS_BY_NAMES=dict((v, k) for k, v in NAMES.items()))
        from local_armor_inspector import exporter as ex
        exporter_checks(ex, temp)
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
    lines = ['prefabs: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed), time.time() - started)]
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
