# -*- coding: utf-8 -*-
"""The run-time names of a replay-made battle (replay_records.ClientNames) inside the client's own Python 2.7 and modules.

    python tests/py27/run27.py tests/py27/replay_battle.py            the check
    python tests/py27/run27.py tests/py27/replay_battle.py update     write the answers table the CPython test reads

The live recorder names indexes from the running client (crit_log.CritLog: constants, extras of the vehicle descriptor,
hit flags, the crit mask, the ammo-bay mode, the roster's short name). For a replay the same names come from ClientNames,
which builds each vehicle's descriptor from the replay's compact descriptor. Here it runs on the offline stand of the
client's items package (tests/fixtures-local/ttx-offline, as ttx_devices.py) over the six local battles that have both a
replay and a live record (02.11 x3, 09.11, the kill-cam battles 15.10 and 20.10), and:

  - every name-bearing field of a replay crit record (and the roster's 'name') equals the live record's on the matched
    records (rb.pair, the pairing of the publication) - a field the live record holds as null and the replay leaves out
    counts as equal (nothing to name);
  - every answer it gave equals the table tests/fixtures-local/replay-battle-2026-11-11/names.json, which
    tests/test_replay_battle.py (CPython 3, no client modules) answers the same questions from - so the CPython proofs of
    the publication use exactly these names. 'update' writes the table.
Local fixtures, the client or the stand absent: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, os, sys, time, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
UPDATE = 'update' in sys.argv[1:]
# Per crit kind: the fields the live recorder names from the client.
NAMED = {'health':('attackReason',), 'extraHit':('extra', 'extraType'), 'publicState':('added', 'addedTypes', 'removed'),
         'hitDirection':('attackReason', 'critsDecoded'), 'damageInfo':('damageCode', 'extra', 'extraType'),
         'damagedDevices':('damaged', 'damagedTypes', 'destroyed', 'destroyedTypes'), 'ammoBay':('modeName',),
         'fireInfo':('notification', 'device', 'deviceType')}
lines, failures = [], []


def finish(code):
    body = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(body.encode('utf-8') if not isinstance(body, bytes) else body)
    else:
        sys.stdout.write(body)


def check(ok, label, detail=''):
    lines.append(('ok   ' if ok else 'FAIL ') + label + ('' if ok or not detail else ' - ' + detail))
    if not ok: failures.append(label)


def plain(value):
    return json.loads(json.dumps(value))


def same(live, replay, record, field):
    if field in live and field not in replay: return live[field] is None or live[field] == []
    return plain(live.get(field)) == plain(replay.get(field))


def main():
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    sys.path.insert(0, os.path.join(REPO, 'tests'))
    import test_replay_records as t
    if not (t.fixtures_ready() and t.kill_cam_ready()) or not os.path.isfile(os.path.join(STAND, 'boot27.py')):
        lines.append('SKIP: the local replay fixtures, the client or the offline stand are absent')
        return 77
    saved = sys.stdout, sys.stderr
    try:
        import imp
        stand = sys.modules['ttx_stand'] = imp.new_module('ttx_stand')
        execfile(os.path.join(STAND, 'boot27.py'), stand.__dict__)
        stand.__dict__['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        lines.append('SKIP: the stand did not boot on this client:\n' + traceback.format_exc())
        return 77
    sys.stdout, sys.stderr = saved
    import test_replay_battle as T
    from local_armor_inspector import replay_records as rr, replay_battle as rb
    from local_armor_inspector.exporter import read_battle
    started = time.clock()
    table = {}
    for name, arena, folder in T.FOUR + T.KILL_CAM:
        names = T.RecordingNames(rr.ClientNames())
        records = T.convert(name, folder, names)
        live = read_battle(t.live_path(arena))
        crits = [r for r in records if r.get('type') == 'crit']
        matched = rb.pair(live['critEvents'], crits, rb.crit_key, rb.CRIT_WINDOW)
        compared = differ = 0
        bad = []
        for r in crits:
            m = matched.get(id(r))
            if m is None: continue
            fields = NAMED.get(r['event'], ())
            if r['event'] == 'shotResults':
                ok = [plain(a.get('flagNames')) == plain(b.get('flagNames')) for a, b in zip(m['results'], r['results'])]
                compared += len(ok)
                if not all(ok): bad.append(('shotResults', 'flagNames'))
                continue
            for field in fields:
                if field not in m: continue
                compared += 1
                if not same(m, r, r, field):
                    differ += 1
                    bad.append((r['event'], field, m.get(field), r.get(field)))
        roster_live = dict((v['id'], v) for v in live.get('roster') or ())
        roster = [r for r in records if r.get('type') == 'roster'][-1]['vehicles']
        names_bad = [(v['id'], roster_live[v['id']].get('name'), v.get('name')) for v in roster
                     if v['id'] in roster_live and plain(roster_live[v['id']].get('name')) != plain(v.get('name'))]
        check(not bad and not names_bad, '%s: %d named crit fields and %d roster names equal the live record\'s'
              % (name, compared, len(roster)), repr(bad[:5] + names_bad[:5]))
        table[name] = plain(names.table())
        # The assembly under this Python: every live hit gets its scene, the window's hits stay scene-less.
        battle, report = rb.build(records, live)
        window = {'16434853064049700':9, '30838317949392403':1}.get(arena, 0)
        check((report['hitsWithScene'], report['hitsWithoutScene'], report['liveOnly'].get('hit', 0))
              == (len(live['hits']), window, 0) and len(battle['hits']) == len(live['hits']) + window,
              '%s: replay_battle.build - %d hits with their live scene, %d scene-less' % (name, len(live['hits']), window),
              repr(report))
    lines.append('stand + 6 replays decoded and converted with ClientNames: %.1f s' % (time.clock() - started))
    path = T.NAMES_TABLE
    if UPDATE:
        folder = os.path.dirname(path)
        if not os.path.isdir(folder): os.makedirs(folder)
        with open(path, 'wb') as stream: stream.write(json.dumps(table, indent=1, sort_keys=True).encode('utf-8'))
        lines.append('written %s' % path)
    elif not os.path.isfile(path):
        check(False, 'the names table exists - run with "update"')
    else:
        with open(path, 'rb') as stream: stored = json.loads(stream.read().decode('utf-8'))
        check(stored == table, 'every answer of ClientNames equals the table the CPython test reads',
              ', '.join(sorted(k for k in set(stored) | set(table) if stored.get(k) != table.get(k))))
    return 1 if failures else 0


try:
    code = main()
except Exception:
    lines.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
    code = 1
lines.append('%d checks, %d failed' % (len([l for l in lines if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
finish(code)
