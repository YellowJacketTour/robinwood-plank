# Unified edge and intelligence — living spec (2026-09-05)

Branch `feat/unified-edge` off `dev`. Companion to `docs/marketplank/SPEC-SYNC-MESH.md` (the mesh constitution) and
`docs/marketplank/FABLE-ONESHOT-marketplank-all-chains-peak-2026-09-05.md` (the mission). Code is the source of truth;
where this file and the code disagree, fix both.

Directive under test: *all users' traffic consolidates into single points so every rate limiter, quota and vendor cliff
is absorbed once, centrally, never per user; hydration and focus follow intent and money; every chain, collection,
trait, rarity and trading feature reaches parity honestly.*

---

## 1. The Single Point (built)

| Piece | Module | What it guarantees |
|---|---|---|
| Read gateway | `lib/market/multichain/edge/read-gateway.ts` | `edgeRead(cell, fetcher)` is the one way an App Router read reaches a vendor. One key grammar (`edge:<kind>:<chain>:<subject>[:variant]`, EVM addresses lower-cased, variants sorted), one policy table (`EDGE_POLICY`, soft/hard TTL per kind), universal singleflight + Postgres lease + stale-while-revalidate + Freshness Budget Controller (reuses `singleflight-cache.ts`, does not re-implement it). Counts reads vs real fetches per kind and per cell. |
| Provider ledger | `edge/provider-ledger.ts`, migration `099` (`plank_provider_ledger`) | Every external call recorded once: source, positional key id, chain, cost units, latency, outcome (`ok/error/rate_limited/timeout/budget_refused`). In-memory per-minute buffer, one UPSERT per dirty bucket every 5 s, never a held connection across a fetch. `meteredFetch()` wraps `fetch`. `readProviderLedger()` joins durable mesh jail state. |
| Demand bus | `edge/demand-bus.ts`, `POST /api/market/multichain/demand`, `hooks/useDemandIntent.ts`, migration `099` (`plank_demand_intents`) | Every intent (viewport, hover, click, search, wallet-connect, sweep, facet, read) lands on one bus and the one mesh queue. `priority = base(kind) + watchers(log2, ≤+8) + money(log10, ≤+10) + staleness(≤+6) − cost(≤−6)`, clamped to `[10,130]`; unknown keys pinned to `UNKNOWN_KEY`. Watchers are distinct salted client hashes in a 2-minute window. Decisions are returned per subject (explainable). |
| Push, not poll | `edge/live-feed.ts`, `GET /api/market/multichain/live` (SSE) | One Postgres tail of `plank_market_events` per process fans out to N browsers. Tip is the id sequence (`MAX(id)` measured at 12.5 s on the real 58M-row table). |
| Usage surface | `GET /api/market/rpc-usage` | `rpc` (per-process CU meter), `edge` (reads vs fetches per kind/cell), `ledger` (durable, last N minutes, per source/key/chain with jail and budget windows). Scope is labeled; nothing fabricated. |

Routes moved onto the gateway this pass (they fanned out per browser before): `activity` (Robinhood eth_getLogs, Magic
Eden activities, OpenSea events), `account-activity`, `owned` (Magic Eden, Alchemy), `owned-all`, `wallet-summary`
(Alchemy per chain, OpenSea contract→slug), `listings` OpenSea helper (metered), `hydrate-stats` CoinGecko,
`trading/foreign-orders.ts` OpenSea GET/POST (metered). Routes that already used `getOrRefresh` keep their keys; new
code must use `edgeRead`.

### Measurement (real, `scripts/edge-load-proof.ts`, local Postgres, 2026-09-05)

| users | unique cells | rounds | browser reads | naive vendor calls | real vendor calls | per cell | reduction |
|---|---|---|---|---|---|---|---|
| 200 | 25 | 4 | 20,000 | 20,000 | 25 | 1.000 | 99.88% |

Vendor cost per unique cell is O(1) in users. `test/market/edge-read-gateway.test.ts` asserts 50 concurrent readers of
a cold cell cost exactly one fetch and a second wave inside the soft TTL costs zero.

---

## 2. Source intelligence (built)

- **Selector** `edge/source-selector.ts`: for a `(chain, cell)` the matrix says which lanes *may* write; the selector
  ranks them from evidence: jail (gate), budget exhausted (gate), budget pressure (−40·p), learned reliability
  (+30·ok/calls over the ledger window), latency (−ms/100, ≤−20), cost (per-source documented unit), evidence (+5).
  Every candidate carries its terms and a `reason`. Matrix order survives only as a tie-break.
- **Corroboration** `corroborate()`: exact agreement after an explicit `normalize`; a disagreement is returned as
  `disagreed` with every source's value, never averaged or fuzzy-matched.
- **Chain manifest** `lib/market/multichain/chains/manifest.ts`: one manifest per chain (ids, kind, display, brand,
  glyph, currencies, OpenSea/Alchemy/CoinGecko ids, HyperSync, Seaport, sources, art rules). Derived: `FOREIGN_CHAINS`,
  `EVM_CHAIN_ID`, `ALCHEMY_NETWORK_SUBDOMAIN`, mesh matrix chain lists, display/brand/glyph/offer-currency maps,
  `chain-plugin.ts`. `test/market/chain-manifest.test.ts` fails on manual wiring in any of them. Still hand-wired on
  purpose: `hydrationJobSources` completion gating (incident-hardened), `chain-vines.ts` prose, per-chain RPC fallback
  lists, mesh-lane runners.
- **Robinhood Chain gap**: HyperSync coverage for 4663 is live (manifest `hypersync: true`, proof 2026-08-27). The
  cheapest real closure remains the app's own streaming scan; time-to-complete for a fresh collection was **not**
  measured this pass (see §6).

---

## 3. Hydration and focus (built)

- `edge/predictive-focus.ts`: intents that name tokens (sweep preview, facet, click) hydrate only the still-pending
  subset (real `metadata_state`), bounded to 24 tokens at concurrency 4, same `hydrateSpecificToken` path the click
  uses. `scripts/market-focus.ts` nudges accelerating collections (demand-score momentum from stored windows only) to
  `PREDICT_NEXT`, strictly below any human tier.
- Client intents wired: sweep preview (USD at stake via `toUsd`, token ids), trait facet open, hub search hits
  (top 8 per chain), wallet connect (server resolves holdings through the edge's `owned` cells; Solana/Bitcoin
  holdings are an honest gap).
- Hash-first hydration and the archive-depth bar were not changed; completion remains real rows vs real supply.

---

## 4. Rarity and traits (built)

`lib/rarity-universal.ts` over the unchanged `-log2` kernel (`lib/rarity-generic.ts`; `lib/rarity.ts` stays canonical
for RobinWood):

- `detectCollectionType` from real signals: `one-of-ones`, `editions`, `open-edition`, `generative`, `large-registry`,
  `ordinals` (by standard), `unknown`. Editions tie copies at one rank; 1/1s and open editions get no fabricated spread.
- `traitFrequencyTable`, `rarerThanPercent`, `floorsByTier` (dash for tiers with no listing, never 0),
  `rarityCoverage` (partial until sample == real supply; unknown supply is partial).
- `/api/market/multichain/rarity` now returns `coverage` and `collectionType` and can no longer report complete
  without a real supply. Official on-metadata tiers (the RobinWood Background rule) generalize through
  `detectOfficialTierTrait`.

---

## 5. Trading parity (registry, built)

`lib/market/multichain/trading/parity-matrix.ts` is chain × feature × `{proven, built-unproven, gated, unavailable}`
with a named evidence line per cell; `/api/market/multichain/parity` serves it and `TradingParityMatrix.tsx` renders
it in the collection intelligence view as coverage. `test/market/trading-parity-and-pricing.test.ts` forbids `proven`
on Solana (no key) and foreign EVM (fork proofs only).

New pure planners: `trading/bid-ladder.ts` (portfolio ladder: rungs, quantities, leftover swept to the top rung, no
floor → no ladder) and `trading/sweep-pricing.ts` (exact cost off the real book, impact vs floor, per-item sanity cap
from the real fill median; tier/trait scope are filters before pricing).

---

## 6. Honest status

Gates run 2026-09-05: `npx tsc --noEmit` clean; `npm run lint:inmotion` clean; `npm run test:market` 1237 tests,
1196 pass, 38 skipped (Postgres-backed, run individually with the env file: all green), 1 pre-existing failure
(`arcade-abi.test.ts` needs compiled hardhat artifacts, untouched by this branch). `npm run build` NOT run: the
machine had 2.3 GB free on C: (Docker's WSL vhdx at 78 GB is the consumer; a stray `.next` dev build in this worktree
is 2.3 GB) -- run it after reclaiming space. Never run the market suite with `--env-file` against the real
`.env.local`: several tests are live integration tests that write `plank_market_events` (~4 GB in minutes).

Proven this pass (real writes or real measurements): O(1) vendor cost per cell (load proof + test); ledger rows
survive flush and carry outcomes; live feed fan-out with real inserted rows; manifest consistency; migration 099
applied locally.

Built, unproven: every wired intent path end-to-end in a browser (no Playwright run this pass); source selector
against live ledger evidence (pure scoring is tested); market-focus over the live catalog (dry-run script exists).

### Measurements added later on 2026-09-05

- **HyperSync transport** (`scripts/hypersync-stream-bench.ts`, Base, blocks 50936591..50939591, 904,669 Transfer
  logs, identical count both ways): paged `get()` 9,453 ms in 16 requests; `stream()` 4,880 ms in 19 batches.
  **1.94× faster** for bulk. But a live run of `runAddressScopedMembershipScan` on a sparse, address-scoped range
  (285 logs over 400k blocks, same tokens found both ways) measured `get()` 1,432 ms vs `stream()` 2,819 ms: the
  stream's setup cost dominates sparse scans. Decision: `stream()` is wired into the address-scoped scan behind
  `HYPERSYNC_STREAM=1` (default stays `get()`); the bulk discovery/backfill cursors are the right place to adopt it
  next, with the same before/after measurement.
- **Time-to-100%** (`scripts/hydration-time-to-complete.ts --chain=base-mainnet --run-mesh`, collection
  `0x0c801a24dc6cf18a2fd7c81467b1414381fdf284`, supply 788): 0 → 1 rows in 485 s, **not reached**. Cause was the
  local database, not the mesh: four lanes died on `canceling statement due to statement timeout` (15 s) against the
  315 GB local `plank_market_events` set. The script is ready; the number must come from production or a healthy DB.
- **Queue telemetry** (`edge/queue-telemetry.ts`, in `/api/market/rpc-usage.queue`): backlog per chain/source,
  throughput-derived ETA (null when nothing completes), jailed keys, rate-limit incidents per day. Rendered in the
  admin System section (`ProviderLedgerPanel.tsx`) together with the ledger and edge counters.
- **Browser proof**: not obtained. The only dev server in this worktree belongs to another session and its render
  worker was crashing (jest-worker exceptions); a second isolated worktree could not run Turbopack over a junctioned
  `node_modules`, and there is no disk for a second install. Parity/rpc-usage/demand routes answered 200 over HTTP.

Not done: Playwright flows; switching lanes to HyperSync `stream()`; production time-to-100% numbers.

Owner-gated: `MAGICEDEN_API_KEY` (Solana writes), `NATIVE_BITCOIN_MAINNET_ENABLED` (Bitcoin mainnet), bridge
receiver/executor deployments (cross-chain sweep), paid HyperSync/OpenSea tiers, dedicated RPC.
