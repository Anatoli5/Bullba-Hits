# -*- coding: utf-8 -*-
"""The replay path at run time (replay_run.py, Exporter.replay_stream) inside the client's own Python 2.7: what it costs
there and that a restart republishes a replay-made battle from its store in under 1 s.

    python tests/py27/run27.py tests/py27/replay_run.py

On the offline stand of the client's items package (tests/fixtures-local/ttx-offline, as replay_battle.py) the names are
the run-time ones (replay_records.ClientNames, the exporter's own replay_names); the vehicles' statics come from the table
of replay_scene.py (the stand's hit testers are stubs), the part models from the installed client, the definitions from a
snapshot of the installed client (the exporter's own ClientSnapshot; in the game setup takes it anyway). Three battles:

  02.11 17:42 (the largest, 129 replay hits): the mod's copy holds 60 % of the stream and the mod's own final file all of
              it - the first battle of a session: the definitions built, the final file decrypted, decoded, converted,
              the scenes rebuilt, published, stored; then a restart (a new exporter, nothing in memory) republishes it from
              its store - under 1 s, the same file - and the page's request after a format change does the same;
  20.10       the next battle of the session (definitions not paid again): its whole stream copy, the death camera's hit
              published with its scene, no HP missing.
Local fixtures, the client or the stand absent: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, os, shutil, sys, time, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
BIG = '1755080049627192'
NEXT = '30838317949392403'
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


def drain(e, work):
    """The export thread's turns until the queue is empty; the longest slice of a replay job in seconds (the model jobs the
    published battle queues are the queue's own business)."""
    clock, longest = getattr(time, 'clock'), 0.0
    while e.jobs:
        e.last_job = 0
        current = e.replay_work
        kind = e.jobs[e.best_job()][2]
        began = clock()
        e.run_job()
        if kind == 'replay': longest = max(longest, clock() - began)
        if current is not None and e.replay_work is None: work.append(current)
    return longest


def main():
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    sys.path.insert(0, os.path.join(REPO, 'tests'))
    import test_replay_records as t
    if not (t.fixtures_ready() and t.kill_cam_ready()) or not os.path.isfile(os.path.join(STAND, 'boot27.py')):
        lines.append('SKIP: the local replay fixtures, the client or the offline stand are absent')
        return 77
    import test_replay_run as R
    if not R.fixtures_ready():
        lines.append('SKIP: the names or statics tables are absent')
        return 77
    saved = sys.stdout, sys.stderr
    try:
        import imp
        stand_module = sys.modules['ttx_stand'] = imp.new_module('ttx_stand')
        execfile(os.path.join(STAND, 'boot27.py'), stand_module.__dict__)
        stand_module.__dict__['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        lines.append('SKIP: the stand did not boot on this client:\n' + traceback.format_exc())
        return 77
    sys.stdout, sys.stderr = saved
    import logging
    log = logging.getLogger('local.armor_inspector')
    log.addHandler(logging.NullHandler())
    log.propagate = False
    import test_replay_scene as S
    from local_armor_inspector import replay_run as rr, replay_stream as rd
    from local_armor_inspector.exporter import Exporter
    clock = getattr(time, 'clock')
    big_file = [n for n, a in t.BATTLES if a == BIG][0]
    next_file = [n for n, a in t.KILL_CAM if a == NEXT][0]

    # The definitions as the game builds them: from the client snapshot (setup takes it), once a session.
    defs = R.definitions()
    lines.append('definitions from the client snapshot: %.2f s (the snapshot itself %.2f s, taken by setup in the game; '
                 'source %s)' % (defs.built_in, defs.snapshot_seconds, defs.source))
    check(defs.source == 'client snapshot', 'the definitions come from the client snapshot, no package scanned')

    stand = R.Stand([BIG, NEXT])
    try:
        # The models the scenes read, extracted beforehand (in the game the live battle's own jobs extract them).
        table = S.statics_table()
        source = S.make_source(table)
        for compact in table:
            for part in table[compact]['parts']:
                if part.get('resource'):
                    try: source.model(part['resource'])
                    except Exception: pass

        def exporter():
            e = Exporter(stand.root, stand.root, R.T.VERSION, os.path.join(stand.root, 'unused.wotmod'))
            e.replay_defs_value = defs
            e.scene_source = lambda version: S.make_source(table)
            return e

        # ---- 17:42: the first battle of a session, the final file decrypted ------------------------------------------
        blocks, stream = rd.read_replay(os.path.join(t.REPLAYS, big_file))
        # The stand reads a nation's vehicle lists from XML the first time a descriptor of it is built (0.3 s a nation);
        # in the game the battle has built every descriptor of its vehicles already. Warmed here, outside the times: the
        # battles' rosters converted with the run-time names.
        from local_armor_inspector import replay_records as rrec
        for warm in (stream, rd.read_replay(os.path.join(t.LIVE, next_file))[1]):
            converter = rrec.Converter(names=rrec.ClientNames(), vehicle_names=defs.vehicle_names)
            for k, event in enumerate(rr.decode(defs, warm)[1]):
                converter.feed(event)
                if k > 20000: break
        copy_path = stand.stream_file(BIG, R.packet_cut(stream, 0.6))
        final = os.path.join(stand.root, 'bullba_hits_battle.wotreplay')
        shutil.copyfile(os.path.join(t.REPLAYS, big_file), final)
        e = exporter()
        e.replay_defs_value = None
        # The first battle pays the definitions: built here from a snapshot taken beforehand (the game's setup took it).
        from local_armor_inspector.client_snapshot import ClientSnapshot
        with open(os.path.join(R.GAME, 'version.xml'), 'rb') as handle: text = handle.read().decode('utf-8', 'replace')
        snap = ClientSnapshot(R.GAME, R._CACHE['snapshot folder'], text)
        snap.refresh()
        snap.files()
        e.client = lambda: snap
        e.game = R.GAME
        message = stand.message(BIG, copy_path, complete=False, final=final, finalOwned=True)
        started = clock()
        e.replay_stream(message)
        work = []
        longest = drain(e, work)
        first_wall = clock() - started
        name = stand.names[BIG]
        value = stand.published(BIG)
        check(value.get('source') == 'replay' and value['replay']['stream']['from'] == 'final replay file'
              and not value['replay']['stream']['cut'], '17:42: published from the decrypted final file, not cut')
        scenes = sum(1 for h in value['hits'] if isinstance(h.get('replayScene'), dict))
        check(scenes >= 120, '17:42: %d hits with their scene rebuilt from the replay' % scenes)
        check(not os.path.exists(final) and not os.path.exists(copy_path), '17:42: the mod\'s final file and the raw copy are gone')
        kept, stored = os.path.getsize(e.replay_stream_path(name)), os.path.getsize(e.replay_records_path(name))
        last = e.replay_state()[name]
        check(longest < 0.3, '17:42: the longest slice of the job %.3f s (BATTLE_SLICE = 0.1 s, then the step that crosses it; the longest step: replay_battle.build)' % longest)
        lines.append('17:42 first battle of a session, the whole job: %.2f s (%s); kept stream %.2f MB (stream %.2f MB), '
                     'stored records %.2f MB, raw record %.2f MB, published file %.2f MB'
                     % (first_wall, ', '.join('%s %.2f s' % kv for kv in sorted(work[0].times.items())) if work else '?',
                        kept / 1e6, len(stream) / 1e6, stored / 1e6,
                        os.path.getsize(os.path.join(stand.root, 'battles', name + '.jsonl')) / 1e6,
                        os.path.getsize(os.path.join(stand.root, 'data', 'battles', name + '.js')) / 1e6))
        check(last.get('status') == 'used', '17:42: marked consumed', repr(last.get('status')))
        e.write_published()

        # ---- a restart: a new exporter republishes it from the store ------------------------------------------------
        again = exporter()
        again.saved_battles()
        started = clock()
        again.republish_saved(name)
        took = clock() - started
        same = R.strip_rev(stand.published(BIG)) == R.strip_rev(value)
        check(same, '17:42 after a restart: the same file, from the stored records')
        check(took < 1.0, '17:42 after a restart: republished in %.2f s (under 1 s)' % took)
        later = exporter()
        later.stamp = 'd999'
        later.saved_battles()
        later.request_battle(name)
        started = clock()
        R.run_jobs(later)
        page = clock() - started
        check(R.strip_rev(stand.published(BIG)) == R.strip_rev(value),
              '17:42 after a format change: the page\'s request rebuilds it the replay way (%.2f s)' % page)

        # ---- 20.10: the next battle of the session ------------------------------------------------------------------
        _, stream2 = rd.read_replay(os.path.join(t.LIVE, next_file))
        path2 = stand.stream_file(NEXT, bytes(stream2))
        started = clock()
        e.replay_stream(stand.message(NEXT, path2))
        work = []
        longest = drain(e, work)
        took = clock() - started
        value2 = stand.published(NEXT)
        window = [h for h in value2['hits'] if str(h.get('id', '')).startswith('r')]
        check(len(window) == 1 and isinstance(window[0].get('replayScene'), dict)
              and value2['damageCheck']['missing'] == 0, '20.10: the death camera\'s hit published with its scene, no HP missing')
        check(longest < 0.3, '20.10: the longest slice of the job %.3f s' % longest)
        lines.append('20.10 next battle of the session (definitions not paid again), the whole job: %.2f s (%s)'
                     % (took, ', '.join('%s %.2f s' % kv for kv in sorted(work[0].times.items())) if work else '?'))
        check(e.replay_defs_value is not None and 'definitions' in (work[0].times if work else {})
              and work[0].times['definitions'] < 0.01, '20.10: the definitions were not built again')
    finally:
        stand.close()
    return 1 if failures else 0


try:
    code = main()
except Exception:
    lines.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
    code = 1
lines.append('%d checks, %d failed' % (len([l for l in lines if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
finish(code)
