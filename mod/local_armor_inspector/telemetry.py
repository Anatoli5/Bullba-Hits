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
# in its component def and the server replicates it to the player's own vehicle alone; it is read for the
# player's own shot and skipped for everybody else, so a default value is never recorded as if it were a
# state. The keys are the mechanic names of VehicleType.mechanicsParams - the same set as AIM_GUN_MECHANICS
# in exporter.py - so only the twelve vehicles of this client that carry one of them cost anything at all.
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
    # No vehicle of client 2.4.0.1 carries this one, and the client's own lookup table names the component
    # 'ShellCalibrationController' while its def declares DefaultKeyName 'shellCalibrationController'. The
    # def is what the entity is keyed by, so that is the name used here.
    'shellCalibration': (
        ('shellCalibrationController', 'status', 'status', None, True),),
    'secondaryGun': (
        ('secondaryGunComponent', 'gunInstallationIndex', 'gunInstallationIndex', None, False),),
}


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


def mechanic_state(entity, own):
    """The state of the shooter's gun mechanics at this instant, {mechanic: {property: value}}.

    One dictionary lookup per mechanic the vehicle really has and a few attribute reads; empty - and
    therefore left out of the record - for every vehicle without one, which is all but twelve. Never
    raises: a component that is not attached, a property the server has not sent and an entity outside
    the area of interest all simply leave their field out.
    """
    result = {}
    components = getattr(entity, 'dynamicComponents', None)
    if not components: return result
    try:
        params = getattr(entity.typeDescriptor.type, 'mechanicsParams', None) or {}
    except Exception:
        return result
    for name in params:
        entries = GUN_MECHANIC_STATE.get(str(name))
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

    def active(self, player):
        import BattleReplay
        arena = getattr(player, 'arena', None)
        if not self.recorder.enabled or arena is None or BattleReplay.g_replayCtrl.isPlaying: return False
        if getattr(player, 'isObserver', lambda: False)(): return False
        identity = str(arena.arenaUniqueID)
        if identity != self.arena:
            self.reset()
            self.arena = identity
        return True

    def emit(self, player, event, values):
        if not self.active(player): return None
        if not self.recorder.ensure_battle(player): return None
        self.sequence += 1
        record = {'schema':1, 'type':'shot', 'event':event, 'id':'s'+str(self.sequence),
                  'receivedAt':time.time(), 'gameTime':number(self.recorder.bw.serverTime())}
        record.update(values)
        self.recorder.writer.put(self.recorder.file, record)
        return record

    def snapshot(self, player):
        result = {'source':'client snapshot before waiting for shot confirmation', 'unavailable':[]}
        def get(name, action):
            try: result[name] = action()
            except Exception: result['unavailable'].append(name)
        rotator = getattr(player, 'gunRotator', None)
        get('dispersionAngles', lambda: [number(v) for v in rotator.getCurShotDispersionAngles()])
        get('gunOrigin', lambda: vec(rotator.getCurShotPosition()[0]))
        get('gunVelocity', lambda: vec(rotator.getCurShotPosition()[1]))
        get('desiredPoint', lambda: vec(player.inputHandler.getDesiredShotPoint(getattr(rotator, 'ignoreAimingMode', False))))
        get('turretYaw', lambda: number(rotator.turretYaw))
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
        record = self.emit(player, 'tracer', values)
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
        if self.active(player) and vehicleID == player.playerVehicleID:
            self.server_vector = {'vehicleId':int(vehicleID), 'origin':vec(shotPos), 'vector':vec(shotVec),
                                  'dispersionAngle':number(dispersionAngle), 'receivedAt':time.time()}

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
            original = getattr(cls, name, None)
            if original is None:
                LOG.warning('Optional telemetry hook missing: %s', name)
                return
            def wrapped(instance, *args, **kwargs):
                try: callback(instance, *args, **kwargs)
                except Exception: LOG.debug('Optional shot telemetry unavailable: %s', name, exc_info=True)
                return original(instance, *args, **kwargs)
            setattr(cls, name, wrapped)
            self.hooks.append((cls, name, original, wrapped))
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
        for cls, name, original, wrapper in reversed(self.hooks):
            if getattr(cls, name) is wrapper: setattr(cls, name, original)
        self.hooks = []
