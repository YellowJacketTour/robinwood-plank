# FORENSIC AUDIT — Powerboard lottery funding, eligibility, and draw correctness

Date: 2026-09-03 · Commit under audit: `3369b14` (master)
Auditor method: **real runtime data**, not unit tests. A real Next.js server
(`npx next dev -p 3199`, this working tree) was driven by three independent
HTTP clients through the production API routes, and the database was then
audited **directly** with an independent re-implementation of every formula
(no imports from `lib/casino/*` or `lib/playtest-*` in the audit scripts).

## Backing store (exact)

- PostgreSQL 16 (`postgres:16-alpine`, docker container `plank-love-postgres-1`,
  `127.0.0.1:54329`) — the same engine and image the deployment uses
  (`docker-compose.inmotion.yml`; prod `/api/health` reports `"storage":"postgres"`).
- Fresh database `plank_audit`, migrated to head with `scripts/migrate-postgres.mjs`
  (through `089_playtest_explicit_auto_lock.sql`).
- Server: real `lib/playtest-rooms.ts` transaction path via
  `/api/playtest/rooms/*` — nothing mocked, no test doubles.

## Session driven

Room `0a5cec0f-2c93-46c2-9e19-80c582ab45b3`, three real authenticated clients:

- **AuditHost** (bootstrap admin, host) — bets every round.
- **AuditPunter** (invite-registered) — bets every round.
- **AuditViewer** (invite-registered) — never places a bet.

**14 SETTLED rounds** (9 funding rounds with varied stakes, 1 unfunded-hit
gate probe, 1 laboratory funding injection + sealing round, 1 funded jackpot
hit, 1 post-hit round, 1 funded miss, 1 final sealing round). One extra
host-only start attempt was refused by the server with `MINIMUM_PLAYERS`
(itself evidence the qualification gate is enforced at the API, not just in
settlement).

---

## 1. FUNDING — verdict: **FUNDED-CORRECTLY**

Recomputation formula, applied per round from RAW stored values only
(`playtest_round_seats.stake`, event `crashBps`, `playtest_rooms.policy`,
cumulative prior fresh wagers for the rake staircase):

```
pot            = Σ seat stakes                      (playtest_round_seats)
effRake        = rakeBps − min(⌊priorFreshWagers/rakeVolumeStep⌋·rakeStepBps, rakeBps−rakeFloorBps)
rake           = pot − ⌊pot·(10000−effRake)/10000⌋
netRake        = rake − keeper(=0)
community      = ⌊netRake·4000/10000⌋               (ratified 40/40/20 split)
contribution   = ⌊community·powerboardFundingBps/10000⌋   (policy: 10000 → full community leg)
```

Row-by-row reconciliation (opening + contribution ± seal/reserve moves = closing;
every round present, none skipped, none double-credited; `effRakeBps` and the
stored `powerboardFundingAdded` matched the recomputation on all 14 rounds):

| round | pot | effRake | expected contribution | stored contribution | opening pending | closing pending | reserve | netPrize | event |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 35,500 | 450 | 639 | 639 ✓ | 0 | 639 | 0 | 0 | funding |
| 2 | 20,000 | 450 | 360 | 360 ✓ | 639 | 999 | 0 | 0 | funding |
| 3 | 55,000 | 450 | 990 | 990 ✓ | 999 | 1,989 | 0 | 0 | funding |
| 4 | 20,000 | 450 | 360 | 360 ✓ | 1,989 | 2,349 | 0 | 0 | funding |
| 5 | 40,500 | 450 | 729 | 729 ✓ | 2,349 | 3,078 | 0 | 0 | funding |
| 6 | 40,000 | 450 | 720 | 720 ✓ | 3,078 | 3,798 | 0 | 0 | funding |
| 7 | 20,000 | 450 | 360 | 360 ✓ | 3,798 | 4,158 | 0 | 0 | funding |
| 8 | 19,500 | 450 | 351 | 351 ✓ | 4,158 | 4,509 | 0 | 0 | funding |
| 9 | 20,000 | 450 | 360 | 360 ✓ | 4,509 | 4,869 | 0 | 0 | funding |
| — | *admin lab injection (`admin.simulation.injected` event): pendingFunding SET to 5,000,000* |
| 10 | 20,000 | 450 | 360 | 360 ✓ | 5,000,000 | 2,722,583 | 1,166,666 | 1,000,000 | **sealed** |
| 11 | 20,000 | 450 | 360 | 360 ✓ | 2,722,583 | 1,497,944 | 1,224,999 | 1,050,000 | **hit** |
| 12 | 20,000 | 450 | 360 | 360 ✓ | 1,497,944 | 1,498,304 | 1,224,999 | 1,050,000 | funding |
| 13 | 20,000 | 450 | 360 | 360 ✓ | 1,498,304 | 1,498,664 | 1,224,999 | 0 | **miss** |
| 14 | 40,000 | 450 | 720 | 720 ✓ | 1,498,664 | 1,324,385 | 1,224,999 | 1,102,500 | **sealed** |

Sealing arithmetic verified independently: round 10 seal consumed exactly
`minimumLotteryGross(1,000,000, 10%) = 1,111,112` gross from pending
(5,000,360 − 1,111,112 − reserve moves), netPrize = 1,111,112 − 10% fee =
1,000,000; the reset reserve then filled to
`minimumLotteryGross(nextCycleBase, 10%)` (1,166,666, then 1,224,999 after the
ratchet). Every intermediate `pendingFunding` value in the table was also
observed live from the snapshot API after each settlement (driver logs) and
matches the replay.

Final-state reconciliation — independent replay from raw rounds vs the stored
`playtest_rooms.simulation_state` — **all 13 fields exact**:
pendingFunding 1,324,385 · resetReserve 1,224,999 · netPrize 1,102,500 ·
rollover 0 · cycleBase 1,050,000 · epoch 3 · cycle 1 · awaitingSeal false ·
readyForDraw true · totals.powerboardFunded 7,029 · totals.lotteryWinnerPayouts
1,000,000 · emissionBuffer 74,698 · totals.freshWagers 390,500.

Jackpot ratchet verified: cycleBase 1,000,000 → 1,050,000 (= max(5%, 50,000)
step) after the round-11 hit; winner payout **1,000,000 = the displayed sealed
netPrize** and the winner's `test_credit_balance` row was credited by exactly
that plus the crash-seat delta.

## 2. ELIGIBILITY — verdict: **ELIGIBLE-CORRECTLY**

Committed rule: each qualified settled round adds every seat's raw stake to
`playtest_powerboard_tickets(room, epoch, user)` in the eligibility epoch
(next epoch while awaiting seal). Recomputed expected weights from
`playtest_round_seats` and diffed against every stored ticket row — **7/7
rows exact, zero missing, zero extra**:

| epoch | user | expected weight | stored weight |
|---|---|---|---|
| 1 | AuditHost | 164,499 | 164,499 ✓ |
| 1 | AuditPunter | 145,501 | 145,501 ✓ |
| 1 | AuditViewer | 500 | 500 ✓ |
| 2 | AuditHost | 20,000 | 20,000 ✓ |
| 2 | AuditPunter | 20,000 | 20,000 ✓ |
| 3 | AuditHost | 30,000 | 30,000 ✓ |
| 3 | AuditPunter | 10,000 | 10,000 ✓ |

**Non-participating viewer:** AuditViewer holds 500 weight in epoch 1 ONLY.
Forensic trace: that 500 is a REAL escrowed wager — the one-time
`newcomerSeatPlan` seat (`newcomers.seated` event; `playtest_round_seats`
round 1: stake 500, net −500, busted; member balance debited to 999,500).
It is wager-backed weight, not a free ticket. In epochs 2 and 3, where the
viewer placed no bets, the viewer has **zero ticket rows** — a member who does
not wager receives no weight. No weight exists anywhere without a matching
seat stake. (Design note, not a defect: joining a table via invite auto-seats
one minimum-stake wager on the next launch; that wager buys its proportional
weight like any other.)

**Odds-header math** (the “1/2,549”-style display): `crash.html` renders
`combinedOddsOneInCeil` from the server quote (`powerboardVoucherQuote`), with
an identical client-side fallback `ceil(totalWeight·16/myWeight)`. Verified
against LIVE snapshot API values with non-degenerate weights (epoch 3):
host myWeight 30,000 / total 40,000 → stored 22 = recomputed 22 ✓; guest
10,000/40,000 → stored 64 = recomputed 64 ✓; `conditionalSharePpm` (750,000 /
250,000) and `probabilityWeightedPrize` (51,679 / 17,226 =
⌊netPrize·my/(total·16)⌋) also exact. Σ weights per epoch equals the
displayed `totalWeight` denominator in every case.

## 3. DRAW CORRECTNESS — verdict: **DRAWS-CORRECTLY**

Recomputation: `drawnNumber = (first 4 bytes BE of sha256(reveal + ":powerboard:number")) mod 16 + 1`.

- **14/14 rounds**: recomputed drawnNumber == stored drawnNumber
  (9, 8, 14, 8, 16, 14, 3, 8, 11, 9, 13, 11, 8, 13). All in 1..16.
- **Commitment binding 14/14**: each round's pre-committed
  `round.launched` commitment == sha256(stored reveal) — the ball is a pure
  function of a value committed before any bet locked.
- **Funded gate**: `drawActive` true ONLY on the funded rounds 11 (hit) and
  13 (miss); in every funding/sealed snapshot `drawActive=false`,
  `payableHit=false`, no winner — including round 9 where the host explicitly
  demanded a "hit" while <100% funded (event stayed `funding`, no draw, no
  payout).
- **Forced-lab labeling**: `forcedForSimulation` correctly labeled every
  outcome that differed from the reveal-derived natural ball (the round-11
  jackpot was a lab-forced hit, drawn ball 13, labeled `forced=true`;
  round-13 miss matched the natural ball 8, labeled `forced=false`).
- **Winner selection**: independent recompute of `weightedTicketWinner`
  (rejection-sampled sha256 over `reveal:powerboard:ticket:1`, ticket index
  154,861 of 310,500) selects AuditHost — exactly the stored winner, paid
  exactly 1,000,000.
- **Uniformity of the derivation function**: 160,000 synthetic reveals →
  counts per ball 9,861–10,105, χ²(15 dof) = 9.88 (p ≫ 0.01). Uniform over
  1..16, no bias, no off-by-one.

## 4. Live prod spot-check (read-only, unauthenticated)

- `https://plank.tanggang.life/api/health` → 200
  `{"ok":true,"storage":"postgres","version":"3369b14fb885…"}`
- `https://plank.love/api/health` → 200, identical body.

Prod is up, Postgres-backed, and running **exactly the commit audited here**
(`3369b14`), so the local-real-server evidence applies to the deployed code
byte-for-byte. Prod room/lottery state itself is behind authentication and was
NOT accessed; funding/eligibility/draw claims about prod runtime data are
therefore scoped to the local real-server evidence above.

## Verdicts

| Claim | Verdict | Basis |
|---|---|---|
| Lottery funding | **FUNDED-CORRECTLY** | 14/14 rounds: stored contribution == pot×effRake×40%×powerboardFundingBps recomputed from raw seats; running ledger reconciles opening→closing with no skips or double-credits; 13/13 final-state fields exact |
| Eligibility | **ELIGIBLE-CORRECTLY** | 7/7 ticket weights == Σ raw seat stakes per epoch; zero unbacked weight; non-wagering viewer gets none; live odds headers == ceil(total·16/my) exactly |
| Draws | **DRAWS-CORRECTLY** | 14/14 drawnNumber == sha256 recompute from pre-committed reveal; 14/14 commitment==sha256(reveal); range 1..16 uniform; funded gate never breached even under an explicit unfunded hit demand; forced-lab draws labeled |

**No discrepancy was found; no code change was required.** Audit scripts
(independent formula implementations) are preserved in the session scratchpad
(`drive-rounds*.mjs`, `audit-lottery.mjs`, `audit-extra.mjs`).
