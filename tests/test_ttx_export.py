"""TTX panel, phase 1 (outputs/ttx-panel-spec-2026-09-22.md section 2.5): the characteristics file of a type.

The client is not here, so `items.vehicles` is a stand-in with just what ttx_block reads: a vehicle list,
a VehicleDescr factory and a descriptor that installs components and turret x gun pairs. Two turrets x two
guns, one pair whose gun refuses a field, one pair that cannot be mounted at all in a separate test. The real
client run is the offline stand of the session (scratchpad ttx-impl/offline), not this file.
"""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from mod.local_armor_inspector import exporter as ex


class Item(object):
    def __init__(self, name, level, **fields):
        self.name, self.level, self.compactDescr = name, level, 'cd:' + name
        self.userString = name.upper()
        self.__dict__.update(fields)


class Gun(Item):
    def __init__(self, name, level, broken=False, **fields):
        Item.__init__(self, name, level, shortUserString=name + ' short', tags=frozenset(fields.pop('tags', ())),
                      maxAmmo=40, invisibilityFactorAtShot=0.15, turretYawLimits=None,
                      pitchLimits={'absolute': (-0.3, 0.1), 'minPitch': ((0.0, -0.3), (1.0, -0.3)),
                                   'maxPitch': ((0.0, 0.1), (1.0, 0.1))}, **fields)
        self.broken = broken


class BrokenGun(Gun):
    @property
    def maxAmmo(self):
        raise AttributeError('maxAmmo')

    @maxAmmo.setter
    def maxAmmo(self, value):
        pass


def fake_type(unmountable=None):
    g1a, g1b = Gun('g_75', 8), BrokenGun('g_88', 9)
    g2a, g2b = Gun('g_75', 8), Gun('g_105', 9, tags=('dualGun',))
    turrets = [Item('turret_1', 8, guns=[g1a, g1b], circularVisionRadius=380.0, invisibilityFactor=1.0,
                    primaryArmor=(120.0, 80.0, 60.0)),
               Item('turret_2', 9, guns=[g2a, g2b], circularVisionRadius=400.0, invisibilityFactor=0.95,
                    primaryArmor=(152.39999389648438, 80.0, 60.0))]
    # The suspension's repair (23.09): the top chassis has two track pairs, the other one its own healthParams only.
    track = lambda t: types.SimpleNamespace(healthParams=types.SimpleNamespace(repairTime=t))
    vtype = types.SimpleNamespace(
        name='germany:G1_Test', turrets=[turrets],
        chassis=[Item('ch_1', 8, terrainResistance=(1.0, 1.2, 2.0), trackPairs=(), repairTime=7.0),
                 Item('ch_2', 9, terrainResistance=(0.9, 1.1, 1.9), trackPairs=(track(5.2941179275512695), track(6.857142925262451)))],
        engines=[Item('en_1', 8, power=500000.0), Item('en_2', 9, power=600000.0)],
        radios=[Item('ra_1', 9)], fuelTanks=[Item('ft_1', 1)],
        invisibility=(0.1, 0.2), invisibilityDeltas={'camouflageBonus': 0.03},
        optDevsOverrides={'camouflageNet': {'invisibilityBonus': types.SimpleNamespace(opType=None, values=(0.05, 0.075))}},
        xphysics={'chassis': {}}, crewRoles=(('commander',),), unmountable=unmountable)
    return vtype


class Descriptor(object):
    def __init__(self, vtype):
        self.type = vtype
        self.chassis, self.engine = vtype.chassis[0], vtype.engines[0]
        self.radio, self.fuelTank = vtype.radios[0], vtype.fuelTanks[0]
        self.turret, self.gun = vtype.turrets[0][0], vtype.turrets[0][0].guns[0]
        self.installed = []
        self.hasSiegeMode = self.isWheeledVehicle = self.isWheeledOnSpotRotation = False
        self.hasTurboshaftEngine = self.hasRocketAcceleration = self.hasHydraulicChassis = False
        self.isTrackWithinTrack = False
        self.miscAttrs = {}
        self.mechanicsParams = {}
        # A real turret unless the type says its turret is the hull's fake one (params __hasTurret).
        self.hull = types.SimpleNamespace(fakeTurrets={'lobby': getattr(vtype, 'fakeTurrets', ()), 'battle': ()},
                                          primaryArmor=(150.0, 150.0, 100.0))

    @property
    def turrets(self):
        return [(self.turret, self.gun)]

    def installComponent(self, compact):
        self.installed.append(compact)
        for attribute, listing in (('chassis', 'chassis'), ('engine', 'engines'), ('radio', 'radios'),
                                   ('fuelTank', 'fuelTanks')):
            for item in getattr(self.type, listing):
                if item.compactDescr == compact: setattr(self, attribute, item)

    def installTurret(self, turret, gun):
        if self.type.unmountable == (turret, gun): raise ValueError('cannot mount')
        for candidate in self.type.turrets[0]:
            if candidate.compactDescr == turret:
                self.turret = candidate
                self.gun = [g for g in candidate.guns if g.compactDescr == gun][0]

    @property
    def maxHealth(self):
        return 1000 + 100 * self.type.turrets[0].index(self.turret)

    @property
    def physics(self):
        return {'weight': 40000.0 + 1000.0 * self.gun.level + 10.0 * self.type.turrets[0].index(self.turret)}


def install_client(vtype):
    """items.vehicles with just the names ttx_block imports; the rest of the client stays missing."""
    items = types.ModuleType('items')
    vehicles = types.ModuleType('items.vehicles')
    vehicles.g_list = types.SimpleNamespace(getIDsByName=lambda name: (1, 7))
    vehicles.g_cache = types.SimpleNamespace(commonConfig={'miscParams': {'projectileSpeedFactor': 0.8}})
    vehicles.VehicleDescr = lambda typeID=None, compactDescr=None: Descriptor(vtype)
    vehicles.vehicleAttributeFactors = lambda: {'gun/extraReloadTime': 0.0}
    items.vehicles = vehicles
    return patch.dict(sys.modules, {'items': items, 'items.vehicles': vehicles})


def shells(descr, installation=None):
    return [{'name': 'AP of ' + descr.gun.name, 'gunInstallation': installation}]


class TtxBlockTests(unittest.TestCase):
    def build(self, vtype):
        with install_client(vtype), patch.object(ex, 'shot_candidates', side_effect=shells), \
                patch.object(ex, 'aim_block', side_effect=lambda d: {'dispersion': 0.004, 'reloadTime': d.gun.level}):
            return ex.ttx_block('germany:G1_Test', 'version\n')

    def test_two_turrets_by_two_guns_make_four_configs(self):
        block = self.build(fake_type())
        self.assertEqual(block['schema'], 1)
        self.assertEqual((block['id'], block['type']), ('germany-G1_Test', 'germany:G1_Test'))
        self.assertEqual([(c['turret'], c['gun']) for c in block['configs']],
                         [(0, 'g_75'), (0, 'g_88'), (1, 'g_75'), (1, 'g_105')])
        # The broken field costs that field of that pair only, and is named.
        broken = block['configs'][1]
        self.assertNotIn('maxAmmo', broken)
        self.assertEqual(broken['maxHealth'], 1000)
        self.assertEqual(block['warnings'], ['turret_1 x g_88: Ammunition unavailable'])
        self.assertTrue(all('maxAmmo' in c for i, c in enumerate(block['configs']) if i != 1))

    def test_top_follows_best_component_and_the_modules_are_the_best(self):
        block = self.build(fake_type())
        self.assertEqual([c['top'] for c in block['configs']], [False, False, False, True])
        self.assertEqual(block['modules']['chassis']['name'], 'ch_2')
        self.assertEqual(block['modules']['chassis']['terrainResistance'], [0.9, 1.1, 1.9])
        self.assertIsNone(block['modules']['chassis']['maxSteeringLockAngle'])
        self.assertEqual(block['modules']['engine'], {'name': 'en_2', 'userString': 'EN_2', 'level': 9,
                                                       'power': 600000.0})
        self.assertEqual([t['name'] for t in block['turrets']], ['turret_1', 'turret_2'])
        self.assertEqual(block['turrets'][1]['circularVisionRadius'], 400.0)

    def test_shells_once_per_gun_and_the_pair_fields(self):
        block = self.build(fake_type())
        self.assertEqual(sorted(block['shells']), ['g_105', 'g_75', 'g_88'])
        self.assertEqual(block['shells']['g_75'], [{'name': 'AP of g_75', 'gunInstallation': 0}])
        config = block['configs'][3]
        self.assertEqual(config['aim'], {'dispersion': 0.004, 'reloadTime': 9, 'aimFrom': 'compact'})
        self.assertEqual((config['maxHealth'], config['weight'], config['maxAmmo']), (1100, 49010.0, 40))
        self.assertEqual(config['gunUserString'], 'g_105 short')
        self.assertEqual(config['pitch'], {'absolute': [-0.3, 0.1], 'minPitch': [[0.0, -0.3], [1.0, -0.3]],
                                           'maxPitch': [[0.0, 0.1], [1.0, 0.1]]})
        self.assertIsNone(config['turretYawLimits'])
        self.assertEqual(config['reloadExtra'], {})
        self.assertEqual(block['vehicle']['optDevsOverrides'],
                         {'camouflageNet': {'invisibilityBonus': {'values': [0.05, 0.075]}}})
        self.assertEqual(block['vehicle']['projectileSpeedFactor'], 0.8)
        self.assertTrue(block['vehicle']['modes']['dualGun'])
        self.assertFalse(block['vehicle']['modes']['twinGun'])
        json.dumps(block, allow_nan=False)

    def test_the_turret_flag_is_the_garage_s_own_test(self):
        # params __hasTurret: len(hull.fakeTurrets['lobby']) != len(turrets) - a real turret here, none on a fake one.
        self.assertIs(self.build(fake_type())['vehicle']['hasTurret'], True)
        turretless = fake_type()
        turretless.fakeTurrets = (0,)
        self.assertIs(self.build(turretless)['vehicle']['hasTurret'], False)

    def test_the_garage_s_survivability_is_in_the_file(self):
        # 23.09: the hull's armour per pair, each turret's, the suspension's repair times of the top chassis in its own
        # order (the garage reverses them after dividing), the marker and the track-within-track flag.
        block = self.build(fake_type())
        self.assertEqual(block['armorSchema'], ex.TTX_ARMOR_SCHEMA)
        self.assertEqual([c['hullArmor'] for c in block['configs']], [[150.0, 150.0, 100.0]] * 4)
        self.assertEqual([t['primaryArmor'] for t in block['turrets']], [[120.0, 80.0, 60.0], [152.39999389648438, 80.0, 60.0]])
        self.assertEqual(block['modules']['chassis']['repairTime'], [5.2941179275512695, 6.857142925262451])
        self.assertIs(block['vehicle']['modes']['trackWithinTrack'], False)
        self.assertEqual(block['warnings'], ['turret_1 x g_88: Ammunition unavailable'])

    def test_the_repair_times_as_the_garage_reads_them(self):
        # params.VehicleParams.chassisRepairTime 883-897: every track pair's own time, [] when one has none; a chassis
        # without track pairs (wheeled) its own healthParams.repairTime, [] without one.
        track = lambda t: types.SimpleNamespace(healthParams=types.SimpleNamespace(repairTime=t))
        self.assertEqual(ex.ttx_repair_times(types.SimpleNamespace(trackPairs=(track(6.5),))), [6.5])
        self.assertEqual(ex.ttx_repair_times(types.SimpleNamespace(trackPairs=(track(6.5), track(None)))), [])
        self.assertEqual(ex.ttx_repair_times(types.SimpleNamespace(trackPairs=(), repairTime=10.97)), [10.97])
        self.assertEqual(ex.ttx_repair_times(types.SimpleNamespace(trackPairs=(), repairTime=None)), [])
        self.assertEqual(ex.ttx_repair_times(types.SimpleNamespace()), [])

    def test_a_pair_that_cannot_be_mounted_is_left_out_and_named(self):
        block = self.build(fake_type(unmountable=('cd:turret_2', 'cd:g_75')))
        self.assertEqual([(c['turret'], c['gun']) for c in block['configs']], [(0, 'g_75'), (0, 'g_88'), (1, 'g_105')])
        self.assertIn('Pair turret_2 x g_75 could not be mounted', block['warnings'])


class EnsureTtxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.exporter = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        self.path = Path(self.temp.name) / 'data/ttx/germany-G1_Test.js'

    def build(self, action):
        with install_client(fake_type()), patch.object(ex, 'shot_candidates', side_effect=shells), \
                patch.object(ex, 'aim_block', return_value={'dispersion': 0.004}):
            return action()

    def test_not_inline_queues_exactly_one_job(self):
        self.exporter.ensure_ttx('germany:G1_Test', inline=False)
        self.exporter.ensure_ttx('germany:G1_Test', inline=False)
        self.assertEqual([job[2:] for job in self.exporter.jobs], [['ttx', {'vehicleType': 'germany:G1_Test'}]])
        self.assertFalse(self.path.exists())
        self.assertTrue(self.build(self.exporter.run_job))
        self.assertTrue(self.path.exists())
        self.assertEqual(self.exporter.ttx_known, {'germany:G1_Test': ex.TTX_CURRENT})

    def test_the_page_raises_a_queued_job_to_the_front(self):
        self.exporter.ensure_ttx('germany:G1_Test', inline=False)
        self.exporter.request_ttx('germany:G1_Test')
        self.assertEqual([(job[0], job[2]) for job in self.exporter.jobs], [(ex.JOB_PAGE, 'ttx')])
        with self.assertRaises(ValueError):
            self.exporter.request_ttx('../escape')

    def test_inline_builds_once_and_a_current_file_is_read_not_rebuilt(self):
        self.assertTrue(self.build(lambda: self.exporter.ensure_ttx('germany:G1_Test', inline=True)))
        key, value = json.loads(self.path.read_text(encoding='ascii')[len('ArmorInspectorData.receive('):-3])
        self.assertEqual(key, 'ttx:germany-G1_Test')
        self.assertEqual(value['clientVersion'], 'version\n')
        self.assertFalse(self.exporter.ensure_ttx('germany:G1_Test', inline=True))
        fresh = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        with patch.object(ex, 'ttx_block', side_effect=AssertionError('rebuilt')):
            self.assertFalse(fresh.ensure_ttx('germany:G1_Test', inline=True))
        self.assertEqual(fresh.ttx_known, {'germany:G1_Test': ex.TTX_CURRENT})
        newer = ex.Exporter(self.temp.name, self.temp.name, 'another client\n')
        self.assertTrue(self.build(lambda: newer.ensure_ttx('germany:G1_Test', inline=True)))

    def test_a_sector_file_without_the_turret_flag_is_built_again_once(self):
        self.assertTrue(self.build(lambda: self.exporter.ensure_ttx('germany:G1_Test', inline=True)))
        text = self.path.read_text(encoding='ascii')
        key, value = json.loads(text[len('ArmorInspectorData.receive('):-3])
        del value['vehicle']['hasTurret']
        ex.write_data(str(self.path), key, value)
        # No gun with a sector: the file is current without the flag.
        fresh = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        self.assertTrue(fresh.ttx_current('germany:G1_Test'))
        value['configs'][0]['turretYawLimits'] = [-0.2, 0.2]
        ex.write_data(str(self.path), key, value)
        self.assertFalse(fresh.ttx_current('germany:G1_Test'))
        again = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        self.assertTrue(self.build(lambda: again.ensure_ttx('germany:G1_Test', inline=True)))
        self.assertTrue(fresh.ttx_current('germany:G1_Test'))

    def test_a_file_without_the_armour_is_built_again_once(self):
        # 23.09: every file of before the armour and the suspension's repair counts as outdated, once.
        self.assertTrue(self.build(lambda: self.exporter.ensure_ttx('germany:G1_Test', inline=True)))
        key, value = json.loads(self.path.read_text(encoding='ascii')[len('ArmorInspectorData.receive('):-3])
        fresh = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        self.assertTrue(fresh.ttx_current('germany:G1_Test'))
        del value['armorSchema']
        ex.write_data(str(self.path), key, value)
        self.assertFalse(fresh.ttx_current('germany:G1_Test'))
        again = ex.Exporter(self.temp.name, self.temp.name, 'version\n')
        self.assertTrue(self.build(lambda: again.ensure_ttx('germany:G1_Test', inline=True)))
        self.assertTrue(fresh.ttx_current('germany:G1_Test'))

    def test_without_the_client_the_type_fails_once_and_is_not_retried(self):
        with patch.dict(sys.modules, {'items': None}):
            self.assertFalse(self.exporter.ensure_ttx('germany:G1_Test', inline=True))
        self.assertEqual(self.exporter.ttx_known, {'germany:G1_Test': ex.TTX_FAILED})
        with patch.object(ex, 'ttx_block', side_effect=AssertionError('retried')):
            self.assertFalse(self.exporter.ensure_ttx('germany:G1_Test', inline=True))
            self.exporter.ensure_ttx('germany:G1_Test', inline=False)
        self.assertEqual(self.exporter.jobs, [])
        self.exporter.request_ttx('germany:G1_Test')   # the page may ask again
        self.assertEqual(len(self.exporter.jobs), 1)

    def test_vehicle_and_ttx_jobs_of_one_type_do_not_merge(self):
        self.exporter.request_vehicle_export({'vehicleType': 'germany:G1_Test', 'source': 'battle'})
        self.exporter.ensure_ttx('germany:G1_Test', inline=False)
        self.assertEqual(sorted(job[2] for job in self.exporter.jobs), ['ttx', 'vehicle'])
        self.assertEqual(self.exporter.prioritise(['germany:G1_Test']), 2)


if __name__ == '__main__':
    unittest.main()
