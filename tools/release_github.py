"""Publish the built installer as a GitHub release: tag v<VERSION> on HEAD, attach Setup.exe, .wotmod and the serverless ZIP.

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


tag = 'v' + VERSION
head = git('rev-parse', 'HEAD')
if git('status', '--porcelain', '--', 'mod', 'web', 'installer/ArmorInspector.iss'):
    raise RuntimeError('Uncommitted changes in mod/, web/ or the installer script; commit before releasing')
assets = [ROOT / 'dist' / ('BullbaHits-' + VERSION + '-Setup.exe'), ROOT / 'dist' / ('local.armor_inspector_' + VERSION + '.wotmod'),
          ROOT / 'dist' / ('BullbaHits-' + VERSION + '-serverless.zip')]
for asset in assets:
    if not asset.is_file():
        raise RuntimeError('Missing build artifact: ' + asset.name)
report = json.loads((ROOT / 'dist' / 'build.json').read_text(encoding='utf-8'))
if digest(assets[1]) != report['sha256']:
    raise RuntimeError('dist/*.wotmod does not match dist/build.json; rebuild first')

repo = '/repos/' + OWNER + '/' + NAME
if api(repo + '/git/ref/tags/' + tag, missing=True) is None:
    api(repo + '/git/refs', 'POST', {'ref': 'refs/tags/' + tag, 'sha': head})
if api(repo + '/releases/tags/' + tag, missing=True) is not None:
    raise RuntimeError('Release ' + tag + ' already exists; bump the version instead of replacing a published build')
notes = ['Bullba Hits ' + VERSION + ' — WoT PC NA 2.4.0.0.', '',
         'Install: download `' + assets[0].name + '` and run it with the game closed. Manual install: put `' + assets[1].name + '` into `mods\\2.4.0.0\\`.', '',
         'SHA-256:']
notes += ['- `' + a.name + '`: `' + digest(a) + '`' for a in assets]
release = api(repo + '/releases', 'POST', {'tag_name': tag, 'target_commitish': head, 'name': 'Bullba Hits ' + VERSION, 'body': '\n'.join(notes), 'draft': False, 'prerelease': False})
upload_base = release['upload_url'].split('{')[0]
for asset in assets:
    api(upload_base + '?name=' + asset.name, 'POST', data=asset.read_bytes(), content_type='application/octet-stream')
final = api(repo + '/releases/tags/' + tag)
print(json.dumps({'tag': tag, 'commit': head, 'url': final['html_url'], 'assets': [a['name'] for a in final['assets']]}, ensure_ascii=False, indent=2))
