# Cake + Eat It — Single Share Atom · Max Compound · Min Risk · Max Elegance

**Status:** synthesis of SOTA + bleeding-edge research; **normative product shape** for Plank CVI.  
**Date:** 2026-08-08  
**Rev:** PERFECT-3 companion  
**Supersedes for share model:** dual retail vToken + xToken. Internal v-units may remain; **users never hold bare v.**  

**Question answered:**  
*How do we have 1:1 mental simplicity **and** default compounding **and** liquid markets **and** fair exit **and** maximal game-theory EV **and** lean contracts **and** minimal exploit / population risk?*

---

## 0. The cake (all at once)

| Want | How we get it without the usual sacrifice |
|------|-------------------------------------------|
| Simple “one share ≈ one NFT unit” | **Genesis rate 1:1**; UI shows *shares* + *est. NFT claim*; redeem uses rate-aware math |
| Everyone compounds | **Only one user token** = yield-bearing inventory share (4626-class) |
| Liquid trading | **AMM is share/WETH** (same liquidity surface as old v AMM) |
| Nested index compound | Index holds **only that share** + WETH; Bus buys **only that share** |
| Fair exit | **Pro-rata iToken redeem** always; collection redeem always rate-aware NFT out |
| No free mint / no oracle settle | Fees raise **assets behind shares**; never mint iToken from fees; no floor feed |
| Lean surface | One share ERC-20 per collection; v is **internal counter** |
| Low population risk | **Finalize diamond**; isolate vaults; no shared mutable brain; Bus immutable pipes |
| +EV for honesty | Wash pays fees; maturity weights; impact skip→compound; DRIP default |

**Cake + eat it = one atom of user value (the Share), two jobs (trade + compound), zero optional stake step.**

---

## 1. Research anchors (SOTA + edge)

### 1.1 Single compounding share (not dual retail tokens)

| Pattern | Lesson |
|---------|--------|
| **ERC-4626** | Users hold **shares**; vault holds **assets**; yield = exchange rate ↑ |
| **sDAI / sUSDS / yield wrappers** | Balance can stay constant while **redeemable claim grows** (or rebase — we prefer **non-rebase rate** for DeFi composability) |
| **stETH shares model** | Internally shares + pooled assets; user UX is liquid claim |
| **NFTX dual v/x** | Dual tokens = optional inventory stake **after** vault share existed — legacy split, not optimal greenfield |

**Verdict:** Greenfield best-in-class is **one user-facing share**, internal asset accounting — not “must stake v→x.”

### 1.2 Inflation / first-depositor attacks

| Pattern | Lesson |
|---------|--------|
| **OZ virtual shares + virtual assets + decimals offset** | Makes donation inflation **unprofitable** |
| **Dead shares** | First depositor cannot sole-control empty vault math |

**Verdict:** Mandatory on every collection share vault and index share.

### 1.3 Trust / upgrade / population risk

| Pattern | Lesson |
|---------|--------|
| **Trail of Bits maturity L4** | True low key-risk = **immutable** after launch; new features = new deploy + voluntary migrate |
| **Uniswap V2** | Immutable core; V3 was a **new** system |
| **Diamond finalize (this repo)** | Atomic cut + remove cutter = **no live upgrade window** |
| **Upgradeable proxies** | Convenience = **population-wide key risk** — avoid for settlement core |

**Verdict:** Settlement path **finalize-at-deploy**. Periphery (solver router, UI, auto-compound LP helper) may upgrade; **cannot brick exit**.

### 1.4 Contagion / isolation

| Pattern | Lesson |
|---------|--------|
| **Plain fee transfer to Bus** | Vault never `call`s index → index bug ≠ mint brick |
| **Pro-rata exit** | No “liquidate liquid legs first” cohort risk |
| **w_max + maturity** | One collection cannot dominate Bus forever via wash |
| **No floor oracle** | No shared feed outage pausing the population |

### 1.5 Compound defaults

| Pattern | Lesson |
|---------|--------|
| **DRIP / auto-reinvest** | Default reinvest beats cash leakage (equities + DeFi) |
| **POL fee harvest** | Renounce principal; compound fees into depth (not stranded) |
| **Buyback scarcity** | Real fees → burn/lock; never emission “APY” |

---

## 2. The Share Atom (canonical model)

```
┌─────────────────────────────────────────────────────────┐
│  COLLECTION SHARE  S  (one ERC-20 per collection)         │
│  User-facing only token. Name in UI: "vault share"        │
│  Internally: ERC-4626-class shares over "inventory units" │
│  inventory unit ≈ 1 NFT of claim (v-unit, not a wallet    │
│  token). Fees increase inventory units behind S.          │
└─────────────────────────────────────────────────────────┘
         ▲ deposit NFT                    │ redeem NFT
         │ mint S                         │ burn S (rate-aware)
         ▼                                ▼
┌──────────────────┐              ┌──────────────────────┐
│ NFT inventory    │              │ AMM: S / WETH        │
│ + fee accounting │              │ liquid market        │
└──────────────────┘              └──────────────────────┘
```

### 2.1 Lifecycle

| Action | User sees | Internal |
|--------|-----------|----------|
| Deposit NFT | **+S** (at current rate; genesis 1 NFT → 1 S unit) | +1 inventory unit, NFT locked |
| Redeem NFT | **−S** (enough shares to cover 1 inventory unit + fees) | −1 inventory unit, NFT out |
| Hold S | Balance **constant** | **Assets/share ↑** as fees compound |
| Trade S | Swap on AMM | Price = pool, not oracle |
| Index mint | Deposit S (+ other S_i + WETH) pro-rata | iToken out |
| Bus I | Buys **S** on AMM into index | Nested compound |

### 2.2 Where “v” went

**vToken as a user balance is deleted.**  
`inventoryUnits` (or internal v) is a **uint accounting field** + NFT enumeration — not transferable.

**Have cake:** redeem math still “one inventory unit ↔ one NFT.”  
**Eat it:** every holder of S compounds; no second token to forget.

### 2.3 1:1 UX honesty

| Time | Truth |
|------|--------|
| t=0 empty / virtual-seeded | 1 S unit ↔ 1 NFT claim |
| After fee compound | 1 S unit ↔ **>1** inventory unit claim (or same S, more assets — same idea) |
| UI | Show **“claim ≈ X NFTs”** via `convertToAssets`, never lie “always 1:1 forever” |

Traders price **S** on AMM (which embeds expected claim + liquidity). Index holds **S** and compounds further via Bus.

---

## 3. Global architecture (lean stack)

```
Immutable / finalized settlement
├── CollectionVault_i  (share S_i, NFT inventory, AMM, fee split, sink→Bus)
├── EnergyBus          (fixed bps, adapters, finalize)
├── WeightModule       (on-chain signals only)
├── Index Diamond      (pro-rata core, energy credit, dividend/DRIP, finalize)
└── IndexCoinPool      (S? no — IDX/WETH; fee→Bus/DRIP)

Periphery (upgradeable OK; cannot hold exit hostage)
├── Intent/solver router (WETH → basket → mint)
├── Optional AutoCompounder for human LP positions
└── Lenses / UI oracles (display only)
```

**Contract count discipline:** no second stake contract if 4626 is inside CollectionVault. Adapters stay tiny.

---

## 4. Automatic compounding (single story)

```
Fee WETH paid
  ├─(1)─→ inventory units behind S  ↑     (everyone who holds S compounds)
  ├─(2)─→ Stream → Bus
  │         ├─ buy S into Index     ↑     (iToken nested claim)
  │         ├─ POL depth harvest    ↑
  │         ├─ burn/lock IDX        ↑ claim/share
  │         ├─ burn PLANK / POL     (ecosystem)
  │         └─ DRIP to reserves     ↑ iToken claim
  └─(3)─→ creator COMPOUND_S default (buys S of own collection)
```

**One user action (use the vault) → all layers can compound.**  
No “remember to stake v→x.”

---

## 5. Game theory: dominant honest strategies

| Actor | Best strategy | Why attack fails |
|-------|---------------|------------------|
| User | Hold S / iToken, use markets | Free-ride on others’ fees as claim growth |
| Washer | Don’t | Linear fee cost; maturity; w_max; impact caps |
| First depositor | Normal deposit | Virtual shares / dead shares |
| Oracle attacker | No target | No settlement feed |
| Admin | None post-finalize | Cutter gone; pipes frozen |
| Thin-pool sniper vs Bus | Limited | MAX_IMPACT; skip→DRIP compound |
| Exit griefer | Cannot brick others | Pro-rata; no shared pause on redeem |

**Dominant equilibrium:** real use generates fees → claim and depth grow → more use. Extraction without payment is not available on settlement paths.

---

## 6. Exploit classes → lean mitigations

| Class | Mitigation (minimal) |
|-------|----------------------|
| 4626 inflation | Virtual shares + assets + dead shares + balance-delta credit |
| Fee-on-transfer | WETH only as paymentToken; delta accounting |
| Reentrancy | CEI + nonReentrant on value paths |
| ERC-777 / callback | Prefer no hooks on share; if any, reentrancy guard |
| Donation to vault | Credit only fee paths / explicit donate with vest |
| Flash mint around Bus | Vest injects V blocks |
| Upgrade rug | Finalize diamond + Bus at deploy |
| Vault↔index coupling | Plain ERC-20 transfer sink only |
| Rounding last man | Floor to vault; virtual offsets |
| Population oracle failure | No oracle on settle |
| Contagion from one collection | Isolated vaults; w_max; pro-rata never dumps one leg onto stayers unfairly |
| PLANK reflexive death | PLANK outside redeemable basket |
| Solver grief | minOut; exit never needs solver |
| Free iToken from fees | Forbidden by construction |

**No** multi-sig “emergency mint.” **No** pause that blocks `redeemProRata`. Optional pause only on **new deposits** if ever needed — never exit.

---

## 7. Population-wide risk map (mitigate or accept)

| Risk | Shared across users? | Mitigation |
|------|----------------------|------------|
| Diamond bug pre-finalize | Yes | Short window; tests; audit; then finalize |
| Diamond bug post-finalize | Yes but fixed code | Immutable simplicity; formal tests; optional migrate product later |
| Single collection rug NFT | No — isolated | Eligibility / social; economic weight decay |
| WETH depeg | Yes (all DeFi) | Accept; canonical WETH only |
| AMM thin liquidity | Local | POL + Bus depth; impact caps |
| Keeper offline | Delayed compound | Permissionless route; funds safe |
| Governance param | Yes if mutable | Freeze critical bps at finalize |

**Mitigable population risk is designed out** (upgrade keys, oracles, exit pause). Residual is **code correctness + asset market risk** — irreducible for any on-chain fund.

---

## 8. Elegance scorecard (lean)

| Metric | Target |
|--------|--------|
| User tokens per collection | **1** (S) |
| User tokens for index | **1** (iToken) |
| Stake ceremony | **0** (auto on deposit) |
| Settlement oracles | **0** |
| Admin after finalize | **0** on pipes/exit |
| Fee → free shares | **0** |
| Basket legs | S_i + WETH (+ optional non-redeemable POL accounting) |

Complexity lives in **math + tests**, not in dual products and dual pools.

---

## 9. Diff vs earlier docs

| Earlier | Now (PERFECT-3) |
|---------|------------------|
| Retail v + optional x | **Only S (x-class); v internal** |
| “Remember to stake” | **Impossible to forget** |
| Bus buys x or v | **Bus buys S only** |
| Dual AMM surfaces | **One AMM: S/WETH** |
| Dual index constituents | **S_i only + WETH** |

Maximal compound EV (DRIP, POL, creator compound) **unchanged** — now applied to **one share atom**.

---

## 10. Implementation sketch (Opus)

```solidity
// CollectionVault: ERC20 share S + ERC721 inventory
// deposit(tokenId): pull NFT, mint S via 4626 preview (inventoryUnits as asset)
// redeem(tokenId or random): burn S, push NFT
// fee: increase inventoryUnits and/or buy S into dead inventory stake accounting
//      + transfer WETH to Bus / treasury per streams

// Index: constituents = address(S_i), WETH
// mintProRata / redeemProRata only (pure mode)
// EnergyBus Pipe I: swap WETH -> S_i by weight, transfer S_i to index, creditInventory
```

**Tests:** inflation attack suite; 1 NFT deposit/redeem; fee raises convertToAssets; index nest; bus buy S; finalize immutability.

---

## 11. Product sentence (best-in-class)

> One share per collection that is always compounding, always liquid against WETH, always redeemable for inventory; a multi-collection index of those shares plus WETH that only grows claim from real fees; an energy bus that cannot mint free shares, cannot use floor oracles, cannot be upgraded after launch, and defaults every fee atom into more claim, depth, or scarcity — so honest use is the dominant strategy.

---

## 12. Verdict

| Goal | Achieved by |
|------|-------------|
| Cake (simple + liquid + exit) | Single S, AMM S/WETH, rate-aware NFT redeem, pro-rata iToken |
| Eat it (max compound) | No bare v; fees→assets; Bus; DRIP; POL; burns |
| +EV game theory | Costly wash; free-ride only by holding through real activity |
| Lean | One share token; finalize; periphery non-custody of exit |
| No exploit classes where known | OZ 4626 defenses; isolation; no oracle settle |
| Population risk mitigable | No upgrade key; no shared oracle; isolated vaults; exit sacred |

**This is the have-cake-and-eat-it shape:** liquid-staked inventory for everyone by construction, without dual-token ceremony, without oracle NAV, without admin after birth.

---

*Normative with ONESHOT PERFECT-3 share-atom section. Audited bytecode remains deployment truth.*
