# PlankCrash realtime visual-stack audit

Date: 2026-08-30

## Executive decision

Keep the existing Three.js/WebGL2 runtime for the alpha. It already has a bespoke staged scene, authoritative-clock animation, selective bloom, PBR primitives, procedural shaders, GPU particles, ACES tone mapping, synthesized audio, and the verified Chalkstronaut art. Replatforming to Babylon.js, PlayCanvas, Unity WebGL, or an experimental WebGPU renderer would replace working identity and introduce gameplay risk without automatically improving art direction.

Build a renderer abstraction and asset pipeline that can adopt WebGPU/TSL later. Three.js itself describes WebGLRenderer as the maintained and recommended choice for pure WebGL2 applications while WebGPURenderer remains experimental and requires a different node/post-processing stack.

## Defects corrected in this pass

1. **Composer resolution drift.** The settings menu changed `WebGLRenderer` DPR but not either `EffectComposer`. Both composers now receive the same capped DPR, so High/Balanced/Low describe the frame that is actually displayed.
2. **Unbounded background GPU use.** Hidden playtest tabs rendered two complete scene passes plus post effects indefinitely. Rendering now suspends while hidden; room state refreshes authoritatively on return.
3. **No sustained-performance governor.** Balanced mode now measures a three-second window, falls back below 48 fps, and restores the richer path only above 57 fps. Low mode removes the second selective-bloom render and expensive light passes while preserving gameplay shaders and the authoritative clock.
4. **Environmental discontinuity.** Stars were regenerated from `Math.random()` on every refresh. A seeded scenic generator now preserves composition across rehydration and across participants.
5. **Opaque GPU failure.** WebGL context loss now produces an intentional recovery curtain explaining that the server-side table is safe. Restoration performs a clean rehydrate rather than showing partially rebuilt render targets.

## Evidence and stack landscape

- Three.js `WebGLRenderer` exposes pixel ratio, GPU resource statistics, asynchronous shader compilation, animation-loop integration, context capabilities, tone mapping, and WebGL2 rendering: <https://threejs.org/docs/pages/WebGLRenderer.html>
- `EffectComposer` owns a separate pixel ratio and render targets; each composer must be resized/configured explicitly: <https://threejs.org/docs/pages/EffectComposer.html>
- Three.js recommends retaining WebGLRenderer for mature WebGL2 applications today and migrating custom GLSL/effect chains to TSL before WebGPU: <https://threejs.org/manual/en/webgpurenderer>
- Khronos defines glTF 2.0 as the interoperable runtime PBR asset format. KTX2/Basis Universal provides cross-device GPU texture compression and reduced GPU memory: <https://www.khronos.org/gltf/>
- PlayCanvas demonstrates the relevant next-stage techniques—WebGPU fallback, HDR post-processing, clustered lighting, light atlases, and feature-scalable shaders—but those capabilities do not justify mixing a second renderer into this scene: <https://developer.playcanvas.com/user-manual/graphics/> and <https://developer.playcanvas.com/user-manual/graphics/lighting/clustered-lighting/>
- Babylon.js offers a mature Havok physics integration. PlankCrash currently needs authored cinematic motion, not general rigid-body physics; adding a physics runtime would make deterministic visual continuity harder and add payload: <https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/physics/v2/usingPhysicsEngine.md>

## Asset-production gate for future authored models

Every new 3D asset must be legally attributable and enter through one pipeline:

1. Author/export glTF 2.0 with metallic/roughness PBR materials.
2. Validate with the Khronos validator; reject warnings affecting transforms, tangents, animation, or color space.
3. Apply mesh optimization and explicit LODs. Merge static meshes by material where it lowers draw calls without destroying culling.
4. Convert color/normal/material textures to KTX2/Basis Universal with mipmaps. Keep original source art outside the runtime bundle.
5. Establish desktop and mobile budgets before integration: compressed download, decoded GPU bytes, triangles, draw calls, texture dimensions, shader variants, and first-use compile cost.
6. Precompile or warm every shader/material required by the round before revealing the flight deck.
7. Provide a reduced-tier substitute. No visual asset may make betting, locking, settlement, reconnect, or admin controls unavailable.

## Next visual milestones

1. Extract the monolithic arcade renderer into tested scene, state-director, effects, audio, and UI modules without changing the authoritative game adapter.
2. Add an opt-in diagnostics HUD based on `renderer.info` and frame-time percentiles for host hardware testing.
3. Produce authored glTF launch-pad, gate, and deep-space landmark kits in the established RobinWood hand-made language; do not use visually incompatible marketplace packs merely because they are technically advanced.
4. Add KTX2/meshopt loader infrastructure only when the first approved authored model lands.
5. Prototype a separate TSL/WebGPU branch, compare visual parity, battery use, shader compilation, and 1% low frame time on representative iOS/Android/desktop devices, and migrate only when it wins measured acceptance gates.

## Non-negotiable acceptance gates

- Server time and settlement never depend on rendered frames.
- Refresh/reconnect reconstructs the same round and scenic composition.
- The primary lock action remains readable and reachable at 390 CSS px.
- Reduced motion removes shake/warp discomfort without removing state information.
- Balanced quality maintains a useful frame rate before preserving bloom.
- Context loss, asset failure, and slow shader compilation have explicit recovery states.
- New assets have licenses, provenance, compression outputs, and measured budgets recorded in-repo.
