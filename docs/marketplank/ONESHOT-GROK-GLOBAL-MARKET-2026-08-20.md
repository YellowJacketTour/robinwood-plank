ONESHOT for Grok (continue this Marketplank / robinwood-plank session)
======================================================================
Paste this whole file. Do NOT merge `dev` → `master`. Do NOT deploy to
plank.tanggang.life. Work stays on branch `dev`. Next code change: branch
off origin/dev, PR with base: `dev` (CONTRIBUTING.md / bullish0x rules).
Operator local app: http://localhost:3800  (Next, not InMotion).

Repo: YellowJacketTour/robinwood-plank
Compare vs live: https://github.com/YellowJacketTour/robinwood-plank/compare/master...dev
Intent map: docs/marketplank/HANDOFF-BULLISH0X-GLOBAL-MARKET-2026-08-20.md
This one-shot: also at docs/marketplank/ONESHOT-GROK-GLOBAL-MARKET-2026-08-20.md

Home NFT: 0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156  chainId 4663 (Robinhood)
Native UI: /market     Global hub: /market/multichain
Alchemy NFT API is FORBIDDEN (monthly 429). Fail closed: never invent floors,
names, images, ranks, volume, holders. Dash with a reason > fake 0.


0. WHAT YOU ARE LOOKING AT IN THE LATEST SCREENSHOT
---------------------------------------------------
http://localhost:3800/market/multichain?chains=robinhood

- Hub COMPILES again (the red Next overlay is gone if they pulled ff6a731+
  and restarted with a wiped .next).
- Row #1 is RobinWood (pin + inject). Banner "Home chain" still links /market.
- Every ranking cell is "—". That is NOT "grade missing as a bug" only:
  getListings("robinwood","robinhood") often returned [] because old
  market_orders rows have NULL chain_slug; 17c39ae now loads getListings
  without forcing chain. If /market Buy&Sell is also empty, floor/listed
  dashes on the hub row are HONEST (no live Seaport listings in this DB).
- Rows 2–10 are OpenSea Robinhood SCAN shells (ERC721, hex, ".."). They
  have images from the scan, almost never OpenSea stats snapshots.
- Operator wants: (1) RobinWood GRADED, (2) decentralized liquidity / vault
  as a REAL grade input, (3) RWA/stock-backed NFTs as REAL grade input when
  sourced, never arbitrary, (4) correct collection NAMES not ERC-721
  name() junk.


1. BRANCH / PROD RULES (BULLISH0X)
----------------------------------
master = InMotion deploy = public. Do not merge this work to master.
dev = integration. This session pushed to dev under weekly-limit pressure
(same exception as docs/HANDOFF-multichain-data-and-bitcoin-audit-2026-08-20.md).
Merging dev→master is bullish0x's release decision only.


2. PRODUCT INTENT (STILL THE GOAL)
----------------------------------
Unified NFT marketplace: every chain, every collection, every piece.

Native RobinWood /market: Seaport 1.6, gallery rarity lib/rarity.ts
  (−log2 on Base/Background/Holographic), vault Instant Swap (V3).

Foreign /market/multichain/:chain/:slug:
  listings overlay + catalog, same −log2 in lib/rarity-generic.ts,
  buy via OpenSea fulfillment_data / Magic Eden buy_now / UniSat auctionId.

No hover mega-menus on /market. No Instant Swap for foreign yet (banner).
No Across/deBridge/0x NFT pay-from-any-chain (receivers null, flags off).


3. WHAT THIS SESSION SHIPPED ON `dev` (CHRONOLOGICAL)
-----------------------------------------------------
Rarity / collections (before the hub crash)
- Claynosaurz empty rarity: ME symbol ≠ Helius collection mint. Resolve
  mint via ME listing + DAS grouping; dual-write slug+mint.
- Names were mints: Listing.tokenName from ME token.name; displayTokenLabel.
- 5k sample stuck: rarity GET only enqueued if map.size===0. Resume if
  sampleSize in {1000,2000,5000}. Claynosaurz reached ~10,232.
- Listed 161 vs floors "20 listed": ME first page cap 20. Page offset up
  to 200; RarityFloorStrip can say "N of M listed".
- All items used ME listings (20). Now catalog from plank_foreign_rarity
  (up to 2000). ITEMS uses sampleSize / ME listedCount.
- Solana verify: don't refetch /v2/tokens/:mint/listings (429/empty).
  Pass collection escrow (auctionHouse, tokenAccount, seller) into
  M2 SellerTradeState getAccountInfo. Buy 409s if PDA gone or price moved.
- Kernel tests: rarity-generic, rarity-index-dispatch, solana-rarity-resolve,
  token-label, solana-verify-listing, marketplace-harness.

Hub / Robinhood
- Native RobinWood was ONLY a banner ("deliberately excluded from
  FOREIGN_CHAINS"). Injected as a ranking row from getListings; isNativeHome
  → href /market. Unsynced listed_count=0 serialized as null (dash not fake 0).
- Default "Has real artwork" + hide shells zeroed Robinhood (477 scan rows
  have no floor/volume). Robinhood-only filter skips those gates.
- Grade sort dropped native row off page 1 (no snapshot → ungradable).
  Pin isHomeRow first. Client fallback inserts RobinWood if API miss.
- Biggest movers now respect chain filter.

THE INCIDENT (operator identified: "you broke something fundamental")
- Goal: make Optimism/Avalanche cells as complete as unfiltered Ethereum.
  Ethereum looks complete because those rows already had an OpenSea stats
  snapshot. OP often has floor only.
- Implementation: GlobalMarketHub POSTed /api/market/multichain/hydrate-stats
  for 8 visible contracts. Module
  lib/market/multichain/opensea-collection-stats.ts called OpenSea+CoinGecko.
- Bug: `const key = await getOpenSeaApiKey()` declared TWICE in one function.
  Turbopack compile error: "the name 'key' is defined multiple times".
- Why the WHOLE GLOBAL MARKET died: Next App Router compiles API routes with
  the page graph. Visiting /market/multichain compiled hydrate-stats which
  imported the broken file. Overlay, not a runtime 500. Browser refresh
  cannot clear it.
- GitHub was fixed (rename openSeaApiKey, rewrite, delete file, inline
  route). Operator's Next PID held .next; Remove-Item .next failed while
  node listened on 3800. Overlay kept showing the GHOST 110-line file.
- Recovery: kill Next PID, wipe .next, stub the stats module (no-op),
  disable hydrate POST, restart `next dev -p 3800`. Hub came back.
- ff6a731 = restore compile. 17c39ae = hydrate again but ONLY inside
  hydrate-stats/route.ts (no second `const key` file). Stub remains so an
  old import cannot crash. Visible-page hydrate: CoinGecko
  /nfts/{platform}/contract/{address}, then OpenSea /stats + num_owners,
  ME /stats for Solana. Max 6 contracts. Bitcoin skipped.

HEAD around 17c39ae on dev. Do not merge to master.


4. PER-CHAIN STATS SOURCES (ETH-LIKE CELLS, NO ALCHEMY NFT)
-----------------------------------------------------------
| Chain | Floor / listed | 24h volume/sales | Holders |
| ETH/Base/OP/Arb/Polygon/BNB/Avax | OpenSea listings/sync + hydrate /stats | CoinGecko NFT by contract (keyless demo) then OpenSea intervals | CG unique addresses or OS num_owners |
| Solana | Magic Eden /stats (keyless) | CoinGecko platform solana | ME uniqueHolders |
| Bitcoin | UniSat / OW catalog | CoinGecko ordinals slug cron (exact match only) | none yet |
| Robinhood native | market_orders / Seaport | chain-indexer / vault fills — NOT OpenSea | not Alchemy |
| Robinhood scan shells | none until OS stats | none | none |

Cron (prod later): scripts/refresh-market-data.ts  scaffold-rarity,
scaffold-rarity-solana, coingecko-solana-stats, coingecko-bitcoin-stats.
Local DB ≠ prod. Never fabricate volume for 3477 Avax rows in one paint.


5. RARITY (ALREADY THE KERNEL — DON'T REINVENT)
-----------------------------------------------
lib/rarity.ts and lib/rarity-generic.ts: informationContent = −log2(count/N).
Official Background-like trait; spam serials excluded; zero-score → Common.
indexRarityForCollectionLookup: solana→Helius, bitcoin→UniSat (always
partial), 0x→OpenSea slug, else OpenSea slug. zkSync openSeaChain null.
On-demand enqueue if empty OR stale first-pass 1k/2k/5k.
scoreTokenAgainstTraitIndex: listed mint not in table still scores vs index.


6. WHAT TO BUILD NEXT (OPERATOR JUST ASKED)
-------------------------------------------
A. Grade RobinWood on the hub (screenshot: Grade column is "—" on row 1).
   Today gradeBreakdown requires artOk && hasMarketEvidence (floor OR
   listed>0 OR volume OR sales). Empty local book → ungradable.
   REAL signals to add (do not invent volume):
   - isNativeHome (this IS the curated collection, MARKET_COLLECTIONS).
   - isVaultBacked + live V3 vault 0xacE28f72Fc3e15eA1671e689806694A9b0cE047D
     (Premium Plank Liquidity) = decentralized NFT/ETH AMM. Read on-chain
     reserve/TVL if you show a number; presence of the vault is already real.
   - trustBadges already on the collection: lp-burned, ownership-renounced,
     verified.
   - Live Seaport listedCount/floor when getListings returns rows.
   gradable should be true for isNativeHome even if the book is empty THIS
   machine, because the collection and vault are real mainnet facts — but
   do NOT fake a floor or 24h volume. Letter from vault+verified+art, not
   from a made-up book.

B. Decentralized liquidity as a grade axis (all collections, not only us)
   Only if a REAL source says there is a pool/vault:
   - Our V3 for RobinWood.
   - NFTX / Sudoswap / Flooring Protocol / similar ONLY when you can
     resolve a contract from a public registry or on-chain, not a guess.
   Points only when verified. Breakdown label must name the source.

C. RWA / stock-backed NFTs
   Same rule: real value only. Possible honest sources later:
   - Collection metadata / official docs (Backed, Dinari, etc.) if
     contract allowlisted.
   - OpenSea category if they publish it — confirm live before using.
   Do NOT mark scan shells as RWA because the art looks like a ticker.
   New optional field on the hub row, fail closed null.

D. Wrong names / titles (ERC721, hex, "..")
   Those are OpenSea-robinhood-scan + on-chain name() (often "ERC721").
   Fix: OpenSea collection `name` / `image_url` via hydrate or the existing
   updateCollectionDisplay path in rarity-index-runner — exact contract
   match, never fuzzy. Keep hex as subtitle. Don't invent display names.

E. Hydrate safety (do not regress)
   ALL OpenSea/CG fetch for hub cells stays in
   app/api/market/multichain/hydrate-stats/route.ts
   Never reintroduce lib/market/multichain/opensea-collection-stats.ts as a
   second copy of getOpenSeaApiKey. Stub there must remain a 10-line no-op
   so leftover imports cannot crash compile.
   After any hydrate change: kill Next, delete .next, `npx next dev -p 3800`.
   Turbopack will otherwise keep the ghost overlay.

F. Tests
   node --import tsx --test test/market/marketplace-harness.test.ts
   node --import tsx --test test/market/rarity-generic.test.ts
   npx tsc --noEmit
   Add a test: isNativeHome is gradable without fabricated volume.


7. CLICK PATHS (LOCAL ONLY)
---------------------------
http://localhost:3800/market
http://localhost:3800/market/multichain
http://localhost:3800/market/multichain?chains=robinhood
http://localhost:3800/market/multichain?chains=opt-mainnet
http://localhost:3800/market/multichain?chains=base-mainnet
http://localhost:3800/market/multichain/solana-mainnet/Claynosaurz
http://localhost:3800/market/multichain/solana-mainnet/Claynosaurz?show=all
https://plank.tanggang.life is OLD MASTER. Do not use it to judge this work.


8. KEY FILES
------------
lib/rarity.ts
lib/rarity-generic.ts
lib/market/multichain/rarity-index-runner.ts
lib/market/multichain/discovery/helius-rarity-index-runner.ts
app/api/market/multichain/route.ts          (native RobinWood inject)
app/api/market/multichain/rarity/route.ts
app/api/market/multichain/listings/route.ts
app/api/market/multichain/hydrate-stats/route.ts
app/api/market/multichain/solana-verify-listing/route.ts
app/api/market/multichain/solana-buy-instruction/route.ts
components/market/GlobalMarketHub.tsx       (pin, filters, grade)
components/market/MultichainCollectionView.tsx
lib/market/multichain/trading/foreign-fulfill.ts
lib/market/multichain/opensea-collection-stats.ts  (STUB only)
scripts/refresh-market-data.ts
test/market/marketplace-harness.test.ts


9. DIRECT INSTRUCTION TO THE RECEIVING GROK
-------------------------------------------
1. Stay on `dev`. No master merge, no InMotion deploy.
2. Grade RobinWood with REAL vault + native-home + listings if present.
   Empty book → still gradable as home/vault; cells for floor/volume stay
   dash if unsourced.
3. Extend gradeBreakdown with optional real liquidity / RWA parts, sourced
   or omit. Show the source in the badge breakdown.
4. Fix display names from OpenSea collection meta on exact contract match.
5. Do not resurrect a second stats TypeScript file with `const key`.
6. If the red overlay returns, it is Turbopack cache: kill node on 3800,
   delete .next, `npx next dev -p 3800`.
7. Keep fail-closed. Keep Alchemy NFT off.
