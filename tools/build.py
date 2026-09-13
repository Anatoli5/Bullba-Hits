"""Reproducible .wotmod build. Never installs or starts the game."""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(ROOT/'mod'))
from local_armor_inspector.exporter import ASSETS, VERSION
COMPILER=ROOT/'work/research-options/sources/openwg--openwg.build/bin/windows_amd64/owg_python_compiler/owg_python_compiler.exe'
EXPECTED='d36dbe2ffd4d77710750fbd9814e45bb7086d2ff7a38b33afce0c142383ffd13'


def build():
    if hashlib.sha256(COMPILER.read_bytes()).hexdigest()!=EXPECTED: raise ValueError('Compiler checksum mismatch')
    out=ROOT/'dist';out.mkdir(exist_ok=True)
    compiled=out/'compiled'
    subprocess.run([str(COMPILER),'compile','--source',str(ROOT/'mod'),'--target',str(compiled),'--python-version','2.7','--jobs','1','--timestamp','0','--filename-root','.'],check=True)
    files={'meta.xml':('<root><id>local.armor_inspector</id><version>'+VERSION+'</version><name>Bullba Hits</name><description>Hit recorder with serverless HTML viewer</description></root>').encode('utf-8')}
    files['res/gui/maps/bullba_hits/modsListApi.png']=(ROOT/'web/menu-icon.png').read_bytes()
    for source in (ROOT/'mod').rglob('*.py'):
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
    report={'artifact':archive.name,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size,'python':'2.7','compilerSha256':EXPECTED,'installed':False,'gameRuntimeTested':False}
    (out/'build.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__': build()
