# Creature party and shared-world simulation

## Current constraints

The current database deliberately stores one starter per account: `110_charmville_companions.sql` has `UNIQUE(owner_profile_id)` and permits only Emerald IDs 277, 280 and 283. Migration111 adds a following preference and revision. `lib/charmville/companions.ts` returns the single owned record in a `party` array; this is not six acquired creatures. Source graphics and species metadata are discovery/reference material, not owned assets. Following preference is not evidence of server-simulated movement.

`scripts/charmville/encounter-state.mjs` is a pure proposed domain model. It preserves one entity's health/status across modes and deduplicates requests, but its caller must provide trusted damage, range, randomness, inventory and persistence. It is not connected to authoritative capture settlement. These are inspected local implementation facts.

The next step should create a real acquisition path and normalized roster, preserving the existing starter UUID. Six visual copies of that UUID, six starter grants, or six catalogue images labeled owned would all be incorrect.

## Compatible storage transition

Introduce `creature_entities` with immutable UUID, source namespace/species ID, current owner profile, acquisition receipt, creation time, lifecycle state and revision. Do not make a creature's existence depend on a deletable yard: home placement is a separate relationship. Add `creature_party_slots(profile_id, slot_index, creature_id)` with slot 0–5, unique creature membership and ownership validation inside the roster transaction. A roster revision protects whole-party rearrangements. Every empty slot remains empty until a genuinely owned instance is assigned.

Backfill existing starter UUIDs into the new entity table without changing identity, nickname or preference. Preserve the one-starter entitlement in a separate unique acquisition record. Keep the existing companion table/API readable for the immediately previous release; perform migration and dual-read compatibility before retiring it. Do not simply remove `UNIQUE(owner_profile_id)` while keeping the old `ON CONFLICT(owner_profile_id)` starter insertion: that breaks both idempotency and the one-starter rule.

Keep acquisition distinct from party deployment. Owned storage may eventually exceed six; active party remains bounded at six. Livestock residence belongs to a habitat assignment, not an extra party slot. A cow at home, an egg in incubation and a deployed adventuring companion can share entity infrastructure while having different capabilities and simulation budgets.

## A concrete route to six actual creatures

Implement one server-authored encounter region with a bounded spawn budget and six-or-more eligible species definitions only after their required graphics and mechanics are mapped. Each spawn gets a durable entity ID and server-selected species. A capture request identifies a visible target and an owned capture item; it never supplies success probability or resulting species.

At capture contact, lock the target, actor inventory and acquisition receipt in a documented order. Validate active region lease, server-known position/range, target state, cooldown and encounter ownership. Consume one valid capture item, apply the server decision, and on success transfer that same target UUID to the actor. A retry returns the same outcome; two actors cannot acquire the same entity. Failure consumes only the declared item cost and does not mint a replacement entity.

A first implementation may use a small explicitly authored creature ruleset rather than claim full Emerald battle parity. If exact Emerald HP/damage/capture behavior is promised, source-derived level/stat/move/status data and RNG behavior must first be imported and tested. Do not invent plausible HP numbers and describe them as authentic. Development spawn tooling can seed an isolated test region, but production acquisition should use the declared ecology budget and receipts.

After that loop works, a player can capture five additional distinct instances and assign them to slots. This is the smallest meaningful path to a full belt. Breeding and trading should follow, not act as shortcuts around acquisition and ownership correctness.

## Commands and disposition

Separate a persistent default stance from a temporary order:

| Stance | Meaning | Required limits |
|---|---|---|
| Follow | Travel toward an assigned formation target | Leash, walkability, region boundary and no body blocking of owners |
| Defend | Respond to a validated threat against the protected actor | Aggro authorization, hostile-region rules and bounded chase |
| Passive | Stay near the party without initiating attacks | May retreat from hazards; no implicit PvP retaliation |
| Free range | Wander inside an assigned allowed habitat | Habitat bounds, occupancy and owner permission; not arbitrary world roaming |

Temporary orders include move-to, focus target, recall and stop. Attack is an order with a legal target, not a promise that every species has a mapped attack animation or damaging move. Number keys 1–6 select actual occupied slots; an optional modifier addresses the whole deployed party. Controller selection uses a radial or belt focus with Confirm/Back. The UI displays only commands supported by the selected entity and current region.

A command includes request ID, roster revision, selected entity IDs and the requested intention. Server validation checks ownership, slot membership, region and target legality. It computes the movement/attack outcome. Avoid sending client-computed damage, path completion, yield or livestock output as authoritative inputs.

## Formation and navigation

Use a server movement trajectory with spaced formation targets behind the owner. A follower should follow reachable trail points around obstacles rather than cut diagonally through walls. Direction reflects its own velocity or facing state, not the owner's last key. On a turn, short controlled catch-up and collision avoidance prevent six creatures stacking at one coordinate.

Pathfinding operates on the region's walkable map and portal graph. Re-path when a target moves materially or a path becomes invalid, not every rendered frame. Use bounded search and stagger jobs across entities. A blocked companion waits or requests a legal recall; teleporting through geometry should be an explicit permitted rule, not a hidden correction. Crossing a portal transfers the roster's deployed entities under one admission decision, preserving UUIDs and state. Revoked home access recalls guests and their deployed creatures to an allowed region.

Free-range livestock uses habitat-local waypoints and low-frequency decisions. Public regions must cap active AI per area; distant livestock can advance economic timers without running every footstep. Offline animal care must not produce unlimited goods without habitat/feed/capacity rules. Production recipes settle through the same ledger as crops.

## Attack and effect event contract

Emit events such as `order-accepted`, `move-state`, `windup-started`, `impact-resolved`, `recovery-ended`, `capture-resolved` and `entity-transferred`. Each carries entity ID, region, sequence/tick and relevant revision. The server resolves impact once; clients render the same event with interpolation. A flashy effect cannot create an additional hit.

Combat needs explicit collision shape, attack range, target mask, friendly-fire rule, cooldown, interruption, status duration and defeat state. Defend AI may select from validated threats; it must not invent damage events because an animation overlapped a sprite. Transitioning into a turn encounter changes controller/mode while retaining the same entity and health/status record. Other clients receive its encounter availability state instead of a duplicate independently fightable creature.

## Species animation manifests

A battle front sheet is not a directional walking sheet. A two-frame menu icon is not a complete follower. Each species manifest should identify source commit/hash, presentation role, dimensions, frame rectangles, timing, direction mapping, origin/feet anchor, palette/transparency, action tags and missing capabilities.

Separate `worldIdle`, `worldWalk`, `worldAttack`, `battleFront`, `battleBack`, `menuIcon` and effect references. If exact overworld sprites are absent, mark that role missing and use an explicitly identified temporary presentation; never label a scaled front portrait as authentic four-direction movement. Carry per-species body size and footprint separately from image dimensions. Rendering should use shared atlases and bounded animation updates, but preserve unique art and timing.

## Acceptance gate and implementation order

1. Add normalized owned entities, starter entitlement and six-slot roster; migrate existing UUIDs and prove no duplicate starter allocation.
2. Add one authoritative region's positions, spawn records and legal movement; existing admission leases alone are insufficient.
3. Complete one capture path with actual item debit, target transfer, retries and competing-player tests.
4. Deploy multiple distinct acquired entities with follow/passive commands and obstacle-aware formation.
5. Add defend/focus attacks only after hit resolution and species action manifests exist.
6. Add habitat assignment and one bounded livestock recipe, then breeding with parent IDs, incubation and supply costs.

Tests must cover foreign entity IDs, duplicate slots, stale roster updates, simultaneous capture, lost-response replay, permission revocation, disconnect/reconnect, portal transfer, full-party overflow, collision corners, direction changes and busy public areas. Performance claims require measured low-end device traces. This document proposes implementation; it does not claim these systems are already complete.

## Player command contract

Formation and behaviour are independent. A player may keep a close trailing line while selecting Defend; changing formation must not cancel the current legal task or reset health. The intended selector targets either the whole deployed party or one belt slot. A single command wheel exposes Follow, Hold, Defend, Focus target and Free roam with a visible current state; formation is a separate compact choice. Keyboard and controller bindings must pass through the shared input layer, avoid text-entry focus, and be remappable. Do not advertise hotkeys before their acknowledged commands and visible responses are wired.

Recall always provides a predictable escape from an unwanted order. A rejected target produces immediate readable feedback without spending a resource. Free roam has a visible leash boundary and never grants permission to harvest another player's property. Livestock may graze or rest without combat capability; species capabilities, habitat and learned abilities determine available tasks rather than assuming every creature uses the same attack. Generic animation names such as Attack or Shoot describe presentation, not a complete learnset or an elemental effect.
