# Index Vault economy — simulator-only breakdown

> **THIS SYSTEM IS SIMULATOR-ONLY AND HAS NEVER BEEN DEPLOYED.**
> Every contract described here lives in the separate working repo
> `robinwood-plank-index-vault`, branch `feat/global-index-vault`, commit
> `0186100`. There is no deploy script, no address record, no ABI wired into
> any app route, and every contract header carries an explicit
> "NOT FOR DEPLOYMENT" gate. The only consumers of these contracts anywhere in
> the tree are Hardhat tests under `test/contracts/`. Nothing here governs, or
> has ever governed, a live user balance. Do not confuse any number below with
> the live V3 economy documented in `ECONOMY-V3-LIVE-BREAKDOWN.md`.

Scope: `GlobalIndexVault.sol`, `PlankGauge.sol`, `IndexDividendDistributor.sol`,
`BackstopSizingCalculator.sol`, `TBAValueSweeper.sol`, `ScopedRoles.sol`,
`IEligibilitySource.sol`. Read-only pass; nothing was modified.

---

## 0. Deployment-status confirmation (re-checked against current code)

| Question | Answer at commit `0186100` |
|---|---|
| Any deploy script / address record? | No. `deploy/` contains nothing referencing these contracts. |
| Any app/route/lib import? | No. Only `test/contracts/*` and generated `typechain-types/*`. |
| Is the platform allocation wired to a treasury? | **Still inert.** Confirmed in current code, not assumed — see §1.9. |

---

## 1. GlobalIndexVault.sol (2,132 lines)

ERC-20 share token + `ReentrancyGuard` + `ScopedRoles`. Simulator-only.

### 1.1 Constants — value, unit, enforced bound

| Constant | Value | Unit | Bound / enforcement |
|---|---|---|---|
| `INDEX_VERSION` | `1` | — | — |
| `BPS` | `10_000` | bps denominator | — |
| `WAD` | `1e18` | fixed-point scale | — |
| `VIRTUAL_SHARES` | `10 ** 3` = 1000 | shares | added to `totalSupply()` in every mint/redeem denominator |
| `VIRTUAL_ASSETS` | `1` | base unit | added to `reserve` on the **mint** side only |
| `MAX_CONSTITUENTS` | `32` | count | checked in `_list` |
| `OBS_SLOTS` | `8` | ring-buffer slots | also doubles as `MAX_REQUIRED_CHECKPOINTS` |
| `MIN_SEED_SHARES` | `1e6` | shares | `openIndex`: `if (seedShares < MIN_SEED_SHARES) revert BadParam()` |
| `SEED_LOCK` | `0x…dEaD` | address | seed minted here permanently |
| `MIN_TIMELOCK_DELAY` / `MAX_TIMELOCK_DELAY` | `48 hours` / `30 days` | seconds | ctor L451; `timelockDelay` is `immutable` |
| `MIN_CONCENTRATION_CAP_BPS` / `MAX` | `1_000` / `5_000` | bps (10% / 50%) | `_validateParams` L2115 |
| `CEIL_IMBALANCE_FEE_BPS` | `1_000` | bps (10% absolute) | caps `maxImbalanceFeeBps` **and** `imbalanceSlopeBps` |
| `CEIL_BAND_BPS` | `2_000` | bps (20%) | `bandBps <= 2000` |
| `CEIL_PRICE_CAP_BPS` | `2_000` | bps (20% per observation) | `priceCapBps` must be `!=0` and `<= 2000` |
| `MIN_RAMP_DURATION` / `MAX` | `7 days` / `365 days` | seconds | `_validateParams` L2128 |
| `CEIL_PLATFORM_ALLOCATION_BPS` | `500` | bps (5%) | re-checked **at execution**, L1514, `AllocationCapExceeded` |
| `DEFAULT_PLATFORM_ALLOCATION_BPS` | `200` | bps (2%) | set in ctor L464 |
| `DEFAULT_TARGET_HHI_BPS` | `2_000` | bps (HHI 0.20) | ctor L465 |
| `MIN_TARGET_HHI_BPS` / `MAX` | `200` / `10_000` | bps (0.02 / 1.00) | L1535 |
| `VARIANCE_WINDOW` | `90 days` | seconds | tumbling-bucket roll |
| `VOL_STEP_BPS` | `100` | bps (1%) | one extra checkpoint per 1% RMS move |
| `MIN_REQUIRED_CHECKPOINTS` / `MAX` | `2` / `8` (`=OBS_SLOTS`) | checkpoints | hard clamp L846-848 |
| `ELIGIBILITY_GAS_CAP` | `50_000` | gas | `staticcall{gas:…}` L937 |

Additional `_validateParams` bounds (all re-checked at *execution*, never only
at queue time): `baseImbalanceFeeBps <= maxImbalanceFeeBps`;
`minCheckpointInterval` in `(0, 1 days]`; `staleAfter` in
`[2*minCheckpointInterval, 30 days]`; `persistenceCheckpoints` in `[2, 8]`;
`persistenceToleranceBps` in `(0, 10_000]`; `largeOpValueWei != 0`.

Constructor also seeds `minEligibilityFeesWei = 0.1 ether`,
`minEligibilityBlocks = 100` — both are *minimums* with no ceiling, deliberately
(setting them absurdly high drives the eligible count to 0, which makes
`capBpsFor(0)` return 100%, which is then clamped by the flat cap — i.e. worst
case is a fallback to the flat parameter).

### 1.2 Pro-rata redemption math

`redeemProRata(sharesIn, minAmountsOut[])` — **no role modifier, no state flag
on any branch, no price read anywhere.** This is the guaranteed exit door.

```
denom  = totalSupply() + VIRTUAL_SHARES          // 1000 virtual shares
_burn(msg.sender, sharesIn)                       // burn FIRST (stale-supply reentrancy)
for each constituent k:
    out_k = mulDiv(sharesIn, reserve_k, denom)    // FLOOR, against the REAL reserve
    if out_k > reserve_k: out_k = reserve_k
    if out_k < minAmountsOut[k]: revert SlippageExceeded
    reserve_k -= out_k ; safeTransfer(msg.sender, out_k)
```

The asymmetry is deliberate and load-bearing: the **mint** side charges against
`reserve_k + VIRTUAL_ASSETS`, the **redeem** side pays against `reserve_k`
alone. That keeps `out_k * (S + V) <= sharesIn * reserve_k` true for every input
— carrying the `+1` through to the payout would let a redemption pay marginally
*more* than a strict slice (the doc's own worked case: reserve 3, burning half
the effective supply pays 2 where strict pro-rata is 1.5).

`mintProRata(sharesOut, maxAmountsIn[])` is the mirror:
`want_k = mulDiv(sharesOut, reserve_k + 1, totalSupply()+1000, Rounding.Up)`,
each pulled through `_pullCredited` (balance-delta, Balancer-STA style) and then
**rejected if `credited < want`** (`ShortDelivery`) — crediting the true delta
alone would mint full shares against a partial deposit.

### 1.3 Single-asset imbalance-fee curve

One fee function, both directions (`_imbalanceFeeBps`, L1936):

```
if (against == 0) return maxImbalanceFeeBps
d   = (amount * 10_000) / against          // bps, clamped to 10_000
fee = baseImbalanceFeeBps + (imbalanceSlopeBps * d) / 10_000
if (fee > maxImbalanceFeeBps) fee = maxImbalanceFeeBps
```

There is no `isBuy` argument and no direction branch: identical `(amount,
against)` costs identical bps on buy and sell. A withdrawal taking 100% of the
remaining leg pays `base + slope`. Absolute ceiling 1000 bps (10%).

**Mint side layers one extra term** (`_mintFeeBps`, L2081), a function of
(current weight, target weight) *only* — not of direction:

```
idx not found            -> maxImbalanceFeeBps
target[idx] == 0         -> maxImbalanceFeeBps          // unknown = overweight
cur < t (UNDERWEIGHT):
    gap    = ((t - cur) * 10_000) / t                    // 0..10_000
    relief = (depthFee * gap) / 10_000
    fee    = max(depthFee - relief, baseImbalanceFeeBps) // floors at base, never 0, never negative
cur >= t (OVERWEIGHT):
    over = min(((cur - t) * 10_000) / t, 10_000)
    fee  = min(depthFee + (imbalanceSlopeBps * over) / 10_000, maxImbalanceFeeBps)
```

Redeem side keeps the depth fee only (`_previewSingleExit`, L1865):

```
proRataTarget = mulDiv(sharesIn, target.reserve, denom)
otherEth      = Σ_{k≠token} mulDiv( mulDiv(sharesIn, reserve_k, denom), lo_k, WAD )
extra         = mulDiv(otherEth, WAD, targetHi)          // other legs at LOW, target at HIGH
remaining     = target.reserve - proRataTarget           // ReserveWouldEmpty if 0
extra        -= (extra * _imbalanceFeeBps(extra, remaining)) / 10_000
amountOut     = proRataTarget + extra
```

The fee is **retained in reserves** — there is no code path on this contract
that transfers a reserve anywhere except to a share-burning redeemer.

### 1.4 NAV band (`priceBand` / `nav`)

`_observe` records a per-checkpoint movement-capped price:

```
hi = (prev.price * (10_000 + priceCapBps)) / 10_000
lo = (prev.price * (10_000 - priceCapBps)) / 10_000
capped = clamp(spot, lo, hi) ; if (capped == 0) capped = 1
cumulative += prev.price * dt
```

`spot = mulDiv(ethReserve, WAD, shareReserve)` — read off the constituent's own
reserves, never submitted.

`priceBand(token)` over the `obsCount` retained observations:

```
minP = min(obs.price) ; maxP = max(obs.price) ; twap = Σ obs.price / n   // ARITHMETIC mean
low  = (minP * (10_000 - bandBps)) / 10_000
high = (maxP * (10_000 + bandBps)) / 10_000
if (now > last.timestamp + staleAfter) low = 0        // asymmetric circuit breaker
```

Stale → `low = 0` (contributes nothing to what you are credited for giving up)
while `high` is retained (still expensive to receive). Pro-rata redemption is
unaffected — it reads no price at all.

```
nav():  navLow  = Σ mulDiv(reserve_k, lo_k, WAD)
        navHigh = Σ mulDiv(reserve_k, hi_k, WAD)
weightBps(token) = (mulDiv(reserve, lo, WAD) * 10_000) / navLow
```

Enforcement is `_requireCapNotWorsened`: an operation reverts only if a leg is
both **over the cap** and **higher than before**. A flat "weight <= cap always"
invariant would brick the basket the first time a constituent rallied.

### 1.5 Dynamic HHI-derived concentration cap (closed form)

HHI of a weight vector is `Σ w_i²`. The binding (cheapest-in-HHI) configuration
for a single-name cap is one leg at `w` and `(1-w)` spread evenly over `n-1`:

```
HHI(w) = w² + (1-w)²/(n-1) = T
    ⇒  n·w² − 2w + (1 − T(n−1)) = 0
    ⇒  w = ( 1 + sqrt( 1 − n(1 − T(n−1)) ) ) / n        (upper root = max feasible)
```

Implemented in integers (`capBpsFor`, L1048):

```
if (n <= 1) return 10_000
lhs = targetHhiBps * n * (n-1) + 10_000
rhs = 10_000 * n
if (lhs <= rhs) return 10_000 / n            // infeasible target ⇒ equal weights
dNum = lhs - rhs                              // == 10_000 * discriminant
w = (10_000 + sqrt(dNum * 10_000)) / n        // sqrt floors ⇒ cap floors (conservative)
w = max(w, 10_000/n) ; w = min(w, 10_000)
```

Worked: `n=10, T=2000` → `lhs=190_000, rhs=100_000, dNum=90_000,
sqrt(9e8)=30_000, w=40_000/10 = 4000 bps`. Check `0.4² + 0.6²/9 = 0.20` exactly.
`n=50, T=2000` → `w = 4400 bps`; check `0.44² + 0.56²/49 = 0.20` exactly.
`n=3, T=2000` → `lhs=22_000 <= rhs=30_000` → equal-weight `3333 bps`.

The formula is **increasing in n** (asymptote `sqrt(T)` = 4472 bps at T=0.20) —
the header states this explicitly as a correction to the natural-but-false
intuition. Because of that, the effective cap takes the **minimum** with the
flat parameter so admissions can only ever tighten:

```
effectiveConcentrationCapBps() = min( capBpsFor(eligibleConstituentCount),
                                      params.concentrationCapBps )   // flat ∈ [1000, 5000]
```

With zero eligible constituents, `capBpsFor(0) = 10_000` and the effective cap
degenerates to exactly the flat parameter — the correct default for a basket
with no eligibility data.

`eligibleConstituentCount` is a **cache**, recomputed on admission /
deactivation / delist / permissionless `refreshEligibleCount()` — never per
trade. Eligibility itself (`checkEligibility`) is a gas-capped (50k) low-level
`staticcall` into `IEligibilitySource`, fail-closed on every failure mode
(no code, wrong selector, revert, short returndata). `staticcall` rather than
`try/catch` deliberately: a `try` on a call that *succeeds* with undecodable
data raises in the calling contract and is not caught.

### 1.6 Persistence-checkpoint scaling ("EVT-calibrated")

Size term (`requiredCheckpoints`, L749):

```
if (ethValue < largeOpValueWei) return persistenceCheckpoints
required = persistenceCheckpoints + (ethValue / largeOpValueWei) - 1
return min(required, OBS_SLOTS)
```

Volatility term (`realizedVolBps`, L805) — a **two-bucket tumbling window** over
squared per-checkpoint moves, accrued in `_accrueVariance` on the *capped*
price:

```
moveBps = (|capped − prev.price| * 10_000) / prev.price      // ≤ priceCapBps by construction
varCurSumSq += moveBps² ; varCurSamples += 1
roll every VARIANCE_WINDOW (90d): prev ← cur, cur ← 0
realizedVolBps = sqrt( (varPrevSumSq + varCurSumSq) / (varPrevSamples + varCurSamples) )   // RMS bps
```

Combined and hard-clamped (`requiredCheckpointsFor`, L839):

```
required = requiredCheckpoints(ethValue) + realizedVolBps(token) / 100
floorReq = max(params.persistenceCheckpoints, 2)
required = clamp(required, floorReq, 8)
```

`persistenceHoldsFor` then requires `obsCount >= required`, non-stale, and every
retained observation within `persistenceToleranceBps` of the arithmetic TWAP.
Gate applies only above `largeOpValueWei` (`_requirePersistenceIfLarge`).

**This is NOT an EVT/GPD tail fit and the file says so itself** (L763-800): it is
a rolling realized-variance proxy, dominated by the middle of the distribution,
structurally unable to anticipate a move larger than any observed. The stated
reason is that an MLE Generalized-Pareto fit is not practically
Solidity-computable and would have to be submitted off-chain — reintroducing the
oracle-trust problem. The clamp is the defence that does not depend on the
statistics being right. See Finding F1.

### 1.7 Target weights and the ramp

```
raw_i  = sqrt(metric_i)  for legs with rampFactor != 0
bps_i  = raw_i * 10_000 / Σ raw
repeat up to n passes:
    excess   = Σ (bps_i − cap) over legs above cap ; those set to cap
    uncapped = Σ bps_i over legs at/below cap
    bps_i   += (excess * bps_i) / uncapped          for 0 < bps_i < cap
bps_i = (bps_i * rampFactor_i) / 10_000
```

`_rampFactorBps`: active legs ramp **in** linearly over `rampDuration`, and a
stale leg's ramp-in is frozen at zero elapsed. Deactivated legs ramp **out**
linearly (`BPS − elapsed*BPS/rampDuration`) — staleness deliberately does *not*
freeze a ramp-out, since that would pin a silent being-removed leg at full
weight. Genesis constituents open at `rampDuration = 0` (full weight).

`metric` is timelocked (`queueMetric` / `executeMetric`, `ROLE_CONSTITUENT_ADMISSION`)
and only ever moves a *view* — nothing on-chain force-trades against
`targetWeightsBps()`.

### 1.8 Roles (see also §6)

| Role | Constant | May queue |
|---|---|---|
| `ROLE_ADMIN` | `"role.admin"` | role reassignments **only** (timelocked, in `ScopedRoles`) |
| `ROLE_CONSTITUENT_ADMISSION` | `"vault.admission"` | `queueListing`, `queueMetric` |
| `ROLE_RISK_PARAM` | `"vault.risk"` | the 15 risk keys in `roleForParamKey` |
| `ROLE_PLATFORM_ALLOCATION` | `"vault.allocation"` | `platformAllocationBps`, `queuePlatformTreasury` |

`roleForParamKey` **reverts on any unrecognised key** — without that, a
parameter role could write a `keccak256("metric", token)` key into the shared
`queuedParams` mapping and have `executeMetric` apply it, handing the risk role
the admission role's re-weighting power through the back door.

No role holder, and no combination of all four colluding, has a withdrawal path,
a pause, a freeze, or any way to block `redeemProRata`.

### 1.9 Platform allocation — exact mechanism, and its current wiring status

```solidity
function _mintWithAllocation(address to, uint256 grossShares) private returns (uint256) {
    address treasury = platformTreasury;
    uint256 bps = platformAllocationBps;
    if (treasury == address(0) || bps == 0) { _mint(to, grossShares); return grossShares; }
    uint256 cut = (grossShares * bps) / BPS;   // floors, in the depositor's favour
    uint256 net = grossShares - cut;
    if (net == 0) revert ZeroAmount();
    _mint(to, net);
    if (cut > 0) _mint(treasury, cut);
    return net;
}
```

- Default `platformAllocationBps` = **200 bps (2%)**, set in the constructor (L464).
- Compile-time ceiling `CEIL_PLATFORM_ALLOCATION_BPS` = **500 bps (5%)**,
  re-checked at *execution* (L1514), not merely at queue time. No admin, no
  timelock, no future governance can raise it.
- The two `_mint` calls sum to **exactly** `grossShares`, so existing holders'
  NAV-per-share is bit-for-bit unaffected; the depositor pays full value and
  receives shares for `(1 − bps)` of it. The treasury receives *shares*, redeemable
  only through the same strict pro-rata path as anyone else. Reserves are never touched.
- `mintSingleAsset`'s `minSharesOut` is checked against the **post-allocation**
  net (L1321-1322) — a guard satisfied by shares the caller never receives is not a guard.

**Current wiring status — re-verified at this commit, not carried over:**
`platformTreasury` is a plain `address public` with **no constructor
initialisation**, so it is `address(0)` at birth. The only writer is
`executePlatformTreasury()`, reachable only after a timelocked
`queuePlatformTreasury(...)` by `ROLE_PLATFORM_ALLOCATION`. There is no other
assignment anywhere in the file. Therefore **the allocation is still inert**:
with `treasury == address(0)` the first branch fires and every mint behaves
exactly as if the parameter did not exist. The previous finding holds
unchanged — the 2% default is a *number in storage that no code path can spend*
until a treasury is appointed. And since this system has never been deployed,
no treasury has ever been appointed anywhere.

---

## 2. PlankGauge.sol (~1,300 lines) — simulator-only

### 2.1 Constants

| Constant | Value | Unit | Bound |
|---|---|---|---|
| `GAUGE_VERSION` | `2` | — | — |
| `BURN_ADDRESS` | `0x…dEaD` | address | — |
| `MIN_TIMELOCK_DELAY` / `MAX` | `48 hours` / `30 days` | seconds | ctor |
| `MIN_MULTIPLIER_BPS` / `MAX` | `10_000` / `50_000` | bps (1.0x / 5.0x) | `_validateMultiplier` |
| `MIN_EPOCH_DURATION` / `MAX` | `1 days` / `90 days` | seconds | ctor + `executeParam` |
| `MIN_EXPONENT_HALVES` / `MAX` | `2` / `8` | halves ⇒ k ∈ [1.0, 4.0] | `executeParam` |
| `CEIL_BOOST_BPS` | `50_000` | bps (5.0x) | ceiling on `maxBoostBps` |
| `PATH_RAW` / `PATH_PLANK_ETH_LP` / `PATH_COLLECTION_LP` | `0` / `1` / `2` | index | — |

Ctor defaults: `concentrationExponentHalves = 3` (k = 1.5), `baseBoostBps = 10_000`
(1.0x), `maxBoostBps = 25_000` (2.5x).

### 2.2 The three burn-path multipliers

Header documents **1.0x raw / 2.5x PLANK-ETH LP / 3.0x collection LP**
(10_000 / 25_000 / 30_000 bps). Those literals **do not exist in the code** —
`multiplierBps` is entirely a constructor argument. The only enforced invariants
are `each ∈ [10_000, 50_000]` and the monotone ordering
`raw ≤ plankEthLp ≤ collectionLp`, re-enforced per-key in `executeParam`. See
Finding F3.

Applied once, at `_burnFor` L535: `weighted = (burned * multiplierBps[path]) / BPS`.
`burned` is a measured `balanceOf(BURN_ADDRESS)` delta, and `burned > amount`
reverts.

### 2.3 Epoch-reset weight mechanics

```
currentEpoch() = epochAnchorId + (block.timestamp − epochAnchorTime) / epochDuration
epochEndsAt()  = epochAnchorTime + ((elapsed / epochDuration) + 1) * epochDuration
```

All burn state is keyed `[epoch][gauge][account]` **first**, so at a boundary
every read hits a virgin slot: weight is exactly **0**. No decay curve, no
carry-forward, no keeper call, no migration. Retuning `epochDuration` sets
`epochAnchorId = currentEpoch() + 1` and `epochAnchorTime = block.timestamp`,
deliberately skipping one id so ids are never reused. Past epochs stay readable
via `gaugeWeightAt`.

### 2.4 Sqrt dampening — and the honest sybil finding

```
nextWeighted  = prevWeighted + weighted
contribution  = Math.sqrt(nextWeighted)                       // of the epoch CUMULATIVE
epochTotalContribution += contribution − prevContribution
```

Taking the sqrt of the *running total* neutralises per-burn chunking within one
wallet. It does **not** make the mechanism sybil-resistant, and the file's own
header says so explicitly. Splitting weighted amount `w` across N addresses:

```
one address : C₁  = √w
N addresses : C_N = N·√(w/N) = √N · √w = √N · C₁
```

Total contribution rises by **√N** — 1.414x at N=2, 3.162x at N=10, 10x at
N=100, bounded only by gas and by `⌊√(w/N)⌋ ≥ 1`. Against a rival total `T`,
share moves from `√w/(√w+T)` to `√(Nw)/(√(Nw)+T)`, strictly increasing in N.
Every concave weighting function has this property; the only real fix is an
identity layer, which does not exist here. This is *stated accurately* in the
contract, not overclaimed — the corrected finding is that sqrt dampening bounds
*whale dominance per address*, and nothing more.

`_isSameAddressSelfDeal` blocks the gauge, its vault, and its LP token from
burning for themselves; if `redirectSink` is unset that reverts `SelfDealing`,
otherwise the weight is redirected to the sink.

### 2.5 Concentration penalty

```
rawShare_i       = mulDiv(contribution_i, WAD, totalContribution)
penalty_i        = _powHalves(rawShare_i, concentrationExponentHalves)     // = raw^(k), k = halves/2
effectiveShare_i = penalty ≥ WAD ? 0 : mulDiv(raw, WAD − penalty, WAD)
protocolShare    = assigned ≥ WAD ? 0 : WAD − Σ effectiveShare_i

_powHalves(xWad, halves):
    root = Math.sqrt(xWad * WAD)
    acc  = WAD ; repeat `halves` times: acc = mulDiv(acc, root, WAD)
```

Exponent bounds `halves ∈ [2, 8]` ⇒ **k ∈ [1.0, 4.0]**, default k = 1.5. All
rounding floors (penalty understated, effective share overstated). Overflow-safe:
`xWad ≤ 1e18` so `xWad*WAD ≤ 1e36`.

A single burner with `raw = 1.0 WAD` gets `penalty = WAD` ⇒ **effective share
zero**. That is worth stating plainly: the penalty does not merely permit
splitting, at the limit it *requires* it. With N sybils and no rivals each holds
`1/N`, and the attacker's aggregate effective share is `1 − N^(1−k)`: 0 at N=1,
0.646 at N=2, 0.75 at N=4, 0.90 at N=100 (k=1.5). See Finding F4.

### 2.6 LP-yield boost

```
if (total == 0) return baseBoostBps
bps = baseBoostBps + mulDiv(maxBoostBps − baseBoostBps, contribution_i, total)
if (bps > maxBoostBps) bps = maxBoostBps
```

Caps: `baseBoostBps ∈ [10_000, maxBoostBps]`, `maxBoostBps ∈ [baseBoostBps,
50_000]`. Defaults 1.0x → 2.5x. Because `contribution_i ≤ total`, the clamp on
the last line is arithmetically unreachable (Finding F5). Note the boost uses
the **raw** contribution, not the concentration-penalised share — it is not
penalty-protected.

---

## 3. IndexDividendDistributor.sol (485 lines) — simulator-only

Immutables: `shareToken`, `indexVault` (both zero-checked), `reinvestAsset`
(WETH; deliberately *not* zero-checked — zero disables the wrapped/reinvest
paths via `ReinvestUnavailable`). `WAD = 1e18`, `DISTRIBUTOR_VERSION = 1`.
**No owner, no admin, no setter, no pause. Every function is permissionless.**

### 3.1 The accumulator

```
_credit(amount):
    totalReceived += amount
    pot    = amount + undistributed
    staked = totalStaked
    if (staked == 0) { undistributed = pot; emit …; return }      // park, don't revert
    undistributed = 0
    accEthPerShareWad += Math.mulDiv(pot, WAD, staked)            // floors
```

### 3.2 Debt tracking

```
_pending(a)     = accrued > debt ? accrued − debt : 0,  accrued = mulDiv(stakedOf[a], acc, WAD)
_settle(a)      : owed[a] += _pending(a) ; claimedDebt[a] = mulDiv(stakedOf[a], acc, WAD)   // OLD balance
_resync(a)      : claimedDebt[a]  = mulDiv(stakedOf[a], acc, WAD)                            // NEW balance
_crystallise(a) : _settle(a) ; amount = owed[a] ; owed[a] = 0 ; totalClaimed += amount
claimable(a)    = owed[a] + _pending(a)
```

`stake` = `_settle` → measured balance delta → `stakedOf += credited` → `_resync`.
`unstake` = `_settle` → decrement → `_resync` → `safeTransfer(nominal)`.
`claim` = `_crystallise` then a raw `call{value:}` (all effects first); a
zero-amount claim returns 0 without an event.
`receive()` rejects everything except `reinvestAsset` (`DirectEthRejected`) —
one immutable read, fits the 2300-gas stipend.

Rounding is one-directional in two places (the `pot mod staked` remainder at
credit time, and the per-account floor), so `totalClaimed <= totalReceived`
holds structurally. There is no sweep and no rescue: stranded dust is permanent.

---

## 4. BackstopSizingCalculator.sol — simulator-only, and value-free by construction

Zero storage variables, zero payable functions, zero custody, every function
`pure`. `capabilities()` returns `(holdsValue=false, hasStorage=false,
isPayable=false, version=1)`. A funded backstop is explicitly out of scope.

```
n = losses.length                    // revert NoSamples if 0, TooManySamples if > MAX_SAMPLES
confidenceBps < 10_000               // else BadConfidence (100% ⇒ empty tail)
s = _sortedAscending(losses)         // memory copy; caller's array never mutated
cutIndex  = (n * confidenceBps) / 10_000, clamped to [0, n−1]
varWei    = s[cutIndex]
tailCount = n − cutIndex
cvarWei   = (Σ_{i=cutIndex..n−1} s[i]) / tailCount        // FLOOR
suggestedReserveWei = (cvarWei * coverageBps + 9_999) / 10_000    // rounds UP
```

`MAX_SAMPLES = 512` (sample count).

**The O(n²) → O(n log n) fix is present in the current code.** `_sortedAscending`
(L247) is an **iterative bottom-up merge sort** over a memory copy plus one
scratch buffer — no recursion, no pivot, so no stack-depth surface and no
adversarial partition, and O(n log n) on *every* input. The header records the
measured numbers from the old insertion sort: 966k gas at n=64, 3.7M at n=128,
14.8M at n=256, and past ~n=300 uncallable under a 30M block — i.e. the
advertised 512 was, for the reverse-sorted input an attacker supplies for free,
simply unreachable. The 512 is retained because it is now affordable at the
worst case rather than only at the best one. The honest limits are stated
up-front: no parametric tail, unweighted, order-blind, and `tailCount` is
returned explicitly so a caller can see a "CVaR" taken over one observation.

---

## 5. TBAValueSweeper.sol (616 lines) — simulator-only

Immutables: `collection` (ERC-721), `vault`, `reserveSink`, `miscellanySink`,
`timelockDelay ∈ [1 days, 30 days]`. `SWEEPER_VERSION = 1`. Roles:
`ROLE_ADMIN` (rotation only) and `ROLE_SWEEP_ALLOWLIST`.
`AssetKind { None, ERC20, ERC721, PositionManager }`.

Allowlist lifecycle: `queueAsset` (`ROLE_SWEEP_ALLOWLIST`, rejects `kind==None`
and `asset==0`) → **permissionless** `executeAsset` after `eta` →
`cancelAsset` (`ROLE_SWEEP_ALLOWLIST`).

Provenance gate `_requireTbaOfHeldToken` runs on every primitive: `tba != 0`;
`IERC6551Account(tba).token()` returns `(block.chainid, address(collection),
heldTokenId)`; `collection.ownerOf(heldTokenId) == vault`;
`vault.isTokenHeld(heldTokenId)`; `IERC6551Account(tba).owner() == vault`.

| # | Primitive | Allowlist key | Destination | Post-check |
|---|---|---|---|---|
| P1 | `sweepTBAERC20(heldTokenId, tba, asset)` | `allowed[ERC20][asset]` | immutable `reserveSink` | measured `balanceOf(sink)` delta; `SweepDidNotLand` if 0 |
| P2 | `sweepTBAERC721(heldTokenId, tba, asset, assetTokenId)` | `allowed[ERC721][asset]` | immutable `miscellanySink` | `ownerOf == sink` else `SweepDidNotLand` |
| P3 | `sweepLpPositionFees(heldTokenId, tba, positionManager, positionTokenId)` | `allowed[PositionManager][pm]` | `collect(recipient: reserveSink, amount0Max/1Max = type(uint128).max)` | **none** — return value trusted |

All three are `nonReentrant`, **permissionless** (no role), and **take no
recipient argument** — destinations are immutable. There is no ETH primitive:
native ETH stranded in a TBA is unrecoverable by this contract. The contract
itself has no `receive`, no `fallback`, and holds nothing.

---

## 6. ScopedRoles.sol — exact capability map

`ROLE_ADMIN = "role.admin"` reassigns role holders and does **nothing else**.
It cannot queue a parameter, a listing, an allowlist entry, or a treasury.
Reassignment is itself timelocked on the inheriting contract's own
`_timelockDelay()`: `queueRole` (ROLE_ADMIN) → **permissionless** `executeRole`
after `eta` → `cancelRole` (ROLE_ADMIN). One holder per role — granting is
always also revoking. No batch, no immediate path. `_isKnownRole` rejects
unknown keys at queue time. There is **no pause, no freeze, no role-lock and no
flag of any kind** in this file or either inheriting contract.

| Contract | Roles | Reach |
|---|---|---|
| `GlobalIndexVault` | `ROLE_ADMIN` | role rotation only |
| | `ROLE_CONSTITUENT_ADMISSION` | `queueListing`, `queueMetric` — cannot touch risk params or the platform cut |
| | `ROLE_RISK_PARAM` | the 15 whitelisted risk keys — cannot admit a constituent, cannot reach `platformAllocationBps` |
| | `ROLE_PLATFORM_ALLOCATION` | `platformAllocationBps` (≤500 bps) + `queuePlatformTreasury` — cannot touch reserves or any risk param |
| `PlankGauge` | `ROLE_ADMIN` | role rotation only |
| | `ROLE_GAUGE_REGISTRY` | gauge registration, LP allowlists, `redirectSink` |
| | `ROLE_GAUGE_TUNING` | the 7 curve keys (3 multipliers, epoch duration, exponent, base/max boost) |
| `TBAValueSweeper` | `ROLE_ADMIN` | role rotation only (no other function in the file) |
| | `ROLE_SWEEP_ALLOWLIST` | queue/cancel allowlist entries — cannot choose a destination, cannot execute a sweep |

Note that `ROLE_ADMIN` can eventually grant itself another role — unavoidable
for any key-rotation authority that can rotate to an arbitrary address — but
never in one transaction and never without the full public, cancellable delay.

---

## 7. Worked numeric examples

### Example A — PLANK burn → gauge weight → concentration penalty → boost

Epoch `e`, gauge `G`, `multiplierBps = [10_000, 25_000, 30_000]`, k = 1.5,
boost 1.0x → 2.5x.

1. **Alice** burns 100 PLANK-collection-LP via `burnCollectionLp`:
   `burned = 100e18`, `weighted = 100e18 × 30_000 / 10_000 = 300e18`,
   `contribution = ⌊√(3e20)⌋ = 17_320_508_075`.
2. **Bob** burns 400 PLANK raw via `burnPlank`:
   `weighted = 400e18 × 10_000/10_000 = 400e18`,
   `contribution = √(4e20) = 20_000_000_000`.
3. `epochTotalContribution[e][G] = 37_320_508_075`.
   Note Bob burned **4x** Alice's tokens and holds only **1.155x** her weight —
   that is both the 3.0x path multiplier and the sqrt at work.
4. `rawShare(Alice) = 17_320_508_075 × 1e18 / 37_320_508_075 ≈ 0.464115 WAD`.
   `penalty = 0.464115^1.5 ≈ 0.316188`;
   `effectiveShare = 0.464115 × (1 − 0.316188) ≈ 0.317366` → **31.74%**.
   Bob: raw 0.535885, penalty 0.392287, effective **32.57%**.
   `protocolShareWad = 1 − 0.317366 − 0.325662 ≈ 0.356972` → **35.70% unassigned**.
5. `boostMultiplier(G, Alice) = 10_000 + ⌊15_000 × 17_320_508_075 / 37_320_508_075⌋
   = 10_000 + 6_961 = 16_961 bps` → **1.6961x** LP yield.
6. **Sybil arithmetic on the same burn.** Alice instead splits her 300e18
   weighted across 4 addresses of 75e18 each:
   `4 × ⌊√(7.5e19)⌋ = 4 × 8_660_254_037 = 34_641_016_148` — exactly **2x =
   √4** her single-address contribution, lifting her group's raw share from
   46.4% to 63.4% for identical PLANK burned. Her aggregate *effective* share
   rises further because each shard's individual penalty is smaller.

### Example B — dividend accrual through the accumulator

Alice stakes 300e18 index shares, Bob 700e18; `totalStaked = 1000e18`.
A 10 ETH push arrives:

```
_credit(1e19): pot = 1e19, staked = 1e21
accEthPerShareWad += mulDiv(1e19, 1e18, 1e21) = 1e16
```

`claimable(Alice) = mulDiv(300e18, 1e16, 1e18) − 0 = 3e18 wei = 3 ETH`.
`claimable(Bob) = 7e18 wei = 7 ETH`. Exact, no remainder.

Now Alice `claim()`s: `_settle` credits `owed = 3e18` and pins
`claimedDebt = 3e18`; `_crystallise` zeroes `owed`, adds to `totalClaimed`, and
`call{value: 3e18}` pays out. A second 5 ETH push moves `acc` to `1.5e16` and
Alice's next `_pending` is `mulDiv(300e18, 1.5e16, 1e18) − 3e18 = 1.5e18` — her
1.5 ETH share of the second push only.

### Example C — `mintSingleAsset` fee stack, end to end

Basket: `totalSupply = 1000e18` shares, `navHigh = 1000e18` wei (1000 ETH).
Token A: band `lo = 0.5e18` (0.5 ETH per token), `reserve = 200e18`,
current weight 3000 bps, target weight 2500 bps.
Params: `base = 10`, `slope = 200`, `max = 1000` bps.

```
credited  = 10e18 tokens
ethValue  = mulDiv(10e18, 0.5e18, 1e18)              = 5e18 wei (5 ETH)
gross     = mulDiv(5e18, 1000e18 + 1000, 1000e18 + 1) ≈ 5e18 shares
depthFee  = 10 + 200 × ((10e18 × 10_000)/200e18) / 10_000
          = 10 + 200 × 500 / 10_000                   = 20 bps
over      = ((3000 − 2500) × 10_000) / 2500           = 2000 bps
feeBps    = 20 + 200 × 2000 / 10_000                  = 60 bps
sharesOut = 5e18 − 5e18 × 60 / 10_000                 = 4.97e18 shares
```

Platform allocation **as the code stands today** (`platformTreasury == 0`):
depositor receives the full `4.97e18`. *If* a treasury were ever appointed at
the 200 bps default: `cut = 9.94e16`, depositor nets `4.8706e18`, total supply
still rises by exactly `4.97e18` — existing holders' NAV per share unchanged.

Same deposit into an **underweight** leg (current 2000 vs target 2500):
`gap = ((2500−2000)×10_000)/2500 = 2000`, `relief = 20×2000/10_000 = 4`,
`fee = max(20 − 4, 10) = 16 bps` → `sharesOut = 4.992e18`. The rebalancing
deposit is 44 bps cheaper, and the discount floors at `base = 10 bps` — never
zero, never negative.

### Example D — CVaR sizing

Loss sample (ETH): `[1, 2, 3, 4, 5, 6, 7, 8, 9, 100]`, `confidenceBps = 9_000`.
`n=10`, `cutIndex = ⌊10×9000/10000⌋ = 9`, `VaR = s[9] = 100e18 wei`,
`tailCount = 1`, `CVaR = 100e18 wei`. At `coverageBps = 15_000`,
`suggestedReserveWei = (100e18 × 15_000 + 9_999)/10_000 = 150e18` wei.
`tailCount = 1` is the whole point of returning it — this "estimate" is one
observation.

---

## 8. Findings (report only; nothing was fixed)

Severity is relative to a hypothetical deployment. **Nothing here is live.**

### F1 — "EVT-calibrated" is a realized-variance proxy, and the code says so
`realizedVolBps` is RMS of all settled per-checkpoint moves — the second moment
of the *whole* distribution, not a Generalized-Pareto tail fit. It cannot
anticipate a move larger than any observed. The file corrects this in its own
header (L763-800) rather than overclaiming; the finding is that any external
description calling this "EVT-calibrated" is wrong, and the clamp
`[max(persistenceCheckpoints,2), 8]` — not the statistics — is the actual
defence.

### F2 — `PlankGauge` header claims "no reference to any vault … in its ABI or
bytecode", but `collectionVaultOf` is a public mapping (ABI getter),
`queueCollectionLp` takes a `vault` argument, and `CollectionLpApproved` emits
one. The narrower claims (no payable function, no custody) are true; the
ABI/bytecode claim as written is false.

### F3 — Documented gauge defaults do not exist in code
The header specifies 1.0x / 2.5x / 3.0x multipliers and a 7-day epoch. Neither
literal appears anywhere: both are constructor arguments. A deployer may legally
set 5.0x / 5.0x / 5.0x and a 90-day epoch and violate no check. Anyone reasoning
about gauge economics from the header is reasoning about a configuration the
contract does not guarantee.

### F4 — Concentration penalty *requires* sybils rather than merely permitting them
A sole burner (`rawShare = 1.0`) hits `penalty >= WAD` and receives **zero**
effective share. Splitting is therefore not an optimisation, it is the only way
to receive anything at all, and aggregate effective share rises monotonically
with N (`1 − N^(1−k)`). The sqrt layer independently pays `√N` for splitting.
Combined worst case: an attacker who fragments across N addresses converts a
mechanism intended to bound whale dominance into one that rewards it, with the
only cost being N transactions' gas.

### F5 — `PlankGauge.boostMultiplier`'s documented cap is unreachable
`contribution_i ≤ total`, so `bps ≤ maxBoostBps` always and the
`if (bps > max_) bps = max_` clamp is dead code. The NatSpec presents the `min()`
as a binding safety cap. Separately, the boost reads the **raw** contribution,
not the penalised share, so it is linearly sybil-splittable; if any downstream
payer sums per-address boosts, N sybils collect `N·base + (max−base)` against a
single address's `max`.

### F6 — `PlankGauge` error `ShortBurn` fires on a LONG burn
`if (burned > amount) revert ShortBurn()` — the condition is "credited more than
sent". The genuine short case (`burned < amount`) is silently accepted and
credited. Naming only; no value impact.

### F7 — `IndexDividendDistributor`: accumulator can move inside `claimAndReinvest`
`receiveDividends()` carries **no** `nonReentrant` (the header at L77-78 claims
"every entry point is `nonReentrant`"). Between `_crystallise` (L392) and
`_resync` (L407) the function makes two external calls (`weth.deposit`,
`indexVault.mintSingleAsset`). If `acc` rises in that window, `_resync`
**assigns** `claimedDebt` at the new balance *and* the new `acc`, so the
caller's own accrual `oldBal × (acc₁ − acc₀) / WAD` is silently destroyed. The
comment at L402-404 asserts exactly the property that does not hold. Worst case
scales with the caller's entire stake, not the reinvested amount.

### F8 — `IndexDividendDistributor`: no lock-up, so distributions are freely front-runnable
`receiveDividends` is permissionless and mempool-visible; there is no cooldown,
no time-weighting, no minimum hold. `stake(X)` → victim push → `claim()` →
`unstake(X)` captures `X/(totalStaked+X)` of a distribution for a zero holding
period, all as separate top-level transactions (`nonReentrant` is irrelevant).
If the share token is borrowable, the capital cost is one block's fee. Related:
whoever is staked when a push lands while `undistributed > 0` captures the
*entire* parked history — 1 wei of stake suffices.

### F9 — `IndexDividendDistributor`: rounding-to-zero push destroys the pot
If `pot × 1e18 < totalStaked`, L304 adds 0 to `acc` while L292 has already
incremented `totalReceived` and L301 has already zeroed `undistributed`. The ETH
becomes permanently unclaimable. The doc (L97-98) says parked ETH "is NOT lost".

### F10 — `TBAValueSweeper`: sinks are unconstrained constructor arguments
`reserveSink` and `miscellanySink` need only be non-zero and `!= address(this)`
(and `miscellanySink != vault`). Either may be a deployer EOA; `reserveSink` is
not even required to differ from `miscellanySink`. Combined with the fact that
**all three sweeps are permissionless**, a mis-set or hostile `reserveSink`
converts every vault-held NFT's TBA contents into that address's property,
irreversibly, callable by anyone. The immutability the header sells as
protection is equally protection *for* an attacker-chosen sink.

### F11 — `TBAValueSweeper`: no ERC-6551 registry derivation
`tbaAddress` is caller-supplied and authenticated only by two *self-reported*
views on that same address. The standard CREATE2-from-registry recomputation is
absent. A fake TBA passes both honest checks (the real token really is held) and
can, by donating a little of the allowlisted asset to `reserveSink` from inside
its own `execute`, mint a genuine `SweptERC20` event attributing arbitrary value
to any held token id. P3 is worse: it has **no** post-hoc balance verification
at all, so `CollectedLpFees` amounts are whatever an allowlisted position
manager returns. Poisons any off-chain reserve accounting that trusts these
events.

### F12 — `TBAValueSweeper`: swept ERC-721s are explicitly not pro-rata redeemable
Header L51-52 says swept value is "redeemable pro rata through the vault's own
path", but P2 sends NFTs to `miscellanySink`, which the constructor *requires*
to differ from the vault (L303) precisely so they stay outside vault accounting.
Both statements cannot hold.

### F13 — Spec deltas (`SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md` vs implementation)
- **vePLANK does not exist.** §3 specifies a vote-escrow token whose *locked,
  time-decayed* weight directs gauge weight, modelled on veBAL/Curve. What is
  implemented is a **burn-based** gauge: PLANK (or LP) is irreversibly sent to
  `0x…dEaD` for a per-epoch weight that resets to zero. Burning and locking have
  opposite reversibility, opposite capital cost, and opposite decay semantics.
  §5.1's close ("anyone can lock PLANK and out-vote a whale's un-locked position
  over time") does not describe this mechanism.
- **The fee loop is not wired.** §3's closed loop routes the index's own fee
  revenue to gauge-directed pools. `GlobalIndexVault` retains its imbalance fee
  in reserves and has no route out; `PlankGauge` receives no fee flow;
  `IndexDividendDistributor` is push-funded by an arbitrary caller and is not
  referenced by the vault. `protocolShareWad` is a reporting view over
  unassigned share, with no payer behind it.
- **Truncated oracle differs in kind.** §2 specifies Uniswap v4's Truncated
  Oracle hook — a *geometric*-mean TWAP with a **per-block** movement cap. The
  implementation is an *arithmetic* mean over an 8-slot ring buffer with a
  **per-checkpoint** cap (`minCheckpointInterval` ∈ (0, 1 day]). The truncation
  property survives; the estimator and the cadence do not match the cited
  precedent.
- **"No single collection above 40% of NAV"** (§5.3) is not what ships. The flat
  cap is a constructor parameter bounded `[1000, 5000]` bps, and the enforced
  value is `min(capBpsFor(eligibleCount), flat)` — which at `eligibleCount = 0`
  (the default, since no constituent has to implement `IEligibilitySource`) is
  simply the flat parameter, whatever the deployer chose.
- **"Always redeem at NAV_low, always mint at NAV_high"** *is* honoured:
  `mintSingleAsset` values the deposit at leg LOW against `navHigh`;
  `_previewSingleExit` values other legs at LOW and the target at HIGH. Recorded
  as a match, not a delta.
- **§4/§5.4's intent/solver requirement** is correctly scoped out in the spec's
  own STATUS block — the vault has no vault-initiated trade and no order
  outliving its transaction. Confirmed against the code: the only two token-out
  call sites both send to `msg.sender` inside a share-burning redemption.

### F14 — Value-extraction paths worth naming explicitly
1. **Gauge sybil farming (F4/F5)** — highest-value path in the set. `√N` on
   contribution, `1 − N^(1−k)` on effective share, and a linearly-splittable
   boost, all for N transactions of gas. Any real payer sitting behind
   `effectiveShareWad` or `boostMultiplier` is extractable.
2. **Distributor JIT staking (F8)** — capture a proportional slice of any push
   with zero holding period and, if shares are borrowable, near-zero capital.
3. **Permissionless TBA sweeps (F10)** — anyone can strip any held NFT's TBA to
   a fixed sink at any time, with no owner consent and no reversal path. Whether
   that is expropriation or intended pooling depends on vault terms not present
   in the file.
4. **`claimAndReinvest` self-burn (F7)** — not attacker profit, but the
   destroyed accrual is retained by the contract with no route to anyone, so it
   is a permanent one-directional loss to the reinvesting user.
5. **Not found:** any path by which a `GlobalIndexVault` role holder, alone or
   all four colluding, moves a reserve or blocks `redeemProRata`. The
   platform-allocation mechanism dilutes only the *depositor's own* mint and
   leaves existing holders' NAV per share bit-for-bit unchanged, is ceilinged at
   500 bps in compile-time code re-checked at execution, and is **inert today**
   because `platformTreasury` is `address(0)` with a single timelocked writer.

---

*Compiled from a read-only pass over `robinwood-plank-index-vault` @ `0186100`.
No code was modified. Simulator-only; never deployed.*
