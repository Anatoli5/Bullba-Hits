# -*- coding: utf-8 -*-
"""The vehicles' collision parts read from the client's vehicle XML (mod/local_armor_inspector/vehicle_xml.py) against what Bullba
Hits built from the client's runtime descriptor, under the client's own Python 2.7 (runs under CPython 3 as well).

    python tests/py27/run27.py tests/py27/vehicle_xml.py

Carried over 19.11.2026 from the stopped side project C:/Projects/Bullba-Replays (tests/py27/vehicles.py, fa382c3).

For every vehicle file of the Hits fixture (BULLBA_VEHICLES_FIXTURE, default
C:/Projects/Bullba-Hits/tests/fixtures-local/playback-2026-11-18/data/vehicles: 26 vehicles of one battle, each with its
compactDescriptor, its parts and gunPitchLimits.samples [yaw, min, max]): parts(vehicle_doc(type), compactDescriptor) has
the same part ids, names and resources, transforms equal within 1e-5, the same wheels (body and place), and gunPitch equal
to (min of samples' min, max of samples' max) within 1e-4. Each part has a modelKey; copy_havok of the first vehicle
returns the bytes of its .havok files with the size and CRC-32 of the key.

The number: how many of the vehicles match fully; each that does not is listed with its differences. A gun pitch that
differs on a vehicle whose record names post-progression modifications (skillTree.modifications: some of them move the
gun's pitch knots, which neither the type's XML nor the compact descriptor holds) is listed as explained and does not fail
the check; any other difference fails it. Also the time
vehicle_doc takes per vehicle (cold: no parsed XML kept; warm: the nation's components kept).

The package index is built once into BULLBA_INDEX_DIR (default <temp>/bullba-replays-vehicles-index), never into the game
folder; the game folder is only read. No fixture or no client packages: SKIP (77). Verdict through BULLBA_PY27_RESULT.
"""
import glob
import io
import json
import os
import sys
import tempfile
import time
import traceback
import zlib

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
FIXTURE = os.environ.get('BULLBA_VEHICLES_FIXTURE',
                         os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18', 'data', 'vehicles'))
INDEX = os.environ.get('BULLBA_INDEX_DIR', os.path.join(tempfile.gettempdir(), 'bullba-replays-vehicles-index'))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import map_raw
from local_armor_inspector import vehicle_xml as vehicles

TOL = 1e-5
PITCH_TOL = 1e-4


def load(path):
    with io.open(path, encoding='utf-8') as f:
        t = f.read()
    key, data = json.loads(t[t.index('(') + 1:t.rindex(')')])
    return data


def close(a, b, tol):
    return a is not None and b is not None and len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


def compare(want, got):
    """The differences of one vehicle, [] when it matches."""
    diffs = []
    w = dict((p['id'], p) for p in want['parts'])
    g = dict((p['id'], p) for p in got['parts'])
    if sorted(w) != sorted(g):
        diffs.append('part ids %s, expected %s' % (sorted(g), sorted(w)))
    for pid in sorted(set(w) & set(g)):
        a, b = w[pid], g[pid]
        if b.get('error'):
            diffs.append('part %d: %s' % (pid, b['error']))
        if a.get('name') != b.get('name'):
            diffs.append('part %d name %r, expected %r' % (pid, b.get('name'), a.get('name')))
        if pid >= 0:
            if a.get('resource') != b.get('resource'):
                diffs.append('part %d resource %r, expected %r' % (pid, b.get('resource'), a.get('resource')))
            if not b.get('modelKey'):
                diffs.append('part %d: no modelKey' % pid)
        else:
            aw, bw = a.get('wheel') or {}, b.get('wheel') or {}
            if not (aw.get('sides') == bw.get('sides') and close([aw.get('radius'), aw.get('width')],
                                                                 [bw.get('radius'), bw.get('width')], TOL)):
                diffs.append('wheel %d body %s, expected %s' % (pid, bw, aw))
        if not close(a.get('transform'), b.get('transform'), TOL):
            diffs.append('part %d transform %s, expected %s' % (pid, b.get('transform'), a.get('transform')))
    samples = (want.get('gunPitchLimits') or {}).get('samples') or []
    expected = [min(s[1] for s in samples), max(s[2] for s in samples)] if samples else None
    explained = []
    if not close(expected, got.get('gunPitch'), PITCH_TOL):
        what = 'gunPitch %s, expected %s' % (got.get('gunPitch'), expected)
        # The descriptor Hits recorded holds the player's post-progression modifications (its skillTree); some move the
        # gun's pitch knots (modifications.xml descrAttrs/gunPitchLimits/...), which neither the type's XML nor the
        # compact descriptor carries: such a difference is listed, not failed.
        if (want.get('skillTree') or {}).get('modifications'):
            explained.append(what + ' (the record has post-progression modifications %s)' % want['skillTree'])
        else:
            diffs.append(what)
    return diffs, explained


def check():
    started = time.time()
    pk = map_raw.Packages(GAME, INDEX)
    index_s = time.time() - started
    files = sorted(glob.glob(os.path.join(FIXTURE, '*.js')))
    lines, matched, failed, cold, warm, first = [], 0, 0, [], [], None
    try:
        for path in files:
            data = load(path)
            name = os.path.basename(path)[:-3]
            try:
                vehicles._xml_cache.clear()
                t0 = time.time()
                doc = vehicles.vehicle_doc(pk, data['type'], 'fixture')
                cold.append(time.time() - t0)
                t0 = time.time()
                doc = vehicles.vehicle_doc(pk, data['type'], 'fixture')
                warm.append(time.time() - t0)
                got = vehicles.parts(doc, data['compactDescriptor'])
                diffs, explained = compare(data, got)
            except Exception:
                diffs, explained = ['crashed: ' + traceback.format_exc().strip().splitlines()[-1]], []
                doc = got = None
            if diffs:
                failed += 1
                lines.append('DIFF %s: %s' % (name, '; '.join(diffs + explained)))
            elif explained:
                lines.append('DIFF (explained) %s: %s' % (name, '; '.join(explained)))
            else:
                matched += 1
                if first is None:
                    first = (name, doc, got)
        havok_ok = None
        if first is not None:
            name, doc, got = first
            want = dict((p['modelKey'], p['resource']) for p in got['parts'] if p.get('modelKey'))
            copied = vehicles.copy_havok(pk, doc, list(want.values()))
            havok_ok = sorted(copied) == sorted(want) and all(
                len(b) == size and (zlib.crc32(b) & 0xffffffff) == crc and key.endswith('-%08x-%d' % (crc, size))
                for key, (b, p, crc, size) in copied.items())
            if not havok_ok:
                lines.append('DIFF %s: copy_havok returned %s for %s' % (name, sorted(copied), sorted(want)))
    finally:
        pk.close()
    ms = lambda v: '%.1f ms mean, %.1f ms max' % (1000.0 * sum(v) / max(1, len(v)), 1000.0 * max(v or [0]))
    head = ('vehicles: %d of %d match fully, %d differ unexplained; copy_havok %s; vehicle_doc cold %s, warm %s; index %.2f s; python %d.%d'
            % (matched, len(files), failed, {None: 'not run', True: 'ok', False: 'FAILED'}[havok_ok], ms(cold), ms(warm),
               index_s, sys.version_info[0], sys.version_info[1]))
    return [head] + lines, 0 if (files and not failed and havok_ok) else 1


def main():
    if not os.path.isdir(FIXTURE) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no fixture %s or no client packages at %s' % (FIXTURE, GAME)], 77)
    try:
        lines, code = check()
    except Exception:
        return finish(['FAIL [run] the script crashed:\n' + traceback.format_exc()], 1)
    return finish(lines, code)


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream:
            stream.write(text.encode('utf-8') if not isinstance(text, bytes) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    sys.exit(main()) if not RESULT else main()
