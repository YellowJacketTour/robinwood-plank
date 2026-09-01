# PlankCrash mechanism and security review — 2026-09-01

## Executive conclusion

The strongest defensible PlankCrash design is a budget-balanced parimutuel
player layer, plus a separately bounded house layer and separately funded
rolling lottery. It can guarantee conservation, transparent aggregate RTP,
partition invariance, bounded reserve exposure, and outcome finality. It
cannot guarantee that every player profits, or that every future round pays
every strategy at least as much as the previous round: an adversarial field
can make those promises mutually inconsistent with solvency.

This review therefore uses the release claim **zero known exploitable edge
under the stated threat model and verification corpus**, never “zero possible
bugs.” Independent audit and a signed testnet canary remain external release
gates.

## Mechanism requirements

| Property | Implementable invariant |
|---|---|
| Solvency | total player payouts + routed rake + retained liabilities never exceed funded value |
| Aggregate player value | player purse equals player pool × (1 − effective rake), wei-exact apart from player-favouring dust policy |
| Skill reward | later surviving locks receive more hazard weight, using `stake × ln(multiplier)` |
| Sybil resistance | allocation constraints are identity-independent, additive in stake, and positively homogeneous |
| House safety | bonus is globally capped from `reserveAtLock`, never capped per wallet |
| Randomness fairness | target drand round is committed before bets; result is domain-separated by chain, deployment, beacon, game round, and beacon round |
| Liveness | any account may relay/reveal/settle; no outcome-selective timeout void exists |
| Lottery integrity | tickets arise from qualified play, a committed future draw selects the result, and crash settlement never depends on lottery availability |

The logarithmic weight is not decorative. Under the crash survival law
`Pr(C ≥ m) = 1/m`, cumulative hazard is `H(m) = −ln(1/m) = ln(m)`.
It therefore prices endured crash hazard continuously, without multiplier
buckets or cliff strategies.

## Proven boundary conditions

1. **No universal individual-profit guarantee.** In a closed player purse,
   all survivors cannot receive more than their combined funding unless a
   bounded external subsidy supplies the difference. Promising it without a
   cap creates an open liability.
2. **No identity-based anti-Sybil rule.** Wallet limits can be split. The
   economic rule must instead be partition invariant: splitting `(s,m)` into
   positions whose stakes sum to `s` must not increase aggregate payout.
3. **No free manufactured-round reward.** A permissionless per-round subsidy
   is farmable whenever controllable reward exceeds unavoidable retained rake.
   Permissionless keepers therefore earn a fraction of realized rake; any gas
   floor is isolated, budgeted, and paid only to a designated independent
   keeper.
4. **No monotone per-player payout across arbitrary fields.** The honest
   monotone promise is system capacity: a deterministic schedule may raise the
   aggregate purse or bounded bonus only after irreversible retained income,
   without reducing previously funded liabilities.

These boundaries agree with false-name and collusion literature: anonymity,
budget balance, incentive compatibility, Sybil resistance, and collusion
resistance cannot all be maximized without trade-offs. The chosen design makes
the scarce guarantees explicit instead of hiding them in wallet identity.

## Optimizations not to leave untapped

### 1. Income-indexed improvement epochs

Version parameters by immutable settlement epoch. A future epoch may improve
the player purse or global house-bonus budget only from realized retained
income after reserve floors and drawdown constraints. Never mutate the rule
for a round after its first bet. This provides “the system gets more generous
as funded capacity grows” without an unfunded promise.

### 2. Risk-constrained reserve controller

Treat seeding as a risk budget, not a fixed promotional percentage. The
controller should use only retained income, enforce hard per-round exposure,
high-water and rolling-window drawdown stops, and resume mechanically. This is
the contract analogue of risk-constrained Kelly allocation: optimize long-run
utility subject to an explicit drawdown bound rather than maximizing raw bet
size.

### 3. Coalition audit as a release artifact

For every parameter set, publish worst-case searches over:

- same-lock and adjacent-lock wallet partitions;
- minimum-risk seed harvesting;
- dominant whales, absorbers, and survivor coalitions;
- manufactured rounds and keeper capture;
- lottery-ticket farming and rollover timing;
- one-wei boundaries, rounding, and maximum participant count.

The release gate is maximum profitable deviation ≤ rounding dust, with all
dust routed consistently and never magnified by repetition.

### 4. Randomness-source independence

Fetch exact drand rounds through at least two independent HTTP origins and
require identical round/signature agreement before submitting. This is a
liveness and transport check; the on-chain BLS verifier remains the
cryptographic authority. Never use `latest` to settle a committed exact round.

### 5. Legacy-contract containment

Only the manifest-pinned production graph is deployable. Entropy prototypes,
blockhash crash variants, mocks, and testbeds must be denied by production
deployment scripts and chain allowlists. A repository-wide analyzer finding
in a legacy prototype is not waived; it is contained by proving that bytecode
cannot enter the release graph.

## Changes applied in this review

- Reconciled the hardened `PlankCrashDrand` lineage onto the audit branch.
- Committed each round's target drand envelope before any bet is visible.
- Domain-separated result seeds across chain, deployment, beacon, game round,
  target round, and beacon output.
- Removed production's outcome-selective stale-round void.
- Applied identical finality semantics to the seedless public testbed.
- Preserved bank auto-cashout commitments through session-key funded bets.
- Required two-origin agreement in the drand relay and autonomous keeper.
- Preserved inert `pendingOverflow`: reserve is synchronously capped, while a
  failed lottery delivery cannot affect seeding, drawdown, or game progress.

## Verification status

- Contract suite: **372 passing, 0 failing** after reconciliation.
- Stateful randomized and fault-sink suites include overflow, forced ETH,
  reentrancy attempts, randomized lifecycle actions, pool conservation,
  income-bounded seeding, drawdown stops, keeper farming, and coalition probes.
- Slither: full repository analyzed (116 contracts). High/medium reports must
  be triaged against the pinned production graph. Expected calls protected by
  CEI/non-reentrancy and deliberate payout destinations are not automatically
  vulnerabilities; legacy weak-randomness variants are excluded from the
  release graph. The machine report is reproducible locally and is not, by
  itself, an independent audit.

## Primary research basis

- Lambert, Langford, Vaughan, Chen, Reeves, Shoham: *An Axiomatic
  Characterization of Wagering Mechanisms* — budget balance, anonymity,
  homogeneity, and Sybil-proof wagering structure.
- Freeman and Pennock: *An Axiomatic Approach to Transaction Fee Mechanism
  Design / Parimutuel Consensus* — budget balance, individual rationality,
  anonymity, Sybil resistance, and the incentive-compatibility trade-off.
- Yokoo et al.: false-name bids — identity splitting defeats mechanisms whose
  constraints are not false-name-proof.
- Busseti, Ryu, Boyd: *Risk-Constrained Kelly Gambling* — explicit convex
  drawdown bounds rather than unconstrained growth maximization.
- SoK: *Distributed Randomness Beacons* — withholding, threshold randomness,
  and guaranteed-output trade-offs.
- SoK: *Mitigation of Front-running* — ordinary commit/reveal permits
  selective non-reveal; input independence and forced availability matter.
- OWASP Smart Contract Top 10 (2026), EEA EthTrust, Solidity Security
  Considerations, and Slither detector guidance form the implementation review
  baseline.

## Remaining external gates

1. Independent contract audit of the exact frozen bytecode and deployment
   parameters.
2. Independent mathematics review of CCS-2L, reserve controller, and lottery
   economics.
3. Signed testnet canary with real gas, relay failover, keeper continuity, and
   multiplayer lifecycle evidence.
4. Bug-bounty publication, incident drill, legal/licensing approval, and final
   deployment-manifest attestation.

Until those gates close, this branch is a hardened production candidate, not
an assertion of perfect security.
