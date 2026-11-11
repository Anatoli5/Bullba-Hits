# -*- coding: utf-8 -*-
"""The replay decoder of the mod package (replay_stream.py, replay_objects.py) under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/replay_stream.py

Decodes every local replay fixture (tests/fixtures-local/replays/*.wotreplay: final replays and one raw in-battle
temp stream) with the installed client's definitions and compares what comes out - event counts per kind, what was
left unread, an md5 over the battle-log events - with the table tests/fixtures-local/replays/digests.json, which
`python tests/replay_digest.py --write` writes from CPython 3 and tests/test_replay_components.py checks there.
Same table under both Pythons = one decoder code for the mod and the dev tool. The fixtures and the table are local
(replays carry nicknames), not in git: absent -> SKIP (exit 77). Also prints the time of each step.
"""
import os
import sys
import time
import traceback

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.path.insert(0, os.path.join(REPO, 'tests'))
RESULT = os.environ.get('BULLBA_PY27_RESULT')


def finish(code, lines):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream:
            stream.write(text.encode('utf-8') if not isinstance(text, bytes) else text)
    else:
        sys.stdout.write(text)


def main():
    import replay_digest
    from local_armor_inspector import replay_stream as rd
    table, paths = replay_digest.load_table(), replay_digest.fixtures()
    if table is None or not paths:
        return 77, ['SKIP: local replay fixtures or %s absent' % replay_digest.TABLE]
    if not os.path.isdir(os.path.join(rd.DEFAULT_CLIENT, 'res', 'packages')):
        return 77, ['SKIP: client definitions absent at %s' % rd.DEFAULT_CLIENT]
    lines = ['python %s' % sys.version.split()[0]]
    t0 = time.clock()
    defs = rd.Defs(rd.Client())
    lines.append('definitions (Client + Defs) %.2f s' % (time.clock() - t0))
    got = {}
    for path in paths:
        t0 = time.clock()
        got[os.path.basename(path)] = replay_digest.summarise(rd, defs, path)
        lines.append('%s: read + decode + digest %.2f s' % (os.path.basename(path), time.clock() - t0))
    bad = replay_digest.differences(table, got)
    lines.extend('DIFF ' + line for line in bad)
    lines.append('%d fixtures, %d differences from the CPython 3 table' % (len(got), len(bad)))
    return (1 if bad else 0), lines


try:
    code, lines = main()
except Exception:
    code, lines = 1, ['FAIL: ' + traceback.format_exc()]
finish(code, lines)
