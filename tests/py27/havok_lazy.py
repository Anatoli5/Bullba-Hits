# -*- coding: utf-8 -*-
"""The collision reader against golden hashes (28.09, havok-lazy), under the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/havok_lazy.py                      the check (tools/check.py runs it)
    python tests/py27/run27.py tests/py27/havok_lazy.py --write RES,RES,...  make tests/golden/havok-models.json again

A few collision models read from the client's packages (read-only), extracted by the mod's geometry.extract and written by
the exporter's own write_data into memory. The golden file holds only names and hashes, never geometry: the package, the
sha256 of the raw .havok and of the model file, and how many values the lazy reader decoded (TagFile.object calls). The
hashes were made with the whole-graph reader of 2b8cb4b and are the same with the lazy one on every collision model of
the client (tools/havok_parity.py). Checks:

  output   each model file byte for byte (sha256) as golden - while exporter.MODEL_FILE_FORMAT is the golden's (BACKLOG 55:
           a change of the output without raising it fails here; a raise without a change too)
  lazy     the reader decodes at most twice the golden number of values - the whole-graph reader decoded many times
           more, so a change that reads the whole file again fails here
  struct   a struct: the same object on a second access, `in`, get(), and neither iterable nor serialisable (a half-read
           struct must never reach a file)

A model whose package is absent or whose raw bytes differ (another client) is skipped; all skipped: SKIP (exit 77).
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import hashlib
import json
import os
import sys
import time
import traceback
import zipfile

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
GOLDEN = os.path.join(REPO, 'tests', 'golden', 'havok-models.json')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import exporter, geometry, havok


def model_file(data, name):
    """sha256 of the model file as model_extract writes it (exporter.model_document, then write_data), and the values decoded.
    model_document is the one writer of a model file: a raised MODEL_FILE_FORMAT changes its bytes (its 'format'), so the
    users' files of the earlier format are exported again (review 02.10 #4)."""
    calls = [0]
    original = havok.TagFile.object
    def counted(self, t, offset):
        calls[0] += 1
        return original(self, t, offset)
    written = []
    saved, exporter.atomic_write = exporter.atomic_write, lambda path, blob: written.append(blob)
    havok.TagFile.object = counted
    try:
        model = exporter.model_document(data, name)
    finally:
        havok.TagFile.object = original
    try:
        exporter.write_data('unused', 'model:golden', model)
    finally:
        exporter.atomic_write = saved
    return hashlib.sha256(written[0]).hexdigest(), calls[0]


def packages():
    return os.path.join(GAME, 'res', 'packages')


def write(names):
    wanted, rows = set(names), []
    for pkg in sorted(os.listdir(packages())):
        if not pkg.endswith('.pkg'): continue
        with zipfile.ZipFile(os.path.join(packages(), pkg)) as z:
            for name in sorted(wanted & set(z.namelist())):
                data = z.read(name)
                digest, calls = model_file(data, name)
                rows.append({'resource': name, 'package': pkg, 'raw': hashlib.sha256(data).hexdigest(),
                             'model': digest, 'decoded': calls})
                wanted.discard(name)
    if wanted: raise ValueError('not in the client: ' + ', '.join(sorted(wanted)))
    rows.sort(key=lambda r: r['resource'])
    with open(GOLDEN, 'w') as stream:
        json.dump({'note': 'hashes only (tests/py27/havok_lazy.py); no geometry', 'models': rows,
                   'format': exporter.MODEL_FILE_FORMAT}, stream, indent=1, sort_keys=True)
        stream.write('\n')
    return ['wrote %d models into %s' % (len(rows), GOLDEN)], 0


def check():
    stored = json.load(open(GOLDEN))
    golden = stored['models']
    # The model file's format (BACKLOG 55): it names every model file (exporter.model_content_key), so an output that changes
    # while it stays leaves the users' files as they were for good; a golden without the field is of format 1.
    golden_format = stored.get('format', 1)
    checks, skipped = [], []
    def ok(value, name, detail=''): checks.append((name, bool(value), detail))
    handles, first = {}, None
    try:
        for row in golden:
            path = os.path.join(packages(), row['package'])
            if not os.path.isfile(path):
                skipped.append(row['resource']); continue
            if path not in handles: handles[path] = zipfile.ZipFile(path)
            try: data = handles[path].read(row['resource'])
            except KeyError:
                skipped.append(row['resource']); continue
            if hashlib.sha256(data).hexdigest() != row['raw']:
                skipped.append(row['resource']); continue
            digest, calls = model_file(data, row['resource'])
            if golden_format == exporter.MODEL_FILE_FORMAT:
                ok(digest == row['model'], 'output %s' % row['resource'], '%s - the model file changed while MODEL_FILE_FORMAT '
                   'stayed %d: if meant, raise it in exporter.py and run with --write' % (digest, golden_format))
            else:
                ok(digest != row['model'], 'output %s' % row['resource'], 'MODEL_FILE_FORMAT raised to %d but this model is '
                   'written as in format %d - raise it only for a changed output' % (exporter.MODEL_FILE_FORMAT, golden_format))
            ok(calls <= 2 * row['decoded'], 'lazy %s' % row['resource'], '%d values decoded, golden %d' % (calls, row['decoded']))
            if first is None: first = data
    finally:
        for handle in handles.values(): handle.close()
    if first is not None:
        root = havok.TagFile(first).root
        ok(root['namedVariants'] is root['namedVariants'], 'struct: a member is decoded once and kept')
        ok('namedVariants' in root and '__type' in root and 'no such member' not in root, 'struct: in')
        ok(root.get('no such member') is None and root.get('namedVariants') is root['namedVariants'], 'struct: get')
        for name, action in (('iterated', lambda: list(root)), ('serialised', lambda: json.dumps(root))):
            try: action(); ok(False, 'struct: cannot be ' + name)
            except TypeError: ok(True, 'struct: cannot be ' + name)
    return checks, skipped


def main():
    started = time.time()
    if not os.path.isdir(packages()):
        return finish(['SKIP: no client packages at %s (set BULLBA_GAME)' % GAME], 77)
    args = sys.argv[1:]
    if '--write' in args:
        return finish(*write(args[args.index('--write') + 1].split(',')))
    try:
        checks, skipped = check()
    except Exception:
        return finish(['FAIL [run] the script crashed:\n' + traceback.format_exc()], 1)
    if not checks:
        return finish(['SKIP: none of the %d golden models is in this client (another version?)' % len(skipped)], 77)
    failed = [c for c in checks if not c[1]]
    golden_format = json.load(open(GOLDEN)).get('format', 1)
    if golden_format != exporter.MODEL_FILE_FORMAT and not failed:
        failed = [('format', False, 'MODEL_FILE_FORMAT is %d, the golden of %d: store the new one with --write'
                   % (exporter.MODEL_FILE_FORMAT, golden_format))]
        checks.append(failed[0])
    lines = ['havok_lazy: %d checks, %d failed, %d models of another client skipped (%.1f s)'
             % (len(checks), len(failed), len(skipped), time.time() - started)]
    lines += ['FAIL %s -- %s' % (name, detail) for name, _, detail in failed]
    return finish(lines, 1 if failed else 0)


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
