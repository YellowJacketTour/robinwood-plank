# Research brief for Grok: state-of-the-art immersive 3D render quality for live hydration visualization — research, invent, and hand back a real build

Status: **research + invention + implementation brief.** Go beyond
describing concepts — research the actual state of the art in real-time
web 3D rendering, then invent a genuinely novel, production-buildable
design, and provide the real, working build back (components, shaders,
animation logic) rather than a description of what one could look like.
Written by Sonnet 5, 2026-08-25, from direct, current, first-hand
knowledge of this codebase.

## Starting concept (already proposed this session, not yet built)

Every real hydration event in this app (a mesh-tick job completing, a
collection's `archival_score` ticking up in `collection_archival_stats`,
a visitor's click triggering a token to be verified and permanently
stored) is currently invisible to a site visitor except as a static
number changing between page loads. The proposed starting concept:
small, physical "plank" objects (matching this app's own wood/plank
branding — see `docs/DESIGN.md`, `public/images/plank-logo.webp`) that
visually animate into existence, tied 1:1 to real backend events,
across: the rankings table (a tiny plank flip/glow per row when a real
job is processing that collection), the collection detail header (a
physical, wood-textured progress bar filling as `archival_score` rises),
and smaller surfaces (a pulsing indicator on trending/mover cards).

**The ask**: research and invent how to take this from "a CSS keyframe
animation" (buildable today, low ambition) to genuinely state-of-the-art,
immersive, high-render-quality 3D — while staying real, honest, and
technically responsible for a production Next.js marketplace, not a tech
demo.

## Non-negotiable constraints (read before proposing anything)

- **This is a real-time web app serving NFT marketplace data as its
  primary content.** Any 3D/visual effect is decoration around real data
  (floor prices, listings, rankings) — it must never obscure, delay, or
  compete with that primary content for rendering priority or user
  attention. A slow-loading marketplace because of a hydration animation
  would be a real regression, not an improvement.
- **The rankings table renders up to 100 rows at once, with more via
  "Show 25/50/100."** Any per-row 3D effect must be evaluated for real
  cost at that scale, not just cost for a single hero element. A design
  that looks great once and destroys frame rate at 100 instances is not
  state of the art, it's a demo that doesn't ship.
- **Every animation must map to a REAL backend event, never a fabricated
  or decorative-only trigger.** This app's single most load-bearing rule
  (`lib/market/multichain/venue-registry.ts`'s own header) is never
  fabricate. A plank animation firing when no real hydration event
  actually happened would violate that rule in a new, visual form — this
  is as serious a constraint as the honest-coverage-labeling rules
  already enforced everywhere else in this codebase.
- **Accessibility**: must fully respect `prefers-reduced-motion` (fall
  back to the plain numeric/text version with zero animation), must not
  rely on 3D as the only way to perceive the underlying information
  (the real number/percentage must always be present in the DOM/AA tree),
  and must not trigger vestibular discomfort (no unbounded parallax/
  motion without user control).
- **Real device/bundle budget**: this app has no existing 3D rendering
  dependency (no Three.js/React Three Fiber/WebGL usage anywhere in the
  current codebase — verify this yourself by checking `package.json`
  before assuming otherwise). Any proposal that adds one must justify
  its real bundle-size cost (Three.js + React Three Fiber is a real,
  non-trivial addition — cite the real current gzipped size) against the
  real value delivered, and must code-split/lazy-load so it never blocks
  first paint of the actual marketplace data.
- **Free-tier-first infrastructure, no new backend cost.** The animation
  is purely a client-side rendering question — it must consume the real
  data already available (polling `collection_archival_stats`/job status
  via existing routes, or a new lightweight endpoint) without requiring
  new paid infrastructure, GPUs, or server-side rendering of 3D content.

## What to research (real, specific, current state of the art)

1. **Real-time WebGL/WebGPU techniques for physically-based wood/material
   rendering at small scale**: PBR (physically based rendering) material
   models for wood grain, procedural wood-grain shaders (real, citable
   techniques — Perlin/Simplex noise-driven grain patterns, real papers
   or production shader examples), and whether WebGPU (the successor to
   WebGL, now shipping in real browsers) offers a meaningfully better
   performance/quality tradeoff for this specific case (many small
   instances, not one hero 3D scene) versus WebGL/Three.js today. Give a
   real, current browser-support verdict, not an aspirational one.
2. **Real production examples of "live data as a physical/tactile
   real-time visual"**: research how real financial/data products
   (Stripe's real-time dashboard animations, Robinhood's own confetti/
   candlestick animations — ironic given this app's branding — GitHub's
   contribution graph, Bloomberg Terminal's tactile UI elements) achieve
   "this number changing feels physically real" without full 3D, and
   contrast with genuine WebGL-based data-art examples (real Three.js/
   R3F showcases, Shadertoy techniques adapted for data-bound instances)
   for cases with many simultaneous small instances (a 100-row table),
   not one hero visualization.
3. **Instanced rendering for many small 3D objects**: if 3D is
   recommended at all for the 100-row table case, research real
   techniques for rendering many similar small objects performantly
   (instanced meshes, GPU instancing via Three.js's `InstancedMesh` or
   React Three Fiber's equivalent) — this is the specific real technical
   problem this brief's "at scale" constraint creates, and it has real,
   documented solutions worth citing precisely.
4. **CSS-only / lightweight alternatives that achieve a similar
   "immersive, tactile" feeling without a full 3D engine**: real modern
   CSS techniques (3D transforms, `conic-gradient`/`radial-gradient`-
   driven fake lighting, CSS `@property`-driven smooth numeric
   transitions, View Transitions API for state changes) that might
   deliver 80% of the immersive feeling at a fraction of the bundle/
   performance cost — research whether any real production site achieves
   a "physical object" feeling this way, and give an honest comparison
   against the full-3D path.
5. **Where real 3D IS justified vs. where it's over-engineering**: give
   an honest verdict on which of this app's surfaces (hero "Trending Now"
   single-collection banner vs. 100-row rankings table vs. small mover
   cards) can actually support real 3D rendering cost, and which
   structurally cannot (the 100-row table) regardless of how clever the
   technique — don't force one visual language onto every surface if the
   real performance math doesn't support it everywhere.

## Deliverable: research AND a real, working build

Unlike prior briefs in this series (research + written design only),
this one explicitly asks for the actual implementation to be handed back:

1. Real citations per research question above, with an honest verdict on
   what's genuinely state-of-the-art vs. what's currently impractical for
   this app's real constraints.
2. A concrete recommendation on WHICH surfaces get which tier of visual
   treatment (e.g.: hero banner = full WebGL/R3F piece; rankings table =
   lightweight CSS/SVG "physical" effect using instanced-friendly
   techniques, not full 3D; detail page progress bar = a middle-tier
   canvas-based or CSS-3D effect).
3. **Real, complete React/TypeScript component code** (not pseudocode)
   for at least the two highest-value surfaces (rankings table row
   indicator + collection detail archive-depth bar), written to
   integrate with this app's real existing conventions: Next.js 16 App
   Router, TypeScript, Tailwind-based styling (check `tailwind.config`/
   existing component class patterns before assuming a different styling
   approach), and consuming real data shapes already established today
   (`archival_score`, `score_method`, job status) rather than inventing a
   new data contract without checking what already exists.
4. Explicit code-splitting/lazy-load strategy so any heavier dependency
   (if recommended) never blocks the initial page load of real
   marketplace data.
5. A real, working `prefers-reduced-motion` fallback path included in the
   same code, not described separately as a TODO.

Label every recommendation "adopt real known technique," "adapt for this
app's specific constraint (many small instances, not one hero object),"
or "genuine new synthesis" — same discipline as every other brief in this
series. If full 3D genuinely isn't justified anywhere on this site given
the real constraints, say so plainly and hand back the best lightweight
alternative instead of forcing a 3D answer to look impressive.
