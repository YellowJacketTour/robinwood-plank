# Charmville: persistent world master specification

Status: target design, not a claim of completed implementation. This specification governs subsequent work. The native reference runtime currently has temporary local farming and guest poses; it does not implement the authenticated universe below.

## Product contract

One PlankSpace profile owns a persistent character, home, inventories, skills and creature collection. The world combines responsive top-down adventure, creature companionship, domestic life, public industry and social publishing. Ordinary play uses contextual Confirm and Back; combat retains dedicated, remappable actions. Discovery and expressive mastery take precedence over compulsory daily chores. Players can leave for weeks without losing their home or creatures. There is no promise that every device runs maximum settings or that a game can be finished infinitely.

## Connected geography

The following names are working original names. Each location requires an authored map, collision layers, navigation, spawn validation, ambient sound, accessibility pass and persistent entity definitions before it is enabled.

| Region | Connected destinations | Activities and purpose |
|---|---|---|
| Hearthwood home | Canopy Commons through home gate | Private treehouse interior, garden, orchard, pond, barn, companion habitat, workshop, storage, furnishings |
| Canopy Commons | Homes, Graincross, Mosswild | Welcome quests, friend rendezvous, community gardens, tutorial gathering |
| Graincross | Commons, Quarry Road, Riverport | Grained Exchange, bank, artisan shops, museum, guild hall, social plaza, creature clinic |
| Mosswild | Commons, Oldroot Ruins, Rainfen | Woodcutting, forage, insects, wild creatures, traversal puzzles |
| Quarry Road | Graincross, Emberdeep | Stone, ore, construction contracts, mining advancement |
| Rainfen | Mosswild, Riverport | Fishing, aquatic creatures, irrigation, reeds, alchemy |
| Oldroot Ruins | Mosswild, Skywell | Adventure tools, shield puzzles, cooperative encounters, relic restoration |
| Riverport | Graincross, Rainfen, Tidechain | Boats, shipping, public harbor construction, fish market |
| Emberdeep | Quarry Road, Glassreach | Smelting, heat hazards, fire creatures, specialist equipment |
| Tidechain | Riverport, Glassreach | Islands, diving, rare habitats, sailing, player expeditions |
| Glassreach | Emberdeep, Tidechain, Skywell | Advanced fabrication, energy systems, public observatory |
| Skywell | Oldroot, Glassreach, Starhaven | Aerial traversal, weather ecology, launch infrastructure |
| Starhaven | Skywell, expedition worlds | Orbital industry, spacecraft, alien ecology, continuing exploration |

All ordinary routes are bidirectional. Boats, lifts and launches have explicit passenger handling and safe arrival. Fast travel unlocks through visiting a destination; it cannot bypass ownership or encounter restrictions. Basic woodland access does not require a mount. Mounts improve traversal instead of gating first-tier gathering.

Home instances use stable profile IDs, never wallet addresses or display names. A public gate resolves to the selected authorized home, not automatically a visitor's home. Each visit preserves a safe return destination. Public regions may have capacity shards; party routing keeps friends together. A shard never creates a second inventory or exchange.

## Home permissions and cooperative play

Owner rights include furnishing, construction, planting, harvesting and managing visitors. Separate grants allow visit, help crops, care for livestock, gather, build and access a named storage container. Friendship alone never grants withdrawal. Default visitors can walk, converse and view public decorations. Helpers water the owner's crop; ownership of its yield remains unchanged unless an explicit shared contract says otherwise.

Check permissions when an action starts and again at its effect frame. Revoking access prevents new effects and returns a visitor safely; committed effects remain committed. Offline owners retain their plots. Simultaneous helpers cannot spend or harvest twice. Public cooperative projects escrow contributions and expose progress and the reward rule before contribution.

## Progression from arrival through continuing play

1. Arrival: claim home, meet guide, move and interact, till/plant/water, meet a companion, gather a first resource, learn inventory versus Satchel. No wallet purchase is required to learn.
2. Belonging: visit a friend, harvest, prepare food, craft a tool, discover the village, make a first voluntary trade and social charm reaction.
3. Specialization: choose several useful professions; unlock workshops, livestock, fishing, mining, equipment, creature care and local adventure tools. No mandatory combat for domestic advancement.
4. Regional mastery: weather and habitat knowledge, multi-step crafting, creature evolution, dungeons, advanced gear, boats and regional contracts.
5. Civilization: guild projects, businesses, supply contracts, transport, public infrastructure and ecological restoration. Common materials retain uses in construction and maintenance.
6. Frontier mastery: unusual habitats, aerial and space exploration, advanced fabrication, cooperative encounters and rare cosmetic expression.
7. Continuing endgame: collection completion, breeding specializations, architecture, mastery challenges, authored expansions and social events. Add horizontal choices before higher numerical tiers. Seasonal participation cannot confiscate permanent progress.

Skills: cultivation, husbandry, creature care, fishing, forestry, mining, cooking, smithing, carpentry, tailoring, alchemy, engineering, navigation and combat disciplines. Skill unlocks combine demonstrated activities with experience; repetitive low-value actions cannot manufacture unlimited economic rewards.

## Unified object and creature model

Separate emoji family, item definition, variant, stack and unique instance. A cow emoji indexes livestock families; species, breed, quality and individual traits are data beneath it. Unicode variants are not automatically separate commodities. Custom memoji use namespaced definitions. Every definition declares sources, sinks, transfer rules, art bindings and discovery requirements.

Gameplay inventory contains usable equipment, tools, supplies and physical outputs. The Satchel contains owned social charms. A conversion recipe explicitly consumes inputs and produces outputs; viewing the same item in two interfaces never duplicates it. Grain is a currency balance. Unique creatures and gear have stable IDs and cannot simultaneously exist as spendable stacks.

One creature record owns HP, status, traits, progression, owner and encounter lock. World combat, turn combat and hybrid transitions operate on that record. Encounter admission freezes conflicting attacks; leaving resolves to the authoritative world position and surviving status. Capture consumes a ball exactly once, uses server randomness and transfers ownership once. Following, feeding, breeding and habitat assignment reuse that identity. Breeding consumes time, food and capacity; offspring issuance follows a defined budget. No unlimited breeding-to-currency faucet.

## Economy invariants

All transfers and transformations are atomic, idempotent and server validated. Ledger entries identify source, destination, definition, quantity, reason and request ID. Quantities use exact integers with explicit units. Clients request actions; they never report earned balances, elapsed growth or successful captures.

For each asset: closing supply = opening supply + authorized issuance - destruction. Trades transfer supply. Recipes consume and issue declared quantities atomically. Finite renewable budgets can replenish on server schedules with caps; rare discoveries use explicit global or regional issuance limits. Offline time cannot accumulate unbounded issuance.

Grain rewards draw from a disclosed finite treasury allocation or player-funded contract. Cash purchases of Grain require existing inventory from a seller or treasury; payment cannot mint Grain. Existing prototype starter/harvest/tending issuance must be migrated deliberately, with historical balances preserved and accounted for, before the shared economy launches.

Supply chains include crops to meals/feed/textiles; livestock to dairy/fiber/fertilizer; timber and ore to tools/buildings/transport; creatures to companionship and habitat services; exploration to restoration and specialist crafting. Sinks include consumables, construction, recipe inputs, repairs where appropriate and social charm use. Avoid destroying treasured unique companions or cosmetics as routine upkeep.

Exchange orders escrow funds or goods, use deterministic matching, handle partial fills and return unfilled escrow on cancellation. Publish actual executed volume, bids, asks and supply definitions. Liquidity pools require funded reserves and exact fee/slippage rules. Simulated derivatives are a later separately funded subsystem, not necessary for farming or social access. Game Corner activities use a separate nonredeemable amusement budget until a complete reward and abuse model is specified; never silently expose purchased currency to wagering.

## Every action has a physical presentation contract

Each action defines preconditions, facing, windup, effect frame, recovery, cancellation, sound, tool anchor, layer, collision and resulting world state. The server commits at the effect frame. Clients interpolate presentation and reconcile rejection without replaying a reward.

| Action family | Required visible sequence |
|---|---|
| Till / seed / water / fertilize | Face target, appropriate body pose, tool or hand motion, ground contact, soil/seed/water change, recovery |
| Crop growth / harvest | Distinct soil, seed, sprout, juvenile, flowering and mature art; ripe-specific harvest, yield appearance and collection |
| Chop / mine | Directional tool windup and contact loop, material-specific impact, depletion state and output |
| Fish | Cast, line and bobber, wait, bite cue, hook response, reel and catch presentation |
| Lift / carry / throw | Correct object removed from ground, attached to hands, carry pose, release trajectory, landing and collision |
| Sword / shield / bow / bomb | Correct shield displacement, directional attack arc, charge state, bow draw/release, bomb fuse/flash and explosion |
| Creature care / capture | Approach and reaction, feeding item, affection or status response, ball flight, capture outcome and ownership update |
| Build / craft / travel | Tool/station interaction, measured progress, completed geometry; boarding, passenger state and safe disembarkation |
| Transformation / magic | Full character-compatible appearance, sustained aura, directional movement, effect origin and clean restoration |

No arbitrary source tile substitution. Sprite adapters declare atlas bounds, palette, body size, directional frames and attachment points. Test north/south/east/west, occlusion, interrupt, map transition, damage, multiplayer observation and low frame rate. Tall objects sort by world foot anchor; canopy and roof overlays are separate from solid collision. Source-specific sword and casting banks must be validated together.

## Technology and authoring boundary

Keep authoritative domain state independent of renderer. Existing native quest runtime remains a source-behavior reference and current player, with its fixed camera limitation recorded. Do not promise seamless large 3D worlds from its existing WASM build. A future renderer decision requires measured sprite fidelity, browser memory, mobile input, large-map streaming and multiplayer benchmarks before replacing working content.

Content packs declare version, dependencies, provenance/license, stable IDs, animation contracts, collision and navigation. Preserve source references independently from distributable assets. Public availability does not establish redistribution permission. Community submissions run through validation, review, preview and versioned publication; scripts execute in bounded capabilities without account or filesystem access. Published worlds pin compatible content versions and support rollback.

## Performance and acceptance

Proposed targets, not measured guarantees: 60 fps on representative mainstream desktop/mobile; a consistent 30 fps fallback on selected lower-end devices. Define actual hardware and browser fixtures before claiming coverage. Stream nearby chunks, cull invisible entities, batch sprites, cap particles and audio voices, and keep texture budgets per device tier. Simulation outcomes cannot depend on rendering frame rate. Support touch, remappable keyboard, gamepad, zoom and fullscreen without losing input focus to the Charmdex.

The first permanent connected release must prove: two authenticated accounts with separate homes; authorized visit and help; unauthorized harvest/storage denial; reconnect persistence; animated gathering and farming; a creature capture and follower; a crafting transformation; escrowed player trade; and consistent balances after concurrent requests, retries and disconnects. All of these must use the same authoritative ownership system. No guest counter import.

Implementation order: identity and durable action ledger; home access and travel; animated resource lifecycle; creature ownership and encounters; crafting and exchange; village/public projects; regional content; advanced travel; community authoring. Work on independent art and map preparation in parallel, but do not bypass these dependencies. Each release records what is playable, tests performed, known defects and the next connected milestone.
