# -*- coding: utf-8 -*-
"""Event-only aim snapshots. Never request extra server data or change aiming."""
from __future__ import absolute_import
import copy
import logging
import math
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
