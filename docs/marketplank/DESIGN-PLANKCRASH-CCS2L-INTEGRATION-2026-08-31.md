# DESIGN: PlankCrash CCS-2L Settlement — Integration + Partition-Invariant House Cap (v1.1)

Status: INTEGRATED on branch `integrate/ccs2l-settlement` (worktree
`robinwood-plank-cos-crash`). The live playtest default `allocationRule`
remains **"pfss"** — `"ccs-2l"` is selectable, not default. Nothing here
touches master, the live deployment, or the five protected live-production
files (`contracts/PlankCrashDrand.sol`, `public/arcade/crash.html`,
`public/arcade/functions/rpc.js`, `scripts/casino-keeper.ts`,
`scripts/relay-drand.ts`).
Date: 2026-08-31 · Author model: claude-fable-5
Builds on: `DESIGN-PLANKCRASH-TWO-LAYER-SETTLEMENT-2026-08-31.md` (repo
`robinwood-plank-crash`) — the CCS-2L analysis and v1.0 evidence. **Variant A
is APPROVED as canonical. Variant C (forward-seed recycling) is REJECTED**;
its campaign artifacts (`campaign-C-*.json`, the `sniper` carry harness in
`campaign.mjs`) are retained solely as *rejected-control evidence* of its
farming surface (800,702 tokens / 1.55% of stakes harvested cross-round in
2M rounds) and MUST NOT be carried into any settlement rule. The single-purse
CCS (`docs/marketplank/sim-settlement-ccs/`, `PlankCcsSettlement.*`) remains
archived as the rejected predecessor for the same reason (player-pot
confiscation).

## 1. THE ONE ECONOMIC FIX — the partition-invariant house cap (v1.0 → v1.1)

v1.0's house layer capped each seat's bonus at
`reserveAtLock * singlePayoutCapBps / BPS` — a **per-wallet** constant.
Constant-per-address caps are split-relaxable: dividing one economic position
across N wallets granted N caps, raising the aggregate house bonus. That cap
is REMOVED. v1.1 requires every house-protection constraint to be
**identity-independent and positively homogeneous in stake**:

```
H_avail = min(H, reserveAtLock * houseCapBps / BPS)   GLOBAL purse cap —
                                                      wallet count cannot move it
w_i     = s_i * lnScaled(m_i)                         house weight, linear in s
b_i     = min(H_avail * w_i / W,  s_i*(m_i-BPS)/BPS)  per-seat FAIR-ODDS cap —
                                                      linear in s, additive
                                                      under splits (lawful local
                                                      cap; implies the aggregate
                                                      constraint Σb ≤ Σ s(m−1))
H_returned = H − Σ b_i        → PROTECTED RESERVE (never players, never treasury)
```

Global constraints only (total reserve-at-lock cap via `H_avail`; the seed
budget via `H` itself; the aggregate fair-odds constraint via the linear
per-seat caps). Splitting a position at the same lock leaves `Σw` and the
fair-cap sum unchanged, and floor division is sub-additive, so the integer
aggregate under any partition is ≤ the unsplit baseline.

**Acceptance criterion, measured** (`sim-settlement-ccs2l/partition.mjs`,
seed 20260831 → `partition-results.json`): exhaustive same-lock (64-step
2-part grid + 1-wei extremes + k=3..6 compositions), adjacent-lock (±1/±2/±50),
multi-target (parts across the whole surviving range vs the top-lock
baseline), and multi-wallet (k=2..20 under a hard-binding global cap — the
exact v1.0 exploit configuration), each under slack, binding, and 1–2-wei
reserves:

| search | cases | worst aggregate house-bonus gain |
|---|---|---|
| S1 same-lock 2-part grid | 22,680 | **0 wei** |
| S1 1-wei extremes | 720 | **0 wei** |
| S1 k-part (3..6) | 1,440 | **0 wei** |
| S1 skewed | 1,440 | **0 wei** |
| S2 adjacent-lock | 8,400 | **0 wei** |
| S3 multi-target | 1,200 | **0 wei** |
| S4 multi-wallet, binding cap | 3,800 | **0 wei** |
| **total** | **39,680** | **0 wei** (bound: < survivorCount wei) |

The v1.0 relaxation demonstrated in the old I5b (split doubled the wallet
cap) is now a regression test: `run.mjs` I5b asserts split bonus ≤ unsplit
bonus and Σb ≤ H_avail.

## 2. What is integrated on this branch

- `lib/casino/economics.ts`: `AllocationRule` now includes `"ccs-2l"`;
  `settleParimutuel` refuses it with a pointer to the two-purse API
  (the previously-unapplied `candidate.diff`, applied).
- `lib/casino/economics-ccs2l.ts`: the canonical variant-A rule with the v1.1
  house layer (params: `floorBps = 7_500`, `playerWeight = "ln"`,
  `houseCapBps = 1_000` — global, of reserveAtLock; all still ratification
  decisions).
- `lib/casino/simulation.ts`: `simulateIteration` dispatches `"ccs-2l"` to
  `settleCcs2L` (reserveAtLock = post-seed-draw emission buffer;
  `houseReturned + bustedToReserve` flow back to the emission buffer, never
  through the community/principal split). Default policy unchanged
  (`lib/playtest-room-core.ts`: `allocationRule: "pfss"`).
- `contracts/lib/PlankCcs2LMath.sol`: production-shaped library (settle +
  lnScaled + paramsHash), `contracts/test/PlankCcs2LSettlement.sol` reduced to
  a thin external harness over it.
- `lib/casino/settlement-rules.ts`: rule-version registry + commitment-time
  descriptor + replay (§4).
- `lib/playtest-rooms.ts`: the descriptor is persisted in the append-only
  event log at round commitment (§4).

## 3. Shared fixed-point conventions (JS ⇄ Solidity, must never diverge)

Documented in `PlankCcs2LMath.sol`'s header and mirrored in
`economics-ccs2l.ts` / `engine.mjs`:
- 1.00x == 10_000 bps (`BPS`); locks ≥ `MIN_TARGET_BPS` = 10_100.
- `lnScaled(xBps) ≈ ln(x/1e4)·1e6`, floor: Q96 normalization, 40 bits of log2
  by repeated squaring, then `· 693_147 >> 40`. Bit-identical by construction
  (asserted on 209 points + every settlement).
- `lambda = premium · 1e18 / W` (informational closed form; no bisection).
- Floor division everywhere; deterministic residue routing (player dust →
  largest-weight survivor, lowest index tie; house remainder → reserve).
- Bounds: stake ≤ 1e30, target ≤ 1e9, pots ≤ 1e33 ⇒ worst product ~2.1e70 <
  2^256; no `unchecked`.

Wei-exact differential: `test/contracts/PlankCcs2LSettlement.test.ts` —
**6 passing**: EIP-170 size check, paramsHash byte-pin, ln sweep, 8 named
cases, 500 random rounds (every payout/bonus/λ/mode/dust/houseReturned/
bustedToReserve equal, both conservation identities asserted on the Solidity
outputs), gas.

Gas (normal mode, viaIR, paris): n=2: **73,899** · n=10: **158,600** ·
n=50: **669,807** · n=100: **1,310,767** (~13k gas/survivor; the v1.0
figures were 73,764 / 159,865 / 678,064 / 1,327,765 — the v1.1 layer is
slightly cheaper at scale). Harness deployed size passes EIP-170.

## 4. Rule versioning + commitment-time persistence

`lib/casino/settlement-rules.ts`:
- **Registry**: (rule, version) → frozen implementation. Registered: `pfss` v1,
  `stake-only` v1, `stake-multiplier` v1 (all → `settleParimutuel`), `ccs-2l`
  v1 (variant A only → `settleCcs2L`). Unregistered versions throw.
- **paramsHash**: for `ccs-2l` v1,
  `keccak256(abi.encode(keccak256("ccs-2l"), 1, floorBps, houseCapBps))` —
  byte-identical to `PlankCcs2LMath.paramsHash()` (pinned in both suites to
  `0xbfa05cce17a89480a879c4aea43ba1538764931a333c64e0a7c66852097f4f9f` for the
  default params, so TS and Solidity are bound through the literals). Legacy
  rules use `sha256:` + canonical-JSON (no tunables; predate the convention).
- **Replay**: `replayCommittedRound(record)` settles under the RECORDED
  descriptor only — it re-derives the hash from the recorded params and throws
  `SettlementRuleMismatch` on any drift; it never falls back to current
  config. Historical pfss rounds replay as pfss forever
  (`test/market/settlement-rules.test.ts`, 8 passing).
- **Persistence at commitment (off-chain, implemented)**: `startPlaytestRound`
  writes `settlementDescriptor(policy.allocationRule)` into the append-only
  `round.launched` event beside the randomness commitment (and again in
  `round.settled`); `updatePlaytestPolicy` is already refused while a round is
  running, so the committed descriptor cannot drift before settlement.
- **Persistence at commitment (on-chain, SPECIFIED — the live contract is
  frozen on this branch)**: a future PlankCrashDrand revision adds to the
  round-commitment struct
  `bytes32 settlementRuleId; bytes32 settlementParamsHash;` written in the
  same transaction that commits the round randomness; settlement requires the
  executing rule/params to hash to those exact values. `PlankCcs2LMath`
  already exposes `RULE_ID`/`RULE_VERSION`/`paramsHash` for it.

## 5. Post-fix campaigns (item 9) — ≥2,000,000 rounds each, re-run under v1.1

Same harness as v1.0 (2–25 seats, 6 strategies, rake 3%, reserve 2,000 with
1/200 seeding, exact `_deriveCrash` law). **0 solvency failures in 8,000,000
rounds** (A, A-seed777, B, C). In every campaign JSON:
`identity.exact: true` and
`playerRtpEqualsOneMinusEffectiveRakeWeiExact: true` — the player-layer
RTP == 1 − effective-rake identity holds as a bigint equality after the cap
correction, AND the house layer is now partition-invariant (§1).

| | A (canonical) | A seed 777 | B (odds dial) | C (REJECTED control) |
|---|---|---|---|---|
| player-layer RTP (=1−eff rake, wei-exact) | 0.867050 | 0.867580 | 0.866302 | 0.866538 |
| aggregate RTP | 0.9700 | 0.9700 | 0.9700 | 0.9700 |
| reserve end (start 2,000) | 970 | 817 | 948 | 647 |
| sniper carry harvest | 0 | 0 | 0 | **800,702 tokens (1.55%)** |

Variant A per-strategy (RTP = player + house bonus · ruin/1000-bet life):
early 1.041 (0.953+0.089, ruin 0.000) · mid 0.653 (0.484+0.169, ruin 0.722) ·
greedy 0.147 (0.100+0.047, ruin 1.000) · mixed 0.895 (0.787+0.108) ·
adversarial 0.771 (0.592+0.179) · sniper 0.921 (0.736+0.186). The ln house
weight (v1.1) pays realized hazard rather than ex-ante odds, so relative to
v1.0 it shifts bonus from long-shot locks toward the hazard actually endured;
mid-lock ruin rises (0.42 → 0.72) — a parameter-ratification observation, not
a solvency issue (both identities remain exact; bonuses never exceed fair
odds or the global reserve cap).

Property suite `run.mjs`: **619,221 checks, 0 failures**. `scenarios.mjs`:
0 failures (cap-saturation now demonstrates the GLOBAL cap: aggregate bonus ≤
H_avail, remainder → reserve, 0 to treasury). Partition proof: §1.

## 6. Round-export replay (item 11)

**No actual exported playtest round exists in-repo** (searched `test/market`,
`test/contracts/fixtures`, `docs/marketplank`; the owner's real round-123
record was never committed). `sim-settlement-ccs2l/replay.mjs` therefore
documents the exact expected export format (decimal-string wei/bps fields,
optional commitment-time `settlement` descriptor which is verified and, if it
names another rule, refuses to replay under ccs-2l) and replays a
**clearly-labeled SYNTHETIC round-123-SHAPED scenario** (the 10-seat 40.00x
shape from `sim-settlement/run.mjs`) → `replay-round123-synthetic.json`:
D_players 19,400,000,000 paid exactly, bonuses 49,999,996 + houseReturned 4
== seed 50,000,000, treasury residue 0.

## 7. Player-facing settlement disclosure (item 12 — content only; the live
`crash.html` is a protected file and is NOT wired here)

Per-seat post-round disclosure, in this order (all values from the settlement
record, never recomputed from config):

1. **Player pot after rake** — "This round's player pool was X PLANK; after
   the disclosed R% rake the player pot was Y PLANK. When anyone survives,
   100% of Y is paid to survivors — the house never keeps any of it."
2. **Your performance weight** — "Your claim on the player pot grows with
   stake × the hazard you survived (ln of your locked multiplier). Your weight
   this round: w = s·ln(m) → Z% of the pot's premium (floor: 75% of your stake
   back on any survival)."
3. **Your player-layer payout** — "From the player pot: P PLANK."
4. **Optional house bonus** — "House bonus (house money, on top): B PLANK.
   Bonuses are capped at fair odds s·(m−1) and by a GLOBAL round cap of
   [houseCapBps/100]% of the house reserve — the cap is on the whole round, so
   splitting a bet across wallets cannot raise it. Unused house money returns
   to the protected reserve, never to the treasury."
5. **Total returned / net** — "Returned: P+B PLANK. Net: (P+B−s) PLANK."
6. **Standing disclosures** — the all-bust rule ("if nobody survives, the
   round's pot goes to the protected reserve; this is part of the effective
   rake, disclosed as such") and the aggregate-identity qualification (§9.1).

Structure for the candidate UI: a `settlementDisclosure(allocation, round)`
formatter beside the settlement record (implemented later in the candidate
frontend, never in the protected live file on this branch).

## 8. Private canary + rollback (item 13 — PREPARED, NOT DEPLOYED)

Canary (laboratory-only, no real value):
1. Create a PRIVATE playtest room (invite-only, admin-owned) on a staging
   database; leave every public room untouched.
2. Set the room's policy `allocationRule` to `"ccs-2l"` via the host console
   patch (`updatePlaytestPolicy`) — the only surface that changes; the global
   `DEFAULT_PLAYTEST_POLICY` stays `"pfss"`.
3. Run ≥ 200 rounds with scripted players; after each `round.settled`, assert
   from the event log: descriptor rule == "ccs-2l" v1 with the pinned
   paramsHash; Σ playerPayout == playerDistributable; Σ bonus + houseReturned
   == seed; aggregate bonus ≤ min(seed, reserveAtLock·houseCapBps/BPS).
4. Abort criteria: any identity failure, any `SettlementRuleMismatch`, any
   negative-liability invariant throw → rollback immediately.

Rollback procedure:
1. Patch the canary room's policy back to `"pfss"` between rounds (policy
   changes are refused mid-round, so no round is ever half-ruled).
2. Rounds already settled under ccs-2l stay ccs-2l forever — their committed
   descriptors replay them correctly; no restatement, no migration.
3. If the code path itself must be withdrawn, revert the integration commits
   on this branch (each commit is a recovery point); the registry keeps
   replaying recorded ccs-2l rounds even after the selectable option is
   removed, because replay dispatches on the recorded descriptor.

## 9. Qualifications (explicit, standing)

1. **"player RTP == 1 − rake" is an AGGREGATE player-layer identity, not an
   individual promise.** Individual strategy outcomes vary enormously
   (measured: early 1.041 vs greedy 0.147 total RTP; greedy ruin ≈ 1.0 per
   1,000-bet life). The identity says only that, summed over all players and
   rounds, the player layer pays out exactly stakes − disclosed rake −
   all-bust redirection, wei-exact.
2. **Production-candidate quality requires BOTH** (a) the wallet-split
   house-cap eliminated — done in this mission (§1, 0-wei worst gain) — AND
   (b) the production integration reproducing the test-only evidence (the
   live contract, claim flow, and UI still run the frozen v1.0-era code on
   this branch). This is **NOT audit-complete**: no security audit, no
   reentrancy/storage/claim-path work on the Solidity, parameters
   (f, houseCapBps, weight) unratified, and a changed crash law would require
   re-deriving g as that law's cumulative hazard.

## 10. Reproduce

```
npm run test:ccs2l                    # run.mjs (619,221 checks) + scenarios + partition proof
node docs/marketplank/sim-settlement-ccs2l/partition.mjs        # exit 0, worst gain 0 wei
node docs/marketplank/sim-settlement-ccs2l/replay.mjs           # synthetic round-123 replay
node docs/marketplank/sim-settlement-ccs2l/campaign.mjs A 2000000 20260831 out.json
npm run test:ccs2l-differential       # 6 passing (wei-exact JS<->Solidity + size + gas)
npx tsx --test test/market/settlement-rules.test.ts             # 8 passing
npm test                              # full market + contracts suites
```

CI (`.github/workflows/inmotion.yml`): `npm run test:ccs2l` runs as its own
step; the wei-exact differential runs inside `npm test` (test:contracts);
lint:inmotion covers the new lib/test files. Artifact hashes:
`docs/marketplank/sim-settlement-ccs2l/manifest.json`.
