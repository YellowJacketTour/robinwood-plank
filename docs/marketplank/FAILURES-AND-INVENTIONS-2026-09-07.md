# Marketplank: the unified failures that still stand, and the inventions that remove them

Date: 2026-09-07. Written against production measurements taken the same day
(rpc-usage queue telemetry, hub index, native order book, lane health) and
the standing audit (AUDIT-MARKETPLANK-TOTAL-2026-09-06) and program
(PROGRAM-INSTANT-MAX-SYNC-2026-09-06) documents.

The rule for this document: every failure named here is either measured
live today or was identified before and is still present. For each one that
was identified before, the fix proposed is NOT "get the vendor key", "buy the
bigger host", or "wait for the queue". Those are someone else's gate. The
fix has to be something this stack can do by itself.

## The measurements that define the problem

| Signal (2026-09-07 07:20 UTC) | Value |
|---|---|
| Jobs queued / running / failed | 1,642 / 3 / 80 |
| Throughput | 4.9 jobs per minute |
| Oldest queued express-priority (120) job | 10 days |
| evm-metadata jobs at priority 120 | 1,007 |
| Lane sources with ANY health row ever | 2 of ~45 (opensea-stats, native-robinwood) |
| Collections with recorded 7-day activity | 0 (every row grades 0/300 on that axis) |
| Solana collections tracked | 184, none with a name |
| Robinhood "collections" tracked | 79,232 |
| Worker slots on the host | 3 (LVE process cap; pool max 4) |

One sentence: the mesh is a correct scheduler starved of compute, fed by
key-gated sources, writing into cells that several writers can overwrite,
with no telemetry that says which lane last did real work.

## Failure 1. Compute is the binding constraint, and it lives on the wrong box

**Standing since:** PROGRAM section 4 ("the constraint that no code removes").
**Still true:** 3 slots, 4.9 jobs/min. At that rate one pass over 184k
collections takes 26 days; the standing lanes get one slot for ~45 lanes,
so each discovery lane runs for two minutes every two hours.

**Gate-kept fix (rejected):** a bigger host, a managed queue, a paid worker
platform.

**Invention: compute anywhere, verified at the ledger.** The mesh already
compiles to a single self-contained bundle (`mesh-tick-standalone.mjs`)
that needs only a database URL and the source keys. Nothing about it
requires the origin server. Three tiers, all owned:

1. **Owner devices as workers.** Any machine the owner controls (this
   development PC, a spare laptop, a Raspberry Pi) runs the same bundle on
   a loop with a `MESH_WORKER_ID`. A worker claims through the same
   `claimDataJob` lease, so ten devices are ten workers with no
   coordination beyond the table that already exists. The only change:
   the database accepts connections from outside the host (cPanel remote
   Postgres allow-list, or an SSH tunnel the worker opens itself), and the
   lease owner records `worker_id` so diagnostics show who did the work.
2. **Visitor browsers as hydration workers ("crowd-hydrate").** The heavy
   lane is metadata: fetch a tokenURI, parse traits, resolve an image.
   Every visitor's browser can do that from ITS OWN IP against public
   IPFS gateways and HTTP tokenURIs, which is exactly the traffic rate
   limits are designed to throttle when it comes from one server. The
   page requests a small work packet (`GET /api/market/multichain/
   crowd-work`: 25 token ids + URIs for the collection the visitor is
   already looking at), fetches them client-side, and posts back
   `{tokenId, sha256(body), traits, imageUrl}`. The server accepts a
   result **[SUPERSEDED 2026-09-08 -- the rule below was UNSOUND; see
   GROK-RESPONSE-AND-VERIFICATION-2026-09-08.md]** only when (a) two
   independent visitors report the same body hash, or (b) the server
   spot-fetches 1 in 20 and it matches.

   Why that was wrong: IPs are a market. "Two independent browsers" is a
   rental, not independence, so a two-browser attacker confirms garbage and
   we badge it as rarity. The corrected construction:

   - Admission requires a server-issued **viewport nonce** bound to a target
     the client is actually displaying. No nonce, no write.
   - Branch on whether the object can authenticate ITSELF:
     content-addressed bodies (`ipfs://`, `ar://`, on-chain, ord envelope)
     are accepted iff `H(body)` matches the on-chain commitment, and signed
     market objects (Seaport order, PSBT) iff the signature and inputs
     verify. Both are sybil-proof; the visitor is a modem.
   - Mutable HTTPS is an **observation, never a fact**: `unconfirmed` until
     a server fetch matches, or K reports with pairwise-distinct ASN
     spanning Δt agree, with any contradiction forcing `disputed` plus an
     immediate server fetch. Audit probability scales with attention, not a
     flat 1-in-20.

   This deliberately does NOT produce truth for unwatched HTTPS tokens. It
   produces truth for watched ones and for everything that can
   authenticate, which is the whole demand that is achievable. The visitor
   who opened Pudgy Penguins is the one who most wants its traits, and they
   bring their own bandwidth and their own IP.
3. **The origin keeps only the express slot.** Once outside workers
   exist, the origin's three slots serve clicks (priority 118+) and the
   standing timer; everything else drains elsewhere.

Acceptance: throughput measured from `succeededLast15m` exceeds 60 jobs
per minute with one owner device attached; a cold collection of 10,000
tokens reaches final metadata in under 15 minutes with 20 concurrent
visitors and no server-side tokenURI fetches.

## Failure 2. Every source of truth is somebody else's key

**Standing since:** AUDIT lens 2 (key-gated matrix), lens 4.
**Still true:** OpenSea key pool (six keys, 95% background skip),
`MAGICEDEN_API_KEY` never provided, `UNISAT_API_KEY` mainnet absent,
`ENVIO_API_TOKEN` for HyperSync, Helius DAS pool, alchemy-account jailed
for 23 more days. When a key is missing the lane exits 0 and the row
looks "synced".

**Gate-kept fix (rejected):** apply for the keys.

**Invention: chain-native truth first, vendors as accelerators.**

- **EVM listings and floors without OpenSea's REST API.** The OpenSea
  Stream (already connected, free key) delivers every new listing and
  every sale chain-wide. Keep a full order book from the stream alone:
  each `item_listed` becomes an order row; each `item_sold`,
  `item_cancelled`, `Transfer` of the token (HyperSync) or expiry closes
  it. Floors come from OUR book, not from `/collections/{slug}/stats`.
  The REST stats lane becomes a nightly reconciliation, not the source.
  This is M3 from the research doc with the venue-polling half deleted.
- **Solana listings from program accounts, no key.** Tensor (TSwap,
  TComp) and Magic Eden (M2 escrow) hold listings ON CHAIN. A single
  `getProgramAccounts` with a memcmp on the collection or a
  `programSubscribe` websocket against any public RPC yields every live
  listing and price. No Magic Eden key is needed to KNOW the floor; the
  key is only needed to BUY through their router, and buying can go
  direct to the program with our own instruction builder (the
  `solana-buy-instruction` route already exists for that shape).
- **Solana catalog from the keyless Magic Eden catalog walk.** The lane
  exists (`magiceden-catalog:solana-mainnet`) and is exhaustive and
  keyless. It has not run to completion; see Failure 5.
- **Bitcoin from our own inscription index.** Sales settle on chain; a
  `bitcoind` plus `ord` on an owner device (tier 1 above) indexes every
  inscription transfer and sale. Listings stay venue-held (PSBTs), but
  every settlement, holder, and transfer is ours. This is M5 without
  renting a box.

Acceptance: with every third-party key removed for one hour, floors on
the top 500 EVM collections stay within one order of OpenSea for 95%,
Solana floors match Tensor for 95%, and no row shows "synced" without a
lane having actually written it.

## Failure 3. The grade measures the pipeline, not the collection

**Measured today:** "Recent chain activity" is 0/300 for every row,
including BAYC with 16 sales in 24h, because the activity axis reads
`plank_multichain_activity_stats`, which only the HyperSync forward scan
writes, and that lane runs two minutes every two hours on one slot.
RobinWood's row was hard-wired to 0 (fixed this release). Holders and
listed are null for most Ethereum rows for the same reason: the lanes
that fill them have not reached them.

**Invention: derive, never re-scan.** Every axis the grade uses is
already implied by data the stack holds:

- activity = distinct transfers in 7d = sales rows in
  `plank_market_events` + stream `item_transferred` + Seaport fills. Write
  a view `collection_activity_7d` over those tables; drop the separate
  scan for the grade.
- listed = COUNT of open order rows in our stream-fed book (Failure 2).
- holders = owner index from Transfer logs we already index for fills.

The grade must also SAY when an axis is unmeasured rather than scoring
it 0: an axis with no lane completion in 7 days is "not measured" and
is excluded from that row's denominator, so the curve compares rows on
the axes that exist for both. A zero the pipeline caused is not a D.

## Failure 4. "Collection" means something different on every chain

**Measured today:** Robinhood 79,232, Base 31,224, Solana 184. Robinhood
Chain does not have 79k NFT collections; HyperSync/robinhood-discovery
registers every contract that emitted one Transfer (AUDIT lens 1 #1,
still open). Solana lost its long tail to the 2026-08-20 cleanup (<50
minted deleted) and the keyless catalog walk has not refilled it.

**Invention: one admission law, one candidates table.** A row enters
`plank_multichain_collections` only when ONE of: (a) at least one sale or
listing observed on any venue, (b) at least 25 distinct holders, (c) it
appears in a marketplace catalog (Magic Eden, OpenSea stream, UniSat).
Everything else lives in `plank_collection_candidates` with the evidence
that got it there, and promotes automatically the moment (a)/(b)/(c)
happens. The chain tabs count admitted rows only. This turns the
Robinhood number into a real one and lets Solana refill from the catalog
walk with names attached on entry (the catalog gives name and image).

## Failure 5. Nothing proves a lane did work

**Standing since:** AUDIT lens 5 G ("marked succeeded without doing the
work"). **Still true and now measured:** lane health has rows for 2 of
~45 sources because `recordLaneClaim` swallows its own failure; a lane
that returns after a 429 exits 0 and the job is "succeeded"; the
standing lanes' `not_before` ratchets to the earliest enqueue so "oldest
queued" is meaningless for them; the Magic Eden catalog cursor cannot be
seen anywhere.

**Invention: work receipts.** Every lane returns a receipt
`{rowsWritten, cellsTouched, cursorBefore, cursorAfter, sourceCalls,
sourceStatus}` and `finishDataJob` stores it on the job row. A job with
`rowsWritten = 0 AND cursorAfter = cursorBefore` is `succeeded-noop`, a
distinct status that the scheduler counts separately and that the
diagnostics endpoint (shipped this release) renders. Noop streaks per
lane raise a visible "lane idle since T, reason" on the chain tab. The
lane-health writer stops catching its own error. This is the difference
between "the mesh ran" and "the mesh did something".

## Failure 6. Several writers own the same cell

**Standing since:** AUDIT lens 3 (volume flipped between vendor and
native-only; fixed for volume with `volume_source`). **Still true for
floors and listed:** opensea-stream, opensea-stats, coingecko, chain
adapters and the canonical fallback all write `floor_price_wei`; the last
one to run wins. The owner watched RobinWood's floor alternate between
0.012 and 0.03 today; the native-book fix removes that instance, not the
class.

**Invention: cell provenance with a truth rank.** One function,
`writeCell(collection, cell, value, source, observedAt)`, is the only
path into any stats cell. Each source has a rank per cell (own order
book > chain-derived > venue stream > venue REST > aggregator). A write
lands only if its rank is at least the current source's rank, or the
current value is older than that source's TTL. The cell stores
`(value, source, observed_at)` together, so the hub can show provenance
on hover and the freshness dot is per cell, not per row. Applied to
floor, listed, holders, sales, volume.

## Failure 7. The hub serves different truths to different tabs

**Measured today:** the index is cached per query cell (chain filter,
offset) for 30 s fresh / 5 min stale, so two tabs opened a minute apart
show different floors for the same row.

**Invention: one materialized hub snapshot.** The mesh writes a single
`hub_snapshot` (top 5,000 rows, all chains, all columns) every 30 s from
the ledger; every hub request serves that one object, sliced. One truth
per 30 s for everyone, and the web process stops recomputing rankings
per request.

## Failure 8. Releases fight the database

**Measured today:** migration 101 (add a defaulted column to the largest
table) ran 52 minutes and failed once on a 30 s statement timeout; each
release with a pending migration spends 40 minutes on a backup; runs
cancel each other in the concurrency group.

**Invention: online-only migrations.** New columns are added NULL with
no default; the mesh backfills in batches as a standing lane; NOT NULL
is added later when the backfill reports complete. Migrations never lock
a hot table and never need the pre-migration backup path, which stays
for destructive changes only.

## What ships now versus what is designed

Shipped this release (PR 366): stale demand decays; RobinWood's own
activity feeds its grade; sticky venue reads and the merged-book
observation key stop the floor flip; the freshness dot on the home row;
the coverage bar's finished rule; the diagnostics endpoint.

Next in order of payoff, all owner-independent:
1. Failure 3 derived activity view (one migration-free query, grade
   honest tomorrow).
2. Failure 5 work receipts (no schema change: receipt goes in the job's
   existing `payload`).
3. Failure 1 tier 1, owner devices as workers (needs the database to
   accept an SSH tunnel; the bundle already exists).
4. Failure 6 `writeCell` for floor and listed.
5. Failure 4 admission law and candidates table.
6. Failure 1 tier 2 crowd-hydrate.
7. Failure 2 stream-fed order book and Solana program-account listings.
