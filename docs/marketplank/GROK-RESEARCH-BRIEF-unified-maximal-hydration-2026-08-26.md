# Research brief for Grok: exhaustive, worldwide, maximum-spectrum research toward one unified discovery/indexing/hydration/prediction architecture across every chain this app covers

Status: **research + invention brief.** Go beyond describing known patterns —
survey the real state of the art across every relevant domain (blockchain
indexing, distributed systems, CDN/edge caching, predictive prefetching,
crawler theory, P2P/gossip networks, ML-driven demand modeling), then
synthesize a genuinely novel, unified design this app can actually build.
Written by Sonnet 5, 2026-08-26, from direct, current, first-hand knowledge
of this codebase.

## The ask, in the owner's own words

"perform exhaustive world wide max spectrum research to produce an organic
and totally outside the scope of modern understanding elegant solution that
can be implemented to maximally overcome all limiting factors for discovery,
indexing, hydrating, visitor prediction maximum service accommodation
instinct and to craft it specifically unified across all our chains and
configurations and intentions for this one market all markets all features
and maximum detail in every facet. we also need intel to have the ability to
auto hydrate and back fill and whatever else on all chains and collections."

Translated into concrete engineering scope: **one coherent architecture**
(not eleven per-chain bolt-ons) that (1) discovers every real collection on
every chain this app covers, (2) indexes/hydrates their real token, listing,
offer, bid, and fill data, (3) predicts what a visitor is about to need
before they ask for it, (4) runs auto-backfill continuously and
unsupervised across the entire catalog with no manual per-collection
trigger required, and (5) does all of this within real, free-tier
infrastructure constraints, honestly.

## Real, current state (verify against the live repo before proposing
anything — don't design against a stale mental model)

This app already has a substantial amount of real, live, working
infrastructure for exactly this problem, built incrementally this session.
Read the real files before proposing something that duplicates or conflicts
with them:

- **Mesh/job-queue control plane**: `lib/market/multichain/control-plane.ts`
  (`plank_data_jobs` table, `enqueueDataJob`/`claimDataJob`/`finishDataJob`,
  Postgres-lease-based, not Redis), `lib/market/multichain/mesh/matrix.ts`
  (`MESH_LANES` — 44 real lanes across every chain/source combination),
  `scripts/mesh-tick.ts` (the scheduler, bounded concurrency, spawns
  isolated child processes per lane), `scripts/mesh-tick-supervisor.sh`
  (crash-resilient wrapper, now actually kept running — this was a real gap
  found and fixed 2026-08-24, jobs previously sat queued forever with
  nothing claiming them).
- **Demand-driven prioritization**: `lib/market/multichain/collection-demand.ts`
  (`DEMAND_PRIORITY` tiers — VISIBLE=110, VISIBLE_STALE_AGED=120,
  PREDICT_NEXT=100, DETAIL_PAGE=95, SIBLING_EXPAND=70, BACKGROUND=50,
  UNKNOWN_KEY=15, ARCHIVAL_FRONTIER=10), `prioritizeVisibleCollections`.
- **Viewport-aware predictive hydration** (already real prediction, not
  hypothetical): `hooks/useVisibleCollectionDemand.ts` (IntersectionObserver,
  batched/debounced), `app/api/market/multichain/visibility-demand/route.ts`,
  same-rank-neighbor expansion (`expandRankAdjacency` — if a visitor is
  looking at rank 47, ranks 45-49 get a demand nudge too, a real, working,
  cheap predictive-prefetch primitive).
- **Opportunistic Archival Ledger**: `lib/market/multichain/archival-ledger.ts`
  (`collection_archival_stats`, `recordArchivalHydration`,
  `backfillArchivalStatsFromExistingTokens`, `runArchivalFrontierLane` — a
  real, working, honest "no stone left unturned" background frontier lane,
  558,646 collections seeded, currently ~558k tracked, 33,111 with a real
  known supply, growing).
- **Freshness Budget Controller**: `lib/market/multichain/freshness-budget.ts`
  (per-provider adaptive TTL widening under real measured pressure) +
  `lib/market/multichain/singleflight-cache.ts` (request coalescing +
  stale-while-revalidate, durable-KV-backed).
- **Just-shipped real hourly pacer** (2026-08-26):
  `lib/market/multichain/discovery/opensea-key-pool.ts`'s
  `claimOpenSeaPaceSlot` — an atomic, cross-process, durable token-bucket
  pacer (6.2s spacing = 600/hour) that stops bursts from tripping a real
  vendor 429 in the first place, rather than reacting to the 429 after the
  fact. This is the first REAL smooth-pacing primitive in this app; every
  other provider still gates on daily ceilings + reactive circuit-breaker
  jails only (see `lib/market/multichain/discovery/source-budget.ts`) — a
  real, known, unsolved gap this brief should address generally, not just
  for OpenSea.
- **Real per-chain sources currently wired** (see
  `lib/market/multichain/venue-registry.ts` for the full real list, and
  `lib/market/multichain/mesh/matrix.ts` for the real lane list): HyperSync
  log scans (Seaport 1.1-1.6, Wyvern, Blur, LooksRare, X2Y2,
  CryptoPunks-native — all EVM chains), OpenSea (membership/stats, key
  pool), Alchemy (evm-metadata), Helius (Solana DAS), Magic Eden (Solana),
  UniSat/Ordiscan/Ordinals Wallet (Bitcoin Ordinals), Tensor on-chain
  listing scan (`getProgramAccounts`, real, 115k+ accounts in one pass),
  mempool.space (Bitcoin settlement inference).
- **Chains covered today**: eth-mainnet, base-mainnet, arb-mainnet,
  opt-mainnet, polygon-mainnet, bnb-mainnet, avax-mainnet, zksync-mainnet
  (EVM, 8 chains), solana-mainnet, bitcoin-mainnet (Ordinals), robinhood
  (this app's own first-party chain/order-book).
- **The one load-bearing rule everything above already follows, and this
  brief's answer must too**: never fabricate. `archival-ledger.ts`'s
  `scoreFromCounts` returns `null`/`unknown_supply` rather than invent a
  percentage; every provider budget is a real documented number or
  explicitly absent (never a guessed placeholder) — see
  `source-budget.ts`'s own extensively-commented history of REMOVING
  self-imposed fake ceilings once no real citation could be found for them.

## Non-negotiable constraints (read before proposing anything)

- **Free-tier-first, no new paid infrastructure.** Every real source this
  app uses today is free-tier or already-paid-for-a-different-reason
  (Alchemy). A proposal that requires a new paid indexer subscription,
  dedicated GPU cluster, or managed message queue is not "outside the scope
  of modern understanding," it's a checkbook, and this app has explicitly
  and repeatedly rejected building against unverified assumed budgets this
  session (see `source-budget.ts`'s header on the several self-imposed
  ceilings that were REMOVED after being found to be guesses).
- **Real, not fabricated.** Nothing in the resulting design may present an
  invented number, a guessed completeness percentage, a hallucinated
  provider rate limit, or a decorative-only animation as if it reflected
  real state. This is the single most enforced rule in this entire
  codebase — violating it in a new, cleverer-sounding form (e.g., a
  probabilistic estimate presented as certain) is still a violation.
- **Postgres is the only datastore.** `lib/market/durable-kv.ts`'s own
  header: Redis/Vercel KV backends were removed as dead code and must not
  be reintroduced. Any proposed architecture (distributed cache, job queue,
  pub/sub, gossip layer) must be buildable on Postgres (already proven
  viable for the lease-based job queue, the durable KV, the singleflight
  cache, and the atomic pacer above) or justify, with a real citation, why
  Postgres genuinely cannot do it before reaching for anything else.
- **This app never bypasses a chain's own real state.** Independently
  verified on-chain truth (HyperSync log scans, `getProgramAccounts`,
  verified sequential mint enumeration) is always the ground truth;
  third-party provider data enriches it, never overrides it. See
  `advanceEvmCollectionMembership`'s own header: "Provider results enrich
  these rows; they do not define the collection's size."
- **No solution that only works for the chains it was designed against.**
  "Unified" means the SAME core primitives (discovery, hydration job
  shape, prediction signal, backfill frontier) must genuinely serve EVM,
  Solana, Bitcoin/Ordinals, and this app's own first-party chain — not one
  elegant EVM answer plus three separate afterthoughts. If a real
  architectural difference between chain families makes full unification
  dishonest to claim, say so plainly and specify exactly where the
  unification boundary has to sit and why.
- **A single spawned-child-process-per-job model has a real, measurable
  cost** (Node+tsx cold start per `mesh-lane.ts` invocation) that today's
  architecture already pays on every single job, including tiny ones (6
  tokens per `evm-metadata` batch). Address this explicitly: is a
  long-lived worker pool, a different job-batching strategy, or something
  else the real fix, and what's the honest tradeoff (crash-blast-radius,
  memory growth, restart-losslessness) against the current crash-resilient
  short-pass design?

## What to research (real, specific, cite real sources/precedent)

1. **Production blockchain indexer architectures at real scale**: how do
   TheGraph, Reservoir, SimpleHash, Alchemy's own NFT API, Dune, Flipside,
   and Subsquid actually structure discovery -> index -> serve at the scale
   of "every collection on every chain," not just one chain? What do they
   do differently for predictive/pre-warmed data vs. on-demand? Cite real,
   current architecture docs/blog posts, not assumed designs.
2. **Distributed crawler/frontier theory**: real, citable techniques for
   "which of N million things do I check next" under a hard rate budget
   (this is exactly `selectArchivalFrontierBatch`'s problem today, solved
   simply) — priority-queue crawlers, Bloom-filter-based dedup at scale,
   adaptive re-crawl scheduling (how search engines decide re-crawl
   frequency per URL based on observed change rate — is there a real,
   citable analogue for "how often does this collection's floor/listings
   actually change" that could replace today's flat TTLs with something
   smarter and still honest?).
3. **Predictive prefetching / demand modeling**: real, production examples
   of "predict what a user is about to look at and have it ready" beyond
   simple viewport/rank-adjacency (already built here) — CDN edge
   prefetching heuristics, real recommender-system techniques applied to
   pre-warming rather than ranking, and an honest verdict on whether any of
   this is justified given this app's real traffic scale vs. added
   complexity risk of over-fetching and wasting free-tier budget on
   predictions that don't pan out.
4. **P2P / gossip / federated indexing**: is there a real, citable case for
   this app's own future visitors' browsers contributing lightweight
   verification/discovery work (already partially true via the
   Opportunistic Archival Ledger's "any visitor's hydration compounds
   forever" design) — and where is the real line between "elegant
   distributed contribution" and "asking a browser to do server work it
   shouldn't," given this app's own explicit real-signer/real-write
   discipline?
5. **Real per-provider rate-limit pacing beyond OpenSea**: the pacer built
   2026-08-26 for OpenSea (`claimOpenSeaPaceSlot`) is the first real smooth
   pacer in this app; every other provider (Alchemy, Helius, Magic Eden,
   UniSat, HyperSync, mempool.space) still only has a daily ceiling +
   reactive circuit-breaker. For each, find that provider's REAL current
   documented rate limit (not a guess — this app has a strict, lived
   history of removing self-imposed limits that weren't backed by a real
   citation) and specify whether the same atomic-pace-slot pattern applies,
   or whether a different real technique (token bucket with burst
   allowance, leaky bucket, sliding window) is genuinely more correct for
   that provider's real documented behavior.
6. **Worker/process architecture for many small jobs**: real, current
   patterns for high-throughput job execution where each unit of work is
   small (a 6-token metadata batch, a single collection's fill scan) —
   long-lived worker pools with in-process job loops vs. today's
   spawn-per-job model, and a real, honest cost/benefit given this app's
   crash-resilience requirements (a single long-lived process crashing
   mid-batch vs. many independent short processes).
7. **Auto-backfill-everything, honestly bounded**: real precedent for "walk
   the entire universe of a chain's history/state with no manual trigger,
   forever, safely" — this app has already built one real instance of this
   (`scripts/genesis-seaport-backfill-pass.mjs`, walking every EVM chain
   from block 0, and the real bug just fixed 2026-08-25 where it spun the
   disk full during a jail with no per-round backoff) — research the real
   failure modes of unattended-forever backfill jobs (runaway resource
   consumption, silent staleness, un-noticed permanent failure) and what
   real production systems do to keep a "run forever, cover everything"
   job observably healthy without a human watching it.

## Deliverable

1. Real citations per research question above, with an honest verdict on
   what's genuinely applicable to THIS app's real constraints (free-tier,
   Postgres-only, honest-never-fabricate, multichain) vs. what's
   theoretically interesting but not actually buildable here.
2. **One concrete, unified architecture** — not a list of unconnected
   upgrades — that ties discovery, hydration, prediction, and
   auto-backfill into a single coherent model reusable across every chain
   family this app covers, explicitly built as an evolution of the real
   primitives listed above (control-plane.ts, collection-demand.ts,
   archival-ledger.ts, singleflight-cache.ts, freshness-budget.ts), not a
   parallel system that ignores or replaces them wholesale.
3. A real, specific answer to "auto hydrate and backfill on all chains and
   collections" — what triggers it, what bounds it (so it can never repeat
   the 2026-08-25 disk-fill incident), how it's observable/provably
   healthy without a human checking logs, and how it fits the existing
   `plank_data_jobs`/mesh-lane job model rather than inventing a second,
   parallel job system.
4. A specific, honest answer to the process-architecture question in
   constraint 6 above (spawn-per-job vs. long-lived workers) with a real
   recommended migration path if a change is warranted, not just "consider
   both."
5. Real code for whatever new primitive(s) the design calls for that don't
   already exist (e.g., a generalized version of `claimOpenSeaPaceSlot` for
   every provider, a real adaptive re-crawl-frequency function replacing a
   flat TTL) — written to integrate with this app's real conventions
   (TypeScript, Postgres via `postgresQuery`, the existing
   `lib/market/multichain/` module layout) rather than described only in
   prose.

Label every recommendation "adopt real known technique," "adapt for this
app's specific constraint," or "genuine new synthesis" — same discipline as
every other brief in this series
(`docs/marketplank/GROK-FINDINGS-*-2026-08-25.md`). If a piece of the ask
genuinely isn't real/buildable within these constraints (a claimed
"outside the scope of modern understanding" technique that turns out to be
either already-known-and-already-built here, or not actually real), say so
plainly rather than inventing something impressive-sounding to fill the
gap — this app's own standing rule, applied to research as much as to
runtime numbers.
