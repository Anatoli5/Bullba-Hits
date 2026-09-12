"""Build the native installer from the existing, hash-verified .wotmod."""
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
from local_armor_inspector.exporter import ASSETS, VERSION, write_data


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def build(test=False):
    compiler=ROOT/'work/installer-dependencies/inno-7.1.0/ISCC.exe'
    generated=ROOT/'installer/generated'
    generated.mkdir(parents=True,exist_ok=True)
    mod=ROOT/'dist'/('local.armor_inspector_'+VERSION+'.wotmod')
    report=json.loads((ROOT/'dist/build.json').read_text())
    if digest(mod)!=report['sha256']: raise ValueError('Mod differs from validated build')
    files=[(mod,'mods/2.4.0.0/'+mod.name,False,False)]
    with zipfile.ZipFile(mod) as z:
        for relative in ASSETS:
            target=generated/'payload'/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(z.read('res/armor_inspector_viewer/'+relative))
            files.append((target,'mods/configs/local.armor_inspector/'+relative,True,False))
    files.extend((ROOT/source,'mods/configs/local.armor_inspector/'+dest,True,False) for source,dest in (
        ('installer/armor-inspector.ico','web/icon.ico'),('README.md','README.md'),
        ('THIRD_PARTY.md','THIRD_PARTY.md'),('licenses/InnoSetup.txt','licenses/InnoSetup.txt')))
    seed=generated/'empty-index.js'
    write_data(str(seed),'index',{'application':'local.armor_inspector','version':VERSION,'updatedAt':None,'battles':[]})
    files.append((seed,'mods/configs/local.armor_inspector/data/index.js',True,True))
    legacy=[json.loads(p.read_text(encoding='utf-8-sig')) for p in sorted((ROOT/'installer/upgrades').glob('*.json'))]
    lines=[]
    checks=['function CheckOwnedFiles(const Folder: String): String;','begin',"  Result := ''; "]
    manifest={}
    for source,relative,keep,only_new in files:
        relative=relative.replace('/','\\')
        dest,_,name=relative.rpartition('\\')
        flags='ignoreversion'+(' uninsneveruninstall' if keep else '')+(' onlyifdoesntexist' if only_new else '')
        lines.append('Source: "'+str(source)+'"; DestDir: "{app}\\'+dest+'"; DestName: "'+name+'"; Flags: '+flags)
        manifest[relative]={'sha256':digest(source),'retainOnUninstall':keep,'onlyIfAbsent':only_new}
        if not only_new:
            old_hash='|'.join(sorted({m[relative]['sha256'] for m in legacy if relative in m}))
            checks.extend(["  Result := CheckUpgradableFile(AddBackslash(Folder) + '"+relative+"', '"+digest(source)+"', '"+old_hash+"');","  if Result <> '' then Exit;"])
    checks.append('end;')
    (generated/'files.iss').write_text('\n'.join(lines),encoding='utf-8-sig')
    (generated/'checks.iss').write_text('\n'.join(checks),encoding='utf-8-sig')
    (generated/'build.iss').write_text('#define ProductVersion "'+VERSION+'"\n#define ModName "'+mod.name+'"\n#define ModHash "'+digest(mod)+'"\n',encoding='utf-8-sig')
    (generated/'payload-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    args=[str(compiler),'/Qp']
    if test: args.extend(['/DTestBuild','/DTestRoot='+str(ROOT/'work/installer-tests')])
    args.append(str(ROOT/'installer/ArmorInspector.iss'))
    subprocess.run(args,check=True)
    output=ROOT/'dist'/('BullbaHits-'+VERSION+'-Setup'+('-Test' if test else '')+'.exe')
    result={'artifact':str(output),'bytes':output.stat().st_size,'sha256':digest(output),
            'innoSetup':'7.1.0','compilerSha256':digest(compiler),'modSha256':digest(mod),'testBuild':test,'digitallySigned':False}
    (ROOT/'outputs'/('installer-test-build.json' if test else 'installer-build.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--test',action='store_true')
    build(parser.parse_args().test)
