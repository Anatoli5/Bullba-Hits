# -*- coding: utf-8 -*-
"""WoT PC 2.4 hit recorder and local HTML export. No server or companion."""
from __future__ import absolute_import
import base64
import json
import logging
import os
import threading
import time
import uuid
try:
    import Queue as queue
except ImportError:
    import queue

VERSION = '0.6.5'
VIEWER_PATH = os.path.join('mods', 'configs', 'local.armor_inspector', 'Viewer.html')
LOG = logging.getLogger('local.armor_inspector')
PARTS = ('chassis', 'hull', 'turret', 'gun')
_recorder = None
_original = None
_wrapper = None
_mods_api = None


def vector(v):
    return [float(v[0]), float(v[1]), float(v[2])]


def matrix_columns(matrix, root_inverse):
    """Column-major affine transform, using API operations instead of layout guesses."""
    columns = []
    for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        columns.extend(vector(root_inverse.applyVector(matrix.applyVector(axis))))
        columns.append(0.0)
    columns.extend(vector(root_inverse.applyPoint(matrix.applyPoint((0, 0, 0)))))
    columns.append(1.0)
    return columns


class Writer(object):
    def __init__(self, folder, exporter=None):
        self.folder = folder
        self.exporter = exporter
        if not os.path.isdir(folder): os.makedirs(folder)
        self.queue = queue.Queue(1024)
        self.dropped = 0
        self.failed = 0
        self.stopping = threading.Event()
        self.export_queue = queue.Queue(1024)
        self.export_thread = None
        if exporter is not None:
            self.export_thread = threading.Thread(target=self.run_export, name='ArmorInspectorExport')
            self.export_thread.daemon = True
            self.export_thread.start()
        self.thread = threading.Thread(target=self.run, name='ArmorInspectorWriter')
        self.thread.daemon = True
        self.thread.start()

    def put(self, name, record):
        try: self.queue.put_nowait((name, record))
        except queue.Full:
            self.dropped += 1
            LOG.error('Record queue full; dropped=%s', self.dropped)

    def run(self):
        while not self.stopping.is_set() or not self.queue.empty():
            try: name, record = self.queue.get(timeout=0.1)
            except queue.Empty: continue
            try:
                line = (json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(',', ':'))+'\n').encode('utf-8')
                with open(os.path.join(self.folder, name+'.jsonl'), 'ab') as stream:
                    stream.write(line)
                if self.exporter is not None:
                    try: self.export_queue.put_nowait((name, record))
                    except queue.Full: LOG.error('HTML export queue full; raw record saved for recovery on restart')
            except Exception:
                self.failed += 1
                LOG.exception('Could not persist hit; failed=%s', self.failed)
            finally: self.queue.task_done()

    def run_export(self):
        try: self.exporter.setup()
        except Exception:
            LOG.exception('HTML export setup failed; raw recording continues')
            self.exporter = None
            return
        while not self.stopping.is_set():
            try: name, record = self.export_queue.get(timeout=0.1)
            except queue.Empty:
                try:
                    if hasattr(self.exporter, 'flush'): self.exporter.flush()
                except Exception: LOG.exception('Deferred export failed; raw events are retained')
                continue
            try: self.exporter.record(name, record)
            except Exception: LOG.exception('HTML export failed; raw record is saved')
            finally: self.export_queue.task_done()

    def close(self):
        self.stopping.set()
        self.thread.join(2.0)
        if self.thread.is_alive(): LOG.warning('Writer still draining at shutdown')
        if self.export_thread is not None: self.export_thread.join(0.25)


class Recorder(object):
    def __init__(self, folder):
        import BigWorld
        self.bw = BigWorld
        self.battle = None
        self.seq = 0
        self.session = uuid.uuid4().hex[:12]
        self.enabled = True
        self.version = 'unknown'
        try:
            with open('version.xml', 'rb') as stream:
                self.version = stream.read(16384).decode('utf-8', 'replace')
        except IOError: LOG.warning('Client version unavailable')
        exporter = None
        if self.version != 'unknown':
            try:
                from local_armor_inspector.exporter import Exporter
                exporter = Exporter(os.getcwd(), os.path.dirname(os.path.abspath(folder)), self.version)
            except Exception: LOG.exception('HTML exporter unavailable; raw recording continues')
        self.writer = Writer(folder, exporter)
        from local_armor_inspector.telemetry import ShotTelemetry
        self.telemetry = ShotTelemetry(self)

    def ensure_battle(self, player):
        arena = getattr(player, 'arena', None)
        if arena is None: return False
        battle_id = str(arena.arenaUniqueID)
        if self.battle != battle_id:
            filename = battle_id+'-'+self.session
            arena_type = getattr(arena, 'arenaType', None)
            self.writer.put(filename, {'schema':1, 'type':'battle', 'id':filename,
                'arenaId':battle_id, 'startedAt':time.time(), 'playerVehicleId':player.playerVehicleID,
                'map':getattr(arena_type, 'name', None) or 'Unknown map',
                'clientVersion':self.version, 'recorderVersion':VERSION})
            self.battle = battle_id
            self.seq = 0
            self.file = filename
        return True

    def capture(self, vehicle, attackerID, hitPoints, effectsIndex, prefabEffIndex,
                damage, damageFactor, lastMaterialIsShield, shellVelocity, gunInstallationIndex):
        if not self.enabled: return
        import BattleReplay
        import Math
        from VehicleEffects import DamageFromShotDecoder as Decoder
        if BattleReplay.g_replayCtrl.isPlaying: return
        player = self.bw.player()
        arena = getattr(player, 'arena', None)
        player_id = getattr(player, 'playerVehicleID', None)
        if arena is None or player_id not in (vehicle.id, attackerID): return
        if getattr(player, 'isObserver', lambda: False)(): return
        if not self.ensure_battle(player): return
        self.seq += 1
        record = {'schema':1, 'type':'hit', 'id':str(self.seq), 'receivedAt':time.time(),
            'gameTime':float(self.bw.serverTime()), 'direction':'outgoing' if attackerID==player_id else 'incoming',
            'attackerId':attackerID, 'targetId':vehicle.id, 'damage':damage,
            'damageFactor':damageFactor, 'effectsIndex':effectsIndex,
            'prefabEffectsIndex':prefabEffIndex, 'lastMaterialIsShield':bool(lastMaterialIsShield),
            'shellVelocity':float(shellVelocity), 'gunInstallationIndex':gunInstallationIndex,
            'rawHitPoints':[], 'points':[], 'warnings':[]}
        attacker = None
        try:
            attacker = getattr(arena, 'vehicles', {}).get(attackerID, {}).get('vehicleType')
            if attacker is not None:
                record['attacker'] = {'name':attacker.type.shortUserString, 'type':attacker.type.name,
                    'compactDescriptor':base64.b64encode(attacker.makeCompactDescr()).decode('ascii')}
        except Exception:
            LOG.exception('Attacker descriptor unavailable; hit is retained')
        try:
            from local_armor_inspector.armor import shot_candidates
            if attacker is not None and gunInstallationIndex == 0:
                record['shellCandidates'] = shot_candidates(attacker, effectsIndex)
                record['availableShells'] = shot_candidates(attacker)
                record['shellStatus'] = 'matched' if record['shellCandidates'] else 'no matching shell effects'
            else:
                record['shellStatus'] = 'additional gun unsupported' if gunInstallationIndex != 0 else 'attacker descriptor unavailable'
        except Exception:
            record['shellStatus'] = 'shell parameter extraction failed'
            LOG.exception('Shell parameters unavailable; hit is retained')
        for hit in hitPoints:
            record['rawHitPoints'].append({'networkID':str(hit['networkID']), 'segment':str(hit['segment']), 'params':str(hit['params'])})
        # Persist even when geometry cannot be recovered from a departed entity.
        try:
            descr = vehicle.typeDescriptor
            record['target'] = {'name':descr.type.shortUserString, 'type':descr.type.name,
                'compactDescriptor':base64.b64encode(descr.makeCompactDescr()).decode('ascii'), 'parts':[]}
            collisions = vehicle.appearance.collisions
            root = Math.Matrix(collisions.getPartTransform(0))
            world_root = Math.Matrix(root)
            root.invertOrthonormal()
            record['target']['worldTransform'] = matrix_columns(world_root, Math.Matrix())
            limits = getattr(descr.gun, 'turretYawLimits', None)
            if limits is not None: record['target']['turretYawLimits'] = [float(x) for x in limits]
            try:
                from local_armor_inspector.presentation import gun_limits
                record['target']['gunPitchLimits'] = gun_limits(descr)
            except Exception:
                record['warnings'].append('Gun pitch limits unavailable')
            for idx, name in enumerate(PARTS):
                component = getattr(descr, name)
                part = {'id':idx, 'name':name}
                try:
                    from local_armor_inspector.armor import live_materials
                    part['armor'] = live_materials(component)
                    part['armorSource'] = 'live vehicle descriptor'
                except Exception:
                    # The export worker may recover stock metadata for this version.
                    pass
                try:
                    part['resource'] = component.hitTesterManager.activeHitTester.bspModelName
                    part['transform'] = matrix_columns(Math.Matrix(collisions.getPartTransform(idx)), root)
                except Exception:
                    part['error'] = 'Part model or transform unavailable'
                    record['warnings'].append('Part unavailable: '+name)
                record['target']['parts'].append(part)
            if collisions.maxStaticPartIndex > 3:
                record['warnings'].append('Additional vehicle parts are not yet rendered')
            record['aim'] = list(vehicle.getAimParams())
            for hit in hitPoints:
                point = {'status':'unresolved'}
                record['points'].append(point)
                try:
                    decoded = Decoder.parseHitPoint(hit, collisions)
                    if decoded is None: continue
                    idx, effect, start, end, hit_type, shell_type, caliber = decoded
                    point.update({'part':idx, 'effect':effect, 'hitType':hit_type,
                        'shellType':shell_type, 'caliber':caliber, 'start':vector(start), 'end':vector(end)})
                    from constants import SHELL_TYPES_LIST
                    if 0 <= shell_type < len(SHELL_TYPES_LIST): point['shellKind'] = SHELL_TYPES_LIST[shell_type]
                    if vector(start) == vector(end): continue
                    resolved = Decoder.collideHitPoint(idx, start, end, collisions)
                    if resolved is None: continue
                    pos, direction, normal = resolved
                    point.update({'position':vector(pos), 'direction':vector(direction), 'normal':vector(normal)})
                    if idx not in range(4):
                        point['status'] = 'unsupported-part'
                    else: point['status'] = 'resolved'
                except Exception:
                    LOG.exception('Hit point could not be decoded')
        except Exception:
            record['warnings'].append('Target appearance unavailable; raw event retained')
            LOG.exception('Hit geometry unavailable')
        try:
            entity = self.bw.entity(attackerID)
            if entity is not None:
                record['attackerPositionAtImpact'] = vector(entity.position)
                record['rangeAtImpact'] = float((vehicle.position-entity.position).length)
            telemetry = self.telemetry
            record['traceCandidates'] = [t['id'] for t in telemetry.tracers.values()
                if t['shooterId'] == attackerID and t['effectsIndex'] == effectsIndex
                and 0 <= time.time()-t['receivedAt'] < 10]
        except Exception: pass
        record['droppedRecords'] = self.writer.dropped
        record['writeFailures'] = self.writer.failed
        self.writer.put(self.file, record)


def open_viewer():
    try:
        from local_armor_inspector.presentation import open_in_game
        open_in_game(VIEWER_PATH)
    except Exception:
        LOG.exception('Could not open local HTML viewer')


def init():
    global _recorder, _original, _wrapper, _mods_api
    if _recorder is not None: return
    try:
        from Vehicle import Vehicle
        _recorder = Recorder(os.path.join('mods', 'configs', 'local.armor_inspector', 'battles'))
        _original = Vehicle.showDamageFromShot
        original = _original
        recorder = _recorder
        def wrapper(vehicle, *args, **kwargs):
            try: recorder.capture(vehicle, *args, **kwargs)
            except Exception: LOG.exception('Recorder failed; game handler continues')
            return original(vehicle, *args, **kwargs)
        _wrapper = wrapper
        Vehicle.showDamageFromShot = wrapper
        try: _recorder.telemetry.install()
        except Exception: LOG.exception('Aim telemetry hooks unavailable; hit recording continues')
        try:
            from gui.modsListApi import g_modsListApi
            _mods_api = g_modsListApi
            _mods_api.addModification(id='local.armor_inspector', name='Bullba Hits',
                description='Saved hits in an in-game window. Local files, no server.', enabled=True,
                icon='gui/maps/bullba_hits/modsListApi.png', login=False, lobby=True, callback=open_viewer)
        except Exception: LOG.exception('ModsList menu unavailable; open '+VIEWER_PATH)
        LOG.info('Armor Inspector %s ready', VERSION)
    except Exception:
        LOG.exception('Armor Inspector initialization failed')
        fini()


def fini():
    global _recorder
    if _recorder is not None:
        _recorder.enabled = False
        _recorder.telemetry.close()
        try:
            from Vehicle import Vehicle
            if Vehicle.showDamageFromShot is _wrapper: Vehicle.showDamageFromShot = _original
        except Exception: LOG.exception('Hook cleanup failed')
        _recorder.writer.close()
        _recorder = None
