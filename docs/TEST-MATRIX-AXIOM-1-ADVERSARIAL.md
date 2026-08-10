# TEST MATRIX — AXIOM-1 Adversarial & Invariant Suite

**Status:** required for delivery. Every row = one or more automated tests.  
**Parent:** `DESIGN-AXIOM-1-…`, `SPEC-AXIOM-1-ENERGY-BUS-…`  
**Date:** 2026-08-08  

---

## 0. How to run

```bash
npm run test:contracts
# after adding suite:
npx hardhat test test/contracts/energy/ --config ... # via package.json TS_NODE_PROJECT
```

New files (suggested):

```
test/contracts/energy/EnergyBus.route.test.ts
test/contracts/energy/WeightModule.sybil.test.ts
test/contracts/energy/InventoryBuyAdapter.test.ts
test/contracts/energy/LpRenounce.test.ts
test/contracts/energy/IdxPlankBurn.test.ts
test/contracts/energy/DividendPipe.test.ts
test/contracts/energy/Autogenesis.admit.test.ts
test/contracts/energy/Invariants.proRataExit.test.ts
test/contracts/energy/Adversary.wash.test.ts
test/contracts/energy/Adversary.flashHarvest.test.ts
test/contracts/energy/Adversary.impactSkip.test.ts
test/contracts/energy/PureMode.noOracle.test.ts
```

---

## 1. Invariants (must hold after every state-changing call in suite)

| ID | Invariant | Assert |
|----|-----------|--------|
| INV-1 | Pro-rata exit always available | `redeemProRata` succeeds for holder with shares; no role |
| INV-2 | Fee ≠ free IDX mint | After `route()`, `totalSupply` IDX unchanged unless explicit mintProRata |
| INV-3 | Fee ≠ free cvShare mint to attacker | Attacker balance cvShare only if they deposited NFT or bought |
| INV-4 | Balance-delta credit | Donation without bus path does not inflate claim without vest rules |
| INV-5 | Non-decreasing claim (redeemable) | After route+vest complete, claim per share ≥ before (except pro-rata mint/redeem equality) |
| INV-6 | Bps sum | Deploy reverts if pipes ≠ 10000 |
| INV-7 | No oracle on write | Static analysis / test: energy + core mint/redeem never call MockPriceSource |
| INV-8 | PLANK not redeemable leg | redeemProRata never pays PLANK token |
| INV-9 | Dead LP no withdraw | adapters have no withdraw; LP balance of dead increases |
| INV-10 | Vault isolation | Index revert cannot brick CollectionVault deposit |

---

## 2. Energy Bus unit tests

| ID | Case | Expected |
|----|------|----------|
| BUS-1 | route with balance < MIN | no-op / revert documented |
| BUS-2 | route splits exact bps | each adapter received correct WETH (±1 wei remainder on last) |
| BUS-3 | adapter skip → D | skipped amount reaches DividendAdapter |
| BUS-4 | MAX_ROUTE caps spend | multiple routes drain large balance safely |
| BUS-5 | reentrancy on route | blocked |
| BUS-6 | unauthorized adapter swap | cannot replace adapter after finalize |
| BUS-7 | finalize | admin zeroed; bps frozen |
| BUS-8 | permissionless route | any address can call |

---

## 3. Weight / sybil

| ID | Case | Expected |
|----|------|----------|
| W-1 | first fee m≈0 | score near 0; buy weight negligible |
| W-2 | mature after K blocks | score ≈ F/2 at delta=K |
| W-3 | wash 10× mint/redeem | washer WETH spent >> weight gain value |
| W-4 | w_max clamp | no vault > W_MAX_BPS |
| W-5 | admit threshold | checkAdmit fails below F_MIN matured; succeeds above |
| W-6 | decay | after DECAY_BLOCKS silence, score drops |
| W-7 | only factory vaults | random address cannot noteFee |

---

## 4. Adapters

| ID | Case | Expected |
|----|------|----------|
| A-I-1 | inventory buy multi-vault | cvShares land on index; weights respected |
| A-I-2 | impact too high | skip leg; funds to D |
| A-L-1 | LP renounce | dead address LP↑; no pull |
| A-X-1 | IDX lock | SEED_LOCK balance↑; live claim↑ after vest |
| A-P-1 | PLANK burn | burn address↑; index constituents unchanged |
| A-R-1 | PLANK LP renounce | dead LP↑ |
| A-D-1 | dividend | claimDividend path increases pending for holders |

---

## 5. Integration / autogenesis

| ID | Case | Expected |
|----|------|----------|
| INT-1 | deposit NFT → sink → route | end-to-end inventory or div moves |
| INT-2 | swap Stream B → route | bus receives 50% fee side |
| INT-3 | new vault admit → appears in weights | autogenesis |
| INT-4 | redeemProRata during pending route | exit works |
| INT-5 | mintProRata with cvShares | supply↑ only with assets |
| INT-6 | IDX pool swap fee → bus/div | Loop E |
| INT-7 | multi-epoch vest | flash mint cannot capture full inject |

---

## 6. Adversary scenarios (named)

| ID | Attack | Expected |
|----|--------|----------|
| ADV-1 | Sandwich route buys | impact cap / skip; no oracle mid |
| ADV-2 | Flash loan mint IDX before route | vest → attacker claim not full inject |
| ADV-3 | Donate WETH to index directly | no free shares; reconcile rules |
| ADV-4 | Fee-on-transfer token as payment | rejected or delta-correct (WETH only) |
| ADV-5 | Reentrant cvShare on credit | nonReentrant / CEI |
| ADV-6 | Admin after finalize tries pipe change | revert |
| ADV-7 | Keeper grief: never route | funds safe in bus; exit still works |
| ADV-8 | Malicious adapter in pre-finalize | only allowlisted; bytecode scan optional |
| ADV-9 | Remove liquidity from renounced LP | impossible |
| ADV-10 | Force PLANK into basket via listing | blocked by product rule test |

---

## 7. Pure-mode / regression

| ID | Case | Expected |
|----|------|----------|
| PM-1 | mintSingleAsset disabled or reverts in pure flag | configured |
| PM-2 | IIndexPriceSource unused in energy paths | pass |
| PM-3 | Existing 700+ suite still green | no regression |
| PM-4 | EIP-170 facet sizes | all under limit |

---

## 8. Gas budgets (document, not hard fail initially)

| Op | Soft target |
|----|-------------|
| route() empty weights | < 200k |
| route() 8 vaults inventory | < 2.5M |
| deposit+stream A | existing vault gas + transfer |

---

## 9. Coverage gate for Bullish handoff

Minimum to mark **AUDIT-DESIGN-COMPLETE → BUILD-COMPLETE**:

- All INV-* tests green  
- All BUS-*, W-*, ADV-1..7 green  
- INT-1..7 green  
- Full `npm run test:contracts` green  
- Written gas snapshot committed  

---

*Opus: implement tests as you implement contracts; do not defer the matrix.*
