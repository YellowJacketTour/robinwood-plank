# Kakariko source and geometry implementation plan

Inspected 2026-09-13 against game branch `458a27b2`. Read-only source audit; no maps, native includes, accounts or runtime packages changed. This is a build plan, not an imported-town claim.

## Verified availability

The local `charmville-references/zelda3` checkout is `https://github.com/snesrev/zelda3.git`, revision `fbbb3f967a51fafe642e6140d0753979e73b4090`, matching our `source-evidence/zelda3.json`. It contains the C engine and resource extraction code. It does **not** currently contain `zelda3.sfc`, `zelda3_assets.dat`, or `assets/overworld/` at the inspected paths. Thus a named Kakariko source table is available, but a decoded, inspectable Kakariko art/collision package is not verified here. No wider personal-file search or resource download was performed.

The upstream [README](https://github.com/snesrev/zelda3#readme), checked online as well as locally, explicitly requires a ROM to extract levels and images. Source-code availability alone does not provide those resources. Do not describe the existing source checkout as a complete art pack.

| Inspected source file | Concrete evidence |
| --- | --- |
| `zelda3/assets/tables.py`, area-name table | Light World indices 24/25/32/33 are Kakariko NW/NE/SW/SE; 34 Smithy Estate, 40 Kakariko Maze, 41 South Annex. These are source overworld indices, not ZQuest DMaps/screens. |
| `zelda3/assets/tables.py`, room-name table | Named interiors include Elder's House 242/243, Angry Bros 244/245, well 47, pub/inn entries 259, shop 287, library/storage 263, sweeper house 264. Repeated room IDs require entrance/subroom identity; names alone cannot define separate destinations. |
| `zelda3/assets/extract_resources.py`, `print_overworld_area` | Extraction emits Header, Travel, Entrances, Holes, Exits, Items, and stage-specific sprite lists. Header includes size, graphics, palette, sign, music and ambient fields. |
| Same file, `print_all_overworld_areas` | Only area heads receive individual YAML exports. Do not assume four independent YAML files exist for the four village quadrants; resolve the source area-head table first. |
| `zelda3/assets/compile_resources.py`, `print_overworld` | Compressed overworld high/low tile maps are read directly from ROM; metadata YAML alone is insufficient to reconstruct scenery. |
| Same file, `load_overworld_yaml`, `print_overworld_tables` | Metadata consumes `overworld/overworld-N.yaml`; big-area attributes propagate to indices +1/+8/+9. This is not the current 256×176 ZQuest screen model. |
| `zelda3/src/overworld.c`, `GetMap8toTileAttr`, `GetMap16toMap8Table` | Native tile attributes and 16-to-8 tile mappings exist. A port needs the actual decoded tables and movement semantics, not solidity guessed from screenshots. |

The existing Hero-of-Dreams-derived template is a different source. `STARTER-LOCATION-SOURCE-AUDIT.md` and `source-evidence/dmap-template-inventory.json` enumerate Autumn Town, Palm Island and TreeTop Village. They do not verify a source Kakariko destination. Palm Island DMap 2 and TreeTop Village DMap 207 remain review candidates with their own names; neither is an imported Kakariko replacement. The archived starter candidate list is metadata, not proof that screenshots or traversal passed.

## Current integration boundary

`lib/charmville/native-world.ts` registers only extracted DMap 4 screens 62 and 63. `native-topology.ts` admits that reciprocal pair only. `native-atlas.ts` is an authored 64×22-cell atlas: Western path at x=0 and Meadow at x=32, each 32×22 at eight pixels per cell. `native-region.ts` explicitly calls its stitched geometry a candidate until all projections and admission use region coordinates. A larger native camera rendering does not automatically enlarge trusted account traversal.

`scripts/charmville/export-native-geometry.mjs` probes the pinned ZQuest template with native `GetLayerComboS`, records template/player/script hashes, and supports `--dmap`, `--screen`, `--work-only`. It is a ZQuest exporter, not a Zelda3 importer. Its temporary shared include replacement means native compiles must remain serialized. `NATIVE-GEOMETRY-EXPORT.md` records the conservative 2×2-cell footprint and static all-layer collision limits; decorative layers, bridges, doors, water abilities and moving obstacles require additional semantics.

## Build order and concrete outputs

1. **Resolve the actual scene input.** For original Kakariko, obtain an explicitly supplied permitted resource package, hash it, run its pinned decoder in an isolated output directory, and capture the village in its native renderer. Alternatively author a Kakariko-inspired settlement from currently available, provenance-recorded ZQuest resources. Record that as a new authored scene; do not claim source-faithful import. No source-package choice has been silently made by this audit.
2. **Produce a scene manifest before player warps.** Record source revision and asset hashes, area-head/quadrant mapping, coordinate units, pixel bounds, background/foreground layers, tile attributes, camera bounds, all entrance IDs and reciprocal exits. Include a rendered contact sheet and overlay collision contours. Convert coordinates once through explicit source-to-world transforms. Never reuse Zelda3 area 24 as an assumed ZQuest DMap 24.
3. **Author the peaceful town state.** Choose and inspect one source story-stage sprite set. Assign stable NPC/service IDs, spawn-safe paths, nonblocking meeting space and explicit shop/house doors. Remove accidental hostile triggers deliberately; a zero enemy count is not a safety guarantee. Bind Exchange, supplies and care to existing server custody operations. Unknown services stay unavailable rather than opening decorative dead-end dialogs.
4. **Export and admit geometry together.** Extend the exporter for the chosen source, generate revisioned collision/interaction metadata, and wire `native-world.ts`, `native-topology.ts`, `native-atlas.ts`, native script destinations and projection transforms as one change. Dilate actor footprints after stitching so border-straddling actors remain valid. Store interior floor/room identity independently of the exterior camera offset.
5. **Connect addresses and ownership.** A shared-town region carries shared actors; `home:<profileId>` remains account custody and visit authorization. A friend's front door must resolve the selected owner, not the local viewer. Define an explicit entry spawn and return destination for home, town and each interior; reject client-selected arbitrary coordinates. Reconnect restores the same admitted world/room, epoch and inventory rather than rerunning the tutorial or a source quest continue point.
6. **Accept the complete route.** Two independent test accounts travel from their own homes to the same town, see each other, use a real service, visit an allowed home and return. Verify rejection of an uninvited visit. Exercise each door both ways, every walkable border, keyboard/touch controls, camera zoom and minimap projection. Check foreground occlusion, collision and companion foot positions at north/south/east/west approaches. Repeat after reload and transient disconnect. Only then replace the Shared meadow destination or advertise the town.

## Immediate next engineering slice

Create the source-neutral scene-manifest validator and entrance/return transform tests using the two already-extracted meadow screens; keep live admission unchanged. This enables the town without inventing its assets, and catches the same coordinate/room-continuity failures seen during earlier camera work. In parallel, prepare the actual source-art input and native contact sheet. Neither workstream requires relabeling the current meadow or resetting player progress.
