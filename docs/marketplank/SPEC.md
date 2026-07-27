# Marketplank — Engineering & UI/UX Spec

Status: **Phase 0 — scaffold + design, no live contracts.** Nothing in this doc describes
software that moves real funds yet. See "Go-live gates" at the end before that changes.

Background/competitive research lives in the scoping artifact from the planning session
(OpenSea/Seaport, Blur/Blend, Magic Eden, NFTX, Sudoswap, NFT-lending field, Remilia/Milady).
This doc is the buildable follow-through: architecture, data flow, and UI/UX for desktop and
mobile.

## 1. Product shape

One route, tabbed, not five separate pages:

```
plank.love/market
├── Buy & Sell     (Seaport listings + offers — Phase 1)
├── Offers         (collection/trait bids you've made or received — Phase 1)
├── Instant Swap   (NFTX-style vault buy/sell — Phase 2)
└── My Listings    (your active listings/offers/vault positions — Phase 1)
```

`Lend` is not a tab yet. It does not appear in navigation until Phase 3 has its own audit —
see `docs/marketplank/SPEC.md#7-go-live-gates`. Advertising a feature before it exists is a
mistake this project already made once (the pre-fix Trade section); not repeating it.

## 2. Information architecture

- Same Next.js app, same layout, same nav — no subdomain (rationale in the scoping doc).
- `/market` is a client route; tab state is local (`useState`), not yet synced to the URL —
  a `?tab=` query param is a small follow-up, not done in the initial build.
- Collection scope starts as an allowlist (`lib/market/collections.ts`): RobinWood only at
  first, expandable by editing that file — not a database, not an admin panel, until Stage B
  (chain-wide permissionless) is actually funded and scoped as its own project.

## 3. Component tree

Built (real, functioning against the live network — gated behind `MARKET_ENABLED`):

```
lib/market/
├── types.ts               — Listing / Offer / MarketCollection shapes
├── collections.ts         — curated allowlist (Stage A)
├── seaport.ts              — seaport-js wrapper: buildListing, buildOffer, fulfillOrder
└── orders-store.ts         — file+memory store for signed orders (see §5 caveat)

app/api/market/orders/route.ts  — GET (list orders) / POST (store a signed order)

components/market/
├── MarketNav.tsx          — tab strip, mirrors CountdownTimer's compact style
├── ListingGrid.tsx        — responsive grid, 2-col mobile → 5-col desktop (matches Gallery.tsx)
├── ListingCard.tsx        — image, name, price, "Buy" / "Make offer" — dense-card style
├── ListForm.tsx           — token ID + price + duration, signs and publishes a listing
├── MarketView.tsx         — ties the above together: fetches orders, wires buy/list actions
├── SwapPanel.tsx          — Phase 2 vault buy/sell, reuses SwapWidget's tab pattern
├── MyPositions.tsx        — active listings/offers/vault shares for the connected wallet
└── ComingSoonGate.tsx     — the only thing rendered until contracts are live
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

Offer made   →  same signing flow, criteria-based order for collection/trait offers
             →  seller fulfills against the standing offer whenever they choose
```

The order-relay API is a thin store-and-forward layer (orders are signed, so the server can't
forge one) — not a custody system, not a matching engine. It exists because Seaport orders
need *somewhere* to live before they're fulfilled on-chain; OpenSea's own "orderbook" plays the
identical role.

**Status:** the full Phase 1 loop is built and functional against the live Seaport deployment —
list (`ListForm.tsx`), buy, make an item or collection-wide offer (`OfferForm.tsx`), accept an
offer, and cancel an active listing/offer (`MyPositions.tsx`, via `seaport.cancelOrders`), all
wired through `lib/market/seaport.ts` and the order-relay API. Verified locally end-to-end
(tabs, empty states, wallet-gated actions) with no console errors.

**Known gap before this can hold real value:** `orders-store.ts` persists to a JSON file on
disk plus an in-memory `globalThis` cache — this survives a single warm serverless instance but
is not durable storage on Vercel (ephemeral filesystem, no cross-instance sharing). Fine for
local/testnet development; needs a real store (Vercel KV, Upstash Redis, or equivalent) before
any listing placed through it should be trusted to still be there tomorrow.

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

**Status:** `contracts/MarketplankVault.sol` is written and compiles clean (Hardhat,
`npx hardhat compile`) — deposit/mint, buy/sell shares via a constant-product AMM, and
random/targeted redemption are all implemented, with a hard ceiling on fees baked into the
constructor so no deploy can accidentally set a predatory rate. It is explicitly marked
UNAUDITED in its own header and is not deployed anywhere. This is the one piece of the whole
build that's genuinely new, unaudited code — see gate 3 below before it goes near mainnet.

## 7. Go-live gates

Nothing above ships to mainnet with real value until, in order:

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
2. The vault/AMM contract (Phase 2) is deployed and its parameters (fees, redemption premium)
   are fixed and published before any deposit is accepted. This one **is** a fresh deployment
   and does not inherit anyone else's audit — see gate 3.
3. **An independent third-party audit** covers the vault/AMM contract and the order-relay API
   (the two pieces that are genuinely new code, unlike Seaport). Confirmed 2026-07-27: this will
   be run via Fable at project completion, once every other piece below is finished and stable —
   not a rolling review mid-build. This is non-negotiable per the standing project rule
   established after the swap-widget incident, and it doesn't move regardless of how much of the
   rest of the build is done.
4. `MARKET_ENABLED` (see `lib/constants.ts`) flips from `false` to `true`. Until then, every
   route in this spec renders `ComingSoonGate` and nothing else — same pattern as
   `TRADE_PAUSED` gating the existing Trade section.

### Readiness checklist (updated 2026-07-27)

| Item | Status |
|---|---|
| Seaport + ConduitController on Robinhood Chain | ✅ Confirmed live, verified — no action needed |
| Deployer wallet funded with ETH | ✅ Confirmed — owner has ETH ready |
| Vault contract written + tested | ✅ 6/6 tests passing, EVM-target bug (Cancun `mcopy`) caught and fixed |
| Deploy script | ✅ Written (`scripts/deploy-vault.ts`), not executed |
| Order-relay persistence | ✅ KV-backed (`@vercel/kv`) with file fallback — needs `KV_REST_API_URL`/`KV_REST_API_TOKEN` from a real Upstash/Vercel KV instance before production traffic should trust it |
| Marketplace fee model (Seaport listings/offers) | ✅ Decided 2026-07-27: $PLANK always 0%, other collections default 0.5%, toggleable per-collection — see §9 |
| Vault fee parameters (mint/redeem/premium bps) + fee recipient | ✅ Updated in `scripts/deploy-vault.ts`: 1% / 1% / 2.5%, treasury wallet |
| Initial pool liquidity (ETH + NFTs to seed) | ✅ Decided 2026-07-27: funded from the fee treasury, not the owner's capital — see §9 for the threshold |
| Partner collections beyond RobinWood | ⏳ None added — `lib/market/collections.ts` is RobinWood-only until told otherwise |
| Internal adversarial review | ✅ Done 2026-07-27 — 10 findings (2 critical, 4 high) found, fixed, and pinned by regression tests. See `AUDIT-2026-07-27.md` |
| Third-party audit | ⏳ **Still required.** The internal review found serious defects precisely because it went looking adversarially, but it was the same author reviewing their own code and shares its blind spots. Blocks `MARKET_ENABLED=true` regardless of everything else on this list. |
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
2. `GET /api/market/treasury` publicly reports the balance and progress toward
   `MARKET_VAULT_SEED_TARGET_ETH` (7.5 ETH — sized so a ~0.5 ETH trade moves the vault's pool
   price under ~5%, since constant-product AMMs move price roughly trade-size ÷ reserve-size).
   Rendered live in `components/market/TreasuryDashboard.tsx` on the Instant Swap tab — this is
   the actual "liquidity engine," visible to anyone, growing from real fee flow.
3. The vault is deployed and seeded from that treasury once it clears the target — not from the
   owner's personal capital. This is the mechanism that gets the stated goal (marketplace pays
   for its own growth) without the reflexive-collateral risk of a purpose-built token.
4. One direct consequence worth naming: since $PLANK trades stay 0% fee, RobinWood's own vault
   ends up funded by *other* collections' trading activity once Stage B opens — chain-wide
   marketplace growth compounds directly into a benefit for the community that started it.
