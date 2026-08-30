# SPEC — Crash family go-live hardening (Phase 3 gate)

Status: **SPEC — no contract change made yet.** Author: Fable (`claude-fable-5`), 2026-08-29.
Applies to `contracts/PlankCrashDrand.sol` (+ `PlankBank`, `PlankRakeDistributor`,
`PlankPowerboard`, `PlankProgression`, `PlankFuelBooster`, `DrandBeacon`). The family is
BUILT + TESTED, NOT DEPLOYED, and has no arcade route in the app. It does not deploy until
this spec is ratified, the three hardenings are in bytecode, and the §6 gauntlet is green.

## 0. Honest baseline (verified in code, 2026-08-29)
- The game is **parimutuel**: winners split the round pool (player stakes + a reserve seed)
  by `stake × multiplierAtCashOut` weight; rake `rakeBps` is taken from the pool;
  `keeperRewardBps` share of the rake goes to whoever settles (`settleRound`, l.793–806) —
  **it is 0 in every current deploy config** (§6c).
- Randomness: the round locks to `targetDrandRound = nextRoundAfter(lockTs) + 20 periods`
  (`lockRound`, l.687). Reveal is permissionless; `cashOut` refuses once the round is publicly
  due but not yet revealed (`AwaitingEntropyReveal`, l.716) — the 2026-08-18 MEDIUM fix.
- `presetCashOut(target)` writes a FUTURE `cashOutBlock = lockBlock + invert(target)`
  (l.755) and is allowed only while the target round is not yet due.
- The reserve seeds `reserve·num/den` into each round (`_seedFromReserve`, l.434), capped
  by `reserveFloorWei`; `reserveCap` spills overflow to `jackpotSink`.

## 1. Hardening (a) — bind bet + auto-cashout into the pre-round commitment
**Problem class.** Any path that lets a cash-out target be chosen or changed AFTER any
information about the crash point could exist (on-chain or off-chain) is exploitable. The
current gate is a TIME check against the beacon; it is correct today but relies on the
relay-vs-due-time ordering argument in the comments — a class defense, not an instance fix,
is required.

**Mechanism.**
1. `placeBet(uint256 autoCashOutBps)` — the auto-cashout target is a **required** parameter of
   the bet, stored at bet time, and immutable for that (round, player). `presetCashOut` is
   REMOVED. (A player who wants "manual" play passes `autoCashOutBps = 0`, meaning none.)
2. Manual `cashOut(roundId)` remains, but records `cashOutBlockOf = block.number` and is
   valid **only if `block.number < r.revealBlock`**, where `revealBlock` is the first block
   at which the target drand round is due by the chain's own clock: the contract computes
   `revealNotBefore = beacon timestamp of targetDrandRound` at lock and stores it; any
   cash-out with `block.timestamp ≥ revealNotBefore` reverts, regardless of whether
   `revealEntropy` has been called. This makes "cash-out strictly before the randomness
   exists anywhere" a bytecode invariant rather than a race between relayers.
3. Settlement uses `min(manualCashOutBlock, lockBlock + invert(autoCashOutBps))` as the
   effective cash-out block, i.e. the earlier of the two — the committed auto-target is a
   ceiling the player cannot raise after the fact.

**Invariant I-a.** For every (round, player): `effectiveCashOutBlock` is a pure function of
data written at or before `lockBlock` plus at most one manual action taken while
`block.timestamp < revealNotBefore`. **Test:** fuzz `revealEntropy`/relay ordering and
prove no sequence lets a player set a cash-out after `revealNotBefore`.

## 2. Hardening (b) — deterministic bankroll caps in bytecode (WINR-style)
The reserve is the house-side capital. Caps that do not scale DOWN with the bankroll are the
documented cause of most on-chain casino failures.
1. **Seed cap per round:** `seed ≤ reserve × SEED_MAX_BPS / 10_000` in addition to
   `num/den` (make the fraction a bounded immutable, ceiling in bytecode).
2. **Single-payout cap:** at `claim`, the HOUSE-SIDE (Vault-seed) portion of any single
   wallet's payout is capped at `reserveAtLock × SINGLE_PAYOUT_CAP_BPS / 10_000`; the
   player-funded parimutuel portion is never capped. The excess is credited back to the
   Vault (pool conserved wei-for-wei — nothing is "lost", only re-weighted toward future
   rounds; same-round redistribution would be an O(n²) water-fill over a sybil-growable
   winner list, so it is deliberately not done on-chain). Proposed 200 bps (2%).
   **This is a PER-WALLET UX bound** ("no single ticket wins more than 2% of the
   bankroll"), **not a sybil bound** — N wallets get N caps. Neither is 2.6's fair-odds cap
   (re-review NEW-1: it bounds house money per WINNER, and a colluding group recycles its
   losers' stakes through the player pot). The only sybil/collusion bound is the seed-income
   budget, 2.7 below. (Review MED-3 / §2.2 wording; corrected by re-review NEW-1.)
6. **Seed distributed by PROFIT weight (review HIGH-1):** the round pool is two pots. The
   player-funded pot splits by the classic `stake × mult` weight. The Vault SEED splits by
   `stake × (mult − 1)` (the profit weight) **and** is capped per winner at that same
   `stake × (mult − 1)` — i.e. at most the profit a fair-odds book would have paid on the
   risk actually taken. Without this, a 1.0001× auto target (P(win) = 0.9999) collected the
   ENTIRE seed every round for a 0.4% risk: 4 sybil wallets drained 18.5% of a 2 ETH
   bankroll in 7 rounds (reviewer's probe, reproduced in `seedNotFarmableAtMinExit`).
   Chosen over a `SEED_MIN_MULTIPLIER_BPS` eligibility floor (proposed 15000): a floor is a
   cliff — the same farm re-parks just above it at P = 2/3 for the full seed — while the
   fair-odds cap is continuous in the exit and bounds the extraction RATE at every
   multiplier. When the cap binds the remainder returns to the Vault; when no winner has
   profit weight (all exits at exactly 1.00×) the seed returns whole. Conservation exact.
   **What this is NOT (re-review NEW-1): a sybil or collusion bound.** The cap limits house
   money per winner at `stake × (m − 1)`, but the LOSING stakes go to the PLAYER pot, not to
   the house. A colluding group — an absorber at the minimum target that wins the player pot
   whenever the others lose, plus B₁..₃ at target m sized so Σ`stake × (m − 1)` ≥ seed — has
   EV/round = `seed/m − rake × Σstakes` > 0 for m ≳ 1.06 (reviewer: 15.6% of a 2 ETH bankroll
   in 6 rounds, group +0.136 ETH; reproduced: 18.5% in 8 rounds at m = 1.088 on 0f21383). In
   a parimutuel game the Vault seed is pure subsidy; no per-round or per-winner cap bounds
   what a coordinated field can extract. Only 2.7 does.
7. **Seed bounded by HOUSE INCOME (re-review NEW-1, structural):** a rolling `seedBudget`
   (wei) in bytecode. `settleRound` credits it with the round's **net rake** (rake minus the
   keeper bounties — the rake the house actually retains, whether it lands in the Vault or
   the treasury); every seed drawn is debited from it; a rescued seed (void), a busted
   round's returned seed, and a capped payout's excess are credited back (never paid, never
   spent). Each round's seed is
   `≤ min(seedBudget × SEED_INCOME_MULTIPLE_BPS / 10⁴, reserve × SEED_MAX_BPS / 10⁴, drawdown circuits)`,
   so at all times **cumulative house money paid out ≤ `SEED_BOOTSTRAP_BUDGET_WEI` +
   `SEED_INCOME_MULTIPLE` × cumulative net rake earned.** At the PROPOSED 10000 bps the house
   recycles at most 100% of what it earned: "positive-sum for the community" becomes
   literally true — the community gets the rake back as seed, never more, and a colluding
   group can at best recover its own retained rake, netting at most the one-off bootstrap
   minus the bounties it paid (strictly negative once the bootstrap is spent). The
   bootstrap (`seedBootstrapBudgetWei`, constructor input, ≤ `reserveCap/10` enforced when
   the Vault is capped) is the only allowance that exists before any rake has been earned.
   Also: `autoCashOutBps == 10000` (elapsed 0, P(win) = 1) is rejected `BadAutoTarget` —
   every committed target takes ≥ 1 block of crash risk. Tests
   `colludingAbsorberIsNotProfitable` (reviewer's absorber + 3-winner probe at
   m ∈ {1.088, 1.25, 1.6, 2.6}, 8 rounds, unbiased PRNG randomness, with and without the
   bootstrap; FAILS on 0f21383), `seedBoundedByHouseIncome`, `autoTargetMustExceedOneX`.
3. **Daily-loss circuit:** rolling 24h window of `reserve` net change; if the drawdown
   exceeds `DAILY_DRAWDOWN_BPS`, the next round seeds 0 from reserve (players-only
   parimutuel continues — the game never stops, the house simply stops subsidizing).
4. **Drawdown mode:** if `reserve < reserveFloorWei`, seed = 0 (already true). Add a
   `reserveHighWaterMark` so a 50% drawdown from HWM also forces seed = 0 until refilled.
5. **Staged deploy caps:** `maxStakePerWalletBps` and `minPoolSize`/`maxPool` are
   immutable per deploy; the §6.5 "scale up with incident-free time" is realized by
   deploying a NEW instance with higher caps and rolling the reserve forward via
   `jackpotSink`/funding — not by a settable cap.

## 3. Hardening (c) — funded keeper rewards
`keeperRewardBps` must be > 0 in every ratified deploy config; proposed **500 bps of rake**
(5% of rake, not of pool). Also reward `revealEntropy` and `lockRound` callers from the same
rake budget (`KEEPER_REVEAL_BPS`, `KEEPER_LOCK_BPS`), since liveness depends on all three
being called promptly. Payouts remain `_asyncTransfer` pull-payments (never push).

## 4. Timelock-encrypted commitment (next iteration; noted, not required for go-live)
Use drand quicknet timelock encryption for any house-side seed so the reveal is
unwithholdable (the round signature IS the key). Domain-separate: `HMAC(beacon ‖ round ‖
betId)`. Always close betting before the target round. Tracked as Phase 3.1.

## 5. Threat model → required "attack fails" tests
| # | Threat | Test |
|---|---|---|
| C1 | Off-chain-known randomness used to place/raise a cash-out | `noCashOutAfterRevealNotBefore` (fuzz relay timing) |
| C2 | Auto-target changed after bet | `autoTargetImmutable` |
| C3 | Whale drains reserve via one round | `singlePayoutCapped`, `seedCapped` |
| C4 | Sustained losing streak empties reserve | `dailyDrawdownHaltsSeed`, `hwmDrawdownHaltsSeed` |
| C5 | Keeper starvation (nobody settles) | `keeperPaidOnLockRevealSettle`, existing `voidStaleRound` liveness |
| C6 | Reserve seed stranded in voided round | existing HIGH fix (`_rescueSeed`) regression test |
| C7 | Reentrancy on claim/settle | existing tests + pull-payment assertion |
| C8 | Beacon spoof / stale round | beacon verifies BLS once; contract never settles on `randomnessOrZero == 0` |

## 6. Proposed constants (ratification required)
| Constant | Proposed | Rationale |
|---|---|---|
| `SINGLE_PAYOUT_CAP_BPS` | 200 | 2% of reserve at lock — WINR-class bound |
| `SEED_MAX_BPS` | 500 | house never puts >5% of bankroll into one round |
| `SEED_MAX_BPS_CEILING` (bytecode) | **1000** (was 5000) | review MED-3: the constant ceiling is 2× the proposal, not 10× — no deploy config can put >10% of the bankroll into one round |
| `CASHOUT_CLOSE_MARGIN_PERIODS` (bytecode) | **2 periods = 6 s** on drand quicknet | review MED-1: manual cash-outs close `revealNotBefore = emission − margin` on the CHAIN clock (absorbs sequencer lag < 6 s); belt: `_cashOut` also reverts once `beacon.isRoundAvailable(target)` regardless of clock |
| seed distribution key | `stake × (mult − 1)`, per-winner cap at the same | review HIGH-1 (§2.6): fair-odds bound on house money; not a tunable — a `SEED_MIN_MULTIPLIER_BPS` floor (15000) was considered and rejected as a cliff |
| daily window peak on roll | `max(reserve, prevPeak × (1 − DAILY_DRAWDOWN_BPS/10⁴)^n)` | review MED-2: the peak decays by the allowed drawdown per elapsed window instead of resetting to the depleted balance (which allowed ~2× the budget across a boundary); rescued seeds / capped-payout excess are RETURNS and do not raise the window peak |
| `DAILY_DRAWDOWN_BPS` | 1500 | 15%/24h halts subsidy, not play |
| `HWM_DRAWDOWN_BPS` | 5000 | 50% from high-water halts subsidy until refilled |
| `keeperRewardBps` (settle) | 500 of rake | liveness is worth 5% of rake |
| `KEEPER_REVEAL_BPS` / `KEEPER_LOCK_BPS` | 100 / 100 of rake | cheap calls, small bounty |
| max multiplier cap | **OWNER MUST SUPPLY** (§2 open question 4) | not a Fable proposal |
| `rakeBps` | must be > 0 (constructor reverts) | review LOW-2: every keeper bounty is bps OF THE RAKE, so rake 0 = the "nobody settles" failure (c) forbids |
| `SEED_INCOME_MULTIPLE_BPS` (bytecode) | **10000** | re-review NEW-1 (§2.7): cumulative seed ≤ 100% of cumulative net rake (+ bootstrap) — the house recycles at most what it earned; the only sybil/collusion bound |
| `SEED_BOOTSTRAP_BUDGET_WEI` (constructor `seedBootstrapBudgetWei`) | **`reserveCap/10` = 0.2 ETH at Stage-1** | re-review NEW-1: the only seed allowance before rake exists; constructor rejects > `reserveCap/10` on a capped Vault; it is the maximum a colluding group can ever net, once |
| minimum auto target | **10001 bps** (1.00x rejected) | re-review NEW-1 (b): `_invertMultiplier(10000) = 0` = a P(win)=1 absorber |
| `estimatedPayout` cap base before lock | current `reserve` | re-review NEW-2: `reserveAtLock` is 0 during BETTING, which zeroed the seed portion of the virtual-lock estimate; test `estimateEqualBettingAndLive` |

Test fixtures (`test/contracts/helpers/crashHardening.ts`) now use exactly these PROPOSED
values so every suite exercises the caps and circuits that would ship (review MED-3). They
remain unratified; `scripts/deploy-casino.ts` is still the only place deploy values live.

Review LOW-1: `cashOut` reverts `TargetUnreachable` once `elapsed > maxMultiplierElapsedBlocks`
(the crash has certainly happened; recording a cash-out there was a guaranteed loss).
Review LOW-3: `estimatedPayout` prices a committed auto target during BETTING against a
virtual lock (`elapsed = invert(auto)`) and the provisional pool, so the bet slip shows a real
number; a manual-only bet reads 0 until it exits.
| Stage-1 bankroll cap (`reserveCap`) | 2 ETH-equiv | small until incident-free time accrues |

## 7. Go-live sequence (§6 gauntlet)
Ratify §6 → implement (a)(b)(c) → unit + invariant + C1–C8 tests (≥5 seeds) → multi-lens
Fable review to green → real-signer write-path on fork/testnet → staged deploy at Stage-1
caps → arcade route in nav ONLY after the write-path proof (§3.8). Copy discipline: show
`estimatedPayout()` — labelled as the player's CURRENT share, which may shrink as others cash
out, never as an upper bound (re-review NEW-3) — never `stake × multiplier`; "positive-sum
for the community, not positive-EV per bet"; fixed daily cadence, no surprise triggers.

Go-live checklist additions (re-review):
- [ ] **NEW-4: pin `CASHOUT_CLOSE_MARGIN_PERIODS` to the target chain's MEASURED sequencer
      timestamp-drift bound** (for an Arbitrum Orbit chain: the `MaxTimeVariation`
      parameters — `delaySeconds`/`futureSeconds` — of the deployed SequencerInbox, read from
      the chain, plus observed drift over a multi-day sample). The bytecode value is 2
      periods = 6 s on quicknet; it is a PROPOSAL, not a measurement. Never assert "< 6 s"
      untested: if the measured bound exceeds the margin, raise the constant (and
      `TARGET_ROUND_SAFETY_PERIODS` with it) before deploy.
- [ ] NEW-1: confirm `seedBootstrapBudgetWei ≤ reserveCap/10` in the deploy config and that
      `seedBudget()` on the deployed contract equals it before the first round is seeded.
