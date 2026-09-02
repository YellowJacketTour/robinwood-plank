# RESEARCH: Vision, Implemented Economics, and SOTA-Grounded Best Configuration — 2026-09-02

Author model: claude-fable-5. **Analysis only** — no code, contract, or existing document was
modified; this file is the sole artifact. Repo under review: `C:\tmp\robinwood-sync-fix2`
(live PlankCrash playtest, master@e10225e); CCS-2L evidence worktree:
`C:\Users\k1rby\projects\robinwood-plank-cos-crash`; dossier worktree:
`C:\Users\k1rby\projects\robinwood-plank-crash` (REVISED dossier carries a SUPERSEDED-IN-PART
banner and is respected as such; the CORRECTED dossier supersedes it via the Solidity-vs-Node
differential test, 3/3 passing).

Standing qualifications, applied throughout (per DESIGN-PLANKCRASH-CCS2L-INTEGRATION §9):
1. **"player RTP == 1 − rake" is an AGGREGATE identity, not an individual promise** — measured
   per-strategy total RTP spans early≈1.04 to greedy≈0.15.
2. **Partition-invariance and no-farm claims rest on finite adversarial search** (39,680 cases,
   worst gain 0 wei; 8M campaign rounds, 0 solvency failures) — strong evidence, not a universal
   proof over all inputs.

---

## PART 1 — The owner's vision, reconstructed from canonical documents

Sources: `SYNTHESIS-unified-vision-and-invention-program-2026-08-29.md` (robinwood-plank
worktree), `docs/CASINO-ARCHITECTURE.md`, `docs/AUDIT-plankcrash-2026-09-02.md`,
`DESIGN-PLANKCRASH-CCS2L-INTEGRATION-2026-08-31.md`, DOSSIER-PLANKCRASH-CONSTANTS-CORRECTED.

**The product**: a **Collection Operating System** — launchpad → auto-vault liquidity →
market → casino/arcade → $PLANK index-AUM token, every pillar white-label ("launch on
plank.love and you get a marketplace, a vault, provably-fair games that fund your vault, and
index inclusion, out of one box"). Unified product, **casino-weighted cashflow** (SYNTHESIS §1).
RobinWood is the proof instance; the pipeline itself is the commercial product.

**Explicit stated principles** (each with its anchor):

| # | Principle | Anchor |
|---|---|---|
| V1 | **Displayed == redeemable honesty.** Never invent numbers; "`—` with a reason beats a fabricated number"; estimatedPayout shown, never stake×multiplier which the game never pays. The honesty contract is named as the brand. | SYNTHESIS §3; CASINO-ARCHITECTURE §4a |
| V2 | **Positive-sum framing, never positive-EV claims.** A rake from a closed pool is negative-sum per bet; the rake stays inside the community (burn + Powerboard + vault). Say it loudly. | CASINO-ARCHITECTURE §1, §4 |
| V3 | **Most-performative players should profit.** Payout weight grows with realized hazard survived (w=s·ln m); the seed splits by profit weight so a 1.0001x exit cannot farm house money. | CCS2L design §7; CASINO-ARCHITECTURE §0 HIGH-1 |
| V4 | **Monotonic protected principal / never-zero reserve.** The Vault is mathematically incapable of reaching zero (strict-fraction seed); protectedPrincipal only accretes; monotonic objectives are recommended ONLY where mathematically solvent ("prime directive", DOSSIER-RATIFICATION). | CASINO-ARCHITECTURE §9; simulation.ts:379 |
| V5 | **Guaranteed lottery reset base.** After a jackpot hit the next prize is pre-funded from a resetReserve and must be ≥ the grown cycleBase (`underfunded reset reserve` throws); mustHitByEpochs guarantees the pot can never roll forever. | simulation.ts:283; CASINO-ARCHITECTURE §10 |
| V6 | **Fail-closed security; immutable, ownerless money contracts.** No owner, no pause, no setters; fee ceilings in bytecode; oracle fail-closed; pull-payments; commit-before-value randomness. | SYNTHESIS §3; AUDIT-2026-09-02 invariants 1–11 |
| V7 | **Fixed, predictable reward timing as an ethical constraint.** The daily draw schedule is deliberately deterministic to avoid a second compulsive-uncertainty loop. "Do not change this into a surprise trigger." | CASINO-ARCHITECTURE §4 |
| V8 | **White-label commercial quality + full risk appetite on mechanisms, with description discipline** (EV-neutrality "true in the math, not just the copy"; securities language routed through counsel). | SYNTHESIS owner direction + §4 item 8 |
| V9 | **Low rake on purpose** — bankroll longevity drives lifetime plays ("the low-rake poker-room lesson. Don't creep it up."). | CASINO-ARCHITECTURE §5a |
| V10 | **No 'zero exploits' claims — proven invariants plus residual assumptions only.** | AUDIT-2026-09-02 preamble |

---

## PART 2 — Economics as implemented (formulas from code)

### 2.1 Crash law
`M(t) = e^(0.22·t)` (`lib/playtest-live-shared.ts:39,44`); crash point sampled by rejection
sampling to a uniform bucket, then `crashBps = 100_000_000 / (10_000 − bucket)`
(`lib/playtest-room-core.ts:148-165`) — the inverse-survival law **P(crash ≥ m) ≈ 1/m**, with a
genuine 10,000x tail and NO hidden RNG edge: "rake remains an explicit pool allocation rather
than hidden RNG edge." Duration to a target is `ln(m)/0.22` seconds. Under 1/m,
**E[fixed-odds payout at target m] = m·(1/m) = 1** — the pre-rake game is exactly fair at every
target, so all edge lives in the disclosed rake (PROVEN, one-line derivation).

### 2.2 Rake pipeline (live playtest defaults, `lib/playtest-room-core.ts:7-30`)
- `rakeBps 450` declining by `rakeStepBps 25` per `rakeVolumeStep 25,000,000` of qualified
  volume to `rakeFloorBps 250` (`evolutionQuote`, `lib/casino/simulation.ts:111-128`):
  `effectiveRake = 450 − min(floor(vol/25M)·25, 200)` bps.
- Split (`ratifiedRakeSplit`, `lib/casino/economics.ts:176-185`): keeper carve first, then of
  net rake **40% burn / 40% community / 20% founder**. (CASINO-ARCHITECTURE §5a's older table
  reads 40% dev / 40% jackpot / 20% burn for the contracts; the playtest/CCS-2L canon is
  40 burn / 40 community / 20 founder — a live doc/param divergence worth reconciling.)
- Community leg: `powerboardFundingBps` (playtest 10_000 = 100%) of community → lottery
  `pendingFunding`; remainder + vaultRemainder split `protectedPrincipalBps` (5_000) into the
  monotone `protectedPrincipal`, rest to `emissionBuffer`, capped at `emissionBufferCap`
  (1,000,000) with overflow cascading to the lottery (`simulation.ts:374-383`).
- True house edge ≪ headline rake: at 4.5% rake only the founder leg (0.9% of handle at the
  playtest split) permanently leaves the player/community economy.

### 2.3 Settlement rules
- **PFSS** (`economics.ts:82-163`): survivors first recover stake pro-rata
  (`basePool = min(distributable, survivorStake)`), surplus split by risk weight
  `s·(m−1)`. Design-doc default on the older branch; **this worktree's live playtest default is
  `allocationRule: "ccs-2l"`** (`playtest-room-core.ts:25`) — CCS-2L has been promoted to
  default here.
- **CCS-2L** (`economics-ccs2l.ts`): two purses.
  Player layer: `p_i = floorBps·s_i/BPS + premium·w_i/W`, `w_i = s_i·lnScaled(m_i)`,
  `floorBps = 7_500`; sum EXACTLY equals playerDistributable when any survivor exists (wei-exact
  conservation asserted at lines 233-235) ⇒ **player-layer RTP = 1 − effective rake, wei-exact,
  in aggregate**. House layer v1.1: `H_avail = min(H, reserveAtLock·houseCapBps/BPS)`
  (houseCapBps 1_000, GLOBAL), split by `s·ln m`, per-seat fair-odds cap `s·(m−1)`; every
  constraint positively homogeneous in stake ⇒ **partition-invariant** (39,680-case search,
  worst wallet-split gain 0 wei — finite search, not universal proof). Unused seed → protected
  reserve; all-bust rounds → reserve; treasury cap-residue structurally 0.
- `g(m) = ln m` is **exactly the cumulative hazard** of the 1/m law: hazard h(m) = 1/m,
  ∫₁^m dx/x = ln m (PROVEN). A changed crash law requires re-deriving g (CCS2L §9.2).

### 2.4 Powerboard / lottery
`nextCycleBase = base + max(base·lotteryBaseGrowthBps/BPS, lotteryMinimumBaseStep)` — playtest:
+max(5% of base, 50,000) per cycle (`simulation.ts:206-213`); prizes sealed only when
`rollover + pendingFunding ≥ minimumLotteryGross(target, founderFee 10%)`; on hit, the next
prize is constituted from the pre-funded `resetReserve` and MUST be ≥ the grown base
(`simulation.ts:283` throws otherwise) — the guaranteed reset base is enforced, not aspirational.
Miss: consolation (playtest 0), rollover, target = max(prior+minIncrease, progressive base).
On-chain analogue: reserveCap overflow cascade + `mustHitByEpochs` forced payout
(CASINO-ARCHITECTURE §10). Hit odds 1/16 per draw (`PLAYTEST_POWERBOARD_ODDS`).

### 2.5 Vault / seed / circuits (contracts + dossier)
Seed = strict fraction (`num < den` ⇒ reserve > 0 forever, PROVEN by integer argument), ∧
`seedMaxBps ≤ 1000` bytecode ceiling, ∧ income budget (cumulative seeds ≤ bootstrap
(≤ reserveCap/10) + Σ reserveCut ≈ rake·reserveShare), ∧ daily decaying-peak drawdown circuit ∧
high-water-mark circuit (seed=0 while play continues), ∧ optional `reserveFloorWei`. Winners are
paid from the round pool, never the Vault. Colluders can at best recover the rake they paid
(CASINO-ARCHITECTURE §0 NEW-1; finite adversarial tests, not universal proof).

### 2.6 Measured strategy-RTP spread (variant A, 2M-round campaigns)
early 1.041 · sniper 0.921 · mixed 0.895 · adversarial 0.771 · mid 0.653 (ruin 0.72) ·
greedy 0.147 (ruin ≈ 1.0). Aggregate RTP 0.97 at 3% test rake; identity wei-exact.

### 2.7 The impossibility triangle
Pick two of: (a) universal principal floor for every participant, (b) exact solvency
(Σ payouts ≤ Σ inflows every round), (c) top performers always profit. In a closed raked pool
all three cannot hold: a universal floor for busted seats is an unfunded liability unless
solvency is relaxed or performers' surplus is confiscated. The shipped design **keeps (b)+(c)
and relaxes (a)**: the `floorBps 7_500` floor applies only to SURVIVORS; busted stakes are lost
(their pot funds survivors/reserve). PFSS relaxes (c) slightly toward (a): its stake-first
basePool compresses the performance gradient among survivors. The Vault's never-zero and the
protectedPrincipal monotonicity are HOUSE-side floors, funded from rake income — solvent by
construction, and correctly not extended to player principal.

---

## PART 3 — Academic grounding (all URLs accessed 2026-09-02)

**PROVEN (theorem/derivation)**
- Fixed-odds crash EV: under P(crash≥m)=1/m, EV at any target m equals (1−edge)·stake,
  independent of m — derivation above; industry treatments agree
  (https://gamblingcalc.com/gambling-guides/crash-game-strategy/,
  https://crashgamesplay.com/games/bustabit-review/ — Bustabit ~1% edge, 99% RTP). The
  parimutuel contrast: here payouts depend on the FIELD, not only on m; only the aggregate
  identity RTP = 1 − rake survives.
- g(m)=ln m as cumulative hazard of the 1/m law (§2.3).
- CCS-2L conservation identities (bigint equalities asserted per settlement) and Vault
  never-zero (integer-division argument).
- Kelly criterion (Kelly 1956, Bell Syst. Tech. J. 35:917; fractional Kelly per Thorp, "The
  Kelly Criterion in Blackjack, Sports Betting, and the Stock Market", 2006): growth-optimal
  fraction and the drawdown law — betting fraction c of Kelly gives P(halving bankroll) ≈
  drawdown exponent 2/c − 1; full-Kelly hits half-bankroll with prob 1/2. Implication: the
  HOUSE seed exposure per round should be a small fraction of reserve — the shipped
  `seedMaxBps ≤ 10%` ceiling and income budget are the fractional-Kelly analogue for the house
  side (the mapping to a precise Kelly fraction is JUDGMENT; the ruin mathematics is PROVEN).
- Moulin & Shenker, "Strategyproof sharing of submodular costs: budget balance versus
  efficiency", Economic Theory 18 (2001)
  (https://link.springer.com/article/10.1007/PL00004200): group-strategyproof budget-balanced
  sharing ⇔ cross-monotone methods; budget balance and efficiency are incompatible — the formal
  cousin of the triangle in §2.7. Yokoo, Sakurai, Matsubara, "Robust combinatorial auction
  protocol against false-name bids", Artificial Intelligence 130 (2001)
  (https://courses.cs.duke.edu/fall06/cps296.2/yokoo_geb.pdf): false-name-proofness requires
  allocations/prices additive-or-worse under identity splits — exactly the "positively
  homogeneous, identity-independent constraints" rule CCS-2L v1.1 adopts. The v1.0 per-wallet
  cap was a textbook false-name violation; its removal is the theoretically correct fix.
- Buyback-and-burn ≡ dividend under Modigliani-Miller (1961) frictionless conditions
  (Miller & Modigliani, "Dividend Policy, Growth, and the Valuation of Shares", J. Business 34);
  net deflation requires burn > emission (arithmetic; CASINO-ARCHITECTURE §4 already states it).

**PEER-REVIEWED EMPIRICAL**
- Lottery takeout/effective-price elasticity: Grote & Matheson, "The Economics of Lotteries: A
  Survey of the Literature" (2011)
  (https://hcapps.holycross.edu/hcs/RePEc/hcx/HC1109-Grote-Matheson_LiteratureReview.pdf):
  lotto price elasticities cluster near −1 (Gulley & Scott 1993: −1.15 to −1.20 for several US
  lotto games, i.e., takeouts near revenue-maximizing but slightly high; Mason et al. 1997,
  Sage: −1.92 Florida, above-optimum takeout;
  https://journals.sagepub.com/doi/10.1177/109114219702500502). Cook & Clotfelter (1993, AER
  83:634) — jackpot size (rollover) drives sales nonlinearly; effective price beats pot size in
  specifications; scale economies favor big guaranteed jackpots
  (https://www.nber.org/system/files/working_papers/w28975/w28975.pdf;
  https://giovannicompiani.com/documents/Lotteries.pdf — Compiani, Magnolfi, Sullivan
  equilibrium rollover model confirms demand responds to jackpot/EV).
- Casino handle elasticity: Landers, "Estimates of the Price Elasticity of Demand for Casino
  Gaming" and Thalheimer & Ali, "The demand for casino gaming"
  (https://www.researchgate.net/publication/4805774; https://www.researchgate.net/publication/227605936):
  short-run handle inelastic in win-percentage, long-run ≈ unit-elastic or somewhat inelastic —
  so revenue = edge×handle is roughly flat-to-increasing in edge over observed ranges in the
  SHORT run, but competitive discipline binds long-run in transparent markets.
- Prospect theory / skew: Tversky & Kahneman (1992, JRU 5:297) probability weighting;
  Barberis, "A Model of Casino Gambling" (Management Science 58(1), 2012;
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1401792): CPT agents gamble at negative
  EV when the venue lets them manufacture POSITIVE SKEW via exit strategies; gain-exit
  (ride winners, quit losers) is the planned strategy. He, Hu, Obłój, Zhou (Management Science
  2023, https://pubsonline.informs.org/doi/10.1287/mnsc.2022.4414) formalize optimal
  precommitted stopping. Design consequence: an honest RTP-by-strategy SHAPE that pays a modest
  many-small-wins floor plus a long right tail (jackpot) matches CPT preferences without lying.
- Pari-mutuel mechanism design: Lange & Economides, "A Parimutuel Market Microstructure for
  Contingent Claims" (European Financial Management 11, 2005;
  https://www.researchgate.net/publication/322618426); Peters, So & Ye, "A Convex Parimutuel
  Formulation for Contingent Claim Markets" (https://web.stanford.edu/~yyye/cpcam-ec.pdf) and
  "Pari-mutuel Markets: Mechanisms and Performance"
  (https://web.stanford.edu/~yyye/scpmfinal.pdf): self-funding call auctions with unique state
  prices via convex programs; Hanson's LMSR (Hanson 2003, J. Prediction Markets 1) is the
  continuous analogue with bounded subsidy b·ln(n). Relevance: PlankCrash's per-round pool with
  a bounded seed IS a subsidized parimutuel; the bounded-subsidy discipline (seed ≤ income
  budget) parallels LMSR's bounded worst-case loss. A full CPCAM-style call auction per round
  is not needed at current scale (JUDGMENT).

**INDUSTRY-EMPIRICAL**
- Crash competitors run ~1% (Bustabit, Stake) to 3–5% edge
  (https://crashgamesplay.com/games/bustabit-review/, https://betscope.bet/roobet/crash-game-odds/,
  https://tradeblock.com/crypto-gambling/casinos/crash-sites/). A 2.5% floor is mid-pack; the
  honest offset is that ~60–80% of Plank's rake recirculates to the community.
- GambleFi deposit growth and Rollbit precedent (SYNTHESIS §1).

---

## PART 4 — Best configuration (optimize WITHIN the vision)

| Parameter | Current (live playtest) | Recommended | Evidence class | Rationale / source |
|---|---|---|---|---|
| Rake start | 450 bps | **KEEP 450** | INDUSTRY-EMPIRICAL + PEER-REVIEWED | Mid-pack vs 1–5% field; short-run handle inelastic (Landers) so no revenue loss; 60–80% recirculates, so effective leakage ≈ founder leg only. |
| Rake floor | 250 bps | **KEEP 250; do not go below 200** | PEER-REVIEWED EMPIRICAL + JUDGMENT | Lotto elasticities ≈ −1 imply takeouts near-optimum-slightly-high; casino handle unit-elastic long-run ⇒ revenue roughly flat in edge near 2–3%; below ~2% the keeper bounties + burn + lottery legs get squeezed (arithmetic). V9 forbids creeping UP. |
| Decline schedule | −25 bps / 25M qualified volume | **KEEP shape; ratify the volume unit against real handle** so the floor is reachable in ~months, not decades | JUDGMENT | Volume-milestone decline is a public, sybil-neutral commitment (rake paid is the qualifying cost — the sybil brief's law); step size immaterial vs reachability. |
| Split | 40% burn / 40% community / 20% founder | **KEEP 40/40/20, but RECONCILE the doc divergence** (CASINO-ARCHITECTURE §5a says 40 dev/40 jackpot/20 burn) — one canon, one code path | PEER-REVIEWED EMPIRICAL (community share) + JUDGMENT (burn vs founder) | Cook-Clotfelter/Compiani: jackpot size drives handle nonlinearly ⇒ a large community→lottery share is handle-positive, so 40% community is defensible and possibly the single highest-leverage leg. Burn ≡ dividend (MM) only if net-deflationary — verify emission schedule before advertising deflation (V1). 20% founder is the only true leakage; keep it the smallest leg. |
| powerboardFundingBps | 10_000 (100% of community leg → lottery, playtest) | **REDUCE to ~6_000–7_000 on mainnet** so 30–40% of the community leg builds protectedPrincipal/emissionBuffer continuously; playtest 100% is fine as a lab hypothesis | JUDGMENT (constrained by V4/V5) | The reset-reserve guarantee (V5) needs a funded emission buffer between hits; 100% routing starves the vault-side floor that V4 promises. |
| Settlement rule | **ccs-2l is already the live playtest default** (playtest-room-core.ts:25; the 08-31 design doc's "pfss remains default" is superseded on this worktree) | **YES — keep/confirm CCS-2L**, conditions: (i) private-canary §8 criteria stay green ≥200 rounds, (ii) params ratified, (iii) any on-chain port completes the §4 commitment-time rule-hash and a real audit (CCS2L §9.2 says NOT audit-complete) | PROVEN identities + finite search | Player-layer RTP=1−rake wei-exact (V1's displayed==redeemable, mechanized); partition-invariant house cap is the false-name-proof fix (Yokoo); PFSS's stake-first base compresses the performance gradient V3 demands and leaves a treasury cap-residue channel CCS-2L structurally zeroes. |
| f (survivor floorBps) | 7_500 | **KEEP 7_500; acceptable band 6_000–8_000** | PEER-REVIEWED EMPIRICAL (shape) + JUDGMENT (level) | CPT loss-aversion (λ≈2.25, TK 1992) makes sub-stake returns feel ~2.25× their size; a 75% floor converts "survived but lost anyway" into a small, tolerable loss while leaving 25%+premium as the performance gradient (V3). f→10_000 would flatten the gradient (violates V3); f≤5_000 makes surviving feel like busting (retention cost, Barberis). No theorem picks the point — label JUDGMENT. |
| House weight g(m) | ln m | **KEEP — exact cumulative hazard** of the 1/m law; re-derive if the law ever changes | PROVEN | ∫₁^m (1/x)dx = ln m: bonus proportional to hazard actually survived, per unit stake. |
| houseCapBps (global) | 1_000 (10% of reserveAtLock) | **KEEP 1_000; never per-wallet** | PROVEN (partition argument) + JUDGMENT (level) | Global + positively-homogeneous is the only split-proof form; 10% of reserve per round is well inside fractional-Kelly-style ruin bounds given the income budget backstop. |
| seedMaxBps | ≤1000 bytecode ceiling | **KEEP; deploy at ≤500** | PROVEN (never-zero) + JUDGMENT (level) | Kelly drawdown math: smaller per-round house fraction ⇒ exponentially smaller drawdown probability; the income budget already dominates below implied volume. |
| Seed income budget | seeds ≤ bootstrap(≤reserveCap/10) + Σ reserveCut | **KEEP — structural anti-collusion bound** | PROVEN (accounting identity) + finite adversarial tests | Colluders recover at most their own retained rake (NEW-1 closure). |
| Drawdown circuits | daily decaying-peak + HWM, seed→0 | **KEEP both** | PROVEN mechanics + INDUSTRY-EMPIRICAL motivation | WINR-style scaling caps; most on-chain casino failures trace to non-scaling max exposure (SYNTHESIS §4 item 12b). |
| Lottery base growth | +max(5%, 50k) per cycle, enforced-funded reset | **KEEP the monotone guaranteed base; consider consolation > 0** (small, e.g. ~5% of prize on miss) on mainnet | PEER-REVIEWED EMPIRICAL | Cook-Clotfelter/rollover models: guaranteed, growing headline jackpots drive handle; the "must be won" cap kills the unbounded-wait tail (V5, V7). Consolation gives every draw a visible winner (CPT small-win frequency) without touching the guarantee. Playtest consolation=0 understates retention. |
| Lottery founder fee | 1_000 bps (10%) on gross incl. rollover | **REDUCE to ≤500 bps and charge on FRESH funding only, not rollover** | JUDGMENT (constrained by V1/V2) | Fee-on-rollover taxes the same wei each miss — compounding leakage that quietly erodes "displayed==redeemable" growth of the pot; state totals already track `lotteryFounderFeesOnRollover`, evidence the design anticipates the concern. |
| Max multiplier | 10,000x tail (playtest law); `maxMultiplierBps` owner-set on-chain | **Cap at 1,000x–10,000x such that worst single fixed-odds cap s·(m−1) stays ≪ houseCap·reserve**; publish the cap (V1) | JUDGMENT | Fair-odds caps already bound house exposure linearly; the ceiling is a UX/solvency belt, not an edge source — the 1/m law prices any tail fairly. |
| Vault/protectedPrincipal monotonicity | monotone accrual, 50% of community-return | **KEEP as a chosen constraint** — a house-side floor funded from income is solvent; never extend it to player principal | PROVEN solvency + owner constraint | Extending a principal floor to busted players is the triangle's unfunded corner (§2.7; Moulin-Shenker BB-vs-efficiency analogue). |
| Draw timing | fixed daily schedule, public forced-hit epoch | **KEEP fixed (V7)** — reject variable-ratio surprise triggers even though they'd raise engagement | PEER-REVIEWED EMPIRICAL (rejected on ethics) | Unpredictable reward timing is the strongest compulsion driver; the vision rightly forbids it. |

**Is 40% of rake to the lottery right?** Yes, directionally: rollover-lottery evidence says the
jackpot headline is the demand engine and elasticities near −1 mean recirculating takeout into
prizes is close to revenue-neutral for the operator while maximizing handle — 40% community is
the best-supported leg of the split (PEER-REVIEWED EMPIRICAL for direction; the exact 40 is
JUDGMENT).

**Is the 2.50% floor near revenue-maximizing?** Within the evidence band: crash competitors at
1–4%, casino handle ≈ unit-elastic long-run, lotto takeouts slightly above optimum at ~50% —
2.5% effective takeout with 60–80% recirculation is comfortably on the low-price/high-handle
side that both the elasticity evidence and V9 favor. Going below ~2% starves the keeper/burn/
lottery legs (arithmetic), going up violates V9 for at best flat revenue (long-run unit
elasticity).

**Unconstrained optimum the vision rightly rejects**: variable-ratio jackpot timing, opaque
RNG-embedded edge, teaser "stake×multiplier" displays, per-wallet bonus caps (higher apparent
generosity, sybil-broken), fee-on-rollover compounding, and universal principal floors funded
by dilution — each would raise short-run engagement or margin and each violates V1/V3/V6/V7 or
solvency.

## Top 5 changes by expected impact
1. **Confirm CCS-2L as the ratified rule** (it is already this worktree's playtest default) and
   complete the §8 canary + on-chain commitment-hash + audit path before any real value.
2. **Reconcile the split canon** — CASINO-ARCHITECTURE §5a (40 dev/40 jackpot/20 burn) vs
   ratifiedRakeSplit (40 burn/40 community/20 founder): one documented truth (V1 violation risk
   as-is).
3. **Cut the lottery founder fee to ≤5% and exempt rollover** — removes compounding leakage
   from the flagship jackpot.
4. **Set powerboardFundingBps ≈ 6_500 on mainnet** so the V4/V5 reserves are continuously
   funded, not only via emission-buffer overflow.
5. **Turn on a small consolation prize** (visible winner every draw) — CPT-aligned retention at
   zero honesty cost.

## PROVEN vs JUDGMENT (explicit)
PROVEN: 1/m fixed-odds EV independence; g=ln m as cumulative hazard; CCS-2L conservation
identities; vault never-zero; seed income-budget accounting bound; Kelly drawdown mathematics;
Moulin-Shenker BB/efficiency incompatibility; false-name-proofness ⇒ homogeneous constraints;
MM buyback≡dividend (frictionless). FINITE-SEARCH EVIDENCE (not proof): partition-invariance
0-wei worst gain; 8M-round solvency; collusion recovers ≤ own rake. PEER-REVIEWED EMPIRICAL:
lotto elasticity ≈ −1; rollover/jackpot demand; handle inelasticity; CPT weighting/λ≈2.25;
Barberis skew-manufacturing. JUDGMENT: exact rake floor 250; f=7_500; houseCapBps 1_000;
powerboardFundingBps target; founder-fee level; max-multiplier ceiling; volume-step sizing.

## Citations (accessed 2026-09-02)
- Grote & Matheson, Economics of Lotteries survey — https://hcapps.holycross.edu/hcs/RePEc/hcx/HC1109-Grote-Matheson_LiteratureReview.pdf
- Mason, Steagall, Fabritius (1997) lotto elasticity — https://journals.sagepub.com/doi/10.1177/109114219702500502
- Cook & Clotfelter jackpot-scale findings via NBER w28975 — https://www.nber.org/system/files/working_papers/w28975/w28975.pdf
- Compiani, Magnolfi, Sullivan, Equilibrium Model of Rollover Lotteries — https://giovannicompiani.com/documents/Lotteries.pdf
- Lange & Economides parimutuel microstructure — https://www.researchgate.net/publication/322618426
- Peters, So, Ye CPCAM — https://web.stanford.edu/~yyye/cpcam-ec.pdf ; performance — https://web.stanford.edu/~yyye/scpmfinal.pdf
- Barberis, A Model of Casino Gambling — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1401792
- He, Hu, Obłój, Zhou, CPT casino stopping — https://pubsonline.informs.org/doi/10.1287/mnsc.2022.4414
- Moulin & Shenker (2001) — https://link.springer.com/article/10.1007/PL00004200
- Yokoo, Sakurai, Matsubara false-name bids — https://courses.cs.duke.edu/fall06/cps296.2/yokoo_geb.pdf
- Casino handle elasticity (Landers; Thalheimer & Ali) — https://www.researchgate.net/publication/4805774 ; https://www.researchgate.net/publication/227605936
- Crash-game edge, industry — https://crashgamesplay.com/games/bustabit-review/ ; https://betscope.bet/roobet/crash-game-odds/ ; https://gamblingcalc.com/gambling-guides/crash-game-strategy/ ; https://tradeblock.com/crypto-gambling/casinos/crash-sites/
- Kelly (1956), Thorp (2006), Tversky & Kahneman (1992), Miller & Modigliani (1961), Hanson LMSR (2003) — canonical print sources, cited from the literature.
