# Changelog

All notable changes to Bullba Hits, newest first. Client: World of Tanks PC NA 2.4.0.1 #950 from 0.7.6 on, 2.4.0.0 #945 before.

## Unreleased

- game.log: while the page is in use, one line every ~5 s of activity gives the real frame rate - frames/s, p95, p99 and the longest frame - for orbiting, the aim emulation and hovering apart; an idle page logs nothing.
- **Aim emulation:** the circle's figure and a shot's figure are computed in a background thread of the page (a Web Worker), no longer between frames: the frame keeps ~0.3 ms of the circle's work instead of ~3 ms, and the fine figure lands sooner. The Statistics log's background pass after a battle opens runs there too. Same figures to the bit; where no worker can start, the page computes as before.
- **Aim emulation:** the rays through the armour no longer leave garbage behind (about 7× less memory churn per ray, rays ~10 % faster), so fewer garbage-collection pauses hit a frame.
- **Armour map:** a new pose, model or Soft lighting under a still camera draws the exact ricochet trace at once, in one pass instead of two.
- **Armour map:** the ricochet trace ("Always") costs the graphics card up to ~3.5× less while you rotate the camera: the few pixels whose bounced shell would search a long way are cut short until the camera stops, and 0.15 s later the exact map is drawn. The picture at rest is unchanged.
- **Smoother hangar while models are exported:** a collision model is read about 10× faster (median 70 → 7 ms, the slowest 2.9 s → 0.06 s), so Export all models and a vehicle's first open no longer freeze the hangar for up to seconds; the model files are the same bytes, nothing is exported again. game.log names a model that took over 0.1 s and gives the models' times at the end of Export all models.

## 0.8.9 (2026-09-28)

- **Aim emulation:** the aiming circle moves smoothly on heavy models. Its figure is computed a few milliseconds per frame instead of in one go (which froze a frame for ~20 ms every 0.12 s while moving and ~80 ms when it came to rest); it may lag a few frames and lands on the same value. A shot's own figure is computed the same way.
- **Faster page start:** the armour map's shader compiles about 0.9 s faster on the game's graphics path (it had doubled in 0.8.7), with the same map.
- The circle's tiles and the speed and reload figures are only rewritten when they change.
- game.log: the page's frame-rate line also gives the longest frame of its 3-second sample.

- **Fix (game start):** the export no longer rewrites every saved battle before doing anything else (in 0.8.7 that took minutes with the page open, and held back the wheels of wheeled vehicles, the characteristics and every export). Only battles that changed are published again, in the background after the vehicle updates; the first start after an update does them all once. game.log has one line with the start's timings.
- **Fix (game start):** that background work runs in short slices (~0.1 s) with the game getting as much time between them, and stops for a battle, a drag or a click - a clicked vehicle no longer waits for a whole battle. The open battle is no longer read again every few seconds while other battles are published. A new build publishes the saved battles again only when their format changed; a battle whose model file was deleted, or whose model or vehicle file failed to read, is published again at the next start.
- **Vehicles (in the game):** a vehicle whose file is out of date (a wheeled one without its wheels, a CAV mod. 71 or AS-XX 40 t without its armoured parts) is exported again as soon as you open it, in the configuration it had, with the spinner, instead of showing the old model; its row's tooltip says so. Outside the game such a row opens its file as it is.

## 0.8.7 (2026-09-27)

- **CAV mod. 71, AS-XX 40 t:** the gun's armoured crest (30–150 mm) and the armoured ammunition containers (20 mm) are part of the hit model: drawn on the exported vehicles (the crest in its first position, the containers closed), recorded with their pose when a shot lands on them - the details name the crest's position (1–4 of 4) - and counted as the vehicle's armour on the panels, the map and the Statistics log. Existing exports of the two are updated in the background at the next game start.
- **CAV mod. 71, AS-XX 40 t:** a crest or container pose the game cannot have (after a crit, a stale index) is no longer recorded, and a recorded pose far off the game's rule is drawn at the default position, the tooltip saying so. The tooltip and the details read "At the hit: position 2 of 4 · 3.3°" with the fit; the Statistics log carries `prefabPose=` and `prefabFit=`. A part not read yet says "armoured part not read yet" (was `'resource'`); a crest whose model fails leaves the scene incomplete, as any part.
- **Fix:** a page opened on a vehicle from the game could stay on "Preparing the model…" for good (when the vehicle's file was read before the vehicle list).
- **Armour map:** two plates lying in one plane (such as a crest face in the plane of the mantlet) are now taken in the same order as the panels and the log; the map could paint the wrong one of the two.
- **Statistics log:** `partialRay=` tells whether the shell met the part the scene lacks; a line whose shell did not is judged as usual, so a disagreement on the hull is no longer hidden.
- **Wheeled vehicles (battle):** the wheels' game files are no longer read during a battle, nor while a hit is being published in the garage (a background job reads them) - a hit on a wheeled type not seen yet gets its wheel bodies right after the battle; a failed read is not retried on every hit. A shot through a wheel into the hull draws its line and camera from the hull point; the armour map keeps the plate behind several wheels after a ricochet. The Statistics log marks a line computed without a wheel body (`partial=`).
- **Wheeled vehicles:** the wheels are part of the hit model now - each a 5 or 10 mm screen, as in the game. They are drawn on exported vehicles and on new hits, a shot through a wheel loses that thickness before the hull, and a hit on a wheel lands on it ("Wheel 3") instead of having no point. Wheeled vehicles exported earlier are exported again once, in the background after the next game start; hits recorded before stay as they were.
- **Emulation / Manual motion:** a click on the speed tile opens two sliders - hull speed and hull traverse, 0-100 % of the shooter's current top figures - that hold the circle in steady motion, so what a stabiliser, a rotation mechanism or a skill does on the move can be compared without driving. The tile shows the speed and the turn and gets a gold frame; the model stays put, the turret follows the cursor, shots fired use the motion. The shares survive a new shooter, Config and a restart (100 % stays the top); any of W A S D ends it.
- **Config:** the default build is rammer, hardening and turbocharger; built-in presets for it in Standard, Improved and Bounty.
- **Mode button:** one button on the shooter's characteristics panel (it replaces the panel's ◐ and the ⌖ strip's mode button), in a colour of its own, and now in plain view too: siege, turbine, Rapid, salvo, the Szakal's stance, the XM69's gyro, the Black Rock's Burst, the rocket, the Taschenratte's and Ho-Ri's second gun, and the shell switchers (Pz.Kpfw. 55 and the other German switchers, the Gorilla's low charge, on records that carry both shell sets). One press switches the panel's figures, the circle, the aiming, the shells and the penetration together. Plain view and ⌖ with ◔ off switch at once; ⌖ with ◔ takes the game's times and cooldowns. Switching ⌖ or ◔ keeps the mode; a recorded hit starts in its recorded mode. On a small scene the button stays beside ▤. The Settings checkbox "Mode switch time" is gone (◔ decides now).
- **Vehicles (in the game):** clicking a vehicle without a model now shows a spinner on its row and on the scene until the model is on screen, or says why it failed (no channel to the game, nothing within 30 s) instead of seeming to do nothing. The export runs at once, ahead of background work and even while you drag the scene; the page picks the model up within 0.4 s of it being written (was up to ~3 s), and a vehicle's armour data is read several times faster. A second click on the same vehicle is no longer ignored, and ⇅ to a shooter without a model asks the game for it too.
- **Characteristics / Export all models:** the time the question gives is now the real wall-clock time at this PC's measured pace (it said ~9 s for a characteristics sweep that took 74 s), in minutes and seconds ("about 1 min 15 s").
- **Characteristics / Export all models:** while the page is open a sweep now gets about half of the time (it got about a quarter); after a game update the characteristics of your exported vehicles are ready in seconds instead of ~50 s.
- **Config / Consumables:** three slots as in the game - a click opens the list of the game's consumables; no item twice, one food, one fuel. Repair kits, first aid kits, extinguishers and the rest can be fitted too (they change no characteristic). Saved builds keep their food and fuel. Camouflage stays a tile of its own beside the slots.
- **Config / Field modification:** one tile showing what is on; a click opens the levels under it. A pair with no side chosen shows both sides dim, as in the game; the level numerals are muted.
- **Field modification:** a shooter picked from the Vehicles list without an exported model (known only from his characteristics) now gets his field modification and the garage's equipment rules (the characteristics files are rebuilt once at the next game start).

## 0.8.6 (2026-09-26)

- **Shooter:** another shooter picked through the Shooter tile keeps the model on screen - the battle's own record - instead of re-reading the vehicle's export (event vehicles such as the Waffenträger Panther II showed "Complete vehicle model unavailable"); its pose, pinned point, ⌖ shot and health stay.
- **Vehicles:** picking another collision model keeps the view - camera angle, distance, zoom, turret and gun (clamped to the new vehicle's limits) - and the shooter's shell; going back gives the same picture.
- **Shooter:** a model picked without choosing a shooter is shot by the shooter on screen, else by the last shooter used (remembered across restarts) - no longer by itself; opening a vehicle from the game keeps the shooter too.
- **Shooter:** another shooter (Vehicles list or the battle's roster) keeps the camera, the turret and gun pose, a pinned point and the ⌖ shot on the model, and takes his shell of the same type (AP ↔ APCR nearest) instead of his first AP.
- **⇅ of a recorded hit:** the shooter's vehicle opens from the shot itself - looking back from the hit point at the recorded range, his turret and gun as recorded (own shots and incoming hits with the shooter's movement); other hits keep the camera on screen.
- **Vehicles:** switching to the Vehicles panel over an empty scene, or a roster seat's model, keeps the last view instead of the default one.
- **Camera:** the wheel over the Distance and Zoom sliders now glides the camera smoothly like the scene wheel (Distance at half its step, Zoom at the Ctrl + wheel step, no modifier needed); over their boxes one notch is 1 m / 0.1. The Height slider moves 5 cm a notch.
- **Fix:** the armour map no longer paints false "bounced shell penetrates" patches where a track lies flush with a side plate (seen on one side of Obj. 430U).
- **Ricochet:** after a ricochet an AP/APCR shell flies on with 75 % of the penetration it had left, so screens before the ricochet now count (Obj. 430U side: 160 mm instead of 186). The ricochet chip shows both figures, e.g. "pen 214 → 160 mm".
- **Ricochet:** shells the game never lets fly on after a ricochet (AAAC, Charlie 3, Delta 6, JPNh, PG70 autocannons) now stop there, on the panels and on the map - older battles too (filled in from the shooter's vehicle when the game starts).
- **Statistics log:** the point after a recorded ricochet uses the same rule (it used the full penetration).
- **Armour map:** two different plates at exactly the same depth are taken in one fixed order, the same on the panels and on the map.
- **Emulation:** moving the aim up or down no longer widens the circle - only turning the turret does, as in the game (a cursor going up at 10 °/s gave ×1.41, now ×1.0). The gun follows vertically at its own elevation speed.
- **Emulation:** the shell leaves the gun's real firing point (a barrel may sit up to 2 m from the gun's pivot), and twin- and dual-gun barrels alternate; twin autocannons fire from one point, as in the game.

## 0.8.3 (2026-09-26)

- **Vehicles:** Export all models in the Vehicles list (in the game) exports the collision model of every regular vehicle - no event or special-mode vehicles - for viewing outside the game too: about 190 MB and 20 min the first time (it asks first, with the estimate). It runs only while the viewer stays open, never in battle, a vehicle you click still goes first; the bar beside the Statistics log shows it and ■ stops it. After a game update only the vehicles whose game files changed are exported again. Your own vehicles keep your configuration.
- **Vehicles:** outside the game a vehicle without a model says where models come from: the game, by a click on the vehicle there or Export all models.
- **Settings:** `exportAllVehicles` in settings.json is no longer read; Export all models replaces it.
- **Speed:** the first model exported in a session starts about 3 s sooner (the game's model index is read about 30 times faster).
- **Vehicles:** the list of all vehicles shows only the vehicles a player can have in the hangar: no event, Story Mode, onboarding, battle-mode (Onslaught) or internet-cafe copies. "This battle" still lists the battle's own vehicles.
- **Game:** the mods list button opens the viewer in the Vehicles mode on the vehicle selected in the hangar; the battles are one click away (Hits).
- **Hits:** a click on a critical-damage icon of a hit tile shows what it means instead of opening the hit.
- **Hits:** critical-damage and damage-source icons are the game's own 16 px icons: yellow/red modules, a yellow/red track instead of the white picture, and the damage log's crit, fire, ram, fall and strike icons (green for damage dealt, red for damage taken, as in the game).
- **Hits:** the icons sit in a fixed column on every row, so the flags line up.
- **Circles:** the "?" of the circle tiles stands at the right end of the top row (the shell row's own "?" is gone) and no longer jumps with "Under the cursor"; the Cyan and Magenta tiles' tooltips share one short layout, name their colour and show their heading in it.
- **Scene:** Zoom redraws the map at once, like Distance (no blurred scaled picture while it changes).
- **Scene:** Fit and the framing of a newly shown hit never zoom out below ×1 (a wider view than any in battle); the Zoom slider and Ctrl + wheel still can.
- **Scene:** Lock beside Zoom keeps the zoom you set while you switch between hits.
- **Emulation:** a tank destroyer's hull turns by itself towards a cursor past the gun's sector with the ⌖ mode off too, as in the game; the ring no longer stops at an invisible wall.
- **Emulation:** without the ⌖ mode a shot whose circle centre is off the vehicle is not fired: no tracer into empty space (in the ⌖ mode shots still miss).
- **Emulation:** holding the button fires a burst only in the ⌖ mode (target HP); otherwise a held button is a plain click and a hesitant turn of the vehicle no longer fires a shot.
- **Help:** the words "cyan" and "magenta" in tooltips are shown in those colours.
- **Vehicles:** the mod prepares the characteristics of every vehicle of the client (about 9 MB), and after a game update only of the vehicles whose game files changed. It asks first when the viewer is open in the game (Start / Later, with an estimated time), runs only while the viewer stays open, never in battle, and a vehicle you click still goes first. A small bar with "done / total" beside the Statistics log shows the progress, ■ stops it; an unfinished run asks to continue the next time. Models still come on demand.
- **Vehicles:** outside the game the list shows every vehicle. A vehicle without a model opens with its characteristics panel, Config and gun/turret pick; the scene says the model is not exported yet. The "Exported" flag filter narrows the list to vehicles with a model.
- **Characteristics:** the panel is now a compact two-column table. ⚙, ▴ and "?" sit on a row of their own above it; under them the HP and the gun. Firepower: the DPM with the reload beside it (for a magazine or autoloader: the time between rounds beside the DPM, the magazine reload — per shell for an autoloader — and the rounds under them), then dispersion | aiming and the stabilisation figures. Stabilisation, Mobility (speed above specific power, turret traverse above hull traverse) and Concealment (view range; standing above moving) stand as column blocks. The second-mode switch (siege, turbine…) sits at the left of the controls row; specific power has an engine icon.
- **Help:** a tooltip or "?" in the lower half of the window opens upward, so the characteristics panel's help no longer covers the panel.
- **Shells:** a hit whose shell the record does not name (e.g. the White Tiger boss's stun shot) is no longer grey or left on the previous hit's figures: it takes the shooter's own shell of the same type, else calibre, else his first, marked ◌ assumed with the reason.
- **Hits:** the list now holds all damage, not only shots: rams, fires, artillery strikes, falls and event abilities stand among the hits at their time, each with its own glyph, filtered like the hits. A fire is one row at its end with its total; its tooltip names the hit that set it.
- **Hits:** such a row opens the damaged vehicle without the penetration map: after a ram the touched part red with a red cross at the contact, after a fire a burnt look.
- **Hits:** a small ≠ beside the hit count when this vehicle's logged damage does not add up to the HP it lost; a click says where and by how much.
- **Recorder:** records where two vehicles touched around a ram, and the shot that destroys a vehicle. Battles recorded since 0.7.20 get their rams, fires and other damage after the next game start; older ones have none.

## 0.8.1 (2026-09-24)

- **Hit line:** the shot is now drawn along the shell's whole real flight from the tracer: a dashed arc from a dot where it left (the drop of up to a metre at long range included) to an arrowhead at the hit, instead of the short stub; the record view puts the camera at that start. More hits find their tracer (up to 5 m off, when nothing else of that shooter is near).
- **Hit line:** a small mark on the hit-line panel when the game drew the vehicle more than 0.5 m from where the server hit it (the game draws vehicles about 0.2 s late); a click says how far and why.
- **Hit line:** when the shot seems to come from under the ground (0.5 m or more below the tracks), a mark says how far and how much of it is the vehicle's own lean, with a dashed square for the world's level.
- **Circles:** temporary lab (Settings → Shot ring lab): Ring axes draws each recorded ring's axis from a dot where its gun stood; View from puts the record view of your own shot at your gun at the press, the server's gun then, or the shot (default).
- **Scene:** a click on a Circle tile (or the hit-line panel) shows its words instead of firing the emulated gun or pinning a point under it.
- **Scene:** the Circle tiles have their own "?": what each ring is and what the figures mean.
- **Circles:** your own recorded shot now also shows the circle the server really fired it from — a thick, translucent ring of long dashes (99 shells in 100 land inside it) beside the two thin outlines of your reticle and the server marker at the press. The Circle figure is taken over it.
- **Circles:** on the move the two thin rings now stand where your reticle and the server marker really were when you pressed fire (they used to swing aside by the distance the vehicle drove before the shell left).
- **Circles:** Settings → Shot ring switches it on or off and sets its opacity (25 % by default, pale cyan); Settings also has a lab to tune its look (colour, thickness, dashes, placement).
- **Settings:** Screen opacity is 20 % by default.
- **Circles:** a ⚠ beside the Circle tile marks a shot ring that is one server tick uncertain; a click on it says what that means and how far off it may be. Two-gun salvos no longer get a false ⚠.
- **Recorder:** keeps the first two server aim updates after each of your shots (about 0.4 KB a shot; a two-gun salvo shares one record, and a shot at the very end of the battle keeps what came), so the ring of new battles is exact in that case too.
- **Scene:** turning the vehicle with the mouse is half as sensitive: about one full turn per 1500 px of drag, and smoother in the game browser.
- **Scene:** turning the vehicle with the mouse no longer stops after a few degrees when some text on the page is selected.
- **Emulation:** the target's health bar takes a roster row only when it names the same vehicle, and its tooltip says whether the figure is the server's own (equipment included) or the roster's figure from before the vehicle was seen.
- **Emulation:** the gun or turret picked on the characteristics panel (or in Config's Turret row) is now the gun the emulation fires: its circle, aiming time, reload, magazine, heat and mode button, and its shells (marked ⇆). The picked gun starts loaded, cool and fully aimed. The recorded ring and the hit's own shell stay the ones that fired. Picking the gun that fired (●) goes back to the recorded gun.
- **Emulation:** switching to another hit of the same vehicle fired with a different gun also starts the emulation over for that gun.
- **Emulation:** the live aim ring (cyan, with the reload on it) is drawn over the magenta ring of a pinned shot, so the reload no longer hides under it.
- **Scene:** turning Zoom (its slider, its box, Shift + wheel, Fit) scales the picture at once without redrawing the armour map; the map sharpens a moment after the zoom stops. Lines, rings and tracers stay sharp throughout.
- **Scene:** the wheel over the scene redraws a few frames less per notch at no cost to the picture.
- **Distance:** the Distance field and slider are the shot's range, from the camera to the hit point, and penetration is taken at it; switching the orbit centre between the vehicle and the hit no longer changes the range, the penetration or the map. Without a hit point it is the distance to the orbit centre.
- **Scene:** with Auto-frame on, the zoom Fit picks no longer jumps on the next camera move, and panning no longer changes the size of the vehicle.
- **Scene:** while the turret or gun is dragged, the ricochet hatching is off until the pose is set, instead of being drawn for the old turret position.
- **Scene:** hover, pins and the emulated turret find the point under the cursor much faster on heavy models.
- **Settings:** the Soft lighting depth slider no longer redraws the whole map on every step.
- **Controls:** every wheel notch over a slider or a number box moves it by one step of its own (Distance 1 m in its box, Zoom 0.1), whatever the pace of the turn: the wheel is for the fine value, dragging for the coarse one; Distance works out the shell once the turn stops.
- **Controls:** the mouse wheel over a slider no longer stalls or slips: the value moves at once, the page redraws once per frame and saves the settings once the turn is over; the number boxes beside the sliders (Distance, Zoom, Height, Pen., Cal., α) take the wheel too, their arrows still work.
- **Records:** a start of the game on which a saved battle or vehicle file cannot be read (held by an antivirus or a backup, or a battle file copied under another name) no longer deletes collision models; unused ones are cleaned up on the next start that reads everything.
- **Records:** a battle file that lost its first line, or a battle whose export fails the same way five times in a row, no longer stops new battles, models and characteristics from being exported for the rest of the session; that one battle is skipped with a single log line and read again on the next start.
- **Records:** watching a replay or spectating no longer creates an empty "live" battle in the list.
- **Records:** recording no longer stops when you are destroyed in Onslaught (or Steel Hunter): hits, shots and damage between the others are recorded until the battle ends.
- **Records:** in Onslaught the battle's roster follows each player's vehicle choice and names the enemies once they are known, and every vehicle seen in battle carries its real hit points (equipment included), which the health bar uses.
- **Installer:** no backup copies any more; installing removes the backup folder earlier versions filled, the previous recorder build and our own files the page no longer uses. Records, settings and other mods are untouched.
- **Emulation:** the target's health bar shows its figures inside it (left / max); its tooltip says where the figure comes from.
- **Emulation:** ⇅ in an Onslaught battle, or in a battle recorded before 0.7.20, keeps the health bar: a vehicle with no hit points in the roster takes its stock figure from its characteristics file. A browsed vehicle uses its own export, not the battle open beside it.
- **Scene:** every way of showing a scene (a hit, ⇅ and back, another shooter, the vehicle browser, another battle or seat, switching the side panel) now draws the tiles, the ⌖ strip, the health bar, the characteristics panel and the "?" icons the same way; an emptied scene no longer keeps the previous hit's strip or controls.
- **Help:** the "?" icons no longer disappear for good after the toolbar reflows or the scene changes; the help mode ends when its "?" leaves the screen.
- **Scene:** the battle-list refresh no longer puts the recorded hit back over a ⇅ view, a picked shooter or a browsed vehicle; switching the side panel keeps a browsed vehicle and its camera; another hit of the same vehicle from another battle gets its own aiming circle at once; a model still exporting stops writing "Exporting…" once you open something else.

## 0.7.41 (2026-09-23)

- **Camera:** a clinch hit keeps the camera on the shell's line at the recorded range; Fit only zooms and no longer backs the camera off to the side.

## 0.7.40 (2026-09-23)

- **Emulation:** a crosshair switch ⌖ beside the collision-model tile turns on Target HP, the RNG shot and Hitmarks together; it is off each time the page opens, so a hit shows as it was recorded. With it on, an emulated shot lands at a random point inside the aiming circle, by the same distribution the circle's percentage uses, and the shot line and the panel follow it.
- **Emulation:** Target HP gives the vehicle on screen a health bar from the hit points the battle recorded for it (Onslaught health in Onslaught); a shot that gets through takes off its alpha or the reconstructed non-penetration damage ±25 % (±12 % in Onslaught) - the tooltip says the roll's shape is an assumption. The health stays when you pick another shooter; ↺ or another vehicle on screen fills the bar again and clears the marks.
- **Emulation:** Hitmarks are cut into the armour along the shell's line on every plate the shot met, 0.7 calibre across - round square-on, an oval at an angle, never past the plate's edge: a penetration is a black hole with a dark red glow, a stopped shell a grey scrape, a ricochet a lighter grey skid. The last 500 shots are kept; marks on the turret and gun turn with them.
- **Emulation:** with ⌖ on, a strip at the top beside the model tile holds the reload, the magazine as a row of rounds (loaded, spent, the next one lit, the loading one filling up; one bar over 12 rounds), gun heat, the mode button, ◔ real reload, the target's health bar and ↺; with ⌖ off it is gone. On a narrow screen it drops under the tile.
- **Emulation:** real reload ◔ (on by default) loads the gun as in the game: letting go does not reset the reload, a press before the gun is loaded does not fire, a clip keeps its rounds between presses and reloads in full once empty, an autoloader loads its spent rounds back one at a time, and an improved autoloader (Progetto 54/66, Bisonte C45, Stone Sentinel, Toro, Rinoceronte, Bélier) loads the next round faster after a pause. A refused press blinks the blocking indicator and the circle red.
- **Emulation:** one press fires a burst gun's whole burst (Donnola, Char Mle. 75, Durendal, MBT-B, 121-2 Ziqiang, tier I-IV autocannons), the rounds before the last widening the circle by the gun's in-burst factor (Donnola: ×1.41, then ×8.06 after the last); an automatic gun's circle grows round by round (Ares 90: ×1.10 after the first, ×4.6 after the tenth) and settles once you let go.
- **Emulation:** dual-accuracy guns (Type 57, Type 63 HT, Type 68, Type 71, SZDV Vz. 50, Kame, Ashigaru, Headshaker) widen the circle after every shot for their cooling delay (Type 71: ×1.73 for 12 s). An Ares gun heats with every round, widens its circle (×1.25, then ×1.5) and locks when overheated until it has cooled right down; the STK-2 heats too but never locks (×1.227 cold, ×1.91 in steady fire).
- **Emulation:** the mode button switches a second mode with the game's switch times: siege of the hydraulic tank destroyers (Strv 103, UDES 03, Kunze Panzer and others), the turbine (CS-63, CS-52 C, Ogar, Vercingétorix, Char Mle. 75), Rapid of the French wheeled vehicles, the salvo of the British twin guns. The gun does not fire while it switches and the vehicle stops; the second mode brings its own circle, aiming, stabilisation and top speed.
- **Emulation:** the rocket booster (BZ-176, BZ-75, DZT-159, Yong Bing, T 56 G, Schwertwal, Tiger (P) CFE…) on the mode button with its time, recharge and uses - faster forward, slower turning; a hydropneumatic vehicle's automatic siege shows there as an indicator.
- **Emulation:** tier XI modes and abilities on the same button, starting from the state the shot was recorded in: CS-67 Szakal's fight and turbo stances and its fight ability (circle ×0.8, aiming ×0.75, reload ×0.8 for 13 s), XM69 Hacker's gyro (10 s with no dispersion from movement or turning, then a 40 s cooldown), Black Rock's Burst mode (both rounds 1.5 s apart).
- **Emulation:** Ho-Ri Shugo and Taschenratte take up the rocket launcher / support mortar with its own circle, reload and magazine; with the leKpz Borkenkäfer's designator the next round marks the target for 10 s and every hit on it rolls ×1.1; Leopard 120 Verbessert, T803 and CAV mod. 71 run by themselves; Breaker, AS-XX 40 t and AMX 67 Imbattable get the button dimmed, with why they are not emulated yet.
- **Emulation:** Strv 107-12 - a tap switches siege / travel, holding the button 1 s goes into the pillbox or out of it (5 s from travel, 3 s from siege); in the pillbox the siege circle is ×0.85, the reload ×0.925 and the vehicle does not drive.
- **Emulation:** a tank destroyer's or limited turret's gun stops at the edge of its horizontal sector, and beyond it only turning the hull (A/D) brings it round; a fixed gun stays on the hull's axis and past its sector the hull turns by itself towards the aim. A French wheeled vehicle does not turn on the spot and turns slower in Rapid (×0.41 on the EBR 105, our estimate).
- **Characteristics panel:** new, in the bottom-right corner of the scene: the shooter's garage figures in the garage's groups (Firepower, Survivability, Mobility, Concealment, Spotting) - reload, DPM, dispersion, aiming time, turret and hull traverse, top speed, specific power, hit points and the movement dispersion factors - icons and numbers lined up on one grid, the words in the tooltips.
- **Characteristics panel:** the reload line reads as the garage prints it - magazine rounds, the reload, the time between rounds or bursts - for autoloaders, dual-gun salvo preparation, the twin-gun mode switch, automatic and Ares continuous fire.
- **Characteristics panel:** ▴ opens the rest: the gun's shells, weight, engine power, gun elevation and horizontal limits, view range, concealment and the whole Survivability group - hit points, hull and turret armour (front / sides / rear) and suspension repair time.
- **Characteristics panel:** ⚙ switches between the stock vehicle (top modules, a trained crew, nothing fitted) and this shooter's Config build, better figures green, worse red; a switch beside it shows the second mode's figures in colour against the first (under ⌖ it follows the emulator's mode), with switch times and hull-aiming limits (Strv 103B -11/11 and 0/0).
- **Characteristics panel:** the gun chip shows the gun, its calibre and tier; a click lists the current turret's guns (the choice is kept per vehicle; the circle keeps the gun that fired). The turret is picked in Config's Turret row, or in the same list while Config is hidden.
- **Config:** rebuilt on the client's own catalogue: pick a slot, then the real items in the garage's grades (Standard, Bounty, Improved, Experimental), each a tile with the client's icon and grade badge; only what this vehicle may mount is offered. Builds saved by earlier versions are dropped.
- **Config:** every device of the game; the ones that do not shoot count on the characteristics panel (optics, binoculars, camouflage net, exhaust, grousers, hardening, every device's weight). The rotation mechanism also turns the hull faster in the WASD emulation, and a turbocharger raises the speed it accelerates to (a bigger circle).
- **Config:** directives in one slot, Optical Calibration, Fuel Filter Replacement and Exhaust Insulation among them (without its device a directive is shown inactive); consumables - combat rations (+10 crew levels) and Quality / Excellent Fuel, which also speeds the turret up; a camouflage paint tile.
- **Config:** crew by role: all 19 gunnery skills and perks, Concealment for each crew member, Recon, Situational Awareness, Off-Road Driving, Engineer; situational perks start off. Brothers in Arms is one tile per crew member and counts as the client does (each tankman with it adds 5/N crew levels); Mag Mastery reloads the whole magazine 2.5 % faster (not on autoloaders).
- **Config:** field modifications by the vehicle's own tree and level: standard ones on / off, dual ones one of two (click the other side to swap, the lit one to clear), counted by the game's rule on the aiming circle and in the characteristics panel; once anything is on, it replaces the field modification the record carries.
- **Config:** pickers open as a panel under their slot and start with the empty slot; a click beside, × or Esc closes the panel alone. Presets are one list with rename, delete and a Custom entry per vehicle that keeps your changes by hand across launches; the arrow keys step through presets with the circle following.
- **Config:** while it is open, the aiming circle and a crosshair sit in the middle of the target, so each tile's effect on the circle is visible; the Config button's tooltip lists the build.
- **Config:** mode and event vehicles: what the vehicle's own lock fixes is not offered, and an Onslaught battle starts from the modifiers it was fought with; the Config tooltip names the mode and what was applied.
- **Scene and camera:** the aiming circle's figures moved from the info panels to a tile of their own at the top right of the scene - a cyan Circle heading for the live ring, magenta for the standing one - coloured by the chance scale; the toolbar percentage is gone, and the recorded shot's figure no longer blinks or changes with the Distance slider.
- **Scene and camera:** the orbit-centre buttons read ⊙ Vehicle / ⊙ Hit and keep the tank framed; Auto-frame starts off.
- **Scene and camera:** a dragged turret on a tilted ring (Kunze Panzer, Kpz 3 GST Turm, CC 3, CC mod. 64, CC-67 B, Controcarro 1 Mk. 2, Object 168N) turns on that ring as in the game, hit marks with it; a turret and gun the game holds fixed (Strv 103 and other tank destroyers) can no longer be dragged.
- **Scene and camera:** Settings - Soft lighting has a depth slider (0 % flat, 200 % by default, more darkens the faces turned away), Grid its brightness and opacity sliders in its own row; the impact cross is drawn at 90 % by default. Sliders take the mouse wheel (a continuous spin steps further) and the arrow keys while the cursor is over them, without turning the scene.
- **Scene and camera:** the ⇅ swap button is offered wherever the shooter has a model (one still being extracted is waited for) and stays when the side panel shows Vehicles.
- **Scene and camera:** collision models also come from mounted shared and event packages (Waffentrager vehicles included), and an incomplete or unsupported model says so instead of showing loose parts. Ares, M-II-Y ... M-VII-Y, AHT-7 and LTC II have their outer track pair as a part of its own, and a crit on it is named the outer track.
- **Hits and records:** penetration changes with distance as in the client - full up to 50 m, then along the line through the 500 m value, still falling past 500 m, 0 beyond the shell's range; Polish smoothbore APCR (Grom, Kilana, Husarz, Gonkiewicza, Błyskawica, Bzyg) also lose damage with distance (Błyskawica at 300 m: 522, not 800).
- **Hits and records:** hit tiles show the damaged modules and injured crew with the client's icons (one crit icon for anything else), with names and sources in the tooltip and a Critical damage row of the hit details; a crit without damage shows 0.
- **Hits and records:** a shell the record does not name is taken from the shooter's own of that type and marked ◌ assumed; of two it cannot tell apart the deeper-piercing one (or the one the damage fits) is assumed; one the tracer contradicts is shown as assumed; a tracer sped up by the tier XI skill-tree bonus names its shell (Breaker, KR-1, Taschenratte and 14 more). A shell picked by hand carries the shooter's alpha in a new α field.
- **Hits and records:** the gun's state at the shot counts: a charged shot shows the charged alpha (×1.045, ×1.177 or ×1.244), the Gorilla's low charge and the German shell switchers use the second mode's shells (marked ◐), a shot in siege or an alternative mode uses that mode's dispersion, aiming time and reload (Strv 103B, Strv 107-12, the Contriver…), and a hit on a target marked by a Borkenkäfer allows ×1.1-1.15 damage.
- **Hits and records:** battles record their mode (Random, Onslaught, White Tiger …) and each vehicle's hit points, field modifications, real crew, locks and whether it is a bot.
- **Hits and records:** Statistics log lines carry the hit's damage, crit code and items, the ricochet chain and a two-mode shooter's mode, shells and siege state; a guessed line names the shell the page shows. The pass on opening a battle takes about half the time, with the lines grouped by target vehicle.
- **Hits and records:** battle files are much smaller - what a vehicle brings to a battle is written once per battle (62 battles: 161.5 MB to 50.7 MB, the biggest 14.2 MB to 2.1 MB), and publishing a 405-hit battle takes 38 ms instead of 302 ms. Older battles are read exactly as they were.
- **Hits and records:** lighter on the game and the page: recording a hit takes about 1.3 ms less, a collision model about 45 ms less hangar work and new ones are about 40 % smaller, saved vehicles load about eight times faster; the armour map is not recomposed on frames where nothing changed, the live circle no longer rebuilds its shader every frame, and wheel zoom updates once when the glide ends.
- **Hits and records:** on the first game start after installing, older battles are updated - they get the vehicle's real crew and the second mode's circle, and Ares 90 or M-V-Y hits recorded on this client that were shown without a model get the model and the verdict. The mod writes a characteristics file for every vehicle type it exports, once per type and client version, outside battles.
- **Interface and help:** tooltips no longer pop up on hover: click a figure to see its tooltip (a button explains itself in help mode), Escape or a click elsewhere closes it. The page draws them itself, so they work in the game's browser too; they are short and structured - a heading, key points in bold, groups.
- **Interface and help:** help dots (?) by the ⌖ switches, the gun panel, the camera toolbar, the shell block, the hit filter, the characteristics panel, Config, the Statistics log and the vehicle list show one line per control - what it does - and start help mode, where a click on any control explains it instead of pressing it (Escape or the same ? leaves).
- **Fixes:** configuring a shooter no longer counts equipment twice: equipment already in the aim data of your own recorded shots is taken out first (a stabiliser made the circle on the move far too tight); field modifications recorded in battle stay in.
- **Fixes:** the aiming circle shrinks back once the turret catches up with the cursor, and its Circle % follows every Config click; after a click on a hit the roster marks that hit's shooter; dragging the Distance slider inside More no longer closes the menu.

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
