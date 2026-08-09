# DESIGN AUDIT — AXIOM-1 Autogenesis Compounding Machine

**Type:** design completeness & adversarial design review (not bytecode audit)  
**Date:** 2026-08-08  
**Auditor role:** synthesis of AXIOM-0, AXIOM-1, SPEC, TEST-MATRIX, existing Diamond/factory code  
**Verdict:** **PASS WITH BINDING CONSTRAINTS** — ready for Opus implementation under the ONESHOT handoff  

---

## 1. Scope audited

| Document / surface | Reviewed |
|--------------------|----------|
| `DESIGN-AXIOM-1-AUTOGENESIS-COMPOUNDING-MACHINE-2026-08-08.md` | Yes |
| `SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md` | Yes |
| `TEST-MATRIX-AXIOM-1-ADVERSARIAL.md` | Yes |
| `DESIGN-AXIOM-0-NESTED-CLAIM-LATTICE-2026-08-08.md` | Yes |
| `RESEARCH-ORACLE-FREE-MAXIMUM-VISION-2026-08-08.md` | Yes |
| `DESIGN-N-VAULT-FACTORY-…` §7.2–7.12 | Yes |
| `CollectionVault.sol` / Factory streams | Yes (interface-level) |
| Diamond facets inventory | Yes (HANDOFF + tree) |

**Not in scope:** formal formal-verification proofs; third-party audit firm; mainnet deploy keys.

---

## 2. Pillar coverage checklist

| Pillar | Spec coverage | Residual risk | Status |
|--------|---------------|---------------|--------|
| P1 Inventory compound | Pipe I + WeightModule | Thin AMM impact | Mitigated MAX_IMPACT + skip→D |
| P2 Liquidity compound | Pipe L renounce | Vault CPAMM may lack LP token | Spec allows donateReserves extension |
| P3 PLANK burn | Pipe P + external router | Router allowlist / migrate | Timelock router pre-finalize only |
| P4 IDX burn/lock | Pipe X + SEED_LOCK | Same as §7.7 | Align existing buyback |
| P5 PLANK LP renounce | Pipe R | Canonical pool address | Construct-time immutable |
| P6 IDX trade → ETH | Pool fee → Bus/D | Pool must wire feeTo | Deploy checklist |
| P7 Autogenesis | admit + weights | Cold start chicken-egg | Bootstrap seed ≥1 vault |
| P8 Balancer exit | pro-rata mandatory | Single-asset optional only | Pure mode default |
| P9 Game theory | TEST-MATRIX ADV/W | Empirical EV tests required | Build gate |
| P10 Alignment | split table | Dev/socialfi must stay 0 in pure | Genesis TRUSTED_CAP=0 |

---

## 3. Critical design decisions (binding)

### 3.1 PASS — Energy is WETH-only observed Δ

Matches factory `paymentToken` and closes USD oracle weight.

### 3.2 PASS — PLANK outside redeemable basket

Prevents OHM-style reflexive POL death. Burns/LP renounce only.

### 3.3 PASS — Buy-only rebalance (no forced art dumps)

Core never sells cvShare to hit weights. Avoids griefing stayers.

### 3.4 PASS — Skip → Dividend

Failed buys enrich holders rather than stuck WETH in adapter or admin.

### 3.5 PASS — Vest injects

Closes flash harvest around `route()`.

### 3.6 PASS WITH NOTE — Collection “LP renounce” without Uni LP NFT

Internal CPAMM may need `donateReserves` so k increases permanently. **Opus must implement one of: (a) UniV2 LP dead, (b) vault donateReserves, (c) hold BPT with proportional exit only.** Document choice in PR.

### 3.7 PASS WITH NOTE — Valuing renounced LP inside redeemProRata

**Prefer renounced LP outside redeemable NAV** (pure externality: deeper markets). If LP is inside NAV, only via standard BPT proportional exit math — **no custom oracle mark**.

### 3.8 REJECT for pure testnet — Spendable dev/socialfi in impregnable claims

`IndexDevFundFacet` / SocialFi remain optional **trusted** side buses; default **0 bps** on AXIOM-1 pure cut. Do not market as “no admin.”

### 3.9 REJECT — Oracle-priced mintSingleAsset in pure cut

Keep code path behind flag or omit from finalized selector set for Bullish pure-mode deploy.

---

## 4. Attack surface residual register

| Residual | Severity | Treatment |
|----------|----------|-----------|
| Offline keepers delay compound | Low | Permissionless route; funds safe |
| Thin pool MEV on Pipe I | Med | Impact cap, epoch skip, vest |
| External PLANK router compromise pre-finalize | Med | Finalize freeze; mainnet audit router |
| Genesis weight capture first vault | Med | F_MIN + K + w_max + multi-collection seed |
| Rounding dust | Low | Floor to protocol; remainder to D |
| Governance before finalize | High if long window | Minimize window; multisig; then finalize |

---

## 5. Consistency with existing codebase

| Existing | AXIOM-1 action |
|----------|----------------|
| CollectionVault Streams A/B | Point sink → EnergyBus |
| IndexDividendFacet | DividendAdapter target |
| IndexBuybackFacet | Merge or call from IdxBurnAdapter |
| IndexCoinPool | fee → Bus |
| IExternalSwapRouter | PlankBurn + PlankLp |
| IndexDeployer finalize | Extend ceremony to include Bus finalize |
| IndexTradeFacet oracle paths | Disable pure cut |
| Weight maturity m(Δt) | Port Garden/index stream shape |

---

## 6. Gaps closed by this audit package

| Gap (pre-package) | Closed by |
|-------------------|-----------|
| Fees only raised cash claim, not art | Pipe I |
| No IDX market ETH airdrop engine | P6 + Pipe D |
| No automatic PLANK burn/LP | Pipes P/R |
| No build-ready interfaces | SPEC |
| No adversarial test list | TEST-MATRIX |
| No Opus/Bullish one-shot | ONESHOT doc |

---

## 7. Audit verdict

| Gate | Result |
|------|--------|
| Design complete for all 10 pillars | **PASS** |
| Genesis params locked | **PASS** (`SPEC` §0) |
| Oracle-free settlement path defined | **PASS** |
| Grief/exploit catalogue mapped to tests | **PASS** |
| Implementation ambiguity remaining | **2 notes** (§3.6, §3.7) — Opus chooses & documents |
| Ready for build handoff | **YES** |
| Ready for mainnet without code audit | **NO** — require testnet + third-party review before mainnet |

---

## 8. Sign-off (design)

**Design audit status:** COMPLETE  
**Recommendation:** Proceed to implementation per `ONESHOT-OPUS-AXIOM-1-BULLISH-DELIVERY.md`  
**Mainnet:** only after testnet soak + external audit of EnergyBus/adapters/IndexEnergy paths  

---

*This audit does not replace a professional smart-contract security audit of deployed bytecode.*
