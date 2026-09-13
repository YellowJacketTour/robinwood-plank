# Renderer initialization and accumulation: next migration

Source audit: 2026-09-13, sibling `charmville-references/zquest-classic` at checkpoint `7d30cab`. Line references identify that checkout and may move. This is a migration plan, not evidence of enabled zoom, live renderer replacement, or visual parity. No engine files were changed for this audit.

## Required result

A single scene transaction renders a larger, bounded world rectangle with terrain, actors, light and script world primitives using the same visual origin. Simulation viewport, collision, activation, quest timing and item/magic custody remain unchanged. Menus and dialogue use stable UI geometry. Allocation is transactional; a failed resize keeps the previous complete geometry/target set. The live legacy path remains available until candidate acceptance.

See [RENDERER-CUTOVER.md](RENDERER-CUTOVER.md), [NATIVE-PRESENTATION-GEOMETRY-EVIDENCE.md](NATIVE-PRESENTATION-GEOMETRY-EVIDENCE.md), [WORLD-CAMERA-RESEARCH.md](WORLD-CAMERA-RESEARCH.md), and the GLOBAL-02 requirement in [APPROVED-GLOBAL-COMPLETION-CONTRACT.md](APPROVED-GLOBAL-COMPLETION-CONTRACT.md).

## Exact allocation topology: do not flatten the dimensions

`src/zc/zelda.cpp:3895–3913` creates distinct allocations:

| Plane | Legacy dimensions | Responsibility |
| --- | --- | --- |
| `framebuf`, `presentbuf`, `framebuf_no_passive_subscreen` | 256×224 | Fixed final presentation and alternate passive-HUD composition |
| `scrollbuf` | 256×232 | Background/world scratch, including historical extra rows |
| `darkscr_bmp`, `darkscr_bmp_trans` | 256×224 | Opaque/translucent darkness accumulation |
| `lightbeam_bmp` | 256×176 | Beam artwork without the HUD offset |
| GUI/menu bitmap | 640×480 | Legacy dialogs and native menu presentation |
| `scrollbuf_old` | 512×406 | Separate transition behavior; not interchangeable with ordinary scene scratch |

The new `presentation_targets.h` owner currently gives its world/background/darkness planes one common extent, with a separate light extent. **It cannot yet represent the exact legacy topology above.** Before wiring it into the renderer, extend the specification to explicit scene, background, darkness and light extents; retain a common extent for the two darkness planes. Adapt the failure-injection tests to resize each extent independently. Do not silently adopt 232-pixel darkness/final targets and claim 1× compatibility. Alternatively, explicit bounded views can preserve legacy dimensions, but their parent/child lifetime and clipping need proof; separate allocations are the simpler initial implementation.

The alternate passive-HUD output and immutable final UI target need their own documented ownership; they are not currently part of the five-plane scratch owner. No world resize should resize active inventory or the final UI texture implicitly.

## All direct darkness clears found

Repository-wide `rg` found the following `clear_darkroom_bitmaps()` call sites in `src`. The helper at `maps.cpp:6405` fills both global planes with **`game->get_darkscr_color()`**, not necessarily zero. Zero is used to carve lit areas later.

| Caller | Existing phase | Migration constraint |
| --- | --- | --- |
| `zelda.cpp:3017` | Main `game_loop`, START_FRAME, after drunk RNG and before platform checks/gameplay/scripts | Prepare the accepted target set here before clearing. Preserve one clear at this phase. |
| `maps.cpp:6784` | Screen/region load cleanup after generic-script state transition | Clear the relevant new scene state; do not reuse previous region light. |
| `maps.cpp:8289` | Map-picture generation after temporary large darkness allocations | Keep the independent capture/export path separate from bounded live targets. |
| `hero.cpp:26965` | Movement/animation loop, after `handleSpotlights`, before viewport update and `draw_screen` | This loop advances independently of the main loop; do not require a main-frame-only clear token. |
| `hero.cpp:28570` | `scrollscr_handle_dark`, after dither-origin adjustment | Preserve transition-specific rectangles and dither offsets. |
| `hero.cpp:29890` | End of scrolling, only `draw_dark && !replay_is_active()` | Intentional compatibility branch. Do not remove or generalize without old/new replay parity. |
| `hero.cpp:32502` | Death sequence, immediately before `advanceframe(true)` | Independent frame sequence; must not inherit stale darkness or extra lamp charges. |

The comment at `hero.cpp:29887` suggests eventually moving clears to `advanceframe`, but also documents old replay differences. Treat it as a proposal, not authorization to alter timing. An apparent cleanup can change the first frame after scrolling.

Direct `clear_to_color(darkscr...)` occurs only inside the helper in this audit. Rectangular fills, dithering and masks also mutate these planes; those are accumulation/composition operations, not equivalent frame resets.

## Accumulation and composition ordering

1. The main frame clears darkness to the configured dark color before update/script work.
2. Script primitives can draw light into the global darkness target. `script_drawing.cpp:12349–12406` explicitly fixes light cone/circle/square destinations to `darkscr_bmp`, even though other primitives select render targets. They must be included in the script world-coordinate migration; the generic target argument alone does not redirect them.
3. `drawing.cpp:87–88`, `132–133`, `196–197` resolves null destinations to global darkness and automatically chooses global translucent darkness when the destination is the global opaque plane. Arbitrary new planes need explicit paired destinations; pointer identity is part of the current behavior.
4. `compose_scene` calls map/FFC torch generation, then `Hero.calc_darkroom_hero`, then clears nondark screen rectangles. The generators now accept explicit darkness planes.
5. `Hero.calc_darkroom_hero` includes eligibility checks, writes `lamp_paid`, and invokes `paymagiccost` before rasterizing the lamp. Its new explicit target parameters do not make the function pure. Retain the existing single invocation; never call it again for an alternate view or to repair a target after a resize.
6. Darkness compositing can be below or above the passive subscreen according to quest rules. `draw_darkroom` mutates the translucent plane when suppressing stacked transparency, changes/restores `color_map`, sets clipping and invokes script primitive layers. Preserve its exact order; a second call can see a changed plane.
7. PRE_DRAW, lens-clock consumption, layer-specific strings, POST_DRAW and temporary-sprite deletion retain their legacy phases. Allocation or clearing added at compose time would erase earlier accumulation. A second scene draw can also advance legacy weapon graphic animation.

Therefore, **do not allocate-and-clear a fresh darkness set inside `compose_scene` after scripts have executed**. Queue camera requests, prepare a complete accepted geometry/target transaction at the correct frame entry, and use it for the entire frame. If preparation fails, retain both old targets and old visual geometry. Returning old textures with new coordinates is not a valid rollback.

## Spotlight artwork is a different pipeline

`zelda.cpp:3922` initializes `lightbeam_bmp`; `zelda.cpp:4610` clears it at each outer play/session loop. `Hero.handleSpotlights` clears the beam bitmap at `hero.cpp:23390` when spotlight processing is active, or conditionally clears it at `23548` when lights disappear. Normal and freeform beams are then rasterized at `23517` and `23536` using simulation-origin coordinates.

The implemented visual snapshot retains the generated art and ordered world-space beam placements without re-running mirrors, shield interactions or target triggers. `Hero.reprojectSpotlights(target, view)` can populate an explicit beam target, but it is not yet wired into the live scene path. It rejects a snapshot from a different map/origin. `Hero::init` clears the snapshot; explicit `clearSpotlightProjection()` is available for lifecycle cleanup.

For a candidate, replay the retained beam snapshot into the accepted light target only after the gameplay update has completed, at the current visual origin, with no HUD offset. Add the HUD/playfield offset only during scene composition as the legacy renderer does. Do not call `handleSpotlights` again to obtain a new perspective. Verify fading/removal, camera movement during frozen scenes, portal transitions and empty snapshot behavior. A zero-light or missing snapshot must not resurrect previous-room beams.

## Ownership and shutdown

Current globals are allocated in `zelda.cpp:3895–3913`. At shutdown, script drawing commands are disposed before the bitmap teardown (`zelda.cpp` around 4855); `game` is freed before destruction of the main bitmaps at `4868–4882`. Darkness and light are explicitly destroyed there. Later shutdown continues through audio and other resources.

Recommended initial candidate ownership:

- Keep the legacy allocations and their destruction untouched.
- Own candidate targets in the player renderer/lifecycle, not as raw replacements assigned to global bitmap pointers and not as a static destructor that may run after Allegro teardown.
- Construct only after the graphics backend is ready. `ensure` performs bounded transactional allocation. Resolve a value snapshot of all accepted geometry and target pointers for the frame.
- Keep the owner alive for every drawing/script consumer that holds a pointer. Do not resize it during callbacks or nested draw phases; a successful resize destroys replaced planes.
- Explicitly `reset()` candidate targets and clear retained spotlight artwork before the existing bitmap/backend teardown. Cleanup must not query `game` after it has been freed.
- On quest restart/load, clear/invalidate the accepted visual state and spotlight snapshot at the appropriate existing transition boundary. Release targets only when no consumer retains references; empty/dormant state should not retain stale region artwork.
- Preserve the old map-capture/export allocator separately. `maps.cpp:8269–8533` temporarily allocates 4096×1408 darkness planes, handles partial allocation failure, fills/masks them, destroys them, and restores original global pointers. It deliberately exceeds the live owner's bounds. Do not redirect this path through the live owner or discard its restoration behavior.

The candidate should initially refuse unsupported transition modes and remain on the legacy path rather than mix a new world origin with old transition scratch buffers. That is an explicit capability boundary, not completion of seamless zoom across every map.

## Smallest implementation sequence and ownership

1. **maps.cpp/maps.h:** add explicit optional darkness targets to `clear_darkroom_bitmaps`, with unchanged defaults and configured dark fill. Preserve every call site and its replay condition. Compile direct and dependent consumers.
2. **presentation_targets.h/tests:** distinguish scene/background/darkness/light extents. Extend allocation failure tests for each independently changed group, unchanged frames, retry and pointer/pixel preservation.
3. **zelda.cpp/player renderer lifecycle:** create an opt-in candidate owner, accept pending geometry only before the appropriate frame clear, and release it before teardown. Do not publish the candidate target set on partial failure.
4. **script drawing contract:** redirect explicitly world-space light commands and other world primitives to the accepted target set; retain fixed screen-space UI primitives. Audit the hardcoded light destinations above. No global viewport or bitmap-pointer swaps around arbitrary scripts.
5. **compose_scene:** bind the complete accepted target bundle, preserve once-only lamp processing and script phases, and project the existing beam snapshot into its own target. Render the world once and composite it into the fixed UI/playfield rectangle.
6. **candidate build and measurement:** full link/package separately; use the same visible test tab only after rollback and capability gating are ready. Keep a recorded source/runtime identity and an immediate legacy fallback.

## Minimum candidate parity checks

These are required checks, not completed results:

- At 1×, compare exact output/captured planes in lit, fully dark, mixed dark/nondark, dithered, transparent and stacked-transparency regions; include legacy extra-bottom-row and extended viewport modes.
- One identical input trace across 1× and changing zoom schedules produces identical position, HP, magic, `lamp_paid` behavior, clocks, beam target triggers, inventory and creature outcomes. Include a paid lantern and a legacy weapon animation rule.
- Script-authored light before composition survives; HUD text/menu primitives stay at stable sizes and positions. Test light commands that currently ignore generic target selection.
- Lamp direction, cone/circle/square origin, torch offsets, foliage overlap and beam art remain aligned with actors at all supported zooms.
- Force allocation failure at every replacement plane; assert old geometry and all old pointers/pixels remain coherent, then retry successfully. Equal extents allocate nothing. Measure CPU, memory and frame cost on actual target devices.
- Independently exercise main loop, special movement loop, screen load, scroll start/end, replay-sensitive scrolling and death sequence. Count lamp charges and clears at their existing phases.
- Test spotlight creation, disappearance, freeform beams, mirrors, shield reflection, frozen scenes, return to the same region and different-region entry; no stale snapshot leakage.
- Open native menus and map capture during play, then return; original target ownership, clipping and palette state must be restored. Restart quests repeatedly and shut down cleanly with no leaked or double-freed candidate targets.
- Show demonstrably additional terrain **and live actors** with zoom-out. Fixed frame dimensions or an atlas/minimap do not satisfy this requirement. Validate inverse targeting after camera movement and near every region edge.

Documentation and compiled boundaries are progress toward the cutover. GLOBAL-02 remains unaccepted until the operational camera, continuity, rendering and device evidence exists.
