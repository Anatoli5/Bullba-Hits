"""Turn the client research into web/equipment.js, the page's own equipment catalogue.

The research pass decoded the installed client and wrote outputs/equipment-perks-<date>.json with every
optional device, crew skill, directive and consumable, their numeric effects and the page input each one
lands on. That file is the source of truth; this script selects what the aiming maths actually needs and
writes it as one flat JavaScript object, so the page never invents an equipment bonus and every number on a
tooltip can be traced back to the client's own XML.

Run it with runtime/python.exe. It reads outputs/ (local context, not in the repository) and writes
web/equipment.js (shipped). Re-run it after a client update, with a fresh research pass behind it.
"""
import io
import json
import os
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGUE = os.path.join(ROOT, 'outputs', 'equipment-perks-2026-09-20.json')
TARGET = os.path.join(ROOT, 'web', 'equipment.js')
CLIENT = 'World of Tanks PC NA 2.4.0.1 #950'

# The garage's own name for a family of devices. The research file carries a shortened form
# ("Stabilizer", "Aiming"); these are the names the interface shows on the item itself.
FAMILY_NAMES = {
    'tankRammer': 'Gun Rammer',
    'aimingStabilizer': 'Vertical Stabilizer',
    'enhancedAimDrives': 'Enhanced Gun Laying Drive',
    'improvedSights': 'Improved Aiming',
    'improvedRotationMechanism': 'Improved Rotation Mechanism',
    'improvedVentilation': 'Improved Ventilation',
    'turbocharger': 'Turbocharger',
    'modernizedAimDrivesAimingStabilizer': 'Fire-Control System',
    'modernizedImprovedSightsEnhancedAimDrives': 'Accuracy Improvement System',
    'modernizedTurbochargerRotationMechanism': 'Mobility Improvement System',
}
# What the family does, in one clause, for the tooltip.
FAMILY_WHAT = {
    'tankRammer': 'shortens the reload',
    'aimingStabilizer': 'scales everything the vehicle’s own movement adds to the circle and leaves the '
                        'fully aimed circle alone',
    'enhancedAimDrives': 'shortens the aiming time, so the circle settles faster but is no smaller when '
                         'fully aimed',
    'improvedSights': 'shrinks the whole circle, the fully aimed one included — the only device that does',
    'improvedRotationMechanism': 'turns the turret faster and scales what movement adds to the circle',
    'improvedVentilation': 'adds crew levels, which tighten the circle and the aiming time, shorten the '
                           'reload and speed the turret up',
    'turbocharger': 'raises the speed the vehicle reaches, which makes the movement term bigger, not smaller',
    'modernizedAimDrivesAimingStabilizer': 'a laying drive and a stabiliser in one slot',
    'modernizedImprovedSightsEnhancedAimDrives': 'improved aiming and a laying drive in one slot',
    'modernizedTurbochargerRotationMechanism': 'a turbocharger and a rotation mechanism in one slot',
}
FAMILY_ORDER = ['tankRammer', 'aimingStabilizer', 'enhancedAimDrives', 'improvedSights',
                'improvedRotationMechanism', 'improvedVentilation', 'turbocharger',
                'modernizedAimDrivesAimingStabilizer', 'modernizedImprovedSightsEnhancedAimDrives',
                'modernizedTurbochargerRotationMechanism']
TIER_ORDER = ['standard', 'improved', 'bounty', 'experimental']
# "badge" is the grade mark the client lays over the corner of the device icon, extracted into web/icons
# from the client's own artefact and demountKit folders (equipmentPlus_overlay,
# equipmentTrophyUpgraded_overlay, experimental_level_icon_lvl1..3). Every grade of one device shares
# ONE picture in the client — verified over all 47 gunnery entries, 21.09 — so the badge is the only
# thing that tells a Bounty rammer from a standard one, and the page copies that instead of captioning
# its tiles. A standard piece wears no badge at all; the experimental name is a stem, and the page
# completes it with the level, which is the trailing digit of the entry id.
TIERS = [
    {'id': 'standard', 'name': 'Standard', 'badge': '', 'note': 'The Class number is the vehicle tier '
     'band, not the strength: every Class of one device carries the same factors.'},
    {'id': 'improved', 'name': 'Improved', 'badge': 'grade_improved',
     'note': 'Bought for bonds; each piece carries its own name.'},
    {'id': 'bounty', 'name': 'Bounty', 'badge': 'grade_bounty_up', 'note': 'One tile per device, and it is '
     'the UPGRADED piece (the client’s trophyUpgraded entry): that is the state a Bounty piece ends up '
     'in, so the page counts it that way and never offers the un-upgraded one. The client calls these '
     'entries “trophy”; the garage never does. The badge is the upgraded one for the same reason: the art must not promise something other than the numbers.'},
    {'id': 'experimental', 'name': 'Experimental', 'badge': 'grade_experimental', 'badgeLevel': True,
     'note': 'Three steps T1→T3, and one piece covers two devices at once.'},
]
# The page's own short names for the inputs of the dispersion maths, keyed by the research file's
# "pageInput" text. An effect whose input is not in here is not something the page models.
PAGE_INPUT = {
    'additiveFactor': 'additiveFactor',
    'aimingTimeFactor': 'aimingTimeFactor',
    'multFactor': 'multFactor',
    'reloadTimeFactor': 'reloadTimeFactor',
    'turretRotationSpeed': 'turretRotationSpeed',
    'crewLevelIncrease': 'crewLevel',
    'speedForward': 'speedForward',
    'speedBackward': 'speedBackward',
    'speed (engine power -> speed reached -> movement term)': 'enginePower',
}
# Slot types a vehicle's <supplySlots> lists, and what each grants (supply_slot_types.xml).
SLOT_TYPES = {1: [], 2: ['mobility'], 3: ['stealth'], 4: ['firepower'], 5: ['survivability']}
CATEGORY_NAMES = {'firepower': 'Firepower', 'mobility': 'Mobility', 'survivability': 'Survivability',
                  'stealth': 'Scouting'}

# Crew skills and perks, transcribed from section 6.1 of the research report, which resolved every
# per-point number into the multiplier at a fully trained skill. The sign of a raw argument depends on the
# argument, so the resolved figure is what is carried here; "situational" marks a perk that only holds while
# its condition does (stationary, low health, alone, close range), which is why it is off by default.
#
# Brothers in Arms is the one skill with role 'each': every tankman learns it for himself, so the page gives
# it one switch per crew member rather than one for the whole crew. Its 5 is BrotherhoodSkill.crewLevelIncrease
# (tankmen.xml <brotherhood><crewLevelIncrease>), and the client AVERAGES it over the crew:
# VehicleDescrCrew._calculateLevelIncreaseByBrotherhood adds 5 x (tankmen who have it) / (all tankmen) to every
# crew member (outputs/brothers-in-arms-2026-09-21.md, checked by running the client's own bytecode).
SKILLS = [
    {'id': 'brotherhood', 'role': 'each', 'name': 'Brothers in Arms', 'kind': 'skill',
     'eff': {'crewLevel': ['add', 5]}, 'situational': False,
     'note': 'learned by each crew member for himself; the client averages it over the whole crew, so every '
             'member who has it adds 5/N crew levels to everyone (N = the number of tankmen) and the full +5 '
             'comes only when all of them have it'},
    {'id': 'gunner_smoothTurret', 'role': 'gunner', 'name': 'Snap Shot', 'kind': 'skill',
     'eff': {'turretRotationFactor': ['mul', 0.925]}, 'situational': False,
     'note': 'the turret-rotation term only'},
    {'id': 'driver_smoothDriving', 'role': 'driver', 'name': 'Smooth Ride', 'kind': 'skill',
     'eff': {'movementFactor': ['mul', 0.96]}, 'situational': False,
     'note': 'driving only, never hull rotation'},
    {'id': 'gunner_armorer', 'role': 'gunner', 'name': 'Armorer', 'kind': 'skill',
     'eff': {'multFactor': ['mul', 0.985]}, 'situational': False,
     'note': 'also moves the penetration roll, which the circle does not see'},
    {'id': 'gunner_quickAiming', 'role': 'gunner', 'name': 'Quick Aiming', 'kind': 'skill',
     'eff': {'aimingTimeFactor': ['mul', 0.975], 'turretRotationSpeed': ['mul', 1.025]},
     'situational': False},
    {'id': 'driver_virtuoso', 'role': 'driver', 'name': 'Clutch Braking', 'kind': 'skill',
     'eff': {'hullRotationSpeed': ['mul', 1.05]}, 'situational': False,
     'note': 'the hull turns faster, so it also comes round sooner'},
    {'id': 'loader_magMastery', 'role': 'loader', 'name': 'Mag Mastery', 'kind': 'skill',
     'eff': {'clipInterval': ['mul', 0.975]}, 'situational': False,
     'note': 'the interval between the rounds of a clip'},
    {'id': 'gunner_focus', 'role': 'gunner', 'name': 'Concentration', 'kind': 'perk',
     'eff': {'multFactor': ['mul', 0.965]}, 'situational': True, 'when': 'while the vehicle stands still'},
    {'id': 'gunner_loneWolf', 'role': 'gunner', 'name': 'Lone Wolf', 'kind': 'perk',
     'eff': {'multFactor': ['mul', 0.95], 'aimingTimeFactor': ['mul', 0.95]}, 'situational': True,
     'when': 'while no ally is near'},
    {'id': 'commander_coordination', 'role': 'commander', 'name': 'Coordination', 'kind': 'perk',
     'eff': {'aimingTimeFactor': ['mul', 0.875]}, 'situational': True,
     'when': 'on a target an ally has spotted'},
    {'id': 'loader_desperado', 'role': 'loader', 'name': 'Adrenaline Rush', 'kind': 'perk',
     'eff': {'reloadTimeFactor': ['mul', 0.95]}, 'situational': True, 'when': 'below 25 % of the health'},
    {'id': 'loader_melee', 'role': 'loader', 'name': 'Close Combat', 'kind': 'perk',
     'eff': {'reloadTimeFactor': ['mul', 0.975]}, 'situational': True, 'when': 'at close range'},
    {'id': 'loader_secondChance', 'role': 'loader', 'name': 'Second Chance', 'kind': 'perk',
     'eff': {'reloadTimeFactor': ['mul', 0.975]}, 'situational': True, 'when': 'after a miss'},
    {'id': 'commander_emergency', 'role': 'commander', 'name': 'Emergency', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 5]}, 'situational': True, 'when': 'while a crew member is knocked out'},
    {'id': 'commander_holdLine', 'role': 'commander', 'name': 'Hold the Line', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 5]}, 'situational': True, 'when': 'while holding a position'},
    {'id': 'commander_staySharp', 'role': 'commander', 'name': 'Stay Sharp', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 5]}, 'situational': True, 'when': 'while nothing is spotted'},
    {'id': 'driver_bulletproof', 'role': 'driver', 'name': 'Bulletproof', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 5]}, 'situational': True, 'when': 'after taking a hit'},
    {'id': 'radioman_expert', 'role': 'radioman', 'name': 'Communications Expert', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 2.5]}, 'situational': True, 'when': 'while in radio range of an ally'},
    {'id': 'radioman_sideBySide', 'role': 'radioman', 'name': 'Side By Side', 'kind': 'perk',
     'eff': {'crewLevel': ['add', 2.5]}, 'situational': True, 'when': 'while an ally is near'},
]
# The five crew roles of the client (items/components/skills_constants.pyc ROLES), in the order the page
# groups the crew tiles. There is no "whole crew" group any more: the one skill that belonged to it, Brothers
# in Arms, now has a tile in every role group.
ROLE_ORDER = ['commander', 'gunner', 'driver', 'loader', 'radioman']
ROLE_NAMES = {'commander': 'Commander', 'gunner': 'Gunner', 'driver': 'Driver',
              'loader': 'Loader', 'radioman': 'Radio Operator'}

# Consumables that reach the maths. Every food ration is the same +10 crew levels, so the page offers one
# food slot rather than eleven national names; the nation-locked names are kept for the tooltip.
FOOD = ['ration', 'chocolate', 'cocacola', 'hotCoffee', 'ration_china', 'ration_uk', 'ration_japan',
        'ration_czech', 'ration_sweden', 'ration_poland', 'ration_italy']
CONSUMABLES = [
    {'id': 'food', 'name': 'Combat rations', 'icon': 'ration', 'slot': 'food',
     'eff': {'crewLevel': ['add', 10]},
     'note': 'Chocolate, Cola, Strong Coffee, Onigiri and the rest are one effect: +10 crew levels for the '
             'whole battle. One per vehicle, by nation.'},
    {'id': 'qualityFuel', 'name': 'Quality Fuel', 'icon': 'qualityFuel', 'slot': 'fuel',
     'eff': {'turretRotationSpeed': ['mul', 1.05], 'enginePower': ['mul', 1.05]},
     'note': 'Fuel.updateVehicleAttrFactorsForAspect writes turret/rotationSpeed as well as engine/power.'},
    {'id': 'excellentFuel', 'name': 'Excellent Fuel', 'icon': 'excellentFuel', 'slot': 'fuel',
     'eff': {'turretRotationSpeed': ['mul', 1.1], 'enginePower': ['mul', 1.1]},
     'note': 'Fuel.updateVehicleAttrFactorsForAspect writes turret/rotationSpeed as well as engine/power.'},
]


def parse_filter(text):
    """The device's <vehicleFilter> as data: which vehicles may mount it.

    include = the vehicle must match at least one clause; exclude = it must match none. Inside a clause
    `tags` is any-of, `mandatoryTags` is all-of, and the levels are inclusive bounds. An empty filter means
    every vehicle, which is what the client's own _VehicleFilter does with no <include>.
    """
    if not text:
        return None
    root = ET.fromstring(text.encode('utf-8') if isinstance(text, bytes) else text)
    out = {}
    for side in ('include', 'exclude'):
        clauses = []
        for group in root.findall(side):
            for vehicle in group.findall('vehicle'):
                clause = {}
                for key, field in (('tags', 'tags'), ('mandatoryTags', 'mandatoryTags')):
                    node = vehicle.find(key)
                    if node is not None and (node.text or '').split():
                        clause[field] = (node.text or '').split()
                for key in ('minLevel', 'maxLevel'):
                    node = vehicle.find(key)
                    if node is not None and (node.text or '').strip():
                        clause[key] = int((node.text or '').strip())
                if clause:
                    clauses.append(clause)
        if clauses:
            out[side] = clauses
    return out or None


def device_rows(data):
    rows = []
    for entry, row in data['devices'].items():
        effects = {}
        for effect in row.get('effects') or ():
            name = PAGE_INPUT.get(effect.get('pageInput') or '')
            if not name:
                continue
            values = [float(v) for v in effect.get('valueByLevel') or ()]
            if not values:
                continue
            effects[name] = [effect.get('op') or 'mul'] + values
        if not effects:
            continue
        family = row['archetype']
        rows.append({
            'id': entry,
            'family': family,
            'tier': row.get('tier'),
            'name': row.get('name_en') or entry,
            'icon': row.get('icon') or family,
            'cat': list(row.get('categories') or ()),
            'blocks': ((row.get('incompatibleTags') or {}).get('installed') or '').split() or [family],
            'eff': effects,
            'fit': parse_filter(row.get('vehicleFilter')),
        })
    # One Bounty tile per device, and it is the upgraded one (user, 21.09). A Bounty piece is upgraded
    # with the same bonds sooner or later, so the un-upgraded trophyBasic entry is a state nobody keeps
    # a build in; offering both would only split the grade into two tiles that share one badge.
    rows = [row for row in rows if row['tier'] != 'bounty']
    for row in rows:
        if row['tier'] == 'bounty_upgraded':
            row['tier'] = 'bounty'
    order = dict((name, index) for index, name in enumerate(FAMILY_ORDER))
    tier = dict((name, index) for index, name in enumerate(TIER_ORDER))
    rows.sort(key=lambda r: (order.get(r['family'], 99), tier.get(r['tier'], 99), r['id']))
    return rows


def families(rows):
    seen, out = set(), []
    for row in rows:
        if row['family'] in seen:
            continue
        seen.add(row['family'])
        out.append({'id': row['family'], 'name': FAMILY_NAMES.get(row['family'], row['family']),
                    'icon': row['icon'], 'what': FAMILY_WHAT.get(row['family'], '')})
    return out


def skill_rows():
    """The crew rows with the icon file the page draws them with.

    The crew tiles carry no caption any more, so every row needs art. The client's own perk icon is named
    after the perk itself (gui/maps/icons/tankmen/skills/big/<id>.png), and all nineteen are in web/icons
    already — the field is written out rather than assumed by the page, like every other icon here.
    """
    rows = []
    for skill in SKILLS:
        row = dict(skill)
        row['icon'] = skill['id']
        rows.append(row)
    return rows


def directive_rows(data):
    """The directives that land on one of our factors, with the device grade each factor depends on."""
    out = []
    for entry, row in data['directives'].items():
        levels = []
        for level in row.get('levels') or ():
            name = {'additiveShotDispersionFactor': 'additiveFactor',
                    'multShotDispersionFactor': 'multFactor',
                    'gunAimingTimeFactor': 'aimingTimeFactor',
                    'gun/aimingTime': 'aimingTimeFactor',
                    'gunReloadTimeFactor': 'reloadTimeFactor',
                    'gun/reloadTime': 'reloadTimeFactor',
                    'crewLevelIncrease': 'crewLevel',
                    'engine/power': 'enginePower'}.get(level.get('attribute') or '')
            if not name:
                continue
            factor, value = level.get('factor'), level.get('value')
            levels.append({'needs': list(level.get('requiredDeviceTags') or ()),
                           'not': list(level.get('incompatibleDeviceTags') or ()),
                           'eff': {name: ['mul', float(factor)] if factor is not None
                                   else ['add', float(value)]}})
        skill = row.get('skillName')
        if not levels and not skill:
            continue
        # A directive has its own art in the client, named after the entry; the research file's "icon" is
        # the device the directive is named for, which would make the two tiles identical on screen.
        item = {'id': entry, 'name': row.get('name_en') or entry, 'icon': entry,
                'deviceIcon': row.get('icon') or entry}
        if levels:
            item['levels'] = levels
        if skill and row.get('perkLevelMultiplier'):
            item['skill'] = skill
            item['skillMult'] = float(row['perkLevelMultiplier'])
        out.append(item)
    # Only the ones that reach the page's own maths: a skill directive counts when the page models that
    # skill, and an equipment directive when at least one of its levels moves an input the page uses.
    # enginePower does not qualify — the movement term reads the speed cap, not the power that gets there,
    # so the Fuel Filter Replacement would sit in the menu changing nothing.
    known = set(s['id'] for s in SKILLS)

    def lands(row):
        for level in row.get('levels') or ():
            for name in level['eff']:
                if name != 'enginePower':
                    return True
        return False

    out = [row for row in out if lands(row) or row.get('skill') in known]
    out.sort(key=lambda r: r['name'])
    return out


def dump(value, indent):
    """JSON that reads like hand-written JavaScript: one line per record, no dangling whitespace."""
    return json.dumps(value, ensure_ascii=False, separators=(', ', ': '), sort_keys=False)


def main():
    data = json.load(io.open(CATALOGUE, encoding='utf-8'))
    devices = device_rows(data)
    lines = [
        '// The client\'s own equipment, crew skills, directives and consumables — everything in the game',
        '// that moves a number the aiming maths reads, and nothing else.',
        '//',
        '// Generated by tools/build_equipment_catalogue.py from a decoded copy of the installed client',
        '// (%s); do not edit by hand. Every factor below is the client\'s own,' % CLIENT,
        '// read out of optional_devices.xml, tankmen.xml, perks.xml, battle_boosters.xml and',
        '// vehicle_equipments.xml. Where a device has two numbers they are [plain, with the slot bonus]:',
        '// the client hands out the second figure when the slot\'s category matches the piece, and only',
        '// standard pieces carry a category at all. The page always takes the LAST figure (user, 21.09):',
        '// the difference is a rounding error, and tracking which slot is categorised cost an interface',
        '// nobody wanted. "cat" and "slotTypes" are the client\'s own data and are kept for the record.',
        '//',
        '// "eff" maps a page input to [operation, value...]: mul multiplies it, add adds to it. The inputs',
        '// are the fields of the recorded aim block, plus crewLevel, which enters through the crew law',
        '// f = 0.57 + 0.43 × efficiency.',
        '(function () {',
        '  \'use strict\';',
        '  window.AIM_CATALOGUE = {',
        '    client: %s,' % dump(CLIENT, 4),
        '    categories: %s,' % dump(CATEGORY_NAMES, 4),
        '    slotTypes: %s,' % dump(dict((str(k), v) for k, v in sorted(SLOT_TYPES.items())), 4),
        '    tiers: [',
    ]
    for tier in TIERS:
        lines.append('      %s,' % dump(tier, 6))
    lines.append('    ],')
    lines.append('    families: [')
    for family in families(devices):
        lines.append('      %s,' % dump(family, 6))
    lines.append('    ],')
    lines.append('    devices: [')
    for device in devices:
        lines.append('      %s,' % dump(device, 6))
    lines.append('    ],')
    lines.append('    roles: %s,' % dump([{'id': r, 'name': ROLE_NAMES[r]} for r in ROLE_ORDER], 4))
    lines.append('    skills: [')
    for skill in skill_rows():
        lines.append('      %s,' % dump(skill, 6))
    lines.append('    ],')
    lines.append('    directives: [')
    for directive in directive_rows(data):
        lines.append('      %s,' % dump(directive, 6))
    lines.append('    ],')
    lines.append('    consumables: [')
    for consumable in CONSUMABLES:
        lines.append('      %s,' % dump(consumable, 6))
    lines.append('    ],')
    lines.append('    food: %s' % dump(FOOD, 4))
    lines.append('  };')
    lines.append('})();')
    io.open(TARGET, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    print('web/equipment.js: %d devices, %d families, %d skills, %d directives, %d consumables'
          % (len(devices), len(families(devices)), len(SKILLS), len(directive_rows(data)), len(CONSUMABLES)))


if __name__ == '__main__':
    main()
