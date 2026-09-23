# Changelog

All notable changes to Bullba Hits, newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## 0.7.40 (2026-09-23)

- A help dot (?) shows one line per control - what it does - and the details come with a click on the control; the ⌖ help starts with what the switch does, not with the model tile.

## 0.7.39 (2026-09-23)

- Tooltips no longer pop up on hover: click a figure to see its tooltip; a “?” shows its group’s summary and starts help mode, where a click on any button explains it instead of pressing it (Escape or the same “?” leaves). Config has its own “?”; the tooltip box is plainer.
- Characteristics panel: every row sits on one three-column grid, so the figures line up across sections.

## 0.7.38 (2026-09-23)

- Config: the icons of the devices, directives and crew skills that do not shoot (Coated Optics, Camouflage Net, Eagle Eye and the rest) show again; they were missing since 0.7.28.

## 0.7.37 (2026-09-23)

- Tooltips are short and structured: a heading, key points in bold, groups.

## 0.7.36 (2026-09-23)

- Switching the orbit centre between ⊙ Vehicle and ⊙ Hit keeps the tank framed again; with Auto-frame off it jumped off the screen.

## 0.7.35 (2026-09-23)

- The Target HP / RNG / Hitmarks switch is a crosshair icon ⌖ (was ✸). The camera's orbit-centre buttons now read ⊙ Vehicle / ⊙ Hit.
- With ⌖ on, the reload, magazine, gun heat and mode button stand in a strip at the top beside the model tile, with ◔ real reload, the target's health bar and ↺ (the bottom panel keeps the shells); with ⌖ off the strip is gone - nothing then blocks a shot. On a narrow screen the strip drops under the tile, and below the info panels if they are in the way.
- ⌖: a press the gun refuses (reloading, a burst still going out, overheated, switching mode) makes the blocking indicator and the aiming circle blink red.
- Characteristics, expanded view: the whole Survivability group as in the garage - hit points, hull and turret armour (front / sides / rear; no turret line on turretless vehicles) and suspension repair time. The mod rewrites every characteristics file once for this.
- Config: the empty slot is back at the top of the equipment and directive pickers.
- Config: field modification by the vehicle's own tree and level: standard modifications on/off, dual modifications one of two (click the other side to swap, click the lit one to clear). Counted by the game's rule on the aiming circle and in the characteristics panel's build view; once anything is on, it replaces the field modification the record carries.

## 0.7.34 (2026-09-23)

- ✸ is off each time the page opens: a hit shows as it was recorded until you switch the emulation on.
- Characteristics: the reload line on top, above DPM, as the garage prints each gun: magazine rounds on the left, the reload in the middle, the time between rounds (or bursts) on the right; autoloader slots, dual-gun salvo preparation, twin-gun mode switch, automatic and Ares continuous fire.
- Characteristics: hit points in the compact view; sections follow the garage's groups (Firepower, Survivability, Mobility, Concealment, Spotting), each under a thin rule with its glyph.
- Characteristics: the gun chip shows the gun, its calibre and tier; a click lists the guns of the current turret. The turret is picked in Config (Turret row), or in the same list while Config is hidden.
- Characteristics: Black Rock's reload is correct on battles recorded before 0.7.27; a gun's horizontal limits sit where the garage prints them (turretless vehicles after the elevation limits).
- Help dots (?) by the ✸ switches, the shooter's gun panel, the camera toolbar, the shell block, the hit filter, the characteristics panel, the Statistics log and the vehicle list: hover shows, a click pins every tooltip of that group.

## 0.7.33 (2026-09-23)

- Tooltips work in the game's browser too: the page draws them itself. Hover an icon or tile for its explanation; click one that is not a button to pin it open, Escape or a click elsewhere closes it.
- ✸: the gun panel's mode button switches a vehicle's second mode with the game's own switch times: siege of the hydraulic tank destroyers (Strv 103, UDES 03, Kunze Panzer and others), the turbine (CS-63, CS-52 C, Ogar, Vercingétorix, Char Mle. 75), Rapid of the French wheeled vehicles, the salvo of the British twin guns. The gun does not fire while it switches and the vehicle stops; the second mode brings its own circle, aiming, stabilisation and top speed.
- ✸: a hydropneumatic vehicle's automatic siege shows on the same button as an indicator (it tilts the hull below its speed; the circle does not change).
- ✸: Strv 107-12 - a tap switches siege / travel, holding the button 1 s goes into the pillbox or out of it, as in the game.
- ✸: a tank destroyer with a fixed gun holds it on the hull's axis while driving or switching; past its sector the hull turns by itself towards the aim. A French wheeled vehicle does not turn on the spot, and in Rapid it turns slower, as its narrower wheel lock allows (×0.41 on the EBR 105, our estimate).
- ✸: the rocket booster of the Chinese heavies and others (BZ-176, BZ-75, DZT-159, Yong Bing, T 56 G, Schwertwal, Tiger (P) CFE…) on the mode button: its time, recharge and uses; faster forward, slower turning - the circle grows only with the speed.
- Characteristics: a second-mode switch beside ⚙ shows the second mode's figures, better or worse than the first in colour; under ✸ it follows the emulator's mode. Switch times; the vertical and horizontal limits with hull aiming as the garage prints them (Strv 103B -11/11 and 0/0).
- A turret and gun the game holds fixed (Strv 103 and other tank destroyers) can no longer be dragged on the model.
- ✸: the Ares and STK-2 heat bands now widen the circle on real records too (the recorded modifier name was not recognised).
- The mod records the second mode's switch, the hull aiming and the fixed gun angles; older battles get the second mode's circle when republished.

## 0.7.31 (2026-09-23)

- Ares, M-II-Y ... M-VII-Y, AHT-7, LTC II: the outer track pair is recorded, drawn and judged as a part of its own. Hits on an Ares 90 or M-V-Y recorded on this client version that were shown without a model get the model and the verdict at the next game start.
- ✸: a tank destroyer's or a limited turret's gun stops at the edge of its horizontal sector; beyond it only turning the hull (A/D) brings it round, and the circle gets no turret term while the gun sits at the edge.
- Kunze Panzer, Kpz 3 GST Turm, CC 3, CC mod. 64, CC-67 B, Controcarro 1 Mk. 2, Object 168N: a dragged turret turns on its own tilted ring, as in the game; hit marks turn with it.

## 0.7.30 (2026-09-23)

- ✸: one mode button in the gun panel for tier XI vehicles with a mode or ability of their own, starting from the state the shot was recorded in; words in its tooltip.
- CS-67 Szakal: the button switches the fight and turbo stances (3 s); turbo widens the circle in motion and after a shot and aims slower, the fight energy builds and at 100 fires the fight ability (circle ×0.8, aiming ×0.75, reload ×0.8 for 13 s).
- XM69 Hacker: the button starts the gyro for 10 s (no dispersion from movement or turning, aiming ×0.3, circle ×0.94), then a 40 s cooldown.
- Strv 107-12: the button switches the pillbox (5 s from travel, 3 s from siege): the siege circle ×0.85, reload ×0.925, the vehicle does not drive.
- Black Rock: the button switches the Burst mode - one press fires both rounds 1.5 s apart, no dispersion from movement or turning, aiming ×0.3; single rounds otherwise.
- Ho-Ri Shugo and Taschenratte: the button takes up the rocket launcher / support mortar with its own circle, reload and magazine; the other gun keeps reloading, and the shell on screen follows the gun.
- leKpz Borkenkäfer: the button arms the designator; the next round marks the target for 10 s, and every hit on it rolls ×1.1.
- Leopard 120 Verbessert (accuracy stacks) and T803 (battle fury) run by themselves; CAV mod. 71 spends a surge charge on the round loading back (8.5 s).
- Breaker, AS-XX 40 t and AMX 67 Imbattable get the button dimmed, with why their mechanic is not emulated yet.
- A hit on a target marked by a Borkenkäfer: the assumed shell allows the ×1.1-1.15 damage, and the hit panel's tooltip says so.
- The mod records the Borkenkäfer mark on the target and the second gun's circle and reload (Ho-Ri Shugo, Taschenratte).

## 0.7.29 (2026-09-23)

- Penetration changes with distance as in the client: full up to 50 m, then along the line through the 500 m value, still falling past 500 m, and 0 beyond the shell's range (was: from 100 m, flat after 500 m).
- Polish smoothbore APCR (Grom, Kilana, Husarz, Gonkiewicza, Błyskawica, Bzyg) lose damage with distance as in the client: damage figures, the ✸ roll, the assumed shell and the Statistics log use the alpha at the range (Błyskawica at 300 m: 522, not 800).
- A crit on the outer track of a twin-track vehicle is named the outer track, not the inner one.
- ✸: one press fires a burst gun's whole burst (Donnola, Char Mle. 75, Durendal, MBT-B, 121-2 Ziqiang, tier I-IV autocannons); the rounds before the last widen the circle by the gun's own in-burst factor (Donnola: ×1.41, then ×8.06 after the last round, was ×8 on every round).
- ✸: an automatic gun's circle grows round by round as in the game (Ares 90: ×1.10 after the first round, ×4.6 after the tenth, was ×4.12 from the first) and settles once you let go.
- ✸: dual-accuracy guns (Type 57, Type 63 HT, Type 68, Type 71, SZDV Vz. 50, Kame, Ashigaru, Headshaker) widen the whole circle after every shot by their own factor for their cooling delay (Type 71: ×1.73 for 12 s).
- ✸: the STK-2 heats up and widens its circle by its heat bands like the Ares, but never locks (×1.227 cold, ×1.91 in steady fire).
- ✸ with ◔: an improved autoloader (Progetto 54/66, Bisonte C45, Stone Sentinel, Toro, Rinoceronte, Bélier) loads the next round faster when you fire after a pause.
- A shot fired in a siege or alternative mode uses that mode's own dispersion, aiming time and reload (Strv 103B, Strv 107-12, the Contriver and the rest of the 34 second-mode files that change the circle); the mod now records the second mode's aiming numbers, and the recorded ring of such a shot is drawn from them with or without ✸.
- A hit whose tracer is faster than the stock shell by the tier XI skill-tree velocity bonus now names its shell instead of assuming it (Breaker, KR-1, Taschenratte and 14 more).
- The mod records each gun's in-burst dispersion factor where it differs from the normal one (Donnola, Black Rock).

## 0.7.28 (2026-09-23)

- The gun panel shows the magazine as a row of rounds instead of the "2/3" text, whenever the emulation is on: loaded, spent, the next round lit, the one loading filling up; a single-shot gun shows one round filling with its reload, a magazine over 12 rounds (Ares) one bar. The numbers are in its tooltip.
- Under ✸ with real reload ◔ an autoloader now loads its spent rounds back one at a time, each on its own timer from the game's data, and fires what it has; the reload figure at rest is its empty-magazine round.
- Each shot now also records the live state of the remaining special mechanics: tier XI abilities and modes, Ares and STK-2 gun heat, autocannons, dual-accuracy guns, rocket boost. Private state only on your own shots.
- The mod now writes a characteristics file for every vehicle type it exports: every turret and gun combination on the top modules, with health, mass, engine power, view range, concealment, elevation limits, ammunition and shells. It is built once per type and client version, outside battles, and the page can ask for a missing one. The characteristics panel below reads it.
- Exported vehicles and recorded shooters now carry the exact gun and turret names, and exported vehicles their health.
- A characteristics panel in the bottom-right corner of the scene shows the shooter’s garage figures: damage per minute, reload, dispersion, aiming time, turret and hull traverse, top speed, specific power and the three dispersion factors of movement. ▴ opens the rest: the gun’s shells, weight, engine power, hit points, gun elevation, view range and concealment. Icons and numbers only, the words are in the tooltips. It appears once the vehicle has a characteristics file.
- ⚙ on the panel switches between the stock (top modules, a trained crew, nothing fitted) and this shooter’s Config build; figures better than the stock turn green, worse ones red.
- A vehicle with several guns or turrets gets a gun tile on the panel to look at the others. The choice is kept per vehicle; the circle keeps the gun that fired.
- Config offers every device of the game, and the ones that do not shoot count on the panel: optics, binoculars, camouflage net, exhaust, grousers, hardening, and every device’s weight. The rotation mechanism now also turns the hull faster in the WASD emulation.
- New Config tiles: Concealment for each crew member, Recon, Situational Awareness, Off-Road Driving, Engineer, the Optical Calibration, Fuel Filter Replacement and Exhaust Insulation directives, and a camouflage paint tile.
- Fixed: Mag Mastery shortened the gap between the rounds of a magazine. As in the game, it now shortens the reload of the whole magazine (not on autoloaders): the rounds of a clip keep the gun’s own pace and the clip reloads 2.5 % faster.
- A vehicle picked in the Vehicles list now has hit points for the health bar, from its export or its characteristics file.

## 0.7.27 (2026-09-22)

- A shell that glances off and flies clear now counts as a ricochet in the Target HP tooltip instead of "no estimate".
- Hitmarks are cut out of the armour along the shell's own line, centred on the hit: a square-on hit leaves a round mark, a hit at an angle an oval drawn out along the plate for as long as the angle makes it, with no length limit. The plate's edge ends it; it never hangs over the edge and never spills onto the next plate or a plate behind.
- Hitmarks are 0.7 calibre across, with no minimum: a 20 mm gun leaves 14 mm. A shell with no calibre in the record leaves no mark.
- What the marks look like: a penetration is a black hole with a dark red glow inside, bare steel round it and a thin burnt edge; a stopped shell is a grey metal scrape, paint burnt black round bright metal; a ricochet is a lighter grey skid. None of them uses a colour of the hit map.
- A shot leaves a Hitmark at every plate it met, not only the first: a hole in each screen or track it went through, then its own outcome on the plate where it ended. A shell that glances off leaves the skid and a mark on whatever it flies into next; an HE shell that dies on a screen leaves its mark there and nothing behind. All of them count as one shot of the 500 kept.
- Hitmarks on the turret and the gun turn and pitch with them instead of hanging in the air, and stay on the same spot of the turret when the scene is rebuilt for another shooter or another hit on the same vehicle.
- Recordings from this build carry the gun's heat parameters for the five Ares and the STK-2: heat per shot, cooling, the temperature bands that widen the circle and the Ares overheat lock. Older recordings do not have them.
- Fixed: the gun mechanics that belong to the gun rather than to the vehicle were never seen by the recorder, so the German shell switchers, the Gorilla, the Fauteur and the Black Rock recorded neither the mechanic's name nor its state at the shot.
- ✸ mode: an Ares gun heats with every round, widens its aiming circle as it gets hot (×1.25, then ×1.5) and locks when it overheats until it has cooled right down, by the gun's own numbers from the record. A small heat bar in the gun panel shows it; the figures are in its tooltip.
- ✸ mode: a second button beside ✸, real reload (◔, on by default). On, the gun loads as in the game: letting go does not reset the reload, a press before the gun is loaded does not fire, and a clip keeps its rounds between presses and reloads in full once empty. Off, the old simplified emulation.

## 0.7.26 (2026-09-22)

- Battle files are much smaller. What a vehicle brings to a battle - the gun's pitch table, the vehicle's passport and aim block, the static part data and the shell lists - is now written once per battle and named by every hit that uses it, instead of being copied into all of them. The 62 recorded battles go from 161.5 MB to 50.7 MB, the biggest one from 14.2 MB to 2.1 MB, and a battle opens with less to read.
- New recordings keep the gun's pitch table once per gun configuration in the raw file too, instead of 22 KB in every single hit. Publishing a 405-hit battle now takes 38 ms of the export thread instead of 302 ms, so the page keeps up with a busy battle.
- Every battle recorded before this build is read exactly as it was. A reference whose table is missing leaves the field empty and says so in the hit's warnings; no value is ever made up.
- The battle header now records where the battle came from.
- Recordings now carry what a later pass needs to check the aiming circle against the shot that really left the barrel: the player's own gun axis and gun pitch at the tracer, how old the last server aim vector was, the time of his previous shot, and the last six seconds of every shooter's movement - position, speed, hull turn rate, hull, turret and gun angles, five times a second - attached to his own tracers and to the hits he takes.
- Target HP, the RNG shot and the hit dots are one mode with one switch, and it stands on the scene beside the collision-model tile instead of in Settings: a button that lights up while the mode is on. The two Settings rows are gone, and a store that still holds them drops them.
- The dots have a name now, Hitmarks, and they are visible: every one of them used to be laid facing into the armour and thrown away by the graphics card, because the exported collision meshes are wound the other way round. They are laid along the side the shot came from instead.
- Picking another shooter no longer empties the health bar and no longer leaves the ↺ doing nothing: the health belongs to the vehicle on screen, not to the hit, so it survives a change of shooter with its Hitmarks and only another vehicle starts afresh.

## 0.7.25 (2026-09-22)

- The Circle figure of the recorded shot no longer blinks and is no longer recomputed when the Distance slider moves: that ring belongs to a shot fired at its own range, so its figure is taken with the shell at that range and the tile keeps its number while a new one is worked out.
- The Circle figures are coloured by the chance scale, like the armour under them; the heading keeps the colour of the ring it belongs to.
- The scene toolbar loses the circle percentage and the (i) beside it — the figure has its own tile at the right edge of the scene.
- Settings: the Grid tick box now carries its brightness and opacity sliders in its own row, like Ricochet tint and Soft lighting, and both are greyed out with the grid off. Soft lighting starts at 200 % instead of 250 %.
- The mouse wheel over a slider now accelerates: a slow turn moves one step, a continuous spin steps further and further (up to a tenth of the scale per notch), and a pause or the other direction goes back to the smallest step.
- The ⇅ swap button is offered again wherever the shooter has a model to be had: a model still being extracted is waited for, a shooter with no parts in the record is read from his own vehicle export, and the button no longer disappears when the side panel is switched to Vehicles.
- The live state of the shooter's gun is recorded at the shot and at the impact — the charge level of the Object 432U, the Gorilla's low charge, the German shell switch, the overheat level and the rest. A charged shot now shows the charged alpha (×1.045, ×1.177 or ×1.244), the Gorilla's low charge picks the low-charge shell, and every other mechanic gets a line in the shell tooltip without changing a figure. Incoming shots with no recorded state are read exactly as before.
- Two new Settings switches, both off by default. Target HP gives the vehicle on screen a health bar, filled from the hit points the battle recorded for it (this battle's own values, so an Onslaught vehicle gets its Onslaught health); Hit marks leaves a small coloured dot on the armour where each emulated shot landed. With either of them on an emulated shot no longer flies through the middle of the aiming circle: its impact point is drawn at random inside the circle, by the same distribution the circle's own percentage is worked out with, and the shot line and the panel follow that point.
- With Target HP on, a shot that gets through rolls its damage — alpha, or the reconstructed non-penetration damage, times one plus or minus the shell's own spread (0.25 normally, 0.12 in an Onslaught record) — and takes it off the bar, down to nothing. The numbers and the last roll are in the bar's tooltip, which also says that the shape of that roll is an assumption: the game makes it on the server. A vehicle the record carries no hit points for gets no bar.
- The dots are coloured by the outcome on the usual chance scale — penetration, no penetration, ricochet — pile up over a whole burst (the last 500 are kept) and take the place of the big impact cross of an emulated shot; a recorded hit keeps its own cross. The ↺ button beside the model fills the bar again and clears the dots, and so does putting another vehicle on screen.
- Auto-frame in the scene toolbar starts off.

## 0.7.24 (2026-09-22)

- Vehicles that fire different shells in their second mode (the Gorilla's low charge and the five German shell switchers) are recorded and computed with that mode's own numbers: the recorder writes both sets of shells, the shooter's siege state at the shot and at the impact, and the page marks a second-mode shell ◐ and says which state it was in.
- The page no longer claims a shell whose flight the tracer contradicts: when the shot's own speed and gravity fit no shell the shooter carries, it is shown as assumed with that reason instead of as the shell that flew.
- A shell you pick by hand now carries the shooter's own alpha for that type, and a new α field beside the penetration and the calibre shows it and lets you change it. The circle figures work for a manual shell again — they printed a dash — and fall back to the penetration chance only when nothing in the record has an alpha at all.
- The aim configuration takes a battle's own modifiers into account: for an Onslaught battle it starts from the numbers that battle was fought with, and the Config tooltip names the mode, what was applied and what was not.
- The gun's own mechanics (shell switcher, low charge, charge shot, overheat and the rest) are recorded for the shooter, so the page can say that a gun's numbers vary instead of showing one value in silence.
- Statistics log: the lines of a two-mode shooter carry the mode, the mode's shells and the recorded siege state, and a guessed line now names the shell the page itself shows instead of the first of the list.
- The lighting-depth slider sits in the Soft lighting row next to its own tick box, like the ricochet rows, so the Settings grid keeps its pairs; its default is 250 % (the deepest shading), and a stored 100 % from the old default follows.
- The aiming-circle percentage left the small line inside the info panels for a tile of its own at the top right of the scene, level with the panel it belongs to and in the big figure size: a cyan “Circle” heading for the live ring under the cursor, magenta for the standing ring the hit line refers to.

## 0.7.23 (2026-09-22)

- New versioned build with the standard single-file Windows installer.

- Of two shells the record cannot tell apart, the page now assumes the one that pierces deeper — it had the better chance of making that hit — or the one the recorded damage fits when only one of them can do it. The reason is on hover.

- Config sub-menus (the equipment and directive pickers, the preset list) open as a panel over the menu, always under the slot or control they belong to, which stays visible and lit while the panel is up. A click beside the panel, its ×, or Esc closes the panel alone; the Config menu stays open.
- Presets are one control with the list inside it: rename in place by double-click or the pencil, delete by the bin, and a Custom entry per vehicle that holds every change you make by hand, kept across launches — choosing a preset no longer throws your build away, and the built-in and saved presets are never changed by an edit. Choosing a preset keeps Config open, and the arrow keys step through the presets with the aiming circle following.
- Soft lighting has a depth slider in Settings: 0 % leaves the armour flat, 100 % is the shading as before, more darkens the faces turned away. It changes brightness only.
- A hit whose shell the record does not name no longer leaves the model grey: the page takes a shell of the shooter’s own of the type the hit names (the type itself when he carries none of it), marks it ◌ assumed everywhere it is shown, and never counts it as the shell that flew. A shooter with one shell that agrees with the hit is now simply that shell.
- Any slider takes the mouse wheel and the arrow keys while the cursor is over it: one notch or one press is one step, and the scene no longer zooms or turns under your hand.
- The impact cross is drawn at 90 % by default instead of 50 %, where it was hard to see; a stored 50 % from the old default follows it.
- Config drops the paragraph under the slots and the "?" on the button; what they said is in the button's tooltip.
- The installer comes in a second form for machines whose App Control refuses the single EXE's copy in the temp folder (error 4551): `noloader\BullbaHits-<version>-Setup.exe` with two `.bin` files beside it, which runs nothing out of the temp folder. Its executable carries no version of its own and is the same file for every build.
- For a machine that refuses any unsigned program of ours there is now `BullbaHits-<version>-Install.zip`: unpack it, close the game and double-click `Install.cmd`, which runs only Windows' own PowerShell and copies the same files with the same checks — but leaves no Programs-and-Features entry and no shortcut.

## 0.7.20 (2026-09-22)

- Hit tiles show the damaged modules and injured crew with the client's own icons when the game reports them; any other critical hit gets one crit icon. Names and sources are on hover and in a "Critical damage" row of the hit details. A crit without damage shows 0 instead of ⚙.
- The recorder logs the client's critical-damage messages next to the hits; older battles show the crit their hit records carry.
- Statistics log lines carry the hit's damage, crit code and items, and the ricochet chain.
- Brothers in Arms is one tile per crew member and counts the way the client does: each tankman with it adds 5/N crew levels to the whole crew, the full +5 only when everyone has it. Records now carry the vehicle's real crew (older battles get it on the next game start); only a vehicle the client no longer has falls back to five tankmen. Builds saved with Brothers in Arms keep it on every member, and a build saved for part of a crew stays partial when the page is reopened.
- Configuring a shooter no longer counts equipment twice: equipment already inside the aim data of your own recorded shots is taken out before the configuration applies its own (a stabiliser made the circle on the move far too tight). Field modifications recorded in battle stay in. Recorded reticles are unchanged.
- Battles record their mode (Random, Onslaught, White Tiger …) and each vehicle's hit points, field modifications and whether it is a bot.
- Config knows mode and event vehicles: equipment, consumables or crew skills the vehicle's own lock fixes are not offered or applied, and the Config button says why. A "?" on it marks a battle whose rules the client data does not give (events, and battles recorded before this build). Records now keep the vehicle's locks and mode tags, so an event vehicle stays recognised after its event leaves the client.
- The gun panel's tooltip names the gun's reloading system (magazine, autoreloader, dual or twin gun, automatic).
- The equipment and directive pickers no longer start with an "empty" tile that looked like the slot itself: click the fitted piece to take it out.
- While Config is open, the aiming circle and a crosshair move to the middle of the target and stay there when the camera turns, so each tile's effect on the circle is visible. A click in the scene then only closes the menu; closing it gives the aim back to the mouse.
- The "Fitted: …" line under the configuration is gone; the Config button's tooltip still lists the build.
- The aiming circle shrinks back after the turret catches up with the cursor instead of staying bloomed until the mouse moves again, and its Circle % follows every configuration click.
- After a click on a hit, the roster marks that hit's shooter instead of the previous one.
- Recording a hit takes about 1.3 ms less of the game's time: armour tables that have not changed are recognised at once instead of being rebuilt for every hit.
- Collision models are read straight from the client packages instead of re-reading a whole package directory for each one: about 45 ms less hangar work per model.
- Game start does less work: the viewer's files are rewritten only when they differ from the package, saved vehicles load about eight times faster, and each vehicle configuration is rebuilt once instead of for every hit that needs it.
- Newly extracted collision models are about 40 % smaller (coordinates rounded to a micrometre); models already saved stay as they are.
- The armour map is no longer recomposed on frames where nothing changed (a still camera, a settling aiming circle), and the live aiming circle no longer rebuilds its shader every frame.
- Circle chances and shot lines are computed faster: a ray stops at the first main armour plate. The results are the same.
- Wheel zoom updates the shell, the panels and the map once, when the glide ends, instead of on every frame; a glide cut short by leaving the page finishes on return.
- Dragging the Distance slider inside "More" no longer closes the menu: the toolbar is re-measured only when something on it appears or disappears.
- A turret or gun drag is handled once per mouse move, and the Config menu is built when it is opened instead of on every hit.
- The Statistics log pass that runs when a battle opens takes about half the time and reads each collision model far less often; the lines are the same, now grouped by target vehicle.

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
