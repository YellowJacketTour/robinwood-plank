# ONESHOT — CVI-SOTA / AXIOM-1 Complete Delivery (Bullish Testnet → Mainnet)

**Hand this document alone to Opus as build authority.**  
**Product name:** Compounding Vault Index (CVI-SOTA) · machine name AXIOM-1  
**Date:** 2026-08-08 · **Rev:** PERFECT-3 (single share atom + max compound + min risk — cake+eat-it)  
**Repo:** `robinwood-plank-index-vault`  
**Branch:** `feat/cvi-sota-axiom-1` from latest index-vault baseline  
**Customer:** Bullish — testnet first, mainnet only after gates  

---

> **This document is retired planning history, superseded in full by
> `docs/AXIOM-1-AS-BUILT.md`.** Read that document instead — it is now
> the single authority on the delivered system. Nothing below this
> line should be used to describe, build against, or report on the
> shipped protocol.

---

## 0. Mission (one paragraph)

Ship a **live multi-collection NFTX-D2-class vault-of-vaults**: each collection is a base vault (vToken + **xToken inventory compounding**); the **index holds a basket of xTokens + WETH** weighted by **on-chain demand/supply performance** (not floor oracles); an **Energy Bus** routes every WETH fee into **buy art · POL LP (fee autocompound) · burn/lock IDX · burn PLANK · PLANK POL · yield DRIP (default reinvest, not cash-out)**; **every protocol-controlled path compounds by default**; **pro-rata exit always works**; **no settlement oracle**; full adversarial tests green; deploy scripts + Bullish runbook filled.

You deliver **production contracts + tests + deploys**, not slides.

---

## 1. Product identity (do not dilute)

| Name | Meaning |
|------|---------|
| **D1** | Collection vault: NFT ↔ vToken (1:1 claim) |
| **xToken** | Inventory stake on vToken; fees raise assets/share (NFTX-class claim compound) |
| **D2 / L2** | Meta-index: holds many xTokens + WETH (vault of vaults) |
| **iToken / IDX** | Index share — claim on that basket |
| **Energy Bus** | Immutable WETH splitter → 6 pipes |
| **Performance weight** | Matured paid fees + net mint pressure + AMM depth + fee-volume — **never floor oracle** |

**Market gap you fill:** NFTX V1 D2 + Scalara multi-collection xToken basket, **maintained**, with cash yield + renounced LP + autogenesis weights.

**Forbidden “SOTA” mistakes:**

- Floor mcap / Chainlink floor as weight or mint size  
- Free iToken mint from fees  
- PLANK as redeemable basket leg  
- Pausing pro-rata redeem on “oracle stale”  
- Spendable team treasury inside Energy Bus (TRUSTED_CAP = 0)

---

## 2. Normative doc stack (conflict order)

**Highest wins:**

1. **This ONESHOT** (delivery + locked params + PR order + DoD)  
2. `docs/SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md` (interfaces; **extend** per §5 below)  
3. `docs/DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md` (**single user share S; v internal only**)  
4. `docs/DESIGN-MAXIMAL-COMPOUND-EV-2026-08-08.md` (**every junction compounds — DRIP, POL, creator**)  
5. `docs/DESIGN-CVI-SOTA-VAULT-OF-VAULTS-2026-08-08.md` (vault-of-vaults; **share-atom overrides dual v/x**)  
6. `docs/DESIGN-AXIOM-1-AUTOGENESIS-COMPOUNDING-MACHINE-2026-08-08.md` (pipes + game theory)  
7. `docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md` (**extend** per §8 + COMP-1..5)  
8. `docs/DESIGN-AUDIT-AXIOM-1-2026-08-08.md`  
9. `docs/DESIGN-N-VAULT-FACTORY-…` §7.2–7.10 · `HANDOFF-BULLISH-FULL-…` · oracle-free research  

Marketing HTML is **not** normative for bytecode.

---

## 3. Three layers (must all ship)

```
L1 BASE VAULT (×N)     NFT → single share S (4626-class; v-units internal only)
                       AMM S/WETH · Streams A/B → Bus
                       Fees raise inventory units behind S (auto-compound)

L2 META-INDEX          Holds { S_i…, WETH }
                       mintProRata / redeemProRata ALWAYS
                       Weights w_i from WeightModule (multi-signal)
                       creditInventory from Bus Pipe I (buys S)

L3 ENERGY + MARKETS    EnergyBus 6 pipes · IDX/WETH → DRIP compound
                       PLANK burn/POL outside basket
```

**Nested compound physics (must be true in tests):**

```
L1 fee → inventory units / S ↑
Bus I  → more S_i in L2
⇒ iToken claims more NFT units over time without minting free iToken
```

---

## 4. Genesis parameters (LOCKED — do not bikeshed)

### 4.1 Energy Bus (sum = 10000)

```
INV_BPS         = 3500   // buy collection share (x) into L2 by weight
CLP_BPS         = 1500   // collection POL + harvest compound
IDX_BURN_BPS    = 1500   // buy IDX → SEED_LOCK or burn
PLANK_BURN_BPS  = 1000   // buy PLANK → burn
PLANK_LP_BPS    = 1000   // PLANK POL; harvest → burn + Bus
DIV_BPS         = 1500   // default DRIP → asset compound (NOT pure cash-out)
```

### 4.1a Share model (PERFECT-3 — cake + eat it)

From `DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md` (normative):

```
USER_FACING_SHARE     = single ERC-20 per collection (x / "vault share")
INTERNAL_V_UNITS      = accounting only (never user balance)
VIRTUAL_SHARES        = dead shares + virtual assets (OZ 4626) — mandatory
EXIT                  = rate-aware burn share → NFT (1 share unit at genesis = 1 NFT)
AMM_PAIR              = share/WETH only
INDEX_HOLDS           = share_i + WETH only (no dual v/x basket)
REDEEM_PATH           = Core only; no periphery required for exit
DIAMOND               = finalize at deploy; pure-mode no oracle settlement
```

**Do not** ship dual retail vToken + xToken. **Do** ship internal v-units + user x.

### 4.1b Maximal compound defaults (PERFECT-2)

```
DRIP_BPS_OF_D           = 10000  // 100% of Pipe D reinvests into L2 claim growth
CASH_BPS_OF_D           = 0      // cash pull only if later product enables opt-in
POL_FEE_SKIM_TO_BUS_BPS = 2000   // 20% of POL harvested fees → Bus
CREATOR_TREASURY_MODE   = COMPOUND_X  // Stream A residual buys own xToken
PREMIUM_TO_X_BPS        = 5000
PREMIUM_TO_BUS_BPS      = 5000
INTENT_PROTOCOL_FEE_BPS = 5
```

| Pipe | Required compound behavior |
|------|----------------------------|
| I | Buy x → L2 |
| L | POL non-withdrawable + harvestAndCompound; skim to Bus |
| X | Buy+lock IDX |
| P | Burn PLANK |
| R | POL; harvest → more PLANK burn + Bus |
| D | Exchange-rate / reserve compound by default |

### 4.2 Safety / weight

```
K_BLOCKS        = 50400      // maturity scale ~7d
F_MIN_WEI       = 0.05 ether // admit floor cumulative fees
W_MAX_BPS       = 2500       // 25% cap per collection
DECAY_BLOCKS    = 100800     // ~14d quiet decay
VEST_BLOCKS     = 300
MAX_IMPACT_BPS  = 300
MAX_ROUTE_WEI   = 10 ether
MIN_ROUTE_WEI   = 0.001 ether
MAX_N           = 32
TRUSTED_CAP_BPS = 0
```

### 4.3 Multi-signal weight (LOCKED alphas, sum 1.0)

```
ALPHA_F   = 0.45   // matured WETH fees to bus from vault
BETA_P    = 0.25   // net mint−redeem pressure (time-decayed)
GAMMA_D   = 0.15   // AMM depth score (reserve product or WETH leg)
DELTA_V   = 0.15   // fee-derived AMM volume (not wash without fees)

s_i = m_i * (α·F̂_i + β·P̂_i + γ·D̂_i + δ·V̂_i)
w_i = cap(s_i / Σs, W_MAX) then renormalize
m_i = Δt / (Δt + K) from first fee block
```

All hats = EWMA-normalized on-chain counters only.

### 4.4 L1 fee split (before/at Stream routing)

Of each vault fee unit (WETH):

```
XTOKEN_COMPOUND_BPS = 2500  // buy vToken into inventory stake pool (or credit assets)
// remainder subject to Stream A/B:
// Stream A: ≥810 bps of mint/redeem fee → Bus (existing floor)
// Stream B: 50% of swap fee → Bus, 50% local pool (existing)
// Collection treasury gets Stream A residual after bus floor
```

If accounting requires sequencing: compound first, then Stream A/B on residual, **or** split gross fee into three buckets in one function — document and test conservation: no WETH lost.

### 4.5 Collection vault constants (keep)

Stream A sink floor **810 bps**, Stream B **5000 bps of swap fee**, swap default **100 bps**, paymentToken **WETH**.

---

## 5. Build checklist (complete)

### 5.1 Energy system

```
contracts/energy/IEnergyBus.sol
contracts/energy/IEnergyAdapter.sol
contracts/energy/IWeightModule.sol
contracts/energy/EnergyBus.sol
contracts/energy/WeightModule.sol          // multi-signal §4.3
contracts/energy/adapters/InventoryBuyAdapter.sol   // buys xToken preferred
contracts/energy/adapters/CollectionLpRenounceAdapter.sol
contracts/energy/adapters/IdxBurnAdapter.sol
contracts/energy/adapters/PlankBurnAdapter.sol
contracts/energy/adapters/PlankLpRenounceAdapter.sol
contracts/energy/adapters/DividendAdapter.sol
```

### 5.2 L1 inventory compound (CVI-critical)

```
contracts/factory/InventoryStake.sol       // OR module inside CollectionVault
// ERC-4626-style: asset = vToken (vault share), share = xToken
// convertToAssets increases as fees buy vToken into stake vault
// deposit/redeem vToken ↔ xToken
// only CollectionVault or fee router may credit fee-compound assets
```

Extend `CollectionVault.sol`:

- After fee pull: route `XTOKEN_COMPOUND_BPS` into InventoryStake  
- Emit signals for WeightModule: mint/redeem counts, fee amounts, pool reserves  
- Factory: `isVault(address)`, sink = EnergyBus  

**LP renounce strategy (pick one, document in DoD):**

- **(a)** UniV2-style LP to `0xdead`  
- **(b)** `donateReserves` permanent k↑ no withdraw  
- **(c)** Balancer BPT held only if proportional exit defined — prefer **(a) or (b)** for testnet  

### 5.3 L2 index

```
contracts/diamond/facets/IndexEnergyFacet.sol
// creditInventory(token, minAmt) onlyEnergyBus — balance Δ + vest
// constituents = xToken addresses (or vToken fallback) + WETH
```

Pure-mode cut:

| Keep | Disable |
|------|---------|
| mintProRata, redeemProRata, claim*, dividend, lens, bootstrap | Settlement via IIndexPriceSource for mint/redeem size |
| Energy credit, reconcile | DevFund/SocialFi funding from Bus |

Optional Mode B (post-testnet ok if time): Balancer-class wrapper for liquid weights; **Mode A pro-rata never removed**.

### 5.4 Markets

- IDX/WETH pool fee skim → EnergyBus or DividendAdapter  
- IExternalSwapRouter for PLANK pipes  
- SEED_LOCK_ADDR for IDX lock pattern (§7.7)

### 5.5 Deploy / ops

```
scripts/deploy/axiom1-local.ts
scripts/deploy/axiom1-testnet.ts
scripts/deploy/axiom1-mainnet.ts      // no keys in repo
scripts/verify/axiom1-postdeploy.ts
docs/BULLISH-AXIOM1-RUNBOOK.md        // fill addresses
deployments/<network>.json
```

---

## 6. Security non-negotiables (every PR)

1. No external oracle on mint/redeem/weight/credit/route settlement  
2. Credit only observed balance deltas  
3. Vest all Bus injects `VEST_BLOCKS`  
4. Fee never mints free iToken  
5. PLANK never redeemable constituent  
6. Adapters: no admin withdraw of renounced LP; Bus uses CALL only  
7. Adapter skip (impact) → remainder to **D** not admin  
8. `route()` and `checkAdmit` permissionless  
9. CEI + nonReentrant on value paths  
10. Vault isolation: plain ERC-20 to Bus only  
11. Finalize freezes bus bps + adapters  
12. `redeemProRata` never gated by roles/hooks/oracle  

---

## 7. Implementation order (strict PR stack)

| PR | Deliverable | Exit criteria |
|----|-------------|-----------------|
| **1** | WeightModule multi-signal + admit/cap/decay | W-* tests |
| **2** | EnergyBus + mock adapters | BUS-* |
| **3** | DividendAdapter + IdxBurnAdapter | A-D, A-X |
| **4** | InventoryStake xToken + vault fee compound | XTOKEN-* |
| **5** | InventoryBuyAdapter + IndexEnergyFacet | A-I, nested claim test |
| **6** | CollectionLpRenounceAdapter | A-L, no withdraw |
| **7** | PlankBurn + PlankLp | A-P, A-R |
| **8** | Factory sink→Bus e2e deposit→route | INT-1..3 |
| **9** | IDX pool fee→Bus Loop E | INT-6 |
| **10** | Pure-mode deployer + finalize ceremony | PM-*, EIP-170 |
| **11** | Full ADV matrix + gas snapshot | ADV-1..10 |
| **12** | Testnet deploy + RUNBOOK filled | Bullish package |

Do not merge PR5 without nested compound invariant green.

---

## 8. Test matrix extensions (required beyond TEST-MATRIX doc)

### Nested / CVI

| ID | Case | Pass |
|----|------|------|
| XTOKEN-1 | Fee compounds xToken assets/share | convertToAssets increases, supply fixed for staker |
| XTOKEN-2 | Redeem xToken → vToken → NFT path | full exit chain |
| NEST-1 | After route Pipe I, L2 xToken reserve↑, iToken supply fixed | claim nested ↑ after vest |
| NEST-2 | Two collections unequal fees → weights + buys skew | higher F gets more INV spend |
| W-MS-1 | Pure fee wash vs real mint pressure | β signal differentiates |
| W-MS-2 | Depth zero → γ contribution ~0 | no free weight from empty pool |
| D2-1 | mintProRata requires all xToken legs | short basket reverts |
| D2-2 | redeemProRata pays all legs floor | stayer ratios hold |

All INV-*, BUS-*, ADV-*, PM-* from `TEST-MATRIX-AXIOM-1-ADVERSARIAL.md` remain mandatory.

---

## 9. Deploy ceremony (testnet)

```
1. WETH (+ mocks NFT, PLANK, pools if needed)
2. WeightModule
3. Diamond pure-mode facet set + finalize diamond
4. IndexCoinPool; feeTo pending Bus
5. InventoryStake per vault template / beacon if needed
6. Six adapters
7. EnergyBus(bps, adapters, weight, WETH)
8. CollectionVaultFactory(EnergyBus, WETH, timelock)
9. Wire onlyEnergyBus, factory registry, noteFee auth
10. Seed ≥2 collections + pool liquidity + optional xToken seed
11. EnergyBus.finalize()
12. verify script + smoke: deposit, stake, fee, route, warp vest, redeemProRata
```

---

## 10. Gates

### TESTNET-READY

- [ ] `npm run test:contracts` 0 fail (baseline + energy + xToken + nested)  
- [ ] Pure mode: grep/test no price source on settlement paths  
- [ ] Nested compound NEST-1 green  
- [ ] Local full smoke  
- [ ] Testnet addresses in RUNBOOK + deployments json  
- [ ] EIP-170 all facets  
- [ ] LP strategy (a|b|c) documented  

### MAINNET-READY (separate)

- [ ] External audit energy + InventoryStake + IndexEnergy + deploy  
- [ ] ≥72h testnet soak, permissionless route from random EOA  
- [ ] Canonical WETH/PLANK/routers verified  
- [ ] Multisig only for pre-finalize; finalize ceremony  
- [ ] Monitoring: EnergyPushed, Routed, Admit, InventoryCredit  

---

## 11. Bullish hand package

1. Tag `cvi-sota-testnet-v1`  
2. This ONESHOT + CVI-SOTA design + SPEC + TEST-MATRIX + AUDIT  
3. Filled `BULLISH-AXIOM1-RUNBOOK.md`  
4. `deployments/testnet.json`  
5. Full test log  
6. Marketing visual: `public/x/iv.html` (non-normative)  
7. Residual risks: keeper delay, thin pool skip, LP choice  

---

## 12. Out of scope (this delivery)

- Floor oracles / NAV mint  
- Full Balancer V3 production Mode B (optional stretch after testnet)  
- Cross-chain  
- SocialFi/dev spendable bus  
- Mobile app redesign  
- ve governance politics beyond burn-to-dead  

---

## 13. Definition of Done (paste when finished)

```
CVI-SOTA / AXIOM-1 BUILD COMPLETE
branch:
commit:
test:contracts: N pass / 0 fail
nested NEST-1: PASS
xToken compound: PASS
pure mode oracle settlement: DISABLED
LP renounce strategy: (a|b|c)
Energy Bus bps: 3500/1500/1500/1000/1000/1500
weight alphas: 0.45/0.25/0.15/0.15
testnet RUNBOOK:
deployments file:
residual risks:
```

---

## 14. System prompt (copy to Opus)

```
You are implementing CVI-SOTA / AXIOM-1 in robinwood-plank-index-vault.

Single authority: docs/ONESHOT-OPUS-AXIOM-1-BULLISH-DELIVERY.md (Rev PERFECT-1).
Also implement: docs/SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md extended by ONESHOT §5,
docs/DESIGN-CVI-SOTA-VAULT-OF-VAULTS-2026-08-08.md, docs/DESIGN-MAXIMAL-COMPOUND-EV-2026-08-08.md,
docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md + ONESHOT §8.

Default EVERY protocol-controlled fee path to compound (DRIP reserves, POL harvest, creator COMPOUND_X). Cash is opt-in only.

Build: xToken inventory stake on collection vaults, multi-signal WeightModule, EnergyBus + 6 adapters, IndexEnergyFacet, pure-mode pro-rata index of xTokens+WETH, nested compounding tests, deploy scripts, Bullish runbook.

LOCKED: bus 35/15/15/10/10/15; weight αβγδ 0.45/0.25/0.15/0.15; no floor oracle; no free iToken from fees; PLANK outside basket; redeemProRata always; TRUSTED_CAP=0.

PR order 1→12. npm run test:contracts via package script (tsconfig.hardhat.json). End with Definition of Done block.
```

---

## 15. One sentence for Bullish

> A maintained NFTX-D2-class multi-collection index: compounding vault claims inside a demand-weighted basket, with every marketplace fee automatically buying art, renouncing liquidity, burning float, and paying ETH — fully on-chain, no settlement oracle, fair exit always.

---

*End ONESHOT PERFECT-1. Escalate only if baseline contracts make a binding rule impossible; propose minimal extension and continue.*
