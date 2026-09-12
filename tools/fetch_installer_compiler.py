"""Fetch the pinned official Inno Setup release; never install it globally."""
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
folder=ROOT/'work/installer-dependencies'
folder.mkdir(parents=True,exist_ok=True)
request=urllib.request.Request('https://api.github.com/repos/jrsoftware/issrc/releases/tags/is-7_1_0',headers={'User-Agent':'ArmorInspector-build'})
with urllib.request.urlopen(request,timeout=40) as response: release=json.load(response)
asset=next(a for a in release['assets'] if a['name']=='innosetup-7.1.0-x64.exe')
with urllib.request.urlopen(asset['browser_download_url'],timeout=60) as response: data=response.read()
digest=hashlib.sha256(data).hexdigest()
assert asset['digest']=='sha256:'+digest
target=folder/asset['name']
target.write_bytes(data)
(folder/'source.json').write_text(json.dumps({'version':'7.1.0','url':asset['browser_download_url'],'sha256':digest,'releaseTag':release['tag_name']},indent=2),encoding='utf-8')
print(json.dumps({'path':str(target),'sha256':digest,'bytes':len(data)}))
