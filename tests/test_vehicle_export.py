"""Vehicle export (Spec A): catalogue, derived files, raw log, replay, dedupe, prune.

Same fixture style as tests/test_serverless.py: a temporary game folder, a fake
vehicles_test.pkg holding one .havok, and an Exporter pointed at both. The client
modules do not exist here, so the pieces that need them (rebuilding a descriptor,
its parts, shells and gun limits) are replaced at the module attribute level.
"""
import json
import unittest
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch
from mod.local_armor_inspector import exporter as ex

ROOT = Path(__file__).resolve().parent.parent
RESOURCE = 'vehicles/test/collision_client/Hull.model'
MODEL = {'kind':'client-shot-collision','groups':[{'material':'armor',
    'vertices':[[0,0,0],[1,0,0],[0,1,0]],'indices':[0,1,2]}]}
TYPE = 'germany:G42_Maus'
IDENTIFIER = 'germany-G42_Maus'
ARMOR = {'armor':{'armor':200.0,'useHitAngle':True}}
SHELLS = [{'name':'AP','kind':'ARMOR_PIERCING','penetration100':246.0}]
LIMITS = {'samples':[[0.0,-0.13,0.35]],'source':'client calcPitchLimitsFromDesc'}


def read_data(path):
    text = Path(path).read_text(encoding='ascii')
    assert text.startswith('ArmorInspectorData.receive(') and text.endswith(');\n')
    return json.loads(text[len('ArmorInspectorData.receive('):-3])


class Vector(object):
    """Just enough of a client vector: addition and a height."""

    def __init__(self, y):
        self.y = y

    def __add__(self, other):
        return Vector(self.y + other.y)


class FakeType(object):
    name = TYPE
    shortUserString = 'Maus'
    level = 10
    tags = frozenset(('heavyTank', 'collectorVehicle'))
    role = 1


class FakeGun(object):
    name = 'gun'
    shortUserString = '12,8 cm Kw.K. 44 L/55'
    shotDispersionAngle = 0.0035
    turretYawLimits = (-0.5, 0.5)


class FakeDescriptor(object):
    """A VehicleDescr as far as the export reads one directly."""

    def __init__(self):
        self.type = FakeType()
        self.gun = FakeGun()
        self.chassis = type('Chassis', (), {'hullPosition':Vector(0.4)})()
        self.hull = type('Hull', (), {'turretPositions':[Vector(1.2)]})()
        self.turret = type('Turret', (), {'gunPosition':Vector(0.8), 'name':'Turret_1'})()
        self.maxHealth = 3000

    def makeCompactDescr(self):
        return b'top'


def parts():
    return [{'id':1, 'name':'hull', 'resource':RESOURCE, 'armor':ARMOR,
             'armorSource':'client vehicle descriptor',
             'transform':[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]


class VehicleExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.game = Path(self.temp.name)/'game'; self.game.mkdir()
        self.folder = self.game/'mods/configs/local.armor_inspector'
        (self.folder/'battles').mkdir(parents=True)
        self.archive = self.game/'test.wotmod'
        with zipfile.ZipFile(self.archive, 'w') as z:
            for asset in ex.ASSETS:
                source = ROOT/'web/index.html' if asset == 'Viewer.html' else ROOT/asset
                z.writestr('res/armor_inspector_viewer/'+asset, source.read_bytes())
        packages = self.game/'res/packages'; packages.mkdir(parents=True)
        with zipfile.ZipFile(packages/'vehicles_test.pkg', 'w') as z:
            z.writestr(RESOURCE.replace('.model', '.havok'), b'fixture')
        self.exporter = self.build()
        self.request = {'schema':1, 'type':'vehicle', 'vehicleType':TYPE, 'source':'hangar',
                        'compactDescriptor':'Y29tcGFjdA==', 'requestedAt':1789000000.0,
                        'name':'Maus', 'identity':{'role':'role_HT_break'}}

    def build(self):
        return ex.Exporter(str(self.game), str(self.folder), 'version\n', str(self.archive))

    def client(self):
        """Patch everything the export needs the running client for."""
        return [patch.object(ex, 'vehicle_descr', return_value=FakeDescriptor()),
                patch.object(ex, 'parts_from_descr', side_effect=lambda descr, source=None: parts()),
                patch.object(ex, 'shot_candidates', return_value=list(SHELLS)),
                patch.object(ex, 'gun_limits', return_value=dict(LIMITS)),
                patch.object(ex, 'extract', return_value=MODEL)]

    def export(self, exporter=None, request=None, replay=False):
        exporter = exporter or self.exporter
        patches = self.client()
        for item in patches: item.start()
        try:
            return exporter.export_vehicle(request or self.request, replay=replay)
        finally:
            for item in patches: item.stop()

    def setup_exporter(self, exporter=None):
        exporter = exporter or self.exporter
        patches = self.client()
        for item in patches: item.start()
        try:
            exporter.setup()
        finally:
            for item in patches: item.stop()
        return exporter

    def raw_requests(self):
        path = self.folder/'vehicles/exports.jsonl'
        if not path.is_file(): return []
        return [json.loads(line) for line in path.read_text(encoding='ascii').splitlines() if line]

    # ---------------------------------------------------------------- the export

    def test_export_writes_the_vehicle_the_catalogue_and_the_raw_request(self):
        self.setup_exporter()
        self.assertTrue(self.export())
        key, record = read_data(self.folder/'data/vehicles'/(IDENTIFIER+'.js'))
        self.assertEqual(key, 'vehicle:'+IDENTIFIER)
        self.assertEqual(record['id'], IDENTIFIER)
        self.assertEqual(record['type'], TYPE)
        self.assertEqual(record['name'], 'Maus')
        self.assertEqual((record['level'], record['class']), (10, 'heavyTank'))
        self.assertEqual(record['nation'], 'germany')
        self.assertEqual((record['premium'], record['collector'], record['special']),
                         (False, True, False))
        self.assertEqual(record['role'], 'role_HT_break')
        self.assertEqual(record['source'], 'hangar')
        self.assertEqual(record['compactDescriptor'], self.request['compactDescriptor'])
        self.assertEqual(record['gun'], '12,8 cm Kw.K. 44 L/55')
        # TTX panel (23.09): the XML names of the pair and the health of the configuration.
        self.assertEqual((record['gunName'], record['turretName'], record['maxHealth']), ('gun', 'Turret_1', 3000))
        self.assertEqual(record['gunDispersion'], 0.0035)
        self.assertAlmostEqual(record['gunHeight'], 2.4)
        self.assertEqual(record['gunHeightFrom'], 'ground')
        self.assertEqual(record['turretYawLimits'], [-0.5, 0.5])
        self.assertEqual(record['gunPitchLimits'], LIMITS)
        self.assertEqual(record['shells'], SHELLS)
        self.assertEqual(record['partsFrom'], 'rest pose')
        self.assertEqual(record['warnings'], [])

        part = record['parts'][0]
        self.assertEqual(part['armor'], ARMOR)
        model = self.folder/'data/models'/(part['modelKey']+'.js')
        self.assertEqual(read_data(model)[1]['groups'][0]['indices'], [0, 1, 2])

        catalogue = read_data(self.folder/'data/vehicles.js')
        self.assertEqual(catalogue[0], 'vehicles')
        row = [v for v in catalogue[1]['vehicles'] if v['id'] == IDENTIFIER][0]
        self.assertTrue(row['exported'])
        self.assertEqual(row['source'], 'hangar')
        self.assertEqual(row['exportedAt'], record['exportedAt'])
        self.assertEqual(row['name'], 'Maus')

        self.assertEqual(self.raw_requests(), [{'schema':1, 'type':'vehicle', 'vehicleType':TYPE,
                                                'compactDescriptor':self.request['compactDescriptor'],
                                                'source':'hangar', 'requestedAt':1789000000.0}])

    def test_same_configuration_is_not_exported_twice(self):
        self.setup_exporter()
        self.assertTrue(self.export())
        self.assertFalse(self.export())
        self.assertEqual(len(self.raw_requests()), 1)
        newer = dict(self.request, compactDescriptor='b3RoZXI=', source='battle')
        self.assertTrue(self.export(request=newer))
        self.assertEqual(len(self.raw_requests()), 2)
        record = read_data(self.folder/'data/vehicles'/(IDENTIFIER+'.js'))[1]
        self.assertEqual((record['compactDescriptor'], record['source']), ('b3RoZXI=', 'battle'))

    def test_setup_replays_the_last_request_per_vehicle_type(self):
        self.setup_exporter()
        self.export()
        self.export(request=dict(self.request, compactDescriptor='bGF0ZXN0', source='battle'))
        (self.folder/'data/vehicles'/(IDENTIFIER+'.js')).unlink()
        self.setup_exporter(self.build())
        record = read_data(self.folder/'data/vehicles'/(IDENTIFIER+'.js'))[1]
        self.assertEqual(record['compactDescriptor'], 'bGF0ZXN0')
        self.assertEqual(record['source'], 'battle')
        self.assertEqual(len(self.raw_requests()), 2, 'a replay must not append to the raw log')

    def test_setup_keeps_an_up_to_date_vehicle_and_still_flags_it(self):
        self.setup_exporter()
        self.export()
        rebuilt = self.setup_exporter(self.build())
        row = [v for v in rebuilt.catalogue_rows() if v['id'] == IDENTIFIER][0]
        self.assertTrue(row['exported'])
        with patch.object(ex, 'vehicle_descr', side_effect=AssertionError('must not rebuild')):
            self.assertFalse(rebuilt.export_vehicle(self.request))

    # --------------------------------------------------------------- the storage

    def test_prune_keeps_the_models_of_exported_vehicles(self):
        self.setup_exporter()
        self.export()
        part = read_data(self.folder/'data/vehicles'/(IDENTIFIER+'.js'))[1]['parts'][0]
        model = self.folder/'data/models'/(part['modelKey']+'.js')
        # The sweep runs only when asked for (write_index(prune=True), since 0.7.17: the index is
        # rewritten on every hit and the sweep is not needed there).
        self.exporter.write_index(prune=True)
        self.assertTrue(model.is_file())
        self.exporter.vehicles.clear()
        self.exporter.model_refs.clear()
        self.exporter.write_index(prune=True)
        self.assertFalse(model.is_file())

    def test_every_battle_is_kept(self):
        self.setup_exporter()
        for number in range(7):
            identifier = '%d-test' % number
            (self.folder/'battles'/(identifier+'.jsonl')).write_bytes(b'{}')
            self.exporter.publish({'schema':1, 'type':'battle', 'id':identifier, 'startedAt':number,
                                   'map':'Map', 'clientVersion':'version\n', 'hits':[]})
            self.exporter.write_index()
        index = read_data(self.folder/'data/index.js')[1]
        self.assertEqual(len(index['battles']), 7)
        self.assertEqual(len(list((self.folder/'data/battles').glob('*.js'))), 7)
        self.assertEqual(len(list((self.folder/'battles').glob('*.jsonl'))), 7)

    # -------------------------------------------------------------- the settings

    def test_settings_defaults_are_written_and_malformed_ones_ignored(self):
        self.setup_exporter()
        path = self.folder/'settings.json'
        self.assertEqual(json.loads(path.read_text(encoding='ascii')), {'exportAllVehicles':False})
        path.write_text('{ not json', encoding='ascii')
        self.assertEqual(self.build().load_settings(), {'exportAllVehicles':False})
        path.write_text('{"exportAllVehicles": true}', encoding='ascii')
        self.assertEqual(self.build().load_settings(), {'exportAllVehicles':True})

    def test_bulk_export_is_queued_by_the_setting_and_drained_on_idle(self):
        (self.folder/'settings.json').write_text('{"exportAllVehicles": true}', encoding='ascii')
        rows = [{'id':IDENTIFIER, 'type':TYPE, 'exported':False}]
        exporter = self.build()
        with patch.object(ex.Exporter, 'catalogue_rows', return_value=rows):
            self.setup_exporter(exporter)
        self.assertEqual(exporter.bulk, [TYPE])
        patches = self.client() + [patch.object(ex, 'top_descriptor', return_value=FakeDescriptor())]
        for item in patches: item.start()
        try:
            exporter.idle()
        finally:
            for item in patches: item.stop()
        self.assertEqual(exporter.bulk, [])
        record = read_data(self.folder/'data/vehicles'/(IDENTIFIER+'.js'))[1]
        self.assertEqual(record['source'], 'catalogue')
        self.assertEqual(record['compactDescriptor'], 'dG9w')
        self.assertEqual(self.raw_requests()[0]['source'], 'catalogue')

    def test_bulk_export_stays_off_by_default(self):
        rows = [{'id':IDENTIFIER, 'type':TYPE, 'exported':False}]
        exporter = self.build()
        with patch.object(ex.Exporter, 'catalogue_rows', return_value=rows):
            self.setup_exporter(exporter)
        self.assertEqual(exporter.bulk, [])

    def test_vehicle_id_is_safe_and_invalid_types_are_rejected(self):
        self.assertEqual(ex.vehicle_id('ussr:R45_IS-7'), 'ussr-R45_IS-7')
        self.assertEqual(ex.vehicle_id('germany:Pz.Kpfw. VI'), 'germany-Pz_Kpfw__VI')
        # A path can never come back out of an id: everything else is replaced.
        self.assertEqual(ex.vehicle_id('../escape:x'), '___escape-x')
        self.setup_exporter()
        for bad in ('', 'no-colon'):
            with self.assertRaises(ValueError):
                self.exporter.export_vehicle(dict(self.request, vehicleType=bad))


if __name__ == '__main__':
    unittest.main()
