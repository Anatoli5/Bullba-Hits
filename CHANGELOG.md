# Changelog

Every build that reaches a user gets its own number and its own section here. The release notes on GitHub are
taken from the section of the version being published; a release without its section is refused by the release
script. Versions are listed newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## Unreleased

- Release assets: two files instead of three. The installer comes first; the archive
  `BullbaHits-<version>-Sources-and-manual-install.zip` holds the `.wotmod` files for a manual install, the
  sources, README and licences. Each file is described in the release notes.
- This changelog, shipped with the mod and used for the release notes.
- README: the mod keeps every recorded battle; the text still described the old five-battle limit.
- Display: **Expected damage** — the armour is coloured by what one shot is worth, `chance × alpha +
  (1 − chance) × non-penetration damage`, as a share of alpha on the same palette; the panels, the reticle tile
  and the Hit line show HP. For AP/APCR/HEAT the picture equals the chance map. For modern HE the
  non-penetration damage is a reconstruction (ratio law: spall damage × min(1, 0.1 × spall damage / (plate × liner)), checked against the 200 recorded shots of the Reddit study),
  not a confirmed server formula, and the tooltips say so; SPG (legacy) HE shows "splash not modelled".
- The recorder saves the shell's damage fields (alpha, spall damage, mechanics, randomisation, radii) and the
  target's spall-liner factor. Older battles get the same fields on the next game start, rebuilt from the recorded
  vehicle descriptors (client data, not a guess).
- Target modifiers next to the Collision model tile (Expected damage view, modern HE): spall liner (none / ×1.5 /
  improved ×1.6), the field modification "Spalling resistance" (×0.85 / default / ×1.15) and the driver's Reliable
  Placement (+15 % at 100 %, a reading of the client data). They start from the recorded liner factor and are kept
  per vehicle type for the session; inline when there is room, one "Modifiers ▾" button otherwise.
- Vehicles mode: the filter rows fold under one "Filters" caption (closed by default, count of active pills), so the
  list has room on a 768 px screen; no filter means every vehicle. Switching Battles ↔ Vehicles no longer resets
  the scene: the hit stays on screen, its vehicles become the model and shooter of the list.
- The legend is two rows: the colour bar with 0 / 50 / 100 % laid under it.
- Expected damage is the default Display (Reset to defaults or a fresh browser); Penetration chance stays one click away.
- Hits from a secondary (ability) gun carry that gun's shell, and the shell list of a vehicle includes every gun's shells;
  ability-gun shells are marked ✦. The Taschenratte's 8 cm ability shell keeps its own absorption rule and shows
  "non-pen not modelled" instead of a guessed number.
- HE behind a screen: a shell that does not get through the screen explodes there and deals nothing, so the
  non-penetration damage counts only for the rolls that pass the screen but not the hull (chip "through screen N %").
- Statistics log: HE lines carry the server damage and the prediction of both candidate laws, to pick the law
  from recorded hits. Every line is stamped with the page build and the records build that made the estimate
  (`v=`, `rec=`); the log tool summarises per version.

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
