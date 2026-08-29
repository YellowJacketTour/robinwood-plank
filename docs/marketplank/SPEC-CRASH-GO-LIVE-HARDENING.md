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
2. **Single-payout cap:** at `registerResult`, any single player's payout is capped at
   `reserveAtLock × SINGLE_PAYOUT_CAP_BPS / 10_000`; the excess stays in the pool and
   distributes to the other winners (parimutuel keeps the pool conserved — nothing is
   "lost", only re-weighted). Proposed 200 bps (2%).
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
| `DAILY_DRAWDOWN_BPS` | 1500 | 15%/24h halts subsidy, not play |
| `HWM_DRAWDOWN_BPS` | 5000 | 50% from high-water halts subsidy until refilled |
| `keeperRewardBps` (settle) | 500 of rake | liveness is worth 5% of rake |
| `KEEPER_REVEAL_BPS` / `KEEPER_LOCK_BPS` | 100 / 100 of rake | cheap calls, small bounty |
| max multiplier cap | **OWNER MUST SUPPLY** (§2 open question 4) | not a Fable proposal |
| Stage-1 bankroll cap (`reserveCap`) | 2 ETH-equiv | small until incident-free time accrues |

## 7. Go-live sequence (§6 gauntlet)
Ratify §6 → implement (a)(b)(c) → unit + invariant + C1–C8 tests (≥5 seeds) → multi-lens
Fable review to green → real-signer write-path on fork/testnet → staged deploy at Stage-1
caps → arcade route in nav ONLY after the write-path proof (§3.8). Copy discipline: show
`estimatedPayout()`, never `stake × multiplier`; "positive-sum for the community, not
positive-EV per bet"; fixed daily cadence, no surprise triggers.
