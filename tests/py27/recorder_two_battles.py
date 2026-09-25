# -*- coding: utf-8 -*-
"""The recorder through two battles, a replay and an observer seat, under the client's own Python 2.7.

Run:  python tests/py27/run27.py tests/py27/recorder_two_battles.py [MOD_DIR]   (default <repo>/mod)

What runs is the real mod (mod/mod_local_armor_inspector.py + mod/local_armor_inspector/*, copied to a temp
folder first so nothing is compiled or written next to the sources) with the client modules its init()
imports replaced by small stubs. Every hook is driven through the stub class it wraps, exactly as the
client calls it (Vehicle.showDamageFromShot, PlayerAvatar.showTracer ...). The battle files land in the temp
folder: the recorder's folder is relative to the working directory (init() passes
mods/configs/local.armor_inspector/battles), so the script chdirs into a temp 'game' folder first. No
version.xml there, so the Recorder starts without the HTML exporter (its thread is not covered here).

Checks, by group:
  hooks      init() wraps each expected class attribute once; a second init() changes nothing; fini() puts
             every original back (by the class dict - Python 2 hands out a new unbound method per read)
  battle A/B roster, hits in/out/other, tracers, a crit, the motion sampler; per-battle state replaced when
             B starts; arena events unsubscribed on leaving
  gunAfterShot the first two own server gun updates after the own tracer, in one record naming that tracer; a third
             update and the enemy's tracer add nothing; a last own shot still waiting when the avatar leaves the
             battle keeps the one update that came (BACKLOG 28 step 2)
  files      one JSONL file per battle, one header each, first line; only that battle's events; ids unique
  replay     a replay being played writes no battle file (REC-01)
  observer   an observer seat (its vehicle the client's ussr:Observer, tag 'observer') writes no battle file (REC-01)
  shutdown   Writer thread ended, subscriptions gone, no ERROR logged

Output: a summary line plus one line per failed check, and 'note' lines for things that are known and not
asserted (REC-03 state left in the hangar). Verdict through BULLBA_PY27_RESULT (see run27.py).
"""
import collections
import glob
import imp
import json
import logging
import math
import os
import shutil
import sys
import tempfile
import time
import traceback
import types

REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESULT = os.environ.get('BULLBA_PY27_RESULT')
sys.dont_write_bytecode = True

checks = []        # (group, name, ok, detail)
notes = []


def check(group, name, ok, detail=''):
    checks.append((group, name, bool(ok), detail))
    return bool(ok)


def note(text):
    notes.append(text)


# ---------------------------------------------------------------------------------------------------------
# Client stubs
# ---------------------------------------------------------------------------------------------------------
CALLS = collections.Counter()   # 'Class.method' -> how often the client's ORIGINAL ran


class NS(object):
    def __init__(self, **kw): self.__dict__.update(kw)


class Event(object):
    """Events.Event of the client: += / -= / call."""
    def __init__(self): self.handlers = []
    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self
    def __isub__(self, handler):
        self.handlers.remove(handler)
        return self
    def __call__(self, *args, **kwargs):
        for handler in list(self.handlers): handler(*args, **kwargs)


class V3(object):
    """Math.Vector3 enough for the recorder: index, x/y/z, +, -, length."""
    def __init__(self, x=0.0, y=0.0, z=0.0): self.x, self.y, self.z = float(x), float(y), float(z)
    def __getitem__(self, i): return (self.x, self.y, self.z)[i]
    def __len__(self): return 3
    def __add__(self, o): return V3(self.x + o[0], self.y + o[1], self.z + o[2])
    def __sub__(self, o): return V3(self.x - o[0], self.y - o[1], self.z - o[2])
    @property
    def length(self): return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)


class Matrix(object):
    """Math.Matrix: a yaw rotation plus a translation (the fixture of tests/test_hits.py)."""
    def __init__(self, other=None):
        self.angle = getattr(other, 'angle', 0.0)
        self.translation = getattr(other, 'translation', (0.0, 0.0, 0.0))
    def applyVector(self, v):
        c, s = math.cos(self.angle), math.sin(self.angle)
        return (c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2])
    def applyPoint(self, v): return tuple(a + b for a, b in zip(self.applyVector(v), self.translation))
    def invertOrthonormal(self):
        self.angle = -self.angle
        self.translation = self.applyVector(tuple(-x for x in self.translation))
    @property
    def yaw(self): return self.angle


def original(label):
    """A client method that only counts its own calls."""
    def method(self, *args, **kwargs):
        CALLS[label] += 1
    method.__name__ = label.split('.')[-1]
    return method


class Vehicle(object):
    showDamageFromShot = original('Vehicle.showDamageFromShot')
    set_publicStateModifiers = original('Vehicle.set_publicStateModifiers')
    onExtraHitted = original('Vehicle.onExtraHitted')
    onHealthChanged = original('Vehicle.onHealthChanged')
    showAmmoBayEffect = original('Vehicle.showAmmoBayEffect')
    showDamageFromExplosion = original('Vehicle.showDamageFromExplosion')


class PlayerAvatar(object):
    _PlayerAvatar__startWaitingForShot = original('PlayerAvatar.__startWaitingForShot')
    showTracer = original('PlayerAvatar.showTracer')
    stopTracer = original('PlayerAvatar.stopTracer')
    explodeProjectile = original('PlayerAvatar.explodeProjectile')
    updateGunMarker = original('PlayerAvatar.updateGunMarker')
    updateTargetingInfo = original('PlayerAvatar.updateTargetingInfo')
    showOwnVehicleHitDirection = original('PlayerAvatar.showOwnVehicleHitDirection')
    onBattleEvents = original('PlayerAvatar.onBattleEvents')
    showShotResults = original('PlayerAvatar.showShotResults')
    showOtherVehicleDamagedDevices = original('PlayerAvatar.showOtherVehicleDamagedDevices')
    updateIsOtherVehicleDamagedDevicesVisible = original('PlayerAvatar.updateIsOtherVehicleDamagedDevicesVisible')
    handleVehicleCollidedVehicle = original('PlayerAvatar.handleVehicleCollidedVehicle')

    def isObserver(self): return self.observer


class AvatarInputHandler(object):
    updateClientGunMarker = original('AvatarInputHandler.updateClientGunMarker')
    updateServerGunMarker = original('AvatarInputHandler.updateServerGunMarker')


class OwnVehicleBase(object):
    showOwnVehicleHitDirection = original('OwnVehicleBase.showOwnVehicleHitDirection')
    update_vehicleDamageInfoList = original('OwnVehicleBase.update_vehicleDamageInfoList')
    onBattleEvents = original('OwnVehicleBase.onBattleEvents')


class Fire(object):
    __init__ = original('Fire.__init__')
    set_fireInfo = original('Fire.set_fireInfo')
    onDestroy = original('Fire.onDestroy')


class VehicleContextMenuHandler(object):
    def _generateOptions(self, ctx=None):
        CALLS['VehicleContextMenuHandler._generateOptions'] += 1
        return [{'id': 'sell'}]
    onOptionSelect = original('VehicleContextMenuHandler.onOptionSelect')
    @staticmethod
    def _makeItem(option, label): return {'id': option, 'label': label}


HOOK_CLASSES = (Vehicle, PlayerAvatar, AvatarInputHandler, OwnVehicleBase, Fire, VehicleContextMenuHandler)
EXPECTED_HOOKS = set([
    # init(): the hit
    ('Vehicle', 'showDamageFromShot'),
    # ShotTelemetry.install
    ('PlayerAvatar', '_PlayerAvatar__startWaitingForShot'), ('PlayerAvatar', 'showTracer'),
    ('PlayerAvatar', 'stopTracer'), ('PlayerAvatar', 'explodeProjectile'), ('PlayerAvatar', 'updateGunMarker'),
    ('PlayerAvatar', 'updateTargetingInfo'),
    ('AvatarInputHandler', 'updateClientGunMarker'), ('AvatarInputHandler', 'updateServerGunMarker'),
    # CritLog.install
    ('OwnVehicleBase', 'showOwnVehicleHitDirection'), ('OwnVehicleBase', 'update_vehicleDamageInfoList'),
    ('OwnVehicleBase', 'onBattleEvents'),
    ('PlayerAvatar', 'showOwnVehicleHitDirection'), ('PlayerAvatar', 'onBattleEvents'),
    ('PlayerAvatar', 'showShotResults'), ('PlayerAvatar', 'showOtherVehicleDamagedDevices'),
    ('PlayerAvatar', 'updateIsOtherVehicleDamagedDevicesVisible'), ('PlayerAvatar', 'handleVehicleCollidedVehicle'),
    ('Fire', 'set_fireInfo'), ('Fire', '__init__'), ('Fire', 'onDestroy'),
    ('Vehicle', 'set_publicStateModifiers'), ('Vehicle', 'onExtraHitted'), ('Vehicle', 'onHealthChanged'),
    ('Vehicle', 'showAmmoBayEffect'), ('Vehicle', 'showDamageFromExplosion'),
    # install_context_menu
    ('VehicleContextMenuHandler', '_generateOptions'), ('VehicleContextMenuHandler', 'onOptionSelect'),
])


class World(object):
    """BigWorld state: the player, the entities, the clock and the pending callbacks."""
    def __init__(self):
        self.player = NS(name='account')   # the hangar: an account, no arena
        self.entities = {}
        self.time = 100.0
        self.callbacks = {}
        self.next = 1

    def callback(self, delay, fn):
        handle = self.next
        self.next += 1
        self.callbacks[handle] = fn
        return handle

    def cancel(self, handle):
        self.callbacks.pop(handle, None)

    def pump(self, ticks=1):
        """Run every pending callback, as if their delay had passed."""
        for _ in range(ticks):
            self.time += 0.2
            pending, self.callbacks = self.callbacks, {}
            for fn in pending.values(): fn()


WORLD = World()


def module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


class Decoder(object):
    @staticmethod
    def parseHitPoint(hit, collisions): return 1, 4, (-2.0, 0.0, 0.0), (2.0, 0.0, 0.0), 0, 0, 100.0
    @staticmethod
    def collideHitPoint(idx, start, end, collisions): return (-1.0, 0.0, 0.0), (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0)


class ReplayCtrl(object):
    isPlaying = False


MODS_LIST = []


def install_stubs():
    module('BigWorld', player=lambda: WORLD.player, entity=lambda i: WORLD.entities.get(i),
           serverTime=lambda: WORLD.time, callback=WORLD.callback, cancelCallback=WORLD.cancel,
           target=lambda: None)
    module('Math', Matrix=Matrix, Vector3=V3)
    module('VehicleEffects', DamageFromShotDecoder=Decoder)
    module('BattleReplay', g_replayCtrl=ReplayCtrl())
    module('Vehicle', Vehicle=Vehicle)
    module('Avatar', PlayerAvatar=PlayerAvatar)
    module('AvatarInputHandler', AvatarInputHandler=AvatarInputHandler)
    module('OwnVehicleBase', OwnVehicleBase=OwnVehicleBase)
    module('Fire', Fire=Fire)
    module('constants', SHELL_TYPES_LIST=('HOLLOW_CHARGE', 'HIGH_EXPLOSIVE', 'ARMOR_PIERCING', 'ARMOR_PIERCING_HE',
                                          'ARMOR_PIERCING_CR', 'SMOKE', 'FLAME'),
           SHELL_TYPES_INDICES={'HOLLOW_CHARGE': 0, 'HIGH_EXPLOSIVE': 1, 'ARMOR_PIERCING': 2,
                                'ARMOR_PIERCING_HE': 3, 'ARMOR_PIERCING_CR': 4},
           ROLE_TYPE_TO_LABEL={0: 'NotDefined'}, BATTLE_MODE_VEHICLE_TAGS=frozenset())
    module('BattleFeedbackCommon', BATTLE_EVENT_TYPE=NS(CRIT=6, RECEIVED_CRIT=9))
    module('CurrentVehicle', g_currentVehicle=NS(onChanged=Event(), isPresent=lambda: False, item=None))
    module('PlayerEvents', g_playerEvents=NS(onAvatarBecomePlayer=Event(), onAvatarBecomeNonPlayer=Event()))
    module('items', __path__=[])
    sys.modules['items'].vehicles = module('items.vehicles',
        VEHICLE_DEVICE_TYPE_NAMES=('engine', 'ammoBay', 'fuelTank', 'radio', 'track', 'gun', 'turretRotator',
                                   'surveyingDevice'),
        VEHICLE_TANKMAN_TYPE_NAMES=('commander', 'driver', 'radioman', 'gunner', 'loader'),
        g_cache=NS(commonConfig={'deviceExtraIndexToTypeIndex': {}, 'tankmanExtraIndexToTypeIndex': {}}))
    path = 'gui.Scaleform.daapi.view.lobby.hangar.hangar_cm_handlers'.split('.')
    for i in range(1, len(path)):
        module('.'.join(path[:i]), __path__=[])
    module('.'.join(path), VehicleContextMenuHandler=VehicleContextMenuHandler)
    module('gui.modsListApi', g_modsListApi=NS(addModification=lambda **kw: MODS_LIST.append(kw)))


# ---------------------------------------------------------------------------------------------------------
# Battle fixtures
# ---------------------------------------------------------------------------------------------------------
def component(name):
    return NS(name=name, materials={}, hitTesterManager=NS(activeHitTester=NS(bspModelName='vehicles/t/%s.model' % name)))


def descriptor(type_name, tags=('mediumTank',)):
    shell = NS(name='AP', userString='AP', kind='ARMOR_PIERCING', effectsIndex=7, caliber=100.0,
               piercingPowerRandomization=0.25, piercingPowerRandomizationType='NORMAL', armorDamage=(300, 300),
               type=NS(normalizationAngle=0.087, ricochetAngleCos=0.34))
    chassis = component('chassis')
    chassis.hullPosition = V3(0, 0.5, 0)
    chassis.trackPairs = ()
    hull = component('hull')
    hull.turretPositions = [V3(0, 1.0, 0)]
    turret = component('turret')
    turret.gunPosition = V3(0, 0.4, 0.2)
    gun = component('gun')
    gun.shortUserString = 'Gun'
    gun.shotDispersionAngle = 0.3
    gun.shots = [NS(shell=shell, piercingPower=(200.0, 180.0), speed=1000.0, gravity=9.81, maxDistance=720.0)]
    gun.turretYawLimits = None
    return NS(type=NS(name=type_name, shortUserString=type_name.split(':')[1], level=8,
                      tags=frozenset(tags), role=0),
              makeCompactDescr=lambda: b'\x01' + type_name.encode('ascii'),
              chassis=chassis, hull=hull, turret=turret, gun=gun, miscAttrs={}, maxHealth=1000,
              hasSiegeMode=False)


def make_vehicle(vehicle_id, descr):
    v = Vehicle.__new__(Vehicle)
    v.id = vehicle_id
    v.typeDescriptor = descr
    # The chassis frame stands at the vehicle's position turned a quarter round, so a world point has to be carried
    # into it (the ram contact's 'local'); every part shares it (rest pose).
    frame = NS(angle=math.pi / 2, translation=(vehicle_id * 10.0, 0.0, 0.0))
    v.appearance = NS(collisions=NS(getPartTransform=lambda i: Matrix(frame), maxStaticPartIndex=3))
    v.position = V3(vehicle_id * 10.0, 0.0, 0.0)
    v.isStarted = True
    v.isAlive = lambda: True
    v.getServerGunAngles = lambda: (0.1, -0.05)
    v.speedInfo = NS(value=(1.0, 0.1, 5.0, 0.2))
    v.matrix = Matrix()
    v.filter = NS(velocity=V3(0.0, 0.0, 5.0 if vehicle_id % 3 == 0 else 0.0))
    v.getAimParams = lambda: (0.2, 0.3)
    v.publicStateModifiers = ()
    v.maxHealth = descr.maxHealth   # Vehicle.maxHealth of the client: publicInfo.maxHealth, the server's figure
    return v


class Battle(object):
    """One arena: the player's vehicle, an enemy and an ally, their entities and the avatar."""
    def __init__(self, arena_id, first_vehicle, observer=False):
        self.arena_id = arena_id
        self.me, self.enemy, self.ally = first_vehicle, first_vehicle + 1, first_vehicle + 2
        self.ids = set([self.me, self.enemy, self.ally])
        infos = {}
        for vid, team in ((self.me, 1), (self.enemy, 2), (self.ally, 1)):
            # A spectator seat drives the client's ussr:Observer, the one type tagged 'observer' (list.xml).
            seat = observer and vid == self.me
            infos[vid] = {'vehicleType': descriptor('ussr:Observer' if seat else 'usa:T%d' % vid,
                                                    ('observer', 'lightTank') if seat else ('mediumTank',)),
                          'team': team, 'name': 'player%d' % vid,
                          'avatarSessionID': 'x', 'vehPostProgression': [], 'customRoleSlotTypeId': 0}
        self.arena = NS(arenaUniqueID=arena_id, vehicles=infos, arenaType=NS(name='Map %d' % arena_id),
                        bonusType=1, guiType=1, extraData={}, onNewVehicleListReceived=Event(),
                        onVehicleAdded=Event(), onVehicleUpdated=Event())
        self.entities = dict((vid, make_vehicle(vid, infos[vid]['vehicleType'])) for vid in self.ids)
        avatar = PlayerAvatar.__new__(PlayerAvatar)
        avatar.arena = self.arena
        avatar.playerVehicleID = self.me
        avatar.observer = observer
        avatar.inputHandler = AvatarInputHandler.__new__(AvatarInputHandler)
        avatar.gunRotator = None
        self.avatar = avatar
        self.shot_ids = set()

    def enter(self, events):
        WORLD.entities = dict(self.entities)
        WORLD.player = self.avatar
        events.onAvatarBecomePlayer()

    def leave(self, events):
        WORLD.player = NS(name='account')
        events.onAvatarBecomeNonPlayer()
        WORLD.entities = {}

    def hit(self, target, attacker, effects=7):
        hit = {'networkID': 0, 'segment': 18446744073709551615, 'params': 2}
        return self.entities[target].showDamageFromShot(attacker, [hit], effects, 0, 300, 1.0, False, 1000.0, 0)

    def tracer(self, shooter, shot_id, effects=7):
        self.shot_ids.add(str(shot_id))
        self.avatar.showTracer(shooter, shot_id, False, effects, 0, 2, 100.0, V3(shooter, 1, 0), V3(0, 0, 900),
                               9.81, 720.0, 0, 0)

    def gun_marker(self, k):
        """One server gun update of the player's own vehicle (PlayerAvatar.updateGunMarker), origin moving 1 m a tick."""
        self.avatar.updateGunMarker(self.me, V3(float(k), 1, 0), V3(0, 0, 1), (0.002, 0.004, 0.006, 0.008, 0.010)[k])

    def play(self, last_shot=False):
        """The events of one battle, each through the client method the recorder hooks."""
        WORLD.pump(3)                                                   # motion sampler ticks
        self.avatar._PlayerAvatar__startWaitingForShot(NS(gunIndexDelayed=0, predictShooting=False))
        self.gun_marker(0)                                              # the server aim the shot leaves by
        self.tracer(self.me, self.arena_id % 1000 * 10 + 1)             # own shot
        self.tracer(self.enemy, self.arena_id % 1000 * 10 + 2)          # the enemy's shot
        for k in (1, 2, 3): self.gun_marker(k)                          # two kept after the own tracer, a third not
        self.avatar.stopTracer(self.arena_id % 1000 * 10 + 1, V3(0, 0, 50))
        self.avatar.inputHandler.updateClientGunMarker(NS(position=V3(1, 2, 3), direction=V3(0, 0, 1), size=2.5),
                                                       None, 0.1)
        self.hit(self.enemy, self.me)                                   # outgoing
        self.hit(self.me, self.enemy)                                   # incoming
        self.hit(self.ally, self.enemy)                                 # other
        self.avatar.showOwnVehicleHitDirection(0.5, self.enemy, 300, 0, False, False, self.me, 0)
        self.entities[self.me].onHealthChanged(700, 1000, self.enemy, 1)
        # A ram (25.09): the client physics' contact of the pair, then the server's damage to both - one contact
        # record near the damage; a second tick of the same ram writes none, a shot that leaves HP writes nothing.
        me, enemy = self.entities[self.me], self.entities[self.enemy]
        self.avatar.handleVehicleCollidedVehicle(me, enemy, V3(self.me * 10.0 + 2.0, 0.5, 1.0), 1.0)
        self.entities[self.enemy].onHealthChanged(950, 1000, self.me, 2)
        self.entities[self.me].onHealthChanged(690, 700, self.enemy, 2)
        self.entities[self.me].onHealthChanged(680, 690, self.enemy, 2)
        self.entities[self.ally].onHealthChanged(500, 800, self.enemy, 0)
        self.entities[self.ally].onHealthChanged(-1, 500, self.enemy, 0)   # the shot that destroys: written (HP 0)
        WORLD.pump(1)
        # The last own shot of the battle: one server update comes, then the avatar leaves (death at the end, the
        # battle over) - the wait is written on the way out with what it holds.
        if last_shot:
            self.tracer(self.me, self.arena_id % 1000 * 10 + 3)
            self.gun_marker(4)


# ---------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------
class Capture(logging.Handler):
    def __init__(self):
        logging.Handler.__init__(self, logging.DEBUG)
        self.records = []
    def emit(self, record): self.records.append(record)


def hooked_attrs():
    return dict(((cls.__name__, name), value) for cls in HOOK_CLASSES for name, value in vars(cls).items()
                if isinstance(value, (types.FunctionType, types.MethodType, staticmethod)))


def closure_values(fn):
    values = []
    for cell in getattr(fn, '__closure__', None) or ():
        try: value = cell.cell_contents
        except ValueError: continue
        values.append(getattr(value, 'im_func', value))
    return values


def read_jsonl(path):
    rows, bad = [], 0
    with open(path, 'rb') as stream:
        for line in stream:
            line = line.strip()
            if not line: continue
            try: rows.append(json.loads(line))
            except ValueError: bad += 1
    return rows, bad


ID_FIELDS = ('attackerId', 'targetId', 'shooterId', 'vehicleId', 'playerVehicleId')


def foreign_events(rows, own_ids, other_ids, other_shots):
    """Records of this file that name a vehicle or a shot of the other battle."""
    found = []
    for row in rows:
        for field in ID_FIELDS:
            if row.get(field) in other_ids and row.get(field) not in own_ids: found.append((row.get('type'), field))
        if row.get('shotId') in other_shots: found.append((row.get('type'), 'shotId'))
        for vehicle in row.get('vehicles') or ():
            if vehicle.get('id') in other_ids: found.append(('roster', 'vehicles.id'))
        for vehicle in row.get('pair') or ():
            if vehicle in other_ids and vehicle not in own_ids: found.append((row.get('type'), 'pair'))
    return found


# ---------------------------------------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------------------------------------
def run(temp):
    # Optional first argument: another mod folder to test (e.g. an export of an older commit's mod/).
    source = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(REPO, 'mod')
    target = os.path.join(temp, 'mod')
    os.makedirs(os.path.join(target, 'local_armor_inspector'))
    for path in glob.glob(os.path.join(source, '*.py')) + glob.glob(os.path.join(source, 'local_armor_inspector', '*.py')):
        shutil.copy(path, os.path.join(target, os.path.relpath(path, source)))
    game = os.path.join(temp, 'game')
    os.makedirs(game)
    os.chdir(game)
    sys.path.insert(0, target)
    install_stubs()
    logger = logging.getLogger('local.armor_inspector')
    capture = Capture()
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    mod = imp.load_source('mod_local_armor_inspector', os.path.join(target, 'mod_local_armor_inspector.py'))
    events = sys.modules['PlayerEvents'].g_playerEvents
    hangar = sys.modules['CurrentVehicle'].g_currentVehicle

    # ---- hooks ------------------------------------------------------------------------------------------
    before = hooked_attrs()
    mod.init()
    first = hooked_attrs()
    recorder = mod._recorder
    check('hooks', 'init() created the recorder', recorder is not None)
    if recorder is None:
        return mod
    mod.init()
    second = hooked_attrs()
    changed = set(key for key in before if first.get(key) is not before[key])
    missing, extra = EXPECTED_HOOKS - changed, changed - EXPECTED_HOOKS
    check('hooks', 'init() wraps the %d expected client methods' % len(EXPECTED_HOOKS), not missing and not extra,
          'not wrapped: %s; unexpected: %s' % (sorted(missing), sorted(extra)))
    double = [key for key in changed if before[key] not in closure_values(first[key])]
    check('hooks', 'each wrapper holds the client original directly (wrapped once)', not double, sorted(double))
    check('hooks', 'a second init() changes no class attribute', all(second[k] is first[k] for k in first),
          sorted(k for k in first if second[k] is not first[k]))
    check('hooks', 'a second init() keeps the one recorder', mod._recorder is recorder)
    check('hooks', 'one subscription to onAvatarBecomePlayer/NonPlayer',
          len(events.onAvatarBecomePlayer.handlers) == 1 and len(events.onAvatarBecomeNonPlayer.handlers) == 1,
          (len(events.onAvatarBecomePlayer.handlers), len(events.onAvatarBecomeNonPlayer.handlers)))
    check('hooks', 'one subscription to the hangar vehicle', len(hangar.onChanged.handlers) == 1,
          len(hangar.onChanged.handlers))
    check('hooks', 'one ModsList entry', len(MODS_LIST) == 1, len(MODS_LIST))
    menu = VehicleContextMenuHandler.__new__(VehicleContextMenuHandler)
    options = menu._generateOptions(None)
    check('hooks', 'context menu: original options plus one entry',
          [o.get('id') for o in options] == ['sell', mod.CONTEXT_MENU_OPTION]
          and CALLS['VehicleContextMenuHandler._generateOptions'] == 1, options)

    # ---- battle A ---------------------------------------------------------------------------------------
    a = Battle(9876543210123456789, 1)
    b = Battle(1234567890987654321, 11)
    a.enter(events)
    check('battle A', 'recorder in battle and motion sampler running', recorder.in_battle and recorder.motion.running)
    check('battle A', 'arena events subscribed once',
          len(a.arena.onNewVehicleListReceived.handlers) == 1 and len(a.arena.onVehicleAdded.handlers) == 1
          and len(a.arena.onVehicleUpdated.handlers) == 1)
    calls_before = dict(CALLS)
    a.play(last_shot=True)
    check('battle A', 'each client original ran once per call (no double wrapper)',
          CALLS['Vehicle.showDamageFromShot'] - calls_before.get('Vehicle.showDamageFromShot', 0) == 3
          and CALLS['PlayerAvatar.showTracer'] - calls_before.get('PlayerAvatar.showTracer', 0) == 3
          and CALLS['PlayerAvatar.showOwnVehicleHitDirection'] - calls_before.get('PlayerAvatar.showOwnVehicleHitDirection', 0) == 1,
          dict((k, CALLS[k] - calls_before.get(k, 0)) for k in CALLS))
    check('battle A', 'recorder, telemetry, crit log and motion on arena A',
          (recorder.battle, recorder.telemetry.arena, recorder.crits.arena, recorder.motion.arena)
          == (str(a.arena_id),) * 4,
          (recorder.battle, recorder.telemetry.arena, recorder.crits.arena, recorder.motion.arena))
    check('battle A', 'motion sampled every vehicle', set(recorder.motion.buffers) == a.ids, sorted(recorder.motion.buffers))
    file_a = recorder.file
    a.leave(events)
    check('battle A', 'leaving: arena events unsubscribed',
          not a.arena.onNewVehicleListReceived.handlers and not a.arena.onVehicleAdded.handlers
          and not a.arena.onVehicleUpdated.handlers,
          (len(a.arena.onNewVehicleListReceived.handlers), len(a.arena.onVehicleAdded.handlers),
           len(a.arena.onVehicleUpdated.handlers)))
    check('battle A', 'leaving: not in battle, sampler stopped, no callback pending',
          not recorder.in_battle and not recorder.motion.running and not WORLD.callbacks
          and not recorder.motion.buffers, (recorder.in_battle, recorder.motion.running, len(WORLD.callbacks)))
    left = []
    if recorder.telemetry.tracers: left.append('telemetry.tracers=%d' % len(recorder.telemetry.tracers))
    if recorder.telemetry.commands: left.append('telemetry.commands=%d' % len(recorder.telemetry.commands))
    if recorder.telemetry.client_marker is not None: left.append('telemetry.client_marker')
    if recorder.mode_blocks: left.append('recorder.mode_blocks=%d' % len(recorder.mode_blocks))
    if recorder.battle is not None: left.append('recorder.battle')
    if recorder.crits.seen or recorder.crits.seq: left.append('crits.seq=%d' % recorder.crits.seq)
    if left: note('REC-03: after leaving battle A the hangar still holds ' + ', '.join(left))

    # ---- battle B ---------------------------------------------------------------------------------------
    b.enter(events)
    check('battle B', 'arena events subscribed once',
          len(b.arena.onNewVehicleListReceived.handlers) == 1 and len(b.arena.onVehicleAdded.handlers) == 1
          and len(b.arena.onVehicleUpdated.handlers) == 1)
    check('battle B', 'recorder switched to B at the roster (battle, file, seq, mode_blocks)',
          recorder.battle == str(b.arena_id) and recorder.file != file_a and recorder.seq == 0
          and not recorder.mode_blocks, (recorder.battle, recorder.file, recorder.seq, len(recorder.mode_blocks)))
    b.play(last_shot=True)
    check('battle B', 'telemetry switched to B, no tracer of A kept',
          recorder.telemetry.arena == str(b.arena_id)
          and not (set(recorder.telemetry.tracers) & a.shot_ids), sorted(recorder.telemetry.tracers))
    check('battle B', 'crit log switched to B', recorder.crits.arena == str(b.arena_id), recorder.crits.arena)
    check('battle B', 'motion switched to B, no vehicle of A',
          recorder.motion.arena == str(b.arena_id) and set(recorder.motion.buffers) == b.ids,
          sorted(recorder.motion.buffers))
    file_b = recorder.file
    b.leave(events)
    check('battle B', 'leaving: arena events unsubscribed',
          not b.arena.onNewVehicleListReceived.handlers and not b.arena.onVehicleAdded.handlers
          and not b.arena.onVehicleUpdated.handlers)

    # ---- replay and observer (REC-01) -------------------------------------------------------------------
    replay = Battle(5550000000000000001, 21)
    sys.modules['BattleReplay'].g_replayCtrl.isPlaying = True
    replay.enter(events)
    replay.play()
    replay.leave(events)
    sys.modules['BattleReplay'].g_replayCtrl.isPlaying = False
    observer = Battle(6660000000000000001, 31, observer=True)
    observer.enter(events)
    observer.play()
    observer.leave(events)

    # ---- fini -------------------------------------------------------------------------------------------
    writer = recorder.writer
    mod.fini()
    after = hooked_attrs()
    kept = sorted(key for key in before if getattr(after.get(key), 'im_func', after.get(key)) is not before[key])
    check('shutdown', 'fini() puts every client original back (REC-10)', not kept,
          '%d still wrapped: %s' % (len(kept), ', '.join('%s.%s' % k for k in kept)))
    rebound = sorted(key for key in before if after.get(key) is not before[key] and key not in kept)
    if rebound:
        note('fini() put back %s as an unbound method object, not the class own function (works, identity differs)'
             % ', '.join('%s.%s' % k for k in rebound))
    check('shutdown', 'Writer thread ended', not writer.thread.is_alive())
    check('shutdown', 'recorder released', mod._recorder is None)
    check('shutdown', 'player events and hangar unsubscribed',
          not events.onAvatarBecomePlayer.handlers and not events.onAvatarBecomeNonPlayer.handlers
          and not hangar.onChanged.handlers)
    check('shutdown', 'no callback left pending', not WORLD.callbacks, len(WORLD.callbacks))

    # ---- files ------------------------------------------------------------------------------------------
    folder = os.path.join(game, 'mods', 'configs', 'local.armor_inspector', 'battles')
    names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(folder, '*.jsonl')))
    stray = [p for p in os.listdir(folder) if not p.endswith('.jsonl')] if os.path.isdir(folder) else []
    check('files', 'battle A and battle B in two different files, one file each', file_a != file_b
          and [n for n in names if n.startswith(str(a.arena_id) + '-')] == [file_a + '.jsonl']
          and [n for n in names if n.startswith(str(b.arena_id) + '-')] == [file_b + '.jsonl'], names)
    check('replay', 'a replay being played writes no battle file (REC-01)',
          not [n for n in names if n.startswith(str(replay.arena_id))],
          [n for n in names if n.startswith(str(replay.arena_id))])
    check('observer', 'an observer seat writes no battle file (REC-01)',
          not [n for n in names if n.startswith(str(observer.arena_id))],
          [n for n in names if n.startswith(str(observer.arena_id))])
    known = tuple(str(x.arena_id) + '-' for x in (a, b, replay, observer))
    check('files', 'no other file in battles/', not stray and all(n.startswith(known) for n in names),
          stray + [n for n in names if not n.startswith(known)])
    for label, battle, name, other in (('A', a, file_a, b), ('B', b, file_b, a)):
        path = os.path.join(folder, name + '.jsonl')
        if not os.path.exists(path): continue
        rows, bad = read_jsonl(path)
        group = 'files ' + label
        headers = [r for r in rows if r.get('type') == 'battle']
        check(group, 'every line is JSON', not bad, '%d unreadable' % bad)
        check(group, 'exactly one header, on the first line', len(headers) == 1 and rows[0].get('type') == 'battle',
              [r.get('type') for r in rows][:3])
        if headers:
            h = headers[0]
            check(group, 'header names this arena and the player',
                  h.get('arenaId') == str(battle.arena_id) and h.get('playerVehicleId') == battle.me
                  and h.get('id') == name and h.get('source') == 'live', (h.get('arenaId'), h.get('playerVehicleId')))
        hits = [r for r in rows if r.get('type') == 'hit']
        check(group, 'its three hits: outgoing, incoming, other',
              [x.get('direction') for x in hits] == ['outgoing', 'incoming', 'other'], [x.get('direction') for x in hits])
        ids = [x.get('id') for x in hits]
        check(group, 'hit ids unique and restarted', ids == ['1', '2', '3'], ids)
        for kind, prefix in (('shot', 's'), ('crit', 'c')):
            own = [r.get('id') for r in rows if r.get('type') == kind]
            check(group, '%s ids unique' % kind, own and len(set(own)) == len(own), own)
        check(group, 'nothing of the other battle',
              not foreign_events(rows, battle.ids, other.ids, other.shot_ids),
              foreign_events(rows, battle.ids, other.ids, other.shot_ids)[:5])
        roster = [r for r in rows if r.get('type') == 'roster']
        check(group, 'roster with the player and his team', roster and roster[-1].get('playerVehicleId') == battle.me
              and roster[-1].get('playerTeam') == 1 and set(v['id'] for v in roster[-1]['vehicles']) == battle.ids)
        if len(hits) == 3:
            check(group, 'the hit is resolved and matched to its shell and tracer',
                  hits[0].get('points', [{}])[0].get('status') == 'resolved' and hits[0].get('shellStatus') == 'matched'
                  and hits[0].get('traceCandidates'), (hits[0].get('shellStatus'), hits[0].get('traceCandidates'),
                                                        hits[0].get('warnings')))
            check(group, 'the incoming hit carries the shooter motion history',
                  (hits[1].get('attacker') or {}).get('motion'))
            check(group, 'no dropped record, no write failure',
                  all(x.get('droppedRecords') == 0 and x.get('writeFailures') == 0 for x in hits))
        shots = [r for r in rows if r.get('type') == 'shot']
        check(group, 'command, three tracers, a stop and the updates after both own shots recorded',
              sorted(r.get('event') for r in shots) == ['command', 'gunAfterShot', 'gunAfterShot', 'stop', 'tracer', 'tracer', 'tracer'],
              sorted(r.get('event') for r in shots))
        own = [r for r in shots if r.get('event') == 'tracer' and r.get('own')]
        after = [r for r in shots if r.get('event') == 'gunAfterShot']
        if own and after:
            ups = after[0].get('updates') or []
            check(group, 'gunAfterShot: the own tracer, the first two updates after it (BACKLOG 28 step 2)',
                  after[0].get('tracerId') == own[0].get('id') and [u.get('origin') for u in ups] == [[1.0, 1.0, 0.0], [2.0, 1.0, 0.0]]
                  and [u.get('dispersionAngle') for u in ups] == [0.004, 0.006],
                  (after[0].get('tracerId'), own[0].get('id'), [u.get('origin') for u in ups]))
            last = after[-1].get('updates') or []
            check(group, 'leaving the battle mid-wait writes the last own shot with the one update that came',
                  len(after) == 2 and after[-1].get('tracerId') == own[-1].get('id') and [u.get('origin') for u in last] == [[4.0, 1.0, 0.0]],
                  (len(after), after[-1].get('tracerId'), own[-1].get('id'), [u.get('origin') for u in last]))
            check(group, 'the own tracer keeps the update before it as lastServerGunUpdate',
                  ((own[0].get('aimAtTracer') or {}).get('lastServerGunUpdate') or {}).get('origin') == [0.0, 1.0, 0.0],
                  (own[0].get('aimAtTracer') or {}).get('lastServerGunUpdate'))
        crits = [r for r in rows if r.get('type') == 'crit']
        check(group, 'the hit direction, the fire tick, three ram ticks, the destroying shot and ONE ram contact recorded (a shot that leaves HP: none)',
              sorted(r.get('event') for r in crits) == ['collision', 'health', 'health', 'health', 'health', 'health', 'hitDirection'],
              sorted(r.get('event') for r in crits))
        shots = [r for r in crits if r.get('event') == 'health' and r.get('attackReasonId') == 0]
        check(group, 'the destroying shot: reason 0, its HP before and after, on the vehicle it destroyed',
              [(r.get('vehicleId'), r.get('oldHealth'), r.get('newHealth'), r.get('attackerId')) for r in shots] == [(battle.ally, 500, -1, battle.enemy)],
              shots)
        contact = [r for r in crits if r.get('event') == 'collision']
        if contact:
            c, sides = contact[0], contact[0].get('sides') or []
            by = dict((x.get('vehicleId'), x) for x in sides)
            mine = by.get(battle.me) or {}
            check(group, 'ram contact: both vehicles, the point in each chassis frame, the parts pose, turret and gun',
                  c.get('pair') == sorted([battle.me, battle.enemy]) and set(by) == set([battle.me, battle.enemy])
                  and [round(x, 6) for x in mine.get('local') or ()] == [-1.0, 0.5, 2.0] and [p.get('id') for p in mine.get('parts') or []] == [0, 1, 2, 3]
                  and all(len(p.get('transform') or ()) == 16 for p in mine.get('parts') or []) and mine.get('aim') == [0.2, 0.3]
                  and c.get('source') == 'client physics' and isinstance(c.get('at'), float), c)
            check(group, 'ram contact: the speed toward the point and the closing speed',
                  all(isinstance(x.get('approach'), float) for x in sides) and c.get('closingSpeed') is not None,
                  [(x.get('vehicleId'), x.get('approach')) for x in sides])

    # ---- log --------------------------------------------------------------------------------------------
    errors = [r for r in capture.records if r.levelno >= logging.ERROR]
    check('log', 'no ERROR logged', not errors,
          '; '.join('%s%s' % (r.getMessage(), ' [%s]' % r.exc_info[1] if r.exc_info else '') for r in errors[:5]))
    expected = ('Client version unavailable',)
    warnings = [r.getMessage() for r in capture.records if r.levelno == logging.WARNING
                and not r.getMessage().startswith(expected)]
    if warnings: note('warnings logged: ' + '; '.join(sorted(set(warnings))))
    failures = sorted(set(r.getMessage() for r in capture.records if r.levelno == logging.DEBUG
                          and ('unavailable' in r.getMessage() or 'skipped' in r.getMessage())))
    if failures: note('hook callbacks that failed (DEBUG): ' + '; '.join(failures))
    return mod


def main():
    started = time.time()
    temp = tempfile.mkdtemp(prefix='bullba-rec27-')
    home = os.getcwd()
    crashed = None
    try:
        run(temp)
    except Exception:
        crashed = traceback.format_exc()
    finally:
        os.chdir(home)
        shutil.rmtree(temp, ignore_errors=True)
    failed = [c for c in checks if not c[2]]
    lines = ['recorder two battles: %d checks, %d failed (%.1f s)' % (len(checks), len(failed) + bool(crashed),
                                                                       time.time() - started)]
    for group, name, ok, detail in failed:
        lines.append('FAIL [%s] %s%s' % (group, name, (' -- %s' % (detail,)) if detail not in ('', None) else ''))
    if crashed: lines.append('FAIL [run] the script crashed:\n' + crashed)
    for text in notes: lines.append('note: ' + text)
    code = 1 if failed or crashed else 0
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text.encode('utf-8') if isinstance(text, unicode) else text)
    else:
        sys.stdout.write(text)
    return code


# Run as a script (run27.py execs it as __main__); imported, it only lends its stubs and fixtures
# (tests/py27/recorder_roster_death.py).
if __name__ == '__main__':
    main()
