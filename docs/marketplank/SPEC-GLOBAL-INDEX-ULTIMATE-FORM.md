# The Global Index — ultimate form (2026-08-04)

Status: **design-complete synthesis, still spec-only.** Nothing here
authorizes building or deploying a contract. This extends
`SPEC-PLANK-CHECKS-AND-INDEX.md` §2 and its lessons-learned sections
(§2.9, §6.1, §6.2) with a from-first-principles answer to "what is the
ultimate form of this vision" — researched against real, documented
precedent across five independent threads (redemption mechanics, oracle
design, tokenomics, bleeding-edge execution primitives, and a fresh
adversarial sweep), not invented from scratch.

The whole design answers one constraint the admin set explicitly:
**people need to be able to elegantly redeem from the basket without ever
extracting undue value or enabling any exploit.** Every piece below is
chosen because it makes that true by construction, not by monitoring.

---

## 1. Redemption — the part that has to be perfect

**Strict pro-rata in-kind redemption is the only free path.** Burning
`s` basket shares out of `S` total pays out `(s/S) × B_k` of every
underlying asset `k` the vault holds — the exact model Set Protocol
(Index Coop's underlying protocol) and Balancer's proportional exit both
use in production. The mathematical guarantee: the redeemer's ownership
fraction of every remaining asset is unchanged, and per-share NAV is
invariant across the transaction. There is no valuation step, no oracle
call, nothing to sandwich, and no way to cherry-pick — a redeemer never
chooses composition, only quantity.

**A single-asset "convenience" exit is allowed, but only priced as what
it actually costs the pool.** Decompose it exactly the way Balancer
already formalizes non-proportional exits: a pro-rata burn, followed by
an *internal* swap of the other components into the requested asset,
priced by the vault's own AMM/imbalance curve — Curve's `remove_liquidity_one_coin`
principle (balanced operations are free; operations that create
imbalance pay a fee that scales with how imbalanced they make the pool).
This charges the redeemer exactly the marginal cost their choice imposes
on remaining holders. NFTX v3's random-vs-targeted redemption fee (0%
for taking what the vault gives you, a real premium to cherry-pick) is
the NFT-native precedent for the identical principle.

**Why this beats cash redemption:** cash-out models (Enzyme Finance and
similar) force the vault to sell assets to raise redemption cash at a
market-timed moment other holders didn't choose — exactly the surface a
NAV-snapshot sandwich exploits. Pro-rata in-kind needs no valuation at
redemption time at all.

**A documented real failure this design elegantly sidesteps:** a 2026
redemption-wave incident (Altura) forced a vault shutdown because
redemption requests outran the vault's ability to unwind, forcing it to
liquidate its most liquid holdings first — leaving remaining holders
overweight the illiquid dregs (adverse selection against whoever's left).
Pro-rata in-kind never has this failure mode: it never needs to choose
*which* asset to liquidate, because it never liquidates anything — every
redemption takes a true slice of everything, illiquid components
included, so no cohort of holders is ever left disproportionately
exposed to what's left.

**A real failure to route around, not repeat:** BasketDAO's 2021 incident
was not a flaw in pro-rata math — it was an infinite-approval bug in a
*periphery* contract (`DelayedBDIBurner`) wrapping the real redemption
logic. The core burn/payout logic must live in the vault contract itself,
never delegated to a separately-approved helper.

**First-depositor inflation defense applies on the mint side**, same as
already specified: OpenZeppelin's virtual-shares/assets offset, applied
independently at both nesting layers (§2.9). Rounding on every redemption
payout floors in the vault's favor, so dust never systematically
transfers to whichever redeemer happens to go last.

---

## 2. NAV pricing — band-based, never a point estimate

**Never compute NAV as one number. Compute a band, and settle
conservatively.** This is not a novel idea — it's Pyth Network's own
documented best practice: every Pyth price feed carries a confidence
interval, and Pyth explicitly recommends protocols use the conservative
edge of that band (not the midpoint) when the direction of manipulation
risk is known. For the Global Index: compute `NAV_low` and `NAV_high`
per component, sum to a basket band, and **always redeem at NAV_low,
always mint at NAV_high.** That spread is what pays for uncertainty and
kills round-trip manipulation arbitrage — an attacker who could move the
midpoint gains nothing, because redemption never pays out at the
midpoint.

**For v-tokens (on-chain, thin AMM pools):** price via Uniswap v4's
Truncated Oracle hook — a geometric-mean TWAP with a *per-block
price-movement cap*, live on mainnet, strictly stronger than a plain TWAP
against exactly the single-block/flash-loan manipulation class a thin NFT
v-token pool is exposed to.

**For anything genuinely off-chain-sourced:** the real institutional
precedent (Ondo's OUSG, WisdomTree's Chainlink-fed CRDT fund) is an
off-chain administrator computing NAV and pushing it on-chain via an
oracle network, with the trust root being the administrator/custodian,
not continuous market trading. Not needed at launch (everything Marketplank
holds trades on-chain), but the right model if a future constituent ever
doesn't.

**PLANK never enters NAV as its own point price — a permanent rule,
already established in §2.5, now given its exact mechanical form:** PLANK
enters only via the truncated-oracle-capped, band-priced TWAP of the
PLANK/ETH pool, redemptions settled at the band's low edge. A single
wallet holding 56.78% of supply cannot move a capped, banded, multi-block
TWAP and have it accepted at face value the way it could a spot price.

**AP-style arbitrage (already specified in §3.4) is the fast corrective
layer — with a real, documented limit now made explicit.** ETF creation/
redemption arbitrage genuinely keeps a basket token's market price near
NAV (this is the empirically-documented mechanism, ETF.com/ICI), but
research into bond ETFs shows this exact mechanism **degrades precisely
when the underlying is illiquid** — arbitrageurs step back from
illiquid legs, and price/NAV can disconnect. The correct synthesis,
mirroring how real illiquid-asset fund structures actually handle this:
AP arbitrage is the fast layer for liquid legs; the delayed/epoch
settlement + size-threshold circuit breaker already specified for
illiquid legs (§2.7) is not a redundant backup, it is *specifically*
covering the exact case where arbitrage is known to fail.

---

## 3. Positive-sum tokenomics — the flywheel that makes this "alien tech"

**The centerpiece: PLANK becomes a vote-escrow token (vePLANK) directing
the Global Index's own fee revenue into deepening specific constituent
pools — a mechanically closed loop, modeled directly on Balancer's
veBAL/Core-Pools mechanic (protocol fees routed back as gauge-vote
incentives that veBAL holders direct toward specific pools) and Curve's
proven vote-escrow/gauge-weight/bribe-market design (the single most
durable tokenomics primitive in DeFi, five years running).**

The loop, stated as mechanism, not narrative: lock PLANK → vePLANK votes
gauge weight across the basket's constituent v-token/ETH pools → the
Global Index's own protocol fees route to the pools vePLANK holders
directed → deeper constituent liquidity → tighter floor-price discovery
→ higher constituent v-token value → more basket value → more fee
revenue → more PLANK buyback funding (already specified, §2.5) → more
reason to lock PLANK. Every step is funded by real fee flow, not token
emissions or dilution — this is what makes it positive-sum rather than a
rotation of the same capital between three assets.

**NFTX v3's Inventory Staking / Liquidity Staking split is the closest
real precedent for cleanly separating non-competing roles**, and the
Global Index should mirror it exactly: NFT depositors earn ETH-denominated
vault fees (never diluting v-token price by paying in v-tokens);
liquidity providers earn AMM trading fees; vePLANK lockers earn gauge
bribes/fee-share. Three different rational actors, three non-competing
payoffs, nobody's yield requires anybody else's position to lose value.

**The one rule that keeps this from becoming Olympus DAO:** Olympus's
POL didn't fail because protocol-owned liquidity is a bad idea — the
core insight (a protocol earning its own LP fees beats renting mercenary
liquidity via emissions) held up. It failed because the treasury's owned
liquidity was paired against OHM's own price: when OHM fell, the
treasury's own asset lost value, reflexively pushing OHM down further — a
self-reinforcing spiral, not a floor. **The Global Index's treasury-owned
liquidity and PLANK buyback must always be funded from external,
already-captured fee revenue (ETH), never bonded or minted against
PLANK's own price.** This is already true of the existing rule-based
buyback design (§2.5) — this section makes explicit *why* that rule
exists and that it must never be relaxed for the sake of a bigger flywheel.

---

## 4. Execution layer — genuinely bleeding-edge, verified production-ready

Researched specifically to separate real 2025-2026 infrastructure from
hype, since "alien tech" ambition needs real precedent under it, not
vaporware:

**Build on now:**
- **Uniswap v4 hooks** — live on mainnet across 15+ chains since Q1 2026.
  A custom hook that prices swaps by basket-composition drift (higher fee
  for a trade that pushes the pool away from target weights, lower for
  one that restores balance) is directly buildable on shipped tooling.
  No live "index-basket hook" product was found — genuine open space,
  not a copy.
- **Intent/solver-based rebalancing** (CoW Swap, UniswapX, 1inch Fusion) —
  solver auctions clear billions/month live today, and CoW AMM already
  captures rebalancing surplus for LPs instead of losing it to MEV. The
  Global Index's periodic rebalance trades (already specified as
  piecewise-executed in §2.7) should be submitted as **solver-auctioned
  intents, not direct AMM swaps** — better execution, and it closes a
  real gap found in this round's adversarial sweep (§5 below).

**Build with a fallback:**
- **ERC-7702** (live since Pectra, May 2025; MetaMask/Rabby/Trust
  integrated through 2025-2026) — genuinely enables one-signature basket
  interactions (deposit N assets + mint share, or redeem + swap-to-preferred-mix,
  in one transaction). Real and current, but young enough (~15 months in
  production) that session-key/AA fallback paths (already speced,
  `DECISION-wallet-session-keys.md`) should stay available, not be
  replaced outright.

**Explicitly not recommended yet:**
- **Restaking of vault constituents** (EigenLayer-style, e.g. "restake the
  basket's own LP/v-token positions for a secondary yield layer") — no
  live precedent preserves on-demand redeemability; the closest real
  examples impose year-long lockups and 15-day withdrawal queues,
  structurally incompatible with the pro-rata-redeem-anytime guarantee
  this whole design is built around. Revisit only if a restaking protocol
  ships genuinely instant/atomic withdrawal.

**Real comparables, for honest differentiation:** Bitwise's Blue-Chip NFT
Index Fund (announced April 2025, TradFi-wrapper style, not an on-chain
redeemable vault) and NFTX (the closer on-chain analog, but
collection-fungibilizing only — no governance-token-plus-multi-asset
basket). Neither combines NFT-vault-shares and a governance token in one
redeemable on-chain basket the way this design does — genuine whitespace,
confirmed by research rather than assumed.

---

## 5. New attack vectors found this round, and what closes each

A fresh adversarial pass, explicitly scoped to find gaps NOT already
covered by §2.7/§2.9/§6's existing defenses. Four found, prioritized by
real severity:

### 5.1 PLANK governance concentration steering basket decisions — CRITICAL, was an open gap

**Real precedent:** Compound's "Humpy" incident (mid-2024) — a whale
accumulated governance tokens across wallets and passed a self-serving
proposal redirecting protocol reserves. Beanstalk (Apr 2022, $182M) is
the sharper basket-specific analog: a flash-loaned governance majority
passed an emergency proposal draining the protocol's pooled assets in one
transaction — governance power over a basket, used to redirect
basket-owned assets.

**Why this is worse for Marketplank than either precedent:** PLANK's
56.78%-held concentration is *static and pre-existing* — it requires no
flash loan, no wallet-splitting, nothing but an existing wallet signing a
transaction. If any basket-level parameter (constituent weights, add/remove
a collection, emergency withdrawal params, fee routing) were ever gated
by raw PLANK vote weight, one wallet could unilaterally control it today.

**The close:** raw PLANK holdings must **never** directly gate any
basket-level parameter change. Two separate, deliberately different
mechanisms:
- **vePLANK (locked, time-decayed)** governs *only* gauge-weight voting —
  directing liquidity incentives among already-approved constituent
  pools (§3). This is a real, bounded, and continuously-contestable
  power (anyone can lock PLANK and out-vote a whale's un-locked position
  over time), not basket-admin control.
- **Basket-admin parameters** (weight-curve constants, constituent
  add/remove, fee-split changes, emergency params) stay exactly where
  §2.7/§2.8 already put them: the timelocked, published, multisig-gated
  process with the compromised-key anchor rule ("no role ever gets a
  withdrawal path over pooled reserves") — never PLANK-vote-gated at all.
  This closes the gap by keeping it closed, not by adding a new lever a
  56.78% holder could eventually reach.

### 5.2 Redemption-epoch adverse selection — closed by the redemption design itself (§1)

Already addressed above: pro-rata in-kind redemption never forces the
vault to choose which asset to liquidate first, so the Altura-style
"illiquid dregs left for whoever's last" failure mode doesn't apply here
by construction. Noted here because the adversarial pass surfaced it as
a real, separate concern worth confirming was actually closed, not just
assumed.

### 5.3 Sustained (not flash-loan) pressure on the weakest constituent — real gap, needs a second layer

**Real precedent:** Yearn's yETH incident (Nov 2025, ~$3M) — an index
token's minting math was drained via how one constituent's value fed the
index calculation, not a single-block spot spike. Hyperliquid's
JELLYJELLY attack (Mar 2025) is the cleaner case: a $15M-cap,
$72K-daily-liquidity token was pumped 500%+ specifically because it was
the thin leg feeding a larger vault's exposure calculation — sustained,
capital-committed pressure held long enough to move through a delay
window, not a flash loan.

**The gap:** cumulative-window delayed settlement (§2.9) defends against
*speed* (an attacker chunking below a per-transaction threshold within one
window). It does not, on its own, defend against an attacker willing to
sustain directional pressure on one illiquid NFT-vault-share constituent
across *multiple* settlement windows.

**The close:** layer a **persistence check** on top of the existing
size-threshold/cumulative-window rule — a constituent's price band must
hold stable (within the confidence band, §2) across N independent
settlement windows, not just one, before it's trusted for a
large/basket-moving redemption or mint. Combined with the existing hard
concentration cap (§2.7, no single collection above 40% of NAV), this
bounds both how much a sustained attack on one constituent can move and
how quickly it can be trusted even if it appears to hold.

### 5.4 Rebalance-direction front-running — real, lower urgency, closed by §4's solver-auction choice

**Real precedent:** documented in TradFi research (QuantPedia) — hedge
funds systematically front-run published, rule-based ETF rebalances
because disclosed weighting rules reveal *future*, not just current,
trade direction. No DeFi-native exploit headline exists yet, but the
strategy is directly portable to any on-chain basket with a public,
derivable rebalance rule.

**The close:** this is exactly why §4 specifies rebalance trades as
solver-auctioned intents (CoW/UniswapX-style) rather than direct,
observable AMM swaps — a sealed-bid auction doesn't reveal the trade
(or its direction) to the chain before it's filled, closing the
front-running surface the plain-AMM approach would have left open. Ordinary
sandwich-MEV mitigation (slippage bounds) does nothing against this
distinct threat; the execution-layer choice is the actual defense.

---

## What "ultimate form" means, concretely

Not a single new invention — a synthesis of five real, independently-verified
best-in-class primitives, each chosen because it makes the admin's stated
requirement true by construction:

1. **Redemption** nobody can extract undue value from: pro-rata in-kind,
   mathematically invariant, no valuation step to game.
2. **Pricing** nobody can manipulate into a bad redemption: band-based,
   settled conservatively, PLANK never a direct input.
3. **Tokenomics** where everyone's rational self-interest deepens the
   system instead of draining it: a real, fee-funded, non-reflexive
   flywheel — not narrative, a closed mechanical loop.
4. **Execution** that doesn't leak value to MEV or front-runners: hooks
   and solver auctions, not naive on-chain swaps.
5. **A governance structure PLANK's own concentration can never turn
   against the basket** — the single most important closed gap this
   round found.

This remains spec-only. Building any of it still requires the same
external-audit bar V3 received, and still requires the admin's explicit
go-ahead to begin — neither of which this document changes.
