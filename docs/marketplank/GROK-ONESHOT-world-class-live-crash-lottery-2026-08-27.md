# Grok one-shot: independently research and invent the world's strongest live crash game and community lottery

You have **zero prior conversation context**. Treat everything below as the complete handoff for an independent, adversarial research and invention assignment. Do not assume our current design is correct. Do not flatter it, rubber-stamp it, or merely restate this brief. Attempt to outperform it.

## Mission

Design an end-to-end, implementation-ready architecture for a real-time crash game and community lottery on Robinhood Chain that feels as immediate and polished as an excellent multiplayer video game while remaining mathematically exact, economically solvent, cryptographically auditable, operationally resilient, accessible, and responsible.

The defining interaction is a live **LOCK / CASH OUT** button. The player sees a rising multiplier and wants the selected multiplier to lock instantly. The hard problem is that Robinhood Chain is a centrally sequenced Arbitrum-derived L2: a browser click, RPC acknowledgment, relayer receipt, sequencer acceptance, L2 soft confirmation, and L1-anchored finality are different events. Invent the best honest solution. Do not call something trustless, final, fair, or instantaneous unless its assumptions actually prove that claim.

Research globally and currently. Search primary standards, official protocol documentation, deployed systems, open-source implementations, security audits, incident reports, postmortems, academic papers, cryptography and mechanism-design literature, gambling laboratory standards, regulators, responsible-gambling research, accessibility standards, game-netcode engineering, Ethereum Research, protocol governance forums, Hacker News, security communities, and skeptical practitioner discussions. Seek contradictory evidence and failed designs—not just supportive citations.

Your answer must produce original synthesis and, where prior art is insufficient, genuinely new mechanisms. Clearly distinguish:

- a proven existing primitive;
- a novel combination of proven primitives;
- a speculative invention requiring validation;
- a claim that cannot be honestly achieved under the platform assumptions.

## Real project context

The application is Plank, a community/NFT/market platform. The game contracts are Solidity with a Next.js/TypeScript client and Hardhat tests. The intended settlement chain is Robinhood Chain, documented as an EVM-compatible Arbitrum Dedicated Chain with first-come-first-served sequencing at the time of this brief. The chain exposes normal RPC, WebSocket/sequencer feeds, and a direct sequencer endpoint. First-come-first-served does **not** eliminate network latency, censorship, geographic advantage, downtime, rollback, or a future ordering-policy change.

The current principal contract is `contracts/PlankCrashDrand.sol`. Related implementations include `PlankCrashEntropy.sol`, `PlankCrashVRF.sol`, `PlankCrashV2.sol`, `PlankBank.sol`, `PlankPowerboard.sol`, and progression/fuel contracts. Current crash is pari-mutuel rather than an unlimited house-banked multiplier liability. Players bet, a round locks, drand randomness determines a crash point, cash-out positions determine winners, and winners share the distributable pool by payout weight.

Do not assume deployed production safety. This is a design and audit target. Real-money release is blocked until mathematical, technical, security, responsible-play, regulatory, and operational gates are proven.

## Confirmed defects and disputed mechanics to independently verify

Audit these claims against the code/mechanism and determine their exact severity:

1. `lockRound()` selects `targetDrandRound = beacon.nextRoundAfter(block.timestamp) + 20`. The beacon target is therefore chosen at lock rather than immutably committed before bets begin. It may remain future/unknown, but timing and terms are still lock-caller/sequencer selected.
2. Live and preset cash-out are represented through `cashOutBlockOf`; the multiplier is inferred from elapsed L2 blocks. L2 block cadence and transaction inclusion are not a neutral game clock.
3. Manual `cashOut()` records inclusion block. It therefore provides inclusion-order fairness, not click-time fairness, and is exposed to provider/sequencer delay, censorship, and ordering.
4. `presetCashOut()` immediately stores a synthetic future block derived from a public target. It is safer than a live click but is not a private timed standing order.
5. Cash-outs correctly freeze once the designated beacon is due but not yet revealed. Preserve the security purpose: nobody may exploit known-offchain but unrevealed-onchain randomness.
6. `_deriveCrash(bytes32)` maps randomness through `% 10000`, then treats `r == 0` as instant crash and otherwise resembles `10000 * 10000 / (10000-r)`. The instant-crash probability is therefore 1/10,000—not a claimed 1%—and the distribution has only 10,000 buckets. Caps and integer rounding obscure exact RTP.
7. Raw shared randomness is used without complete domain separation across chain, verifying contract, implementation/rules version, game round, and target beacon network/round.
8. `voidStaleRound()` uses a block-count liveness path. If designated randomness exists but no one submits it, an eventual operator/player choice between settle and void may become strategically valuable. Valid designated randomness should normally dominate forever.
9. Pari-mutuel accounting prevents one form of uncapped house insolvency but does not automatically prove conservation, dust allocation, segregated liabilities, claim liveness, withdrawal liveness, token behavior, or upgrade safety.
10. Progression reduces premiums and raises caps as cumulative wager volume rises. That rewards gambling intensity and gives heavier gamblers better economic terms.
11. Powerboard uses wager-linked/wager-weighted ticket mechanics and rollover/headline-jackpot framing, creating whale concentration and chasing incentives.
12. Any durable wallet mutation must have precise authorization and replay controls. Public GET requests must not write. Work must be bounded before database/API scans. Identifiers must be canonical. Token value received must use actual balance deltas rather than router return values. Production configuration must be explicit and fail closed. Persisted truth must dominate cosmetic UI state. Source, deployed bytecode, verification, and runtime-observed configuration are separate states.

## Candidate architecture you must try to defeat

We have one internally proposed design. Treat it only as a benchmark. Find counterexamples, incentive failures, hidden trust, UX failures, gas problems, privacy problems, legal problems, and simpler superior alternatives.

### Candidate: dual execution lanes

- **Target Lock**: the default, ranked lane. A player precommits an automatic cash-out target before randomness can be known. It remains operative through browser/RPC failure.
- **Live Lock**: a separately labeled, unranked, latency-sensitive lane. A player signs a multiplier intent locally during the live phase and multicasts it to independent bundlers/RPC endpoints/direct sequencer. It counts only if accepted before a deterministic intent deadline.
- The UI distinguishes **Chosen locally**, **Sending**, optionally **Witnessed**, **Accepted by chain**, and **Settled**. Animation can be optimistic; money cannot be falsely confirmed.

### Candidate: immutable round envelope

Before the first bet, commit:

```text
(protocolVersion, chainId, verifyingContract, implementationHash, rulesHash,
 roundId, betOpen, betClose, intentClose, targetBeaconNetworkHash,
 targetBeaconRound, safetyDelay, exactRTP, multiplierCap, rake,
 payoutMode, settlementAsset, limitsHash)
```

Derive the beacon target only from the immutable schedule, not the lock transaction. Use phases:

```text
BETTING -> LIVE_INTENT -> SEALED_RANDOM_PENDING -> RESULT -> SETTLED
```

### Candidate: sealed live intent

Sign a narrowly scoped EIP-712 object:

```text
CashoutIntent(chainId, verifyingContract, rulesHash, envelopeHash,
 roundId, account, betNonce, targetBps, saltCommit, intentNonce, expiry)
```

Commit `keccak256(intent, salt)` before randomness. Reveal afterward. A losing player who withholds reveal receives nothing. Use one live intent per bet to avoid replacement-order ambiguity. Settlement is `won iff crashBps >= targetBps`; economic payout never depends on frames, browser time, relayer time, block cadence, or transaction position.

### Candidate: constrained session authorization

Use ERC-4337-style UserOperations and audited modular-account policies. Scope authority to exact chain, account, game, selectors, token, nonce range, validity interval, stake/session/loss/gas/round caps, with owner revocation. It cannot transfer arbitrary assets, approve, withdraw, configure, upgrade, or call arbitrary recipients. Multicast to provider-diverse infrastructure. No server holds unilateral spending power.

### Candidate: optional receipt mesh

An `n-of-m` set of independent bonded witnesses could issue threshold receipts over `(intentHash, envelopeHash, monotonicTick, receiptEpoch, expiry)` and anchor short-epoch Merkle roots before randomness/deadline. This would create a fast **Witnessed** state under explicit threshold-honesty and slashing assumptions. It is **not** chain finality and a lone app-server timestamp is never authoritative. Determine whether this mechanism can ever be worthwhile, safely authoritative, or economically sustainable—or reject it.

### Candidate: randomness

Use one predetermined drand network/round and domain-separate:

```text
keccak256("PLANK_SEALED_CRASH_V1", chainId, verifyingContract,
 implementationHash, rulesHash, roundId, targetBeaconNetworkHash,
 targetBeaconRound, verifiedBeaconSignature, verifiedBeaconRandomness)
```

Use a full-width exact integer transform with rejection sampling, specified rounding and cap, exact analytical RTP, public vectors, and an independent verifier. Anyone can submit the proof. Once valid designated randomness exists, it permanently defeats void/refund. Only a deterministic source-wide failure path may refund after an absolute deadline.

### Candidate: solvency and community safety

Maintain segregated buckets for withdrawable principal, open-round escrow, settled claims, jackpot liability, community vault liability, failed credits, and realized revenue. Prove continuously:

```text
assets >= withdrawablePrincipal + openRoundEscrow + settledClaims
        + jackpotLiabilities + communityVaultLiabilities + failedCredits

distributable = committedPool - rake
sum(claims) + deterministicDust = distributable
```

Replace wagering-volume progression with non-economic **Proof of Contribution** reputation for moderation, verified bugs, verifier operation, education, art/community work, and governance. Equal gambling price/risk for all. Add enforceable deposit/spend/loss/time/round limits, cooling-off periods, self-exclusion, reality checks, no autoplay/turbo rebet, no near misses/losses-disguised-as-wins, accessible reduced-motion presentation, and a persistent withdrawal path.

## Questions your research must answer

### 1. Can live lock ever be both instant and fair?

Compare at least:

- preset target orders;
- normal L2 transactions and direct sequencer submission;
- ERC-4337 bundlers/paymasters and session keys;
- sequencer preconfirmations;
- threshold/bonded receipt networks;
- encrypted mempools and threshold encryption;
- trusted execution environments;
- fair-ordering consensus;
- commit/reveal or sealed-bid designs;
- future-beacon tick ladders;
- state channels or game-specific rollups;
- intent protocols/solvers;
- authoritative server execution with onchain escrow and retrospective proofs;
- any better mechanism you invent.

For each, state latency, finality, censorship assumptions, reorg behavior, trust set, privacy, gas, mobile-wallet UX, liveness, griefing, MEV, capital/slashing needs, and whether it truly improves over target-at-bet.

Resolve the core semantic question: what exactly does “my multiplier locked instantly” mean, who can prove it, and what happens if each subsystem fails one millisecond before or after the boundary?

### 2. What is the optimal crash mechanism?

Derive a complete mathematical model:

- crash distribution and inverse CDF;
- exact RTP before and after cap/rounding;
- instant-crash semantics;
- multiplier granularity;
- pari-mutuel payout weights and whether target-multiplier weighting is incentive compatible;
- rake, dust, unclaimed winnings, empty/one-player rounds, ties, whales, sybils, collusion, late information, and pool manipulation;
- bankroll/escrow behavior;
- whether pari-mutuel crash remains intuitive enough for users;
- alternative market designs that are more legible and safer.

Supply executable pseudocode, integer formulas, example vectors, and property/invariant statements. Identify every distribution bias introduced by modulo, truncation, cap, rejection sampling, fixed-point math, or gas optimization.

### 3. What is the strongest randomness/liveness architecture?

Compare drand, Chainlink VRF, Pyth Entropy, commit/reveal, block/prevrandao sources, threshold beacons, hybrid sources, and any emerging 2025–2026 systems. Address withholding, source compromise, provider censorship, fallback shopping, proof cost, chain support, beacon/network upgrades, clock mapping, future-round commitment, and permanent settlement.

Do not propose a fallback chosen after observing any candidate outcome. If combining sources, specify the exact combiner and prove which assumptions it improves or worsens.

### 4. How should Powerboard/community lottery work?

Determine whether it is legally/mechanically a lottery, raffle, sweepstakes, pari-mutuel pool, or another category in likely jurisdictions—and do not give definitive legal advice without jurisdiction and counsel. Design a community-aligned mechanism that avoids whale dominance, wagering escalation, rollover chasing, opaque odds, discretionary prize handling, and fake “community” extraction.

Explore equal-entry, capped-entry, quadratic, proof-of-personhood, contribution-based free entry, non-transferable eligibility, periodic distributions, public-goods splits, and no-purchase alternatives. Analyze sybil resistance, privacy, accessibility, collusion, and regulatory consequences. Propose the best mechanism or conclude it should not exist.

### 5. What is the ideal realtime game UX?

Research multiplayer prediction/reconciliation, exchange order status, payment certainty, competitive game netcode, optimistic UI failure modes, animation accessibility, gambling-interface dark patterns, and player comprehension.

Produce an exact state machine covering disconnected, clock synchronization, spectating, session authorization, target editing, submission, witness/preconfirmation, chain acceptance, reorg, round running, crash, win/loss/void/refund, claim, and settlement. Every state must carry source and confidence. Define exact button labels, color/motion/audio rules, copy, degraded-mode behavior, and mobile/wallet recovery. No confetti or financial victory styling before settlement evidence.

### 6. How do we prove solvency and safe withdrawals?

Design storage/accounting, priority of claims, escrow segregation, fee recognition, pull payments, dust, failed credits, token edge cases, pause/upgrade rules, emergency exits, public solvency reports, monitoring, and invariant tests. Analyze insolvency runs, reentrancy, griefing, malicious tokens, fee-on-transfer/rebasing assets, callback paths, compromised admins, oracle failure, and chain halt.

### 7. What must responsible design prohibit or require?

Use current peer-reviewed evidence and regulatory/standards material to determine appropriate pace, friction, limits, self-exclusion, cooldowns, reality checks, marketing language, leaderboards, social features, loss presentation, near misses, autoplay, VIP treatment, free-play parity, minors, KYC/AML/sanctions, geofencing, privacy, and customer-funds treatment.

Explicitly challenge engagement/retention mechanics when they increase harm. “Community” does not excuse exploitative mechanics.

### 8. How does this survive production operations?

Cover redundant providers, canonical identifiers, idempotency, queues, bounded work, backpressure, retries, circuit breakers, chain reorgs, clock skew, process ownership, Node.js worker leaks, graceful shutdown, duplicate supervisors, database connection limits, telemetry, incident response, proof retention, deterministic replay, upgrades, governance, key rotation, disaster recovery, and runtime bytecode/config verification.

Define SLOs and alerts for submission latency, acceptance latency, deadline misses, provider disagreement, clock error, beacon delay, settlement delay, solvency margin, claim failures, process count, handle/socket growth, heap, event-loop lag, queue depth, and restart storms.

## Source requirements

Research must be current as of the date you perform it. At minimum, investigate and critically compare:

- Robinhood Chain official architecture, connectivity, governance, sequencing, gas sponsorship, and finality documentation;
- Arbitrum Nitro, delayed inbox/force inclusion, sequencer feeds, Timeboost/current ordering governance, outages, and rollback history;
- ERC-4337, ERC-7702, ERC-7715, ERC-7579 or current successors, wallet support, bundlers, paymasters, delegated/session authorization, and known vulnerabilities;
- drand specification, network upgrades, threshold assumptions, timelock work, onchain verification, and incidents;
- Chainlink VRF and Pyth Entropy protocol/security assumptions;
- decentralized randomness and fair-ordering academic surveys;
- preconfirmations, encrypted mempools, MEV, fair sequencing, and latency-racing research;
- provably fair crash/online casino implementations and their known failures;
- pari-mutuel and lottery mechanism-design literature;
- UKGC remote technical standards including time-critical events, responsible product design, customer funds, and security;
- GLI-19 and other credible gaming laboratory standards;
- NCPG or equivalent responsible online-gambling standards;
- peer-reviewed studies on game speed, near misses, losses disguised as wins, dark patterns, and gambling harm;
- WCAG 2.2 motion/flashing/cognitive requirements;
- realtime networking literature and public engineering from Riot, Valve, Unity, Photon, Colyseus, exchanges, or payment systems;
- smart-contract security guidance, audits, exploit postmortems, formal verification, invariant/property testing, and upgrade governance;
- Ethereum Research, Arbitrum governance forums, security forums, Hacker News, and other practitioner communities for counterexamples and lived failures.

Use primary sources for factual behavior. Academic papers should be read, not cited from snippets. Vendor claims require corroboration. Forum and Hacker News material may identify failure modes but is not authoritative proof. Include publication/update dates, direct links, and note source conflicts, incentives, sample limitations, outdated assumptions, and retracted/weak evidence.

## Required deliverable

Return one cohesive report containing:

1. **Executive verdict** — the best architecture and the claims it can/cannot honestly make.
2. **Critical audit of the current system** — severity, exploit/failure scenario, evidence, and remedy for every finding.
3. **Prior-art matrix** — mechanisms/products/papers, guarantees, assumptions, failures, costs, and relevance.
4. **Adversarial critique of the candidate architecture** — attempt to break every component and identify unnecessary complexity.
5. **Your superior invented design** — name it; specify actors, trust model, contracts, data structures, messages, phases, state transitions, algorithms, and failure recovery.
6. **Exact economics** — formulas, worked examples, RTP, cap/rounding/dust, liabilities, whale/sybil/collusion analysis, and incentive compatibility.
7. **Exact execution protocol** — typed messages, domain separation, nonces, deadlines, replacement/cancellation rules, receipts, ordering, settlement, and reorg behavior.
8. **Exact randomness protocol** — source choice, verification, timing, failure, upgrade, and no-result-shopping proof.
9. **Powerboard redesign** — or a reasoned recommendation to remove it.
10. **UX specification** — statechart, proof labels, wire-level-to-visual mapping, degraded mode, accessibility, and responsible-play interactions.
11. **Solvency/accounting specification** — storage buckets, invariants, withdrawal precedence, public report, and adversarial sequences.
12. **Security and formal verification plan** — properties, fuzz domains, differential tests, model checking, threat actors, audit scopes, and reproducible deployment provenance.
13. **Operational design** — services, process model, provider redundancy, telemetry, SLOs, incident/runbook behavior, and cost estimates at small/medium/large load.
14. **Legal/responsible-release gates** — jurisdiction-dependent questions and controls that block launch.
15. **Phased implementation roadmap** — safest minimal testnet version through any justified fast path, with kill criteria and rollback paths.
16. **Residual-risk register** — severity, probability, detectability, blast radius, mitigation, owner, and explicit accepted assumptions.
17. **Claim-evidence table** — every proposed marketing/security claim mapped to the evidence required before it may be made.
18. **Bibliography/source audit** — diverse direct links, dates, credibility class, conflicts, and exactly which design decision each source supports or challenges.

For the invented protocol, include Solidity-like interfaces, EIP-712 schemas, event definitions, storage layout, TypeScript client pseudocode, relayer pseudocode, public verifier pseudocode, and representative invariant/property tests. Mark all unverified pseudocode as such.

## Quality bar

- Do not answer with generic “use VRF, audits, and rate limits.”
- Do not optimize visual excitement at the expense of financial truth.
- Do not hide trust inside a sequencer, relayer, witness, wallet, oracle, admin, upgrade key, frontend, RPC, or timestamp.
- Do not assume two endpoints are independent merely because they have different URLs.
- Do not assume cryptographic fairness implies economic fairness, solvency, legal permission, responsible design, liveness, or usable UX.
- Do not recommend live real-money deployment merely because tests pass.
- Quantify latency, probabilities, caps, gas, costs, thresholds, timeouts, and failure windows wherever possible.
- If a superior result is impossible under the constraints, prove the impossibility boundary and design the least misleading experience.
- Prefer the smallest mechanism whose guarantees are understandable and testable. Complexity must buy a measurable guarantee.
- End with the strongest counterargument against your own recommended design and the experiment or proof that could falsify it.

The goal is not a persuasive concept document. The goal is a critically sourced blueprint that expert cryptographers, game economists, smart-contract auditors, regulators, accessibility specialists, realtime engineers, and skeptical players could independently challenge and reproduce.
