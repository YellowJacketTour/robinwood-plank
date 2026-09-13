# Charmville as one social world

Charmville should preserve one identity, one owned collection, and one social context while a person moves between playing, watching, visiting, building, and trading. The central design opportunity is continuity between these activities. It is not established that any proposed implementation is unprecedented or universally faster than existing games. Superiority must be demonstrated through playability, reliability, capacity, and cost.

This research checkpoint covers world organization, social presence, gameplay broadcasting, theatres, replication, and the content architecture connecting the source-game inspirations. Sources were checked on September 13, 2026. Historical developer articles are identified as historical evidence; they are not claims about current production internals. This is a design and research artifact, not a completed implementation or an exhaustive ranking of every game.

## The experience to build

A visitor opens a PlankSpace profile and sees the account's actual live gameplay when broadcast permissions allow it. They can keep watching while browsing posts, react using the same Charmdex collection, enter a shared theatre, ask to join the party, and travel to an authorized arrival point. The broadcaster keeps playing throughout. Watching must not silently grant control, harvesting, storage access, or a place in a full combat instance.

The interface should explain a transition with one clear action and a truthful state: Watch, Join party, Visit home, or Return. When admission is unavailable, retain the stream and conversation while offering a queue or another agreed destination. A friend must never appear to have joined successfully while actually being assigned to a different copy of the location.

The first playable story should teach this continuity. At the family home, the player receives the burning-heart seed, tends it, harvests a charm, learns the satchel, and gives a first permitted reaction. A nearby public square introduces friends, trade, and shared activities. The tutorial's completion records should follow actual completed actions, not merely closed dialogue windows. This story is a proposed authored sequence, not an existing source-game mechanic or a finished quest.

## Evidence and its implications

| Reference | Documented mechanism | Charmville design consequence |
|---|---|---|
| Epic's Replication Graph | Organizes actor replication to avoid every actor independently evaluating every client. The documentation uses Fortnite's 100 players and roughly 50,000 replicated actors as an example. [1] | Build spatial and relationship-based subscription lists. This is evidence for interest management, not evidence that our server can support those counts. |
| Factorio's multiplayer rewrite | Wube explains connectivity, synchronization, and join/leave complexity in its original peer-to-peer design and the move toward a server-mediated model. [2] | A browser consensus mesh is an experiment, not the default authority for shared combat or scarce items. |
| Factorio's latency state | The developer describes predicted local state layered over deterministic authoritative game state and reconciliation of queued inputs. [3] | Separate responsive presentation from committed outcomes. Reconcile inputs without replaying rewards or spawning duplicate companions. |
| No Man's Sky Beyond | The Space Anomaly and Nexus provide a social rendezvous and multiplayer mission selection within a much larger universe. [4] | A legible meeting hub can connect distant friends without making the whole universe a single overloaded simulation room. |
| Stardew Valley 1.3 | Its official multiplayer release describes farmhands and shared cooperative farm life. [5] | Keep household permissions and contributions explicit; an enjoyable farm is a place to inhabit together, not simply a timer dashboard. |
| Pokémon Emerald reconstruction | The repository provides a reproducible decompilation and concrete code/data to inspect. [6] | Pin source revisions and trace party, battle, bag, and field behavior. A repository's existence does not establish a browser MMO port. |
| Solarus editor | Its documentation exposes map, sprite, and script editing in a quest workflow. [7] | Adopt coherent authored content packages and editor previews, while retaining a separate online authority boundary. |
| Minecraft entity authoring | Microsoft documents distinct behavior and resource definitions for custom entities. [8] | Separate creature identity and behavior from artwork variants, animation resources, and creator skins. |
| Diablo IV Loot Reborn | The historical season describes revised itemization and item improvement systems. [9] | Evaluate readable affixes and progression choices, but do not copy a seasonal balance model uncritically into a permanent shared economy. |
| Canvas capture | The browser API returns a video track of canvas contents and requires an origin-clean canvas. [10] | Broadcast actual game footage from the game surface; do not substitute position snapshots or silently capture the desktop. |
| LiveKit | Its SFU forwards published media to interested subscribers; adaptive subscriptions and simulcast can reduce unnecessary delivery. [11–13] | One publication can support profile, floating player, and theatre views. Multiple publications from the player for each viewer are unnecessary. |
| Media over QUIC | Draft21 defines publish/subscribe delivery over QUIC and WebTransport with relay support; it remains an active draft. [14] | Benchmark as a replaceable transport option. Do not base account identity or item custody on a draft media protocol. |

## World geography and homesteads

Guild Wars2's published megaserver design places people using social affinities, including parties and guilds; its follow-up describes limited guild reservations and draining map copies. These are useful precedents for preserving groups during allocation. They do not establish that two copies contain the same live enemies or that every regional population can interact simultaneously. [15–16]

FFXIV's housing guide offers persistent residential districts, wards, and subdivisions, while its housing-rights documentation provides owner controls over visitors. Charmville should borrow the legibility of addresses and permissions without copying finite plot allocation if every account is promised a home. Nintendo's visiting flow provides another simple precedent: opening access, inviting visitors, and ending the visit. [17–19]

Roblox documents streaming nearby instance content to reduce client resource use, with additional replication foci carrying additional work. This supports separating visible detail from the complete world catalogue. It does not license hiding interactable opponents or failing to load collision at an entrance. [20]

Use a stable hierarchy of universe, world, region, place, and instance. A place is a meaningful address such as a house entrance, public market, woodland path, or dungeon gate. Its instance identifies the particular active simulation. Server process identifiers must not become permanent player-facing addresses.

Homesteads should have a persistent address and a visible connection to shared geography. The recommended first design is a shared neighborhood entrance with a private, permission-controlled interior and expandable land beyond it. That provides a recognizable home without reserving an unbounded amount of contiguous physical terrain for every registered account. Remote islands can be optional geography, not a universal isolation requirement.

Separate ownership from residency and visiting. A household can grant build, tend, collect, or storage rights individually. A visitor may walk and watch without acquiring harvest rights. Public exterior changes should have their own rules, because they affect neighbors. Logging out should not destroy the address, crops, buildings, or other persistent records.

Public regions should contain complete circulation loops: home to square, square to fields, fields to wilderness, wilderness to dungeon or transport, and a clearly understood return route. A region should be authored around sight lines, collision, landmarks, safe arrival positions, and activity density. Do not place a tutorial solely because the current source quest happens to spawn there.

Before choosing the permanent opening, export a map atlas and classify candidate areas for accessible ground, foliage occlusion, interior connections, water access, threat separation, and room for other players. Walk every entrance and return path. The present four-screen joined region is a technical proving area, not a completed global map or a final location decision.

## Distributed worlds and capacity

Global unity means stable identity, reachable geography, consistent rules, and durable ownership. It does not require every browser to simulate every creature or every world server to broadcast all state to every player. Public-world populations can be distributed among regional simulation workers while the social directory and ownership services remain logically shared.

A proposed transfer protocol reserves destination capacity, verifies the destination geometry version and permissions, prepares the player and party state, then commits one ownership epoch. The old worker stops accepting actions for that epoch. Duplicate messages return the previous result; a reconnect resolves the committed owner. A failed transfer leaves the player at the last safe source position. Cross-border combat needs an explicit authority rule and bounded overlap; merely sending both workers the same actor creates competing writers.

Capacity must be described on separate axes: registered accounts, simultaneous connected accounts, active players per world, players within one combat area, active creature count, and spectators. Six companions make 1,000 players at least 7,000 player-and-companion actors before enemies, effects, projectiles, and buildings. This arithmetic is not a capacity prediction.

Benchmark a workload ladder rather than announce a maximum: ordinary exploration; a busy town; farming with visitors; six companions per player; and concentrated raid combat. Measure server tick time, queue growth, reconciliation frequency, client frame time, memory, and bytes per client. Hold per-player relevance bounded where gameplay allows. A large distributed population and thousands of mutually interacting combatants are different engineering problems.

World allocation must favor existing parties and explicit friends' destinations. Do not silently dissolve parties to fill spare slots. At saturation, preserve a social meeting point and show an admission state. Different copies of a battlefield cannot be presented as the same fight. Global markets may span worlds only when issuance, transfers, and sinks use the same ownership rules.

## Actual live footage on every social surface

The existing canvas capture helper is useful groundwork, but it is not proof of end-to-end streaming. Canvas capture supplies video; game audio needs an explicit audio-graph connection. Microphone and proximity voice remain separate selected tracks. Profile broadcasts should exclude wallet panels, private messages, and private inventory overlays unless deliberately included.

Use one broadcast identifier across the account profile, feed card, floating player, Charmdex, and theatre. Start with an SFU for interactive viewing, selecting media layers according to visible size and network conditions. The LiveKit documentation supports that approach, but its current self-hosted architecture routes a room's participants to the same node; adding nodes does not automatically make one room unbounded. Large audiences require a separately measured fan-out strategy. [11–13]

For mass passive audiences, compare a broadcast delivery path against interactive WebRTC. Higher delay may be acceptable for a large public event but not for a friend deciding when to join. Label delay and distinguish Live from recorded clips. Keep media transport interchangeable so MoQ experiments do not require rewriting privacy or the profile page. [14]

Audience policy must be enforced both at admission and on changes: public, owner-only, or explicit allowed accounts. Theatre membership cannot widen the broadcaster's audience. Revocation must terminate existing delivery, not merely prevent new tokens. Already delivered pixels cannot be recalled. Recording and clipping need a separate retention policy.

## Theatres, raids, and transitions from watching to playing

A theatre is a shared social place with a synchronized media timeline. Its host can select an authorized broadcast and manage local conversation. A live game's simulation never pauses because theatre viewers pause or buffer. Late arrivals should synchronize to a bounded common viewing point while retaining a clear route back to the live edge.

An in-world screen displays the same broadcast publication used by the profile. Prevent accidental recursive capture when a broadcaster watches their own stream in a theatre. Keep theatre voice separate from game sound and party voice, with understandable mute controls. A mobile client should not decode several full-resolution streams hidden behind other menus.

For raids, authorized player angles can share an encounter identifier and timeline. The active player's camera remains gameplay; alternate views are spectator media. Switching angle must not change attack authority, reveal private tactical data, or reset encounter health. Spectator views should expose only permitted information, especially in PvP.

The proposed differentiator is a continuous Watch → Join → Play → Share journey. A viewer receives a join invitation tied to the current party and a safe destination; the social session stays open while world assets load. Admission then replaces passive watching with their own controllable character. A saved return address lets them leave the visit without losing their previous location. This is a product hypothesis to test, not a claim of historical novelty.

## One content identity across game and social life

A charm definition identifies meaning, not just a picture. A cow-related family can have species, quality, individual creature instances, products, and expressive artwork without pretending those are interchangeable units. The satchel shows owned quantities and unique instances. The Charmdex shows knowledge and discovery. The equipment bag shows usable manifestations. All three reference the same definitions and custody records.

A social sticker is a presentation of a defined charm. A free expression, a consumable reaction, and a transfer of an owned charm must be visibly distinct. Watching or repeatedly posting must not independently mint unlimited scarce assets. Livestock breeding, crop harvests, monster loot, crafting, and reaction consumption need explicit issuance and sink rules. These are Charmville design requirements, not facts imported from the cited games.

Animation definitions should include facing, anchor, footprint, anticipation, contact time, recovery, occlusion, and interruption behavior. The same creature instance carries health and statuses from action combat into staged combat. A battle view must not create a second authoritative creature. Creator artwork can replace a visual package without changing item identity or duplicating custody.

## Feature research coverage and next questions

| Feature family | Reference set | Required next evidence or experiment |
|---|---|---|
| World travel and settlements | Guild Wars2, WoW, FFXIV, No Man's Sky | Friend affinity, capacity failure, home entrance and return continuity. |
| Field combat and tools | Zelda, Graal, Solarus | Frame-by-frame directional action and collision comparison; historical sources already collected need version-pinned acceptance. |
| Party and staged battle | Emerald, Mystery Dungeon, Final Fantasy | Same-instance damage/status/capture continuity; formation and six-member menu interaction. |
| Farming and household life | Stardew, FarmVille, Animal Crossing | Shared rights, crop-stage readability, calendar/time behavior, meaningful cooperative tasks. |
| Loot and equipment | Diablo II, Diablo IV, WoW, OSRS | Target farming, affix readability, party eligibility and item identity; current pass does not claim a full D2 magic-find audit. |
| Manufacturing and civic play | EVE, Factorio, Minecraft, SimCity, Age of Empires | Production graphs, logistics, citizen effects, resource sinks and limits on offline simulation cost. |
| Creatures and livestock | Emerald, Palworld, Stardew | Species-specific behavior, breeding provenance, workload limits, capture/evolution custody. |
| Creator tools | Solarus, Minecraft, Roblox | Versioned art/behavior packages, preview, rollback, validation and migration of live content. |
| Profile media and theatres | WebRTC/LiveKit, MoQ, social viewing platforms | Two-device actual footage, audio, privacy revocation, late joins and mobile encoder cost. |
| Input, menus and accessibility | Nintendo source interfaces plus browser controls | Visual source comparisons, controller focus graph, touch hit targets, remapping, captions and reduced-motion behavior. |

This table is an accountable research backlog. Entries without a source analysis are not labelled completed. No single game's interface, network model, or economic system establishes the correct solution for every feature.

## Production gates

First, finish the native presentation boundary: a true world camera independent of simulation, complete coordinate transforms, stable input, and readable authored locations. Next, prove a committed home-to-public-to-friend-home round trip with two authenticated accounts and preserved party/inventory. In parallel with that bounded integration, build actual two-device profile footage and one theatre using the existing audience-policy boundary.

Then join those two paths: watch a friend, accept a party invitation, arrive in their instance, perform one shared activity, and return. Test failures at every transition. Only after this end-to-end loop is reliable should density and audience benchmarks determine world and theatre admission limits.

AI can assist map validation, animation contact-frame audits, test generation, creator previews, and content consistency checks. Generated terrain and rules must pass collision, topology, economy, and provenance validation before publication. AI should not invent live authoritative rewards or mutate combat rules unpredictably. The desired innovation is a better integrated and measurable experience, not an unsupported claim that a model name makes the architecture superior.

## Sources

1. Epic Games, [Replication Graph](https://dev.epicgames.com/documentation/unreal-engine/replication-graph-in-unreal-engine), live documentation.
2. Wube, [Friday Facts147: Multiplayer rewrite](https://www.factorio.com/blog/post/fff-147), July15,2016.
3. Wube, [Friday Facts302: The multiplayer megapacket](https://www.factorio.com/blog/post/fff-302), historical developer article.
4. Hello Games, [Beyond Update](https://www.nomanssky.com/beyond-update/), historical update2.0.
5. ConcernedApe, [Stardew Valley1.3 multiplayer release](https://www.stardewvalley.net/stardew-valley-1-3-multiplayer-update-is-now-available/), historical release announcement.
6. pret, [pokeemerald](https://github.com/pret/pokeemerald), reconstruction source repository; source revision must be pinned for implementation.
7. Solarus, [Creating a Quest](https://docs.solarus-games.org/tutorials/getting-started/creating-a-quest/), documentation.
8. Microsoft, [Creating New Entity Types](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoaddentity?view=minecraft-bedrock-stable), Bedrock creator documentation.
9. Blizzard, [Season4: Loot Reborn](https://news.blizzard.com/en-gb/article/24077223/galvanize-your-legend-in-season-4-loot-reborn), historical season design.
10. MDN, [HTMLCanvasElement.captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), browser API documentation.
11. LiveKit, [SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/), current documentation.
12. LiveKit, [Subscribing to tracks](https://docs.livekit.io/guides/room/receive), adaptive stream documentation.
13. LiveKit, [Codecs and more](https://docs.livekit.io/transport/media/advanced/), simulcast and dynacast documentation.
14. IETF, [Media over QUIC Transport draft21](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/), updated September8,2026; work in progress.
15. ArenaNet, [Introducing the Megaserver System](https://www.guildwars2.com/en-gb/news/introducing-the-megaserver-system/), historical architecture announcement.
16. ArenaNet, [Continued Improvements to the Megaserver System](https://www.guildwars2.com/en/news/continued-improvements-to-the-megaserver-system/), historical follow-up.
17. Square Enix, [Housing purchasing guide](https://na.finalfantasyxiv.com/lodestone/playguide/contentsguide/housing_land/), housing districts and allocation.
18. Square Enix, [Patch7.0 notes](https://na.finalfantasyxiv.com/lodestone/topics/detail/d7db61f938f9cea65e4c5cd261918edb036b3004), historical housing-rights behavior.
19. Nintendo Support, [Animal Crossing multiplayer](https://en-americas-support.nintendo.com/app/answers/detail/a_id/49136/p/897), visiting and host controls.
20. Roblox, [Instance streaming](https://create.roblox.com/docs/workspace/streaming), client streaming and replication focus documentation.
