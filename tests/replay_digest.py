"""What the replay decoder makes of the local replay fixtures, as a table both Pythons can compare.

    python tests/replay_digest.py --write    (CPython 3) recompute tests/fixtures-local/replays/digests.json
    python tests/replay_digest.py            (CPython 3) print the summaries without writing

Per fixture (`tests/fixtures-local/replays/*.wotreplay`): the event count, the count per event kind, the counts
that say what was left unread (raw packets, undecoded packets, unread component messages, failed 0x32 frames, other
object-table failures, a partial last packet dropped), and an md5 over the battle-log events (hits, HP changes, own
hit direction, battle events, tracers, explosions, damaged-device lists) written in a form that does not depend on
the Python (every string and byte string as hex, floats by repr, sets sorted).

The table is checked by tests/test_replay_components.py (CPython 3) and tests/py27/replay_stream.py (the client's
Python 2.7): the same decoder code must give the same table under both. Rewrite it only after a decoder change whose
new output was checked; the fixtures and the table are local (replays carry nicknames), not in git.
Runs under Python 2.7 and 3; no game module is imported.
"""
from __future__ import print_function
import collections
import glob
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FIXTURES = os.path.join(REPO, 'tests', 'fixtures-local', 'replays')
TABLE = os.path.join(FIXTURES, 'digests.json')
LOG = ('showDamageFromShot', 'onHealthChanged', 'showOwnVehicleHitDirection', 'onBattleEvents', 'showTracer',
       'explodeProjectile', 'vehicleDamageInfoList')

try:
    _TEXT = unicode  # noqa: F821  (Python 2)
except NameError:
    _TEXT = str
try:
    _INT = (int, long)  # noqa: F821  (Python 2)
except NameError:
    _INT = (int,)
_BYTES = (bytes, bytearray)


def fixtures():
    return sorted(glob.glob(os.path.join(FIXTURES, '*.wotreplay')))


def _hex(raw):
    return '0x' + bytes(bytearray(raw)).hex() if sys.version_info[0] >= 3 else '0x' + str(bytearray(raw)).encode('hex')


def norm(v):
    """One line of text for a decoded value, equal under Python 2.7 and 3."""
    if isinstance(v, _TEXT):
        return _hex(v.encode('utf-8'))
    if isinstance(v, _BYTES):
        return _hex(v)
    if isinstance(v, bool) or v is None:
        return '%s' % (v,)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, _INT):
        return '%d' % v
    if isinstance(v, dict):
        return '{' + ','.join(sorted('%s:%s' % (norm(k), norm(x)) for k, x in v.items())) + '}'
    if isinstance(v, (list, tuple)):
        return '[' + ','.join(norm(x) for x in v) + ']'
    if isinstance(v, (set, frozenset)):
        return '<' + ','.join(sorted(norm(x) for x in v)) + '>'
    # stubs of safe_unpickle: class name, constructor args, state
    return '%s(%s;%s)' % (type(v).__name__, norm(getattr(v, 'args', None)), norm(getattr(v, 'state', None)))


def read(rd, path):
    """(blocks, stream) through the decoder's own reader; an older decoder without read_any reads a raw stream here."""
    if hasattr(rd, 'read_any'):
        return rd.read_any(path)
    with open(path, 'rb') as f:
        head = f.read(4)
    if struct.unpack('<I', head)[0] == rd.REPLAY_MAGIC:
        return rd.read_replay(path)
    with open(path, 'rb') as f:
        return [], bytearray(f.read())


def summarise(rd, defs, path):
    blocks, stream = read(rd, path)
    dec = rd.Decoder(defs)
    kinds = collections.Counter()
    md5 = hashlib.md5()
    rows = events = 0
    for ev in dec.decode(stream):
        events += 1
        kinds[ev['ev']] += 1
        if ev.get('name') in LOG:
            a = ev.get('args') if 'args' in ev else ev.get('value')
            row = '%s|%s|%s|%s' % (repr(ev['t']), norm(ev.get('id', ev.get('owner'))), ev['name'], norm(a))
            md5.update(row.encode('utf-8') + b'\n')
            rows += 1
    frames = sum(n for k, n in dec.objects.failures.items() if k[0] == 'frame')
    return collections.OrderedDict([
        ('events', events), ('logRows', rows), ('logMd5', md5.hexdigest()),
        ('rawPackets', kinds['packet']), ('undecodedPackets', kinds['undecoded']),
        ('unreadMessages', kinds['component_undecoded']), ('failedFrames', frames),
        ('objectFailures', sum(dec.objects.failures.values()) - frames),
        ('decoderFailures', sum(dec.failures.values())),
        ('partialTailBytes', getattr(dec, 'partial_bytes', None)),
        ('kinds', collections.OrderedDict(sorted(kinds.items()))),
    ])


def summarise_all(rd, defs=None, paths=None):
    defs = defs or rd.Defs(rd.Client())
    out = collections.OrderedDict()
    for path in (paths or fixtures()):
        out[os.path.basename(path)] = summarise(rd, defs, path)
    return out


def load_table():
    if not os.path.isfile(TABLE):
        return None
    with open(TABLE, 'rb') as f:
        return json.loads(f.read().decode('utf-8'))


def differences(table, got):
    """Lines naming every fixture and field where got differs from the table (fixtures absent from got are skipped)."""
    out = []
    for name in sorted(got):
        want = table.get(name)
        if want is None:
            out.append('%s: not in the table' % name)
            continue
        for key, value in got[name].items():
            if want.get(key) != value:
                out.append('%s %s: table %s, now %s' % (name, key, want.get(key), value))
    return out


def main(argv):
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import replay_stream as rd
    got = summarise_all(rd)
    text = json.dumps(got, indent=1)
    if '--write' in argv:
        with open(TABLE, 'w') as f:
            f.write(text + '\n')
        print('written %s (%d fixtures)' % (TABLE, len(got)))
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
