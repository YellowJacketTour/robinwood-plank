# PlankCrash value-flow contracts — fresh adversarial audit, 2026-09-02

Scope: every contract reachable from PlankCrash value flows at commit
`49b2f2c` — PlankCrashDrand (production), PlankCrashV2/VRF/Entropy (legacy),
PlankPowerboard (+V2 kernel), PlankBank, PlankBurnEngine,
PlankEconomicRouterV2, PlankFuelBooster, PlankRakeDistributor,
PlankProgression, DrandBeacon, PlankV2TwapOracle, PlankRakeDistributor —
plus the Powerboard result/payout DISPLAY path (Workstream F:
`lib/playtest-room-core.ts`, `lib/playtest-rooms.ts`,
`public/arcade/crash.html`).

Prior audits reviewed and NOT re-litigated (claims spot-verified against
code): `docs/marketplank/AUDIT-PLANKCRASH-MECHANISM-AND-SECURITY-2026-09-01.md`,
`AUDIT-PLANK-BUY-BURN-MEV-2026-09-01.md`,
`AUDIT-CRASH-RNG-TIMING-AND-LIVE-VALUE-2026-08-30.md`,
`AUDIT-POWERBOARD-CINEMATIC-PRESENTATION-2026-08-30.md`. This document
records only what is NEW, what was verified, and what remains open. Per
the standing discipline, no "zero exploits" claim is made anywhere below —
only proven invariants plus residual assumptions.

---

## Findings

### HIGH-1 (FIXED): voided-round ticket farm against the Powerboard

- **Location:** `contracts/PlankPowerboard.sol` `claimTickets()` /
  `contracts/PlankCrashDrand.sol` `voided` + `carryForwardStake()` interaction.
- **Exploit path:** a crash round that VOIDS (under-threshold or
  whale-dominated at `lockRound()`) keeps `stakeOf[round][player]` nonzero
  forever (`carryForwardStake` needs it to recover the stake) and takes
  **zero rake**. `claimTickets(source, roundId, player)` read only
  `stakeOf`, and its double-claim guard is keyed per `(source, roundId,
  player)` — so every voided roundId was a fresh claim. Attack: bet solo →
  betting window lapses → `lockRound()` voids (minParticipants unmet) →
  `carryForwardStake` into the next round → repeat. One stake, recycled
  forever, mints unbounded wager-weighted tickets **for gas only**, while
  honest players pay rake per ticket batch. Combined with the
  `mustHitByEpochs` forced-jackpot epoch, this converts to near-certain
  jackpot capture at ~gas cost. A second face of the same hole: claiming
  while the source round was still BETTING/LIVE credited tickets for a
  stake whose round could still void afterwards.
- **Fix:** `IWagerSource` extended with `currentRoundId()` and
  `voided(uint256)` (public getters every Plank Crash variant already has;
  `MockWagerSource` extended to match). `claimTickets` now requires
  `sourceRoundId < source.currentRoundId()` (the round actually finished —
  every variant advances `currentRoundId` only on settle-or-void) AND
  `!source.voided(sourceRoundId)` (rake was actually taken). New errors
  `SourceRoundNotFinal` / `SourceRoundVoided`.
- **Regression tests:** `test/contracts/PlankPowerboardAdversarial.test.ts`
  — "VOID-CYCLE FARM (AUDIT 2026-09-02 HIGH)" and "PRE-SETTLEMENT CLAIM".
  The real-crash path through the new gate is exercised by the existing
  `CasinoIntegration` / `CasinoKeeper` suites (tickets claimed post-settle
  from the real `PlankCrashDrand`), which stay green.
- **Behavioral note:** ticket claims must now wait for round settlement.
  `scripts/casino-keeper.ts` already wraps `claimTickets` in a
  best-effort `attempt(...)`, so a claim against an unsettled/voided round
  degrades to a logged failed attempt, not a stuck loop.

### MEDIUM-1 (DOCUMENTED, accepted): ticket-claim epoch deferral

Tickets credit to the epoch current **at claim time**, not at bet time.
A player can hoard finished-round receipts and dump them into one chosen
epoch (e.g. a due `mustHitByEpochs` epoch, or a low-participation epoch)
to concentrate odds. This is bounded — tickets are still linear in raked
wager, so the deferrer paid full freight and merely times their exposure;
every other player can do the same, and the forced-hit epoch is publicly
computable so competition is symmetric. Eliminating it needs bet-time
epoch stamping (source-side event attribution), a larger interface
change. **Owner acceptance recommended** with the note that the
forced-epoch schedule being public makes deferral a symmetric, not
privileged, strategy. Listed in the 2026-09-01 audit's coalition-audit
matrix ("lottery-ticket farming and rollover timing"); the *free* variant
(HIGH-1) is now closed, the *paid timing* variant remains.

### MEDIUM-2 (DOCUMENTED, accepted): Powerboard forced-hit epoch is a known-schedule value event

`guaranteedHitByEpoch()` is public by design (ethics: fixed, predictable
timing). The whole field can see the epoch in which the pot must pay, so
ticket volume (and, pre-fix, farmed tickets) concentrates there. With
HIGH-1 closed, buying odds in the forced epoch costs the same raked wager
as any other epoch; the jackpot is paid to a funded, eligible winner
drawn by committed randomness (`requestDraw` commits the target drand
round before the value exists). Residual: the forced epoch's EV is
higher than other epochs, which is the advertised, intended mechanic —
not a solvency risk (prize ≤ `jackpot`, which is balance-backed by
`fund()` receipts).

### MEDIUM-3 (DOCUMENTED): PlankPowerboardV2 settler is fully trusted

`settleEpoch(winner, hit)` takes winner and hit **as arguments** from the
immutable `settler`. The contract is explicitly an epoch-isolated
accounting kernel ("randomness/ticket selection intentionally remains
outside"); it must never be deployed with an EOA settler in production.
Deployment gate: settler MUST be a target-bound randomness verifier
contract. Not wired into the production graph today (the crash's
`jackpotSink` is PlankPowerboard v1). No code change.

### LOW-1 (DOCUMENTED): claim() rounding dust stays in the contract

`_splitPayout` floors each winner's share; the sum of paid + excess per
claim is exact, but cross-winner floor dust (≤ number-of-winners wei per
round) remains as contract balance outside `reserve`/`pendingOverflow`
bookkeeping. Solvency-safe (surplus, never deficit); consistent with the
stated player-favouring dust policy. No change.

### LOW-2 (DOCUMENTED): dev-config target-round collision liveness

With `roundIntervalSeconds == 0` (local-dev exemption in the
constructor), two rounds settling within one drand period could compute
the same `targetDrandRound`; `_startRound`'s collision check would then
revert the settle until time advances one period. Liveness-only, dev
config only; production configs are constructor-guarded
(`RoundIntervalTooShort`). No change.

### LOW-3 (DOCUMENTED): voided rounds still count toward Progression rank

`recordBet` fires at `placeBet`, so a bet in a round that later voids
still increments `roundsPlayed`/`cumulativeWagered` — rank grinding can
use rake-free voided rounds. Progression gates only stake ceilings and
entry premiums (friction, not funds), and the void cycle costs real
cadence time; with HIGH-1 fixed it no longer feeds the Powerboard.
Accepted.

### INFO: display path (Workstream F) — architecture verified sound

- The displayed Powerboard ball is `powerboardRoundDraw(reveal)` — a pure
  sha256 derivation from the **pre-committed** reveal
  (`commitment = sha256(reveal)` persisted before the round runs); the
  `% 16` of a 32-bit read is exactly uniform. The client pins the
  authoritative number (`balls.find(b => b.number === Number(drawNumber))`,
  throws on mismatch); `crypto.getRandomValues` on the client drives only
  ball turbulence, never selection.
- A displayed ball alone never implies a jackpot: celebration/payout copy
  key off the settled `winner`, and funding-mix rounds are labeled
  non-payable. The one legitimate divergence — a host-forced lab outcome —
  is computed server-side (`forcedForSimulation`) and rendered as
  "HOST-FORCED LAB OUTCOME · NOT NATURAL RANDOMNESS".
- Interrupted animation / reload resumes the same committed result via
  `snapshot.currentSettlement` + round-keyed `sessionStorage` ack;
  the ceremony replay can never roll a different number.
- **Tests added** (gaps found by this audit): forced-lab banner rendering,
  winner-not-ball celebration keying, reload-resume markers
  (`test/market/playtest-presentation.test.ts`), and a literal fixture
  pinning the reveal→ball mapping (`test/market/playtest-room-core.test.ts`:
  reveal `"ab"×32` → ball 11/16, miss). Residual nit: `payableHit` is
  published but the client re-derives from `lotteryEvent`/`winner`
  (equivalent today; the regex tests pin both sides).

---

## Proven / re-verified invariants

1. **Randomness commitment ordering:** `targetDrandRound` and
   `revealNotBefore` are committed in `_startRound` — before any bet is
   visible; result seed is domain-separated over chain-id, deployment,
   beacon, game round, target round, and beacon output (`resultSeed`).
   Chain-ID separation is in the seed itself (no cross-chain replay of a
   result mapping).
2. **No outcome-selective void:** `voidStaleRound` reverts unconditionally
   in production; drand results never expire.
3. **Cash-out information boundary:** manual cash-out requires
   `block.timestamp < revealNotBefore` AND `!beacon.isRoundAvailable(target)`
   (clock-independent belt); auto targets are committed with the bet and
   can only be lowered, never raised.
4. **Vault non-negativity & caps:** the seed is a strict fraction
   (`num < den`), additionally capped by `seedMaxBps ≤ 1000`, the
   NEW-1 income budget (`seeds drawn − returned ≤ bootstrap + Σ reserveCut`),
   the optional floor, and two drawdown circuits. `_creditReserve` is the
   only credit path and synchronously skims `pendingOverflow` above
   `reserveCap`; `deliverOverflow` is CEI with bounded gas
   (`SINK_GAS_STIPEND`) and exact restore-on-failure.
5. **Conservation at claim:** `paid + excess` equals the winner's exact
   parimutuel share; excess returns to the Vault with
   `raisesWindowPeak=false` (no daily-budget re-arm); busted pots sweep to
   the Vault with the seed's budget restored. The vault invariant test at
   `49b2f2c` includes queued overflow.
6. **Pull-over-push:** all game payouts go through `_asyncTransfer`
   escrow; the only pushes are the self-set `payoutRedirect` (falls back
   to escrow on failure, `nonReentrant`) and the distributor's fixed,
   best-effort legs with stuck-leg retention + permissionless `flush()`.
7. **Keeper economics:** all bps bounties are of the rake (manufactured
   rounds pay more rake than they earn); the gas floor pays only the
   immutable `designatedKeeper` from a segregated, epoch-capped subsidy
   reserve. `keeperRewardBps > 0` and `rakeBps > 0` are constructor-forced.
8. **Bank containment:** session keys can only bet (cap- and
   expiry-bounded) on construction-fixed games, never withdraw;
   `creditFor` is game-gated; withdraw is CEI + `nonReentrant`; `spent`
   is never reset on re-grant.
9. **Buy-and-burn:** fixed route/recipient, TWAP floor
   (`maxSlippageBps ≤ 1000`), atomic burn of measured receipt, keeper
   reward hard-capped at 2%, oracle fail-closed on unprimed/stale/shallow
   (constructor and per-update reserve floor). Claim remains **bounded
   adverse execution**, not MEV immunity (see citations).
10. **Beacon:** BLS verification fail-closed (`PairingCallFailed` distinct
    from `InvalidSignature`), deterministic-signature idempotent relay, no
    overwrite, correct drand round convention (`+1` fix present).
11. **Powerboard draw:** target round committed at `requestDraw` before
    the value exists; prize ≤ balance-backed `jackpot`; drawer reward
    hard-capped 5%; ticket segments binary-searched (no sybil DoS of the
    draw); **and now** tickets exist only for finalized, raked wagers
    (HIGH-1 fix).

## Residual assumptions (unchanged from prior audits, restated)

- A threshold of the drand League of Entropy is honest and live; someone
  relays rounds (bps bounties + optional designated-keeper floor are the
  incentive, two-origin agreement in the relay is transport hygiene).
- Sequencer timestamp jumps stay under `TARGET_ROUND_SAFETY_PERIODS` (60s)
  and lag under `CASHOUT_CLOSE_MARGIN_PERIODS` (6s) — with the
  `isRoundAvailable` belt behind the clock gate.
- Deploy process pins the real router/WETH/deep-pair addresses and the
  verified drand public key; legacy variants (V2/VRF/Entropy) and
  testbeds stay out of the production deployment graph.
- Sandwich extraction inside the configured slippage band remains
  economically possible on the burn path; TWAP manipulation cost scales
  with pool depth × window (see citations) and the per-call cap bounds
  the value at stake.

## Citations (MEV / oracle, accessed 2026-09-02)

- Uniswap v2 oracle design & manipulation-cost framing:
  https://developers.uniswap.org/docs/protocols/v2/concepts/oracles
- Mackinga, Nadahalli, Wattenhofer, "TWAP Oracle Attacks: Easier Done
  than Said?" (IACR eprint 2022/445): https://eprint.iacr.org/2022/445.pdf
  — single-block vs multi-block manipulation cost; motivates the
  deep-pool + reserve-floor + window requirements enforced in
  `PlankV2TwapOracle`.
- Euler, cost-of-attack analysis for TWAP manipulation (capital scales
  with liquidity and √window):
  https://github.com/euler-xyz/uni-v3-twap-manipulation/blob/master/cost-of-attack.tex
- Heimbach & Wattenhofer, "Eliminating Sandwich Attacks with the Help of
  Game Theory" (arXiv:2202.03762): https://arxiv.org/pdf/2202.03762 —
  slippage bounds as loss ceilings, consistent with the 2026-09-01
  buy-burn audit's "bounded adverse execution" claim.

## Test evidence

- `npm run test:contracts`: **374 passing, 0 failing** (372 baseline
  +2 HIGH-1 regressions).
- Market/display suite: `npx tsx --test test/market/playtest-presentation.test.ts
  test/market/playtest-room-core.test.ts`: 37 passing, 0 failing
  (+5 Workstream F tests added by this audit).
- Per-file: `npx cross-env TS_NODE_PROJECT=tsconfig.hardhat.json hardhat
  test test/contracts/PlankPowerboardAdversarial.test.ts`.

## Files changed by this audit

- `contracts/PlankPowerboard.sol` — HIGH-1 fix (finality + voided gates).
- `contracts/test/MockWagerSource.sol` — finality surface for the mock.
- `test/contracts/PlankPowerboardAdversarial.test.ts` — 2 regressions.
- `test/market/playtest-presentation.test.ts` — 4 Workstream F tests.
- `test/market/playtest-room-core.test.ts` — reveal→ball fixture test.
- `docs/AUDIT-plankcrash-2026-09-02.md` — this document.
