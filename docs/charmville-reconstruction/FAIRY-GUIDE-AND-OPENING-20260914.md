# Fairy guide and opening continuity

## Implemented in this change

The Journal contains an original illustrated fairy guide with short dialogue, a practical next action, and a six-page family-opening replay. This replaces its duplicate first-step heading and primary action rather than adding another panel above gameplay. All forward progress is read from the existing authenticated journey endpoint. Unknown/loading status never becomes a new-game invitation. Profile changes reset presentation through the component key. Reading, skipping, and repeating the scene grants nothing and does not alter location, inventory, or completed lessons.

The guide begins with home setup, then soil, seed, water, harvest, a partner, and the actual shared meadow. A returning player resumes the appropriate saved lesson. Historical Oran crop receipts still count; current balances never determine past achievements. A used or traded harvest does not undo education. The family seeds remain exclusively under the existing server-backed, once-per-profile FamilyGiftPanel action.

The fairy illustration is original SVG source, not a extracted third-party character. The fixed art box has alpha padding. Its optional two-pixel float honors reduced-motion. Dialogue has no forced timer or typing delay. Back, Next, Close story, and the current action are keyboard/touch buttons of at least 44px height. Instructions remain literal and separate from flavor.

## Approved narrative direction

The fictional hero is seven. Girl and boy presentations have identical abilities and tutorial treatment. Loving parents give the hero a genuinely independent beginning; their confidence is gently absurd, while the child's vulnerability remains sincere. The faith foundation is Christian love, generosity, forgiveness and conviction expressed in conduct. No player receives economic or gameplay advantages for a declaration of faith. Original prose uses affectionate absurdity and economical theatrical dialogue, never copied lines or imitation presented as an author's work. Love and friendship are not prices, spending obligations, or promises of financial return.

The fairy is intended to become each account's first soulbound companion: a guide and gentle restorative presence, distinct from captured party monsters. Naming and skins remain presentation, not a second tradable copy of its identity. This change implements the Journal guide only. It does **not** claim that a native following/healing companion or a persisted soulbound item has been granted.

## Remaining delivery gates

1. Account title flow: authenticated New adventure versus Continue must use persisted story checkpoints; intro replay is a presentation preference and must never reset a returning location. Current Journal actions do not replace this title flow.
2. Hero parity: preview and persist the actual chosen girl/boy art only after all gear/direction/action frames pass the shared animation contract.
3. Fairy custody: server-issued once-per-profile identity, bound ownership, nontradable/nonconsumable/no-market status, idempotent reconnect, account deletion policy, no double occupancy after transfer. Do not infer ownership from loading this UI.
4. Native fairy: actual idle/follow/turn/recovery/help art, shadow/occlusion/anchors and camera continuity; no teleport or collision authority from decorative sprite position. It must not consume one of the six monster-party slots unless that rule is explicitly approved.
5. Restorative ability: authoritative cooldown, eligibility, encounter/PvP rules and observed healing; do not award healing from UI effects.
6. Cinematic: in-world authored parent sprites, safe arrival, player-controlled advancing dialogue, cutscene input ownership, reduced motion and no movement behind a modal. A Journal replay is not cinematic acceptance.
7. Kakariko: authored friendly map, verified entrance/return and safe multiplayer state before changing meadow navigation to town. No button may advertise unimplemented travel.
8. Live acceptance: verify new account, returning account, account switch, spent harvest, denied gift, keyboard, narrow screen, and reduced motion. Unit checks cover receipt progression only, not these visual/native gates.

The existing global completion contract continues to govern acceptance. No item above is accepted merely because this document names it.
