# Soil, agriculture, action art and rotating inventory

## Recommendation and scope

Build agriculture from a small set of understandable terrain families plus independent care, climate and crop traits. Build the inventory as one semantic interface with optional rotating presentation. Neither requires a separate economy or a second copy of ownership. The foundation should support simple first-day planting and deep later specialization without requiring players to memorize dozens of fictional dirt names.

This report distinguishes **source facts**, **design recommendations**, and **implemented behavior**. Coverage includes the local Emerald and Solarus quest sources, current Charmville planting implementation, official Minecraft and Stardew material, and the Ocarina of Time decompilation's pause-menu source. It does not certify every farming repository, every Zelda animation, or current RuneScape farming behavior. FarmVille Replowed is present locally, but its crop simulation was not sufficiently traced here to assert its exact formulas. No Stardew or Minecraft proprietary source implementation was imported.

## What the inspected sources establish

### Emerald: care is separate from growth stage

At local commit `5eff78649e7170a877b961ef0b3da13b81a16038`, `src/berry.c` has separate planted, sprouted, taller, flowering and berries stages. Watering sets one boolean per eligible stage. Repeated watering within that stage does not add another distinct watered stage. Yield calculation uses the number of watered stages and a random range between berry-specific minimum and maximum; zero watering returns the minimum. Growth progresses from elapsed minutes. Mature trees have a longer window; unharvested trees can regrow and eventually clear. This is a useful example of separating visible development, care history and yield, rather than using one overloaded crop-quality number. [Emerald berry implementation](https://github.com/pret/pokeemerald/blob/5eff78649e7170a877b961ef0b3da13b81a16038/src/berry.c).

Do not directly transplant its single-player random generator or save clock into a shared economy. Recommended adaptation: the server owns crop cycle IDs, elapsed time, stage care flags and the once-only outcome. The client receives stage and remaining-time information; it cannot report a harvested quantity. Deterministic test seeds belong in isolated testing. Production randomness, if retained, must be server controlled and reproducible for audit.

### Minecraft: readable land transformation and infrastructure

Minecraft's official farmland article describes changing dirt or grass with a hoe and placing water within four blocks. Its wheat article connects irrigated farmland, seeds, waiting and harvesting. These establish an especially readable interaction vocabulary and an infrastructure benefit: irrigation replaces repetitive manual care. They do not establish a soil-chemistry simulator. [Farmland](https://www.minecraft.net/en-us/article/block-week-farmland), [Wheat](https://www.minecraft.net/en-us/article/taking-inventory--wheat).

Recommended adaptation: a first-time player sees land change immediately after the hoe contacts it, and later builds irrigation that produces the same authoritative watering effect under a declared capacity. Avoid making every new crop require a new kind of soil item merely to create progression.

### Stardew: distinct axes of improvement

The official 1.6 changelog includes new crops, equipment and farm-related changes, plus fixes involving fertilizer placement and seasonal crop behavior. It supports treating farming as a broad progression system rather than a single harvest button. This report does not derive exact fertilizer equations from that changelog. Specific quality, speed and water-retention formulas need a separate versioned mechanics reference before implementation. [Official 1.6 changelog](https://www.stardewvalley.net/stardew-valley-1-6-update-full-changelog/).

Recommended adaptation: growth speed, harvest quality, moisture retention and regional suitability remain distinct attributes. Combining them must have explicit caps and costs. One fertilizer should not silently become an unlimited multiplier on time, yield and rarity simultaneously.

## Soil families with depth that arrives gradually

The following is a proposed initial ruleset, not source-game behavior and not yet implemented.

| Family | First interaction | Later specialization | Economic purpose |
|---|---|---|---|
| Ordinary soil | Till, seed, water | Compost, irrigation, crop rotation | Common food, fibers, herbs and accessible starting trade |
| Sandy ground | Identify plants that tolerate it | Water retention amendments and coastal cultivation | Distinct habitat products and materials, not universally inferior soil |
| Clay-rich ground | Prepare beds and drainage | Ceramics, reservoirs and wetland engineering | Dual farming/construction use creates a meaningful allocation choice |
| Wet ground | Plant water-compatible species | Channels, rice-like crops, aquaculture | Connects farming, fishing and shared water infrastructure |
| Rocky ground | Clear stones; use appropriate plants | Terraces, mineral extraction and orchard supports | Links mining and construction to agricultural expansion |

These labels are descriptive placeholders. Ordinary soil should be enough for the opening experience. Introduce a new family only when it changes a decision the player can perceive: crop suitability, irrigation, terrain preparation, or a product chain. A cosmetically dark patch need not be a sixth soil family. Fertility, moisture and ownership are properties, not terrain families.

Use a bounded schema: `terrainFamily`, `tillage`, `moistureBand`, `amendment`, `cropCycle`, `regionClimate`, `revision`. Avoid exposing raw chemistry on the first screen. Advanced growers can inspect the detailed view. Geological material can be tradable when extracted, while the land cell remains persistent terrain; this prevents an icon from ambiguously meaning both a bag of clay and ownership of the ground.

### Keep the six important variables independent

1. **Water** determines whether the next interval receives adequate moisture. Rain, player watering and irrigation feed the same rule; they do not triple-count.
2. **Fertilizer** is a consumed amendment with a stated effect and duration. Applying it should reserve the ingredient at action start and settle consumption at valid contact.
3. **Season and climate** determine suitability. A decorative autumn palette is not automatically a server season change.
4. **Growth stage** describes visible development. Stage transitions do not mint market goods.
5. **Quality** belongs to the resulting lot or instance. It can depend on care and skill within a defined distribution; it is not a new species ID.
6. **Yield** is the count minted by a validated harvest from a particular cycle, once. It must not be multiplied again by social reaction or inventory presentation.

At a season boundary, prefer a clearly explained dormancy or protected-growth rule for persistent online homes over a surprise wipe while a player is away. This is a design recommendation. Test alternatives against player absence patterns before committing. Greenhouses should consume construction capacity, energy or maintenance, so removing a climate restriction has an economic cost.

## Art and action specification

### Source assets ready for mapping

Local reference root: `C:/Users/k1rby/OneDrive/Desktop/SpacePoker/charmville-references/`.

| Purpose | Exact local source | Interpretation |
|---|---|---|
| Planted ground | `pokeemerald/graphics/object_events/pics/berry_trees/dirt_pile.png` | Source planted-patch image; do not mistake it for every terrain type |
| Sprout | `pokeemerald/graphics/object_events/pics/berry_trees/sprout.png` | Early growth artwork; frame dimensions must be read from the asset manifest |
| Oran stages | `pokeemerald/graphics/object_events/pics/berry_trees/oran.png` | Existing native integration maps taller, flowering and fruit-bearing frames |
| Grass and destruction | `solarus-zsdx/data/sprites/entities/grass.dat` | Tileset references; on-ground origin `(8,13)`, destruction origin `(16,29)` |
| Pot and breaking | `solarus-zsdx/data/sprites/entities/pot.dat` | Distinct standing/carry movement/destruction definitions, not a generic pickup sparkle |
| Lift and carry | `solarus-zsdx/data/sprites/hero/tunic1.dat` | Action-specific atlas dimensions and origins; requires matching hero sheets |

Solarus source revision is `e904d7904d74a97a50992b1340431d5d8f341d69`. Its lift definition uses 48×24 frames with origin `(24,21)` and five frames per direction. Carrying uses 24×24 frames with origin `(12,21)` and direction-dependent frame counts. Therefore, treating all frames as identical-width cells or assuming all directions have the same loop length is demonstrably wrong for this source. [Hero definitions](https://gitlab.com/solarus-games/games/zsdx/-/blob/e904d7904d74a97a50992b1340431d5d8f341d69/data/sprites/hero/tunic1.dat), [Grass](https://gitlab.com/solarus-games/games/zsdx/-/blob/e904d7904d74a97a50992b1340431d5d8f341d69/data/sprites/entities/grass.dat), [Pot](https://gitlab.com/solarus-games/games/zsdx/-/blob/e904d7904d74a97a50992b1340431d5d8f341d69/data/sprites/entities/pot.dat).

Each imported action needs: source revision, sheet hash, frame rectangles, source direction ordering, animation duration, loop behavior, origin, feet anchor, hand/tool socket, transparency method, collision shape, effect timing, sound trigger and interrupt rules. Frame direction order must be mapped from the engine convention; the row number alone is not a compass direction. Mirroring a sword or shield can be invalid even when mirroring a walk is acceptable.

### Proposed action sequence

For tilling, planting, watering, fertilizing and harvesting, use `ready → windup → contact → recovery`. Keep actor facing and target cell fixed for the committed action. Movement before contact either cancels with no economic effect or is explicitly part of the authored animation. A server receipt identifies which cycle and action completed. Recovery does not produce a second yield.

For lifting and throwing, use `reach → lift → held → throw release → airborne object → impact`. The held object keeps its own identity and sprite; it should not temporarily become unrelated grass or a flower. Collision follows the object's physical trajectory and footprint, while the rendered vertical arc is presentation. An impact resolves once even if several clients render it.

For fishing, use cast, float travel, waiting, bite signal, reaction window, reel and outcome. For woodcutting/mining, loops have explicit impact contacts and cancel points. Every impact may play a visual effect, but only the server-authorized completion awards a resource. These are recommended mappings, not a claim that RuneScape or Emerald's native skill routines are integrated.

### Layers and masks

The foot anchor establishes ground order; sprite top-left does not. Soil belongs below actors, crop stems/rooted objects sort against feet, and overhead canopy belongs above. Tall crops need a declared blocking footprint separate from their visible leaves. Sword contact should query harvestable capabilities and the relevant hit shape, not screen-color coincidence.

Current local native implementation has a documented 8-bit framebuffer versus RGBA overlay mismatch. It also previously sampled fractional atlas positions. Preserve integral source rectangles, verify color depth and maintain a separate transparency mask. Palette replacement must not accidentally turn transparent pixels opaque. These findings are recorded in `docs/charmville-reconstruction/PLANT-ENVIRONMENT-CATALOG.md` and the local `charmville-native-homestead/Homestead.zs`. They are not proof that every tool animation is fixed.

## Crafting and economic continuity

Recommended recipe records contain exact input definitions or explicit substitution groups, integer counts, tool/station requirements, elapsed work, output definition and quantity, byproducts, quality rules and a recipe version. Reserve inputs atomically; settle outputs once. Cancellations specify which inputs return. A client animation finishing is never evidence that ingredients existed.

Keep useful chains broad: crops feed cooking and livestock; livestock supplies food and textile inputs; compost uses organic remnants; timber and clay support homes and irrigation; ore supplies tools; flowers support dyes, decoration and social expression. Do not force every plant into a new coin substitute. Tradability, consumability, equipment use and reaction use are distinct capabilities on the same definition.

Scarcity should arise from habitat capacity, time, work, consumption and limited productive space. Common items can remain worthwhile because many recipes and public projects consume them. Quality and species produce meaningful variation without requiring one Unicode emoji per variant. An emoji is a recognizable family marker, not a sufficient item identity.

## The rotating inventory is an N64 reference

Ocarina of Time's `ovl_kaleido_scope` contains separate item, map, quest and equipment page code. The inspected `z_kaleido_scope.c` describes page order, camera-eye deltas and a 16-step page switch. This is a concrete N64 rotating-page reference. It is not Emerald's GBA bag implementation, and should not be described as such. Inspected upstream revision: `cbe814b25455f14a343a7457c4b1c92af40ede6a`. [KaleidoScope source](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/src/overlays/misc/ovl_kaleido_scope/z_kaleido_scope.c).

Recommended Charmville presentation: a small number of primary pages with a restrained rotating transition. Suggested functional groups are equipment/actions, Satchel and materials, world/quests, and people/Charmdex. Names remain replaceable. Market and feed views open from the relevant page rather than making a carousel of dozens of panels. The menu must not pause the shared simulation.

### Semantic schema independent of presentation

A panel record should contain `id`, label, icon, ordering, capability gate and view type. An item reference contains definition ID, stack or instance ID, count, quality/variant, custody state and available actions. An action contains an intent type and validation requirements; it does not embed a writable balance. Equipment loadouts reference owned instances. Reservations appear separately from available quantities. Account changes invalidate all loaded private panels and pending operations.

Page transitions carry no economic meaning. A rotated card, a flat mobile tab and a screen-reader view must invoke the same action command. Confirmation for an offer or irreversible choice remains explicit. A failed network response preserves its command identity rather than offering a visually fresh transaction that could duplicate a completed action.

### Accessibility and performance

Use real tab semantics and focus relationships. W3C's tabs pattern specifies active-tab selection, associated panels, arrow navigation and explicit activation where appropriate. Preserve a visible focus indicator and restore focus when closing. [W3C tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).

Provide a flat transition when reduced motion is requested; MDN documents the browser media query for that preference. [Reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

Recommended implementation budgets: animate only the outgoing and incoming panel; use transform/opacity rather than rebuilding every item each frame; keep the active semantic content available and inactive controls noninteractive. Cap texture resolution to the actual viewport. Virtualize large catalogues, lazily decode distant asset sheets, and cache by source hash. Do not upload a 4K snapshot of thousands of inventory icons just to rotate a menu. Low-power devices receive a flat or short slide transition without losing functionality.

Controller shoulders can change primary pages; Confirm and Back remain the stable core. Touch uses visible tabs plus optional swipe, not swipe-only discovery. Text inputs and voice drafts must suppress game attacks. Proximity communication and account feed access remain subject to their own permissions even while the menu is open.

## Implemented state versus remaining work

Implemented in the repository: durable garden inventory, profile-based home permissions, world-region admission leases, fixed-price escrow offers and one saved starter companion. The native quest has source crop-stage rendering and a local action loop. The authenticated shell presents actual account state. Native movement, crop actions and creature presentation are not yet one authoritative spatial simulation.

Not implemented by this report: the soil-family rules above, complete crop/season simulation, multi-station crafting, proper directional art for every tool, a native rotating inventory, creature following/battles, or continuous public/private world geometry. The required next integration is an authoritative action transaction that targets a real admitted region and cell, then emits a world-state change consumed by the same renderer.

Acceptance should include four directions per action, cancellation before contact, exactly one economic contact, overlapping actor/crop depth, palette transparency, reconnect and replay, revoked-helper denial, two simultaneous harvest attempts, inventory reservation visibility, reduced motion, keyboard-only operation, controller disconnect and a low-end mobile performance trace. Frame-rate targets are requirements to measure, not guarantees established by this research.

## Source inventory and remaining gaps

- Local Emerald: `C:/Users/k1rby/OneDrive/Desktop/SpacePoker/charmville-references/pokeemerald`, revision `5eff78649e7170a877b961ef0b3da13b81a16038`.
- Local Solarus ZSDX: `C:/Users/k1rby/OneDrive/Desktop/SpacePoker/charmville-references/solarus-zsdx`, revision `e904d7904d74a97a50992b1340431d5d8f341d69`.
- Local FarmVille Replowed: `C:/Users/k1rby/OneDrive/Desktop/SpacePoker/charmville-references/fv-replowed`, revision `01ece56b75ed578b62396a97705f5333831f41d7`, [repository](https://github.com/FV-Replowed/fv-replowed). Presence verified; crop formulas not audited here.
- Ocarina source was inspected remotely at the pinned revision above; it is not claimed to be a complete local asset extraction.
- Official Minecraft and Stardew pages and W3C/MDN documents are linked inline. Their scope is explicitly narrower than complete engine behavior.

Remaining source work: trace RuneScape farming/skill animation IDs to a versioned compatible asset source; identify season-specific crop sheets beyond existing berries; inspect FarmVille server growth and wither rules; inventory authentic Zelda tool attachment metadata for all weapons; verify tileset-specific Solarus references against the active quest; and map each new crop or material definition to production, consumption and art. Public source availability alone does not establish asset redistribution rights; provenance must remain separate from the reconstruction plan.


## Player menu integration contract

Current shell navigation is Play, Inventory, Companions, Exchange and Friends, with direct Charmdex and Voice shortcuts. These expose working systems; native equipment remains a separate reference-game menu until equipment ownership and commands are connected.

The final organization follows player intent rather than separate franchise menus:

| Destination | Contents | Primary interaction |
|---|---|---|
| Gear and tools | Sword, shield, bow, bombs, magic, harvesting tools, worn gear and quick slots | Equip / use; compare on demand |
| Inventory and Satchel | Physical supplies and materials; distinct owned charm stacks; reserved quantities | Inspect, choose a valid use, move or offer |
| Companions | Roster, active follower, health/status, moves, care, breeding and evolution conditions | Choose companion / inspect |
| Map and journal | Home, regions, friends, routes, quests, skills and tracked objectives | Track / travel when allowed |
| Charmdex | Discovered and undiscovered definitions, recipes, habitats, production chains and uses | Search / pin a goal |
| Exchange | Offers, holdings, reservations and market history | Review then confirm an offer |
| Social | Feed, posts, voice drafts, friends and communication settings | Browse / explicitly compose and publish |

A single Menu/Back pair should open and close the current panel. Shoulder buttons may switch pages; visible tabs must provide the same access on touch. Closing returns focus to the prior game control. Text entry and recording must not also trigger combat. Public-world time continues while browsing; opening a menu does not grant invulnerability. Any danger or interruption policy must be explicit and consistent across devices.

Menus must display the same authoritative inventory and instance identifiers as gameplay. A creature battle must not own a second copy of a companion; a market listing must reserve the same stack shown in the Satchel. An icon is presentation, never evidence of ownership. Optional N64-inspired rotation is a visual transition over these semantics, not a second inventory implementation. Names and grouping remain adjustable as actual content expands.
