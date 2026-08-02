# Marketplank — Engineering & UI/UX Spec

Status: **The Seaport marketplace and Instant Swap interface are deployed and
enabled.** MarketplankVaultV3 ("Premium Plank Liquidity") is live on mainnet
(2026-08-01) and is the primary, LP-capable vault; V1 (Driftwood) and V2
(WormWood) are legacy, redeem-only — WormWood must never be recommended for
new deposits or LP given its LP-drain (`docs/marketplank/AUDIT-2026-07-31-lp.md`).
The application is deployed from `master` to InMotion Passenger with
PostgreSQL. The custom vault code has extensive internal audit evidence and
regression tests but has not received an independent third-party audit.

This specification began as a pre-launch plan. Sections below describe the
current implementation where updated and retain explicit historical decisions
where they explain the product.

Background/competitive research lives in the scoping artifact from the planning session
(OpenSea/Seaport, Blur/Blend, Magic Eden, NFTX, Sudoswap, NFT-lending field, Remilia/Milady).
This doc is the buildable follow-through: architecture, data flow, and UI/UX for desktop and
mobile.

## 1. Product shape

One route, tabbed, not five separate pages:

```
plank.love/market
├── Buy & Sell     (Seaport listings + offers — Phase 1)
├── Instant Swap   (Premium Plank Liquidity primary + Driftwood/WormWood legacy vaults)
├── Offers         (token, trait, rarity, and combination bids)
├── Activity       (collection and vault activity)
├── My NFTs        (wallet inventory and listing)
└── My Listings    (active listings, offers, approvals, and actions)
```

`Lend` is not a tab yet. It does not appear in navigation until Phase 3 has its own audit —
see `docs/marketplank/SPEC.md#7-go-live-gates`. Advertising a feature before it exists is a
mistake this project already made once (the pre-fix Trade section); not repeating it.

## 2. Information architecture

- Same Next.js app, same layout, same nav — no subdomain (rationale in the scoping doc).
- `/market` is a client route. `?tab=` and `?item=` make tabs and item details
  shareable and keep browser Back/Forward navigation coherent.
- Collection scope starts as an allowlist (`lib/market/collections.ts`): RobinWood only at
  first, expandable by editing that file — not a database, not an admin panel, until Stage B
  (chain-wide permissionless) is actually funded and scoped as its own project.

## 3. Component tree

Current major components:

```
lib/market/
├── order-validation.ts    — derives user-visible values from signed orders
├── signature.ts           — Seaport EIP-712 and EIP-1271 verification
├── orders-store.ts        — indexed PostgreSQL orders; KV-compatible alternatives
├── durable-kv.ts          — PostgreSQL, Redis/Valkey, and Upstash adapter
├── vault-registry.ts      — V3 primary and V1/V2 legacy selection
├── vault*.ts              — vault reads, writes, activity, inventory, and caches
└── seaport.ts             — listing, offer, fulfillment, cancel, revoke, and sweep

app/api/market/orders/route.ts  — GET (list orders) / POST (store a signed order)

components/market/
├── MarketView.tsx         — URL state, data loading, validation, and actions
├── ListingGrid/Card       — responsive listing and offer surfaces
├── ItemDetail.tsx         — owner, traits, rarity, history, and actions
├── OfferForm.tsx          — token, trait, rarity, and combination bids
├── SwapPanel.tsx          — buy, sell, LP, deposit, and redeem
├── VaultMigrate.tsx       — optional legacy (V1/V2) holder migration into V3
├── MyNfts/MyPositions     — wallet inventory and active positions
└── ActivityFeed.tsx       — collection and market activity
```

All of it reuses existing primitives rather than inventing new ones: `dense-card`,
`wood-ledger`, `min-h-11`/`min-h-12` tap targets, `gold-500`/`wood-950` palette, the
`Reveal`/`SectionHead` pattern already used by every other section, and the wallet functions
already hardened in `lib/wallet.ts` (`connectWallet`, `ensureRobinhoodChain`,
`simulateTransaction`, `sendTransaction`, `waitForTransaction`).

## 4. Desktop vs. mobile execution

| Surface | Desktop (≥ 640px) | Mobile (< 640px) |
|---|---|---|
| Listing grid | 4–5 columns, hover reveals price/CTA | 2 columns, price/CTA always visible (no hover state to rely on) |
| Listing detail | Side-panel modal, image left / info right | Full-height bottom sheet, image on top, sticky buy button at the bottom of the viewport |
| Tabs | Horizontal pill row under the section head | Horizontal scroll strip, same pills, `overflow-x-auto`, no wrap |
| Make-offer form | Inline panel beside the listing | Full-screen step (amount → review → sign), one field per screen — mirrors the SwapWidget buy/sell flow already shipped |
| My Positions | Table (columns: item, type, price, expiry, action) | Stacked cards, one per position, same data reordered top-to-bottom |
| Wallet connect | Top-right of the market nav | Same button, full-width in the sticky action bar |

No new breakpoint system — this reuses the site's existing `sm:`/`lg:` convention throughout,
because introducing a second responsive scale for one section is how designs drift apart from
each other.

## 5. Data flow (Phase 1)

```
Seller lists  →  EIP-712 signed order (off-chain, no gas)
             →  stored via a lightweight order-relay API (app/api/market/orders)
             →  buyer fetches via GET, fulfills on-chain through Seaport directly

Offer made   →  same signing flow, token or snapshotted criteria order
             →  seller fulfills against the standing offer whenever they choose
```

The order-relay API is a thin store-and-forward layer (orders are signed, so the server can't
forge one) — not a custody system, not a matching engine. It exists because Seaport orders
need *somewhere* to live before they're fulfilled on-chain; OpenSea's own "orderbook" plays the
identical role.

**Status:** the full Phase 1 loop is deployed: list, buy, sweep, make token or
criteria offers, accept, cancel, and revoke approvals. The browser independently
re-validates signed orders before fulfillment.

Orders use indexed rows in local PostgreSQL on cPanel Passenger. The smaller cache primitives
continue through `lib/market/durable-kv.ts`, which supports PostgreSQL, Redis/Valkey, and
Upstash/Vercel KV. With no durable backend configured, the app falls back to an ephemeral file
+ memory store that is only suitable for local development.

Every displayed field is re-derived from the signed order rather than taken from the client
(`lib/market/order-validation.ts`) — see the audit for why that distinction is the difference
between a marketplace and a way to rob its own users. A `DELETE` route removes orders that
Seaport itself reports cancelled, filled, or counter-invalidated, so a cancelled listing stops
being offered to buyers without letting anyone delete a listing they do not own.

## 6. Phase 2 (Instant Swap) data flow

```
Deposit NFT  →  vault mints fungible vTOKEN 1:1
Buy          →  swap ETH → vTOKEN on the vault's AMM → redeem vTOKEN for a random NFT
             →  or pay a premium to target a specific token ID
Sell         →  deposit specific NFT → mint vTOKEN → swap vTOKEN → ETH on the AMM
```

This is the NFTX pattern from the scoping doc, scoped initially to the RobinWood collection
only — a second collection only gets a vault once there's real demand for one, not
speculatively.

**Status:** V1, V2, and V3 are all deployed. V3 ("Premium Plank Liquidity") is
the primary, public LP-capable book; V1 (Driftwood) and V2 (WormWood) remain
reachable only for legacy redeem — WormWood must not be used for new deposits
or LP (see the LP-drain audit above). Random redemption targets a future
drand round verified by `DrandBeacon`, then the relayer pins and settles the
request. The contracts are immutable and are not independently audited.

## 7. Launch record and remaining gates

The marketplace and vaults were launched after the original checklist was
written. The checklist is retained as a decision record; outstanding items are
still real risks rather than pre-launch blockers:

1. ~~Seaport 1.6 is deployed by us on Robinhood Chain~~ — **confirmed unnecessary.** Verified
   2026-07-27 via direct RPC (`eth_getCode`) and Blockscout (`is_verified: true`,
   `name: "Seaport"`) that Seaport 1.6 and its ConduitController already exist on Robinhood
   Chain at their canonical CREATE2 addresses:
   `0x0000000000000068F116a894984e2DB1123eB395` (Seaport) and
   `0x00000000F9490004C11Cef243f5400493c00Ad63` (ConduitController). This is byte-identical
   bytecode to every other chain's deployment — not a fork, not a redeploy, so the existing
   OpenZeppelin/Trail of Bits/Code4rena audits genuinely apply. This gate is satisfied for the
   exchange contract itself; what remains is integration testing (real testnet orders end to
   end), not a deployment.
2. The vault/AMM contracts are deployed with immutable parameters. They do not
   inherit Seaport's audit.
3. **An independent third-party audit** should cover the vault/AMM contract and
   the order-relay API. The Fable passes in this repository are internal
   adversarial reviews, not independent third-party audits. No independent
   report is recorded here.
4. `NEXT_PUBLIC_MARKET_ENABLED` is currently `true` on the `master`
   deployment.

### Readiness checklist (updated 2026-07-27)

| Item | Status |
|---|---|
| Seaport + ConduitController on Robinhood Chain | ✅ Confirmed live, verified — no action needed |
| Deployer wallet funded with ETH | ✅ Confirmed — owner has ETH ready |
| Vault contracts written + tested | ✅ V1, V2, and V3 deployed; contract regression suite runs in CI |
| Deploy tooling | ✅ Wallet-signed standalone tool retained for operator-controlled deploys |
| Order-relay persistence | ✅ cPanel PostgreSQL uses indexed live-order rows; Redis/Valkey and Upstash remain migration-compatible; the file fallback is local-only |
| Marketplace fee model (Seaport listings/offers) | ✅ Decided 2026-07-27: $PLANK always 0%, other collections default 0.5%, toggleable per-collection — see §9 |
| Vault fee parameters (mint/redeem/premium bps) + fee recipient | ✅ Updated in `scripts/deploy-vault.ts`: 1% / 1% / 2.5%, treasury wallet |
| Initial pool liquidity (ETH + NFTs to seed) | ✅ Decided 2026-07-27: funded from the fee treasury, not the owner's capital — see §9 for the threshold |
| Partner collections beyond RobinWood | ⏳ None added — `lib/market/collections.ts` is RobinWood-only until told otherwise |
| Internal adversarial review | ✅ Multiple documented passes with regression tests. See both audit records. |
| Third-party audit | ⏳ **Still absent.** Internal review does not replace an independent audit; limit exposure accordingly. |
| Legal/compliance review of the vault as a financial product | ⏳ Not assessed — flagged, not resolved, by design (outside what an AI assistant can sign off on) |

## 8. What Remilia/Milady contributed to this design

Full writeup: `docs/marketplank/RESEARCH-remilia-milady.md`. Four concrete, adopted ideas —
not cultural flavor, actual product decisions:

1. **Derivative/provenance support.** A collection can be listed as an official derivative of
   another, with that relationship surfaced in the UI — lets a parent collection's OGs get
   first-look access to derivatives (extends the OG mechanic already in the scoping doc).
2. **Redeemable-share auction template** (à la "Bonkler") as an optional Phase 2+ launch format
   — an auction where the NFT encodes a claim on escrowed proceeds, burnable to redeem. Not
   required for Phase 1.
3. **Collection-level trust badges** ("LP burned," "ownership renounced") inside the listing UI
   — this is already exactly what the site's own `TrustFacts` section communicates at the
   homepage level; the new work is surfacing it per-collection in the marketplace, not a new
   concept.
4. **Scheduled/gated drop primitive.** Reuses the existing `CountdownTimer` component pattern
   for new-collection launches instead of leaving drop coordination to off-site tooling.

Explicitly not adopted: their own contract hygiene. Milady/Bonkler/$LADYS have no published
audit trail — good incentive-design lessons, not an infrastructure model.

## 9. Fee model & the treasury-funded liquidity engine

Decided 2026-07-27, after explicitly rejecting a proposed alternative (see below).

**Per-collection marketplace fee** (`MarketCollection.feeBps` in `lib/market/collections.ts`):
- $PLANK / RobinWood: always **0%**. Not a promotional rate — a permanent design decision, since
  Marketplank exists to serve this community first.
- Every other approved collection: **0.5%** (`MARKET_DEFAULT_FEE_BPS`) by default, toggleable
  per-collection (edit the file, redeploy — no admin panel, matching the curated-allowlist
  discipline already in place for Stage A).
- Mechanism: seaport-js's native `fees` parameter on `createOrder` — the fee is an additional
  consideration item Seaport computes and enforces on-chain at fulfillment, the same mechanism
  OpenSea's own frontend uses. Zero custom fee-calculation code, zero new attack surface.

**Vault fees** (`contracts/MarketplankVault.sol`, set at deploy in `scripts/deploy-vault.ts`):
1% mint, 1% redeem, 2.5% target-redemption premium — kept below what NFTX charges in production,
because the vault only has a reason to exist if it's cheaper/faster than a 0%-fee Seaport
listing for $PLANK specifically.

**What we explicitly did not build:** a proposal to launch a second token ($PLINTER) that would
accrue marketplace fee flow and double as AMM/lending collateral was rejected. The mechanism —
an asset whose value depends on marketplace activity, used as collateral *for that same
marketplace* — is structurally the same failure mode behind Terra/UST and, closer to this
project's own research, JPEG'd's dependency-driven loss: a downturn in activity and a collapse
in the collateral's value happen simultaneously, not independently. It would also have been a
second speculative token layered next to $PLANK, the exact pattern already ruled out for
Blur-style points programs in the original scoping doc.

**What we built instead — the treasury-funded seeding plan:**
1. Fees (from non-$PLANK collections, once any exist and trade) accrue in ETH to
   `MARKET_FEE_RECIPIENT` — Marketplank's own dedicated treasury wallet
   (`0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8`, set 2026-07-27), separate from the Trade
   section's Uniswap integrator fee wallet. No new token, just a clean separation of which
   wallet is accountable for which product's revenue.
2. `GET /api/market/treasury` publicly reports the accumulated balance. As of
   2026-07-28 there is no fixed ETH target: `MarketplankVault` deploys closed
   to trading, the treasury seeds NFTs/shares/ETH across as many calls as it
   wants, in any order, and calls the one-way `openPool()` whenever the owner
   personally decides the pool is deep enough — no protocol-enforced minimum.
   Stated plainly: a shallower pool has higher slippage per trade (constant-
   product AMMs move price roughly trade-size ÷ reserve-size), so a small
   first pool will visibly reprice on modest swaps until more liquidity is
   seeded. That trade-off is now entirely the owner's call, made at open time,
   not a number picked in advance.
   Rendered live in `components/market/TreasuryDashboard.tsx` on the Instant Swap tab — this is
   the actual "liquidity engine," visible to anyone, growing from real fee flow.
3. The vault is deployed and seeded from that treasury once it clears the target — not from the
   owner's personal capital. This is the mechanism that gets the stated goal (marketplace pays
   for its own growth) without the reflexive-collateral risk of a purpose-built token.
4. One direct consequence worth naming: since $PLANK trades stay 0% fee, RobinWood's own vault
   ends up funded by *other* collections' trading activity once Stage B opens — chain-wide
   marketplace growth compounds directly into a benefit for the community that started it.
