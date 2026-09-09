# Existing-game foundation audit and corrected build direction

September 9, 2026. This supersedes the assumption that the sparse Three.js district is an acceptable visual foundation. The user rejected its artwork. Retain its useful experiments and existing PlankSpace services, but do not continue polishing that composition as the target.

## Decision: working adventure first

The implementation strategy is now to establish a mature, authored adventure as a behavioral and visual baseline, extend its gameplay/world systems, integrate shared authority and PlankSpace, and replace reference code/art incrementally with bespoke equivalents while preserving verified behavior. Asset counts do not measure progress toward that experience.

For the nostalgic action-adventure baseline, **Solarus plus Mystery of Solarus DX** is the strongest newly acquired match: an actual authored Zelda-style game and a purpose-built adventure engine. Emerald is the strongest acquired creature/encounter and field-system reference. Neither should be described as a drop-in MMO backend. For an immediate established browser Zelda runtime, **ZQuest Classic** has a documented experimental web player and editor; it warrants a browser compatibility benchmark before a custom renderer is chosen again.

A long-term renderer decision must follow this baseline exercise. The earlier Three/R3F choice established rendering flexibility but failed to deliver the expected game feel. It should not override the user's requirement to start from mature gameplay and authored worlds.

## Verified repositories

| Project | What is established | Limitation relevant to Charmville |
|---|---|---|
| [Solarus / Mystery of Solarus DX](https://gitlab.com/solarus-games/games/zsdx) | Acquired full quest source; 137 map definition files, Lua scripts, sprites, items and quest metadata. Quest describes Zelda-like mechanisms. | Native Solarus runtime required; no browser/MMO integration has been demonstrated here. |
| [pret/pokeemerald](https://github.com/pret/pokeemerald) | Acquired source; indexed 518 map definitions, 1,313 warp events, 2,776 object events. Inspected field/door modules, berry growth code and capture handler presence. | Builds a GBA game; browser delivery and shared authoritative state are additional engineering. |
| [snesrev/zelda3](https://github.com/snesrev/zelda3) | Acquired C reimplementation. Upstream describes a playable start-to-finish A Link to the Past implementation with enhanced aspect ratios. | Requires resource extraction from a supplied ROM; those resources were not acquired in this task. Not an MMO engine. |
| [OpenGraal](https://github.com/OpenGraal) / [GServer-v2](https://github.com/xtjoeytx/GServer-v2) | Located map/editor/server projects; acquired GServer-v2. README documents Graal Reborn server and NPC server build requirements. | Not evidence of a complete official Classic/Era client plus all production worlds/assets. Older dependencies require evaluation. |
| [Solarus Online](https://github.com/stdgregwar/solarus-online) | Acquired working-in-progress layer; docs describe replicated maps, destructibles, NPCs, enemies, and simple sword actions. | Explicit unfinished saving, equipment synchronization, movement, and hero actions. Delegated client mob simulation needs redesign for valuable shared resources. |
| [ZQuest Classic](https://github.com/ZQuestClassic/ZQuestClassic) | Mature Zelda-like quest engine/editor with an [experimental browser player](https://web.zquestclassic.com/play/). | Browser availability is verified from official docs; this task has not completed a quest playthrough or integrated it into PlankSpace. |
| [Harbour Masters / Shipwright](https://github.com/HarbourMasters/Shipwright) | Official source-port project relevant to Ocarina of Time and Kokiri Forest-style 3D world research. | Not a browser MMO toolkit, and required original resources were not supplied/extracted here. Avoid unrelated search-result forks claiming to be official ports. |
| [Tuxemon](https://github.com/Tuxemon/Tuxemon) | Acquired open creature RPG source; project documents JSON game data, Tiled maps, encounters/creatures, items and interaction systems. | Python runtime and its own game model; no native integration into the current browser app yet. |
| [Flare](https://github.com/flareteam/flare-game) | Complete isometric action RPG reference with Tiled source maps and editable art sources documented upstream. | Dark fantasy presentation and single-player architecture; research reference, not yet acquired. |
| [RPGJS](https://github.com/RSamaium/RPG-JS) | Upstream v5 beta documents browser map rooms, events, movement/collision, inventory/skills and authoritative multiplayer architecture. | A framework, not an authored Zelda-quality game; beta claims need runtime validation. Possible browser integration candidate, not selected simply from its README. |

## Top-down versus isometric

Classic Zelda, Pokémon Emerald, and Graal's familiar presentation are primarily top-down/oblique tile worlds rather than diamond-isometric terrain. The distinction matters because the previous diamond island composition did not match the reference. We should preserve the reference camera, pixel density, character-to-building scale, tile transitions, and visual hierarchy first. Rich 3D effects are an extension, not a reason to discard that everyday presentation.

I found isometric action-RPG engines and Zelda-like repositories, but have not verified a complete, mature isometric Zelda MMO repository that supplies everything requested. Flare is a genuine isometric reference; Solarus is a more direct classic-Zelda reference.

## Why Emerald infrastructure is useful

The imported map definitions contain connections, layouts, weather, map type, NPC/object events, script references, coordinates and warps. The codebase also has field camera/player control/door systems, berry planting/growth/watering/yield functions, and battle/capture machinery. This is materially different from harvesting sprite sheets.

The new `index-reference-worlds.mjs` indexes the map graph without executing imported code. It records source revision `5eff78649e7170a877b961ef0b3da13b81a16038`, map/object/warp definitions, and 45 destinations that need special handling or resolution beyond the static map-ID set. Those are flagged rather than silently assumed valid. This index is not a port of the event interpreter, collision system, or encounter engine.

Possible reuse paths:

1. Run the original implementation as a controlled behavioral baseline, with its existing assets and content.
2. Adapt its game source directly for a prototype where the platform constraints are acceptable.
3. Extract validated world definitions and migrate semantics into an extensible runtime where browser/MMO requirements demand it.

The choice must preserve behavior through tests. Copying C files into Next.js does not make them executable browser services. Conversely, GBA origins do not make reuse impossible. The engineering work is platform adaptation, authority separation, and compatibility—not inventing portals and NPC interaction from scratch without studying the existing systems.

## Integrated acceptance sequence

1. **Unmodified reference acceptance:** start the game, move, transition between exterior/interior maps, talk to NPCs, fight, use items, save, reload. Record camera, input timing, collision and audio behavior.
2. **World modification:** turn a selected town/forest region into a homestead district while preserving its authored density and transitions. Add cultivable plots and production interactions through the existing event/interaction machinery.
3. **Creature loop:** preserve encounter and capture semantics in the chosen prototype; define stable original-replacement creature IDs.
4. **Skills and gear:** add validated progression and equipment requirements. Preserve item/quest state through transitions and saves.
5. **Shared authority:** move economically consequential state out of local saves. Validate two accounts, reconnects, retries, concurrent actions and private/public state boundaries.
6. **PlankSpace integration:** connect the same account to profiles, homes, posts, charm expression and community contributions. Navigation links alone do not pass.
7. **Grained Exchange:** implement native escrow and trading before representing external settlement. Preserve the distinctions in the full product specification.
8. **Bespoke replacement:** replace assets and implementation units while regression tests preserve interactions, map transitions, encounter results, economy conservation and performance. Review each replacement visually at the reference pixel density and in motion.

The full MMO specification cannot be tested merely by running an unchanged single-player game. The unchanged game proves the baseline; each added shared/social/economic capability needs its own end-to-end checks before the overall specification can pass.

## Current status

The current localhost frontier remains the earlier rejected visual experiment; it has not secretly been replaced by a fully integrated Zelda/Emerald engine. The complete game sources above have now been acquired or located as specified, and the Emerald map graph is indexed. No new engine has yet been compiled, played through, or connected to production accounts in this audit. The next useful proof is a working established adventure baseline and a faithful modified district, not another sparse generic 3D scene.
