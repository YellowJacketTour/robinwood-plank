# Charmville: Graal-shaped world, creator platform, and charm economy

Research and architectural recommendation • September 9, 2026

## The product we are building

Charmville is the inhabited economic world of PlankSpace. A player has a character, a home, skills, relationships, productive land, and a role in a civilization that other players help build. Social reactions become discoverable charm identities with expressive, productive, collectible, and potentially tradable uses. The ambition includes the full discoverable unicorn.meme/memoji universe, rather than a closed selection of seven starter charms.

The useful organizing reference is GraalOnline Era and its PlayerWorlds creation ecosystem. I have treated “Graal online new era” as referring to that lineage; I have not verified a separate official product named New Era. Graal contributes the continuous social place: recognizable avatars, streets, jobs, houses, furnishings, events, and player identity. Farming is one activity within that place. Crafting, shops, guilds, civic works, and markets become other reasons to inhabit it.

The combined loop is:

**Explore and socialize → discover charms → cultivate and gather → combine and manufacture → trade or contribute → build homes and towns → unlock new capabilities and regions.**

“Composting” can be a real transformation system: expend eligible native materials or duplicates to recover components, nutrients, or catalysts. It needs explicit recipes and conservation rules. An external token cannot be silently destroyed, duplicated, or reminted merely because the interface calls the action farming.

Graal's official Era listing documents jobs, custom graphics, housing, furniture, and social/PvP activities; PlayerWorlds documents community world construction. These support the social-world reference, not a claim that Graal already implements this proposed economy. Sources: [Era](https://store.steampowered.com/app/2358050/Graalonline_Era/), [PlayerWorlds](https://graalonline.com/playerworlds/), [creation tools](https://graalonline.net/Creation/Dev/Tools).

## Technology decision

**Recommended foundation: existing Three.js/React Three Fiber client + a separate Colyseus world service + PostgreSQL economic persistence + Blender/Blockbench/glTF content + a custom creator editor using Yjs for collaborative drafts.**

The inspected application already depends on Three.js, React Three Fiber, Drei, and postprocessing. Retaining that investment is the strongest starting decision. The recommendation is based on source and documentation research, integration fit, and ownership requirements; it is not a completed comparative performance benchmark.

| Layer | Selection | Purpose and boundary |
|---|---|---|
| PlankSpace shell | Existing Next.js/React application | Accounts, profiles, discovery, commerce interfaces, community tools |
| World rendering | Three.js + React Three Fiber | Orthographic 3D world, characters, animation, effects, scalable camera presentation |
| Realtime authority | Colyseus service | Movement validation, region sessions, interactions, state synchronization |
| Durable economy | PostgreSQL transaction service | Inventory, ownership, escrow, orders, crafting jobs, settlement, audit trail |
| Professional assets | Blender source, exported glTF/GLB | Editable geometry, rigs, animations, reusable environment kits |
| Accessible creation | Blockbench and in-game editor | Community props, skins, tile/parcel layouts, accessible contribution path |
| Shared editing | Yjs draft documents | Collaborative scene and configuration editing; publication remains validated |
| Content delivery | Versioned object storage/CDN | Models, textures, previews, content manifests, rollback |
| Chain integration | Isolated chain/indexer adapters | Registry discovery, balance verification, signed transactions, confirmed settlement |

Keep high-frequency animation and movement outside React component state. Separate simulation state from rendering objects so a later renderer migration does not rewrite the economy. Three.js documents WebGPU with WebGL2 fallback, but each shader, effect, and dependency still requires compatibility testing. Sources: [WebGPU renderer](https://threejs.org/manual/en/webgpurenderer), [R3F performance guidance](https://r3f.docs.pmnd.rs/advanced/scaling-performance), [R3F pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls).

### Alternatives and when they win

| Combination | Strength | Decision |
|---|---|---|
| Three/R3F + custom editor + Colyseus | Existing integration, source ownership, tailored social UI and creator experience | Adopt as the baseline |
| Babylon.js + Babylon Editor + Colyseus | More integrated game-engine tooling and an established editor | Strongest renderer challenger; switch only for demonstrated production or performance gains |
| PlayCanvas + its collaborative editor + authoritative backend | Excellent ready-made browser scene collaboration | Prefer if hosted creator workflow becomes more important than owning the complete editing service |
| Godot + authoritative backend | Open engine, cohesive game editor, strong native route | Credible native-first alternative; browser export constraints require evaluation |
| Unity + authoritative backend | Mature content ecosystem and game production tooling | Useful if the project commits to a dedicated studio pipeline; migration is substantial |
| Unreal + backend | Highest-end native cinematic rendering/tooling option | Reserve for a future native client requirement; browser Pixel Streaming entails remote rendering infrastructure |
| Nakama instead of Colyseus | Broader game backend capabilities | Reassess if its social/backend services replace substantial existing work; otherwise duplicates PlankSpace responsibilities |
| SpacetimeDB-centric stack | Transactional state/reducer architecture | Interesting alternative, but changes the existing persistence architecture and has a different license model |

PlayCanvas's editor frontend is now open source; that does **not** establish that the complete hosted collaboration backend is available as a self-hosted MIT package. Godot's browser export uses its compatibility renderer and has browser networking/threading constraints. Unreal Pixel Streaming renders on a server and streams to the browser. Sources: [Babylon](https://www.babylonjs.com/), [Babylon Editor](https://editor.babylonjs.com/documentation), [PlayCanvas collaboration](https://developer.playcanvas.com/user-manual/editor/realtime-collaboration/), [editor frontend announcement](https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/), [Godot web export](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html), [Unity web technical overview](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-technical-overview.html), [Unreal Pixel Streaming](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-pixel-streaming-in-unreal-engine), [Nakama authority](https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/), [SpacetimeDB FAQ](https://spacetimedb.com/docs/intro/faq/).

## How it achieves the visual ambition

Use a **2.5D presentation built from a 3D world**: an orthographic or restrained perspective camera, readable neochibi silhouettes, expressive rigs, tangible foliage and buildings, and sticker/sprite layers for charm expression. This supports Graal-like readability and Nintendo-like clarity while allowing lighting, animation, layered terrain, and richer close views.

The existing woodland reference suggests warm materials, rounded silhouettes, mossy architecture, curved stone paths, botanical density, and an inviting scale. Translate those qualities into reusable geometry, material palettes, character proportions, lighting, and interaction animations. A beautiful background image alone does not provide a playable world.

Production priorities:

1. One coherent character skeleton, proportions, face system, locomotion set, and interaction set.
2. Modular clothing with explicit attachment and clipping rules.
3. A reusable environment kit: terrain edges, paths, houses, farm beds, market stalls, civic structures, vegetation.
4. Art-directed lighting with baked/static contributions where useful, limited dynamic lights, shadows appropriate to device capability, and consistent color treatment.
5. Responsive feedback for footsteps, harvesting, crafting, trading, placement, emotes, and weather.
6. LOD, instancing, texture budgets, streamed districts, and distant simplified actors.

AAA is a production quality target, not an engine checkbox. The decisive investment is a coherent art pipeline, excellent movement and feedback, content density, stable performance, and repeated playtesting. A disciplined stylized game can have exceptional polish without pursuing photorealism.

## How the game references combine

| Reference family | What Charmville should take | Research conclusion |
|---|---|---|
| Graal Era / PlayerWorlds | Inhabited social map, recognizable characters, jobs, housing, custom graphics, community authorship | Best organizing reference for the entire experience |
| Zelda / Solarus / ZQuest Classic | Readable exploration, contextual interaction, secrets, tool-based progression, handcrafted places | Design/editor references; neither researched engine is the recommended 3D MMO base |
| OSRS / RuneLite / Lost City | Long-lived skills, gathering, item identities, production chains, exchange convenience | RuneLite is a client; reconstruction server/content projects require careful separation of code and original assets |
| Animal Crossing | Personal expression, cozy routines, homes, neighbors, seasonal discovery | Interaction and art direction reference; existing-game ports are not a reusable original-world asset library |
| FarmVille / Farm Together / Hay Day | Crop scheduling, production queues, cooperative visits, accessible commerce | Embed these loops in the walkable world and regional supply chains |
| Palia / Roots of Pacha / Staxel / Garden Paws | Social/cooperative farming, settlement progression, building, mod-friendly contribution patterns | Useful bridges between cozy life simulation and inhabited multiplayer spaces |
| SimCity / Micropolis / Unknown Horizons | Infrastructure, services, settlement dependencies, public works | Introduce civic projects driven by actual player production and permissioned planning |
| Age of Empires / 0 A.D. / openage | Technology progression, building roles, territory readability, scenario editing | Use progression and editor lessons; avoid forcing a continuous RTS combat loop into everyday cozy play |
| EVE | Blueprints, industry dependencies, hauling, specialization, regional demand | Adopt interdependence and player production; full-loot conflict is not necessary to obtain a deep economy |
| Minecraft / Luanti / Veloren | Combinatory construction, recipes, creator extensibility, exploration | Favor flexible content definitions and interoperable world systems over unlimited arbitrary scripts in the shared economy |

Specific repository findings matter. [Solarus](https://www.solarus-games.org/about/faq/) is a 2D action-adventure engine; [ZQuest Classic](https://github.com/ZQuestClassic/ZQuestClassic) centers its own Zelda-like creation model. [RuneLite](https://github.com/runelite/runelite) is an open client, not an MMO backend. [Lost City content](https://github.com/LostCityRS/Content) explicitly distinguishes its source license from Jagex assets. [openage](https://github.com/openage-framework/openage-engine/) describes incomplete gameplay and dependence on original game assets. These are research references, not turnkey foundations for original Charmville.

Additional primary references: [Animal Crossing custom designs](https://www.nintendo.com/us/whatsnew/nintendo-inspired-custom-designs-are-here-for-animal-crossing-new-horizons/), [0 A.D. participation](https://play0ad.com/community/participate/), [MicropolisCore](https://github.com/SimHacker/MicropolisCore), [Unknown Horizons](https://github.com/unknown-horizons/unknown-horizons), [Palia's cozy MMO design](https://palia.com/news/building-a-cozy-sim-mmo), [Roots of Pacha](https://rootsofpacha.com/), [Staxel modding](https://blog.playstaxel.com/creating-mods/), [Garden Paws modding](https://www.gardenpawsgame.com/modding/), [EVE manufacturing](https://support.eveonline.com/hc/en-us/articles/203210292-Manufacturing), [EVE structure production](https://www.eveonline.com/eve-academy/careers/industrialist/structure-production), [Luanti](https://docs.luanti.org/), [Veloren](https://github.com/veloren/veloren).

The farming research also covered [Sunflower Land](https://github.com/sunflower-land/sunflower-land), [FarmVillage](https://github.com/AcidCaos/farmvillage), the locally available FV-Replowed reference, [World of Farmcraft](https://github.com/joeyinbox/world-of-farmcraft), [Flowerpot](https://github.com/AmbientRun/flowerpot), [Farm Together 2 terraforming](https://www.milkstonestudios.com/2024/05/farm-together-2-early-access-update-1/), [FarmVille 3](https://www.zynga.com/games/farmville-3/), [Stardew Valley multiplayer](https://www.stardewvalley.net/multiplayer-troubleshooting-guide/), and [Coral Island multiplayer](https://blog.stairwaygames.com/post/coral-island-1-2-update-release-date). These vary greatly in age, completeness, licensing, and accessibility. Their inclusion means researched references, not all locally executed or production-ready. Garden Paws's modding page lists supported and unsupported categories; it should not be described as supporting unrestricted modification of every system.

## One character, several scales of civilization

At character scale, players walk, emote, gather, craft, fish, explore, and interact with buildings. At household scale, they arrange land, decorate, cultivate, and operate workshops. At neighborhood scale, they share services and construct public works. At regional scale, transport costs and resource distribution produce specialization and trade. At civilization scale, collective projects unlock new infrastructure, recipes, and places.

These scales use the same underlying inventories, buildings, ownership records, and production jobs. The town view is a planning view over the inhabited world. It must not become a separate minigame whose buildings and resources disagree with the character view.

Start with safe common areas and explicit parcel permissions. Guilds and communities can propose and fund roads, irrigation, workshops, and market halls. Contribution records support reputation and civic identity. Permissions, quotas, and project approval protect shared spaces from accidental or hostile alteration.

## MMO architecture and scale

Use regional authority rather than treating one giant synchronized room as the whole world. A client receives nearby relevant entities and its own private state. An authoritative server validates movement and actions; persistent transactions handle scarce resources and ownership. Region handoffs need a single active authority and a controlled transfer of player state.

Crop maturation and long manufacturing jobs should normally derive from stored start/finish timestamps. Empty farms do not need a continuous per-plant simulation tick. Transport, markets, and civic systems can use appropriate lower-frequency jobs. Real-time movement and combat, if introduced, have different latency requirements.

[Colyseus](https://github.com/colyseus/colyseus) supplies useful multiplayer room and synchronization infrastructure. It does not by itself solve an MMO economy, world handoffs, exploit prevention, or unlimited scale. Its documented multiprocess presence option uses Redis. Earlier project material discourages Redis; preserve that constraint for the first service and record a specific architecture decision before adopting Redis or implementing alternative coordination. Source: [Colyseus presence](https://docs.colyseus.io/server/presence).

Kubernetes/[Agones](https://agones.dev/site/docs/overview/) is a later operational option, not an initial prerequisite or a persistence solution. Likewise, Rust/WASM simulation kernels should follow profiling of actual expensive systems, not precede a working game.

## The full charm universe and its markets

The inspected memoji reference is a concrete implementation, not proof of a complete current live catalog. Its constants contain 77 entries and point to `osmo-test-5`. The reviewed local revision is `e4a2d1440c2a283cea6cedaa1147fca49d187502`. The prior seven starter charms and the 77-entry snapshot must not become permanent scope limits.

Create a registry whose canonical identity includes chain and denom/contract identifiers. Track names, aliases, emoji representation, visual assets, provenance, metadata versions, external references, and market mappings separately. Support pagination, search, filters, new discoveries, and unknown/unverified entries. Unicode emoji alone cannot uniquely identify the memoji universe.

Discovery should combine source catalogs, creator-denom enumeration, indexed chain events, known pool data, and reviewed community submissions. Display whether an identity is discovered, visually supported, playable, owned, or tradable. Those are different facts.

Keep three systems distinct while presenting a coherent player experience:

- **Social expression:** reacting and displaying charm identities, with clear rules about whether expression consumes anything.
- **Game production:** gathering, growing, crafting, combining, and composting native resources under explicit recipes and supply rules.
- **Asset settlement:** ownership and transfer of real externally issued tokens or backed claims, where supported.

An existing external token may have no mint capability available to this game. Farming that identity therefore needs an explicit model: earn an acquired/reserved token, earn a redeemable claim backed by reserves, or earn a separately identified native game resource. An icon match never establishes financial equivalence.

Build the Grand Exchange as escrowed buy/sell orders with partial fills, cancellation, fees, and durable settlement. Integrate AMM pools through separate routing adapters and signed transactions. An order book and an AMM can appear in one market screen, but have different execution and custody rules. Treat shares in player enterprises as a separate future instrument design, rather than calling every collectible a stock.

The reviewed memoji swap component uses Osmosis GAMM `swapExactAmountIn`, registry pool selection, a single route, six-decimal assumptions, and frontend amount calculations. It is a valuable behavior reference but requires replacement/generalization for production routing, token precision, quoting, and transaction lifecycle handling. This was a source inspection, not a complete security audit. Sources: [memoji repository](https://github.com/nocktoshi/memoji-market), [constants](https://github.com/nocktoshi/memoji-market/blob/main/src/constants/index.ts), [Osmosis](https://docs.osmosis.zone/), [pool manager](https://github.com/osmosis-labs/osmosis/blob/main/x/poolmanager/README.md).

Engagement issuance should not reward unlimited self-generated reactions. Proposed controls include bounded emissions, meaningful unique participation, diminishing repetitive rewards, and sinks through crafting/civic activity. Exact rates require economy simulation and playtesting; they are not settled by this research.

## Community creation with a long horizon

Publish a versioned content SDK: unit scale, origin conventions, skeletons, sockets, material rules, texture budgets, animation names, collision requirements, previews, and example packs. Retain editable source files alongside optimized runtime exports. [glTF](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.pdf) provides an interchange/runtime format; it does not replace all authoring source.

Give creators three entry levels:

1. In-game parcel decoration, palette changes, signage, and safe pattern/skin uploads.
2. Blockbench/Blender assets and data-defined recipes, quests, furniture, buildings, and world chunks submitted through validation.
3. Advanced isolated mod worlds with broader scripting capabilities and explicit boundaries from the shared economy.

Use [Blockbench](https://blockbench.net/) for approachable modeling and [Tiled](https://doc.mapeditor.org/en/stable/manual/introduction/) as a possible world-layout import tool. [Quaternius modular characters](https://quaternius.com/packs/ultimatemodularwomen.html) and animation libraries can accelerate prototypes; unify and review them against the target art direction. Asset packs are ingredients, not an automatic coherent visual style.

[Yjs](https://yjs.dev/) can synchronize draft scene documents and editor awareness. It does not authorize publication, secure an inventory, or merge binary Blender files. Use versioned uploads, ownership, branching/reviews, and practical editing locks for binary authoring sources. Validate and version published content; preserve attribution and licenses per asset. Shared-world changes that alter production or scarcity require stronger review than personal cosmetics.

## What to build first, and what remains unproven

The next integrated playable district should contain a controllable expressive avatar, several visible players, a home plot, a farm/workshop, a public gathering place, the searchable charm registry, a physical exchange building, one multi-stage production chain, and one collectively funded civic upgrade. A community member must be able to add a permitted prop through the real asset pipeline. This exercises the connections that isolated farming screens cannot prove.

Sequence:

1. Stabilize the existing slice and record architecture boundaries without overwriting unrelated ongoing changes.
2. Establish the canonical charm registry and source discovery adapters.
3. Build the authoritative playable district, movement, persistence, and interaction contracts.
4. Integrate production, inventories, exchange escrow, and civic contributions with transactional consistency.
5. Deliver the creator pipeline and publish/revert workflow.
6. Add region handoff, transport specialization, broader content, and supported external-market settlement.

Before committing to a renderer replacement, compare the same district and equivalent assets in the baseline and challenger. Measure cold/warm loading, frame time, memory, GPU load, animation quality, asset iteration time, and browser/device coverage. Proposed crowd cases are 25, 100, and 250 visible actors with LOD; these are benchmark scenarios, not achieved capacities. Separately test server concurrent sessions, reconnects, handoffs, duplicated requests, conflicting trades, and recovery after failure.

Evidence limits: the browser Graal client returned a disconnected screen on repeated attempts, so no successful gameplay test is claimed. The unicorn.meme/linked market pages did not establish the full current live market catalog; one linked market domain failed to resolve in the browser. The local 77-entry testnet source remains only a verified subset. Repository and documentation review does not establish production performance. This report does not claim to have found every Zelda clone or every farming game.

## Work performed and continuity

This research extends the project's earlier FarmVille/memoji and art-reference work with Graal/PlayerWorlds, Zelda engines, OSRS client/server distinctions, cozy multiplayer references, civilization/RTS references, browser/native engines, authoritative backends, creator collaboration, and token-market architecture. The existing implementation dependency list and local memoji constants/swap behavior were inspected. No gameplay code, dependencies, contracts, deployments, or financial transactions were changed by this research task.

The resulting decision is concrete: build the first polished inhabited district on the existing renderer, make economic and world authority independent of that renderer, and make community content a first-class pipeline. This preserves a practical path to a richer client, larger civilization, and broader creator ecosystem without requiring an engine rewrite to begin.
