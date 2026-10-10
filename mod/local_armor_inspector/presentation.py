# -*- coding: utf-8 -*-
"""Local presentation helpers; no external browser, service or network request."""
from __future__ import absolute_import
import logging
import math
import os
import re
import time
from urllib import pathname2url

LOG = logging.getLogger('local.armor_inspector')
_limits = {}
_browser_id = None
WEB_COMMAND = 'bullba_hits'
_export_request = None
_busy_request = None
_prioritise_request = None
_ttx_request = None
_open_request = None
_sweep_request = None
_battle_request = None
_warned = set()
BATTLE_ID = re.compile(r'^[-a-zA-Z0-9_]{1,100}\Z')


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
    try:
        mode = int(getattr(descr, 'vehicleMode', 0) or 0) if getattr(descr, 'hasSiegeMode', False) else 0
    except Exception:
        mode = 0
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


def set_ttx_request(handler):
    """The page asks for the characteristics file of one vehicle type (data/ttx/<id>.js)."""
    global _ttx_request
    _ttx_request = handler


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

    Eight fire-and-forget actions: 'exportVehicle' asks for one vehicle type,
    'exportTtx' for the characteristics file of one type (no collision models),
    'busy' says the user is dragging or zooming the page right now,
    'prioritise' names the vehicle types whose collision models the page is
    waiting for, 'open' says the page is open (a sweep may run) and
    'sweepStart'/'sweepStop' are the user's Start and Stop of a sweep, its
    'kind' - 'ttx' when absent, or 'models' - and 'prepareBattle' names the saved
    battle the page opened whose file is stale ('battleId').
    None of them may cost the game thread more than a flag.
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
            # 'prepareBattle': the saved battle the page opened (BACKLOG 55).
            battleId = Field(type=basestring)
        return [createCommandHandler(WEB_COMMAND, BullbaHitsSchema, _handle_web_command, None)]
    except Exception:
        LOG.exception('Bullba Hits page command could not be registered')
        return []


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
    EVENTS = ('onReady', 'onLoadStart', 'onLoadEnd', 'onResized', 'onTextureStateChanged')
    VIEW_CALLS = ('as_loadBitmapS', 'as_resizeS', 'as_loadingStartS', 'as_loadingStopS')

    def __init__(self, controller, browser_id, web, at, ticket=None):
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
        LOG.info('Bullba Hits window +%d ms: ' + text, int(round((time.time() - self.at) * 1000)), *args)

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
        hook, self.hook = self.hook, None
        if hook is None: return
        try:
            from .telemetry import unwrap
            unwrap([hook])
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
        self.dropped()

    def on_ready(self, *args):
        # A creation that failed never comes here: the client goes onFailedCreation -> delBrowser (WebBrowser.ready).
        self.was_ready = True
        self.say('ready')

    def on_load_start(self, *args):
        self.say('load start')

    def on_load_end(self, url=None, loaded=True, status=None, *args):
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
        self.view = self.web = None


def follow_window(controller, browser_id, at, ticket=None):
    """The window's trace for this open: a new browser gets a new one, an open window keeps its own."""
    global _trace
    try:
        web = controller.getBrowser(browser_id)
        if _trace is not None and not _trace.closed and web is not None and _trace.web is web:
            _trace.renavigated(at)
            return
        close_window_trace()
        if web is None:
            _warn_once('trace-browser', 'Bullba Hits window: the browser is not known to the controller; its steps are not followed')
            return
        _trace = WindowTrace(controller, browser_id, web, at, ticket)
        _trace.follow()
    except Exception:
        _warn_once('trace', 'Bullba Hits window: its steps could not be followed')
        LOG.debug('Bullba Hits window trace', exc_info=True)


def settle_window(ticket):
    """The 20 s check of the open that holds `ticket`: the trace that open made stops waiting for a view
    (WindowTrace.settle). A later window's trace is another open's and is left alone."""
    trace = _trace
    try:
        if trace is not None and ticket is not None and trace.ticket is ticket: trace.settle()
    except Exception:
        LOG.debug('Bullba Hits window trace settle', exc_info=True)


def close_window_trace():
    """The mod leaves (fini) or the trace's browser is gone: nothing of it stays on the client's objects."""
    global _trace
    trace, _trace = _trace, None
    if trace is None: return
    try:
        trace.close()
    except Exception:
        LOG.debug('Bullba Hits window trace close', exc_info=True)


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
    ticket = None
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
        opened = time.time()
        ticket = object()      # this open, for the trace it makes and for its 20 s check
        LOG.info('Opening Bullba Hits in-game window: %s', url)
        def loaded(browser_id):
            global _browser_id
            _browser_id = browser_id
            # The window's steps from here on, one line each (WindowTrace); it cannot break the open.
            follow_window(browser, browser_id, opened, ticket)
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
            LOG.info('Bullba Hits in-game window shown (+%d ms)', int(round((time.time() - opened) * 1000)))
        def check_opened():
            settle_window(ticket)
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
        BigWorld.callback(TRACE_VIEW_WAIT, check_opened)
    except Exception:
        LOG.exception('Bullba Hits in-game window could not be opened')
        settle_window(ticket)      # no 20 s check may have been set: the trace does not wait for a view without it
        SystemMessages.pushMessage(u'Bullba Hits: the in-game window is unavailable. Open the local history with the Bullba Hits shortcut after leaving the game.', type=SystemMessages.SM_TYPE.Error)
