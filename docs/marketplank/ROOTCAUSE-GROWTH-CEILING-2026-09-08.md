# Root cause: why catalog growth stalls, per chain

Date: 2026-09-08. Every number measured, not estimated.

## The headline

**Bitcoin is not stuck. Its catalog source is exhausted, and every
alternative is paywalled or down.** The other chains stall for a completely
different reason: their discovery lanes are timing out against a keyed
vendor and sitting in backoff.

These are two unrelated failures that produced the same visible symptom (a
frozen counter), which is why one fix never resolved both.

## Bitcoin: source exhaustion, not lane failure

The lane is healthy. `ow-catalog:bitcoin-mainnet` last succeeded 9 minutes
before this measurement, with no error. It walks pages and registers
nothing new because there is nothing new to register.

Measured density in the OrdinalsWallet catalog (`total` claims 425,201):

| Offset | Real collections in 50 | Of those, BRC-20 |
|---|---|---|
| 1,000 | 49 | 0 |
| 2,000 | 2 | 2 |
| 2,500 | 0 | 0 |
| 3,000 | 7 | 6 |
| 4,000 | 8 | 7 |
| 6,000 | 9 | 8 |

Counting real, non-BRC-20 collections across the productive region:

| Offset | Real non-BRC-20 in 500 |
|---|---|
| 0 | 499 |
| 500 | 490 |
| 1,000 | 483 |
| 1,500 | 363 |
| 2,000 | 2 |

**Total available from this source: ~1,837. We already track 19,601** — ten
times more, gathered from other sources over time. The `total: 425,201` is
overwhelmingly BRC-20 fungible-token rows, which the scan correctly rejects.

My `DEAD_ZONE_OFFSET = 120_000` was wrong by two orders of magnitude. Real
collections end near offset 2,000, so the lane spends every turn walking
BRC-20 rows before wrapping.

### Every alternative Bitcoin catalog is closed

| Source | Status |
|---|---|
| Ordiscan | `402 Payment Required` |
| Magic Eden Ordinals | `503` (and Cloudflare-blocks servers) |
| UniSat | `404` without a key |
| OrdinalsWallet | open, exhausted at ~1,837 |

**Bitcoin's ceiling is a market-structure fact, not a bug.** Ordinals
collection membership is a social convention — a published list of
inscription IDs — with no on-chain registry to enumerate. Every catalog is
somebody's curated list, and the only free one is smaller than what we hold.

## EVM chains: vendor timeouts, lanes in backoff

Measured lane health at the same moment:

| Lane | Last success | Status |
|---|---|---|
| hypersync-discovery:opt-mainnet | 547 min ago | backoff |
| hypersync-discovery:polygon-mainnet | 474 min ago | backoff |
| hypersync-discovery:base-mainnet | 58 min ago | backoff |
| hypersync-discovery:eth-mainnet | 16 min ago | backoff |
| hypersync-discovery:bnb-mainnet | 12 min ago | backoff |

Errors: `timeout exceeded when trying to connect`, `Query read timeout`.

These lanes depend on HyperSync (keyed, `ENVIO_API_TOKEN`). When it is slow
or rate-limited, the lane dies, enters backoff, and that chain stops growing
until the next turn. Optimism has been dark for nine hours — which matches
the owner's observation of "1 added to optimism".

**The keyless `hunter-evm` driver exists and does not have this dependency**,
but it is scheduled only for Robinhood, because the matrix excludes chains
that already have a HyperSync lane to avoid double-counting activity. So
when HyperSync fails, those chains have no fallback discovery at all.

## The three structural ceilings

1. **Source ceiling.** A chain grows only as fast as the best catalog
   anyone publishes. For Bitcoin that is ~1,837 free entries; the rest is
   paywalled. No amount of engineering moves this without either a key or
   an independent enumeration.

2. **Vendor-dependency ceiling.** EVM discovery routes through one keyed
   vendor with no keyless fallback wired in, so a vendor's bad hour is a
   chain's dark hour.

3. **Compute ceiling.** 154 standing lanes; ~26 discover. Now mitigated by
   dedicated discovery workers and 10 in-process lanes, but still one host.

## What "instantaneous, total archive" actually requires

Not faster polling. Polling asks "what changed?" repeatedly. The archive
should instead be *told*:

- **EVM:** stop enumerating collections; enumerate *contract deployments*
  from logs. Every NFT collection announces itself on-chain the moment it
  mints. The keyless `hunter-evm` driver already reads Transfer logs
  chain-wide — it needs to be scheduled on every chain as a HyperSync
  fallback, not just Robinhood.
- **Bitcoin:** inscriptions are numbered sequentially, so "all" is
  enumerable by number from the ord recursive endpoints, independent of any
  marketplace's curated list. Collection *membership* still needs a
  published list, but *existence* does not.
- **Solana:** already closest to this — the Magic Eden catalog walk plus
  Helius DAS grouping is real enumeration, which is why Solana went from
  184 to ~9,800 in a day.

## Immediate corrections this analysis implies

1. `DEAD_ZONE_OFFSET` from 120,000 to ~2,500 so the Bitcoin lane stops
   burning turns on BRC-20 rows.
2. Schedule `hunter-evm` on all EVM chains as the keyless fallback when
   HyperSync is in backoff.
3. Treat "catalog exhausted" as a first-class lane state so a healthy lane
   with nothing to find is not mistaken for a broken one — the confusion
   that cost several cycles here.
