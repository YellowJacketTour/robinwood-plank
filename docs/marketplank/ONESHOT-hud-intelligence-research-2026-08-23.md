# ONE-SHOT RESEARCH BRIEF: Next-Generation Collection Intelligence HUD

Paste this entire document to a fresh, zero-context AI research session (Grok or otherwise). It is self-contained — you do not need any other context about this project to execute it.

---

## 1. WHO YOU ARE WORKING FOR AND WHY

You are doing deep technical + design research for **RobinWood / Marketplank**, a real, live, multichain NFT marketplace (GitHub org `YellowJacketTour`, repo `robinwood-plank`). It aggregates NFT collections and real trading data across 8+ EVM chains (Ethereum, Base, BNB Chain, Polygon, Arbitrum, Optimism, Avalanche, zkSync), Solana, Bitcoin Ordinals, and its own native "Robinhood Chain." It is a real product with real users and real money moving through it, not a prototype or a demo.

Every collection tracked by the platform (currently spanning hundreds of thousands of real collections across all these chains) has a per-collection "Intel" panel — a business-intelligence surface meant to answer "is this collection real, healthy, and trustworthy?" for a buyer in seconds. **That panel exists today but is visually and experientially a disappointment: a flat page of gray boxes with plain numbers in them.** A real, working screenshot of the current state is described in Section 3 below. It is functionally correct (the numbers are real, sourced from an actual on-chain permanent ledger, never fabricated) but it looks like a spreadsheet, not like intelligence software.

**Your job**: research, at true state-of-the-art / no-budget-limit depth, every real technology, open-source library, rendering technique, and design language that could turn this into something that feels like:
- A **James Bond / Q-Branch heads-up display**
- **Tony Stark's JARVIS interface** (Iron Man movies) — holographic, spatial, reactive to touch/hover, layered depth
- **2001: A Space Odyssey's HAL 9000 / mission-control aesthetic** — cold, precise, high-contrast, deliberate
- A **hyper-advanced institutional business-intelligence terminal** — think Bloomberg Terminal, Palantir Gotham, or a hedge fund's internal trading desk, but for NFT collection trust and provenance instead of equities

This is not a request for a mood board. This is a request for **the actual, real, buildable technology stack** — specific libraries, specific rendering approaches, specific open-source repositories with real GitHub URLs, specific code patterns — that a development team could pick up and implement immediately, for every collection, on every chain, automatically, with zero manual curation per collection.

---

## 2. YOUR CONSTRAINTS — READ THIS CAREFULLY, DO NOT VIOLATE IT

This is the single most important section. Everything you research and recommend MUST be compatible with these hard rules, because they are this project's core identity and cannot be compromised for the sake of a cooler visual:

1. **Never fabricated data.** Every single visual element — every chart, every graph, every number, every animation driven by a data value — must be rendered FROM a real, sourced data point (an actual on-chain event, an actual API response, an actual database row). If a data point doesn't exist yet for a given collection (e.g., a collection has zero priced sales so far), the correct behavior is to show that state HONESTLY (e.g. "no priced sales yet" or an empty/dormant visual state), never to interpolate, estimate, or invent a plausible-looking number to fill the space. Research how real institutional terminals (Bloomberg, Palantir) handle "no data" states elegantly instead of hiding the gap — that pattern matters as much as the "full data" pattern.
2. **Must work identically across ALL chains** — EVM (8 chains), Solana, Bitcoin Ordinals, and a custom L3 chain — with zero chain-specific one-off code. The underlying data model is already chain-agnostic (a unified event ledger of mints/sales/transfers/listings across every chain). Whatever visualization architecture you propose must consume that same unified shape, not require a special build per chain.
3. **Must run automatically, at scale, with zero manual work per collection.** This platform tracks hundreds of thousands of collections. A visualization approach that requires an artist/designer to hand-craft a scene per collection is disqualified. Everything must be generated procedurally from the collection's own real data (its art, its trait distribution, its trade graph, its holder graph, etc.).
4. **Must be real web technology that runs performantly in a browser**, inside a Next.js 16 / React application, without requiring a native app or a heavyweight game engine install. WebGL/WebGPU in-browser is fine and encouraged. A separate Unreal Engine pipeline is not.
5. **No dark patterns.** This is explicitly NOT about manufacturing false hype or FOMO through misleading visuals (no fake "trending" glows on dead collections, no artificially inflated-looking charts). The HUD aesthetic is in service of **clarity and trustworthiness**, the same way a fighter pilot's HUD exists to give correct information faster, not to look cool for its own sake. Research real "data-ink ratio" / information-density design philosophy (Edward Tufte's work is a real, canonical reference point here) and reconcile it with the sci-fi HUD aesthetic — the best real HUD design in film and in actual military/aerospace HUDs is information-dense and beautiful at the same time, not one traded for the other.
6. **Must respect an existing dark, "wood/gold/cream" warm color identity** (the brand is literally called RobinWood, has a wood-grain/carved aesthetic elsewhere in the product) blended with a cooler "intelligence/analytical" palette for this specific panel (the current Intel panel already uses purple/violet as its accent against the dark background, which read as an intentional signal: "you have left the marketplace and entered the analysis layer"). Your visual research should propose a real, specific extended palette and typographic system that bridges both, not replace the brand identity wholesale.

---

## 3. CURRENT STATE — WHAT EXISTS TODAY (BE HONEST ABOUT WHERE THE BAR IS)

The current Intel panel (component name: `CollectionIntelligence`) already computes and displays, per collection, in real time, from real data:
- A **wash-trade suspicion score** (reciprocal round-trip / self-transfer detection across the real sale ledger)
- A **demand score** (recency-weighted momentum, modeled after Hacker News' and Reddit's published "hot" ranking algorithms)
- **Maker/listing concentration** (HHI and Gini coefficient across the real live order book — i.e., "is this collection's liquidity controlled by a tiny number of wallets?")
- **Rarity coverage, holder coverage, and listed-supply coverage** as percentage bars
- An **ask-ladder / floor-depth chart** (a real orderbook depth curve, draggable/scrubbable, showing exact price at exact depth)
- A **rarity-tier composition donut** and a **live-ask maker-share donut**
- **USD-valued sale volume**, when priced sales exist
- Explicit **"Limits" disclosure text** (rarity is metadata-dependent, wash-flags are screening signals not accusations, etc.) — the product deliberately never overclaims certainty

Right now this renders as: gray bordered boxes in a grid, each with a label and a plain number, one line chart, two donut charts, and two horizontal progress bars. It is functionally honest and information-rich but has **zero spatial depth, zero motion design, zero sense of "system coming alive," and no unifying visual metaphor.** A collection with genuinely rich real data (RobinWood's own native collection, 1,542 real minted items, 298 real holders, a real live order book) still looks like an accounting spreadsheet, not like intelligence software. That is the gap you are researching a solution to.

---

## 4. WHAT TO RESEARCH — GO DEEP, GO WIDE, CITE REAL SOURCES

Research and return REAL, SPECIFIC findings (actual project names, actual GitHub repo URLs, actual npm package names, actual published techniques with sources) in each of the following areas. Do not generalize ("use WebGL") — name the actual library, the actual repo, the actual maintainers, the actual license, and the actual reason it fits.

### 4.1 — Real-time / spatial / 3D data visualization libraries for the web
- WebGL and WebGPU-based charting and scene libraries usable inside React (e.g. investigate the current state of `react-three-fiber` + `drei`, `deck.gl`, `regl`, `Cosmos`/`cosmograph`, `Sigma.js`, `Cytoscape.js`, `3d-force-graph`, `VisX`, `Nivo`, `Observable Plot`, `ECharts` (incl. its GL extension), `Recharts`, `Tremor`, and whatever has emerged more recently than these that you can find real evidence of production use for financial/network/graph data in 2026).
- Specifically research **force-directed graph rendering at scale** for visualizing a collection's real holder graph and trade graph (who bought from whom, wallet clustering, whale concentration) as a literal navigable 3D/2D node network — this is a real, natural fit for NFT provenance data and is the single highest-leverage "wow" visual available, because it's real data (every edge is a real on-chain transfer) rendered as something that looks alive.
- Research **real order-book / depth-chart visualization** from professional trading terminals (how do Binance, dYdX, Hyperliquid render orderbook depth with motion and glow) and how those techniques could apply to an NFT listing-ladder instead of a token orderbook.

### 4.2 — Sci-fi HUD / heads-up-display design systems and shader techniques
- Research real open-source "sci-fi UI kit" / "HUD generator" projects (for example, investigate the lineage and current state of projects inspired by "Hyperspace" / glitch-UI generators, WebGL shader-based scanline/glow/glass effects, and any maintained open-source component libraries explicitly built for this aesthetic).
- Research **glassmorphism + holographic shader techniques** achievable in real-time WebGL/CSS (frosted glass panels, chromatic aberration on data-refresh, scanline sweep animations, radar-style rotating sweep reveals, particle systems that represent live data ticks) and cite the specific shader techniques or libraries (e.g. `postprocessing`, `three-stdlib` effects, GLSL patterns) that produce them performantly.
- Research how real military/aerospace HUD design (actual published design guidelines for fighter-jet HUDs, actual NASA mission-control console design history) balances information density with clarity — this should inform WHERE motion and glow are used (to draw attention to a genuinely important state change) versus where flat, still, high-contrast text is correct (for a number someone needs to read precisely, motion is often the wrong choice — cite real research on this trade-off).

### 4.3 — AI-assisted narrative / dossier generation
- Research real, current techniques for turning structured on-chain data into a natural-language "dossier" narrative (the equivalent of an intelligence analyst's written brief) generated automatically per collection — real LLM-in-the-loop architectures for this (e.g. retrieval-augmented generation over a collection's real event history, with hard grounding rules preventing hallucinated claims) — and how that narrative text itself could be integrated INTO the HUD visually (e.g. a "case file" reveal animation, typewriter-style text synced to real data callouts) rather than as a separate wall of text.

### 4.4 — Financial/institutional terminal design precedent
- Research the actual design language of Bloomberg Terminal, Palantir Gotham/Foundry, TradingView, and Hyperliquid/dYdX's professional trading UIs — what specific typographic, color, and layout decisions make these read as "serious professional tool" rather than "consumer app" or "hobbyist dashboard" — and how those specific decisions (not just "make it dark mode") could be adapted.

### 4.5 — Performance and scale reality-check
- For every technique above, research and report the REAL performance cost (can it run at 60fps on a mid-range laptop and a real mobile device, what's the actual bundle-size cost of the library, does it tree-shake, is it SSR-compatible with Next.js's App Router) — a beautiful visualization that is unusable on mobile or that adds 2MB to the bundle for every page load is a real failure mode, not an acceptable trade-off, given this product needs to load fast for real buyers making real purchase decisions.
- Research patterns for **procedural generation of the "scene" per collection from its own data** (e.g. a collection's dominant color palette extracted from its own real artwork driving the HUD's accent color per-collection; a collection's real trait-rarity distribution driving the shape/density of a generated background pattern) so that every collection's HUD feels bespoke without requiring any manual design work — this is real, achievable, and is the mechanism that makes "hundreds of thousands of collections, all automatically world-class" actually possible.

---

## 5. WHAT TO DELIVER BACK — THE FORMAT OF YOUR FINAL ANSWER

Your final output must be a single, organized document (this is the "one-shot" this brief refers to — the document YOU produce is what gets handed to a coding AI to implement) structured as:

1. **Executive summary** — the overall visual/architectural direction you recommend, in plain language, 1-2 paragraphs.
2. **Recommended stack** — a definitive, opinionated list of the specific libraries/packages to install (with real npm package names and current version/maintenance status), organized by concern (3D/spatial rendering, 2D charting, shader/post-processing effects, graph/network layout, animation/motion, AI narrative generation).
3. **Architecture plan** — how these pieces compose together inside a React/Next.js component tree, how they consume the existing unified per-collection data shape (assume: real sale events with from/to/price/timestamp/txHash, real listing orderbook, real holder addresses, real trait/rarity data, real collection artwork URLs — all already available, nothing new needs to be built to source this data), and how the "procedural generation from real data" mechanism from section 4.5 actually works end to end for one concrete example collection.
4. **Component-by-component redesign proposal** — for each of the real, existing panel elements listed in Section 3 (wash-trade score, demand score, maker concentration, rarity/holder/listed coverage, ask-ladder chart, rarity donut, maker-share donut), a specific proposal for what it becomes visually and why, citing the specific technique/library from your research.
5. **New capability proposals** — beyond redesigning what exists, propose 2-4 genuinely new HUD elements made possible by the stack you researched (e.g., the holder/trade force-graph from 4.1, an AI-generated dossier reveal from 4.3) with the same level of specificity.
6. **Honest trade-off table** — for every major recommendation, a short table of (real benefit) vs (real cost: performance, bundle size, implementation complexity, maintenance risk).
7. **Open questions / risks** — anything you're genuinely uncertain about that the implementing team should resolve before building (e.g., "library X is very new, verify current maintenance status before committing").

Do not pad this with generic filler. Every claim must be backed by something real and specific you actually found. If you cannot verify something is real and current, say so explicitly rather than presenting it as settled fact.

---

## 6. FINAL REMINDER

The end goal is not "make it flashier." The end goal is: **a buyer looking at any collection, on any chain, for the first time, should feel like they just walked into a professional intelligence agency's situation room and were handed a real, trustworthy, beautifully rendered case file on that collection in under two seconds** — and every single pixel of that case file must trace back to a real, sourced, honest piece of on-chain data. Research accordingly.
