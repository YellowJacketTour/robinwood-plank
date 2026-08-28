# One-shot prompt for Grok: adversarial global redesign of Plank abundance economics

You have no prior conversation context. Treat everything below as the complete assignment. Do not flatter the premise. Your job is to reproduce, falsify, improve, or replace it with a more solvent, profitable, fair, attractive, compounding design.

## Product

Plank.love is designing an onchain pari-mutuel crash game, a slower community lottery called Powerboard, a persistent Vault, a PLANK token burn/boost engine, rankings/progression, creator/community utilities, and a high-fidelity real-time UI on Robinhood Chain.

The founders want the entire platform to compound value and intrigue: increasing community backing, increasing sealed game/lottery prizes, increasing post-win lottery bases, winner-take-all net jackpots, sustainable founder revenue, token utility, creator/public-good output, and aligned long-term participation.

## Non-negotiable existing economics

Fresh crash wagers pay 4.50% gross rake. At zero keeper reward the ratified destinations are:

```text
20% of gross rake -> PLANK burn      = 0.90% of wagers
40% of gross rake -> Vault-first community prize engine = 1.80% of wagers
40% of gross rake -> founders/dev/ops = 1.80% of wagers
```

If a keeper reward is enabled, remove it first and apply 20/40/40 to net rake. The split must be calculated in one pass. A current implementation mistakenly takes a 40% Vault carve and then applies 20/40/40 to the remainder, producing effective 0.54/1.08/1.08 burn/Powerboard/founder percentages; diagnose and correct this without inventing value.

The Vault-first community leg funds crash prizes first and covered overflow funds Powerboard. It is one liability leg, not an additional allocation beyond 100%.

Powerboard has a separate immutable flat founder lottery-engine fee `phi` applied when each epoch's gross prize capital is constituted, including rollover. The fee is paid/escrowed before the draw. The advertised jackpot is net of this fee and the winner receives all of it with no claim-time deduction.

After every miss, the next sealed net jackpot must be strictly higher. After every jackpot hit, the next cycle must restart at a strictly higher net base than the previous cycle began with. The next reset must be fully reserved before the current jackpot becomes drawable.

The wager is the assumed player sacrifice. A qualifying iteration requires at least `m_min` independently eligible players and at least `b_min` fresh stake from each, so `W_min = m_min*b_min`. Research privacy-preserving Sybil resistance and explain why wallet count is not personhood. Before both thresholds lock, commitments must remain refundable and cannot be counted as guaranteed capital.

Assume infinitely many qualifying iterations with fresh player wagers at least `W_min > 0`. Be mathematically exact about what this proves. Constant minimum inflow provides linearly growing cumulative funding but cannot finance an unbounded strictly increasing paid cash prize on every fixed-cadence iteration. The proposed resolution is coverage-triggered sealing: a target/epoch stays funding-open until fully covered; under infinite minimum contributions every finite target is eventually reached, while every finite-prefix state remains solvent. Try to improve this theorem without weakening conservation.

The founders want all participants rowing in the same direction. Treat every "bribe" as a transparent, rules-hashed incentive transfer with payer, recipient, budget, action, cap, vesting/reversal, and measurable positive externality. Design incentives for players, founders, creators, sponsors, keepers, relayers, token holders, auditors, referrers, moderators, and public-good builders. Reject covert affiliate steering, governance bribery, outcome influence, circular wash rewards, raw-loss leaderboards, or any payment whose durable incremental value does not exceed its cost and induced risk.

## Current important findings

- Vault seed was incorrectly included in the rake base; it has been patched so only fresh player stakes are raked.
- Current Powerboard uses one global mutable jackpot. Historical epochs can compete for later funding and draw order changes entitlements. Replace it with isolated epoch pots and rollover credits.
- Current Powerboard chooses a drand target when someone requests a draw rather than from scheduled epoch close, enabling caller timing and duplicate/correlated targets.
- Historical crash settlement constructs winner denominators through a registration window. Omitted winners can be excluded. Replace this with objective per-round aggregates/canonical seats or another mechanism proven superior.
- Current crash timeouts may permit a settle-versus-void option after randomness is knowable.
- Current crash and lottery randomness lack complete domain separation.
- Current payout math has unresolved deterministic dust and equality-boundary policies.
- Current wager-weighted progression and tickets can reward gambling intensity and saved-ticket timing.
- Fuel burns need minimum output, expected round, deadline, exact token burn proof, and source/destination provenance.

## Baseline formulas to audit

For fresh wager `W_n`, rake `rho=450/10000`, keeper `K_n`, and `Q_n = floor(W_n*rho)-K_n`:

```text
Burn_n      = floor(Q_n*2000/10000)
Community_n = floor(Q_n*4000/10000)
Founders_n  = Q_n-Burn_n-Community_n
```

For Powerboard epoch `e`:

```text
Gross_e      = Rollover_e + FreshCommunity_e + ExternalFunding_e
FounderFee_e = floor(Gross_e*phi/10000)
NetPrize_e   = Gross_e-FounderFee_e
```

On a miss with consolation `C_e`:

```text
Rollover_(e+1)=NetPrize_e-C_e
NetPrize_(e+1)>=NetPrize_e+Delta_e
```

Derive an exact integer `minimumGross(targetNet,phi)` and minimum fresh funding. Prove minimality including one-wei-below tests. Do not rely on floating point.

For cycle base:

```text
B_(k+1)=B_k+max(minBaseStep,floor(B_k*baseGrowthBps/10000))
GrossReset_(k+1)=minimumGross(B_(k+1),phi)
```

The current winner pot, founder fee, later epoch pots, and next reset reserve must be disjoint liabilities.

## Required global research

Perform a source-diverse web deep dive dated to the current day. Search and critically compare:

1. live crypto crash providers, provably-fair implementations, onchain games, pari-mutuel markets, progressive jackpots, national/state lotteries, raffle protocols, prediction markets, poker rake and loyalty systems;
2. mechanism design, contest/all-pay theory, lottery-demand elasticity, jackpot skewness, rollover behavior, house takeout, gambler welfare, regressivity, Kelly/bankroll survival, dynamic games, repeated games, principal-agent theory, club goods, network effects, matching markets, loyalty and status systems;
3. endowment spending, reserve/ruin theory, insurance capital, risk measures, liability matching, sustainable emissions, control theory, robust optimization, stochastic processes, queue/admission control, Lyapunov functions, supermartingales, and formal solvency proofs;
4. tokenomics, buyback/burn evidence, reflexivity, liquidity, oracle manipulation, MEV, Sybil resistance, airdrop farming, ve-token/bribery failures, public-goods funding, quadratic funding, pairwise funding, Nash-product allocation, retroactive funding, creator economies, referrals, sponsorship, subscriptions, APIs and external commerce;
5. drand, VRFs, commit-reveal, threshold cryptography, domain separation, rejection sampling, L2 sequencing/reorgs, session keys, account abstraction, preconfirmations, real-time UX, WebSockets, rollback/reconciliation, and keeper markets;
6. formal verification, invariant testing, economic audits, smart-contract incident postmortems, Hacker News, Ethereum Research, ethresear.ch, governance forums, security researchers, audit contest findings, GitHub issues, Reddit specialist communities, gambling-industry forums, operator documentation, and regulator/test-house standards;
7. responsible product design, precommitment, limits, self-exclusion, reality checks, VIP/loyalty harm, near-miss/loss-disguised-as-win effects, accessibility, privacy, AML/sanctions/source-of-funds, gambling/lottery/betting classification, advertising, taxation, and crypto-specific licensing.

Use primary sources for technical claims and law/regulation; peer-reviewed papers or working papers for academic claims; clearly label forums and anecdotes as weak evidence. Include direct links, publication dates, jurisdictions, conflicts of interest, sample limitations, and contrary evidence. Do not pad the bibliography with sources that do not change a decision.

## Required critique

Attack the design from every participant's perspective:

- small player, whale, Sybil farmer, sophisticated arbitrageur, latency attacker, sequencer, keeper, relayer, winner, offline claimant, sponsor, creator, founder, token holder, regulator, auditor, and compromised session key;
- low/constant/volatile/declining volume;
- immediate repeated jackpot hits and extremely long miss streaks;
- no external revenue, grant loss, oracle failure, token crash, chain halt, reorg, censorship, malicious sink, forced ETH, rounding extremes, and gas exhaustion;
- saved tickets, wallet splitting, collusion, wash volume, referral loops, leaderboard farming, griefing, front-running, selective settlement, draw reordering, and UI deception;
- founder incentives under recurring rollover fees and whether fees create an eventual growth threshold too costly for attraction;
- whether winner-take-all is actually optimal versus prize tiers, consolation, must-hit, or bounded hybrid schedules;
- whether monotonic prizes create unhealthy chasing, regressivity, or unsustainable cadence.

Distinguish:

- accounting profit;
- player expected monetary value;
- community redistribution;
- external revenue;
- entertainment/consumer surplus;
- token-holder transfer;
- true social/public-good surplus.

Never call a closed-pool transfer positive-sum merely because it remains inside the community.

## Invention mandate

Invent superior mechanisms if evidence supports them. Candidate directions—not conclusions—include:

- a one-pass provenance router;
- coverage-triggered monotonic prize queues;
- per-epoch sealed balance sheets and sequential finalization;
- reserve certificates and public solvency/coverage curves;
- a two-tempo crash/lottery attention engine;
- bounded excess-prize capture into future bases;
- sponsor matching that buys non-outcome-changing visibility;
- creator/public-good dividends from non-wager external revenue;
- concave, capped, breadth-based progression rather than loss-volume rankings;
- nontransferable legacy/high-water artifacts;
- privacy-preserving anti-collusion community allocation;
- target-intent crash execution with objective aggregate settlement;
- domain-separated scheduled drand envelopes;
- session-key constraints on target range, direction, revisions, spend/loss, rules hash, and deadline;
- verified burn receipts and token utility independent of price promises;
- safety tools that improve healthy lifetime value rather than merely satisfy compliance.

For every proposed mechanism provide exact formulas, state machine, balance sheet, attack surface, equilibrium intuition, failure conditions, observability, UX copy, migration consequences, and reasons it dominates or fails the baseline.

## Simulations and proofs required

Provide executable pseudocode or Python/TypeScript model specifications for:

- deterministic exact rounding and conservation;
- adaptive volume processes, including `W_n=W_min` forever;
- jackpot Bernoulli/geometric hit paths, immediate hits, maximum miss paths, must-hit paths, and draw-order permutations;
- founder revenue, player RTP/EV distribution, Vault/community capital, burn, reset coverage, time-to-seal, and jackpot growth;
- whale concentration, Gini/HHI, Sybil splits, referral abuse, and progression incentives;
- risk-of-ruin and finite-prefix insolvency;
- sensitivity/robust optimization across rake, `phi`, community allocation, consolation, `Delta`, base growth, hit probability, minimum volume, and external revenue;
- comparison against current implementation, corrected baseline, and every proposed alternative.

Prove or falsify these invariants:

```text
assets == sum(disjoint liabilities)
sealedPrize[e+1] > sealedPrize[e] after a miss
cycleBase[k+1] > cycleBase[k]
winnerPayment == advertisedNetPrize
no fee is charged twice without explicit recurring-fee disclosure
no historical epoch consumes later funding
draw/claim order does not change entitlement
known randomness cannot transition to refund/void
every liability remains withdrawable
under infinite W_min contributions every finite covered target eventually seals
no finite prefix depends on future funding for solvency
```

Correct the stray `+` in the invariant above if encountered; it is a formatting character, not mathematics.

## Exact implementation plan to review

1. Ratify parameters and `rulesHash`.
2. Extend a BigInt reference oracle with one-pass split, exact recurring-fee minimum gross, reset coverage, and stochastic/adversarial simulation.
3. Build versioned `PlankEconomicRouterV2` with typed provenance buckets.
4. Build `PlankPowerboardV2` with funding accumulator, isolated epoch pots, sequential seals/draws, scheduled domain-separated drand, rejection sampling, pre-reserved higher reset base, WTA pull payment, and exact founder escrow.
5. Build `PlankCrashVNext` with bet-time target intent, canonical seats, round-isolated objective aggregate settlement, uniform equality rule, exact dust, immutable rules envelope, domain-separated drand, no selective timeout, and perpetual pull claims.
6. Build constrained Bank/session-key methods and real-time submitted/accepted/frozen/survived/claimable UX.
7. Replace raw-wager progression with a capped multi-axis contribution model and separately governed creator/public-good allocation.
8. Add combined-system solvency views, high-water/lifetime counters, alerting, and public verifier.
9. Differential test, stateful fuzz, formally verify core invariants, benchmark gas, obtain independent economic/security/randomness/UI and jurisdictional reviews.
10. Shadow simulation, capped testnet, capped approved production, public evidence package, then measured expansion.

## Required output

Deliver one self-contained report with:

1. executive verdict and fatal flaws;
2. source methodology and evidence-quality table;
3. reconstructed current and intended Plank balance sheets;
4. corrected formulas and formal propositions/proofs;
5. provider/industry comparison matrix;
6. mechanism-by-mechanism critique;
7. at least three complete alternative architectures;
8. simulation design and representative sensitivity results;
9. security/economic/adversarial threat model;
10. responsible-design and legal/compliance matrix by representative jurisdictions, clearly marked as requiring counsel;
11. selected optimal architecture with exact contracts/state/functions/events;
12. UI/UX and disclosure specification;
13. phased migration and validation plan;
14. rejected ideas and why;
15. unresolved questions ranked by decision impact;
16. source-linked bibliography.

Conclude with a red-team verdict: what would make you refuse to launch, what evidence would change your mind, and the smallest set of experiments that most reduces uncertainty. Seek a design that is more profitable because it is more trustworthy, useful, safe, and durable—not because it hides costs or accelerates harmful loss.
