"""The project map (docs/MAP.md and its parts docs/map/*.md) against the files on disk.

The previous structure document (docs/architecture.md) went stale because nothing compared it with the files; this test
does. Check 1: every repo path the map and the rule files name in backticks exists. Check 2: every source file git tracks
under mod/, web/ and tools/ is named in a map part. docs/ and AGENTS.md are local agent context, not in git: on a clean
clone docs/MAP.md is absent and the whole test skips.
"""
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP = ROOT / 'docs' / 'MAP.md'
PARTS_DIR = ROOT / 'docs' / 'map'

# Repo folders whose paths the documents promise to exist.
CHECKED_PREFIXES = ('mod/', 'web/', 'tools/', 'tests/', 'installer/', 'docs/', 'outputs/', 'licenses/')
# Root documents named bare (HANDOFF.md, CHANGELOG.md, AGENTS.md); bare module names such as `app.js` are not root files.
ROOT_FILE = re.compile(r'^[A-Z][A-Z0-9_-]*\.md$')
# Placeholders and patterns describe many files or machine state, not one path.
PATTERN_MARKS = ('<', '>', '*', '…', '..', ' ', '{', '}', '?')
TRAILING_LINE = re.compile(r':\d+(-\d+)?$')
TRAILING_PUNCT = '.,;:)'
BACKTICKED = re.compile(r'`([^`\n]+)`')


def documents():
    """The documents whose backticked paths must exist: the entry rules, the map top, the rules, the map parts."""
    docs = [ROOT / 'AGENTS.md', MAP, ROOT / 'docs' / 'RULES.md'] + sorted(PARTS_DIR.glob('*.md'))
    return [d for d in docs if d.is_file()]


def path_token(token):
    """The repo path a backticked token names, or None when the token is code, a pattern or machine state."""
    token = token.strip()
    token = TRAILING_LINE.sub('', token)
    token = token.rstrip(TRAILING_PUNCT)
    if not token or any(mark in token for mark in PATTERN_MARKS):
        return None
    if token.startswith(CHECKED_PREFIXES) or ROOT_FILE.match(token):
        return token
    return None


def tracked_sources():
    """Source files git tracks that the map parts must name, or None when git cannot answer."""
    git = shutil.which('git')
    if not git:
        return None
    try:
        out = subprocess.run([git, 'ls-files', '--', 'mod', 'web', 'tools'], cwd=str(ROOT), capture_output=True,
                             text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    sources = []
    for name in out.stdout.splitlines():
        parts = name.split('/')
        if parts[0] == 'mod' and name.endswith('.py'):
            sources.append(name)
        elif parts[0] == 'web' and len(parts) == 2 and name.endswith(('.js', '.html', '.css')):
            # Only files directly in web/: vendor/ is third-party code, icons/ are images.
            sources.append(name)
        elif parts[0] == 'tools':
            sources.append(name)
    return sources


@unittest.skipUnless(MAP.is_file(), 'docs/MAP.md is local agent context, absent on a clean clone')
class ProjectMapTest(unittest.TestCase):
    def test_named_paths_exist(self):
        missing = []
        for doc in documents():
            text = doc.read_text(encoding='utf-8')
            for token in BACKTICKED.findall(text):
                path = path_token(token)
                if path is None:
                    continue
                target = ROOT / path
                ok = target.is_dir() if path.endswith('/') else target.exists()
                if not ok:
                    missing.append('%s names %s' % (doc.relative_to(ROOT).as_posix(), path))
        missing = sorted(set(missing))
        self.assertEqual(missing, [], 'paths named but not on disk:\n  ' + '\n  '.join(missing))

    def test_every_source_file_is_mapped(self):
        sources = tracked_sources()
        if sources is None:
            self.skipTest('git is unavailable')
        parts = sorted(PARTS_DIR.glob('*.md'))
        self.assertTrue(parts, 'docs/map/*.md is missing')
        text = '\n'.join(part.read_text(encoding='utf-8') for part in parts)
        unnamed = []
        for path in sources:
            base = path.rsplit('/', 1)[-1]
            # A part often names a file by its base name inside a block whose `Files:` line already set the folder;
            # a bare word match keeps `armor.py` from counting as `class_armor.py`.
            named_base = re.search(r'(?<![\w.-])' + re.escape(base) + r'(?![\w-])', text)
            if path not in text and not named_base:
                unnamed.append(path)
        self.assertEqual(unnamed, [], 'tracked source files no map part names:\n  ' + '\n  '.join(unnamed))


if __name__ == '__main__':
    unittest.main()
