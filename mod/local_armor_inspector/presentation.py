# -*- coding: utf-8 -*-
"""Local presentation helpers; no external browser, service or network request."""
from __future__ import absolute_import
import logging
import math
import os
from urllib import pathname2url

LOG = logging.getLogger('local.armor_inspector')
_limits = {}
_browser_id = None
WEB_COMMAND = 'bullba_hits'
_export_request = None


def gun_limits(descr):
    key = descr.makeCompactDescr()
    if key not in _limits:
        from gun_rotation_shared import calcPitchLimitsFromDesc
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
        _limits[key] = {'samples':samples, 'hullTurretPitch':pitch, 'gunJointPitch':joint,
                        'source':'client calcPitchLimitsFromDesc; knots and 1 degree samples'}
        if len(_limits) > 64:
            value = _limits[key]
            _limits.clear()
            _limits[key] = value
    return _limits[key]


def set_export_request(handler):
    """The mod hands the page command its one action: export this vehicle type now."""
    global _export_request
    _export_request = handler


def _handle_web_command(command, ctx):
    """One w2c command from the page, on the game thread. Only the request is done here."""
    try:
        action = getattr(command, 'action', None)
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

    Every link of the chain was read in the installed 2.4.0.0 bytecode/binaries:
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
        return [createCommandHandler(WEB_COMMAND, BullbaHitsSchema, _handle_web_command, None)]
    except Exception:
        LOG.exception('Bullba Hits page command could not be registered')
        return []


def open_in_game(path, fragment='host=game'):
    """Open the local viewer in the game's own browser window.

    The fragment is the page's only input: 'host=game' alone for the ModsList
    button, 'host=game&vehicle=<id>' for one vehicle of the browser. It is never
    sent anywhere - the client keeps it on the file URL.

    Loading again with the browser id we already have re-navigates that window
    instead of failing: BrowserController.load logs 'CTRL: Re-navigating an
    existing browser' and calls browser.navigate(url) when the id is already in
    its __browsers map.
    """
    from gui import SystemMessages
    try:
        from helpers import dependency
        from skeletons.gui.game_control import IBrowserController
        import GUI
        if not os.path.isfile(path):
            raise IOError('Local viewer is not ready')
        # WebBrowser/CEF owns this window. Never silently minimize the game.
        url = 'file:' + pathname2url(os.path.abspath(path))
        if url.startswith('file:///') is False:
            url = 'file:///' + pathname2url(os.path.abspath(path)).lstrip('/')
        # The page limits heavy settings only when it knows it runs inside the
        # game's offscreen CEF; the fragment is never sent or rewritten.
        url += '#' + fragment
        browser = dependency.instance(IBrowserController)
        width, height = GUI.screenResolution()
        try:
            import BigWorld as _bw
            client_w, client_h = _bw.screenSize()
            LOG.info('Bullba Hits window sizing: GUI %sx%s, client %sx%s', width, height, client_w, client_h)
            width, height = min(width, int(client_w)), min(height, int(client_h))
        except Exception:
            LOG.info('Bullba Hits window sizing: GUI %sx%s (client size unavailable)', width, height)
        global _browser_id
        LOG.info('Opening Bullba Hits in-game window: %s', url)
        def loaded(browser_id):
            global _browser_id
            _browser_id = browser_id
            LOG.info('Bullba Hits browser operation started: %s', browser_id)
        # An open window is re-navigated by the controller (BrowserController.load: 'Re-navigating an
        # existing browser', browser.navigate(url)) and never calls showBrowserCallback again, so the
        # 20 s check below would cry wolf every time the hangar menu points the open window at a
        # vehicle (0.6.35). getBrowser(browserID) is the controller's own dict lookup.
        existing = None
        try:
            if _browser_id is not None: existing = browser.getBrowser(_browser_id)
        except Exception:
            existing = None
        shown = [existing is not None]
        if existing is not None: LOG.info('Bullba Hits window already open; re-navigating')
        def on_shown(*args):
            shown[0] = True
            LOG.info('Bullba Hits in-game window shown')
        def check_opened():
            if not shown[0]:
                LOG.warning('Bullba Hits window did not report opening')
                SystemMessages.pushMessage(u'Bullba Hits: the in-game window did not load. See game.log.', type=SystemMessages.SM_TYPE.Error)
        # adisp_async returns a callable, not an already running operation.
        operation = browser.load(url=url, title='Bullba Hits', browserID=_browser_id,
                     showActionBtn=False, showCloseBtn=True, showWaiting=True,
                     showCreateWaiting=False, useBrowserWindow=True, isModal=False,
                     browserSize=(max(640, int(width * .92)), max(480, int(height * .88))),
                     showBrowserCallback=on_shown, handlers=web_handlers())
        operation(loaded)
        import BigWorld
        BigWorld.callback(20, check_opened)
    except Exception:
        LOG.exception('Bullba Hits in-game window could not be opened')
        SystemMessages.pushMessage(u'Bullba Hits: the in-game window is unavailable. Open the local history with the Bullba Hits shortcut after leaving the game.', type=SystemMessages.SM_TYPE.Error)
