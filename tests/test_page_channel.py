"""Spec C: the page -> mod command, the picker descriptor and the dispersion backfill.

The client is not here, so the pieces that need it are replaced: `web.web_client_api`
is a stand-in with the same three names the client exports (W2CSchema, Field,
createCommandHandler), and the items cache / descriptor helpers are patched. The
channel itself cannot be exercised outside the game; what is tested is that the
handler we register routes a page command to exactly one recorder request.
"""
import sys
import time
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

    def test_window_size_steps_on_the_users_screen(self):
        # BACKLOG 94 (12.11): his screen 2474 x 1354 at interface scale 1 (game.log 12.11). Step 1 is the size the window
        # always had (the log's 2276 x 1191); steps 2-3 leave the carousel's 122 / 234 strip free under a centred window.
        # The frame around the page is 79 high and 25 wide (lobby.swf / browserWindow.swf 2.4.1.1, 13.11): the whole window
        # at step 0 is the whole screen, frame included (on 1.09 the frame was guessed 48 x 16 and step 0 stuck out).
        sizes = presentation.window_sizes(2474.0, 1354.0, presentation.WINDOW_FRAME)
        self.assertEqual(presentation.WINDOW_FRAME, (79, 25))
        self.assertEqual(sizes, [(2449, 1275), (2276, 1191), (2276, 1015), (2276, 791), (1979, 704), (1682, 622), (1434, 541)])
        frame_h, frame_w = presentation.WINDOW_FRAME
        self.assertEqual((sizes[0][0] + frame_w, sizes[0][1] + frame_h), (2474, 1354))
        for step, strip in ((2, 122), (3, 234)):
            self.assertLessEqual(sizes[step][1] + frame_h + 2 * strip, 1354)
        # A small screen: no step under the readable minimum, no window (frame included) over the screen, none larger than
        # the one before.
        small = presentation.window_sizes(1280.0, 720.0, presentation.WINDOW_FRAME)
        self.assertTrue(all(w >= 960 and h >= 540 and w + frame_w <= 1280 and h + frame_h <= 720 for w, h in small))
        self.assertTrue(all(a[0] >= b[0] and a[1] >= b[1] for a, b in zip(small, small[1:])))

    def test_window_size_and_follow_commands_reach_presentation_only(self):
        handler = presentation.web_handlers()[0].handler
        steps = []
        with patch.object(presentation, 'set_window_step', steps.append):
            for step in (0, 6, 2, 7, -1, True, '3', None):
                handler(Command(action='windowSize', step=step), {})
        self.assertEqual((steps, self.calls), ([0, 6, 2], []))
        self.addCleanup(presentation.set_page_follows, False)
        with patch.object(presentation, 'window_open', lambda: True):
            handler(Command(action='follow', on=True), {})
            self.assertTrue(presentation.page_follows())
            handler(Command(action='follow', on='yes'), {})
            self.assertFalse(presentation.page_follows())
        handler(Command(action='follow', on=True), {})
        with patch.object(presentation, 'window_open', lambda: False):
            self.assertFalse(presentation.page_follows())

    def test_the_page_follows_a_change_of_the_hangar_vehicle_type_only_while_it_browses(self):
        # BACKLOG 94: g_currentVehicle.onChanged fires for the same vehicle too (modules, crew, a return from a preview);
        # only another TYPE is a choice in the carousel, and only a page browsing vehicles is pointed at it.
        opened, waited, requested = [], [], []
        recorder = types.SimpleNamespace(request_vehicle=lambda descr, source, fitted=None: requested.append((descr.type.name, source)),
                                         prioritise=lambda types_: waited.append(list(types_)))
        def vehicle(name):
            return types.SimpleNamespace(descriptor=types.SimpleNamespace(type=types.SimpleNamespace(name=name)))
        hangar = types.SimpleNamespace(item=vehicle('germany:G42_Maus'), isPresent=lambda: True)
        events = modmain.VehicleEvents(recorder)
        events.hangar = hangar
        follows = [True]
        with patch.dict(sys.modules, TOP_LEVEL), patch.object(modmain, '_recorder', recorder), \
                patch.object(presentation, 'page_follows', lambda: follows[0]), \
                patch.object(presentation, 'open_in_game', lambda path, fragment: opened.append(fragment)):
            events.on_hangar_vehicle()                       # the first vehicle seen: nothing to follow from
            events.on_hangar_vehicle()                       # the same vehicle again (its crew, a return from a preview)
            hangar.item = vehicle('ussr:R45_IS-7')
            events.on_hangar_vehicle()                       # another vehicle picked in the carousel
            events.on_hangar_vehicle()
            follows[0] = False                               # a battle on the page now
            hangar.item = vehicle('china:Ch67_BZ_79')
            events.on_hangar_vehicle()
            follows[0] = True
            hangar.item = vehicle('ussr:R45_IS-7')
            events.on_hangar_vehicle()                       # the same vehicle as the page's last: a new fragment all the same
        self.assertEqual(len(requested), 6)                  # every change still asks for its export, as before
        self.assertEqual(len(opened), 2)
        self.assertRegex(opened[0], r'^host=game&vehicle=ussr-R45_IS-7&follow=\d+$')
        self.assertRegex(opened[1], r'^host=game&vehicle=ussr-R45_IS-7&follow=\d+$')
        self.assertNotEqual(opened[0], opened[1])
        self.assertEqual(waited, [['ussr:R45_IS-7'], ['ussr:R45_IS-7']])

    def test_open_command_marks_the_page_open_for_the_ttx_sweep(self):
        # 24.09: the page, open in the game, says so every few seconds; the recorder holds it open for 12 s.
        opened = []
        presentation.set_open_request(lambda: opened.append(1))
        self.addCleanup(presentation.set_open_request, None)
        presentation.web_handlers()[0].handler(Command(action='open'), {})
        self.assertEqual((opened, self.calls), ([1], []))
        recorder = modmain.Recorder.__new__(modmain.Recorder)
        recorder.page_open_until, recorder.frames_wanted, recorder.frame_loop = 0.0, False, False
        with patch.object(modmain, '_recorder', recorder):
            modmain.page_open()
        self.assertAlmostEqual(recorder.page_open_until - time.time(), modmain.PAGE_OPEN_SECONDS, delta=1)
        with patch.object(modmain, '_recorder', None):
            modmain.page_open()

    def test_sweep_start_and_stop_reach_the_recorder_and_its_frames(self):
        # 24.09: Start and Stop of the characteristics sweep; Start begins the frame callback that paces its slices.
        asked = []
        presentation.set_sweep_request(lambda start, kind: asked.append((start, kind)))
        self.addCleanup(presentation.set_sweep_request, None)
        handler = presentation.web_handlers()[0].handler
        handler(Command(action='sweepStart'), {})
        handler(Command(action='sweepStop'), {})
        # 25.09: the model sweep is the same pair of commands with its kind; an unknown kind is refused.
        handler(Command(action='sweepStart', kind='models'), {})
        handler(Command(action='sweepStop', kind='models'), {})
        handler(Command(action='sweepStart', kind='other'), {})
        self.assertEqual((asked, self.calls), ([(True, 'ttx'), (False, 'ttx'), (True, 'models'), (False, 'models')], []))
        callbacks, exports = [], []
        bigworld = types.ModuleType('BigWorld')
        bigworld.callback = lambda delay, fn: callbacks.append(fn)
        recorder = modmain.Recorder.__new__(modmain.Recorder)
        recorder.page_open_until, recorder.frames_wanted, recorder.frame_loop = time.time() + 10, False, False
        recorder.frame_event = modmain.threading.Event()
        kinds = []
        recorder.writer = types.SimpleNamespace(put_export=lambda name, payload: exports.append(name) or kinds.append(payload))
        with patch.dict(sys.modules, {'BigWorld': bigworld}):
            with patch.object(modmain, '_recorder', recorder):
                modmain.page_sweep(True)
            self.assertEqual((exports, recorder.frames_wanted, recorder.frame_loop, len(callbacks)), (['sweepStart'], True, True, 1))
            callbacks.pop()()   # one frame: the event is set and the next frame asked for
            self.assertTrue(recorder.frame_event.is_set())
            self.assertEqual(len(callbacks), 1)
            recorder.note_page_open()   # the page's own signal while the chain runs starts no second chain
            self.assertEqual(len(callbacks), 1)
            with patch.object(modmain, '_recorder', recorder):
                modmain.page_sweep(False)
            callbacks.pop()()   # the chain ends on the next frame
            self.assertEqual((exports, recorder.frames_wanted, recorder.frame_loop, callbacks), (['sweepStart', 'sweepStop'], False, False, []))
            with patch.object(modmain, '_recorder', recorder):
                modmain.page_sweep(True, 'models')
            self.assertEqual((exports[-1], kinds), ('sweepStart', ['ttx', 'ttx', 'models']))


class TwoPagesOneChannelTests(unittest.TestCase):
    """Both pages - Viewer.html and the replay viewer's playback.html (19.11, 'one mod, two entries') - send through the one
    command 'bullba_hits': every action a page sends has one name in presentation.ACTIONS, and the handler answers each."""

    def sent_actions(self):
        import glob, os, re
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        found = {}
        for path in glob.glob(os.path.join(root, 'web', '*.js')) + glob.glob(os.path.join(root, 'web', 'playback', '*.js')):
            text = open(path, encoding='utf-8').read()
            for name in re.findall(r"sendCommand\('([A-Za-z]+)'", text) + re.findall(r"action:\s*'([A-Za-z]+)'", text):
                found.setdefault(name, set()).add(os.path.basename(path))
        return found

    def test_every_action_a_page_sends_is_one_known_name(self):
        self.assertEqual(len(presentation.ACTIONS), len(set(presentation.ACTIONS)))
        sent = self.sent_actions()
        self.assertTrue({'openReplays', 'replayFiles', 'playbackVehicles', 'openHits', 'playback', 'exportVehicle'} <= set(sent), sent)
        self.assertEqual(sorted(set(sent) - set(presentation.ACTIONS)), [])

    def test_the_handler_answers_every_known_action(self):
        import inspect
        source = inspect.getsource(presentation._handle_web_command)
        for name in presentation.ACTIONS: self.assertIn("'%s'" % name, source)

    def test_the_viewer_commands_reach_their_own_requests(self):
        windows, files, vehicles = [], [], []
        presentation.set_window_request(lambda window, battle, shot=None: windows.append((window, battle) if shot is None else (window, battle, shot)))
        presentation.set_files_request(lambda: files.append(True))
        presentation.set_vehicles_request(lambda battle, rows: vehicles.append((battle, rows)))
        self.addCleanup(presentation.set_window_request, None)
        self.addCleanup(presentation.set_files_request, None)
        self.addCleanup(presentation.set_vehicles_request, None)
        handler = presentation.web_handlers()[0].handler
        with patch.object(presentation, 'notify_page', lambda note: None):
            handler(Command(action='openReplays', battleId='f-0123456789abcdef'), {})
            handler(Command(action='openReplays', battleId='bad id!'), {})
            handler(Command(action='openHits'), {})
            # a row of the viewer's shots panel (19.11, BACKLOG 109): Hits' fragment of that shot; a bad value - Hits' window only
            handler(Command(action='openHits', battleId='2315856430906286521-d36eff9b31bb', at=1234.5, attacker=7, target=9, focus=7), {})
            handler(Command(action='openHits', battleId='2315856430906286521-d36eff9b31bb', at='x', attacker=7, target=9, focus=7), {})
            handler(Command(action='replayFiles'), {})
            handler(Command(action='playbackVehicles', battleId='f-0123456789abcdef',
                            vehicles=[{'type': 'usa:A83_T110E4', 'descr': 'AQIDBA=='}, {'type': 'bad'}, 'x']), {})
        self.assertEqual(windows, [(presentation.REPLAYS, 'f-0123456789abcdef'), (presentation.HITS, None),
                                   (presentation.HITS, None, 'host=game&battle=2315856430906286521-d36eff9b31bb&at=1234.500&attacker=7&target=9&focus=7'),
                                   (presentation.HITS, None)])
        self.assertEqual(files, [True])
        self.assertEqual(vehicles, [('f-0123456789abcdef', [('usa:A83_T110E4', 'AQIDBA==')])])
        self.assertEqual(self.calls if hasattr(self, 'calls') else [], [])

    def test_open_hits_takes_the_shot_from_the_games_custom_parameters(self):
        # 19.11, 1.13 in the game: the schema has no fields for at/attacker/target/focus, so the client's command carries
        # them as None attributes and hands the values over in `custom_parameters` - the shot was refused as "no shot"
        windows = []
        presentation.set_window_request(lambda window, battle, shot=None: windows.append((window, battle, shot)))
        self.addCleanup(presentation.set_window_request, None)
        game = Command(action='openHits', battleId='2315856430906286521-d36eff9b31bb', at=None, attacker=None, target=None, focus=None,
                       custom_parameters={'at': 1234.5, 'attacker': 7, 'target': 9, 'focus': 7})
        fragment = 'host=game&battle=2315856430906286521-d36eff9b31bb&at=1234.500&attacker=7&target=9&focus=7'
        self.assertEqual(presentation.shot_fragment('2315856430906286521-d36eff9b31bb', game), fragment)
        with patch.object(presentation, 'notify_page', lambda note: None):
            presentation.web_handlers()[0].handler(game, {})
        self.assertEqual(windows, [(presentation.HITS, None, fragment)])


class FullScreenTests(unittest.TestCase):
    """R5 (BACKLOG 110, 20.11.2026): the replay viewer's full-screen button in the game. The client's frameless view, its
    factory and event bus are stand-ins with the names presentation imports (read from the 2.4.1.1 bytecode); what is
    tested is the mod's side: the state the page sends, the view registered and opened with it, the window closed once
    the view stands, Esc and the page's button back to the window with the state, and every failure leaving the window
    with one log line. Whether the client draws the view is for the game to show."""

    def setUp(self):
        presentation._full.update({'class': None, 'registered': False, 'view': None, 'state': '', 'asked': None})
        self.addCleanup(presentation._full.update, {'class': None, 'registered': False, 'view': None, 'state': '', 'asked': None})
        saved = dict(presentation._viewer)
        self.addCleanup(presentation._viewer.update, saved)
        presentation._viewer.update({'path': '/game/mods/configs/local.armor_inspector/playback.html', 'browser_id': 77, 'trace': None})

    def client(self):
        """Stand-ins of the client's modules the full-screen path imports; returns what they record."""
        rec = {'settings': [], 'events': [], 'callbacks': [], 'destroyed': [], 'deleted': []}

        class WebView(object):
            def __init__(self, ctx=None): self.ctx = ctx
            def webHandlers(self): return ['wg']
            def getBrowser(self): return rec.setdefault('browser', types.SimpleNamespace())
            def _populate(self): rec['populated'] = True
            def _dispose(self): rec['disposed'] = True
            def destroy(self): rec['destroyed'].append(self); self._dispose()

        def module(name, **names):
            m = types.ModuleType(name); m.__dict__.update(names); return m
        factories = types.SimpleNamespace(addSettings=lambda s: rec['settings'].append(s))
        bus = types.SimpleNamespace(handleEvent=lambda e, scope=None: rec['events'].append((e, scope)))
        events = types.SimpleNamespace(LoadViewEvent=lambda params, ctx=None: {'params': params, 'ctx': ctx})
        mods = {}
        for name in ('gui', 'gui.Scaleform', 'gui.Scaleform.daapi', 'gui.Scaleform.daapi.view', 'gui.Scaleform.daapi.view.lobby',
                     'gui.Scaleform.daapi.view.lobby.shared', 'gui.Scaleform.daapi.view.lobby.hangar', 'gui.Scaleform.framework.managers',
                     'frameworks', 'helpers', 'skeletons', 'skeletons.gui'):
            mods[name] = module(name)
        mods['gui.Scaleform.daapi.view.lobby.shared.web_view'] = module('web_view', WebView=WebView)
        mods['gui.Scaleform.framework'] = module('framework', g_entitiesFactories=factories, ScopeTemplates=types.SimpleNamespace(LOBBY_SUB_SCOPE='lobbySub'),
                                                 ViewSettings=lambda *a: a)
        mods['frameworks.wulf'] = module('wulf', WindowLayer=types.SimpleNamespace(FULLSCREEN_WINDOW='fullscreen'))
        mods['gui.shared'] = module('shared', g_eventBus=bus, events=events, EVENT_BUS_SCOPE=types.SimpleNamespace(LOBBY='lobby'))
        mods['gui.Scaleform.framework.managers.loaders'] = module('loaders', SFViewLoadParams=lambda alias: ('params', alias))
        mods['gui.Scaleform.daapi.view.lobby.hangar.BrowserView'] = module('BrowserView', makeBrowserParams=lambda **k: dict(k))
        mods['BigWorld'] = module('BigWorld', callback=lambda delay, fn: rec['callbacks'].append((delay, fn)))
        mods['helpers.dependency'] = module('dependency', instance=lambda cls: types.SimpleNamespace(delBrowser=lambda i: rec['deleted'].append(i)))
        mods['helpers'].dependency = mods['helpers.dependency']
        mods['skeletons.gui.game_control'] = module('game_control', IBrowserController=object)
        patcher = patch.dict(sys.modules, mods)
        patcher.start(); self.addCleanup(patcher.stop)
        return rec

    def test_the_state_the_page_sends_is_read_only_as_its_own_fragment(self):
        good = 'battle=f-0123456789abcdef&at=123.45&cam=10.5,-3.25,800.00,0.6000,0.4200,35.00&speed=0.5&play=1&follow=7&panel=9'
        self.assertEqual(presentation.view_state(Command(state=good)), good)
        # the client hands a field the schema lacks in custom_parameters (as openHits' shot, 19.11)
        self.assertEqual(presentation.view_state(Command(state=None, custom_parameters={'state': good})), good)
        self.assertEqual(presentation.view_state(Command()), '')
        for bad in ('battle=x&host=evil', 'view=full&battle=x', 'battle=x#y', 'battle=<script>', 'a' * 601):
            self.assertIsNone(presentation.view_state(Command(state=bad)), bad)
        self.assertEqual(presentation.full_fragment(good, True), 'host=game&view=full&' + good)
        self.assertEqual(presentation.full_fragment('', False), 'host=game')

    def test_the_commands_reach_enter_and_leave_with_the_state(self):
        calls = []
        handler = presentation.web_handlers()[0].handler
        with patch.object(presentation, 'enter_fullscreen', lambda s: calls.append(('enter', s))), \
                patch.object(presentation, 'leave_fullscreen', lambda s, close=False: calls.append(('leave', s, close))):
            handler(Command(action='fullscreen', on=True, state='battle=b1&at=5.00'), {})
            handler(Command(action='fullscreen', on=False, state='battle=b1&at=6.00'), {})
            handler(Command(action='fullscreen', on=False, close=True), {})
            handler(Command(action='fullscreen', on=True, state='host=game'), {})       # refused: not the page's state
            handler(Command(action='viewState', state='battle=b1&at=7.00'), {})        # no view open: not kept
        self.assertEqual(calls, [('enter', 'battle=b1&at=5.00'), ('leave', 'battle=b1&at=6.00', False), ('leave', '', True)])
        self.assertEqual(presentation._full['state'], '')

    def test_outside_the_client_the_window_stays_and_one_line_says_why(self):
        closed = []
        with patch.object(presentation, 'close_viewer_window', lambda: closed.append(True)), \
                self.assertLogs('local.armor_inspector', level='WARNING') as logs:
            presentation.enter_fullscreen('battle=b1')
        self.assertEqual(len(logs.output), 1)
        self.assertIn('the window stays', logs.output[0])
        self.assertEqual((closed, presentation.fullscreen_open(), presentation._full['asked']), ([], False, None))

    def test_the_view_opens_with_the_state_then_the_window_closes_and_esc_brings_it_back(self):
        rec = self.client()
        window = types.SimpleNamespace(destroy=lambda: rec['destroyed'].append('window'))
        presentation._viewer['trace'] = types.SimpleNamespace(window=window)
        state = 'battle=f-0123456789abcdef&at=123.45&cam=1.00,2.00,3.00,0.6000,0.4200,35.00&speed=2&play=1'
        presentation.enter_fullscreen(state)
        # registered once under our alias: the client's frameless screen on the full-screen layer
        self.assertEqual(len(rec['settings']), 1)
        alias, cls, swf, layer, event, scope = rec['settings'][0]
        self.assertEqual((alias, swf, layer, event, scope), (presentation.FULLSCREEN_ALIAS, 'browserScreen.swf', 'fullscreen', None, 'lobbySub'))
        (load, scope), = rec['events']
        ctx = load['ctx']
        self.assertEqual((load['params'], scope), (('params', presentation.FULLSCREEN_ALIAS), 'lobby'))
        self.assertTrue(ctx['url'].startswith('file:///') and ctx['url'].endswith('playback.html#host=game&view=full&' + state), ctx['url'])
        self.assertEqual(ctx['browserParams'], {'isCloseBtnVisible': False, 'bgAlpha': 1.0})
        self.assertEqual((ctx['allowRightClick'], ctx['ignoreCtrlClick'], ctx['ignoreShiftClick'], ctx['forcedSkipEscape']), (True, False, False, False))
        self.assertEqual(rec['destroyed'], [])                     # the window stays until the view stands
        # the client makes the view: our page command is among its handlers, the window goes when it stands
        view = cls({'url': ctx['url']})
        handlers = view.webHandlers()
        self.assertEqual(handlers[0], 'wg')
        self.assertEqual([getattr(h, 'name', None) for h in handlers[1:]], [presentation.WEB_COMMAND])
        view._populate()
        self.assertTrue(presentation.fullscreen_open())
        self.assertEqual(rec['destroyed'], ['window'])
        # its browser shows (the client's callbackOnLoad): the middle button let through too, as in the window
        ctx['callbackOnLoad']()
        b = rec['browser']
        self.assertEqual((b.allowRightClick, b.allowMiddleClick, b.ignoreCtrlClick, b.ignoreShiftClick), (True, True, False, False))
        # its 10 s check finds it standing: no line
        delay, check = rec['callbacks'][0]
        self.assertEqual(delay, presentation.FULLSCREEN_WAIT)
        check()
        # the page tells its state while full screen; Esc (the view's own) opens the window on it and the view goes
        presentation.web_handlers()[0].handler(Command(action='viewState', state='battle=f-0123456789abcdef&at=200.00&play=0'), {})
        opened = []
        with patch.object(presentation, 'open_in_game', lambda path, fragment='host=game', window=presentation.HITS: opened.append((path, fragment, window))):
            view.onEscapePress()
        self.assertEqual(opened, [(presentation._viewer['path'], 'host=game&battle=f-0123456789abcdef&at=200.00&play=0', presentation.REPLAYS)])
        self.assertIn(view, rec['destroyed'])
        self.assertFalse(presentation.fullscreen_open())
        # a second leave (the page's Esc after the view's) does nothing
        with patch.object(presentation, 'open_in_game', lambda *a, **k: opened.append(a)):
            presentation.leave_fullscreen('battle=x')
        self.assertEqual(len(opened), 1)

    def test_the_page_close_button_closes_the_view_without_a_window(self):
        rec = self.client()
        presentation.enter_fullscreen('battle=b1')
        view = rec['settings'][0][1]({})
        view._populate()
        self.assertEqual(rec['deleted'], [77])                     # no trace window: the browser deleted by its id
        opened = []
        with patch.object(presentation, 'open_in_game', lambda *a, **k: opened.append(a)):
            presentation.web_handlers()[0].handler(Command(action='fullscreen', on=False, close=True), {})
        self.assertEqual((opened, presentation.fullscreen_open()), ([], False))
        self.assertIn(view, rec['destroyed'])

    def test_a_view_that_never_stands_leaves_the_window_and_one_line(self):
        rec = self.client()
        presentation.enter_fullscreen('battle=b1')
        with self.assertLogs('local.armor_inspector', level='WARNING') as logs:
            rec['callbacks'][0][1]()
        self.assertEqual(len(logs.output), 1)
        self.assertIn('did not open', logs.output[0])
        self.assertEqual((rec['destroyed'], rec['deleted']), ([], []))

    def test_a_refused_open_leaves_the_window_and_one_line(self):
        rec = self.client()
        def refuse(event, scope=None): raise RuntimeError('no such alias')
        sys.modules['gui.shared'].g_eventBus = types.SimpleNamespace(handleEvent=refuse)
        with self.assertLogs('local.armor_inspector', level='WARNING') as logs:
            presentation.enter_fullscreen('battle=b1')
        self.assertEqual(len(logs.output), 1)
        self.assertIn('RuntimeError: no such alias', logs.output[0])
        self.assertEqual((rec['callbacks'], rec['destroyed'], presentation.fullscreen_open()), ([], [], False))


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
        recorder = types.SimpleNamespace(request_vehicle=lambda descr, source, fitted=None: requests.append((descr, source)))
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
