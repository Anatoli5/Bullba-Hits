"""tools/verdicts_from_log.classify for a scene that left a part out (review of d1b372b): a verdict whose shell met the
missing part (partialRay=1, or a line from before partialRay) is counted apart; one whose shell did not (partialRay=0) is
judged as any line, so a disagreement on the hull still reaches triage."""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('verdicts_from_log', os.path.join(HERE, '..', 'tools', 'verdicts_from_log.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

BASE = {'server': 'Penetration', 'part': 'hull', 'angle': '40', 'ours': 'no-pen_10%'}


def test_partial_ray_met_is_apart():
    assert tool.classify(dict(BASE, partial='crest', partialRay='1')) == 'partial-scene'


def test_partial_line_before_the_column_is_apart():
    assert tool.classify(dict(BASE, partial='wheel1')) == 'partial-scene'


def test_partial_ray_not_met_is_judged():
    assert tool.classify(dict(BASE, partial='crest', partialRay='0')) == 'DISAGREE'
    assert tool.classify(dict(BASE, partial='crest', partialRay='0', ours='pen_90%')) == 'agree'


def test_rebuilt_scene_view_keeps_the_snapshot_line(tmp_path):
    """Row 80 (12.11): the page now logs the view of a hit's scene rebuilt from the replay (scene=replay); that line is
    kept beside the snapshot's line of the same point and shell, not over it."""
    log = tmp_path / 'game.log'
    log.write_text('Bullba Hits verdict: battle=b hit=1 point=0 part=hull server=Penetration ours=pen_90% shell=AP mode=auto\n'
                   'Bullba Hits verdict: battle=b hit=1 point=0 part=hull server=Penetration ours=no-pen_10% shell=AP mode=view scene=replay\n'
                   'Bullba Hits verdict: battle=b hit=1 point=0 part=hull server=Penetration ours=pen_80% shell=AP mode=view\n',
                   encoding='utf-8')
    rows = sorted(tool.parse([str(log)]), key=lambda r: r.get('scene', ''))
    assert [(r.get('scene', 'snapshot'), r['ours']) for r in rows] == [('snapshot', 'pen_80%'), ('replay', 'no-pen_10%')]
