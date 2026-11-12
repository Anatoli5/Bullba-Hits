"""Focused contract tests for lossless armour-table record packing."""
from __future__ import absolute_import

import copy
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector.records import (ArmorTable, PitchTable, RecordDecoder, RecordEncoder,
                                          config_key, pack_battle, snapshot_refs, stamp_snapshot,
                                          unpack_battle, SNAPSHOT_KEY, STATIC_FIELD, STATIC_RECORD,
                                          VehicleStatic, split_hit, split_vehicle)
from local_armor_inspector import armor as armor_module


ARMOR = {
    'armor': {'armor': 120.0, 'mayRicochet': True, 'useHitAngle': True},
    'track': {'armor': 40.0, 'mayRicochet': False, 'useHitAngle': False},
}


def hit(identifier='1', armor=ARMOR):
    """A record with different per-event values on both vehicle sides."""
    return {
        'schema': 1, 'type': 'hit', 'id': identifier, 'receivedAt': 13.5,
        'damage': 490, 'points': [{'position': [1.0, 2.0, 3.0], 'status': 'resolved'}],
        'shellCandidates': [{'kind': 'ARMOR_PIERCING', 'penetration100': 250}],
        'attacker': {'name': 'Attacker', 'parts': [
            {'id': 0, 'name': 'gun', 'resource': 'gun.model',
             'transform': [1, 0, 0, 1], 'armor': armor},
        ]},
        'target': {'name': 'Target', 'parts': [
            {'id': 1, 'name': 'hull', 'resource': 'hull.model',
             'transform': [1, 0, 0, 9], 'armor': armor},
        ]},
    }


class RecordTableTests(unittest.TestCase):
    def test_encode_decode_preserves_static_and_dynamic_fields_on_both_sides(self):
        source = hit()
        encoder = RecordEncoder()
        packed = encoder.encode(source)
        self.assertEqual(source, hit(), 'encoding must not change the caller record')
        self.assertEqual(packed['damage'], 490)
        self.assertEqual(packed['points'], source['points'])
        self.assertEqual(packed['attacker']['parts'][0]['transform'], [1, 0, 0, 1])
        self.assertEqual(packed['target']['parts'][0]['transform'], [1, 0, 0, 9])
        self.assertNotIn('armor', packed['attacker']['parts'][0])
        self.assertNotIn('armor', packed['target']['parts'][0])
        self.assertEqual(len(packed['armorTables']), 1)

        decoded = RecordDecoder().decode(packed)
        self.assertEqual(decoded['points'], source['points'])
        self.assertEqual(decoded['shellCandidates'], source['shellCandidates'])
        for side in ('attacker', 'target'):
            part = decoded[side]['parts'][0]
            self.assertEqual(part['armor'], ARMOR)
            self.assertEqual(part['transform'], source[side]['parts'][0]['transform'])

    def test_commit_omits_known_definition_and_rollback_reemits_it(self):
        encoder = RecordEncoder()
        first = encoder.encode(hit('1'))
        self.assertIn('armorTables', first)
        encoder.commit()
        later = encoder.encode(hit('2'))
        self.assertNotIn('armorTables', later)

        retry = RecordEncoder()
        retry.encode(hit('1'))
        retry.rollback()
        after_failed_write = retry.encode(hit('1'))
        self.assertIn('armorTables', after_failed_write)

    def test_changed_same_vehicle_table_has_new_reference(self):
        encoder = RecordEncoder()
        old = encoder.encode(hit('1'))
        old_ref = old['target']['parts'][0]['armorRef']
        encoder.commit()
        changed = copy.deepcopy(ARMOR)
        changed['armor']['armor'] = 121.0
        newer = encoder.encode(hit('2', changed))
        new_ref = newer['target']['parts'][0]['armorRef']
        self.assertNotEqual(new_ref, old_ref)
        self.assertEqual(set(newer['armorTables']), {new_ref})

    def test_old_inline_record_decodes_and_interns_shared_read_only_snapshot(self):
        source = hit()
        decoded = RecordDecoder().decode(source)
        a = decoded['attacker']['parts'][0]['armor']
        t = decoded['target']['parts'][0]['armor']
        self.assertIsInstance(a, ArmorTable)
        self.assertIs(a, t)
        self.assertEqual(a, ARMOR)
        self.assertIs(copy.deepcopy(a), a)

    def test_missing_or_invalid_reference_warns_but_keeps_event_with_empty_armor_marker(self):
        missing = hit()
        missing['target']['parts'][0].pop('armor')
        missing['target']['parts'][0]['armorRef'] = '0' * 64
        decoded = RecordDecoder().decode(missing)
        part = decoded['target']['parts'][0]
        self.assertEqual(decoded['id'], missing['id'])
        self.assertEqual(part['armor'], {})
        self.assertEqual(part['armorError'], 'Recorded armor table unavailable')
        self.assertTrue(decoded['warnings'])

        invalid = hit()
        invalid['target']['parts'][0].pop('armor')
        invalid['target']['parts'][0]['armorRef'] = 4
        decoded = RecordDecoder().decode(invalid)
        self.assertEqual(decoded['id'], invalid['id'])
        self.assertEqual(decoded['target']['parts'][0]['armor'], {})
        self.assertTrue(decoded['warnings'])

    def test_self_contained_battle_round_trip_keeps_multiple_sides_and_shared_snapshot(self):
        second = hit('2')
        second['target']['parts'][0]['transform'] = [1, 0, 0, 19]
        battle = {'schema': 1, 'type': 'battle', 'id': '12-test', 'hits': [hit('1'), second],
                  'shotEvents': [{'type': 'shot', 'id': 's1'}]}
        packed = pack_battle(battle)
        self.assertEqual(len(packed['armorTables']), 1)
        self.assertNotIn('armorTables', packed['hits'][0])
        unpacked = unpack_battle(packed)
        self.assertEqual(unpacked['shotEvents'], battle['shotEvents'])
        self.assertEqual(unpacked['hits'][1]['target']['parts'][0]['transform'], [1, 0, 0, 19])
        snapshots = [unpacked['hits'][i][side]['parts'][0]['armor']
                     for i in range(2) for side in ('attacker', 'target')]
        self.assertTrue(all(table is snapshots[0] for table in snapshots))
        self.assertEqual(snapshots[0], ARMOR)

    def test_live_material_cache_detects_in_place_material_and_homogenization_changes(self):
        material = types.SimpleNamespace(
            useHitAngle=True, mayRicochet=True, collideOnceOnly=False,
            checkCaliberForRicochet=False, checkCaliberForHitAngleNorm=False,
            useArmorHomogenization=True, armor=120.0, vehicleDamageFactor=1.0,
            chanceToHitByProjectile=None)
        component = types.SimpleNamespace(materials={}, armorHomogenization=1.0)
        vehicles = types.SimpleNamespace(g_cache=types.SimpleNamespace(
            commonConfig={'materials': {7: material}}))
        fake_items = types.ModuleType('items')
        fake_items.vehicles = vehicles
        fake_kinds = types.ModuleType('material_kinds')
        fake_kinds.NAMES_BY_IDS = {7: 'armor'}
        with patch.dict(sys.modules, {'items': fake_items, 'material_kinds': fake_kinds}):
            first = armor_module.live_materials(component)
            self.assertIs(first, armor_module.live_materials(component))
            self.assertEqual(first['armor']['armor'], 120.0)

            material.armor = 160.0
            second = armor_module.live_materials(component)
            self.assertIsNot(second, first)
            self.assertEqual(second['armor']['armor'], 160.0)
            self.assertEqual(first['armor']['armor'], 120.0)

            component.armorHomogenization = 1.25
            third = armor_module.live_materials(component)
            self.assertIsNot(third, second)
            self.assertEqual(third['armor']['armor'], 200.0)
            self.assertEqual(second['armor']['armor'], 160.0)



PITCH = {'samples': [[-1.0, -0.1, 0.2], [0.0, -0.2, 0.3]], 'hullTurretPitch': 0.05,
         'gunJointPitch': 0.01, 'source': 'client calcPitchLimitsFromDesc'}
DESCRIPTOR = 'EX8kATkB0AAZAf0ASQEA'


def battle_hit(identifier='1', pose=None, table=None, mode=None):
    """A hit shaped as the recorder writes it: a static shooter at rest, a target in a live pose."""
    record = hit(identifier)
    record['availableShells'] = [{'kind': 'ARMOR_PIERCING', 'alpha': 400}]
    record['attacker'].update({'compactDescriptor': DESCRIPTOR, 'partsFrom': 'rest pose',
                               'aim': {'dispersion': 0.1}})
    if mode is not None:
        record['attacker']['vehicleMode'] = mode
    record['target'].update({'compactDescriptor': DESCRIPTOR, 'worldTransform': [1, 2, 3],
                             'gunPitchLimits': PitchTable(table or PITCH)})
    record['target']['parts'][0]['transform'] = pose or [1, 0, 0, 9]
    return record


class PitchTableRecordTests(unittest.TestCase):
    """The gun pitch table by reference in the raw JSONL (plan B1): one table per configuration."""

    def test_pitch_table_leaves_the_line_once_and_never_raises_the_armor_marker(self):
        encoder = RecordEncoder()
        first = encoder.encode(battle_hit('1'))
        self.assertNotIn('gunPitchLimits', first['target'])
        reference = first['target']['gunPitchRef']
        self.assertTrue(reference.startswith(DESCRIPTOR + ':'), reference)
        self.assertEqual(first['pitchTableFormat'], 1)
        self.assertEqual(set(first['pitchTables']), {reference})
        self.assertEqual(first['armorTableFormat'], 1, 'the armour marker keeps its own meaning')
        encoder.commit()
        later = encoder.encode(battle_hit('2'))
        self.assertEqual(later['target']['gunPitchRef'], reference)
        self.assertNotIn('pitchTables', later, 'a known table is defined once per file')

    def test_a_failed_write_re_emits_the_definition(self):
        encoder = RecordEncoder()
        encoder.encode(battle_hit('1'))
        encoder.rollback()
        again = encoder.encode(battle_hit('1'))
        self.assertIn('pitchTables', again)

    def test_decode_restores_one_shared_table_and_deepcopy_keeps_it(self):
        encoder = RecordEncoder()
        decoder = RecordDecoder()
        first = decoder.decode(encoder.encode(battle_hit('1')))
        encoder.commit()
        second = decoder.decode(encoder.encode(battle_hit('2')))
        self.assertEqual(first['target']['gunPitchLimits'], PITCH)
        self.assertIs(first['target']['gunPitchLimits'], second['target']['gunPitchLimits'])
        self.assertIs(copy.deepcopy(first['target']['gunPitchLimits']),
                      first['target']['gunPitchLimits'])

    def test_missing_pitch_definition_keeps_the_hit_warns_and_invents_nothing(self):
        broken = battle_hit('1')
        broken['target'].pop('gunPitchLimits')
        broken['target']['gunPitchRef'] = DESCRIPTOR + ':' + '0' * 32
        decoded = RecordDecoder().decode(broken)
        self.assertEqual(decoded['id'], '1')
        self.assertNotIn('gunPitchLimits', decoded['target'])
        self.assertNotIn('gunPitchRef', decoded['target'])
        self.assertIn('Recorded pitch table unavailable: target', decoded['warnings'])

    def test_old_inline_tables_are_interned_into_one_object_without_hashing(self):
        decoder = RecordDecoder()
        first, second = battle_hit('1'), battle_hit('2')
        first['target']['gunPitchLimits'] = dict(PITCH)
        second['target']['gunPitchLimits'] = dict(PITCH)
        a = decoder.decode(first)['target']['gunPitchLimits']
        b = decoder.decode(second)['target']['gunPitchLimits']
        self.assertIsInstance(a, PitchTable)
        self.assertIs(a, b)
        self.assertNotIn('_fingerprint', a.__dict__, 'interning must not hash 22 KB per hit')

    def test_an_unknown_pitch_format_is_refused_like_the_armour_one(self):
        with self.assertRaises(ValueError):
            RecordDecoder().decode({'type': 'hit', 'pitchTableFormat': 7})


class SnapshotStaticTableTests(unittest.TestCase):
    """The published snapshot: passport and aim block, static part data, rest pose, shell lists."""

    def battle(self, hits):
        return {'schema': 1, 'type': 'battle', 'id': '12-test', 'source': 'live', 'hits': hits,
                'shotEvents': [{'type': 'shot', 'id': 's1'}]}

    def test_round_trip_restores_every_field_of_every_hit(self):
        source = self.battle([battle_hit('1'), battle_hit('2', pose=[1, 0, 0, 19])])
        packed = pack_battle(copy.deepcopy(source))
        self.assertEqual(packed['staticTableFormat'], 1)
        self.assertEqual(packed['pitchTableFormat'], 1)
        self.assertEqual(packed['armorTableFormat'], 1)
        self.assertEqual(packed['source'], 'live', 'the header field is carried, never read')
        for record in packed['hits']:
            for side in ('attacker', 'target'):
                self.assertIn('vehicleRef', record[side])
                self.assertNotIn('aim', record[side])
                self.assertNotIn('parts', record[side])
            self.assertNotIn('availableShells', record)
        unpacked = unpack_battle(packed)
        self.assertEqual(unpacked['shotEvents'], source['shotEvents'])
        for index in range(2):
            for key in ('availableShells', 'shellCandidates', 'damage', 'points'):
                self.assertEqual(unpacked['hits'][index][key], source['hits'][index][key])
            for side in ('attacker', 'target'):
                want, got = source['hits'][index][side], unpacked['hits'][index][side]
                self.assertEqual(set(want), set(got))
                for key in want:
                    if key != 'parts':
                        self.assertEqual(got[key], want[key], key)
                self.assertEqual([p['transform'] for p in got['parts']],
                                 [p['transform'] for p in want['parts']])
                self.assertEqual(got['parts'][0]['armor'], ARMOR)

    def test_a_repeated_block_is_defined_once_and_the_live_pose_stays_on_the_hit(self):
        packed = pack_battle(self.battle([battle_hit(str(n), pose=[1, 0, 0, n]) for n in range(5)]))
        # Two vehicle blocks, their two part lists, the shooter's rest pose and two shell lists -
        # seven definitions for five hits, instead of the same blocks copied five times over.
        self.assertEqual(len(packed['staticTables']), 7, sorted(packed['staticTables']))
        self.assertEqual(len(packed['pitchTables']), 1)
        for index, record in enumerate(packed['hits']):
            self.assertNotIn('partPoses', record['attacker'], 'a rest pose is shared by reference')
            self.assertEqual(record['target']['partPoses'], [[1, 0, 0, index]])

    def test_the_reference_names_the_configuration_and_the_mode(self):
        self.assertEqual(config_key({'compactDescriptor': DESCRIPTOR}), DESCRIPTOR)
        self.assertEqual(config_key({'compactDescriptor': DESCRIPTOR, 'vehicleMode': 0}),
                         DESCRIPTOR + '#0')
        self.assertEqual(config_key({'name': 'no descriptor'}), '')
        default = pack_battle(self.battle([battle_hit('1', mode=0)]))
        siege = pack_battle(self.battle([battle_hit('2', mode=1)]))
        a = default['hits'][0]['attacker']['vehicleRef']
        b = siege['hits'][0]['attacker']['vehicleRef']
        self.assertTrue(a.startswith(DESCRIPTOR + '#0:') and b.startswith(DESCRIPTOR + '#1:'))
        self.assertNotEqual(a, b)

    def test_two_different_blocks_of_one_configuration_get_two_references(self):
        """The confirmed gun_limits defect and the two recorded aim exceptions stay correct."""
        other = battle_hit('2', table=dict(PITCH, gunJointPitch=0.99))
        packed = pack_battle(self.battle([battle_hit('1'), other]))
        self.assertNotEqual(packed['hits'][0]['target']['vehicleRef'],
                            packed['hits'][1]['target']['vehicleRef'])
        self.assertEqual(len(packed['pitchTables']), 2)
        restored = unpack_battle(packed)['hits'][1]['target']['gunPitchLimits']
        self.assertEqual(restored['gunJointPitch'], 0.99)

    def test_a_dangling_reference_leaves_the_field_empty_warns_and_invents_nothing(self):
        packed = pack_battle(self.battle([battle_hit('1')]))
        packed['staticTables'].pop(packed['hits'][0]['target']['vehicleRef'])
        packed['pitchTables'] = {}
        unpacked = unpack_battle(packed)
        target = unpacked['hits'][0]['target']
        self.assertEqual(unpacked['hits'][0]['id'], '1', 'the hit itself survives')
        self.assertEqual(target['worldTransform'], [1, 2, 3], 'its live fields are its own')
        self.assertNotIn('name', target)
        self.assertNotIn('gunPitchLimits', target)
        self.assertIn('Recorded vehicle data unavailable: target', unpacked['hits'][0]['warnings'])

    def test_an_unknown_static_format_is_refused(self):
        with self.assertRaises(ValueError):
            unpack_battle({'staticTableFormat': 7, 'hits': []})

    def test_the_fingerprints_are_taken_once_and_never_reach_the_published_file(self):
        record = battle_hit('1')
        stamp_snapshot(record)
        self.assertIn(SNAPSHOT_KEY, record)
        packed = pack_battle({'hits': [record]})
        self.assertNotIn(SNAPSHOT_KEY, packed['hits'][0])
        stamped = record[SNAPSHOT_KEY]['sides']['attacker']['vehicleRef']
        self.assertEqual(packed['hits'][0]['attacker']['vehicleRef'], stamped)
        self.assertEqual(snapshot_refs(record)['sides']['attacker']['vehicleRef'], stamped)


def prefab_hit(identifier='1', pose=None):
    """battle_hit with the target's armoured prefab (a part of this shot only) after its static part and a wheel."""
    record = battle_hit(identifier, pose=pose)
    record['target']['parts'].append({'id': -1, 'name': 'W_L1', 'material': 'wheel', 'armor': ARMOR})
    record['target']['parts'].append({'id': 5, 'name': 'crest', 'prefab': 'crest.prefab', 'parentPart': 3,
                                      'transform': [0, 0, 0, 5]})
    record['target']['designatorMark'] = {'creatorID': 7}
    record['attacker']['vehicleMode'] = 1
    return record


def write(encoder, record):
    """What Writer.run appends for one record: the `static` definitions first, then the record; committed."""
    rows = []
    encoded = encoder.encode(record)
    if encoder.definitions is not None:
        rows.append(json.loads(json.dumps(encoder.definitions)))
    rows.append(json.loads(json.dumps(encoded)))
    encoder.commit()
    return rows


def read(rows):
    decoder = RecordDecoder()
    return [row for row in (decoder.decode(r) for r in rows) if row.get('type') != STATIC_RECORD]


def plain(value):
    return json.loads(json.dumps(value, sort_keys=True))


class RawStaticRecordTests(unittest.TestCase):
    """BACKLOG 27 (12.11): the raw record writes a vehicle's static half once, in a record of its own kind."""

    def test_split_and_read_back_is_the_hit_itself(self):
        for record in (battle_hit('1'), prefab_hit('2')):
            halves = split_vehicle(record['target'])
            self.assertIsNotNone(halves)
            live, static = halves
            self.assertIsInstance(static, VehicleStatic)
            self.assertNotIn('worldTransform', static)
            self.assertNotIn('transform', static['parts'][0], 'the pose at the shot is live')
            self.assertEqual(live['partPoses'][0], record['target']['parts'][0]['transform'])
            rows = write(RecordEncoder(), split_hit(record))
            self.assertEqual(plain(read(rows)), plain([RecordDecoder().decode(record)]))

    def test_definitions_once_per_file_in_their_own_record_before_the_hit(self):
        encoder = RecordEncoder()
        first = split_hit(prefab_hit('1'))
        rows = write(encoder, first)
        self.assertEqual([r['type'] for r in rows], [STATIC_RECORD, 'hit'])
        static, line = rows
        self.assertEqual((static['staticTableFormat'], static['armorTableFormat'], static['pitchTableFormat']), (1, 1, 1))
        self.assertEqual(line['staticTableFormat'], 1)
        for name in ('armorTables', 'pitchTables', 'availableShells', 'shellCandidates'):
            self.assertNotIn(name, line)
        self.assertEqual(sorted(line['target']), ['designatorMark', 'partPoses', 'parts', 'vehicleRef', 'worldTransform'])
        self.assertEqual([p['id'] for p in line['target']['parts']], [5], 'only the part of this shot stays on the hit')
        self.assertEqual(line['attacker'], {'vehicleMode': 1, 'vehicleRef': line['attacker']['vehicleRef']})
        self.assertTrue(line['attacker']['vehicleRef'].startswith(DESCRIPTOR + '#1:'), 'configuration and mode name it')
        # The same halves again (the recorder hands the very objects): nothing more to define.
        again = split_hit(prefab_hit('2', pose=[1, 0, 0, 19]))
        again['attacker'][STATIC_FIELD] = first['attacker'][STATIC_FIELD]
        again['target'][STATIC_FIELD] = first['target'][STATIC_FIELD]
        later = write(encoder, again)
        self.assertEqual([r['type'] for r in later], ['hit'])
        self.assertEqual(later[0]['target']['vehicleRef'], line['target']['vehicleRef'])
        # Equal content in another object (a half read again): its references are the same, still nothing defined.
        self.assertEqual([r['type'] for r in write(encoder, split_hit(prefab_hit('3')))], ['hit'])
        decoded = read(rows + later)
        self.assertEqual(plain(decoded), plain([RecordDecoder().decode(prefab_hit('1')),
                                                RecordDecoder().decode(prefab_hit('2', pose=[1, 0, 0, 19]))]))

    def test_another_vehicle_writes_a_new_half_and_a_failed_write_writes_it_again(self):
        encoder = RecordEncoder()
        write(encoder, split_hit(battle_hit('1')))
        other = battle_hit('2')
        other['target']['name'] = 'Switched'
        encoded = encoder.encode(split_hit(other))
        self.assertIsNotNone(encoder.definitions, 'a changed vehicle is a new half')
        self.assertEqual(set(encoder.definitions), {'schema', 'type', 'staticTableFormat', 'staticTables'},
                         'its armour and pitch tables are known already')
        encoder.rollback()
        self.assertIsNotNone(write(encoder, split_hit(other))[0].get('staticTables'), 'a lost line is defined again')
        self.assertTrue(encoded['target']['vehicleRef'])

    def test_a_dangling_raw_reference_keeps_the_hit_warns_and_invents_nothing(self):
        rows = write(RecordEncoder(), split_hit(battle_hit('1')))
        decoded = read(rows[1:])[0]
        self.assertEqual(decoded['id'], '1')
        self.assertNotIn('name', decoded['target'])
        self.assertNotIn('availableShells', decoded)
        self.assertIn('Recorded vehicle data unavailable: target', decoded['warnings'])
        self.assertIn('Recorded shell list unavailable: availableShells', decoded['warnings'])

    def test_an_unsplittable_block_stays_inline(self):
        record = prefab_hit('1')
        record['target']['parts'].append({'id': 2, 'name': 'turret', 'transform': [0, 0, 0, 1]})
        self.assertIsNone(split_vehicle(record['target']), 'a static part after the prefab would not come back in order')
        packed = split_hit(record)
        self.assertNotIn(STATIC_FIELD, packed['target'])
        self.assertEqual(plain(read(write(RecordEncoder(), packed))), plain([RecordDecoder().decode(record)]))

    def test_an_unknown_static_format_in_a_raw_record_is_refused(self):
        with self.assertRaises(ValueError):
            RecordDecoder().decode({'schema': 1, 'type': STATIC_RECORD, 'staticTableFormat': 2})

    def test_the_exporter_reads_both_forms_and_ignores_the_definition_record(self):
        from local_armor_inspector.exporter import read_battle, Exporter
        header = {'schema': 1, 'type': 'battle', 'id': 'x', 'clientVersion': 'v', 'map': 'm'}
        encoder = RecordEncoder()
        rows = [header] + write(encoder, split_hit(prefab_hit('1'))) + write(encoder, prefab_hit('2'))
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, '1-test.jsonl')
            with open(path, 'w') as stream:
                for row in rows: stream.write(json.dumps(row) + '\n')
            battle = read_battle(path)
        self.assertEqual(battle['warnings'], [])
        self.assertEqual(plain(battle['hits']), plain([RecordDecoder().decode(prefab_hit('1')),
                                                       RecordDecoder().decode(prefab_hit('2'))]))
        exporter = Exporter.__new__(Exporter)
        exporter.current = None
        self.assertIsNone(exporter.apply_record('1-test', {'schema': 1, 'type': STATIC_RECORD}), 'nothing to publish')


RAW = os.path.join('C:/', 'Games', 'World_of_Tanks_NA', 'mods', 'configs', 'local.armor_inspector', 'battles')
LOCAL = ('2311244215850685716-90c9fc0d82f8', '2310458541778197335-90c9fc0d82f8', '3637817619308026-90c9fc0d82f8',
         '6520676977801102-90c9fc0d82f8', '2311242673957423690-90c9fc0d82f8')


def convert(path):
    """A raw battle of an earlier build turned into the reference form by the writer's own code: every record decoded,
    split (records.split_hit) and encoded (RecordEncoder) - what the recorder writes for the same hits."""
    decoder, encoder, rows = RecordDecoder(), RecordEncoder(), []
    with open(path, 'rb') as stream:
        for line in stream:
            if line.endswith(b'\n'):
                rows.extend(write(encoder, split_hit(decoder.decode(json.loads(line.decode('utf-8'))))))
    return rows


@unittest.skipUnless(all(os.path.isfile(os.path.join(RAW, n + '.jsonl')) for n in LOCAL),
                     'the battles of 11.11 recorded by 1.06 are not in the game folder')
class LocalBattleTests(unittest.TestCase):
    """Five battles of 11.11 (1.06, 1 120 hits; the game folder is read, never written): converted to the reference
    form they read back the same and publish the same file."""

    def publish(self, name, rows):
        from local_armor_inspector.exporter import Exporter
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'battles'))
            with open(os.path.join(root, 'battles', name + '.jsonl'), 'w') as stream:
                for row in rows: stream.write(json.dumps(row, separators=(',', ':')) + '\n')
            exporter = Exporter(root, root, 'version\n', os.path.join(root, 'unused.wotmod'))
            exporter.publishing_final = True
            exporter.republish_saved(name)
            # The value of the file: the order of an object's keys may differ (CPython keeps the order a dict was filled in, and
            # a hit read back from its halves fills the shooter's live fields first); the client's Python 2.7 orders by hash.
            with open(os.path.join(root, 'data', 'battles', name + '.js'), 'rb') as stream: text = stream.read().decode('ascii')
            prefix = 'ArmorInspectorData.receive('
            self.assertTrue(text.startswith(prefix) and text.endswith(');\n'), name)
            return json.loads(text[len(prefix):-3])

    def test_converted_battles_read_and_publish_the_same(self):
        for name in LOCAL:
            path = os.path.join(RAW, name + '.jsonl')
            with open(path, 'rb') as stream: data = stream.read()
            old = [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()]
            new = convert(path)
            self.assertLess(len(json.dumps(new)), 0.9 * len(json.dumps(old)), name)
            self.assertEqual(plain(read(new)), plain(read(old)), name)
            self.assertEqual(self.publish(name, new), self.publish(name, old), name)



if __name__ == '__main__':
    unittest.main()
