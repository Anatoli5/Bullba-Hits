"""Focused contract tests for lossless armour-table record packing."""
from __future__ import absolute_import

import copy
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector.records import (ArmorTable, PitchTable, RecordDecoder, RecordEncoder,
                                          config_key, pack_battle, snapshot_refs, stamp_snapshot,
                                          unpack_battle, SNAPSHOT_KEY)
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



if __name__ == '__main__':
    unittest.main()
