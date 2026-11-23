# -*- coding: utf-8 -*-
"""Local presentation helpers; no external browser, service or network request."""
from __future__ import absolute_import
import collections
import json
import logging
import math
import numbers
import os
import re
import time
from urllib import pathname2url

LOG = logging.getLogger('local.armor_inspector')
_limits = {}
_browser_id = None
WEB_COMMAND = 'bullba_hits'
# Two windows of one mod (19.11, the user's 'one mod, two entries'): Bullba Hits' own (Viewer.html; its browser id and
# trace are the module's _browser_id / _trace, as before) and the 3D replay viewer's (playback.html, 'Bullba Replays' -
# working name; _viewer). Each has its own browser id and trace, so opening one never re-navigates or closes the other.
HITS = 'hits'
REPLAYS = 'replays'
WINDOW_TITLES = {HITS: 'Bullba Hits', REPLAYS: 'Bullba Replays'}
_viewer = {'browser_id': None, 'trace': None}
# Every action of the page channel (both pages send through WEB_COMMAND): one name, one meaning. tests/test_page_channel.py
# checks that every action a page sends is here once and that _handle_web_command answers each.
ACTIONS = ('busy', 'sweepStart', 'sweepStop', 'open', 'windowSize', 'follow', 'prepareBattle', 'playback', 'mapRaw',
           'playbackReport', 'replayKeep', 'replayLimit', 'prioritise', 'exportTtx', 'exportVehicle',
           'openReplays', 'openHits', 'replayFiles', 'playbackVehicles', 'fullscreen', 'viewState')
_window_request = None
_files_request = None
_vehicles_request = None
_export_request = None
_busy_request = None
_prioritise_request = None
_ttx_request = None
_open_request = None
_sweep_request = None
_battle_request = None
_playback_request = None
_player_request = None
_replays_request = None
ARENA = re.compile(r'^[0-9a-z_]{1,80}\Z')
# The page's loading (the replay job waits for it): called with True when the window opens, False on its onLoadEnd, None
# when it is gone (Recorder.note_page_loading).
_load_listener = None
_warned = set()
# The page's window size step (BACKLOG 94): the page's Settings own it ('windowSize'); this is the session's copy of the
# last step the page told, so the next open of the window takes that size at once. None until a page said one.
_window_step = None
# Whether the page browses vehicles now ('follow', BACKLOG 94): only then does a change of the hangar's vehicle point
# the open window at it. A new window starts without it, until its page says.
_page_follows = False
BATTLE_ID = re.compile(r'^[-a-zA-Z0-9_]{1,100}\Z')


def descriptor_mode(descr):
    """The mode a descriptor of a vehicle built twice is in now (0 default, 1 siege; 0 for every other vehicle): the
    composite descriptor answers every attribute from that mode's descriptor, so whatever is read from it - the pitch
    limits here, a recorded vehicle's static half (Recorder.static_valid) - is that mode's."""
    try:
        return int(getattr(descr, 'vehicleMode', 0) or 0) if getattr(descr, 'hasSiegeMode', False) else 0
    except Exception:
        return 0


def gun_limits(descr, key=None):
    """The gun's pitch limits of one configuration: ~365 samples, one shared object.

    `key` are the compact descriptor bytes when the caller has already built them (the hit path
    does, right beside this call), so the descriptor is not packed twice for one hit.

    The table is returned as a records.PitchTable: hits reference it by the fingerprint of its
    contents instead of carrying 22 KB each, and the fingerprint is taken once per distinct
    table. The local variable is returned rather than `_limits[key]`, because the export thread
    calls this too and may clear the cache between the assignment and the return.

    The key is the compact descriptor AND the vehicle's mode (23.09, second modes M4): a vehicle built
    twice has two guns' limits - the Strv 103B -1..-1 degrees in travel, -4..+2 in siege - and a key
    without the mode froze the table on the mode seen first (record-format audit 2026-09-22 section 3).
    The gun's static angles (staticPitch / staticTurretYaw, radians, client sign) ride in the same
    table where the gun has them: the viewer holds such a turret and gun still, as the client's own
    armour view does, and the table travels by reference, so they cost nothing per hit.
    """
    if key is None:
        key = descr.makeCompactDescr()
    mode = descriptor_mode(descr)
    # ... AND the modifications installed on the descriptor (09.10, D-112): the compact descriptor does not pack them, and a
    # tier-XI skill tree widens the gun's limits (17 trees of client 2.4.0.2: a degree or two) - so two descriptors of one
    # compact descriptor, the bare one a record's fix_* rebuild and the one with the tree (a vehicle file; in a battle, two
    # players with different trees on the same vehicle), must not share a table, whichever came first.
    try:
        modifications = tuple(getattr(descr, 'modifications', None) or ())
    except Exception:
        modifications = ()
    key = (key, mode, modifications)
    table = _limits.get(key)
    if table is not None:
        return table
    from gun_rotation_shared import calcPitchLimitsFromDesc
    from .records import PitchTable
    pitch = float(descr.hull.turretPitches[0])
    joint = float(descr.turret.gunJointPitch)
    definition = descr.gun.pitchLimits
    angles = set(-math.pi + i * math.pi / 180 for i in range(361))
    for curve in ('minPitch', 'maxPitch'):
        for point in definition[curve]:
            yaw = (float(point[0]) + math.pi) % (math.pi * 2) - math.pi
            angles.add(yaw)
    samples = []
    for yaw in sorted(angles):
        lo, hi = calcPitchLimitsFromDesc(yaw, definition, pitch, joint)
        samples.append([yaw, float(lo), float(hi)])
    table = PitchTable({'samples':samples, 'hullTurretPitch':pitch, 'gunJointPitch':joint,
                        'source':'client calcPitchLimitsFromDesc; knots and 1 degree samples'})
    for name in ('staticPitch', 'staticTurretYaw'):
        try:
            value = getattr(descr.gun, name, None)
            if value is not None: table[name] = float(value)
        except Exception:
            pass
    if len(_limits) > 64:
        _limits.clear()
    _limits[key] = table
    return table


def set_export_request(handler):
    """The mod hands the page command its one action: export this vehicle type now."""
    global _export_request
    _export_request = handler


def set_busy_request(handler):
    """The page reports that the user is working in it, so the mod holds its work back."""
    global _busy_request
    _busy_request = handler


def set_prioritise_request(handler):
    """The page names the vehicle types whose collision models it is waiting for."""
    global _prioritise_request
    _prioritise_request = handler


def set_battle_request(handler):
    """The page opened a saved battle whose file is stale ('prepareBattle', BACKLOG 55): the mod prepares that battle."""
    global _battle_request
    _battle_request = handler


def set_playback_request(handler):
    """The page opened a battle in the 3D replay player ('playback', BACKLOG 104): the mod makes that battle's file."""
    global _playback_request
    _playback_request = handler


def set_player_request(handler):
    """The 3D replay player's other commands (19.11): handler(kind, payload) - 'mapraw' (a map's raw files, the page's
    IndexedDB lacking the map) and 'playbackReport' (the page's one report of an opening: the mod's log line)."""
    global _player_request
    _player_request = handler


def notify_page(note):
    """Any thread: a note of the export thread for the open player page. Nothing is sent: the client of 2.4.1.1 has no
    call that runs a script in a page (WebBrowser.executeJavascript names a native method the exe lacks - 19.11), so
    the page learns of a finished job by looking at the file every 0.25 s. Kept as the one hook a later channel plugs into."""


def set_window_request(handler):
    """The pages' 'openReplays' (Hits' 3D control: the replay viewer's window on a battle, `battleId`) and 'openHits' (the
    viewer's back control: Hits' window; with `battleId`, `at`, `attacker`, `target`, `focus` - a row of its shots panel,
    19.11 - one shot): handler(window, battle id or None[, Hits' fragment of the shot][, the viewer's shot - 'openReplays'
    from one hit of Hits, 21.11 BACKLOG 118: viewer_shot]), on the game thread."""
    global _window_request
    _window_request = handler


def shot_fragment(battle_id, command):
    """The fragment of Hits' page for one shot of the viewer's shots panel (BACKLOG 109): 'host=game&battle=<id>&at=
    <gameTime>&attacker=<id>&target=<id>&focus=<id>' (web/app.js openShot), or None when a value is not a number."""
    # In the game the schema has no fields for these four, so the client hands them over in the command's
    # `custom_parameters` (seen 19.11, 1.13: the shot was refused as "no shot"); a test's plain object has attributes.
    extra = getattr(command, 'custom_parameters', None)
    if not isinstance(extra, dict): extra = {}
    def value(name):
        v = getattr(command, name, None)
        return extra.get(name) if v is None else v
    try:
        at = float(value('at'))
        ids = [int(value(k)) for k in ('attacker', 'target', 'focus')]
    except (TypeError, ValueError):
        _warn_once('open-shot', 'Bullba Hits page command: no shot in %r', getattr(command, '__dict__', command))
        return None
    if at != at or at in (float('inf'), float('-inf')): return None
    fragment = 'host=game&battle=%s&at=%.3f&attacker=%d&target=%d&focus=%d' % ((str(battle_id), at) + tuple(ids))
    shot_id = command_value(command, 'shotId')
    if shot_id is not None and re.match(r'^\d+$', str(shot_id)): fragment += '&shotId=' + str(shot_id)
    return fragment


def viewer_shot(command):
    """The replay viewer's 'shot' value for one hit of Hits ('openReplays' with `at` - the hit's gameTime -, `attacker`,
    `target`, `focus`; 21.11, BACKLOG 118): '<at>,<attacker>,<target>,<focus>' (web/playback/playback.js openShotParam),
    or None when the command carries no shot (a battle row's link) or a value is not a number."""
    if command_value(command, 'at') is None: return None
    try:
        at = float(command_value(command, 'at'))
        ids = [int(command_value(command, k)) for k in ('attacker', 'target', 'focus')]
    except (TypeError, ValueError):
        _warn_once('open-viewer-shot', 'Bullba Hits page command: no shot in %r', getattr(command, '__dict__', command))
        return None
    if at != at or at in (float('inf'), float('-inf')): return None
    route = '%.3f,%d,%d,%d' % ((at,) + tuple(ids))
    shot_id, index = command_value(command, 'shotId'), command_value(command, 'shotIndex')
    if shot_id is not None and not re.match(r'^\d+$', str(shot_id)): return None
    if index is not None and not re.match(r'^\d+$', str(index)): return None
    if shot_id is not None or index is not None: route += ',' + (str(shot_id) if shot_id is not None else '')
    if index is not None: route += ',' + str(index)
    return route


def set_files_request(handler):
    """The viewer's 'replayFiles': the list of replay files (data/replay-files.js) read again; handler()."""
    global _files_request
    _files_request = handler


def set_vehicles_request(handler):
    """The viewer's 'playbackVehicles' (19.11): the vehicle types of a battle that have no vehicle file, with the compact
    descriptor the page decoded from the replay; handler(battle id, [(type, compact descriptor or None)])."""
    global _vehicles_request
    _vehicles_request = handler


VEHICLE_TYPE = re.compile(r'^[a-z]+:[-A-Za-z0-9_.]{1,80}\Z')
DESCRIPTOR = re.compile(r'^[A-Za-z0-9+/=]{4,400}\Z')


def set_replays_request(handler):
    """The page's word on the mod's replay folder (BACKLOG 107): 'replayKeep' (a battle's replay kept forever or put back
    under the limit) and 'replayLimit' (how many replays are kept); the handler gets one dict."""
    global _replays_request
    _replays_request = handler


def set_ttx_request(handler):
    """The page asks for the characteristics file of one vehicle type (data/ttx/<id>.js)."""
    global _ttx_request
    _ttx_request = handler


def set_load_listener(handler):
    """Told when the page starts loading (True), has loaded (False) or its window is gone (None): the replay job waits."""
    global _load_listener
    _load_listener = handler


def page_loading(state):
    """The page's loading state to its listener; never raises into the client's event."""
    listener = _load_listener
    if listener is None: return
    try: listener(state)
    except Exception: LOG.debug('Bullba Hits page loading state not noted', exc_info=True)


def set_open_request(handler):
    """The page says it is open in the game (every few seconds while it is): the TTX sweep may go fast."""
    global _open_request
    _open_request = handler


def set_sweep_request(handler):
    """The page's Start (True) or Stop (False) of a sweep: handler(start, kind), kind 'ttx' (the characteristics of
    this client version) or 'models' (the collision models of every regular vehicle)."""
    global _sweep_request
    _sweep_request = handler


def _warn_once(key, message, *args):
    """A page command that keeps failing must not fill game.log line by line.

    'busy' arrives once a second while the user drags the scene, so a warning for
    every one of them would be noise, not a diagnosis.
    """
    if key in _warned:
        return
    _warned.add(key)
    LOG.warning(message, *args)


def _handle_web_command(command, ctx):
    """One w2c command from the page, on the game thread. Only the request is done here.

    Fire-and-forget actions: 'exportVehicle' asks for one vehicle type,
    'exportTtx' for the characteristics file of one type (no collision models),
    'busy' says the user is dragging or zooming the page right now,
    'prioritise' names the vehicle types whose collision models the page is
    waiting for, 'open' says the page is open (a sweep may run) and
    'sweepStart'/'sweepStop' are the user's Start and Stop of a sweep, its
    'kind' - 'ttx' when absent, or 'models' - and 'prepareBattle' names the saved
    battle the page opened whose file is stale ('battleId'), 'windowSize' is the
    step of the window's size the page's Settings hold ('step', BACKLOG 94),
    'follow' says whether the page browses vehicles now ('on'), 'playback' names
    the battle the page's 3D replay player opened ('battleId', BACKLOG 104),
    'replayKeep' keeps a battle's replay forever or not ('battleId', 'keep') and
    'replayLimit' is the replay limit's mode: on or off ('on') and how many replays ('limit', BACKLOG 107);
    'mapRaw' asks for a map's raw files ('arena', 'held', 'resv', 'whole') and 'playbackReport' brings the player's
    report of an opening ('report') - both the 3D replay player's (19.11), answered through notify_page.
    None of them may cost the game thread more than a flag (a resize goes out on the next tick).
    """
    try:
        action = getattr(command, 'action', None)
        if action == 'busy':
            if _busy_request is None:
                _warn_once('busy', 'Bullba Hits page command: the recorder is not running')
                return
            _busy_request()
            return
        if action in ('sweepStart', 'sweepStop'):
            if _sweep_request is None:
                _warn_once('sweep', 'Bullba Hits page command: the recorder is not running')
                return
            kind = getattr(command, 'kind', None) or 'ttx'
            if kind not in ('ttx', 'models'):
                _warn_once('sweep-kind', 'Bullba Hits page command: unknown sweep %r', kind)
                return
            LOG.info('Bullba Hits page command: %s sweep %s', kind, 'started' if action == 'sweepStart' else 'stopped')
            _sweep_request(action == 'sweepStart', str(kind))
            return
        if action == 'open':
            if _open_request is None:
                _warn_once('open', 'Bullba Hits page command: the recorder is not running')
                return
            _open_request()
            return
        if action == 'windowSize':
            step = getattr(command, 'step', None)
            if isinstance(step, bool) or not isinstance(step, numbers.Integral) or not 0 <= step < WINDOW_STEPS:
                _warn_once('window-step', 'Bullba Hits page command: no window size step in %r', step)
                return
            set_window_step(int(step))
            return
        if action == 'follow':
            set_page_follows(getattr(command, 'on', None) is True)
            return
        if action == 'prepareBattle':
            battle_id = getattr(command, 'battleId', None)
            if not battle_id or not BATTLE_ID.match(str(battle_id)):
                _warn_once('battle-id', 'Bullba Hits page command: no battle id in %r', battle_id)
                return
            if _battle_request is None:
                _warn_once('battle', 'Bullba Hits page command: the recorder is not running')
                return
            _battle_request(str(battle_id))
            return
        if action == 'playback':
            battle_id = getattr(command, 'battleId', None)
            if not battle_id or not BATTLE_ID.match(str(battle_id)):
                _warn_once('playback-id', 'Bullba Hits page command: no battle id in %r', battle_id)
                return
            if _playback_request is None:
                _warn_once('playback', 'Bullba Hits page command: the recorder is not running')
                return
            _playback_request(str(battle_id))
            return
        if action in ('mapRaw', 'playbackReport'):
            if _player_request is None:
                _warn_once('player', 'Bullba Hits page command: the recorder is not running')
                return
            if action == 'mapRaw':
                arena, held, resv = getattr(command, 'arena', None), getattr(command, 'held', None), getattr(command, 'resv', None)
                if not arena or not ARENA.match(str(arena)):
                    _warn_once('map-arena', 'Bullba Hits page command: no arena in %r', arena)
                    return
                _player_request('mapraw', {'arena': str(arena), 'held': str(held) if held else None,
                                           'resv': str(resv)[:16] if resv else None, 'whole': getattr(command, 'whole', None) is True})
                return
            report = getattr(command, 'report', None)
            if not isinstance(report, dict):
                _warn_once('report', 'Bullba Hits page command: no report in %r', report)
                return
            _player_request('playbackReport', dict((str(k), v) for k, v in list(report.items())[:40]))
            return
        if action in ('fullscreen', 'viewState'):
            # R5 (BACKLOG 110, 20.11): the replay viewer's full-screen button ('on', 'close') and, while it is full screen,
            # its state every few seconds - for the view's own Esc
            state = view_state(command)
            if state is None:
                _warn_once('view-state', 'Bullba Replays page command: no view state in %r', getattr(command, 'state', None))
                return
            if action == 'viewState':
                if fullscreen_open(): _full['state'] = state
                return
            if command_value(command, 'on') is True: enter_fullscreen(state)
            else: leave_fullscreen(state, close=command_value(command, 'close') is True)
            return
        if action in ('openReplays', 'openHits'):
            battle_id = getattr(command, 'battleId', None)
            if battle_id is not None and not BATTLE_ID.match(str(battle_id)):
                _warn_once('open-window-id', 'Bullba Hits page command: no battle id in %r', battle_id)
                return
            if _window_request is None:
                _warn_once('open-window', 'Bullba Hits page command: the recorder is not running')
                return
            if action == 'openHits':
                # 19.11 (BACKLOG 109): the viewer's shots panel - one shot of a battle in Hits' window
                # 21.11 (BACKLOG 118): the viewer's back control with its battle and no shot - Hits on that battle
                if battle_id is not None and command_value(command, 'at') is None: shot = 'host=game&battle=%s' % battle_id
                else: shot = shot_fragment(battle_id, command) if battle_id is not None else None
                if shot is not None: _window_request(HITS, None, shot)
                else: _window_request(HITS, None)
                return
            # 21.11 (BACKLOG 118): Hits' link of one hit - the viewer opens on that shot (its shot view), the state's 'shot'
            shot = viewer_shot(command) if battle_id is not None else None
            if shot is not None: _window_request(REPLAYS, str(battle_id), None, shot)
            else: _window_request(REPLAYS, str(battle_id) if battle_id else None)
            return
        if action == 'replayFiles':
            if _files_request is None:
                _warn_once('replay-files', 'Bullba Hits page command: the recorder is not running')
                return
            _files_request()
            return
        if action == 'playbackVehicles':
            battle_id, rows = getattr(command, 'battleId', None), getattr(command, 'vehicles', None)
            if not battle_id or not BATTLE_ID.match(str(battle_id)) or not isinstance(rows, (list, tuple)):
                _warn_once('pb-vehicles', 'Bullba Hits page command: no battle or vehicles in %r', battle_id)
                return
            wanted = []
            for row in list(rows)[:1000]:
                if not isinstance(row, dict): continue
                kind, descr = row.get('type'), row.get('descr')
                if kind and VEHICLE_TYPE.match(str(kind)) and (descr is None or DESCRIPTOR.match(str(descr))):
                    wanted.append((str(kind), str(descr) if descr else None))
            if _vehicles_request is None:
                _warn_once('pb-vehicles-off', 'Bullba Hits page command: the recorder is not running')
                return
            _vehicles_request(str(battle_id), wanted)
            return
        if action in ('replayKeep', 'replayLimit'):
            if _replays_request is None:
                _warn_once('replays', 'Bullba Hits page command: the recorder is not running')
                return
            if action == 'replayKeep':
                battle_id, keep = getattr(command, 'battleId', None), getattr(command, 'keep', None)
                if not battle_id or not BATTLE_ID.match(str(battle_id)) or not isinstance(keep, bool):
                    _warn_once('replay-keep', 'Bullba Hits page command: no battle id or keep in %r %r', battle_id, keep)
                    return
                _replays_request({'action': 'keep', 'battleId': str(battle_id), 'keep': keep})
                return
            limit, on = getattr(command, 'limit', None), getattr(command, 'on', None)
            if (isinstance(limit, bool) or not isinstance(limit, numbers.Integral) or not 1 <= limit <= 100
                    or not isinstance(on, bool)):
                _warn_once('replay-limit', 'Bullba Hits page command: no replay limit in %r %r', on, limit)
                return
            _replays_request({'action': 'limit', 'on': on, 'limit': int(limit)})
            return
        if action == 'prioritise':
            types = getattr(command, 'vehicleTypes', None)
            if not isinstance(types, (list, tuple)) or not types:
                _warn_once('prioritise-empty', 'Bullba Hits page command: no vehicle types in %r', types)
                return
            if _prioritise_request is None:
                _warn_once('prioritise', 'Bullba Hits page command: the recorder is not running')
                return
            _prioritise_request([str(name) for name in list(types)[:8] if name])
            return
        if action == 'exportTtx':
            type_name = getattr(command, 'vehicleType', None)
            if not type_name or ':' not in str(type_name):
                _warn_once('ttx-type', 'Bullba Hits page command: no vehicle type in %r', type_name)
                return
            if _ttx_request is None:
                _warn_once('ttx', 'Bullba Hits page command: the recorder is not running')
                return
            _ttx_request(str(type_name))
            return
        if action != 'exportVehicle':
            LOG.warning('Bullba Hits page command: unknown action %r', action)
            return
        type_name = getattr(command, 'vehicleType', None)
        if not type_name or ':' not in str(type_name):
            LOG.warning('Bullba Hits page command: no vehicle type in %r', type_name)
            return
        if _export_request is None:
            LOG.warning('Bullba Hits page command: the recorder is not running')
            return
        LOG.info('Bullba Hits page command: export %s', type_name)
        _export_request(str(type_name))
    except Exception:
        LOG.exception('Bullba Hits page command failed')


def web_handlers():
    """The client's own page -> Python channel, registered for our window only.

    Every link of the chain was read in the installed 2.4.0.0 bytecode/binaries (unchanged in 2.4.0.1):
      * cef_browser_process.exe registers the CEF message-router JS functions
        'jsHostQuery' / 'jsHostQueryCancel' (both strings sit next to
        browser_process\\cef_handler.cpp and "Failed to handle jsHostQuery
        request. Browser's view wasn't found."), so a page calls
        window.jsHostQuery({request: '<json>', onSuccess, onFailure});
      * WorldOfTanks.exe: PyWebBrowserProvider::onJsHostQuery calls
        script.onJsHostQuery(command); WebBrowser.create sets
        self.__browser.script = EventListener and subscribes
        EventListener.onJsHostQuery -> WebBrowser.__onJsHostQuery ->
        WebBrowser.onJsHostQuery (an Event);
      * gui/Scaleform/daapi/view/lobby/Browser.__prepareBrowser subscribes
        Browser.__onJsHostQuery, which calls
        BrowserViewWebHandlers.handleCommand -> WebCommandHandler.handleCommand:
        json.loads(data) -> WebCommandSchema(command, params, web_id) ->
        handleWebCommand -> self.__handlers[command].handler(cmd, ctx);
      * that handler dict is filled by WebCommandHandler.addHandlers(webHandlersMap),
        and webHandlersMap is exactly the 'handlers' argument of
        BrowserController.load: load() stores it in ctx['handlers'],
        BrowserWindow.__init__ keeps ctx['handlers'] and
        _onRegisterFlashComponent calls viewPy.init(browserID, handlers, alias)
        on VIEW_ALIAS.BROWSER.
    So passing handlers=[...] to load() is the client's supported way for a mod
    to register its own w2c command; nothing here is invented or patched.
    """
    try:
        from web.web_client_api import W2CSchema, Field, createCommandHandler
    except Exception:
        LOG.exception('Web command API unavailable; the in-game window opens without the export channel')
        return []
    try:
        class BullbaHitsSchema(W2CSchema):
            action = Field(required=True, type=basestring)
            vehicleType = Field(type=basestring)
            # 'prioritise' carries a short list of client vehicle type names. The
            # client's own WebCommandSchema declares a dict field the same way, so
            # a JSON array is an ordinary field type here, not a special case.
            vehicleTypes = Field(type=list)
            # 'sweepStart'/'sweepStop': which sweep ('ttx' when absent, 'models').
            kind = Field(type=basestring)
            # 'prepareBattle': the saved battle the page opened (BACKLOG 55); 'playback': the battle its 3D replay
            # player opened (BACKLOG 104).
            battleId = Field(type=basestring)
            # 'windowSize': the step of the window's size (0 full screen .. WINDOW_STEPS - 1); 'follow': whether the page
            # browses vehicles, so the hangar's choice may point it at another (BACKLOG 94).
            step = Field(type=int)
            on = Field(type=bool)
            # 'replayKeep': keep the battle's replay forever (True) or put it back under the limit; 'replayLimit': the
            # replay limit on or off ('on', above) and how many replays it keeps (BACKLOG 107).
            keep = Field(type=bool)
            limit = Field(type=int)
            # 'mapRaw' (19.11): the map whose raw files the player's builder needs, the FNV-1a hashes of the products its
            # IndexedDB holds (base64 of u32 LE) and their version, whether to copy all of it; 'playbackReport': the
            # page's one report of an opening (an object of plain values).
            arena = Field(type=basestring)
            held = Field(type=basestring)
            resv = Field(type=basestring)
            whole = Field(type=bool)
            report = Field(type=dict)
            # 'playbackVehicles' (19.11): [{type, descr}] - the battle's types with no vehicle file and their descriptors.
            vehicles = Field(type=list)
            # 'fullscreen' / 'viewState' (20.11, BACKLOG 110): the replay viewer's state as its fragment, and 'close'
            state = Field(type=basestring)
            close = Field(type=bool)
        return [createCommandHandler(WEB_COMMAND, BullbaHitsSchema, _handle_web_command, None)]
    except Exception:
        LOG.exception('Bullba Hits page command could not be registered')
        return []


# ---- the window's size, by steps (BACKLOG 94, user 12.11) ----------------------------------------------------------
# Everything here is in Flash units, the units the window is laid out in: one screen pixel at interface scale 1, `scale`
# pixels at another (GUI.screenResolution is in pixels and the client divides by the scale for its Flash positions -
# WoT-Base KNOWLEDGE-client, the crosshair's position; checked). The steps, from the largest: 0 the whole screen; 1 the
# size the window always had (92 % x 88 %); 2 and 3 the hangar's vehicle carousel left free - the client centres the
# window (BrowserWindow.updatePosition), so the strip at the bottom is free when window <= screen - 2 x strip; then three
# smaller ones that narrow the window too. Steps 1-3 keep the width: the carousel needs height only.
WINDOW_STEPS = 7
WINDOW_STEP_DEFAULT = 1
# The carousel's strip from the bottom edge: 122 for one row or a small double row, 234 for two big rows (TankCarousel,
# client 2.4.1.1 bytecode; outputs/browser-window-abilities-2026-11-12.md section 6). Checked.
CAROUSEL_STRIPS = (122, 234)
# The window's frame around the page, height and width, READ from the client 2.4.1.1 (lobby.swf bytecode and
# browserWindow.swf art; outputs/browser-window-abilities-2026-11-12.md section 4), not measured in the game: the frame is the content plus
# Window.contentPadding (top 35, bottom -6 set by BrowserWindow.onPopulate, left 12, right 13), and the content is the page
# plus the close button's row (ButtonBlack, 22 high, + 5) and the hidden action button above it (y -23). The frame the
# window really has is read back after every size change (WindowTrace.settle_size, as_getGeometryS) and used instead.
WINDOW_FRAME = (79, 25)
# What a frame read back may be, (height, width) from - to: at least the frame's padding (29 x 25, read), at most 40 over
# WINDOW_FRAME. Anything else is a frame that did not take the new size (it keeps the old one around a smaller page, or is
# smaller than a larger page): it is written as such and the numbers in use stay.
WINDOW_FRAME_LIMITS = ((29, 119), (25, 65))
# The frame read back from the open window this session (height, width), None until one was read.
_frame_seen = None
# Seconds after a size change before the window's place is read back: Flash draws the change on its next frames.
WINDOW_SETTLE = 0.3
# NOT READ - AN ESTIMATE: the carousel's art above its background and its hover mask (12 in the client's code), kept free too.
CAROUSEL_MARGIN = 16
# The smallest page kept readable (a choice): the page's layout is checked down to 1024 wide (tests/page/real_page.cjs
# topBand), and 540 high still holds the scene and its toolbar.
WINDOW_MIN = (960, 540)
# The smaller steps below the carousel ones: share of the screen's width and the most of its height.
WINDOW_SMALL = ((.80, .52), (.68, .46), (.58, .40))


def interface_scale():
    """The client's interface scale (1.0 at 100 %): settingsCore.interfaceScale.get() - InterfaceScaleManager.get, its
    names read in the 2.4.1.1 bytecode. 1.0 when it cannot be read."""
    try:
        from helpers import dependency
        from skeletons.account_helpers.settings_core import ISettingsCore
        scale = float(dependency.instance(ISettingsCore).interfaceScale.get())
        return scale if 0.5 <= scale <= 4 else 1.0
    except Exception:
        return 1.0


def stage_size():
    """(width, height, scale): the game's screen in Flash units - the smaller of GUI.screenResolution and
    BigWorld.screenSize (what the open always took), divided by the interface scale - and that scale."""
    import GUI
    width, height = GUI.screenResolution()
    try:
        import BigWorld as _bw
        client_w, client_h = _bw.screenSize()
        width, height = min(width, int(client_w)), min(height, int(client_h))
    except Exception:
        pass
    scale = interface_scale()
    return float(width) / scale, float(height) / scale, scale


def window_frame():
    """The window's frame around the page (height, width) in Flash units: the one read back from the open window this
    session, else the one read from the client's Flash (WINDOW_FRAME)."""
    return _frame_seen or WINDOW_FRAME


def window_sizes(width, height, frame=None):
    """The page's size at each step, from the largest, for a screen of width x height Flash units: WINDOW_STEPS pairs,
    none larger than the one before it, none smaller than WINDOW_MIN (unless the screen itself is); the window with its
    frame never over the screen."""
    frame_h, frame_w = frame or window_frame()
    usual = (int(width * .92), int(height * .88))
    rows = [(int(width - frame_w), int(height - frame_h)), usual]
    for strip in CAROUSEL_STRIPS:
        rows.append((usual[0], min(rows[-1][1], int(height - 2 * strip - frame_h - CAROUSEL_MARGIN))))
    for share_w, share_h in WINDOW_SMALL:
        rows.append((int(width * share_w), min(rows[-1][1], int(height * share_h))))
    top_w, top_h = int(width - frame_w), int(height - frame_h)
    low_w, low_h = min(WINDOW_MIN[0], top_w), min(WINDOW_MIN[1], top_h)
    out = []
    for w, h in rows:
        w, h = max(low_w, min(w, top_w)), max(low_h, min(h, top_h))
        if out: w, h = min(w, out[-1][0]), min(h, out[-1][1])
        out.append((w, h))
    return out


def window_size(step):
    """The page's size at this step on the screen of now, in Flash units."""
    width, height, scale = stage_size()
    return window_sizes(width, height)[max(0, min(WINDOW_STEPS - 1, int(step)))]


def window_id(window=HITS):
    """The browser id of one of the mod's windows (None before its first open)."""
    return _browser_id if window == HITS else _viewer['browser_id']


def window_trace(window=HITS):
    return _trace if window == HITS else _viewer['trace']


def window_open(window=HITS):
    """True while that window of the mod is open: the controller still knows its browser."""
    browser_id = window_id(window)
    if browser_id is None: return False
    try:
        from helpers import dependency
        from skeletons.gui.game_control import IBrowserController
        return dependency.instance(IBrowserController).getBrowser(browser_id) is not None
    except Exception:
        return False


def set_window_step(step):
    """The page's step of the window's size (its Settings own it): kept for the next open, and the open window takes it
    now (WindowTrace.resize) unless it already has it."""
    global _window_step
    _window_step = step
    trace = _trace
    if trace is None or trace.closed or not window_open(): return
    if trace.step == step: return
    trace.resize(step)


def set_page_follows(on):
    """The page says whether it browses vehicles now: only then does the hangar's choice point it at another."""
    global _page_follows
    if on != _page_follows: LOG.info('Bullba Hits page %s the hangar vehicle', 'follows' if on else 'does not follow')
    _page_follows = on


def page_follows():
    """True when the window is open and its page browses vehicles (BACKLOG 94)."""
    return _page_follows and window_open()


# The mod's own requests to draw the window again, per page of a window: a bound, in case a redraw makes the engine
# report the texture again (not seen; the count of 'redraw asked' lines of one open would show it).
TRACE_REDRAWS = 8
# How long the Browser view's class init may stay wrapped while a window's Flash component has not registered: the 20 s
# of open_in_game's own check that the window opened.
TRACE_VIEW_WAIT = 20
# After the last report of the page's load or of its texture the redraw is asked for twice more, at these seconds: the
# first scene's shaders hold the page for about two seconds on a first open, and a frame lost then has no other request.
TRACE_REDRAW_LATER = (1.0, 3.0)
_trace = None


class WindowTrace(object):
    """The mod's own window as the client reports it to Python, one game.log line per step (blue window, 03.10).

    The user's window sometimes opened blank while the page in it ran - its scripts, the scene, his mouse - and game.log
    held nothing that told such an open from a working one (outputs/blue-window-2026-10-03.md). The picture travels
    browser frame -> engine texture -> the Flash component's bitmap, and this follows the part of that road Python sees:
      * the WebBrowser's own events (WebBrowser.pyc): onReady, onLoadStart, onLoadEnd, onResized, onTextureStateChanged;
      * the two calls the Flash component makes through this very WebBrowser object: updateSize (the size it sends to
        the engine) and invalidateView (the client's own request to draw again, sent when the window is placed);
      * what the client's Browser view tells Flash (lobby/Browser.pyc, meta/BrowserMeta.pyc): as_loadBitmapS - the one
        bitmap that shows the page - as_resizeS, which alone makes Flash load that bitmap again, and the loading screen.
    Every line reads 'Bullba Hits window +<ms since the open> ms: <step>' and carries no address.

    ONE THING IS DONE, the rest is only written down: after the page's load end and after each texture report the mod
    asks the browser to draw again - WebBrowser.invalidateView, the call the client itself makes once, when the window is
    placed (by the log's times that is before a first open has a frame to draw; inferred, the 'client asked redraw' line
    now says when) - and twice more a little later. At most TRACE_REDRAWS times per page. Whether this cures the blank
    window is not known: it answers one of two candidate causes.
    The engine is never called from inside its own report (review, 04.10): the client does not call invalidate while
    onLoadEnd or onTextureStateChanged is being dispatched, so the request goes out on the next tick (BigWorld.callback(0)).
    The bound is counted when the request is scheduled, so reports that come with no tick between them cannot pass it.

    How it listens, least first: handlers on the events of this one browser; instance attributes over two methods of
    this one WebBrowser and four of this one view (the class's methods stay as they are; each wrapper notes the call and
    passes it on with its result); and, only until the window's Flash component registers, the Browser view's class
    method init, which is where the view of this window can be told from any other (telemetry.wrap). That one is taken
    back when the view registers, when the window closes, and after TRACE_VIEW_WAIT seconds whatever happened.

    A handler of the client's Event must never raise: Event.__call__ logs the exception and raises it again, and the
    client's own handlers behind it would not run. So every step here is guarded and says so once. (Leaving the list
    while it is called is safe: the client calls a copy, `for delegate in self[:]`.) The client clears a destroyed
    browser's events itself; close() takes the mod's off anyway.
    """
    name = 'Bullba Hits'    # the window's title in its lines (follow_window sets the replay viewer's)
    EVENTS = ('onReady', 'onLoadStart', 'onLoadEnd', 'onResized', 'onTextureStateChanged')
    VIEW_CALLS = ('as_loadBitmapS', 'as_resizeS', 'as_loadingStartS', 'as_loadingStopS')

    def __init__(self, controller, browser_id, web, at, ticket=None, step=WINDOW_STEP_DEFAULT):
        self.step = step        # the size step this window has now (BACKLOG 94)
        self.sizing = 0         # the generation of size changes: a newer one retires the older one's read-back
        self.window = None      # the client's BrowserWindow view of this window: the one that can change its size
        self.window_hook = None # telemetry.wrap record of BrowserWindow._onRegisterFlashComponent, while it stands
        self.controller = controller
        self.browser_id = browser_id
        self.web = web
        self.at = at
        self.ticket = ticket    # the open that made this trace: its 20 s check is the one that may take the class hook back
        self.closed = False
        self.was_ready = False
        self.redraws = 0        # asked for this page, against TRACE_REDRAWS
        self.total = 0          # asked for the window, for its closing line
        self.later = 0          # the generation of the deferred redraws: a newer report retires the older timers
        self.handlers = []      # (event name, handler) on the browser's events
        self.patched = []       # (object, name, wrapper): instance attributes over the client's methods
        self.original = {}      # the browser's own methods, as they were before the instance attributes
        self.hook = None        # telemetry.wrap record of the Browser view's class init, while it stands
        self.view = None
        self.deleted = None     # the listener of the controller's onBrowserDeleted

    def say(self, text, *args):
        LOG.info(self.name + ' window +%d ms: ' + text, int(round((time.time() - self.at) * 1000)), *args)

    def guarded(self, name, step):
        """`step` as a handler that cannot raise into the client; a failure is said once per kind."""
        def handler(*args, **kwargs):
            if self.closed: return
            try:
                step(*args, **kwargs)
            except Exception:
                _warn_once('trace-' + name, 'Bullba Hits window: %s could not be followed; that step is skipped', name)
                LOG.debug('Bullba Hits window: %s', name, exc_info=True)
        return handler

    def follow(self):
        self.say('browser %s created', self.browser_id)
        steps = {'onReady':self.on_ready, 'onLoadStart':self.on_load_start, 'onLoadEnd':self.on_load_end,
                 'onResized':self.on_resized, 'onTextureStateChanged':self.on_texture}
        for name in self.EVENTS:
            try:
                event = getattr(self.web, name)
                handler = self.guarded(name, steps[name])
                event += handler
                self.handlers.append((name, handler))
            except Exception:
                _warn_once('trace-' + name, 'Bullba Hits window: %s could not be followed; that step is skipped', name)
        self.patch(self.web, 'updateSize', self.on_size_sent, keep=True)
        self.patch(self.web, 'invalidateView', self.on_client_redraw, keep=True)
        if 'invalidateView' not in self.original:
            _warn_once('trace-redraw', 'Bullba Hits window: the browser could not be asked to draw again; not asked any more')
            self.redraws = TRACE_REDRAWS
        try:
            deleted = self.guarded('onBrowserDeleted', self.on_deleted)
            event = self.controller.onBrowserDeleted
            event += deleted
            self.deleted = deleted
        except Exception:
            _warn_once('trace-onBrowserDeleted', 'Bullba Hits window: its closing could not be followed')
        try:
            from gui.Scaleform.daapi.view.lobby.Browser import Browser
            from .telemetry import wrap
            trace = self
            def make(original):
                def init(view, *args, **kwargs):
                    try:
                        trace.bind(view, args, kwargs)
                    except Exception:
                        _warn_once('trace-view', 'Bullba Hits window: its Flash side could not be followed')
                    return original(view, *args, **kwargs)
                return init
            self.hook = wrap(Browser, 'init', make)
            if self.hook is None: _warn_once('trace-view', 'Bullba Hits window: its Flash side could not be followed')
        except Exception:
            _warn_once('trace-view', 'Bullba Hits window: its Flash side could not be followed')
            LOG.debug('Bullba Hits window: Browser view', exc_info=True)
        # The window's own view (BACKLOG 94): BrowserWindow._onRegisterFlashComponent(viewPy, alias) is what calls the Browser
        # view's init above, on the window that carries this browser's id (_BrowserWindow__browserID, 2.4.1.1 bytecode);
        # its as_setSizeS is the one call that changes the size of an open window. Taken back with the init hook.
        try:
            from gui.Scaleform.daapi.view.lobby.BrowserWindow import BrowserWindow
            from .telemetry import wrap
            trace = self
            def make_window(original):
                def register(window, *args, **kwargs):
                    try:
                        trace.bind_window(window)
                    except Exception:
                        _warn_once('trace-window', 'Bullba Hits window: its frame was not found; a new size waits for the next open')
                    return original(window, *args, **kwargs)
                return register
            self.window_hook = wrap(BrowserWindow, '_onRegisterFlashComponent', make_window)
            if self.window_hook is None:
                _warn_once('trace-window', 'Bullba Hits window: its frame was not found; a new size waits for the next open')
        except Exception:
            _warn_once('trace-window', 'Bullba Hits window: its frame was not found; a new size waits for the next open')
            LOG.debug('Bullba Hits window: BrowserWindow view', exc_info=True)

    def bind_window(self, window):
        """BrowserWindow._onRegisterFlashComponent of some window: this one's carries this browser's id."""
        if self.closed or self.window is not None: return
        if getattr(window, '_BrowserWindow__browserID', None) != self.browser_id: return
        self.window = window

    def resize(self, step):
        """The open window to the size of this step (the page asked, set_window_step), frame and page together, centred -
        as if it had opened at that size. On the next tick, never from inside the page's command.

        The client's Flash (lobby.swf 2.4.1.1) splits this in two, and 1.09 did only the first half (user 13.11: a smaller
        page inside the old frame, a larger one over its edges):
          * as_setSize -> BrowserWindow.updateSize sizes the page (Browser -> the engine's resize -> as_resize -> the bitmap
            again, the path of every open) and the window's content, and invalidates the position: updatePosition centres
            the frame by the frame's size as it is then;
          * the frame (Window) takes the content's size only when it is invalidated with INVALID_SRC_VIEW - at the open,
            and when the window's Browser component hides its service view: as_hideServiceView -> SERVICE_VIEW_HIDDEN ->
            BrowserWindow.onBrowserServiceViewHiddenHandler. The client itself calls as_hideServiceViewS on every
            navigation (Browser.__onNavigate), so it is the frame's own, tried path.
        So the frame is invalidated first and the size given after it: CLIK draws invalidations in the order they were
        raised (inferred, not read), the frame then takes its size before the window is centred. settle_size reads the
        window's place back WINDOW_SETTLE seconds later, writes it, keeps the frame it measured and centres the window once
        more if it is not (the size given again, the one call that centres it).
        The redraw requests start again as for a new page. False when this window's view was not found: the size waits
        for the next open."""
        if self.closed: return False
        window = self.window
        if window is None:
            _warn_once('window-resize', 'Bullba Hits window: its frame was not found; the new size applies at the next open')
            return False
        width, height = window_size(step)
        self.step = step
        self.sizing += 1
        sizing = self.sizing
        if 'invalidateView' in self.original: self.redraws = 0
        self.say('size step %d of %d asked: %dx%d', step + 1, WINDOW_STEPS, width, height)
        def apply():
            if self.closed or self.window is not window: return
            view = self.view
            if view is not None: view.as_hideServiceViewS()
            else: _warn_once('window-frame', 'Bullba Hits window: its page part was not found; the frame may keep its old size')
            window.as_setSizeS(width, height)
            import BigWorld
            BigWorld.callback(WINDOW_SETTLE, self.guarded('resize', lambda: self.settle_size(window, sizing, width, height)))
        try:
            import BigWorld
            BigWorld.callback(0, self.guarded('resize', apply))
            return True
        except Exception:
            _warn_once('window-resize-later', 'Bullba Hits window: no timer; the new size applies at the next open')
            return False

    def settle_size(self, window, sizing, width, height):
        """WINDOW_SETTLE s after a size change: the window's frame as Flash has it (as_getGeometryS -> [x, y, width,
        height], the call the client's stored window positions use), one line; the frame it adds to the page is kept for the
        next steps (window_frame); a window off the centre is centred once more. A newer size change retires this one."""
        global _frame_seen
        if self.closed or self.window is not window or sizing != self.sizing: return
        geometry = window.as_getGeometryS()
        if not geometry or len(geometry) < 4:
            self.say('frame not read')
            return
        x, y, frame_w, frame_h = [int(round(float(v))) for v in geometry[:4]]
        extra = (frame_h - height, frame_w - width)
        stage_w, stage_h, scale = stage_size()
        off = abs(x - (stage_w - frame_w) / 2.0) > 2 or abs(y - (stage_h - frame_h) / 2.0) > 2
        (low_h, top_h), (low_w, top_w) = WINDOW_FRAME_LIMITS
        followed = low_h <= extra[0] <= top_h and low_w <= extra[1] <= top_w
        if followed:
            if _frame_seen != extra: LOG.info('Bullba Hits window frame: %d high, %d wide around the page (read %d x %d)',
                                              extra[0], extra[1], WINDOW_FRAME[0], WINDOW_FRAME[1])
            _frame_seen = extra
        self.say('frame %dx%d at %d,%d on %dx%d; page %dx%d%s%s', frame_w, frame_h, x, y, int(stage_w), int(stage_h), width,
                 height, '' if followed else '; the frame did NOT take the size', '; centred again' if off else '')
        if off: window.as_setSizeS(width, height)

    def patch(self, target, name, note, keep=False):
        """An instance attribute over target.name: `note` sees the arguments, the client's method does the work."""
        try:
            original = getattr(target, name)
            if not callable(original): raise TypeError(name)
            if keep: self.original[name] = original
            noted = self.guarded(name, note)
            def call(*args, **kwargs):
                noted(*args, **kwargs)
                return original(*args, **kwargs)
            setattr(target, name, call)
            self.patched.append((target, name, call))
        except Exception:
            _warn_once('trace-' + name, 'Bullba Hits window: %s could not be followed; that step is skipped', name)

    def bind(self, view, args, kwargs):
        """Browser.init of some view: this window's is the one given this browser's id. Runs before the client's init."""
        if self.closed or self.view is not None: return
        browser_id = args[0] if args else kwargs.get('browserID')
        if browser_id != self.browser_id: return
        self.view = view
        self.unhook()
        size = getattr(view, '_Browser__size', None)
        if size: self.say('Flash component registered, its size already set %sx%s', int(size[0]), int(size[1]))
        else: self.say('Flash component registered, no size yet')
        notes = {'as_loadBitmapS':lambda *a, **k: self.say('Flash asked to load the bitmap'),
                 'as_resizeS':lambda *a, **k: self.say('Flash told the size %sx%s', *[int(v) for v in a[:2]]),
                 'as_loadingStartS':lambda *a, **k: self.say('loading screen shown'),
                 'as_loadingStopS':lambda *a, **k: self.say('loading screen hidden')}
        for name in self.VIEW_CALLS: self.patch(view, name, notes[name])

    def unhook(self):
        hooks = [hook for hook in (self.window_hook, self.hook) if hook is not None]
        self.hook = self.window_hook = None
        if not hooks: return
        try:
            from .telemetry import unwrap
            unwrap(hooks)
        except Exception:
            _warn_once('trace-unhook', 'Bullba Hits window: the Browser view hook could not be taken back')

    def take_redraw(self):
        """One of the page's TRACE_REDRAWS requests, counted now. False when none is left."""
        if self.closed or self.redraws >= TRACE_REDRAWS: return False
        self.redraws += 1
        self.total += 1
        return True

    def redraw_now(self):
        """The client's own invalidateView. Only from a timer, never from inside a report of the engine."""
        if self.dropped(): return False
        try:
            self.original['invalidateView']()
            return True
        except Exception:
            _warn_once('trace-redraw', 'Bullba Hits window: the browser could not be asked to draw again; not asked any more')
            LOG.debug('Bullba Hits window: invalidateView', exc_info=True)
            self.redraws = TRACE_REDRAWS
            return False

    def ask_redraw(self):
        """From inside a report of the engine: the request is counted now and goes out on the next tick. True when set."""
        if not self.take_redraw(): return False
        try:
            import BigWorld
            BigWorld.callback(0, self.guarded('redraw', self.redraw_now))
            return True
        except Exception:
            _warn_once('trace-later', 'Bullba Hits window: no redraw request (no timer)')
            self.redraws = TRACE_REDRAWS
            return False

    def redraw_soon(self):
        """Two more requests after the last report; a newer report starts the wait again. None once the bound is reached."""
        self.later += 1
        if self.redraws >= TRACE_REDRAWS: return
        generation = self.later
        try:
            import BigWorld
            for delay in TRACE_REDRAW_LATER:
                BigWorld.callback(delay, self.guarded('redraw', lambda generation=generation: self.redraw_later(generation)))
        except Exception:
            _warn_once('trace-later', 'Bullba Hits window: no redraw request (no timer)')

    def redraw_later(self, generation):
        if generation != self.later or self.dropped(): return
        if self.take_redraw() and self.redraw_now(): self.say('redraw asked again')

    def dropped(self):
        """A browser the client destroyed without saying so (it does on a disconnect) is let go. True when it was."""
        if self.controller.getBrowser(self.browser_id) is self.web: return False
        self.close()
        return True

    def settle(self):
        """TRACE_VIEW_WAIT seconds after the open: the class hook does not wait any longer for a view that never came."""
        if self.closed: return
        if self.hook is not None:
            self.unhook()
            self.say('no Flash component registered in %d s', TRACE_VIEW_WAIT)
        elif self.window_hook is not None:
            self.unhook()
        self.dropped()

    def on_ready(self, *args):
        # A creation that failed never comes here: the client goes onFailedCreation -> delBrowser (WebBrowser.ready).
        self.was_ready = True
        self.say('ready')

    def on_load_start(self, *args):
        self.say('load start')

    def on_load_end(self, url=None, loaded=True, status=None, *args):
        page_loading(False)
        asked = self.ask_redraw()
        self.say('load end %s%s', 'ok' if loaded else 'FAILED (code %s)' % (status,), '; redraw asked' if asked else '')
        self.redraw_soon()

    def on_resized(self, width=0, height=0, *args):
        self.say('resized %sx%s', int(width), int(height))

    def on_texture(self, ok=True, *args):
        asked = self.ask_redraw()
        self.say('texture %s%s', 'ok' if ok else 'NOT ok', '; redraw asked' if asked else '')
        self.redraw_soon()

    def on_size_sent(self, size=None, *args):
        if size is None: return
        size = tuple(size)
        self.say('size sent %sx%s%s', int(size[0]), int(size[1]), ' scale %s' % (size[2],) if len(size) > 2 and size[2] != 1 else '')

    def on_client_redraw(self, *args):
        self.say('client asked redraw')

    def on_deleted(self, browser_id=None, *args):
        if browser_id != self.browser_id: return
        self.say('destroyed%s; redraws %d', '' if self.was_ready else ' before ready', self.total)
        page_loading(None)
        self.close()

    def renavigated(self, at):
        """The open window pointed at another address: the same browser, the same listeners, a new zero of time."""
        self.at = at
        if 'invalidateView' in self.original: self.redraws = 0
        self.say('re-navigated')

    def close(self):
        """Everything the trace put on the client is taken off, at once."""
        if self.closed: return
        self.closed = True
        self.later += 1
        self.unhook()
        for name, handler in self.handlers:
            try:
                event = getattr(self.web, name)
                event -= handler
            except Exception: pass
        self.handlers = []
        for target, name, call in self.patched:
            try:
                if vars(target).get(name) is call: delattr(target, name)
            except Exception: pass
        self.patched = []
        self.original = {}
        deleted, self.deleted = self.deleted, None
        if deleted is not None:
            try:
                event = self.controller.onBrowserDeleted
                event -= deleted
            except Exception: pass
        self.view = self.web = self.window = None


def _set_trace(window, trace):
    global _trace
    if window == HITS: _trace = trace
    else: _viewer['trace'] = trace


def follow_window(controller, browser_id, at, ticket=None, step=WINDOW_STEP_DEFAULT, window=HITS):
    """The window's trace for this open: a new browser gets a new one, an open window keeps its own. Each of the mod's
    windows has its own trace (window: HITS or REPLAYS)."""
    try:
        web = controller.getBrowser(browser_id)
        trace = window_trace(window)
        if trace is not None and not trace.closed and web is not None and trace.web is web:
            trace.renavigated(at)
            return
        close_window_trace(window)
        if web is None:
            _warn_once('trace-browser', 'Bullba Hits window: the browser is not known to the controller; its steps are not followed')
            return
        trace = WindowTrace(controller, browser_id, web, at, ticket, step)
        trace.name = WINDOW_TITLES.get(window, 'Bullba Hits')
        _set_trace(window, trace)
        trace.follow()
    except Exception:
        _warn_once('trace', 'Bullba Hits window: its steps could not be followed')
        LOG.debug('Bullba Hits window trace', exc_info=True)


def settle_window(ticket):
    """The 20 s check of the open that holds `ticket`: the trace that open made stops waiting for a view
    (WindowTrace.settle). A later window's trace is another open's and is left alone."""
    for trace in (_trace, _viewer['trace']):
        try:
            if trace is not None and ticket is not None and trace.ticket is ticket: trace.settle()
        except Exception:
            LOG.debug('Bullba Hits window trace settle', exc_info=True)


def close_window_trace(window=None):
    """The mod leaves (fini: window None, both) or a trace's browser is gone: nothing of it stays on the client's objects."""
    for name in ((HITS, REPLAYS) if window is None else (window,)):
        trace = window_trace(name)
        _set_trace(name, None)
        if trace is None: continue
        try:
            trace.close()
        except Exception:
            LOG.debug('Bullba Hits window trace close', exc_info=True)


def open_in_game(path, fragment='host=game', window=HITS):
    """Open the local viewer in the game's own browser window.

    `window`: HITS (Viewer.html, the window Bullba Hits always had) or REPLAYS (playback.html, the 3D replay viewer's own
    window, 19.11): each keeps its own browser id and trace, so one is never re-navigated or closed by the other's open.

    The fragment is the page's only input: 'host=game' alone for the ModsList
    button, 'host=game&vehicle=<id>' for one vehicle of the browser. It is never
    sent anywhere - the client keeps it on the file URL.

    Loading again with the browser id we already have re-navigates that window
    instead of failing: BrowserController.load logs 'CTRL: Re-navigating an
    existing browser' and calls browser.navigate(url) when the id is already in
    its __browsers map.
    """
    from gui import SystemMessages
    ticket = None
    try:
        from helpers import dependency
        from skeletons.gui.game_control import IBrowserController
        import GUI
        if not os.path.isfile(path):
            raise IOError('Local viewer is not ready')
        # WebBrowser/CEF owns this window. Never silently minimize the game.
        url = page_url(path, fragment)
        if window == REPLAYS: _viewer['path'] = path   # the full-screen view opens the same page (R5)
        browser = dependency.instance(IBrowserController)
        width, height = GUI.screenResolution()
        try:
            import BigWorld as _bw
            client_w, client_h = _bw.screenSize()
            LOG.info('Bullba Hits window sizing: GUI %sx%s, client %sx%s', width, height, client_w, client_h)
        except Exception:
            LOG.info('Bullba Hits window sizing: GUI %sx%s (client size unavailable)', width, height)
        # The size of the step the page's Settings hold (the session's copy of its last word; BACKLOG 94), else the usual one.
        step = _window_step if _window_step is not None else WINDOW_STEP_DEFAULT
        stage_w, stage_h, scale = stage_size()
        size = window_sizes(stage_w, stage_h)[step]
        LOG.info('Bullba Hits window size step %d of %d: %dx%d (screen %dx%d at interface scale %s)', step + 1, WINDOW_STEPS,
                 size[0], size[1], int(stage_w), int(stage_h), scale)
        global _page_follows
        title = WINDOW_TITLES.get(window, 'Bullba Hits')
        opened = time.time()
        ticket = object()      # this open, for the trace it makes and for its 20 s check
        LOG.info('Opening %s in-game window: %s', title, url)
        page_loading(True)
        def loaded(browser_id):
            global _browser_id
            if window == HITS: _browser_id = browser_id
            else: _viewer['browser_id'] = browser_id
            # The mouse switches (let_mouse_through), set the same way by the game's own pages.
            # Read from the client's code on 19.11.2026, not yet seen working in the game.
            try:
                let_mouse_through(browser.getBrowser(browser_id))
                LOG.info('Window %s: right and middle buttons and Ctrl/Shift clicks let through', browser_id)
            except Exception:
                LOG.exception('Window %s: the mouse switches could not be set', browser_id)
            # The window's steps from here on, one line each (WindowTrace); it cannot break the open.
            follow_window(browser, browser_id, opened, ticket, step, window)
        # An open window is re-navigated by the controller (BrowserController.load: 'Re-navigating an
        # existing browser', browser.navigate(url)) and never calls showBrowserCallback again, so the
        # 20 s check below would cry wolf every time the hangar menu points the open window at a
        # vehicle (0.6.35). getBrowser(browserID) is the controller's own dict lookup.
        existing = None
        try:
            if window_id(window) is not None: existing = browser.getBrowser(window_id(window))
        except Exception:
            existing = None
        shown = [existing is not None]
        if existing is not None:
            LOG.info('%s window already open; re-navigating', title)
            close_other(window)     # never two pages together (BACKLOG 118): this one stands already
        elif window == HITS: _page_follows = False     # a new page follows the hangar only once it says it browses vehicles
        def on_shown(*args):
            shown[0] = True
            LOG.info('%s in-game window shown (+%d ms)', title, int(round((time.time() - opened) * 1000)))
            close_other(window)
        def check_opened():
            settle_window(ticket)
            if not shown[0]:
                LOG.warning('%s window did not report opening', title)
                SystemMessages.pushMessage(u'%s: the in-game window did not load. See game.log.' % title, type=SystemMessages.SM_TYPE.Error)
        # adisp_async returns a callable, not an already running operation.
        operation = browser.load(url=url, title=title, browserID=window_id(window),
                     showActionBtn=False, showCloseBtn=True, showWaiting=True,
                     showCreateWaiting=False, useBrowserWindow=True, isModal=False,
                     browserSize=size,
                     showBrowserCallback=on_shown, handlers=web_handlers())
        operation(loaded)
        import BigWorld
        BigWorld.callback(TRACE_VIEW_WAIT, check_opened)
    except Exception:
        LOG.exception('Bullba Hits in-game window could not be opened')
        settle_window(ticket)      # no 20 s check may have been set: the trace does not wait for a view without it
        SystemMessages.pushMessage(u'Bullba Hits: the in-game window is unavailable. Open the local history with the Bullba Hits shortcut after leaving the game.', type=SystemMessages.SM_TYPE.Error)


# ---- the replay viewer in full screen (R5, BACKLOG 110, 20.11.2026) ------------------------------------------------------
# The game's browser window keeps its WG frame whatever is asked of it (outputs/window-frame-options-2026-11-19.md B2), so
# full screen is the client's own frameless view instead - the one its shop and premium pages use: a WebView on
# browserScreen.swf in the FULLSCREEN_WINDOW layer, sized by the client to the whole stage, with no title bar and no close
# button (browserParams isCloseBtnVisible False). The base WebView registers WG's own page commands only (webHandlers() =
# createWebHandlers), so ours is a subclass that adds the 'bullba_hits' command, under our own alias. The page is loaded
# anew in the view and in the window, so what it shows travels in its fragment (the page's viewState: battle, time,
# camera, speed, play, followed vehicle, shots panel); the window is closed once the view stands, and opened again when
# the view is left (the page's button, its close, or Esc). Every step is guarded: a failure leaves the window as it was
# and writes one line naming the step. Every client name here was read from the client's bytecode (2.4.1.1 #992:
# WebView, IGuiLoader.entitiesFactory / GuiEntitiesFactories, ViewSettings.__new__, LobbyPackageBusinessHandler,
# LobbyEntry.loadView, IAppLoader.getDefLobbyApp, BrowserView.makeBrowserParams; WoT-Base KNOWLEDGE-client 'Which browser
# views the client has'); not yet seen in the game.
FULLSCREEN_ALIAS = 'bullbaReplaysFullScreen'
FULLSCREEN_WAIT = 10.0          # s: the view must stand by then, else the window stays and one line says so (a guess)
VIEW_STATE = re.compile(r'^[-a-zA-Z0-9_.,=&]{0,600}\Z')
_full = {'class': None, 'registered': False, 'view': None, 'state': '', 'asked': None}
# The mode the viewer was last left in (U5, 20.11): 'full' once the frameless view stood (closing it there keeps it),
# 'window' once the view was left for the window; the next open takes it (open_viewer_view). One small file of this
# module's own, read on the first open and written on a change, only where the mod's folder is (the game's).
VIEW_MODE_FILE = os.path.join('mods', 'configs', 'local.armor_inspector', 'replays-view.json')
VIEW_MODES = ('window', 'full')
_view_mode = None             # None: not read yet


def view_mode():
    """The remembered mode, 'window' when none or unreadable."""
    global _view_mode
    if _view_mode is None:
        _view_mode = 'window'
        try:
            if os.path.isfile(VIEW_MODE_FILE):
                with open(VIEW_MODE_FILE, 'rb') as handle: stored = json.loads(handle.read(4096).decode('utf-8'))
                if isinstance(stored, dict) and stored.get('mode') in VIEW_MODES: _view_mode = stored['mode']
        except Exception as error:
            LOG.warning('Bullba Replays: %s unreadable (%s: %s); the window mode is used', VIEW_MODE_FILE, type(error).__name__, error)
    return _view_mode


def remember_view_mode(mode):
    global _view_mode
    if mode not in VIEW_MODES or view_mode() == mode: return
    _view_mode = mode
    folder = os.path.dirname(VIEW_MODE_FILE)
    if not os.path.isdir(folder): return
    try:
        from local_armor_inspector.exporter import atomic_write
        atomic_write(VIEW_MODE_FILE, json.dumps({'mode': mode}).encode('ascii'))
        LOG.info('Bullba Replays: opens in the %s mode from now on', mode)
    except Exception as error:
        LOG.warning('Bullba Replays: the %s mode could not be remembered (%s: %s)', mode, type(error).__name__, error)


def open_viewer_view(path, state=''):
    """The viewer's open (its mods-list button, Hits' 3D link): in the mode it was last left in - the frameless view
    straight away, the window if that fails; else the window."""
    _viewer['path'] = path
    if fullscreen_open() and state:
        browser = _full['view'].getBrowser()
        if browser is None: raise RuntimeError('the existing replay browser is not ready')
        _full['state'] = state
        browser.navigate(page_url(path, full_fragment(state, True)))
        close_other(REPLAYS)
    elif view_mode() == 'full': enter_fullscreen(state, fallback=True)
    else: open_in_game(path, full_fragment(state, False), window=REPLAYS)


def command_value(command, name):
    """A field of a page command: its attribute, else the client's `custom_parameters` (fields the schema lacks)."""
    value = getattr(command, name, None)
    if value is not None: return value
    extra = getattr(command, 'custom_parameters', None)
    return extra.get(name) if isinstance(extra, dict) else None


def view_state(command):
    """The viewer's state as the page sends it ('battle=..&at=..&cam=..'), '' when none, None when it does not read: only
    the page's own characters, and never 'host' or 'view' (the mod sets those)."""
    value = command_value(command, 'state')
    if value is None: return ''
    value = str(value)
    if not VIEW_STATE.match(value): return None
    keys = [part.split('=')[0] for part in value.split('&') if part]
    if 'host' in keys or 'view' in keys: return None
    return value


def full_fragment(state, full):
    """The page's fragment in the full-screen view (full) or in the window."""
    return 'host=game' + ('&view=full' if full else '') + ('&' + state if state else '')


def fullscreen_open():
    return _full['view'] is not None


def let_mouse_through(web):
    """The client's browser drops the right and middle buttons and Ctrl/Shift + left clicks unless the window says
    otherwise (WebBrowser's public switches, outputs/game-browser-input-2026-11-19.md); both pages pan with them."""
    for name, value in (('allowRightClick', True), ('allowMiddleClick', True), ('ignoreCtrlClick', False), ('ignoreShiftClick', False)):
        setattr(web, name, value)


def fullscreen_loaded():
    """The full-screen view's callbackOnLoad (WebView.__loadBrowserAS calls it once its browser shows): the client's
    WebView sets the right button and Ctrl/Shift from our ctx but never the middle one - the same switches as the window."""
    try:
        let_mouse_through(_full['view'].getBrowser())
        LOG.info('Bullba Replays full screen: right and middle buttons and Ctrl/Shift clicks let through')
    except Exception:
        LOG.exception('Bullba Replays full screen: the mouse switches could not be set')


def fullscreen_class():
    """Our WebView subclass, made once (the client's class is imported only in the game)."""
    if _full['class'] is not None: return _full['class']
    from gui.Scaleform.daapi.view.lobby.shared.web_view import WebView

    class BullbaFullScreenView(WebView):
        """The client's frameless full-screen browser view with the page's 'bullba_hits' command added."""

        def webHandlers(self):
            try: base = list(super(BullbaFullScreenView, self).webHandlers() or ())
            except Exception: base = []
            return base + web_handlers()

        def _populate(self):
            super(BullbaFullScreenView, self)._populate()
            fullscreen_stood(self)

        def onEscapePress(self):
            # the view's own Esc: back to the window with the page's last state (not the base's plain destroy)
            leave_fullscreen(None)

        def _dispose(self):
            try:
                super(BullbaFullScreenView, self)._dispose()
            finally:
                fullscreen_gone(self)

    _full['class'] = BullbaFullScreenView
    return BullbaFullScreenView


def register_fullscreen():
    """Our alias in the client's view factory, once: the frameless browser screen on the full-screen layer, as the client
    registers its own BROWSER_OVERLAY and MAPBOX_INFO_OVERLAY (lobby/__init__ getViewSettings). The factory is the GUI
    loader's entitiesFactory (GuiEntitiesFactories; the client's loaders.pyc adds settings to it the same way); its
    addSettings refuses an alias it has, so it is asked first (the alias outlives a lobby reload)."""
    from helpers import dependency
    from skeletons.gui.impl import IGuiLoader
    from gui.Scaleform.framework import ViewSettings, ScopeTemplates
    from frameworks.wulf import WindowLayer
    factory = dependency.instance(IGuiLoader).entitiesFactory
    if factory.getSettings(FULLSCREEN_ALIAS) is None:
        factory.addSettings(ViewSettings(FULLSCREEN_ALIAS, fullscreen_class(), 'browserScreen.swf',
                                         WindowLayer.FULLSCREEN_WINDOW, FULLSCREEN_ALIAS, ScopeTemplates.LOBBY_SUB_SCOPE))
    _full['registered'] = True


_page_entry = 0


def page_url(path, fragment):
    url = 'file:' + pathname2url(os.path.abspath(path))
    if not url.startswith('file:///'): url = 'file:///' + pathname2url(os.path.abspath(path)).lstrip('/')
    # An explicit link must navigate even when the same destination/shot is open.
    # A fresh query reloads the destination document rather than relying on CEF hash events.
    global _page_entry
    if 'battle=' in fragment:
        _page_entry += 1
        url += '?entry=%d' % _page_entry
    return url + '#' + fragment


def fullscreen_fallback(state):
    """A direct open into the frameless view failed (U5): the viewer's window instead; the remembered mode is left."""
    path = _viewer.get('path')
    if path: open_in_game(path, full_fragment(state, False), window=REPLAYS)


def enter_fullscreen(state, fallback=False):
    """The page's full-screen button in the window: the viewer opens in the frameless view; the window closes once the
    view stands (fullscreen_stood). The view is loaded by the lobby app's loadView - the call the client's own
    LobbyPackageBusinessHandler.loadViewByCtxEvent makes for BROWSER_OVERLAY; a LoadViewEvent on the event bus would reach
    no handler for our alias. Any failure: the window stays, one line naming the step. `fallback` (U5, an open with no
    window, in the remembered full mode): a failure opens the window instead, the same one line."""
    step = 'prepare'
    try:
        if fullscreen_open():
            LOG.info('Bullba Replays full screen: already open')
            return
        path = _viewer.get('path')
        if not path: raise RuntimeError('the viewer page is not known yet')
        step = 'register'
        register_fullscreen()
        step = 'lobby app'
        from helpers import dependency
        from skeletons.gui.app_loader import IAppLoader
        app = dependency.instance(IAppLoader).getDefLobbyApp()
        if app is None: raise RuntimeError('the lobby app is missing')
        step = 'loadView'
        from gui.Scaleform.framework.managers.loaders import SFViewLoadParams
        from gui.Scaleform.daapi.view.lobby.hangar.BrowserView import makeBrowserParams
        ctx = {'url': page_url(path, full_fragment(state, True)), 'forcedSkipEscape': False,
               'browserParams': makeBrowserParams(isCloseBtnVisible=False, bgAlpha=1.0),
               # the page's mouse as in the window (open_in_game): right drag, Ctrl/Shift clicks
               'allowRightClick': True, 'ignoreCtrlClick': False, 'ignoreShiftClick': False,
               'callbackOnLoad': fullscreen_loaded}      # the middle button: WebView's ctx has no key for it
        _full['state'] = state
        asked = _full['asked'] = time.time()
        app.loadView(SFViewLoadParams(FULLSCREEN_ALIAS), ctx=ctx)
        LOG.info('Bullba Replays full screen: opening the frameless view (%s)', state or 'no battle')
        step = 'wait timer'
        import BigWorld
        BigWorld.callback(FULLSCREEN_WAIT, lambda: fullscreen_check(asked, state if fallback else None))
    except Exception as error:
        _full['asked'] = None
        LOG.warning('Bullba Replays full screen could not open at step %s (%s: %s); the window %s', step, type(error).__name__, error,
                    'opens instead' if fallback else 'stays')
        if fallback: fullscreen_fallback(state)


def fullscreen_check(asked, fallback=None):
    """FULLSCREEN_WAIT after an open: the view did not stand - the window is left as it is (or, `fallback` a state, opened
    on it), one line."""
    if _full['asked'] == asked and not fullscreen_open():
        _full['asked'] = None
        LOG.warning('Bullba Replays full screen, step populate: the view did not open in %d s; the window %s', int(FULLSCREEN_WAIT),
                    'opens instead' if fallback is not None else 'stays')
        if fallback is not None: fullscreen_fallback(fallback)


def fullscreen_stood(view):
    """Our view is populated: it is the viewer now, the window closes (its trace and browser go with it)."""
    _full['view'], _full['asked'] = view, None
    remember_view_mode('full')
    close_viewer_window()
    close_other(REPLAYS)        # Bullba Hits' window too (BACKLOG 118)
    LOG.info('Bullba Replays full screen: the frameless view stands, the window closed')


def fullscreen_gone(view):
    if _full['view'] is view: _full['view'] = None


def close_viewer_window():
    """The viewer's window closed (its full-screen view stands)."""
    close_window(REPLAYS)


def close_window(window):
    """One of the mod's windows closed: its BrowserWindow view destroyed (the trace's), else its browser deleted - the
    calls close_viewer_window made since 1.16 (seen working: the window goes when the full-screen view stands)."""
    trace, browser_id = window_trace(window), window_id(window)
    try:
        view = trace.window if trace is not None else None
        if view is not None:
            view.destroy()
        elif browser_id is not None:
            from helpers import dependency
            from skeletons.gui.game_control import IBrowserController
            dependency.instance(IBrowserController).delBrowser(browser_id)
    except Exception as error:
        LOG.warning('%s window could not be closed (%s: %s)', WINDOW_TITLES.get(window, 'Bullba Hits'), type(error).__name__, error)


# NEVER TWO PAGES TOGETHER (21.11, BACKLOG 118: the user's machine lags with both open): once one page stands - its window
# shown (open_in_game's showBrowserCallback, or at once for an open window re-navigated) or the viewer's full-screen view
# populated - the other page goes: its window, or the viewer's full-screen view (its remembered mode kept). A page that
# never stands leaves the other as it was. Done on the next tick, never inside the client's own callback.
def close_other(window):
    def run():
        try:
            if window == HITS:
                if fullscreen_open():
                    view = _full['view']
                    fullscreen_gone(view)
                    view.destroy()
                    LOG.info('Bullba Replays full screen closed: Bullba Hits opened')
                if window_open(REPLAYS):
                    close_window(REPLAYS)
                    LOG.info('Bullba Replays window closed: Bullba Hits opened')
            elif window_open(HITS):
                close_window(HITS)
                LOG.info('Bullba Hits window closed: Bullba Replays opened')
        except Exception as error:
            LOG.warning('The other page could not be closed (%s: %s)', type(error).__name__, error)
    try:
        import BigWorld
        BigWorld.callback(0, run)
    except Exception:
        run()


def leave_fullscreen(state, close=False):
    """The page's button or Esc in the view (state: the page's, None: the last it told) - the window opens again on that
    state and the view goes; `close`: the page's close button - the view goes, no window."""
    view = _full['view']
    if view is None:
        if not close: LOG.info('Bullba Replays full screen: not open; nothing to leave')
        return
    if state is not None: _full['state'] = state
    try:
        if not close:
            remember_view_mode('window')     # left for the window (closed in the view: the full mode stays)
            path = _viewer.get('path')
            if path: open_in_game(path, full_fragment(_full['state'], False), window=REPLAYS)
            else: LOG.warning('Bullba Replays full screen: the viewer page is not known; the window is not opened again')
    finally:
        fullscreen_gone(view)
        try:
            view.destroy()
        except Exception as error:
            LOG.warning('Bullba Replays full screen, step close view: the view could not be closed (%s: %s)', type(error).__name__, error)
        LOG.info('Bullba Replays full screen: %s', 'closed' if close else 'back to the window')
