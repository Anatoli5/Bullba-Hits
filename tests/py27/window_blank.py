# -*- coding: utf-8 -*-
"""The in-game window that opens blank (user, 03.10: "the window opens and there is just some blue background, that is all;
reopening usually makes it work").

His case, as his game.log has it (02.10 20:12:23 and 03.10 00:02:08, both the first open after entering the hangar): the
window was created and shown, the page loaded and ran - its scripts, the scene, 51-54 frames/s of the aim loop, his mouse
over the scene - and 8-11 s later he closed the window and opened it again on the same vehicle. Nothing in the log told
those two opens from a working one: the client reports the same lines, 'onTextureStateChanged isOk: True' twice included.
So the page was alive and its picture was not on the screen: the fault is between the browser's frame and the game's window
(the engine's web texture and the Flash bitmap that shows it), a part of the chain the mod neither saw nor wrote.

The blank picture itself cannot be reproduced without the game (its exe, its Flash, its CEF host). What is checked here is
what the mod does about it (presentation.WindowTrace, 04.10), against fakes that keep the client's contract as read from the
2.4.0.2 bytecode (scripts.pkg: gui/game_control/BrowserController.pyc, WebBrowser.pyc, common/Event.pyc,
gui/Scaleform/daapi/view/lobby/Browser.pyc, view/meta/BrowserMeta.pyc):
  - BrowserController.load(...) creates the WebBrowser, calls back with the browser id, shows the window when the browser
    is READY (isAsync False) and calls showBrowserCallback; getBrowser(id) is a dict lookup; delBrowser destroys the browser
    (its events are cleared) and then calls onBrowserDeleted(id); a disconnect destroys the browsers without that call;
  - Event is a list called over a copy of itself (for delegate in self[:]): a handler may leave the list while it is
    called, but a handler that raises stops the handlers behind it - the exception is logged and raised again;
  - the Browser view: init(browserID, ...) subscribes its own handlers, sends the size it already has and calls
    as_loadBitmapS; setBrowserSize stores the size and sends it through WebBrowser.updateSize; onResized -> as_resizeS;
    invalidateView -> WebBrowser.invalidateView.
Checked:
  1. the path as it was: the address, the size, 'window shown', the 20 s alarm, a re-navigated and a reopened window;
  2. his open, step by step: every step is one 'Bullba Hits window +N ms: ...' line without an address, the Flash-side
     calls among them in the order they were made (both orders of 'the size' and 'the bitmap');
  3. the one thing done: the browser is asked to draw again after the load end and after each texture report - on the
     next tick, never from inside the engine's own report - and twice more later; never more than TRACE_REDRAWS times a
     page, no timers once that bound is reached, never after the window closed; the closing line says how many;
  4. the client is left as it was: its calls pass through with their results, a view of another window is not touched,
     a failure inside the mod never reaches the client's handlers, a browser without these events still opens;
  5. nothing stays on the client when the window closes, when the mod leaves, or when the client drops the browser
     silently; the view class's init is the mod's for 20 s at most.

The first 16 of these checks were the red test of 03.10 (8 red on 3de626e: nothing listened, nothing written).

    python tests/py27/run27.py tests/py27/window_blank.py
Verdict through BULLBA_PY27_RESULT (see run27.py). Investigation: outputs/blue-window-2026-10-03.md."""
import logging, os, re, sys, tempfile, types
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True
report = []
failures = []


def check(ok, name, extra=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' ' + str(extra) if extra and not ok else ''))
    if not ok: failures.append(name)
    return ok


class Collect(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.records = []

    def emit(self, record):
        self.records.append(record)


logs = Collect()
logger = logging.getLogger('local.armor_inspector')
logger.addHandler(logs)
logger.setLevel(logging.INFO)
logger.propagate = False


def lines(level=None):
    out = []
    for record in logs.records:
        if level is not None and record.levelno != level: continue
        try: out.append(record.getMessage())
        except Exception: out.append('UNFORMATTED ' + str(record.msg))
    return out


def logged(*words):
    """How many log lines hold every one of the words, whatever the case."""
    return len([l for l in lines() if all(w.lower() in l.lower() for w in words)])


def steps():
    """The steps of the window's lines, in order, without their times."""
    out = []
    for line in lines():
        match = re.match(r'Bullba Hits window \+(\d+) ms: (.*)$', line)
        if match: out.append(match.group(2))
    return out


class Event(list):
    """common/Event.pyc: a list called over a copy of itself; an exception of a handler goes on to the caller."""
    def __iadd__(self, handler):
        if not callable(handler): raise TypeError('Event listener is not callable.')
        if handler not in self: self.append(handler)
        return self

    def __isub__(self, handler):
        if handler in self: self.remove(handler)
        return self

    def __call__(self, *args, **kwargs):
        for handler in self[:]: handler(*args, **kwargs)

    def clear(self):
        del self[:]


class FakeWebBrowser(object):
    """WebBrowser.pyc: the events of __init__ and the calls made on it."""
    EVENTS = ('onLoadStart', 'onLoadEnd', 'onLoadingStateChange', 'onReadyToShowContent', 'onNavigate', 'onReady',
              'onJsHostQuery', 'onTitleChange', 'onFailedCreation', 'onCanCreateNewBrowser', 'onResized', 'onTextureStateChanged')

    def __init__(self, browser_id, url):
        self.id = browser_id
        self.url = self.baseUrl = url
        self.hasBrowser = True
        self.navigated = []
        self.invalidated = 0
        self.inside = 0          # the engine is calling one of this browser's events right now
        self.reentered = 0       # calls into the engine made from inside such a call
        self.sizes = []
        for name in self.EVENTS: setattr(self, name, Event())

    def report(self, name, *args):
        """The engine calls one of the events, as PyWebBrowserProvider does from its own callback."""
        self.inside += 1
        try: getattr(self, name)(*args)
        finally: self.inside -= 1

    def navigate(self, url):
        self.url = self.baseUrl = url
        self.navigated.append(url)

    def changeTitle(self, title): pass

    def invalidateView(self):
        if self.inside: self.reentered += 1
        if self.hasBrowser: self.invalidated += 1

    def updateSize(self, size):
        self.sizes.append(tuple(size))
        return 'engine'

    def refresh(self, ignoreCache=True): pass

    def destroy(self):
        for name in self.EVENTS: getattr(self, name).clear()
        self.hasBrowser = False


class BareWebBrowser(object):
    """A browser of some other client: no texture or resize events, no invalidateView, a size it refuses."""
    def __init__(self, browser_id, url):
        self.id = browser_id
        self.url = self.baseUrl = url
        self.hasBrowser = True
        self.navigated = []
        self.onReady = Event()
        self.onLoadEnd = Event()

    def navigate(self, url): self.navigated.append(url)

    def changeTitle(self, title): pass

    def destroy(self):
        self.onReady.clear(); self.onLoadEnd.clear()


class FakeController(object):
    """BrowserController.pyc: load() as the client runs it for isAsync False, getBrowser, delBrowser, the disconnect."""
    def __init__(self):
        self.browsers = {}
        self.calls = []
        self.contexts = {}
        self.next_id = 1
        self.kind = FakeWebBrowser
        self.onBrowserAdded = Event()
        self.onBrowserDeleted = Event()

    def getBrowser(self, browser_id):
        return self.browsers.get(browser_id)

    def load(self, url=None, title=None, showActionBtn=True, showWaiting=True, browserID=None, isAsync=False,
             browserSize=None, isDefault=True, callback=None, showCloseBtn=False, useBrowserWindow=True, isModal=False,
             showCreateWaiting=False, handlers=None, showBrowserCallback=None, isSolidBorder=False):
        self.calls.append(dict(url=url, browserID=browserID, isAsync=isAsync, browserSize=browserSize, showWaiting=showWaiting))
        controller = self

        def operation(done):
            browser_id = browserID
            if browser_id is None:
                browser_id = controller.next_id
                controller.next_id += 1
            if browser_id in controller.browsers:
                controller.browsers[browser_id].navigate(url)   # 'CTRL: Re-navigating an existing browser'
            else:
                controller.browsers[browser_id] = controller.kind(browser_id, url)
                controller.contexts[browser_id] = showBrowserCallback
                controller.onBrowserAdded(browser_id)
            done(browser_id)
        return operation

    def ready(self, browser_id):
        """The engine reports the browser created: 'READY success: True', 'CTRL: Showing a browser', the callback."""
        web = self.browsers[browser_id]
        web.onReady(web.url, True)
        shown = self.contexts.get(browser_id)
        if shown: shown()

    def delBrowser(self, browser_id):
        """The user closes the window: 'CTRL: Deleting a browser', the browser destroyed, then onBrowserDeleted."""
        web = self.browsers.pop(browser_id)
        web.destroy()
        self.onBrowserDeleted(browser_id)
        return web

    def stop(self):
        """A disconnect (BrowserController.__stop): every browser destroyed, onBrowserDeleted not called."""
        while self.browsers:
            self.browsers.popitem()[1].destroy()


class Browser(object):
    """lobby/Browser.pyc with meta/BrowserMeta.pyc: what the view does with its browser and what it tells Flash."""
    def __init__(self):
        self.__browserID = None
        self.__browser = None
        self.__size = None
        self.flash = []
        self.bitmap = None

    def init(self, browserID, webHandlersMap=None, alias=''):
        if self.__browserID == browserID: return
        self.__browserID = browserID
        self.__browser = controller.getBrowser(browserID)
        self.__prepareBrowser()
        return 'inited'

    def __prepareBrowser(self):
        self.__browser.onResized += self.__onResized
        if self.__size is not None: self.__browser.updateSize(self.__size)
        self.bitmap = self.as_loadBitmapS('img://webview/%s' % self.__browserID)

    def setBrowserSize(self, width, height, scale):
        self.__size = (width, height, scale)
        if self.__browser is not None: self.__browser.updateSize(self.__size)

    def invalidateView(self):
        if self.__browser is not None: self.__browser.invalidateView()

    def __onResized(self, width, height):
        self.as_resizeS(width, height)

    def as_loadBitmapS(self, url):
        self.flash.append(('loadBitmap', url))
        return 'flash'

    def as_resizeS(self, width, height): self.flash.append(('resize', width, height))

    def as_loadingStartS(self, show): self.flash.append(('loadingStart', show))

    def as_loadingStopS(self): self.flash.append(('loadingStop',))


controller = FakeController()
timers = []
messages = []
CLIENT_INIT = Browser.__dict__['init']


def fire(pick, limit=None):
    """Run and drop the timers whose delay `pick` accepts (the first `limit` of them), in the order they were set."""
    due = [t for t in timers if pick(t[0])][:limit]
    for t in due: timers.remove(t)
    for delay, fn in due: fn()
    return len(due)


def install_client():
    """The client modules open_in_game imports, each with the few names it uses."""
    def module(name, **names):
        mod = types.ModuleType(name)
        for key, value in names.items(): setattr(mod, key, value)
        sys.modules[name] = mod
        return mod

    class SM_TYPE(object):
        Error = 'Error'

    system_messages = types.ModuleType('gui.SystemMessages')
    system_messages.SM_TYPE = SM_TYPE
    system_messages.pushMessage = lambda text, type=None: messages.append(text)
    sys.modules['gui.SystemMessages'] = system_messages
    module('gui', SystemMessages=system_messages)
    for name in ('gui.Scaleform', 'gui.Scaleform.daapi', 'gui.Scaleform.daapi.view', 'gui.Scaleform.daapi.view.lobby'): module(name)
    module('gui.Scaleform.daapi.view.lobby.Browser', Browser=Browser)

    class IBrowserController(object): pass
    dependency = types.ModuleType('helpers.dependency')
    dependency.instance = lambda cls: controller
    sys.modules['helpers.dependency'] = dependency
    module('helpers', dependency=dependency)
    module('skeletons')
    module('skeletons.gui')
    module('skeletons.gui.game_control', IBrowserController=IBrowserController)
    module('GUI', screenResolution=lambda: (2560.0, 1440.0))
    module('BigWorld', screenSize=lambda: (2560.0, 1440.0),
           callback=lambda delay, fn: timers.append((delay, fn)) or len(timers), cancelCallback=lambda handle: None,
           time=lambda: 0.0)

    class W2CSchema(object): pass
    web_api = types.ModuleType('web.web_client_api')
    web_api.W2CSchema = W2CSchema
    web_api.Field = lambda **kw: None
    web_api.createCommandHandler = lambda name, schema, handler, extra=None: (name, handler)
    sys.modules['web.web_client_api'] = web_api
    module('web', web_client_api=web_api)


def nothing_left(web, view, what):
    """Nothing of the mod on this browser, this view, the view's class or the controller."""
    left = []
    if web is not None:
        own = [n for n in ('updateSize', 'invalidateView') if n in vars(web)]
        if own: left.append('browser attributes %s' % own)
        for name in ('onReady', 'onLoadStart', 'onLoadEnd', 'onResized', 'onTextureStateChanged'):
            mine = [h for h in getattr(web, name, []) if getattr(h, '__name__', '') == 'handler']
            if mine: left.append('%s handler' % name)
    if view is not None:
        own = [n for n in ('as_loadBitmapS', 'as_resizeS', 'as_loadingStartS', 'as_loadingStopS', 'setBrowserSize') if n in vars(view)]
        if own: left.append('view attributes %s' % own)
    if Browser.__dict__['init'] is not CLIENT_INIT: left.append('the view class init')
    if len(controller.onBrowserDeleted): left.append('%d onBrowserDeleted listener(s)' % len(controller.onBrowserDeleted))
    return check(not left, what, left)


temp = tempfile.mkdtemp(prefix='bullba-window-')
try:
    install_client()
    from local_armor_inspector import presentation
    viewer = os.path.join(temp, 'Viewer.html')
    with open(viewer, 'wb') as stream: stream.write('<!doctype html>')

    # ---- his open: the mods list button, the vehicle of the hangar ----
    presentation.open_in_game(viewer, 'host=game&vehicle=china-Ch67_BZ_79')
    check(len(controller.calls) == 1, 'the window is asked for once', controller.calls)
    call = controller.calls[0] if controller.calls else {}
    url = call.get('url') or ''
    check(url.startswith('file:///') and url.endswith('Viewer.html#host=game&vehicle=china-Ch67_BZ_79'),
          'the address is the local page with host=game and the vehicle', url)
    check(call.get('browserSize') == (2355, 1267), 'the window takes 92 % by 88 % of a 2560x1440 client', call.get('browserSize'))
    check(call.get('isAsync') is False, 'the window is still shown when the browser is ready, not after the page load (isAsync)')
    web = controller.getBrowser(presentation._browser_id) if presentation._browser_id is not None else None
    if check(web is not None, 'the mod knows its browser by the id the controller gave'):
        # The client's order in both of his blank opens (game.log, relative times of 03.10 00:02:08):
        controller.ready(web.id)                       # +0.009 s READY success: True, CTRL: Showing a browser
        check(logged('in-game window shown') == 1, 'the mod writes that the window was shown')
        # The window's Flash file loads: a view of ANOTHER window registers first (the game's own browser), then this one's.
        other = Browser()
        controller.browsers[99] = FakeWebBrowser(99, 'https://example.invalid/')
        other.init(99)
        check(not [n for n in vars(other) if n.startswith('as_')] and logged('Flash component registered') == 0,
              'a view of another window is not touched and not written')
        view = Browser()
        result = view.init(web.id)                     # Browser.init -> __prepareBrowser -> as_loadBitmapS
        view.setBrowserSize(2355, 1267, 1.0)           # Flash draw(): the size, sent on through WebBrowser.updateSize
        view.invalidateView()                          # Flash updatePosition(): the client's one request to draw
        web.report('onLoadStart', web.url)
        web.report('onLoadEnd', web.url, True, 0)      # the page: its scripts run from +0.10 s, the scene at +0.54 s
        web.report('onTextureStateChanged', True)      # +0.63 s onTextureStateChanged isOk: True
        web.report('onResized', 2355, 1267)            # the engine's answer to the size the Flash component sent
        web.report('onTextureStateChanged', True)      # +0.65 s onTextureStateChanged isOk: True

        # ---- the part of the chain between the browser's frame and the game's window is listened to and written ----
        check(len(web.onTextureStateChanged) >= 1, 'the mod listens to the texture state of its browser',
              '%d handlers' % len(web.onTextureStateChanged))
        check(len(web.onResized) >= 1, 'the mod listens to the engine\'s resize report of its browser',
              '%d handlers' % len(web.onResized))
        check(len(web.onLoadEnd) >= 1, 'the mod listens to the end of the page load of its browser',
              '%d handlers' % len(web.onLoadEnd))
        check(logged('Bullba Hits', 'texture') >= 2, 'both texture reports are written, each on its own line',
              '%d lines' % logged('Bullba Hits', 'texture'))
        check(logged('Bullba Hits', 'resize', '2355') >= 1, 'the resize report is written with the size',
              '%d lines' % logged('Bullba Hits', 'resize', '2355'))
        check(logged('Bullba Hits', 'load', 'end') + logged('Bullba Hits', 'loaded') >= 1, 'the end of the page load is written',
              'no line')
        expected = ['browser 1 created', 'ready', 'Flash component registered, no size yet', 'Flash asked to load the bitmap',
                    'size sent 2355x1267', 'client asked redraw', 'load start', 'load end ok; redraw asked',
                    'texture ok; redraw asked', 'resized 2355x1267', 'Flash told the size 2355x1267', 'texture ok; redraw asked']
        check(steps() == expected, 'his open is written step by step, one line a step, in the order of the calls', steps())
        chain = [l for l in lines() if l.startswith('Bullba Hits window +')]
        check(len(chain) == len(expected) and all(re.match(r'Bullba Hits window \+\d+ ms: ', l) for l in chain),
              'every step carries the milliseconds since the open')
        check(not [l for l in chain if 'file:' in l or 'Viewer.html' in l or '://' in l], 'no step carries an address')
        check(re.search(r'in-game window shown \(\+\d+ ms\)', '\n'.join(lines())) is not None, 'the shown line carries them too')
        check(not lines(logging.WARNING) and not lines(logging.ERROR), 'nothing is warned of on a client that has it all',
              lines(logging.WARNING) + lines(logging.ERROR))

        # ---- the client is left as it was ----
        check(result == 'inited' and view.bitmap == 'flash' and web.sizes == [(2355, 1267, 1.0)],
              'the client\'s calls pass through with their arguments and results', (result, view.bitmap, web.sizes))
        check(view.flash == [('loadBitmap', 'img://webview/1'), ('resize', 2355, 1267)], 'Flash is told what it was told before',
              view.flash)
        check(Browser.__dict__['init'] is CLIENT_INIT, 'the view class has its own init back once the window\'s view registered')
        check(other.flash == [('loadBitmap', 'img://webview/99')] and controller.browsers[99].invalidated == 0,
              'the other window got its own calls and no redraw request')

        # ---- the one thing done: the browser is asked to draw again ----
        check(web.invalidated == 1 and web.reentered == 0 and len([t for t in timers if t[0] == 0]) == 3,
              'no redraw is asked from inside the engine\'s own report: each waits for the next tick',
              (web.invalidated, web.reentered, [t[0] for t in timers]))
        check(fire(lambda d: d == 0) == 3 and web.invalidated == 4 and web.reentered == 0,
              'a redraw is asked after the load end and after each texture report (3, and the client\'s 1)', web.invalidated)
        check(len([t for t in timers if t[0] < 20]) == 6 and fire(lambda d: d < 20) == 6 and web.invalidated == 6
              and steps()[-2:] == ['redraw asked again', 'redraw asked again'],
              'and twice more after the last report, the earlier reports\' timers doing nothing', (web.invalidated, steps()[-3:]))
        # A burst of reports with no tick between them: the bound is counted when a redraw is scheduled, not when it runs.
        for _ in range(20): web.report('onTextureStateChanged', True)
        left = presentation.TRACE_REDRAWS - 5
        check(len([t for t in timers if t[0] == 0]) == left and web.invalidated == 6,
              'a burst of reports schedules no more than the bound leaves', [t[0] for t in timers])
        check(len([t for t in timers if 0 < t[0] < 20]) == 2 * (left - 1),
              'no later timers are set once the bound is reached', [t[0] for t in timers])
        fire(lambda d: d < 20)
        check(web.invalidated == 1 + presentation.TRACE_REDRAWS and web.reentered == 0 and logged('redraw asked again') == 2,
              'never more than TRACE_REDRAWS times a page', (web.invalidated, web.reentered, logged('redraw asked again')))
        check(logged('texture ok') == 22 and logged('texture ok; redraw asked') == 5, 'the reports are still written past the bound',
              (logged('texture ok'), logged('texture ok; redraw asked')))
        web.report('onTextureStateChanged', True)
        check(not [t for t in timers if t[0] < 20], 'past the bound a report sets no timer at all', [t[0] for t in timers])

        # ---- a failure inside the mod never reaches the client's handlers ----
        try:
            web.report('onResized', 'wide', None)      # the mod's line cannot be formed; the view's handler stands behind it
            raised = None
        except Exception as error:
            raised = error
        check(raised is None and view.flash[-1] == ('resize', 'wide', None) and len(lines(logging.WARNING)) == 2,
              'a failure of the mod\'s own steps (the report, the call to Flash) is said and the client\'s handler behind still runs',
              (raised, view.flash[-1], lines(logging.WARNING)))
        web.onResized('wide', None)
        check(len(lines(logging.WARNING)) == 2 and view.flash[-2:] == [('resize', 'wide', None)] * 2,
              'said once a step, not on every report', lines(logging.WARNING))

        # ---- the window is open and the hangar menu points it at another vehicle: the same browser, re-navigated ----
        before = (len(web.onTextureStateChanged), len(web.onResized), len(web.onLoadEnd))
        presentation.open_in_game(viewer, 'host=game&vehicle=france-F135_AS_XX_40_t')
        check(controller.getBrowser(presentation._browser_id) is web and len(web.navigated) == 1,
              'an open window is re-navigated, not created again', web.navigated)
        after = (len(web.onTextureStateChanged), len(web.onResized), len(web.onLoadEnd))
        check(after == before and min(after) >= 1, 'a re-navigated window is listened to once, not twice',
              '%r -> %r' % (before, after))
        asked = web.invalidated
        web.report('onLoadEnd', web.url, True, 0)
        check(steps()[-2:] == ['re-navigated', 'load end ok; redraw asked'] and fire(lambda d: d == 0) == 1
              and web.invalidated == asked + 1 and web.reentered == 0,
              'the re-navigation is a step and its page load asks for a redraw again', steps()[-2:])

        # ---- the 20 s alarm of the path as it is: silent for a window that was shown ----
        count = len(lines())
        fire(lambda d: d >= 20)
        check(not messages and logged('did not report opening') == 0 and len(lines()) == count,
              'no alarm and no line at 20 s for a window that was shown and whose view registered', messages)

        # ---- he closes the blank window ----
        asked = web.invalidated
        behind = []
        controller.onBrowserDeleted += behind.append       # a listener of the client's own, behind the mod's
        controller.delBrowser(web.id)
        controller.onBrowserDeleted -= behind.append
        check(steps()[-1] == 'destroyed; redraws %d' % (presentation.TRACE_REDRAWS + 1),
              'the closing is the last step and says how many redraws were asked', steps()[-1:])
        check(behind == [web.id], 'the client\'s listener behind the mod\'s is still called', behind)
        nothing_left(web, view, 'a closed window leaves nothing of the mod on the client, at once')
        count = len(lines())
        fire(lambda d: d < 20)
        web.hasBrowser = True
        view.as_resizeS(1, 1)
        check(web.invalidated == asked and len(lines()) == count, 'no redraw request and no line after the window closed',
              (web.invalidated, asked))

        # ---- and opens it again: a new browser under the same id, followed again; the size comes before the bitmap ----
        presentation.open_in_game(viewer, 'host=game&vehicle=china-Ch67_BZ_79')
        again = controller.getBrowser(presentation._browser_id)
        if check(again is not None and again is not web, 'the reopened window is a new browser'):
            controller.ready(again.id)
            check(len(again.onTextureStateChanged) >= 1 and len(again.onResized) >= 1 and len(again.onLoadEnd) >= 1,
                  'the reopened window is listened to as well',
                  '%d/%d/%d handlers' % (len(again.onTextureStateChanged), len(again.onResized), len(again.onLoadEnd)))
            first = len(steps())
            view2 = Browser()
            view2.setBrowserSize(2355, 1267, 1.0)      # Flash draw() before the component registered: the view keeps the size
            view2.init(again.id)
            check(steps()[first:] == ['Flash component registered, its size already set 2355x1267', 'size sent 2355x1267',
                                          'Flash asked to load the bitmap'],
                  'the other order of the size and the bitmap is told apart', steps()[first:])

            # ---- the mod leaves with the window open (fini): the client's own handlers stay, the mod's go ----
            presentation.close_window_trace()
            check(len(again.onResized) == 1, 'the view\'s own handler stays on the browser', len(again.onResized))
            nothing_left(again, view2, 'the mod leaving takes everything of its own off an open window')
            asked = again.invalidated
            again.report('onTextureStateChanged', True)
            fire(lambda d: d < 20)
            check(again.invalidated == asked, 'and asks for nothing after it left')
            controller.delBrowser(again.id)
            fire(lambda d: d >= 20)

        # ---- a disconnect: the client destroys the browser and tells nobody ----
        presentation.open_in_game(viewer, 'host=game')
        lost = controller.getBrowser(presentation._browser_id)
        controller.ready(lost.id)
        view3 = Browser()
        view3.init(lost.id)
        lost.report('onLoadEnd', lost.url, True, 0)
        controller.stop()
        asked = lost.invalidated
        lost.hasBrowser = True
        fire(lambda d: d < 20)
        check(lost.invalidated == asked, 'a browser the client dropped silently is asked for nothing')
        nothing_left(lost, view3, 'and is let go at the next timer')
        fire(lambda d: d >= 20)

        # ---- a view that never registers: the class init is the mod's until the window closes ... ----
        presentation.open_in_game(viewer, 'host=game')
        check(Browser.__dict__['init'] is not CLIENT_INIT, 'while the window\'s view is awaited the class init is the mod\'s')
        controller.delBrowser(presentation._browser_id)
        check(steps()[-1] == 'destroyed before ready; redraws 0', 'a window closed before its browser was ready says so',
              steps()[-1:])
        nothing_left(None, None, 'and it is taken back when the window closes without one')
        # ... and that older open's 20 s timer does not take the hook of a newer window that still waits for its view
        presentation.open_in_game(viewer, 'host=game')
        check(fire(lambda d: d >= 20, limit=1) == 1 and Browser.__dict__['init'] is not CLIENT_INIT,
              'the 20 s timer of an earlier open leaves a newer window\'s wait alone')
        # ... or, when nothing ever says the window is gone, for 20 s at most: no page load, a silent drop, no further open
        quiet = controller.getBrowser(presentation._browser_id)
        controller.ready(quiet.id)
        controller.stop()
        check(not [t for t in timers if t[0] < 20] and Browser.__dict__['init'] is not CLIENT_INIT,
              'with no report and no closing nothing but the 20 s timer is left to take it back')
        fire(lambda d: d >= 20)
        check(Browser.__dict__['init'] is CLIENT_INIT and steps()[-1] == 'no Flash component registered in 20 s',
              'the view class has its own init back after 20 s at most, and the line says why', steps()[-1:])
        presentation.close_window_trace()
        nothing_left(quiet, None, 'that window leaves nothing either')

        # ---- a client without these events and calls: the window still opens, each gap is said once ----
        del logs.records[:]
        del messages[:]        # the alarm of the window above that never became ready was a true one
        controller.kind = BareWebBrowser
        presentation._warned.clear()
        presentation.open_in_game(viewer, 'host=game')
        bare = controller.getBrowser(presentation._browser_id)
        try:
            controller.ready(bare.id)
            bare.onLoadEnd(bare.url, True, 0)
            bare.onLoadEnd(bare.url, False, 404)
            failed = None
        except Exception as error:
            failed = error
        fire(lambda d: d < 20)
        check(failed is None and logged('in-game window shown') == 1 and not messages,
              'a browser without the texture and resize events and without invalidateView still opens', (failed, messages))
        check(steps() == ['browser 1 created', 'ready', 'load end ok', 'load end FAILED (code 404)'],
              'what it does report is written', steps())
        warned = lines(logging.WARNING)
        check(len(warned) == len(set(warned)) and 4 <= len(warned) <= 7 and logged('could not be asked to draw again') == 1,
              'each thing it lacks is said once', warned)
        controller.delBrowser(bare.id)
        nothing_left(None, None, 'and nothing is left of that window either')
except Exception:
    import traceback
    check(False, 'the test ran to its end', traceback.format_exc())
finally:
    import shutil
    shutil.rmtree(temp, ignore_errors=True)
report.append('%d checks, %d failed' % (len(report), len(failures)))
report.append('ALL OK' if not failures else 'FAILED: %d' % len(failures))
text = 'exit %d\n%s\n' % (1 if failures else 0, '\n'.join(report))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
if RESULT:
    with open(RESULT, 'wb') as stream: stream.write(text)
else:
    sys.stdout.write(text)
