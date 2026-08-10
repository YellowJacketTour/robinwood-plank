# The Honest Index — canonical design

**Status:** design authority. Supersedes all prior AXIOM-1 design docs.
**Date:** 2026-08-09
**Predecessor:** `docs/AUDIT-2026-08-09-FULL-SOLIDITY.md` (six CRITICALs, and the reason this document exists)

---

## 0. The thesis in one paragraph

NFTX shipped this architecture once, as v1 "D2", and killed it because *"the multi-layer model was found to suffer from long-tail, illiquid base (D1) funds causing liquidity and arbitrage issues for higher level (D2) funds which combine them."* It has no published audit coverage anywhere. D2 failed because it **stacked a liquidity illusion on top of a valuation illusion**: it marked constituents at spot while promising redemption its constituents' depth could not honour.

We do not repeat that. **We never promise more than arithmetic guarantees.** Every number this protocol displays is a number it can actually pay. That is not a limitation we accept — it is the product, and it is the one thing no competitor in NFT-fi can currently claim.

---

## 1. Redemption: the two-door theorem

### 1.1 The guarantee door — in-kind pro-rata

**Theorem.** An index redeeming in-kind pro-rata cannot be run on.

Let the index hold reserves `r₁…rₙ` against supply `T`. Redeeming `q` shares pays `(q/T)·rᵢ` of each constituent, leaving `rᵢ' = rᵢ(1−q/T)` and `T' = T−q`:

```
rᵢ'/T' = rᵢ(1−q/T) / T(1−q/T) = rᵢ/T
```

Per-share claim is **invariant** under redemption of any size, in any order. No first-mover advantage exists, so no run is possible, so no gate is ever required. This is why ETFs survive crises that suspend open-end funds.

**Consequences, which are binding design rules:**
- `redeemProRata` is always open, oracle-free, and unblockable. No pause, no fee, no allowlist, no governance reachability. Ever.
- **We therefore need no tranching, no redemption queue, and no interval windows.** Those mechanisms exist to manage a liquidity mismatch this architecture does not have.

### 1.2 The convenience door — WETH exit at realizable value

Users who want WETH rather than a basket may take a second door. It must never harm the first.

If the index sells `s` shares of a constituent whose pool is `(x` WETH, `y` shares`)`:

```
realizable(s) = x·s / (y + s)          spot mark = s·x / y
haircut ratio = y / (y + s)
```

Hold shares equal to the pool's own reserve and realizable is **exactly half** the spot mark. That is the D2 illusion, quantified in one line, computed by the same constant-product formula the AMM itself uses — no oracle, no new trust assumption.

**Theorem.** Paying a WETH redeemer exactly `realizable(s)` is the *unique* price at which remaining holders are unaffected. Pay more and the exiter is subsidised by those who stay; pay less and the exiter is taxed by them.

So the honest price and the fair price are the same number, and it is **derived, never chosen**. There is no parameter here for governance to get wrong.

This door is self-regulating: larger exits receive strictly worse fills, automatically. **The curve is the queue.**

### 1.3 Consequence for pricing everywhere

**All settlement prices in this system are realizable-integral prices.** `mintSingleAsset`, `redeemSingleAsset`, zap legs, and every Energy Bus purchase price on the integral, not on a mark and not on an oracle.

This is not merely conservative accounting. It closes audit findings at the root:
- **C-2 dies** — an impact guard becomes unnecessary when the price already includes the impact. A broken guard becomes a redundant one.
- **C-6 dies** — realizable pricing replaces the price oracle entirely, so a self-minted token priced by a self-written oracle credits ~nothing, because a fake pool has no realizable depth.
- **C-4 is largely defanged** — inflating weight over a thin pool no longer extracts value, since purchases credit only what is genuinely absorbable.

---

## 2. Fungibility: make the assumption true

`1 NFT → 1e18 S` is a **claim about fungibility**. Rather than compensating for its falsity with a redeem premium — the mechanism NFTX needed three Critical/High findings to half-fix, and which Spearbit signed off on only conditionally — we make the claim true.

**A vault is `(collection, predicate)`, not `collection`.**

- The predicate is a **merkle root over eligible tokenIds** (or a trait-hash commitment). Verification is one merkle proof: cheap, exact, no oracle.
- **The predicate is immutable at vault creation.** This is critical: a mutable predicate lets an owner widen the band after attracting deposits, which is a rug.
- Vault creation remains **permissionless**. Nobody defines the bands centrally.

Junk-for-treasure extraction requires intra-vault variance. Collapse the variance and caller-chosen redemption is harmless — with no premium, no randomness, and no depositor bookkeeping to get wrong. **C-5 dies.**

**Why this is attack-proof rather than merely better:** a vault with a sloppy predicate gets sniped, its `S` depreciates, its LPs leave, its depth falls, its weight falls, and it stops receiving energy. The failure is *locally contained and economically visible*, and the index's exposure to any one vault is capped by exit capacity regardless. The system self-heals. Fungibility becomes a market-priced property instead of a hidden liability.

---

## 3. Weight: earned with value you cannot take back

### 3.1 The anti-wash bound

If weight costs contribution `C` and attracts reward `R(w(C))`, wash-farming is profitable exactly when `R(w(C)) > C`. The design rule is therefore **`R ≤ C` for all `C`** — a provable bound, not a heuristic. Two changes establish it:

1. **Count only *unrecoverable* contribution.** Today an attacker sets their own `treasury_` and `sinkBps` and recaptures ~91.9% of the fee they "paid" (audit H-4: ~0.004 WETH buys 12.5% of all fee flow, permanently). Weight must credit **only the portion that irreversibly reaches the commons** — Bus-credited, burned, or locked into LP — and never the portion routed to a vault-chosen treasury. Faking the signal then costs exactly what it earns.
2. **Buy at realizable price** (§1.3). Weight attracting protocol purchases is a subsidy only if the purchase overpays.

### 3.2 Signal hardening

- **Depth `D` = minimum over a window, not the latest sample.** Today `noteDepth` latches an instantaneous value — flash-loan it once and it is yours forever (audit C-4/H-6). A windowed minimum cannot be faked without *holding* real liquidity for the whole window, which costs real money for real duration.
- **Volume `V` = fees, not gross notional.** The current interface documents fees and measures notional; the doc is false.
- **Decay is the staleness answer.** A decaying accumulator makes weight track *recent* unrecoverable contribution, so a dormant collection falls to zero without anyone voting on it. Collections earn their keep continuously or stop receiving energy.

### 3.3 Concentration

Replace the fiat `W_MAX_BPS = 2500` with an **exit-capacity cap**: no constituent may exceed the weight the index could actually exit within a bounded haircut. The remaining cap is derived from math rather than chosen by decree — and it also fixes audit H-8, where fewer than four admitted vaults left capped weights summing to 2500/5000/7500 and silently leaked up to 75% of the largest pipe into dividends.

### 3.4 The Robinwood floor — 8.1%, self-fulfilling

Robinwood is the permanent beneficiary: **the index holds no less than 8.1% Robinwood by value**, echoing the royalty. It may hold considerably more — and naturally will while the ecosystem is young or activity is thin, since a decaying meritocratic formula concentrates on whoever is actually contributing.

```
w_RW  = max(8.1%, meritocratic_score_RW / Σ scores)
others = (1 − w_RW) distributed by score, each under its exit-capacity cap
```

Robinwood is exempt from the *fiat* concentration cap but **not** from the *exit-capacity* cap — because exempting it from the latter would mean lying about redeemability, and §1 is not negotiable.

**The elegant resolution of that tension:** if Robinwood's exit capacity cannot currently support 8.1%, the shortfall is not waived and not faked — it is routed to **deepening Robinwood's own pool** (Pipe L) until the floor becomes honestly supportable. The floor is self-fulfilling: when we cannot hold it truthfully, we spend energy earning the right to.

This also resolves the zero-fee tension. Robinwood charges no marketplace fee beyond infrastructure cost, so it generates little *unrecoverable contribution* and would earn near-zero weight under a strictly meritocratic formula. The floor is an explicit, stated charter privilege — which is honest — rather than a thumb on the scale hidden inside the formula, which would not be.

---

## 4. Fee flow: solvency first, then yield

Maximum dividends, maximum compounding, and maximum PLANK support genuinely compete. Ordering matters more than ratios, and one principle makes the whole waterfall safe:

> **Never pay a dividend that reduces honest backing per share.**

```
Tier 0 — Solvency.   Maintain realizable/marked above target.
                     While below, all flow compounds. Non-negotiable.
Tier 1 — Compounding. Constituent backing + locked LP (index and
                     Marketplank vault LPs both autocompound).
Tier 2 — Dividends.   Paid only from flow ABOVE the solvency line.
                     Real cash to holders, never funded out of principal.
Tier 3 — PLANK.       Burn + renounced LP into the meme coin's own pool,
                     0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc.
                     Funded from a share of REALIZED growth, so it scales
                     with success instead of taxing the base.
```

**PLANK is the attention north star; the index coin is the serious asset.** Those are different jobs and the waterfall reflects it: PLANK is paid out of winnings, the index is paid out of discipline.

⚠️ **PLANK LP goes to the meme coin's Uniswap-v2-style pool at `0x69420…2DDc` — never to MarketplankVault V2 at `0xc4B29D7a…72e04`, which this audit confirms is drainable.**

---

## 5. What this design closes

| Audit finding | Closed by | How |
|---|---|---|
| C-2 inert impact guard | §1.3 | guard unnecessary; price includes impact |
| C-6 hostile self-priced listing | §1.3 | oracle removed from settlement entirely |
| C-4 weight-farming for budget | §1.3 + §3.1 + §3.2 | purchases honest; depth unfakeable; `R ≤ C` |
| C-5 junk-for-treasure | §2 | variance collapsed by immutable predicate |
| H-4 0.004 WETH buys 12.5% of flow | §3.1 | only unrecoverable contribution counts |
| H-6 latched/instantaneous signals | §3.2 | windowed minimum; fees not notional |
| H-8 weights under-summing | §3.3 | exit-capacity cap replaces fiat cap |

**Not closed by this design — still require their own fixes:**
- **C-1** (route() brickable) — a pure implementation bug; survives any redesign. Fix first.
- **C-3** (JIT-LP donation capture) — needs vesting. Spearbit's evidence says a flash-loan fee *and* a timelock, not one or the other.
- **H-1/H-2/H-3** (vest bypass, self-reported zap credit, unvested dividend leg) — independent bugs.
- Governance hardening: `GRACE_PERIOD`, a cancel/veto path, bounded `largeOpValueWei`/`minCheckpointInterval`.

---

## 6. Build order

**Phase 0 — pure bugs that survive any design.** C-1 underflow clamp + adapter refund caps; `IndexCoinPool` reentrancy; replace the three hollow tests (ADV-1, the missing `ReserveVest.test.ts`, the grep-based `Hooks.exitDoorFree`); fix the PoC time-warp leak that breaks the Seaport suite.

**Phase 1 — realizable-value accounting.** The core. Closes C-2, C-6, defangs C-4.

**Phase 2 — predicate vaults.** Immutable merkle predicate at creation. Closes C-5.

**Phase 3 — weight reform.** Unrecoverable-contribution signal, windowed-minimum depth, fee-based volume, decay, exit-capacity cap, Robinwood 8.1% self-fulfilling floor. Closes C-4, H-4, H-6, H-8.

**Phase 4 — vesting.** `_compoundXToken` vest + LP lock (C-3); dividend-leg vest (H-3); vest-bypass fix (H-1); zap `_pullCredited` (H-2).

**Phase 5 — governance hardening + the fee waterfall.**

Every phase ends with real adversarial tests that can actually fail, and each audit PoC is deleted or inverted as its finding closes.

---

## 6a. Deployment constraint: EIP-170 headroom (relieved, still finite)

`CollectionVaultFactory` calls `type(CollectionVault).creationCode`, so its deployed bytecode **literally carries the entire vault creation code as a data blob**. Factory size ≈ vault creation code + ~2.6 KB of factory logic. The two are *one* size problem: every byte the vault sheds comes straight off the factory.

At first measurement the factory sat at **24,122 bytes — 98.2%** of the 24,576 limit, with 454 bytes spare. Enabling `viaIR` for those two files (commit `43531bf`) relieved it:

| Contract | Before | After | % of limit |
|---|---:|---:|---:|
| **CollectionVaultFactory** | 24,122 | **22,723** | 98.2% → **92.5%** |
| CollectionVault | 19,735 | **17,468** | 80.3% → **71.1%** |
| *headroom* | *454* | ***1,853*** | *4.1× more* |

**The saving came from codegen, not from trading away runtime gas** — measured, because the assumption ran the other way. With `viaIR` on, factory size by optimizer runs was `runs=1 → 22,592`, `runs=50 → 22,593`, `runs=200 → 22,723`: a 131-byte spread across a 200× change. So `runs` stays at the default 200 and the hot user paths (`deposit`, `redeem`, `buyShares`, `sellShares`) keep full optimization. Users pay nothing for the headroom.

The override is scoped to those two files; all 133 other contracts are byte-identical, so no facet and no already-deployed bytecode is affected and no existing source verification breaks.

**The ceiling is relieved, not removed.** `diamondCut` is still renounced at birth, so this remains a pre-deployment constraint — there is no later fix. Budget the 1,853 bytes deliberately. If substantially more is ever needed, the real lever is a **minimal-proxy / clone factory**, so the factory stops carrying the vault's creation code at all and drops to a few hundred bytes.

---

## 7. Standing principles

1. **Never display a number we cannot pay.** Displayed = redeemable, always.
2. **Prefer derived prices to chosen ones.** A parameter governance can set wrong is worse than a formula it cannot touch.
3. **Make assumptions true rather than compensating for their falsity.** Predicate vaults over redeem premiums.
4. **Signals must cost what they earn.** `R ≤ C` or the signal will be farmed.
5. **The exit door is sacred.** In-kind pro-rata redemption is never gated, priced, paused, or made governance-reachable.
6. **A green test suite is evidence about the tests.** Three load-bearing proofs in this repo proved nothing. Assert what can fail.
7. **There is no upgrade path.** `diamondCut` is renounced at birth, so everything here must be right *before* deployment.
