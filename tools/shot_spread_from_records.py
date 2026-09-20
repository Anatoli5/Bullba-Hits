"""Measure the shot distribution inside the aiming circle from the own recorded shots.

For every own tracer (hits AND misses) the tool takes the angular offset of the
actual initial shot direction from the server's aim direction and normalises it by
the server's dispersion angle, then compares the radial CDF with two models:

  gauss-r2        2D Gaussian sigma = R/2 truncated to the circle (what web/viewer.js
                  sampleCircle() integrates):  F(t) = (1 - exp(-2t^2)) / (1 - exp(-2))
  empirical-p96   the Overlord_Prime post-0.9.6 table (outputs/shot-distribution-2026-09-19.md
                  section 3), piecewise linear in the radius between the 0.1 knots.

The scale of the real distribution relative to the reference circle is estimated
separately as R_eff = k * R_ref, by least squares on the CDF (Cramer-von Mises core:
sum over the order statistics of ((i-0.5)/N - F_model(q_i/k))^2). Uncertainty comes
from a bootstrap over battles, because shots inside one battle are not independent.

The records are private. The tool reads ONLY telemetry numbers and prints numbers and
counts; it never reads, prints or stores a nickname or any other player identity, and
battles are reported as indices, not file names. Nothing under the game folder is written.

Usage:
    runtime\\python.exe tools\\shot_spread_from_records.py
    runtime\\python.exe tools\\shot_spread_from_records.py --folder <battles dir> --bootstrap 200 --seed 20260919

Python 3, standard library only.
"""

import argparse
import io
import json
import math
import os
import random

DEFAULT_FOLDER = r'C:\Games\World_of_Tanks_NA\mods\configs\local.armor_inspector\battles'

UP = (0.0, 1.0, 0.0)

# Primary subset thresholds (spec): the vehicle and the turret must be still and the
# last server gun update must be fresh.
STILL_SPEED = 0.2       # m/s
STILL_ROTATION = 0.01   # rad/s
STILL_TURRET = 0.01     # rad/s
MAX_AGE = 0.3           # s

GRID = [0.1 * i for i in range(1, 11)]
RINGS = [0.1 * i for i in range(1, 16)]

# Overlord_Prime, Post-0.9.6 Shot Distribution Probability Table: cumulative share
# at the upper edge of every 0.1 ring; the last 0.1 % ("edge") is an atom at t = 1.
TABLE_CUM = [0.0, 0.099, 0.260, 0.421, 0.567, 0.689, 0.788, 0.861, 0.917, 0.961, 0.999]


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def scale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def length(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = length(a)
    if n < 1e-9:
        return None
    return [a[0] / n, a[1] / n, a[2] / n]


def finite_vec(value):
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    out = []
    for i in range(3):
        try:
            x = float(value[i])
        except (TypeError, ValueError):
            return None
        if math.isnan(x) or math.isinf(x):
            return None
        out.append(x)
    return out


def cdf_gauss(t):
    """2D Gaussian sigma = R/2 conditioned on the disc."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return (1.0 - math.exp(-2.0 * t * t)) / (1.0 - math.exp(-2.0))


def cdf_table(t):
    """Overlord_Prime table, linear in the radius inside a ring, atom at the edge."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    i = int(t * 10.0)
    if i > 9:
        i = 9
    lo = i * 0.1
    return TABLE_CUM[i] + (TABLE_CUM[i + 1] - TABLE_CUM[i]) * (t - lo) / 0.1


MODELS = (('gauss-r2', cdf_gauss), ('empirical-p96', cdf_table))


def tabulate_marginal(cdf, umax=3.0, du=0.002, steps=1200):
    """P(|Y| <= u) for the isotropic 2D law whose radial CDF is `cdf`.

    A point at radius t has a uniform angle, so P(|t sin phi| <= u) is 1 for t <= u
    and (2/pi) asin(u/t) above it. The radial law is binned once and the marginal is
    tabulated on a grid, so the fit and the bootstrap can look it up.
    """
    bins = []
    previous = 0.0
    for i in range(steps):
        upper = (i + 1) / steps
        current = cdf(upper)
        weight = current - previous
        previous = current
        if weight > 0.0:
            bins.append(((i + 0.5) / steps, weight))
    tail = 1.0 - previous
    if tail > 1e-12:
        bins.append((1.0, tail))
    count = int(umax / du) + 2
    table = []
    for j in range(count):
        u = j * du
        total = 0.0
        for t, weight in bins:
            if t <= u:
                total += weight
            else:
                total += weight * (2.0 / math.pi) * math.asin(u / t)
        table.append(total)

    def lookup(u):
        if u <= 0.0:
            return 0.0
        if u >= umax:
            return 1.0
        j = int(u / du)
        lo = table[j]
        return lo + (table[j + 1] - lo) * (u / du - j)

    return lookup


MARGINALS = None


def marginals():
    global MARGINALS
    if MARGINALS is None:
        MARGINALS = tuple((name, tabulate_marginal(cdf)) for name, cdf in MODELS)
    return MARGINALS


# --------------------------------------------------------------------------- reading

def read_battles(folder):
    """Yield (battle index, tracer record, command record or None, endpoint or None)."""
    names = sorted(f for f in os.listdir(folder) if f.endswith('.jsonl'))
    for index, name in enumerate(names):
        commands = {}
        tracers = []
        endpoints = {}
        path = os.path.join(folder, name)
        with io.open(path, 'r', encoding='utf-8', errors='replace') as stream:
            for line in stream:
                if '"shot"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get('type') != 'shot':
                    continue
                event = row.get('event')
                if event == 'command':
                    commands[row.get('id')] = row
                elif event == 'tracer':
                    tracers.append(row)
                elif event in ('stop', 'explosion') and row.get('own'):
                    endpoints.setdefault(str(row.get('shotId')), {})[event] = row
        for row in tracers:
            end = endpoints.get(str(row.get('shotId')), {})
            yield index + 1, row, commands.get(row.get('possibleCommandId')), (end.get('stop') or end.get('explosion'))


def transverse(n):
    e1 = unit(cross(n, list(UP)))
    if e1 is None:
        return None
    return e1, cross(e1, n)


def offsets(n, v, angle):
    """qx, qy of the actual direction v against the reference direction n, per angle."""
    u = unit(n)
    if u is None or angle is None or angle <= 0.0:
        return None
    axes = transverse(u)
    if axes is None:
        return None
    e1, e2 = axes
    forward = dot(v, u)
    if forward <= 1e-6:
        return None
    qx = dot(v, e1) / forward / angle
    qy = dot(v, e2) / forward / angle
    return qx, qy


def trajectory_offset(origin, nominal_velocity, gravity, endpoint, angle):
    """Offset of the endpoint from the nominal ballistic trajectory at the same range."""
    u = unit(nominal_velocity)
    if u is None:
        return None
    rel = sub(endpoint, origin)
    distance = dot(rel, u)
    if distance < 1.0 or angle is None or angle <= 0.0:
        return None
    speed = dot(nominal_velocity, u)
    a = -0.5 * gravity * u[1]
    disc = speed * speed + 4.0 * a * distance
    if disc < 0.0:
        return None
    denom = speed + math.sqrt(disc)
    if abs(denom) < 1e-9:
        return None
    t = 2.0 * distance / denom
    if t <= 0.0:
        return None
    nominal = add(add(origin, scale(nominal_velocity, t)), [0.0, -0.5 * gravity * t * t, 0.0])
    delta = sub(endpoint, nominal)
    perp = sub(delta, scale(u, dot(delta, u)))
    return length(perp) / (distance * angle), distance


def collect(folder):
    """Build the per-shot rows and the exclusion counters."""
    rows = []
    counts = {
        'tracer records': 0,
        'not own': 0,
        'ricochet': 0,
        'secondary gun installation': 0,
        'no aimAtTracer snapshot': 0,
        'no lastServerGunUpdate': 0,
        'bad server vector or angle': 0,
        'degenerate geometry': 0,
        'usable': 0,
    }
    for battle, row, command, endpoint in read_battles(folder):
        counts['tracer records'] += 1
        if not row.get('own'):
            counts['not own'] += 1
            continue
        if row.get('isRicochet'):
            counts['ricochet'] += 1
            continue
        if row.get('gunInstallationIndex') != 0:
            counts['secondary gun installation'] += 1
            continue
        aim = row.get('aimAtTracer')
        if not isinstance(aim, dict):
            counts['no aimAtTracer snapshot'] += 1
            continue
        server = aim.get('lastServerGunUpdate')
        if not isinstance(server, dict):
            counts['no lastServerGunUpdate'] += 1
            continue
        n = finite_vec(server.get('vector'))
        origin = finite_vec(server.get('origin'))
        v = finite_vec(row.get('velocity'))
        try:
            angle = float(server.get('dispersionAngle'))
        except (TypeError, ValueError):
            angle = 0.0
        if n is None or v is None or origin is None or angle <= 0.0:
            counts['bad server vector or angle'] += 1
            continue
        primary = offsets(n, v, angle)
        if primary is None:
            counts['degenerate geometry'] += 1
            continue
        counts['usable'] += 1

        speeds = aim.get('vehicleSpeeds') or [0.0, 0.0]
        try:
            speed = abs(float(speeds[0]))
            rotation = abs(float(speeds[1])) if len(speeds) > 1 else 0.0
        except (TypeError, ValueError):
            speed, rotation = 0.0, 0.0
        try:
            turret = abs(float(aim.get('turretRotationSpeed') or 0.0))
        except (TypeError, ValueError):
            turret = 0.0
        age = float(row.get('receivedAt', 0.0)) - float(server.get('receivedAt', 0.0))

        entry = {
            'battle': battle,
            'qx': primary[0],
            'qy': primary[1],
            'q': math.hypot(primary[0], primary[1]),
            'age': age,
            'speed': speed,
            'rotation': rotation,
            'turret': turret,
            'gun': row.get('gunIndex'),
            'shell': ((aim.get('selectedShell') or {}).get('kind')
                      if isinstance(aim.get('selectedShell'), dict) else None),
            'angle': angle,
            'still': speed < STILL_SPEED and rotation < STILL_ROTATION and turret < STILL_TURRET,
            'fresh': age <= MAX_AGE,
        }

        # Alternative references (scale check, section 4 of the research note).
        marker = aim.get('serverMarker')
        if isinstance(marker, dict):
            direction = finite_vec(marker.get('direction'))
            if direction is not None:
                alt = offsets(direction, v, angle)
                if alt is not None:
                    entry['q_server_marker'] = math.hypot(alt[0], alt[1])
        client_angle = None
        client_direction = None
        command_aim = command.get('aim') if isinstance(command, dict) else None
        if isinstance(command_aim, dict):
            angles = command_aim.get('dispersionAngles')
            if isinstance(angles, list) and angles:
                try:
                    value = float(angles[0])
                except (TypeError, ValueError):
                    value = 0.0
                if value > 0.0:
                    client_angle = value
            client_marker = command_aim.get('clientMarker')
            if isinstance(client_marker, dict):
                client_direction = finite_vec(client_marker.get('direction'))
        entry['client_angle'] = client_angle
        if client_angle:
            alt = offsets(n, v, client_angle)
            if alt is not None:
                entry['q_client_angle'] = math.hypot(alt[0], alt[1])
            if client_direction is not None:
                alt = offsets(client_direction, v, client_angle)
                if alt is not None:
                    entry['q_client_marker'] = math.hypot(alt[0], alt[1])

        if endpoint is not None:
            end = finite_vec(endpoint.get('position'))
            try:
                gravity = float(row.get('gravity') or 0.0)
            except (TypeError, ValueError):
                gravity = 0.0
            if end is not None and gravity > 0.0:
                check = trajectory_offset(origin, n, gravity, end, angle)
                if check is not None:
                    entry['q_trajectory'] = check[0]
                    entry['range'] = check[1]
        rows.append(entry)
    return rows, counts


# --------------------------------------------------------------------------- statistics

def mean_se(values):
    n = len(values)
    if n == 0:
        return 0.0, 0.0
    m = sum(values) / n
    if n < 2:
        return m, 0.0
    var = sum((x - m) ** 2 for x in values) / (n - 1)
    return m, math.sqrt(var / n)


def empirical_cdf(qs, t):
    if not qs:
        return 0.0
    return sum(1 for q in qs if q <= t) / len(qs)


def cvm(qs, cdf, k):
    """Cramer-von Mises core: the least-squares criterion on the CDF."""
    n = len(qs)
    total = 0.0
    for i, q in enumerate(qs):
        total += ((i + 0.5) / n - cdf(q / k)) ** 2
    return total


def fit_scale(qs, cdf, lo=0.20, hi=4.00):
    """Least squares on the CDF; coarse grid then a refinement pass."""
    if not qs:
        return None
    ordered = sorted(qs)
    best, best_value = lo, None
    step = 0.01
    k = lo
    while k <= hi + 1e-9:
        value = cvm(ordered, cdf, k)
        if best_value is None or value < best_value:
            best, best_value = k, value
        k += step
    k = max(lo, best - step)
    stop = min(hi, best + step)
    while k <= stop + 1e-9:
        value = cvm(ordered, cdf, k)
        if value < best_value:
            best, best_value = k, value
        k += 0.0005
    return best


def percentile(values, p):
    if not values:
        return float('nan')
    ordered = sorted(values)
    i = p * (len(ordered) - 1)
    lo = int(math.floor(i))
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (i - lo)


def bootstrap(rows, draws, seed):
    """Resample whole battles, because shots inside one battle are correlated."""
    by_battle = {}
    for row in rows:
        by_battle.setdefault(row['battle'], []).append(row['q'])
    battles = sorted(by_battle)
    if len(battles) < 2 or draws <= 0:
        return None
    rng = random.Random(seed)
    out = {'cdf05': [], 'cdf03': [], 'median': []}
    for name, _ in MODELS:
        out['k:' + name] = []
    for _ in range(draws):
        sample = []
        for _ in range(len(battles)):
            sample.extend(by_battle[battles[rng.randrange(len(battles))]])
        if len(sample) < 5:
            continue
        out['cdf05'].append(empirical_cdf(sample, 0.5))
        out['cdf03'].append(empirical_cdf(sample, 0.3))
        out['median'].append(percentile(sample, 0.5))
        for name, cdf in MODELS:
            k = fit_scale(sample, cdf)
            if k is not None:
                out['k:' + name].append(k)
    return out


def report_subset(title, rows, draws, seed):
    print('')
    print('=' * 78)
    print(title)
    print('=' * 78)
    n = len(rows)
    print('N = %d shots in %d battles' % (n, len({r['battle'] for r in rows})))
    if n < 3:
        print('too few shots for statistics')
        return
    qs = sorted(r['q'] for r in rows)
    qx = [r['qx'] for r in rows]
    qy = [r['qy'] for r in rows]
    mx, sx = mean_se(qx)
    my, sy = mean_se(qy)
    print('bias: mean qx = %+.4f +- %.4f (se), mean qy = %+.4f +- %.4f (se)' % (mx, sx, my, sy))
    print('spread of the components: sd qx = %.4f, sd qy = %.4f' % (
        math.sqrt(sum((x - mx) ** 2 for x in qx) / (n - 1)),
        math.sqrt(sum((y - my) ** 2 for y in qy) / (n - 1))))
    print('q: min %.3f, q25 %.3f, median %.3f, q75 %.3f, q90 %.3f, max %.3f' % (
        qs[0], percentile(qs, 0.25), percentile(qs, 0.5),
        percentile(qs, 0.75), percentile(qs, 0.90), qs[-1]))
    print('mean q = %.4f, rms q = %.4f' % (
        sum(qs) / n, math.sqrt(sum(q * q for q in qs) / n)))

    print('')
    print('per battle (index, N, median q, share q <= 0.5):')
    by_battle = {}
    for row in rows:
        by_battle.setdefault(row['battle'], []).append(row['q'])
    for battle in sorted(by_battle):
        values = by_battle[battle]
        print('  battle %2d: N = %3d  median %.3f  share %.3f' % (
            battle, len(values), percentile(values, 0.5), empirical_cdf(values, 0.5)))

    print('')
    print('histogram of q, rings of 0.1:')
    lower = 0.0
    for upper in RINGS:
        count = sum(1 for q in qs if lower < q <= upper)
        print('  (%.1f, %.1f]: %4d  %5.1f %%  |%s' % (
            lower, upper, count, 100.0 * count / n, '#' * count))
        lower = upper
    beyond = sum(1 for q in qs if q > RINGS[-1])
    print('  > %.1f     : %4d  %5.1f %%' % (RINGS[-1], beyond, 100.0 * beyond / n))
    over = sum(1 for q in qs if q > 1.0)
    print('share beyond the reference circle (q > 1): %d of %d = %.1f %%' % (over, n, 100.0 * over / n))

    print('')
    print('radial CDF, measured against the two models at k = 1:')
    print('   t      measured    gauss-r2   empirical-p96')
    for t in GRID:
        print('  %.1f      %7.3f     %7.3f     %7.3f' % (t, empirical_cdf(qs, t), cdf_gauss(t), cdf_table(t)))

    print('')
    print('best scale k (R_eff = k * R_ref), least squares on the CDF:')
    fits = {}
    for name, cdf in MODELS:
        k = fit_scale(qs, cdf)
        fits[name] = k
        print('  %-14s k = %.3f   criterion %.4f (at k = 1: %.4f)' % (
            name, k, cvm(qs, cdf, k), cvm(qs, cdf, 1.0)))

    print('')
    print('radial CDF with each model at its own best k:')
    print('   t      measured    gauss-r2   empirical-p96')
    for t in GRID:
        print('  %.1f      %7.3f     %7.3f     %7.3f' % (
            t, empirical_cdf(qs, t),
            cdf_gauss(t / fits['gauss-r2']), cdf_table(t / fits['empirical-p96'])))

    print('')
    print('largest absolute CDF gap over the observed range (Kolmogorov distance):')
    for name, cdf in MODELS:
        gap1 = max(abs(empirical_cdf(qs, q) - cdf(q)) for q in qs)
        gapk = max(abs(empirical_cdf(qs, q) - cdf(q / fits[name])) for q in qs)
        print('  %-14s at k = 1: %.3f   at k = %.3f: %.3f' % (name, gap1, fits[name], gapk))

    boot = bootstrap(rows, draws, seed)
    if boot:
        print('')
        print('bootstrap over battles, %d resamples (percentile intervals):' % len(boot['cdf05']))
        print('  share q <= 0.3: %.3f   [%.3f, %.3f]' % (
            empirical_cdf(qs, 0.3), percentile(boot['cdf03'], 0.025), percentile(boot['cdf03'], 0.975)))
        print('  share q <= 0.5: %.3f   [%.3f, %.3f]' % (
            empirical_cdf(qs, 0.5), percentile(boot['cdf05'], 0.025), percentile(boot['cdf05'], 0.975)))
        print('  median q      : %.3f   [%.3f, %.3f]' % (
            percentile(qs, 0.5), percentile(boot['median'], 0.025), percentile(boot['median'], 0.975)))
        for name, _ in MODELS:
            values = boot['k:' + name]
            if values:
                print('  k %-14s: %.3f   [%.3f, %.3f]' % (
                    name, fits[name], percentile(values, 0.025), percentile(values, 0.975)))


def bootstrap_component(rows, key, cdf, draws, seed):
    by_battle = {}
    for row in rows:
        by_battle.setdefault(row['battle'], []).append(abs(row[key]))
    battles = sorted(by_battle)
    if len(battles) < 2 or draws <= 0:
        return []
    rng = random.Random(seed)
    out = []
    for _ in range(draws):
        sample = []
        for _ in range(len(battles)):
            sample.extend(by_battle[battles[rng.randrange(len(battles))]])
        if len(sample) < 5:
            continue
        k = fit_scale(sample, cdf)
        if k is not None:
            out.append(k)
    return out


def report_components(title, rows, draws, seed):
    """Horizontal and vertical offsets separately.

    The radial q mixes whatever error the reference direction carries into the real
    spread. The turret follows the mouse mostly in yaw, so a stale server aim vector
    inflates qx and leaves qy comparatively clean. Each component is compared with the
    marginal of the same isotropic model, which is the same law seen along one axis.
    """
    print('')
    print('=' * 78)
    print(title)
    print('=' * 78)
    n = len(rows)
    if n < 5:
        print('too few shots')
        return
    ax = sorted(abs(r['qx']) for r in rows)
    ay = sorted(abs(r['qy']) for r in rows)
    print('N = %d' % n)
    print('  |qx|: median %.3f  q75 %.3f  q90 %.3f  max %.3f  rms %.3f' % (
        percentile(ax, 0.5), percentile(ax, 0.75), percentile(ax, 0.9), ax[-1],
        math.sqrt(sum(x * x for x in ax) / n)))
    print('  |qy|: median %.3f  q75 %.3f  q90 %.3f  max %.3f  rms %.3f' % (
        percentile(ay, 0.5), percentile(ay, 0.75), percentile(ay, 0.9), ay[-1],
        math.sqrt(sum(y * y for y in ay) / n)))
    print('  ratio of the medians |qx| / |qy| = %.2f (1.00 if the reference is clean)' % (
        percentile(ax, 0.5) / percentile(ay, 0.5) if percentile(ay, 0.5) > 1e-9 else float('nan')))

    age = [r['age'] for r in rows]
    absx = [abs(r['qx']) for r in rows]
    absy = [abs(r['qy']) for r in rows]
    for label, values in (('|qx|', absx), ('|qy|', absy)):
        ma, _ = mean_se(age)
        mv, _ = mean_se(values)
        cov = sum((a - ma) * (v - mv) for a, v in zip(age, values))
        va = sum((a - ma) ** 2 for a in age)
        vv = sum((v - mv) ** 2 for v in values)
        r = cov / math.sqrt(va * vv) if va > 0 and vv > 0 else float('nan')
        print('  correlation of %s with the server update age: %+.3f' % (label, r))

    print('')
    print('  one-axis CDF against the model marginals (same law seen along one axis):')
    print('   u        |qx|       |qy|    gauss-r2   empirical-p96')
    for t in GRID:
        line = '  %.1f      %6.3f     %6.3f' % (t, empirical_cdf(ax, t), empirical_cdf(ay, t))
        for _, lookup in marginals():
            line += '      %6.3f' % lookup(t)
        print(line)

    print('')
    print('  best scale k per component (least squares on the one-axis CDF):')
    for name, lookup in marginals():
        for label, values in (('|qx|', ax), ('|qy|', ay)):
            k = fit_scale(values, lookup)
            key = 'qx' if label == '|qx|' else 'qy'
            boot = bootstrap_component(rows, key, lookup, draws, seed)
            interval = ''
            if boot:
                interval = '   [%.3f, %.3f]' % (percentile(boot, 0.025), percentile(boot, 0.975))
            print('    %-14s %s: k = %.3f   criterion %.4f%s' % (
                name, label, k, cvm(sorted(values), lookup, k), interval))


def report_references(rows):
    print('')
    print('=' * 78)
    print('alternative references (scale check)')
    print('=' * 78)
    print('The primary q normalises by the server dispersion angle and measures the offset')
    print('from the server gun vector. The alternatives replace the direction, the angle or both.')
    print('')
    print('  %-32s %5s %8s %8s %8s' % ('reference', 'N', 'median', 'mean', 'share<=1'))
    variants = (
        ('server vector, server angle', 'q'),
        ('server marker direction, server angle', 'q_server_marker'),
        ('server vector, client angle', 'q_client_angle'),
        ('client marker direction, client angle', 'q_client_marker'),
    )
    for title, key in variants:
        values = [r[key] for r in rows if r.get(key) is not None]
        if not values:
            print('  %-32s %5d' % (title[:32], 0))
            continue
        print('  %-37s %5d %8.3f %8.3f %8.3f' % (
            title, len(values), percentile(values, 0.5),
            sum(values) / len(values), empirical_cdf(values, 1.0)))
    ratios = [r['client_angle'] / r['angle'] for r in rows
              if r.get('client_angle') and r.get('angle')]
    if ratios:
        print('')
        print('client pre-shot dispersion angle / server dispersion angle: N = %d,'
              ' median %.3f, q25 %.3f, q75 %.3f' % (
                  len(ratios), percentile(ratios, 0.5), percentile(ratios, 0.25), percentile(ratios, 0.75)))


def report_outliers(rows, limit):
    """The widest shots are kept, never clipped: they show where the method breaks."""
    print('')
    print('=' * 78)
    print('widest shots, kept in every subset (no clipping)')
    print('=' * 78)
    ordered = sorted(rows, key=lambda r: -r['q'])[:limit]
    print('  %6s %8s %8s %7s %6s %8s %8s %8s %9s' % (
        'q', 'qx', 'qy', 'age s', 'still', 'm/s', 'rad/s', 'turret', 'angle rad'))
    for row in ordered:
        print('  %6.3f %8.3f %8.3f %7.3f %6s %8.3f %8.4f %8.4f %9.5f' % (
            row['q'], row['qx'], row['qy'], row['age'], row['still'],
            row['speed'], row['rotation'], row['turret'], row['angle']))
    qs = [r['q'] for r in rows]
    angles = [r['angle'] for r in rows]
    mq, _ = mean_se(qs)
    ma, _ = mean_se(angles)
    cov = sum((a - ma) * (q - mq) for a, q in zip(angles, qs))
    va = sum((a - ma) ** 2 for a in angles)
    vq = sum((q - mq) ** 2 for q in qs)
    if va > 0 and vq > 0:
        print('  correlation of q with the server dispersion angle: %+.3f' % (cov / math.sqrt(va * vq)))
    print('  server dispersion angle rad: min %.5f, median %.5f, max %.5f' % (
        min(angles), percentile(angles, 0.5), max(angles)))


def report_trajectory(rows, limit):
    checked = [r for r in rows if r.get('q_trajectory') is not None]
    print('')
    print('=' * 78)
    print('sanity check: angular method against the ballistic projection to the endpoint')
    print('=' * 78)
    print('N with an endpoint record: %d of %d' % (len(checked), len(rows)))
    if not checked:
        return
    print('  %6s %9s %10s %10s %9s' % ('#', 'range m', 'q angular', 'q traject.', 'ratio'))
    shown = sorted(checked, key=lambda r: -r['range'])[:limit]
    for i, row in enumerate(shown):
        ratio = row['q_trajectory'] / row['q'] if row['q'] > 1e-6 else float('nan')
        print('  %6d %9.1f %10.3f %10.3f %9.3f' % (i + 1, row['range'], row['q'], row['q_trajectory'], ratio))
    ratios = [r['q_trajectory'] / r['q'] for r in checked if r['q'] > 0.02]
    if ratios:
        print('  ratio over all checked shots with q > 0.02: N = %d, median %.3f, q10 %.3f, q90 %.3f' % (
            len(ratios), percentile(ratios, 0.5), percentile(ratios, 0.10), percentile(ratios, 0.90)))
        print('  (the endpoint is where the shell stopped, so obstacles closer than the aim point,')
        print('   the shell own gravity and the server/client origin gap all enter this ratio)')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--folder', default=DEFAULT_FOLDER, help='battle records folder')
    parser.add_argument('--bootstrap', type=int, default=200, help='bootstrap resamples over battles')
    parser.add_argument('--seed', type=int, default=20260919, help='bootstrap seed')
    parser.add_argument('--trajectory', type=int, default=10, help='shots listed in the sanity check')
    args = parser.parse_args()

    rows, counts = collect(args.folder)

    print('shot records scanned from %d battle files' % len(
        [f for f in os.listdir(args.folder) if f.endswith('.jsonl')]))
    print('')
    print('exclusions by reason:')
    for key in ('tracer records', 'not own', 'ricochet', 'secondary gun installation',
                'no aimAtTracer snapshot', 'no lastServerGunUpdate',
                'bad server vector or angle', 'degenerate geometry', 'usable'):
        print('  %-30s %6d' % (key, counts[key]))

    print('')
    print('quality of the usable shots:')
    ages = sorted(r['age'] for r in rows)
    if ages:
        print('  server update age s: min %.3f, median %.3f, p90 %.3f, max %.3f' % (
            ages[0], percentile(ages, 0.5), percentile(ages, 0.9), ages[-1]))
    print('  stale (age > %.1f s): %d' % (MAX_AGE, sum(1 for r in rows if not r['fresh'])))
    print('  vehicle or turret moving: %d' % sum(1 for r in rows if not r['still']))
    kinds = {}
    for row in rows:
        kinds[row['shell'] or 'unknown'] = kinds.get(row['shell'] or 'unknown', 0) + 1
    print('  shell kinds: ' + ', '.join('%s %d' % (k, kinds[k]) for k in sorted(kinds)))
    guns = {}
    for row in rows:
        guns[row['gun']] = guns.get(row['gun'], 0) + 1
    print('  gun index: ' + ', '.join('%s %d' % (g, guns[g]) for g in sorted(guns, key=str)))

    primary = [r for r in rows if r['still'] and r['fresh']]
    report_subset('PRIMARY SUBSET: still vehicle and turret, server update age <= %.1f s' % MAX_AGE,
                  primary, args.bootstrap, args.seed)
    report_subset('SECONDARY SUBSET: every usable own shot', rows, args.bootstrap, args.seed + 1)
    moving = [r for r in rows if not (r['still'] and r['fresh'])]
    report_subset('CONTROL SUBSET: the excluded moving/stale shots only', moving, args.bootstrap, args.seed + 2)

    report_components('COMPONENTS, primary subset', primary, args.bootstrap, args.seed + 3)
    report_components('COMPONENTS, every usable own shot', rows, args.bootstrap, args.seed + 4)

    report_references(rows)
    report_outliers(rows, args.trajectory + 2)
    report_trajectory(rows, args.trajectory)


if __name__ == '__main__':
    main()
