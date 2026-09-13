# Shared encounter and raid target

The requested end state is one battlefield shared by direct player combat, commanded companions, nearby friends and large cooperative groups. Entering a staged battle changes the camera and available commands; it must not duplicate the enemy or reset HP, status, threat, loot eligibility or time. Current implementation has one encounter controller plus an explicitly invited nearby player who may contribute one authorized companion action. The invitation expires, is consumed once, and is invalidated by lifecycle transitions. That action spends persisted PP and updates the same enemy HP with a committed event and replay-safe receipt; it does not establish a second controller or a raid party. Other nearby players remain authenticated spectators. The wider raid system below remains a target, not completed functionality.

## Rules that both views share

Every enemy and companion has one server identity. Accepted actions reference an actor, target, encounter, intent and authoritative sequence. Damage, healing, shields, buffs, debuffs, crowd control and resource spending settle once. Both cameras consume the same resulting events. Network retries replay receipts; rendering an animation never settles a second hit.

Multiple controllers need explicit ownership: each player commands their own roster, while encounter participation grants neither control of another player's creature nor unrestricted loot. An encounter scheduler must resolve direct attacks and companion commands on one clock with cast time, recovery, cooldown, interruption and target validity. The present serialized starter turns must be replaced or extended deliberately before simultaneous attacks are admitted.

## Art and perspective contract

Each actor presentation needs a source asset ID, animation action, facing, frame timing, ground anchor, attachment anchors, footprint and height. World position remains separate from a staged-camera screen position. The camera transforms positions; it does not alter collision geometry. Source portraits, world walking sheets and move-effect sheets have distinct roles.

Layer order follows ground contact and explicit height bands: terrain, ground decals, grounded actors/objects, airborne actors/projectiles, overhead effects and UI. Effects attach to named actor/target anchors and carry an event identity, start tick and duration. A projectile ending behind an actor must not split that actor's sprite. A shield or held item changes with the action's authored frames rather than staying pasted over every pose.

Raid readability requires limits on visible effect density, party emphasis, reduced-effects accessibility and clear hostile telegraphs. Distant allies may use cheaper animation updates; authoritative simulation remains intact. No browser/device population or raid-size claim is valid without profiling and load tests.

## Friendly controls over deep systems

Default play uses one context action and one equipped action, with clear target and feedback. Advanced controls expose companion selection, attack/defend/recall, movement and ability shortcuts. Each command needs an acknowledged outcome. Spectators, the controller and an invited one-action helper must remain visibly distinct; buttons cannot imply unrestricted assistance or unsupported commands.

## Remaining gates

Implement and verify world-space hit authority; shared status clocks and stacking; multi-player action scheduling; companion navigation and target selection; source move animation bindings; raid telegraphs and encounter scripts; contribution-aware rewards; atomic capture; then performance and accessibility across keyboard, touch and controller. The existing shared HP and committed event projection is one prerequisite, not fulfillment of those gates.
