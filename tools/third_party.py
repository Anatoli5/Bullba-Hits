"""Third-party .wotmod packages shipped next to ours so the hangar panel works on a standalone install.

Both are MIT (Andrii Andruschyshyn) and designed to be bundled: ModsList's README says "Add ModsList as a
distribution to your mod", and ModsList itself requires OpenWG Gameface. The files are not in the repository;
they sit in work/third-party/ (fetched from the official releases) and every build verifies them by hash.
The installer copies each one only when the game folder does not already have that file, never removes it on
uninstall, and the game loads the newest version of a package id when a modpack brings another.
"""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'work' / 'third-party'
PACKAGES = (
    # (file name, SHA-256, source)
    ('me.poliroid.modslistapi_1.7.9.wotmod', 'd62237cd755412189f1d62855219c9035d0d0fea315a0d4505971639c86d8283',
     'https://gitlab.com/wot-public-mods/mods-list/-/releases'),
    ('net.openwg.gameface_1.1.6.wotmod', '26b190d216c758ccffa824766cbd6bb7cbfc9dfa041e530b99b0d1f02129d5e1',
     'https://gitlab.com/openwg/wot.gameface/-/releases'),
)


def collect():
    """Return the verified package paths, or raise with what is missing and where it comes from."""
    paths = []
    for name, sha256, source in PACKAGES:
        path = FOLDER / name
        if not path.is_file():
            raise FileNotFoundError('Missing ' + str(path) + '; download it from ' + source + ' (SHA-256 ' + sha256 + ')')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != sha256:
            raise ValueError(name + ' does not match the pinned SHA-256: ' + digest)
        paths.append(path)
    return paths
