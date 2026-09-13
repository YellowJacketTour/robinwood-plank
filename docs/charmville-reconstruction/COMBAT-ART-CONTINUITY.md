# Combat art and world continuity

## Evidence and current gaps

The live Homestead script draws a procedural ellipse and orbiting line accents for aura. It adds `universal-lpc/spritesheets/hair/spiked2/male/gold.png`, using walk rows 8–11, scaled from 64-pixel cells to 32 pixels. This is a partial presentation implementation, not a complete transformation costume or a charged-beam ability. A hair sheet made for another body cannot establish correct head placement for every native casting, carrying, swimming, hurt and sword frame.

The local change makes the body-attached aura and hair subtract native Z and FakeZ from the ground Y coordinate. Collision and account coordinates remain ground coordinates. Native candidate compilation passed; visual jump/casting verification is outstanding. This does not fix costume registration, foreground occlusion or unsupported action poses.

The report of returning blue hearts does not identify the equipped item. Do not rename or recolor a native hookshot, boomerang or spell as a beam without identifying its item family, weapon graphics and return rules. Preserve the reference quest. Record a reproduction with selected item, direction, screen, charge duration and outbound/impact/return frames.

The code audit found no Kamehameha in active scripts, lib or app code. `adventure-entry.mjs` includes default item slots 35 (Fire boomerang), 25 (Wand) and 89 (Longshot), while warning that the authored quest can redefine them. The local DragonBallArena reference has multipart beam resources in `AnimatorGameFactory.java` and creation logic in `Goku.java`; those side-view Java assets are not an integrated top-down ability. The native hookshot implementation in the local ZQuest `src/zc/weapons.cpp` uses separate head, handle and chain objects, so returning motion alone is insufficient to classify the report.

## Source design findings

Solarus separates sprite appearance from entity behavior and permits custom collision and traversal rules. Direction can propagate to a custom entity's sprites, while layer-independent collision is an explicit choice. This is a useful precedent for keeping a hammer's art, contact and world permissions coordinated without treating visible pixels as the sole physics definition. [Solarus custom entities](https://docs.solarus-games.org/lua-api/map-entities/custom-entity/).

Godot CanvasItem exposes Y sorting, Z order and texture filtering separately. Its documentation describes higher Y positions drawing in front when sorting is enabled. Charmville should therefore distinguish floor, ground anchor and visual height; a single global foreground layer cannot express bridges, tree canopies and airborne effects. These are design lessons, not evidence that the current ZQuest adapter implements Godot's rendering model. [Godot CanvasItem](https://docs.godotengine.org/en/stable/classes/class_canvasitem.html).

Emerald's battle-animation script table assigns distinct animation routines to moves including Ice Beam, Aurora Beam and Hyper Beam. Its battle-command layer is separate from that animation source. Adapt move timing and semantic identity through an adapter; do not treat a staged battle's screen coordinates as world coordinates. [Emerald animation source](https://github.com/pret/pokeemerald/blob/master/data/battle_anim_scripts.s), [battle commands](https://github.com/pret/pokeemerald/blob/master/src/battle_script_commands.c).

## One action contract across game modes

Each action needs an identity, actor, target or aim, authoritative start tick, resource cost, allowed movement, contact windows, cancellation rules and completion outcome. Presentation consumes those facts. An animation finishing must not independently mint damage, loot or a charm. Reconnecting or switching to a staged battle must not replay rewards.

Each visual binding needs source provenance, palette, projection, native pixel scale, frame rectangles, direction mapping, ground origin, hand or mouth socket, elevation offset, duration, foreground/background parts and supported actor poses. Missing bindings are tracked as missing; a randomly adjacent atlas tile is never a fallback.

Preserve grounded world position independently of drawn height. Sort feet and shadows against the appropriate floor. Attach tools to authored sockets. Split long effects into depth-aware pieces where required. Render canopy and roof occlusion according to the map, not by forcing every effect above everything. Decorative glow cannot enlarge the damaging hitbox.

The present Zelda-style view is an oblique top-down presentation. A true isometric map requires a compatible projection and directional asset set. High-resolution output alone neither changes perspective nor creates missing detail. Preserve deliberate pixel clusters, consistent scale and silhouette; allow interface resolution to increase independently of world art.

## Ability-specific visual grammar

| Action | Anticipation and contact | Travel and finish | Required distinction |
|---|---|---|---|
| Charged energy beam | Braced stance, hands converge, charge grows at hand socket; clear release moment | Continuous core and outer envelope extend along aim; wall or target impact; dissipate and recover | No returning chain or heart train; decorative particles do not determine damage |
| Grappling tool | Arm aims; visible mechanical hook leaves the hand | Tether extends, hits approved anchor or stops, retracts or pulls actor | Return is mechanical and connected; terrain permissions determine pulling |
| Boomerang | Directional throw pose | Outbound arc, turn, inbound flight and catch | Independent returning object; no sustained beam silhouette |
| Transformation | Charge stance and coherent costume change | Body-attached aura, separate ground accents; directional movement and action poses | Hair alone is incomplete; shield, weapons and head must retain proper overlap |
| Farming tool | Face bed, plant feet, bring correct implement forward | Contact at soil or crop, particles at contact, recover | Yield follows committed server contact; growth sprites retain soil anchor |
| Capture ball | Select owned ball, aim and throw | Ball arc with ground shadow, contact, shakes, capture or release | Same target health/status and custody in world and staged views |

Beam collision needs a swept segment or equivalent bounded query, clipped at blocking terrain. Decide piercing, thickness and target eligibility explicitly. A sustained beam needs a tick-based damage cadence and one authoritative resource drain. Lag or rendering rate cannot increase hit count. Recovery should prevent immediate unbounded spam while allowing understandable interruption rules.

## Shared combat and economy

World combat and staged command combat are views of one encounter, with one target identity and health/status timeline. Switching view does not heal, clone or respawn the creature. Party members seen in a staged background should represent actual participants and committed actions, with presentation positions separate from simulation positions.

Solo, party, competing-party, PvE and PvP eligibility must be resolved before damage, support, capture or loot. Companion attacks do not create extra player loot allocations. Capture transfers one creature instance, not one per watching client. Party loot follows the agreed per-eligible-player allocation rule; unpartied observers do not receive automatic copies. Charms enter custody through recorded issuance or transfer, never through particles, repeated animation events or social reaction loops.

## Art acceptance and creator pipeline

Review every direction in idle, movement, anticipation, contact, sustained action, recovery and interruption. Include tree foregrounds, walls, screen boundaries, raised terrain, water, simultaneous allies, enemy impacts and UI overlays. Check normal speed and frame stepping. Evaluate silhouettes against bright grass, dark interiors and visually crowded raids. Mobile effects budgets may reduce secondary particles but must preserve attack intent and collision telegraphs.

Community themes can change decorative palettes, frames and permitted cosmetic bindings. They cannot hide hostile telegraphs, alter collision or forge rarity/custody indicators. Version packs, validate atlas bounds and required directions, retain attribution and source hashes, and preview against reference scenes before activation. Never assume source-code availability also establishes an art license.

## Delivery order and honest status

1. Identify the reported projectile from runtime evidence and item graphics; currently unresolved.
2. Validate the compiled elevation fix through jumping and spell actions; not visually verified yet.
3. Author a complete actor-compatible transformation pose set and depth-aware aura; missing.
4. Implement a distinct charged-beam action with server authority, dedicated art and collision; missing.
5. Connect each ability to world/staged encounter adapters, persistence, costs and multiplayer reconciliation; incomplete.
6. Review the same contracts for tools, companions, capture, farming and social charm issuance.

A successful compile establishes script compatibility. It does not establish visual quality, multiplayer correctness or completion of these milestones.
