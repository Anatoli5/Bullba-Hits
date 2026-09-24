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

VERSION = '0.8.0'
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
# The record of the hit hook (telemetry.wrap): the class, the name, its own dictionary entry and the wrapper.
_hit_hook = None
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
    try:
        # S3 review (22.09): the tags that put the vehicle in a group - its locks and its battle-mode tags -
        # written while this client still has the type. An event vehicle's type leaves the client with its
        # event, and the exporter's fitment backfill (full 'tags') lives only in the published copy, so this
        # short list is what a record made today keeps of them. Written even when empty: that it was read
        # is the point. vtype.tags is a small frozenset; one pass over it per recorded vehicle.
        modes = group_mode_tags()
        identity['groupTags'] = sorted(str(tag) for tag in vtype.tags if str(tag).startswith('lock') or str(tag) in modes)
    except Exception:
        pass
    return identity


# constants.BATTLE_MODE_VEHICLE_TAGS of client 2.4.0.1, the fallback when the client's own set cannot be
# read, plus maps_training, which gui Vehicle.isOnlyForMapsTrainingBattles reads outside that set
# (outputs/vehicle-classes-modes-2026-09-21.md, summary point 6).
DEFAULT_MODE_TAGS = ('event_battles', 'comp7', 'comp7_light', 'epic_battles', 'battle_royale', 'fun_random',
                     'fallout', 'bob', 'clanWarsBattles', 'maps_training')
_mode_tags = []


def group_mode_tags():
    """The battle-mode vehicle tags of the running client, read once; the known set when it has none."""
    if not _mode_tags:
        names = set(DEFAULT_MODE_TAGS)
        try:
            from constants import BATTLE_MODE_VEHICLE_TAGS
            names.update(str(tag) for tag in BATTLE_MODE_VEHICLE_TAGS)
        except Exception:
            pass
        _mode_tags.append(frozenset(names))
    return _mode_tags[0]


def constant_name(table, value):
    """The name a client constants class gives an integer, e.g. ARENA_GUI_TYPE, or None.

    Only integer attributes whose name starts with a capital count (RTS_1x1 has a small x): the
    classes also hold tuples (RANDOM_RANGE and the like) and helpers. Two names for one value are
    joined in sorted order, so the answer is stable.
    """
    names = []
    for name in dir(table):
        if not name[:1].isupper(): continue
        try: attribute = getattr(table, name)
        except Exception: continue
        if isinstance(attribute, bool) or not isinstance(attribute, int): continue
        if attribute == value: names.append(name)
    return '/'.join(sorted(names)) or None


def battle_mode(arena):
    """The battle's mode, as the client itself names it (S3, 22.09) - one small dictionary per battle.

    arena.bonusType is the authority (outputs/vehicle-classes-modes-2026-09-21.md 1.2), arena.guiType the
    sub-mode; the gameplay name is NOT one (maps training has its own, Onslaught plays on standard
    geometries too) and is kept for reference only. The names are resolved NOW, from this client's
    constants, because the ids of an event are injected by its extension at runtime and may mean
    nothing in a later client. battleModifiersDescr is the RAW descriptor the client builds
    arena.battleModifiers from (ClientArena.__init__: extraData.get('battleModifiersDescr', ()), so an
    absent key is written as the empty list the client uses), made JSON-safe - never read through the
    BattleModifiers object, whose real class exists only with the battle_modifiers extension.
    Game thread: attribute and dictionary reads only, once per battle. Every field on its own; one the
    client refuses is named in 'unavailable'.
    """
    mode = {'read':True}
    missing = []
    try:
        import constants
    except Exception:
        constants = None
    try:
        from local_armor_inspector.exporter import json_safe
    except Exception:
        json_safe = None

    def take(name, action):
        try:
            value = action()
        except Exception:
            missing.append(name)
            return
        if value is not None: mode[name] = value

    def bonus_name():
        # ARENA_BONUS_TYPE_IDS (id -> name) is the table the extensions update when they add their ids
        # (constants_utils.addArenaBonusTypesFromExtension); the class attributes are the fallback.
        bonus = mode.get('bonusType')
        if bonus is None: return None
        try: name = constants.ARENA_BONUS_TYPE_IDS.get(bonus)
        except Exception: name = None
        return str(name) if name else constant_name(constants.ARENA_BONUS_TYPE, bonus)

    def gui_label():
        if mode.get('guiType') is None: return None
        label = constants.ARENA_GUI_TYPE_LABEL.LABELS.get(mode['guiType'])
        return str(label) if label else None

    take('bonusType', lambda: int(arena.bonusType))
    take('bonusTypeName', bonus_name)
    take('guiType', lambda: int(arena.guiType))
    take('guiTypeName', lambda: None if mode.get('guiType') is None
         else constant_name(constants.ARENA_GUI_TYPE, mode['guiType']))
    take('guiLabel', gui_label)
    arena_type = getattr(arena, 'arenaType', None)
    if arena_type is not None:
        take('arenaTypeId', lambda: int(arena_type.id))
        take('gameplayName', lambda: str(arena_type.gameplayName))
        take('geometryName', lambda: str(arena_type.geometryName))
    else:
        missing.append('arenaType')
    extra = getattr(arena, 'extraData', None)
    if isinstance(extra, dict):
        for key in ('queueType', 'battleLevel'):
            if key in extra: take(key, lambda key=key: json_safe(extra[key], 64))
        take('battleModifiersDescr', lambda: json_safe(extra.get('battleModifiersDescr', ()), 20000))
    else:
        missing.extend(('queueType', 'battleLevel', 'battleModifiersDescr'))
    if missing: mode['unavailable'] = missing
    return mode


def roster_state(info, descr, json_safe):
    """Per-battle state of one roster vehicle that its type cannot give (S3, 22.09).

      maxHealth, defaultMaxHealth  descr.maxHealth / defaultMaxHealth. maxHealth is NOT the mode's HP
                                   modifier on its own: VehicleDescriptor.__updateAttributes multiplies it
                                   by miscAttrs['healthFactor'] too (field modifications, Improved
                                   Hardening), so that factor is written beside it.
      vehPostProgression,          the arena info the client builds this very descriptor from
      customRoleSlotTypeId         (ClientArena.getVehicleType subscripts both, so they are always there)
      isBot                        only when the info carries 'avatarSessionID': True when it is empty
                                   (ClientArena.__preprocessVehicleInfo). A missing key says nothing.
    Game thread, dictionary and attribute reads only; every field on its own.

    The arena's descriptor is built from the compact descriptor, the field modifications, the role slot and the
    battle modifiers only (ClientArena.getVehicleType): no equipment. Its maxHealth is not always the server's: in
    the Onslaught battle of 24.09 three of seven allies had 9.7-10.2 % less here than their Vehicle.maxHealth
    (= publicInfo.maxHealth, the replay's figure) - presumably Improved Hardening, not verified. Recorder.roster_rows
    puts the server's figure over it wherever the vehicle has been in view (maxHealthFrom 'vehicle').
    """
    state = descr_state(descr)
    state.update(seat_state(info, json_safe))
    return state


def descr_state(descr):
    """The descriptor's half of roster_state: maxHealth, defaultMaxHealth, healthFactor."""
    state = {}
    try: state['maxHealth'] = int(descr.maxHealth)
    except Exception: pass
    try: state['defaultMaxHealth'] = int(descr.defaultMaxHealth)
    except Exception: pass
    try: state['healthFactor'] = float(descr.miscAttrs['healthFactor'])
    except Exception: pass
    return state


def seat_state(info, json_safe):
    """The arena info's half of roster_state: vehPostProgression, customRoleSlotTypeId, isBot."""
    state = {}
    try: state['vehPostProgression'] = json_safe(info['vehPostProgression'], 256)
    except Exception: pass
    try: state['customRoleSlotTypeId'] = int(info['customRoleSlotTypeId'])
    except Exception: pass
    try:
        if 'avatarSessionID' in info: state['isBot'] = not info['avatarSessionID']
    except Exception: pass
    return state


# The two states of VEHICLE_MODE (constants.pyc 4151-4153, read in this client): 0 DEFAULT, 1 SIEGE.
VEHICLE_MODE_DEFAULT, VEHICLE_MODE_SIEGE = 0, 1


def mode_shell_block(descr):
    """Both modes' shells of a vehicle that is built twice (R1 of outputs/mode-shell-modifiers-2026-09-22.md).

    A vehicle tagged `siegeMode` is read from `<Name>.xml` AND `<Name>_siege_mode.xml`, and the two
    descriptors are wrapped in a CompositeVehicleDescriptor (vehicles.pyc 2850) whose __getattr__ hands
    every attribute to whichever of the two the current VEHICLE_MODE names. Six vehicles of this client
    re-declare the gun's <shots> there, so their second mode really fires another shell: five German
    `shellParamsSwitcher` tanks (normalisation, ricochet angle, alpha, HEAT jet loss) and the Gorilla's
    `lowChargeShot` (alpha, penetration, speed and the shell's effects id).

    Read-only. `defaultVehicleDescr` and `siegeVehicleDescr` are plain properties of the composite that
    the client's own garage code reads; **onSiegeStateChanged is never called here** - the client calls it
    itself on this very object for the attached vehicle (Avatar.pyc __getDetailedVehicleDescriptor), and
    the recorder stays out of that race.

    Returns None for every ordinary vehicle (one attribute read), else
    {'default': [shell], 'siege': [shell], 'same': bool}. Both lists are read ONCE per battle per
    descriptor object (Recorder.mode_blocks) because neither of the two descriptors changes while the
    battle runs; a hit only picks the list of the mode it was not fired in.
    """
    if not getattr(descr, 'hasSiegeMode', False): return None
    siege = getattr(descr, 'siegeVehicleDescr', None)
    default = getattr(descr, 'defaultVehicleDescr', None)
    if siege is None or default is None: return None
    from local_armor_inspector.armor import shot_candidates
    first, second = shot_candidates(default), shot_candidates(siege)
    return {'default': first, 'siege': second, 'same': first == second}


def mode_aim_block(descr):
    """Both modes' aim blocks of a vehicle built twice (BACKLOG 35 B5): exporter.mode_aim_block, the one function
    the characteristics file uses too (23.09, second modes M2). Kept under this name for the recorder's callers."""
    from local_armor_inspector.exporter import mode_aim_block as both
    return both(descr)


def matrix_columns(matrix, root_inverse):
    """Column-major affine transform, using API operations instead of layout guesses."""
    columns = []
    for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        columns.extend(vector(root_inverse.applyVector(matrix.applyVector(axis))))
        columns.append(0.0)
    columns.extend(vector(root_inverse.applyPoint(matrix.applyPoint((0, 0, 0)))))
    columns.append(1.0)
    return columns


def extra_part_info(idx, collisions, appearance, root, matrix):
    """What the client itself knows of a collision part beyond the static ones, for one contact on it.

    Read only with the calls the client makes for such an index (VehicleEffects.parseHitPoints and
    Vehicle.showDamageFromShot), so nothing here asks the collision component anything new
    (docs/BACKLOG.md 39): a negative index is a wheel of a wheeled vehicle - the collision component's
    own part name and the compound model's node of that name, the frame the client lays the hit
    effect in; an index above maxStaticPartIndex is a CGF prefab (the CAV mod. 71 crest, the AS-XX
    containers) linked by DynamicCollisionLinker - its parent part and getPartTransform. Both with the
    part's bounding box. Each read on its own, so one that fails costs only its field. 'matrix' is
    Math.Matrix; poses are column-major relative to the chassis, as the parts' transforms.
    """
    info = {}
    try:
        box = collisions.getBoundingBox(idx)
        info['partBounds'] = [vector(box[0]), vector(box[1])]
    except Exception:
        pass
    if idx < 0:
        try:
            name = collisions.getPartName(idx)
            if name:
                info['partName'] = str(name)
                info['partTransform'] = matrix_columns(matrix(appearance.compoundModel.node(name)), root)
        except Exception:
            pass
    elif idx > collisions.maxStaticPartIndex:
        try:
            parent = collisions.getParentPartIndex(idx)
            if parent is not None: info['parentPart'] = int(parent)
        except Exception:
            pass
        try:
            info['partTransform'] = matrix_columns(matrix(collisions.getPartTransform(idx)), root)
        except Exception:
            pass
    return info


def rest_transforms(descr):
    """Collision-part transforms of a vehicle descriptor in its rest pose.

    A hit records the target's parts from the live entity; the shooter has no
    entity here, only his descriptor, so his parts are stacked the way the client
    itself stacks them (vehicles.py VehicleDescr.__updateAttributes): the chassis
    is the frame, the hull sits at chassis.hullPosition, the turret on the hull at
    hull.turretPositions[0], the gun in the turret at turret.gunPosition. No
    rotation: the collision models are authored in that pose - except a gun with a static pitch, which is
    drawn in it (23.09). Order follows PARTS. The one writer is exporter.rest_columns.
    """
    from local_armor_inspector.exporter import rest_columns
    return rest_columns(descr)


class Writer(object):
    def __init__(self, folder, exporter=None):
        self.folder = folder
        self.exporter = exporter
        if not os.path.isdir(folder): os.makedirs(folder)
        self.queue = queue.Queue(1024)
        self.dropped = 0
        self.failed = 0
        self.stopping = threading.Event()
        self.export_deadline = None
        self.raw_done = threading.Event()
        self.dirty_lock = threading.Lock()
        self.dirty = {}
        self.encoders = {}
        # File name -> its size after the last clean append of this session. Writer thread only.
        self.ends = {}
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
        """Queue one record; False when the queue is full and the record is dropped."""
        try: self.queue.put_nowait((name, record))
        except queue.Full:
            self.dropped += 1
            LOG.error('Record queue full; dropped=%s', self.dropped)
            return False
        return True

    def put_export(self, name, payload):
        """One message for the export thread. Game thread, never blocking.

        Control messages have a separate bounded queue. Durable battle updates
        are coalesced byte ranges, so a burst of hits cannot fill this queue.
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

    def mark_dirty(self, name, start, end):
        """Coalesce durable byte ranges without carrying full records twice."""
        with self.dirty_lock:
            previous = self.dirty.get(name)
            if previous is None:
                self.dirty[name] = (start, end)
            else:
                self.dirty[name] = (min(previous[0], start), max(previous[1], end))

    def take_dirty(self):
        with self.dirty_lock:
            dirty, self.dirty = self.dirty, {}
        return dirty

    def has_dirty(self):
        with self.dirty_lock:
            return bool(self.dirty)

    def run(self):
        try: from local_armor_inspector.records import RecordEncoder
        except ImportError: from mod.local_armor_inspector.records import RecordEncoder
        try:
            while not self.stopping.is_set() or not self.queue.empty():
                try: name, record = self.queue.get(timeout=0.1)
                except queue.Empty: continue
                encoder = self.encoders.setdefault(name, RecordEncoder())
                try:
                    encoded = encoder.encode(record)
                    line = (json.dumps(encoded, ensure_ascii=True, allow_nan=False,
                                       separators=(',', ':'))+'\n').encode('utf-8')
                    path = os.path.join(self.folder, name+'.jsonl')
                    # A failed earlier append may have left a partial tail. End it
                    # as an unreadable row so this complete record remains recoverable.
                    # The tail is read only when the file is new to this session, when the last
                    # append failed (its mark is taken off before writing) or when the size is not
                    # the one our last clean append left: anything else ends in our own newline.
                    known = self.ends.pop(name, None)
                    try: size = os.path.getsize(path)
                    except OSError: size = None
                    if known is None or size != known:
                        if size:
                            with open(path, 'rb') as existing:
                                existing.seek(-1, os.SEEK_END)
                                partial = existing.read(1) != b'\n'
                            if partial:
                                with open(path, 'ab') as stream: stream.write(b'\n')
                    with open(path, 'ab') as stream:
                        stream.write(line)
                        stream.flush()
                        end = stream.tell()
                    # A binary append puts the whole line right before the end.
                    start = end - len(line)
                    self.ends[name] = end
                    encoder.commit()
                    if self.exporter is not None: self.mark_dirty(name, start, end)
                except Exception:
                    encoder.rollback()
                    self.failed += 1
                    LOG.exception('Could not persist hit; failed=%s', self.failed)
                finally: self.queue.task_done()
        finally:
            self.raw_done.set()

    def run_export(self):
        try: self.exporter.setup()
        except Exception:
            LOG.exception('HTML export setup failed; raw recording continues')
            self.exporter = None
            return
        while True:
            message = None
            try: message = self.export_queue.get(timeout=0.05)
            except queue.Empty: pass
            if message is not None:
                name, payload = message
                try:
                    if name == 'vehicle': self.exporter.request_vehicle_export(payload)
                    elif name == 'prioritise': self.exporter.prioritise(payload)
                    elif name == 'ttx': self.exporter.request_ttx(payload)
                except Exception: LOG.exception('HTML export command failed')
                finally: self.export_queue.task_done()
            dirty = self.take_dirty()
            try:
                if hasattr(self.exporter, 'record_written'):
                    for name, bounds in dirty.items():
                        self.exporter.record_written(name, bounds[0], bounds[1])
                if hasattr(self.exporter, 'idle'): self.exporter.idle()
                elif hasattr(self.exporter, 'flush'): self.exporter.flush()
            except Exception:
                for name, bounds in dirty.items(): self.mark_dirty(name, bounds[0], bounds[1])
                LOG.exception('Deferred export failed; raw events are retained')
            if (self.raw_done.is_set() and self.export_queue.empty() and not self.has_dirty()
                    and (not hasattr(self.exporter, 'has_pending_records')
                         or not self.exporter.has_pending_records())):
                try:
                    if hasattr(self.exporter, 'finish'): self.exporter.finish()
                    elif hasattr(self.exporter, 'flush'): self.exporter.flush(force=True)
                except Exception: LOG.exception('Final HTML export failed; raw events are retained')
                if (not hasattr(self.exporter, 'has_pending_publish')
                        or not self.exporter.has_pending_publish()): break
                if self.export_deadline is not None and time.time() >= self.export_deadline:
                    LOG.warning('Final HTML publication remains pending; raw events are retained')
                    break

    def close(self):
        self.export_deadline = time.time() + 2.0
        self.stopping.set()
        self.thread.join(2.0)
        if self.thread.is_alive(): LOG.warning('Writer still draining at shutdown')
        if self.export_thread is not None:
            self.export_thread.join(2.0)
            if self.export_thread.is_alive(): LOG.warning('HTML exporter still draining at shutdown')


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
    returns vehicles.VehicleDescr(compactDescr=..., extData=...) - the extData carries the
    field modifications, the role slot and the battle modifiers of this battle (2.4.0.1).

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
        # The motion sampler lives exactly as long as the battle does: armed here, stopped when the
        # avatar stops being the player. It never runs in the hangar and never per frame.
        try: self.recorder.motion.start()
        except Exception: LOG.exception('Motion sampler unavailable; hit recording continues')
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
            arena.onVehicleAdded += self.on_vehicle_info
            # Every change of a vehicle's arena info (AvatarVehiclesInfoBase.setNested_vehiclesInfo ->
            # ClientArena.updateVehicleInfo, which rebuilds 'vehicleType' from a new compDescr, then
            # arena.onVehicleUpdated): the Onslaught vehicle choice of the first seconds and the enemy types
            # the arena learns later. Without it the roster kept what the first list said (24.09).
            updated = getattr(arena, 'onVehicleUpdated', None)
            if updated is not None: updated += self.on_vehicle_info
            self.arena = arena
            self.on_vehicle_list()
        except Exception: LOG.exception('Arena vehicle export hooks unavailable')

    def detach_arena(self):
        try:
            if self.arena is not None:
                self.arena.onNewVehicleListReceived -= self.on_vehicle_list
                self.arena.onVehicleAdded -= self.on_vehicle_info
                updated = getattr(self.arena, 'onVehicleUpdated', None)
                if updated is not None: updated -= self.on_vehicle_info
        except Exception: LOG.exception('Arena hook cleanup failed')
        self.arena = None

    def on_avatar_become_non_player(self, *args):
        try: self.recorder.in_battle = False
        except Exception: LOG.exception('Battle state could not be noted')
        try: self.recorder.motion.stop()
        except Exception: LOG.exception('Motion sampler stop failed')
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

    def on_vehicle_info(self, vehicle_id, *args):
        """A vehicle added to the arena list or its arena info changed: note it for export, write the roster (the
        recorder writes it only when a row really changed, so a death or a frag count costs no record)."""
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
        # Static mode block of a shooter, once per battle and per descriptor object (optimisation
        # plan A4b): the second descriptor of a siege vehicle never changes while the battle runs,
        # so its shells and the gun's mechanics are read once and every later hit of that shooter
        # copies them. Keyed by id() with the descriptor itself kept in the value, so the key can
        # never be reused by another object; emptied in ensure_battle when the battle changes.
        self.mode_blocks = {}
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
        # The roster of the battle being written (all three emptied by ensure_battle when the battle changes):
        # the rows of the last roster record, to write a new one only when a row changed (REC-11), and what the
        # vehicles in view said of themselves - {vehicle id: (key, facts)}, see note_vehicle.
        self.roster_known = False
        self.roster_last = None
        self.roster_seen = {}
        # The reader of the gun mechanics' live state is bound once here, beside the telemetry it lives in,
        # so the hit path does not run an import statement per hit (22.09).
        from local_armor_inspector.telemetry import ShotTelemetry, mechanic_state, designator_mark, recording
        # The one gate of every recording path (REC-01, 24.09): the hit capture and the roster here, the shot
        # telemetry, the motion sampler and the crit log there. A replay or a spectated battle opens no file.
        self.recording = recording
        self.telemetry = ShotTelemetry(self)
        self.mechanic_state = mechanic_state
        self.designator_mark = designator_mark
        # The motion history of every shooter, in memory only; started and stopped by the battle
        # hooks of VehicleEvents. It reuses this recorder's BigWorld handle and the telemetry's own
        # "are we recording" gate, so it can never sample where the telemetry would not record.
        from local_armor_inspector.motion import MotionSampler, PERIOD as MOTION_PERIOD
        self.motion = MotionSampler(self)
        self.motion_period = MOTION_PERIOD
        from local_armor_inspector.crit_log import CritLog
        self.crits = CritLog(self)

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

    def request_ttx(self, type_name):
        """The page asks for the characteristics file of one type (data/ttx/<id>.js). Game thread: the
        string goes through the export queue; the check, the build and the file belong to that thread."""
        if type_name: self.writer.put_export('ttx', str(type_name))

    def note_roster(self, arena, player):
        """The battle's roster as one record: id, player, vehicle and team of every vehicle known so far.

        Contract for readers (unchanged since 0.7.9, spelled out 24.09): every roster record is the WHOLE roster
        as known at that moment and supersedes the ones before it; a reader keeps the last one of the battle
        (exporter read_battle / apply_record). Rows only gain or correct fields over a battle - the vehicle chosen
        in an Onslaught battle's first seconds, an enemy type the arena learns later, the server's own maximum
        health of a vehicle once it has been in view - so the last record is the most complete one.

        Written when the arena list changes, when a vehicle's arena info changes (VehicleEvents) and when a vehicle
        in view tells something new about itself (note_vehicle) - and only when a row really differs from the last
        record written (REC-11: up to 39 identical rosters a battle before 24.09). The viewer lists the allies from
        it and takes the target's health from it. Game thread: dictionary reads only, no package access.
        """
        if arena is None or not self.recording(self, player): return
        player_id = getattr(player, 'playerVehicleID', None)
        # The first arena list can arrive before the client knows its own vehicle (playerVehicleID 0, Tundra
        # 18.09): a roster without the player is worthless and would also stamp 0 into the battle header, so it
        # waits - the next list change or the first recorded hit writes it.
        if not player_id or not getattr(arena, 'vehicles', None): return
        if not self.ensure_battle(player): return
        vehicles, player_team = self.roster_rows(arena, player_id)
        if (player_team, vehicles) == self.roster_last:
            self.roster_known = True
            return
        if self.writer.put(self.file, {'schema':1, 'type':'roster', 'receivedAt':time.time(),
                'playerVehicleId':player_id, 'playerTeam':player_team, 'vehicles':vehicles}):
            self.roster_last = (player_team, vehicles)
        self.roster_known = True

    def roster_rows(self, arena, player_id):
        """The rows of the roster and the player's team: the arena info of every vehicle, and over it what the
        vehicle itself said when it was in view (note_vehicle).

          arena type          name, type, roster_state (S3) and maxHealthFrom 'descriptor' - the arena
                              descriptor's figure, which has no equipment in it
          + the vehicle, same type
                              maxHealth replaced by the server's figure, maxHealthFrom 'vehicle'
          + the vehicle, another type
                              ignored: the arena info is the one the server updates with a new vehicle choice
                              (compDescr), while the entity's typeDescriptor changes only when the client
                              redraws it - the next note_vehicle after that brings the matching figure
          no arena type, the vehicle
                              name, type, maxHealth (server), defaultMaxHealth and healthFactor of the vehicle's
                              own descriptor, maxHealthFrom 'vehicle', isBot from the arena info (an Onslaught
                              enemy before the arena learns its type)
          neither             id, player, team only
        """
        vehicles, player_team = [], None
        try: from local_armor_inspector.exporter import json_safe
        except Exception: json_safe = None
        seen = self.roster_seen
        for vehicle_id, info in list(getattr(arena, 'vehicles', {}).items()):
            try:
                info = info or {}
                descr = info.get('vehicleType')
                row = {'id':vehicle_id, 'player':info.get('name'), 'team':info.get('team')}
                facts = seen.get(vehicle_id)
                facts = facts[1] if facts is not None else None
                if descr is not None:
                    row['name'] = descr.type.shortUserString
                    row['type'] = descr.type.name
                    # S3 (22.09): what this battle did to the vehicle, beside who it is.
                    try: row.update(roster_state(info, descr, json_safe))
                    except Exception: pass
                    if (facts is not None and facts['type'] == row['type']
                            and facts.get('maxHealthFrom') == 'vehicle'):
                        row['maxHealth'] = facts['maxHealth']
                        row['maxHealthFrom'] = 'vehicle'
                    elif 'maxHealth' in row: row['maxHealthFrom'] = 'descriptor'
                elif facts is not None:
                    row.update(facts)
                    try:
                        bot = seat_state(info, json_safe).get('isBot')
                        if bot is not None: row['isBot'] = bot
                    except Exception: pass
                vehicles.append(row)
                if vehicle_id == player_id: player_team = info.get('team')
            except Exception: LOG.exception('Roster vehicle could not be listed')
        return vehicles, player_team

    def note_vehicle(self, player, vehicle):
        """A vehicle entity in view: its type and the server's own maximum health (Vehicle.maxHealth, which is
        publicInfo.maxHealth - the figure the replay and the battle results carry), kept for its roster row.
        True when something new was kept: the caller then writes the roster once (note_roster) for all the
        vehicles of its pass, not one record per vehicle.

        Called by the motion sampler for every vehicle it looks at (5 Hz): the fast path is one tuple and one
        dictionary lookup; only a vehicle that is new or changed (another type after an Onslaught choice, a new
        maximum) costs the gate and the facts. The key carries the arena id, so nothing of a previous battle can
        match. Never raises."""
        try:
            descr = vehicle.typeDescriptor
            key = (player.arena.arenaUniqueID, descr.type.name, vehicle.maxHealth)
            entry = self.roster_seen.get(vehicle.id)
        except Exception: return False   # an entity still being set up: asked again on the next tick, silently
        if entry is not None and entry[0] == key: return False
        try:
            if not self.recording(self, player) or not getattr(player, 'playerVehicleID', None): return False
            # Opens (or switches to) this battle BEFORE the facts are kept: a new battle empties roster_seen.
            if not self.ensure_battle(player): return False
            facts = {'name':descr.type.shortUserString, 'type':descr.type.name}
            facts.update(descr_state(descr))
            try: server = int(key[2])
            except (TypeError, ValueError): server = 0
            if server > 0:
                facts['maxHealth'] = server
                facts['maxHealthFrom'] = 'vehicle'
            elif 'maxHealth' in facts: facts['maxHealthFrom'] = 'descriptor'
            self.roster_seen[vehicle.id] = (key, facts)
            return True
        except Exception:
            # Kept as seen without facts: the same failure is not logged again five times a second.
            self.roster_seen[vehicle.id] = (key, None)
            LOG.debug('Roster vehicle facts unavailable', exc_info=True)
            return False

    def ensure_battle(self, player):
        arena = getattr(player, 'arena', None)
        if arena is None: return False
        battle_id = str(arena.arenaUniqueID)
        if self.battle != battle_id:
            filename = battle_id+'-'+self.session
            arena_type = getattr(arena, 'arenaType', None)
            # The battle's mode (S3, 22.09). A failure costs the block, never the battle: the page reads a
            # header without it - every battle recorded before - as a mode it does not know.
            try: mode = battle_mode(arena)
            except Exception: mode = {'read':False, 'error':'Battle mode unavailable'}
            # 'source' says who produced the battle: this recorder writes 'live'. An offline parser
            # of a .wotreplay will write its own value one day, so no reader may branch on it and
            # none may require it - every battle recorded before this build has no such field.
            self.writer.put(filename, {'schema':1, 'type':'battle', 'id':filename, 'source':'live',
                'arenaId':battle_id, 'startedAt':time.time(), 'playerVehicleId':player.playerVehicleID,
                'map':getattr(arena_type, 'name', None) or 'Unknown map',
                'clientVersion':self.version, 'recorderVersion':VERSION, 'mode':mode,
                # Seconds between two motion samples of this battle. The layout of a sample rides
                # on every attached buffer; the period belongs to the battle, so it is written once.
                'motionPeriod':self.motion_period})
            self.battle = battle_id
            self.seq = 0
            self.file = filename
            self.roster_known = False
            self.roster_last = None
            self.roster_seen = {}
            self.mode_blocks = {}
        return True

    def capture(self, vehicle, attackerID, hitPoints, effectsIndex, prefabEffIndex,
                damage, damageFactor, lastMaterialIsShield, shellVelocity, gunInstallationIndex):
        if not self.enabled: return
        import Math
        from VehicleEffects import DamageFromShotDecoder as Decoder
        player = self.bw.player()
        if not self.recording(self, player): return
        arena = player.arena
        player_id = getattr(player, 'playerVehicleID', None)
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
                    # The XML names of the mounted gun and turret: the exact pair among the configs of the
                    # shooter's data/ttx/<id>.js. Static, so the snapshot keeps them in its vehicle table.
                    record['attacker']['gunName'] = attacker.gun.name
                    record['attacker']['turretName'] = attacker.turret.name
                except Exception:
                    pass
                try:
                    # Aiming parameters of the shooter (gun, turret and chassis dispersion
                    # factors, aiming time, rotation and top speeds): the page recomputes the
                    # client's own dispersion circle for a state the user picks. Exactly the
                    # block the exporter writes for a catalogue vehicle, so a hit and a browsed
                    # vehicle carry the same fields; older records get it from its backfill.
                    from local_armor_inspector.exporter import aim_block
                    block = aim_block(attacker)
                    if block: record['attacker']['aim'] = block
                except Exception:
                    record['warnings'].append('Shooter aim parameters unavailable')
                try:
                    # The shooter's own collision parts (0.6.34), so the viewer can swap the roles and
                    # draw his armour. There is no live entity for him here, only the descriptor, so the
                    # parts take the rest pose in the chassis frame instead of a recorded transform.
                    from local_armor_inspector.armor import live_materials
                    from local_armor_inspector.exporter import static_parts
                    transforms = rest_transforms(attacker)
                    parts = []
                    # Every static collision part: the four, then an extra track pair in the chassis' place.
                    for idx, name, component in static_parts(attacker):
                        part = {'id':idx, 'name':name}
                        try:
                            part['armor'] = live_materials(component)
                            part['armorSource'] = 'live vehicle descriptor'
                        except Exception:
                            # The export worker may recover stock metadata for this version.
                            pass
                        try:
                            part['resource'] = component.hitTesterManager.activeHitTester.bspModelName
                            part['transform'] = transforms[idx if idx < len(transforms) else 0]
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
            # The shell comes from the gun that fired: slot 0 is the main gun, slot 1 the secondary (ability)
            # gun of a vehicle that has one. The full list offers every gun's shells for comparison.
            if attacker is not None:
                record['shellCandidates'] = shot_candidates(attacker, effectsIndex, gunInstallationIndex)
                record['availableShells'] = shot_candidates(attacker)
                record['shellStatus'] = 'matched' if record['shellCandidates'] else 'no matching shell effects'
            else:
                record['shellStatus'] = 'attacker descriptor unavailable'
        except Exception:
            record['shellStatus'] = 'shell parameter extraction failed'
            LOG.exception('Shell parameters unavailable; hit is retained')
        # R1: the shells of the shooter's OTHER mode, beside the ones above and never instead of them.
        # 'availableShells' keeps the one meaning it has always had - the shells of the descriptor the
        # client handed us - and 'vehicleMode' now says which of the two modes that descriptor was in,
        # so the page can label both lists instead of guessing. Written only for the six vehicles whose
        # second mode really changes a shell; the block itself is read once per battle (mode_blocks).
        if attacker is not None and 'attacker' in record:
            key = id(attacker)
            block = self.mode_blocks.get(key)
            if block is None or block['descr'] is not attacker:
                block = {'descr':attacker}
                self.mode_blocks[key] = block
            try:
                if 'shells' not in block: block['shells'] = mode_shell_block(attacker)
                shells = block['shells']
                if shells is not None:
                    mode = int(getattr(attacker, 'vehicleMode', VEHICLE_MODE_DEFAULT))
                    record['attacker']['vehicleMode'] = mode
                    if not shells['same']:
                        other = VEHICLE_MODE_DEFAULT if mode == VEHICLE_MODE_SIEGE else VEHICLE_MODE_SIEGE
                        record['attacker']['modeShells'] = shells['default' if other == VEHICLE_MODE_DEFAULT else 'siege']
                        record['attacker']['modeShellsMode'] = other
                        record['attacker']['modeShellsFrom'] = ('default descriptor' if other == VEHICLE_MODE_DEFAULT
                                                                else 'siege descriptor')
            except Exception:
                record['warnings'].append('Shooter second-mode shells unavailable')
            # B5 (23.09): the aim block of the other mode, the same way and from the same cache entry - read once
            # per battle per descriptor, written only where the two modes' circles differ. Its own guard, so a
            # failure here costs this field and never the shells above.
            try:
                if 'aims' not in block:
                    # A descriptor that fails once fails every time: remembered, so it costs no rebuild per hit.
                    try: block['aims'] = mode_aim_block(attacker)
                    except Exception: block['aims'] = False
                aims = block['aims']
                if aims is False: raise ValueError('Second-mode aim block failed')
                if aims is not None and not aims['same']:
                    mode = int(getattr(attacker, 'vehicleMode', VEHICLE_MODE_DEFAULT))
                    other = VEHICLE_MODE_DEFAULT if mode == VEHICLE_MODE_SIEGE else VEHICLE_MODE_SIEGE
                    second = aims['default' if other == VEHICLE_MODE_DEFAULT else 'siege']
                    if second:
                        record['attacker']['vehicleMode'] = mode
                        record['attacker']['modeAim'] = second
                        record['attacker']['modeAimMode'] = other
            except Exception:
                record['warnings'].append('Shooter second-mode aim unavailable')
        for hit in hitPoints:
            record['rawHitPoints'].append({'networkID':str(hit['networkID']), 'segment':str(hit['segment']), 'params':str(hit['params'])})
        # Persist even when geometry cannot be recovered from a departed entity.
        try:
            descr = vehicle.typeDescriptor
            # Packed once and reused for the pitch-limit cache key below (optimisation plan A4a).
            compact = descr.makeCompactDescr()
            record['target'] = {'name':descr.type.shortUserString, 'type':descr.type.name,
                'compactDescriptor':base64.b64encode(compact).decode('ascii'), 'parts':[]}
            record['target'].update(vehicle_identity(descr))
            try:
                # Spall-liner factor of the target: 1.0 without a liner, higher with one. The page divides the
                # non-penetration HE damage by it; a client without the attribute simply leaves the field out.
                record['target']['linerFactor'] = float(descr.miscAttrs.get('antifragmentationLiningFactor', 1.0))
            except Exception:
                pass
            # BACKLOG 38: the leKpz Borkenkafer's mark on the TARGET at the impact - every shell deals a marked
            # vehicle x1.1 (x1.15) from any shooter, above the page's damage window. One lookup on the entity this
            # hit lands on, beside the reads above; no hook. A live field of the hit (records.LIVE_VEHICLE_KEYS).
            try:
                mark = self.designator_mark(vehicle)
                if mark: record['target']['designatorMark'] = mark
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
                # One shared table per gun configuration; the encoder writes it once per file and
                # every later hit carries only its fingerprint.
                record['target']['gunPitchLimits'] = gun_limits(descr, compact)
            except Exception:
                record['warnings'].append('Gun pitch limits unavailable')
            # Every static collision part (exporter.static_parts): the four, then the outer track pair of a vehicle
            # with double tracks as part 4. Only an index the list does not know keeps the warning below.
            from local_armor_inspector.exporter import static_parts, EXTRA_PARTS_WARNING
            for idx, name, component in static_parts(descr):
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
            known = set(part['id'] for part in record['target']['parts'])
            if collisions.maxStaticPartIndex >= len(known):
                record['warnings'].append(EXTRA_PARTS_WARNING)
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
                    if idx not in known:
                        point['status'] = 'unsupported-part'
                        # A wheel or an armoured prefab: its name, parent and pose at impact, so the part can be
                        # identified and placed later (docs/BACKLOG.md 39). Only for such a point - rare.
                        point.update(extra_part_info(idx, collisions, vehicle.appearance, root, Math.Matrix))
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
                # R2: the shooter's own siege state, from the entity the line above already looked up.
                # Vehicle.siegeState is UINT8/ALL_CLIENTS (entity_defs/Vehicle.def), so it is there for
                # every vehicle in the area of interest, the player's own included. It is the state AT
                # IMPACT, up to a second after the shot - never call it the mode of the shot. Written
                # only for a vehicle that has the two modes, and only when the attacker block exists.
                try:
                    if 'attacker' in record and record['attacker'].get('vehicleMode') is not None:
                        record['attacker']['siegeStateAtImpact'] = int(entity.siegeState)
                except Exception: pass
                # The gun mechanics of the shooter, from the same entity and with the same warning: this
                # is the state AT IMPACT, up to a second after the shot, so it is the FALLBACK - the
                # tracer's own 'gunState' is the reading that decides, exactly as for the siege state.
                try:
                    if 'attacker' in record:
                        state = self.mechanic_state(entity, attackerID == player_id)
                        if state: record['attacker']['gunStateAtImpact'] = state
                except Exception: pass
            telemetry = self.telemetry
            record['traceCandidates'] = [t['id'] for t in telemetry.tracers.values()
                if t['shooterId'] == attackerID and t['effectsIndex'] == effectsIndex
                and 0 <= time.time()-t['receivedAt'] < 10]
        except Exception: pass
        # The shooter's last six seconds, for a shot that hit the PLAYER (docs/BACKLOG.md row 28).
        # Only for an incoming hit: the player's own shots carry it on their tracer, and putting it
        # on every hit between two other vehicles would grow the file for nothing. Nothing is
        # sampled here - this is a copy of what the sampler already holds, and it stands outside the
        # block above so that a missing attacker entity cannot take it away.
        try:
            if record['direction'] == 'incoming' and 'attacker' in record:
                motion = self.motion.history(attackerID)
                if motion: record['attacker']['motion'] = motion
        except Exception: LOG.debug('Attacker motion history unavailable', exc_info=True)
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


def page_ttx(type_name):
    """The page has no current characteristics file of this type. Game thread: the request only."""
    if _recorder is None: return
    _recorder.request_ttx(type_name)


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
    from local_armor_inspector.telemetry import wrap
    if getattr(VehicleContextMenuHandler._generateOptions, 'bullba_hits', False): return None

    def make_generate(generate):
        def bullba_generate_options(handler, ctx=None):
            options = generate(handler, ctx)
            try:
                options = list(options or [])
                options.append(VehicleContextMenuHandler._makeItem(CONTEXT_MENU_OPTION, CONTEXT_MENU_LABEL))
            except Exception:
                LOG.exception('Bullba Hits context menu entry unavailable; the menu is unchanged')
            return options
        bullba_generate_options.bullba_hits = True
        return bullba_generate_options

    def make_select(select):
        def bullba_option_select(handler, optionId):
            if optionId != CONTEXT_MENU_OPTION:
                return select(handler, optionId)
            try:
                show_vehicle(handler)
            except Exception:
                LOG.exception('Bullba Hits could not open the selected vehicle')
            return None
        bullba_option_select.bullba_hits = True
        return bullba_option_select

    # The recorder's one wrapper (telemetry.wrap, REC-10): remove_context_menu puts back the class's own entries -
    # onOptionSelect is inherited, so it is removed from the subclass rather than copied onto it.
    hooks = [wrap(VehicleContextMenuHandler, '_generateOptions', make_generate),
             wrap(VehicleContextMenuHandler, 'onOptionSelect', make_select)]
    return [hook for hook in hooks if hook is not None]


def remove_context_menu(installed):
    if not installed: return
    try:
        from local_armor_inspector.telemetry import unwrap
        unwrap(installed)
    except Exception: LOG.exception('Context menu cleanup failed')


def init():
    global _recorder, _hit_hook, _mods_api, _events, _context_menu
    if _recorder is not None: return
    try:
        from Vehicle import Vehicle
        from local_armor_inspector.telemetry import wrap
        _recorder = Recorder(os.path.join('mods', 'configs', 'local.armor_inspector', 'battles'))
        recorder = _recorder
        def make(original):
            def wrapper(vehicle, *args, **kwargs):
                try: recorder.capture(vehicle, *args, **kwargs)
                except Exception: LOG.exception('Recorder failed; game handler continues')
                return original(vehicle, *args, **kwargs)
            return wrapper
        # The same wrapper as every other hook of the recorder (REC-10): fini() puts back the class's own entry.
        _hit_hook = wrap(Vehicle, 'showDamageFromShot', make)
        if _hit_hook is None: raise AttributeError('Vehicle.showDamageFromShot is missing')
        try: _recorder.telemetry.install()
        except Exception: LOG.exception('Aim telemetry hooks unavailable; hit recording continues')
        try: _recorder.crits.install()
        except Exception: LOG.exception('Crit hooks unavailable; hit recording continues')
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
            presentation.set_ttx_request(page_ttx)
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
    global _recorder, _hit_hook, _events, _context_menu
    try:
        from local_armor_inspector import presentation
        presentation.set_export_request(None)
        presentation.set_busy_request(None)
        presentation.set_prioritise_request(None)
        presentation.set_ttx_request(None)
    except Exception: LOG.exception('Page export command cleanup failed')
    remove_context_menu(_context_menu)
    _context_menu = None
    if _events is not None:
        _events.close()
        _events = None
    if _recorder is not None:
        _recorder.enabled = False
        _recorder.telemetry.close()
        _recorder.crits.close()
        try: _recorder.motion.stop()
        except Exception: LOG.exception('Motion sampler stop failed')
        try:
            from local_armor_inspector.telemetry import unwrap
            if _hit_hook is not None: unwrap([_hit_hook])
        except Exception: LOG.exception('Hook cleanup failed')
        _hit_hook = None
        _recorder.writer.close()
        _recorder = None
