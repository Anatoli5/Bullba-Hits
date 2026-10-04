# -*- coding: utf-8 -*-
"""Produce ordinary local HTML + classic-script data. No sockets or processes.

Runs only on the recorder's worker thread. Game objects and ResMgr are never used.
JSONL is authoritative; every file written here can be regenerated from it and
the matching client resources. Models are retained across game updates.
"""
from __future__ import absolute_import
import copy
import glob
import hashlib
import io
import json
import marshal
import logging
import math
import numbers
import os
import re
import struct
import sys
import threading
import time
import zipfile
import zlib
import xml.etree.ElementTree as ET
from collections import OrderedDict
from .geometry import extract
from .armor import ArmorCatalog
from .records import RecordDecoder, pack_battle, stamp_snapshot, unpack_battle
from .telemetry import mechanics_params
from .crit_tie import attach_crits, moves_tie
from .damage_log import damage_log
from .client_snapshot import ClientSnapshot, version_label
from .client_code import CODE_MODULES, SHARED_DATA, TEXT_DOMAINS
from . import client_code as _client_code
from .client_objects import Objects
# The types whose output on the offline stand changed between the previous client and this one (tools/client_code_set.py:
# the stand built every type for both; hashes only): rebuilt once whatever their keys say (BACKLOG 55, second review C2).
STAND_CHANGED = tuple(getattr(_client_code, 'STAND_CHANGED', ()))
STAND_CLIENT = getattr(_client_code, 'STAND_CLIENT', None)

LOG = logging.getLogger('local.armor_inspector')
VERSION = '0.9.6'
RESOURCE = re.compile(r'^(?:[A-Za-z0-9_-]+/)?vehicles/[A-Za-z0-9_/-]+\.(?:model|havok)\Z')
IDENTIFIER = re.compile(r'^[-a-zA-Z0-9_]{1,100}\Z')
# The interface icons of the aim configuration (equipment, perks, shells) ship with the page in web/icons
# (user, 20.09): they are interface art, not game data, and a fresh install must look right before the
# first game start. Until 0.7.15 they were unpacked from the client's gui packages on a game start.
ICON_FILES = tuple('web/icons/%s.png' % name for name in (
    # Optional devices, the empty slot and the consumables
    'aimingStabilizer', 'empty_slot', 'enhancedAimDrives', 'excellentFuel',
    'improvedRotationMechanism', 'improvedSights', 'improvedVentilation', 'modernizedAimDrivesAimingStabilizer',
    'modernizedImprovedSightsEnhancedAimDrives', 'modernizedTurbochargerRotationMechanism', 'qualityFuel', 'rammer',
    'ration', 'turbocharger',
    # The grade badges the garage lays over a device icon: every grade shares one picture,
    # so the badge is the only thing that tells them apart (21.09)
    'grade_bounty_up', 'grade_experimental1', 'grade_experimental2', 'grade_experimental3',
    'grade_improved',
    # Crew skills and perks
    'brotherhood', 'commander_coordination', 'commander_emergency', 'commander_holdLine',
    'commander_staySharp', 'driver_bulletproof', 'driver_smoothDriving', 'driver_virtuoso',
    'gunner_armorer', 'gunner_focus', 'gunner_loneWolf', 'gunner_quickAiming',
    'gunner_smoothTurret', 'loader_desperado', 'loader_magMastery', 'loader_melee',
    'loader_secondChance', 'radioman_expert', 'radioman_sideBySide',
    # Directives
    'aimingStabilizerBattleBooster', 'enhancedAimDrivesBattleBooster', 'improvedSightsBattleBooster', 'improvedVentilationBattleBooster',
    'rammerBattleBooster', 'smoothDrivingBattleBooster', 'smoothTurretBattleBooster', 'virtuosoBattleBooster',
    # Shell types, for the gun panel
    'ARMOR_PIERCING', 'ARMOR_PIERCING_CR', 'ARMOR_PIERCING_CR_PREMIUM', 'ARMOR_PIERCING_PREMIUM',
    'HIGH_EXPLOSIVE', 'HIGH_EXPLOSIVE_MODERN', 'HIGH_EXPLOSIVE_MODERN_PREMIUM', 'HIGH_EXPLOSIVE_PREMIUM',
    'HOLLOW_CHARGE', 'HOLLOW_CHARGE_PREMIUM',
    # The Config pieces that do not shoot (0.7.28) - their art was never shipped until 23.09 (copied by
    # tools/build_equipment_catalogue.py copy_config_icons): devices, directives, crew skills, the paint
    'additInvisibilityDeviceBattleBooster', 'additionalInvisibilityDevice', 'antifragmentationLining', 'camouflage',
    'camouflageNet', 'coatedOptics', 'coatedOpticsBattleBooster', 'commander_eagleEye', 'commandersView',
    'driver_badRoadsKing', 'driver_motorExpert', 'extraHealthReserve', 'grousers', 'improvedConfiguration',
    'improvedRadioCommunication', 'modernizedExtraHealthReserveAntifragmentationLining', 'radioman_finder',
    'stereoscope', 'turbochargerBattleBooster',
    # The consumables that move no characteristic (26.09: three slots, any consumable of the game)
    'afterburning', 'autoExtinguishers', 'handExtinguishers', 'largeMedkit', 'largeRepairkit', 'removedRpmLimiter',
    'smallMedkit', 'smallRepairkit',
    # Field modification (23.09): the garage's own art, copied by tools/build_equipment_catalogue.py - a pair
    # side's icon, and the level's hexagon for a standard modification
    'fm_additionalGrousers', 'fm_betterFriction', 'fm_improvedAimingHandling', 'fm_improvedCamouflage',
    'fm_improvedChassisDurability', 'fm_improvedChassisStability', 'fm_improvedEnginePower', 'fm_improvedGunBreech',
    'fm_improvedLightFilters', 'fm_improvedMuzzleBreak', 'fm_improvedObservationDevice', 'fm_improvedProjectileRifling',
    'fm_improvedReflexScopes', 'fm_improvedScope', 'fm_improvedSelfRepairingTracks', 'fm_improvedSelfRepairingWheels',
    'fm_improvedSharpnessVisor', 'fm_improvedSpallingResistance', 'fm_improvedSpeedIndicator',
    'fm_improvedSpeedIndicatorBackwards', 'fm_improvedTurretRingStability', 'fm_improvedTurretTurningWheels',
    'fm_increasedSensitivityOptics', 'fm_increasedThickness', 'fm_reinforcedInteriorModules', 'fm_reinforcedStructure',
    'fm_level_2', 'fm_level_4', 'fm_level_5', 'fm_level_7', 'fm_level_8'))
# The client's own 16 px icons of damaged modules and injured crew for the hit tiles (22.09), and the battle damage
# log's own 16 px icons of the damage source (25.09: a generic crit, fire, ram, a fall, a strike ...; the plain one for
# damage the player dealt, *_enemy for damage he took - web/crits.js picks them). tools/extract_crit_icons.py copies
# them out of the installed client (the damage-log ones cut out of battleAtlas.dds) and writes exactly this list
# (tools/check.py compares the two): the user runs it once before a build, and tools/build.py stops with its name
# while one is missing.
CRIT_ICON_FILES = tuple('web/icons/crits/%s.png' % name for name in (
    'engineCriticalSmall', 'engineDestroyedSmall', 'ammoBayCriticalSmall', 'ammoBayDestroyedSmall',
    'fuelTankCriticalSmall', 'fuelTankDestroyedSmall', 'radioCriticalSmall', 'radioDestroyedSmall',
    'trackCriticalSmall', 'trackDestroyedSmall', 'wheelCriticalSmall', 'wheelDestroyedSmall',
    'gunCriticalSmall', 'gunDestroyedSmall', 'turretRotatorCriticalSmall', 'turretRotatorDestroyedSmall',
    'surveyingDeviceCriticalSmall', 'surveyingDeviceDestroyedSmall',
    'commanderDestroyedSmall', 'driverDestroyedSmall', 'radiomanDestroyedSmall', 'gunnerDestroyedSmall',
    'loaderDestroyedSmall')) + tuple('web/icons/crits/damageLog_%s_16x16.png' % name for name in (
    'critical', 'critical_enemy', 'fire', 'fire_enemy', 'ram', 'ram_enemy', 'damage', 'damage_enemy',
    'artillery_eq', 'artillery_eq_enemy', 'airstrike_eq', 'airstrike_eq_enemy', 'airstrike_enemy',
    'artillery', 'artillery_enemy', 'mine_field', 'by_mine_field', 'spawned_bot', 'by_spawned_bot', 'by_smoke',
    'berserker', 'corroding_shot', 'corroding_shot_enemy', 'fire_circle', 'fire_circle_enemy', 'cling_brander',
    'cling_brander_enemy', 'thunder_strike', 'thunder_strike_enemy', 'he_rocket', 'he_rocket_enemy'))
# web/modifiers.js is the Target modifier group beside the Collision model tile; the page has loaded it
# since 0.7.12 but the package never carried it, so the group silently stayed away (found 20.09).
# web/vehicle-modes.js (S3, 22.09) is the table of vehicle types this client lists for its event modes,
# generated by tools/build_vehicle_modes.py from the client's own extension packages.
# web/ttx.js (23.09) is the arithmetic of the characteristics panel; index.html loads it before app.js, and without it
# here the panel would stay hidden in the package the way the modifier group did.
ASSETS = ('Viewer.html', 'web/style.css', 'web/icon.svg', 'web/viewer.js',
          'web/local-data.js', 'web/frame.js', 'web/host.js', 'web/app.js', 'web/modifiers.js', 'web/equipment.js', 'web/vehicle-modes.js', 'web/ballistics.js', 'web/shot-telemetry.js', 'web/shot-context.js', 'web/crits.js', 'web/ttx.js', 'web/tooltips.js', 'web/screen-armor.js', 'web/vendor/three.min.js',
          'web/vendor/three.LICENSE', 'web/vendor/three-mesh-bvh.umd.js',
          # THIRD_PARTY.md ships with the page and points at these two: the packed-XML reader's licence and
          # the vendor manifest with the sources and hashes of three.js / three-mesh-bvh (inspection, 20.09).
          'web/vendor/three-mesh-bvh.LICENSE', 'web/vendor/manifest.json',
          'licenses/TagTools.txt', 'licenses/BattleHits.txt', 'licenses/TankInspector.txt') + ICON_FILES + CRIT_ICON_FILES


# Deferred work (0.7.11). Publishing a hit never reads a client package any more:
# the battle file is written at once and the collision models follow as jobs, one
# per idle tick, never during a battle and never while the page is being used.
PENDING = 'pending'
PACE = 0.3
TAIL_RECORD_BUDGET = 64
TAIL_TIME_BUDGET = 0.02
# A crit record that moves no tie (a fire tick, an explosion elsewhere: counts only) rides along with the next
# publish, and alone goes out at most this often, or at once on a battle switch and at the end.
QUIET_PUBLISH = 10.0
# Consecutive failed publications of one battle, other than a locked or unwritable output (EnvironmentError),
# after which that battle is passed over for the session: the same error on every retry is a fault in the data
# or the code, and retrying it held back every deferred job (EXP-01, second road; review F3, 24.09).
PUBLISH_GIVE_UP = 5
JOB_PAGE, JOB_PLAYER, JOB_OTHER, JOB_BULK = 0, 1, 2, 3
# Where a vehicle request came from decides its turn: the page is waiting for the
# one it asked for, the hangar vehicle is the player's own, a roster or the
# optional catalogue export is background work.
VEHICLE_PRIORITY = {'picker':JOB_PAGE, 'hangar':JOB_PLAYER, 'battle':JOB_BULK, 'catalogue':JOB_BULK}
# What a hit waits for when the vehicle XML of its type is not read yet and a battle is on (Exporter.type_extras): the
# key under which the prepared hits and the battles wait, like a model's key (invalidate_model, waiting).
EXTRAS_KEY = 'extras:'
# Which saved battles setup publishes again (startup-republish-slow, 27.09). Until 0.8.7 setup read and published every
# saved battle before anything else ran: 145 battles cost ~65 s of CPU offline and 8 min 22 s in the game on 27.09 (page
# open over a hit), and the wheel migration, the TTX sources and every job waited behind it. data/published.json keeps,
# per battle, what its derived file was built from: the stamp (DERIVED_FORMAT, the client version), the raw bytes read and
# the raw file's size, the derived file's size, its model references (and those whose model failed), whether it still
# waited for a model or the vehicle XML - or had a part the next start may do better - and its summary. Setup compares two
# file sizes a battle and one listing of data/models, and publishes again only those that differ - in the background, a
# 'battle' job after the vehicle migrations, in slices (BATTLE_SLICE) with the game's share of the time between two.
PUBLISHED_FILE = 'published.json'
# 2 (startup-review-fixes, 27.09): 'rawSize', 'absent', the stamp by DERIVED_FORMAT.
# BACKLOG 55 (02.10): the stamp is 'd<DERIVED_FORMAT>' alone - the client a battle was recorded with never changes, and a
# client update queued all 222 saved battles (296 s) to write 138 of 145 byte for byte again and to lose the fill-ins of the
# rest. An entry also names the client that recorded the battle and the one that built the file ('client', 'built': sha1[:16]
# of the version text) and the inputs its fill-ins read ('inputs': path -> 'crc:size'). An entry of 0.9.3 ('d1:<built
# under>') is current when the battle's own client built it (its raw header says), else it is repaired when it is opened.
# No battle is published at the start any more: one that is not current is 'stale' in the index; the page shows its file at
# once and asks for it ('prepareBattle' -> request_battle), and the mod prepares that one battle at the page's turn.
PUBLISHED_FORMAT = 2
PUBLISHED_LIMIT = 16*1024*1024
# The published state is written by the idle tick at most this often outside a battle (and at setup, at the end of the
# background publication and when the game closes): a state lost to a crash only costs those battles one more publish.
PUBLISHED_PAUSE = 30.0
# WHAT A DERIVED BATTLE FILE IS (startup-review-fixes, 27.09): raised whenever publish() writes anything different for the
# same raw battle - a field, a fix, an order. It stamps data/published.json instead of VERSION: a build that changes nothing
# of it no longer publishes every saved battle again (145 in the background after every build). tests/py27/derived_golden.py
# compares publish()'s output for a fixture battle with tests/golden/derived-battle-<N>.js and fails when it changes while
# this stays; after a raise it stores the new one beside the previous, which the page must still read
# (tests/test_derived_formats.cjs) until the background has published every battle again.
DERIVED_FORMAT = 1
# One slice of a saved battle's background publication (run_battle_job): lines of its raw file, then hits prepared, then the
# file written (~60 ms for the largest, 53 MB raw / 405 hits - the one part that does not split). Between two lines or hits
# the slice ends early for a battle, a drag, a command of the page or the mod closing; after it the game gets its share
# (SWEEP_SHARE) of the time the slice took, with no cap.
BATTLE_SLICE = 0.1
# A model failure that the next start cannot undo (the other failures - a package scan, a mod overriding the model, anything
# unexpected - leave the battle to be published again at the next start, 'waits').
PERMANENT_MODEL_ERRORS = ('Client version changed', 'Collision model not found in client')
# The background publication logs a battle of its own when it is this big or took this long (the rest are in the summary).
BATTLE_LOG_MB, BATTLE_LOG_WALL = 10.0, 5.0
LEGACY_STAMP = re.compile(r'^d(\d+):([0-9a-f]{16})\Z')
# What an armoured prefab's armour names come from besides the prefab and the vehicle XML (prefab_spec, material_kinds).
MATERIAL_KINDS = 'system/data/material_kinds.xml'
MATERIAL_KINDS_CODE = 'scripts/common/material_kinds.pyc'
# THE CODE A FILL-IN READS THROUGH (review #7, 02.10). The outer track pair and the wheels start from the compact descriptor,
# decoded by the client's items code with the nation's tables (list.xml, components/chassis.xml); the pair's armour names
# come from material_kinds. That code is the code set of the characteristics and vehicle files (Exporter.code_modules, BACKLOG
# 55: the modules the builds execute and those whose objects they name) - one rule for both: 2.4.0.2 changed only the crew's
# tankmen_components.pyc, which no build executes, so the repair of 02.10's battles stays open.


def nation_tables(type_name):
    """The nation's tables a compact descriptor of this type is decoded with: list.xml (type ids) and components/chassis.xml
    (chassis ids)."""
    nation = str(type_name or '').split(':', 1)[0]
    if not re.match(r'^[a-z]+\Z', nation): return []
    return ['scripts/item_defs/vehicles/%s/list.xml' % nation, 'scripts/item_defs/vehicles/%s/components/chassis.xml' % nation]


def version_hash(text):
    """The short hash a published entry names a client by ('client', 'built', the 0.9.3 stamp)."""
    return hashlib.sha1(canonical(text or '').encode('utf-8')).hexdigest()[:16]


def vehicle_xml(type_name):
    """The client path of a vehicle type's XML ('france:F108_X' -> scripts/item_defs/vehicles/france/F108_X.xml), or None."""
    if not re.match(r'^[a-z]+:[A-Za-z0-9_-]+\Z', str(type_name or '')): return None
    nation, name = str(type_name).split(':')
    return 'scripts/item_defs/vehicles/' + nation + '/' + name + '.xml'


def read_header(path):
    """The first line of a raw battle file when it is the battle's header (id, start, map, client), else None: one readline,
    no record decoded."""
    try:
        with open(path, 'rb') as stream: line = stream.readline(1024 * 1024 + 1)
        row = json.loads(line.decode('utf-8'))
        return row if isinstance(row, dict) and row.get('type') == 'battle' else None
    except Exception:
        return None



def canonical(version):
    return version.lstrip(u'\ufeff').replace('\r\n', '\n')


def job_key(kind, payload):
    """Identity of one queued job: a model is its resource, a vehicle its type.

    Two hits of the same vehicle want the same four models, and the hangar repeats
    its own vehicle: the queue holds one job per resource and per type, and a
    second request only raises the priority of the one already in it.
    """
    if kind == 'model':
        return ('model', payload[0])
    # 'battle' (a saved battle the page asked for, request_battle) is one job per battle.
    if kind == 'battle':
        return ('battle', str((payload or {}).get('battleId') or ''))
    # 'vehicle', 'ttx' (the characteristics file of a type) and 'extras' (Exporter.type_extras) are one job per type each.
    return (kind, str((payload or {}).get('vehicleType') or ''))


def model_key(resource, version):
    """The name of a model file before 0.9.4 (and of every model of a battle of another client): the version text and the
    resource. Such files stay as they are; Exporter.model_ref names the models of the running client by their content."""
    if not RESOURCE.match(resource) or '..' in resource:
        raise ValueError('Invalid collision resource')
    return hashlib.sha256((canonical(version)+'\n'+resource).encode('utf-8')).hexdigest()


# WHAT A MODEL FILE IS (BACKLOG 55, 02.10): raised whenever geometry.extract, havok.py or model_document writes anything
# different for the same .havok. It is in every model's name (model_content_key) and, from 2 on, in the file itself ('format';
# a file without it is of format 1): a model file of another format is never taken over (Exporter.adopt_model) nor counted the
# same part of a vehicle file (model_identity), so a raise exports each model again as it is next needed and writes the vehicle
# files that refer to it again. tests/py27/havok_lazy.py compares the files of eight client models with
# tests/golden/havok-models.json and fails when they change while this stays (or when it is raised without a change).
MODEL_FILE_FORMAT = 1


def model_content_key(havok, crc, size):
    """The name of a model file by what it is made of (BACKLOG 55): its .havok's path, CRC-32 and size in the client's
    packages, and MODEL_FILE_FORMAT - no client version. The same file in the next client is the same model."""
    return hashlib.sha256(('model-file %d\n%s\n%s\n%d' % (MODEL_FILE_FORMAT, havok, crc, int(size))).encode('utf-8')).hexdigest()


def model_document(data, havok):
    """What a model file holds (the one writer: Exporter.model_extract, and tests/py27/havok_lazy.py's golden): the shot
    collision of the .havok's bytes, the .havok's path and sha256, and MODEL_FILE_FORMAT from 2 on (format 1 files have none,
    so they stay byte for byte what 0.9.3 wrote)."""
    model = extract(data)
    model.update({'resource': havok, 'sha256': hashlib.sha256(data).hexdigest()})
    if MODEL_FILE_FORMAT != 1: model['format'] = MODEL_FILE_FORMAT
    return model


def code_identity(code):
    """What a client module's code does, without where it stands (BACKLOG 55): sha1 of every code object's bytecode, constants
    (a nested code object by its own identity), names, variable, free and cell names, argument count, flags and name - not the
    file name, the first line or the line table. A module moved down a few lines keeps it; a changed function changes it
    (measured on the client's 8642 .pyc: 1.7 s for all on its python27; outputs/rebuild-code-identity-2026-10-02.md)."""
    digest = hashlib.sha1()
    digest.update(code.co_code)
    for value in code.co_consts:
        if isinstance(value, type(code)): digest.update(b'C' + code_identity(value).encode('ascii'))
        else: digest.update(('K%r%r' % (type(value), value)).encode('utf-8', 'replace'))
    for names in (code.co_names, code.co_varnames, code.co_freevars, code.co_cellvars):
        digest.update(('|' + ','.join(names)).encode('utf-8', 'replace'))
    digest.update(('|%d|%d|%d|%s' % (code.co_argcount, code.co_flags, code.co_nlocals, code.co_name)).encode('utf-8', 'replace'))
    return digest.hexdigest()


def crc_text(entry):
    """'%08x:size' of a snapshot entry, '-' for none, '?' for an unknown CRC."""
    return '-' if entry is None else '?' if entry[0] < 0 else '%08x:%d' % entry


def atomic_write(path, data):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder): os.makedirs(folder)
    temp = path + '.tmp'
    with open(temp, 'wb') as stream: stream.write(data)
    if hasattr(os, 'replace'):
        os.replace(temp, path)
    elif os.name == 'nt':
        # The client does not ship _ctypes or os.replace. Retain the last good
        # file until rename succeeds; JSONL also permits rebuilding after exit.
        previous = path + '.previous'
        if os.path.isfile(path):
            if os.path.isfile(previous): os.remove(previous)
            os.rename(path, previous)
        try:
            os.rename(temp, path)
        except Exception:
            if not os.path.isfile(path) and os.path.isfile(previous): os.rename(previous, path)
            raise
        if os.path.isfile(previous): os.remove(previous)
    else:
        os.rename(temp, path)


MODEL_LIMIT = 32*1024*1024
PACKAGE_RESCAN_PAUSE = 300
ZIP_LOCAL_HEADER = struct.Struct('<4sHHHHHIIIHH')


ZIP_END = struct.Struct('<4s4H2LH')


def zip_directory(path):
    """The raw central directory of a zip (a package), or None when it cannot be found simply (a comment longer than
    64 KB, zip64): the caller then parses the package as usual. Read-only, one seek and one read."""
    with open(path, 'rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        tail_size = min(size, 65536 + ZIP_END.size)
        stream.seek(size - tail_size)
        tail = stream.read(tail_size)
        at = tail.rfind(b'PK')
        if at < 0 or at + ZIP_END.size > len(tail): return None
        fields = ZIP_END.unpack(tail[at:at + ZIP_END.size])
        length, offset = fields[5], fields[6]
        if length == 0xffffffff or offset == 0xffffffff or offset + length > size: return None
        stream.seek(offset)
        return stream.read(length)


# One central-directory record (PKZIP APPNOTE 4.3.12): signature, versions, flags, method, time, date, CRC-32, sizes,
# name/extra/comment lengths, disk, attributes, the local header's offset.
ZIP_ENTRY = struct.Struct('<4s6H3L5H2L')
COLLISION_MARK = b'/collision_client/'


def collision_members(path, mark=COLLISION_MARK, suffix='.havok'):
    """[(name, (header_offset, method, compressed, size, crc))] of the collision models (.havok) of one package, in the
    directory's order - the index zipfile gave, without building an object for every one of its ~20 000 entries: one
    C-level search of the raw central directory for the folder name, then the record around each hit (5 364 of 568 840
    entries in all the client's packages). A package with no such folder costs one search. None when the directory
    cannot be read that way or a record does not add up: the caller parses the package with zipfile instead.
    `mark` and `suffix` name other members the same way (the vehicles' prefabs, 27.09: PREFAB_ROOT, '.prefab')."""
    directory = zip_directory(path)
    if directory is None: return None
    found, end = [], len(directory)
    at = directory.find(mark)
    while at >= 0:
        # The record's own signature is the nearest one before its name: a name is text and holds none.
        start = directory.rfind(b'PK\x01\x02', max(0, at - ZIP_ENTRY.size - 1024), at)
        if start < 0 or start + ZIP_ENTRY.size > end: return None
        fields = ZIP_ENTRY.unpack_from(directory, start)
        name_end = start + ZIP_ENTRY.size + fields[10]
        if not start + ZIP_ENTRY.size <= at < name_end <= end: return None
        if 0xffffffff in (fields[8], fields[9], fields[16]): return None   # zip64: zipfile's own reading
        try:
            name = directory[start + ZIP_ENTRY.size:name_end].decode('ascii')
        except UnicodeDecodeError:
            name = ''
        if name.endswith(suffix): found.append((name, (fields[16], fields[4], fields[8], fields[9], fields[7])))
        at = directory.find(mark, name_end + fields[11] + fields[12])
    return found


def read_package_entry(path, name, entry):
    """One ZIP entry read at the offset its central-directory record gave.

    entry is (header_offset, compress_type, compress_size, file_size, CRC) as zipfile's own
    ZipInfo holds them. Every check zipfile makes on the way is made here too - the local
    header's signature, no encryption, the same file name, the length, the size and the CRC-32 -
    and any failure raises, so the caller can take the ordinary zipfile path instead.
    """
    offset, method, compressed, size, crc = entry
    with open(path, 'rb') as stream:
        stream.seek(offset)
        header = stream.read(ZIP_LOCAL_HEADER.size)
        if len(header) != ZIP_LOCAL_HEADER.size: raise ValueError('Truncated local header')
        fields = ZIP_LOCAL_HEADER.unpack(header)
        if fields[0] != b'PK\x03\x04': raise ValueError('Bad local header signature')
        if fields[2] & 1: raise ValueError('Encrypted entry')
        stored = stream.read(fields[9])
        if stored.decode('ascii', 'replace') != name: raise ValueError('Local header names another file')
        stream.seek(fields[10], 1)
        data = stream.read(compressed)
    if len(data) != compressed: raise ValueError('Truncated entry')
    if method == zipfile.ZIP_DEFLATED:
        inflate = zlib.decompressobj(-15)
        data = inflate.decompress(data) + inflate.flush()
    elif method != zipfile.ZIP_STORED:
        raise ValueError('Unsupported compression')
    if len(data) != size or (zlib.crc32(data) & 0xffffffff) != crc: raise ValueError('Entry CRC mismatch')
    return data


def same_as_member(path, info):
    """True when the file at path holds exactly the ZIP entry described by info (size and CRC-32)."""
    if not os.path.isfile(path) or os.path.getsize(path) != info.file_size: return False
    with open(path, 'rb') as stream:
        data = stream.read(info.file_size + 1)
    return len(data) == info.file_size and (zlib.crc32(data) & 0xffffffff) == info.CRC


def data_bytes(key, value):
    # JSON is serialized, never interpolated into executable text unescaped.
    if str(key).startswith('battle:'):
        value = pack_battle(value)
    payload = json.dumps([key, value], ensure_ascii=True, allow_nan=False, separators=(',', ':'))
    payload = payload.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    return ('ArmorInspectorData.receive('+payload+');\n').encode('ascii')


def write_data(path, key, value):
    data = data_bytes(key, value)
    atomic_write(path, data)
    # The size written: data/published.json compares it with the file on disk at the next start.
    return len(data)


def write_data_changed(path, key, value):
    """(size, written): write_data, unless the file on disk holds these very bytes (BACKLOG 55, 02.10: 138 of 145 battles
    published again after the client update were byte for byte the old files) - then nothing is written."""
    data = data_bytes(key, value)
    try:
        if os.path.getsize(path) == len(data):
            with open(path, 'rb') as stream:
                if stream.read(len(data) + 1) == data: return len(data), False
    except (OSError, IOError):
        pass
    atomic_write(path, data)
    return len(data), True


def read_data_file(path):
    """The value written by write_data, read back from a classic-script payload.

    Read by the file's own size: on Windows read(64 MB) costs 14-19 ms per file whatever its
    size, because the whole buffer is allocated first, and setup reads every exported vehicle.
    """
    with open(path, 'rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        if size > 64*1024*1024: raise ValueError('Data file too large')
        payload = stream.read(size).decode('ascii')
    prefix, suffix = 'ArmorInspectorData.receive(', ');\n'
    if not payload.startswith(prefix) or not payload.endswith(suffix):
        raise ValueError('Not an exported data file')
    key, value = json.loads(payload[len(prefix):-len(suffix)])
    return unpack_battle(value) if str(key).startswith('battle:') else value


class HeaderUnavailable(ValueError):
    """A battle file whose first record is not its header and which has no recovery file (REC-02, 24.09).

    The file itself reads; nothing that follows the lost header can be placed without it. A ValueError, so
    every caller that already catches one keeps doing so; the tail catches this class by name to leave the
    file alone for the session instead of retrying it on every tick."""


class BattleReader(object):
    """A raw battle file read in steps (startup-review-fixes, 27.09): read_battle is one step to the end; the background
    publication (Exporter.run_battle_job) reads a line at a time between its gates. The file is opened for each step and
    read from where the last one stopped. `offset`: the bytes of the complete lines read; `size`: the file's size at the
    last step - more than `offset` when the last line is unfinished (data/published.json keeps both)."""

    def __init__(self, path, decoder=None):
        self.path = path
        self.decoder = decoder or RecordDecoder()
        self.header, self.hits, self.warnings, self.shot_events, self.crit_events, self.roster = None, [], [], [], [], None
        self.offset, self.number, self.size, self.done = 0, 0, None, False

    def step(self, stop=None):
        """Read lines until the end of the file, or until `stop()` says so after a line. True when the file is read."""
        with open(self.path, 'rb') as stream:
            self.size = os.fstat(stream.fileno()).st_size
            stream.seek(self.offset)
            while True:
                line = stream.readline(2*1024*1024+1)
                if not line: break
                if self.number == 20000 or len(line) > 2*1024*1024:
                    raise ValueError('Battle exceeds export limit')
                if not line.endswith(b'\n'): break
                self.offset = stream.tell()
                try:
                    row = self.decoder.decode(json.loads(line.decode('utf-8')))
                    if row.get('schema') != 1: raise ValueError('Unknown schema')
                    if row.get('type') == 'battle' and self.header is None: self.header = row
                    elif row.get('type') == 'hit': self.hits.append(row)
                    elif row.get('type') == 'shot': self.shot_events.append(row)
                    elif row.get('type') == 'crit': self.crit_events.append(row)
                    elif row.get('type') == 'roster': self.roster = row
                    else: raise ValueError('Unexpected record')
                except (ValueError, AttributeError): self.warnings.append('Unreadable record at line '+str(self.number+1))
                self.number += 1
                if stop is not None and stop(): return False
        self.done = True
        return True

    def result(self):
        """The battle read (the header restored from its recovery file when the file lost it)."""
        path, header, warnings = self.path, self.header, self.warnings
        if header is None:
            # Explicit, hash-bound metadata can recover the header lost by 0.2.0.
            # Never guess the client version from whatever client is installed now.
            sidecar = path + '.recovery.json'
            if not os.path.isfile(sidecar): raise HeaderUnavailable('Battle header unavailable')
            with open(sidecar, 'rb') as stream:
                recovery = json.loads(stream.read(65537).decode('utf-8'))
            digest = hashlib.sha256()
            with open(path, 'rb') as stream:
                while True:
                    chunk = stream.read(65536)
                    if not chunk: break
                    digest.update(chunk)
            if recovery.get('rawSha256') != digest.hexdigest():
                raise ValueError('Recovery metadata does not match the raw battle')
            header = recovery['header']
            if (header.get('schema') != 1 or header.get('type') != 'battle' or
                    header.get('id') != os.path.basename(path)[:-6] or not header.get('clientVersion')):
                raise ValueError('Invalid recovery header')
            warnings.extend(recovery.get('warnings', []))
        result = dict(header)
        result.update({'id':os.path.basename(path)[:-6], 'hits':self.hits, 'shotEvents':self.shot_events,
                       'critEvents':self.crit_events, 'warnings':warnings})
        roster = self.roster
        if roster is not None:
            result.update({'roster':roster.get('vehicles') or [], 'playerTeam':roster.get('playerTeam')})
            # The header may hold 0 when the battle record was opened before the client knew its vehicle.
            if roster.get('playerVehicleId'): result['playerVehicleId'] = roster['playerVehicleId']
        return result


def read_battle(path, return_offset=False, decoder=None):
    reader = BattleReader(path, decoder)
    reader.step()
    result = reader.result()
    return (result, reader.offset) if return_offset else result


VEHICLE_CLASS_TAGS = ('lightTank', 'mediumTank', 'heavyTank', 'AT-SPG', 'SPG')


def fix_shells(hit):
    """Shell damage fields and the target's liner factor for hits recorded before 0.7.13.

    The expected-damage view needs alpha, the spall damage and the mechanics of the
    shell, and the target's spall-liner factor. Both compact descriptors are in the
    record, so the same client lookups the recorder makes today rebuild them exactly;
    nothing is guessed. A hit whose shells already carry 'alpha' is left alone.
    Guarded like the fixes above: a failure leaves the record as it was.

    R5 of outputs/mode-shell-modifiers-2026-09-22.md - what a rebuilt shell is NOT. vehicle_descr()
    passes no extData, so a shell built here carries neither the battle's modifiers nor the shooter's
    post-progression, while the ones the recorder wrote live do (ClientArena.getVehicleType builds the
    attacker's descriptor with both). Measured on the owner's own records, 22.09: in the twenty 7v7
    battles of 20-21.09 the live shells carry damageRandomization 0.12 where the stock value is 0.25
    and half the module damage. So a live list is never replaced: the only records touched are those
    whose shells carry no 'alpha' at all, i.e. were written before 0.7.13. The second mode's shells
    (modeShells) are live-only for the same reason and are never rebuilt here.
    """
    attacker, target = hit.get('attacker') or {}, hit.get('target') or {}
    shells = hit.get('availableShells') or hit.get('shellCandidates') or []
    live = bool(shells and all('alpha' in s for s in shells)) or bool(attacker.get('modeShells'))
    if attacker.get('compactDescriptor') and not live:
        try:
            from .armor import shot_candidates
            descr = vehicle_descr(attacker['compactDescriptor'])
            slot = hit.get('gunInstallationIndex') or 0
            candidates = shot_candidates(descr, hit.get('effectsIndex'), slot)
            # A type the client can no longer build gives an empty list; the record then keeps the
            # shells it was written with instead of losing them.
            rebuilt = shot_candidates(descr)
            if rebuilt: hit['availableShells'] = rebuilt
            if candidates:
                hit['shellCandidates'] = candidates
                hit['shellStatus'] = 'matched'
        except Exception:
            pass
    if target.get('compactDescriptor') and target.get('linerFactor') is None:
        try:
            descr = vehicle_descr(target['compactDescriptor'])
            target['linerFactor'] = float(descr.miscAttrs.get('antifragmentationLiningFactor', 1.0))
        except Exception:
            pass
    try:
        fix_trace_ricochet(hit)
    except Exception:
        pass


TRACE_RICOCHET = 'traceRicochet'


def fix_trace_ricochet(hit):
    """The shells' traceRicochet (enableTraceRicochet) for records written before 26.09 (b197550); True when it wrote one.

    A shell without the key reads as the client default True on the page, so the 28 shells that lose themselves at the
    first ricochet (AAAC, Charlie 3/Delta 6, JPNh, PG70) flew on in every older record. The flag is a property of the
    shell type the battle's modifiers never touch (docs/KNOWLEDGE.md 5, vehicle_modifications.pyc), so the stock
    descriptor of the shooter gives it exactly - but only BY POSITION: a live list is shot_candidates of the live
    descriptor, the stock list the same walk over the same guns and shots, and modifiers change a shell's figures (its
    effectsIndex among them), never the list. A list whose length, kinds or calibres differ from the stock one gets
    nothing; a shell is never matched by its name. A match candidate (shellCandidates) takes the flag of the live shell
    it equals (every key but 'source'); the other mode's shells (modeShells) are read off that mode's descriptor. Only
    a missing key is written - a recorded one stays as it is.
    """
    attacker = hit.get('attacker') or {}
    available, candidates, mode_shells = hit.get('availableShells'), hit.get('shellCandidates'), attacker.get('modeShells')

    def missing(shells):
        return isinstance(shells, list) and any(isinstance(s, dict) and TRACE_RICOCHET not in s for s in shells)

    if not attacker.get('compactDescriptor') or not (missing(available) or missing(candidates) or missing(mode_shells)):
        return False
    from .armor import shot_candidates as stock_shells
    descr = vehicle_descr(attacker['compactDescriptor'])
    if attacker.get('type') and str(descr.type.name) != str(attacker.get('type')):
        return False

    def flags(live, stock):
        if not isinstance(live, list) or len(live) != len(stock): return None
        for a, b in zip(live, stock):
            if not isinstance(a, dict) or a.get('kind') != b.get('kind'): return None
            try:
                if abs(float(a.get('caliber')) - float(b.get('caliber'))) > 1e-6: return None
            except Exception:
                return None
            if 'gunInstallation' in a and a['gunInstallation'] != b.get('gunInstallation'): return None
        return [bool(b.get(TRACE_RICOCHET, True)) for b in stock]

    wrote = False
    mode = attacker.get('vehicleMode')
    live_flags = flags(available, stock_shells(mode_descr(descr, mode)))
    if live_flags:
        for shell, flag in zip(available, live_flags):
            if TRACE_RICOCHET not in shell:
                shell[TRACE_RICOCHET] = flag
                wrote = True
        if isinstance(candidates, list):
            def body(shell):
                return dict((k, v) for k, v in shell.items() if k not in ('source', TRACE_RICOCHET))
            bodies = [body(s) for s in available]
            for shell in candidates:
                if not isinstance(shell, dict) or TRACE_RICOCHET in shell: continue
                own = body(shell)
                matches = [i for i, other in enumerate(bodies) if other == own]
                if matches and len(set(live_flags[i] for i in matches)) == 1:
                    shell[TRACE_RICOCHET] = live_flags[matches[0]]
                    wrote = True
    if missing(mode_shells) and attacker.get('modeShellsMode') in (0, 1):
        mode_flags = flags(mode_shells, stock_shells(mode_descr(descr, attacker['modeShellsMode'])))
        for shell, flag in zip(mode_shells, mode_flags or []):
            if TRACE_RICOCHET not in shell:
                shell[TRACE_RICOCHET] = flag
                wrote = True
    return wrote


def player_vehicle(battle):
    """The player's vehicle of a battle for the battle picker: the target of his incoming hits, the attacker
    of his outgoing ones, else his roster row. Only display fields, never the descriptor."""
    keys = ('name', 'type', 'level', 'class', 'role', 'nation')
    for hit in battle.get('hits') or []:
        side = {'incoming':'target', 'outgoing':'attacker'}.get(hit.get('direction'))
        vehicle = hit.get(side) if side else None
        if isinstance(vehicle, dict) and vehicle.get('name'):
            return dict((k, vehicle.get(k)) for k in keys if vehicle.get(k) is not None)
    own = battle.get('playerVehicleId')
    for row in battle.get('roster') or []:
        if own and row.get('id') == own and row.get('name'):
            return dict((k, row.get(k)) for k in keys if row.get(k) is not None)
    return None


def enrich_vehicle(vehicle):
    """Add tier/class/role/nation to a recorded attacker/target when they are missing.

    Battles written before the recorder learned these fields are re-published on
    every run, so they pick the data up here. Purely additive and fully guarded:
    the export must never fail because a vehicle type cannot be resolved.
    """
    if not isinstance(vehicle, dict):
        return
    type_name = vehicle.get('type')
    if not type_name:
        return
    if vehicle.get('nation') is None:
        try:
            vehicle['nation'] = str(type_name.split(':')[0])
        except Exception:
            pass
    fix_gun_height(vehicle)
    fix_gun_dispersion(vehicle)
    fix_aim(vehicle)
    fix_fitment(vehicle)
    if all(vehicle.get(key) is not None for key in ('level', 'class', 'role')):
        return
    try:
        from items import vehicles
        nation_id, innation_id = vehicles.g_list.getIDsByName(type_name)
        vtype = vehicles.g_cache.vehicle(nation_id, innation_id)
    except Exception:
        return
    if vehicle.get('level') is None:
        try:
            vehicle['level'] = int(vtype.level)
        except Exception:
            pass
    if vehicle.get('class') is None:
        try:
            for tag in vtype.tags:
                if tag in VEHICLE_CLASS_TAGS:
                    vehicle['class'] = str(tag)
                    break
        except Exception:
            pass
    if vehicle.get('role') is None:
        try:
            from constants import ROLE_TYPE_TO_LABEL
            label = ROLE_TYPE_TO_LABEL.get(vtype.role)
            if label and label != 'NotDefined':
                vehicle['role'] = str(label)
        except Exception:
            pass


def fix_gun_height(vehicle):
    """Recompute 'gunHeight' from the ground for records made before 0.6.34.

    Those records summed the turret and gun positions but not the hull's height
    on the chassis, so the orbit centre sat about a metre too low. The compact
    descriptor of the shooter is recorded, so the exact mounted turret and gun
    are known. Guarded like everything else here.
    """
    if vehicle.get('gunHeightFrom') == 'ground' or not vehicle.get('compactDescriptor'):
        return
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        vehicle['gunHeight'] = float((descr.chassis.hullPosition + descr.hull.turretPositions[0] + descr.turret.gunPosition).y)
        vehicle['gunHeightFrom'] = 'ground'
    except Exception:
        pass


def fix_gun_dispersion(vehicle):
    """Recompute 'gunDispersion' for records made before 0.6.29 did not save it.

    The viewer draws the nominal full-aim circle of every hit without a recorded
    reticle from this number, so an old battle would show no estimate ring at all.
    The mounted gun is known exactly from the compact descriptor, and the client's
    own gun.shotDispersionAngle is the same value the recorder writes today.
    Guarded like fix_gun_height next to it.
    """
    existing = vehicle.get('gunDispersion')
    if isinstance(existing, (int, float)) and existing > 0:
        return
    if not vehicle.get('compactDescriptor'):
        return
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        dispersion = float(descr.gun.shotDispersionAngle)
        if dispersion > 0:
            vehicle['gunDispersion'] = dispersion
    except Exception:
        pass


TEXT_TYPE = type(u'')


def json_safe(value, limit=4000, depth=16):
    """A copy of a client value that json.dumps(allow_nan=False) always takes (S3, 22.09).

    For the raw data of the client the recorder keeps as it is - the battle modifiers descriptor, the
    field modifications of a roster vehicle, the namedtuples of a gun's reloading systems: tuples and
    sets become lists, a namedtuple its fields by name, byte strings text, a non-finite float None,
    anything else its short repr. A value bigger than `limit` items or deeper than `depth` raises
    ValueError, so one odd server payload can never swell a record or cost the line it rides in: the
    Writer drops a whole record whose json.dumps fails.
    """
    budget = [int(limit)]

    def walk(item, level):
        budget[0] -= 1
        if budget[0] < 0 or level > depth: raise ValueError('Value too large to record')
        if item is None or isinstance(item, bool): return item
        if isinstance(item, numbers.Integral): return int(item)
        if isinstance(item, numbers.Real):
            number = float(item)
            return number if number - number == 0 else None
        if isinstance(item, TEXT_TYPE): return item
        if isinstance(item, bytes): return item.decode('utf-8', 'replace')
        if hasattr(item, '_asdict'):
            return walk(item._asdict(), level + 1)
        if isinstance(item, dict):
            out = {}
            for key, entry in item.items():
                if isinstance(key, bytes): key = key.decode('utf-8', 'replace')
                elif not isinstance(key, TEXT_TYPE): key = TEXT_TYPE(walk(key, level + 1))
                out[key] = walk(entry, level + 1)
            return out
        if isinstance(item, (list, tuple, set, frozenset)):
            return [walk(entry, level + 1) for entry in item]
        text = repr(item)
        if isinstance(text, bytes): text = text.decode('utf-8', 'replace')
        return text[:200]

    return walk(value, 0)


def positive(value):
    """True for a finite number above zero. Written out because a record read back from
    disk may carry None or a string where a number is expected, and Python 2 compares
    those without complaining."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def speed_limits(descr):
    """(forward, backward) top speed of the vehicle in m/s.

    The client reads speedLimits/forward|backward from the vehicle XML in km/h and stores
    them multiplied by component_constants.KMH_TO_MS on VehicleType.speedLimits; the
    descriptor's 'physics' dict carries that very tuple, but only on the apps that compute
    the arena parameters, so the type is the fallback (vehicles.pyc, VehicleType.__init__
    and VehicleDescriptor.__updateAttributes of client 2.4.0.1).
    """
    physics = getattr(descr, 'physics', None)
    limits = physics.get('speedLimits') if isinstance(physics, dict) else None
    if limits is None:
        limits = descr.type.speedLimits
    return float(limits[0]), float(limits[1])


def aim_block(descr):
    """Everything the client's own dispersion formula needs about a shooter, in client units.

    Avatar.getOwnVehicleShotDispersionAngle turns the state of the vehicle into a factor on
    gun.shotDispersionAngle:
        ideal = multShotDispersionFactor * sqrt(1 + additiveShotDispersionFactor**2 * (
                    (speed * chassisMovement)**2 + (hullTurn * chassisRotation)**2
                  + (turretTurn * gunTurretRotation)**2 + (afterShot and afterShot**2 or 0)))
    and lets the factor settle towards it as exp(-t / gun.aimingTime). The fields below are
    exactly its inputs, so the page can recompute the circle for a state the user chooses:

      dispersion            rad        gun.shotDispersionAngle (full-aim radius per metre of range)
      aimingTime            s          gun.aimingTime
      turretRotationFactor  per rad/s  gun.shotDispersionFactors['turretRotation']
      afterShotFactor       -          gun.shotDispersionFactors['afterShot']
      afterShotInBurstFactor -         gun.shotDispersionFactors['afterShotInBurst'] - a round of a burst
                                       with more rounds after it; written only where it differs from
                                       afterShot (the client's default)
      movementFactor       per m/s    chassis.shotDispersionFactors[0] (a two-item tuple, not a dict)
      rotationFactor        per rad/s  chassis.shotDispersionFactors[1]
      turretRotationSpeed   rad/s      turret.rotationSpeed
      hullRotationSpeed     rad/s      chassis.rotationSpeed
      gunPitchSpeed         rad/s      gun.rotationSpeed - the gun's elevation speed, which the client's gun rotator
                                       moves the pitch at (getNextGunPitch) and which never enters the circle: the
                                       turret term is |d yaw| / dt alone (VehicleGunRotator.__rotate) - gun_statics
      shotOffsets           [[m,m,m]]  where the shell leaves, from the gun's joint (turret.gunPosition) in the turret's
                                       frame: one entry per barrel of a multi-barrel gun, else gun.shotOffset - written
                                       only where it is not zero (shot_offsets)
      speedForward/Backward m/s        speed_limits(descr)
      turretYawLimits       [rad, rad] yaw_limits(descr): the gun's sector on the hull, left negative -
                                       written only for a gun that has one (turretless tank destroyers,
                                       limited turrets); the page's turret chase stops at it (BACKLOG 40)
      staticPitch,          rad        gun.staticPitch / gun.staticTurretYaw: the pose the client holds the gun in
      staticTurretYaw                  while switching the mode, driving (yaw only) or with a dead engine; written only
                                       for a gun that has them (aim_mode_fields, 23.09)
      hullAiming            {..}       the hull aiming of a hydropneumatic or hydraulic chassis (aim_mode_fields)
      siegeMode             {..}       the parameters of the vehicle's second mode (aim_mode_fields)
      multFactor            -          miscAttrs['multShotDispersionFactor']
      additiveFactor        -          miscAttrs['additiveShotDispersionFactor']
      aimingTimeFactor      -          miscAttrs['gunAimingTimeFactor']

    The rest is the reload, which the page needs to gate an emulated shot (0.7.14 stage 2).
    utils.getReloadTime of the client computes it as

        reload = gun.reloadTime * miscAttrs['gunReloadTimeFactor']
                 * max(factors['gun/reloadTime'], 0.0) + factors['gun/extraReloadTime']

    where factors['gun/reloadTime'] is 1 / f of the loader (VehicleDescrCrew._updateLoaderFactors,
    the same 0.57 + 0.43 * efficiency law the gunner uses) and gunReloadTimeFactor carries the
    rammer. The record therefore holds the two the descriptor knows and the page multiplies the
    crew and the rammer on top:

      reloadTime            s          gun.reloadTime
      clip                  [n, s]     gun.clip - the client's own (count, interval) tuple, where
                                       interval = 60.0 / <rate> seconds and is 0.0 for count 1
                                       (vehicles.pyc _readGunClip, component_constants
                                       DEFAULT_GUN_CLIP = (1, 0.0))
      burst                 [n, s, b]  gun.burst - (count, interval, syncReloading), read by the
                                       very same _readGunClip plus burst/syncReloading; written
                                       only when the gun really bursts, i.e. count > 1
      reloadTimeFactor      -          miscAttrs['gunReloadTimeFactor']

    The names and the unit conversions were read out of the installed client's own
    scripts/common/items/vehicles.pyc (_readGun, _readGunShotDispersionFactors, _readChassis,
    _readTurret, _readGunClip, _readGunBurst, VehicleType.__init__,
    VehicleDescriptor.__updateAttributes) and items/utils.pyc (getReloadTime), not from memory.

    multFactor, additiveFactor, aimingTimeFactor and reloadTimeFactor are the miscAttrs factors. They
    are NOT always 1.0 (corrected 22.09, outputs/vehicle-classes-modes-2026-09-21.md 2.5): the live
    shooter block of a hit is read from the arena's descriptor, which carries the battle's field
    modifications and battle modifiers and, for the player's own shots, his devices; a descriptor
    rebuilt from a compact descriptor carries whatever devices were packed into it. Neither has a
    crew. The published block says which descriptor it came from in 'aimFrom', and a live one also
    carries its compact descriptor's own four as 'compactFactors' (stamp_aim_origin), so the page's
    configurator can take out exactly the packed devices it applies itself and keep the field
    modifications, which it cannot add back (web/app.js aimBaseFactors).

    The vehicle and its gun, beside the numbers (S3, 22.09):

      crewRoles             [[role, ...]]  descr.type.crewRoles: one list per tankman in slot order, his
                                       main role first (vehicles.pyc _readCrew). Type-level, so an old
                                       record takes it from its compact descriptor (fix_aim).
      gunTags               [tag]      descr.gun.tags - the client's own flags of the mounted gun
                                       (_readGun: clip, autoreload, autoShoot, unlimitedClip, twinGun,
                                       dualGun, dualAccuracy, ...)
      autoreload, dualGun,  {field: v} the gun's own namedtuple of that mechanic, by field name, written
      twinGun, dualAccuracy,           only when gunTags names it: the client keeps a default tuple on
      autoShoot                        every other gun, which says nothing
      gunMechanics          [name]     the mechanics of AIM_GUN_MECHANICS the descriptor carries
      temperatureGun,       {field: v} the gun's heat parameters (gun_heat), only for a gun that has them
      overheatGun,
      heatingZonesGun
      secondary             {field: v} the circle and the reload of the vehicle's secondary (ability) gun, gun
                                       slot 1 (secondary_aim) - only the Ho-Ri Shugo and the Taschenratte of client
                                       2.4.0.1 have one

    Every field is read on its own and a field the client does not give is simply left out
    and named in 'unavailable', the same contract the telemetry snapshot uses: this must
    never raise inside the recorder.
    """
    aim = {'unavailable': []}

    def take(name, action):
        try:
            aim[name] = action()
        except Exception:
            aim['unavailable'].append(name)

    take('dispersion', lambda: float(descr.gun.shotDispersionAngle))
    take('aimingTime', lambda: float(descr.gun.aimingTime))
    take('turretRotationFactor', lambda: float(descr.gun.shotDispersionFactors['turretRotation']))
    take('afterShotFactor', lambda: float(descr.gun.shotDispersionFactors['afterShot']))
    # The factor of a round of a burst that still has rounds after it (23.09, BACKLOG 35 B1): the client
    # takes it where withShot is 2 (Avatar.getOwnVehicleShotDispersionAngle; vehicle_extras.ShowShooting
    # fires the burst of a showShooting(burstCount) that way). _readGunShotDispersionFactors defaults it to
    # afterShot, so it is written only where the gun's own differs - the Donnola and the Black Rock of client
    # 2.4.0.1 - and never named in 'unavailable', like 'burst'. Static per configuration.
    try:
        in_burst = float(descr.gun.shotDispersionFactors['afterShotInBurst'])
        if positive(in_burst) and in_burst != aim.get('afterShotFactor'):
            aim['afterShotInBurstFactor'] = in_burst
    except Exception:
        pass
    take('movementFactor', lambda: float(descr.chassis.shotDispersionFactors[0]))
    take('rotationFactor', lambda: float(descr.chassis.shotDispersionFactors[1]))
    take('turretRotationSpeed', lambda: float(descr.turret.rotationSpeed))
    take('hullRotationSpeed', lambda: float(descr.chassis.rotationSpeed))
    # The gun's own elevation speed, its circle multiplier while damaged and where its shells leave (26.09, fields
    # audit P2-P4): one reader, gun_statics, for this block and for fix_gun_statics of an older record.
    statics = gun_statics(descr)
    aim.update(statics)
    aim['unavailable'].extend(key for key in GUN_STATIC_KEYS if key not in statics)
    # The gun's horizontal sector on the hull (23.09, BACKLOG 40): the page's turret chase stops at it, as the
    # client's gun rotator does. Written only for a gun that has one - a turret that turns all the way round has
    # none, so its absence says nothing and 'unavailable' never names it, like 'burst'. Static per configuration.
    try:
        limits = yaw_limits(descr)
        if limits is not None: aim['turretYawLimits'] = limits
    except Exception:
        pass
    # The second mode's static fields (23.09, outputs/second-modes-2026-09-23.md 5.1 M1): the gun's static angles, the
    # hull aiming and the parameters of the mode switch - each only where the descriptor has it, never 'unavailable'.
    try:
        aim.update(aim_mode_fields(descr))
    except Exception:
        pass
    take('speedForward', lambda: speed_limits(descr)[0])
    take('speedBackward', lambda: speed_limits(descr)[1])
    take('multFactor', lambda: float(descr.miscAttrs['multShotDispersionFactor']))
    take('additiveFactor', lambda: float(descr.miscAttrs['additiveShotDispersionFactor']))
    take('aimingTimeFactor', lambda: float(descr.miscAttrs['gunAimingTimeFactor']))
    take('reloadTime', lambda: float(descr.gun.reloadTime))
    take('clip', lambda: [int(descr.gun.clip[0]), float(descr.gun.clip[1])])
    take('reloadTimeFactor', lambda: float(descr.miscAttrs['gunReloadTimeFactor']))
    # A burst of one is the client's default for every ordinary gun and says nothing, so it is
    # written only when the gun really fires in bursts. 'unavailable' must not list it either:
    # the field is absent by decision here, not because the client refused it.
    try:
        burst = descr.gun.burst
        if int(burst[0]) > 1:
            aim['burst'] = [int(burst[0]), float(burst[1]), bool(burst[2])]
    except Exception:
        aim['unavailable'].append('burst')
    take('crewRoles', lambda: [[str(role) for role in roles] for roles in descr.type.crewRoles])
    gun_tags = ()
    try:
        gun_tags = frozenset(str(tag) for tag in descr.gun.tags)
        aim['gunTags'] = sorted(gun_tags)
    except Exception:
        aim['unavailable'].append('gunTags')
    for key in AIM_MECHANICS_KEYS:
        # The gun attribute and its tag share the name (vehicles.pyc _readGun, 2.4.0.1). dualAccuracy is
        # read the same guarded way, so a client without it simply has no such tag.
        if key not in gun_tags: continue
        try:
            value = json_safe(getattr(descr.gun, key), 200)
            if value is not None: aim[key] = value
        except Exception:
            aim['unavailable'].append(key)
    # R3: the gun mechanics this vehicle carries, by the client's own names (the MECHANICS_NAME constants
    # of items/components/shared_components.pyc). It says only THAT the gun has the mechanic, never its
    # state at the shot, so the page can say "this gun's numbers vary" instead of quietly showing one
    # value. Read from the descriptor's merged mechanicsParams (telemetry.mechanics_params): until 22.09
    # it was read from VehicleType.mechanicsParams, which never holds a gun-level mechanic - so the five
    # German switchers, the Gorilla, the Fauteur and the Black Rock silently got no list at all.
    mechanics = {}
    try:
        mechanics = mechanics_params(descr)
        found = sorted(str(name) for name in mechanics if str(name) in AIM_GUN_MECHANICS)
        if found: aim['gunMechanics'] = found
    except Exception:
        aim['unavailable'].append('gunMechanics')
    # The gun's heat (22.09, outputs/gun-overheat-2026-09-22.md): the static parameters of temperatureGun,
    # overheatGun and heatingZonesGun, written only for a gun that has them (the five Ares and the STK-2 in
    # client 2.4.0.1). Static per configuration, so the by-reference snapshot carries it once.
    try:
        aim.update(gun_heat(mechanics))
    except Exception:
        aim['unavailable'].append('temperatureGun')
    # The secondary gun (23.09, BACKLOG 37): its own circle and reload, so the page can fire it under its own numbers.
    # Static per configuration and built once per gun object (secondary_aim); written only for a vehicle that has it.
    try:
        secondary = secondary_aim(descr)
        if secondary: aim['secondary'] = secondary
    except Exception:
        aim['unavailable'].append('secondary')
    if not aim['unavailable']:
        del aim['unavailable']
    # Without the angle itself there is no circle to draw, so an empty block is no block.
    return aim if positive(aim.get('dispersion')) else None


# The keys 0.7.14 stage 2 added to aim_block. A block that carries none of them and does not
# name them in 'unavailable' was written by an older build and is completed, not rebuilt: the
# fields it already has came from the same descriptor and recomputing them would change nothing.
AIM_RELOAD_KEYS = ('reloadTime', 'clip', 'reloadTimeFactor')
# S3 (22.09): the crew and the gun's own flags. Both belong to the type and the mounted gun, which the
# compact descriptor packs, so every older record - a live block of 0.7.14-0.7.19 included - takes
# them from it; the mechanics tuples come along with gunTags, whose presence decides them.
AIM_TYPE_KEYS = ('crewRoles', 'gunTags')
AIM_MECHANICS_KEYS = ('autoreload', 'dualGun', 'twinGun', 'dualAccuracy', 'autoShoot')
# The gun mechanics whose presence changes what a shell does or how hard the shot hits, by the client's
# own MECHANICS_NAME (shared_components.pyc, verified in 2.4.0.1): the first four are the ones the garage
# itself shows a shell in two states for (shell_mechanics_helper.pyc), the rest multiply the damage or the
# penetration of a single shot from live state. Anything else in mechanicsParams is mobility or vision and
# is not written here.
AIM_GUN_MECHANICS = frozenset((
    'shellParamsSwitcher', 'lowChargeShot', 'shellCalibration', 'bustleFeed',
    'chargeShot', 'propellantAfterburnerGun', 'overheatStacks', 'chargeableBurst', 'secondaryGun'))
AIM_COMPLETION_KEYS = AIM_RELOAD_KEYS + AIM_TYPE_KEYS
# The gun's temperature mechanics (gun_heat): written only for a gun that has them, so - like 'burst' -
# they never decide that a block is incomplete and are copied only when a rebuild happens anyway.
AIM_GUN_HEAT_KEYS = ('temperatureGun', 'overheatGun', 'heatingZonesGun')
# One block per mechanics object of a descriptor: the arena keeps one descriptor per vehicle for the whole
# battle and an Ares fires 3.3 rounds a second, so the block is built once and every later hit only looks
# it up. The objects themselves are kept in the entry, so an id can never be reused while it is cached.
_GUN_HEAT_CACHE = {}


def heat_number(value):
    """A finite float or a ValueError - one bad field must cost the block, not the recorder."""
    result = float(value)
    if result - result != 0:
        raise ValueError('Non-finite heat parameter')
    return result


def heat_modifier(modifier):
    """One modifier of a thermal state as {'op', 'name', 'value'[, 'filter']}.

    items/attributes_helpers.pyc readModifiers (client 2.4.0.1) keeps each as the tuple
    (opType 'mul'|'add'|'set', attrType, attrName, value, filterName); the name is written back whole, as
    the XML spells it ('dynAttrs/multShotDispersionFactor'), and the filter only when it is not the default
    MODIFIER_FILTER_TYPE.COMMON.
    """
    op, kind, name, value, where = tuple(modifier)[:5]
    # The client keeps the kind WITH its slash ('dynAttrs/', 2.4.0.1, checked on the real items.vehicles 23.09), so a
    # plain join wrote 'dynAttrs//multShotDispersionFactor' into every record since 0.7.27; the page reads both.
    kind = str(kind).rstrip('/') if kind else ''
    result = {'op': str(op), 'name': '%s/%s' % (kind, name) if kind else str(name), 'value': heat_number(value)}
    if where and str(where) != 'common':
        result['filter'] = str(where)
    return result


def gun_heat(params):
    """The static heat parameters of the mounted gun, {mechanic: {field: value}}; {} for every other gun.

    Read out of the client's own parameter objects (items/components/shared_components.pyc, 2.4.0.1):

      temperatureGun   heatingPerShot, coolingDelay (s), coolingPerSec (degrees/s), maxTemperature (the
                       hottest state's bound, TemperatureGunParams.maxTemperature), thermalStateHysteresis and
                       thermalStates - ascending by maxTemperature, as the client sorts them, each with the
                       modifiers applied while the temperature lies in that band (the Ares: none below 50,
                       then multShotDispersionFactor 1.25 and 1.5)
      overheatGun      coolingPerSecFactor (the cooling while overheated), tempOverheatOnThreshold (the gun
                       locks), tempOverheatOffThreshold (it unlocks), tempOverheatWarnThreshold
      heatingZonesGun  zones - four temperatures, one per HEATING_ZONES_GUN_STATE (idle, low, medium, high)

    The values are the descriptor's, i.e. after the field modifications of the battle (a live block) or
    stock (a block rebuilt from a compact descriptor). The live temperature is not here: it is replicated
    state (TemperatureGunController.stateStatus), not a parameter. Raises on a malformed object; the
    caller guards it.
    """
    objects = tuple(params.get(name) for name in AIM_GUN_HEAT_KEYS)
    if not any(item is not None for item in objects):
        return {}
    key = tuple(id(item) for item in objects)
    cached = _GUN_HEAT_CACHE.get(key)
    if cached is not None and all(a is b for a, b in zip(cached[0], objects)):
        return cached[1]
    temperature, overheat, zones = objects
    block = {}
    if temperature is not None:
        states = []
        for state in sorted(temperature.thermalStates.states, key=lambda item: float(item.temperature)):
            entry = {'maxTemperature': heat_number(state.temperature)}
            modifiers = [heat_modifier(item) for item in (state.modifiers or ())]
            if modifiers:
                entry['modifiers'] = modifiers
            states.append(entry)
        block['temperatureGun'] = {
            'heatingPerShot': heat_number(temperature.heatingPerShot),
            'coolingDelay': heat_number(temperature.coolingDelay),
            'coolingPerSec': heat_number(temperature.coolingPerSec),
            'maxTemperature': heat_number(temperature.maxTemperature),
            'thermalStateHysteresis': heat_number(temperature.thermalStates.thermalStateHysteresis),
            'thermalStates': states}
    if overheat is not None:
        block['overheatGun'] = dict((name, heat_number(getattr(overheat, name))) for name in (
            'coolingPerSecFactor', 'tempOverheatOnThreshold', 'tempOverheatOffThreshold',
            'tempOverheatWarnThreshold'))
    if zones is not None:
        block['heatingZonesGun'] = {'zones': [heat_number(value) for value in zones.zones]}
    if len(_GUN_HEAT_CACHE) > 256:
        _GUN_HEAT_CACHE.clear()
    _GUN_HEAT_CACHE[key] = (objects, block)
    return block


# One block per secondary gun object: an arena keeps one descriptor per vehicle for the whole battle, so the block is
# built once and every later hit of that shooter only looks it up (the gun object is kept in the entry, so an id can
# never be reused while it is cached) - the same pattern as _GUN_HEAT_CACHE above.
_SECONDARY_CACHE = {}


def secondary_aim(descr):
    """The circle and the reload of the vehicle's secondary gun, gun slot 1; None for every vehicle with one gun.

    Two vehicles of client 2.4.0.1 carry one (turrets0/<turret>/secondaryGuns of the vehicle file): the Ho-Ri Shugo's
    rocket launcher _12_cm_Shisei_Funshinhou (reload 60 s, aiming 1.0 s, 0.15 m/100 m, turret 0.10, after a shot 1.0)
    and the Taschenratte's mortar _8_cm_8H62_2 (reload 50 s, clip and burst 2 at 120 a minute, aiming 1.9 s, 0.35 m,
    turret 0.05, after a shot 1.2). The descriptor keeps the gun in VehicleDescriptor.gunInstallations, the list
    armor.gun_installations already reads for the shells, so the same reader is used here. The fields carry the names
    and the units of aim_block's own gun fields, so the page lays the block over the main one to fire that gun:

      installation 1; name (the gun's XML name); dispersion, aimingTime, turretRotationFactor, afterShotFactor,
      afterShotInBurstFactor (only where it differs), reloadTime, clip, burst (only with a count above 1), gunTags,
      and gun_statics of this gun (gunPitchSpeed, shotOffsets from the main gun's joint)

    The vehicle's own factors (miscAttrs, the chassis, the crew) are the main block's and are not repeated. Raises on
    a malformed gun list; the caller guards it.
    """
    from .armor import gun_installations
    for index, gun in gun_installations(descr):
        if index != 1: continue
        cached = _SECONDARY_CACHE.get(id(gun))
        if cached is not None and cached[0] is gun:
            return cached[1]
        block = {'installation': 1}

        def put(name, action):
            try:
                block[name] = action()
            except Exception:
                pass
        put('name', lambda: str(gun.name))
        put('dispersion', lambda: float(gun.shotDispersionAngle))
        put('aimingTime', lambda: float(gun.aimingTime))
        put('turretRotationFactor', lambda: float(gun.shotDispersionFactors['turretRotation']))
        put('afterShotFactor', lambda: float(gun.shotDispersionFactors['afterShot']))
        try:
            in_burst = float(gun.shotDispersionFactors['afterShotInBurst'])
            if positive(in_burst) and in_burst != block.get('afterShotFactor'):
                block['afterShotInBurstFactor'] = in_burst
        except Exception:
            pass
        put('reloadTime', lambda: float(gun.reloadTime))
        put('clip', lambda: [int(gun.clip[0]), float(gun.clip[1])])
        try:
            burst = gun.burst
            if int(burst[0]) > 1:
                block['burst'] = [int(burst[0]), float(burst[1]), bool(burst[2])]
        except Exception:
            pass
        put('gunTags', lambda: sorted(str(tag) for tag in gun.tags))
        # Its own elevation speed, damaged-gun factor and barrels (26.09), so none of the main gun's is laid under it.
        block.update(gun_statics(descr, gun))
        block = block if positive(block.get('dispersion')) else None
        if len(_SECONDARY_CACHE) > 64:
            _SECONDARY_CACHE.clear()
        _SECONDARY_CACHE[id(gun)] = (gun, block)
        return block
    return None


# The fields of a mode switch the page reads, by the name aim_block writes and the key of the client's own
# VehicleType.siegeModeParams (vehicles.pyc _readSiegeModeParams 11215, 2.4.0.1).
SIEGE_MODE_FIELDS = (('switchOnTime', 'switchOnTime', float), ('switchOffTime', 'switchOffTime', float),
                     ('switchCancelEnabled', 'switchCancelEnabled', bool), ('stopEngineOnSwitch', 'stopEngineOnSwitch', bool),
                     ('device', 'device', str), ('engineDamageCoeff', 'engineDamageCoeff', float))
# One block per (type, gun) object pair: the recorder builds aim_block on every hit, and these are static per
# configuration - the same pattern as _SECONDARY_CACHE. The objects are kept in the entry, so an id is never reused.
_MODE_FIELDS_CACHE = {}


def mode_kind(descr):
    """The kind of a vehicle's second mode, by the rule of the garage (params.py __hasHydraulicSiegeMode and its
    neighbours) and of SiegeModeControl, first match (outputs/second-modes-2026-09-23.md section 5.1 M1):

      hydraulic   hasHydraulicChassis - manual siege, key X (Strv 103, UDES 03, Kunze Panzer ...)
      auto        hasAutoSiegeMode - the server switches it by the speed; only the hull's tilt changes
      turboshaft  hasTurboshaftEngine - the gas turbine of the CS-63, CS-52 C, Ogar, Vercingetorix, Char Mle. 75
      wheeled     isWheeledVehicle - Cruise / Rapid of the French wheeled vehicles
      twinGun     the salvo of the British twin guns
      dualGun     the 'dualgun' type tag - the charged salvo, on its own key, not a mode switch of the page
      gun         anything else (the five shell switchers and the Gorilla: device 'gun')
    """
    if getattr(descr, 'hasHydraulicChassis', False): return 'hydraulic'
    if getattr(descr, 'hasAutoSiegeMode', False): return 'auto'
    if getattr(descr, 'hasTurboshaftEngine', False): return 'turboshaft'
    if getattr(descr, 'isWheeledVehicle', False): return 'wheeled'
    try:
        if getattr(descr, 'isTwinGunVehicle', False) or 'twinGun' in descr.gun.tags: return 'twinGun'
    except Exception:
        pass
    try:
        if 'dualgun' in descr.type.tags: return 'dualGun'
    except Exception:
        pass
    return 'gun'


def aim_mode_fields(descr):
    """The static fields of the second mode of one descriptor, {} for an ordinary vehicle (23.09, section 5.1 M1).

      staticPitch, staticTurretYaw  rad  gun.staticPitch / gun.staticTurretYaw (client sign: a negative pitch is up),
                                         only when the gun has them - 14 tank destroyers of client 2.4.0.1
      hullAiming  {'pitch': {available, enabled, flexible, speed (rad/s), min, max (rad)}, 'yawAvailable'} - the
                  type's hullAimingParams, only when descr.isHullAimingAvailable; 'enabled' is what differs between
                  the two descriptors (True in the siege one only: the hull tilts in the second mode alone)
      siegeMode   {kind (mode_kind), switchOnTime, switchOffTime, switchCancelEnabled, stopEngineOnSwitch, device,
                  engineDamageCoeff[, autoOn, autoOff m/s for an auto siege]} - the type's siegeModeParams, only when
                  descr.hasSiegeMode

    Every field on its own: one the client refuses is left out and never named in 'unavailable'. Raises nothing.
    """
    try:
        vtype, gun = descr.type, descr.gun
    except Exception:
        return {}
    key = (id(vtype), id(gun))
    cached = _MODE_FIELDS_CACHE.get(key)
    if cached is not None and cached[0] is vtype and cached[1] is gun:
        return cached[2]
    block = {}
    for name in ('staticPitch', 'staticTurretYaw'):
        try:
            value = getattr(gun, name, None)
            if value is not None: block[name] = float(value)
        except Exception:
            pass
    try:
        if getattr(descr, 'isHullAimingAvailable', False):
            params = vtype.hullAimingParams
            pitch = params['pitch']
            angles = pitch.get('wheelsCorrectionAngles') or {}
            block['hullAiming'] = {
                'pitch': {'available': bool(pitch.get('isAvailable')), 'enabled': bool(pitch.get('isEnabled')),
                          'flexible': bool(pitch.get('isFlexible')), 'speed': float(pitch.get('wheelsCorrectionSpeed') or 0.0),
                          'min': float(angles.get('pitchMin') or 0.0), 'max': float(angles.get('pitchMax') or 0.0)},
                'yawAvailable': bool((params.get('yaw') or {}).get('isAvailable'))}
    except Exception:
        block.pop('hullAiming', None)
    try:
        if getattr(descr, 'hasSiegeMode', False):
            params = vtype.siegeModeParams
            mode = {'kind': mode_kind(descr)}
            for name, source, cast in SIEGE_MODE_FIELDS:
                try:
                    if source in params: mode[name] = cast(params[source])
                except Exception:
                    pass
            if mode['kind'] == 'auto':
                for name, source in (('autoOn', 'autoSwitchOnRequiredVehicleSpeed'), ('autoOff', 'autoSwitchOffRequiredVehicleSpeed')):
                    try:
                        if source in params: mode[name] = float(params[source])
                    except Exception:
                        pass
            block['siegeMode'] = mode
    except Exception:
        block.pop('siegeMode', None)
    if len(_MODE_FIELDS_CACHE) > 128:
        _MODE_FIELDS_CACHE.clear()
    _MODE_FIELDS_CACHE[key] = (vtype, gun, block)
    return block


def fix_aim(vehicle):
    """Fill or complete the 'aim' block of a record written before the recorder knew it.

    The twin of fix_gun_dispersion next to it, and for the same reason: the mounted gun,
    turret and chassis are known exactly from the recorded compact descriptor, so an old
    battle or an old exported vehicle can draw the dispersion circle without being fired
    at again. Returns True when it filled something, so a caller that owns a file on disk
    can rewrite it. Guarded like its neighbours.
    """
    if not isinstance(vehicle, dict):
        return False
    existing = vehicle.get('aim')
    complete = isinstance(existing, dict) and positive(existing.get('dispersion'))
    known = list(existing.get('unavailable') or []) if complete else []
    if complete and not [k for k in AIM_COMPLETION_KEYS if k not in existing and k not in known]:
        statics = fix_gun_statics(vehicle)
        return fix_yaw_limits(vehicle) or statics
    if not vehicle.get('compactDescriptor'):
        return False
    try:
        block = aim_block(vehicle_descr(vehicle['compactDescriptor']))
    except Exception:
        return False
    if not block:
        return False
    if not complete:
        vehicle['aim'] = block
        fix_gun_statics(vehicle)   # an older second-mode block beside the rebuilt one
        return True
    # Only the missing keys are copied over: whatever the old block holds stays byte for byte,
    # so a record is never silently rewritten by a later change to an unrelated field.
    fresh = list(block.get('unavailable') or [])
    # 'burst', 'afterShotInBurstFactor', 'gunMechanics' and 'secondary' are written only when the gun really has
    # them, so none may decide that a block is incomplete - a vehicle without them would be "completed" on every pass
    # for ever. They are copied when a completion key brings the rebuild here anyway.
    for key in AIM_COMPLETION_KEYS + ('burst', 'afterShotInBurstFactor', 'gunMechanics', 'secondary') + AIM_MECHANICS_KEYS + AIM_GUN_HEAT_KEYS:
        if key in existing:
            continue
        if key in block:
            existing[key] = block[key]
        elif key in fresh and key not in known:
            known.append(key)
    if known:
        existing['unavailable'] = known
    # The sector and the gun's statics of the block's own mode, not the default one the rebuild above was made from.
    fix_yaw_limits(vehicle)
    fix_gun_statics(vehicle)
    return True


def yaw_limits(descr):
    """[left, right] of the gun's horizontal sector on the hull, radians with the left one negative, or None.

    The client's gun.turretYawLimits (vehicles.pyc _readGun, where a turret may override the gun's own): None for a
    turret that turns all the way round, a pair for a turretless tank destroyer or a limited turret; the garage
    prints it as abs(degrees(l)) left and right (gui params 698-710). The one reader of the vehicle export, the
    characteristics file and the aim block (BACKLOG 40).
    """
    limits = getattr(descr.gun, 'turretYawLimits', None)
    return None if limits is None else [float(item) for item in limits]


# The field gun_statics writes for every gun; 'shotOffsets' comes with it where it is not zero. A block that has it not
# and does not name it in 'unavailable' was written before 26.09 and gets it from fix_gun_statics. (The damaged gun's
# whileGunDamaged is not exported: damaged guns are not emulated - user's decision 26.09, docs/KNOWLEDGE.md 6.)
GUN_STATIC_KEYS = ('gunPitchSpeed',)


def gun_statics(descr, gun=None):
    """The gun's elevation speed and its shells' start points (26.09, P2 and P4).

    `gun`: another gun of the descriptor's turret than the mounted one (secondary_aim's), else descr.gun. Each read on
    its own; a field the client refuses is left out (the caller names it). The one reader for aim_block, secondary_aim
    and fix_gun_statics:
      gunPitchSpeed          gun.rotationSpeed, rad/s (vehicles.pyc _readGun: radians of the XML's degrees). The client
                             moves the pitch at the server's maxGunRotationSpeed, which is this with the gunner's factor
                             (VehicleDescrCrew._updateGunnerFactors scales turret/rotationSpeed and gun/rotationSpeed
                             alike). With no server speed the pitch stands still (getNextGunPitch 899-903: shotAngle =
                             curAngle); gun.rotationSpeed alone only brings the gun back inside its pitch limits.
      shotOffsets            shot_offsets
    """
    out = {}
    gun = descr.gun if gun is None else gun
    try: out['gunPitchSpeed'] = float(gun.rotationSpeed)
    except Exception: pass
    try:
        offsets = shot_offsets(descr, gun)
        if offsets: out['shotOffsets'] = offsets
    except Exception:
        pass
    return out


def metres(value):
    """A length to 0.1 mm, never -0.0."""
    return round(float(value), 4) + 0.0


def shot_offsets(descr, gun=None):
    """Where the shells leave, from the gun's joint, in the turret's frame (metres, x right, y up, z forward), or None.

    VehicleGunRotator.__getShotPosition puts the shell's start at turretMatrix.applyPoint(gunOffset): the turret turned
    by its yaw only - the gun's pitch does not move it - where gunOffset is descr.activeGunShotPosition =
    turret.gunPosition + gun.shotOffset (VehicleDescriptor.__set_activeTurretPos), or, while one barrel of a
    multi-barrel gun is the active one, that barrel's multiGun[i].shotPosition = position + shotOffset
    (switchActiveGun; _readMultiGun). The client makes a barrel the active one only on a vehicle flagged
    isDualgunVehicle or isTwinGunVehicle (switchActiveGun 1163-1167, multiGunCurrentShotPosition) and for a gun that
    is not the main one (__getGunInstallationShotsInfo); the twin AUTOMATIC guns (Tesak, Blesk, Squall, Selma, PGZ-70)
    and the SH copies of KV-13 / AMX 35 have a multiGun but fire from the joint + gun.shotOffset (review 26.09 D1: all
    629 Tesak tracers of the owner's records carry gunIndex 0 and start where the one before did). So: one offset per
    barrel, shotPosition - turret.gunPosition, in their order, for those guns; gun.shotOffset otherwise - written only
    when it is not zero (212 vehicles of client 2.4.0.1, up to 0.88 m ahead of the joint; a barrel of a multi-barrel
    gun sits up to 2.07 m from it, J48 Saryuda's 127 mm pair behind the trunnions).
    """
    main = gun is None or gun is descr.gun
    gun = descr.gun if gun is None else gun
    joint = descr.turret.gunPosition
    barrels = getattr(gun, 'multiGun', None)
    if barrels and (not main or getattr(descr, 'isDualgunVehicle', False) or getattr(descr, 'isTwinGunVehicle', False)):
        return [[metres(p.x - joint.x), metres(p.y - joint.y), metres(p.z - joint.z)]
                for p in (barrel.shotPosition for barrel in barrels)]
    offset = gun.shotOffset
    values = [metres(offset.x), metres(offset.y), metres(offset.z)]
    return [values] if any(values) else None


def fix_gun_statics(vehicle):
    """Give the aim blocks of an older record the fields of gun_statics (26.09); True when it did.

    Each block gets them from ITS mode's descriptor, as fix_yaw_limits gives it the sector: 'aim' the one of
    vehicleMode, 'modeAim' the one of modeAimMode, both off the compact descriptor vehicle_descr keeps built - a few
    attribute reads per block. Nothing without a compact descriptor, for a descriptor the running client cannot build or
    one of another type. The raw record is never touched: a battle gets them again on each publish; an exported
    vehicle file is written back by its caller once (load_vehicles).
    """
    blocks = [(block, mode) for block, mode in ((vehicle.get('aim'), vehicle.get('vehicleMode')),
                                                (vehicle.get('modeAim'), vehicle.get('modeAimMode')))
              if isinstance(block, dict) and positive(block.get('dispersion'))
              and not [key for key in GUN_STATIC_KEYS if key in block or key in (block.get('unavailable') or ())]]
    if not blocks or not vehicle.get('compactDescriptor'):
        return False
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        if vehicle.get('type') and str(descr.type.name) != str(vehicle.get('type')):
            return False
    except Exception:
        return False
    filled = False
    for block, mode in blocks:
        try:
            statics = gun_statics(mode_descr(descr, mode))
        except Exception:
            continue
        if statics:
            block.update(statics)
            filled = True
    return filled


def fix_yaw_limits(vehicle):
    """Give the complete aim blocks of an older record the gun's sector (23.09, BACKLOG 40); True when it did.

    A block is complete without it - aim_block writes it only for a gun that has one - so it never decides that a
    block needs the rebuild of fix_aim. Each block gets the sector of its OWN mode: 'aim' the one of vehicleMode (the
    descriptor the client handed the recorder), the second mode's 'modeAim' (BACKLOG 35 B5) the one of modeAimMode -
    one attribute of that mode's gun, from the compact descriptor vehicle_descr keeps built. Nothing for a
    full-circle turret, a descriptor the running client cannot build or one that names another type than the record
    (ids that moved between clients), so a stranger's sector never stops a chase.

    An exported vehicle file ('exportedAt') carries its gun's sector itself, top level, from the very descriptor its
    block was built from - the vehicle export has written it since 0.6.35, and only for a gun that has one - so its
    pair is copied and no descriptor is built: a full-circle vehicle gets nothing filled, and load_vehicles would
    otherwise rebuild every such descriptor of the catalogue on every start. The raw record of a battle is never
    touched: it gets the sector again on each publish, where the descriptor is built for the hit's other fixes anyway.
    """
    blocks = [(block, mode) for block, mode in ((vehicle.get('aim'), vehicle.get('vehicleMode')),
                                                (vehicle.get('modeAim'), vehicle.get('modeAimMode')))
              if isinstance(block, dict) and positive(block.get('dispersion')) and 'turretYawLimits' not in block]
    if not blocks:
        return False
    if 'exportedAt' in vehicle:
        limits = vehicle.get('turretYawLimits')
        if not isinstance(limits, (list, tuple)) or len(limits) != 2:
            return False
        for block, _ in blocks:
            block['turretYawLimits'] = [float(item) for item in limits]
        return True
    if not vehicle.get('compactDescriptor'):
        return False
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        if vehicle.get('type') and str(descr.type.name) != str(vehicle.get('type')):
            return False
    except Exception:
        return False
    filled = False
    for block, mode in blocks:
        try:
            limits = yaw_limits(mode_descr(descr, mode))
        except Exception:
            continue
        if limits is not None:
            block['turretYawLimits'] = limits
            filled = True
    return filled


def mode_descr(descr, mode):
    """The descriptor of one mode of a vehicle built twice (VEHICLE_MODE 0 default, 1 siege), else descr itself.

    The two built descriptors of CompositeVehicleDescriptor (docs/KNOWLEDGE.md 4), read as mode_aim_block of the
    recorder reads them - onSiegeStateChanged is never called, so the cached descriptor never switches its mode.
    """
    if mode in (0, 1) and getattr(descr, 'hasSiegeMode', False):
        return getattr(descr, 'siegeVehicleDescr' if mode == 1 else 'defaultVehicleDescr', None) or descr
    return descr


def mode_aim_block(descr):
    """Both modes' aim blocks of a vehicle that is built twice (23.09, BACKLOG 35 B5 'modeAim').

    The second descriptor changes the circle far more often than the shells: 34 of the client's 79
    `*_siege_mode.xml` differ from their base in shotDispersionRadius, aimingTime, reloadTime or the
    dispersion factors (the Strv 107-12 0.29 -> 0.24 m/100 m and 3.0 -> 1.0 s, the Contriver's salvo mode
    0.33 -> 1.1 and afterShot 4 -> 8) - docs/KNOWLEDGE.md section 4; since the fields of aim_mode_fields (23.09) the
    32 vehicles with hull aiming differ at least in hullAiming.enabled. The recorder writes the other block beside the
    shooter's 'aim' (always DEFAULT for somebody else's vehicle), exactly as modeShells: read ONCE per battle per
    descriptor object (Recorder.mode_blocks), written only where the two blocks differ, shared by reference like every
    static vehicle field. The characteristics file writes the siege one per pair (ttx_pair) - one function for both.

    Same contract as the recorder's mode_shell_block: None for an ordinary vehicle (one attribute read), else
    {'default': block, 'siege': block, 'same': bool}; onSiegeStateChanged is never called here.
    """
    if not getattr(descr, 'hasSiegeMode', False): return None
    siege = getattr(descr, 'siegeVehicleDescr', None)
    default = getattr(descr, 'defaultVehicleDescr', None)
    if siege is None or default is None: return None
    first, second = aim_block(default), aim_block(siege)
    return {'default': first, 'siege': second, 'same': first == second}

# The first recorder that wrote the shooter's aim block live, from the arena's descriptor (0.7.14).
LIVE_AIM_SINCE = (0, 7, 14)
SHOOTER_AIM_WARNING = 'Shooter aim parameters unavailable'


def version_tuple(text):
    """(0, 7, 14) out of '0.7.14', None when the text holds no number."""
    parts = re.findall(r'\d+', str(text or ''))[:3]
    return tuple(int(part) for part in parts) if parts else None


def stamp_aim_origin(hit, raw, battle):
    """Say on each published aim block which descriptor it came from: 'arena' or 'compact' (S3, 22.09).

    The rule of the independent check of outputs/vehicle-classes-modes-2026-09-21.md: the shooter's
    block of a record by recorder 0.7.14 or later, unless that hit carries the warning that the
    block could not be read, was taken live from arena.vehicles[id]['vehicleType'] - the descriptor
    built with the battle's extData, so it already holds the field modifications, the battle
    modifiers and, for the player's own shots, his devices. Every other block is fix_aim's rebuild
    from the compact descriptor: no extData, and only the devices the descriptor packs. The raw
    record decides, not the published copy, which fix_aim may have filled in the meantime.

    A live block also gets 'compactFactors' (compact_factors): the same four miscAttrs factors of the
    vehicle's compact descriptor rebuilt without extData - the packed devices and nothing else. The
    page divides the live block's factors by them, which takes out the devices its configurator
    applies itself and keeps the field modifications, which it cannot add back. Published copy only;
    left out when the descriptor cannot be rebuilt (a type the client no longer has).
    """
    version = version_tuple((battle or {}).get('recorderVersion'))
    warned = SHOOTER_AIM_WARNING in ((raw or {}).get('warnings') or [])
    for side in ('attacker', 'target'):
        vehicle = hit.get(side) or {}
        aim = vehicle.get('aim')
        if not isinstance(aim, dict):
            continue
        recorded = ((raw or {}).get(side) or {}).get('aim')
        live = (side == 'attacker' and isinstance(recorded, dict) and positive(recorded.get('dispersion'))
                and version is not None and version >= LIVE_AIM_SINCE and not warned)
        aim['aimFrom'] = 'arena' if live else 'compact'
        if live:
            factors = compact_factors(vehicle)
            if factors:
                aim['compactFactors'] = factors


# The four miscAttrs factors of an aim block, by the block's name and the client's (aim_block).
AIM_MISC_FACTORS = (('multFactor', 'multShotDispersionFactor'), ('additiveFactor', 'additiveShotDispersionFactor'),
                    ('aimingTimeFactor', 'gunAimingTimeFactor'), ('reloadTimeFactor', 'gunReloadTimeFactor'))


def compact_factors(vehicle):
    """The four miscAttrs factors of a recorded vehicle's compact descriptor, or None (S3 review, 22.09).

    Rebuilt without the battle's extData, so they hold the devices the descriptor packs - the player's
    own, since the server strips them from everybody else's (outputs/vehicle-classes-modes-2026-09-21.md
    2.5) - and no field modifications: makeCompactDescr does not pack them. Built by vehicle_descr and so
    cached; None when the descriptor cannot be rebuilt or names another type than the record (ids that
    moved between clients), so the page never divides by a stranger's factors. Never raises.
    """
    try:
        descr = vehicle_descr(vehicle['compactDescriptor'])
        if str(descr.type.name) != str(vehicle.get('type')):
            return None
        misc = descr.miscAttrs
    except Exception:
        return None
    factors = {}
    for key, attribute in AIM_MISC_FACTORS:
        try:
            value = float(misc[attribute])
        except Exception:
            continue
        if value > 0 and value - value == 0:
            factors[key] = value
    return factors or None


# The first recorder whose aim blocks carry the second mode's fields (aim_mode_fields, 23.09) - the build after 0.7.31.
MODE_FIELDS_SINCE = (0, 7, 32)
AIM_MODE_KEYS = ('staticPitch', 'staticTurretYaw', 'hullAiming', 'siegeMode')
# The numbers that tell which descriptor a recorded block came from: where the two modes differ, the block matches one.
MODE_TELL_KEYS = ('dispersion', 'aimingTime', 'movementFactor', 'rotationFactor', 'turretRotationFactor', 'afterShotFactor',
                  'turretRotationSpeed', 'hullRotationSpeed', 'speedForward', 'speedBackward', 'reloadTime')
# Both modes' blocks per compact descriptor, for the old records of one publish (export thread only, like vehicle_descr).
_MODE_AIMS_CACHE = OrderedDict()


def recorded_mode(aim, aims):
    """0 or 1: the mode whose descriptor a recorded block was built from, by the numbers the two modes' blocks differ
    in; None when no such number matches either mode, or they point both ways. A number that matches neither (a field
    modification that moved a speed, say) says nothing and is passed over."""
    votes = set()
    for key in MODE_TELL_KEYS:
        first, second, value = aims['default'].get(key), aims['siege'].get(key), aim.get(key)
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (first, second, value)) or first == second:
            continue
        near_first = abs(value - first) <= 1e-6 * max(1.0, abs(first))
        near_second = abs(value - second) <= 1e-6 * max(1.0, abs(second))
        if near_first != near_second:
            votes.add(0 if near_first else 1)
    return votes.pop() if len(votes) == 1 else None


def fix_mode_blocks(vehicle, battle):
    """The second modes (23.09, outputs/second-modes-2026-09-23.md 5.1 M3) for a shooter recorded before the recorder
    wrote them; True when it filled something. Only records of a recorder before MODE_FIELDS_SINCE, like
    stamp_aim_origin, and only the published copy: the raw record is never touched.

      1. The recorded 'aim' and 'modeAim' get the fields of aim_mode_fields of their OWN mode's descriptor - 'aim' the
         one of vehicleMode, 'modeAim' the one of modeAimMode - exactly as fix_yaw_limits gives them their sector.
      2. A shooter built twice with no 'modeAim' gets it when the two modes' blocks differ: the mode of the recorded
         block is its vehicleMode where the record has it, else the one whose numbers it matches (recorded_mode; never
         written when it matches neither or both ways), and the other mode's block takes the recorded block's own four
         miscAttrs factors, aimFrom and compactFactors - the field modifications and the battle's modifiers are the
         same in both modes. 'vehicleMode' is not added: the shells of the record read it.

    The descriptor is vehicle_descr's, built for the other fixes of the hit anyway; a type the running client cannot
    build, or one that names another type than the record, gets nothing. Never raises out of a guarded caller.
    """
    if not isinstance(vehicle, dict):
        return False
    version = version_tuple((battle or {}).get('recorderVersion'))
    if version is not None and version >= MODE_FIELDS_SINCE:
        return False
    aim = vehicle.get('aim')
    if not (isinstance(aim, dict) and positive(aim.get('dispersion'))) or not vehicle.get('compactDescriptor'):
        return False
    compact = vehicle['compactDescriptor']
    try:
        descr = vehicle_descr(compact)
        if vehicle.get('type') and str(descr.type.name) != str(vehicle.get('type')):
            return False
    except Exception:
        return False
    filled = False
    for block, mode in ((aim, vehicle.get('vehicleMode')), (vehicle.get('modeAim'), vehicle.get('modeAimMode'))):
        if not (isinstance(block, dict) and positive(block.get('dispersion'))) or any(key in block for key in AIM_MODE_KEYS):
            continue
        try:
            fields = aim_mode_fields(mode_descr(descr, mode))
        except Exception:
            continue
        for key, value in fields.items():
            block[key] = value
            filled = True
    if 'modeAim' in vehicle or not getattr(descr, 'hasSiegeMode', False):
        return filled
    aims = _MODE_AIMS_CACHE.get(compact)
    if aims is None:
        try:
            aims = mode_aim_block(descr) or False
        except Exception:
            aims = False
        _MODE_AIMS_CACHE[compact] = aims
        if len(_MODE_AIMS_CACHE) > 64:
            _MODE_AIMS_CACHE.popitem(last=False)
    if not aims or aims['same'] or not aims.get('default') or not aims.get('siege'):
        return filled
    mode = vehicle.get('vehicleMode')
    if mode not in (0, 1):
        mode = recorded_mode(aim, aims)
    if mode not in (0, 1):
        return filled
    other = 1 - mode
    block = dict(aims['siege' if other == 1 else 'default'])
    block.pop('unavailable', None)
    for key, _ in AIM_MISC_FACTORS:
        if key in aim: block[key] = aim[key]
    for key in ('aimFrom', 'compactFactors'):
        if key in aim: block[key] = aim[key]
    vehicle['modeAim'] = block
    vehicle['modeAimMode'] = other
    return True


PARTS = ('chassis', 'hull', 'turret', 'gun')
# The warning the recorder put on a hit whose target had static collision parts it did not write.
EXTRA_PARTS_WARNING = 'Additional vehicle parts are not yet rendered'


def static_parts(descr):
    """[(collision index, name, component)] of every static collision part the client builds for a vehicle.

    model_assembler.prepareCollisionAssembler: chassis, hull, turret and gun are parts 0-3
    (TankPartNames.ALL), and every track pair after the first - chassis.trackPairs[1:], the OUTER pair of the
    vehicles with double tracks (the Ares, M-II-Y ... M-VII-Y, AHT-7, LTC II) - follows as part
    len(TankPartNames.ALL) + i. Its component is the pair's chassis_components.TrackPair, which carries
    hitTesterManager and materials exactly like the four parts. CommonTankAppearance._connectCollider moves
    those extra parts with the chassis' own matrix, so they sit in the chassis frame (docs/KNOWLEDGE.md 9).
    Wheels are no static part: they lie beyond maxStaticPartIndex and are not listed here.
    """
    parts = [(idx, name, getattr(descr, name, None)) for idx, name in enumerate(PARTS)]
    try:
        pairs = tuple(descr.chassis.trackPairs or ())[1:]
    except Exception:
        pairs = ()
    for number, pair in enumerate(pairs):
        parts.append((len(PARTS)+number, 'trackPair%d' % (number+1), pair))
    return parts


# THE WHEELS OF A WHEELED VEHICLE (BACKLOG 39, 26.09; docs/KNOWLEDGE.md 9). Collision parts -1 ... -N after the static
# ones: DamageFromShotDecoder.convertComponentIndex turns an index above maxStaticPartIndex into maxStaticPartIndex - idx,
# Vehicle.calcMaxComponentIdx counts generalWheelsAnimatorConfig.getNonTrackWheelsCount() of them, and the client reads a
# wheel's armour by the collision's own name alone (vehicle_utils.getMatinfo: chassis.wheelsArmor[getPartName(idx)], the
# common table otherwise). Part -k is the wheel with XML index k-1: the recorder's partName of the two named contacts in
# the records (-4 W_R1, -1 WD_L1 of the EBR 105) and the three earlier ones. The index is the client's own: the wheel's
# material is read with it (_readArmor(..., index) names its extra 'wheel<index>Health').
# The body is procedural (proceduralCollisionBody, the 220 collision wheels of the 35 wheeled chassis all have it): a
# 16-sided prism, radius at its corners, `geometry/width` along the axle, a corner on the part's +y axis - the two rim
# contacts' normals lie exactly on that grid (168.75 and -33.75 degrees, 1e-7) and 0.08 mm off its apothem. Its frame
# carries no spin (a contact's direction through the spinning node would climb at 54 degrees). The wheel sits at its
# `wheelPos` (Wheel.position, what the client reads for it), static in the chassis frame: the recorded node poses fit no
# rest structure, so no pose at impact is taken from them. geometry/pivotXOffset is not a shift of the body: taken as one
# it would put the AMD 178B's front wheels 0.24 m inside the hull; 107 of the 150 wheels' visual nodes sit exactly at
# wheelPos, the EBR 105's middle four 0.1 m further out (docs/KNOWLEDGE.md 9).
WHEEL_EXTRA = re.compile(r'^wheel(\d+)Health\Z')
WHEEL_SIDES = 16


class ExtrasUnavailable(ValueError):
    """The vehicle XML of a type did not read this session (Exporter.type_extras); the reason is its message."""


_wheel_components = {}
_wheel_rows = {}


class WheelArmor(object):
    """One wheel's material as armor.live_materials reads a component: its own material over the common table, as
    vehicle_utils.getMatinfo falls back to it. Kept per material (wheel_armor) so the quick check of live_materials holds."""
    __slots__ = ('material', 'materials')

    def __init__(self, material):
        self.material = material
        self.materials = {material.kind: material}


def wheel_armor(material):
    """The armour table of one wheel from its live MaterialInfo (chassis.wheelsArmor[name])."""
    from .armor import live_materials
    entry = _wheel_components.get(id(material))
    if entry is None or entry.material is not material:
        if len(_wheel_components) >= 512: _wheel_components.clear()
        entry = _wheel_components[id(material)] = WheelArmor(material)
    return live_materials(entry)


def wheel_parts(descr, armor_source='live vehicle descriptor'):
    """[{id, name, material, armor, armorSource}] of every wheel that is a collision part, -1 first; [] for any other vehicle.

    From the descriptor alone (chassis.wheelsArmor, read by the client only for the wheels with an armour section - the
    nonTrack ones): the recorder writes them for both sides of a hit, the vehicle export for its file. The body and the
    place (fill_wheels) come from the vehicle's XML on the export thread, which the game thread never reads.
    """
    try:
        armour = descr.chassis.wheelsArmor
    except Exception:
        return []
    if not armour:
        return []
    # The order and names are the chassis' own: kept per wheelsArmor dictionary (the same entries), so a hit pays only the
    # quick check of each wheel's table (0.06 ms for the EBR 105's eight on the offline stand before, the rows each time).
    cached = _wheel_rows.get(id(armour))
    if cached is not None and cached[0] is armour and cached[1] == armour:
        rows = cached[2]
    else:
        try:
            from material_kinds import NAMES_BY_IDS
        except Exception:
            NAMES_BY_IDS = {}
        rows = []
        for name, material in armour.items():
            extra = getattr(material, 'extra', None)
            if not isinstance(extra, (str, TEXT_TYPE)): extra = getattr(extra, 'name', '')
            match = WHEEL_EXTRA.match(str(extra or ''))
            if match:
                kind = NAMES_BY_IDS.get(getattr(material, 'kind', None))
                rows.append((int(match.group(1)), str(name), material, str(kind) if kind else None))
        rows.sort(key=lambda row: row[0])
        if len(_wheel_rows) >= 256: _wheel_rows.clear()
        _wheel_rows[id(armour)] = (armour, dict(armour), rows)
    parts = []
    for index, name, material, kind in rows:
        part = {'id':-(index+1), 'name':name}
        if kind: part['material'] = kind
        try:
            part['armor'] = wheel_armor(material)
            part['armorSource'] = armor_source
        except Exception:
            pass
        parts.append(part)
    return parts


def wheeled_types():
    """The client's wheeled vehicle types (their 'wheeledVehicle' tag in items.vehicles.g_list, what VehicleType reads
    isWheeledVehicle from), None outside the game. One pass over the list, no descriptor built."""
    try:
        import nations
        from items import vehicles as client_vehicles
        found = set()
        for nation_id in range(len(nations.NAMES)):
            listing = client_vehicles.g_list.getList(nation_id) or {}
            for item in listing.values():
                if 'wheeledVehicle' in tuple(getattr(item, 'tags', ()) or ()): found.add(str(item.name))
        return found
    except Exception:
        return None


def wheel_shapes(tree, chassis_name):
    """{name: {'index', 'wheel': {radius, width, sides}, 'transform'}} of the collision wheels of one chassis of a vehicle
    XML (the client's own file, ArmorCatalog.xml): nonTrack wheels with a procedural body, as chassis_readers reads them -
    `radius` or else `geometry/radius`, `wheelPos` - and the width the native body takes. A wheel short of any of them is
    left out, never guessed."""
    shapes = {}
    chassis = tree.find('chassis/' + chassis_name) if chassis_name else None
    wheels = chassis.find('wheels') if chassis is not None else None
    if wheels is None:
        return shapes
    flag = lambda node, key: (node.findtext(key) or '').strip().lower() == 'true'
    for node in wheels.findall('wheel'):
        try:
            if not flag(node, 'nonTrack') or not flag(node, 'proceduralCollisionBody'): continue
            name = (node.findtext('name') or '').strip()
            index = int((node.findtext('index') or '').strip())
            radius = float(node.findtext('radius') if node.find('radius') is not None else node.findtext('geometry/radius'))
            width = float(node.findtext('geometry/width'))
            position = [float(x) for x in node.findtext('wheelPos').split()]
            if not name or len(position) != 3 or not (radius > 0 and width > 0): continue
        except (TypeError, ValueError, AttributeError):
            continue
        shapes[name] = {'index':index, 'wheel':{'radius':radius, 'width':width, 'sides':WHEEL_SIDES},
                        'transform':translation_columns(position)}
    return shapes


def fill_wheels(vehicle, shapes):
    """Give each wheel part of a vehicle block (id < 0, no body yet) its body and its rest place from wheel_shapes, when the
    XML's wheel of that name has the index the part stands for. Returns how many were filled; the rest stay as recorded."""
    filled = 0
    for part in (vehicle or {}).get('parts') or []:
        if not isinstance(part, dict) or not isinstance(part.get('id'), int) or part['id'] >= 0 or 'wheel' in part:
            continue
        shape = shapes.get(part.get('name'))
        if not shape or shape['index'] != -part['id']-1:
            continue
        part['wheel'] = dict(shape['wheel'])
        part['transform'] = list(shape['transform'])
        # Its place at rest, not a pose of the hit: the page anchors the shot's line on a part posed at impact.
        part['poseFrom'] = 'rest'
        filled += 1
    return filled


# ARMOURED PREFABS (27.09, task prefab-parts; docs/KNOWLEDGE.md 9). Two of the client's 287 vehicle prefabs carry armour
# and a collider of their own: the CAV mod. 71's crest (its gun's slotPrefabs/crest_module ->
# content/CGFPrefabs/Vehicle/dynamic_parts/italy/it43_CAV_mod_71_crest.prefab) and the AS-XX 40 t's containers (the hull's
# slotPrefabs/HP_pod -> .../france/F135_stationary_reload.prefab). A prefab is a JSON tree of CGF objects: the one with
# BW::Colliders (MeshColliderDesc.modelName - a collision_client model like any part's), BW::ArmorComponent (its own
# materials by numeric kind, every field written out) and the client's BW::DynamicCollisionLinker (which gives the collider
# a collision index above maxStaticPartIndex - DamageFromShotDecoder.getPartIndexByNetworkID) is the armoured part, in the
# prefab's 'normal' state (BW::StateSwitcherComponent; the 'crash' one is the same model and armour). Its place: the parent
# part x the slot (the component's objectSlots/slot of that name: a position, no rotation on either carrier) x the
# TransformComponents from the prefab's root down to the collider, each at the end of the root's active SequenceComponent
# layer where a track moves it - the crest's four "N position layer"s turn it 0, 3.3, 6.6, 9.9 degrees about x, the
# containers' 'closing' ends at 0 and 'opening' at 70. Degrees; a positive turn about x lowers +z and lifts -z, the sense of
# the client's own gun pitch (rest_columns) and the one that lifts the containers when they open (their "pods_move_up"
# sound) - inferred. A node turned about another axis, or scaled, on that path is refused, never guessed.
PREFAB_ROOT = 'content/CGFPrefabs/Vehicle/'
# data/<this>: the collider folders of the armoured prefabs, per client version (Exporter.run_prefab_check).
PREFAB_FOLDERS = 'prefab-folders.json'
PREFAB_MARK = PREFAB_ROOT.encode('ascii')
PREFAB_LIMIT = 1024*1024
PREFAB_KINDS = (('script::CrestMovingSequenceParamsComponent', 'crest'),
                ('script::StationaryReloadSequenceParamsComponent', 'containers'))
PREFAB_FLAGS = ('useHitAngle', 'mayRicochet', 'collideOnceOnly', 'checkCaliberForRicochet', 'checkCaliberForHitAngleNorm')
PREFAB_ARMOR_SOURCE = 'client prefab (ArmorComponent)'


def rotation_x_columns(degrees):
    """A turn of `degrees` about x in translation_columns' layout: +y towards +z for a positive angle (rest_columns' gun pitch)."""
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0]


def multiply_columns(a, b):
    """a x b of two column-major 4x4 matrices (translation_columns' layout): b applied first."""
    return [sum(a[k*4+row] * b[col*4+k] for k in range(4)) for col in range(4) for row in range(4)]


def turn_x(matrix):
    """The turn about x (degrees) of a matrix whose rotation is one."""
    return math.degrees(math.atan2(matrix[6], matrix[5]))


def prefab_objects(data):
    """{uuid: (object, parent uuid)} of a prefab's JSON tree, and its root's uuid."""
    found = {}

    def walk(node, parent):
        if isinstance(node, dict):
            if 'components' in node:
                found[node.get('uuid')] = (node, parent)
                parent = node.get('uuid')
            for key, value in node.items():
                if key != 'components': walk(value, parent)
        elif isinstance(node, list):
            for value in node: walk(value, parent)
    root = data.get('objects') or {}
    walk(root, None)
    return found, root.get('uuid')


def sequence_end(root, layer_name=None):
    """What the root's SequenceComponent sets at the end of a layer - the active one, or the one named - as {object uuid:
    {'rotation'|'position': {axis: value}}}, and the layer's name. TransformComponent tracks only."""
    sequence = (root.get('components') or {}).get('BW::SequenceComponent') or {}
    layers = sequence.get('layers') or []
    index = None
    if layer_name is None:
        index = int(sequence.get('activeLayer') or 0)
    else:
        for number, layer in enumerate(layers):
            if layer.get('name') == layer_name: index = number
    if index is None or not 0 <= index < len(layers): return {}, None
    state = {}
    for track in layers[index].get('tracks') or []:
        for parameter in track.get('parameters') or []:
            if parameter.get('component') != 'cgf::TransformComponent' or not parameter.get('keys'): continue
            path = [p.get('__cvalue__') if isinstance(p, dict) else p for p in parameter.get('property') or []]
            if not path or path[0] not in ('rotation', 'position'): continue
            value = parameter['keys'][-1].get('value')
            value = value.get('__cvalue__', value) if isinstance(value, dict) else value
            slot = state.setdefault(track.get('object'), {}).setdefault(path[0], {})
            if len(path) == 1 and isinstance(value, dict):
                slot.update(dict((axis, float(value.get(axis) or 0.0)) for axis in 'xyz'))
            elif len(path) == 2 and path[1] in ('x', 'y', 'z'):
                slot[path[1]] = float(value)
    return state, layers[index].get('name')


def prefab_local(node, moved):
    """One object's local matrix: its TransformComponent with what the sequence set over it."""
    transform = (node.get('components') or {}).get('cgf::TransformComponent') or {}
    position = dict((axis, float((transform.get('position') or {}).get(axis) or 0.0)) for axis in 'xyz')
    rotation = dict((axis, float((transform.get('rotation') or {}).get(axis) or 0.0)) for axis in 'xyz')
    position.update((moved or {}).get('position') or {})
    rotation.update((moved or {}).get('rotation') or {})
    if abs(rotation['y']) > 1e-9 or abs(rotation['z']) > 1e-9: raise ValueError('Prefab node turned about y or z')
    if any(abs(float(v) - 1.0) > 1e-9 for v in (transform.get('scale') or {}).values()): raise ValueError('Scaled prefab node')
    return multiply_columns(translation_columns([position['x'], position['y'], position['z']]), rotation_x_columns(rotation['x']))


def prefab_spec(data, names_by_ids):
    """The armoured part of one prefab (its parsed JSON), or None when it has none: {'resource', 'armor', 'kind', 'transform'
    (the collider in the prefab root's frame at the default layer), 'layer' (that layer's name), 'layers': [{'name', 'angle'}]
    (every named layer's turn about x against the default)}. Raises on what it does not understand."""
    objects, root_id = prefab_objects(data)
    root = objects.get(root_id, (None, None))[0]
    if root is None: return None
    components = root.get('components') or {}

    def armoured(node):
        found = node.get('components') or {}
        linker = found.get('BW::DynamicCollisionLinker')
        return ('BW::Colliders' in found and 'BW::ArmorComponent' in found and linker is not None
                and 'Client' not in (linker.get('disabledDomains') or ()))

    def under(uuid, ancestor):
        while uuid is not None:
            if uuid == ancestor: return True
            uuid = objects.get(uuid, (None, None))[1]
        return False
    colliders = [uuid for uuid, (node, _) in objects.items() if armoured(node)]
    normal = (components.get('BW::StateSwitcherComponent') or {}).get('normal')
    if normal and any(under(uuid, normal) for uuid in colliders):
        colliders = [uuid for uuid in colliders if under(uuid, normal)]
    if not colliders: return None
    if len(colliders) != 1: raise ValueError('Several armoured colliders in one prefab')
    found = objects[colliders[0]][0]['components']
    models = [(c.get('__cvalue__') or {}).get('modelName') for c in (found['BW::Colliders'].get('colliders') or [])
              if isinstance(c, dict)]
    if len(models) != 1 or not RESOURCE.match(str(models[0] or '')): raise ValueError('Prefab collider model not understood')
    armour = {}
    for material in found['BW::ArmorComponent'].get('materials') or []:
        name = names_by_ids.get(int(material['kind']))
        if not name: raise ValueError('Unknown prefab material kind %s' % material.get('kind'))
        value = dict((flag, str(material.get(flag, '0')).strip().lower() in ('1', 'true')) for flag in PREFAB_FLAGS)
        value['useArmorHomogenization'] = False
        # A device (the containers' ammoBay, 0 mm) is walked through, as every device of a hull is: no armour of its own.
        value['armor'] = None if str(material.get('damageKind') or '').upper() == 'DEVICE' else float(material['armor'])
        value['vehicleDamageFactor'] = float(material.get('vehicleDamageFactor') or 0.0)
        value['chanceToHitByProjectile'] = float(material.get('chanceToHitByProjectile') or 1.0)
        armour[str(name)] = value
    path, uuid = [], colliders[0]
    while uuid is not None:
        path.append(uuid)
        uuid = objects[uuid][1]
    path.reverse()

    def placed(layer_name=None):
        moved, name = sequence_end(root, layer_name)
        matrix = translation_columns([0.0, 0.0, 0.0])
        for step in path: matrix = multiply_columns(matrix, prefab_local(objects[step][0], moved.get(step)))
        return matrix, name
    transform, layer = placed()
    base = turn_x(transform)
    layers = []
    for entry in (components.get('BW::SequenceComponent') or {}).get('layers') or []:
        if entry.get('name'): layers.append({'name':entry['name'], 'angle':round(turn_x(placed(entry['name'])[0]) - base, 4)})
    kind = next((label for component, label in PREFAB_KINDS if component in components), None)
    return {'resource':str(models[0]), 'armor':armour, 'kind':kind, 'transform':transform, 'layer':layer, 'layers':layers}


def slot_prefabs(tree):
    """[(parent part index, component name, slot, prefab path, slot matrix or None)] of a vehicle XML: every slotPrefabs entry
    of its hull, chassis, turrets and guns with the place its objectSlots/slot gives (None when the slot has no place or
    a turned one - that prefab is then left out, never placed by guess)."""
    found = []

    def scan(node, parent, name):
        prefabs = node.find('slotPrefabs') if node is not None else None
        if prefabs is None: return
        slots = dict(((s.findtext('name') or '').strip(), s) for s in node.findall('objectSlots/slot'))
        for entry in prefabs:
            path, slot, place = (entry.text or '').strip(), slots.get(entry.tag), None
            try:
                position = [float(x) for x in slot.findtext('position').split()]
                rotation = [float(x) for x in (slot.findtext('rotation') or '0 0 0').split()]
                if len(position) == 3 and not any(abs(r) > 1e-9 for r in rotation): place = translation_columns(position)
            except (AttributeError, ValueError):
                place = None
            found.append((parent, name, entry.tag, path, place))
    scan(tree.find('hull'), 1, 'hull')
    for group, parent in (('chassis', 0), ('turrets0', 2)):
        for node in (tree.find(group) if tree.find(group) is not None else ()):
            scan(node, parent, node.tag)
            if parent == 2:
                for gun in (node.find('guns') if node.find('guns') is not None else ()): scan(gun, 3, gun.tag)
    return found


def descriptor_slots(descr):
    """[(parent part index, slot, prefab path)] of the slotPrefabs of a descriptor's mounted chassis, hull, turret and gun -
    attribute reads only (the recorder names a prefab contact with it; a vehicle export reads the XML only when it has any)."""
    found = []
    for index, name in ((0, 'chassis'), (1, 'hull'), (2, 'turret'), (3, 'gun')):
        try:
            for slot, prefab in tuple(getattr(getattr(descr, name), 'slotPrefabs', ()) or ()):
                found.append((index, str(slot), str(prefab)))
        except Exception:
            pass
    return found


def prefab_components(descr):
    """{parent part index: the name its XML component has} of a descriptor: which gun, turret and chassis are mounted."""
    names = {1:'hull'}
    for index, attribute in ((0, 'chassis'), (2, 'turret'), (3, 'gun')):
        try:
            names[index] = str(getattr(descr, attribute).name)
        except Exception:
            pass
    return names


def migration_request(record):
    """What a migration keeps of an exported file to export it again (review of d1b372b: not the whole record, which
    holds every part's armour): the request the file answers - type, compact descriptor, source, identity."""
    identity = record.get('identity') if isinstance(record.get('identity'), dict) else dict(
        (key, record.get(key)) for key in ('name', 'level', 'class', 'role', 'nation'))
    return {'vehicleType':str(record.get('vehicleType') or record.get('type') or ''),
            'compactDescriptor':record.get('compactDescriptor'), 'source':record.get('source'), 'identity':identity}


def collision_folders(record):
    """The collision_client folders the models of an exported file's parts lie in (one, as a rule)."""
    found = set()
    for part in record.get('parts') or ():
        resource = str(part.get('resource') or '') if isinstance(part, dict) else ''
        if '/collision_client/' in resource: found.add(resource.rsplit('/collision_client/', 1)[0] + '/collision_client/')
    return sorted(found)


def prefab_statics(entry):
    """What a prefab part has whatever its pose: its slot, prefab, parent, model, armour, layers and `prefabBase` - the slot x
    the collider at the default layer, in the parent part's frame. The page turns a recorded pose into a layer and an angle
    against it (ArmorInspectorData.prefabPose); nothing of the pose is kept here, so every hit shares one static block."""
    spec = entry['spec']
    return {'name':entry['slot'], 'prefab':entry['prefab'], 'prefabKind':spec['kind'], 'parentPart':entry['parent'],
            'resource':spec['resource'], 'armor':copy.deepcopy(spec['armor']), 'armorSource':PREFAB_ARMOR_SOURCE,
            'prefabLayers':[dict(layer) for layer in spec['layers']], 'prefabDefault':spec['layer'],
            'prefabBase':multiply_columns(entry['place'], spec['transform'])}


def prefab_part(entry, parent_transform, part_id):
    """A prefab part at its default layer on a parent placed at `parent_transform` (a vehicle export)."""
    part = {'id':part_id}
    part.update(prefab_statics(entry))
    part['poseFrom'] = 'default'
    part['transform'] = multiply_columns(list(parent_transform), part['prefabBase'])
    return part


def fill_prefab(part, entry):
    """A prefab part the recorder wrote (its collision index, slot, parent and pose at the hit) gets the rest."""
    part.update(prefab_statics(entry))
    return part


def translation_columns(offset):
    """The column-major layout the recorder's matrix_columns writes, without rotation.

    Three axis columns, each with a trailing 0.0, then the offset with a trailing 1.0.
    """
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            float(offset[0]), float(offset[1]), float(offset[2]), 1.0]


def fix_fitment(vehicle):
    """Add the fitment fields to a record written before the recorder knew them.

    The twin of fix_aim above: what a vehicle may mount does not depend on the battle, so an
    old record can pick it up from the client's own cache instead of being fired at again.
    Returns True when it filled something, so a caller that owns a file on disk can rewrite it.
    """
    if not isinstance(vehicle, dict):
        return False
    if vehicle.get('tags') is not None:
        return False
    type_name = vehicle.get('type')
    if not type_name:
        return False
    try:
        from items import vehicles
        nation_id, innation_id = vehicles.g_list.getIDsByName(str(type_name))
        vtype = vehicles.g_cache.vehicle(nation_id, innation_id)
        tags = tuple(vtype.tags)
    except Exception:
        return False
    block = fitment_block(vtype, tags)
    if not block:
        return False
    vehicle.update(block)
    return True


_descr_cache = threading.local()
DESCR_CACHE_LIMIT = 128


def vehicle_descr(compact_descriptor):
    """The client's own VehicleDescr for a recorded base64 compact descriptor.

    Publishing runs inside the game (the exporter is imported by the mod), so
    items.vehicles is available; outside it this raises, and every caller is guarded.

    Memoised per thread by the descriptor string, least recently used out after 128: every fix_*
    of a hit used to build its own descriptor, some 70 builds per distinct descriptor on a setup
    and three per new hit. The descriptor is always built by the running client, so the
    string alone is the key, and only a successful build is kept. Callers only read it; the
    one that installs components (top_descriptor) builds its own.
    """
    import base64
    from items import vehicles
    factory = vehicles.VehicleDescr
    cache = getattr(_descr_cache, 'values', None)
    if cache is None:
        cache = _descr_cache.values = OrderedDict()
    try:
        entry = cache.pop(compact_descriptor, None)
    except TypeError:
        entry = None
    if entry is not None and entry[0] is factory:
        cache[compact_descriptor] = entry
        return entry[1]
    descr = factory(compactDescr=base64.b64decode(compact_descriptor))
    try:
        cache[compact_descriptor] = (factory, descr)
        if len(cache) > DESCR_CACHE_LIMIT:
            cache.popitem(last=False)
    except TypeError:
        pass
    return descr


def rest_columns(descr):
    """The column-major transforms of the four static parts in the rest pose, in the chassis frame - the one writer of
    the rest pose for the recorder's shooter (rest_transforms), the vehicle export and the parts of an old record.

    The client's own stacking (vehicles.py VehicleDescr.__updateAttributes): chassis at the origin, the hull at
    chassis.hullPosition, the turret at hull.turretPositions[0] above it, the gun at turret.gunPosition above that.
    A gun with a static pitch (23.09, second modes M5: the Strv 103-0, 103B and S1 hold theirs 1 degree up, gun.staticPitch
    -1 degree in the client's sign) is drawn in it, as the client's garage and its own vehicle draw it
    (HangarVehicleAppearance, VehicleGunRotator): a rotation about the gun's X axis by the client's pitch, positive
    down - the sense the page's pose gives the gun (viewer.poseExtra). Every other part is a pure translation.
    """
    hull = descr.chassis.hullPosition
    turret = hull + descr.hull.turretPositions[0]
    gun = turret + descr.turret.gunPosition
    columns = [translation_columns(offset) for offset in ((0.0, 0.0, 0.0), hull, turret, gun)]
    try:
        pitch = getattr(descr.gun, 'staticPitch', None)
        if pitch:
            c, s = math.cos(float(pitch)), math.sin(float(pitch))
            columns[3][4:12] = [0.0, c, s, 0.0, 0.0, -s, c, 0.0]
    except Exception:
        pass
    return columns


def part_resource(component):
    """The collision model of one static part: the resource its active hit tester reads (parts_from_descr, the model sweep)."""
    return component.hitTesterManager.activeHitTester.bspModelName


def parts_from_descr(descr, armor_source='client descriptor rebuilt from the record'):
    """A vehicle descriptor in, its collision parts out - no battle record involved.

    The parts are placed in the rest pose in the chassis frame, the way the client
    itself stacks them (vehicles.py VehicleDescr.__updateAttributes) and the way the
    recorder now writes the shooter's parts: chassis at the origin, hull at
    chassis.hullPosition, turret at hull.turretPositions[0] above it, gun at
    turret.gunPosition above that, no rotation. An extra track pair (static_parts)
    takes the chassis' place, as the client connects it.

    Kept as a function of a descriptor alone on purpose: the planned vehicle browser
    (any vehicle of the client, picked by tier / nation / class / role) needs parts for
    a descriptor that never took part in a battle, and this is the whole of what it
    needs. Failures are per part, like the recorder's.
    """
    from .armor import live_materials
    transforms = rest_columns(descr)
    parts = []
    for idx, name, component in static_parts(descr):
        part = {'id':idx, 'name':name}
        try:
            part['armor'] = live_materials(component)
            part['armorSource'] = armor_source
        except Exception:
            pass
        try:
            part['resource'] = part_resource(component)
            part['transform'] = list(transforms[idx] if idx < len(transforms) else transforms[0])
        except Exception:
            part['error'] = 'Part model or transform unavailable'
        parts.append(part)
    return parts


def fix_extra_parts(hit):
    """The outer track pair of a double-track target recorded before the recorder wrote it.

    Such a target carries parts 0-3 and the warning EXTRA_PARTS_WARNING, and the page withheld its whole
    scene. The pair is static and fully known from the recorded compact descriptor (static_parts), and the
    client moves it with the chassis' own matrix (CommonTankAppearance._connectCollider), so its recorded
    pose IS the recorded chassis transform: nothing is guessed. A contact the client resolved on that part
    was kept as 'unsupported-part' with its position already in the part's frame; it becomes 'resolved'.
    Gated by the warning alone, so no other hit costs a descriptor. The caller passes only hits of the
    running client's version: a model of another version is never extracted (model_extract). A failure
    leaves the hit as recorded, warning included.
    """
    warnings = hit.get('warnings')
    target = hit.get('target')
    if not isinstance(warnings, list) or EXTRA_PARTS_WARNING not in warnings or not isinstance(target, dict):
        return False
    parts = target.get('parts')
    if not isinstance(parts, list) or not target.get('compactDescriptor'):
        return False
    chassis = [part for part in parts if isinstance(part, dict) and part.get('id') == 0 and part.get('transform')]
    if not chassis:
        return False
    try:
        descr = vehicle_descr(target['compactDescriptor'])
        if str(descr.type.name) != str(target.get('type')):
            return False
        known = set(part.get('id') for part in parts if isinstance(part, dict))
        added = [part for part in parts_from_descr(descr) if part['id'] >= len(PARTS) and part['id'] not in known]
    except Exception:
        return False
    if not added or any('resource' not in part for part in added):
        return False
    for part in added:
        part['transform'] = list(chassis[0]['transform'])
        parts.append(part)
    ids = set(part['id'] for part in added)
    for point in hit.get('points') or []:
        if (isinstance(point, dict) and point.get('status') == 'unsupported-part' and point.get('part') in ids
                and point.get('position')):
            point['status'] = 'resolved'
    hit['warnings'] = [line for line in warnings if line != EXTRA_PARTS_WARNING]
    return True


def synthesize_parts(vehicle):
    """Add the collision parts of a shooter recorded before 0.6.34.

    Only targets had parts then: nothing of the attacker was needed beyond his name
    and gun. His compact descriptor is recorded, so the exact mounted chassis, hull,
    turret and gun are known. Guarded like everything else here: an old record whose
    parts cannot be rebuilt simply keeps none, and the viewer leaves the swap disabled.
    """
    if not isinstance(vehicle, dict) or vehicle.get('parts') or not vehicle.get('compactDescriptor'):
        return
    try:
        vehicle['parts'] = parts_from_descr(vehicle_descr(vehicle['compactDescriptor']))
        vehicle['partsFrom'] = 'rest pose'
    except Exception:
        LOG.exception('Shooter collision parts could not be rebuilt; the hit is published as recorded')


VEHICLE_TAG_PREMIUM = 'premium'
VEHICLE_TAG_PREMIUM_IGR = 'premiumIGR'
VEHICLE_TAG_COLLECTOR = 'collectorVehicle'
VEHICLE_TAG_SPECIAL = 'special'
CATALOGUE_SKIP_TAGS = ('observer', 'bot')
# settings.json: no setting is read today. exportAllVehicles (the hidden bulk export until 25.09) is replaced by the
# page's Export all models (the model sweep); a file that still sets it is left as it is and one line says so.
DEFAULT_SETTINGS = {}
NON_IDENTIFIER = re.compile(r'[^-a-zA-Z0-9_]')
# constants.BATTLE_MODE_VEHICLE_TAGS of client 2.4.0.1, the fallback when the client's own set cannot be
# read, plus maps_training, which gui Vehicle.isOnlyForMapsTrainingBattles reads outside that set
# (outputs/vehicle-classes-modes-2026-09-21.md, summary point 6). One owner: the recorder's groupTags and the
# catalogue's modeOnly flag (the model sweep leaves those vehicles out) both read group_mode_tags().
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


def vehicle_id(type_name):
    """File id of a client vehicle type name, per the agreed data contract.

    'ussr:R45_IS-7' becomes 'ussr-R45_IS-7': only the first colon turns into a
    dash, everything outside [-A-Za-z0-9_] is replaced. The id is never split
    back apart - the type name travels next to it in every record.
    """
    return NON_IDENTIFIER.sub('_', str(type_name).replace(':', '-', 1))


def descriptor_hash(type_name, compact_descriptor):
    """Identity of one exported configuration: type and descriptor. Not the client version (BACKLOG 55: after 02.10's update
    every vehicle a request named was exported again inside setup, 31 s); whether the file is still this client's is its key's
    business (Exporter.vehicle_current)."""
    identity = '\n'.join((str(type_name or ''), str(compact_descriptor or '')))
    return hashlib.sha256(identity.encode('utf-8')).hexdigest()


def role_labels():
    """Every defined role label of the client, as the tag strings it uses.

    The client derives a vehicle's role from its tags: VehicleType.__getRoleFromTags
    looks for ROLE_TYPE_TO_LABEL[roleType] among the vehicle's own tags. The
    catalogue is built from g_list items, which carry the tags but not a parsed
    role, so the same rule is applied here instead of building a VehicleType (and
    with it parsing the whole XML) for every vehicle of the client.
    """
    try:
        from constants import ROLE_TYPE_TO_LABEL
        return set(label for label in ROLE_TYPE_TO_LABEL.values() if label and label != 'NotDefined')
    except Exception:
        return set()


def shot_candidates(descr, installation=None):
    """Every AP/APCR/HEAT/HE shot of the mounted gun, in the shapes a hit uses; `installation`
    narrows it to one gun slot (0 = the main gun), None lists every slot.

    Kept as a module attribute on purpose: outside the game the client modules are
    missing, and a test can put a fixture in its place.
    """
    from .armor import shot_candidates as candidates
    return candidates(descr, installation=installation)


def gun_limits(descr):
    """Pitch limits of the mounted gun, the same object a hit's target carries."""
    from .presentation import gun_limits as limits
    return limits(descr)


def fitment_block(vtype, tags, tags_read=True):
    """What this vehicle may mount, in the client's own terms.

    The page's aim configuration needs all of it and can derive none of it:

      tags                 the vehicle's own tag list. The eligibility tags in it
                           (tankRammer_class1_user, aimingStabilizer_class2_user, ...) are the
                           client's allow list: a vehicle without them cannot fit that archetype
                           at all, whatever grade. The class and nation tags feed the devices'
                           own <vehicleFilter>.
      supplySlots          the slot types of the vehicle's <supplySlots> (supply_slot_types.xml:
                           1 carries no category, 2 mobility, 3 stealth, 4 firepower,
                           5 survivability, 6 a consumable, 7 the directive, 8 a shell). A standard
                           device is worth its second <valueByLevel> figure only in a slot whose
                           category it shares, so without this the page cannot tell an honest
                           circle from an optimistic one.
      postProgressionTree  which field-modification tree the vehicle has, or '' for none. Role and
                           tier reproduce it for most vehicles and quietly fail for the rest.
      eliteByProgression   separates the tier-XI vehicle-skill trees from the role trees.

      tagsRead             True when the tag list above was read (S3, 22.09; Codex's point in
                           outputs/demand-export-spec-2026-09-21.md): a list that was read is written
                           even when empty, so "no tags" and "the read failed" no longer look alike.
                           False when the caller could not read them; the page then knows nothing
                           about what the vehicle may mount or which mode it was made for.

    Guarded field by field like every other block here: a renamed client attribute costs one
    field, never the export.
    """
    block = {'tagsRead': bool(tags_read)}
    if tags_read:
        block['tags'] = sorted(str(tag) for tag in tags or ())
    try:
        slots = []
        for slot in vtype.supplySlots:
            try:
                slots.append(int(slot))
            except Exception:
                slots.append(int(getattr(slot, 'typeID', getattr(slot, 'id', 0))))
        if slots:
            block['supplySlots'] = slots
    except Exception:
        pass
    try:
        tree = getattr(vtype, 'postProgressionTree', None)
        block['postProgressionTree'] = str(getattr(tree, 'name', tree) or '')
    except Exception:
        pass
    try:
        block['eliteByProgression'] = bool(vtype.eliteByProgression)
    except Exception:
        pass
    return block


def descr_identity(descr):
    """Identity of a VehicleDescr in the shapes of the vehicle contract.

    Every field is read on its own, exactly like the recorder's vehicle_identity:
    a missing or renamed client attribute must cost one field, never the export.
    The tag names are the client's own (gui Vehicle.isPremium/isSpecial read
    VEHICLE_TAGS.PREMIUM 'premium', PREMIUM_IGR 'premiumIGR', SPECIAL 'special';
    isCollectible reads CollectorVehicleConsts.COLLECTOR_VEHICLES_TAG
    'collectorVehicle').
    """
    identity = {}
    vtype = getattr(descr, 'type', None)
    if vtype is None:
        return identity
    try:
        identity['type'] = str(vtype.name)
    except Exception:
        pass
    try:
        identity['name'] = vtype.shortUserString
    except Exception:
        pass
    try:
        identity['level'] = int(vtype.level)
    except Exception:
        pass
    tags, tags_read = (), False
    try:
        tags = tuple(vtype.tags)
        tags_read = True
    except Exception:
        pass
    for tag in tags:
        if tag in VEHICLE_CLASS_TAGS:
            identity['class'] = str(tag)
            break
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
    identity['premium'] = VEHICLE_TAG_PREMIUM in tags or VEHICLE_TAG_PREMIUM_IGR in tags
    identity['collector'] = VEHICLE_TAG_COLLECTOR in tags
    identity['special'] = VEHICLE_TAG_SPECIAL in tags
    identity.update(fitment_block(vtype, tags, tags_read))
    return identity


def catalogue_entry(nation, item, labels):
    """One catalogue row from an items.vehicles.g_list item, or None to skip it.

    g_list items carry name, level, tags and compactDescr, and (on the client)
    an i18n component whose shortString is what VehicleType.shortUserString
    returns. That is everything the catalogue needs, without parsing a vehicle.
    """
    type_name = str(getattr(item, 'name', '') or '')
    if ':' not in type_name:
        return None
    tags = ()
    try:
        tags = tuple(item.tags)
    except Exception:
        pass
    for tag in CATALOGUE_SKIP_TAGS:
        if tag in tags:
            return None
    entry_id = vehicle_id(type_name)
    if not IDENTIFIER.match(entry_id):
        return None
    entry = {'id':entry_id, 'type':type_name, 'nation':nation, 'name':type_name.split(':', 1)[1]}
    try:
        short = item.i18n.shortString
        if short:
            entry['name'] = short
    except Exception:
        pass
    try:
        entry['level'] = int(item.level)
    except Exception:
        return None
    for tag in tags:
        if tag in VEHICLE_CLASS_TAGS:
            entry['class'] = str(tag)
            break
    if 'class' not in entry:
        return None
    for tag in tags:
        if tag in labels:
            entry['role'] = str(tag)
            break
    entry['premium'] = VEHICLE_TAG_PREMIUM in tags or VEHICLE_TAG_PREMIUM_IGR in tags
    entry['collector'] = VEHICLE_TAG_COLLECTOR in tags
    entry['special'] = VEHICLE_TAG_SPECIAL in tags
    # A vehicle made for a battle mode (event, Frontline, Steel Hunter, Onslaught's rentals...): the model sweep leaves
    # it out. Only written when true.
    modes = group_mode_tags()
    if any(tag in modes for tag in tags): entry['modeOnly'] = True
    # An internet-café copy (premiumIGR): the original's model under another name - the model sweep leaves it out too
    # (review 25.09: 47 of them). Only written when true.
    if VEHICLE_TAG_PREMIUM_IGR in tags: entry['igr'] = True
    return entry


def best_component(components):
    """The highest-level component of a list; ties are won by the last candidate."""
    best = None
    for component in components or ():
        if best is None or float(getattr(component, 'level', 0)) >= float(getattr(best, 'level', 0)):
            best = component
    return best


def top_descriptor(type_name):
    """The client's stock descriptor of a vehicle type, raised to its top configuration.

    Deliberately a simple heuristic, used for a vehicle the player does not own
    (a click in the page's list) and by the model sweep: the highest-level chassis, then the highest-level turret
    of turret position 0 with that turret's highest-level gun. The hull is not an
    installable component in this client - the hull variant follows from the
    installed components - so the chassis is what a 'top hull' means here. Engine,
    radio and fuel tank stay stock: they change nothing in the collision model.
    """
    from items import vehicles as client_vehicles
    nation_id, innation_id = client_vehicles.g_list.getIDsByName(type_name)
    descr = client_vehicles.VehicleDescr(typeID=(nation_id, innation_id))
    vtype = descr.type
    try:
        chassis = best_component(vtype.chassis)
        if chassis is not None:
            descr.installComponent(chassis.compactDescr)
    except Exception:
        LOG.warning('Top chassis unavailable for %s; the stock one is kept', type_name)
    try:
        turret = best_component(vtype.turrets[0])
        gun = best_component(turret.guns) if turret is not None else None
        if turret is not None and gun is not None:
            descr.installTurret(turret.compactDescr, gun.compactDescr)
    except Exception:
        LOG.warning('Top turret or gun unavailable for %s; the stock one is kept', type_name)
    return descr


# ------------------------------------------------------------ characteristics (TTX)
# data/ttx/<id>.js: the characteristics panel of the page (outputs/ttx-panel-spec-2026-09-22.md section 2). One
# file per vehicle type and client version, independent of any compact descriptor: every turret x gun pair on
# the top chassis, engine, radio and fuel tank, in client units (rad, m/s, W, kg). Built on the export thread
# only, outside battles, once per type; a file whose schema or client version is not the current one counts as
# missing. The page reads it by the key 'ttx:<id>'.
TTX_SCHEMA = 1
# The second modes' fields (23.09: configs[k].modeAim/modePitch, vehicle.modeValues and rocketAcceleration, the aim
# blocks' hullAiming/siegeMode/static angles). The schema stays 1 - an older page reads the file as before - and a file
# of a vehicle with a second mode or a rocket booster without this marker is rebuilt once (ttx_current).
TTX_MODES_SCHEMA = 1
# The garage's Survivability (23.09): the hull's nominal armour per pair (configs[k].hullArmor), each turret's
# (turrets[i].primaryArmor) and the suspension's repair times (modules.chassis.repairTime). Every file is built
# again once without this marker (ttx_current); an older page ignores the new fields.
TTX_ARMOR_SCHEMA = 1
TTX_CURRENT, TTX_FAILED = 'current', 'failed'
# A clock fine enough for buildMs: time.time() moves in 15.6 ms steps on Windows; time.clock is the
# performance counter there in Python 2.7, perf_counter its successor in 3.
TTX_TIMER = getattr(time, 'perf_counter', None) or time.clock
# The installable modules raised to their best before the pairs are walked: (attribute of the descriptor,
# list on the type). The turret and gun come per pair.
TTX_TOP_MODULES = (('chassis', 'chassis'), ('engine', 'engines'), ('radio', 'radios'), ('fuelTank', 'fuelTanks'))
# THE SWEEP (24.09, user: the characteristics of every catalogue vehicle, also for the page outside the game). Every
# type of the catalogue goes through build_ttx - the one path of a TTX file - and ONLY while the page is open in the game
# and the user has said Start (user's decision, 24.09, after a background pace was tried the same day):
#   - the page, open in the game, says so with every poll ('open'; the recorder's page_open_until). When the sweep of
#     this client version is not done and not running, it asks the user on every open of the page (Start - or Continue
#     with how far it got - / Later, with the mod's own estimate, write_sweep); Start ('sweepStart') runs it
#     until the page closes or the user presses Stop ('sweepStop' - after the current slice), and the next open asks again;
#   - confirmed and the page open: builds back to back for a slice (TTX_SWEEP_SLICE seconds, longer when the game's frames
#     are slow - SWEEP_SLICE_MAX), then rests (sweep_rest): at least ONE frame of the game (the recorder's frame callback,
#     wait_frame) and as long as the game's share of the time asks (SWEEP_SHARE); the export loop does not wait its 50 ms
#     meanwhile (sweep_hurry). Never in a battle, never while the page is being dragged, and every queued job (a clicked
#     vehicle's export) first. The page closed: nothing runs, and the next open of the page asks again.
# Measured on the client's own python27.dll and items.vehicles (offline stand, 1251 types): a build 26 ms median, most of
# it the stand's own XML reader (native in the game), the client's parsing ~24 %, ours <1 %. Once per client version and
# file schema: the progress file TTX_SWEEP_DATA (data/ttx-sweep.js, which the page reads for its indicator and its
# question) holds that stamp, whether it runs now (confirmed), when the sweep began (a file written after it is current without a read
# - the resume), how far it got, the build time so far (the page's estimate) and, when done, the types that failed
# (tried again once a session while the page is open, without asking). One log line when a sweep ends, none per type.
try: basestring_type = basestring
except NameError: basestring_type = str
TTX_SWEEP_SLICE = 0.06
# THE SWEEP'S SHARE OF THE TIME (26.09, user: "about half" while the page is open; THE knob, tune it here). A slice of
# work, then the game alone for slice * (1 - SWEEP_SHARE) / SWEEP_SHARE (at least one frame, at most SWEEP_REST_MAX). The
# game's frames take their own time anyway (0.8.6 in the game: 60 ms slices with one frame between them came to 23 % -
# 17 s of work in 74 s, 1202 types at 13.7 ms): when one frame lasts longer than that rest, the next slice grows to keep
# the share (the frame's time * SWEEP_SHARE / (1 - SWEEP_SHARE)), never beyond SWEEP_SLICE_MAX - the longest hitch.
SWEEP_SHARE = 0.5
SWEEP_SLICE_MAX = 0.15
SWEEP_REST_MAX = 1.0
# Waits of one frame (0.1 s at most each) in one rest: a bound, whatever the clock does.
SWEEP_REST_WAITS = 100
# THE ESTIMATE (26.09, user: the page's question said ~9 s, the sweep took 74 s): the wall-clock time of what is left =
# items left * ms of work an item / the share of the time the work got (write_sweep, the one owner; the page prints it).
# Both are measured while the sweep runs - the work of its slices over the vehicles it built, and those slices over the
# time from the first to the last with the rests between them (a gap over SWEEP_GAP_CAP is the gates closed - a drag, a
# click, a battle - not the sweep's pace) - and kept in the progress file ('pace') once a session has SWEEP_PACE_ITEMS
# vehicles and slices; until then the last kept figures, and before any: SWEEP_MS (below) and SWEEP_SHARE. The cap is
# above the longest rest (SWEEP_REST_MAX and its last frame), else a model slice's full rest would count as a pause.
SWEEP_GAP_CAP = 2.0
SWEEP_PACE_ITEMS = 10
# THE SOURCES' KEYS (24.09, user: do not build again what did not change). The client reads the characteristics from its
# packages: scripts.pkg (scripts/item_defs/vehicles/<nation>/<vehicle>.xml, <nation>/components/*.xml, <nation>/list.xml,
# vehicles/common/*, the items code scripts/common/items/*.pyc) and an event's own package (<event>/scripts/item_defs/...,
# last_stand, story_mode, white_tiger, comp7...). A type's key is the CRC-32 of those members' CRCs (the packages' central
# directories, no unpacking) with TTX_FORMAT, which is raised whenever ttx_block writes anything different. The .pyc carry
# a zero time stamp, so an unchanged module keeps its CRC. TTX_SOURCE_SKIP: common files no characteristic is read from.
# The file carries its format too ('format'): ttx_current takes a file of another format as missing, so a raise reaches the
# page's own per-type request as well as the sweep (whose keys it changes). 2 (26.09): the shells' traceRicochet.
# 3 (26.09): the aim blocks' gunPitchSpeed and shotOffsets (gun_statics). 4 (26.09): vehicle.fitment (fitment_block: the
# tags and the field modification tree), so a shooter known only from this file gets his tree and the garage's rules.
TTX_FORMAT = 4
TTX_SOURCE = re.compile(r'^(?:[^/]+/)?scripts/(?:item_defs/vehicles/|common/items/)')
TTX_SOURCE_SKIP = re.compile(r'item_defs/vehicles/common/(?:customization|damage_stickers|player_emblems|'
                             r'forbidden_vehicles_to_battle_config|equipments|optional_devices|post_progression|prefab_effects)'
                             r'|item_defs/vehicles/common/[^/]*effects\.xml$|item_defs/vehicles/[^/]+/customization\.xml$')
TTX_SWEEP_REPORT = 2.0
TTX_SWEEP_DATA = ('data', 'ttx-sweep.js')
TTX_SWEEP_KEY = 'ttxSweep'
# THE MODEL SWEEP (25.09, user: a visible Export all models, every regular vehicle, only what changed on the next run).
# The second kind of the same machinery (Exporter.run_sweep): the same Start, Stop, gates, slices, resume and progress file
# shape (MODELS_SWEEP_DATA). MODELS_FORMAT is raised whenever export_vehicle or a model file changes so that every vehicle
# of the sweep must be written again. Measured on the offline stand (docs/KNOWLEDGE.md 14): 1107 regular vehicles, a vehicle
# 0.74 s median of work (0.89 s mean), a collision model 0.11 s median and 1.6 s p99; 986 s of work, ~190 MB in all.
MODELS_FORMAT = 1
# THE KEYS OF THE CLIENT'S OUTPUTS (BACKLOG 55, 02.10). The 2.4.0.2 update changed tankmen_components.pyc (crew tables) and one
# vehicle's XML; the mod built again all 1343 characteristics files, 888 vehicles' models and 196 vehicle files - the same
# bytes. The user: when a formula changes, check the formula, not every value run through it. Each output is keyed by:
#   - its data: the vehicle's own XML (and variants), its nation's files, and what every type is built with alike - the files
#     items reads at its start and the builds open beyond those (client_code.SHARED_DATA) and the texts they translate from
#     (client_code.TEXT_DOMAINS); a vehicle file adds its compact descriptor, its collision models and prefabs;
#   - the client's CODE its build executes: the identity (code_identity: the bytecode, constants and names, not the line
#     numbers or the file) of every module of the code set - client_code.CODE_MODULES (made on the offline stand for each
#     client by tools/client_code_set.py: what the builds execute and what that code names), and what the game itself records
#     executing during builds (code_record). One 'generation' for all, changed only when a module of the set really changed.
# A key that changed is built again and compared with the file on disk, written only when the result differs: a vehicle whose
# data changed - that vehicle; a module of the set - every file (a real change of the formula). Outside the keys: the
# game's executable (native XML reading, vector maths) and code outside the set (a table computed at import from a module
# the set does not name); their change runs the sample check (VERIFY_SAMPLE_*): a few files built and compared, one that
# differs - 'Missed change' and every file. A key: '<data>.<generation>' (characteristics) or '<data>.<generation>.<own>'.
CODE_STATE_FILE = 'code-state.json'
# The client change check that must outlive its session (second review A): the reasons of a pending sample check, whether every
# file is to be checked (a 'Missed change'), and the client whose stand changes were rebuilt.
VERIFY_STATE_FILE = 'verify.json'
# WHAT A VEHICLE FILE IS: raised whenever export_vehicle writes anything different for the same vehicle (in every vehicle
# file's key: each is built again in the background and written where it differs).
VEHICLE_FORMAT = 1
# The keys of the vehicle files (data/<this>): {id: key} - the one owner of "this file is the running client's".
VEHICLE_KEYS_FILE = 'vehicle-keys.json'
# The model files named before 0.9.4 (by the version text) that hold exactly a model of the running client: {content key:
# file}, and what each scanned file is (its .havok and that file's sha256). data/<this>.
MODELS_INDEX_FILE = 'models-index.json'
# THE GUARD AGAINST A MISSED CHANGE: after the client's files changed, this many characteristics files and vehicle files whose
# keys did NOT change are built and compared all the same; one that differs is a change the keys missed ('Missed change').
VERIFY_SAMPLE_TTX, VERIFY_SAMPLE_VEHICLES = 8, 4
MODELS_SWEEP_DATA = ('data', 'models-sweep.js')
MODELS_SWEEP_KEY = 'modelsSweep'
# Base-list copies made for the onboarding and Story Mode (no battle-mode tag on them) and the client's test vehicles:
# not regular vehicles, left out of the model sweep by name (outputs/vehicle-classes-modes-2026-09-21.md section 4).
MODELS_SKIP_NAME = re.compile(r'_(?:StoryMode\w*|NewOnBoarding|test|TEST)$|^Env_')


def regular_vehicle(row, extension=()):
    """A vehicle a player can have in the hangar - the one rule of the model sweep and of the page's vehicle list (user,
    25.09: no event, battle-mode, internet-cafe, onboarding or Story Mode copy in the picker). `extension`: the types of
    the event packages (Exporter.extension_types)."""
    type_name = str(row.get('type') or '')
    return not (row.get('modeOnly') or row.get('igr') or type_name in extension
                or MODELS_SKIP_NAME.search(type_name.split(':', 1)[-1]))
# The catalogue while the model sweep writes vehicle after vehicle: at most every 5 s (the page polls every 2-5 s).
SWEEP_CATALOGUE_PAUSE = 5.0
# 'verify' (BACKLOG 55): the files whose key really changed (their own data, or a module of the code set), built again and
# compared - in the background, after every job and every sweep the user started, without the page and without asking; and
# the sample check when the exe or code outside the set changed. It has no progress file.
SWEEP_ORDER = ('ttx', 'models', 'verify')
# The sweeps the user starts (the page's Start): ahead of the background's jobs, taking turns (BACKLOG 55, run_sweeps).
USER_SWEEPS = ('ttx', 'models')
SWEEP_FILES = {'ttx': (TTX_SWEEP_DATA, TTX_SWEEP_KEY), 'models': (MODELS_SWEEP_DATA, MODELS_SWEEP_KEY)}
SWEEP_LABELS = {'ttx': 'TTX', 'models': 'Model', 'verify': 'Client change check'}
# Ms of work a vehicle before this machine has measured its own (SWEEP_PACE_ITEMS): the characteristics as measured in the
# game (0.8.6, 26.09: 17 s of slices for 1202 built types, 14.1 ms), the models on the offline stand (28.09, havok-lazy:
# 179 s for 1058 vehicles, 169 ms; 626 ms with the whole-graph reader, 890 ms on 25.09; docs/KNOWLEDGE.md 14).
SWEEP_MS = {'ttx': 14.0, 'models': 170.0, 'verify': 14.0}
# A collision model whose extraction (model_extract: read, parse, hash, write) took this long says so in the log.
MODEL_SLOW_MS = 100.0
# The marker before the page's progress file (24.09, earlier the same day): removed when found.
TTX_SWEEP_OLD = 'ttx-sweep.json'
# The mode flags of a vehicle, by name in the file and the descriptor property (vehicles.pyc 2.4.0.1). The second
# mode's own values are configs[k].modeAim/modePitch and vehicle.modeValues (23.09, ttx_mode_values).
TTX_MODE_FLAGS = (('siege', 'hasSiegeMode'), ('wheeled', 'isWheeledVehicle'),
                  ('onSpotRotation', 'isWheeledOnSpotRotation'), ('turboshaft', 'hasTurboshaftEngine'),
                  ('rocketAcceleration', 'hasRocketAcceleration'), ('hydraulicChassis', 'hasHydraulicChassis'),
                  # A chassis whose track pairs run one inside the other: the garage titles its repair times "main /
                  # reserve" (formatters.needUseYohChassisRepairTime 316). The M-VI-Yoh has two pairs without it.
                  ('trackWithinTrack', 'isTrackWithinTrack'))


def ttx_take(target, key, action, warnings, label):
    """target[key] = action(), or a line in warnings: one field the client refuses costs that field only."""
    try:
        target[key] = action()
        return True
    except Exception:
        warnings.append(label + ' unavailable')
        return False


def ttx_text(component):
    """The display name of a module, text or None."""
    text = getattr(component, 'userString', None)
    if isinstance(text, bytes): text = text.decode('utf-8', 'replace')
    return text if isinstance(text, TEXT_TYPE) else None


def ttx_module(component):
    """name, userString and level of one installable module."""
    return {'name': str(component.name), 'userString': ttx_text(component), 'level': int(component.level)}


def ttx_levels_factor(value):
    """One factor of type.optDevsOverrides. The client keeps it as a LevelsFactor (items/components/
    supply_slot_categories.pyc, __slots__ opType and values): values holds one number per level of the
    device, [standard, in a slot of its own category] for the devices that have both (camouflage net
    0.05/0.075), opType is None for a plain value. Anything else is written by json_safe."""
    values = None if isinstance(value, dict) else getattr(value, 'values', None)
    if values is not None:
        block = {'values': [float(item) for item in values]}
        op = getattr(value, 'opType', None)
        if op is not None: block['op'] = str(op)
        return block
    return json_safe(value, 200)


def ttx_overrides(overrides):
    """type.optDevsOverrides as {device: {factor: {'values': [...], 'op'?}}}: the camouflage net and the exhaust
    are given per vehicle in the client, not per device (1247 of 1252 vehicles, outputs/ttx-data-2026-09-22.md)."""
    result = {}
    for device, factors in (overrides or {}).items():
        result[str(device)] = dict((str(name), ttx_levels_factor(value)) for name, value in (factors or {}).items())
    return result


def ttx_steering_lock(values):
    """The client's gui.shared.items_parameters.functions.getMaxSteeringLockAngle (functions.pyc 345-349,
    2.4.0.1), copied so the export thread never imports a garage module: max(|angle|) of the axles, or None when
    no axle steers. The angles are the XML's, in degrees, as the garage shows them."""
    if not values or not any(values):
        return None
    return float(max(abs(float(item)) for item in values))


def ttx_repair_times(chassis):
    """The suspension's repair times of the XML in seconds, the inputs of the garage's params.VehicleParams.
    chassisRepairTime (883-897, 2.4.0.1): one per track pair (chassis.trackPairs - two on the M-VI-Yoh) in the
    chassis's own order, which the garage divides by the repair factors and then REVERSES; [] when a pair has none, as
    the garage returns then. A wheeled chassis has no track pairs: its own healthParams.repairTime."""
    pairs = getattr(chassis, 'trackPairs', None) or ()
    if pairs:
        times = [pair.healthParams.repairTime for pair in pairs]
        return [] if any(time is None for time in times) else [float(time) for time in times]
    time = getattr(chassis, 'repairTime', None)
    return [] if time is None else [float(time)]


def ttx_reload_extra(descr):
    """What the mechanics add to the reload of this pair, {name: seconds}, only the non-zero ones.

    extraReloadTime: factors['gun/extraReloadTime'] after every mechanic of the descriptor has written its
    factors, the way the garage collects them (items/utils.pyc updateVehicleAttrFactors, the DEFAULT aspect).
    mechanicsReloadDelay: preparingDelay + finishingDelay of the stationary reload - the client's
    items_parameters.getMechanicsReloadDelay (__init__.pyc 108-116) copied, for the reason given at
    ttx_steering_lock. {} is a counted zero; the caller leaves the field out when this raises.
    """
    mechanics = mechanics_params(descr)
    if not mechanics:
        return {}
    block = {}
    from items.components.shared_components import StationaryReloadParams
    stationary = mechanics.get(StationaryReloadParams.MECHANICS_NAME)
    if stationary is not None:
        delay = float(stationary.preparingDelay) + float(stationary.finishingDelay)
        if delay: block['mechanicsReloadDelay'] = delay
    from constants import VEHICLE_TTC_ASPECTS
    from items import vehicles as client_vehicles
    factors = client_vehicles.vehicleAttributeFactors()
    for mechanic in mechanics.values():
        update = getattr(mechanic, 'updateVehicleAttrFactorsForAspect', None)
        if update is not None:
            update(descr, factors, VEHICLE_TTC_ASPECTS.DEFAULT)
    extra = float(factors.get('gun/extraReloadTime', 0.0) or 0.0)
    if extra: block['extraReloadTime'] = extra
    return block


def ttx_weight(descr, warnings):
    """The mass of the configuration in kg: descr.physics['weight'] (vehicles.pyc __computeWeight: every
    module, no devices on a bare descriptor), else the sum of the module masses with a warning."""
    physics = getattr(descr, 'physics', None)
    if isinstance(physics, dict) and positive(physics.get('weight')):
        return float(physics['weight'])
    total = 0.0
    for name in ('hull', 'chassis', 'engine', 'fuelTank', 'radio'):
        total += float(getattr(descr, name).weight)
    for turret, gun in descr.turrets:
        total += float(turret.weight) + float(gun.weight)
    warnings.append('Weight taken as the sum of the module weights')
    return total


def ttx_pitch(limits):
    """gun.pitchLimits without the table: 'absolute' (min, max) and the knots of the two curves, (share of the
    turret circle, angle) - the garage shows the absolute pair, the page the extremes of the curves."""
    return {'absolute': [float(item) for item in limits['absolute']],
            'minPitch': [[float(x), float(y)] for x, y in limits['minPitch']],
            'maxPitch': [[float(x), float(y)] for x, y in limits['maxPitch']]}


def ttx_pair(descr, turret_index, gun_name, top):
    """One configs[] entry: the fields of the pair the descriptor now carries, each on its own."""
    warnings = []
    config = {'turret': turret_index, 'gun': gun_name, 'top': bool(top)}
    gun = descr.gun
    ttx_take(config, 'gunUserString', lambda: getattr(gun, 'shortUserString', None) or str(gun.name),
             warnings, 'Gun name')
    ttx_take(config, 'gunLevel', lambda: int(gun.level), warnings, 'Gun level')
    # A vehicle built twice (23.09, second modes M2): both modes' blocks by the recorder's own mode_aim_block, the first
    # one as 'aim' - so it is built once, not twice - and the siege one as 'modeAim' where the two differ.
    aims = None
    if getattr(descr, 'hasSiegeMode', False):
        try:
            aims = mode_aim_block(descr)
        except Exception:
            warnings.append('Second-mode aim parameters unavailable')

    def aim():
        block = aims['default'] if aims and aims.get('default') else aim_block(descr)
        if not block: raise ValueError('No aim block')
        # A bare descriptor rebuilt by the client: no battle, no field modifications, no devices.
        block['aimFrom'] = 'compact'
        return block
    ttx_take(config, 'aim', aim, warnings, 'Aim parameters')
    if aims and not aims['same'] and aims.get('siege'):
        aims['siege']['aimFrom'] = 'compact'
        config['modeAim'] = aims['siege']
        config['modeAimMode'] = 1
    ttx_take(config, 'maxHealth', lambda: int(descr.maxHealth), warnings, 'Health')
    # The hull's nominal armour front / sides / rear, mm (params.VehicleParams.hullArmor 263): per pair, because the
    # client picks the hull variant with the turret.
    ttx_take(config, 'hullArmor', lambda: [float(item) for item in descr.hull.primaryArmor], warnings, 'Hull armour')
    ttx_take(config, 'weight', lambda: ttx_weight(descr, warnings), warnings, 'Weight')
    ttx_take(config, 'maxAmmo', lambda: int(gun.maxAmmo), warnings, 'Ammunition')
    ttx_take(config, 'invisibilityFactorAtShot', lambda: float(gun.invisibilityFactorAtShot), warnings,
             'Concealment at the shot')

    ttx_take(config, 'turretYawLimits', lambda: yaw_limits(descr), warnings, 'Turret yaw limits')
    ttx_take(config, 'pitch', lambda: ttx_pitch(gun.pitchLimits), warnings, 'Pitch limits')
    if aims is not None:
        # The siege gun's own limits where they differ (the Strv 103: +1 degree fixed in travel, -2..+4 in siege).
        try:
            pitch = ttx_pitch(mode_descr(descr, 1).gun.pitchLimits)
            if pitch != config.get('pitch'): config['modePitch'] = pitch
        except Exception:
            warnings.append('Second-mode pitch limits unavailable')
    ttx_take(config, 'reloadExtra', lambda: ttx_reload_extra(descr), warnings, 'Mechanics reload')
    return config, warnings


def ttx_mode_values(descr, vehicle, modules, turrets, modes):
    """The vehicle's own figures of its second mode, only the ones that differ from the first (23.09, second modes M2):

      enginePower            W        the siege engine's power (the turbine: 740 -> 1150 hp on the CS-63)
      invisibility           [2]      the siege type's concealment moving / standing
      circularVisionRadius   [m, ..]  per turret of the file's turret list (the Char Mle. 75: 370 -> 350)
      maxSteeringLockAngle   deg      a wheeled vehicle without on-the-spot turning, its Rapid wheels (33 -> 15)

    Read off the siege descriptor of the composite the pairs were mounted on (mode_descr): the top engine and chassis
    are installed in both. {} for a vehicle built once.
    """
    if not modes.get('siege'):
        return {}
    siege = mode_descr(descr, 1)
    if siege is descr:
        return {}
    values = {}
    try:
        power = float(siege.engine.power)
        if power != (modules.get('engine') or {}).get('power'): values['enginePower'] = power
    except Exception:
        pass
    try:
        inv = [float(item) for item in siege.type.invisibility]
        if inv != vehicle.get('invisibility'): values['invisibility'] = inv
    except Exception:
        pass
    try:
        vision = [float(turret.circularVisionRadius) for turret in siege.type.turrets[0]]
        if len(vision) == len(turrets) and vision != [entry.get('circularVisionRadius') for entry in turrets]:
            values['circularVisionRadius'] = vision
    except Exception:
        pass
    try:
        if modes.get('wheeled') and not modes.get('onSpotRotation'):
            chassis = siege.chassis
            lock = ttx_steering_lock(siege.type.xphysics['chassis'][chassis.name].get('axleSteeringLockAngles'))
            if lock != (modules.get('chassis') or {}).get('maxSteeringLockAngle'): values['maxSteeringLockAngle'] = lock
    except Exception:
        pass
    return values


def rocket_block(params):
    """The rocket booster of sixteen vehicles (type.rocketAccelerationParams, items/components/shared_components.pyc
    RocketAccelerationParams, 2.4.0.1): deployTime, reloadTime (the pause between two uses), reuseCount, duration (s)
    and the modifiers in force while it burns, as the heat bands' modifiers are written - on the BZ-176
    dynAttrs/engine/power x2.5, vehicle/maxSpeed/forward x1.5, backward x0.1, vehicle/rotationSpeed x0.15. None of
    them touches the dispersion: the circle grows only with the speed (docs/KNOWLEDGE.md section 6)."""
    block = {'deployTime': float(params.deployTime), 'reloadTime': float(params.reloadTime),
             'reuseCount': int(params.reuseCount), 'duration': float(params.duration),
             'modifiers': [heat_modifier(item) for item in (params.modifiers or ())]}
    impulse = getattr(params, 'impulse', None)
    if impulse is not None:
        try:
            block['impulse'] = {'magnitude': float(impulse.magnitude), 'duration': float(impulse.duration)}
        except Exception:
            pass
    return block


def ttx_block(type_name, version, log=True):
    """The characteristics of one vehicle type, the value of data/ttx/<id>.js (spec section 2.1).

    A fresh VehicleDescr(typeID) of the running client - never the memo of vehicle_descr: its modules are
    replaced here - raised to the best chassis, engine, radio and fuel tank (best_component, the rule of
    top_descriptor, which itself stays as it is: it decides the compact descriptor of the model sweep). Then
    one installTurret per pair of vtype.turrets[0][i].guns: the client applies the turret's own overrides of
    the gun (reload, aiming, dispersion factors, pitch limits) and picks the hull variant itself. The shells
    are read once per gun, the modules once per type. Every field is read on its own; a refusal is a line in
    'warnings', never a lost file. Export thread only: it may take tens of milliseconds.
    """
    started = TTX_TIMER()
    from items import vehicles as client_vehicles
    nation_id, innation_id = client_vehicles.g_list.getIDsByName(type_name)
    descr = client_vehicles.VehicleDescr(typeID=(nation_id, innation_id))
    vtype = descr.type
    warnings = []
    for attribute, listing in TTX_TOP_MODULES:
        try:
            best = best_component(getattr(vtype, listing))
            current = getattr(descr, attribute, None)
            if best is not None and (current is None or current.name != best.name):
                descr.installComponent(best.compactDescr)
        except Exception:
            warnings.append('Top %s unavailable; the stock one is kept' % attribute)
    vehicle = {}
    ttx_take(vehicle, 'invisibility', lambda: [float(item) for item in vtype.invisibility], warnings, 'Concealment')
    ttx_take(vehicle, 'camouflageBonus', lambda: float(vtype.invisibilityDeltas['camouflageBonus']), warnings,
             'Camouflage bonus')
    ttx_take(vehicle, 'optDevsOverrides', lambda: ttx_overrides(vtype.optDevsOverrides), warnings,
             'Device overrides')
    # What the vehicle may mount (26.09): the vehicle exports' own fitment block - the tags (eligibility, the mode group)
    # and the field modification tree - so a shooter the page knows only from this file is offered what an export offers.
    tags, tags_read = (), False
    try:
        tags, tags_read = tuple(vtype.tags), True
    except Exception:
        pass
    vehicle['fitment'] = fitment_block(vtype, tags, tags_read)
    # The factor the client multiplies every shell speed by when it reads it (vehicles.pyc _readShot 9060):
    # the garage shows shell.speed / projectileSpeedFactor, the XML speed.
    ttx_take(vehicle, 'projectileSpeedFactor',
             lambda: float(client_vehicles.g_cache.commonConfig['miscParams']['projectileSpeedFactor']),
             warnings, 'Shell speed factor')
    # A real turret or only the hull's fake one (params.VehicleParams.__hasTurret 1236: len(hull.fakeTurrets['lobby'])
    # != len(turrets)). The garage prints a gun's sector after the turret's traverse on a real turret (turretYawLimits)
    # and after the pitch limits without one (gunYawLimits; params 698-710, params_helper 47) - the page's order of
    # the expanded panel (23.09, panel v2). 34 of the client's 266 vehicles with a sector have a real turret (T110E4,
    # FV4005, ...), so the page cannot tell by itself. None when the client refuses: never read again for that file.
    try:
        vehicle['hasTurret'] = len(descr.hull.fakeTurrets['lobby']) != len(descr.turrets)
    except Exception:
        vehicle['hasTurret'] = None
        warnings.append('Turret flag unavailable')
    modes = {}
    for key, attribute in TTX_MODE_FLAGS:
        ttx_take(modes, key, lambda attribute=attribute: bool(getattr(descr, attribute)), warnings,
                 'Mode flag ' + key)
    modules = {}

    def chassis():
        component = descr.chassis
        block = ttx_module(component)
        block['terrainResistance'] = [float(item) for item in component.terrainResistance]
        block['maxSteeringLockAngle'] = None
        if modes.get('wheeled') and not modes.get('onSpotRotation'):
            physics = vtype.xphysics['chassis'][component.name]
            block['maxSteeringLockAngle'] = ttx_steering_lock(physics.get('axleSteeringLockAngles'))
        ttx_take(block, 'repairTime', lambda: ttx_repair_times(component), warnings, 'Suspension repair time')
        return block

    def engine():
        block = ttx_module(descr.engine)
        block['power'] = float(descr.engine.power)
        return block
    ttx_take(modules, 'chassis', chassis, warnings, 'Chassis')
    ttx_take(modules, 'engine', engine, warnings, 'Engine')
    turrets, configs, shells = [], [], {}
    candidates = list(vtype.turrets[0])
    top_turret = best_component(candidates)
    top_index = candidates.index(top_turret) if top_turret is not None else -1
    top_gun = best_component(top_turret.guns) if top_turret is not None else None
    tags = set()
    for index, turret in enumerate(candidates):
        entry = {}
        ttx_take(entry, 'module', lambda: ttx_module(turret), warnings, 'Turret')
        entry = entry.get('module') or {'name': str(getattr(turret, 'name', index))}
        ttx_take(entry, 'circularVisionRadius', lambda: float(turret.circularVisionRadius), warnings,
                 'View range of ' + entry['name'])
        ttx_take(entry, 'invisibilityFactor', lambda: float(turret.invisibilityFactor), warnings,
                 'Turret concealment of ' + entry['name'])
        # The turret's nominal armour front / sides / rear, mm (params.VehicleParams.turretArmor 461): the garage prints
        # it only on a real turret (vehicle.hasTurret); a fake one has figures of its own that nobody shows.
        ttx_take(entry, 'primaryArmor', lambda: [float(item) for item in turret.primaryArmor], warnings,
                 'Turret armour of ' + entry['name'])
        turrets.append(entry)
        for gun in turret.guns:
            name = str(gun.name)
            try:
                descr.installTurret(turret.compactDescr, gun.compactDescr)
            except Exception:
                warnings.append('Pair %s x %s could not be mounted' % (entry['name'], name))
                continue
            top = index == top_index and top_gun is not None and name == str(top_gun.name)
            config, lines = ttx_pair(descr, index, name, top)
            warnings.extend('%s x %s: %s' % (entry['name'], name, line) for line in lines)
            try:
                tags.update(str(tag) for tag in descr.gun.tags)
            except Exception:
                pass
            try:
                listed = shot_candidates(descr, installation=0)
                if name not in shells:
                    shells[name] = listed
                elif listed != shells[name]:
                    # A turret may override the shots of its gun (vehicles.pyc _readGunLocals reads a local
                    # 'shots' block): the pair then carries its own list instead of the gun's.
                    config['shells'] = listed
            except Exception:
                warnings.append('%s x %s: Shell parameters unavailable' % (entry['name'], name))
            configs.append(config)
    modes['dualGun'] = 'dualGun' in tags
    modes['twinGun'] = 'twinGun' in tags
    vehicle['modes'] = modes
    # The second mode's own figures of the vehicle, and the rocket booster (23.09, second modes M2).
    try:
        values = ttx_mode_values(descr, vehicle, modules, turrets, modes)
        if values: vehicle['modeValues'] = values
    except Exception:
        warnings.append('Second-mode values unavailable')
    if modes.get('rocketAcceleration'):
        ttx_take(vehicle, 'rocketAcceleration', lambda: rocket_block(vtype.rocketAccelerationParams), warnings,
                 'Rocket acceleration')
    result = {'schema': TTX_SCHEMA, 'modesSchema': TTX_MODES_SCHEMA, 'armorSchema': TTX_ARMOR_SCHEMA, 'format': TTX_FORMAT,
              'id': vehicle_id(type_name), 'type': str(type_name),
              'clientVersion': version, 'producedAt': time.time(), 'buildMs': round((TTX_TIMER() - started) * 1000.0, 1),
              'vehicle': vehicle, 'modules': modules, 'turrets': turrets, 'shells': shells,
              'configs': configs, 'warnings': warnings}
    if log: LOG.info('TTX %s: %s pairs, %.1f ms', type_name, len(configs), result['buildMs'])
    return result


class Exporter(object):
    # The TTX sweep's run state and progress state, by the names its code has always used.
    ttx_sweep = property(lambda self: self.sweeps['ttx'], lambda self, value: self.sweeps.__setitem__('ttx', value))
    ttx_state = property(lambda self: self.sweep_states['ttx'], lambda self, value: self.sweep_states.__setitem__('ttx', value))

    def __init__(self, game, folder, version, archive=None):
        self.game = os.path.abspath(game)
        self.folder = os.path.abspath(folder)
        self.version = canonical(version)
        self.archive = archive
        self.packages = None
        self.package_entries = None
        self.package_scan_failed = None
        self.prefab_entries = None
        self.package_conflicts = set()
        self.index_skipped, self.index_failed = set(), []
        self.overrides = None
        self.attempts = {}
        # Ms of each model extracted since the last model sweep's report (model_extract; the report prints and clears it).
        self.model_ms = []
        self.scan_errors = set()
        self.summaries = {}
        self.model_refs = {}
        self.current = None
        self.armor = ArmorCatalog(self.game)
        self.settings = dict(DEFAULT_SETTINGS)
        self.vehicles = {}
        self.catalogue_dirty = False
        self.catalogue_written = 0
        # The one queue of deferred work: [priority, order, kind, payload], lowest
        # priority number first, ties by order. Touched by the export thread only;
        # the game thread asks for a change of priority through the record queue.
        self.jobs = []
        self.job_index = {}
        # The jobs the page's last 'prioritise' lifted to JOB_PAGE, with the priority each had (key -> priority): the next
        # one puts them back - only what the page waits for now passes the drag gate (review 26.09).
        self.lifted = {}
        self.job_seq = 0
        self.job_types = {}
        self.waiting = {}
        self.republish = set()
        self.republished = {}
        self.last_job = 0
        # Seconds after last_job before the next job that the page is not waiting for (run_job): PACE after a model or
        # a vehicle, a characteristics file's own share of the time after one.
        self.job_rest = PACE
        # A job the page waits for (JOB_PAGE) is still queued after the one that just ran: the export loop takes it without
        # its 50 ms wait for a message (export_hurry, one turn only). The clicked vehicle's own jobs run back to back.
        self.page_follow = False
        # Durable JSONL cursors. The writer only raises targets after a complete
        # line has closed successfully; consumption is bounded on every tick.
        self.raw_offsets = {}
        self.raw_targets = {}
        self.raw_decoders = {}
        self.raw_oversize = {}
        # Battle files passed over for the rest of the session (skip_battle): no header line, or a publication
        # that keeps failing the same way. Never retried; the next start reads them again.
        self.skipped = set()
        # Prepared hits are retained only for the active battle. Each raw hit is
        # copied/enriched once, then selectively invalidated by its model key.
        self.prepared_hits = []
        self.prepared_models = {}
        self.prepared_identity = None
        self.publish_failures = 0
        # The same count without EnvironmentError: what PUBLISH_GIVE_UP is measured against.
        self.publish_faults = 0
        self.next_publish_retry = 0
        # The Recorder, when the mod is running: in_battle and busy_until say when
        # a job may run. Outside the game it stays None and everything may run.
        self.recorder = None
        # data/ttx/<id>.js per type (TTX panel, 23.09): TTX_CURRENT once the file on disk was found current
        # or written this session, TTX_FAILED after a build failed. Filled lazily on the first request of a
        # type - setup reads nothing for it. Export thread only.
        self.ttx_known = {}
        # The sweeps over the catalogue (SWEEP_ORDER: 'ttx', 'models'), None when there is none this session; ttx_stopped -
        # the mod is shutting down (Writer.close), no step of any sweep after it.
        self.sweeps = dict((kind, None) for kind in SWEEP_ORDER)
        self.ttx_stopped = False
        # Each progress file's state this session (start_*_sweep): the sources' keys now and those of the current files.
        self.sweep_states = dict((kind, None) for kind in SWEEP_ORDER)
        # The CRCs of the characteristics' sources, read once a session for both sweeps (source_crcs).
        self.crcs = None
        # The client's files (BACKLOG 55): the snapshot (client_snapshot.ClientSnapshot, refreshed once a session by
        # client(); None until then, False when it could not be taken - the keys fall back to the client version), and
        # {client version text: {path: (crc, size)}} given from outside (a test) before the snapshot's own (client_files).
        self.client_state = None
        self.client_snapshots = {}
        self.code_generation_value = None
        self.code_state_value = None
        self.code_samples = []      # why the sample check runs this session (code_generation)
        self.code_seen = set()      # client modules the builds executed this session (recorded, code_record)
        # The model files named by the version text that hold a model of this client (models_index), the vehicle files' keys
        # (vehicle_keys), the characteristics files whose key changed (start_ttx_sweep -> start_verify).
        self.models_index_value = None
        self.models_index_dirty = False
        self.vehicle_keys_value = None
        self.vehicle_keys_dirty = False
        self.vehicle_keys_written = 0.0
        self.vehicle_bases = {}
        self.ttx_stale = []
        # The vehicle XML's extras per type (type_extras), a failure's reason included; the types whose descriptor failed
        # in fix_wheels (logged once). Export thread only.
        self.extras_cache = {}
        self.extras_logged = set()
        self.prefab_cache = {}
        # Wheeled vehicles' files from before the wheels that load_vehicles found: exported again in the background, and
        # the catalogue written once after the last of them (replay_vehicle_requests, run_vehicle_job).
        self.migrating = set()
        # The out-of-date files the page asked for with no job queued, exported again from their own request (outdated_request).
        self.outdated_tried = set()
        # data/published.json (PUBLISHED_FILE): {battle id: what its derived file was built from}, kept by publish() and
        # written by write_published when dirty. `backlog`: the saved battles setup left to the background ('battle' jobs)
        # - {'left', 'count', 'started', 'work', 'failed', 'prune'} - None when there are none left.
        self.published = {}
        self.published_dirty = False
        self.published_written = 0.0
        self.backlog = None
        # The saved battle the background is publishing in slices (run_battle_job), None between two: its reader, the hits
        # prepared so far, its times. Dropped when a battle starts (a big one holds its whole record in memory).
        self.battle_work = None
        # What a derived battle file is: a file of another format is prepared again when it is opened (not of another build -
        # DERIVED_FORMAT says when a build writes them differently - nor of another client: BACKLOG 55, PUBLISHED_FORMAT).
        self.stamp = 'd%d' % DERIVED_FORMAT
        # The saved battles whose file is not current ('stale' in the index): each prepared when the page opens it
        # (request_battle). Those whose model references are unknown (no entry for their file): the prune waits for them.
        self.stale = set()
        self.refs_unknown = set()
        self.prune_waits = self.prune_now = False
        # A 'battle' job the page waits for runs now (run_job): its slices go on through a drag (battle_stop) and read the
        # vehicle XML at once instead of queueing the extras job behind the drag (fix_wheels, fix_prefabs).
        self.preparing_page = False
        # The inputs the fill-ins of a battle read this publish ({battle id: {path: 'crc:size'}}, fill_allowed): its entry
        # keeps them, so a later client is compared with what was really read.
        self.fill_reads = {}
        # The hits of a battle's file on disk while it is prepared again (kept_hit), and the fill-ins taken from them
        # (keep_fills: {battle id: kinds}) - for the one log line of its publish.
        self.kept_files = {}
        self.kept_now = {}
        # The started sweep that ran last (run_sweeps): the other started one goes next - both get slices.
        self.sweep_last = None
        # Each publish gives its battle a revision in the index ('rev', optimisation plan C1): the page reads again only the
        # battle it has open when that one's revision changed, not whenever the index was written (the background publishes
        # a battle every few seconds). This session and a count: a page that outlives a restart never sees one revision twice.
        self.session = '%x' % int(time.time() * 1000)
        self.publish_serial = 0

    def setup(self):
        # The startup timing line (startup-republish-slow, 27.09): where setup's time goes, one line in game.log.
        began = step = TTX_TIMER()
        spent = {}
        def lap(name):
            now = TTX_TIMER()
            spent[name] = now - step
            return now
        archive = self.archive
        if archive is None:
            candidates = glob.glob(os.path.join(self.game, 'mods', '*', 'local.armor_inspector_'+VERSION+'.wotmod'))
            # A client update leaves the previous mods/<version> folder behind and the launcher never cleans
            # it, so the same file can sit in two of them; refusing to choose used to turn the whole export
            # off for the session (inspection, 20.09). Every candidate carries the same VERSION in its name,
            # so they are the same build: take the newest client folder and only an empty list is an error.
            if not candidates: raise ValueError('Cannot locate the installed viewer package')
            def folder_key(path):
                name = os.path.basename(os.path.dirname(path))
                return [int(part) if part.isdigit() else -1 for part in name.split('.')]
            archive = sorted(candidates, key=folder_key)[-1]
        with zipfile.ZipFile(archive) as z:
            for name in ASSETS:
                target = os.path.join(self.folder, *name.split('/'))
                member = 'res/armor_inspector_viewer/'+name
                # The installer has usually just put the very same bytes there: a file of the same size
                # and CRC-32 as the package entry is left alone. Anything else - missing, half written,
                # edited - is rewritten, and any doubt falls back to the unconditional write.
                try:
                    if same_as_member(target, z.getinfo(member)): continue
                except Exception:
                    pass
                atomic_write(target, z.read(member))
        step = lap('assets')
        # The client's files (BACKLOG 55): read again only when a package, an override or a text changed since the last start.
        self.client()
        # And the code its builds execute: changed - every characteristics and vehicle file is rebuilt (code_generation).
        try:
            self.code_generation()
        except Exception:
            LOG.exception('Client code identity unavailable this session; the files are checked by their data')
        step = lap('client')
        self.load_settings()
        complete = self.load_vehicles()
        step = lap('vehicles')
        # The saved battles: two sizes each; those whose derived file is not what data/published.json says it was built from
        # are 'stale' - none is published here or in the background (BACKLOG 55): the page asks for the one it opens.
        named, current, stale, refs_known = self.saved_battles()
        complete = complete and named
        step = lap('battles')
        self.replay_vehicle_requests()
        step = lap('replay')
        rows = self.catalogue_rows()
        # prune() deletes every model no reference names, and a model of an earlier client can never be extracted
        # again. So it runs only from a complete reference set: one battle or vehicle file that did not read or
        # publish - locked by an antivirus or a backup, or broken - keeps every model on disk this session
        # (EXP-02/DATA-02, 24.09). The unused ones go on the next start that reads everything. A battle whose references
        # are not known (no published state for its file) is prepared when it is opened; the prune waits for the last of
        # them (publish -> write_index).
        if not complete: LOG.warning('Unused models kept this session: a saved battle or vehicle could not be read')
        self.prune_waits = bool(complete and not refs_known)
        self.write_index(prune=complete and refs_known)
        step = lap('index')
        # The sweeps are optional: whatever goes wrong with one leaves the export alone (review #1).
        for kind, start in (('ttx', self.start_ttx_sweep), ('models', self.start_models_sweep)):
            try:
                start(rows)
            except Exception:
                self.sweeps[kind] = None
                LOG.exception('%s sweep unavailable this session; the export goes on', SWEEP_LABELS[kind])
        # What the client's change asks to build again and compare (the files whose key changed), in the background.
        try:
            self.start_verify()
        except Exception:
            self.sweeps['verify'] = None
            LOG.exception('Client change check unavailable this session; the export goes on')
        step = lap('sweeps')
        # The catalogue once the model sweep's keys are known: a file of an earlier client whose sources did not change
        # is this client's too ('exported').
        self.flag_rows(rows)
        self.write_catalogue(force=True, rows=rows)
        if self.published_dirty: self.write_published()
        self.write_keys(force=True)
        step = lap('catalogue')
        LOG.info('Startup in %.2f s: assets %.2f s, client files %.2f s, %d vehicles %.2f s, battles %d current and %d stale '
                 '(prepared when opened) %.2f s, replay %.2f s (%d jobs queued), index %.2f s, sweeps %.2f s, catalogue %.2f s',
                 step - began, spent['assets'], spent['client'], len(self.vehicles), spent['vehicles'], current, len(stale),
                 spent['battles'], spent['replay'], len(self.jobs), spent['index'], spent['sweeps'], spent['catalogue'])

    # SAVED BATTLES AT STARTUP (startup-republish-slow, 27.09): see PUBLISHED_FILE.
    def published_path(self):
        return os.path.join(self.folder, 'data', PUBLISHED_FILE)

    def read_published(self):
        """{battle id: entry} of data/published.json ('refs' as a set of model keys), {} when there is none or it does not
        read - every battle is then published again, as before."""
        try:
            path = self.published_path()
            if not os.path.isfile(path) or os.path.getsize(path) > PUBLISHED_LIMIT: return {}
            with open(path, 'rb') as stream:
                value = json.loads(stream.read().decode('utf-8'))
            if value.get('format') != PUBLISHED_FORMAT: return {}
            keys, found = value['keys'], {}
            for name, entry in value['battles'].items():
                if not IDENTIFIER.match(name) or not isinstance(entry, dict): continue
                entry = dict(entry)
                entry['refs'] = set(str(keys[index]) for index in entry.get('refs') or ())
                if not isinstance(entry.get('summary'), dict): entry['summary'] = None
                found[str(name)] = entry
            return found
        except Exception:
            LOG.warning('Published battle state unreadable; every saved battle is published again')
            return {}

    def write_published(self):
        """data/published.json from self.published; the model keys once, each battle's references as their numbers."""
        keys, numbers, battles = [], {}, {}
        for name, entry in self.published.items():
            refs = []
            for key in entry['refs']:
                if key not in numbers:
                    numbers[key] = len(keys)
                    keys.append(key)
                refs.append(numbers[key])
            battles[name] = dict(entry, refs=sorted(refs))
        try:
            atomic_write(self.published_path(), json.dumps({'format':PUBLISHED_FORMAT, 'keys':keys, 'battles':battles},
                                                           ensure_ascii=True, allow_nan=False,
                                                           separators=(',', ':')).encode('ascii'))
            self.published_dirty = False
        except Exception:
            LOG.exception('Published battle state not written; those battles are published again next start')
        self.published_written = time.time()

    def published_current(self, name, entry, models=None):
        """The derived file of this battle is what `entry` says, built in this format for this client from the raw file as
        it is now (its size: an unfinished last line is read to the same end every time), and waits for nothing: two sizes,
        nothing read. `models` (setup: the model keys on disk, one listing): every model it names that was there is still
        there - a model file deleted since would leave its parts empty until the next build."""
        if not entry or entry.get('stamp') != self.stamp or entry.get('waits') or entry.get('repair'): return False
        try:
            if not (entry.get('rawSize') == os.path.getsize(os.path.join(self.folder, 'battles', name+'.jsonl')) and
                    entry.get('size') == os.path.getsize(os.path.join(self.folder, 'data', 'battles', name+'.js'))):
                return False
        except OSError:
            return False
        if models is not None and not (entry['refs'] - set(entry.get('absent') or ())) <= models: return False
        return True

    def model_files(self):
        """The model keys in data/models, one listing (setup's check of the saved battles); none without the folder."""
        try:
            return set(name[:-3] for name in os.listdir(os.path.join(self.folder, 'data', 'models')) if name.endswith('.js'))
        except OSError:
            return set()

    def legacy_entry(self, name, entry):
        """An entry of 0.9.3 ('d<format>:<sha1 of the client that built the file>'): current - stamped by the format alone -
        when the battle's own client built it (its raw header's clientVersion; one readline), else marked for the repair:
        built under another client, its fill-ins were left out (BACKLOG 55, 02.10). Any other entry as it is."""
        match = LEGACY_STAMP.match(str((entry or {}).get('stamp') or ''))
        if not match: return entry
        header = read_header(os.path.join(self.folder, 'battles', name + '.jsonl')) or {}
        own = version_hash(header.get('clientVersion')) if header.get('clientVersion') else None
        entry = dict(entry, stamp='d%s' % match.group(1), built=match.group(2))
        if own is not None: entry['client'] = own
        if own != match.group(2): entry['repair'] = True
        self.published_dirty = True
        return entry

    def header_summary(self, name):
        """The list's row of a battle no state or index names (a crash before its first publish, a copied raw file): its
        header line alone - id, start, map; the hits are not counted before it is prepared."""
        header = read_header(os.path.join(self.folder, 'battles', name + '.jsonl'))
        if header is None: return None
        return {'id': name, 'startedAt': header.get('startedAt'), 'map': header.get('map'), 'hits': '?'}

    def saved_battles(self):
        """Setup's look at the saved battles. A current one (published_current) is taken as it is: its summary, model
        references and raw offset from data/published.json. Any other is 'stale' - prepared when the page opens it
        (request_battle), never here nor in the background (BACKLOG 55); the index lists it with its last summary (its
        entry's, else the previous index's, else its header line's), and its references are its file's when the entry is
        that file's. Returns (every name a battle id, current count, [stale ids], every reference known)."""
        stored = self.read_published()
        # One listing of data/models for all of them (a battle whose model file was deleted is prepared again).
        models = self.model_files() if stored else None
        previous = None
        named, refs_known, current, queued = True, True, 0, []
        for path in sorted(glob.glob(os.path.join(self.folder, 'battles', '*.jsonl'))):
            name = os.path.basename(path)[:-6]
            # A name that is not a battle id ("X - Copy.jsonl" from a file manager or a sync conflict) cannot be
            # published, and its hits may name models no other battle does: the set is then incomplete (F5, 24.09).
            if not IDENTIFIER.match(name):
                named = False
                LOG.warning('Battle file with an unexpected name is not published: %s', os.path.basename(path))
                continue
            entry = self.legacy_entry(name, stored.get(name))
            if self.published_current(name, entry, models):
                self.published[name] = entry
                self.summaries[name] = dict(entry['summary'] or {'id':name})
                self.model_refs[name] = set(entry['refs'])
                self.raw_offsets[name] = entry['raw']
                current += 1
                continue
            queued.append(name)
            self.stale.add(name)
            try:
                same = entry is not None and entry.get('size') == os.path.getsize(
                    os.path.join(self.folder, 'data', 'battles', name+'.js'))
            except OSError:
                same = False
            # A battle to repair (built under another client, its fill-ins left out): its file names fewer models than the
            # battle needs - the prune must not take the outer track pair's or the prefab's model before it is prepared.
            if same and not entry.get('repair'):
                self.published[name] = entry
                self.model_refs[name] = set(entry['refs'])
            else:
                if same: self.published[name] = entry
                refs_known = False
                self.refs_unknown.add(name)
            summary = entry.get('summary') if entry else None
            if summary is None:
                if previous is None: previous = self.index_summaries()
                summary = previous.get(name) or self.header_summary(name)
            if summary: self.summaries[name] = dict(summary)
        self.published_dirty = self.published_dirty or set(stored) != set(self.published)
        return named, current, queued, refs_known

    def index_summaries(self):
        """{battle id: summary} of the index written by the previous run, {} when it does not read."""
        try:
            value = read_data_file(os.path.join(self.folder, 'data', 'index.js'))
            return dict((str(row['id']), row) for row in value.get('battles') or ()
                        if isinstance(row, dict) and IDENTIFIER.match(str(row.get('id') or '')))
        except Exception:
            return {}

    def republish_saved(self, battle_id):
        """Publish one saved battle again, at once: the active one from memory, any other read from its raw file (its
        offset kept for the tail and for data/published.json). drain_republish's path. The background's slices of this
        battle, if any, are dropped: their hits were prepared before what made this publish necessary."""
        self.drop_battle_work(battle_id)
        if self.current is not None and self.current.get('id') == battle_id:
            self.publish(self.current)
            return
        reader = BattleReader(os.path.join(self.folder, 'battles', battle_id+'.jsonl'))
        reader.step()
        battle = reader.result()
        self.raw_offsets[battle_id] = reader.offset
        self.publish(battle, reader.offset, raw_size=reader.size)

    def drop_battle_work(self, battle_id=None):
        """Forget the background's slices of this battle (of any, without an id): its job, still queued, starts it anew."""
        work = self.battle_work
        if work is not None and (battle_id is None or work['name'] == battle_id): self.battle_work = None

    def battle_stop(self):
        """A slice of a battle's preparation ends after this line or hit: a battle, a drag of the page (not for the battle the
        page asked for: preparing_page - the user dragging the scene of its old file must not hold it back), a command of
        the page waiting to be read (its click's job goes first), the mod closing."""
        return self.ttx_stopped or not self.jobs_allowed(self.preparing_page) or self.sweep_waiting()

    def request_battle(self, battle_id):
        """The page's 'prepareBattle' (BACKLOG 55): it opened a saved battle the index says is stale and shows its old file
        meanwhile. That battle alone is prepared at the page's turn (JOB_PAGE: before the background, through a drag, never
        in a battle); its new revision in the index tells the page to read it again. True when a job was queued."""
        name = str(battle_id or '')
        if not IDENTIFIER.match(name) or name in self.skipped: return False
        if not os.path.isfile(os.path.join(self.folder, 'battles', name + '.jsonl')): return False
        if name not in self.stale and self.published_current(name, self.published.get(name)): return False
        if self.current is not None and self.current.get('id') == name: return False
        self.queue_job(JOB_PAGE, 'battle', {'battleId': name})
        LOG.info('Saved battle %s asked for by the page: prepared now', name)
        return True

    def run_battle_job(self, payload):
        """One slice of a saved battle the page asked for (request_battle): lines of its raw file (BattleReader), then its hits
        prepared, then its file and the index written - for BATTLE_SLICE seconds, the gates checked after every line and
        hit (battle_stop); every slice does one line, hit or write at least. True when the battle needs another slice:
        run_job puts the job back in its place, and whatever the page waits for goes first meanwhile. Passed over when it
        is current by now (the tail made it the active battle and published it) or skipped; a failure is logged and keeps
        the prune off. 0.8.7 did a battle in one go: 0.5-11 s in the game (11.4 s for 53 MB raw), a click waiting behind."""
        name = str((payload or {}).get('battleId') or '')
        began = TTX_TIMER()
        # The tail made it the active battle since the last slice: what was read is not what is in memory now.
        if self.current is not None and self.current.get('id') == name: self.drop_battle_work(name)
        work = self.battle_work
        if work is not None and work['name'] != name:
            self.drop_battle_work()
            work = None
        failed = done = False
        try:
            if work is None:
                # A battle passed over this session keeps its references unknown: no prune after the backlog either.
                if name in self.skipped: failed = done = True
                # Published this session already (the tail made it the active battle): its entry is this session's.
                elif (str(((self.published.get(name) or {}).get('summary') or {}).get('rev') or '').startswith(self.session + '.')
                      and self.published_current(name, self.published.get(name))): done = True
                elif self.current is not None and self.current.get('id') == name:
                    self.republish_saved(name)
                    self.write_index()
                    done = True
                else:
                    for state in (self.fill_reads, self.kept_files, self.kept_now): state.pop(name, None)
                    work = self.battle_work = {'name':name, 'battle':None, 'prepared':[], 'started':began,
                                               'work':0.0, 'slices':0,
                                               'reader':BattleReader(os.path.join(self.folder, 'battles', name+'.jsonl'))}
            if work is not None:
                deadline = began + BATTLE_SLICE
                stop = lambda: TTX_TIMER() >= deadline or self.battle_stop()
                reader, prepared = work['reader'], work['prepared']
                stopped = worked = False
                if not reader.done:
                    stopped = not reader.step(stop)
                    worked = True
                    if not stopped: work['battle'] = reader.result()
                battle = work['battle']
                if battle is not None and not stopped:
                    hits = battle.get('hits') or []
                    while len(prepared) < len(hits):
                        index = len(prepared)
                        prepared.append(self.prepare_hit(hits[index], index, battle))
                        worked = True
                        if stop():
                            stopped = True
                            break
                    # The file: in this slice when it has time left, else first thing in the next.
                    if len(prepared) == len(hits) and not (worked and stop()):
                        self.raw_offsets[name] = reader.offset
                        self.publish(battle, reader.offset, prepared=prepared, raw_size=reader.size)
                        self.write_index()
                        done = True
        except Exception:
            failed = done = True
            LOG.exception('Could not rebuild saved battle: %s', name)
            # Its references stay unknown: the prune that waited for them does not run this session (EXP-02/DATA-02).
            if name in self.refs_unknown and self.prune_waits:
                self.prune_waits = False
                LOG.warning('Unused models kept this session: saved battle %s could not be read', name)
        spent = max(0.0, TTX_TIMER() - began)
        if work is not None:
            work['work'] += spent
            work['slices'] += 1
        if not done:
            # A battle began: the record read so far is let go (a big one is hundreds of MB of objects); the job, still
            # queued, starts the battle again after it.
            if not self.xml_allowed(): self.drop_battle_work(name)
            if self.backlog is not None: self.backlog['work'] += spent
            return True
        if work is not None:
            self.drop_battle_work(name)
            megabytes = (work['reader'].size or 0) / 1e6
            wall = TTX_TIMER() - work['started']
            # The pace in the game (review of 4b1c8c8 #10): the big or slow ones one line each, the rest in the summary.
            # A battle the page asked for: one line each (the wait the user had; BACKLOG 55 asks for it measured in the game).
            if self.preparing_page:
                LOG.info('Saved battle %s prepared for the page: %.1f MB raw, %d hits, %.2f s (%.2f s of work in %d slices)',
                         name, megabytes, len(work['prepared']), wall, work['work'], work['slices'])
            elif megabytes >= BATTLE_LOG_MB or wall >= BATTLE_LOG_WALL:
                LOG.info('Saved battle %s published in the background: %.1f MB raw, %d hits, %.1f s (%.2f s of work in %d '
                         'slices)', name, megabytes, len(work['prepared']), wall, work['work'], work['slices'])
        backlog = self.backlog
        if backlog is None or name not in backlog['left']: return False
        backlog['left'].discard(name)
        backlog['work'] += spent
        if work is not None:
            backlog['mb'] += megabytes
            backlog['slices'] += work['slices']
            if backlog['slowest'] is None or wall > backlog['slowest'][1]:
                backlog['slowest'] = (name, wall, work['work'], megabytes)
        if failed: backlog['failed'] += 1
        if not backlog['left']: self.finish_backlog()
        return False

    def finish_backlog(self):
        """The last saved battle of setup's backlog is published: one log line, the prune its references waited for."""
        backlog, self.backlog = self.backlog, None
        slowest = backlog['slowest']
        LOG.info('Saved battles published in the background: %d in %.1f s (%.1f s of work, %.0f MB raw, %d slices)%s',
                 backlog['count'], time.time() - backlog['started'], backlog['work'], backlog['mb'], backlog['slices'],
                 '; the longest %s: %.1f MB, %.1f s (%.2f s of work)' % (slowest[0], slowest[3], slowest[1], slowest[2])
                 if slowest else '')
        if backlog['failed']:
            LOG.warning('Unused models kept this session: %d saved battle(s) could not be read', backlog['failed'])
        elif backlog['prune']:
            self.write_index(prune=True)
        self.write_published()

    # ---- THE CLIENT'S FILES (BACKLOG 55): one snapshot of path -> (CRC, size), the source of every key below.
    def client(self):
        """The client's snapshot (client_snapshot.ClientSnapshot), refreshed once a session - setup does it first, so its one
        log line says what an update changed. None when it cannot be had: the keys then fall back to the client version."""
        if self.client_state is None:
            try:
                snapshot = ClientSnapshot(self.game, self.folder, self.version)
                snapshot.refresh()
                snapshot.files()
                self.client_state = snapshot
            except Exception as error:
                self.client_state = False
                LOG.warning('Client files unreadable (%r): this session the keys fall back to the client version', error)
        return self.client_state or None

    def client_files(self, version=None):
        """{path: (crc, size)} of the running client, or of the client of `version` (a battle's clientVersion text): given
        from outside (client_snapshots[version]), the snapshot this mod took of it, or one derived from a later snapshot and
        what the update changed (client_changes.py; a changed path's crc is negative - unknown). None when unknown."""
        if version is not None:
            for text in (version, canonical(version)):
                if text in self.client_snapshots: return self.client_snapshots[text]
            if canonical(version) == self.version: version = None
        snapshot = self.client()
        if snapshot is None: return None
        try:
            return snapshot.files(None if version is None else canonical(version))
        except Exception:
            return None

    def client_crc(self, path, version=None):
        """THE HELPER FOR THE BATTLES (BACKLOG 55): ('%08x' CRC, size) of one client file - of the running client, or of the
        client of `version` (a battle's clientVersion text) - or None when that client has no such file in the snapshot's
        scope (scripts/, collision .havok, vehicle prefabs, material_kinds.xml, lc_messages/*.mo) or nothing is known of
        that client. '?' for a CRC that is unknown (a derived snapshot's changed path): it equals no real CRC."""
        files = self.client_files(version)
        entry = None if files is None else files.get(path)
        if entry is None: return None
        return ('?' if entry[0] < 0 else '%08x' % entry[0], entry[1])

    def client_signature(self, paths, version=None):
        """One '%08x' over the CRCs and sizes of the given client files (a missing one counts as missing, an unknown one as
        '?'), of the running client or of `version`'s; None when that client is unknown. Two equal signatures of two clients:
        the same inputs."""
        files = self.client_files(version)
        if files is None: return None
        lines = []
        for path in sorted(set(paths)):
            entry = files.get(path)
            lines.append('%s=%s' % (path, '-' if entry is None else '?' if entry[0] < 0 else '%08x:%d' % entry))
        return '%08x' % (zlib.crc32('\n'.join(lines).encode('utf-8')) & 0xffffffff)

    # ---- THE CLIENT'S CODE (BACKLOG 55): the code set and its identity.
    def code_state(self):
        """data/code-state.json: {'modules': {path: [crc, identity]} of the code set, 'objects': {module:name: identity} of
        what the set takes from modules outside it and 'objectsBasis' ({path: crc} they were read from), 'watch': {path: [crc,
        identity]} of modules only the game's recording saw a build execute, 'generation', 'client' (the version text the
        generation was set under), 'exe' ([size, mtime] of the game's exe)}."""
        if self.code_state_value is None:
            value = None
            try:
                path = os.path.join(self.folder, 'data', CODE_STATE_FILE)
                if os.path.isfile(path):
                    with open(path, 'rb') as stream: value = json.loads(stream.read().decode('utf-8'))
                if not (isinstance(value, dict) and value.get('format') == 1 and isinstance(value.get('modules'), dict)): value = None
            except Exception:
                value = None
            value = value or {'format': 1, 'modules': {}, 'generation': None, 'client': None, 'exe': None}
            value.setdefault('watch', {})
            # The game's recording added modules to the set until the second review (02.10): they are watched now.
            for path in value.pop('recorded', None) or ():
                if path in value['modules'] and path not in CODE_MODULES: value['watch'][path] = value['modules'].pop(path)
            self.code_state_value = value
        return self.code_state_value

    def write_code_state(self):
        try:
            atomic_write(os.path.join(self.folder, 'data', CODE_STATE_FILE),
                         json.dumps(self.code_state(), sort_keys=True, separators=(',', ':')).encode('ascii'))
        except Exception:
            LOG.exception('Client code state not written; the code set is looked at again next start')

    def code_modules(self):
        """The code set: client_code.CODE_MODULES - what the offline stand saw the builds execute and what that code names.
        What only the game's recording saw is watched (code_record), not part of it."""
        return sorted(CODE_MODULES)

    def module_identity(self, path, entry):
        """code_identity of a client module (its .pyc from the snapshot's source); 'bytes:<crc>' when its bytes do not
        decode; None when they could not be read now (unknown: never taken for a change)."""
        try:
            data = self.client().read(path)
        except Exception:
            return None
        if data is None: return None
        try:
            return code_identity(marshal.loads(data[8:]))
        except Exception:
            return 'bytes:%08x:%d' % entry

    def exe_stat(self):
        for path in (os.path.join(self.game, 'win64', 'WorldOfTanks.exe'), os.path.join(self.game, 'WorldOfTanks.exe')):
            try:
                stat = os.stat(path)
                return [int(stat.st_size), repr(stat.st_mtime)]
            except OSError:
                continue
        return None

    # ---- the durable client change check (second review A)
    def verify_state(self):
        """data/verify.json: {'pending': [reasons of a sample check not run to its end], 'everything': a 'Missed change'
        asked for every file, 'stand': the client whose stand changes were rebuilt}."""
        if getattr(self, 'verify_state_value', None) is None:
            value = None
            try:
                path = os.path.join(self.folder, 'data', VERIFY_STATE_FILE)
                if os.path.isfile(path):
                    with open(path, 'rb') as stream: value = json.loads(stream.read().decode('utf-8'))
                if not (isinstance(value, dict) and value.get('format') == 1): value = None
            except Exception:
                value = None
            self.verify_state_value = value or {'format': 1, 'pending': [], 'everything': False, 'stand': None}
        return self.verify_state_value

    def write_verify_state(self):
        try:
            atomic_write(os.path.join(self.folder, 'data', VERIFY_STATE_FILE),
                         json.dumps(self.verify_state(), sort_keys=True).encode('ascii'))
        except Exception:
            LOG.exception('Client change check state not written; the check is asked for again next start')

    def code_generation(self):
        """The generation of the client's code, once a session: changed when a module of the code set or a name the set
        takes from outside it changed its identity (a line shift is none; a module that does not read now is unknown, not
        changed) - every characteristics and vehicle file is then rebuilt. The sample check is asked for (code_samples, kept
        in data/verify.json until it ran to its end) when the game's exe changed, a module of the set changed its bytes but
        not its code, a watched module changed, or a module outside the set changed. None without a snapshot."""
        if self.code_generation_value is not None: return self.code_generation_value
        try:
            return self.take_code_generation()
        finally:
            # The packages read() opened for the identities: never left open (the launcher updates them).
            if self.client_state: self.client_state.close()

    def take_code_generation(self):
        files = self.client_files()
        if files is None: return None
        state = self.code_state()
        stored, first = state['modules'], state.get('generation') is None
        changed, shifted, unknown, now = [], [], [], {}
        for path in self.code_modules():
            entry = files.get(path)
            crc = crc_text(entry)
            old = stored.get(path)
            identity = old[1] if old and old[0] == crc else None
            if identity is None and crc != '?':
                identity = '-' if entry is None else self.module_identity(path, entry)
            if identity is None:
                # Not readable now (a package locked, left out of the snapshot): unknown - kept as it was, tried again.
                unknown.append(path)
                if old: now[path] = old
                continue
            if old is not None:
                if old[1] != identity: changed.append(path)
                elif old[0] != crc: shifted.append(path)
            elif not first and not self.code_same_since(path, crc):
                changed.append(path)
            now[path] = [crc, identity]
        objects, objects_changed = self.code_objects(state, files, unknown)
        if first or changed or objects_changed:
            text = '\n'.join(['%s=%s' % (p, now[p][1]) for p in sorted(now)] + ['%s=%s' % (k, objects[k]) for k in sorted(objects)])
            state['generation'] = hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]
            state['client'] = self.version
            if changed or objects_changed:
                LOG.info('Client code changed in %d module(s) the builds execute and %d name(s) they take from other modules '
                         '(%s): every characteristics and vehicle file is built again and compared', len(changed),
                         len(objects_changed), ', '.join((changed + objects_changed)[:5]))
        if unknown:
            LOG.warning('Client code: %d module(s) of the set unreadable now (%s): taken as they were, looked at again next start',
                        len(unknown), ', '.join(unknown[:3]))
        state['modules'], state['objects'] = now, objects
        # The watched modules (only the game's recording saw them): a change asks for the sample check, nothing more.
        watched = []
        for path, old in sorted(state['watch'].items()):
            entry = files.get(path)
            crc = crc_text(entry)
            if crc == '?' or old[0] == crc: continue
            identity = '-' if entry is None else self.module_identity(path, entry)
            if identity is None: continue
            if identity != old[1]: watched.append(path)
            state['watch'][path] = [crc, identity]
        exe = self.exe_stat()
        snapshot = self.client()
        diff = (snapshot.diff or {}) if snapshot is not None else {}
        outside = [p for p in diff.get('changed', []) + diff.get('added', []) + diff.get('removed', [])
                   if p.endswith('.pyc') and p not in now and p not in state['watch']]
        reasons = []
        if not first and state.get('exe') and exe != state.get('exe'): reasons.append('the game\'s executable')
        if shifted: reasons.append('%d module(s) of the set rebuilt with the same code' % len(shifted))
        if watched: reasons.append('%d watched module(s) (%s)' % (len(watched), ', '.join(watched[:3])))
        if outside: reasons.append('%d client module(s) outside the set (%s)' % (len(outside), ', '.join(outside[:3])))
        state['exe'] = exe
        self.write_code_state()
        pending = self.verify_state()
        if reasons:
            pending['pending'] = sorted(set(pending.get('pending') or ()) | set(reasons))
            self.write_verify_state()
        self.code_samples = list(pending.get('pending') or ())
        self.code_generation_value = state['generation']
        return self.code_generation_value

    def code_objects(self, state, files, unknown):
        """({'<module>:<name>': identity}, [changed]) of what the set takes from modules outside it (client_objects). Read
        only when a module it was read from changed; unknown when a module of the set or of them does not read now."""
        basis = state.get('objectsBasis') or {}
        old = state.get('objects')
        if old is not None and basis and all(crc_text(files.get(p)) == c for p, c in basis.items()) and not unknown:
            return old, []
        if unknown: return old or {}, []
        snapshot = self.client()
        failed = []

        def read(path):
            try:
                data = snapshot.read(path)
            except Exception:
                data = None
            if data is None:
                # A module the client has that did not read now is unknown; one it does not have is simply absent.
                if path in files: failed.append(path)
                raise IOError(path)
            return data
        objects = Objects(read, lambda p: p in files, lambda p: crc_text(files.get(p)), code_identity)
        try:
            found = objects.external(self.code_modules())
        except Exception:
            LOG.exception('Client code: the names the set takes from other modules not read; taken as they were')
            return old or {}, []
        if failed or any(crc_text(files.get(p)) == '?' for p in objects.read_paths):
            return old or {}, []
        state['objectsBasis'] = dict((p, crc_text(files.get(p))) for p in objects.read_paths)
        if old is None: return found, []
        return found, sorted(k for k in set(old) | set(found) if old.get(k) != found.get(k))

    def code_same_since(self, path, crc):
        """A module new to the set had this very file when the generation was set (its client's snapshot): nothing to rebuild."""
        then = self.client_files(self.code_state().get('client'))
        if then is None: return False
        return crc == crc_text(then.get(path)) and crc != '?'

    def code_record(self, paths):
        try:
            self.record_code(paths)
        finally:
            if self.client_state: self.client_state.close()

    def record_code(self, paths):
        """Modules the game saw a build execute that the stand's set lacks (second review D): WATCHED - their change asks for
        the sample check, raises no generation, closes no fill-in gate and no proof. Logged, so the stand can be corrected."""
        files = self.client_files()
        if files is None: return
        state = self.code_state()
        added = []
        for path in sorted(set(paths) - set(self.code_modules()) - set(state['watch'])):
            entry = files.get(path)
            if entry is None or entry[0] < 0: continue
            identity = self.module_identity(path, entry)
            if identity is None: continue
            state['watch'][path] = [crc_text(entry), identity]
            added.append(path)
        if not added: return
        LOG.info('Client code: %d module(s) the builds executed are not in the stand\'s set - watched (a change runs the sample '
                 'check); correct the stand at the next build: %s', len(added), ', '.join(added[:8]))
        self.write_code_state()

    def flush_code_seen(self):
        if self.code_seen:
            seen, self.code_seen = self.code_seen, set()
            try: self.code_record(seen)
            except Exception: LOG.exception('Client code set not recorded')

    def recorded_build(self, action, *args, **kwargs):
        """One build of a background pass, with the modules it executes recorded (the C profiler of this thread only, no call
        tree: second review G)."""
        profiler = None
        try:
            import _lsprof
            profiler = _lsprof.Profiler(builtins=False, subcalls=False)
            profiler.enable()
        except Exception:
            profiler = None
        try:
            return action(*args, **kwargs)
        finally:
            if profiler is not None:
                try:
                    profiler.disable()
                    for entry in profiler.getstats():
                        code = entry.code
                        name = getattr(code, 'co_filename', None)
                        if name and name.startswith('scripts/') and name.endswith('.py'): self.code_seen.add(name + 'c')
                except Exception:
                    pass

    def code_inputs_same(self, version):
        """The client of `version` (a file's clientVersion) had the very files of the code set this one has (CRCs, none
        unknown): files it built were built with this code."""
        cache = getattr(self, 'code_same_cache', None)
        if cache is None: cache = self.code_same_cache = {}
        if version in cache: return cache[version]
        now, then = self.client_files(), self.client_files(version)
        same = bool(now is not None and then is not None and all(
            now.get(p) == then.get(p) and (now.get(p) is None or now.get(p)[0] >= 0) for p in self.code_modules()))
        cache[version] = same
        return same

    # ---- model files by content (BACKLOG 55)
    def model_path(self, key):
        return os.path.join(self.folder, 'data', 'models', key + '.js')

    def model_content(self, resource, version=None):
        """model_content_key of a resource of the running client (or of the client of `version`), None when its .havok is
        not in that client's snapshot or its CRC there is unknown."""
        havok = str(resource).rsplit('.', 1)[0] + '.havok'
        files = self.client_files(version)
        entry = files.get(havok) if files else None
        if entry is None or entry[0] < 0: return None
        return model_content_key(havok, '%08x' % entry[0], entry[1])

    def model_ref(self, resource, version):
        """The model file of a part: for a battle of another client (and without a snapshot) the name by the version text,
        as before; for the running client the file of the same content - one named by it, or one named by an earlier client's
        version text that holds the same .havok (models_index: verified by its sha256 when the model was first wanted)."""
        legacy = model_key(resource, version)
        aliases = self.models_index()['aliases']
        if canonical(version) != self.version:
            # A battle of another client: its file as that client named it; else the file of the same content, when that
            # client's .havok is known (client_files: this mod's snapshot of it, or one derived) - its model by content. When
            # it is the very .havok of this client (review 02.10 #2: the repair of a 2.4.0.1 battle whose added part has no
            # model yet), the content key even without a file: model_extract exports it from this client.
            if os.path.isfile(self.model_path(legacy)): return legacy
            content = self.model_content(resource, version)
            if content is not None:
                if os.path.isfile(self.model_path(content)): return content
                alias = aliases.get(content)
                if alias and os.path.isfile(self.model_path(alias)): return alias
                if content == self.model_content(resource): return content
            return legacy
        content = self.model_content(resource)
        if content is None:
            # No snapshot (review 02.10 #1c): the name by the version text, or the earlier file found to hold the same .havok.
            alias = aliases.get(legacy)
            return alias if alias and not os.path.isfile(self.model_path(legacy)) and os.path.isfile(self.model_path(alias)) else legacy
        if os.path.isfile(self.model_path(content)): return content
        alias = aliases.get(content)
        if alias and os.path.isfile(self.model_path(alias)): return alias
        return content

    def models_index(self):
        """{'aliases': {content key: file}, 'files': {file: [havok, sha256 of its bytes]}} (MODELS_INDEX_FILE), read once."""
        if self.models_index_value is None:
            value = None
            try:
                path = os.path.join(self.folder, 'data', MODELS_INDEX_FILE)
                if os.path.isfile(path):
                    with open(path, 'rb') as stream: value = json.loads(stream.read().decode('utf-8'))
                if not (isinstance(value, dict) and value.get('format') == MODEL_FILE_FORMAT
                        and isinstance(value.get('aliases'), dict) and isinstance(value.get('files'), dict)): value = None
            except Exception:
                value = None
            self.models_index_value = value or {'format': MODEL_FILE_FORMAT, 'aliases': {}, 'files': {}}
            self.models_index_value['scanned'] = False
        return self.models_index_value

    def model_identity(self, name):
        """(havok, sha256 of its bytes, MODEL_FILE_FORMAT it was written in) of a model file - read from the file once and
        kept in models_index - or (name,) when it does not read. Two files of one identity are the same model."""
        files = self.models_index()['files']
        if name not in files or len(files[name]) < 3:
            files[name] = self.read_model_identity(name)
            self.models_index_dirty = True
        found = files.get(name)
        return tuple(found) if found and found[0] else (name,)

    def read_model_identity(self, name):
        try:
            path = self.model_path(name)
            size = os.path.getsize(path)
            with open(path, 'rb') as stream:
                head = stream.read(1024).decode('ascii', 'replace')
                stream.seek(max(0, size - 256))
                tail = stream.read().decode('ascii', 'replace')
            resource = re.search(r'"resource":"([^"]+)"', head) or re.search(r'"resource":"([^"]+)"', tail)
            digest = re.search(r'"sha256":"([0-9a-f]{64})"', tail) or re.search(r'"sha256":"([0-9a-f]{64})"', head)
            # The format is written after the geometry (model_document; the order Python 2 gives its keys): in the tail when
            # there at all - none is format 1 (every file 0.9.3 wrote).
            form = re.search(r'"format":(\d+)', tail) or re.search(r'"format":(\d+)', head)
            if resource and digest: return [resource.group(1), digest.group(1), int(form.group(1)) if form else 1]
            value = read_data_file(path)
            return [str(value['resource']), str(value['sha256']), int(value.get('format', 1))]
        except Exception:
            return ['', '', 0]

    def adopt_model(self, havok, content, data):
        """A model file of an earlier name that holds exactly these bytes of `havok` (by the sha256 it keeps): it becomes the
        file of `content` (no export). The folder is scanned once a session, each file read once ever (models_index)."""
        index = self.models_index()
        if not index['scanned']:
            index['scanned'] = True
            names = set(self.model_files())
            for name in [n for n in index['files'] if n not in names]:
                del index['files'][name]
                self.models_index_dirty = True
            for name in sorted(names):
                if name not in index['files']: self.model_identity(name)
            for key in [k for k, name in index['aliases'].items() if name not in names]:
                del index['aliases'][key]
                self.models_index_dirty = True
        digest = hashlib.sha256(data).hexdigest()
        # The files by the .havok they hold, once a session (a model a time would walk them all).
        by_havok = getattr(self, 'models_by_havok', None)
        if by_havok is None or by_havok[0] != len(index['files']):
            found = {}
            for name, entry in index['files'].items():
                if entry and entry[0]: found.setdefault(entry[0], []).append(name)
            by_havok = self.models_by_havok = (len(index['files']), found)
        for name in sorted(by_havok[1].get(havok, ())):
            entry = index['files'][name]
            # The same bytes AND the same format (review 02.10 #4: a raised MODEL_FILE_FORMAT took the old files over).
            if (entry and entry[0] == havok and entry[1] == digest and (entry[2] if len(entry) > 2 else 1) == MODEL_FILE_FORMAT
                    and os.path.isfile(self.model_path(name))):
                index['aliases'][content] = name
                self.models_index_dirty = True
                return name
        return None

    # ---- the vehicle files' keys (BACKLOG 55)
    def vehicle_keys(self):
        """{vehicle id: key} of the vehicle files (VEHICLE_KEYS_FILE), read once."""
        if self.vehicle_keys_value is None:
            value = None
            try:
                path = os.path.join(self.folder, 'data', VEHICLE_KEYS_FILE)
                if os.path.isfile(path):
                    with open(path, 'rb') as stream: value = json.loads(stream.read().decode('utf-8'))
                if not (isinstance(value, dict) and value.get('format') == 1 and isinstance(value.get('keys'), dict)): value = None
            except Exception:
                value = None
            self.vehicle_keys_value = dict((value or {}).get('keys') or {})
        return self.vehicle_keys_value

    def write_keys(self, force=False):
        """The vehicle files' keys and the models' index, when changed - at most every SWEEP_CATALOGUE_PAUSE s unless forced."""
        if not force and time.time() - self.vehicle_keys_written < SWEEP_CATALOGUE_PAUSE: return
        self.vehicle_keys_written = time.time()
        try:
            if self.vehicle_keys_dirty:
                atomic_write(os.path.join(self.folder, 'data', VEHICLE_KEYS_FILE), json.dumps(
                    {'format': 1, 'keys': self.vehicle_keys()}, sort_keys=True, separators=(',', ':')).encode('ascii'))
                self.vehicle_keys_dirty = False
            if self.models_index_dirty:
                index = dict(self.models_index())
                index.pop('scanned', None)
                atomic_write(os.path.join(self.folder, 'data', MODELS_INDEX_FILE),
                             json.dumps(index, sort_keys=True, separators=(',', ':')).encode('ascii'))
                self.models_index_dirty = False
        except Exception:
            LOG.exception('Vehicle keys or the models index not written; those files are checked again next start')

    def vehicle_key(self, record):
        """'<data>.<epoch>.<own>' of a vehicle file (or its summary): its type's data (ttx_source_keys with VEHICLE_FORMAT),
        the client's code (code_generation), and its own inputs - the compact descriptor, each part's .havok and prefab. Raises
        without a snapshot."""
        type_name = str(record.get('type') or '')
        if type_name not in self.vehicle_bases:
            types = set([type_name]) | set(str(s.get('type') or '') for s in self.vehicles.values())
            self.vehicle_bases.update(self.ttx_source_keys(sorted(t for t in types if ':' in t and t not in self.vehicle_bases),
                                                           self.source_crcs(), 'vehicle-%d' % VEHICLE_FORMAT))
        files = self.client_files()
        lines = ['compact=%s' % (record.get('compactDescriptor') or '')]
        for part in record.get('parts') or ():
            if not isinstance(part, dict): continue
            for path in (str(part['resource']).rsplit('.', 1)[0] + '.havok' if part.get('resource') else None, part.get('prefab')):
                if not path: continue
                entry = files.get(path)
                lines.append('%s=%s' % (path, '-' if entry is None else '%08x:%d' % entry))
        own = '%08x' % (zlib.crc32('\n'.join(sorted(lines)).encode('utf-8')) & 0xffffffff)
        return '%s.%s.%s' % (self.vehicle_bases.get(type_name, '-'), self.code_generation() or '-', own)

    def vehicle_own(self, record, files):
        own = ['compact=%s' % (record.get('compactDescriptor') or '')]
        for part in record.get('parts') or ():
            if not isinstance(part, dict): continue
            for path in (str(part['resource']).rsplit('.', 1)[0] + '.havok' if part.get('resource') else None, part.get('prefab')):
                if path:
                    entry = files.get(path)
                    own.append('%s=%s' % (path, '-' if entry is None else '?' if entry[0] < 0 else '%08x:%d' % entry))
        return sorted(own)

    def proven(self, type_name, version, record=None):
        """A file made by the client of `version` (a 0.9.3 file has no key) holds what this client would build: its type's
        data files, the code set and - a vehicle file - its own models and prefabs are the same files in both clients (that
        client's snapshot: this mod's, or one derived from the update's changes). No build needed: its key is kept."""
        version = canonical(version or '')
        if not version: return False
        # Built by this build's format, whichever client (second review F): a vehicle file names it (none: format 1).
        if record is not None and record.get('format', 1) != VEHICLE_FORMAT: return False
        if version != self.version:
            then = self.client_files(version)
            if then is None or not self.code_inputs_same(version): return False
            tables = getattr(self, 'proof_crcs', None)
            if tables is None: tables = self.proof_crcs = {}
            if version not in tables: tables[version] = self.source_crcs_of(then)
            data = self.ttx_source_keys([type_name], tables[version], 'proof')
            if data != self.ttx_source_keys([type_name], self.source_crcs(), 'proof'): return False
            if record is not None and self.vehicle_own(record, then) != self.vehicle_own(record, self.client_files()): return False
        return True

    def vehicle_current(self, summary):
        """An exported vehicle file is what this client and this build would write now: its key (vehicle_key) is the one it
        was last built or checked with (vehicle_keys). Without a snapshot: written by this client version, as before."""
        if not summary: return False
        stored = self.vehicle_keys().get(str(summary.get('id') or ''))
        if self.client() is not None:
            try:
                return stored == self.vehicle_key(summary)
            except Exception:
                pass
        # No snapshot (review 02.10 #1b): current only when written or checked by this very client - its version text, or the
        # fallback key a check under it left; another client's file is unknown, never current.
        return stored == self.fallback_key() or canonical(summary.get('clientVersion') or '') == self.version

    def fallback_key(self):
        """The key of a file checked while there is no snapshot: this client's version text (a different one - another
        client - is unknown). Never equal to a key from a snapshot, so the next snapshot checks the file again."""
        return 'version:' + hashlib.sha1(self.version.encode('utf-8')).hexdigest()[:16]

    def mounted_packages(self):
        """The client's packages in the order paths.xml mounts them (the collision index and the TTX sources' keys)."""
        package_root = os.path.normcase(os.path.abspath(os.path.join(self.game, 'res', 'packages')))
        manifest = os.path.join(self.game, 'paths.xml')
        if os.path.isfile(manifest):
            mounted = ET.parse(manifest).findall('.//Packages/Package')
            paths = []
            for node in mounted:
                path = os.path.abspath(os.path.join(self.game, (node.text or '').strip()))
                if (os.path.normcase(path).startswith(package_root + os.sep)
                        and path.lower().endswith('.pkg') and os.path.isfile(path)):
                    if path not in paths: paths.append(path)
            return paths
        # Offline fixtures/older layouts without a mounting manifest.
        return sorted(glob.glob(os.path.join(self.game, 'res', 'packages', '*.pkg')))

    def _index_resources(self):
        # Event/shared models are mounted outside vehicles*.pkg. Read only ZIP
        # directories here; decode one selected model later on the idle worker.
        paths = self.mounted_packages()
        packages, signatures, conflicts, overrides, entries = {}, {}, set(), set(), {}
        # The vehicles' CGF prefabs too (27.09): an armoured one's JSON is read for its collider and armour (type_extras).
        # The first package that has one wins, as for the models; they are few (two armoured of 287).
        prefabs = {}
        skipped = []
        for path in paths:
            # The raw directory (collision_members, 25.09): the same names, places and CRCs as zipfile's, in ~1/20 of
            # the time; any doubt about a package reads it through zipfile as before. One that does not read at all is left
            # out with a line (second review B): its models are 'unavailable' this session, never 'not in the client'.
            try:
                members = collision_members(path)
                prefab_members = collision_members(path, PREFAB_MARK, '.prefab') if members is not None else None
                if members is None or prefab_members is None:
                    with zipfile.ZipFile(path) as archive:
                        members = [(info.filename, (info.header_offset, info.compress_type, info.compress_size,
                                                    info.file_size, info.CRC)) for info in archive.infolist()]
                else:
                    members = members + prefab_members
            except Exception as error:
                skipped.append((path, error))
                continue
            for name, entry in members:
                if name.startswith(PREFAB_ROOT) and name.endswith('.prefab') and '..' not in name:
                    if name not in prefabs: prefabs[name] = (path, entry)
                    continue
                if ('/collision_client/' not in name or not name.endswith('.havok')
                        or not RESOURCE.match(name) or '..' in name): continue
                signature = (entry[3], entry[4])
                if name in signatures and signatures[name] != signature:
                    # Do not silently choose a different physical surface by
                    # guessing archive priority when two resources disagree.
                    conflicts.add(name)
                else:
                    signatures[name] = signature
                    if name not in packages:
                        packages[name] = path
                        # Where the chosen copy sits in its package, so a model is later read
                        # with one seek instead of parsing this whole directory again.
                        entries[name] = entry
        for path in glob.glob(os.path.join(self.game, 'mods', '*', '*.wotmod')):
            try:
                with zipfile.ZipFile(path) as archive:
                    for name in archive.namelist():
                        resource = name[4:] if name.startswith('res/') else ''
                        if (RESOURCE.match(resource) or resource.startswith(PREFAB_ROOT)) and '..' not in resource:
                            overrides.add(resource)
            except Exception as error:
                # A broken mod package overrides nothing the game can read either (second review B).
                skipped.append((path, error))
        for path, error in skipped:
            if path not in self.index_skipped:
                self.index_skipped.add(path)
                LOG.warning('Collision index: %s left out (%r)', os.path.basename(path), error)
        self.index_failed = [path for path, error in skipped if path.lower().endswith('.pkg')]
        # Publish the index only after a complete successful scan.
        self.packages, self.package_conflicts, self.overrides = packages, conflicts, overrides
        self.package_entries = entries
        self.prefab_entries = prefabs

    def ensure_packages(self):
        """The package index, built on first need. A failed scan (an unreadable package or .wotmod)
        is not repeated for every model: each would cost the full 2-3 s scan and fail the same way.
        It is tried again after PACKAGE_RESCAN_PAUSE."""
        if self.packages is not None: return
        failed = self.package_scan_failed
        if failed is not None and time.time()-failed[0] < PACKAGE_RESCAN_PAUSE:
            raise ValueError(failed[1])
        try:
            self._index_resources()
        except Exception as exc:
            self.package_scan_failed = (time.time(), str(exc) or exc.__class__.__name__)
            raise
        self.package_scan_failed = None

    def read_resource(self, name):
        """The bytes of one indexed collision resource.

        Straight from its local header in the package (read_package_entry). Any mismatch there
        falls back once to zipfile, which parses the package directory again; its error is the
        one that reaches 'attempts'. The same bytes either way, so every model already written
        keeps its sha256.
        """
        path = self.packages[name]
        entry = (self.package_entries or {}).get(name)
        if entry is not None:
            if entry[2] > MODEL_LIMIT or entry[3] > MODEL_LIMIT: raise ValueError('Model too large')
            try:
                return read_package_entry(path, name, entry)
            except Exception as exc:
                LOG.warning('Direct package read of %s failed (%s); reading it through zipfile', name, exc)
        with zipfile.ZipFile(path) as z:
            if z.getinfo(name).file_size > MODEL_LIMIT: raise ValueError('Model too large')
            return z.read(name)

    def read_prefab(self, name):
        """One vehicle prefab's JSON (type_extras), from the package index; one a mod replaces is refused, as a model is."""
        self.ensure_packages()
        if name in (self.overrides or ()): raise ValueError('Prefab overridden by a mod')
        found = (getattr(self, 'prefab_entries', None) or {}).get(name)
        if found is None: raise ValueError('Prefab not found in the client packages')
        path, entry = found
        if entry[2] > PREFAB_LIMIT or entry[3] > PREFAB_LIMIT: raise ValueError('Prefab too large')
        try:
            data = read_package_entry(path, name, entry)
        except Exception:
            with zipfile.ZipFile(path) as z: data = z.read(name)
        return json.loads(data.decode('utf-8'))

    def model(self, resource, version):
        """The cache-or-extract call of every explicit request.

        Publishing no longer uses it (0.7.11): a recorded hit must not wait for the
        client packages, so publish_vehicle_parts asks model_cached and queues a job.
        An exported vehicle IS the request, so it still extracts right here.
        """
        return self.model_extract(resource, version)

    def model_cached(self, resource, version):
        """What is known about a model without reading a single package.

        (key, None) when the file is already written, (key, reason) when the
        extraction was tried and failed, (key, PENDING) when nothing was tried yet.
        """
        key = self.model_ref(resource, version)
        if key in self.attempts and not self.scan_retry(key): return key, self.attempts[key]
        if os.path.isfile(os.path.join(self.folder, 'data', 'models', key+'.js')):
            self.attempts[key] = None
            return key, None
        return key, PENDING

    def scan_retry(self, key):
        """Forget a model's failure when it was the package scan's and its pause is over.

        A scan failure says nothing about the model itself, so it must not last the session;
        within the pause it stands, so a failed job cannot requeue itself in a loop."""
        if key not in self.scan_errors: return False
        failed = self.package_scan_failed
        if failed is not None and time.time()-failed[0] < PACKAGE_RESCAN_PAUSE: return False
        self.scan_errors.discard(key)
        self.attempts.pop(key, None)
        return True

    def model_extract(self, resource, version):
        key = self.model_ref(resource, version)
        path = os.path.join(self.folder, 'data', 'models', key+'.js')
        if key in self.attempts and not self.scan_retry(key): return key, self.attempts[key]
        if os.path.isfile(path):
            self.attempts[key] = None
            return key, None
        try:
            # Another client's battle: its model is extracted from this client only when it is the very same .havok there
            # (its content key in that client's snapshot is this client's) - the repair of 02.10's battles (BACKLOG 55).
            if canonical(version) != self.version and not (key == self.model_content(resource) is not None
                                                           and self.model_content(resource, version) == key):
                raise ValueError('Client version changed; model was not saved before the update')
            name = resource.rsplit('.', 1)[0]+'.havok'
            try:
                self.ensure_packages()
            except Exception:
                self.scan_errors.add(key)
                raise
            if name in self.package_conflicts: raise ValueError('Conflicting mounted collision resources')
            if name not in self.packages:
                if getattr(self, 'index_failed', None):
                    # A package of the client did not read: unknown, not missing - looked at again after the pause.
                    self.scan_errors.add(key)
                    raise ValueError('Collision model unavailable: a client package did not read')
                raise ValueError('Collision model not found in client')
            if name in self.overrides or resource in self.overrides:
                raise ValueError('A mod overrides this collision model')
            for root in glob.glob(os.path.join(self.game, 'res_mods', '*')):
                if os.path.isfile(os.path.join(root, name)) or os.path.isfile(os.path.join(root, resource)):
                    raise ValueError('res_mods overrides this collision model')
            started = TTX_TIMER()
            data = self.read_resource(name)
            # A file of an earlier name with these very bytes and this MODEL_FILE_FORMAT (0.9.3 and before named them by the
            # version text): it is the model - also without a snapshot (review 02.10 #1c: else the file of the new name was
            # written, the vehicle file kept the old name, and the prune deleted the new one).
            alias = self.adopt_model(name, key, data)
            if alias is not None:
                self.attempts[alias] = None
                return alias, None
            write_data(path, 'model:'+key, model_document(data, name))
            self.attempts[key] = None
            # The whole unit under the GIL: read, parse, hash, write (28.09, havok-lazy: 10 ms median, 48 ms p99; 76 ms and 1.1 s before).
            ms = (TTX_TIMER() - started) * 1000.0
            self.model_ms.append(ms)
            if ms >= MODEL_SLOW_MS: LOG.info('Model %s extracted in %.0f ms (%d KB)', name, ms, len(data) // 1024)
        except Exception as exc:
            self.attempts[key] = str(exc)
            LOG.warning('Model export unavailable: %s: %s', resource, exc)
        return key, self.attempts[key]

    def armor_inputs(self, type_name, version):
        """'armor:<the CRCs of the vehicle's XML and common/vehicle.xml>' in the client of `version` (client_files), None when
        that client is unknown; a file whose CRC is unknown there leaves a '?' in it (never a real key)."""
        try:
            nation, name = str(type_name).split(':', 1)
            files = self.client_files(None if canonical(version) == self.version else version)
            if files is None: return None
            parts = []
            for path in ('scripts/item_defs/vehicles/%s/%s.xml' % (nation, name), 'scripts/item_defs/vehicles/common/vehicle.xml'):
                entry = files.get(path)
                parts.append('-' if entry is None else '?' if entry[0] < 0 else '%08x:%d' % entry)
            return 'armor:' + ','.join(parts)
        except Exception:
            return None

    def publish_parts(self, result, hit, side, battle_id=None, priority=JOB_OTHER, pending=None):
        """Collision models and armour tables for one side of a recorded hit."""
        vehicle = hit.get(side) or {}
        self.publish_vehicle_parts(vehicle.get('parts', []), vehicle, result['clientVersion'],
                                   battle_id, priority, pending)

    def publish_vehicle_parts(self, parts, vehicle, client_version,
                              battle_id=None, priority=JOB_OTHER, pending=None, extract=False):
        """Collision models and armour tables for the parts of one vehicle.

        The same work for a hit's target, for its shooter and for a vehicle record
        of the browser: the armour table is cached per client version, vehicle and
        resource - so the cache identity has to follow the vehicle whose parts
        these are, not always the target.

        The model itself is only looked up here (0.7.11). A part whose model is not
        on disk yet carries no 'modelKey' at all and 'modelPending': the page shows
        it as on its way instead of missing, and a job extracts it later. An
        exported vehicle passes extract=True: that record IS the request, and the
        page waits for the file itself.
        """
        for part in parts:
            # These fields describe the derived model file, never the raw part.
            # Re-evaluate them when a completed/failed model job invalidates a hit.
            part.pop('modelKey', None)
            part.pop('modelPending', None)
            part.pop('modelError', None)
            # A wheel (id < 0) has no model file and no resource: its body is procedural (fill_wheels), its armour live.
            # An armoured prefab part the prefab has not filled yet (fix_prefabs) has none either: the page says why
            # (its prefabError, or "not read yet") instead of the KeyError a lookup would leave (review of d1b372b).
            if 'resource' not in part and (part.get('prefab') or isinstance(part.get('id'), int) and part['id'] < 0):
                continue
            try:
                if extract:
                    key, error = self.model_extract(part['resource'], client_version)
                else:
                    key, error = self.model_cached(part['resource'], client_version)
                if error == PENDING:
                    part['modelPending'] = True
                    self.queue_model(part['resource'], client_version, key, vehicle, battle_id, priority)
                    if pending is not None: pending.add(key)
                else:
                    part['modelKey'] = key
                    if error: part['modelError'] = error
            except Exception as exc: part['modelError'] = str(exc)
            if 'armor' not in part:
                try:
                    # Keyed by what the table is read from (review 02.10 #3): the vehicle's XML and the common vehicle.xml
                    # (ArmorCatalog.materials) of the client of these parts - not its version text; that text without a snapshot.
                    inputs = self.armor_inputs(vehicle['type'], client_version)
                    identity = '\n'.join((inputs or canonical(client_version), vehicle['type'],
                        vehicle.get('compactDescriptor', ''), part['resource']))
                    key = hashlib.sha256(identity.encode('utf-8')).hexdigest()
                    cache = os.path.join(self.folder, 'data', 'armor', key+'.json')
                    # The cache 0.9.3 named by the version text (second review E): written by that very client, so its
                    # tables are that client's - the battle's own - whatever the key above says.
                    if not os.path.isfile(cache) and inputs:
                        legacy = '\n'.join((canonical(client_version), vehicle['type'],
                                            vehicle.get('compactDescriptor', ''), part['resource']))
                        legacy = os.path.join(self.folder, 'data', 'armor', hashlib.sha256(legacy.encode('utf-8')).hexdigest() + '.json')
                        if os.path.isfile(legacy): cache = legacy
                    if os.path.isfile(cache):
                        with open(cache, 'rb') as stream:
                            size = os.fstat(stream.fileno()).st_size
                            if size > 1024*1024: raise ValueError('Armor metadata cache too large')
                            part['armor'] = json.loads(stream.read(size).decode('ascii'))
                    else:
                        # Read from this client: only for its own parts, or another client's whose two files are these.
                        if canonical(client_version) != self.version and (
                                inputs is None or '?' in inputs or inputs != self.armor_inputs(vehicle['type'], self.version)):
                            raise ValueError('Armor metadata was not saved for the old client version')
                        part['armor'] = self.armor.materials(vehicle['type'], part['resource'])
                        atomic_write(cache, json.dumps(part['armor'], ensure_ascii=True, allow_nan=False).encode('ascii'))
                    part['armorSource'] = 'version-matched client XML (cached)'
                except Exception as exc:
                    part['armorError'] = str(exc)
                    # 0.6.28 removed the page's "Current <version>" comparison; the current client's
                    # armour for an old battle (comparisonArmor) had no reader left, and building it
                    # meant a synchronous model extraction inside publishing. It is gone.

    # WHAT THE VEHICLE XML ADDS TO THE DESCRIPTOR (review of 5f2bee5, 27.09). The collision wheels' bodies and places
    # (wheel_shapes) are in no descriptor, only in the vehicle's XML, and reading it is 74-91 ms of Python under the GIL
    # (a look through every installed wotmod, a decode out of scripts.pkg): never during a battle. Read once a session per
    # type - on the thread that exports vehicles anyway, in the hangar - and a failure is kept as well, with its reason, so
    # it is neither read again nor logged again. A hit published during a battle before its type was read waits for it
    # like a hit waits for its model: the extras job reads it after the battle and the battles that waited are published
    # again (invalidate_model, waiting).
    def xml_allowed(self):
        """False during a battle (the Recorder's flag); outside the game (no recorder) always True."""
        recorder = self.recorder
        try:
            return recorder is None or not getattr(recorder, 'in_battle', False)
        except Exception:
            return True

    def type_extras(self, type_name, defer=None, inline=True):
        """{'wheels': {chassis name: wheel_shapes}, 'prefabs': [armoured prefab entry], 'prefabErrors': [reason]} of one
        type of the running client, None while it may not be read (a battle, or `inline` False - the publication of a
        hit, which never reads the XML itself (review of d1b372b): `defer`, a set, gets the key the hit waits under and
        the extras job is queued). Raises ExtrasUnavailable when the XML did not read (the reason is kept for the
        session). A prefab entry: {'parent', 'component', 'slot', 'prefab', 'place' (the slot's matrix), 'spec' (prefab_spec)}."""
        cache = self.extras_cache
        key = str(type_name)
        entry = cache.get(key)
        if entry is None:
            if not inline or not self.xml_allowed():
                if defer is not None: defer.add(EXTRAS_KEY + key)
                self.queue_job(JOB_OTHER, 'extras', {'vehicleType':key})
                return None
            entry = self.read_type_extras(key)
        if 'error' in entry: raise ExtrasUnavailable(entry['error'])
        return entry

    def read_type_extras(self, key):
        """Read and keep one type's extras (type_extras); a failure is kept with its reason and logged once."""
        try:
            if not re.match(r'^[a-z]+:[A-Za-z0-9_-]+\Z', key): raise ValueError('Invalid vehicle type')
            nation, name = key.split(':')
            tree = self.armor.xml('scripts/item_defs/vehicles/'+nation+'/'+name+'.xml')
            chassis = tree.find('chassis')
            entry = {'wheels':dict((node.tag, wheel_shapes(tree, node.tag)) for node in (chassis if chassis is not None else ())),
                     'prefabs':[], 'prefabErrors':[]}
            # The armoured prefabs of its slots (27.09): the JSON of each named prefab, once; one that does not read or that
            # has no place is left out and named in prefabErrors (a vehicle file then does not count its prefabs as done).
            for parent, component, slot, path, place in slot_prefabs(tree):
                try:
                    spec = self.prefab_spec(path)
                    if spec is None: continue
                    if place is None: raise ValueError('slot %s has no place' % slot)
                    entry['prefabs'].append({'parent':parent, 'component':component, 'slot':slot, 'prefab':path,
                                             'place':place, 'spec':spec})
                except Exception as exc:
                    LOG.warning('Prefab %s of %s left out: %s', path, key, exc)
                    entry['prefabErrors'].append('%s: %s' % (slot, exc))
        except Exception as exc:
            LOG.warning('Vehicle XML unavailable for %s (its wheels and armoured prefabs are left out): %s', key, exc)
            entry = {'error':str(exc) or type(exc).__name__}
        if len(self.extras_cache) >= 256: self.extras_cache.clear()
        self.extras_cache[key] = entry
        return entry

    def prefab_spec(self, path):
        """prefab_spec of one prefab of the client packages, kept for the session (several types may share one)."""
        cache = self.prefab_cache
        if path not in cache:
            try:
                from material_kinds import NAMES_BY_IDS
            except Exception:
                NAMES_BY_IDS = {}
            cache[path] = prefab_spec(self.read_prefab(path), NAMES_BY_IDS)
        return cache[path]

    def run_extras_job(self, payload):
        """After a battle: read the type's XML (unless the vehicle export already did) and publish again what waited for it.
        Never during a battle, whatever priority the page gave the job (review of d1b372b): it waits for the battle's end."""
        key = str((payload or {}).get('vehicleType') or '')
        if key not in self.extras_cache:
            if not self.xml_allowed():
                self.queue_job(JOB_OTHER, 'extras', {'vehicleType':key})
                return
            self.read_type_extras(key)
        self.invalidate_model(EXTRAS_KEY + key)
        self.republish.update(self.waiting.pop(EXTRAS_KEY + key, ()))

    def run_prefab_check(self):
        """The exported files from before the armoured prefabs: which of them to export again. The client's armoured
        prefabs are the dynamic parts with a collider and armour (two in 2.4.0.1, both in content/CGFPrefabs/Vehicle/
        dynamic_parts); a file whose parts' models lie in the folder of such a prefab's collider is that vehicle's, and is
        exported again in the background (its own request, replay). Every other file is left as it is - nothing written;
        the check is two small JSON reads, once per client version: the folders are kept (PREFAB_FOLDERS), and the next
        start decides every file from them in load_vehicles, holding nothing and queueing no check (review of d1b372b).
        Never in a battle (the JSON is read); a failure leaves them all for the next start."""
        if not self.xml_allowed():
            self.queue_job(JOB_BULK, 'prefabs', {'vehicleType':''})
            return
        unchecked, self.prefab_unchecked = getattr(self, 'prefab_unchecked', None) or {}, {}
        if not unchecked: return
        self.ensure_packages()
        folders, failed = set(), False
        for name in sorted(self.prefab_entries or ()):
            if not name.startswith(PREFAB_ROOT + 'dynamic_parts/'): continue
            try:
                spec = self.prefab_spec(name)
            except Exception as exc:
                LOG.warning('Prefab %s not read for the check: %s', name, exc)
                failed = True
                continue
            if spec: folders.add(spec['resource'].rsplit('/collision_client/', 1)[0] + '/collision_client/')
        if not failed and self.prefab_entries is not None: self.write_prefab_folders(folders)
        for type_name, (identifier, own, request) in sorted(unchecked.items()):
            if not folders.intersection(own) or not request.get('compactDescriptor'): continue
            summary = self.vehicles.get(str(identifier or ''))
            if summary is not None: summary['descriptorHash'] = None
            self.migrating.add(type_name)
            self.queue_job(JOB_BULK, 'vehicle', dict(request, replay=True))
            # The catalogue marks it 'outdated' at the next idle tick: the page then asks for it when it is opened.
            self.catalogue_dirty = True

    def prefab_inputs(self):
        """What the check's folders are made of (BACKLOG 55): the armoured-prefab candidates' CRCs in the client's snapshot
        (the dynamic parts' prefabs) - not the client version; the version text without a snapshot."""
        files = self.client_files()
        if not files: return 'version:' + hashlib.sha1(self.version.encode('utf-8')).hexdigest()[:16]
        return 'prefabs:' + self.client_signature([p for p in files if p.startswith(PREFAB_ROOT + 'dynamic_parts/')])

    def prefab_folders_path(self):
        return os.path.join(self.folder, 'data', PREFAB_FOLDERS)

    def read_prefab_folders(self):
        """The collider folders of the armoured prefabs the check found for this client version, or None (not checked yet,
        another version, unreadable)."""
        try:
            path = self.prefab_folders_path()
            if not os.path.isfile(path) or os.path.getsize(path) > 65536: return None
            with open(path, 'rb') as stream:
                value = json.loads(stream.read().decode('utf-8'))
            if value.get('inputs') != self.prefab_inputs() or not isinstance(value.get('folders'), list): return None
            return set(str(folder) for folder in value['folders'])
        except Exception:
            return None

    def write_prefab_folders(self, folders):
        try:
            atomic_write(self.prefab_folders_path(), json.dumps({'inputs':self.prefab_inputs(), 'folders':sorted(folders)},
                                                                ensure_ascii=True, sort_keys=True).encode('ascii'))
        except Exception:
            LOG.exception('Armoured prefab folders not kept; the check runs again next start')

    def fix_wheels(self, vehicle, defer=None):
        """Body and rest place for the wheel parts of one vehicle block that has any without them (the recorder's). Its own
        descriptor names the type and chassis; a failure leaves the parts as recorded - the page then shows no wheel
        (and says so on the Statistics log line). During a battle before the type is read: 0, and `defer` names the wait."""
        parts = (vehicle or {}).get('parts') if isinstance(vehicle, dict) else None
        if not parts or not any(isinstance(p, dict) and isinstance(p.get('id'), int) and p['id'] < 0 and 'wheel' not in p
                                for p in parts):
            return 0
        try:
            descr = vehicle_descr(vehicle['compactDescriptor'])
            # A descriptor this client decodes to another type than the record names (ids that moved): its XML is not the
            # vehicle's (review #7) - as fix_extra_parts and fix_yaw_limits, nothing is taken from it.
            if vehicle.get('type') and str(descr.type.name) != str(vehicle.get('type')): return 0
            # The publication never reads the XML itself, except for the battle the page waits for (preparing_page): its
            # extras job would stand behind a drag of that very page (type_extras still refuses in a battle).
            extras = self.type_extras(descr.type.name, defer, inline=self.preparing_page)
            return fill_wheels(vehicle, extras['wheels'].get(descr.chassis.name) or {}) if extras is not None else 0
        except ExtrasUnavailable:
            return 0
        except Exception:
            # Not the XML (its failure is kept and logged once): the descriptor. Once a session per type, not per hit.
            name = str((vehicle or {}).get('type') or '')
            if name not in self.extras_logged:
                self.extras_logged.add(name)
                LOG.exception('Wheel bodies unavailable for %s; the wheels are published without them', name)
            return 0

    def fix_prefabs(self, vehicle, defer=None):
        """The armoured prefab part the recorder wrote (its collision index, slot, parent and pose at the hit; no model yet)
        gets its model, armour, layers and base from this client's prefab (fill_prefab); the page reads the layer its pose
        stands in. The type names the XML, no descriptor is built. A failure leaves it as recorded: the page leaves it out and says so."""
        parts = vehicle.get('parts') if isinstance(vehicle, dict) else None
        todo = [p for p in parts or () if isinstance(p, dict) and p.get('prefab') and 'resource' not in p]
        if not todo: return 0
        try:
            extras = self.type_extras(str(vehicle.get('type') or ''), defer, inline=self.preparing_page)
        except ExtrasUnavailable as exc:
            for part in todo: part['prefabError'] = 'vehicle XML unavailable (%s)' % exc
            return 0
        if extras is None: return 0
        filled = 0
        for part in todo:
            entry = next((e for e in extras['prefabs'] if e['slot'] == part.get('name') and e['prefab'] == part.get('prefab')
                          and e['parent'] == part.get('parentPart')), None)
            if entry is None:
                part['prefabError'] = 'not an armoured prefab of this client'
                continue
            fill_prefab(part, entry)
            filled += 1
        return filled

    def reset_prepared(self):
        self.prepared_hits = [None] * len((self.current or {}).get('hits') or [])
        self.prepared_models = {}
        self.prepared_identity = None

    def invalidate_model(self, key):
        """Forget only active hits that mentioned the completed model."""
        indexes = self.prepared_models.pop(key, set())
        if not indexes: return
        for index in indexes:
            if index < len(self.prepared_hits): self.prepared_hits[index] = None
        for other in list(self.prepared_models):
            self.prepared_models[other].difference_update(indexes)
            if not self.prepared_models[other]: self.prepared_models.pop(other, None)

    def input_text(self, path, version=None):
        """'crc:size' of one client file (client_crc), '-' when that client has no such file, '?' for an unknown CRC."""
        found = self.client_crc(path, version) if path else None
        return '-' if found is None else '?' if found[0] == '?' else '%s:%d' % found

    def fill_code(self, version=None):
        """One signature over the code set (code_modules: the client's code the builds execute and name) in the client of
        `version` (the running one without it); None when that client is unknown. The same rule as the files' keys: the
        crew's code is outside it, the chassis code inside."""
        return self.client_signature(self.code_modules(), version)

    def fill_allowed(self, battle, paths, code=False):
        """A fill-in of this battle may read these client files now (BACKLOG 55): the battle is the running client's, or its
        own client's files are these very files - by what its entry says its fill-ins read before (inputs), else by the
        snapshot of its client (client_files: this mod's, or one derived from the update's changes). `code`: the fill-in
        decodes the compact descriptor, so the client's code it goes through counts too (fill_code, one signature '@code').
        Nothing known of its client, an unknown CRC ('?') or a file that differs: no fill-in from this client - keep_fills
        takes it from the battle's own file, else the part stays as recorded, never guessed. What was read is kept for the
        battle's entry (fill_reads), whether it is the running client's battle or not (review #5: a battle outlives the
        snapshots of its client)."""
        paths = [p for p in paths if p]
        if not paths: return False
        version = canonical(battle.get('clientVersion') or '')
        running = version == self.version
        now = dict((p, self.input_text(p)) for p in paths)
        if code: now['@code'] = self.fill_code() or '?'
        if running:
            allowed = True
        elif self.client_files() is None or any(v == '?' for v in now.values()):
            allowed = False
        else:
            known = (self.published.get(str(battle.get('id') or '')) or {}).get('inputs') or {}
            if all(p in known for p in now):
                allowed = all(known[p] == now[p] for p in now)
            else:
                then = self.client_signature(paths, version)
                allowed = then is not None and then == self.client_signature(paths)
                if allowed and code: allowed = self.fill_code(version) == now['@code']
        if allowed and self.client_files() is not None: self.fill_reads.setdefault(str(battle.get('id') or ''), {}).update(now)
        return allowed

    # NEVER A WORSE FILE (review #5, 02.10): a battle whose fill-ins its own client made is prepared again (a raised format, a
    # model deleted, a wait) under a client whose files they were read from changed. The gate closes - and that client is
    # gone, so what the file holds can never be had again: the fill-ins are taken from the battle's file as it is, one log line.
    def kept_hit(self, battle, hit_id):
        """The hit of this id in the battle's derived file on disk (read once per preparation), or None."""
        name = str(battle.get('id') or '')
        files = self.kept_files
        if name not in files:
            try:
                value = read_data_file(os.path.join(self.folder, 'data', 'battles', name + '.js'))
                files[name] = dict((str(h.get('id')), h) for h in value.get('hits') or () if isinstance(h, dict))
            except Exception:
                files[name] = {}
        return files[name].get(str(hit_id))

    def keep_fills(self, battle, hit, kind):
        """Copy one fill-in ('pair', 'wheels', 'prefab') of `hit` from the same hit of the battle's file; True when it did."""
        old = self.kept_hit(battle, hit.get('id'))
        if not old: return False
        kept = False
        if kind == 'pair':
            target, before = hit.get('target') or {}, old.get('target') or {}
            if EXTRA_PARTS_WARNING in (old.get('warnings') or ()): return False
            known = set(p.get('id') for p in target.get('parts') or () if isinstance(p, dict))
            added = [dict((k, v) for k, v in p.items() if k not in ('modelKey', 'modelPending', 'modelError'))
                     for p in before.get('parts') or () if isinstance(p, dict) and isinstance(p.get('id'), int)
                     and p['id'] >= len(PARTS) and p['id'] not in known and not p.get('prefab') and p.get('resource')]
            if not added: return False
            target.setdefault('parts', []).extend(added)
            ids = set(p['id'] for p in added)
            for point in hit.get('points') or []:
                if isinstance(point, dict) and point.get('status') == 'unsupported-part' and point.get('part') in ids:
                    point['status'] = 'resolved'
            hit['warnings'] = [line for line in hit.get('warnings') or () if line != EXTRA_PARTS_WARNING]
            kept = True
        elif kind == 'wheels':
            for side in ('target', 'attacker'):
                shapes = dict((p.get('id'), p) for p in (old.get(side) or {}).get('parts') or ()
                              if isinstance(p, dict) and isinstance(p.get('id'), int) and p['id'] < 0 and p.get('wheel'))
                for part in (hit.get(side) or {}).get('parts') or ():
                    source = shapes.get(part.get('id')) if isinstance(part, dict) and 'wheel' not in part else None
                    if source is None or source.get('name') != part.get('name'): continue
                    for key in ('wheel', 'transform', 'poseFrom'):
                        if key in source: part[key] = copy.deepcopy(source[key])
                    kept = True
        else:
            before = dict((p.get('id'), p) for p in (old.get('target') or {}).get('parts') or ()
                          if isinstance(p, dict) and p.get('prefab') and p.get('resource') and not p.get('prefabError'))
            for part in (hit.get('target') or {}).get('parts') or ():
                if not (isinstance(part, dict) and part.get('prefab') and 'resource' not in part): continue
                source = before.get(part.get('id'))
                if source is None or source.get('prefab') != part.get('prefab'): continue
                part.pop('prefabError', None)
                for key, value in source.items():
                    if key not in ('transform', 'modelKey', 'modelPending', 'modelError'): part[key] = copy.deepcopy(value)
                kept = True
        if kept: self.kept_now.setdefault(str(battle.get('id') or ''), set()).add(kind)
        return kept

    def prepare_hit(self, raw, index, battle, track=False):
        hit = copy.deepcopy(raw)
        for side in ('attacker', 'target'):
            try:
                enrich_vehicle(hit.get(side))
            except Exception:
                LOG.exception('Vehicle identity unavailable; the hit is published as recorded')
        synthesize_parts(hit.get('attacker'))
        # THE FILL-INS (BACKLOG 55, 02.10): what the running client's files add to the record - the outer track pair, the
        # wheels' bodies, the armoured prefab - is right for the battle when the files it reads are the battle's client's:
        # a battle of the running client, or one whose files of its own client have the same CRCs (fill_allowed). It used
        # to be the client's version text: the update of 02.10 changed none of those files and 22 battles lost them.
        deferred = set()
        target = hit.get('target') if isinstance(hit.get('target'), dict) else {}
        # Its inputs: the vehicle XML, the nation's tables and the code that decode the descriptor, the common armour XML, the
        # material names and the added parts' .havok - recorded for the running client's battle too (review #5).
        if EXTRA_PARTS_WARNING in (hit.get('warnings') or ()):
            trial = copy.deepcopy(hit)
            done = False
            if fix_extra_parts(trial):
                known = set(p.get('id') for p in target.get('parts') or () if isinstance(p, dict))
                added = [str(p['resource']).rsplit('.', 1)[0] + '.havok' for p in (trial.get('target') or {}).get('parts') or ()
                         if isinstance(p, dict) and p.get('id') not in known and p.get('resource')]
                if self.fill_allowed(battle, [vehicle_xml(target.get('type')), 'scripts/item_defs/vehicles/common/vehicle.xml',
                                              MATERIAL_KINDS] + nation_tables(target.get('type')) + added, code=True):
                    hit, done = trial, True
                    target = hit.get('target') if isinstance(hit.get('target'), dict) else {}
            if not done and canonical(battle.get('clientVersion') or '') != self.version: self.keep_fills(battle, hit, 'pair')
        # The wheels the recorder wrote (a record before them has none: old data stays as it is) get their body and rest
        # place from the client's XML (the chassis by the descriptor: the nation's tables and the code count). During a battle
        # before the type is read the hit goes out without them and waits (`deferred`) like one waiting for a model.
        for side in ('target', 'attacker'):
            vehicle = hit.get(side)
            if not (isinstance(vehicle, dict) and any(isinstance(p, dict) and isinstance(p.get('id'), int) and p['id'] < 0
                                                      and 'wheel' not in p for p in vehicle.get('parts') or ())): continue
            if self.fill_allowed(battle, [vehicle_xml(vehicle.get('type'))] + nation_tables(vehicle.get('type')), code=True):
                self.fix_wheels(vehicle, deferred)
            else:
                self.keep_fills(battle, hit, 'wheels')
        # The armoured prefab part the recorder wrote for the target (27.09): its model, armour and layers - from the XML,
        # the prefab and the material names (no descriptor is decoded: fix_prefabs goes by the recorded type).
        bare = [p for p in target.get('parts') or () if isinstance(p, dict) and p.get('prefab') and 'resource' not in p]
        if bare:
            if self.fill_allowed(battle, [vehicle_xml(target.get('type')), MATERIAL_KINDS, MATERIAL_KINDS_CODE]
                                 + [str(p['prefab']) for p in bare]):
                self.fix_prefabs(target, deferred)
            elif not self.keep_fills(battle, hit, 'prefab'):
                # Another client's record whose prefab files are not known to be this client's and no file holding its prefab:
                # read from no XML (as its wheels) - the page says so.
                for part in bare: part['prefabError'] = 'recorded by another client version'
        fix_shells(hit)
        try:
            stamp_aim_origin(hit, raw, battle)
        except Exception:
            LOG.exception('Aim block origin unavailable; the hit is published without it')
        try:
            fix_mode_blocks(hit.get('attacker'), battle)
        except Exception:
            LOG.exception('Second-mode fields unavailable; the hit is published without them')
        priority = JOB_PLAYER if hit.get('direction') in ('incoming', 'outgoing') else JOB_OTHER
        pending = set()
        for side in ('target', 'attacker'):
            self.publish_parts(battle, hit, side, battle['id'], priority, pending)
        for key in deferred:
            self.waiting.setdefault(key, set()).add(battle['id'])
        if track:
            for key in deferred:
                self.prepared_models.setdefault(key, set()).add(index)
            for side in ('target', 'attacker'):
                for part in (hit.get(side) or {}).get('parts', []):
                    try:
                        key = self.model_ref(part['resource'], battle['clientVersion'])
                        self.prepared_models.setdefault(key, set()).add(index)
                    except Exception:
                        pass
        # The static blocks of this hit are fingerprinted here, once, and the publish loop then
        # only copies the references. Hashing them on every publish would cost more than the
        # duplication it removes (optimisation plan B1 cost trap, B5 step 3); an
        # invalidated model drops the whole slot, so the fingerprints can never go stale.
        stamp_snapshot(hit)
        return hit

    def publish(self, battle, offset=None, prepared=None, raw_size=None):
        """Write one battle's derived file. `offset`: the raw bytes it was read from (a saved battle), `raw_size` its raw
        file's size then; the active battle's are its tail's. Known, they go to data/published.json with what else the
        file was built from. `prepared`: the hits of a saved battle already prepared (the background's slices)."""
        if not IDENTIFIER.match(battle['id']): raise ValueError('Invalid battle id')
        active = battle is self.current
        identity = (battle['id'], canonical(battle.get('clientVersion') or ''), self.version)
        if active and (self.prepared_identity != identity or
                       len(self.prepared_hits) != len(battle.get('hits') or [])):
            self.reset_prepared()
            self.prepared_identity = identity
        result = dict(battle)
        # What the fill-ins read (fill_allowed): this publish's own, unless the slices before it prepared the hits.
        if not active and prepared is None:
            for state in (self.fill_reads, self.kept_files, self.kept_now): state.pop(battle['id'], None)
        if prepared is not None and not active and len(prepared) == len(battle.get('hits') or []):
            result['hits'] = list(prepared)
        else:
            result['hits'] = []
            for index, raw in enumerate(battle.get('hits') or []):
                if active:
                    hit = self.prepared_hits[index]
                    if hit is None:
                        hit = self.prepare_hit(raw, index, battle, track=True)
                        self.prepared_hits[index] = hit
                else:
                    hit = self.prepare_hit(raw, index, battle)
                result['hits'].append(hit)
        # The client's crit records tied to the hits (22.09). Every publish ties them afresh, so a record that
        # arrives after its hit, or a better rule, moves a tie instead of adding one; the raw records stay in the
        # JSONL and the page reads only the ties.
        try: result['critStats'] = attach_crits(result['hits'], battle.get('critEvents') or [], battle.get('playerVehicleId'))
        except Exception: LOG.exception('Crit ties failed; hits are published without them')
        # Every HP no shell took (25.09): one event per ram, fire and other episode from the same crit records, after
        # the ties (a fire names the hit they marked), and the battle's damage check. Rebuilt on every publish too.
        # An episode still ticking is held back and this battle published again at the quiet pace (flush) until it is over.
        # Only the active battle's own publish decides it (a model's republish of another battle must not drop it).
        if active: self.damage_held = False
        try:
            # A forced publish (a battle switch, the game closing) is the battle's last: it counts as finished, so an
            # episode still ticking goes out as it stands instead of asking for yet another publish (review 25.09 #2).
            now = None if getattr(self, 'publishing_final', False) else time.time()
            events, check, held = damage_log(result['hits'], battle.get('critEvents') or [], battle.get('roster'), now)
            if events: result['damageEvents'] = events
            if check: result['damageCheck'] = check
            if active: self.damage_held = bool(held)
        except Exception: LOG.exception('Damage events failed; hits are published without them')
        result.pop('critEvents', None)
        target = os.path.join(self.folder, 'data', 'battles', battle['id']+'.js')
        if active:
            size, written = write_data(target, 'battle:'+battle['id'], result), True
        else:
            # A saved battle prepared again whose file comes out the same (the repair of a battle that had nothing to fill,
            # BACKLOG 55): not written, and its revision stays - the page has nothing to read again.
            size, written = write_data_changed(target, 'battle:'+battle['id'], result)
        # One walk over the parts: the models it references (the shooter's count too, or prune() would delete them as
        # unused; a model it still waits for counts the same way, or prune() would delete it between the job that writes it
        # and the republish that names it), those whose model failed (no file to look for at the next start), and whether
        # the next start may do better (startup-review-fixes #5): a model failure that is not for good, a wheel without its
        # body or a prefab without its model because the vehicle XML did not read - only in a battle of the running client.
        running = canonical(battle.get('clientVersion') or '') == self.version
        references, pending, absent, redo = set(), set(), set(), False
        for hit in result['hits']:
            for side in ('target', 'attacker'):
                vehicle = hit.get(side) or {}
                for part in vehicle.get('parts', []):
                    key = part.get('modelKey')
                    if key:
                        references.add(key)
                        error = part.get('modelError')
                        if error:
                            absent.add(key)
                            if running and not str(error).startswith(PERMANENT_MODEL_ERRORS): redo = True
                    elif part.get('modelPending'):
                        try: pending.add(self.model_ref(part['resource'], battle['clientVersion']))
                        except Exception: pass
                    if running and not redo:
                        if str(part.get('prefabError') or '').startswith('vehicle XML unavailable'): redo = True
                        elif (isinstance(part.get('id'), int) and part['id'] < 0 and 'wheel' not in part
                              and 'error' in (self.extras_cache.get(str(vehicle.get('type') or '')) or {})): redo = True
        references.update(pending)
        self.model_refs[battle['id']] = references
        previous_rev = (self.summaries.get(battle['id']) or {}).get('rev')
        summary = self.summaries[battle['id']] = dict((k, battle.get(k)) for k in ('id', 'startedAt', 'map'))
        summary['hits'] = len(battle['hits'])
        try:
            summary['vehicle'] = player_vehicle(result)
        except Exception:
            summary['vehicle'] = None
        # Its revision in the index (C1): the page reads the battle it has open again only when this changes.
        if written or not previous_rev:
            self.publish_serial += 1
            summary['rev'] = '%s.%d' % (self.session, self.publish_serial)
        else:
            summary['rev'] = previous_rev
        # Fill-ins its own client made, kept from its file because the files they were read from changed (keep_fills).
        self.kept_files.pop(battle['id'], None)
        kept = self.kept_now.pop(battle['id'], None)
        if kept:
            LOG.info('Saved battle %s: fill-ins kept from its file (%s) - the client files they were read from changed',
                     battle['id'], ', '.join(sorted(kept)))
        # Current now: no longer stale; its references known - the prune that waited for the last of them may run.
        self.stale.discard(battle['id'])
        if battle['id'] in self.refs_unknown:
            self.refs_unknown.discard(battle['id'])
            if not self.refs_unknown and self.prune_waits:
                self.prune_waits = False
                self.prune_now = True
        # What this file was built from (PUBLISHED_FILE): the next start takes it as it is when nothing of it changed.
        # A battle still waiting for a model or for its vehicle XML is published again then, which queues that wait anew.
        if offset is None and active: offset = self.raw_offsets.get(battle['id'])
        if offset is None:
            self.published.pop(battle['id'], None)
        else:
            if raw_size is None:
                # The active battle: its raw file as far as the tail has read it. Bytes behind that (records not read yet, an
                # unfinished line) are not in this file: no size, and the next start publishes it again.
                try: raw_size = os.path.getsize(os.path.join(self.folder, 'battles', battle['id']+'.jsonl'))
                except OSError: raw_size = None
                if raw_size != offset: raw_size = None
            waits = redo or bool(pending) or any(battle['id'] in ids for ids in self.waiting.values())
            previous = self.published.get(battle['id']) or {}
            entry = {'stamp':self.stamp, 'raw':int(offset), 'rawSize':raw_size, 'size':size, 'refs':references,
                     'waits':waits, 'summary':dict(summary), 'client':version_hash(battle.get('clientVersion')),
                     'built':version_hash(self.version)}
            if absent: entry['absent'] = sorted(absent)
            # The inputs its fill-ins read (fill_allowed): kept from before for a file not read this time.
            inputs = dict(previous.get('inputs') or {})
            inputs.update(self.fill_reads.get(battle['id']) or {})
            if inputs: entry['inputs'] = inputs
            self.published[battle['id']] = entry
        self.published_dirty = True

    def set_current(self, name, battle):
        if self.current is not None and self.current.get('id') != name:
            if not self.flush(force=True):
                raise RuntimeError('Previous battle publication is waiting for retry')
        self.current = battle
        self.reset_prepared()

    def apply_record(self, name, record):
        if record.get('schema') != 1: raise ValueError('Unknown schema')
        if record.get('type') not in ('battle', 'hit', 'shot', 'crit', 'roster'):
            raise ValueError('Unexpected record')
        if record['type'] == 'battle':
            battle = dict(record)
            battle.update({'id':name, 'hits':[], 'shotEvents':[], 'critEvents':[], 'warnings':[]})
            self.set_current(name, battle)
        elif self.current is not None and self.current['id'] == name and record['type'] == 'roster':
            self.current.update({'roster':record.get('vehicles') or [], 'playerTeam':record.get('playerTeam')})
            if record.get('playerVehicleId'): self.current['playerVehicleId'] = record['playerVehicleId']
        elif self.current is not None and self.current['id'] == name:
            field = {'shot':'shotEvents', 'crit':'critEvents'}.get(record['type'], 'hits')
            rows = self.current.setdefault(field, [])
            quiet = False
            if field == 'critEvents':
                try: quiet = not moves_tie(record, rows)
                except Exception: quiet = False
            rows.append(record)
            if field == 'hits': self.prepared_hits.append(None)
            if quiet:
                self.pending_quiet = True
                return
        else:
            raise HeaderUnavailable('Battle header unavailable for '+name)
        self.pending_publish = True

    def record(self, name, record):
        """Compatibility entry point for offline callers; Writer tails JSONL."""
        self.apply_record(name, record)
        self.flush(force=record['type'] not in ('shot', 'crit'))

    def record_written(self, name, start, end):
        if not IDENTIFIER.match(name): raise ValueError('Invalid battle id')
        self.raw_targets[name] = max(int(end), self.raw_targets.get(name, 0))

    def has_pending_records(self):
        return any(self.raw_targets.get(name, 0) > self.raw_offsets.get(name, 0)
                   for name in self.raw_targets)

    def activate_tail(self, name):
        if self.current is not None and self.current.get('id') == name: return True
        if self.current is not None and not self.flush(force=True): return False
        if self.raw_offsets.get(name, 0):
            self.load_tail(name)
        else:
            self.current = None
            self.raw_decoders = {name:RecordDecoder()}
        return True

    def load_tail(self, name):
        """Make the whole battle file the current battle, read by read_battle: the one reader that also restores
        a lost header from its recovery file. Raises HeaderUnavailable when the file has neither."""
        decoder = RecordDecoder()
        battle, offset = read_battle(os.path.join(self.folder, 'battles', name+'.jsonl'), return_offset=True,
                                     decoder=decoder)
        self.current = battle
        self.raw_offsets[name] = offset
        self.raw_decoders = {name:decoder}
        self.reset_prepared()
        self.pending_publish = True

    def skip_battle(self, name, reason):
        """Pass a battle file over for the rest of the session (EXP-01/REC-02, review F3, 24.09).

        Two cases, both of which used to stall the whole export - a traceback every tick or every second, no other
        battle published, no model or TTX job run: a file without its header (nothing after it can be placed), and
        a battle whose publication fails the same way PUBLISH_GIVE_UP times in a row. One warning; everything the
        recorder appends to the file this session is passed over unread. The raw file stays as it is; the next start
        reads it again through setup, where a failure also keeps prune() off."""
        self.skipped.add(name)
        self.republish.discard(name)
        self.raw_offsets[name] = max(self.raw_offsets.get(name, 0), self.raw_targets.get(name, 0))
        self.raw_oversize.pop(name, None)
        if self.current is not None and self.current.get('id') == name:
            self.current = None
            self.reset_prepared()
            self.pending_publish = self.pending_quiet = False
        LOG.warning('Battle file skipped this session (%s): %s', reason, name)

    def consume_records(self, count_budget=TAIL_RECORD_BUDGET,
                        time_budget=TAIL_TIME_BUDGET, force=False):
        consumed = 0
        started = time.time()
        while consumed < count_budget and (force or time.time()-started < time_budget):
            names = [name for name in self.raw_targets
                     if self.raw_targets[name] > self.raw_offsets.get(name, 0)]
            if not names: break
            name = sorted(names)[0]
            if name in self.skipped:
                self.raw_offsets[name] = self.raw_targets[name]
                continue
            try:
                if not self.activate_tail(name): break
            except HeaderUnavailable:
                self.skip_battle(name, 'no header line')
                continue
            target = self.raw_targets[name]
            offset = self.raw_offsets.get(name, 0)
            # activate_tail may have read through the advertised target.
            if offset >= target: continue
            path = os.path.join(self.folder, 'battles', name+'.jsonl')
            with open(path, 'rb') as stream:
                while (consumed < count_budget and self.raw_offsets.get(name, 0) < target
                       and (force or time.time()-started < time_budget)):
                    offset = self.raw_offsets.get(name, 0)
                    scan = self.raw_oversize.get(name)
                    stream.seek(scan if scan is not None else offset)
                    line = stream.readline(2*1024*1024+1)
                    next_offset = stream.tell()
                    if scan is not None or (line and not line.endswith(b'\n') and len(line) > 2*1024*1024):
                        if line.endswith(b'\n'):
                            self.raw_oversize.pop(name, None)
                            if self.current is not None and self.current.get('id') == name:
                                self.current.setdefault('warnings', []).append(
                                    'Unreadable oversized record at byte '+str(offset))
                                self.pending_publish = True
                            self.raw_offsets[name] = next_offset
                            consumed += 1
                        elif not line or next_offset >= target:
                            self.raw_oversize.pop(name, None)
                            if self.current is not None and self.current.get('id') == name:
                                self.current.setdefault('warnings', []).append(
                                    'Unreadable truncated record at byte '+str(offset))
                                self.pending_publish = True
                            self.raw_offsets[name] = target
                            consumed += 1
                        else:
                            self.raw_oversize[name] = next_offset
                        continue
                    if not line or not line.endswith(b'\n') or next_offset > target:
                        return consumed
                    try:
                        row = self.raw_decoders[name].decode(json.loads(line.decode('utf-8')))
                        if row.get('schema') != 1: raise ValueError('Unknown schema')
                        if row.get('type') not in ('battle', 'hit', 'shot', 'crit', 'roster'):
                            raise ValueError('Unexpected record')
                    except (ValueError, AttributeError):
                        if self.current is not None and self.current.get('id') == name:
                            self.current.setdefault('warnings', []).append(
                                'Unreadable record at byte '+str(offset))
                            self.pending_publish = True
                        self.raw_offsets[name] = next_offset
                        consumed += 1
                        continue
                    # A battle-switch flush can fail while the output is locked.
                    # Advance only after the decoded row is fully applied.
                    try:
                        self.apply_record(name, row)
                    except HeaderUnavailable:
                        # The file's first record is not its header (its write was lost, REC-02): the whole file
                        # goes through read_battle, which restores the header from a recovery file if there is
                        # one; without one the file is passed over for the session.
                        try: self.load_tail(name)
                        except HeaderUnavailable: self.skip_battle(name, 'no header line')
                        consumed += 1
                        break
                    self.raw_offsets[name] = next_offset
                    consumed += 1
        return consumed

    def flush(self, force=False):
        pending = getattr(self, 'pending_publish', False)
        if not pending and not getattr(self, 'pending_quiet', False): return True
        if self.current is None:
            # Nothing to publish (activate_tail may drop the battle right after its forced publish): no publish(None).
            self.pending_publish = self.pending_quiet = False
            return True
        now = time.time()
        if now < self.next_publish_retry: return False
        if not force and now-getattr(self, 'last_published', 0) < (1 if pending else QUIET_PUBLISH): return False
        self.publishing_final = bool(force)
        try:
            self.publish(self.current)
            self.write_index()
        except Exception as error:
            self.publishing_final = False
            self.publish_failures += 1
            self.next_publish_retry = now + min(1.0, 0.1 * (2 ** min(self.publish_failures, 4)))
            # A locked or unwritable output is waited out as before; any other error that repeats is the
            # battle's own and would repeat all session, so the battle is let go (review F3, 24.09).
            if not isinstance(error, EnvironmentError) and self.current is not None:
                self.publish_faults += 1
                if self.publish_faults >= PUBLISH_GIVE_UP:
                    self.skip_battle(self.current.get('id'),
                                     'publication failed %d times in a row: %r' % (self.publish_faults, error))
                    self.publish_failures = self.publish_faults = 0
                    self.next_publish_retry = 0
                    return True
            raise
        self.publishing_final = False
        self.pending_publish = False
        # A damage episode held back (a fire still burning) asks for one more publish at the quiet pace.
        self.pending_quiet = bool(getattr(self, 'damage_held', False))
        self.publish_failures = 0
        self.publish_faults = 0
        self.next_publish_retry = 0
        self.last_published = time.time()
        return True

    def idle(self):
        """Consume a bounded batch, publish at cadence, then do one deferred job.

        Called on every worker tick, including under continuous input. Model
        extraction still waits until ingestion/publication catches up and the
        existing in-battle/busy checks allow it.
        """
        # A battle began while the background was halfway through a saved one: what it read is let go (run_battle_job).
        if self.battle_work is not None and not self.xml_allowed(): self.drop_battle_work()
        self.consume_records()
        published = self.flush()
        if getattr(self, 'pending_publish', False) and not published: return
        if self.has_pending_records(): return
        if self.drain_republish(): return
        if self.catalogue_dirty: self.write_catalogue()
        if self.vehicle_keys_dirty or self.models_index_dirty: self.write_keys()
        # What the battle files were built from, now and then outside a battle (in one, the battle's end or the game's
        # close writes it; a crash only costs the battles it misses one more publish at the next start).
        if (self.published_dirty and self.xml_allowed()
                and time.time() - self.published_written >= PUBLISHED_PAUSE): self.write_published()
        self.run_job()

    def finish(self):
        self.write_keys(force=True)
        self.flush_code_seen()
        while self.has_pending_records():
            if not self.consume_records(count_budget=512, time_budget=1.0, force=True): break
        done = self.flush(force=True)
        if self.published_dirty: self.write_published()
        return done

    def has_pending_publish(self):
        return bool(getattr(self, 'pending_publish', False) or getattr(self, 'pending_quiet', False))

    # --------------------------------------------------------------------- jobs
    # Extraction is what makes the hangar stutter: 0.12-0.37 s of the interpreter
    # lock per collision model on Python 3, two to three times that in the client's
    # 2.7, and up to four models per vehicle. So it never happens while publishing,
    # never during a battle, never while the user is dragging the page, and at most
    # one model every PACE seconds otherwise.

    def queue_job(self, priority, kind, payload):
        """Queue one unit of deferred work, or raise the priority of the queued one."""
        key = job_key(kind, payload)
        job = self.job_index.get(key)
        if job is not None:
            if priority < job[0]:
                job[0] = priority
                # The newer request of a vehicle (the page's click over a queued roster or hangar one) is the one the log
                # measures from (its requestedAt; review of click-export-fast 26.09). Never over a file's own request
                # queued to export it again (a migration, replay): that one keeps its configuration - a click would put the
                # hangar's or the top one in its place, and the request log would keep that for good (review of 4b1c8c8 #1).
                # The click's time goes with it for the log (askedAt).
                if kind == 'vehicle':
                    if (job[3] or {}).get('replay') is True:
                        job[3] = dict(job[3], askedAt=float((payload or {}).get('requestedAt') or time.time()))
                    else: job[3] = payload
            return job
        self.job_seq += 1
        job = [priority, self.job_seq, kind, payload]
        self.jobs.append(job)
        self.job_index[key] = job
        return job

    def queue_model(self, resource, version, key, vehicle, battle_id, priority):
        """One collision model, and who is waiting for it.

        'waiting' is what turns a finished job back into a published battle, and
        'job_types' is how the page can name a vehicle type and have its models
        moved to the front - a model job itself knows only a resource path.
        """
        self.queue_job(priority, 'model', (resource, version))
        if battle_id: self.waiting.setdefault(key, set()).add(battle_id)
        try:
            type_name = (vehicle or {}).get('type')
            if type_name:
                if len(self.job_types) > 8192: self.job_types = {}
                self.job_types.setdefault(resource, set()).add(str(type_name))
        except Exception:
            pass

    def best_job(self):
        best = 0
        for index in range(1, len(self.jobs)):
            if (self.jobs[index][0], self.jobs[index][1]) < (self.jobs[best][0], self.jobs[best][1]):
                best = index
        return best

    def take_job(self, index):
        job = self.jobs.pop(index)
        self.job_index.pop(job_key(job[2], job[3]), None)
        return job

    def jobs_allowed(self, page=False):
        """Never in a battle, never while the page is being used - except a job the page itself waits for (`page`: JOB_PAGE,
        click-export-fast 26.09): the user clicked a vehicle and waits for it, a drag in the scene does not hold it back.

        Both flags belong to the Recorder: the game thread writes them, this thread
        reads them. Without a recorder (the offline rebuild, a test) work may run.
        """
        recorder = self.recorder
        if recorder is None: return True
        try:
            if getattr(recorder, 'in_battle', False): return False
            return page or time.time() >= float(getattr(recorder, 'busy_until', 0) or 0)
        except Exception:
            return True

    def run_job(self):
        """One job per call, the lowest priority number first; with none queued, one slice of a sweep (run_sweeps). A sweep
        the user started goes before the background's jobs (JOB_BULK; BACKLOG 55: on 02.10 Export all models stood at 0
        behind 222 battles and 196 checks) - only what the page, the player or a battle's hits wait for comes first."""
        self.note_sweep_waits()
        if not self.jobs: return self.run_sweeps()
        index = self.best_job()
        if self.jobs[index][0] >= JOB_BULK and any(self.sweep_ready(kind) for kind in USER_SWEEPS): return self.run_sweeps()
        page = self.jobs[index][0] == JOB_PAGE
        if not self.jobs_allowed(page): return False
        # What the page is waiting for runs at once; everything else keeps PACE
        # seconds between two extractions, which halves the load on the hangar.
        if not page and time.time()-self.last_job < self.job_rest: return False
        job = self.take_job(index)
        started = TTX_TIMER()
        more = False
        try:
            if job[2] == 'model': self.run_model_job(job[3])
            elif job[2] == 'ttx': self.run_ttx_job(job[3])
            elif job[2] == 'extras': self.run_extras_job(job[3])
            elif job[2] == 'prefabs': self.run_prefab_check()
            elif job[2] == 'battle':
                # The battle the page asked for (request_battle): through a drag, its vehicle XML read at once.
                self.preparing_page = page
                try: more = self.run_battle_job(job[3])
                finally: self.preparing_page = False
            else: self.run_vehicle_job(job[3], page)
        except Exception:
            LOG.exception('Deferred %s job failed; the rest of the queue continues', job[2])
        # A saved battle with slices to go goes back in its own place (its priority and order): the next of them after the
        # rest, unless something the page waits for comes first.
        if more and job_key(job[2], job[3]) not in self.job_index:
            self.jobs.append(job)
            self.job_index[job_key(job[2], job[3])] = job
        self.last_job = time.time()
        self.page_follow = any(queued[0] == JOB_PAGE for queued in self.jobs)
        # A characteristics file is no extraction (26.09): the exported vehicles' files after a format change took 0.5 ms
        # each and waited PACE between them - 141 of them 47 s, the TTX sweep behind them. After one: the game's share of
        # the time its build took (SWEEP_SHARE, as between two slices of the sweep, at most SWEEP_REST_MAX); the export
        # loop's own wait for a message (50 ms) comes between two jobs anyway.
        spent = max(0.0, TTX_TIMER() - started)
        rest = spent * (1.0 - SWEEP_SHARE) / SWEEP_SHARE
        # A slice of a saved battle of setup's backlog (27.09) is no extraction either: the game's share after it, all of it
        # (review of 4b1c8c8 #4: a 1 s cap left the work 85-95 % of the time when a battle took seconds in one go).
        self.job_rest = rest if job[2] == 'battle' else min(SWEEP_REST_MAX, rest) if job[2] == 'ttx' else PACE
        return True

    def run_model_job(self, payload):
        """Extract one collision model and mark the battles that were waiting for it.

        A failure marks them too: the part then carries the reason instead of the
        pending flag, so the page stops waiting for something that will not come.
        """
        # The hits waited under the name the model had when they were published; a file of an earlier name found to hold the
        # same model (model_extract -> adopt_model) answers them under that one: both are let go.
        waited = self.model_ref(payload[0], payload[1])
        key, error = self.model_extract(payload[0], payload[1])
        for name in set([waited, key]):
            self.invalidate_model(name)
            self.republish.update(self.waiting.pop(name, ()))

    def run_vehicle_job(self, request, page=False):
        """One vehicle record, exported exactly as before - only its turn has changed. One the page waits for says in the
        log how long it took and how long after the click (the request's time) it was done - the in-game measure of it."""
        started = TTX_TIMER()
        try:
            # A migration's replay (replay_vehicle_requests) is exported as one; every other request as it always was.
            written = self.export_vehicle(request, replay=True) if request.get('replay') is True else self.export_vehicle(request)
        except Exception:
            if page: LOG.warning('Vehicle %s for the page failed; the page says so after its wait', request.get('vehicleType'))
            raise
        finally:
            # The wheeled files of an older build, exported again one by one: the catalogue once, after the last.
            name = str(request.get('vehicleType') or '')
            if name in self.migrating:
                self.migrating.discard(name)
                if not self.migrating: self.catalogue_dirty = True
            # One the page waits for: its row stops saying 'outdated' at the next idle tick, whatever else still migrates.
            if page and request.get('replay') is True: self.catalogue_dirty = True
        if page:
            try: after = time.time() - float(request.get('askedAt') or request.get('requestedAt') or 0)
            except Exception: after = -1.0
            LOG.info('Vehicle %s for the page: %s in %.2f s, %.2f s after the request', request.get('vehicleType'),
                     'exported' if written else 'already current', TTX_TIMER() - started, after)

    def request_vehicle_export(self, request):
        """The export thread's entry point for a vehicle asked for by the game.

        The work is unchanged; it simply waits in the one queue now, so a model the
        page is looking at goes first and the pace between two extractions holds.
        """
        source = str((request or {}).get('source') or '')
        # A click on a row whose file is out of date (a page of an earlier build still sends one): the file's own request,
        # never the hangar's or the top configuration picker_descriptor built (review of 4b1c8c8 #1).
        if source == 'picker':
            type_name = str(request.get('vehicleType') or '')
            own = self.outdated_request(type_name) if ('vehicle', type_name) not in self.job_index else None
            if own is not None: request = dict(own, replay=True, askedAt=float(request.get('requestedAt') or time.time()))
        self.queue_job(VEHICLE_PRIORITY.get(source, JOB_OTHER), 'vehicle', request)

    def outdated_request(self, type_name):
        """The own request (migration_request) of a vehicle file this session found out of date - the catalogue's 'outdated':
        a file of this client whose summary has no hash (a wheeled type without its wheels, a prefab type without its
        prefabs, a missing extra track pair) - read from the file; None for any other type, and once a session per type
        (a re-export that fails is not tried again on every hit the page opens)."""
        summary = self.vehicles.get(vehicle_id(type_name))
        if not summary or summary.get('descriptorHash') is not None: return None
        if type_name in self.outdated_tried: return None
        self.outdated_tried.add(type_name)
        try:
            request = migration_request(read_data_file(os.path.join(self.folder, 'data', 'vehicles', vehicle_id(type_name)+'.js')))
        except Exception:
            LOG.exception('Out-of-date vehicle file of %s unreadable; it is not exported again', type_name)
            return None
        return request if request.get('compactDescriptor') and request.get('vehicleType') == type_name else None

    def prioritise(self, types):
        """The page opened a hit: whatever it needs is moved to the front.

        Client vehicle type names, at most eight. A model job knows only its
        resource, so it is matched through the vehicles whose parts asked for it.
        """
        wanted = set()
        for name in list(types or [])[:8]:
            if name: wanted.add(str(name))
        if not wanted: return 0
        # What an earlier hit lifted goes back to its own turn: a job lifted once stayed JOB_PAGE for good, and ten hits
        # opened in a row left ten vehicles' extractions running through a drag (review of click-export-fast 26.09).
        for key, priority in self.lifted.items():
            job = self.job_index.get(key)
            if job is not None and job[0] == JOB_PAGE: job[0] = priority
        self.lifted = {}
        moved = 0
        for job in self.jobs:
            if job[0] == JOB_PAGE: continue
            if job[2] in ('vehicle', 'ttx', 'extras', 'prefabs'):
                match = str((job[3] or {}).get('vehicleType') or '') in wanted
            elif job[2] == 'battle':
                match = False
            else:
                match = bool(self.job_types.get(job[3][0], ()) and self.job_types[job[3][0]] & wanted)
            if match:
                self.lifted[job_key(job[2], job[3])] = job[0]
                job[0] = JOB_PAGE
                if job[2] == 'vehicle' and (job[3] or {}).get('replay') is True: job[3] = dict(job[3], askedAt=time.time())
                moved += 1
        # A file out of date whose own job is not queued (it ran and failed, or its migration had no request to replay): the
        # page opened it - 'prioritise' is what the page sends for such a row (review of 4b1c8c8 #1) - so it is exported again
        # from its own request at the page's turn, never in another configuration.
        for type_name in sorted(wanted):
            if ('vehicle', type_name) in self.job_index: continue
            request = self.outdated_request(type_name)
            if request is None: continue
            self.queue_job(JOB_PAGE, 'vehicle', dict(request, replay=True, askedAt=time.time()))
            self.lifted[('vehicle', type_name)] = JOB_BULK
            self.migrating.add(type_name)
            moved += 1
        if moved: LOG.info('Page asked for %s deferred job(s) first', moved)
        return moved

    def drain_republish(self):
        """Rewrite one battle whose models have arrived; at most one per second each.

        Several models finishing in a row are therefore batched into one rewrite,
        and the index stamp tells the page to read the battle again.
        """
        if not self.republish: return False
        now = time.time()
        for battle_id in sorted(self.republish):
            if battle_id in self.skipped:
                self.republish.discard(battle_id)
                continue
            if now-self.republished.get(battle_id, 0) < 1: continue
            self.republished[battle_id] = now
            try:
                self.republish_saved(battle_id)
                self.write_index()
                self.republish.discard(battle_id)
            except Exception:
                LOG.exception('Could not republish a battle after a model job: %s', battle_id)
            return True
        return False

    def prune(self):
        # Storage hygiene without a battle cap: every recorded battle is kept, raw JSONL and
        # derived file alike. A collision model is removed only when no battle and no exported
        # vehicle references it any more; vehicle records hold their keys under 'vehicle:<id>',
        # which no battle id can collide with (IDENTIFIER has no colon).
        # Only data/models is swept; a data/icons folder left by 0.7.14 is harmless and stays.
        referenced = set()
        for keys in self.model_refs.values(): referenced.update(keys)
        for path in glob.glob(os.path.join(self.folder, 'data', 'models', '*.js')):
            key = os.path.basename(path)[:-3]
            if key in referenced: continue
            try: os.remove(path)
            except Exception: LOG.exception('Could not remove unreferenced model: %s', path)
            self.attempts.pop(key, None)

    def write_index(self, prune=False):
        # The prune that waited for the references of the last stale battle without them (publish sets prune_now).
        if prune or getattr(self, 'prune_now', False):
            self.prune_now = False
            self.prune()
        # A battle whose file is not current says so ('stale', BACKLOG 55): the page shows that file and asks for the battle.
        battles = sorted((dict(row, stale=True) if row.get('id') in self.stale else row for row in self.summaries.values()),
                         key=lambda b:b.get('startedAt') or 0, reverse=True)
        write_data(os.path.join(self.folder, 'data', 'index.js'), 'index',
                   {'application':'local.armor_inspector', 'version':VERSION, 'updatedAt':time.time(), 'battles':battles})

    # ------------------------------------------------------------------ vehicles

    def load_settings(self):
        """mods/configs/local.armor_inspector/settings.json, read once at setup.

        Written with the defaults when it is absent; a malformed file leaves the
        defaults in place with a warning rather than stopping the export. No setting
        is read today (exportAllVehicles, the hidden bulk export, gave way to the
        page's Export all models on 25.09); a file that still sets it is not rewritten.
        """
        path = os.path.join(self.folder, 'settings.json')
        self.settings = dict(DEFAULT_SETTINGS)
        try:
            if os.path.isfile(path):
                with open(path, 'rb') as stream:
                    stored = json.loads(stream.read(65537).decode('utf-8'))
                if not isinstance(stored, dict): raise ValueError('Settings must be a JSON object')
                for key in DEFAULT_SETTINGS:
                    if key in stored: self.settings[key] = stored[key]
                if stored.get('exportAllVehicles'):
                    LOG.info('settings.json exportAllVehicles is no longer read: Export all models in the Vehicles list does it')
            else:
                atomic_write(path, json.dumps(DEFAULT_SETTINGS, sort_keys=True, indent=2).encode('ascii'))
        except Exception:
            self.settings = dict(DEFAULT_SETTINGS)
            LOG.warning('Settings unreadable; the defaults are used: %s', path)
        return self.settings

    def load_vehicles(self):
        """Pick up the vehicles exported by earlier runs.

        Two things depend on it: the catalogue's 'exported' flags, and prune() -
        a model referenced only by an exported vehicle would otherwise be deleted
        as unused on the next index write. Returns False when any file did not
        read: its references are then unknown and setup must not prune.
        """
        complete = True
        # Files of wheeled vehicles written before the wheels, by type: replay_vehicle_requests exports them again.
        self.stale_vehicles = {}
        # Which types are wheeled: the client's own list (its tags), read once here - no descriptor per file.
        wheeled = wheeled_types()
        # Files from before the armoured prefabs (27.09), by type: the prefab check job picks the few to export again - only
        # what it needs of each (migration_request and the folders of its models), never the record (review of d1b372b).
        # Once the check has run for this client version its folders decide at once (read_prefab_folders): no job.
        self.prefab_unchecked = {}
        prefab_folders = self.read_prefab_folders()
        for path in sorted(glob.glob(os.path.join(self.folder, 'data', 'vehicles', '*.js'))):
            try:
                record = read_data_file(path)
                # A vehicle exported before the aim block or the fitment fields existed gets them
                # here, from its own compact descriptor and the client's cache. Re-exporting it
                # instead would re-extract every collision model of the catalogue on the first
                # start after the update, for two small dictionaries; the rest is already current.
                identifier = record.get('id')
                filled = fix_aim(record)
                filled = fix_fitment(record) or filled
                # An exported vehicle's block is always the compact descriptor's (S3, 22.09).
                aim = record.get('aim')
                if isinstance(aim, dict) and 'aimFrom' not in aim:
                    aim['aimFrom'] = 'compact'
                    filled = True
                # Exported before an extra track pair was a part (docs/BACKLOG.md 33): checked once, from its own
                # descriptor. A vehicle that has one is exported again by the replay right after this (its
                # summary gets no hash), which extracts the one missing model; every other one is marked and
                # written back with the other fixes, so the check never runs twice for a file.
                stale = False
                if record.get('parts') and 'staticParts' not in record:
                    try:
                        count = len(static_parts(vehicle_descr(record['compactDescriptor'])))
                        if count > len(record['parts']):
                            stale = True
                        else:
                            record['staticParts'] = len(record['parts'])
                            filled = True
                    except Exception:
                        pass
                # Exported before the wheels were parts (docs/BACKLOG.md 39). A wheeled vehicle - by the client's list,
                # no descriptor built - is exported again in the background after setup (replay_vehicle_requests), from
                # its request or from this file itself when no request names it (a sweep's, a hangar's). Any other file
                # has nothing to add and is left as it is: no rewrite (review of 5f2bee5: the first start rewrote every
                # exported file for a 0). Without the client's list (outside the game) the descriptor decides.
                if record.get('parts') and 'wheelParts' not in record and not stale:
                    type_name = str(record.get('type') or '')
                    try:
                        if (type_name in wheeled if wheeled is not None
                                else bool(wheel_parts(vehicle_descr(record['compactDescriptor'])))):
                            stale = True
                            self.stale_vehicles[type_name] = migration_request(record)
                    except Exception:
                        pass
                if record.get('parts') and 'prefabParts' not in record and not stale and record.get('type'):
                    folders = collision_folders(record)
                    if prefab_folders is None:
                        self.prefab_unchecked[str(record['type'])] = (identifier, folders, migration_request(record))
                    elif prefab_folders.intersection(folders):
                        stale = True
                        self.stale_vehicles[str(record['type'])] = migration_request(record)
                if filled and identifier and IDENTIFIER.match(identifier):
                    write_data(path, 'vehicle:'+identifier, record)
                self.remember_vehicle(record)
                if stale and identifier in self.vehicles:
                    self.vehicles[identifier]['descriptorHash'] = None
            except Exception:
                complete = False
                LOG.exception('Could not read an exported vehicle: %s', os.path.basename(path))
        return complete

    def remember_vehicle(self, record):
        """Keep the catalogue summary and the model references of one vehicle record."""
        identifier = record.get('id')
        if not identifier or not IDENTIFIER.match(identifier): return
        summary = dict((key, record.get(key)) for key in
                       ('id', 'type', 'name', 'level', 'class', 'role', 'nation',
                        'premium', 'collector', 'special', 'source', 'exportedAt', 'clientVersion'))
        summary['descriptorHash'] = descriptor_hash(record.get('type'), record.get('compactDescriptor'))
        summary['format'] = record.get('format', 1)
        # What its key is made of besides its type (vehicle_key): the descriptor and each part's model and prefab.
        summary['compactDescriptor'] = record.get('compactDescriptor')
        summary['parts'] = [dict((k, part[k]) for k in ('resource', 'prefab') if part.get(k))
                            for part in record.get('parts') or [] if isinstance(part, dict)]
        self.vehicles[identifier] = summary
        self.model_refs['vehicle:'+identifier] = set(part['modelKey'] for part in record.get('parts') or []
                                                     if part.get('modelKey'))

    def append_vehicle_request(self, request):
        """The raw request line - the vehicle twin of the battle JSONL, and as authoritative.

        Every derived vehicle file can be rebuilt from it after a client update,
        because the model keys carry the client version and are re-extracted then.
        """
        row = {'schema':1, 'type':'vehicle', 'vehicleType':str(request.get('vehicleType') or ''),
               'compactDescriptor':request.get('compactDescriptor'), 'source':request.get('source'),
               'requestedAt':float(request.get('requestedAt') or time.time())}
        folder = os.path.join(self.folder, 'vehicles')
        if not os.path.isdir(folder): os.makedirs(folder)
        line = (json.dumps(row, ensure_ascii=True, allow_nan=False, separators=(',', ':'))+'\n').encode('utf-8')
        with open(os.path.join(folder, 'exports.jsonl'), 'ab') as stream:
            stream.write(line)

    def replay_vehicle_requests(self):
        """Rebuild the derived vehicle files from the raw log, last request per type.

        Same contract as the battles: the JSONL is what survives, the .js files are
        derived. Deduplication skips the ones that are already current.
        """
        path = os.path.join(self.folder, 'vehicles', 'exports.jsonl')
        requests = {}
        try:
            with open(path, 'rb') if os.path.isfile(path) else io.BytesIO() as stream:
                for number in range(100001):
                    line = stream.readline(1024*1024+1)
                    if not line: break
                    if number == 100000 or len(line) > 1024*1024:
                        raise ValueError('Vehicle request log exceeds the export limit')
                    if not line.endswith(b'\n'): break
                    try:
                        row = json.loads(line.decode('utf-8'))
                    except ValueError:
                        continue
                    # 'catalogue' rows (the bulk export's until 25.09) belong to the model sweep and its keys: replaying
                    # them re-exported every such vehicle here, at setup, after every game update.
                    if (row.get('schema') == 1 and row.get('type') == 'vehicle' and row.get('vehicleType')
                            and row.get('source') != 'catalogue'):
                        requests[str(row['vehicleType'])] = row
        except Exception:
            LOG.exception('Vehicle request log unreadable; exported vehicles are kept as they are')
            return
        # A wheeled vehicle's file from before the wheels (load_vehicles) is exported again as background work, not here:
        # one vehicle job each at the bulk pace (its models are on disk already; the XML read is the cost), from its
        # request or - when no request names it (the model sweep's, or one whose request line is gone) - from the file
        # itself, with its own source. The catalogue is written once, after the last of them (run_vehicle_job).
        stale, self.stale_vehicles = getattr(self, 'stale_vehicles', None) or {}, {}
        for type_name, own in sorted(stale.items()):
            request = requests.pop(type_name, None)
            if request is None and type_name and own.get('compactDescriptor'): request = migration_request(own)
            if request is None: continue
            self.migrating.add(type_name)
            self.queue_job(JOB_BULK, 'vehicle', dict(request, replay=True))
        # Files from before the armoured prefabs: one background check, not a descriptor per file (run_prefab_check).
        if getattr(self, 'prefab_unchecked', None): self.queue_job(JOB_BULK, 'prefabs', {'vehicleType':''})
        # A request whose file is there in its configuration is done: whether the file is still this client's is the
        # background check's (start_verify) - nothing is exported inside setup any more (BACKLOG 55: 02.10, 196 vehicles and
        # their models, 31 s before the page heard a command). A request with no such file is one background job.
        for type_name in sorted(requests):
            request = requests[type_name]
            identifier = vehicle_id(type_name)
            known = self.vehicles.get(identifier)
            if (known and known.get('descriptorHash') == descriptor_hash(type_name, request.get('compactDescriptor'))
                    and os.path.isfile(os.path.join(self.folder, 'data', 'vehicles', identifier + '.js'))):
                continue
            self.queue_job(JOB_BULK, 'vehicle', dict(request, replay=True))

    def export_vehicle(self, request, replay=False, sweep=False, descr=None, verify=False):
        """One vehicle of the client, exported from its compact descriptor.

        Export thread only: rebuilding the descriptor, reading collision models out
        of the client packages and collecting armour tables is exactly the work the
        game thread must never do. Returns False when the request was a duplicate -
        or when the file built is the one on disk (BACKLOG 55: then it is not written).
        `sweep` (the model sweep): no line in the request log - the sweep's keys own
        such a file - and the catalogue is written by the idle tick, not per vehicle;
        `descr` is the descriptor the sweep built the request from. `verify` (the client
        change check, verify_step): built again whatever the duplicate shortcut says.
        """
        type_name = str(request.get('vehicleType') or '')
        compact = request.get('compactDescriptor')
        identifier = vehicle_id(type_name)
        if ':' not in type_name or not IDENTIFIER.match(identifier):
            raise ValueError('Invalid vehicle type')
        # The characteristics file of this type (TTX panel), checked BEFORE the duplicate shortcut below: a
        # vehicle exported before this build would otherwise never get one. A replay or a check only queues it, and only
        # when there is none (BACKLOG 55: one 'ttx' job per replayed vehicle on every start - 196 - read a current file
        # each; a file whose key changed is the background check's); any other request builds it here, on the thread
        # that is busy with this vehicle anyway. It never costs the vehicle export.
        try:
            if not (replay or verify) or not os.path.isfile(self.ttx_path(type_name)):
                self.ensure_ttx(type_name, inline=not (replay or verify))
        except Exception:
            LOG.exception('TTX check failed for %s; the vehicle export continues', type_name)
        digest = descriptor_hash(type_name, compact)
        path = os.path.join(self.folder, 'data', 'vehicles', identifier+'.js')
        known = self.vehicles.get(identifier)
        if not verify and known and known.get('descriptorHash') == digest and os.path.isfile(path) and self.vehicle_current(known):
            return False
        if not replay and not sweep: self.append_vehicle_request(request)
        if descr is None: descr = vehicle_descr(compact)
        record = {'schema':1, 'warnings':[]}
        record.update(descr_identity(descr))
        for key in ('name', 'level', 'class', 'role', 'nation'):
            if record.get(key) is None and (request.get('identity') or {}).get(key) is not None:
                record[key] = request['identity'][key]
        if record.get('name') is None and request.get('name'): record['name'] = request['name']
        # Its format (second review F): written from VEHICLE_FORMAT 2 on - a file without it is of format 1 (0.9.3's).
        if VEHICLE_FORMAT != 1: record['format'] = VEHICLE_FORMAT
        record.update({'id':identifier, 'type':type_name, 'source':request.get('source'),
                       'exportedAt':time.time(), 'clientVersion':self.version, 'compactDescriptor':compact})
        try:
            record['gun'] = getattr(descr.gun, 'shortUserString', descr.gun.name)
            record['gunDispersion'] = float(descr.gun.shotDispersionAngle)
        except Exception:
            record['warnings'].append('Gun parameters unavailable')
        try:
            # The XML names of the mounted gun and turret: the exact pair among the configs of data/ttx/<id>.js.
            record['gunName'] = str(descr.gun.name)
            record['turretName'] = str(descr.turret.name)
        except Exception:
            record['warnings'].append('Gun and turret names unavailable')
        try:
            # The health of this configuration (hull variant + turret), which the page had no source for.
            record['maxHealth'] = int(descr.maxHealth)
        except Exception:
            record['warnings'].append('Vehicle health unavailable')
        try:
            # Everything the page's dispersion circle needs about this vehicle as a shooter.
            block = aim_block(descr)
            if block:
                # Rebuilt from the compact descriptor: no battle, no field modifications (S3, 22.09).
                block['aimFrom'] = 'compact'
                record['aim'] = block
            else: record['warnings'].append('Aim parameters unavailable')
        except Exception:
            record['warnings'].append('Aim parameters unavailable')
        try:
            # The client's own sum (vehicles.py VehicleDescr.__updateAttributes), the same
            # one the recorder writes for a shooter: the gun axis above flat ground.
            record['gunHeight'] = float((descr.chassis.hullPosition + descr.hull.turretPositions[0] +
                                         descr.turret.gunPosition).y)
            record['gunHeightFrom'] = 'ground'
        except Exception:
            record['warnings'].append('Gun height unavailable')
        try:
            limits = yaw_limits(descr)
            if limits is not None: record['turretYawLimits'] = limits
        except Exception:
            record['warnings'].append('Turret yaw limits unavailable')
        # The gun's static angles beside its sector (23.09, second modes M5): the viewer holds such a turret and gun
        # still, as the client's armour view does. Only for a gun that has them; older files are not rebuilt for it.
        for name in ('staticPitch', 'staticTurretYaw'):
            try:
                value = getattr(descr.gun, name, None)
                if value is not None: record[name] = float(value)
            except Exception:
                pass
        try:
            record['gunPitchLimits'] = gun_limits(descr)
        except Exception:
            record['warnings'].append('Gun pitch limits unavailable')
        try:
            record['shells'] = shot_candidates(descr)
        except Exception:
            record['shells'] = []
            record['warnings'].append('Shell parameters unavailable')
        try:
            # The same spall-liner factor a hit's target carries, for the page's expected-damage map.
            record['linerFactor'] = float(descr.miscAttrs.get('antifragmentationLiningFactor', 1.0))
        except Exception:
            pass
        try:
            record['parts'] = parts_from_descr(descr, 'client vehicle descriptor')
            record['partsFrom'] = 'rest pose'
            # Every static collision part is listed (static_parts); the count also tells load_vehicles
            # that this file needs no check for a missing extra track pair.
            record['staticParts'] = len(record['parts'])
            # Then the wheels (BACKLOG 39): only those that got their body. The count tells load_vehicles this file has
            # been written knowing them - so it is left out when the XML did not read (type_extras): a failure of this
            # session must not mark the file for good (review of 5f2bee5); the next start looks at it again.
            wheels = {'parts':wheel_parts(descr, 'client vehicle descriptor')}
            listed = len(wheels['parts'])
            if listed:
                try:
                    extras = self.type_extras(descr.type.name)
                    if extras is None: raise ExtrasUnavailable('not read during a battle')
                    fill_wheels(wheels, extras['wheels'].get(descr.chassis.name) or {})
                except Exception:
                    pass
            wheels = [part for part in wheels['parts'] if 'wheel' in part]
            record['parts'].extend(wheels)
            if wheels or not listed: record['wheelParts'] = len(wheels)
            else: record['warnings'].append('Wheel bodies unavailable')
            # Then the armoured prefabs of its mounted components (27.09: the CAV mod. 71's crest, the AS-XX 40 t's
            # containers) at their default layer on the rest pose of their parent part. The count, as the wheels', only when
            # the XML and every prefab it names were read: a failure of this session is looked at again at the next start.
            prefabs = []
            try:
                # No slot on a mounted component: nothing to read (the XML costs 50-90 ms; most vehicles have none).
                extras = self.type_extras(descr.type.name) if descriptor_slots(descr) else {'prefabs':[], 'prefabErrors':[]}
                if extras is None: raise ExtrasUnavailable('not read during a battle')
                names = prefab_components(descr)
                placed = dict((p['id'], p.get('transform')) for p in record['parts'] if isinstance(p.get('id'), int))
                number = max([key for key in placed if key >= 0] or [3]) + 1
                for entry in extras['prefabs']:
                    if names.get(entry['parent']) != entry['component']: continue
                    if not placed.get(entry['parent']): raise ValueError('parent part %d has no place' % entry['parent'])
                    prefabs.append(prefab_part(entry, placed[entry['parent']], number))
                    number += 1
                if extras['prefabErrors']: raise ValueError('; '.join(extras['prefabErrors']))
                record['prefabParts'] = len(prefabs)
            except Exception as exc:
                record['warnings'].append('Armoured prefabs unavailable: %s' % exc)
            record['parts'].extend(prefabs)
            self.publish_vehicle_parts(record['parts'], record, self.version, extract=True)
        except Exception:
            record['parts'] = []
            record['warnings'].append('Collision parts unavailable')
            LOG.exception('Collision parts unavailable for %s', type_name)
        # Never a worse file because something did not read (second review B): a rebuild with fewer parts, models, wheels or
        # prefabs than the file on disk and a read error of its own keeps the file - and its old key, so it is tried again.
        worse = self.degraded_vehicle(path, record)
        if worse:
            LOG.warning('Vehicle %s: the rebuild is degraded (%s) - its file and key are kept, tried again later', type_name, worse)
            return False
        # The same file as on disk (BACKLOG 55: a client update usually changes nothing of it): not written, only its key kept.
        old = self.same_vehicle_file(path, record)
        if old is not None:
            self.remember_vehicle(old)
            self.keep_vehicle_key(old)
            return False
        write_data(path, 'vehicle:'+identifier, record)
        self.remember_vehicle(record)
        self.keep_vehicle_key(record)
        # A replay writes no catalogue of its own: setup writes it after all of them, the background ones once at the end.
        if sweep: self.catalogue_dirty = True
        elif not replay: self.write_catalogue()
        return True

    # Fields a vehicle file may differ in without being another file (when and by which client it was written).
    VEHICLE_VOLATILE = ('exportedAt', 'clientVersion')

    def same_vehicle_file(self, path, record):
        """The file on disk when it is `record` but for VEHICLE_VOLATILE and the names of its model files (two names of one
        model - model_identity - are the same part); None otherwise or when it does not read."""
        try:
            if not os.path.isfile(path): return None
            old = read_data_file(path)
        except Exception:
            return None
        def plain(value):
            value = dict((k, v) for k, v in value.items() if k not in self.VEHICLE_VOLATILE)
            parts = []
            for part in value.get('parts') or []:
                part = dict(part) if isinstance(part, dict) else part
                if isinstance(part, dict) and part.get('modelKey'):
                    part['modelKey'] = list(self.model_identity(str(part['modelKey'])))
                parts.append(part)
            value['parts'] = parts
            return json.loads(json.dumps(value))
        try:
            return old if plain(old) == plain(record) else None
        except Exception:
            return None

    @staticmethod
    def vehicle_counts(record):
        parts = [p for p in record.get('parts') or () if isinstance(p, dict)]
        return {'parts': len(parts), 'models': len([p for p in parts if p.get('modelKey') and not p.get('modelError')]),
                'wheels': len([p for p in parts if p.get('wheel')]), 'prefabs': len([p for p in parts if p.get('prefab')])}

    def degraded_vehicle(self, path, record):
        """Why a rebuilt vehicle record is worse than its file on disk because of a read error ('' when it is not): fewer
        parts, models, wheels or prefabs, and a part's model or armour error or an 'unavailable' warning the file did not have."""
        try:
            if not os.path.isfile(path): return ''
            old = read_data_file(path)
        except Exception:
            return ''
        before, after = self.vehicle_counts(old), self.vehicle_counts(record)
        fewer = [k for k in sorted(before) if after[k] < before[k]]
        if not fewer: return ''
        errors = [p.get('modelError') or p.get('armorError') for p in record.get('parts') or ()
                  if isinstance(p, dict) and (p.get('modelError') or p.get('armorError'))]
        errors += [w for w in record.get('warnings') or () if 'unavailable' in str(w) and w not in (old.get('warnings') or ())]
        if not errors: return ''
        return 'fewer %s; %s' % ('/'.join(fewer), errors[0])

    def keep_vehicle_key(self, record):
        """The key a vehicle file was just built or checked with (vehicle_keys); without a snapshot the fallback key of this
        client (fallback_key), so a file checked once is not built again at every start (review 02.10 #1b)."""
        identifier = str(record.get('id') or '')
        if not identifier: return
        try:
            key = self.vehicle_key(record) if self.client() is not None else self.fallback_key()
        except Exception:
            key = self.fallback_key()
        if self.vehicle_keys().get(identifier) != key:
            self.vehicle_keys()[identifier] = key
            self.vehicle_keys_dirty = True

    # ------------------------------------------------------- characteristics (TTX)

    def ttx_path(self, type_name):
        return os.path.join(self.folder, 'data', 'ttx', vehicle_id(type_name)+'.js')

    def ttx_current(self, type_name):
        """True when data/ttx/<id>.js exists with the current schema and format and its key is the one it was built or
        checked with (a ~5 KB read; BACKLOG 55: not the client version - a file of another client whose key held is current)."""
        path = self.ttx_path(type_name)
        if not os.path.isfile(path): return False
        try:
            value = read_data_file(path)
        except Exception:
            return False
        if not (isinstance(value, dict) and value.get('schema') == TTX_SCHEMA):
            return False
        # Its key (the progress file's, start_ttx_sweep): changed - not current (built again and compared: build_ttx). No keys
        # this session (no snapshot): current only when built or checked by this very client (its version text, or the
        # fallback key a check under it left) - a key of another client says nothing (review 02.10 #1a).
        state = self.ttx_state or {}
        if state.get('now') is not None:
            if type_name not in state['now'] or state['keys'].get(type_name) != state['now'][type_name]: return False
        elif (canonical(value.get('clientVersion') or '') != self.version
              and (state.get('keys') or {}).get(type_name) != self.fallback_key()):
            return False
        # Any file that predates the armour and the suspension's repair (23.09) is built again, once.
        if value.get('armorSchema') != TTX_ARMOR_SCHEMA:
            return False
        # So is a file of another TTX_FORMAT (a file without the field is format 1: before the shells' traceRicochet).
        if value.get('format', 1) != TTX_FORMAT:
            return False
        # A vehicle with a second mode or a rocket booster whose file predates their fields is built again, once.
        vehicle = value.get('vehicle') or {}
        modes = vehicle.get('modes') or {}
        if (modes.get('siege') or modes.get('rocketAcceleration')) and value.get('modesSchema') != TTX_MODES_SCHEMA:
            return False
        # So is a gun with a sector whose file predates hasTurret (23.09): the page places the sector by it.
        return 'hasTurret' in vehicle or not any(c.get('turretYawLimits') for c in value.get('configs') or ())

    def ensure_ttx(self, type_name, inline, priority=JOB_BULK):
        """Make sure the characteristics file of a type is current; export thread only.

        Lazy: the first request of a type in this session reads its file, later ones only look at
        ttx_known. inline builds a missing or outdated file at once; otherwise one 'ttx' job is queued,
        which runs in the same queue, at the same pace and under the same jobs_allowed() as a model: never
        in a battle, never while the page is busy. A type whose build failed is not tried again this
        session, unless the page itself asks (priority JOB_PAGE). Returns True when a file was written.
        """
        state = self.ttx_known.get(type_name)
        if state == TTX_CURRENT: return False
        if state == TTX_FAILED and priority != JOB_PAGE: return False
        if not inline:
            self.queue_job(priority, 'ttx', {'vehicleType':type_name})
            return False
        return self.build_ttx(type_name)

    def build_ttx(self, type_name, sweep=None, force=False):
        """Check the file of one type and build it when it is missing or outdated.

        `sweep` (the background sweep's state): the build logs nothing; a failure is counted in the sweep, whose one line
        names the first, instead of a traceback. The type it parsed stays in the client's cache (no eviction, 25.09): a
        type parsed twice in one session raises in the client."""
        if not force and self.ttx_current(type_name):
            self.ttx_known[type_name] = TTX_CURRENT
            return False
        try:
            block = ttx_block(type_name, self.version, log=sweep is None)
        except ImportError:
            # Outside the game: the client's item modules do not exist.
            self.ttx_known[type_name] = TTX_FAILED
            if sweep is None: LOG.warning('TTX %s unavailable: the client item modules are missing', type_name)
            else: sweep['error'] = sweep['error'] or 'client item modules missing'
            return False
        except Exception as error:
            self.ttx_known[type_name] = TTX_FAILED
            if sweep is None: LOG.exception('TTX %s could not be built; nothing else is affected', type_name)
            else:
                sweep['error'] = sweep['error'] or '%s: %r' % (type_name, error)
                self.ttx_key_done(type_name, False)
            return False
        try:
            # The same file as on disk but for when and by whom it was built (BACKLOG 55): not written, its key kept.
            if self.same_ttx_file(type_name, block):
                self.ttx_known[type_name] = TTX_CURRENT
                self.ttx_key_done(type_name, True)
                return False
            write_data(self.ttx_path(type_name), 'ttx:'+vehicle_id(type_name), block)
        except Exception as error:
            # The sweep's own: an ordinary failure of this vehicle, the sweep goes on (review #2). The page's request
            # raises as before, into run_job's own guard.
            if sweep is None: raise
            self.ttx_known[type_name] = TTX_FAILED
            self.ttx_key_done(type_name, False)
            sweep['error'] = sweep['error'] or '%s: %r' % (type_name, error)
            return False
        self.ttx_known[type_name] = TTX_CURRENT
        self.ttx_key_done(type_name, True)
        # A page's own build with no sweep running: the progress file keeps its key now.
        if sweep is None and self.ttx_sweep is None and self.ttx_state is not None and self.ttx_state['now'] is not None:
            self.write_sweep('ttx', done=True)
        return True

    # Fields a characteristics file may differ in without being another file.
    TTX_VOLATILE = ('clientVersion', 'producedAt', 'buildMs')

    def same_ttx_file(self, type_name, block):
        """The file on disk is `block` but for TTX_VOLATILE (False when there is none or it does not read)."""
        try:
            path = self.ttx_path(type_name)
            if not os.path.isfile(path): return False
            old = read_data_file(path)
            plain = lambda value: json.loads(json.dumps(dict((k, v) for k, v in value.items() if k not in self.TTX_VOLATILE)))
            return plain(old) == plain(block)
        except Exception:
            return False

    def run_ttx_job(self, payload):
        """A queued 'ttx' job: the check and, when needed, the build."""
        type_name = str((payload or {}).get('vehicleType') or '')
        if self.ttx_known.get(type_name) == TTX_CURRENT: return
        self.build_ttx(type_name)

    def request_ttx(self, type_name):
        """The page's exportTtx command: this type's characteristics before any background work, and
        without its collision models. The page sends it once per session per type, in the game only."""
        type_name = str(type_name or '')
        if ':' not in type_name or not IDENTIFIER.match(vehicle_id(type_name)):
            raise ValueError('Invalid vehicle type')
        self.ensure_ttx(type_name, inline=False, priority=JOB_PAGE)

    # THE SWEEPS (TTX_SWEEP_SLICE): 'ttx' (24.09) and 'models' (25.09), one machinery, in SWEEP_ORDER. Each kind has its
    # progress file (the one owner of its sources' keys, how far it got, whether it runs), the same gates, slices, Start,
    # Stop and resume; a kind brings its stamp, its start (which types) and its step (one unit of work on one type).
    def sweep_stamp(self, kind):
        """What a progress file's work was done for: the formats and the client's files (the snapshot's id - BACKLOG 55: a
        reason to look at the keys again, not a key; the client version when there is no snapshot)."""
        snapshot = self.client()
        client = snapshot.id if snapshot is not None else self.version
        if kind == 'ttx':
            return {'client': client, 'schema': TTX_SCHEMA, 'modesSchema': TTX_MODES_SCHEMA,
                    'armorSchema': TTX_ARMOR_SCHEMA, 'format': TTX_FORMAT}
        return {'client': client, 'format': MODELS_FORMAT}

    def sweep_path(self, kind):
        return os.path.join(self.folder, *SWEEP_FILES[kind][0])

    def sweep_marker(self, kind):
        """The progress file, or None (none yet, unreadable, or of another shape - then everything counts as changed)."""
        try:
            marker = read_data_file(self.sweep_path(kind))
        except Exception:
            return None
        # A file of another shape (edited, another build of the mod) is no file at all (review #1).
        try:
            if not isinstance(marker, dict) or not isinstance(marker.get('stamp'), dict): return None
            for field in ('keys', 'failed', 'packages', 'parts'):
                value = marker.get(field, {})
                if not isinstance(value, dict): return None
                if field in ('keys', 'failed') and not all(isinstance(k, basestring_type) and isinstance(v, basestring_type) for k, v in value.items()): return None
                if field == 'parts' and not all(isinstance(v, list) for v in value.values()): return None
            if not isinstance(marker.get('extension', []), list): return None
            float(marker.get('startedAt') or 0); int(marker.get('built') or 0); float(marker.get('builtMs') or 0)
            int(marker.get('bytes') or 0)
        except Exception:
            return None
        return marker

    def write_sweep(self, kind, done=False):
        """The progress file. For the mod: the stamp, the keys of the sources every current file was built from, the
        failures (by the key they failed with), and the kind's own (TTX: the packages' cache; models: each built type's
        collision resources, the event packages' types). For the page: count/total/done, whether it runs (confirmed), how
        many of the catalogue it covers, the build time and bytes so far (models: the MB left from them; whether the user
        ever started it - 'opted' - and whether only failures are left), and 'estimate': the wall-clock seconds of what is
        left at this machine's measured pace ('pace', sweep_pace) - the one estimate, the page prints it. A sweep of the
        failed types alone is a completed one to the page (TTX: done from the start)."""
        if kind == 'verify':
            # No progress file of its own: what it did is in the characteristics' keys and the vehicle files' keys.
            if self.sweeps.get('verify') is not None:
                self.sweeps['verify']['reported'] = time.time()
                self.sweeps['verify']['dirty'] = False
            if self.ttx_state is not None: self.write_sweep('ttx', done=self.ttx_sweep is None)
            self.write_keys(force=True)
            return
        sweep, state = self.sweeps[kind], self.sweep_states[kind]
        if state is None: return
        if sweep is not None:
            done = bool(done or sweep['retry'])
            total = len(sweep['types']) if not sweep['retry'] else 0
            count = total if done else min(total, sweep['next'])
        else:
            done, total, count = True, 0, 0
        marker = {'stamp': self.sweep_stamp(kind), 'startedAt': state['started'], 'done': done, 'count': count,
                  'total': total, 'catalogue': state['catalogue'], 'confirmed': bool(sweep and sweep['confirmed']),
                  'retrying': bool(sweep and sweep['retry']), 'built': state['built'], 'builtMs': round(state['builtMs'], 1),
                  'keys': state['keys'], 'failed': state['failed'], 'incremental': state['now'] is not None, 'updatedAt': time.time()}
        ms, share = self.sweep_pace(kind)
        marker['pace'] = dict(state['pace'], target=SWEEP_SHARE)
        marker['estimate'] = 0 if done else int(math.ceil(max(0, total - count) * ms / share / 1000.0))
        if kind == 'ttx':
            marker['packages'] = state['packages']
        else:
            marker.update({'parts': state['parts'], 'extension': state['extension'], 'bytes': state['bytes'],
                           'opted': state['opted'], 'failedOnly': bool(sweep and sweep.get('failedOnly'))})
        # What a started sweep waits for (BACKLOG 55): the page says it instead of standing at the same count.
        wait = self.sweep_wait(kind) if sweep is not None and sweep['confirmed'] and not done else None
        if wait: marker['waiting'] = wait
        if sweep is not None:
            sweep['waitingFor'] = wait
            sweep['reported'] = time.time()
            sweep['dirty'] = False
        try:
            write_data(self.sweep_path(kind), SWEEP_FILES[kind][1], marker)
        except Exception:
            LOG.exception('%s sweep progress could not be written; the sweep starts over next time', SWEEP_LABELS[kind])

    def page_open(self):
        """The page is open in the game (the recorder's flag, set by the page's 'open' command)."""
        try:
            return float(getattr(self.recorder, 'page_open_until', 0) or 0) > time.time()
        except Exception:
            return False

    def confirm_sweep(self, kind='ttx'):
        """The page's Start ('sweepStart' with its kind, export thread): the sweep runs while the page is open."""
        sweep = self.sweeps.get(kind)
        if sweep is None or sweep['confirmed']: return False
        sweep['confirmed'] = True
        if kind == 'models': self.sweep_states[kind]['opted'] = True
        self.write_sweep(kind, done=False)
        return True

    def stop_sweep(self, kind='ttx'):
        """The page's Stop ('sweepStop', export thread; the page closed comes to the same): what is done stays and the next
        open of the page asks again. The retry of the failed types alone is not the page's to stop."""
        sweep = self.sweeps.get(kind)
        if sweep is None or not sweep['confirmed'] or sweep['retry']: return False
        sweep['confirmed'] = False
        sweep['sliced'] = False
        if self.recorder is not None:
            try: self.recorder.frames_wanted = False
            except Exception: pass
        self.write_sweep(kind, done=False)
        return True

    def sweep_gates_open(self, kind=None):
        """Work of a sweep may start now: no battle, no drag of the page, the page open, the mod not shutting down. The
        client change check ('verify') does not need the page: it rebuilds only what really changed (BACKLOG 55)."""
        if kind == 'verify': return not self.ttx_stopped and self.jobs_allowed()
        return not self.ttx_stopped and self.jobs_allowed() and self.page_open()

    def sweep_ready(self, kind):
        """A slice may run now: confirmed, the page open, nothing queued before it, jobs allowed, not shutting down.
        A page that has closed stops the sweep (stop_sweep). Before a sweep the user started (USER_SWEEPS) only the jobs
        above the background's (BACKLOG 55); the background check ('verify') waits for every job."""
        sweep = self.sweeps.get(kind)
        if sweep is None or not sweep['confirmed'] or self.ttx_stopped: return False
        if kind == 'verify': return bool(not self.jobs and self.jobs_allowed())
        if not self.page_open():
            self.stop_sweep(kind)
            return False
        return bool(not any(job[0] < JOB_BULK for job in self.jobs) and self.jobs_allowed())

    def sweep_wait(self, kind):
        """What a started sweep waits for now, for its progress file ('waiting', the page's "Waiting: ..."): a battle, or the
        jobs above the background's ({'for': 'jobs', 'jobs': {kind: count}}); None when nothing holds it (a drag the page
        knows itself)."""
        recorder = self.recorder
        try:
            if recorder is not None and getattr(recorder, 'in_battle', False): return {'for': 'battle'}
        except Exception:
            pass
        counts = {}
        for job in self.jobs:
            if job[0] < JOB_BULK: counts[job[2]] = counts.get(job[2], 0) + 1
        return {'for': 'jobs', 'jobs': counts} if counts else None

    def note_sweep_waits(self):
        """The progress file of a started sweep is written again when what it waits for changed (run_job, every turn)."""
        for kind in USER_SWEEPS:
            sweep = self.sweeps.get(kind)
            if sweep is None or not sweep['confirmed'] or self.sweep_states.get(kind) is None: continue
            if self.sweep_wait(kind) != sweep.get('waitingFor'): self.write_sweep(kind, done=False)

    def export_hurry(self):
        """The export loop's wait for a message (Writer.run_export): none while a sweep's slices run (sweep_hurry), and none
        once right after a job when another job the page waits for is queued (page_follow) - its jobs run back to back."""
        sweep = self.sweep_hurry()
        follow, self.page_follow = self.page_follow, False
        return sweep or bool(follow and self.jobs_allowed(True))

    def sweep_hurry(self):
        """The export loop's wait: none while a sweep's slices run - between two of them it rests itself (sweep_rest).
        The game's frame callback is wanted while a sweep is started and the page open, even when no slice may run this
        very moment (a drag, a click's job, 26.09): a chain that stops comes back only with the page's next 'open' (every
        4 s), and until then every frame waited for would be wait_frame's 0.1 s timeout."""
        ready = wanted = False
        for kind in SWEEP_ORDER:
            ready = self.sweep_ready(kind) or ready
            sweep = self.sweeps.get(kind)
            wanted = wanted or bool(sweep is not None and sweep['confirmed'])
        recorder = self.recorder
        if recorder is not None:
            try:
                wanted = wanted and not self.ttx_stopped and not getattr(recorder, 'in_battle', False) and self.page_open()
                recorder.frames_wanted = bool(ready or wanted)
            except Exception: pass
        return ready

    def wait_frame(self):
        """One frame of the game: the recorder's frame callback, 0.1 s at most. None offline."""
        wait = getattr(self.recorder, 'wait_frame', None)
        if wait is None: return
        try: wait(0.1)
        except Exception: pass

    def sweep_rest(self, sweep):
        """Between two slices, the game alone (SWEEP_SHARE): one frame of the game at least, then more frames while the
        game's share of the time since the slice ended asks for it (the slice * (1 - share) / share, SWEEP_REST_MAX at
        most); a gate that closes ends the rest (the next slice checks them anyway). How long that first frame took says
        how slow the game's frames are now: the next slice is made long enough that such a frame alone leaves the sweep
        its share, from TTX_SWEEP_SLICE up to SWEEP_SLICE_MAX. After a pause (the gates closed, a queued job: the slice
        ended over SWEEP_GAP_CAP ago) the frame is timed from now - timed from that slice it would be the pause, and the
        slices would grow to their maximum (review 26.09) - and the rest is already over. A command of the page waiting
        ends the rest too (sweep_waiting)."""
        start = TTX_TIMER()
        end = sweep['sliceEnd']
        if end is None: end = start
        base = end if start - end <= SWEEP_GAP_CAP else start
        self.wait_frame()
        frame = max(0.0, TTX_TIMER() - base)
        sweep['frame'] = frame if sweep['frame'] is None else 0.8 * sweep['frame'] + 0.2 * frame
        until = end + min(SWEEP_REST_MAX, sweep['last'] * (1.0 - SWEEP_SHARE) / SWEEP_SHARE)
        for _ in range(SWEEP_REST_WAITS):
            if TTX_TIMER() >= until or not self.sweep_gates_open(sweep.get('kind')) or self.sweep_waiting(): break
            self.wait_frame()
        sweep['slice'] = min(SWEEP_SLICE_MAX, max(TTX_SWEEP_SLICE, sweep['frame'] * SWEEP_SHARE / (1.0 - SWEEP_SHARE)))

    def sweep_waiting(self):
        """A command of the page (a vehicle, Stop) waits in the export loop's queue: the rest ends and no slice starts
        before it is read."""
        try:
            commands = self.recorder.writer.export_queue
            return not commands.empty()
        except Exception: return False

    def sweep_measure(self, kind, sweep, began):
        """A slice has ended (began: its TTX_TIMER start): its work, and the time since the slice before - the rest
        between them, unless the gates were closed meanwhile (a gap over SWEEP_GAP_CAP) - for the measured pace. From
        SWEEP_PACE_ITEMS built vehicles and slices of this session on, the progress file keeps this session's figures."""
        now = TTX_TIMER()
        spent = max(0.0, now - began)
        gap = began - sweep['sliceEnd'] if sweep['sliceEnd'] is not None else None
        sweep['workMs'] += spent * 1000.0
        sweep['wallMs'] += (spent + (gap if gap is not None and 0 <= gap <= SWEEP_GAP_CAP else 0.0)) * 1000.0
        sweep['slices'] += 1
        sweep['last'] = spent
        sweep['sliceEnd'] = now
        state = self.sweep_states.get(kind)
        if state is None: return
        if sweep['built'] >= SWEEP_PACE_ITEMS: state['pace']['ms'] = round(sweep['workMs'] / sweep['built'], 2)
        if sweep['slices'] >= SWEEP_PACE_ITEMS and sweep['wallMs'] > 0:
            state['pace']['share'] = round(min(1.0, max(0.02, sweep['workMs'] / sweep['wallMs'])), 3)

    def sweep_pace(self, kind):
        """(ms of work a vehicle, share of the time the work gets) for the estimate: this machine's measured figures
        (the progress file's 'pace', sweep_measure), else SWEEP_MS and SWEEP_SHARE."""
        pace = (self.sweep_states.get(kind) or {}).get('pace') or {}
        return pace.get('ms') or SWEEP_MS[kind], pace.get('share') or SWEEP_SHARE

    def run_sweeps(self):
        """One slice of the first sweep that is ready (SWEEP_ORDER: the characteristics before the models). Shutting down:
        the progress a sweep made since its last report is written once (the resume after the next start)."""
        if self.ttx_stopped:
            for kind in SWEEP_ORDER:
                if self.sweeps[kind] is not None and self.sweeps[kind].get('dirty'): self.write_sweep(kind)
            return False
        # The sweeps the user started take turns (BACKLOG 55: the models stood behind the whole characteristics sweep); the
        # one that ran last goes after the other. The next one rests from the last one's slice: the game keeps its share.
        order = list(USER_SWEEPS)
        if self.sweep_last in order: order.remove(self.sweep_last); order.append(self.sweep_last)
        for kind in order + [k for k in SWEEP_ORDER if k not in USER_SWEEPS]:
            if not self.sweep_ready(kind): continue
            last = self.sweeps.get(self.sweep_last) if self.sweep_last not in (None, kind) else None
            sweep = self.sweeps[kind]
            if last is not None and last.get('sliceEnd') is not None and (sweep['sliceEnd'] is None or last['sliceEnd'] > sweep['sliceEnd']):
                sweep['sliceEnd'], sweep['last'], sweep['sliced'] = last['sliceEnd'], last['last'], True
            if kind in USER_SWEEPS: self.sweep_last = kind
            return self.run_sweep(kind)
        return False

    def run_sweep(self, kind):
        """One slice: after the rest since the slice before (sweep_rest), steps back to back for up to a slice's seconds,
        every step behind the gates (review #5: a battle, a drag, a closing page or the mod shutting down (#6) ends the slice
        before the next one). A step is the kind's own unit of work on the type at 'next' (ttx_step, models_step); it says
        'built', 'current' or 'failed' when it is done with the type, 'partial' when the type needs more steps, None when
        the gates closed before it did anything. True when it did any work."""
        sweep = self.sweeps[kind]
        if sweep['sliced']:
            self.sweep_rest(sweep)
            # A gate closed or a command came during the rest (review 26.09): no slice now - it would read a file behind
            # a closed gate, or keep the page's click waiting a slice more. The rest is done; the next call slices at once.
            if not self.sweep_gates_open(kind) or self.sweep_waiting():
                sweep['sliced'] = False
                return False
        sweep['sliced'] = True
        if sweep['clock'] is None: sweep['clock'] = time.time()
        step = {'ttx': self.ttx_step, 'models': self.models_step, 'verify': self.verify_step}[kind]
        worked = False
        try:
            began, types = TTX_TIMER(), sweep['types']
            while sweep['next'] < len(types):
                type_name = types[sweep['next']]
                outcome = step(type_name, sweep)
                if outcome is None: break
                if outcome in ('built', 'partial'):
                    worked = True
                    sweep['dirty'] = True
                    self.last_job, self.job_rest = time.time(), PACE
                if outcome != 'partial':
                    sweep['next'] += 1
                    if outcome == 'built': sweep['built'] += 1
                    elif outcome == 'failed': sweep['failed'].append(type_name)
                    else: sweep['current'] += 1
                # A command of the page (a click's vehicle, Stop) ends the slice after this step, not after the slice's time.
                if TTX_TIMER() - began >= sweep['slice'] or self.sweep_waiting(): break
            else:
                self.sweep_measure(kind, sweep, began)
                self.finish_sweep(kind)
                return worked
            self.sweep_measure(kind, sweep, began)
            if time.time() - sweep['reported'] >= TTX_SWEEP_REPORT: self.write_sweep(kind, done=False)
        except Exception:
            self.sweeps[kind] = None
            LOG.exception('%s sweep stopped; the page still asks for each vehicle it opens', SWEEP_LABELS[kind])
        return worked

    def finish_sweep(self, kind):
        sweep = self.sweeps[kind]
        self.sweeps[kind] = None
        state = self.sweep_states[kind]
        if kind == 'ttx' and state is not None and state['now'] is None:
            # The fallback keeps its failures by name, with no key.
            state['failed'] = dict((t, '') for t in sweep['failed'])
        if kind in ('models', 'verify'): self.catalogue_dirty = True
        # The check ran to its end: what it was asked for is done (data/verify.json).
        if kind == 'verify':
            pending = self.verify_state()
            pending['pending'], pending['everything'] = [], False
            if sweep.get('stand'): pending['stand'] = STAND_CLIENT
            self.write_verify_state()
        # The modules its builds executed outside the stand's set (recorded_build): watched.
        self.flush_code_seen()
        self.write_sweep(kind, done=True)
        if self.recorder is not None:
            try: self.recorder.frames_wanted = False
            except Exception: pass
        # The pace too (26.09): what the estimate of the next run starts from, and what SWEEP_SHARE is tuned by.
        LOG.info('%s sweep: %d types - %d built (%.0f ms), %d current, %d failed%s; %.0f s of work, %.0f s from its start this session; '
                 '%.1f ms of work a built vehicle, the work %.0f %% of the time while it ran (SWEEP_SHARE %.0f %%), %d slices, '
                 'the last %.0f ms long, a frame %.0f ms',
                 SWEEP_LABELS[kind], len(sweep['types']), sweep['built'], sweep['buildMs'], sweep['current'], len(sweep['failed']),
                 ' (first: %s)' % sweep['error'] if sweep['error'] else '', sweep['workMs'] / 1000.0,
                 time.time() - (sweep['clock'] or time.time()), sweep['workMs'] / max(1, sweep['built']),
                 100.0 * sweep['workMs'] / max(1e-9, sweep['wallMs']), 100.0 * SWEEP_SHARE, sweep['slices'],
                 1000.0 * sweep['last'], 1000.0 * (sweep['frame'] or 0.0))
        if kind == 'verify':
            changed, missed = sweep.get('changed') or [], sweep.get('missed') or []
            LOG.info('Client change check: %d files built again and compared - %d differed and were written%s%s',
                     len(sweep['types']), len(changed), ' (%s)' % ', '.join(changed[:5]) if changed else '',
                     '; missed change: %s' % ', '.join(missed[:5]) if missed else '')
        if kind == 'models' and self.model_ms:
            times = sorted(self.model_ms)
            LOG.info('Model sweep: %d collision models extracted, %.1f ms median, %.1f ms p90, %.1f ms max (read, parse, write)',
                     len(times), times[len(times) // 2], times[min(len(times) - 1, int(0.9 * len(times)))], times[-1])
            self.model_ms = []

    def new_sweep(self, types, retry=False, confirmed=False):
        """The run state of a sweep over `types` (the progress file's count is 'next')."""
        return {'types': types, 'retry': retry, 'confirmed': confirmed, 'next': 0, 'clock': None, 'built': 0, 'current': 0,
                'failed': [], 'error': None, 'buildMs': 0.0, 'workMs': 0.0, 'reported': 0.0, 'sliced': False, 'dirty': False,
                # The pace (sweep_rest, sweep_measure): the slices' time with the rests between them, how many, the last
                # slice's length and its end, the game's frame (smoothed) and the length of the next slice.
                'wallMs': 0.0, 'slices': 0, 'sliceEnd': None, 'last': 0.0, 'frame': None, 'slice': TTX_SWEEP_SLICE}

    def sweep_state(self, kind, marker, catalogue):
        """The progress file's state this session, from its marker (keys, failures, build time so far, the pace)."""
        state = {'catalogue': catalogue, 'started': time.time(), 'built': 0, 'builtMs': 0.0, 'now': None,
                 'keys': dict(marker.get('keys') or {}), 'failed': dict(marker.get('failed') or {}),
                 'packages': dict(marker.get('packages') or {}), 'parts': dict(marker.get('parts') or {}),
                 'extension': list(marker.get('extension') or []), 'bytes': 0, 'opted': bool(marker.get('opted')), 'bases': None}
        try:
            state['built'], state['builtMs'] = int(marker.get('built') or 0), float(marker.get('builtMs') or 0)
            state['bytes'] = int(marker.get('bytes') or 0)
        except (TypeError, ValueError):
            pass
        # The measured pace of an earlier session (sweep_measure); a share measured under another SWEEP_SHARE is not
        # this build's, and a value of another shape is none.
        state['pace'] = {}
        pace = marker.get('pace')
        if isinstance(pace, dict):
            try:
                ms, share = float(pace.get('ms') or 0), float(pace.get('share') or 0)
                if 0 < ms < 1e6: state['pace']['ms'] = ms
                if 0 < share <= 1 and pace.get('target') == SWEEP_SHARE: state['pace']['share'] = share
            except (TypeError, ValueError):
                pass
        self.sweep_states[kind] = state
        return state

    # ---- The sources' keys (24.09, user: "do not do the work twice"): a type is built again only when a file it is read
    # from changed. Their CRCs come from the client's snapshot (BACKLOG 55: client_snapshot, the packages' central
    # directories and the overrides); the client's code is not a source of a type but of all of them (code_generation).
    def source_crcs(self):
        """{path: crc} of the characteristics' data sources in this client (source_crcs_of), once a session. Raises without a
        snapshot or without any source in it."""
        if self.crcs is None:
            files = self.client_files()
            if files is None: raise ValueError('Client files unreadable')
            crcs = self.source_crcs_of(files)
            if not any(name.startswith('scripts/') for name in crcs): raise ValueError('No characteristics sources in the client packages')
            self.crcs = crcs
        return self.crcs

    @staticmethod
    def source_crcs_of(files):
        """{path: crc} of the data the characteristics and vehicle files are built from, in a client's files: every vehicle's
        own XML and its nation's files (TTX_SOURCE without the code), of the vehicles' common files only those a build opens
        (SHARED_DATA; an event package's all of them), what items reads at its start, and the texts the builds translate from.
        An unknown CRC (a derived snapshot) is '?'."""
        shared = set(SHARED_DATA) | set('res/text/lc_messages/%s.mo' % d for d in TEXT_DOMAINS)
        crcs = {}
        for name, entry in files.items():
            if name in shared or (TTX_SOURCE.match(name) and not name.endswith('.pyc')
                                  and not name.startswith('scripts/item_defs/vehicles/common/')):
                crcs[name] = '?' if entry[0] < 0 else '%08x' % entry[0]
        return crcs

    def sources_unknown(self):
        """Some data source of the characteristics has an unknown CRC now (its package left out of the snapshot)."""
        try:
            return any(value == '?' for value in self.source_crcs().values())
        except Exception:
            return False

    def ttx_keys(self, types):
        """{type: '<data>.<generation>'}: the type's data sources (ttx_source_keys with TTX_FORMAT) and the client's code."""
        generation = self.code_generation() or '-'
        return dict((t, '%s.%s' % (k, generation)) for t, k in self.ttx_source_keys(types, self.source_crcs()).items())

    @staticmethod
    def key_change(stored, now):
        """Which part of a key changed, for the log: 'no earlier key', 'vehicle data', 'client code', 'its models'."""
        if not stored or stored.count('.') != now.count('.'): return 'no earlier key'
        old, new = stored.split('.'), now.split('.')
        names = ('vehicle data', 'client code', 'its models')
        return ' and '.join(names[i] for i in range(len(new)) if old[i] != new[i]) or 'nothing'

    @staticmethod
    def split_sources(crcs):
        """The source files by what they are to a type: (shared {root: [line]}, the nations' {(root, nation): [line]}, each
        nation's own vehicle files {nation: [(file, root, line)]}). A root is '' for the client's scripts.pkg, '<event>/'
        for an event's own package."""
        shared, nation_files, own = {}, {}, {}
        for name in sorted(crcs):
            if 'scripts/' not in name:
                # A file outside the scripts (system/data, gui, the texts): shared by every type.
                shared.setdefault('', []).append(name + '=' + crcs[name])
                continue
            at = name.index('scripts/')
            root, rest = name[:at], name[at + len('scripts/'):]
            line = rest + '=' + crcs[name]
            if not rest.startswith('item_defs/vehicles/'):
                shared.setdefault(root, []).append(line)
                continue
            parts = rest[len('item_defs/vehicles/'):].split('/')
            if len(parts) == 1 or parts[0] == 'common':
                shared.setdefault(root, []).append(line)
            elif len(parts) == 2 and parts[1] != 'list.xml':
                own.setdefault(parts[0], []).append((parts[1], root, line))
            else:
                nation_files.setdefault((root, parts[0]), []).append(line)
        return shared, nation_files, own

    def ttx_source_keys(self, types, crcs, format_tag=None):
        """{type: key}: the format (TTX_FORMAT; the model sweep passes its own), the files every type is read with (the
        client's items code, the vehicles' common files - TTX_SOURCE_SKIP leaves out what no characteristic depends on), its
        nation's (components, list.xml) and its own XML (every file of its nation whose name begins with its own - a variant
        too: more rebuilds, never fewer). A type from an extension package (an event's) takes that package's common and
        nation files too. The client's code is not here (ttx_keys, vehicle_key add code_generation)."""
        # One split per sources' table (this client's, and an earlier client's for a proof): both are kept.
        caches = getattr(self, 'split_caches', None)
        if caches is None: caches = self.split_caches = {}
        cached = caches.get(id(crcs))
        if cached is None or cached[0] is not crcs:
            cached = caches[id(crcs)] = (crcs, self.split_sources(crcs))
        shared, nation_files, own = cached[1]
        keys, bases = {}, {}
        for type_name in types:
            nation, _, name = type_name.partition(':')
            mine = [(root, line) for base, root, line in own.get(nation, ()) if base.startswith(name) and base[len(name):len(name) + 1] in ('.', '_')]
            roots = tuple(sorted(set([''] + [root for root, line in mine])))
            # The shared part of a nation's types is the same text: its CRC once, the start value of each type's own.
            if (roots, nation) not in bases:
                text = ['format=%s' % (TTX_FORMAT if format_tag is None else format_tag)]
                for root in roots:
                    text.extend(shared.get(root, ()))
                    text.extend(nation_files.get((root, nation), ()))
                bases[(roots, nation)] = zlib.crc32('\n'.join(text).encode('utf-8'))
            own_text = '\n'.join(sorted(line for root, line in mine)).encode('utf-8')
            keys[type_name] = '%08x' % (zlib.crc32(own_text, bases[(roots, nation)]) & 0xffffffff)
        return keys

    def extension_types(self, types, crcs):
        """The types whose own XML exists only in an event's package (Story Mode, Last Stand, White Tiger...): the model
        sweep leaves them out, tagged or not (nine Story Mode vehicles carry no mode tag)."""
        own = self.split_sources(crcs)[2]
        found = []
        for type_name in types:
            nation, _, name = type_name.partition(':')
            roots = set(root for base, root, line in own.get(nation, ()) if base == name + '.xml')
            if roots and '' not in roots: found.append(type_name)
        return found

    # ---- the characteristics (TTX)
    def start_ttx_sweep(self, rows):
        """Setup: which catalogue types need their file built, and the sweep over them - not running until the page's
        Start of this session. Nothing outside the game (no client item modules). The sources' keys (ttx_keys, from the
        client's snapshot): a type without a file is the sweep's; one that failed with the same key is retried without
        asking; one with a file whose key changed is checked in the background (ttx_stale -> start_verify: built again,
        written only when different - BACKLOG 55). Keys unavailable: every file is checked, one log line."""
        self.ttx_sweep = None
        self.ttx_state = None
        old = os.path.join(self.folder, TTX_SWEEP_OLD)
        if os.path.isfile(old):
            try: os.remove(old)
            except Exception: pass
        try:
            from items import vehicles as client_vehicles
            client_vehicles.g_list
        except Exception:
            return None
        catalogue, seen = [], set()
        for row in rows or ():
            type_name = str(row.get('type') or '')
            if ':' in type_name and IDENTIFIER.match(vehicle_id(type_name)) and type_name not in seen:
                seen.add(type_name)
                catalogue.append(type_name)
        marker = self.sweep_marker('ttx') or {}
        same = marker.get('stamp') == self.sweep_stamp('ttx')
        state = self.sweep_state('ttx', marker, len(catalogue))
        started = TTX_TIMER()
        try:
            state['now'] = self.ttx_keys(catalogue)
        except Exception as error:
            state['now'] = None
            LOG.warning('TTX sources unreadable (%r): every file is built again and compared', error)
        known = set(catalogue)
        state['keys'] = dict((t, k) for t, k in state['keys'].items() if t in known)
        missing = [t for t in catalogue if not os.path.isfile(self.ttx_path(t))]
        if state['now'] is not None:
            now = state['now']
            # A failure with another key is a change like any other: the type is tried as one without a file.
            state['failed'] = failed = dict((t, k) for t, k in state['failed'].items() if now.get(t) == k)
            stale = [t for t in catalogue if t not in missing and state['keys'].get(t) != now.get(t)]
            # Sources unreadable now (a package left out of the snapshot: CRCs unknown): nothing is taken for changed by
            # them - looked at again next start (second review G); what is missing is still built.
            if self.sources_unknown():
                LOG.warning('TTX sources: some client files unreadable now - no file is checked by its data this session')
                stale = []
            # A file of 0.9.3 (no key of this kind) or of an earlier client: kept when that client had its very inputs (proven).
            for type_name in list(stale):
                if state['keys'].get(type_name) is not None and state['keys'].get(type_name).count('.') == now[type_name].count('.'):
                    continue
                try:
                    value = read_data_file(self.ttx_path(type_name))
                    ok = value.get('format', 1) == TTX_FORMAT and self.proven(type_name, value.get('clientVersion'))
                except Exception:
                    ok = False
                if ok:
                    state['keys'][type_name] = now[type_name]
                    stale.remove(type_name)
        else:
            failed = dict((t, '') for t in (marker.get('failed') or {}) if t in known) if same else {}
            state['failed'] = failed
            # No snapshot: what this very client checked (the fallback key) is current, nothing else (review 02.10 #1a).
            stale = [t for t in catalogue if t not in missing and state['keys'].get(t) != self.fallback_key()]
        types = [t for t in missing if t not in failed]
        retry = [t for t in catalogue if t in failed]
        # Those with a file whose key changed: built again and compared in the background (start_verify), not a question.
        self.ttx_stale = [t for t in stale if t not in failed]
        if same and marker.get('startedAt') and not marker.get('done'):
            try: state['started'] = float(marker['startedAt'])
            except (TypeError, ValueError): pass
        LOG.info('TTX sources: %d of %d types to build, %d to retry, %d to check in the background (%s, %.0f ms)', len(types),
                 len(catalogue), len(retry), len(self.ttx_stale), 'by their files' if state['now'] is not None else 'no keys',
                 (TTX_TIMER() - started) * 1000.0)
        if not types and not retry:
            self.write_sweep('ttx', done=True)
            return None
        # A sweep the page asks for takes the failed types along; the failed types alone are retried without asking.
        self.ttx_sweep = self.new_sweep(types + retry if types else retry, retry=not types, confirmed=not types)
        self.write_sweep('ttx', done=False)
        return self.ttx_sweep

    def ttx_key_done(self, type_name, ok):
        """The file of a type was just written (ok) or failed: its key goes to the progress file's keys or failures."""
        state = self.ttx_state
        if state is None: return
        if state['now'] is None: key = self.fallback_key()
        elif type_name not in state['now']: return
        else: key = state['now'][type_name]
        if ok:
            state['keys'][type_name] = key
            state['failed'].pop(type_name, None)
        else:
            state['failed'][type_name] = key

    def ttx_fresh(self, type_name, started):
        """The fallback's resume: a file written since this sweep began is current without a read."""
        try:
            return os.path.getmtime(self.ttx_path(type_name)) >= started
        except OSError:
            return False

    def ttx_step(self, type_name, sweep):
        """The TTX sweep's step: one type's file checked and, when needed, built (build_ttx)."""
        state = self.ttx_state
        known = self.ttx_known.get(type_name)
        if known is None and state['now'] is None and self.ttx_fresh(type_name, state['started']):
            self.ttx_known[type_name] = known = TTX_CURRENT
        if known == TTX_FAILED: return 'failed'
        if known == TTX_CURRENT: return 'current'
        if not self.sweep_gates_open(): return None
        started = TTX_TIMER()
        if self.recorded_build(self.build_ttx, type_name, sweep):
            ms = (TTX_TIMER() - started) * 1000.0
            sweep['buildMs'] += ms
            state['built'] += 1
            state['builtMs'] += ms
            return 'built'
        return 'failed' if self.ttx_known.get(type_name) == TTX_FAILED else 'current'

    # ---- THE CLIENT CHANGE CHECK (BACKLOG 55): the files whose key changed - the characteristics of ttx_stale, the vehicle
    # files whose vehicle_key is not the one kept; a file of 0.9.3 or of an earlier client whose inputs that client's snapshot
    # proves the same is kept without a build (proven) - built again and compared in the background (the 'verify' kind: after
    # every job and every sweep the user started, no page needed, never in a battle or a drag, the game's share of the time
    # between slices); a file is written only where the result differs. When the game's exe or client code outside the code
    # set changed (code_samples), a few files whose keys held are built and compared too (VERIFY_SAMPLE_*): one that differs is
    # a change the keys missed - written, named in the log ('Missed change'), and every file joins the check.
    def start_verify(self):
        self.sweeps['verify'] = None
        items, reasons = [], {}
        state = self.ttx_state or {}
        now = state.get('now') or {}
        for type_name in self.ttx_stale or ():
            items.append('ttx:' + type_name)
            why = self.key_change((state.get('keys') or {}).get(type_name), now[type_name]) if type_name in now else 'no keys'
            reasons['characteristics: ' + why] = reasons.get('characteristics: ' + why, 0) + 1
        snapshot = self.client()
        stored = self.vehicle_keys() if snapshot is not None else {}
        unknown = snapshot is not None and self.sources_unknown()
        for identifier in sorted(self.vehicles):
            summary = self.vehicles[identifier]
            if unknown: break   # the client's files unreadable now: no vehicle file is judged by them (second review G)
            # A file a migration exports again from its own request (load_vehicles: no hash) is that job's.
            if summary.get('descriptorHash') is None or self.vehicle_current(summary): continue
            if not os.path.isfile(os.path.join(self.folder, 'data', 'vehicles', identifier + '.js')): continue
            # A file of 0.9.3 (no key) or of an earlier client whose inputs were these very files: its key is kept, no build.
            if snapshot is not None and identifier not in stored and self.proven(summary.get('type'), summary.get('clientVersion'), summary):
                self.keep_vehicle_key(summary)
                continue
            items.append('vehicle:' + identifier)
            try: why = self.key_change(stored.get(identifier), self.vehicle_key(summary))
            except Exception: why = 'no keys'
            reasons['vehicle files: ' + why] = reasons.get('vehicle files: ' + why, 0) + 1
        if snapshot is not None:
            self.code_generation()
        # The types whose stand output changed for this client (STAND_CHANGED): rebuilt once, whatever their keys say.
        pending = self.verify_state()
        if snapshot is not None and STAND_CHANGED and STAND_CLIENT == snapshot.label() and pending.get('stand') != STAND_CLIENT:
            for type_name in STAND_CHANGED:
                if os.path.isfile(self.ttx_path(type_name)) and 'ttx:' + type_name not in items: items.append('stand-ttx:' + type_name)
                identifier = vehicle_id(type_name)
                if identifier in self.vehicles and 'vehicle:' + identifier not in items: items.append('stand-vehicle:' + identifier)
            reasons['changed on the stand'] = len(STAND_CHANGED)
        if snapshot is not None and self.code_samples:
            import random
            chance = random.Random(snapshot.id)
            held = sorted(t for t in now if 'ttx:' + t not in items and os.path.isfile(self.ttx_path(t)))
            items.extend('sample-ttx:' + t for t in sorted(chance.sample(held, min(VERIFY_SAMPLE_TTX, len(held)))))
            held = sorted(i for i in self.vehicles if 'vehicle:' + i not in items and self.vehicles[i].get('descriptorHash')
                          and os.path.isfile(os.path.join(self.folder, 'data', 'vehicles', i + '.js')))
            items.extend('sample-vehicle:' + i for i in sorted(chance.sample(held, min(VERIFY_SAMPLE_VEHICLES, len(held)))))
        if not items and not pending.get('everything'):
            if pending.get('pending'):
                pending['pending'] = []
                self.write_verify_state()
            return None
        sweep = self.sweeps['verify'] = self.new_sweep(items, confirmed=True)
        sweep.update({'kind': 'verify', 'changed': [], 'missed': [], 'stand': bool(STAND_CHANGED and pending.get('stand') != STAND_CLIENT)})
        # A 'Missed change' of an earlier session that did not run to its end: every file still.
        if pending.get('everything'): self.verify_everything(sweep)
        LOG.info('Client change check: %d files to build again and compare in the background, written only where they differ '
                 '(%s; %d samples of unchanged keys%s)', len(items),
                 ', '.join('%s %d' % (why, count) for why, count in sorted(reasons.items())) or 'no key changed',
                 len([i for i in items if i.startswith('sample-')]),
                 ': ' + '; '.join(self.code_samples) + ' changed' if self.code_samples else '')
        return sweep

    def verify_step(self, item, sweep):
        """The check's step on one file: 'ttx:<type>' or 'vehicle:<id>' (a sample: 'sample-...', built whatever its key)."""
        kind, _, name = item.partition(':')
        sample = kind.startswith('sample-')
        forced = sample or kind.startswith('stand-')
        if not self.sweep_gates_open('verify'): return None
        try:
            if kind.endswith('ttx'):
                if not forced and self.ttx_current(name):
                    self.ttx_known[name] = TTX_CURRENT
                    return 'current'
                written = self.recorded_build(self.build_ttx, name, sweep, force=True)
                if self.ttx_known.get(name) == TTX_FAILED: return 'failed'
            else:
                summary = self.vehicles.get(name)
                path = os.path.join(self.folder, 'data', 'vehicles', name + '.js')
                if not summary or not os.path.isfile(path): return 'current'
                if not forced and self.vehicle_current(summary): return 'current'
                request = migration_request(read_data_file(path))
                if not request.get('compactDescriptor') or not request.get('vehicleType'): return 'failed'
                written = self.recorded_build(self.export_vehicle, dict(request, replay=True), replay=True, verify=True)
        except Exception as error:
            sweep['error'] = sweep['error'] or '%s: %r' % (item, error)
            return 'failed'
        if written:
            sweep['changed'].append(name)
            if sample:
                sweep['missed'].append(name)
                LOG.warning('Missed change: %s differed from its file although its key did not change - written; the keys '
                            'miss an input of it: every file is built and compared now', name)
                self.verify_everything(sweep)
        return 'built'

    def verify_everything(self, sweep):
        """A sample differed (a change the keys missed): every characteristics and vehicle file joins the check, once - and
        until that check ran to its end, from start to start (data/verify.json)."""
        if sweep.get('everything'): return
        sweep['everything'] = True
        pending = self.verify_state()
        if not pending.get('everything'):
            pending['everything'] = True
            self.write_verify_state()
        listed = set(sweep['types'])
        for type_name in sorted((self.ttx_state or {}).get('now') or ()):
            if os.path.isfile(self.ttx_path(type_name)) and 'ttx:' + type_name not in listed and 'sample-ttx:' + type_name not in listed:
                sweep['types'].append('sample-ttx:' + type_name)
        for identifier in sorted(self.vehicles):
            if 'vehicle:' + identifier not in listed and 'sample-vehicle:' + identifier not in listed and os.path.isfile(
                    os.path.join(self.folder, 'data', 'vehicles', identifier + '.js')):
                sweep['types'].append('sample-vehicle:' + identifier)

    # ---- the collision models (25.09, BACKLOG 51). Every regular vehicle of the catalogue - no battle-mode vehicle
    # (modeOnly), no event package's, no onboarding or Story Mode copy (MODELS_SKIP_NAME) - exported by the one vehicle
    # export (export_vehicle) in its top configuration, as the per-click path exports a vehicle the player does not own.
    # Only after the user's Start (the page's Export all models), and only the vehicles WITHOUT a file (BACKLOG 55): a file
    # whose key changed with the client is built again and compared in the background (start_verify), whoever wrote it. A file
    # of the player's own (the hangar, a battle, a click: any other source) is never replaced by the top configuration.
    def models_key_safe(self, type_name, resources):
        """The key a failure of the sweep is kept with (models_failed): the vehicle key of its type and models, or None."""
        try:
            return self.vehicle_key({'type': type_name, 'parts': [{'resource': r} for r in resources or ()]})
        except Exception:
            return None

    def models_current(self, type_name):
        """The model sweep has nothing to do for this type: not failed, and it has a file (whose key, changed or not, is the
        background check's - start_verify)."""
        state = self.sweep_states['models']
        if type_name in state['failed']: return False
        identifier = vehicle_id(type_name)
        summary = self.vehicles.get(identifier)
        # A file on disk that setup could not read (a lock of an antivirus or a backup) may be the player's own: it is
        # left alone this session rather than overwritten with the top configuration (review 25.09).
        return bool(summary) or os.path.exists(os.path.join(self.folder, 'data', 'vehicles', identifier + '.js'))

    def start_models_sweep(self, rows):
        """Setup: the plan of the model sweep - never running before the page's Start. Nothing outside the game. The same
        client files and format, done, nothing failed: nothing is read. Otherwise the regular types (event packages from the
        sources' CRCs, once a client) without a file, and the failed ones (BACKLOG 55: a file whose key changed is the
        background check's, start_verify - not a question to the user)."""
        self.sweeps['models'] = None
        self.sweep_states['models'] = None
        try:
            from items import vehicles as client_vehicles
            client_vehicles.g_list
        except Exception:
            return None
        marker = self.sweep_marker('models') or {}
        same = marker.get('stamp') == self.sweep_stamp('models')
        state = self.sweep_state('models', marker, int(marker.get('catalogue') or 0) if same else 0)
        state['regular'] = []
        if same and marker.get('done') and not marker.get('failed'): return None
        started = TTX_TIMER()
        if not same:
            state['keys'], state['extension'] = {}, []
            # A failure stays one across a client change (retried on the user's Start); a format raised forgets them.
            if (marker.get('stamp') or {}).get('format') != MODELS_FORMAT: state['failed'] = {}
        catalogue = [row for row in rows or () if ':' in str(row.get('type') or '') and IDENTIFIER.match(vehicle_id(row['type']))]
        crcs = None
        if not same:
            try:
                crcs = self.source_crcs()
                state['extension'] = self.extension_types([str(row['type']) for row in catalogue], crcs)
            except Exception as error:
                LOG.warning('Model sweep: the client packages could not be read (%r); event vehicles are told by their tags only', error)
        extension = set(state['extension'])
        seen = set()
        for row in catalogue:
            type_name = str(row['type'])
            if type_name in seen or not regular_vehicle(row, extension): continue
            seen.add(type_name)
            state['regular'].append(type_name)
        state['catalogue'] = len(state['regular'])
        state['parts'] = dict((t, v) for t, v in state['parts'].items() if t in state['keys'] or t in state['failed'])
        types = [t for t in state['regular'] if not self.models_current(t)]
        failed_only = bool(types) and all(t in state['failed'] for t in types)
        if not same and marker.get('startedAt') and not marker.get('done'):
            try: state['started'] = float(marker['startedAt'])
            except (TypeError, ValueError): pass
        LOG.info('Model sweep: %d of %d regular vehicles to export%s (%.0f ms)', len(types), len(state['regular']),
                 ', all of them failed before' if failed_only else '', (TTX_TIMER() - started) * 1000.0)
        if not types:
            self.write_sweep('models', done=True)
            return None
        self.sweeps['models'] = sweep = self.new_sweep(types)
        sweep['failedOnly'] = failed_only
        sweep['work'] = None
        self.write_sweep('models', done=False)
        return sweep

    def models_step(self, type_name, sweep):
        """The model sweep's step on one type, one unit of work at a time so that a frame of the game passes between two of
        them: the plan (its top configuration's descriptor and collision resources), each collision model (model_extract,
        the one extraction; 10 ms median, 48 ms p99 offline since 28.09 - 76 ms and 1.1 s before), then the vehicle file
        itself (export_vehicle, which finds its models written). A failure of any unit is this vehicle's (by its key), the sweep goes on."""
        state = self.sweep_states['models']
        work = sweep.get('work')
        if work is not None and work['type'] != type_name: work = sweep['work'] = None
        # Current by now - a click exported it meanwhile, the player's own configuration: nothing more, never overwritten.
        if self.models_current(type_name):
            sweep['work'] = None
            return 'current'
        if work is None:
            if not self.sweep_gates_open(): return None
            started = TTX_TIMER()
            try:
                import base64
                descr = top_descriptor(type_name)
                compact = base64.b64encode(descr.makeCompactDescr()).decode('ascii')
                resources = [r for r in (part_resource(component) for _, _, component in static_parts(descr)) if r]
            except Exception as error:
                return self.models_failed(type_name, sweep, error, None)
            sweep['work'] = {'type': type_name, 'descr': descr, 'resources': resources, 'next': 0, 'bytes': 0,
                             'ms': (TTX_TIMER() - started) * 1000.0,
                             'request': {'schema': 1, 'type': 'vehicle', 'vehicleType': type_name, 'source': 'catalogue',
                                         'compactDescriptor': compact, 'requestedAt': time.time()}}
            return 'partial'
        if not self.sweep_gates_open(): return None
        started = TTX_TIMER()
        if work['next'] < len(work['resources']):
            resource = work['resources'][work['next']]
            work['next'] += 1
            try:
                key = self.model_ref(resource, self.version)
                path = os.path.join(self.folder, 'data', 'models', key + '.js')
                existed = os.path.isfile(path)
                self.model_extract(resource, self.version)
                if not existed and os.path.isfile(path): work['bytes'] += os.path.getsize(path)
            except Exception:
                pass   # an invalid resource: export_vehicle names it on its part
            work['ms'] += (TTX_TIMER() - started) * 1000.0
            return 'partial'
        sweep['work'] = None
        try:
            self.export_vehicle(work['request'], sweep=True, descr=work['descr'])
            identifier = vehicle_id(type_name)
            record_path = os.path.join(self.folder, 'data', 'vehicles', identifier + '.js')
            work['bytes'] += os.path.getsize(record_path)
        except Exception as error:
            return self.models_failed(type_name, sweep, error, work['resources'])
        ms = work['ms'] + (TTX_TIMER() - started) * 1000.0
        sweep['buildMs'] += ms
        state['built'] += 1
        state['builtMs'] += ms
        state['bytes'] += work['bytes']
        errors = [] if work['resources'] else ['no collision parts']
        for resource in work['resources']:
            try: error = self.attempts.get(self.model_ref(resource, self.version), 'not extracted')
            except Exception as exc: error = str(exc)
            if error: errors.append(error)
        if errors: return self.models_failed(type_name, sweep, errors[0], work['resources'])
        key = self.models_key_safe(type_name, work['resources'])
        state['parts'][type_name] = list(work['resources'])
        state['failed'].pop(type_name, None)
        if key is not None: state['keys'][type_name] = key
        return 'built'

    def models_failed(self, type_name, sweep, error, resources):
        """One vehicle of the model sweep failed: by its key (tried again when the user starts the sweep again), the first
        error named in the sweep's one log line."""
        state = self.sweep_states['models']
        sweep['error'] = sweep['error'] or '%s: %s' % (type_name, error)
        key = self.models_key_safe(type_name, resources) if resources else None
        state['failed'][type_name] = key or ''
        state['keys'].pop(type_name, None)
        if resources: state['parts'][type_name] = list(resources)
        return 'failed'

    def catalogue_rows(self):
        """Every vehicle of the client, with the exported ones flagged.

        Built from items.vehicles.g_list, which the export thread can import (the
        recorded-hit enrichment already proves it). Outside the game the module is
        missing: the catalogue then holds only the vehicles that were exported.
        """
        rows, seen = [], set()
        try:
            import nations
            from items import vehicles as client_vehicles
            labels = role_labels()
            for nation_id, nation in enumerate(nations.NAMES):
                try:
                    listing = client_vehicles.g_list.getList(nation_id)
                except Exception:
                    listing = None
                if not listing: continue
                for item in listing.values():
                    try:
                        entry = catalogue_entry(str(nation), item, labels)
                    except Exception:
                        entry = None
                    if entry is None or entry['id'] in seen: continue
                    seen.add(entry['id'])
                    rows.append(entry)
        except Exception:
            LOG.warning('Client vehicle list unavailable; the catalogue holds exported vehicles only')
        for identifier in sorted(self.vehicles):
            if identifier in seen: continue
            summary = self.vehicles[identifier]
            rows.append(dict((key, summary.get(key)) for key in
                             ('id', 'type', 'name', 'level', 'class', 'role', 'nation',
                              'premium', 'collector', 'special')))
            seen.add(identifier)
        for entry in rows:
            if entry.get('role') is None: entry.pop('role', None)
        self.flag_rows(rows)
        rows.sort(key=lambda e:(e.get('nation') or '', -(e.get('level') or 0), e.get('name') or ''))
        return rows

    def flag_rows(self, rows):
        """The export flags of catalogue rows: 'exported' when the vehicle has a file (BACKLOG 55), and
        'regular': false on a vehicle no player has in the hangar (regular_vehicle) - the page's list leaves it out."""
        extension = set((self.sweep_states.get('models') or {}).get('extension') or ())
        for entry in rows:
            if regular_vehicle(entry, extension): entry.pop('regular', None)
            else: entry['regular'] = False
            summary = self.vehicles.get(entry['id'])
            # A file is there (BACKLOG 55: not "a file of this client version" - 817 vehicles exported on 28.09 showed as not
            # exported after 02.10's update; a file whose key changed is checked in the background and kept when the same).
            entry['exported'] = bool(summary)
            # A file this start found out of date (27.09: a wheeled type without its wheels, a prefab type without its
            # prefabs, a missing extra track pair) and exports again: the page asks for it at once when it is opened,
            # as for a vehicle without a file, and never shows the old one.
            if entry['exported'] and summary.get('descriptorHash') is None: entry['outdated'] = True
            else: entry.pop('outdated', None)
            entry['exportedAt'] = summary.get('exportedAt') if summary else None
            entry['source'] = summary.get('source') if summary else None
        return rows

    def write_catalogue(self, force=False, rows=None):
        """data/vehicles.js. Rebuilt at setup and after every vehicle export.

        The rebuild walks the whole client list, which is fine once per exported
        vehicle but not a thousand times in a row: while the model sweep runs it is
        written by the idle tick at most every SWEEP_CATALOGUE_PAUSE seconds, inside
        the page's poll. A hangar or battle export writes at once. `rows`: setup's,
        already built. Returns the rows written, None when the write was deferred.
        """
        self.catalogue_dirty = True
        sweep = self.sweeps.get('models')
        if (not force and sweep is not None and sweep['confirmed']
                and time.time()-self.catalogue_written < SWEEP_CATALOGUE_PAUSE): return None
        if rows is None: rows = self.catalogue_rows()
        write_data(os.path.join(self.folder, 'data', 'vehicles.js'), 'vehicles',
                   {'application':'local.armor_inspector', 'clientVersion':self.version,
                    'updatedAt':time.time(), 'vehicles':rows})
        self.catalogue_dirty = False
        self.catalogue_written = time.time()
        return rows
