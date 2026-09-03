# RATIFICATION — CCS-2L Two-Layer Continuous Capped Settlement — 2026-09-02

Author model: claude-fable-5. Owner decision: **proceed** — ratify CCS-2L end-to-end,
completing every locally-achievable condition. This document records what is ratified,
the evidence, and the gates that remain EXTERNAL.

## 1. Ratified rule and parameters

- **Rule**: `ccs-2l` v1, variant A (canonical), as implemented in
  `lib/casino/economics-ccs2l.ts` and mirrored wei-for-wei by
  `docs/marketplank/sim-settlement-ccs2l/engine.mjs` and
  `contracts/test/PlankCcs2LSettlement.sol` / `contracts/lib/PlankCcs2LMath.sol`.
- **Player layer**: `p_i = f·s_i/BPS + premium·w_i/W`, `w_i = s_i·lnScaled(m_i)` with
  closed-form `λ = premium·1e18/W`; **f = 7,500 bps** (survivor floor). When any survivor
  exists the layer pays out EXACTLY `playerDistributable` (wei-exact conservation asserted
  every settlement) ⇒ aggregate player-layer RTP = 1 − effective rake.
- **House layer v1.1**: `H_avail = min(H, reserveAtLock·houseCapBps/BPS)` with
  **houseCapBps = 1,000 (10%), GLOBAL — never per-wallet**; split by `w = s·ln m`
  (`g(m) = ln m` is exactly the cumulative hazard of the 1/m crash law), per-seat
  fair-odds cap `s·(m−1)`. Every constraint is positively homogeneous in stake ⇒
  partition-invariant (false-name-proof form per Yokoo et al.; the removed v1.0
  per-wallet cap was the textbook violation).
- **No-survivor rounds**: whole distributable → protected reserve. Unused seed →
  protected reserve. Treasury cap-residue is structurally 0.
- **Live default**: `allocationRule: "ccs-2l"` (`lib/playtest-room-core.ts:25`).

## 2. Verification against the proven design (condition a)

This worktree's `lib/casino/economics-ccs2l.ts` and `lib/casino/settlement-rules.ts`
were diffed against the proven copies in
`C:\Users\k1rby\projects\robinwood-plank-cos-crash\lib\casino\`:
**byte-identical settlement mathematics** (the only differences are documentation
comments — this worktree carries the newer ratified 40/40/20 split note, and its
simulation adds the evolutionary-rake staircase and Powerboard funding routing on top).
No reconciliation of math was required. 2026-09-02 addition: purely additive telemetry
fields `floorPayout`/`performancePayout` on each allocation (§4); payout arithmetic and
all conservation identities untouched, guarded by tests.

## 3. Commitment-time rule + parameter-hash persistence (condition b)

Present and verified in this worktree:
- `lib/casino/settlement-rules.ts` — registry mapping (rule, version) → frozen settle
  implementation + deterministic `paramsHash`; for ccs-2l v1 the hash is
  `keccak256(abi.encode(keccak256("ccs-2l"), 1, floorBps, houseCapBps))`, byte-identical
  to `PlankCcs2LMath.paramsHash()`. `replayCommittedRound` settles ONLY under the
  recorded descriptor and throws `SettlementRuleMismatch` on any hash drift — it never
  falls back to current config. Historical pfss rounds replay as pfss (v1).
- `lib/playtest-rooms.ts` — the descriptor is persisted in the `round.launched` event
  (commitment time, same transaction as the crash commitment) and echoed on
  `round.settled` (guard test asserts both persistence sites).
- On-chain fields (`settlementRuleId`, `settlementParamsHash` in the round commitment
  struct) remain SPECIFIED, not deployed — the live PlankCrashDrand is frozen (§6).

## 4. Player-facing settlement disclosure (condition c)

The round-summary card in `public/arcade/crash.html` now discloses, for ccs-2l rounds:
player pot after the effective routed rake (`playerDistributable`), the seat's hazard
weight (`stake × ln(locked multiplier)`), the player-layer payout decomposed into
survivor floor + performance premium, the house bonus when non-zero, and the exact
total returned + net. Busted seats get honest copy ("nothing is returned to busted
seats"), never an invented number. Displayed == redeemable: every displayed component
sums exactly to the paid total. Guarded by
`test/market/playtest-presentation.test.ts` ("round summary discloses the full CCS-2L
settlement decomposition").

## 5. Telemetry for the adversarial-multiplayer evidence phase (condition d)

Every settled round's `round.settled` event already carried: the settlement descriptor
(rule id, version, `paramsHash`, params), `effectiveRakeBps`, `evolutionTier`, and the
full accounting object. Added 2026-09-02: per-seat `floorPayout` and
`performancePayout` on every allocation (with `houseBonus` already present), so each
seat's payout decomposes exactly as floor + performance + house bonus.
Identities guarded by `test/market/settlement-rules.test.ts`:
`floorPayout + performancePayout === playerPayout` per seat and
`Σ(floor) + Σ(performance) === totalPlayerPaid` per round.

## 6. Remaining EXTERNAL gates (stated plainly)

1. **Independent audit before any real value.** CCS-2L is NOT audit-complete
   (CCS2L design §9.2). No mainnet or real-asset deployment until an independent
   audit of the settlement math, the registry, and the integration passes.
2. **On-chain commitment fields.** The frozen PlankCrashDrand contract cannot carry
   `settlementRuleId`/`settlementParamsHash`; the next contract revision MUST add both
   to the round commitment struct, written in the randomness-commit transaction, with
   the settlement path requiring an exact hash match.
3. **Adversarial-multiplayer evidence phase.** Owner-run live evidence collection using
   the §5 telemetry (the private-canary §8 criteria of the integration design remain
   the bar: ≥200 green rounds).
4. **Crash-law coupling.** `g(m) = ln m` is exact ONLY for the 1/m law; any change to
   `_deriveCrash`/`simulationCrashBps` requires re-deriving g before ccs-2l may settle
   a single round under the new law.

## 7. Consolation prize — REJECTED (owner's three-leg bar not met)

Owner's bar: no consolation unless it **(a) materially improves game theory AND
(b) reduces attacks AND (c) monotonically compounds**. Verdict per leg:

- **(a) Incentive alignment — NOT ESTABLISHED.** The candidate designs (a slice of the
  prize on a miss, or a small per-draw payment to ticket holders) do not correct any
  identified misaligned incentive. Variance-farming is already structurally closed
  (linear stake-weight tickets, rake-paid qualification, partition-invariant weights);
  last-second-abandon has no analogue in a committed-stake round. The genuine support
  for consolation is retention-behavioral (CPT small-win frequency, Barberis 2012) —
  a marketing effect, not a game-theoretic improvement. Honest classification:
  retention, not alignment. Leg fails.
- **(b) Attack-surface reduction — FAILS.** No concrete attack is removed. A recurring
  consolation payment per draw CREATES a farmable per-draw yield surface: any positive
  expected consolation per unit weight invites minimum-stake weight accumulation priced
  against the consolation stream rather than the jackpot, i.e., a new sybil/grind
  channel that must then itself be clamped. Strictly worse on this leg.
- **(c) Monotone compounding — WEAKENED, not preserved-and-improved.** Every credit
  paid as consolation on a miss is a credit removed from rollover, and rollover is what
  drives `nextPrizeTarget = max(prior + minIncrease, progressive base)` and funds the
  reset reserve ahead of schedule. Consolation slows the compounding of the flagship
  guaranteed base; it does not break the ratchet (V5's guarantees are enforced
  independently), but "monotonically compounding" as an improvement bar is not met.

**Conclusion: legs (a) and (b) fail outright, (c) is weakened ⇒ NOTHING IMPLEMENTED.**
The `consolation` policy parameter remains present and set to 0 in the playtest
laboratory; this rejection is the standing decision of record. Any future revisit must
present new evidence of a concrete attack that consolation removes — retention-only
arguments are insufficient by the owner's own bar.

## 8. Playtest test-credit profile (owner decision 2026-09-03)

**Scope: the public laboratory's DEFAULT policy only** (`DEFAULT_PLAYTEST_POLICY`,
`lib/playtest-room-core.ts`). Nothing in `contracts/` or `lib/casino/` changes; the rake
(450 bps, floor 250, step 25 / 25M), the ratified 40/40/20 split, the 10% lottery founder
fee, `lotteryMinimumIncrease` / `lotteryBaseGrowthBps` / `lotteryMinimumBaseStep`
(50k / 5% / 50k) and the CCS-2L settlement rule are exactly as ratified above.

| Parameter | Ratified-era playtest default (v2) | Playtest test-credit profile (v3) |
|---|---|---|
| `lotteryInitialBase` | 1,000,000 credits | **50,000 credits** |
| `powerboardFundingBps` | 10,000 (100% of the community leg → prize) | **6,500 (65% → prize; 35% retained)** |

**Reason — reachability.** At minimum stakes a two-seat round moves roughly 11–22 credits
into the prize pipeline (pot 1,000 → rake 45 → community 18 → 65% ≈ 11; at the pre-change
100% routing ≈ 18–22). The 1,000,000 base grossed up by the founder fee demanded
`minimumLotteryGross(1,000,000, 10%) = 1,111,111` credits of funding before the epoch
could even seal — tens of thousands of rounds — so no laboratory table ever reached a live
draw without host injection. Retaining 35% of the community leg also makes the protected
vault visibly compound (50/50 into `protectedPrincipal` and the emission buffer) instead
of showing 0 for the life of a table.

**Funding math (same kernel the engine's funded gate uses — `minimumLotteryGross`):**

- Per 2 × 10,000-credit round: pot 20,000 × 4.50% = 900 rake → community 360 →
  **234 to the prize** (`powerboardFundingAdded`), **126 retained** → 63 protected principal
  + 63 emission buffer.
- Prize seal gate: `minimumLotteryGross(50,000, 1,000 bps) = 55,555` gross → seals on
  round ⌈55,555 / 234⌉ = **238** at that stake; sealed net prize exactly 50,000.
- Reset-reserve gate (draw arms only when BOTH are covered): next base
  `50,000 + max(5%, 50,000) = 100,000` → `minimumLotteryGross(100,000) = 111,111` gross;
  arms on round ⌈(55,555 + 111,111) / 234⌉ = **713**.
- After a hit: base ratchets to 100,000, the next prize (100,000) is re-seeded from the
  sealed reserve, and the reserve refills toward `minimumLotteryGross(150,000) = 166,666`.

**Migration of existing tables (round boundary only, never mid-flight).** `startPlaytestRound`
already advanced tables whose stored prize tuple equalled the legacy v1 profile
(25% / 100k). That check is now `legacyPlaytestPrizeProfile()`, which recognises BOTH
superseded shipped defaults (v1 and the v2 tuple above) and advances them to the current
default on the next launch. Bespoke host-edited tuples are never rewritten. When a v2 table
is advanced and its lottery is still UNSEALED and undisplayed (`awaitingSeal`, `netPrize`
0, no rollover, no armed draw, `cycleBase == nextPrizeTarget == 1,000,000`) the target is
re-based to 50,000 by `rebasePlaytestLotteryTarget()`; accrued `pendingFunding`,
`resetReserve` and principal are untouched (accounted assets conserved exactly). A sealed
or ratcheted prize is a displayed promise and is never lowered. Every such migration is
recorded on that round's `round.launched` event as `policyMigration` (`prizeProfile`
from/to, per-key policy from/to, `lotteryTargetRebased`, and the target from/to). New
tables start on the v3 profile directly.

Pinned by `test/market/playtest-room-core.test.ts` (profile pin; funded gate arms at the
new base with the founder gross-up; re-basing rules) and proven end-to-end against the real
server + PostgreSQL by `test/e2e-playtest/lottery-funding-payout.spec.ts`.

## 9. Evidence links

- `docs/marketplank/RESEARCH-vision-economics-sota-config-2026-09-02.md` — the review
  behind these decisions (SOTA grounding, PROVEN vs JUDGMENT labeling).
- `docs/marketplank/sim-settlement-ccs2l/` — engine, partition search (39,680 cases,
  worst wallet-split gain 0 wei), campaign evidence (8M rounds, 0 solvency failures).
  Standing qualification: finite adversarial search, not a universal proof.
- `DESIGN-PLANKCRASH-CCS2L-INTEGRATION-2026-08-31.md` (cos-crash worktree) — the
  integration design; its "pfss remains default" line is superseded by this worktree's
  live `ccs-2l` default and by this ratification.
- `test/market/settlement-rules.test.ts`, `test/contracts/PlankCcs2LSettlement.test.ts`
  (Solidity/JS differential), `test/market/casino-simulation.test.ts` — green suites at
  ratification time.
