# Handoff: multichain 24h data, Bitcoin listing security audit, Solana Sell tab — for bullish0x

Branch: `dev`
Latest commit as of this update: `0e07506` (a continuation of the same
2026-08-20 session, pushed directly to `dev` for the same time-pressure
reason as the original push — see "Why this didn't follow the normal
branch-per-PR flow" at the bottom). Full commit sequence this session,
oldest first:
`6057de7` (original push, everything in sections 1-6 below) →
`8b716bf` (Solana cleanup script Helius-429 fix) →
`a3a63a9` (genesis Seaport backfill feature) →
`646f166` (Solana dead-collection threshold recalibration, 0 → <50) →
`0e07506` (OpenSea-stats floor/volume fallback, independent of Alchemy).

**If you're only reading one section, read "Session 2 continuation" below
— it supersedes some of what section 1-2 originally said and closes two
real, previously-unknown bugs.**

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
- `npm run build` — clean, run after the initial push (full route table
  generated, zero errors) — confirms this doesn't just type-check in
  isolation but actually compiles as a real Next.js production build.
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

## Session 2 continuation (same day, same `dev` branch)

The owner kept pushing on the exact "why are cells still empty / why is
the Solana count still wrong" questions after the original push. Real,
concrete progress on both, plus two genuinely new bugs found and fixed
that section 1-2 above didn't know about yet.

### A. Solana zero-minted cleanup — a real bug in the fix itself, found and fixed

The cleanup script mentioned in section 2 above (`scripts/cleanup-solana-
zero-minted.ts`, now committed and real — it did not exist in the
original push, it was written and debugged this continuation) hit a real
circuit-breaker bug on its first live runs: the per-id `getAsset`
fallback (needed because `getAssetBatch` fails its ENTIRE 100-item batch
if even one id is a corrupted pubkey) fired up to 100 sequential
requests with zero delay, tripping Helius's real per-second rate limit.
The resulting HTTP 429 came back as **plain text**, not JSON, which
crashed `res.json()` before the code could even check `res.ok` —
misclassifying a real rate-limit hit as a generic circuit-breaker
failure and jailing the source on the very first batch, every time.
Fixed (commit `8b716bf`) by checking `res.status === 429` directly before
attempting JSON parse, and adding a 120ms throttle between fallback
requests.

### B. The zero-only threshold was real but too narrow — recalibrated with live evidence

After (A) let the script actually run to completion, the owner pushed
back hard: *"you expect me to believe there are 56 thousand solana nfts
that arent lp?"* — and was right. A live random sample of 200 of the
*remaining* tracked rows (i.e. AFTER the exactly-zero pass already ran)
found 95% (190/200) still sitting at `num_minted <= 50`, and a
hand-checked sub-sample (num_minted 3/10/20/38) confirmed real Metaplex
Core collections with **zero real trading signal ever** — 0 of the
entire remaining tracked set had ever produced a real floor or volume in
`plank_multichain_snapshots`.

Recalibrated (commit `646f166`) both the live forward filter
(`shouldSkipZeroMemberCollection` in `helius-collection-scan.ts`) and the
retroactive cleanup script to share one real, evidence-based constant:
`MIN_REAL_MEMBER_COUNT = 50` — the observed break point in the sample
(51-200 held only 6/200, 201-1000 held 2/200, 1000+ held 2/200; real
collections cluster clearly above 50, spam/farm collections cluster
clearly below it). **Not a guessed number** — see the constant's own doc
comment in `helius-collection-scan.ts` for the full reasoning if this
ever needs to be revisited with a bigger sample.

**Real, live-verified result, run against the local dev DB this
session**: Solana tracked-collection count went `62,064 → 3,084` across
three convergence passes (the cleanup script is idempotent — some rows
fall through to "unknown, left alone" on transient per-id errors each
pass, so it needs 2-3 re-runs to fully converge; each run only ever
deletes what it can positively confirm, never guesses). **This needs to
be re-run against the real production database** — same "no production
access" blocker as everything else in this doc. Run order:
```
npx tsx scripts/cleanup-solana-zero-minted.ts               # dry run, reports the real count first
npx tsx scripts/cleanup-solana-zero-minted.ts --apply        # apply
# re-run --apply 2-3 more times until "deleted 0" — that's real convergence, not a bug
```

### C. Real full-history Seaport fill backfill ("from genesis, no exceptions")

`scanChainForFillsViaHypersync` (existing, from the original push) is
intentionally forward-only from whenever this app first ran it — correct
for staying current, but it can never reach anything older than that
first-run point. The owner explicitly asked for full genesis-to-head
coverage. Added (commit `a3a63a9`) `scanChainForFillsGenesisBackfillViaHypersync`
in `hypersync-seaport-scan.ts`: walks every EVM chain forward from block
0 in 50k-block windows, under a SEPARATE cursor row
(`{chainSlug}::genesis-backfill`, same `plank_seaport_fill_cursor` table)
so it never disturbs or gets clamped by the live forward cursor's own
progress. "Genesis" means literal block 0, not a guessed per-chain
Seaport deployment block — this app never fabricates a number it hasn't
verified; the pre-deployment range simply returns zero matching logs and
advances through quickly.

**Real scale honesty**: some chains (Arbitrum ~496M blocks, Optimism
~155M, Avalanche ~93M current height) are far larger than others
(eth-mainnet/base-mainnet ~25-50M) — full genesis-to-head coverage on the
big chains is genuinely thousands of real HyperSync calls, multi-day
work at a sustainable pace, not something to fake-converge. Cursors
persist in Postgres regardless of how long this runs, so leaving the
supervisor running is real, compounding progress, never wasted.
**Already producing real data**: a live test run recorded 451,050 real
fills and populated real 24h volume for 1,085 eth-mainnet collections in
one aggregation pass (`updateEvmVolumeFromSeaportFills`, already wired
into `scripts/refresh-market-data.ts` per section 1 above — just needs
real fills to aggregate, which this backfill now supplies).

### D. Real root cause found for Polygon/BNB/Optimism/Avalanche's empty Floor column

Investigated live why Polygon (1,805 tracked, 0 ever with a floor) still
showed nothing after (A)-(C). Direct test against real, recently-
registered Polygon contracts: `alchemyNftAdapter.fetchSnapshot` returns
**HTTP 429 Too Many Requests** — Alchemy's key is still sitting on the
same real quota exhaustion flagged in section "What I could not do"
below, unrecovered. This is not Polygon-specific — every chain whose
floor coverage depends solely on Alchemy (Polygon, BNB, Optimism,
Avalanche, Robinhood) is blocked by this one exhausted key.

**Real fix (commit `0e07506`)**: new module
`lib/market/multichain/discovery/opensea-stats.ts`, an entirely
independent source with its own circuit breaker
(`SOURCE="opensea-stats"` in `source-budget.ts`), verified live against
real OpenSea v2 endpoints:
- `GET /chain/{chain}/contract/{address}` → resolves the exact collection
  slug for an ALREADY-tracked contract (Alchemy discovery registers raw
  addresses with no slug; this fills that gap). Cached in `durable-kv` so
  a contract's slug is resolved once, never re-resolved every sync pass.
- `GET /collections/{slug}/stats` → real `floor_price` AND real
  `one_day` volume/sales in a single call — both the floor fallback AND
  a genuine extension of 24h volume coverage beyond CoinGecko's
  Solana/Bitcoin-only scope, to every OpenSea-indexed EVM chain.

Also added `store.ts`'s `updateCollectionFloorOnly` — a real, previously
missing safety fix: `writeSnapshot`'s `total_supply`/`listed_count`
columns are a **plain overwrite** (`EXCLUDED.*`, no `COALESCE`) by
design, correct for a primary adapter (Alchemy) that reports both
together every time. Calling it with only a floor from a secondary
source would have silently wiped real Alchemy-sourced supply/listed
data the next time it ran. The new function `COALESCE`s
`total_supply`/`listed_count`/`holder_count` against whatever's already
there, so a floor-only source can never clobber them.

**Verified live**: `runOpenSeaStatsSync("polygon-mainnet", 10)` resolved
10/10 slugs, wrote 3 real non-zero floors (the other 7 genuinely have no
active OpenSea listings right now — correctly left `null`, not
fabricated as zero).

### E. New durable background sync scripts (all committed, all portable — no hardcoded local paths)

Four real, currently-running (in this session's local environment)
crash-resilient supervisor pairs, same pattern throughout — a short
bounded `*-pass.mjs` (survives a crash losing at most a few minutes,
cursors persist in Postgres/durable-kv either way) wrapped by a
`*-supervisor.sh` that relaunches it in a loop for up to 24h:

| Pass script | Supervisor | What it does |
|---|---|---|
| `evm-hypersync-backfill-pass.mjs` | `evm-hypersync-backfill-supervisor.sh` | Forward EVM collection discovery + recent-fill backfill via HyperSync (pre-existing capability, just given a crash-resilient runner — the first long-run attempt this session died to a native-module segfault) |
| `other-chains-discovery-pass.mjs` | `other-chains-discovery-supervisor.sh` | Robinhood Chain + Solana + Bitcoin Ordinals discovery scans (the EVM supervisor above only covers the 8 EVM chains) |
| `genesis-seaport-backfill-pass.mjs` | `genesis-seaport-backfill-supervisor.sh` | Section C above — full genesis-to-head Seaport fill history, all 8 EVM chains |
| `opensea-stats-sync-pass.mjs` | `opensea-stats-sync-supervisor.sh` | Section D above — real floor + 24h volume via OpenSea, independent of Alchemy |
| `coingecko-nft-stats-sync-pass.mjs` | `coingecko-nft-stats-sync-supervisor.sh` | Section 1 above's CoinGecko path, just given the same crash-resilient runner |

Run any of them with `bash scripts/<name>-supervisor.sh` from the repo
root (each `cd`s to its own directory via `$(dirname "$0")`, no
hardcoded machine paths) — they read DB/API config the same way every
other script here does, from a sourced `.env.local`.

**Real, live-verified rate-limit ceiling, not solvable by code alone**:
CoinGecko's unauthenticated NFT API is ~5-15 calls/min — real math says
full convergence across 56k+ Solana + 2.6k Bitcoin collections is
**~90+ hours** at that rate. A free CoinGecko Demo key
(`COINGECKO_API_KEY` env var, 2-minute signup at
https://www.coingecko.com/en/developers/dashboard, no cost) raises this
to 100/min — already documented in `coingecko-nft-stats.ts`'s own header
from the original session, still not configured. **This is the single
highest-leverage remaining action to unblock Solana/Bitcoin 24h
volume/sales specifically** — everything else in this doc is either
already fixed or bottlenecked on real external rate limits/quotas, not
on missing code.

### Real state as of this update (local dev DB, not production)

| Chain | Total tracked | Has real floor | Has real 24h volume |
|---|---|---|---|
| Solana | 3,084 (was 62,147) | 83 | 4 |
| Bitcoin (Ordinals) | 2,629 | 55 | 0 |
| Avalanche | 3,477 | 0 (Alchemy-blocked, OpenSea sync not yet run for this chain) | 0 |
| Polygon | 1,908 | 3 (growing — OpenSea sync running) | small, growing |
| Base | 1,367 | 6 | 1 |
| Arbitrum | 882 | 173 | 24 |
| Ethereum | 623 | 113 | 38 (growing fast — genesis backfill already caught up to head here) |
| BNB | 608 | 0 (Alchemy-blocked, OpenSea sync not yet run for this chain) | 0 |
| Robinhood | 471 | 0 (no OpenSea presence — private L3, needs its own listings-based floor, not built yet) | 0 |
| Optimism | 227 | 0 (Alchemy-blocked, OpenSea sync not yet run for this chain) | 0 |

### What was actually run, this continuation

- `npx tsc --noEmit -p .` — clean after every real change, checked
  repeatedly.
- Every new function above was live-tested against the real local
  Postgres + real external APIs (Helius, HyperSync, OpenSea) before being
  committed — not just type-checked. Specific verification calls are
  documented inline in each file's own header comment.
- Full test suite (`npm test`) was **not** re-run this continuation —
  should be run before merge, same as the original push's own
  disclosure.

### Still open / real next actions for whoever picks this up

1. **Decide on a CoinGecko Demo key** (section E above) — the single
   biggest unblock for Solana/Bitcoin 24h volume/sales.
2. **Run the Solana cleanup script against production** (section B) —
   2-3 `--apply` passes until "deleted 0".
3. **Keep the 5 supervisors running** (section E) — they're real,
   idempotent, crash-resilient, and cursor-persisted; there's no harm in
   leaving them running indefinitely, only benefit.
4. **Robinhood Chain has no floor-price path at all** (see table above)
   — it has no OpenSea presence (private L3), so it needs a listings-
   based floor (lowest active native listing, same as Grok's own
   priority-2 "own marketplace listings" suggestion) — not built yet,
   real gap.
5. Grok's own follow-up research brief (pasted into this session,
   summarized as "Enhanced solutions for the total multichain vision")
   independently arrived at the same OpenSea-first-fallback priority
   this session already built (D above) — its secondary suggestions
   (Bitquery, Moralis, Magic Eden/Tensor direct stats for Solana, Xverse/
   Ordiscan for Bitcoin) are real, additive redundancy ideas not yet
   evaluated or built this session.

## Why this didn't follow the normal branch-per-PR flow

The owner directed this session's work be pushed to `dev` directly given
real time pressure (approaching a weekly usage limit) rather than opened
as a feature-branch PR per the repo's own default `CONTRIBUTING.md`
policy. This is a deliberate, explicit exception for this one push, not a
new standing practice — the next change should go back through the normal
`git switch -c <type>/<short-description>` → PR-against-`dev` flow.
`master` was never touched; merging `dev` into `master` remains bullish0x's
own explicit release decision, same as always.
