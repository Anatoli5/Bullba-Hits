# -*- coding: utf-8 -*-
"""Compile the mod's sources to .pyc with the client's own python27.dll (inner script for tests/py27/run27.py).

    python tests/py27/run27.py tools/compile27.py SOURCE_ROOT TARGET_ROOT RELATIVE.py [RELATIVE.py ...]

Each SOURCE_ROOT/RELATIVE.py becomes TARGET_ROOT/RELATIVE.pyc; RELATIVE.py is the name written into the code object
(shown in tracebacks in python.log). The header is the client interpreter's magic plus a zero timestamp, so the same
source gives the same bytes. Taken from Bullba Countdown (tools/compile27.py) on 30.10.2026, when Smart App Control
began to refuse the unsigned OpenWG compiler tools/build.py used before.
"""
import imp
import marshal
import os
import struct
import sys

RESULT = os.environ.get('BULLBA_PY27_RESULT')


def main():
    source_root, target_root = sys.argv[1:3]
    done = []
    for relative in sys.argv[3:]:
        with open(os.path.join(source_root, relative), 'rU') as stream:
            text = stream.read()
        code = compile(text, relative, 'exec')
        data = imp.get_magic() + struct.pack('<I', 0) + marshal.dumps(code)
        target = os.path.join(target_root, relative[:-3] + '.pyc')
        if not os.path.isdir(os.path.dirname(target)):
            os.makedirs(os.path.dirname(target))
        with open(target, 'wb') as stream:
            stream.write(data)
        done.append(relative)
    return 'compiled %d files (magic %s)' % (len(done), imp.get_magic().encode('hex'))


try:
    message, code = main(), 0
except Exception:
    import traceback
    message, code = traceback.format_exc(), 1
if RESULT:
    with open(RESULT, 'w') as stream:
        stream.write('exit %d\n%s\n' % (code, message))
else:
    print message
