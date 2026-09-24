"""Spec C: the page -> mod command, the picker descriptor and the dispersion backfill.

The client is not here, so the pieces that need it are replaced: `web.web_client_api`
is a stand-in with the same three names the client exports (W2CSchema, Field,
createCommandHandler), and the items cache / descriptor helpers are patched. The
channel itself cannot be exercised outside the game; what is tested is that the
handler we register routes a page command to exactly one recorder request.
"""
import sys
import types
import unittest
import urllib
import urllib.request
from unittest.mock import patch

# presentation.py is Python 2.7 source for the game; the one name Python 3 lacks is
# urllib.pathname2url, and it is only used to build a file: URL.
if not hasattr(urllib, 'pathname2url'):
    urllib.pathname2url = urllib.request.pathname2url


class _Field(object):
    def __init__(self, required=False, type=None, default=None):
        self.required, self.type, self.default = required, type, default


class _W2CSchema(object):
    pass


class _Handler(object):
    def __init__(self, name, schema, handler, finiHandler=None):
        self.name, self.schema, self.handler, self.finiHandler = name, schema, handler, finiHandler


def _install_client_api():
    """A stand-in for scripts/client/web/web_client_api: the three names we import."""
    web = sys.modules.setdefault('web', types.ModuleType('web'))
    api = types.ModuleType('web.web_client_api')
    api.W2CSchema, api.Field = _W2CSchema, _Field
    api.createCommandHandler = lambda name, schema, handler, fini=None: _Handler(name, schema, handler, fini)
    web.web_client_api = api
    sys.modules['web.web_client_api'] = api


_install_client_api()
import builtins
if not hasattr(builtins, 'basestring'):
    builtins.basestring = str                      # the schema declares Python 2 string fields

import mod.local_armor_inspector as package
from mod.local_armor_inspector import presentation
from mod.local_armor_inspector import exporter as ex
from mod import mod_local_armor_inspector as modmain

# Inside the game the mod folder is on sys.path, so the package is top-level and the lazy
# imports in the mod read 'local_armor_inspector.…'. Mirrored per test, never globally:
# tests.test_serverless checks that exact module name and must keep seeing its own import.
TOP_LEVEL = {'local_armor_inspector': package,
             'local_armor_inspector.exporter': ex,
             'local_armor_inspector.presentation': presentation}


class Command(object):
    """What instantiateCommand hands a handler: attributes, missing ones default to None."""

    def __init__(self, **fields):
        self.__dict__.update(fields)

    def __getattr__(self, name):
        return None


class WebCommandTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        presentation.set_export_request(lambda type_name: self.calls.append(type_name))
        self.addCleanup(presentation.set_export_request, None)

    def test_handler_is_registered_under_one_command_name(self):
        handlers = presentation.web_handlers()
        self.assertEqual(len(handlers), 1)
        self.assertEqual(handlers[0].name, presentation.WEB_COMMAND)
        self.assertEqual(handlers[0].name, 'bullba_hits')
        schema = handlers[0].schema
        self.assertTrue(issubclass(schema, _W2CSchema))
        self.assertTrue(schema.action.required)
        self.assertFalse(schema.vehicleType.required)

    def test_export_command_reaches_the_recorder_once(self):
        handler = presentation.web_handlers()[0]
        handler.handler(Command(action='exportVehicle', vehicleType='germany:G42_Maus'), {})
        self.assertEqual(self.calls, ['germany:G42_Maus'])

    def test_unknown_action_and_missing_type_do_nothing(self):
        handler = presentation.web_handlers()[0].handler
        handler(Command(action='doSomethingElse', vehicleType='germany:G42_Maus'), {})
        handler(Command(action='exportVehicle'), {})
        handler(Command(action='exportVehicle', vehicleType='not-a-type'), {})
        self.assertEqual(self.calls, [])

    def test_a_failing_handler_never_escapes_into_the_client(self):
        def boom(type_name):
            raise RuntimeError('export unavailable')
        presentation.set_export_request(boom)
        presentation.web_handlers()[0].handler(Command(action='exportVehicle', vehicleType='ussr:R45_IS-7'), {})

    def test_without_a_recorder_nothing_is_called(self):
        presentation.set_export_request(None)
        presentation.web_handlers()[0].handler(Command(action='exportVehicle', vehicleType='ussr:R45_IS-7'), {})
        self.assertEqual(self.calls, [])

    def test_ttx_command_reaches_its_own_request_only(self):
        # TTX panel (23.09): exportTtx asks for the characteristics file, never for the vehicle export.
        ttx = []
        presentation.set_ttx_request(lambda type_name: ttx.append(type_name))
        self.addCleanup(presentation.set_ttx_request, None)
        handler = presentation.web_handlers()[0].handler
        handler(Command(action='exportTtx', vehicleType='czech:Cz17_Vz_55'), {})
        handler(Command(action='exportTtx'), {})
        handler(Command(action='exportTtx', vehicleType='not-a-type'), {})
        self.assertEqual((ttx, self.calls), (['czech:Cz17_Vz_55'], []))
        requests = []
        recorder = types.SimpleNamespace(request_ttx=lambda type_name: requests.append(type_name))
        with patch.object(modmain, '_recorder', recorder):
            modmain.page_ttx('czech:Cz17_Vz_55')
        with patch.object(modmain, '_recorder', None):
            modmain.page_ttx('czech:Cz17_Vz_55')
        self.assertEqual(requests, ['czech:Cz17_Vz_55'])


class PickerDescriptorTests(unittest.TestCase):
    """The configuration chosen for a vehicle picked in the page's list."""

    def setUp(self):
        self.top = object()
        for item in (patch.dict(sys.modules, TOP_LEVEL),
                     patch.object(ex, 'top_descriptor', return_value=self.top)):
            item.start(); self.addCleanup(item.stop)

    def test_the_top_configuration_is_used_when_the_client_is_unreachable(self):
        # No `items` module here, so the hangar branch raises and is logged, not propagated.
        self.assertIs(modmain.picker_descriptor('germany:G42_Maus'), self.top)

    def test_export_picked_vehicle_makes_exactly_one_request_with_the_picker_source(self):
        requests = []
        recorder = types.SimpleNamespace(request_vehicle=lambda descr, source: requests.append((descr, source)))
        with patch.object(modmain, '_recorder', recorder):
            modmain.export_picked_vehicle('germany:G42_Maus')
        self.assertEqual(requests, [(self.top, 'picker')])

    def test_export_without_a_recorder_is_a_no_op(self):
        with patch.object(modmain, '_recorder', None):
            modmain.export_picked_vehicle('germany:G42_Maus')


class GunDispersionBackfillTests(unittest.TestCase):
    """Records older than 0.6.29 carry no gunDispersion; the descriptor still has it."""

    def descr(self, angle=0.0035):
        return types.SimpleNamespace(gun=types.SimpleNamespace(shotDispersionAngle=angle))

    def test_missing_dispersion_is_taken_from_the_compact_descriptor(self):
        vehicle = {'type': 'germany:G42_Maus', 'compactDescriptor': 'Y29tcGFjdA=='}
        with patch.object(ex, 'vehicle_descr', return_value=self.descr()):
            ex.fix_gun_dispersion(vehicle)
        self.assertAlmostEqual(vehicle['gunDispersion'], 0.0035)

    def test_a_recorded_dispersion_is_never_overwritten(self):
        vehicle = {'gunDispersion': 0.0041, 'compactDescriptor': 'Y29tcGFjdA=='}
        with patch.object(ex, 'vehicle_descr', return_value=self.descr(0.0035)):
            ex.fix_gun_dispersion(vehicle)
        self.assertAlmostEqual(vehicle['gunDispersion'], 0.0041)

    def test_without_a_descriptor_or_on_failure_nothing_is_invented(self):
        vehicle = {'type': 'germany:G42_Maus'}
        ex.fix_gun_dispersion(vehicle)
        self.assertNotIn('gunDispersion', vehicle)
        broken = {'compactDescriptor': 'Y29tcGFjdA=='}
        with patch.object(ex, 'vehicle_descr', side_effect=ValueError('no client')):
            ex.fix_gun_dispersion(broken)
        self.assertNotIn('gunDispersion', broken)

    def test_enrich_vehicle_backfills_it(self):
        vehicle = {'type': 'germany:G42_Maus', 'compactDescriptor': 'Y29tcGFjdA==',
                   'level': 10, 'class': 'heavyTank', 'role': 'role_HT_break', 'nation': 'germany',
                   'gunHeightFrom': 'ground'}
        with patch.object(ex, 'vehicle_descr', return_value=self.descr()):
            ex.enrich_vehicle(vehicle)
        self.assertAlmostEqual(vehicle['gunDispersion'], 0.0035)


if __name__ == '__main__':
    unittest.main()
