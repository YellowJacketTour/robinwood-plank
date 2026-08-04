# 9x / 9mmPro router integration — notes for bullish

Status: **blocked on real integration details from bullish** — everything
below is what Marketplank's side is already built to receive, and exactly
what's needed to plug 9x in. See `SPEC-PLANK-CHECKS-AND-INDEX.md` §3 for
the full routing-intelligence design this fits into.

## 1. What we already have, and why 9x slots in cleanly

Marketplank's swap routing is already venue-neutral by design —
`lib/market/token-registry.ts` was built from the start to compare
multiple venues for the same trade (it already routes $PLANK through
Uniswap and 0x) and pick or split the best combination, the same shape as
1inch/Matcha. A new venue is meant to be "add one more adapter," not a
rewrite. That pattern now also covers vault v-tokens: the discovery/
routing layer built this session (`lib/market/portfolio-pnl.ts`,
`lib/market/trending.ts`, the `/discover` surface) assumes N comparable
venues per asset, never a hardcoded pair.

**What this means for you:** integrating 9x is adding an adapter that
implements the same "get a quote, execute a trade" shape our Uniswap/0x
adapters already implement — not a new subsystem.

## 2. What we need from you, concretely

Nothing here can move until we have:

1. **9mm/9x contract addresses on Robinhood Chain** — the DEX pool/router
   contract(s) and the 9x/9mmPro aggregator contract(s) specifically.
2. **ABI** for both (or a link to verified source on a block explorer).
3. **Quote API** — how to ask 9x "what's the best route/price for token A
   → token B, amount X" off-chain before submitting a transaction (a REST/
   RPC quote endpoint, the same role 0x's `/quote` plays in our existing
   0x adapter).
4. **Docs** — anything on fee structure, slippage/minOut conventions,
   whether 9x does route-splitting internally or expects the caller to
   split, and any rate limits.
5. **Whether 9x can quote against a vault-share-style token (a v-token)**
   at all today, or only against standard fungible pairs — this determines
   whether 9x becomes a venue for both $PLANK-style swaps AND v-token
   routing, or just the former for now.

Once we have these, plugging in the adapter is expected to take a day or
two of engineering, not a redesign — the seams are already there.

## 3. Future-proofing this integration — what "done right" looks like

This section is the part worth reading closely even before you send over
the technical details, since it shapes what shape those details should
take to slot in cleanly.

### 3.1 Order-splitting by default, not winner-take-all

For anything beyond trivial trade size, the router should split a trade
across venues (native vault / Uniswap / 9x) in the same execution rather
than sending 100% of it to whichever quotes marginally better. This is
just better execution practice (less price impact than dumping full size
on one venue), and it's also what §3.4 of the spec requires for a
different reason — see 3.2 below. If 9x's own quote API returns a single
best price rather than a depth curve, we'll need either (a) multiple
quote calls at different notional sizes to approximate depth, or (b) a
9x-side "give me the price impact curve" call if one exists — worth
asking about specifically.

### 3.2 Don't let 9x cannibalize the primary vault's volume

This is the most important structural requirement, and it's the reason
this isn't just "wire up another DEX." For v-token routing specifically
(not $PLANK swaps — this only applies once/if 9x can quote v-tokens per
§2 item 5), the router must guarantee the native vault a structural
minimum share of routed volume, adaptively proportional to the vault's
own real current share of available liquidity — never a frozen fixed
percentage. Real-world precedent: the U.S. equities Order Protection Rule
exists specifically to stop off-exchange venues from silently capturing
flow away from the lit, primary exchange everyone's price discovery
depends on. 9x becoming efficient enough to consistently out-quote the
native vault is a *good* outcome for users in isolation, but if it's
allowed to fully divert volume away from the vault with no floor, the
vault's own price discovery and fee revenue (which the whole v-token
economy — Plank Checks points, the eventual Global Index revenue-share —
depends on) degrades. The floor is a router-side parameter on our end, not
something 9x needs to implement, but the quote API needs to expose enough
(depth/price at multiple sizes) for us to compute it correctly.

### 3.3 Mint-vs-secondary arbitrage, if 9x ever surfaces v-token pairs

If a v-token gets a secondary market on 9x/9mm at some point, the router
should treat "buy on 9x" vs "mint directly from the vault" as two venues
to compare — same real-world precedent as ETF Authorized Participant
arbitrage (buy the cheap side, settle the expensive side, which
mechanically keeps secondary price and real NAV converged). This needs no
special cooperation from 9x beyond a working quote API; it's routing logic
entirely on our side.

### 3.4 PLANK stays a one-way instrument, never something the router sells

Whatever adapter shape 9x integration takes, it must never create a path
where the router sells $PLANK to acquire something else on a user's
behalf — that's a hard rule from the token's own economics (see spec
§2.5): all deposits are ETH/stables in, and PLANK only ever moves via the
protocol's own rule-based buyback, never via routed user swaps that treat
it as a spendable settlement asset. If 9x/9mm has a PLANK pool, it's fine
for the router to buy PLANK there (that's just execution venue choice for
the existing buyback), but the router must never be given a code path that
routes PLANK *out* through 9x to acquire another asset.

### 3.5 Isolation from the audit-gated stuff

To be explicit about scope: none of this touches the Index Vault
contracts, the backstop/insurance fund, or lending/borrowing against
v-tokens — those all stay spec-only pending the same external-audit bar
the existing V3 vault went through, entirely independent of when 9x
integration details arrive. 9x routing is a read/quote + execute-via-
existing-swap-path integration; it doesn't touch pooled reserves or
introduce new custody.

## 4. Suggested handoff format

Whatever's easiest for you — a doc, a link to your own team's internal
integration guide, or just a call — but if you're writing something down,
the fastest path for us is:

- Contract addresses (DEX + aggregator), network/chain ID confirmation
  (Robinhood Chain, 4663).
- ABI or verified-source link.
- One example quote request/response (real payload, not a schema) so we
  can build against something concrete.
- One example execute/swap transaction (real payload) showing exactly
  what a caller submits.
- Fee bps and where they're taken (in the quoted price, or separate).
- Any rate limits or auth requirements on the quote API.

That's enough to build and test the adapter end-to-end against real 9x
responses before touching production routing logic.
