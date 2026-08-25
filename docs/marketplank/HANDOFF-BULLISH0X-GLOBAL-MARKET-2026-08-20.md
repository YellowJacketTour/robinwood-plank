# Handoff: Global Market + rarity + listings (bullish0x / bot harnesses)

**Branch:** `dev` at `9e211e8` (and follow-ups on the same branch).  
**Repo:** `YellowJacketTour/robinwood-plank`.  
**Home collection:** RobinWood NFT `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156` on Robinhood Chain `4663`. Native UI is `/market`. Global hub is `/market/multichain`.  
**This document is the intent map.** Code is source of truth; if they disagree, fix the code and this file together.

### Bullish0x engagement (do not skip)

Matches `CONTRIBUTING.md` and the 2026-08-20 multichain handoff:

- **`master` deploys to InMotion / public prod.** Do **not** merge `dev` → `master` for this work. Global marketplace is **not** going public yet.
- **`dev` is the integration branch.** This session pushed here under time pressure (same exception as the other 2026-08-20 handoff). Next code change: `git switch -c <type>/<short-description>` off `origin/dev`, PR with **`base: dev`**.
- Merging `dev` into `master` remains **bullish0x’s explicit release decision**.
- Prod host (`plank.tanggang.life`) will stay on whatever SHA is on `master` until that decision. Verify this stack on **local `npm run dev`** (operator used `http://localhost:3800`) or any private preview — not by shipping.

**Review without shipping:** [compare `master`…`dev`](https://github.com/YellowJacketTour/robinwood-plank/compare/master...dev) · [tree at `dev`](https://github.com/YellowJacketTour/robinwood-plank/tree/dev)

Nothing here requires the original operator’s laptop for *code*. Keys for live indexers live in InMotion env / `.env.inmotion.example` **after** a future master deploy. Until then, local `.env.local` / `.env.docker.local`. Cron: `scripts/refresh-market-data.ts`. Tests: `node --import tsx --test test/market/*.test.ts`.

---

## 1. Vision (what “totality” means)

One marketplace surface for **every chain, every collection, every piece**:

| Capability | Native RobinWood `/market` | Foreign `/market/multichain/:chain/:slug` |
|---|---|---|
| Full catalog | Gallery + indexer | Rarity table / tokens route (JIT) |
| Listings overlay | Seaport book | Venue book (OpenSea / ME / UniSat) |
| Rarity | `lib/rarity.ts` −log2 on Base/Background/Holo | `lib/rarity-generic.ts` same kernel, adaptive traits |
| Buy | Seaport 1.6 native | OpenSea fulfillment_data / ME buy_now / UniSat auctionId |
| Sweep / bid-by-criteria | Native | ForeignOfferForm + trait index |
| Instant Swap / vaults | V3 vault | **Later** (banner only; do not fake) |

**Honesty rules (non-negotiable):** fail closed; never fabricate floors, names, images, ranks, holder counts, or 24h volume. `—` with `emptyCellReason` is correct when there is no source. `0` is only allowed when we **counted** zero live listings, not as a DB default.

Hover mega-menus on `/market` are forbidden (a11y, DESIGN.md). Alchemy NFT API is **off** (monthly 429 cap).

---

## 2. Why RobinWood vanished from Robinhood rankings (gatekeeping)

Three independent filters, not one bug:

1. **Architectural split.** Native book is `lib/market/seaport.ts` + `orders-store.ts` + `MARKET_COLLECTIONS` slug `robinwood`. Global hub reads `plank_multichain_collections` + snapshots. RobinWood was only a **Home chain banner** (`GlobalMarketHub.tsx`), “deliberately excluded from FOREIGN_CHAINS.”
2. **OpenSea Robinhood scan** (`opensea-robinhood-scan.ts`) registered ~477 ERC-721s with names/images, **no floor/volume snapshots**. Table showed `Listed: 0` and Grade `—`.
3. **Default hub filters:** “Has real artwork” + hide shells (`!hasMarketEvidence`). Evidence = floor **or** listedCount>0 **or** 24h volume/sales. Scan rows failed that, so Robinhood-only looked empty.

**Fix on `dev`:** `GET /api/market/multichain` **injects** a native RobinWood row from `getListings("robinwood","robinhood")` (real floor + listed count). `isNativeHome: true` → cards/table link to `/market`. Duplicate contract is stripped. `listedCount === 0` with no floor and no volume is serialized as **`null`** (dash), not fake zero. Robinhood-only filter skips art/shells gates so named scan rows still appear.

**Same class of gate on every chain:**

| Gate | Symptom | Fix direction |
|---|---|---|
| Default `onlyArt` | Empty Avalanche/Robinhood if `imageUrl` null | Don’t require art for identity rows; never invent JPEGs |
| `!showShells && !hasMarketEvidence` | Rankings skip unsynced contracts | Keep shells off by default **except** when the user filtered to that chain |
| Hub vs native store | Home collection missing from table | Inject native stats; don’t copy native Seaport into OpenSea |
| Snapshot `listed_count = 0` default | Cells look “scrubbed” | Treat unsynced 0 as null |
| First-pass rarity cap | 5k of 10k; empty map never re-enqueued | Resume when sampleSize ∈ {1000,2000,5000} |
| ME listings `limit=20` | Banner 161 vs floors 20 | Page `offset` up to 200 |
| Tokens from ME listings | All items = listed only | Catalog from `plank_foreign_rarity` |
| Solana slug vs mint | Helius grouping on `Claynosaurz` = 0 | Resolve ME symbol → collection mint, dual-write |
| Alchemy forbidden | No holders on many EVM rows | ME uniqueHolders / OpenSea stats / on-demand only |

---

## 3. Chain enumerators (rarity + catalog)

`lib/market/multichain/rarity-index-runner.ts` → `rarityIndexBackend()`:

| `chainSlug` | Backend | Notes |
|---|---|---|
| `solana-mainnet` | Helius `searchAssets` grouping | Resolve mint via ME listings + DAS `grouping.collection`. Cap 12k. Dual-write mint + symbol. |
| `bitcoin-mainnet` | UniSat activity log | **Always partial.** No full inscription walk. |
| `avax-mainnet` … OpenSea EVM | OpenSea NFT walk | `openSeaChain` in `foreign-chain-registry.ts`. Polygon alias `matic`/`polygon`. |
| `zksync-mainnet` | none | `openSeaChain: null` — unranked, fail closed |
| `robinhood` | native `lib/rarity.ts` | Not this runner. Hub row is listings-derived. |

**On-demand:** `GET /api/market/multichain/rarity` enqueues `indexRarityForCollectionLookup` if map empty **or** stale first-pass (1k/2k/5k), except Bitcoin. In-flight `Set` prevents stampede.

**Cron (InMotion, not a laptop):** `scripts/refresh-market-data.ts` steps include `scaffold-rarity`, `scaffold-rarity-solana`, `scaffold-rarity-bitcoin`, `discover-*`, `coingecko-solana-stats`, `coingecko-bitcoin-stats`. Full 15k-row completeness is **not** claimed until those jobs have run in prod.

**Kernel:** `informationContent = -log2(count/N)`. Official Background-like trait when detected; spam serials excluded; zero-score → Common; competition ranks. Unindexed listed tokens: `scoreTokenAgainstTraitIndex` vs trait index.

**Tests:** `test/market/rarity-generic.test.ts`, `rarity-index-dispatch.test.ts`, `solana-rarity-resolve.test.ts`, `marketplace-harness.test.ts`.

---

## 4. Listings / buy / verify

| Venue | Book | Buy | Verify |
|---|---|---|---|
| Marketplank native | `market_orders` | Seaport | Local book |
| OpenSea EVM | `listings/route.ts` | `fulfillment_data` + price/token assert | At fill |
| Magic Eden Solana | Paged `/v2/collections/{symbol}/listings` | `solana-buy-instruction` → Phantom | M2 SellerTradeState PDA from **collection escrow leads** (`solanaEscrow`), Helius RPC if `HELIUS_API_KEY` |
| UniSat BTC | auction list / OW turbo catalog | `auctionId` (not inscription id) | Key-gated |

**Claynosaurz listed discrepancy:** ME stats `listedCount` (banner) vs first page of 20 (rarity floors). Paging + `listedTotal` on `RarityFloorStrip` (`N of M listed` if book < venue total).

Do not enable Across / deBridge / 0x NFT pay-from-any-chain: receivers are **null**, flags off.

---

## 5. Wallets (no universal signer)

| Family | Connect | Used for |
|---|---|---|
| EVM | `connectWallet` / wallet-context | ETH, AVAX, Base, Arb, OP, BNB, Polygon, Robinhood, zkSync |
| Solana | Phantom (`non-evm-wallet.ts`) | ME buy/offer/list |
| Bitcoin | UniSat | auction bids |

Hub “Connect wallet” is EVM. Collection page switches Phantom/UniSat when `chainSlug` is SOL/BTC.

---

## 6. Env (prod / InMotion — not local-only)

See `.env.inmotion.example`. Required for this stack:

- `HELIUS_API_KEY` — Solana rarity walk + listing verify RPC  
- `OPENSEA_API_KEY` — EVM metadata/stats/listings (not Alchemy)  
- `UNISAT_API_KEY` — Bitcoin rarity + some buys  
- `MAGICEDEN_API_KEY` — Solana **trade** (buy_now/sell), not public listings  
- Postgres (`PG*`) — `plank_foreign_rarity`, `plank_multichain_*`, `market_orders`  
- `NEXT_PUBLIC_SOLANA_RPC_URL` fallback if no Helius  

Alchemy NFT must stay unused.

---

## 7. Bot harness (what to run in CI / on a worker)

```text
node --import tsx --test test/market/rarity-generic.test.ts
node --import tsx --test test/market/rarity-index-dispatch.test.ts
node --import tsx --test test/market/solana-rarity-resolve.test.ts
node --import tsx --test test/market/token-label.test.ts
node --import tsx --test test/market/solana-verify-listing.test.ts
node --import tsx --test test/market/marketplace-harness.test.ts
npx tsc --noEmit
```

Harness asserts: Helius for SOL, UniSat for BTC, OpenSea for AVAX+EVM, slug identity, buy fail-closed without `foreignOrderHash`.

**Live smoke (prod keys, not a laptop):**

1. Open `/market/multichain/solana-mainnet/Claynosaurz` — ITEMS ≈ indexed N; listings page toward ME listedCount; rarity floors not stuck at 20.  
2. Details → on-chain verify uses escrow query params.  
3. `/market/multichain?chains=robinhood` — **RobinWood** row #1 with real listed/floor from native book; click → `/market`. Other Robinhood names visible; volume cells may still be `—`.  
4. Do **not** merge `dev`→`master`. Local/dev-DB fullness ≠ prod.

### Local click paths (private; not the public host)

Replace host if the operator’s Next port differs (`3800` was live this session):

- Native book: http://localhost:3800/market
- Global hub: http://localhost:3800/market/multichain
- Robinhood-only rankings (RobinWood row + scan names): http://localhost:3800/market/multichain?chains=robinhood
- Claynosaurz (rarity ~10k, paged ME book): http://localhost:3800/market/multichain/solana-mainnet/Claynosaurz
- Claynosaurz all items: http://localhost:3800/market/multichain/solana-mainnet/Claynosaurz?show=all

Paste any of those (or a deployed **preview**, never `master`) back to the agent for a fetch. Public `https://plank.tanggang.life/…` is **old `master`** until bullish0x ships.

---

## 8. Taking it to totality (ordered, no fantasy)

### Hub ranking completeness (ETH-like cells)

Unfiltered Ethereum looks “complete” because those rows already had an OpenSea stats snapshot. Optimism/Avalanche often have **floor only**. Visible-page hydrate (`POST /api/market/multichain/hydrate-stats`, 8 contracts):

| Chain | Primary (keyless where possible) | Fallback |
|---|---|---|
| ETH/Base/OP/Arb/Polygon/BNB/Avax | CoinGecko `GET /nfts/{platform}/contract/{address}` | OpenSea `/stats` + `num_owners` |
| Solana | Magic Eden `/v2/collections/{symbol}/stats` (keyless) | CoinGecko platform `solana` |
| Bitcoin | CoinGecko `ordinals` slug match (existing cron) | UniSat floor only |
| Robinhood native | `getListings("robinwood")` | never OpenSea for the home collection |

Holders stay `—` unless CoinGecko unique addresses or OpenSea `num_owners` returns. Alchemy NFT stays off.

1. Cron `scaffold-rarity*` + OpenSea `/stats` for Robinhood scan rows that have slugs (cells fill **only** after a real pass).  
2. Persist `partial` (`031_foreign_rarity_partial.sql` if applied) instead of inferring 5k.  
3. Native 24h volume/sales/holders for RobinWood from chain-indexer / rarity sample — still no Alchemy.  
4. Bitcoin full-collection attributes if a real enumerator exists; until then partial.  
5. Foreign Instant Swap / Across — **after** receivers are deployed and audited.  
6. External audit of Seaport path + ME M2 + UniSat — this repo has internal notes, not a third-party report.

**Do not:** invent grades A for JPEG-only; treat listed 0 as a real book; hover-dropdowns on `/market`; use Alchemy NFT; assume 15,365 collections are all rarity-indexed.

---

## 9. Key files

- `lib/rarity.ts` / `lib/rarity-generic.ts`  
- `lib/market/multichain/rarity-index-runner.ts`  
- `lib/market/multichain/discovery/helius-rarity-index-runner.ts`  
- `lib/market/multichain/discovery/unisat-rarity-index-runner.ts`  
- `app/api/market/multichain/route.ts` (native RobinWood injection)  
- `app/api/market/multichain/rarity/route.ts`  
- `app/api/market/multichain/listings/route.ts`  
- `app/api/market/multichain/solana-verify-listing/route.ts`  
- `app/api/market/multichain/solana-buy-instruction/route.ts`  
- `components/market/GlobalMarketHub.tsx`  
- `components/market/MultichainCollectionView.tsx`  
- `lib/market/multichain/trading/foreign-fulfill.ts`  
- `scripts/refresh-market-data.ts`  
- `test/market/marketplace-harness.test.ts`
