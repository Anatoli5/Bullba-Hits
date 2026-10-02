"""The game client this build of Bullba Hits is made and checked for - the one place it is written.

    python tools/client_version.py      prints it and what the installed client says

VERSION names the folder <game>/mods/<VERSION>: the installer puts the recorder there and refuses another version
or realm (installer/ArmorInspector.iss, through tools/build_installer.py). BUILD is the number after '#' in
version.xml: a micro-update of the same version changes only it and the folder stays, so the installer does NOT
compare it (WoT-Base rule W12; an installer of the sister mod that did compare it refused the client of the same
day, 01.10.2026). The check does stop on it (tools/check.py, suite 'client'): after any client update the names
the recorder hooks are looked up again in the new bytecode (tools/inspect_hook_names.py, rule W7), and only then
is BUILD changed here.

Readers: tools/build_installer.py (the folder, the /D defines of the installer script), tools/release_github.py
(the release notes), tools/build_script_installer.py, tools/build_equipment_catalogue.py (the catalogue's label),
tools/check.py.

History: 2.4.0.0 #945 (up to 0.7.5); 2.4.0.1 #950 (0.7.6 - 0.9.2); 2.4.0.2 #964 since 0.9.3 (01.10.2026): all 38
hooked names are in the new bytecode and the hooked functions keep their arguments (Vehicle.showDamageFromShot,
PlayerAvatar.showTracer / updateGunMarker / updateTargetingInfo / __startWaitingForShot,
DamageFromShotDecoder.parseHitPoint, BrowserController.load, calcPitchLimitsFromDesc).
"""
import re
from pathlib import Path

VERSION = '2.4.0.2'             # the folder: <game>/mods/<VERSION>
BUILD = '964'                   # the build of that version the hooked names were last checked on
REALM = 'NA'
VERSION_XML = 'v.%s #%s' % (VERSION, BUILD)                        # <version> of <game>/version.xml
LABEL = 'World of Tanks PC %s %s #%s' % (REALM, VERSION, BUILD)    # as README, CHANGELOG and the catalogue say it
PREVIOUS = ('2.4.0.1', '2.4.0.0')   # folders of earlier clients a recorder of ours may still lie in
GAME = Path('C:/Games/World_of_Tanks_NA')


def split(text):
    """'v.2.4.0.2 #964' -> ('2.4.0.2', '964'); the build is '' when there is no '#'."""
    version, _, build = text.partition('#')
    version = version.strip()
    return (version[2:] if version.startswith('v.') else version, build.strip())


def installed(game=GAME):
    """(version text, realm) of the installed client's version.xml, or None when it is not there."""
    path = Path(game) / 'version.xml'
    if not path.is_file():
        return None
    text = path.read_text(encoding='utf-8', errors='replace')
    version = re.search(r'<version>\s*(.*?)\s*</version>', text)
    realm = re.search(r'<realm>\s*(.*?)\s*</realm>', text)
    return (version.group(1) if version else '', realm.group(1) if realm else '')


def problem(game=GAME, found=None):
    """None when the installed client is the one above, else what differs (another version or realm: another mods
    folder; the same version with another build: only the hooked names have to be looked up again)."""
    found = found if found is not None else installed(game)
    if found is None:
        return 'no version.xml in %s' % game
    version, build = split(found[0])
    if version != VERSION or found[1] != REALM:
        return ('another client: %s %s is installed, this build is for %s %s (mods/%s). Run tools/inspect_hook_names.py '
                'on it, then change VERSION, BUILD and REALM in tools/client_version.py' % (
                    found[1], found[0], REALM, VERSION_XML, VERSION))
    if build != BUILD:
        return ('the same version %s %s, another build: #%s is installed, the names were checked on #%s. Run '
                'tools/inspect_hook_names.py, then set BUILD in tools/client_version.py' % (REALM, VERSION, build, BUILD))
    return None


if __name__ == '__main__':
    print('build for: %s (mods/%s)' % (LABEL, VERSION))
    print('installed: %s' % (installed(),))
    print('problem:   %s' % problem())
