# Plant and environment source contract

## Playable scope
The native Homestead tutorial adapts Emerald Oran berry artwork into the Zelda scene. Its accelerated growth is a local demonstration, not authenticated inventory or server-owned farming. The world palette is preserved: source sprite indices are mapped to nearest available colors at runtime. Original PNG files are copied unchanged and SHA-256 recorded by stage-action-sprites.mjs.

## Verified growth artwork
All paths below are relative to the sibling charmville-references directory.

| State | Source | Frame geometry | Meaning |
|---|---|---|---|
| Seed planted | pokeemerald/graphics/object_events/pics/berry_trees/dirt_pile.png | 16 × 16 | Seed committed on tool contact |
| Sprout | same directory, sprout.png | Two 16 × 16 frames | Watered crop begins growing |
| Taller | same directory, oran.png | Frames 0–1, 16 × 32 | Established plant |
| Flowering | oran.png | Frames 2–3 | Blooming before fruit |
| Ripe | oran.png | Frames 4–5 | Harvest available |
| Harvested | Quest soil combo | Existing 16 × 16 | Fruit removed, soil reusable |

Ground anchor stays at (216,104); taller frames grow upward. Source pair cadences are 32, 48, 64, and 96 ticks respectively. Source tables: src/data/object_events/berry_tree_graphics_tables.h; object_event_anims.h; src/event_object_movement.c. Embedded palettes correspond to npc_2, npc_3, and npc_1. Source Oran growth takes three hours per stage and yields 2–3; the tutorial intentionally accelerates growth and retains its existing one-crop reward.

## Zelda environment catalogue and intended material effects
Solarus ZSDX data/sprites/entities definitions refer to the active data/tilesets/<id>.entities.png, not one universal sprite sheet. Resolve the tileset before selecting art.

| Object | Verified source definition | Required world behavior |
|---|---|---|
| Grass | grass.dat: 16 × 16; five 32 × 32 destruction frames | Cut removes vegetation, awards only on authoritative contact, regrowth tracked |
| Bush | bush.dat: 16 × 24; three carrying frames; eight destruction frames | Lift attaches a real prop; throw detaches it; collision resolves destruction |
| Pot | pot.dat: 16 × 16; three carrying frames; eight destruction frames | Container contents and break event share one persistent identity |
| Stones | stone_small_white.dat / stone_small_black.dat | Mining durability, depletion, material yields, respawn |
| Bomb flower | bomb_flower.dat | Harvestable explosive with fuse ownership and area effects |

These are source references, not claims that these mechanics are already integrated. Exact frame origins, carry anchors and destruction timing must accompany imports. Flowers used as decoration must not silently become edible crops.

## Persistent civilization integration still required
Each resource needs an entity ID, owner/region, species/catalog identity, state revision, growth deadline, resource capacity, and validated interactions. Private home regions and public harvesting regions must resolve through authenticated server authority. Rendering must consume that same state on every client; a local sprite swap cannot mint a Charm.

Harvests should produce inventory entries through the existing transaction/idempotency system. Crafting, compost, construction, social use and trading must consume or transfer those entries with explicit rules. Decorative objects, harvestable resources and player construction need separate capabilities, even when their artwork is related.

Travel must carry account state through server-approved region transitions. World events need event IDs, start/end times, affected entities, and reversible/persistent consequences. Music selection should follow region/event priority with source provenance and transitions; no new event music or public/private travel was added in this checkpoint.

## Renderer findings and remaining animation work
The hosted quest returns legacy 0–63 palette channels. Mapping uses the source palette divided by four and a separate bitmap mask, preserving transparency and avoiding replacement collisions. Source files remain unchanged.

ZScript arithmetic retains fractional parts: atlas frame counters now explicitly use Floor before multiplying by frame width. Without this, the sampled rectangle drifts between neighboring frames and can show a sliced sprite. The same correction covers the existing tool/hair frame counters.

The existing LPC hoe/watering/hair PNGs are RGBA32, while masked drawing targets the native 8-bit framebuffer. Native source confirms that path requires compatible depths. Those overlays still need a validated color-depth/transparency conversion and grip/body animation integration; this crop checkpoint does not claim they are repaired.

Verification: native compile; browser screenshots of soil, seed, sprout, taller, flowering, ripe and harvested; stage/contact/harvest event assertions; two-client guest join/aura/presence regression. This verifies local crops and guest presence, not crop replication or authenticated shared-world persistence.
