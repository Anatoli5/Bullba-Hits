# -*- coding: utf-8 -*-
"""What exporter.ttx_block writes, pinned (BACKLOG 55, 02.10), on the offline stand of the client's own items.vehicles.

    python tests/py27/run27.py tests/py27/ttx_golden.py            the check
    python tests/py27/run27.py tests/py27/ttx_golden.py --write    store the golden of this client and TTX_FORMAT

A characteristics file is built again after a client change and written only where it differs (build_ttx, same_ttx_file);
its key carries TTX_FORMAT. So a change of ttx_block's output that does not raise TTX_FORMAT is caught only when the client's
own files change too - and then reaches only some files. This test builds a few types on the stand
(tests/fixtures-local/ttx-offline: the client's scripts.pkg on sys.path, a ResMgr shim over its packed XML - local, never
committed) and compares the sha256 of each output, without its volatile fields (Exporter.TTX_VOLATILE), with
tests/golden/ttx-outputs.json - hashes only, no characteristic of the client:

  - the client's inputs of these types as in the golden (the CRCs of their sources and of the client's code): each output the
    same while TTX_FORMAT is the golden's; a raised TTX_FORMAT needs --write;
  - another client (its sources changed): SKIP - the golden is that client's; --write after checking the change is the
    client's;
  - no stand, no client, no python27 stdlib: SKIP.
Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import hashlib, json, os, sys, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
GOLDEN = os.path.join(REPO, 'tests', 'golden', 'ttx-outputs.json')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
# The last one is a tier-XI vehicle (09.10): its file carries its whole skill tree, and its tree's files are among its inputs.
TYPES = ('ussr:R45_IS-7', 'czech:Cz17_Vz_55', 'france:F108_Panhard_EBR_105', 'usa:A144_M_VI_Y', 'sweden:S11_Strv_103B',
         'germany:G197_Pz_Kpfw_Neu')


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text)
    else:
        sys.stdout.write(text)


def main():
    if not os.path.isfile(os.path.join(STAND, 'boot27.py')) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no offline stand (%s) or no client (%s)' % (STAND, GAME)], 77)
    saved = sys.stdout, sys.stderr
    try:
        scope = {'__name__': 'ttx_stand'}
        execfile(os.path.join(STAND, 'boot27.py'), scope)
        scope['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        return finish(['SKIP: the stand did not boot on this client:\n' + traceback.format_exc()], 77)
    sys.stdout, sys.stderr = saved
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import exporter, client_snapshot
    # The inputs of these types in this client: their data sources and the client's code (the keys' own rule).
    members = client_snapshot.package_members(os.path.join(GAME, 'res', 'packages', 'scripts.pkg'))
    crcs = dict((name, '%08x' % crc) for name, (crc, size) in members.items()
                if exporter.TTX_TREE.match(name)
                or exporter.TTX_SOURCE.match(name) and not exporter.TTX_SOURCE_SKIP.search(name) and not name.endswith('.pyc'))
    import tempfile
    keys = exporter.Exporter(tempfile.gettempdir(), tempfile.gettempdir(), 'golden').ttx_source_keys(TYPES, crcs, 'golden')
    code = sorted('%s=%08x' % (name, entry[0]) for name, entry in members.items() if name in exporter.CODE_MODULES)
    client = hashlib.sha256(json.dumps([sorted(keys.items()), code]).encode('utf-8')).hexdigest()[:16]
    outputs = {}
    for type_name in TYPES:
        block = exporter.ttx_block(type_name, 'golden', log=False)
        plain = dict((k, v) for k, v in block.items() if k not in exporter.Exporter.TTX_VOLATILE)
        outputs[type_name] = hashlib.sha256(json.dumps(plain, sort_keys=True).encode('utf-8')).hexdigest()
    if '--write' in sys.argv[1:]:
        with open(GOLDEN, 'w') as stream:
            json.dump({'note': 'hashes only (tests/py27/ttx_golden.py); no characteristic of the client',
                       'format': exporter.TTX_FORMAT, 'client': client, 'types': outputs}, stream, indent=1, sort_keys=True)
            stream.write('\n')
        return finish(['wrote %d types into %s' % (len(outputs), GOLDEN)], 0)
    if not os.path.isfile(GOLDEN):
        return finish(['FAIL no %s: run with --write' % GOLDEN], 1)
    golden = json.load(open(GOLDEN))
    if golden.get('client') != client:
        return finish(['SKIP: the client\'s inputs of these types changed since the golden (%s, now %s): check the change is the '
                       'client\'s, then --write' % (golden.get('client'), client)], 77)
    lines, failed = [], 0
    if golden.get('format') != exporter.TTX_FORMAT:
        same = [t for t in TYPES if outputs[t] == golden['types'].get(t)]
        lines.append('FAIL TTX_FORMAT is %d, the golden of %s: %s' % (exporter.TTX_FORMAT, golden.get('format'),
                     'nothing of the output changed - raise it only for a changed output' if len(same) == len(TYPES)
                     else 'store the new output with --write'))
        failed += 1
    else:
        for type_name in TYPES:
            ok = outputs[type_name] == golden['types'].get(type_name)
            if not ok: failed += 1
            lines.append(('ok   ' if ok else 'FAIL ') + 'ttx_block %s as golden%s' % (type_name, '' if ok else
                         ' - the output changed while TTX_FORMAT stayed %d: if meant, raise it in exporter.py and run --write'
                         % exporter.TTX_FORMAT))
    lines.append('%d types, %d failed' % (len(TYPES), failed))
    return finish(lines, 1 if failed else 0)


try:
    main()
except Exception:
    finish(['FAIL exception\n' + traceback.format_exc()], 1)
