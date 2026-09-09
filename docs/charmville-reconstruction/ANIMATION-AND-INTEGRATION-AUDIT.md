# Charmville animation and world integration audit

The current playtest preserves a substantial Zelda-style adventure, but it does not yet deliver the combined farming, creature, skill and market game. Its most urgent weaknesses are incomplete action feedback, an endgame preset that hides costs and damage, and a browser/native engine mismatch that prevents the proposed WebSocket script from running. More source material helps only when converted into tested behavior inside the shared world.

The immediate recommendation is to retain the source adventure as the fidelity benchmark, establish a version-matched editable browser build, and prove one complete farming-and-creature loop there. Keep a browser-native alternative available if that engine cannot satisfy the integration tests. Do not replace the praised movement and art with another sparse scene, and do not confuse a catalog or transport probe with gameplay integration.

## What the animation audit establishes

Four isolated browser scenarios exercised bow, bomb, wand and Divine Fire inputs, with idle and seven subsequent screenshots per scenario. All four completed without JavaScript page errors. The captures are wall-clock samples, not frame-exact recordings: rendering and screenshot overhead make the filename offsets unsuitable for measuring exact frame timing. Earlier captures separately show sword charging and spin release.

The evidence has limits. A screenshot sequence cannot prove sound quality, all four directions, controller behavior, every collision case or every item variant. No claim of a complete animation regression pass is warranted. The following table separates observed behavior, source-supported capability and outstanding work.

| Action or feedback | Evidence and present state | Required completion |
| --- | --- | --- |
| Sword swipe | Slash flag and spin scrolls were absent from the first kit; now enabled. Native sword and spin frames captured. | Four-direction tests, moving attacks, recovery timing, hit response and equipment variants. |
| Sword charging | Native code supports normal and stronger charge thresholds, sounds and optional charge-ring timing. Endgame fast-charge gear changes the perceived buildup. | Visible charge progression, clear ready cue, early release/cancel tests, cost and interruption tests. Keep an unmodified-speed diagnostic preset. |
| Bow | Captured arrow projectile and resource decrement. Current native arrow action creates the projectile when invoked; no held draw/release state is supplied by this action path. | Explicit draw, aim, release and recovery states; draw pose and bowstring frames; directional origins; empty-ammo feedback. Do not advertise hold-to-charge until implemented. |
| Bomb fuse | Captured a placed bomb before the explosion. Source fuse length comes from the item's configuration. | Readable ignition/fuse animation, warning cadence and consistent placement origin; inspect the complete sprite sequence before claiming a particular flashing pattern. |
| Bomb explosion | Captured blast and lost hearts. Native code separately defines blast timing, hitbox changes, secret triggers and optional palette flash. | Distinguish fuse flashing, blast animation, world flash and damage. Check normal/super bombs, edges, shields, self-damage and reduced-flash mode. |
| Wand | Outgoing projectile visibly captured in the wand-180 sample; native projectile path exists. | Inspect remaining snapshots and directional variants, impact versus disappearance, blocking and empty magic feedback. |
| Divine magic | Casting pose captured; complete effect behavior remains unverified. | Cast start, invulnerability window, resource deduction, effect duration, cancel/exit behavior and audio review. |
| Hurt and regeneration | Bomb scenario visibly loses health; full-kit regeneration and defensive gear obscure that feedback. | Separate ordinary-combat and endgame tests; damage flash, knockback, invulnerability and recovery must remain legible. |
| Shield | Equipment slot present; broad blocking behavior not regression-tested. | Facing-dependent block tests and visible/audio success versus failure. |
| Movement and traversal | Native walking used throughout. Endgame traversal items are supplied, not exhaustively tested. | Foot anchoring, water entry, swimming, ladder/raft transitions, jumping, landing, stairs, portals and collision recovery. |
| Grass cutting and drops | Existing adventure mechanics remain a reference. | Verify cuts, debris, drop ownership, collection sound and respawn separately from crop harvesting. |
| Farming actions | Not connected in the Zelda playtest. | Hoe windup/contact/recovery, soil change, seed placement, water splash, wet soil, growth stages, harvest pop and inventory/XP confirmation. |
| Creature interactions | No integrated live creature/capture loop. | Spawn smoke, idle/roam/follow, attack/hurt, capture throw and outcome, battle transition and evolution coverage. |
| Skills and crafting | Not connected to this playtest. | Tool contact frames, progress/cancel feedback, exhausted nodes, resource transfer, XP and unlock cues. |
| Social and economy | Existing PlankSpace systems are outside this runtime. | Distinguish reaction animation, earned item, account ownership and actual market settlement. |

The precise source locations are ZQuest `src/zc/hero.cpp` (arrow action and charging), `src/zc/weapons.cpp` (bomb fuse, blast and palette handling), `src/init.cpp` (slash flag), and `src/core/zdefs.h` (equipment IDs). These are stronger evidence than an inventory icon. The acquired source revision is pinned in the source evidence; it is newer than the hosted runtime and therefore documents capabilities, not automatic runtime parity.[^1]

### Existing art that directly addresses the gaps

Solarus ZSDX already contains a four-direction bow animation definition: three frames per direction at a declared 100 ms frame delay. Its bow item script calls the native bow action and delays ammunition removal. It also includes charge-star, tunic, sword, shield, spin, swimming, lifting and hookshot sprite layers. This is a concrete animation reference, not a reason to redraw every action from scratch. These `.dat` definitions and Lua calls are Solarus-specific; importing the PNG alone would discard their timing and attachment information.[^2]

The acquired Extended LPC Magic pack contains separate directional sheets for several effects, including snake-related attacks, as well as other spells. The Items and Game Effects pack supplies inventory/world items and effect material. Preserve the included credits and inspect each animation's frame layout; a directory of PNGs is not a ready-to-run effect system.[^3][^4]

## Quality-of-life changes made in the playtest

The source wrapper now includes a collapsible controls guide and links to isolated sword, bow, bomb, wand and Divine Fire test kits. The full endgame kit remains available. Diagnostic kits remove the regeneration, fast charging and effectively unlimited resources that make ordinary timing and costs difficult to assess.

The stable entry is `http://localhost:3021/charmville/`. Add `?kit=sword`, `?kit=bow`, `?kit=bomb`, `?kit=wand` or `?kit=fire` for a focused test. These remain native test-mode sessions and reset progress. The controls panel states that the current bow fires immediately. It does not imply that the missing draw animation has been implemented.

The next quality improvements should be action-state feedback, not decorative overlays. Input acceptance, windup, resource payment, hit frame and recovery need explicit timing. Use a consistent sound vocabulary for acceptance, charging, ready, contact, failure and completion. Preserve positional audio where the engine supports it; verify audible results separately from a no-error browser test. Offer reduced screen flashes without removing a readable bomb warning.

## A blocking engine compatibility finding

The acquired hosted browser editor identifies itself as **3.0.0-prerelease.212+2026-08-16** in its runtime log. The separately acquired native tool distribution is **3.0.0-prerelease.219+2026-09-08**. The newer native compiler accepts the WebSocket probe. The browser-matched compiler rejects that source with **T047: Type websocket has not been declared**.

A separate Hero of Dreams copy was opened in the web editor, its previously empty script buffer was loaded through the editor's Load ZScript workflow, and the copy was saved. Native smart-assignment then produced a quest the browser player rejected as invalid. The rejection proves incompatibility in this tested combination; it does not prove that every possible resave is incompatible or that the binary format is the only cause. No WebSocket frames were observed. The original source quest was not overwritten.

Consequently, the earlier native compilation milestone must not be described as a working browser networking foundation. The current player does not run the proposed transport. The next step is a matched source, editor, player, compiler and script-header build, followed by a runtime test that observes both outgoing messages and validated incoming state. Loading the script through the editor is now demonstrated; successful in-world transport is still not.

Version identity belongs in an engine lock manifest: source revision, compiler revision, editor/player hashes, header hashes, quest section versions, feature support and browser smoke results. A source engine upgrade must pass authored movement, combat and dialogue checks before replacing the default playtest.

## Graal: the relevant systems and what is actually available

Graal's animation model is particularly relevant to the missing polish. Its documented GANI format combines sprite placement, timing, sound events and optional scripts. The documented world workflow connects `.nw`/`.graal` levels with maps and links. Those formats deserve adapters that preserve relationships, not image extraction alone. The official tool documentation is historical and explicitly notes limitations in the old level editor.[^5]

The newly acquired TilesEditor supports `.gmap`, `.nw` and `.graal`, layers, links/signs, undo/redo, tile operations and a work-in-progress JSON representation. It is an editing/conversion source, not an official Classic/Era world or complete game client. The already acquired Graal Reborn server is likewise a server implementation, not proof that official client artwork and all live content are in the repository.[^6][^7]

### Why Kingdoms matters

The official Graal Kingdoms description joins farming, resource jobs, crafting, housing, player shops, pets and mixed 2D/3D terrain. It also identifies integration with Crossfire's mudlib. Its historical lore places ordinary settlement life against disruptive Bomy events and competing kingdoms. That combination is a close design reference for cozy property life gradually expanding into a stranger civilization-scale world. Historical descriptions and staff/king listings must not be treated as current live-server state.[^8]

Crossfire therefore merits direct examination, not merely a passing mention. Its public project provides cooperative real-time RPG systems, skill and spell material, maps, item archetypes and editors. The server, archetype and map repositories have now been acquired. Local paths include `server/skills.cpp`, `server/alchemy.cpp`, `server/spell_attack.cpp`, and archetype `.arc`/`.face`/PNG records. Crossfire content is not identical to Graal Kingdoms content, and its client protocol is not a ZQuest protocol.[^9]

### Lore, catalogs and seasonal content

Treat Graal as several distinct content traditions: Classic-style social adventuring and housing; Era's contemporary weapons, jobs and item presentation; Kingdoms' roleplaying, craft and territorial systems; and other playerworld-specific designs. Preserve the world/server name on every catalog record rather than combining similarly named items into one ambiguous ID.

Era's official developer posts document item-linked profile animations and seasonal shop releases. Halloween and Christmas posts, winter shops and gift-pool descriptions are useful dated catalog evidence. They are not complete downloadable sprite packs, GANI source archives or current inventory APIs. A profile animation can also depend on continuing ownership of the item, which is a useful reference for PlankSpace expression rights.[^10][^11][^12][^13]

No complete official Classic/Era client-source repository, exhaustive lore database, all-item catalog or downloadable set of every seasonal pack was verified. Public fan catalogs can identify leads, but this report does not promote unverified fan prices or screenshots into authoritative live data. PureZC's script search could not be reliably opened in this pass, so no particular charged-bow mod is claimed as acquired.

A usable catalog record should include origin world, source item ID, display name, item family, season/year, obtainability window, original provenance, tradeability, ownership-dependent cosmetics, equipment effects, inventory art, world art, directional action art, audio, source code and verification status. Missing fields must remain missing rather than being guessed.

## Newly acquired sources and compatibility

Seven repositories and three art archives were acquired in this pass. Their pinned revisions, file hashes and file counts are recorded in `source-evidence/animation-expansion-lock.json`. Original ZIPs and their source pages are retained for the art packs. Acquisition is not installation, execution or integration.

| Source | Concrete value | Compatibility boundary |
| --- | --- | --- |
| DragonBallArena | Implemented Goku/Vegeta transformations and beam attacks; local sprite, collision and animation definitions | Java/Slick2D fighting-game code; side-facing art does not establish four-direction top-down coverage |
| TilesEditor | Graal map formats and editing operations | Qt editor; no automatic ZQuest map or GANI runtime adapter |
| RuneJS server | TypeScript content systems, banking, resource and crafting work | RuneScape build 435 protocol; incomplete skill/combat coverage |
| maierfelix/PokeMMO | Browser renderer/editor, maps and map-connection reference | Separate project from the commercial PokeMMO service; README explicitly calls gameplay unfinished |
| Crossfire server | Real-time RPG, skill, spell and alchemy implementation | Different simulation and network model |
| Crossfire archetypes | Item/creature definitions and associated images | Requires semantic and art adapters |
| Crossfire maps | Connected authored world material | Requires map/link/entity conversion and collision validation |
| LPC 4-Season Terrain | Seasonal terrain, animated water/waterfalls and climbing material | 32-pixel visual conventions require deliberate scale/anchor conversion |
| Extended LPC Magic | Spell-effect sheets and directional material | Frame/timing definitions must be authored or verified |
| LPC Items and Game Effects | Item and world-effect art | Credits and per-asset origin must accompany derivatives |

DragonBallArena is a real source lead for the requested crossover powers. Its animation factory separately configures beam head/body/end and explosion pieces, and the acquired resource tree contains attack/collision definitions. It has not been run here or ported into Charmville. It cannot honestly be presented as a finished top-down Kamehameha or transformation pack.[^14]

RuneJS's current feature checklist is unusually useful because it exposes incompleteness: mining and woodcutting contain implemented elements, while farming, fishing and several combat systems are marked missing or partial. Its build-435 target also does not establish the requested modern OSRS/Grand Exchange feature set. Reuse specific verified systems and data patterns, not the assumption that a RuneScape-named server supplies the whole economy.[^15]

The four-season terrain archive explicitly includes seasonal variants and animated environmental material. Its attribution identifies multiple contributing artists. This can support a coherent seasonal world layer, but seasonal rendering, crop eligibility and festival availability must remain separate systems.[^16]

## Broader platform and mod assessment

Compatibility has four different meanings: compatible artwork, translatable content, reusable mechanics and a runnable network integration. These should never be represented by one unchecked “compatible” label.

| Platform or project | Appropriate role | What it does not supply automatically |
| --- | --- | --- |
| ZQuest Classic | Immediate authored-action fidelity benchmark; candidate custom client after version lock | FarmVille, persistent MMO authority or a verified current web transport |
| Solarus / ZSDX / Trillium | Rich action/entity APIs and animation reference; alternate action client | Ready browser export or secure economic multiplayer |
| Pokémon Emerald / expansion | Source rules, encounters, progression and content reference | Shared real-time world authority or complete followers for every species |
| Pokémon Showdown | Server-side battle-simulation reference and potential battle rules module | Emerald exploration, capture/evolution persistence or overworld HP handoff |
| maierfelix/PokeMMO | Map/editor and browser-world reference | Completed Pokémon MMO gameplay |
| RuneJS / LostCity / XRSPS | Server/content or browser RuneScape implementation candidates | Identical revision coverage, complete skills or automatic compatibility with PlankSpace |
| Crossfire / Gridarta | Persistent RPG/content/map research, especially relevant through Kingdoms | Graal's exact assets, Zelda controls or a ZQuest adapter |
| RPGJS | Browser-oriented RPG authoring and TypeScript candidate | Source-identical Zelda action behavior without implementation |
| Godot | Strong candidate for editable 2D/3D presentation and native/web targets | A web export with no browser restrictions, or automatic multi-engine imports |
| Colyseus with a suitable client | Room/state synchronization and network-framework option | Durable economic authority, game rules or asset conversion |
| SMAPI / StardewMods | Farming-mod architecture, content-patch and user-mod workflows | Standalone Stardew engine or executable ZQuest/browser mods |
| Unknown Horizons / Mindustry | Settlement production chains, logistics and collaborative-system references | The desired player-character action RPG and social identity layer |

The official repositories/documentation support those narrower roles. Showdown is a battle simulator; Emerald expansion is a ROM-hack base; XRSPS describes a React/WebGL client and TypeScript server; LostCity's top-level repository is setup orchestration for engine/content. RPGJS, Godot and Colyseus should be judged through a small representative prototype, not feature-marketing alone. SMAPI mods remain dependent on Stardew Valley's runtime.[^17][^18][^19][^20][^21][^22][^23][^24][^25]

## One world, one progression model

The implementation should converge on a shared domain model rather than running multiple games side by side. A player account owns a character identity, skills, learned abilities, inventory and property permissions. A creature has one persistent ID, HP, statuses, evolution history and owner. A crop has one plot location, species, growth state and harvest entitlement. A source renderer is a presentation and input adapter around those records.

Use a canonical action timeline: input accepted, windup, committed cost, active effect, contact, recovery and completion. Rendering listens to these events. Skill XP, loot and market credits result from validated state changes, never from an animation finishing on a client. This is the point where the animation audit and MMO architecture must meet.

World time must also be explicit. Crops grow from server timestamps and configured care rules; combat advances on simulation ticks; animations use presentation time. Opening a staged encounter cannot pause the public world. Any safe encounter mode needs a reservation/participation rule so the same creature cannot be simultaneously captured or killed through two interfaces.

Preserve HP/status continuity by handing off a versioned creature record. The transition reserves the entity, records current HP/status and authorized participants, runs the selected encounter rules, and commits the result once. Retries and disconnects cannot duplicate the creature or restore its old health. Follow companions are another presentation of the captured identity, not a newly spawned unrelated copy.

Farming and skills should make this continuity visible. Clear a plot using the actual character, till it, plant a seed from the shared satchel, water it, observe growth, harvest a resource and gain farming XP. A nearby resource node should feed a crafting recipe; the resulting item should appear in the same inventory and then in a test exchange listing. Charms can be identities across social and game manifestations, but a social reaction, cosmetic entitlement, harvested unit and financial position require distinct accounting.

Community editing needs dependency-aware packages. A package declares maps, tiles, actors, animation clips, sounds, items, recipes, quests, localization and required engine features. Stable IDs permit replacement without breaking saves. Pixel scale, feet origin, directional ordering, depth layers, palette and collision shape must be validated at import. A missing north-facing beam cast or watering animation is a failed coverage check, not an invitation to silently substitute an unrelated sprite.

## The next playable acceptance sequence

1. **Matched engine build:** a derived quest compiles and loads in the exact browser player; original dialogue and movement remain intact; bidirectional adapter traffic is observed.
2. **One farm plot:** character-driven till/plant/water/harvest inside the authored map, with animation and persistent satchel/XP changes. Reload and a second client see the same result.
3. **One creature:** live attack and hurt feedback, then staged encounter with the same HP/status; capture produces a persistent follower. Test retries and disconnects.
4. **One skill recipe:** gather, gain XP, unlock or use a recipe, craft and equip an item with source-quality feedback.
5. **One test-market transaction:** list and purchase that item through shared account inventory with atomic settlement and no duplicate claims.
6. **One crossover ability:** implement the beam's charge, aim, collision, costs and impacts; then a transformation with full directional animation coverage. Test effects against that same creature state.
7. **One seasonal property package:** seasonal terrain and furnishings change without losing plot, creature or ownership records.

Until those gates pass, the accurate label is an authored adventure reference with testing tools and an expanding source foundation. The next milestone must be a playable vertical slice of the combined game, not a larger item list.

## Sources

[^1]: ZQuest Classic, pinned local source b9354acc0f4bbcfda3b390f98ff5032fbf0f6eb0: [hero.cpp](https://github.com/ZQuestClassic/ZQuestClassic/blob/b9354acc0f4bbcfda3b390f98ff5032fbf0f6eb0/src/zc/hero.cpp), [weapons.cpp](https://github.com/ZQuestClassic/ZQuestClassic/blob/b9354acc0f4bbcfda3b390f98ff5032fbf0f6eb0/src/zc/weapons.cpp). Browser audit and compiler screenshots are retained with the reconstruction evidence.
[^2]: Solarus ZSDX, acquired revision e904d7904d74a97a50992b1340431d5d8f341d69, local `data/items/bow.lua` and `data/sprites/hero/tunic1.dat`, plus associated sprite images. See the existing source-evidence manifest for origin and hashes.
[^3]: Daniel Eddeland, [Extended LPC Magic pack](https://opengameart.org/content/extended-lpc-magic-pack), 2012; downloaded original ZIP and source page.
[^4]: Reemax and credited collaborators, [LPC Items and Game Effects](https://opengameart.org/content/lpc-items-and-game-effects), 2015; downloaded original ZIP and credits.
[^5]: Graal Bible, [Development Tools](https://graalonline.net/Creation/Dev/Tools), historical documentation last edited 2010.
[^6]: Luke Graham, [TilesEditor](https://github.com/lukegrahamSydney/TilesEditor), README and acquired source.
[^7]: Graal Reborn, [GServer-v2](https://github.com/xtjoeytx/GServer-v2), repository; compare the existing acquired server manifest rather than assuming identical forks.
[^8]: GraalOnline, [Graal Kingdoms](https://www.graalonline.com/playerworlds/about/wiki?page=Worlds/Graal+Kingdoms), historical product, systems and lore description.
[^9]: Crossfire, [project overview](https://crossfire.real-time.com/), [Git modules](https://crossfire.real-time.com/git/index.html), [weapon catalog](https://crossfire.real-time.com/spoiler/weapons/index.html) and [map editors](https://crossfire.real-time.com/editors/index.html).
[^10]: GraalOnline Era, [Profile Animations](https://era.graalonline.blog/developer-patch-notes-profile-animations/).
[^11]: GraalOnline Era, [Halloween Shop 2025](https://era.graalonline.blog/halloween-shop-2025/).
[^12]: GraalOnline Era, [Christmas Shop 2025](https://era.graalonline.blog/christmas-shop-2025/) and [Plasma Corp Winter Shop](https://era.graalonline.blog/plasma-corp-winter-shop-2025/).
[^13]: GraalOnline Era, [2025 Present Opening and Information](https://era.graalonline.blog/2025-present-opening-and-information/).
[^14]: Draym, [DragonBallArena](https://github.com/Draym/DragonBallArena), README and acquired `AnimatorGameFactory.java`/resource definitions. The repository's third-party art provenance requires per-file tracking.
[^15]: RuneJS, [server](https://github.com/runejs/server) and [feature checklist](https://github.com/runejs/server/blob/develop/FEATURES.md), acquired revision recorded in the expansion lock.
[^16]: Death's Darling and credited artists, [LPC Revised 4-Season Terrain](https://opengameart.org/content/lpc-revised-4-season-terrain), 2022, OGA-BY 3.0.
[^17]: Felix Maier, [PokeMMO engine](https://github.com/maierfelix/PokeMMO), README and repository license; not the similarly named live service.
[^18]: Smogon, [Pokémon Showdown](https://github.com/smogon/pokemon-showdown), primary simulator repository; an older pkmn URL redirects to an archive and should not be used as the canonical upstream.
[^19]: RH Hideout, [pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion).
[^20]: [XRSPS](https://github.com/xrsps/xrsps-typescript) and [LostCity setup repository](https://github.com/LostCityRS/Server).
[^21]: RPGJS, [official engine and authoring overview](https://rpgjs.dev/).
[^22]: Godot, [Exporting for the Web](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html).
[^23]: Colyseus, [official documentation](https://docs.colyseus.io/).
[^24]: Pathoschild, [SMAPI](https://github.com/Pathoschild/SMAPI) and [StardewMods](https://github.com/Pathoschild/StardewMods).
[^25]: [Unknown Horizons](https://github.com/unknown-horizons/unknown-horizons) and [Mindustry](https://github.com/Anuken/Mindustry), primary repositories.


## Checkpoint and validation

The supplemental sources and engine failure evidence are backed up in the [private recovery release](https://github.com/YellowJacketTour/charmville-reconstruction-vault/releases/tag/animation-audit-2026-09-09); all nine archive sizes and SHA256 digests matched GitHub. Controls-menu navigation and the bow-kit startup were exercised in Chromium. A loading-overlay interception of the menu was fixed. Repository lint, typecheck, contract/market tests and production build completed; the market suite reported 1,326 passing and 50 skipped tests, with zero failures. These checks do not certify the unimplemented MMORPG features.
