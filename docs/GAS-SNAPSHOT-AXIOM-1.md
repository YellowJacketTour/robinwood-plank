# GAS SNAPSHOT — AXIOM-1 EnergyBus.route()

**Generated:** 2026-08-09T19:45:47.320Z
**Network:** hardhat
**Source:** `scripts/gas/axiom1-gas-snapshot.ts` (run via `npx hardhat run scripts/gas/axiom1-gas-snapshot.ts --network hardhat`)

Per `docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md` §8 — documentation only, not a
hard-fail gate.

| Op | Soft target (matrix §8) | Observed |
|----|--------------------------|----------|
| `route()` empty weights | < 200k | 572350 |
| `route()` 2 seeded vaults (real `axiom1-local.ts` deploy, real 6 adapters, real WeightModule/index) | < 2.5M (matrix's own row is stated for 8 vaults; 2 vaults is this repo's real `axiom1-local.ts` seed count) | 1199429 |

## Notes

- "Empty weights" measures a real `EnergyBus.route()` against a real
  `InventoryBuyAdapter` whose `WeightModule` has zero admitted vaults (Pipe
  I's own `n == 0` safe-skip branch), with `MockEnergyAdapter` (SPEND_ALL)
  standing in for the other five pipes — this isolates the Bus's own
  six-pipe dispatch overhead from any one pipe's adapter-specific cost.
- "2 seeded vaults" runs the ACTUAL `deployAxiom1Local()` ceremony
  (`scripts/deploy/axiom1-local.ts`) — every adapter, the real
  `WeightModule`, the real index Diamond, two real `CollectionVault`s, both
  admitted into weights — then funds the (already-`finalize()`d) Bus with
  fresh WETH and measures one real `route()` call across all 6 real pipes.
- Gas numbers on a local Hardhat network are a reasonable proxy for L1/L2
  mainnet cost ordering, not a guaranteed absolute figure — re-run this
  script after any change to the adapters, `EnergyBus`, `WeightModule`, or
  the index Diamond's `creditInventory`/`reconcile` path to refresh it.
