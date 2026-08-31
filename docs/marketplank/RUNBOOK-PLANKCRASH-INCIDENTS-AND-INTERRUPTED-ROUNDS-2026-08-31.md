# PlankCrash incident and interrupted-round runbook

Status: operator procedure for testnet/private alpha. It does not authorize real-value operation.

## Non-negotiable rules

- Never describe a submitted transaction as accepted without a receipt/event.
- Never invent a crash result, lottery draw, payout, refund, or balance correction.
- Never relay an unverified beacon result or substitute a different beacon round.
- Never ask a player to resubmit while the first transaction is merely unknown; reconcile its hash first.
- Never use simulator balance/state injection on an on-chain environment.
- Preserve logs, hashes, proof bundles, server time, chain head, and deployed bytecode before restarting anything.

## Severity

- **SEV-1:** solvency mismatch, proof conflict/equivocation, wrong randomness mapping, unauthorized state transition, key compromise, or displayed acceptance without authoritative evidence. Stop new rounds and public access immediately.
- **SEV-2:** sequencer/RPC outage, beacon delay, keeper failure, widespread unknown transactions, or persistent room divergence. Stop launches; preserve already accepted state.
- **SEV-3:** presentation degradation with authoritative accounting intact. Disable the affected enhancement and retain the evidence path.

## Immediate evidence capture

1. Record UTC time, release SHA, URL, room/round, wallet, transaction hashes, and screenshots.
2. Export the browser’s locally verified fairness ledger without modifying it.
3. Run `npm run plankcrash:audit-manifest -- --out=<new-file>.json` from a clean checkout of the deployed SHA.
4. Run the read-only canary against each configured HTTP/WS provider.
5. Record current chain ID, latest block number/hash/timestamp, contract addresses and bytecode hashes.
6. Preserve Passenger, keeper, relayer, PostgreSQL and edge logs. Do not publish secrets or personal data.

## Sequencer or provider outage

- Freeze the UI in `status unknown`/`sync hold`; do not advance financial state from wall time.
- Query at least two independent RPC endpoints by transaction hash and block hash.
- If providers disagree, treat the transaction as unknown until canonical agreement returns.
- Do not replace-by-fee or duplicate a lock unless the protocol nonce proves the original cannot later execute.
- Resume new rounds only after head age, continuity and receipt reconciliation meet the published SLO.

## Public beacon delay

- Once the target drand round is due, manual cash-outs stay closed permanently for that round.
- Attempt permissionless verified relay/reveal through the documented keeper path.
- If randomness is unavailable through independent relays, wait for the contract’s stale-round path. Do not substitute entropy.
- `voidStaleRound` and `carryForwardStake` are the recovery primitives. Verify the `RoundVoided` event and each player’s exact carried stake.

## Proof conflict

- A local `FAIRNESS_EQUIVOCATION` or commitment/crash mismatch is SEV-1.
- Stop new rounds, export both payloads, and hash them. Do not overwrite either record.
- Compare the authoritative event stream and database audit entries against the public verifier.
- Reopening requires a published root cause, corrected deterministic vector, regression test and a new release SHA.

## Interrupted private room

- Refresh/reconnect must reload the server snapshot; it must not create a new bet or lock.
- The first accepted commitment after settlement opens the next round exactly once. Other clients join that round.
- Admin state correction is simulation-only, must be audit logged, and must identify before/after values and actor.

## Key compromise

- Remove the compromised key from its environment and revoke/deactivate its operational role where the protocol permits.
- Do not rotate a key by placing the replacement into Passenger if it belongs to cron-only infrastructure.
- Determine the exact selector/value/address powers of the key; enumerate all transactions since last-known-good.
- Immutable contracts without a pause cannot be made safe by UI hiding. Publicly disclose affected addresses and stop routing users to them.

## Recovery gate

Recovery requires: reconciled canonical state, successful full tests/build, clean audit manifest, successful testnet canary, incident owner approval, and a written postmortem for SEV-1/2. Mainnet additionally requires the independent and legal evidence checked by `npm run plankcrash:launch-gate`.

