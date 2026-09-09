# Charmville feature map and evidence tracker

Snapshot: 2026-09-09. Names are placeholders. This tracks the requested synthesis, not a claim to inventory every mechanic in every edition of every source game. No feature is certified production-ready. Bars show integration maturity, not percent complete, effort remaining or artistic quality. Separate source games working on their own do not count as a unified MMORPG.

Legend: `░░░░░` not built; `█░░░░` specified; `██░░░` isolated implementation/reference; `███░░` connected locally; `████░` verified end-to-end in the stated scope; `█████` release quality demonstrated. A row must meet every earlier gate to advance. Source fidelity, multiplayer and performance still need separate acceptance evidence.

## Shared foundation

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Approved PlankSpace account entrance | ███░░ | Existing session validation and saved garden; real wallet/device matrix still needed |
| One stable profile across game/social | ███░░ | Account entrance now resolves canonical profile ID; native runtime still separate |
| Multiple wallets per profile | █░░░░ | Must add explicit proof-based account linking; not equivalent to wallet switching |
| OAuth and passkeys for same game identity | █░░░░ | Other auth namespace exists; safe linking not implemented |
| Durable account garden | ████░ | PostgreSQL lifecycle, ownership, retries and races tested; existing small garden only |
| Native world persistent account progress | █░░░░ | Guest native counters must not be imported as authoritative rewards |
| Account-owned map instances | ██░░░ | Durable region admission now exists; native authored home maps still missing |
| Friend invitations / revoke / expiry | ███░░ | Durable API and account garden controls; private native visits still missing |
| Help versus harvest/build/storage rights | ███░░ | Durable garden tending checks grants transactionally; other native actions not connected |
| Player movement replication | ███░░ | Local guest relay by scene; no authenticated authoritative movement |
| Shared resource replication | █░░░░ | Requires versioned entities and server action commits |
| Reconnect / crash recovery | ██░░░ | Garden durable; native world recovery missing |
| Party and region shard routing | █░░░░ | Keep party together, separate region capacity from economic identity |
| Abuse prevention | ██░░░ | Garden transactions and relay rate limits; movement/automation/encounter authority incomplete |

## Zelda / Graal adventure and presentation

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Directional walk / native character sprites | ███░░ | Native quest playable; source-specific animation audit remains |
| Sword swipe / shield displacement | ██░░░ | Native source behavior available; directional visual acceptance incomplete |
| Sword charge / spin | ███░░ | Source quest equipment initialization; interruption and device verification needed |
| Bow / arrows / ammunition | ███░░ | Native bow fires; draw behavior varies by source and needs explicit binding |
| Bomb fuse / flash / blast | ██░░░ | Native source behavior; interaction/collision matrix not fully verified |
| Shield blocking / knockback / damage | ██░░░ | Source systems; unified combat authority not wired |
| Lift / carry / throw pots and objects | █░░░░ | Native lifting source located; correct held art and world identity integration missing |
| Cut grass / drops / collection | ██░░░ | Native reference; authenticated yield and respawn policy missing |
| Magic / fire / protection | ███░░ | Sword tile-bank fix for broken casting implemented; full spell matrix incomplete |
| Transformations / sustained aura / energy wave | ██░░░ | Procedural aura exists; character transformation and wave not finished |
| Doors / interiors / puzzles / switches | ██░░░ | Source quest functionality; original shared-world content not authored |
| Dialogue / scripted introduction | ███░░ | Small native farming intro; complete account-to-village storyline missing |
| Layering / canopy / foot sorting | ██░░░ | Local crop depth handling; general entity layering and collision incomplete |
| Source asset provenance and replacement pipeline | ██░░░ | Source vault/catalogue and validation prototypes; complete licensed distribution/replacement mapping missing |

## Pokémon / companion systems

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Species and encounter tables | ██░░░ | Source catalogue resolves386 species and184 evolution rules; target habitats/rates not authored |
| Creatures visible in adventure world | █░░░░ | Needs world entities, directional art, pathing and spawn budgets |
| Real-time creature combat | █░░░░ | Shared damage/ownership authority and source animation adapters missing |
| Native-style turn battle | ██░░░ | Encounter domain prototype; no playable native battle integration |
| Hybrid HP/status continuity | ██░░░ | Domain transition tests; live world/turn handoff missing |
| Capture / ball consumption / ownership | ██░░░ | Idempotent domain capture; DB and live presentation missing |
| Followers and companion reactions | █░░░░ | Path following, doors, mounts and disconnect behavior required |
| Party / storage / clinic | ██░░░ | One persistent account-bound starter implemented; party slots, clinic and storage gameplay missing |
| Moves / types / status durations | █░░░░ | Definitions and balancing missing; prototype only holds limited status names |
| Evolution / traits / breeding | █░░░░ | Time, food, habitat capacity and offspring issuance specified conceptually |
| Fishing / aquatic encounters | █░░░░ | Rod, line, bobber, bite, reel and catch required |
| Collections / discovery journal | █░░░░ | Emoji discovery exists separately; creature discovery not connected |
| Game Corner activities | █░░░░ | Separate amusement budget; game implementation and reward model absent |

## RuneScape / FarmVille / Stardew / Animal Crossing / Palworld / Minecraft

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Till / sow / water | ███░░ | Local native sequence and direction logic; server integration absent |
| Visible crop growth stages | ███░░ | Indexed source berry art; growth and harvest tested locally |
| Fertilizer / bonus harvest | ███░░ | Local one-use fertilizer loop verified; durable balancing absent |
| Orchards / seasons / weather | █░░░░ | Crop definitions, environmental clock and art sets required |
| Soil / irrigation / compost | ██░░░ | Limited garden compost exists; rich soil system not built |
| Livestock / feed / produce | █░░░░ | Species, care, habitat and limited production chains specified |
| Woodcutting / mining | █░░░░ | Tool loops, deposits, depletion and authority required |
| Cooking / smithing / carpentry / tailoring | █░░░░ | Recipe graph, station permissions, input escrow and outputs required |
| Alchemy / engineering / automation | █░░░░ | Bounded energy/material throughput, no offline infinite production |
| Skills / XP / unlocks | ██░░░ | Local farm counter; persistent multi-profession system absent |
| Equipment tiers / durability / modifiers | █░░░░ | Separate material, quality, traits and unique-instance identity |
| Home furnishings / construction | ██░░░ | Durable small scenery layout; native home building missing |
| Museum / collections / village relationships | █░░░░ | Authored content and persistent progression required |
| Companion labor / habitat utility | █░░░░ | Limited tasks and resource budgets; avoid currency generation by unattended loops |
| Combinatorial crafting and transmutation | █░░░░ | Input/output conservation, discoverable recipes and variant compatibility |

## SimCity / Age of Empires / EVE / No Man's Sky world scale

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Connected world geography | █░░░░ | Master specification; twelve proposed regions are not authored maps |
| Private/public border transitions | ██░░░ | Travel domain tests; native map bindings and authoritative host missing |
| Mounts / boats / warp towers | █░░░░ | Logical requirements only; boarding and travel gameplay absent |
| Guild settlements / businesses | █░░░░ | Ownership roles, contribution escrow and public contracts |
| Roads / harbors / industry | █░░░░ | Shared construction, maintenance and logistics graph |
| Resource transport / regional trade | █░░░░ | Cargo identity, routes, delivery receipts and supply demand |
| Ecology / disasters / world events | █░░░░ | Bounded reversible events and persistent consequences; no unannounced home destruction |
| Sky / orbital / planetary travel | █░░░░ | Planned expansion; renderer and streaming decision not proven |
| Modern 3D within top-down world | █░░░░ | Requires renderer prototype benchmarks and asset compatibility; not native current camera |
| Continuing endgame | █░░░░ | Horizontal mastery, collections, public projects and authored expansions |

## Charms / Grained Exchange / social economy

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Full Unicode discovery catalogue | ████░ | 3,953 entries, searchable native overlay; discovery only |
| Custom memoji registry | ██░░░ | Historical registry reference; live completeness not verified |
| Family/species/quality/instance taxonomy | █░░░░ | Master specification; content definitions not exhaustively authored |
| Gameplay inventory versus Satchel | ███░░ | Durable garden compartment projection; native unification missing |
| Finite Grain rewards | ███░░ | Local migration and garden integration; conservation/retry/exhaustion checked in PostgreSQL |
| Commodity production budgets | █░░░░ | Currency reserve does not make every crop or creature scarce |
| Player trades / order book / escrow | ███░░ | Fixed-price offers, escrow, partial fills and cancellation tested; automatic matching absent |
| Exchange prices / volume / supply feed | ██░░░ | Actual offers and aggregate Grain supply available; charts/volume feed missing |
| Liquidity pools / fees / slippage | █░░░░ | Simulated funded-reserve design only |
| Derivatives and trader analytics | █░░░░ | Later separately funded subsystem; no implemented game perps |
| Cash skins / season passes | █░░░░ | Commerce and entitlements not integrated |
| Purchased Grain without minting | █░░░░ | Existing-supply transfer requirement; no cash purchase flow |
| Crafting sinks / social consumption | ██░░░ | Existing stamp consumes charm; broad sinks not implemented |

## Communications, social and player controls

| Feature | Progress | Evidence / next integration |
|---|---|---|
| PlankSpace posts and charm stamps | ███░░ | Existing account garden/social routes; native feed not embedded |
| In-game feed / Lumberyard / Pine browsing | █░░░░ | Same-origin account shell and input-isolated overlay required |
| In-game composing / reacting | █░░░░ | Needs existing authenticated APIs and explicit publication UX |
| Voice note recording / playback | ████░ | Local draft flow tested with synthetic mic; no actual user audio recorded |
| Audio attachment to post | ███░░ | Existing composer upload/playback code; native publication not connected |
| Voice-to-text | ██░░░ | Optional browser recognition; browser/provider support varies |
| Proximity voice / party voice | █░░░░ | Server-authorized room membership and transport not built |
| Moderation / blocking / reporting | ██░░░ | Existing social moderation; native comms policy integration absent |
| Two-button menu and controller adapter | ███░░ | Synthetic gamepad tests; physical-controller matrix pending |
| Mobile zoom / fullscreen / pixel scale | ███░░ | Local browser verification; broad hardware coverage pending |
| Large seamless camera | █░░░░ | Current native viewport fixed; fullscreen is scaling, not a larger world view |
| Accessibility / remapping / subtitles | ██░░░ | Partial controls and labels; full accessibility testing absent |

## Builder, quality and delivery

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Community content contract | ██░░░ | Pack validation prototype; editor and publishing pipeline absent |
| Collaborative map/art editor | █░░░░ | Versioned assets, review, rollback and bounded scripting required |
| Animated action conformance suite | ██░░░ | Several local regression scripts; full directional/action matrix absent |
| Economy concurrency testing | ███░░ | Durable garden tested; future trades/encounters require their own races |
| Performance budgets / low-end fallback | █░░░░ | Proposed targets only; benchmark device set not measured |
| Remote friends-playable release | █░░░░ | Current links are localhost; no authenticated MMO deployment |
| Full source-to-bespoke replacement coverage | █░░░░ | Provenance exists for subsets; replacement catalogue incomplete |

## Active work and next gate

Implemented this pass: durable access API and owner controls; canonical account endpoint/client connected to the entrance; native tool sprite palette correction; finite Grain reserve and garden permission enforcement. Account and native worlds remain separate. Production build, TypeScript, main lint, application tests and local migration/storage checks pass. Browser invitation verification is tracked separately below rather than inferred from unit tests.

Browser verification passed: synthetic approved account restores, claims, harvests and persists after reload; owner saves a seven-day help invitation, visitor sees it, owner revokes it and reload retains revocation. Native crop/fertilizer regression also passes after indexed tool-art compilation. These checks do not demonstrate private native homesteads or creature gameplay. Application suite: 1,337 passed, 48 skipped; additional focused account, permission, travel and asset compiler checks passed. Skipped coverage is not counted as verified.

The next meaningful shared-game gate is two authenticated profiles entering separate homes, authorized visits, an animated server-committed resource action, reconnect persistence and no duplicate reward. The following gate adds one captured follower, a consumed-input recipe and an escrowed trade. Communication overlays must operate on the same profile without leaking tokens or submitting posts automatically.

Further implementation: `/charmville/world` now combines real account region membership, peer lists, inventory and trade controls with an isolated native reference camera. Two-account region visitation and escrow trades pass browser tests, including lost-response retry. This completes account-shell integration, not native map/action integration. Source watering playback no longer uses blank columns; all eight hoe frames are used. Starter companion ownership is implemented; capturing/following is not.

Latest verification: 1,344 application tests passed, 48 skipped. Starter selection with an original Emerald portrait survives reload with the same creature ID. Embedded voice recording/playback/download/discard and modal close cleanup pass using synthetic audio; real user audio was not accessed. Native startup loads191 original MIDI instruments without missing-patch errors, at a35.4MB startup cost. Fullscreen and390px mobile overflow checks pass. These are local checks, not a claim of broad device performance or finished source-fidelity animation.

Evidence roots: `lib/charmville`, `test/market/charmville-*`, `scripts/charmville/*test.mjs`, native verification scripts and `docs/charmville-reconstruction`. Tests for pure modules do not prove live gameplay. Update this document after integration, not on agent assignment or optimistic estimates.

## 2026-09-09 menu visibility update

The world shell now keeps Play, Inventory, Companions, Exchange and Friends above the camera, with direct Charmdex and Voice shortcuts. Browser checks cover 600px and 390px layouts, keyboard tab navigation, retained form state and a delayed-frame shortcut race. Native equipment remains separate; a complete rotating unified equipment menu is not yet implemented. Soil and menu source findings and the target integration contract are in `SOIL-AND-INVENTORY-RESEARCH.md`.

## 2026-09-09 in-game menu access

A prominent Game menus button now appears inside the native player and its fullscreen toolbar. It returns to account Inventory and focuses the navigation; direct `?panel=companions` and other allowlisted panel links work. Browser verification covers embedded fullscreen, a narrow viewport, standalone navigation and rejection of messages from the wrong origin or window. This fixes access to the existing panels, not the still-unbuilt unified equipment system.
