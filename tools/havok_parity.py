# -*- coding: utf-8 -*-
"""Parity and pace of the collision reader on EVERY collision model of the client, under its own python27.dll.

    python tools/havok_parity.py [--ref REV] [--limit N] [--out FILE.tsv]

Compares the mod's collision reader (mod/local_armor_inspector/havok.py + geometry.py of the working tree) with the same
two files at git revision REV (default 2b8cb4b: the last reader that built the whole object graph of a file). Every
collision_client/*.havok of every package in res/packages is read once (the game folder is only read); both readers
extract it, and the model file each would write (the exporter's own write_data: the model with 'resource' and 'sha256')
must be the same bytes. Prints the per-model times of both (median, p90, p99, max, total) and every difference or error.

    --out    a TSV per model: resource, raw bytes, ref ms, new ms, write ms (json + sha256 of the new), sha256 of the
             model file. Holds hashes and names only, never geometry; keep it local all the same (outputs/ or scratch).
    --limit  only the first N models (by package and name), for a quick look.

Environment: BULLBA_GAME (default C:/Games/World_of_Tanks_NA), plus run27.py's own (BULLBA_PY27_DLL/HOME). A full run
is about half an hour (the old reader); not part of tools/check.py - its guard there is tests/py27/havok_lazy.py.
Exit code: 0 all identical, 1 a difference or an error in only one reader, 77 no client (SKIP).
"""
import os
import sys

GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
DEFAULT_REF = '2b8cb4b'


def outer():
    import subprocess
    import tempfile
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    args = sys.argv[1:]
    ref = DEFAULT_REF
    if '--ref' in args:
        i = args.index('--ref'); ref = args[i + 1]; del args[i:i + 2]
    if not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        print('SKIP: no client packages at %s (set BULLBA_GAME)' % GAME)
        return 77
    folder = tempfile.mkdtemp(prefix='bullba-havok-ref-')
    for name in ('havok.py', 'geometry.py'):
        blob = subprocess.check_output(['git', 'show', '%s:mod/local_armor_inspector/%s' % (ref, name)], cwd=repo)
        with open(os.path.join(folder, name), 'wb') as stream: stream.write(blob)
    env = dict(os.environ, BULLBA_PY27_TIMEOUT=os.environ.get('BULLBA_PY27_TIMEOUT', '7200'),
               BULLBA_HAVOK_REF=folder.replace('\\', '/'), BULLBA_HAVOK_REV=ref)
    return subprocess.call([sys.executable, os.path.join(repo, 'tests', 'py27', 'run27.py'),
                            os.path.abspath(__file__).replace('\\', '/')] + args, env=env)


def load(alias, folder):
    """The reader in `folder` as package `alias` (geometry's relative import finds its havok beside it)."""
    import imp
    package = imp.new_module(alias)
    package.__path__ = [folder]
    sys.modules[alias] = package
    return imp.load_source(alias + '.geometry', os.path.join(folder, 'geometry.py'))


def model_file(model, data, name):
    """The model file's bytes exactly as model_extract writes them (the exporter's own write_data), and their sha256."""
    import hashlib
    from local_armor_inspector import exporter
    written = []
    saved, exporter.atomic_write = exporter.atomic_write, lambda path, blob: written.append(blob)
    try:
        model.update({'resource': name, 'sha256': hashlib.sha256(data).hexdigest()})
        exporter.write_data('unused', 'model:parity', model)
    finally:
        exporter.atomic_write = saved
    return written[0], hashlib.sha256(written[0]).hexdigest()


def stats(values):
    v = sorted(values)
    if not v: return 'none'
    at = lambda q: v[min(len(v) - 1, int(q * len(v)))]
    return 'median %.1f  p90 %.1f  p99 %.1f  max %.1f  total %.1f s' % (at(0.5), at(0.9), at(0.99), v[-1], sum(v) / 1000.0)


def inner():
    import gc
    import glob
    import time
    import zipfile
    clock = time.clock if sys.version_info[0] == 2 else time.perf_counter
    repo = os.environ['BULLBA_REPO']
    args = sys.argv[1:]
    limit = int(args[args.index('--limit') + 1]) if '--limit' in args else None
    out = args[args.index('--out') + 1] if '--out' in args else None
    sys.path.insert(0, os.path.join(repo, 'mod'))
    ref = load('bullba_ref', os.environ['BULLBA_HAVOK_REF'])
    new = load('bullba_new', os.path.join(repo, 'mod', 'local_armor_inspector').replace('\\', '/'))
    seen, jobs = set(), []
    for pkg in sorted(glob.glob(os.path.join(GAME, 'res', 'packages', '*.pkg'))):
        with zipfile.ZipFile(pkg) as z:
            for info in z.infolist():
                n = info.filename
                if '/collision_client/' in n and n.endswith('.havok') and n not in seen:
                    seen.add(n); jobs.append((pkg, n))
    if limit: jobs = jobs[:limit]
    rows, lines = [], []
    ref_ms, new_ms, write_ms = [], [], []
    same = differ = both_fail = one_fail = 0
    handle = None
    for pkg, name in jobs:
        if handle is None or handle[0] != pkg:
            if handle: handle[1].close()
            handle = (pkg, zipfile.ZipFile(pkg))
        data = handle[1].read(name)
        results = []
        for reader in (ref, new):
            gc.collect()
            t0 = clock()
            try: model, error = reader.extract(data), None
            except Exception as exc: model, error = None, '%s: %s' % (type(exc).__name__, exc)
            results.append((model, error, (clock() - t0) * 1000.0))
        (a, ea, ta), (b, eb, tb) = results
        ref_ms.append(ta); new_ms.append(tb)
        digest, tw = '', 0.0
        if ea or eb:
            if ea and eb and ea == eb: both_fail += 1
            else:
                one_fail += 1; lines.append('FAIL error differs %s: ref %s / new %s' % (name, ea, eb))
        else:
            blob_a, _ = model_file(a, data, name)
            t0 = clock()
            blob_b, digest = model_file(b, data, name)
            tw = (clock() - t0) * 1000.0
            write_ms.append(tw)
            if blob_a == blob_b: same += 1
            else: differ += 1; lines.append('FAIL output differs %s' % name)
        rows.append('%s\t%d\t%.2f\t%.2f\t%.2f\t%s' % (name, len(data), ta, tb, tw, digest or ('error: ' + str(eb))))
    if handle: handle[1].close()
    if out:
        with open(out, 'w') as stream:
            stream.write('resource\tbytes\tref_ms\tnew_ms\twrite_ms\tmodel_sha256\n' + '\n'.join(rows) + '\n')
    lines += ['models %d: identical %d, different %d, same error %d, error in one reader %d (ref %s)'
              % (len(jobs), same, differ, both_fail, one_fail, os.environ.get('BULLBA_HAVOK_REV')),
              'ref ms  ' + stats(ref_ms), 'new ms  ' + stats(new_ms), 'write ms (json + sha256, new) ' + stats(write_ms)]
    ok = not differ and not one_fail and jobs
    text = '\n'.join(lines)
    result = os.environ.get('BULLBA_PY27_RESULT')
    if result:
        with open(result, 'w') as stream: stream.write('exit %d\n%s' % (0 if ok else 1, text))
    else: print(text)


if __name__ == '__main__':
    if os.environ.get('BULLBA_HAVOK_REF') and sys.version_info[0] == 2: inner()
    else: sys.exit(outer())
