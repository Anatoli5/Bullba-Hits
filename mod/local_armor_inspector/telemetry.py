# -*- coding: utf-8 -*-
"""Event-only aim snapshots. Never request extra server data or change aiming."""
from __future__ import absolute_import
import copy
import logging
import math
import numbers
import time

LOG = logging.getLogger('local.armor_inspector')


def number(value):
    result = float(value)
    if math.isnan(result) or math.isinf(result): raise ValueError('Non-finite number')
    return result


def vec(value):
    return [number(value[i]) for i in range(3)]


def marker(info):
    return {'position':vec(info.position), 'direction':vec(info.direction),
            'diameter':number(info.size), 'receivedAt':time.time()}


# The live state of the shooter's gun mechanics, by the client's own names (owner's decision 22.09: for the
# player's OWN shot the state is known and must be recorded, for other vehicles the replicated public state,
# and for an incoming shot with no state nothing is guessed). Research: outputs/own-gun-state-2026-09-22.md.
#
# Every one of these is a BigWorld dynamic component of the Vehicle ENTITY, not of the descriptor:
# `vehicle.dynamicComponents` is a plain dict keyed by the component's DefaultKeyName, which is exactly how
# the client itself reads them (scripts/client/vehicles/mechanics/mechanic_helpers.pyc,
# getVehicleMechanicComponent -> findVehicleMechanicDynamicComponent, disassembled in client 2.4.0.1). A
# property is either a number or a FIXED_DICT declared in scripts/entity_defs/alias.xml; none of those
# dictionaries has an `implementedBy`, and the client reads their fields as ATTRIBUTES
# (ChargeShotComponent.__getCurrentState: privateState.flags / .level / .endTime), which is what is done
# below. Nothing here calls a controller method, subscribes to an event or keeps per-frame state.
#
# Each entry is (component key, property on the component, name in the record, fields of the FIXED_DICT or
# None for a plain number, own-vehicle-only). "own only" means the property carries DetailLevel = MY_VEHICLE
# in its component def - or the whole component does, at the root of its def (concentrationMode,
# autoreloaderSurge, stationaryReload, battleFury, supportWeapon, dualAccuracy, overheatGun), and then a
# foreign vehicle most likely has no such component at all - and the server replicates it to the player's own
# vehicle alone; it is read for the player's own shot and skipped for everybody else, so a default value is
# never recorded as if it were a state. The keys are the client's own mechanic names (the MECHANICS_NAME
# constants of items/components/shared_components.pyc, the VehicleMechanic names of mechanic_constants.pyc);
# which of them a vehicle has is decided by mechanic_names below - the descriptor's mechanicsParams, and for
# four of them the gun's tags, the type's flag or a companion mechanic - so only the vehicles of this client
# that carry one cost anything at all. A field that is itself a TIME_INTERVAL {startTime, endTime} is not
# listed: state_value keeps plain numbers only, and the enclosing state already says the same.
GUN_MECHANIC_STATE = {
    'shellParamsSwitcher': (
        ('shellParamsSwitcherController', 'status', 'status', ('state', 'endTime'), False),
        ('shellParamsSwitcherController', 'publicStatus', 'publicStatus',
         ('isActive', 'lastActiveShotTimestamp'), False)),
    'lowChargeShot': (
        ('lowChargeShotPublicController', 'stateStatus', 'publicState',
         ('visualState', 'fullShotChangeTime'), False),
        ('lowChargeShotController', 'stateStatus', 'privateState',
         ('reloadingState', 'baseTime', 'timeLeft', 'endTime', 'lowChargeTime'), True)),
    'chargeShot': (
        ('chargeShotComponent', 'publicState', 'publicState', ('flags', 'level'), False),
        ('chargeShotComponent', 'privateState', 'privateState', ('flags', 'level', 'endTime'), True)),
    'propellantAfterburnerGun': (
        ('propellantGunController', 'status', 'status',
         ('state', 'chargeStageID', 'chargeProgress', 'isOverchargeEnabled', 'isSwitchCooldownActive',
          'updateTimestamp', 'isForbiddenShell', 'lastShotTimestamp', 'lastShotCharge'), False),),
    'overheatStacks': (
        ('overheatStacksController', 'gainState', 'gainState', None, False),
        ('overheatStacksController', 'curLevel', 'curLevel', None, False),
        ('overheatStacksController', 'delayTimerElapsed', 'delayTimerElapsed', None, True),
        ('overheatStacksController', 'timeElapsed', 'timeElapsed', None, True),
        ('overheatStacksController', 'timeNextGain', 'timeNextGain', None, True)),
    'chargeableBurst': (
        ('chargeableBurstComponent', 'charges', 'charges', None, True),
        ('chargeableBurstComponent', 'shots', 'shots', None, True),
        ('chargeableBurstComponent', 'isBurstActive', 'isBurstActive', None, True)),
    'bustleFeed': (
        ('bustleFeedController', 'status', 'status', ('state', 'baseTime', 'endTime', 'switchAccessState'), True),
        ('bustleFeedController', 'reloadStatus', 'reloadStatus', ('timeLeft', 'baseTime', 'endTime'), True)),
    # The Vz. 63P (czech:Cz46_Vz_63P) carries this one in its gun's <mechanics> - the first reading of 22.09
    # looked at the vehicle files only and found no carrier. The client's own lookup table names the component
    # 'ShellCalibrationController' while its def declares DefaultKeyName 'shellCalibrationController'. The
    # def is what the entity is keyed by, so that is the name used here.
    'shellCalibration': (
        ('shellCalibrationController', 'status', 'status', None, True),),
    'secondaryGun': (
        ('secondaryGunComponent', 'gunInstallationIndex', 'gunInstallationIndex', None, False),),
    # 23.09, docs/BACKLOG.md row 34 - part (a) of outputs/mechanics-impact-2026-09-23.md: the tier XI
    # mechanics, the gun's heat, the autocannons, the dual-accuracy guns and the rocket acceleration. Fields
    # by scripts/entity_defs/alias.xml, visibility and keys by each component's def (client 2.4.0.1). Every
    # value is written as the client holds it; what a packed state means is left to the page once a battle
    # has shown it.
    'stanceDance': (  # CS-67 Szakal; state is the client's bit mask of stance, switching and abilities
        ('stanceDanceController', 'abilityState', 'abilityState', ('state', 'energyFight', 'energyTurbo'), False),),
    'powerMode': (  # AT-FV230 Breaker
        ('powerModeController', 'stateStatus', 'stateStatus',
         ('state', 'powerProgress', 'stateActivationTime', 'directionFactor'), False),
        ('powerModeController', 'timeInfo', 'timeInfo', ('modeThreshold', 'modeDuration'), False)),
    'concentrationMode': (  # XM69 Hacker
        ('concentrationModeComponent', 'status', 'status', ('state', 'baseTime', 'endTime'), True),),
    'pillboxSiegeMode': (  # Strv 107-12; on the base and the siege descriptor alike
        ('pillboxSiegeComponent', 'publicStatus', 'publicStatus', ('state', 'nextState'), False),
        ('pillboxSiegeComponent', 'status', 'status', ('baseTime', 'endTime'), True)),
    'targetDesignator': (  # leKpz Borkenkafer, the shooter's side; the mark on a target is another component
        ('targetDesignatorController', 'abilityState', 'abilityState', ('state', 'startTime', 'endTime'), False),),
    'temperatureGun': (  # the five Ares and the STK-2
        ('temperatureGunController', 'stateStatus', 'stateStatus',
         ('state', 'thermalStateID', 'updateTime', 'directionFactor', 'currentTemperature', 'coolingPerSecFactor'),
         False),),
    'overheatGun': (  # the five Ares
        ('overheatGunComponent', 'state', 'state', None, True),),
    'accuracyStacks': (  # Leopard 120 Verbessert
        ('accuracyStacksController', 'abilityState', 'abilityState',
         ('curLevel', 'maxLevel', 'timeElapsed', 'gainMaxSpdKmh', 'gainTime', 'aimLevelBonus'), False),),
    'autoreloaderSurge': (  # CAV mod. 71
        ('autoreloaderSurgeController', 'abilityState', 'abilityState', ('state', 'charges', 'restrictions'), True),),
    'crestMoving': (  # the CAV mod. 71's crest: the direction it moves in, not its position; key with a capital
        ('CrestMovingController', 'state', 'state', None, False),),
    'stationaryReload': (  # AS-XX 40 t
        ('stationaryReloadController', 'status', 'status',
         ('state', 'baseTime', 'timeLeft', 'gunLockMask', 'sequenceEndTime'), True),),
    'extraShotClip': (  # AMX 67 Imbattable
        ('extraShotClipComponent', 'reloadState', 'reloadState', None, False),),
    'battleFury': (  # T803
        ('battleFuryController', 'abilityState', 'abilityState', ('currentLevel', 'maxLevel'), True),),
    # Ho-Ri Shugo. The key is the def's DefaultKeyName; VEHICLE_MECHANIC_DYN_COMPONENT_NAMES of the client
    # says 'auxiliaryRocketLauncherComponent', the same mismatch as shellCalibration above.
    'auxiliaryRocketLauncher': (
        ('auxiliaryRocketLauncher', 'visualStatus', 'visualStatus', ('isReloaded', 'reloadStartTime'), False),
        ('auxiliaryRocketLauncher', 'status', 'status', ('state', 'baseTime', 'endTime'), True)),
    'supportWeapon': (  # Taschenratte
        ('supportWeaponComponent', 'status', 'status', ('state', 'baseTime', 'endTime', 'gunInstallationIndex'), True),),
    'autoShoot': (  # a gun tag: the five Ares, PGZ-70, Blesk, Selma, Squall, Tesak
        ('autoShootGunController', 'stateStatus', 'stateStatus', ('state', 'rateMultFactor'), False),
        ('autoShootGunController', 'defaultShotRate', 'defaultShotRate', None, False),
        ('autoShootGunController', 'dispersionStatus', 'dispersionStatus',
         ('dispersionFactor', 'updateTime', 'shotDispersionPerSec', 'maxShotDispersion'), True)),
    'dualAccuracy': (  # a gun tag: nine vehicles
        ('dualAccuracy', 'state', 'state', None, True),),
    'rocketAcceleration': (  # a flag of the type: sixteen vehicles
        ('rocketAccelerationController', 'stateStatus', 'stateStatus',
         ('status', 'endTime', 'timeLeft', 'reuseCount'), False),),
}

# The mechanics a descriptor does not list in its mechanicsParams, and what names them instead (23.09).
# autoShoot and dualAccuracy are flags of the mounted gun, descr.gun.tags (vehicles.pyc _readGun; the recorded
# aim.gunTags of an Ares and of a dual-accuracy gun carry them). rocketAcceleration is a section at the root of
# the vehicle file: VehicleType.__init__ sets type.hasRocketAcceleration = 'rocketAcceleration' in its tags and
# the descriptor exposes the same name as a property (vehicles.pyc 1059), like hasSiegeMode. The crest of the
# CAV mod. 71 comes with its gun's prefab (slotPrefabs/crest_module) and sits in no <mechanics> block at all;
# its one carrier has autoreloaderSurge, so it is looked for on the vehicles with that one - a vehicle without
# the component costs one dictionary lookup and records nothing.
GUN_TAG_MECHANICS = ('autoShoot', 'dualAccuracy')
TYPE_FLAG_MECHANICS = (('hasRocketAcceleration', 'rocketAcceleration'),)
COMPANION_MECHANICS = {'autoreloaderSurge': ('crestMoving',)}


def mechanics_params(descr):
    """The mechanics a vehicle descriptor carries, its own and its mounted gun's together (22.09).

    VehicleType.__init__ (vehicles.pyc 3515-3524, client 2.4.0.1) reads into type.mechanicsParams only the
    mechanics classes without a COMPONENT_TYPE_ID. Every subclass of GunMechanicsParams - shellParamsSwitcher,
    lowChargeShot, shellCalibration, propellantAfterburnerGun, chargeableBurst, stationaryReload,
    extraShotClip, secondaryGun, temperatureGun, overheatGun, heatingZonesGun, auxiliaryRocketLauncher - is
    read with the GUN instead (_readItemMechanicsParams) and is never on the type. The descriptor merges the
    two: VehicleDescriptor.__updateAttributes (vehicles.pyc 2558-2659) fills descr.mechanicsParams from
    type.mechanicsParams and from every gun installation, applies the field modifications to the copies
    (applyMiscAttrToMechanics) and drops the inactive ones. That dict is what the client itself reads
    (mechanic_helpers.getVehicleDescrMechanicParams), so it is read here; a descriptor without it gets the
    two merged by hand. Never raises; an empty dict when nothing is known.
    """
    params = getattr(descr, 'mechanicsParams', None)
    if isinstance(params, dict):
        return params
    merged = {}
    for owner in ('type', 'gun'):
        try:
            merged.update(getattr(getattr(descr, owner), 'mechanicsParams', None) or {})
        except Exception:
            pass
    return merged


def state_value(value):
    """One number of a mechanic component, or None when the client has nothing usable there.

    The same rule exporter.json_safe uses for a number, written out here because the values are read
    one by one out of a fixed dictionary and a non-finite float would cost the Writer the whole record.
    """
    if value is None or isinstance(value, bool): return value
    if isinstance(value, numbers.Integral): return int(value)
    if isinstance(value, numbers.Real):
        result = float(value)
        return result if result - result == 0 else None
    return None


def mechanic_names(descr):
    """The mechanics a vehicle descriptor carries, as a set of names for GUN_MECHANIC_STATE (23.09).

    The keys of its mechanicsParams (mechanics_params), the gun tags of GUN_TAG_MECHANICS the mounted gun
    has, the names of TYPE_FLAG_MECHANICS whose flag is set, and the companions of what was found. A few
    attribute reads on the descriptor, no call into the client. Never raises; each source that fails simply
    adds nothing.
    """
    names = set()
    try:
        for name in mechanics_params(descr):
            names.add(str(name))
    except Exception:
        pass
    try:
        tags = descr.gun.tags
        for tag in GUN_TAG_MECHANICS:
            if tag in tags: names.add(tag)
    except Exception:
        pass
    for flag, name in TYPE_FLAG_MECHANICS:
        try:
            if getattr(descr, flag, False): names.add(name)
        except Exception:
            pass
    for name in tuple(names):
        names.update(COMPANION_MECHANICS.get(name, ()))
    return names


def mechanic_state(entity, own):
    """The state of the shooter's gun mechanics at this instant, {mechanic: {property: value}}.

    One dictionary lookup per mechanic the vehicle really has and a few attribute reads; empty - and
    therefore left out of the record - for every vehicle without one, which is all but a few dozen of the
    client's vehicles. Never raises: a component that is not attached, a property the server has not sent
    and an entity outside the area of interest all simply leave their field out.
    """
    result = {}
    components = getattr(entity, 'dynamicComponents', None)
    if not components: return result
    try:
        names = mechanic_names(entity.typeDescriptor)
    except Exception:
        return result
    for name in names:
        entries = GUN_MECHANIC_STATE.get(name)
        if not entries: continue
        values = {}
        for key, prop, out, fields, private in entries:
            if private and not own: continue
            try:
                component = components.get(key)
                if component is None: continue
                value = getattr(component, prop, None)
                if value is None: continue
                if fields is None:
                    item = state_value(value)
                    if item is not None: values[out] = item
                    continue
                packed = {}
                for field in fields:
                    item = state_value(getattr(value, field, None))
                    if item is not None: packed[field] = item
                if packed: values[out] = packed
            except Exception:
                LOG.debug('Gun mechanic state unavailable: %s.%s', key, prop, exc_info=True)
        if values: result[str(name)] = values
    return result


def designator_mark(entity):
    """The leKpz Borkenkafer's mark on this vehicle, {creatorID, startTime, endTime}, or None (BACKLOG 38, 23.09).

    The Borkenkafer's targetDesignator arms its next shot; a hit on a spotted target marks it for 10 s (12.5 with
    the full skill tree), and every shell from ANY shooter then deals it damageIncomeFactor 1.1 (1.15) - applied by
    the server. The mark lives on the TARGET: targetDesignatorTargetController.spottedMarker (TARGET_DESIGNATOR_MARKER
    {creatorID, startTime, endTime}, ALL_CLIENTS in its def, client 2.4.0.1), so it is read off the entity the hit
    lands on - one dictionary lookup, the same way mechanic_state reads the shooter. Written only when a mark was
    ever set (a creator or an end time): the component's default says nothing. The times are server time, the
    clock of the record's own gameTime, and whether the mark is still on at the impact is the page's comparison.
    Never raises.
    """
    components = getattr(entity, 'dynamicComponents', None)
    if not components: return None
    try:
        component = components.get('targetDesignatorTargetController')
        marker = getattr(component, 'spottedMarker', None) if component is not None else None
        if marker is None: return None
        packed = {}
        for field in ('creatorID', 'startTime', 'endTime'):
            item = state_value(getattr(marker, field, None))
            if item is not None and not isinstance(item, bool): packed[field] = item
        if not (packed.get('creatorID') or packed.get('endTime')): return None
        return packed
    except Exception:
        LOG.debug('Designator mark unavailable', exc_info=True)
        return None


# VEHICLE_TAGS.OBSERVER of the client (gui/shared/gui_items/Vehicle.pyc): the tag of the spectator seat's vehicle
# type (ussr:Observer is the only type carrying it in 2.4.0.1, scripts/item_defs/vehicles/ussr/list.xml).
OBSERVER_TAG = 'observer'


def observer_seat(player):
    """Whether the player sits in a spectator seat: the client's own first test of it (VehicleArenaInfoVO.isObserver,
    arena_vos.pyc 734: the seat's vehicle type carries the 'observer' tag).

    NOT player.isObserver() while the seat's type is known: that cached flag is also raised when the player has died.
    Onslaught and Steel Hunter call BigWorld.player().setIsObserver() on the switch to the post-mortem view
    (comp7_core ... battle/page.pyc Comp7BattlePage._switchToPostmortem; battle_royale ... page.pyc), and a mode with
    the bonus cap BECOME_AN_OBSERVER_AFTER_DEATH makes the dead player an observer the same way. Asking that flag
    stopped every recording path at the player's death in Onslaught (24.09: 46 s, 16 hits lost in one battle).
    Only while the seat's own type is not known yet (the first arena list of an Onslaught battle, or a player id of
    0) the flag answers - before his death it is the seat's own. Two dictionary reads and a set lookup."""
    try: descr = player.arena.vehicles[player.playerVehicleID]['vehicleType']
    except Exception: descr = None
    if descr is not None:
        try: return OBSERVER_TAG in descr.type.tags
        except Exception: pass
    return bool(getattr(player, 'isObserver', lambda: False)())


def recording(recorder, player):
    """The one gate of every recording path: the recorder is on, the player has an arena, and it is his own live
    battle - not a replay being played and not a spectator seat (observer_seat: the seat, not the player's death).

    The hit capture and the roster (Recorder), the shot telemetry (and the motion sampler through it) and the crit
    log all ask here before they write, so a replay or an observer seat never opens a battle file. Before 24.09 the
    roster path had no such check and a replay wrote a fake live battle (REC-01). A battle is recorded until the
    avatar leaves it (onAvatarBecomeNonPlayer), the player's death included. Attribute reads only; the import of an
    already loaded module is a dictionary lookup, as it was in each of the four copies this replaces."""
    if not recorder.enabled or getattr(player, 'arena', None) is None: return False
    import BattleReplay
    if BattleReplay.g_replayCtrl.isPlaying: return False
    return not observer_seat(player)


def wrap(cls, name, make):
    """The one way the recorder wraps a client method (REC-10): cls.name becomes make(original).

    `original` is what the class hands out (getattr, inherited or not) and is called as original(instance, ...).
    What unwrap() puts back is the class's own dictionary entry, None when the method is inherited. Python 2 hands
    out a new unbound method object on every getattr, so an identity test on it is always false and putting it back
    leaves an unbound method object in place of the class's function - the hit and telemetry hooks were never
    removed that way (measured 24.09 under the client's python27.dll: 9 of 25 left wrapped after fini()).
    Returns the record for unwrap(), or None when the class has no such attribute."""
    original = getattr(cls, name, None)
    if original is None: return None
    saved = vars(cls).get(name)
    wrapper = make(original)
    setattr(cls, name, wrapper)
    return (cls, name, saved, wrapper)


def unwrap(hooks):
    """Put back what wrap() replaced, newest first; a method someone else re-wrapped since is left to its owner."""
    for cls, name, saved, wrapper in reversed(list(hooks)):
        if vars(cls).get(name) is not wrapper: continue
        if saved is not None: setattr(cls, name, saved)
        else: delattr(cls, name)


class ShotTelemetry(object):
    def __init__(self, recorder):
        self.recorder = recorder
        self.hooks = []
        self.arena = None
        self.reset()

    def reset(self):
        self.client_marker = None
        self.server_marker = None
        self.server_vector = None
        self.targeting = None
        self.commands = []
        self.tracers = {}
        self.sequence = 0
        # gameTime of the player's previous shot. The after-shot term of the dispersion formula
        # decays from it, and the offline calibration needs the instant, not a hook of its own:
        # this is the tracer bookkeeping already running here, remembering one number more.
        self.last_own_shot = None
        # The own shot still waiting for the server gun updates that come AFTER its tracer (BACKLOG 28 step 2,
        # 24.09): {'tracerId', 'updates', 'gameTime', 'player'}, or None. See server_update() and tracer().
        self.after_shot = None

    def active(self, player):
        if not recording(self.recorder, player): return False
        identity = str(player.arena.arenaUniqueID)
        if identity != self.arena:
            self.reset()
            self.arena = identity
        return True

    def emit(self, player, event, values, gameTime=None):
        """One shot event. `gameTime` is passed in when the caller already read the clock for it,
        so a record and the ages computed against it are the same instant and serverTime() is
        called once, not twice."""
        if not self.active(player): return None
        if not self.recorder.ensure_battle(player): return None
        self.sequence += 1
        if gameTime is None: gameTime = number(self.recorder.bw.serverTime())
        record = {'schema':1, 'type':'shot', 'event':event, 'id':'s'+str(self.sequence),
                  'receivedAt':time.time(), 'gameTime':gameTime}
        record.update(values)
        self.recorder.writer.put(self.recorder.file, record)
        return record

    def snapshot(self, player):
        result = {'source':'client snapshot before waiting for shot confirmation', 'unavailable':[]}
        def get(name, action):
            try: result[name] = action()
            except Exception: result['unavailable'].append(name)
        rotator = getattr(player, 'gunRotator', None)
        # VehicleGunRotator.getCurShotDispersionAngles returns the client's own current dispersion
        # pair; getCurShotPosition() is __getShotPosition(__turretYaw, __gunPitch) and returns the
        # muzzle point and the shot velocity, so its second half IS the gun's world axis times the
        # shell's speed. Asked for once here and used three times - it used to be asked twice.
        get('dispersionAngles', lambda: [number(v) for v in rotator.getCurShotDispersionAngles()])
        shot = []
        def shot_position():
            if not shot: shot.append(rotator.getCurShotPosition())
            return shot[0]
        def gun_direction():
            value = vec(shot_position()[1])
            length = math.sqrt(value[0]*value[0]+value[1]*value[1]+value[2]*value[2])
            if not length: raise ValueError('Gun axis has no length')
            return [v/length for v in value]
        get('gunOrigin', lambda: vec(shot_position()[0]))
        get('gunVelocity', lambda: vec(shot_position()[1]))
        get('gunDirection', gun_direction)
        get('desiredPoint', lambda: vec(player.inputHandler.getDesiredShotPoint(getattr(rotator, 'ignoreAimingMode', False))))
        get('turretYaw', lambda: number(rotator.turretYaw))
        # The other half of the own gun axis in the vehicle's own frame; the packed pair of every
        # other vehicle carries exactly these two angles, so own and foreign shots compare directly.
        get('gunPitch', lambda: number(rotator.gunPitch))
        get('turretRotationSpeed', lambda: number(rotator.turretRotationSpeed))
        get('vehicleSpeeds', lambda: [number(v) for v in player.getOwnVehicleSpeeds(True)])
        if self.client_marker is not None: result['clientMarker'] = copy.deepcopy(self.client_marker)
        else:
            def current_marker():
                p, d, diameter = rotator.markerInfo
                return {'position':vec(p), 'direction':vec(d), 'diameter':number(diameter), 'receivedAt':time.time()}
            get('clientMarker', current_marker)
        if self.server_marker is not None: result['serverMarker'] = copy.deepcopy(self.server_marker)
        if self.server_vector is not None: result['lastServerGunUpdate'] = copy.deepcopy(self.server_vector)
        if self.targeting is not None: result['targeting'] = copy.deepcopy(self.targeting)
        def selected_shell():
            from .armor import shot_parameters
            vehicle = self.recorder.bw.entity(player.playerVehicleID)
            return shot_parameters(vehicle.typeDescriptor.shot, 'selected shell at client command')
        get('selectedShell', selected_shell)
        get('baseDispersionAngle', lambda: number(self.recorder.bw.entity(player.playerVehicleID).typeDescriptor.gun.shotDispersionAngle))
        return result

    def command(self, player, shotParams):
        if not self.active(player): return
        values = {'shooterId':player.playerVehicleID, 'aim':self.snapshot(player),
                  'gunIndex':int(getattr(shotParams, 'gunIndexDelayed', 0)),
                  'predicted':bool(getattr(shotParams, 'predictShooting', False))}
        record = self.emit(player, 'command', values)
        if record:
            self.commands = [c for c in self.commands if time.time()-c['receivedAt'] < 3][-31:]
            self.commands.append(record)

    def tracer(self, player, shooterID, shotID, isRicochet, effectsIndex, prefabEffIndex,
               shellTypeIdx, shellCaliber, refStartPoint, velocity, gravity, maxShotDist, gunIndex, gunInstallationIndex):
        if not self.active(player): return
        values = {'shooterId':int(shooterID), 'shotId':str(shotID), 'isRicochet':bool(isRicochet),
                  'effectsIndex':int(effectsIndex), 'shellTypeIdx':int(shellTypeIdx), 'caliber':number(shellCaliber),
                  'origin':vec(refStartPoint), 'velocity':vec(velocity), 'gravity':number(gravity),
                  'maxDistance':number(maxShotDist), 'gunIndex':int(gunIndex), 'gunInstallationIndex':int(gunInstallationIndex),
                  'source':'received Avatar.showTracer', 'own':shooterID == player.playerVehicleID}
        # R2 of outputs/mode-shell-modifiers-2026-09-22.md: the shooter's siege state at the moment the
        # shot leaves the barrel - the one moment that really decides which of his two shells flew. Only
        # for a vehicle that has two modes; an ordinary one would carry a 0 that says nothing. Vehicle
        # .siegeState is UINT8/ALL_CLIENTS, so it is readable for every vehicle in the area of interest,
        # the player's own included. Guarded: an entity outside the AoI simply leaves the field out.
        # The live state of the gun mechanics rides on the very same entity lookup (22.09): one read per
        # shot, at the instant the shell leaves the barrel - the moment the owner's decision is about.
        # Private properties only for his own shot; for every other vehicle the replicated public state.
        try:
            entity = self.recorder.bw.entity(int(shooterID))
            if entity is not None:
                if getattr(entity.typeDescriptor, 'hasSiegeMode', False):
                    values['siegeState'] = int(entity.siegeState)
                state = mechanic_state(entity, shooterID == player.playerVehicleID)
                if state: values['gunState'] = state
        except Exception: pass
        if values['own'] and not isRicochet and gunInstallationIndex == 0:
            values['aimAtTracer'] = self.snapshot(player)
            values['aimAtTracer']['source'] = 'client snapshot when own tracer received'
            possible = [c for c in self.commands if 0 <= time.time()-c['receivedAt'] <= 2 and c['gunIndex'] in (gunIndex, -1)]
            values['commandCandidates'] = [c['id'] for c in possible]
            # The damage callback has no shot ID and a command is not server confirmation.
            # Preserve the provenance instead of claiming an exact association.
            if len(possible) == 1:
                values['possibleCommandId'] = possible[0]['id']
                values['association'] = 'single recent command; temporal association, not server identity'
                if possible[0]['gunIndex'] != -1: self.commands.remove(possible[0])
        # The logging half of the aiming-circle calibration (owner's decision 22.09,
        # docs/BACKLOG.md row 28). A ricochet tracer is a continuation, not a shot, so it is left
        # out of all three. The clock is read once here and handed to emit() below.
        shot_time = None
        if values['own'] and not isRicochet:
            shot_time = number(self.recorder.bw.serverTime())
            vector = self.server_vector
            if vector is not None and vector.get('gameTime') is not None:
                # The artefact of the method (KNOWLEDGE section 6): the last server aim vector is
                # older than the shot, which is why the horizontal spread of the 19.09 measurement
                # is not a law. Recorded now instead of inferred, on the gameTime clock.
                values['serverVectorAge'] = shot_time-vector['gameTime']
            if self.last_own_shot is not None:
                values['previousShotGameTime'] = self.last_own_shot
                values['sinceLastShot'] = shot_time-self.last_own_shot
            self.last_own_shot = shot_time
            try:
                motion = self.recorder.motion.history(int(shooterID))
                if motion: values['motion'] = motion
            except Exception:
                LOG.debug('Own motion history unavailable', exc_info=True)
        record = self.emit(player, 'tracer', values, shot_time)
        if record and 'aimAtTracer' in values:
            pending = self.after_shot
            # A two-gun salvo: the second barrel's tracer comes at the same instant as the first (same gameTime). It
            # shares the first one's wait - the updates after the salvo belong to both barrels, and a new wait would
            # drop the first one's with nothing in it (review 24.09) - and the page finds the record through that
            # instant. A later shot before the previous one got its two updates (an autocannon) closes the previous
            # with what it has.
            if not (pending is not None and shot_time is not None and pending['gameTime'] is not None
                    and abs(shot_time-pending['gameTime']) < 1e-3):
                self.flush_after_shot(player)
                self.after_shot = {'tracerId':record['id'], 'updates':[], 'gameTime':shot_time, 'player':player}
        if record:
            self.tracers[str(shotID)] = record
            if len(self.tracers) > 512:
                oldest = min(self.tracers, key=lambda k:self.tracers[k]['receivedAt'])
                del self.tracers[oldest]

    def endpoint(self, player, shotID, endPoint, event, extra=None):
        if not self.active(player): return
        tracer = self.tracers.get(str(shotID))
        if tracer is None: return
        values = {'shotId':str(shotID), 'tracerId':tracer['id'], 'shooterId':tracer['shooterId'],
                  'own':tracer['own'], 'position':vec(endPoint)}
        values['segmentDistance'] = math.sqrt(sum((values['position'][i]-tracer['origin'][i])**2 for i in range(3)))
        if extra: values.update(extra)
        self.emit(player, event, values)

    def stop(self, player, shotID, endPoint):
        self.endpoint(player, shotID, endPoint, 'stop')

    def explosion(self, player, shotID, effectsIndex, prefabEffIndex, effectMaterialIndex,
                  shellTypeIdx, shellCaliber, endPoint, velocityDir, speed, damagedDestructibles):
        self.endpoint(player, shotID, endPoint, 'explosion', {'direction':vec(velocityDir), 'speed':number(speed), 'material':int(effectMaterialIndex)})

    def server_update(self, player, vehicleID, shotPos, shotVec, dispersionAngle):
        # Server message, not a frame: the clock read here is what makes the age of this vector at
        # the next shot measurable on the same gameTime scale as every other record.
        if self.active(player) and vehicleID == player.playerVehicleID:
            self.server_vector = {'vehicleId':int(vehicleID), 'origin':vec(shotPos), 'vector':vec(shotVec),
                                  'dispersionAngle':number(dispersionAngle), 'receivedAt':time.time(),
                                  'gameTime':number(self.recorder.bw.serverTime())}
            # The shell leaves by the server aim of the tick before it (outputs/own-shot-centre-2026-09-24.md), but in
            # 2.7 % of own shots the client did not hold that update yet when the tracer came - the record then holds
            # an aim one tick too old. So the first two updates after each own tracer are kept, in one short record per
            # shot (~0.45 KB): the same dict this update already built, no copy, no hook, nothing per frame.
            pending = self.after_shot
            if pending is not None:
                pending['updates'].append(self.server_vector)
                if len(pending['updates']) >= 2: self.flush_after_shot(player)

    def flush_after_shot(self, player=None):
        """Write the pending after-shot record with whatever updates came. Also called when the avatar leaves the
        battle (death at the end, the battle over): `player` is then the avatar kept with the wait, whose battle file
        is still the current one."""
        pending, self.after_shot = self.after_shot, None
        if player is None and pending: player = pending['player']
        if pending and pending['updates']:
            self.emit(player, 'gunAfterShot', {'tracerId':pending['tracerId'], 'updates':pending['updates']},
                      pending['updates'][-1]['gameTime'])

    def targeting_update(self, player, entityId, *values):
        if self.active(player) and entityId == player.playerVehicleID:
            names = ('turretYaw','gunPitch','maxTurretRotationSpeed','maxGunRotationSpeed','shotDispMultiplierFactor',
                     'turretRotationFactor','movementFactor','rotationFactor','afterShotFactor','aimingTime')
            self.targeting = dict(zip(names, [number(v) for v in values]))
            self.targeting['receivedAt'] = time.time()

    def cache_marker(self, handler, info, supportMarkersInfo, relaxTime, server=False):
        player = self.recorder.bw.player()
        if not self.active(player) or handler is not getattr(player, 'inputHandler', None): return
        value = marker(info)
        if server: self.server_marker = value
        else: self.client_marker = value

    def install(self):
        from Avatar import PlayerAvatar
        from AvatarInputHandler import AvatarInputHandler
        def hook(cls, name, callback):
            def make(original):
                def wrapped(instance, *args, **kwargs):
                    try: callback(instance, *args, **kwargs)
                    except Exception: LOG.debug('Optional shot telemetry unavailable: %s', name, exc_info=True)
                    return original(instance, *args, **kwargs)
                return wrapped
            record = wrap(cls, name, make)
            if record is None: LOG.warning('Optional telemetry hook missing: %s', name)
            else: self.hooks.append(record)
        for name, callback in (('_PlayerAvatar__startWaitingForShot',self.command),('showTracer',self.tracer),
                               ('stopTracer',self.stop),('explodeProjectile',self.explosion),
                               ('updateGunMarker',self.server_update),('updateTargetingInfo',self.targeting_update)):
            hook(PlayerAvatar, name, callback)
        hook(AvatarInputHandler, 'updateClientGunMarker', self.cache_marker)
        def server_marker(handler, *args, **kwargs):
            kwargs['server'] = True
            self.cache_marker(handler, *args, **kwargs)
        hook(AvatarInputHandler, 'updateServerGunMarker', server_marker)

    def close(self):
        unwrap(self.hooks)
        self.hooks = []
