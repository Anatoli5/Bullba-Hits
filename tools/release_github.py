"""Publish the built installer as a GitHub release: tag v<VERSION> on the commit the build was made from, attach
Setup.exe and the sources/manual-install ZIP.

The tag goes on dist/build.json's commit (tools/build.py builds only from a clean tree and records it), never on
whatever HEAD is now: the published files and the tagged sources are one and the same (audit QA-03, 24.09 - v0.7.40
was tagged on 29ea400 with artefacts built from 2ab4efe). Refused when build.json has no commit (a build of before
this rule), when that commit is not on the remote yet, when an existing tag points elsewhere, and when the build
skipped tools/check.py (--allow-unchecked overrides that one, for an emergency build).

Uses the user's Git Credential Manager token like tools/publish_github.py; the token never reaches stdout.
"""
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'mod'))
from local_armor_inspector.exporter import VERSION  # noqa: E402

OWNER = 'Anatoli5'
NAME = 'Bullba-Hits'
ENV = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')


def git(*args, input=None):
    result = subprocess.run(['git', *args], cwd=ROOT, input=input, text=True, encoding='utf-8', capture_output=True, env=ENV)
    if result.returncode:
        raise RuntimeError('Git command failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()


credentials = dict(line.split('=', 1) for line in git('credential', 'fill', input='protocol=https\nhost=github.com\nusername=' + OWNER + '\n\n').splitlines() if '=' in line)
if not credentials.get('password'):
    raise RuntimeError('GitHub token is not available from the credential manager')
TOKEN = credentials['password']


def api(url, method='GET', body=None, data=None, content_type='application/json', missing=False):
    if not url.startswith('https://'):
        url = 'https://api.github.com' + url
    request = urllib.request.Request(url, method=method, data=data if data is not None else (json.dumps(body).encode('utf-8') if body is not None else None),
        headers={'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'Bullba-Hits-release', 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError('GitHub API %s %s failed with status %d' % (method, url.split('?')[0], error.code)) from None


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def changelog_section(version, text=None):
    """The bullet list under '## <version> (date)' in CHANGELOG.md; the release is refused without it."""
    lines = (text if text is not None else (ROOT / 'CHANGELOG.md').read_text(encoding='utf-8')).splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith('## ' + version + ' ') or l.strip() == '## ' + version), None)
    if start is None:
        raise RuntimeError('CHANGELOG.md has no section for ' + version + '; write it (rename Unreleased) before releasing')
    body = []
    for l in lines[start + 1:]:
        if l.startswith('## '):
            break
        body.append(l)
    text = '\n'.join(body).strip()
    if not text:
        raise RuntimeError('CHANGELOG.md section for ' + version + ' is empty')
    return text


tag = 'v' + VERSION
report = json.loads((ROOT / 'dist' / 'build.json').read_text(encoding='utf-8'))
head = report.get('commit')
if '--notes' in sys.argv:
    # Only the notes of a release already out are rewritten (below): no tag is made, the build is not checked.
    changelog = changelog_section(VERSION)
else:
    if not head:
        raise RuntimeError('dist/build.json names no commit (a build of before 24.09); build again with tools/build.py')
    if (report.get('check') or {}).get('skipped') and '--allow-unchecked' not in sys.argv:
        raise RuntimeError('This build skipped tools/check.py (--skip-check); build again with the check, or pass --allow-unchecked')
    if not git('branch', '-r', '--contains', head):
        raise RuntimeError('The build commit ' + head[:10] + ' is not on the remote; push it before releasing')
    # The notes are the CHANGELOG of the build commit, not of the working copy.
    changelog = changelog_section(VERSION, git('show', head + ':CHANGELOG.md'))
# Two files, named so that GitHub's alphabetical asset list shows the installer first ("Setup" < "Sources").
# The bare .wotmod is inside the ZIP; it is not attached on its own any more (user, 19.09: a pile of files nobody
# can explain).
assets = [ROOT / 'dist' / ('BullbaHits-' + VERSION + '-Setup.exe'), ROOT / 'dist' / ('BullbaHits-' + VERSION + '-Sources-and-manual-install.zip')]
wotmod = ROOT / 'dist' / ('local.armor_inspector_' + VERSION + '.wotmod')
for asset in assets + [wotmod]:
    if not asset.is_file():
        raise RuntimeError('Missing build artifact: ' + asset.name)
if digest(wotmod) != report['sha256']:
    raise RuntimeError('dist/*.wotmod does not match dist/build.json; rebuild first')

repo = '/repos/' + OWNER + '/' + NAME
notes = ['Bullba Hits ' + VERSION + u' \u2014 WoT PC NA 2.4.0.1 #950.', '', changelog, '', '### Files', '',
         '**' + assets[0].name + u'** \u2014 the installer. Works alongside other mod packs: used with Aslain\'s, others are expected to work. Keeps your recorded battles.', '',
         '**' + assets[1].name + u'** \u2014 the `.wotmod` files for a manual install (copy them into `mods\\2.4.0.1\\`), the sources, README and licences.', '',
         'SHA-256:']
notes += ['- `' + a.name + '`: `' + digest(a) + '`' for a in assets]
notes += ['- `' + wotmod.name + '` (inside the archive): `' + report['sha256'] + '`']
existing_tag = None if '--notes' in sys.argv else api(repo + '/git/ref/tags/' + tag, missing=True)
if '--notes' in sys.argv:
    pass
elif existing_tag is None:
    api(repo + '/git/refs', 'POST', {'ref': 'refs/tags/' + tag, 'sha': head})
elif (existing_tag.get('object') or {}).get('sha') != head:
    raise RuntimeError('Tag ' + tag + ' already points at ' + str((existing_tag.get('object') or {}).get('sha'))[:10]
                       + ', the artefacts were built from ' + head[:10] + '; refusing to publish them under it')
existing = api(repo + '/releases/tags/' + tag, missing=True)
if '--notes' in sys.argv:
    # Rewrite the notes of the published release from the current CHANGELOG section; assets and tag stay.
    if existing is None:
        raise RuntimeError('Release ' + tag + ' does not exist; nothing to update')
    api(existing['url'], 'PATCH', {'body': '\n'.join(notes)})
    print(json.dumps({'tag': tag, 'url': existing['html_url'], 'notes': 'updated'}, ensure_ascii=False, indent=2))
    sys.exit(0)
if existing is not None:
    raise RuntimeError('Release ' + tag + ' already exists; bump the version instead of replacing a published build')
release = api(repo + '/releases', 'POST', {'tag_name': tag, 'target_commitish': head, 'name': 'Bullba Hits ' + VERSION, 'body': '\n'.join(notes), 'draft': False, 'prerelease': False})
upload_base = release['upload_url'].split('{')[0]
for asset in assets:
    api(upload_base + '?name=' + asset.name, 'POST', data=asset.read_bytes(), content_type='application/octet-stream')
final = api(repo + '/releases/tags/' + tag)
print(json.dumps({'tag': tag, 'commit': head, 'url': final['html_url'], 'assets': [a['name'] for a in final['assets']]}, ensure_ascii=False, indent=2))
