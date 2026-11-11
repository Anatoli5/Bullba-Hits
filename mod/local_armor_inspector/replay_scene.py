# -*- coding: utf-8 -*-
"""The scene of a hit rebuilt from the replay: a second scene beside the in-game snapshot (11.11.2026).

The user (docs/PRODUCT.md «Лог боя из реплея, снимки и реконструкция»): every hit of a replay-made battle keeps the
recorder's snapshot as its main scene AND gets a scene rebuilt from the replay; both are kept and compared per hit, the
page switches between them. A hit the recorder never saw (the death camera) has no snapshot: the rebuilt scene is its
only one. The method is the one measured on 11.11 (outputs/replay-scene-recompute-2026-11-11.md):

- What needs no pose. DamageFromShotDecoder.parseHitPoint decodes the hit point's segment in the HIT PART'S OWN frame on
  the part's client bounding box (helpers_common.decodeSegment), collideHitPoint collides it with that one part's model
  (on a miss: the segment shifted by 1/256 of the box along -y, +y, -x, +x, -z, +z; the nearest-point fallback is not
  reproduced - never needed on 199 points). Point, direction, plate, incidence and nominal armour come from the raw
  segment, the part's model and its box alone.
- The box (model_assembler.setupCollisions: hitTester.bbox = collisions.getBoundingBox(part)) is the collision
  component's, native; for 25 of 79 measured models it is NOT the box of the model's vertices (up to 0.81 m: a turret's
  lower y bound, a hull's upper one). Taken, in this order: the client's own value on the part's hit tester
  ('client', statics 'bounds'), a box the recorder wrote for the part ('record', partBounds), the box recovered exactly
  from the live record's decoded start/end of the same model in this battle (decodeSegment is linear in the box:
  'recovered', residual <= BOX_RESIDUAL), else the vertex box - then the part is marked approximate.
- The pose. Position and hull yaw/pitch/roll at the hit packet's clock minus POSE_DELAY (0.2 s: the client draws the
  others that far behind), linear between the 10 Hz packets, world = T(pos) Ry(yaw) Rx(pitch) Rz(roll). The hull sits at
  rest on the chassis: the replay has no suspension tilt. Turret yaw and gun pitch: another vehicle's last
  gunAnglesPacked TURRET_DELAY before the hit (yaw 2pi k/1024 - pi in steps of 0.35 degrees, pitch on 63 steps of the
  gun's absolute limits); the own vehicle's last turret_yaw/gun_pitch floats at the hit. Parts stacked as the client
  does: hull T(hullPosition), turret hull T(turretPosition) Rx(turretPitch) Ry(yaw), gun turret T(gunPosition) Rx(pitch).
- The range: the two vehicles' packet positions at the pose time (none when the shooter is not in view, as live).

The block is the hit's SECOND_SCENE ('replayScene'): the snapshot's field names (target: type, compactDescriptor,
worldTransform, parts with transform, resource, modelKey, armor; points with start, end, position, direction, normal,
status; rangeAtImpact, attackerPositionAtImpact) plus its own: how it was made and where it is weaker ('limits'), each
point's material, nominal armour, incidence and box source, and, where the hit has a snapshot, 'comparison' with it.

Pure: no game module, no file. The client's Python 2.7 and CPython 3. Inputs come through a `source` object
(Exporter.scene_source in the game; a fixture table in the tests): statics(compact descriptor) and model(resource).
Tracks collects the replay's poses inside replay_records.Converter (poses=True) into one in-memory 'poses' record.
"""
from __future__ import absolute_import, division
import array
import base64
import bisect
import math

FORMAT = 1
# The pose of a hit (MEASURED 11.11 on 176 hits, scan 0/0.1/0.2/0.25/0.3 s): the others' position, hull angles and
# packed turret angles 0.2 s before the hit packet match the drawn pose best; the own turret floats at the hit itself.
POSE_DELAY = 0.2
TURRET_DELAY = 0.2
OWN_TURRET_DELAY = 0.0
# Two packets further apart than this are not interpolated; a pose further than this from any packet is not taken.
PACKET_GAP = 0.5
# A shot's stop (Avatar.stopTracer) belongs to a hit of the same shooter within this many seconds.
STOP_WINDOW = 0.15
# A recovered box must reproduce every live start/end of its model within this (m); the measured fit was 7.6e-7.
BOX_RESIDUAL = 1e-5
# collideHitPoint's retries: the segment shifted by 1/256 of the box along these axes (client order).
NUDGES = ((1, -1), (1, 1), (0, -1), (0, 1), (2, -1), (2, 1))
YAW_STEP = 360.0 / 1024.0
# The scene's own words for what the replay cannot give (the block says it rather than hiding it).
LIMIT_HULL = 'hull at rest on the chassis: the replay has no suspension tilt'
LIMIT_PACKED = 'turret yaw and gun pitch from the packed angles: steps of %.2f and %.2f degrees, %.1f s before the hit'
LIMIT_BOX = 'part %s: the client box is unknown, the box of the model vertices is taken - its points are approximate'
STATIC_PARTS = 4


# ---- the replay's poses, collected while the replay is converted -----------------------------------------------------
class Tracks(object):
    """Per vehicle: position packets (time, x, y, z, yaw, pitch, roll), gunAnglesPacked (time, code), the own turret
    yaw / gun pitch floats, the publicInfo compact descriptor. Kept in arrays of 32-bit floats - the packets' own width
    (clock, position and angles are float32 in 0x0a): 28 bytes a packet, 1.7 MB for the 60 000 packets of a 15-minute
    battle."""

    def __init__(self):
        self.times, self.values = {}, {}
        self.gun_times, self.gun_codes = {}, {}
        self.own = {'yaw':(array.array('f'), array.array('f')), 'pitch':(array.array('f'), array.array('f'))}
        self.compact = {}

    def position(self, vid, t, pos, yaw, pitch, roll):
        if vid not in self.times:
            self.times[vid], self.values[vid] = array.array('f'), array.array('f')
        self.times[vid].append(t)
        self.values[vid].extend((pos[0], pos[1], pos[2], yaw, pitch, roll))

    def gun(self, vid, t, code):
        if code is None: return
        if vid not in self.gun_times:
            self.gun_times[vid], self.gun_codes[vid] = array.array('f'), array.array('l')
        self.gun_times[vid].append(t)
        self.gun_codes[vid].append(int(code))

    def own_angle(self, which, t, value):
        times, values = self.own[which]
        times.append(t)
        values.append(value)

    def public(self, vid, compact):
        if compact: self.compact[vid] = compact_text(compact)

    def record(self, player, server_start, info=None):
        """The one 'poses' record of a battle (in memory only: its arrays are not JSON). `info` the vehiclesInfo list:
        a vehicle never created keeps its compact descriptor from there (the publicInfo one wins, as measured)."""
        compact = dict(self.compact)
        for row in info or ():
            try:
                vid = int(row.get('vehicleID'))
                if vid not in compact and row.get('compDescr'): compact[vid] = compact_text(row['compDescr'])
            except Exception:
                continue
        return {'type':'poses', 'format':FORMAT, 'playerVehicleId':player, 'serverTimeAtStart':server_start,
                'positions':dict((k, (self.times[k], self.values[k])) for k in self.times),
                'guns':dict((k, (self.gun_times[k], self.gun_codes[k])) for k in self.gun_times),
                'ownYaw':self.own['yaw'], 'ownPitch':self.own['pitch'], 'compact':compact}


def compact_text(value):
    """A compact descriptor as the records keep it: base64 text (exporter.vehicle_descr's input)."""
    if isinstance(value, bytearray): value = bytes(value)
    if not isinstance(value, bytes):
        try: value = value.encode('latin-1')
        except Exception: return None
    return base64.b64encode(value).decode('ascii')


# ---- small linear algebra: column-major 4x4 as the records and three.js ------------------------------------------------
def mm(a, b):
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    return out


def T(x, y, z):
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, float(x), float(y), float(z), 1.0]


def RX(a):
    c, s = math.cos(a), math.sin(a)
    return [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0]


def RY(a):
    c, s = math.cos(a), math.sin(a)
    return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0]


def RZ(a):
    c, s = math.cos(a), math.sin(a)
    return [c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def rigid_inverse(m):
    o = [0.0] * 15 + [1.0]
    for r in range(3):
        for c in range(3): o[c * 4 + r] = m[r * 4 + c]
    for r in range(3): o[12 + r] = -(m[r * 4] * m[12] + m[r * 4 + 1] * m[13] + m[r * 4 + 2] * m[14])
    return o


def apply(m, p):
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]


def rotation_angle(a, b):
    """Degrees of the rotation between two rigid matrices."""
    r = mm(rigid_inverse(a), b)
    # atan2 of the axis part and the trace part: well conditioned for small angles (acos of the trace is not - a
    # 1e-6 rounding of the matrices moved a 0.25-degree angle by 0.002 degrees).
    s = math.sqrt((r[6] - r[9]) ** 2 + (r[8] - r[2]) ** 2 + (r[1] - r[4]) ** 2) / 2.0
    return math.degrees(math.atan2(s, (r[0] + r[5] + r[10] - 1.0) / 2.0))


def sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def length(a): return math.sqrt(dot(a, a))


def unit(a):
    n = length(a)
    return [a[0] / n, a[1] / n, a[2] / n]


def angle(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b))))))


def wrap(a):
    while a > math.pi: a -= 2.0 * math.pi
    while a < -math.pi: a += 2.0 * math.pi
    return a


def rounded(values, digits=6):
    return [round(float(v), digits) for v in values]


# ---- the replay's tracks at a moment -----------------------------------------------------------------------------------
def pose_at(track, t):
    """(row [x, y, z, yaw, pitch, roll], gap): linear between the two packets around t (angles the short way); the
    nearer packet and its distance in time when t is outside the track or the two packets are PACKET_GAP apart."""
    if not track: return None, None
    times, values = track
    n = len(times)
    if not n: return None, None
    i = bisect.bisect_right(times, t)
    row = lambda k: [float(values[k * 6 + j]) for j in range(6)]
    if i == 0: return row(0), float(times[0]) - t
    if i == n: return row(n - 1), t - float(times[n - 1])
    ta, tb = float(times[i - 1]), float(times[i])
    if tb - ta > PACKET_GAP: return row(i - 1), t - ta
    f = (t - ta) / (tb - ta) if tb > ta else 0.0
    a, b = row(i - 1), row(i)
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
            a[3] + wrap(b[3] - a[3]) * f, a[4] + wrap(b[4] - a[4]) * f, a[5] + wrap(b[5] - a[5]) * f], 0.0


def last_at(track, t):
    """(time, value) of the last sample at or before t, or None."""
    if not track: return None
    times, values = track
    i = bisect.bisect_right(times, t + 1e-6)
    return (float(times[i - 1]), values[i - 1]) if i else None


def world_of(row):
    return mm(mm(mm(T(row[0], row[1], row[2]), RY(row[3])), RX(row[4])), RZ(row[5]))


def packed_angles(code, limits):
    """Vehicle.gunAnglesPacked: yaw = 2pi k/1024 - pi (k = code >> 6, 10 bits), pitch on 63 steps of the gun's absolute
    limits (client sign, + down)."""
    yaw = 2.0 * math.pi * ((code >> 6) & 1023) / 1024.0 - math.pi
    return yaw, limits[0] + (code & 63) / 63.0 * (limits[1] - limits[0])


# ---- part models -------------------------------------------------------------------------------------------------------
class Model(object):
    """One part's collision model (a model file's value: groups of vertices, indices, material), in its own frame."""

    def __init__(self, document, key=None):
        self.key = key
        self.resource = document.get('resource')
        tris = []
        lo, hi = [float('inf')] * 3, [float('-inf')] * 3
        for group in document.get('groups') or ():
            vertices, indices, material = group['vertices'], group['indices'], group.get('material')
            for v in vertices:
                for i in range(3):
                    if v[i] < lo[i]: lo[i] = v[i]
                    if v[i] > hi[i]: hi[i] = v[i]
            for k in range(0, len(indices) - 2, 3):
                a, b, c = vertices[indices[k]], vertices[indices[k + 1]], vertices[indices[k + 2]]
                e1, e2 = sub(b, a), sub(c, a)
                n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
                ln = length(n)
                if not ln > 0: continue
                tris.append((a[0], a[1], a[2], e1[0], e1[1], e1[2], e2[0], e2[1], e2[2],
                             n[0] / ln, n[1] / ln, n[2] / ln, material))
        self.tris = tris
        self.vertex_box = (lo, hi)

    def collide(self, s, e):
        """collideLocal: the nearest triangle the segment s -> e meets, both sides: (distance along it, triangle)."""
        dx, dy, dz = e[0] - s[0], e[1] - s[1], e[2] - s[2]
        span = math.sqrt(dx * dx + dy * dy + dz * dz)
        if not span > 0: return None
        ux, uy, uz = dx / span, dy / span, dz / span
        sx, sy, sz = s
        best, found = span, None
        for tri in self.tris:
            ax, ay, az, e1x, e1y, e1z, e2x, e2y, e2z = tri[:9]
            px, py, pz = uy * e2z - uz * e2y, uz * e2x - ux * e2z, ux * e2y - uy * e2x
            det = e1x * px + e1y * py + e1z * pz
            if -1e-12 < det < 1e-12: continue
            inv = 1.0 / det
            tx, ty, tz = sx - ax, sy - ay, sz - az
            u = (tx * px + ty * py + tz * pz) * inv
            if u < 0.0 or u > 1.0: continue
            qx, qy, qz = ty * e1z - tz * e1y, tz * e1x - tx * e1z, tx * e1y - ty * e1x
            v = (ux * qx + uy * qy + uz * qz) * inv
            if v < 0.0 or u + v > 1.0: continue
            d = (e2x * qx + e2y * qy + e2z * qz) * inv
            if d < 0.0 or d > best: continue
            best, found = d, tri
        return None if found is None else (best, found)

    def material_at(self, p, gap=0.02):
        """The triangle under a point: nearest plane within `gap`, the point's projection inside it (1e-3 slack)."""
        found = None
        for tri in self.tris:
            ax, ay, az, e1x, e1y, e1z, e2x, e2y, e2z, nx, ny, nz = tri[:12]
            x = (p[0] - ax, p[1] - ay, p[2] - az)
            off = abs(x[0] * nx + x[1] * ny + x[2] * nz)
            if not off < gap: continue
            d11 = e1x * e1x + e1y * e1y + e1z * e1z
            d12 = e1x * e2x + e1y * e2y + e1z * e2z
            d22 = e2x * e2x + e2y * e2y + e2z * e2z
            det = d11 * d22 - d12 * d12
            if not det: continue
            p1 = x[0] * e1x + x[1] * e1y + x[2] * e1z
            p2 = x[0] * e2x + x[1] * e2y + x[2] * e2z
            u, v = (d22 * p1 - d12 * p2) / det, (d11 * p2 - d12 * p1) / det
            if u < -0.001 or v < -0.001 or u + v > 1.001: continue
            found, gap = tri, off
        return found


def decode_segment(segment, box):
    """helpers_common.decodeSegment on the part's box: start/end on its 1/255 grid, each pushed 1 % outwards."""
    lo, hi = box
    s, e = [], []
    for i in range(3):
        step = (hi[i] - lo[i]) / 255.0
        s.append(lo[i] + step * ((segment >> (16 + 8 * i)) & 255))
        e.append(lo[i] + step * ((segment >> (40 + 8 * i)) & 255))
    off = [(e[i] - s[i]) * 0.01 for i in range(3)]
    return [s[i] - off[i] for i in range(3)], [e[i] + off[i] for i in range(3)]


def collide_hit_point(model, box, s, e):
    """DamageFromShotDecoder.collideHitPoint in the part's own frame: (position, direction, triangle, how) or None."""
    hit, how = model.collide(s, e), 'direct'
    if hit is None:
        size = [(box[1][i] - box[0][i]) / 256.0 for i in range(3)]
        for axis, sign in NUDGES:
            shift = [0.0, 0.0, 0.0]
            shift[axis] = sign * size[axis]
            s2, e2 = [s[i] + shift[i] for i in range(3)], [e[i] + shift[i] for i in range(3)]
            hit = model.collide(s2, e2)
            if hit is not None:
                s, e, how = s2, e2, 'nudged'
                break
    if hit is None: return None
    direction = unit(sub(e, s))
    distance, tri = hit
    return [s[i] + direction[i] * distance for i in range(3)], direction, tri, how


def facing(tri, direction):
    """The plate's normal turned against the shell (the client's normal faces the shell: 241 of 241 measured)."""
    n = [tri[9], tri[10], tri[11]]
    return [-n[0], -n[1], -n[2]] if dot(n, direction) > 0 else n


def nominal(armor, material):
    entry = (armor or {}).get(material) if material is not None else None
    try: return float(entry['armor']) if entry is not None else None
    except (TypeError, KeyError, ValueError): return None


# ---- the client's part box ---------------------------------------------------------------------------------------------
def recover_boxes(live_hits):
    """{resource: (lo, hi, source, residual)} of every static part model the live hits decoded points on: the box the
    recorder wrote (partBounds), else the one the client's own start/end give (decodeSegment is linear in the box:
    start = lo + (hi - lo)/255 (qs - 0.01 (qe - qs)), end likewise with qe + 0.01 (qe - qs); least squares per axis, at
    least two grid values seen). An axis seen at one grid value only stays None."""
    observed, written = {}, {}
    for hit in live_hits or ():
        target = hit.get('target') if isinstance(hit, dict) else None
        if not isinstance(target, dict): continue
        resources = dict((p.get('id'), p.get('resource')) for p in target.get('parts') or () if isinstance(p, dict))
        for raw, point in zip(hit.get('rawHitPoints') or (), hit.get('points') or ()):
            if not isinstance(point, dict): continue
            part = point.get('part')
            resource = resources.get(part)
            if not (isinstance(part, int) and 0 <= part and resource): continue
            bounds = point.get('partBounds')
            if bounds and resource not in written: written[resource] = bounds
            if 'start' not in point or 'end' not in point: continue
            try: seg = int(raw['segment'])
            except (TypeError, KeyError, ValueError): continue
            rows = observed.setdefault(resource, ([], [], []))
            for i in range(3):
                qs, qe = (seg >> (16 + 8 * i)) & 255, (seg >> (40 + 8 * i)) & 255
                rows[i].append((qs - 0.01 * (qe - qs), float(point['start'][i])))
                rows[i].append((qe + 0.01 * (qe - qs), float(point['end'][i])))
    out = {}
    for resource, bounds in written.items():
        out[resource] = ([float(x) for x in bounds[0]], [float(x) for x in bounds[1]], 'record', 0.0)
    for resource, rows in observed.items():
        if resource in out: continue
        lo, hi, worst = [None] * 3, [None] * 3, 0.0
        for i, pts in enumerate(rows):
            xs = [p[0] for p in pts]
            n = len(pts)
            mx, my = sum(xs) / n, sum(p[1] for p in pts) / n
            sxx = sum((x - mx) ** 2 for x in xs)
            if sxx < 1e-9: continue
            slope = sum((x - mx) * (y - my) for x, y in pts) / sxx
            base = my - slope * mx
            residual = max(abs(base + slope * x - y) for x, y in pts)
            if residual > BOX_RESIDUAL: continue
            lo[i], hi[i], worst = base, base + 255.0 * slope, max(worst, residual)
        out[resource] = (lo, hi, 'recovered', worst)
    return out


def part_box(part, model, recovered):
    """(box, source): the client's (statics 'bounds'), the record's or the recovered one; a box recovered on some axes
    only takes the vertex box on the others ('recovered+vertices', approximate); else the vertex box ('vertices')."""
    bounds = part.get('bounds')
    if bounds: return ([float(x) for x in bounds[0]], [float(x) for x in bounds[1]]), 'client'
    known = recovered.get(part.get('resource'))
    vlo, vhi = model.vertex_box
    if known is not None:
        lo, hi, source = known[0], known[1], known[2]
        if None not in lo and None not in hi: return (list(lo), list(hi)), source
        if any(x is not None for x in lo):
            return ([vlo[i] if lo[i] is None else lo[i] for i in range(3)],
                    [vhi[i] if hi[i] is None else hi[i] for i in range(3)]), 'recovered+vertices'
    return (list(vlo), list(vhi)), 'vertices'


APPROXIMATE_BOXES = ('vertices', 'recovered+vertices')


# ---- one battle ----------------------------------------------------------------------------------------------------------
class Scenes(object):
    """The scenes of one replay-made battle: its poses record, the live battle (boxes) and a source of statics and
    models. scene(hit) -> the block, or (None, reason)."""

    def __init__(self, poses, live, source, shot_events=()):
        self.poses, self.source = poses, source
        self.player = poses.get('playerVehicleId')
        self.start = poses.get('serverTimeAtStart')
        self.recovered = recover_boxes((live or {}).get('hits'))
        self.statics, self.models = {}, {}
        self.stops = {}
        for s in shot_events or ():
            if s.get('event') == 'stop' and s.get('position') is not None and s.get('gameTime') is not None:
                self.stops.setdefault(s.get('shooterId'), []).append((float(s['gameTime']), s['position']))

    def static(self, compact):
        if compact not in self.statics:
            try: self.statics[compact] = (self.source.statics(compact), None)
            except Exception as exc: self.statics[compact] = (None, 'vehicle descriptor unavailable: %s' % exc)
        return self.statics[compact]

    def model(self, resource):
        if resource not in self.models:
            try:
                key, document = self.source.model(resource)
                self.models[resource] = (Model(document, key), None)
            except Exception as exc:
                self.models[resource] = (None, 'part model unavailable: %s' % exc)
        return self.models[resource]

    def scene(self, hit):
        if self.start is None: return None, 'no server time at start in the replay'
        when = hit.get('gameTime')
        if when is None: return None, 'hit without gameTime'
        t_hit = float(when) - float(self.start)
        tid, aid = hit.get('targetId'), hit.get('attackerId')
        compact = self.poses['compact'].get(tid)
        if not compact: return None, 'no compact descriptor of the target in the replay'
        statics, error = self.static(compact)
        if statics is None: return None, error
        out = {'format':FORMAT, 'source':'replay', 'poseDelay':POSE_DELAY, 'limits':[LIMIT_HULL], 'problems':[]}
        t_pose = t_hit - POSE_DELAY
        out['poseTime'] = round(float(self.start) + t_pose, 4)
        row, gap = pose_at(self.poses['positions'].get(tid), t_pose)
        world = None
        if row is None: out['problems'].append('no position of the target in the replay')
        elif gap > PACKET_GAP: out['problems'].append('no position of the target within %.1f s of the hit (%.1f s)' % (PACKET_GAP, gap))
        else: world = world_of(row)
        # turret yaw and gun pitch to the hull (client sign: pitch + down)
        yaw = pitch = None
        if tid == self.player:
            y = last_at(self.poses['ownYaw'], t_hit - OWN_TURRET_DELAY)
            p = last_at(self.poses['ownPitch'], t_hit - OWN_TURRET_DELAY)
            if y is not None and p is not None:
                yaw, pitch = float(y[1]), float(p[1])
                out['angles'] = {'from':'own turret_yaw / gun_pitch', 'time':round(float(self.start) + max(y[0], p[0]), 4)}
        limits = statics.get('pitchLimits')
        if yaw is None:
            g = last_at(self.poses['guns'].get(tid), t_hit - TURRET_DELAY)
            if g is not None and limits:
                yaw, pitch = packed_angles(int(g[1]), limits)
                pitch_step = math.degrees(limits[1] - limits[0]) / 63.0
                out['angles'] = {'from':'gunAnglesPacked', 'time':round(float(self.start) + g[0], 4),
                                 'yawStep':round(YAW_STEP, 4), 'pitchStep':round(pitch_step, 4)}
                out['limits'].append(LIMIT_PACKED % (YAW_STEP, pitch_step, TURRET_DELAY))
        if yaw is None:
            out['problems'].append('no turret and gun angles of the target in the replay: turret and gun at 0')
            yaw = pitch = 0.0
        hull = T(*statics['hullPosition'])
        turret = mm(mm(mm(hull, T(*statics['turretPosition'])), RX(statics.get('turretPitch') or 0.0)), RY(yaw))
        gun = mm(mm(turret, T(*statics['gunPosition'])), RX(pitch))
        poses = [T(0, 0, 0), hull, turret, gun]
        target = {'type':statics.get('type'), 'compactDescriptor':compact, 'turretYaw':round(yaw, 6),
                  'gunPitch':round(pitch, 6), 'parts':[]}
        if world is not None: target['worldTransform'] = rounded(world)
        snapshot_parts = dict((p.get('id'), p) for p in ((hit.get('target') or {}).get('parts') or ()) if isinstance(p, dict))
        parts = {}
        for spec in statics.get('parts') or ():
            pid = spec.get('id')
            # A static part after the four (the outer track pair) sits in the chassis frame, as the client connects it.
            part = {'id':pid, 'name':spec.get('name'), 'transform':rounded(poses[pid] if pid < len(poses) else poses[0])}
            if spec.get('resource'): part['resource'] = spec['resource']
            armor = spec.get('armor')
            same = snapshot_parts.get(pid)
            if armor is not None and same is not None and same.get('armor') == armor: part['armorFrom'] = 'snapshot'
            elif armor is not None: part['armor'] = armor
            model, error = self.model(spec['resource']) if spec.get('resource') else (None, 'no part model resource')
            if model is not None:
                part['modelKey'] = model.key
                box, box_from = part_box(spec, model, self.recovered)
                part['bounds'], part['boundsFrom'] = [rounded(box[0], 7), rounded(box[1], 7)], box_from
                if box_from in APPROXIMATE_BOXES: part['approximate'] = True
                parts[pid] = (part, model, box, armor if armor is not None else (same or {}).get('armor'))
            else:
                part['modelError'] = error
            target['parts'].append(part)
        out['target'] = target
        self.part_ids = set(spec.get('id') for spec in statics.get('parts') or ())
        out['points'] = []
        for raw in hit.get('rawHitPoints') or ():
            out['points'].append(self.point(raw, parts))
        # A part without its client box matters where a point lies on it (its other parts only draw).
        for pid in sorted(set(p.get('part') for p in out['points'] if p.get('approximate'))):
            out['limits'].append(LIMIT_BOX % parts[pid][0]['name'])
        # range and the shooter's place at the pose time, as live (none when the shooter is not in view)
        a_row, a_gap = pose_at(self.poses['positions'].get(aid), t_pose)
        if world is not None and a_row is not None and a_gap <= PACKET_GAP:
            out['attackerPositionAtImpact'] = rounded(a_row[:3])
            out['rangeAtImpact'] = round(length(sub(row[:3], a_row[:3])), 4)
        stop = self.stop_of(aid, float(when))
        if stop is not None and world is not None:
            gaps = [length(sub(apply(mm(world, parts[p['part']][0]['transform']), p['position']), stop))
                    for p in out['points'] if p.get('status') == 'resolved' and p.get('part') in parts]
            if gaps: out['stopDistance'] = round(min(gaps), 4)
        if not out['problems']: del out['problems']
        return out, None

    def point(self, raw, parts):
        try: seg = int(raw['segment'])
        except (TypeError, KeyError, ValueError): return {'status':'unresolved', 'why':'no segment'}
        params = int(raw.get('params') or 0)
        pid = (seg >> 8) & 255
        p = {'part':pid, 'effect':seg & 255, 'hitType':params & 15, 'shellType':(params >> 4) & 15,
             'caliber':((params >> 8) & 0xffff) * 0.1, 'status':'unresolved'}
        if pid not in parts:
            # A part the descriptor does not list (a wheel or an armoured prefab, beyond the static parts): not rebuilt.
            p['status'] = 'unresolved' if pid in self.part_ids else 'unsupported-part'
            p['why'] = 'no model of this part' if pid in self.part_ids else 'not a static part: not rebuilt'
            return p
        part, model, box, armor = parts[pid]
        s, e = decode_segment(seg, box)
        p['start'], p['end'], p['boxFrom'] = rounded(s), rounded(e), part['boundsFrom']
        if s == e:
            p['why'] = 'empty segment'
            return p
        found = collide_hit_point(model, box, s, e)
        if found is None:
            p['why'] = 'no collision (the client then takes the nearest point within its fallback distance)'
            return p
        position, direction, tri, how = found
        normal = facing(tri, direction)
        p.update({'position':rounded(position), 'direction':rounded(direction), 'normal':rounded(normal),
                  'status':'resolved', 'collision':how, 'material':tri[12],
                  'incidence':round(math.degrees(math.acos(max(-1.0, min(1.0, -dot(direction, normal))))), 4)})
        armor_mm = nominal(armor, tri[12])
        if armor_mm is not None: p['nominal'] = armor_mm
        if part.get('approximate'): p['approximate'] = True
        return p

    def stop_of(self, shooter, when):
        best = None
        for t, position in self.stops.get(shooter, ()):
            if abs(t - when) < STOP_WINDOW and (best is None or abs(t - when) < best[0]): best = (abs(t - when), position)
        return None if best is None else best[1]

    # ---- the comparison with the snapshot ---------------------------------------------------------------------------
    def compare(self, hit, scene):
        """Per hit where both scenes exist: the two resolved points (part frame), their incidence and nominal armour,
        turret yaw and gun pitch, the world position and rotation, the range, the server stop's distance - replay minus
        snapshot. The page's verdict is the page's."""
        target = hit.get('target')
        if not isinstance(target, dict) or not target.get('parts'): return None
        snap = dict((p.get('id'), p) for p in target['parts'] if isinstance(p, dict))
        statics = self.static(scene['target']['compactDescriptor'])[0] or {}
        out = {}
        scene_parts = dict((p['id'], p) for p in scene['target']['parts'])
        try:
            hull, turret, gun = snap[1]['transform'], snap[2]['transform'], snap[3]['transform']
            rel = mm(RX(-(statics.get('turretPitch') or 0.0)), mm(rigid_inverse(hull), turret))
            yaw = math.atan2(rel[8], rel[10])
            relg = mm(rigid_inverse(turret), gun)
            pitch = math.atan2(relg[6], relg[5])
            out['turretYawDiff'] = round(math.degrees(wrap(scene['target']['turretYaw'] - yaw)), 4)
            out['gunPitchDiff'] = round(math.degrees(scene['target']['gunPitch'] - pitch), 4)
            out['hullFromRest'] = {'rotation':round(rotation_angle(scene_parts[1]['transform'], hull), 4),
                                   'shift':round(length(sub(hull[12:15], scene_parts[1]['transform'][12:15])), 4)}
        except Exception:
            pass
        world_s, world_r = target.get('worldTransform'), scene['target'].get('worldTransform')
        if world_s and world_r:
            out['worldShift'] = round(length(sub(world_s[12:15], world_r[12:15])), 4)
            out['worldRotation'] = round(rotation_angle(world_s, world_r), 4)
        if hit.get('rangeAtImpact') is not None and scene.get('rangeAtImpact') is not None:
            out['rangeDiff'] = round(scene['rangeAtImpact'] - float(hit['rangeAtImpact']), 4)
        rows = []
        live_points = hit.get('points') or ()
        for k, rp in enumerate(scene['points']):
            lp = live_points[k] if k < len(live_points) else None
            row = {}
            if not isinstance(lp, dict) or lp.get('part') != rp.get('part'):
                rows.append({'why':'no snapshot point'})
                continue
            if lp.get('position') is None or rp.get('position') is None:
                row['why'] = 'unresolved in the %s' % ('snapshot' if lp.get('position') is None else 'replay scene')
                rows.append(row)
                continue
            row['distance'] = round(length(sub(lp['position'], rp['position'])), 6)
            if lp.get('start') and rp.get('start'):
                row['segmentDistance'] = round(max(length(sub(lp['start'], rp['start'])), length(sub(lp['end'], rp['end']))), 6)
            model = self.models.get(scene_parts.get(rp['part'], {}).get('resource'), (None,))[0]
            tri = model.material_at(lp['position']) if model is not None else None
            if tri is not None:
                incidence = math.degrees(math.acos(max(-1.0, min(1.0, abs(dot(unit(lp['direction']), [tri[9], tri[10], tri[11]]))))))
                row['snapshotIncidence'] = round(incidence, 4)
                row['incidenceDiff'] = round(rp['incidence'] - incidence, 4)
                armor = snap.get(rp['part'], {}).get('armor')
                snap_mm = nominal(armor, tri[12])
                if snap_mm is not None:
                    row['snapshotNominal'] = snap_mm
                    if rp.get('nominal') is not None: row['nominalDiff'] = round(rp['nominal'] - snap_mm, 3)
            rows.append(row)
        out['points'] = rows
        stop = self.stop_of(hit.get('attackerId'), float(hit['gameTime']))
        if stop is not None and world_s:
            gaps = [length(sub(apply(mm(world_s, snap[p['part']]['transform']), p['position']), stop))
                    for p in live_points if isinstance(p, dict) and p.get('position') and p.get('part') in snap
                    and snap[p['part']].get('transform')]
            if gaps: out['stopDistance'] = {'snapshot':round(min(gaps), 4), 'replay':scene.get('stopDistance')}
        return out


def attach(battle, poses, live, source, key='replayScene'):
    """Put the rebuilt scene on every hit of a replay-made battle that can be rebuilt (matched and replay-only), with the
    comparison where the hit has its snapshot. Returns the counts for the battle's 'replay' block."""
    report = {}
    for _ in attaching(battle, poses, live, source, key, report): pass
    return report


def attaching(battle, poses, live, source, key, report):
    """attach() one hit a step (the export thread's slices, Exporter.replay_assemble_steps): yields after each hit; the
    counts are put in `report` at the end."""
    scenes = Scenes(poses, live, source, battle.get('shotEvents') or ())
    made = compared = 0
    without, approximate, unresolved = {}, 0, 0
    for hit in battle.get('hits') or ():
        if not isinstance(hit, dict): continue
        try:
            scene, why = scenes.scene(hit)
        except Exception as exc:
            scene, why = None, 'failed: %s' % exc
        if scene is None:
            without[why] = without.get(why, 0) + 1
            yield
            continue
        if isinstance(hit.get('target'), dict):
            try: comparison = scenes.compare(hit, scene)
            except Exception as exc: comparison = {'why':'failed: %s' % exc}
            if comparison is not None:
                scene['comparison'] = comparison
                compared += 1
        hit[key] = scene
        made += 1
        approximate += sum(1 for p in scene['points'] if p.get('approximate'))
        unresolved += sum(1 for p in scene['points'] if p.get('status') != 'resolved')
        yield
    report.update({'format':FORMAT, 'made':made, 'compared':compared, 'pointsApproximate':approximate,
                   'pointsUnresolved':unresolved})
    if without: report['without'] = without
    sources = {}
    for hit in battle.get('hits') or ():
        for part in ((hit.get(key) or {}).get('target') or {}).get('parts') or () if isinstance(hit, dict) else ():
            if part.get('boundsFrom'): sources[part['boundsFrom']] = sources.get(part['boundsFrom'], 0) + 1
    if sources: report['partBoxes'] = sources
