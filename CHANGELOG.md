# Changelog

All notable changes to Bullba Hits, newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## Unreleased

- Brothers in Arms is one tile per crew member and counts the way the client does: each tankman with it adds 5/N crew levels to the whole crew, the full +5 only when everyone has it. Until records carry the vehicle's crew, the page assumes five tankmen. Builds saved with Brothers in Arms keep it on every member.
- The equipment and directive pickers no longer start with an "empty" tile that looked like the slot itself: click the fitted piece to take it out.
- While Config is open, the aiming circle and a crosshair move to the middle of the target and stay there when the camera turns, so each tile's effect on the circle is visible. A click in the scene then only closes the menu; closing it gives the aim back to the mouse.
- The "Fitted: …" line under the configuration is gone; the Config button's tooltip still lists the build.
- The aiming circle shrinks back after the turret catches up with the cursor instead of staying bloomed until the mouse moves again, and its Circle % follows every configuration click.
- After a click on a hit, the roster marks that hit's shooter instead of the previous one.

## 0.7.19 (2026-09-21)

- Collision models are resolved from mounted shared and event packages, including Waffentrager vehicles; saved battles can recover their missing parts with the matching client.
- Incomplete or unsupported collision models show an explicit message instead of isolated parts or misleading armour estimates.

- Hit export now coalesces durable log updates, prepares new hits incrementally and retries interrupted publication instead of queueing a full battle rewrite for every hit.
- Repeated armor material tables are stored once and shared by reference; old battle logs remain readable, and changing vehicle configurations retain their own recorded armor.

- Aim configuration rebuilt around the client's own catalogue: pick a slot, then the client's real items in the garage's own grade groups — Standard, Bounty, Improved, Experimental. The invented "variants" std/delux/trophy/trophyUp are gone.
- A tile is an icon: the client's own picture with its grade badge in the corner and not a word on it. The name, the grade, every factor and the client entry id are one hover away. Equipment, directive, consumables and crew alike.
- In the Standard group the Class bands of one device are a single tile — they are the same item for a different vehicle tier, not three rammers.
- Bounty is one grade and counts as the upgraded piece, which is the state a Bounty piece ends up in.
- The grades are the garage's own words — Standard, Bounty, Improved, Experimental. "Trophy" is the client's internal word and is never shown.
- Improved Aiming, the Improved Rotation Mechanism, the Turbocharger and the whole Experimental tier are on the menu at last; 40 devices in ten families instead of four.
- A standard device always counts at its category-slot value, and the question about the vehicle's slot categories is gone with it: the difference was a fraction of a per cent and it cost a select, a note and a branch.
- Only the devices this vehicle may actually mount are offered, read from the tags the record carries. Without them everything is offered and a line under the slots says so.
- Directives: one slot, eight of them, with the factor the client gives for the fitted piece's grade. A directive without its device is offered but shown inactive.
- Consumables: combat rations (+10 crew levels) and Quality / Excellent Fuel, which also speed the turret up.
- Crew: all 19 gunnery skills and perks, grouped by role. A situational perk is a dimmed tile with a corner dot and starts off.
- A turbocharger now raises the speed the emulation accelerates to, which makes the circle bigger — the honest answer. Mag Mastery shortens the interval between the rounds of a clip.
- Every tile of the configuration carries the client's own icon: the new devices, the crew skills, the directives and the consumables no longer fall back to a short text label.
- Saved builds from earlier versions are dropped: the old slots named kinds, not the client's items, and could not be carried over.

## 0.7.16 (2026-09-20)

- The crosshair shape picked in Settings now shows over the model; the canvas kept the plain cross.
- The circle figure of an emulated shot no longer stays on the panel of the next hit, where it hid that hit's own figure.
- The reticle tile follows the Display switch again instead of keeping the other mode's number.
- W A S D no longer sticks when the key is released while a field has the focus.
- Armour data for vehicles whose type name carries a hyphen (E-100, WZ-111 and 82 more).
- Recording no longer switches itself off for the session when the same mod file sits in two client folders.
- The licence of the packed-XML reader and the vendor manifest ship with the page, as the notices promise; the shipped icons are listed in them.
- Installer and README text brought back in line with the page: no “Refresh” button, expected damage as a share of alpha.
- Target modifiers beside the Collision model tile (spall liner, field modification, driver skill) are back: the script was missing from the package since 0.7.12.
- Equipment, perk and shell icons ship with the page; nothing is unpacked from the client on a game start any more.
- Info panels: the "flies past after the ricochet" chip is gone; the ricochet chip and 0 % say it.
- Info panels: the shell's alpha in HP stands beside the chance figure ("62 % / 390").
- Info panels: the "pen NNN mm / NNN m" chip moves from the title row to its own line under the chance, right above the effective armour line.
- On a narrow page the pose tile steps up above the shooter row instead of sitting under the speed tile.
- Battle tile in the heading: framed like the other clickable tiles instead of a dashed underline.
- Battle list: rows are tall enough for the vehicle tile.
- Aim emulation is on by default and is switched in Settings → Scene ("Aim emulation"); the bottom strip
  with the sliders is gone and the "Config" button sits next to the Shooter tile.
- A gun panel beside the Shooter tile: the shooter's shells as the client's own icons — click one to pick
  it for the whole page, in step with the shell list in the heading — and, like the in-game reticle, the
  reload counting down with the rounds left in the clip while you hold the button, the gun's reload time
  and clip size at rest. The shell icons come out of your client on a game start.
- Settings moved from the scene heading up into the header row: the "Statistics log" status first, the
  Settings button in the corner. The swap button now sits beside the Shooter tile, and the speed tile
  stands clear of it at the other end of the row.
- A tap is one shot; holding the button fires on the gun's cooldown until you let go, and a clip stops
  when it is empty. Moving the mouse aims a burst instead of stopping it, and a new press fires at once.
- W A S D drive from the moment the mode is on, wherever the focus is. S brakes a forward run to a stop
  before it reverses and W does the same the other way; A and D turn the hull, which carries the gun with
  it, and the turret chases the crosshair back with what speed it has left. The speed tile shows the km/h
  beside a W-over-A-S-D key glyph that lights the keys you hold, and an arc that shows which way the hull
  is coming round and how fast.
- Every aiming circle that stands still is magenta — the recorded client and server reticles, the nominal
  full-aim ring and the ring your last shot left — and only the live ring is cyan.
- Each circle prints one figure on an info panel: the live cyan ring on "Under the cursor", the magenta
  ring on the hit-line panel above it — "Circle 25 %", the expected damage of a shot inside that circle as
  a share of the shell's alpha. The hit-line figure is the recorded reticle's (or the nominal ring's) until
  you fire, and your own shot's afterwards. The corner readout is gone.
- While you hold the button the aiming circle is the reload indicator, as in the game: it is drawn from
  nothing and fills clockwise while the gun reloads. Let go and the ring is whole again; only the recoil stays.
- Settings → Scene: "Impact mark opacity" (10–100 %, 50 % by default) dims the cross at the impact point,
  which covered the armour when seen from the shooter's seat.
- The ⓘ help badge is a gold glyph instead of a gold disc in the Vehicles panel, and the colour legend has
  been taken off the scene.
- The circle is drawn over the model now, cyan and dashed; the mouse pointer becomes a crosshair
  (cross or dot, Settings → Scene).
- Configuration: three equipment slots with the game's own icons, each in its standard, improved, trophy or
  upgraded-trophy variant, plus the three perks. Icons are unpacked from your client on the next game start.
- The battle's own reticles and tracers stay on screen when the mode goes on and make way for your FIRST
  shot; switching the mode off brings them back (the ◎ toggle is gone).
- A point pinned elsewhere on the model hides the recorded aim circles: they belong to the recorded shot.
- `tools/verdicts_offline.cjs`: the Statistics log pass runs over the exported records outside the game, so the
  page's estimate can be checked against the server's result without the game client open.

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
