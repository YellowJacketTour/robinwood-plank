# Plank Lockstep: crash execution and lottery safety specification

Status: design candidate; **not approved for production wagering**  
Date: 2026-08-27  
Scope: PlankCrash, Powerboard, wallet execution, settlement, presentation, responsible play, verification, and operations

## Executive decision

Plank should offer two visibly different execution lanes:

1. **Target Lock** is the default and the only ranked/competitive lane. A player commits an automatic cash-out multiplier before randomness can be known. It remains fair during RPC, browser, or sequencer degradation.
2. **Live Lock** is an explicitly latency-sensitive, unranked entertainment lane. A click is signed locally and multicast to independent endpoints. It is economically effective only when the protocol has accepted a valid intent before the deterministic deadline.

The client may react instantly, but it must never display a financial win or a locked target until evidence supports that state. The four proof states are **Chosen locally**, **Sending**, **Accepted by Robinhood Chain**, and **Settled**. Optional fast receipts add a separately named **Witnessed** state; they are not chain finality.

This architecture is called **Plank Lockstep**. Its settlement protocol is **Sealed-Intent Crash**. Its essential invention is to separate the player's instant, cryptographically binding intent from the slower proof that the authoritative system accepted it. That produces a responsive game without inventing click-time finality that a centrally sequenced chain cannot provide.

“Best” and “provably fair” are release claims to be earned by reproducible evidence, not adjectives in product copy.

## What the audit rejects

The existing crash implementation must not ship unchanged:

- The target drand round is selected in `lockRound()` rather than committed before bets, leaving timing dependent on the lock transaction.
- Economic cash-out is inferred from L2 block progression. L2 block cadence and transaction inclusion are sequencer-controlled; animation time is not a fair financial clock.
- Manual cash-out is inclusion-order fairness, not click-time fairness. A sequencer or provider can delay, censor, or reorder it.
- The crash transform uses only 10,000 buckets. Its current `r == 0` branch makes the instant-crash probability 1/10,000, not 1/100, while truncation and caps obscure exact RTP.
- Raw shared randomness is not domain-separated by chain, contract, implementation/rules, game round, and beacon round.
- Block-count stale-round voiding can conflict with an already available beacon result. Once the designated result exists, settlement must permanently dominate refund.
- Progression currently makes high-volume wagering cheaper and raises limits. This rewards gambling intensity and is incompatible with the intended community ethos.
- Powerboard's wager-weighted tickets and rollover/headline-jackpot framing create concentration and chasing incentives.

The move to pari-mutuel accounting removes the original unlimited house-banked liability shape, but does not by itself prove conservation, claim solvency, dust handling, withdrawal liveness, or operational segregation.

## Canonical round envelope

Before the first bet, the contract emits and stores an immutable envelope:

```text
RoundEnvelope(
  protocolVersion,
  chainId,
  verifyingContract,
  implementationHash,
  rulesHash,
  roundId,
  betOpen,
  betClose,
  intentClose,
  targetBeaconNetworkHash,
  targetBeaconRound,
  safetyDelay,
  rtpNumerator,
  rtpDenominator,
  maxMultiplierBps,
  rakeBps,
  payoutMode,
  settlementAsset,
  limitsHash
)
```

The target beacon round is derived from `intentClose + safetyDelay`, not transaction time. No field may change after the first accepted bet. An envelope hash is displayed by the verifier and included in every signed intent.

Deterministic phases are:

```text
BETTING -> LIVE_INTENT -> SEALED_RANDOM_PENDING -> RESULT -> SETTLED
```

All betting ends before the randomness is public. Every economic cash-out target is bound before `intentClose`. There is no operator-selected retry or fallback beacon after observing a result.

## Target Lock

At bet placement, the player selects `targetBps`. The signed bet binds the envelope hash, stake, target, account, nonce, limits, and expiry. A win is determined only by:

```text
won = crashBps >= targetBps
```

Payout depends on the published payout rule and locked basis points—never client time, frame count, block interval, transaction position, or relayer timestamp. The round animation is a deterministic presentation of the envelope and result.

This is the unconditional reliability path and should be selected by default. It is the only path eligible for leaderboards or competitions.

## Live Lock: sealed intent

The instant button signs this EIP-712 message locally with a constrained session key:

```text
CashoutIntent(
  chainId,
  verifyingContract,
  rulesHash,
  envelopeHash,
  roundId,
  account,
  betNonce,
  targetBps,
  saltCommit,
  intentNonce,
  expiry
)
```

The stored commitment is `keccak256(intent, salt)`. Hiding the target until reveal prevents copied strategy while binding the player before the outcome. Failure to reveal cannot create value: it only forfeits that intent. The production-simple rule is one live intent per bet; replacement and cancellation after acceptance are forbidden. This removes ambiguous same-tick ordering and replacement races.

The client immediately freezes the displayed target as **Sending**, multicasts the signed ERC-4337 UserOperation to at least two independently operated providers plus the direct sequencer endpoint where supported, and reconciles all responses by canonical intent hash. Only onchain acceptance changes it to **Accepted by Robinhood Chain**.

Robinhood Chain currently documents first-come-first-served sequencing. That reduces fee bidding but does not remove the geographic/provider latency race. The protocol must not assume Robinhood will always use the same ordering policy.

### Optional witnessed fast path

A future receipt mesh may issue threshold receipts over:

```text
(intentHash, envelopeHash, monotonicTick, receiptEpoch, expiry)
```

An `n-of-m` bonded, independently operated witness set commits short-epoch Merkle roots before `intentClose`. A valid receipt creates the UI state **Witnessed**, not **Finalized**. Onchain economic authority should not depend on this system until its threshold assumptions, equivocation/slashing evidence, censorship behavior, liveness, and root timing are independently audited. A lone application-server timestamp is never authoritative.

Threshold receipts are an explicit trust layer, not “trustless instant settlement.” The safe initial release omits them.

## Randomness and outcome

Anyone may submit and verify the one predesignated drand result. Derive the game seed as:

```text
keccak256(
  "PLANK_SEALED_CRASH_V1",
  chainId,
  verifyingContract,
  implementationHash,
  rulesHash,
  roundId,
  targetBeaconNetworkHash,
  targetBeaconRound,
  verifiedBeaconSignature,
  verifiedBeaconRandomness
)
```

Use a full-width rejection-sampled integer transform, not `% 10000`. Specify exact inequalities, rounding direction, cap probability, and integer dust. Generate an exhaustive reference table and an independent verifier implementation from the same mathematical specification. Publish the cap-adjusted exact RTP; do not infer it from simulation.

No cash-out mutation is possible from `intentClose` through result. Once the designated beacon output exists, the result remains permissionlessly settleable forever and no refund path may supersede it. A deterministic source-wide beacon-failure refund may activate only after an absolute envelope deadline and only if no valid proof exists. A chain-halt escape path must preserve the same precedence.

## Session authorization

Session authorization is sponsor-paid and restricted to the exact chain, game contract, account, and bet/cash-out selectors. It includes `validAfter`, `validUntil`, maximum stake, aggregate session stake, loss, gas, round count, token allowlist, intent nonce range, device binding, and immediate owner revocation.

It cannot transfer arbitrary assets, call arbitrary recipients, approve tokens, withdraw funds, modify configuration, or survive revocation. Prefer audited ERC-4337 modular-account policies and wallet-supported delegated authorization. Private session material should be non-exportable WebCrypto material where the wallet permits it. The server never possesses a unilateral spending key.

Fuzz every selector, recipient, calldata length, token, value, nonce, boundary time, revoke race, and upgrade state.

## Solvency and accounting

Use separate accounting buckets, preferably separately permissioned contracts or vaults:

- withdrawable player principal
- open-round escrow
- settled claims
- jackpot liabilities
- protocol/community vault
- failed credits
- realized revenue

At every state transition:

```text
assets >= withdrawablePrincipal
        + openRoundEscrow
        + settledClaims
        + jackpotLiabilities
        + communityVaultLiabilities
        + failedCredits

distributable = committedPool - rake
sum(playerClaims) + deterministicDust = distributable
```

Snapshot every economic parameter before outcome availability. Claims are pull-based and cannot be blocked by another player's failure. Revenue becomes withdrawable only after all senior liabilities are reserved. Token accounting uses actual balance deltas, not router return values. Fee-on-transfer, rebasing, callback, decimal, zero-value, overflow, dust, duplicate-claim, and failed-native-transfer behavior must be explicitly rejected or proven.

A public `solvencyReport()` exposes assets and every liability bucket. Monitoring alerts before an invariant becomes false. Property tests prove conservation across arbitrary bet, result, claim, refund, pause, upgrade, and withdrawal sequences.

## Powerboard redesign

Do not sell better expected value or higher caps as a reward for cumulative wagering. Replace wagering progression with **Proof of Contribution**, a non-economic community reputation earned through moderation, verified bug reports, verifier operation, education, art/community quests, and governance participation. It may unlock cosmetics and recognition, never cheaper gambling or increased loss capacity.

Powerboard should use equal-priced, clearly bounded entries rather than wager-weighted tickets. Publish the exact pool split, probability model, rake, rollover treatment, and maximum liability before purchase. Avoid near-miss presentation, “almost won,” losses disguised as wins, urgency countdown manipulation, and jackpot-chasing copy. If rollover remains, cap it and route excess by a precommitted community rule rather than operator discretion.

## Player protection as protocol behavior

Required controls are not dismissible modals:

- deposit, spend, loss, session-time, and round-count limits with cooling-off periods for increases
- immediate limit decreases
- self-exclusion and account closure enforced across contracts, relayers, and UI
- one active wagering session per account
- no autoplay, turbo rebet, or one-click loss chasing
- periodic reality checks showing elapsed time, net deposits, stakes, wins, losses, and available withdrawal
- a reflection interval after a loss or limit boundary
- a persistent withdraw/bank-winnings action
- free-play rules, pace, and probabilities identical to paid play
- no wagering-volume pricing, VIP risk expansion, near misses, celebratory losses, or dark-pattern urgency

Accessibility includes reduced motion, pause/stop controls, no unsafe flashing, non-color status cues, keyboard and screen-reader operation, and a readable proof ledger.

## UX state machine

```text
DISCONNECTED
  -> SYNCING_CLOCK
  -> SPECTATING_OPEN
  -> SESSION_AUTH_REQUIRED
  -> SESSION_READY
  -> EDITING_TARGET
  -> SUBMITTING
  -> ACCEPTED_UNFINALIZED
  -> LOCKED
  -> ROUND_RUNNING
  -> AUTO_CASHOUT_ELIGIBLE | LIVE_CASHOUT_REQUESTED | CRASHED
  -> WON | LOST | VOIDED | REFUND_AVAILABLE
  -> CLAIM_PENDING
  -> SETTLED
```

Exceptional states are `REJECTED_LATE`, `REJECTED_LIMIT`, `REJECTED_BALANCE`, `UNKNOWN`, `REORGED`, `MISSED_BOUNDARY`, `CONNECTION_DEGRADED`, and `RANDOMNESS_DELAYED`. Every state carries round/envelope, sequence number, observed block/tick, transaction or intent hash, source, and confidence. State transitions are monotonic except an explicit reorg transition.

Animation prediction may smooth the curve, but authoritative snapshots reconcile the presentation. A prediction correction changes only visuals, never the signed target. There is no green win treatment or confetti for pending, submitted, or merely witnessed actions.

## Operational architecture

- Read APIs are side-effect-free. Writes use authenticated, idempotent commands with canonical identifiers.
- Bound all scans before database/API work; cursor every history surface.
- Separate source, deployed, verified, and runtime-observed states.
- Production configuration is explicit and fail-closed. No permissive deploy defaults.
- Runtime checks prove chain ID, bytecode hash, implementation, rules hash, beacon network, relayer policy, and treasury destinations.
- Relayers use canonical intent IDs, idempotency keys, replay protection, bounded queues, deadlines, circuit breakers, and graceful process shutdown.
- A supervisor owns exactly one worker generation, persists PID/port ownership, terminates descendants on restart, and rejects duplicate starts. Track process count, handles, heap, event-loop lag, sockets, queue depth, and restart reason.
- Provider diversity means different operators and network paths, not two URLs backed by one vendor.
- Retain immutable proof bundles: envelope, signed bet/intent, acceptance evidence, beacon proof, outcome transform inputs, settlement transaction, and accounting deltas.

## Machine-verifiable invariants

1. Envelope fields cannot change after the first accepted bet.
2. The beacon target is a deterministic envelope function and is due after `intentClose + safetyDelay`.
3. Differing chain, contract, rules, round, or beacon target always yields a different seed.
4. Every intent signature binds exact chain, contract, rules, envelope, player, bet, target, nonce, and expiry.
5. Every nonce is single-use and every target is inside published bounds.
6. Permuting accepted intent transactions produces identical winners and liabilities.
7. No create, replace, cancel, or economically meaningful reveal occurs after `intentClose`.
8. Payout never depends on client time, relayer time, block number, transaction position, or animation.
9. No outcome mutation occurs between intent close and verified result.
10. Exactly one beacon network and round can settle a game.
11. Verified randomness permanently disables refund/void alternatives.
12. Session authority cannot escape its selector, asset, value, time, round, loss, or revocation bounds.
13. Assets cover all senior liabilities and claims plus dust equal the distributable pool.
14. A user's withdrawal/claim liveness is independent of other users.
15. UI labels correspond to observed proof and never advance on a timeout alone.

## Release evidence ladder

No real-money launch until all levels pass:

1. mathematical specification and independently reproduced RTP/liability tables
2. executable reference verifier and public proof-bundle format
3. unit, property, invariant, fuzz, differential, and state-machine tests
4. adversarial sequencing, delayed inclusion, reorg, provider disagreement, beacon delay, and chain-halt simulations
5. session-key escape and account-upgrade security review
6. independent smart-contract audit with all findings and exact commit provenance
7. economic/mechanism review including whales, collusion, griefing, dust, and withdrawal runs
8. responsible-gambling and accessibility review
9. jurisdiction-specific licensing, geofencing, age/KYC/AML, sanctions, tax, privacy, and customer-funds approval
10. testnet canary with published SLOs, incident drills, monitoring, pause/refund runbooks, and a time-bounded bug bounty

Audits attach to exact source commits and deployed bytecode. A CI badge is not audit provenance. Production remains paused if runtime verification disagrees with source or configuration.

## Staged delivery

### Stage 0 — specification and proof

Freeze the current production path. Implement the reference math, envelope encoder, verifier, invariants, accounting model, threat model, and deterministic vectors. Remove false probability/RTP claims.

### Stage 1 — Target Lock testnet

Ship only precommitted target lock, permissionless drand proof submission, pull claims, proof ledger, limits, accessibility, and solvency reporting. No live cash-out and no real money.

### Stage 2 — Live Lock testnet

Add constrained session authorization, redundant broadcast, proof-state UI, provider fault injection, reorg handling, and missed-deadline behavior. Live mode remains unranked.

### Stage 3 — independently approved production

Launch only after the evidence ladder, licensing gates, and runtime verification pass. Start with conservative pool/round/account limits. Publish incidents and verifier data.

### Stage 4 — research only

Evaluate bonded threshold receipts or a future-beacon tick ladder. Neither belongs in the trusted production core until its additional assumptions and economics outperform the simpler target-lock protocol under adversarial review.

## Critically audited source map

Primary specifications and platform documentation carry the most weight; academic work supplies adversarial models; industry standards supply test and control expectations; forums and Hacker News supply failure reports and practitioner skepticism, not normative truth.

### Chain execution and account authorization

- [Robinhood Chain overview](https://docs.robinhood.com/chain/) — current EVM/Arbitrum architecture and documented FCFS ordering.
- [Robinhood Chain connectivity](https://docs.robinhood.com/chain/connecting/) — direct sequencer/WebSocket endpoints and chain configuration.
- [Arbitrum Nitro whitepaper](https://docs.arbitrum.io/nitro-whitepaper.pdf) — sequencer feed, delayed inbox, ordering, and finality model.
- [Arbitrum Timeboost research discussion](https://forum.arbitrum.foundation/t/transaction-ordering-policies-value-accrual-in-l2s-timeboost-op-pga-fastlane-oev-network-ardc-research-deliverables/26771) — why FCFS remains a latency race and ordering policy can change incentives.
- [Empirical Timeboost study](https://arxiv.org/abs/2509.22143) and [latency racing versus bidding](https://arxiv.org/abs/2306.02179) — measurements and mechanism tradeoffs.
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) — UserOperations, bundlers, paymasters, nonce, and replay-domain requirements.
- [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) — scoped permissions, expiry/revocation, and phishing risk.
- [OpenZeppelin account contracts](https://docs.openzeppelin.com/contracts/5.x/api/account) — modular account/signature primitives; reuse does not replace an audit.
- [Hacker News: Arbitrum outage/rollback discussion](https://news.ycombinator.com/item?id=34391559) — useful incident perspective; anecdotal rather than authoritative.

### Randomness and ordering fairness

- [drand protocol specification](https://docs.drand.love/docs/specification/) — beacon verification and time/round mapping.
- [drand timelock encryption](https://docs.drand.love/docs/timelock-encryption/) — threshold assumptions and future randomness properties.
- [Pyth Entropy design](https://docs.pyth.network/entropy/protocol-design) — unusually candid provider censorship, front-running, and hash-chain assumptions.
- [Chainlink VRF](https://chain.link/vrf) — alternative proof-based oracle model; vendor material must be independently threat-modeled.
- [SoK: decentralized randomness beacons](https://arxiv.org/abs/2205.13333) — comparative academic threat model.
- [SoK: fair message ordering](https://arxiv.org/abs/2411.09981) and [order-fair consensus](https://eprint.iacr.org/2021/139.pdf) — limits and definitions of fair ordering.
- [Threshold-encrypted mempools with preconfirmations](https://ethresear.ch/t/threshold-encrypted-mempools-with-mev-commit-preconfirmations/23588) — proposed receipt/encryption approach and its economic enforcement limits.
- [Road toward distributed encrypted mempools](https://ethresear.ch/t/the-road-towards-a-distributed-encrypted-mempool-on-ethereum/21717/1) — practitioner comparison of TEE, FHE, timed-crypto, and keyper tradeoffs.

### Gambling integrity, economics, and player safety

- [UK Gambling Commission RTS](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/3-remote-gambling-and-software-technical-standards) and [RTS 4 time-critical events](https://www.gamblingcommission.gov.uk/manual/remote-gambling-and-software-technical-standards/rts-4-time-critical-events) — latency disclosure and technical controls.
- [UKGC customer-funds segregation guidance](https://www.gamblingcommission.gov.uk/guidance/customer-funds-segregation-disclosure-to-customers-and-reporting/introduction-customer-funds-segregation-disclosure-to-customers-and) — liability segregation expectations; jurisdiction-specific legal advice remains necessary.
- [GLI-19 Interactive Gaming Systems](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf) — laboratory control and testing baseline.
- [NCPG Internet Responsible Gambling Standards](https://www.ncpgambling.org/wp-content/uploads/2024/01/Internet-Responsible-Gambling-Standards-Rev.-12-2023-FINAL.pdf) — player-control and intervention practices.
- [Speed/frequency and gambling harm study](https://pmc.ncbi.nlm.nih.gov/articles/PMC9981537/) — evidence relevant to pace and friction decisions.
- [Systematic review of near-miss effects](https://pmc.ncbi.nlm.nih.gov/articles/PMC5663799/) — basis for rejecting near-miss manipulation.
- [High rollers in pari-mutuel wagering](https://arxiv.org/abs/1605.03653) — concentration and strategic-participant concerns.
- [Hacker News: provably fair gambling discussion](https://news.ycombinator.com/item?id=5303758) — early community critique and threat brainstorming; not proof of safety.

### Realtime UX and accessibility

- [Unity client prediction](https://docs.unity.cn/Packages/com.unity.netcode%401.5/manual/intro-to-prediction.html), [Photon simulation loop](https://doc.photonengine.com/fusion/v2/concepts-and-patterns/network-simulation-loop), and [Colyseus netcode](https://docs.colyseus.io/netcode) — prediction/reconciliation patterns; financial state needs stricter confirmation than game motion.
- [Riot VALORANT netcode](https://www.riotgames.com/en/news/peeking-valorants-netcode) — latency and fairness engineering from competitive games.
- [Hacker News optimistic UI discussion](https://news.ycombinator.com/item?id=35626706) — practitioner failure cases and user-expectation concerns.
- [WCAG 2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) and [Three Flashes](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html) — minimum motion and flashing safeguards.

## Unresolved research questions

- Exact capped inverse-CDF and pari-mutuel payout rule that maximizes clarity while satisfying the chosen RTP and dust constraints.
- Whether sealed target privacy materially improves play or merely adds reveal/liveness complexity; target-at-bet is safer for first release.
- Whether Robinhood Chain offers a durable, cryptographically accountable preconfirmation primitive beyond documented sequencer access.
- Formal parameters for beacon safety delay under clock skew, network delay, and source availability.
- Jurisdiction-specific treatment of pari-mutuel crash, lottery/community pools, tokens, and non-custodial interfaces.
- Whether any fast receipt mesh can provide enough independent operation and slashable collateral to justify its complexity.

Until those questions have reproducible answers, the safe product is Target Lock on testnet with transparent proofs—not a real-money promise of instantaneous live settlement.
