# SPEC — AXIOM-1 Energy Bus, Adapters, Weights, Portfolio (Build Spec)

**Status:** implementation-ready specification.  
**Parent design:** `DESIGN-AXIOM-1-AUTOGENESIS-COMPOUNDING-MACHINE-2026-08-08.md` + `DESIGN-CVI-SOTA-VAULT-OF-VAULTS-2026-08-08.md`  
**Delivery authority:** `ONESHOT-OPUS-AXIOM-1-BULLISH-DELIVERY.md` **Rev PERFECT-1** (overrides on conflict).  
**Baseline code:** `feat/global-index-vault` Diamond + `CollectionVault` / `CollectionVaultFactory`  
**Date:** 2026-08-08  

**PERFECT-1 extensions (must implement):**  
- Inventory stake **xToken** (ERC-4626-style) on L1; Bus Pipe I prefers buying **xToken** into L2.  
- WeightModule multi-signal: αF+βP+γD+δV = 0.45/0.25/0.15/0.15 (see ONESHOT §4.3).  
- L1 fee slice `XTOKEN_COMPOUND_BPS = 2500` into inventory stake before/with Streams.  

---

## 0. Genesis parameters (LOCKED for testnet v1)

All bps are of **Energy Bus credit** (observed WETH Δ). Sum must equal **10_000**.

| Param | Symbol | Genesis | Bounds (timelock before finalize) | Notes |
|-------|--------|---------|-------------------------------------|-------|
| Inventory buy | `INV_BPS` | **3500** | 1000–5000 | Buy `cvShare_i` by weight |
| Collection LP renounce | `CLP_BPS` | **1500** | 500–3000 | Add cvShare/WETH LP → dead |
| IDX buy+burn/lock | `IDX_BURN_BPS` | **1500** | 500–3000 | Buy IDX → `SEED_LOCK_ADDR` or burn |
| PLANK buy+burn | `PLANK_BURN_BPS` | **1000** | 0–2000 | External PLANK router |
| PLANK LP renounce | `PLANK_LP_BPS` | **1000** | 0–2000 | PLANK/WETH LP → dead |
| Holder dividend | `DIV_BPS` | **1500** | 500–4000 | EIP-2222 / IndexDividendFacet |
| **Sum** | | **10000** | exact | Revert deploy if ≠ |

| Weight / safety | Symbol | Genesis | Bounds |
|-----------------|--------|---------|--------|
| Maturity half-scale | `K_BLOCKS` | **50_400** (~7d @12s) | 7200–403200 |
| Admit min cumulative WETH | `F_MIN_WEI` | **0.05 ether** | 0.01–1 ether |
| Max weight per collection | `W_MAX_BPS` | **2500** (25%) | 1000–4000 |
| Quiet decay window | `DECAY_BLOCKS` | **100_800** (~14d) | 0 or ≥ K |
| Inject vest blocks | `VEST_BLOCKS` | **300** | 100–5000 (reuse STREAM_VEST) |
| Max buy impact | `MAX_IMPACT_BPS` | **300** (3%) | 50–1000 |
| Max energy per `route()` | `MAX_ROUTE_WEI` | **10 ether** | 1–100 ether |
| Min energy per `route()` | `MIN_ROUTE_WEI` | **0.001 ether** | dust filter |
| Max constituents | `MAX_N` | **32** | match existing index |
| Stream A sink floor | existing | **810 bps** | already in CollectionVault |
| Stream B sink half | existing | **5000 bps of swap fee** | already |

**Finalize freeze:** after testnet bake, `EnergyBus.finalizePipes()` freezes bps + adapter addresses + dead addresses (same philosophy as Diamond finalize).

**Trustless path excludes:** IndexDevFundFacet spendable treasury and SocialFi spendable treasury from AXIOM-1 impregnability claims. If left in Diamond, label `TRUSTED_CAP_BPS` separate bus; default **0** on pure-mode testnet cut.

---

## 1. Architecture placement

```
CollectionVault ──plain WETH──► EnergyBus (or Diamond address + pull)
                                      │
                                      ├─ InventoryBuyAdapter
                                      ├─ CollectionLpRenounceAdapter
                                      ├─ IdxBurnAdapter
                                      ├─ PlankBurnAdapter
                                      ├─ PlankLpRenounceAdapter
                                      └─ DividendAdapter → IndexDividendFacet / creditDividends
```

**Recommended:** EnergyBus as **standalone immutable** contract; `upstreamSink` on factory vaults = `EnergyBus`.  
EnergyBus holds transient WETH; after `route()`, residual dust ≤ threshold stays for next call.

**Index receives assets:** adapters transfer `cvShare` / WETH / accounting updates into Diamond via:

- `IIndexEnergyReceiver.creditInventory(token, amount)` — balance-delta + vest  
- or existing reconcile pattern if tokens sent to Diamond first  

Implement **one** receive path; prefer explicit `creditInventory` with only observed Δ.

---

## 2. Contracts to build

### 2.1 `contracts/energy/EnergyBus.sol`

```solidity
// SPDX-License-Identifier: MIT
// Interface contract (implementation must match)

interface IEnergyBus {
    event Credited(address indexed from, uint256 amount, uint256 balanceAfter);
    event Routed(
        address indexed caller,
        uint256 total,
        uint256 inv,
        uint256 clp,
        uint256 idxBurn,
        uint256 plankBurn,
        uint256 plankLp,
        uint256 div
    );
    event PipeFinalized();

    function paymentToken() external view returns (address); // WETH
    function invBps() external view returns (uint16);
    // ... other bps getters
    function finalized() external view returns (bool);

    /// @notice Permissionless. Spends min(balance, MAX_ROUTE_WEI) if >= MIN_ROUTE_WEI.
    function route() external returns (uint256 spent);

    /// @notice Optional: credit accounting when WETH pushed (if not pure balance model).
    function sync() external returns (uint256 surplus);
}
```

**Requirements:**

- `nonReentrant` on `route` / `sync`
- Split: `amt_i = total * bps_i / 10_000`; last pipe gets remainder to avoid dust trap on INV
- Call adapters in fixed order: I → L → X → P → R → D  
- If adapter returns `skipped=true` (impact too high), forward that slice to **D** (holders), never to EOA  
- No `delegatecall`; only `call` to allowlisted adapters  
- Constructor sets WETH, adapters, bps, dead addresses, index receiver  
- `finalize()` by deployer role once: zero out admin

### 2.2 `contracts/energy/IEnergyAdapter.sol`

```solidity
interface IEnergyAdapter {
    /// @param amountIn WETH approved/transferred to adapter for this pipe
    /// @return used amount of WETH consumed
    /// @return skipped true if no safe fill (caller routes remainder to D)
    function execute(uint256 amountIn) external returns (uint256 used, bool skipped);
}
```

Bus transfers WETH to adapter then calls `execute`. Adapter must not hold leftover WETH without returning it to bus (return unused).

### 2.3 `InventoryBuyAdapter.sol`

1. Read weights from `IWeightModule.weights()`  
2. For each active `v` with `w_v > 0`: `budget_v = amountIn * w_v / 1e18` (or bps sum)  
3. Swap WETH → `cvShare_v` via allowlisted pool router (`CollectionVault.buyShares` or UniV2-style)  
4. Enforce `MAX_IMPACT_BPS` vs mid/spot from reserves; else skip that leg  
5. Transfer cvShares to Index; call `creditInventory`  
6. Return unused WETH to Bus  

### 2.4 `CollectionLpRenounceAdapter.sol`

1. For each weighted vault: split budget into buy cvShare + residual WETH for balanced LP  
2. `addLiquidity` to collection pool  
3. Transfer LP tokens to `DEAD` / `address(0xdead)` **or** burn if burnable  
4. Emit `LpRenounced(vault, lpAmount)`  
5. **No** withdraw function ever  

If collection pool is vault-internal CPAMM without LP tokens: use `seedLiquidity`-class path that permanently increases reserves without minting withdrawable LP to admin — document exact CollectionVault extension if needed (`donateReserves` → k↑, no shares).

### 2.5 `IdxBurnAdapter.sol`

1. Buy IDX on `IIndexCoinPool` / IDX-WETH pair  
2. Transfer IDX to `SEED_LOCK_ADDR` (existing pattern) **or** `burn` if IndexShare supports burn from holder  
3. Prefer lock-not-redeemable (existing §7.7) so redeem math stays safe  
4. Impact cap applies  

### 2.6 `PlankBurnAdapter.sol`

1. `IExternalSwapRouter.swapToPlank(amountIn, minOut, to=BURN_OR_GAUGE)`  
2. If gauge-burn: only if gauge has **no** vault admin reach (existing PlankGauge invariant)  
3. True `address(0xdead)` or known burn address for ERC-20 that don't burn  

### 2.7 `PlankLpRenounceAdapter.sol`

1. Split WETH: buy PLANK half (approx), add PLANK/WETH liquidity on canonical pool  
2. Send LP to dead  
3. Router allowlisted at construct  

### 2.8 `DividendAdapter.sol`

1. Transfer WETH to Diamond / call `receiveDividends` / `creditDividends` path already proven  
2. Must not mix into redeemable reserves incorrectly — use existing ecosystem/dividend segregation rules  
3. Prefer existing `IndexDividendFacet` entrypoints  

---

## 3. Weight module

### 3.1 `contracts/energy/WeightModule.sol` (or facet)

**Storage per vault:**

```solidity
struct VaultScore {
    uint256 feeWethCumulative; // F_v
    uint64 firstFeeBlock;
    uint64 lastFeeBlock;
    bool admitted;
}
```

**On EnergyBus credit from vault v:** (vault should tag? or bus maps `msg.sender`→vault)

Factory vaults all push from vault address → `WeightModule.noteFee(vault, amount)` only callable by Bus after verifying `factory.isVault(vault)`.

**Views:**

```solidity
function score(address vault) public view returns (uint256 s); // m * F * decay
function weights() external view returns (address[] vaults, uint256[] wBps); // sum 10000 among admitted
function checkAdmit(address vault) external; // permissionless admit when score >= F_MIN matured
```

**Maturity:**

```
m = delta / (delta + K) where delta = block.number - firstFeeBlock
```

**Decay:** if `block.number - lastFeeBlock > DECAY_BLOCKS`, multiply score by `DECAY_BPS/10000` stepwise or continuous formula in spec tests.

**Cap:** after normalize, clamp each `w` to `W_MAX_BPS`, redistribute remainder pro-rata to uncapped (standard).

---

## 4. Index integration (Diamond)

### 4.1 Pure-mode production cut (testnet AXIOM-1)

| Keep | Disable / gate |
|------|----------------|
| `mintProRata`, `redeemProRata` | Settlement via `IIndexPriceSource` for mint size |
| Dividend facet | — |
| Buyback facet (may merge with IdxBurnAdapter) | — |
| Bootstrap seed + open | — |
| Lens | — |
| `mintSingleAsset` / `redeemSingleAsset` | **Off for pure testnet** OR keep only with pool-invariant path documented as non-oracle |

### 4.2 New facet: `IndexEnergyFacet` (or extend Bootstrap)

```solidity
function creditInventory(address token, uint256 minAmount) external onlyEnergyBus;
// measures balance delta, applies vest, updates constituent reserve if listed
function creditWethFromBus(uint256 minAmount) external onlyEnergyBus;
```

Constituent must be **admitted** (weight module or governance seed list) before inventory credit of `cvShare` increases that leg.

### 4.3 Listing path for autogenesis

`checkAdmit(vault)` on WeightModule → calls Index `seedConstituent` / `executeListing` equivalent **permissionless** when thresholds met — reuse ramp-in from IndexBootstrapFacet.

---

## 5. CollectionVault extensions (minimal)

Already has Streams A/B → sink. Confirm:

- `upstreamSink == EnergyBus`  
- paymentToken == WETH  

**May need:**

- `isVault` registry on factory (exists via predict/mapping)  
- Optional: `donateToReserves(uint256 weth, uint256 shares)` for LP renounce without LP token  
- Events: `EnergyPushed(uint256 amount)` for indexers  

---

## 6. IDX/WETH pool fee → Bus

`IndexCoinPool` / pool swap fee: protocol cut transfers WETH to EnergyBus (or DividendAdapter directly).  
Wire in pool fee collector: `feeTo = EnergyBus` or skim function permissionless `skimToBus()`.

---

## 7. File checklist (new)

```
contracts/energy/EnergyBus.sol
contracts/energy/IEnergyBus.sol
contracts/energy/IEnergyAdapter.sol
contracts/energy/IWeightModule.sol
contracts/energy/WeightModule.sol
contracts/energy/adapters/InventoryBuyAdapter.sol
contracts/energy/adapters/CollectionLpRenounceAdapter.sol
contracts/energy/adapters/IdxBurnAdapter.sol
contracts/energy/adapters/PlankBurnAdapter.sol
contracts/energy/adapters/PlankLpRenounceAdapter.sol
contracts/energy/adapters/DividendAdapter.sol
contracts/diamond/facets/IndexEnergyFacet.sol  // if needed
test/contracts/energy/*.test.ts
scripts/deploy/axiom1-testnet.ts
scripts/deploy/axiom1-mainnet.ts
docs/SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md  // this file
```

---

## 8. Deploy order (atomic where required)

1. Deploy WETH (testnet) / use canonical (mainnet)  
2. Deploy mock/real PLANK pool + router adapters  
3. Deploy Index Diamond (finalize pure-mode facet set)  
4. Deploy IDX/WETH pool; set fee skim  
5. Deploy WeightModule  
6. Deploy adapters (with placeholders)  
7. Deploy EnergyBus(adapters, bps, index, factory)  
8. Deploy CollectionVaultFactory(upstreamSink=EnergyBus, paymentToken=WETH)  
9. Wire `onlyEnergyBus` roles on Index  
10. Seed ≥1 collection vault + seed liquidity  
11. `EnergyBus.finalize()` + Diamond already finalized  
12. Verify: deposit NFT → fee → `route()` → inventory/dividend effects  

---

## 9. Acceptance criteria (delivery)

- [ ] `npm run test:contracts` all green including new energy suite  
- [ ] No non-view function in energy/index mint-redeem uses `IIndexPriceSource`  
- [ ] `route()` permissionless; skipped pipes → D  
- [ ] LP renounce: no withdraw selector on adapters  
- [ ] PLANK not in redeemable index constituents  
- [ ] `redeemProRata` works with bus offline  
- [ ] Wash simulation: cost > benefit in test  
- [ ] EIP-170 all facets < 24_576  
- [ ] Deploy scripts dry-run on hardhat + testnet  
- [ ] HANDOFF addresses filled for Bullish  

---

*Build against this spec; parent design is normative for intent.*
