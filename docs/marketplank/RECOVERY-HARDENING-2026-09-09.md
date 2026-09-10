# Original-result recovery: security resolution

Date: 2026-09-09. This supersedes the earlier same-day recovery delta. No mainnet deployment or independent approval occurred.

## Result

The reproduced selective-relay/refund exploit PC-RELAY-OPTION-01 is blocked by removing the cancellation option itself. Both PlankCrash and experimental PlankScalableCrash now reject every LIVE refund. There is no deadline, gas budget, player role or administrator role that authorizes cancellation. The deprecated ABI method remains only to return a clear error. The explicit recovery policy is PLANK_ORIGINAL_RESULT_ONLY_V1.

A stalled canonical round retains its original round ID, target drand round, bets, underwriting and lottery commitment. Permissionless freezeStalledRound reports the incident after the configured timeout without changing those commitments or moving funds. PlankGuardedCrash freezes admissions and cancels scheduled reopening. Governance cannot request or execute reopening while that incident's original round remains unsettled. The original result can still settle while frozen; previously credited balances and unrelated bank deposits remain withdrawable.

Neither keeper nor browser attempts a refund. The keeper continues attempting the same drand relay, including after long delays. The operator console disables reopening while the original incident is pending. The rules disclosure explains that committed bets cannot be cancelled and unresolved stakes wait for verification. Lottery delivery retains the existing original-commitment retry path.

## Adversarial evidence

The prior exploit regression now tests a winning settlement followed by an externally known losing result whose relay is withheld. At 1, 30 and 300 times the timeout, each of player, outsider, guardian and governance is refused a refund. Claiming a refund and skipping the round also fail. Later delivery of the original losing entropy settles the loss without a refund. The former extra-stake gain disappears. The same fixture demonstrates that normal delayed governance reopening works only after original settlement.

A negative control restores the old missing-entropy refund predicate. The regression then fails because the formerly exploitable refund succeeds. Restoring the hardened source makes the regression pass. This demonstrates detection of that specific vulnerability; it does not prove that every possible exploit has been eliminated.

Additional tests cover gas-starved refund attempts, failed beacon reads, delayed keeper relay, frozen-state settlement, unrelated withdrawals during an outage, cancellation of pending reopening, and independent claims in the indexed variant. The 96-round lifecycle test now recovers six delayed original outcomes instead of cancelling them; 90 rounds settle and six empty rounds void.

## Validation

- 280 contract tests passed; one pending. Hardhat's aggregate includes the pending test and must not be reported as 281 executed passes.
- 1,599 application tests passed; 48 skipped.
- Type checking, required scoped lint and production build passed.
- The updated mobile operator console completed real local guardian freeze, governance reopening request and early-reopen rejection, with no page errors or horizontal overflow. This is not a mainnet multisig certification.
- The local practice stack was redeployed with the new contracts and its keeper restarted. Chain 31337 only; the existing node was not reset. Existing mainnet contracts, if any, were not modified.
- Current forced compiler output and a source fingerprint accompany the auditor package. Older Slither scans and gameplay recordings remain historical; no fresh complete static scan or formal proof is claimed for this delta.

## Explicit availability boundary

Eliminating selective refunds necessarily changes recovery: if the ORIGINAL beacon result is permanently never published or never deliverable, that round's unsettled stakes remain pending. No alternative seed, discretionary payout, silent haircut or administrator sweep was added. This is a custody/availability assumption, not a solved guarantee that no funds can ever wait indefinitely.

PC-ORIGINAL-RESULT-LIVENESS-04 remains a release-blocking review item for this changed policy and production availability evidence. Independent contract/math review and the existing production-readiness requirements remain outstanding. Public-testnet soak evidence now uses schema v2 and requires a freeze-recovery drill instead of a refund drill; old refund-drill evidence cannot satisfy the new policy. The mainnet deployment script still executes the source-bound gate before sending deployment transactions.

## Research cross-check

Chainlink's [VRF security guidance](https://docs.chain.link/vrf/v2-5/security) explains why cancellation or replacement requests can allow unfavorable randomness to be discarded. Preserving the original commitment follows that security principle. This game uses drand; the reference does not prove drand availability or establish an unconditional no-stranding guarantee.

## Reproduce

Run npm run test:contracts -- test/contracts/PlankRelayAbsence.audit.test.ts test/contracts/PlankRecoverySelection.test.ts test/contracts/PlankSafety.test.ts test/contracts/PlankRollingLifecycle.test.ts test/contracts/PlankScalableCrash.test.ts, followed by npm test, npx tsc --noEmit, npm run lint:inmotion and npm run build. Compile and export arcade ABIs before generating the release snapshot. The ZIP contains the complete source overlay selected by the snapshot, compiler evidence and this run's logs. Earlier audit fingerprints cannot authorize this new candidate.
