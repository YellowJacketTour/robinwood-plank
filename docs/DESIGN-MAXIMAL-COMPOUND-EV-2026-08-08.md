# Maximal Compounding EV — Every Junction Compounds by Default

**Status:** design upgrade to CVI-SOTA / AXIOM-1. Binding for product spirit.  
**Date:** 2026-08-08  
**Research anchors:** ERC-4626 auto-compound vaults (Yearn/Beefy class) · real-yield reinvestment · equity DRIPs · NFTX inventory staking fee→backing · Uniswap-style fee autocompound into LP · protocol-owned liquidity fee harvest (without OHM-style reflexive mint) · Hyperliquid-style buyback accrual  

**Hard rules preserved:** no settlement oracle · fee ≠ free iToken mint · pro-rata exit always · PLANK not a redeemable basket leg · trustless Bus (no spendable admin sink).

> **Retired planning history, superseded in full by
> `docs/AXIOM-1-AS-BUILT.md`.** Read that document instead.

---

## 0. Principle

**Anywhere value is cash-out or dead-end today becomes either:**

1. **Auto-compound into claims / depth / scarcity** (default), or  
2. **Opt-in cash** for users who explicitly want liquidity (opt-out of DRIP), never the protocol default for protocol-controlled energy.

**Positive EV test (every pipe):**  
Would an honest long-term index holder, x-staker, or LP prefer this routing over pure extraction?  
If extraction only helps a short-term actor at long-term holders’ expense → **reject**.  
If reinvestment increases nested redeemable claim or durable depth faster than leakage → **adopt**.

---

## 1. Audit: where compounding was missing

| Junction | Current (pre-upgrade) | Leak type | +EV compound upgrade |
|----------|----------------------|-----------|----------------------|
| **Pipe D — ETH dividend** | Cash pull leaves system | Cash leakage | **Default DRIP** → reinvest into pro-rata basket / weighted xToken buy → claim↑; opt-out cash |
| **Stream A treasury** | Creator takes cash | Aligned extract (OK if optional) | **Creator Compound Mode**: default or opt-in auto-buy own collection xToken or renounce LP |
| **Idle Bus WETH** | Sits until route() | Time decay of productivity | **Permissionless continuous route** + micro-batch; optional internal “pending → auto-pipe” on next vault fee |
| **Renounced LP fees** | Dead LP may strand trading fees | Dead capital | **POL autocompound**: non-withdrawable principal; harvest fees → more LP or more index inventory |
| **Local 50% swap fee** | Compounds only for LPs who stay | Passive OK for LPs | **Auto-compounder vault** for LP positions (Beefy-class periphery); index can hold auto-comp LP receipt as depth leg |
| **IDX pool fees** | Cash to holders | Leakage if all cash | **Same DRIP default** as Pipe D |
| **Target redeem premium** | If pure treasury | Leakage | **100% → xToken inventory + Bus** (never pure EOA extract) |
| **Solver / AP surplus** | Solver keeps full edge | Optional | **Min protocol skim → Bus** on intent fills (small bps) |
| **PLANK path** | Burn/LP only for PLANK | Index gets no compound | **PLANK LP fees harvest → buy more PLANK burn OR WETH to Bus** (index-aligned flywheel without basket PLANK) |
| **Burn IDX** | Scarcity only | Already claim↑ | Keep; optional **buy → dead-lock** already maxes EV for stayers |
| **Redeem exit** | User exits | Necessary | No change — exit door sacred; cannot compound someone out |

---

## 2. Research → mechanism map

| Industry pattern | Source class | How we use it |
|------------------|--------------|---------------|
| **ERC-4626 share price ↑** | Yearn, Beefy, modern vaults | xToken + iToken nested claim; DRIP increases assets not free mint from air |
| **Auto-harvest reinvest** | Yield automation / aggregators | Energy Bus + POL fee harvester permissionless `compound()` |
| **DRIP** | Equity dividend reinvestment | Index holders: default reinvest dividends into more basket exposure |
| **Inventory fee → backing** | NFTX xToken pools | L1 already; expand premiums & fee share into x backing |
| **LP fee autocompound** | Uni V2 k↑, V3 compounders, permanent LP | Renounced/POL positions reinvest fees into more depth |
| **Buyback without emissions** | Real-yield buybacks, fee switch burns | IDX burn + PLANK burn from real fees only |
| **POL fee capture** | Protocol-owned LP (sans reflexive mint) | Own LP, harvest fees, never mint against own token price for POL |

**Reject:** inflationary reward emissions “compounding” that dilute; floor-oracle NAV mints; OHM-style bonding that pairs treasury against own coin price death spiral.

---

## 3. Upgraded value machine (defaults)

### 3.1 Energy Bus — still 6 pipes, smarter semantics

| Pipe | bps | Was | **Maximal compound default** |
|------|-----|-----|------------------------------|
| **I** Inventory | 3500 | Buy x → L2 | Unchanged — primary **claim compound** |
| **L** Coll. LP | 1500 | Renounce | **POL + fee autocompound** into more LP (principal non-withdrawable) |
| **X** IDX scarce | 1500 | Buy+lock | Unchanged — **claim/share compound** for remaining holders |
| **P** PLANK burn | 1000 | Burn | Unchanged scarcity |
| **R** PLANK LP | 1000 | Renounce | **POL + harvest fees → 50% more PLANK burn, 50% WETH to Bus I/D** |
| **D** Holder yield | 1500 | Cash div | **Default DRIP** (see §3.2); cash is opt-out |

### 3.2 Pipe D — DRIP default (world-class)

**Problem:** Cash dividends are +EV for spenders but **stop compounding** fund NAV for passive holders.  
**SOTA fix:** DRIP (equity markets) + 4626 reinvestment (DeFi).

```
On credit to Pipe D:
  if holder.dripEnabled (default TRUE):
      use WETH to mintProRata-equivalent exposure:
        - buy weighted xTokens (same WeightModule as Pipe I) into L2
        - credit holder via:
            (A) increase their iToken balance by minting against deposited basket, OR
            (B) preferred: raise global assets so all holders' redeemable claim↑ without mint
               (exchange-rate compound — works in Uniswap LPs holding iToken)
  else:
      credit EIP-2222 cash pull (legacy cash path)
```

**Recommendation: default (B) exchange-rate** for protocol-controlled D energy (same as fee surplus), so iToken in external pools still compounds.  
Optional per-wallet DRIP of *extra* personal cash uses (A) only if they opt into share mint against their reinvested basket.

**Protocol-controlled D (Bus):** always **(B)** — pure compound, no free mint, works everywhere.  
**User-level “I want cash”:** divert a governed sub-split of D to pull dividends for wallets that set `preferCash=true`.

Genesis: `DRIP_BPS_OF_D = 10000` (100% of D compounds via assets) for pure max compound testnet; or `7000` compound / `3000` cash pool for product flexibility.

**+EV:** Long-term holders and LP-of-iToken benefit; cash users opt in; no dilution mint from fees.

### 3.3 Creator treasury — compound mode

```
treasuryMode = CASH | COMPOUND_X | COMPOUND_LP
default for new factory vaults: COMPOUND_X
  → Stream A residual auto-buys xToken of that collection, held by treasury or burned into vault inventory stake
```

Creator can timelock-switch to CASH (honest extract).  
**+EV for collection ecosystem:** creator wealth tied to xToken / vault success, not pure fee farming.

### 3.4 POL LP autocompound (Pipe L & R)

Renounce ≠ “fees vanish.”

```
CollectionLpPosition:
  - principal LP tokens: non-transferable / dead-locked (no admin withdraw)
  - fee harvest: permissionless compound()
      swap fee tokens → balanced addLiquidity → more locked LP
  - optional skim: max SKIM_BPS of harvested fees → Bus (index holders share depth profits)
```

**+EV:** Depth grows forever; optional skim funds more art buys; no rug.

### 3.5 Premiums & residual leakage closed

| Source | Route |
|--------|--------|
| Target NFT redeem premium | 50% xToken inventory compound, 50% Bus |
| Intent/solver protocol fee | 100% Bus |
| Dust / skip→D | Already holders; under §3.2 becomes compound default |
| Donation WETH to diamond | Reconcile → vest → compound into reserves (not free shares) |

### 3.6 LP position auto-compound (periphery, user +EV)

Offer `AutoCompoundVaultLP` (4626): deposits collection LP tokens, harvests fees, reinvests — Beefy-class.  
Index may hold this receipt as depth accounting if redeemable via proportional exit only.

---

## 4. Positive EV matrix (every party, post-upgrade)

| Party | Compounding EV | Cash option |
|-------|----------------|-------------|
| **iToken holder** | Nested x·v claim↑ + D reinvest + burn scarcity | Opt-in cash sub-split |
| **xToken staker** | Fees+premiums raise v/x continuously | Exit to v→NFT |
| **Vault LP** | Local fee half + auto-compound vault | Withdraw LP |
| **Creator** | Default own-x accumulate | Timelock to cash |
| **PLANK holder** | Burn + LP depth; LP fees partly more burn | — |
| **Trader** | Better depth over time (lower impact) | Immediate swap |
| **Washer** | Still pays fees; funds others’ compound | EV negative |

---

## 5. Revised “no dead ends” theorem

**Theorem:** Every WETH unit of protocol-controlled fee energy eventually becomes one of:

1. **More nested NFT claim** (x in L2 or v behind x), or  
2. **More non-withdrawable depth** (autocompounding POL), or  
3. **Higher claim per iToken** via burn/lock, or  
4. **User-opted cash** (minority path),  

and **never**: free iToken inflation, oracle mint, admin extract, or stranded fees on dead LP.

---

## 6. Implementation delta (Opus / ONESHOT addendum)

1. `DividendAdapter` / Pipe D → `compoundToReserves()` default; cash ledger only if `cashBpsOfD > 0`.  
2. `CollectionLpRenounceAdapter` → POL contract with `harvestAndCompound` + optional skim.  
3. `PlankLpRenounceAdapter` → harvest → burn PLANK + Bus.  
4. `CollectionVault` treasuryMode enum + compound path.  
5. Premium routing to x + Bus.  
6. Tests:  
   - COMP-1: D energy raises nested claim without iToken supply↑  
   - COMP-2: POL harvest increases LP depth  
   - COMP-3: creator COMPOUND_X increases treasury x balance  
   - COMP-4: skip→D compounds not only cash  
   - COMP-5: cash opt-in still works when enabled  

---

## 7. Genesis defaults (max compound testnet)

```
DRIP_BPS_OF_D           = 10000   // 100% of Pipe D → asset compound
CASH_BPS_OF_D           = 0       // enable later if product wants cash UX
POL_FEE_SKIM_TO_BUS_BPS = 2000    // 20% of POL harvested fees → Bus
CREATOR_TREASURY_MODE   = COMPOUND_X
PREMIUM_TO_X_BPS        = 5000
PREMIUM_TO_BUS_BPS      = 5000
INTENT_PROTOCOL_FEE_BPS = 5       // 0.05% to Bus on solver fills
```

Bus pipe bps unchanged: `3500/1500/1500/1000/1000/1500`.

---

## 8. Marketing / user language

| Old chip | New chip |
|----------|----------|
| ETH dividend (cash only) | **Yield → reinvests into more art claim (cash opt-out)** |
| Renounce LP | **Permanent depth that keeps earning & reinvesting** |
| Creator treasury | **Creator wealth can auto-buy their own vault claims** |

---

## 9. Verdict

| Goal | Status |
|------|--------|
| Every non-compound junction researched | Yes |
| World-class patterns applied | 4626, DRIP, NFTX inventory, POL harvest, buyback scarcity |
| Maximal +EV for long-term holders | Default compound everywhere protocol controls energy |
| User freedom | Cash / creator cash via explicit opt-in |
| Oracle-free / no free mint | Preserved |

**This is the missing layer on AXIOM-1:** not only “route fees,” but **never stop compounding** unless a human opts into cash.

---

*Deployment still requires ONESHOT implementation + audits. This doc upgrades the economic machine’s defaults.*
