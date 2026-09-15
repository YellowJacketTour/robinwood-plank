# Native viewport: source and binary audit

This is a reproducible diagnosis, not a claim that widescreen rendering is complete. No engine file, existing WASM, or accepted package was changed during this audit. Existing uncommitted engine edits to `src/zc/crt_filter.cpp` and `web/package-lock.json` remain untouched.

## Verified executable identity

Engine checkout: sibling `charmville-references/zquest-classic`, revision `bfc91163fa512183cfed41b65db5d0f602aa2b78`.

The 125,105,388-byte debug build and the 19,967,606-byte `work/menu-native-r03-local-candidate/runtime/zplayer.wasm` have **identical executable core sections**: SHA-256 `5c6578ffcb0570f37a631cbdee1d70fc80f8df8a95c34f13562f1de3baf6ed96`. Both binaries pass WebAssembly validation. The candidate omits names and eight debug/name custom sections; no machine-code reconstruction is needed because the matching source and debug symbols are available. This does not establish that every local source file matches the historical binary build; per-file hashes in the receipt identify the audited source state.

`llvm-nm --demangle` on the engine's `maps.cpp.o` confirms compiled symbols for `begin_world_camera_frame`, `get_world_camera_geometry`, `draw_screen`, and `publish_world_camera`. `llvm-objdump --section-headers` confirms the debug binary's code section and debug tables. These tools were used only on the declared game engine files.

## Exact narrowing path

| Location at this revision | Actual behavior | Required coordinated change |
| --- | --- | --- |
| `src/zc/maps.cpp:5867` | Camera target is `{0, playing_field_offset, 256, viewport.h}`. | Derive a presentation target from an explicit bounded display aspect; retain simulation viewport. |
| `src/zc/presentation_camera.h:48–72` | `make` sizes the visible world from legacy width/height and zoom; target aspect does not determine additional world extent. | Add aspect-aware geometry with uniform scale and inverse mapping. Merely giving current `make` a wide target stretches the same world. |
| `src/zc/presentation_targets.h:103` | Each scratch plane is bounded to512×464. | Keep or deliberately revise allocation limits; wider aspect plus0.5zoom may exceed512 width. Return a supported zoom bound instead of silently failing. |
| `src/zc/maps.cpp:5995–5999` | Owned scene is compressed into256-wide `framebuf`; deferred UI commands then draw in legacy geometry. | Keep one scene composition; composite into an independent aspect-shaped presentation target and intentionally place fixed UI. Do not repeatedly draw mutable scenes. |
| `src/zc/zelda.cpp:3898` | `presentbuf` is256×224. | Give the new presentation surface explicit allocation/resize/failure/shutdown ownership. Retain fixed legacy UI targets. |
| `src/zc/zc_sys.cpp:3305–3322` | Message, wave and panorama processing still use256-wide legacy intermediates before copying to `presentbuf`. | Decide world/UI ordering for these effects; do not bypass them by swapping a texture pointer. |
| `src/zc/zc_sys.cpp:5694–5730` | Hidden-bottom-pixel changes recreate256-wide targets and renderer textures. | Preserve these transitions and legacy fallback without overwriting the new target or leaking textures. |
| `src/zc/render.cpp:84–86,146–163` | GPU game texture gets legacy frame size, then aspect-contain transform leaves side framing. | Upload/composite the presentation surface with a matching uniform transform; retain crisp640×480 system dialogs. |
| `src/zc/render.cpp:64–68` and `maps.cpp:5947` | Native mouse uses the game render-tree transform; published targetWidth remains256. | Publish actual target rectangle and use consistent inverse world mapping while keeping UI hit testing in its own coordinates. |

This is why changing CSS to `cover`, changing only256 to384, or hiding black pixels is not a correct renderer fix. The smallest safe active cutover still spans composition, postprocessing, target lifecycle, render-tree sizing, and input mapping. It cannot be accepted from a helper test alone.

## Checks actually run

From the engine checkout:

```powershell
New-Item -ItemType Directory -Force build_charmville_web/viewport-audit-20260914
& ../tooling/emsdk/upstream/emscripten/em++.exe -std=c++17 -Isrc tests/presentation_camera_geometry.cpp -sENVIRONMENT=node -o build_charmville_web/viewport-audit-20260914/geometry.cjs
node build_charmville_web/viewport-audit-20260914/geometry.cjs
& ../tooling/emsdk/upstream/emscripten/em++.exe -std=c++17 -Isrc tests/presentation_target_space.cpp -sENVIRONMENT=node -o build_charmville_web/viewport-audit-20260914/target-space.cjs
node build_charmville_web/viewport-audit-20260914/target-space.cjs
& ../tooling/native-build-env/Scripts/ninja.exe -C build_charmville_web CMakeFiles/zplayer.dir/src/zc/maps.cpp.o
```

Both C++ tests were freshly compiled toWASM and executed successfully inNode. They cover existing geometry inverses, rejected requests, legacy-coordinate stability, and destination identity for sprites. The normal maps object target succeeded; it was already current, so this is **not** a newly compiled wide renderer or full player link.

Reproduce source/byte identities from the application checkout:

```powershell
node scripts/charmville/audit-native-viewport.mjs ../charmville-references/zquest-classic work/menu-native-r03-local-candidate
```

The checked receipt is `source-evidence/native-viewport-audit-20260914.json`. The script is read-only and rejects changed/missing source markers. It prints evidence, never a deployment acceptance token. Camera visual parity, resizing, pointer accuracy, dialogue, inventory, transitions, and hardware performance still require an active candidate when the coordinated cutover is implemented.
