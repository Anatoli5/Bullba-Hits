# Changelog

Every build that reaches a user gets its own number and its own section here. The release notes on GitHub are
taken from the section of the version being published; a release without its section is refused by the release
script. Versions are listed newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## Unreleased

- **Aim emulation — take the shooter's seat.** Switch it on in Settings → Scene (or in the block under the
  scene; it is off by default) and drive the shooter yourself: **W A S D** move the vehicle, the turret
  follows the cursor at its own rotation speed so the gun lags behind a fast flick, and **a click in the
  scene is a shot** — the tracer goes down the middle of the circle, the recoil blooms it, and the gun
  reloads before the next one, clip guns firing their magazine first. The radius is the one the game itself
  would give: gun accuracy and aiming time, the dispersion the hull speed, the hull turn, the turret turn and
  the recoil add, and the exponential settling after everything stops. The chance to damage and the expected
  damage are integrated over the circle whenever it comes to rest, each shot's own figure is pinned in a list
  of the last five, and the sliders of the strip follow the live state (and can still be set by hand while no
  key is held). Battles and vehicles recorded before this version pick the aiming
  parameters up on the next game start; until then the manual radius of the old estimate stands.
- **Shooter configuration with presets.** One "Configuration" popover holds the whole build — Brothers in
  Arms, Improved Ventilation, Snap Shot, Smooth Ride, the class of the vertical stabiliser, the gun laying
  drive and the gun rammer, how long the vehicle takes to get going and to stop, and the shot distribution —
  with four built-in presets (stock, two snipers, a brawler) and your own, saved, renamed and deleted there
  and remembered per vehicle type. The crew is always the fully trained crew the client computes, the
  commander's bonus included, because that is what a vehicle in a battle has. The short group beside the
  Shooter tile now names the active preset.
- **Where a shot lands inside the circle** is no longer a bare assumption. The page now integrates over the
  published post-9.6 distribution table (Overlord_Prime, 380k shots), checked against 72 of your own recorded
  shots including misses: they put 68–70 % of shots inside half the radius, the table gives 68.9 %, and the
  old Gaussian (σ = half the radius) gives 45.5 %. The scale came out compatible with 1 on the circle the page
  draws, so the table is used directly. The old model is still selectable in the configuration and labelled
  as not matching the measured shots. It is a measurement, not a confirmed server formula, and the page says so.
- The side panel's first mode is called **Hits** (it lists the hits of the recorded battles), and in the
  Vehicles panel the caret that opens Role and Flags moved onto the row of class pills, so those filters
  open directly under the pills instead of under the caption above them.
- Expected damage is now shown as a share of the shell's alpha everywhere (panel under the cursor, Hit line,
  reticle tile, the chips and the circle), instead of HP: “50 %” instead of “275 HP”, so the number reads on
  the same scale as the colours of the model and compares two guns of different alpha. The alpha in HP is
  printed next to the legend and in the aim strip.
- `tools/verdicts_from_log.py` reads several inputs, saves a snapshot of the Statistics log lines (`--save DIR`),
  filters by page build (`--version`), lists HE lines with the server's damage (`--he-rows`) and groups the
  disagreements by pattern (part, server effect, our class).
- The ⇅ swap button works in the Vehicles panel too: the two browsed vehicles change places.
- The Taschenratte ability shell shows its expected damage as a lower bound (≥, penetration only) with the chip
  "non-pen unknown": it does deal damage without piercing, but no law fits the recorded shots.

## 0.7.13 (2026-09-19)

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
- The battle picker is the heading tile again: map name and your vehicle, a caret at the end opens the list; each
  row shows the map and the vehicle, with day and time in small print, no hit count.
- Both scene tiles choose a vehicle in both side-panel modes: click Collision model or Shooter, then pick from
  the battle roster (Battles) or the catalogue (Vehicles); the side panel highlights the vehicle in that role.
  A shooter picked from the roster is shown against the model with his gun and no shot line. The role swap is
  its own ⇅ button next to the Shooter tile.
- Target modifiers next to the Collision model tile (Expected damage view, modern HE): spall liner (none / ×1.5 /
  improved ×1.6), the field modification "Spalling resistance" (×0.85 / default / ×1.15) and the driver's Reliable
  Placement (+15 % at 100 %, a reading of the client data). They start from the recorded liner factor and are kept
  per vehicle type for the session; inline when there is room, one "Modifiers ▾" button otherwise.
- Settings → Scene → **Soft lighting** (on by default; untick it to compare): a soft light over the main armour with smoothed visual
  normals, so round shapes read as round under the colours while plate joints stay sharp. One extra draw per
  redraw, about 10 MB of video memory; nothing in the physics, the chances or the marks changes. Off = the plain map.
- Vehicles panel is the one vehicle chooser: a click on the Collision model or Shooter tile opens it, scoped to
  the current battle (ALLIES / ENEMIES with team stripes, vehicles only), with an "All vehicles" scope for the
  whole catalogue; any filter switches to it. Tier, Nation and Class stay visible; Role and Flags sit behind a
  caret at the end of the Class row, the search behind a magnifier at the end of the Tier row. One count line
  with a yellow info badge that opens a short formatted help. The side column is 300 px so the nations fit in
  two rows. Switching Battles ↔ Vehicles no longer resets the scene.
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
