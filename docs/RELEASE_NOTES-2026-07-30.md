# Release notes — 2026-07-30 (inmotion)

> `inmotion` was the deployment branch at the time these notes were written;
> the deployment branch has been `master` since 2026-08-02. Branch and SHA
> references below describe the repository as it stood on 2026-07-30.

This file documents everything that landed on `inmotion` around 2026-07-30:
what is already deployed in production (pushed to `origin/inmotion` at
`7edda9e`), and what is committed locally on `inmotion` but **not yet pushed**
(25 commits, `7edda9e..af25981`). `docs/RELEASES.md` is the branch/versioning
*policy* document, not a changelog — this file is the dated record; it is
linked from `docs/README.md` and `docs/RELEASES.md` for discoverability.

`package.json` is still `0.1.0`. Nothing here bumps it — that is an owner
decision per `docs/RELEASES.md`.

## Already in production (pushed, deployed)

- **Wallet-less indicative Uniswap quotes** and **auto-quote on input** —
  the Trade widget shows a live quote as soon as an amount is typed, before a
  wallet is connected.
- **Counter-token list with multihop routing**, including chain-core money
  tokens (**USDG**, **WETH**) added to the counter-token list
  (`d338421`).
- **WalletConnect path in the Trade widget** (`6239ac3`) plus a broader swap
  UX uplift: token modal, quote-freshness indicator, rate line, route display
  (`21e730f`).
- **Hotfix `7edda9e`** — "re-quote with the chosen counter token before
  executing a swap." Before this fix, the execution-time re-quote silently
  dropped the user's chosen counter token and re-priced the swap against ETH.
  This is the tip of `origin/inmotion` as of this writing.

## Committed locally, not yet pushed (`7edda9e..af25981`, 25 commits)

### Dedicated /trade page
A standalone `/trade` route (`16060ce`) with its own header, price context,
action zone, and safety band, iterated across several follow-up commits
(hierarchy/rail scannability, token-selector anatomy, logo/ticker/CA row,
final chart-crash fix). `docs/TRADE_PAGE_SPEC.md` records the current
information-architecture spec and a known-outstanding punch list (a routing
label that doesn't reflect the active trade mode, a bare wallet address on
the 0x cross-chain panel, and an orphan "0x" line) — those are **documented
as still open**, not fixed in this range.

### $PLANK/ETH price chart
GeckoTerminal-backed chart on `/trade`: pool stats, a 24h volume histogram,
line/candle modes, and micro-price notation for a token that trades at very
small unit prices. The final commit in this range (`af25981`) fixes a chart
crash and an "ALL" time-range failure, and changes the default to line mode
tracking the deepest of $PLANK's 5 real pools (Uniswap v2, ~$71K liquidity) —
not a synthetic cross-pool average. This pool-attribution behavior and its
rationale are written up in `docs/TRADE_PAGE_SPEC.md`.

### Gasless swaps via UniswapX
Flag-gated (see Feature flags below), with hardened order-integrity
validation (`9cef2ed`).

### Chain-wide token search and import-by-address
Real token logos via Blockscout, chain-wide search, and import-by-address
with on-chain ERC-20 validation (`3146582`).

### 0x integration
Two separate, independently flagged capabilities added as a second
liquidity/routing provider (`06885eb`, `3af258c`, `eb2348b`):
- **0x same-chain quotes** — price competition against the Uniswap route.
- **0x true one-step cross-chain into $PLANK** — this is the cross-chain path
  that actually ships and works today (see Known limitations).

### Uniswap bridge-then-swap cross-chain fallback (dormant, flagged off)
A CHAINED/BRIDGE routing scaffold for cross-chain buys into $PLANK
(`577ff1d`, `c7c833b`). **This path does not currently work upstream** — see
Known limitations. `5506c12` documents why 0x, not this module, is the
shipping cross-chain path.

### Shared wallet context
Fixes a state-desync bug where nav and market/trade surfaces disagreed about
wallet-connection state (`c21c31a`).

### App-page backdrop
`components/AppBackdrop.tsx` (`531ecc9`) — a static, fixed, viewport-pinned
wood-texture layer wired into `/trade`, `/market`, and `/gallery` only. Fixes
the homepage's giant plank-character background bleeding through panel gaps
on those three dense app pages. The homepage itself and
`PlankBackground.tsx` are untouched by design.

### DESIGN.md reconciliation
`DESIGN.md`'s color/typography token vocabulary reconciled against the real
`app/globals.css` tokens, and made discoverable from `AGENTS.md` (`1ea1797`).

### CI
Stages an optional `ZEROX_API_KEY` to the production runtime env (`bb63837`).

### Other docs added in this range
- `docs/TRADE_PAGE_SPEC.md` — pool-attribution/IA spec and outstanding punch
  list (`62e329f`).
- `docs/WALLET_REOWN_EVALUATION.md` — evaluates adopting Reown AppKit as a
  replacement for the hand-built WalletConnect bundle (`e5cbc40`). This is an
  **evaluation only** — no code changed, and **no `NEXT_PUBLIC_WALLET_UI` or
  Reown flag exists in the codebase yet** (verified: no `REOWN` or
  `WALLET_UI` reference anywhere under `lib/` or `app/`). Task tracking shows
  Phase 1 implementation as in progress in a separate work stream, but it had
  not landed as of this commit range.

## Feature flags — verified against source, not memory

All of the following are booleans that only evaluate `true` when the env var
is the literal string `"true"`; any other value (including unset) is `false`
— i.e. **every one of these defaults OFF**.

| Flag | Default | Source | Gates |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_GASLESS_ENABLED` | off | `lib/constants.ts:100-101` | Gasless swaps via UniswapX |
| `NEXT_PUBLIC_ZEROX_ENABLED` | off | `lib/zerox-server.ts:30` | 0x same-chain quotes |
| `NEXT_PUBLIC_ZEROX_CROSSCHAIN_ENABLED` | off | `lib/zerox-server.ts:33` | 0x true one-step cross-chain into $PLANK |
| `NEXT_PUBLIC_CROSSCHAIN_ENABLED` | off | `lib/crosschain-constants.ts:19` | Dormant Uniswap CHAINED/BRIDGE cross-chain fallback |

No Reown/wallet-UI flag exists yet; `docs/WALLET_REOWN_EVALUATION.md` is a
proposal, not a shipped, gated feature.

## Known limitations and liabilities — stated plainly

- **Uniswap's CHAINED cross-chain routing does not work for chain 4663.**
  Empirically confirmed and documented in `lib/crosschain-server.ts:19-25`:
  Uniswap's `/quote` returns `"No quotes available"` for any source-chain →
  $PLANK CHAINED request, and this is not $PLANK-specific — the identical
  ETH → USDG request on Robinhood Chain fails the same way. This is why 0x,
  not the dormant Uniswap module, is the cross-chain path that actually
  ships (`5506c12`).
- **Uniswap silently drops `integratorFees` on BRIDGE routing.**
  `lib/crosschain-server.ts:12-14` documents byte-identical quote output with
  and without `integratorFees` attached — we earn nothing on that leg if it
  is ever enabled.
- **0x's `swapFeeBps` is integer-only.** `lib/zerox-server.ts:113-135`: the
  API rejects `42.07` (400 `INPUT_INVALID`) and accepts only `42`. The 0x
  path therefore charges **0.42%**, not the exact **0.4207%** the Uniswap
  same-chain widget charges.
- **Cross-chain settlement is not atomic.** A failed bridge leg can leave a
  user holding a different token than intended, mid-flow.
- **`public/wallet-connect-bundle.js` is 4,862,013 bytes with no build
  script anywhere in the repo.** Confirmed in `docs/WALLET_REOWN_EVALUATION.md`:
  no `@walletconnect/*`/`wagmi`/`reown` package exists in `package.json` or
  `package-lock.json`, and nothing under `scripts/` regenerates this file —
  it was built once, out-of-band, and committed as a static binary blob.
- **The dormant Uniswap cross-chain module's Across contract targets are
  not individually pinned per chain.** `lib/crosschain-server.ts:34,158`:
  Across uses a different SpokePool contract per source chain, and unlike
  the same-chain widget (which pins its router address), this module does
  not yet pin those addresses individually. This must be fixed before
  `NEXT_PUBLIC_CROSSCHAIN_ENABLED` is ever turned on — right now it is
  correctly left flagged off and is not the active cross-chain path.
- **`docs/TRADE_PAGE_SPEC.md` lists still-open bugs** in this same commit
  range: `TradeStatusPanel`'s routing/fee row is mode-blind (always shows
  "Uniswap Trading API" / `0.4207%` even in the 0x cross-chain tab), and the
  0x cross-chain panel has a bare unlabeled wallet address and an orphan
  "0x" line. These are documented as open work, not resolved by this range.

## Operational / migration notes

- **New env var:** `ZEROX_API_KEY` — optional, staged to the production
  runtime by CI (`bb63837`). Required only if `NEXT_PUBLIC_ZEROX_ENABLED` or
  `NEXT_PUBLIC_ZEROX_CROSSCHAIN_ENABLED` is turned on.
- **New third-party dependency:** the 0x API. Free-tier/rate-limit terms were
  not independently re-verified as part of this documentation pass — confirm
  current 0x API quota before enabling either flag in production.
- **New third-party dependency:** GeckoTerminal, for the $PLANK/ETH price
  chart data. No API key wiring was found in this range; treat its rate
  limits as unverified until checked.
- **Blockscout** is used for chain-wide token search and logos
  (`3146582`) — no new secret required, but its availability/rate limits
  were not independently re-verified here either.
- No new PostgreSQL migrations were found in this commit range.
- No API keys, secrets, or credentials were printed or copied into this file.

## What was not personally verified

This pass read source code and existing in-repo documentation
(`lib/constants.ts`, `lib/zerox-server.ts`, `lib/crosschain-server.ts`,
`lib/crosschain-constants.ts`, `docs/TRADE_PAGE_SPEC.md`,
`docs/WALLET_REOWN_EVALUATION.md`) and git history
(`git log 7edda9e..af25981`). No browser verification (visiting `/trade`,
clicking through the chart or cross-chain panel) was performed as part of
writing this document — the screenshots under
`docs/mockups/market-redesign/verify-*.png` were produced by a separate,
unrelated pass and are not evidence for the claims in this file.
