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


def open_in_game(path):
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
        url += '#host=game'
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
        shown = [False]
        def on_shown(*args):
            shown[0] = True
            LOG.info('Bullba Hits in-game window shown')
        def check_opened():
            if not shown[0]:
                LOG.warning('Bullba Hits window did not report opening')
                SystemMessages.pushMessage(u'Bullba Hits: встроенное окно не загрузилось. Подробности в game.log.', type=SystemMessages.SM_TYPE.Error)
        # adisp_async returns a callable, not an already running operation.
        operation = browser.load(url=url, title='Bullba Hits', browserID=_browser_id,
                     showActionBtn=False, showCloseBtn=True, showWaiting=True,
                     showCreateWaiting=False, useBrowserWindow=True, isModal=False,
                     browserSize=(max(640, int(width * .92)), max(480, int(height * .88))),
                     showBrowserCallback=on_shown, handlers=[])
        operation(loaded)
        import BigWorld
        BigWorld.callback(20, check_opened)
    except Exception:
        LOG.exception('Bullba Hits in-game window could not be opened')
        SystemMessages.pushMessage(u'Bullba Hits: встроенное окно недоступно. Локальную историю можно открыть ярлыком Bullba Hits после выхода из игры.', type=SystemMessages.SM_TYPE.Error)
