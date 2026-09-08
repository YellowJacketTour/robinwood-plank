
```
| Source                              | What it is                                                                                                                                                                                                                                | Charmville note                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| FV-Replowed/fv-replowed             | “Definitive” FV1 PHP revival. Quests, worlds, artisan parsers. Discord discord.gg/rumZVpBsqt. Sister tools: FVDehasher, fv-launcher, FarmHelpers, FarmReplower-Linux. | Code ≠ assets. README: “Game assets from farmville/assets” — you supply Zynga files. | Best protocol/quest/XML study. Do not vendor public/farmville/assets.       |
| AcidCaos/farmvillage                | Python/Flask AMF private server. Pulls WARCs from archive.org original-farmville.                                                                                     | Same: hashed Zynga SWFs.                                                             | Asset-hash + growth tables. Study assets.py, not the SWFs.                  |
| Kristianfriis/FarmVille             | Blazor WASM “BlazorVille”: plow 15 coins, plant, harvest, wither, tools, PWA.                                                                                         | MIT. Sprites: Kathy Chow Tiny Garden (itch).                                         | Cleanest modern web appointment loop. Top-down, not iso.                    |
| CodingQuests/FarmVille-Game         | Godot tutorial farm. Bundles Sprout Lands Basic.                                                                                                                      | MIT code; Sprout Lands non-commercial unless you bought premium.                     | Cute pastel reference. License trap if you copy the folder into plank.love. |
| wollok/farmvilleGame                | Teaching FV: sow/water/harvest maize-wheat-tomaco, gold.                                                                                                              | Academic; small assets/.                                                             | Tiny state machine.                                                         |
| elel123/Farmville-Lite              | Jupyter + pygame, two crops.                                                                                                                                          | Student.                                                                             | Skip except as a one-page loop.                                             |
| joeyinbox/world-of-farmcraft        | Multiplayer 3D-iso Node farm, 4 camera yaws, 12 actions, day/night.                                                                                                   | Old Socket.IO 0.9.                                                                   | Neighbor-on-a-shared-map idea. Art is not cute.                             |
| Saccharine-Coal/Isometric-Farm-Demo | Pygame iso grid, plant flower, grow thread. Own art.                                                                                                                  | Author art; tiny.                                                                    | Smallest iso plant→grow demo.                                               |
| georgiabains/isometric-farm-game    | Godot iso farm→cook→serve (Gourmet Ranch homage).                                                                                                                     | In progress.                                                                         | Porch-to-kitchen later, not slice 1.                                        |
| dcl-regenesislabs/cozy-farm         | Multiplayer cozy farm, wallet save, offline growth, hire farmer.                                                                                                      | DCL SDK.                                                                             | Offline-growth + wallet profile is closer to Plank than FV Flash.           |
```
B. Isometric farm / crop artwork (what you asked for)
These are the tilesets. Charmville porch should study diamond footprint + growth stages, then redraw.
CC0 / safest to study and redraw
```
| Pack                                 | Look                                                                                                          | Spec                                                              | Link                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ★ Kenney — Isometric Miniature Farm  | Soft mini-iso houses, plots, animals, characters. Warm, toy-like, closest “cute iso farm” that is truly free. | 60 tiles, 256×512, 30°×45°, floor 256×128, Unity + Tiled samples. | kenney.nl/assets/isometric-miniature-farm · OGA · itch · mirror dump ETdoFresh/kenney.nl (also isometriccity, isometriclandscape, isometric-buildings, foodKit isometric) |
| ★ pixel32 — Pixel farm and shack     | Small iso crops + shack. Warm pixel, Harvest Moon-ish.                                                        | crops_tileset.png CC0.                                            | OGA / LPC                                                                                                                                                                 |
| Varkalandar — Iso crops & farmland   | Nine crops (cabbage→tomato) + 36 assembled fields. Low-detail patches meant to tile into density.             | CC-BY (check zip; some SA).                                       | OGA                                                                                                                                                                       |
| CityBuildingKit — Corn Farm tile     | Big painted iso corn, PSD layers.                                                                             | CC0.                                                              | OGA                                                                                                                                                                       |
| ChikenwingJJA — Simple farm tiles    | Grass, dirt, crops. Flat, not iso.                                                                            | CC0.                                                              | OGA                                                                                                                                                                       |
| Screaming Brain — 300+ iso overworld | Forest/terrain/water, true 2:1 iso, Tiled .tsx. Not farm-cute; good dirt/grass language.                      | CC0.                                                              | OGA                                                                                                                                                                       |
| Screaming Brain — Iso Stone Soup     | 1895 iso floors/walls from DCSS. Dungeon, not farm.                                                           | CC0.                                                              | OGA                                                                                                                                                                       |
| tipsy/isometric-tiles                | Grass/arid/snow/desert + trees/houses. Tiled sample.                                                          | Check LICENSE in repo.                                            | github.com/tipsy/isometric-tiles                                                                                                                                          |
| Kenney food kit (iso folder)         | Iso produce — useful for satchel icons if redrawn to plank faces.                                             | CC0.                                                              | kenney.nl food kit / ETdoFresh mirror foodKit_v1.2/Isometric                                                                                                              |
```

```
| Pack                                    | Look                                                                                                 | Link                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| IsometricRobot — Gardening dirt & wheat | 32×32 iso wheat 7-stage growth + dirt day-cycle. Explicitly Harvest Moon inspired.                   | OGA                        |
| IsometricRobot — Farm shed              | Iso barn.                                                                                            | OGA                        |
| bluecarrot16 — [LPC] Farm               | Modular barn, silo, coop, apiary, churn, windmill. Warm LPC. Pair with Daneeklu animals.             | OGA                        |
| [LPC] Crops (bluecarrot16 et al.)       | 50 crops, 5-frame grow cycles, LPC style. Best growth-stage sheet in the commons. Top-down, not iso. | OGA                        |
| Daneeklu — LPC farm animals             | Chickens/cows etc. CC-BY.                                                                            | Linked from LPC Farm page. |
```

```
| Pack                              | Why it matters                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| ★ Cup Nooble — Sprout Lands       | The neo-chibi / warm pastel farm look. Animals, dirt, UI. Used by half the Godot tutorial farms. | Basic = non-commercial + credit + no NFT/AI. Premium (~$4) = commercial, still no redistribute pack. itch |
| ★ Cup Nooble — Sprout Lands UI    | Same warmth for windows/buttons.                                                                 | Same. Godot wrapper Maaack/Sprout-Lands-UI MIT code, art still Cup Nooble.                                |
| ★ Kathy Chow — 16×16 Tiny Garden  | Used by BlazorVille. Soft mini plants.                                                           | Itch; check pack license before shipping.                                                                 |
| ★ Penzilla — Cozy Iso RPG Village | Hand-drawn iso village, autumn plants, layered so characters walk behind counters.               | Paid royalty-free. Sample zip only is free. itch                                                          |
| PabloGameDev — Farm Iso Voxelart  | Buildings, crop stages, roads, animals. Voxel-cute.                                              | Use in games OK; cannot redistribute the pack. itch                                                       |
```
Sprout Lands / Tiny Garden / Penzilla are the neo-chibi warmth you want. They are not CC0. Charmville art direction is still DESIGN.md plank ink — treat these as moodboards and growth-timing boards.
C. Cute / cozy / chibi games (mostly top-down — style + loop)
```
| Repo                                               | Style                                             | Notes                                                           |
| -------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| ★ perquis/sprout_lands                             | Pastel 16-bit rural.                              | Wraps Cup Nooble packs. Credit + license.                       |
| ★ gadget-hq/2d-farming-game                        | Godot series from zero.                           | Sprout Lands + Kenney cursors. Best “how a cute farm is wired.” |
| tuananohut/pydew_valley                            | ClearCode Stardew tutorial.                       | Sprout Lands again.                                             |
| RakuNana/Stardew_Valley_clone                      | Godot Stardew-class tutorial.                     | Inventory/seeds/maps.                                           |
| elliotfontaine/untitled-farming-sim (Seasons Gone) | Cozy pixel + nitrogen / rotation.                 | Closest “permaculture mechanics” OSS farm. MIT.                 |
| greenteakettle/hedgehog-s-farm                     | Cute hedgehog farmer.                             | Godot 4.5, itch playable.                                       |
| shittened/kuki-land                                | Cozy top-down Godot.                              | Small.                                                          |
| JibblyC/CarrotCorner                               | Birds vs carrots.                                 | Mix of Kenney + farm-rpg itch packs.                            |
| juandadev/medieval-game                            | Cozy medieval farm stub.                          | MIT, thin.                                                      |
| SevcikMichal/tuk-farm                              | Non-violent mobile minigames (milk, shear, eggs). | RS-skill grind energy, not iso.                                 |
| lunar-huang/Cornucopia                             | Unity Stardew-ish crops + cute animals.           | Student.                                                        |
| mochaeng/IHM (FarmCode)                            | Cozy task farm.                                   | itch.                                                           |
```
D. Isometric engines and city cousins (porch renderer)
```
| Repo                                    | Why                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| amilich/isometric-city                  | Next.js 16 + canvas iso — same stack family as plank.love. Depth sort, sprites. City not farm. |
| hasanharman/isomiddleearth / isoshire   | Next iso tile placer, 128×64 footprint, cozy Shire tiles. Live: isomiddleearth.com             |
| d3n4/LOVC                               | Habbo-like iso room engine. Social-room DNA (PlankSpace is a room).                            |
| DjPale/IsometricEdit                    | Editor built for Kenney iso atlases. JSON maps.                                                |
| jrouillard/TileGen                      | Generate the 48 bitmask iso tiles from 2 inputs.                                               |
| AshKyd/isometric-tile-generator         | PNG iso tile baker. isotile.ash.ms                                                             |
| Kenney iso city / landscape / buildings | CC0 city massing if the porch ever becomes a SimCity skyline.                                  |
```
E. Do not ingest as Charmville art
```
| Thing                                                                   | Why                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| FV-Replowed / farmvillage asset folders                                 | Zynga IP. Revival servers say so in the README.                              |
| archive.org/download/original-farmville WARCs                           | Same files.                                                                  |
| brexeprogram/Stardew-Valley                                             | Decompile.                                                                   |
| ConcernedApe tiles in hpeinar/stardewplanner                            | Planner code is Apache; sprites are SV. Layout UX only.                      |
| Civitai “cute iso LoRAs”                                                | Not a repo; training-data soup; DESIGN.md hates clipart generation as brand. |
| Pablo / Penzilla / Sprout redistributing the zip inside robinwood-plank | Their licenses forbid pack redistribution even if the game may use them.     |
```
What to clone first (practical ingest)
For iso porch geometry + growth, in order:
1. Kenney Isometric Miniature Farm (CC0) — tile size and cute iso buildings.
2. pixel32 farm+shack (CC0) — crop diamonds.
3. IsometricRobot wheat sheet — 7-stage grow.
4. LPC Crops v2.1 — 50 plants × 5 frames (translate to iso later).
5. Saccharine-Coal Isometric-Farm-Demo — smallest running iso grow loop.
6. amilich/isometric-city — canvas depth-sort in Next.
For neo-chibi warmth (mood + UI chrome, not shipping pixels unless licensed):
7. Cup Nooble Sprout Lands Basic + UI (read the license; premium if plank.love stays commercial).
8. perquis/sprout_lands + gadget-hq/2d-farming-game — how those pixels are used in a farm loop.
9. Kathy Chow Tiny Garden + Kristianfriis/FarmVille — web appointment farm.
10. Penzilla sample files — layered iso “walk behind the stall.”
For FV appointment economics (code only):
11. fv-replowed + farmvillage (no assets).
12. BlazorVille (wither + plow cost — we already rejected plow-on-six).
13. elliotfontaine Seasons Gone — soil as a governor.
Notes for Astra / art agents
- Charmville plots are 2:1 iso diamonds, not Stardew top-down. Kenney 256×128 floor is the closest free spec; scale down to porch widget size.
- Growth must be staged frames (dirt → sprout → ripe), LPC Crops / IsometricRobot wheat are the templates.
- Density target is FarmVille late-game packing, but plank ink outlines, gold/wood, official plank character — not Sprout pastel as the shipped look.
- Satchel icons can start as Kenney food-iso structure (orthographic produce on a diamond) redrawn as Stalk/Splinter/… faces.
- Habbo/LOVC is the social room cousin, not the farm cousin. Useful when the porch is a widget among posts.
That is the exhaustive open-and-commons set that is actually FarmVille-shaped or isometric-farm-shaped. Everything warmer than Kenney is almost always itch-licensed, not GitHub-CC0.