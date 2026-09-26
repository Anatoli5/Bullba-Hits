"""The gun's statics of the aim block (26.09, fields audit P2-P4: outputs/mechanics-fields-audit-2026-09-26.md).

gun_statics reads the gun's elevation speed, its circle multiplier while damaged and the shells' start points from a
descriptor; aim_block writes them, fix_gun_statics gives them to an older record's blocks from each block's own mode.
The client is not here: the descriptors are stand-ins with just the attributes read.
"""
import types
import unittest
from unittest.mock import patch

from mod.local_armor_inspector import exporter as ex

NS = types.SimpleNamespace


def v3(x, y, z):
    return NS(x=x, y=y, z=z)


def descr(name='germany:G1_Test', pitch=0.61, damaged=2.0, offset=(0.0, 0.0, 0.0), barrels=None, joint=(0.0, 0.53, 0.83)):
    gun = NS(rotationSpeed=pitch, shotDispersionFactors={'turretRotation': 0.1, 'afterShot': 4.0, 'whileGunDamaged': damaged},
             shotOffset=v3(*offset), multiGun=barrels)
    return NS(gun=gun, turret=NS(gunPosition=v3(*joint)), type=NS(name=name))


class GunStatics(unittest.TestCase):
    def test_a_plain_gun_has_its_pitch_speed_and_damaged_factor_and_no_offset(self):
        self.assertEqual(ex.gun_statics(descr()), {'gunPitchSpeed': 0.61, 'whileGunDamagedFactor': 2.0})

    def test_a_single_barrel_offset_is_the_gun_s_own_shot_offset(self):
        # FV226 Contradictious-like: the shell leaves 0.88 m ahead of the joint.
        out = ex.gun_statics(descr(offset=(0.0, 0.0, 0.88), damaged=3.0))
        self.assertEqual(out['shotOffsets'], [[0.0, 0.0, 0.88]])
        self.assertEqual(out['whileGunDamagedFactor'], 3.0)

    def test_the_barrels_of_a_multi_gun_are_their_shot_positions_from_the_joint(self):
        # The dual gun of the client (_100mm_S34_dualgun_SH): two barrels 0.19 m either side of the joint.
        barrels = [NS(shotPosition=v3(-0.19, 0.531, 0.834)), NS(shotPosition=v3(0.191, 0.531, 0.834))]
        out = ex.shot_offsets(descr(barrels=barrels, joint=(0.0, 0.531, 0.834), offset=(0.0, 0.3, 0.0)))
        self.assertEqual(out, [[-0.19, 0.0, 0.0], [0.191, 0.0, 0.0]])

    def test_an_empty_multi_gun_falls_back_to_the_gun_s_offset(self):
        self.assertEqual(ex.shot_offsets(descr(barrels=[], offset=(-0.19, 0.0, 0.0))), [[-0.19, 0.0, 0.0]])

    def test_another_gun_of_the_turret_is_read_from_the_main_joint(self):
        # secondary_aim's gun (Taschenratte's mortar): its own speed and factor, its barrel from the MAIN gun's joint.
        mortar = NS(rotationSpeed=0.2, shotDispersionFactors={'whileGunDamaged': 2.0}, shotOffset=v3(0, 0, 0),
                    multiGun=[NS(shotPosition=v3(0.5, 1.03, 0.83))])
        out = ex.gun_statics(descr(), gun=mortar)
        self.assertEqual(out, {'gunPitchSpeed': 0.2, 'whileGunDamagedFactor': 2.0, 'shotOffsets': [[0.5, 0.5, 0.0]]})

    def test_a_refused_field_is_left_out(self):
        broken = descr()
        broken.gun.shotDispersionFactors = {}
        self.assertEqual(ex.gun_statics(broken), {'gunPitchSpeed': 0.61})


class FixGunStatics(unittest.TestCase):
    def record(self, **extra):
        vehicle = {'type': 'germany:G1_Test', 'compactDescriptor': 'cd', 'vehicleMode': 0,
                   'aim': {'dispersion': 0.004, 'aimingTime': 2.0}}
        vehicle.update(extra)
        return vehicle

    def test_an_older_block_gets_the_fields_of_its_own_mode(self):
        both = NS(hasSiegeMode=True, defaultVehicleDescr=descr(pitch=0.5), siegeVehicleDescr=descr(pitch=0.2, damaged=1.6),
                  type=NS(name='germany:G1_Test'))
        vehicle = self.record(modeAim={'dispersion': 0.003}, modeAimMode=1)
        with patch.object(ex, 'vehicle_descr', return_value=both):
            self.assertTrue(ex.fix_gun_statics(vehicle))
        self.assertEqual((vehicle['aim']['gunPitchSpeed'], vehicle['aim']['whileGunDamagedFactor']), (0.5, 2.0))
        self.assertEqual((vehicle['modeAim']['gunPitchSpeed'], vehicle['modeAim']['whileGunDamagedFactor']), (0.2, 1.6))

    def test_a_current_block_builds_nothing(self):
        vehicle = self.record()
        vehicle['aim'].update(gunPitchSpeed=0.4, whileGunDamagedFactor=2.0)
        with patch.object(ex, 'vehicle_descr', side_effect=AssertionError('built')):
            self.assertFalse(ex.fix_gun_statics(vehicle))

    def test_another_type_or_no_descriptor_leaves_the_block_alone(self):
        vehicle = self.record()
        with patch.object(ex, 'vehicle_descr', return_value=descr(name='ussr:R1_Other')):
            self.assertFalse(ex.fix_gun_statics(vehicle))
        self.assertNotIn('gunPitchSpeed', vehicle['aim'])
        vehicle = self.record()
        del vehicle['compactDescriptor']
        self.assertFalse(ex.fix_gun_statics(vehicle))

    def test_fix_aim_completes_a_complete_older_block_with_them(self):
        vehicle = self.record()
        vehicle['aim'].update(dict((k, 1) for k in ex.AIM_COMPLETION_KEYS))
        with patch.object(ex, 'vehicle_descr', return_value=descr(offset=(0.0, 0.3, 0.0))):
            self.assertTrue(ex.fix_aim(vehicle))
        self.assertEqual(vehicle['aim']['shotOffsets'], [[0.0, 0.3, 0.0]])
        self.assertEqual(vehicle['aim']['gunPitchSpeed'], 0.61)


if __name__ == '__main__':
    unittest.main()
