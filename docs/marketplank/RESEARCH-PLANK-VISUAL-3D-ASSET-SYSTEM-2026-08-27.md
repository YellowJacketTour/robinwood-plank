# Plank Visual System: Three.js, Skins, and Asset Research

Date: 2026-08-27

## Executive verdict

Plank already owns the hard-to-buy ingredient: a recognizable visual language. The chalk characters, mission-patch typography, hand-built spacecraft, launch infrastructure, wormhole, particles, and bloom read as one authored world. Replacing that with a marketplace model pack would make the product technically richer and culturally poorer.

The best route is a **Plank-native, deterministic cosmetic system**:

1. Keep the current procedural spacecraft and effects as the canonical gameplay silhouette.
2. Extract the 4,307-line standalone scene into testable modules sharing the app's installed Three.js/R3F stack.
3. Add immutable, content-addressed skin manifests. Cosmetics may change presentation, never timing, collision, multiplier, settlement, visibility of material information, or odds.
4. Admit outside assets only through a provenance ledger and build pipeline. Prefer CC0 environment materials and set dressing; retain original or commissioned art for identity-bearing characters and vehicles.
5. Ship WebGL first. Prototype WebGPU/TSL behind a capability-gated lab flag until the upstream React integration and backend consistency are production-grade.

This is a visual-system recommendation, not a claim that beauty or commercial success can be mathematically guaranteed.

## What is in the repository now

### Crash experience

`public/arcade/crash.html` is a substantial custom Three.js application, not a placeholder. It contains:

- procedural launch pad, tower, rocket, satellites, alien, artifact, gate, starfield, and particles;
- custom shader materials for the sky, wormhole, heat shield, warp streaks, and compositing;
- selective bloom using `EffectComposer` and `UnrealBloomPass`;
- a capped device-pixel ratio and a reduced-motion path;
- chalk-character billboards created by chroma-keying PNGs into `CanvasTexture` objects;
- locally vendored Three.js runtime and postprocessing modules.

The four chalk PNGs total roughly 1.1 MB. There are no GLB, glTF, FBX, OBJ, HDR, EXR, KTX2, or Basis assets in the present arcade tree. This keeps licensing and loading simple, but there is not yet a production model/material pipeline.

### Wider app

The application already installs Three 0.185, React Three Fiber 9.7, Drei 10.7, and React Three Postprocessing 3.1. `CollectionEvidenceSpace.tsx` demonstrates the right instincts: bounded DPR, `frameloop="demand"`, and restrained effects. `DiscoFluidBackdrop.tsx` is another custom WebGL surface.

The main architectural debt is therefore **two rendering worlds**: a large standalone vendored scene and an npm/R3F component stack. Version drift, duplicated code, lifecycle behavior, observability, and testability matter more than acquiring more models.

## What is excellent and must survive

- **Ownable silhouette:** the chalk astronaut and handmade rocket are much more memorable than a generic realistic spacecraft.
- **Procedural core:** basic geometry is compact, deterministic, fast to recolor, and safe from third-party licensing surprises.
- **Readable spectacle:** launch, ascent, danger, and crash have a clear temporal arc suitable for a live multiplier game.
- **Local operation:** the current core does not depend on an asset CDN or remote model host.
- **Progressive instincts:** reduced motion and pixel-ratio limits already exist.

## Material gaps and risks

### 1. Monolithic scene ownership

The HTML file combines rendering, assets, input, animation, game state, and networking. It should become modules with explicit ownership: `renderer`, `scene`, `effects`, `assets`, `skins`, `timeline`, `game-adapter`, and `telemetry`. This also makes GPU disposal and WebGL context restoration testable.

Three.js does not automatically release GPU buffers, textures, materials, render targets, or skeletons; its official disposal guide requires explicit lifecycle cleanup. The scene needs a resource registry and mount/unmount soak tests ([Three.js disposal guide](https://threejs.org/manual/en/how-to-dispose-of-objects.html), [cleanup guide](https://threejs.org/manual/en/cleanup.html)).

### 2. Duplicate Three.js distribution

The vendored runtime should be pinned and generated from the same dependency graph as the application, or the scene should be migrated to a bundled route/component. Do not silently mix object instances from different Three versions. An offline fallback bundle can still be emitted by the build.

### 3. No asset provenance contract

Every source asset needs: source URL, author, exact license, retrieval date, original hash, transformed hash, permitted modifications, attribution text, and reviewer. “Free” is not a license. Community asset lists are useful for discovery but repeatedly warn that each item must be checked independently; the ledger, not a forum post, is the authority.

### 4. Texture and billboard pipeline

Runtime chroma-keying is clever but makes alpha quality and memory behavior device-dependent. Preserve the original art, then derive transparent, tightly cropped, mipmapped artifacts at build time. Test lossless WebP/PNG for UI sprites and KTX2 for GPU-resident scene textures. Never optimize the only source copy.

### 5. No adaptive quality governor

Selective bloom creates extra render targets and passes. The game needs deterministic visual tiers chosen from measured frame time and capabilities—not wallet value or wager size:

- Tier 0: DOM/gameplay UI plus static or CSS background.
- Tier 1: core rocket, stars, low particle count, no bloom.
- Tier 2: standard particles, one bloom chain, bounded DPR.
- Tier 3: richer particles, reflections/environment lighting, high-resolution effects.

R3F supports `always`, `demand`, and `never` frame loops plus performance regression controls. On-demand rendering is appropriate for quiet collection views; the live crash timeline needs a continuous loop while active and should stop when hidden or settled ([R3F hooks](https://github.com/pmndrs/react-three-fiber/blob/master/docs/API/hooks.mdx), [community performance discussion](https://github.com/pmndrs/react-three-fiber/discussions/697)). Geometry merging and instancing remain important because every mesh can add draw overhead ([Three.js optimization guide](https://threejs.org/manual/en/optimize-lots-of-objects.html)).

### 6. Accessibility must remain DOM-first

Bet, lock, cash-out, balance, multiplier, round status, receipts, and errors must be semantic DOM with keyboard operation and screen-reader announcements. Canvas visuals are an enhancement, not the control or truth plane. `react-three-a11y` is worth an isolated evaluation, but its open issue history includes integration and input problems; it is not a substitute for DOM parity ([react-three-a11y](https://github.com/pmndrs/react-three-a11y)).

## Recommended production architecture

### Rendering baseline

Use the repository's React 19 + R3F 9 + Three 0.185 generation for production. R3F officially maps v9 to React 19 ([React Three Fiber](https://github.com/pmndrs/react-three-fiber)). Preserve a direct Three adapter only where precise postprocessing or migration economics justify it.

WebGPU/TSL should be a lab backend selected after capability tests and visual-differential tests. Upstream work demonstrates its promise, but public projects also document current alpha/Turbopack integration friction and WebGPU backend inconsistencies ([Three WebGPU/TSL example](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_tsl_interoperability.html), [PMNDRS Paris notes](https://github.com/pmndrs/paris-site), [Three.js issue 31834](https://github.com/mrdoob/three.js/issues/31834)). A technology badge is not worth a degraded cash-out frame.

### Asset pipeline

Proposed reproducible path:

`source art / Blender -> validated GLB -> glTF-Transform -> Meshopt geometry -> KTX2 textures -> LOD variants -> hashed manifest`

- glTF is the Khronos runtime transmission standard and its repository includes specifications and test assets ([Khronos glTF](https://github.com/KhronosGroup/glTF)).
- Meshoptimizer documents glTF geometry compression and pairing with KTX2 ([meshoptimizer glTF guidance](https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md)).
- glTF-Transform provides scriptable, versionable transforms. Resize source textures before KTX2 encoding and pin the toolchain; a maintainer discussion records surprising resize behavior in some KTX2 workflows ([glTF-Transform](https://github.com/donmccurdy/glTF-Transform), [KTX2 workflow discussion](https://github.com/donmccurdy/glTF-Transform/discussions/1305)).
- Use ETC1S primarily where download size dominates and UASTC where fidelity—especially normal maps and critical gradients—wins. Validate on actual mobile GPUs rather than applying one codec globally.

### Canonical skin manifest

```ts
type PlankSkinManifest = {
  schema: "plank.skin.v1";
  id: string;
  version: number;
  contentHash: `0x${string}`;
  author: string;
  license: { spdx: string; source: string; receiptHash: string };
  compatibility: { scene: string; minRenderer: string };
  assets: Array<{
    role: "rocket" | "pilot" | "trail" | "environment" | "audio";
    uri: string;
    sha256: string;
    bytes: number;
  }>;
  palette: Record<string, string>;
  effectsProfile: "low" | "standard" | "cinematic";
  budgets: { triangles: number; drawCalls: number; textureBytes: number };
  accessibility: {
    silhouetteClass: string;
    highContrastPalette: Record<string, string>;
    reducedMotionProfile: string;
  };
};
```

The client loads only signed/allowlisted manifests and verifies hashes. A skin cannot supply executable JavaScript, arbitrary shaders, remote URLs, event handlers, economics parameters, or network endpoints. Custom shaders are curated application code referenced by stable IDs. The canonical game event stream drives every skin.

### Visual families

1. **Chalkflight (default):** deepen the current 2.5D chalk/paper/mission-patch world. This is the brand, not the fallback.
2. **Heartwood Observatory:** carved wood, brass instruments, tree-ring trajectories, and warm astronomical materials; this connects the economic “Heartwood” concept to a place.
3. **Neon Drand:** crystalline randomness beacon, restrained grid/scan effects, visible confirmation states, and high-contrast accessibility palette.

All share the same camera envelope, timeline markers, gameplay silhouette, and UI hit targets.

## Asset-source policy

Preferred discovery sources, subject to per-asset ledger review:

- **Original/commissioned Plank art:** identity-bearing pilots, rocket, logo, icons, and hero environments.
- **Poly Haven:** CC0 HDRIs, textures, and models; its license explicitly permits commercial use and redistribution ([Poly Haven license](https://polyhaven.com/license)).
- **ambientCG:** CC0 PBR materials, with the exact asset page and archive hash recorded.
- **Quaternius:** stylized model packs whose FAQ states CC0, useful for background props and prototyping ([Quaternius FAQ](https://quaternius.com/faq.html)).
- **Kenney:** CC0 prototyping and set-dressing assets, after verifying the exact pack's license at download time.
- **Khronos sample assets:** conformance and loader tests, not automatically production art.

Reject or quarantine assets with missing source files, ambiguous “royalty free” terms, noncommercial restrictions, no-derivatives restrictions, incompatible share-alike obligations, model releases that do not cover identifiable people/marks, or provenance that exists only in a repost. Sketchfab and OpenGameArt are marketplaces/catalogs with per-item licenses, not blanket approvals.

## Advanced open-source tools worth evaluating

- Drei for reusable helpers and loaders; use selectively rather than importing visual conventions wholesale.
- `@react-three/rapier` only if later spaces need physical interaction. Crash outcomes must never depend on client physics; Rapier state can be snapshotted for visual replay ([react-three-rapier](https://github.com/pmndrs/react-three-rapier)).
- Theatre.js for authored camera and environmental animation. Its core is Apache-licensed, while Studio is AGPL and intended as a design-time editor; do not ship Studio in production ([Theatre.js README](https://github.com/theatre-js/theatre/blob/main/README.md), [Three integration](https://github.com/theatre-js/website/blob/main/content/docs/0.5/100-getting-started/200-with-three-js.mdx)).
- GPU path tracing/lightmapping only as offline look-development or bake tooling, not the live wagering renderer.
- Triplex as a local scene-authoring experiment after verifying current React/Next compatibility.

## Verification gates

No visual asset or skin is production-ready until it passes:

- deterministic replay from the same signed round-event fixture;
- screenshot and perceptual regression at low/standard/cinematic tiers;
- keyboard, screen-reader, forced-colors, zoom, and reduced-motion tests;
- WebGL context loss/restoration and route mount/unmount tests;
- a repeated skin-swap soak checking `renderer.info`, JS heap, event listeners, workers, timers, sockets, image bitmaps, materials, textures, geometries, and render targets;
- representative low/mid/high mobile GPU tests with thermal and battery observation;
- slow-network, cache corruption, hash mismatch, missing asset, and offline fallback tests;
- proof that loading failure cannot block betting, cash-out/lock, settlement display, or receipt verification;
- license-ledger and supply-chain review.

Set measured budgets per tier during profiling. Suggested initial engineering hypotheses—not universal truths—are a sub-3 MB first-play visual payload on mobile, no unbounded particle allocation, a 60 Hz target on capable devices, a stable 30 Hz degradation floor on low tier, and zero growth after repeated settled-round/skin-swap cycles.

## Ordered implementation

1. Freeze visual fixtures and record current screenshots, frame timing, draw calls, GPU resources, payload, and accessibility behavior.
2. Add the asset provenance schema, skin manifest validator, content hashes, and a no-executable-assets rule.
3. Extract the current scene without redesigning it; establish one event adapter and explicit resource disposal.
4. Preprocess the four chalk sprites and compare transparency, fidelity, payload, and GPU memory across formats.
5. Implement adaptive quality and DOM-first fallback before increasing scene complexity.
6. Add a single Heartwood Observatory vertical slice using original geometry plus one audited CC0 material/HDRI set.
7. Run visual, accessibility, deterministic replay, memory soak, and mobile performance gates.
8. Only then test a WebGPU/TSL backend and additional model packs.

The governing rule is simple: every new visual must increase wonder without increasing doubt about the game, degrading the lock interaction, changing economics, or weakening Plank's authorship.
