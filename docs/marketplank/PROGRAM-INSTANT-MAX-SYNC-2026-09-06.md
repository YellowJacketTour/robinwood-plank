# PROGRAM: Instant Max Sync -- every chain, every collection, every trait, rarity, listing, wiring and activity

Owner directive (2026-09-06): "state of the art solutions to achieve the complete vision of instant max sync
ability for all chains all collections all traits and rarities and listings and marketplace wirings and activity,
no excuses."

This document is the program. It says what state of the art actually is for this problem, what of it is now
running, what is built but not yet on, and what each remaining piece needs. Every claim of "live" below was
measured on production or on a real run; anything not measured is labelled.

## 1. What state of the art is for this problem

The best-in-class NFT aggregators (Reservoir before its shutdown, Magic Eden's indexer, OpenSea's own) converge on
one shape, and this program adopts it:

1. **Push, not poll, for the hot path.** Marketplaces expose event streams (OpenSea Stream API over WebSocket;
   Magic Eden and Tensor WebSockets on Solana; Hiro/Ordiscan on Bitcoin poll only). Sales, listings and offers
   arrive in seconds; polling is only for backfill and reconciliation.
2. **Chain-native truth for the cold path.** Transfers, mints, burns and Seaport fills come from logs, not from a
   marketplace. Envio HyperSync `stream()` covers EVM bulk at 1.9x the paginated rate (measured on this repo);
   Helius DAS for Solana; ordinals via inscription indexers.
3. **Selective materialization.** Nobody stores the firehose. Sales become rows; listings become per-collection
   floor state; offers become top-of-book state; bulk transfers stay in the chain indexer. The wildcard OpenSea
   topic delivers ~3,600 events/s (measured 2026-09-06); bids and cancellations are 75% of it and carry no
   durable information beyond the current book.
4. **Incremental derived data.** Trait indexes and rarity update when metadata arrives, not on a schedule; a
   metadata-updated event enqueues exactly that collection.
5. **One read path with one cost.** Every browser read goes through a coalescing, budget-aware gateway so N
   viewers cost one vendor call per window (built, measured: 20,000 reads -> 25 vendor calls).
6. **Always-on workers with real connection headroom.** Streams and schedulers are processes, not five-minute
   crons, and they sit next to a database with dozens of connections and NVMe storage.

## 2. What is real on production right now (2026-09-06)

| Piece | State | Evidence |
|---|---|---|
| Unified read gateway, provider ledger, demand bus, SSE live feed | LIVE | `/api/market/rpc-usage`, `/api/market/multichain/live` on plank.love |
| Hub index through the edge, backstage door, Cloudflare-correct rate limiting | LIVE | hub renders for the owner; index 200 in ~3.5 s |
| Singleflight cache lease | FIXED | production PostgreSQL rejected the old `jsonb::bigint` cast; every cached read had been failing silently |
| Deploys | 2 min when no migration is pending (was 41 min: full `pg_dump` on every release) | run 34025542310 |
| Convergence mesh (memberships, metadata, traits, rarity, stats lanes) | BUNDLED + PACKAGED, cron NOT yet installed | first `provision-market-mesh` proof run exited 1 in 5 s; the next run echoes the server log |
| OpenSea Stream ingest (sales rows + floor state, all OpenSea chains) | BUILT, PROVEN LOCALLY, DEPLOYING | 145k events / 41 s, 6 sales written, 7 unit tests; run 34028150001 |

Hydration truth before this program started: 412 queued jobs, 0 completed in 15 minutes, because the mesh needed
`tsx`, which the release tree never ships. The mesh had never run in production.

## 3. The remaining pieces, in the order that pays

1. **Mesh cron live** (this session, in progress): read the proof-run failure from the server log, fix, re-run
   `provision-market-mesh`. Success = `succeededLast15m > 0` on `/api/market/rpc-usage` and per-chain fill
   rising on the hub.
2. **Stream cron live** (same job): installed alongside the mesh cron; success = `opensea-stream` rows in the
   ledger and sales visible on collection pages within seconds of OpenSea.
3. **Top-of-book state from the stream**: per-collection best offer upsert (collection_offer / item_received_bid
   for tracked collections only) into the offers table the collection page reads. Small change; uses the same
   batch loop.
4. **Solana push**: Magic Eden WebSocket (or Tensor) ingest with the same policy; Helius webhooks for transfers on
   tracked collections instead of the transfer scan lane.
5. **Bulk EVM via HyperSync `stream()`** in the membership and fill lanes (adapter exists as `hypersyncStream`,
   measured 1.94x; adopt in bulk lanes with the before/after harness).
6. **Incremental traits and rarity**: on metadata arrival, update the projected trait index and Merkle set for
   that collection only (today a full pass per collection).

## 4. The constraint that no code removes

Production is a shared cPanel host: `PGPOOL_MAX=4` per process, cron at one-minute granularity, no resident
worker processes, database on the same shared box. The stream worker already runs at 145k events per 41 s on a
laptop; the constraint is the database's write headroom and the absence of an always-on process. State of the art
here means one of:

- **Worker VPS** (any $20-40/month box): runs `mesh-tick-standalone.mjs --loop` and `opensea-stream-standalone.mjs`
  as systemd services against the existing database over the network, with `PGPOOL_MAX=16` and PgBouncer. Zero
  code change: the bundles are built for exactly this.
- **Managed PostgreSQL** (Neon, Supabase, RDS) for the ledger and token projection, keeping cPanel for the app.
  Needed once the token projection passes what shared storage can serve (locally it is 19M rows / 16 GB).

This is an owner spending decision, not an engineering blocker; everything above runs on the cPanel cron path
today at cron granularity.

## 5. Acceptance, measured not claimed

- `/api/market/rpc-usage?minutes=15`: `queue.totals.succeededLast15m > 0`, `etaMinutes` finite, ledger rows for
  `opensea-stream` with `errors = 0`.
- Hub top-2000 rows: floors present for > 90% of Ethereum, Base, BNB, Bitcoin rows; Arbitrum shells (1,567 rows
  with 15 floors) either filled or demoted by the honest "no market" state.
- A sale on OpenSea appears on the collection's activity within 10 seconds (SSE tail), with the real tx hash.
- Trait facets and rarity ranks present for every collection whose membership is complete.
