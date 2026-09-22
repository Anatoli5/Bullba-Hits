"""Build the script form of the installer: a folder and a ZIP that run no executable of ours.

Smart App Control judges every unsigned EXE of ours by a cloud verdict and regularly refuses it
(error 4551). Windows' own cmd.exe and powershell.exe are Microsoft-signed, so an installer that is
only a .cmd starting a .ps1 has nothing App Control can block. The payload and the checks are the
ones tools/build_installer.py and installer/ArmorInspector.iss already produce; missing here are the
registry entry, the uninstaller and the shortcut.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
from local_armor_inspector.exporter import VERSION

# One generated [Files] line: Source, DestDir under {app}, DestName, Flags.
ENTRY=re.compile(r'^Source: "(.+?)"; DestDir: "\{app\}\\(.+?)"; DestName: "(.+?)"; Flags: (.*)$')
TEMPLATES=('Install.cmd','install.ps1','README.txt')


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def read_entries(files_iss,manifest):
    """The [Files] lines and the payload manifest must describe the same set, byte for byte."""
    entries=[]
    for line in files_iss.read_text(encoding='utf-8-sig').splitlines():
        line=line.strip()
        if not line: continue
        match=ENTRY.match(line)
        if not match: raise ValueError('Could not read a files.iss line: '+line)
        source=Path(match.group(1))
        relative=match.group(2)+'\\'+match.group(3)
        flags=match.group(4)
        if relative not in manifest: raise ValueError('files.iss lists a file the manifest does not: '+relative)
        record=manifest[relative]
        if not source.exists(): raise ValueError('A payload source is missing: '+str(source))
        if digest(source)!=record['sha256']: raise ValueError('A payload source changed since the manifest was written: '+relative)
        if ('onlyifdoesntexist' in flags)!=bool(record['onlyIfAbsent']): raise ValueError('onlyIfAbsent disagrees with the flags: '+relative)
        if ('uninsneveruninstall' in flags)!=bool(record['retainOnUninstall']): raise ValueError('retainOnUninstall disagrees with the flags: '+relative)
        entries.append((source,relative,record))
    if len(entries)!=len(manifest): raise ValueError('The manifest has entries files.iss does not list')
    return entries


def client_facts():
    """Client version, realm and default folder come from the .iss, so there is one source of truth."""
    text=(ROOT/'installer/ArmorInspector.iss').read_text(encoding='utf-8-sig')
    client=re.search(r"VersionText <> '([^']+)'",text)
    realm=re.search(r"realm'\)\.text\) <> '([^']+)'",text)
    folder=re.search(r'(?m)^DefaultDirName=(.+)$',text)
    if not client or not realm or not folder: raise ValueError('Could not read version, realm or default folder from the .iss')
    return client.group(1),realm.group(1),folder.group(1).strip()


def build():
    generated=ROOT/'installer/generated'
    files_iss,manifest_path=generated/'files.iss',generated/'payload-manifest.json'
    for path in (files_iss,manifest_path):
        if not path.exists(): raise ValueError('Run tools/build_installer.py first; missing '+str(path))
    mod=ROOT/'dist'/('local.armor_inspector_'+VERSION+'.wotmod')
    if not mod.exists(): raise ValueError('The built mod is missing: '+str(mod))
    report=json.loads((ROOT/'dist/build.json').read_text())
    if digest(mod)!=report['sha256']: raise ValueError('Mod differs from validated build')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    entries=read_entries(files_iss,manifest)
    client,realm,default_folder=client_facts()
    out=ROOT/'dist'/('BullbaHits-'+VERSION+'-Install')
    if out.exists(): shutil.rmtree(out)
    for source,relative,_ in entries:
        target=out/'payload'/relative.replace('\\','/')
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target)
    document={'application':'local.armor_inspector','version':VERSION,'client':client,'realm':realm,
              'mod':mod.name,'modSha256':digest(mod),'defaultGameFolder':default_folder,
              'note':'files[] is installer/generated/payload-manifest.json as a list; path is both the '
                     'destination under the game folder and the path inside payload\\.',
              'files':[{'path':relative,'sha256':record['sha256'],'retainOnUninstall':record['retainOnUninstall'],
                        'onlyIfAbsent':record['onlyIfAbsent']} for _,relative,record in entries]}
    (out/'manifest.json').write_text(json.dumps(document,indent=2),encoding='utf-8')
    for name in TEMPLATES:
        data=(ROOT/'installer/script'/name).read_bytes()
        (out/name).write_bytes(data.replace(b'{VERSION}',VERSION.encode('ascii')).replace(b'{CLIENT}',client.encode('ascii')))
    # Every staged file takes the .wotmod's own time, so one build of the mod gives one archive
    # however often it is packed (same reason as in tools/build_installer.py).
    stamp=mod.stat().st_mtime
    for path in sorted(out.rglob('*')): os.utime(path,(stamp,stamp))
    os.utime(out,(stamp,stamp))
    archive=ROOT/'dist'/(out.name+'.zip')
    when=time.localtime(stamp)[:6]
    paths=sorted(path for path in out.rglob('*') if path.is_file())
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as package:
        for path in paths:
            info=zipfile.ZipInfo(out.name+'/'+path.relative_to(out).as_posix(),when)
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o644<<16
            package.writestr(info,path.read_bytes())
    result={'artifact':str(archive),'folder':str(out),'bytes':archive.stat().st_size,'sha256':digest(archive),
            'files':len(paths),'payloadFiles':len(entries),'version':VERSION,'client':client,'realm':realm,
            'modSha256':document['modSha256'],'runsNoExecutableOfOurs':True,'installTested':False}
    (ROOT/'outputs'/'script-installer-build.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
    return result


if __name__=='__main__':
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    build()
