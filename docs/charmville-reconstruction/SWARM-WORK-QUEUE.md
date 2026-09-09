# Charmville implementation work queue

Complete row coverage is assignment coverage, not implementation completion. Maturity is copied from the evidence tracker and is not percent complete. Workers rotate through lanes; queued lanes are not running.

Capacity: one integration coordinator and three concurrent workers. Every progress-table row has a work item; explicit follow-up requirements are appended.

## Current assignments

- Native worker: source-ground anchors and path/warp visual verification.
- State worker: saved action intent verification and desktop/mobile performance baseline.
- Experience worker: saved garden access inside the game shell and fullscreen menu.
- Coordinator: cross-system test, evidence reconciliation, source preservation and next work dispatch.

## Dispatch order and integration gates

1. Finish and test the current roster/menu/native chain.
2. Rotate native work to tool contact and collision; state work to authoritative resource actions; experience work to input and layout defects.
3. Connect one resource action through animation, owned inventory, crafting consumption and exchange settlement.
4. Add authoritative encounter/capture, then combat commands and move bindings.
5. Extend authored homes/travel, production chains, social overlays and builder tools on the same state model.
6. Each lane must pass its evidence gates; performance and source fidelity are checked throughout. No assignment alone raises a maturity bar.

## authority

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-001 | Approved PlankSpace account entrance | queued | ███░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Existing session validation and saved garden; real wallet/device matrix still needed |
| CV-002 | One stable profile across game/social | queued | ███░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Account entrance now resolves canonical profile ID; native runtime still separate |
| CV-003 | Multiple wallets per profile | queued | █░░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Must add explicit proof-based account linking; not equivalent to wallet switching |
| CV-004 | OAuth and passkeys for same game identity | queued | █░░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Other auth namespace exists; safe linking not implemented |
| CV-005 | Durable account garden | queued | ████░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: PostgreSQL lifecycle, ownership, retries and races tested; existing small garden only |
| CV-006 | Native world persistent account progress | queued | █░░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Guest native counters must not be imported as authoritative rewards |
| CV-007 | Account-owned map instances | queued | ██░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Durable region admission now exists; native authored home maps still missing |
| CV-008 | Friend invitations / revoke / expiry | queued | ███░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Durable API and account garden controls; private native visits still missing |
| CV-009 | Help versus harvest/build/storage rights | queued | ███░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Durable garden tending checks grants transactionally; other native actions not connected |
| CV-010 | Player movement replication | queued | ███░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Local guest relay by scene; no authenticated authoritative movement |
| CV-011 | Shared resource replication | queued | █░░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Requires versioned entities and server action commits |
| CV-012 | Reconnect / crash recovery | queued | ██░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Garden durable; native world recovery missing |
| CV-013 | Party and region shard routing | queued | █░░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Keep party together, separate region capacity from economic identity |
| CV-014 | Abuse prevention | queued | ██░░░ | Authenticated state, permission, retry and reconnect checks with two isolated accounts. Current gap: Garden transactions and relay rate limits; movement/automation/encounter authority incomplete |

## world-actions

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-015 | Directional walk / native character sprites | queued | ███░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native quest playable; source-specific animation audit remains |
| CV-016 | Sword swipe / shield displacement | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native source behavior available; directional visual acceptance incomplete |
| CV-017 | Sword charge / spin | queued | ███░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Source quest equipment initialization; interruption and device verification needed |
| CV-018 | Bow / arrows / ammunition | queued | ███░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native bow fires; draw behavior varies by source and needs explicit binding |
| CV-019 | Bomb fuse / flash / blast | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native source behavior; interaction/collision matrix not fully verified |
| CV-020 | Shield blocking / knockback / damage | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Source systems; unified combat authority not wired |
| CV-021 | Lift / carry / throw pots and objects | queued | █░░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native lifting source located; correct held art and world identity integration missing |
| CV-022 | Cut grass / drops / collection | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Native reference; authenticated yield and respawn policy missing |
| CV-023 | Magic / fire / protection | queued | ███░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Sword tile-bank fix for broken casting implemented; full spell matrix incomplete |
| CV-024 | Transformations / sustained aura / energy wave | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Procedural aura exists; character transformation and wave not finished |
| CV-025 | Doors / interiors / puzzles / switches | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Source quest functionality; original shared-world content not authored |
| CV-026 | Dialogue / scripted introduction | queued | ███░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Small native farming intro; complete account-to-village storyline missing |
| CV-027 | Layering / canopy / foot sorting | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Local crop depth handling; general entity layering and collision incomplete |
| CV-028 | Source asset provenance and replacement pipeline | queued | ██░░░ | Four-facing visual playback, contact timing, collision, interruption and world-state acceptance. Current gap: Source vault/catalogue and validation prototypes; complete licensed distribution/replacement mapping missing |

## creatures

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-029 | Species and encounter tables | queued | ██░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Source catalogue resolves386 species and184 evolution rules; target habitats/rates not authored |
| CV-030 | Creatures visible in adventure world | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Needs world entities, directional art, pathing and spawn budgets |
| CV-031 | Real-time creature combat | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Shared damage/ownership authority and source animation adapters missing |
| CV-032 | Native-style turn battle | queued | ██░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Encounter domain prototype; no playable native battle integration |
| CV-033 | Hybrid HP/status continuity | queued | ██░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Domain transition tests; live world/turn handoff missing |
| CV-034 | Capture / ball consumption / ownership | queued | ██░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Idempotent domain capture; DB and live presentation missing |
| CV-035 | Followers and companion reactions | in progress | ███░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Six owned fixture members reach native path rendering; 18px spacing. Reactions, obstacle avoidance, mounts and shared replication remain missing |
| CV-036 | Party / storage / clinic | in progress | ██░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Normalized six-slot owned roster and UI verified; actual capture acquisition, clinic and storage gameplay remain missing |
| CV-037 | Moves / types / status durations | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Definitions and balancing missing; prototype only holds limited status names |
| CV-038 | Evolution / traits / breeding | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Time, food, habitat capacity and offspring issuance specified conceptually |
| CV-039 | Fishing / aquatic encounters | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Rod, line, bobber, bite, reel and catch required |
| CV-040 | Collections / discovery journal | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Emoji discovery exists separately; creature discovery not connected |
| CV-041 | Game Corner activities | queued | █░░░░ | Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions. Current gap: Separate amusement budget; game implementation and reward model absent |
| CV-099 | Six-member follower train and formations | in progress | not scored | Distinct owned UUIDs; six visible followers; corners/warps; spacing and ordering. Current gap: Explicit conversation requirement; do not infer completion from assignment. |
| CV-100 | Attack, defend, hold and free-roam commands | queued | not scored | Acknowledged server commands, valid target selection, no neutral aggression, recall and leash. Current gap: Explicit conversation requirement; do not infer completion from assignment. |
| CV-101 | Species-specific move animation and effects | queued | not scored | Source markers and anchors bound to defined move events; projectile/effect ownership and single hit. Current gap: Explicit conversation requirement; do not infer completion from assignment. |

## professions

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-042 | Till / sow / water | queued | ███░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Local native sequence and direction logic; server integration absent |
| CV-043 | Visible crop growth stages | queued | ███░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Indexed source berry art; growth and harvest tested locally |
| CV-044 | Fertilizer / bonus harvest | queued | ███░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Local one-use fertilizer loop verified; durable balancing absent |
| CV-045 | Orchards / seasons / weather | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Crop definitions, environmental clock and art sets required |
| CV-046 | Soil / irrigation / compost | queued | ██░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Limited garden compost exists; rich soil system not built |
| CV-047 | Livestock / feed / produce | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Species, care, habitat and limited production chains specified |
| CV-048 | Woodcutting / mining | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Tool loops, deposits, depletion and authority required |
| CV-049 | Cooking / smithing / carpentry / tailoring | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Recipe graph, station permissions, input escrow and outputs required |
| CV-050 | Alchemy / engineering / automation | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Bounded energy/material throughput, no offline infinite production |
| CV-051 | Skills / XP / unlocks | queued | ██░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Local farm counter; persistent multi-profession system absent |
| CV-052 | Equipment tiers / durability / modifiers | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Separate material, quality, traits and unique-instance identity |
| CV-053 | Home furnishings / construction | queued | ██░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Durable small scenery layout; native home building missing |
| CV-054 | Museum / collections / village relationships | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Authored content and persistent progression required |
| CV-055 | Companion labor / habitat utility | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Limited tasks and resource budgets; avoid currency generation by unattended loops |
| CV-056 | Combinatorial crafting and transmutation | queued | █░░░░ | Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights. Current gap: Input/output conservation, discoverable recipes and variant compatibility |
| CV-102 | Livestock intelligence and habitat assignment | queued | not scored | Care and grazing permissions, species capabilities, bounded produce and breeding receipts. Current gap: Explicit conversation requirement; do not infer completion from assignment. |

## world-travel

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-057 | Connected world geography | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Master specification; twelve proposed regions are not authored maps |
| CV-058 | Private/public border transitions | queued | ██░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Travel domain tests; native map bindings and authoritative host missing |
| CV-059 | Mounts / boats / warp towers | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Logical requirements only; boarding and travel gameplay absent |
| CV-060 | Guild settlements / businesses | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Ownership roles, contribution escrow and public contracts |
| CV-061 | Roads / harbors / industry | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Shared construction, maintenance and logistics graph |
| CV-062 | Resource transport / regional trade | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Cargo identity, routes, delivery receipts and supply demand |
| CV-063 | Ecology / disasters / world events | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Bounded reversible events and persistent consequences; no unannounced home destruction |
| CV-064 | Sky / orbital / planetary travel | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Planned expansion; renderer and streaming decision not proven |
| CV-065 | Modern 3D within top-down world | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Requires renderer prototype benchmarks and asset compatibility; not native current camera |
| CV-066 | Continuing endgame | queued | █░░░░ | Authored map route, border and instance transition, access rules, recovery and measured streaming. Current gap: Horizontal mastery, collections, public projects and authored expansions |

## economy

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-067 | Full Unicode discovery catalogue | queued | ████░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: 3,953 entries, searchable native overlay; discovery only |
| CV-068 | Custom memoji registry | queued | ██░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Historical registry reference; live completeness not verified |
| CV-069 | Family/species/quality/instance taxonomy | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Master specification; content definitions not exhaustively authored |
| CV-070 | Gameplay inventory versus Satchel | queued | ███░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Durable garden compartment projection; native unification missing |
| CV-071 | Finite Grain rewards | queued | ███░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Local migration and garden integration; conservation/retry/exhaustion checked in PostgreSQL |
| CV-072 | Commodity production budgets | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Currency reserve does not make every crop or creature scarce |
| CV-073 | Player trades / order book / escrow | queued | ███░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Fixed-price offers, escrow, partial fills and cancellation tested; automatic matching absent |
| CV-074 | Exchange prices / volume / supply feed | queued | ██░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Actual offers and aggregate Grain supply available; charts/volume feed missing |
| CV-075 | Liquidity pools / fees / slippage | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Simulated funded-reserve design only |
| CV-076 | Derivatives and trader analytics | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Later separately funded subsystem; no implemented game perps |
| CV-077 | Cash skins / season passes | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Commerce and entitlements not integrated |
| CV-078 | Purchased Grain without minting | queued | █░░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Existing-supply transfer requirement; no cash purchase flow |
| CV-079 | Crafting sinks / social consumption | queued | ██░░░ | Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement. Current gap: Existing stamp consumes charm; broad sinks not implemented |

## experience

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-080 | PlankSpace posts and charm stamps | queued | ███░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Existing account garden/social routes; native feed not embedded |
| CV-081 | In-game feed / Lumberyard / Pine browsing | queued | █░░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Same-origin account shell and input-isolated overlay required |
| CV-082 | In-game composing / reacting | queued | █░░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Needs existing authenticated APIs and explicit publication UX |
| CV-083 | Voice note recording / playback | queued | ████░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Local draft flow tested with synthetic mic; no actual user audio recorded |
| CV-084 | Audio attachment to post | queued | ███░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Existing composer upload/playback code; native publication not connected |
| CV-085 | Voice-to-text | queued | ██░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Optional browser recognition; browser/provider support varies |
| CV-086 | Proximity voice / party voice | queued | █░░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Server-authorized room membership and transport not built |
| CV-087 | Moderation / blocking / reporting | queued | ██░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Existing social moderation; native comms policy integration absent |
| CV-088 | Two-button menu and controller adapter | queued | ███░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Synthetic gamepad tests; physical-controller matrix pending |
| CV-089 | Mobile zoom / fullscreen / pixel scale | queued | ███░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Local browser verification; broad hardware coverage pending |
| CV-090 | Large seamless camera | queued | █░░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Current native viewport fixed; fullscreen is scaling, not a larger world view |
| CV-091 | Accessibility / remapping / subtitles | queued | ██░░░ | Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication. Current gap: Partial controls and labels; full accessibility testing absent |
| CV-103 | Nintendo-quality Charmdex interaction pass | queued | not scored | Consistent hierarchy, belt selection, meaningful feedback, input parity and visual review of every state. Current gap: Explicit conversation requirement; do not infer completion from assignment. |

## delivery

| Work | Feature | Status | Existing maturity | Required evidence |
|---|---|---|---|---|
| CV-092 | Community content contract | queued | ██░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Pack validation prototype; editor and publishing pipeline absent |
| CV-093 | Collaborative map/art editor | queued | █░░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Versioned assets, review, rollback and bounded scripting required |
| CV-094 | Animated action conformance suite | queued | ██░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Several local regression scripts; full directional/action matrix absent |
| CV-095 | Economy concurrency testing | queued | ███░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Durable garden tested; future trades/encounters require their own races |
| CV-096 | Performance budgets / low-end fallback | queued | █░░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Proposed targets only; benchmark device set not measured |
| CV-097 | Remote friends-playable release | queued | █░░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Current links are localhost; no authenticated MMO deployment |
| CV-098 | Full source-to-bespoke replacement coverage | queued | █░░░░ | Reproducible validation, documented evidence, rollback and measured target-device performance. Current gap: Provenance exists for subsets; replacement catalogue incomplete |
| CV-104 | All-source art replacement and provenance completeness | queued | not scored | Each used asset has source, hash, attribution, runtime role, replacement status and verified dimensions. Current gap: Explicit conversation requirement; do not infer completion from assignment. |
| CV-105 | Browser desktop/mobile GPU and memory budgets | queued | not scored | Measure startup, frame time, memory and input latency; record device/browser and fallback. Current gap: Explicit conversation requirement; do not infer completion from assignment. |
| CV-106 | Account-transition recovery and GitHub handoff | queued | not scored | Committed sources, reproducible setup and zero-context handoff with current blockers. Current gap: Explicit conversation requirement; do not infer completion from assignment. |
