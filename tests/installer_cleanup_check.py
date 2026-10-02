"""Installer without backups (24.09): compile installer/ArmorInspector.iss as a loaderless TestBuild into a temp
folder and install it silently into a fake game folder there. Nothing under the real game folder or dist/ is touched.

    python tests/installer_cleanup_check.py
Needs a previous tools/build_installer.py run (installer/generated/ and its payload) and the Inno compiler in
work/installer-dependencies. Runs an unsigned setup engine: Smart App Control may refuse it (docs/KNOWLEDGE.md §13).

Checks: the backup folder and the retired web/heatmap-gpu.js go; a previous recorder in the client's own mods folder
and in those of the two earlier clients goes (no copy); records, models, settings, other mods and a user file in our
folder stay. The fake client has the build's version with ANOTHER build number: the installer compares the version
and the realm only (tools/client_version.py); a client of another version is refused and nothing is written."""
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path(tempfile.mkdtemp(prefix='bullba-installer-'))
sys.path.insert(0, str(ROOT / 'tools'))
import build_installer as bi
import client_version
MODS = 'mods/' + client_version.VERSION
OLD1, OLD2 = ('mods/' + v for v in client_version.PREVIOUS)

src = SCRATCH / 'src'; (src / 'generated').mkdir(parents=True)
shutil.copy(ROOT / 'installer/ArmorInspector.iss', src)
shutil.copy(ROOT / 'installer/armor-inspector.ico', src)
for name in ('build.iss', 'checks.iss', 'files.iss'):
    shutil.copy(ROOT / 'installer/generated' / name, src / 'generated')
manifest = json.loads((ROOT / 'installer/generated/payload-manifest.json').read_text(encoding='utf-8'))
prefix = 'mods\\configs\\local.armor_inspector\\'
shipped = set(k[len(prefix):].replace('\\', '/') for k in manifest if k.startswith(prefix))
(src / 'generated/retired.iss').write_text('\n'.join(bi.retired_lines(shipped)) + '\n', encoding='utf-8-sig')
root = SCRATCH / 'root'; out = SCRATCH / 'out'
root.mkdir(); out.mkdir()
iscc = ROOT / 'work/installer-dependencies/inno-7.1.0/ISCC.exe'
cmd = [str(iscc), '/Qp', '/O' + str(out), '/DNoLoader', '/DTestBuild', '/DTestRoot=' + str(root), str(src / 'ArmorInspector.iss')]
r = subprocess.run(cmd, capture_output=True, text=True)
print('compile exit', r.returncode, (r.stdout + r.stderr)[-1500:] if r.returncode else '')
if r.returncode: sys.exit(1)

game = root / 'game'
cfg = game / 'mods/configs/local.armor_inspector'
def put(rel, data=b'x'):
    p = game / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data); return p
def version_xml(version, realm='NA'):
    put('version.xml', ('<version.xml><version>%s</version><meta><realm>%s</realm></meta></version.xml>' % (version, realm)).encode('ascii'))
# the build's version, a build number it was never checked on: a micro-update of the same client
version_xml('v.%s #%d' % (client_version.VERSION, int(client_version.BUILD) + 7))
(game / 'res/packages').mkdir(parents=True)
keep = {
    MODS + '/someone.else_1.0.wotmod': b'other mod',
    OLD1 + '/someone.else_0.9.wotmod': b'other mod of the earlier client',
    'mods/configs/local.armor_inspector/battles/1-abc.jsonl': b'{"schema":1,"type":"battle"}\n',
    'mods/configs/local.armor_inspector/data/models/k.js': b'model',
    'mods/configs/local.armor_inspector/data/battles/1-abc.js': b'snapshot',
    'mods/configs/local.armor_inspector/settings.json': b'{}',
    'mods/configs/local.armor_inspector/web/user-note.txt': b'mine',
}
for rel, data in keep.items(): put(rel, data)
gone = [MODS + '/local.armor_inspector_0.9.1.wotmod', OLD1 + '/local.armor_inspector_0.7.41.wotmod', OLD2 + '/local.armor_inspector_0.6.4.wotmod',
        'mods/configs/local.armor_inspector/web/heatmap-gpu.js',
        'mods/configs/local.armor_inspector/installer/backups/0.7.40/local.armor_inspector_0.7.40.wotmod',
        'mods/configs/local.armor_inspector/installer/backups/viewer-20260923-101010/web/app.js',
        'mods/configs/local.armor_inspector/installer/backups/desktop/ArmorInspector-1.lnk',
        # A recorder an earlier install could not delete and renamed (RemoveLegacyMod).
        OLD1 + '/local.armor_inspector_0.7.39.wotmod.removed', MODS + '/local.armor_inspector_0.9.0.wotmod.removed']
for rel in gone: put(rel)
# Review F1 (24.09): the previous recorders and the renamed one are read-only (a mod pack, a copy from a medium);
# DeleteFile refuses such a file unless the attribute goes first.
import stat
for rel in gone[:2] + gone[-1:]: os.chmod(game / rel, stat.S_IREAD)
put('mods/configs/local.armor_inspector/Viewer.html', b'old viewer')
before = dict((rel, hashlib.sha256((game / rel).read_bytes()).hexdigest()) for rel in keep)

import re
version = re.search(r'ProductVersion "([^"]+)"', (src / 'generated/build.iss').read_text(encoding='utf-8-sig')).group(1)
exe = out / ('BullbaHits-' + version + '-Setup-Test.exe')
print('exe sha256', hashlib.sha256(exe.read_bytes()).hexdigest())
log = SCRATCH / 'install.log'
new_mod = game / MODS / ('local.armor_inspector_' + version + '.wotmod')
ok = True
# A client of another version (the earlier one): refused, nothing of ours is written.
version_xml('v.%s #950' % client_version.PREVIOUS[0])
r = subprocess.run([str(exe), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/DIR=' + str(game), '/TASKS=',
                    '/TESTPROCESSNAME=NoSuchGame.exe', '/LOG=' + str(SCRATCH / 'refused.log')], capture_output=True, text=True, timeout=300)
refused = r.returncode != 0 and not new_mod.exists() and (cfg / 'Viewer.html').read_bytes() == b'old viewer'
ok &= refused
print(('ok ' if refused else 'FAIL ') + 'a client of another version is refused, nothing written (exit %d)' % r.returncode)
# The build's version with a build number it was never checked on: a micro-update of the same client, accepted.
version_xml('v.%s #%d' % (client_version.VERSION, int(client_version.BUILD) + 7))
r = subprocess.run([str(exe), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/DIR=' + str(game), '/TASKS=',
                    '/TESTPROCESSNAME=NoSuchGame.exe', '/LOG=' + str(log)], capture_output=True, text=True, timeout=300)
print('install exit', r.returncode)
ok &= r.returncode == 0
# An exception in a [Code] step still ends with exit 0; the setup log says so.
text = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
clean = 'Runtime error' not in text and 'Exception message' not in text
ok &= clean
print(('ok ' if clean else 'FAIL ') + 'no runtime error in the setup log')
left = sorted(p.name for p in game.glob('mods/*/local.armor_inspector_*.wotmod.removed'))
ok &= not left
print(('FAIL renamed instead of deleted: %s' % left) if left else 'ok previous recorders deleted, none renamed')
for rel in gone:
    exists = (game / rel).exists(); ok &= not exists
    print(('FAIL still there ' if exists else 'ok gone ') + rel)
backups = cfg / 'installer/backups'
print(('FAIL ' if backups.exists() else 'ok ') + 'backup folder removed')
ok &= not backups.exists()
for rel, digest in before.items():
    same = (game / rel).exists() and hashlib.sha256((game / rel).read_bytes()).hexdigest() == digest
    ok &= same
    print(('ok kept ' if same else 'FAIL changed ') + rel)
fresh = new_mod.exists() and (cfg / 'Viewer.html').read_bytes() != b'old viewer'
ok &= fresh
print(('ok ' if fresh else 'FAIL ') + 'new recorder and viewer installed')
print('installer folder now:', sorted(p.name for p in (cfg / 'installer').iterdir()) if (cfg / 'installer').exists() else None)
print('ALL OK' if ok else 'SOME FAILED')
if ok: shutil.rmtree(SCRATCH, ignore_errors=True)
else: print('fixture kept:', SCRATCH)
sys.exit(0 if ok else 1)
