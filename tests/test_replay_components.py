"""The replay decoder of the mod package (mod/local_armor_inspector/replay_stream.py, replay_objects.py) under CPython 3.

On synthetic bytes: the numbering rule, a component state, member messages, the bit path of nested updates (the
ammo-list bytes of the 01.11.2026 replay, which carry no player data), resynchronisation, a raw stream cut inside a
packet. On the local replay fixtures (tests/fixtures-local/replays/, not in git; skipped when absent): the table of
tests/replay_digest.py (the same table tests/py27/replay_stream.py checks under the client's Python 2.7), and the
two 0x32 frames of the 10.11 in-battle stream the decoder cannot read yet (KNOWLEDGE section 18).
"""
import collections
import os
import sys
import struct
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'mod'))
sys.path.insert(0, str(ROOT / 'tests'))
from local_armor_inspector import replay_stream as rd  # noqa: E402
from local_armor_inspector import replay_objects as rc  # noqa: E402
import replay_digest  # noqa: E402

TEMP_LIVE = ROOT / 'tests' / 'fixtures-local' / 'replays' / '2026-11-10-temp-live.wotreplay'
CLIENT = Path(rd.DEFAULT_CLIENT) / 'res' / 'packages'
_DEFS = []


def client_defs():
    """The installed client's definitions, read once for every fixture test."""
    if not _DEFS:
        _DEFS.append(rd.Defs(rd.Client()))
    return _DEFS[0]


def types():
    d = rd.Defs.__new__(rd.Defs)
    d.alias_xml, d.types = {}, {}
    return d


def type_of(xml):
    return types().type_of(ET.fromstring(xml))


AMMO = ('<Type>ARRAY<of>FIXED_DICT<AllowNone>true</AllowNone><Properties>'
        '<compactDescr><Type>INT32</Type></compactDescr><quantity><Type>UINT16</Type></quantity>'
        '<quantityInClip><Type>UINT16</Type></quantityInClip><previousStage><Type>UINT16</Type></previousStage>'
        '<endTime><Type>FLOAT32</Type></endTime><totalTime><Type>INT16</Type></totalTime>'
        '<index><Type>UINT8</Type></index></Properties></of></Type>')


class Holder(object):
    def __init__(self, props, values):
        self.props, self.values = props, values


class FakeRegistry(object):
    def __init__(self, specs):
        self.specs = specs

    def name(self, typ):
        return {7: 'Receiver', 8: 'Pair', 9: 'Eight'}.get(typ)

    def spec(self, name):
        return self.specs.get(name)


def spec_receiver():
    u32, u8 = type_of('<Type>UINT32</Type>'), type_of('<Type>UINT8</Type>')
    return rc.ComponentSpec('Receiver', collections.OrderedDict([('networkId', (u32, 'ALL_CLIENTS'))]),
                            collections.OrderedDict([('receive', ([('x', u8)], 1))]))


def spec_pair():
    u8 = type_of('<Type>UINT8</Type>')
    # sorted by size: 'none' (header only) first, then 'one' (1 byte + header)
    return rc.ComponentSpec('Pair', collections.OrderedDict(),
                            collections.OrderedDict([('one', ([('x', u8)], 1)), ('none', ([], 1))]))


class ReplayComponentsTests(unittest.TestCase):
    def test_numbering_skips_classless_and_repeated_names(self):
        self.assertEqual(rc.numbered_components(['A', 'B', 'X', 'A', 'C'], {'A', 'B', 'C'}), ['A', 'B', 'C'])

    def test_ammo_list_slices_and_element_set(self):
        ammo = type_of(AMMO)
        props = [('p%d' % i, type_of('<Type>UINT8</Type>')) for i in range(23)]
        props[1] = ('vehicleAmmoList', ammo)
        first = {'compactDescr': 0xccfb, 'quantity': 1, 'quantityInClip': 0, 'previousStage': 0, 'endTime': -1.0,
                 'totalTime': 0, 'index': 0}
        h = Holder(props, {'vehicleAmmoList': [first]})
        # 1 | prop 00001 | stop | slice [1, 1) on a 1-element list (1-bit indexes): appends at 1
        r = rc.nested_update(h, 1, 1, bytes.fromhex('8580015a9600000c000000000000000000000000'))
        self.assertEqual(r['slice'], [1, 1])
        self.assertEqual(r['value'][0]['compactDescr'], 0x965a)
        self.assertEqual(r['value'][0]['quantity'], 12)
        # length 2: 2-bit indexes, slice [2, 2)
        r = rc.nested_update(h, 1, 1, bytes.fromhex('8540015a9700000f000000000000000000000000'))
        self.assertEqual(r['slice'], [2, 2])
        self.assertEqual(len(h.values['vehicleAmmoList']), 3)
        # mode 2 on the full list of 7 (3 shells, 3 consumables after the slices of the battle): 3-bit index 1
        h.values['vehicleAmmoList'] += [dict(first) for _ in range(4)]
        r = rc.nested_update(h, 1, 2, bytes.fromhex('8440015a9600000b000000000000000000000000'))
        self.assertEqual(r['path'], ['vehicleAmmoList', 1])
        self.assertEqual(h.values['vehicleAmmoList'][1]['quantity'], 11)

    def test_array_of_dicts_field_set(self):
        info = type_of('<Type>ARRAY<of>FIXED_DICT<Properties>' + ''.join(
            '<f%d><Type>%s</Type></f%d>' % (i, 'UINT32' if i == 38 else 'UINT8', i)
            for i in range(39)) + '</Properties></of></Type>')
        rows = [dict(('f%d' % i, 0) for i in range(39)) for _ in range(30)]
        h = Holder([('vehiclesInfo', info)], {'vehiclesInfo': rows})
        # 1 | (one property: no index bits) | descend | element 00010 | stop | field 000111 | value 01
        r = rc.nested_update(h, 0, 2, bytes.fromhex('c41c01'))
        self.assertEqual(r['path'], ['vehiclesInfo', 2, 'f7'])
        self.assertEqual(rows[2]['f7'], 1)
        r = rc.nested_update(h, 0, 2, bytes.fromhex('c49802000000'))
        self.assertEqual(r['path'], ['vehiclesInfo', 2, 'f38'])
        self.assertEqual(rows[2]['f38'], 2)

    def test_state_messages_removal_and_resync(self):
        table = rc.ObjectTable(FakeRegistry({'Receiver': spec_receiver()}))
        # entity 0x0010 (id 1001) with one child 0x0011 of type 7: ids 0x85 = a run of 3 (2 members + the last id),
        # 0x82, mask 0b111 (one bit per id)
        frame = bytes.fromhex('0010' '0001' '01' 'e9030000' '01' '0010' '01' '00'
                              '02' '07' '0000' '85' '82' '07' '2a000000' '00')
        table.create(len(frame).to_bytes(4, 'little') + frame)
        inst = table.instances[0x11]
        self.assertEqual(inst.owner, 1001)
        self.assertEqual(inst.values, {'networkId': 42})
        out = table.messages(bytes.fromhex('0012' '07000000' '0013' '05'), 1.0)
        self.assertEqual([(e['ev'], e.get('name')) for e in out], [('component_property', 'networkId'),
                                                                   ('component_method', 'receive')])
        self.assertEqual(out[1]['args']['x'], 5)
        out = table.messages(bytes.fromhex('0011'), 2.0)
        self.assertEqual(out[0]['ev'], 'component_removed')
        self.assertEqual(table.lookup(0x13), (None, None))
        # a message before the frame that creates its instance (same tick) is held and read after the frame
        self.assertEqual(table.messages(bytes.fromhex('0013' '04'), 3.0), [])
        table.create(len(frame).to_bytes(4, 'little') + frame)
        out = table.retry()
        self.assertEqual(out[0]['args']['x'], 4)
        # an id of no instance, then a readable message, the tick over: the reader skips to it
        table.messages(bytes.fromhex('0f0f' 'aabb' '0013' '09'), 4.0)
        out = table.flush()
        self.assertEqual(out[0]['ev'], 'component_undecoded')
        self.assertEqual(out[-1]['args']['x'], 9)

    def test_member_ids_with_gaps(self):
        # a gap: '03' = member 0 at instance + 3, then '84' = a run of 2 (member 1 and the last id)
        table = rc.ObjectTable(FakeRegistry({'Receiver': spec_receiver()}))
        frame = bytes.fromhex('0010' '0001' '01' 'e9030000' '01' '0010' '01' '00'
                              '02' '07' '0000' '03' '84' '82' '07' '2a000000' '00')
        table.create(len(frame).to_bytes(4, 'little') + frame)
        inst = table.instances[0x11]
        self.assertEqual((inst.members, inst.ids), (2, [0x14, 0x15]))
        out = table.messages(bytes.fromhex('0014' '07000000' '0015' '05'), 1.0)
        self.assertEqual([(e['ev'], e.get('name')) for e in out], [('component_property', 'networkId'),
                                                                   ('component_method', 'receive')])

    def test_state_header_grammar(self):
        # outputs/replay-state-header-2026-11-10.md: members + 1 ids; a run byte 0x80|n = n - 2 ids; 0x82 = the end
        ids = rc.ObjectTable._member_ids
        self.assertEqual(ids(bytes.fromhex('85' '82'), 0, 0x10), ([0x11, 0x12, 0x13], 1))          # plain run
        self.assertEqual(ids(bytes.fromhex('05' '83' '82'), 0, 0x10), ([0x15, 0x16], 2))          # delta + run
        self.assertEqual(ids(bytes.fromhex('83' '05' '83' '82'), 0, 0x382), ([0x383, 0x388, 0x389], 3))
        self.assertEqual(ids(bytes.fromhex('800030' '84' '82'), 0, 0x10), ([0x30, 0x31, 0x32], 4))  # absolute
        self.assertEqual(ids(bytes.fromhex('03' '82'), 0, 0x10), ([0x13], 1))                     # 0 members
        # the mask: one bit per id (9 ids -> 2 bytes); the last id's bit is set and carries no value
        u8 = type_of('<Type>UINT8</Type>')
        spec = rc.ComponentSpec('Eight', collections.OrderedDict(('p%d' % i, (u8, 'ALL_CLIENTS')) for i in range(8)),
                                collections.OrderedDict())
        table = rc.ObjectTable(FakeRegistry({'Eight': spec}))
        table.entities[0x10] = 7
        # 8 members: run 0x80|(9+2); mask 0x0181 = members 0 and 7 present + the last id's bit; then the next record
        frame = bytes.fromhex('0040' '0010' '02' '09' '0000' '8b' '82' '8101' '0b' '0c' '00')
        table.create(len(frame).to_bytes(4, 'little') + frame)
        inst = table.instances[0x40]
        self.assertEqual((inst.members, inst.ids), (8, list(range(0x41, 0x49))))
        self.assertEqual([inst.values['p%d' % i] for i in range(8)], [0x0b, 0, 0, 0, 0, 0, 0, 0x0c])
        self.assertEqual(table.failures, {})
        self.assertEqual(table.lookup(0x49), (None, None))   # the last id is no member

    def test_method_order_comes_from_the_state(self):
        table = rc.ObjectTable(FakeRegistry({'Pair': spec_pair()}))
        # two methods, both present; the state says wire 0 = sorted 1 ('one'), wire 1 = sorted 0 ('none')
        frame = bytes.fromhex('0020' '0010' '02' '08' '0000' '85' '82' '07' '01' '00')
        table.entities[0x10] = 7
        table.create(len(frame).to_bytes(4, 'little') + frame)
        out = table.messages(bytes.fromhex('0021' '03' '0022'), 1.0)
        self.assertEqual([e['name'] for e in out], ['one', 'none'])


    def test_small_setup_packets(self):
        ev = rc.small_packet(0x0d, 0.0, bytes.fromhex('12020000' '00000000' '04000000' '02000000'))
        self.assertEqual((ev['spaceId'], ev['key'], ev['value']), (530, 0, '02000000'))
        self.assertEqual(rc.small_packet(0x1e, 1.0, bytes.fromhex('01000000'))['index'], 1)
        self.assertEqual(rc.small_packet(0x02, 0.0, bytes.fromhex('20a90d0000'))['entityId'], 895264)
        self.assertEqual(rc.small_packet(0x1d, 0.0, struct.pack('<f', 0.5))['ev'], 'gun_pitch')

    def test_battle_results_unpickle_only_sets(self):
        import pickle, zlib
        # Python 2 str in the client's pickle = latin-1 text here (bytes would pickle through _codecs)
        inner = zlib.compress(pickle.dumps([1, {2, 3}], protocol=2)).decode('latin1')
        outer = zlib.compress(pickle.dumps((77, inner, inner, inner), protocol=2), 0)
        ev = rc.small_packet(0x11, 9.0, bytes.fromhex('6400') + outer)
        self.assertEqual((ev['arenaUniqueID'], ev['parts'][0]), (77, [1, {2, 3}]))
        bad = zlib.compress(pickle.dumps((77, zlib.compress(pickle.dumps(OSError('x'), protocol=2)).decode('latin1')), protocol=2), 0)
        with self.assertRaises(pickle.UnpicklingError):
            rc.small_packet(0x11, 9.0, bytes.fromhex('6400') + bad)

    def test_raw_stream_cut_inside_a_packet(self):
        # two whole packets, then a third whose payload the file does not hold yet (a temp.wotreplay being written)
        whole = struct.pack('<IIf', 4, 0x16, 0.5) + struct.pack('<I', 3) + struct.pack('<IIf', 0, 0x36, 0.6)
        cut = struct.pack('<IIf', 60, 0x1a, 0.7) + b'\x00' * 19
        handle, path = tempfile.mkstemp(suffix='.wotreplay')
        try:
            with os.fdopen(handle, 'wb') as f:
                f.write(whole + cut)
            blocks, stream = rd.read_any(path)
        finally:
            os.remove(path)
        self.assertEqual((blocks, type(stream)), ([], bytearray))
        tail = []
        self.assertEqual([(t, c) for t, c, p in rd.iter_packets(stream, tail)], [(0x16, 0.5), (0x36, 0.6000000238418579)])
        self.assertEqual(tail, [len(cut)])


@unittest.skipUnless(CLIENT.is_dir(), 'the installed client (entity_defs) is absent')
class ReplayFixtureTests(unittest.TestCase):
    @staticmethod
    def live_hierarchy():
        """The object table after the 0x32 frames at clock 0 of the 10.11 in-battle stream, and NetworkVehicleHierarchy
        0x382 of entity 0x202199fb (vehicle uk:GB92_FV217) in it."""
        blocks, stream = rd.read_any(str(TEMP_LIVE))
        defs = client_defs()
        table = rc.ObjectTable(rc.Registry(defs.client, defs))
        table.reg.base = rc.calibrate_base(stream, table.reg)
        for ptype, clock, p in rd.iter_packets(stream):
            if clock > 0:
                break
            if ptype == 0x32:
                table.create(p)
        return table, table.instances[0x382]

    @unittest.skipUnless(TEMP_LIVE.is_file(), 'local fixture absent: %s' % TEMP_LIVE.name)
    def test_live_stream_hierarchy_frames(self):
        # 10.11.2026, the in-battle stream: two equal 0x32 frames (t 0.0 and 469.15, 110 bytes) failed under the old
        # "members + 3 ids" reading. The NetworkVehicleHierarchy state's id list has a gap between its two members:
        # '83 05 83' = ids 0x383, 0x388 (members) and 0x389 (the last id); mask 07; values as in every other state
        # (outputs/replay-state-header-2026-11-10.md).
        table, inst = self.live_hierarchy()
        self.assertEqual((inst.name, inst.members, inst.ids), ('NetworkVehicleHierarchy', 2, [0x383, 0x388]))
        self.assertEqual(inst.values['vehTypeCD'], 0x3e51)
        self.assertEqual([s['slotName'] for s in inst.values['hierarchyInfo']],
                         [b'gun', b'hull', b'chassis', b'turret', b'compositionRootSlot'])
        self.assertEqual(table.failures, {})

    def test_fixtures_match_the_table(self):
        table = replay_digest.load_table()
        paths = replay_digest.fixtures()
        if table is None or not paths:
            self.skipTest('local fixtures or tests/fixtures-local/replays/digests.json absent')
        got = replay_digest.summarise_all(rd, client_defs(), paths)
        self.assertEqual(replay_digest.differences(table, got), [])
        for name, row in got.items():
            if 'temp' in name:
                continue
            # the final replays: nothing left unread
            self.assertEqual([row[k] for k in ('rawPackets', 'undecodedPackets', 'unreadMessages', 'failedFrames',
                                               'objectFailures', 'decoderFailures', 'partialTailBytes')],
                             [0, 0, 0, 0, 0, 0, 0], name)


if __name__ == '__main__':
    unittest.main()
