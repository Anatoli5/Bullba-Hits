"""What the mod hands the 3D replay player for a battle (BACKLOG 104, 18.11.2026; since 19.11 the page builds the battle
from it), under the client's own Python 2.7.

    python tests/py27/run27.py tests/py27/playback_job.py                 the check (tools/check.py runs it)
    python tests/py27/run27.py tests/py27/playback_job.py --stage DIR     the same, the staged folder kept in DIR (an empty
                                                                          or new folder), plus a second battle REPLAY whose
                                                                          source is a .wotreplay (the fixture's stream
                                                                          encrypted, renamed by the replay limit):
                                                                          tests/page/playback_page.cjs opens both

The user's battle of 14.11 on Malinovka, 217 s of replay: 49 shots, 44 hit points, 196 destroyed items (counted
18.11) (tests/fixtures-local/playback-2026-11-18: its record, its kept replay stream and
stored records, the vehicle and model files of its roster - copies, the game's folder is only read) staged as a config
folder; the exporter's own path runs on it: request_playback queues the 'playback' job, run_job runs it in slices
(playback.Job: the source handed over as it is kept, the client's definitions file, the map's raw files copied from the
client's packages - read only -, the battle file last). Checks:

  queue     the page's request queues one job at the page's priority; a second request while it is queued adds none
  file      data/playback/<id>.js of playback.FORMAT: the record's map and mode, the roster of 30 with nicknames, the
            part boxes; its source file holds the kept stream.z byte for byte (kind, size and CRC said); its definitions
            file holds the decoder's entities, the vehicle names and the damage sticker kinds
  replay    a second battle REPLAY from a .wotreplay: its source file holds that replay byte for byte
  drop      that second request removed the first battle's source file; its battle file stays
  notes     the page is told (Exporter.notify_page, 19.11): the battle file made; the map's copy queued, its stage, ready
  map       the page's 'mapRaw' (19.11; the playback job copies no map): mapraw/<arena>/manifest.js of
            map_raw.MANIFEST_VERSION and its parts, every resource in a part (no per-resource file, no mapraw/res); the
            rock shader's textures among them (Malinovka's cliffs - a texture kept from the level where its atlas cell is
            128 px, map_raw.rock_textures); LODs the builder only counts copied in part (sparse ranges)
  held      the same map asked for with the page's digest of products it holds (here every havok file's 'hav' product):
            those resources listed held, not copied; a raw set there already: the page told at once, nothing queued
  report    the page's report of an opening (playback_report): a map read from IndexedDB that was built in this game
            session keeps its raw set; one built before this session started removes it (without --stage)
  current   once made, a request queues nothing (the file is there)
  slices    no slice longer than SLICE_LIMIT seconds (the job's own BATTLE_SLICE plus one step; in the game the export
            thread shares the interpreter with the game, the stand does not)

No fixture or no client packages: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18')
BATTLE = '2315856430906286521-d36eff9b31bb'
REPLAY = '2315856430906286521-0000000000aa'    # the same battle from a .wotreplay (--stage only; the arena id kept)
ARENA = '02_malinovka'
RESULT = os.environ.get('BULLBA_PY27_RESULT')
# The longest slice allowed on the stand: BATTLE_SLICE (0.1 s) plus the longest single step measured here (a resource
# walk of one object, a vehicle type's collision model) with room for a slow core.
SLICE_LIMIT = 0.6
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import exporter, playback, map_raw


def stage(folder):
    for sub in ('battles', 'replay', os.path.join('data', 'vehicles'), os.path.join('data', 'models')):
        source = os.path.join(FIXTURE, sub)
        target = os.path.join(folder, sub)
        if not os.path.isdir(target): os.makedirs(target)
        for name in os.listdir(source):
            shutil.copyfile(os.path.join(source, name), os.path.join(target, name))


class Stand(exporter.Exporter):
    """The exporter's queue and job path on a staged folder: no setup (no package of the mod, no client snapshot), the
    session's definitions by the decoder's own package scan (replay_run.Definitions without a snapshot)."""

    def client(self):
        return None


def source_matches(folder, name, value, kind, original):
    """The battle file's source: of `kind`, size and CRC those of `original`, its source file `original` in base64."""
    import base64, zlib
    source = value.get('source') or {}
    with open(original, 'rb') as handle: data = handle.read()
    path = playback.source_path(folder, name)
    held = exporter.read_data_file(path) if os.path.isfile(path) else None
    return (source.get('kind') == kind and source.get('size') == len(data) and source.get('crc') == zlib.crc32(data) & 0xffffffff
            and source.get('file') == os.path.basename(path) and held is not None and base64.b64decode(held) == data)


def definitions(folder, value):
    path = playback.data_path(folder, value.get('defs') or 'none')
    return exporter.read_data_file(path) if os.path.isfile(path) else None


def replay_battle(stand, folder, ok, staging):
    """The second battle REPLAY: the fixture's stream encrypted into a .wotreplay (replay_library.write_final), renamed by
    the replay limit, its record and stored records under the new id, no stream.z; its files made, BATTLE's source file
    removed by that request, its battle file kept. `staging`: BATTLE's source put back afterwards for the page test (the
    stage has no mod to write it again)."""
    first_source = playback.source_path(folder, BATTLE)
    kept_aside = first_source + '.stage'
    if staging: shutil.copyfile(first_source, kept_aside)
    import zlib
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from replay_library import write_final
    from local_armor_inspector import replay_library as rl
    replays = os.path.join(folder, 'game', 'replays')
    if not os.path.isdir(replays): os.makedirs(replays)
    for sub, ext in (('battles', '.jsonl'), ('replay', '.records.z')):
        shutil.copyfile(os.path.join(folder, sub, BATTLE + ext), os.path.join(folder, sub, REPLAY + ext))
    with open(os.path.join(FIXTURE, 'replay', BATTLE + '.stream.z'), 'rb') as handle: stream = zlib.decompress(handle.read())
    final = os.path.join(replays, 'replay_last_battle.wotreplay')
    started = time.time()
    write_final(final, bytearray(stream), {'dateTime': '14.11.2026 21:58:12', 'mapName': ARENA}, cipher=True)
    encrypted = time.time() - started
    library = rl.Library(replays, folder)
    library.set_mode(True, 50)
    copy = library.add(REPLAY, final, started, REPLAY.split('-', 1)[0])
    stand.replays_folder = replays
    stand.request_playback(REPLAY)
    began = time.time()
    while any(j[2] == 'playback' for j in stand.jobs) and time.time() - began < 120:
        stand.last_job = 0
        stand.run_job()
    path = playback.data_path(folder, REPLAY)
    value = exporter.read_data_file(path) if os.path.isfile(path) else {}
    ok('replay', not value.get('error') and copy and source_matches(folder, REPLAY, value, 'wotreplay', copy),
       repr(value.get('error') or value.get('source')))
    ok('drop', not os.path.exists(first_source) and os.path.isfile(playback.data_path(folder, BATTLE))
       and os.path.isfile(playback.source_path(folder, REPLAY)),
       'after the second request: %r' % sorted(os.listdir(os.path.dirname(first_source))))
    if staging: os.rename(kept_aside, first_source)
    return 'REPLAY: the stream encrypted in %.1f s' % encrypted


def check():
    checks = []

    def ok(name, value, detail=''):
        checks.append((name, bool(value), detail))
        return bool(value)

    args = sys.argv[1:]
    keep = args[args.index('--stage') + 1] if '--stage' in args else None
    folder = keep or tempfile.mkdtemp(prefix='bullba-playback-')
    if not os.path.isdir(folder): os.makedirs(folder)
    try:
        stage(folder)
        stand = Stand(GAME, folder, '2.4.1.1')
        stand.recorder = None
        # The session's definitions first, as the game builds them in the hangar at setup ('definitions' job): here by the
        # decoder's package scan, seconds in one go - not a part of the job's slices.
        stand.replay_defs()
        queued = stand.request_playback(BATTLE)
        again = stand.request_playback(BATTLE)
        jobs = [j for j in stand.jobs if j[2] == 'playback']
        ok('queue', queued and len(jobs) == 1 and jobs[0][0] == exporter.JOB_PAGE,
           'queued %r, jobs %r' % (queued, [(j[0], j[2], j[3]) for j in stand.jobs]))
        ok('queue', len([j for j in stand.jobs if j[2] == 'playback']) == 1, 'the second request added a job: %r' % again)
        longest, slices, began = 0.0, 0, time.time()
        while any(j[2] == 'playback' for j in stand.jobs):
            stand.last_job = 0
            started = time.time()
            stand.run_job()
            spent = time.time() - started
            longest = max(longest, spent)
            slices += 1
            if time.time() - began > 170: break
        path = playback.data_path(folder, BATTLE)
        value = exporter.read_data_file(path) if os.path.isfile(path) else None
        ok('file', isinstance(value, dict) and value.get('format') == playback.FORMAT and not value.get('error'),
           'file %s: %s' % (path, (value or {}).get('error') if isinstance(value, dict) else value))
        if isinstance(value, dict) and not value.get('error'):
            ok('file', value['record']['map'] == ARENA and value['record']['gameplay'] == 'ctf', value['record'])
            roster = value.get('roster') or []
            ok('file', len(roster) == 30 and any(r.get('player') for r in roster) and len(value.get('boxes') or {}) > 10,
               'roster %d, boxes %d' % (len(roster), len(value.get('boxes') or {})))
            ok('file', source_matches(folder, BATTLE, value, 'zlib', os.path.join(FIXTURE, 'replay', BATTLE + '.stream.z')),
               repr(value.get('source')))
            defs = definitions(folder, value)
            ok('file', defs and 'Vehicle' in defs['schema']['entitySpecs'] and len(defs['vehicleNames']) > 500
               and len(defs['stickers']) >= 20, 'definitions %s' % (sorted(defs) if defs else defs))
            ok('file', value['record'].get('client'), 'no client version in the record %r' % value['record'])
        ok('notes', {'kind': 'playback', 'id': BATTLE, 'state': 'ready'} in list(stand.page_notes), list(stand.page_notes))
        ok('map', not os.path.isdir(os.path.join(playback.raw_root(folder), ARENA)), 'the playback job copied the map')
        root = playback.raw_root(folder)
        took = {}

        def map_job(payload):
            stand.page_notes.clear()
            queued = stand.request_map_raw(payload)
            longest_, slices_, t0 = 0.0, 0, time.time()
            while any(j[2] == 'mapraw' for j in stand.jobs):
                stand.last_job = 0
                started = time.time()
                stand.run_job()
                longest_ = max(longest_, time.time() - started)
                slices_ += 1
                if time.time() - t0 > 170: break
            took.update(seconds=time.time() - t0, slices=slices_, longest=longest_)
            return queued

        def manifest_of():
            path = map_raw.manifest_path(root, ARENA)
            text = open(path, 'rb').read().decode('utf-8') if os.path.isfile(path) else ''
            return json.loads(text[len('MapRaw.manifest('):text.rindex(')')]) if text.startswith('MapRaw.manifest(') else {}
        queued = map_job({'arena': ARENA})
        notes = list(stand.page_notes)
        ok('notes', queued and notes and notes[0].get('state') == 'queued' and notes[-1] == {'kind': 'map', 'arena': ARENA, 'state': 'ready'}
           and any(n.get('state') == 'copying' and n.get('stage') for n in notes), notes)
        man = manifest_of()
        parts, entries = man.get('parts') or [], man.get('res') or []
        ok('map', man.get('version') == map_raw.MANIFEST_VERSION and parts
           and all(os.path.isfile(os.path.join(root, ARENA, p)) for p in parts), 'manifest %r, parts %r' % (man.get('version'), parts))
        ok('map', len(entries) > 100 and all(isinstance(e.get('part'), int) and e['part'] < len(parts) and e.get('name') for e in entries)
           and not os.path.isdir(os.path.join(root, 'res')), '%d resources, %d without a part' % (len(entries), len([e for e in entries if not isinstance(e.get('part'), int)])))
        ok('map', any(e.get('slice') for e in entries), 'no rock texture copied at its cell level among %d resources' % len(entries))
        ok('map', any(e.get('sparse') for e in entries), 'no LOD copied in part among %d resources' % len(entries))
        written = sum(os.path.getsize(os.path.join(root, ARENA, n)) for n in os.listdir(os.path.join(root, ARENA)))
        nfiles = len(os.listdir(os.path.join(root, ARENA)))
        first = dict(took)
        # held: the havok files' products said held - listed, not copied
        import array, base64
        havok = [e for e in entries if e['path'].endswith('.havok')]
        keys = array.array('I', [map_raw.fnv(u'hav|%s|%d|p2' % (e['path'], e['crc'])) for e in havok])
        held_text = base64.b64encode(getattr(keys, 'tobytes', getattr(keys, 'tostring', None))()).decode('ascii')
        ok('held', stand.request_map_raw({'arena': ARENA, 'held': held_text, 'resv': 'p2'}) is False and not stand.jobs
           and list(stand.page_notes)[-1].get('state') == 'ready', 'a request with the raw set there queued %r' % stand.jobs)
        map_raw.remove_set(root, ARENA)
        map_job({'arena': ARENA, 'held': held_text, 'resv': 'p2'})
        man2 = manifest_of()
        held = [e for e in man2.get('res') or [] if e.get('held')]
        ok('held', havok and len(held) == len(havok) and all('part' not in e for e in held) and all(e['path'].endswith('.havok') for e in held),
           'held %d of %d havok files' % (len(held), len(havok)))
        # the page's report
        built_now = (stand.session_started + 5) * 1000.0
        line = {'battleId': BATTLE, 'map': ARENA, 'mapFrom': 'IndexedDB', 'battleFrom': 'IndexedDB', 'waitMod': 0, 'loadRaw': 0,
                'buildMap': 0, 'buildBattle': 0.1, 'total': 2.5, 'webgl': True}
        line['mapBuiltAt'] = built_now
        ok('report', stand.playback_report(line) == 'kept' and os.path.isdir(os.path.join(root, ARENA)), 'a map built in this session lost its raw set')
        if keep is None:
            line['mapBuiltAt'] = (stand.session_started - 3600) * 1000.0
            ok('report', stand.playback_report(line) == 'removed' and not os.path.isdir(os.path.join(root, ARENA)),
               'a map built before this session kept its raw set')
        else:   # the page test builds from the whole set
            map_raw.remove_set(root, ARENA)
            map_job({'arena': ARENA})
        ok('current', stand.request_playback(BATTLE) is False and not stand.jobs, 'a request after the file was made queued %r' % stand.jobs)
        ok('slices', longest <= SLICE_LIMIT and first['longest'] <= SLICE_LIMIT, 'the longest of %d slices took %.3f s; of the map %d, %.3f s'
           % (slices, longest, first['slices'], first['longest']))
        made = (value or {}).get('made') or {}
        note = 'made in %d slices, %.1f s; work %r; map copied in %.2f s (%d slices, the longest %.3f s), %.1f MB written in %d files' % (
            slices, time.time() - began, made.get('seconds'), first['seconds'], first['slices'], first['longest'], written / 1e6, nfiles)
        note += '; ' + replay_battle(stand, folder, ok, keep is not None)
        return checks, note
    finally:
        if keep is None: shutil.rmtree(folder, True)


def main():
    if not os.path.isdir(FIXTURE) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no fixture %s or no client packages at %s' % (FIXTURE, GAME)], 77)
    started = time.time()
    try:
        checks, note = check()
    except Exception:
        return finish(['FAIL [run] the script crashed:\n' + traceback.format_exc()], 1)
    failed = [c for c in checks if not c[1]]
    lines = ['playback_job: %d checks, %d failed (%.1f s); %s' % (len(checks), len(failed), time.time() - started, note)]
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
