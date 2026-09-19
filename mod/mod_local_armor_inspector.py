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

VERSION = '0.7.12'
VIEWER_PATH = os.path.join('mods', 'configs', 'local.armor_inspector', 'Viewer.html')
LOG = logging.getLogger('local.armor_inspector')
PARTS = ('chassis', 'hull', 'turret', 'gun')
CONTEXT_MENU_OPTION = 'bullbaHits'
CONTEXT_MENU_LABEL = 'Bullba Hits'
# How long one 'busy' message from the page holds the deferred work back. The page
# repeats it at most once a second while the user drags or zooms, so two seconds
# covers the gap between two messages and expires on its own afterwards.
BUSY_SECONDS = 2.0
_recorder = None
_original = None
_wrapper = None
_mods_api = None
_events = None
_context_menu = None


def vector(v):
    return [float(v[0]), float(v[1]), float(v[2])]


VEHICLE_CLASS_TAGS = ('lightTank', 'mediumTank', 'heavyTank', 'AT-SPG', 'SPG')


def vehicle_identity(descr):
    """Tier, class, role and nation of a VehicleDescriptor, each field independently.

    A missing or renamed client attribute must never cost us the hit, so every
    field is read on its own and simply left out when it is unavailable.
    """
    identity = {}
    vtype = getattr(descr, 'type', None)
    if vtype is None:
        return identity
    try:
        identity['level'] = int(vtype.level)
    except Exception:
        pass
    try:
        for tag in vtype.tags:
            if tag in VEHICLE_CLASS_TAGS:
                identity['class'] = str(tag)
                break
    except Exception:
        pass
    try:
        from constants import ROLE_TYPE_TO_LABEL
        label = ROLE_TYPE_TO_LABEL.get(vtype.role)
        if label and label != 'NotDefined':
            identity['role'] = str(label)
    except Exception:
        pass
    try:
        identity['nation'] = str(vtype.name.split(':')[0])
    except Exception:
        pass
    return identity


def matrix_columns(matrix, root_inverse):
    """Column-major affine transform, using API operations instead of layout guesses."""
    columns = []
    for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        columns.extend(vector(root_inverse.applyVector(matrix.applyVector(axis))))
        columns.append(0.0)
    columns.extend(vector(root_inverse.applyPoint(matrix.applyPoint((0, 0, 0)))))
    columns.append(1.0)
    return columns


def translation_columns(point):
    """The same column-major layout as matrix_columns, for a pure translation.

    Three axis columns, each with a trailing 0.0, then the offset with a trailing
    1.0. Used where there is no live entity to read a part transform from.
    """
    columns = []
    for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        columns.extend([float(axis[0]), float(axis[1]), float(axis[2])])
        columns.append(0.0)
    columns.extend(vector(point))
    columns.append(1.0)
    return columns


def rest_transforms(descr):
    """Collision-part transforms of a vehicle descriptor in its rest pose.

    A hit records the target's parts from the live entity; the shooter has no
    entity here, only his descriptor, so his parts are stacked the way the client
    itself stacks them (vehicles.py VehicleDescr.__updateAttributes): the chassis
    is the frame, the hull sits at chassis.hullPosition, the turret on the hull at
    hull.turretPositions[0], the gun in the turret at turret.gunPosition. No
    rotation: the collision models are authored in that pose. Order follows PARTS.
    """
    hull = descr.chassis.hullPosition
    turret = hull + descr.hull.turretPositions[0]
    gun = turret + descr.turret.gunPosition
    return [translation_columns(offset) for offset in ((0.0, 0.0, 0.0), hull, turret, gun)]


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

    def put_export(self, name, payload):
        """One message for the export thread. Game thread, never blocking.

        The same queue the records travel in, so the export thread has a single
        place to read from and no lock of its own: a message is handled in its
        turn, ahead of the deferred work but behind the records already waiting.
        """
        if self.exporter is None: return
        try: self.export_queue.put_nowait((name, payload))
        except queue.Full: LOG.error('Export queue full; %s message dropped', name)

    def put_vehicle(self, request):
        """Ask the export thread for a vehicle export. Game thread, never blocking.

        The request is a handful of strings; rebuilding the descriptor, reading the
        client packages and collecting the armour tables all happen on the export
        thread. A full queue drops the request - the raw log keeps the earlier ones
        and the hangar will ask again.
        """
        self.put_export('vehicle', request)

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
                    if hasattr(self.exporter, 'idle'): self.exporter.idle()
                    elif hasattr(self.exporter, 'flush'): self.exporter.flush()
                except Exception: LOG.exception('Deferred export failed; raw events are retained')
                continue
            try:
                # 'vehicle' and 'prioritise' are messages, not battle records: a battle
                # file is named '<arenaUniqueID>-<session>' and can be neither.
                if name == 'vehicle': self.exporter.request_vehicle_export(record)
                elif name == 'prioritise': self.exporter.prioritise(record)
                else: self.exporter.record(name, record)
            except Exception: LOG.exception('HTML export failed; raw record is saved')
            finally: self.export_queue.task_done()

    def close(self):
        self.stopping.set()
        self.thread.join(2.0)
        if self.thread.is_alive(): LOG.warning('Writer still draining at shutdown')
        if self.export_thread is not None: self.export_thread.join(0.25)


def vehicle_request(descr, source):
    """The tiny request a game-thread hook hands to the export thread."""
    request = {'schema':1, 'type':'vehicle', 'source':source,
               'vehicleType':str(descr.type.name), 'requestedAt':time.time(),
               'compactDescriptor':base64.b64encode(descr.makeCompactDescr()).decode('ascii')}
    try: request['name'] = descr.type.shortUserString
    except Exception: pass
    try: request['identity'] = vehicle_identity(descr)
    except Exception: pass
    return request


class VehicleEvents(object):
    """Hangar and battle hooks that ask for a vehicle export.

    Client names confirmed in the installed bytecode of 2.4.0.0 and again in 2.4.0.1 (identical):
    CurrentVehicle.g_currentVehicle is a _CurrentVehicle whose onChanged is an
    Event, isPresent() is 'self.item is not None' and item returns the gui Vehicle
    (whose descriptor is FittingItem._descriptor, a VehicleDescr);
    PlayerEvents.g_playerEvents has onAvatarBecomePlayer / onAvatarBecomeNonPlayer;
    ClientArena creates onNewVehicleListReceived and onVehicleAdded and stores
    info['vehicleType'] = self.getVehicleType(info, info.pop('compDescr')), which
    returns vehicles.VehicleDescr(compactDescr=...).

    Everything here is optional: any failure logs and leaves hit recording alone.
    """

    def __init__(self, recorder):
        self.recorder = recorder
        self.hangar = None
        self.events = None
        self.arena = None
        self.attempts = 0
        # Roster descriptors seen during the battle, exported only after it: the
        # export thread shares the interpreter lock with the game, and thirty
        # vehicles' worth of package reads at battle start would show as stutter.
        self.roster = {}

    def install(self):
        try:
            from CurrentVehicle import g_currentVehicle
            self.hangar = g_currentVehicle
            g_currentVehicle.onChanged += self.on_hangar_vehicle
            self.on_hangar_vehicle()
        except Exception: LOG.exception('Hangar vehicle export unavailable; hit recording continues')
        try:
            from PlayerEvents import g_playerEvents
            g_playerEvents.onAvatarBecomePlayer += self.on_avatar_become_player
            g_playerEvents.onAvatarBecomeNonPlayer += self.on_avatar_become_non_player
            self.events = g_playerEvents
        except Exception: LOG.exception('Battle vehicle export unavailable; hit recording continues')

    def close(self):
        self.detach_arena()
        self.roster = {}
        try:
            if self.hangar is not None: self.hangar.onChanged -= self.on_hangar_vehicle
        except Exception: LOG.exception('Hangar hook cleanup failed')
        try:
            if self.events is not None:
                self.events.onAvatarBecomePlayer -= self.on_avatar_become_player
                self.events.onAvatarBecomeNonPlayer -= self.on_avatar_become_non_player
        except Exception: LOG.exception('Battle hook cleanup failed')
        self.hangar, self.events = None, None

    def on_hangar_vehicle(self, *args):
        """The vehicle selected in the hangar, on every change. Duplicates are dropped."""
        try:
            if self.hangar is None or not self.hangar.isPresent(): return
            vehicle = self.hangar.item
            if vehicle is None: return
            self.recorder.request_vehicle(vehicle.descriptor, 'hangar')
        except Exception: LOG.exception('Hangar vehicle export request failed')

    def on_avatar_become_player(self, *args):
        # The export thread extracts nothing while this is set: a collision model
        # costs a few tenths of a second of the interpreter lock, which is stutter
        # in a battle. The hits themselves are written and published throughout.
        try: self.recorder.in_battle = True
        except Exception: LOG.exception('Battle state could not be noted')
        self.attempts = 0
        self.attach_arena()

    def attach_arena(self):
        """Subscribe to the arena roster; the arena appears slightly after the avatar."""
        try:
            import BigWorld
            arena = getattr(BigWorld.player(), 'arena', None)
            if arena is None:
                self.attempts += 1
                if self.attempts <= 5: BigWorld.callback(1.0, self.attach_arena)
                return
            if arena is self.arena: return
            self.detach_arena()
            arena.onNewVehicleListReceived += self.on_vehicle_list
            arena.onVehicleAdded += self.on_vehicle_added
            self.arena = arena
            self.on_vehicle_list()
        except Exception: LOG.exception('Arena vehicle export hooks unavailable')

    def detach_arena(self):
        try:
            if self.arena is not None:
                self.arena.onNewVehicleListReceived -= self.on_vehicle_list
                self.arena.onVehicleAdded -= self.on_vehicle_added
        except Exception: LOG.exception('Arena hook cleanup failed')
        self.arena = None

    def on_avatar_become_non_player(self, *args):
        try: self.recorder.in_battle = False
        except Exception: LOG.exception('Battle state could not be noted')
        self.detach_arena()
        self.flush_roster()

    def note_roster_vehicle(self, descr):
        """Remember a roster vehicle for export after the battle; the game thread does nothing else."""
        if descr is None: return
        try:
            key = str(descr.type.name)
            if key not in self.roster: self.roster[key] = descr
        except Exception: LOG.exception('Roster vehicle could not be noted')

    def flush_roster(self):
        """Queue the battle's vehicles for export now that the battle is over."""
        pending, self.roster = self.roster, {}
        for descr in pending.values():
            try: self.recorder.request_vehicle(descr, 'battle')
            except Exception: LOG.exception('Battle vehicle export request failed')

    def on_vehicle_list(self, *args):
        """Every vehicle of the roster - the opponents' exact configurations."""
        try:
            if self.arena is None: return
            for info in list(getattr(self.arena, 'vehicles', {}).values()):
                self.note_roster_vehicle((info or {}).get('vehicleType'))
            self.write_roster()
        except Exception: LOG.exception('Battle roster unavailable for vehicle export')

    def on_vehicle_added(self, vehicle_id, *args):
        try:
            if self.arena is None: return
            info = getattr(self.arena, 'vehicles', {}).get(vehicle_id) or {}
            self.note_roster_vehicle(info.get('vehicleType'))
            self.write_roster()
        except Exception: LOG.exception('Battle vehicle export request failed')

    def write_roster(self):
        try:
            import BigWorld
            self.recorder.note_roster(self.arena, BigWorld.player())
        except Exception: LOG.exception('Battle roster record failed')


class Recorder(object):
    def __init__(self, folder):
        import BigWorld
        self.bw = BigWorld
        self.battle = None
        self.seq = 0
        self.session = uuid.uuid4().hex[:12]
        self.enabled = True
        # Two flags the export thread reads before it runs deferred work (0.7.11):
        # no collision model is extracted during a battle, and none while the page
        # says the user is working in it. Written here, on the game thread, only.
        self.in_battle = False
        self.busy_until = 0.0
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
                exporter.recorder = self
            except Exception: LOG.exception('HTML exporter unavailable; raw recording continues')
        self.writer = Writer(folder, exporter)
        self.last_vehicle = None
        from local_armor_inspector.telemetry import ShotTelemetry
        self.telemetry = ShotTelemetry(self)

    def request_vehicle(self, descr, source):
        """Queue one vehicle export, skipping the request we just queued.

        The hangar fires its change event often and a roster repeats itself, so the
        same type with the same compact descriptor twice in a row is dropped here;
        the exporter drops the rest by comparing the descriptor hash of the file it
        already wrote.
        """
        try:
            if descr is None: return
            request = vehicle_request(descr, source)
            key = (request['vehicleType'], request['compactDescriptor'])
            if key == self.last_vehicle: return
            self.last_vehicle = key
            self.writer.put_vehicle(request)
        except Exception:
            LOG.exception('Vehicle export request failed; hit recording continues')

    def note_busy(self, seconds=BUSY_SECONDS):
        """The page is being used right now: hold the deferred work back.

        One float written by the game thread and read by the export thread, so the
        page can drag and zoom without an extraction taking the interpreter lock
        under it. It expires by itself - a page that stops asking is not busy.
        """
        self.busy_until = time.time()+float(seconds)

    def prioritise(self, types):
        """The page opened a hit: its vehicles' models go before everything else.

        Sent through the export queue instead of touching the queue of jobs from
        here: that list belongs to the export thread.
        """
        names = [str(name) for name in list(types or [])[:8] if name]
        if names: self.writer.put_export('prioritise', names)

    def note_roster(self, arena, player):
        """The battle's roster as one record: id, player, vehicle and team of every vehicle known so far.

        Written whole each time the arena list changes (a few hundred bytes); the exporter keeps the
        last one. The viewer lists the allies from it so that the hits can be read from any ally's
        seat. Game thread: dictionary reads only, no package access.
        """
        if not self.enabled or arena is None: return
        player_id = getattr(player, 'playerVehicleID', None)
        # The first arena list can arrive before the client knows its own vehicle (playerVehicleID 0, Tundra
        # 18.09): a roster without the player is worthless and would also stamp 0 into the battle header, so it
        # waits - the next list change or the first recorded hit writes it.
        if not player_id or not getattr(arena, 'vehicles', None): return
        if not self.ensure_battle(player): return
        vehicles, player_team = [], None
        for vehicle_id, info in list(getattr(arena, 'vehicles', {}).items()):
            try:
                descr = (info or {}).get('vehicleType')
                row = {'id':vehicle_id, 'player':info.get('name'), 'team':info.get('team')}
                if descr is not None:
                    row['name'] = descr.type.shortUserString
                    row['type'] = descr.type.name
                vehicles.append(row)
                if vehicle_id == player_id: player_team = info.get('team')
            except Exception: LOG.exception('Roster vehicle could not be listed')
        self.writer.put(self.file, {'schema':1, 'type':'roster', 'receivedAt':time.time(),
            'playerVehicleId':player_id, 'playerTeam':player_team, 'vehicles':vehicles})
        self.roster_known = True

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
            self.roster_known = False
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
        if arena is None: return
        if getattr(player, 'isObserver', lambda: False)(): return
        if not self.ensure_battle(player): return
        if not getattr(self, 'roster_known', False):
            try: self.note_roster(arena, player)
            except Exception: LOG.exception('Battle roster record failed')
        # Every hit the client shows is recorded (0.7.9), not only the player's own: the viewer picks the
        # vehicle to look at. 'direction' stays relative to the player for older pages; 'other' is a hit
        # between two vehicles that are not his.
        self.seq += 1
        record = {'schema':1, 'type':'hit', 'id':str(self.seq), 'receivedAt':time.time(),
            'gameTime':float(self.bw.serverTime()),
            'direction':'outgoing' if attackerID==player_id else 'incoming' if vehicle.id==player_id else 'other',
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
                record['attacker'].update(vehicle_identity(attacker))
                try:
                    # Nominal full-aim accuracy of the mounted gun (no crew or equipment): radius grows linearly with range.
                    record['attacker']['gunDispersion'] = float(attacker.gun.shotDispersionAngle)
                    record['attacker']['gun'] = getattr(attacker.gun, 'shortUserString', attacker.gun.name)
                    # Gun axis height above the ground (the chassis origin): the shooter's viewpoint on flat ground.
                    # The client's own sum (vehicles.py VehicleDescr.__updateAttributes): chassis.hullPosition +
                    # hull.turretPositions[0] + turret.gunPosition. Records before 0.6.34 lacked the chassis term and
                    # carry no 'gunHeightFrom'; the exporter recomputes them from the compact descriptor.
                    record['attacker']['gunHeight'] = float((attacker.chassis.hullPosition + attacker.hull.turretPositions[0] + attacker.turret.gunPosition).y)
                    record['attacker']['gunHeightFrom'] = 'ground'
                except Exception:
                    pass
                try:
                    # The shooter's own collision parts (0.6.34), so the viewer can swap the roles and
                    # draw his armour. There is no live entity for him here, only the descriptor, so the
                    # parts take the rest pose in the chassis frame instead of a recorded transform.
                    from local_armor_inspector.armor import live_materials
                    transforms = rest_transforms(attacker)
                    parts = []
                    for idx, name in enumerate(PARTS):
                        component = getattr(attacker, name, None)
                        part = {'id':idx, 'name':name}
                        try:
                            part['armor'] = live_materials(component)
                            part['armorSource'] = 'live vehicle descriptor'
                        except Exception:
                            # The export worker may recover stock metadata for this version.
                            pass
                        try:
                            part['resource'] = component.hitTesterManager.activeHitTester.bspModelName
                            part['transform'] = transforms[idx]
                        except Exception:
                            part['error'] = 'Part model or transform unavailable'
                            record['warnings'].append('Shooter part unavailable: '+name)
                        parts.append(part)
                    record['attacker']['parts'] = parts
                    record['attacker']['partsFrom'] = 'rest pose'
                except Exception:
                    record['warnings'].append('Shooter collision parts unavailable')
                    LOG.exception('Shooter collision parts unavailable; hit is retained')
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
            record['target'].update(vehicle_identity(descr))
            try:
                # Spall-liner factor of the target: 1.0 without a liner, higher with one. The page divides the
                # non-penetration HE damage by it; a client without the attribute simply leaves the field out.
                record['target']['linerFactor'] = float(descr.miscAttrs.get('antifragmentationLiningFactor', 1.0))
            except Exception:
                pass
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


def picker_descriptor(type_name):
    """The configuration to export for a vehicle picked in the page's list.

    The player's own hangar configuration when the vehicle is in the inventory -
    items.makeIntCompactDescrByID('vehicle', nationID, innationID) builds the int
    compact descriptor, IItemsCache.items.getItemByCD returns the gui Vehicle and
    its .descriptor is FittingItem._descriptor, a VehicleDescr - otherwise the top
    configuration of the catalogue, exactly as the optional bulk export uses it.
    """
    from local_armor_inspector.exporter import top_descriptor
    try:
        from items import vehicles as client_vehicles, makeIntCompactDescrByID
        from helpers import dependency
        from skeletons.gui.shared import IItemsCache
        nation_id, innation_id = client_vehicles.g_list.getIDsByName(type_name)
        item = dependency.instance(IItemsCache).items.getItemByCD(
            makeIntCompactDescrByID('vehicle', nation_id, innation_id))
        if item is not None and getattr(item, 'isInInventory', False):
            descr = item.descriptor
            if descr is not None:
                return descr
    except Exception:
        LOG.exception('Hangar configuration of %s unavailable; the top configuration is exported', type_name)
    return top_descriptor(type_name)


def export_picked_vehicle(type_name):
    """The page asked for a vehicle it has no model of. Game thread: the request only.

    The export thread does the rest, exactly as the hangar and battle hooks do; the
    page polls data/vehicles/<id>.js and gives up after 30 s.
    """
    if _recorder is None:
        LOG.warning('Bullba Hits: no recorder, %s cannot be exported', type_name)
        return
    _recorder.request_vehicle(picker_descriptor(type_name), 'picker')


def page_busy():
    """The page reports that the user is dragging or zooming. Game thread, a float."""
    if _recorder is None: return
    _recorder.note_busy()


def page_prioritise(types):
    """The page opened a hit whose collision models are not extracted yet."""
    if _recorder is None: return
    _recorder.prioritise(types)


def show_vehicle(handler):
    """The context-menu entry: export this vehicle and open the viewer on it.

    The handler is a VehicleContextMenuHandler; _initFlashValues stored the
    inventory id and the vehicle's intCD on it (self.vehInvID / self.vehCD), and
    getVehCD()/getVehInvID() return them.
    """
    from local_armor_inspector.exporter import vehicle_id
    from local_armor_inspector.presentation import open_in_game
    from helpers import dependency
    from skeletons.gui.shared import IItemsCache
    items = dependency.instance(IItemsCache).items
    vehicle = None
    try:
        vehicle = items.getItemByCD(handler.getVehCD())
    except Exception:
        LOG.exception('Vehicle of the context menu could not be read by compact descriptor')
    if vehicle is None:
        vehicle = items.getVehicle(handler.getVehInvID())
    descr = vehicle.descriptor
    if _recorder is not None:
        _recorder.request_vehicle(descr, 'hangar')
    open_in_game(VIEWER_PATH, 'host=game&vehicle=' + vehicle_id(descr.type.name))


def install_context_menu():
    """Append one entry to the hangar vehicle context menu.

    hangar/__init__.py getContextMenuHandlers() registers
    CONTEXT_MENU_HANDLER_TYPE.VEHICLE ('vehicle') -> VehicleContextMenuHandler, and
    ContextMenuManager.requestOptions builds that class and sends
    handler.getOptions(ctx) -> _generateOptions(ctx) to Flash, then routes the
    click back through handler.onOptionSelect(optionId). Wrapping those two class
    methods is therefore all an option needs; AbstractContextMenuHandler._makeItem
    builds the option dict (id, label, iconType, initData, submenu, linkage).

    Idempotent: a reloaded module finds its own marker and leaves the class alone.
    """
    from gui.Scaleform.daapi.view.lobby.hangar.hangar_cm_handlers import VehicleContextMenuHandler
    generate, select = VehicleContextMenuHandler._generateOptions, VehicleContextMenuHandler.onOptionSelect
    if getattr(generate, 'bullba_hits', False): return None

    def bullba_generate_options(handler, ctx=None):
        options = generate(handler, ctx)
        try:
            options = list(options or [])
            options.append(VehicleContextMenuHandler._makeItem(CONTEXT_MENU_OPTION, CONTEXT_MENU_LABEL))
        except Exception:
            LOG.exception('Bullba Hits context menu entry unavailable; the menu is unchanged')
        return options

    def bullba_option_select(handler, optionId):
        if optionId != CONTEXT_MENU_OPTION:
            return select(handler, optionId)
        try:
            show_vehicle(handler)
        except Exception:
            LOG.exception('Bullba Hits could not open the selected vehicle')
        return None

    bullba_generate_options.bullba_hits = True
    bullba_option_select.bullba_hits = True
    VehicleContextMenuHandler._generateOptions = bullba_generate_options
    VehicleContextMenuHandler.onOptionSelect = bullba_option_select
    return (VehicleContextMenuHandler, generate, select)


def remove_context_menu(installed):
    if not installed: return
    handler_class, generate, select = installed
    try:
        if getattr(handler_class._generateOptions, 'bullba_hits', False):
            handler_class._generateOptions = generate
        if getattr(handler_class.onOptionSelect, 'bullba_hits', False):
            handler_class.onOptionSelect = select
    except Exception: LOG.exception('Context menu cleanup failed')


def init():
    global _recorder, _original, _wrapper, _mods_api, _events, _context_menu
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
            _events = VehicleEvents(_recorder)
            _events.install()
        except Exception: LOG.exception('Vehicle export hooks unavailable; hit recording continues')
        try: _context_menu = install_context_menu()
        except Exception: LOG.exception('Hangar context menu unavailable; hit recording continues')
        try:
            from local_armor_inspector import presentation
            presentation.set_export_request(export_picked_vehicle)
            presentation.set_busy_request(page_busy)
            presentation.set_prioritise_request(page_prioritise)
        except Exception: LOG.exception('Page export command unavailable; hit recording continues')
        try:
            from gui.modsListApi import g_modsListApi
            _mods_api = g_modsListApi
            _mods_api.addModification(id='local.armor_inspector', name='Bullba Hits',
                description='Saved hits in an in-game window. Local files, no server.', enabled=True,
                icon='gui/maps/bullba_hits/modsListApi.png', login=False, lobby=True, callback=open_viewer)
        except Exception:
            # The panel ships with the installer; without it the hangar vehicle context menu still opens the viewer.
            LOG.exception('ModsList panel unavailable; the vehicle context menu opens ' + VIEWER_PATH)
        LOG.info('Armor Inspector %s ready', VERSION)
    except Exception:
        LOG.exception('Armor Inspector initialization failed')
        fini()


def fini():
    global _recorder, _events, _context_menu
    try:
        from local_armor_inspector import presentation
        presentation.set_export_request(None)
        presentation.set_busy_request(None)
        presentation.set_prioritise_request(None)
    except Exception: LOG.exception('Page export command cleanup failed')
    remove_context_menu(_context_menu)
    _context_menu = None
    if _events is not None:
        _events.close()
        _events = None
    if _recorder is not None:
        _recorder.enabled = False
        _recorder.telemetry.close()
        try:
            from Vehicle import Vehicle
            if Vehicle.showDamageFromShot is _wrapper: Vehicle.showDamageFromShot = _original
        except Exception: LOG.exception('Hook cleanup failed')
        _recorder.writer.close()
        _recorder = None
