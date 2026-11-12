# -*- coding: utf-8 -*-
"""The own aim circles rebuilt from the replay (replay_aim.py, BACKLOG 82) and the replay source's copy failure under the
client's own Python 2.7: the export thread builds the block in the game, the replay thread copies the stream.

Run:  python tests/py27/run27.py tests/py27/replay_aim.py

The synthetic stream of tests/replay_aim_synthetic.py (the same as tests/test_replay_aim.py, CPython 3): the decoder's
0x1a names, the block of a tracer (press, reticles, disc), the converter putting it on the own main-gun tracers, the
comparison with an equal snapshot; a copy whose write fails is handed over with 'copyFailure' and distrusted.
"""
import os
import shutil
import struct
import sys
import tempfile

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.path.insert(0, os.path.join(REPO, 'tests'))
checks = []


def check(name, ok, detail=''):
    checks.append((name, bool(ok), detail))


def close(a, b, tol=1e-4):
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


def main():
    import replay_aim_synthetic as S
    from local_armor_inspector import replay_aim as ra
    from local_armor_inspector import replay_objects as rc
    from local_armor_inspector import replay_records as rrec
    from local_armor_inspector import replay_battle as rb
    from local_armor_inspector import replay_run as rr
    from local_armor_inspector import replay_source as rs

    ev = rc.small_packet(0x1a, 1.0, bytearray(struct.pack('<15f', *range(15))))
    check('0x1a names by position', (ev['point'], ev['markerDiameter'], ev['markerPosition'], ev['markerDirection'],
                                     ev['arcadeDiameter'], ev['spg']) == ([0, 1, 2], 3, [5, 6, 7], [8, 9, 10], 11, [13, 14]), ev)

    track = ra.Track()
    for e in S.events(S.stream()): track.feed(e)
    b = track.block(3.0, S.gun(19), S.START)
    check('the press: tracer - (ping + 0.05 s)', abs(b['press']['delta'] - 0.10) < 1e-9 and
          abs(b['press']['gameTime'] - (S.START + 2.9)) < 1e-5, b['press'])
    check('the server reticle and its update at the press', b['markerSource'] == 'server reticle' and
          close(b['serverMarker']['position'], [0.0, 2.0, 9.5 + S.RANGE]) and b['lastServerGunUpdate']['tick'] == 100019, b)
    check('the disc: the update at the shell origin, looking back', b['shotUpdate']['tick'] == 100019 and
          track.block(3.0, S.gun(17), S.START)['shotUpdate']['tick'] == 100017, b['shotUpdate'])
    hidden = ra.Track()
    for e in S.events(S.stream(hidden=True)): hidden.feed(e)
    h = hidden.block(3.0, S.gun(19), S.START)
    check('no server reticle given: none drawn, the client one still the cursor point',
          h['markerSource'] == 'client reticle' and 'serverMarker' not in h
          and close(h['clientMarker']['position'], [0.3, 2.0, 9.5 + S.RANGE]), h.get('markerSource'))

    a, c = S.gun(19), S.gun(19)
    a[0] -= 0.2
    c[0] += 0.2
    tracers = [S.tracer_event(3.0, a, 7), S.tracer_event(3.0, c, 8), S.tracer_event(3.2, S.gun(21), 7, ricochet=True)]
    out = rrec.convert(S.battle_events(S.stream(), tracers))[0]
    shots = [r for r in out if r.get('type') == 'shot' and r.get('event') == 'tracer']
    check('the converter: own main-gun tracers only, a salvo by its mean origin',
          [ra.KEY in s for s in shots] == [True, True, False] and shots[0][ra.KEY]['salvo'] == 2
          and shots[0][ra.KEY]['shotUpdate']['from'] == 'origin', [s.get(ra.KEY, {}).get('salvo') for s in shots])

    records = rrec.convert(S.battle_events(S.stream(), [S.tracer_event(3.0, S.gun(19), 7)]))[0]
    replay = [r for r in records if r.get('event') == 'tracer'][0]
    block = replay[ra.KEY]
    recv = 5000.0
    def at(game): return recv + (game - replay['gameTime'])
    server = {'position':block['serverMarker']['position'], 'direction':block['serverMarker']['direction'],
              'diameter':block['serverMarker']['diameter'], 'receivedAt':at(block['serverMarker']['gameTime'])}
    client = {'position':block['clientMarker']['position'], 'direction':block['clientMarker']['direction'],
              'diameter':block['clientMarker']['diameter'], 'receivedAt':at(block['press']['gameTime'])}
    update = dict(block['lastServerGunUpdate'], receivedAt=server['receivedAt'])
    live = {'type':'shot', 'event':'tracer', 'id':'s5', 'shotId':'7', 'gameTime':replay['gameTime'] + 0.05, 'receivedAt':recv,
            'own':True, 'isRicochet':False, 'gunInstallationIndex':0, 'shooterId':11, 'origin':replay['origin'],
            'velocity':replay['velocity'], 'aimAtTracer':{'clientMarker':client, 'serverMarker':server,
                                                          'lastServerGunUpdate':update, 'gunOrigin':block['gunOrigin']}}
    battle, report = rb.build(records, {'hits':[], 'shotEvents':[live], 'critEvents':[]}, 'x')
    t = [s for s in battle['shotEvents'] if s.get('event') == 'tracer'][0]
    cmp = t[ra.KEY].get('comparison') or {}
    check('the comparison with an equal snapshot', (report['aimBlocks'], report['aimCompared']) == (1, 1)
          and cmp.get('serverMarker', {}).get('same') and cmp.get('disc', {}).get('same')
          and cmp.get('clientMarker', {}).get('centreRadii', 1) < 1e-6, cmp)

    root = tempfile.mkdtemp()
    try:
        folder = os.path.join(root, 'battles')
        os.makedirs(folder)
        def packet(ptype, clock, payload): return struct.pack('<IIf', len(payload), ptype, clock) + payload
        data = packet(0x18, 0.0, b'abcd') + packet(0x16, 2.0, struct.pack('<I', 4))
        source = os.path.join(folder, 'temp.wotreplay')
        with open(source, 'wb') as f: f.write(data)
        broken = rs.StreamCopy(folder, 'broken', '1', source, 0.0)
        os.makedirs(broken.path)
        broken.pull()
        check('a failed write is noted and stops the copy', broken.failure and broken.pull() is None, broken.failure)
        sent = []
        rs.ReplaySource(folder, 'sess', lambda kind, message: sent.append(message), replay_dir=folder,
                        threaded=False).handover(broken, {'at':0.0, 'reason':'battle'}, None, None)
        message = sent[-1] if sent else {}
        check('the hand-over says it', message.get('copyFailure') == broken.failure, message)
        copy = bytearray(data)
        check('distrust reads the final file for it', rr.distrust(message, copy, rr.copy_shape(copy)) ==
              'the copying of the stream failed (%s)' % broken.failure, rr.distrust(message, copy, rr.copy_shape(copy)))
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    crashed = None
    try: main()
    except Exception:
        import traceback
        crashed = traceback.format_exc()
    failed = [c for c in checks if not c[1]]
    lines = ['replay aim (py2.7): %d checks, %d failed' % (len(checks), len(failed) + bool(crashed))]
    lines += ['FAIL %s -- %s' % (name, str(detail)[:400]) for name, ok, detail in failed]
    if crashed: lines.append('FAIL the script crashed:\n' + crashed)
    if not failed and not crashed: lines.append('ALL OK')
    result = os.environ.get('BULLBA_PY27_RESULT')
    if result:
        with open(result, 'w') as stream:
            stream.write('exit %d\n%s\n' % (1 if failed or crashed else 0, '\n'.join(lines)))
    else: print('\n'.join(lines))
