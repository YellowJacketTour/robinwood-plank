# Research brief for Grok: exhaustive global research + novel invention for unified cross-chain indexing

Status: **maximal-depth research + invention brief.** This is the capstone
ask across everything researched today (see the reading list at the bottom).
The instruction is explicit: search the entire real body of available
knowledge — academic distributed-systems literature, blockchain-indexing
research papers, production architecture write-ups from real indexing
companies, protocol specs, developer forum/Discord/GitHub-issue discussions
among people who actually run this infrastructure — at the depth and breadth
of a formal research effort, not a quick summary of top search results. Then,
where real prior art runs out, invent genuinely novel architecture reasoned
from first principles, held to the same standard of rigor. Written by
Sonnet 5, 2026-08-25, from direct, current, first-hand knowledge of this
exact codebase.

## What "CIA-level PhD research around the entire internet globally" means, translated honestly

There is no literal intelligence-agency research methodology to apply here,
and this brief is not asking for one — translating the owner's intent
directly: **the most exhaustive, most globally-sourced, least-narrow research
pass this task has ever been given**, treating "indexing blockchain data at
scale, cheaply, completely, and verifiably" as a real, decades-deep field
with real unsolved and solved problems, and mining ALL of it — not just the
first few blog posts a narrow search turns up. Concretely, that means
searching and synthesizing across:

- **Academic literature**: distributed systems (consensus, CRDTs, gossip
  protocols, Byzantine fault tolerance as it applies to trustless
  aggregation of many independent data sources), database literature
  (materialized view maintenance, incremental computation, LSM-tree/append-
  only log architectures relevant to blockchain's own append-only nature),
  and any blockchain-indexing-specific papers (search terms worth
  exhausting: "blockchain indexing," "verifiable off-chain computation,"
  "light client data availability," "state sync protocols," "optimistic
  indexing with fraud proofs," "zk co-processors for blockchain data").
- **Real production indexer architectures**, studied in depth, not just
  named: The Graph Protocol (subgraphs, its decentralized indexer/curator/
  delegator economic model, and its real documented scaling limits),
  Goldsky, Dune Analytics (their real ingestion architecture, published
  engineering blog posts), Flipside Crypto, Chainbase, Space and Time
  (their "Proof of SQL" verifiable-database approach — real, citable, worth
  understanding deeply since it's a genuinely novel verifiable-indexing
  primitive), Ponder/Envio HyperSync (already used in this codebase — read
  their own architecture docs for what they explicitly say HyperSync is
  and isn't good for), and any Solana-specific (Yellowstone gRPC geyser
  plugins, Triton One's infrastructure), Bitcoin-specific (electrs,
  fulcrum, mempool.space's own indexer architecture — already partially
  used today via its free API), and cross-chain (LayerZero/Wormhole's
  message-indexing needs, which are a structurally similar problem to
  NFT-marketplace cross-chain aggregation) prior art.
- **Real economic/incentive-design research** for decentralized indexing
  specifically (The Graph's own tokenomics papers, any academic
  mechanism-design work on incentivizing honest data indexing without a
  trusted central operator) — relevant because this app's earlier research
  today (`GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md`,
  section 3c, "Shard-Attested Settlement Log") already sketched an
  amateur version of this; a real literature search may reveal this is a
  solved or partially-solved problem worth learning from rather than
  re-inventing naively.
- **Real, current developer sentiment** — GitHub issues/discussions on the
  real indexer projects named above, Reddit/Discord/Twitter discussions
  among people who run this infrastructure in production, complaining
  about real pain points (cost, staleness, chain-reorg handling, historical
  backfill time) — actual practitioner experience matters as much as
  official documentation.

## Non-negotiable constraints (read before proposing anything — same as every other brief this session)

- **PostgreSQL is the only datastore.** No Redis, no Kafka, no dedicated
  time-series DB, no vector DB. `PGPOOL_MAX=4` in production.
- **Free-tier-first, no paid infrastructure assumed.** Every existing
  adapter in this codebase fails closed rather than fabricating data when
  a key/quota is unavailable — any proposal must honor this.
- **Single Next.js standalone instance on InMotion shared/VPS hosting.** No
  Kubernetes, no serverless edge compute fleet, no dedicated indexer
  cluster. Whatever this app runs, it runs on one real, modest server plus
  whatever free/rate-limited third-party APIs and public RPC nodes it can
  reach.
- **Never fabricate. Fail closed.** This is the single load-bearing rule of
  this entire codebase (`lib/market/multichain/venue-registry.ts`'s own
  header, and dozens of "confirmed live" / "could not verify, left unbuilt"
  precedents throughout `lib/market/multichain/`).
- **Trading/fulfillment code is unaudited and out of scope for expansion**
  (standing CRITICAL finding from today's audit) — this brief is about
  READ-SIDE indexing/data completeness only, not trading execution.
- **No custody, no new trust assumptions on users.** Any indexing solution
  that requires end users to run software, stake funds, or trust a new
  third party beyond what they already implicitly trust (their own wallet,
  public blockchains, already-used free APIs) needs to be flagged as a
  bigger ask, not a drop-in.

## What already exists in this codebase (ground every proposal against this — real, not hypothetical)

- **EVM**: ~45 discovery files. Direct HyperSync (Envio) dual-cursor
  scanners for Seaport 1.6/legacy, Wyvern, Blur, LooksRare, X2Y2, Sudoswap,
  Rarible, Foundation, CryptoKitties fills — each scans real, Sourcify-
  verified contract addresses with real, live-smoke-tested decoders,
  writing into per-protocol Postgres fill tables
  (`plank_seaport_fills`/`plank_blur_fills`/etc.) plus shared
  `plank_market_event_assets`/`plank_market_event_payments` legs. This is
  the most mature indexing lane in the app — read 2-3 of these files
  (`lib/market/multichain/discovery/hypersync-seaport-scan.ts` and
  `hypersync-blur-scan.ts`) to understand the real, working pattern before
  proposing anything that claims to replace or improve on it.
- **Solana**: DAS-API-based reads (`lib/market/multichain/discovery/
  solana-das-pool.ts`, multi-provider pool across Helius/QuickNode/Shyft),
  free on-chain-first readers for Metaplex/Editions
  (`solana-metaplex-reads.ts`, `solana-editions.ts`), a real Tensor
  settlement scanner (`tensor-settlement-scan.ts`, reads real program logs)
  and a real Tensor active-listing scanner (`tensor-listing-scan.ts`,
  reads real `getProgramAccounts` state — built today, 115,370 real
  accounts returned in one free-RPC pass, no key needed) and Metaplex
  compressed/Core asset provenance (`solana-compressed-provenance.ts`).
- **Bitcoin**: keyed adapters (UniSat, Ordiscan) plus a keyless Ordinals
  Wallet catalog reader, and a real on-chain settlement index built today
  (`bitcoin-settlement-scan.ts`, using mempool.space's free API to observe
  confirmed inscription-UTXO spends with an honestly-labeled confidence
  tier, since price-inference from raw settlement data is a real heuristic
  not a certainty).
- **Cross-cutting infra built today**: `singleflight-cache.ts` (request
  coalescing + stale-while-revalidate, Postgres-lease-based, not Redis-
  lock-based, specifically because of the small connection pool),
  `freshness-budget.ts` (per-provider adaptive TTL under real free-tier
  rate ceilings), and an as-yet-unbuilt design
  (`GROK-RESEARCH-BRIEF-viewport-predictive-hydration-2026-08-25.md`) for
  prioritizing hydration of whatever's actually visible on a user's
  screen.
- **The honest coverage model**: `venue-registry.ts`'s `coverage` field
  (`indexed`/`partial`/`planned`/`unavailable`) plus the public `/market/
  multichain/known-limitations` page and inline `DataSourceChip` component
  — this app deliberately shows uneven completeness rather than faking
  parity.
- **Real, confirmed-dead-end venues from today's research** (do not
  re-research these, they're settled): Tensor's off-chain book API
  (key-gated, no free tier — but its on-chain listing state IS free, see
  above), Best in Slot (fully retired), Ordzaar (not actually a
  marketplace, no server API), OKX Ordinals (key-gated, application
  pending), ORD.NET (requires a wallet holding 0.01 BTC), Gamma Ordinals
  (no verified API), X2Y2 (marketplace shut down April 2025).

## The core question this brief exists to answer

Given everything above — a real, working, but structurally uneven set of
per-chain indexing lanes, each hand-built against that chain's specific
data-availability shape — **is there a genuinely unified, cross-chain
indexing architecture (not just "the same quality bar applied N times," but
an actual shared mechanism) that would let this app converge toward the
same completeness/verifiability standard on every chain, using only free/
public infrastructure, without custody or new user trust assumptions?**

Concretely research and answer:

1. **Is there a real, existing "universal" blockchain indexing abstraction**
   (a real academic or production architecture that treats EVM logs,
   Solana program accounts/logs, and Bitcoin UTXO spends as instances of
   one general "append-only event stream with eventual settlement finality"
   model) that this app could adopt to stop hand-building N bespoke
   scanners and instead build one real, general indexing engine with
   per-chain adapters plugged into it? Or is chain-specific bespoke
   indexing (what this app already does) actually the correct, proven
   approach in real production systems, and a "universal" abstraction is a
   known anti-pattern that real indexer teams have tried and abandoned?
   Find real evidence either way rather than assuming a unification
   fantasy is achievable.
2. **Verifiable indexing without a trusted operator**: research Space and
   Time's "Proof of SQL," any zk-coprocessor projects (Axiom, Herodotus,
   Lagrange), and academic work on succinct proofs of correct off-chain
   computation over on-chain data. Is any of this realistically adoptable
   by a small, free-tier-first app today, or is it still research-grade
   infrastructure requiring resources this app doesn't have? Give an
   honest verdict, not an aspirational one.
3. **Historical backfill at scale on free infrastructure**: real prior art
   for efficiently backfilling YEARS of historical chain data (this app's
   own HyperSync-based EVM scanners already do this well — is there
   something even better for Solana/Bitcoin specifically, where this app's
   current historical coverage is thinner)?
4. **Real-time freshness without infrastructure spend**: beyond what
   `freshness-budget.ts` and `singleflight-cache.ts` already do, is there
   real prior art for keeping indexed data fresh in near-real-time on free
   public RPC/API tiers specifically (webhook/push-based options many free
   tiers don't offer — confirm this real limitation rather than assuming
   one exists — vs. polling optimization techniques)?
5. **A genuinely novel synthesis, if warranted**: if research turns up no
   existing "unified cross-chain indexing for a free-tier NFT aggregator"
   architecture (a real possibility — this may be a genuinely under-served
   niche between "run your own full node + indexer" and "pay The Graph/
   Goldsky/Dune"), design one. Reason from first principles, cite every
   piece of real prior art you're drawing from, and be explicit about what
   parts are genuinely new synthesis versus applying a known pattern to a
   new context.

## Deliverable format

Structure the response the same way today's other Grok findings were
structured (and will be preserved verbatim in this repo for the record):
a section per research question above with real citations, followed by a
concrete, buildable architecture proposal that:
- Names every real prior-art system/paper it draws from, with enough
  specificity that someone could go verify the citation.
- Distinguishes "adopt this proven pattern as-is," "adapt this pattern for
  our specific free-tier constraint," and "this is genuinely novel
  synthesis, no direct precedent found" for every recommendation.
- Gives a concrete build-order recommendation the same way prior briefs
  did, ranked by (real value unlocked) / (engineering effort), explicitly
  flagging anything that would need a resource this app doesn't currently
  have (money, custody, new user trust) as a separate-decision item rather
  than bundling it into "just build this."

## Reading list (this session's prior research, for context — read to avoid re-deriving already-settled findings)

- `docs/marketplank/GROK-RESEARCH-BRIEF-full-multichain-parity-2026-08-20.md`
  and its findings doc — earlier feature-parity research.
- `docs/marketplank/GROK-RESEARCH-BRIEF-biggest-issues-unified-vision-2026-08-25.md`
  and `GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md` — the
  critical audit + Bounded Blast-Radius Canary / Freshness Budget
  Controller research (both since built and merged).
- `docs/marketplank/GROK-RESEARCH-BRIEF-free-remedies` findings
  (`GROK-FINDINGS-free-remedies-2026-08-25.md`) — per-venue free
  substitutes (Tensor GPA scanning, Bitcoin settlement-first indexing,
  and the Nostr-listing idea that real live investigation disproved —
  don't re-propose it without new evidence).
- `docs/marketplank/GROK-RESEARCH-BRIEF-viewport-predictive-hydration-2026-08-25.md`
  — the still-open, not-yet-answered brief on prioritizing hydration of
  what's visible on screen (a real, separate, narrower question from this
  one — this brief is about indexing architecture/completeness itself,
  that one is about prioritization/scheduling of an already-built
  indexing system).
