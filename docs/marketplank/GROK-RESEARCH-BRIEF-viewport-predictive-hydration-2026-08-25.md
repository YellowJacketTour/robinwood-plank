# Research brief for Grok: viewport-aware, predictive, threshold-driven continuous hydration

Status: **research + implementation brief.** Hand this to Grok with an explicit
ask to research real prior art (predictive prefetching, viewport-driven data
loading, recommendation-adjacent "likely next" modeling) AND propose a
concrete, buildable design for this exact codebase. Written by Sonnet 5,
2026-08-25, from direct, current, first-hand knowledge of this exact
codebase (file:line references are real).

## The problem, concretely

Today, `/market/multichain` renders a rankings table of 100+ collections at
once (`components/market/GlobalMarketHub.tsx`). Just fixed a real bug where
a dead marketplace (X2Y2) was being shown as the "primary venue" for every
collection with no exact venue match (`lib/market/multichain/venue-
registry.ts`'s `primaryVenueForCollection`) — now fixed, but fixing it
surfaced the real underlying gap: **every non-native EVM collection
correctly shows an honest "OpenSea · PARTIAL BOOK" chip, because that
venue's coverage genuinely is partial at the registry level** (see
`opensea-seaport-1.6`'s entry: block-0-to-tip HyperSync completeness isn't
proven per chain/version cell yet).

That's honest, not a bug — but it's also static. The owner's ask: **whatever
collections are actually visible on a user's screen right now (rankings
grid, a collection detail page, the "biggest movers" strip, related-
collections rail) should be prioritized for continuous, threshold-gated
hydration/verification, building out "the universe they're likely to
navigate to next" — not just relying on the existing background cadence.**

## What already exists (read these first, real code, not hypothetical)

- `lib/market/multichain/collection-demand.ts`'s `prioritizeCollectionDemand(chainSlug, collectionKey)` — enqueues real, deduplicated background jobs (`enqueueDataJob`, `mesh-lane:{chainSlug}` kind) at real priority numbers (90-100 range) for membership/rarity/stats sources, keyed so the mesh naturally coalesces duplicate requests. **This is only ever called when a single collection's detail page loads server-side** (e.g. `app/api/market/multichain/collection/route.ts:28`) — never for collections merely rendered in a list/grid.
- `lib/market/multichain/mesh/jail.ts` + `source-budget.ts` — existing per-provider capacity/backoff for background indexing (a DIFFERENT, already-solved problem from what's needed here).
- `lib/market/multichain/singleflight-cache.ts` + `lib/market/multichain/freshness-budget.ts` (both built earlier today, live-verified) — request-coalescing + free-tier-quota-aware adaptive TTL for LIVE user-facing fetches. Any new viewport-driven demand signal MUST route through these, not bypass them, or it reintroduces the exact "N visitors, N upstream calls" problem these were built to solve.
- `components/market/GlobalMarketHub.tsx` and `components/market/MultichainCollectionView.tsx` — the two client surfaces that would need to emit visibility signals.
- The registry's `coverage` field (`indexed`/`partial`/`planned`/`unavailable`) is a **venue-level, not collection-level** classification today — a real design question this brief should address is whether per-collection completeness needs its own finer-grained tracking (the `CapabilityCoverageCell` system in `lib/market/multichain/capability-coverage.ts` already tracks per-chain/venue/protocol-version state — check whether that's the right substrate to extend, or whether a new per-collection completeness signal is needed).

## What to research (real prior art)

1. **Viewport-driven data loading / lazy-hydration-on-visibility.** IntersectionObserver-based patterns are well-established (infinite scroll, lazy image loading) — but this needs BATCHED demand signaling (don't fire one request per visible row; batch visible collection IDs into one periodic call) with debouncing for fast scrolling. Real prior art: how do large data-grid products (financial tickers, e.g. Bloomberg Terminal-style UIs, or open-source examples like TradingView's watchlist) batch "what's currently visible" into backend prioritization signals without hammering the backend on every scroll frame?
2. **Predictive prefetching / "likely next" modeling.** Real, citable techniques: hover-intent prefetching (Next.js's own `<Link prefetch>` is a simple version of this), navigation-graph-based prediction (Google's "quicklink" library prioritizes links likely to be clicked based on viewport position + connection speed), and recommendation-adjacent techniques (collaborative filtering is overkill here, but simple heuristics like "same chain as current page," "adjacent rank in the sorted table," "same creator/collection family" are real, cheap signals worth citing precedent for if it exists).
3. **Threshold-gated escalation ("constant live improvement within thresholds").** This app already has exactly this pattern in miniature: `freshness-budget.ts`'s pressure-based TTL widening. Research whether there's a real, generalizable "escalating priority tiers" pattern for background job systems — e.g., does a job's priority increase the longer/more-often it's been requested-but-not-yet-fresh (analogous to aging in OS schedulers — CPU scheduling's "aging" technique prevents starvation by boosting a waiting process's priority over time; is there a real, direct precedent for applying this to a data-freshness queue rather than a CPU scheduler)?
4. **"Intelligence agency level" framing** — the owner used this phrase; translate it honestly. The real, grounded interpretation is: a system that treats "what is a real user looking at or about to look at" as the single most important prioritization signal for finite hydration capacity, ahead of any fixed background cadence. This is a real, well-established product pattern (it's what makes Bloomberg terminals and trading platforms feel "live" — visible data gets priority bandwidth) — cite real examples if you can find documented architecture write-ups, but don't invent a surveillance-flavored framing that doesn't fit a public NFT marketplace's actual constraints (no user tracking beyond what's needed to know which collections are currently rendered in someone's open tab).

## Concrete design questions to answer

1. **Signal collection:** should visibility be reported via IntersectionObserver on each row (batched client-side into one periodic POST of visible collection ids), or via a simpler "what's on this page" signal derived server-side from the already-known query (chain filter + sort + pagination = a deterministic list of what's being requested, no client instrumentation needed for the rankings table specifically, though a detail page's "related collections" rail would still need client signaling)? Recommend the simplest mechanism that actually covers both surfaces.
2. **New demand-priority entry point:** should `collection-demand.ts` gain a new `prioritizeVisibleCollections(chainSlug, collectionKeys[])` batch variant of the existing single-collection function, reusing the same `enqueueDataJob` mesh-dedup mechanism? What priority tier should "currently visible" get relative to the existing 90-100 range (should it be a NEW, higher-priority tier reflecting real-time user attention, or fit into the existing scale)?
3. **Aging/escalation:** if a visible collection's data is still stale after N seconds/requests, should its priority actually increase (aging), and if so, by what schedule, and where does that state live (Postgres, matching this app's Postgres-only constraint — likely a small table tracking `collection_key, first_seen_visible_at, last_hydrated_at, current_priority`)?
4. **Rate/cost control:** how does this interact with `freshness-budget.ts`'s per-provider budgets? A viewport full of 100 partial-coverage collections must NOT translate into 100 simultaneous upstream calls the moment a user opens the rankings page — the existing FBC pressure model should throttle this automatically if wired correctly, but confirm the design explicitly accounts for "many collections become visible at once" as a burst pattern, not just "one popular collection gets many concurrent viewers" (the case FBC was originally built for).
5. **What "hydrated to full" actually means for a partial venue:** be honest in the design that for structurally partial venues (OpenSea/Seaport's block-0-to-tip completeness proof), no amount of demand-priority makes the coverage flag flip to "indexed" — that requires the separate, real verification project described in `opensea-seaport-1.6`'s registry note. This system should instead target the things that GENUINELY do resolve with more hydration effort: per-collection metadata completeness, rarity index completion, real-time price freshness within the FBC's TTL model, art/image resolution — not falsely promise that "partial" venue classifications disappear once enough people look at a collection.

## Deliverable

A concrete, buildable design (not just principles) covering:
- The exact new function signature(s) and where they get called from (client visibility signal -> API route -> `collection-demand.ts` -> `enqueueDataJob`).
- The Postgres schema for any new aging/escalation state.
- How this composes with `singleflight-cache.ts` and `freshness-budget.ts` without bypassing either.
- A realistic scope statement distinguishing "this makes visible collections hydrate faster/fresher within real constraints" from "this makes structural coverage gaps disappear" (it does the former, not the latter — be explicit about this in the design's own documentation so a future reader doesn't misunderstand what was built).
