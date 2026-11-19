# -*- coding: utf-8 -*-
"""The client's own box of each collision model, kept in the shared store as a resource -> box table, so the replay page
decodes a hit point on the box the client decoded it on (DamageFromShotDecoder.parseHitPoint: decodeSegment in
collisions.getBoundingBox(part)). That box differs from the collision mesh's vertex box in 25 of 79 models, by up to 0.81 m
(WoT-Base KNOWLEDGE-client, the part box entry); the page takes the vertex box, marked approximate, only for a model the
table lacks.

    Harvest()            one pass over the client's cached vehicle types; step() on the game thread outside battle
                         (mod_local_armor_inspector.harvest_boxes, after the hangar loads)
    Table(path, client)  CFG/data/playback/boxes.js: load / merge / save, one client version per file (the export thread:
                         Exporter.store_part_boxes; read by playback.Job for a battle with no stored part boxes)

    boxes.js   ArmorInspectorData.receive(["boxes", {"format": 1, "client": <version>,
                                                     "boxes": {<collision model resource>: [lo x, y, z, hi x, y, z]}}]);

Where the box is (client bytecode, NA 2.4.1.1, read only):
  - model_assembler.setupCollisions(typeDescriptor, collisions), called by CommonTankAppearance._connectCollider for every
    vehicle the client builds (battle, replay playback), stores collisions.getBoundingBox(part) on the hit tester of the
    descriptor's chassis, hull, turret and gun (component.hitTester = hitTesterManager.activeHitTester) and of each
    chassis.trackPairs[1:]. The hangar's HangarVehicleAppearance has its own _connectCollider without it: the hangar sets
    no box. ModelHitTester.bbox is None from __init__ until then (loadBspModel, the only other writer, runs on the cell
    app and the editor only).
  - A descriptor's components are the type's own objects: VehicleDescriptor.__initFromCompactDescr takes chassis, turrets
    and guns from g_cache.vehicle(nation, id) by id (_descrByID) and the hull from type.hulls (selectBestHull);
    battleModifiers.getVehicleModification returns the type itself. So the box lands on the cached type, shared by every
    descriptor of it, and g_cache keeps every type it read for the session (Cache.__vehicles: only vehicle() adds to it,
    nothing removes). Reading g_cache.getVehicles() after the battle sees every box set this session; the live vehicles
    of an arena add nothing to it, and they are gone outside battle.
  - A box is read under the hit tester's own model name (bspModelName = the XML's collisionModelClient, the resource of
    vehicles.parts), both the normal and the crashed hit tester of a part (a wreck is built on the crashed model).
  - A zero box is dropped (Bullba Hits' playback.part_boxes: 33 zero boxes on turret / gun models among the real ones):
    prepareCollisionAssembler leaves turret and gun out of a vehicle whose turret is detached, setupCollisions still asks
    their box - so such a build overwrites the type's real box with an empty one until the next build. The table keeps
    the real box it read earlier; a harvest after each battle catches the boxes between such builds.

Carried over 19.11.2026 from the stopped side project C:/Projects/Bullba-Replays (src/bullba_replays/boxes.py, commit
fa382c3); its file store replaced by Bullba Hits' own data files (exporter.write_data / read_data_file).
Python 2.7 and 3; the game only through guarded imports (items.vehicles, BigWorld).
"""
from __future__ import absolute_import
import time


FORMAT = 1
KEY = 'boxes'
FILE = 'boxes.js'
MIN_EXTENT = 1e-6        # the extent below which a box is empty (playback.part_boxes)
LIMIT = 1e4              # metres: a coordinate beyond it is no box of a vehicle part
BUDGET = 0.004           # seconds of one step


def valid(box):
    """A box worth keeping: six finite numbers, every extent above MIN_EXTENT (NaN fails the comparison)."""
    try:
        return (len(box) == 6 and all(-LIMIT < float(v) < LIMIT for v in box)
                and all(float(box[3 + j]) - float(box[j]) > MIN_EXTENT for j in range(3)))
    except (TypeError, ValueError):
        return False


def box_of(hit_tester):
    """[lo x, y, z, hi x, y, z] of a hit tester's bbox (a pair of Math.Vector3), None when it has none or it is empty."""
    try:
        box = getattr(hit_tester, 'bbox', None)
        if not box:
            return None
        lo, hi = box[0], box[1]
        out = [float(lo[0]), float(lo[1]), float(lo[2]), float(hi[0]), float(hi[1]), float(hi[2])]
    except Exception:
        return None
    return out if valid(out) else None


def hit_testers(component):
    """The normal and the crashed hit tester of a component (HitTesterManager.modelHitTester, crashedModelHitTester)."""
    manager = getattr(component, 'hitTesterManager', None)
    out = []
    if manager is None:
        return out
    for name in ('modelHitTester', 'crashedModelHitTester'):
        try:
            tester = getattr(manager, name)
        except Exception:
            tester = None
        if tester is not None and all(tester is not t for t in out):
            out.append(tester)
    return out


def type_components(vehicle_type):
    """Every component of a VehicleType that carries a collision model: each chassis and its track pairs, each hull
    (type.hulls: the default and its variants), each turret of each slot and each of its guns."""
    out = []
    for chassis in getattr(vehicle_type, 'chassis', None) or ():
        out.append(chassis)
        out.extend(getattr(chassis, 'trackPairs', None) or ())
    out.extend(getattr(vehicle_type, 'hulls', None) or ())
    for slot in getattr(vehicle_type, 'turrets', None) or ():
        for turret in slot:
            out.append(turret)
            out.extend(getattr(turret, 'guns', None) or ())
    return out


def cached_types():
    """The vehicle types the client read this session (items.vehicles.g_cache.getVehicles()); [] outside the client."""
    try:
        from items import vehicles
    except ImportError:
        return []
    return list(vehicles.g_cache.getVehicles())


def in_battle():
    """Whether the player is an avatar (a battle or a replay is playing): no harvest then (W10)."""
    try:
        import BigWorld
    except ImportError:
        return False
    try:
        return type(BigWorld.player()).__name__ == 'PlayerAvatar'
    except Exception:
        return False


class Harvest(object):
    """One pass over the client's cached vehicle types. step() reads types until its budget is spent (at least one) and
    returns None while types remain, then the boxes {resource: box}; in battle it does nothing and returns None.

        job = Harvest()
        while job.step() is None: ...yield to the game...
        job.boxes, job.errors ([(type name, text)]), job.types (types read), job.conflicts (one model, two boxes)

    `types` replaces the client's cache (tests); `clock` the timer."""

    def __init__(self, types=None, budget=BUDGET, clock=None):
        self._types = list(types) if types is not None else None
        self.budget = budget
        self.clock = clock or getattr(time, 'perf_counter', None) or time.clock
        self.boxes = {}
        self.errors = []
        self.types = 0
        self.conflicts = 0
        self.finished = False
        self._at = 0

    def _read(self, vehicle_type):
        found = {}
        for component in type_components(vehicle_type):
            for tester in hit_testers(component):
                box = box_of(tester)
                if box is None:
                    continue
                resource = getattr(tester, 'bspModelName', None)
                if resource:
                    found[str(resource)] = box
        for resource, box in found.items():     # a type that fails midway gives nothing
            if resource in self.boxes and self.boxes[resource] != box:
                self.conflicts += 1
            self.boxes[resource] = box

    def step(self, budget=None):
        if self.finished:
            return self.boxes
        if in_battle():
            return None
        if self._types is None:
            try:
                self._types = cached_types()
            except Exception as e:
                self.errors.append(('g_cache', '%s: %s' % (type(e).__name__, e)))
                self._types = []
        budget = self.budget if budget is None else budget
        start = self.clock()
        while self._at < len(self._types):
            vehicle_type = self._types[self._at]
            self._at += 1
            try:
                self._read(vehicle_type)
                self.types += 1
            except Exception as e:      # one type the client cannot walk does not stop the others
                self.errors.append((str(getattr(vehicle_type, 'name', '?')), '%s: %s' % (type(e).__name__, e)))
            if self.clock() - start >= budget:
                break
        if self._at < len(self._types):
            return None
        self.finished = True
        return self.boxes


class Table(object):
    """The store's boxes.js of one client version: {resource: box}. A file of another client or format is not read: a
    new client starts a new table (a box belongs to the model file, which an update may change under the same name).

        table = Table(os.path.join(common_dir, FILE), client)
        table.load()                    -> boxes read
        table.merge(job.boxes)          -> (added, changed)
        table.save()                    -> bytes written; the file's boxes of this client written meanwhile are kept"""

    def __init__(self, path, client):
        self.path = path
        self.client = client
        self.boxes = {}

    def _disk(self):
        value = read_file(self.path)
        if not isinstance(value, dict):
            return {}
        if value.get('format') != FORMAT or value.get('client') != self.client or not isinstance(value.get('boxes'), dict):
            return {}
        return dict((str(k), [float(x) for x in v]) for k, v in value['boxes'].items() if valid(v))

    def load(self):
        disk = self._disk()
        disk.update(self.boxes)
        self.boxes = disk
        return len(self.boxes)

    def merge(self, boxes):
        added = changed = 0
        for resource, box in (boxes or {}).items():
            if not resource or not valid(box):
                continue
            box = [float(x) for x in box]
            old = self.boxes.get(resource)
            if old is None:
                added += 1
            elif old != box:
                changed += 1
            self.boxes[str(resource)] = box
        return added, changed

    def get(self, resource):
        return self.boxes.get(resource)

    def save(self):
        disk = self._disk()
        disk.update(self.boxes)
        self.boxes = disk
        value = {'format': FORMAT, 'client': self.client, 'boxes': self.boxes}
        from .exporter import write_data
        import os
        if not os.path.isdir(os.path.dirname(self.path)): os.makedirs(os.path.dirname(self.path))
        return write_data(self.path, KEY, value)


def read_file(path):
    """{format, client, boxes} of a boxes.js, None when it is missing or not one."""
    import os
    if not os.path.isfile(path): return None
    try:
        from .exporter import read_data_file
        value = read_data_file(path)
    except Exception:
        return None
    return value if isinstance(value, dict) else None
