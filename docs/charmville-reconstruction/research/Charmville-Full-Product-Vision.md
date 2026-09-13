# Charmville / PlankSpace — full product vision and implementation contract

September 9, 2026. This document records the user's ambition, proposed implementation rules, and current evidence separately. It supersedes any earlier interpretation of Charmville as only seven collectible reactions or a small profile farming widget. Proposed mechanics below are design decisions to validate, not claims that they are shipped.

## 1. The intended experience

Charmville is PlankSpace inhabited: an expressive, persistent, community-authored MMORPG and civilization simulator whose people, posts, relationships, creations, resources, and markets belong to a coherent world. Its everyday experience has the nostalgic readability of Graal and classic Zelda. Its progression combines RuneScape skills and equipment, Pokémon-like creature discovery and capture, FarmVille cultivation, Animal Crossing personal expression, SimCity civic development, Minecraft combinatory construction, EVE industrial interdependence, and a long horizon toward No Man's Sky-like exploration.

The user should enter as a character, recognize a place, have something enjoyable to do immediately, and see why their actions matter to other people. This must become a game worth inhabiting before its economy can make it interesting. A dashboard, decorative garden, anonymous primitive character, or list of promised features does not meet that standard.

Normal presentation: top-down or restrained isometric 2.5D, readable silhouettes, rich grass and ground detail, expressive pixel/neo-chibi characters, clear collision and interaction cues, charming buildings, foliage, interiors, water, secrets, and movement with satisfying weight. The underlying renderer supports 3D geometry and lighting. Special events can tilt the camera, deform or reveal the world, bring in spacecraft, and leave persistent consequences. Visual diversity must remain coherent through art direction.

The user's permission covers reference art during prototyping, with an explicit eventual replacement by bespoke equivalents. Track provenance and replacement status now so later replacement is practical. Preserve source assets and imports rather than flattening everything into screenshots.

## 2. The player's first hour

The intended first session introduces one connected loop:

1. Enter using the same PlankSpace identity, select or customize an avatar, and arrive at an inhabited commons.
2. Move immediately with keyboard, pointer, touch, or controller. Talk to an NPC or inspect another player's public profile without leaving the sense of place.
3. Cut grass with a sword, gather a resource, find a hidden charm or encounter, and receive clear sound/animation feedback.
4. Claim or visit a home parcel; plant something, water or tend it, and understand its growth schedule.
5. Craft an early tool or useful item from the gathered material. See the recipe and the source of ingredients.
6. Discover a creature, learn its behavior, attempt a capture or bond under explicit rules, and add it to a journal.
7. Discover the charm atlas and distinguish expressive identities, game resources, and externally issued assets.
8. Use an earned eligible charm on a real PlankSpace post. The post and profile reflect the same recorded action.
9. Visit the Grained Exchange and inspect actual offers or production requests, with a clear unavailable state where no venue exists.
10. Contribute resources or work to a shared project and observe visible progress in the town.

Acceptance: these steps operate on consistent identities and items, survive reconnection where persistence is promised, and provide enjoyable feedback. A button linking to another app page is navigation, not completed integration.

## 3. Character, movement, combat, and interaction

Character identity includes body presentation, face, hairstyle, outfit, equipped tools, animation set, emotes, titles, companions, and creator attribution. Support feminine, masculine, and androgynous presentation without tying skills to appearance. Modular wardrobe requires common skeletons, sockets, clipping checks, preview poses, and device-scale readability.

Movement must include facing, idle/walk/run animation, collision, interaction reach, camera behavior, accessible focus, and reliable input release. Pointer navigation and direct movement should share the same world geometry. Server authority must eventually reject impossible speed, out-of-range actions, and conflicting location claims.

Adventure mechanics include sword attacks, bows/projectiles, bombs, grass/bush cutting, breakable objects, hearts/health, damage feedback, knockback where appropriate, equipment, tools, secrets, doors, terrain height, and contextual interactions. Every weapon needs timing, range, cooldown, collision, hit feedback, resource use, and network reconciliation. Artwork alone is insufficient. Bombs and destruction obey ownership and region rules; personal/shared homes are not arbitrarily griefable.

Cozy participation remains viable. Combat can occur in designated regions, encounters, dungeons, or opt-in events. The economy's depth does not require unwanted PvP losses.

Acceptance: swing hits at the right time and range; arrows collide predictably; bombs affect allowed targets; no input remains stuck after blur; mobile/controller actions invoke the same rules; no client can award itself loot.

## 4. Creatures, encounters, and capture

Provide an original creature taxonomy with biome, rarity, behavior, affinity, growth, habitat, discoverability, and visual identity. Encounters can be visible in the world, triggered by habitats, or occur during exploration. Capture/bond attempts require an actual eligible encounter, item or action cost, server-owned outcome, and a durable result.

Creature progression may include care, training, abilities, variants, evolution-like transformations, companionship, habitat decoration, and useful noncombat roles. Breeding and tradability require explicit supply rules before adoption. A species entry, a discovered individual, and an owned companion are different records.

Encounter presentation can retain the shared world or transition to a staged battle view. The character cannot duplicate rewards by abandoning/reopening the view. Public journals can show discoveries without exposing private inventory or location.

Acceptance: encounter → interaction → capture/failure → inventory/journal update → reconnect yields one consistent result. Original species and data schemas make bespoke art replacement straightforward.

## 5. Farming, composting, and production

Farming includes land, seeds, planting, maturation, harvesting, tending, tools, storage, recipes, crop variety, and useful social visits. Growth uses durable timestamps; empty parcels do not require constant real-time ticking. Accessibility and time zones should inform cadence rather than punishing ordinary absence.

Composting is an explicit recipe family that consumes eligible materials and returns specified nutrients, components, seeds, or catalysts. It can give duplicates and exhausted items productive uses. Crafting combines resources into tools, furniture, clothing, consumables, building materials, and advanced industrial components.

Progression runs from hand gathering to workshops, specialized buildings, logistics, regional infrastructure, and advanced industry. Each stage should introduce new decisions and dependencies rather than only longer timers or larger numbers.

Acceptance: costs and yields use integer quantities, simultaneous actions cannot overspend, retries return the original result, and ready times remain consistent across devices. Native resource recipes never silently mint an externally issued token.

## 6. RuneScape-like skills, gear, and progression

Candidate skills: cultivation, woodcutting, mining, fishing, cooking, crafting, smithing, construction, exploration, creature care, trade/logistics, and combat specializations. Final skill names and balance remain design choices. Skill experience is earned from validated actions; gear modifies explicitly documented capabilities, not arbitrary client multipliers.

Equipment includes slots, requirements, durability if justified, upgrade/repair recipes, appearance, and clear tool affordances. Long-lived progression should enable specialization and mastery while keeping newcomers economically useful. Avoid creating an inflationary treadmill that renders early regions and materials obsolete.

Acceptance: skill gains correspond to receipts; gear requirements are enforced by authority; appearance and gameplay stats are separate; recipe dependencies are inspectable; progression has meaningful playtests rather than invented leveling curves presented as final.

## 7. Housing, settlement, and civilization

One world supports several scales: avatar, household, neighborhood, region, civilization, and eventually off-world settlements. Town planning is a view over actual inhabited buildings and infrastructure, not an unrelated simulation with different inventories.

Housing supports furniture, paths, landscaping, rooms, displays, shops, workshops, and visitors. Communities can propose, fund, construct, maintain, and govern roads, irrigation, markets, storage, transport, utilities, and public spaces. Public works have requirements, contribution records, permissions, progress, and visible completion.

Regional resources and transportation create trade and specialization. Technology unlocks should follow shared accomplishments and production capability. Off-world expansion requires exploration, travel, new materials, settlements, and trade routes, with enough variety to justify distance. It is a later horizon, not a claim of an infinite universe today.

Events such as UFO arrivals can temporarily change presentation and permanently change world state where permitted: damage, salvage, unusual resources, reconstruction, or new discoveries. Visual debris is mostly local; economically consequential destruction is authoritative.

Acceptance: a contribution changes one project ledger; completed construction appears to all relevant players; planning and avatar views agree; permission changes prevent unauthorized edits; reconnects do not duplicate salvage.

## 8. PlankSpace accounts, posts, and social identity

Use the existing authenticated PlankSpace account as the canonical person. Wallets are linked credentials/assets, not necessarily separate people. Never create an unrelated identity system merely to render a character. Public handles can change without changing economic ownership IDs.

Profiles can expose homes, selected achievements, creations, public discoveries, reputation, and shops according to privacy settings. Posts can receive eligible charm expressions and carry links to world activity, creations, projects, or markets. Communities can own shared spaces with scoped roles.

Reactions must define whether they are free expressions, consumable items, transfers, or reputation signals. These are distinct semantics even when they share a charm identity. Prevent self-reaction loops from becoming unlimited value creation. Ranking formulas should distinguish appreciation, contribution, influence, and wealth rather than compress all of them into one karma number.

Account switching, sign-out, expired sessions, and reconnects must clear private views and invalidate pending authority. Existing wallet proofs/session verification are reused. Moderation, block lists, chat/report tools, and permissions apply across social and world surfaces.

Acceptance: one authenticated action has one actor and one receipt; private inventory never leaks to visitors; the same post stamp appears consistently on feed/profile/world references; account A cannot act with account B's stale state.

## 9. Charm/memoji universe

The registry is extensible and source-driven. It must not be capped at seven starter charms or the currently imported snapshot. The freshly parsed memoji source contains **78 denom identities**, including entries with empty emoji or pool fields. Earlier references to 77 described an incomplete count and are superseded.

Canonical external identity is chain plus denom/contract identifier. Names, Unicode representations, art, aliases, recipes, categories, pool references, and creator metadata are attributes. A registry entry can be discovered without having verified artwork, a live venue, an owned balance, or mint rights.

Discovery adapters should support catalog imports, creator-denom enumeration, chain indexing, pool inspection, metadata refresh, and reviewed submissions. Record source revision and observations. Unknown/retired/unavailable entries remain representable. Search supports names, emoji, identity, type, origin, progression, and market availability.

Acceptance: duplicate names do not merge different assets; missing emoji/pool data does not drop an identity; snapshot network is visible; no stale reference pool is presented as verified live liquidity.

## 10. Grained Exchange, global markets, and DeFi

The intended exchange combines the legibility of RuneScape's Grand Exchange, EVE-style industrial demand, and memoji/DeFi pool discovery. Users should understand what is being traded, the venue, quantity, cost, execution behavior, settlement status, and ownership consequence.

Native game orders require transactional escrow, matching policy, partial fills, cancellation, fees, expiry if used, and recoverable receipts. External token trading uses appropriate chain-specific quoting, signing, and confirmation adapters. AMMs and order books can coexist in the interface but retain different execution rules.

External assets can only be awarded through an explicit available issuance/reserve model. Distinguish a native resource, a backed redeemable claim, and a real token. Keep inventory available balances separate from escrow and pending transfers. Never infer balances from icons, reactions, or displayed prices.

Player businesses, cooperative funds, shares, or other stock-like instruments are a further design domain. They require explicit rights, issuance, redemption, voting/profit semantics, accounting, and venue rules. Collectibles are not automatically stocks. No production funds or contracts should be changed merely to demonstrate visual gameplay.

Acceptance: duplicate requests cannot double spend; canceled orders return only remaining escrow; chain reorganization/failed confirmation has defined handling; prices and precision come from verified asset metadata; fictional demo values are clearly separate from live balances.

## 11. Unified asset and creator pipeline

Pipeline stages: discover → acquire original bytes → record provenance/revision → hash and classify → inspect format/rig/animations/license metadata → convert → preview in target camera → validate budgets and compatibility → publish immutable content revision → retain source and rollback.

Every asset needs a stable ID, source hash, source revision, author/attribution where available, permission status, replacement status, source format, runtime format, preview, bounds, anchors/pivots, material conventions, collision role, and relevant animation/attachment metadata. Not every field is populated by the current initial index.

Import families include sprite sheets, tilesets, tilemaps, audio, models, rigs, animation clips, and editable authoring files. Map conversion needs tile semantics, collision, layers, transitions, objects, and scripts; copying a map file alone is not a working map import. Source code should be inspected directly where available. Decompilation projects help research, but do not automatically supply reusable complete games.

Creator levels: in-game decoration and patterns; structured items/quests/recipes/world chunks; advanced isolated mod worlds. Collaboration uses shared draft documents, version control and review; binary art uses versioned sources and practical locks. Publishing economic content has stronger validation than changing personal cosmetics.

The bespoke replacement program maps every reference asset to its intended original equivalent. Preserve silhouettes and functional roles while creating Charmville's coherent palette, materials, rigs, characters, and environments. No global replacement should break stable gameplay identities.

## 12. Technical foundation and authority

Baseline: existing Next/React shell, Three.js/R3F world, PostgreSQL durable domain services, and a dedicated authoritative realtime service when multiplayer is implemented. Colyseus is the researched candidate, not an installed/shared-world capability today. Preserve the current no-Redis architecture unless a specific scaling decision changes it.

Renderer-independent content and entity IDs connect social, gameplay, and economic domains. Define commands, validation, idempotency, transactions, and emitted events. Use interest-managed regions and controlled handoffs. High-frequency movement differs from crop schedules, manufacturing jobs, social activity, and chain confirmations; they should not all share one tick rate.

Measure asset load time, frame time, memory, GPU workload, nearby actors, server sessions, database contention, reconnect recovery, and mobile behavior. Optimize measured bottlenecks. Neither choosing a renderer nor adding multiplayer rooms establishes AAA quality or MMO scale.

## 13. Delivery and truthful progress

The testing route should remain easy to find and update during active development. Each meaningful increment needs a brief change log, a playable check, screenshots where useful, and explicit remaining limitations. Public availability requires a deployed, verified environment; a localhost link works only on the host machine while its server is running.

Current new implementation: `/charmville/frontier` introduces a 3D district preview, a 2.5D default camera, movement, sword sweeps/cuttable grass, device-local scenery placement, a UFO visual event, a searchable 78-identity testnet atlas, and a source-file creator catalog. These are not shared multiplayer, server-authoritative combat, capture, or functioning exchange settlement. The existing `/charmville/play` remains the account-aware garden test with its existing persistence path.

Initial ingestion now indexes **36,491 candidate files across 29 local source directories**. This includes preexisting reference collections and newly acquired Solarus MIT Starter and Trillium. Counts are file counts, not unique characters/items, approved assets, or integrated content. Files have hashes; a curated Kenney CC0 subset has downloadable previews. Per-file metadata in Trillium includes licenses different from a simple pack-wide summary, reinforcing why source tracking matters even during permitted prototyping.

The next acceptance milestones are: animated character and collision; connected gathering/crafting/planting loop; creature encounter/capture; identity-backed world state; first two-player shared district; post/charm consistency; escrowed native exchange; community publication; multi-region handoff; externally settled market adapters; civic progression; advanced events and exploration.

These milestones are sequencing, not a reduction of the vision. Completion requires the interconnected experience above, not merely a checklist of isolated screens.

## Latest correction: existing-game foundation first

The user rejected the frontier artwork. It is not an accepted visual baseline. The next build must start from mature authored adventure infrastructure and preserve its feel before extending farming, creatures, skills, social state and exchanges. See Charmville-Existing-Game-Foundation-Audit.md for the revised strategy. Newly acquired references include pokeemerald, Tuxemon, Zelda3, Graal Reborn GServer, Solarus Online and Mystery of Solarus DX. The refreshed file index contains 44,178 candidate assets; this is a source inventory, not integrated gameplay. Emerald's actual map graph contains 518 maps, 1,313 warp events and 2,776 object events. The current frontier has not been replaced by those engines yet.
