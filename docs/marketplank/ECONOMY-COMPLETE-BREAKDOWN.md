# Marketplank — complete end-to-end economy breakdown

**For bullish0x and his AI.** Two independent, code-level audits — one of the
live production system, one of the simulator-only Index Vault — merged into
one document, then spot-checked line-by-line by the orchestrating session
before merge (not taken on either audit's word alone). Every formula below is
transcribed literally from the source, every constant carries its unit and
its *actually enforced* bound (not just its name), and every severity claim
is grounded in a specific file:line, not a general concern. No marketing
language, no rounding, no "approximately" outside of stated numeric examples.

**Read this first, distinguish these two systems constantly:**

| | Live V3 (§1) | Index Vault (§2) |
|---|---|---|
| Status | **Deployed, mainnet, real user funds** | **Simulator-only. Never deployed. No address exists.** |
| Repo | `robinwood-plank` | `robinwood-plank-index-vault` (separate repo) |
| Address | `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`, chain 4663 | none |
| Consumers | Live app, real users | `test/contracts/*` only |

Nothing in §2 governs, or has ever governed, a real dollar. Do not let any
number in §2 be mistaken for live behavior.

---

# §1. Live production economy — MarketplankVaultV3

Source: `contracts/MarketplankVaultV3.sol` (788 lines), plus every app-layer
fee/treasury reference in `lib/` and `app/api/`. Deployed 2026-08-01,
`VAULT_VERSION() == 3`, share token `vROBIN`.

## 1.0 The headline answer: is there any fee split?

**No. 100% of every ETH fee the contract collects goes to one immutable
address, `treasury`.** No split, no distributor, no holder revenue-share, no
burn, no second recipient, and no on-chain mechanism to ever add one.

- `address public immutable treasury` — set once at construction, no setter.
- Every fee-taking function does exactly one thing with the ETH:
  `accruedFees += msg.value` — 5 sites total (`deposit`, `depositMany`,
  `requestRandomRedeem`, `redeemTarget`, `redeemTargetMany`).
- `accruedFees` is read in exactly 2 places: `withdrawFees()` and the
  `_assertEthBacked()` invariant.
- `withdrawFees()` zeroes `accruedFees` and sends the whole amount to
  `treasury.call{value: amount}("")`. Permissionless to *trigger*; the
  destination is fixed, never redirectable.
- No `receive()`, no fallback, no owner, no pause, no upgrade path, no admin
  withdrawal of pool ETH.

The only non-treasury economic beneficiary in the contract is **liquidity
providers**, paid by a fully separate mechanism that never touches
`accruedFees`: the AMM swap fee is retained *inside the reserves* (§1.3).
Fee-for-liquidity, not a revenue share on operator income.

**On the spec's "Part H" fee-split design** (`SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md`):
confirmed **aspirational/future**. That doc section itself describes today's
single-sink behavior as the operator-income side and *proposes* a second,
not-yet-built side. Nothing in the live V3 bytecode implements any part of a
split — no ecosystem address, no percentage constant, no event carrying a
split, no accumulator other than `accruedFees`.

One *incidental* non-treasury, non-LP value sink exists — see Finding V-F4.

## 1.1 Constants — value, unit, actual enforced bound

| Constant | Value | Unit | Enforcement |
|---|---|---|---|
| `VAULT_VERSION` | `3` | — | generation marker |
| `BPS_DENOMINATOR` | `10_000` | bps/1.0 | swap math divisor only |
| `SHARE_UNIT` | `1e18` | wei vROBIN / NFT | exactly one share per NFT, everywhere |
| `MAX_MINT_FEE_WEI` | `0.05 ether` | wei | inclusive ceiling; **no floor — 0 is legal on-chain** |
| `MAX_REDEEM_FEE_WEI` | `0.05 ether` | wei | inclusive ceiling; **no floor** |
| `MAX_TARGET_PREMIUM_WEI` | `0.1 ether` | wei | inclusive ceiling; **no floor (0 legal)** |
| `MAX_SWAP_FEE_BPS` | `100` (1.00%) | bps | inclusive ceiling; **0 bps legal** |
| `MIN_INITIAL_LIQUIDITY` | `1000` | LP units | `l0 <= 1000` reverts → must be **≥ 1001** |
| `MAX_BATCH` | `50` | items | batch operations |
| `ROUND_LEAD` | `1` | drand rounds | target = next round + 1 |
| `ROUND_EXPIRY` | `28_800` | drand rounds | strict `>` on expiry check |

All fee immutables (`mintFeeWei`, `redeemFeeWei`, `targetPremiumWei`,
`swapFeeBps`, `treasury`, `collection`, `beacon`) are `immutable`, fixed
forever at construction. **No owner-mutable fee exists in this contract.**

**The live vault's actual chosen fee values are not recorded in this repo**
(the runbook records the address, not the immutables). Worked examples below
use the deploy-script defaults (`mintFeeWei = redeemFeeWei = 0.001 ETH`,
`targetPremiumWei = 0.002 ETH`, `swapFeeBps = 30`) labeled as assumptions —
the authoritative source is the four public getters on the live address
(Finding V-F6).

## 1.2 Function-by-function economy

**`deposit(uint256 tokenId)`** — `msg.value == mintFeeWei` exactly. Pulls the
NFT, mints exactly `SHARE_UNIT` (1e18). Fee: flat `mintFeeWei` → `accruedFees`.
No curve, no scaling with NFT value.

**`depositMany(tokenIds[])`** — `1 ≤ n ≤ 50`. `msg.value == mintFeeWei * n`
exactly. Strictly linear — no batch discount or surcharge.

**Redemption — random path.** `requestRandomRedeem()`: `msg.value ==
redeemFeeWei` exactly (target premium NOT charged — random is the cheap
path). One vault-wide slot. Burns `SHARE_UNIT` immediately, freezes
`heldTokenIds.length`, targets drand round `nextRoundAfter(now) + 1`.
`pinPendingDraw()`: permissionless, free — `index = keccak256(seed,
requester) % frozenLen`. `claimRandomRedeem[For]()`: **zero fee** —
settlement stays pushable by anyone since the fee was already taken at
request time.

**`forfeitExpiredRedeem(requester)` — zero fee, zero refund.** This is an
economic penalty, not a fee: the share burned at request time is **re-minted
to `treasury`**, and the already-paid `redeemFeeWei` is **not returned**. Net
cost of walking away from a disliked draw: one full share plus the redeem
fee. Deliberate anti-reroll design — see Finding V-F1, this is where the app
and contract disagree.

**Redemption — targeted path.** `redeemTarget(tokenId)`: `msg.value ==
redeemFeeWei + targetPremiumWei` exactly. Reverts if a pending unpinned
request exists (reserves the *entire* held set, not just the drawn token).
Fee: both components flat to `accruedFees` — the premium is not shared with
LPs, not burned, not split. `redeemTargetMany`: aggregate reservation check
(not per-item), duplicates self-revert.

**The AMM — `buyShares`/`sellShares`.**
```
buy:  inNet = msg.value * (10000 - swapFeeBps) / 10000        (floor)
      sharesOut = inNet * shareReserve / (ethReserve + inNet)  (floor)
      ethReserve += msg.value (FULL input, not inNet)
sell: inNet = sharesIn * (10000 - swapFeeBps) / 10000
      ethOut = inNet * ethReserve / (shareReserve + inNet)
      shareReserve += sharesIn (FULL input)
```
Standard Uniswap-V2 fee-on-input: output priced on the *discounted* input,
full input joins reserve, `k` strictly grows — that growth is the LP fee.
**Neither function touches `accruedFees`. The swap fee never reaches
treasury — it accrues to LP claims inside the reserves.**

**Liquidity.** `addLiquidity`/`removeLiquidity`: pro-rata against current
reserves both ways, no fee, no lockup, LP is internal and
**non-transferable** (no LP token exists). `openPool()`: treasury-only,
one-way, permanent. `l0 = sqrt(ethReserve * shareReserve)`, must be `> 1000`.
Seed LP (`lpBalance[address(0)] = l0`) is **permanently locked and
unredeemable** — see Finding V-F4.

**`withdrawFees()`** — permissionless trigger, fixed destination. A
reverting treasury bricks *only this call*, never deposits or redemptions.

## 1.3 Invariants
```
SOLVENCY:    totalSupply() + pendingRedeemCount*SHARE_UNIT == heldTokenIds.length*SHARE_UNIT
ETH BACKING: address(this).balance >= ethReserve + accruedFees
```
Reserves are explicit storage, never live balances — donation-inflation is
structurally impossible.

## 1.4 Worked numeric examples

**A — deposits and the treasury payout.** Alice deposits 1 NFT
(`msg.value = 1e15` wei), Bob deposits 3 (`msg.value = 3e15`).
`accruedFees: 0 → 4e15` (0.004 ETH). Anyone calls `withdrawFees()`:
treasury receives exactly `4e15` wei. **Running total to treasury: 0.004
ETH. To LPs: 0. To any ecosystem/holder mechanism: 0 — none exists.**

**B — targeted redeem.** Carol calls `redeemTarget(7)`,
`msg.value = 1e15 + 2e15 = 3e15` wei. `1e18` vROBIN burned, NFT out. The
premium she paid to choose (vs. random) is exactly `2e15` wei, and **100%
lands in treasury.** Running total across A+B: 0.007 ETH.

**C — a swap, showing the fee bypasses treasury entirely.** Pool:
`ethReserve = 2e18`, `shareReserve = 1e19`. Dave buys with `msg.value =
1e17`: `inNet = 9.97e16`, `sharesOut ≈ 4.7483e17`. `ethReserve → 2.1e18`
(full 0.1 ETH). `k: 2.0000e37 → 2.00029e37` — LPs' gain. `accruedFees`
unchanged at 0. Treasury earns nothing from swaps, ever.

## 1.5 Findings — live production, reported not fixed

**V-F1 (real, live, user-facing money-loss bug).** `lib/market/vault-v3.ts:46`
tells the user: *"Your drand round expired. You can forfeit it for a refund
and retry."* `forfeitExpiredRedeem` refunds **nothing** — burns the share to
treasury, keeps the fee. The contract's own comment explains the refund-free
design is deliberate anti-reroll protection. A user who trusts this copy
loses a full share plus the fee. **Recommend fixing the UI string as a
standalone, immediate priority**, independent of anything else in this doc.

**V-F2.** "Predatory-fee deployment is impossible" overstates the on-chain
bound — ceilings only, no floor. `mintFeeWei = redeemFeeWei =
targetPremiumWei = swapFeeBps = 0` all deploy fine on-chain; the non-zero
requirement lives only in CI/deploy-script guardrails, bypassable by
deploying directly.

**V-F3.** `MIN_INITIAL_LIQUIDITY`'s comment claims a stronger floor than
UniV2's — the *value* (1000) is identical to UniV2's; what differs is
donating the *entire* `l0` to `address(0)` rather than only 1000 units.
Naming precision only.

**V-F4 (real, undocumented, ongoing).** The locked seed LP
(`lpBalance[address(0)]`) holds a pro-rata claim on both reserves forever,
including its share of every swap fee that grows `k` — permanently
stranded, unclaimable by anyone. Nowhere documented (not in contract docs,
`vault-stats.ts`, or the runbook) that this locked slice keeps accruing
unclaimable fee revenue — a silent haircut on real LPs' effective rate,
materially larger the smaller live LP is relative to the seed.

**V-F5.** `targetPremiumWei` has no on-chain floor — a deployment with
`targetPremiumWei = 0` makes targeted redemption cost the same as random
while removing the randomness, collapsing the commit-reveal's economic
purpose. No guardrail at any layer beyond the ceiling.

**V-F6.** The live vault's actual fee immutables aren't recorded anywhere in
the repo — only defaults, which the deploy workflow requires an operator to
override. Every number in §1.4 is an assumption; the four public getters on
the live address are authoritative.

**V-F7.** Targeted redemption is fully blocked while ANY unpinned request
exists (not just for the drawn token) — combined with the single vault-wide
slot and `ROUND_EXPIRY = 28,800` rounds, an unrelayed request stalls all
targeted-redeem revenue until pinned or expired. Correct for solvency; worth
naming as a revenue/liveness coupling.

---

# §2. Index Vault economy — simulator-only, never deployed

> **Repeat: this system has never been deployed. No address exists, no app
> route imports it, only `test/contracts/*` exercises it.** Source:
> `robinwood-plank-index-vault`, branch `feat/global-index-vault`, commit
> `0186100`.

## 2.0 GlobalIndexVault.sol — pro-rata redemption (the guaranteed exit door)

`redeemProRata(sharesIn, minAmountsOut[])` — **no role modifier, no state
flag on any branch, no price read anywhere.**
```
denom = totalSupply() + VIRTUAL_SHARES        // 1000 virtual shares
burn(msg.sender, sharesIn)                     // burn FIRST
for each constituent k:
    out_k = floor(sharesIn * reserve_k / denom)
    if out_k > reserve_k: out_k = reserve_k
    if out_k < minAmountsOut[k]: revert
    reserve_k -= out_k; transfer(msg.sender, out_k)
```
Deliberate asymmetry: mint side charges against `reserve_k + VIRTUAL_ASSETS`,
redeem side pays against `reserve_k` alone — keeps redemption from ever
paying strictly more than a true slice.

**No role, and no combination of all four roles colluding, has a withdrawal
path, a pause, a freeze, or any way to block this function.**

## 2.1 Single-asset imbalance-fee curve
```
_imbalanceFeeBps(amount, against):
    if against == 0: return maxImbalanceFeeBps
    d = amount * 10000 / against   (clamped to 10000)
    fee = baseImbalanceFeeBps + imbalanceSlopeBps * d / 10000  (capped at max)
```
No direction argument — identical `(amount, against)` costs identical bps on
buy and sell. Mint side layers one extra term as a function of (current
weight, target weight) only:
```
underweight: fee = max(depthFee - relief, base)   // floors at base, never 0
overweight:  fee = min(depthFee + slope*over/10000, max)
```
Fee is retained in reserves — no code path transfers a reserve anywhere
except to a share-burning redeemer.

## 2.2 NAV band (oracle-free)
```
spot = ethReserve * WAD / shareReserve            // self-referential, no feed
capped = clamp(spot, prev*(1-cap), prev*(1+cap))   // per-checkpoint movement cap
priceBand: low = min(obs)*(1-band), high = max(obs)*(1+band)
stale → low = 0 (asymmetric: cheap to give up, still expensive to receive)
```
Redemption is unaffected by any of this — it reads no price at all.

## 2.3 Dynamic HHI-derived concentration cap (closed form)
```
w = (1 + sqrt(1 - n*(1 - T*(n-1)))) / n     // T = target HHI, n = eligible count
```
Worked: n=10, T=0.20 → w=40%. n=50, T=0.20 → w=44%. n=3, T=0.20 → infeasible,
falls back to equal-weight 33.3%. **Increasing in n** (counter-intuitive,
documented as a correction to the natural-but-wrong assumption) — so the
effective cap is `min(dynamic, flat)`, admission can only ever tighten.

## 2.4 Platform allocation — exact mechanism and current wiring

```
cut = grossShares * bps / BPS   (floors, in depositor's favor)
net = grossShares - cut
mint(depositor, net); mint(treasury, cut)   // sums to exactly grossShares
```
Default 200 bps (2%), compile-time ceiling 500 bps (5%) re-checked at
execution. Existing holders' NAV-per-share is bit-for-bit unaffected — the
treasury receives shares redeemable only through the same pro-rata path as
anyone else.

**Current status, re-verified at this commit: still inert.**
`platformTreasury` has no constructor init (`address(0)` at birth), the only
writer is a timelocked `executePlatformTreasury()`. No treasury has ever
been appointed — with `treasury == address(0)`, every mint behaves as if the
parameter doesn't exist. Since the system has never been deployed, this has
never mattered in practice, but it's not wired even in principle yet.

## 2.5 PlankGauge.sol — the burn-directed weight economy

**Three burn paths, constructor-configured, not hardcoded** (default 1.0x /
2.5x / 3.0x per the header, but nothing in code enforces those literals —
only the bound `[1.0x, 5.0x]` and the ordering `raw ≤ plankEthLp ≤
collectionLp`).

**Epoch-reset weight**: `[epoch][gauge][account]`-keyed — a fresh epoch means
weight is exactly 0 for everyone. No decay, no carry-forward.

**Sqrt dampening — corrected finding, stated accurately in the code, not
overclaimed:**
```
contribution = sqrt(cumulative weighted burn this epoch)
```
This neutralizes chunking *within one wallet* — it does **not** make the
mechanism sybil-resistant. Splitting weighted amount `w` across N addresses:
`C_N = √N · C_1` — total contribution rises by exactly √N (1.414x at N=2,
3.162x at N=10). This is stated plainly in the contract itself.

**Concentration penalty — sharper than "permits" splitting, it *requires*
it:**
```
penalty_i = rawShare_i ^ k     (k = exponent/2, default 1.5, bounded [1.0, 4.0])
effectiveShare_i = penalty ≥ 1.0 ? 0 : rawShare_i * (1 - penalty_i)
```
A **sole burner** (`rawShare = 1.0`) gets `penalty = 1.0` → **zero effective
share**. With N sybils splitting evenly and no rivals, aggregate effective
share = `1 - N^(1-k)`: 0 at N=1, 64.6% at N=2, 75% at N=4, 90% at N=100
(k=1.5). Splitting is not an optimization here — at the limit it's the only
way to receive anything.

**LP-yield boost**: `1.0x` base → `2.5x` cap, linear in share of epoch
contribution. Uses the **raw** contribution, not the penalized share — not
penalty-protected, and linearly sybil-splittable if any downstream payer
sums per-address boosts.

## 2.6 Dividends — SUPERSEDED, round 9. No staking, no snapshot, no publisher.

`IndexDividendDistributor.sol` is **deleted**. The stake-based accumulator
described in the original audit no longer exists anywhere in this system —
replaced, after a live design discussion with the admin that explicitly
rejected both staking (custody risk, illiquidity) and an off-chain Merkle
root (trusted publisher), with a fully on-chain, zero-off-chain-computation
mechanism collapsed directly into `GlobalIndexVault` itself, since only the
contract that owns the balances can correctly account for them without an
external call on every transfer.

**Magnified-dividend-per-share** (EIP-2222 lineage — the real, audited
pattern behind dividend-paying tokens and Compound-style checkpointed vote
weight):
```
accumulativeDividendOf(a) = (magnifiedDividendPerShare * balanceOf(a)
                              + magnifiedDividendCorrections[a]) / MAGNITUDE
withdrawableDividendOf(a) = accumulativeDividendOf(a) - withdrawnDividends[a]

on every mint/burn/transfer of `value`:
    correction = magnifiedDividendPerShare * value
    if from != 0: corrections[from] += correction
    if to   != 0: corrections[to]   -= correction
```
`MAGNITUDE = 2**64` (deliberately not `2**128` — the product must never
overflow `int256`, or a legitimate transfer reverts; the ceiling is enforced
at push (`MAX_MAGNIFIED_PER_SHARE = 2**126`) and mint
(`MAX_SHARE_SUPPLY = 2**128`) instead, both places where reverting is
harmless, so the transfer path itself contains **no revert condition at
all** — non-revert is proven, not assumed). The locked seed share is
excluded in O(1) via the same correction-term trick, so no distribution is
ever partially stranded at the dead address.

**The property that matters most: `withdrawableDividendOf` does NOT zero
out when a holder's balance goes to zero.** A redeemer who burns their
entire position via `redeemProRata` keeps and can still claim everything
they'd already earned — entitlement is for value already accrued, not
proportional to current holding. Proven by differential test against
`redeemProRata`'s own payout math (bit-for-bit unaffected by the hook) and
by the disjoint-accrual test (a seller and buyer with identical `balanceOf`
history shapes at different times get strictly disjoint entitlement — the
correction term is what prevents reaching back for a distribution that
predates you).

**Measured, disclosed cost, not hidden:** a plain share transfer costs
+5,600 gas (two warm non-zero SSTOREs — the theoretical floor for this
pattern); `redeemProRata` costs +19,900 gas (a cold-slot write on the first
burn-side correction). No malicious-publisher risk exists at all — there is
no off-chain input to this mechanism, so there is no party who could
publish a wrong one.

**The size cost, and how it was paid.** Adding this hook required real
headroom in an already-24,513-byte contract. Round 9a extracted four pure
math clusters into external libraries (`IndexMath`, `IndexParams`,
`IndexEligibility`, `IndexValuation`) — net −1,979 bytes before the hook was
even added. One sub-attempt (a naive single-library extraction) saved only
3 bytes and was correctly abandoned; the rule that actually pays is *(body
removed) > (call sites × ~100–150 byte delegatecall stub)*. Final deployed
size: **24,499/24,576 bytes, 77 bytes headroom** — thin, and explicitly
flagged: the next feature touching this file needs another extraction
first (`priceBand`/`nav`/`_previewSingleExit` already identified as the
next lever).

## 2.6b WrappedIndexShare.sol — opt-in composability, no staking required here either

**The gap the on-chain hook alone can't close**: `balanceOf()`-based
accrual only reaches *direct* holders. Shares sitting inside an LP pool, a
lending deposit, or any other third-party contract accrue to that
contract's own balance, and since that contract has no idea the mechanism
exists, the value is permanently stranded at an address nobody who benefits
controls.

**The fix — confirmed via research to be Lido's own live, billions-TVL
precedent for the identical problem** (stETH's rebasing balance breaks
inside AMM pools; wstETH fixes it by trading "yield via growing balance"
for "yield via appreciating exchange rate," which works correctly no matter
what contract holds the token). `WrappedIndexShare` is a new, **standalone**
contract — zero changes to `GlobalIndexVault.sol`, zero byte-budget
pressure on it. Deposit raw index shares, receive wIDX at the current
exchange rate; LP or deposit *the wrapper token* anywhere and it keeps
earning, because `harvest()` — permissionless, callable by anyone, **no
swap, no price, no oracle, no slippage risk of any kind** — simply pulls
the wrapper's own already-earned entitlement into its own backing, raising
the exchange rate for every wIDX holder simultaneously.

One deliberate deviation from the original spec, caught by the build
itself: a naive single-asset deposit against dual-asset (raw share +
dividend-asset) backing would have been a live drain whenever the two
assets' relative value wasn't exactly 1:1 — `x` deposited then immediately
withdrawn nets `x·D·(1−p)/(R+D+x)` for a price ratio `p`, real, risk-free
extraction. **Not shipped.** Shipped instead: a proportional dual-asset
join/exit (the same Balancer/Set model `GlobalIndexVault` already uses for
its own pro-rata redemption) — value-neutral for any ratio, no price ever
read, floored in the pool's favor.

No owner, no admin, no pause, no upgrade path — `deposit`/`withdraw`/`harvest`
is the entire external mutating surface (proven by an ABI test asserting no
owner/pause/upgrade fragment exists).

## 2.6c Round 9d — N-asset reward streams: every future stream reaches pooled holders too

**The distinction that matters**: ERC-7575 (multi-asset vault entry — how
shares get minted/redeemed) and "claim any index revenue stream" (a
bribed-in token, an RWA airdrop) are different problems. Solving the second
by giving `WrappedIndexShare` itself a per-holder correction-term mechanism
for new streams would have silently reintroduced the exact stranding bug
the wrapper was built to fix, one level up — a pooled wIDX holder would
again be the un-actioned holder of record. **Only backing-pool
appreciation reaches pooled holders; per-holder accounting never does**,
regardless of which contract it lives on.

The real fix, confirmed with the admin through live design discussion:
generalize the wrapper's backing from 2 assets to **N** ("streams"), admin-
whitelisted (`ROLE_STREAM_LISTER`, timelocked via the same `ScopedRoles`
pattern used everywhere in this system — deliberately NOT permissionless
registration, specifically so a hostile token can't become an attack
surface just by being pushed in uninvited). `depositStream(token, amount)`
is permissionless *once a token is whitelisted* — this is the actual bribe/
airdrop-forwarding mechanism. `withdraw()` pays out pro-rata across every
currently-held asset (raw share + dividend + every funded stream), each in
its own native units, never converted or compared to another asset's value.

**Hardening specific to a system where arbitrary tokens get whitelisted:**
- **Per-stream isolation, proven under a maximally hostile token** (reverts
  on transfer, reverts on `balanceOf`, lies on return, gas-bombs) — deposit,
  withdrawal of every OTHER asset, and `harvest()` all remain unaffected.
  Bounded payout gas (`PAYOUT_GAS = 250_000`) is what makes this real rather
  than assumed — the EVM's 63/64 forwarding rule means a hostile callee
  cannot consume what the remaining legs need.
- **RWA transfer-restriction fault-tolerance — a real, disclosed, non-
  fixable-by-us category, handled rather than ignored.** If one whitelisted
  asset's issuer restricts who can receive it, a naive implementation would
  brick the ENTIRE withdrawal (trapping a user's raw shares and every other,
  unrestricted asset too). Fixed with a three-phase withdraw: compute every
  leg's amount from pre-burn backing, burn once, then pay each leg through a
  fault-isolated low-level call — a failed leg is deferred to a
  `pendingClaim`/`reserved` mapping (so it can never be double-counted by
  remaining holders) rather than reverting the whole call, retryable later
  via `claimPending`/`claimPendingMany`.
- **Delisting never claws back held backing** — only stops new inflow;
  already-funded value stays in the pool and stays withdrawable forever.
- **Rebasing tokens** — disclosed as an explicit whitelisting-time judgment
  call, not code-enforced (on-chain rebase detection isn't generally
  reliable — stated honestly rather than falsely guaranteed).
- **A generous but finite stream cap** (`MAX_STREAMS = 32`, matching
  `GlobalIndexVault.MAX_CONSTITUENTS`'s existing precedent) — disclosed and
  deliberate: `withdraw()` iterates every held asset, so unbounded streams
  would eventually make withdrawal itself gas-unsafe. "Infinitely growing"
  is honestly scoped to "grows to a large, gas-safe bound," not literally
  unbounded.

`WrappedIndexShare.sol` deployed size after this round: 14,190 bytes (58%
of the limit — real headroom, no pressure, since it's a standalone
contract with no shared byte budget with the core vault).

## 2.7 BackstopSizingCalculator.sol — stateless CVaR, value-free by construction

Zero storage, zero payable functions, zero custody, every function `pure`.
```
VaR = sortedLosses[cutIndex]           where cutIndex = n * confidenceBps / 10000
CVaR = mean(sortedLosses[cutIndex:])    (floor)
suggestedReserve = ceil(CVaR * coverageBps / 10000)
```
The O(n²)→O(n log n) sort fix (found and closed this session) is present:
an iterative merge sort, no recursion, affordable at the documented 512-sample
ceiling under worst-case (previously reverse-sorted) input.

**No funded reserve exists or is planned** — see §3 below for why.

## 2.8 TBAValueSweeper.sol — the stranded-value sweep

Three permissionless, allowlisted, immutable-destination primitives:
ERC-20 sweep, ERC-721 sweep, LP-position-fee collection. Provenance gated
(`token()`/`owner()` checks against the real held NFT). No recipient
argument on any function — destinations are fixed at construction. See
Findings I-F10/F11/F12 below for real, unresolved gaps in this mechanism.

## 2.9 ScopedRoles.sol — the capability map

| Contract | Role | Reach |
|---|---|---|
| GlobalIndexVault | `ROLE_ADMIN` | role rotation only |
| | `ROLE_CONSTITUENT_ADMISSION` | listing/metric changes — cannot touch risk or allocation |
| | `ROLE_RISK_PARAM` | 15 whitelisted risk keys — cannot admit, cannot reach allocation |
| | `ROLE_PLATFORM_ALLOCATION` | allocation bps + treasury addr — cannot touch reserves/risk |
| PlankGauge | `ROLE_ADMIN` | role rotation only |
| | `ROLE_GAUGE_REGISTRY` | gauge/LP allowlists, redirect sink |
| | `ROLE_GAUGE_TUNING` | 7 curve parameters |
| TBAValueSweeper | `ROLE_ADMIN` | role rotation only |
| | `ROLE_SWEEP_ALLOWLIST` | allowlist entries only — cannot choose a destination or execute |

**No pause, no freeze, no role-lock, no flag of any kind exists anywhere in
this system.** `redeemProRata` cannot be blocked by any role, alone or in
total collusion — proven by test, not just asserted.

## 2.10 Worked numeric examples

**Gauge sybil arithmetic.** Alice burns 300e18-weighted single-address:
contribution = √(3e20) ≈ 17.32B, raw share ≈ 46.4%, effective share after
penalty ≈ 31.7%. Same burn split across 4 addresses of 75e18 each:
`4 × √(7.5e19) ≈ 34.64B` — exactly **2x = √4** the single-address
contribution for identical PLANK burned, and the aggregate effective share
after penalty is *higher* still since each shard's individual penalty is
smaller.

**Dividend accrual.** Alice stakes 300e18 shares, Bob 700e18. A 10 ETH push:
`acc += 1e16`. `claimable(Alice) = 3 ETH`, `claimable(Bob) = 7 ETH` exactly,
no remainder.

**CVaR sizing.** Losses `[1,2,3,4,5,6,7,8,9,100]` ETH, confidence 90%:
`VaR = 100 ETH`, `tailCount = 1`, `CVaR = 100 ETH`. At 150% coverage,
suggested reserve = 150 ETH — and the calculator returns `tailCount = 1`
specifically so a caller can see this "estimate" rests on one observation.

## 2.11 Findings — Index Vault, reported not fixed (severity relative to a hypothetical future deployment; nothing here is live)

**I-F1.** "EVT-calibrated" persistence checkpointing is actually a realized-
variance (RMS) proxy over the whole distribution, not a Generalized-Pareto
tail fit — the code says so in its own header. It cannot anticipate a move
larger than any observed; the hard clamp `[max(persistenceCheckpoints,2), 8]`
is the real defense, not the statistics.

**I-F2.** `PlankGauge`'s header claims "no reference to any vault in its ABI
or bytecode" — false as written: `collectionVaultOf` is a public getter,
`queueCollectionLp` takes a vault argument. The narrower claims (no payable
function, no custody) remain true.

**I-F3.** Documented gauge defaults (1.0x/2.5x/3.0x, 7-day epoch) don't exist
as enforced literals — both are constructor arguments, bounded but not
pinned. A deployer could legally set 5.0x/5.0x/5.0x and a 90-day epoch.

**I-F4 (highest-value extraction path in this system).** The concentration
penalty *requires* sybil-splitting rather than merely permitting it — a sole
burner gets zero effective share. Combined with the independent √N gain from
sqrt-dampening, an attacker fragmenting across N addresses converts a
mechanism intended to bound whale dominance into one that rewards
fragmentation, for the cost of N transactions' gas.

**I-F5.** `boostMultiplier`'s documented cap is dead code (mathematically
unreachable, since contribution ≤ total always). The boost also reads raw
(not penalty-adjusted) contribution — linearly sybil-splittable if any
downstream payer sums per-address boosts.

**I-F6.** Cosmetic: `PlankGauge`'s `ShortBurn` error name fires on a long
burn condition — naming only, no value impact.

**I-F7 — RESOLVED, round 7 (`68677cc`).** `receiveDividends()` lacked
`nonReentrant`, contradicting the contract header's claim that "every entry
point is nonReentrant." `claimAndReinvest` makes two external calls
(`weth.deposit`, `indexVault.mintSingleAsset`) between settling and
re-syncing a caller's debt — if the accumulator `acc` rose inside that
window, `_resync` would assign the caller's debt at the new balance/new
`acc`, silently destroying their own pending accrual.

**Definitively traced, not left open.** Confirmed NOT exploitable against
the real call graph, and the reason is structural rather than incidental:
every external read `mintSingleAsset` makes along its price/eligibility path
goes through `IIndexPriceSource`'s `view` functions — the compiler emits
`STATICCALL` for these, making a state-mutating reentrant push impossible at
the EVM level, not merely absent by convention. `weth.deposit()` (canonical
WETH9) makes no external call at all. The only non-static calls in the path
are a `safeTransferFrom` against the distributor's own **immutable**
`reinvestAsset` (not attacker-choosable) and an internal OZ `_mint` (no
hook).

**But proven live, not just theoretical, one dependency away:** a
purpose-built `MockReentrantWeth` was substituted onto the reinvest leg and
made to call `receiveDividends()` from inside both external-call sites.
**With the guard removed, the reentrant push landed and destroyed the
caller's accrual in the adversarial test** — confirming the missing-guard
finding was real, and that correctness currently rests on WETH9's bytecode
staying inert forever, which is not a property this contract should depend
on silently. `nonReentrant` is now added to `receiveDividends()`, closing
the dependency risk permanently rather than leaving it correct-by-luck.
Zero behavior change for legitimate callers — proven by test (honest pushes,
back-to-back same-block pushes, and the wrapped twin all still work
identically; no other function in the file ever calls `receiveDividends`
directly, so nothing was ever legitimately nesting through it).

A companion exhaustive sweep checked every external-call-adjacent function
across all six Index Vault contracts for the same class of gap. Exactly one
real gap existed (this one). Every other function either already carried
`nonReentrant`, or has a specific structural reason it doesn't need one
(e.g. `BackstopSizingCalculator`'s functions are `pure` with zero storage —
a guard needs storage to function and would be pure noise; `checkpoint`/
`refreshEligibleCount`/all governance `queue*`/`execute*` functions make no
external calls or route only through `staticcall`). 390/390 tests passing
(377 baseline + 13 new), independently re-verified.

**I-F8.** No lock-up on staking — `stake → victim's push lands → claim →
unstake`, all as separate top-level transactions, captures a proportional
slice of any dividend push for zero holding period. If the share token is
ever borrowable, capital cost is one block's fee.

**I-F9.** A rounding-to-zero push (`pot * WAD < totalStaked`) permanently
destroys that ETH — `totalReceived` and the zeroing of `undistributed` both
happen before the zero-add to `acc`, contradicting the doc's claim that
parked ETH "is NOT lost."

**I-F10 — RESOLVED, round 8 (`04abae3`).** Sink addresses are now
constructor-validated beyond "non-zero": each must have code (`SinkNotContract`
otherwise), their codehashes are recorded as immutables at deploy, and a
`SinksValidated` event publishes exactly what code each sink contains at
construction time — an auditable, checkable fact instead of a trust
assumption. Deliberately still **no post-deploy mutability of either sink** —
adding a redirect path would have reopened the claw-back risk this contract
was specifically hardened against, so the fix is entirely about
construction-time assurance, never a new admin lever. Proven by test: a
garbage/EOA-shaped sink reverts at deploy in either position; a legitimate
sink deploys and emits the exact attested hashes/sizes.

**I-F11 — RESOLVED, round 8 (`04abae3`).** `tbaAddress` is no longer trusted
from self-report. The sweeper now independently recomputes the canonical
ERC-6551 address via the real registry's own `account()` view
(`accountRegistry`, `accountImplementation`, `accountSalt` — all immutable,
no setter) and requires `tba == derived` before any of the three primitives
proceed, fed only by the caller's already-proven-held `heldTokenId` — never
anything the supplied address self-reports about itself, so a TBA can't
steer its own verification. **Proven as a real fix, not just added code**: a
regression test constructs a fake TBA that genuinely passes all three old
checks (`token()`/`owner()` self-report correctly, the NFT really is
vault-held) and confirms it is now rejected with
`TbaNotRegistryDerived(fake, derived)`, with `wasExecuted() == false` — the
exact hole the finding described, closed at its root rather than patched
around. All three sweep primitives re-confirmed working for genuine
registry-derived TBAs. Sweeper suite 33 → 43 tests, `SWEEPER_VERSION` bumped
1 → 2.

**I-F12.** Header claims swept ERC-721s are "redeemable pro rata through the
vault's own path" — but the sweep destination (`miscellanySink`) is
constructor-required to differ from the vault specifically so swept NFTs
stay outside vault accounting. Both statements cannot be true simultaneously.

**I-F13 — spec-vs-implementation deltas** (design doc says one thing, code
does another; not bugs, but must not be treated as matching):
- **vePLANK does not exist.** The spec's vote-escrow, locked/decayed-weight
  model was replaced by the burn-based epoch gauge actually implemented —
  opposite reversibility, opposite capital cost, opposite decay semantics.
- **The fee loop is now PARTIALLY wired — round 8 (`40a42f4`), the vault→distributor
  leg is real; the vault→gauge leg is a deliberate, documented non-build.**
  See §3 below for the full mechanism and the reasoning that decided each leg.
- **The NAV oracle differs in kind from its cited precedent** — Uniswap v4's
  Truncated Oracle is geometric-mean with a per-block cap; the
  implementation is arithmetic-mean over an 8-slot ring buffer with a
  per-checkpoint cap. The truncation property survives; the estimator and
  cadence don't match the citation.
- **"No collection above 40% of NAV" is not what ships** — the actual
  enforced cap is `min(dynamic HHI cap, flat parameter)`, and at zero
  eligible constituents (the default, since eligibility is opt-in per
  constituent) it collapses to whatever flat value the deployer chose.
- **Confirmed as matching, not a delta:** "always redeem at NAV_low, always
  mint at NAV_high" is honored exactly as specced.
- **Confirmed as matching:** the intent/solver-auction requirement is
  correctly scoped out — the vault has no vault-initiated trade at all (only
  two token-out call sites, both to `msg.sender` inside a redemption).

---

# §3. The end-to-end incentive flow — tracing one dollar

**Live today (V3):** a marketplace/vault fee is paid → `accruedFees` →
`withdrawFees()` → 100% to one `treasury` address. No hop, no split, no
ecosystem participant sees any of it except via the completely separate
swap-fee-in-reserves mechanism, which pays LPs via `k`-growth, never treasury.

**Simulator-only (Index Vault) — round 8 closed the vault→distributor leg for
real, using the same proven separation pattern V3 already uses live.**

`GlobalIndexVault`'s single-asset imbalance fee, at the moment it's
collected (both mint and redeem sides), now splits into two genuinely
separate destinations — **never carved out of an existing reserve after the
fact**, computed once at the moment of collection:

```
ecosystemFeesWei[token] += feeWei * ecosystemFeeSplitBps / BPS   // segregated ledger
reserve[token]          += feeWei * (BPS - ecosystemFeeSplitBps) / BPS  // NAV-backing, as before
```

`ecosystemFeeSplitBps` defaults to 2000 (holders keep 80% of the fee's NAV
lift), hard-ceilinged at 3000 (30%), timelocked, owned by
`ROLE_PLATFORM_ALLOCATION` (not `ROLE_RISK_PARAM` — the split doesn't change
what anyone is charged, it changes where an already-charged fee is booked,
the same category of decision `platformAllocationBps` already makes).
`ecosystemFeesWei` is a genuinely separate mapping — **never read by `nav()`,
`priceBand()`, `weightBps()`, or `targetWeightsBps()`, never payable to a
redeemer.** `redeemProRata` reads only `reserve`, completely unaffected by
whether the ledger is full or empty — proven by a differential test that
runs the identical exit against bit-identical reserves and supply with the
ledger full vs. empty and confirms the payout is byte-identical either way.

`harvestEcosystemFees()` — permissionless trigger, zero arguments, fixed
destination (`ecosystemSink`, timelocked to appoint, itself scoped at
appointment time to one asset read once from the sink's own `reinvestAsset()`
so a non-matching constituent's fee simply never accrues rather than being
trapped in an unspendable ledger) — routes the harvested WETH into
`IndexDividendDistributor.receiveDividendsWrapped()`, which every staked
index-share holder then earns pro-rata via the accumulator described in §2.6.
**This is the first real, wired, automatic path from a live fee event to an
ecosystem participant in this system.**

**The vault→gauge leg was investigated and deliberately NOT built — this is
correct, not incomplete.** `PlankGauge`'s zero-payment-surface property (no
payable function, no token custody, no intake of any kind — its own header
states "THIS CONTRACT PAYS NONE OF IT. It cannot.") is proven and load-bearing
for this system's security model; giving it any fee intake requires custody,
which is exactly what that property forbids. Harvested fees route to the
distributor only. If gauge-directed incentives are ever wanted, they need a
new, separately-designed mechanism that doesn't compromise PlankGauge's
proven zero-custody property — not a retrofit onto this feature.

**Platform allocation (up to 5% of new-mint shares, diluting only the
depositor, never existing holders) remains a fully separate mechanism from
this fee split** — both exist, both are real, neither substitutes for the
other.

---

# §4. What remains explicitly unbuilt or spec-only

- **The vault→gauge fee leg** — deliberately not built. `PlankGauge`'s
  zero-custody property is load-bearing and correct; feeding it real value
  requires a new, separately-designed mechanism, not a retrofit. The
  vault→distributor leg (§3) is real and wired.
- A funded backstop reserve — deliberately not built; see spec Part K.
- MEV-safe execution/intent-settlement — investigated and found unnecessary
  given the vault has no vault-initiated trade; see spec §4/§5.4 STATUS block.
- Real testnet or mainnet deployment infrastructure — untouched, unscoped,
  and intentionally out of this session's scope: deployment is bullish's to
  drive when the time comes.
- `platformTreasury` and `ecosystemSink` appointment — both mechanisms are
  fully built and timelock-gated, but neither treasury/sink has ever been
  appointed, since this system has never been deployed. Both are deploy-time
  operational decisions, not code gaps.

**Closed this round, no longer open:**
- ERC-6551 registry-derived TBA address verification (I-F11) — closed,
  `04abae3`.
- TBA sweep sink hardening (I-F10) — closed, `04abae3`.
- `receiveDividends()` reentrancy gap (I-F7) — closed and definitively
  resolved (not left as "unproven"), `68677cc`.
- The vault→distributor fee-loop leg — closed, `40a42f4`.

**One real operational note for whoever eventually deploys this:**
`GlobalIndexVault.sol` is now 24,513/24,576 bytes — 63 bytes under the
EIP-170 contract-size limit. The next feature touching this specific file
will need library extraction to fit; this round already spent the cheap
savings available (folding a new timelock key into the existing queue
instead of a bespoke one, reusing an existing error instead of a new one,
dropping a redundant approval step).

---

*Merged from two independent, code-level, read-only audit passes
(`ECONOMY-V3-LIVE-BREAKDOWN.md`, `ECONOMY-INDEXVAULT-SIMULATOR-BREAKDOWN.md`),
cross-checked against source by the orchestrating session before merge.
Nothing in this document authorizes or constitutes a deployment.*
