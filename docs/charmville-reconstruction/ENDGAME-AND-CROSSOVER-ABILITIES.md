# Endgame testing and crossover unlocks

The user requires endgame-quality abilities and gear immediately accessible for testing, later earned as unlocks. Explicit additions include a Kamehameha-style beam and Super Saiyan-style transformation, alongside iconic 1980s/1990s game mechanics. This is an extensible requirement, not a claim that all titles or powers have been acquired or implemented.

## Native test profile

adventure-entry.mjs explicitly lists equipment IDs and engine-default names. It enables slashing, spin/super-spin scrolls, fast charging, high-tier equipment and larger counters. Quest definitions still govern the actual artwork and behavior. Inventory presence is not complete behavior verification. Custom crossover powers are not implemented by this profile.

## Ability contract

Each ability needs a namespaced ID, source revision/provenance, implementation status, directional animation coverage, input binding, press/hold/release/cancel semantics, windup/charge/active/recovery stages, costs, cooldown, hit geometry, movement restrictions, interruption rules, damage/status effects, environmental interactions, unlock requirements and test fixtures. Cosmetics, owned equipment, learned techniques and active transformations are separate records.

Shared combat must evaluate collision, permissions, costs, hits and cooldowns on the server. Client testing presets must never grant tradeable items or main-world economic value. The current ZQuest test mode is isolated and resets progress; it does not implement that server adapter.

## Planned powers — not playable yet

| Family | Required behavior | Visual coverage |
| --- | --- | --- |
| Kamehameha-style beam | Hold to gather energy, aim under explicit movement limits, release a sustained beam, drain energy, bounded repeated hits, interruption and depletion | Directional charging pose, hand light, beam origin/body/end, impacts, recoil, audio |
| Super Saiyan-style transformation | Transformation sequence, energy/mastery requirements, explicit modifiers and ability variants, upkeep, clean reversion on depletion/death | Character-specific hair/body variants, aura, directional movement/attack coverage |
| Charged arm cannon | Distinct charge thresholds, projectiles, costs and release/cancel behavior | Charge flashes, directional pose, projectile/impact variants |
| Speed and spin movement | Acceleration, braking, collision, hazards, bounded attack damage | Running transitions, spin frames, trails and collision response |
| Elemental spells | Fire/ice/lightning, resistance, status duration, environmental rules | Casting, projectiles/areas, status overlays, sounds |
| Morph traversal | Changed collision footprint and movement permissions, validated exit position | Entry/exit and alternate locomotion/interaction frames |
| Summons and creature techniques | Persistent creature identity, ownership, commands, targeting and HP/status | Spawn, follow, attack and staged encounter counterparts |

These are proposed contracts, not verified frame-exact reproductions. Inspect direct sources before claiming source timing or fidelity. Missing asset directions/frames must remain explicitly tracked.

## Progression and integration

Unlock through mastery, quests, recipes, creature bonds and civic discoveries. Distinguish untradeable learned techniques, tradeable training items, equipment, cosmetics and social charm reactions. Shared visual identity does not automatically confer combat power or identical scarcity.

Live combat and staged encounters must share HP, energy, cooldowns and statuses. Transitions cannot reset them. Property damage must follow owner/world permissions. Testing privileges must not transfer into normal accounts or markets.

## Next executable gates

1. Verify native kit behavior in the authored quest.
2. Establish the derived editable quest and authoritative adapter in ENGINE-INTEGRATION.md.
3. Implement one beam with real hit geometry, energy accounting, full animation and interruption checks.
4. Implement one transformation with complete movement/attack coverage and reversible modifiers.
5. Verify both against live creatures, encounter transitions, saved characters and multiplayer before reporting integration.
