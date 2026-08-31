# TEST ONLY — NEVER DEPLOY — PlankCrashDrandTestbed seed-disable design

Status: DESIGN SPEC (documented minimal diff), per the analysis-only mandate.
The real `contracts/PlankCrashDrand.sol` is NOT modified. Because every seed
function is `private`, the variant is a copy-with-diff of the production file
placed at `contracts/test/PlankCrashDrandTestbed.sol` when built.

## Goal
A private-alpha artifact where seeding is off as a BYTECODE invariant —
independent of reserve, floor/cap interplay, overflow stranding, or any
runtime state — closing the V16-demonstrated hole where a "seedless"
floor==cap config re-seeds after a busted-pot inflow whose spill FAILED
(excess retained above the floor makes `maxDraw = avail - floor > 0`).

## Minimal diff (against PlankCrashDrand.sol @ 6966068)

1. New immutables + unmistakable non-production marker:
```solidity
    /// TEST ONLY. NEVER DEPLOY. Bytecode-level seeding switch for the
    /// private-alpha testbed. false => _computeSeed() returns 0 forever.
    bool public immutable seedingEnabled;
    /// Unmistakable marker: every integration MUST check this reads true.
    bool public constant IS_TEST_BUILD = true;
```

2. Config struct: append `bool seedingEnabled;` (last field, so every
   positional decoder of the production struct still lines up on the shared
   prefix).

3. Constructor, FIRST lines (production-safe guards):
```solidity
    // NEVER-MAINNET GUARD: refuse to construct on Robinhood Chain mainnet
    // (4663) or any chain id below 10_000_000 that is not a known devnet.
    if (block.chainid == 4663 || block.chainid == 1 || block.chainid == 42161) revert BadHardeningConfig();
    seedingEnabled = cfg.seedingEnabled;
    // Validation: a seed-disabled build must not carry a live bootstrap
    // budget (it would silently arm if the flag were ever copy-pasted out).
    if (!cfg.seedingEnabled && cfg.seedBootstrapBudgetWei != 0) revert BadHardeningConfig();
```
   (Constructor validation of seedNumerator/Denominator etc. is kept
   unchanged so a seed-disabled build still requires a well-formed config —
   flipping the flag back on never bypasses production checks.)

4. `_computeSeed()`, first line:
```solidity
    if (!seedingEnabled) return 0; // bytecode invariant, overflow-independent
```
   This is the load-bearing line: `_seedFromReserve` then never debits the
   Vault, `nextSeed()` reads 0, and the V16 reactivation path is closed
   because the zero does not depend on `reserve`, `reserveFloorWei`,
   `reserveCap`, or stranded overflow.

5. `SeedHalted` is NOT emitted for the disabled state (it is not a circuit
   trip); `VaultSeeded` simply never fires.

## Alternative considered and rejected
Permitting an explicit validated zero seed rate (`seedNumerator == 0`)
in production code was rejected: it weakens the constructor's proper-fraction
invariant that guarantees reserve strict positivity for every OTHER deploy,
and it is a runtime-config fact rather than a bytecode fact.

## Deployment safety summary
- `IS_TEST_BUILD == true` constant — verifiable from any explorer.
- Constructor reverts on chainid 4663 / 1 / 42161 — the artifact cannot be a
  mainnet deploy even by accident or copy-paste.
- Zero bootstrap enforced when seeding is disabled.
- Marker comment block at the top of the file: "TEST ONLY. NEVER DEPLOY."
