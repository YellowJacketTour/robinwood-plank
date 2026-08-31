# PlankCrash signed testnet canary and receipt-gas runbook

Status: executable Robinhood-testnet evidence workflow; not mainnet approval.

## What it proves

The canary fails closed unless chain ID is `46630`, all six configured addresses contain bytecode, the seedless/test-build flags are true, and the crash, bank, fuel, Powerboard, progression, and mock-beacon wiring agree on chain. It then:

1. discovers each creation transaction through Blockscout;
2. independently reads every receipt from the configured chain RPC;
3. records `gasUsed`, effective gas price, total wei cost, block number/hash, status, runtime bytecode hash, and address;
4. broadcasts a signed write to an unreachable mock-beacon sentinel round and verifies the persisted value; and
5. signs the SHA-256 of a canonical JSON payload, then verifies signature recovery before writing the artifact.

The manual canary workflow is non-invasive and safe for a shared friend-test table. The deployment rehearsal additionally enables `CANARY_EXERCISE_FRESH_ROUND=1` immediately after a new deployment. That opt-in path requires an unused first round and records receipts for `placeBet`, `lockRound`, mock `setRandomness`, `revealEntropy`, and `settleRound`.

Run the existing deployment with a lifecycle canary:

```text
Actions -> PlankCrash testnet rehearsal -> Run workflow
confirmation: ROBINHOOD-TESTNET-ONLY
```

Probe the existing deployment without touching its live round:

```text
Actions -> PlankCrash signed testnet canary -> Run workflow
confirmation: ROBINHOOD-TESTNET-CANARY
```

The only credential is `DEPLOYER_PK_TESTNET`, consumed by the runner as a signer. It is never serialized. The artifact is rejected if it contains a private-key-shaped field name.

The script also supports migration to a separately held key without a code change: point the Hardhat signer at that canary credential and set `CANARY_EXPECTED_SIGNER` to its public address. The evidence will classify it as separate from the deployment address. The workflow deliberately remains on the existing deployment secret until separate custody is provisioned.

## Evidence interpretation

- Deployment receipt gas is real Robinhood-testnet execution evidence for these exact bytecodes and constructor arguments.
- Lifecycle receipt gas is the input for keeper-floor and stipend ratification. Use a distribution across repeated runs (median and high percentile), not one receipt.
- The signature proves control of the deployment key at evidence time. It is **not independent attestation**, because the deployer key and canary signer are currently the same secret.
- Blockscout is used only to discover creation hashes. Receipt contents are re-read from RPC and contract addresses are matched exactly.
- The sentinel write is intentionally outside the round range the game can reach. It does not prove gameplay fairness.

## Hard limitations and launch gates

`DrandBeaconMock` is openly manipulable. The lifecycle chooses a deterministic immediate crash to bound test duration. Therefore this artifact proves deployment/configuration/write-path operation and gas only; it proves no randomness fairness, no economic safety under real value, and no licensing or audit approval.

Before any real-value launch, repeat the canary with a production randomness beacon, a separately controlled canary signer, multiple RPC providers, repeated keeper operations sufficient for p50/p95/p99 gas, reorg/finality observation, and independently signed bytecode/audit/math/legal artifacts.
