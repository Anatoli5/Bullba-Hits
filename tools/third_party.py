"""Third-party .wotmod packages shipped next to ours so the hangar panel works on a standalone install.

Both are MIT (Andrii Andruschyshyn) and designed to be bundled: ModsList's README says "Add ModsList as a
distribution to your mod", and ModsList itself requires OpenWG Gameface. The files are not in the repository;
they sit in work/third-party/ (fetched from the official releases) and every build verifies them by hash.
The installer copies each one only when the game folder does not already have that file, never removes it on
uninstall, and the game loads the newest version of a package id when a modpack brings another.

Client 2.4.1.0 (13.10.2026): neither pinned build starts there - gui/impl/gen_utils.pyc is gone from the client and
OpenWG Gameface 1.1.6 imports it at its top level, ModsList 1.7.9 imports that Gameface (read in their bytecode;
C:/Projects/WoT-Base/KNOWLEDGE-client.md, 13.10). So a build for a client outside WORKS_ON ships no panel package:
a modpack's own ModsList still lists our entry, and the page opens by a right-click on a vehicle or the shortcut.
New pins (builds made for 2.4.1) put the panel back: add them to PACKAGES and the client to WORKS_ON.
"""
import hashlib
from pathlib import Path

import client_version

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'work' / 'third-party'
PACKAGES = (
    # (file name, SHA-256, source)
    ('me.poliroid.modslistapi_1.7.9.wotmod', 'd62237cd755412189f1d62855219c9035d0d0fea315a0d4505971639c86d8283',
     'https://gitlab.com/wot-public-mods/mods-list/-/releases'),
    ('net.openwg.gameface_1.1.6.wotmod', '26b190d216c758ccffa824766cbd6bb7cbfc9dfa041e530b99b0d1f02129d5e1',
     'https://gitlab.com/openwg/wot.gameface/-/releases'),
)
WORKS_ON = ('2.4.0.0', '2.4.0.1', '2.4.0.2')   # the clients the pinned builds start on


def collect():
    """Return the verified package paths, or raise with what is missing and where it comes from; none for a client the
    pinned builds do not start on."""
    paths = []
    if client_version.VERSION not in WORKS_ON: return paths
    for name, sha256, source in PACKAGES:
        path = FOLDER / name
        if not path.is_file():
            raise FileNotFoundError('Missing ' + str(path) + '; download it from ' + source + ' (SHA-256 ' + sha256 + ')')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != sha256:
            raise ValueError(name + ' does not match the pinned SHA-256: ' + digest)
        paths.append(path)
    return paths
