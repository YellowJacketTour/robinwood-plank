# Live camera pan contract

The native renderer accepts `window.charmvilleCameraPanX` and `window.charmvilleCameraPanY` as absolute world-pixel offsets from the normal following camera. `window.charmvilleCameraPanReady` advertises this bridge. A zero offset restores following behavior. The accepted world rectangle is published through `window.charmvilleCameraViewport`.

This is a presentation-only translation. It does not write Hero coordinates, the simulation viewport, script viewport bindings, creature activation, collision or world ownership. The same game loop keeps advancing while the camera is panned. Each frame still performs one world composition and one fixed-UI projection; no duplicate simulation or animation pass is added.

Requests are finite checked and bounded to ±4096 horizontal and ±1408 vertical world pixels. The resulting view is clamped against the current authored region dimensions. If the view is larger than the region, that axis remains centered. Live zoom remains 0.5–1.0. A nonzero pan enables the owned rendering path at1x; zero pan at1x uses the original legacy path. Existing unsupported-mode fallbacks remain.

This does not make distant inactive creatures simulate. The visible terrain can move beyond the player's activation neighborhood, while only currently active entities are available to draw. Future remote activity requires authoritative interest management and replicated activity state; it must not be faked by extra local ticks. The full authored-map overview remains a separate inspection mode, while this camera view stays live.

The browser layer owns input policy: WASD camera pan, arrow keys player movement, and0 recenter. The native bridge does not change gamepad or player input assignments.

Build log: `build_charmville_web/live-camera-pan-build.log` (compile/link exit0). Candidate packaging exit0. Candidate WASM125103607 bytes; SHA256 `F41E4A056943A40E63077AEF69C3B166267CC8CCA4E1CBC4C2E38F63A755BDDD`. Browser verification and promotion are recorded by the integrating task.

Browser integration passed: D pans at1x while Hero stays unchanged and live position sequence advances;0 recenters; prior zoom and overview invariants passed. Root promoted the verified candidate to3024.
