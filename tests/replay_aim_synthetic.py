# -*- coding: utf-8 -*-
"""A small synthetic replay stream for the own aim circles (replay_aim.py, BACKLOG 82), shared by tests/test_replay_aim.py
(CPython 3) and tests/py27/replay_aim.py (the client's Python 2.7).

The own vehicle drives along +z at 5 m/s (0.5 m a server tick) and aims along +z at a point 300 m ahead; one packet 0x39
(the server's gun marker) and one 0x1a (the replay controller's gun-marker state) every 0.1 s from clock 1.0, the
dispersion growing by 0.0001 rad a tick so each tick is told apart; a ping packet 0x1f (50 ms) at the start. `hidden`:
fields 3-10 hold another reticle than the server's (its direction 0.01 rad off the shot vector's azimuth).
"""
import struct

START = 1000.0        # server time at the recording start (0x15)
TICK = 0.1
FIRST = 1.0
TICKS = 40
PING = 50             # ms
RANGE = 300.0


def gun(k):
    return [0.0, 2.0, 0.5 * k]


def dispersion(k):
    return 0.002 + 0.0001 * k


def clock(k):
    return FIRST + TICK * k


def packet(ptype, at, payload):
    return struct.pack('<IIf', len(payload), ptype, at) + payload


def stream(hidden=False, ping=True):
    out = []
    if ping: out.append(packet(0x1f, FIRST - 0.05, struct.pack('<I', 60 | (PING << 8) | (3 << 24))))
    for k in range(TICKS):
        g = gun(k)
        server = bytearray(72)
        struct.pack_into('<I', server, 15, 100000 + k)
        server[41] = 1
        struct.pack_into('<3f', server, 42, *g)
        struct.pack_into('<3f', server, 54, 0.0, 0.0, 800.0)
        struct.pack_into('<f', server, 66, dispersion(k))
        out.append(packet(0x39, clock(k), bytes(server)))
        point = [g[0], g[1], g[2] + RANGE]
        direction = [0.01, -0.01, 1.0] if hidden else [0.0, -0.01, 1.0]
        values = ([0.3, 2.0, point[2]] + [2 * dispersion(k) * RANGE, 1.5 * dispersion(k) * RANGE] + point + direction
                  + [2.2 * dispersion(k) * RANGE, 0.5, -1.0, -1.0])
        out.append(packet(0x1a, clock(k), struct.pack('<15f', *values)))
    return b''.join(out)


def events(data):
    """The decoder's small-packet events of the stream, as replay_stream.Decoder.decode yields them."""
    from local_armor_inspector import replay_stream as rd
    from local_armor_inspector import replay_objects as rc
    out = []
    for ptype, at, p in rd.iter_packets(bytearray(data)):
        ev = rc.small_packet(ptype, at, p)
        if ev is not None:
            ev['t'] = at
            out.append(ev)
    return out


def tracer_event(at, origin, shot_id=7, ricochet=False, gun_installation=0):
    return {'ev':'method', 'entity':'Avatar', 'name':'showTracer', 't':at,
            'args':{'shooterID':11, 'shotID':shot_id, 'isRicochet':ricochet, 'effectsIndex':3, 'shellTypeIdx':0,
                    'shellCaliber':0.1, 'refStartPoint':list(origin), 'velocity':[0.0, 0.0, 800.0], 'gravity':9.81,
                    'maxShotDist':720.0, 'gunIndex':0, 'gunInstallationIndex':gun_installation}}


def battle_events(data, tracers):
    """A converter's whole input: the arena, the own vehicle 11, the server time, the stream's events with the tracers
    put in at their clocks."""
    head = [{'ev':'player_base', 't':0.0, 'props':{'arenaUniqueID':77, 'sessionID':'11'}},
            {'ev':'own_vehicle', 't':0.0, 'vehicleId':11}, {'ev':'server_time_at_start', 't':0.0, 'serverTime':START}]
    body = events(data) + list(tracers)
    body.sort(key=lambda e: e['t'])
    return head + body
