# MarketplankVaultV3 — live economy, exact breakdown

Read-only audit of `contracts/MarketplankVaultV3.sol` (788 lines) plus every
app-layer reference to fees/treasury in `lib/` and `app/api/`. Scope: the LIVE
production economy only. The Index Vault / `IndexDividendDistributor` design is
out of scope here.

Live deployment: `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`, Robinhood Chain
mainnet (chainId 4663), `VAULT_VERSION() == 3`, share token `vROBIN`, since
2026-08-01 (`docs/marketplank/DEPLOY-V3-RUNBOOK.md`).

---

## 1. The headline answer: is there any fee split?

**No. 100% of every ETH fee the contract collects goes to one immutable address,
`treasury`. There is no split, no distributor, no holder revenue-share, no
burn, no second recipient, and no mechanism of any kind to add one.**

Evidence, exhaustive:

- `address public immutable treasury` (line 159). Set once in the constructor,
  `immutable`, no setter anywhere in the file.
- Every fee-taking function does exactly one thing with the ETH:
  `accruedFees += msg.value` — lines 298 (`deposit`), 317 (`depositMany`),
  332 (`requestRandomRedeem`), 418 (`redeemTarget`), 452 (`redeemTargetMany`).
  Five sites, no others.
- `accruedFees` is read in exactly two places: `withdrawFees()` (line 639) and
  the `_assertEthBacked()` invariant (line 756).
- `withdrawFees()` (lines 638–646) zeroes `accruedFees` and sends the whole
  amount to `treasury.call{value: amount}("")`. It is permissionless — anyone
  may call it — but the destination is fixed, so "permissionless" only means
  anyone can *trigger* the payout, never redirect it.
- There is no `receive()`, no fallback, no owner, no pause, no upgrade path, no
  admin withdrawal of pool ETH. Stray ETH sent to the contract is inert dead
  capital (it is not in `ethReserve` and not in `accruedFees`).

The only non-treasury economic beneficiary in the whole contract is **liquidity
providers**, and they are paid by a completely separate mechanism that never
touches `accruedFees`: the AMM swap fee is retained *inside the reserves*
(§3.4). That is fee-for-liquidity, not a revenue share on operator income.

**On "Part H" of `SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md`** (operator income vs.
ecosystem revenue-share): confirmed **aspirational/future**. That spec section
itself describes stream 1 as "already paid only to `treasury` per the existing
`withdrawFees` path" — i.e. the spec is *describing* today's single-sink
behaviour as the operator-income side and *proposing* a second, not-yet-built
side. Nothing in the live V3 bytecode implements any part of the split. There
is not even a partial hook: no ecosystem address, no percentage constant, no
event carrying a split, no accumulator other than `accruedFees`.

There is one *incidental* value sink that is not `treasury` and not any live
LP — see Finding F4 (locked seed LP).

---

## 2. Constants — value, unit, and actual enforced bound

| Constant | Value | Unit | Where enforced | Exact enforcement |
|---|---|---|---|---|
| `VAULT_VERSION` | `3` | — | line 146 | `public constant`, generation marker |
| `BPS_DENOMINATOR` | `10_000` | bps per 1.0 | line 171 | divisor in swap math only |
| `SHARE_UNIT` | `1e18` | wei of vROBIN per 1 NFT | line 172 | exactly one share per NFT, everywhere |
| `MAX_MINT_FEE_WEI` | `0.05 ether` = `5e16` wei | wei | ctor line 271 | `mintFeeWei_ > MAX` reverts → **0.05 ETH inclusive is legal**; **no lower bound — 0 is legal on-chain** |
| `MAX_REDEEM_FEE_WEI` | `0.05 ether` = `5e16` wei | wei | ctor line 272 | same; inclusive ceiling, **no floor** |
| `MAX_TARGET_PREMIUM_WEI` | `0.1 ether` = `1e17` wei | wei | ctor line 273 | inclusive ceiling, **no floor (0 premium legal)** |
| `MAX_SWAP_FEE_BPS` | `100` | bps (= 1.00%) | ctor line 274 | inclusive ceiling; **0 bps legal** |
| `MIN_INITIAL_LIQUIDITY` | `1e3` = 1000 | LP units (sqrt(wei·wei)) | `openPool` line 628 | `l0 <= 1000` reverts → l0 must be **strictly ≥ 1001** |
| `MAX_BATCH` | `50` | items | lines 306, 435 | `n == 0 \|\| n > 50` reverts |
| `ROUND_LEAD` | `1` | drand rounds | line 334 | target = `nextRoundAfter(now) + 1` |
| `ROUND_EXPIRY` | `28_800` | drand rounds | `_roundExpired` line 743 | expired iff `nowRound > target && nowRound - target > 28800` (strict) |

Fee immutables (`mintFeeWei`, `redeemFeeWei`, `targetPremiumWei`, `swapFeeBps`,
`treasury`, `collection`, `beacon`) are all `immutable`, fixed at construction,
**forever**. There is no owner-mutable fee in this contract.

Deploy-time values for the live vault are **not recorded in this repo** (the
runbook records the address but not the chosen immutables). The deploy script's
defaults — `scripts/deploy-and-seed-v3.ts:81-84` — are `mintFeeWei = 0.001 ETH`,
`redeemFeeWei = 0.001 ETH`, `targetPremiumWei = 0.002 ETH`, `swapFeeBps = 30`,
and the admin form default is likewise `swapFeeBps: "30"`
(`lib/market/vault-deploy-v3.ts:75`). Worked examples below use those values and
label them as assumptions; the authoritative values are the four public getters
on the live address.

---

## 3. Function-by-function economy

### 3.1 `deposit(uint256 tokenId) external payable nonReentrant`
- Requires `msg.value == mintFeeWei` **exactly** (not ≥) — `IncorrectFee`.
- Pins any pending random draw first, pulls the NFT via `safeTransferFrom`,
  appends to `heldTokenIds`, mints exactly `SHARE_UNIT` (1e18) to `msg.sender`.
- **Fee: flat `mintFeeWei` wei → `accruedFees`. No curve, no bps, no scaling
  with NFT value or vault size.**
- Post: `_assertSolvent()`.

### 3.2 `depositMany(uint256[] calldata tokenIds) external payable nonReentrant`
- `1 <= n <= 50`, else `BadBatch`.
- Requires `msg.value == mintFeeWei * n` exactly.
- One `_mint(msg.sender, SHARE_UNIT * n)` at the end (so the invariant is only
  transiently off, behind `nonReentrant`).
- **Fee: `mintFeeWei * n` → `accruedFees`. Strictly linear — no batch discount,
  no batch surcharge.**

### 3.3 Redemption

`requestRandomRedeem() external payable nonReentrant`
- `msg.value == redeemFeeWei` exactly. **The target premium is NOT charged
  here** — random redemption is the cheap path, by exactly `targetPremiumWei`.
- One vault-wide slot: reverts `RequestPending` if `pendingRequester != 0`.
- Reverts `EmptyVault` if `heldTokenIds.length <= pendingRedeemCount`.
- Burns `SHARE_UNIT` from the caller **immediately**, `accruedFees += msg.value`,
  freezes `frozenLen = heldTokenIds.length`, targets drand round
  `beacon.nextRoundAfter(block.timestamp) + 1`.

`pinPendingDraw() external nonReentrant` — permissionless, free, no fee.
Resolves the draw: `index = uint256(keccak256(abi.encodePacked(seed, requester))) % frozenLen`,
`drawnTokenId = heldTokenIds[index]` (line 708–709).

`claimRandomRedeem() external nonReentrant returns (uint256)` and
`claimRandomRedeemFor(address requester) external nonReentrant returns (uint256)`
— **zero fee**, deliberately: settlement must stay pushable by anyone (the fee
was already taken at request time). Delivery uses `transferFrom`, not
`safeTransferFrom`, so an undeliverable receiver cannot brick the single slot.

`forfeitExpiredRedeem(address requester) external nonReentrant` — **zero fee,
and zero refund.** This is an economic penalty, not a fee: the share burned at
request time is **re-minted to `treasury`** (line 397), and the `redeemFeeWei`
already paid is **not returned**. Net cost to a requester who walks away from a
draw they dislike: one full share (1e18 vROBIN, i.e. one NFT's claim) plus the
redeem fee. The in-contract rationale (lines 382–396) is anti-reroll: a drand
round is public before anyone relays it on-chain, so a requester can compute
their own draw off-chain and decline it by never relaying; refunding would make
that a near-free reroll that cherry-picks rares.

`redeemTarget(uint256 tokenId) external payable nonReentrant`
- `msg.value == redeemFeeWei + targetPremiumWei` **exactly** (line 405).
- `heldTokenIndex[tokenId] != 0` else `TokenNotHeld`.
- If a request is pending: pins it; reverts `ReservedForPendingRedeem` if still
  unpinned, or if `tokenId == pend.drawnTokenId`.
- Reverts `ReservedForPendingRedeem` if `heldTokenIds.length <= pendingRedeemCount`.
- Burns `SHARE_UNIT`, `accruedFees += msg.value`, transfers the NFT out.
- **Fee: `redeemFeeWei + targetPremiumWei`, flat, both to `accruedFees` (i.e.
  100% treasury). The premium is not shared with LPs, not burned, not split.**

`redeemTargetMany(uint256[] calldata tokenIds) external payable nonReentrant`
- `1 <= n <= 50`; `msg.value == (redeemFeeWei + targetPremiumWei) * n` exactly.
- Reservation check is **aggregate**: `heldTokenIds.length < pendingRedeemCount + n`
  reverts (line 447) — a per-item check would let the loop drop held supply
  below what a pending draw is owed.
- Duplicates self-revert (second occurrence is no longer held).

### 3.4 The AMM — `buyShares` / `sellShares`

`buyShares(uint256 minSharesOut) external payable nonReentrant returns (uint256 sharesOut)`

```
inNet     = (msg.value * (10000 - swapFeeBps)) / 10000     // floor
sharesOut = (inNet * shareReserve) / (ethReserve + inNet)  // floor
require sharesOut != 0 && sharesOut >= minSharesOut        // else InsufficientOutput
ethReserve   += msg.value        // FULL input, not inNet
shareReserve -= sharesOut
```

`sellShares(uint256 sharesIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut)`

```
inNet  = (sharesIn * (10000 - swapFeeBps)) / 10000
ethOut = (inNet * ethReserve) / (shareReserve + inNet)
require ethOut != 0 && ethOut >= minEthOut
shareReserve += sharesIn         // FULL input
ethReserve   -= ethOut
```

This is the standard Uniswap-V2 fee-on-input construction: output is priced on
the **discounted** input while the **full** input joins the reserve, so `k`
strictly grows on every swap and the growth is the LPs' fee.

**Critically: neither function touches `accruedFees`. The swap fee never reaches
`treasury` at all — it accrues to LP claims inside the reserves.** Both revert
`PoolNotOpen` until the treasury calls `openPool()`, and `EmptyVault` if either
reserve is zero.

### 3.5 Liquidity

`addLiquidity(uint256 maxSharesIn, uint256 minLpOut) external payable nonReentrant returns (uint256 lpMinted, uint256 sharesUsed)`

```
sharesUsed = ceilDiv(msg.value * shareReserve, ethReserve)   // ceil — favours the pool
lpMinted   = (msg.value * totalLpSupply) / ethReserve        // floor — favours the pool
```
ETH-driven: shares are **pulled** to match `msg.value` at the current ratio, so
there is no mis-ratioed side, no refund path, and no external call. Reverts
`InsufficientOutput` if `sharesUsed == 0 || > maxSharesIn` or
`lpMinted == 0 || < minLpOut`. **No fee.**

`removeLiquidity(uint256 lpIn, uint256 minEthOut, uint256 minSharesOut) external nonReentrant returns (uint256 ethOut, uint256 sharesOut)`

```
ethOut    = (lpIn * ethReserve)   / totalLpSupply   // floor
sharesOut = (lpIn * shareReserve) / totalLpSupply   // floor
```
Pro-rata against **current** reserves both ways, so an LP absorbs any price
move they cause and add/remove can never extract value. **No fee, no exit fee,
no lockup.** LP is internal (`lpBalance` mapping) and **non-transferable** —
there is no LP token and no transfer function for it. `accruedFees` is expressly
excluded from removeLiquidity payouts.

### 3.6 Bootstrap and payout

`seedLiquidity() external payable nonReentrant` — treasury only, pre-open only.
Adds ETH to `ethReserve` with **no LP claim**.

`seedShares(uint256 shares) external payable nonReentrant` — treasury only,
pre-open only. Moves treasury-held shares into `shareReserve` (+ optional ETH).
**No LP claim.**

`openPool() external nonReentrant` — treasury only, **one-way and permanent**.
`l0 = Math.sqrt(ethReserve * shareReserve)`; reverts `InsufficientLiquidity` if
`l0 <= 1000`. Assigns `lpBalance[address(0)] = l0` and `totalLpSupply = l0`.
That seed LP is **permanently locked and unredeemable** — pool ETH can never be
withdrawn below it and reserves stay strictly positive, so the pool cannot be
bricked or rugged.

`withdrawFees() external nonReentrant` — permissionless trigger, fixed
destination. `amount = accruedFees; accruedFees = 0; treasury.call{value: amount}("")`,
reverts `NoFees` on zero and `TransferFailed` on a reverting treasury. A
reverting treasury bricks **only this call**, never deposits or redemptions —
that is the whole reason fees are pulled rather than pushed.

### 3.7 Invariants

```
SOLVENCY:    totalSupply() + pendingRedeemCount * SHARE_UNIT == heldTokenIds.length * SHARE_UNIT
ETH BACKING: address(this).balance >= ethReserve + accruedFees
```
`_assertSolvent()` runs after every NFT/share-moving call; `_assertEthBacked()`
after every ETH-out call (`sellShares`, `removeLiquidity`, `withdrawFees`).
Reserves are **explicit storage**, not live balances, so donation-inflation is
impossible.

---

## 4. Worked numeric examples

Assumed immutables (deploy-script defaults — verify against the live getters):
`mintFeeWei = 1e15` (0.001 ETH), `redeemFeeWei = 1e15`, `targetPremiumWei = 2e15`
(0.002 ETH), `swapFeeBps = 30`.

### Example A — deposits and the treasury payout, end to end

Start: `accruedFees = 0`, treasury ETH balance `T`.

1. Alice calls `deposit(4242)` with `msg.value = 1_000_000_000_000_000` wei.
   - NFT #4242 → vault; `heldTokenIds.length` +1.
   - Alice receives `1_000_000_000_000_000_000` vROBIN (1e18 = one share).
   - `accruedFees: 0 → 1e15 wei`. Treasury balance still `T` (nothing pushed).
2. Bob calls `depositMany([7, 8, 9])` with `msg.value = 3e15` wei (exactly
   `1e15 * 3`; `3e15 - 1` or `3e15 + 1` reverts `IncorrectFee`).
   - Bob receives `3e18` vROBIN.
   - `accruedFees: 1e15 → 4_000_000_000_000_000 wei` (0.004 ETH).
3. Anyone (a keeper, Alice, a stranger) calls `withdrawFees()`.
   - `accruedFees: 4e15 → 0`; treasury receives exactly `4e15` wei.
   - **Running total to treasury: 0.004 ETH. Running total to LPs: 0. Running
     total to any ecosystem/holder mechanism: 0 — no such mechanism exists.**

Vault state: 4 NFTs held, 4e18 vROBIN outstanding, solvency exact.

### Example B — targeted redeem (the premium path)

Continuing from A. Carol wants NFT #7 specifically, not a random draw.

- She calls `redeemTarget(7)` with `msg.value = redeemFeeWei + targetPremiumWei
  = 1e15 + 2e15 = 3_000_000_000_000_000` wei (0.003 ETH). Any other value
  reverts `IncorrectFee`.
- `1e18` vROBIN burned from Carol; `accruedFees: 0 → 3e15 wei`; NFT #7 out.
- The random path for the same NFT would have cost her `1e15` wei but given her
  a `1/frozenLen` draw. **The premium she paid to choose is exactly `2e15` wei,
  and 100% of it lands in `accruedFees` → `treasury`.** Zero of it goes to LPs,
  zero is burned, zero is shared.
- Next `withdrawFees()`: treasury receives `3e15` wei. **Running total to
  treasury across A+B: 0.007 ETH.**

### Example C — a swap, showing the fee bypasses the treasury entirely

Pool state: `ethReserve = 2e18` (2 ETH), `shareReserve = 1e19` (10 shares),
`poolOpen = true`, `accruedFees = 0`.

Dave calls `buyShares(minSharesOut)` with `msg.value = 1e17` (0.1 ETH):

```
inNet     = 1e17 * 9970 / 10000            = 9.97e16 wei
sharesOut = 9.97e16 * 1e19 / (2e18 + 9.97e16)
          = 9.97e35 / 2.0997e18            ≈ 4.7483e17 wei of vROBIN (≈0.4748 shares)
```
- `ethReserve: 2e18 → 2.1e18` (the **full** 0.1 ETH, not the discounted 9.97e16).
- `shareReserve: 1e19 → ≈9.5252e18`.
- `k`: `2e18 × 1e19 = 2.0000e37` → `2.1e18 × 9.5252e18 ≈ 2.00029e37`. **k grew.
  That growth is the LP fee.**
- `accruedFees: 0 → 0`. **The treasury earned nothing from this trade.**

Dave then sells 0.5 shares back — `sellShares(5e17, minEthOut)`:

```
inNet  = 5e17 * 9970 / 10000                    = 4.985e17
ethOut = 4.985e17 * 2.1e18 / (9.5252e18 + 4.985e17)
       = 1.04685e36 / 1.00237e19                ≈ 1.0444e17 wei ≈ 0.10444 ETH
```
- `shareReserve` takes the full `5e17`; `ethReserve: 2.1e18 → ≈1.9956e18`.
- Dave paid 0.1 ETH for 0.4748 shares and got 0.10444 ETH back for 0.5 shares —
  the round-trip loss versus the mid is the 30 bps taken twice plus curve
  impact, and every wei of it stayed in the reserves for LPs.
- `accruedFees` still `0`. **Treasury running total across A+B+C: 0.007 ETH,
  entirely from mint/redeem/premium. LP running total: the k-growth from two
  swaps. These two revenue pools never mix, in either direction.**

---

## 5. App-layer cross-check

Checked: `lib/market/vault-v3.ts`, `lib/market/vault-stats.ts`,
`lib/market/vault-deploy-v3.ts`, `lib/market/migration.ts`,
`lib/market/useVaultLive.ts`, `app/api/market/treasury/route.ts`,
`app/api/admin/finance/route.ts`, `app/api/admin/vault-deploy/route.ts`.

Matches confirmed:
- `quoteBuy` / `quoteSell` (`vault-v3.ts:196-205`) reproduce the contract's
  `inNet` formula **exactly**, same floor-division order. `quoteAddLiquidity` /
  `quoteRemoveLiquidity` likewise.
- `vault-deploy-v3.ts:28-31` mirrors all four contract ceilings with the
  correct values and the correct inclusive/exclusive sense.
- `vault-stats.ts` `aprPct` docs are correct and unusually careful: mint/redeem
  fees are treasury income and **explicitly excluded** from LP APR; only
  `volume × swapFeeBps` feeds the APR (`vault-stats.ts:648`).
- `feePerRedeemWei` correctly **excludes** `targetPremiumWei` for the random
  path, matching `requestRandomRedeem`'s `msg.value == redeemFeeWei`.
- `app/api/admin/finance/route.ts:39` labels `MARKET_FEE_RECIPIENT` as
  "Marketplank's treasury (marketplace + vault fees)" — a single wallet, which
  is exactly what the contract implements. No app code anywhere assumes a split
  recipient, a distributor, or a holder dividend from V3 fees.

---

## 6. Findings (reported, not fixed)

**F1 — app copy promises a refund the contract does not give (real mismatch).**
`lib/market/vault-v3.ts:46`:
`RandomnessExpired: "Your redeem's drand round expired. You can forfeit it for a refund and retry."`
`forfeitExpiredRedeem` refunds **nothing**: the burned share is re-minted to
`treasury` (line 397) and the `redeemFeeWei` is kept in `accruedFees`. The
contract's own comment says burning is "load-bearing, not a fee" precisely
*because* a refund would enable free rerolls. A user who follows this copy
loses one full share plus the redeem fee. (`lib/market/vault.ts` has the same
`forfeitExpiredRedeem` path for legacy vaults; the V3 error string is the one
that misstates V3's behaviour.)

**F2 — "a predatory-fee deployment is impossible" overstates the on-chain
bound.** The comment at lines 174-175 sits over ceilings only. There is **no
lower bound** in the constructor: `mintFeeWei = 0`, `redeemFeeWei = 0`,
`targetPremiumWei = 0`, `swapFeeBps = 0` all deploy fine. The non-zero
mint/redeem requirement (which the audit notes exists to keep the redeem-slot
rate limiter meaningful) lives **only** in CI (`deploy-vault-v3.yml` guardrails)
and in `lib/market/vault-deploy-v3.ts:180-206` — both bypassable by deploying
the contract directly. Ceilings are also **inclusive** (`>` comparison), so
exactly 0.05/0.05/0.1 ETH and exactly 100 bps are all legal — consistent with
the `MAX_` naming, noted only for precision.

**F3 — `MIN_INITIAL_LIQUIDITY` comment claims a strength it does not have.**
"A LP floor stronger than UniV2's 1000-wei MINIMUM_LIQUIDITY" (line 181) — the
value is `1e3`, *identical* to UniV2's 1000. What differs is the mechanism (a
revert-if-`l0 <= 1000` gate on `openPool`, plus donating the entire `l0` to
`address(0)` rather than only 1000 units), not the number. "Stronger" is true of
the donation, misleading about the constant it annotates.

**F4 — an undocumented permanent value sink: the locked seed LP earns fees
nobody can ever claim.** `lpBalance[address(0)] = l0` holds a pro-rata claim on
both reserves forever, including its share of every swap fee that grows `k`. No
`removeLiquidity` call can ever burn it (no key for `address(0)`), so that
fraction of LP revenue is permanently stranded. `poolComposition()` exposes
`lockedLp` so the UI *can* state what is genuinely removable, but nothing in
the contract docs, `vault-stats.ts`, or the runbook says that locked slice keeps
accruing unclaimable fee revenue. For a pool whose live LP is small relative to
the seed, this is a materially large silent haircut on real LPs' effective fee
rate. It is also, notably, the only place in the live system where fee value
goes somewhere other than `treasury` or a live LP.

**F5 — `targetPremiumWei` has no on-chain floor, so nothing enforces that
targeting costs more than random.** A deployment with `targetPremiumWei = 0`
passes the constructor and makes `redeemTarget` cost exactly the same as
`requestRandomRedeem` while removing the randomness entirely — collapsing the
commit-reveal's economic purpose. Only the CI guardrail's *mint/redeem* non-zero
check exists; there is no premium guardrail at any layer
(`vault-deploy-v3.ts:208-215` checks only the ceiling).

**F6 — the live vault's actual fee immutables are not recorded anywhere in the
repo.** `DEPLOY-V3-RUNBOOK.md` records the deployed address, network, beacon,
and collection, but not the chosen `mintFeeWei` / `redeemFeeWei` /
`targetPremiumWei` / `swapFeeBps`. The only in-repo numbers are *defaults*
(`scripts/deploy-and-seed-v3.ts:81-84`, `vault-deploy-v3.ts:75`) which the
dispatch requires an operator to override (`required: true` on all four
workflow inputs) — so they are not evidence of what is live. Every number in §4
above is therefore an assumption; the authoritative source is the four public
getters on `0xacE28f72…047D`.

**F7 — targeted redemption is fully blocked while an unpinned request exists.**
`redeemTarget` / `redeemTargetMany` revert `ReservedForPendingRedeem` whenever
`pendingRequester != 0` and the draw has not yet been pinned (lines 412, 443) —
not merely for the drawn token, but for *every* token. Combined with the
single vault-wide redeem slot and `ROUND_EXPIRY = 28_800` rounds, an unrelayed
request stalls all targeted-redeem (premium) revenue until someone pins or the
round expires. Correct for solvency; worth naming as a revenue/liveness
coupling rather than a pure safety property.

---

## 7. One-line summary

Four flat, immutable, ETH-denominated fees (mint, redeem, target premium — all
`accruedFees` → single immutable `treasury` via a permissionless-trigger
fixed-destination `withdrawFees()`) plus one bps swap fee that never leaves the
AMM reserves and belongs to LPs. **Zero split, zero distribution, zero
ecosystem revenue-share exists in the live V3 contract today.**
