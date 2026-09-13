# Pixel art remastering for a continuous world

## Scheduling decision

Deferred by product direction: finish playability and advance into live public play before remaster production. Retain current source art. The eventual remaster will roll out gradually per reviewed asset, with gameplay compatibility preserved. This document is a later-phase reference, not the current build priority.

## Decision

Preserve source pixels as the immutable reference, then compile reviewed presentation variants per asset and animation family. Render those variants at the actual world-camera resolution, with a separate screen-space interface. Retain exact pixel presentation as a selectable baseline and fallback. Smooth vector reconstruction is an artistic interpretation; it cannot simultaneously preserve every square pixel boundary and replace those boundaries with curves.

This is a research and implementation specification reviewed September 13, 2026. It does not claim the current browser runtime renders vectors, supplies full camera zoom, or achieves the proposed budgets. The current native renderer cutover is documented separately in [RENDERER-CUTOVER.md](RENDERER-CUTOVER.md). Completion requires game-scale visual and timing evidence, not an attractive enlarged still image.

## What can be exact

An indexed sprite can be represented as unit squares or merged same-color axis-aligned regions, retaining every pixel's palette identity and transparency. Rasterizing that representation at original pixel centers with matching sampling and color rules can reproduce the source exactly. At magnification it remains intentionally block-shaped. SVG storage alone does not create additional detail or remove the cost of rendering geometry.

Smoothed vectorization resolves ambiguous diagonal connectivity, changes contours, and may introduce shading. This can look cleaner at large sizes, but is a remaster. A strict round-trip comparator must not label such an output pixel-identical merely because its silhouette resembles the source. Provide separate exact and remastered modes, with clearly named provenance and approval records.

Zooming far out is a different problem. If a 16-pixel-wide sprite projects to four display pixels, the display cannot show all 16 source samples independently. Antialiasing, coverage-aware minification, or a purpose-designed distant silhouette can preserve useful appearance, but none preserves all original information at that scale. Crowd dots, map symbols, and simplified silhouettes must be presented honestly as alternate representations. Threat indicators and interaction targets must remain legible even when the underlying actor is smaller than a useful touch target.

## Research evidence and suitability

| Approach | Evidence | Appropriate use | Limit |
|---|---|---|---|
| Exact pixel cells | Direct representation of indexed source samples | Archival baseline, crisp tiles, glyphs, strict source fidelity | Remains visibly square at high magnification |
| Kopf–Lischinski vector reconstruction | SIGGRAPH 2011 extracts connected regions and piecewise smooth contours | Offline candidate generation for approved sprite/prop families | Changes geometry; ambiguous features require review |
| GPU depixelization | Kreuzer, Kopf and Wimmer's 2015 poster describes GPU implementation | Research comparator for runtime reconstruction | Historical desktop research is not a browser/mobile performance guarantee |
| MMPX | McGuire and Gagiu 2021 twofold style-preserving pixel magnifier | Efficient candidate for source sprites and fonts | Discrete magnification, not arbitrary vector geometry; no universal best filter |
| xBRZ and shader chains | Libretro provides implementations and configurable passes | Optional presentation benchmark and user style preset | Filter language/backend compatibility must be established; whole-frame processing lacks semantic layers |
| Feature-aware animation | Kuo, Yang and Chu 2016 jointly optimize feature lines across frames | Offline animation-family consistency and editorial tooling | Not proof that independent smoothing preserves source animation timing or anatomy |

Kopf and Lischinski explicitly address diagonal pixel connectivity before reshaping cells and fitting spline curves. Their purpose is a smooth, resolution-independent representation, not exact square-pixel preservation. The paper reports limitations including strong dithering not being explored; its original implementation was not designed as a fast gameplay path. These are reasons to preserve originals and compare specific source families rather than run one conversion blindly over every asset. [Project and paper](https://johanneskopf.de/publications/pixelart/).

The later TU Wien work describes an efficient GPU implementation of depixelization for interactive emulator use. That establishes prior art for runtime depixelization; it does not establish WebGL compatibility, phone thermal behavior, or cost at today's framebuffer sizes. Benchmark its actual implementation and license before integration. [Kreuzer, Kopf and Wimmer, Depixelizing Pixel Art in Real-Time, 2015](https://www.cg.tuwien.ac.at/research/publications/2015/KREUZER-2015-DPA/).

MMPX doubles resolution while preserving palette, transparency and small features. Its authors describe benefits for sprites and fonts, acknowledge other filters are better for some content, and provide C++, JavaScript and GLSL implementations. Their reported sub-millisecond results concern their tested retro-scale inputs and hardware; they are not our measurement. Use MMPX as a reproducible candidate alongside nearest-neighbor and approved smoothing, not as a promise of automatic studio-quality artwork. [McGuire and Gagiu, MMPX, 2021](https://casual-effects.com/research/McGuire2021PixelArt/index.html).

Libretro documents shader presets, multiple passes, source scaling, hardware filtering, and live parameter changes. Its xBRZ catalogue includes different scale variants. Those facilities support comparative evaluation and user preference, but importing a Slang preset into a browser renderer is not a direct integration contract. Separate world and UI filtering so a contour filter cannot unexpectedly merge small text, health marks, or selection borders. [Shader guide](https://docs.libretro.com/guides/shaders/), [xBRZ catalogue](https://docs.libretro.com/shader/xbrz/), [shader languages](https://docs.libretro.com/shader/introduction/).

Feature-Aware Pixel Art Animation starts from a keyframe/warping framework and jointly optimizes feature lines over the sequence for spatial and temporal quality. This supports treating an animation family as the unit of review. It is not a method for inferring canonical missing attack poses or silently inserting extra source frames. The NTHU project was intermittently unavailable on direct open; its indexed project content and the university/publisher abstract were available. [NTHU project](https://cgv.cs.nthu.edu.tw/projects/Recreational_Graphics/PixelLineAnim), [University of Bath research record](https://researchportal.bath.ac.uk/en/publications/feature-aware-pixel-art-animation/), [publisher DOI](https://doi.org/10.1111/cgf.13038).

## Proposed asset contract

The following is a schema proposal, not an existing runtime format. Every variant references the same canonical gameplay definition. Names, positions, timing and custody must not depend on art quality settings.

```json
{
  "schemaVersion": 1,
  "assetId": "creature.example.walk",
  "source": {
    "contentHash": "sha256:<source bytes>",
    "path": "sources/example.png",
    "paletteId": "example.palette.v1",
    "transparentIndex": 0,
    "rightsManifestId": "source-record"
  },
  "logicalGeometry": {
    "frameSize": [16, 24],
    "groundAnchor": [8, 22],
    "handAnchor": [11, 12],
    "depthAnchor": [8, 22],
    "gameplayDefinitionId": "creature.example.v1"
  },
  "animation": {
    "familyId": "example.walk.all-directions",
    "clock": "simulation-ticks",
    "frames": [
      {"sourceRect": [0, 0, 16, 24], "durationTicks": 6},
      {"sourceRect": [16, 0, 16, 24], "durationTicks": 6}
    ],
    "eventsRef": "example.walk.events.v1"
  },
  "variants": [
    {"id": "exact", "kind": "indexed-raster", "hash": "sha256:<bytes>"},
    {"id": "pixel-cells", "kind": "merged-rectangles", "hash": "sha256:<bytes>"},
    {"id": "remaster", "kind": "reviewed-vector", "hash": "sha256:<bytes>", "approvalId": "review-001"}
  ],
  "presentation": {
    "materialId": "palette-cutout",
    "occlusionClass": "world-actor",
    "lodFamilyId": "example.visible-sizes.v1",
    "fallbackVariant": "exact"
  },
  "build": {"converterVersion": "pinned-tool-version", "parametersHash": "sha256:<parameters>"}
}
```

Palette identity is not equivalent to RGB equality: an opaque black palette entry must not become transparent because the transparent index is also black. Frames retain original empty margins or explicit origin compensation. Mirroring is allowed only where the source design permits it; sword/shield hands, creature asymmetry, and directional eyes can invalidate naive mirroring. Ground, grip, emission and depth anchors are independently meaningful.

Collision shapes, attack range, pickup distance, throw trajectory, frame-event timing, immunity and movement speed remain in the gameplay definition. A thickened smoothed sword cannot hit farther. A remastered large creature cannot change navigation clearance. Authoritative events select the same attack/contact frame regardless of raster, vector or distant presentation. Player-created themes can recolor allowed palette roles but must preserve mandatory hazard contrast and distinguish hostility/selection through non-color signals too.

## Offline compilation and runtime composition

1. Inventory source frames, indexed palettes, native draw modes and sheet packing. Retain hashes and provenance. Build a representative set before mass conversion: four-direction Link movement and sword, shield displacement, lift/carry/throw, bow and rod, companion walk/turn/attack, one-pixel eyes, grass, crop growth, water, foliage, beams, translucent effects, fonts and UI borders.
2. Generate exact raster/cell baselines and candidate MMPX/vector variants outside the gameplay frame loop. Compare all animation directions together. Record contour choices for ambiguous diagonals, isolated pixels, holes and dithered regions. Reject candidates that erase intentional pixels or change identity.
3. Store reviewed vectors as editable source, but choose runtime representation by measured cost. Pre-rasterized size tiers in atlases may outperform dynamic tessellation for hundreds of small sprites. Nearby enlarged portraits or selected characters may justify vector rasterization. Do not allocate a DOM SVG node per world actor.
4. Compile complete animation families into versioned bundles with shared anchors and timestamps. Generate lower-resolution variants per sprite with controlled alpha coverage. Prevent adjacent atlas frames from bleeding into one another by padding/extrusion at each mip level or using appropriate array layers. Validate each chosen packaging path on actual browsers.
5. Decode and prepare bundles off the main interaction path where supported. Bound caches and uploads. Warm likely upcoming assets before an event; retain immediate exact-raster fallback if the remaster is missing. Never pause movement waiting for a visual upgrade.
6. Draw world layers at the camera's real render extent, then compose the HUD at its own resolution. Keep ground and overhead foliage, shadows, transparent effects, actors and occlusion in the original intended order. A final full-frame filter cannot repair incorrect layer order or recover detail that was never rendered.
7. Allow exact and remastered preferences without changing server packets or gameplay outcomes. Switch complete families atomically at safe presentation boundaries rather than changing a single animation frame mid-swing. Content updates require version compatibility and rollback.

MDN recommends batching draws and using texture atlases to reduce texture changes; it also emphasizes hardware limits, explicit memory budgeting, avoiding blocking calls and upload stalls, and mipmaps for minified textures. These are applicable browser engineering principles, not evidence for a particular asset count. Query capabilities rather than assuming desktop limits on phones. [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).

Mipmaps are successively reduced texture levels. Their purpose is stable and efficient minification, not adding detail. Sampling modes have distinct magnification and minification behavior; choose them per material and scale range. Pixel-exact nearest sampling and smooth antialiasing are different presentation goals. A global bilinear toggle is insufficient for UI glyphs, thin weapons, translucent water and faraway crowds. [MDN generateMipmap](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/generateMipmap), [Khronos sampler objects](https://wikis.khronos.org/opengl/Sampler_Object).

## The present framebuffer bottleneck

The current renderer audit identifies a legacy 256×176 world view, small shared composition buffers, hardcoded clip/blit dimensions, and world drawing mixed with messages and subscreens. It also records staged native extraction and remaining work. Merely displaying that final bitmap in a 4K canvas, SVG image element, or shader increases output samples without supplying additional world geometry or source detail. A smooth filter can improve its appearance but does not complete real zoom or a remaster pipeline. [Local source audit](RENDERER-CUTOVER.md).

The integration point must retain asset identity and draw intent before final raster composition. For an interim option, a well-bounded shader can provide selectable magnification on the existing frame, clearly called a presentation filter. The full path requires the renderer to access per-asset variants at world composition time, preserve palette effects and native transforms, and separate the UI target. Avoid implementing a second simulation merely to obtain HD output.

A contemporaneous source audit found an additional coordinate hazard: `sprite.cpp` subtracts the render viewport for `framebuf` and `scrollbuf` destinations, while the newly owned camera target was omitted. The shared sprite destination fix passed a focused native regression, browser camera checks and wide/panned screenshot review, and was promoted locally to port 3024. Exhaustive animation coverage remains outstanding. See SPRITE-PROJECTION-CORRECTION.md. This shows why immutable logical positions alone do not guarantee visual continuity: each destination needs an explicit world-to-target transform, and ground/grip/effect anchors must be tested against that transform. The same sprite should land at the same projected coordinate on legacy and owned targets; no destination-specific exception may silently bypass the camera origin.

Zoom changes the visual rectangle only. Preserve the independent simulation viewport/activation rules until authoritative world activation replaces them intentionally. Re-rendering the legacy scene repeatedly is unsafe while draw routines have side effects; it can change clocks or gameplay. Larger render targets must have bounded allocation and failure recovery. These constraints remain prerequisites even if every source sprite has a beautiful vector counterpart.

## Proposed performance budgets

These are initial engineering targets, not measurements or published capacity. Revise them against named baseline devices and workload captures before acceptance. Budget total frame time first; rendering cannot consume the time needed for input, simulation and network handling.

| Area | Initial target | Measurement |
|---|---|---|
| Interactive desktop total frame | 60 Hz target, 16.7 ms interval | p50/p95/p99 frame intervals and long-frame count |
| Mobile normal mode | 60 Hz where sustained; explicit 30 Hz fallback | Ten-minute thermal run, not a short empty scene |
| Additional remaster GPU cost | At most 2 ms p95 desktop, 3 ms p95 chosen mobile baseline | Same scene/input trace versus exact rendering, GPU timing where supported |
| Additional main-thread work | At most 1 ms p95 for variant selection/batch preparation | CPU profiles; no synchronous pixel readback/conversion per frame |
| Asset upload scheduling | No remaster-caused frame exceeding 50 ms during normal traversal | Cold/warm cache and event-arrival traces |
| Resident presentation cache | Starting cap 64 MiB low tier, 128 MiB normal tier | Accounted CPU and GPU estimates; device-adaptive reduction and fallback |
| Converter throughput | Record per-family time and output size; no required live conversion | Offline build report and deterministic rebuild hashes |

RGBA memory grows with area: a 4096² RGBA8 image is 64 MiB before mip levels and other buffers. Therefore universal 8× pre-rasterization of every sheet is not a mobile strategy. Load region/family bundles, share immutable data, and evict by budget. Hundreds of actors should reuse a small number of family/material batches rather than own texture copies. Vector paths also consume memory and rasterization time; count geometry and overdraw instead of treating vectors as free.

## Animation and visual acceptance

| Gate | Required evidence |
|---|---|
| ART-01 exact fidelity | Source-size raster round-trip equals indexed source and alpha; transparent/opaque duplicate colors preserved |
| ART-02 remaster approval | Contact sheet at 1×/2×/4×/8× for complete direction/action family, original visible alongside; intentional differences recorded |
| ART-03 temporal coherence | Looped video, rapid turns and interruptions show no flickering face features, contour pumping, anchor jumps or unintended limb swaps |
| ART-04 gameplay parity | Identical input/seed trace yields identical positions, collision, damage, timing, inventory and custody in every presentation mode |
| ART-05 contact and layers | Sword/shield/hand grip, carried objects, throw landing, bow release, rod line, canopy occlusion, ground shadows and effects align at every zoom |
| ART-06 minification | Slow continuous zoom and camera pan avoid unstable disappearance; distant actors remain recognizable where resolution permits; strategic symbols remain honest |
| ART-07 atlas integrity | Edge sampling, animation boundaries, every mip and transparent color edge show no neighbor-frame bleed or dark halos |
| ART-08 dense event | Real browser capture with separately counted players, companions, enemies and effects; timing and memory reports meet declared device tier |
| ART-09 recovery | Missing variant, malformed asset, failed allocation, context loss and quality change retain playable fallback without altering state |
| ART-10 accessibility | HUD/text stays stable and readable; user palette options preserve danger semantics and touch/controller usability |

Automated pixel and geometry checks catch regressions, but do not substitute for art review. Evaluate whole sequences against source pose timing, not just image similarity scores. A visually plausible hallucinated shield or extra finger can score well while violating the character design. Generated imagery may be useful as an offline concept candidate, but cannot be accepted into gameplay merely because it looks polished.

## Hybrid experiment and delivery sequence

The proposed hybrid keeps source pixels, a reviewed feature/anchor description, and several compiled presentations under one identity. It selects by projected size and semantic importance: exact pixels at comfortable native scale, reviewed remaster for close inspection, carefully filtered raster at small scale, and explicit symbols below readable detail. Use hysteresis around thresholds to prevent rapid variant switching. This is an engineering synthesis for this project; no claim of novelty or superiority is made before comparison.

First establish source-size replay and palette correctness. Next build the representative family corpus and converter comparisons. Then integrate one complete actor/tool family at per-asset draw time in a separate candidate, maintaining an immediate exact fallback. Complete true camera/HUD composition before claiming arbitrary zoom. Only after animation, layer, gameplay and device gates pass should batch conversion expand to terrain, items, companions and the full source catalogue. Creator tooling can then expose versioned palette/theme/remaster contributions with the same validation.

The intended result is sharper, more expressive source-faithful play across supported displays. It is not a full-frame generative repaint, an inferred 3D model from a single sprite, or a promise that infinitely distant details remain visible. Those distinctions preserve both the nostalgic art and the continuous MMO's correctness.
