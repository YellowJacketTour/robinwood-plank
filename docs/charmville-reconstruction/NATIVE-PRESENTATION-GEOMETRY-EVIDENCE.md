# Native presentation geometry foundation

Source checkpoint: sibling engine commit `eee0c5e`; portable patch preserved in `source-evidence/0001-refactor-zc-separate-presentation-geometry-and-lens-.patch`. This is a local checkpoint, not a pushed upstream release or rebuilt live runtime.

Date: 2026-09-13. Status: compiled geometry foundation; **not enabled camera zoom** and not completion of GLOBAL-02.

## Implemented

In the sibling `charmville-references/zquest-classic` checkout:

- `src/zc/presentation_camera.h`: explicit world rectangle, fixed target rectangle, forward/inverse point transforms and bounded geometry factory. Zoom requests outside 0.5–2, nonfinite numbers, invalid dimensions and unsupported resource extents are rejected. The initial world scratch extent is bounded to 512×464 pixels, including extended legacy height.
- `src/zc/maps.h` and `src/zc/maps.cpp`: read-only `get_presentation_geometry(target, zoom)` boundary derived from the legacy viewport. This does not write the viewport or advance camera clocks. Script viewport bindings, activation, collision and despawn behavior remain on their existing geometry.
- `tests/presentation_camera_geometry.cpp`: executable C++ assertions for exact 1× geometry, wider visible region at 0.5×, stable target dimensions, centered undersized regions, authored script offsets, inverse transforms and rejected requests.

The geometry follows the center of the already-resolved legacy camera, so authored camera effects need no duplicate timer. At 1× it preserves the exact rectangle. For bounded views wider than the loaded region, negative origins represent letterboxing; later terrain composition must clip those areas, never use negative tile indices. Center/unbounded script camera behavior remains unbounded.

Integer world extents use ceiling, so nonintegral zooms have slightly different effective horizontal/vertical ratios after pixel rounding. The inverse transform uses the actual integer dimensions, keeping targeting consistent with the composed geometry. The final renderer must choose its sampling policy explicitly.

## Verification executed

From the engine checkout, using the installed Emscripten compiler:

```powershell
& ../tooling/emsdk/upstream/emscripten/em++.exe -std=c++17 -Isrc tests/presentation_camera_geometry.cpp -sENVIRONMENT=node -o build_charmville_web/presentation_camera_geometry.cjs
node build_charmville_web/presentation_camera_geometry.cjs
& ../tooling/native-build-env/Scripts/ninja.exe -C build_charmville_web CMakeFiles/zplayer.dir/src/zc/maps.cpp.o
```

All three commands exited 0. The standalone test exercised the actual C++ geometry compiled to WASM. The native engine `maps.cpp` translation unit compiled successfully with its normal project configuration.

No full player link, distributed WASM rebuild, live runtime replacement, screenshot parity, replay parity or hardware performance test was performed for this change. The currently served game has no new zoom behavior from these source edits. No browser JS or quest files were modified by this work.

## Required next cutover work

1. Extract world composition into an explicit bounded target and route drawing transforms to presentation geometry while retaining simulation geometry reads.
2. Separate HUD/dialogue/script coordinate conventions; preserve source quest ordering at 1×. The historical hidden bottom eight pixels and extended viewport rules need an explicit target policy.
3. Allocate render/light/darkness buffers on extent changes with rollback on allocation failure. Handle letterboxing and world clipping consistently.
4. Move any drawing side effects to once-per-frame preparation; do not stitch repeated mutable draw passes.
5. Build a separate candidate WASM, establish 1× screenshot/replay parity, then wire camera controls and inverse targeting.
6. Measure device performance and identical simulation outcomes under different zoom schedules before promoting the renderer.

This is the first boundary from [RENDERER-CUTOVER.md](RENDERER-CUTOVER.md), not a substitute for the remaining work. Keep the new accessor unexposed to browser input until render targets actually consume it.

## Follow-up: explicit lens clock ownership

Implemented `src/zc/presentation_frame.h` and connected its `presentation_frame_effects` token to the main game-loop draw call. `draw_screen` accepts an optional token; additional views sharing it can consume the region lens clock only once. Existing independent callers receive a fresh local token, retaining their original one-decrement-per-draw semantics. This matters because warps, deaths, messages and cutscenes have their own draw/advance loops: a global frame-number deduplication would silently change them.

The effect remains at its exact legacy phase: **after lens artwork, before layer-6 strings, passive subscreen primitives and POST_DRAW scripts**. Moving the decrement to after `draw_screen` would change the value those scripts observe. The non-region lens path in `zelda.cpp` is unchanged. Suspended lens handling is unchanged. A zero clock does not consume the token, allowing later activation within the transaction.

Executed successfully:

```powershell
& ../tooling/emsdk/upstream/emscripten/em++.exe -std=c++17 -Isrc tests/presentation_frame_effects.cpp -sENVIRONMENT=node -o build_charmville_web/presentation_frame_effects.cjs
node build_charmville_web/presentation_frame_effects.cjs
& ../tooling/native-build-env/Scripts/ninja.exe -C build_charmville_web CMakeFiles/zplayer.dir/src/zc/maps.cpp.o CMakeFiles/zplayer.dir/src/zc/zelda.cpp.o
```

Assertions cover repeated shared-token consumption, a fresh transaction, zero/late activation, no underflow from zero, and independent legacy draws. Both normal engine translation units compiled. No replay or visual parity claim is made from compilation or helper tests alone.

**Repeated `draw_screen` is still not a safe world-tiling strategy.** Other remaining behavior includes PRE_DRAW/POST_DRAW script execution when enabled, temporary shadow sprite allocation/deletion, shared darkness/light buffers, clip and color-map state, frame bookkeeping, interleaved HUD primitives and nested sprite routines not yet proven mutation-free. Even lens artwork is not yet snapshotted for repeated views, so a second view could observe the already-decremented clock; the token protects advancement, not full presentation equivalence. The next extraction needs a shared immutable visual snapshot and explicit world/overlay passes, preserving script phases.
