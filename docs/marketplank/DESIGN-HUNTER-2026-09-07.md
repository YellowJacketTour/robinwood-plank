# The Hunter: one engine that gathers any chain's data without indexing any chain

Date: 2026-09-07. Code: `lib/market/multichain/hunter/`, `lib/market/multichain/cell-provenance.ts`, lanes `hunter-evm:*`, `hunter-solana:solana-mainnet`, `hunter-bitcoin:bitcoin-mainnet`.

## The owner's brief, answered

"An on-server mini super-fast indexer for taking chunks of blockchain data
from anything including Solana and Bitcoin, hydrating our server and
archives, such that we can go and grab all data from anywhere anytime on
any chain, without indexing entire chains on my storage."

Yes. The shape is a **hunter-gatherer**, not an indexer: every chain
exposes a public primitive that returns exactly one bounded slice of its
history or state, keyless, from many independent operators. The engine
asks for the slice it needs, keeps only what it finds, remembers where it
stopped, and leaves a receipt. plank.love holds the findings. Nobody holds
the chain.

## The primitives (all verified live in this codebase before today)

| Family | Slice primitive | Operators (no key) | What it yields |
|---|---|---|---|
| EVM (9 chains) | `eth_getLogs` by topic, chain-wide, block range | publicnode, drpc (+ Alchemy as fallback) | every NFT transfer, Seaport/Blur/X2Y2 fill, ERC-4906 metadata update |
| Solana | `getProgramAccounts` on marketplace programs; `getSignaturesForAddress` | any public RPC (pooled) | Tensor list state, Magic Eden M2 trade state, program history |
| Bitcoin | `tx/:txid`, `tx/:txid/outspends`, `blocks/tip/height` | mempool.space (blockstream as mirror) | inscription location, spend, settlement price; envelope parsed locally |

## The kernel

```
runHunt(driver, chain, budget)
  cursor  <- durable (plank_kv_values)          one per (family, chain, scope)
  chunk   <- remembered size, adaptive          grow 1.5x on success, halve on "too large", honour vendor hints
  loop until budget or caught up:
     findings, cursorAfter <- driver.hunt(cursor, chunk)
     rows <- sink(findings)                     activity, admission, provenance-ranked cells, ledger
     cursor <- cursorAfter (persisted per chunk, never lost on abort)
  receipt -> job.payload.receipt                calls, status, cursorBefore/After, findings, rows, noop flag
```

- **Adaptive chunking** is what makes it fast without a paid accelerator.
  The old keyless scan hard-coded the smallest vendor ceiling (10 blocks)
  and crawled at two minutes of chain time per call. The hunter probes:
  200 blocks, 300, 450 ... until a provider says "too large", then halves,
  and remembers the last good size per chain. Measured ceilings on the
  public pool are in the thousands of blocks per call.
- **Reorg safety**: EVM hunts stop three blocks behind the head.
- **Cooperative cancellation**: the lane's AbortSignal and a wall-clock
  deadline are checked per chunk; cursor persistence is per chunk, so an
  abort costs at most one chunk of rework.
- **Receipts**: `succeeded` and `succeeded-noop` are different outcomes.
  A hunt that moved no cursor and wrote no row is flagged `noop` on the
  job so diagnostics can show idle lanes as idle.

## The sink: one law for every finding

- `transfer-tally` -> `plank_multichain_activity_stats` (the grade's
  activity axis reads it directly) and the **admission law**: a contract
  enters the tracked set only with >= 25 transfers across >= 25 distinct
  tokens in one chunk. A one-token airdrop or an ERC-20 look-alike never
  qualifies; a real collection trading normally qualifies within minutes.
  Name and image then hydrate through the existing metadata lane.
- `listing-book` -> `writeCells()` under **cell provenance**: chain-derived
  sources rank above every venue stream and REST vendor; a lower-ranked
  writer may replace a cell only after the holder's TTL. This is the
  class fix for "the floor flips between two values".
- `settlements` -> already in the ledger through the one sink
  (`ledger-sink.ts`); the finding carries the count for the receipt.

## What this replaces, and what it keeps

Kept as accelerators, not dependencies: HyperSync (EVM, keyed), Helius
DAS (Solana metadata, keyed), the OpenSea stream (free key). Their lanes
run unchanged. When they are jailed or absent, the hunter lanes still
produce activity, admission, Solana books and Bitcoin settlements from
public surfaces.

Replaced over time: `evm-log-scan.ts`'s fixed 10-block scan (superseded
by the adaptive EVM driver), separate ad-hoc cursors in three files
(superseded by `hunter/cursor.ts`), last-writer-wins floor writes
(superseded by `cell-provenance.ts`).

## Next drivers, same interface

1. **EVM fills**: add the Seaport `OrderFulfilled`, Blur, X2Y2 topics to
   the same adaptive chunk; hand logs to the existing fill decoders. One
   pass then yields transfers AND sales.
2. **Solana Magic Eden M2 sweep**: `getProgramAccounts` on M2 with the
   seller-trade-state discriminator, decoded by the verified PDA layout
   already in `magiceden-m2-onchain.ts`.
3. **Solana sales**: `getSignaturesForAddress` on Tensor/M2 programs from
   the signature cursor; decode with the existing enhanced-tx decoder.
4. **Bitcoin inscriptions**: for a known inscription id, walk the reveal
   tx witness with `ordinals-envelope-parser.ts` for content type and
   metadata, keyless.
5. **Crowd-hydrate** (FAILURES-AND-INVENTIONS failure 1, tier 2): the
   visitor's browser runs the metadata driver for the collection it is
   viewing, with server-side hash corroboration.

## Acceptance, measured not claimed

- `hunter-evm` receipts show chunk size > 1,000 blocks on at least six of
  nine EVM chains within a day.
- Every EVM row with sales in the last 24h shows non-zero "Recent chain
  activity" on the hub within one hunter pass.
- `plank_multichain_collections` gains rows only through the admission
  law or a marketplace catalog; the Robinhood tab count stops climbing on
  shells.
- Solana collections with Tensor listings show listed and floor with
  provenance `hunter-solana`, and no REST vendor overwrites them inside
  30 minutes.
- Bitcoin settlements keep landing with every vendor key removed.

## Addendum (same day): proof, and "all Solana NFTs, all Ordinals"

### Parity oracle: prove the numbers against independent references

Owner: "sites like Dune or DefiLlama ... cross-verify against these
sources to prove our work is accurate". Yes. `lib/market/multichain/parity/`
samples each chain's most active collections every pass, reads independent
references, compares floor / listed / supply / 24h sales / 24h volume with
relative tolerances, and stores a verdict per collection (match, near,
diverge, unverified) plus a per-chain agreement ratio. A divergent
collection is enqueued for a fresh stats sync, so disagreement becomes work.
Read at `/api/market/multichain/parity-oracle` (door).

References, chosen for being readable without anyone's gate:

| Family | Reference | Key? | Fields |
|---|---|---|---|
| all | CoinGecko NFT (EVM by platform + contract; Solana and Ordinals by id) | none (Demo key optional, free) | floor, 24h volume, 24h sales, supply |
| Solana | Magic Eden collection stats | none | floor, listed, 24h volume |
| Bitcoin | Hiro Ordinals API global count | none | coverage: inscriptions we hold / all inscriptions |

Dune is the right fourth reference for sales and volume (its `nft.trades`
and Solana tables are the industry benchmark) and needs one saved query
per metric in the owner's own account plus a free API key; the reader slot
is left for it. DefiLlama no longer publishes NFT volumes. CryptoSlam and
NFTGo are paid.

### The complete catalog: how "all" is reached without indexing a chain

**Solana, every NFT.** Three enumerations, each exhaustive for its
standard, unioned:
1. Collections: the keyless Magic Eden catalog walk (`magiceden-catalog`,
   exhaustive, paginated past 20,000 with no ceiling) plus Tensor and the
   Helius Core scan. This is the long tail the 2026-08-20 cleanup removed;
   it refills from here with names attached on entry.
2. Members per collection: DAS `getAssetsByGroup` across the pooled
   providers (Helius, QuickNode, Shyft each bill independently), which is
   the only path that also covers compressed NFTs. Keyless fallback for
   legacy metadata accounts: `getProgramAccounts` on Token Metadata with a
   memcmp on the first verified creator, which identifies candy-machine
   collections without a key.
3. Listings and sales: program accounts (Tensor, Magic Eden M2) and
   signature history, keyless.

**Bitcoin, every Ordinal.** Inscriptions are numbered, so "all" has a
denominator: Hiro's keyless API walks inscriptions by number and reports
the total. Collections are a social layer (a published list of inscription
ids), enumerated from the OrdinalsWallet catalog (keyless) and any keyed
catalog the owner adds. Settlements come from mempool.space; content and
metadata from the reveal transaction witness, parsed locally. The one
piece no public API will give at full scale is ownership of every
inscription at every block; that is the owner-device `bitcoind` + `ord`
tier from FAILURES-AND-INVENTIONS failure 1, which pushes findings to
plank.love instead of plank.love hosting the chain.

**Capacity is the only real limit**, and compute-anywhere removes it:
every device the owner controls runs the same worker bundle against the
same job table; every visitor's browser hydrates the collection it is
looking at. Coverage parity (held / total) on the parity endpoint is the
progress bar for "all".
