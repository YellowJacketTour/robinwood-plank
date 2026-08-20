# Handoff: multichain 24h data, Bitcoin listing security audit, Solana Sell tab — for bullish0x

Branch: `dev`
Commit: `6057de7` (pushed directly to `dev`, not a feature branch — see
"Why this didn't follow the normal branch-per-PR flow" at the bottom)

## What changed for users/operators, in priority order

### 1. Real 24h Change/Volume/Sales, where none existed before (any chain)

**The bug**: every chain's rankings table showed `–` for 24h Change/
Volume/Sales except EVM collections with a resolvable OpenSea slug. Root
cause, confirmed by reading the code: `updateCollectionMarketStats`
(`lib/market/multichain/store.ts`) had exactly ONE real caller anywhere
in the codebase — `rarity-index-runner.ts`'s OpenSea-stats fetch — which
structurally cannot cover Bitcoin, Solana, or Robinhood Chain's own
community collections (no OpenSea presence at all, private L3).

**Two real fixes, both live-tested against a real local Postgres this
session** (not just type-checked — see "What was actually run" below):

- **EVM, all 8 foreign chains + Robinhood**: `plank_seaport_fills`
  (migration `023_seaport_fill_index.sql`) — a first-party, self-hosted
  on-chain indexer watching Seaport's `OrderFulfilled` event directly —
  was fully built and populated by `seaport-fill-indexer.ts` but **had
  zero consumers anywhere in the codebase**. New function
  `updateEvmVolumeFromSeaportFills` (`store.ts`) aggregates it into real
  24h volume/sales per collection, wired as a new `evm-fill-stats` step in
  `scripts/refresh-market-data.ts`.
- **Solana + Bitcoin Ordinals**: new adapter
  `lib/market/multichain/discovery/coingecko-nft-stats.ts`, using
  CoinGecko's free public NFT API (`api.coingecko.com/api/v3/nfts/*`, no
  key required to read — a free Demo key, registration only, raises the
  rate limit from 5-15/min to 100/min). **Live-verified with real API
  calls this session**: real `volume_24h`/`one_day_sales`/floor-change for
  a real Solana collection (Aurorians) and a real Bitcoin Ordinals
  collection (Aeons/Bitcoin Frogs). **Exact-slug matching only, never
  fuzzy** — a collection this can't exactly match against CoinGecko's own
  `id` stays `null`, on purpose (see the file's own header for why fuzzy
  matching was explicitly rejected: attaching one collection's real stats
  to a different, wrong collection is worse than staying empty). Wired as
  two new steps, `coingecko-solana-stats` and `coingecko-bitcoin-stats`.

**Real, current limitation, not hidden**: CoinGecko doesn't track every
collection this app tracks. A live test run matched 11 of 61,162 tracked
Solana collections and 67 of 2,629 tracked Bitcoin collections. The rest
are either genuinely illiquid (no real volume anywhere to report — the
zero-`num_minted` filter below already excludes the worst of these) or
just not in CoinGecko's own dataset. This is a real ceiling, not a bug —
see `docs/marketplank/GROK-RESEARCH-BRIEF-total-coverage-data-warehouse-
2026-08-20.md` for the open research question on further source
redundancy.

### 2. Solana collection-discovery was registering permanent spam

**The bug**: Solana showed 60,000+ "tracked collections," most with no
real data ever, growing without bound. Root cause: `helius-collection-
scan.ts`'s only registration filter was "has a name or an image" —
Metaplex Core is permissionless (free to create), so every dead/spam
collection Core has ever seen was being registered forever.

**Fix**: added `shouldSkipZeroMemberCollection`, gated on Core's own real
`mpl_core_info.num_minted` field (live-verified against a real Helius
`searchAssets` call this session — confirmed real, not guessed). A
collection with zero minted members structurally cannot ever have real
trading data. Only skips on a CONFIRMED zero — never on a missing field
(absence of data is not evidence of zero). 5 regression tests in
`test/market/helius-collection-scan-quality-filter.test.ts`.

**Not yet run against production data**: `scripts/cleanup-solana-casing-
duplicates.ts` — a real, dry-run-by-default (`--apply` to execute) script
for a separate, already-fixed bug (contract addresses force-lowercased
before the case-sensitivity fix landed, corrupting Solana pubkeys). Proven
correct against a synthetic test pair in a local DB this session. Ready
to run against production whenever there's real DB access — see "What I
could not do" below.

### 3. Bitcoin native listing engine — real Opus security audit, all 5 findings closed

A full security audit (Opus-level review, not a lighter pass) of
`lib/market/multichain/trading/native-bitcoin-listing.ts` and its 4 API
routes found it **passes for testnet4 piloting, fails for mainnet**, with
one CRITICAL finding: nothing verified a listing's claimed `inscriptionId`
actually lived on the UTXO being listed — a real, working fraud primitive
(list a worthless UTXO under a blue-chip inscription's real id; a buyer's
fully-valid transaction pays real money for a worthless sat,
irreversibly). All 5 findings closed this session:

- **C1/C2 (CRITICAL)**: real inscription-to-UTXO binding verification via
  UniSat's own indexer (`getInscriptionIdsOnUtxo`, new function in
  `bitcoin-utxo-safety.ts`), checked at BOTH listing-creation time
  (`app/api/market/multichain/native-bitcoin-listings/route.ts`) and
  fulfillment time (auto-invalidates the listing if the inscription moved
  since listing — `app/api/market/native-bitcoin-listing/[id]/fulfill/
  route.ts`). Fails closed (503) if the indexer itself is unreachable,
  never silently trusts the claim.
- **H1**: the burn-prevention math (the single most safety-critical number
  in the file, per its own header) now sources the seller UTXO's value
  from the SIGNED PSBT itself, never the database — closes a "coincidence,
  not a guarantee" gap.
- **H2**: a real seller-cancel flow (`buildCancelProofPsbt`/
  `verifyCancelProofPsbt`, new functions, plus two new routes
  `native-bitcoin-listing/[id]/cancel-build` and `.../cancel`). Reuses
  this app's own already-proven signing primitive instead of adding a new
  dependency (BIP-322 was considered and rejected) — a self-send PSBT
  signed `SIGHASH_ALL`, a different sighash domain than the listing's
  `SIGHASH_SINGLE|ANYONECANPAY`, so a listing signature and a cancel
  signature can never be confused for one another BY CONSTRUCTION. 5
  adversarial tests (wrong key, wrong UTXO, wrong sighash domain, garbage
  input — all correctly rejected).
- **H3**: `NativeBitcoinListingsPanel.tsx` was hardcoded to testnet4. Now
  reads the real `NATIVE_BITCOIN_MAINNET_ENABLED` flag server-side
  (`app/market/bitcoin-listings/page.tsx`, a server component) and passes
  it down as a prop — flipping the env var now correctly and
  automatically flips every mempool.space URL in the panel, no separate
  manual step to forget.

**Real, live-piloted this session**: the owner personally drove a full
connect → pick-a-real-inscription → sign → list flow through an actual
UniSat browser extension on testnet4 and confirmed it worked (after
finding and fixing a real bug along the way — validation error messages
were being silently discarded by `publicError()` because they were plain
`Error` instances, not `TradeApiError`; all 9 throw sites in
`native-bitcoin-listing.ts` converted).

**`NATIVE_BITCOIN_MAINNET_ENABLED` should stay unset** until real,
extended testnet4 piloting (multiple real purchases, not just one) proves
the new binding-verification code correctly rejects a real mismatch case,
not just the offline test suite.

### 4. Solana Sell tab (new)

Real end-to-end path: `app/api/market/multichain/solana-sell-instruction/
route.ts` (wraps Magic Eden's real `/instructions/sell` and `/sell_now`),
`listSolanaTokenNow()` in `foreign-fulfill.ts`, and
`components/market/NativeSolanaListForm.tsx`, wired into
`MultichainCollectionView.tsx`'s Sell tab for Solana collections. Single-
price-mode only (no bundle listing yet — Solana's Auction House has no
native multi-item atomic listing primitive the way Seaport does).
**Inert until `MAGICEDEN_API_KEY` is configured** — fails closed with a
clear 400/503, same posture as every other keyed adapter in this app.

### 5. Real RPC fallback after Alchemy's key hit its monthly quota mid-session

`foreignRpcUrls()` (`foreign-chain-registry.ts`) now returns Alchemy
FIRST, then a free PublicNode fallback URL, per chain.
`scanAllChainsForFills` (`seaport-fill-indexer.ts`) now actually tries
every URL in that array in order instead of hardcoding `[0]` — a real bug
this session found while debugging the live Alchemy outage. **Live-tested
against the real quota-exhausted key**: Polygon and Optimism now succeed
via the PublicNode fallback; eth/arb/base/bnb-mainnet hit PublicNode's
own "archive requests require a personal token" limit (a real, different,
still-open constraint — see the emergency RPC brief below).

### 6. UI consistency pass (real chain-logo icons, fluid text, layout fix)

`ChainIcon.tsx` now renders the REAL official brand SVGs (from
`spothq/cryptocurrency-icons`, MIT-licensed) for Ethereum/Bitcoin/Solana/
BNB/Avalanche/Polygon, replacing hand-approximated shapes. Fluid
`clamp()`-based text sizing across price displays (scales with
viewport/zoom instead of snapping at breakpoints). One real regression
found and fixed live: the price+Buy-button row in `ListingCard.tsx` used
to switch to a side-by-side layout at `sm:`, but this app's grid is
auto-fill with a 180-200px column floor — card width barely changes
across breakpoints, so side-by-side kept getting squeezed at real column
counts other than the one first tested. Now always stacks vertically
(full-width Buy button, bigger tap target as a side effect) — proven safe
at 360px/640px/1253px/1440px via direct DOM measurement, not just visual
spot-check.

## Real research briefs written this session (not yet acted on by Grok — hand these off as-is)

- `docs/marketplank/GROK-RESEARCH-BRIEF-full-multichain-parity-2026-08-20.md`
  — trait/criteria offers, sweep/bundle UX, and full feature parity across
  every chain (the vault/Global Index features are the only ones meant to
  stay chain-limited, per the owner's own explicit exception).
- `docs/marketplank/GROK-RESEARCH-BRIEF-universal-24h-volume-sales-2026-08-20.md`
  — superseded in part by what actually shipped this session (see #1
  above), but the deeper Bitcoin/Solana universal-sale-detection research
  questions in it are still open.
- `docs/marketplank/GROK-RESEARCH-BRIEF-EMERGENCY-free-rpc-fallback-2026-08-20.md`
  — the RPC swarm strategy; PublicNode is now wired in as a first real
  step, the rest (dRPC, Chainstack, HyperSync-for-archive-logs) is still
  open.
- `docs/marketplank/GROK-RESEARCH-BRIEF-total-coverage-data-warehouse-2026-08-20.md`
  — the long-term "every real cell filled, maximum redundancy" swarm
  architecture. Explicitly disqualifies any design that fabricates data
  for a genuinely dead collection — real ceiling, not negotiable.

## What was actually run (per CONTRIBUTING.md's required-checks list)

- `npx tsc --noEmit` — clean, run repeatedly throughout the session after
  every real change.
- `npm test` (`test:market` — the full `test/market/*.test.ts` suite) —
  680 passing, 4 skipped (pre-existing, unrelated to this session), 0
  failing. Includes 5 new test files added this session (Bitcoin
  inscription-binding, cancel-proof adversarial cases, Helius quality
  filter).
- `npm run lint:inmotion` — clean.
- **`npm run build` was NOT run this session** — flagging honestly per
  this repo's own PR-description requirement rather than silently
  omitting it. Should be run before merging to `master`.
- `npm run test:contracts` — not applicable, no contract changes.
- `npm run test:postgres` — not run; storage-shape changes here are
  additive-only (new columns/tables were NOT added — `updateCollection
  MarketStats` and `plank_seaport_fills` both already existed from prior
  sessions, this session only added new callers), but this should still
  be run before merge per the storage-changes rule.

## What I could not do (real, external blockers, not skipped by choice)

- **No production database or server access.** Every fix in this handoff
  was live-tested against a real, correctly-configured LOCAL Postgres
  this session found running on `127.0.0.1:55556` (the real port in
  `.env.local` — an earlier connectivity test this session mistakenly
  used the default port 5432 and wrongly concluded nothing was reachable;
  that was corrected mid-session). **This is a local database, not
  production** — real collections, real API responses, but a different
  dataset than what's live on `plank.tanggang.life`. The Solana casing-
  duplicate cleanup script and the full-scale CoinGecko/EVM-fill sync
  passes still need to run against the real production database.
- **Alchemy's API key hit its real monthly capacity limit** mid-session
  (`eth_blockNumber: Monthly capacity limit exceeded`) — needs either a
  plan upgrade or the monthly reset. The PublicNode fallback added this
  session is a real mitigation, not a full fix (4 of 8 EVM chains still
  blocked by PublicNode's own archive-range limit).
- **`MAGICEDEN_API_KEY` still not configured** — blocks Solana buy/sell/
  sweep from actually executing (the code paths are real and tested, just
  inert without the key, same fail-closed posture as every other keyed
  adapter).

## Why this didn't follow the normal branch-per-PR flow

The owner directed this session's work be pushed to `dev` directly given
real time pressure (approaching a weekly usage limit) rather than opened
as a feature-branch PR per the repo's own default `CONTRIBUTING.md`
policy. This is a deliberate, explicit exception for this one push, not a
new standing practice — the next change should go back through the normal
`git switch -c <type>/<short-description>` → PR-against-`dev` flow.
`master` was never touched; merging `dev` into `master` remains bullish0x's
own explicit release decision, same as always.
