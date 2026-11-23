"""Native routing and the cheap JS shot-link/state smoke; no game or browser."""
import ast
from pathlib import Path
import re
import subprocess
import unittest
from urllib.request import pathname2url

ROOT = Path(__file__).resolve().parents[1]
NODE = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'


class ShotLinks(unittest.TestCase):
    def test_routing_and_selector_state(self):
        result = subprocess.run([str(NODE), str(ROOT / 'tests/shot_links.cjs')], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"ok":true', result.stdout)

    def test_existing_native_destination_and_stable_id(self):
        import os
        from types import SimpleNamespace
        source = (ROOT / 'mod/local_armor_inspector/presentation.py').read_text(encoding='utf-8')
        names = {'command_value', 'viewer_shot', 'shot_fragment', 'page_url', 'full_fragment', 'open_viewer_view'}
        tree = ast.parse(source)
        tree.body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        urls, closed = [], []
        ns = dict(re=re, os=os, pathname2url=pathname2url, _page_entry=0,
                  _viewer={}, _full={'view':SimpleNamespace(getBrowser=lambda:SimpleNamespace(navigate=urls.append))},
                  fullscreen_open=lambda:True, close_other=closed.append, REPLAYS='replays')
        exec(compile(tree, 'presentation-routing', 'exec'), ns)
        command = SimpleNamespace(custom_parameters=dict(at=1010,attacker=7,target=9,focus=7,shotId='101',shotIndex=1))
        shot = ns['viewer_shot'](command)
        self.assertEqual(shot, '1010.000,7,9,7,101,1')
        self.assertTrue(ns['shot_fragment']('battle',command).endswith('&shotId=101'))
        for _ in range(2): ns['open_viewer_view'](str(ROOT/'web/playback.html'),'battle=battle&shot='+shot)
        self.assertEqual(len(urls),2)
        self.assertNotEqual(urls[0],urls[1])
        self.assertTrue(all('#host=game&view=full&battle=battle&shot='+shot in u for u in urls))
        self.assertEqual(closed,['replays','replays'])


if __name__ == '__main__':
    unittest.main()
