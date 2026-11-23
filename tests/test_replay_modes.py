"""Shipped classifier parity and the stale 47/comp7 metadata regression; no browser."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector import replay_files as modes


class ReplayModes(unittest.TestCase):
    def test_shipped_policy_matches_python_owner(self):
        source = (ROOT / 'web/replay-mode.js').read_text(encoding='utf-8')
        actual = json.loads(re.search(r'var POLICY = (\{.*?\}); // policy-end', source, re.S).group(1))
        expected = dict(standardBonus=modes.STANDARD_BONUS,
                        standardGameplay=list(modes.STANDARD_GAMEPLAY),
                        specialNames=modes.SPECIAL_NAMES, gameplayNames=modes.GAMEPLAY_NAMES)
        self.assertEqual(actual, json.loads(json.dumps(expected)))
        self.assertIn("'web/replay-mode.js'", (ROOT / 'mod/local_armor_inspector/exporter.py').read_text(encoding='utf-8'))
        html = (ROOT / 'web/playback.html').read_text(encoding='utf-8')
        self.assertIn('<script src="replay-mode.js"></script>', html)
        self.assertLess(html.index('src="replay-mode.js"'), html.index('src="playback/playback.js"'))

    def test_summary_carries_mode_of_every_battle(self):
        # NOTEBOOK Y15 (22.11): his installed index had 1243 of 1327 battles with no mode evidence - an ordinary battle's
        # row carried nothing, and the viewer warned "Unidentified mode". The mode fields of his Redshire battle's record:
        ordinary = {'gameplayName': 'domination', 'bonusTypeName': 'TOURNAMENT_REGULAR', 'bonusType': 14, 'geometryName': '34_redshire'}
        self.assertEqual(modes.summary_mode(ordinary), {'battleType': 14, 'gameplay': 'domination'})
        self.assertEqual(modes.summary_mode({'bonusType': 1, 'gameplayName': 'ctf'}), {'battleType': 1, 'gameplay': 'ctf'})
        frontline = modes.summary_mode({'bonusType': 27, 'gameplayName': 'epic'})
        self.assertEqual(frontline['special']['name'], 'Frontline')
        self.assertEqual(frontline['battleType'], 27)
        # an old record with no mode: nothing claimed (the viewer decides after preparing it)
        self.assertEqual(modes.summary_mode({}), {})
        self.assertEqual(modes.summary_mode(None), {})

    def test_stale_metadata_regression(self):
        fallback = os.path.expanduser('~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
        node = next((p for p in (os.environ.get('BULLBA_NODE'), shutil.which('node'), fallback)
                     if p and os.path.isfile(p)), None)
        if not node:
            self.skipTest('node not found: set BULLBA_NODE')
        result = subprocess.run([node, str(ROOT / 'tests/replay_modes.cjs')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])
