# Advanced Wide-Spread Research Spec: Free, On-Chain, Bespoke Data Solutions for Marketplank

**Date:** 2026-08-24
**Scope:** Floor price, collection banner/cover imagery, rarity, holder distribution, and volume/sales history — sourced without dependency on a single paid vendor's REST API, using free/keyless infra consistent with `rpc-provider-pool.ts` and `onchain-contract-reads.ts`.

**Ground truth this spec respects:** no LLM key exists in this app; Alchemy CU quota is scarce; OpenSea/CoinGecko/UniSat/Ordiscan/Magic Eden/Helius are the only paid-tier-adjacent vendors in use; LooksRare/Blur/X2Y2 REST APIs were already found dead/non-viable as of 2026-08-24.

---

## 1. Floor Price — Triangulation Without a Vendor REST API

The core insight: **"floor price" as displayed by OpenSea/Blur is a curated off-chain aggregation product**, but the raw signal it's built from — listings and fills — is either (a) fully on-chain for AMM-style pools, or (b) reconstructable from on-chain **fill events**, even when the pre-fill *listing* itself was an off-chain signed order. This app already has Seaport-backfill/HyperSync infra, so the marginal build here is smaller than it looks.

### 1a. On-chain AMM/bonding-curve pools — REAL, fully on-chain, buildable today

**sudoswap (LSSVMPair / sudoAMM v2)**
- Every pool is its own contract holding NFTs and/or ETH, with a readable `spotPrice()` and `delta()`/curve params. The *sell-into-pool* quote (what the pool will pay for 1 NFT) is a direct, honest lower-bound floor signal for that collection — it's a live, standing bid, not a stale listing.
- Pools are discoverable via the `PairFactory` contract's pool-creation events (`NewPair`), each pair tagged to an NFT collection address. Once you have the set of pairs for a collection, `eth_call` to `spotPrice()` per pair, take the max sell-quote across pools as a floor-adjacent signal.
- This is exactly the shape of read `onchain-contract-reads.ts` already does (raw `eth_call`, no vendor). Cost: one more contract-read module, same RPC pool.
- Caveat: sudoswap has thin liquidity for most collections now (peak usage was 2022–23) — treat it as one input, not primary, and only present when pools exist for a given collection.
- Docs: [sudoswap Pair Creation](https://sudoswap.github.io/lssvm-docs/site/reference/pair-creation/), [lssvm GitHub](https://github.com/sudoswap/lssvm), Etherscan PairFactory `0xb16c1342e617a5b6e4b631eb114483fdb289c0a4`

**NFTX v3 vaults**
- v3 vaults pair a "vToken" (1:1-backed fungible wrapper of the NFT collection) against WETH on an in-protocol Uniswap-v3 fork AMM. The vToken/WETH pool price *is* a continuously-traded, on-chain, manipulation-resistant floor proxy — arguably a better floor signal than a REST snapshot because it reflects live AMM state, not a stale listing sweep.
- Read path: resolve vault address from `NFTXVaultFactoryUpgradeableV3` (per-collection vault registry) → read the Uniswap-v3-fork pool's `slot0()` for `sqrtPriceX96` → convert to vToken/WETH price → that's your floor estimate in ETH.
- This is a second real, free, on-chain floor input with zero vendor dependency.
- Docs: [NFTX Protocol Overview](https://docs.nftx.io/protocol-overview), [NFTXVaultFactoryUpgradeableV3](https://docs.nftx.io/core-contracts/nftxvaultfactoryupgradeablev3)

Combine both: `floor_estimate_onchain = min/max(sudoswap_best_sell_quote, nftx_vtoken_price)`, clearly labeled as "AMM liquidity floor" and shown only when a pool exists — not force-filled for the ~99% of collections with no AMM pool.

### 1b. On-chain marketplace fill events — REAL, the biggest lever, directly extends existing infra

**Listings on Seaport/LooksRare/Blur are off-chain signed orders (gasless), so they are NOT visible pre-fill via chain scanning or mempool monitoring** — the order payload lives in the marketplace's private off-chain order book/API, exactly the dead-REST-API problem already identified. But **fills are always on-chain**, because settlement requires a transaction.

- **Seaport `OrderFulfilled`** — already partially in scope via existing Seaport-backfill infra. Parsing `consideration` gives real sale price per fill. A rolling window (e.g. last N fills, or last 24–72h) of `min(sale_price)` or a percentile (10th pctile to reject dust/wash trades) across a collection's fills is a legitimate, free, **realized-floor** signal — arguably more honest than a listed-floor number since it reflects actual clearing prices, not asks that never fill.
  - Refs: [Seaport OrderFulfilled discussion](https://github.com/ProjectOpenSea/seaport/discussions/546), [Shovel indexer docs](https://www.indexsupply.com/shovel/docs/) (real open-source log-to-SQL indexer worth evaluating as infra).
- **LooksRare V2 `TakerAsk`/`TakerBid`** — same shape, different ABI, against `LooksRareProtocol` (`0x0000000000E655fAe4d56241588680F86E3b2377`). Docs: [LooksRare V2 Protocol Overview](https://docs.looksrare.org/developers/protocol/looksrare-v2-protocol-overview).
- **Blur** — Blur's exchange contract (`0x000000000000ad05ccc4f10045630fb830b95127`) emits an `Execution`-style event on every fill, log-scannable even though Blur has **no public REST/off-chain API at all**. This makes Blur fill-log scanning the *only* free way to get any Blur signal at all — third-party rebroadcasters (Bitquery, SimpleHash) are paid vendors, defeating the purpose.
  - Refs: [Blur Marketplace — Etherscan](https://etherscan.io/address/0x000000000000ad05ccc4f10045630fb830b95127), [BlurExchange.sol source](https://github.com/code-423n4/2022-10-blur/blob/main/contracts/BlurExchange.sol).

**Why this beats a REST call architecturally**: it's the *same* underlying settlement data OpenSea/Blur REST APIs are themselves built from — going to the source instead of the reseller. Reservoir Protocol (the industry's own NFT liquidity-aggregation infra) is explicitly built this way — order-book aggregation plus on-chain indexing of transfers/fills across marketplaces. Marketplank's `onchain-contract-reads.ts` + Seaport-backfill infra is a smaller, purpose-built version of the same architecture, for free.

### 1c. Mempool monitoring — mostly a dead end, be honest about it

**Not viable as a primary floor signal**: Seaport/LooksRare/Blur *listings* are off-chain signed messages that never touch the public mempool (only the *fill* transaction does, at which point it's already an on-chain event covered by 1b). Recommendation: do not build mempool monitoring for this purpose — the cost/complexity isn't justified over polling confirmed-block AMM state (1a) and fill logs (1b).

### 1d. What's genuinely NOT achievable on-chain

- **Curated "floor price"** as OpenSea/Blur display it (lowest active, non-cancelled, verified-collection listing) is fundamentally an off-chain business-logic product — private order book, private spam/wash filtering, silent cancellation/expiry that may never post a transaction. Cannot be reconstructed byte-for-byte — only approximated via realized fills (1b) and AMM liquidity (1a).
- **Listed count** has the same problem — requires knowing every live, unfilled off-chain order. No chain-scanning recovers this. UI should either omit "listed count" or show it only for AMM-backed collections (sudoswap/NFTX inventory counts *are* on-chain and 100% accurate there).

**Recommended blended floor pipeline**: `onchain_floor_estimate = weighted_blend(AMM_liquidity_floor [1a], rolling_realized_fill_floor [1b, Seaport+LooksRare+Blur])`, always labeled distinctly from any vendor-sourced "floor" (OpenSea) to avoid presenting a triangulated estimate as the marketplace's own curated number.

---

## 2. Collection Banner/Cover Images

### 2a. `contractURI()` per ERC-7572 — REAL, on-chain-pointer, buildable today, highest-value fix

ERC-7572 (finalized standard, successor to OpenSea's older undocumented `contractURI()` convention) standardizes a contract-level metadata endpoint returning JSON with `name`, `description`, `image`, **and `banner_image`** — an explicit banner-image field. This is precisely the field this app is missing and it is 100% on-chain-discoverable:

1. `eth_call` the collection contract's `contractURI()` (present on a large and growing share of post-2023 ERC-721/1155 deployments; OpenZeppelin templates now scaffold it by default).
2. Resolve the returned URI exactly like `onchain-contract-reads.ts` already resolves `tokenURI()` — `data:`, `ipfs://`, `https://` all apply identically.
3. Parse `banner_image` (fall back to `image` for a square/cover shot when no banner is set).

Near-zero-cost extension of the existing metadata-hydration module — same URI-resolution code path, one new contract call. Highest-leverage fix in this whole spec because it's free, standards-backed, and architecturally identical to work already shipped.
- Docs: [ERC-7572 spec](https://eips.ethereum.org/EIPS/eip-7572), [Ethereum Magicians discussion](https://ethereum-magicians.org/t/erc-7572-contract-level-metadata-via-contracturi/17157), [OpenSea contract-level metadata docs](https://docs.opensea.io/docs/contract-level-metadata) (the pre-7572 convention this standard formalized — many older/legacy collections still only support this older shape, same field names).

**Coverage caveat, stated honestly**: `contractURI()` is opt-in — older collections (most pre-2022 blue chips) frequently don't implement it at all, or implement only `name()`/`image` with no `banner_image`. Expect meaningful coverage gaps, especially on older/smaller chains. Real, additive fallback layer, not a total replacement for a curated banner source.

### 2b. Block-explorer-cached CDN scraping — real, free, legally-gray fallback

Etherscan/Blockscout NFT tabs render a cached banner/thumbnail for many collections. Real free fallback for collections without `contractURI()`, but:
- Scraping a UI surface not designed as an API — brittle to markup changes, and Etherscan's ToS restricts automated scraping without their (paid/rate-limited) API.
- Recommend treating this as a **manual/one-off curation aid** (internal admin tool for filling gaps on high-traffic collections) rather than an automated production pipeline.

### 2c. Social-graph (Farcaster) sourced images — real but narrow

Farcaster's open Hub network occasionally has NFT-collection-linked casts/frames with images, but this is unreliable, sparse coverage, and would require an entire association-and-moderation pipeline to verify a cast represents the *official* collection. **Not recommended** — cost/complexity disproportionate to coverage gained versus 2a.

### 2d. Community-sourced/curated — real, standard practice, cheapest path for remaining gap

For the residual set of collections with neither `contractURI().banner_image` nor a usable explorer-cached image: a simple admin-curation table (collection address → banner URL, populated manually or via a lightweight submission form) is the honest, standard approach every marketplace (including OpenSea itself, originally) uses to backfill pre-standard collections.

### 2e. What's NOT achievable

A marketplace's own **curated/verified** banner choice (specific crop/version chosen by their internal curation team or the project's verified profile settings) is inherently off-chain and proprietary — no on-chain equivalent, no legitimate way to retrieve *their specific* asset without hitting their API. `contractURI()` gets you *a* banner the project itself published on-chain (often the same image), not necessarily OpenSea's cropped/optimized version.

---

## 3. Other Struggling Data Points

### 3a. Rarity ranking — REAL, fully computable in-house once metadata is hydrated, zero external dependency

Once `onchain-contract-reads.ts` has hydrated `tokenURI()` metadata (trait/attribute JSON) across a collection's supply, rarity ranking is pure local computation — no vendor needed, ever:

- **Trait Rarity (rarity.tools formula)**: `score(trait_value) = 1 / (count_of_items_with_trait_value / total_supply)`; sum per-token across all its traits for a token-level score. Published, widely-adopted formula; open-source reference implementation exists (`fukuball/rarity-analyser`, MIT-licensed).
- **Statistical Rarity**: multiply per-trait probabilities instead of summing inverse-frequency scores — documented alternative, useful as a secondary "probability of this exact combination" ranking.
- Refs: [rarity.tools formula explainer](https://medium.com/coinmonks/rarity-tools-measure-how-rare-your-nft-is-93c244b05f02), [fukuball/rarity-analyser](https://github.com/fukuball/rarity-analyser), [Rara Avis statistical rarity methodology](https://www.raraavis.dev/methodology).
- **Honest caveat**: only works once *complete* trait metadata is hydrated for the *whole* collection (partial hydration skews frequency counts). For large or slow-to-hydrate collections, gate rarity display behind a "fully indexed" flag or ranks will shift misleadingly as more tokens hydrate.

### 3b. Holder count/distribution — REAL, already substantially covered by existing infra

Direct `Transfer` event log scanning (already the backbone of the existing HyperSync/Seaport-backfill infra) trivially yields current holder set and distribution: replay `Transfer(from, to, tokenId)` per collection, maintain a running owner map, holder count = distinct non-zero `to` addresses with balance > 0. No new vendor needed; remaining work is exposing distribution stats (top-10 concentration, unique-holder/supply ratio) as a computed view. Flag as "wire up, don't build."

### 3c. Volume/sales history — REAL, same event sources as §1b, already largely in scope

Sales history is the same `OrderFulfilled`/`TakerAsk`/`TakerBid`/Blur `Execution` fill events from §1b, joined to the matching `Transfer` event in the same transaction to attribute a sale price to a specific token ID. Standard "sale = Transfer + matching payment log in same tx" reconciliation, exactly what Reservoir and every other NFT indexer does — natural extension of infra already built for the Seaport backfill.

---

## Summary Table

| Data point | On-chain/free path | Status | Confidence |
|---|---|---|---|
| AMM liquidity floor | sudoswap `spotPrice()`, NFTX v3 vault AMM price | Buildable now, thin coverage | High (real, narrow) |
| Realized-fill floor | Seaport/LooksRare/Blur fill-event log scan | Extends existing Seaport-backfill infra | High |
| Listed floor / listed count (curated) | — | **Not achievable** (off-chain order book) | N/A — be honest |
| Mempool listing signals | — | **Not worth building** (listings aren't in mempool) | N/A |
| Banner image | `contractURI()` per ERC-7572 | Buildable now, partial coverage (opt-in standard) | High for new collections, gaps on legacy |
| Banner fallback | Explorer CDN scrape | Fragile/ToS-gray, manual aid only | Low as automated pipeline |
| Banner fallback | Community curation table | Cheap, standard industry practice | High (unglamorous but real) |
| Banner fallback | Farcaster social graph | Not recommended, poor ROI | Low |
| Rarity ranking | Local compute over hydrated trait metadata | Buildable now, zero vendor | High |
| Holder distribution | `Transfer` log scan | Likely already mostly built | High |
| Volume/sales history | Fill events + matching `Transfer` | Extends existing infra | High |
| Marketplace's own curated business logic (floor/curation choices) | — | **Not achievable, inherently off-chain** | N/A — be honest |

**Bottom line**: the two highest-leverage, lowest-effort, standards-backed wins are `contractURI()`/ERC-7572 for banners (near-zero marginal cost given existing URI-resolution code) and realized-fill-price scanning across Seaport + LooksRare + Blur contracts for a triangulated floor (extends existing Seaport-backfill/HyperSync infra). AMM-pool floor (sudoswap/NFTX) is a real bonus signal but only for the minority of collections with pool liquidity. Curated listed-count, marketplace-internal floor curation, and mempool-based listing discovery are honestly not recoverable without going back to a vendor API, and this spec does not force a fake solution for them.
