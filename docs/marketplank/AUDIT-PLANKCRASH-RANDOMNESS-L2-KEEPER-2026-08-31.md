# PlankCrash randomness, L2 timing, and keeper audit

Date: 2026-08-31  
Scope: `PlankCrashDrand.sol`, `DrandBeacon.sol`, `casino-keeper.ts`, and the production boundary  
Status: engineering review; **not** an independent audit or launch approval

## Executive decision

The BN254 drand verifier is a sound production candidate, but the current
PlankCrash lifecycle is **not ready for real-value production**. The principal
blocker is not signature verification. It is a free option created by
`voidStaleRound`: after the designated drand output is public, a party can relay
and settle a favorable result or withhold it until the block timeout and void an
unfavorable result. On-chain availability checks only narrow this attack; they
cannot prove that a public, immutable off-chain result does not exist.

The production rule must therefore be:

> Once a round has accepted value and committed to a valid drand chain and
> round, that exact result remains settleable forever. Transport failure delays
> settlement; it never changes the outcome or creates a refund choice.

Seedless/private-alpha recovery may use an explicitly test-only escape hatch,
but production bytecode must not expose an outcome-dependent timeout void.

## Findings

### RND-1 — Critical: timeout void enables result shopping

`lockRound()` fixes `targetDrandRound`, but `voidStaleRound()` checks only
`entropyRevealed` and `maxAwaitBlocks`. The output is publicly readable from
multiple drand relays before it is copied into `DrandBeacon`. A participant,
keeper, or colluding operator can evaluate the predetermined outcome off-chain:

1. relay + reveal + settle when favorable;
2. withhold the relay and call `voidStaleRound()` when unfavorable.

Adding `beacon.isRoundAvailable(target)` to the void function prevents voiding
after an honest on-chain relay, but does not remove the option while public
randomness is withheld from this chain. Keeper redundancy improves availability
but cannot establish non-existence.

**Required correction:** remove the production timeout-void path for a locked,
funded round. Preserve permissionless `submitRound`, `revealEntropy`, and
`settleRound` indefinitely. If product policy requires disaster recovery, use a
governance migration that preserves the already-designated result, or a refund
process that cannot activate based on a single round's observed output. Do not
select a replacement beacon or replacement round after seeing the first result.

### RND-2 — High: raw beacon output lacks application domain separation

`_deriveCrash(randomness)` consumes the cached drand output directly. A robust
seed binds the public randomness to at least:

```text
keccak256(
  "PLANKCRASH_RESULT_V1",
  chainid,
  verifyingContract,
  rulesHash,
  gameRoundId,
  drandChainHash,
  targetDrandRound,
  drandRandomness
)
```

This prevents accidental same-output coupling between PlankCrash, Powerboard,
other deployments, forks, and future rule versions. It does not make public
randomness secret and must not be presented as doing so.

**Required correction:** store/derive an immutable rules-domain identifier,
expose the complete preimage through views/events, add public deterministic test
vectors, and use the domain-separated seed for the exact integer transform.

### RND-3 — High: the designated round is selected at lock, not at round open

`targetDrandRound` is selected by the transaction that calls `lockRound()`.
Although the 20-period look-ahead keeps that output in the future, the keeper
controls when the target is chosen after bets are already known. The cleaner
commitment is an immutable round envelope created before the first bet, with a
target derived from a scheduled close plus safety delay. This removes keeper
discretion and makes every accepted bet attest to the exact randomness target.

**Required correction:** create and emit the envelope at `_startRound()`, freeze
its target before accepting value, and include its hash in signed/UI receipts.
Reject configurations whose cadence can reuse a target. Do not exempt
`roundIntervalSeconds == 0` in production.

### TIME-1 — High: manual live cash-out depends on sequencer-controlled L2 data

The economic curve uses `block.number - lockBlock`; cash-out admission uses L2
transaction ordering and `block.timestamp`. The two-belt close
(`revealNotBefore` plus on-chain beacon availability) is materially better than
a relay race, but still explicitly assumes bounded sequencer clock lag. It does
not turn a browser click into fair, instant finality.

**Required product boundary:** ranked/real-value play should use a target chosen
and committed before randomness can exist. Manual live cash-out can remain an
unranked simulation or a clearly disclosed preconfirmation system with its own
trust and failure model. Animation must interpolate a server/chain-authoritative
state and never determine settlement.

### TIME-2 — Medium: block-count timeouts are not wall-clock service objectives

`maxAwaitBlocks` conflates L2 block production with a service deadline. It is
especially inappropriate as a fairness transition (RND-1). Monitoring may use
wall-clock SLOs, but the contract result must remain invariant through sequencer,
RPC, or relayer delay.

### OPS-1 — High: relayer uses one HTTP origin, not official failover/racing

`relay-drand.ts` and `casino-keeper.ts` default to one `DRAND_API`. drand's
official client guidance recommends verified clients with failover, racing,
aggregation, and caching. The on-chain verifier protects integrity, but one
origin still creates avoidable latency and availability risk.

**Required correction:** race at least three independently operated relays,
pin the evmnet chain hash/public key out of band, validate round equality, bound
timeouts and response sizes, submit exactly once with idempotent handling, and
retain per-origin latency/error telemetry. Include HTTP and a non-identical
operator/CDN path. Never disable verification in any off-chain consumer merely
because the contract verifies later.

### OPS-2 — Medium: keeper economics do not equal keeper availability

Permissionless bps rewards and the bounded designated-keeper floor reduce
incentive failures, but production needs at least two independently operated,
gas-funded keepers plus a permissionless fallback. Alerts must cover target due,
relay fetched, beacon submission confirmed, reveal confirmed, settlement
confirmed, replacement transaction, and outstanding pull-payment credit.

No reward should depend on selecting a new randomness source or round. The
keeper may transport and finalize a committed fact; it may not choose the fact.

### RNG-1 — Medium: modulo transform needs an explicit statistical contract

`uint256(randomness) % 10000` introduces negligible cryptographic modulo bias
for a 256-bit uniform input, but intentionally compresses outcomes to 10,000
buckets. The instant-crash branch is 1/10,000, not 1%. The exact distribution,
cap behavior, integer rounding, expected RTP, and tail probabilities must be
versioned and published. If a wider-resolution design is adopted, use a
specified full-width transform or rejection sampling and preserve golden
vectors across Solidity and clients.

## Production architecture

1. **Immutable root of trust:** deploy a `DrandBeacon` pinned to evmnet chain
   hash, BN254 scheme, public key, genesis, period, and DST independently
   verified from multiple operators.
2. **Pre-bet envelope:** commit chain, contract, rules, round, close time,
   drand network, and target round before accepting the first stake.
3. **Permanent result:** one target, one verified signature, one
   domain-separated seed, no result-dependent void or fallback shopping.
4. **Transport mesh:** independent keepers race verified relays and submit an
   idempotent transaction; replacement raises fee without changing calldata.
5. **Target-lock settlement:** wallet/RPC/browser failure cannot alter the
   committed cash-out target. UI frames are presentation only.
6. **Proof bundle:** envelope, target, drand signature, beacon transaction,
   derived seed, transform version, settlement receipt, and accounting delta.
7. **Beacon migration:** a new drand chain requires a new verifier and a new
   rules version. Existing rounds remain bound to their original verifier and
   target; no in-flight migration.

## Acceptance tests required before production freeze

- Public drand evmnet fixture verifies on-chain and produces the published
  randomness; malformed point, key, DST, chain, and round all fail closed.
- The same drand output produces different seeds for different chain IDs,
  contracts, rule versions, game rounds, and Powerboard domains.
- A locked production round has no path to void/refund because relay, sequencer,
  RPC, or keeper service is delayed.
- Randomness relayed before/after every phase boundary yields the same outcome.
- Reorg/replacement/idempotent keeper races cannot overwrite a verified round.
- Target selection is fixed before the first accepted bet and cannot repeat for
  overlapping production envelopes.
- Differential vectors match Solidity, TypeScript, and the independent verifier
  for the entire cap/rounding boundary set.
- Chaos drills disable each relay, keeper, RPC, and the sequencer-facing endpoint
  independently; settlement is delayed but never rerolled or voided.

## Source audit

Primary and academic sources used in this pass:

- drand protocol specification (chain hash as root of trust, scheme and group
  semantics): https://docs.drand.love/docs/specification/
- drand developer guide (evmnet is BN254/EVM-compatible; pin chain hash and
  verify outputs): https://docs.drand.love/developer/
- drand HTTP API and client guidance (multiple public relays; verified
  failover/racing/caching):
  https://docs.drand.love/developer/API-v1/drand-http-api/ and
  https://docs.drand.love/developer/clients/
- Arbitrum Nitro whitepaper (sequencer ordering, L2 timestamp, delayed-inbox
  model): https://docs.arbitrum.io/nitro-whitepaper.pdf
- SoK: Decentralized Randomness Beacon Protocols (unpredictability,
  bias-resistance, availability, public verifiability):
  https://arxiv.org/abs/2205.13333
- SoK: Distributed Randomness Beacons (withholding/selective-abort threat
  taxonomy): https://eprint.iacr.org/2023/728.pdf
- Fair Delivery of Decentralised Randomness Beacon (delivery fairness is a
  separate property from output correctness): https://eprint.iacr.org/2023/103.pdf

## Gate conclusion

The current seedless testnet deployment remains appropriate for explicitly
labeled simulation. Production/mainnet remains blocked until RND-1, RND-2, and
RND-3 are implemented and independently reviewed, target-lock is the economic
authority, multi-origin keeper failover is exercised in an incident drill, and
the resulting bytecode/evidence hashes are frozen.
