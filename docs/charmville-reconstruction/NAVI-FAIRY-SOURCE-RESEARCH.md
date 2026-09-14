# Fairy animation and customization architecture

Navi's recognizable form is a luminous core with four animated wings, supported by purposeful following, attention, dialogue, color and light behavior. A flat gold figure with a floating transform does not reproduce that visual system. The implemented Journal replacement therefore uses a white orb, blue aura and four individually animated wings, with an attention state while reading. It is original source-informed art. It is not an extracted Nintendo model or a claim of native in-world companion completion.

## Original-game evidence

The Ocarina of Time fairy actor initializes a skeleton and animation, updates skeletal motion, controls two lights, blends attention colors and draws translucent geometry. The body limb receives a sinusoidal scale adjustment; four designated wing limbs can be omitted for large fairies. The drawing path modulates environment alpha and disappearance independently from body color. This architecture separates movement, appearance and interaction rather than relying on an animated GIF. These are directly observable source behaviors, not an inference from screenshots. [Fairy actor, pinned revision](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/src/overlays/actors/ovl_En_Elf/z_en_elf.c).

The asset manifest specifies a 32×64 intensity wing texture, four vertex arrays with four vertices apiece, four display lists, an animation and a skeleton. Those declarations identify the necessary pieces for a faithful extraction and conversion. A runtime could project the same rig into multiple camera angles without independently redrawing every action. That is a proposed conversion path, not a completed exporter. [Asset manifest](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/assets/xml/objects/gameplay_keep.xml).

The checked-in skeleton translation unit references generated include files for wing texture, vertices, display lists and limbs. The animation translation unit likewise references generated frame data, joint indices and header. Their presence does not mean the required binary asset values are bundled. The actual include data was not found in the inspected checkout or current Charmville asset folders. [Skeleton source](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/assets/objects/gameplay_keep/fairy_skel.c), [animation source](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/assets/objects/gameplay_keep/fairy_anim.c).

The repository explicitly documents an asset-extraction dependency on a prior game copy and states that its assets are not included. It describes itself as a decompilation rather than a PC port. Consequently, a Git clone alone is not a usable Navi asset delivery mechanism. No ROM or extracted Nintendo asset was acquired or bundled in this change. [Repository build requirements](https://github.com/zeldaret/oot/blob/cbe814b25455f14a343a7457c4b1c92af40ede6a/README.md).

## Modern port lessons

Shipwright exposes distinct primary and secondary Navi colors for idle, NPC, enemy and prop situations. Its default idle pair is a white core and blue secondary color. This is useful evidence for separating a visual skin from semantic attention state. Charmville should preserve an independent target marker even when a player changes the fairy's preferred colors, so a cosmetic selection cannot disguise an enemy as a friendly character. The latter is a Charmville design recommendation, not behavior claimed for the port. [Cosmetics editor](https://github.com/HarbourMasters/Shipwright/blob/ea348bc9fbfb6407a6c9bd8864df4d10c6d46b05/soh/soh/Enhancements/cosmetics/CosmeticsEditor.cpp).

A project-maintained cosmetics issue records color popping, preview mismatches and clamping problems, including cases where dissimilar color channels produce black regions. These reports show why merely offering a color picker does not establish consistent rendering. Validate blend equations and continuity at spawn, targeting, zone changes and restoration. The issue is qualitative defect evidence, not a current performance benchmark or proof that every listed defect remains. [Maintainer issue #2113](https://github.com/HarbourMasters/Shipwright/issues/2113).

## Candidate resource routes

| Route | What is available | What it establishes | Integration decision |
|---|---|---|---|
| zeldaret OOT | Actor source, asset declarations and extraction workflow | Detailed reference behavior and conversion inputs | Use as a reference; actual Navi requires the missing extraction inputs and provenance review |
| Shipwright | Port source and state-aware cosmetic controls | Modern customization patterns | Adopt separation of skin, attention and state; do not infer bundled game art |
| Solarus free resource pack | Creative Commons art catalog with per-file license information | A route for attributable original 2D assets | Inspect the exact proposed sprite and attribution before importing |
| Existing Solarus ZSDX reference | Current local fairy item script and shared item sheet | Existing project reference behavior | Do not confuse a collectible healing fairy with an account-bound guide |
| Original Charmville orb rig | Four-wing SVG, bounded motion, three local palettes | A working menu presentation now | Active fallback, explicitly identified as original art |

Solarus distinguishes its ALTTP-derived pack from its free pack. The free-pack license lists mostly CC BY-SA data, GPL scripts and some public-domain exceptions; it does not permit treating every Solarus-associated file as one uniformly licensed art library. The archived GitHub mirror is useful for attribution history but is not the current development repository. This review did not identify and import a complete licensed Navi-equivalent sprite set. [Resource-pack directory](https://gitlab.com/solarus-games/resource-packs), [free-pack license](https://github.com/solarus-games/solarus-free-resource-pack/blob/dev/license.txt), [current free-pack location](https://gitlab.com/solarus-games/resource-packs/solarus-free-resource-pack).

## Implemented presentation contract

The four wings pivot around one central anchor. The lower pair has an offset phase. The orb remains visible throughout its cycle; aura breathing changes intensity without removing the character. Idle uses a slow two-pixel hover. Reading activates a slightly larger, slower aura instead of flashes or repeated exclamation effects. Reduced-motion disables all oscillation and preserves the complete silhouette.

The default is Classic blue. Warm gold and Leaf green are optional browser-local preferences under the same validated profile namespace as the reading bookmark. They do not create an inventory item, skin entitlement, server purchase, healing buff or new companion. Only three internal IDs are accepted; there is no arbitrary SVG, URL or script upload through this selector. The visible label states the storage scope.

The SVG uses no external image, script, font, filter kernel or audio. Its core, wings and aura are independent rendering parts. Unique gradient IDs allow multiple portraits in one document without cross-instance paint collisions. This is suitable for a small UI portrait; it is not a measured solution for thousands of world actors. Large crowds should use pre-rendered atlases or a batched renderer rather than one animated DOM tree per fairy.

## Path to authentic and customizable world models

1. Resolve the actual model package and source revision. Record author, rights, content hash and extraction inputs without distributing unreviewed raw sources.
2. Parse skeleton, animation, display lists and textures into a canonical visual rig. Retain original scale, handedness, limb parenting, frame timing and attachment origin. Define exactly how a top-down camera derives projected anchors.
3. Export from that rig into a browser mesh and deterministic sprite atlases with the same animation names. A GIF/MP4 is review or social media output, not the simulation's animation authority.
4. Record states for idle, follow, attention, dialogue, recover, disappear and reappear, with explicit transitions and loop boundaries. Require front/back layering, zoom, interpolation and frame-advance review.
5. Keep the account-bound companion identity and restorative abilities on the server. A local model or palette change cannot alter collision, reach, cooldown, threat, health or ownership.
6. Permit reviewed skins to replace appearance through manifest IDs. Animation compatibility, anchor bounds, alpha coverage, size budgets and reduced-motion behavior must pass before activation.
7. Test reconnect, camera changes, party travel, private/public transitions and spectators with the same companion ID. A rendered guide must not duplicate when both native and host layers reconnect.

## Evidence and remaining uncertainty

Source revision inspected: zeldaret/oot `cbe814b25455f14a343a7457c4b1c92af40ede6a`; Shipwright `ea348bc9fbfb6407a6c9bd8864df4d10c6d46b05`. Access was September 14, 2026 UTC. Source references above are pinned where available. The existing story and journey protocol is unchanged. Actual native follower, healing, model extraction, world lighting and multiplayer rendering acceptance remain separate unfinished work. This replacement improves a visible menu asset and its interaction states; it does not certify a full cinematic or authentic model pipeline.
