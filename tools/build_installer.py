"""Build the native installer from the existing, hash-verified .wotmod."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
from local_armor_inspector.exporter import ASSETS, VERSION, write_data
sys.path.insert(0,str(ROOT/'tools'))
import third_party


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def signature_info(path):
    """Inspect Authenticode without executing the installer or changing trust."""
    # Prefer the current PowerShell generation; a Core PSModulePath inherited by
    # Windows PowerShell 5 can make its Security module fail to import.
    powershell=shutil.which('pwsh.exe') or shutil.which('powershell.exe')
    if not powershell: raise RuntimeError('PowerShell is required to inspect the installer signature')
    literal="'"+str(path).replace("'","''")+"'"
    script=("$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath "+literal+"; "
            "[pscustomobject]@{status=$s.Status.ToString(); "
            "subject=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}); "
            "publicKeyAlgorithm=$(if($s.SignerCertificate){$s.SignerCertificate.PublicKey.Oid.Value}); "
            "timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress")
    result=subprocess.run([powershell,'-NoProfile','-NonInteractive','-Command',script],
                          check=True,capture_output=True,text=True,timeout=30)
    return json.loads(result.stdout)


def build(test=False,sign_command=None,require_signature=False):
    if require_signature and not sign_command:
        raise ValueError('A trusted RSA signing command is required; provide --sign-command')
    if sign_command and '$f' not in sign_command:
        raise ValueError('Inno signing command must include the $f filename placeholder')
    compiler=ROOT/'work/installer-dependencies/inno-7.1.0/ISCC.exe'
    expected='d06ebd38f38e3cee60a3c50cc45bd449d77e0bc6a5cabc607ea9886808e4de1a'
    if digest(compiler)!=expected: raise ValueError('Inno compiler checksum mismatch')
    generated=ROOT/'installer/generated'
    generated.mkdir(parents=True,exist_ok=True)
    mod=ROOT/'dist'/('local.armor_inspector_'+VERSION+'.wotmod')
    report=json.loads((ROOT/'dist/build.json').read_text())
    if digest(mod)!=report['sha256']: raise ValueError('Mod differs from validated build')
    files=[(mod,'mods/2.4.0.1/'+mod.name,False,False)]
    # The hangar panel (ModsList + OpenWG Gameface): copied only when absent, kept on uninstall, never hash-checked
    # afterwards - a modpack may bring its own build of the same package.
    files.extend((path,'mods/2.4.0.1/'+path.name,True,True) for path in third_party.collect())
    with zipfile.ZipFile(mod) as z:
        for relative in ASSETS:
            data=z.read('res/armor_inspector_viewer/'+relative)
            source=ROOT/'web/index.html' if relative=='Viewer.html' else ROOT/relative
            expected=source.read_bytes()
            if relative=='Viewer.html': expected=expected.replace(b'data-version="dev"',('data-version="'+VERSION+'"').encode('utf-8'))
            if data!=expected: raise ValueError('Stale viewer payload; run tools/build.py: '+relative)
            target=generated/'payload'/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(data)
            files.append((target,'mods/configs/local.armor_inspector/'+relative,True,False))
    files.extend((ROOT/source,'mods/configs/local.armor_inspector/'+dest,True,False) for source,dest in (
        ('installer/armor-inspector.ico','web/icon.ico'),('README.md','README.md'),('CHANGELOG.md','CHANGELOG.md'),
        ('THIRD_PARTY.md','THIRD_PARTY.md'),('licenses/InnoSetup.txt','licenses/InnoSetup.txt'),
        ('licenses/ModsList.txt','licenses/ModsList.txt'),('licenses/OpenWGGameface.txt','licenses/OpenWGGameface.txt')))
    seed=generated/'empty-index.js'
    write_data(str(seed),'index',{'application':'local.armor_inspector','version':VERSION,'updatedAt':None,'battles':[]})
    files.append((seed,'mods/configs/local.armor_inspector/data/index.js',True,True))
    lines=[]
    checks=['function CheckOwnedFiles(const Folder: String): String;','begin',"  Result := ''; "]
    manifest={}
    for source,relative,keep,only_new in files:
        relative=relative.replace('/','\\')
        dest,_,name=relative.rpartition('\\')
        flags='ignoreversion'+(' uninsneveruninstall' if keep else '')+(' onlyifdoesntexist' if only_new else '')
        lines.append('Source: "'+str(source)+'"; DestDir: "{app}\\'+dest+'"; DestName: "'+name+'"; Flags: '+flags)
        manifest[relative]={'sha256':digest(source),'retainOnUninstall':keep,'onlyIfAbsent':only_new}
        # Viewer files inside our own folder are replaced (the previous set is backed up by the installer);
        # only the version-named .wotmod is hash-checked, and a version is never rebuilt under its number.
        if source==mod:
            checks.extend(["  Result := CheckUpgradableFile(AddBackslash(Folder) + '"+relative+"', '"+digest(source)+"', '');","  if Result <> '' then Exit;"])
    checks.append('end;')
    (generated/'files.iss').write_text('\n'.join(lines),encoding='utf-8-sig')
    (generated/'checks.iss').write_text('\n'.join(checks),encoding='utf-8-sig')
    (generated/'build.iss').write_text('#define ProductVersion "'+VERSION+'"\n#define ModName "'+mod.name+'"\n#define ModHash "'+digest(mod)+'"\n',encoding='utf-8-sig')
    (generated/'payload-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    args=[str(compiler),'/Qp']
    if sign_command: args.extend(['/DSignBuild','/SBullbaHitsSign='+sign_command])
    if test: args.extend(['/DTestBuild','/DTestRoot='+str(ROOT/'work/installer-tests')])
    args.append(str(ROOT/'installer/ArmorInspector.iss'))
    subprocess.run(args,check=True)
    output=ROOT/'dist'/('BullbaHits-'+VERSION+'-Setup'+('-Test' if test else '')+'.exe')
    signature=signature_info(output)
    signed=signature['status']=='Valid' and signature['publicKeyAlgorithm']=='1.2.840.113549.1.1.1'
    if sign_command and not signed:
        raise ValueError('Installer does not have a valid trusted RSA signature: '+signature['status'])
    result={'artifact':str(output),'bytes':output.stat().st_size,'sha256':digest(output),
            'innoSetup':'7.1.0','compilerSha256':digest(compiler),'modSha256':digest(mod),'testBuild':test,
            'digitallySigned':signature['status']=='Valid','authenticode':signature,
            'signedInnerSetupRequested':bool(sign_command),'smartAppControlTested':False}
    (ROOT/'outputs'/('installer-test-build.json' if test else 'installer-build.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
    if not signed: print('Unsigned build: Smart App Control may block it. No signing certificate was used.',file=sys.stderr)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--test',action='store_true')
    parser.add_argument('--sign-command',help='Inno SignTool command with $f; use a trusted RSA certificate, never inline passwords')
    parser.add_argument('--require-signature',action='store_true',help='Refuse to build without a signing command')
    options=parser.parse_args()
    build(options.test,options.sign_command,options.require_signature)
