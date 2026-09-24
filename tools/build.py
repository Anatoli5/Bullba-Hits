"""Reproducible .wotmod build. Never installs or starts the game.

    python tools/build.py [--skip-check]

Refuses to build from a dirty git tree (every tracked change and every untracked, not ignored file is listed): the
package must be exactly one commit, recorded in dist/build.json, so a release can be tied to it (audit QA-03,
24.09). Runs tools/check.py first and stops on red; --skip-check is for emergencies only and is written into
build.json, where tools/release_github.py sees it.
"""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(ROOT/'mod'))
from local_armor_inspector.exporter import ASSETS, CRIT_ICON_FILES, VERSION
COMPILER=ROOT/'work/research-options/sources/openwg--openwg.build/bin/windows_amd64/owg_python_compiler/owg_python_compiler.exe'
EXPECTED='d36dbe2ffd4d77710750fbd9814e45bb7086d2ff7a38b33afce0c142383ffd13'


def git(*args):
    return subprocess.run(['git',*args],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',check=True).stdout


def clean_commit():
    """The commit the package is built from; SystemExit when the tree holds anything that commit does not."""
    dirty=[line for line in git('status','--porcelain','--untracked-files=all').splitlines() if line.strip()]
    if dirty:
        raise SystemExit('Build refused: the git tree is not clean - commit or stash these first, so the package is '
                         'exactly one commit:\n  '+'\n  '.join(dirty))
    return git('rev-parse','HEAD').strip()


def run_check():
    sys.path.insert(0,str(ROOT/'tools'))
    import check
    code,summary=check.main([])
    if code: raise SystemExit('Build refused: tools/check.py is red (see above). --skip-check only in an emergency.')
    return summary


def build(skip_check=False):
    commit=clean_commit()
    checked={'skipped':True,'reason':'--skip-check'} if skip_check else run_check()
    if skip_check: print('WARNING: tools/check.py skipped (--skip-check); build.json records it.',file=sys.stderr)
    if hashlib.sha256(COMPILER.read_bytes()).hexdigest()!=EXPECTED: raise ValueError('Compiler checksum mismatch')
    # The crit icons are the client's own art and come out of the installed game (22.09): say which and how.
    missing=[asset for asset in CRIT_ICON_FILES if not (ROOT/asset).is_file()]
    if missing: raise FileNotFoundError('Crit icons missing: '+', '.join(missing)+'. Run tools/extract_crit_icons.py first; it copies them from the installed client.')
    out=ROOT/'dist';out.mkdir(exist_ok=True)
    compiled=out/'compiled'
    subprocess.run([str(COMPILER),'compile','--source',str(ROOT/'mod'),'--target',str(compiled),'--python-version','2.7','--jobs','1','--timestamp','0','--filename-root','.'],check=True)
    files={'meta.xml':('<root><id>local.armor_inspector</id><version>'+VERSION+'</version><name>Bullba Hits</name><description>Hit recorder with serverless HTML viewer</description></root>').encode('utf-8')}
    files['res/gui/maps/bullba_hits/modsListApi.png']=(ROOT/'web/menu-icon.png').read_bytes()
    # The tracked sources only (audit QA-18): a local .py left in mod/ would otherwise ship. The tree is clean, so
    # the list is the commit's.
    for source in sorted(ROOT/p for p in git('ls-files','--','mod/*.py').split() if p):
        relative=source.relative_to(ROOT/'mod').with_suffix('.pyc')
        pyc=(compiled/relative).read_bytes()
        if pyc[:4]!=bytes.fromhex('03f30d0a'): raise ValueError('Wrong Python bytecode version')
        target='gui/mods/'+relative.as_posix() if relative.name=='mod_local_armor_inspector.pyc' else relative.as_posix()
        files['res/scripts/client/'+target]=pyc
    for asset in ASSETS:
        source=ROOT/'web/index.html' if asset=='Viewer.html' else ROOT/asset
        data=source.read_bytes()
        if asset=='Viewer.html': data=data.replace(b'data-version="dev"',('data-version="'+VERSION+'"').encode('utf-8'))
        files['res/armor_inspector_viewer/'+asset]=data
    dirs=set()
    for file in files:
        dirs.update(p.as_posix()+'/' for p in Path(file).parents if str(p)!='.')
    archive=out/('local.armor_inspector_'+VERSION+'.wotmod')
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_STORED) as z:
        for name in sorted(dirs)+sorted(files):
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.external_attr=(0o40755 if name.endswith('/') else 0o100644)<<16
            z.writestr(info,files.get(name,b''))
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None: raise ValueError('Corrupt archive')
    if git('status','--porcelain','--untracked-files=all').strip() or git('rev-parse','HEAD').strip()!=commit:
        raise SystemExit('Build refused: the tree changed while building; build again from a clean commit.')
    report={'artifact':archive.name,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size,'python':'2.7','compilerSha256':EXPECTED,
            'commit':commit,'check':checked,'installed':False,'gameRuntimeTested':False}
    (out/'build.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    unknown=[a for a in sys.argv[1:] if a!='--skip-check']
    if unknown: raise SystemExit('Unknown argument: '+' '.join(unknown)+' (only --skip-check)')
    build('--skip-check' in sys.argv[1:])
