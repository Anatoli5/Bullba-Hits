"""Small isolated event test. No game launch, network or renderer."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
from local_armor_inspector.telemetry import ShotTelemetry
from local_armor_inspector.exporter import read_battle


class ShotEvents(unittest.TestCase):
    def test_command_tracer_endpoint_and_raw_recovery(self):
        rows=[]
        player=types.SimpleNamespace(arena=types.SimpleNamespace(arenaUniqueID=1),playerVehicleID=7)
        recorder=types.SimpleNamespace(enabled=True,file='one',ensure_battle=lambda p:True,
            bw=types.SimpleNamespace(serverTime=lambda:10),writer=types.SimpleNamespace(put=lambda n,r:rows.append(r)))
        telemetry=ShotTelemetry(recorder)
        telemetry.snapshot=lambda p:{'clientMarker':{'position':[0,0,100],'direction':[0,0,1],'diameter':1}}
        replay=types.SimpleNamespace(g_replayCtrl=types.SimpleNamespace(isPlaying=False))
        with patch.dict(sys.modules,{'BattleReplay':replay}):
            telemetry.command(player,types.SimpleNamespace(gunIndexDelayed=0,predictShooting=True))
            telemetry.tracer(player,7,81,False,3,0,0,100,[0,0,0],[0,0,1000],9.81,720,0,0)
            self.assertEqual(rows[1]['possibleCommandId'],rows[0]['id'])
            self.assertIn('temporal',rows[1]['association'])
            telemetry.stop(player,81,[0,0,100])
            self.assertEqual(rows[2]['tracerId'],rows[1]['id'])
            self.assertEqual(rows[2]['segmentDistance'],100)
            telemetry.tracer(player,8,82,False,3,0,0,100,[0,0,0],[0,0,1000],9.81,720,0,0)
            self.assertNotIn('possibleCommandId',rows[-1])
            self.assertNotIn('aim',rows[-1])
            replay.g_replayCtrl.isPlaying=True
            telemetry.command(player,types.SimpleNamespace())
            self.assertEqual(len(rows),4)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'one.jsonl'
            header={'schema':1,'type':'battle','id':'one','clientVersion':'test'}
            path.write_text('\n'.join(json.dumps(x) for x in [header]+rows)+'\n')
            recovered=read_battle(str(path))
            self.assertEqual(len(recovered['shotEvents']),4)
            self.assertEqual(recovered['hits'],[])
            self.assertEqual(recovered['warnings'],[])

    def test_gun_updates_after_own_shot(self):
        # BACKLOG 28 step 2 (24.09): the first two own server gun updates after each own tracer, one record per shot;
        # a shot before the previous one got two (an autocannon) closes the previous with what it has.
        rows=[]
        player=types.SimpleNamespace(arena=types.SimpleNamespace(arenaUniqueID=1),playerVehicleID=7)
        recorder=types.SimpleNamespace(enabled=True,file='one',ensure_battle=lambda p:True,
            bw=types.SimpleNamespace(serverTime=lambda:10),writer=types.SimpleNamespace(put=lambda n,r:rows.append(r)))
        telemetry=ShotTelemetry(recorder)
        telemetry.snapshot=lambda p:{}
        replay=types.SimpleNamespace(g_replayCtrl=types.SimpleNamespace(isPlaying=False))
        update=lambda k:telemetry.server_update(player,7,[k,0,0],[0,0,1],.001*k)
        with patch.dict(sys.modules,{'BattleReplay':replay}):
            update(1)
            telemetry.tracer(player,7,81,False,3,0,0,100,[0,0,0],[0,0,1000],9.81,720,0,0)
            update(2)
            telemetry.tracer(player,8,90,False,3,0,0,100,[0,0,0],[0,0,1000],9.81,720,0,0)   # another's: nothing
            telemetry.tracer(player,7,82,False,3,0,0,100,[0,0,0],[0,0,1000],9.81,720,0,0)
            update(3);update(4);update(5)
        after=[r for r in rows if r['event']=='gunAfterShot']
        tracers=[r for r in rows if r['event']=='tracer' and r['own']]
        self.assertEqual([a['tracerId'] for a in after],[tracers[0]['id'],tracers[1]['id']])
        self.assertEqual([[u['origin'][0] for u in a['updates']] for a in after],[[2],[3,4]])
        self.assertIsNone(telemetry.after_shot)


if __name__=='__main__':unittest.main()
