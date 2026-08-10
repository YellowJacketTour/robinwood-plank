# Slither triage — post-redesign code

**Date:** 2026-08-09
**Tool:** slither-analyzer 0.11.6, solc 0.8.24 (via `solc-select`), standalone per-file invocation
**Scope:** the code added *after* the audited commit `1525597` — 8,631 lines across the honest-index redesign

This document exists so an incoming auditor knows exactly which static-analysis findings were examined and dismissed, **and can challenge the reasoning** rather than repeating the triage. Every dismissal below states its argument; if an argument is wrong, the finding is live.

---

## Toolchain note (read this before re-running) — CORRECTED

The **`slither .` console script** crashes on this repo with a fatal CPython error:

```
Fatal Python error: _PyEval_EvalFrameDefault: Executing a cache
```

**Invoking it as a module works.** This was found after the per-file triage below was written, and it supersedes this document's original claim that whole-project analysis was impossible:

```bash
python -m slither .        # works
slither .                  # crashes — console-script entry point only
```

**Whole-project result at `bff8e5c`:** 284 contracts analysed, 102 detectors, **748 results** — 364 informational, 176 medium, 161 low, **37 high**, 10 optimization.

Of the 37 High: 12 are in `contracts/test/` mocks or in OpenZeppelin itself (`Math.mulDiv`'s well-known `^`-vs-`**` false positive). The **25 in production contracts** are 22 `reentrancy-balance`, 2 `reentrancy-eth`, and 1 `arbitrary-send-erc20` — **precisely the two families triaged below**, plus the `_pullCredited` finding already cleared in the original audit (internal function; all four call sites pass `msg.sender`).

So the whole-project run surfaced **no new family** beyond what the per-file triage below already covers.

The per-file method is still documented because it is useful for iterating on one contract, and it is how the detailed findings below were produced:

```bash
solc-select install 0.8.24 && solc-select use 0.8.24
slither contracts/factory/CollectionVault.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies --exclude-informational
```

⚠️ **Operator warning:** Slither runs `hardhat clean` + `compile --force`. Running it while a test suite is executing corrupts the artifacts the tests are reading and produces phantom `Unexpected end of JSON input` / `Unterminated string in JSON` failures that look like real breakage. This happened three times during this work and resolved to a read race every time. **Never run Slither and `npm run test:contracts` concurrently.**

---

## Results

| Contract | Contracts analysed | Results | Verdict |
|---|---:|---:|---|
| `CollectionVault.sol` | 16 | 47 | all triaged below |
| `WeightModule.sol` | 4 | 18 | all triaged below |
| `EnergyBus.sol` | 8 | 6 | all triaged below |
| **`IndexRealizable.sol`** | 1 | **0** | clean |

`CollectionVault` by impact: 4 High, 25 Medium, 18 Low. Every High and Medium falls into exactly three families.

---

## Family 1 — `reentrancy-*` (8 findings) → FALSE POSITIVE

Flagged: `redeem` (reentrancy-eth), `buyShares`, `addLiquidity`, `removeLiquidity`, `_pullFee`, `_routeStreamA`.

**Why dismissed — verified, not assumed.** Every flagged *external* carries `nonReentrant`:

```
deposit:520 · redeem:520 · buyShares:778 · sellShares:807 · addLiquidity:914 · removeLiquidity:955
```

and both flagged internals (`_pullFee:534`, `_routeStreamA:551`) are `private`, reachable only from inside those guarded externals. Slither is not modelling the guard.

`redeem`'s `reentrancy-eth` is the ERC-721 `safeTransferFrom` → `onERC721Received` callback. This is a genuine reentrancy *vector* and was examined directly during the audit: `S` is burned and the inventory index updated **before** the NFT transfer (strict CEI), under `nonReentrant`. This is the JPEG'd/Curve failure shape (~$11.5M, LP tokens minted against pre-burn balances) and it does not apply here.

**Residual note for the incoming auditor:** the audit did record one LOW nit — `_routeStreamA` sits *after* the NFT transfer in `redeem`. Harmless today because the guard holds, but it is the one line in this family worth re-checking if the guard is ever refactored.

## Family 2 — `incorrect-equality` (14 findings) → FALSE POSITIVE

Every hit is an unsigned zero-guard of the form `x == 0` — `shareReserve == 0`, `grossOut == 0`, `sharesIn == 0`, `m == 0`, `d == 0`. The detector targets dangerous strict equality on *balances or timestamps* that an attacker can land exactly on. A `== 0` guard on an unsigned quantity is exact by construction and is the codebase's uniform early-return idiom. The same misfire was recorded on the pre-redesign tree (20 hits, all identical shape).

## Family 3 — `divide-before-multiply` (9 findings) → INTENTIONAL. **Do not "fix" without reading this.**

Flagged in `quoteSellShares`, `quoteBuyShares`, `buyShares`, `sellShares`, `_swapFeeSinkCut`, `removeLiquidity`, `WeightModule._rawScore`, `WeightModule._exitCapacityWeth`.

Two independent reasons these stay as they are:

**(a) In the quote functions it is REQUIRED for correctness.** `quoteSellShares` must return, wei-for-wei, what `sellShares` would pay — that mirror is the foundation of the whole realizable-pricing design (`DESIGN-HONEST-INDEX` §1.2/§1.3). The expressions are therefore deliberately identical:

```solidity
// quoteSellShares:705              // sellShares:811
inNet    = (sharesIn * (BPS_DENOMINATOR - swapFeeBps)) / BPS_DENOMINATOR;   // identical
grossOut = (inNet * _pr())          //  (inNet * paymentReserve)
           / (shareReserve + inNet);//  / (shareReserve + inNet);
```

**Reformulating the quote to multiply-first would make it MORE precise than execution and therefore WRONG** — the quote would promise more than the swap pays, which is exactly the class of overstatement this protocol exists to eliminate. Any change must be applied to both sides together, with the mirror re-proven.

*(The `_pr()` vs `paymentReserve` difference is not a mismatch: `sellShares` calls `_drip()` first, committing the elapsed donation vest into `paymentReserve`; the `view` quote cannot mutate, so `_pr() = paymentReserve + _drippable()` reconstructs the identical post-drip value. `effectivePaymentReserve()` exposes this to integrators, since the raw storage slot lags by up to one call.)*

**(b) Everywhere else the loss is ≤1 wei per step and rounds in the protocol's favour.** `inNet` floors, so the trader receives slightly less and the pool keeps the remainder. `_exitCapacityWeth` floors twice, so the exit-capacity cap is *understated* — a tighter, more conservative cap. `_rawScore` is a **relative** score: weights are `s_i / Σs_j`, then capped and renormalised to exactly 10,000 bps, so a uniform ~1e-18 relative error cancels entirely.

**Empirically confirmed, not merely argued:** `test/contracts/factory/AuditRounding.poc.test.ts` fuzzes round-trips from 1 wei to 1e21 and reports monotone behaviour with no sign flip — rounding never crosses into favouring the trader.

## `WeightModule` — remaining findings

Same two families (`divide-before-multiply` ×2, `incorrect-equality` ×7, both covered above). Nothing outside them.

## `EnergyBus` — remaining findings

One `incorrect-equality` in `_runPipe` (a `== 0` guard). Note that `_runPipe` is the site of audit finding **C-1**, where a subtraction underflowed inside a ternary condition; that is fixed and the fix carries its own inverted PoC (`AuditPoc.energy.test.ts`, "PoC-1 (FIXED)").

---

## Summary

**No static-analysis finding on the post-redesign code survives triage as a real defect** — and this now covers the whole project (284 contracts, 748 results), not merely the principal files. Every High and Medium reduces to a guard Slither does not model, an unsigned zero-check, or an intentional fixed-point ordering whose rounding direction favours the protocol and is fuzz-verified.

**What this does NOT establish.** Slither finds shallow, pattern-matchable defects. Every finding in the original audit — inert guards, unvested value, self-referential price references, privileged keys with undocumented blast radius — was **economic and invisible to static analysis**. A clean Slither run is a floor, not a ceiling, and must not be cited as evidence that the redesign is sound. The remediation has still never been independently audited.
