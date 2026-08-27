# Decision record: Plank economic kernel and accounting boundaries

Status: implementation gate; candidate mechanisms remain subject to simulation and audit  
Date: 2026-08-27

## Protected identity

Plank is a bounded pari-mutuel community game. It is not a house-banked fixed-payout casino.

Every valid implementation must satisfy:

```text
roundGross = roundSeed + playerPool
distributable + roundRake = roundGross
totalPlayerClaims + roundRemainder = distributable
totalPlayerClaims <= distributable
```

The Vault, Powerboard, fuel pool, treasury revenue, open pools, and player claims are distinct liabilities. No wei may inhabit two accounting buckets simultaneously.

## Global balance sheet

At any observable state:

```text
physicalAssets = address(this).balance + pullPaymentEscrowBalance

requiredAssets =
    vaultReserve
  + sum(openRoundPools)
  + sum(settledUnclaimedRoundLiabilities)
  + refundableOrCarriedPlayerStakes
  + accumulatedTreasuryRake
  + keeperCredits
  + failedCredits
  + otherExplicitLiabilities

physicalAssets >= requiredAssets
```

Powerboard and FuelBooster require equivalent local balance sheets. Cross-contract reporting must not count an outbound transfer as both sender and receiver assets.

Forced ETH is `unaccountedAssets = physicalAssets - requiredAssets`; it is not silently revenue or reserve. A predetermined reconciliation policy must assign it without changing completed rounds.

## Round transition ledger

### Start

```text
Vault reserve       -= seed
Open round pool     += seed
```

The seed is recorded once as `rolledOverFromPrevious`/`roundSeed`; it is no longer Vault reserve while exposed to the round.

### Bet

```text
Contract assets     += gross payment
Progression premium += configured premium, if retained
Open round pool     += net stake
```

Current progression pricing is under redesign because it rewards cumulative wagering. No replacement may fabricate a fee or silently reduce the recorded player stake.

### Lock

No value moves. Round envelope, target schedule, eligible target grid, player stakes, and player targets become governed by immutable phase rules.

### Result

```text
Open round pool     -= roundGross
Round rake liability += roundRake
Settled allocation   += distributable
```

Keeper, Vault, treasury, and Powerboard shares are subdivisions of published rake or explicit remainder—not additional liabilities minted beside it.

### Claims

```text
Settled claim liability -= payout
Pull-payment liability  += payout
```

Moving value into a pull-payment escrow changes custody location but does not erase the player liability.

### All-bust

Only objective survivor aggregate `S == 0` permits:

```text
Settled allocation -= distributable
Vault reserve      += distributable
```

Registration inactivity is not evidence of all-bust.

### Dust/remainder

Every allocation rule produces a deterministic remainder through integer division. The selected production rule must assign it once after claims are fully determined. Candidate policy: route remainder to the Vault, with a public event and no claim-dependent timing advantage.

## Allocation candidates

### SM — current stake-multiplier allocation

```text
w_i = survived ? stake_i * target_i : 0
p_i = D * w_i / W
```

Strengths:

- bounded and simple;
- high targets have strong strategic meaning;
- exact additive sybil invariance before cap evasion.

Risks:

- target weighting applies to the whole distributable;
- a high-target survivor can dilute a timid survivor below stake even when the pool could return both stakes;
- communal seed increases target-shading incentives;
- survived-but-negative outcomes require careful presentation.

### SO — stake-only survivors

```text
w_i = survived ? stake_i : 0
p_i = D * w_i / W
```

Strengths:

- conventional pari-mutuel allocation;
- easier comprehension;
- target does not amplify conditional concentration.

Risks:

- weak reward for selecting a higher target;
- likely minimum-target clustering;
- live target interaction may lose economic meaning.

### PFSS — survivor base plus risk surplus

```text
S = sum survivor stake
P = min(D, S)
Q = D - P
R = sum survivor stake_i * (target_i - 1x)

base_i    = P * stake_i / S
surplus_i = R == 0 ? 0 : Q * stake_i(target_i - 1x) / R
payout_i  = base_i + surplus_i
```

Strengths:

- bounded;
- prioritizes a survivor base allocation before target competition;
- retains high-target competition over genuine surplus;
- compatible with two objective prefix aggregates;
- reduces losses-disguised-as-wins caused specifically by target weighting.

Risks/open cases:

- conservative target clustering;
- `R == 0` surplus disposition;
- terminology must not imply guaranteed principal;
- equilibrium is unproven;
- two integer allocation stages increase dust;
- minimum target and exact 1.00x semantics are load-bearing.

## Current candidate decision

PFSS is the leading research candidate, not yet the selected production mechanism. The current SM rule remains the compatibility baseline. Selection requires reproducible adaptive-strategy simulations, comprehension testing, and differential Solidity tests.

No production UI or contract should be finalized around either formula until this gate closes.

## Objective settlement decision

Registration-dependent denominator construction is rejected for the next contract version.

The leading construction is two target-indexed prefix accumulators:

```text
stakeTree[targetTick] += stake
riskTree[targetTick]  += stake * (target - 1x)
```

For crash `C`:

```text
winningTick = greatest grid target <= C
S = stakeTree.prefix(winningTick)
R = riskTree.prefix(winningTick)
```

This objectively determines all-bust and PFSS aggregates without enumerating players or trusting registration. Each player claims from their stored seat.

Required controls:

- target grid fixed in the round envelope;
- raw `target <= crash` predicate preserved at every boundary;
- add/subtract changes both trees atomically;
- replacement nonce and phase prevent duplicate or post-freeze mutation;
- subtraction underflow reverts;
- tree size and maximum aggregate are constructor-validated;
- upgrades cannot change grid or accumulator semantics for a live round;
- individual stored seats and tree totals are differential-tested after every mutation;
- target ticks use explicit precision. One-basis-point 1.01x–100x contains 989,901 ticks; 9,900 ticks implies 0.01x steps.

## Live interaction decision

The economic action is a target selection, not conventional house-game cash-out.

Safe baseline:

```text
bet includes safeTarget
optional signed update is submitted before intentClose
host acknowledgment is presentation only
chain acceptance changes the authoritative target
missed update leaves safeTarget unchanged
```

Candidate interaction modes to test separately:

1. one replace-once target;
2. upward-only “raise risk target”;
3. two sealed stake tranches, safe and hunt, with fixed total exposure.

Do not mix modes in one production round until replacement ordering and comprehension are proven.

## Progression decision

Community reputation remains. Wager-volume discounts and wager-earned expansion of loss capacity do not.

Protocol concentration limits apply equally to economic participants. Responsible limits are user/beneficial-owner controls where identity is legally required. Cosmetics, contribution recognition, moderation, verification, education, art, and governance may use ranks without changing gambling price or odds.

Per-address controls must never be described as sybil-resistant.

## Powerboard decision

Powerboard remains a protected slower communal layer, subject to redesign gates:

- segregated jackpot liability;
- fixed schedule;
- target beacon committed before eligibility accumulation;
- chain/contract/rules/epoch/network/round domain separation;
- bounded drawer reward;
- deterministic rollover and must-hit semantics;
- no near-miss or chase presentation;
- no eligibility function selected without sybil and legal analysis.

Linear stake weight is arithmetically sybil-invariant but whale-concentrated and wagering-intensity-linked. Per-wallet base tickets and concave per-wallet weights are sybil-vulnerable. HHI is a disclosure metric, not a remedy.

## Evidence gates

Before integrating the settlement prototype into `PlankCrashDrand`:

1. reference economics tests conserve all candidates;
2. Solidity primitives match reference vectors;
3. target tree survives randomized adds, replacements, and underflow attempts;
4. economic simulations cover seed ratios, player counts, whale/minnow mixtures, adaptive best response, and risk aversion;
5. PFSS edge cases have explicit policy;
6. global accounting includes pull-payment escrow and cross-contract transfers;
7. migration is a new version, not an unsafe mutation of live rounds;
8. independent audit reviews the exact selected formula and bytecode.
