# Independent PlankCrash review brief

Auditors must bind findings to the exact Git commit, manifest file hashes, compiler configuration, compiled bytecode and deployed addresses. “Repository reviewed” is insufficient provenance.

## Required scope

- `PlankCrashDrand`, `PlankBank`, `PlankPowerboardV2`, `PlankRakeDistributor`, `PlankBurnEngine`, `DrandBeacon`, progression and every reachable library/interface.
- Deployment scripts, keeper/relayer, browser ABI and action-state UI.
- Parimutuel PFSS settlement, reserve/vault movements, founder allocations, rollover/reset reserve, integer dust and every zero/maximum boundary.
- Beacon target selection, due-time calculation, relay/reveal, stale void, manual/preset lock ordering and post-reveal closure.
- Sybil splitting, whale concentration, collusion, griefing, censorship, delayed inclusion, sequencer timestamp jumps, reorgs, provider disagreement and chain halt.
- Session/bank authorization, replay/nonces, payout redirects, pull-payment liveness and compromised-key blast radius.

## Mandatory properties to reproduce independently

1. Conservation of every asset across every transition.
2. Liabilities never exceed immediately available assets.
3. A public randomness result can never improve a newly submitted discretionary lock.
4. One wallet split into many wallets gains no aggregate linear Powerboard weight.
5. A losing or non-locking player cannot receive a crash payout.
6. Payout presentation equals authoritative payout minus stake.
7. No lottery prize is displayed before full funding and founder fee accounting.
8. A lottery win cannot reduce the next base below its ratcheted requirement.
9. Void/carry-forward returns exactly the player-owned stake and rescues non-player seed exactly once.
10. No admin/operator/keeper path can redirect player or protected-reserve assets.

## Adversarial test corpus

- randomness due but unrelayed;
- randomness revealed while derived crash lies in the future;
- relay censorship and malicious duplicate submissions;
- sequencer timestamp jump after inactivity;
- transaction included after the UI deadline;
- receipt seen by one provider but absent/reorged on another;
- all lose, one survivor, all survive, zero risk weight, maximum multiplier and dust-only remainder;
- duplicate registration/claim/carry/void/reveal;
- reverting recipient, bank/session expiry and unauthorized funder;
- repeated jackpot rollover and jackpot hit at every funding boundary.

## Deliverables

- threat model and severity rubric;
- independent math implementation and deterministic vectors;
- source and bytecode findings with exploit tests;
- fixed-commit retest letter;
- unresolved assumptions and explicit deployment limits;
- signed report SHA-256 entered into the mainnet launch gate.

