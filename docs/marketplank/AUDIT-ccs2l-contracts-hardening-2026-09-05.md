# AUDIT — CCS-2L contract set: adversarial review + hardening — 2026-09-05

Author model: claude-fable-5-1 (pinned, self-reported).
Working tree: `C:\tmp\robinwood-sync-fix2` (master, local; started at `0391515`, four commits ahead of origin).
**Nothing was pushed.** No out-of-scope contract (Marketplank*, Across, DeBridge, VaultV3) was touched.
Protected files (`docs/marketplank/sim-settlement-ccs2l/partition-results.json`,
`docs/marketplank/GROK-ONESHOT-vault-deposit-backfill-2026-08-28.md`, `docs/marketplank/sim-plankcrash/*.json`)
were never staged.

Predecessor: `AUDIT-contracts-hardening-2026-09-04.md` (B-1..B-19, invariants §C.8/§C.9) targeted the OLD
graph. The set rewritten in `b8263a6..0391515` had never been reviewed *as itself*. This document attacks
that set, fixes what it can without touching ratified economics, and proves the fixes.

> **Standing honesty line.** "Impossible to exploit" is not claimed here and must not be claimed anywhere.
> What follows is: proven invariants (with the test that proves each), findings with concrete attack
> narratives, fixes with negative controls, and an explicit residual-assumption list. **No real value
> should move on these contracts before an independent audit.** Two HIGH economic findings (F-1, F-2)
> are OPEN because fixing them requires changing ratified economics — they are owner decisions.

Static analysis: **none available** — `package.json` devDeps carry hardhat 3.12 + toolbox only; no
slither / solhint / mythril / foundry in `node_modules/.bin`. Nothing was installed. Everything below is
manual call-graph tracing plus property/fuzz tests executed against the real contracts.

---

## 0. Scope and method

In scope (13): `PlankCrash.sol`, `PlankLottery.sol`, `PlankRakeRouter.sol`, `PlankBank.sol`,
`lib/PlankCcs2LMath.sol`, and for integration `DrandBeacon.sol`, `IDrandBeacon.sol`, `lib/BLSBN254.sol`,
`PlankV2TwapOracle.sol`, `PlankBurnEngine.sol` (+ test harness `test/PlankCcs2LSettlement.sol`,
`test/DrandBeaconMock.sol`, and two new test-only mocks).

Method, per vector in the brief (§1–§9): every external call site traced for CEI + guard coverage and for
what an outsider can observe mid-call (§A.1); the fixed-point settlement re-derived for overflow, monotonicity,
division-by-zero and rounding direction (§A.2); the round state machine enumerated for every interleaving of
`placeBet / lockRound / settleRound / refundRound` against the beacon (§A.3); the reserve identities checked
under forced ETH, failing callbacks and manufactured rounds (§A.4); the lottery carve proven monotone at every
wei analytically and on-chain (§A.5); router/burn (§A.6); every non-view function's authorisation listed
(§A.7); beacon integration (§A.8); gas/DoS measured to the EIP-7825 cap (§A.9).

---

## PART A — FINDINGS (severity-ranked)

| ID | Sev | Status | Title | Where |
|---|---|---|---|---|
| **F-1** | **HIGH** (economic) | **OPEN — owner decision** | The Powerboard is drained by manufactured minimum-pool rounds: the per-round hit probability is independent of the round's size | `PlankLottery.recordRound` (ball at L162); `PlankCrash._lock` quorum |
| **F-2** | **HIGH** (economic) | **OPEN — owner decision** | A two-target solo table (1.01x pool-keeper + seed-farmer) is strictly +EV against the fixed per-round Vault seed | `PlankCrash._drawSeed`; `PlankCcs2LMath._houseLayer` |
| F-3 | MEDIUM | FIXED `58ecf97` | Open `placeBetFor` lets anyone squat a player's one seat per round (seat-squatting / forced-hit capture) | `PlankCrash.placeBetFor` |
| F-4 | MEDIUM (liveness) | FIXED `58ecf97` | An unsettleable LIVE round locks every stake forever (the refund is gated on randomness *absence*; a reverting `lottery.recordRound`, a gas ceiling, or any settle-path failure is permanent) | `PlankCrash.settleRound` / `refundRound` |
| F-5 | MEDIUM (liveness) | FIXED `dad6e45` | `MAX_SEATS_CEILING = 512` cannot be settled in one transaction (512 all-survive > 30M; EIP-7825 caps a tx at 16.78M) | `PlankCrash` constants |
| F-6 | LOW | FIXED `58ecf97` | `OVERFLOW_GAS_STIPEND = 100_000` vs ~91k for the first-ever `lottery.fund()` (four cold zero→nonzero SSTOREs) | `PlankCrash.deliverOverflow` |
| F-7 | LOW | FIXED `58ecf97` | Constructor gaps: codeless router/lottery (settle bricks), `minParticipants > maxSeats` / `minStakeWei > MAX_STAKE_WEI` (every round voids), `oddsOneIn == 1`, `carveMinBps == 0` (no structural reset), `carveMin == carveMax` (not progressive), router codeless burn/lottery sinks | all three constructors |
| F-8 | LOW | FIXED `58ecf97` | `withdrawToBank(address)` made an ETH call to a caller-chosen contract | `PlankCrash.withdrawToBank` |
| F-9 | LOW (gas) | FIXED `dad6e45` | Dead SSTORE `_seatIndexPlusOne` (+22k per bet, never read); per-seat `paidOf` SSTORE was 1/3 of settle gas | `PlankCrash._placeBet` / `settleRound` |
| F-10 | LOW | OPEN — accepted bound (B-10) | Buy-and-burn sandwich leak ≤ `maxSlippageBps` (5% deployed, 10% ceiling) of each `executeBurn`, plus 1% keeper reward; no cooldown, so an MEV searcher can loop `maxEthPerCall` chunks in one block | `PlankBurnEngine.executeBurn` |
| F-11 | LOW | OPEN — griefing only | `grantSession` on a never-granted key can be claimed by anyone first (victim gets `KeyInUse`, picks another key). No theft path. Orbit chains have no public mempool, so the race needs the sequencer | `PlankBank.grantSession` |
| F-12 | INFO | noted | `seedBudget` is credited with income that immediately cascades to the lottery (`_creditBuffer` adds `amount` before subtracting `excess`); V2 bound is loose by the cascaded amount but `seed ≤ buffer` still clamps every draw (S-7 holds) | `PlankCrash._creditBuffer` |
| F-13 | INFO / residual | stated | The randomness envelope assumes the chain clock lags real time by < 60 s (20 periods). A sequencer whose `block.timestamp` lags more than `revealNotBefore − bettingEndsAt` (60–63 s) lets bettors see the drand output while betting is open. Cannot be closed on-chain | `PlankCrash._startRound` |
| F-14 | INFO | inherent | Parimutuel last-look: later bettors see earlier seats; no randomness advantage | `_placeBet` |
| F-15 | INFO | stated | Modulo bias of `% BPS`, `% playerPool`, `% oddsOneIn` on a uniform 256-bit hash ≤ N·2⁻²⁵⁶ | `_deriveCrash`, `_ticketWinner`, `recordRound` |
| F-16 | INFO | consistent with lib | Founder take is layered: 20 % of net rake at the router **and** `founderFeeBps` on every lottery *inflow* (incl. the router's lottery leg and Vault overflow). Not a double charge *inside* the lottery (carried seed is never re-taxed), but the compound take on the lottery leg is 20 % + 10 %·80 %. Matches `lib/casino/simulation.ts` (`sealed.founderFee`) | `PlankLottery.fund` |
| F-17 | INFO | proven | Reentrancy: none. CEI at every site; `nonReentrant` on every ETH-moving or state-transitioning entry; the only outsider callback is `withdraw()`→`msg.sender` after the debit, and every accounting view is consistent inside it (A-8) | all |
| F-18 | INFO | proven by analysis | `PlankLottery.recordRound` is revert-free: `pool ≥ committedPrize` is an invariant (pool only shrinks inside `recordRound` by `prize = committedPrize ≤ pool`), `winner ≠ 0` (a seat player), `oddsOneIn ≥ 2` | `PlankLottery.recordRound` |

### F-1 · HIGH · Manufactured rounds drain the Powerboard (OPEN — owner decision)

**Invariant broken:** PRODUCT.md *"a community lottery whose prize can only grow"*; design §5's "fixed
point set by volume".

**Attack narrative.** Every settled qualified round is a draw with probability `1/oddsOneIn` (`recordRound`
L162) and the ticket goes to a stake-weighted seat of *that round*. Qualification is `n ≥ minParticipants`
and `pool ≥ minPoolWei` (fixture: 2 seats, 0.005 ETH = 5,000 credits). The hit probability does **not**
depend on the pool. So an attacker runs two wallets, bets 3,000 + 2,000 credits at 1.01x every round the
table is otherwise empty (120 s windows, 24 h a day), and settles. Per round they pay rake
`0.045 × 5,000 = 225` credits (their play EV is `−0.045·P/m ≈ −223`, proven in A-9), of which
`26 % × 90 % ≈ 53` credits reach the pool — and they receive a `1/16` shot at `W(P)`. Break-even is
`W(P)/16 ≈ 223` ⇒ `P ≈ 4,000` credits (0.004 ETH). **Any committed prize above ~0.004 ETH is +EV to farm
with the cheapest qualifying table**, so the prize's equilibrium is `P* ≈ oddsOneIn × cost(cheapest round)`,
three orders of magnitude below `c = 250,000` credits, the carve's half-saturation. A-10 executes this: a
5,000-credit table took `W = 76,235` credits from a 90,000-credit board on the first hit.

With `mustHitByRounds = 96`, the same bot advances `fundedRoundsSinceHit` at 225 credits per round and
**forces** the hit for ≈ 21,600 credits, winning it with its stake share of that one round
(`roundsUntilForcedHit()` is public, so it is an open auction — but the manufactured rounds are what
make it cheap to reach).

**Why it is not fixed here.** Round-only eligibility, the ball = `keccak(BALL_DOMAIN, resultSeed) % oddsOneIn`,
the uncapped base and `mustHitByRounds` are all ratified. Any fix changes one of them. **Owner options** (not
implemented): (a) hit probability proportional to the round's *qualified* pool relative to a reference
volume — `hit ⇔ ball % (oddsOneIn · Q) < min(pool, Q)`, i.e. a 5,000-credit table gets 5,000/Q of the full
odds; (b) qualification threshold for a *draw* that scales with the committed prize (`pool ≥ P / k`); (c)
return to volume-weighted tickets across a window. Each keeps W/S/carve untouched. Note the same law lives in
the lib kernel; the contract is faithful to it.

### F-2 · HIGH · Two-target solo table farms the fixed per-round seed (OPEN — owner decision)

**Invariant broken:** the Vault as *"funded only by rake it has itself taken in"* (design 1.4/V2) — the
income bound holds, but a manufactured table converts bootstrap + retained income into attacker profit
faster than any honest table contributes.

**Attack narrative.** The seed is `min(crashSeedWei, buffer, seedBudget)` **regardless of the pool**
(`_drawSeed`, matching `simulation.ts:329`). The house layer pays survivor `i` up to
`min(hAvail·wᵢ/W, sᵢ(mᵢ−1))`. For a *same-target* solo table this is provably `EV < 0` (A-9: the fair-odds
cap makes the bonus ≤ `s(m−1)` while survival is `≤ 1/m`, and the rake makes the player layer lose
`0.045·P/m`). But with **two targets** the stake is protected by the low sybil: A stakes 40 % at 1.01x
(survives 99 %, collects the whole player pot `D` whenever B busts), B stakes 60 % at
`m_B = 1 + seed/s_B` (its fair-odds cap equals the whole seed). When both survive, B collects the full seed
as bonus. B's stake is never "lost" — it is recycled to A through the parimutuel pot. A-9b computes on the
on-chain law: **+2,043 credits per round on a 5,000-credit table** (rake paid 225, seed 10,000). The
bootstrap budget (200,000 credits) is gone in ~100 rounds; thereafter every retained-rake wei that lands in
the buffer is farmed at the same rate. The 10 % `houseCapBps` of `reserveAtLock` does not bind (buffer
≈ 1M ⇒ cap ≈ 99k ≫ seed).

**Why it is not fixed here.** `crashSeedWei` fixed per round, `f`, the house cap and the fair-odds cap are
ratified CCS-2L v1.1 / lib kernel. **Owner options:** seed proportional to the round's pool
(`seed = min(crashSeedWei, k·playerPool)`), or seed proportional to the round's *rake* (then a table can
never draw more subsidy than it pays), or a per-round house-layer cap expressed on `playerPool` rather than
on `reserveAtLock`. All are one-line changes in `_drawSeed` / `_houseLayer` and the lib kernel; none affect
partition invariance (they are homogeneous in stake).

**F-1 + F-2 compose:** the same two wallets farm both per round.

### F-3 · MEDIUM · Seat squatting via open `placeBetFor` (FIXED)

`placeBetFor(player, target)` was callable by anyone, and a seat is one-per-player-per-round
(`AlreadyBet`). Mallory calls `placeBetFor(alice, 10_100, {value: minStakeWei})` at the start of each round:
Alice cannot bet at all this round (her seat is 500 credits at 1.01x, chosen by Mallory). Cost to Mallory ≈
the stake, which mostly comes back to *Alice*. Combined with F-1's forced hit (`roundsUntilForcedHit() == 1`
is public): squat every known large player's seat for 500 credits each, then stake big and take the forced
prize with a dominant stake share. **Fix:** `bank` is an immutable pinned at construction (CREATE-address
prediction at `nonce+3`, checked in every deploy script); `placeBetFor` reverts `NotBank()` for anyone else.
The bank only bets on the player's own root- or session-key signature. Negative control: A-1 — the stranger
call succeeded on `0391515`, reverts now; Alice keeps her seat and target.

### F-4 · MEDIUM · Unsettleable LIVE round locks stakes forever (FIXED)

`refundRound` requires `randomnessOrZero(target) == 0` (correct: outcome-independent). But if the randomness
*exists* and `settleRound` cannot succeed — `lottery.recordRound` reverting for any reason (it is called
without try/catch and the lottery is immutable), a round whose settlement exceeds the transaction gas cap, or
a beacon read that reverts — every stake in the round is locked with no escape, and every subsequent round
is impossible (the game halts). **Fix (two layers):** (1) `recordRound` is wrapped in `try/catch` emitting
`LotteryRecordFailed(roundId, winner, reason)`; a starved call cannot silently skip a healthy draw because
`_startRound` after the call costs ≫ the 1/64 that EIP-150 retains, so the whole transaction reverts (A-2b:
56 starved attempts reverted whole, none settled without the `Draw`). (2) `refundRound` also fires when
`block.timestamp ≥ revealNotBefore + 30 × refundTimeoutSeconds` (`ABANDONED_ROUND_MULTIPLIER`) even if the
randomness exists — settlement is permissionless, rewarded (`keeperRewardBps`) and first-come the whole
time, so only a round nobody *could* settle for 30 timeouts (30 days on the fixture, 900 days on the
30-day production timeout) reaches it; the condition still never reads the outcome. Negative controls: A-2
(reverted `Broken()` on `0391515`, settles now with the failure logged; overflow leg fails closed and
restores escrow), A-3 (`RandomnessAvailable` at 30×timeout−2 s, refund at 30×timeout).

### F-5 · MEDIUM · Seat ceiling not settleable in one transaction (FIXED)

Measured: 128 mixed seats 2.40M; 100 all-survive 6.98M (~70k/seat). 512 all-survive at distinct targets
ran hardhat's 30M block out of gas; hardhat's EDR also enforces the **EIP-7825 (Osaka) per-transaction cap
of 2²⁴ = 16,777,216 gas**, under which any settle above it is permanently impossible → F-4's lock. **Fix:**
`MAX_SEATS_CEILING = 256`, and the per-seat cost cut by a third (F-9: `paidOf` is now a view recomputed from
committed data by the same library call; the never-read `_seatIndexPlusOne` SSTORE removed). 256 all-survive
now measures **11,730,465 gas (45,822/seat)**, 30 % under the EIP-7825 cap (A-6 asserts < 80 % of it). Fixture
and production configs use 128.

---

## PART A′ — Vector-by-vector trace (what was checked, and what holds)

**§1 Reentrancy.** External calls in `PlankCrash`: beacon views (immutable, trusted), `lottery.recordRound`
(trusted, now try/catch, called after `phase = SETTLED` and all ledgers written), `router.routeRake` /
`lottery.fund` (escrow zeroed before, restored on failure, no callbacks in either), `bank.creditFor` (pinned
bank, after `_debit`), `msg.sender.call` in `withdraw` (after `_debit`). `nonReentrant` on all of
`placeBet/placeBetFor/lockRound/settleRound/refundRound/withdraw/withdrawToBank/fundVault/
fundCommunityReturn/flushRake/deliverOverflow`; `claimRefund` is unguarded but makes no call and is
monotone. **Read-only reentrancy:** the only moment outsider code runs inside the crash is the `withdraw`
callback; A-8 (`MockReentrancyProbe`) asserts `balance == accountedBalance()` on crash *and* lottery,
`owed == 0`, and that all eight state-changing entries revert there. Lottery/router: every claim is
CEI + guard; `fund` and `routeRake` make no calls. Bank: CEI + guard; `creditFor` game-gated.

**§2 Settlement math.** `lnScaled`: Q96 normalise, 40 squarings; each step is monotone (floor∘square,
conditional halve), so `lnScaled` is non-decreasing; `lnScaled(10_100) = 9,950 > 0` ⇒ `W > 0` whenever a
survivor exists (no ÷0; all-bust returns before the layers). Overflow: `stake ≤ 2⁹⁶`, `m ≤ 10⁸` ⇒
`w ≤ 7.3e35`, `W ≤ 256·w ≤ 1.9e38`, `premium ≤ 2e31`, `premium·w ≤ 1.5e67 < 2²⁵⁶`; `seedH ≤ MAX_POT` is
enforced by `crashSeedWei ≤ MAX_POT` at construction, `playerDistributable ≤ 256·2⁹⁶ ≈ 2e31 < MAX_POT`.
Rounding: player dust (< n wei) → largest-w survivor, lowest index; bonus floors → `houseReturned`
(house-favouring); `playerDistributable` floors → rake; keeper floors → net rake; router dust → founders;
lottery fee floors → pool; carve floors → winner (≤ 1 wei). All deterministic, none farmable beyond n wei.
Partition: player layer `Σ floor(premium·wⱼ/W) ≤ floor(premium·Σwⱼ/W)` and dust ≤ n; house layer
`Σ min(floor(hAvail·wⱼ/W), floor(sⱼ(m−1)/BPS)) ≤ min(floor(hAvail·w/W), floor(s(m−1)/BPS))` — splitting
never gains a wei. A-5: 126 sybils vs one whole seat at the same and at adjacent targets (with two honest
seats present), across four (m, crash) cells including the survival boundary: player gain ≤ k wei, house gain
≤ 0, both conserve exactly. Three-way differential (300 rounds, `settleRound` vs `settleCcs2L` vs
`engine.mjs`) re-run after every change: wei-identical.

**§3 Round lifecycle.** Target round is chosen in `_startRound` (the previous round's settle/void/refund tx)
before any seat: `target = nextRoundAfter(bettingEndsAt) + 20`, i.e. emission `≥ bettingEndsAt + 60 s`
(strictly `> 63 s` worst case). Uniqueness: with `roundIntervalSeconds = 0`, round N+1 starts at
`t₁ ≥ t₀ + D` and `D ≥ period` ⇒ `target_{N+1} > target_N`; with an interval, consecutive slots differ by
`> 21 periods` (constructor). The `BadConfig` revert in `_startRound` is therefore unreachable (it would
otherwise brick — noted). Replay: `resultSeed` binds chainid, this address, the beacon, roundId and target;
the beacon never overwrites a round. `refundRound` and `settleRound` are mutually exclusive by phase and by
the `randomnessOrZero` predicate (S-13); the new abandoned hatch is the only interleaving where both *could*
be callable, and settle wins if anyone calls it. Seats: the 128th is accepted, the 129th `RoundFull` (S-12);
settle at 256 all-survive measured (A-6). Nobody can make settle revert for another player: no per-seat
external call, no per-seat revert path (S-12 fuzz + full round).

**§4 Economic / solvency.** `accountedBalance = reserve + pendingRake + pendingOverflow + unclaimedRefunds +
totalOwed + (seed + playerPool of the open round)`; every transition moves value between these terms
exactly (S-6/S-8, `assertConserved` after every adversarial case). Forced ETH is `unclassifiedSurplus`,
never credited. Failing router/lottery callbacks restore escrow (A-2). `protectedPrincipal` cannot be
breached: `reserve` is debited only by `_drawSeed (≤ buffer)` and by cascade `(≤ buffer)`. Seed budget:
drains only via F-2 (open). Keeper bounty: bps of realised rake, farm-proof (S-14).
`emissionBufferCap` cascade only ever moves *buffer* to `pendingOverflow` → `lottery.fund` (the ratified V3).

**§5 Lottery.** Carve monotonicity, proven at every wei: with `u = P/(P+c)`,
`x(P) + P·x′(P) = x_min + Δ(2u − u²) ≤ x_min + Δ = x_max < 1`, so the real-valued `s(P) = P·x(P)` has
`0 < s′ < 1` ⇒ `S(P+1) − S(P) ∈ {0, 1}` after a single floor ⇒ both `S` and `W = P − S` are non-decreasing
for *all* admissible parameters (the constructor now enforces `0 < x_min < x_max < 1`, `c > 0`). L-2 covers
30 orders of magnitude on-chain and 100k dense wei steps in the bit-identical JS mirror. `%oddsOneIn` bias
`≤ oddsOneIn·2⁻²⁵⁶` (F-15). `mustHitBy`: counts only funded qualified rounds; cannot be delayed (the
counter is monotone until a hit) but can be *reached cheaply* (F-1). `committedPrize` snapshot: sealed at the
previous `recordRound`, before the drawn round's target is committed in the same tx; mid-round funding joins
the next board (L-4); rounds record strictly in order (single source, `currentRoundId`). Zero-stake players
cannot exist (`stake ≥ max(1, minStakeWei)`), voided rounds never call `recordRound`. Founder fee: once on
inflow (F-16 notes the layering with the router's 20 %).

**§6 Router / burn.** `burn + community + founders == net` and `lottery + vault == community` by
construction (dust → founders, matching `ratifiedRakeSplit`). Claims are CEI + guard, permissionless, fixed
sinks. Burn: floor = TWAP·(1 − 5 %); leak per call ≤ 5 % of `ethAmount` + 1 % keeper; no cooldown (F-10,
accepted bound, recommendation: a `minBurnIntervalSeconds` immutable). Oracle: window ≥ 30 s, staleness ≤
8× window, reserve floor re-checked on every `update` (fails closed).

**§7 Access / immutability.** Non-view surface and its authorisation: **Crash** — `placeBet` (anyone),
`placeBetFor` (**bank only**, new), `lockRound`/`settleRound`/`refundRound`/`claimRefund`/`flushRake`/
`deliverOverflow`/`fundVault`/`withdraw` (anyone), `withdrawToBank` (caller, to the pinned bank only, new),
`fundCommunityReturn` (router only). **Lottery** — `fund`/`withdraw`/`withdrawFounderFees` (anyone),
`recordRound` (source only). **Router** — `routeRake` (source only), `claim*` (anyone). **Bank** —
`deposit`/`withdraw`/`withdrawAll`/`grantSession`/`revokeSession`/`bet`/`betVia` (caller), `creditFor` (game
only). **Beacon** — `submitRound` (anyone, signature-verified). **Oracle** — `update` (anyone). **Burn** —
`executeBurn` (anyone). No owner, no setter, no pause, no upgrade path, no `selfdestruct` in any of them
(S-11 also greps the ABI). Chain-id: `resultSeed` includes `block.chainid`. Constructor validation after F-7:
zero addresses, code presence for pre-deployed dependencies, bps ranges, `MIN_TARGET ≤ maxTarget ≤ 10,000x`,
`0 < maxSeats ≤ 256`, `minParticipants ≤ maxSeats`, `minStakeWei ≤ 2⁹⁶−1`, `floorBps ≤ BPS − rakeBps`,
`crashSeedWei ≤ MAX_POT`, interval/period compatibility, `refundTimeout > 0`; lottery `oddsOneIn ≥ 2`,
`0 < x_min < x_max < BPS`, `c > 0`, `founderFeeBps < BPS`.

**§8 Randomness / beacon.** Target strictly after close (§3). A submitted round is immutable
(`RoundAlreadySubmitted` on a different value, idempotent on the same). Unchained drand: the signature for
round R is a deterministic function of the group key and R, and cannot be computed before a threshold of
the League of Entropy signs at emission time — that is the assumption; nothing on this chain can precompute
it. The beacon address is immutable in the crash; if drand rotates its key (a new chain hash), **this
beacon can never verify new rounds** and every round after that would go through the refund path
(`refundTimeoutSeconds` outcome-independent, then the game is dead until a new crash is deployed). This is a
disclosed property of the ownerless posture, not a bug.

**§9 Gas / DoS.** Loops: `_placeBet` O(1); `settleRound` O(n ≤ maxSeats) with no per-seat external call;
`_ticketWinner` O(n); `paidOf` view O(n). Storage per round: `Round` (~14 slots) + `n` seats + 2 mappings
per seat, retained forever (needed by `claimRefund` and history); nothing iterates old rounds. Events are
bounded. Measured gas table in §C.

---

## PART B — FIXES (all without touching ratified economics)

| # | Change | File:line (post) | Negative-control test | Gas Δ | Size Δ |
|---|---|---|---|---|---|
| B-1 (F-3) | `bank` immutable in `Config`; `placeBetFor` reverts `NotBank()` unless `msg.sender == bank`; deploy scripts predict the bank at `nonce+3` and verify | `PlankCrash.sol` 143, 169, 278, 413–414; `scripts/deploy-casino.ts`, `local-casino-setup.ts`, `testnet-casino-setup.ts` | A-1 (stranger `placeBetFor` succeeded on `0391515`) | +1 SLOAD-equivalent (immutable) | +~90 B |
| B-2 (F-4a) | `try lottery.recordRound … catch → emit LotteryRecordFailed` | `PlankCrash.sol` 551–554 | A-2 (whole settle reverted on `0391515`); A-2b (starved calls revert whole) | +~1.5k on settle | +~250 B |
| B-3 (F-4b) | `ABANDONED_ROUND_MULTIPLIER = 30`; `refundRound` allowed at `reveal + 30×timeout` regardless of randomness | `PlankCrash.sol` 99–104, 595–601 | A-3 (`RandomnessAvailable` forever on `0391515`) | +~150 on refund | +~60 B |
| B-4 (F-5, F-9) | `MAX_SEATS_CEILING 512 → 256`; `paidOf` becomes a view recomputed by `_preview`; `_seatIndexPlusOne` removed | `PlankCrash.sol` 81–87, 756–779 | A-6 (512 all-survive OOG > 30M, > 16.78M cap); existing `paidOf` assertions still pass | settle −33 %/seat; bet −22k | +~180 B (view) −~60 B |
| B-5 (F-6) | `OVERFLOW_GAS_STIPEND 100_000 → 200_000` | `PlankCrash.sol` 96–98 | A-4 (cold lottery: four zero→nonzero slots) | none | 0 |
| B-6 (F-7) | Crash: router/lottery must have code; `minParticipants ≤ maxSeats`; `minStakeWei ≤ MAX_STAKE_WEI`. Lottery: `oddsOneIn ≥ 2`, `0 < x_min < x_max`. Router: burn/lottery sinks must have code | `PlankCrash.sol` 278, 298; `PlankLottery.sol` 114, 119; `PlankRakeRouter.sol` 87 | A-7 (all accepted on `0391515`) | constructor only | creation code only (deployed size unchanged) |
| B-7 (F-8) | `withdrawToBank(bank_)` requires `bank_ == bank` | `PlankCrash.sol` 637–638 | A-1 (last assertion) | none | +~30 B |
| B-8 (tests) | `betFor()` impersonates the pinned bank; `freshAddress()` replaces `ethers.Wallet.createRandom()` (which produced a bad secp256k1 point once in the baseline run and failed S-12) | `test/contracts/helpers/casino.ts` | S-12 baseline flake | — | — |

Patterns applied, with sources (accessed 2026-09-05): checks-effects-interactions and pull over push —
Solidity docs, *Security Considerations → Re-Entrancy* (https://docs.soliditylang.org/en/v0.8.24/security-considerations.html#reentrancy);
`ReentrancyGuard` — OpenZeppelin Contracts 4.9 (https://docs.openzeppelin.com/contracts/4.x/api/security#ReentrancyGuard).
**Recommendation, not applied (project pinned to OZ 4.x, `evmVersion: paris`):** OZ 5.1's
`ReentrancyGuardTransient` (EIP-1153, https://eips.ethereum.org/EIPS/eip-1153) would cut ~4.9k gas per
guarded call but needs Cancun, which is unconfirmed on the target chain. `try/catch` on external calls —
Solidity docs (https://docs.soliditylang.org/en/v0.8.24/control-structures.html#try-catch); the 63/64 gas
retention that makes starved-call griefing revert the caller — EIP-150
(https://eips.ethereum.org/EIPS/eip-150); the `SWC-113` "DoS with failed call" class the escrowed claims
avoid (https://swcregistry.io/docs/SWC-113/); the contract-size limit — EIP-170
(https://eips.ethereum.org/EIPS/eip-170); the per-transaction gas cap the seat ceiling is sized to —
EIP-7825 (https://eips.ethereum.org/EIPS/eip-7825); Arbitrum block-timestamp semantics for F-13
(https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time); drand
unchained beacons (https://drand.love/docs/cryptography/#unchained-randomness); Uniswap V2 TWAP oracle
(https://docs.uniswap.org/contracts/v2/concepts/core-concepts/oracles).

Explicit rounding directions and checked arithmetic are documented inline (no `unchecked` blocks in the
crash/lottery/router/bank/math; the oracle's `unchecked` is the V2 accumulator wrap, load-bearing).

---

## PART C — PROOF

**Compile:** `npx hardhat compile --force` clean (30 files, solc 0.8.24, paris, viaIR).

**Suites.**

| Suite | Before (`0391515`) | After (`dad6e45` + test fix) |
|---|---|---|
| `npm run test:contracts` | 175 passing, 1 failing (S-12: `ethers.Wallet.createRandom()` bad-point flake — harness, not contract; brief said 176) | **188 passing, 0 failing** (176 + 12 adversarial) |
| `npm run test:market` | 1128 pass / 4 fail (pre-existing PlankSpace drizzle-orm) | **1128 pass / 4 fail** (unchanged; nothing installed) |
| Three-way differential (300 rounds, 135 all-bust) | wei-identical | **wei-identical** (settlement math untouched: `PlankCcs2LMath.sol` has no diff) |

**Deployed size (EIP-170 limit 24,576).**

| Contract | Before | After | Δ |
|---|---|---|---|
| PlankCrash | 15,790 | 16,318 | +528 (66.4 % of limit) |
| PlankLottery | 3,909 | 3,909 | 0 (constructor-only change) |
| PlankRakeRouter | 2,864 | 2,864 | 0 (constructor-only change) |
| PlankBank | 2,483 | 2,483 | 0 (comment only) |

**`settleRound` gas** (all survivors at distinct targets unless noted).

| n | Before | After | Δ |
|---|---|---|---|
| 2 | 590,407 | 545,943 | −7.5 % |
| 10 | 1,047,942 | 828,412 | −21 % |
| 50 | 3,691,677 | 2,580,542 | −30 % |
| 100 | 6,982,097 | 4,783,077 | −31.5 % |
| 128 (S-12 mixed) | 2,398,497 | 2,177,353 | −9 % |
| 256 all-survive (ceiling) | n/a | 11,730,465 (45,822/seat) | 70 % of EIP-7825 cap |
| 512 all-survive (old ceiling) | OOG (> 30M block) | disallowed | — |

Other measured: `settleRound` with a real draw ≈ 510k (A-2b estimate); 56 starved gas limits from 12.5 % to
98 % of the estimate all reverted whole.

### Proven invariants (test → statement)

- S-1…S-14 (`PlankCrash.test.ts`), L-1…L-6 (`PlankLottery.test.ts`), R-1/R-2 (`PlankRakeRouter.test.ts`),
  D-1/D-2 (`DrandBeacon.*`) — unchanged and green.
- A-1 seat-squatting impossible; only the pinned bank may fund a seat for another address.
- A-2 a reverting draw dependency cannot lock stakes; overflow leg fails closed.
- A-2b a starved `settleRound` cannot skip a healthy draw (EIP-150 argument, executed).
- A-3 abandoned-round refund is gated at exactly 30× the timeout; settle remains possible until then.
- A-4 first-ever overflow delivery fits the stipend.
- A-5 partition invariance at 126 sybils, same and adjacent targets, with honest seats present.
- A-6 ceiling settle ≤ 80 % of the EIP-7825 cap.
- A-7 every new constructor guard rejects its foot-gun; the admissible boundary deploys.
- A-8 no re-entry from the only outsider callback; accounting views consistent inside it (crash + lottery).
- A-9 same-target solo table has `EV < 0` in 144/144 (pool, seed, m) cells on the exact discrete law
  `P(crash ≥ m) = ⌊10⁸/m⌋/10⁴` (which is ≤ 1/m, house-favouring).
- Analytic (this document): carve monotone at every wei for all admissible params; target-round uniqueness;
  `pool ≥ committedPrize`; `reserve ≥ protectedPrincipal`; `lnScaled` monotone and overflow-free at the
  contract's bounds.

### Deferred / not proven here

- F-1, F-2 (owner decisions; A-9b and A-10 *document* them and will fail when the law changes — invert them then).
- BLS wire compatibility beyond the single fixture (prior B-18) — unchanged.
- TWAP manipulation cost on the real pair (depends on real depth) — unchanged.
- Behaviour under a real Osaka chain (only hardhat's EDR cap was exercised).
- The lib kernel (`lib/casino/*.ts`) mirrors F-1/F-2 by construction; not re-audited here.

### Residual assumptions (explicit)

1. The sequencer's `block.timestamp` lags real time by < 60 s (F-13); it also orders transactions, which is
   the standing L2 assumption.
2. A threshold of the drand League of Entropy does not collude with a bettor and does not precompute rounds.
3. The deployed `beacon`, `router`, `lottery`, `bank` and TWAP `pair` are the intended contracts (checked
   for code presence and CREATE-prediction only; correctness is a deploy-process responsibility).
4. OZ 4.9.6 `ReentrancyGuard` semantics; solc 0.8.24 checked arithmetic.
5. `keeperRewardBps > 0` (or any honest party) makes settlement happen; the abandoned hatch is a backstop,
   not a liveness plan.

---

## Commits (local, master, NOT pushed)

- `58ecf97` fix(contracts): bank-only `placeBetFor`, lottery try/catch, abandoned-round hatch, stipend,
  constructor guards, test helper.
- `dad6e45` feat(contracts): seat ceiling 256 sized to EIP-7825, `paidOf` view, dead SSTORE removed,
  adversarial suite A-1..A-10 + two test-only mocks.
- (this report + A-2 outcome-agnostic assertion) — see `git log`.

Never staged: `docs/marketplank/sim-settlement-ccs2l/partition-results.json`,
`docs/marketplank/GROK-ONESHOT-vault-deposit-backfill-2026-08-28.md`, `docs/marketplank/sim-plankcrash/*.json`
(the pre-existing modification to `random-stateful-summary.json` was left in the working tree untouched).
