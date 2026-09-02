# Plank abundance engine: critical mechanism-design blueprint

Date: 2026-08-27

Status: research-backed target architecture; implementation requires simulation, legal classification, independent audit, and versioned deployment.

> **SPLIT-CANON CORRECTION 2026-09-02** (owner decision: the code is canon).
> References to a "20/40/40" rake split below reflect a superseded pipeline.
> The ratified, implemented split of net rake is **40% burn / 40% community
> (Powerboard funding leg) / 20% founder** — `ratifiedRakeSplit`
> (`lib/casino/economics.ts`) and `contracts/PlankEconomicRouterV2.sol`
> (`BURN_BPS = 4_000`, `COMMUNITY_BPS = 4_000`, founder = remainder), with the
> evolutionary rake 450 bps declining -25 bps per 25M qualified volume to a
> 250 bps floor. See docs/CASINO-ARCHITECTURE.md SS5a. Historical analysis below
> is preserved unmodified for the record.

## Thesis

Plank should maximize durable community surplus, not merely gross wagering. A closed wagering pool is redistributive and becomes negative-sum after operating costs. Plank becomes broader-sense positive-sum only through entertainment utility, transparent founder-funded product development, sponsor and commerce revenue, useful software and market services, creator compensation, public goods, verifiable status artifacts, and community capital that produces future experiences.

The objective function is therefore multi-dimensional:

```text
maximize:
  player entertainment and agency
  + solvent net prizes
  + community capital formation
  + creator/public-good output
  + $PLANK utility and verified burn
  + founder capacity to improve the product
  + trust, fairness, safety, and retention

subject to:
  exact conservation
  withdrawal liveness
  no hidden dilution
  no unfunded promise
  no outcome manipulation
  no reward for harmful intensity
  jurisdictional and testing gates
```

Lottery research finds jackpot size, rollover, and the shape—not merely the mean—of the prize distribution affect demand. That supports a visible progressive jackpot, but it also means the design can intensify chasing and regressivity. The system must optimize healthy lifetime participation rather than extraction. Sources: [How to Design a Lottery](https://doi.org/10.1016/B978-044450744-0.50025-1), [recent demand and welfare evidence](https://academic.oup.com/restud/article/92/4/2578/7738012), and [rollover regressivity](https://ecommons.luc.edu/business_facpubs/152/).

## Ratified economic kernel

For fresh player wagers `W_n`, published crash rake `rho = 450/10000`, and keeper share `k`:

```text
R_n = floor(W_n * rho)
K_n = floor(R_n * k)
Q_n = R_n - K_n

Burn_n      = floor(Q_n * 2000 / 10000)
Community_n = floor(Q_n * 4000 / 10000)
Founders_n  = Q_n - Burn_n - Community_n
```

At zero keeper reward, this is exactly 0.90% burn, 1.80% Vault-first community prizes, and 1.80% founder/dev/ops per wager. All legs are calculated once from `Q_n`; sequential percentages that silently turn the ratified split into 0.54/1.08/1.08 are rejected.

Founder revenue is productive infrastructure: audits, operations, game development, liquidity, support, compliance, art, sponsorship sales, and new utilities. It is not called player value and is never double-counted as community capital.

## Infinite-minimum-contribution theorem

The wager is the participant's assumed economic sacrifice. A qualifying game exists only when at least `m_min` independently eligible players each commit at least `b_min` of fresh stake:

```text
W_min = m_min * b_min
participantCount_n >= m_min
freshWagers_n >= W_min
```

Wallet count alone is not independence. Eligibility may require jurisdictionally permitted identity/personhood, funding-provenance, device/payment-cluster, or other Sybil controls, while preserving privacy and an appeal path. A whale splitting one bankroll cannot manufacture the diversity assumption.

Assume infinitely many qualifying iterations and fresh player wagers `W_n >= W_min > 0`. Then the minimum community inflow per iteration is:

```text
C_min = floor((floor(W_min * rho) - K_max) * 4000 / 10000)
```

If mandatory community outflow per iteration is bounded by `O_max < C_min`, restricted community capital grows at least linearly:

```text
H_N >= H_0 + N * (C_min - O_max)
```

and diverges as `N -> infinity`.

This proves unbounded cumulative capital, not an unbounded increasing cash payout at every fixed-cadence game. With constant minimum inflow, a strictly increasing per-game payout has cumulative cost that eventually exceeds linear funding. No fee split or rollover algebra changes that conservation result.

Plank resolves this without weakening monotonicity:

1. a game or lottery target increases only after full escrow coverage;
2. the funding epoch remains open until covered;
3. every sealed prize is no smaller than the previous sealed prize;
4. under infinitely many minimum contributions, every finite target is eventually funded;
5. at every finite prefix, assets cover liabilities.

This is **coverage-triggered monotonicity with eventual progress**, not cadence-triggered insolvency.

### Sacrifice-floor admission rule

Before `m_min` and `W_min` are met, the state is `FUNDING`, not a live game. Player commitments remain withdrawable until the threshold locks, or expire/refund automatically. Once locked:

```text
minimumGrossRake = floor(W_min * 450 / 10000)
minimumBurn      = floor(minimumNetRake * 2000 / 10000)
minimumCommunity = floor(minimumNetRake * 4000 / 10000)
minimumFounders  = minimumNetRake - minimumBurn - minimumCommunity
```

No target ratchet may count wagers before the lock makes them irrevocably part of the qualifying iteration. No UI may call conditional commitments guaranteed backing.

## One-direction stakeholder incentives

"Bribes" are implemented only as disclosed, rules-hashed incentive transfers. Covert payments, outcome-dependent promotion, affiliate steering, governance bribery, and rewards for concealment are excluded. Every incentive must name its payer, recipient, funded budget, qualifying action, cap, vesting/reversal rule, and measurable positive externality.

The alignment test is:

```text
incremental durable system value created by action
  >= incentive paid
  + induced risk/harm cost
  + verification/enforcement cost
```

| Actor | Rewarded action | Funding source | Anti-gaming constraint |
|---|---|---|---|
| Players | qualifying breadth, healthy return, verification, community contribution | acquisition/community budget | concave caps; never raw losses |
| Founders | solvent volume, external revenue, uptime, safety, creator/public-good output | ratified founder legs | liabilities paid first; public metrics |
| Keepers/relayers | timely unique state transition | explicit liveness budget | pay once; target-bound; gas/replay caps |
| Creators | retained attributable users, commerce, accepted assets/events | founder acquisition or external commerce margin | vesting, quality, self-referral exclusion |
| Token holders | verified real burn and useful access/discount utility | ratified burn leg and product utility | no price/RTP promise; oracle/min-output guards |
| Sponsors | verifiable attention and non-outcome-changing placement | external sponsor revenue | no odds influence; frequency and suitability limits |
| Public-good builders | verified delivered impact | capped community/external matching pool | Sybil/collusion defenses; milestone evidence |
| Auditors/verifiers | accepted findings, reproduced invariants, monitoring | founder/security budget or bounty | severity rubric; duplicate handling; embargo process |

### Marginal-value procurement, not extraction contests

Where Plank purchases creator work, sponsorship, liquidity, audits, or public goods, rewards should be based on verified marginal contribution rather than highest spend. All-pay contest literature warns that making everyone expend irreversible resources for one prize can dissipate the prize value. Use posted bounties, milestone escrow, capped matching, or procurement auctions where appropriate; reserve winner-take-all treatment for the disclosed lottery entertainment product.

### Compounding flywheel

```text
minimum diverse sacrifice
 -> ratified one-pass rake
 -> founder capacity + real burn + community capital
 -> safer/faster/richer product and larger covered prizes
 -> stronger trust, creators, sponsors, and external revenue
 -> broader healthy participation
 -> larger future qualifying sacrifice
```

Each arrow needs a counterfactual metric. If an incentive increases short-term wagering but worsens concentration, harm, withdrawals, trust, or long-term retention, it is rowing against the system and is removed.

## Unified Heartwood ledger

Use one router and physically or logically isolated liabilities:

- `protectedPrincipal`: normally nondecreasing and never raked or paid;
- `crashEmission`: fully funded crash subsidies;
- `lotteryGrowthEscrow`: funds required to make the next miss prize larger;
- `nextCycleResetEscrow`: gross capital for the next strictly higher base;
- `epochPrize[e]`: one sealed, net winner-take-all pot;
- `founderCrashEscrow`: founders' ratified crash-rake leg;
- `founderLotteryEscrow[e]`: epoch founder fee, including rollover provenance;
- `burnEscrow`: exact ETH authorized for audited conversion and burn;
- player, void, winner, keeper, and dust liabilities;
- forced ETH as `unclassifiedSurplus` until explicitly synchronized.

Every transfer is a debit to exactly one source bucket and credit to exactly one destination bucket. Historical gross volume is not a live liability.

## Lottery recurrence

For net rollover `R_e`, fresh community allocation `A_e`, external revenue `X_e`, immutable founder lottery fee `phi`, and exact floor policy:

```text
Gross_e       = R_e + A_e + X_e
FounderFee_e  = floor(Gross_e * phi / 10000)
NetPrize_e    = Gross_e - FounderFee_e
```

On a hit, the winner receives `NetPrize_e` in full. On a miss with consolation `C_e`:

```text
R_(e+1) = NetPrize_e - C_e
```

The next epoch seals only if exact integer arithmetic proves:

```text
NetPrize_(e+1) >= NetPrize_e + Delta_e
```

The implementation uses a monotonic exact `minimumGross(targetNet, phi)` function rather than an approximate rearrangement. One-wei-underfunded sealing must revert.

Before an epoch becomes drawable, `nextCycleResetEscrow` must cover the already-ratified next base:

```text
B_(cycle+1) = B_cycle + max(minBaseStep, floor(B_cycle * baseGrowthBps / 10000))
GrossReset  = minimumGross(B_(cycle+1), phi)
```

This makes a first-epoch hit safe. A jackpot draw cannot consume later-epoch or reset capital.

## Attraction without extraction

### 1. Two tempos, one story

- Crash provides frequent agency and immediate target selection.
- Powerboard provides communal suspense and rare winner-take-all release.
- Heartwood high-water records preserve continuity after resets.
- The UI distinguishes guaranteed base, player-added value, gross constituted capital, founder fee already paid, net WTA prize, reset coverage, and time-to-seal estimate.

### 2. Progression based on breadth, craft, and contribution

All-pay contest theory warns that winner-take-all status competitions can dissipate participant value and magnify errors. Do not make ranking a pure loss-volume arms race. Reward a capped mixture of:

- distinct active days and seasons;
- verified educational/provable-fair checks;
- community moderation and accepted contributions;
- creator commerce and referrals with quality/retention gates;
- responsible-tool use and voluntary limits;
- normalized play skill/decision quality where legitimately measurable;
- diminishing-return wager participation.

Use concave contribution transforms such as `score = sqrt(value)` or logarithmic bands, per-person and per-epoch caps, and nontransferable legacy achievements. Status-gamification research suggests disclosure can increase status-good demand but effects vary by segment; it should never expose loss amounts or shame low spenders. [Status goods and gamification](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4762511).

### 3. Community surplus engine

Allocate a disclosed portion of non-wager external revenue—market fees, sponsorship, cosmetics, creator commissions, premium analytics, API/service revenue—to Heartwood. Diversification is more resilient than dependence on grants or wagering alone; Ethereum's public-goods funding review similarly emphasizes mixed grants, contracts, and commercial revenue. [EF funding diversification](https://blog.ethereum.org/2026/02/27/project-odin).

Run separate, capped community rounds for creators/tools/public goods. Quadratic funding can favor broad unique support, but matching requirements can explode and reciprocal/Sybil behavior is documented. Use verified uniqueness, capped matching, pairwise/collusion analysis, and preferably privacy-preserving anti-collusion infrastructure; do not use wagering volume as voting identity. Sources: [original QF mechanism](https://arxiv.org/abs/1809.06421), [matching-fund and strategic limits](https://arxiv.org/abs/2010.01193), [ZK/MACI collusion discussion](https://ethereum.org/zero-knowledge-proofs).

### 4. PLANK utility without reflexive promises

- burn only after an exact oracle-bounded quote with `minBoostWei`, deadline, and expected round;
- report token supply delta and user balance delta;
- fund boosts from real ETH, never token mark-to-market accounting;
- utility may include cosmetics, governance over bounded community allocations, creator access, verifier badges, and fee discounts that remain solvent;
- never count burned token value as ETH prize backing.

### 5. Sustainable referrals and creators

Pay referrals from the founder acquisition budget or incremental external commerce margin, not player prize liabilities. Vest rewards against retained, non-self-referred users; cap household/device/payment-cluster farming; publish reversal rules. Creator revenue shares must be prospective, rules-hashed, and cannot change odds or settlement.

## Fair execution

- Commit the drand target from the scheduled round envelope before betting closes.
- Bind outcome derivation to chain ID, contract, rules hash, game/epoch ID, target round, and verified randomness.
- drand identifies a network cryptographically by chain hash and produces threshold-verifiable public randomness; clients should verify values and network identity. [drand protocol](https://docs.drand.love/docs/specification/), [EVM-compatible network information](https://docs.drand.love/developer/).
- Use rejection sampling for lottery ranges rather than modulo mapping.
- No settle-or-void choice after randomness exists or can be known.
- Use per-round canonical seats and isolated aggregate trees; never keeper-built winner denominators.
- Claims are pull liabilities and remain correct without indexer participation. OpenZeppelin documents the pull-payment pattern as isolating funds in escrow and avoiding recipient-blocked execution. [OpenZeppelin security](https://docs.openzeppelin.com/contracts/4.x/api/security).

## Safety is growth infrastructure

Trust, affordability, and long player lifetimes dominate short extraction. Provide default deposit/loss/time limits, reality checks, cooldowns, self-exclusion, transparent session P&L, no autoplay, no near-miss substitution, no losses disguised as wins, and automated identify/act/evaluate interventions.

Evidence for individual responsible-design tools is mixed and sometimes weak, so Plank should preregister evaluations and publish effect sizes rather than claim certainty. [Scoping review](https://pmc.ncbi.nlm.nih.gov/articles/PMC8057587/). Standards cover informed decisions, assistance, self-exclusion, product features, advertising, research, and payments. [NCPG Internet Standards](https://www.ncpgambling.org/responsible-gambling/internet-standards/).

Any launch is jurisdiction-gated. The UKGC technical standards specifically address game rules, time-critical events, randomness, progressive jackpots, interrupted play, limits, responsible design, and in-play betting; game math, artwork, theoretical RTP, RNG mapping, and live behavior may require independent testing. [UKGC RTS](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/3-remote-gambling-and-software-technical-standards), [testing strategy](https://www.gamblingcommission.gov.uk/strategy/testing-strategy-for-compliance-with-remote-gambling-and-software-technical/3-procedure-for-testing). Crypto does not remove operator, source-of-funds, or third-party duties. [UKGC crypto guidance](https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/page/blockchain-technology-and-crypto-assets).

## Critical failure modes

1. **False positive-sum language:** redistribution and burn are not newly created player wealth.
2. **Recurring-fee drag:** rollover shrinks unless fresh funding covers the fee, consolation, and increase.
3. **Impossible cadence promise:** fixed minimum inflow cannot fund an unbounded increasing payout every fixed interval.
4. **Sequential split dilution:** applying 20/40/40 after a 40% reserve carve violates ratified gross economics.
5. **Shared jackpot race:** historical epochs must not draw from one mutable global pot.
6. **Reset underfunding:** the next higher base must be reserved before the current epoch becomes drawable.
7. **Whale/status extraction:** rankings based on raw wager/loss encourage rent dissipation and harm.
8. **Sybil public-goods capture:** naive QF and one-wallet-one-person mechanisms are manipulable.
9. **Token circularity:** token price, burns, and emissions cannot be counted as hard ETH backing.
10. **Adaptive randomness:** caller-timed target selection, selective timeout, modulo bias, and missing domain separation undermine fairness.
11. **Liability opacity:** physical contract balance is not free capital.
12. **Legal evasion assumption:** onchain execution does not make gambling, AML, consumer-protection, tax, or sanctions duties disappear.

OWASP identifies business-logic flaws as economic/state-transition failures even where low-level protections are correct and recommends formal verification and property fuzzing for accounting paths. [OWASP business-logic guidance](https://scs.owasp.org/sctop10/SC02-BusinessLogicVulnerabilities/) and [SCSVS](https://scs.owasp.org/SCSVS/).

## Implementation plan

### Gate 0 — ratification

Freeze `rho`, 20/40/40, lottery `phi`, consolation, minimum increase, base ratchet, coverage rule, maximum target, equality boundary, PFSS/alternative allocation, dust policy, claim lifetime, and jurisdiction matrix in a human-readable rules document and `rulesHash`.

### Gate 1 — executable economics

Extend the BigInt reference model with exact one-pass routing, recurring-fee minimum funding, reset coverage, epoch isolation, and adaptive simulations over volume, hit sequences, whale concentration, Sybils, and outages. Optimize robust percentiles, not a single mean path.

### Gate 2 — new contracts

Build versioned `PlankEconomicRouterV2`, `PlankCrashVNext`, and `PlankPowerboardV2`. Do not mutate historical liabilities. Use isolated typed buckets, sequential epoch finalization, scheduled randomness envelopes, per-round canonical seats, objective survivor aggregates, and pull claims.

### Gate 3 — adversarial proof

Stateful fuzz every transition; differential-test Solidity against BigInt; formally specify conservation, monotonic sealed prizes, higher covered reset bases, outcome finality, draw-order independence, and withdrawal liveness. Test one wei, maximum values, forced ETH, reentrancy, malicious sinks/tokens, same-block races, missing keepers, reorgs, and every hit/miss permutation.

### Gate 4 — independent review

Obtain economic/game-math review, smart-contract audits, randomness review, front-end/session-key review, operational threat model, and applicable licensed test-house/regulatory review. Publish fixes and rerun the entire proof suite.

### Gate 5 — measured launch

Shadow simulate live chain conditions, then capped testnet, then capped jurisdiction-approved production. Publish solvency, liabilities, effective RTP, prize/founder provenance, burn proof, and safety metrics. Ratchets grow only from realized coverage; no emergency role may redirect player/community liabilities.

## Success metrics

Measure retained healthy users, voluntary-limit adoption, withdrawal success, latency/finality, verifier use, creator/public-good output, external-revenue share, community capital, founder runway, burn execution quality, prize coverage, concentration, and harm indicators. Gross wager volume is diagnostic—not the north-star objective.
