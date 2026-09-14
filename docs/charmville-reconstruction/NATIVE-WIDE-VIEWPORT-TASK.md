# Bounded native wide viewport task

## Objective

Show additional live world area on wide displays while preserving source pixel proportions, simulation coordinates, action anchors and all menus. Do not stretch a fixed framebuffer to fill the browser. Begin with one explicit desktop aspect ratio and retain the existing viewport as a fallback.

## Source map

- `scripts/charmville/native-canvas-layout.mjs`: reviewed adapter fixes presentation backbuffer to768×690; keep immutable source pins and review any changed sizing markers.
- Native `src/zc/maps.cpp`, `calculate_viewport`: currently hardcodes256wide and176/232high. `get_presentation_geometry` already separates world rectangle from target rectangle.
- Native `src/zc/render.cpp`, render transform near146–163: fits game framebuffer usingheight+6 and centers it. Screen-space HUD and overlays share this tree.
- Native `src/zc/zc_sys.cpp`:256wide drawing buffers and right-edge255 fills. Audit each before widening allocations.
- Native `src/zc/zelda.cpp`: scrollbuf256×232 and fixed playing_field_offset56 assumptions.
- Native `src/zc/message_string.cpp`: text/background256×224 buffers; dialogue must remain readable and anchored.
- `scripts/charmville/zquest/Homestead.zs`: region-origin crop/tool draws, foot-depth sorting, fixed script HUD coordinates; preserve region-to-presentation conversion.
- `scripts/charmville/display-controls.js`: camera wheel/pinch/pan; camera movement must not move authoritative actors.

## Order of work and acceptance gates

1. Enumerate native render allocations and coordinate transforms. Add an explicit presentation-only viewport rectangle rather than expanding every simulation viewport by assumption.
2. Choose one bounded pixel canvas, derive camera visible rectangle from its aspect and zoom, and retain one uniform scale. Clamp camera against region extents. Keep original actor/world coordinates and network snapshots unchanged.
3. Route world geometry, players, followers, tools, crops, projectiles, labels and inverse pointer hit-testing through the same transform. HUD/dialogue remain separately anchored to safe visible bounds. Rendering extra terrain must not imply simulation/authority over unloaded entities.
4. Rebuild the native binary; update reviewed upstream hash pins deliberately. Stage a new immutable candidate; never patch an accepted release in place.
5. Acceptance: compare known world points at center/corners and all zooms; forward/inverse pointer error below one source pixel; no player relocation from resize; four-direction actions and followers stay registered; interiors and boundary transitions retain correct coordinates; system640×480dialogs remain accessible; mobile portrait/landscape and reduced viewport recover without cropping controls.
6. Measure pixel allocation, frame time and entity draw cost. Agree a measured bound before increasing density. No claim of unlimited simultaneous players follows from a larger camera.

## Explicit non-completion

No viewport implementation or native binary change is included with this task. The crop coverage JSON records structural anchors only: its direction×action×crop matrix contains32 visual cases still requiring recorded live observation. Plant and harvest held props are real outstanding artwork gaps, not completed animations merely because an action receipt succeeds.
