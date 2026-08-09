# AXIOM-1 — Autogenesis Compounding Machine

**Status:** design truth for maximum vision. Does **not** authorize deploy.  
**Constraint:** fully on-chain settlement; no external price oracle on mint/redeem/weight/buy paths; grief and exploit surface closed by construction, not by monitoring.  
**Date:** 2026-08-08  
**Supersedes for product spirit:** AXIOM-0 “cash-only fee claim” as the *sole* compound path. AXIOM-0 safety rules (pro-rata exit, fee ≠ free mint, balance-delta credit, vest injects) **remain binding**.  
**Integrates:** factory Streams A/B, §7.3 hybrid accrual, §7.5–7.7 weight/vest/buyback, §7.10 index pool, PLANK market, plank.love / Marketplank performance as the **only** energy source.

---

## 0. One-sentence vision

**plank.love marketplace performance automatically mints a living Balancer-class portfolio of collection vault shares + ETH + LP, and every natural trade (NFT, vault share, index, PLANK) permanently compounds inventory, deepens liquidity, burns PLANK, burns or locks index float, and renounces protocol LP — with cashflows so aligned that grief and extraction are strictly dominated strategies.**

---

## 1. Core pillars (non-negotiable)

| # | Pillar | Always-on effect of real activity |
|---|--------|-----------------------------------|
| **P1** | **Inventory compound** | Fee/surplus WETH systematically **buys collection vault shares** (art claims) into the index by performance weight |
| **P2** | **Liquidity compound** | Surplus also **adds LP** on collection share/WETH pools and on IDX/WETH; protocol LP is **renounced / dead-locked** (cannot be withdrawn by admin) |
| **P3** | **PLANK buy + burn** | A fixed bps of energy **market-buys PLANK and burns** (or gauge-burns) — never parks spendable PLANK for team in the trustless path |
| **P4** | **Index LP buy + burn/lock** | Energy **buys IDX from the market and burns or dead-locks** it → float shrink, claim↑ for stayers |
| **P5** | **PLANK LP add + renounce** | Energy **adds PLANK/WETH LP and renounces** (dead LP) → permanent depth, protocol-owned, no rug path |
| **P6** | **Index market → ETH to holders** | Every **buy/sell of IDX** skims WETH into **holder dividends** (airdrop/real yield) |
| **P7** | **Autogenesis** | Index portfolio is **produced by marketplace + vault performance**, not by a curator repeatedly “listing bags” |
| **P8** | **Balancer portfolio exit** | Redeem always yields a **legitimate slice** of vault shares + ETH + valued LP inventory; weights from **inventory + matured performance**, never a floor oracle |
| **P9** | **Impregnable game theory** | Wash, sandwich, donation, free-ride, and admin grief are **EV-negative or impossible** by construction |
| **P10** | **Maximal cashflow alignment** | Creators, traders, LPs, index holders, and PLANK stakers earn from **the same real fee energy** without competing for free mints |

---

## 2. System topology

```
                    plank.love / Marketplank marketplace
                    (NFT list, bid, fill, vault mint/redeem/swap)
                                      │
                                      │ every fee event = WETH-class energy
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L1  COLLECTION VAULTS (×N, factory)                                     │
│     NFT inventory · 1 NFT ↔ 1 cvShare · CPAMM cvShare/WETH              │
│     Stream A ≥8.1% → Energy Bus   Stream B 50% → Energy Bus, 50% pool   │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ plain WETH transfer (no call into core)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L0  ENERGY BUS (immutable splitter · pure accounting)                     │
│     Input: observed ΔWETH only                                            │
│     Output: fixed bps pipes (timelocked constants after finalize)         │
└───┬──────┬──────┬──────┬──────┬──────┬──────────────────────────────────┘
    │      │      │      │      │      │
    ▼      ▼      ▼      ▼      ▼      ▼
   [I]    [L]    [P]    [X]    [R]    [D]
 Inventory Liq   PLANK  IDX    PLANK  Dividend
  buy     LP     burn   burn   LP     / cash
  cvShare add    buy    lock   add+
         renounce            renounce
    │      │                      │
    └──────┴──────────┬───────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L2  GLOBAL INDEX — Balancer-class portfolio vault                         │
│     Assets: { cvShare_i…, WETH, LP_collection_i…, LP_IDX (accounting) }   │
│     Weights: w_i = f(inventory, matured fee receipts, soft caps)          │
│     Settlement: proportional join/exit always; single-asset only via pool │
│                 invariant (attacker pays pool) — optional periphery        │
│     IDX supply: mint only against full recipe; never free from fees       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                    IDX/WETH market (P6 fees → D)
                                │
                                ▼
                         IDX holders (claim↑ + ETH yield)
                                │
                    PLANK market + renounced PLANK LP (P3, P5)
```

**Autogenesis rule:** no human “adds a collection to the soul of the fund” beyond permissionless vault deploy + **performance weight crossing a maturity threshold**. The marketplace *is* the portfolio constructor.

---

## 3. Energy Bus — the single cashflow brain

### 3.1 Only one input type

```
energy = Σ observed WETH (paymentToken) received from:
  - Stream A (mint/redeem fees on collection vaults)
  - Stream B sink half (swap fees on collection vaults)
  - IDX/WETH pool protocol fee skim (P6)
  - optional marketplace protocol fee if plank.love routes the same token
```

Credit rule (impregnable):  
`credit = balanceAfter − balanceBefore` (or reserved accounting).  
**Never** trust `msg.value` alone, never trust self-reported surplus, never trust an oracle-converted “USD fee.”

### 3.2 Fixed pipes (example genesis split — governance sets numbers once in band)

| Pipe | Code | Example bps of energy | Action (atomic keeper or same-tx micro-batch) |
|------|------|----------------------|-----------------------------------------------|
| **I** Inventory | `INV_BPS` | 3500 | Buy `cvShare_i` on L1 AMMs by weight \(w_i\); transfer into L2 reserves |
| **L** Collection LP | `CLP_BPS` | 1500 | Add liquidity cvShare_i/WETH; **mint LP to DEAD / renounce role** or index-held renounced custody |
| **X** Index burn | `IDX_BURN_BPS` | 1500 | Buy IDX on IDX/WETH; **burn or dead-lock** |
| **P** PLANK burn | `PLANK_BURN_BPS` | 1000 | Buy PLANK; **burn** (or burn-for-gauge with no admin withdraw) |
| **R** PLANK LP | `PLANK_LP_BPS` | 1000 | Add PLANK/WETH LP; **renounce** (dead LP) |
| **D** Holder cash | `DIV_BPS` | 1500 | EIP-2222 / streaming WETH to IDX holders |
| **Σ** | | **10000** | Must sum exactly; remainder dust → D |

**Hard rules:**

1. **No pipe mints free IDX or free cvShare.** Only market buys and LP mint against real pairs.  
2. **No pipe sends to EOA treasury** in the trustless machine. (Dev/socialfi, if any, are a *separate, disclosed* capped bus with different legal language — not part of P1–P9 impregnability claims.)  
3. **All market buys** use AMM routers with `amountOutMin` set by **on-chain bound**: e.g. max impact bps vs spot, or TWAP-free “fill or skip this epoch.” Prefer **Dutch/keeper batch** that reverts a slice rather than fill toxic.  
4. **Vest:** assets and WETH credited to L2 claim math vest over `V` blocks (existing §7.6) so flash mint around energy is dead.

### 3.3 Automation model (no privileged “fund manager” brain)

| Actor | Power |
|-------|--------|
| **Anyone** | `harvest(vault)` / `routeEnergy()` / `rebalanceTick(i)` — permissionless keepers |
| **Energy Bus** | Only splits + calls allowlisted adapters (cvShare router, LP manager, burn sinks) |
| **Adapters** | Immutable after finalize; each can only spend WETH to one action class |
| **Admin after finalize** | **None** on pipes, sinks, burn addresses, LP renounce |

If a keeper is offline, energy **accrues** (WETH sits, still owned by bus/index). Next keeper call compounds. No grief by non-cooperation: delayed compound ≠ stolen funds.

---

## 4. Performance weights — Balancer soul without oracle

### 4.1 Signal (only real WETH)

For each collection vault \(v\):

\[
F_v = \text{cumulative WETH received by Energy Bus from vault } v
\]

\[
m_v(t) = \frac{\Delta t_v}{\Delta t_v + K} \quad \text{(maturity; wash burst ≈ 0)}
\]

\[
s_v = m_v \cdot F_v \cdot \mathbf{1}_{\{F_v \ge F_{\min}\}}
\]

\[
w_v = \frac{s_v}{\sum_u s_u} \quad \text{capped: } w_v \le w_{\max} \text{ (e.g. 25\%), residual renormalized}
\]

- **No floor price, no USD volume, no NFT rarity oracle.**  
- Performance = **who paid real fees for how long.**  
- Cap \(w_{\max}\) stops one wash-funded collection from eating the whole buy pipe.

### 4.2 How weights are used

| Use | Rule |
|-----|------|
| **Pipe I buys** | Spend \(w_v \cdot \text{INV budget}\) on `cvShare_v` |
| **Pipe L LP adds** | Same \(w_v\) for which collection LP to deepen |
| **Balancer target weights** | Soft-target \(w_v\) on cvShare legs; WETH/LP legs have fixed target bands |
| **Admission** | Vault appears in portfolio when \(s_v \ge S_{\text{admit}}\) (permissionless `checkAdmit`) |
| **Decay** | If no fees for \(T\) blocks, \(m_v\) or \(s_v\) decays — capital buy pressure leaves zombies |

### 4.3 Inventory vs target (arbitrage is the rebalancer)

The fund does **not** need a trusted rebalance bot that “sells NAV.”

- **Balancer-style weighted pool** (or internal virtual weights + CPAMM legs) makes **external arbitrageurs** restore weight by trading.  
- Pipe I/L only **nudge** toward performance (always buying, never forced dump of art for “rebalance” in the trustless core).  
- **Never** sell cvShare for WETH in core to “hit target” unless via **user-driven** single-asset exit (pool math). Avoids hostile liquidation of stayers.

---

## 5. Portfolio composition — “legitimate zero-grief Balancer”

### 5.1 Assets in L2

| Asset | Meaning |
|-------|---------|
| `cvShare_i` | Claim on collection NFT inventory (1:1 unit economics on L1) |
| `WETH` | Cash buffer, dividend fuel, buy fuel |
| `LP_i` (optional index-held) | Renounced or accounting-only claim on collection share/WETH pool |
| Accounting: dead IDX, dead PLANK LP | Not redeemable; raises economic value of live float |

**LP valuation for exit (hard problem, solved carefully):**

- Prefer **index holds underlying cvShare + WETH**, and “LP compound” is implemented as **renounced external LP** (not inside redeemable NAV), **or**  
- Hold **ERC-4626 / Balancer BPT** and redeem path uses **proportional exit of BPT** only (user gets underlyings via standard Balancer exit — no custom mark).  

**Forbidden:** custom “LP worth X ETH” from an oracle for settlement.

### 5.2 Mint / redeem (exit door first)

| Path | Rule |
|------|------|
| **mintProRata** | Deposit \(s/S\) of every redeemable reserve (ceil). Only way to grow IDX supply. |
| **redeemProRata** | Burn \(s\); receive floor \(s/S\) of every redeemable reserve. **Always on. No hook. No role.** |
| **Single-asset** | Only as **Balancer invariant join/exit** (endogenous price; attacker pays pool) or **solver periphery** assembling pro-rata. Never oracle NAV. |

**Non-decreasing claim invariant** (per redeemable leg where defined, and overall):  
fee paths and burns must not reduce live holders’ pro-rata claim except pure pro-rata mint/redeem equality cases.

### 5.3 Why this is “Balancer portfolio of vault NFT collection shares + ETH + LP”

- Multi-asset weighted exposure to **all performing collections**.  
- ETH leg for ballast and yield.  
- LP legs (or renounced LP) for **liquidity as an asset class**.  
- Weights track **performance of plank.love / vault flow**, not a committee’s narrative.

---

## 6. The five permanent compound loops (game-theory closed)

### Loop A — Marketplace → Art inventory

```
NFT trade / vault use → WETH fee → Bus → Pipe I → buy cvShare_i → L2 inventory↑
→ redeemable art claim per IDX ↑ (after vest)
```

**Attack:** wash mint/redeem to force buys of own worthless cvShare.  
**Defense:** (1) real fee cost linear; (2) maturity \(m\); (3) \(w_{\max}\); (4) \(F_{\min}\) admit; (5) buys on AMM with impact caps — thin fake markets eat the washer’s own fee budget.  
**EV:** negative vs not attacking.

### Loop B — Marketplace → Collection liquidity

```
Fees → Pipe L → add cvShare/WETH LP → renounce
→ deeper books → better vault UX → more volume → more fees
```

**Attack:** grief by not providing matching cvShare for LP add.  
**Defense:** Pipe L first buys balanced sides via AMM or skips epoch; leftover WETH rolls to D or next epoch. No reentrancy into user positions.

### Loop C — Activity → IDX scarcity

```
Fees → Pipe X → buy IDX → burn/dead-lock
→ float↓ → claim per live share↑ + market support
```

**Attack:** fee-on-transfer / donation to inflate.  
**Defense:** balance-delta only; burn address immutable; vest on claim bump.

### Loop D — Activity → PLANK scarcity + depth

```
Fees → Pipe P → buy PLANK → burn
Fees → Pipe R → PLANK/WETH LP → renounce
→ PLANK more scarce + permanently deeper market
```

Aligns index success with **PLANK holders** without putting PLANK **inside** the redeemable NFT basket (avoids reflexive OHM-style POL death spiral: **PLANK is not a redeemable index leg**).

### Loop E — Index trading → ETH airdrop

```
User buys/sells IDX on IDX/WETH → swap fee WETH → Pipe D (or direct dividend)
→ holders receive ETH without selling
```

**Attack:** wash IDX trade to farm dividend.  
**Defense:** fees paid are real; dividend is pro-rata to IDX; washer’s round-trip cost ≥ fee; no mint of IDX from fee. Same linear-cost structure as Garden-style wash analysis.

### Meta-loop — Autogenesis

```
More collections on plank.love → more vaults → more heterogeneous fees
→ weights spread → portfolio diversifies automatically
→ index more attractive → more IDX volume → Loop E + pipes fire harder
```

No curator required for “which art is in the fund” beyond **performance**.

---

## 7. Alignment matrix (who gets paid from what)

| Actor | Pays | Receives | Why aligned |
|-------|------|----------|-------------|
| NFT trader / depositor | Fees, spread | Liquidity, vault shares, NFTs | UX for real use |
| Collection creator | — | Stream A treasury share (timelocked) | Earns only from real mint/redeem |
| Collection LP | IL + capital | Local swap fees (Stream B half) + deeper books from Pipe L | Local + global deepen together |
| Index holder | Basket capital | Art inventory↑, WETH, dividends, burn-driven claim↑ | Every loop ends here |
| IDX market maker | Inventory | Spread; fees partly return as D if they hold IDX | Holding + MM compatible |
| PLANK holder | — | Burns + renounced PLANK LP depth | Index success → PLANK structural bid |
| Washer / griefer | Full fees + impact | Transient weight, no free mint | Dominated strategy |
| Admin post-finalize | — | — | No pipe control |

**Maximal alignment principle:**  
One energy atom of WETH from a real marketplace decision is **split into public goods** (inventory, liquidity, burns, LP renounce, dividends) that **cannot be redirected to private extraction** in the trustless machine.

---

## 8. Exploit / grief catalogue → closure

| Attack | Closure |
|--------|---------|
| Oracle NAV sandwich | No oracle on settlement; pro-rata / pool invariant only |
| Free IDX from fees | Forbidden; pipes only buy/burn/LP |
| First depositor inflation | Virtual shares + dead shares |
| Donation / fee-on-transfer inflate | Credit observed Δbalance only |
| Flash mint around harvest | Vest all injects `V` blocks |
| Wash volume weight | Maturity + fee cost + \(w_{\max}\) + \(F_{\min}\) |
| Thin pool buy manipulation | Max impact bps; epoch skip; vest |
| Admin rug LP | Renounce / dead lock at add; no withdraw role |
| Admin change sink | Immutable upstream after vault deploy; bus pipes finalize |
| Brick vault via index revert | Plain ERC-20 transfer only from vault |
| Hostile rebalance dumps art | Core never force-sells cvShare for weight; arb + buy-only pipes |
| Index exit adverse selection | Pro-rata all legs including illiquid |
| PLANK inside basket reflexive death | PLANK burn/LP only **outside** redeemable basket |
| Keeper censorship | Permissionless harvest; energy queues |
| Solver grief on WETH-in mint | minOut; core mint independent; exit never needs solver |
| Rounding last-redeemer dust | Floor to vault; virtual offsets |
| Governance parameter rug | Timelock + finalize freeze of critical bps; dual council if needed |
| Cross-collection $ fake performance | Weights in WETH fees only |

**“Zero grief” (honest meaning):**  
No strategy that **steals** from honest holders or **bricks exit**.  
Delay and opportunity cost from offline keepers can exist; **value is not confiscated**.

---

## 9. Natural flow — “economic decisions only”

Nothing in the machine requires a committee to “decide to compound today.”

| Human decision (game) | Automatic machine response |
|----------------------|----------------------------|
| List/sell/buy NFT on plank.love / use vault | Fees → Energy Bus → all pipes |
| Provide or trade collection liquidity | Stream B → bus + local depth |
| Mint IDX with basket | Supply↑ only with assets in; recipe enforced |
| Redeem IDX | Pro-rata art+ETH out; no permission |
| Trade IDX | Fee → ETH dividend to holders |
| Trade PLANK | Burns/LP renounce from bus still structural bid |
| Deploy new collection vault | Eligible for weight once fees mature |
| Do nothing (hold IDX) | Inventory/LP/burns still raise claim over time |

The index fund is **emitted by revealed preference in the marketplace**, not by narrative emissions.

---

## 10. Relation to prior docs

| Prior | Keep | Change |
|-------|------|--------|
| AXIOM-0 nested claims | L0–L3, no oracle settlement, pro-rata exit | Fee energy **must** run pipes I/L/X/P/R/D, not only WETH claim↑ |
| §7.2 Streams A/B | Push + reconcile | Feed Energy Bus |
| §7.3 three-stream hybrid | Dividend + claim | Claim growth increasingly from **inventory+burns**, not cash alone |
| §7.5 continuous weight | Maturity fee weights | Drive **buys and Balancer targets**, not only reward share |
| §7.7 buyback-lock | IDX burn/lock | Elevate to mandatory Pipe X |
| §7.10 index pool | IDX/WETH market | Fee skim → Pipe D; POL may be renounced LP |
| §7.11 dev PLANK buy | — | **Out of trustless machine** or re-spec as Pipe P **burn only** if team accepts no treasury PLANK |
| §7.12 socialfi treasury | — | Separate disclosed bus; never described as impregnable |

---

## 11. Implementation shape (when authorized)

1. **EnergyBus.sol** — immutable bps, allowlisted adapters, `route(amount)` permissionless.  
2. **Adapters:** `InventoryBuyAdapter`, `CollectionLpRenounceAdapter`, `IdxBurnAdapter`, `PlankBurnAdapter`, `PlankLpRenounceAdapter`, `DividendAdapter`.  
3. **WeightModule** — \(F_v, m_v, w_v\), admit, cap, decay.  
4. **L2 portfolio** — multi-asset reserves + pro-rata; optional Balancer pool wrapper.  
5. **IDX/WETH pool** — fee → D.  
6. **Invariant test suite** — every attack row in §8 as a foundry/hardhat adversary.  
7. **Finalize** — diamond cut + bus immutability + renounce patterns in one deploy ceremony.

---

## 12. Product sentence (external)

> Use plank.love and collection vaults as you already would.  
> Every real fee automatically buys art into the index, deepens liquidity, burns PLANK, burns index float, renounces LP, and pays ETH to index holders.  
> The index is a Balancer-style basket of vault shares and ETH you can always exit fairly.  
> No oracle. No free mint. No admin hand on the flywheel.

---

## 13. Verdict

This is the **most advanced automated concept** of your pillars:

- **Always compounds** inventory (I), liquidity (L), PLANK scarcity (P), index scarcity (X), PLANK depth (R), holder cash (D).  
- **Produced by** marketplace performance (weights + energy).  
- **Legitimate Balancer portfolio** of collection shares + ETH (+ LP discipline).  
- **Maximally aligned** cashflows with **game-theory-hard** closures.  
- **Impregnable** in the only honest sense: extraction and brick paths are closed; compound is permissionless and automatic.

**AXIOM-0** was the safety skeleton.  
**AXIOM-1** is the living organism that skeleton was waiting for.

---

*Source of truth for deployment remains audited bytecode, not this document.*
