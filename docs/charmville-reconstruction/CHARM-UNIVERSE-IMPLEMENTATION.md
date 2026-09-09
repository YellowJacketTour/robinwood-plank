# Charm universe implementation and economic design

## Complete vocabulary, expandable world
The pinned Unicode 17.0 emoji-test data supplies 3,953 catalogue entries: 3,944 fully-qualified sequences and nine standalone components. The generator preserves codepoint sequence IDs, names, group, subgroup and source hash. This is full coverage of that particular dataset, not a claim to cover every proprietary sticker, custom memoji, font image, or game asset. Source: [Unicode emoji-test data](https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt). The original file and its licensing notice are retained.

The in-game Charmdex searches these entries. Its category-to-economy assignments are proposed design roles. Every entry initially marks gameplay and artwork as unmapped. Existing custom memoji identifiers remain separate namespaced identities and must not be silently replaced by Unicode names. A reviewed alias table will link them where appropriate. Skin tone, gender and flags are expression choices, not economic power or rarity tiers.

A complete asset catalogue needs a many-to-many relation: semantic family → definition → visual representation. One cow family can point to pasture overworld art, a portrait, milk item art, a reaction and a building sign. These representations do not create five cows. Conversely, several livestock species can share a family glyph while remaining distinct definitions. Every art binding must specify provenance, frames, palette, origin, collision footprint, motion directions and supported actions. A missing walking animation cannot be replaced by stretching a battle portrait.

## Proposed progression lattice
Progression should be multidimensional. Skill gates indicate competence; material tiers indicate equipment capability; quality grades describe condition/output; species traits define specialization; rarity describes supply and discovery. None should be inferred from the emoji glyph alone. Trade equivalence requires a canonical definition and meaningful variant attributes; unique animals, personalized gear and constructed homes retain instance IDs.

| Progression band | Example families | Criteria and useful outputs |
|---|---|---|
| Household | grass, seeds, berries, chicken, fish, wood | Learn gathering, planting, cooking, basic tools and first trades |
| Skilled village | cow, sheep, bee, mushroom, axe, thread | Habitat, breeding maturity, workshops, husbandry and ingredient quality |
| Regional specialist | ore, gem, boat, horse, snow, desert | Travel access, specialized equipment, biome permits and cooperative work |
| City producer | factory, rail, crane, hospital, energy | Public construction contracts, logistics, upkeep, civic services |
| Mythic ecology | dragon, unicorn, phoenix-like custom family, crystal | Habitat restoration, quest knowledge, rare catalysts and group encounters |
| Expedition/astral | telescope, rocket, satellite, planet, comet | Shared infrastructure, navigation, fuel, expedition supplies and research |
| Legacy/community | trophy, art, monument, festival | Authored contributions, mastery, stewardship and lasting public achievements |

These are proposed bands, not assigned live level numbers. Endgame should include excellent common-resource producers, explorers, breeders, builders and artists. It must not collapse into one numerically strongest animal. Ordinary wood, food, cloth and fertilizer remain inputs to advanced projects, so new players have a role.

## Homestead and public territory responsibilities
A home owns land-use choices, furniture, crops, livestock capacity, storage, workshops and permitted visitors. Ownership does not grant arbitrary server commands or unlimited global production. Its private instance is a presentation and access boundary; resource issuance still belongs to the world simulation.

A public meadow offers shared renewable harvesting with regeneration and access rules. Forests, mines, wetlands and oceans have distinct capacities and disturbance rules. Civic districts offer markets, workshops, recreation and public works. Expedition regions offer scarce discoveries and costly logistics. Event regions have published start/end times, temporary recipes and a defined post-event treatment for materials. Every border transfer validates destination, actor permission, arrival position and inventory continuity.

Private livestock remains private; public wildlife is not automatically privately claimable. Capture or adoption requires a validated claim, appropriate item, habitat capacity and committed ownership transition. Cooperative encounters need an explicit reward allocation rule before combat begins. Respawning a region cannot respawn already-claimed unique rewards.

## Livestock and breeding chains
| Family | Inputs and care | Products and roles | Limits |
|---|---|---|---|
| Cattle | Pasture, water, feed, shelter | Milk, dairy recipes, manure, collection | Maturity, wellbeing, collection interval, habitat capacity |
| Sheep | Feed, shelter, grooming | Wool, yarn, clothing, insulation | Regrowth interval and shear action |
| Poultry | Coop, feed, space | Eggs, incubation, feathers | Nest capacity, fertility, adulthood |
| Bees | Flowers, hives, suitable weather | Honey, wax, pollination | Forage capacity; overstocking reduces efficiency |
| Horses | Feed, stable, training | Mount travel and logistics | Stamina, rest, training and equipment |
| Fish | Suitable water and food | Aquaculture, cooking, ornamental keeping | Water quality, population and reproduction budget |
| Mythic companions | Specialized habitat and quest inputs | Regional traversal or particular work specialties | Published breeding eligibility and scarce catalysts |

A breeding operation reserves parents and inputs, checks compatibility/maturity/cooldown/capacity, records a server-generated offspring outcome once, and completes after a server deadline. Disconnecting or changing renderer cannot reroll offspring. Parentage and traits are explicit instance data. Ordinary family appearance has no hidden relationship to economic worth. Inherited traits should trade off specialization; do not make breeding an infinite exponential resource generator.

Waste and low-grade outputs can become compost, feed, construction filler, fuel or research supplies. Their conversion efficiency must be bounded. If a closed recipe cycle returns more of every input than it consumes, it is an exploit unless explicitly budgeted as production requiring time/capacity. Recipe dependency cycles need automated checks and simulation.

## Unified accounting
Keep the existing profile-owned ledger as the migration starting point. The newly added compartments are projections: gameplay.seeds, satchel.charms, currency.grain. They do not duplicate inventory. Tool instances, creatures, regional storage and market escrow will require approved schemas and transaction semantics; none are invented by this projection.

For each commodity, closing supply = opening supply + authorized issuance - consumed/burned units. Transfers, market escrow, purchases from treasury and changing inventory views have zero effect on total supply. Every issuance requires a source budget, rule revision and unique event ID. Every debit must check availability within the same transaction as its credit or sink. An item committed to a market order is unavailable for feeding, reacting or crafting.

The current durable garden grants Grain on claim/harvest/tend, and the native demo gives temporary berries. Those paths are not yet finite-treasury-compliant. They must not be described as the finished economy. Native reported counters must never be accepted as deposit receipts. A migration must reconcile existing balances rather than overwrite them.

Production can allocate global capacity to regions and households. Capacity needs transparent renewal rules and protection against starvation of newcomers. More alternate accounts must not create extra scarce budget. Anti-cheat needs validated actions, bounded movement, timing, replay protection, audit trails and abuse detection in addition to arithmetic. No claim of perfect cheat prevention is justified.

## Game Corner and city leisure
Emerald's slot_machine.c is useful for visual cadence, reel presentation, sound, machine state and interaction research. Its source explicitly includes luckyGame, machineBias and ReelTime behavior. It should not be imported as a supposedly simple independent uniform reel model. [Source: pret/pokeemerald slot_machine.c](https://github.com/pret/pokeemerald/blob/master/src/slot_machine.c).

A proposed city district can contain a Game Corner, fishing competitions, skill courses, collection exhibitions, crafting contests and social venues. Chance games are optional recreation within the simulated economy. They should not be the only source of essential progression materials. Separate participation souvenirs from monetary balances and from skill-based tournament rewards.

A simulated chance game needs a versioned paytable, explicit outcome distribution, stake, maximum liability, bankroll reservation and one-time settlement. Before accepting a stake, reserve the maximum amount the house might owe; reject the round if funds are insufficient. Settle the player's debit and resulting payout against that reserve atomically. A disconnected client retrieves its existing result rather than rerolling. Show the same odds to every player; animations reveal an already committed result and do not secretly change it.

Expected payout is the sum of outcome probability times payout. Any fee and the treatment of returned stake must be defined consistently. This expectation is a property of a tested game definition, not a guaranteed player result. Jackpot contributions move existing currency into a disclosed reserve; jackpots must not create Grain. Replays, bonuses and free spins still reserve liabilities. Test rounding, maximum payouts, concurrent rounds, depleted bank, replay, crash recovery and adversarial request sequences.

No new gambling game, payout service, or city map is implemented here. Existing real-money application contracts are separate and must not be wired into simulated Grain without an explicit design and review.

## Encounter continuity
The proposed encounter module keeps one entity ID, HP, statuses, controller and eventual owner across world and turn views. A server-authorized capture consumes one ball once and creates one specimen once. Native Emerald rules, animations and damage formulas are not implemented by this model. The module requires authenticated callers, server validation, trusted randomness and atomic persistence before it can govern live rewards. See HYBRID-ENCOUNTER-CONTRACT.md.

The intended three presentations are world action, native-style turn battle and hybrid handoff. Changing presentation must not heal a creature, clear poison, replenish balls, award XP twice or create a second specimen. Group combat and disconnect claim release still need product rules. Rendering should be attached after this shared state is authoritative.

## Current delivery and remaining acceptance gate
Delivered: searchable full Unicode catalogue in the fullscreen shell; owner-only account inventory compartments; tested encounter domain proposal; comparative research and economic design. The catalogue is discovery UI, not a market or an inventory screen. Catalogue coverage does not mean every emoji has authored species, recipes or sprite animations.

Still required: shared native account bridge, canonical live resource migration, persistent encounters and breeding, finite production/treasury enforcement, actual order matching, city maps, full art mapping, social feed access and authoritative multiplayer settlement. The acceptance gate remains two authenticated players growing or acquiring resources, converting them, exchanging them, and observing the same persistent outcomes after reconnecting. This checkpoint does not satisfy that gate yet.
