# `hose`: the firehose, and the reclassification it forces

Date: 2026-09-08. Implementation spec accepted from Grok's second response,
**with one correction verified against our source**.

## The correction (checked before accepting)

Grok wrote: "you have a venue feed and an address-filtered puller", and told
us to rename HyperSync discovery until its address list is gone.

Verified in `lib/market/multichain/discovery/hypersync-evm-scan.ts`:

| Call site | Query shape | Verdict |
|---|---|---|
| `runHypersyncDiscoveryScan` (line 542) | `logs: [{ topics: [[Transfer, TransferSingle, TransferBatch]] }]` — **no `address`** | already compliant |
| genesis/backfill scans (681, 837) | topic-only | already compliant |
| `findEarliestTransferBlock` (339) | `address: [contractAddress]` | **legitimate** — per-collection, named genesis |
| `runAddressScopedMembershipScan` (418) | `address: [address]` | **legitimate** — attention-named slice |

So our EVM discovery is already topic-only over a block range. The two
address-filtered calls are exactly the "attention-named historical slice"
the spec permits. **The catalog is not in our EVM discovery query.**

What *is* true, and is the real finding:

- We have **no chain subscription at all** (verified: zero hits for
  `eth_subscribe`, `newHeads`, `blockSubscribe`, `programSubscribe`,
  `rawblock`, `zmq` across `lib/` and `scripts/`).
- Discovery is a **cursor-advanced range pull through one keyed vendor**.
  It is topic-correct but vendor-bound, which is precisely the ceiling we
  measured: 5 of 8 chains in backoff, Optimism dark 9h, Polygon 8h.
- There is **no coverage object**. No process can currently answer "is
  `[t0, finalized]` a single contiguous run?"

The distinction matters: we do not need to un-catalog the query. We need to
change *who owns the tip* and *what proves completeness*.

## Reclassification (adopted)

| Process | Allowed to be | Not allowed to be |
|---|---|---|
| OpenSea Stream | Courier hint for Seaport orders; may enqueue order tickets | Existence, completeness, a cursor |
| HyperSync | Accelerator for a slice whose `(contract, from, to)` is already named | The tip cursor; the reason a chain grows |
| Catalog walks (Solana 184→9,800) | Backfill of a named genesis | How a chain grows |
| Crowd-hydrate 2-hash rule | Dead | — |

**Already compliant, verified:** the OpenSea Stream does not call
`upsertTrackedCollection` and does not insert into
`plank_multichain_collections`. It writes fills and floor observations only.
Grok's rule 4 ("stream cannot insert artifacts") is a regression test to
add, not a bug to fix.

## What `hose` is

One process that owns the tip. Everything else may read the event table;
nothing else may write `artifact`, `event`, or `coverage_run`.

```
hose
  ├─ adapter.evm      × N   (newHeads | HTTP tick → bloom → one-block receipts)
  ├─ adapter.solana   × 1   (fixed PROGRAM set, not mints)
  ├─ adapter.bitcoin  × 1   (ZMQ doorbell + header walk)
  ├─ coverage               (the only completeness object)
  └─ gap_worker             (the only legal puller)
```

### Boot invariants (refuse to start otherwise)

1. `coverage_run` over `[t0_height, finalized_height]` collapses to one
   contiguous run, else boot in repair and never set `stream_alive`.
2. Every `event.block_hash` has a stored header. **Height is not identity.**
3. `gap_queue` is the only caller of historical RPC.
4. No adapter accepts a list of collection addresses. A fixed list of
   protocol programs (Solana) or topic0s (EVM) is allowed.

### EVM adapter

Preference order, none of which is a paid vendor on the critical path:

1. `eth_subscribe("newHeads")` on any WS that stays up; treat disconnect as
   the normal case.
2. HTTP tick: `eth_blockNumber` every `max(2s, half_block_time)`, then
   `eth_getBlockByNumber(n, false)`. Still push-shaped — you learn heads
   without asking about collections. Slower, complete.

Never `eth_subscribe("logs")` filtered by a growing address list.

Per head: rewind if `parentHash != tip_hash`; store the header; test
`logsBloom` against our topic0 set; on a hit call `eth_getBlockReceipts(hash)`
(one call, all logs) falling back to `eth_getLogs` for that single block with
**no `address`**; persist matching logs; upsert artifacts for mint-shaped
transfers (`from == 0x0`) and factory clones; advance tip; extend the
coverage run at finality.

- **Finality:** `finalized = tip - k`, `k` stored per chain (ETH 12, L2s
  20–60). No vendor "safe" tag.
- **Bloom audit:** force receipts on `height % 32 == 0`. A miss means our
  topic hashes are wrong or the node's bloom is bad; that chain runs
  force-receipts until the incident closes.
- **Rewind:** walk `parentHash` to a stored hash, `DELETE ... WHERE
  block_hash IN (orphans)`, then gap-fill ancestor→tip.

HyperSync is demoted in code to `hypersync_fill(chain, address, from, to)`,
callable only by the attention backfill worker and only after `artifact`
exists for that address. In backoff it falls back to `eth_getLogs` on that
one address. **Discovery never calls it.**

### Solana adapter

`blockSubscribe` is unstable and needs validator flags; it is not the
critical path. Subscribe `programSubscribe` at `confirmed` over a **closed,
versioned protocol set**: Token Metadata, MPL-Core, Bubblegum, Token and
Token-2022, and the marketplace programs we settle against. A follower
advances `finalized`.

Completeness is **slot arithmetic**: store every ingested slot; a hole in
`[t0, finalized]` is a gap; fill with `getBlock`. The subscription is a
hint, the slot run is the tape.

The 184→9,800 catalog walk becomes backfill of a named genesis, not
discovery.

### Bitcoin adapter

ZMQ is a doorbell, not a tape. `hashblock`/`rawblock` fire on tip change,
can drop, and do not walk you back on reorg. Use the `sequence` topic for
connect/disconnect if available.

On any wake: compare `getbestblockhash()` to the cursor; fast-path if the
parent matches; otherwise walk headers, disconnect the old path, ingest the
new one in order; gap-queue any sequence jump. Ingest parses taproot
witnesses for `ord` envelopes into `event` rows. Parent-child is stored as a
raw field, **not** as a cluster write — clusters are a later reader.

A local `bitcoind` + `ord` is the justification for a second worker tier.
Paid ordinal APIs are how we hit the source ceiling we measured today
(Ordiscan 402, Magic Eden 503, UniSat 404).

### Gap worker

One queue, one budget. Live adapters hold first lock on their chain. Fill at
most B blocks per turn (16 EVM, 32 Solana slots, 1 Bitcoin block),
preemptible. **Refuse** any gap whose range was not produced by reconnect,
reorg, bloom audit, or an attention ticket naming a genesis already in
`artifact`.

## Definition of done for this week

Not clusters, not visitor nonces, not floor kits — those read a tape that
does not exist.

Ship `hose` on the chains currently in HyperSync backoff. Measurements:

1. **Coverage invariant.** A test inserts a hole; the process refuses
   `stream_alive`.
2. **Reconnect drill.** Kill the stream 90s. Queue drains; the event set for
   that range equals a from-scratch `getBlockReceipts` over the same heights.
3. **No address list in discovery.** Grep the adapter path.
4. **Stream cannot insert artifacts.** Replay a stream event for an unseen
   contract; `artifact` stays empty until a chain event arrives. (Currently
   true — lock it with a test.)
5. **Lag.** p99 block-timestamp → `event` row under 2 block times on the
   backoff chains, on the HTTP tick if WS is gone.

If (5) fails on the HTTP tick, that is a node problem, not a reason to
restore vendor discovery. Point the tick elsewhere.

## Why this is first

The Bitcoin source ceiling we measured today is the firehose's first payoff
on that chain: once every new block's envelopes land in `artifact` without
asking OrdinalsWallet what exists, the exhaustion of their `total` stops
being a product state.

Until `hose` owns the tip, every other lane is still pulling a list.
