"""The replay viewer's list of replay files and a replay with no record of Bullba Hits (19.11.2026, 'one mod, two
entries'), under the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/replay_files.py                 the check (tools/check.py runs it)
    python tests/py27/run27.py tests/py27/replay_files.py --stage DIR     the same in DIR, kept for tests/page/
                                                                         playback_files.cjs (DIR: a stage of
                                                                         playback_job.py --stage, or an empty folder)
    python tests/py27/run27.py tests/py27/replay_files.py --measure DIR   only the number: the headers of a real replays
                                                                         folder DIR read (read only; the cache in a temp
                                                                         folder), with the file count

A staged game replays folder (the user's battle of 14.11 on Malinovka, tests/fixtures-local/playback-2026-11-18: its
stream encrypted into .wotreplay files with headers as the game writes them):
  OWN     the player's own replay, also kept by hand in replays/bullba_hits/ under another name (same content: one entry,
          the kept one)
  OTHER   the same battle recorded by another player (other nickname and time): no record of Bullba Hits
  broken  a file that is no replay: skipped with one log line; temp.wotreplay (the game's growing file) not listed
Checks:
  list      the exporter's 'replayFiles' job writes data/replay-files.js: OWN once (kept), OTHER, newest first, the
            broken file named, the page told {kind files}; a second scan reads no header (cache by name, size, mtime)
  id        the id is the content's: OTHER renamed keeps its id
  record    OTHER opened ('playback' with its id): its battle file - map and mode from the header, the header's roster
            with nicknames and max HP, the own vehicle from the header, the source the .wotreplay byte for byte, the part
            boxes of every static part of the staged vehicle files computed from the model (Exporter.part_box =
            geometry.client_box of the client's .havok), the vehicle files listed
  modes     BACKLOG 112: special battle modes (replay_files.special_mode, by the header's battleType and gameplayID) -
            the rule on known types, an Onslaught file marked in the list and a random one not, the random battle's
            file unmarked; the count of the repository's fixture replays marked (in the summary line)
  vehicles  a type with no vehicle file ('playbackVehicles'): on the stand the client's descriptor cannot be built (no
            items.vehicles), so the client's XML route makes data/playback/vehicles/<id>.js - its parts' resources those
            of the fixture's vehicle file of that type, every model file there; the page told with the files
No fixture or no client packages: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import glob
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import traceback
import zlib

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18')
BATTLE = '2315856430906286521-d36eff9b31bb'
ARENA = '02_malinovka'
MISSING = 'usa:A83_T110E4'      # its vehicle file taken out of the stage: the viewer's vehicle route makes it
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True

from local_armor_inspector import exporter, playback, replay_files


class Lines(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self)
        self.lines = []

    def emit(self, record):
        try: self.lines.append(record.getMessage())
        except Exception: pass


def header(roster, player, when, own_id):
    vehicles = {}
    for row in roster:
        vehicles[str(row['id'])] = {'vehicleType': row['type'], 'name': row.get('player'), 'team': row.get('team'),
                                    'maxHealth': row.get('maxHealth'), 'isAlive': True}
    vehicles[str(own_id)]['name'] = player
    return {'dateTime': when, 'mapName': ARENA, 'mapDisplayName': 'Malinovka', 'gameplayID': 'ctf', 'battleType': 1,
            'playerName': player, 'playerID': 1000 + len(player), 'playerVehicle': 'germany-G197_Pz_Kpfw_Neu',
            'clientVersionFromXml': '2.4.1.1 #992', 'vehicles': vehicles}


def run_jobs(stand, kinds, limit=170):
    began = time.time()
    while any(j[2] in kinds for j in stand.jobs) and time.time() - began < limit:
        stand.last_job = 0
        stand.run_job()


def check():
    from playback_job import Stand, stage
    from replay_library import write_final
    checks = []

    def ok(name, value, detail=''):
        checks.append((name, bool(value), detail))
        return bool(value)

    args = sys.argv[1:]
    keep = args[args.index('--stage') + 1] if '--stage' in args else None
    folder = keep or tempfile.mkdtemp(prefix='bullba-files-')
    if not os.path.isdir(folder): os.makedirs(folder)
    lines = Lines()
    logging.getLogger('local.armor_inspector').addHandler(lines)
    logging.getLogger('local.armor_inspector').setLevel(logging.INFO)
    try:
        if not os.path.isdir(os.path.join(folder, 'data', 'vehicles')): stage(folder)
        missing = os.path.join(folder, 'data', 'vehicles', MISSING.replace(':', '-') + '.js')
        want = exporter.read_data_file(os.path.join(FIXTURE, 'data', 'vehicles', os.path.basename(missing)))
        if os.path.isfile(missing): os.remove(missing)
        with open(os.path.join(FIXTURE, 'battles', BATTLE + '.jsonl'), 'rb') as handle:
            rows = [json.loads(l.decode('utf-8')) for l in handle]
        record = [r for r in rows if r.get('type') == 'battle'][0]
        roster = [r for r in rows if r.get('type') == 'roster'][0]['vehicles']
        own_id = record['playerVehicleId']
        with open(os.path.join(FIXTURE, 'replay', BATTLE + '.stream.z'), 'rb') as handle:
            stream = bytearray(zlib.decompress(handle.read()))
        replays = os.path.join(folder, 'game', 'replays')
        kept_dir = os.path.join(replays, 'bullba_hits')
        for d in (replays, kept_dir):
            if not os.path.isdir(d): os.makedirs(d)
        own = os.path.join(replays, '20261114_2158_germany-G197_Pz_Kpfw_Neu_02_malinovka.wotreplay')
        other = os.path.join(replays, '20261114_2158_usa-A83_T110E4_02_malinovka.wotreplay')
        write_final(own, stream, header(roster, 'Bullba', '14.11.2026 21:58:12', own_id), cipher=True)
        write_final(other, stream, header(roster, 'SomeoneElse', '14.11.2026 21:58:13', own_id), cipher=True)
        shutil.copyfile(own, os.path.join(kept_dir, 'my_best_battle.wotreplay'))
        with open(os.path.join(replays, 'notes.wotreplay'), 'wb') as handle: handle.write(b'not a replay at all')
        shutil.copyfile(own, os.path.join(replays, 'temp.wotreplay'))
        stand = Stand(GAME, folder, '2.4.1.1')
        stand.recorder = None
        stand.replays_folder = replays
        stand.replay_defs()

        # list
        stand.request_replay_files()
        run_jobs(stand, ('replayfiles',))
        path = os.path.join(folder, 'data', replay_files.DATA_FILE + '.js')
        value = exporter.read_data_file(path) if os.path.isfile(path) else {}
        # (with --stage after playback_job.py: the battle REPLAY's replay_last_battle and its bh_ copy - one content, listed
        # once - are there too, tied to that battle)
        theirs_too = lambda f: f.get('file', '').startswith('bh_') or f.get('file') == 'replay_last_battle.wotreplay'
        files = [f for f in value.get('files') or [] if not theirs_too(f)]
        players = [f.get('player') for f in files]
        ok('list', len(files) == 2 and players == ['SomeoneElse', 'Bullba'], [(f.get('player'), f.get('file')) for f in files])
        tied = [f for f in value.get('files') or [] if theirs_too(f)]
        ok('list', all(f.get('battle') for f in tied), 'a replay of the replay limit not tied to its battle: %r' % tied)
        mine = [f for f in files if f.get('player') == 'Bullba']
        ok('list', mine and mine[0]['kept'] and mine[0]['file'] == 'bullba_hits/my_best_battle.wotreplay',
           'the own replay should be listed once, as the kept copy: %r' % mine)
        ok('list', value.get('broken') == ['notes.wotreplay'] and any('notes.wotreplay skipped' in l for l in lines.lines),
           (value.get('broken'), [l for l in lines.lines if 'skipped' in l]))
        ok('list', not any('temp.wotreplay' == f.get('file') for f in files), 'the game\'s growing file is listed')
        ok('list', {'kind': 'files', 'state': 'ready'} in list(stand.page_notes), list(stand.page_notes))
        stand.request_replay_files()
        run_jobs(stand, ('replayfiles',))
        ok('list', stand.files_work is None and [l for l in lines.lines if l.startswith('Replay files:')][-1:]
           and '(0 headers read, ' in [l for l in lines.lines if l.startswith('Replay files:')][-1],
           [l for l in lines.lines if l.startswith('Replay files:')])
        theirs = [f for f in files if f.get('player') == 'SomeoneElse'][0]
        file_id = theirs['id']

        # id
        moved = os.path.join(replays, 'renamed_by_hand.wotreplay')
        os.rename(other, moved)
        stand.request_replay_files()
        run_jobs(stand, ('replayfiles',))
        again = (exporter.read_data_file(path).get('files') or [])
        ok('id', [f['id'] for f in again if f.get('player') == 'SomeoneElse'] == [file_id]
           and [f['file'] for f in again if f.get('player') == 'SomeoneElse'] == ['renamed_by_hand.wotreplay'],
           [(f['id'], f['file']) for f in again])

        # record
        stand.page_notes.clear()
        queued = stand.request_playback(file_id)
        run_jobs(stand, ('playback',))
        made = playback.data_path(folder, file_id)
        battle = exporter.read_data_file(made) if os.path.isfile(made) else {}
        ok('record', queued and battle.get('format') == playback.FORMAT and not battle.get('error'),
           battle.get('error') or 'no file %s' % made)
        meta = battle.get('record') or {}
        ok('record', meta.get('map') == ARENA and meta.get('gameplay') == 'ctf' and meta.get('playerVehicleId') == own_id, meta)
        got = battle.get('roster') or []
        ok('record', len(got) == len(roster) and any(r.get('player') == 'SomeoneElse' for r in got)
           and all(r.get('maxHealth') for r in got), '%d of %d' % (len(got), len(roster)))
        source = battle.get('source') or {}
        with open(moved, 'rb') as handle: data = handle.read()
        ok('record', source.get('kind') == 'wotreplay' and source.get('size') == len(data)
           and source.get('crc') == zlib.crc32(data) & 0xffffffff, source)
        boxes_ = battle.get('boxes') or {}
        staged = set()
        for f in glob.glob(os.path.join(folder, 'data', 'vehicles', '*.js')):
            staged.update(p['resource'] for p in exporter.read_data_file(f).get('parts') or ()
                          if isinstance(p.get('id'), int) and p['id'] >= 0 and p.get('resource') and not p.get('prefab'))
        boxed = [r for r in staged if boxes_.get(r) and boxes_.get(r) == stand.part_box(r)]
        ok('record', staged and len(boxed) == len(staged), 'boxes from the model: %d of %d staged parts'
           % (len(boxed), len(staged)))
        listed = battle.get('vehicleFiles') or {}
        ok('record', MISSING.replace(':', '-') not in (listed.get('hits') or ()) and len(listed.get('hits') or ()) == 25, listed)
        ok('record', {'kind': 'playback', 'id': file_id, 'state': 'ready'} in list(stand.page_notes), list(stand.page_notes))
        ok('record', stand.request_playback(file_id) is False, 'a second request queued a job: the file is current')

        # modes (BACKLOG 112, 20.11.2026): special battle modes marked in the list and in the battle file
        ok('modes', 'special' not in (battle.get('record') or {}) and not any(f.get('special') for f in value.get('files') or ()),
           'a random battle marked special: %r' % [f.get('special') for f in value.get('files') or ()])
        cases = [((1, 'ctf'), None), ((14, 'domination'), None), ((22, 'ctf'), None), ((2, 'assault'), None),
                 ((None, None), None), ((None, 'ctf'), None), ((1, None), None), ((43, 'comp7'), None), ((5, 'ctf'), None), ((13, 'domination'), None), ((20, 'ctf'), None),
                 ((47, 'comp7'), None), ((27, 'epic'), 'Frontline'), ((24, 'ctf30x30'), 'Grand Battle'),
                 ((111, 'ctf'), 'battle type 111'), ((None, 'epic'), 'Frontline'), ((1, 'ctf30x30'), 'Grand Battle'),
                 (('27', u'epic'), 'Frontline')]
        got = [(a, (replay_files.special_mode(*a) or {}).get('name')) for a, _ in cases]
        ok('modes', all(g[1] == w for g, (a, w) in zip(got, cases)), got)
        special_dir = tempfile.mkdtemp(prefix='bullba-files-modes-')
        try:
            replays2 = os.path.join(special_dir, 'replays')
            os.makedirs(replays2)
            h = header(roster, 'Bullba', '15.11.2026 20:00:00', own_id)
            h.update({'battleType': 27, 'gameplayID': 'epic'})
            write_final(os.path.join(replays2, 'frontline.wotreplay'), stream, h, cipher=True)
            write_final(os.path.join(replays2, 'random.wotreplay'), stream, header(roster, 'Bullba', '16.11.2026 20:00:00', own_id), cipher=True)
            scan = replay_files.Scan(special_dir, replays2)
            for _ in scan.steps(): pass
            marks = dict((f['file'], f.get('special')) for f in scan.value['files'])
            ok('modes', marks.get('frontline.wotreplay') == {'name': 'Frontline', 'bonusType': 27, 'gameplay': 'epic'}
               and marks.get('random.wotreplay') is None and len(marks) == 2, marks)
        finally:
            shutil.rmtree(special_dir, True)
        # the repository's own replay fixtures, by their headers: how many the list marks special
        first_block = replay_files.first_block
        fixtures = []
        for root, _, names in os.walk(os.path.join(REPO, 'tests', 'fixtures-local')):
            fixtures.extend(os.path.join(root, n) for n in names if n.lower().endswith('.wotreplay'))
        heads = [first_block(p) for p in sorted(fixtures)]
        heads = [b for b in heads if b]
        marked = [replay_files.special_mode(b.get('battleType'), b.get('gameplayID')) for b in heads]
        mode_note = '%d of %d fixture replays special (%s)' % (len([m for m in marked if m]), len(heads),
                                                               ', '.join(sorted(m['name'] for m in marked if m)) or 'none')

        # vehicles
        types = sorted(set(r['type'] for r in roster))
        rows_ = [(t, 'AAAA' if t != MISSING else want.get('compactDescriptor')) for t in types]
        stand.page_notes.clear()
        stand.request_playback_vehicles({'battleId': file_id, 'vehicles': rows_})
        run_jobs(stand, ('vehicle', 'pbvehicles', 'model'))
        made = os.path.join(folder, 'data', 'playback', 'vehicles', MISSING.replace(':', '-') + '.js')
        veh = exporter.read_data_file(made) if os.path.isfile(made) else {}
        res = sorted(p.get('resource') for p in veh.get('parts') or () if p.get('resource'))
        want_res = sorted(p.get('resource') for p in want.get('parts') or () if p.get('resource'))
        ok('vehicles', res and res == want_res, (res, want_res))
        boxed = [p for p in veh.get('parts') or () if p.get('resource') and p.get('clientBox') == stand.part_box(p['resource'])
                 and p.get('clientBox')]
        ok('vehicles', len(boxed) == len(res), 'clientBox from the model on %d of %d parts' % (len(boxed), len(res)))
        models = [p.get('modelKey') for p in veh.get('parts') or () if p.get('resource')]
        ok('vehicles', models and all(os.path.isfile(os.path.join(folder, 'data', 'models', k + '.js')) for k in models), models)
        note = [n for n in stand.page_notes if n.get('kind') == 'vehicles']
        ok('vehicles', note and note[-1].get('id') == file_id
           and MISSING.replace(':', '-') in (note[-1].get('files') or {}).get('viewer', ()), note)
        ok('vehicles', not os.path.isfile(missing), 'the XML route wrote into data/vehicles')
        return checks, 'other player\'s replay %s, %d models of %s from the client XML; %s' % (file_id, len(models), MISSING, mode_note)
    finally:
        logging.getLogger('local.armor_inspector').removeHandler(lines)
        if keep is None: shutil.rmtree(folder, True)


def measure(replays):
    """The headers of a real replays folder, read only: one full scan with an empty cache, then one from the cache."""
    temp = tempfile.mkdtemp(prefix='bullba-files-measure-')
    try:
        out = []
        for label in ('cold', 'cached'):
            scan = replay_files.Scan(temp, replays)
            began = time.time()
            for _ in scan.steps(): pass
            out.append('%s %.3f s (%d read, %d cached)' % (label, time.time() - began, scan.read, scan.cached))
        files = replay_files.listing(replays)
        return 'replays folder %s: %d files, %.1f MB; headers %s; %d listed, %d skipped' % (
            replays, len(files), sum(f[2] for f in files) / 1e6, ', '.join(out), len(scan.value['files']), len(scan.broken))
    finally:
        shutil.rmtree(temp, True)


def main():
    if '--measure' in sys.argv:
        return finish([measure(sys.argv[sys.argv.index('--measure') + 1])], 0)
    if not os.path.isdir(FIXTURE) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no fixture %s or no client packages at %s' % (FIXTURE, GAME)], 77)
    started = time.time()
    try:
        checks, note = check()
    except Exception:
        return finish(['FAIL [run] the script crashed:\n' + traceback.format_exc()], 1)
    failed = [c for c in checks if not c[1]]
    lines = ['replay_files: %d checks, %d failed (%.1f s); %s' % (len(checks), len(failed), time.time() - started, note)]
    lines += ['FAIL %s -- %s' % (name, detail) for name, _, detail in failed]
    return finish(lines, 1 if failed else 0)


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if not isinstance(text, bytes) else text)
    else:
        sys.stdout.write(text)
    return code


if __name__ == '__main__':
    main()
