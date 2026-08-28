# Grok one-shot: exhaustive adversarial research and invention for Plank's pari-mutuel crash, perpetual Vault, and Powerboard

You have **zero prior conversation context**. This document is the complete assignment. Perform your own current research and attempt to produce a superior mechanism—not an endorsement, paraphrase, or stylistic rewrite of this brief.

## Mission

Design, attack, formally analyze, and improve a novel community economy combining:

1. a live multiplayer crash game;
2. bounded pari-mutuel settlement rather than a house bankroll;
3. a perpetual community Vault that fractionally seeds future rounds;
4. capture of objectively all-busted round pools into that Vault;
5. rake recirculation into the Vault;
6. capped Vault overflow into a rolling community lottery called Powerboard;
7. optional token-burning “fuel” that releases separately prefunded ETH into the communal Vault;
8. ranking, fees, stake limits, player protections, and community reputation;
9. instant-feeling realtime interaction without lying about blockchain acceptance.

The result must be mathematically conserved, strategically defensible, sybil-aware, cryptographically verifiable, operationally live, comprehensible to ordinary players, accessible, responsible, and honest about legal uncertainty.

Do not replace this system with a conventional house-backed fixed-multiplier game. A proposal that promises `stake × multiplier` from an operator bankroll is a regression unless included solely as a comparison proving why it is inferior for this project.

## Non-negotiable economic identity

The protected kernel is:

```text
roundGross    = vaultSeed + Σ netPlayerStakes
roundRake     = published deterministic function of roundGross
distributable = roundGross - roundRake

weight_i = survived_i
         ? floor(stake_i × weightFunction(lockedTarget_i))
         : 0

payout_i = floor(distributable × weight_i / totalWinningWeight)
```

The current candidate uses:

```text
weightFunction(targetBps) = targetBps / 10_000
survived_i = lockedTargetBps_i <= crashBps
```

A 1,000,000× target never creates a 1,000,000× liability. It changes only the allocation of a fixed pool. Aggregate claims must never exceed `distributable`.

You may propose a superior `weightFunction`, rake function, seed-release function, or eligibility function, but you must:

- preserve bounded aggregate liability;
- prove conservation;
- quantify strategic effects;
- explain player-facing semantics;
- compare it against the current formula;
- identify who gains and loses under the change;
- never conceal a house credit line inside a “Vault.”

## Current system architecture

The implementation is Solidity on Robinhood Chain, an Arbitrum-derived centrally sequenced EVM L2. The client is Next.js/TypeScript. Randomness is currently obtained from a shared onchain drand beacon cache using the `evmnet` BN254 network.

Principal contracts:

- `contracts/PlankCrashDrand.sol`
- `contracts/PlankPowerboard.sol`
- `contracts/PlankProgression.sol`
- `contracts/PlankFuelBooster.sol`
- `contracts/PlankBank.sol`
- `contracts/DrandBeacon.sol`

Related variants include `PlankCrashV2.sol`, `PlankCrashVRF.sol`, and `PlankCrashEntropy.sol`.

### Current Vault loop

The Vault reserve receives:

- a configured share of net round rake;
- the distributable pool from objectively fully busted rounds;
- direct donations/sponsorship;
- bounded ETH released from a separately prefunded fuel-booster pool after users burn `$PLANK`;
- progression premiums.

Each new round draws only a strict fraction:

```text
seed = floor(reserve × seedNumerator / seedDenominator)
0 < seedNumerator < seedDenominator
```

An optional absolute floor further limits the draw. The remaining reserve stays positive arithmetically when it began positive. When reserve exceeds `reserveCap`, the excess is transferred best-effort into Powerboard. A failed Powerboard call leaves the excess in the Vault rather than blocking the crash game.

### Current crash allocation

The round pool contains the Vault seed and player stakes. After the crash result, winning players receive pro-rata shares according to:

```text
weight = stake × cashoutMultiplier
```

The player-facing multiplier is therefore a strategic pool-weight target, not a guaranteed posted payout. A survivor may receive less than stake when survivors are crowded or more than the nominal target when they are unusually dominant in a seeded pool.

### Current Powerboard

Powerboard is a fixed-schedule rolling jackpot funded by designated inflows, including Vault overflow. Existing allowed game stakes produce linearly wager-weighted ticket ranges. Every epoch selects:

- a winning ticket;
- a separate “Plank Ball.”

If the ball hits, the ticket owner receives the jackpot; otherwise they receive a consolation share and the remainder rolls over. A configured must-hit interval can force a full payout. A bounded permissionless drawer reward incentivizes settlement.

### Current progression

Current progression grants higher cumulative-wager ranks lower entry premiums and higher absolute stake caps:

```text
Sapling:      15% premium above exemption; 0.02 ETH cap
Stick:        10%;                         0.05 ETH
Board:         6%;                         0.10 ETH
Plank:         3%;                         0.25 ETH
Big Beam:      1%;                         0.50 ETH
Wooden Whale:  0%;                         no rank absolute cap
```

The crash contract separately enforces a relative maximum stake as a share of player-contributed pool and rechecks the largest individual stake against the final pool at lock. It also enforces minimum participants and minimum pool size.

Small bets at or below an exemption threshold pay no progression premium. Rank is address-based and uses rounds, cumulative wager, tenure, fuel burns, and Powerboard claims.

## Confirmed or strongly suspected issues

Independently verify every claim. Do not assume this list is complete.

### Settlement and conservation

1. Current winning weight is accumulated only when `registerResult(roundId, player)` is called during a bounded registration window.
2. Permissionless registration on behalf of users helps but does not prove every winner was registered.
3. Claims divide by registered winning weight, so omitted winners may enlarge other payouts.
4. `sweepBustedRound()` currently treats `totalWinningWeight == 0` after the registration deadline as all-bust. That can mean “no winner registered,” not “no winner existed.”
5. Evaluating every participant in one finalization transaction would fix semantic omission but can create an unbounded-gas denial of service.
6. Integer division leaves deterministic dust whose owner and eventual disposition require specification.
7. Physical assets must cover all simultaneous accounting buckets; a positive `reserve` variable does not alone prove solvency if the same ETH is counted elsewhere.

### Suggested scalable remedy to attack

Use a discrete target grid and an onchain Fenwick tree or segment tree of aggregate winning weight:

```text
weightAtTarget[t] += playerWeight
```

When a target changes, subtract from the old bucket and add to the new. At result:

```text
totalWinningWeight = prefixSum(highestTarget <= crashTarget)
```

This gives objective total winning weight in `O(log K)` independent of player count. Each survivor claims independently. All-bust is proven by a zero prefix sum.

Attempt to break this design. Analyze target-grid discretization, gas, storage, underflow, replacements, duplicate bets, carried stakes, forced ETH, upgrade/version transitions, reorgs, stale tree state, griefing, extreme targets, and invariant complexity. Compare it with sparse segment trees, cumulative target buckets, sorted Merkle-sum trees, rollup proofs, zk proofs, optimistic claims, bitmap/tick designs, and any better invention.

### Strategic allocation

The current game is not conventional crash. For player `i`:

```text
π_i = D × (s_i m_i) / Σ(s_j m_j)
```

when `m_i <= crash`, and zero otherwise.

Questions include:

- Does multiplying by target reward risk optimally or double-reward high targets?
- Can a high-target survivor farm communal seed from a timid room?
- Does a large seed distort equilibrium toward excessive risk?
- Can coordinated players use sacrificial low/high targets to transfer value?
- Does stake splitting preserve weight while bypassing wallet caps?
- Can visible targets create last-mover advantage?
- Do sealed targets improve equilibrium enough to justify reveal complexity?
- Can a nominal survivor receive less than stake, creating a loss-disguised-as-win problem?
- Is a target-weight cap, square-root/log target function, stake-only survivor allocation, tranche system, or market-scoring construction superior?
- Is there a unique/symmetric/mixed equilibrium? Does one exist for finite discrete targets?
- How do risk aversion, bankroll constraints, utility curvature, and heterogeneous beliefs alter play?

### Ranking, premiums, and caps

Current controls reduce ordinary single-wallet dominance, first-bettor cap bypass, and obviously thin rounds. They do not automatically solve:

- multiple wallets under common control;
- fake minimum participant count;
- repeated exemption use;
- veteran economic advantage;
- wagering escalation to unlock cheaper fees and larger permitted losses;
- responsible-play limits across linked accounts;
- whale dominance after the highest rank removes the absolute cap.

Determine which current controls are valuable and which are harmful. Do not remove protections merely for symmetry. Design a superior progression/reputation system that preserves community identity without rewarding higher gambling intensity.

### Powerboard eligibility

Linear stake weight is sybil-invariant at the arithmetic ticket level:

```text
S = S₁ + ... + Sₙ
```

but directly rewards wagering volume and naturally concentrates lottery odds.

Naive concave per-wallet weighting is sybil-vulnerable:

```text
sqrt(S) < sqrt(S/2) + sqrt(S/2)
```

One-ticket-per-wallet is also sybil-vulnerable. Analyze identity, privacy, cost, legal classification, and manipulation before recommending either.

### Live execution

The intended safe execution model is:

- `safeTargetBps` committed with the bet;
- an optional live target update accepted onchain before `intentClose`;
- the beacon result remains unavailable until after `intentClose` plus a safety margin;
- the realtime host may acknowledge input immediately but has no financial authority;
- “FrameHeard” is not chain acceptance or payout;
- the precommitted target survives client, host, RPC, or sequencer failure.

An upward-only update reduces session-key griefing but is not ordinary cash-out: raising the target increases risk in exchange for conditional weight. Determine the correct product semantics and whether one replace-once action in either direction is preferable.

## Research mandate

Search broadly and currently across every relevant discipline. Do not rely on search snippets. Read source documents and code where available. Use primary sources for claims about real systems.

### Live crash providers

Build the broadest verifiable provider registry possible, covering major operators, original game providers, white-label engines, onchain casinos, discontinued systems, and open-source implementations.

At minimum investigate:

- Bustabit and its historical/current seeding, verifier, bankroll, maximum-profit, investor, disconnect, and cash-out model;
- Stake Crash and Stake Originals fairness implementation, RTP, multiplayer synchronization, auto/manual cash-out, limits, disputes, and responsible tools;
- BC.Game Crash hash chains, formulas, reseeding events, custody, cash-out, jackpots, and verification;
- Roobet Crash latency/refund policy and auto-cashout;
- SPRIBE Aviator rules, provider/operator boundary, provably-fair mechanism, two-bet UX, cash-out adjudication, maximum winnings, disconnects, and certifications;
- Rollbit, Shuffle, Duelbits, Rainbet, Tower.bet, Thunderpick, Wolf.bet, CryptoGames, Gamdom, and other currently material crypto crash offerings where verifiable documentation exists;
- Every materially different onchain crash implementation on EVM, Solana, Sui, TON, EOS/WAX, Algorand, Bitcoin-adjacent systems, appchains, and state-channel systems;
- provider engines such as websocket/iGaming APIs where documentation exposes game events and collection/cash-out semantics;
- open-source crash implementations, exploit demonstrations, audits, bug bounties, and abandoned projects.

For each provider record:

```text
provider/operator/game/version/date
live status and jurisdiction
custody model
bankroll/liability model
RTP/edge and exact formula
outcome commitment/randomness model
cash-out authority and timing boundary
auto-cashout behavior
disconnect/server incident/reorg policy
maximum bet/win/profit
social/live UI features
jackpot/loyalty/VIP/autoplay mechanics
responsible-play controls
verifier availability and reproducibility
audit/certification provenance
known incidents/disputes/exploits
source quality and conflicts
features worth importing
features Plank must reject
```

Do not count multiple skins using one provider engine as independent technical architectures.

### Forums and practitioner communities

Search and critically evaluate:

- BitcoinTalk crash/seeding threads;
- Ethereum Research;
- Arbitrum governance and research forums;
- Solidity and smart-contract security forums;
- Hacker News;
- relevant Reddit communities, including player complaints and recovery communities;
- casino affiliate/review discussions only as leads, never authoritative evidence;
- Discord/forum archives where public and attributable;
- GitHub issues, commits, exploit repositories, audit contests, Code4rena/Sherlock/Cantina findings, and bug-bounty disclosures;
- professional iGaming engineering and compliance discussions.

Extract recurring failure modes: missed cash-outs, server receipt disputes, seed lifecycle mistakes, nonce races, skipped hash-chain indices, bankroll insolvency, withdrawal freezes, insider/admin control, misleading RTP, UI desynchronization, autoplay harm, jackpot chasing, sybil exploitation, and smart-contract drains.

Forums supply hypotheses and incidents, not proof. Corroborate material claims.

### Academic research

Cover:

- pari-mutuel wagering equilibrium and high-roller effects;
- wagering mechanism design, Pareto optimality, strategyproofness, collusion, sybils, and budget balance;
- contest theory, all-pay contests, proportional allocation, Tullock contests, Kelly betting, and rent seeking;
- prediction/information markets and dynamic pari-mutuel mechanisms;
- lottery design, rollover equilibrium, jackpot skewness, prize concentration, and regressivity;
- behavioral economics of long-shot preference and probability weighting;
- prospect theory, risk aversion, CRRA/CARA utility, loss chasing, and sunk-cost behavior;
- gambling speed, event frequency, near misses, losses disguised as wins, structural characteristics, dark patterns, and social proof;
- mechanism design under false-name/sybil participation;
- cryptographic fair ordering, commit/reveal, threshold encryption, time-lock encryption, preconfirmations, and sequencer censorship;
- decentralized randomness beacons, VRFs, withholding, fallback bias, and liveness;
- formal verification of conservation and financial smart contracts;
- accessible realtime/game UX and prediction/reconciliation.

For each paper give assumptions, theorem/empirical method, sample/data, limitations, relevance, and whether Plank violates the assumptions.

### Standards, regulation, and laboratories

Investigate current requirements and guidance from:

- UK Gambling Commission RTS, especially time-critical events, RNG, financial limits, autoplay/product design, and customer funds;
- GLI-19 and relevant GLI standards;
- Malta, Gibraltar, Isle of Man, Curaçao, Ontario/AGCO, relevant U.S. state regimes, and other plausible jurisdictions;
- NCPG and comparable responsible-gambling standards;
- AML/KYC/sanctions, age, geofencing, privacy, marketing, tax, token, sweepstakes, lottery, raffle, and pari-mutuel law;
- accessibility standards including WCAG 2.2;
- security standards relevant to keys, randomness, operations, and incident response.

Do not give definitive legal advice. Produce a jurisdiction-question matrix and launch blockers for qualified counsel.

## Required formal analysis

### Exact accounting model

Define every asset and liability bucket:

- Vault reserve;
- current/open round pools;
- seeds in flight;
- settled claims;
- pending pull-payment escrow;
- carried-forward stakes;
- voided/refundable stakes;
- accumulated treasury rake;
- keeper rewards;
- Powerboard jackpot;
- Powerboard awarded-but-unclaimed prizes;
- fuel boost pool;
- failed credits;
- deterministic dust;
- forced/unaccounted ETH.

Produce a global invariant using actual contract balance, not accounting variables alone. Show every state transition as a debit/credit table and prove that no bucket is double-counted.

### Exact game model

Model target grid `M`, player stakes, seed ratio, rake, crash distribution, target weighting, information structure, and timing.

At minimum run:

```text
N ∈ {1, 2, 3, 10, 50, 500}
seed/playerPool ∈ {0, 0.01, 0.1, 0.5, 1, 5, 20}
rake ∈ {0, 0.5%, 1%, 2%, 5%}
risk utility ∈ {risk-neutral, CRRA variants, prospect-theory candidates}
information ∈ {public targets, sealed targets, delayed public targets}
actors ∈ {symmetric, whale+minnows, colluding coalition, sybil whale}
```

Compute or approximate equilibria, best responses, regret, expected net return, variance, drawdown, pool concentration, Vault extraction, and welfare. State where equilibrium computation fails or is non-unique.

Compare at least:

- `weight = stake × target`;
- `weight = stake` among survivors;
- capped target weight;
- sublinear target transformations;
- target tranches;
- survivor-principal-first variants that remain conserved;
- any original superior mechanism you invent.

Do not optimize only protocol revenue or engagement. Include player comprehension, concentration, harm, and community distribution objectives.

### Sybil model

For every cap, rank, premium, target, and lottery formula, compute the benefit of splitting one beneficial owner across `n` wallets after gas, minimum stake, premium exemptions, tenure, required actions, and identity costs.

Classify each rule as:

- exactly sybil-invariant;
- sybil-resistant under quantified cost assumptions;
- sybil-vulnerable;
- dependent on external identity/KYC/proof-of-personhood;
- privacy-incompatible.

### Settlement data structure

Provide an implementation comparison for objective, registration-free total winning weight:

| Construction | Bet/update gas | Settlement gas | Storage | Claim gas | Privacy | Complexity | DoS surface |
|---|---:|---:|---:|---:|---|---|---|

Include Solidity-like code, overflow bounds, tick count, update rules, carried stake behavior, and exact invariants.

## Product and UX mandate

Design a vocabulary that never confuses:

- displayed target with guaranteed payout;
- survived target with positive net result;
- local input with server receipt;
- server receipt with chain acceptance;
- L2 acceptance with irreversible finality;
- estimated share with claimable amount;
- community seed with free money;
- token burn with personally purchased odds;
- Powerboard eligibility with a guaranteed benefit.

Produce the exact state machine, screen copy, error states, proof drawer, pool composition panel, net-result presentation, reduced-motion behavior, disconnect recovery, and mobile wallet flow.

No confetti or “WIN” treatment when net return is below stake. No `stake × target` preview. No autoplay, martingale, turbo rebet, near misses, jackpot-chasing urgency, or rank copy encouraging wagering to unlock better economics.

## Required invention task

After surveying prior art, invent the strongest version of this economy. It should preserve the emotional spirit:

- the whole table plays one dramatic shared round;
- players choose meaningful risk;
- the community Vault visibly seeds opportunity;
- fully busted rounds feed future players;
- part of protocol value returns to the community;
- the jackpot compounds across time;
- `$PLANK` fuel benefits everyone rather than buying personal odds;
- the platform cannot owe an unbounded tail multiplier;
- no operator can choose winners or withdraw game purses;
- players can independently replay every result and accounting transition.

Name the invention. Clearly label which components are:

- existing proven patterns;
- new combinations;
- original mechanisms;
- speculative research requiring falsification.

Complexity must buy a measurable guarantee. If the existing formula is better than every alternative, prove why. If an apparently sacred mechanic is harmful or exploitable, say so and produce the closest spirit-preserving repair.

## Required deliverable

Return one cohesive report with:

1. Executive verdict and impossibility boundaries.
2. Current-contract audit with severity, scenario, affected invariant, and remedy.
3. Exhaustive provider/archetype registry with dated citations.
4. Forum/incident synthesis with corroboration status.
5. Academic literature review with assumptions and limitations.
6. Regulatory/laboratory/responsible-design matrix.
7. Exact global accounting ledger and conservation proof.
8. Formal game definition and notation.
9. Equilibrium/best-response analysis and simulation results.
10. Seed-farming, whale, coalition, and sybil analysis.
11. Comparison of target-weight functions.
12. Ranking/fee/minimum/maximum redesign.
13. Objective registration-free settlement design.
14. Vault seed-release and overflow optimization.
15. Powerboard eligibility and rollover redesign.
16. Live execution and precise proof-state UX.
17. Randomness, domain separation, freeze, failure, and no-result-shopping protocol.
18. Smart-contract interfaces, storage, events, typed messages, and pseudocode.
19. Property, invariant, fuzz, differential, model-checking, and economic-test plan.
20. Operational architecture, SLOs, monitors, incident and chain-halt runbooks.
21. Legal/responsible/accessibility launch blockers.
22. Phased implementation roadmap with testnet gates and kill criteria.
23. Residual-risk register.
24. Claim-to-evidence table for every marketing/security statement.
25. Full bibliography with source date, credibility class, conflicts, and supported/challenged decision.

Attach machine-readable artifacts where possible:

- simulation source;
- parameter files;
- deterministic seeds;
- CSV/JSON outputs;
- plots with raw data;
- Solidity sketches;
- property-test sketches;
- test vectors;
- provider registry JSON/CSV;
- reproducibility instructions.

Do not claim tests were run unless you provide the complete code, command, environment, raw output, and seed. A Python kernel is not a Solidity proof. Map every model transition to the proposed contract transition and identify mismatches.

## Quality and falsification standard

- Prefer primary protocol documentation, source code, verified contracts, audit reports, regulator publications, and peer-reviewed research.
- Vendor pages establish claims, not truth; corroborate them.
- Forum anecdotes generate hypotheses; label and verify them.
- Search for negative evidence and failed systems.
- Quantify instead of saying “secure,” “fair,” “instant,” “decentralized,” or “responsible.”
- Do not confuse cryptographic outcome integrity with economic fairness, execution fairness, solvency, legal authorization, or low harm.
- Do not describe a per-wallet control as sybil-resistant without a beneficial-owner model.
- Do not use engagement or retention as the sole objective for lottery design.
- Do not declare an architecture unimprovable.
- State every trust assumption and every administrator/upgrader/oracle/sequencer privilege.
- End with the strongest argument against your recommended mechanism.
- Give at least three concrete experiments, proofs, or adversarial results that would falsify your recommendation.

The goal is a reproducible mechanism-design and engineering blueprint that can survive challenge from game theorists, cryptographers, smart-contract auditors, iGaming engineers, regulators, responsible-gambling researchers, accessibility specialists, operations engineers, skeptical players, and adversarial token holders.
