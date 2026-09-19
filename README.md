# Bullba Hits

Local hit recorder and collision-armour viewer for **World of Tanks PC NA 2.4.0.1 #950**.

The `.wotmod` recorder saves events inside the game. The viewer is a local HTML page with WebGL: no HTTP server, no service, no autostart and no mandatory network connection. Vehicle models are extracted on the user's computer from the installed client and are not part of the repository.

## Download

Installers are published on the [Releases](https://github.com/Anatoli5/Bullba-Hits/releases) page. Every release ships two files: `BullbaHits-<version>-Setup.exe`, the installer, and `BullbaHits-<version>-Sources-and-manual-install.zip` with the `.wotmod` files for a manual install, the mod sources, README and licences. The release notes carry the SHA-256 of each file and the version's section of [CHANGELOG.md](CHANGELOG.md).

The installer is not code-signed. Windows SmartScreen or Smart App Control may warn about it or block the first run; see the signing section below.

## Features

- History of incoming and outgoing hits with the hit point and shot direction.
- Automatic shell selection from the hit data; nominal penetration, calibre, ammunition comparison.
- GPU chance map that accounts for angle, distance and screens, drawn in screen space from depth layers. Red → yellow → green by default. No CPU heatmap or per-frame CPU/GPU comparison. If GPU composition is unavailable, the model stays neutral and shows the reason.
- Turret rotation and gun elevation within the recorded limits; independent distance and optical zoom.
- Saved client and server circles of your own reticle, automatic chance along the hit line and a nominal estimate over the dispersion circle.
- Opens as a separate Edge/Chrome window from the shortcut and in the game's built-in browser.

The enemy crosshair and aiming are never guessed. Penetration from the shell data is never presented as the rolled RNG. The dispersion estimate uses a nominal clipped Gaussian, not a confirmed server formula. Replays, blast damage and map obstacles are not modelled. After the pose changes, historical marks stay hidden until the recorded pose is restored.

## Installation

1. Close the game and run the installer.
2. Select the World of Tanks root folder. The **Bullba Hits** shortcut is created when the box is ticked.
3. Start the game with the mod. The hangar mods panel (top left) has a Bullba Hits entry; right-click on a vehicle opens it as well. The panel is the open-source ModsList with OpenWG Gameface: the installer adds them only when the game folder has no copy, and a modpack's own copy is left alone. Manual install from the ZIP: put every `.wotmod` from its `mod` folder into `mods\2.4.0.1\`.
4. After a battle open the viewer; new battles appear on their own. If the page was open during an update, reload it with Ctrl+F5.

Data and the page live in `<game>/mods/configs/local.armor_inspector/`. To move the history, keep that whole folder. The installer keeps records and moves any previous build of our mod to a backup; other mods are not touched. After a mod pack that wipes `mods`, Bullba Hits may need to be installed again.

The mod keeps every recorded battle. A collision model is removed only when no battle and no exported vehicle references it any more.

## Sources and build

- `mod/` — recorder, local file export and geometry extraction; game-side Python 2.7.
- `web/` — HTML/CSS/JavaScript, Three.js, CPU ballistics and GPU shaders.
- `installer/` — Inno Setup script and the hash manifests that make upgrades safe. The `upgrades/` manifests are not old builds; the current installer needs them.
- `tools/` — build, packaging, installer and release scripts.

Building runs on Windows with Python 3. Tool dependencies are not in Git:

1. [OpenWG build](https://gitlab.com/openwg/openwg.build), commit `d0704c7dbd062c861582c90a761a7e019af9b60a`. Place its tree in `work/research-options/sources/openwg--openwg.build/`; the compiler is expected at `bin/windows_amd64/owg_python_compiler/owg_python_compiler.exe`. Its SHA-256 is pinned in `tools/build.py`.
2. The full **Inno Setup 7.1.0** compiler directory is expected in `work/installer-dependencies/inno-7.1.0/`, including `ISCC.exe`. `tools/fetch_installer_compiler.py` downloads the official distribution and verifies its hash; unpacking the compiler directory is a separate step. The SHA-256 of `ISCC.exe` is pinned in the installer build tool.
3. Three.js is vendored in `web/vendor/` with its licence and source manifest.

From the project root:

```powershell
python tools/build.py
python tools/package.py
python tools/build_installer.py
python tools/release_github.py
```

Results: `.wotmod`, ZIP and EXE in `dist/`. These commands do not install the mod into the game. The release script tags `v<version>`, creates the GitHub release and uploads the two files, with the version's changelog section as the notes. Users of the installer need neither Python nor the build tools.

Every build that reaches a user gets its own version number; a version is never rebuilt under an existing number.

### Signing and Smart App Control

A plain local build is unsigned: Smart App Control may block it even if the previous release ran. A clean compile and a SHA-256 do not replace a digital signature. The builder records the actual Authenticode status in a local report; a successful build does not mean the run under SAC was verified.

A signed release needs a trusted RSA publisher certificate or a signing service. Inno Setup must sign not only the final EXE but also the temporary Setup copy and the uninstaller: the builder enables `SignTool` and `SignedUninstaller=yes` for that. Signing only the outer EXE after the build is not enough for the inner files.

Example, after the certificate is in the Windows store and SignTool is installed (replace the two placeholders):

```powershell
python tools/build_installer.py --require-signature --sign-command 'signtool.exe sign /sha1 CERTIFICATE_THUMBPRINT /fd SHA256 /tr RFC3161_TIMESTAMP_URL /td SHA256 $f'
```

`$f` is substituted by Inno Setup itself. Never put passwords or private keys into the command or the repository. The mandatory-signature mode refuses to build without a sign command; after a signed build the trusted RSA signature of the outer EXE is verified. Passing every install/uninstall path under SAC needs a separate check on the target system. Changing Windows policies, a self-signed certificate or a swapped version number are not used as a way to obtain a trusted release.

References: [Microsoft — code signing for SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), [Inno Setup — signing inner files](https://jrsoftware.org/ishelp/topic_setup_signeduninstaller.htm).

The repository contains the current code. Development history, agent context, local reports, battles, game resources, old builds and working copies are excluded from Git. Third-party sources and licences are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
