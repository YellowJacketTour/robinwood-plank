# SUPERSEDED on the canonical branch: SimPlankCrashDifferential.test.ts

`SimPlankCrashDifferential.test.ts.SUPERSEDED-precanonical` validated the **pre-pendingOverflow**
`PlankCrashDrand` (the `_spillOverflow` push model): its V1..V14 vectors matched the OLD `engine.mjs`,
and V16 PROVED the floor==cap-reseed pathology on that old contract. On `reconcile/plankcrash-canonical`
the contract now carries pendingOverflow, so those vectors no longer match by design — the pathology
they demonstrated is FIXED. Retained as historical regression evidence, renamed out of the active
hardhat glob. The live differential on the canonical contract is `SimPlankCrashRandomStateful.test.ts`
(phase-2 targets the pendingOverflow behavior) + `SimPlankCrashOverflowV2.test.ts`.
