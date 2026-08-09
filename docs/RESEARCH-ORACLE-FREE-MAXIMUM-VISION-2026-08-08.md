# RESEARCH — Oracle-Free Maximum Vision (Fully On-Chain)

**Status:** research brief only. Does not authorize deploy.  
**Constraint (hard):** no external price oracle on any settlement path; everything that moves value is computable from on-chain balances, invariants, and user-supplied assets.  
**Date:** 2026-08-08  

---

## 0. Maximum vision (target state)

Restated as **requirements**, not as “the Diamond we already sketched”:

| # | Capability | Must be true |
|---|------------|--------------|
| V1 | **Collection liquidity** | Anyone can launch a vault for a collection; deposit NFT → fungible share; redeem share → NFT (or random/target with *internal* rules only). |
| V2 | **Tradeable shares** | Shares trade vs a cash token (WETH) with an on-chain market. |
| V3 | **Mandatory upward fee energy** | Real fees from collection activity permanently fund a higher-level product (global index / AUM claim). |
| V4 | **Global index share** | One ERC-20 claims a multi-asset (or multi-vault-share) basket. |
| V5 | **Compounding** | Fee energy raises redeemable claim of existing holders (PPS / exchange rate). |
| V6 | **Cash utilities** | Optional pull cash (dividends) and/or buyback-lock from fee earmarks. |
| V7 | **Free fair exit** | Always redeem pro-rata in-kind without admin, hook, or price feed. |
| V8 | **Sybil-hard admission / weight** | Influence or inclusion cannot be farmed cheaply by wash. |
| V9 | **No oracle attack surface** | No path where “move a pool price / feed” changes mint/redeem settlement amounts. |
| V10 | **No protocol dilution/drain** | No free-share mint from fees; no upgrade rug; exit not brickable by roles. |

This document asks: **what SOTA designs achieve all of the above without oracles?**  
Answer: **yes, all are possible** if “single-asset convenience priced in ETH” is replaced by **internal AMM geometry + pro-rata baskets + fixed inventory rules**.

---

## 1. What “no oracle” mathematically allows

### 1.1 Settlement that never needs a price

Any function of the form:

\[
\text{sharesOut} = f(\text{balances on this contract},\; \text{assets transferred in this tx},\; \text{supply})
\]

is oracle-free. Classics:

| Primitive | What it prices with | Oracle? |
|-----------|---------------------|---------|
| Uniswap v2 / constant product | Own reserves \(x\cdot y=k\) | **No external oracle** (price *is* the pool) |
| Balancer weighted invariant | Own balances + fixed weights | **No** for joins/exits/swaps that preserve invariant |
| Pro-rata basket mint/redeem | Reserves / supply only | **No** |
| NFTX-style vault: 1 NFT ↔ 1 share | Discrete inventory count | **No** |
| Sudoswap-style bonding curve | Curve params + inventory + eth reserve | **No external feed** (curve is the market) |
| ERC-4626 single-asset vault | `totalAssets` / `totalSupply` of **one** asset | **No** (if `totalAssets` = balance, not strategy mark-to-market via oracle) |
| ERC-7621 basket (proportional path) | Multi-asset reserves, proportional claim | **No** for pure proportional deposit/withdraw |

### 1.2 Settlement that *always* needs a price (and is forbidden)

| Operation | Why it needs a price |
|-----------|----------------------|
| Mint index shares by depositing **only WETH** into a multi-asset basket | Must convert WETH → “basket NAV” |
| Redeem index for **only WETH** while holding many tokens | Must sell basket or mark NAV |
| Single-asset join/exit of a multi-asset index **as if** balanced | Implicit swap at a valuation |
| Weight vaults into index by “$ fee volume” across different tokens without a numeraire | Needs cross-asset prices |
| Liquidation LTV, options strike, etc. | External valuation |

**SOTA resolution:** never do those on the core contracts. Do them only as:

- **User-assembled baskets** (user brings every asset), or  
- **Internal AMM legs** (user trades until the pool invariant says the amount is fair), or  
- **Off-chain intent / RFQ** that still settles as atomic multi-asset transfers (solver brings the basket; protocol never marks a price).

---

## 2. SOTA building blocks (industry + standards)

### 2.1 NFT → fungible (V1) — proven, oracle-free

**NFTX pattern (live industry standard):**

- Deposit NFT → mint **vToken** (1 unit per NFT, or fixed share).  
- Redeem vToken → NFT (random or target with premium).  
- Premium for cherry-picking is a **protocol fee schedule**, not an oracle.  
- vToken/WETH trades on an **internal AMM** (NFTX v3 uses Uni-v3-like pools).  

**Sudoswap / bonding-curve AMMs:**

- Inventory of NFTs + ETH reserve + curve parameters define buy/sell quotes.  
- Price is 100% on-chain from state; no Chainlink.  
- Tradeoff: LPs take inventory risk (same as any AMM).

**Maximum-vision mapping:** Collection vaults = this layer. Keep **fixed inventory accounting** (1 NFT ↔ 1 share) for settlement purity; use **internal AMM** for cash↔share, not for “valuing” the index.

### 2.2 Multi-asset index without oracle (V4, V7) — proven

**Pro-rata basket (Set-like / Index Coop spirit / ERC-7621 proportional path):**

- Mint: deposit \(s/S\) of **every** reserve (ceil).  
- Redeem: receive \(s/S\) of every reserve (floor).  
- No NAV in ETH required.  

**Balancer Weighted Pools:**

- Proportional join/exit is oracle-free.  
- Single-asset join/exit uses **pool math** (invariant), not an external feed — still “a price,” but it is **endogenous** (attacking it costs trading against the pool’s own depth).  
- For **zero oracle risk** including endogenous thin-pool manip on the *index*, prefer **proportional-only** on the index; put single-asset convenience only on deep **collection** AMMs.

**ERC-7621 (Basket Token):**

- Explicit standard for multi-asset baskets with proportional claims.  
- Spec deliberately **excludes** oracle design — rebalancing via owner/manager is separate; pure proportional mode is oracle-free.

**ACP / community index pattern (Robinhood Chain narrative):**

- Mint only with full basket; redeem only proportional underlyings.  
- Same invariant as your “exit door first” rule.

### 2.3 Compounding without oracle (V5) — proven

**ERC-4626 exchange-rate model (single asset):**

- Yield / donations increase `totalAssets`; shares fixed → PPS up.  
- Organic growth is **balance increase**, not a price feed.

**Generalize to multi-asset index:**

- “PPS” is not one number on-chain.  
- **Per-asset claim** \(reserve_i / supply\) rises when fee tokens hit reserve \(i\).  
- Off-chain UI can sum in dollars; **settlement never does**.

**Fee compounding in AMMs (Uniswap / NFTX fee distributors):**

- Fees stay in pool or route to a second vault — all balance accounting.

### 2.4 Cash utilities without oracle (V6) — proven

**EIP-2222 magnified dividends:**

- Accrue a cash token already held by the contract; claim is pull.  
- No price.

**Buyback-and-lock:**

- Spend earmarked WETH into an **internal** IDX/WETH pool (constant product) with **minOut** set by the caller (slippage), not by an oracle.  
- Or: burn shares against a **fixed auction** / Dutch auction in pure WETH (still no external feed).

### 2.5 Mandatory fee routing (V3) — proven

**Factory + immutable sink (your CollectionVault design is already SOTA here):**

- Fee pull in paymentToken.  
- Immutable `upstreamSink`.  
- Plain transfer (no call into index).  
- Index `sync`/`reconcile` only credits **observed balance deltas**.

This matches “never trust self-reported surplus” (same discipline as many vault inflate defenses).

### 2.6 Sybil resistance without identity (V8) — research-grade, doable

Industry / research patterns:

| Pattern | On-chain signal | Oracle? |
|---------|-----------------|---------|
| **Fee-paid activity only** | Only txs that paid real fees count | No |
| **Maturity curves** \(m(\Delta t)=\Delta t/(\Delta t+K)\) | Time since first fee / continuous fees | No |
| **Burn-for-weight (ve / gauges)** | Burn PLANK or lock share for influence | No |
| **Bond / stake to create vault** | Create2 + minimum WETH bond, slashable | No |
| **Quadratic / cost-of-Sybil** | Registration cost in scarce token | No |

**Do not use:** USD volume, floor price, or cross-collection “$ fees” without a numeraire oracle.

**Maximum-vision sybil rule:**  
Weight \(w_v = m(\text{time}) \cdot \sum \text{paymentToken fees paid to sink from vault } v\).  
Single numeraire = **WETH already forced as fee token**. No second oracle.

---

## 3. Canonical architecture that hits the full vision (oracle-free)

Not “the Diamond we have,” but the **minimal SOTA shape** that satisfies V1–V10:

```
┌─────────────────────────────────────────────────────────────────┐
│ L0  CASH NUMERAIRE                                              │
│     WETH (or chain-native wrapped ETH) as the only fee currency │
└─────────────────────────────────────────────────────────────────┘
         ▲ fee pull                    │ earmarks / dividends
         │                             ▼
┌────────┴────────┐            ┌──────────────────┐
│ L1 COLLECTION   │            │ L3 CASH UTILITIES│
│ VAULTS (×N)     │            │ dividend pull    │
│ NFT inventory   │            │ buyback via pool │
│ 1 NFT ↔ 1 share │            │ (minOut by user) │
│ CPAMM share/WETH│            └────────▲─────────┘
│ Streams A/B     │                     │
└────────┬────────┘                     │
         │ plain WETH transfer          │
         ▼                              │
┌───────────────────────────────────────┴─────────────────────────┐
│ L2  GLOBAL INDEX (finished diamond or monolith)                 │
│     Constituents = { WETH, vaultShare_A, vaultShare_B, ... }    │
│     ONLY: mintProRata / redeemProRata / reconcile / claims      │
│     NO: single-asset priced mint, external IPriceSource settle  │
│     PPS (off-chain UI) = f(balances); settlement = pro-rata     │
└─────────────────────────────────────────────────────────────────┘
```

### Why this is “maximum vision”

| Vision | How it is achieved |
|--------|--------------------|
| V1 Collection liquidity | L1 vaults (NFTX-class) |
| V2 Tradeable shares | L1 CPAMM share/WETH (Uniswap-class, endogenous price) |
| V3 Mandatory fees | Immutable sink + Streams A/B |
| V4 Global index | L2 multi-asset pro-rata basket of **WETH + vault shares** |
| V5 Compounding | WETH fees → WETH reserve (and optional buyback) without share mint |
| V6 Cash utilities | Dividends + buyback from WETH earmarks |
| V7 Free exit | Pro-rata only on L2 |
| V8 Sybil | Weight = matured WETH fees from each vault |
| V9 No oracle | No settlement function reads a feed or NAV in ETH |
| V10 No dilute/drain | Virtual shares/seed; vest injects; finalize diamond; no free-share mint |

### Critical design pivot vs earlier thinking

**Old trap:** Index holds many **heterogeneous ERC-20s** and tries to mint with **one asset** → needs oracle.  

**SOTA escape:** Index holds **homogenous claims**:

1. **WETH** (fee surplus, cash utilities), and  
2. **Collection vault shares** (each share is already the oracle-free claim on that collection’s NFT inventory + pool).

Then:

- Global index exposure to “many NFT collections” = hold a **basket of vault shares + WETH**.  
- Minting index = deposit pro-rata of those ERC-20s (vault shares + WETH).  
- No need to price Bored Apes vs Planks in ETH on-chain.

**Single-collection convenience** lives entirely at L1 (swap share↔WETH on the collection AMM).  
**Multi-collection exposure** is L2 pro-rata of vault shares.

That is how you get the full product without an oracle.

---

## 4. Advanced oracle-free patterns (beyond current code)

### 4.1 Endogenous rebalancing without “NAV”

If the index must stay near target weights **without oracles**:

- Use a **Balancer-style weighted pool as the index itself** (BPT = index share).  
- Rebalance = arbitrageurs trade the pool; LPs (index holders) earn fees.  
- Single-asset join is allowed **only** as pool invariant math (attacker pays the pool).  
- For **strict** zero manip risk on index: disable single-asset join; only proportional.

### 4.2 Intent / batch settlement (still oracle-free)

User wants “pay only WETH, get index exposure”:

1. Off-chain solver computes basket of vault shares + WETH.  
2. User signs intent; solver executes **one atomic tx**: buys vault shares on L1 AMMs, deposits pro-rata into L2.  
3. Protocol never marks a price — only checks balances received ≥ required pro-rata recipe.

This is how professional ETF creation works (AP model) without the fund trusting an oracle for mint.

### 4.3 Discrete bonding curves for NFT rarity (optional L1)

Target redeem premiums as **fixed bps tables** or curves over inventory depth (Sudoswap-class), not floor oracles.

### 4.4 Continuous weight without USD

\[
w_v(t) = \mathrm{mature}(t - t_0) \cdot F_v^{\mathrm{WETH}}
\]

where \(F_v^{\mathrm{WETH}}\) is cumulative WETH received by the index from vault \(v\)’s sink.  
Optional: decay \(w\) if no fees for \(T\) blocks (still no oracle).

### 4.5 Anti-dilution suite (SOTA checklist)

From OZ ERC-4626 / vault literature, all oracle-free:

| Defense | Purpose |
|---------|---------|
| Virtual shares + dead shares | First depositor inflation |
| Credit only `balanceAfter - balanceBefore` | Fee-on-transfer / donation games |
| Vest injects over \(N\) blocks | Flash mint around fee credit |
| Non-decreasing per-asset claim invariant | No silent reserve theft |
| CEI + non-reentrant | Classic drain |
| Finalize diamond / no upgrade | Admin drain |
| Exit facet imports no roles/hooks | Political brick |

---

## 5. What to abandon forever (if V9 is absolute)

| Feature | Replacement |
|---------|-------------|
| `mintSingleAsset` / `redeemSingleAsset` priced in ETH | L1 AMM + pro-rata L2; or solver intents |
| `IIndexPriceSource` for settlement | Delete from production cut |
| Checkpoint TWAP for mint size | UI-only charts |
| Cross-asset $ volume for weight | WETH fee receipts only |
| Claiming “index NAV in ETH” on-chain for settlement | Per-asset pro-rata claims only |

---

## 6. Feasibility verdict

| Vision item | Possible without oracle? | SOTA reference |
|-------------|--------------------------|----------------|
| V1 Collection vaults | **Yes** | NFTX, Sudoswap |
| V2 Share markets | **Yes** | Uni v2/v3, NFTX AMM |
| V3 Mandatory fee routing | **Yes** | Immutable sink factories |
| V4 Global multi-collection index | **Yes** | Basket of vault shares + WETH; ERC-7621 proportional; Balancer proportional |
| V5 Compounding | **Yes** | ERC-4626-style reserve growth; fee-to-reserve |
| V6 Cash utilities | **Yes** | EIP-2222; buyback vs internal pool |
| V7 Free fair exit | **Yes** | Strict pro-rata (Set/ACP spirit) |
| V8 Sybil-hard weight | **Yes** | Fee maturity + burn/bond |
| V9 Zero oracle settlement | **Yes** | Delete priced paths; endogenous AMM only where attacker pays pool |
| V10 No dilute/drain (protocol) | **Yes** | Virtual shares, vest, finalize, no free mint |

**The full maximum vision is achievable on-chain without oracles** if the index is redefined as a **pro-rata claim on (WETH + collection vault shares)** rather than a **priced claim on heterogeneous raw tokens**.

That is not a downgrade of vision — it is the standard way ETFs and NFTX-composed indices compose liquidity layers.

---

## 7. Suggested product narrative (accurate)

> Plank collection vaults turn NFTs into shares and cash markets **using only their own inventory and WETH reserves**.  
> A mandatory slice of every fee is WETH pushed into the Global Index.  
> The Index is a basket of those vault shares plus WETH — mint and redeem only as a full slice.  
> As fees accumulate, the basket’s WETH (and buybacks) raise every holder’s claim.  
> No price feed is trusted. The only “prices” are AMMs you can trade against, and pro-rata math you can verify from balances.

---

## 8. Next engineering steps (when authorized)

1. Spec L2 constituents as `{WETH, cvShare_i…}` only.  
2. Production facet cut: Core + Bootstrap + Dividend + Buyback + Lens + finalize — **no Trade priced settlement**.  
3. L1 CollectionVault remains fee + inventory + CPAMM.  
4. Optional intent router (periphery, not custody) for “WETH-in → index-out.”  
5. Weight module: pure WETH fee maturity.  
6. Invariant test suite: no non-view function may call `_priceBand` / external price.  

---

## 9. References (research anchors)

- NFTX vault + AMM architecture (inventory share + endogenous market) — V3: UniV3-style AMM, inventory staking (xNFT), vault fees in ETH; 80/20 vault-fee split inventory vs LPs (production docs)  
- Balancer weighted math; proportional join/exit (endogenous, no external oracle)  
- ERC-4626 exchange-rate compounding; inflation defenses (OpenZeppelin)  
- ERC-7621 basket token (proportional multi-asset claims; Alvara-class onchain baskets live 2026)  
- ERC-7575 multi-asset ERC-4626 (share token + per-asset entry “pipes” — periphery convenience, not core NAV oracle)  
- EIP-2222 funds distribution tokens  
- Uniswap constant product / v3–v4 (price = reserves / concentrated liquidity)  
- Bonding-curve NFT AMMs (Sudoswap-class)  
- AP-style creation: atomic multi-asset mint without fund-side pricing  
- CoW Protocol atomic bundles (2026): swap + surrounding action in one settlement — periphery “WETH → full basket → mint” without core pricing  
- Set Protocol / Index Coop: strict collateralized portfolio + pro-rata redeem spirit  

---

## 10. 2026 SOTA refresh (what industry confirmed after earlier drafts)

### 10.1 What is *not* “oracle-free” even when people claim it is

| Pattern | Why it still needs a price root |
|---------|----------------------------------|
| Multi-asset vault that **redeems in one reference asset only** (e.g. deposit USDC/USDT, withdraw only USDC) | Must convert other assets → reference (oracle or internal swap against thin depth) |
| “NAV feed” products (RWA funds, institutional vault tokens) | Explicit Chainlink/DIA/admin NAV — trust model is custodian + oracle, not pure L1 math |
| Basket products that **mint with ETH by buying underlyings inside the fund** | Fund becomes the trader; fill quality is a settlement risk unless the mint is atomic multi-asset transfer only |

**Your hard constraint forbids all three as *core* settlement.** They may exist only as **periphery** (user or solver executes the trades; core only sees final pro-rata basket).

### 10.2 What production systems already prove is enough

1. **NFTX V3 (mainnet)** — collection vault = 1 NFT ↔ vToken; price discovery only on **NFTX AMM** (vToken/WETH); vault fees paid in **ETH/WETH** to inventory stakers and LPs — **no floor oracle for mint/redeem inventory accounting**. Target redeem premium = fee schedule, not Chainlink.  
2. **ERC-7621 / onchain baskets (2024–2026)** — share = proportional claim on multi-ERC20 reserves; pure deposit/withdraw of the basket is oracle-free. Rebalancing and “ETH-in buy-the-basket” are **separate** (manager or periphery) — do not put them in the index core if V9 is absolute.  
3. **ERC-7575** — multi-asset 4626 via **share token + per-asset pipes**. Pipes can be pure proportional multi-leg or can hide swaps; **only proportional pipes belong in production settlement** under your mandate.  
4. **CoW atomic bundles (2026)** — industry finally ships “intent + surrounding action” in one settlement. That is the correct UX layer for “I only have WETH, I want index”: solver buys `cvShare_i` on L1 AMMs, deposits pro-rata to L2, user receives index — **core never quotes NAV**.  
5. **Balancer 2025 rate-manipulation class (stable pools)** — endogenous math can still be attacked if invariants + rounding are complex. **Implication for max vision:** prefer **strict pro-rata** on L2 over clever single-asset invariant pricing on the global index. Put complexity (and attack surface) on deep L1 AMMs where the attacker pays the pool.

### 10.3 Composition theorem (the actual answer to “is full vision possible?”)

Define:

- \(V_c\) = collection vault for collection \(c\): inventory + optional CPAMM \(share_c/\mathrm{WETH}\).  
- \(I\) = global index with reserves \(\{R_{\mathrm{WETH}}, R_{share_1},\ldots,R_{share_n}\}\).  
- Fees: every fee path pays **WETH** (or paymentToken ≡ WETH) into \(R_{\mathrm{WETH}}\) (and optional streams).  

Then every maximum-vision capability reduces to functions of **balances + supply + fixed parameters**:

| Capability | On-chain function |
|------------|-------------------|
| Mint collection share | \(+1\) NFT → \(+1\) share (inventory) |
| Trade collection | CPAMM \(xy=k\) or Uni-v3 ticks |
| Mint index | transfer pro-rata \(\{r_i\}\) → mint \(s\) |
| Redeem index | burn \(s\) → transfer floor pro-rata \(\{r_i\}\) |
| Compound | \(\Delta R_{\mathrm{WETH}} > 0\), \(S\) fixed → claim per share rises |
| Dividend | EIP-2222 on earmarked WETH balance |
| Buyback | swap earmarked WETH → IDX on **internal** pool with caller `minOut` |
| Weight / sybil | \(w_c = m(\Delta t)\cdot F_c^{\mathrm{WETH}}\) from sink receipts only |

No equation in the table reads an external feed. Therefore **V1–V10 are jointly achievable**.

### 10.4 What must change vs the oracle-band Diamond

The earlier ultimate-form spec allowed `mintSingleAsset` / band NAV / TWAP checkpoints. That path is **optional convenience**, not maximum vision. Under absolute V9:

| Keep | Delete from production cut |
|------|----------------------------|
| `mintProRata` / `redeemProRata` | `mintSingleAsset` / `redeemSingleAsset` settlement |
| `reconcile` / balance-delta credit | `IIndexPriceSource` in any write path |
| Collection factory + Streams A/B | Cross-collection $ volume for weight |
| Vest injects, virtual shares, finalize | Free share mint from fees |
| L1 share/WETH AMM | Core “sell basket for WETH” |

UI may still show a **display NAV** from off-chain prices. Settlement never uses it.

### 10.5 End-state product in one sentence

**Permissionless NFTX-class vaults per collection, with mandatory WETH fee slices into a global ERC-7621-style basket of those vault shares plus WETH, mint/redeem only pro-rata, value accrual by reserve growth + optional cash/buyback streams, sybil weight from matured WETH fees — zero oracles, all on-chain.**

---

*End of research brief. Source of truth for deployment remains audited bytecode, not this document.*
