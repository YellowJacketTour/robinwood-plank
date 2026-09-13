# Sprite lighting: remaining explicit context migration

Source audit: sibling `../charmville-references/zquest-classic`, engine commit `72093a3`, 2026-09-13. Line numbers refer to that checkpoint. This document records a migration plan, not an activated camera. No engine source was changed for this audit.

## Implementation checkpoint after this audit

Engine `53e4bc5` implemented the atomic sprite-context migration below: 94 draw/helper definitions, 183 explicit nested forwards and 46 compile-time member-pointer contracts. Full player compile/link passed; shared/editor objects compiled. The new context flows through all 40 specialized enemy draw overrides, Hero/lifted weapons, items, moving blocks, FFC virtual drawing, decorations, lists and map composition. Existing default calls remain supported. These changes were exported as portable patches; the live package was not replaced.

Engine `159cadb` then routed the lens-over script command through the scene pair. Focused maps/zc_sys object compilation passed. Its old public overload, original viewport reads, fixed mask dimensions, radius caching, blit rectangle and lens-clock phase remain unchanged. Therefore the **lens raster itself still needs a larger-camera contract**.

Remaining activation blockers: bind the owned world/darkness/light planes to one frame transaction and initialize them before START_FRAME and script accumulation; reproject the retained spotlight snapshot into that transaction; implement the expanded lens raster or an explicit candidate exclusion; separate final world-camera projection from HUD/text composition; preserve transition/map-capture legacy paths; compare legacy-sized scene and darkness outputs before promoting a single-pass enlarged candidate. Compile and static contracts are not visual or gameplay parity proof. This historical inventory remains below as the source trail and test checklist.

## Current boundary

The six-argument do_primitives accepts borrowed script_world_light_targets and routes effective Region/Sprite origins outside screen scrolling only when both planes exist. Screen, PlayingField, offscreen bitmap and transition origins retain legacy behavior. Direct scene calls, layer helpers, sorted moving-block layer scripts and region FFC layer calls now carry explicit pairs. Nested virtual sprite draws remain incomplete.

## Exact remaining primitive callers

| Source anchor | Owner and phases |
| --- | --- |
| src/zc/hero.cpp:2787-3581 | HeroClass::draw: sprite-target UNDER 2789, scope-exit OVER 2792, UNDER_PLAYER 2795, PLAYER 3581. Preserve herodraw_end and offset restoration. |
| src/zc/hero.cpp:3584-3649 | HeroClass::masked_draw: OVER_LIFT_WEAPON / OVER_PROMPT_COMBO at 3615/3617 and 3636/3638, in doorway and ordinary branches. Lifted weapon has another nested pair. |
| src/zc/guys.cpp:4119-4315 | enemy::draw: UNDER 4128, scope-exit OVER 4134 after hide_hitbox restoration. Preserve invisibility/flicker returns and didScriptThisFrame assignment. |
| src/zc/weapons.cpp:7481 | weapon::draw: UNDER 7483, scope-exit OVER 7486, surrounding dying/falling/drowning and weapon-specific returns. |
| src/items.cpp:309 | item::draw: UNDER 311, scope-exit OVER 314, surrounding NODRAW/tile/forced-grab/flicker returns. Base draw at 340. |
| src/sprite.cpp:2919 | movingblock::draw: UNDER 2921, scope-exit OVER 2924. Layer overload at 2987 reaches this path. Already-routed map SPLAYER_MOVINGBLOCK is a separate phase. |

All sprite-target pairs retain their actor UID; ordinary layers retain UID 0. The original overload supplies offsets exactly `(0, playing_field_offset)`. Do not replace these with sprite offsets, actor position or doorway sub-bitmap offsets: each command resolves its own DrawOrigin.

Base sprite::draw (src/sprite.cpp:1002) has **no direct script pair**. The sprite.cpp pair belongs to movingblock. Decorations have no direct do_primitives calls either. Do not invent extra script phases for either; their draw/glow chains still require forwarding.

Other remaining paths:

- src/zc/zc_sys.cpp:3077-3102, draw_lens_over: SPLAYER_LENS_OVER plus legacy viewport/256-width raster. Needs a separate lens contract.
- src/zc/hero.cpp:28616/28665 and 29667-29855: transition/scroll layers. Leave legacy until transition target/coordinate migration.
- src/zc/maps.cpp:4201: do_scrolling_layer FFC call still uses old draw_ffc. Region FFC composition is routed; scrolling remains intentional legacy.
- script_drawing.cpp bulk primitive helper and zq/zquest.cpp:22010/22014 editor stubs are separate, not sprite hooks.

## Additional global light writers

src/zc/zc_sprite.cpp:13-46, sprite::handle_sprlighting, computes center from hitbox dimensions, optional hit offsets and directional glowOffset, adds playing_field_offset and calls handle_lighting with darkscr_bmp. Preserve NEW_DARKROOM, is_any_room_dark and glowRad guards while adding paired targets.

src/zc/zc_sprite.cpp:279-303, movingblock::handle_sprlighting, checks active state, calls base glow, then adds cTORCH combo light to darkscr_bmp. Both need the same pair. Keep their existing sequence and count.

Base sprite draw calls glow before visibility returns (sprite.cpp:1005). Moving-block draw calls glow at 2927 and can then reach base draw in some branches. Do not deduplicate or move glows to a prepass without evidence; preserve legacy counts. Editor no-op implementations at zq/zq_sprite.cpp:10/23 must track any virtual signature change.

## Explicit propagation design

Use a borrowed immutable context carrying paired world-light targets, or the pair pointer directly. No global/thread-local current context, bitmap-address registry, or mutable context member on gameplay sprites. No inference from destination bitmap: doorway sub-bitmaps and screen-space commands make that wrong.

The smallest correct hierarchy migration appends a context parameter to the **existing virtual draw signature**, with nullptr defaults on base and derived declarations. Update overriding declarations/definitions together and mark overrides explicitly. Existing source calls retain behavior; the native ABI changes and requires a full rebuild. This is not binary compatibility.

Do not add only enemy::draw(dest, context) alongside the old virtual: dispatch can select the inherited enemy implementation and bypass specialized monsters. A new context virtual that defaults to old draw preserves art but silently loses context inside old base calls; that is staging, not complete propagation.

The 41 guys.cpp draw definitions are enemy plus these 40 derived classes:

guy, eFire, eOther, eScript, eFriendly, eGhini, eTektite, eItemFairy, ePeahat, eLeever, eWallM, eTrap, eTrap2, eRock, eBoulder, eProjectile, eTrigger, eNPC, eSpinTile, eZora, eStalfos, eKeese, eWizzrobe, eDodongo, eDodongo2, eAquamentus, eGohma, eLilDig, eBigDig, eGanon, esMoldorm, esLanmola, eManhandla, esManhandla, eGleeok, esGleeok, ePatra, esPatra, ePatraBS, esPatraBS.

Forwarding surfaces:

1. sprite_list::draw (2255), draw_smooth_maze (2269), draw2 (2324), drawcloaked2 (2338). Preserve list direction, maze clips and auxiliary passes. Audit shadow methods for nested context-dependent calls rather than assuming they all write light.
2. maps.cpp sorted draw_sprites: Hero, carried-Hero enemy, enemy draw/draw2 and generic virtual dispatch. Also classic-order lists, direct Hero, chainlinks, portals, items and decorations.
3. Every derived enemy draw and qualified enemy/base draw, drawzcboss, drawcloaked, masked and multi-tile helper. Defaults make missing forwarding compile, so use call-site/AST coverage as well as compilation.
4. Hero draw to masked_draw to base/lifted weapon. Doorway sub-bitmap clips color; light coordinates retain their own space. Preserve lifted z/fakez/shadow restoration and handle_lift timing.
5. Moving-block virtual and layer overloads/glow override; item/weapon; FFC virtual draw to existing explicit draw_ffc.
6. Decoration draw/draw2/realdraw chains: comboSprite and dDivineProtectionShield have two phases; customWalkSprite overrides realdraw. decoration inherits base draw, so qualified decoration::draw needs forwarding. Direct tile-drawing leaf effects still need matching virtual declarations.
7. Shared/editor implementations and temporary sprites such as tempsprite_shadow. Shared headers must not require player-only headers just to carry two bitmap pointers.

Context is valid only during synchronous draw. Scope-exit callbacks finish before return; never retain this borrowed pointer in queued script commands. Ownership remains in the renderer.

## Required proof before activation

- Compile all changed objects and full player link; compile shared/editor definitions. Enable/check override diagnostics for hidden signatures.
- At legacy dimensions compare indexed scene, opaque and translucent plane bytes against current behavior across classic/sorted order, subscreen order and darkroom modes.
- With alternate planes, snapshot global planes: Region/Sprite scripts should modify only supplied planes; Screen/PlayingField/offscreen/scroll cases intentionally retain legacy routing. Cover all light shapes/default parameters and per-UID filtering.
- Exercise Hero, item, weapon, moving block, ordinary enemy, masked Wallmaster, multipart boss and two-phase decoration. Script hook count/order must match on visible and early-return frames.
- Preserve qr_OLD_WEAPON_DRAW_ANIMATE_TIMING, enemy script flags/hitbox state, lifted state and glow invocation counts. Never run a second draw pass to compensate for missing propagation.
- Cover doorway clips, smooth mazes, carried Hero, lifted weapon, invisibility, flicker, falling/drowning and sprite removal after command queueing.
- Keep expansion disabled until initialization, lamp, glows, scripts, FFC and lens/transition decisions share a reviewed coordinate/target contract. Terrain and actors must not be lit into different buffers.

## Bounded implementation order

Atomically establish the shared virtual interface and defaults without activation. Then explicitly forward one complete branch (item plus base glow is smaller than enemy hierarchy), prove legacy parity, and continue moving block, weapon/Hero, enemy hierarchy, lists/maps and auxiliary paths. Report remaining call paths rather than percentages inferred from lines changed. Alternate-target activation remains a separate milestone.
