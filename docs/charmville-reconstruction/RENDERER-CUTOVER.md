# Native camera renderer cutover

Status: staged native implementation, 2026-09-13. Presentation geometry and final overlay extraction are implemented in native source; the wider world composition pass is not complete. The frame-sizing candidate failed visual validation and was rolled back. Normal play retains the working renderer.

## Required behavior

Wheel/pinch changes the visible world extent inside the same canvas. HUD, dialogue, menus, and input target sizes remain stable. Player/world coordinates and simulation timing do not change. Zooming out exposes terrain and actors already belonging to the loaded region; it cannot create connectivity between unrelated maps or load a persistent multiplayer world by itself.

## Source evidence

Audited checkout: `../charmville-references/zquest-classic`. Paths and line numbers below refer to that checkout and may shift with edits.

| Source | Actual constraint |
| --- | --- |
| `src/zc/maps.cpp:370`, `calculate_viewport` | Assigns width 256 and height 176 (plus 56 in extended-height mode), then centers/clamps. Changing CSS cannot change this visible world rectangle. |
| `src/zc/maps.cpp:669`, `update_viewport` | Explicitly safe to recompute repeatedly without advancing camera effect state. This does **not** make the entire draw pipeline pure. |
| `src/zc/maps.cpp:4677` and `4714` | Nearby-screen enumeration derives screen range from viewport edges. This part already supports a larger visible rectangle within the current region. |
| `src/zc/maps.cpp:4961`, `draw_screen` | Composes background, terrain, FFCs, particles, sprites, overhead layers, darkness, messages, passive subscreen and script layers into shared buffers. |
| `src/zc/maps.cpp:5235` | Hardcoded `blit(scrollbuf, dest, ..., 256, 232)` clips a wider world even if viewport dimensions change. |
| `src/zc/maps.cpp:4809`, `set_draw_screen_clip` | Uses global clip bounds; these default/reset to x=0..255, y=0..231 in `src/zc/zelda.cpp:173` and `1488`. |
| `src/zc/zelda.cpp:3894–3912` | Allocates frame buffers at 256×224, scroll buffer at 256×232, darkness at 256×224, light beams at 256×176. These deliberately differ; do not normalize them blindly. |
| `src/sprite.cpp:1049`, `1536`, `1917`, `1954`, `2025` | Sprite drawing subtracts global viewport coordinates. Terrain and sprites must use the same visual transform. |
| `src/zc/maps.cpp:4797`, `draw_msgstr` | Defaults to global framebuf and uses playing-field offset. Messages are interleaved with world layers, not a clean final HUD pass. |
| `src/zc/maps.cpp:5547` onward and `5708` onward | Passive subscreen can draw below or above sprites according to quest rules. `framebuf_no_passive_subscreen` separation exists only for a particular extended-height/rule combination, not as a general clean world texture. |
| `src/zc/zelda.cpp:2995`, `game_loop`; `3317` | Runs script timing phases, invokes draw_screen, then message icons and intro handling. Native frame processing must remain once per simulation frame. |

## Why repeated subviews are not a safe shortcut

Calling `draw_screen` four times at different viewport offsets and stitching outputs is not presently a pure render operation. `runGeneric=true` invokes pre/post-draw scripts. Even `runGeneric=false` still decrements `lensclk` at `maps.cpp:5695`; other nested draw routines have not been proven mutation-free. It also generates/deletes temporary shadow sprites, touches shared darkness/clip state, composes HUD and message layers, and updates shared frame presentation bookkeeping. Repeating this risks faster effects, duplicated overlays and different drawing outcomes.

More importantly, viewport participates in gameplay: `sprite::is_beyond_viewport_suspend_range` and `sprite::is_beyond_viewport_despawn_range` (`src/sprite.cpp:2840–2890`) consult it; sprite update logic around `2357–2506` uses those decisions. FFC update logic in `maps.cpp:3701`, `3754`, `3858` does likewise. A zoom feature must not silently increase creature activation or change drops, despawning, combat, or replay results. Shared MMORPG simulation eventually needs server-controlled interest/activation independent of each player's camera.

## Minimal defensible implementation sequence

1. **Introduce separate presentation geometry.** Keep legacy simulation viewport behavior stable. Add a visual world rectangle, target pixel rectangle and zoom ratio. Make camera centering/bounding a parameterized helper rather than changing every assignment to global viewport. Handle views wider/taller than the region explicitly: center/letterbox instead of a negative clamp range. Route rendering coordinate reads to presentation geometry; leave suspend/despawn and gameplay reads on simulation geometry. Audit script Viewport bindings so existing quests retain their documented coordinate meaning.
2. **Extract world composition with an explicit target.** Refactor `draw_screen` without altering its layer ordering at zoom=1. Pass the world target, clip and visual rectangle into terrain, sprites, shadows, weapons, particles, FFCs, lens, darkness and lighting. Replace the hardcoded final world blit and clip extents with target dimensions. Keep 256×176 screen tile topology constants: those represent source-room dimensions, not buffer sizes.
3. **Separate screen-space overlays intentionally.** Preserve quest rules at zoom=1. Classify messages and script draws as legacy screen-space or world-space; never infer from layer number alone. Keep passive/active inventory screens, dialogue and menu backgrounds on the fixed logical UI target. Some legacy layer-over-HUD effects need an explicit overlay phase after world composition. The existing no-passive-subscreen buffer cannot substitute for this extraction.
4. **Allocate bounded world render targets.** World extent is logical playfield size divided by zoom. Recreate world scratch, light and darkness targets only when extent changes, not each frame. Composite that world once into the fixed playfield using nearest-neighbor sampling for source pixels. Keep HUD and final canvas dimensions unchanged. Initially cap zoom-out to 0.5 (four times the world pixel area), then measure before extending the limit. Allocation failure restores the last valid view.
5. **Make rendering side effects once-per-frame.** Move lens countdown and any discovered draw mutation to a frame preparation/update phase, preserving legacy timing at zoom=1. Do not move arbitrary quest script phases until replay parity is established. This enables optional future multi-view spectators but does not require tiled render repetition now.
6. **Wire input only after actual native capability exists.** Browser wheel/pinch/key controls issue a clamped camera-zoom command at the native boundary. Anchor zoom around player or pointer using an inverse world transform. Keep clicks, targeting, world cursor, companion placement and effect endpoints on that same transform. Menus consume their own scroll; gameplay wheel must not resize the DOM/canvas or move the browser page.
7. **Produce a separate native/WASM candidate build.** The distributed web runtime does not change by editing C++ source. Compile and identify the candidate build, serve it separately, then run the current source quest before replacing any live runtime. Retain an immediate rollback to current native rendering.

## Acceptance gates

- Zoom=1 screenshot and replay parity: terrain, Link sword/shield, throw arc, projectiles, companions, foliage, overhead canopy, particles, darkness, lens, dialogue and inventory.
- Fixed canvas/HUD rectangles at 0.5/0.75/1/1.5/2 zoom; additional world tiles demonstrably visible when zooming out.
- One held input trace at different zoom schedules gives identical player/creature states, collision outcomes, health, clocks and item custody. Specifically test lens duration and out-of-view actor activation.
- All four directions across seams retain world positions; target click and companion formations remain aligned before/during/after zoom.
- Region edge views never render invalid memory or stretch empty terrain into valid cells. Portals remain explicit topology changes.
- Touch pinch cancels browser page zoom only on active game surface; menus and ordinary site controls remain accessible. Keyboard and controller users can reach the same camera settings.
- Measure CPU render time, frame time, memory and input latency on supported mobile hardware; report measurements and scene size rather than claiming unlimited scale.

This cutover fixes camera presentation within loaded native regions. Account-owned homesteads, visit permissions, source-map topology, persistent entity state and multiplayer authority still require their separate integration work.

## Render coordinate separation implemented

Native commit `27f2ec4` adds a bounded, noncopyable/nonmovable render viewport scope and migrates terrain enumeration, terrain/door placement, basic sprite drawing, hitbox visualization, maze clipping and moving-block placement. Default reads continue using the current legacy viewport. The scope is deliberately not activated until the remaining composition paths migrate. Normal WASM objects for maps.cpp and sprite.cpp compiled successfully; commit diff check passed. Portable patch: source-evidence/0001-refactor-zc-isolate-render-viewport-from-simulation-.patch.

Remaining dependencies include specialized weapon/hero/effect drawing, script coordinate conventions, bounded scratch allocation and final single-pass world composition. This commit does not change the served WASM or expose a zoom control.

## Specialized drawing migration

Native commit `4eafcc0` migrates FFC drawing, directional eyeball tile inverse coordinates, darkroom circle/cone/square origins and dither alignment, beam fragments, bomb explosions, hero raft/ladder/prompt/item hitbox, Ganon fragments/flash and Gleeok neck sprites. Normal WASM objects for all six changed translation units compiled; existing compiler warnings remain. Explicit diff checks passed. Portable patch: source-evidence/0001-refactor-zc-align-specialized-world-drawing-with-ren.patch.

`HeroClass::handleSpotlights` still mixes gameplay beam calculation and legacy-origin lightbeam bitmap preparation. Its visual projection requires separation. Legacy ZScript world primitives also require an explicit coordinate contract before a larger presentation viewport can be activated. Neither camera override nor new distributed WASM is enabled by this staged migration.

## Script coordinates and spotlight snapshots

Native commit `0404940` migrates explicit region/sprite draw origins and light-origin compensation to the render viewport. Screen and playing-field origins retain their existing interpretation. Spotlight gameplay still runs once in its original update phase; a separate retained visual snapshot can be reprojected without triggering beam physics again. hero.cpp and script_drawing.cpp WASM objects compiled. Retained atlas/tile-vector memory and visual parity remain unmeasured; no camera override is active.

The published Homestead quest now places the transformation hair and aura in region space and uses the current target for capture-ball drawing. Native quest compilation/startup passed. Live browser tab19 on3024 was piloted through Prepare soil, Plant a seed, Water the seed and Gather your crop. This confirms those input/state transitions only, not complete animation parity or multiplayer custody. The previous tab was absent from browser inventory, so one replacement tab was created and reused.

## Bounded target ownership

Native commit `5d88acd` adds separately sized world/background/darkness/translucent-darkness/light surfaces with transactional resize. Failed allocation retains the previous complete set; unchanged dimensions retain pixels and allocate nothing. WASM tests injected failure at each initial and resize allocation and verified cleanup/retry, bounds and light-only resize. The native Allegro adapter compiled against project flags. Integration must give the owner a lifetime ending before Allegro shutdown. No wider composition is enabled by the allocator alone.
Native commit0fa80b8 extracts the actual compose_scene pass with explicit scene/background/alternate-HUD targets. Normal maps.cpp WASM compilation passed; normalized source comparison preserved ordering after reversing target substitutions. Darkness/light globals, script render-target policy and world/UI classification still need integration. No live zoom activation.

## Explicit darkness targets

Native commit `7d30cab` routes opaque/translucent darkness and beam composition through explicit targets, including terrain torches and the hero lamp. The default destinations and lamp eligibility/payment order remain unchanged; the lamp is still invoked once in the original composition location. Normal maps.cpp and hero.cpp WASM object compilation passed. A portable source patch is retained in source-evidence. This is not a live package update.

Next dependency: initialize and accumulate the owned planes correctly for each frame, then resolve script screen-target and fixed-overlay policy. Repeated scene drawing remains unsafe: lamp payment and other draw-side mutations must not be duplicated. Wider camera activation still requires visual and input-trace parity.

Native 99bb7e7 parameterizes darkness frame reset targets, preserving all seven callsites and their timing. maps.cpp, hero.cpp and zelda.cpp WASM objects compiled; patch archived. No live package changed. The distinct render-target extent implementation continues independently and must be reviewed/tested before its own commit.

Native a151a11 extends paired script-light routing through map-layer helpers (15 terrain, 9 script-layer and 6 sorted-sprite calls). maps.cpp and hero.cpp compile checks passed. Sprite-class and FFC nested coverage is still under audit; lifecycle and world/UI composition remain required before live camera activation.
