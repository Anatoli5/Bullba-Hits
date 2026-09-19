"""Armor metadata from live descriptors, with a version-checked XML fallback."""
from __future__ import absolute_import
import copy
import glob
import os
import re
import zipfile
from .packed_xml import decode

FLAGS = ('useHitAngle', 'mayRicochet', 'collideOnceOnly', 'checkCaliberForRicochet',
         'checkCaliberForHitAngleNorm', 'useArmorHomogenization')
NUMBERS = ('armor', 'vehicleDamageFactor', 'chanceToHitByProjectile')


def live_materials(component):
    from material_kinds import NAMES_BY_IDS
    from items import vehicles
    materials = dict(vehicles.g_cache.commonConfig['materials'])
    materials.update(component.materials)
    result = {}
    for kind, material in materials.items():
        name = NAMES_BY_IDS.get(kind)
        if not name: continue
        value = dict((key, bool(getattr(material, key))) for key in FLAGS)
        value.update((key, float(getattr(material, key)) if getattr(material, key, None) is not None else None) for key in NUMBERS)
        if value['armor'] is not None and value['useArmorHomogenization']:
            value['armor'] *= float(getattr(component, 'armorHomogenization', 1.0))
        result[name] = value
    return result


def shot_candidates(descriptor, effects_index=None):
    result = []
    for shot in descriptor.gun.shots:
        if effects_index is not None and shot.shell.effectsIndex != effects_index: continue
        if shot.shell.kind not in ('ARMOR_PIERCING', 'ARMOR_PIERCING_CR', 'HOLLOW_CHARGE', 'HIGH_EXPLOSIVE'): continue
        result.append(shot_parameters(shot, 'attacker descriptor gun shots' if effects_index is None else 'attacker descriptor matched by effectsIndex'))
    return result


def number(value, default=0.0):
    """A float out of a client attribute; anything unexpected (None, a missing slot) reads as the default."""
    try: return float(value)
    except Exception: return default


def pair(value):
    """(near, far) of a damage pair, as floats. A single value counts for both, anything else is zero."""
    try: return [float(value[0]), float(value[1])]
    except Exception: return [number(value), number(value)]


def damage_parameters(shell, shell_type):
    """Damage fields of a shell, for the page's expected-damage map. Never raises: every field is a
    getattr with a default, and an absent one stays None so the page can tell "no data" from zero.
    'spallDamage' is armorSpalls.armorDamage[0] of modern HE (the client's own maxDamage), the
    non-penetration base of the ratio law; 'mechanics' of HE without the attribute is LEGACY (SPG shells)."""
    armor = pair(getattr(shell, 'armorDamage', None))
    mechanics = getattr(shell_type, 'mechanics', None)
    if mechanics is None and getattr(shell, 'kind', None) == 'HIGH_EXPLOSIVE': mechanics = 'LEGACY'
    spalls = getattr(shell_type, 'armorSpalls', None)
    spall_damage = spall_radius = None
    if spalls is not None and getattr(spalls, 'isActive', False):
        spall_damage = pair(getattr(spalls, 'armorDamage', None))[0]
        spall_radius = number(getattr(spalls, 'radius', 0))
    top = getattr(shell_type, 'maxDamage', None)
    return {'alpha':armor[0], 'alphaFar':armor[1],
        'deviceDamage':pair(getattr(shell, 'deviceDamage', None))[0],
        'damageRandomization':number(getattr(shell, 'damageRandomization', 0)),
        'damageRandomizationType':getattr(shell, 'damageRandomizationType', None),
        'mechanics':mechanics, 'maxDamage':None if top is None else number(top),
        'explosionRadius':number(getattr(shell_type, 'explosionRadius', 0)),
        'spallDamage':spall_damage, 'spallRadius':spall_radius,
        'nonPiercingArmorDamage':number(getattr(shell_type, 'nonPiercingArmorDamage', 0))}


def shot_parameters(shot, source):
        from constants import SHELL_TYPES_INDICES
        shell = shot.shell
        shell_type = shell.type
        damage = damage_parameters(shell, shell_type)
        damage.update({'name':getattr(shell, 'userString', shell.name), 'kind':shell.kind,
            'typeIndex':int(SHELL_TYPES_INDICES[shell.kind]),
            'caliber':float(shell.caliber), 'penetration100':float(shot.piercingPower[0]),
            'penetration500':float(shot.piercingPower[1]),
            'normalization':float(getattr(shell_type, 'normalizationAngle', 0)),
            'ricochetCos':float(getattr(shell_type, 'ricochetAngleCos', -1)),
            'jetLossPerMeter':float(getattr(shell_type, 'piercingPowerLossFactorByDistance', 0)),
            'randomization':float(shell.piercingPowerRandomization),
            'randomizationType':shell.piercingPowerRandomizationType,
            'shieldPenetration':bool(getattr(shell_type, 'shieldPenetration', False)),
            'speed':float(getattr(shot, 'speed', 0)), 'gravity':float(getattr(shot, 'gravity', 0)),
            'maxDistance':float(getattr(shot, 'maxDistance', 0)), 'effectsIndex':int(shell.effectsIndex),
            'source':source})
        return damage


class ArmorCatalog(object):
    def __init__(self, game):
        self.game = game
        self.cache = {}

    def xml(self, name):
        for folder in glob.glob(os.path.join(self.game, 'res_mods', '*')):
            if os.path.isfile(os.path.join(folder, name)): raise ValueError('Armor definitions overridden in res_mods')
        for archive in glob.glob(os.path.join(self.game, 'mods', '*', '*.wotmod')):
            with zipfile.ZipFile(archive) as z:
                if 'res/'+name in z.namelist(): raise ValueError('Armor definitions overridden by a mod')
        with zipfile.ZipFile(os.path.join(self.game, 'res', 'packages', 'scripts.pkg')) as z:
            if z.getinfo(name).file_size > 8*1024*1024: raise ValueError('Armor definition too large')
            return decode(z.read(name))

    def materials(self, vehicle_type, resource):
        key = (vehicle_type, resource)
        if key in self.cache: return self.cache[key]
        if not re.match(r'^[a-z]+:[A-Za-z0-9_]+\Z', vehicle_type): raise ValueError('Invalid vehicle type')
        nation, vehicle = vehicle_type.split(':')
        tree = self.xml('scripts/item_defs/vehicles/'+nation+'/'+vehicle+'.xml')
        candidates = [node for node in tree.iter() if node.findtext('hitTester/collisionModelClient') == resource]
        if len(candidates) != 1: raise ValueError('Armor component cannot be matched unambiguously')
        component = candidates[0]
        armor = component.find('armor')
        if armor is None:
            tracks = [p.find('armor') for p in component.findall('trackPairParams') if p.findtext('trackPairIdx') == '0']
            if len(tracks) == 1: armor = tracks[0]
        if armor is None: raise ValueError('Armor table unavailable for this component')
        common = self.xml('scripts/item_defs/vehicles/common/vehicle.xml').find('materials')
        result = {}
        for node in common:
            value = dict((k, (node.findtext(k) or '').lower() == 'true') for k in FLAGS)
            value.update({'armor':0.0 if node.findtext('extra') else None,
                'vehicleDamageFactor':float(node.findtext('vehicleDamageFactor') or 0),
                'chanceToHitByProjectile':float(node.findtext('chanceToHitByProjectile') or 1)})
            result[node.tag] = value
        homogenization = float(component.findtext('armorHomogenization') or 1)
        for node in armor:
            if node.tag not in result: raise ValueError('Unknown armor material '+node.tag)
            value = result[node.tag]
            value['armor'] = float(node.text)
            for prop in node:
                if prop.tag in FLAGS: value[prop.tag] = (prop.text or '').lower() == 'true'
                elif prop.tag in NUMBERS: value[prop.tag] = float(prop.text)
            if value['useArmorHomogenization']: value['armor'] *= homogenization
        self.cache[key] = result
        return copy.deepcopy(result)
