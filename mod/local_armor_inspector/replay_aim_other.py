# -*- coding: utf-8 -*-
"""Another vehicle's aim circle at its shot, estimated from the replay (BACKLOG 82, 12.11.2026).

The own shot's circles come from packets only the own vehicle has (0x39, 0x1a: replay_aim.py). For a shot of ANY other
vehicle the replay holds its track - positions and hull angles (0x0a), its gun's packed angles (Vehicle.gunAnglesPacked,
on the server's 0.1 s tick, sent on a change) - its tracers and its compact descriptor. From these this module estimates
the circle the shell left from: its SIZE from the client's dispersion formula driven by the track, its CENTRE from the
gun's track (horizontal) combined with the tracer (vertical anchor) and the vehicle's other shots of the battle. The
method and every constant are the measurement's (outputs/aim-circles-other-vehicles-2026-11-12.md, section 4.5 with the
staircase fit of round 4c, scored on 201 own shots treated as another vehicle's: centre 0.31 / 0.65 R median / p90 from
the server's own axis, every shell inside the circle; the shell's place in it carries the left/right truth with
correlation ~0.7, the up/down truth ~0.26). Algorithm, per shooter of a battle:

  size     the client's formula (web/ballistics.js aimFactor / aimStep / aimShot: aim_ideal, aim_step, aim_shot below)
           on a 0.1 s grid of the vehicle's track: speed and hull turn from 0x0a, turret turn from the packed yaw,
           centred differences over 0.2 s taken 0.3 s back; its own shots bloom the circle at the tick after the tracer;
           crew and equipment unknown -> TYPICAL (crew 120 %, half the vehicles with a laying drive and a stabiliser,
           Snap Shot), measured R_est / R p10-p90 0.77-1.30 at the shots;
  track    the gun's axis at the tracer clock - 0.1 s: the 0x0a pose, the packed angles interpolated (a pair over 0.45 s
           apart holds the earlier); the 4 ticks around the moment fitted where it wins (round 4c): a steady turn by the
           centroid of the lines whose rate is within 1.3 x the vehicle's traverse (elevation) speed, a start / stop by
           the one-kink lines, plain interpolation otherwise;
  centre   in the tangent plane of the track axis: horizontal = the track's error drawn from its measured two-Gaussian
           mixture (posterior mean); vertical = one Gaussian process over ALL the vehicle's tracers of the battle (an
           offset per vehicle, a frame tilt per stop seen through the turret yaw, the pitch code's noise); the deviation
           of the game (half-normal radius, sigma 0.56 R, cut at 1 R) as a per-axis Gaussian of sd 0.327 R_est x 1.32;
           then the tracer kept within 1 R_est of the centre.

Not modelled (a block with no circle and the reason): automatic guns, dual-accuracy guns, the rounds of a burst after its
first, a vehicle in its second mode, the secondary gun. The block (KEY) sits on the other vehicle's tracer record, in the shape of
the own shot's replayAim: 'circle' has the names of its 'shotUpdate' (origin, vector, dispersionAngle), so the page can
carry it to the hit the way it carries the own disc; marked 'estimate'.

Steps: attaching() yields between units of work (a vehicle's preparation, a window of its size simulation, a tracer, its
circles) for the replay job's slices (replay_run.Consumption). Pure: no game module; the client's Python 2.7 and CPython 3.
The vehicle's gun comes through `inputs(compact descriptor)` (exporter.aim_estimate_inputs in the game; a table in the
tests).
"""
from __future__ import absolute_import, division
import math
from bisect import bisect_right

from .replay_scene import RX, RY, lives_of, mm, world_of

KEY = 'replayAimEstimate'
FORMAT = 1
SOURCE = 'replay'

# ---- the dispersion formula: ONE copy of web/ballistics.js (aimFactor's ideal, aimStep, aimShot) ----------------------
# tests/test_replay_aim_other.py runs both on the same inputs and requires the same factors (FormulaParity).
STEP_CLAMP = 0.25         # ballistics.js aimStep: a dt over a quarter of a second is clamped
# Another vehicle's unknown crew and equipment, set a priori from the game's numbers (not fitted; measurement section 1):
# crew 120 % (mult and aiming time x0.92), a laying drive on half the vehicles (aiming time x0.95), a stabiliser on half
# (additive x0.9), Snap Shot (turret x0.925). The keys are ballistics.js aimMods' own.
TYPICAL = {'mult':0.92, 'aimingTime':0.92 * 0.95, 'additive':0.9, 'turret':0.925}


def aim_ideal(aim, speed, hull, turret, shot, mods):
    """ballistics.js aimFactor(aim, {speed, hullTurn, turretTurn, afterShot}, mods).ideal and its aimingTime: the factor
    the client's formula gives the state (multFactor, additiveFactor, aimingTimeFactor taken as the aim dict has them -
    absent: 1)."""
    m = mods or {}
    mult = (aim.get('multFactor') or 1.0) * m.get('mult', 1.0)
    additive = (aim.get('additiveFactor') or 1.0) * m.get('additive', 1.0)
    cm = (aim.get('movementFactor') or 0.0) * m.get('movement', 1.0)
    cr = (aim.get('rotationFactor') or 0.0) * m.get('rotation', 1.0)
    ct = (aim.get('turretRotationFactor') or 0.0) * m.get('turret', 1.0)
    cs = (aim.get('afterShotFactor') or 0.0) * m.get('afterShotField', 1.0) * m.get('afterShot', 1.0)
    v, w, wt = abs(speed), abs(hull), abs(turret)
    total = (v * cm) ** 2 + (w * cr) ** 2 + (wt * ct) ** 2 + (cs * cs if shot else 0.0)
    ideal = mult * math.sqrt(1.0 + additive * additive * total)
    aiming = (aim.get('aimingTime') or 0.0) * (aim.get('aimingTimeFactor') or 1.0) * m.get('aimingTime', 1.0)
    return ideal, aiming


def aim_step(prev, ideal, aiming, dt):
    """ballistics.js aimStep on (factor, start, elapsed): the factor falls from its start as exp(-elapsed / aimingTime)
    towards the ideal of the state; a rise is instant."""
    step = max(0.0, min(STEP_CLAMP, dt or 0.0))
    start = prev[1] if prev and prev[1] > 0 else 0.0
    elapsed = prev[2] + step if prev and prev[2] >= 0 else 0.0
    decayed = start * math.exp(-elapsed / aiming) if start > 0 and aiming > 0 else 0.0
    if not decayed > ideal: return (ideal, ideal, 0.0)
    return (decayed, start, elapsed)


def aim_shot(prev, bloom, after):
    """ballistics.js aimShot: the circle restarts from the ideal with the after-shot term, or from the current factor when
    that is wider."""
    current = prev[0] if prev and prev[0] > 0 else after
    start = max(current, bloom)
    return (start, start, 0.0)


# ---- the measured constants (outputs/aim-circles-other-vehicles-2026-11-12.md 4.5, round 4c; the mean of the two folds) -
GRID = 0.1                # the size model's tick
SIZE_WINDOW = 0.2         # speed / hull turn / turret turn: centred differences over 0.2 s ...
SIZE_LAG = 0.3            # ... taken 0.3 s before the tick (scan 0-0.6 s, size.out.txt)
HOLD_GAP = 0.45           # two samples further apart are a hold of the earlier (the properties are sent on a change)
BLOOM_EPS = 1e-4          # a shot blooms the first tick at or after its tracer clock (- this)
SETTLE = 6.0              # the size simulated from SETTLE aiming times (at least SETTLE_MIN s) before each shot: the
SETTLE_MIN = 5.0          # factor of a start that far back has decayed below any ideal (equal to the whole track: tests)
POSE_LAG = 0.1            # the track at the tracer clock - 0.1 s (pose and angles; lag scan of round 4, pinned by 4c)
ANGLE_LAG = 0.1
POSE_AGE = 1.0            # the shooter's last position more than this before the shot: not in view, no circle
RATE_SPAN = 0.5           # the gun's world yaw rate and the hull speed over the last 0.5 s
STILL_GUN = 0.02          # rad/s: the gun still, else turning (the horizontal mixture)
STOP_SPEED = 0.3          # m/s: standing; a stop is left beyond 0.3 m of path or 0.01 rad of hull yaw
STOP_PATH = 0.3
STOP_YAW = 0.01
TELEPORT = 30.0           # m between two packets: not a path
YAW_STEP = 2.0 * math.pi / 1024.0
STAIR_TICKS = 2           # round 4c: the 4 ticks from 0.1 s before the moment to 0.2 s after
STAIR_RATE = 1.3          # the fitted rate within 1.3 x the vehicle's own traverse / elevation speed
STAIR_LINES = 121
STAIR_KINK_RATES = 25
DEFAULT_SPEEDS = (1.0, 0.6)   # rad/s turret, gun, when the descriptor gives none
DEVIATION_SD = 0.32675    # per-axis sd of the deviation in R (the law cut at 1 R)
SIZE_RATIO2 = 1.31815     # E[(R / R_est)^2] of the typical size model
HORIZONTAL = {'still':(0.95543, 0.00211, 0.0087), 'turning':(0.93443, 0.00228, 0.01309)}   # (p, sd good, sd bad) rad
VERTICAL_MEAN = -0.00064  # rad
VERTICAL_TILT = -0.03011  # per rad of the 0x0a frame's tilt along the gun
VEHICLE_SD = 0.00214      # one offset per vehicle and battle
STOP_SD = 0.01023         # a frame tilt per stop, seen through the turret yaw (cos of the yaw difference)
MOVING_SD = 0.01443       # a moving shot is its own stop
CODE_SD = 0.00296         # the 6-bit pitch code
BURST_SLACK = 0.3         # s: a tracer this much past its burst's interval is still one of its rounds
SAME_SHOT = 1e-3          # the tracers of one salvo: the same clock (not two rounds)
INSIDE = 1.0              # the tracer within INSIDE x R_est of the centre (never binds in the measured data)
# What the page may say of the estimate (the measurement's figures).
SIZE_BAND = [0.77, 1.30]  # R_est / R at the shots, p10-p90
CENTRE_ERROR = [0.31, 0.65]   # |centre - server axis| in R, median / p90 (held-out own shots)
INFORMATION = {'horizontal':0.69, 'vertical':0.26, 'verticalStop2':0.39}

CASES = {'still':'still', 'steady':'steady turn', 'kink':'start-stop', 'complex':'complex', 'none':'still'}   # none: no code within 5 s - the gun held
LIMITS = (
    'an estimate: the replay holds this vehicle\'s track, gun angles and shells, not its aim; centre about a third of the '
    'circle off the server\'s axis (median 0.31 R, p90 0.65 R, measured on 201 own shots treated as another vehicle\'s)',
    'size: the client\'s formula on the vehicle\'s track with a typical crew and equipment (crew 120 %, half with a laying '
    'drive and a stabiliser, Snap Shot); the true circle was 0.77-1.30 of it (p10-p90)',
    'left / right of the centre is meaningful (correlation 0.69 with the truth); up / down is not (0.26; 0.39 with several '
    'shots from one stop): the height of the aim comes from the shells themselves',
    'turret yaw and gun pitch from the packed angles (steps of 0.35 degrees and 1/63 of the pitch range), 0.1 s back',
)
ABSENT = ('crew', 'equipment', 'consumables', 'field modification (vehPostProgression not decoded)', 'gun damage',
          'the press and the reticles (packets 0x1a / 0x39 are the own vehicle\'s only)', 'the server\'s own axis')
WHY = {
    'auto':'automatic gun: its circle grows with every round of a stream (not modelled)',
    'dual':'dual-accuracy gun: the circle switches between two sizes (not modelled)',
    'burst':'a later round of a burst: the rounds after the first bloom with their own term (not modelled)',
    'mode':'the vehicle was in its second mode: that mode\'s gun is not modelled',
    'secondary':'the secondary gun: not modelled',
    'gun':'the vehicle\'s gun could not be read from the client: %s',
    'track':'the replay holds no track of this vehicle',
    'view':'the shooter was not in view at the shot (its last position over 1 s before it)',
}


# ---- small helpers ------------------------------------------------------------------------------------------------------
def wrap(a):
    return a - 2.0 * math.pi * math.floor((a + math.pi) / (2.0 * math.pi))


def interp(xs, ys, x):
    """numpy.interp: linear between the samples around x, the end value outside."""
    n = len(xs)
    if x <= xs[0]: return ys[0]
    if x >= xs[n - 1]: return ys[n - 1]
    i = bisect_right(xs, x)
    x0, x1 = xs[i - 1], xs[i]
    if x1 <= x0: return ys[i]
    return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - x0) / (x1 - x0)


def dedupe(times, rows):
    """Samples of one clock (within 1e-6 s) merged: the last kept."""
    out_t, out_r = [], []
    for t, r in zip(times, rows):
        if out_t and t <= out_t[-1] + 1e-6:
            out_r[-1] = r
            continue
        out_t.append(t)
        out_r.append(r)
    return out_t, out_r


def unwrap(values):
    out, last, shift = [], None, 0.0
    for v in values:
        if last is not None:
            d = v - last
            if d > math.pi: shift -= 2.0 * math.pi * math.floor((d + math.pi) / (2.0 * math.pi))
            elif d < -math.pi: shift += 2.0 * math.pi * math.floor((-d + math.pi) / (2.0 * math.pi))
        out.append(v + shift)
        last = v
    return out


def with_holds(times, values):
    """A pair of samples over HOLD_GAP apart holds the earlier value until 0.1 s before the later one (size model)."""
    tt, vv = [], []
    for i in range(len(times)):
        if i and times[i] - times[i - 1] > HOLD_GAP:
            tt.append(times[i] - 0.1)
            vv.append(values[i - 1])
        tt.append(times[i])
        vv.append(values[i])
    return tt, vv


def unit(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return [v[0] / n, v[1] / n, v[2] / n]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def frame(axis):
    """(e0, e1, e2): e0 the axis, e1 = up x e0 (horizontal: to the RIGHT of a shooter looking along the axis - the game's
    world is left-handed, x right of z; the page flips z for three.js), e2 = e0 x e1 (up)."""
    e0 = unit(axis)
    e1 = unit([e0[2], 0.0, -e0[0]])
    return e0, e1, cross(e0, e1)


def tangent(basis, v):
    """A direction's (x, y) in radians in the tangent plane of basis[0]: x to the right, y up."""
    e0, e1, e2 = basis
    v = unit(v)
    d = dot(v, e0)
    return [dot(v, e1) / d, dot(v, e2) / d]


def direction(basis, xy):
    e0, e1, e2 = basis
    return unit([e0[k] + xy[0] * e1[k] + xy[1] * e2[k] for k in range(3)])


# ---- the staircase of the packed codes (round 4c) ---------------------------------------------------------------------
def stair_window(ts, vs, tau):
    """Tick offsets from tau and the code there for the STAIR_TICKS ticks either side (the grid of the updates)."""
    i = bisect_right(ts, tau)
    if i == 0: return [], []
    ref = ts[i - 1]
    g0 = ref + math.floor((tau - ref) / GRID + 1e-6) * GRID
    dts, codes = [], []
    for k in range(-STAIR_TICKS + 1, STAIR_TICKS + 1):
        g = g0 + k * GRID
        j = bisect_right(ts, g + 1e-4)
        if j == 0 or g > ts[-1] + 5.0: continue
        dts.append(g - tau)
        codes.append(vs[j - 1])
    return dts, codes


def lines_centre(dts, vs, h, vmax):
    """The centroid (at dt 0) of the lines with |rate| <= vmax passing within h of every tick's code; None if none."""
    num = den = 0.0
    for k in range(STAIR_LINES):
        b = -vmax + 2.0 * vmax * k / (STAIR_LINES - 1)
        r = [v - b * d for v, d in zip(vs, dts)]
        lo, hi = max(r) - h, min(r) + h
        if hi >= lo:
            w = hi - lo + 1e-12
            num += w * 0.5 * (lo + hi)
            den += w
    return num / den if den > 0 else None


def kink_centre(dts, vs, h, vmax):
    """The centroid (at dt 0) of the continuous lines with one change of rate anywhere in the window (a start, a stop, a
    reversal), both rates within vmax, passing within h of every tick's code; None if none."""
    n = STAIR_KINK_RATES - 1
    step = 2.0 * vmax / n
    rates = [i * step - vmax for i in range(n)] + [vmax]
    if 0.0 not in rates: rates = sorted(rates + [0.0])
    kinks = sorted(set(dts)) + [(dts[i] + dts[i + 1]) / 2.0 for i in range(len(dts) - 1)]
    num = den = 0.0
    for ts in kinks:
        a = [min(d, ts) - min(0.0, ts) for d in dts]
        b = [max(d, ts) - max(0.0, ts) for d in dts]
        for s1 in rates:
            base = [v - s1 * x for v, x in zip(vs, a)]
            for s2 in rates:
                r = [p - s2 * y for p, y in zip(base, b)]
                lo, hi = max(r) - h, min(r) + h
                if hi >= lo:
                    w = hi - lo + 1e-12
                    num += w * 0.5 * (lo + hi)
                    den += w
    return num / den if den > 0 else None


def stair(ts, vs, tau, step, vmax, plain):
    """(value, case) of a packed angle at tau: a steady turn by the bounded lines, a start / stop by the one-kink lines,
    else (still, complex, too few ticks) the plain interpolation."""
    dts, codes = stair_window(ts, vs, tau)
    if len(dts) < 2: return plain, 'none'
    h = step / 2.0
    if max(codes) - min(codes) < 1e-9: return plain, 'still'
    value = lines_centre(dts, codes, h, vmax)
    if value is not None: return value, 'steady'
    value = kink_centre(dts, codes, h, vmax)
    if value is not None: return value, 'kink'
    return plain, 'complex'


# ---- one shooter --------------------------------------------------------------------------------------------------------
class Shooter(object):
    """One vehicle's track in a battle: positions and hull angles, packed gun angles decoded over the gun's absolute pitch
    limits, its gun's inputs; the size model and the track axis at a moment."""

    def __init__(self, positions, guns, inputs):
        self.inputs = inputs
        times, values = positions
        rows = [tuple(float(values[k * 6 + j]) for j in range(6)) for k in range(len(times))]
        self.pt, rows = dedupe([float(t) for t in times], rows)
        self.px = [r[0] for r in rows]
        self.py = [r[1] for r in rows]
        self.pz = [r[2] for r in rows]
        self.pyaw = unwrap([r[3] for r in rows])
        self.ppitch = [r[4] for r in rows]
        self.proll = [r[5] for r in rows]
        path, s = [0.0], 0.0
        for k in range(1, len(rows)):
            d = math.sqrt((self.px[k] - self.px[k - 1]) ** 2 + (self.py[k] - self.py[k - 1]) ** 2 + (self.pz[k] - self.pz[k - 1]) ** 2)
            s += d if d <= TELEPORT else 0.0
            path.append(s)
        self.ps = path
        lo, hi = inputs['pitchLimits']
        gt, codes = guns
        self.at, codes = dedupe([float(t) for t in gt], [int(c) for c in codes])
        self.ayaw = unwrap([2.0 * math.pi * ((c >> 6) & 1023) / 1024.0 - math.pi for c in codes])
        self.apitch = [lo + (c & 63) / 63.0 * (hi - lo) for c in codes]
        self.pitch_step = (hi - lo) / 63.0
        self.hull_holds = with_holds(self.pt, self.pyaw)
        self.turret_holds = with_holds(self.at, self.ayaw)
        speeds = inputs.get('turretRotationSpeed'), inputs.get('gunPitchSpeed')
        self.vmax = (STAIR_RATE * (speeds[0] or DEFAULT_SPEEDS[0]), STAIR_RATE * (speeds[1] or DEFAULT_SPEEDS[1]))
        self.aim = dict((k, inputs.get(k)) for k in ('dispersion', 'aimingTime', 'movementFactor', 'rotationFactor',
                                                       'turretRotationFactor', 'afterShotFactor'))

    def ok(self):
        return len(self.pt) >= 10 and len(self.at) >= 2

    # -- the size model
    def grid(self):
        n = int(math.ceil((self.pt[-1] - self.pt[0]) / GRID - 1e-9))
        return self.pt[0], max(n, 1)

    def tick_state(self, t):
        """(speed, hull turn, turret turn) of the size model at grid time t."""
        a, b = t - SIZE_LAG - SIZE_WINDOW / 2.0, t - SIZE_LAG + SIZE_WINDOW / 2.0
        d = [interp(self.pt, s, b) - interp(self.pt, s, a) for s in (self.px, self.py, self.pz)]
        speed = math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / SIZE_WINDOW
        ht, hv = self.hull_holds
        hull = abs(interp(ht, hv, b) - interp(ht, hv, a)) / SIZE_WINDOW
        tt, tv = self.turret_holds
        turret = abs(interp(tt, tv, b) - interp(tt, tv, a)) / SIZE_WINDOW
        return speed, hull, turret

    def size_steps(self, shots, wanted, out):
        """R_est (rad) at each clock of `wanted` into out[clock]: the factor on the 0.1 s grid from SETTLE aiming times
        before each, the shots (clocks) blooming the tick at or after their tracer. Yields after each stretch simulated."""
        t0, n = self.grid()
        ticks = lambda k: t0 + k * GRID
        bloom = set()
        for c in shots:
            k = int(math.ceil((c - BLOOM_EPS - t0) / GRID - 1e-9))
            k = max(k, 0)
            # searchsorted(left) of c - eps on the grid: the first tick >= c - eps
            while k > 0 and ticks(k - 1) >= c - BLOOM_EPS: k -= 1
            while k < n and ticks(k) < c - BLOOM_EPS: k += 1
            if k < n: bloom.add(k)
        aiming = aim_ideal(self.aim, 0.0, 0.0, 0.0, False, TYPICAL)[1]
        back = int(math.ceil(max(SETTLE * aiming, SETTLE_MIN) / GRID))
        need = []
        for c in wanted:
            # the last tick strictly before the clock (numpy searchsorted - 1, as the measurement read it)
            k = int(math.floor((c - t0) / GRID))
            while k + 1 < n and ticks(k + 1) < c: k += 1
            while k >= 0 and not ticks(k) < c: k -= 1
            need.append((max(0, min(k, n - 1)), c))
        need.sort()
        state, at = None, -1
        base = self.aim['dispersion']
        for k, c in need:
            if state is None or k - back > at:
                state, at = None, max(0, k - back) - 1
            while at < k:
                at += 1
                v, w, wt = self.tick_state(ticks(at))
                ideal, aiming = aim_ideal(self.aim, v, w, wt, False, TYPICAL)
                state = (ideal, ideal, 0.0) if state is None else aim_step(state, ideal, aiming, GRID)
                if at in bloom:
                    state = aim_shot(state, aim_ideal(self.aim, v, w, wt, True, TYPICAL)[0], ideal)
            out[c] = base * state[0]
            yield

    # -- the track
    def pose(self, t):
        return [interp(self.pt, s, t) for s in (self.px, self.py, self.pz, self.pyaw, self.ppitch, self.proll)]

    def angles(self, t):
        """Turret yaw, gun pitch: linear between the samples around t; a pair over HOLD_GAP apart holds the earlier."""
        i = bisect_right(self.at, t)
        if i == 0: return self.ayaw[0], self.apitch[0]
        if i == len(self.at) or self.at[i] - self.at[i - 1] > HOLD_GAP: return self.ayaw[i - 1], self.apitch[i - 1]
        f = (t - self.at[i - 1]) / (self.at[i] - self.at[i - 1])
        return (self.ayaw[i - 1] + f * (self.ayaw[i] - self.ayaw[i - 1]),
                self.apitch[i - 1] + f * (self.apitch[i] - self.apitch[i - 1]))

    def age(self, t):
        i = bisect_right(self.pt, t)
        return t - self.pt[i - 1] if i else 99.0

    def shot(self, t):
        """What the estimator needs of the moment t (a tracer clock): the track axis, the features of the vehicle."""
        row = self.pose(t - POSE_LAG)
        tau = t - ANGLE_LAG
        y0, p0 = self.angles(tau)
        y, case = stair(self.at, self.ayaw, tau, YAW_STEP, self.vmax[0], y0)
        p, _ = stair(self.at, self.apitch, tau, self.pitch_step, self.vmax[1], p0)
        m = mm(mm(world_of(row), RY(y)), RX(p))
        axis = [m[8], m[9], m[10]]
        back = self.pose(t - POSE_LAG - RATE_SPAN)
        speed = math.sqrt(sum((row[k] - back[k]) ** 2 for k in range(3))) / RATE_SPAN
        yb = self.angles(tau - RATE_SPAN)[0] + interp(self.pt, self.pyaw, tau - RATE_SPAN - POSE_LAG)
        gun_rate = abs((y0 + row[3]) - yb) / RATE_SPAN
        w = world_of(row)
        along = [w[0] * math.sin(y0) + w[8] * math.cos(y0), w[1] * math.sin(y0) + w[9] * math.cos(y0),
                 w[2] * math.sin(y0) + w[10] * math.cos(y0)]
        tilt = math.asin(max(-1.0, min(1.0, along[1])))
        return {'t':t, 'axis':axis, 'case':case, 'speed':speed, 'gunRate':gun_rate, 'path':interp(self.pt, self.ps, t - POSE_LAG),
                'hullYaw':row[3], 'tilt':tilt, 'turretYaw':y0}


def stop_keys(rows):
    """A stop per row of one vehicle (rows sorted by time): standing (< STOP_SPEED) within STOP_PATH of path and STOP_YAW
    of hull yaw of the stop's first row; a moving row is its own stop. Returns [(moving, number)]."""
    keys, first, n = [], None, 0
    for r in rows:
        if r['speed'] >= STOP_SPEED:
            n += 1
            keys.append((True, n))
            first = None
            continue
        if first is None or abs(r['path'] - first['path']) > STOP_PATH or abs(wrap(r['hullYaw'] - first['hullYaw'])) > STOP_YAW:
            n += 1
            first = r
        keys.append((False, n))
    return keys


def solve(a, rhs):
    """x of a x = rhs for a small dense symmetric positive matrix (Gauss-Jordan with partial pivots) and the inverse's
    diagonal: (x, diag)."""
    n = len(a)
    m = [list(a[i]) + [rhs[i]] + [1.0 if j == i else 0.0 for j in range(n)] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        d = m[c][c]
        m[c] = [x / d for x in m[c]]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c]
                rc = m[c]
                m[r] = [x - f * y for x, y in zip(m[r], rc)]
    return [m[i][n] for i in range(n)], [m[i][n + 1 + i] for i in range(n)]


def vertical(rows, keys, dev):
    """The Gaussian process over one vehicle's shots: (posterior mean, posterior variance) of each axis's y. A = K +
    diag(dev), K = VEHICLE_SD^2 (all) + per stop sd^2 cos(yaw_i - yaw_j) + CODE_SD^2 on the diagonal; solved per stop
    and joined through the per-vehicle offset (Sherman-Morrison)."""
    n = len(rows)
    mu = [VERTICAL_MEAN + VERTICAL_TILT * r['tilt'] for r in rows]
    resid = [r['tracer'][1] - mu[i] for i, r in enumerate(rows)]
    groups = {}
    for i, k in enumerate(keys): groups.setdefault(k, []).append(i)
    z, ones, diag = [0.0] * n, [0.0] * n, [0.0] * n
    for key, idx in groups.items():
        s2 = (MOVING_SD if key[0] else STOP_SD) ** 2
        block = [[s2 * math.cos(rows[i]['turretYaw'] - rows[j]['turretYaw']) + (CODE_SD ** 2 + dev[i] if i == j else 0.0)
                  for j in idx] for i in idx]
        x, d = solve(block, [resid[i] for i in idx])
        x1, _ = solve(block, [1.0] * len(idx))
        for k, i in enumerate(idx):
            z[i], ones[i], diag[i] = x[k], x1[k], d[k]
    v2 = VEHICLE_SD ** 2
    sum_r, sum_1 = sum(z), sum(ones)
    scale = v2 / (1.0 + v2 * sum_1)
    solved = [z[i] - ones[i] * scale * sum_r for i in range(n)]
    inverse = [diag[i] - scale * ones[i] * ones[i] for i in range(n)]
    mean = [rows[i]['tracer'][1] - dev[i] * solved[i] for i in range(n)]
    var = [max(dev[i] - dev[i] * dev[i] * inverse[i], 1e-14) for i in range(n)]
    return mean, var


def horizontal(x, dev, mixture):
    """Posterior mean and variance of the track's horizontal error e given x = e + deviation (the mixture's prior)."""
    p, s1, s2 = mixture
    comps = []
    for pk, sk in ((p, s1), (1.0 - p, s2)):
        v = sk * sk + dev
        g = sk * sk / v
        comps.append((pk * math.exp(-x * x / (2.0 * v)) / math.sqrt(v), g * x, g * dev))
    total = sum(c[0] for c in comps) + 1e-300
    mean = sum(c[0] * c[1] for c in comps) / total
    var = sum(c[0] * (c[2] + c[1] ** 2) for c in comps) / total - mean * mean
    return mean, max(var, 1e-14)


def constrain(tracer, mean, var, radius):
    """The point nearest `mean` in the posterior's metric with |tracer - point| <= radius."""
    if math.hypot(mean[0] - tracer[0], mean[1] - tracer[1]) <= radius: return mean
    w = [1.0 / var[0], 1.0 / var[1]]
    at = lambda lam: [(w[k] * mean[k] + lam * tracer[k]) / (w[k] + lam) for k in (0, 1)]
    far = lambda lam: math.hypot(at(lam)[0] - tracer[0], at(lam)[1] - tracer[1]) > radius
    lo, hi = 0.0, max(w)
    while far(hi): lo, hi = hi, hi * 4.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if far(mid): lo = mid
        else: hi = mid
    return at(hi)


def estimate(rows):
    """The circles of one vehicle's estimated shots (rows: shot() + tracer, R_est), in place: 'centre' (x, y) in the
    track axis's tangent plane, 'var'. The stops and the vertical process span all of them."""
    rows.sort(key=lambda r: r['t'])
    keys = stop_keys(rows)
    dev = [(DEVIATION_SD * r['R']) ** 2 * SIZE_RATIO2 for r in rows]
    ys, yv = vertical(rows, keys, dev)
    count = {}
    for k in keys: count[k] = count.get(k, 0) + 1
    for i, r in enumerate(rows):
        mixture = HORIZONTAL['still' if r['gunRate'] < STILL_GUN else 'turning']
        xm, xv = horizontal(r['tracer'][0], dev[i], mixture)
        r['centre'] = constrain(r['tracer'], [xm, ys[i]], [xv, yv[i]], INSIDE * r['R'])
        r['var'] = (xv, yv[i])
        r['stop'] = keys[i]
        r['inStop'] = 0 if keys[i][0] else count[keys[i]]
    return rows


def block_of(row):
    """The block on the tracer of one estimated shot."""
    basis = frame(row['axis'])
    centre = direction(basis, row['centre'])
    R = row['R']
    shell = [(row['tracer'][0] - row['centre'][0]) / R, (row['tracer'][1] - row['centre'][1]) / R]
    return {'format':FORMAT, 'source':SOURCE, 'estimate':True,
            'circle':{'origin':list(row['origin']), 'vector':[round(v, 9) for v in centre], 'dispersionAngle':round(R, 9)},
            'track':{'vector':[round(v, 9) for v in unit(row['axis'])]},
            'shell':{'right':round(shell[0], 4), 'up':round(shell[1], 4)},
            'uncertainty':{'centreRight':round(math.sqrt(row['var'][0]) / R, 3), 'centreUp':round(math.sqrt(row['var'][1]) / R, 3),
                           'sizeBand':list(SIZE_BAND), 'centreMeasured':list(CENTRE_ERROR), 'information':dict(INFORMATION)},
            'basis':{'case':CASES[row['case']], 'gun':'still' if row['gunRate'] < STILL_GUN else 'turning',
                     'moving':row['stop'][0], 'shotsInStop':row['inStop'], 'shotsOfVehicle':row['shots'],
                     'crewAndEquipment':'typical'},
            'limits':list(LIMITS), 'absent':list(ABSENT)}


def absent_block(why, detail=None):
    text = WHY[why] % detail if '%s' in WHY[why] else WHY[why]
    return {'format':FORMAT, 'source':SOURCE, 'estimate':True, 'reason':text, 'reasonKey':why, 'absent':list(ABSENT)}


def not_modelled(inputs):
    """The reason a vehicle's gun is not modelled (a WHY key), or None."""
    tags = set(str(t) for t in inputs.get('gunTags') or ())
    if 'autoShoot' in tags or inputs.get('autoShoot'): return 'auto'
    if 'dualAccuracy' in tags or inputs.get('dualAccuracy'): return 'dual'
    return None


def burst_rounds(inputs, tracers):
    """The ids of the tracers that are a later round of a burst (gun.burst: count > 1): another main-gun tracer of the
    vehicle came at most (count - 1) x the burst's interval + BURST_SLACK s before it. The first round's circle is the
    ordinary one (the in-burst term blooms the rounds after it, Avatar.getOwnVehicleShotDispersionAngle withShot 2)."""
    burst = inputs.get('burst')
    if not (isinstance(burst, (list, tuple)) and len(burst) > 1 and (burst[0] or 0) > 1): return set()
    span = (burst[0] - 1) * float(burst[1] or 0.0) + BURST_SLACK
    clocks = sorted(c for c, _ in tracers)
    out = set()
    for c, r in tracers:
        i = bisect_right(clocks, c - SAME_SHOT)
        if i and c - clocks[i - 1] <= span: out.add(id(r))
    return out


# ---- one vehicle's tracers, and a battle --------------------------------------------------------------------------------
def vehicle_steps(positions, guns, inputs, tracers, out):
    """The blocks of one vehicle's tracers (records with 'gameTime' clock fields: (clock, record) pairs, main gun, no
    ricochet) into out[id(record)] = block. Yields between units of work."""
    why = not_modelled(inputs)
    if why is not None:
        for _, r in tracers: out[id(r)] = absent_block(why)
        return
    if not positions or not guns:
        for _, r in tracers: out[id(r)] = absent_block('track')
        return
    if not inputs.get('pitchLimits') or not (inputs.get('dispersion') or 0) > 0:
        for _, r in tracers: out[id(r)] = absent_block('gun', 'no dispersion or pitch limits')
        return
    shooter = Shooter(positions, guns, inputs)
    if not shooter.ok():
        for _, r in tracers: out[id(r)] = absent_block('track')
        return
    yield
    wanted, rows, later = [], [], burst_rounds(inputs, tracers)
    for clock, r in tracers:
        if id(r) in later: out[id(r)] = absent_block('burst')
        elif r.get('siegeState') and inputs.get('hasSiegeMode'): out[id(r)] = absent_block('mode')
        elif shooter.age(clock) > POSE_AGE: out[id(r)] = absent_block('view')
        else: wanted.append((clock, r))
    if not wanted: return
    sizes = {}
    for _ in shooter.size_steps([c for c, _ in tracers], [c for c, _ in wanted], sizes): yield
    for clock, r in wanted:
        row = shooter.shot(clock)
        row['R'] = sizes[clock]
        row['tracer'] = tangent(frame(row['axis']), r['velocity'])
        row['origin'] = r['origin']
        row['record'] = r
        rows.append(row)
        yield
    estimate(rows)
    for row in rows:
        row['shots'] = len(rows)
        out[id(row['record'])] = block_of(row)
    yield


def clock_of(record, start):
    return float(record['gameTime']) - float(start)


def attaching(records, inputs, report):
    """Every other vehicle's tracer of a replay's records (replay_records.Converter with poses) gets KEY, in steps.
    `inputs(compact)`: the vehicle's gun (exporter.aim_estimate_inputs), may raise. `report` gets the counts."""
    poses = next((r for r in records if r.get('type') == 'poses'), None)
    report.update({'tracers':0, 'circles':0, 'absent':{}})
    if poses is None: return
    player, start = poses.get('playerVehicleId'), poses.get('serverTimeAtStart')
    if start is None: return
    by = {}
    for r in records:
        if r.get('type') != 'shot' or r.get('event') != 'tracer' or r.get('own') or r.get('isRicochet'): continue
        if r.get('shooterId') == player or not isinstance(r.get('gameTime'), (int, float)): continue
        if not isinstance(r.get('velocity'), list) or not isinstance(r.get('origin'), list): continue
        by.setdefault(r.get('shooterId'), []).append(r)
    known = {}
    for vid in sorted(by, key=lambda v: (v is None, v)):
        tracers = [(clock_of(r, start), r) for r in by[vid]]
        report['tracers'] += len(tracers)
        out = {}
        for c, r in tracers:
            if r.get('gunInstallationIndex'): out[id(r)] = absent_block('secondary')
        # A respawn mode brings the id back in ANOTHER vehicle (BACKLOG 97): each life of the id - its descriptor and the
        # stretch of its track from its creation to the next one - is a vehicle of its own: its gun, its size model.
        lives = lives_of(poses, vid) or [(0.0, None)]
        whens = [float(w) for w, _ in lives]
        for k, (born, compact) in enumerate(lives):
            end = whens[k + 1] if k + 1 < len(whens) else None
            main = [(c, r) for c, r in tracers if not r.get('gunInstallationIndex')
                    and (k == 0 or c >= whens[k] - 1e-6) and (end is None or c < end - 1e-6)]
            if not main: continue
            positions, guns = (poses.get('positions') or {}).get(vid), (poses.get('guns') or {}).get(vid)
            if len(lives) > 1: positions, guns = life_tracks(positions, guns, whens[k] if k else None, end)
            gun = None
            if compact is not None and positions and guns:
                if compact not in known:
                    try: known[compact] = inputs(compact)
                    except Exception as exc: known[compact] = exc
                gun = known[compact]
            if not (positions and guns):
                for c, r in main: out[id(r)] = absent_block('track')
            elif gun is None or isinstance(gun, Exception):
                detail = 'no compact descriptor' if gun is None else (str(gun) or type(gun).__name__)
                for c, r in main: out[id(r)] = absent_block('gun', detail)
            else:
                try:
                    for _ in vehicle_steps(positions, guns, gun, main, out):
                        yield
                except (ArithmeticError, IndexError, KeyError, TypeError, ValueError) as exc:
                    for c, r in main: out[id(r)] = absent_block('gun', 'estimate failed: %s' % (str(exc) or type(exc).__name__))
        for c, r in tracers:
            block = out.get(id(r))
            if block is None: continue
            r[KEY] = block
            if 'circle' in block: report['circles'] += 1
            else: report['absent'][block['reasonKey']] = report['absent'].get(block['reasonKey'], 0) + 1
        yield


def life_tracks(positions, guns, start, end):
    """(positions, guns) of one life of a vehicle id: the samples with start <= time < end (None: open)."""
    def cut(track, width):
        if not track: return track
        times, values = track
        lo = 0 if start is None else bisect_right(times, start - 1e-6)
        hi = len(times) if end is None else bisect_right(times, end - 1e-6)
        return times[lo:hi], values[lo * width:hi * width]
    return cut(positions, 6), cut(guns, 1)


def attach(records, inputs):
    """attaching() at once; returns its report."""
    report = {}
    for _ in attaching(records, inputs, report): pass
    return report


def count(shots):
    """(tracers with a block, of them with a circle) among published shot records (replay_battle.build's report)."""
    blocks = [s[KEY] for s in shots if s.get('event') == 'tracer' and isinstance(s.get(KEY), dict)]
    return len(blocks), sum(1 for b in blocks if 'circle' in b)
