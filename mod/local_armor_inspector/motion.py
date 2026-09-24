# -*- coding: utf-8 -*-
"""Motion history of every shooter, sampled at a fixed low rate.

Why this exists (owner's decision 22.09, docs/BACKLOG.md row 28): the server sends no dispersion
angle for anybody but the player, yet it does send every vehicle's position, speed and packed gun
angles about ten times a second. With that history an offline script can rebuild the aiming circle
a shooter really had at the moment he fired and compare it with the tracer he actually produced.
Nothing here computes a circle and nothing here is written per sample: the sampler only remembers
the last few seconds in memory, and a copy of that memory rides on the two records that can ever
use it - the player's own tracer and a hit on the player's own vehicle.

Load: one BigWorld callback every PERIOD seconds, a bounded number of entity reads per tick (the
arena roster, at most thirty), and one small list per vehicle per tick. There is no per-frame work,
no hook, no subscription and no descriptor work - every value below is one the client already holds.
Since 24.09 the same loop hands each vehicle in view to Recorder.note_vehicle (its type name and
Vehicle.maxHealth for the roster), which costs a tuple and a lookup unless the vehicle is new or changed.

Client contract (read from the installed bytecode of 2.4.0.1, no game launch):

* ``Vehicle.speedInfo`` is a ``_VehicleSpeedProvider`` bound in ``Vehicle.__startWGPhysics`` to
  ``self.filter.speedInfo``; ``__startWGPhysics`` runs unconditionally in
  ``Vehicle.__onActivateAppearance``, so the value is there for EVERY started vehicle, not only the
  player's. ``speedInfo.value`` is the four-tuple the client's own ``getOwnVehicleSpeeds`` reads:
  index 0/1 are the smoothed pair and 2/3 the INSTANTANEOUS speed and hull rotation speed - the two
  the dispersion formula uses (docs/KNOWLEDGE.md section 6). ``CustomEffectManager.update`` reads
  the very same ``vehicle.speedInfo.value`` for any vehicle it decorates.
* ``Vehicle.getServerGunAngles()`` returns ``decodeGunAngles(self.gunAnglesPacked,
  self.typeDescriptor.gun.pitchLimits['absolute'])`` - turret yaw relative to the hull and gun
  pitch, exactly as the server packed them: yaw in 10 bits over the full circle (step 2*pi/1024 =
  0.35 deg) and pitch in 6 bits over the gun's absolute limits (step (max-min)/63). That is the
  resolution of every foreign angle here, and no rounding below is finer than it.
* For the player's own vehicle the client keeps the true float in ``PlayerAvatar.gunRotator``
  (properties ``turretYaw`` and ``gunPitch``), so his own samples are not quantised.
* ``Math.Matrix(vehicle.matrix).yaw`` is how the client itself takes a vehicle's hull yaw
  (``vehicles_selection_mode._CameraManager.__locateCameraOnAllVehicles``).
* ``Vehicle.isAlive()`` is ``isCrewActive and health > 0``; ``isStarted`` is the flag the client's
  own ``getOwnVehicleSpeeds`` checks before trusting ``speedInfo``.

A vehicle that does not answer one of these reads is skipped for that tick. Nothing is defaulted:
an unstarted entity's speed provider still reads as a stationary vehicle, which would be a guess.
"""
from __future__ import absolute_import
import logging
from collections import deque

LOG = logging.getLogger('local.armor_inspector')

# 5 Hz: the server itself moves these values about ten times a second, so a faster sampler would
# only copy the client's interpolation, and a slower one would miss a turret starting to swing.
PERIOD = 0.2
# Six seconds of history. The dispersion terms that matter (hull movement, hull rotation, turret
# rotation, the after-shot penalty) all decay inside a few seconds of full aiming time.
DEPTH = 30
# The layout of one sample. Written into every attached buffer so the offline reader never guesses.
FIELDS = ['gameTime', 'x', 'y', 'z', 'speed', 'hullYawRate', 'hullYaw', 'turretYaw', 'gunPitch']
# How many ticks without an arena before the loop gives up on its own. The battle hooks stop it
# normally; this is only the guard for a stop that never arrived.
IDLE_LIMIT = 25


class MotionSampler(object):
    """The last few seconds of every vehicle's movement, in memory only."""

    def __init__(self, recorder):
        self.recorder = recorder
        # vehicle id -> deque of samples. Bounded by the roster and by DEPTH.
        self.buffers = {}
        self.handle = None
        self.running = False
        self.idle = 0
        self.arena = None
        # Math.Matrix, bound on the first tick: the module exists in the game only.
        self.matrix = None

    def start(self):
        """Begin sampling this battle. Called when the avatar becomes the player."""
        if self.running:
            return
        self.running = True
        self.idle = 0
        self.arena = None
        self.buffers = {}
        self.arm()

    def arm(self):
        try:
            self.handle = self.recorder.bw.callback(PERIOD, self.tick)
        except Exception:
            self.running = False
            self.handle = None
            LOG.exception('Motion sampler unavailable; recording continues')

    def stop(self):
        """End sampling. Called when the avatar stops being the player, and from fini()."""
        self.running = False
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                self.recorder.bw.cancelCallback(handle)
            except Exception:
                LOG.debug('Motion sampler callback could not be cancelled', exc_info=True)
        self.buffers = {}
        self.matrix = None

    def tick(self):
        self.handle = None
        if not self.running:
            return
        try:
            self.sample()
        except Exception:
            LOG.debug('Motion sample skipped', exc_info=True)
        if self.running:
            self.arm()

    def sample(self):
        """One tick: the values the client already holds for every alive vehicle of the roster."""
        bw = self.recorder.bw
        player = bw.player()
        # The very same gate the shot telemetry uses - Recorder.recording: recorder enabled, an arena, not a
        # replay and not an observer - so the sampler can never run where the telemetry would not record.
        if player is None or not self.recorder.telemetry.active(player):
            self.idle += 1
            if self.idle > IDLE_LIMIT:
                self.running = False
            return
        self.idle = 0
        arena = player.arena
        identity = str(arena.arenaUniqueID)
        if identity != self.arena:
            self.arena = identity
            self.buffers = {}
        matrix = self.matrix
        if matrix is None:
            import Math
            matrix = self.matrix = Math.Matrix
        now = round(float(bw.serverTime()), 3)
        own = getattr(player, 'playerVehicleID', None)
        rotator = getattr(player, 'gunRotator', None)
        entity = bw.entity
        buffers = self.buffers
        # The roster's owner hears of every vehicle in view here (24.09): its type and the server's maximum health
        # go into its roster row. This loop already visits each of them; the call costs a tuple and a lookup
        # unless the vehicle is new or changed. A wreck too - its figure still names the vehicle that was hit.
        # One roster record for the whole pass, written after the loop, and only when a vehicle told something new.
        note = getattr(self.recorder, 'note_vehicle', None)
        noted = False
        for vehicle_id in list(getattr(arena, 'vehicles', {}).keys()):
            try:
                vehicle = entity(vehicle_id)
                if vehicle is None or not vehicle.isStarted:
                    continue
                if note is not None and note(player, vehicle): noted = True
                if not vehicle.isAlive():
                    continue
                if vehicle_id == own and rotator is not None:
                    # His own angles are the client's own floats, not the packed server pair.
                    turret_yaw, gun_pitch = rotator.turretYaw, rotator.gunPitch
                else:
                    turret_yaw, gun_pitch = vehicle.getServerGunAngles()
                position = vehicle.position
                speeds = vehicle.speedInfo.value
                sample = [now,
                          round(position.x, 2), round(position.y, 2), round(position.z, 2),
                          round(speeds[2], 3), round(speeds[3], 4),
                          round(matrix(vehicle.matrix).yaw, 4),
                          round(turret_yaw, 4), round(gun_pitch, 4)]
                # One pass for a NaN or an infinity anywhere in the sample: either would make the
                # writer's json.dumps(allow_nan=False) throw away the whole record it rides on.
                total = sum(sample)
                if total - total != 0:
                    continue
            except Exception:
                # A vehicle outside the area of interest, one whose appearance has not activated
                # and one the client has no entity for are all simply not sampled this tick.
                continue
            buffer = buffers.get(vehicle_id)
            if buffer is None:
                buffer = buffers[vehicle_id] = deque(maxlen=DEPTH)
            buffer.append(sample)
        if noted:
            try: self.recorder.note_roster(arena, player)
            except Exception: LOG.debug('Roster record skipped', exc_info=True)

    def history(self, vehicle_id):
        """A copy of one shooter's recent motion, or None when nothing was sampled for him.

        The samples themselves are never mutated after they are appended, so the list is a plain
        copy of the deque and the writer thread may serialise it while the next tick appends.
        """
        buffer = self.buffers.get(vehicle_id)
        if not buffer:
            return None
        return {'fields': FIELDS, 'samples': list(buffer)}
