"""Lossless armour-table references for JSONL and self-contained battle snapshots.

Only static material dictionaries are shared. Hit data, poses and shell state stay
on their original records. Published readers expand the old in-memory shape.
"""
from __future__ import absolute_import
import hashlib
import json


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False,
                      separators=(',', ':'))


class ArmorTable(dict):
    """An owned, read-only snapshot. Consumers must replace, never mutate it."""
    def __deepcopy__(self, memo):
        return self

    def fingerprint(self):
        key = getattr(self, '_fingerprint', None)
        if key is None:
            key = hashlib.sha256(_json(self).encode('ascii')).hexdigest()
            self._fingerprint = key
        return key


def _sides(record):
    """Copy containers on the edited path; preserve all unrelated fields."""
    result = dict(record)
    for side in ('attacker', 'target'):
        vehicle = record.get(side)
        if not isinstance(vehicle, dict):
            continue
        vehicle = dict(vehicle)
        result[side] = vehicle
        if isinstance(vehicle.get('parts'), list):
            vehicle['parts'] = [dict(p) if isinstance(p, dict) else p
                                for p in vehicle['parts']]
    return result


def _parts(record):
    for side in ('attacker', 'target'):
        vehicle = record.get(side)
        if isinstance(vehicle, dict):
            for part in vehicle.get('parts') or []:
                if isinstance(part, dict):
                    yield part


class RecordEncoder(object):
    """One per raw file. Commit only after the complete encoded line is written."""
    def __init__(self):
        self.known = set()
        self.pending = set()

    def encode(self, record):
        self.pending = set()
        if record.get('type') != 'hit':
            return record
        result = _sides(record)
        tables = {}
        for part in _parts(result):
            table = part.get('armor')
            if not isinstance(table, dict):
                continue
            key = (table.fingerprint() if isinstance(table, ArmorTable) else
                   hashlib.sha256(_json(table).encode('ascii')).hexdigest())
            part.pop('armor')
            part['armorRef'] = key
            if key not in self.known:
                tables[key] = table
                self.pending.add(key)
        if any('armorRef' in part for part in _parts(result)):
            result['armorTableFormat'] = 1
            if tables:
                result['armorTables'] = tables
        return result

    def commit(self):
        self.known.update(self.pending)
        self.pending = set()

    def rollback(self):
        self.pending = set()


class RecordDecoder(object):
    def __init__(self):
        self.tables = {}

    def define(self, definitions):
        if not isinstance(definitions, dict):
            return
        for key, value in definitions.items():
            if not isinstance(value, dict):
                continue
            table = ArmorTable(value)
            if table.fingerprint() == key:
                self.tables[key] = table

    def decode(self, record):
        if not isinstance(record, dict):
            raise ValueError('Record must be an object')
        if record.get('armorTableFormat') not in (None, 1):
            raise ValueError('Unknown armor table format')
        self.define(record.get('armorTables'))
        if record.get('type') != 'hit':
            return record
        result = _sides(record)
        result.pop('armorTables', None)
        result.pop('armorTableFormat', None)
        warnings = list(record.get('warnings') or [])
        for part in _parts(result):
            key = part.pop('armorRef', None)
            if key is not None:
                table = self.tables.get(key) if isinstance(key, str) else None
                # Python 2 json keys and values may be unicode.
                if table is None:
                    try: table = self.tables.get(key)
                    except TypeError: pass
                if table is None:
                    part['armor'] = ArmorTable()
                    part['armorError'] = 'Recorded armor table unavailable'
                    warnings.append('Recorded armor table unavailable: '+str(part.get('name', '?')))
                else:
                    part['armor'] = table
            elif isinstance(part.get('armor'), dict):
                # Intern old inline data too; originals on disk are never rewritten.
                table = ArmorTable(part['armor'])
                key = table.fingerprint()
                part['armor'] = self.tables.setdefault(key, table)
        if warnings:
            result['warnings'] = warnings
        return result


def pack_battle(battle):
    """A complete snapshot carries its own dictionary; never needs earlier JS."""
    result = dict(battle)
    encoder = RecordEncoder()
    definitions = {}
    hits = []
    for hit in battle.get('hits') or []:
        packed = encoder.encode(hit)
        definitions.update(packed.pop('armorTables', {}))
        packed.pop('armorTableFormat', None)
        encoder.commit()
        hits.append(packed)
    result['hits'] = hits
    if definitions:
        result['armorTableFormat'] = 1
        result['armorTables'] = definitions
    return result


def unpack_battle(battle):
    if not isinstance(battle, dict):
        return battle
    if battle.get('armorTableFormat') not in (None, 1):
        raise ValueError('Unknown armor table format')
    decoder = RecordDecoder()
    decoder.define(battle.get('armorTables'))
    result = dict(battle)
    result.pop('armorTables', None)
    result.pop('armorTableFormat', None)
    result['hits'] = [decoder.decode(hit) for hit in battle.get('hits') or []]
    return result
