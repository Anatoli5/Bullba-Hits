"""Map scenarios (the game's random events, 21.11.2026): space.bin GOBJ's elements and the CGF prefab tree turned into
the standing and ruin models the map copy hands to the builder (map_raw.space_game_objects, scenario_instances,
euler_matrix). Synthetic inputs; the numbers expected are worked by hand."""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'mod'))
from local_armor_inspector import map_raw  # noqa: E402

IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def gobj_bytes(elements):
    body = b''.join(struct.pack('<16f', *t) + b'\x11' * 16 + struct.pack('<II', mask, h) for t, mask, h in elements)
    return struct.pack('<II', 88, len(elements)) + body + struct.pack('<II', 84, 0)


def test_gobj_element():
    t = list(IDENTITY)
    t[12:15] = [10.0, 2.0, -3.0]
    st = {0x1234: 'content/CGFPrefabs/Map_scenarios/x/x_scenario.prefab'}
    got = map_raw.space_game_objects(gobj_bytes([(t, 0x7ffffff7, 0x1234), (IDENTITY, 1, 0x999)]), st)
    assert got[0] == ('content/CGFPrefabs/Map_scenarios/x/x_scenario.prefab', 0x7ffffff7, t)
    assert got[1][0] is None and got[1][1] == 1


def test_euler_order_y_x_z():
    # yaw 90 alone turns +x into -z (Ry, column vectors); pitch 90 alone turns +y into +z (Rx); roll 90: +x into +y (Rz)
    def apply(m, v):
        return [round(sum(m[r][c] * v[c] for c in range(3)), 6) for r in range(3)]
    assert apply(map_raw.euler_matrix([0, 0, 0], [0, 90, 0], [1, 1, 1]), [1, 0, 0]) == [0, 0, -1]
    assert apply(map_raw.euler_matrix([0, 0, 0], [90, 0, 0], [1, 1, 1]), [0, 1, 0]) == [0, 0, 1]
    assert apply(map_raw.euler_matrix([0, 0, 0], [0, 0, 90], [1, 1, 1]), [1, 0, 0]) == [0, 1, 0]
    # all three: R = Ry Rx Rz, so +x goes through roll first: x -> y (roll) -> z (pitch) -> z stays under yaw 90 -> +x... worked:
    # Rz(90) x = y; Rx(90) y = z; Ry(90) z = x
    assert apply(map_raw.euler_matrix([0, 0, 0], [90, 90, 90], [1, 1, 1]), [1, 0, 0]) == [1, 0, 0]
    m = map_raw.euler_matrix([1, 2, 3], [0, 0, 0], [2, 3, 4])
    assert [m[0][0], m[1][1], m[2][2], m[0][3], m[1][3], m[2][3]] == [2, 3, 4, 1, 2, 3]


def prefab(objects):
    return json.dumps({'__type__': 'cgf::PrefabResource::RawData', 'objects': objects, 'version': 5}).encode('utf-8')


def model(name, x, collider=False, flags=('Static',)):
    comps = {'BW::DynamicModel': {'modelName': 'content/B/%s.model' % name},
             'cgf::TransformComponent': {'position': {'x': x, 'y': 0.0, 'z': 0.0}}}
    if collider:
        comps['BW::Colliders'] = {'colliders': [{'__ctype__': 'BW::MeshColliderDesc', '__cvalue__': {'modelName': 'content/B/%s.model' % name}}]}
    return {'components': comps, 'flags': list(flags), 'name': name}


FILES = {
    'S/s_scenario.prefab': prefab({'name': 's_scenario', 'components': {}, 'children': [
        {'name': 'a_complete.prefab', 'prefab': 'S/a_complete.prefab', 'flags': ['Static'],
         'components': {'cgf::TransformComponent/position/x': 100.0}},
        {'name': 'train_complete.prefab', 'prefab': 'S/train_complete.prefab', 'flags': ['Static'], 'components': {}},
        {'name': 'planes.prefab', 'prefab': 'S/planes.prefab', 'flags': ['SelfInactive'], 'components': {}}]}),
    'S/a_complete.prefab': prefab({'name': 'a_complete', 'components': {'cgf::TransformComponent': {'rotation': {'y': 90.0}}}, 'children': [
        {'name': 'a_normal.prefab', 'prefab': 'S/a_normal.prefab', 'flags': ['Static'], 'components': {}},
        {'name': 'a_transition.prefab', 'prefab': 'S/a_transition.prefab', 'flags': ['SelfInactive'], 'components': {}},
        {'name': 'a_destroyed.prefab', 'prefab': 'S/a_destroyed.prefab', 'flags': ['Static', 'SelfInactive'], 'components': {}}]}),
    'S/a_normal.prefab': prefab({'name': 'a_normal', 'components': {}, 'children': [
        model('house', 5.0, collider=True), model('tent', 1.0), model('hidden', 2.0, flags=('SelfInactive',))]}),
    'S/a_transition.prefab': prefab({'name': 'a_transition', 'components': {}, 'children': [model('falling', 0.0)]}),
    'S/a_destroyed.prefab': prefab({'name': 'a_destroyed', 'components': {}, 'children': [model('pile', 3.0, collider=True)]}),
    'S/train_complete.prefab': prefab({'name': 'train_complete', 'components': {}, 'children': [
        {'name': 'train_normal.prefab', 'prefab': 'S/train_normal.prefab', 'flags': ['Static'], 'components': {}}]}),
    'S/train_normal.prefab': prefab({'name': 'train_normal', 'components': {}, 'children': [model('wagon', 0.0)]}),
    'S/planes.prefab': prefab({'name': 'planes', 'components': {}, 'children': [model('plane', 0.0)]}),
}


def test_scenario_instances():
    counts = {}
    t = list(IDENTITY)
    t[13] = 7.0   # the scenario placed 7 m up by GOBJ
    got = map_raw.scenario_instances(FILES.get, 'S/s_scenario.prefab', 0x7ffffff7, t, counts)
    names = [(it['state'], it['model'].split('/')[-1]) for it in got]
    # the standing house and tent, not the inactive model; the ruin's pile; no transition, no train (no ruin), no plane
    assert names == [('normal', 'house.model'), ('normal', 'tent.model'), ('ruin', 'pile.model')]
    assert counts == {'standing models inactive': 1, 'parts without both states (left out)': 1}
    house = got[0]
    assert house['part'] == 'a_complete' and house['name'] == 'a_normal.prefab' and house['mask'] == 0x7ffffff7
    assert house['collider'] == 'content/B/house.model' and got[1]['collider'] is None
    # translation: the part moved to x 100 and turned by yaw 90 (x -> -z), the house 5 m along its own x, GOBJ 7 m up
    m = house['m']
    assert [round(v, 4) for v in m[12:15]] == [100.0, 7.0, -5.0]
    # BSMI's layout: floats 0-2 = the image of +x (yaw 90: -z)
    assert [round(v, 4) for v in m[0:3]] == [0.0, 0.0, -1.0]
    assert got[2]['name'] == 'a_destroyed.prefab' and [round(v, 4) for v in got[2]['m'][12:15]] == [100.0, 7.0, -3.0]


def test_prefab_not_utf8():
    raw = b'\xef\xbb\xbf' + json.dumps({'objects': {'name': 'x'}}).encode('ascii')[:-1] + b', "n": "\xd1"}'
    assert map_raw.prefab_json(raw)['n'] == u'С'
    assert math.isclose(0.0, 0.0)
