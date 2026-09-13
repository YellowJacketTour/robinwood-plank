# Persistent world continuity requirement

The world must behave as connected persistent geography, not a collection of temporary screen overlays. Camera viewport, native screen, simulation region and ownership parcel are distinct concepts. Leaving a viewport never moves, resets, despawns permanently or transfers ownership of a farm, creature or item.

## Current defect and patch

Farm dirt and Oran growth sprites used DRAW_ORIGIN_SCREEN with a hardcoded 56-pixel HUD offset. Native engine DrawOrigin documentation specifies DRAW_ORIGIN_REGION for world sprite coordinates, including scrolling old/new regions. These farm draw calls now use that origin and field-relative Y coordinates. The native candidate compiled successfully. Visual boundary-scroll validation remains required; successful compilation does not prove transition correctness.

Opening placement still has two sources: local farmSpawned placement (16,72) and asynchronous authoritative account correction. Resolve initial admission before revealing controllable play; do not conceal repeated corrections with animation. The enemy appearance is a separate encounter projection and must be tied to region admission and narrative readiness.

## Required world implementation

1. Catalogue source screens into region-local coordinates with source map/screen identity, collision, elevations, entrances and art provenance. Native screen identifiers must never double as account ownership.
2. Define a connected region graph and stable world positions: world, region, local position and elevation. Home parcels remain account-owned regions connected by authored entrances to public geography.
3. Expand authoritative geometry and travel beyond the sole dmap 4/screen 63 currently supported. Validate exits, permissions and arrival collision atomically; retain old-region authority until handoff commits.
4. Stream nearby region entities independently of camera zoom. Crops retain region-and-bed identity, timers and custody while offscreen. Rendering derives screen coordinates from world position and camera, never the reverse.
5. Use continuous tracking cameras where source geometry supports connected regions. Interior, boat, tower and inter-world travel are explicit graph edges with persistent destination state.
6. Verify leave-and-return crop placement, party following across edges, two-player handoff, reconnect in destination, and minimap/world-map agreement. Do not describe the current one-screen prototype as this complete architecture.

## Connected-screen implementation (2026-09-12)

The extracted d4/s62 western screen is now registered beside d4/s63. The authoritative actor endpoint accepts explicit border travel only at paired walkable anchors: s63 x0/y4..12 to s62 x30/same y and reciprocal. It checks admission, source geometry, sequence, epoch, border position and timing in the existing actor transaction. Destination geometry revision persists in the actor row; reconnect selects that geometry rather than resetting to the starting layout. No migration or inventory mutation is involved.

Native movement sends an explicit destination request on a supported screen change. Native correction receipts accept either registered screen, and observations/corrections are suspended during native scrolling. Nearby-player projections carry screen identity; they cannot be drawn on the other physical screen. The minimap resolves either registered geometry. Unknown maps remain unconnected.

The embedded opening hides its canvas until the current native run acknowledges authoritative placement. This is a presentation gate, not a fabricated saved position. Standalone reference play has no account gate.

Validation: 19 actor/domain/client tests passed, including a real isolated local PostgreSQL schema for reconnect and reciprocal travel; four peer-bridge tests and three position-bridge tests passed; targeted ESLint, TypeScript and native candidate compilation passed. Published rebuilt quest to local runtime. Browser leave-and-return traversal and visual layer behavior are not yet verified.

Still outstanding: source continuous-region assignments, world camera conversion, whole-world topology, dynamic native collision parity, expanded-screen farming/creature coordinate adaptation and shared combat. Existing region identity remains the account home/public instance; physical source screen is carried independently in the actor geometry/native descriptor. This is deliberately not a claim of a complete continuous world.

Live browser follow-up: reused tab 15, restarted the updated runtime, and observed the admission notice disappear into the native scene. Key taps were sent westward but did not establish a visible border traversal; do not mark camera/scrolling visual QA complete. A fifth peer regression now confirms that changing screens resets interpolation rather than dragging an entity from its old map position.

## Shared atlas projection

Added native-atlas.ts as an explicit authored placement registry, independent of account instance identity. The current two extracted screens occupy one 64×22-cell atlas. RegionMap renders both source collision silhouettes, the connecting border, the current area's outline and actor/peer coordinates transformed into the shared atlas. It does not fabricate distant player presence or permit click-to-teleport.

A focused regression verifies same local coordinates map to distinct world positions and rejects unknown/out-of-bounds input. Targeted lint passed. Live tab 15 showed the expanded atlas beside the running native scene. This is not full world artwork or continuous camera completion.
