# Total Coverage: every NFT, every venue, every order

**The goal: a marketplace where every NFT a consumer could want to find is
findable, and every place it is currently for sale is visible.**

Researched live 2026-09-09 against official docs, GitHub, and the chain
registries. Every claim carries its evidence; anything unconfirmed says so.

---

## 0. The finding that changes the plan

**The machinery for exhaustive discovery already exists in this codebase. It
is being starved, not blocked.**

- All three canonical topics are already constants:
  `Transfer` `0xddf252ad…`, `TransferSingle` `0xc3d58168…`,
  `TransferBatch` `0x4a39dc06…` (`discovery/evm-log-scan.ts:70-74`).
- HyperSync scans **50,000 blocks per chunk**
  (`hypersync-evm-scan.ts:99`) against Alchemy's free-tier **10**
  (`evm-log-scan.ts` `CHUNK_BLOCKS = 10`, live-verified). **5,000×.**
- `runHypersyncBackfillScan` exists, is scheduled as a mesh lane, and its own
  note reads *"Gap-free genesis-forward historical discovery with its own
  durable cursor."*

So the question was never "can we?" It is arithmetic:

| chain | blocks | chunks @50k |
|---|---|---|
| ethereum | 23,000,000 | 460 |
| base | 22,000,000 | 440 |
| arbitrum | 290,000,000 | 5,800 |
| polygon | 66,000,000 | 1,320 |
| bnb | 45,000,000 | 900 |
| optimism | 128,000,000 | 2,560 |
| avalanche | 53,000,000 | 1,060 |
| zksync | 50,000,000 | 1,000 |
| **total** | | **13,540** |

At 1s/chunk: **3.8 hours serial, 24 minutes at 10-way, 5 minutes at 50-way.**
Every NFT contract ever deployed on eight chains.

Today the backfill lane gets `sliceSec: 180` and competes with ~45 other lanes
for ~3 slots. **That scheduling decision — not vendor limits, not technology —
is the distance between 349,253 collections and all of them.**

---

### Bitcoin: my root cause was wrong, and here is the corrected one

I said #418's self-parent fix would unstick the Bitcoin backfill and committed
to reporting the number either way. **It deployed and it did not.**

- Production now serves `6e3c82a` (confirmed via the page's `data-dpl-id`),
  and `git grep` confirms `repairSelfParent` is present in that commit.
- `blocksToProtocolT0` is **still exactly 198,651**. `backfillTail` still
  966,081. `runCount` still 41.

The self-parent poisoning was real, but it was **not the binding constraint**.
Walking the path component by component:

| link | verdict |
|---|---|
| `getBlockHashAtHeight` implemented on `EsploraBitcoinRpc` | ✅ present |
| Esplora `/block-height/966080` live right now | ✅ returns a valid hash |
| `ingestRange` has a Bitcoin branch | ✅ fixed previously |
| `this.store` and `this.pg` are the same object | ✅ verified — not a split-store bug |
| hash-link guard blocking the step | ❌ **cannot be** — see below |

The guard cannot be the blocker, and this is worth stating precisely because it
inverts the obvious reading:

```ts
const linked = !tailHeader || store.headersAtHeight(chain, to).some(...)
```

`ArchiveStore`'s maps are `new Map()` per process and **`pg-store.ts` has no
hydrate path**, so after a restart `headersAtHeight(tail)` is empty,
`tailHeader` is `undefined`, and `!tailHeader` makes `linked` **true**. The
guard is *skipped*, not failed. A self-parented row could not have stopped it
either.

Every component works. And `backfillTick` **is** called — unconditionally,
every tick, at `scripts/akasha-hose.ts:183`, with 66% of the tick as its
budget. So "starved of slots" is wrong here too.

What that leaves is the shape of the caller:

```ts
await hose.repairTick();
if (SHARD_CLAIMS > 0) { ... }        // off by default
await hose.backfillTick(BACKFILL_BUDGET_MS);
await hose.flush();
} catch (e) { console.error("[akasha-hose] tick failed:", ...) }
```

`backfillTick` is the **second-to-last statement in one shared `try`**. Anything
that throws above it — `repairTick`, or a shard tick once sharding is enabled —
skips the backfill entirely for that tick, forever, while the process stays up
and healthy-looking. The catch logs it, so the evidence is in the worker log,
not in any HTTP surface I can reach.

That is the honest end state of this investigation: **the cause is one of two
things, and distinguishing them needs the worker log, not more code reading.**
Either the `akasha-hose` process is not running at all in production, or it is
running and something before line 183 throws every tick. Both produce exactly
the number observed, and neither is distinguishable from outside — which is
itself the finding.

The instrumentation that ends this class of bug permanently: **count backfill
invocations separately from backfill progress**, and surface both. Right now
"never called", "called and threw", and "called and made no progress" are
indistinguishable, which is why this has now survived three wrong diagnoses
including two of mine.

That makes the fix the same fix: **give the backfill lane real slots**, and add
the one instrument that would have caught this months ago — a counter for
backfill *invocations*, distinct from backfill *progress*. A lane that is never
called and a lane that is called and makes no progress currently look identical
from outside, and that is precisely why this survived two wrong diagnoses.

---

## 1. The rate limit is a procurement decision

Every throttle here exists to ration a hardcoded pool: two RPC endpoints per
chain (later seven), seven IPFS gateways. But a public limit is **per
provider**, so the budget is `providers × per-provider-limit`, and the first
term was a constant somebody typed.

Measured against the live registries:

- `chainid.network/chains.json` — **2,755 chains**, and **52 keyless https
  endpoints** across our eight EVM chains (eth 13, bnb 14, base 7, polygon 6,
  arb 4, opt 4, avax 2, zksync 2).
- IPFS `public-gateway-checker` — **11 gateways**, only **2** of them among
  our hardcoded seven.

**This is the opposite of ignoring rate limits.** Racing one host is what
earned this app a 30-minute cooldown, and a prior audit banned it correctly.
Spreading across many hosts *respects every individual limit while removing
the aggregate one*: each provider keeps its own bucket, rest window and jail.
There were simply never only seven doors.

*Shipped:* `lib/market/multichain/provider-discovery.ts` — registry-driven,
probed before use (a 200 is not enough; some hosts return 200 with a JSON-RPC
error body), curated pool always the floor.

---

## 2. The venue coverage matrix, as it actually stands

**L** = live/resting orders · **H** = historical fills · **M** = membership only

Read this table with §"The limit that is real" below: every **L** on an EVM row
is necessarily Tier 2 (off-chain), because EVM resting orders have no on-chain
representation. Only the Solana **L** cells are chain-derived.

| venue | eth | 7 other EVM | solana | bitcoin |
|---|---|---|---|---|
| Marketplank (own) | — | — | — | — |
| Seaport (1.1–1.6) | **L+H** | **L+H** | — | — |
| OpenSea Stream | **L** | **L** | — | — |
| Blur | H | — | — | — |
| LooksRare **v1 only** | H | — | — | — |
| Rarible | H | — | — | — |
| Foundation | H | — | — | — |
| Sudoswap **v1 only** | H | — | — | — |
| X2Y2 (venue dead) | H | — | — | — |
| Wyvern | H *(no token id)* | — | — | — |
| Tensor | — | — | **L+H** | — |
| Magic Eden | — | — | L+M | *(retired)* |
| UniSat / Ordiscan / OrdWallet | — | — | — | **L+M** |

Nine fill indexers exist, each following an identical shape: verbatim ABI →
`Interface.getEvent(name).topicHash` → a pure `decode*` returning null on
mismatch → `writeFills`. **No topic0 is hardcoded in any indexer** — they are
derived, which is why they are trustworthy.

### The limit that is real, and is not ours

**EVM resting listings do not exist on-chain in any form.** A Seaport/Blur/
LooksRare order is an EIP-712 struct signed off-chain; the signature arrives as
calldata from the *taker* at fill time. There is no state to read and no event
to index. Chain data reveals such an order only at the moment it dies.
Seaport's maintainers confirm this in [issue #605](https://github.com/ProjectOpenSea/seaport/issues/605):
even orders posted via `validate()` cannot be retrieved from the contract or
its events to build a frontend.

This is a protocol design property, not a tooling gap, and no amount of RPC
throughput closes it. So the honest architecture is **two tiers, labeled as
such**:

- **Tier 1 — chain-derived, trustless, genuinely exhaustive.** Every asset on
  every chain. Every fill and cancel. And *complete live orderbooks* for the
  venues that do keep orders on-chain: **Solana** (Tensor and Magic Eden M2
  hold listings as on-chain PDAs with public IDLs — a real orderbook, no API
  needed), Sudoswap pools, and on-chain auction venues.
- **Tier 2 — off-chain, unavoidable, must reconcile against Tier 1.**
  OpenSea Stream plus whatever Blur exposes. Reconciliation is mandatory
  because off-chain cancellation lets an order die with **zero chain
  footprint** — a naive indexer over-reports live listings forever.

Solana is therefore the place where "every listing, provably" is actually
achievable today, and it is where we are weakest. That reorders the roadmap.

### Asset-discovery traps that silently break exhaustiveness

These are the ways a topic-only scan quietly misses tokens:

1. **ERC-721 and ERC-20 share the identical `Transfer` topic0.** Disambiguate
   by **topic count**: ERC-721 has 4 topics (tokenId indexed), ERC-20 has 3.
   The single most important filter rule.
2. **ERC-2309 `ConsecutiveTransfer`** compresses an entire collection into one
   event — `0xdeaa91b6123d068f5821d0fb0678463d1a8a6079fe8af5de3ce5e896dcf9133d`.
   An indexer keyed only on `Transfer` misses **every token** in such a
   collection. Confirmed real breakage.
3. **The ERC-721 spec exempts contract-creation from emitting `Transfer`** —
   which is why ERC-6047 exists. Log-only discovery can miss pre-assigned
   tokens; backstop with `ownerOf` probing.
4. **CryptoPunks predates ERC-721** (`0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB`)
   — registered as ERC-20, no `supportsInterface`, emits `PunkTransfer` /
   `PunkBought`. Needs a bespoke adapter.
5. **Blur v2 packs tokenId, price and side into two uint256 words** —
   `Execution721Packed` needs bit-unpacking, not ABI decode.

`supportsInterface` is a *confirmation* tool, never a discovery tool. Discover
from logs; confirm with 165.

### The single highest-leverage gap

**Six venues are hardcoded to Ethereum**: `BLUR_CHAIN_SLUG`,
`FOUNDATION_CHAIN_SLUG`, `LOOKSRARE_V1_CHAIN_SLUG`, `RARIBLE_CHAIN_SLUG`,
`SUDOSWAP_CHAIN_SLUG`, `X2Y2_CHAIN_SLUG` — all `= "eth-mainnet"`.

Rarible is genuinely multi-chain and the **same ExchangeV2 contract with the
same `Match` event** is deployed elsewhere. Verified today from
`rarible/protocol-contracts` deployment files:

| chain | ExchangeV2 |
|---|---|
| ethereum | `0x9757F2d2b135150BBeb65308D4a91804107cd8D6` *(already indexed)* |
| **arbitrum** | `0x07b637739CAd9A5f0c487219B283a52717E69978` |
| **bsc** | `0xF944C45AdD4d496E0409D8950925Aa03b0f09273` |
| **zksync** | `0x5E0BbEd68e1b47C94a396226D8AC10DDe242e77c` |

Three new chains, *zero new decoding logic* — the existing decoder already
handles this exact event.

**Verified independently, 2026-09-09** (not taken on the research agent's
word): all three addresses return real deployed bytecode via `eth_getCode`,
and **Arbitrum's is 2,141 bytes — byte-for-byte the same size as the
known-good Ethereum ExchangeV2**, which is strong evidence of the same
contract.

**But deployed is not the same as live, and this changes the recommendation.**
Scanning Arbitrum's ExchangeV2 for the `Match` topic
(`0x956cd63e…`, derived not copied) over **1.2M blocks (~3.5 days)** returned
**zero** fills; zkSync returned zero over 600k blocks. I could not obtain a
working Ethereum control within the public endpoints' 10k-block cap, so I will
not upgrade "no fills observed" to "dormant" — an uncontrolled negative is not
a finding. What is established:

- the contracts are real and deployed (proven)
- no recent fills observed on Arbitrum/zkSync in the windows scanned (proven)
- whether that means dormant or merely quiet is **UNVERIFIED**

The practical consequence: **do not wire these three first.** Un-hardcoding
the chain slug is still right, but the ordering argument in §5 rested on
"three new chains of data for free", and the data has not been shown to exist.
Confirm live fills against an archive-capable endpoint (HyperSync, which the
repo already uses) before spending scan budget on them. Rarible deploys to dozens of chains (apechain,
berachain, celo, astar, abstract, aleph_zero…), so this list extends as far as
we add chains. Polygon/base/optimism/avalanche files were empty or differently
shaped and are **UNVERIFIED** — not asserted here.

---

## 3. "Committed elsewhere" — where my first answer was wrong

My initial claim was that an NFT committed elsewhere is *always* a `Transfer`
to a contract, therefore free to detect once we read every transfer. **That is
only half true, and the missing half is the half that matters.**

Encumbrance splits into two regimes needing two entirely different pipelines.

### Regime 1 — custodial. The NFT moves. `ownerOf` returns a contract.

Free, exactly as claimed: the transfer is already in hand. But **contract
custody is not evidence of a listing**, and collapsing it into a price field
would be a real product bug. Three verified cases produce an identical
`ownerOf → contract` and mean three different things:

| `ownerOf` returns | actual meaning | is there a price? |
|---|---|---|
| Sudoswap pair | genuinely for sale | **yes** — `getBuyNFTQuote(id,1)` |
| NFTX vault | redeemable at floor | floor + fee + premium, **not** an ask |
| Fractional vault | fractionalized | **no** — reserve is a governance vote |
| Blur Blend `0x29469395…` | loan collateral | **no** — a loan, not a sale |

So the data model needs an explicit state —
`listed_at_price` / `pooled_floor` / `fractionalized` / `collateralized` —
never one price column.

**Sudoswap is the only clean case**, and it is genuinely clean: the pair holds
the NFT directly, `isValidPair(X)` confirms it, and `getBuyNFTQuote` returns a
true executable all-in per-token price. Check `error == OK` and skip
`poolType() == TOKEN` pools — those only bid, and rendering one as "listed"
would be wrong. Factories: v1 `0xb16c1342E617A5B6E4b631EB114483FDB289c0A4`
(deprecated), v2 `0xA020d57aB0448Ef74115c112D18a9C231CC86000`. Note v2 indexes
`poolAddress` in `NewERC721Pair` and v1's `NewPair` does not — v1 must be
decoded from data, not filtered by topic. And `NFTDeposit` means inventory
changes *after* creation, so indexing creation events alone drifts.

### Regime 2 — non-custodial. The NFT never moves. This is the trap.

**Blur Blend loans and delegate.xyz delegations leave the token in the owner's
wallet.** A transfer-only pipeline sees nothing and reports the token as
unencumbered. This is the classic failure mode and my first draft walked
straight into it.

Detection here is a **registry query keyed off the owner**, not a log scan:

1. `owner = ownerOf(tokenId)`
2. `delegateRegistry.getOutgoingDelegations(owner)` — one call, all rows
3. filter in **widening scope order**: `ERC721` exact token → `CONTRACT`
   whole-collection → `ALL` wallet-wide

> Checking only the `ERC721` tier is the false-negative that bites: **most
> real delegations in the wild are `DelegateAll`**. A token can be fully
> committed with zero ERC721-type rows.

delegate.xyz v2 `0x00000000000000447e69651d841bD8D104Bed493` (identical across
~29 EVM mainnets; **zkSync-family is different**:
`0x0000000059A24EB229eED07Ac44229DB56C5d797`). v1
`0x00000000000076A84feF008CDAbe6409d2FE638B` is a separate live contract with
a different ABI — check both for history.

**`tokenId` is NOT indexed on `DelegateERC721`.** You cannot filter logs by
token; filter by `contract_` (topic3) and decode tokenId from data. That single
fact rules out the naive reverse-lookup design.

On-token standards are the easy tier — one `supportsInterface` per collection,
cached forever, then a per-token read: ERC-4907 `0xad092b5c` (`userOf` returns
zero once expired, so non-zero *is* the proof), ERC-4400 `0x953c8dfa`
(`consumerOf`, no expiry). ERC-5058's expiry is a **block number, not a
timestamp** — comparing it to `block.timestamp` is a real and easy bug.

### Regime 3 — ERC-6551, the inverse case

The NFT is not encumbered; it *owns* a wallet. Transferring it hands over
everything inside. Registry `0x000000006551c19487814612e58FE06813775758`
indexes `tokenContract` and `tokenId`, so log reverse-lookup works directly
here. Two traps: an **earlier registry** `0x02101dfB77FDE026414827Fdc604ddAF224F0921`
is still live with a different `createAccount` signature; and `account()` is a
CREATE2 *prediction* that returns an address whether or not anything is
deployed — **an undeployed TBA can still hold assets**, so absence of a
creation event does not mean absence of value.

### How to classify a holder without a hand-maintained address list

The scaling insight: **cache by `EXTCODEHASH`, not by address.** Nearly every
NFT-holding contract is a clone — Safe proxies, 6551 accounts, Sudoswap pairs
are byte-identical per implementation. Millions of tokens collapse to thousands
of codehashes, and a few thousand cover the overwhelming majority.

Order matters, and proxies must resolve *first* — scanning a Safe proxy's
bytecode tells you nothing, since the selectors live in the singleton:

```
ownerOf → address
  ├─ code length 0            → EOA or burn                    (free)
  ├─ codehash in cache        → done                           (free)
  ├─ CREATE2 recompute 6551   → 100% precision, zero RPC       (free)
  ├─ in factory-child index   → done                           (free)
  ├─ resolve proxy: 1167 byte-slice / 1967 slot / Safe slot 0
  ├─ Sourcify v2 → Etherscan V2 verified source → label
  └─ else EVMole selector-SET fingerprint
```

- EIP-1167 clones put the implementation at **bytes 10–29 of the 45-byte
  runtime** — a string slice, zero extra RPC.
- EIP-1967 impl slot `0x360894a1…82bbc`; Safe uses **storage slot 0** instead.
- `supportsInterface` returning true is high-precision; **returning false is
  near-zero information** — OpenZeppelin's own `ERC721Holder` does not
  advertise `IERC721Receiver`. Always sanity-check `supportsInterface(0xffffffff)`
  returns false, or the contract is lying and every 165 result must be discarded.
- Classify by **selector SET**, never a single selector. Sets survive the
  ~0.06% collision rate and need no signature database at all.
- **Upgradeable proxies break codehash caching**: cache the *resolved
  implementation* and invalidate on `Upgraded`/`BeaconUpgraded`.

Factory-event indexing is the best coverage-per-effort in the whole plan: one
`eth_getLogs` sweep per factory, once, and every current *and future* instance
resolves by O(1) lookup. Sudoswap's indexer already proves this shape here —
it filters topic0-only across all addresses because every pool is a clone
(`sudoswap-fill-indexer.ts:80-94`).

---

## 4. What the industry research changed

**Magic Eden exited Bitcoin Ordinals on 2026-03-09** — Ordinals, Runes and EVM
all shut down to refocus on Solana. Their Ordinals API docs are still live with
no sunset notice. **OKX is now the primary surviving Ordinals venue with a
documented API.**

**The neutral NFT data layer collapsed.** Reservoir sunset 2025-10-15 (docs now
redirect to `docs.relay.link`); SimpleHash ceased 2025-03-27. Two aggregator
exits in seven months, leaving Alchemy (EVM) + Helius (Solana) and **no strong
Bitcoin/Ordinals equivalent.**

> That is precisely the gap the akasha archive fills — and it is now a market
> gap, not merely a technical preference.

**Blur has no public API at all.** `docs.blur.io` does not resolve; the
`blur-io` GitHub org has exactly one public repo, a fork of OpenSea's operator
filter. Blur is a feature spec to harvest, not an API to integrate.

### Worth taking, with sources

- **`me-foundation/msigner`** (Apache-2.0) — Ordinals atomic swap:
  `SIGHASH_SINGLE | ANYONECANPAY` so the seller commits only to their own
  output, plus a 2-dummy-UTXO layout that keeps the inscription at a fixed
  offset so it cannot be swept into fees. Magic Eden abandoned the product and
  left the hard-won part published.
- **OpenSea Stream API** — `wss://stream-api.opensea.io`, ten event types, and
  critically **stream messages do not count toward REST rate limits**.
- **Seaport criteria orders** — Merkle-root trait bids. How professionals
  actually acquire; a venue without them is not a pro venue.
- **`tensor-foundation/escrow`** — one balance backing many bids. Directly
  determines how much size a market-maker will commit.
- **TensorSwap / MMM pools** — turns passive inventory into quoted liquidity.
- **`magicdrop`, `cmx`** — launchpad references, EVM and Solana.
- **`ProjectOpenSea/api-types`** — types generated from an OpenAPI spec,
  implying a machine-readable spec exists.

---

## 5. Build order

**Now — the 5%-to-100% change**
1. Give `hypersync-backfill` real slots. This one scheduling change is the
   whole distance to exhaustive EVM coverage.
2. Wire `provider-discovery` into the RPC pool and gateway list, which is what
   makes (1) safe at concurrency.
3. Bitcoin: the self-parent fix **deployed and did not help** — 198,651
   unchanged. Corrected root cause in §0.1: the lane is not being called.
   Same starvation, same fix. Add an invocation counter so "never called" and
   "called, no progress" stop looking identical.

**Next — venue breadth for almost no code**
4. Un-hardcode the six eth-only indexers; add the three verified Rarible
   deployments first.
5. Decode Wyvern's `atomicMatch_` calldata — years of OpenSea history are
   indexed with maker/taker/price but **no token id**. Rarible already proves
   the calldata-via-HyperSync pattern.
6. LooksRare v2 (the multi-chain protocol; only v1 is indexed and v1 is
   dormant).

**Then — the depth nobody else has**
7. **Solana on-chain orderbooks.** The one place "every listing, provably" is
   actually achievable: Tensor and Magic Eden M2 keep listings as on-chain
   PDAs with public IDLs. Tier 1 completeness no competitor can claim by API.
8. Encumbrance, **both regimes** — custodial via the transfers already read,
   non-custodial via delegate.xyz + on-token standards. Regime 2 is the one
   every other system omits, and it is the one with financial consequence.
9. Holder classification by codehash cache + factory-event index.
10. Ordinals atomic swap on the msigner pattern.
11. The retention layer: watchlist, alerts, cross-listing.

## 6. What must stay true

- **Discovery is topic-only across all addresses.** Address-scoped scanning is
  restricted to exactly two audited functions and enforced by
  `npm run lint:discovery`. Exhaustiveness is a property of *not filtering*.
- **A registry is a list of claims.** Every discovered endpoint is probed;
  `polygon-rpc.com` now answers 401 and llamarpc fails TLS with 525.
- **Coverage is a hash-linked run-list**, and `run_count = 1` is load-bearing:
  an archive with holes satisfies every endpoint check and still cannot claim
  completeness.
- **A dead venue stays recorded, not deleted.** X2Y2 is marked `unavailable`
  with the HTTP 521 that proved it. Knowing where the data ends is the product.
