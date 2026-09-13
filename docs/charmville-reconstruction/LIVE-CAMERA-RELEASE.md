# Live camera and authored-map overview

2026-09-13: verified candidate promoted to the existing local port 3024 runtime.

- **Map overview** opens the complete authored map for the explicit homestead-region test quest. Arrows pan, Z/X zoom, Return to world closes it. This is an overview, not simultaneous simulation of every room.
- **Settings & help → Display → World camera → Wide view** requests 0.5× camera zoom. Wheel, pinch, and +/−/0 target the camera; Game size remains separate presentation scaling. Pinch has synthetic tests, not physical-device verification.
- Default 1× remains the legacy draw path. At 0.5× the usual visible world rectangle grows from 256×176 to 512×352, with identical canvas dimensions.
- The native renderer uses one world composition. Fixed screen/playing-field drawing commands execute once after projection, preserving dialogue text, black panels, and HUD resolution. Offscreen bitmap targets retain their authored behavior.

Verification: full native compile/link, four gesture tests, and `node scripts/charmville/verify-native-camera.mjs` passed. The browser test checks stable player coordinates through zoom, expanded world extent, unchanged canvas size, reset, and overview open/close. Screenshots were inspected; the six-member party follows Link at the same world scale after movement. Evidence is in `source-evidence/camera-2026-09-13/`.

Published WASM: 125100218 bytes; SHA256 `663EDDB1B703D2F36D7710AA42B6F200027D58F816A3A65C90D2B13914A8050F`.

Known scope: homestead-region test runtime only. Lens-active, scrolling, custom-clip, or separate-passive paths can fall back to 1×. This does not expand multiplayer admission, simulation activation, or persistent world capacity. The existing tutorial first-spawn relocation is separately recorded in the test baseline and is not claimed fixed. Universal authored-quest visual parity, physical touch/gamepad testing, and scale/load testing remain outstanding.

The source overview and wider play camera are now usable. This does not close the broader global-world/MMORPG completion gate.
