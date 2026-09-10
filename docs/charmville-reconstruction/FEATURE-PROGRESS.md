# Charmville feature map and evidence tracker

Snapshot: 2026-09-09. Names are placeholders. This tracks the requested synthesis, not a claim to inventory every mechanic in every edition of every source game. No feature is certified production-ready. Bars show integration maturity, not percent complete, effort remaining or artistic quality. Separate source games working on their own do not count as a unified MMORPG.

Legend: `░░░░░` not built; `█░░░░` specified; `██░░░` isolated implementation/reference; `███░░` connected locally; `████░` verified end-to-end in the stated scope; `█████` release quality demonstrated. A row must meet every earlier gate to advance. Source fidelity, multiplayer and performance still need separate acceptance evidence.

## Shared foundation

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Approved PlankSpace account entrance | ███░░ | Existing session validation and account shell; real wallet/device matrix still needed |
| One stable profile across game/social | ███░░ | Account entrance now resolves canonical profile ID; native runtime still separate |
| Multiple wallets per profile | █░░░░ | Must add explicit proof-based account linking; not equivalent to wallet switching |
| OAuth and passkeys for same game identity | █░░░░ | Other auth namespace exists; safe linking not implemented |
| Preserved legacy garden storage (retired UI) | ████░ | Legacy PostgreSQL lifecycle, ownership, retries and races tested; standalone UI retired, not unified gameplay |
| Native world persistent account progress | ███░░ | Authenticated movement, bounded peers and Oran till/plant/water/harvest saved locally; combat and warps missing. See NATIVE-ECONOMIC-LOOP.md |
| Account-owned map instances | ██░░░ | Private account region and three-bed resource authority exist; distinct authored home geography and native routing remain missing |
| Friend invitations / revoke / expiry | ███░░ | Invitation API and private resource revoke checks verified; playable native home-to-home visits remain missing |
| Help versus harvest/build/storage rights | ███░░ | Durable garden tending checks grants transactionally; other native actions not connected |
| Player movement replication | ███░░ | Seven native 8px steps persisted to same authenticated actor with no rejection corrections; two authenticated accounts project stored actors into native view; fixed pose, two-second poll, no interpolation/hit collisions |
| Shared resource replication | ███░░ | Two authenticated native clients in one granted home render Oran stages 0→1→2→3→4→1; owner-only yield and unchanged visitor balances verified. One crop/map; permission-aware native prompts verified; remote tool animations remain missing. See NATIVE-RESOURCE-REPLICATION.md. |
| Reconnect / crash recovery | ██░░░ | Native actor reconnect and Oran inventory reload verified; interrupted action/full world crash recovery remains incomplete |
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
| Species and encounter tables | ██░░░ | Source catalogue resolves386 species and184 evolution rules; one persisted Poochyena inspection anchor exists, wider habitats/rates not authored |
| Creatures visible in adventure world | ███░░ | Six owned test species and one authoritative wild Poochyena render locally with source art; general habitat spawning, remote companion replication and pathfinding remain missing |
| Real-time creature combat | █░░░░ | Shared damage/ownership authority and source animation adapters missing |
| Native-style turn battle | ███░░ | Source-backed starter Pound/Scratch/Tackle versus wild Tackle; HP/PP and replay verified; full engine, statuses and attack animation missing |
| Hybrid HP/status continuity | ██░░░ | Domain transition tests; live world/turn handoff missing |
| Capture / ball consumption / ownership | ███░░ | Finite sandbox balls, shared world/turn capture calculation, conserved ownership transfer and replay tested. Source ball playback and authorized nearby spectator projection verified; broader ball types, statuses and full visual acceptance remain incomplete |
| Followers and companion reactions | ███░░ | Six distinct test species, individual persisted walking selection, stationary spawn anchors and compressed source-size presentation verified. Reversals, reactions, obstacle avoidance and shared creature replication remain incomplete |
| Party / storage / clinic | ███░░ | Six-slot owned roster, individual following, source size/type/HP summaries, Oran care and server-timed home HP/PP recovery connected. Full clinic and storage gameplay remain missing |
| Moves / types / status durations | █░░░░ | 354 source move definitions catalogued; three basic moves integrated, full effects/status behavior missing |
| Evolution / traits / breeding | █░░░░ | Time, food, habitat capacity and offspring issuance specified conceptually |
| Fishing / aquatic encounters | █░░░░ | Rod, line, bobber, bite, reel and catch required |
| Collections / discovery journal | █░░░░ | Emoji discovery exists separately; creature discovery not connected |
| Game Corner activities | █░░░░ | Separate amusement budget; game implementation and reward model absent |

## RuneScape / FarmVille / Stardew / Animal Crossing / Palworld / Minecraft

| Feature | Progress | Evidence / next integration |
|---|---|---|
| Till / sow / water | ███░░ | Three native private beds now settle Oran till/plant/water/harvest through server authority; broader crop/tool matrix missing |
| Visible crop growth stages | ███░░ | Indexed source berry art; Oran 30-second server growth and harvested inventory/reload verified; full visual matrix missing |
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
| Private/public border transitions | ██░░░ | Admission/travel invalidation tests exist; playable private/public native border warps remain missing |
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
| Gameplay inventory versus Satchel | ███░░ | Oran native produce and returned seed reach account inventory; unified equipment and wider items missing |
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
| Economy concurrency testing | ███░░ | Oran harvest, duplicate commits, permission revocation and exchange escrow/cancel tested; combat/capture races absent |
| Performance budgets / low-end fallback | █░░░░ | Proposed targets only; benchmark device set not measured |
| Remote friends-playable release | █░░░░ | Current links are localhost; no authenticated MMO deployment |
| Full source-to-bespoke replacement coverage | █░░░░ | Provenance exists for subsets; replacement catalogue incomplete |

## Active work and next gate

Implemented this pass: durable access API and owner controls; canonical account endpoint/client connected to the entrance; native tool sprite palette correction; finite Grain reserve and garden permission enforcement. Account and native worlds remain separate. Production build, TypeScript, main lint, application tests and local migration/storage checks pass. Browser invitation verification is tracked separately below rather than inferred from unit tests.

Browser verification passed: synthetic approved account restores, claims, harvests and persists after reload; owner saves a seven-day help invitation, visitor sees it, owner revokes it and reload retains revocation. Native crop/fertilizer regression also passes after indexed tool-art compilation. These checks do not demonstrate private native homesteads or creature gameplay. Application suite: 1,337 passed, 48 skipped; additional focused account, permission, travel and asset compiler checks passed. Skipped coverage is not counted as verified.

The next meaningful shared-game gate is two authenticated profiles entering separate homes, authorized visits, an animated server-committed resource action, reconnect persistence and no duplicate reward. The following gate adds one captured follower, a consumed-input recipe and an escrowed trade. Communication overlays must operate on the same profile without leaking tokens or submitting posts automatically.

Further implementation: `/charmville/world` now combines real account region membership, peer lists, inventory and trade controls with an isolated native reference camera. Two-account region visitation and escrow trades pass browser tests, including lost-response retry. This completes account-shell integration, not native map/action integration. Source watering playback no longer uses blank columns; all eight hoe frames are used. Starter companion ownership and local following are implemented; capture and shared creature simulation are not.

Latest verification: 1,344 application tests passed, 48 skipped. Starter selection with an original Emerald portrait survives reload with the same creature ID. Embedded voice recording/playback/download/discard and modal close cleanup pass using synthetic audio; real user audio was not accessed. Native startup loads191 original MIDI instruments without missing-patch errors, at a35.4MB startup cost. Fullscreen and390px mobile overflow checks pass. These are local checks, not a claim of broad device performance or finished source-fidelity animation.

Evidence roots: `lib/charmville`, `test/market/charmville-*`, `scripts/charmville/*test.mjs`, native verification scripts and `docs/charmville-reconstruction`. Tests for pure modules do not prove live gameplay. Update this document after integration, not on agent assignment or optimistic estimates.

## 2026-09-09 menu visibility update

The world shell now keeps Play, Inventory, Companions, Exchange and Friends above the camera, with direct Charmdex and Voice shortcuts. Browser checks cover 600px and 390px layouts, keyboard tab navigation, retained form state and a delayed-frame shortcut race. Native equipment remains separate; a complete rotating unified equipment menu is not yet implemented. Soil and menu source findings and the target integration contract are in `SOIL-AND-INVENTORY-RESEARCH.md`.

## 2026-09-09 in-game menu access

A prominent Game menus button now appears inside the native player and its fullscreen toolbar. It returns to account Inventory and focuses the navigation; direct `?panel=companions` and other allowlisted panel links work. Browser verification covers embedded fullscreen, a narrow viewport, standalone navigation and rejection of messages from the wrong origin or window. This fixes access to the existing panels, not the still-unbuilt unified equipment system.

## 2026-09-09 party and Enter menu

The account party now displays the owned starter in a six-slot belt and persists a follow/return preference. All three starter account-to-native follow/return checks passed with visible source walking sprites. Enter opens Party, Gear, Inventory, Charmdex, Exchange, Friends and Voice notes. Corrected the native indexed PNG exporter: tRNS metadata had caused incompatible RGBA decoding and distorted artwork. Native sprite export now retains indexed pixels and index-zero masking; original assets remain intact. This is local follower presentation, not shared creature simulation, capture, battle or a completed skill system. See `PARTY-AND-UNIFIED-MENU.md` and `NATIVE-STARTER-FOLLOWERS.md`.

## 2026-09-09 six-slot integration and swarm coverage

Six distinct database fixture creatures now pass through the authenticated roster API, account menu, native follower rendering and recall. This verifies roster-to-renderer integration, not capture gameplay: five extra fixture records were inserted only for an isolated synthetic test account. Original user accounts were not granted creatures. Migration112 preserves the starter UUID, prevents duplicate starter entitlement and supports explicit roster clearing. The native train has18px arc-length spacing; path reversals can still bunch sprites and obstacle-aware formation is not implemented.

The source pipeline preserves107 animation entries (102 physical sets,314 source files including existing metadata) for Treecko, Torchic and Mudkip. These are animation assets, not107 implemented moves. Pure command-policy tests cover ownership, target validity and bounded livestock intent; live combat AI remains unconnected.

`SWARM-WORK-QUEUE.md` and its JSON sibling map every progress-table row plus explicit subsequent requirements into generated work items across eight lanes. Three workers run concurrently with a coordinator; queued items are not active work or completion evidence.

## Retired standalone garden UI and current integration boundary

The temporary Garden/Home management tab and native menu destination have been removed at the user's direction. Old `?panel=garden` links return to Play. The saved Porch's separate page/gameplay presentation is retired; its PostgreSQL records and conservation/retry tests remain preserved infrastructure. Earlier garden browser checks demonstrate that legacy subsystem only and must not be counted as the unified MMORPG experience. Do not restore it as a player-facing workaround for native authority.

The primary experience is the native adventure with account Party, Inventory, Exchange, Friends, Charmdex and voice access. Native tool contacts are observable through a bounded outbox, but an observation is not a server-authorized action or saved reward. Client counters, native five-second growth and local contact messages must never be imported as earned account goods.

The next dependency sequence is trusted authored geometry, authenticated server-owned movement, authorized timed actions with atomic receipts, shared world event replication, then durable item production and exchange consumption. Private homes and border travel require authored map identities and admission that agree with server coordinates. Reconnect must reconcile committed receipts and cannot replay rewards. Companion following currently projects owned roster entries locally; capture, battle transitions and shared AI remain separate missing gates.

Required acceptance: two isolated accounts observe the same resource change; a revoked visitor cannot commit; interruption and stale geometry/revision fail safely; dropped responses return the original receipt; inventory and exchange show the exact conserved result; native action animation and world appearance follow the authoritative result. No standalone garden is an acceptable substitute.

## Source grounding and measured performance

Follower feet now use the preserved source ground markers rather than generic sprite-center offsets. All112 marker checks and a six-follower runtime check pass. Route reversals can still overlap, and shared creature collision/AI is not implemented.

`PERF-BASELINE.md` records a reproducible desktop-Chromium baseline at two viewport sizes and its limits. Browser rAF cadence is not engineFPS and a narrow viewport is not a physical mobile device.

## Authenticated native movement evidence

The native-to-account movement browser test now passes: seven 8px steps persisted for the same profile, with one initial spawn placement and zero rejection corrections. Actor tests cover two identities, replay, reconnect, expiry and travel invalidation; bounded 20ms jitter checks pass. This advances persistent native movement to locally connected scope only. At this movement checkpoint resource settlement was not yet connected; the later Oran loop below supersedes that gap. Combat and native warps remain missing. See [NATIVE-ACCOUNT-MOVEMENT.md](NATIVE-ACCOUNT-MOVEMENT.md) for exact geometry and evidence paths.

## Two-account peer visibility evidence

The expanded native account movement browser check verifies Bob's persisted actor in Alice's native view, including mode 1 and matching coordinates; screenshot review passed. Peers are limited to 16 approved active same-region/same-geometry actors. This is fixed-standing-pose projection on a two-second poll, without interpolation, movement animation or hit collisions. Maturity remains locally connected. Subsequent Oran resource settlement is documented below; movement/peer presence alone never implies an earned reward.

## Native Oran economic loop evidence

Actual browser verification now completes private-account till, plant, water, 30-second server growth and harvest across the three-bed native resource surface. One Oran produce and a returned seed appear in the same account inventory and survive reload (checked balance: three seeds, one produce). PostgreSQL tests cover harvest-to-exchange escrow, cancel return, private permission revocation and duplicate commit. Four resource-client and four bridge tests pass. See [NATIVE-ECONOMIC-LOOP.md](NATIVE-ECONOMIC-LOOP.md).

Farming bars remain locally connected: the full animation/facing/interruption matrix and broad resource content are not complete. Next blockers are authoritative weapons/encounters, additional resource definitions and supply policies, and unified owned equipment UI. No combat, capture, PvP or global crop catalogue is claimed.

## Companion health and Oran evidence

The source catalogue covers 386 species. Owned companion health uses source HP at level 5 with a server-generated persisted HP IV and HP EV 0. Oran consumes one item to restore up to 10 HP; new companions begin at full health. Real healthy-account UI, synthetic injured/lost-response presentation, and PostgreSQL transaction tests are distinguished in [COMPANION-HEALTH-AND-ORAN.md](COMPANION-HEALTH-AND-ORAN.md). No damage or combat API, fake user injury, clinic or capture is claimed. Existing maturity bars remain unchanged because the broader party/storage/clinic scope is incomplete. Native peer-facing fixes are not included in this evidence.

## Authenticated encounter inspection

A nearby Play panel now shows the original Poochyena portrait and server-owned level/HP for one authored regional encounter. Actual browser verification passes claim, Inspect, Return to world and release with persisted controller/mode, keyboard activation and narrow-screen review. Inspect is a lifecycle mode only: no attack, capture, damage, reward or playable battle is claimed. Combat bars remain unchanged. See [ENCOUNTER-LIFECYCLE.md](ENCOUNTER-LIFECYCLE.md).

## Bounded source battle turn evidence

The actual battle service and contextual UI now execute supported starter Pound/Scratch/Tackle turns against wild Tackle. HP/PP persist, and a real lost-response browser test verifies one turn/PP debit with exact receipt replay; Party health refreshes automatically from the authoritative API. Source portraits and readable damage/miss/critical results are present. The turn-battle row advances only to locally connected; native real-time combat, full effects, attack animations, capture, rewards and PvP are not claimed. See [SOURCE-BATTLE-TURNS.md](SOURCE-BATTLE-TURNS.md).

## Companion home recovery

The actual battle-to-home-rest browser loop restores HP and supported move PP after 10 server-timed seconds, preserving IV and maxHP. Explicit Finish/Cancel and retry controls use the real service. Database checks cover interruption and duplicate completion. This is bounded home recovery, not a complete clinic world or storage system; bars remain unchanged. See [COMPANION-REST.md](COMPANION-REST.md).

## Accessible six-member test party

The local interface loads six distinct persistent companions through a trusted-marker server action. Unmarked accounts open a separate test profile; actual browser checks verify the switch, reload and unchanged original account. All six account IDs reach native follow projection with Close/Relaxed trail spacing, and selected Pikachu battle switching is verified. This is a local test entitlement, not capture/XP/raid rewards or production issuance. Close/reversal overlap remains; maturity bars do not advance. See [SIX-MEMBER-TEST-PARTY.md](SIX-MEMBER-TEST-PARTY.md).

## Shared battle scene evidence

Two actual authorized accounts now observe identical encounter HP and committed events with real nearby Fighting/Watching labels and source portraits. Spectators receive no battle controls. Hit feedback is tied to new committed target events; it is not source attack animation. The watcher native adapter consumes matching HP/effect state and displays Poochyena while the viewport remains mounted. See [SHARED-BATTLE-SCENE.md](SHARED-BATTLE-SCENE.md). Full moves/AI/capture/rewards and broad spectator performance remain incomplete; bars are unchanged.

## Consented cooperative assist evidence

A controller can invite one nearby approved player for one companion move. Actual two-account browser verification covers invitation, helper-owned move and PP, shared enemy HP, retaliation against the helper, unchanged controller and consumed access. PostgreSQL checks cover duplicate action/invitation, expiry, private access revocation and invalidation on battle transitions. This extends shared combat beyond spectators without claiming simultaneous party AI, raids, capture or rewards. Native source animation integration is tracked separately and must pass playback verification before its evidence advances. See SHARED-BATTLE-SCENE.md.

## Native committed attack integration evidence

The current native build maps Treecko/Pound, Torchic/Scratch and Mudkip/Tackle to preserved PMD Attack sequences with source ground markers and contact timing. Queued events wait for native completion; old event history and stale acknowledgments cannot replay attacks. Owned follower UUIDs select the existing body for temporary attack playback. The final fresh two-account assist check verified Treecko contact, exact slot and completion with the real shared result. Full per-frame/direction visual QA, the other three test-party attack mappings, misses/statuses and autonomous movement remain incomplete. See NATIVE-WORLD-ENCOUNTER.md; maturity bars remain unchanged.

## Individual following and party menu repair

Following now belongs to each creature rather than the starter's global flag. A real six-member account test selects exactly two, verifies persistence after reload, sees both source sprites beside the stationary hero, and returns the second without changing the first. Native six-species spawn placement also passes independently. Party portrait cards, health/types, Summary/Care/Organize controls and the shared Charmdex navigation replace the mixed controls; desktop container sizing and 390px checks pass. This repairs the reported behavior and menu organization; it does not certify the complete game's visual or SocialFi scope. See INDIVIDUAL-FOLLOWING-AND-CHARMDEX.md.

## Source dimensions and companion scale

The pinned Emerald catalogue now supplies species height and weight for 386 species, with internal IDs joined by species names and source units preserved. Party Summary displays these as species references. Six supported native followers use compressed 16/18/20-pixel envelopes, fixed across walking and supported attacks, with transformed ground anchors and audited opaque bounds. The audit covers 488 frames and 240 anchors; stationary six-party and individual-follow browser checks pass. This is readable chibi scaling, not literal human-to-creature proportions. Catalogue coverage does not imply 386 playable creatures. Large bodies, mounts, authored footprints and complete attack-direction visual review remain outstanding; maturity bars are unchanged. See CREATURE-SCALE-AND-WORLD-CONTRACT.md.


All new features must apply MULTIPLAYER-INTERACTION-CONTRACT.md across solo, allied, competing, PvE and PvP contexts. Current controller-only capture does not implement PvP or group reward allocation.

## Shared capture and six-species attack checkpoint

Ordinary-ball capture now runs through the same controller-owned transaction in world and staged modes. Finite local sandbox supply, failed retaliation, preserved wild identity/HP/IVs, stored ownership, exact retry and competing-account rejection pass PostgreSQL checks. The actual browser overhead run observed one failed and one successful throw through native START/OPEN/RESULT and acknowledgment, spent two balls, verified receipt replay and found the caught Poochyena in Party. Original ordinary-ball frames drive a receipt-only visual; this is not a complete predicted release/contact control or spectator capture system. Distinct React keys fix stale battle controls after capture.

All six test-party basic attacks now have pinned source sequences. The added three species pass 24 synthetic direction/contact cases; 744 walk/attack frames and 504 attack anchors are audited. This does not certify every animation frame or authenticated move in every direction. See CAPTURE-UI.md, CAPTURE-INTEGRATION-CONTRACT.md and NATIVE-WORLD-ENCOUNTER.md.

## Nearby capture replication and visual audit

Migration124 records a bounded public capture event independently of private inventory receipts. Authorized nearby viewers receive the event identity, source/target cells, result and timestamp. Inventory amounts and private receipt fields are not projected. The initiating client deduplicates the direct receipt against the shared stream. First snapshot, reconnect and range reentry establish a history baseline instead of replaying missed captures. Rendering is observational and grants no capture rights.

A real two-account browser check confirms spectator native completion for the shared event and no second animation on an identical retry. Server tests exclude far-away actors and viewers and expired presence; stale epoch, expired claim and changed retry payload do not consume supply. Original ball palette-index transparency is now interpreted correctly; sampled native throw/open frames no longer have a white rectangle. Broader multiplayer and full frame-by-frame fidelity remain incomplete.

## Fullscreen capture and captured-companion recovery

The native Enter/Game menu now exposes an eligibility-gated Throw ball option and routes it to the existing parent capture command. Actual fullscreen browser verification passed a failed then successful throw while retaining fullscreen, spending two finite balls and preserving the successful owned result and native acknowledgment. This is menu access, not a new direct aiming/throw-arm implementation.

Captured companions were incorrectly excluded from rest queries; all recovery paths now include them. A dedicated PostgreSQL lifecycle test captures with all six slots occupied, preserves the seventh creature in storage, explicitly swaps it into the party, fights and rests to full HP/PP while preserving level/IVs and preventing repeated-commit duplication. Private-home revocation also blocks capture history immediately.

The source pose audit found no usable directional lift/throw frames in this quest: lifting and lift-walking return tile0, and the spell pose repeats one tile. No unrelated animation was substituted. Authored directional throw poses remain outstanding.
