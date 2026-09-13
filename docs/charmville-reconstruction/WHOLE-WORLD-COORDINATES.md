# Continuous world implementation checkpoint

The target is one persistent geography with camera-following movement, account homesteads, public regions and permissioned territories. Loading terrain must not recreate entities or reposition crops. Clients subscribe to nearby activity; persistence is not dependent on every browser rendering every entity.

## Verified source inventory

The isolated native audit resolves DMap 4 to map 10 and inventories all 128 screens, including warps, room types, layers and enemy counts. 125 screens have authored terrain. Screens 68,117,125 are empty. Valid is a bitfield: test its low bit, not equality to 1. The earlier 58-screen/2x4 interpretation was incorrect and is superseded.

The largest fully authored rectangle containing the candidate is 11x7 from screen 5 (77 screens). This is not a playability guarantee: screen 111 has all base combos solid; special rooms and scripted warps also require review. Do not publish a blanket region assignment as the completed world.

Reproduce with `node scripts/charmville/whole-map-audit-build.mjs`. Its generated inventory and native evidence are under work/whole-map-audit. Protected source hashes remain unchanged.

The exporter now also writes terrain.json: 128 screens, 327 active base/overlay layers and 57,552 combo cells. Each cell retains combo artwork identity, palette set, solidity, type and flag; every layer retains its original map/screen reference. Layer arrays are 1-indexed as verified in the native bindings; all six overlays are included. This is raw terrain metadata, not raster artwork or a replacement for native collision. The isolated native compile/run passed with protected hashes unchanged.

topology.json is generated alongside terrain: authored source-coordinate nodes, neighboring screen candidates without row wrapping, and separate preserved warp records. Every crossing remains explicitly unverified until native collision and scripted travel semantics have been validated. Five compiler tests cover holes, boundaries, special rooms and metadata preservation.

## Implemented boundary

lib/charmville/world-coordinates.ts defines stable place/map/source-pixel anchors. Screen and rectangular-region conversions produce the same anchor regardless of region origin. Camera projection subtracts a position without changing the entity. Cross-place and cross-map projections are rejected. Three focused tests cover all 128 screen round trips, region changes, and place isolation.

This module is not yet wired into live movement or persistent entities. The browser remains the four-screen candidate. It must not be described as a completed continuous MMORPG.

## Production pass: terrain loading and retained entities

world-scene.ts now separates camera/chunk interest from entity projection lifetime. Camera travel emits chunk load/unload differences without deleting crops. Entity updates require matching admitted place/map/epoch and increasing revisions; removal tombstones prevent old updates resurrecting objects. A newer place epoch clears the old scene. This is an in-memory projection boundary, not database persistence or live movement authority. Three focused tests cover camera seams, off-camera crop retention, stale updates and place changes. The caller still must supply authenticated scope and snapshots.

The full-map builder now emits conservative static geometry alongside terrain/topology with recorded SHA256 hashes and coverage counts. Five geometry tests cover quadrant masks, missing screens and footprints crossing horizontal, vertical and corner seams. Dynamic native collision rules remain an integration gate.

Main-game changes in this pass: movement observation overflow now enters an explicit authoritative resynchronization barrier instead of resuming a discontinuous tail; 25 focused movement tests pass. This does not solve serial RTT throughput. The map component now supports two-pointer focal pinch zoom (1x–4x); two gesture math tests and targeted ESLint passed, physical mobile interaction remains unverified. Shared standard-ball capture math is available with six source-compatible modifier tests, but new ball inventory and persistent status gameplay are not enabled.

The existing browser tab was inspected and directional keys sent without opening another tab. It was displaying Hyrule Field in the standalone candidate. This is observation of existing gameplay, not proof that the new full-world scene runs in that browser. No main quest publication or multiplayer release occurred.

## Required integration order

1. Export the entire map's terrain, collision, layer and warp topology, preserving source identities. Classify ordinary adjacency separately from authored portals and special rooms. Empty cells remain unavailable until deliberately authored.
2. Migrate native projections, farm combo addressing, followers, encounter placement and movement admission together to stable anchors. Region origin is not hero screen. Screen-major combo indices are not raster tile indices.
3. Preserve admitted owner-based home IDs and public IDs. Add territories through authenticated admission and explicit visit/interact rights, not client-selected ownership.
4. Use one movement authority and acknowledged input history; eliminate the serialized observed-cell backlog before exposing broader multiplayer. Camera or presence renewal must never act as a new arrival.
5. Stream visible terrain and nearby entities while keeping persisted simulation state independent of camera visibility. Native rectangular regions alone cannot represent the irregular whole-map topology.
6. Verify repeated north/south/east/west travel, return-to-crop alignment, followers, portals and two-account isolation in the same visible browser before replacing the main game route.

Whole-world release remains gated on these integrations. No quest publication or account migration occurred at this checkpoint.
