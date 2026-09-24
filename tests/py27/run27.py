"""Run an inner script under the game client's own Python 2.7 (python27.dll), with any Python 3.

    python tests/py27/run27.py INNER.py [ARG...]

The dll is loaded with ctypes in a child process of this launcher, so a hung inner script (a thread that
never ends) is killed by the watchdog here instead of hanging the caller.

    BULLBA_PY27_DLL      python27.dll of the client   (default C:/Games/World_of_Tanks_NA/win64/python27.dll)
    BULLBA_PY27_HOME     folder with stdlib.zip       (default <repo>/work/game-python27)
    BULLBA_PY27_TIMEOUT  watchdog seconds             (default 60)

Exit code: the inner script's verdict (0 pass, 1 fail); 77 when the dll or the stdlib is missing (SKIP).

The inner script reports through the file named by the environment variable BULLBA_PY27_RESULT: first
line 'exit <code>', then the text to print. The dll's own stdout is not used for the verdict: its C runtime
buffers are never flushed, because the child leaves with os._exit and never calls Py_Finalize (the inner
script may leave daemon threads, and finalising the interpreter under them can crash).
"""
import ctypes
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DLL = os.environ.get('BULLBA_PY27_DLL', 'C:/Games/World_of_Tanks_NA/win64/python27.dll')
HOME = Path(os.environ.get('BULLBA_PY27_HOME', str(REPO / 'work' / 'game-python27')))
SKIP = 77


def child(inner, args):
    """In the child process: start the dll, execfile the inner script, leave without finalising."""
    stdlib = str(HOME / 'stdlib.zip').replace('\\', '/')
    os.environ.update(PYTHONHOME=str(HOME), PYTHONPATH=stdlib, PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1')
    runtime = ctypes.PyDLL(DLL)
    runtime.Py_Initialize()
    runtime.PyRun_SimpleString.argtypes = [ctypes.c_char_p]
    code = ('import sys\nsys.path[:] = [%r]\nsys.dont_write_bytecode = True\nsys.argv = %r\n'
            'execfile(%r, {"__name__": "__main__", "__file__": %r})\n' % (stdlib, [inner] + args, inner, inner))
    status = runtime.PyRun_SimpleString(code.encode('utf-8'))
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if status == 0 else 3)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == '--child':
        child(sys.argv[2], sys.argv[3:])
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[2].strip())
        return 2
    if not os.path.isfile(DLL):
        print('SKIP: client python27.dll not found at %s (set BULLBA_PY27_DLL)' % DLL)
        return SKIP
    if not (HOME / 'stdlib.zip').is_file():
        print('SKIP: stdlib.zip not found in %s (set BULLBA_PY27_HOME)' % HOME)
        return SKIP
    inner = os.path.abspath(sys.argv[1]).replace('\\', '/')
    handle, result = tempfile.mkstemp(prefix='bullba-py27-', suffix='.txt')
    os.close(handle)
    env = dict(os.environ, BULLBA_PY27_RESULT=result, BULLBA_REPO=str(REPO).replace('\\', '/'))
    timeout = float(os.environ.get('BULLBA_PY27_TIMEOUT', '60'))
    try:
        try:
            proc = subprocess.run([sys.executable, os.path.abspath(__file__), '--child', inner] + sys.argv[2:],
                                  env=env, cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=timeout)
            out, err, code = proc.stdout, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired as expired:
            out, err, code = expired.stdout or b'', expired.stderr or b'', None
        with open(result, 'rb') as stream:
            text = stream.read().decode('utf-8', 'replace')
    finally:
        try: os.remove(result)
        except OSError: pass
    first, _, rest = text.partition('\n')
    if code is None:
        if rest: print(rest.rstrip())
        print('FAIL: watchdog - %s did not finish within %.0f s' % (os.path.basename(inner), timeout))
        return 1
    if not first.startswith('exit '):
        # No verdict: the inner script died on an uncaught exception, or the dll failed to start.
        print('FAIL: %s gave no verdict (child exit %s)' % (os.path.basename(inner), code))
        for stream in (out, err):
            if stream: print(stream.decode('utf-8', 'replace').rstrip())
        return 1
    if rest: print(rest.rstrip())
    return int(first.split()[1])


if __name__ == '__main__':
    sys.exit(main())
