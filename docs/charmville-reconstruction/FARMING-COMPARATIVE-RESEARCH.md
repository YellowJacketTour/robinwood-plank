# Farming, creatures, and the Charm universe economy

## Scope and conclusion

Charmville should combine a readable homestead routine, useful creature companionship, material transformation, and public specialization. Emoji provide a discoverable semantic catalogue; they should not impose a one-emoji-to-one-item restriction. A cow symbol can organize many cattle breeds, individual animals, milk grades, husbandry activities, and associated social collectibles without pretending these are interchangeable assets.

This document distinguishes verified reference mechanics from proposed Charmville systems. Sources were checked on September 9, 2026. Numerical production rates, probabilities, level requirements, and market prices below are deliberately not claimed as balanced or implemented. This is a design foundation, not evidence that the current native prototype already has persistent livestock, authoritative rewards, or an authenticated shared exchange.

## Verified reference mechanics

### Stardew Valley: home, community, and progression

ConcernedApe describes a farm inherited from a relative, transformation of overgrown fields, animal raising, fishing, crops, crafting, community relationships, caves, and home customization. These activities establish the farm as a personal anchor rather than a detached production menu. [ConcernedApe, Stardew Valley](https://www.stardewvalley.net/).

The official 1.6 changelog provides particularly relevant examples: Meadowlands starts with a coop and two chickens; its blue grass supports an animal-oriented identity. Mastery offers additional progression through a new area. Festivals include a desert event reached after repairing the bus and two fishing events. The important design evidence is that farm choice, infrastructure, community events, and late progression can reinforce different play styles. Exact balance is version-specific. [ConcernedApe, 1.6 changelog](https://www.stardewvalley.net/stardew-valley-1-6-update-full-changelog/).

**Charmville interpretation:** introduce one complete production chain before exposing the whole universe. A treehouse household can choose a garden, coop, or workshop focus, but retain access to all branches later. Public infrastructure should unlock destinations and new recipes rather than simply increase every existing yield. Events can create temporary recipe demand without invalidating ordinary crops.

### Palworld: creatures as productive and traveling companions

Pocketpair's product description explicitly connects Pals to combat, farms, factories, planting, watering, harvesting, fire, electricity, mining, and traversal over land, sea, and sky. It also describes inherited parental characteristics, creature trading, and multiplayer. This verifies the broad connection between creature identity and productive role; it does not establish a universal breeding formula, economic equilibrium, or MMO-scale capacity. [Pocketpair, Palworld product description](https://store.steampowered.com/app/1623730/Palworld/).

**Charmville interpretation:** every domestic or captured creature can have a small, understandable role set. A water companion can help irrigate, a sheep provides wool, and a mount expands travel. Assistance should consume food and occupy work capacity. It must not bypass world production limits. Breeding should be a designed husbandry loop with parental records, habitat, nutrition, maturity, and limited offspring opportunities, not an unbounded exponential mint.

### Minecraft: common materials retain multiple purposes

Mojang's wheat article connects tilled and irrigated cultivation to animal breeding and other uses. Its cow article documents wheat-based breeding and milk collection. These are useful examples of one ordinary resource participating in several loops. [Mojang, Wheat](https://www.minecraft.net/en-us/article/taking-inventory--wheat), [Mojang, Cow](https://www.minecraft.net/fr-fr/article/cow).

Microsoft's creator documentation exposes an NPC composter behavior that converts excess seeds into bone meal, including work duration and interaction controls. Mojang's candle article links string and honeycomb to a decorative light. These demonstrate both byproduct reuse and connections between husbandry and domestic decoration. [Microsoft, work_composter](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_work_composter?view=minecraft-bedrock-stable), [Mojang, Candle](https://www.minecraft.net/ja-jp/article/taking-inventory--candle).

Mojang explains netherite's original design as an upgrade to existing diamond equipment so the earlier material remains useful. Its 2020 recipe description is historical; later official snapshot documentation adds a smithing-template requirement. This report adopts the preservation-of-input-value principle, not the old recipe as a current implementation specification. [Mojang, Netherite Ingot](https://www.minecraft.net/en-us/article/taking-inventory--netherite-ingot), [Mojang, Snapshot 23w04a](https://www.minecraft.net/de-de/article/minecraft-snapshot-23w04a).

**Charmville interpretation:** roots, grass, seeds, wood, fiber, and milk should remain inputs to advanced goods. Endgame production can require refined common materials alongside a scarce catalyst. New tiers should expand recipes and capabilities rather than make the previous tier worthless. Repeating a transformation cycle must still require time, capacity, or a budgeted source; a positive free conversion cycle is an exploit.

## What belongs in private and public territory

The following is proposed Charmville design, not a description of the reference games.

| Territory | Player control | Shared access | Production and ownership rule |
|---|---|---|---|
| Private home interior | Furniture, storage, display, crafting stations | Owner-approved visitors | Placement refers to owned instances; display does not duplicate them |
| Private garden | Soil beds, seeds, irrigation, compost, harvest timing | Explicit helper permissions | Plot capacity plus seasonal production allocation; visitor assistance cannot mint a second harvest |
| Ranch and orchard | Feed, shelters, parent selection, pruning, husbandry | Authorized care or trade appointments | Animal identity, maturity, habitat capacity, and finite feed inputs |
| Neighborhood commons | Cooperative beautification and projects | Public movement and interaction | Contributions escrowed to project; construction changes shared map state |
| Wild forest and river | Temporary gathering and encounters | Public exploration | Regional resource budget, regeneration, contested-action arbitration |
| Mine and quarry | Expedition tasks and extraction | Public or party instances | Deposits have finite yield; separate encounter instance must not imply unlimited economic copies |
| Port and trade town | Stalls, contracts, services | Public exchange | Goods move through inventory escrow; local order views may reference one global market |
| Guild industrial district | Permissioned facilities and routes | Members and customers | Throughput, fuel, staffing, and input constraints |
| Event region | Participation and temporary projects | Scheduled public event | Announced reward allocation; ordinary materials remain relevant |
| Frontier island or orbital region | Specialist outposts and transport | Progression-based access | Logistics capacity and expedition inputs; no automatic higher yield merely for travel |

Private maps must never become a way to create an unlimited number of copies of scarce resources. A home is an ownership and presentation boundary. Its production allocations are issued by the same authority as public resources. Additional households need an explicit expansion policy, not hidden issuance through alternate accounts.

Public borders need stable region IDs, arrival locations, capacity handling, permission checks, and transaction continuity. Carrying a cow through a gate moves one entity. Entering a battle moves control of one creature record. Neither operation creates a new copy. A disconnected player should resume a committed state rather than rerolling a reward.

## Emoji coverage without flattening the world

Unicode distinguishes emoji characters, presentation sequences, modifiers, and joined sequences. The count depends on what is counted; a displayed emoji is not necessarily one code point. Production should ingest a pinned emoji data release rather than scrape visual charts or split strings by character. Unicode 17.0 is the stable version shown by the sources consulted. [Unicode, UTS #51](https://www.unicode.org/reports/tr51/), [Unicode, Emoji Counts](https://unicode.org/emoji/charts/emoji-counts.html).

Use four separate identities:

1. **Semantic family:** a versioned Unicode sequence or a namespaced custom memoji, such as the cow family.
2. **Definition:** a designed species, material, recipe output, structure, tool, or social collectible.
3. **Variant:** quality, breed, material tier, visual form, provenance class, and other meaningful attributes.
4. **Instance or stack:** an owned individual animal/tool, or fungible units with identical trading attributes.

The family makes discovery simple. The definition determines behavior. The variant determines interchangeability. The instance records ownership and mutable state. Never use the rendered emoji string as the sole database key. Preserve aliases so catalogue changes do not orphan inventory.

| Emoji category | Proposed economic representation | Important distinction |
|---|---|---|
| Animals and nature | Livestock, companions, wildlife, seeds, plants, timber, pollinators | A cow face and cow body may share a family but need not create separate species |
| Food and drink | Ingredients, meals, preserves, feed, festival recipes | Edible use consumes a unit; a discovered recipe remains knowledge |
| Objects | Tools, machines, furniture, instruments, containers | Equipped, stored, placed, and listed are states of one owned item |
| Travel and places | Buildings, vehicles, route permits, destination discoveries | Owning a building Charm does not automatically own public land |
| Activities | Sports equipment, event participation, trophies, game pieces | Participation records and transferable goods are different asset classes |
| Smileys and emotion | Expression collectibles, effects, reaction charges | Free text expression must remain distinguishable from spending a collectible |
| People and body | Avatar expression, profession emblems, gestures | Identity-related appearance variants should not imply stronger or rarer people |
| Symbols | Recipe categories, signals, magical schools, interface labels | Not every interface symbol should become a mined commodity |
| Flags | Decorations, community identity, collection entries | Representation is separate from gameplay power |
| Components | Rendering metadata or avatar components | Do not invent independent commodities solely because a component exists in Unicode |

The full emoji list is a coverage checklist, not a requirement that every symbol have a bespoke production machine. Each catalogue row needs a deliberate status: playable object, social collectible, cosmetic, interface-only, alias, or not yet designed. [Unicode, Full Emoji List](https://unicode.org/emoji/charts/full-emoji-list.html).

## Livestock and production chains

All chains below are proposals. Their coefficients need simulation and playtesting.

| Family | Care and capacity | Renewable output | Combinatorial uses |
|---|---|---|---|
| Cattle | Pasture, feed, water, barn space | Milk, compost inputs | Cheese, meals, festival desserts, husbandry contracts |
| Sheep | Grazing, shelter, shearing interval | Wool | Yarn, clothing, banners, upholstery, insulation |
| Chickens | Coop, feed, nesting space | Eggs | Cooking, incubation, baking, delivery contracts |
| Goats | Browse, shelter, care | Milk | Distinct dairy recipes and regional specialties |
| Bees | Flower access, hive capacity | Honey and wax | Food, candles, polish, decorative crafting |
| Horses | Stable, feed, training | Travel service | Mount equipment, delivery routes, races |
| Fish | Water habitat, feed where cultivated | Harvested fish or breeding stock | Food, bait, aquariums, specialist contracts |
| Rabbits | Shelter and care | Designed non-destructive fiber or companion role | Textile specialty or companionship; do not invent a real-world claim |
| Mythic creatures | Specific habitat and earned progression | Bounded specialty materials or abilities | Rare recipes, traversal, cooperative encounters |

Breeding records should include parent IDs, species rule version, birth eligibility, inherited traits, generation, cooldown, reserved capacity, and resulting offspring ID. Traits should offer tradeoffs: cold tolerance, stamina, milk composition, temperament, or work specialization. A single universally superior genetic roll would concentrate demand and discard the rest of the system.

Eggs intended for cooking and eggs committed to incubation cannot both remain available. Reserve the egg or breeding inputs when the action begins, commit at the specified stage, and define interruption behavior. Naming an animal, rendering it as a follower, or listing it for sale must not reset its age, cooldown, or history.

## Progression beyond a single rarity ladder

Keep four axes separate: **skill requirement**, **material tier**, **quality**, and **rarity**. A common high-tier industrial input can be difficult to produce but plentiful among specialists. A rare decorative flower can be obtainable by a beginner. A carefully raised ordinary cow can produce excellent milk without becoming a mythical species.

| Progression band | New capability | Example Charm families | Continuing demand for earlier goods |
|---|---|---|---|
| Household | Gather, grow, cook, keep first animal | Seeds, berries, eggs, wood | Food, compost, repairs, simple tools |
| Artisan | Process, breed, specialize | Cheese, cloth, honey, pottery | Milk, fiber, fuel, containers |
| Regional specialist | Biome adaptation and expeditions | Rare herbs, ores, fish, mounts | Meals, tools, transport supplies |
| Civic producer | Cooperative infrastructure | Bricks, machinery, bridges, boats | Bulk timber, stone, textiles, food |
| Master craft | Multi-profession transformations | Enchanted equipment, rare breeds | Existing tools become upgrade inputs |
| Frontier | New environments and logistics | Habitat systems, specialist craft | Construction inputs and expedition provisions |
| Legacy and cosmic | Difficult cooperative achievements | Observatory, star catalyst, world-event trophy | Broad supply chains plus bounded catalysts |

The highest advancement should require breadth, mastery, cooperation, and infrastructure rather than only a larger number above the same sword. Cosmic items should enable new activities; they should not make a novice's grain or wool obsolete. Price is determined by actual offers, not automatically by tier labels.

## Economy invariants and practical fun

For each asset, record opening stock plus authorized production minus consumption, with transfers summing to zero globally. For recipes, account for every input and output, including byproducts. Grain sales funded by real money must transfer existing reserve or player holdings under the stated non-dilution requirement. They cannot silently mint currency.

Renewable means finite throughput, not a finite lifetime total. Distinguish lifetime-limited collectibles from replenishing commodities with a published production policy. Budgets must be global or regionally allocated, with anti-monopoly access and enough ordinary supply for new players. Overly tight global caps can make basic farming unavailable; this must be tested rather than assumed fun.

Use finite civic purchase orders to support useful entry-level activity. A town can demand timber for a bridge, but its payment budget is real within the simulation. Avoid promising every item a permanent floor price. Compost and salvage provide utility even when a market is quiet, but recycling alone does not guarantee market demand.

Automation trades repetitive labor for construction, maintenance, food, and capacity decisions. It should retain visible world activity and clear bottlenecks. It must not multiply issuance merely because an unattended client can run more action loops.

Test economy scenarios with low population, mass onboarding, coordinated automation, inactive owners, seasonal supply shocks, hoarding, and collapsed demand. Measure median time to basic tools, unsold listings, production/consumption ratios, currency concentration, and whether new players can contribute. No mathematics alone guarantees absence of cheating or manipulation.

## Art and interaction requirements

An art catalogue needs behavior metadata, not only file names: source/version/hash, palette, cell bounds, frame timing, origin, facing, foot anchor, grip anchors, depth rule, collision shape, action phases, and stage transitions. A plant needs distinct seed, sprout, growth, ripe, harvested, and recovery states where applicable. A cow needs idle, locomotion, eating, resting, interaction, and relevant production feedback. Missing animations must be recorded as missing rather than substituted with misleading generic slashes.

World, battle, inventory, and social art may differ while resolving to the same definition or entity. A battle portrait is not necessarily suitable as a walking overworld sprite. A source pack that has only a front-facing animal image cannot honestly supply a full directional follower. Scene transitions must preserve health, ownership, status, and reserved resources independently of which renderer is active.

The first complete acceptance path should be: authenticated account enters its home, plants and waters, sees timed stages, harvests once, allocates produce to feed or crafting, receives a ledger-backed product, lists it, and completes a trade with another account. Then add an animal chain and an encounter chain against the same ownership rules. Passing a local sprite demonstration does not establish this end-to-end path.

## Research limits

This report uses developer/publisher material and Unicode specifications for reference facts. It does not claim source-level compatibility between these games or that their internal engines can be merged directly. It does not establish exhaustive asset availability, exact current balance tables, or a license inventory. All Charmville tables are proposed design and require implementation plus economy simulation. The older Minecraft article is used specifically for historical design intent, with its recipe-age limitation stated above.
