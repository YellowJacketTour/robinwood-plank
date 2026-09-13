# Native world camera activation — 2026-09-13

Engine checkpoint: `0b80f9c` (`feat(zc): add bounded world camera with fixed UI and map overview`). Portable patch: [source patch](source-evidence/0001-feat-zc-add-bounded-world-camera-with-fixed-UI-and-m.patch).

## Implemented and verified

The opt-in live camera renders a larger world frustum once into retained, dimension-keyed world/background/darkness/light targets, then projects it into the unchanged playing-field rectangle. Camera requests do not change the canvas dimensions, Hero coordinates, simulation viewport, activation range, collision or script update cadence. At zoom 0.5 a usual 256×176 playing field shows 512×352 world pixels.

Native HUD and message drawing and explicit Screen/PlayingField script raster commands execute once on the final fixed-resolution frame, in their recorded UI order, before POST_DRAW. Palette index zero remains valid opaque artwork: there is no transparent-overlay color-key loss. Region/Sprite commands stay in world projection. Native HUD item drawing uses legacy render coordinates. SetRenderTarget offscreen writes remain immediate.

Frame initialization clears owned darkness before START_FRAME, matching legacy accumulation timing. PRE_DRAW resolves destinations afterward. No repeated world draw, gameplay update, lamp charge, spotlight calculation or lens-clock update is introduced. Ownership cleanup runs during engine shutdown.

The separate native map overview displays valid authored map terrain at fit scale. Its test-only request bypasses display/visited filtering without changing saved quest flags. Existing overview zoom/navigation remains available; close restores gameplay. Overview is a map inspection view, not a second live simulation camera.

## Evidence

- Stable-source full dependency rebuild: `build_charmville_web/world-camera-ui-final-build.log`, exit 0. Shared context header was touched after the earlier build fully exited, guaranteeing consistent dependent objects.
- Final maps helper forwarding and link: `build_charmville_web/world-camera-ui-tail-build.log`, exit 0.
- Separate candidate packaging: `build_charmville_web/world-camera-candidate/package.log`, exit 0.
- Browser verifier passed fixed canvas dimensions, enlarged world extent, stable baseline Hero position across zoom, normal/wide restoration, overview open/close. Baseline waits for existing tutorial placement before measuring camera motion.
- Root visually reviewed `.charmville-camera-candidate/wide.png`: crisp fixed-size welcome UI; `.charmville-camera-candidate/wide-gameplay.png`: party follows Hero at the same world scale after movement. Overview screenshot shows authored terrain.
- Root promoted the verified pair to the existing 3024 runtime and enabled controls; this source task did not independently overwrite live files.
- Final WASM: 125100218 bytes; SHA256 `663EDDB1B703D2F36D7710AA42B6F200027D58F816A3A65C90D2B13914A8050F`.

## Boundaries and remaining work

Live zoom is bounded to 0.5–1.0 and existing scratch bounds. Zoom 1 follows the original rendering path. Active lens, scrolling transitions, extended-height mode, separate passive-subsceen mode, custom clipping, changed map/frame identity or failed allocation fall back to legacy presentation. Allocation failure preserves previously valid owned targets.

Full-map overview is exposed only to the explicit `/quests/charmville/homestead-region/` test runtime. Live wide view is not a claim that the entire map or thousands of remote actors are simulated at once. Simulation authority, interest management and global persistence remain separate dependencies.

UI is composited above the world while retaining internal UI ordering. Arbitrary third-party quests with bitmap read/write dependencies or unusual screen-space effects need their own compatibility review; the opt-in homestead script set has direct browser evidence. The existing tutorial startup placement handoff is separate from camera projection and still needs its own polish.

Unrelated preexisting `src/zc/crt_filter.cpp` and `web/package-lock.json` edits were not included in this commit.
