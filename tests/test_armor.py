import copy
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from mod.local_armor_inspector.armor import ArmorCatalog, shot_candidates
from mod.local_armor_inspector.packed_xml import signed_integer


class ArmorTests(unittest.TestCase):
    def test_signed_packed_xml_values(self):
        self.assertEqual(signed_integer(b'\xff'), -1)
        self.assertEqual(signed_integer(b'\x00\x80'), -32768)
        self.assertEqual(signed_integer(b'\xff\x7f'), 32767)

    def test_catalog_merges_component_flags_and_track_armor(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'res/packages').mkdir(parents=True)
            resource = 'vehicles/test/collision_client/Chassis.model'
            common = '<root><materials><leftTrack><extra>track</extra><vehicleDamageFactor>0</vehicleDamageFactor><useHitAngle>true</useHitAngle><collideOnceOnly>true</collideOnceOnly></leftTrack></materials></root>'
            vehicle = '<root><chassis><Track><hitTester><collisionModelClient>'+resource+'</collisionModelClient></hitTester><trackPairParams><trackPairIdx>0</trackPairIdx><armor><leftTrack>20<useHitAngle>false</useHitAngle></leftTrack></armor></trackPairParams></Track></chassis></root>'
            with zipfile.ZipFile(root/'res/packages/scripts.pkg','w') as z:
                z.writestr('scripts/item_defs/vehicles/test/Tank.xml', vehicle)
                z.writestr('scripts/item_defs/vehicles/common/vehicle.xml', common)
            catalog = ArmorCatalog(temp)
            material = catalog.materials('test:Tank', resource)['leftTrack']
            self.assertEqual(material['armor'], 20)
            self.assertFalse(material['useHitAngle'])
            self.assertTrue(material['collideOnceOnly'])
            with self.assertRaises(ValueError): catalog.materials('test:Tank', resource+'X')
            with self.assertRaises(ValueError): catalog.materials('../outside:Tank', resource)
            override = root/'res_mods/2.4.0.0/scripts/item_defs/vehicles/test/Tank.xml'
            override.parent.mkdir(parents=True); override.write_text(vehicle)
            with self.assertRaisesRegex(ValueError, 'overridden'):
                ArmorCatalog(temp).materials('test:Tank', resource)

    def test_shell_matching_preserves_ambiguity_and_parameters(self):
        shell = types.SimpleNamespace(name='Test', userString='Test shell', kind='ARMOR_PIERCING_CR',
            effectsIndex=18, caliber=105, piercingPowerRandomization=.25, piercingPowerRandomizationType='NORMAL',
            type=types.SimpleNamespace(normalizationAngle=.034906585, ricochetAngleCos=.342020143))
        shot = types.SimpleNamespace(shell=shell, piercingPower=(250,220))
        second = copy.deepcopy(shot);second.shell.name='Premium';second.piercingPower=(310,270)
        descriptor = types.SimpleNamespace(gun=types.SimpleNamespace(shots=[shot,second]))
        # The client's constants module (shell kind -> type index) exists only in the game; a stand-in here.
        client = types.SimpleNamespace(SHELL_TYPES_INDICES={'ARMOR_PIERCING':0, 'ARMOR_PIERCING_CR':1,
            'HOLLOW_CHARGE':2, 'HIGH_EXPLOSIVE':3})
        with patch.dict(sys.modules, {'constants':client}):
            self.assertEqual(shot_candidates(descriptor,19), [])
            candidates = shot_candidates(descriptor,18)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]['penetration500'],220)
        self.assertAlmostEqual(candidates[0]['normalization'],.034906585)


if __name__ == '__main__': unittest.main()
