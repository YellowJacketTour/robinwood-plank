# Sprite projection correction for owned camera targets

## Root cause

The live camera uses a retained scene bitmap instead of the legacy `framebuf` and `scrollbuf`. Four base sprite rendering paths still gated world-origin subtraction on destination pointer equality with those two legacy bitmaps. Consequently, terrain and Region-origin companion drawings subtracted the render viewport while affected native sprites could draw at absolute world coordinates in the camera target. Hero's stored position remained unchanged, so position-only integration checks could pass despite incorrect visual placement.

## Correction

The render viewport scope now explicitly registers its owned world scene and background targets. A shared destination predicate recognizes those plus the legacy targets. The four sprite guards use this predicate. Arbitrary offscreen bitmaps remain local-coordinate art. Scope exit restores previous target registration; the nested fixed-UI scope clears owned target registration and uses legacy viewport coordinates. `putitem3` compensates using the same render viewport it will subsequently subtract.

This does not move Hero, change collision, activate extra creatures or change animation cadence. It corrects the raster coordinate transform. Base sprite paths are shared by Hero, native enemies, items and weapons. Already unconditional render-viewport paths remain unchanged.

## Regression evidence

`tests/presentation_target_space.cpp` covers legacy frame/background, owned world/background, offscreen and null destinations, nested UI unregistration, and expected projected position after subtracting world origin. Compiled with em++ and executed with Node: exit0, ten assertions.

Full native build log: `build_charmville_web/world-target-projection-build.log`. Browser artifact verification and promotion are recorded by the integrating task after candidate packaging. A complete animation/weapon/dungeon-doorway sweep is not claimed by this bounded correction.

Full stable132-step build/link and isolated packaging exited0. Root browser integration passed and visually reviewed wide-gameplay/panned screenshots: Hero aligns with companion chain on the same terrain. Root promoted the verified pair to3024. Final WASM125105388 bytes, SHA2562EB5C73CEDA2641C03155B18421C5808A59E52BAA4B30E6380E17337BD6EE4D9.
