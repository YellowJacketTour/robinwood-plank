# Research brief for Grok: our biggest current issues — research AND invent novel solutions for the unified vision

Status: **research brief, not a spec.** Hand this to Grok (or any frontier
research model) with an explicit ask to go beyond summarizing prior art —
research exhaustively, then propose genuinely novel, original mechanism
designs where prior art falls short. Written by Sonnet 5, 2026-08-25, from
direct, current, first-hand knowledge of this exact codebase (file:line
references are real, verified live this session, not inferred). Builds on
and supersedes the scope of `GROK-RESEARCH-BRIEF-full-multichain-parity-
2026-08-20.md` (still valid for feature-parity detail) — this brief is about
what's actually blocking the *unified vision* from being real, safe, and
public, based on a critical audit and a full day of live-verified
engineering completed today.

## How to use this document

1. **Don't just research — invent.** Several of the issues below were
   researched exhaustively today and turned out to be genuine dead ends
   with existing tools/APIs (verified live, evidence included). Standard
   research will re-find the same dead ends. The ask is: given the real
   constraints listed, design something novel that doesn't exist yet —
   a new mechanism, a new data-sourcing architecture, a new trust model —
   not a repackaging of what's already been tried and ruled out.
2. **Every claim below is real and live-verified today (2026-08-25)**,
   not guessed. Where an API/venue is described as "dead" or "gated," that
   was confirmed via direct HTTP requests this session, not assumed from
   old docs. Cite these facts as ground truth; don't re-litigate them
   without new evidence.
3. **Ground proposals in this app's real architecture and constraints**
   (section below) — this is not a green-field exercise.
4. **Be explicit about genuinely novel synthesis vs. known patterns.** If
   you're proposing something that doesn't exist in production anywhere,
   say so and reason from first principles. If it's a known pattern
   applied here for the first time, cite where it's proven elsewhere.

---

## Non-negotiable constraints

- **PostgreSQL is the only datastore.** No Redis, no Vercel KV, no
  external cache tier. `PGPOOL_MAX=4` in production (see
  `.env.inmotion.example`) — any proposal that assumes a large connection
  pool or an always-open connection per key is not viable here.
- **Free-tier-first.** This app cannot assume paid API access. Every
  adapter fails closed with a clear error when a key is unset — never
  fabricates data. A proposal that only works with a paid enterprise tier
  of a third-party API is not a real solution for this app's actual
  budget reality.
- **Next.js 16 standalone on a single InMotion Passenger instance.** No
  Kubernetes, no serverless edge functions beyond Cloudflare's standard
  CDN caching, no message queue infrastructure (Kafka/SQS/etc.) currently
  exists.
- **Never fabricate.** This is the single most load-bearing rule in the
  entire codebase (see `lib/market/multichain/venue-registry.ts`'s own
  header and dozens of "confirmed live" / "could not verify, left
  unbuilt" comments throughout `lib/market/multichain/`). Any proposed
  solution must fail closed and say so honestly, never approximate real
  data with a plausible-looking guess.
- **Trading/fulfillment code is currently unaudited** (see Issue 1) — any
  proposal that expands what code can move real user funds must be
  explicitly flagged as blocked on that audit, not bundled in as if it
  were free to build.

---

## Issue 1 (CRITICAL — blocks any public alpha): zero third-party audit on cross-chain trading code, with self-admitted untested paths

A dedicated adversarial audit today found:

- Every existing security audit (`docs/marketplank/AUDIT-2026-07-27.md`,
  `AUDIT-2026-07-27-fable.md`, `AUDIT-2026-08-01-v3-internal.md`) scopes
  only the native Marketplank/Seaport flow on Robinhood Chain. None
  mention `lib/market/multichain/trading/foreign-fulfill.ts`,
  `foreign-offer.ts`, `native-fulfill.ts`, Bitcoin, or Solana trading.
  Nine real fund-moving functions in `foreign-fulfill.ts` alone have never
  been reviewed by anyone outside this codebase.
- The code **admits, in its own comments**, that it hasn't been proven:
  `magiceden-solana-trade.ts:64-70` ("NOT YET LIVE-TESTED against a real
  API key"), `bitcoin-utxo-safety.ts:31,123` ("NOT yet exercised/live-
  verified against a real inscription-bearing UTXO"),
  `native-bitcoin-listing.ts:104` ("does NOT yet prove interop with an
  actual THIRD-PARTY WALLET"), `foreign-fulfill.ts:1146,1240` (receiver/
  executor contracts "not yet deployed").
- Zero test coverage on the highest-risk files: `foreign-fulfill.ts` (9
  fund-moving functions), `native-fulfill.ts`, `foreign-offer.ts`,
  `magiceden-solana-trade.ts`, `tensor-solana-trade.ts`.
- No legal disclosure exists anywhere for the cross-chain aggregator —
  the generic `/terms` page only covers the native RobinWood collection,
  never mentions that a foreign-chain trade routes through unaudited
  bridging code against third-party inventory (OpenSea/Magic Eden/UniSat)
  where RobinWood is not the counterparty.

**What we need from you:** research real, production-proven models for
*progressively de-risking* unaudited multi-chain trading code before a
full audit is affordable/scheduled — e.g., are there real precedents for
a "canary" trading mode (hard USD-value caps per trade, per-wallet, per-
day, enforced server-side, that make a worst-case exploit bounded and
survivable) used by other cross-chain protocols during their own pre-
audit period? Is there a real, citable mechanism-design or security-
engineering framework for *quantifying* how much unaudited-code risk a
hard value cap actually removes, so this could be presented as a
defensible interim posture rather than "just trust us"? This is a
place where genuinely inventing a novel, well-reasoned interim safety
mechanism (not just "get an audit," which we know) would have real value.

## Issue 2 (HIGH): rate-limit/capacity assumptions were built for one developer, not public traffic — partially fixed today, real gap remains

Today we designed and shipped a real request-coalescing + stale-while-
revalidate cache (`lib/market/multichain/singleflight-cache.ts` — a
Postgres-conditional-UPDATE lease, not a session-scoped advisory lock,
specifically because `PGPOOL_MAX=4` is too small to hold a connection
open across a network-bound fetch), live-verified to collapse 10
concurrent callers into 1 upstream call. Wired onto 5 previously-uncached
live routes today.

**What's still unsolved:** this only solves the "many visitors, same
collection" case. It does NOT solve raw *aggregate* request volume across
many *different* collections under real public alpha traffic hitting a
genuinely small free-tier quota (Helius free tier is hardcoded as "2 RPS"
in `helius-key-pool.ts:43-44`; Alchemy's demo key is explicitly flagged
"never a production credential" in `alchemy-network.ts:43`).

**What we need from you:** research and, ideally, invent a real answer to:
given a hard, small, real rate-limit ceiling per provider (not
infrastructure we can scale our way out of, since we can't pay for more
QPS from Helius/Alchemy on day one), what is the state-of-the-art
approach to *gracefully degrading breadth of freshness* under load — e.g.
is there real prior art for a system that automatically widens cache TTLs
and/or serves progressively older-but-honestly-labeled data as aggregate
QPS approaches a provider's ceiling, rather than either (a) exhausting the
quota and breaking for everyone, or (b) a fixed TTL that's either too
aggressive normally or too loose under load? This is close to classic
admission-control/load-shedding literature (token buckets, adaptive rate
limiting) — but the specific twist here (multiple *independent* rate-
limited upstream providers feeding one shared cache layer, serving a
public read-heavy audience) may not have an off-the-shelf answer. Propose
one if it doesn't.

## Issue 3 (HIGH): structurally lopsided chain coverage, and today's research proved several "gaps" are permanently, externally blocked — not solvable by more engineering effort

Of ~30 tracked venues, only 1 (RobinWood's own book) is `coverage:
"indexed"`. Today, six parallel real-evidence investigations (each
verified via live HTTP requests, not guessed) found:

- **Tensor** (Solana's largest NFT marketplace by volume): real API
  exists (`api.mainnet.tensordev.io/graphql`), confirmed live, but
  returns a genuine `403: required x-tensor-api-key`. Tensor's own
  current docs confirm **no self-serve free tier exists** — access is
  approval-gated via a live Airtable application form.
- **Best in Slot**: confirmed the entire hosted API has been **retired**
  (`docs.bestinslot.xyz` states verbatim "This API has been retired...
  new API keys are not being issued"; the API hostname now 301-redirects
  to an unrelated third-party logistics product). Their own suggested
  replacement is "run OPI yourself" — a self-hosted indexer requiring
  ~1-1.5TB of storage and a fully synced Bitcoin node, already ruled out
  earlier this project for disk-space reasons.
- **Ordzaar**: confirmed no server-side marketplace API exists anywhere —
  their live site is a mint launchpad, not an order-book marketplace;
  their GitHub org only publishes client-side wallet SDKs.
- **ORD.NET**: sales/offers are real, fully documented API endpoints
  (confirmed via their actual OpenAPI 3.1 contract), but every one sits
  behind bearer auth that can only be obtained by a wallet holding **0.01
  BTC confirmed** at a challenge address — a real financial precondition,
  not a technical one.
- **OKX Ordinals**: real, live endpoint confirmed (`web3.okx.com`), but
  fully key-gated with no public tier; the owner's API application is
  still pending as of today.

**What we need from you:** this is the crux of the "invent, don't just
research" ask. Given that four of five investigated Bitcoin/Solana venues
are blocked by things no amount of our own engineering effort resolves
(paywalls, retirements, capital requirements, approval queues) — is there
a genuinely novel data-sourcing architecture that could close this gap
WITHOUT depending on any single gated venue API? Specific angles worth
exhausting:
  - **Direct on-chain-first sourcing**: for Bitcoin Ordinals specifically,
    is there a real, provably-correct way to derive marketplace-grade
    listing/sale data directly from Bitcoin's own chain state (PSBT
    inscription-transfer patterns, known marketplace script templates)
    without needing any indexer's off-chain database at all? This
    project already has `solana-metaplex-reads.ts`/`solana-editions.ts`
    doing exactly this for Solana (free, on-chain-first, no paid indexer)
    — is there a real Bitcoin/Ordinals equivalent, and if it doesn't
    exist as prior art, could one be designed?
  - **Federated/community indexing**: has anyone built a real, working
    protocol for many independent low-resource node operators to each
    index a shard of Bitcoin Ordinals data and merkle-attest/gossip
    results, such that no single operator needs the ~1TB+ OPI requires?
    This may be genuinely unsolved — if so, sketch the actual mechanism
    (data model, attestation/dispute-resolution scheme, incentive to
    participate) rather than just noting the idea.
  - **Cross-venue price-discovery inference without direct book access**:
    for a venue like Tensor where we can't read the book directly, is
    there a legitimate (non-scraping-ToS-violating) way to infer a
    reasonable floor/activity signal from data we CAN access (e.g. on-
    chain program logs for the trades themselves, since even a gated API
    can't hide a real settled Solana transaction from public RPC reads)?
    This project already knows the real program IDs for several Solana
    marketplaces from `tensor-solana-trade.ts` — could raw program-log
    decoding (the same technique this app's HyperSync EVM fill-indexers
    already use for Seaport/Blur/X2Y2/LooksRare) produce a real, free,
    always-available activity/price feed for Tensor specifically, sidestepping
    their gated read API entirely by reading the *settlement*, not their
    off-chain index? Research whether Tensor's on-chain program has a
    stable, decodable instruction/log format, and if so, propose a real
    scanner design mirroring this app's existing HyperSync scanner
    pattern (`lib/market/multichain/discovery/hypersync-seaport-scan.ts`
    et al.).

## Issue 4 (MEDIUM, but structurally connected to the above): ~30+ honest gaps are invisible to anyone but a source-code reader

We shipped a public `/market/multichain/known-limitations` page today
(generated directly from `venue-registry.ts`, not hand-maintained) as a
first pass at this. **What we need from you:** research real, production
examples of how other aggregator products (price aggregators, cross-chain
bridges, multi-exchange trading terminals) communicate partial/uneven data
completeness to end users *in the actual product UI*, not just a separate
docs page — is there a proven UX pattern for signaling "this number is
real but less complete than that one" inline, at the point of decision,
without it reading as an alarming disclaimer that erodes trust in the
whole product? This is a genuine product-design research question, not
just an engineering one.

## The "unified vision" ask, stated plainly

The stated goal across this whole project is one seamless global
marketplace where every chain, every collection, every venue behaves as
though it has the same quality of data and trading safety — without
users ever needing to know that RobinWood's own book is audited and
complete while a Bitcoin Ordinals venue three clicks away is running on
a free-tier indexer with known gaps, and a Solana marketplace's live
book can't be read at all without an approval-gated key.

Today's work proved that closing this gap venue-by-venue keeps running
into walls that are economic/legal/capital-based, not technical. Take
that as the real starting condition and propose the most genuinely novel,
well-reasoned architecture you can — for data completeness (Issues 3-4),
for load resilience under real public traffic on a real small budget
(Issue 2), and for a defensible interim safety posture while a real audit
is pursued (Issue 1) — that gets this project closer to that unified
vision without requiring capital or third-party approval this project
doesn't currently have.
