# Heartwood: monotonic compounding constitution

Status: normative design gate; not a claim that the current contracts implement every item.

## Ratified Plank economics are the constraint

The state-of-the-art accounting design does not replace Plank's selected economics. It preserves the ratified gross crash rake and its economic destinations:

```text
gross player rake                         4.50% of fresh wagers
$PLANK burn                              20% of gross rake = 0.90% of wagers
Vault-first community prize engine       40% of gross rake = 1.80% of wagers
founder/dev/ops                           40% of gross rake = 1.80% of wagers
```

`keeperRewardBps` is zero while founders operate the keeper. If it becomes nonzero, it is removed first and the 20/40/40 split applies proportionally to net rake.

The **Vault-first community prize engine** is one economic leg. It funds the short-cycle crash subsidy first; covered excess and cap overflow fund Powerboard. It is not an additional fourth leg minted on top of the ratified 100% split.

### Current implementation mismatch

The current setup applies `reserveShareBps = 4000` before sending the remainder to a distributor that again applies 20/40/40. With a zero keeper reward, its effective allocation is:

```text
Vault                                  40.0% of gross rake = 1.80% of wagers
burn                  20% of remainder = 12.0% of gross rake = 0.54% of wagers
Powerboard            40% of remainder = 24.0% of gross rake = 1.08% of wagers
founders              40% of remainder = 24.0% of gross rake = 1.08% of wagers
```

That is not the ratified 0.90% / 1.80% / 1.80% wager split. The replacement router must calculate every leg from the same gross-rake base in one pass. Sequential percentages are prohibited unless the specification explicitly states their effective gross percentages.

For gross player rake `R`, keeper reward `K`, and `Q = R - K`:

```text
burn       = floor(Q * 2000 / 10000)
community  = floor(Q * 4000 / 10000)
founders   = Q - burn - community
```

The community amount enters the Vault-first engine. Powerboard funding from that engine is a transfer between community liabilities, not a second expense and not founder revenue.

## Ratified recurring Powerboard founder fee

Powerboard additionally charges the founders' flat lottery-engine fee on the gross capital constituted for each sealed epoch, including carried rollover. This is distinct from the crash-rake founder leg and must be named and reported separately.

For epoch `e`:

```text
R_e = net rollover entering the epoch
A_e = fresh allocation from the Vault-first community engine
X_e = explicit external lottery funding
phi = immutable lottery founder-fee rate
G_e = R_e + A_e + X_e
F_e = floor(G_e * phi)
P_e = G_e - F_e
```

`P_e` is the only advertised jackpot. The fee is escrowed when the epoch seals, so a hit pays the winner exactly `P_e`; no claim-time fee exists.

### Miss-growth financing condition

If consolation `C_e` is paid, then `R_(e+1) = P_e - C_e`. For the next net jackpot to grow by at least `Delta_e`:

```text
P_(e+1) >= P_e + Delta_e
```

the minimum fresh funding is:

```text
A_(e+1) + X_(e+1)
  >= ceil((phi * P_e + Delta_e) / (1 - phi)) + C_e
```

The implementation must use the algebraically equivalent integer formula derived from the exact floor policy and prove the boundary exhaustively. An epoch cannot seal until this condition is funded. Reapplying the fee to rollover without this funding would shrink the prize and is forbidden.

### Higher base after every jackpot

Let `B_k` be the advertised net base for jackpot cycle `k`. The immutable ratchet is:

```text
B_(k+1) = B_k + max(minBaseStep, floor(B_k * baseGrowthBps / 10000))
grossReset_(k+1) = ceil(B_(k+1) / (1 - phi))
```

Before cycle `k` can expose its jackpot to a winning draw, a distinct reset liability must already cover `grossReset_(k+1)`. On a hit:

```text
winner receives P_e in full
founder fee was already escrowed
next cycle opens with net base B_(k+1) > B_k
```

The current winner pot, founder escrow, and next-cycle reset reserve are three different liabilities. No shared global jackpot balance may represent more than one of them.

### One-pass observability

The public accounting surface must expose cumulative and current values for:

- gross fresh-wager rake;
- burn allocation;
- Vault-first community allocation;
- crash-rake founder allocation;
- gross lottery capital constituted;
- lottery founder fees, including the portion attributable to rollover;
- net winner-take-all prizes;
- reset reserve and next guaranteed base;
- consolation paid and rollover carried.

This preserves Plank's original economic split while upgrading execution, isolation, solvency, monotonicity, and auditability.

## The conservation boundary

One wei cannot simultaneously remain protected principal and be paid as a prize. No finite closed pool can guarantee an eternally increasing payable prize while continuing to pay winners. Plank therefore makes the valuable *system* compound without pretending that a current-cycle pot never falls after a payout.

## Minimum sacrifice assumption

The player bet is the assumed sacrifice that powers a qualifying iteration. Let `m_min` be the minimum number of independently eligible players and `b_min` the minimum fresh bet per player:

```text
W_min = m_min * b_min
```

Only a locked iteration satisfying both thresholds enters the infinite-iteration growth theorem. Before lock, commitments remain refundable and do not finance ratchets. Under infinitely many qualifying iterations, ratified community inflow is unbounded. This guarantees eventual funding of every finite coverage target, not an unfunded increasing payout at fixed cadence. Games and lottery epochs seal only after the next monotonic promise is fully escrowed.

Every incentive above the sacrifice floor is a disclosed, rules-hashed transfer designed to increase durable participation, capital, utility, safety, creator output, external revenue, or trust. Raw losses, covert steering, circular wash activity, and unverified wallet multiplication are not valuable contributions.

## Segregated value buckets

1. **Heartwood principal** is restricted community backing. Its nominal ledger balance never decreases in normal operation. It cannot pay rake, founders, keepers, winners, or consolation prizes.
2. **Emission buffer** receives an explicit share of new player rake, donations, fuel backing, and any realized external yield. It funds round seeds and reset floors. It may decrease only through a disclosed prize allocation.
3. **Round pool** contains player stakes plus a separately identified emission subsidy. Rake applies only to player stakes. Every wei is assigned exactly once.
4. **Epoch jackpot** belongs to one immutable Powerboard epoch. It may pay or roll forward; it never shares a mutable balance with another pending epoch.
5. **Restricted liabilities** cover unclaimed winners, void refunds, keeper rewards, treasury rake, and rounding dust. They are never counted as free backing.

Heartwood principal must not be advertised as spendable liquidity. If it is deployed into a yield strategy, principal is no longer mathematically guaranteed: market, contract, oracle, bridge, governance, and counterparty risk must be named and bounded. Only realized, withdrawn yield may enter the emission buffer.

## State that must be monotonic

These counters and records only increase:

- protected principal and its high-water mark;
- cumulative player-funded prizes, community-subsidized prizes, and total winner receipts;
- cumulative PLANK provably burned and ETH actually delivered by fuel backing;
- cumulative Vault contributions, jackpot contributions, and rollover value;
- jackpot and seeded-prize high-water marks;
- lifetime participation, verified wins, streak records, badges, and completed community milestones;
- founder rake earned strictly from player stakes, reported separately from community capital;
- protocol solvency margin and coverage history.

Current round pools, current jackpots, emission buffers, and user balances are allowed to fall for their intended payouts. Their lifetime totals, high-water marks, and legacy artifacts preserve intrigue after a reset.

## Coverage-backed prize ratchets

A minimum advertised seed or reset prize may ratchet upward only when already covered. For proposed new minimum `m`, the contract must prove:

```text
emissionBuffer - allExistingEmissionLiabilities >= m * coverageRounds
```

The coverage horizon, allocation rule, and rounding are immutable in the rules hash. A ratchet cannot count expected future wagers or unrealized yield. If funding stops, the protected principal remains monotonic and covered commitments remain payable; the product must not promise that new commitments grow forever.

## Powerboard epoch isolation

Every deposit is assigned to exactly one of: unallocated future funding, a sealed epoch pot, a rollover credit, or protected principal. Closing an epoch freezes its pot and deterministic drand target. A later deposit cannot accrue to an old epoch, and drawing an old epoch cannot consume a newer epoch's funds. Misses may reduce the current pot through consolation; product language says "rolls over" unless net inflow actually caused growth.

Permanent intrigue after a jackpot hit comes from the jackpot high-water mark, lifetime distributed value, winner lineage, rollover streak record, and a coverage-backed reset seed—not false presentation of a pot that was just paid.

## Founder, keeper, and fuel provenance

- Vault seed, donations, protected principal, and fuel-backed ETH never enter the rake base.
- Founder/treasury revenue is the immutable remainder of player-funded rake after disclosed keeper and community allocations.
- Fuel transactions include `minBoostWei`, expected round, and deadline; a normal transaction cannot burn all PLANK for a zero or unexpectedly capped boost.
- Metrics distinguish ETH sent to Crash, ETH retained in the emission buffer, ETH spilled to Powerboard, and PLANK burned.

## Release invariants

No economic contract version ships until stateful tests prove:

```text
controlled physical ETH
= player principal liabilities
 + open-round liabilities
 + settled winner liabilities
 + protected principal
 + emission buffer
 + isolated epoch pots and rollover credits
 + void refunds
 + treasury and keeper liabilities
 + classified dust and forced surplus
```

Additionally:

- the same wei never occupies two buckets;
- settlement and draw order cannot change entitlements;
- every outcome uses a domain-separated, schedule-committed randomness envelope;
- every player entitlement remains withdrawable without continued wagering;
- no timeout permits choosing between a known result and a refund;
- all advertised minimums are net-of-fee and fully covered;
- all high-water and cumulative counters are independently reconstructible from events.

## Migration rule

This architecture is a new version, not an in-place semantic mutation. Existing balances must be reconciled by provenance before migration. Ambiguous surplus is restricted pending proof; it is never assigned to founders by default.
