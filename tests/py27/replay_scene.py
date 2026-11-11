# -*- coding: utf-8 -*-
"""The hit scene rebuilt from the replay (replay_scene.py) inside the client's own Python 2.7 and items package.

    python tests/py27/run27.py tests/py27/replay_scene.py            the check (the 02.11 17:42 battle)
    python tests/py27/run27.py tests/py27/replay_scene.py update     write the statics table of the six battles

On the offline stand of the client's items package (tests/fixtures-local/ttx-offline) the mod's own
exporter.scene_statics reads every target's descriptor - the part stacking, the gun's absolute pitch limits, each static
part's live armour - which tests/test_replay_scene.py (CPython 3, no client modules) takes from STATICS, the table this
writes with 'update'. Offline the hit testers are stubs, so a part's model resource is read from the vehicle XML (as
models_run.py of the stand does) and the client's box (hitTester.bbox) is absent: the scene takes the recovered box.

The check, on the largest battle (17:42, 129 replay hits): the statics of its targets equal the table; the battle's
scenes are rebuilt under this Python with the models extracted from the client's packages by the exporter's own
model_extract, and their numbers equal what CPython gets (the point within 1 cm, incidence, armour, counts); the cost of
the work per battle under Python 2.7 is printed: the poses kept while converting, the rebuild of every scene.
Local fixtures, the client or the stand absent: SKIP (exit 77). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import json, os, shutil, sys, tempfile, time, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
UPDATE = 'update' in sys.argv[1:]
CHECKED = '1755080049627192'
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


def xml_resources(xmls, descr):
    """{part name: collision resource} from the vehicle XML (the stand's hit testers are stubs)."""
    nation, name = str(descr.type.name).split(':')
    tree = xmls.xml('scripts/item_defs/vehicles/%s/%s.xml' % (nation, name))
    chassis = tree.find('chassis/' + descr.chassis.name)
    turret = tree.find('turrets0/' + descr.turret.name)
    found = {'hull':tree.findtext('hull/hitTester/collisionModelClient'),
             'turret':turret.findtext('hitTester/collisionModelClient') if turret is not None else None,
             'gun':turret.findtext('guns/' + descr.gun.name + '/hitTester/collisionModelClient') if turret is not None else None}
    testers = [x.findtext('collisionModelClient') for x in (chassis.findall('hitTester') if chassis is not None else [])]
    found['chassis'] = testers[0] if testers else None
    for k in range(1, len(testers)): found['trackPair%d' % k] = testers[k]
    return dict((k, (v or '').strip() or None) for k, v in found.items())


def statics_of(exporter, xmls, compact):
    descr = exporter.vehicle_descr(compact)
    value = exporter.scene_statics(descr)
    resources = xml_resources(xmls, descr)
    for part in value['parts']:
        part['resource'] = resources.get(part['name'])
        part.pop('bounds', None)   # a stub's attribute on the stand, never the client's box
    return plain(value)


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
    import logging
    logging.getLogger('local.armor_inspector').addHandler(logging.NullHandler())
    import test_replay_battle as T
    import test_replay_scene as S
    from local_armor_inspector import replay_records as rr, replay_battle as rb, replay_scene as rs, exporter
    from local_armor_inspector.armor import ArmorCatalog
    xmls = ArmorCatalog(GAME)
    table = S.statics_table() or {}
    battles = T.FOUR + T.KILL_CAM if UPDATE else [b for b in T.FOUR if b[1] == CHECKED]
    clock = getattr(time, 'clock')
    new = {}
    for name, arena, folder in battles:
        d = t.defs()
        blocks, stream = t.rd.read_any(os.path.join(folder, name))
        started = clock()
        plain_records = rr.convert(t.rd.Decoder(d).decode(stream), header=blocks[0] if blocks else None,
                                   vehicle_names=t._CACHE['names'])[0]
        without = clock() - started
        started = clock()
        records = rr.convert(t.rd.Decoder(d).decode(stream), header=blocks[0] if blocks else None,
                             vehicle_names=t._CACHE['names'], poses=True)[0]
        with_poses = clock() - started
        poses = records[-1]
        check(poses.get('type') == 'poses' and plain(records[:-1]) == plain(plain_records),
              '%s: poses=True adds one poses record after the same records' % name)
        targets = set(r.get('targetId') for r in records if r.get('type') == 'hit')
        compacts = sorted(set(poses['compact'][v] for v in targets if v in poses['compact']))
        for compact in compacts: new[compact] = statics_of(exporter, xmls, compact)
        if UPDATE: continue
        same = [c for c in compacts if table.get(c) == new[c]]
        check(len(same) == len(compacts), '%s: the statics of its %d target descriptors equal the table' % (name, len(compacts)),
              ', '.join(c[:12] for c in compacts if c not in same))
        live = exporter.read_battle(t.live_path(arena))
        battle, report = rb.build(records, live)
        source = S.make_source(table)
        for compact in compacts:
            for part in table[compact]['parts']:
                if part.get('resource'): source.model(part['resource'])
        started = clock()
        stats = rs.attach(battle, poses, live, S.make_source(table))
        rebuild = clock() - started
        shutil.rmtree(S.model_exporter().folder, ignore_errors=True)
        digest = S.digest(battle)
        expected = S.expected_digest(arena)
        check(expected is None or digest == expected, '%s: the scenes rebuilt under Python 2.7 give the numbers CPython gets'
              % name, repr((digest, expected)))
        lines.append('%s under Python 2.7: conversion %.1f s without poses, %.1f s with them (+%.2f s); %d scenes rebuilt '
                     'in %.2f s (%d points; model files read and collisions, the models already extracted) - %r'
                     % (name, without, with_poses, with_poses - without, stats['made'], rebuild,
                        sum(len(h['replayScene']['points']) for h in battle['hits'] if 'replayScene' in h), stats))
    if UPDATE:
        path = S.STATICS
        folder = os.path.dirname(path)
        if not os.path.isdir(folder): os.makedirs(folder)
        merged = dict(table)
        merged.update(new)
        with open(path, 'wb') as stream: stream.write(json.dumps(merged, indent=0, sort_keys=True).encode('utf-8'))
        lines.append('written %s: %d descriptors' % (path, len(merged)))
    return 1 if failures else 0


try:
    code = main()
except Exception:
    lines.append('FAIL exception\n' + traceback.format_exc())
    failures.append('exception')
    code = 1
lines.append('%d checks, %d failed' % (len([l for l in lines if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
finish(code)
