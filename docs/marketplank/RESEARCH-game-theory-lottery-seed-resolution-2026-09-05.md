# Game-theory resolution of F-1 (lottery drain) and F-2 (seed farm)

Date: 2026-09-05 · Scope: `contracts/PlankCrash.sol`, `contracts/PlankLottery.sol`, `contracts/lib/PlankCcs2LMath.sol`
Status: RESEARCH COMPLETE and **IMPLEMENTED** (§10). Verified numerically (`scripts/research/gametheory-f1-f2.mjs`, reproduces every audit figure) and on-chain (A-9b, A-10 inverted; L-7..L-9). Owner rulings 2026-09-05: one global game, no tables; **no forced hit** (a progressive lottery pays when the ball falls).

Reference inputs: `AUDIT-ccs2l-contracts-hardening-2026-09-05.md` (F-1, F-2), `DESIGN-vault-lottery-progressive-carve-2026-09-04.md`, `RATIFICATION-ccs2l-2026-09-02.md`, tests A-9b and A-10 in `test/contracts/PlankCrash.adversarial.test.ts`.

## 0. Result in one paragraph

F-1 and F-2 are the same defect. In both, the protocol pays a **fixed** amount (the 10,000-credit house seed; the prize `W(P)`) against a **variable** contribution that the attacker chooses to be minimal (a 5,000-credit min-pool round paying 225 rake). Any mechanism that pays a fixed reward against a player-chosen contribution is farmable once the reward exceeds the contribution, and no parameter tuning escapes it (Theorem 1, Theorem 3). The elegant fix is one principle applied twice, the **actuarial identity**: *a round can never expect to take out of a shared pool more than it put in.* Concretely: (i) the house bonus a round may draw is capped by a fraction of that round's own rake, `H_round = min(seed, reserveCap, κ_h · rake_round)`; (ii) the lottery hit probability is `p = min(1/oddsOneIn, c_round / (κ · W(P)))` where `c_round` is the round's routed lottery contribution; (iii) the forced hit (`mustHitByRounds`) is **removed** — it was the cheapest F-1 vector and a progressive lottery does not need it. Under (i)–(ii) the attacker's EV is `(κ_h − 1)·rake < 0` and `(c/κ) − rake < 0` for **every** pool size, split, target choice, seed size and prize size (verified: max EV −166 and −196 credits per round respectively). Honest players are unaffected in the parimutuel layer, and the prize grows *forever* at rate `c(1 − 1/κ)` per round, which is exactly the owner directive. The cost is fundamental and stated in §6: draw frequency becomes proportional to prize size, as in every real progressive jackpot.

**Architecture note.** The site hosts exactly one PlankCrash, one PlankLottery and one vault. There are no tables: `PlankCrash.currentRoundId` is a single global sequence on a fixed clock. "Manufacturing a round" therefore means *being the only participant in a round that runs anyway*, i.e. betting with two sybil wallets during quiet hours when no honest player joins. The attacker cannot create rounds, only occupy empty ones, and every round contributes to the one site-wide prize. All results below are unchanged by this; "round" replaces "table" throughout.

## 1. Model

Notation (credits): pool `Q = Σ s_i`; rake `r·Q` with `r ∈ [0.025, 0.045]`; distributable `D = (1−r)Q`; floor `f = 0.75`; weights `w_i = s_i ln m_i` over survivors; `W = Σ w_i`; survival law `P(crash ≥ m) = 1/m` (discrete `floor(1e8/m)/1e4`). Player layer returns all of `D` to survivors when any survive (floors plus premium). House layer: `H = min(seed, reserveAtLock·houseCapBps)`, `b_i = min(H·w_i/W, s_i(m_i − 1))`, `houseReturned = H − Σ b_i`. Lottery: contribution per round `c = 0.40 · 0.65 · r · Q = 0.26·r·Q`; hit `1/N`, `N = 16`; winner takes `W(P) = P(1 − x(P))`, carve `x(P) = 0.10 + 0.20·P/(P + 250,000)`; `mustHitByRounds` forces a hit after 96 (deploy 1,536) rounds.

**Lemma 1 (sybil zero-sum).** If every seat in a round belongs to one principal, the player layer nets that principal exactly `−r·Q` regardless of targets, splits and the crash point, because `D` is returned in full whenever any seat survives and the attacker can always hold one seat at `1.01×` (survives with probability 0.990). The only channels through which a quiet round (attacker is the only participant) can profit are the house layer and the lottery. This reduces both findings to one-dimensional problems.

## 2. F-2, the seed farm

**Derivation.** Attacker holds `A` at `m_A = 1.01×` with `s_A = (1−ω)Q` and `B` at `m_B` with `s_B = ωQ`, `ω ≤ 0.6` (whale cap). When both survive (probability `1/m_B`), `w_B/W ≈ 1` because `ln m_B ≫ ln 1.01`, so `b_B = min(H, s_B(m_B − 1))`. The attacker chooses `m_B* = 1 + H/s_B`, making the fair-odds cap bind exactly at `H`. Expected bonus:

    E[bonus] = H / m_B* = H·s_B / (H + s_B)

and by Lemma 1

    EV_F2 = H·s_B/(H + s_B) − r·Q.                                   (1)

With `H = 10,000, s_B = 3,000, r·Q = 225`: (1) gives `+2,083`; the discrete law gives `+2,044` (audit: `+2,043`, test A-9b). Best-response search over `ω ∈ [0.05, 0.6]` and `m_B` confirms `ω = 0.6`, `m_B ≈ 4.37×` is optimal.

**Theorem 1 (any fixed seed is farmable).** Substituting `s_B = ωQ` in (1), `EV_F2 > 0 ⇔ H > Q · rω/(ω − r)`. At `r = 0.045, ω = 0.6` the threshold is **4.86 % of the pool**; at the rake floor `r = 0.025` it is **2.61 %**. A fixed seed of 10,000 against a 5,000 min pool is 200 %. Raising `minPoolWei`, lowering the whale cap or lowering the seed only moves the threshold; it cannot remove it because `H` is a constant and `Q` is attacker-chosen. Making the seed pool-proportional (`H = σQ`) is sybil-proof iff `σ ≤ rω/(ω − r)`, i.e. `σ ≤ 2.6 %` at the rake floor, which is too small to be a meaningful house bonus and couples the seed to the rake schedule.

**Mechanism (F-2).** Cap the house draw by the round's own rake:

    H_round = min(seed, reserveAtLock·houseCapBps/BPS, κ_h · rake_round),   κ_h ∈ (0, 1).

**Theorem 2 (sybil-proofness).** For any partition of a round into seats owned by one principal, `Σ b_i ≤ H_round ≤ κ_h·rake_round`, and by Lemma 1 `EV ≤ (κ_h − 1)·rake_round < 0`. The bound holds for every `Q`, `ω`, targets, `seed`, `P` and rake tier; it does not depend on the survival law. Mixed rounds (honest players present): the honest seats' bonus is unchanged in form (`H·w_i/W`, fair-capped); the attacker cannot increase `H_round` without paying rake proportionally, so the attacker's extraction is still bounded by `κ_h·rake_round` of their own money. Verified numerically over `Q ∈ {5k, 20k, 100k, 1M}`, `seed ∈ {10k, 100k, 1M}`, `ω ∈ [0.05, 0.6]`, `m_B ∈ [1.01, 10,000]`, `m_A ∈ {1.01, 1.5, 2.0}`: **max attacker EV = −166.1 credits/round** (at the min pool, i.e. `(0.5 − 1)·225` less rounding).

Interpretation for players: the house bonus is the house *matching a slice of the rake back to survivors who took real risk*. With `κ_h = 0.5` it is exactly "the house returns up to half the rake as a risk bonus". The `seed`/`emissionBuffer` machinery remains the *bankroll* that funds it; the vault floor `protectedPrincipal` remains untouched. Partition invariance of the player layer is unaffected because the change is confined to `_houseLayer`.

## 3. F-1, manufactured lottery rounds

**Derivation.** A solo min-pool round costs `r·Q = 225` and buys a `1/N` chance at `W(P)` with the attacker holding 100 % of the round's tickets (round-only eligibility makes this legitimate: the round is theirs). By Lemma 1,

    EV_F1 = W(P)/N − r·Q.                                              (2)

Break-even `W(P) = 3,600 ⇒ P = 4,015` (audit: ~4,000). At `P = 90,000`, `W = 76,235` (audit A-10). Forcing via `mustHitByRounds = 96` costs `96 × 225 = 21,600` for a certain win of `W` (audit).

**Theorem 3 (flat odds are unbounded-EV).** With `p = 1/N` fixed, (2) is increasing and unbounded in `P`, so for any `N`, `minPoolWei`, `r`, there is a `P` above which manufacturing rounds is +EV, and the prize can never be allowed to grow past it. This directly contradicts "it can grow forever". The two owner directives (round-only eligibility, unbounded growth) are compatible with each other but **incompatible with a flat per-round hit probability**.

**Mechanism (F-1).** Actuarial hit rule:

    p_round = min( 1/N ,  c_round / (κ · W(P)) ),   κ > 1,   c_round = lotteryShare · rake_round.

Expected outflow per round `p·W ≤ c/κ < c`, so **the pool never expects to pay out more than `1/κ` of what the round paid in**, and the prize grows in expectation by `c(1 − 1/κ)` per round *unconditionally* (`P` is a strict submartingale). Small prizes keep the `1/N` cadence (branch 1 binds while `W < κ·N·c`, i.e. below ≈ 7,500 credits for a 20 k-credit round at `κ = 2`).

**Theorem 4 (sybil-proofness).** For a manufactured round `EV = p·W − r·Q ≤ c/κ − r·Q = r·Q(0.26/κ − 1) < 0` for all `κ > 0.26`; with `κ = 2`, EV `= −0.87·rake` for every `Q` and `P`. Verified over `Q ∈ {5k, 20k, 100k}`, `P ∈ [1k, 10M]`: **max EV = −195.8 credits/round**. Splitting one bankroll across many small rounds does not help: `p` is linear in `c_round` below the cap, so `k` rounds of contribution `c/k` have the same total hit mass as one round of `c` (additivity), while paying the same total rake.

**mustHitBy: removed (owner ruling).** The round-counted forced hit cost 21,600 credits to trigger at `P = 90,000` and was the cheapest F-1 vector. A contribution-counted backstop (force when `Σ c ≥ M·W`) was analysed and would be safe (forcing cost 1.76 M credits to win 76 k), but the owner ruled that the site runs a pure progressive lottery: the prize pays when the ball falls, and the actuarial rule already guarantees a finite, traffic-proportional expected time to every hit. Nothing forces a draw; nothing can be forced.

## 4. Equilibrium and growth

Under the design doc's flat odds, `P` had a unique attracting equilibrium `P*` because outflow `W(P)/N` grew with `P`. Under the actuarial rule outflow is capped at `c/κ`, so there is **no equilibrium**: `E[P_{t+1} − P_t] = c(1 − 1/κ) > 0` always. This is "grow forever" realised literally, and the carve `x(P)` still applies on every hit so each next cycle starts from `S = x(P)·P`, which also grows without bound. `x(P)` remains in the admissible family; nothing in `DESIGN-vault-lottery-progressive-carve` changes except the equilibrium section, which becomes a drift section.

Growth rate at ratified parameters, 20 k-credit rounds, `κ = 2`: `+117` credits per round net of expected payouts; 1 M credits (1 ETH) of prize in ≈ 8,500 rounds ≈ 4 days of continuous play at 40 s per round. Honest cadence (`E[rounds to hit]`) at `P = 10k / 50k / 150k / 500k / 1M`: `76 / 370 / 1,058 / 3,276 / 6,325`.

## 5. Mechanisms considered and rejected

| Mechanism | Why rejected |
|---|---|
| Raise `minPoolWei` / lower whale cap / lower seed | Moves the F-2 threshold (Thm 1), never removes it. |
| Pool-proportional seed `σQ` | Sybil-proof only for `σ ≤ 2.6 %`; couples seed to the rake tier; not a real bonus. |
| Cap prize at `P_max` | Contradicts "grow forever"; `P_max` would have to be ≤ 4,000 credits at current rake, i.e. no lottery. |
| Ticket weight by wallet age / history | Cross-round eligibility, which the owner rejected; sybil wallets age for free. |
| Minimum qualifying pool `Q_min(P)` scaling with `W` | Same cadence as the actuarial rule but excludes small honest rounds from draws entirely; strictly dominated. |
| Contribution-banked draws (fires when Σc ≥ threshold, winner from that round) | Same expected cadence as actuarial `p`; deterministic in money, so a whale can time the crossing round. Kept only as the `mustHitBy` backstop. |
| Per-wallet cooldown / KYC | Off-chain, sybil-trivial, against the permissionless thesis. |

## 6. What is fundamental

Round-only eligibility + unbounded prize + fixed per-round odds cannot coexist (Thm 3). Any sybil-proof rule must make the round's hit mass proportional to what the round paid in, which makes the expected time between hits grow linearly with the prize. This is how Powerball, EuroMillions and every casino progressive behave, and it is legible to players: a bigger jackpot is rarer. The earlier wish for bounded cadence "without arbitrarily making each lottery harder" is met in the only non-arbitrary way: harder exactly in proportion to what it pays, never more. If a frequent-win feel is wanted in addition, the correct instrument is a second, small, capped pool with flat odds (a "daily ball"), funded from a separate rake slice, whose cap sits below the F-1 break-even (`W_cap/N < min rake`, i.e. ≤ 3,600 credits at current parameters). This is optional and not required for the fix.

## 7. Owner decisions (taken 2026-09-05)

1. **Adopted.** Actuarial house cap `κ_h = 0.5` (`houseRakeCapBps = 5000`): the house returns up to half the round's rake as risk bonus.
2. **Adopted.** Actuarial hit rule `κ = 2` (`kappaBps = 20000`, `contributionBps = 2600`, flat ceiling `oddsOneIn = 16`): the pool keeps at least half of every contribution in expectation.
3. **Rejected in favour of removal.** No forced hit of any kind; `mustHitByRounds` deleted from the contract, the fixtures and the deploy scripts.
4. Optional "daily ball" pool: not built; noted for a future decision.

## 8. Reproduction

    node scripts/research/gametheory-f1-f2.mjs

Output reproduces: `+2,044` (A-9b), best response `ω = 0.6, m_B ≈ 4.37×`, threshold 4.86 % / 2.61 %, F-1 break-even `P = 4,015`, `W(90,000) = 76,235`, forcing cost, and the two post-fix maxima `−166.1` and `−195.8`.

## 9. Sources

- Parimutuel and progressive-jackpot pricing: Thaler & Ziemba, "Anomalies: Parimutuel Betting Markets", J. Econ. Perspectives 2(2), 1988; Cook & Clotfelter, "The Peculiar Scale Economies of Lotto", AER 83(3), 1993 (jackpot size drives demand; rollover design).
- Actuarial premium principles: Bühlmann, *Mathematical Methods in Risk Theory*, 1970 (expected-value principle with loading `κ`).
- Sybil-proofness of allocation rules: Conitzer, Immorlica, Letchford, Munagala, Wagman, "False-name-proofness in social networks", WINE 2010; Alon, Fischer, Procaccia, Tennenholtz, "Sum of us: strategyproof selection from the selectors", TARK 2011 (additivity in contribution as the standard sufficient condition, used in Thm 4).
- Submartingale drift: Williams, *Probability with Martingales*, 1991, ch. 10.

## 10. Implementation (2026-09-05, same day)

| Piece | Change |
|---|---|
| `contracts/lib/PlankCcs2LMath.sol` | RULE_VERSION 1 → 2. `Params.houseRakeCapBps`; `settle(..., reserveAtLock, rakeWei, params)`; `_houseLayer` takes `hAvail = min(seed, reserveCap, rakeWei·houseRakeCapBps/BPS)`. `paramsHash` now commits 5 fields. |
| `contracts/PlankCrash.sol` | `Config.houseRakeCapBps` (immutable, `< BPS` enforced); keeper bounty computed before settlement so **net rake** is the base of both caps; `recordRound(id, seed, winner, netRake)`; `_preview` mirrors. |
| `contracts/PlankLottery.sol` | `Config`: `contributionBps`, `kappaBps` (`> BPS` enforced) replace `mustHitByRounds`. `hitThreshold(rakeWei, prize) = min(PROB_ONE/oddsOneIn, c·PROB_ONE·BPS/(kappaBps·W))`, `PROB_ONE = 1e18`; hit iff `keccak(BALL_DOMAIN, seed) % PROB_ONE < threshold`. `Draw` event carries `threshold` and `hit`; no `forced`, no counters, no `roundsUntilForcedHit`. |
| `lib/casino/economics-ccs2l.ts`, `settlement-rules.ts`, `simulation.ts`, `docs/.../engine.mjs` | Mirrors: `houseRakeCapBps` param, optional `rakeWei` (explicit in every chain-parity path; omitted only to replay v1 records/campaigns), registry version 2, `CommittedCcs2LRound.inputs.rakeWei`. |
| Fixtures / deploy | `houseRakeCapBps 5000`, `contributionBps 2600` (= router 40 % × 65 %), `kappaBps 20000`, `oddsOneIn 16` on deploy (was 256 with a 1,536-round force). `CASINO_MUST_HIT_BY_ROUNDS` removed. |
| Tests | A-9b and A-10 **inverted** (negative controls now assert EV < 0 across pool/seed/split/target and across prize 1e12..1e24 wei); A-5/A-9 carry the rake cap; A-7 rejects `houseRakeCapBps ≥ BPS`, `kappaBps ≤ BPS`, `contributionBps ∉ (0, BPS]`; L-5 (forced hit) deleted; L-7 (rule mirror + identity + monotonicity), L-8 (Powerball law, no forced surface in ABI/event), L-9 (net-of-keeper rake) added; params-hash pins re-pinned to v2. |

Results: hardhat 190/190; market 1148/0 (33 skipped, unchanged); CCS-2L simulations 619,221 checks / 0 failures, scenarios 0 failures (new `v2-rake-cap-closes-farming`), partition 39,680 cases worst gain 0 wei.

Observed under the fixture (A-10, L-8): a 5,000-credit quiet round against a 90,000-credit prize draws at about 1 in 2,600 and its expected payout is below its 225-credit rake; a 3.5 ETH round against a 90 ETH prize draws at 1 in 3,079 versus the 1-in-16 ceiling.
