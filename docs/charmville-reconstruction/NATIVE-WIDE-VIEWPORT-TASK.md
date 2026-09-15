# Bounded native wide viewport task

## Current checkpoint — 2026-09-14

The earlier renderer-cutover notes describe intermediate commits, not the current engine. Audited sibling checkout `../charmville-references/zquest-classic` is at `bfc91163fa512183cfed41b65db5d0f602aa2b78`. It already includes bounded zoom/pan and owned world targets (`0b80f9c`, `a18aa02`, `bfc9116`). `src/zc/maps.cpp:5852–6005` prepares one world composition, retains legacy activation geometry, projects sprites into owned targets, and composites it into a fixed 256-wide playfield. The last step, not absence of camera support, explains the remaining side framing.

This pass adds a **browser-facing improvement**, not a new native binary: modern hosts explicitly send `menuSuite: true`, allowing the redundant native header to collapse after the start/retry button is removed. Controls/settings become an overlay. Opening them does not change canvas geometry. Older hosts and standalone play retain their controls. The fit logic recovers the header and padding area, preserves 768×690 backbuffer dimensions and uniform scale, and reserves touch-control space. Tests cover startup, older hosts, stable settings sizing, no immersive over-zoom cropping, and portrait/landscape bounds.

The source checkpoint contains pre-existing uncommitted `src/zc/crt_filter.cpp` and `web/package-lock.json` changes. They were preserved; no blanket native commit, rebuild or accepted-package mutation was performed.

**Still not complete:** a viewport-shaped native presentation target. The active path still calls `stretch_blit(..., 0, playing_field_offset, 256, viewport.h)` into the fixed frame. Changing only CSS, enlarging the browser backbuffer, or removing black with cropping cannot reveal additional native world area. A full-width target must also preserve fixed UI layout, script-overlay classification and inverse pointer coordinates. The prior portable geometry/target tests are useful, but do not establish the visual acceptance of that future target.

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

No new wide-aspect viewport implementation or native binary change is included with this task. Existing bounded zoom/pan is acknowledged above; it is distinct from filling a wider aspect ratio. The crop coverage JSON records structural anchors only: its direction×action×crop matrix contains32 visual cases still requiring recorded live observation. Plant and harvest held props are real outstanding artwork gaps, not completed animations merely because an action receipt succeeds.
