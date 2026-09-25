# -*- coding: utf-8 -*-
"""The client's critical-damage messages, logged next to the hits (22.09). Event only.

What the client itself receives about damaged modules and injured crew is written as small 'crit' records with
the ids, times and vehicles a later tie needs; nothing is tied here - the exporter does that (crit_tie.py), so a
better rule re-ties every recorded battle on the next start. Like telemetry.py: never ask the server for more,
never change a target or toggle anything; on the game thread only a few attribute reads and name lookups.
Design: outputs/crits-design-2026-09-22.md, section 1 (local agent context).
"""
from __future__ import absolute_import
import logging
import math
import numbers
import re
import time
from .telemetry import recording, wrap, unwrap, matrix_columns

LOG = logging.getLogger('local.armor_inspector')
# Extras the common map may not list (vehicle-specific ones: wheels, a second pair of tracks), typed by name.
DEVICE_NAMES = ('engine', 'ammoBay', 'fuelTank', 'radio', 'gun', 'turretRotator', 'surveyingDevice')
TRACK = re.compile(r'^(left|right)Track\d+$')
WHEEL = re.compile(r'^wheel\d+$')
CREW = re.compile(r'^(radioman|gunner|loader)\d*$')
# BattleFeedbackCommon.BATTLE_EVENT_TYPE.CRIT / RECEIVED_CRIT in NA 2.4.0.1, used when the import fails.
CRIT_EVENTS = (6, 9)
# ATTACK_REASON_INDICES['ramming'] of NA 2.4.0.1, used when the constant is missing (outputs/ram-damage-findings.md 1.1).
RAM_REASON = 2
# Ram contacts (25.09): the client physics reports a touching pair up to five times a second (PlayerAvatar.
# handleVehicleCollidedVehicle, its own 0.2 s pace per pair). The last contact of each pair is kept in memory (at most
# one read per CONTACT_PACE, the client's own pace; only the world point and the two chassis frames - the parts' poses
# are read when a contact is written) and written only near a ram's damage: a contact up to CONTACT_WINDOW before a ram tick of
# the pair, or the first one after it; at most one written per pair per window. A touch without damage writes nothing.
CONTACT_PACE = 0.2
CONTACT_WINDOW = 1.0


def num(value):
    """A finite float or None: the writer refuses NaN, and one odd value must not cost the record."""
    try: value = float(value)
    except (TypeError, ValueError): return None
    return None if math.isnan(value) or math.isinf(value) else value


def vec(value):
    try: return [num(value[i]) for i in range(3)]
    except Exception: return None


def extra_name(descr, index):
    """descr.extras[index].name without 'Health'; None for index 0 (no extra, Avatar.pyc 2199) or out of range."""
    try:
        index = int(index)
        if index <= 0: return None
        extras = getattr(descr, 'extras', None)
        if extras is None: extras = descr.type.extras
        name = str(extras[index].name)
    except Exception: return None
    return name[:-6] if name.endswith('Health') else name


def type_by_name(name):
    if not name: return None
    if TRACK.match(name): return 'track'
    if WHEEL.match(name): return 'wheel'
    crew = CREW.match(name)
    if crew: return crew.group(1)
    if name in ('commander', 'driver') or name in DEVICE_NAMES: return name
    return 'other'


class CritLog(object):
    def __init__(self, recorder):
        self.recorder = recorder
        self.hooks = []
        self.arena = None
        # True while the component's hit-direction or battle-events method runs: the avatar's method it calls is then
        # not logged a second time. The two never nest and run on the game thread, so a plain attribute is enough.
        self.in_component = False
        self.flag_bits = ()
        self.crit_events = CRIT_EVENTS
        self.common = None
        self.mask_parser = None
        self.ram_reason = RAM_REASON
        self.reset()

    def reset(self):
        self.seq = 0
        # Damage-info list positions already logged, per vehicle, and the last fire state per vehicle.
        self.seen = {}
        self.burning = {}
        # Ram contacts per unordered pair of vehicle ids: the last contact, the last ram tick, the last one written.
        self.contacts = {}
        self.rams = {}
        self.written = {}

    def active(self, player):
        # The recorder's one gate (on, an arena, not a replay, not an observer), shared by every recording path.
        if not recording(self.recorder, player): return False
        # Before the client knows its own vehicle a record would stamp 0 into the battle header.
        if not getattr(player, 'playerVehicleID', None): return False
        identity = str(player.arena.arenaUniqueID)
        if identity != self.arena:
            self.reset()
            self.arena = identity
        return True

    def player(self):
        player = self.recorder.bw.player()
        return player if self.active(player) else None

    def emit(self, player, event, values):
        if not self.recorder.ensure_battle(player): return None
        self.seq += 1
        record = {'schema':1, 'type':'crit', 'event':event, 'id':'c'+str(self.seq), 'receivedAt':time.time(),
                  'gameTime':float(self.recorder.bw.serverTime()), 'playerVehicleId':player.playerVehicleID}
        record.update(values)
        self.recorder.writer.put(self.recorder.file, record)
        return record

    # ---- names -----------------------------------------------------------------------------------------------
    def constant(self, table, index):
        try: return str(getattr(self.constants, table)[int(index)])
        except Exception: return None

    def extra_type(self, index, name):
        """The device or crew type of an extra: the client's common map first, then the name."""
        if self.common is None:
            try:
                from items import vehicles
                config = vehicles.g_cache.commonConfig
                self.common = (dict(config['deviceExtraIndexToTypeIndex']), vehicles.VEHICLE_DEVICE_TYPE_NAMES,
                               dict(config['tankmanExtraIndexToTypeIndex']), vehicles.VEHICLE_TANKMAN_TYPE_NAMES)
            except Exception:
                LOG.debug('Crit log: common extra map unavailable; types come from the names', exc_info=True)
                self.common = ({}, (), {}, ())
        devices, device_names, tankmen, tankman_names = self.common
        try:
            if index in devices: return str(device_names[devices[index]])
            if index in tankmen: return str(tankman_names[tankmen[index]])
        except Exception: pass
        return type_by_name(name)

    def extra(self, descr, index):
        name = extra_name(descr, index)
        return name, (self.extra_type(int(index), name) if name else None)

    def descr(self, vehicle_id):
        """The vehicle's descriptor from the arena list, which outlives the view; the entity only as a fallback."""
        try: return self.recorder.bw.player().arena.vehicles[vehicle_id]['vehicleType']
        except Exception: pass
        try: return self.recorder.bw.entity(vehicle_id).typeDescriptor
        except Exception: return None

    def decode_mask(self, mask):
        """CRIT_MASK of a hit-direction call: gui.shared.crits_mask_parser, or the same bit arithmetic."""
        if self.mask_parser is None:
            try:
                from gui.shared.crits_mask_parser import critsParserGenerator
                self.mask_parser = critsParserGenerator
            except Exception: self.mask_parser = False
        result = {'criticalDevices':[], 'destroyedDevices':[], 'destroyedTankmen':[]}
        if self.mask_parser:
            try:
                for sub, name in self.mask_parser(mask): result.setdefault(str(sub), []).append(str(name))
                return result
            except Exception:
                result = {'criticalDevices':[], 'destroyedDevices':[], 'destroyedTankmen':[]}
        from items.vehicles import VEHICLE_DEVICE_TYPE_NAMES, VEHICLE_TANKMAN_TYPE_NAMES
        mask &= ~256   # bit 8 is STUN_PLACEHOLDER
        for sub, bits, names in (('destroyedDevices', mask >> 12 & 4095, VEHICLE_DEVICE_TYPE_NAMES),
                                 ('criticalDevices', mask & 4095, VEHICLE_DEVICE_TYPE_NAMES),
                                 ('destroyedTankmen', mask >> 24 & 255, VEHICLE_TANKMAN_TYPE_NAMES)):
            for i in range(12):
                if bits >> i & 1: result[sub].append(str(names[i]) if i < len(names) else 'unknown%d' % i)
        return result

    # ---- H1/H2: the hit indicator, one call per hit on the own (or watched) vehicle --------------------------
    def direction(self, player, route, hitDirYaw, attackerID, damage, crits, isBlocked, isShellHE, damagedID,
                  attackReasonID, extra=None):
        values = {'route':route, 'vehicleId':int(damagedID), 'attackerId':int(attackerID), 'damage':int(damage),
                  'crits':int(crits), 'critsDecoded':self.decode_mask(int(crits)), 'isBlocked':bool(isBlocked),
                  'isShellHE':bool(isShellHE), 'attackReasonId':int(attackReasonID),
                  'attackReason':self.constant('ATTACK_REASONS', attackReasonID), 'hitDirYaw':num(hitDirYaw)}
        try: values['controllingVehicleId'] = int(player.guiSessionProvider.shared.vehicleState.getControllingVehicleID())
        except Exception: values['controllingVehicleId'] = None
        if extra: values.update(extra)
        self.emit(player, 'hitDirection', values)

    def component_hit(self, comp, data):
        player = self.player()
        if player is None: return
        self.direction(player, 'component', data.hitDirYaw, data.attackerID, data.damage, data.crits, data.isBlocked,
                       data.isShellHE, data.damagedID, data.attackReasonID,
                       {'componentVehicleId':getattr(getattr(comp, 'entity', None), 'id', None)})

    def avatar_hit(self, avatar, hitDirYaw, attackerID, damage, crits, isBlocked, isShellHE, damagedID, attackReasonID):
        if self.in_component: return
        player = self.player()
        if player is None: return
        self.direction(player, 'avatar', hitDirYaw, attackerID, damage, crits, isBlocked, isShellHE, damagedID,
                       attackReasonID)

    # ---- H3: the damage-info list, deduplicated by list position (design 1.4) --------------------------------
    def damage_info(self, comp, damageInfoList):
        if not damageInfoList:
            # The list emptied (a whole set to [], a new component attached to an empty one): count from 0 again.
            if not getattr(comp, 'vehicleDamageInfoList', None):
                self.seen.pop(getattr(getattr(comp, 'entity', None), 'id', None), None)
            return
        player = self.player()
        if player is None: return
        full = getattr(comp, 'vehicleDamageInfoList', None) or []
        vehicle = comp.entity
        key = vehicle.id
        seen = self.seen.get(key, 0)
        if len(full) < seen: seen = 0   # the list shrank (respawn modes): start over
        if getattr(comp, '_OwnVehicleBase__isAttachingToVehicle', False):
            # The whole list again on (re)attaching to a vehicle: history without timing, not a hit.
            self.seen[key] = max(seen, len(full))
            self.emit(player, 'damageInfoReplay', {'vehicleId':key, 'count':len(full)})
            return
        # As long as the whole list: the whole set again, or the first insertion into an empty one - either way at 0,
        # whatever objects the engine hands out. Otherwise an insertion slice, found by the identity of its entries.
        if damageInfoList is full or len(damageInfoList) == len(full): start = 0
        else:
            start = len(full) - len(damageInfoList)
            if not (0 <= start < len(full) and full[start] is damageInfoList[0]):
                start = next((i for i, e in enumerate(full) if e is damageInfoList[0]), None)
        descr = vehicle.typeDescriptor
        for i, entry in enumerate(damageInfoList):
            position = None if start is None else start + i
            if position is not None and position < seen: continue
            name, kind = self.extra(descr, entry.extraIndex)
            self.emit(player, 'damageInfo', {'vehicleId':key, 'position':position, 'attackerId':int(entry.entityID),
                'damageIndex':int(entry.damageIndex), 'damageCode':self.constant('DAMAGE_INFO_CODES', entry.damageIndex),
                'extraIndex':int(entry.extraIndex), 'extra':name, 'extraType':kind,
                'equipmentId':int(getattr(entry, 'equipmentID', 0) or 0),
                'damageExtIndex':int(getattr(entry, 'damageExtIndex', 0) or 0)})
        if start is not None: self.seen[key] = max(seen, start + len(damageInfoList))

    # ---- H4/H5: fire ----------------------------------------------------------------------------------------
    def fire_info(self, fire, *args):
        info = getattr(fire, 'fireInfo', None)
        if info is None: return
        player = self.player()
        if player is None: return
        vehicle = fire.entity
        name, kind = self.extra(vehicle.typeDescriptor, info['deviceExtraIndex'])
        self.emit(player, 'fireInfo', {'vehicleId':vehicle.id, 'attackerId':int(info['attackerID']),
            'deviceExtraIndex':int(info['deviceExtraIndex']), 'device':name, 'deviceType':kind,
            'notificationIndex':int(info['notificationIndex']),
            'notification':self.constant('FIRE_NOTIFICATION_CODES', info['notificationIndex']),
            'equipmentId':int(info['equipmentID'] or 0), 'startTime':num(info['startTime'])})

    def fire_state(self, fire, state):
        player = self.player()
        if player is None: return
        vehicle_id = fire.entity.id
        # Fire.onLeaveWorld calls onDestroy, and the component's own destruction may call it again.
        if self.burning.get(vehicle_id) == state: return
        self.burning[vehicle_id] = state
        self.emit(player, 'fire', {'vehicleId':vehicle_id, 'state':state})

    def fire_appeared(self, fire, *args):
        self.fire_state(fire, 'appeared')

    def fire_removed(self, fire, *args):
        self.fire_state(fire, 'removed')

    # ---- H6-H9: the player's shots, the battle feedback, the target's panel ---------------------------------
    def shot_results(self, avatar, results):
        player = self.player()
        if player is None: return
        rows = []
        for r in results or ():
            flags = int(r.hitFlags)
            rows.append({'vehicleId':int(r.vehicleID), 'hitFlags':flags, 'gunInstallationIndex':int(r.gunInstallationIndex),
                         'flagNames':[name for name, bit in self.flag_bits if flags & bit]})
        if rows: self.emit(player, 'shotResults', {'shooterId':player.playerVehicleID, 'results':rows})

    def battle_events(self, comp, battleEvents, route='component'):
        # The component level: the avatar drops these unless the controlling vehicle is the player's (corr. 8).
        wanted = [e for e in battleEvents or () if e['eventType'] in self.crit_events]
        if not wanted: return
        player = self.player()
        if player is None: return
        rows = []
        for e in wanted:
            details = int(e['details'])
            kind = 'CRIT' if e['eventType'] == self.crit_events[0] else 'RECEIVED_CRIT'
            rows.append({'eventType':int(e['eventType']), 'eventName':kind, 'targetId':int(e['targetID']), 'count':int(e['count']),
                         'details':str(details), 'critsCount':details >> 24 & 0xFFFF, 'attackReasonId':details >> 16 & 255,
                         'shellTypeId':details >> 9 & 127, 'shellIsGold':details >> 8 & 1})
        self.emit(player, 'battleEvents', {'route':route, 'vehicleId':getattr(getattr(comp, 'entity', None), 'id', None),
                                           'events':rows})

    def avatar_battle_events(self, avatar, events):
        # Sent to the avatar directly; the component's method forwards here too and is logged there (as H1/H2).
        if self.in_component: return
        self.battle_events(None, events, 'avatar')

    def damaged_devices(self, avatar, vehicleID, damagedExtras, destroyedExtras):
        player = self.player()
        if player is None: return
        descr = self.descr(vehicleID)
        damaged = [int(i) for i in damagedExtras or ()]
        destroyed = [int(i) for i in destroyedExtras or ()]
        target = self.recorder.bw.target()
        self.emit(player, 'damagedDevices', {'vehicleId':int(vehicleID), 'damagedIdx':damaged, 'destroyedIdx':destroyed,
            'damaged':[extra_name(descr, i) for i in damaged], 'destroyed':[extra_name(descr, i) for i in destroyed],
            'damagedTypes':[self.extra(descr, i)[1] for i in damaged], 'destroyedTypes':[self.extra(descr, i)[1] for i in destroyed],
            'isTarget':target is not None and getattr(target, 'id', None) == vehicleID})

    def devices_visible(self, avatar, vehicleID, status):
        player = self.player()
        if player is None: return
        self.emit(player, 'damagedDevicesVisible', {'vehicleId':int(vehicleID), 'status':int(status)})

    # ---- H10-H14: any vehicle in view -----------------------------------------------------------------------
    def public_state(self, vehicle, *args):
        if not getattr(vehicle, 'isStarted', False): return   # the original does nothing then either
        player = self.player()
        if player is None: return
        previous = frozenset(getattr(vehicle, '_Vehicle__prevPublicStateModifiers', None) or ())
        current = frozenset(vehicle.publicStateModifiers or ())
        added, removed = sorted(current - previous), sorted(previous - current)
        if not added and not removed: return
        descr = self.descr(vehicle.id)
        self.emit(player, 'publicState', {'vehicleId':vehicle.id, 'addedIdx':[int(i) for i in added],
            'removedIdx':[int(i) for i in removed], 'added':[extra_name(descr, i) for i in added],
            'removed':[extra_name(descr, i) for i in removed], 'addedTypes':[self.extra(descr, i)[1] for i in added]})

    def extra_hit(self, vehicle, extraIndex, hitPoint):
        player = self.player()
        if player is None: return
        name, kind = self.extra(self.descr(vehicle.id), extraIndex)
        # The point's frame is not established (it feeds addCrashedTrack): stored as received.
        self.emit(player, 'extraHit', {'vehicleId':vehicle.id, 'extraIndex':int(extraIndex), 'extra':name,
                                       'extraType':kind, 'point':vec(hitPoint)})

    def health(self, vehicle, newHealth, oldHealth, attackerID, attackReasonID, attackReasonExtID=0):
        # Index 0 of ATTACK_REASONS is SHOT: the hits already carry that damage. Only the shot that destroys the
        # vehicle is written (25.09): its HP after, 0 or below, closes the page's damage check of that vehicle.
        if not attackReasonID and int(newHealth) > 0: return
        player = self.player()
        if player is None: return
        self.emit(player, 'health', {'vehicleId':vehicle.id, 'newHealth':int(newHealth), 'oldHealth':int(oldHealth),
            'attackerId':int(attackerID), 'attackReasonId':int(attackReasonID),
            'attackReason':self.constant('ATTACK_REASONS', attackReasonID), 'attackReasonExtId':int(attackReasonExtID or 0)})
        if int(attackReasonID) == self.ram_reason and attackerID and attackerID != vehicle.id:
            pair = frozenset((vehicle.id, int(attackerID)))
            now = float(self.recorder.bw.serverTime())
            self.rams[pair] = now
            contact = self.contacts.get(pair)
            if contact is not None and now - contact['at'] <= CONTACT_WINDOW: self.write_contact(player, pair, contact, now)

    # ---- ram contacts (25.09): where two vehicles touched, for the page's ram tile -------------------------------
    def contact_side(self, vehicle, point):
        """One vehicle at a contact, as cheaply as it can be kept: copies of its chassis frame (collision part 0, the
        frame of a hit's points and parts) and of its parts' matrices, its turret and gun, and its speed toward the
        point. Turned into numbers (side_record) only when the contact is written - most touches never are."""
        side = {'vehicleId':vehicle.id}
        try:
            import Math
            from .exporter import static_parts
            collisions = vehicle.appearance.collisions
            side['frames'] = [(idx, Math.Matrix(collisions.getPartTransform(idx)))
                              for idx, _, _ in static_parts(vehicle.typeDescriptor)]
            side['aim'] = [num(a) for a in vehicle.getAimParams()]
        except Exception:
            LOG.debug('Ram contact frame unavailable', exc_info=True)
        try:
            velocity, position = vehicle.filter.velocity, vehicle.position
            toward = [float(point[i]) - float(position[i]) for i in range(3)]
            length = math.sqrt(sum(x * x for x in toward))
            if length > 1e-6: side['approach'] = num(sum(float(velocity[i]) * toward[i] for i in range(3)) / length)
        except Exception: pass
        return side

    def side_record(self, side, point):
        """The written side: the point in the chassis frame and every part's pose in that frame (telemetry.matrix_columns,
        the writer of a hit's part poses)."""
        out = dict((k, v) for k, v in side.items() if k != 'frames')
        frames = side.get('frames') or []
        try:
            import Math
            root = Math.Matrix(frames[0][1])
            root.invertOrthonormal()
            out['local'] = vec(root.applyPoint(Math.Vector3(point[0], point[1], point[2])))   # the API takes a Vector3
            out['parts'] = [{'id':idx, 'transform':matrix_columns(matrix, root)} for idx, matrix in frames]
        except Exception:
            LOG.debug('Ram contact frame unavailable', exc_info=True)
        return out

    def collided(self, avatar, vehA, vehB, hitPt, *args):
        player = self.player()
        if player is None: return
        pair = frozenset((vehA.id, vehB.id))
        now = float(self.recorder.bw.serverTime())
        last = self.contacts.get(pair)
        if last is not None and 0 <= now - last['at'] < CONTACT_PACE: return
        contact = {'at':now, 'point':vec(hitPt), 'source':'client physics',
                   'sides':[self.contact_side(vehA, hitPt), self.contact_side(vehB, hitPt)]}
        try: contact['closingSpeed'] = num((vehA.filter.velocity - vehB.filter.velocity).length)
        except Exception: pass
        self.contacts[pair] = contact
        ram = self.rams.get(pair)
        if ram is not None and 0 <= now - ram <= CONTACT_WINDOW: self.write_contact(player, pair, contact, now)

    def write_contact(self, player, pair, contact, now):
        if contact.get('written') or now - self.written.get(pair, -1e9) <= CONTACT_WINDOW: return
        contact['written'] = True
        self.written[pair] = now
        values = dict((k, v) for k, v in contact.items() if k not in ('written', 'sides'))
        values['sides'] = [self.side_record(side, contact['point']) for side in contact['sides']]
        values['pair'] = sorted(pair)
        self.emit(player, 'collision', values)

    def ammo_bay(self, vehicle, mode, fireballVolume, *args):
        player = self.player()
        if player is None: return
        try: burn = mode == self.constants.AMMOBAY_DESTRUCTION_MODE.POWDER_BURN_OFF
        except Exception: burn = None
        self.emit(player, 'ammoBay', {'vehicleId':vehicle.id, 'mode':int(mode),
            'modeName':None if burn is None else 'burnOff' if burn else 'explosion', 'fireballVolume':num(fireballVolume)})

    def explosion(self, vehicle, attackerID, center, effectsIndex, damage, damageFactor, gunInstallationIndex):
        # HE splash (corr. 6): evidence only, so a splash crit ties to something and is counted.
        player = self.player()
        if player is None: return
        self.emit(player, 'explosion', {'vehicleId':vehicle.id, 'attackerId':int(attackerID), 'center':vec(center),
            'effectsIndex':int(effectsIndex), 'damage':int(damage), 'damageFactor':num(damageFactor),
            'gunInstallationIndex':int(gunInstallationIndex)})

    # ---- installation ----------------------------------------------------------------------------------------
    def install(self):
        import constants
        self.constants = constants
        flags = getattr(constants, 'VEHICLE_HIT_FLAGS', None)
        # Names, not bit values that could move in a client update: the exporter keys on them. Single bits only.
        self.flag_bits = tuple(sorted(((str(name), int(value)) for name, value in vars(flags).items()
                                       if not name.startswith('_') and isinstance(value, numbers.Integral) and not isinstance(value, bool)
                                       and value > 0 and value & (value - 1) == 0), key=lambda item: item[1])) if flags else ()
        try: self.ram_reason = int(constants.ATTACK_REASON_INDICES['ramming'])
        except Exception: LOG.debug('Crit log: ramming index of NA 2.4.0.1', exc_info=True)
        try:
            from BattleFeedbackCommon import BATTLE_EVENT_TYPE
            self.crit_events = (int(BATTLE_EVENT_TYPE.CRIT), int(BATTLE_EVENT_TYPE.RECEIVED_CRIT))
        except Exception: LOG.debug('Crit log: battle event types from the constants of NA 2.4.0.1', exc_info=True)
        def load(module, name):
            try: return getattr(__import__(module, fromlist=[name]), name)
            except Exception:
                LOG.warning('Optional crit hook class missing: %s.%s', module, name)
                return None
        def hook(cls, name, callback, mode='before'):
            def make(original):
                def wrapped(instance, *args, **kwargs):
                    if mode == 'after':
                        result = original(instance, *args, **kwargs)
                        try: callback(instance, *args, **kwargs)
                        except Exception: LOG.debug('Optional crit record unavailable: %s', name, exc_info=True)
                        return result
                    # Before the original (corr. 1): its early returns cannot hide an event.
                    try: callback(instance, *args, **kwargs)
                    except Exception: LOG.debug('Optional crit record unavailable: %s', name, exc_info=True)
                    if mode != 'around': return original(instance, *args, **kwargs)
                    self.in_component = True
                    try: return original(instance, *args, **kwargs)
                    finally: self.in_component = False
                return wrapped
            # The recorder's one wrapper (telemetry.wrap): put back by the class dictionary, None when inherited.
            record = wrap(cls, name, make) if cls is not None else None
            if record is None: LOG.warning('Optional crit hook missing: %s', name)
            else: self.hooks.append(record)
        avatar = load('Avatar', 'PlayerAvatar')
        vehicle = load('Vehicle', 'Vehicle')
        component = load('OwnVehicleBase', 'OwnVehicleBase')
        fire = load('Fire', 'Fire')
        hook(component, 'showOwnVehicleHitDirection', self.component_hit, 'around')
        hook(avatar, 'showOwnVehicleHitDirection', self.avatar_hit)
        # Patched on the class: OwnVehicleBase.__getattr__ builds set_<prop> from getattr(self, 'update_'+prop).
        hook(component, 'update_vehicleDamageInfoList', self.damage_info)
        hook(component, 'onBattleEvents', self.battle_events, 'around')
        hook(avatar, 'onBattleEvents', self.avatar_battle_events)
        hook(fire, 'set_fireInfo', self.fire_info)
        hook(fire, '__init__', self.fire_appeared, 'after')   # the entity is set by the original
        hook(fire, 'onDestroy', self.fire_removed)
        # The client binds this method once per vehicle (CompoundAppearance.__linkCompound: filter.vehicleCollisionCallback
        # = player.handleVehicleCollidedVehicle), after this class-level wrapper is in place.
        for name, callback in (('showShotResults', self.shot_results), ('showOtherVehicleDamagedDevices', self.damaged_devices),
                               ('updateIsOtherVehicleDamagedDevicesVisible', self.devices_visible),
                               ('handleVehicleCollidedVehicle', self.collided)):
            hook(avatar, name, callback)
        for name, callback in (('set_publicStateModifiers', self.public_state), ('onExtraHitted', self.extra_hit),
                               ('onHealthChanged', self.health), ('showAmmoBayEffect', self.ammo_bay),
                               ('showDamageFromExplosion', self.explosion)):
            hook(vehicle, name, callback)

    def close(self):
        unwrap(self.hooks)
        self.hooks = []
