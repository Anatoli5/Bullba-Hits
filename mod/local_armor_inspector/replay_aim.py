# -*- coding: utf-8 -*-
"""The player's own aim circles at a shot, rebuilt from the replay (BACKLOG 82, 12.11.2026).

The page draws three figures at an own shot (web/viewer.js, web/shot-context.js): the solid ring (the client reticle at
the press), the dashed ring (the server reticle at the press) and the thick disc (the server update the shell left from).
Today all three come from the recorder's in-battle snapshot (the command's 'aim', the tracer's 'aimAtTracer' and the
'gunAfterShot' record). This module rebuilds them from the replay's own packets, as measured on 321 own shots of the 33
battles of 11.11.2026 (outputs/aim-circles-from-replay-2026-11-11.md):

  0x39  the server's gun marker of the own vehicle, one per server tick: gun position, shot vector, dispersion angle;
  0x1a  the replay controller's gun-marker state, one per tick: 0-2 the point under the cursor the gun turns to, 3-10 the
        marker last given to setGunMarkerParams (the SERVER reticle while it is shown: diameter, dual-accuracy diameter,
        position, the shell's direction there), 11 the arcade (client) reticle's diameter;
  0x1f  the client's ping (ms), with the tick.

The replay holds no fire command, so the press is found back from the own tracer: press = tracer clock - (ping + 0.05 s)
(PRESS_EXTRA; the measured best single rule). Track collects the three series while the converter is fed (small arrays,
float32 as the stream carries them); Track.block() builds the block of one own tracer once the stream is read, and
replay_records.Converter puts it on the tracer record under KEY. compare() measures the block against the snapshot the
page would draw (attach(), called by replay_battle.build where both exist), as replay_scene does for a hit's scene.

Block fields carry the snapshot's own names, so the page can draw one or the other with the same code:
  clientMarker {position, direction, diameter, gameTime, approximate, from}, serverMarker {position, direction, diameter,
  dualAccDiameter, gameTime, from}, lastServerGunUpdate {origin, vector, dispersionAngle, gameTime, tick} (the update
  the dashed ring was made from), gunOrigin, desiredPoint; and shotUpdate {origin, vector, dispersionAngle, gameTime,
  tick, gap, from} - the update the shell left from, what shot-context.js serverShot() finds for the disc.
  press {gameTime, tracerGameTime, ping, delta, rule}, markerSource, markerCheck, limits, absent, comparison.
  replay_battle.build adds receivedAt to each part (the tracer's receipt moved by the gameTime difference) where the
  tracer has one, so the page's own receipt windows apply.

No server reticle given (read from the code, VehicleGunRotator 2.4.1.1): with the server reticle hidden setShotPosition
returns before setGunMarkerParams and __updateGunMarker writes the client's marker every frame instead, so fields 3-10 hold
the CLIENT reticle of the last frame - and whether the server sends 0x39 at all then is the server's (Avatar.enableServerAim
-> cell.setServerMarker). Told apart by the data: while fields 3-10 are the server's, the shell's direction there (8-10)
has the azimuth of the shot vector of a 0x39 near it (up to 6 updates before, 4 after: the two packets' clocks of one
tick differ by up to 0.3 s) to float precision - the horizontal velocity of a flight does not change; the share of such
samples within SHOWN_WINDOW of the press decides. Measured 12.11.2026 on the 321 own shots of 11.11 (server reticle
shown in every battle): 273 shots have it, each one whose recorded server reticle is at most 0.15 s old; the other 48 are
exactly those whose recorded server reticle was 0.15-26 s old - the game was not updating it then, and fields 3-10 are
no 0x39's. Such a shot gets no serverMarker; its client reticle is centred on the cursor point and sized by field 3 (on
those 48 the snapshot's client reticle stood 2.5 radii / 0.18 m off the cursor point in the median, 2.7 / 0.34 m off
fields 5-7; size ratio median 0.99 by field 3, 0.77 by field 11; docs/KNOWLEDGE.md section 18).

Pure: no game module; the client's Python 2.7 and CPython 3.
"""
from __future__ import absolute_import, division
import math
from array import array
from bisect import bisect_left, bisect_right

KEY = 'replayAim'
FORMAT = 1
SOURCE = 'replay'
# press = tracer clock - (ping + PRESS_EXTRA); without a ping packet before the tracer, a fixed PRESS_NO_PING (the best
# fixed delay measured was 0.10-0.12 s: 53 % of the fresh dashed rings exact, against 58 % with the ping).
PRESS_EXTRA = 0.05
PRESS_NO_PING = 0.10
RULE = 'tracer - (ping + 0.05 s)'
RULE_NO_PING = 'tracer - 0.10 s (no ping before the tracer)'
EPS = 1e-6                # a sample "at or before" a moment: its clock <= the moment + EPS (the prototype's rule)
BEFORE = 1e-4             # the disc: a 0x39 strictly before the tracer's packet
SAME_INSTANT = 1e-3       # the tracers of one salvo: the same clock
ORIGIN_GAP = 0.05         # m: the update whose gun position is the shell's origin (shot-context.js STALE_GAP)
DISC_BACK = 3             # the disc: the updates looked at before the tracer, and one after
SHOWN_WINDOW = (0.3, 0.1)  # s before / after the press: the 0x1a samples that say which reticle fields 3-10 hold
SHOWN_SHARE = 0.5
SERVER_SPREAD = (6, 4)    # the 0x39 a 0x1a sample was made from: up to 6 updates before it, 4 after (measured offsets)
SAME_AZIMUTH = 2e-5       # rad: fields 8-10 are the shell's direction of that 0x39 (float32 of the same flight)
# compare(): what counts as the same figure (the measurement's own thresholds)
SAME_POSITION = 1e-3
SAME_DIAMETER = 1e-5
SAME_ANGLE = 1e-6
SAME_DISPERSION = 1e-7
NEAR = 1.0                # m: a marker nearer the gun than this is not compared (no ring size to speak of)
SNAPSHOT_WINDOW = 0.5     # the page's own windows (shot-context.js resolve)
SALVO_WINDOW = 1.5
COMMAND_WINDOW = 1.5
SERVER_RECEIPT = 0.02     # viewer.js: the dashed ring's gun is its update's origin when received within 0.02 s of it
# The snapshot's fields the replay has no counterpart of (telemetry.ShotTelemetry.snapshot).
ABSENT = ('dispersionAngles', 'gunVelocity', 'gunDirection', 'turretYaw', 'gunPitch', 'turretRotationSpeed',
          'vehicleSpeeds', 'targeting', 'selectedShell', 'baseDispersionAngle')
LIMITS = (
    'press: estimated, the replay has no fire command; one server tick uncertain, 0.2-0.4 s for a gun with a delayed shot',
    'clientMarker: approximate - the point under the cursor and the arcade reticle diameter of the tick before the press; '
    'the client gun axis at the press is not recorded: near-exact with the gun still (median 0.04 radius), 1-2 radii off '
    'while the gun turns',
    'gunOrigin: the server gun position at the press (0x39), not the client muzzle',
    'not recorded: the client dispersion pair, the shell selected at the press, speeds, turret rotation, targeting factors, '
    'the client reticle per frame; turret yaw and gun pitch are in the replay (0x1c/0x1d) but not taken here',
)
LIMIT_HIDDEN = ('server reticle not given at the press (0x1a fields 3-10 matched no server update): no dashed ring - the '
                'game was not updating it (on 11.11 so at 48 of 321 shots, exactly those whose recorded server reticle '
                'was 0.15-26 s old) or it is hidden')
LIMIT_NO_SERVER = 'no server gun update (0x39) before the press: no dashed ring, no disc, no gun position'


def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _norm(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _angle(a, b):
    """The angle between two vectors, robust for tiny angles; None for a zero vector."""
    na, nb = _norm(a), _norm(b)
    if not na or not nb: return None
    a, b = [x / na for x in a], [x / nb for x in b]
    c = max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
    cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    return math.atan2(_norm(cross), c)


def _at(times, clock):
    """Index of the last sample at or before `clock` (-1 when none)."""
    return bisect_right(times, clock + EPS) - 1


def _floats(values):
    return [float(v) for v in values]


class Track(object):
    """The three aim series of one battle, fed with the decoder's events in stream order (replay clocks never go back)."""
    KINDS = frozenset(('client_gun_marker', 'server_gun_marker', 'net_stats'))

    def __init__(self):
        self.marker_t, self.marker = array('d'), array('f')      # 0x1a: 15 floats a sample
        self.server_t, self.server = array('d'), array('f')      # 0x39: gun position 3, shot vector 3, dispersion
        self.ticks = []
        self.net_t, self.ping = array('d'), array('d')           # 0x1f: ping, ms

    def feed(self, ev):
        kind, t = ev.get('ev'), float(ev.get('t') or 0.0)
        if kind == 'client_gun_marker':
            values = (list(ev['point']) + [ev['markerDiameter'], ev['dualAccDiameter']] + list(ev['markerPosition'])
                      + list(ev['markerDirection']) + [ev['arcadeDiameter'], ev['dualAccSize']] + list(ev['spg']))
            if len(values) != 15: return
            self.marker_t.append(t)
            self.marker.extend(_floats(values))
        elif kind == 'server_gun_marker':
            values = list(ev['gunPosition']) + list(ev['shotVector']) + [ev['dispersion']]
            if len(values) != 7: return
            self.server_t.append(t)
            self.server.extend(_floats(values))
            self.ticks.append(int(ev.get('tick') or 0))
        elif kind == 'net_stats':
            self.net_t.append(t)
            self.ping.append(float(ev.get('ping') or 0))

    def sample(self, j):
        return list(self.marker[15 * j:15 * j + 15])

    def update(self, k, start):
        v = self.server[7 * k:7 * k + 7]
        out = {'origin':_floats(v[0:3]), 'vector':_floats(v[3:6]), 'dispersionAngle':float(v[6]), 'tick':self.ticks[k]}
        if start is not None: out['gameTime'] = float(start) + self.server_t[k]
        return out

    def from_server(self, j):
        """Fields 3-10 of the 0x1a sample j are the server's marker: the shell's direction there (8-10) has the azimuth of
        the shot vector of a 0x39 near it (SERVER_SPREAD updates before / after) to SAME_AZIMUTH."""
        m = self.marker[15 * j:15 * j + 15]
        if math.hypot(m[8], m[10]) < 1e-6: return False
        azimuth = math.atan2(m[8], m[10])
        k = _at(self.server_t, self.marker_t[j])
        for kk in range(max(0, k - SERVER_SPREAD[0]), min(len(self.server_t), k + SERVER_SPREAD[1] + 1)):
            v = self.server[7 * kk + 3:7 * kk + 6]
            if math.hypot(v[0], v[2]) < 1e-6: continue
            d = math.atan2(v[0], v[2]) - azimuth
            if abs(math.atan2(math.sin(d), math.cos(d))) <= SAME_AZIMUTH: return True
        return False

    def server_shown(self, clock):
        """(samples, samples whose fields 3-10 are the server's) within SHOWN_WINDOW of `clock`."""
        lo = bisect_left(self.marker_t, clock - SHOWN_WINDOW[0])
        hi = bisect_right(self.marker_t, clock + SHOWN_WINDOW[1])
        same = 0
        for j in range(lo, hi):
            if self.from_server(j): same += 1
        return hi - lo, same

    def disc(self, clock, origin, start):
        """The server update the shell left from: the last 0x39 strictly before the tracer whose gun position is the
        shell's origin (a salvo's mean) within ORIGIN_GAP, among the DISC_BACK + 1 before it; else the nearest in
        origin among those and the one after (measured 12.11: the page's own pick from the snapshot in 321 of 321)."""
        k0 = _at(self.server_t, clock - BEFORE)
        if not len(self.server_t): return None
        pick, how = None, 'origin'
        for k in range(k0, max(-1, k0 - DISC_BACK - 1), -1):
            if _norm(_sub(self.server[7 * k:7 * k + 3], origin)) <= ORIGIN_GAP:
                pick = k
                break
        if pick is None:
            how = 'nearest'
            cands = list(range(max(0, k0 - DISC_BACK), min(len(self.server_t), k0 + 2)))
            if not cands: return None
            pick = min(cands, key=lambda k: _norm(_sub(self.server[7 * k:7 * k + 3], origin)))
        out = self.update(pick, start)
        out['gap'] = round(_norm(_sub(out['origin'], origin)), 6)   # to the micrometre: the two Pythons' sqrt agree
        out['from'] = how
        return out

    def block(self, clock, origin, start=None, salvo=1):
        """The aim block of one own tracer: `clock` its replay clock, `origin` the shell's origin (a salvo's mean over
        `salvo` tracers), `start` the server time at the recording start (gameTime = start + clock), or None."""
        def game(c): return None if start is None else float(start) + c
        i = _at(self.net_t, clock)
        ping = self.ping[i] / 1000.0 if i >= 0 else None
        delta = ping + PRESS_EXTRA if ping is not None else PRESS_NO_PING
        press = clock - delta
        block = {'format':FORMAT, 'source':SOURCE,
                 'press':{'gameTime':game(press), 'tracerGameTime':game(clock), 'ping':ping, 'delta':delta,
                          'rule':RULE if ping is not None else RULE_NO_PING,
                          'basis':'measured on 321 own shots of 11.11.2026: the server reticle of the press exact in 58 %, '
                                  'otherwise the neighbouring tick (outputs/aim-circles-from-replay-2026-11-11.md)'},
                 'limits':list(LIMITS), 'absent':list(ABSENT)}
        if salvo > 1: block['salvo'] = salvo
        k = _at(self.server_t, press)
        if k >= 0:
            update = self.update(k, start)
            block['lastServerGunUpdate'] = update
            block['gunOrigin'] = list(update['origin'])
        else:
            block['limits'].append(LIMIT_NO_SERVER)
        j = _at(self.marker_t, press)
        if j >= 0:
            m = self.sample(j)
            when = game(self.marker_t[j])
            samples, same = self.server_shown(press)
            shown = k >= 0 and samples > 0 and same >= SHOWN_SHARE * samples
            block['markerSource'] = 'server reticle' if shown else 'client reticle'
            block['markerCheck'] = {'samples':samples, 'fromServer':same}
            block['desiredPoint'] = m[0:3]
            if shown:
                block['serverMarker'] = {'position':m[5:8], 'direction':m[8:11], 'diameter':m[3], 'dualAccDiameter':m[4],
                                         'from':'0x1a fields 3-10 at the press'}
                client = {'position':m[0:3], 'direction':m[8:11], 'diameter':m[11], 'approximate':True,
                          'from':'0x1a: the point under the cursor (0-2), the arcade reticle diameter (11)'}
            else:
                block['limits'].append(LIMIT_HIDDEN)
                # Field 3 is metres at its own point (5-7): the same angle carried to the cursor point's distance.
                diameter, gun = m[3], block.get('gunOrigin')
                if gun is not None and _norm(_sub(m[5:8], gun)) > NEAR:
                    diameter = round(m[3] * _norm(_sub(m[0:3], gun)) / _norm(_sub(m[5:8], gun)), 6)
                client = {'position':m[0:3], 'direction':m[8:11], 'diameter':diameter, 'approximate':True,
                          'from':'0x1a: the point under the cursor (0-2), the client reticle angle (3 at 5-7: no server one)'}
            if when is not None:
                client['gameTime'] = when
                if 'serverMarker' in block: block['serverMarker']['gameTime'] = when
            block['clientMarker'] = client
        disc = self.disc(clock, origin, start) if origin is not None else None
        if disc is not None: block['shotUpdate'] = disc
        return block


# ---- the comparison with the snapshot the page draws (replay_battle.build) -------------------------------------------
def command_of(tracer, commands):
    """shot-context.js commandOf(): the command the tracer names, else the shooter's last within COMMAND_WINDOW before it."""
    if not tracer or not tracer.get('own'): return None
    named = tracer.get('possibleCommandId')
    for c in commands:
        if named is not None and c.get('id') == named: return c
    at = tracer.get('receivedAt')
    if not isinstance(at, (int, float)): return None
    before = [c for c in commands if c.get('shooterId') == tracer.get('shooterId') and isinstance(c.get('receivedAt'), (int, float))
              and c['receivedAt'] <= at and at - c['receivedAt'] <= COMMAND_WINDOW]
    return before[-1] if before else None


def usable(aim, stamp, window):
    m = (aim or {}).get('clientMarker')
    return bool(m and (m.get('diameter') or 0) > 0 and m.get('position') and m.get('direction')
                and isinstance(m.get('receivedAt'), (int, float)) and isinstance(stamp, (int, float))
                and abs(stamp - m['receivedAt']) <= window)


def snapshot(tracer, command):
    """(aim, which) the page draws for the tracer (shot-context.js resolve: the command's, the tracer's, the salvo's)."""
    sources = []
    if command and command.get('aim'): sources.append((command['aim'], 'command', command.get('receivedAt'), SNAPSHOT_WINDOW))
    if tracer.get('aimAtTracer'): sources.append((tracer['aimAtTracer'], 'tracer', tracer.get('receivedAt'), SNAPSHOT_WINDOW))
    if command and command.get('aim'): sources.append((command['aim'], 'salvo', tracer.get('receivedAt'), SALVO_WINDOW))
    for aim, which, stamp, window in sources:
        if usable(aim, stamp, window): return aim, which
    return None, None


def server_shot(tracer, salvo, after):
    """shot-context.js serverShot(): (update, from, stale) of the snapshot's disc, or None. `salvo` the own tracers of the
    instant (the tracer among them), `after` the gunAfterShot records."""
    def valid(u): return bool(u and isinstance(u.get('vector'), list) and isinstance(u.get('origin'), list)
                              and (u.get('dispersionAngle') or 0) > 0)
    last = (tracer.get('aimAtTracer') or {}).get('lastServerGunUpdate')
    if not valid(last) or not isinstance(tracer.get('origin'), list): return None
    origin = [sum(e['origin'][i] for e in salvo) / len(salvo) for i in range(3)]
    if _norm(_sub(last['origin'], origin)) <= ORIGIN_GAP: return last, 'last', False
    ids = set(e.get('id') for e in salvo)
    record = next((a for a in after if a.get('tracerId') in ids), None)
    for u in (record or {}).get('updates') or ():
        if valid(u) and _norm(_sub(u['origin'], origin)) <= ORIGIN_GAP: return u, 'after', False
    return last, 'last', True


def compare(block, aim, which, origin, end=None, stamp=None, disc=None):
    """The block against the snapshot the page draws (the measurement's units): per ring the centre's angular offset in
    radii of the snapshot's ring and in metres at the shot's range, the size ratio (replay / snapshot); 'same' when the
    figure is the snapshot's to float precision. `origin` the tracer's, `end` the shell's end (else the range is the
    snapshot reticle's), `stamp` the press's receipt (the command's, else the client reticle's) for the server reticle's
    age, `disc` server_shot()'s result."""
    out = {'snapshot':which}
    shot = block.get('shotUpdate')
    if disc and shot:
        update, how, stale = disc
        a = _angle(shot['vector'], update['vector'])
        out['disc'] = {'same':a is not None and a < SAME_ANGLE
                       and abs(shot['dispersionAngle'] - update['dispersionAngle']) < SAME_DISPERSION,
                       'angle':a, 'dispersionRatio':shot['dispersionAngle'] / update['dispersionAngle'],
                       'snapshotFrom':how, 'snapshotStale':stale}
    aim = aim or {}
    cm, sm, last, gun = aim.get('clientMarker') or {}, aim.get('serverMarker'), aim.get('lastServerGunUpdate'), aim.get('gunOrigin')
    if not (cm.get('position') and gun): return out
    c_dir = _sub(cm['position'], gun)
    if _norm(c_dir) <= 0 or not (cm.get('diameter') or 0) > 0: return out
    rng = _norm(_sub(end, origin)) if end and origin else _norm(c_dir)
    out['range'] = rng
    c_rad = cm['diameter'] / 2.0 / _norm(c_dir)
    rc, g = block.get('clientMarker'), block.get('gunOrigin')
    if rc and g:
        los = _sub(rc['position'], g)
        if _norm(los) > NEAR:
            a = _angle(los, c_dir)
            row = {'centreRadii':a / c_rad, 'centreMetres':a * rng}
            if rc.get('diameter', 0) > 0: row['sizeRatio'] = rc['diameter'] / 2.0 / _norm(los) / c_rad
            out['clientMarker'] = row
    if sm and sm.get('position') and (sm.get('diameter') or 0) > 0:
        recv = sm.get('receivedAt')
        if (last and isinstance(last.get('origin'), list) and isinstance(recv, (int, float))
                and isinstance(last.get('receivedAt'), (int, float)) and abs(last['receivedAt'] - recv) < SERVER_RECEIPT):
            s_dir = _sub(sm['position'], last['origin'])
        else:
            s_dir = _sub(sm['position'], gun)
        rs, u = block.get('serverMarker'), block.get('lastServerGunUpdate')
        if _norm(s_dir) > 0 and rs and u:
            s_rad = sm['diameter'] / 2.0 / _norm(s_dir)
            los = _sub(rs['position'], u['origin'])
            if _norm(los) > NEAR and rs.get('diameter', 0) > 0:
                a = _angle(los, s_dir)
                out['serverMarker'] = {'centreRadii':a / s_rad, 'centreMetres':a * rng,
                                       'sizeRatio':rs['diameter'] / 2.0 / _norm(los) / s_rad,
                                       'same':_norm(_sub(rs['position'], sm['position'])) < SAME_POSITION
                                       and abs(rs['diameter'] - sm['diameter']) < SAME_DIAMETER}
                if isinstance(stamp, (int, float)) and isinstance(recv, (int, float)):
                    out['serverMarker']['snapshotAge'] = stamp - recv
    return out


PARTS = ('clientMarker', 'serverMarker', 'lastServerGunUpdate', 'shotUpdate', 'press')


def attach(shots):
    """On the published shot records of one battle (replay_battle.build): each own tracer's block gets receivedAt on its
    parts (the tracer's receipt moved by the gameTime difference) and, when the page has a snapshot for it, 'comparison'.
    Returns (blocks, compared)."""
    commands = [s for s in shots if s.get('event') == 'command']
    after = [s for s in shots if s.get('event') == 'gunAfterShot']
    tracers = [s for s in shots if s.get('event') == 'tracer' and s.get('own') and not s.get('isRicochet')]
    ends = {}
    for s in shots:
        if s.get('event') in ('stop', 'explosion') and isinstance(s.get('position'), list):
            ends.setdefault(s.get('tracerId'), s['position'])
    blocks = compared = 0
    for t in tracers:
        block = t.get(KEY)
        if not isinstance(block, dict): continue
        blocks += 1
        block.pop('comparison', None)
        recv, when = t.get('receivedAt'), t.get('gameTime')
        if isinstance(recv, (int, float)) and isinstance(when, (int, float)):
            for part in PARTS:
                value = block.get(part)
                if isinstance(value, dict) and isinstance(value.get('gameTime'), (int, float)):
                    value['receivedAt'] = recv + (value['gameTime'] - when)
        command = command_of(t, commands)
        aim, which = snapshot(t, command)
        salvo = [e for e in tracers if e.get('gunInstallationIndex') == t.get('gunInstallationIndex')
                 and isinstance(e.get('origin'), list) and isinstance(e.get('gameTime'), (int, float))
                 and isinstance(when, (int, float)) and abs(e['gameTime'] - when) < SAME_INSTANT]
        if t not in salvo: salvo = [t] + salvo
        disc = server_shot(t, salvo, after)
        if aim is None and disc is None: continue
        stamp = command.get('receivedAt') if command else ((aim or {}).get('clientMarker') or {}).get('receivedAt')
        block['comparison'] = compare(block, aim, which, t.get('origin'), ends.get(t.get('id')), stamp, disc)
        compared += 1
    return blocks, compared
