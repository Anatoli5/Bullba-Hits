# -*- coding: utf-8 -*-
"""A battle's records in the recorder's own schema, made from a .wotreplay instead of the live hooks (10.11.2026).

The live recorder loses every vehicle event while the client withholds the vehicles (the death camera, ~15 s after the
player's death: outputs/hits-failures-diagnosis-2026-11-02.md section 1); the replay of the same battle keeps them. This
module turns the replay decoder's events (replay_stream.Decoder.decode, in stream order) into the raw records the
recorder writes - 'battle', 'roster', 'crit', 'shot', 'hit' (docs/KNOWLEDGE.md section 11) - so that whatever reads raw
records (Exporter.apply_record, crit_tie.attach_crits, damage_log.damage_log) takes a replay-made battle unchanged.
Not wired into the recorder or the exporter yet: the run-time step decides when and where it runs.

Rules of the conversion:
- The header says source 'replay'. Every event carries gameTime = the server time at the recording start (packet
  0x15) + the packet clock; there is no receivedAt (no wall clock in a replay: damage_log treats a battle read this way
  as finished, now=None).
- A field the live record has and the replay cannot give is left out, never zeroed or guessed. Names the live recorder
  reads from the running client (extra and device names, hit flag names, constant names, the crit mask decoded) come
  from a Names object the caller passes; the default one knows none, and those fields are then absent.
- A hit carries what Vehicle.showDamageFromShot itself carries (attacker, target, damage, raw points and what their
  encoding says - part, effect, hit type, shell type, calibre - effects, shell velocity, gun index). What the client
  computes at the moment of the hit (part poses, live armour, the resolved point, the aim block, gun state, shell
  candidates) is not in the replay in that form: such a hit has no 'target'/'attacker' blocks, its points have status
  'replay-raw', and 'replayAbsent' names the missing fields (KNOWLEDGE section 18).
- Each event kind follows the live recorder's own rule of when to write (crit_log.py, telemetry.py): a health change
  only when it is not a shot or it destroys the vehicle; a shot end only for a tracer seen; a fire state only when it
  changes; a damage-info entry once per list position.

Runs under the client's Python 2.7 and CPython 3; imports nothing of the game (ClientNames does, when it is built: in
the game, or on the offline stand of tests/py27/replay_battle.py). Measured against the live records of the
same battles: outputs/replay-records-parity-2026-11-10.md.
"""
from __future__ import absolute_import
import copy
import math
import time

from .crit_log import CRIT_EVENTS, RAM_REASON, CONTACT_PACE, CONTACT_WINDOW, num, vec
from . import replay_stream

SOURCE = 'replay'
# Version of this conversion, written in the header: a later, better conversion of the same replay is told apart.
FORMAT = 1
# The hit fields a replay-made hit does not have (the client computes them at the moment of the hit).
HIT_ABSENT = ('target', 'attacker', 'aim', 'points.resolved', 'shellCandidates', 'availableShells', 'shellStatus',
              'traceCandidates', 'rangeAtImpact', 'attackerPositionAtImpact')
HIT_WARNING = 'Replay hit: part poses, armour, the resolved point, aim and gun state were not recorded'
ROSTER_FIELDS = ('name', 'fakeName', 'team', 'compDescr', 'maxHealth', 'vehPostProgression', 'customRoleSlotTypeId',
                 'avatarSessionID')


class Names(object):
    """What the live recorder reads from the running client to name indexes. This one knows nothing (offline): every
    field it would fill is left out. A run-time subclass answers from the client's constants and the vehicles'
    descriptors (compDescr of AvatarVehiclesInfo)."""

    crit_events = CRIT_EVENTS
    ram_reason = RAM_REASON

    def constant(self, table, index):
        """constants.<table>[index] as text (ATTACK_REASONS, DAMAGE_INFO_CODES, FIRE_NOTIFICATION_CODES), or None."""
        return None

    def extra(self, vehicle_id, index):
        """(extra name without 'Health', device or crew type) of the vehicle's extra, or (None, None)."""
        return None, None

    def hit_flags(self, flags):
        """The VEHICLE_HIT_FLAGS names set in flags, or None."""
        return None

    def crit_mask(self, mask):
        """The crit mask of a hit direction decoded as crit_log.decode_mask does, or None."""
        return None

    def ammo_bay_mode(self, mode):
        """'burnOff' or 'explosion', or None."""
        return None

    def short_name(self, type_name):
        """The vehicle type's short user name (roster 'name'), or None."""
        return None

    def vehicle(self, vehicle_id, compact):
        """The converter names each roster vehicle's compact descriptor (vehiclesInfo / publicInfo compDescr) before it
        asks for that vehicle's extras: a run-time Names builds its descriptor here. This one keeps nothing."""


class ClientNames(Names):
    """The names from the running client (or the offline stand of its modules), read exactly as the live recorder reads
    them: crit_log.CritLog's own methods for constants, extras and the crit mask, its rule for the hit-flag names, the
    ram reason and the crit event types (CritLog.install), the ammo-bay mode (CritLog.ammo_bay). The live recorder takes
    a vehicle's descriptor from the arena list; a replay has its compact descriptor, from which the client's own
    VehicleDescr is built once per vehicle (the extras are the type's: the same list). Imports the game's modules, so
    it is built only inside the game or on the stand; a name the client cannot give stays None (the field is left out)."""

    def __init__(self):
        import numbers
        import constants
        from .crit_log import CritLog
        self.log = CritLog(None)
        self.log.constants = constants
        self.constants = constants
        flags = getattr(constants, 'VEHICLE_HIT_FLAGS', None)
        # CritLog.install's rule: names of the single-bit flags, by value.
        self.flag_bits = tuple(sorted(((str(name), int(value)) for name, value in vars(flags).items()
                                       if not name.startswith('_') and isinstance(value, numbers.Integral) and not isinstance(value, bool)
                                       and value > 0 and value & (value - 1) == 0), key=lambda item: item[1])) if flags else ()
        try: self.ram_reason = int(constants.ATTACK_REASON_INDICES['ramming'])
        except Exception: self.ram_reason = RAM_REASON
        try:
            from BattleFeedbackCommon import BATTLE_EVENT_TYPE
            self.crit_events = (int(BATTLE_EVENT_TYPE.CRIT), int(BATTLE_EVENT_TYPE.RECEIVED_CRIT))
        except Exception: self.crit_events = CRIT_EVENTS
        self.descrs = {}    # vehicle id -> (compact descriptor, VehicleDescr or None)
        self.short = {}     # type name -> short user name

    def vehicle(self, vehicle_id, compact):
        if not compact: return
        compact = bytes(compact)
        known = self.descrs.get(vehicle_id)
        if known is not None and known[0] == compact: return
        try:
            from items import vehicles
            descr = vehicles.VehicleDescr(compactDescr=compact)
            self.short[str(descr.type.name)] = descr.type.shortUserString
        except Exception: descr = None
        self.descrs[vehicle_id] = (compact, descr)

    def constant(self, table, index):
        return self.log.constant(table, index)

    def extra(self, vehicle_id, index):
        descr = (self.descrs.get(vehicle_id) or (None, None))[1]
        if descr is None or index is None: return None, None
        try: return self.log.extra(descr, index)
        except Exception: return None, None

    def hit_flags(self, flags):
        return [name for name, bit in self.flag_bits if flags & bit]

    def crit_mask(self, mask):
        try: return self.log.decode_mask(mask)
        except Exception: return None

    def ammo_bay_mode(self, mode):
        try: burn = mode == self.constants.AMMOBAY_DESTRUCTION_MODE.POWDER_BURN_OFF
        except Exception: return None
        return 'burnOff' if burn else 'explosion'

    def short_name(self, type_name):
        return self.short.get(type_name)


def text(value):
    if isinstance(value, (bytes, bytearray)):
        try: return bytes(value).decode('utf-8')
        except UnicodeDecodeError: return bytes(value).decode('latin-1')
    return value


def integer(value):
    try: return int(value)
    except (TypeError, ValueError): return None


def apply_update(current, ev):
    """The property value after one decoded update: a whole value, a slice of an array or one element/field."""
    path = ev.get('path')
    if not path:
        return copy.deepcopy(ev.get('value'))
    root = current
    if root is None: return None
    keys = list(path[1:])
    holder = root
    if 'slice' in ev:
        for k in keys: holder = holder[k]
        a, z = ev['slice']
        holder[a:z] = copy.deepcopy(ev.get('value') or [])
        return root
    if not keys: return copy.deepcopy(ev.get('value'))
    for k in keys[:-1]: holder = holder[k]
    holder[keys[-1]] = copy.deepcopy(ev.get('value'))
    return root


def method_args(ev):
    """A component method's arguments: the decoder names a single struct argument arg0."""
    args = ev.get('args') or {}
    if len(args) == 1:
        only = list(args.values())[0]
        if isinstance(only, dict): return only
    return args


class Converter(object):
    """One battle. feed() each decoder event in stream order, collect the records it returns; finish() at the end."""

    def __init__(self, session='replay', header=None, client_version=None, recorder_version=None, names=None,
                 vehicle_names=None, poses=False):
        self.session = session
        # poses=True (11.11, the rebuilt scene): every vehicle's position packets, packed gun angles, the own turret
        # floats and compact descriptors are kept (replay_scene.Tracks) and finish() adds ONE in-memory record of type
        # 'poses' after the others - what replay_scene rebuilds each hit's pose from. Not a recorder record (its arrays
        # are not JSON); without it the records are exactly as before.
        self.tracks = None
        if poses:
            from .replay_scene import Tracks
            self.tracks = Tracks()
        self.header = header or {}
        self.client_version = client_version
        self.recorder_version = recorder_version
        self.names = names or Names()
        self.vehicle_names = vehicle_names or {}
        self.arena = None
        self.player = None       # own vehicle id
        self.controlling = None  # the vehicle the client controls now (packet 0x22)
        self.own_seen = False
        self.server_start = None
        self.extra_data = None
        self.base = {}           # player_base properties
        self.started = False
        self.held = []           # events before the header could be written
        self.out = []
        self.seq = {'hit':0, 'shot':0, 'crit':0}
        self.stats = {'events':0, 'records':{}, 'skipped':{}}
        # state per vehicle / component
        self.info = None         # AvatarVehiclesInfo.vehiclesInfo (own copy)
        self.public = {}         # vehicle id -> publicInfo of the entity (older replays, Onslaught)
        self.roster_last = None
        self.modifiers = {}      # vehicle id -> publicStateModifiers
        self.fires = {}          # Fire component id -> vehicle id
        self.burning = {}        # vehicle id -> last fire state written
        self.damage_lists = {}   # OwnVehicle owner -> vehicleDamageInfoList
        self.seen = {}           # owner -> damage-info positions written
        self.tracers = {}        # shot id -> tracer record
        self.contact = None      # last own contact {'at', 'point', 'energy'}
        self.rams = {}           # pair -> last ram tick time
        self.written = {}        # pair -> last contact written

    # ---- output ---------------------------------------------------------------------------------------------
    def count(self, key, field='records'):
        self.stats[field][key] = self.stats[field].get(key, 0) + 1

    def game_time(self, t):
        return None if self.server_start is None else float(self.server_start) + float(t)

    def put(self, record):
        self.out.append(record)
        self.count(record['type'] if record['type'] in ('battle', 'roster', 'hit') else record['type'] + ':' + record['event'])

    def event(self, kind, event, t, values):
        self.seq[kind] += 1
        record = {'schema':1, 'type':kind, 'event':event, 'id':('c' if kind == 'crit' else 's') + str(self.seq[kind])}
        when = self.game_time(t)
        if when is not None: record['gameTime'] = when
        if kind == 'crit' and self.player is not None: record['playerVehicleId'] = self.player
        record.update(values)
        self.put(record)
        return record

    # ---- header -----------------------------------------------------------------------------------------------
    def ready(self):
        return self.arena is not None and self.player is not None and self.server_start is not None

    def write_header(self):
        if self.arena is None:
            raise ValueError('The replay names no arena (no player_base packet)')
        self.started = True
        h = self.header
        battle = {'schema':1, 'type':'battle', 'id':str(self.arena) + '-' + str(self.session), 'source':SOURCE,
                  'replayRecordsFormat':FORMAT, 'arenaId':str(self.arena),
                  'map':text(h.get('mapDisplayName')) or 'Unknown map', 'mode':self.mode()}
        if self.player is not None: battle['playerVehicleId'] = self.player
        if self.server_start is not None: battle['replayServerTimeAtStart'] = self.server_start
        if self.client_version is not None: battle['clientVersion'] = self.client_version
        if h.get('clientVersionFromXml'): battle['replayClientVersion'] = text(h['clientVersionFromXml'])
        if self.recorder_version is not None: battle['recorderVersion'] = self.recorder_version
        started = self.started_at()
        if started is not None: battle['startedAt'] = started
        self.put(battle)

    def started_at(self):
        """The header's local date and time of the recording start, as the epoch of this computer's time zone."""
        stamp = self.header.get('dateTime')
        if not stamp: return None
        try: return float(time.mktime(time.strptime(str(stamp), '%d.%m.%Y %H:%M:%S')))
        except (ValueError, OverflowError): return None

    def mode(self):
        """The battle_mode block the replay can give: ids from player_base, names of the map from the header; the
        constant names (bonus type, gui type, label) need the running client and are listed as unavailable."""
        mode, missing = {'read':True}, ['bonusTypeName', 'guiTypeName', 'guiLabel']
        for key, name in (('bonusType', 'arenaBonusType'), ('guiType', 'arenaGuiType'), ('arenaTypeId', 'arenaTypeID')):
            value = integer(self.base.get(name))
            if value is not None: mode[key] = value
            else: missing.append(key)
        for key, name in (('gameplayName', 'gameplayID'), ('geometryName', 'mapName')):
            if self.header.get(name): mode[key] = text(self.header[name])
            else: missing.append(key)
        extra = replay_stream.safe_unpickle(self.base.get('arenaExtraData'))
        if isinstance(extra, dict):
            extra = dict((text(k), v) for k, v in extra.items())
            for key in ('queueType', 'battleLevel'):
                value = extra.get(key)
                if isinstance(value, int) and not isinstance(value, bool): mode[key] = value
        else: missing.extend(('queueType', 'battleLevel'))
        missing.append('battleModifiersDescr')
        mode['unavailable'] = missing
        return mode

    # ---- roster -----------------------------------------------------------------------------------------------
    def type_name(self, descr):
        if not descr: return None
        try: nation, tid, _ = replay_stream.parse_vehicle_compact_descr(descr)
        except Exception: return None
        return self.vehicle_names.get((nation, tid))

    def row(self, vehicle_id, info, source):
        row = {'id':vehicle_id, 'player':text(info.get('name')), 'team':info.get('team')}
        self.names.vehicle(vehicle_id, info.get('compDescr'))
        type_name = self.type_name(info.get('compDescr'))
        if type_name:
            row['type'] = type_name
            short = self.names.short_name(type_name)
            if short: row['name'] = short
        if integer(info.get('maxHealth')):
            row['maxHealth'] = int(info['maxHealth'])
            row['maxHealthFrom'] = source
        if 'vehPostProgression' in info: row['vehPostProgression'] = list(info.get('vehPostProgression') or [])
        if integer(info.get('customRoleSlotTypeId')) is not None: row['customRoleSlotTypeId'] = int(info['customRoleSlotTypeId'])
        if 'avatarSessionID' in info: row['isBot'] = not info.get('avatarSessionID')
        return row

    def roster(self):
        rows, known = [], set()
        for info in self.info or ():
            if not isinstance(info, dict) or integer(info.get('vehicleID')) is None: continue
            vid = int(info['vehicleID'])
            known.add(vid)
            rows.append(self.row(vid, info, 'vehiclesInfo'))
        # Replays without the vehicles-info component (older clients): the vehicles' own publicInfo, as far as seen.
        for vid in sorted(self.public):
            if vid not in known: rows.append(self.row(vid, self.public[vid], 'vehicle'))
        if not rows or not self.started: return
        team = next((r.get('team') for r in rows if r['id'] == self.player), None)
        if (team, rows) == self.roster_last: return
        self.roster_last = (team, rows)
        self.put({'schema':1, 'type':'roster', 'playerVehicleId':self.player, 'playerTeam':team,
                  'vehicles':copy.deepcopy(rows)})

    # ---- the events -------------------------------------------------------------------------------------------
    def feed(self, ev):
        self.stats['events'] += 1
        kind = ev.get('ev')
        if kind == 'player_base':
            props = ev.get('props') or {}
            self.base = props
            self.arena = integer(props.get('arenaUniqueID'))
            if self.player is None: self.player = integer(text(props.get('sessionID')))
        elif kind == 'own_vehicle':
            # 0x22 names the vehicle the client controls; after the player's death it follows the ally he watches
            # (MEASURED 20.10: 9117107 -> 9117106 -> 9117107). The player's vehicle is the first one, as live
            # (playerVehicleID never changes in a battle); the current one is kept for hitDirection.
            self.controlling = integer(ev.get('vehicleId'))
            if self.player is None or not self.own_seen: self.player = self.controlling
            self.own_seen = True
        elif kind == 'server_time_at_start':
            self.server_start = ev.get('serverTime')
        if not self.started:
            self.held.append(ev)
            if self.ready() or (ev.get('t') or 0) > 0:
                held, self.held = self.held, []
                self.write_header()
                for e in held: self.handle(e)
            return self.drain()
        self.handle(ev)
        return self.drain()

    def drain(self):
        out, self.out = self.out, []
        return out

    def finish(self):
        if not self.started and (self.held or self.arena is not None):
            held, self.held = self.held, []
            self.write_header()
            for e in held: self.handle(e)
        if self.tracks is not None:
            self.out.append(self.tracks.record(self.player, self.server_start, self.info))
        return self.drain()

    def track(self, kind, ev, t):
        """The pose inputs of replay_scene (poses=True): what extract_replay.py of the 11.11 measurement took."""
        tracks = self.tracks
        if kind == 'position':
            if not ev.get('vehicleId'):   # an Avatar riding a vehicle has its vehicle id here; a vehicle has 0
                tracks.position(ev.get('id'), t, ev['pos'], ev['yaw'], ev['pitch'], ev['roll'])
        elif kind == 'turret_yaw': tracks.own_angle('yaw', t, ev['value'])
        elif kind == 'gun_pitch': tracks.own_angle('pitch', t, ev['value'])
        elif ev.get('entity') == 'Vehicle':
            if kind == 'entity_create':
                props = ev.get('props') or {}
                if 'gunAnglesPacked' in props: tracks.gun(ev['id'], t, props['gunAnglesPacked'])
                if isinstance(props.get('publicInfo'), dict): tracks.public(ev['id'], props['publicInfo'].get('compDescr'))
            elif kind == 'property':
                if ev.get('name') == 'gunAnglesPacked': tracks.gun(ev['id'], t, ev.get('value'))
                elif ev.get('name') == 'publicInfo' and isinstance(ev.get('value'), dict):
                    tracks.public(ev['id'], ev['value'].get('compDescr'))

    def handle(self, ev):
        kind, t = ev.get('ev'), ev.get('t') or 0.0
        name = ev.get('name')
        if self.tracks is not None and kind in ('position', 'turret_yaw', 'gun_pitch', 'entity_create', 'property'):
            try: self.track(kind, ev, t)
            except (KeyError, TypeError, ValueError): self.count('pose ' + kind, 'skipped')
        if kind == 'method':
            entity = ev.get('entity')
            args = ev.get('args') or {}
            if entity == 'Vehicle': self.vehicle_method(ev.get('id'), name, args, t)
            elif entity == 'Avatar': self.avatar_method(name, args, t)
        elif kind == 'component':
            self.component(ev, t)
        elif kind == 'component_property':
            self.component_property(ev, t)
        elif kind == 'component_method':
            self.component_method(ev, t)
        elif kind == 'component_removed':
            if ev.get('component') == 'Fire': self.fire(self.fires.pop(ev.get('cid'), ev.get('owner')), 'removed', t)
        elif kind in ('entity_create', 'entity_properties') and ev.get('entity') == 'Vehicle':
            props = ev.get('props') or {}
            if 'publicStateModifiers' in props:
                self.modifiers[ev['id']] = list(props['publicStateModifiers'] or ())
            if isinstance(props.get('publicInfo'), dict): self.public_info(ev['id'], props['publicInfo'])
        elif kind in ('property', 'nested_property') and ev.get('entity') == 'Vehicle':
            if name == 'publicStateModifiers': self.public_state(ev, t)
            elif name == 'publicInfo' and kind == 'property' and isinstance(ev.get('value'), dict):
                self.public_info(ev['id'], ev['value'])
        elif kind == 'entity_leave':
            # Fire.onLeaveWorld calls onDestroy: the live recorder logs the fire as removed when its vehicle leaves.
            vid = ev.get('id')
            for cid, owner in list(self.fires.items()):
                if owner == vid:
                    del self.fires[cid]
                    self.fire(vid, 'removed', t)

    def public_info(self, vehicle_id, info):
        self.public[vehicle_id] = copy.deepcopy(info)
        self.roster()

    # ---- Vehicle methods: hits, health, extras, ammo bay, splash -----------------------------------------------
    def vehicle_method(self, vid, name, a, t):
        if name == 'showDamageFromShot': self.hit(vid, a, t)
        elif name == 'onHealthChanged': self.health(vid, a, t)
        elif name == 'onExtraHitted':
            extra, kind = self.names.extra(vid, a.get('extraIndex'))
            values = {'vehicleId':vid, 'extraIndex':int(a['extraIndex']), 'point':vec(a.get('hitPoint'))}
            if extra is not None: values['extra'] = extra
            if kind is not None: values['extraType'] = kind
            self.event('crit', 'extraHit', t, values)
        elif name == 'showAmmoBayEffect':
            values = {'vehicleId':vid, 'mode':int(a['mode']), 'fireballVolume':num(a.get('fireballVolume'))}
            mode = self.names.ammo_bay_mode(a['mode'])
            if mode is not None: values['modeName'] = mode
            self.event('crit', 'ammoBay', t, values)
        elif name == 'showDamageFromExplosion':
            self.event('crit', 'explosion', t, {'vehicleId':vid, 'attackerId':int(a['attackerID']), 'center':vec(a.get('center')),
                       'effectsIndex':int(a['effectsIndex']), 'damage':int(a['damage']), 'damageFactor':num(a.get('damageFactor')),
                       'gunInstallationIndex':int(a['gunInstallationIndex'])})

    def hit(self, vid, a, t):
        self.seq['hit'] += 1
        player = self.player
        attacker = a.get('attackerID')
        record = {'schema':1, 'type':'hit', 'id':str(self.seq['hit']), 'source':SOURCE,
                  'direction':'outgoing' if attacker == player else 'incoming' if vid == player else 'other',
                  'attackerId':attacker, 'targetId':vid, 'damage':a.get('damage'), 'damageFactor':a.get('damageFactor'),
                  'effectsIndex':a.get('effectsIndex'), 'prefabEffectsIndex':a.get('prefabEffIndex'),
                  'lastMaterialIsShield':bool(a.get('lastMaterialIsShield')), 'shellVelocity':float(a.get('shellVelocity')),
                  'gunInstallationIndex':a.get('gunInstallationIndex'), 'rawHitPoints':[], 'points':[],
                  'warnings':[HIT_WARNING], 'replayAbsent':list(HIT_ABSENT)}
        when = self.game_time(t)
        if when is not None: record['gameTime'] = when
        for p in a.get('hitPoints') or ():
            record['rawHitPoints'].append({'networkID':str(p['networkID']), 'segment':str(p['segment']), 'params':str(p['params'])})
            # Only what the encoding itself says (DamageFromShotDecoder.parseHitPoint): no point, no frame. The calibre
            # as the client computes it (tenths of mm times 0.1, not rounded: 1143 -> 114.30000000000001, as live).
            point = dict((k, p[k]) for k in ('part', 'effect', 'hitType', 'shellType') if k in p)
            params = integer(p.get('params'))
            if params is not None: point['caliber'] = ((params >> 8) & 0xffff) * 0.1
            point['status'] = 'replay-raw'
            record['points'].append(point)
        self.put(record)

    def health(self, vid, a, t):
        reason = int(a.get('attackReasonID') or 0)
        new, old, attacker = int(a['newHealth']), int(a['oldHealth']), int(a.get('attackerID') or 0)
        # crit_log.health: a shot's damage is on its hit; only the shot that destroys the vehicle is written.
        if not reason and new > 0: return
        values = {'vehicleId':vid, 'newHealth':new, 'oldHealth':old, 'attackerId':attacker, 'attackReasonId':reason,
                  'attackReasonExtId':int(a.get('attackReasonExtID') or 0)}
        name = self.names.constant('ATTACK_REASONS', reason)
        if name is not None: values['attackReason'] = name
        self.event('crit', 'health', t, values)
        if reason == self.names.ram_reason and attacker and attacker != vid and self.player in (vid, attacker):
            pair = frozenset((vid, attacker))
            self.rams[pair] = t
            if self.contact is not None and 0 <= t - self.contact['at'] <= CONTACT_WINDOW:
                self.write_contact(pair, self.contact, t)

    # ---- Avatar methods: shots, shot results, damaged devices, own contacts -------------------------------------
    def avatar_method(self, name, a, t):
        if name == 'showTracer': self.tracer(a, t)
        elif name == 'stopTracer': self.endpoint(a, t, 'stop')
        elif name == 'explodeProjectile':
            self.endpoint(a, t, 'explosion', {'direction':vec(a.get('velocityDir')), 'speed':num(a.get('speed')),
                                              'material':int(a.get('effectMaterialIndex') or 0)})
        elif name == 'showShotResults':
            rows = []
            for r in a.get('results') or ():
                flags = int(r['hitFlags'])
                row = {'vehicleId':int(r['vehicleID']), 'hitFlags':flags, 'gunInstallationIndex':int(r['gunInstallationIndex'])}
                names = self.names.hit_flags(flags)
                if names is not None: row['flagNames'] = names
                rows.append(row)
            if rows: self.event('crit', 'shotResults', t, {'shooterId':self.player, 'results':rows})
        elif name == 'showOtherVehicleDamagedDevices':
            vid = int(a['vehicleID'])
            damaged = [int(i) for i in a.get('damagedExtras') or ()]
            destroyed = [int(i) for i in a.get('destroyedExtras') or ()]
            values = {'vehicleId':vid, 'damagedIdx':damaged, 'destroyedIdx':destroyed}
            for field, indexes in (('damaged', damaged), ('destroyed', destroyed)):
                named = [self.names.extra(vid, i) for i in indexes]
                if all(n[0] is not None for n in named): values[field] = [n[0] for n in named]
                if all(n[1] is not None for n in named): values[field + 'Types'] = [n[1] for n in named]
            self.event('crit', 'damagedDevices', t, values)
        elif name == 'onCollisionWithVehicle':
            self.collided(a, t)

    def tracer(self, a, t):
        shooter = int(a['shooterID'])
        values = {'shooterId':shooter, 'shotId':str(a['shotID']), 'isRicochet':bool(a.get('isRicochet')),
                  'effectsIndex':int(a['effectsIndex']), 'shellTypeIdx':int(a['shellTypeIdx']), 'caliber':num(a.get('shellCaliber')),
                  'origin':vec(a.get('refStartPoint')), 'velocity':vec(a.get('velocity')), 'gravity':num(a.get('gravity')),
                  'maxDistance':num(a.get('maxShotDist')), 'gunIndex':int(a['gunIndex']),
                  'gunInstallationIndex':int(a['gunInstallationIndex']), 'source':'replay Avatar.showTracer',
                  'own':shooter == self.player}
        self.tracers[str(a['shotID'])] = self.event('shot', 'tracer', t, values)

    def endpoint(self, a, t, event, extra=None):
        tracer = self.tracers.get(str(a['shotID']))
        if tracer is None:
            # telemetry.endpoint: a shot end without its tracer is not written (the shell left before it was seen).
            self.count(event + ' without its tracer', 'skipped')
            return
        values = {'shotId':str(a['shotID']), 'tracerId':tracer['id'], 'shooterId':tracer['shooterId'], 'own':tracer['own'],
                  'position':vec(a.get('endPoint'))}
        values['segmentDistance'] = math.sqrt(sum((values['position'][i] - tracer['origin'][i]) ** 2 for i in range(3)))
        if extra: values.update(extra)
        self.event('shot', event, t, values)

    def collided(self, a, t):
        """The own vehicle's contact (Avatar.onCollisionWithVehicle: the point and the energy, no other vehicle). Kept
        like crit_log.collided and written only next to a ram tick of the own vehicle; the pair is that tick's."""
        if self.contact is not None and 0 <= t - self.contact['at'] < CONTACT_PACE: return
        self.contact = {'at':t, 'point':vec(a.get('point')), 'energy':num(a.get('energy'))}
        for pair, ram in self.rams.items():
            if 0 <= t - ram <= CONTACT_WINDOW: self.write_contact(pair, self.contact, t)

    def write_contact(self, pair, contact, t):
        if contact.get('written') or t - self.written.get(pair, -1e9) <= CONTACT_WINDOW: return
        contact['written'] = True
        self.written[pair] = t
        values = {'at':self.game_time(contact['at']), 'point':contact['point'], 'energy':contact['energy'],
                  'source':'replay Avatar.onCollisionWithVehicle', 'pair':sorted(pair), 'pairFrom':'ram tick',
                  'sides':[{'vehicleId':v} for v in sorted(pair)]}
        self.event('crit', 'collision', contact['at'], values)

    # ---- components: own vehicle, fire, vehicles info --------------------------------------------------------------
    def component(self, ev, t):
        name, owner, state = ev.get('component'), ev.get('owner'), ev.get('state') or {}
        if name == 'Fire':
            self.fires[ev.get('cid')] = owner
            self.fire(owner, 'appeared', t)
            if state.get('fireInfo'): self.fire_info(owner, state['fireInfo'], t)
        elif name == 'AvatarVehiclesInfo':
            self.info = copy.deepcopy(state.get('vehiclesInfo'))
            self.roster()
        elif name == 'OwnVehicle':
            full = copy.deepcopy(state.get('vehicleDamageInfoList') or [])
            self.damage_lists[owner] = full
            if full:
                # crit_log.damage_info: the whole list again on (re)attaching - history without timing, not a hit.
                self.seen[owner] = max(self.seen.get(owner, 0), len(full))
                self.event('crit', 'damageInfoReplay', t, {'vehicleId':owner, 'count':len(full)})

    def component_property(self, ev, t):
        name, owner, comp = ev.get('name'), ev.get('owner'), ev.get('component')
        if comp == 'AvatarVehiclesInfo' and name == 'vehiclesInfo':
            self.info = apply_update(self.info, ev)
            path = ev.get('path') or []
            if len(path) < 3 or path[-1] in ROSTER_FIELDS or 'slice' in ev: self.roster()
        elif comp == 'OwnVehicle' and name == 'vehicleDamageInfoList':
            self.damage_info(owner, ev, t)
        elif comp == 'OwnVehicle' and name == 'isOtherVehicleDamagedDevicesVisible':
            value = ev.get('value')
            status = value.get('status') if isinstance(value, dict) else value
            self.event('crit', 'damagedDevicesVisible', t, {'vehicleId':owner, 'status':int(status)})
        elif comp == 'Fire' and name == 'fireInfo' and ev.get('value'):
            self.fire_info(owner, ev['value'], t)

    def component_method(self, ev, t):
        comp, name, owner = ev.get('component'), ev.get('name'), ev.get('owner')
        if comp != 'OwnVehicle': return
        if name == 'showOwnVehicleHitDirection':
            a = method_args(ev)
            reason = int(a['attackReasonID'])
            values = {'route':'component', 'vehicleId':int(a['damagedID']), 'attackerId':int(a['attackerID']),
                      'damage':int(a['damage']), 'crits':int(a['crits']), 'isBlocked':bool(a['isBlocked']),
                      'isShellHE':bool(a['isShellHE']), 'attackReasonId':reason, 'hitDirYaw':num(a.get('hitDirYaw')),
                      'componentVehicleId':owner}
            if self.controlling is not None: values['controllingVehicleId'] = self.controlling
            decoded = self.names.crit_mask(int(a['crits']))
            if decoded is not None: values['critsDecoded'] = decoded
            reason_name = self.names.constant('ATTACK_REASONS', reason)
            if reason_name is not None: values['attackReason'] = reason_name
            self.event('crit', 'hitDirection', t, values)
        elif name == 'onBattleEvents':
            a = ev.get('args') or {}
            events = list(a.values())[0] if len(a) == 1 else a.get('events')
            wanted = self.names.crit_events
            rows = []
            for e in events or ():
                if e.get('eventType') not in wanted: continue
                details = int(e['details'])
                rows.append({'eventType':int(e['eventType']), 'eventName':'CRIT' if e['eventType'] == wanted[0] else 'RECEIVED_CRIT',
                             'targetId':int(e['targetID']), 'count':int(e['count']), 'details':str(details),
                             'critsCount':details >> 24 & 0xFFFF, 'attackReasonId':details >> 16 & 255,
                             'shellTypeId':details >> 9 & 127, 'shellIsGold':details >> 8 & 1})
            if rows: self.event('crit', 'battleEvents', t, {'route':'component', 'vehicleId':owner, 'events':rows})

    def damage_info(self, owner, ev, t):
        """crit_log.damage_info: one record per list position, once."""
        before = self.damage_lists.get(owner) or []
        if 'path' not in ev:
            full, start, entries = copy.deepcopy(ev.get('value') or []), 0, ev.get('value') or []
        else:
            full = apply_update(copy.deepcopy(before), ev)
            if 'slice' in ev:
                start, entries = ev['slice'][0], ev.get('value') or []
            else:
                # One element or field changed: the entry at that position is written if not yet.
                start = ev['path'][1] if len(ev['path']) > 1 and isinstance(ev['path'][1], int) else None
                entries = [full[start]] if start is not None and start < len(full) else []
        self.damage_lists[owner] = full
        if not full:
            self.seen.pop(owner, None)
            return
        seen = self.seen.get(owner, 0)
        if len(full) < seen: seen = 0
        for i, entry in enumerate(entries):
            position = start + i
            if position < seen: continue
            extra, kind = self.names.extra(owner, entry.get('extraIndex'))
            values = {'vehicleId':owner, 'position':position, 'attackerId':int(entry['entityID']),
                      'damageIndex':int(entry['damageIndex']), 'extraIndex':int(entry['extraIndex']),
                      'equipmentId':int(entry.get('equipmentID') or 0), 'damageExtIndex':int(entry.get('damageExtIndex') or 0)}
            code = self.names.constant('DAMAGE_INFO_CODES', entry['damageIndex'])
            if code is not None: values['damageCode'] = code
            if extra is not None: values['extra'] = extra
            if kind is not None: values['extraType'] = kind
            self.event('crit', 'damageInfo', t, values)
        if start is not None: self.seen[owner] = max(seen, start + len(entries))

    def fire(self, vid, state, t):
        if vid is None or self.burning.get(vid) == state: return
        self.burning[vid] = state
        self.event('crit', 'fire', t, {'vehicleId':vid, 'state':state})

    def fire_info(self, vid, info, t):
        device, kind = self.names.extra(vid, info.get('deviceExtraIndex'))
        values = {'vehicleId':vid, 'attackerId':int(info['attackerID']), 'deviceExtraIndex':int(info['deviceExtraIndex']),
                  'notificationIndex':int(info['notificationIndex']), 'equipmentId':int(info.get('equipmentID') or 0),
                  'startTime':num(info.get('startTime'))}
        note = self.names.constant('FIRE_NOTIFICATION_CODES', info['notificationIndex'])
        if note is not None: values['notification'] = note
        if device is not None: values['device'] = device
        if kind is not None: values['deviceType'] = kind
        self.event('crit', 'fireInfo', t, values)

    def public_state(self, ev, t):
        vid = ev['id']
        previous = self.modifiers.get(vid) or []
        # The list as the server holds it (slices index into it); the record compares the sets, as crit_log does.
        current = list(apply_update(list(previous), ev) or ())
        self.modifiers[vid] = current
        added, removed = sorted(set(current) - set(previous)), sorted(set(previous) - set(current))
        if not added and not removed: return
        values = {'vehicleId':vid, 'addedIdx':[int(i) for i in added], 'removedIdx':[int(i) for i in removed]}
        for field, indexes in (('added', added), ('removed', removed)):
            named = [self.names.extra(vid, i) for i in indexes]
            if all(n[0] is not None for n in named): values[field] = [n[0] for n in named]
            if field == 'added' and all(n[1] is not None for n in named): values['addedTypes'] = [n[1] for n in named]
        self.event('crit', 'publicState', t, values)


def records(events, **options):
    """Every record of one battle, in the order the recorder would have written them (header first)."""
    converter = Converter(**options)
    for ev in events:
        for record in converter.feed(ev):
            yield record
    for record in converter.finish():
        yield record


def convert(events, **options):
    """(records list, stats) of one battle; options as Converter."""
    converter = Converter(**options)
    out = []
    for ev in events: out.extend(converter.feed(ev))
    out.extend(converter.finish())
    return out, converter.stats
