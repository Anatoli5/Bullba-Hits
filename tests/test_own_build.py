"""The player's own build for the page's Config entry Current (BACKLOG 102, user 14.11).

The garage: the hook reads the mounted directive and consumables off the gui Vehicle (hangar_fitted), the vehicle file
names the equipment its descriptor packs and those two (vehicle_build -> `build`), a change of consumables alone exports it
again, as does a garage file of the same descriptor without a build. A battle: the equipment of
the player's own vehicles read off their own descriptors (own_builds -> the battle file's `ownBuilds`) - his attacker
blocks only (his vehicle as a target is recorded stripped), never another player's.
The client is not here: VehicleDescr is a fake, as in tests/test_vehicle_export.py.
"""
import builtins
import json
import sys
import types
import unittest
from unittest.mock import patch

if not hasattr(builtins, 'basestring'):
    builtins.basestring = str
web = sys.modules.setdefault('web', types.ModuleType('web'))
if 'web.web_client_api' not in sys.modules:
    api = types.ModuleType('web.web_client_api')
    api.W2CSchema = type('W2CSchema', (), {})
    api.Field = lambda **kw: None
    api.createCommandHandler = lambda *a, **kw: None
    web.web_client_api = api
    sys.modules['web.web_client_api'] = api

from mod.local_armor_inspector import exporter as ex
from mod import mod_local_armor_inspector as modmain
from tests import test_vehicle_export as tvx
from tests.test_vehicle_export import FakeDescriptor, read_data, IDENTIFIER, TYPE


class Device(object):
    def __init__(self, name): self.name = name


def descriptor(devices, type_name=TYPE):
    d = FakeDescriptor()
    d.optionalDevices = [Device(n) if n else None for n in devices]
    d.type = type('T', (), {'name': type_name, 'shortUserString': 'Maus', 'level': 10, 'tags': frozenset(('heavyTank',)), 'role': 1})()
    return d


class Item(object):
    def __init__(self, name, stimulator=False):
        self.name = name
        self.isStimulator = stimulator


class Collector(object):
    """A gui equipment collector: `installed` iterates its slots, an empty one as None (vehicle_equipment, 2.4.1.1)."""
    def __init__(self, items): self.installed = items


class GuiVehicle(object):
    def __init__(self, descr, consumables, boosters):
        self.descriptor = descr
        self.consumables = Collector(consumables)
        self.battleBoosters = Collector(boosters)


class DescriptorBuildTests(unittest.TestCase):
    def test_devices_by_slot_with_empty_slots(self):
        self.assertEqual(ex.descr_devices(descriptor(['tankRammer_tier1', '', 'turbocharger_tier1'])),
                         ['tankRammer_tier1', '', 'turbocharger_tier1'])
        self.assertEqual(ex.descr_devices(FakeDescriptor()), ['', '', ''])

    def test_the_garage_names_even_an_empty_build_and_another_source_only_a_packed_one(self):
        self.assertEqual(ex.vehicle_build(descriptor(['', '', '']), 'hangar'), {'from': 'hangar', 'devices': ['', '', '']})
        self.assertEqual(ex.vehicle_build(descriptor(['', '', '']), 'battle'), None)   # another player's: stripped
        self.assertEqual(ex.vehicle_build(descriptor(['', 'aimingStabilizer_tier1', '']), 'battle'),
                         {'from': 'battle', 'devices': ['', 'aimingStabilizer_tier1', '']})
        self.assertEqual(ex.vehicle_build(descriptor(['deluxRammer', '', '']), 'hangar', {'consumables': ['food', 'largeMedkit'], 'directive': 'rammerBattleBooster'}),
                         {'from': 'hangar', 'devices': ['deluxRammer', '', ''], 'consumables': ['food', 'largeMedkit'], 'directive': 'rammerBattleBooster'})


class HangarHookTests(unittest.TestCase):
    def test_hangar_fitted_reads_consumables_rations_and_the_directive(self):
        vehicle = GuiVehicle(descriptor(['', '', '']), [Item('largeMedkit'), None, Item('ration_china', True)], [None, Item('rammerBattleBooster')])
        self.assertEqual(modmain.hangar_fitted(vehicle), {'consumables': ['largeMedkit', 'food'], 'directive': 'rammerBattleBooster'})

    def test_hangar_fitted_without_the_collectors_is_none_and_never_raises(self):
        self.assertIsNone(modmain.hangar_fitted(object()))

    def test_the_hangar_hook_hands_the_fitted_items_with_the_descriptor(self):
        """The garage's vehicle (a fake g_currentVehicle): its request carries its equipment's descriptor and `fitted`; the
        same descriptor with other consumables is a new request, not a repeat."""
        asked = []

        class Recorder(object):
            def request_vehicle(self, descr, source, fitted=None): asked.append((descr, source, fitted))

        descr = descriptor(['tankRammer_tier1', '', ''])
        car = GuiVehicle(descr, [Item('smallRepairkit')], [])
        hangar = type('H', (), {'isPresent': lambda self: True, 'item': car})()
        events = modmain.VehicleEvents(Recorder())
        events.hangar = hangar
        with patch.object(modmain, 'follow_hangar', lambda name: None):
            events.on_hangar_vehicle()
        self.assertEqual(asked, [(descr, 'hangar', {'consumables': ['smallRepairkit'], 'directive': ''})])
        request = modmain.vehicle_request(descr, 'hangar', asked[0][2])
        self.assertEqual(request['fitted'], {'consumables': ['smallRepairkit'], 'directive': ''})
        self.assertNotIn('fitted', modmain.vehicle_request(descr, 'battle'))


class HangarFileTests(unittest.TestCase):
    """The vehicle file of the garage's vehicle, on the export fixture of tests/test_vehicle_export.py (its helpers, not its
    tests)."""
    BUILD = ['tankRammer_tier1', 'extraHealthReserve_tier1', '']
    setUp = tvx.VehicleExportTests.setUp
    build = tvx.VehicleExportTests.build
    export = tvx.VehicleExportTests.export
    setup_exporter = tvx.VehicleExportTests.setup_exporter
    raw_requests = tvx.VehicleExportTests.raw_requests

    def client(self):
        patches = tvx.VehicleExportTests.client(self)
        patches[0] = patch.object(ex, 'vehicle_descr', return_value=descriptor(self.BUILD))
        return patches

    def test_the_garage_file_names_its_build_and_its_raw_line_keeps_the_fitted_items(self):
        self.setup_exporter()
        request = dict(self.request, fitted={'consumables': ['food'], 'directive': ''})
        self.assertTrue(self.export(request=request))
        record = read_data(self.folder / 'data/vehicles' / (IDENTIFIER + '.js'))[1]
        self.assertEqual(record['build'], {'from': 'hangar', 'devices': self.BUILD, 'consumables': ['food'], 'directive': ''})
        self.assertEqual(self.raw_requests()[-1]['fitted'], {'consumables': ['food'], 'directive': ''})
        # Other consumables, the same descriptor: exported again (the build changed); the same again: not.
        other = dict(self.request, fitted={'consumables': ['qualityFuel'], 'directive': ''})
        self.assertTrue(self.export(request=other))
        self.assertFalse(self.export(request=other))
        self.assertEqual(read_data(self.folder / 'data/vehicles' / (IDENTIFIER + '.js'))[1]['build']['consumables'], ['qualityFuel'])

    def test_a_garage_file_of_before_the_build_is_exported_again_by_the_garage(self):
        """A file of the same descriptor written without a build (before 14.11): the garage's request exports it again."""
        self.setup_exporter()
        self.assertTrue(self.export(request=dict(self.request, source='battle')))   # own vehicle from a battle: devices only
        self.assertEqual(read_data(self.folder / 'data/vehicles' / (IDENTIFIER + '.js'))[1]['build'], {'from': 'battle', 'devices': self.BUILD})
        self.assertTrue(self.export())
        self.assertEqual(read_data(self.folder / 'data/vehicles' / (IDENTIFIER + '.js'))[1]['build'], {'from': 'hangar', 'devices': self.BUILD})


class OwnBuildsTests(unittest.TestCase):
    ME, OTHER = 7, 9

    def descr_of(self, compact):
        return {'mine': descriptor(['trophyUpgradedTurbocharger', 'trophyUpgradedAimingStabilizer', '']),
                'bare': descriptor(['', '', '']),
                'theirs': descriptor(['', '', '']),
                'moved': descriptor(['tankRammer_tier1', '', ''], 'ussr:Other'),
                'replay': descriptor(['', '', 'improvedVentilation_tier1'], 'usa:Second')}[compact]

    def test_the_players_attacker_blocks_name_his_build_his_target_blocks_and_others_do_not(self):
        hits = [
            # his vehicle as a target: the stripped descriptor - says nothing
            {'targetId': self.ME, 'attackerId': self.OTHER, 'target': {'type': TYPE, 'compactDescriptor': 'bare'},
             'attacker': {'type': 'ussr:Enemy', 'compactDescriptor': 'theirs'}},
            {'attackerId': self.ME, 'targetId': self.OTHER, 'attacker': {'type': TYPE, 'compactDescriptor': 'mine'},
             'target': {'type': 'ussr:Enemy', 'compactDescriptor': 'theirs'}},
            {'attackerId': self.ME, 'attacker': {'type': 'germany:Moved', 'compactDescriptor': 'moved'}}]
        rosters = [{'vehicles': [{'id': self.ME, 'type': 'usa:Second', 'compDescr': 'replay'},
                                 {'id': self.OTHER, 'type': 'ussr:Enemy', 'compDescr': 'theirs'}]}]
        with patch.object(ex, 'vehicle_descr', side_effect=self.descr_of):
            builds = ex.own_builds(hits, rosters, self.ME)
        self.assertEqual(builds, {TYPE: {'devices': ['trophyUpgradedTurbocharger', 'trophyUpgradedAimingStabilizer', '']},
                                  'usa:Second': {'devices': ['', '', 'improvedVentilation_tier1']}})

    def test_no_player_no_builds_and_a_descriptor_that_fails_is_skipped(self):
        self.assertEqual(ex.own_builds([{'attackerId': None, 'attacker': {'type': TYPE, 'compactDescriptor': 'x'}}], [], None), {})
        with patch.object(ex, 'vehicle_descr', side_effect=ValueError('no client')):
            self.assertEqual(ex.own_builds([{'attackerId': 1, 'attacker': {'type': TYPE, 'compactDescriptor': 'x'}}], [], 1), {})


class PublishTests(unittest.TestCase):
    def test_publish_writes_own_builds_and_derived_format_says_so(self):
        """publish() puts own_builds' answer on the battle file (static: the call and its key) - DERIVED_FORMAT 5."""
        import inspect
        source = inspect.getsource(ex.Exporter.publish)
        self.assertIn("own_builds(result['hits'], rosters, battle.get('playerVehicleId'))", source)
        self.assertIn("result['ownBuilds'] = builds", source)
        self.assertGreaterEqual(ex.DERIVED_FORMAT, 5)


if __name__ == '__main__':
    unittest.main()
