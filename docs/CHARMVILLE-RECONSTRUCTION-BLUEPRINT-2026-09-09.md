# Charmville reconstruction blueprint

Approved direction and execution contract • September 9, 2026

## Binding creative decisions

The user approved all six proposed instincts. Treat these as decisions rather than reopening the interview:

1. A mysterious woodland arrival opens quickly into an inhabited town.
2. A charm identity can manifest as a creature, crop, material, ornament, and social expression. These manifestations share identity but do not automatically share ownership, scarcity, or redemption rights.
3. Continuous action is the normal adventure mode. Particular creatures, challenges, and competitions can use staged encounters.
4. A player can enjoy an independent life. Advanced production and civilization projects benefit strongly from specialists and trade.
5. Everyday expression is easy. Scarce rewards come from bounded, meaningful participation rather than unlimited self-generated engagement.
6. The woodland world has a coherent surface and gradually reveals stranger layers, technology, space, and extraordinary events.

The rejected diamond-isometric district is not a visual target. Begin with mature authored adventure content, its camera and character scale, and its interactions. Retain useful account/economy infrastructure and reference experiments, but do not confuse them with accepted game design.

## What the research foundation must contain

Every adopted source needs an immutable revision, complete asset bytes, build instructions, dependency versions, authorship information, gameplay entry points, map/portal definitions, save semantics, and tests or observed play evidence. A clone alone passes acquisition, not execution or reconstruction readiness.

The accompanying `source-evidence/source-lock.json` records 16 selected source collections. Each repository has a separate file manifest with relative path, byte length, SHA-256, and detection of unresolved Git LFS pointers. The lock also records submodule status. The reproducible generator lives at `scripts/charmville/audit-reconstruction-sources.mjs` in the implementation checkout. No imported source is executed by the audit.

Preserve the difference between these evidence levels:

| Level | Required evidence |
|---|---|
| Located | Verified source identity and repository or resource location |
| Acquired | Files downloaded; asset pointers and missing dependencies identified |
| Reproducible | Revision, hashes, build recipe, dependency versions and toolchain recorded |
| Running | Actual engine starts with the intended content |
| Behavior verified | Recorded interactions and state changes match the reference |
| Adapted | Charmville additions operate without breaking verified reference behavior |
| Integrated | Two authenticated accounts, persistence, social effects and economic invariants work together |
| Reconstructed | Bespoke code/art replaces the reference while passing the same behavior and visual checks |

Current work is principally acquisition, source inspection, and reproducibility. The full original-game runtime and integration levels have not been passed.

## Source coverage by intended influence

| Influence | Material currently available | Still required |
|---|---|---|
| Zelda action adventure | Solarus engine, ZSDX full quest, Trillium, MIT Starter, Zelda3 source, ZQuest source/assets | Run and benchmark the selected engine/content pairing; original Zelda3 resource extraction is not complete |
| Pokémon Emerald | Full decompilation source; 518 map definitions, 1,313 warps and 2,776 object events indexed | Reproducible toolchain/build and field/encounter/capture playthrough; special warp destination handling |
| Graal | Graal Reborn server, discovered OpenGraal editing projects, Solarus Online comparison | Verified compatible client/world package; no complete official Classic/Era production source archive established |
| RuneScape / OSRS | Prior source research distinguishes RuneLite client and Lost City reconstruction projects | Pin and acquire selected server/content source; prove skills, inventory and exchange behavior rather than assume client code supplies it |
| Animal Crossing | Design/customization research | No complete reusable official game source/assets established; specific interaction and art reference capture still needed |
| FarmVille | FarmVillage, FV-Replowed and other local farming references; Emerald berry code | Determine runnable completeness and external asset dependencies; reproduce cultivation and visit loops |
| SimCity / settlement games | Local Micropolis-related reference plus LinCity-NG and Unknown Horizons material | Establish which checkout contains executable simulation and complete art; validate public-work and production behavior |
| EVE | Official manufacturing/economy research | No official server source or full original asset corpus established; reconstruct industrial contracts from observed/documented behavior |
| Minecraft-like construction | Prior Luanti/Veloren research and construction references | Acquire a chosen implementation if voxel/mod-world behavior is adopted; do not assume arbitrary scripts are safe in the shared economy |
| No Man's Sky | Approved exploration/expansion inspiration | No official source/assets established; define original travel, discovery and off-world settlement systems later |
| Memoji market | Acquired source and all 78 parsed denom identities | Full current live registry discovery, network/pool verification, custody/issuance design and settlement adapters |
| Original creature RPG | Acquired Tuxemon source and content | Runtime validation, per-creature data/asset mapping, and selection of behavior to adapt |

“Every title” is the coverage objective. It is not a claim that inaccessible proprietary source exists or has been acquired. Missing entries remain explicit work, not silently replaced by similarly named clones. The user's stated prototype permission is recorded; keep source/replacement tracking practical and do not repeatedly reopen that permission question.

## Foundation choice and version control

Use **Solarus + Mystery of Solarus DX as the first action-adventure reference baseline**. It supplies authored environments and the interactions that the sparse custom renderer failed to convey. The newly cloned Solarus development head identified itself as 2.2.0; it has now been pinned to release **v2.1.3**, commit `72d81668d6902b99338bbe1926a7d048ec1d3476`. The acquired quest declares a Solarus 2.0 format, which needs runtime compatibility verification rather than an assumption.

Use **Emerald as the field/encounter/capture baseline** and **ZQuest as the established browser-adventure comparison**. The ZQuest acquisition includes Git LFS material; audit that material before treating the checkout as complete. Web delivery and MMO authority remain separate acceptance gates. Do not choose a final runtime from a README's feature list alone.

Keep clean reference snapshots distinct from modified adaptations. Each adaptation records its upstream revision and explicit patch set. No line-by-line replacement begins without a baseline behavior record for the affected system. A literal one-to-one rewrite is not always appropriate; preserve externally observable behavior while allowing a different architecture where multiplayer and persistence require it.

## Functionality preservation contracts

| System | What must be recorded and preserved | Required test |
|---|---|---|
| Movement | Speed, acceleration if any, facing, animation frames, diagonal rules, collision footprint | Timed path with wall, corner, narrow doorway and input interruption |
| Camera | Logical resolution, pixel scaling, bounds, scrolling and transitions | Same route at desktop/mobile sizes with no hidden interaction targets |
| Sword | Wind-up, active frames, reach, direction, recovery, grass/destructible/enemy response | Hit and miss cases, repeated input, boundary and cooldown checks |
| Bow | Animation timing, projectile spawn, ammo cost, collision and equipment variants | Empty quiver, last arrow, interrupted shot, obstacle hit, duplicate command |
| Bombs | Bag eligibility, quantity, placement, fuse, blast range and destructible rules | No bag, no ammo, placement failure, blast boundary, reconnect during fuse |
| Shield | Facing, blockable categories, animation, movement restrictions | Frontal/side/rear attack and incompatible attack types |
| Magic | Meter, costs, cast timing, effect lifetime, target rules | Insufficient meter, interrupted cast, expiration, concurrent costs |
| Hearts/damage | Health units, invulnerability window, knockback, death and recovery | Multiple simultaneous hits, healing cap, respawn state |
| Grass/gathering | Cutting animation, drop rules, respawn and item ownership | Two actors target one object; exactly one allowed outcome |
| Portals | Map/room IDs, entry position/facing, transitions, conditions | Enter/exit every connected test doorway; save/reload on both sides |
| NPCs/dialogue | Facing, trigger range, branches, flags, rewards | Repeat conversation, quest-state changes, duplicate reward attempt |
| Encounters | Eligible habitat, trigger/cooldown, species selection and escape | Seeded reproducible encounter fixture and canceled transition |
| Capture | Device consumption, eligibility, probability/state, result presentation | Success/failure/full-party cases and retry without duplicate companion |
| Farming | Planting constraints, phases, watering, yield, compost and reseeding | Timestamp boundaries, missed visits, offline maturation and concurrent harvest |
| Skills/gear | XP source, level requirements, equipment slots, modifiers and repair | Unequip mid-action, invalid requirement, duplicate XP event |
| Crafting | Ingredients, station, duration, outputs, cancellation policy | Insufficient inputs, concurrent jobs, restart, exactly-once output |
| Exchange | Asset identity, precision, escrow, matching, cancellation and receipts | Partial fill, competing orders, retry, failure and restart conservation |
| Social charms | Expression/consumption meaning, target post, privacy and attribution | Account switch, deleted post, duplicate submission, self-reward limits |
| Civic works | Proposal, permissions, requirements, contributions, completion | Competing contributions, revoked role, completion exactly once |
| Creator content | Asset/schema version, dependencies, collision, behavior and ownership | Publish, reject, rollback and old-save compatibility |

Source observations already support this level of detail: ZSDX's `data/items/bow.lua` delays arrow consumption by 300 ms and changes variants when ammunition is empty; `data/items/bomb.lua` checks bomb-bag eligibility before allowing bomb pickups. Emerald's `src/berry.c` includes growth-stage, watering and yield helpers. Tuxemon has capture code and capture/teleporter tests. These must inform the adaptation instead of being replaced by invented generic behavior.

## First integrated district

The district should have an authored woodland approach, a commons, at least one functioning home interior, a cultivable parcel, an encounter habitat, a workshop, a public project, and a market location. Their connections must be playable and meaningful; duplicating the same cottage model does not satisfy place-making.

The initial narrative is discovery rather than exposition. The player arrives, learns movement through the environment, performs a useful action, meets someone, discovers a charm manifestation, and gains a reason to return. The town introduces social possibilities and a home. The first strange event hints at the larger world without turning the opening into a science-fiction dashboard.

A charm's identity is stable across its manifestations. A wild creature, seed, harvested ingredient, display object, reaction and external token may relate to that identity, but transformations require explicit recipes/rights. This is the common vocabulary that makes the world feel unified without collapsing distinct assets into one ambiguous balance.

## Authority and PlankSpace integration

Use existing PlankSpace identity and verified sessions. Keep public profiles/homes separate from private inventory and progression. One account can have multiple credentials without automatically becoming multiple economic people.

The client presents and predicts; shared authority validates consequential actions. Durable inventory, escrow, crafting, capture results and civic contributions need transactions and idempotency. Realtime position, crop timestamps, production jobs, social posts and chain confirmations have different timing requirements.

Do not import single-player saves wholesale as trusted MMO state. Create explicit migration contracts for character, flags, inventory and discovered content. Imported scripts need capability boundaries: a dialogue script may propose a reward, but it must not mint unrestricted balances or issue arbitrary server calls.

Native game exchange and external DeFi settlement remain separate venues with unified discovery. Establish native item conservation and account correctness first. A cached pool reference is not live liquidity; a reaction is not a token balance; an icon is not proof of ownership.

## Bespoke reconstruction method

For each replacement, retain: reference asset/source ID, intended role, original behavior capture, adaptation patch, new source file, export recipe, compatibility notes and acceptance result. Preserve pivots, timing, collision, interaction clarity and visual hierarchy as deliberately as color and silhouette.

Replacement groups should be coherent: character body plus wardrobe plus animation; terrain plus edge transitions plus collision; weapon plus effects plus sound plus hit timing. Repainting individual images without checking their system context can degrade the game even when each image looks attractive alone.

No replacement passes merely because it is original. It must preserve recognizable interaction and improve Charmville's own identity. Retain reference screenshots/input recordings for comparisons, and test at actual play scale rather than only enlarged art previews.

## Execution order and stop conditions

1. Finish pinned sources/dependencies and record missing files. Do not spend time polishing missing-asset fallbacks.
2. Run the intact Solarus quest and Emerald baseline with reproducible build/runtime instructions. Record what actually runs.
3. Select the browser delivery path using a real ZQuest/Solarus compatibility experiment, including audio, saving, mobile input and loading. Native success alone does not pass the browser requirement.
4. Modify one authored district while retaining the baseline's richness and transitions.
5. Connect the cultivation/crafting/encounter loop; then prove two-account shared state.
6. Integrate post expressions, native exchange and civic work with transactional tests.
7. Expand content and regions only after handoff/recovery/performance gates pass.
8. Reconstruct bespoke systems and art in coherent groups, maintaining the reference contracts.

If a source cannot build, record the exact dependency/error and try a supported release/toolchain. If an engine cannot satisfy a critical browser or authority constraint, change the engine choice before rebuilding large quantities of content. If the scene fails the user's nostalgic visual standard, change the art/world foundation rather than decorate the surrounding UI.

## Current deliverable boundary

This blueprint, the pinned sources, file manifests, and functionality contracts strengthen the reconstruction foundation. They do not claim that the original games have already been compiled, that the MMO works, or that the rejected frontier has been replaced. The existing local link remains available; no new playable engine integration was completed during this source-planning pass.
