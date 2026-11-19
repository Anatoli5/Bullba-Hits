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

VERSION = '1.11'
VIEWER_PATH = os.path.join('mods', 'configs', 'local.armor_inspector', 'Viewer.html')
LOG = logging.getLogger('local.armor_inspector')
PARTS = ('chassis', 'hull', 'turret', 'gun')
CONTEXT_MENU_OPTION = 'bullbaHits'
CONTEXT_MENU_LABEL = 'Bullba Hits'
# How long one 'busy' message from the page holds the deferred work back. The page
# repeats it at most once a second while the user drags or zooms, so two seconds
# covers the gap between two messages and expires on its own afterwards.
BUSY_SECONDS = 2.0
# How long one 'open' message from the page counts it open (24.09, the fast TTX sweep). The page sends one with every
# poll of its data, every 2-5 s; a page closed or navigated away stops sending and the sweep goes slow again.
PAGE_OPEN_SECONDS = 12.0
# The replay job waits for the game's own loads (BACKLOG 84; outputs/replay-job-cost-1.08-2026-11-12.md: its slices during
# the return to the hangar were 2-7.5 s of waiting for 0.1-0.3 s of work). The hangar: from leaving a battle or the space
# starting to load (IHangarSpace.onSpaceCreating) until the space is created (onSpaceCreate, fired by HangarSpace.__spaceDone
# once BigWorld.spaceLoadStatus() reaches 1 and the virtual texture is drawn - 2.4.1.1 bytecode, 12.11) and HANGAR_SETTLE
# more for the hangar's vehicle; without that signal HANGAR_FALLBACK after it began, so a battle is never left waiting for
# good. The page: from the window's open until the browser's onLoadEnd and PAGE_LOAD_SETTLE more, at most
# PAGE_LOAD_FALLBACK (the open's own check, TRACE_VIEW_WAIT, is 20 s too). The settle and fallback values are guesses; the
# replay job's cost line says when its first slice came against the hangar's signal.
HANGAR_SETTLE = 3.0
HANGAR_FALLBACK = 60.0
PAGE_LOAD_SETTLE = 2.0
PAGE_LOAD_FALLBACK = 20.0
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
        from local_armor_inspector.exporter import group_mode_tags
        modes = group_mode_tags()
        identity['groupTags'] = sorted(str(tag) for tag in vtype.tags if str(tag).startswith('lock') or str(tag) in modes)
    except Exception:
        pass
    return identity


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


# --- what the recorder writes in a battle whose replay is confirmed (BACKLOG 87, the user's decision 11.11.2026) -----------
# The replay is the source of every event of a battle; in such a battle the recorder keeps the two snapshots the page shows
# beside the scene rebuilt from the replay - the own shot (command, own tracers, gunAfterShot) and the shown hit - with the
# battle header and the roster. It writes no crit record and no tracer, stop or explosion of another vehicle, and records
# no end of its own shells (the replay has every one of them). Everywhere else it records everything, as before.
#
# THE ONE LIST of the battle modes whose replay is confirmed: bonusType -> the name the client gives it (both must agree).
# Evidence, 11.11.2026: the 33 battles of 1.06 on 2.4.1.1 #992 all went through the replay path and matched - 15 random
# (1 REGULAR), 13 tournament (14 TOURNAMENT_REGULAR), 5 training (2 TRAINING): the live record had no hit, health change,
# tracer or shell stop that the replay lacked (docs/KNOWLEDGE.md section 18). A mode not listed here has not gone through
# the replay path: recorded in full.
REPLAY_CONFIRMED_MODES = {1:'REGULAR', 2:'TRAINING', 14:'TOURNAMENT_REGULAR'}
# The client those 33 battles were played on: <version> of version.xml. Must equal tools/client_version.VERSION_XML
# (tests/test_recorder_scope.py); another client is recorded in full until the replay path is checked on it.
REPLAY_CONFIRMED_CLIENT = 'v.2.4.1.1 #992'
# Value of the battle header's 'recording' for such a battle (replay_battle.SNAPSHOTS reads it); a full battle has no key.
RECORDING_SNAPSHOTS = 'snapshots'


def client_build(version_text):
    """'v.2.4.1.1 #992' out of the text of version.xml, or None."""
    import re
    found = re.search(r'<version>\s*([^<]*?)\s*</version>', version_text or '')
    return found.group(1) if found else None


def recording_scope(mode, version_text, replay_recording):
    """(snapshots only, why) of a battle: True only when its mode is in REPLAY_CONFIRMED_MODES (id and name), a replay
    recording runs at its start and the client is REPLAY_CONFIRMED_CLIENT. `why` says what decided it - for a full
    battle the first condition that failed. Pure: the recorder asks it once per battle (Recorder.snapshots_only)."""
    mode = mode if isinstance(mode, dict) else {}
    bonus, name = mode.get('bonusType'), mode.get('bonusTypeName')
    if bonus not in REPLAY_CONFIRMED_MODES or REPLAY_CONFIRMED_MODES[bonus] != name:
        return False, 'mode %s (bonusType %s) has not gone through the replay path' % (name, bonus)
    client = client_build(version_text)
    if client != REPLAY_CONFIRMED_CLIENT:
        return False, 'client %s is not the one the replay path was checked on (%s)' % (client, REPLAY_CONFIRMED_CLIENT)
    if replay_recording is not True:
        return False, 'no replay recording at the battle start (%s)' % (replay_recording,)
    return True, 'mode %s, replay recording, client %s' % (name, client)


def replay_recording(recorder):
    """True when the game records this battle's replay and the mod's replay source copies it; otherwise what was found
    (None: the controller says nothing). Attribute reads only (replay_source.controller, BattleReplay.g_replayCtrl)."""
    if getattr(recorder, 'replay', None) is None: return 'no replay source'
    try:
        from local_armor_inspector.replay_source import controller, playing
        ctrl = controller()
        if ctrl is None: return 'no replay controller'
        if playing(ctrl): return 'a replay is being played'
        recording = getattr(ctrl, 'isRecording', None)
        return bool(recording) if isinstance(recording, (bool, int)) else recording
    except Exception:
        LOG.debug('Replay recording state unavailable', exc_info=True)
        return 'replay recording state unavailable'


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
    """Column-major affine transform: telemetry.matrix_columns, the one writer (the crit log's ram contacts use it too,
    25.09). Kept under this name for the recorder's callers."""
    from local_armor_inspector.telemetry import matrix_columns as columns
    return columns(matrix, root_inverse)


def extra_part_info(idx, collisions, appearance, root, matrix, probe=None):
    """What the client itself knows of a collision part beyond the static ones, for one contact on it.

    Read only with the calls the client makes for such an index (VehicleEffects.parseHitPoints and
    Vehicle.showDamageFromShot), so nothing here asks the collision component anything new
    (docs/BACKLOG.md 39): a negative index is a wheel of a wheeled vehicle - the collision component's
    own part name and the compound model's node of that name, the frame the client lays the hit
    effect in; an index above maxStaticPartIndex is a CGF prefab (the CAV mod. 71 crest, the AS-XX
    containers) linked by DynamicCollisionLinker - its parent part and getPartTransform, as prefab_probe
    read them (`probe`; None: nothing more, the part itself carries them). Both with the part's bounding box.
    Each read on its own, so one that fails costs only its field. 'matrix' is Math.Matrix; poses are
    column-major relative to the chassis, as the parts' transforms.
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
    elif idx > collisions.maxStaticPartIndex and probe is not None:
        if probe[0] is not None: info['parentPart'] = probe[0]
        if probe[1] is not None: info['partTransform'] = probe[1]
    return info


_WHEEL_NAMES = {}


def wheel_parts_checked(descr, collisions):
    """exporter.wheel_parts of a hit's target, only when its collision agrees with them: as many wheels as the client
    counts (generalWheelsAnimatorConfig.getNonTrackWheelsCount, Vehicle.calcMaxComponentIdx) and part -k under the name of
    the wheel of index k-1 (collisions.getPartName, the lookup the client's getMatinfo makes). The names are asked once per
    collision component and type; the cache holds no game object (a reused address meets another type's names and fails).
    Otherwise [] - a contact on a wheel then stays 'unsupported-part', as before.
    Only an agreement is kept for good. A failure or a disagreement (the wheel colliders not attached yet at the first
    hit, review of 5f2bee5) is asked again, at most every WHEEL_RETRY seconds: a count and a few names, cheap."""
    from local_armor_inspector.exporter import wheel_parts
    parts = wheel_parts(descr)
    if not parts: return []
    key = (id(collisions), str(descr.type.name))
    entry = _WHEEL_NAMES.get(key)
    now = time.time()
    if entry is None or (entry[1] is not None and now >= entry[1]):
        try:
            count = int(descr.chassis.generalWheelsAnimatorConfig.getNonTrackWheelsCount())
            names = tuple(str(collisions.getPartName(-k) or '') for k in range(1, count+1))
        except Exception:
            names = ()
        agree = wheel_names_agree(names, parts)
        if len(_WHEEL_NAMES) >= 64: _WHEEL_NAMES.clear()
        entry = _WHEEL_NAMES[key] = (agree, None if agree else now + WHEEL_RETRY)
    return parts if entry[0] else []


WHEEL_RETRY = 5.0


def wheels_state(descr, collisions):
    """What wheel_parts_checked keeps of a wheeled target's collision: True or False while it holds, None when it is to be
    asked (again) - nothing kept yet, or a disagreement whose WHEEL_RETRY is due. Read, never asked: part of the key of
    the target's shared static half (Recorder.shared_target), which carries the wheels only when they agreed."""
    entry = _WHEEL_NAMES.get((id(collisions), str(descr.type.name)))
    if entry is None or (entry[1] is not None and time.time() >= entry[1]): return None
    return entry[0]


def part_resources(descr):
    """The collision model each static part's active hit tester reads now (exporter.part_resource), None where it cannot be
    read: part of the key of a vehicle's shared static half. Whatever switches a part's model while the battle runs gets a
    new half written instead of the old model under it - a few attribute reads a hit."""
    from local_armor_inspector.exporter import static_parts, part_resource
    resources = []
    for idx, name, component in static_parts(descr):
        try: resources.append(part_resource(component))
        except Exception: resources.append(None)
    return tuple(resources)


class SharedStatic(object):
    """One vehicle's static half in this battle (BACKLOG 27), kept by Recorder.statics under (side, id(descriptor)):
      descr       the descriptor it was read from - kept, so its id cannot be reused by another object
      check       (mode, part models[, wheel agreement]) at the reading; any change and the half is read again
      static      records.VehicleStatic, the object every hit of this vehicle hands the writer (written once a file)
      live        the shooter's live fields that come with the half (vehicleMode)
      available, candidates
                  the shooter's shell lists (records.SharedList): all its shells, and by (effectsIndex, gun slot)
      ids, count, wheeled
                  the target's parts in order (a pose read for each id >= 0), its static part count, whether it has wheels
    """
    __slots__ = ('descr', 'check', 'static', 'live', 'available', 'candidates', 'ids', 'count', 'wheeled')

    def __init__(self, descr, check, static, live):
        self.descr, self.check, self.static, self.live = descr, check, static, live
        self.available, self.candidates, self.ids, self.count, self.wheeled = None, {}, (), 0, False


def wheel_names_agree(names, parts):
    """The collision's wheel names are the descriptor's wheels, part -k under the name of the wheel of index k-1."""
    return bool(names) and len(names) == len(parts) and all(
        -part['id'] <= len(names) and names[-part['id']-1] == part['name'] for part in parts)


# ARMOURED PREFABS OF A TARGET (27.09, task prefab-parts; exporter.prefab_spec). The CAV mod. 71's crest and the AS-XX
# 40 t's containers are CGF prefabs in a slot of their gun / hull (descr.<part>.slotPrefabs: (slot, prefab path)); the
# client's DynamicCollisionLinker gives the collider a collision index above maxStaticPartIndex, known to the recorder
# only from a contact on it (DamageFromShotDecoder.getPartIndexByNetworkID). Such a contact is recorded on a part of that
# index with its slot, parent and pose at the hit (collisions.getPartTransform - the call the client makes for it in
# Vehicle.showDamageFromShot), and the index is remembered for the collision component: every later hit on that vehicle
# records the part's pose too (one getParentPartIndex and one getPartTransform), whatever it strikes - the crest moves
# with the charges, the containers when they open. Its model and armour come from the prefab on the export thread;
# nothing is read here.
# A pose is taken only when it can be the part's (review of d1b372b): the client names the slot's parent (for a
# remembered index it must, and the same one), the matrix is finite and rigid, not the chassis frame itself (identity:
# a prefab stands on the hull or the gun, never at the chassis origin) and its origin within PREFAB_REACH of the parent
# part's. A crit that switches the prefab to its 'crash' state or a collision component at a reused address can leave
# the index on something else; a remembered index that fails is forgotten, and no pose is ever made up. What the rule
# of the page (ArmorInspectorData.prefabPose, `fit`) finds wrong with a pose that passes is the page's to reject.
_PREFAB_INDEX = {}
# Metres: the slot and the collider put the crest 0.6 m from its gun's origin and the containers 3.1 m from the hull's
# (exporter.prefab_statics on the offline bench, 27.09); twice the larger, rounded up.
PREFAB_REACH = 7.0


def prefab_slot(descr, parent, strict=False):
    """(parent part index, slot, prefab path) of the target's prefab slot a dynamic collision part belongs to: the one slot
    of its parent's component. The parent unknown (the client gave none): the vehicle's only slot, unless `strict` (a
    remembered index); a parent the vehicle has no slot on: None - the contact then stays unsupported."""
    from local_armor_inspector.exporter import descriptor_slots
    found = descriptor_slots(descr)
    if parent is not None:
        own = [entry for entry in found if entry[0] == parent]
        return own[0] if len(own) == 1 else None
    return found[0] if len(found) == 1 and not strict else None


def prefab_probe(idx, collisions, root, matrix):
    """(parent part index or None, pose columns or None) the client gives for a dynamic collision part - one
    getParentPartIndex and one getPartTransform, each on its own (a failure costs only its half). A pose that is not 16
    finite numbers is None: the record is JSON without NaN, and one NaN would cost the whole hit."""
    try:
        parent = collisions.getParentPartIndex(idx)
        parent = int(parent) if parent is not None else None
    except Exception:
        parent = None
    try:
        transform = matrix_columns(matrix(collisions.getPartTransform(idx)), root)
        if any(value != value or value in (_INF, -_INF) for value in transform): transform = None
    except Exception:
        transform = None
    return parent, transform


_IDENTITY = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
_INF = float('inf')


def prefab_pose_valid(transform, parent_transform):
    """Whether a recorded prefab pose can be the part's (see above): 16 numbers (finite: prefab_probe), a rigid turn, not the identity,
    its origin within PREFAB_REACH of the parent part's (when that part's pose is known)."""
    if not isinstance(transform, list) or len(transform) != 16: return False
    columns = [transform[0:3], transform[4:7], transform[8:11]]
    for a in range(3):
        if abs(sum(x * x for x in columns[a]) - 1.0) > 1e-3: return False
        for b in range(a + 1, 3):
            if abs(sum(x * y for x, y in zip(columns[a], columns[b]))) > 1e-3: return False
    if max(abs(x - y) for x, y in zip(transform, _IDENTITY)) < 1e-6: return False
    if isinstance(parent_transform, list) and len(parent_transform) == 16:
        if sum((transform[12 + k] - parent_transform[12 + k]) ** 2 for k in range(3)) > PREFAB_REACH ** 2: return False
    return True


def prefab_part(idx, descr, probe, poses, remembered=None):
    """The target's prefab part at collision index `idx` from what the client gave for it (prefab_probe), posed at this
    hit; None when it cannot be named or its pose is not one it can have. `poses`: {part id: transform} of the static parts
    of this hit. `remembered`: the parent part the index was first found on - the client must name that one again."""
    parent, transform = probe
    if remembered is not None and parent != remembered: return None
    slot = prefab_slot(descr, parent, strict=remembered is not None)
    if slot is None or not prefab_pose_valid(transform, poses.get(slot[0])): return None
    return {'id':int(idx), 'name':slot[1], 'prefab':slot[2], 'parentPart':slot[0], 'transform':transform}


def remember_prefab(collisions, descr, part):
    if len(_PREFAB_INDEX) >= 64: _PREFAB_INDEX.clear()
    _PREFAB_INDEX[id(collisions)] = (str(descr.type.name), int(part['id']), int(part['parentPart']))


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
        # The shared definition store beside the battles folder (BACKLOG 27): CFG/definitions. Built in run().
        self.store = None
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
        try: from local_armor_inspector.records import RecordEncoder, DefinitionStore, DEFINITIONS_FOLDER
        except ImportError: from mod.local_armor_inspector.records import RecordEncoder, DefinitionStore, DEFINITIONS_FOLDER
        if self.store is None:
            self.store = DefinitionStore(os.path.join(os.path.dirname(os.path.abspath(self.folder)), DEFINITIONS_FOLDER))
        try:
            while not self.stopping.is_set() or not self.queue.empty():
                try: name, record = self.queue.get(timeout=0.1)
                except queue.Empty: continue
                encoder = self.encoders.get(name)
                if encoder is None: encoder = self.encoders[name] = RecordEncoder(self.store)
                try:
                    encoded = encoder.encode(record)
                    # The definitions of this hit's shared halves the store lacks (BACKLOG 27): each put there whole and
                    # flushed before the line that refers to them; an entry already there is not written again. When
                    # the store cannot take them they go into the file instead, in the `static` record before the hit.
                    if encoder.stored:
                        try:
                            for kind, key, value in encoder.stored: self.store.put(kind, key, value)
                        except Exception:
                            LOG.exception('Shared definition store not written; the definitions stay in %s', name)
                            encoder.in_file()
                    line = (json.dumps(encoded, ensure_ascii=True, allow_nan=False,
                                       separators=(',', ':'))+'\n').encode('utf-8')
                    # The definitions this hit's references need and the file does not hold yet (BACKLOG 27): their own
                    # `static` record, in the same append right before the hit, so a reader meets them first.
                    if encoder.definitions is not None:
                        line = (json.dumps(encoder.definitions, ensure_ascii=True, allow_nan=False,
                                           separators=(',', ':'))+'\n').encode('utf-8') + line
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

    def export_command(self, name, payload):
        """One message of the export queue, on the export thread. A failure is one line with the mod's tag that names the
        command and the exception (12.11: 'HTML export command failed' alone; its traceback follows untagged in game.log,
        so the cause could not be read from our own lines). False when it failed."""
        try:
            if name == 'vehicle': self.exporter.request_vehicle_export(payload)
            elif name == 'prioritise': self.exporter.prioritise(payload)
            elif name == 'ttx': self.exporter.request_ttx(payload)
            elif name == 'battle': self.exporter.request_battle(payload)
            elif name == 'playback': self.exporter.request_playback(payload)
            elif name == 'mapraw': self.exporter.request_map_raw(payload)
            elif name == 'playbackReport': self.exporter.playback_report(payload)
            elif name == 'replays': self.exporter.replay_library_command(payload)
            elif name == 'sweepStart': self.exporter.confirm_sweep(payload or 'ttx')
            elif name == 'sweepStop': self.exporter.stop_sweep(payload or 'ttx')
            # The replay stream of one battle (replay_source.ReplaySource.handover): its consumer is the
            # exporter's replay_stream; an exporter without it lets the message go (the copy stays on disk).
            elif name == 'replay' and hasattr(self.exporter, 'replay_stream'): self.exporter.replay_stream(payload)
            return True
        except Exception as error:
            LOG.exception('HTML export command %r failed: %s: %s', name, type(error).__name__, error)
            return False

    def run_export(self):
        try: self.exporter.setup()
        except Exception:
            LOG.exception('HTML export setup failed; raw recording continues')
            self.exporter = None
            return
        while True:
            message = None
            # While a sweep's slices run, no wait here: it waits one frame of the game between two slices itself. None either
            # right after a job when the page waits for another one (a clicked vehicle's): its jobs run back to back.
            hurry = False
            try: hurry = bool(getattr(self.exporter, 'export_hurry', None) and self.exporter.export_hurry())
            except Exception: hurry = False
            try: message = self.export_queue.get_nowait() if hurry else self.export_queue.get(timeout=0.05)
            except queue.Empty: pass
            if message is not None:
                try: self.export_command(message[0], message[1])
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
        # No sweep works any more (review #6): the drain below is the records' only.
        if self.exporter is not None:
            try: self.exporter.ttx_stopped = True
            except Exception: pass
        self.stopping.set()
        self.thread.join(2.0)
        if self.thread.is_alive(): LOG.warning('Writer still draining at shutdown')
        if self.export_thread is not None:
            self.export_thread.join(2.0)
            if self.export_thread.is_alive(): LOG.warning('HTML exporter still draining at shutdown')


def hangar_fitted(vehicle):
    """The directive and the consumables mounted on the garage's vehicle (BACKLOG 102): the page's Current of the player's
    own vehicle counts them. The descriptor packs the equipment but neither of these. The gui Vehicle (2.4.1.1 bytecode,
    14.11): `consumables` and `battleBoosters` are equipment collectors whose `installed` is the mounted set - it iterates
    its slots, a gui item or an empty one; an item's `name` is the client's entry name, and `isStimulator` (a ration of any
    nation: the page's one 'food') is VehicleArtefact's. None when nothing could be read; never raises."""
    def items(collector):
        installed = getattr(collector, 'installed', None)
        if callable(installed): installed = installed()
        out = []
        for item in list(installed or []):
            name = getattr(item, 'name', None) if item is not None else None
            if not name or not isinstance(name, (str, type(u''))): continue
            stim = getattr(item, 'isStimulator', False)
            if callable(stim): stim = stim()
            out.append('food' if stim else str(name))
        return out
    fitted = {}
    try: fitted['consumables'] = items(vehicle.consumables)[:3]
    except Exception: pass
    try:
        boosters = items(vehicle.battleBoosters)
        fitted['directive'] = boosters[0] if boosters else ''
    except Exception: pass
    return fitted or None


def vehicle_request(descr, source, fitted=None):
    """The tiny request a game-thread hook hands to the export thread. `fitted`: the garage's directive and consumables."""
    request = {'schema':1, 'type':'vehicle', 'source':source,
               'vehicleType':str(descr.type.name), 'requestedAt':time.time(),
               'compactDescriptor':base64.b64encode(descr.makeCompactDescr()).decode('ascii')}
    if fitted: request['fitted'] = fitted
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
        self.shown = None       # the type name of the hangar's vehicle last seen (follow_hangar)
        self.space = None       # the client's IHangarSpace while its loading events are followed
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
        # The hangar's loading (the replay job waits for it): the client's IHangarSpace events. Without them the replay
        # job does not wait for the hangar (as before 12.11).
        try:
            from helpers import dependency
            from skeletons.gui.shared.utils import IHangarSpace
            space = dependency.instance(IHangarSpace)
            space.onSpaceCreating += self.on_hangar_loading
            space.onSpaceCreate += self.on_hangar_loaded
            self.space = space
            self.recorder.hangar_signal = True
        except Exception: LOG.warning('Hangar loading events unavailable; the replay job does not wait for the hangar', exc_info=True)

    def close(self):
        self.detach_arena()
        self.roster = {}
        try:
            if self.hangar is not None: self.hangar.onChanged -= self.on_hangar_vehicle
        except Exception: LOG.exception('Hangar hook cleanup failed')
        try:
            if self.space is not None:
                self.space.onSpaceCreating -= self.on_hangar_loading
                self.space.onSpaceCreate -= self.on_hangar_loaded
        except Exception: LOG.exception('Hangar space hook cleanup failed')
        self.space = None
        self.recorder.hangar_signal = False
        try:
            if self.events is not None:
                self.events.onAvatarBecomePlayer -= self.on_avatar_become_player
                self.events.onAvatarBecomeNonPlayer -= self.on_avatar_become_non_player
        except Exception: LOG.exception('Battle hook cleanup failed')
        self.hangar, self.events = None, None

    def on_hangar_vehicle(self, *args):
        """The vehicle selected in the hangar, on every change. Duplicates are dropped.

        The open page follows a change of the vehicle's TYPE (BACKLOG 94, follow_hangar): onChanged also fires for the
        same vehicle - its modules, crew, repair, a return from a preview or the comparison (during those the hangar's
        vehicle stays as it was) - and none of that is a choice in the carousel."""
        try:
            if self.hangar is None or not self.hangar.isPresent(): return
            vehicle = self.hangar.item
            if vehicle is None: return
            self.recorder.request_vehicle(vehicle.descriptor, 'hangar', hangar_fitted(vehicle))
            type_name = str(vehicle.descriptor.type.name)
            previous, self.shown = self.shown, type_name
            if previous is not None and previous != type_name: follow_hangar(type_name)
        except Exception: LOG.exception('Hangar vehicle export request failed')

    def on_hangar_loading(self, *args):
        # A handler of the client's Event must not raise (the client's handlers behind it would not run).
        try: self.recorder.note_hangar_loading()
        except Exception: LOG.exception('Hangar loading could not be noted')

    def on_hangar_loaded(self, *args):
        try: self.recorder.note_hangar_loaded()
        except Exception: LOG.exception('Hangar loaded could not be noted')

    def on_avatar_become_player(self, *args):
        # The export thread extracts nothing while this is set: a collision model
        # costs a few tenths of a second of the interpreter lock, which is stutter
        # in a battle. The hits themselves are written and published throughout.
        try: self.recorder.in_battle = True
        except Exception: LOG.exception('Battle state could not be noted')
        try: self.recorder.start_cost()
        except Exception: LOG.exception('Recorder cost unavailable; hit recording continues')
        # The motion sampler lives exactly as long as the battle does: armed here, stopped when the
        # avatar stops being the player. It never runs in the hangar and never per frame.
        try: self.recorder.motion.start()
        except Exception: LOG.exception('Motion sampler unavailable; hit recording continues')
        self.attempts = 0
        self.attach_arena()
        # The replay stream's copy of this battle starts (replay_source): attribute reads and one message here.
        replay = getattr(self.recorder, 'replay', None)
        if replay is not None: replay.on_avatar_become_player(self.recorder.bw.player())

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
        # The own shot still waiting for its server aim updates (telemetry.gunAfterShot) keeps the ones that came:
        # the battle's file is still the current one here. The existing exit path, no hook of its own.
        try: self.recorder.telemetry.flush_after_shot()
        except Exception: LOG.exception('Pending shot updates could not be written')
        try:
            self.recorder.in_battle = False
            # When the player left the battle (wall clock): the replay job's moments are timed after it (Exporter.replay_moments).
            self.recorder.battle_left_at = time.time()
            # The hangar loads from here: the replay job of this battle waits for it (note_hangar_loaded).
            self.recorder.note_hangar_loading()
        except Exception: LOG.exception('Battle state could not be noted')
        # The vehicles' static halves hold the battle's descriptors: not kept in the hangar (BACKLOG 27).
        self.recorder.statics = {}
        try: self.recorder.motion.stop()
        except Exception: LOG.exception('Motion sampler stop failed')
        self.detach_arena()
        self.flush_roster()
        # What the recorder took on the game thread in this battle: one log line (Recorder.log_cost).
        try:
            import BigWorld
            try: arena_id = str(BigWorld.player().arena.arenaUniqueID)
            except Exception: arena_id = None
            self.recorder.log_cost(arena_id)
        except Exception: LOG.exception('Recorder cost could not be logged')
        # The avatar's own onBecomeNonPlayer stopped the recording before this event: the stream's end and hand-over.
        replay = getattr(self.recorder, 'replay', None)
        if replay is not None: replay.on_avatar_become_non_player()

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
        """Every vehicle of the roster - the opponents' exact configurations. Its time is the battle's ROSTER cost."""
        from local_armor_inspector.telemetry import CLOCK, ROSTER
        t0 = CLOCK()
        try:
            if self.arena is None: return
            for info in list(getattr(self.arena, 'vehicles', {}).values()):
                self.note_roster_vehicle((info or {}).get('vehicleType'))
            self.write_roster()
        except Exception: LOG.exception('Battle roster unavailable for vehicle export')
        finally: self.recorder.cost.add(ROSTER, CLOCK() - t0)

    def on_vehicle_info(self, vehicle_id, *args):
        """A vehicle added to the arena list or its arena info changed: note it for export, write the roster (the
        recorder writes it only when a row really changed, so a death or a frag count costs no record). ROSTER cost."""
        from local_armor_inspector.telemetry import CLOCK, ROSTER
        t0 = CLOCK()
        try:
            if self.arena is None: return
            info = getattr(self.arena, 'vehicles', {}).get(vehicle_id) or {}
            self.note_roster_vehicle(info.get('vehicleType'))
            self.write_roster()
        except Exception: LOG.exception('Battle vehicle export request failed')
        finally: self.recorder.cost.add(ROSTER, CLOCK() - t0)

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
        # Each vehicle's static half in this battle (BACKLOG 27, SharedStatic): read from the client at the first hit that
        # needs it, written once by the writer, and handed by every later hit as the same object. Emptied in ensure_battle.
        self.statics = {}
        from local_armor_inspector import records
        self.records = records
        self.session = uuid.uuid4().hex[:12]
        self.enabled = True
        # Two flags the export thread reads before it runs deferred work (0.7.11):
        # no collision model is extracted during a battle, and none while the page
        # says the user is working in it. Written here, on the game thread, only.
        self.in_battle = False
        self.battle_left_at = None
        # The game's own loads the replay job waits for (Exporter.replay_wait; written here, on the game thread, only):
        # until then the hangar is loading, its space created at hangar_loaded_at (wall clock), the page loading until then;
        # hangar_signal - the client's hangar space events are followed (without them nothing waits for the hangar).
        self.hangar_wait_until = 0.0
        self.hangar_loaded_at = None
        self.hangar_signal = False
        self.page_loading_until = 0.0
        self.busy_until = 0.0
        # The page is open in the game until then (note_page_open): the TTX sweep may run meanwhile. While its slices run
        # (frames_wanted, written by the export thread) a callback on every frame sets frame_event, which the export
        # thread waits for between two slices (wait_frame): the game gets one whole frame between them.
        self.page_open_until = 0.0
        self.frames_wanted = False
        self.frame_loop = False
        self.frame_event = threading.Event()
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
                # the player page is told on the game thread (presentation's queue of notes, 19.11)
                from local_armor_inspector import presentation as page_presentation
                exporter.page_notify = page_presentation.notify_page
            except Exception: LOG.exception('HTML exporter unavailable; raw recording continues')
        self.writer = Writer(folder, exporter)
        self.last_vehicle = None
        # The roster of the battle being written (all three emptied by ensure_battle when the battle changes):
        # the rows of the last roster record, to write a new one only when a row changed (REC-11), and what the
        # vehicles in view said of themselves - {vehicle id: (key, facts)}, see note_vehicle.
        self.roster_known = False
        self.roster_last = None
        self.roster_seen = {}
        # (arena id, snapshots only, why) of the battle the recorder last decided for (snapshots_only, BACKLOG 87).
        self.scope = None
        # The reader of the gun mechanics' live state is bound once here, beside the telemetry it lives in,
        # so the hit path does not run an import statement per hit (22.09).
        from local_armor_inspector.telemetry import ShotTelemetry, mechanic_state, designator_mark, recording, Cost
        # What the recorder's own code costs the game thread in this battle, per hook group (telemetry.Cost): made
        # before every hook that adds to it, reset when the avatar becomes the player, logged at the battle's end.
        self.cost = Cost()
        self.cost_scope = None
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

    def request_vehicle(self, descr, source, fitted=None):
        """Queue one vehicle export, skipping the request we just queued.

        The hangar fires its change event often and a roster repeats itself, so the
        same type with the same compact descriptor twice in a row is dropped here;
        the exporter drops the rest by comparing the descriptor hash of the file it
        already wrote. A click of the page ('picker') always goes through (click-export-fast, 26.09): a second click
        after a failed or slow export was dropped here, and the page waited for nothing; the export thread's queue
        holds one job per type anyway, and a current file costs one hash comparison.
        """
        try:
            if descr is None: return
            request = vehicle_request(descr, source, fitted)
            key = (request['vehicleType'], request['compactDescriptor'], repr(sorted((fitted or {}).items())))
            if key == self.last_vehicle and source != 'picker': return
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

    def note_hangar_loading(self):
        """The hangar starts loading (a battle left, the space being created): the replay job waits until it is loaded,
        HANGAR_FALLBACK at most. Nothing waits when the client's hangar events are not followed. Game thread."""
        if self.hangar_signal: self.hangar_wait_until = time.time() + HANGAR_FALLBACK

    def note_hangar_loaded(self):
        """The hangar's space is created (IHangarSpace.onSpaceCreate): the replay job may start HANGAR_SETTLE later. One
        log line, timed against the battle the player left. Game thread."""
        now = time.time()
        self.hangar_loaded_at = now
        self.hangar_wait_until = now + HANGAR_SETTLE
        left = self.battle_left_at
        LOG.info('Hangar loaded%s', ' %.1f s after the battle was left' % (now - left) if left is not None else '')

    def note_page_loading(self, state):
        """The page's window (presentation.open_in_game, WindowTrace): True - it starts loading, the replay job waits
        PAGE_LOAD_FALLBACK at most; False - loaded, PAGE_LOAD_SETTLE more; None - the window is gone. Game thread."""
        now = time.time()
        self.page_loading_until = (now + PAGE_LOAD_FALLBACK if state is True else now + PAGE_LOAD_SETTLE if state is False
                                   else 0.0)

    def note_page_open(self, seconds=PAGE_OPEN_SECONDS):
        """The page is open in the game right now: one float, read by the export thread's TTX sweep. Game thread."""
        self.page_open_until = time.time()+float(seconds)
        self.start_frames()

    def sweep_request(self, start, kind='ttx'):
        """The page's Start or Stop of a sweep ('ttx' the characteristics, 'models' the collision models): the export
        thread runs or stops it, the frames begin here."""
        self.writer.put_export('sweepStart' if start else 'sweepStop', kind)
        self.frames_wanted = bool(start)
        if start: self.start_frames()

    def start_frames(self):
        """Game thread: the frame callback, while the sweep's slices want it and the page is open; one chain at a time."""
        if self.frame_loop or not self.frames_wanted: return
        try:
            import BigWorld
            BigWorld.callback(0, self.on_frame)
            self.frame_loop = True
        except Exception:
            self.frame_loop = False

    def on_frame(self):
        """One frame of the game has passed: the export thread's next slice may start."""
        self.frame_event.set()
        if self.frames_wanted and not getattr(self, 'in_battle', False) and self.page_open_until > time.time():
            try:
                import BigWorld
                BigWorld.callback(0, self.on_frame)
                return
            except Exception:
                pass
        self.frame_loop = False

    def wait_frame(self, timeout=0.1):
        """Export thread: until the next frame of the game (or `timeout` s, when the frame callback is not running)."""
        self.frame_event.clear()
        self.frame_event.wait(timeout)

    def prioritise(self, types):
        """The page opened a hit: its vehicles' models go before everything else.

        Sent through the export queue instead of touching the queue of jobs from
        here: that list belongs to the export thread.
        """
        names = [str(name) for name in list(types or [])[:8] if name]
        if names: self.writer.put_export('prioritise', names)

    def request_battle(self, battle_id):
        """The page opened a saved battle whose file is stale (BACKLOG 55). Game thread: the id goes through the export
        queue; reading the raw file and writing the battle belong to that thread."""
        if battle_id: self.writer.put_export('battle', str(battle_id))

    def request_playback(self, battle_id):
        """The page opened a battle in the 3D replay player and its file is missing (BACKLOG 104). Game thread: the id goes
        through the export queue; decoding the replay and copying the map belong to that thread."""
        if battle_id: self.writer.put_export('playback', str(battle_id))

    def request_replays(self, payload):
        """The page's word on the mod's replay folder (BACKLOG 107): keep a battle's replay forever or not, or the number of
        replays kept. Game thread: through the export queue; the files belong to that thread."""
        if payload: self.writer.put_export('replays', dict(payload))

    def request_ttx(self, type_name):
        """The page asks for the characteristics file of one type (data/ttx/<id>.js). Game thread: the
        string goes through the export queue; the check, the build and the file belong to that thread."""
        if type_name: self.writer.put_export('ttx', str(type_name))

    def note_roster(self, arena, player):
        """The battle's roster as one record: id, player, vehicle and team of every vehicle known so far.

        Contract for readers (unchanged since 0.7.9, spelled out 24.09): every roster record is the WHOLE roster
        as known at that moment and supersedes the ones before it; a reader keeps the last one of the battle
        (exporter read_battle / apply_record) as the battle's roster, and all of them in order as the history of an id
        that changes its vehicle in a respawn mode (roster.lives, BACKLOG 99, 13.11). Rows only gain or correct fields over a battle - the vehicle chosen
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
        record = {'schema':1, 'type':'roster', 'receivedAt':time.time(),
                  'playerVehicleId':player_id, 'playerTeam':player_team, 'vehicles':vehicles}
        # The battle's clock too, as on every hit and crit record: a vehicle id's vehicles over the battle are placed by
        # it (roster.lives, BACKLOG 99, 13.11).
        try: record['gameTime'] = float(self.bw.serverTime())
        except Exception: pass
        if self.writer.put(self.file, record):
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

    def snapshots_only(self, player):
        """Whether this battle records the two snapshots only (BACKLOG 87): decided once per battle, at the first record
        path that asks - the roster at the arena's first list, normally - by recording_scope, and logged in one line.
        Opens no file. False (everything recorded) for anything it cannot read. Game thread."""
        arena = getattr(player, 'arena', None)
        try: arena_id = str(arena.arenaUniqueID)
        except Exception: return False
        scope = self.scope
        if scope is not None and scope[0] == arena_id: return scope[1]
        try: mode = battle_mode(arena)
        except Exception: mode = None
        try: reduced, why = recording_scope(mode, self.version, replay_recording(self))
        except Exception:
            reduced, why = False, 'the rule could not be read'
            LOG.exception('Recording scope unavailable; the battle is recorded in full')
        self.scope = (arena_id, reduced, why)
        if reduced: LOG.info('recorder: snapshots only - battle %s: %s', arena_id, why)
        else: LOG.info('recorder: full, because %s - battle %s', why, arena_id)
        return reduced

    def start_cost(self):
        """The avatar became the player: this battle's cost starts from nothing (telemetry.Cost). Game thread."""
        self.cost.reset()
        self.cost_scope = self.scope

    def log_cost(self, arena_id=None):
        """The avatar left the battle: one log line of what the recorder's code took on the game thread in it, by group
        (telemetry.Cost.line), and the battle's length - the wall seconds the avatar was the player. The scope is the
        battle's decision (snapshots_only) when it was made in this battle; 'not recorded' when no record path asked
        (a replay played, a spectator seat). No record is written: the raw record has no closing record. Game thread."""
        scope = self.scope
        if scope is None or (scope is self.cost_scope and scope[0] != arena_id): label = 'not recorded'
        else: label = ('snapshots only' if scope[1] else 'full') + ', battle ' + scope[0]
        LOG.info('recorder: %s', self.cost.line(label, time.time() - self.cost.started))

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
            header = {'schema':1, 'type':'battle', 'id':filename, 'source':'live',
                'arenaId':battle_id, 'startedAt':time.time(), 'playerVehicleId':player.playerVehicleID,
                'map':getattr(arena_type, 'name', None) or 'Unknown map',
                'clientVersion':self.version, 'recorderVersion':VERSION, 'mode':mode,
                # Seconds between two motion samples of this battle. The layout of a sample rides
                # on every attached buffer; the period belongs to the battle, so it is written once.
                'motionPeriod':self.motion_period}
            # A battle that records the snapshots only says so (replay_battle reads it); a full one keeps today's header.
            if self.snapshots_only(player): header['recording'] = RECORDING_SNAPSHOTS
            self.writer.put(filename, header)
            self.battle = battle_id
            self.seq = 0
            self.file = filename
            self.roster_known = False
            self.roster_last = None
            self.roster_seen = {}
            self.mode_blocks = {}
            self.statics = {}
        return True

    def shared_shooter(self, attacker, record, effects, installation):
        """The shooter's half kept by an earlier hit of this battle (keep_shooter), when it still is this descriptor's: the
        same object, mode and part models. Puts the attacker block (its live fields and the shared half), both shell lists
        and the shell status on the record and says True; False - nothing written - when the half must be read anew.
        A gun slot or shell effect not met before reads its candidates once (shot_candidates). Game thread, never raises."""
        entry = self.statics.get(('attacker', id(attacker)))
        if entry is None or entry.descr is not attacker: return False
        try:
            from local_armor_inspector.presentation import descriptor_mode
            if entry.check != (descriptor_mode(attacker), part_resources(attacker)): return False
            candidates = entry.candidates.get((effects, installation))
            if candidates is None:
                from local_armor_inspector.armor import shot_candidates
                candidates = self.records.SharedList(shot_candidates(attacker, effects, installation))
                entry.candidates[(effects, installation)] = candidates
        except Exception:
            return False
        side = dict(entry.live)
        side[self.records.STATIC_FIELD] = entry.static
        record['attacker'] = side
        record['shellCandidates'] = candidates
        record['availableShells'] = entry.available
        record['shellStatus'] = 'matched' if candidates else 'no matching shell effects'
        return True

    def keep_shooter(self, attacker, record, before, effects, installation):
        """After a full reading of the shooter: keep its static half for the battle's later hits and hand this hit the
        shared form - only when the reading was whole (no warning since `before`, the shells read) and the block splits
        (records.split_vehicle). Otherwise the hit keeps its block inline, as before, and the next hit reads again."""
        try:
            if len(record['warnings']) != before: return
            if record.get('shellStatus') not in ('matched', 'no matching shell effects'): return
            halves = self.records.split_vehicle(record.get('attacker'))
            if halves is None: return
            from local_armor_inspector.presentation import descriptor_mode
            check = (descriptor_mode(attacker), part_resources(attacker))
            if None in check[1]: return
            live, static = halves
            entry = SharedStatic(attacker, check, static, live)
            entry.available = self.records.SharedList(record.get('availableShells') or [])
            candidates = self.records.SharedList(record.get('shellCandidates') or [])
            entry.candidates[(effects, installation)] = candidates
            self.statics[('attacker', id(attacker))] = entry
            side = dict(live)
            side[self.records.STATIC_FIELD] = static
            record['attacker'] = side
            record['availableShells'] = entry.available
            record['shellCandidates'] = candidates
        except Exception:
            LOG.debug('Shooter static half not kept', exc_info=True)

    def shared_target(self, vehicle, descr, record):
        """The target's half kept by an earlier hit of this battle (keep_target), when it still is this descriptor's: the
        same object, mode, part models and wheel agreement. Reads only what is new at this shot - the chassis' world pose,
        each static part's pose, the extra-part check, the Borkenkafer's mark - and puts the target block on the record:
        (collisions, root, known part ids, {id: pose}, the list for the parts of this shot only). None, nothing written,
        when the half must be read anew or any of these reads fails (the full reading then says what failed, as before)."""
        entry = self.statics.get(('target', id(descr)))
        if entry is None or entry.descr is not descr: return None
        try:
            import Math
            from local_armor_inspector.presentation import descriptor_mode
            from local_armor_inspector.exporter import EXTRA_PARTS_WARNING
            collisions = vehicle.appearance.collisions
            wheels = wheels_state(descr, collisions) if entry.wheeled else 'none'
            if entry.check != (descriptor_mode(descr), part_resources(descr), wheels): return None
            root = Math.Matrix(collisions.getPartTransform(0))
            world_root = Math.Matrix(root)
            root.invertOrthonormal()
            transforms = [matrix_columns(Math.Matrix(collisions.getPartTransform(idx)), root) if idx >= 0 else None
                          for idx in entry.ids]
            extra = collisions.maxStaticPartIndex >= entry.count
            world = matrix_columns(world_root, Math.Matrix())
        except Exception:
            return None
        side = {self.records.STATIC_FIELD: entry.static, 'worldTransform': world, 'parts': []}
        if [pose for pose in transforms if pose is not None]: side['partPoses'] = transforms
        try:
            mark = self.designator_mark(vehicle)
            if mark: side['designatorMark'] = mark
        except Exception:
            pass
        record['target'] = side
        if extra: record['warnings'].append(EXTRA_PARTS_WARNING)
        return collisions, root, set(entry.ids), dict(zip(entry.ids, transforms)), side['parts']

    def keep_target(self, vehicle, descr, collisions, record, before):
        """After a full reading of the target: keep its static half for the battle's later hits and hand this hit the
        shared form - only when the reading was whole (no warning since `before` but the extra-part one, which every hit
        checks for itself; every static part posed; the wheel agreement settled) and the block splits."""
        try:
            from local_armor_inspector.exporter import EXTRA_PARTS_WARNING, wheel_parts
            from local_armor_inspector.presentation import descriptor_mode
            if [text for text in record['warnings'][before:] if text != EXTRA_PARTS_WARNING]: return
            side = record.get('target')
            if [part for part in side.get('parts') or () if not isinstance(part, dict) or 'error' in part]: return
            halves = self.records.split_vehicle(side)
            if halves is None: return
            wheeled = bool(wheel_parts(descr))
            wheels = wheels_state(descr, collisions) if wheeled else 'none'
            check = (descriptor_mode(descr), part_resources(descr), wheels)
            if None in check[1] or wheels is None: return
            live, static = halves
            ids = [part.get('id') for part in static.get('parts') or ()]
            if [idx for idx in ids if not isinstance(idx, int)]: return
            # Every static part's pose is the hit's own (live partPoses): none may have stayed in the half.
            if [part for part in static.get('parts') or () if part.get('id') >= 0 and 'transform' in part]: return
            entry = SharedStatic(descr, check, static, None)
            entry.ids, entry.count, entry.wheeled = ids, len([idx for idx in ids if idx >= 0]), wheeled
            self.statics[('target', id(descr))] = entry
            live[self.records.STATIC_FIELD] = static
            record['target'] = live
        except Exception:
            LOG.debug('Target static half not kept', exc_info=True)

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
        # BACKLOG 27 (12.11): a shooter whose static half an earlier hit of this battle has built and written - the
        # same descriptor, mode and part models - is not read from the client again; only what is new at this shot is.
        shared = False
        before = len(record['warnings'])
        try:
            attacker = getattr(arena, 'vehicles', {}).get(attackerID, {}).get('vehicleType')
            shared = attacker is not None and self.shared_shooter(attacker, record, effectsIndex, gunInstallationIndex)
            if attacker is not None and not shared:
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
                    # His wheels, from his descriptor alone (no collision of his to ask): the rest place is added on the
                    # export thread, as for the target's.
                    try:
                        from local_armor_inspector.exporter import wheel_parts
                        parts.extend(wheel_parts(attacker))
                    except Exception:
                        pass
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
            if shared: pass
            elif attacker is not None:
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
        if attacker is not None and 'attacker' in record and not shared:
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
        if attacker is not None and not shared:
            self.keep_shooter(attacker, record, before, effectsIndex, gunInstallationIndex)
        for hit in hitPoints:
            record['rawHitPoints'].append({'networkID':str(hit['networkID']), 'segment':str(hit['segment']), 'params':str(hit['params'])})
        # Persist even when geometry cannot be recovered from a departed entity.
        try:
            descr = vehicle.typeDescriptor
            # BACKLOG 27 (12.11): a target whose static half an earlier hit of this battle has built and written - the same
            # descriptor, mode, part models and wheels - is not read from the client again: only its pose and what else is
            # new at this shot (shared_target). Anything else, or any read of the live half that fails: the full reading below.
            shared = self.shared_target(vehicle, descr, record)
            if shared is not None:
                collisions, root, known, poses, parts_out = shared
            else:
                before = len(record['warnings'])
                wheels_failed = False
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
                # The wheels of a wheeled vehicle, parts -1 ... -N (exporter.wheel_parts; their body and rest place are added
                # on the export thread). Only when the collision itself has them under these names (wheel_names).
                try:
                    wheels = wheel_parts_checked(descr, collisions)
                    if wheels:
                        record['target']['parts'].extend(wheels)
                        known.update(part['id'] for part in wheels)
                except Exception:
                    wheels_failed = True
                    LOG.exception('Wheel parts unavailable; the hit is recorded without them')
                # An armoured prefab a contact met before on this collision component: its pose at this hit. An index that
                # no longer gives the part a pose it can have (prefab_part) is forgotten - never recorded, never guessed.
                poses = dict((part['id'], part.get('transform')) for part in record['target']['parts'])
                parts_out = record['target']['parts']
            try:
                seen = _PREFAB_INDEX.get(id(collisions))
                if seen is not None and seen[0] == str(descr.type.name) and seen[1] not in known:
                    part = prefab_part(seen[1], descr, prefab_probe(seen[1], collisions, root, Math.Matrix), poses, seen[2])
                    if part:
                        parts_out.append(part)
                        known.add(part['id'])
                    else:
                        _PREFAB_INDEX.pop(id(collisions), None)
            except Exception:
                LOG.exception('Prefab part unavailable; the hit is recorded without it')
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
                    # The static part's client box, the very box parseHitPoint decoded start/end on (11.11): the scene
                    # rebuilt from the replay decodes the same point on it (replay_scene.recover_boxes). Not published for
                    # a live battle (Exporter.prepare_hit). A failure costs only this field, never the hit.
                    try:
                        if 0 <= idx <= collisions.maxStaticPartIndex:
                            box = collisions.getBoundingBox(idx)
                            point['partBounds'] = [vector(box[0]), vector(box[1])]
                    except Exception:
                        pass
                    if vector(start) == vector(end): continue
                    resolved = Decoder.collideHitPoint(idx, start, end, collisions)
                    if resolved is None: continue
                    pos, direction, normal = resolved
                    point.update({'position':vector(pos), 'direction':vector(direction), 'normal':vector(normal)})
                    # A contact on an armoured prefab (an index above the static parts): the part, posed at this hit. The
                    # client is asked for its parent and pose once (prefab_probe); the part keeps them, the point only
                    # its box - one copy of the pose (review of d1b372b).
                    probe = None
                    if idx not in known and idx > collisions.maxStaticPartIndex:
                        probe = prefab_probe(idx, collisions, root, Math.Matrix)
                        part = prefab_part(idx, descr, probe, poses)
                        if part:
                            parts_out.append(part)
                            known.add(idx)
                            remember_prefab(collisions, descr, part)
                    if idx not in known:
                        point['status'] = 'unsupported-part'
                        # A wheel or an armoured prefab: its name, parent and pose at impact, so the part can be
                        # identified and placed later (docs/BACKLOG.md 39). Only for such a point - rare. A prefab's
                        # parent and pose are the ones just read (probe), not asked again.
                        point.update(extra_part_info(idx, collisions, vehicle.appearance, root, Math.Matrix, probe))
                    else:
                        point['status'] = 'resolved'
                        # A contact on a wheel keeps what the collision says of it (its name, box and node pose); one on a
                        # prefab its box - the part holds its parent and pose - rare.
                        if idx < 0 or idx > collisions.maxStaticPartIndex:
                            point.update(extra_part_info(idx, collisions, vehicle.appearance, root, Math.Matrix))
                except Exception:
                    LOG.exception('Hit point could not be decoded')
            if shared is not None:
                # The parts that exist at this shot only (an armoured prefab): none, then no key (records.split_vehicle).
                if not parts_out: del record['target']['parts']
            elif not wheels_failed:
                self.keep_target(vehicle, descr, collisions, record, before)
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
    """The mods list button: the Vehicles mode on the vehicle the lobby shows (user, 25.09) - the previewed one while a
    vehicle preview is open (BACKLOG 93, 12.11), else the one selected in the hangar; the Hits mode is one click away
    on the page. No vehicle - the page as before, on the battles. The hangar vehicle's model the hangar hook has already
    asked for (on_hangar_vehicle); a previewed one is asked for here (owned - its hangar configuration, else the top one,
    picker_descriptor). The page opens waiting for that vehicle: if its export is still queued, it goes first (page_waits)."""
    try:
        from local_armor_inspector.presentation import open_in_game
        type_name, source = shown_vehicle()
        if source == 'preview' and _recorder is not None:
            try: _recorder.request_vehicle(picker_descriptor(type_name), 'preview')
            except Exception: LOG.exception('Previewed vehicle %s could not be asked for; the page asks itself', type_name)
        page_waits(type_name)
        open_in_game(VIEWER_PATH, hangar_fragment(type_name))
    except Exception:
        LOG.exception('Could not open local HTML viewer')


def shown_vehicle():
    """(type name, 'preview' | 'hangar') of the vehicle the lobby shows, or (None, None).

    CurrentVehicle.g_currentPreviewVehicle (a _CurrentPreviewVehicle: isPresent() = item is not None) holds the vehicle
    of the vehicle preview / Vehicle Hub, which clears it on exit (VehicleHubState._onExited -> selectNoVehicle(),
    2.4.1.1 bytecode); g_currentVehicle stays the hangar's during a preview. Read by getattr, so a client without the
    preview owner falls back to the hangar. One log line names the source."""
    try:
        import CurrentVehicle
        for owner, source in ((getattr(CurrentVehicle, 'g_currentPreviewVehicle', None), 'preview'),
                              (CurrentVehicle.g_currentVehicle, 'hangar')):
            item = owner.item if owner is not None and owner.isPresent() else None
            if item is not None and item.descriptor is not None:
                type_name = str(item.descriptor.type.name)
                LOG.info('Bullba Hits opens on %s, the %s vehicle', type_name, source)
                return type_name, source
    except Exception:
        LOG.exception('Hangar vehicle unavailable; the viewer opens on the battles')
    return None, None


def hangar_type():
    """The client type name of the vehicle the lobby shows (the previewed one first, shown_vehicle), or None."""
    return shown_vehicle()[0]


def hangar_fragment(type_name=None):
    """'host=game&vehicle=<id>' of that vehicle type (by default the one selected in the hangar), else 'host=game'."""
    if type_name is None: type_name = hangar_type()
    if not type_name: return 'host=game'
    try:
        from local_armor_inspector.exporter import vehicle_id
        return 'host=game&vehicle=' + vehicle_id(type_name)
    except Exception:
        LOG.exception('Hangar vehicle unavailable; the viewer opens on the battles')
    return 'host=game'


_follow_count = 0


def follow_hangar(type_name):
    """The hangar's vehicle changed to another type (VehicleEvents.on_hangar_vehicle): the open page shows it, if it
    browses vehicles (BACKLOG 94, user 12.11). The page says when it does ('follow'): a recorded battle the user studies
    is never taken off the screen, and outside the Vehicles mode nothing is pointed anywhere (no decision of the user
    on that; docs/BACKLOG.md row 94). The path is the context menu's: the vehicle first in the export queue, the open
    window re-navigated. The fragment carries a count of its own ('follow=<n>'): a navigation to the address the window
    already has is no change of its fragment and the page would not see it (measured in Chrome 157, 12.11), and the page
    takes a 'follow' fragment only while it still browses vehicles."""
    global _follow_count
    try:
        from local_armor_inspector import presentation
        if not presentation.page_follows(): return
        _follow_count += 1
        LOG.info('Bullba Hits page follows the hangar to %s', type_name)
        page_waits(type_name)
        presentation.open_in_game(VIEWER_PATH, hangar_fragment(type_name) + '&follow=%d' % _follow_count)
    except Exception:
        LOG.exception('Bullba Hits could not follow the hangar vehicle')


def page_waits(type_name):
    """The page is opened on this vehicle and waits for its file: whatever of it is still queued goes first, at the page's
    priority (the page's own 'prioritise', click-export-fast 26.09). Game thread: one message to the export thread."""
    if _recorder is None or not type_name: return
    _recorder.prioritise([type_name])


def picker_descriptor(type_name):
    """The configuration to export for a vehicle picked in the page's list.

    The player's own hangar configuration when the vehicle is in the inventory -
    items.makeIntCompactDescrByID('vehicle', nationID, innationID) builds the int
    compact descriptor, IItemsCache.items.getItemByCD returns the gui Vehicle and
    its .descriptor is FittingItem._descriptor, a VehicleDescr - otherwise the top
    configuration of the catalogue, exactly as the model sweep uses it.
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


def page_open():
    """The page reports it is open in the game. Game thread, a float."""
    if _recorder is None: return
    _recorder.note_page_open()


def page_sweep(start, kind='ttx'):
    """The page's Start or Stop of a sweep ('ttx' or 'models'). Game thread: the request only."""
    if _recorder is None: return
    _recorder.sweep_request(start, kind)


def page_prioritise(types):
    """The page opened a hit whose collision models are not extracted yet."""
    if _recorder is None: return
    _recorder.prioritise(types)


def page_battle(battle_id):
    """The page opened a stale saved battle and shows its old file meanwhile. Game thread: the request only."""
    if _recorder is None: return
    _recorder.request_battle(battle_id)


def page_playback(battle_id):
    """The page opened a battle in the 3D replay player (BACKLOG 104). Game thread: the request only."""
    if _recorder is None: return
    _recorder.request_playback(battle_id)


def page_player(kind, payload):
    """The 3D replay player's 'mapRaw' / 'playbackReport' (19.11). Game thread: the request only, through the export
    queue (the map's copy and the log line with what it decides belong to that thread)."""
    if _recorder is None or not payload: return
    _recorder.writer.put_export(kind, dict(payload))


def page_replays(payload):
    """The page's 'replayKeep' / 'replayLimit' (BACKLOG 107). Game thread: the request only."""
    if _recorder is None: return
    _recorder.request_replays(payload)


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
        page_waits(descr.type.name)
    open_in_game(VIEWER_PATH, 'host=game&vehicle=' + vehicle_id(descr.type.name))


def show_compared_vehicle(handler):
    """The Vehicle Comparison screen's entry (BACKLOG 95): export the column's vehicle as configured there and open the
    viewer on it.

    The handler is cmp_cm_handlers.VehicleCompareContextMenuHandler (2.4.1.1): _initFlashValues stores the column's
    basket index (int(ctx.index)) as the private __itemIndexInBasket, the class attribute comparisonBasket is the
    IVehicleComparisonBasket; getVehicleAt(index).getVehicleStrCD() is the compact descriptor of the vehicle with the
    modules chosen in the comparison (applyNewParameters: descriptor.makeCompactDescr()). Equipment, crew and shells
    are not in it and change nothing on the page's model. Unreadable - the vehicle by getVehCD() as the page's list
    would give it (picker_descriptor)."""
    from local_armor_inspector.exporter import vehicle_id
    from local_armor_inspector.presentation import open_in_game
    descr = None
    try:
        from items import vehicles as client_vehicles
        index = handler._VehicleCompareContextMenuHandler__itemIndexInBasket
        descr = client_vehicles.VehicleDescr(
            compactDescr=handler.comparisonBasket.getVehicleAt(index).getVehicleStrCD())
    except Exception:
        LOG.exception('Comparison configuration unreadable; the vehicle opens as the page list gives it')
    if descr is None:
        from helpers import dependency
        from skeletons.gui.shared import IItemsCache
        vehicle = dependency.instance(IItemsCache).items.getItemByCD(handler.getVehCD())
        descr = picker_descriptor(str(vehicle.descriptor.type.name))
    type_name = str(descr.type.name)
    LOG.info('Bullba Hits opens on %s from the vehicle comparison', type_name)
    if _recorder is not None:
        _recorder.request_vehicle(descr, 'compare')
        page_waits(type_name)
    open_in_game(VIEWER_PATH, 'host=game&vehicle=' + vehicle_id(type_name))


# The vehicle context menus that carry the Bullba Hits entry: (module, class, what the entry does). The comparison
# menu's class is CONTEXT_MENU_HANDLER_TYPE.VEH_COMPARE, the one handler vehicle_compare/__init__.getContextMenuHandlers
# registers (2.4.1.1); its _generateOptions is inherited from CommonContextMenuHandler and wrapped on the subclass.
CONTEXT_MENUS = (
    ('gui.Scaleform.daapi.view.lobby.hangar.hangar_cm_handlers', 'VehicleContextMenuHandler', 'show_vehicle'),
    ('gui.Scaleform.daapi.view.lobby.vehicle_compare.cmp_cm_handlers', 'VehicleCompareContextMenuHandler',
     'show_compared_vehicle'),
)


def install_context_menu():
    """The Bullba Hits entry in each menu of CONTEXT_MENUS; a menu whose class is missing is skipped with a log line,
    the others still get theirs. Returns the hooks for remove_context_menu."""
    installed = []
    for module_name, class_name, action in CONTEXT_MENUS:
        try:
            cls = getattr(__import__(module_name, fromlist=[class_name]), class_name)
            installed.extend(install_menu_entry(cls, globals()[action]) or ())
        except Exception:
            LOG.exception('%s context menu unavailable; the other entries stay', class_name)
    return installed


def install_menu_entry(menu_class, action):
    """Append the Bullba Hits entry to one vehicle context menu class; its click runs action(handler).

    A package's getContextMenuHandlers() registers a handler type -> class (hangar: CONTEXT_MENU_HANDLER_TYPE.VEHICLE
    -> VehicleContextMenuHandler; the comparison: VEH_COMPARE -> VehicleCompareContextMenuHandler), and
    ContextMenuManager.requestOptions builds that class and sends handler.getOptions(ctx) -> _generateOptions(ctx) to
    Flash, then routes the click back through handler.onOptionSelect(optionId). Wrapping those two class methods is
    therefore all an option needs; AbstractContextMenuHandler._makeItem builds the option dict (id, label, iconType,
    initData, submenu, linkage).

    Idempotent: a reloaded module finds its own marker and leaves the class alone.
    """
    from local_armor_inspector.telemetry import wrap
    if getattr(menu_class._generateOptions, 'bullba_hits', False): return None

    def make_generate(generate):
        def bullba_generate_options(handler, ctx=None):
            options = generate(handler, ctx)
            try:
                options = list(options or [])
                options.append(menu_class._makeItem(CONTEXT_MENU_OPTION, CONTEXT_MENU_LABEL))
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
                action(handler)
            except Exception:
                LOG.exception('Bullba Hits could not open the selected vehicle')
            return None
        bullba_option_select.bullba_hits = True
        return bullba_option_select

    # The recorder's one wrapper (telemetry.wrap, REC-10): remove_context_menu puts back the class's own entries -
    # an inherited method (onOptionSelect; the comparison's _generateOptions) is removed from the subclass rather
    # than copied onto it.
    hooks = [wrap(menu_class, '_generateOptions', make_generate),
             wrap(menu_class, 'onOptionSelect', make_select)]
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
        from local_armor_inspector.telemetry import wrap, CLOCK, HIT
        _recorder = Recorder(os.path.join('mods', 'configs', 'local.armor_inspector', 'battles'))
        recorder = _recorder
        add = recorder.cost.add
        def make(original):
            def wrapper(vehicle, *args, **kwargs):
                t0 = CLOCK()
                try: recorder.capture(vehicle, *args, **kwargs)
                except Exception: LOG.exception('Recorder failed; game handler continues')
                add(HIT, CLOCK() - t0)
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
        try:
            # The battle's replay stream: the game records every live battle, the copy lands beside the battle's
            # record and goes to the export thread after the battle (and, after a crash, at this start).
            # Its gate is the recording gate without the arena (the arena comes after the avatar): a replay being
            # played is refused inside, a spectator seat here.
            # The replay limit (BACKLOG 107): with it on, the battle's whole final file is renamed to the mod's name.
            from local_armor_inspector.replay_source import ReplaySource
            from local_armor_inspector.replay_library import Library
            from local_armor_inspector.telemetry import observer_seat
            library = Library(os.path.join(os.getcwd(), 'replays'), os.path.dirname(os.path.abspath(_recorder.writer.folder)))
            _recorder.replay = ReplaySource(_recorder.writer.folder, _recorder.session, _recorder.writer.put_export,
                                            gate=lambda player: recorder.enabled and not observer_seat(player),
                                            library=library)
            _recorder.replay.install()
        except Exception: LOG.exception('Replay source unavailable; hit recording continues')
        try: _context_menu = install_context_menu()
        except Exception: LOG.exception('Hangar context menu unavailable; hit recording continues')
        try:
            from local_armor_inspector import presentation
            presentation.set_export_request(export_picked_vehicle)
            presentation.set_busy_request(page_busy)
            presentation.set_prioritise_request(page_prioritise)
            presentation.set_ttx_request(page_ttx)
            presentation.set_open_request(page_open)
            presentation.set_sweep_request(page_sweep)
            presentation.set_battle_request(page_battle)
            presentation.set_playback_request(page_playback)
            presentation.set_player_request(page_player)
            presentation.set_replays_request(page_replays)
            presentation.set_load_listener(_recorder.note_page_loading)
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
        presentation.set_open_request(None)
        presentation.set_sweep_request(None)
        presentation.set_battle_request(None)
        presentation.set_playback_request(None)
        presentation.set_player_request(None)
        presentation.set_replays_request(None)
        presentation.set_load_listener(None)
        # The open window's trace (blue window, 03.10): its listeners and wrappers leave the client's objects.
        presentation.close_window_trace()
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
        # Before the writer closes: a battle ending now still reaches the export thread's queue.
        replay = getattr(_recorder, 'replay', None)
        if replay is not None:
            try: replay.close()
            except Exception: LOG.exception('Replay source cleanup failed')
        _recorder.writer.close()
        _recorder = None
