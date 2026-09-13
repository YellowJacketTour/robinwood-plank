# Offline scene manifest contract

`lib/charmville/scene-manifest.ts` compiles and validates a source-neutral geometry
manifest. It is not imported into live movement, admission, rendering or travel.
It does not import Kakariko, create a new destination, grant a player entry, or
verify source-art redistribution rights. Existing meadow behavior is unchanged.

## Coordinate and identity contract

- `scene.id` is unique. `spaceId` and signed integer `floor` identify a coordinate
  plane; a basement can reuse exterior x/y without becoming the exterior room.
- `sourceId` plus `sourceRoom` records engine-specific source identity. Source
  room names remain opaque strings: Zelda3 area numbers are not ZQuest DMaps.
  The same source room may repeat in different spaces/floors, but not twice on
  one plane. Account instance admission remains a separate server concern.
- `width`, `height`, `blocked` and `footprint` use integral geometry cells.
  `tilePixels` converts cells to pixels. `origin`, `toWorld` and `toLocal` use
  pixels; fractional pixel positions are accepted by the projection helpers.
- Bounds are half-open: `[0,width*tilePixels)` and `[0,height*tilePixels)`.
  A seam point belongs to the next scene only. Invalid/nonfinite positions
  return null, never silently clamp or warp. Overlapping rectangles on the same
  space/floor are rejected, even when their solids happen to differ.
- `revision` must have SHA256 syntax. This is a reference, not a computed
  integrity check; a trusted importer must compare the actual source artifact
  and its revision before offering this manifest to an authoritative server.

## Entrances and exact returns

Each entrance names `from`, `to`, `returnId`, a source `trigger` cell and a target
`arrival` cell. Both occupied actor footprints must fit the scene and avoid all
blocked cells. An entrance cannot connect unknown rooms or its own room.
Duplicate IDs and two entrances sharing a source trigger are rejected.

The inverse entrance must name the original as its inverse and swap both scenes
and positions exactly. `entranceAt` resolves only the requested entrance from
the exact source scene and trigger cell. It returns a copy of the destination
cell. It does not execute travel, enforce cooldowns, choose an account instance,
check permissions, or automatically trigger a return when a player arrives.
Those remain mandatory integration responsibilities. One-way drops or displaced
door exits need an explicitly versioned future schema rather than weakening
these reciprocal guarantees.

Compiled values are normalized into owned, deeply frozen records. Mutating the
original JSON afterward cannot relocate a room or entrance. The version-1
compiler bounds scenes (256), entrances (4,096), cells per scene (1,048,576),
total cells (4,194,304), footprint size (64 per axis) and coordinate magnitudes.
These are offline validation limits, not a claimed player/server capacity.

## Verified examples and remaining acceptance

`test/market/charmville-scene-manifest.test.ts` uses the committed, extracted
DMap 4 screens 62/63: eight-pixel cells, 32×22 scenes, 2×2 actor footprints,
origins (0,0)/(256,0). The exercised reciprocal pair is west (30,9) to meadow
(0,9). Existing solids are used unchanged. A copied west scene on floor -1 is
only a projection test, not invented basement artwork or a registered room.

Tests cover fractional-pixel round trips and exact seams; unknown space/floor;
inverse entrances; overlap and duplicate identity rejection; a blocked quadrant
inside an otherwise plausible arrival footprint; out-of-bounds arrivals;
malformed manifests; and post-compilation input mutation.

Before live adoption, a source importer must pin real assets and scene revisions,
classify foreground/collision semantics, and connect the manifest to admission
and native projection in one reviewed change. Exercise two independent players,
all intended entry/return routes, camera zoom and reconnects against the actual
renderer. Static solidity does not model moving obstacles, water abilities,
bridges, elevations, collision animation or conditional door permissions.
