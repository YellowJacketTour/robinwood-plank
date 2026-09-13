# Camera zoom, not presentation scaling

The user explicitly rejected wheel-to-CSS-resize. display-controls.js no longer binds wheel, keyboard zoom keys or pinch to setZoom. The explicit Display size slider remains a presentation preference. Existing loaded pages require reload to remove listeners.

Verified native source: src/zc/maps.cpp calculate_viewport assigns width256 and height176 (232 with extended viewport). bindings/viewport.zh exposes Width/Height as const. Script mode permits position control, not arbitrary zoom. Changing canvas CSS or backing size does not make native rendering produce additional terrain.

Required implementation: independent world render target at camera coverage resolution, composite into fixed presentation rectangle, then draw HUD unscaled. Apply the same world-to-view transform to terrain layers, sprites, particles, darkness, culling and pointer hit tests. Collision and simulation remain in world coordinates. Wheel/pinch modify camera coverage, not DOM size or actor position. Clamp camera against joined-region bounds and preserve focal position. A native renderer build or complete compatible world renderer is required; merely changing viewport.w is unsafe because drawing and screen transitions contain fixed dimensions.

Acceptance: canvas client dimensions unchanged across zoom; more authored terrain visible when zooming out; player/crop positions unchanged; HUD constant size; effects and clicks aligned; no newly fabricated or black neighboring screens presented as loaded world. No implementation is claimed complete yet.
