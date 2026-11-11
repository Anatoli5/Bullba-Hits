"""Damage no shell dealt (25.09, BACKLOG 3): mod/local_armor_inspector/damage_log.py and its call in Exporter.publish.

The recorder's 'health' crit records (one per server tick) become one event per ram, fire and other episode; a ram
pairs both vehicles' ticks and the client-physics contact of the pair; a fire stands at its end with the total and the
hit the crit ties marked; a vehicle's logged damage is checked against the HP it lost. Synthetic records, the shapes
crit_log.py writes.
"""
import json
import tempfile
import unittest
from pathlib import Path

from mod.local_armor_inspector.damage_log import damage_log, build_events, check
from mod.local_armor_inspector.exporter import Exporter, read_data_file

ME, ENEMY, ALLY = 101, 202, 303
REASON_IDS = {'fire': 1, 'ramming': 2, 'world_collision': 3, 'artillery_eq': 13, 'none': 16, 'circuit_overload': 56,
              'shot': 0}
_serial = [0]


def health(t, vehicle, old, new, attacker, reason):
    _serial[0] += 1
    return {'schema': 1, 'type': 'crit', 'event': 'health', 'id': 'c%d' % _serial[0], 'gameTime': t,
            'receivedAt': 1000.0 + t, 'vehicleId': vehicle, 'oldHealth': old, 'newHealth': new, 'attackerId': attacker,
            'attackReasonId': REASON_IDS[reason], 'attackReason': None if reason == 'shot' else reason,
            'attackReasonExtId': -1}


def fire_mark(t, vehicle, state):
    _serial[0] += 1
    return {'schema': 1, 'type': 'crit', 'event': 'fire', 'id': 'c%d' % _serial[0], 'gameTime': t, 'vehicleId': vehicle,
            'state': state}


def contact(t, a, b, approach_a, approach_b, local_b=(1.0, 1.5, 2.0)):
    parts = [{'id': i, 'transform': [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]} for i in range(4)]
    return {'schema': 1, 'type': 'crit', 'event': 'collision', 'id': 'k%.1f' % t, 'gameTime': t, 'at': t,
            'pair': sorted([a, b]), 'source': 'client physics', 'closingSpeed': 6.0,
            'sides': [{'vehicleId': a, 'local': [0.0, 1.0, 3.0], 'parts': parts, 'aim': [0.1, 0.0], 'approach': approach_a},
                      {'vehicleId': b, 'local': list(local_b), 'parts': parts, 'aim': [0.2, 0.0], 'approach': approach_b}]}


def shot(hit_id, t, target, attacker, damage, crits=None):
    h = {'id': str(hit_id), 'gameTime': t, 'receivedAt': 1000.0 + t, 'targetId': target, 'attackerId': attacker,
         'damage': damage, 'points': []}
    if crits: h['crits'] = crits
    return h


ROSTER = [{'id': ME, 'maxHealth': 1000}, {'id': ENEMY, 'maxHealth': 1200}, {'id': ALLY, 'maxHealth': 800}]


class RamTests(unittest.TestCase):
    def test_each_side_its_own_event_and_the_contact(self):
        # A ram is mutual: each side's ticks name the OTHER vehicle (KNOWLEDGE 10, measured 25.09), and each side's
        # loss is one event dealt by that vehicle - whoever drove into the contact (here the enemy).
        events = [contact(9.8, ME, ENEMY, -0.5, 7.0),
                  health(10.0, ME, 1000, 850, ENEMY, 'ramming'), health(10.0, ENEMY, 1200, 1180, ME, 'ramming'),
                  health(10.2, ME, 850, 830, ENEMY, 'ramming')]
        out = build_events([], events)
        self.assertEqual([(e['kind'], e['attackerId'], e['targetId'], e['damage'], e['returned'], e['ticks']) for e in out],
                         [('ram', ENEMY, ME, 170, 20, 2), ('ram', ME, ENEMY, 20, 170, 1)])
        mine, theirs = out
        self.assertEqual((mine['healthAfter'], theirs['healthAfter']), (830, 1180))
        self.assertEqual(mine['collision'], theirs['collision'])
        self.assertEqual((mine['id'], theirs['id']), ('ram:' + events[1]['id'], 'ram:' + events[2]['id']))
        for ram in out:
            self.assertEqual(ram['contact']['sides'][str(ME)]['local'], [0.0, 1.0, 3.0])
            self.assertAlmostEqual(ram['contact']['dt'], -0.2)
            self.assertEqual(ram['gameTime'], 10.0)
            for gone in ('selfDamage', 'rammerFrom', 'attackerKilled', 'attackerHealthAfter'):
                self.assertNotIn(gone, ram)

    def test_one_damaged_side_one_event_and_no_contact_out_of_the_window(self):
        events = [health(10.0, ENEMY, 1200, 1050, ME, 'ramming'),
                  contact(12.5, ME, ENEMY, 1, 2)]   # out of the window: not this ram's contact
        out = build_events([], events)
        self.assertEqual([(e['attackerId'], e['targetId'], e['damage'], e['returned']) for e in out], [(ME, ENEMY, 150, 0)])
        self.assertNotIn('contact', out[0])

    def test_a_ram_that_destroys(self):
        events = [health(10.0, ME, 1000, 990, ENEMY, 'ramming'), health(10.0, ENEMY, 120, -1, ME, 'ramming')]
        out = build_events([], events)
        self.assertEqual([(e['targetId'], e['damage'], e.get('killed', False), e['healthAfter']) for e in out],
                         [(ME, 10, False, 990), (ENEMY, 120, True, 0)])

    def test_every_tick_is_in_exactly_one_event(self):
        # What the log shows adds up to what the vehicles lost, by source (the user's requirement of 16.09.2026).
        events = [health(10.0, ME, 1000, 850, ENEMY, 'ramming'), health(10.0, ENEMY, 1200, 1180, ME, 'ramming'),
                  health(10.3, ENEMY, 1180, 1100, ME, 'ramming'), health(12.0, ALLY, 800, 700, ENEMY, 'ramming'),
                  health(12.1, ENEMY, 1100, 1090, ALLY, 'ramming'), health(20.0, ME, 850, 800, ENEMY, 'fire'),
                  health(20.5, ME, 800, 760, ENEMY, 'fire'), health(30.0, ALLY, 700, 650, 0, 'world_collision')]
        out = build_events([], events)
        shown, lost = {}, {}
        for e in out:
            key = (e['attackerId'], e['targetId'])
            shown[key] = shown.get(key, 0) + e['damage']
        for r in events:
            key = (r['attackerId'], r['vehicleId'])
            lost[key] = lost.get(key, 0) + r['oldHealth'] - r['newHealth']
        self.assertEqual(shown, lost)

    def test_a_pause_makes_two_rams(self):
        events = [health(10.0, ME, 1000, 990, ENEMY, 'ramming'), health(12.0, ME, 990, 980, ENEMY, 'ramming')]
        self.assertEqual(len(build_events([], events)), 2)


class FireTests(unittest.TestCase):
    def test_one_event_at_the_end_with_the_total_and_the_cause(self):
        hits = [shot(7, 19.5, ENEMY, ME, 300, {'items': [{'kind': 'fire', 'type': 'fire', 'state': 'started'}]})]
        events = [fire_mark(19.6, ENEMY, 'appeared')] + [
            health(20.0 + 0.5 * k, ENEMY, 900 - 40 * k, 860 - 40 * k, ME, 'fire') for k in range(4)] + [
            fire_mark(21.7, ENEMY, 'removed')]
        out = build_events(hits, events)
        self.assertEqual(len(out), 1)
        fire = out[0]
        self.assertEqual((fire['kind'], fire['targetId'], fire['attackerId'], fire['damage'], fire['ticks']),
                         ('fire', ENEMY, ME, 160, 4))
        self.assertEqual((fire['start'], fire['end'], fire['gameTime'], fire['out']), (19.6, 21.7, 21.7, 'extinguished'))
        self.assertEqual(fire['cause'], {'hitId': '7', 'from': 'crit'})
        self.assertEqual(fire['receivedAt'], events[4]['receivedAt'])   # the tile stands at the last tick

    def test_a_fire_that_destroys_closes_and_says_so(self):
        events = [health(30.0, ENEMY, 60, 20, ME, 'fire'), health(30.5, ENEMY, 20, -1, ME, 'fire')]
        fire = build_events([], events)[0]
        self.assertEqual((fire['damage'], fire['killed'], fire['out'], fire['healthAfter']), (60, True, 'destroyed', 0))

    def test_a_fire_still_burning_waits(self):
        events = [health(30.0, ENEMY, 600, 560, ME, 'fire'), health(30.5, ENEMY, 560, 520, ME, 'fire')]
        held = {}
        self.assertEqual(build_events([], events, now=1030.6, held=held), [])   # the last tick 0.1 s ago
        self.assertEqual(held, {'count': 1})
        # Two seconds without a tick: the fire is over and its tile goes out; a finished battle (now None) likewise.
        self.assertEqual([e['kind'] for e in build_events([], events, now=1032.6)], ['fire'])
        self.assertEqual([e['kind'] for e in build_events([], events)], ['fire'])


class OtherTests(unittest.TestCase):
    def test_reasons_and_heals(self):
        events = [health(5.0, ALLY, 800, 375, ENEMY, 'artillery_eq'),
                  health(6.0, ENEMY, 1200, 1116, ENEMY, 'circuit_overload'),
                  health(6.5, ENEMY, 1116, 1032, ENEMY, 'circuit_overload'),
                  health(7.0, ME, 1000, 1000, 0, 'none'), health(8.0, ME, 900, 1000, 0, 'none'),
                  health(9.0, ALLY, 375, -2, ALLY, 'world_collision'),
                  health(20.0, ME, 500, 0, ENEMY, 'shot')]
        out = build_events([], events)
        self.assertEqual([(e['reason'], e['damage'], e['ticks']) for e in out],
                         [('artillery_eq', 425, 1), ('circuit_overload', 168, 2), ('world_collision', 375, 1)])
        self.assertTrue(out[2]['killed'])
        self.assertEqual(out[2]['attackerId'], out[2]['targetId'])


class CheckTests(unittest.TestCase):
    def test_anchors_match_and_mismatch(self):
        hits = [shot(1, 1.0, ME, ENEMY, 300), shot(2, 2.0, ME, ENEMY, 200)]
        events = [health(3.0, ME, 500, 460, ENEMY, 'fire'),          # 1000 - 300 - 200 = 500: matches
                  health(9.0, ENEMY, 1000, 900, ME, 'ramming')]       # 1200 lost 200 before, nothing logged
        result = check(hits, events, ROSTER)
        self.assertEqual((result['intervals'], result['matched'], result['mismatched'], result['missing']), (2, 1, 1, 200))
        self.assertEqual(result['rows'][0]['vehicleId'], ENEMY)
        self.assertEqual(result['rows'][0]['at'], 'start')

    def test_a_vehicle_destroyed_by_the_logged_hits(self):
        hits = [shot(1, 1.0, ALLY, ENEMY, 500), shot(2, 2.0, ALLY, ENEMY, 300)]
        result = check(hits, [], ROSTER)
        self.assertEqual((result['destroyed'], result['matched'], result['mismatched']), (1, 1, 0))

    def test_the_shot_that_destroys_is_an_anchor(self):
        hits = [shot(1, 1.0, ALLY, ENEMY, 700), shot(2, 2.0, ALLY, ENEMY, 100)]
        events = [health(2.0, ALLY, 100, -1, ENEMY, 'shot')]
        result = check(hits, events, ROSTER)
        self.assertEqual((result['intervals'], result['matched'], result['destroyed']), (1, 1, 1))

    def test_a_death_and_a_new_life_is_not_a_mismatch(self):
        # Respawn modes restore the HP without a health record: logged hits worth more than the HP left.
        hits = [shot(1, 1.0, ME, ENEMY, 1000), shot(2, 5.0, ME, ENEMY, 300)]
        events = [health(6.0, ME, 700, 1000, 0, 'none')]
        result = check(hits, events, ROSTER)
        self.assertEqual((result['respawns'], result['mismatched']), (1, 0))

    def test_no_health_records_no_log(self):
        self.assertEqual(damage_log([shot(1, 1.0, ME, ENEMY, 100)], [], ROSTER), ([], None, 0))


class HoldBackTests(unittest.TestCase):
    """The exporter holds an episode still ticking back and publishes again at the quiet pace; a forced publish (a
    battle switch, the game closing) counts the battle as finished and publishes it as it stands (review 25.09 #2)."""
    def test_a_live_fire_waits_and_the_final_publish_takes_it(self):
        import time as clock
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / 'battles').mkdir()
        (root / 'data' / 'battles').mkdir(parents=True)
        exporter = Exporter(str(root), str(root), 'version\n', str(root / 'unused.wotmod'))
        exporter.apply_record('14-test', {'schema': 1, 'type': 'battle', 'id': '14-test', 'startedAt': 1, 'map': 'Map',
                                          'clientVersion': 'version\n', 'playerVehicleId': ME})
        now = clock.time()
        for k in range(3):
            tick = health(50.0 + 0.5 * k, ENEMY, 900 - 40 * k, 860 - 40 * k, ME, 'fire')
            tick['receivedAt'] = now - 1.0 + 0.5 * k
            exporter.apply_record('14-test', tick)
        exporter.flush()
        read = lambda: read_data_file(str(root / 'data' / 'battles' / '14-test.js'))
        battle = read()
        battle = battle[1] if isinstance(battle, list) else battle
        self.assertNotIn('damageEvents', battle)                   # still burning: held back
        self.assertTrue(exporter.has_pending_publish())           # and asked for once more
        self.assertTrue(exporter.finish())                        # the last publish: the battle is over
        battle = read()
        battle = battle[1] if isinstance(battle, list) else battle
        self.assertEqual([e['kind'] for e in battle['damageEvents']], ['fire'])
        self.assertFalse(exporter.has_pending_publish())

    def test_no_battle_no_publish(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        exporter = Exporter(temp.name, temp.name, 'version\n', str(Path(temp.name) / 'unused.wotmod'))
        exporter.current, exporter.pending_quiet, exporter.pending_publish = None, True, False
        self.assertTrue(exporter.flush())                         # no publish(None), no TypeError
        self.assertFalse(exporter.has_pending_publish())


class PublishTests(unittest.TestCase):
    def test_the_battle_file_carries_the_events_and_the_check(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / 'battles').mkdir()
        (root / 'data' / 'battles').mkdir(parents=True)
        exporter = Exporter(str(root), str(root), 'version\n', str(root / 'unused.wotmod'))
        exporter.record('12-test', {'schema': 1, 'type': 'battle', 'id': '12-test', 'startedAt': 1, 'map': 'Map',
                                    'clientVersion': 'version\n', 'playerVehicleId': ME})
        for row in [health(10.0, ME, 1000, 850, ENEMY, 'ramming'), health(10.0, ENEMY, 1200, 1180, ME, 'ramming'),
                    health(20.0, ALLY, 800, 700, ENEMY, 'artillery_eq')]:
            exporter.record('12-test', row)
        exporter.flush(force=True)
        published = read_data_file(str(root / 'data' / 'battles' / '12-test.js'))
        battle = published[1] if isinstance(published, list) else published
        self.assertEqual([(e['kind'], e['targetId'], e['damage']) for e in battle['damageEvents']],
                         [('ram', ME, 150), ('ram', ENEMY, 20), ('other', ALLY, 100)])
        self.assertEqual(battle['damageCheck']['schema'], 1)
        self.assertNotIn('critEvents', battle)


class RamCreditTests(unittest.TestCase):
    def test_damage_named_to_me_adds_up_to_the_hp_the_enemy_lost(self):
        # The user's 1v1 of 09.11.2026 (arena 1726269409620419, VK 72.01 K against K-91, 2090 HP; the record is in
        # tests/fixtures-local/ram-credit-2026-11-09): three shots 645 + 834 + 55 and two rams 486 + 70, every tick
        # with attackerId = the user, as the server credits them (battle result: damageDealt 2090, damageRamming
        # 556). 1.05 called the enemy the rammer of the first ram (it drove into the contact) and showed the 486 as
        # "Rammer took", so the log gave the user 1604 of 2090.
        full = 2090
        hits = [shot('h1', 123.6, ENEMY, ME, 645), shot('h2', 142.2, ENEMY, ME, 834), shot('h3', 159.4, ENEMY, ME, 55)]
        events = [contact(135.7, ME, ENEMY, 1.0, 5.0),
                  health(135.7, ME, 2630, 2591, ENEMY, 'ramming'), health(135.7, ENEMY, 1445, 959, ME, 'ramming'),
                  contact(146.0, ME, ENEMY, 5.0, 0.0),
                  health(146.0, ENEMY, 125, 55, ME, 'ramming'),
                  health(159.4, ENEMY, 55, 0, ME, 'shot')]
        out = build_events(hits, events)
        mine = sum(h['damage'] for h in hits if h['attackerId'] == ME and h['targetId'] == ENEMY)
        mine += sum(e['damage'] for e in out if e.get('attackerId') == ME and e.get('targetId') == ENEMY)
        self.assertEqual(mine, full)
        taken = sum(e['damage'] for e in out if e.get('attackerId') == ENEMY and e.get('targetId') == ME)
        self.assertEqual(taken, 39)


if __name__ == '__main__':
    unittest.main()
