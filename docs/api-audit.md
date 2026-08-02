# API surface audit — 2026-08-02

Read-only inventory of every route under `app/api/**`, prompted by the pace
of recent change: the V3 vault generation going primary (V1/V2 redeem-only),
`/learn` cut from 33 to 6 sections, `/floorboards` and `/migrate` shipping,
the order book now merging our own Seaport orders with OpenSea, an RPC
routing rework (display reads off the metered provider + circuit breaker),
and admin section corrections. Verified against source and, where noted,
against live responses from the dev server (`:3000`, production-mirrored
data) on 2026-08-02.

Consumer categories: **UI** (fetched by a live page/component), **admin**
(fetched only by `components/admin/**`), **route** (only called by another
API route/lib, server-to-server), **cron/ops** (manual or scheduled,
non-UI), **none** (no consumer found anywhere in the tree).

## Inventory

| Route | Consumer | Status | Verdict |
|---|---|---|---|
| `admin/finance` | admin (`FinanceSection.tsx`) | live | keep — being edited by another agent this session |
| `admin/status` | admin (`SystemSection.tsx`) | live | keep — being edited by another agent this session |
| `admin/whoami` | admin (`AdminConsole.tsx`) | live | keep |
| `airdrop` | UI (`AirdropChecker.tsx`) | live | keep |
| `airdrop/stream` | UI (`AirdropChecker.tsx`, SSE) | live | keep |
| `airdrop/export-holders` | none found | manual/ops — serves a pre-built file for hand distribution | keep, document as ops-only |
| `boards` | none | **dead in practice** — see Finding 1 | flag for removal |
| `boards/ping` | UI (`SwapWidget.tsx`) | live | keep |
| `boards/export` | none | **dead in practice** — see Finding 1 | flag for removal |
| `boards/scan` | none (self-invoked by `boards` GET's auto-scan) | **dead in practice** — see Finding 1 | flag for removal |
| `boards/stream` | none | **dead in practice** — see Finding 1 | flag for removal |
| `boards/wallet` | none | **dead in practice**, zero references anywhere | flag for removal |
| `content/[slug]` | UI + admin (`SiteBanner`, `SplashIntro`, `CollectionsSection`, `contentDocCard`) | live | keep |
| `crosschain/bridge/quote` | UI (`CrossChainPanel.tsx`) | flag-gated off (`CROSSCHAIN_ENABLED=false` today) but wired | keep |
| `crosschain/bridge/swap` | UI (`CrossChainPanel.tsx`) | flag-gated off, wired | keep |
| `crosschain/status` | UI (`CrossChainPanel.tsx`) | live, reports `enabled:false` | keep |
| `crosschain/quote` | none | dead scaffolding, explicitly documented as such — see Finding 2 | flag for removal |
| `crosschain/plan` | none | dead scaffolding — see Finding 2 | flag for removal |
| `crosschain/plan/submit` | none | dead scaffolding — see Finding 2 | flag for removal |
| `dev-relay` | route (`lib/market/vault-v3.ts`, `lib/market/vault.ts`), hard-gated `NEXT_PUBLIC_DEV_LOCAL_CHAIN=1`, 404s otherwise | live (local only) | keep |
| `health` | CI (`inmotion.yml` health gate) | live | keep |
| `ipfs/image` | UI (`NftViewer`, `lib/ipfs.ts`, `lib/art-cache.ts`) | live | keep |
| `ipfs/metadata` | route (`lib/ipfs.ts`) | live | keep |
| `market/activity` | UI (`ActivityFeed`, `MarketView`, `NftPriceChart`, admin Analytics), route (`lib/market/pricing.ts`) | live | keep |
| `market/collection-index` | UI (`Gallery.tsx`) | live | keep |
| `market/orders` | UI (`MarketView`, `FloorboardsView`, `MyPositions`, `OfferForm`, `MarketSnapshot`), route (`lib/market/bulk-list.ts`) | live | keep |
| `market/rarity` | UI (`lib/market/rarityClient.ts`) | live | keep |
| `market/rpc-usage` | none | ops diagnostic (curl/browser by an operator) | keep, document as ops-only |
| `market/sales-history` | UI (`ActivityFeed`, `ActivityStats`), route (`lib/market/pricing.ts`) | live | keep |
| `market/sales-stats` | UI (`ActivityFeed`, `ActivityStats`, `CollectionStats`, `EventCountdown`, `MarketSnapshot`, admin Analytics) | live | keep |
| `market/token` | UI (`Gallery`, `ItemDetail`, `PlankFence`, `SwapPanel`, `EventCountdown`) | live | keep |
| `market/traits` | UI (`lib/market/traits.ts`) | live | keep |
| `market/treasury` | UI (`TreasuryDashboard.tsx`) | live — **not dead**, only its admin consumer was removed | keep (see brief's own caveat, confirmed correct) |
| `market/vault/activity` | UI (`MarketView`, `NftPriceChart`, `useVaultLive`) | live, N-vault aware (verified live: emits events for all 6 configured vault addresses) | keep |
| `market/vault/held` | UI (`FloorboardsView`, `LivingLiquidityViz`, `RedeemOdds`, `SwapPanel`, `V3SwapView`, `MarketView`) | live, N-vault aware via `?vault=` | keep |
| `market/vault/settle-random` | route (`lib/market/vault.ts`), cron (`CRON_SECRET`) | live | keep |
| `market/vault/stats` | UI (admin Analytics, `LivingLiquidityViz`, `MarketView`, `SwapWidget`, `useVaultBook`, `useVaultLive`) | live, N-vault + fee-model aware (verified live: `feeModel:"eth"` for V3) | keep, not touched (excluded per instructions) |
| `market/vault/stream` | UI (`useVaultLive`, SSE) | live | keep |
| `media/[name]` | UI (`NftViewer` via `lib/uploads.ts` URLs), `WoodAmpProvider` playback | live | keep |
| `music/import-x` | admin (`components/admin/api.ts`) | live | keep |
| `music/playlist` | UI (`WoodAmpProvider`), admin (`MusicSection`) | live | keep |
| `music/track-meta` | admin (`MusicSection`) | live | keep |
| `music/upload` | admin (`api.ts`, `MusicSection`) | live | keep |
| `rpc` | UI (`TokenSelectModal`, `lib/market/inventory.ts`, `lib/market/send-fee.ts`, `lib/robinhood-provider.ts`) | live | keep |
| `trade/pools` | UI (`PlankPoolsPanel`, admin Analytics) | live | keep |
| `trade/price-history` | UI (`PlankPriceChart`, admin Analytics) | live | keep |
| `trade/status` | UI (`CountdownTimer`, `SwapWidget`, `TradeStatusPanel`), test scripts, CI health check | live | keep |
| `trade/valuation` | UI (`PlankValuation.tsx`) | live | keep |
| `uniswap/check-approval` | UI (`SwapWidget`) | live | keep |
| `uniswap/import-token` | UI (`TokenSelectModal`) | live | keep |
| `uniswap/order` | UI (`OrderStatus`, `SwapWidget`) | live | keep |
| `uniswap/quote` | UI (`SwapWidget`) | live | keep |
| `uniswap/swap` | UI (`SwapWidget`) | live | keep |
| `uniswap/token-search` | UI (`TokenSelectModal`) | live | keep |
| `uniswap/tokens` | UI (`SwapWidget`, `TokenSelectModal`) | live | keep |
| `zerox/crosschain/quote` | UI (`ZeroXCrossChainPanel`) | live, `enabled:true` today | keep |
| `zerox/crosschain/status` | UI (`ZeroXCrossChainPanel`) | live | keep |
| `zerox/quote` | UI (`ZeroXQuoteCompare`) | live | keep |
| `zerox/status` | UI (`ChainSelectModal`, `TradeModeSwitch`, `TradeSafetyNotes`, `TradeStatusPanel`, `ZeroXCrossChainPanel`, `ZeroXQuoteCompare`) | live | keep — no `rateLimit()` call, see Finding 4 |

## Answering the three questions

### 1. Which endpoints are no longer needed?

**Finding 1 — the entire "Boards" sniper-trap subsystem is now permanently
inert for this launch, and most of it never had a UI consumer at all.**

`lib/boards.ts` gates all Boards behavior on a `[opens − 30m, opens + 30m]`
window around `TRADE_OPENS_AT`. Live check against the dev server confirms
`tradeOpensAt: 2026-07-25T21:20:00Z` — nine days in the past — so
`getTrapWindow()` returns `phase: "free"` and every capture/scan function
(`isSniperCaptureActive`, `isOffWidgetCaptureActive`, `isListingWindowActive`)
returns `false` permanently. `/api/boards/scan` confirmed this live: it
returns `{skipped: true, live: false}` unconditionally now. Since the
collection is minted out (`totalSupply() == MAX_SUPPLY == 1542`, no future
mint event to protect), this window cannot reopen for this collection.

On top of being functionally inert, four of the five routes never had a UI
consumer to begin with — there is no `app/boards` page and no admin
"Boards" section (`AdminConsole.tsx` wires `music`, `content`, `system`,
`finance`, `analytics`, `collections`, `flags` — no boards section exists):
- `GET /api/boards` — full snapshot, no page renders it.
- `GET /api/boards/stream` — SSE version of the same, no consumer.
- `POST/GET /api/boards/scan` — no consumer; even `/api/boards`'s own
  auto-scan branch can't fire anymore since it's gated on the same dead
  window.
- `GET /api/boards/wallet` — zero references anywhere in the tree.
- `GET /api/boards/export` — CSV/address export; only self-referenced by
  the sibling routes' own response bodies (as a documented download link),
  never fetched or linked from any page or admin section.

`POST /api/boards/ping` is the one exception — `SwapWidget.tsx` still calls
it after every quote/swap, and it degrades safely (no-ops while the widget
is locked, which is permanent now, so it is currently a harmless no-op
call, not dead code to remove).

**Recommendation:** retire `GET /api/boards`, `/api/boards/stream`,
`/api/boards/scan`, `/api/boards/wallet`, and `/api/boards/export`. If a
future collection launch needs the sniper-trap tooling again, it was never
wired to a page anyway — resurrect it with actual ops tooling at that time
rather than carrying five unreachable routes now. Left `boards/ping` alone
(still called, still cheap, and removing it would require a `SwapWidget.tsx`
change I was not scoped to make).

**Finding 2 — `/api/crosschain/quote`, `/api/crosschain/plan`, and
`/api/crosschain/plan/submit` are dead scaffolding by the code's own
admission**, not something I inferred. Comments in
`app/api/crosschain/bridge/quote/route.ts:34`, `components/trade/CrossChainPanel.tsx:45`,
and `lib/crosschain-server.ts:25,211` all independently point to
`app/api/crosschain/quote` as "dormant scaffolding kept for when" CHAINED
routing (single-step swap straight into $PLANK from another chain) becomes
available upstream — Uniswap's API currently returns "no quotes available"
for it. The live two-step flow actually wired to `CrossChainPanel.tsx` is
`bridge/quote` + `bridge/swap` (BRIDGE routing only). `quote`, `plan`, and
`plan/submit` have no consumer in the tree at all, gated or not — they were
never called even when I traced call sites with `CROSSCHAIN_ENABLED` on.

**Recommendation:** these are intentionally dormant per the existing
comments, so I did not delete them — that is exactly the kind of call the
brief reserves for the owner. Flagging for a decision: either keep them
(cheap to carry, and the code explains why) or delete now and re-add if/when
CHAINED routing ships, since nothing currently depends on them and the
scaffolding will need re-verification against Uniswap's API shape whenever
it's actually turned on anyway.

**Not dead, confirmed:** `/api/market/treasury` — matches the brief's own
example, verified: `TreasuryDashboard.tsx:28` still fetches it directly
even though `FinanceSection.tsx` (admin) stopped. Also checked and kept:
`/api/crosschain/bridge/quote` and `/api/crosschain/bridge/swap` — flag-off
today (`CROSSCHAIN_ENABLED=false`) but wired to `CrossChainPanel.tsx` and
gated behind `/api/crosschain/status`, same pattern as the (kept)
`zerox/crosschain/*` pair. A flag being off is not the same as "no
consumer."

### 2. Which are missing information?

Checked the pool/vault endpoints specifically since they're the likeliest
place for the V3 generation change to have left a gap — they haven't:
`market/vault/stats` and `market/vault/held` already resolve `?vault=`
against `MARKET_VAULT_ADDRESSES` (all configured generations) and fall back
to the primary; `market/vault/stats` already reports `feeModel: "eth"` vs
share-denominated bps for legacy vaults (verified live); `market/vault/activity`
already walks all configured vault addresses (verified live: returned events
for all 6 configured addresses, V1/V2/V3 plus per-collection vaults) rather
than a single hardcoded one. These were evidently part of the same
migration work, not missed by it.

**Finding 3 — `airdrop/export-holders` and `market/rpc-usage` are
undocumented ops endpoints.** Both work correctly and are safe (rate
limited, public-safe payloads), but neither appears in `README.md`,
`ARCHITECTURE.md`, or `docs/ARCHITECTURE_MAP.md`'s route inventory, and
`docs/ARCHITECTURE_MAP.md`'s API summary line (`airdrop, boards, crosschain,
health, ipfs, market, rpc, trade, uniswap, zerox`) doesn't distinguish
"has a UI" from "ops-only, curl it yourself." An operator reading the docs
today has no way to discover `?format=` on the export route or that
`rpc-usage` exists at all — not a code defect, but worth a doc note given
`docs/ARCHITECTURE_MAP.md`'s own stated purpose ("what talks to what... has
already produced real bugs").

No route requires an extra round-trip or client-side recomputation that I
found — the ones I inspected in most depth (`market/token`,
`market/vault/stats`, `market/vault/held`, `market/orders`,
`trade/valuation`) already return everything their consumers read in one
shot, including deliberate design choices like `marketCapUsd: null` (sent
explicitly, not omitted, so a client can't confuse "absent" with "zero").

### 3. What new endpoints are warranted?

None found. I looked for the shape of gap that would justify one —
a consumer working around a missing field, computing something route-side
data should already carry, or making N calls where one would do — and
didn't find it. The routes doing the most consumer-side assembly
(`market/orders` merging Seaport + OpenSea, `market/token` combining
owner/image/metadata/history/rarity, `trade/valuation` combining three
independently-cached upstreams) already do that assembly server-side.
Not proposing anything speculative per the brief's instruction.

## What I fixed

Nothing needed fixing. I did not find an outright bug (wrong field name, an
unreadable response shape, or a missing null-guard) in the course of this
audit — every route I inspected in depth had already been defensively
written (fail-closed RPC paths, degraded-not-broken payloads, last-known-good
caching, explicit `null` over silent omission). No source changes were made
in this pass.

## Verification

Read-only throughout: no files changed, so `npx tsc --noEmit` /
`npm run lint:inmotion` were not re-run (nothing to validate). Live response
shapes were checked against the dev server on `:3000` (production-mirrored
data) for `health`, `boards`, `crosschain/status`, `zerox/status`,
`market/traits`, `market/vault/stats`, `market/vault/activity` (both
default and `?full=1`), and `market/rarity` — all via GET, nothing mutating.
