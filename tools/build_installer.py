"""Build the native installer from the existing, hash-verified .wotmod."""
import argparse
import hashlib
import json
import os
import re
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


# Files an earlier build of ours put into mods/configs/local.armor_inspector and the current build no longer ships.
# The installer deletes each before the new files land ([InstallDelete] via generated/retired.iss); one the build
# ships again is skipped. Only the viewer's own files belong here, never data/, battles/, installer/ or settings:
# retired_lines() refuses anything else. Append when a file leaves ASSETS (exporter.py) or the extras below; never drop a
# line - an old game folder may still hold the file. 24.09.2026: the union of installer/upgrades/*.json and every
# ASSETS in the git history of exporter.py (0.2.0 - 0.7.42), minus what 0.7.42 ships.
RETIRED_FILES=('web/heatmap-gpu.js',)
# The viewer's own files only: web/ and licenses/, or a top-level page or document (Viewer.html, README.md, ...).
RETIRED_SAFE=re.compile(r'^(?:(?:web|licenses)(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:html|md))$')


def retired_lines(shipped):
    """[InstallDelete] lines for RETIRED_FILES, minus every path in `shipped` (relative to our folder, '/')."""
    lines=[]
    for relative in RETIRED_FILES:
        if not RETIRED_SAFE.match(relative) or '..' in relative:
            raise ValueError('Retired file outside the viewer files: '+relative)
        if relative in shipped: continue
        lines.append('Type: files; Name: "{app}\\mods\\configs\\local.armor_inspector\\'+relative.replace('/','\\')+'"')
    return lines


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


def build(test=False,sign_command=None,require_signature=False,only=None):
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
    for source,dest in (('installer/armor-inspector.ico','web/icon.ico'),('README.md','README.md'),('CHANGELOG.md','CHANGELOG.md'),
                        ('THIRD_PARTY.md','THIRD_PARTY.md'),('licenses/InnoSetup.txt','licenses/InnoSetup.txt'),
                        ('licenses/ModsList.txt','licenses/ModsList.txt'),('licenses/OpenWGGameface.txt','licenses/OpenWGGameface.txt')):
        target=generated/'payload'/dest
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((ROOT/source).read_bytes())
        files.append((target,'mods/configs/local.armor_inspector/'+dest,True,False))
    seed=generated/'payload'/'data'/'index.js'
    seed.parent.mkdir(parents=True,exist_ok=True)
    write_data(str(seed),'index',{'application':'local.armor_inspector','version':VERSION,'updatedAt':None,'battles':[]})
    files.append((seed,'mods/configs/local.armor_inspector/data/index.js',True,True))
    # Inno packs each file's modification time, so a staged payload rewritten now would make every run of this
    # script a different installer (found 22.09: 9 bytes, new hash, same content). Every staged file takes the
    # .wotmod's own time: one build of the mod gives one installer, however often it is packed.
    stamp=mod.stat().st_mtime
    for source,_,_,_ in files:
        if generated in source.parents: os.utime(source,(stamp,stamp))
    lines=[]
    checks=['function CheckOwnedFiles(const Folder: String): String;','begin',"  Result := ''; "]
    manifest={}
    for source,relative,keep,only_new in files:
        relative=relative.replace('/','\\')
        dest,_,name=relative.rpartition('\\')
        flags='ignoreversion'+(' uninsneveruninstall' if keep else '')+(' onlyifdoesntexist' if only_new else '')
        lines.append('Source: "'+str(source)+'"; DestDir: "{app}\\'+dest+'"; DestName: "'+name+'"; Flags: '+flags)
        manifest[relative]={'sha256':digest(source),'retainOnUninstall':keep,'onlyIfAbsent':only_new}
        # Viewer files inside our own folder are replaced (no copy of the previous set is kept, 24.09);
        # only the version-named .wotmod is hash-checked, and a version is never rebuilt under its number.
        if source==mod:
            checks.extend(["  Result := CheckUpgradableFile(AddBackslash(Folder) + '"+relative+"', '"+digest(source)+"', '');","  if Result <> '' then Exit;"])
    checks.append('end;')
    (generated/'files.iss').write_text('\n'.join(lines),encoding='utf-8-sig')
    (generated/'checks.iss').write_text('\n'.join(checks),encoding='utf-8-sig')
    prefix='mods/configs/local.armor_inspector/'
    shipped=set(relative[len(prefix):] for _,relative,_,_ in files if relative.startswith(prefix))
    (generated/'retired.iss').write_text('\n'.join(retired_lines(shipped))+'\n',encoding='utf-8-sig')
    (generated/'build.iss').write_text('#define ProductVersion "'+VERSION+'"\n#define ModName "'+mod.name+'"\n#define ModHash "'+digest(mod)+'"\n',encoding='utf-8-sig')
    (generated/'payload-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    # Two forms of the same installer from one script and one payload. The single EXE in dist/: Inno's loader
    # unpacks the setup engine into %TEMP% and runs it there - the copy Smart App Control refused on 22.09
    # (error 4551). The loaderless set in dist/noloader/: the engine itself plus the .bin data beside it, nothing
    # run out of %TEMP%, and an EXE with no version data in it, so it is the same file for every build (.iss).
    variants=[v for v in ('loader','noloader') if only in (None,v)]
    results={}
    for variant in variants:
        out_dir=ROOT/'dist'/('noloader' if variant=='noloader' else '')
        out_dir.mkdir(parents=True,exist_ok=True)
        args=[str(compiler),'/Qp','/O'+str(out_dir)]
        if variant=='noloader': args.append('/DNoLoader')
        if sign_command: args.extend(['/DSignBuild','/SBullbaHitsSign='+sign_command])
        if test: args.extend(['/DTestBuild','/DTestRoot='+str(ROOT/'work/installer-tests')])
        args.append(str(ROOT/'installer/ArmorInspector.iss'))
        subprocess.run(args,check=True)
        base='BullbaHits-'+VERSION+'-Setup'+('-Test' if test else '')
        output=out_dir/(base+'.exe')
        signature=signature_info(output)
        signed=signature['status']=='Valid' and signature['publicKeyAlgorithm']=='1.2.840.113549.1.1.1'
        if sign_command and not signed:
            raise ValueError('Installer does not have a valid trusted RSA signature: '+signature['status'])
        parts=[output]+sorted(out_dir.glob(base+'-*.bin'))
        result={'variant':variant,'artifact':str(output),'bytes':output.stat().st_size,'sha256':digest(output),
                'files':[{'name':p.name,'bytes':p.stat().st_size,'sha256':digest(p)} for p in parts],
                'innoSetup':'7.1.0','compilerSha256':digest(compiler),'modSha256':digest(mod),'testBuild':test,
                'digitallySigned':signature['status']=='Valid','authenticode':signature,
                'signedInnerSetupRequested':bool(sign_command),'smartAppControlTested':False}
        name=('installer-test-build' if test else 'installer-build')+('-noloader' if variant=='noloader' else '')+'.json'
        (ROOT/'outputs'/name).write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result,indent=2))
        results[variant]=result
    if not all(r['digitallySigned'] for r in results.values()):
        print('Unsigned build: Smart App Control may block it. No signing certificate was used.',file=sys.stderr)
    return results


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--test',action='store_true')
    parser.add_argument('--sign-command',help='Inno SignTool command with $f; use a trusted RSA certificate, never inline passwords')
    parser.add_argument('--require-signature',action='store_true',help='Refuse to build without a signing command')
    parser.add_argument('--only',choices=['loader','noloader'],help='Build one form only; both by default (dist/ and dist/noloader/)')
    options=parser.parse_args()
    build(options.test,options.sign_command,options.require_signature,options.only)
