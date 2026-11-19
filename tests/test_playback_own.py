# -*- coding: utf-8 -*-
"""The player's own vehicle in a battle decoded from its replay stream: the user's case of 18.11.2026 (B17).

His battle on Karelia, 18.11.2026 02:05, STK-2 (vehicle id 2996243): the 3D replay player marked Black Rock (2996248,
a teammate) as his own, so the yellow row and marker were on the wrong tank. The stream has two packets 0x22
(`own_vehicle`): 2996243 at 0.0 s and 2996248 at 389.25 s - his vehicle's health reaches 0 at 354.85 s, and after his
death the client's camera follows the ally he watches, which 0x22 names. A builder that kept the last 0x22 took the
watched ally. The player's vehicle is the first 0x22 (the battle record's live playerVehicleId agrees).

    python -m pytest tests/test_playback_own.py -q

Checked here, on his kept stream (tests/fixtures-local/own-vehicle-2026-11-18, copied from the game's
mods/configs/local.armor_inspector/replay/; local, not in git: it carries nicknames):
  events    the 0x22 packets and his death, as above (the mechanism)
  product   the page's battle builder (web/playback/battle.js Collector, since 19.11; the mod's definitions file) on the
            kept stream.z -> meta.own and the one vehicle marked own = the record's playerVehicleId
  records   replay_records.convert (the product's hits from a replay) -> the battle record's playerVehicleId the same
  trial     work/map-playback/build.py build_battle -> meta.own and the one vehicle marked own the same
No fixture or no client: SKIP.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'mod'))
from local_armor_inspector import replay_stream as rd  # noqa: E402
from local_armor_inspector import replay_records as rr  # noqa: E402
from local_armor_inspector import replay_objects as rc  # noqa: E402
from local_armor_inspector import playback  # noqa: E402

FIXTURE = os.path.join(ROOT, 'tests', 'fixtures-local', 'own-vehicle-2026-11-18')
BATTLE = '6293116726103588-d97689b2b162'
TRIAL = os.path.join(ROOT, 'work', 'map-playback')
_CACHE = {}


def ready():
    return (os.path.isfile(os.path.join(FIXTURE, BATTLE + '.stream.z'))
            and os.path.isdir(os.path.join(rd.DEFAULT_CLIENT, 'res', 'packages')))


def record():
    with open(os.path.join(FIXTURE, BATTLE + '.battle.json'), 'rb') as handle:
        return json.loads(handle.read().decode('utf-8'))


def stream():
    if 'stream' not in _CACHE:
        with open(os.path.join(FIXTURE, BATTLE + '.stream.z'), 'rb') as handle:
            _CACHE['stream'] = bytearray(zlib.decompress(handle.read()))
    return _CACHE['stream']


def events():
    if 'events' not in _CACHE:
        client = rd.Client()
        _CACHE['client'], _CACHE['defs'] = client, rd.Defs(client)
        _CACHE['names'] = client.vehicle_names()
        _CACHE['events'] = list(rd.Decoder(_CACHE['defs']).decode(stream()))
    return _CACHE['events']


NODE = os.path.expanduser('~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
# argv: battle.js, the folder with defs.json and info.json, the stream.z; prints {own, marked}
BUILD_JS = r'''
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [js, folder, src] = process.argv.slice(1);
const B = require(js);
B.setInflate((b) => Promise.resolve(new Uint8Array(zlib.inflateSync(b))));
const defs = JSON.parse(fs.readFileSync(path.join(folder, 'defs.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(folder, 'info.json'), 'utf8'));
info.roster = [];
B.source('zlib', new Uint8Array(fs.readFileSync(src)), info.id).then((stream) => {
  const b = B.build(defs, info, stream).battle;
  console.log(JSON.stringify({own: b.meta.own, marked: b.vehicles.filter((v) => v.own).map((v) => v.id)}));
});
'''


@unittest.skipUnless(ready(), 'the kept stream of 18.11 (tests/fixtures-local/own-vehicle-2026-11-18) or the client is absent')
class OwnVehicle(unittest.TestCase):
    PLAYER = 2996243
    WATCHED = 2996248

    def test_events(self):
        own = [(round(e.get('t') or 0.0, 2), e.get('vehicleId')) for e in events() if e.get('ev') == 'own_vehicle']
        self.assertEqual(own, [(0.0, self.PLAYER), (389.25, self.WATCHED)])
        death = [round(e['t'], 2) for e in events() if e.get('ev') == 'property' and e.get('id') == self.PLAYER
                 and e.get('name') == 'health' and (e.get('value') or 0) <= 0]
        self.assertEqual(death[:1], [354.85])
        self.assertEqual(record()['playerVehicleId'], self.PLAYER)

    def test_product(self):
        """The page's path (19.11): the mod's definitions file, the page's decoder and battle builder (web/playback/
        decoder.js, battle.js) under node on the kept stream.z as the mod hands it over -> meta.own and the one vehicle
        marked own."""
        node = next((p for p in (os.environ.get('BULLBA_NODE'), shutil.which('node'), NODE) if p and os.path.isfile(p)), None)
        if node is None: self.skipTest('node not found: set BULLBA_NODE to node.exe')
        events()
        defs = playback.definitions_value(_CACHE['defs'], rc.Registry(_CACHE['client'], _CACHE['defs']), _CACHE['names'], [])
        info = {'id': BATTLE, 'record': {'playerVehicleId': record()['playerVehicleId']}, 'roster': [], 'boxes': {}}
        folder = tempfile.mkdtemp()
        try:
            with open(os.path.join(folder, 'defs.json'), 'w') as handle: json.dump(defs, handle)
            with open(os.path.join(folder, 'info.json'), 'w') as handle: json.dump(info, handle)
            run = subprocess.run([node, '-e', BUILD_JS, os.path.join(ROOT, 'web', 'playback', 'battle.js'), folder,
                                  os.path.join(FIXTURE, BATTLE + '.stream.z')], capture_output=True, text=True, timeout=120)
        finally:
            shutil.rmtree(folder, True)
        self.assertEqual(run.returncode, 0, run.stderr[-800:])
        out = json.loads(run.stdout.strip().splitlines()[-1])
        self.assertEqual(out['own'], record()['playerVehicleId'])
        self.assertEqual(out['marked'], [record()['playerVehicleId']])

    def test_records(self):
        events()
        out, stats = rr.convert(iter(events()), vehicle_names=_CACHE['names'])
        battle = [r for r in out if r.get('type') == 'battle']
        self.assertEqual([r.get('playerVehicleId') for r in battle], [record()['playerVehicleId']])

    def test_trial(self):
        try:
            import numpy  # noqa: F401  (the trial's builder needs it)
        except ImportError:
            self.skipTest('numpy is absent: the trial builder cannot run')
        if not os.path.isfile(os.path.join(TRIAL, 'build.py')):
            self.skipTest('the trial work/map-playback is absent')
        sys.path.insert(0, TRIAL)
        import build
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, BATTLE + '.stream')
        try:
            with open(path, 'wb') as handle:
                handle.write(bytes(stream()))
            battle, _ = build.build_battle(path, build.Sizes(), None)
        finally:
            os.remove(path)
            os.rmdir(folder)
        self.assertEqual(battle['meta']['own'], record()['playerVehicleId'])
        self.assertEqual([v['id'] for v in battle['vehicles'] if v['own']], [record()['playerVehicleId']])


if __name__ == '__main__':
    unittest.main()
