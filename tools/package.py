"""Distribute one mod, installation helper and sources. No executable/runtime/server."""
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'mod'))
from local_armor_inspector.exporter import VERSION
sys.path.insert(0,str(ROOT/'tools'))
import third_party


def package():
    name='BullbaHits-'+VERSION+'-Sources-and-manual-install'
    dest=ROOT/'dist'/name
    dest.mkdir(parents=True,exist_ok=True)
    sources=[ROOT/n for n in ('README.md','CHANGELOG.md','THIRD_PARTY.md')]
    sources.extend((ROOT/'licenses').glob('*'))
    sources.extend((ROOT/'mod').rglob('*.py'))
    sources.append(ROOT/'dist'/('local.armor_inspector_'+VERSION+'.wotmod'))
    sources.extend(third_party.collect())  # the hangar panel packages, see THIRD_PARTY.md
    files=[]
    for src in sources:
        rel=Path('mod')/src.name if src.suffix=='.wotmod' else src.relative_to(ROOT)
        out=dest/rel
        out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(src,out)
        files.append(out)
    manifest={p.relative_to(dest).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    (dest/'SHA256SUMS.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    files.append(dest/'SHA256SUMS.json')
    archive=ROOT/'dist'/(name+'.zip')
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(files):z.write(p,name+'/'+p.relative_to(dest).as_posix())
    print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(files)},indent=2))


if __name__=='__main__':package()
