# -*- coding: utf-8 -*-
"""A tier-XI vehicle's characteristics file carries its WHOLE skill tree (the user, 09.10: "the panel says 40 km/h, the
upgrade gives plus 2 - the upgrades are not counted"; the decision of 26.09: the tier-XI tree is always taken as fully
researched; docs/DEFECTS.md D-112), on the offline stand of the client's own items.vehicles.

    python tests/py27/run27.py tests/py27/ttx_skill_tree.py

What exporter.ttx_block writes is compared with what the client's own files say, by another road than the one the build
takes: the same block built with the tree left out (the bare vehicle) plus the tree's nodes as the client's cache holds them
(g_cache.postProgression().modifications[id].modifiers) - never with a figure kept in this file.

  1  his case, the Pz.Kpfw. Neu: every node of its tree that moves a field of the file is in the file - the top speed first -
     and, where the local fixture is on this machine (tests/fixtures-local/xi-tree-2026-10-09: his numbers, 40 -> 42 km/h), the
     file holds exactly them;
  2  every vehicle whose tree has no pair (the tier-XI skill trees) the same way; a vehicle with a role tree (its sides are the
     user's choice in Config) and one with no tree are written exactly as without this rule;
  3  the client is only read: a descriptor made after the builds is the bare one, the second mode's descriptor carries the tree
     too, the same type built again gives the same file;
  4  a tree the client refuses costs that vehicle its tree - the file is the bare one with a line in 'warnings' - never the
     build of that vehicle or of the next one;
  5  freshness: the tree's own files are in the keys of its vehicle - the characteristics' and the vehicle file's - and of
     nobody else's; a file written before this rule is not current;
  6  the vehicle file (data/vehicles/<id>.js, which the page takes a browsed vehicle's shooter from) carries the tree too: its
     aim block, shells, health and gun limits are the characteristics file's; nothing else of it moves; the descriptor the
     records read stays bare; a tree the client refuses leaves the bare file with a warning.
Verdict through BULLBA_PY27_RESULT (see run27.py). No stand, no client: SKIP.
"""
import json, math, os, sys, tempfile, traceback
REPO = os.environ.get('BULLBA_REPO') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.environ.get('BULLBA_GAME', 'C:/Games/World_of_Tanks_NA')
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline')
FIXTURE = os.path.join(REPO, 'tests', 'fixtures-local', 'xi-tree-2026-10-09', 'pz-neu-expected.json')
RESULT = os.environ.get('BULLBA_PY27_RESULT')
HIS = 'germany:G197_Pz_Kpfw_Neu'
ROLE_TREE, NO_TREE = 'ussr:R45_IS-7', 'germany:G27_VK3001P'
report, failures = [], []


def finish(lines, code):
    text = 'exit %d\n%s\n' % (code, '\n'.join(lines))
    if RESULT:
        with open(RESULT, 'wb') as stream: stream.write(text)
    else:
        sys.stdout.write(text)


def check(ok, name, detail=''):
    report.append(('ok   ' if ok else 'FAIL ') + name + (' (%s)' % (detail,) if detail != '' and not ok else ''))
    if not ok: failures.append(name)


def near(a, b, tolerance=1e-6):
    try:
        return abs(float(a) - float(b)) <= tolerance * max(1.0, abs(float(b)))
    except Exception:
        return False


def top(block):
    found = [c for c in block['configs'] if c.get('top')]
    return found[0] if found else block['configs'][0]


def shells(block, config):
    return config.get('shells') or block['shells'][config['gun']]


def main():
    if not os.path.isfile(os.path.join(STAND, 'boot27.py')) or not os.path.isdir(os.path.join(GAME, 'res', 'packages')):
        return finish(['SKIP: no offline stand (%s) or no client (%s)' % (STAND, GAME)], 77)
    saved = sys.stdout, sys.stderr
    try:
        # A module of its own, so the stand's stand-in classes can be found by name: the client copies the parameters of
        # four tier-XI mechanics through pickle (a vector among them), which looks the class up in its module.
        import imp
        stand = sys.modules['ttx_stand'] = imp.new_module('ttx_stand')
        scope = stand.__dict__
        execfile(os.path.join(STAND, 'boot27.py'), scope)
        vehicles = scope['boot']()
    except Exception:
        sys.stdout, sys.stderr = saved
        return finish(['SKIP: the stand did not boot on this client:\n' + traceback.format_exc()], 77)
    sys.stdout, sys.stderr = saved
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import exporter as ex, client_snapshot
    import nations
    from post_progression_common import ACTION_TYPES
    from items.components import component_constants as constants
    cache = vehicles.g_cache.postProgression()
    speed_factor = float(vehicles.g_cache.commonConfig['miscParams']['projectileSpeedFactor'])
    plain = lambda block: json.loads(json.dumps(dict((k, v) for k, v in block.items() if k not in ex.Exporter.TTX_VOLATILE)))

    def tree_of(type_name):
        """(tree id, [modification id], has a pair) as the client's cache holds the vehicle's tree; (None, [], False)."""
        descr = vehicles.VehicleDescr(typeID=vehicles.g_list.getIDsByName(type_name))
        tree_id = getattr(descr.type, 'postProgressionTree', None)
        tree = cache.trees.get(tree_id) if tree_id is not None else None
        if tree is None: return None, [], False
        actions = [step.action for step in tree.steps.values()]
        return (tree_id, sorted(item for kind, item in actions if kind == ACTION_TYPES.MODIFICATION),
                any(kind == ACTION_TYPES.PAIR_MODIFICATION for kind, item in actions))

    def nodes_of(ids, mode='default'):
        """{'descrAttrs/engine/power': ('add', [100.0])} of the nodes that act on the descriptor of `mode`."""
        found = {}
        for item in ids:
            for op, kind, name, value, where in cache.modifications[item].modifiers:
                if where not in ('common', mode): continue
                entry = found.setdefault(str(kind) + str(name), (str(op), []))
                entry[1].append(float(value))
        return found

    def bare_block(type_name):
        """The file of the vehicle with its tree left out: ttx_block itself, the tree's list emptied."""
        kept = getattr(ex, 'skill_tree_modifications', None)
        ex.skill_tree_modifications = lambda vtype: ()
        try:
            return ex.ttx_block(type_name, 'test', log=False)
        finally:
            if kept is None: del ex.skill_tree_modifications
            else: ex.skill_tree_modifications = kept

    # The fields of the file a node moves: (the node, how the file's figure is read, the client's unit of the node -> the
    # file's: descr_modify_attrs' own processors - km/h, hp, degrees, m per 100 m, the XML shell speed).
    def shell_field(index, key):
        return lambda block, config: shells(block, config)[index][key] if len(shells(block, config)) > index else None
    aim = lambda key, scale=1.0: (lambda block, config: config['aim'][key] * scale)
    FIELDS = [('descrAttrs/engine/maxSpeedForward', aim('speedForward', 1.0 / constants.KMH_TO_MS), 1.0),
              ('descrAttrs/engine/maxSpeedBack', aim('speedBackward', 1.0 / constants.KMH_TO_MS), 1.0),
              ('descrAttrs/engine/power', lambda block, config: block['modules']['engine']['power'], constants.HP_TO_WATTS),
              ('descrAttrs/hull/maxHealth', lambda block, config: config['maxHealth'], 1.0),
              ('descrAttrs/chassis/rotationSpeedDegrees', aim('hullRotationSpeed', 180.0 / math.pi), 1.0),
              ('descrAttrs/turret/rotationSpeedDegrees', aim('turretRotationSpeed', 180.0 / math.pi), 1.0),
              ('descrAttrs/turret/circularVisionRadius',
               lambda block, config: block['turrets'][config['turret']]['circularVisionRadius'], 1.0),
              ('descrAttrs/gun/maxAmmo', lambda block, config: config['maxAmmo'], 1.0),
              ('descrAttrs/gun/aimingTime', aim('aimingTime'), 1.0),
              ('descrAttrs/gun/reloadTime', aim('reloadTime'), 1.0),
              ('descrAttrs/gun/shotDispersionRadius', lambda block, config: math.tan(config['aim']['dispersion']) * 100.0, 1.0),
              ('descrAttrs/gun/invisibilityFactorAtShot', lambda block, config: config['invisibilityFactorAtShot'], 1.0),
              ('descrAttrs/chassis/shotDispersionFactors/0', aim('movementFactor'), 1.0),
              ('descrAttrs/chassis/shotDispersionFactors/1', aim('rotationFactor'), 1.0),
              ('descrAttrs/siegeModeParams/switchOnTime', lambda block, config: config['aim']['siegeMode']['switchOnTime'], 1.0),
              ('descrAttrs/siegeModeParams/switchOffTime', lambda block, config: config['aim']['siegeMode']['switchOffTime'], 1.0),
              # The gun's own factors the client keeps a copy of in miscAttrs, which is what a node multiplies and what the
              # battle's circle reads (vehicles __updateAttributes; tools/build_equipment_catalogue.py FIELD_INPUT).
              ('miscAttrs/gun/shotDispersionFactors/turretRotation', aim('turretRotationFactor'), 1.0),
              ('miscAttrs/gun/shotDispersionFactors/afterShot', aim('afterShotFactor'), 1.0)]
    for index in range(3):
        FIELDS += [('descrAttrs/shot%d/piercingPower' % index, shell_field(index, 'penetration100'), 1.0),
                   ('descrAttrs/shot%d/speed' % index, shell_field(index, 'speed'), speed_factor),
                   ('descrAttrs/shell%d/armorDamage' % index, shell_field(index, 'alpha'), 1.0)]

    def compare(type_name, block, bare, ids):
        """[(node, expected, the file's)] of the nodes the file does not carry; the number of nodes looked at."""
        nodes, missed, seen = nodes_of(ids), [], 0
        for node, read, unit in FIELDS:
            if node not in nodes: continue
            op, values = nodes[node]
            try:
                before, after = float(read(bare, top(bare))), float(read(block, top(block)))
            except Exception:
                continue   # the vehicle has no such field (a shell the gun does not fire, no mode switch)
            seen += 1
            if op == 'add': expected = before + sum(values) * unit
            elif len(values) == 1: expected = before * values[0]
            else:
                # Several multipliers on one figure: the client's own law of merging them is not repeated here - the
                # figure must have moved their way and no further than their product or the sum of their deviations.
                bounds = (before * reduce(lambda a, b: a * b, values), before * (1.0 + sum(v - 1.0 for v in values)), before)
                low, high = min(bounds), max(bounds)
                if not (low - 1e-9 <= after <= high + 1e-9 and after != before): missed.append((node, (low, high), after))
                continue
            if not near(after, expected): missed.append((node, expected, after))
        return missed, seen

    # ---- 1. his case -----------------------------------------------------------------------------------------------
    tree_id, ids, pairs = tree_of(HIS)
    check(tree_id is not None and ids and not pairs, '1: the Pz.Kpfw. Neu has a skill tree without pairs in this client',
          (tree_id, len(ids), pairs))
    bare = bare_block(HIS)
    block = ex.ttx_block(HIS, 'test', log=False)
    nodes = nodes_of(ids)
    forward = nodes.get('descrAttrs/engine/maxSpeedForward')
    check(forward is not None and forward[0] == 'add' and sum(forward[1]) > 0, '1: its tree has a top speed node', forward)
    kmh = lambda b: top(b)['aim']['speedForward'] / constants.KMH_TO_MS
    check(forward is not None and near(kmh(block), kmh(bare) + sum(forward[1])),
          '1: HIS CASE - the file\'s top speed is the bare vehicle\'s plus the node of its tree',
          'file %.2f km/h, bare %.2f, node %s' % (kmh(block), kmh(bare), forward and sum(forward[1])))
    missed, seen = compare(HIS, block, bare, ids)
    check(seen >= 10 and not missed, '1: every node of its tree that moves a field of the file is in the file',
          '%d looked at; not carried: %s' % (seen, missed[:6]))
    marker = (block.get('vehicle') or {}).get('skillTree')
    check(marker == {'tree': str(tree_id), 'modifications': len(ids)}, '1: the file says which tree it carries and how many nodes',
          marker)
    check(block.get('warnings') == [], '1: and no warning', block.get('warnings'))
    if os.path.isfile(FIXTURE):
        want = json.load(open(FIXTURE))
        config, his_shells = top(block), shells(block, top(block))
        got = {'speedForwardKmh': round(kmh(block), 2), 'speedBackwardKmh': round(config['aim']['speedBackward'] / constants.KMH_TO_MS, 2),
               'enginePowerW': block['modules']['engine']['power'], 'maxHealth': config['maxHealth'],
               'penetration100': [s['penetration100'] for s in his_shells], 'penetration500': [s['penetration500'] for s in his_shells],
               'alpha': [s['alpha'] for s in his_shells], 'shellSpeed': [s['speed'] for s in his_shells],
               'hullRotationSpeed': config['aim']['hullRotationSpeed'],
               'circularVisionRadius': block['turrets'][config['turret']]['circularVisionRadius'], 'maxAmmo': config['maxAmmo'],
               'movementFactor': config['aim']['movementFactor'], 'rotationFactor': config['aim']['rotationFactor'],
               'pitchAbsolute': config['pitch']['absolute'], 'switchOnTime': config['aim']['siegeMode']['switchOnTime'],
               'switchOffTime': config['aim']['siegeMode']['switchOffTime']}
        if want.get('client') and want['client'] not in open(os.path.join(GAME, 'version.xml')).read():
            report.append('SKIP 1: his numbers are client %s\'s, this is another client' % want['client'])
        else:
            same = lambda a, b: all(near(x, y) for x, y in zip(a, b)) and len(a) == len(b) if isinstance(a, list) else near(a, b)
            wrong = sorted(k for k in want['full'] if not same(got[k], want['full'][k]))
            check(not wrong, '1: HIS NUMBERS - the file holds what the garage shows with the whole tree (42 km/h forward)',
                  ', '.join('%s %s, wanted %s' % (k, got[k], want['full'][k]) for k in wrong))
    else:
        report.append('SKIP 1: his numbers are not on this machine (%s)' % FIXTURE)

    # ---- 2. every skill tree, and nobody else ------------------------------------------------------------------------
    # The vehicles with a skill tree, without parsing the whole catalogue (1252 types, half a minute): every tree of the
    # client's cache that has no pair, and the vehicle each tree's files are named after (the keys' own rule, section 5) -
    # so a tree whose files are not named after its vehicle fails here, before it is missed by a key.
    catalogue, skill = [], []
    for nation in nations.NAMES:
        for item in vehicles.g_list.getList(nations.INDICES[nation]).values():
            catalogue.append('%s:%s' % (nation, item.name.split(':')[-1]))
    members = client_snapshot.package_members(os.path.join(GAME, 'res', 'packages', 'scripts.pkg'))
    named = set(match.group(1) for match in (getattr(ex, 'TTX_TREE', None) and ex.TTX_TREE.match(name) for name in members) if match)
    for type_name in sorted(t for t in catalogue if t.split(':')[1] in named):
        found = tree_of(type_name)
        if found[1] and not found[2]: skill.append((type_name, found[0], found[1]))
    pairless = sorted(tree_id for tree_id, tree in cache.trees.items()
                      if not any(step.action[0] == ACTION_TYPES.PAIR_MODIFICATION for step in tree.steps.values()))
    check(pairless and sorted(s[1] for s in skill) == pairless and HIS in [s[0] for s in skill],
          '2: every tree without a pair is some vehicle\'s, found by the name of its files (%d trees)' % len(pairless),
          '%d vehicles for %d trees' % (len(skill), len(pairless)))
    wrong, looked, blocks, mixed = [], 0, {HIS: (block, bare)}, []
    for type_name, its_tree, its_ids in skill:
        if type_name == HIS: continue
        # In every order: the bare build before the one with the tree, after it, and the tree's again - the exporter's own
        # memos (the gun's heat, the second gun, the mode fields: keyed by the client's objects) and the client's cache must
        # hand each descriptor its own figures.
        before = bare_block(type_name)
        full, stock = blocks[type_name] = ex.ttx_block(type_name, 'test', log=False), bare_block(type_name)
        if plain(before) != plain(stock) or plain(ex.ttx_block(type_name, 'test', log=False)) != plain(full): mixed.append(type_name)
        missed, seen = compare(type_name, full, stock, its_ids)
        looked += seen
        if missed or seen < 5 or full.get('warnings') or (full.get('vehicle') or {}).get('skillTree') != {'tree': str(its_tree), 'modifications': len(its_ids)}:
            wrong.append((type_name, seen, missed[:3], full.get('warnings')))
    check(not wrong, '2: every other skill-tree vehicle carries its tree (%d nodes looked at)' % looked, wrong[:4])
    check(not mixed, '2: and its bare build is the same before and after the build with the tree, and the one with the tree the same twice', mixed[:6])
    for type_name, label in ((ROLE_TREE, 'a role tree'), (NO_TREE, 'no tree')):
        full, stock = ex.ttx_block(type_name, 'test', log=False), bare_block(type_name)
        check(plain(full) == plain(stock) and 'skillTree' not in full['vehicle'],
              '2: a vehicle with %s is written as before (%s)' % (label, type_name))

    # ---- 3. the client is only read ----------------------------------------------------------------------------------
    again = ex.ttx_block(HIS, 'test', log=False)
    check(plain(again) == plain(block), '3: the same vehicle built again gives the same file')
    check(plain(bare_block(HIS)) == plain(bare), '3: and its bare build, after the builds with the tree, is the bare vehicle still')
    fresh = vehicles.VehicleDescr(typeID=vehicles.g_list.getIDsByName(HIS))
    check(not list(fresh.modifications) and near(fresh.type.speedLimits[0] / constants.KMH_TO_MS,
                                                 kmh(bare)), '3: a descriptor the client makes afterwards is the bare one',
          (list(fresh.modifications), fresh.type.speedLimits[0] / constants.KMH_TO_MS))
    siege = [name for name, its_tree, its_ids in skill if any(c.get('modeAim') for c in blocks[name][0]['configs'])]
    moved = len([name for name in siege if top(blocks[name][0]).get('modeAim') != top(blocks[name][1]).get('modeAim')])
    check(not siege or moved == len(siege), '3: the second mode\'s block carries the tree too (%d vehicles with one)' % len(siege),
          '%d of %d moved' % (moved, len(siege)))

    # ---- 4. a tree the client refuses --------------------------------------------------------------------------------
    kept = getattr(ex, 'skill_tree_modifications', None)
    ex.skill_tree_modifications = lambda vtype: (999999999,)
    try:
        broken = error = None
        try:
            broken = ex.ttx_block(HIS, 'test', log=False)
        except Exception:
            error = traceback.format_exc()
        check(broken is not None, '4: a tree the client refuses does not lose the vehicle\'s file', error or '')
        if broken is not None:
            # But for the warning and the marker's count of nodes: none.
            strip = lambda b: dict(dict((k, v) for k, v in plain(b).items() if k != 'warnings'),
                                   vehicle=dict((k, v) for k, v in plain(b)['vehicle'].items() if k != 'skillTree'))
            check(strip(broken) == strip(bare) and broken['vehicle'].get('skillTree') == {'tree': str(tree_id), 'modifications': 0},
                  '4: the file is then the bare vehicle\'s, and says its tree is not in it', broken['vehicle'].get('skillTree'))
            check(any('kill tree' in line for line in broken.get('warnings') or ()), '4: and says so in its warnings', broken.get('warnings'))
        after = ex.ttx_block(ROLE_TREE, 'test', log=False)
        check(after.get('configs'), '4: the next vehicle is built')
    finally:
        if kept is None: del ex.skill_tree_modifications
        else: ex.skill_tree_modifications = kept
    check(plain(ex.ttx_block(HIS, 'test', log=False)) == plain(block), '4: and the refused one, built again with its tree, is whole')

    # ---- 5. freshness ------------------------------------------------------------------------------------------------
    crcs = ex.Exporter.source_crcs_of(members)
    e = ex.Exporter(tempfile.gettempdir(), tempfile.gettempdir(), 'test')
    names = sorted(catalogue)
    # The keys as the builds before this rule made them: the same sources without the trees' files.
    before_crcs = dict((name, crc) for name, crc in crcs.items() if not (getattr(ex, 'TTX_TREE', None) and ex.TTX_TREE.match(name)))
    for label, tag in (('characteristics', None), ('vehicle file', 'vehicle-%d' % ex.VEHICLE_FORMAT)):
        with_trees, without = e.ttx_source_keys(names, crcs, tag), e.ttx_source_keys(names, before_crcs, tag)
        changed = sorted(t for t in names if with_trees[t] != without[t])
        check(changed == sorted(s[0] for s in skill), '5: the tree\'s files are in the %s key of every skill-tree vehicle and of nobody else' % label,
              '%d keys differ, %d skill trees; first %s' % (len(changed), len(skill), changed[:3]))
    with_trees = e.ttx_source_keys(names, crcs)
    e.crcs, e.code_generation = crcs, lambda: 'g'
    live = e.ttx_keys(names)
    check(all(live[t] == with_trees[t] + '.g' for t in names) and skill, '5: the characteristics\' keys are the ones with the trees')
    his_files = sorted(n for n in crcs if '/veh_skill_configs/' + HIS.split(':')[1] + '_' in n)
    check(len(his_files) == 2, '5: the Pz.Kpfw. Neu\'s two tree files are among the sources', his_files)
    if his_files:
        moved_crcs = dict(crcs)
        moved_crcs[his_files[0]] = '00000000'
        then = e.ttx_source_keys(names, moved_crcs)
        check([t for t in names if then[t] != with_trees[t]] == [HIS], '5: a client update that changes its tree rebuilds its files alone',
              [t for t in names if then[t] != with_trees[t]][:4])
    current = getattr(ex, 'ttx_tree_current', None)
    # A file as the builds before this rule wrote it: the bare vehicle and no word about its tree.
    old = dict(plain(bare), vehicle=dict((k, v) for k, v in plain(bare)['vehicle'].items() if k != 'skillTree'))
    check(current is not None and not current(old) and current(plain(block)) and current(plain(ex.ttx_block(ROLE_TREE, 'test', log=False))),
          '5: a skill-tree vehicle\'s file written before this rule is not current; one with the tree, and any other vehicle\'s, is')

    # ---- 6. the vehicle file (data/vehicles/<id>.js) -------------------------------------------------------------------
    # The page takes a browsed vehicle's shooter from this file: its aim block, shells, gun limits and health (the user's
    # case with an export on disk, as he has for all 28: the panel's build column, the emulator and the shell list). The
    # stand has no collision models: the parts are left out here, the rest is export_vehicle itself.
    import base64
    # The stand has no gun_rotation_shared (native maths): a stand-in that reads the same definition - the lowest and the
    # highest knot of the gun's own curves - so the table's KEY is exercised on the client's real descriptors.
    import types as pytypes
    kept_rotation = sys.modules.get('gun_rotation_shared')
    rotation = sys.modules['gun_rotation_shared'] = pytypes.ModuleType('gun_rotation_shared')
    rotation.calcPitchLimitsFromDesc = lambda yaw, definition, pitch=0.0, joint=0.0: (
        min(float(point[1]) for point in definition['minPitch']), max(float(point[1]) for point in definition['maxPitch']))
    written = {}
    kept_write, kept_resource, kept_publish = ex.write_data, ex.part_resource, ex.Exporter.publish_vehicle_parts
    ex.write_data = lambda path, key, value: written.__setitem__(str(key), value) or 0
    ex.part_resource = lambda component: 'vehicles/x/collision_client/Hull.model'
    ex.Exporter.publish_vehicle_parts = lambda self, *a, **k: None
    folder = tempfile.mkdtemp()
    try:
        owner = ex.Exporter(GAME, folder, 'offline\n')
        owner.client_state = False

        def export(type_name):
            top_descr = ex.top_descriptor(type_name)
            compact = base64.b64encode(top_descr.makeCompactDescr()).decode('ascii')
            owner.vehicles.pop(ex.vehicle_id(type_name), None)
            written.clear()
            owner.export_vehicle({'vehicleType': type_name, 'source': 'catalogue', 'compactDescriptor': compact}, replay=True)
            del owner.jobs[:]
            owner.job_index.clear()
            return written.get('vehicle:' + ex.vehicle_id(type_name)), compact

        def bare_export(type_name):
            keep = getattr(ex, 'skill_tree_modifications', None)
            ex.skill_tree_modifications = lambda vtype: ()
            try:
                return export(type_name)[0]
            finally:
                if keep is None: del ex.skill_tree_modifications
                else: ex.skill_tree_modifications = keep
        strip = lambda record: dict((k, v) for k, v in json.loads(json.dumps(record, default=repr)).items()
                                    if k not in ('exportedAt', 'clientVersion', 'skillTree', 'warnings'))
        record, compact = export(HIS)
        stock = bare_export(HIS)
        pair = top(block)
        check(record is not None and stock is not None, '6: the vehicle file of the Pz.Kpfw. Neu is built')
        if record is not None and stock is not None:
            aim_same = sorted(k for k in pair['aim'] if json.loads(json.dumps(record['aim'].get(k))) != json.loads(json.dumps(pair['aim'][k])))
            check(not aim_same and near(record['aim']['speedForward'] / constants.KMH_TO_MS, kmh(block))
                  and not near(stock['aim']['speedForward'], record['aim']['speedForward']),
                  '6: HIS CASE - the vehicle file\'s aim block is the characteristics file\'s of that pair, tree and all (42 km/h, not 40)',
                  'differ in %s; file %.2f km/h, bare %.2f' % (aim_same, record['aim']['speedForward'] / constants.KMH_TO_MS,
                                                               stock['aim']['speedForward'] / constants.KMH_TO_MS))
            pick = lambda rows, key: [row.get(key) for row in rows if not row.get('gunInstallation')]
            file_shells = shells(block, pair)
            check(all(pick(record['shells'], key) == [row.get(key) for row in file_shells] for key in ('penetration100', 'penetration500', 'alpha', 'speed'))
                  and pick(record['shells'], 'penetration100') != pick(stock['shells'], 'penetration100'),
                  '6: its shells are the characteristics file\'s - penetration, damage, speed',
                  '%s against %s' % (pick(record['shells'], 'penetration100'), [row.get('penetration100') for row in file_shells]))
            check(record.get('maxHealth') == pair['maxHealth'] and record.get('maxHealth') != stock.get('maxHealth'),
                  '6: and its health', (record.get('maxHealth'), pair['maxHealth']))
            # The gun's limits table (presentation.gun_limits) is keyed by the compact descriptor, which packs no modification:
            # the bare table and the tree's must not answer for each other, whichever was asked first. (Where the stand has no
            # gun_rotation_shared the export has no table at all, and this says so.)
            limits = lambda value: json.dumps(value, default=repr, sort_keys=True)
            if record.get('gunPitchLimits') is None or stock.get('gunPitchLimits') is None:
                report.append('SKIP 6: no gun limits table on this stand (%s)' % [w for w in record.get('warnings') or [] if 'itch' in w][:1])
            else:
                check(limits(record['gunPitchLimits']) != limits(stock['gunPitchLimits'])
                      and limits(bare_export(HIS)['gunPitchLimits']) == limits(stock['gunPitchLimits'])
                      and limits(export(HIS)[0]['gunPitchLimits']) == limits(record['gunPitchLimits']),
                      '6: and its gun\'s pitch limits are the tree\'s - the bare table and the tree\'s never stand in for each other',
                      limits(record['gunPitchLimits'])[:200])
            check(record.get('skillTree') == block['vehicle']['skillTree'] and not [w for w in record.get('warnings') or [] if 'kill tree' in w],
                  '6: the file says which tree it carries, as the characteristics file does', record.get('skillTree'))
            moved = sorted(k for k in set(strip(record)) | set(strip(stock)) if strip(record).get(k) != strip(stock).get(k))
            check(moved and set(moved) <= set(('aim', 'shells', 'maxHealth', 'gunPitchLimits', 'turretYawLimits', 'linerFactor', 'gunDispersion')),
                  '6: nothing else of the file moves with the tree - not its parts, not its descriptor', moved)
            memo = ex.vehicle_descr(compact)
            check(not list(memo.modifications) and near(ex.speed_limits(memo)[0], stock['aim']['speedForward']),
                  '6: the descriptor the records read (vehicle_descr\'s memo of the same compact descriptor) stays the bare one',
                  (list(memo.modifications), ex.speed_limits(memo)[0]))
            check(strip(export(HIS)[0]) == strip(record), '6: the same vehicle exported again gives the same file')
        full, plainly = export(ROLE_TREE)[0], bare_export(ROLE_TREE)
        check(full is not None and strip(full) == strip(plainly) and 'skillTree' not in full, '6: a vehicle with a role tree is exported as before')
        keep = getattr(ex, 'skill_tree_modifications', None)
        ex.skill_tree_modifications = lambda vtype: (999999999,)
        try:
            broken = export(HIS)[0]
            after = export(ROLE_TREE)[0]
        finally:
            if keep is None: del ex.skill_tree_modifications
            else: ex.skill_tree_modifications = keep
        check(broken is not None and stock is not None and strip(broken) == strip(stock)
              and any('kill tree' in w for w in broken.get('warnings') or ()) and (broken.get('skillTree') or {}).get('modifications') == 0,
              '6: a tree the client refuses leaves the bare vehicle\'s file with a warning', broken and broken.get('warnings'))
        check(after is not None and after.get('shells'), '6: and the next vehicle is exported')
        fresh_summary = dict(owner.vehicles.get(ex.vehicle_id(HIS)) or {})
        check(fresh_summary.get('eliteByProgression') and 'skillTree' in fresh_summary,
              '6: the summary kept of the file carries the marker of the tree (what a file without a key is judged by)', sorted(fresh_summary))
        tree_current = getattr(ex, 'vehicle_tree_current', None)
        check(tree_current is not None and stock is not None and not tree_current(dict((k, v) for k, v in stock.items() if k != 'skillTree'))
              and record is not None and tree_current(record) and tree_current(full),
              '6: a tier-XI vehicle file written before this rule is not current; one with the tree, and any other vehicle\'s, is')
    finally:
        ex.write_data, ex.part_resource, ex.Exporter.publish_vehicle_parts = kept_write, kept_resource, kept_publish
        if kept_rotation is None: sys.modules.pop('gun_rotation_shared', None)
        else: sys.modules['gun_rotation_shared'] = kept_rotation
        import shutil
        shutil.rmtree(folder, True)

    report.append('%d checks, %d failed' % (len([l for l in report if l[:4] in ('ok  ', 'FAIL')]), len(failures)))
    return finish(report, 1 if failures else 0)


try:
    main()
except Exception:
    finish(report + ['FAIL exception\n' + traceback.format_exc()], 1)
