# Changelog

All notable changes to Bullba Hits, newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## Unreleased

- Aim emulation moved next to the Shooter tile: an "Aim emulation" switch and a "Configuration" button; the
  bottom strip with the sliders is gone.
- A click is one shot; holding the button fires on the gun's cooldown until you let go, and a clip stops
  when it is empty. A new press always fires at once.
- The last shot leaves its own solid circle and tracer on the model, with the chance and the expected
  damage in the bottom-right corner with an ⓘ; the aiming circle never stops aiming.
- The reload fills an amber arc on the aiming circle, as in the game.
- The circle is drawn over the model now, cyan and dashed; the mouse pointer becomes a crosshair
  (cross or dot, Settings → Scene).
- Configuration: three equipment slots with the game's own icons, each in its standard, improved, trophy or
  upgraded-trophy variant, plus the three perks. Icons are unpacked from your client on the next game start.
- With the emulation on, the recorded reticles and tracers make way for the emulated shot; with it off they are
  always shown (the ◎ toggle is gone).
- A point pinned elsewhere on the model hides the recorded aim circles: they belong to the recorded shot.

## 0.7.14 (2026-09-19)

- Aim emulation (off by default, Settings → Scene): W A S D drive the shooter, the turret follows the cursor at its
  own speed, a click is a shot with recoil and reload; the circle radius follows the game's own formula.
- Shooter configuration with presets: equipment and perks, built-in presets and your own.
- Shot distribution inside the circle: the published post-9.6 table, checked against your own recorded shots;
  the old Gaussian is still selectable.
- Expected damage is shown as a share of alpha instead of HP.
- Side panel: "Battles" is now "Hits"; the Role/Flags caret sits on the class row.
- The ⇅ swap button works in the Vehicles panel; the Taschenratte ability shell shows a lower bound.
- `tools/verdicts_from_log.py`: log snapshots, version filter, HE rows, disagreement patterns.
- Older battles get the aiming parameters on the next game start.

## 0.7.13 (2026-09-19)

- Release assets: the installer and one archive with the `.wotmod` files, sources, README and licences.
  This changelog ships with the mod.
- Display "Expected damage" (now the default): armour coloured by chance × alpha + (1 − chance) × non-penetration
  damage; the HE law is a reconstruction, SPG HE splash is not modelled.
- Recorder saves the shell damage fields and the target's spall-liner factor; older battles get them on the next
  game start.
- Battle picker in the heading tile: map, vehicle, day and time.
- Both scene tiles choose vehicles in both panel modes; the role swap is its own ⇅ button.
- Target modifiers next to the Collision model tile: spall liner, field modification, Reliable Placement.
- Settings → Scene → Soft lighting (on by default).
- Vehicles panel: battle roster or the whole catalogue; Tier/Nation/Class filters, Role/Flags and search behind
  carets, info badge; 300 px column; no scene reset on a mode switch.
- Two-row legend.
- Ability-gun shells in the shell list (✦); the Taschenratte 8 cm shell: non-penetration not modelled.
- HE stopped by a screen deals nothing.
- Statistics log: HE lines carry the server damage and both candidate laws; every line is stamped with the page
  and records build.
- README: the mod keeps every recorded battle.

## 0.7.12 (2026-09-19)

- Fixed: the HEAT jet loss behind a screen is linear from the first screen along the whole way to the armour;
  a second screen in the same gap (a track behind a side skirt) only subtracts its own plate and no longer
  raises the chance. Same rule on the CPU and in the GPU map.

## 0.7.11 (2026-09-19)

- Hits appear in the viewer right after the battle: the battle file is written on the first hit, the collision
  models follow later.
- Collision models are extracted by priority: the hit you open first, then your own vehicle and the vehicles of
  your hits, then the other hits, then the roster for the catalogue. Never during a battle; paced in the hangar;
  paused while the in-game page is being dragged or zoomed.
- A hit whose model is still pending shows a spinner and refreshes on its own when the model is ready.

## 0.7.10 (2026-09-19)

- The player's own vehicle is found correctly even when the battle record opened before the client knew it.
- The vehicle picker lists allies and enemies as two groups (vehicle on the left, nickname on the right, team
  colours); picking a vehicle opens its first hit, or shows the vehicle's own model with the chance map for its
  own gun when it has no hits.
- Turret and gun angles are absolute (hull forward, the gun's own zero) in a pose tile at the bottom right of the
  scene, with the limits.
- The battle picker sits on the heading tile; the side column keeps the vehicle picker, filters and hits.
- Fit and the orbit-centre switch centre the vehicle the same way.
- Defaults: grid opacity 6 %, screen opacity 12 %, ricochet dots on at 3 px (applied on Reset or a fresh browser).

## 0.7.9 (2026-09-18)

- Settings persist across launches; Reset to defaults at the bottom of the Settings menu.
- Grid, grid brightness, grid opacity and screen opacity moved from the toolbar into Settings.
- Every hit the client shows is recorded, with the battle roster; the side column has a Vehicle picker to read
  the battle from any ally's seat.
- "Verdict log" is now "Statistics log". The Ctrl + Alt + B hotkey is gone.

## 0.7.8 (2026-09-18)

- The hangar mods panel ships with the installer: ModsList 1.7.9 and OpenWG Gameface 1.1.6 (both MIT) are
  installed only when the game folder has no copy and are kept on uninstall. The archive carries them too.

## 0.7.7 (2026-09-18)

- Opening without a mods-list panel: the vehicle context menu in the hangar and a hotkey (removed again in 0.7.9).

## 0.7.6 (2026-09-18)

- First build for World of Tanks 2.4.0.1 #950: the installer checks the new version, installs into
  `mods\2.4.0.1` and moves a build left in `mods\2.4.0.0` to the backups. Client contracts re-read, identical.
- Fit keeps the vehicle centred when the distance changes with Auto-frame; wheel distance, scale and zoom ease
  smoothly; Auto-frame on by default.
- Adaptive layout: the scene gets most of the height; shell panel in the heading row; the Hit line tile under
  the cursor panel; one-row toolbar with a More popover; the legend over the scene; the sidebar at one width.
- Tooltips of the reticle chance, the Hit line and the shell types lead with what the number means.

## 0.7.5 (2026-09-18)

- The Detail and Ricochet trace settings hold while dragging (Always stays live).

## 0.7.4 (2026-09-18)

- Smooth camera on its own frame clock; no engine rebuild while dragging the turret; recovery after sleep;
  frame-rate readout in the status line.

## 0.7.3 (2026-09-16)

- Ricochet tint and ricochet dots as two independent rows in Settings; tint 50 % by default.

## 0.7.2 (2026-09-16)

- Ricochet tint slider, dots instead of lines over the bounced-leg zones, seams between parts, wireframe
  through screens.

## 0.7.1 (2026-09-15)

- Thin hatch lines over the bounced-leg zones, hatch spacing slider, live ricochet trace by default.

## 0.7.0 (2026-09-15)

- Second contact after a ricochet traced on the GPU: the map shows where the bounced shell still penetrates.
