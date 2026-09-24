import contextlib
import importlib.util
import json
import math
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from mod.local_armor_inspector.geometry import compressed_mesh, transform
from mod.local_armor_inspector.havok import TagFile, FormatError
from mod.local_armor_inspector.exporter import read_battle

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
spec=importlib.util.spec_from_file_location('recorder',ROOT/'mod/mod_local_armor_inspector.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)


class Matrix:
    """Known rotation/translation fixture independent of the serialization code."""
    def __init__(self, other=None):
        self.angle=getattr(other,'angle',0)
        self.translation=getattr(other,'translation',(0,0,0))
    def applyVector(self,v):
        c,s=math.cos(self.angle),math.sin(self.angle)
        return (c*v[0]+s*v[2],v[1],-s*v[0]+c*v[2])
    def applyPoint(self,v): return tuple(x+y for x,y in zip(self.applyVector(v),self.translation))
    def invertOrthonormal(self):
        self.angle=-self.angle
        self.translation=self.applyVector(tuple(-x for x in self.translation))


def battles(folder):
    """Every raw battle the recorder wrote, read by the exporter's own reader (the one the export uses)."""
    return [read_battle(str(p)) for p in sorted(Path(folder).glob('*.jsonl'))]


def apply_columns(m,v): return [sum(m[j*4+i]*v[j] for j in range(3))+m[12+i] for i in range(3)]


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        player=types.SimpleNamespace(playerVehicleID=1,arena=types.SimpleNamespace(arenaUniqueID=9876543210123456789,
            arenaType=types.SimpleNamespace(name='Test map')),isObserver=lambda:False)
        self.player=player
        class Decoder:
            @staticmethod
            def parseHitPoint(hit,collisions):
                if hit['params']==999: return None
                return 1,4,(-2.,0,0),(2.,0,0),0,0,120.
            @staticmethod
            def collideHitPoint(idx,start,end,collisions): return (-1.,0,0),(1.,0,0),(-1.,0,0)
        self.patch=patch.dict(sys.modules,{'BigWorld':types.SimpleNamespace(player=lambda:player,serverTime=lambda:12.5),
            'Math':types.SimpleNamespace(Matrix=Matrix),'VehicleEffects':types.SimpleNamespace(DamageFromShotDecoder=Decoder),
            'BattleReplay':types.SimpleNamespace(g_replayCtrl=types.SimpleNamespace(isPlaying=False)),
            # The client's constants module: shell kinds by index (point decoding) and back (shell lists).
            'constants':types.SimpleNamespace(SHELL_TYPES_LIST=('HOLLOW_CHARGE','HIGH_EXPLOSIVE','ARMOR_PIERCING','ARMOR_PIERCING_HE','ARMOR_PIERCING_CR'),
                SHELL_TYPES_INDICES={'HOLLOW_CHARGE':0,'HIGH_EXPLOSIVE':1,'ARMOR_PIERCING':2,'ARMOR_PIERCING_HE':3,'ARMOR_PIERCING_CR':4})})
        self.patch.start();self.addCleanup(self.patch.stop)
        self.recorder=mod.Recorder(self.tmp.name);self.addCleanup(self.recorder.writer.close)
        self.vehicle=types.SimpleNamespace(id=2,appearance=types.SimpleNamespace(collisions=types.SimpleNamespace(
            getPartTransform=lambda i:Matrix(),maxStaticPartIndex=3)),getAimParams=lambda:(.2,.3))
        comp=types.SimpleNamespace(hitTesterManager=types.SimpleNamespace(activeHitTester=types.SimpleNamespace(bspModelName='vehicles/test/collision_client/Hull.model')))
        self.vehicle.typeDescriptor=types.SimpleNamespace(type=types.SimpleNamespace(shortUserString='Target',name='test:target'),
            chassis=comp,hull=comp,turret=comp,gun=comp,makeCompactDescr=lambda:b'\x00\xff')
        self.hit={'networkID':0,'segment':18446744073709551615,'params':2}

    def capture(self,attacker): self.recorder.capture(self.vehicle,attacker,[self.hit],1,0,390,1,False,1200.0,0)
    def read(self):
        self.recorder.writer.close()
        return battles(self.tmp.name)[0]

    def test_incoming_outgoing_and_restart(self):
        self.capture(1)
        self.vehicle.id=1;self.capture(2)
        b=self.read()
        self.assertEqual([h['direction'] for h in b['hits']],['outgoing','incoming'])
        self.assertEqual(b['hits'][0]['shellVelocity'],1200.)
        self.assertEqual(b['hits'][0]['rawHitPoints'][0]['segment'],'18446744073709551615')
        self.assertEqual(b['hits'][0]['points'][0]['position'],[-1.,0,0])
        self.assertEqual(b['arenaId'],'9876543210123456789')
        self.assertEqual(battles(self.tmp.name)[0],b)

    def test_missing_decoder_keeps_raw_event(self):
        self.hit['params']=999;self.capture(1)
        h=self.read()['hits'][0]
        self.assertEqual(h['points'][0]['status'],'unresolved');self.assertEqual(len(h['rawHitPoints']),1)

    def test_nominal_ammunition_and_attacker_are_retained_on_hit(self):
        shell=types.SimpleNamespace(name='AP shell',userString='AP shell',kind='ARMOR_PIERCING',
            effectsIndex=1,caliber=120,piercingPowerRandomization=.25,piercingPowerRandomizationType='NORMAL',
            type=types.SimpleNamespace(normalizationAngle=math.radians(5),ricochetAngleCos=math.cos(math.radians(70))))
        descriptor=types.SimpleNamespace(type=types.SimpleNamespace(name='test:attacker',shortUserString='Attacker'),
            makeCompactDescr=lambda:b'\x01\xfe',gun=types.SimpleNamespace(shots=[types.SimpleNamespace(shell=shell,piercingPower=(260,230))]))
        self.player.arena.vehicles={1:{'vehicleType':descriptor}}
        self.capture(1)
        h=self.read()['hits'][0]
        self.assertEqual(h['attacker']['compactDescriptor'],'Af4=')
        self.assertEqual(h['shellCandidates'][0]['penetration100'],260)
        self.assertEqual(h['shellCandidates'][0]['penetration500'],230)
        self.assertEqual(h['shellCandidates'][0]['randomization'],.25)
        self.assertEqual(h['shellStatus'],'matched')

    def test_shell_failure_retains_attacker_for_future_recovery(self):
        descriptor=types.SimpleNamespace(type=types.SimpleNamespace(name='test:attacker',shortUserString='Attacker'),
            makeCompactDescr=lambda:b'\x01\xfe')
        self.player.arena.vehicles={1:{'vehicleType':descriptor}}
        with self.assertLogs('local.armor_inspector',level='ERROR'):self.capture(1)
        h=self.read()['hits'][0]
        self.assertEqual(h['attacker']['type'],'test:attacker')
        self.assertEqual(h['shellStatus'],'shell parameter extraction failed')
        self.assertEqual(h['damage'],390)

    def test_first_hit_without_legacy_arena_type_id(self):
        self.capture(1)
        battle = self.read()
        self.assertEqual(battle['map'], 'Test map')
        self.assertEqual(len(battle['hits']), 1)
        self.assertEqual(battle['hits'][0]['id'], '1')

    def test_missing_map_does_not_drop_header_or_first_hit(self):
        del self.player.arena.arenaType
        self.capture(1)
        battle = self.read()
        self.assertEqual(battle['map'], 'Unknown map')
        self.assertEqual(len(battle['hits']), 1)

    def test_unavailable_appearance_keeps_event(self):
        self.vehicle.appearance=None
        with self.assertLogs('local.armor_inspector',level='ERROR'):self.capture(1)
        h=self.read()['hits'][0]
        self.assertEqual(h['damage'],390);self.assertTrue(h['warnings'])

    def test_replays_ignored_and_other_hits_kept_as_other(self):
        # Since the roster shooters (0.7.x) a hit between two other vehicles is recorded too, as 'other';
        # a replay still records nothing.
        self.capture(3)
        sys.modules['BattleReplay'].g_replayCtrl.isPlaying=True;self.capture(1)
        self.recorder.writer.close();recorded=battles(self.tmp.name)
        self.assertEqual([[h['direction'] for h in b['hits']] for b in recorded],[['other']])

    def test_battle_change_and_unique_hit_ids(self):
        self.capture(1);self.capture(1)
        self.player.arena.arenaUniqueID=12;self.capture(1)
        self.recorder.writer.close()
        self.assertEqual(sorted(len(x['hits']) for x in battles(self.tmp.name)),[1,2])

    def test_hook_keeps_original_return_and_exception(self):
        class Vehicle:
            def showDamageFromShot(self,*args,**kwargs):
                if kwargs.get('fail'):raise RuntimeError('game error')
                return 87
        with patch.dict(sys.modules,{'Vehicle':types.SimpleNamespace(Vehicle=Vehicle)}),patch.object(mod,'Recorder',return_value=self.recorder):
            # By the class dictionary (REC-10): under the client's Python 2 getattr hands out a new unbound method
            # each time, so an identity test through it proves nothing there; tests/py27/recorder_two_battles.py
            # checks the same removal under python27.dll.
            original=vars(Vehicle)['showDamageFromShot']
            mod.init()
            with patch.object(self.recorder,'capture',side_effect=ValueError('record failure')):
                with self.assertLogs('local.armor_inspector',level='ERROR'):
                    self.assertEqual(Vehicle().showDamageFromShot(),87)
                with self.assertLogs('local.armor_inspector',level='ERROR'),self.assertRaisesRegex(RuntimeError,'game error'):
                    Vehicle().showDamageFromShot(fail=True)
            mod.fini();self.assertIs(vars(Vehicle)['showDamageFromShot'],original)


class GeometryTests(unittest.TestCase):
    def test_rotated_part_transform(self):
        root=Matrix();root.translation=(10,3,-7);root.angle=.7
        inverse=Matrix(root);inverse.invertOrthonormal()
        part=Matrix();part.translation=root.applyPoint((1,2,3));part.angle=root.angle+math.pi/2
        actual=apply_columns(mod.matrix_columns(part,inverse),(0,0,2))
        for a,b in zip(actual,(3,2,3)):self.assertAlmostEqual(a,b,places=8)

    def test_shared_vertices_and_second_section(self):
        section={'firstPackedVertexIndex':1,'numPackedVertices':2,'codecParms':[0,0,0,1,1,1],
            'firstSharedVertexIndex':1,'firstPrimitiveIndex':1,'numPrimitives':2}
        tree={'domain':{'min':[0,0,0],'max':[1,1,1]},'sharedVertices':[0,(1<<21)-1],
            'sharedVerticesIndex':[0,1],'packedVertices':[999,0,1<<11],
            'sections':[section],'primitives':[{'indices':[9,9,9,9]},{'indices':[0,1,2,2]},{'indices':[222,173,222,173]}]}
        vertices,indices=compressed_mesh({'data':{'meshTree':tree}})
        self.assertEqual(vertices,[[0,0,0],[0,1,0],[1,0,0]])
        self.assertEqual(indices,[0,1,2])

    def test_quaternion_body_pose(self):
        result=transform([1,0,0],[3,4,5],[0,0,math.sqrt(.5),math.sqrt(.5)])
        for a,b in zip(result,[3,5,5]):self.assertAlmostEqual(a,b)

    def test_rejects_truncated_havok(self):
        with self.assertRaises(FormatError):TagFile(b'\x00\x00\x01\x00TAG0')


class StorageTests(unittest.TestCase):
    """The exporter's reader of a raw battle (read_battle): a torn last line waits, a bad line is a warning."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'battle.jsonl'
        self.path.write_text(json.dumps({'schema':1,'type':'battle','clientVersion':'test'})+'\n'+json.dumps({'schema':1,'type':'hit','id':'1','direction':'incoming'})+'\n',encoding='utf-8')

    def test_partial_tail_is_ignored_then_read_after_completion(self):
        with self.path.open('ab') as f:f.write(b'{"schema":1,"type":"hit","id":"2"}')
        self.assertEqual(len(read_battle(str(self.path))['hits']),1)
        with self.path.open('ab') as f:f.write(b'\n')
        self.assertEqual(len(read_battle(str(self.path))['hits']),2)

    def test_malformed_line_is_reported(self):
        with self.path.open('ab') as f:f.write(b'not json\n')
        self.assertEqual(len(read_battle(str(self.path))['warnings']),1)



if __name__=='__main__':unittest.main()
