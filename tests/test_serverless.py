import json
import hashlib
import os
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch, mock_open
from mod.local_armor_inspector import exporter as ex
from mod.mod_local_armor_inspector import Writer

ROOT = Path(__file__).resolve().parent.parent
RESOURCE = 'vehicles/test/collision_client/Hull.model'
MODEL = {'kind':'client-shot-collision','groups':[{'material':'armor',
    'vertices':[[0,0,0],[1,0,0],[0,1,0]],'indices':[0,1,2]}]}


def read_data(path):
    text = Path(path).read_text(encoding='ascii')
    assert text.startswith('ArmorInspectorData.receive(') and text.endswith(');\n')
    return json.loads(text[len('ArmorInspectorData.receive('):-3])


class ServerlessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.game = Path(self.temp.name)/'game'; self.game.mkdir()
        self.folder = self.game/'mods/configs/local.armor_inspector'
        (self.folder/'battles').mkdir(parents=True)
        self.archive = self.game/'test.wotmod'
        with zipfile.ZipFile(self.archive,'w') as z:
            for asset in ex.ASSETS:
                source = ROOT/'web/index.html' if asset=='Viewer.html' else ROOT/asset
                z.writestr('res/armor_inspector_viewer/'+asset,source.read_bytes())
            z.writestr('res/armor_inspector_viewer/../../escape.js',b'bad')
        packages = self.game/'res/packages'; packages.mkdir(parents=True)
        with zipfile.ZipFile(packages/'vehicles_test.pkg','w') as z:
            z.writestr(RESOURCE.replace('.model','.havok'),b'fixture')
        self.exporter = ex.Exporter(str(self.game),str(self.folder),'version\n',str(self.archive))
        self.header = {'schema':1,'type':'battle','id':'12-test','startedAt':1,'map':'Map',
                       'clientVersion':'version\r\n'}
        self.hit = {'schema':1,'type':'hit','id':'1','direction':'incoming','damage':100,
                    'target':{'name':'Target','parts':[{'id':1,'name':'hull','resource':RESOURCE,
                    'transform':[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]},'points':[]}

    def settle(self):
        """Run the deferred work the way the worker's idle ticks would: model jobs (extraction is queued
        since the on-demand export of 0.7.x) and the republish of the battles that waited for them."""
        for _ in range(100):
            self.exporter.last_job = 0
            if not (self.exporter.run_job() or self.exporter.drain_republish()): break
        self.exporter.flush(force=True)

    def battle(self):
        """The published battle file, with its shared tables expanded the way the page reads it."""
        return ex.read_data_file(str(self.folder/'data/battles/12-test.js'))

    def raw(self, rows, tail=b''):
        path = self.folder/'battles/12-test.jsonl'
        path.write_bytes(b''.join((json.dumps(r)+'\n').encode() for r in rows)+tail)
        return path

    def test_restart_exports_existing_hits_and_models_without_game_objects(self):
        self.raw([self.header,self.hit],b'{"schema":1')
        with patch.object(ex,'extract',return_value=MODEL): self.exporter.setup(); self.settle()
        self.assertTrue((self.folder/'Viewer.html').is_file())
        self.assertFalse((self.folder.parent/'escape.js').exists())
        index = read_data(self.folder/'data/index.js')[1]
        self.assertEqual(index['battles'][0]['hits'],1)
        b = self.battle()
        part = b['hits'][0]['target']['parts'][0]
        model_path = self.folder/'data/models'/(part['modelKey']+'.js')
        self.assertEqual(read_data(model_path)[1]['groups'][0]['indices'],[0,1,2])
        self.exporter.version = 'new version'
        self.exporter.attempts.clear()
        with patch.object(ex,'extract',side_effect=AssertionError('cache must be reused')):
            self.assertEqual(self.exporter.model(RESOURCE,self.header['clientVersion']),(part['modelKey'],None))

    def test_native_armor_inspector_module_does_not_shadow_exporter(self):
        import types
        from mod import mod_local_armor_inspector as recorder
        native = types.ModuleType('armor_inspector')
        with patch.dict(sys.modules, {'armor_inspector':native, 'BigWorld':types.ModuleType('BigWorld')}), \
                patch.object(sys, 'path', [str(ROOT/'mod')]+sys.path), \
                patch('builtins.open', mock_open(read_data=b'version\n')), patch.object(recorder, 'Writer') as writer:
            recorder.Recorder(str(self.folder/'battles'))
            self.assertIsNotNone(writer.call_args.args[1])
            self.assertEqual(type(writer.call_args.args[1]).__module__, 'local_armor_inspector.exporter')
            self.assertIs(sys.modules['armor_inspector'], native)

    def test_hash_bound_recovery_preserves_all_raw_events(self):
        path = self.raw([self.hit, dict(self.hit, id='2')])
        original = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'header unavailable'):
            ex.read_battle(str(path))
        sidecar = Path(str(path)+'.recovery.json')
        sidecar.write_text(json.dumps({'rawSha256':hashlib.sha256(original).hexdigest(),
            'header':self.header, 'warnings':['Recovered metadata; original header missing']}))
        with patch.object(ex, 'extract', return_value=MODEL): self.exporter.setup()
        battle = read_data(self.folder/'data/battles/12-test.js')[1]
        self.assertEqual([h['id'] for h in battle['hits']], ['1','2'])
        self.assertIn('Recovered metadata', battle['warnings'][0])
        self.assertEqual(path.read_bytes(), original)
        path.write_bytes(original+b'\n')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            ex.read_battle(str(path))

    def test_missing_old_geometry_is_explicit_and_event_survives(self):
        self.exporter.version = 'new'
        self.raw([self.header,self.hit])
        self.exporter.setup(); self.settle()
        hit = self.battle()['hits'][0]
        self.assertEqual(hit['damage'],100)
        self.assertIn('Client version changed',hit['target']['parts'][0]['modelError'])

    def test_override_never_substitutes_stock_mesh(self):
        override = self.game/'res_mods/2.4.0.0'/RESOURCE
        override.parent.mkdir(parents=True); override.write_bytes(b'override')
        with patch.object(ex,'extract',side_effect=AssertionError('must not extract')):
            key,error = self.exporter.model(RESOURCE,'version\n')
        self.assertIn('overrides',error)
        self.assertFalse((self.folder/'data/models'/(key+'.js')).exists())

    def test_recording_updates_index_and_keeps_raw_hit_detached(self):
        self.exporter.setup()
        original = json.dumps(self.hit,sort_keys=True)
        with patch.object(ex,'extract',return_value=MODEL) as extract:
            self.exporter.record('12-test',self.header)
            self.exporter.record('12-test',self.hit)
            outgoing = dict(self.hit,id='2',direction='outgoing')
            self.exporter.record('12-test',outgoing)
            self.settle()
        self.assertEqual(extract.call_count,1)
        self.assertEqual(read_data(self.folder/'data/index.js')[1]['battles'][0]['hits'],2)
        self.assertEqual(json.dumps(self.hit,sort_keys=True),original)

    def test_slow_model_export_does_not_block_raw_logging(self):
        entered,release = threading.Event(),threading.Event()
        class SlowExporter:
            def setup(self): entered.set(); release.wait(3)
            def record(self,*args): pass
        writer = Writer(str(self.folder/'battles'),SlowExporter())
        try:
            self.assertTrue(entered.wait(1))
            writer.put('12-test',self.header);writer.put('12-test',self.hit)
            writer.queue.join()
            self.assertEqual(len(ex.read_battle(str(self.folder/'battles/12-test.jsonl'))['hits']),1)
        finally: release.set();writer.close()

    def test_js_payload_escapes_code_and_unicode(self):
        path = self.folder/'data/payload.js'
        value = {'name':'</script>\u2028\u2029";globalThis.bad=true;// & < танк'}
        ex.write_data(str(path),'index',value)
        self.assertNotIn('<',path.read_text())
        self.assertEqual(read_data(path),['index',value])

    def test_python27_windows_replace_path(self):
        path = self.folder/'данные.js'
        with patch.object(ex.os,'replace',create=True) as modern:
            del ex.os.replace
            try:
                ex.atomic_write(str(path),b'old')
                ex.atomic_write(str(path),b'new')
            finally: ex.os.replace = modern
        self.assertEqual(path.read_bytes(),b'new')

    def test_python27_failed_rename_restores_previous_snapshot(self):
        path = self.folder/'snapshot.js'
        path.write_bytes(b'previous snapshot')
        rename = os.rename
        def fail_new(source, dest):
            if source.endswith('.tmp'): raise OSError('rename failed')
            return rename(source, dest)
        with patch.object(ex.os, 'replace', create=True) as modern:
            del ex.os.replace
            try:
                with patch.object(ex.os, 'rename', side_effect=fail_new), self.assertRaises(OSError):
                    ex.atomic_write(str(path), b'new')
            finally: ex.os.replace = modern
        self.assertEqual(path.read_bytes(), b'previous snapshot')

    def test_invalid_resource_and_battle_paths(self):
        for resource in ('../x.model',RESOURCE+'\n','vehicles/../x.model'):
            with self.assertRaises(ValueError): ex.model_key(resource,'version')
        self.header['id']='../escape'
        with self.assertRaises(ValueError): self.exporter.publish(dict(self.header,hits=[]))


if __name__=='__main__': unittest.main()
