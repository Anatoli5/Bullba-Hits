# -*- coding: utf-8 -*-
"""The client's part box computed from the model (geometry.client_box) and the replay viewer's battle file taking it
(playback.Job.model_boxes_steps), under the client's own Python 2.7 (runs under CPython 3 as well).

    python tests/py27/run27.py tests/py27/part_boxes.py

The defect of 19.11 (builds 1.12, 1.13, the game's log: "Part boxes of the client: 0 read from 1498 types"): the
harvest read hitTester.bbox, which only a battle sets, so a replay's vehicles got the vertex box - up to 0.81 m off.
The box is the HKBodyFlagsData bounds of the part's own .havok (WoT-Base KNOWLEDGE-client).

Checked:
  model     every model whose exact client box the user's records held (BULLBA_BOXES, default
            tests/fixtures-local/part-boxes-2026-11-19/part-boxes.json: hit points' partBounds and replay-store bounds of
            client 2.4.1.1, tools/part_boxes_seed.py): the box computed from its .havok equals it, every float
  vehicles  the fixture's 26 vehicle files (tests/fixtures-local/playback-2026-11-18): every static part gets its box
            through Job.model_boxes_steps; the fixture's stored boxes agree; a part with a box in the vehicle file takes
            it; one with none and no model box is left to the page's vertex box and counted
The number: models equal / models with a known box, and vehicles with every static part boxed. No client packages or
no fixture: that part SKIPPED. Verdict through BULLBA_PY27_RESULT.
"""
import glob
import io
import json
import os
import sys
import traceback
import zipfile

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
BOXES = os.environ.get('BULLBA_BOXES', os.path.join(REPO, 'tests', 'fixtures-local', 'part-boxes-2026-11-19',
                                                    'part-boxes.json'))
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'playback-2026-11-18')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.path.insert(0, os.path.join(REPO, 'mod'))
sys.dont_write_bytecode = True

from local_armor_inspector import geometry, playback

failures = []
lines = []


def check(what, ok, detail=''):
    if not ok:
        failures.append('%s %s' % (what, detail))


def havok_index():
    out = {}
    for pkg in sorted(glob.glob(os.path.join(GAME, 'res', 'packages', 'vehicles_level_*.pkg'))
                      + glob.glob(os.path.join(GAME, 'res', 'packages', 'shared_content*.pkg'))):
        z = zipfile.ZipFile(pkg)
        for name in z.namelist():
            if name.endswith('.havok') and '/collision_client/' in name:
                out[name.lower()] = (z, name)
    return out


def model_box(index, resource):
    entry = index.get((resource[:-len('.model')] + '.havok').lower())
    return geometry.client_box(entry[0].read(entry[1])) if entry else None


def load_js(path):
    with io.open(path, encoding='utf-8') as f:
        t = f.read()
    return json.loads(t[t.index('(') + 1:t.rindex(')')])[1]


def test_model(index):
    if not os.path.isfile(BOXES):
        lines.append('model: SKIPPED (no %s)' % BOXES)
        return
    with io.open(BOXES, encoding='utf-8') as f:
        known = json.load(f)['boxes']
    equal, differ, missing = 0, [], 0
    for resource, box in sorted(known.items()):
        got = model_box(index, resource)
        if got is None: missing += 1
        elif got == [float(v) for v in box]: equal += 1
        else: differ.append(resource)
    check('model box = the client box', equal == len(known), '%d equal, %d differ %r, %d without a .havok'
          % (equal, len(differ), differ[:3], missing))
    lines.append('model: the box from the .havok = the client\'s recorded box for %d of %d models (%d differ, %d without '
                 'a .havok)' % (equal, len(known), len(differ), missing))


class Defs(object):
    """Exporter.part_box stood in for by the same computation (the real one: tests/py27/replay_files.py)."""
    version = 'stand'

    def __init__(self, index, none=()):
        self.index, self.none, self.asked = index, set(none), []

    def part_box(self, resource, version=None):
        self.asked.append(resource)
        return None if resource in self.none else model_box(self.index, resource)


def test_vehicles(index):
    files = sorted(glob.glob(os.path.join(FIXTURE, 'data', 'vehicles', '*.js')))
    if not files:
        lines.append('vehicles: SKIPPED (no %s)' % FIXTURE)
        return
    docs = [load_js(f) for f in files]
    statics = lambda d: [p['resource'] for p in d.get('parts', ()) if isinstance(p.get('id'), int) and p['id'] >= 0
                         and p.get('resource') and not p.get('prefab')]
    roster = {'vehicles': [{'type': d.get('type')} for d in docs] + [{'type': 'usa:NoSuchTank'}, {'type': None}]}
    job = playback.Job(FIXTURE, GAME, 'stand', Defs(index))
    got = {}
    for _ in job.model_boxes_steps(roster, got): pass
    full = sum(1 for d in docs if statics(d) and all(r in got for r in statics(d)))
    parts = sum(len(statics(d)) for d in docs)
    check('vehicles: every static part boxed', full == len(docs), '%d of %d' % (full, len(docs)))
    check('vehicles: counts', job.box_counts.get('parts from the model') == len(set(r for d in docs for r in statics(d)))
          and job.box_counts.get('types without a vehicle file') == 1, repr(job.box_counts))
    stored = playback.part_boxes(FIXTURE, '2315856430906286521-d36eff9b31bb')
    both = [r for r in stored if r in got]
    agree = sum(1 for r in both if got[r] == [float(v) for v in stored[r]])
    check('vehicles: the stored boxes agree', both and agree == len(both), '%d of %d' % (agree, len(both)))
    lines.append('vehicles: %d of %d fixture vehicles have the client box of every static part (%d parts, %s); the '
                 'battle\'s stored boxes: %d of %d of these models equal' % (full, len(docs), parts, job.box_counts,
                                                                          agree, len(both)))
    # a stored box stays; a vehicle file's clientBox is taken without asking; a model with no box is left and counted
    first = statics(docs[0])
    keep = {first[0]: [9.0, 9.0, 9.0, 10.0, 10.0, 10.0]}
    defs = Defs(index, none=set(first[2:]))
    job = playback.Job(FIXTURE, GAME, 'stand', defs)
    for _ in job.model_boxes_steps({'vehicles': [{'type': docs[0]['type']}]}, keep): pass
    check('a stored box stays', keep[first[0]] == [9.0, 9.0, 9.0, 10.0, 10.0, 10.0])
    check('no box: left to the vertex box', all(r not in keep for r in first[2:])
          and job.box_counts.get('parts left to the vertex box') == len(first) - 2, repr(job.box_counts))
    folder = os.path.join(os.environ.get('TEMP', '/tmp'), 'bullba-part-boxes')
    vehicles = os.path.join(folder, 'data', 'vehicles')
    if not os.path.isdir(vehicles): os.makedirs(vehicles)
    doc = dict(docs[0])
    doc['parts'] = [dict(p, clientBox=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]) if p.get('resource') == first[1] else p
                    for p in docs[0]['parts']]
    from local_armor_inspector.exporter import write_data, vehicle_id
    write_data(os.path.join(vehicles, vehicle_id(doc['type']) + '.js'), 'vehicle:x', doc)
    defs = Defs(index)
    job = playback.Job(folder, GAME, 'stand', defs)
    out = {}
    for _ in job.model_boxes_steps({'vehicles': [{'type': doc['type']}]}, out): pass
    check('the vehicle file\'s clientBox taken', out.get(first[1]) == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
          and first[1] not in defs.asked and job.box_counts.get('parts from the vehicle file') == 1, repr(job.box_counts))


def main():
    index = havok_index() if os.path.isdir(os.path.join(GAME, 'res', 'packages')) else None
    if index is None:
        lines.append('SKIPPED: no client packages at %s' % GAME)
    else:
        for test in (test_model, test_vehicles):
            try:
                test(index)
            except Exception:
                failures.append(traceback.format_exc())
    text = '\n'.join(['part boxes: %s' % ('%d failures' % len(failures) if failures else 'all checks pass')] + lines
                     + failures)
    if RESULT:
        with open(RESULT, 'w') as stream:
            stream.write('exit %d\n%s\n' % (1 if failures else 0, text))
    else:
        print(text)
        sys.exit(1 if failures else 0)


main()
