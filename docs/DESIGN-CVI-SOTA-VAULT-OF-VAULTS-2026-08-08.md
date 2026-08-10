# CVI-SOTA — Compounding Vault Index  
## Vault-of-vaults · Balancer-class weights · demand/supply truth · zero settlement oracle

**Status:** design truth. Supersedes generic “CVI with floor oracles” research sketches for this product.  
**Lineage:** NFTX V1 D2 (Balancer of vTokens) · Scalara NFTI (multi-collection xTokens) · Fungify yield · AXIOM-1 Energy Bus · AXIOM-0 oracle-free exit.  
**Date:** 2026-08-08  
**Hard rule:** No external floor/NAV oracle on mint, redeem, weight settlement, or fee credit. UI may display floors; **contracts do not settle on them.**

> **Retired planning history, superseded in full by
> `docs/AXIOM-1-AS-BUILT.md`.** Read that document instead.

---

## 0. What you asked for (exact product)

> NFTX-style **vault of vaults**: many collections → one index, **Balancer-like** weights driven by **performance in their vaults** (and market truth), with **state-of-the-art** compounding of **value, inventory claims, liquidity**, and **cash dividends** to index holders and LPs — mechanics that are **impossible to gamify** so the system **mirrors real demand/supply**.

**Market gap (research):** That product **existed** (NFTX D2, Scalara-like baskets) and is **not maintained** as a live multi-collection Balancer-of-vaults today. The open design space is yours.

---

## 1. Why the “floor-oracle CVI” sketch is not SOTA for you

A common research design weights by:

- oracle floor × supply  
- multi-oracle TWAP of secondary sales  
- “impossible to gamify” via more oracles  

That **reintroduces the attack surface** you banned: sandwich mint/redeem on NAV, floor manip on thin collections, stale feeds pausing exit, and **false “true value”** that is not paid demand.

**SOTA for this stack** = D2 structure + inventory compounding + cash/LP yield, with **weights and buys driven only by paid, on-chain demand/supply** (fees, mint/redeem pressure, pool depth, time-matured activity). Floor is an **off-chain chart**, not a settlement input.

---

## 2. Three-layer architecture (D2 evolved)

```
L1  BASE VAULT (per collection)          ← NFTX D1 + inventory compound
    NFT → vToken (1:1 claim)
    optional inventory stake → xToken (ERC-4626-style claim growth from fees)
    CPAMM / CL pool: vToken|xToken ↔ WETH
    Streams A/B → Energy Bus (WETH)

L2  META-INDEX (vault of vaults)         ← NFTX D2 + Scalara multi-collection
    Holds basket of xTokens (preferred) or vTokens + WETH
    Index share = pro-rata vault share OR Balancer BPT-class claim
    Weights = performance from vault demand (not floor oracle)
    mint/redeem = full basket / proportional (ETF AP + arb)

L3  YIELD & LIQUIDITY ENGINE             ← Fungify + modern AMM + AXIOM-1 pipes
    Per-vault LPs + IDX/WETH LPs
    Cash dividends (WETH) to iToken holders
    Fee split: inventory compound / LP / index dividend / burns / renounced LP
    Energy Bus: buys xTokens into L2, renounces LP, burns PLANK/IDX, pays D
```

**Index token (iToken / IDX):** claim on **nested claims** — each xToken already compounds **more vToken (NFT claims)**; the meta-layer compounds **more xToken inventory + WETH + renounced depth**.

That is the Scalara insight (hold **xTokens**, not raw floors) + D2 insight (Balancer basket of vault tokens) + your AXIOM-1 flywheel.

---

## 3. Layer L1 — Base vault (compounding inventory of NFT claims)

### 3.1 Mechanics

| Action | Result |
|--------|--------|
| Deposit eligible NFT | Mint 1 vToken |
| Redeem vToken | Random NFT free-tier; target pays **premium → pool/fees** (not oracle cherry-pick free) |
| Stake vToken | Mint xToken (ERC-4626): `assets = vToken balance credited to vault` |
| Vault fees (mint/redeem/swap) | Split: local treasury floor + **Energy Bus** + **inventory compound into xToken rate** |

**Inventory compounding (NFTX xToken class):**  
Fees denominated in vToken or used to buy vToken back into the staking pool → `totalAssets/totalSupply` of xToken rises → **each xToken claims more NFT units over time**. No inflationary reward token.

### 3.2 Demand/supply signals (on-chain only)

Per vault, continuously track:

| Signal | Definition | Meaning |
|--------|------------|---------|
| \(F\) | Cumulative WETH fees paid to bus | Paid activity |
| \(U\) | Utilisation = NFTs in vault / (in + free float proxy if any) or simply inventory count growth | Inventory demand |
| \(P_{mr}\) | Mint count − redeem count over window (net deposit pressure) | Supply absorption |
| \(D\) | AMM depth (WETH reserve × share reserve) | Real liquidity |
| \(V_{amm}\) | AMM volume (fee-derived) | Tradable demand |

**No floor oracle.** “Performance” = **who pays and who locks inventory**.

### 3.3 Anti-game at L1

- Fee ceilings non-waivable  
- Target redeem premium → pool (stayers benefit)  
- Maturity on fee attribution \(m(\Delta t)\)  
- Balance-delta fee accounting  
- Eligibility: collection allowlist or **permissionless factory** with economic admit at L2 (not floor band oracle)

---

## 4. Layer L2 — Meta-index (Balancer-class vault of vaults)

### 4.1 What the pool holds

Preferred constituents:

1. **xToken_i** (compounding claim on collection i)  
2. **WETH** (ballast + dividend fuel)  
3. Optional: **renounced LP positions** outside redeemable NAV (depth externality) or BPT with proportional exit only  

**Not held as redeemable legs:** PLANK (burn/LP renounce outside basket — AXIOM-1).

### 4.2 Index share model (two allowed modes)

| Mode | Share type | Exit | When |
|------|------------|------|------|
| **A — Strict pro-rata vault** | ERC-20 iToken | Always `redeemProRata` of xTokens+WETH | Default pure / max safety |
| **B — Weighted pool (D2)** | BPT / Balancer V3-class | Proportional exit free; single-asset pays **pool imbalance** | Capital efficiency + arb rebalance |

**SOTA recommendation:** implement **A as non-negotiable exit door**; optionally wrap **B** as the liquid market layer that still allows proportional exit to A’s inventory accounting. Never require oracle to leave.

### 4.3 Performance weights (the D2/Scalara soul — without floors)

Target weight for collection \(i\):

\[
s_i = m_i \cdot \big(
  \alpha \hat F_i + \beta \hat P^{net}_i + \gamma \hat D_i + \delta \hat V^{amm}_i
\big)
\]

\[
w_i = \mathrm{cap}\Big(\frac{s_i}{\sum s},\, w_{\max}\Big)
\]

- \(\hat\cdot\) = normalized, time-decayed (EWMA), **only from on-chain counters**  
- \(m_i\) = maturity of fee history  
- \(w_{\max}\) e.g. 25% (Punks-cap style without floor)  
- Admit when \(s_i \ge S_{\min}\) for sustained window  

**What this replaces:**

| Oracle-CVI | CVI-SOTA |
|------------|----------|
| Floor × supply | Matured fee \(F\) + net mint pressure |
| Secondary sale TWAP | AMM volume/fees + depth |
| Multi-oracle confidence | Multi-signal **paid** activity + caps |

**Rebalancing:**

- **Continuous:** arb on Mode B pool restores weights; buyers of underweight xTokens profit  
- **Directed:** Energy Bus Pipe I spends WETH to **buy underweight xTokens** (buy-only; never force-dump stayers’ art)  
- **No committee rebalance** of “sell weak floors”

### 4.4 Creation / redemption (ETF AP — demand/supply mirror)

| Path | Effect |
|------|--------|
| Deposit exact weighted basket of xTokens (+ WETH band) | Mint iToken (pro-rata / pool join) |
| Burn iToken | Receive proportional basket |
| WETH-only UX | Solver/router builds basket on L1 AMMs; core never prices NAV |

High demand for collection A → more fees → higher \(w_A\) → more Bus buys of xToken_A → deeper A markets → **revealed preference loop**.  
Excess supply / redemptions → lower net pressure → weight decays → capital attention leaves.

---

## 5. Layer L3 — Liquidity, LP cash, index dividends, inventory compound

### 5.1 Fee split philosophy (illustrative; align with AXIOM-1 genesis)

From every L1 fee WETH (and L2 pool fees):

| Destination | Role | Beneficiary |
|-------------|------|-------------|
| **xToken compound** | Buy vToken into inventory stake | Inventory stakers (claim↑) |
| **Local LP** | Stay in vault AMM / CL | Collection LPs |
| **Energy Bus → Index inventory** | Buy xTokens into L2 | iToken holders (art↑) |
| **Energy Bus → renounce coll. LP** | Depth | Everyone trading that collection |
| **Energy Bus → IDX burn/lock** | Float↓ | iToken holders |
| **Energy Bus → PLANK burn/LP** | Ecosystem | PLANK (outside basket) |
| **Energy Bus → WETH dividend** | Cash | iToken holders (+ optional long-LP share) |
| **IDX/WETH pool fees** | Cash skim | iToken holders |

**Dual stake (NFTX inventory vs LP) preserved:**

- **Inventory (xToken):** IL-free compounding NFT claims + share of vault fees into rate  
- **LP:** swap fees + majority of local trading economics + optional cash  
- **iToken:** nested claim growth + Bus inventory buys + cash dividends + burn scarcity  

No emissions inflation required.

### 5.2 Cash dividends (real yield)

- EIP-2222 / streaming **WETH** to iToken holders  
- Optional: share of fees to **ve-locked LPs** (time-weighted) without governance capture of basket  
- Index **trading** produces ETH to holders (buy/sell iToken pool) — your airdrop engine  

### 5.3 Compounding inventory of shares (nested)

```
Fee on collection A
  → some vToken bought into xToken pool     ⇒ xToken claims more NFTs
  → some WETH buys xToken_A into L2         ⇒ iToken claims more xToken_A
  → xToken_A itself still compounds           ⇒ iToken’s claim compounds twice
```

That is **strictly stronger** than “WETH claim only” and matches “compounding claims to the NFT collections that make up the portfolio.”

---

## 6. Impossible-to-gamify (honest version)

**Not** “oracles so good you can’t game them.”  
**Yes** “attacks cost more than they return, and exit stays open.”

| Attack | Closure |
|--------|---------|
| Wash fees for weight | Pay full fees; maturity \(m\); \(w_{\max}\); admit threshold; vest Bus injects |
| Floor oracle manip | **No floor in settlement** |
| Flash weight / flash mint iToken around Bus buy | Vest injects; same-block credit not fully mature |
| Thin AMM push then Bus buy | MAX_IMPACT; skip → dividend; epoch caps |
| Cherry-pick NFT from vault | Premium to pool or random default |
| Admin rug LP | Renounce / dead LP |
| Brick exit | Pro-rata always; no oracle pause |
| Free iToken from fees | Forbidden — only buy assets / burn / dividend |
| Single collection capture | \(w_{\max}\) + multi-signal normalize |
| Fake volume without fees | Volume signals derived from **fee-paid** swaps only |
| PLANK reflexive death | PLANK outside redeemable basket |

**Circuit breakers (oracle-free):**  
If net redeem pressure on L1 vault or L2 exceeds bound, **slow Bus buys** for that leg (not pause honest pro-rata redeem). Prefer degrade compound speed over trapping capital.

---

## 7. Demand/supply “true value” loop (no floor required)

```
Demand ↑ for collection
  → vault deposits & swaps ↑ → fees ↑ → depth ↑
  → weight w_i ↑ → Bus buys more xToken_i → index exposure ↑
  → LPs see volume → more LP → better discovery
  → iToken holders get nested claim↑ + dividends

Supply pressure / redemptions ↑
  → net mint pressure ↓ → fees dry → m/decay ↓
  → weight ↓ → Bus stops supporting → attention leaves
  → index de-emphasises weak demand automatically
```

Arbitrageurs mint/redeem the **basket** (not a fake NAV) so iToken market price tracks **deliverable inventory**, the only “true” on-chain value.

---

## 8. Comparison table

| Feature | NFTX D2 | Scalara NFTI | Fungify | Floor-oracle CVI sketch | **CVI-SOTA (this doc)** |
|---------|---------|--------------|---------|-------------------------|-------------------------|
| Vault of vaults | Yes (Balancer vTokens) | Yes (xTokens) | Single vault multi-NFT | Yes | **Yes (xTokens preferred)** |
| Multi-collection | Trait-limited often | Yes | Yes | Yes | **Yes** |
| Live maintained 2026 | No | Stale | Niche | Paper | **Your product** |
| Weight driver | Manual/equal | Floor mcap | Mcap-like | Floor + oracles | **Paid demand/supply on-chain** |
| Inventory compound | Via x later | xToken | Exchange rate | xToken | **xToken + Bus buys into L2** |
| Cash dividend | Weak | Weak | Fee rate | Yes | **Yes (WETH + IDX fees)** |
| LP economics | Separate | Separate | — | Dual stake | **Dual + renounce pipes** |
| Settlement oracle | Pool | Off-chain rebalance | Internal | Heavy | **None** |
| Exit | BPT | Token | Token | NAV risk | **Pro-rata always** |

---

## 9. Mapping to existing Plank/AXIOM-1 work

| CVI-SOTA piece | Existing / planned |
|----------------|-------------------|
| L1 vault | `CollectionVault` (+ evolve xToken/4626 inventory stake) |
| Streams → Bus | Factory sink → EnergyBus |
| L2 basket of vault shares | Index Diamond constituents = xToken/vToken + WETH |
| Performance weights | WeightModule (extend signals beyond F alone) |
| Buy art into index | Pipe I |
| Renounce LP | Pipe L / R |
| Cash to holders | Pipe D + dividend facet |
| IDX burn | Pipe X |
| PLANK | Pipe P/R outside basket |
| Pure pro-rata exit | IndexCore `redeemProRata` |
| Solver WETH-in | Periphery intent |

**Build delta beyond AXIOM-1 SPEC:**

1. **xToken / inventory staking** on CollectionVault (claim compound at L1)  
2. WeightModule multi-signal (\(\hat P, \hat D, \hat V\)) not only \(F\)  
3. Optional Balancer V3 / weighted pool wrapper for Mode B liquid layer  
4. Fee split that **also** compounds L1 xToken rate (not only Bus)

---

## 10. Genesis fee / weight defaults (compatible with AXIOM-1)

Energy Bus (of WETH reaching bus) — keep locked split unless retuned:

`INV 35% · CLP 15% · IDX_BURN 15% · PLANK_BURN 10% · PLANK_LP 10% · DIV 15%`

**Additionally at L1 (before bus),** e.g. of total vault fee:

- 30–40% → xToken inventory compound (buy vToken into stake)  
- rest → treasury + bus (existing Stream A/B floors still bind bus minimums)

Weight alphas (start): \(\alpha=0.45, \beta=0.25, \gamma=0.15, \delta=0.15\), \(w_{\max}=25\%\), maturity K as AXIOM-1.

---

## 11. Product sentence (market)

> **The missing product:** a live multi-collection NFTX D2 — Balancer-class vault-of-vaults — where each leg is a compounding inventory claim (xToken), weights follow real vault demand and paid fees (not floor oracles), liquidity is renounced into the books, and index holders receive nested claim growth plus cash ETH, with fair pro-rata exit always on.

---

## 12. Verdict

| Question | Answer |
|----------|--------|
| Is vault-of-vaults Balancer multi-collection real prior art? | **Yes (D2, Scalara-class); not maintained** |
| Is floor-oracle CVI “most SOTA”? | **No for this protocol** — fights your oracle ban and fails open |
| Is CVI-SOTA achievable on-chain without settlement oracles? | **Yes** |
| Does it compound inventory of NFT claims? | **Yes — L1 xToken + L2 Bus buys** |
| Cash dividends + LP yield + index yield? | **Yes — three constituencies, one energy** |
| Gamify-proof? | **EV-negative wash; no NAV sandwich; exit first** |

**This document is the SOTA target** for “NFTX vault of vaults, many collections, Balancer-weighted by vault performance, compounding claims/liquidity/cash.”

Implementation authority remains:  
`ONESHOT-OPUS-AXIOM-1-BULLISH-DELIVERY.md` + `SPEC-AXIOM-1-ENERGY-BUS-…`  
**extended by §9 build delta** (xToken + multi-signal weights + optional Mode B pool).

---

*Deployment truth = audited bytecode. Floor prices are UI, not law.*
