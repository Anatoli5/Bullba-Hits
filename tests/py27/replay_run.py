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


def drain(e, work, slices=None):
    """The export thread's turns until the queue is empty; the longest slice of a replay job in seconds (the model jobs the
    published battle queues are the queue's own business), not counting a slice in which the interpreter ran a full
    collection of its garbage collector (generation 2: gc.get_count()[2] went down). Such a collection walks every object
    of the process - on this stand ~0.2 s on top of the slice's own steps, 11.11 -, so it is the process's pause, not a
    step of the job: it falls in whichever slice allocates past the threshold (moving one step moved it, 11.11), and in
    the game its cost is the game's heap. Those slices are reported apart (longest_text), not hidden. `slices` gets
    (seconds, the part of Consumption.times that grew most in it, full collection) of every replay slice."""
    import gc
    clock, longest = getattr(time, 'clock'), 0.0
    while e.jobs:
        e.last_job = 0
        current = e.replay_work
        kind = e.jobs[e.best_job()][2]
        before = dict(current.times) if current is not None else {}
        counts = gc.get_count()
        began = clock()
        e.run_job()
        took = clock() - began
        if kind == 'replay':
            full = gc.get_count()[2] < counts[2]
            if not full: longest = max(longest, took)
            if slices is not None:
                job = e.replay_work or current
                after = getattr(job, 'times', None) or {}
                if current is None: before = {}
                grew = sorted(((after.get(k, 0.0) - before.get(k, 0.0), k) for k in after), reverse=True)
                slices.append((took, grew[0][1] if grew else '?', full))
        if current is not None and e.replay_work is None: work.append(current)
    return longest


def Lines():
    """A logging handler that keeps the messages (the mod's line of what a replay job cost)."""
    import logging

    class Handler(logging.Handler):
        def emit(self, record):
            self.lines.append(record.getMessage())
    handler = Handler(logging.INFO)
    handler.lines = []
    return handler


def longest_text(slices):
    """'0.231 s (definitions)': the longest replay slice without a full garbage collection and the part of the job it was
    spent on; then the slices that had one, each with its time and part."""
    own = [row for row in slices if not row[2]]
    text = '%.3f s (%s)' % max(own)[:2] if own else '?'
    full = [row for row in slices if row[2]]
    if full: text += '; with a full garbage collection in it: ' + ', '.join('%.3f s (%s)' % row[:2] for row in full)
    return text


# ---- the times as ratios to the machine's speed on one core ---------------------------------------------------------------
# Wall-clock times here depend on the core the scheduler gives the thread (measured 11.11.2026 on this machine, an Intel
# Core Ultra 9 275HX with fast and slow cores, the game client busy at 4-5 cores): pinned to one core a fixed workload
# (calibrate) holds within ~3 %, but per core it took 0.151-0.17 s (cores 0, 10, 12, 14-17, 22, 23), 0.185-0.19 (1-5),
# 0.20 (11), 0.225 (6-9), 0.245-0.26 (13, 18-21); unpinned, the thread moves and every time here wandered ~40 %. The
# republish after a restart pinned: 0.92-0.95 s on core 12 (calibration 0.148-0.155), 1.04-1.07 on 15, 1.63-1.67 on 19 -
# 6.2-6.6 calibrations on any core. So the process is pinned to the fastest core found at the start (pin_fastest) and
# each measured part is judged in calibrations taken on that core right before and after it (the slower of the two):
#   slice      <= SLICE_LIMIT calibrations: 2.08 = 0.3 s at the reference speed (the idle limit it replaces); measured
#                 1.10-1.46 unpinned;
#   republish  <= REPUBLISH_LIMIT calibrations: 7.5 ~ 1.08 s at the reference speed; today's cost 6.2-6.6, the same
#                 republish made 1.5x slower ~9.5 - the threshold separates the two.
# Reference speed: CALIBRATION_REFERENCE, the fastest calibration seen on this machine (11.11.2026), only to show seconds.
SLICE_LIMIT = 2.08
REPUBLISH_LIMIT = 7.5
CALIBRATION_REFERENCE = 0.144
PIN_HELPER = ('import ctypes,sys;k=ctypes.windll.kernel32;h=k.OpenProcess(0x0600,0,int(sys.argv[1]));'
              'ok=h and k.SetProcessAffinityMask(ctypes.c_void_p(h),ctypes.c_size_t(int(sys.argv[2])));'
              'h and k.CloseHandle(ctypes.c_void_p(h));sys.exit(0 if ok else 1)')


def calibrate(rounds=200000):
    """Seconds of a fixed pure-Python workload in this interpreter: struct reads, integer arithmetic, dict and list work
    (what the replay job does), with the garbage collector off while it runs (the test's large heap would put a full
    collection in it now and then)."""
    import gc, struct
    clock = getattr(time, 'clock')
    enabled = gc.isenabled()
    gc.disable()
    try:
        started = clock()
        data = struct.pack('<64I', *range(64))
        table, out, acc = {}, [], 0
        for k in range(rounds):
            a, b = struct.unpack_from('<II', data, (k & 31) * 8)
            acc = (acc ^ (a * 2654435761 + b + k)) & 0xffffffff
            key = acc & 1023
            table[key] = table.get(key, 0) + 1
            if k & 7 == 0: out.append((key, acc >> 16))
            if len(out) > 4096: del out[:]
        return clock() - started
    finally:
        if enabled: gc.enable()


def pin(mask):
    """This process's cores = `mask` (the client's Python 2.7 has no ctypes: a CPython helper sets it). True when set."""
    import subprocess
    try: return subprocess.call([sys.executable, '-I', '-c', PIN_HELPER, str(os.getpid()), str(mask)]) == 0
    except Exception: return False


def cores():
    try: return max(1, min(64, int(os.environ.get('NUMBER_OF_PROCESSORS') or 1)))
    except ValueError: return 1


def pin_fastest():
    """Pin the process to the core where a short calibration is fastest (each core tried twice, ~2-3 s); the core, or None
    when pinning is not available (the run is then unpinned and says so)."""
    best = None
    for core in range(cores()):
        if not pin(1 << core): return None
        took = min(calibrate(40000) for _ in range(2))
        if best is None or took < best[0]: best = (took, core)
    return best[1] if best is not None and pin(1 << best[1]) else None


def ratio_text(seconds, before, after, limit, core):
    """(seconds over the slower calibration, the text): seconds, calibration, ratio and its limit, the core."""
    calibration = max(before, after)
    ratio = seconds / calibration
    return ratio, '%.3f s = %.2f calibrations of %.3f s (%.3f/%.3f; limit %.2f = %.2f s at the reference speed) on %s' % (
        seconds, ratio, calibration, before, after, limit, limit * CALIBRATION_REFERENCE,
        'core %d' % core if core is not None else 'no pinned core (pinning unavailable)')


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

    pinned = []
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
        # The copy is not trusted as the battle (no orderly end, the crash path - backlog 84): the final file is decrypted.
        message = stand.message(BIG, copy_path, complete=False, final=final, finalOwned=True, end='restart')
        # The wall-clock part on one core, the fastest found now (see SLICE_LIMIT).
        core = pin_fastest()
        pinned.append(core)
        lines.append('timed on %s' % ('core %d of %d (the fastest by a short calibration on each)' % (core, cores())
                                       if core is not None else 'no pinned core: pinning unavailable, the times are unpinned'))
        seen = Lines()
        log.addHandler(seen)
        level = log.level
        log.setLevel(logging.INFO)
        calm = calibrate()
        started = clock()
        e.replay_stream(message)
        work = []
        slices = []
        longest = drain(e, work, slices)
        first_wall = clock() - started
        ratio, text = ratio_text(longest, calm, calibrate(), SLICE_LIMIT, core)
        log.removeHandler(seen)
        log.setLevel(level)
        name = stand.names[BIG]
        value = stand.published(BIG)
        check(value.get('source') == 'replay' and value['replay']['stream']['from'] == 'final replay file'
              and not value['replay']['stream']['cut'], '17:42: published from the decrypted final file, not cut')
        scenes = sum(1 for h in value['hits'] if isinstance(h.get('replayScene'), dict))
        check(scenes >= 120, '17:42: %d hits with their scene rebuilt from the replay' % scenes)
        check(not os.path.exists(final) and not os.path.exists(copy_path), '17:42: the mod\'s final file and the raw copy are gone')
        # 20.11 (the one store of replays): no stream.z is kept in the mod's folder any more; the records are
        check(not os.path.exists(e.replay_stream_path(name)), "17:42: no stream.z kept in the mod's folder")
        stored = os.path.getsize(e.replay_records_path(name))
        last = e.replay_state()[name]
        check(ratio <= SLICE_LIMIT, '17:42: the longest slice of the job %s - BATTLE_SLICE = 0.1 s, then the step that '
              'crosses it; in brackets the part of the job that slice was spent on; %s' % (longest_text(slices), text))
        # What the mod itself says the job cost (its log line and the battle's index entry): consistent with the slices
        # the test timed around run_job (the mod's own slice is inside that).
        job = last.get('job') or {}
        cost = [l for l in seen.lines if l.startswith('Replay of %s, its cost in the game: ' % name)]
        check(len(cost) == 1 and job.get('slices') == len(slices) and 0 < job.get('longest', 0) <= job.get('work', 0)
              and job['longest'] <= max(row[0] for row in slices) + 0.001 and job.get('longestPart') in work[0].times
              and 0 <= job.get('fullCollections', -1) <= job['slices'],
              '17:42: the mod logs and keeps what the job cost, consistent with the slices timed here', repr((cost, job)))
        # The probe of every slice (BACKLOG 84) under the game's Python 2.7: ~0.6 ms on the fastest core; the own-work
        # estimate never above the slices' wall.
        probe_ms = job.get('probeMs') or [0, 0, 0]
        check(0 < probe_ms[0] <= probe_ms[1] <= probe_ms[2] and job.get('ownWorkEstimate') is not None
              and job['ownWorkEstimate'] <= job['work'] + 0.001 and 0 <= job.get('contendedSlices', -1) <= job['slices'],
              '17:42: the probe min/median/max %s ms, %s contended slice(s) of %s s, own work estimated %s s of %s s'
              % (probe_ms, job.get('contendedSlices'), job.get('contendedWall'), job.get('ownWorkEstimate'), job.get('work')))
        if cost: lines.append('the mod\'s line: ' + cost[0])
        lines.append('17:42 first battle of a session, the whole job: %.2f s (%s); stream %.2f MB, '
                     'stored records %.2f MB, raw record %.2f MB, published file %.2f MB'
                     % (first_wall, ', '.join('%s %.2f s' % kv for kv in sorted(work[0].times.items())) if work else '?',
                        len(stream) / 1e6, stored / 1e6,
                        os.path.getsize(os.path.join(stand.root, 'battles', name + '.jsonl')) / 1e6,
                        os.path.getsize(os.path.join(stand.root, 'data', 'battles', name + '.js')) / 1e6))
        check(last.get('status') == 'used', '17:42: marked consumed', repr(last.get('status')))
        e.write_published()

        # ---- a restart: a new exporter republishes it from the store ------------------------------------------------
        # A full collection of the garbage collector (gc.get_count()[2] goes down, as drain) can fall in it - the 4th
        # republish in a row always had one, +0.35 s: such a republish is reported and the restart done again (up to 3).
        import gc
        tries = []
        while len(tries) < 3:
            again = exporter()
            again.saved_battles()
            calm = calibrate()
            counts = gc.get_count()
            started = clock()
            again.republish_saved(name)
            took = clock() - started
            full = gc.get_count()[2] < counts[2]
            tries.append((took, calm, calibrate(), full))
            if not full: break
        took, calm, after, full = tries[-1]
        ratio, text = ratio_text(took, calm, after, REPUBLISH_LIMIT, core)
        if len(tries) > 1:
            text += '; before it, with a full garbage collection in it: ' + ', '.join('%.3f s' % row[0] for row in tries[:-1])
        same = R.strip_rev(stand.published(BIG)) == R.strip_rev(value)
        check(same, '17:42 after a restart: the same file, from the stored records')
        # One go by design (Exporter.replay_restore inside publish): in the game it runs on the export thread outside
        # battles only when the page opens a replay-made battle whose file is stale (a new mod version's format; the page
        # shows the old file meanwhile, once per battle per version) or when a model the battle waits for arrives
        # (drain_republish - every battle's model republish is one go). Setup does not run it: a current file is taken as
        # it is. Its limit: REPUBLISH_LIMIT calibrations (see SLICE_LIMIT).
        check(ratio <= REPUBLISH_LIMIT and not full, '17:42 after a restart: republished in %s' % text)
        later = exporter()
        later.stamp = 'd999'
        later.saved_battles()
        later.request_battle(name)
        started = clock()
        R.run_jobs(later)
        page = clock() - started
        check(R.strip_rev(stand.published(BIG)) == R.strip_rev(value),
              '17:42 after a format change: the page\'s request rebuilds it the replay way (%.2f s)' % page)

        # ---- 17:42 again, the copy reaching the end of the fight (backlog 84): no decryption, the same battle ----------
        stand_end = R.Stand([BIG])
        try:
            near_end = R.packet_cut(stream, 1.0 - 20000.0 / len(stream))
            end = rr.fight_end(near_end)
            # and a copy of a player who left 2 KB before the end: the battle up to his exit, the tail not read
            left = R.packet_cut(stream, (rr.fight_end(stream)[0] - 2000.0) / len(stream))
            path_end = stand_end.stream_file(BIG, near_end)
            final_end = os.path.join(stand_end.root, 'bullba_hits_battle.wotreplay')
            shutil.copyfile(os.path.join(t.REPLAYS, big_file), final_end)
            e_end = Exporter(stand_end.root, stand_end.root, R.T.VERSION, os.path.join(stand_end.root, 'unused.wotmod'))
            e_end.replay_defs_value = defs
            e_end.scene_source = lambda version: S.make_source(table)
            calm = calibrate()
            started = clock()
            e_end.replay_stream(stand_end.message(BIG, path_end, complete=False, final=final_end, finalOwned=True,
                                                  fightEnd=list(end) if end else None))
            work = []
            drain(e_end, work, [])
            took_end = clock() - started
            after_end = calibrate()
            got = R.strip_rev(stand_end.published(BIG))
            info = got['replay'].pop('stream')
            expected = R.strip_rev(value)
            expected['replay'].pop('stream')
            times = work[0].times if work else {}
            check(end is not None and info.get('from') == 'stream copy' and not info.get('cut') and 'decrypt' not in times
                  and not os.path.exists(final_end) and got == expected,
                  '17:42, the copy reaching the end of the fight: the final file not decrypted, the battle the same as from '
                  'the decrypted final file (%.2f s = %.1f calibrations; %s)' % (
                      took_end, took_end / max(calm, after_end), ', '.join('%s %.2f s' % kv for kv in sorted(times.items()))))
        finally:
            stand_end.close()
        stand_left = R.Stand([BIG])
        try:
            path_left = stand_left.stream_file(BIG, left)
            final_left = os.path.join(stand_left.root, 'bullba_hits_battle.wotreplay')
            shutil.copyfile(os.path.join(t.REPLAYS, big_file), final_left)
            e_left = Exporter(stand_left.root, stand_left.root, R.T.VERSION, os.path.join(stand_left.root, 'unused.wotmod'))
            e_left.replay_defs_value = defs
            e_left.scene_source = lambda version: S.make_source(table)
            calm = calibrate()
            started = clock()
            e_left.replay_stream(stand_left.message(BIG, path_left, complete=False, final=final_left, finalOwned=True,
                                                    finalStreamBytes=len(stream)))
            work = []
            drain(e_left, work, [])
            took_left = clock() - started
            after_left = calibrate()
            info = stand_left.published(BIG)['replay']['stream']
            times = work[0].times if work else {}
            check(info.get('from') == 'stream copy' and not info.get('cut') and 'decrypt' not in times
                  and info.get('tail') == 'left before the end, tail not read (%d bytes)' % (len(stream) - len(left))
                  and not os.path.exists(final_left),
                  '17:42, a player who left before the end: the copy is the battle, the final file not decrypted '
                  '(%.2f s = %.1f calibrations; %s)' % (took_left, took_left / max(calm, after_left),
                                                         ', '.join('%s %.2f s' % kv for kv in sorted(times.items()))))
        finally:
            stand_left.close()

        # ---- 20.10: the next battle of the session ------------------------------------------------------------------
        _, stream2 = rd.read_replay(os.path.join(t.LIVE, next_file))
        path2 = stand.stream_file(NEXT, bytes(stream2))
        calm = calibrate()
        started = clock()
        e.replay_stream(stand.message(NEXT, path2))
        work = []
        slices = []
        longest = drain(e, work, slices)
        took = clock() - started
        ratio, text = ratio_text(longest, calm, calibrate(), SLICE_LIMIT, core)
        value2 = stand.published(NEXT)
        window = [h for h in value2['hits'] if str(h.get('id', '')).startswith('r')]
        check(len(window) == 1 and isinstance(window[0].get('replayScene'), dict)
              and value2['damageCheck']['missing'] == 0, '20.10: the death camera\'s hit published with its scene, no HP missing')
        check(ratio <= SLICE_LIMIT, '20.10: the longest slice of the job %s; %s' % (longest_text(slices), text))
        lines.append('20.10 next battle of the session (definitions not paid again), the whole job: %.2f s (%s)'
                     % (took, ', '.join('%s %.2f s' % kv for kv in sorted(work[0].times.items())) if work else '?'))
        check(e.replay_defs_value is not None and 'definitions' in (work[0].times if work else {})
              and work[0].times['definitions'] < 0.01, '20.10: the definitions were not built again')
    finally:
        if pinned and pinned[0] is not None: pin((1 << cores()) - 1)
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
