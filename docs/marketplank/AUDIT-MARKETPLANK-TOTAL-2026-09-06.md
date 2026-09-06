# AUDIT: Marketplank total -- every collection, piece, listing, venue, wallet wiring, purchase path, metadata, trait and rarity solution

Owner directive (2026-09-06): "deeply audit all of our solutions for marketplank across all collections, all pieces,
all listings from all discoverable marketplaces and dapps and aggregators, all wallet wirings and market purchasing
features, all collection metadata discoveries and traits and rarity solutions such that these kinds of shortcomings
to our perfect vision cannot exist."

Method: six independent Fable-5.1 audit lenses, each read-only against the real code at the commit deployed to
production that day, each reporting `MODEL SELF-REPORT` on its first line (all six reported Fable 5.1). Findings are
file-anchored with a failure scenario and a fix. The owner's own live observations that day (hub blank, collections
not opening, 3.12% traits on BAYC, 1,567 Arbitrum rows with 15 floors) are the calibration set: every one of them is
explained by a finding below.

Fix log at the end records what was closed in the same session.

# LENS 1 -- Discovery and catalog completeness

## 1. Per-chain pipeline table

Cadence facts that drive everything below (docs/INMOTION_DEPLOYMENT.md:592,630): prod runs `refresh-market-data.mjs` every 2 min (non-`--full`) and the mesh scheduler under `flock -n`. The matrix (`lib/market/multichain/mesh/matrix.ts`) expands to ~116 lanes (7 lanes x 8 HyperSync chains + 2 x 7 OpenSea chains + 9 CoinGecko + 37 singles), each with sliceSec 60-180. At concurrency 6 one pass is ~45-50 min, so **every per-chain lane fires roughly once per ~48 min** (worse at the production in-process concurrency of 3). `other-chains-discovery-pass.mjs` (the only caller of `runMagicEdenCatalogScan`) is a local-dev supervisor and is not in the prod cron.

| Chain | Discovery | Floor | Volume / sales | Listed | Holders | Gap |
|---|---|---|---|---|---|---|
| eth-mainnet | hypersync-discovery (10 blocks/pass, `hypersync-evm-scan.ts:107`), hypersync-backfill, opensea-bulk (refresh, 80 pages/2 min), evm-log-scan (Alchemy), CG catalog upsert | OS stats lane 20/pass (`mesh-lane.ts:221`) + refresh 3/chain/2 min; Alchemy adapter (skipped when jailed); CG 15/pass | OS intervals; Seaport/Wyvern/Blur/X2Y2/Foundation/Sudoswap/Rarible/CK fills | OS listings walk (null if truncated) | OS `num_owners`; Alchemy owners on detail view | Best-covered chain; still ~7/343 floors missing |
| polygon / opt / bnb / base | same as ETH minus the 7 ETH-only venues; forward scan **10/10/15/20 blocks per ~48 min** | same | OS intervals; Seaport fills **native-currency only** (`store.ts:491`) | same | same | Forward discovery falls behind chain head permanently; WETH-denominated fills excluded so `sales_24h` stays NULL and rows sink to the bottom of the sales-desc index |
| arb-mainnet | forward scan 800 blocks/pass, **no transfer threshold** (`hypersync-evm-scan.ts:527`) | same | same | same | same | Discovery volume >> stats capacity: 1,567 rows / 15 floors |
| avax-mainnet | 150 blocks/pass | same | same | same | same | same class as arb |
| zksync-mainnet | hypersync only | **none in matrix** (no OS chain, no CG platform, no `adapter:` lane for EVM); only refresh `multichain` step via Alchemy | Seaport fills (native only) | none | none | Structural: every zkSync row is a shell by design |
| robinhood | own scan + backfill + OpenSea robinhood list | native book + OS stats | Seaport fills + OS | native + OS | OS | OK |
| solana-mainnet | helius MplCore only (1 page/pass lane `mesh-lane.ts:115`; 5 pages/2 min refresh); ME exhaustive catalog **never runs in prod** | ME adapter (symbol rows only); helius rows **never** get a floor (`helius-solana.ts:149`); CG matches `contract_address == cg id` (`coingecko-nft-stats.ts:264`) so mint-address rows never match | CG only (symbol rows) | ME | ME / CG | 184 collections total = MplCore + ME top-N; legacy/pNFT long tail absent |
| bitcoin-mainnet | unisat list (1 page/pass; 2,625 total), ordiscan, ordinalswallet | unisat / OW adapters, CG | CG | unisat / OW | unisat / OW | Discovery fine; stats gated on UNISAT key |

## 2. Top 10 defects by user impact

1. **HyperSync forward discovery registers every contract with >=1 Transfer/TransferSingle log, no threshold, no metadata gate** -- `hypersync-evm-scan.ts:527,656,817` (`candidates = [...tally.entries()]`; `MIN_TRANSFERS_TO_CONSIDER` from evm-log-scan.ts:97 is only mentioned in the comment at :452, never applied) and `:153` upserts even when Alchemy returned no snapshot (`state: "partial"`). Scenario: one 800-block Arbitrum pass registers hundreds of ERC-1155 game/airdrop contracts as tracked collections; they then compete for the 20-per-pass OpenSea stats budget. This is the Arbitrum 1,567/15 number. Fix: filter `tally` by `MIN_TRANSFERS_TO_CONSIDER`, require >=2 distinct tokenIds for ERC-721, and defer upsert to a pending-candidates table until name/image resolve.

2. **Forward-scan chunk sizes cannot keep up with chain head** -- `hypersync-evm-scan.ts:106-115` (10 blocks/pass for eth/polygon/opt) x ~48 min lane cadence. Polygon produces ~1,400 blocks in 48 min; scanner advances 10. Cursor also starts at `height - 50_000` (`:476`), so the lane is permanently "backfilling" and never reaches `live` (`:538`). Fix: make the chunk time-budgeted (scan until sliceSec elapses or `MAX_LOGS_PER_RUN`), and use `maxNumLogs` overshoot as the bound rather than a fixed block count; or move discovery to the 2-min refresh tick.

3. **OpenSea stats cursor + ordering starves real collections** -- `opensea-stats.ts:436-448` selects rows with `c.id > afterId`, sorted junk-first (`name IS NULL OR name ILIKE '0x%'`), `LIMIT max(20*40,200)=800`, then writes `lastSeenId` (`:548`) as the new cursor. Junk rows with a cached `__none__` slug still match the WHERE (name stays NULL) and are `continue`d without counting toward `processed`. Scenario on Arbitrum: the 800-row window is entirely hex shells with `__none__`; `processed` stays 0; the cursor jumps to the highest junk id, skipping every real collection with a lower id; wrap only occurs when the query returns zero rows. Fix: exclude rows whose slug cache is `__none__` in SQL (persist the terminal state on the row, e.g. `opensea_slug_state`), order by `synced_at ASC` within the cursor, and never advance the cursor past unprocessed rows.

4. **`__none__` slug / stats-404 markers are permanent** -- `opensea-stats.ts:476` and `:495` write to KV with no TTL; `resolveOpenSeaSlug` returns null for 429/5xx/timeouts too (`:138-152`). Scenario: one rate-limited call during resolution marks a real Base collection `__none__` forever; it never gets a floor from OpenSea again. Fix: only cache `__none__` on a confirmed 404; give it a 7-day TTL; on non-404 failures return without caching.

5. **Seaport volume excludes every ERC-20-denominated fill** -- `store.ts:491` (`AND currency_token IS NULL`). On Polygon/BNB/Avalanche most Seaport orders are WETH/WBNB/WAVAX (manifest `offerCurrencySymbol` is WETH for all EVM chains). `sales_24h` therefore stays NULL, and since the hub index orders by `sales_24h DESC NULLS LAST` (`store.ts:906`), those chains are near-empty in the top-2000. Fix: count `sales` regardless of currency (sales are currency-agnostic) and sum volume only for `currency_token IS NULL OR currency_token = offerCurrencyAddress` (wrapped native is 1:1).

6. **Solana exhaustive discovery is not wired into production** -- `runMagicEdenCatalogScan` is called only from `scripts/other-chains-discovery-pass.mjs:32` (local supervisor); refresh's `discover-solana-collections` (`refresh-market-data.ts:688`) only walks MplCore; the `me:solana-mainnet` lane runs `hydrateSolanaFromMagicEden` (art only, `mesh-lane.ts:406`) despite advertising `floor/listedCount/holders` cells. 184 Solana collections is the result. Fix: add a `magiceden-catalog` MeshSource/lane calling `runMagicEdenCatalogScan({maxPages: 25})`, and add it to the refresh step list.

7. **Helius-discovered Solana rows structurally never receive a floor** -- `helius-solana.ts:105,120,149` return null floors; the sync loop writes that via `writeSnapshot` and bumps `synced_at` (green dot); CG matching for non-EVM uses `contract_address` (mint address) against CG `id` (slug) at `coingecko-nft-stats.ts:264` -- never equal. Fix: for helius rows, resolve the ME symbol via ME's collections-by-mint (or DAS `grouping` -> ME `symbol`), store it as an alias column, and route floor/listed through the ME adapter using the alias.

8. **A floor, once written, can never be cleared or expire** -- `store.ts:724` (`floor_price_wei = COALESCE(EXCLUDED..., old)`), `store.ts:530` (floor-only writer returns early on null), `sanitizeUnknownZeros` only scrubs `'0'`. Scenario: collection delisted from OpenSea/ME; adapter returns null; the old floor persists indefinitely and every partial writer (`updateCollectionSupplyFields` `:684`, holder writes) refreshes `synced_at`, so the hub shows a stale floor with a green "synced under 1h" dot. Fix: store `floor_observed_at` separately; when the authoritative source for `floor_price_marketplace` returns null/404, null the floor; render freshness from `floor_observed_at`, not `synced_at`.

9. **No per-chain "source unavailable" state reaches the hub** -- when the DAS pool has no provider (`solana-das-pool.ts:164` -> `helius-collection-scan.ts:53` throws), or `ENVIO_API_TOKEN` is unset, or Alchemy is jailed, the refresh step logs `ERR(...)` and the chain tab simply shows a small count as if complete. Fix: write per-chain lane health (`mesh/lane-health.ts` already exists) into the hub API response and render a chain-tab banner "discovery source X down since T / N rows pending stats".

10. **zkSync has no stats path at all** -- manifest `openSeaChain: null, coingeckoPlatform: null`; matrix has no `adapter:` lane for any EVM chain; the only floor writer is the refresh `multichain` step through Alchemy, which is skipped whenever the shared Alchemy jail is set (`sync.ts:125-127`). Every zkSync row is a permanent shell. Fix: either add a zkSync-native source (Element/zkMarkets API) or mark the chain `statsCapable: false` in the manifest and show that honestly instead of dashes.

## 3. Fabrication / overstatement

- **"24h change" derived from an unbounded-age previous floor** -- `app/api/market/multichain/route.ts:362-366` computes `floorChangePct` from `previous_floor_price_wei`, which `store.ts` only rotates when the prior snapshot was >20 h old with no upper bound. A floor from 3 weeks ago yields a number rendered as a 24h change. Fix: store `previous_floor_at` and only compute when it is within 20-30 h.
- **Freshness dot lies about floor age** -- `GlobalMarketHub.tsx:382` uses `snapshot.synced_at`, which every partial writer bumps (`store.ts:684`, holder writes, `writeSnapshotError`). `DataSourceChip asOf={c.syncedAt}` (`:2612`) same. See defect 8.
- **Empty-cell explanations are false for the current pipeline** -- `GlobalMarketHub.tsx:408-421`: Solana "no volume feed" (CG lane writes Solana volume), holders "loads the first time viewed" (Alchemy-jailed -> never), "real data lands on the next sync" for rows with a permanent `__none__` slug (never). These tooltips assert future data that will not come.
- **Bitcoin marked tradeable against the code's own comment** -- `route.ts:326-341`: comment says Bitcoin must be FALSE (UNISAT key-gated, returns 503), code includes `isBitcoinChainSlug`. Buy affordance shown for a chain the deployment cannot fulfill.
- **CoinGecko floors have no plausibility ceiling** -- `coingecko-nft-stats.ts:206` `toWeiString` lacks the `MAX_PLAUSIBLE_FLOOR` bound that opensea-stats.ts:37 and alchemy-nft.ts:231 enforce; a bad CG value is written verbatim as the collection floor with `floor_price_marketplace = "coingecko"`.
- **Alchemy batch floor currency is asserted, not sourced** -- `alchemy-nft.ts:415-421` labels `openSeaMetadata.floorPrice` with the chain's gas token (POL/BNB/AVAX); Alchemy's field carries no currency, and OpenSea Polygon floors are frequently WETH-quoted. USD conversions on the hub then use the wrong symbol. Prefer opensea-stats' `floor_price_symbol` and drop the Alchemy floor when the two disagree.
- **Hero/mover tiles bypass the zero guard** -- `GlobalMarketHub.tsx:2094,2598` use raw `floorPriceWei` rather than `displayFloorWei`; a `"0"` that slipped past `sanitizeUnknownZeros` renders as a real 0 floor.
- **Lane cells overstate what lanes write** -- `matrix.ts` `me:solana-mainnet` claims `floor/listedCount/holders` but the handler only hydrates name/image; `unisat:bitcoin-mainnet` claims floor/listed/holders but runs `backfillUnisatCollectionArt(6)`. Anything reading lane cells for coverage reporting will over-report.

# LENS 2 -- Listings and offers from every venue

## 1. Matrix: chain x venue (what the collection page actually reads)

Listings grid = `GET /api/market/multichain/listings` (`app/api/market/multichain/listings/route.ts`), polled by `components/market/MultichainCollectionView.tsx:596-627,712` every 20 s (swr ttl 8 s / stale-serve 45 s). Offers = `offers/route.ts`, fetched once per mount/action (`MultichainCollectionView.tsx:859-874`, ttl 15 s / stale 90 s, no timer). The only staleness labels anywhere on listings are: "OpenSea rate-limited, retrying" (`:180`), "refreshing..." when `bookCoverage.partial` (`:2026`), "<venue> not connected" for credential-missing (`:201-209`). No listing or offer carries an observed-at timestamp.

| Chain | Venue | Listings source | Offers source | Refresh | Staleness label |
|---|---|---|---|---|---|
| eth / polygon / arb / base / opt / bnb / avax | OpenSea (Seaport 1.6) | live REST `/listings/collection/{slug}/all`, single page, no cursor (`foreign-orders.ts:347-370`; `listings/route.ts:689`) | live REST `/offers/collection/{slug}` limit<=50 (`offers/route.ts:121`) + Marketplank-native DB rows (`:213`) | 20 s poll, uncached | none except 429 label; grid is emptied on 429 (`listings/route.ts:816-824`, client `:621-624`) |
| same | OpenSea Stream (WS) | `item_listed` folded to a floor observation only for tracked collections (`opensea-stream.ts:300-304,316-342`); never becomes a listing row | `bid-created` skipped (`:305-313`) | continuous, 2 s flush | none; observations table has no reader on the collection page (only `getObservedFloorChange24h` for RobinWood, `app/api/market/multichain/route.ts:201`) |
| same | Marketplank-native (own Seaport book) | DB (`native-orders/route.ts:115`) -- NOT merged into the collection listings grid (EVM branch of `listings/route.ts` returns OpenSea only) | DB, merged into offers (`offers/route.ts:213-233`) | on demand | none |
| eth-mainnet | Blur / LooksRare / X2Y2 / Rarible / Foundation | none (fills only, `venue-registry.ts:32-84`) | none | n/a | n/a |
| eth-mainnet | Sudoswap | pools/fills only via `sudoswap-pools/route.ts`; no pool ask surfaced in grid | none | | |
| eth-mainnet | CryptoPunks native | on-chain projection, public offers only (`native-market-adapters/cryptopunks.ts:51`) | none (bids "remaining lane", `venue-registry.ts:31`) | sync job; s-maxage 10 | none |
| any EVM | Zora, Mintify, Magic Eden EVM, Element, OKX EVM | none | none | | |
| zksync | anything | none (`openSeaChain:null`, `foreign-orders.ts:356`); native book only | native only | | |
| robinhood | native + PulpMarket + OpenSea | DB + Pulp REST + OpenSea cursor walk with cached fallback (`listings/route.ts:251-303`) | native DB only (`offers/route.ts:60-91`) | 20 s | `bookCoverage.partial` -> "refreshing..." |
| solana | Magic Eden | keyless REST `/v2/collections/{symbol}/listings`, singleflight soft 15 s / hard 2 min (`listings/route.ts:414-441`) | none (`offers/route.ts:102-104`) | 20 s poll over 15 s cache | none; "Making offers isn't available" text only |
| solana | Tensor | scanned on-chain into `tensor_onchain_listings` (`discovery/tensor-listing-scan.ts:246`) but NEVER read by the listings route; only Tensor settlements reach activity (`activity/route.ts:259-261`) | none | scan throttled | n/a (invisible) |
| bitcoin | UniSat | keyed REST, limit<=20 (`listings/route.ts:515-516`), 15-min durableKv cache served silently on upstream error (`solana-bitcoin-listings.ts:130-139`) | none | 20 s | none for the 15-min stale fallback |
| bitcoin | Ordinals Wallet | keyless catalog escrow prices, display-only (`listings/route.ts:530`, `foreignOrderHash` undefined) | none | 5-min in-proc cache | none |
| bitcoin | ord.net | wallet-session-gated cursor read (`:519`) | none (offers API documented, not wired; `venue-registry.ts:251-254`) | 20 s | "not connected" |
| bitcoin | Satflow / OKX | key-gated REST, [] without key (`satflow-ordinals.ts:57`); floor-only fallback when everything empty (`listings/route.ts:594-613`) | none | 20 s | "credential-missing" note only for unisat/ordinalsWallet/ordnet keys (label map `:203` omits satflow/okx -> renders raw key) |
| bitcoin | Magic Eden Ordinals, Ordiscan listings, Gamma, Ordzaar, BestInSlot | none (Ordiscan is floor-only, `ordiscan-ordinals.ts:84-93`) | none | | |

Offers coverage in one line: the offers table holds OpenSea + Marketplank-native on 7 EVM chains, native-only on Robinhood/zkSync, nothing on Solana or Bitcoin.

## 2. Top 10 gaps/defects by user impact

1. **Foreign-EVM listings are priced as if every consideration leg is the chain's native token.** `listings/route.ts:781-783` and `:717-725` sum `consideration[].startAmount` with no check of `item.token`/`itemType`. OpenSea `/all` returns WETH-, USDC-, POL-priced listings. A 5 USDC listing on Polygon shows as "0.0000" with a Polygon icon and wins "cheapest" dedup and the "Floor" badge (`MultichainCollectionView.tsx:1946,2662`). Same bug in the Robinhood merge path `lib/market/opensea.ts:475-483`. Fix: filter to `itemType 0` native (or carry `currencyAddress`/`decimals` on `Listing` and render it); reject mixed-currency rows from floor/cheapest math.
2. **OpenSea `/all` is read as one page; collections with >100 listings are silently truncated.** `foreign-orders.ts:363` passes `limit` (client asks 200, `collection-surface.ts:26`) but OpenSea caps at 100 and returns `next`; no cursor loop. No `bookCoverage.partial` flag on the EVM branch (`listings/route.ts:807-813`). Fix: walk `next` up to `limit`, return `bookCoverage.complete=false` when truncated.
3. **Marketplank-native listings on foreign EVM chains never appear in the collection grid.** EVM branch returns OpenSea rows only (`listings/route.ts:647-813`); native rows exist in the DB and are served by `native-orders/route.ts:115` and merged for offers (`offers/route.ts:213`) but not for listings. Fix: merge `getListings(chain:addr)` with venue undefined, dedup cheapest per token.
4. **Tensor listings are indexed but invisible; Solana shows Magic Eden only.** `tensor-listing-scan.ts:246` writes `tensor_onchain_listings`; the Solana branch (`listings/route.ts:390-494`) never reads it; no Tensor executable path (`parity-matrix.ts:120-138`). Fix: read the table into the Solana branch with `venue:"tensor"`, View-only until a fill path exists.
5. **OpenSea wildcard (criteria-root 0) collection offers are marked acceptable and get an Accept button, contradicting the module's own contract.** `offers/route.ts:147` sets `acceptable: true` for `identifierOrCriteria === "0"`; UI `MultichainCollectionView.tsx:2965` shows Accept; `acceptForeignOffer` (`foreign-offer.ts:207-232`) says it is "deliberately limited to token-specific offers". Fix: reconcile -- record a real fill or set `acceptable:false` for criteria.
6. **Currency labels are per chain, not per row.** `nativeCurrencySymbol` (`foreign-chain-registry.ts:158-164`) returns "WETH" for every EVM chain including Polygon (native POL); `statCurrencySymbol` (`:1995`) feeds both listings and offers. Polygon native-priced listings are labelled WETH and USD-converted at the ETH price. Fix: currency per row (see #1).
7. **Stream floor state mixes currencies and ignores cancellations/auctions, then never reaches the page.** `opensea-stream.ts:321-325` picks lowest `amountAtomic` across all payment tokens (a 6-decimal USDC ask always "wins"), ignores `listing_type` (auction start price treated as ask) and `expiration_date`; cancellations are skipped (`:305-313`). `recordFloorObservation` writes only `plank_collection_floor_observations`, which nothing on the collection page reads. Fix: filter native/WETH by chain, honour `listing_type`, apply `item_cancelled`, and read observations into the header or upsert the snapshot.
8. **UniSat 15-minute stale cache is served as live with no flag.** `solana-bitcoin-listings.ts:130-136`; `listings/route.ts:632` reports `unisat: "queried"`. Also `Math.min(limit, 20)` (`:516`) caps UniSat at 20 rows with no partial flag. Fix: return `{rows, stale:true, observedAt}` and surface it.
9. **Bitcoin cheapest-wins dedup can hide the only executable listing.** `listings/route.ts:616-620` keeps the cheapest row per inscription regardless of venue; display-only venues can replace the Buy card with a View link. Fix: prefer executable rows on ties/near-ties, or keep both.
10. **Offers on Solana and Bitcoin are hard-coded empty and the UI text implies only placing offers is missing.** `offers/route.ts:102-104` returns `[]`; UI `:2871-2878`. Magic Eden per-token `offers_received`, M2 buyer trade states, Tensor bids, ord.net offers all exist and are unread. Fix: per-token ME offers for listed tokens; label "Offers not indexed for this chain".

Also: `bookCoverageNote` label map (`MultichainCollectionView.tsx:203`) lacks satflow/okx; Robinhood `expiresAt: null` OpenSea rows get a far-future sentinel (`opensea.ts:492`); EVM grid card `title` claims "A 1.8% Marketplank fee is added" (`ListingCard.tsx:296`) while parity says tip logic is fork-proven only (`parity-matrix.ts:85`).

## 3. Listings shown but not executable, or in the wrong currency

- Foreign-EVM OpenSea listings priced in ERC-20 (WETH/USDC/DAI): shown with native icon and 18-decimal formatting, Buy button present (`lib/market/types.ts:181-189`); `assertForeignOrderMatchesExpectation` (`foreign-fulfill.ts:186-230`) checks total but not currency. `listings/route.ts:778-801`.
- Bundle/multi-item Seaport orders: only `offer[0]` is read (`:715,779`); a 2-token bundle shows as one token at the bundle price.
- ERC-1155 quantity ignored: `startAmount` of the offer item is never read; a 10x listing shows as one unit at the 10x price.
- Solana Magic Eden rows: Buy button shown, but `MAGICEDEN_API_KEY` is "never provided" (`parity-matrix.ts:57`); `magiceden-solana-trade.ts:78-81` throws at click.
- Ordinals Wallet / ord.net / Satflow / OKX rows: View-only by design; Satflow `externalUrl` points at the collection page, not the inscription (`listings/route.ts:561`); Satflow/OKX `maker: "unknown"` (`:555,574`).
- Polygon: native POL-priced listings labelled "WETH" and USD-converted at ETH price.
- CryptoPunks: correct (private `onlySellTo` offers excluded, `cryptopunks.ts:51`).
- Stream-derived floors: currency-mixed and auction-contaminated, though currently unread on the page.

# LENS 5 -- Hydration engine and the edge

## 1. Starve / duplicate / run-twice / lease-leak / false-success / enqueue-forever

**A. Timed-out in-process lane keeps running -> job finished, released, reclaimed, runs twice.** `scripts/mesh-tick.ts:158-182` `withTimeout` resolves `1` but cannot cancel the promise. `:202-207` in-process lanes get 120s; `:333` releases the OpenSea semaphore; `:347` `finishDataJob(...,"lane exited 1")` clears the lease. The lane body is still executing: still holding pool connections (PGPOOL_MAX=4), still burning OpenSea pace slots, and the job is now `failed` and re-enqueuable by any demand ping -> second concurrent execution of the same subject. No AbortSignal is passed to any lane.

**B. Standing lanes now run once per HOUR, not every 5 min.** `scripts/mesh-tick.ts:259-291` enqueues the 49 `mesh:<lane.id>` jobs only at process start. The always-on change (`--max-seconds=3300` under `flock -n`) means the process lives ~55 min, so seaport-fills / discovery / fills-reconcile get exactly one claim per hour.

**C. Two general workers exit on first empty claim; express worker holds the flock for 55 min.** `mesh-tick.ts:314` `if (!job) break;` for non-express workers; `:310-313` express loops until `claimDeadline`. Once the general workers see an empty claim, only priority >=118 work is served until the hour ends.

**D. Express-lane threshold is unreachable for most clicks.** `demand-bus.ts:57` click base = 118; `:94-96` cost penalty -1 per 50 units; `estimateRefreshCost` (`:154-162`) for an incomplete EVM collection = 221 -> -4. Watchers +2. A click on a recently-synced incomplete collection = 118+2+0-4 = **116 < 118** (`mesh-tick.ts:303`). Express lane idles while the click job waits.

**E. Sleep-inside-lane + immediate re-enqueue = a slot pinned to a sleeping job.** `scripts/mesh-lane.ts:91-93` (jailed demand job: sleep 30s, `markIncomplete`) and `:314-316` (pool busy / "no OpenSea slug": sleep 8s, `markIncomplete`). `mesh-tick.ts:346-356` re-enqueues with `not_before = LEAST(existing, now)` (`control-plane.ts:143`) -> immediately claimable again. `not_before` can never be pushed forward through `enqueueDataJob`, so "retry later" is impossible by design.

**F. Infinite loop for slug-less collections.** `mesh-lane.ts:305-317` treats `no OpenSea slug` as transient; re-enqueues every 8s until the process ends, `attempts` climbing without bound.

**G. Marked succeeded without doing the work:** `mesh-lane.ts:484-504` any 429/403/quota error returns normally -> exit 0 -> `succeeded` (and no jail for `OPENSEA_POOL_SOURCES`); `:481` unknown source -> exit 0; `:117-119, 236-238, 242-244, 268-270` `helius-membership`, `unisat-rarity`, `unisat-membership`, `magiceden-solana` ignore `subject` and advance "next tracked" -- every Solana/Bitcoin demand job is marked succeeded after hydrating some *other* collection; `opensea-key-pool.ts:295` `BACKGROUND_SKIP_RATE=0.95` -> background OpenSea lanes return null 95% of attempts, exit 0 -> succeeded, no work.

**H. `markIncomplete()` in script mode is infinite recursion.** `mesh-lane.ts:27-31`: `getStore()` undefined when `main()` runs directly -> `else markIncomplete()` -> RangeError. The spawned-child exit=2 path is dead; only in-process mode works.

**I. Lease leak on worker crash.** `mesh-tick.ts:309` `claimDataJob` throws on pool `connectionTimeoutMillis` (10s) under saturation -> worker dies; `Promise.all` rejects main; leases held by other in-flight jobs recovered only by the sweep at `control-plane.ts:172-174`, which runs only on a *claim*. `pool.end()` skipped on the reject path (`:401-404`).

**J. Duplicate work across job families.** Background `opensea-membership` and a demand job for the same contract can walk the same collection concurrently; no subject-level lock.

**K. Telemetry undercount.** `enqueueDataJob` sets `completed_at = NULL` (`control-plane.ts:146`) on exit=2 re-enqueue, so `queue-telemetry.ts:29` never counts partial completions.

**L. `demoteStaleVisibleDemand` clobbers click/sweep priority.** `collection-demand.ts:560-566` demotes every `demand:%:chain:key` job to 50 if the viewport row is >5 min old -- including a click (118) or sweep (124) intent published seconds ago.

## 2. Throughput model

Per job overhead ~6 DB round trips (claim txn 4, lane-health claim/outcome, finish). Lane time dominates: opensea-stats bg 53s at 7 keys, >120s at <=3 keys (hits timeout A); opensea-membership demand 10-50s; evm-metadata 45s loop with `Promise.all` over 25 tokens -> pool saturation; HyperSync lanes 5-60s; jailed skip / pool busy 30s / 8s of zero work. Effective workers = 2 (express idles). Mean lane 30-45s -> **2.5-4 jobs/min ceiling**, realistically ~2. 820 queued = 4-7 h if nothing re-enqueued; standing lanes + partials mean the queue never drains.

Five changes, largest first: (1) thread an `AbortSignal` through `runMeshLane`, abort on timeout, then split pools: 2 OpenSea-bound slots + 3-4 HyperSync/RPC/PG-bound slots (~2-3x); (2) per-collection -> per-batch stats; skip display for imaged rows and drop `fetchOpenSeaListedCount` where the stream has a floor <10 min old (3 calls -> 1); (3) `deferDataJob(id, notBefore)` bypassing the `LEAST()` ratchet: jailed -> `not_before = jail_until`, pool busy -> +8s; (4) re-enqueue standing lanes inside the pass every `sliceSec`, not at process start; (5) batch the queue protocol (claim N per txn, fold lane-health into claim/finish, sweep expired leases every 30s not per claim) and make `evm-metadata` use `p-limit(4)` instead of `Promise.all(25)`.

## 3. Stream worker risks (`lib/market/multichain/edge/opensea-stream.ts`)

- Duplicate sales vs on-chain indexers: `:219` unique key includes `venue_id='opensea-stream'`; `biggest-buyers.ts:19` filters only `event_type='sale'` -> volume/board double-counts any sale seen by both paths (activity reader dedups; buyer board does not).
- Half-open socket never detected: heartbeat sent but no reply/`lastEventAt` staleness check; join rejection logged, not closed -> up to 59 min blind.
- Hourly gap with no replay: `--max-seconds=3540` + `flock -n` -> 20-60s blind window every hour.
- Final flush can drop rows: `:394` returns early if `flushing`; final `flush()` at exit no-op if a flush is in flight, and `closePostgres()` can end the pool under it.
- One bad floor aborts the whole floor batch: sequential `recordFloorObservation` throws for untracked/renormalized keys; exception discards remaining floors.
- Unbounded `raw_event` in batch path (`:207` not sliced); `floorBuffer` has no size trigger; `metadataSeen` never pruned; 3,600 `JSON.parse`/s on a shared core -- test a cheap substring before parsing.

## 4. Top 10 defects (ranked)

1. Timed-out in-process lane keeps running -> duplicate execution + contention (`mesh-tick.ts:158-182, 202-207, 333, 347`).
2. Standing lanes run once per hour under always-on (`mesh-tick.ts:259-291`).
3. Solana/Bitcoin demand jobs ignore `subject` and succeed after hydrating another collection (`mesh-lane.ts:117-119, 236-244, 268-270`).
4. Rate-limit catch returns exit 0 -> demand job marked succeeded, no jail for OpenSea sources (`mesh-lane.ts:484-504`).
5. Express threshold 118 unreachable after cost penalty (`demand-bus.ts:57, 94-96`; `mesh-tick.ts:303`).
6. Sleep-then-immediate-re-enqueue pins slots; "no OpenSea slug" loops forever (`mesh-lane.ts:91-93, 305-317`; `control-plane.ts:143`).
7. Stream sales duplicate on-chain sales in the buyer board (`opensea-stream.ts:219`, `biggest-buyers.ts:19`).
8. Stream has no liveness watchdog (`opensea-stream.ts:440-449, 456-459`).
9. General workers exit on first empty claim while express holds the flock (`mesh-tick.ts:310-314`).
10. `markIncomplete()` recursion in script mode (`mesh-lane.ts:27-31, 521`).

# LENS 6 -- Activity, sales ledger, volume, grades and scoring

## 1. Three disconnected ledgers; no single one has every sale

| Store | Writers | Readers |
|---|---|---|
| `plank_<venue>_fills` (9 tables) | seaport/wyvern/looksrare/blur/x2y2/foundation/sudoswap/rarible/cryptokitties indexers | `ledger-activity.ts` UNION (activity tab), `updateEvmVolumeFromSeaportFills` (seaport only) |
| `plank_market_events` | opensea-stream (sales), transfer-ledger (EVM transfers/mints), helius-transfer-scan (Solana sale/mint/transfer), unisat-transfer-scan (BTC transfers) | `biggest-buyers.ts`, `live-feed.ts`, activity UNION (transfer + opensea-stream branches only) |
| `plank_multichain_snapshots.volume_24h_wei/sales_24h/7d/30d` | `updateCollectionMarketStats` called by opensea-stats, coingecko-nft-stats, rarity-index-runner, hydrate-stats route, `updateEvmVolumeFromSeaportFills` (last writer wins, no source column) | hub grade/sort, collection page |

**EVM:** activity tab unions all 9 fill tables + wallet-transfer + opensea-stream (OK). **Volume/sales 24h** (`store.ts:479-505`) sums plank_seaport_fills only, native-currency only (`currency_token IS NULL`, :491). Wyvern/LooksRare/Blur/X2Y2/Foundation/Sudoswap/Rarible/CK fills are in no volume figure. WETH-denominated Seaport fills (every accepted offer) are excluded. Then opensea-stats / coingecko overwrite the same columns, so the number flips between vendor and native-only-subset depending on which lane ran last. **OpenSea stream sales are NOT counted in volume/sales.** Buyer board reads `plank_market_events` sales only -> on EVM that is opensea-stream rows only; the 9 fill tables never reach it. 7d/30d only from OpenSea stats / rarity-index-runner.

**Robinhood:** activity = raw Transfer logs with `priceWei:null`; volume = native Seaport; buyer board empty. **Solana:** activity = Magic Eden live API + `plank_tensor_fills`; Helius ledger sales not read; volume = CoinGecko 24h only; buyer board = Helius `NFT_SALE` rows with **no amount columns** (`helius-transfer-scan.ts:248-274`), so ranks by count only. **Bitcoin:** activity returns `[]`; volume = CoinGecko; buyer board empty; `bitcoin_onchain_settlements` aggregated by nobody.

## 2. Top 10 defects

1. **Sales from 8 of 9 on-chain venues never touch volume, sales count, or the buyer board.** `store.ts:480-494`, `biggest-buyers.ts:56-57`, `seaport-fill-indexer.ts:566-590`.
2. **OpenSea Stream sales are invisible to volume/grade.** `opensea-stream.ts:213-219`; no volume updater reads that table.
3. **Seaport 24h volume excludes every ERC-20 (WETH/USDC) fill.** `store.ts:491`.
4. **Every `seaport-fills` lane run wipes 7d/30d.** `store.ts:498-502` -> `store.ts:376-413` writes NULLs.
5. **Three writers race on the same volume columns with no provenance.** `opensea-stats.ts:395,533`, `coingecko-nft-stats.ts:368`, `rarity-index-runner.ts:667`, `hydrate-stats/route.ts:175,238`, `store.ts:498`.
6. **Activity feed ordering is lexicographic.** `ledger-activity.ts:125,137,146,...` cast `block_number::text`, then `ORDER BY block_number DESC` (:295) and in `deriveApproxHolderCountFromLedger` (:253); NULL stream rows sort first forever. Fix: `ORDER BY COALESCE(block_timestamp, to_timestamp(0)) DESC, block_number::numeric DESC NULLS LAST, log_index DESC`.
7. **Buyer board double-counts bundle sales and counts unconfirmed rows as settled.** Stream `item_sold` fires once per item with the full `sale_price` each; `finality='observed'` never promoted/reverted.
8. **USD is not "at time of sale."** `activity-value.ts:75-90` prices historical rows at current spot; fill tables carry no `amount_usd`.
9. **Grade is computed on partial/vendor-mixed volume with no label; wash trading never touches it.** `GlobalMarketHub.tsx:656-663`; `computeWashSuspicion` client-only.
10. **Solana sales unpriced in the ledger; Solana/Bitcoin activity ignores the ledger.** `helius-transfer-scan.ts:248-274`; `route.ts:209-300`.

Minor: `transfer-ledger.ts:164-173` FILL_TABLES omits `plank_cryptokitties_fills`; NULL `block_timestamp` rows silently drop out of windows (`store.ts:492`).

## 3. The one change: any sale on any chain updates volume, sales, grade, buyer board within a minute

1. **One sink:** every fill writer also upserts a normalized row into `plank_market_events` in the same transaction (venue_id per venue, finality 'confirmed', amount_usd priced at write time from a `plank_asset_price_daily(asset, day, usd)` table). Backfill existing fill tables with one INSERT...SELECT per venue.
2. **Dedup stream vs chain in the sink:** partial unique index on `(chain_slug, tx_hash, token_id) WHERE event_type='sale'`; when the on-chain row arrives, UPDATE the stream row to `finality='confirmed'` with block number and chain venue instead of inserting; mark stream rows >30 min with no on-chain match `reverted`; store per-item share for bundles.
3. **One aggregator, triggered by writes:** `updateVolumeFromMarketEvents(chainSlug, keys[])` computing 24h/7d/30d USD and native sums with `NOT (seller = buyer)` and `finality <> 'reverted'`, writing all three windows atomically plus `volume_source`/`volume_computed_at`; called from `writeMarketEventRows` and each fill writer; vendor stats write only when `volume_source IS NULL OR 'vendor'`.
4. **Buyer board and grade read the same thing;** grade badge renders "partial data" when source is vendor or coverage not indexed.
5. **Solana/Bitcoin parity:** Helius insert carries amount/currency/usd; `readLedgerActivity` gains a namespace-agnostic branch.

# LENS 3 -- Wallet wirings and market purchasing features

## 1. Chain x feature matrix (actual code state, not the registry's claim)

Registry: `lib/market/multichain/trading/parity-matrix.ts:59-160`. Where the reading disagrees with the registry, the cell shows `registry -> actual`.

| Feature | Robinhood (4663) | Foreign EVM (eth/polygon/arb/base/opt/bnb/avax) | zkSync (324) | Solana | Bitcoin |
|---|---|---|---|---|---|
| connect | proven (injected + WC + Reown) `lib/wallet-context.tsx` | injected only; WC/Reown sessions pinned to 4663 (`lib/wallet-connect.ts:146-148`, `ConnectWalletModalReown.tsx:106-107`) -> **gated-by-wiring** | same | Phantom raw injected, not in WalletProvider (`non-evm-wallet.ts:82`) built-unproven | UniSat raw injected, no network check (`non-evm-wallet.ts:92`) built-unproven |
| buy | proven `foreign-fulfill.ts:346-368` -> `seaport.ts:851` | built-unproven, fork-only `foreign-fulfill.ts:832-929`; C1 guard bypassed from MarketView | built-unproven (native book) `native-fulfill.ts:44` | gated: `MAGICEDEN_API_KEY` + ME price-unit bug | UniSat AH gated `NATIVE_BITCOIN_MAINNET_ENABLED`; native OpenOrdex book proven testnet4 only |
| sweep floor | proven `seaport.ts:973` (assertSweepTotal) | built-unproven `foreign-fulfill.ts:941-1001`; no total cap, executes non-previewed set | built-unproven | gated | gated (mainnet) |
| sweep tier/trait | built-unproven | **registry B -> broken**: tier scope dropped at execution (`MultichainCollectionView.tsx:1650-1655`) | same | gated | tier gated; trait unavailable |
| offer (item) | proven | built-unproven `foreign-offer.ts:103`; unsimulated sends, demo RPC | built-unproven | gated (+ unit bug) | **registry B -> absent**: UI routes Bitcoin offers into `buildForeignOffer` which throws (`MCV:1199-1215`) |
| collection / trait bid | proven (criteria.ts) | built-unproven; `chooseCriteriaMode`/`planBidLadder` have **zero UI callers** | same | gated | unavailable |
| list | proven | built-unproven `NativeForeignListForm.tsx:206` | built-unproven | gated | proven testnet4 |
| cancel | proven `MyPositions.tsx:107` | **registry B -> absent**: `seaport.ts:1068 cancelOrder` has no chain param, always `ensureRobinhoodChain` | absent | gated | proven testnet4 |
| accept offer | proven `foreign-fulfill.ts:769-805` | native: built-unproven, no client-side validation (`MCV:1249`); OpenSea offers: **broken for criteria/wildcard** (`foreign-offer.ts:227-261`) | native only | gated | unavailable |
| cross-chain sweep | gated (receiver/executor addresses null) | gated | gated | unavailable | unavailable |

Canary spend caps (`canary-limits.ts:112`) are wired into **no route**. `FOREIGN_TRADE_CANARY_ENABLED` gates nothing.

## 2. Top 10 defects (money-at-risk first)

1. **EVM sweep executes a different set than the one confirmed, with no spend cap.** `foreign-fulfill.ts:941-1001`: takes `count`+`traits`, re-fetches "N cheapest" server-side, fills whatever comes back. `maxTotalSpendWei` (948) declared and never read; no per-order `assertForeignOrderMatchesExpectation`; no analogue of native `assertSweepTotal`. Fix: pass previewed `orderHash[]` + `expectedTotalWei`, fetch only those, sum consideration+tips, refuse above cap.
2. **Tier-scoped EVM sweep buys the wrong tokens.** `MCV:1570-1573` filters preview by tier, but `confirmSweep` (1650-1655) passes only `traitClauses`. "Sweep 3 Legendary" buys the 3 cheapest commons. Same fix.
3. **MarketView buy path skips the C1 price/asset guard.** `components/market/MarketView.tsx:731-734` calls `buyForeignListingNow` with only chain+orderHash. Fix: pass priceWei, contract, tokenId as MCV does at 1339-1352.
4. **Foreign offer/accept sends unsimulated, un-allowlisted transactions on a wallet-added chain with a bogus RPC.** `foreign-offer.ts:58-64` (`ETH` symbol for Polygon/BNB/Avax, `.../v2/demo` RPC); `:97` `signer.sendTransaction` bypasses simulation/destination allowlist. Fix: route through `executeActionsViaWallet` with `seaportChainFor()` as buy does.
5. **Accepting an OpenSea collection/trait offer is unfulfillable.** `offer-fulfillment-data/route.ts:65-72` discards criteria resolvers; `foreign-offer.ts:255-259` fulfills with no `considerationCriteria`. Fix: use OpenSea's resolved `fulfillment_data.transaction` calldata or build `InputCriteria`; add a `validateOfferOrder`-style assertion.
6. **Magic Eden price unit mismatch (gated).** `magiceden-solana-trade.ts:123-134, 151-165` send lamports where ME documents decimal SOL; omits seller/AH/ATA. Verify against current docs, then convert at the adapter boundary.
7. **Bitcoin UniSat buy signs a third-party PSBT blind with `autoFinalized: true`.** `foreign-fulfill.ts:487-491`. Fix: parse PSBT, assert inscription output to buyer and total spend <= quote, then sign; route-level mainnet gate.
8. **Foreign-chain native offer accept has no client-side re-derivation.** `MCV:1249` -> `native-fulfill.ts:44-66` fulfills a store row without `validateOfferOrder`. Fix: mirror the trait path 1268-1290.
9. **No cancel for foreign EVM/zkSync native listings and offers.** `seaport.ts:1068-1083` hardcodes Robinhood. Fix: `chain?: SeaportChain` param, route through `sendForeignTransaction`, add UI.
10. **WalletConnect/Reown users cannot trade any foreign chain.** Sessions declare only chain 4663. Fix: declare all manifest EVM chainIds in `optionalChains`/`networks`.

Honorable mentions: Bitcoin offer UI dispatches to `buildForeignOffer` and throws; `foreignFillTip` always tips native so WETH/USDC listings need both balances and the USDC approve is blocked by `assertSafeForeignMarketDestination`; `considerationTotal` sums mixed-token consideration; `sweepSolanaListingsBatched` reads `process.env.SOLANA_RPC_URL` in browser code; parity `bitcoin.buy` cites the wrong route as testnet4-proven.

## 3. What moves built-unproven -> proven

| Cell(s) | Requirement |
|---|---|
| Foreign EVM buy/sweep/offer/list/accept (7 chains) | Fix #1-#5, #9. Then one real mainnet fill per chain with a funded wallet (~$50 + gas each), signed record in `parity-matrix.ts`. Wire `checkAndRecordCanaryLimit` into fulfillment-data/submit-offer/floor-listings before real funds. |
| zkSync native book | Seaport 1.6 fill on 324 with a real signer (WETH for offers). |
| Solana (all cells) | `MAGICEDEN_API_KEY` (owner application), fix #6, one Phantom signature on mainnet per action; Tensor bids need a route + `TENSOR_API_KEY`; batched sweep needs a composability test. |
| Bitcoin UniSat AH | `UNISAT_API_KEY` mainnet + `NATIVE_BITCOIN_MAINNET_ENABLED=true` + fix #7; one real small bid. |
| Bitcoin native book mainnet | Flip the flag, mainnet UniSat Indexer key, client `unisat.getNetwork()` check, one mainnet fill. |
| Cross-chain sweep | Deploy receiver/executor contracts; external audit first (custodies bridged funds). |
| Robinhood sweep-tier/trait, bid-ladder, criteria-mode | Wire the test-only helpers into MCV/SweepConfirm; one signed write each. |
| Connect (WC/Reown on foreign chains) | Fix #10; one pairing per chain. |

External audit warranted for: fee-tip/consideration math on the foreign fill path, the Bitcoin PSBT builders before mainnet, the bridge receiver contracts before deployment.

# LENS 4 -- Metadata discovery, traits and rarity

## 1. The pipeline as it really is

**A. Membership** -> `plank_collection_tokens` rows with `metadata_state='pending'`. EVM: `advanceEvmCollectionMembership` (`rarity-index-runner.ts:183`) = one OpenSea `/nfts` page of 50 per tick, paced by the key pool; `advanceVerifiedSequentialMembership` (750 ids/tick); HyperSync `anchored-membership` and `token-index-probe` write bare rows (`name:null, traits:[]`). This is why BAYC archive depth = 100%: 10,000 empty rows. Solana: one DAS `searchAssets` page of 1000/tick, traits only from `content.metadata.attributes`. Bitcoin: unisat 100/page, traits only if the activity item carries `attributes`; the OrdinalsWallet full-set runner is script-only; `ordinals-envelope-parser.ts` has zero callers.

**B. Metadata fetch (EVM only)**: `advanceEvmTokenMetadata` (`rarity-index-runner.ts:365`). `readTokenMetadataWork` caps at **25 rows** per call; retries re-eligible after 30 min with no attempt limit. One Multicall3 `tokenURI` batch (ERC-721 selector only), then `Promise.all` over 25: `fetchNftMetadata` (`lib/ipfs.ts:310`) races 3 gateways (8 s) then walks 4 more serially (12 s each) -> worst case **56 s per token**; non-IPFS `http(s)` URIs get a single candidate. ~**11 DB round trips per token** on a 4-connection pool. Lane ceiling **75 tokens (background) / 250 (subject)** per invocation; **the evm-metadata handler never calls `markIncomplete()`**, so a subject job is marked succeeded after <=250 tokens and only re-enqueued by another viewport ping. That is the 312/10,000.

**C. Trait projection**: jsonb per row; `readProjectedTraitIndex` builds the index by `jsonb_array_elements` over the whole collection per request.

**D. Rarity**: `computeGenericRaritySnapshot` (`lib/rarity-generic.ts:88`): sum of -log2(count/N) over non-spam trait types, competition rank, tier by percentile. Triggered only when an OpenSea/DAS walk ends or when a work batch leaves `remaining==0` AND a membership cursor is complete (`:517`). Persisted via `replaceForeignRarity` = DELETE + **one INSERT per token per alias**.

**E. UI**: `MetadataCoverageBar` = rows with `name IS NOT NULL OR image_url IS NOT NULL` / `projected_count` (`archival-ledger.ts:600-611`).

## 2. Top 10 defects

1. **Evm-metadata demand job is capped at 250 tokens and self-terminates.** `scripts/mesh-lane.ts:172-176`, `scripts/mesh-tick.ts:110-116`; no `markIncomplete()`. Fix: loop until `isEvmMetadataComplete` or a hard wall-clock, `markIncomplete()` when work remains, drop the 25-row cap for subject jobs.
2. **OpenSea list walk writes a full, non-partial rarity snapshot with empty traits.** `rarity-index-runner.ts:222-251`: the list endpoint returns no `traits`, so rarity is computed over trait-less tokens -> all "Common", `partial=false`, coverage=100%. Fix: never compute rarity at membership completion; only at metadata terminal, `partial=true` unless `withTraits/expected` passes a threshold.
3. **Rarity never finalizes if one token is stuck in `retry`.** `rarity-index-runner.ts:517-527`; no attempt cap. Fix: cap attempts (5 -> `empty` with reason), finalize at >=99.5% terminal on a cadence, decoupled from the work batch.
4. **ERC-4906 rescan is broken in three ways.** `erc4906-rescan.ts:51-55` (LIMIT 5, no cursor, full scan of the 19M-row table every minute per chain); `onchain-extensions.ts:76-120` unchunked `eth_getLogs`, errors swallowed, cursor advanced anyway. Fix: durable cursor, 2k-block chunks, advance only on success.
5. **Coverage label lies in both directions.** `archival-ledger.ts:600-611`. Fix: three honest counters `terminal/expected`, `withTraits/expected`, `withImage/expected`.
6. **Rarity method silently penalises missing traits.** `rarity-generic.ts:106-111` (no "None" pseudo-value); `isSpamTraitType` drops types on small samples. Fix: add "None" per scored trait type; document the method on the page.
7. **Gateway strategy stalls and self-DDoSes.** `lib/ipfs.ts:337-356`: 3-way race x 25 concurrent = 75 simultaneous hits; 429 -> 30-min cooldown. Fix: one gateway per attempt with rotation + per-host token bucket, 5 s timeout; dedicated gateway for bulk.
8. **Rarity GET triggers a 500-page OpenSea walk in the web process.** `rarity/route.ts:82-90`; `replaceForeignRarity` does 10k+ single-row INSERTs. Fix: enqueue a demand job; bulk insert via `unnest`.
9. **Solana / Ordinals traits have no fallback.** `helius-rarity-index-runner.ts:206-213`, `solana-token-hydrate.ts:108` never fetch `json_uri`; Bitcoin lane is activity-only; no inscription `metadata` parse. Fix: json_uri fallback; promote ordinalswallet-rarity to a lane; wire the envelope parser.
10. **Multicall pre-pass and per-token writes are the wrong shape for throughput.** 25-item batches, ERC-1155 `uri()` excluded, `COUNT(*)` inside every single-token transaction (`collection-token-store.ts:183`). Fix: 250-500 URIs per aggregate3 with both selectors, 500-row `unnest` writes, one count per batch.

## 3. 10k collection: 3% -> 100% in under an hour on a 4-connection Postgres

1. URIs (~15 s): all pending ids in one query, Multicall3 `aggregate3` with both selectors, 250 per batch -> 40 calls.
2. Bodies (~5-6 min IPFS at 30 rps across rotated hosts; ~2 min via Alchemy `getNFTsForContract?withMetadata=true` 100/page; tokenURI stays the verifier, not the fetcher).
3. Writes (~10 s): `INSERT ... SELECT FROM unnest(...)` 500 rows/statement -> 20 statements, one count, one projection upsert, one archival update (vs ~110k round trips today).
4. Rarity (~5 s): in-memory compute with "None" values; bulk `unnest` inserts.
5. Scheduler: subject job runs to completion under a ~50-min wall with `markIncomplete`, no 25/250 caps; finalize at >=99.5% terminal with `partial`, `withTraits`, `expected` surfaced verbatim in the bar.

Net ~3-8 min wall-clock for a 10k IPFS collection; the database is not the constraint once writes are batched.

# SYNTHESIS -- why the owner saw what they saw, and the order of repair

Every live observation maps to a root cause above:

| Owner observation (2026-09-06) | Root cause(s) |
|---|---|
| "no global" after the door | singleflight lease cast rejected by production PostgreSQL (fixed); hub index uncached; rate limiter keyed on the Cloudflare edge (fixed) |
| collections would not open | `router.replace` URL sync batching every navigation into a stalled transition; demand pings saturating the pool (fixed) |
| lots of data missing on the hub | L1 #1-#5 (Arbitrum shells, forward scan cannot keep up, stats cursor starvation, permanent `__none__`, ERC-20 fills excluded); L5 (mesh never ran in production, then 0.13 jobs/min) |
| BAYC traits 3.12% while archive depth 100% | L4 #1 (250-token cap, no `markIncomplete`), #2/#5 (bare membership rows count as depth; coverage counts name-or-image), #7 (gateway stalls) |
| bars not surging live | correct at rest; L5 D (express threshold unreachable after the cost penalty) and L5 C (general workers exit early) keep the job out of a slot |
| "I thought we had prioritization" | it existed at the intent layer; L5 D/L/E show three ways a click's priority is lost before a slot is won |

## Repair order (each batch = one release, tests + live proof, recorded in the fix log)

**Batch A -- hydration engine truthfulness and throughput (production-visible today)**
A1 L4#1 evm-metadata subject jobs loop to completion (`markIncomplete`, hard wall, no 25/250 caps for subjects).
A2 L5 D express threshold: click/sweep intents exempt from the cost penalty; express floor 116.
A3 L5 C general workers idle-poll until the deadline instead of exiting on the first empty claim.
A4 L5 B standing lanes re-enqueued inside the pass every `sliceSec`.
A5 L5 E/F `deferDataJob(id, notBefore)`; jailed -> jail_until, pool busy -> +8s, slug-less -> terminal `empty`.
A6 L5 G rate-limit catch -> defer (not succeeded); non-EVM demand jobs that cannot target a subject -> `markIncomplete`, never success.
A7 L5 H `markIncomplete` script-mode recursion.
A8 L5 A abort signal for in-process lanes on timeout.
A9 L5 K telemetry counts partial completions.

**Batch B -- ledger truth (volume, grade, board agree)**
B1 L6 #1/#2/#5 one sink (`plank_market_events`) for every fill writer + one write-triggered aggregator with `volume_source`.
B2 L6 #3 ERC-20 fills counted (USD aggregation).
B3 L6 #4 7d/30d never wiped by the seaport lane.
B4 L6 #6 activity ordering by timestamp/numeric block.
B5 L6 #7 + L5 stream dedup: buyer board excludes stream rows whose tx is in a fill table; bundle share per item.
B6 L6 #8/#10 USD at time of sale; Solana ledger rows priced.

**Batch C -- listings and offers truth**
C1 L2 #1/#6 currency per row (itemType/token), never per chain; ERC-20-priced listings excluded from floor/cheapest math and labelled.
C2 L2 #2 OpenSea cursor walk with `bookCoverage.complete`.
C3 L2 #3 native listings merged into the foreign grid.
C4 L2 #5 criteria/wildcard offers `acceptable:false` until the criteria fill path is proven.
C5 L2 #7 stream floor state: native/WETH only, `listing_type` honoured, cancellations applied, observations read into the header.
C6 L2 #4/#8/#9/#10 Tensor listings surfaced view-only; UniSat stale flag; executable-first dedup on Bitcoin; Solana/Bitcoin offers labelled honestly.

**Batch D -- money at risk (before any foreign-chain real-funds proof)**
D1 L3 #1/#2 sweep executes exactly the previewed order hashes under `expectedTotalWei`; tier scope carried to execution.
D2 L3 #3 MarketView buy passes price/contract/tokenId to the guard.
D3 L3 #4 foreign offers routed through the simulated, allowlisted sender with correct chain params.
D4 L3 #5/#8 offer acceptance validated client-side; criteria offers use OpenSea's resolved calldata or are refused.
D5 L3 #9/#10 foreign cancel; WC/Reown declare all EVM chains.
D6 L3 #7 Bitcoin PSBT parsed and asserted before signing.
D7 canary caps wired into every real-funds route.

**Batch E -- catalog completeness**
E1 L1 #1 discovery threshold + pending-candidates gate (no more shells).
E2 L1 #2 time-budgeted forward scan.
E3 L1 #3/#4 stats cursor never skips unprocessed rows; `__none__` only on confirmed 404 with a TTL.
E4 L1 #6/#7 Solana catalog lane + ME alias for Helius rows.
E5 L1 #8 floor expiry + `floor_observed_at`; freshness from it, not `synced_at`.
E6 L1 #9/#10 per-chain source-down banner; zkSync `statsCapable:false` shown honestly.

**Batch F -- metadata at scale** (L4 #2-#10): rarity only at metadata terminal with `partial`; attempt caps; honest three-counter coverage; "None" trait value; single-gateway rotation with per-host buckets; bulk `unnest` writes; ERC-4906 cursor; Solana/Ordinals trait fallbacks.

Owner-side prerequisites that no batch removes: `MAGICEDEN_API_KEY`, `UNISAT_API_KEY` mainnet, `NATIVE_BITCOIN_MAINNET_ENABLED`, funded wallets for one proof fill per chain, external audit for the foreign fill math, PSBT builders and bridge receivers, and a worker host with real connection headroom (PROGRAM-INSTANT-MAX-SYNC section 4).

# FIX LOG

- **Batch A shipped (2026-09-06):** A1 evm-metadata subject jobs signal `moreWork` and re-enqueue at priority (ceiling 500/slice); A2 click/sweep intents exempt from the cost penalty; A3 general workers idle-poll to the deadline; A4 standing lanes re-enqueued every 5 min inside the pass; A5 `deferDataJob` -- jailed subject jobs defer 20 min, pool-busy defers 10 s, slug-less collections are terminal for the OpenSea lane; A6 rate-limit catch defers subject jobs instead of marking them succeeded; subject-blind non-EVM sources fail visibly for subject jobs; A7 `markIncomplete` script-mode recursion fixed; A9 telemetry counts completions in the window regardless of status. Open: A8 abort signal for timed-out in-process lanes.
- **Batch B/C shipped (2026-09-06):** B2 sales counted whatever the currency, wei volume includes the chain's wrapped native at 1:1 (`updateEvmVolumeFromSeaportFills`); B3 7d/30d windows no longer wiped by a caller that only knows 24h; B4 activity ordered by timestamp then numeric block; B5 buyer board excludes stream rows whose tx the Seaport indexer holds and takes a 1/quantity share for bundle items; C5 stream floor state accepts only unexpired basic asks in native or wrapped-native currency, one bad key no longer discards a window, raw payload bounded, half-open sockets detected after 90 s of silence, frames pre-filtered before JSON parsing. Proven live: 120k events / 41 s, 31 sales, 1,635 floors, 27 metadata refreshes. Open: B1 single sink for all fill writers + write-triggered aggregator; B6 USD at time of sale; C1-C4/C6 listings truth; D1-D7 money-at-risk; E/F.
- **Batch C shipped (2026-09-06):** C1/C6 every foreign-EVM listing is priced in its own currency (`priceForeignOrder`: native legs, wrapped-native 1:1 and labelled, other ERC-20 or mixed consideration excluded from the grid and counted in `bookCoverage.excludedNonNativeCurrency`); C2 the OpenSea `/all` book is cursor-walked up to the requested limit with `bookCoverage.complete/partial`; C4 criteria and wildcard offers are view-only (`acceptable:false`) until the criteria fill path is proven; `Listing` carries `currencySymbol/currencyAddress`. Open: C3 native listings merged into the foreign grid; C5 stream floor observations read into the header; C6 Tensor view-only rows, UniSat stale flag, executable-first Bitcoin dedup, Solana/Bitcoin offer labels.
- **Batch D part 1 shipped (2026-09-06):** D1 foreign sweeps execute exactly the confirmed order hashes (tier/trait scope carried by the preview), each at or below its previewed price, in native/wrapped-native only, capped at the confirmed total plus tips (`assertSweepMatchesPreview`, 5 tests); legacy callers' `maxTotalSpendWei` is now enforced; D2 the RobinWood market's cross-chain buy passes price, token and maker into the C1 guard. Open: D3 foreign offers via the simulated allowlisted sender; D4 offer acceptance validation + criteria via `fulfillment_data`; D5 foreign cancel + WC/Reown chain namespaces; D6 PSBT verification before signing; D7 canary caps; Magic Eden decimal-SOL price at the adapter boundary.
- **Batch D part 2 shipped (2026-09-06):** D6 UniSat buys decode the marketplace PSBT and assert (inscription output to the buyer, others paid <= confirmed price + fee, only enumerated buyer inputs signed and never the seller's SINGLE|ANYONECANPAY input, miner fee <= ceiling) before the wallet prompt (`psbt-safety.ts`, 5 tests); Magic Eden REST `price` converted to decimal SOL at the adapter boundary (research-confirmed; 1 test); D3 partial: foreign offers add the chain to the wallet with the registry's real symbol/RPC/explorer instead of "ETH"/a demo RPC. Provisioning proof runs use their own lock so they never time out against the live scheduler. Production measured after Batch A: 145 jobs / 15 min (9.7 per minute, from 0.6), queue 889 -> 545. Open: D3 routing offer sends through the simulated allowlisted sender; D4; D5; D7.
- **Batch E/F part 1 shipped (2026-09-06):** E1 HyperSync discovery applies `MIN_TRANSFERS_TO_CONSIDER` on all three candidate sites (no more one-transfer shells); E3 an OpenSea "no slug"/"no stats" is remembered only on a confirmed 404 and expires after 7 days; the stats cursor window is ordered by id so the cursor can never skip real rows; F2 rarity is never finalized from a trait-less membership walk, and is labelled partial unless >=99.5% of tokens carry traits. Open: E2 time-budgeted forward scan; E4 Solana catalog lane + ME alias; E5 floor expiry/freshness; E6 source-down banner and zkSync honesty; F1/F3-F10 (attempt caps need a migration; gateway rotation; bulk writes; ERC-4906 cursor; Solana/ordinals trait fallbacks; OpenRarity two-key sort + RANK ties + explicit None).
- **Batch E part 2 shipped (2026-09-06):** the hub marks Bitcoin rows tradeable only when the mainnet native book flag is on (the route's own comment had said so; the code disagreed); CoinGecko floors get the same 100,000 plausibility ceiling as OpenSea/Alchemy; every hub price read (hero tile, mover strip, sort, floorNative) goes through the zero guard `displayFloorWei`. Open (needs a `previous_floor_at` column): the 24h change computed from an unbounded-age previous floor.
- **Batch E part 3 shipped (2026-09-06):** the hub index tie-break among rows with no sales is now floor-present, holders, 30d volume before chain/contract, so alphabetical "arb-mainnet" shells no longer fill the window ahead of real collections on other chains.
- **Batch E part 4 shipped (2026-09-06):** hub empty-cell explanations no longer promise data the pipeline cannot deliver; each states what is actually known. Owner-gated (recorded, not changed): D5 WalletConnect/Reown optional chain namespaces -- the code documents a real wallet freeze from optional chains in the past and the shared connect path also serves the swap/vault, so this needs real-wallet testing before it ships.
- **Batch B1 part 1 shipped (2026-09-06):** every Seaport fill now also lands in `plank_market_events` as a confirmed sale in the same transaction (venue `seaport`), and a stream row for the same transaction is promoted to `confirmed` instead of lingering as an unconfirmed duplicate; the buyer board and live feed therefore see on-chain Seaport sales, not only stream sales. Open: the other eight venue writers; the write-triggered aggregator with `volume_source`; USD at time of sale (hourly).
- **Build repair (2026-09-06):** the sweep-cap change had made the browser bundle import `foreign-orders.ts` (which pulls in the OpenSea key pool and Postgres); the pure pricer now lives in `order-pricing.ts` with no dependencies and is re-exported from `foreign-orders.ts` for existing callers.
