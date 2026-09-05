# One-shot for a fresh Fable: bring plank.love / Marketplank to the invented peak of all-chain NFT trading

Written 2026-09-05 for a session with zero context. Paste this whole file as the first message.
Repository: `YellowJacketTour/robinwood-plank` (private). Working branch `dev`, deploy branch `master`
(a push to `master` builds and deploys to InMotion). Read `AGENTS.md`, `DESIGN.md`, `docs/ARCHITECTURE_MAP.md`
and `docs/marketplank/SPEC-SYNC-MESH.md` before touching anything; they override this document where they disagree.

You are Claude Fable 5.1. The owner (bullish0x) has one directive and it is the whole spec:

> A maximally researched and novelly invented solution for **all chains, all collections, all traits, all rarities,
> all bid, sweep, list and transfer features and more**, with **intelligent asset hydration and focus**, and **all users'
> traffic consolidating into single points** so that every rate limiter, quota and vendor cliff is absorbed once,
> centrally, never per user. The product must reach the absolute peak of new, state-of-the-art, invented solutions.

Everything below is verified against the real repository at the time of writing. Code moves; verify before trusting.

---

## 0. How to work (non-negotiable, learned the hard way)

1. **Verify live, never assume.** Every real bug this project has found (Bitcoin dust rejection, UniSat sighash whitelist,
   WIN1252 Postgres encoding, Alchemy monthly quota, OpenSea account-level jail, Postgres `shared_buffers` default) was
   found only by a real call, and would have passed any unit test. Read the actual file before citing it.
2. **A surface is "verified" only when a real signer drove a real WRITE** (an order settled, a PSBT broadcast, a
   Seaport fill mined). Render plus read proves nothing. Say "unproven" otherwise.
3. **Never fabricate a number or an image.** Empty cell = dash. `0` only when an empty book was actually counted.
   Never fuzzy-match identities across sources; two rows until a venue proves they are one.
4. **Writers are scripts, never the Next.js App Router.** Hub and collection GETs read snapshots only. A vendor 403
   must never hang `localhost:3800` or production.
5. **Budgets are budgets, not cliffs.** Every external source runs through `source-budget.ts`,
   `freshness-budget.ts`, per-key pools and durable jails. Unbounded fan-out across paid sources is a payment leak.
6. **Do not use subagents unless told to.** Do the work in the main session, commit as you go, write reports
   incrementally, never park on a background wait.
7. Before shipping: `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, `npm run build`. PRs go to `dev`.
8. Never make the repo public. Never migrate users into vault V2. Resolve vaults only through
   `lib/market/vault-registry.ts` by address. Never render a vault version number.
9. Append-only Postgres migrations (`deploy/inmotion/postgres/migrations/`, currently through `098`).
10. Do not claim "impossible to exploit", "instant", or "100%" unless a real measurement backs it.

---

## 1. What the product is

**RobinWood ($PLANK)** is an NFT collection and app on **Robinhood Chain** (chainId 4663), a private L3 that public
indexers do not cover. **Marketplank** is its marketplace, and the thesis is *any chain, any collection*:

- Native Seaport 1.6 order book on Robinhood Chain and on every foreign EVM chain, because Seaport 1.6 lives at the
  identical canonical address `0x0000000000000068F116a894984e2DB1123eB395` on all of them (live-verified). Native
  foreign listings charge 1.8% (`MARKETPLANK_NATIVE_LISTING_FEE_BPS = 180`), third-party (OpenSea) fills carry a 1.8%
  fulfiller tip via Seaport `additionalRecipients`. Five 180-bps constants in `lib/constants.ts` are intentionally
  distinct; do not alias them.
- Multi-vault Instant Swap on Robinhood Chain (V3 `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`, live since 2026-08-01).
- A global multichain hub (`/market/multichain`, `components/market/GlobalMarketHub.tsx`) rendering rankings across
  every chain at once, and per-collection pages (`MultichainCollectionView.tsx`) with catalog, book, traits, rarity,
  activity, offers, sweep, list, transfer.
- Bitcoin Ordinals native listing engine (OpenOrdex-style PSBT, `SIGHASH_SINGLE|ANYONECANPAY`, dummy-UTXO sat
  preservation), proven end-to-end on testnet4 with a real UniSat wallet, mainnet gated behind
  `NATIVE_BITCOIN_MAINNET_ENABLED`.
- Solana (Magic Eden M2 reads, Tensor/Magic Eden trade adapters) whose write path is unproven because
  `MAGICEDEN_API_KEY` was never provided.
- A separate casino product (PlankCrash / PlankLottery, CCS-2L v2) is finished and out of scope here; do not touch
  `contracts/`, `public/arcade/`, `lib/casino/` or `lib/playtest-*` unless asked.

Production: InMotion Passenger (`deploy/inmotion/`), Postgres on shared hosting with `PGPOOL_MAX=4`.
Kill switch: `MARKET_ENABLED` / `NEXT_PUBLIC_MARKET_ENABLED` renders `ComingSoonGate` only.

### Chain surfaces (verify in `lib/market/multichain/trading/foreign-chain-registry.ts`, `non-evm-chains.ts`, `chain-plugin.ts`)

| Surface | Mechanism | Membership / metadata | Book | State |
|---|---|---|---|---|
| Robinhood Chain 4663 | Seaport native + vault swap | own scan (`robinhood-chain-scan.ts`), HyperSync anchored membership (2026-08-27) | native book | live |
| Ethereum, Polygon, Arbitrum, Base, Optimism, BNB, Avalanche, zkSync | Seaport native + OpenSea fills | HyperSync (Envio) primary, on-chain `tokenURI` via Multicall3, IPFS, OpenSea last resort | OpenSea + native | live (Avalanche has no curated metadata upstream) |
| Solana | Magic Eden M2 / Tensor | Helius DAS (4-key pool) | Magic Eden | read live, write unproven |
| Bitcoin Ordinals | native PSBT engine | UniSat, Ordiscan, Ordinals Wallet, OKX, Satflow, ord.net adapters | UniSat + native | testnet4 proven, mainnet gated |

---

## 2. What already exists (reuse, do not rebuild)

`lib/market/multichain/` is the whole machine. Key modules, all real:

- **Control plane and mesh.** `control-plane.ts` (Postgres job queue `plank_data_jobs`, provider windows),
  `mesh/matrix.ts` (cell × source lanes), `mesh/jail.ts`, `mesh/lane-health.ts`, `chain-vines.ts`
  (acquire → harness → express per chain), `scripts/mesh-tick.ts` / `mesh-lane.ts` (one source × one chain per
  process, bounded parallelism), `scripts/refresh-market-data.ts` (~20-step orchestrator).
- **Demand and focus.** `collection-demand.ts` (viewport-visible → detail-click → background sweep priority tiers with
  aging), `/api/market/multichain/visibility-demand`, `demand-score.ts`, `dormancy.ts`, `adaptive-recrawl.ts`
  (recrawl from observed change rate), `hash-first-hydrate.ts` (content-addressed pointer = proof of unchanged body),
  `archival-ledger.ts` (honest completeness scoring from real writes only), `discovery/hydration-completion.ts`
  (completion judged by real row count vs real supply, never a source's own flag).
- **Consolidation and budgets.** `singleflight-cache.ts` (request coalescing + stale-while-revalidate over durable KV),
  `freshness-budget.ts` (TTL widens as spend approaches the window ceiling, hard stop past it),
  `discovery/source-budget.ts` (per-source daily ceilings + circuit breaker), `discovery/provider-pace.ts`,
  `discovery/rpc-provider-pool.ts` (multi-vendor raw JSON-RPC pool), key pools with independent jails for OpenSea
  (7 keys, but jailed per account: `opensea-key-pool.ts`, `alchemy-account-jail.ts`, `hypersync-account-jail.ts`,
  `helius-key-pool.ts`), `capability-coverage.ts` + `venue-registry.ts` (coverage is a registry, never a claim).
- **Data.** `store.ts` (`plank_multichain_collections`, snapshots, `updateEvmVolumeFromSeaportFills`),
  `collection-token-store.ts` (`plank_collection_tokens`, ~19M rows locally), fill indexers for Seaport, Wyvern,
  Blur, LooksRare, X2Y2, Rarible, Foundation, Sudoswap, CryptoKitties, `discovery/transfer-ledger.ts`
  (`plank_market_events`), `ledger-activity.ts`, `foreign-rarity-store.ts`, `rarity-index-runner.ts` and the
  Helius/UniSat/Ordinals Wallet rarity runners, `lib/rarity.ts` (canonical RobinWood −log2 information-content rarity,
  competition rank, two percentiles, Background-encoded official tiers) and `lib/rarity-generic.ts` (same math over any
  trait set).
- **Trading.** `lib/market/seaport.ts`, `criteria.ts` (Merkle criteria bids using seaport-js's own tree),
  `bulk-list.ts`, `orders-store.ts`, `trading/foreign-fulfill.ts` (buy, sweep, multi-collection sweep, rewired off the
  undeployed fee router onto direct Seaport + tip), `foreign-offer.ts`, `foreign-orders.ts`, `foreign-transfer.ts`,
  `native-fulfill.ts`, `native-bitcoin-listing.ts`, `bitcoin-utxo-safety.ts`, `bitcoin-transfer.ts`,
  `solana-transfer.ts`, `solana-tx-batch.ts`, `across-quote.ts`, `debridge-quote.ts` (bridges quoted, contracts undeployed).
- **Surfaces.** 43 routes under `app/api/market/multichain/` (collection, tokens, traits, trait-index, rarity, listings,
  offers, submit-offer, fulfillment-data, floor-listings, owned, wallet-summary, hydrate-token, hydration-status,
  bitcoin-buy-psbt, solana-buy/sell/bid-instruction, sudoswap-pools, visibility-demand, ...) and ~75 components in
  `components/market/` (sweep confirms, offer forms, native list forms per chain, `TraitFacetFilters`,
  `TraitCriteriaPicker`, `RarityFloorStrip`, `CollectionDossier`, `CollectionIntelligence`, `LivingLiquidityViz`).

Provider keys in `.env`: `OPENSEA_API_KEYS` (pool), `ENVIO_API_TOKEN` (single), `ALCHEMY_API_KEY` (single, monthly quota
already exhausted once; Alchemy NFT API is forbidden as a dependency), `HELIUS_API_KEY` (4 pooled), `UNISAT_API_KEY`
(2,000 calls/day documented), `ORDISCAN_API_KEY`, `MAGICEDEN_API_KEY` (absent), `ZEROX_API_KEY`, RPC URLs.

Research already done and stored (read, cite, do not redo): every `docs/marketplank/GROK-FINDINGS-*` and
`GROK-RESEARCH-BRIEF-*` file (unified global indexing, unified maximal hydration, sustainable archival mining,
viewport predictive hydration, intelligence-agency maximal vision, free remedies, ordinals node offload, total-coverage
data warehouse, universal 24h volume, immersive hydration visualization), `GROK-ONESHOT-instant-live-multichain-2026-08-27.md`
(the open questions on OpenSea account-level limits, HyperSync streaming, self-hosted archive nodes, Robinhood Chain
coverage, O(n) chain wiring), `docs/ONESHOT-universal-rarity-for-every-collection.md`, `docs/ONESHOT-marketplank-multichain-2026-08-19.md`,
`docs/HANDOFF-multichain-data-and-bitcoin-audit-2026-08-20.md`, `docs/AUDIT-onchain-data-extraction-2026-08-24.md`,
`docs/marketplank/LESSONS-STATS-RARITY-TX.md`, `SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md`, `SPEC-MAINNET-INTELLIGENCE-AND-LAUNCH-2026-08-20.md`.

---

## 3. The gaps the owner is pointing at (real, current)

1. **Traffic is not yet a single point.** Some user-facing routes still fan out to vendors per request
   (`singleflight-cache.ts` documents the ones it wrapped; find the rest). Demand signals are per page, per user.
   There is no single, chain-agnostic edge that every browser hits for every read, so N users can still cost N vendor
   calls for the same cell in the same second.
2. **Sources are pooled by key, not unified by capability.** Fallback order is fixed per cell (`mesh/matrix.ts`);
   there is no real-time cost/speed/limit-aware source selector, no cross-source deduplication of the same fact, and
   no learned per-source reliability.
3. **Hydration is honest but not predictive enough.** Viewport demand exists; anticipation (what the user will open
   next, what the market will move next, what a sweep will need) does not. Focus should follow intent and money.
4. **Rarity and traits are complete for RobinWood, partial elsewhere.** Foreign collections get ranks only after a
   background pass; Bitcoin rarity is `partial: true` structurally; official on-metadata tiers are only detected for
   RobinWood; ERC-1155 and open editions are handled unevenly (see 2026-09-05 fix `61b1ddb`, real ERC-1155 standard).
5. **Trading features are uneven by chain.** EVM has list, bulk list, offer, criteria bid, sweep, multi-collection
   sweep, transfer. Solana has list/buy/sell/bid instruction builders but no proven write. Bitcoin has list, buy,
   cancel, transfer, mainnet gated. Bundle orders and swap orders are native-only. No cross-chain sweep, no
   portfolio-level bid ladder, no trait-floor sweep across chains.
6. **Robinhood Chain has no public indexer coverage.** HyperSync anchored membership was wired 2026-08-27 through a
   token-index probe, but the chain still depends on the app's own scans for the full picture.
7. **Adding a chain is O(files).** `chain-plugin.ts` is a derived view, not the source of truth; a new chain touches
   registries, `EVM_CHAIN_ID` maps, `hydrationJobSources`, adapters, matrix, vines.
8. **Bitcoin and Solana mainnet proofs are owner-gated** (BTC mainnet flag, Magic Eden key). You cannot flip these;
   you can make everything behind them ready and measured.

---

## 4. Your mission: invent and build the peak, in this order

Deliver as code, tests, measurements and one living spec (`docs/marketplank/SPEC-UNIFIED-EDGE-AND-INTELLIGENCE-<date>.md`).
Research live (web) for anything time-sensitive: vendor limits and pricing (OpenSea, Envio HyperSync tiers and
`stream()`, Helius, UniSat, Ordiscan, Magic Eden, Tensor, Reservoir, Goldsky, QuickNode Streams, The Graph, Moralis,
SimpleHash successors, Blockscout, self-hosted archive nodes), Seaport 1.6 and any newer versions, Metaplex Core and
compressed NFT trading, Ordinals/Runes protocol changes, EIP-7825 and EIP-712 tooling, and what OpenSea, Blur, Tensor,
Magic Eden and Best in Slot actually do architecturally. Cite everything with dates.

### A. The Single Point: a unified edge every read goes through
- One chain-agnostic read gateway (server module + route family, not a second app) that every hub, collection,
  token, trait, rarity, activity, book and wallet read passes through. Per-key single-flight, stale-while-revalidate,
  and freshness budgets become universal, not opt-in. Measure: vendor calls per unique cell per minute across N
  simulated users must be O(1), not O(N).
- One demand bus: every viewport, hover, click, search, wallet connect and sweep intent publishes intent to the same
  queue the mesh drains, with priority = f(users watching, money at stake, staleness, cost to refresh).
- One provider ledger: every external call recorded once with source, key, cost unit, latency, outcome and jail
  state, exposed live on `/api/market/rpc-usage` and in the HUD. No fabricated "100%".
- Push instead of poll where the vendor allows it (HyperSync `stream()`/`streamHeight()`, websocket `eth_subscribe`,
  Helius webhooks/DAS, mempool.space websockets for Ordinals, Magic Eden/Tensor feeds) so live data fans out from one
  subscription to all users, not from all users to the vendor.

### B. Source intelligence: capability-aware selection, not fixed fallback
- Replace fixed fallback order with a per-cell selector scoring every eligible source on live cost, remaining budget,
  latency, historical accuracy and jail state. Learned, explainable, logged. Cross-source corroboration for the same
  fact (name, image, supply, floor); a disagreement is surfaced, never averaged.
- Make chains true plugins: one manifest per chain (ids, kinds, sources, capabilities, fee currencies, Seaport or
  native venue, art rules) from which registries, matrix rows, vines and job sources are derived. Adding a chain must be
  one file plus a test.
- Close the Robinhood Chain gap with the cheapest real option (self-hosted Envio indexer or the app's own streaming
  scan against the chain RPC) and measure time-to-complete for a fresh collection.

### C. Hydration and focus: anticipatory, content-addressed, honest
- Extend hash-first hydration to every content-addressed pointer; treat `https://` and `data:` pointers with adaptive
  recrawl only. Parallelize per-token fills within budget (the 2026-08-27 "real cheat code" pattern).
- Predictive focus: pre-warm what the user is about to need (next page of a grid, the trait facet just opened, the
  tokens a sweep would take, the collections in a wallet just connected) and what the market is about to need
  (collections whose fills, floor moves or mint activity are accelerating). Keep the archive-depth bar real: it must
  visibly race to 100% only because rows actually landed.
- Completion is always real rows vs real supply per `chain × identity namespace × source × cell`.

### D. Rarity and traits for everything
- One pipeline that adapts by collection type: ERC-721, ERC-1155 (real standard, editions, open editions), 1/1s,
  10k generative, 500k+ (ENS, Art Blocks), Ordinals (collection vs inscription attributes, parent/child provenance),
  Solana standard, editions and compressed. Keep `lib/rarity.ts` canonical for RobinWood; generalize `rarity-generic.ts`
  with detection of official on-metadata tiers (the RobinWood Background rule) and per-trait frequency, floors by
  tier, "rarer than X%", and `partial` honesty until the sample equals supply.
- Criteria bids without a complete id set: collection wildcard versus Merkle snapshot, chosen per completeness.

### E. Trading features at parity on every chain, then beyond
- List, bulk list, edit, cancel, offer, collection offer, trait/criteria bid, buy, sweep (floor, by rarity tier, by
  trait, multi-collection, cross-chain where quotes exist), bundle, swap, transfer, batch transfer, on every surface
  where a venue exists. Solana write path built and instrumented so one real Phantom signature proves it the day the
  key arrives. Bitcoin mainnet path measured on testnet4 with the same code path as mainnet.
- Every fee captured on-chain via Seaport tips or the native engine, never off-platform. Every order validated by the
  existing `order-validation.ts` model; every relay route signed.
- New: portfolio-level bid ladders, trait-floor sweeps with rarity awareness, liquidity-aware sweep pricing from the
  fill ledgers, and a "biggest buyer board" HUD (see the 2026-08-26 findings) driven only by real events.

### F. Proof and measurement
- Before/after numbers for: vendor calls per unique cell per minute under N users, time-to-100% for a fresh 20k
  collection per chain, jail incidents per day, backlog depth and honest ETA, cell coverage per chain.
- Playwright end-to-end proofs on a real local Postgres for every user flow you touch; real signed writes on testnet
  for every trading path you touch. Record what could not be proven and exactly why (owner-gated key or flag).

---

## 5. Local environment

- Node 24, Next.js (read `node_modules/next/dist/docs/` first; this version differs from training data).
- Local Postgres: portable cluster documented in `docs/ONESHOT-marketplank-multichain-2026-08-19.md` §7
  (UTF8, locale C, `shared_buffers=4GB`, `random_page_cost=1.1`); apply migrations with `npm run db:migrate`.
  A docker Postgres also exists (`plank-love-postgres-1`, port 54329, db `plank_fixtest`); always pin `-p` on compose.
- Dev server on **port 3800** (`npx next dev -p 3800`); port 3000 is hijacked by `wslrelay.exe` on this machine.
- Source env: `set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a`.
- Data: `npx tsx scripts/refresh-market-data.ts --full` or targeted steps; `npm run market:mesh`;
  `scripts/mesh-tick.ts --minutes=12`; `scripts/mesh-lane.ts --source=<s> --chain=<c>`.
- Tests: `npm run test:market` (node test runner, ~1,180 tests), `npm run test:contracts` (hardhat, out of scope),
  `npx playwright test -c playwright.playtest.config.ts` (casino only).
- CI: GitHub Actions on the org is billing-blocked at times; local verification is the real gate.

---

## 6. Deliverables the owner expects at the end of your run

1. The unified edge, demand bus and provider ledger in code, with measurements proving O(1) vendor cost per cell.
2. The chain-plugin manifest with at least one chain migrated to it and a test that fails on manual wiring.
3. Rarity and traits for every collection type with `partial` honesty and official-tier detection.
4. Trading parity matrix (chain × feature × state: proven / built-unproven / gated) as a real registry, rendered in
   the UI as coverage, never as a claim.
5. The living spec, an audit of what you changed, and a one-line memory of every non-obvious decision.
6. A plain-language summary for the owner: what is proven, what is built but gated, what only they can unblock
   (Magic Eden key, Bitcoin mainnet flag, paid vendor tiers, dedicated RPC), with real costs and steps.

Work in the main session, commit small, verify live, and stop only when the whole list is done or blocked on the owner.
