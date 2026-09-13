# Native action audit and unified-world contract

## Findings from the collected source

ZQuest Classic `src/zc/ffscript.cpp`, `FFScript::getHeroOTile`: walk/stab/slash use directional tables. The land one-hand hold-up uses `holdspr[0][0]` and ignores direction. It is a treasure presentation, not a four-direction carry animation. The previous farming adapter incorrectly used it for harvesting. Removed that selection.

ZQuest Classic `src/zc/hero.cpp`, `handle_lift`, `can_lift`, `lift`: lifting maintains a weapon entity, lift clock, height and direction. The object travels from the facing tile toward the hero and rises through Z; large objects use different centering offsets. Carrying keeps that same entity. Native action eligibility and swimming restrictions matter. A DrawCombo above a character supplies none of this behavior.

Solarus ZSDX `data/sprites/hero/tunic1.dat`: lifting has five 48x24 frames per direction at 100 ms with origin (24,21). Carrying uses separate stopped/walking animations, 24x24 frames and origin (12,21); walking frame counts differ by direction. Bow, sword loading and shield-aware movement have their own definitions. These are engine-specific profiles, not interchangeable sheet rows or blanket scaling rules.

Current runtime: GetOriginalTile and TileMod work; GetOriginalFlip aborts the hosted engine. Therefore the adapter's directional flip remains unverified. Loading an LPC sheet at width 832 was verified; correctly rendered and aligned tool layers were not. No claim of source-faithful tool animation is justified yet.

## Corrections in this checkpoint

Removed the incorrect treasure hold-up selection and the arbitrary map flower drawn as a held item. Retained the existing provisional reach/stab pose. Added cancellation on health loss, displacement or incompatible native action, restoring script sprite overrides. Screen transitions already restore overrides. These changes prevent farming poses from persisting through native knockback or other actions; the browser regression checks the normal farming path, not every interruption case.

## Required action representation

Each action needs: stable action and item identities; allowed actor states; native animation profile and direction mapping; exact frame timing; body, hand, shield and tool layers; per-frame grip origin and depth ordering; separate visual bounds and collision bounds; contact event; recovery; interruption; sound and environment feedback. Unknown asset mappings must remain explicitly unresolved.

Pick up: reserve a specific world object; validate reach and obstruction; play directional lift; move that object's own art to the grip; transfer ownership once. Carry: retain the object identity, animate locomotion with occupied hands, preserve collision policy. Throw: detach that object once, use facing and a defined trajectory, collide and resolve breakage/drop once. A treasure fanfare is a different action.

Hoe, axe and pickaxe require distinct tool arcs and impact timing, target materials and depletion. Watering needs can tilt and a stream landing on the selected plot. Fishing needs rod cast, line, bobber, bite, reel and outcome. Sword, shield, bow, bomb and magic retain native action timing and weapon entities; farming must not overwrite their states.

## One world across the inspirations

Use one authoritative entity/item ledger and action timeline. Rendering adapters preserve the chosen visual style; they do not create separate inventories or independent copies of creatures. Zelda-style contact damage and a turn-based creature encounter update the same HP/status entity. Capture changes ownership once. A follower is that owned creature in world movement mode.

Farm production feeds gathering/crafting, equipment and settlement construction. Private plots connect to shared regions, towns, wilderness, industry and later planetary travel. Civilization and galaxy progression extend the same location/ownership model. They are not separate minigames with disconnected balances.

A charm definition identifies a resource, collectible or reaction representation; player ownership and economic events are independent of the animation. Social reacts must have explicit consume/transfer/display rules. Exchange settlement must be authoritative and idempotent. Client-side animation completion must never mint tradeable inventory. Real-money integrations remain separate from this guest prototype's session counters.

Memetic value comes from recognizable action grammar: lifting a prized object, a readable sword arc, a capture anticipation beat, a familiar gathering rhythm, a visible transformation. Gamer value comes from timing, readable targets, consistent collision and fair outcomes. Recognition alone does not replace those mechanics.

## Acceptance gates

1. Inspect every action in four directions with shield/equipment variants; mark exact sprite and grip origin, windup/contact/recovery frames.
2. Test against a wall, diagonal target, moving target, damage, scene transition, rapid input and controller input.
3. Match held and thrown art to the exact item; verify one object/one reward through cancellation and retries.
4. Observe the same action and outcome from a second authenticated player, including reconnects.
5. Persist inventory/property/creature state and integrate PlankSpace sessions before advertising a public shared-world playtest.

Current status remains a local native-quest prototype with guest pose replication. Authenticated MMO, authoritative economy, creature systems, civilization and galaxy gameplay are not implemented by this checkpoint.
