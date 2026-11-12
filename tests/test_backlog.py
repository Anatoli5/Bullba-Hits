"""The list of open work (docs/BACKLOG.md) is queryable by area and priority.

Every row of the status table has a priority A/B/C, a status, and an area made of block names from the docs/MAP.md block
index (or `проект`), so `python tools/backlog.py --area <block>` brings an agent the open items of the block it touches.
docs/ is local agent context, not in git: on a clean clone the files are absent and the test skips.
"""
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKLOG = ROOT / 'docs' / 'BACKLOG.md'
MAP = ROOT / 'docs' / 'MAP.md'
sys.path.insert(0, str(ROOT / 'tools'))
try:
    import backlog
except ImportError:   # tools/backlog.py absent: nothing to check against
    backlog = None

PROJECT_AREA = 'проект'


def map_blocks():
    """Block names from the docs/MAP.md «Block index» table (second column)."""
    text = MAP.read_text(encoding='utf-8')
    section = text.split('## Block index', 1)[1].split('\n## ', 1)[0]
    names = set()
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 2 and cells[0] in ('mod', 'page', 'tools'):
            names.add(cells[1])
    return names


@unittest.skipUnless(backlog and BACKLOG.is_file() and MAP.is_file(), 'docs/ is local agent context, absent on a clean clone')
class BacklogTest(unittest.TestCase):
    def test_rows_have_priority_status_and_known_area(self):
        rows = backlog.read_rows(str(BACKLOG))   # raises on a row with a bad priority or an empty cell
        self.assertTrue(rows)
        blocks = map_blocks()
        self.assertTrue(blocks, 'no block names read from docs/MAP.md')
        bad = []
        for row in rows:
            self.assertIn(row['priority'], ('A', 'B', 'C'), row['num'])
            self.assertTrue(row['status'], row['num'])
            for name in row['area'].split('; '):
                if name != PROJECT_AREA and name not in blocks:
                    bad.append('%s: %r' % (row['num'], name))
        self.assertEqual(bad, [], 'areas that are not docs/MAP.md blocks:\n  ' + '\n  '.join(bad))

    def test_tool_lists_every_open_row(self):
        text = BACKLOG.read_text(encoding='utf-8')
        open_rows = 0
        for line in text.split(backlog.HEADER, 1)[1].split('\n')[2:]:
            if not line.startswith('| '):
                break
            status = line.strip()[2:-2].split(' | ')[4]
            if not re.match(r'^(сделано \(|выпущено|закрыто|отменено)', status.strip('* ')):
                open_rows += 1
        env = dict(os.environ, PYTHONIOENCODING='utf-8')
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'backlog.py')], capture_output=True, timeout=60,
                             env=env)
        self.assertEqual(out.returncode, 0, out.stderr.decode('utf-8', 'replace'))
        listed = [l for l in out.stdout.decode('utf-8').splitlines() if l and not l.startswith('-- ')]
        self.assertEqual(len(listed), open_rows)


if __name__ == '__main__':
    unittest.main()
