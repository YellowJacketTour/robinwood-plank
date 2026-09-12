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

**STATUS (round 6, `0186100`): the intent/solver-auction recommendation
above does NOT apply to `GlobalIndexVault.sol`'s actual single-asset
mint/redeem imbalance-fee leg, and no commit/settle plumbing was built for
it — verified, not assumed.** Direct code read found the front-running
shape this section describes has no arrow present in the contract: there is
no vault-initiated trade at all (only two `safeTransfer` call sites in the
whole contract, both `to msg.sender` inside a share-burning redemption, no
external venue/router/forwardable-calldata entrypoint); the "internal swap"
prices off the checkpointed oracle band (Part 2 of this doc), not a
reserve ratio an attacker could move first; and commit/fill are already the
same atomic transaction, bounded by the caller's own
`minSharesOut`/`minAmountOut` — there is no window between "committed" and
"filled" for a solver auction to close, because none exists to begin with.
Building a settlement leg anyway would have added a second, later,
separately-callable step between a user and their assets — a regression
against the unmovable-assets rule, not an improvement. Proven adversarially
in `test/contracts/IndexVaultIntentSurface.test.ts` (13 tests): no
calldata-forwarding entrypoint exists; both sandwich orientations are
strictly loss-making with loss monotonically growing with attack size (no
break-even point); NAV-per-share is non-decreasing across any sandwich
attempt (per-*leg* backing is correctly allowed to shift — a single-asset
deposit deliberately lifts its own leg and dilutes the others, that's the
mechanism working, not a bug — the right stayer-protection invariant is
NAV-per-share, not per-leg balance); and the exit door stays open under
every ordering, including with the oracle fully stale, since
`redeemProRata` consults no price at all and so cannot be jammed by
anything that would have made the oracle side worse. The v4-hooks and
ERC-7702 recommendations above remain genuinely open, unbuilt design space
— only the intent-settlement piece was resolved this round, and it
resolved to "already safe, don't build it," not "built."

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

---

## Part G: universal stranded-value sweep (spec-only, round 4 candidate)

**The problem, concretely.** StonkBrokers-style collections give every NFT
its own ERC-6551 token-bound account (TBA) that keeps *receiving* value
after mint — trading-fee-funded RWA airdrops, in StonkBrokers' case (70% of
Anvil AMM fees swapped into stock tokens like TSLA/AMZN/NVDA and pushed into
activated wallets). Any NFT sitting in a MarketplankVault, or in
GlobalIndexVault's basket, keeps its TBA — and right now nothing in either
contract sweeps, tracks, or distributes what lands there. That's real,
growing, invisible value. The same gap exists for two other custody shapes:
LP positions and generic ERC-721/721A holdings.

**Three distinct asset shapes, three distinct sweep primitives — deliberately
not one generic function:**

1. **ERC-20 stranded in a TBA** (stock tokens, reward tokens): permissionless
   `sweepTBAERC20(heldTokenId, tbaAddress, assetContract)` — plain
   `IERC20.transfer` out of the TBA into the vault's accounted reserves,
   credited the same push-only way `IndexDividendDistributor.receiveDividends()`
   already handles ETH. `assetContract` must be on a per-asset allowlist —
   never "sweep whatever token balance appears," since that's exactly the
   fake-token attack surface `PlankGauge`'s "impostor LP token" test already
   had to guard against for a different reason.

2. **ERC-721/721A stranded in a TBA, or accrued directly on a held NFT**
   (e.g. a sub-NFT airdropped to the TBA): `sweepTBAERC721(heldTokenId,
   tbaAddress, assetContract, assetTokenId)` via `safeTransferFrom`. Needs
   the same per-`assetContract` allowlist as (1) — accepting arbitrary
   inbound 721s is worse than arbitrary ERC-20s, since it's also a vector for
   griefing via a maliciously-reverting `onERC721Received` implementation on
   whatever downstream contract eventually holds it, and for diluting basket
   accounting with junk collections nobody priced.

3. **LP positions.** Two different shapes needing two different code paths:
   - Fungible LP tokens (v2-style, most 9mm pools) are already covered by
     primitive (1) once the pair address is allowlisted — no new code.
   - Concentrated-liquidity positions (v3/v4-style) are ERC-721s that also
     accrue *uncollected fees inside the position itself* — sweeping the NFT
     alone misses value sitting in the position manager. Needs
     `sweepLPPosition(heldTokenId, tbaAddress, positionManager, positionId)`
     that calls `collect()` against the position manager (allowlisted, since
     an unaudited/fake position manager could misreport or reenter) before
     crediting the collected amounts, then optionally sweeps the position
     NFT itself via primitive (2).

**The consistent safety pattern across all three** (matches every custody
primitive already shipped in this codebase): permissionless (anyone can
trigger a sweep — there is no reason to gate *who* calls it), push-only
(value only ever moves into accounted reserves, never out to a caller-chosen
address), allowlisted per exact `(mechanism, assetContract)` pair — never a
blanket "accept anything this TBA holds" — and credited through the existing
accounted-reserve/dividend-accumulator machinery, not a new balance-tracking
system.

**A sharper risk than the value-capture gap: TBA `execute()` scope.**
ERC-6551's `execute()` lets whoever the standard resolves as the TBA's
"owner" run arbitrary calls through it. If a MarketplankVault or
GlobalIndexVault ever holds the NFT that owns a TBA, the *vault contract
address* resolves as that owner — meaning the vault (or anything that can
trick the vault into forwarding a call) has a live path to drive arbitrary
calldata through the TBA, not just read its balances. The sweep primitives
above must be READ-then-TRANSFER only — call `IERC20.transfer`/
`safeTransferFrom` directly, never anything that routes through
`execute()`, and the vault must never expose a general-purpose "forward this
calldata to a TBA I own" function to anyone, including its own admin. This
is a materially bigger risk than the missing-airdrop-value gap it was meant
to fix, and it's the reason Part G stays spec-only pending its own dedicated
adversarial pass before any build authorization.

Not authorized to build. Queued as a round-4 candidate once round 3's real
work (Parts A-F, committed at `92c9979` on `feat/global-index-vault`) has
had time to be reviewed, and only with its own explicit go-ahead — same bar
as every other Index Vault build this session.

---

## Security best-practices sweep (2026 research pass)

Real, current findings checked against what's actually built, not a generic
checklist:

- **Admin-key social engineering is 2026's dominant real loss vector, not
  contract logic.** Drift Protocol's $285M April 2026 loss and several other
  headline 2026 incidents trace to a compromised/social-engineered
  *privileged key*, not a bug in the audited logic — the attacker used a
  legitimate admin key to whitelist a fake collateral token, self-priced it,
  and drained the pool. GlobalIndexVault's timelock (`MIN_TIMELOCK_DELAY`
  floor, `MAX_TIMELOCK_DELAY` = 30 days ceiling) buys *reaction time* against
  this, but a single compromised admin key can still queue a malicious
  parameter change and wait it out unnoticed. The real mitigation the Garden
  economics engine already applies and this codebase hasn't yet — **scoped-
  capability admin**, splitting one blanket admin role into independently-
  keyed roles (constituent-admission, treasury-policy, emergency-pause,
  parameter-tuning) so one compromised key can't do everything — remains a
  documented, real, unclosed gap. Worth a dedicated round before any mainnet
  conversation, not a mainnet-day fix.
- **Whitelisting bad collateral is the second-most-common real 2026 root
  cause** (the Drift incident again, plus the Blend/YieldBlox February 2026
  oracle-inflation incident: a manipulated single-source price let an
  attacker post a wildly overvalued token as collateral). This is exactly
  what `IEligibilitySource` already guards against — no admin function makes
  a constituent eligible by fiat, eligibility is read from self-sourced
  on-chain state and fails closed against reverting/gas-bomb sources (proven
  in `IndexVaultEligibility.test.ts`). This design was already ahead of the
  2026 incident pattern before the pattern was researched — worth noting
  explicitly since it validates the earlier decision not to add an
  admin-settable eligibility override for convenience.
- **Single-source oracle feeds remain the standard root cause where oracles
  are used at all** — reinforces (doesn't newly discover) the standing
  decision to keep GlobalIndexVault's NAV band-based/checkpointed rather
  than trusting any single external price feed, and to keep PLANK itself
  never a direct pricing input.
- **ERC-6551 itself has no publicly documented exploit history yet** (it's
  a young standard) — the real risk found this pass isn't a known incident,
  it's the `execute()` scope-creep risk documented in Part G above, surfaced
  by reasoning from the standard's own mechanics rather than a public
  post-mortem. Flagging it now, before any sweep primitive is built, is the
  cheaper time to catch it.

Sources: [DeFi Hacks 2026 guide](https://airdropalert.com/blogs/defi-hacks-2026-guide/), [Drift Protocol Hack 2026](https://smartcontractshacking.com/hacks/drift-protocol-hack-2026), [Oracle Manipulation Attacks 2026](https://smartcontractshacking.com/attacks/oracle-manipulation-attacks), [ERC-6551 EIP](https://eips.ethereum.org/EIPS/eip-6551)

---

## Verified build state — bullet points with real numbers (round 3, `92c9979`)

Every number below is read directly from the committed contracts or from a
command I ran and confirmed myself this session — not narrated from memory.

**Test suite:** 317 passing, 0 failing (`npm run test:contracts`, confirmed
independently after copying the continuation agent's work into the real
worktree). 212 pre-existing + 105 new across five new test files
(`BackstopSizingCalculator.test.ts` 28, `IndexVaultEligibility.test.ts` 23,
`DistributorWethAndReentrancy.test.ts` 21, `SelfDealAndDirectionSymmetry.test.ts`
16, `IndexVaultPersistenceCalibration.test.ts` 17).

**GlobalIndexVault.sol real bounds:**
- Max 32 constituents (`MAX_CONSTITUENTS`).
- Timelock: 30-day ceiling (`MAX_TIMELOCK_DELAY`), floor set at deploy time
  per `MIN_TIMELOCK_DELAY`.
- Concentration cap: hard-bounded between 10% and 50% (`MIN/MAX_CONCENTRATION_CAP_BPS`
  = 1,000/5,000 bps) even before the new dynamic HHI formula narrows it
  further; the dynamic cap can only tighten this range, never loosen it
  (`min(dynamic, flat)`).
- Target HHI: default 2,000 bps (0.20), bounded between 200 bps (0.02, very
  diversified) and 10,000 bps (1.00, unconstrained) via `MIN/MAX_TARGET_HHI_BPS`.
- Single-asset imbalance fee ceiling: 10% (`CEIL_IMBALANCE_FEE_BPS`).
- NAV band widening ceiling: 20% (`CEIL_BAND_BPS`); per-observation price-cap
  ceiling: 20% (`CEIL_PRICE_CAP_BPS`).
- Ramp-in/out duration: up to 365 days (`MAX_RAMP_DURATION`).
- Platform allocation (operator's cut of NEW MINTS ONLY, never existing
  holders): default 200 bps (2.0%), hard-capped at 500 bps (5.0%) via
  `CEIL_PLATFORM_ALLOCATION_BPS` — currently **inert**, no treasury wired yet
  (`platformAllocationBps = DEFAULT_PLATFORM_ALLOCATION_BPS; // inert: no treasury yet`
  is a real comment in the deployed constructor logic, not a claim).

**PlankGauge.sol real bounds:**
- LP-yield boost: capped at 5.0x (`MAX_MULTIPLIER_BPS` = 5×BPS), floor at
  1.0x (`MIN_MULTIPLIER_BPS`) — never a penalty, only ever a boost or no-op.
- Epoch duration: up to 90 days (`MAX_EPOCH_DURATION`).
- Concentration-penalty exponent: bounded, tuned via `MAX_EXPONENT_HALVES`
  = 8 halving-steps.
- Boost ceiling: hard-capped at 5.0x (`CEIL_BOOST_BPS`) regardless of what a
  timelocked parameter change requests.

**MarketplankVaultV3.sol real bounds** (the live, audited, mainnet
contract — quoted here for contrast with the still-spec-only Index Vault):
- Mint fee ceiling: 0.05 ETH (`MAX_MINT_FEE_WEI`).
- Redeem fee ceiling: 0.05 ETH (`MAX_REDEEM_FEE_WEI`).
- Target-redeem premium ceiling: 0.1 ETH (`MAX_TARGET_PREMIUM_WEI`).
- Swap fee ceiling: 100 bps / 1% (`MAX_SWAP_FEE_BPS`).
- Batch operation ceiling: 50 NFTs per call (`MAX_BATCH`).

**BackstopSizingCalculator.sol:**
- `MAX_SAMPLES` = 512, genuinely affordable at that ceiling as of this
  round's fix — measured gas at n=256 was ~14.8M under the old insertion
  sort (uncallable on a 30M-gas block at n≈300); the merge-sort replacement
  is O(n log n) on any input ordering, closing that gap.
- Confirmed stateless by full ABI/storage enumeration in
  `BackstopSizingCalculator.test.ts`: every function is view/pure, no
  receive/fallback/payable constructor, all storage slots read zero after
  driving the entire ABI.

Nothing above is deployed anywhere real. All of it lives on
`feat/global-index-vault` in the isolated worktree, compiles clean, and is
independently test-verified — the deployment/audit gate is unchanged.

---

## Round 4: scoped-capability admin roles (`1288775`)

The single blanket `admin` on GlobalIndexVault.sol and PlankGauge.sol —
flagged as a real, open gap in the security-research pass above — is
replaced with a mapping-based role registry (`ScopedRoles.sol`, not a proxy,
not delegatecall): GlobalIndexVault gets four independently-held,
independently-timelocked roles (constituent-admission, risk-parameter,
platform-allocation, admin-role-management); PlankGauge gets three
(gauge-registry, gauge-tuning, admin-role-management). Every reassignment
goes through the existing timelock — rotating a key costs exactly as much
public delay as any other parameter change. 331 tests passing (317 + 14),
independently re-verified.

One real cross-role hole was found and closed during this round: the
timelock's `queuedParams` mapping is shared key-space across both contracts,
so without an explicit whitelist the risk-parameter role could construct a
key that landed in admission-role territory. `roleForParamKey()` now rejects
unrecognized keys at *queue* time.

**A hard constraint, stated by the admin and now binding on every future
round, including Part G:** no security mechanism — pause, freeze, role
lock, anything — may ever be capable of trapping user assets in an
unmovable state, even temporarily, even under total role compromise. This
round's own `ScopedRoles.sol` deliberately has NO pause/freeze/halt/lock
surface anywhere — none existed before this round and none was added,
specifically because of this rule. Proven, not asserted: the named test
`THE EXIT DOOR: no role, no pause, no queued change, and no collusion can
ever block a redemption` drives a fully hostile queued slate from every
role key simultaneously and confirms pro-rata redemption still succeeds,
both mid-timelock and after the hostile changes land. Any future round that
proposes an emergency-pause, circuit-breaker, or similar mechanism must
prove this same invariant before it can be considered done — gating new
deposits/admission/parameter changes is fine, gating withdrawal/redemption
in any way, for any duration, by any role, is not.

---

## Round 5: universal stranded-value sweep, built (`8523349`)

Part G above is no longer spec-only — built as a standalone
`TBAValueSweeper.sol`, deliberately NOT a change to `GlobalIndexVault.sol`
(zero vault authority; its only view into the vault is a read-only
`isTokenHeld`). 364 tests passing (331 + 33), independently re-verified.

**The `execute()` question, answered honestly rather than routed around:**
ERC-6551 gives no way to move a TBA's ERC-20 balance except through the
TBA's own `execute()` — the TBA *is* the token holder, there is no direct
"call transfer against the TBA" primitive to fall back to. What got built
is the narrowest form of the constraint from this doc: exactly one
`execute()` call site per primitive, with calldata built entirely
in-contract from (allowlisted asset, immutable destination, measured
balance) — `value=0`, `CALL` only, never delegatecall — and a test
asserting no external function on the sweeper takes a `bytes` parameter at
all. A caller chooses only *which allowlisted asset* to sweep, never what
happens to it. The sweeper must still be granted executor permission on
each TBA it sweeps (real ERC-6551 accounts only execute for their owner or
an owner-permitted caller) — that setup step was deliberately left open
rather than closed with any general-purpose forwarder, since a forwarder is
exactly the drain this whole design exists to refuse.

**Both unmovable-assets proofs pass by name:** `UNMOVABLE-ASSETS (a)` drives
real vault redemptions under a hostile allowlist, mid-sweep, and immediately
after a sweep of the same NFT — vault always ends empty, every NFT with its
owner. `UNMOVABLE-ASSETS (b)` is the harder one: a full role takeover to an
attacker, followed by de-allowlisting the swept asset, still leaves
already-swept value untouched in the immutable sink — no role, including a
fully compromised one, has a claw-back path.

New role: `ROLE_SWEEP_ALLOWLIST` (via the existing `ScopedRoles.sol`
pattern), scoped narrowly to adding/removing allowlist entries — it fits
none of the four existing GlobalIndexVault roles on merits (documented in
the contract header) and reusing one would have quietly widened that role's
blast radius, the exact thing scoped roles exist to prevent.

---

## Part K: no funded backstop — the elegant answer is not building one

The admin's own framing, restated precisely: find a design that **never
needs** a backstop, or that generates protection **naturally**, without
skimming off max profit share. Researched against real precedent
(GMX/GLP's shared-pool model, Synthetix's debt-pool socialization, and the
Garden economics engine's own resolution of an equivalent question — see
below) rather than defaulting to "build a bigger insurance fund."

**The core Index Vault already doesn't need one, by construction, and this
was true before this question was asked — it just hadn't been named.**
Every backstop-fund precedent researched (Drift, Mango, Euler, InsurAce,
BendDAO — §6.1 of `SPEC-PLANK-CHECKS-AND-INDEX.md`) exists to cover a gap
between what a protocol *promised* and what it can *actually deliver* —
bad debt, undercollateralized loans, a redemption that outran real
reserves. **Pro-rata in-kind redemption (Part 1 of this doc) never makes
that promise in the first place** — burning `s` shares out of `S` pays out
exactly `(s/S)` of whatever the vault actually, currently holds. There is
no gap for a backstop to fill, because there is no promised value beyond
real backing, ever, by mathematical construction, not by monitoring. This
is the same reason NFTX v3 and Set Protocol don't run backstop funds for
their core redemption paths either — the mechanism itself has no
insolvency mode.

**The one place a genuine backstop concept would ever apply — lending
(§6.2, still spec-only, never built, no timeline) — has its own elegant
non-fund answer, GMX/GLP-shaped rather than fund-shaped:** if lending is
ever built, bad debt should be **organically absorbed by the same pool of
participants who took the yield for bearing that exact risk** — the way
GLP stakers collectively collateralize GMX's trader positions, or the way
Synthetix's debt pool is socialized directly across SNX stakers, rather
than routed through a separately-funded, separately-triggered insurance
contract. This generates protection **naturally** because the yield those
participants already earn (for supplying credit, exactly the actors who
should bear that credit's risk) *is* the risk premium — nothing is carved
out of top-line profit share to pre-fund a separate reserve; the same
capital that earns from lending is the capital that's first-loss on it,
priced in from day one, not skimmed after the fact.

**Garden's own equivalent resolution, checked for precedent**: Garden's
audit history (`docs/AUDIT-garden-economics-2026-07-17.md`) never
independently funds a backstop reserve either — every fix for a real
custody bug (the ephemeral-respend double-credit CRITICAL, the terminal-
exit freeze CRITICAL) was a fix to the mechanism's own invariants, not a
reserve built to paper over an unfixed one. The float/dead-share design gap
found in that audit was explicitly left as "requires owner economic
sign-off, not an autonomous rewrite" rather than being patched with a fund
— same discipline this section applies here.

**What stays exactly as-is:** `BackstopSizingCalculator.sol` remains a
correct, useful, stateless CVaR *sizing* utility for the one narrow case
where it would ever matter (a future, explicitly-authorized lending
feature, sized honestly against real tail risk) — kept because it costs
nothing to keep (zero custody, zero storage) and would be the right tool
*if* lending is ever built and *if* it ever needed sizing help beyond the
GLP-style organic-absorption default above. It is not, and was never,
itself a promise that a funded reserve exists or is planned.

No build authorized by this section — it is a closed design decision
(build no funded reserve) and a documented precedent for the one future
feature (lending) where the question could recur.

---

## Part H: fee-revenue split — operator income vs. ecosystem revenue-share

Answers the previously-open question: how does "just our income" (real
marketplace-fee revenue Marketplank the operator is owed) get correctly
separated from "ecosystem revenue-share" (value that flows to PLANK
burners, LP boosters, and index-share holders), across collections that
charge a marketplace fee and collections that don't.

**The split is determined at the point of fee collection, never
after-the-fact, and never by inference.** Every Marketplank collection's
listing config already carries an explicit, collection-specific fee rate
(zero for fee-free collections, non-zero — e.g. 0.5% — for others per
existing listing logic). There is no "default" fee assumed for a collection
that charges none; a zero-fee collection contributes exactly zero to either
side of the split, permanently, not a rounding-to-zero of some nonzero
default.

**Two real, already-collected revenue streams, kept in genuinely separate
accounting, never commingled:**
1. **Operator income** — Marketplank's own marketplace-fee cut (V3's
   `mintFeeWei`/`redeemFeeWei`/swap-fee-bps, already live on mainnet,
   already paid only to `treasury` per the existing `withdrawFees` path).
   This is Marketplank's own revenue, full stop — no ecosystem mechanism
   has any claim on it, and no ecosystem mechanism should ever be built
   with an implicit assumption that it does.
2. **Ecosystem revenue-share** — anything that funds `IndexDividendDistributor`,
   `PlankGauge` boost pools, or a future backstop reserve. This must be
   sourced ONLY from real, already-realized protocol-level revenue that
   was explicitly designed to be shared (e.g. a portion of AMM swap-fee
   growth in `MarketplankVaultV3`'s `k`-growth mechanism, or a future
   explicit ecosystem-fee leg on top of, not carved out of, operator
   income) — never from operator income being redirected after the fact,
   and never minted/promised. This mirrors the Garden economics engine's
   FLWRS attribution law precedent: fee must be confirmed, hard-asset-
   denominated, capped at realized contribution, no double-count.

**Precedent checked, not adopted as-is:** 9mm.pro/claim is a real, live,
Merkle-proof-based claimable revenue-share mechanism on Robinhood Chain —
see Part I below for why Marketplank keeps its own accumulator pattern
instead rather than copying it directly.

**Zero-fee collections, explicitly:** a zero-fee collection's holders still
benefit from the ecosystem side (index inclusion, gauge eligibility, sweep
of any stranded TBA value per Part G) — those are usage/eligibility-gated,
not fee-gated. What a zero-fee collection never generates is operator
income or an ecosystem revenue-share contribution of its own — it can only
ever be a net beneficiary of value other, fee-paying collections generate,
which is fine and by design, not a bug to fix.

This section is a specification of an accounting/design rule, not new
contract code — no build authorized by writing this.

---

## Part I: Merkle-distributor — documented alternative, not adopted

9mm's own live `claim.9mm.pro` is confirmed (via research) to be a real,
snapshot-based, monthly, multi-chain, non-custodial Merkle-proof claim
distributor for ETH revenue-share. Real, working precedent — noted here so
it's not re-discovered later, and explicitly NOT what
`IndexDividendDistributor.sol` uses.

**Why Marketplank keeps the accumulator pattern (MasterChef/Synthetix-style
`accEthPerShareWad`) instead:** a Merkle distributor's core advantage is
serving claims across multiple chains from one off-chain-computed root —
Marketplank is single-chain (Robinhood Chain only) today, so that advantage
doesn't apply yet. The accumulator pattern's advantage that does apply now:
continuous, permissionless, real-time accrual with no snapshot cadence and
no off-chain computation step trusted to be correct — every claim is
computed live, on-chain, from live balances, which is a strictly smaller
trust surface for a single-chain deployment.

**When this should be revisited:** if/when Marketplank ever expands
ecosystem revenue-share across more than one chain, the Merkle-distributor
pattern becomes the better fit and this decision should be re-opened —
flagged explicitly so a future session doesn't have to re-research 9mm's
mechanism from scratch.

---

## Part J: forbidden-claims list — marketing and UI copy

Ported from the-exchange's Garden economics engine, which already
maintains this list as a real, audited-project discipline — directly
applicable here, not reinvented:

- **Never** say "riskless," "guaranteed," "safe," or "impossible to
  exploit" about any Index Vault mechanism, on any surface (marketing copy,
  UI strings, admin-facing docs meant for external eyes) — matches this
  session's own standing rule of never making absolute claims even when
  explicitly requested.
- **Never** say "audited" before a real, completed external audit has
  actually happened — not "audit in progress," not "audit scheduled," only
  after completion, and only for the specific contract version that was
  actually audited (a re-audit is required after any material change, per
  the same standard `MarketplankVaultV3.sol` was held to).
- **Never** quote an APY or APR figure for any ecosystem revenue-share
  mechanism. Real yield here is realized fee flow, not a rate — a rate
  implies a promise about the future that this design deliberately never
  makes (see the Terraform-collapse precedent already cited in the legal
  research doc). If a number is shown at all, show realized historical
  distribution amounts, explicitly labeled as historical and non-
  predictive, never an annualized/projected rate.
- **Never** describe PLANK burning, LP-boost, or gauge weighting as
  "earning interest," "staking rewards" in the securities-law sense
  discussed in `RESEARCH-legal-structural-precedent.md`, or any phrase
  that implies a fixed, contractual return — these are all real, variable,
  usage-driven, non-guaranteed mechanisms and must be described as such.
- **Never** claim the sqrt-dampened gauge weight or the concentration
  penalty is "sybil-resistant" — this session's own corrected finding: it
  is explicitly NOT (splitting a burn across wallets yields MORE weight,
  not less). Any future copy describing PlankGauge must not repeat the
  original, disproven claim.

Documentation only — no build authorized by writing this.

---

## Standing audit requirement — restated, not new

Before any Index Vault code (or Part G, once built) goes anywhere near a
real network: the same external-audit bar `MarketplankVaultV3.sol` already
received on mainnet applies here, **plus** bullish's own independent review
of every round in this document, **plus** the admin's stated plan —
multiple angles, multiple frontier models, not one review pass. This
includes explicitly re-checking the two sections above (Part G's
`execute()`-scope risk and the admin-key-compromise/scoped-capability gap)
by name, since they were found by reasoning about the mechanics rather than
from a public incident report on this exact codebase, and a second set of
eyes is exactly how a reasoning-based finding gets pressure-tested. This
gate has not moved and does not move without the admin's own explicit
separate sign-off.
