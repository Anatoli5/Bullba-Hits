"""The copy step's mirror of the page's LOD choice (23.11.2026, NOTEBOOK A6): map_raw.lod_drawn must hold every LOD
mapbuild9.js chooseLod can draw, whole - the walk now stops before a LOD drawn with a texture the chain's first LOD does
not use (the game's far impostor with one baked texture). Synthetic chains; the expected sets are worked by hand from
the budgets [BUDGET_LO 100, BUDGET_HI 800]. The page side on real data: tests/test_building_textures.cjs (a LOD the
page draws but the copy cut would fail its build)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'mod'))
from local_armor_inspector import map_raw  # noqa: E402

TILED = frozenset(['plaster_512_am.dds', 'roof_512_am.dds'])
BAKED = frozenset(['house_bam.dds'])


def test_house_keeps_its_tiled_lod():
    # a Tohouse: lod2 (1 700 triangles) fits no budget, lod3 is the impostor - before: lod3 drawn; now: lod2
    chain = [('lod0', 14341, TILED), ('lod1', 4639, TILED), ('lod2', 1732, TILED), ('lod3', 87, BAKED)]
    assert map_raw.lod_drawn(chain) == {'lod2'}


def test_tiled_lods_within_budget_unchanged():
    chain = [('lod0', 5000, TILED), ('lod1', 700, TILED), ('lod2', 300, TILED), ('lod3', 60, BAKED)]
    assert map_raw.lod_drawn(chain) == {'lod1', 'lod2'}


def test_subset_of_first_textures_is_not_an_impostor():
    chain = [('lod0', 5000, TILED), ('lod1', 90, frozenset(['roof_512_am.dds']))]
    assert map_raw.lod_drawn(chain) == {'lod1'}


def test_without_textures_the_old_rule():
    assert map_raw.lod_drawn([('lod0', 5000), ('lod1', 900), ('lod2', 60)]) == {'lod2'}
    assert map_raw.lod_chain_walked([]) == []
