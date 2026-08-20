ONESHOT for Grok (continue Marketplank / robinwood-plank) — 2026-08-20 late
===========================================================================
Paste this WHOLE file into a NEW Grok chat. Work in
C:\Users\k1rby\projects\robinwood-plank  on branch `dev`.
Operator local: http://localhost:3800  (Next). Prod is InMotion from `master`
only: plank.tanggang.life — DO NOT merge `dev`→`master`, DO NOT deploy.

Repo: YellowJacketTour/robinwood-plank
Compare: https://github.com/YellowJacketTour/robinwood-plank/compare/master...dev
This file: docs/marketplank/ONESHOT-GROK-GLOBAL-MARKET-2026-08-20.md
Also copy: C:\Users\k1rby\Desktop\ONESHOT-global-market-dev-handoff-for-grok-2026-08-20.txt
Intent: docs/marketplank/HANDOFF-BULLISH0X-GLOBAL-MARKET-2026-08-20.md
PRs: against `dev` (bullish0x). Next change: branch off origin/dev.

Home NFT: 0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156  chainId 4663 (Robinhood)
Vault V3: 0xacE28f72Fc3e15eA1671e689806694A9b0cE047D
Native UI: /market     Global hub: /market/multichain
Seaport 1.6 native. Collection slug for native listings: "robinwood"


================================================================
0. YOUR JOB (OPERATOR, THIS MESSAGE)
================================================================
Research and invent the most fool-proof, exhaustive, AUDITED data path
for ALL chains, ALL collections, ALL traits, ALL rarities — each chain
a BESPOKE spoke, wired, fail-closed, never fake-filled.

Operator screenshots (same session) prove the gap:
  BNB: names like "_-l_", "<< WK Cartoon Football >>", "0x100f…4eca",
       "币安人生NFT" — some art, ALL ranking cells "—", grades empty.
       Earlier BNB also showed etherscan URL / vandals scam titles
       (fixed in 786eb7f isSpamCollectionTitle — keep that gate).
  Avalanche: 3477 rows, titles are truncated hex 0x000a…4dd4, cards
       say ART PENDING, every cell dash, LRT/HEND placeholder thumbs.
  Base: BEST current spoke — Layer3 CUBE, Signal Shards, Basenames,
       Beezie, Ddrv, RoarMads have REAL floors, 24h volume, sales,
       holders, grades A/B/C. Still missing Listed on most; 24h Change
       often 0.0% or dash; Signal Shards 100% listed of 1 is shell-like.
  Arbitrum: names exist (Bioframe Ascendant etc) and floors exist
       (ETH) but 24h volume/sales/change almost all dash; Listed is
       "0.1% 1" (one listing / huge supply) — grade B on floor+jpeg
       is still too generous if operator wants ETH-standard evidence.
  Robinhood: RobinWood row is GRADED B but Floor/Listed/Volume/Sales
       are ALL dash. Operator says the REAL RobinWood floor exists
       (native Seaport book on /market). You MUST source it from
       getListings("robinwood") WITHOUT requiring chain_slug (NULL
       rows). If /market Buy&Sell is also empty, dash is honest —
       then the work is to INDEX/SHOW the real book, not invent ETH.
  Duplicate "Ddrv" rows on Base — do not merge by fuzzy name; exact
       contract only. Investigate duplicate tracking.

Success = every VISIBLE ranked row has:
  legitimate name (never hex, never URL, never ERC-721 name() junk
    unless that IS the on-chain identity AND OpenSea/ME/CG has no
    better exact slug match)
  legitimate image (or hide the card; never LRT/HEND placeholder as
    "the collection")
  floor from a real book (OpenSea stats, ME stats, UniSat, native
    listings min price, CoinGecko exact id) — never guessed
  listed count from that book
  24h volume/sales from OpenSea interval, CG, ME, or first-party
    plank_seaport_fills — never 0 fabricated
  holders only if adapter returned a real owner count
  rarity/traits on COLLECTION PAGE via −log2 kernel, not hub table
  grade only if hasGradeEvidence (listed OR volume OR native home +
    real vault) — never A/B for floor+jpeg shells

Dash with a reason > fake 0. Exact-match only. Do not prune Avalanche
like Solana. Do not restyle native /market. No hover mega-menus.
Alchemy NFT API FORBIDDEN (monthly 429). Instant Swap/vaults for
foreign collections = later. Across/deBridge/0x flags stay off.


================================================================
1. KEEP THE SITE UP WITHOUT HANGING THE AGENT
================================================================
Next MUST run in its OWN window, not a Grok-owned foreground command.

  START-MARKET.bat  (repo root) → start "Marketplank :3800" cmd /k
  npx next dev -p 3800

Do NOT use START.bat (that is PlankCrash / Hardhat).
If :3800 already LISTENING, leave it. Kill+wipe .next ONLY if compile
overlay / ghost modules (Turbopack held PID 13936 once).
Verify: Invoke-WebRequest http://localhost:3800/market/multichain
Hub GET stays snapshot-read. Heavy work = scripts in separate cmd.

  npm run market:spokes
  npx tsx scripts/spoke-backfill.ts --minutes=8
  npx tsx scripts/spoke-backfill.ts --spoke=evm-opensea-stats --minutes=8
  npm run market:refresh            # incremental cron
  npm run market:refresh:full       # daily; includes rarity scaffold

Spoke worker MUST NOT be imported into App Router page graph.
Previous crash: duplicate `const key` in a hydrate module imported by
the page. Hydrate lives in
  app/api/market/multichain/hydrate-stats/route.ts
Stub:
  lib/market/multichain/opensea-collection-stats.ts  (no-op, keep stub)


================================================================
2. SPOKE MAP (ALREADY IN REPO — EXTEND, DO NOT REPLACE)
================================================================
lib/market/multichain/spokes.ts  +  scripts/spoke-backfill.ts

id                     chain            cells                 source
evm-opensea-stats      EVM w/ OS        floor,vol,sales,name  OpenSea v2 slug EXACT
evm-seaport-fills      EVM+Robinhood    vol,sales             plank_seaport_fills
solana-magiceden       solana           floor,listed,name     ME keyless
solana-helius-rarity   solana           ranks,traits          DAS + −log2 cap 12k
solana-coingecko       solana           vol,sales,floor       CG platform=solana exact id
bitcoin-unisat         bitcoin          floor,listed,name     UniSat
bitcoin-unisat-rarity  bitcoin          ranks,traits          ALWAYS partial
bitcoin-coingecko      bitcoin          vol,sales             CG ordinals exact slug
robinhood-native       robinhood        floor,listed,grade    getListings("robinwood")
adapter-sync           *                snapshot fields       staleness queue, batch 800

FOREIGN_CHAINS (lib/market/multichain/trading/foreign-chain-registry.ts):
  eth-mainnet 1 ethereum
  polygon-mainnet 137 matic
  arb-mainnet 42161 arbitrum
  base-mainnet 8453 base
  opt-mainnet 10 optimism
  bnb-mainnet 56 bsc
  avax-mainnet 43114 avalanche
  zksync: openSeaChain NULL — skip OpenSea, native only

Discovery already exists (do not rewrite):
  evm-log-scan, hypersync-evm-scan, opensea-bulk-scan,
  unisat-collection-list-scan, ordiscan-collection-scan,
  helius-collection-scan, robinhood-chain-scan, opensea-robinhood-scan

Stats already exists:
  discovery/opensea-stats.ts  runOpenSeaStatsSync(chainSlug, batch)
  discovery/coingecko-nft-stats.ts  runCoinGeckoNftStats(platform, n)
  scripts/opensea-stats-sync-pass.mjs
  scripts/coingecko-nft-stats-sync-pass.mjs
  store.updateEvmVolumeFromSeaportFills
  lib/market/multichain/sync.ts  runMultichainSync (fair staleness)

Rarity:
  lib/rarity.ts native Base/Background/Holographic −log2
  lib/rarity-generic.ts competition rank + dual percentile + spam trait filter
  rarity-index-runner.ts (EVM)
  helius-rarity-index-runner.ts (Solana; resolve ME symbol → mint; dual-write)
  unisat-rarity-index-runner.ts (Bitcoin; always partial)
  scripts/index-foreign-rarity.ts  scripts/scaffold-all-collections.ts

Titles:
  lib/market/collection-title.ts  isSpamCollectionTitle
    (http, explorers, buying transaction, vandals, gorillaPool,
     length>80, ^[-_*\s.]+$)
  isHexLikeCollectionName in opensea-stats.ts — never store hex as title

Budget:
  discovery/source-budget.ts daily ceilings + jail on 429
  CoinGecko monthly 9000 under 10k demo
  Alchemy NFT API do not call
  ME 400ms pace (180/min advertised)
  UniSat/Ordiscan 500ms


================================================================
3. ROBINWOOD FLOOR — THE CONCRETE BUG TO FIX FIRST
================================================================
Hub injects native collection in
  app/api/market/multichain/route.ts
Must call getListings("robinwood") WITHOUT forcing chain_slug
(17c39ae). Then floor = min live listing price in native wei/ETH,
listedCount = book size.

If still dash: query market_orders locally (Postgres). If rows exist
with collection_slug robinwood and expires_at > now, the inject is
wrong. If zero rows, /market is empty too — operator must list, OR
you index on-chain Seaport OrderFulfilled / OrderValidated for 4663
via existing seaport-fill-indexer + book — still fail closed if none.

Grade: isNativeHome + isVaultBacked (V3 address above) is allowed
without fake volume (5c99b23). Floor still must be real or dash.

Do not invent 0.001 ETH.


================================================================
4. NAMES AND QUALIFICATIONS — NO JUNK IN RANKINGS
================================================================
Hub: components/market/GlobalMarketHub.tsx
  isSpamCollectionTitle, displayName, isHomeRow, hasGradeEvidence,
  listedPctOf requires listed>0, pin native first,
  one-chain skip art/shells (let BNB identity through BUT spam filter
  must still drop URL/vandals/hex-only titles).

For Avalanche/BNB hex titles:
  1. Resolve OpenSea slug from chain+contract (opensea-stats resolveOpenSeaSlug)
  2. If OS returns a human name, updateCollectionDisplay
  3. If OS name is hex-like, keep dash name / hide from trending
  4. Never fuzzy-match another collection's name onto this contract

ART PENDING cards: no image_url in snapshot. Either hydrate from OS/ME
or exclude from "trending (graded)" until image exists.

Duplicate Base "Ddrv": two contracts, two rows — correct unless they
are the same address. Confirm before collapsing.


================================================================
5. WHAT `dev` ALREADY SHIPPED (DO NOT RE-LITIGATE)
================================================================
HEAD origin/dev around 786eb7f (local also has uncommitted:
  START-MARKET.bat, lib/market/multichain/spokes.ts,
  scripts/spoke-backfill.ts, package.json market:spokes)

786eb7f  BNB scam-title reject
0317678  ETH-standard cells; no fake 0 sales; no hex titles;
         no B-grade on floor-only shells; BNB visible when filtered
5c99b23  one-shot + RobinWood grade from native+vault
17c39ae  hydrate-in-route; RobinWood listings without chain filter
ff6a731  restore compile; disable page-graph stats hydrate
+ Claynosaurz mint resolve, tokenName, ME pagination offset 200,
  rarity resume 1k/2k/5k, Solana verify via listing escrow,
  migration 030_collection_integrity.sql (safelist/nsfw),
  listCollectionsForSync staleness (Solana was starved alphabetically)

Uncommitted work is the spoke catalog + detached START-MARKET +
spoke-backfill. Commit on a feature branch off origin/dev, PR to `dev`.


================================================================
6. INFRA
================================================================
Next 16 App Router + Turbopack. Postgres (PGHOST etc) = durable store.
plank_multichain_collections + plank_multichain_snapshots
plank_foreign_rarity
plank_seaport_fills
market_orders (native Seaport)
Non-EVM addresses are case-sensitive (Solana base58). EVM lowercased
in store.normalizeContractAddress.

InMotion Passenger = `master` only. Local .env for keys:
  OPENSEA, COINGECKO_API_KEY (demo), HELIUS, UNISAT, ENVIO_API_TOKEN
  NEVER Alchemy NFT quota.

Tests: npm run test:market  (tsx --test test/market/*.test.ts)
Do not add exploit PoCs. Fail closed.


================================================================
7. RESEARCH YOU MUST DO (THEN WIRE, THEN AUDIT)
================================================================
For EACH chain tab the operator showed empty or partial, write a
short audit (real HTTP against live APIs, not assumed):

  BNB bsc     — OpenSea collections+stats for the 10 visible contracts
  Avalanche   — why 3477 hex shells: bulk scan without display hydrate;
                pace OS stats for the visible window first, not 3477
  Base        — copy this quality to other EVM spokes; fill Listed from
                OS listings count if stats expose it; 24h change only
                if OS/CG returns floor_price_24h_percentage_change
  Arbitrum    — floors exist, volume missing: runOpenSeaStatsSync
                intervals one_day; if OS 429, jail, don't zero
  Robinhood   — native book + OS robinhood chain list for community
                names (11111zq3, 1337 RH, 3D Chungos already have vol
                from fills — RobinWood must join that path)

Then rarity: collection pages, not hub. Enqueue scaffold-rarity for
collections the user actually opens; do not stampede 15k.

Traits: generic −log2; spam trait filter; official-tier detect.

Wash/stolen: only if a real source exists; do not invent flags.

Budget: visible rows first (hub window 10/25/50/100), then staleness
queue. Never 15k fan-out in the request path.


================================================================
8. HARD NO
================================================================
- merge dev→master / push public
- Alchemy NFT API
- fabricate floors, names, images, ranks, volume, holders
- import a second OpenSea hydrate into GlobalMarketHub / page graph
- hover mega-menus on /market
- Instant Swap for foreign
- fuzzy name attach
- prune Avalanche
- restyle native /market
- hang Next on the agent command (use START-MARKET.bat)
- claim cells "done" without a sourced snapshot write + UI readback


================================================================
9. FIRST 90 MINUTES
================================================================
1. Confirm :3800 up via START-MARKET.bat if needed.
2. SQL: live robinwood listings → wire hub floor/listed if rows exist.
3. Launch spoke-backfill in a second window; prioritize
   evm-opensea-stats for bnb-mainnet + avax-mainnet (visible 100).
4. Hide/spam-filter remaining hex and "_-l_" titles from rankings.
5. Commit on a branch, PR to `dev`. Do not merge to master.
6. Paste this file's "audit" notes into the PR: per-chain source,
   sample contract, HTTP status, fields written, fields still dash
   and WHY.

When you say a chain is "through and through," you mean: sampled
visible rows have names from OS/ME/CG/native, floors from a book,
volume from a 24h source or dash with jail/budget reason, rarity
kernel runs on open collection, traits stored, tests green.
Not: every cell on 15366 rows filled this afternoon.
