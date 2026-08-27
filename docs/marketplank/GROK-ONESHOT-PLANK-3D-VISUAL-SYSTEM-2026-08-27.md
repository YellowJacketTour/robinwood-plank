# One-shot: Adversarial Global Research for Plank's 3D Visual and Skin System

You have no prior context. Act as a multidisciplinary principal graphics engineer, technical artist, game art director, accessibility specialist, web-performance investigator, open-source licensing auditor, and adversarial reviewer.

## Product

Plank is a browser-based, real-money-adjacent/on-chain crash game and lottery community. A live multiplier rises until a provably determined crash. Players must be able to lock/cash out with video-game immediacy while the protocol remains deterministic and auditable. Visuals may never influence outcomes or conceal material state.

The current product has an authored retro-space/chalk aesthetic. Its standalone Three.js crash scene is 4,307 lines and includes procedural spacecraft, launch infrastructure, satellites, alien/artifact scenes, wormhole and heat-shield shaders, point particles, selective bloom, and four chroma-keyed chalk-character PNG billboards. It vendors a Three.js runtime locally. Elsewhere, the React 19/Next 16 app installs Three 0.185, React Three Fiber 9.7, Drei 10.7, and React Three Postprocessing 3.1. There are no current GLB/glTF/HDR/KTX2 assets.

## Proposed plan you must attack

1. Preserve the authored chalk/mission-patch identity; do not replace it with generic asset-store art.
2. Extract the monolithic scene into renderer, assets, skins, timeline, effects, game-adapter, telemetry, and explicit resource-lifecycle modules.
3. Use the stable WebGL/R3F 9 stack in production; place WebGPU/TSL behind a capability-gated lab flag until React integration and renderer parity mature.
4. Keep game controls and authoritative state in accessible semantic DOM. Canvas is an enhancement.
5. Establish a reproducible Blender/glTF pipeline using glTF validation, glTF-Transform, Meshopt, KTX2, LODs, immutable hashes, and a complete provenance/license ledger.
6. Permit only declarative, signed/allowlisted skin manifests. Skins cannot contain executable JS, arbitrary shaders, network endpoints, or economic/game parameters. They reference curated effect IDs and content-addressed assets.
7. Make skins deterministic projections of the same signed game event stream. They cannot affect timing, multiplier, visibility of material state, controls, outcomes, settlement, or odds.
8. Create adaptive visual tiers, robust fallback, reduced-motion/high-contrast profiles, context-loss recovery, memory soak tests, visual regression, and mobile thermal testing.
9. Prefer original/commissioned assets for identity. Use individually audited CC0 assets from sources such as Poly Haven, ambientCG, Quaternius, and Kenney mainly for materials/set dressing.
10. Develop three compatible art families: Chalkflight, Heartwood Observatory, and Neon Drand.

## Required research breadth

Search current primary documentation, source repositories, issue trackers, release notes, conference talks, graphics research, browser/vendor documentation, Three.js Discourse, Hacker News, Reddit technical communities, technical-artist forums, Blender/glTF/KTX forums, accessibility discussions, game-development postmortems, and security/supply-chain sources. Follow citations to originals. Include dissent and reported production failures, not just tutorials.

At minimum investigate:

- Three.js vs React Three Fiber architecture for a continuous live game in React 19/Next 16;
- current WebGL, WebGPU, TSL, browser, mobile GPU, and fallback maturity;
- postprocessing, selective bloom, shader compilation stalls, pipeline warming, color management, tone mapping, and backend parity;
- glTF/GLB, Meshopt, Draco, KTX2/Basis, ETC1S vs UASTC, texture atlases, mipmaps, LODs, instancing, baking, lightmaps, HDRIs, and streaming;
- skeletal animation, VRM/avatar systems, sprite/billboard approaches, authored camera tooling, particles/VFX, physics only for presentation, and deterministic replay;
- memory disposal, image bitmap lifecycle, workers, timers, event listeners, WebGL context loss, route remounting, and long-session leak detection;
- accessibility of canvas games, DOM overlays, keyboard/screen-reader semantics, reduced motion, photosensitivity, contrast, zoom, touch, and motor latency;
- anti-cheat and content security for downloadable skins, signed manifests, immutable hashes, CSP, shader denial-of-service, decompression bombs, malformed glTF, remote URL exfiltration, and license laundering;
- open-source repositories for scene authoring, inspection, profiling, compression, loaders, postprocessing, animation, accessibility, visual regression, and observability;
- open/CC0 asset repositories, with exact per-source and per-asset license caveats, trademark/model-release risks, attribution, redistribution, and modifications;
- production-quality web games and interactive 3D sites, including measured lessons and failure modes rather than aesthetic screenshots alone;
- how visual reward, skins, rarity, collection, and social display can create attraction without pay-to-win, deceptive scarcity, compulsive dark patterns, or interference with the underlying parimutuel economics.

## Mandatory adversarial questions

- Is migrating the standalone crash scene into R3F actually superior, or would an isolated direct-Three engine with a React adapter be safer? Give decision criteria and a migration benchmark.
- Is the production-WebGL/lab-WebGPU split still correct on 2026-08-27? Identify precise evidence that would reverse the decision.
- Can arbitrary model assets create timing, visibility, memory, security, fairness, or denial-of-service differences between players?
- How can skin swaps be proven incapable of affecting the authoritative event stream or lock action?
- Which attractive effects most threaten mobile latency exactly when players lock?
- What payload, GPU-memory, shader, draw-call, triangle, particle, and frame-time budgets should each device tier use, and what real evidence supports them?
- Which proposed open-source tools have licensing, maintenance, React 19, Next 16, WebGPU, StrictMode, or mobile-input problems?
- Which popular asset sites are commonly misrepresented as blanket-free when licenses are per-item?
- What would a browser graphics engineer, casino fairness auditor, accessibility advocate, technical artist, and hostile security researcher each reject?

## Deliverables

Produce one coherent, implementation-ready report containing:

1. An evidence-ranked executive verdict with confidence levels.
2. A source landscape separating primary evidence, maintainer discussion, production report, academic result, and anecdote.
3. A critique of every numbered proposal, including stronger replacements.
4. A recommended rendering architecture and module/API boundaries.
5. A complete versioned skin-manifest schema, threat model, signing/allowlist design, cache policy, and failure behavior.
6. A reproducible asset pipeline with exact command/tool alternatives, pinned-version strategy, CI validation, license ledger, SBOM, and artifact hashes.
7. Device-tier budgets and an adaptive-quality state machine that never changes game semantics.
8. Accessibility and reduced-motion behavior for every live-game phase.
9. Memory, context-loss, performance, deterministic replay, security, and visual-regression test matrices with pass/fail invariants.
10. A curated repository/tool matrix: purpose, license, maturity, maintenance, browser support, integration cost, risks, and recommendation.
11. A curated asset-source matrix with license verification links and rejection rules.
12. Visual direction briefs for Chalkflight, Heartwood Observatory, and Neon Drand that share gameplay silhouette and state grammar.
13. A staged implementation backlog with dependencies, acceptance criteria, rollback paths, and experiments that can falsify the plan.
14. Novel inventions that improve wonder, identity, social attraction, auditability, performance, and aligned incentives simultaneously.

## Research integrity

- Cite direct URLs next to every substantive factual claim.
- State publication/update dates and access date where possible.
- Prefer specifications, official docs, code, issues, and maintainer statements over SEO summaries.
- Separate verified fact, inference, proposal, and speculation.
- Report conflicts and unresolved uncertainty.
- Never describe an entire marketplace as safely licensed based on one item or community claim.
- Do not claim “best,” “safe,” “fair,” or “production-ready” without measurable criteria and evidence.
- Do not recommend changing game economics. The visual system is subordinate to deterministic protocol state, instant-feeling lock UX, and accessibility.

The goal is not maximal polygons. It is a uniquely Plank visual world whose spectacle, responsiveness, provenance, accessibility, and auditability reinforce one another under long-running multiplayer operation.
