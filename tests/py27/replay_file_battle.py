# -*- coding: utf-8 -*-
"""A Bullba Hits battle made from a replay FILE the recorder has no battle of (19.11.2026, the replay viewer's shot view:
"the shot view works for any replay the viewer opens"), inside the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/replay_file_battle.py

The replay of 02.11 17:42 (the largest local fixture, 129 replay hits) lies in a stand's replays folder with no raw record
of it; the viewer's list (replay_files.Scan) names it 'f-...'. The page's 'prepareBattle' with that id (Exporter.
request_battle) hands the file to the replay route - the same 'replay' job as after a battle (replay_run.Consumption: the
final file decrypted, decoded, converted, the scenes rebuilt, published and stored) with no live record, the arena from
the stream. Checks:

  made      the request queues the replay job; data/battles/<f-id>.js published from the replay ('source' replay, every hit
            with a scene rebuilt from it), in the index; the user's file untouched
  again     a second request while it is current queues nothing
  restart   a new exporter (setup's saved_battles) takes the battle as current from data/published.json - listed, its models
            referenced - though it has no raw file; after a format change the page's request republishes it from its stored
            records (republish_saved -> replay_restore), the same file
The figure printed: the whole job's time on the stand (the game's export thread runs it in slices).
The stand (tests/fixtures-local/ttx-offline, replay_run.py's): statics from replay_scene.py's table, the part models
extracted from the installed client, the definitions from a client snapshot. Absent: SKIP (exit 77).
"""
import json, os, shutil, sys, time, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
BIG = '1755080049627192'
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


def main():
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    sys.path.insert(0, os.path.join(REPO, 'tests'))
    import test_replay_records as t
    if not t.fixtures_ready() or not os.path.isfile(os.path.join(STAND, 'boot27.py')):
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
    from local_armor_inspector import replay_files, replay_records as rrec, replay_run as rr, replay_stream as rd
    from local_armor_inspector.exporter import Exporter, read_data_file
    clock = getattr(time, 'clock')
    big_file = [n for n, a in t.BATTLES if a == BIG][0]
    defs = R.definitions()
    stand = R.Stand([])
    try:
        table = S.statics_table()
        source = S.make_source(table)
        for compact in table:
            for part in table[compact]['parts']:
                if part.get('resource'):
                    try: source.model(part['resource'])
                    except Exception: pass
        replays = os.path.join(stand.root, 'game', 'replays')
        os.makedirs(replays)
        user_file = os.path.join(replays, big_file)
        shutil.copyfile(os.path.join(t.REPLAYS, big_file), user_file)
        with open(user_file, 'rb') as handle: user_bytes = handle.read()
        # the stand reads a nation's vehicle lists from XML the first time (0.3 s a nation): warmed outside the times
        converter = rrec.Converter(names=rrec.ClientNames(), vehicle_names=defs.vehicle_names)
        for k, event in enumerate(rr.decode(defs, rd.read_replay(user_file)[1])[1]):
            converter.feed(event)
            if k > 20000: break

        def exporter():
            e = Exporter(stand.root, stand.root, R.T.VERSION, os.path.join(stand.root, 'unused.wotmod'))
            e.replay_defs_value = defs
            e.scene_source = lambda version: S.make_source(table)
            e.replays_folder = replays
            return e

        scan = replay_files.Scan(stand.root, replays)
        for _ in scan.steps(): pass
        listed = scan.value['files']
        check(len(listed) == 1 and listed[0]['id'].startswith('f-'), 'the replay file is listed with its file id', repr(listed))
        name = listed[0]['id']
        e = exporter()
        started = clock()
        queued = e.request_battle(name)
        R.run_jobs(e)
        took = clock() - started
        path = os.path.join(stand.root, 'data', 'battles', name + '.js')
        value = read_data_file(path) if os.path.isfile(path) else {}
        scenes = sum(1 for h in value.get('hits') or () if isinstance(h.get('replayScene'), dict))
        check(queued and value.get('source') == 'replay' and value['replay']['stream']['from'] == 'final replay file',
              'made: the page\'s request for a replay file with no record publishes its battle from the replay', repr((queued, value.get('source'), (value.get('replay') or {}).get('stream'))))
        check(scenes >= 120, 'made: %d hits with their scene rebuilt from the replay' % scenes)
        index = read_data_file(os.path.join(stand.root, 'data', 'index.js'))
        check(any(b.get('id') == name for b in index.get('battles') or ()), 'made: the index lists it')
        with open(user_file, 'rb') as handle: same_user = handle.read() == user_bytes
        check(same_user and not os.path.exists(os.path.join(stand.root, 'battles', name + '.jsonl')), 'made: the user\'s file untouched, no raw record made')
        lines.append('the mod\'s part on the stand (the 17:42 replay, %.1f MB): %.2f s from the request to the published battle' % (len(user_bytes) / 1e6, took))
        check(not e.request_battle(name) and not e.jobs, 'again: a second request while it is current queues nothing')
        e.write_published()
        # the stand keeps the part models it extracted in its own folder (test_replay_scene.model_exporter); in the game they
        # are this folder's data/models, which setup checks a current battle's references against
        models_from = S.model_exporter()
        if not os.path.isdir(os.path.join(stand.root, 'data', 'models')): os.makedirs(os.path.join(stand.root, 'data', 'models'))
        for key in e.published[name]['refs']:
            got = models_from.model_path(key)
            if os.path.isfile(got): shutil.copyfile(got, os.path.join(stand.root, 'data', 'models', key + '.js'))
        # a restart: setup takes it as current with no raw file
        again = exporter()
        again.saved_battles()
        again.write_index()
        index2 = read_data_file(os.path.join(stand.root, 'data', 'index.js'))
        check(name in again.published and name not in again.stale and bool(again.model_refs.get(name))
              and any(b.get('id') == name for b in index2.get('battles') or ()),
              'restart: current, listed, its models referenced, with no raw file', repr((name in again.published, name in again.stale, len(again.model_refs.get(name) or ()),
              len(set(again.published.get(name, {}).get('refs') or ()) - set(again.model_files())))))
        later = exporter()
        later.stamp = 'd999'
        later.saved_battles()
        asked = later.request_battle(name)
        R.run_jobs(later)
        check(asked and R.strip_rev(read_data_file(path)) == R.strip_rev(value),
              'restart after a format change: the page\'s request republishes it from its stored records, the same file')
    finally:
        shutil.rmtree(stand.root, True)
    return 1 if failures else 0


if __name__ == '__main__':
    try: code = main()
    except Exception:
        lines.append('FAIL the test ran: ' + traceback.format_exc())
        code = 1
    finish(code)
