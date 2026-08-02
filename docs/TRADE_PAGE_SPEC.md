# /trade Page Spec — Pool Attribution, IA, and Cross-Chain Cleanup

Prepared for developer/designer handoff. Source: live review of `/trade` at 1440/768/390px, `GET /api/trade/pools`, and the current `inmotion` working tree (2026-07-30).

## Status check before you start

Two other in-flight changes already land part of this spec — verify against current `HEAD` before picking up any item below, since duplicate work will conflict:

- `components/trade/PlankPriceChart.tsx` (working tree, uncommitted) already fixed the chart's own attribution: header now reads "Uniswap v2 pool · deepest of $PLANK's 5 real pools" and its stat tiles are labeled "Liquidity (**this pool**)" / "24H Volume (**this pool**)" / "Buys / Sells (24H)". **This part of the original bug report is resolved.** Do not re-do it.
- `components/trade/PlankPoolsPanel.tsx` and `app/api/trade/pools/route.ts` (working tree, both untracked/new) already exist, are fully built, and correctly render all 5 pools with honest per-pool + aggregate labeling. **They are not mounted anywhere.** `app/trade/page.tsx` never imports `PlankPoolsPanel`. This is the actual remaining gap and it's P0 — see item 1.

So the original bug (v3 header, v2 numbers) is fixed at the component level, but the owner's actual ask — show all 5 pools, with an honest totals card — is unbuilt-but-ready. Item 1 is almost pure wiring, not new logic.

---

## Top 3 P0s, in plain language

1. **Mount the pools panel that already exists.** `PlankPoolsPanel.tsx` and its API are fully built and sitting unused in the repo. Put it on the page, in the right position, and the owner's core ask ("show all pools, plus an honest totals card") is done.
2. **Fix `TradeStatusPanel`'s Routing row.** It hardcodes "Uniswap Trading API" even when the user is on the 0x cross-chain tab, and shows a fee (`0.4207%`) that isn't what that tab actually charges. This is the same class of misattribution bug the owner originally caught, just in a different component — it needs to go in the same pass.
3. **Fix the cross-chain (0x) panel's three UX gaps**: a wallet address with no label, an orphan "0x" line that renders when the route/provider fields are sparse, and no balance or MAX affordance on the pay field.

Full breakdown below, split into Developer and Designer work with acceptance criteria.

---

## 1. Information architecture for /trade

Order, top to bottom, unchanged from current except for inserting the pools panel:

1. **Masthead** (`TradePageHeader`) — unchanged, works.
2. **Price context** — the chart, leading, full width. A visitor's first question is "what's it trading at and is that legit."
3. **Pools breakdown** — immediately under the chart, NOT buried in the safety band at the bottom. The chart discloses it tracks one pool; the very next thing on the page must be the panel that shows all five, so the disclosure is backed by visible evidence, not a promise the user has to scroll to verify.
4. **Action zone** — workbench (buy/sell/cross-chain) + status rail, side by side on desktop, matching current layout.
5. **Safety band** — unchanged, stays last as a trust reinforcement, not a first read.

Justification: the user's goal is "buy or sell $PLANK confidently." Confidence here specifically means trusting the price reference, which the owner flagged as broken. Pools evidence has to sit next to the price claim, not three sections away. The action zone stays below because it depends on price confidence already being established.

## 2. Labelling / attribution rules (apply everywhere on this page, and grep the rest of the codebase for the same pattern)

- Any number that comes from ONE pool must say which pool, inline, next to the number — not just in a subtitle above a stat group. Acceptable: "Liquidity (this pool)" next to a $ figure. Not acceptable: a stat labeled just "Liquidity" under a header that names a pool, because the two can visually separate on mobile reflow.
- Any number that is a SUM across pools must say "(all pools)" or "Total," inline, same rule.
- A dexId + version pair (e.g. "Uniswap v3") is not sufficient pool identification on its own where more than one pool shares a dexId+version+different quote token (there is exactly one such case today: `uniswap v3 PLANK/WETH` and `uniswap v3 PLANK/USDG`). Any UI that shows "Uniswap v3" without the quote symbol next to it is ambiguous. `PlankPoolsPanel` already gets this right (`PLANK/{pool.quoteSymbol}` on its own line) — use that as the reference pattern.
- Any label describing a routing/execution provider (Uniswap, 0x, a bridge) must be computed from the actual active mode/tab state, never a static string. This is the same bug class as the original chart issue, just in `TradeStatusPanel`.

## 3. Which pool the chart tracks

**Recommendation: keep tracking the deepest pool (Uniswap v2, ~$71K), already implemented.** Do not switch to a selector or an aggregate.

Justification:
- A pool selector adds a decision the visitor didn't come to make, and 3 of the 5 pools have under $1,100 liquidity — letting a user "select" a dust pool as their price reference produces a worse, not better, outcome.
- A synthetic aggregate price (liquidity-weighted average across 5 pools with wildly different depth) is more "complete" but is not a number any single trade actually executes at — it would be a new kind of misleading number, the opposite of what this whole spec is fixing.
- The deepest pool is the one large trades will actually move against and the one most resistant to single-trade manipulation — it's the most honest single reference.

The subtitle already in place ("Uniswap v2 pool · deepest of $PLANK's 5 real pools") is sufficient disclosure. No further chart work needed here.

## 4. Pools panel layout

`PlankPoolsPanel.tsx` already implements the right shape. Confirmed against `GET /api/trade/pools` (5 pools: Uniswap v2/v3 WETH, Sushiswap v3, Uniswap v3 PLANK/USDG, Uniswap v4 — liquidity ranges from $71,462 down to $26.81). Two changes needed before/as it's mounted:

- **Sort order**: currently renders pools in API order, which is already liquidity-descending (verified against the live response) — keep it, but make the sort explicit in the component (`.sort((a,b) => b.liquidityUsd - a.liquidityUsd)`) rather than trusting the API's current ordering to stay stable, since a data-integrity spec shouldn't itself depend on an implicit contract.
- **Dust pools**: Uniswap v4 ($26.81 liquidity) and the USDG pool ($183.49) are two to three orders of magnitude smaller than the top pool. Showing them as equal-weight table rows is technically honest (real numbers, real pool) but gives them undue visual authority. Add a "Dust" or "<$1K" visual de-emphasis: lower-opacity row text, or a collapsed "+2 more pools under $1K liquidity" disclosure row that expands to show them. Do not hide them outright — that would recreate a different omission bug.

Columns: Pool (dex + version + pair), Liquidity, 24H Volume, Link — all already present. Add two columns/fields the owner's brief explicitly asked for that the API already returns but the panel doesn't yet surface: **price change 24h** (`priceChangePct24h`) and **txn count** (`txns24h.buys`/`sells`). Creation date (`pairCreatedAt`) can go in a tooltip/expand rather than a column, to control table width.

Mobile treatment: the existing `overflow-x-auto` on the table works but is a poor mobile pattern for a primary content panel (silent horizontal scroll, no visual affordance). Below 640px, switch to stacked cards — one per pool, same fields, no table chrome. This matches the pattern already used elsewhere in the app (Marketplank listing cards).

## 5. Known outstanding issues — verified live, all still present

### `TradeStatusPanel.tsx` — Routing row is mode-blind (P0, Developer)
**Problem**: `components/trade/TradeStatusPanel.tsx:106-111` hardcodes `status.tradingApiConfigured ? "Uniswap Trading API" : "Offline — use Uniswap"`. This has no awareness of `TradeModeSwitch`'s same-chain/cross-chain tab state, so it says "Uniswap Trading API" even while the user is in the 0x cross-chain tab.
**Required outcome**: Routing label reflects the active trade mode. Needs either (a) lifting mode state up so `TradeStatusPanel` can read it, or (b) `TradeStatusPanel` polling `/api/zerox/status` itself the way `TradeModeSwitch` does and rendering "0x Cross-Chain" when that tab is active. Same fix location should address the fee row showing `0.4207%` (`lib/constants.ts:135`, the same-chain integrator fee) when the actual active path is 0x cross-chain, which per `ZeroXQuoteCompare.tsx` and `ZeroXCrossChainPanel.tsx` charges its own separately-computed fee (rounded to a whole-bips value, not 0.4207%).
**Acceptance criteria**: With the cross-chain tab active, the status rail's Routing value is not "Uniswap Trading API," and the fee value shown matches what the 0x quote response actually returns for `siteFee.label`, not the hardcoded same-chain constant.

### ZeroXCrossChainPanel — bare wallet address (P1, Developer)
**Problem**: `components/trade/ZeroXCrossChainPanel.tsx:306-310` renders `{shortAddress(account)}` with zero label. A user landing on this tab with a wallet already connected sees an unlabeled hex string.
**Required outcome**: Prefix with a label, e.g. "Connected: 0x1234…5678" or an icon + "Connected wallet" caption, matching the labeled-field convention used everywhere else on this panel ("You pay," "You receive").
**Acceptance criteria**: The connected-account row has a visible text label, not just the address.

### ZeroXCrossChainPanel — orphan "0x" line (P1, Developer)
**Problem**: `components/trade/ZeroXCrossChainPanel.tsx:396-400` renders `{[quote.provider, quote.route].filter(Boolean).join(" · ")}` — when the API returns `provider: "0x"` and no `route` field (which the current 0x cross-chain quote endpoint does, per the type at line 30-32 marking `route` optional), this renders a lone, unexplained "0x" on its own line with no context.
**Required outcome**: Either suppress this line entirely when `route` is absent (provider alone isn't useful information — the user already knows they're using 0x, it's labeled above), or give it a real label ("Provider: 0x") so a bare token never appears unexplained.
**Acceptance criteria**: No line on this panel ever renders as a single unlabeled token with no caption.

### ZeroXCrossChainPanel — three stacked disclosure blocks (P2, Designer)
**Problem**: Before a user reaches the Send button, they pass: `CrossChainDisclaimer` (collapsed `<details>`, mounted by `TradeModeSwitch`), the Fees `<details>` block (`ZeroXCrossChainPanel.tsx:403-415`), and the always-visible non-atomic-settlement warning (`ZeroXCrossChainPanel.tsx:417-428`). Three separately-styled trust/risk surfaces in one short flow reads as noisy, even though each is individually deliberate (confirmed via code comments — `CrossChainDisclaimer` explicitly says it doesn't repeat what the panel covers).
**Required outcome**: Consolidate the two `<details>` disclosure blocks (`CrossChainDisclaimer` and the inline Fees details) into one collapsed disclosure with two sections, OR keep them separate but give them one shared visual treatment (same border/background) so they read as one "risk & fees" system instead of three unrelated cards. **Do not delete any content** — this is a layout/hierarchy fix, not a content cut, per DESIGN.md's rule against removing safety disclosures.
**Acceptance criteria**: No content from any of the three blocks is removed. Visual redesign reduces the number of distinctly-styled containers a user scrolls past before the Send button, verified by screenshot at 390px before/after.

### ZeroXCrossChainPanel — no balance/MAX on pay field (P2, Developer)
**Problem**: The "You pay" input (`ZeroXCrossChainPanel.tsx:312-347`) has no visible balance and no MAX shortcut. Note: `SwapWidget.tsx` (the same-chain widget) doesn't have this either today — it only validates balance server-side pre-submit (`SwapWidget.tsx:524-546`) — so this is a page-wide gap, not a regression specific to the cross-chain tab.
**Required outcome**: Add a balance readout under/beside the "You pay" field (native token balance on the selected source chain) and a MAX button that fills the input to balance minus a gas reserve. Since this affordance doesn't exist anywhere on the page yet, build it once and apply it consistently to both `SwapWidget.tsx`'s pay field and `ZeroXCrossChainPanel.tsx`'s pay field so the two don't diverge on day one.
**Acceptance criteria**: Both same-chain and cross-chain "you pay" fields show a real fetched balance and a working MAX button that respects a gas reserve (mirror `BUY_GAS_RESERVE_WEI`/`BUY_GAS_RESERVE_ETH` already used in `SwapWidget.tsx`).

## 6. Additional issues found in this review

### Chart/pools panel duplicate data fetching (P2, Developer)
Once `PlankPoolsPanel` is mounted, the page will run two independent 60-second polling loops against pool-shaped data (`PlankPriceChart`'s `/api/trade/price-history` and `PlankPoolsPanel`'s own `/api/trade/pools`, both client-side `useEffect` + `setInterval`). Not a bug, but worth a follow-up ticket to share a single polling context if a third pool-data consumer appears — not blocking for this pass.

### Mobile chart stat strip crowding (P2, Designer)
At 390px, the chart's `grid-cols-2` stat strip (`PlankPriceChart.tsx:457-469`) puts 4 tiles in a 2x2 grid above the range/denom/mode button rows, all within an already-dense card. Once `PlankPoolsPanel` is added directly below, verify the combined vertical stack doesn't push the workbench below the fold on a typical phone viewport (test at 390x844, iPhone-class). If it does, consider collapsing the FDV tile (least decision-relevant of the four) into a secondary row or tooltip at this breakpoint only.

---

## Priority summary

| Item | Owner | Priority |
|---|---|---|
| Mount `PlankPoolsPanel` on `/trade` in the position specified in §1 | Developer | P0 |
| Explicit liquidity-descending sort in `PlankPoolsPanel` | Developer | P0 |
| Dust-pool de-emphasis / collapse in pools panel | Designer | P0 |
| Add price-change-24h and txn-count columns to pools panel | Developer | P1 |
| Mobile stacked-card layout for pools panel (<640px) | Designer | P1 |
| `TradeStatusPanel` Routing label reflects active trade mode | Developer | P0 |
| `TradeStatusPanel` fee value reflects active mode's real fee | Developer | P0 |
| Label the wallet address row in `ZeroXCrossChainPanel` | Developer | P1 |
| Fix/suppress orphan "0x" line in `ZeroXCrossChainPanel` | Developer | P1 |
| Consolidate/unify the three disclosure blocks in cross-chain flow | Designer | P2 |
| Balance + MAX on pay field, same-chain and cross-chain | Developer | P2 |
| Verify combined mobile vertical stack doesn't bury the workbench | Designer | P2 |

Chart pool selection: **no change** — current deepest-pool tracking is the right call, already correctly disclosed.
