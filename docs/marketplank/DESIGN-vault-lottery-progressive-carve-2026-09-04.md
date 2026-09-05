# DESIGN — The authentic vault role, the progressive carve x(P), and round-only eligibility

> **SUPERSEDED IN PART — 2026-09-05.** Two parts of this design were replaced by
> `RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md` after the F-1/F-2 audit findings:
> (1) the flat per-round hit probability `1/E[R]` is replaced by the actuarial rule
> `p = min(1/oddsOneIn, c_round/(κ·W(P)))`, so the "equilibrium prize `P*`" analysis (Part 4) becomes a
> **drift** analysis: `P` grows in expectation by `c(1 − 1/κ)` every round with no equilibrium and no cap;
> (2) every must-hit-by mechanism (Part 5, D4) is **removed by owner ruling** — the site runs a pure
> progressive lottery. The carve `x(P)`, round-only eligibility, prize snapshot, founder-fee-on-inflow and
> the vault floor are unchanged and remain canonical.

**Date:** 2026-09-04 · **Status:** design + research, analysis only. No code, config or
economics changed by this document.
**Builds on:** `docs/marketplank/RESEARCH-vault-and-lottery-design-2026-09-04.md` (the prior
report). This document does **not** repeat it. Where it **supersedes** the prior report, that is
stated explicitly and loudly.

**Authorities read:** `PRODUCT.md`; `docs/CASINO-ARCHITECTURE.md` §5a, §9, §10;
`lib/casino/economics.ts`; `lib/casino/simulation.ts`; `lib/playtest-room-core.ts`;
`lib/playtest-rooms.ts`.

---

## 0. What the owner's three directives change

The owner has issued three directives that **supersede the prior report's central
recommendation** ("cap the base") and my own earlier position. Stated plainly, so that nothing
is smuggled:

| # | Directive | What it overrides |
|---|---|---|
| 1 | *"the authentic real economic logic which satisfies our vault and lottery intentions"* | The unresolved PRODUCT.md ↔ §9 contradiction |
| 2 | A **progressive** carve x(P), rising with P, such that **both** winner-take and next seed grow with P | The prior report's **constant** x = 20% |
| 3 | The base **may grow forever** (no cap); **only players in the winning ROUND are eligible** | The prior report's `lotteryMaxBase` cap, and `playtest-rooms.ts:677` epoch-accumulating tickets |

**The headline result of this document:** directives 2 and 3 are not two separate changes. They
are one change, and **directive 3 is what makes directive 2 work.** Round-only eligibility with
a per-round draw makes the prize base **endogenous**, and an endogenous base under a saturating
carve **converges to a finite fixed point set entirely by volume** — which delivers exactly what
the owner asked for: *it can grow forever* (no cap is ever written anywhere) *and* cadence stays
bounded. The prior report's conclusion that "the carve alone does not solve the unbounded
problem" was **correct for the epoch model it analysed and is superseded here**, because that
analysis held the base's growth law exogenous. Section 5 proves both statements and reconciles
them.

---

## PART 1 — DIRECTIVE 1: the vault's one authentic role

### 1.1 The contradiction, stated exactly

| Source | Claim |
|---|---|
| `PRODUCT.md`, Terminology | *"**Vault (protected principal)** — a reserve that only grows, funded from routed rake."* |
| `PRODUCT.md`, Product Purpose | *"rake funds a community lottery whose prize can only grow"* |
| `CASINO-ARCHITECTURE.md` §9 | *"It is not a subsidy engine and it is **not a progressive pot that grows without limit**; it is **a rake rebate with a bankroll behind it**."* |
| `CASINO-ARCHITECTURE.md` §9 | *"The earlier `R* = c·P/α`, always-compounding, un-emptyable progressive pot description was the pre-hardening formula and is **withdrawn**: the pot does not compound off a release fraction, **it recycles income**."* |

These cannot both be true of the same object. "Only grows" and "recycles income" are opposite
claims about the same balance.

### 1.2 What the CODE actually implements today

The contradiction resolves the moment you read the code, because **the code implements two
different objects and the docs use one word for both.**

**Object A — `protectedPrincipal` (monotone, never spent).**

- `lib/casino/simulation.ts:385-386` — credited each qualified round:
  ```
  const principal = (communityReturn * policy.protectedPrincipalBps) / BPS;
  state.protectedPrincipal += principal;
  ```
- `lib/casino/simulation.ts:422` — enforced monotone by invariant:
  ```
  if (state.protectedPrincipal < prior.protectedPrincipal) throw new Error("principal decreased");
  ```
- **There is no debit path anywhere.** `protectedPrincipal` is credited in exactly one place and
  decremented in none.
- `lib/playtest-room-core.ts:15` — `protectedPrincipalBps: 5_000n` (50% of the retained
  community leg).

**Object B — `emissionBuffer` (the working bankroll that actually seeds flights).**

- `lib/casino/simulation.ts:329-330` — the seed is drawn from the **buffer**, never the principal:
  ```
  seed = state.emissionBuffer < policy.crashSeed ? state.emissionBuffer : policy.crashSeed;
  state.emissionBuffer -= seed;
  ```
- `lib/casino/simulation.ts:356` — house-side returns flow back into the buffer:
  `state.emissionBuffer += reserveReturn;`
- `lib/casino/simulation.ts:387` — credited with the non-principal half of the community return.
- `lib/casino/simulation.ts:388-390` — **overflow above the cap cascades to the lottery**:
  ```
  if (state.emissionBuffer > policy.emissionBufferCap) {
    state.lottery.pendingFunding += state.emissionBuffer - policy.emissionBufferCap;
    state.emissionBuffer = policy.emissionBufferCap;
  }
  ```
- `lib/playtest-room-core.ts:23` — `emissionBufferCap: 1_000_000n`.

**Seed funding path, end to end:** rake → `ratifiedRakeSplit` (`economics.ts:181-183`, 40/40/20)
→ community leg → `powerboardFundingBps` 65% to the lottery (`simulation.ts:383`) → the retained
35% splits 50/50 → `protectedPrincipal` (dead) / `emissionBuffer` (live) → buffer seeds the next
flight at `crashSeed = 10_000` → buffer overflow above 1,000,000 cascades to the lottery.

### 1.3 Where code and stated intent diverge — the finding

> **`protectedPrincipal` is, today, economically inert. It is credited forever, spent never, and
> backs no obligation. It does no economic work. It is a display trophy — precisely the thing
> directive 1 says the vault must not be.**

This is the honest answer to directive 1. The number the UI labels "Heartwood Vault / Protected
principal" (`components/playtest/GameLaboratory.tsx:276`) is a monotone counter. `PRODUCT.md`'s
*"a reserve that only grows"* is a **literally accurate description of the code** — and that is
exactly the problem. §9's *"a rake rebate with a bankroll behind it... it recycles income"* is
an accurate description of **`emissionBuffer`**, a different variable. **Neither document is
lying; they are describing two different objects under one name.**

Three specific divergences:

1. **`PRODUCT.md` "reserve that only grows" describes `protectedPrincipal`; §9 "recycles income"
   describes `emissionBuffer`.** One word, two objects.
2. **§9 describes the on-chain `PlankCrashDrand` reserve** (with `seedNumerator/seedDenominator`,
   `seedBudget`, `reserveCap`, `reserveFloorWei`) — **none of which exist in `lib/`.** The live
   engine's vault is the two-variable structure above, not the contract's. §9 is a spec for a
   different implementation.
3. **§9 promises a cascade `reserveCap → jackpotSink`; `lib/` implements
   `emissionBufferCap → lottery.pendingFunding`.** These agree in spirit — and this is the one
   place the live code already does authentic vault work.

### 1.4 The ONE role — decided, not hedged

Of the four candidate roles the brief lists, I evaluate and reject three:

| Candidate | Verdict | Reason |
|---|---|---|
| Underwriter of the lottery's guaranteed reset | **Reject** | Directives 2+3 make the *carve* fund the reset from banked prize money. An underwriter would be a second, redundant guarantee — and it would reintroduce the reset-reserve gate the carve exists to delete. |
| Rake rebate that recycles to players | **Reject as the primary role** | True but not distinguishing: it describes *where the money goes*, not *what the balance is for*. Every leg of the rake is a rebate under this definition. It is a consequence, not a role. |
| Solvency floor / bankroll backing the parimutuel house layer | **Adopt — this is the role** | It is the only candidate that (a) the code already partially implements, (b) is *load-bearing* — remove it and the ccs-2l house layer cannot pay, and (c) does real work every single round. |
| Buffer that smooths seed funding across rounds | **Adopt as the mechanism of the above** | This is *how* the solvency floor does its work, not a separate role. |

> ### THE VAULT'S ONE ROLE
>
> **The Vault is the solvency floor of the house layer: the bankroll that guarantees every
> flight can be seeded and every house-side (ccs-2l) obligation can be paid, funded only by
> rake it has itself taken in, and whose surplus above its solvency requirement is released to
> the players via the Powerboard.**

It is **not** a prize, **not** a progressive pot, and **not** a trophy. It is a **bankroll**, and
the honest player-facing sentence is: *"the Vault is what lets the game seed every round and pay
every winner; when it holds more than it needs to do that, the excess becomes prize money."*

This adopts §9's substance and **retires `PRODUCT.md`'s "a reserve that only grows"** as a
description of the vault. (Note carefully: `PRODUCT.md`'s *other* "only grows" claim — *"a
community lottery whose prize can only grow"* — is about the **prize**, is protected by
constraint C3, and is **untouched** by this. See §6.3.)

### 1.5 The invariant that expresses it

> **`emissionBuffer ≥ solvencyFloor` at all times, where `solvencyFloor` is the reserve
> sufficient to seed and settle the house layer at the current table's exposure; every credit
> above it is released to the Powerboard; and the Vault's cumulative outflow never exceeds its
> cumulative rake inflow plus its one-off bootstrap.**

Formally, with `V` the vault balance, `I` cumulative rake inflow, `O` cumulative outflow,
`B` the bootstrap:

```
(V1)  V ≥ F                     solvency floor never breached
(V2)  O ≤ I + B                 never a subsidy; recycles income only
(V3)  V > F  ⟹  V − F spills to lottery.pendingFunding      surplus is released, not hoarded
```

### 1.6 What must change in principle (NOT code — analysis only)

1. **Retire `protectedPrincipal` as a separate monotone balance, or give it a debit path.**
   It must either (a) *become* the solvency floor `F` — i.e. the buffer may never be drawn below
   it, which makes it load-bearing while keeping it monotone and never *spent* — or (b) be
   deleted and its inflow redirected. **Option (a) is strongly preferred**: it preserves the
   monotone invariant at `simulation.ts:422`, preserves the existing UI number, preserves
   `protectedPrincipalBps`, and converts a trophy into the floor of a real solvency constraint
   **with no change to any economic parameter**. This is the smallest possible change that makes
   directive 1 true.
2. **Rename in the docs, not in the code.** `PRODUCT.md`'s Terminology entry must describe the
   *bankroll*, and must stop saying "a reserve that only grows" of the Vault.
3. **`emissionBufferCap` is then the solvency ceiling**, and the existing cascade at
   `simulation.ts:388-390` becomes the (V3) surplus release — already implemented, already
   correct, and now *justified*.

Under (a) the vault does real work every round: it is drawn from (`:329`), returned to (`:356`),
floored (`protectedPrincipal`), capped (`:388`), and its surplus funds the prize. That is
authentic.

---

## PART 2 — DIRECTIVE 2: the progressive carve x(P)

### 2.1 Setup and notation

At the instant of a hit, let

- `P` = the sealed prize (net of the founder fee), banked and conserved;
- `x(P) ∈ [0,1)` = the fraction **retained** as the next base's opening seed;
- `W(P) = P·(1 − x(P))` = **what the winner receives**;
- `S(P) = P·x(P)` = **what seeds the next board**.

Conservation is exact and instantaneous: `W(P) + S(P) = P`. Nothing is created; **there is no
unbacked liability at any instant** (this property is inherited unchanged from the prior report
§5(h) and is the reason the carve is admissible at all).

The owner requires **both** `W` and `S` strictly increasing in `P`.

### 2.2 The admissible-family condition — derivation

Assume `x` differentiable on `(0, ∞)`.

**Seed increasing:**
```
S(P) = P·x(P)
S'(P) = x(P) + P·x'(P) > 0
        ⟺  x'(P) > −x(P)/P                                            … (S)
```

**Winner-take increasing:**
```
W(P) = P·(1 − x(P))
W'(P) = (1 − x(P)) − P·x'(P) > 0
        ⟺  x'(P) < (1 − x(P))/P                                       … (W)
```

Combining, the **admissible family** is exactly:

> ### THE ADMISSIBLE-FAMILY CONDITION
> ```
> −x(P)/P  <  x'(P)  <  (1 − x(P))/P        for all P > 0,   with 0 ≤ x(P) < 1
> ```
> equivalently, in elasticity form with `ε(P) := P·x'(P)/x(P)` the elasticity of the carve rate:
> ```
> −1  <  ε(P)  <  (1 − x(P))/x(P)
> ```

**Reading it.** The **left** inequality is nearly free: it is violated only if `x` *falls* faster
than `1/P`, i.e. faster than the prize grows. Any non-decreasing `x` satisfies it automatically.
**The right inequality is the binding one**, and it is the one the owner's instinct is in tension
with: *x may rise with P, but not too fast.* If `x` rises faster than `(1−x)/P`, the carve eats
the winner's increase and `W` starts falling — the prize gets bigger and the winner gets less,
which is exactly the outcome the owner forbids.

**Two immediate corollaries.**

- **Corollary 1 (bounded x is sufficient).** If `x` is non-decreasing and bounded above by
  `x_max < 1`, then (S) holds automatically, and (W) holds iff `x'(P) < (1−x(P))/P`. Any
  **saturating** `x` — one whose derivative decays at least as fast as `1/P` — satisfies both
  for all `P`. This is the practical design rule.
- **Corollary 2 (the asymptote).** If `x(P) → x_max < 1` then `W(P) ~ P(1−x_max)` and
  `S(P) ~ P·x_max`: **both grow linearly in P, in fixed proportion.** The owner's requirement is
  satisfied *in the limit* by construction, and the whole design question is only about the
  *shape of the approach*.

### 2.3 Candidate functional forms evaluated

Throughout, `P₀` is a reference prize scale and `x₀ = x(P₀)`.

#### (a) Constant — `x(P) = x₀` (the prior report's recommendation, x₀ = 0.20)

- `x' = 0`, so both (S) and (W) hold strictly (`0 > −x₀/P` and `0 < (1−x₀)/P`). **Admissible.**
- `W = 0.8P`, `S = 0.2P`: both linear, both increasing. **It already satisfies the owner's
  literal requirement.**
- **Cadence:** fresh needed `∝ P`; linear in P.
- **Legibility: best in class.** "You get 80%, 20% seeds the next board" — one number, forever.
- **Verdict: the baseline, and it is not a bad one.** But it is *not progressive*: the carve rate
  does not respond to state, so a 10,000-credit prize and a 10,000,000-credit prize are treated
  identically. It gives away the most at small prizes (where the seed matters most for cadence)
  and the least at large ones (where the winner can most afford to share).

#### (b) Linear ramp with ceiling — `x(P) = min(x₀ + k(P − P₀), x_max)`

- On the ramp, `x' = k`. (W) requires `k < (1 − x)/P` — **this fails for large P at any fixed
  k > 0**, so the ceiling is not optional, it is *required for admissibility*. Below the ceiling
  the design is only admissible on a bounded interval.
- Above the ceiling it degenerates to case (a).
- **Cadence:** fine, but the kink at the ceiling is arbitrary.
- **Legibility:** poor. A player cannot predict their share without doing arithmetic, and the
  share changes discontinuously in slope.
- **Verdict: reject.** It is admissible only by being capped, and the cap is precisely the thing
  the owner rejected in directive 3. A form that *needs* a cap to be well-posed is the wrong
  form here.

#### (c) Logarithmic — `x(P) = a + b·ln(P/P₀)`

- `x'(P) = b/P`. (S): `b/P > −x/P ⟺ b > −x`. (W): `b/P < (1−x)/P ⟺ **b < 1 − x(P)**`.
- Since `x → ∞` as `P → ∞` for any `b > 0`, `x` eventually exceeds 1 — **inadmissible without
  clamping**, and once clamped it is case (a) again.
- **However:** on the *operating range* it is well-behaved and `b < 1 − x_max` is easy to satisfy.
- **Legibility:** poor. Logarithms are not player-legible.
- **Verdict: reject.** Unbounded in a design whose whole premise (directive 3a) is "no caps".

#### (d) Saturating / Michaelis–Menten — `x(P) = x_max·P/(P + c)`

- `x'(P) = x_max·c/(P+c)²  > 0`, so (S) holds strictly. ✅
- (W): need `x_max·c/(P+c)² < (1 − x_max·P/(P+c))/P`. Substituting and simplifying:
  ```
  x_max·c·P/(P+c)²  <  (P + c − x_max·P)/(P+c)
  ⟺ x_max·c·P      <  (P+c)(P + c − x_max·P)
  ⟺ 0              <  P² + 2cP + c² − x_max·P² − 2·x_max·c·P
  ⟺ 0              <  (1 − x_max)P² + 2c(1 − x_max)P + c²
  ```
  Every term is **positive for `x_max < 1`, `c > 0`, `P > 0`.** ✅
- > **RESULT: the saturating form satisfies BOTH monotonicity conditions for ALL P > 0,
  > unconditionally, for any `x_max < 1` and `c > 0`. No ceiling, no clamp, no special-casing.**
  This is the unique candidate here that is admissible *by construction on the whole domain*,
  which is precisely what directive 3(a)'s "grow forever" demands.
- **Cadence:** `x → x_max`, so asymptotically `S ~ x_max·P` — the seed keeps pace with the base
  by construction (Corollary 2). Analysed fully in §3.
- **Legibility:** moderate. The formula is not legible, but **the displayed consequence is**:
  the board can always show the two numbers (§6.4). And it has an intuitive story: *"the bigger
  the pot gets, the more of it stays behind to start the next one — up to 30%."*
- **Verdict: ADOPT.**

#### (e) Tiered step function (real progressives' actual practice)

- `x` piecewise constant on prize bands. Within a band `x' = 0` → both conditions hold. **But at
  a band boundary `x` jumps up by `Δ`, and `W = P(1−x)` jumps DOWN by `P·Δ`.** So `W` is
  **not** increasing — it has downward discontinuities. **It violates the owner's requirement at
  every tier boundary**, and creates a perverse region where a *larger* pool pays the winner
  *less*.
- This is a real and serious defect, not a technicality: a player who watches the pool cross a
  boundary sees their prospective take fall.
- **Mitigation:** tiers can be made admissible by applying the rate **marginally** (tax-bracket
  style): `S(P) = Σ_bands x_i · (band width)`. Then `S` is continuous, piecewise linear and
  increasing, and `W = P − S` is increasing iff every marginal rate `x_i < 1`. ✅
- **Legibility: best in class.** This is why real progressives use it — a bracket table is the
  single most legible way to express a state-dependent rate, and every player already understands
  it from income tax.
- **Verdict: REJECT the naive form (violates the requirement); the MARGINAL form is admissible
  and is the recommended *display* of the recommended function.** See §6.4 — I recommend
  computing `x(P)` with (d) and *presenting* it as a small marginal bracket table.

#### Summary table

| form | `x(P)` | S↑ | W↑ | needs cap | cadence | legibility |
|---|---|---|---|---|---|---|
| (a) constant | `x₀` | ✅ | ✅ | no | linear in P | ★★★★★ |
| (b) linear ramp | `x₀+k(P−P₀)` | ✅ | ❌ unless capped | **yes** | ok | ★★ |
| (c) logarithmic | `a+b·ln(P/P₀)` | ✅ | ❌ unless clamped | **yes** | ok | ★ |
| **(d) saturating** | **`x_max·P/(P+c)`** | **✅ ∀P** | **✅ ∀P** | **no** | **§3** | ★★★ |
| (e) tiered (naive) | step | ✅ | ❌ at boundaries | no | ok | ★★★★★ |
| (e′) tiered (marginal) | bracket | ✅ | ✅ | no | ok | ★★★★★ |

### 2.4 Should x depend on TIME as well as P?

The owner said *"more X on more time/prize raised."* Two ways to honour "time":

- **Separable `x(P, t)`** with `t` = rounds since the last hit.
- **Folded into P**, since `P` grows monotonically with `t` between hits.

**Recommendation: fold time into P. Do NOT make x an explicit function of t.** Reasons:

1. **`P` is a sufficient statistic for `t` here.** Between hits the prize only ever increases,
   by a per-round inflow that is itself a fixed fraction of volume (`f` per round). So
   `P ≈ P_seed + f·t`, and `t` carries **no information about the state that `P` does not
   already carry** — except the table's volume, and volume is the thing we *want* the prize to
   track (Compiani et al.: optimal scale is a function of the player base — §4.3).
2. **`x(P,t)` breaks the monotonicity guarantee.** Both (S) and (W) are conditions on `dP`. Once
   `x` also moves in `t`, `W` can fall while the player watches — `dW = ∂W/∂P·dP + ∂W/∂t·dt`,
   and the second term is negative for a rising `x`. A player would see the pool grow and their
   prospective take shrink. **This is the same defect as the naive tiered form, and it is
   disqualifying.**
3. **It is not legible.** Two moving inputs cannot be shown honestly on a game board.
4. **A time-based mechanism already exists and is the right tool** — must-hit-by (Part 5).
   Time should govern *when the draw is forced*, not *how the prize is split*. Keeping these
   orthogonal is what makes both explainable.

> **Recommendation: `x` is a function of `P` alone. Time enters the design through the draw
> mechanism (must-hit-by), never through the split.**

### 2.5 Does a bigger winner-take pay for itself in volume?

This is the owner's implicit economic bet, and the honest answer is **partially, with a
documented ceiling**.

- **Supports it:** Cook & Clotfelter (1993) — per-capita lotto sales rise with the population
  base, because *players judge the likelihood of winning by the frequency with which someone
  wins*. **PEER-REVIEWED.** Compiani, Magnolfi & Smith (2024) — log sales grow **convexly** in
  log jackpot over the observed range. **PEER-REVIEWED (working paper).**
- **Bounds it:** Combs & Spry (2025) quantify **jackpot fatigue** — redesigns that raised the
  average jackpot *lowered* the elasticity of sales to jackpot size. **PEER-REVIEWED.** Operator
  evidence is starker: North Carolina same-day Mega Millions sales fell from **$10.1M at an
  $830M jackpot to $3.7M at an $820M jackpot** one year later — a ~63% handle collapse at the
  same advertised prize. **INDUSTRY-STANDARD.**
- **The synthesis, and it is the load-bearing judgement of this document:** the elasticity of
  participation is **higher with respect to observed win frequency than with respect to headline
  size**. Both cited mechanisms point the same way — Cook–Clotfelter's is *explicitly* a
  frequency mechanism, and jackpot fatigue is the decay of the size mechanism.
  **Therefore a design should spend its marginal credit on cadence before headline.**
  This is precisely what a rising `x(P)` does: it diverts a *growing* share into the seed exactly
  when the prize is large (where the marginal headline credit is worth least) and leaves the
  winner's share nearly whole when the prize is small (where cadence is already fast).
  **JUDGMENT**, but well-grounded in two peer-reviewed results pointing the same direction.

> **The progressive carve is therefore not merely admissible — it is the elasticity-correct
> shape.** A constant `x` spends the same fraction on cadence regardless of whether cadence or
> headline is the binding constraint. A saturating `x` spends more on cadence precisely when
> headline growth has the least marginal effect. This is the strongest available argument for
> directive 2, and it is stronger than the argument for the constant carve the prior report
> recommended.

### 2.6 THE RECOMMENDED x(P)

> ### RECOMMENDED FORM
> ```
> x(P) = x_min + (x_max − x_min) · P / (P + c)
>
>   x_min = 0.10      floor: the winner always receives at least 90% at small prizes
>   x_max = 0.30      asymptote: the winner always receives more than 70%, forever
>   c     = 250,000   half-saturation scale (credits), the prize at which x is midway
> ```
> Admissible for all `P > 0` (the proof of §2.3(d) applies verbatim to the shifted form, since
> `x_min ≥ 0` only strengthens (S) and `x_max < 1` preserves (W)).

**Why these parameters.**

- **`x_max = 0.30`** sits at the top of the observed industry band and is defensible against it:
  MUSL's GPCFP deduction is **up to 20% of a party lottery's GPP contribution**; the hidden-meter
  patents' worked examples run **37.5% and 60%**. 30% is comfortably inside. It also guarantees
  the winner **never** receives less than 70% of the pool — a bright line that is easy to state
  and never breached at any prize size, however large.
- **`x_min = 0.10`** keeps the winner's share at 90% at small prizes, where the game's positioning
  ("any player can win on a minimum bet") is most load-bearing and the headline is smallest.
- **`c = 250,000`** is chosen so the midpoint (`x = 0.20`) lands exactly on the prior report's
  recommended constant, and on MUSL's 20%. **The recommendation therefore agrees with the prior
  report's value at the prior report's design point, and only diverges away from it** — which is
  the right property for a superseding recommendation.

**The table the owner asked for** (live playtest constants: `rakeBps 450`, community 40%,
`powerboardFundingBps 6500` → prize-leg inflow **1.17% of wagered**; `lotteryFounderFeeBps 1000`;
12 s rounds; 20,000-credit pot/round → **f = 234 credits/round**):

| P (pool) | x(P) | winner W(P) | seed S(P) | fresh gross needed | rounds to refill | ≈ hours |
|---|---|---|---|---|---|---|
| 50,000 | 0.133 | **43,333** | 6,667 | 48,889 | 209 | 0.7 |
| 100,000 | 0.157 | **84,286** | 15,714 | 95,397 | 408 | 1.4 |
| 250,000 | 0.200 | **200,000** | 50,000 | 227,778 | 973 | 3.2 |
| 500,000 | 0.233 | **383,333** | 116,667 | 438,889 | 1,876 | 6.3 |
| 1,000,000 | 0.260 | **740,000** | 260,000 | 851,111 | 3,637 | 12.1 |
| 5,000,000 | 0.291 | **3,547,619** | 1,452,381 | 4,103,175 | 17,535 | 58.4 |
| 10,000,000 | 0.295 | **7,048,780** | 2,951,220 | 8,159,892 | 34,871 | 116.2 |

Both `W` and `S` increase strictly down the column, as required. Verified numerically:
`W' ∈ [0.700, 0.839]` and `S' ∈ [0.161, 0.300]` across the range — **both strictly positive
everywhere**, confirming the analytic result.

> ### THE ONE-LINE INVARIANT (directive 2)
> **`W(P) = P·(1 − x(P))` and `S(P) = P·x(P)` are both strictly increasing in `P`, and
> `W(P) + S(P) = P` exactly — the pool is split, never created, and a bigger pool always means
> both a bigger winner take and a bigger next seed.**

---

## PART 3 — DIRECTIVE 3(a): can cadence be bounded with NO cap?

### 3.1 The refutation of the naive claim

The brief's hint is: *if `x(P) → x_max`, then `S(P) = P·x_max` grows linearly with P, so the seed
may keep pace with the base by construction.* **This is true but insufficient, and the
insufficiency is arithmetic.**

With founder fee `φ = 0.10` and per-round prize inflow `f`, the fresh gross required to rebuild
the board from seed `S(P)` to a new prize `P` is:

```
fresh(P) = P/(1 − φ) − S(P) = P·[ 1/(1−φ) − x(P) ]
rounds(P) = fresh(P)/f
```

As `P → ∞`, `x → x_max` and

```
rounds(P) ~ (P/f)·[ 1/(1−φ) − x_max ]
```

This is **linear in P, not bounded**, and it vanishes only if

```
x_max ≥ 1/(1 − φ) = 1.111…
```

which is **impossible**, since `x_max < 1` is required for the winner to receive anything at all.
Numerically, the coefficient `1/(1−φ) − x_max` is `0.911` at `x_max = 0.20` and `0.811` at
`x_max = 0.30`.

> ### REFUTATION
> **For an EXOGENOUS base target, the carve alone can NEVER bound cadence — for any admissible
> `x(P)`. The carve reduces the constant of proportionality by at most `x_max` (≤11% here); it
> never changes the linear growth. This holds for every functional form in §2.3, and confirms and
> generalises the prior report's finding.**

The founder fee makes it strictly worse than the naive intuition: even a *100%* carve would not
suffice, because 10% of the rebuilt pool leaks to the fee on the way back.

### 3.2 The proof that cadence IS bounded — the endogenous base

The refutation above assumes something that **directive 3(b) removes**: that there is an
*exogenous target* `P` the board must climb back to before a draw is permitted. That is the
current design (`nextPrizeTarget`, `nextCycleBase()`, `sealFromFunding()`,
`simulation.ts:210-243`), and it is what makes cadence grow: the target ratchets by
`lotteryBaseGrowthBps` **independently of whether volume supports it**.

**Under round-only eligibility with a per-round draw, there is no target.** The prize is simply
*whatever is banked when the ball hits*. The base becomes **endogenous**, and the system's law is
a one-dimensional map:

```
P_{n+1} = S(P_n) + (1 − φ)·f·R_n
```

where `R_n` is the number of rounds until the next hit — geometric with `E[R] = 1/p = 16` at the
live `PLAYTEST_POWERBOARD_ODDS = 16`.

The fixed point `P*` satisfies `P* = S(P*) + (1−φ)·f·E[R]`, i.e. — and this is the elegant part —

```
P* − S(P*) = W(P*) = (1 − φ)·f·E[R]
```

> ### THE CADENCE THEOREM
> **The winner's take at equilibrium equals exactly the fee-net prize inflow accumulated over one
> expected inter-hit interval:**
> ```
> W(P*) = (1 − φ) · f · E[R]
> ```
> **`P*` exists and is unique because `W(P) = P(1−x(P))` is continuous, strictly increasing
> (condition (W)) and unbounded, so it crosses the constant right-hand side exactly once. The map
> is a contraction toward `P*` because `0 < W'(P) < 1` on the operating range, so `P_{n+1}`
> depends on `P_n` only through `S = P − W`, with `dS/dP = 1 − W' ∈ (0,1)`.**
>
> **Therefore: cadence is bounded — at `E[R] = 16` rounds ≈ 3.2 minutes — WITHOUT ANY CAP. The
> prize base is self-limiting. It "grows forever" in the sense the owner means (no ceiling is
> written anywhere, and it rises without bound as volume rises), yet it never runs away, because
> a bigger prize is exactly a prize that pays out more per hit.**

**Numerical confirmation** (convergence from wildly different starting points, `f = 234`,
`E[R] = 16`):

| start `P₀` | converges to |
|---|---|
| 1,000 | **3,756** |
| 100,000 | **3,756** |
| 10,000,000 | **3,756** |

and the check `W(P*) = 3,370 = (1−φ)·f·E[R] = 0.9 × 234 × 16` holds exactly.

**Equilibrium prize scales linearly with volume** — which is precisely Compiani et al.'s
"optimal odds scale linearly in population", obtained here **for free, as a structural property
rather than a tuned parameter**:

| pot/round (credits) | f (cr/round) | equilibrium `P*` | x(P*) | winner | seed |
|---|---|---|---|---|---|
| 1,000 | 11.7 | 187 | 0.100 | 168 | 19 |
| 20,000 | 234 | 3,756 | 0.103 | 3,370 | 387 |
| 130,000 | 1,521 | 24,835 | 0.118 | 21,902 | 2,932 |
| 1,000,000 | 11,700 | 208,227 | 0.191 | 168,480 | 39,747 |
| 10,000,000 | 117,000 | 2,342,317 | 0.281 | 1,684,800 | 657,517 |

> **This is the answer to directive 3(a): cadence is bounded by the carve *together with*
> round-only eligibility. Neither alone suffices. The prior report's negative finding was correct
> for the epoch/target model; directive 3(b) changes the model, and under the new model the
> result flips.**

**What else is required.** Strictly, the theorem needs three things and they are all already
true or already recommended:
1. **No exogenous ratchet target** — `nextPrizeTarget` / `nextCycleBase()` must go. (This is the
   same deletion the prior report already recommended for the reset-reserve gate.)
2. **`x(P)` admissible and saturating** — §2.6. (Needed so `W` is increasing and unbounded, which
   is what makes `P*` unique.)
3. **A draw with bounded expected wait** — `E[R] < ∞`, satisfied by the 1-in-16 geometric draw.

**One honest caveat.** At equilibrium the prize is *small and frequent* (3,756 credits every ~16
rounds at a 20,000 pot), not *large and rare*. That is a genuine product choice, not a free lunch:
this design converts the entire prize leg into **cadence**. If the owner wants a large headline,
the lever is `E[R]` — a longer expected wait linearly raises `P*` (`W(P*) ∝ E[R]`). **This is the
single most important owner decision in this document** (§6.5, D1): the odds constant is now the
prize-size dial, and it is a clean, legible, single-parameter dial with no cap and no ratchet.
Setting `PLAYTEST_POWERBOARD_ODDS` to 256 gives `P* ≈ 63,000` at the same volume; 1,024 gives
`P* ≈ 260,000`.

---

## PART 4 — DIRECTIVE 3(b): round-only eligibility

### 4.1 What the code does today

`lib/playtest-rooms.ts:677-682` — tickets are keyed `(room, epoch, user)` and **accumulate across
every round of the epoch**:

```sql
INSERT INTO playtest_powerboard_tickets (room_id,epoch,user_id,weight) VALUES ($1,$2,$3,$4)
ON CONFLICT (room_id,epoch,user_id) DO UPDATE SET weight=playtest_powerboard_tickets.weight+EXCLUDED.weight
```

with `weight = seat.stake` added per qualified round, and the winner drawn over the **whole
epoch's** accumulated weights (`:691`, `weightedTicketWinner`). The eligibility epoch is
`prior.lottery.awaitingSeal ? epoch+1 : epoch` (`:663`).

**Implementation implication of the directive: tickets become per-round, not per-epoch** — the
key becomes `(room, round, user)`, the `ON CONFLICT ... weight + EXCLUDED.weight` accumulation is
removed (a player has exactly one ticket row per round), and the draw reads only the current
round's rows. The `epoch` column and `eligibilityEpoch` derivation become vestigial for the draw.

### 4.2 Probability of winning

Let `N` be the players in a round, `w_i` player `i`'s stake, `W_r = Σ w_j` the round's stake, and
`p = 1/16` the ball's hit probability.

**Round-only model:**
```
Pr[i wins in a given round played] = p · w_i / W_r
Pr[i wins at least once over k rounds played] = 1 − (1 − p·w_i/W_r)^k
```

**Epoch model (today), for an epoch of `K` rounds in which `i` plays `k`:**
```
Pr[i wins the epoch] = (k·w_i) / (k·w_i + Σ_{j≠i} K·w_j)
```

**The comparison that matters** (N = 10 equal stakes):

| rounds in epoch `K` | player plays `k` | epoch model | round-only model | ratio |
|---|---|---|---|---|
| 100 | 1 | 0.00111 | **0.00625** | **5.6×** |
| 100 | 10 | 0.01099 | **0.06077** | 5.5× |
| 100 | 100 | 0.10000 | **0.46579** | 4.7× |
| 1,000 | 1 | 0.000111 | **0.00625** | **56×** |
| 1,000 | 10 | 0.00111 | **0.06077** | 55× |
| 1,000 | 1,000 | 0.10000 | **0.99811** | 10× |

> **The casual player who plays a single round is 5.6× to 56× more likely to win under
> round-only eligibility, and the disadvantage grows with epoch length — under the epoch model a
> one-round player's chance is diluted by the *entire epoch's* accumulated weight, which is
> unbounded in `K`.**

### 4.3 Expected value — unchanged in aggregate, transformed in dispersion

Per round, the field's expected lottery receipt is `p·P` in **both** models (in the epoch model,
`p·P` per epoch spread over the epoch's rounds). **The total return to players is identical.**
What changes is **dispersion and attribution**:

| N | EV per round per player (round-only) | field total per round |
|---|---|---|
| 2 | 117.4 cr | 234.8 cr |
| 10 | 23.5 cr | 234.8 cr |
| 100 | 2.3 cr | 234.8 cr |

**For a minimum-stake player** (`minimumStake = 500`, `lib/playtest-room-core.ts:36`) the change
is unambiguously favourable: their EV per round is `p·(500/W_r)·P`, which **does not decay with
how long the epoch has been running**. Under the epoch model, a minimum-stake player joining late
in a long epoch faces a weight denominator inflated by every prior round of every prior player —
their chance decays as `1/K`. **Round-only removes that decay entirely.**

### 4.4 Effect on the positioning "any player can win on a minimum bet"

> **It strengthens it decisively, and it is the single strongest argument for directive 3(b).**

`PRODUCT.md` Positioning §3 claims *"a minimum-stake player holds a real, non-zero, provable
chance at the full sealed prize."* Under the epoch model that claim is **technically true but
quantitatively eroding** — the longer the epoch, the smaller the minimum-stake player's share, and
epochs under the current ratchet are thousands of rounds long (prior report: 950–9,734 rounds).
At `K = 1,000` a one-round minimum-stake player's chance is `0.000111` — 1 in 9,000.

Under round-only it is `0.00625` — **1 in 160, and constant.** The claim becomes not just true but
*demonstrable on the board every single round*.

It also repairs a subtler honesty problem: under the epoch model the phrase "the full sealed
prize" is reachable only by someone who has been accumulating weight all epoch, so the marketing
claim and the realistic claim diverge. Round-only collapses them.

### 4.5 Incentives, fairness, and the sybil/whale surface

**Does it reward playing every round?** Yes — but *proportionately and honestly*, via
`1 − (1−q)^k` rather than via a weight denominator that punishes latecomers. Playing 100 of 100
rounds gives 0.466; playing 1 gives 0.00625. The dedicated player is rewarded ~75× for 100× the
play — **sub-linear**, i.e. it rewards regular play *without* making casual play pointless. The
epoch model is *linear* in `k` and therefore harsher on the casual player at the margin.

**Does it disadvantage casual players?** **No — it is strictly better for them**, by the factors
in §4.2. This is the opposite of the intuitive worry ("I lose my accumulated tickets"), and the
intuition is wrong because *the prize also resets*: you are not losing tickets toward a big prize,
you are getting a fresh full-odds shot at a smaller prize, every round, forever.

**Is it MORE or LESS fair?** **More fair, on two of three standard criteria:**
- *Ex-ante equality of opportunity per unit staked*: **identical** in both models (both are
  stake-proportional, linear, and neither favours large or small stakes per credit).
- *Independence from arrival time*: **round-only is strictly fairer.** The epoch model's outcome
  depends on when you joined relative to the epoch; round-only does not. This is a real fairness
  gain, not a cosmetic one.
- *Reward for loyalty*: the epoch model is nominally more "loyal-friendly", but only because it
  penalises newcomers — a redistribution, not a creation, of fairness. And round-only still
  rewards loyalty through repeated exposure (`1−(1−q)^k`).

**Ticket-weight concentration.** Round-only **reduces** it. Epoch weights are sums over rounds,
so a heavy regular's weight compounds relative to a casual's; per-round weights are a single
round's stakes, so the concentration is only whatever that round's stake distribution is. The
whale's advantage is capped at their share of *one round's* pot rather than their share of an
epoch's cumulative volume.

**Sybil surface: unchanged, and provably so.** Weight share is **linear in stake** in both models,
so splitting a stake `s` across `M` wallets yields `M·((s/M)/W) = s/W` — **exactly invariant**
(verified numerically for M = 1, 5, 100). Round-only neither opens nor closes a sybil vector on
the draw. The relevant sybil surface remains the ccs-2l house layer, which
`CASINO-ARCHITECTURE.md` §0 already addresses via `seedBudget` and the profit-weight rule, and is
untouched here.

**Draw excitement.** **Every round becomes a live draw.** This is a substantial product gain and
it is directly supported by the strongest citation in the file: Cook–Clotfelter's finding that
*players judge the likelihood of winning by the observed frequency with which someone wins.*
Under the current design a player may play for hours and never see a draw resolve; under
round-only, a draw resolves every 12 seconds and someone visibly wins roughly every 16 rounds
(~3.2 minutes). The single most load-bearing behavioural quantity in the literature goes from
"almost never observed" to "observed ~19 times an hour".

### 4.6 Comparison to real-world practice

> **Round-only eligibility is the MORE conventional model, and the current epoch-accumulation
> model is the unusual one.**

- **A lottery ticket is for a specific draw.** Powerball/MUSL: each ticket is purchased for one
  drawing; it is the **jackpot** that rolls over, never the tickets. This is the exact structure
  proposed here — *the prize carries forward, the eligibility does not.*
- **Raffles discard tickets each draw**: *"that ticket is then left out of the container... A
  second ticket is then drawn for the next prize, and that ticket also is discarded."* And *"each
  of which has an equal chance of winning a prize."*
- **Slot progressives** are per-spin: eligibility is established by the wager on the triggering
  spin, not by cumulative prior wagering.
- **The one real counterexample is the on-chain no-loss family** (PoolTogether, Save to Win),
  where a *deposit balance* confers eligibility across draws — but that is because the stake is
  *persistent capital*, not a per-round wager. Plank's stake is a per-round wager, so the slot /
  lottery / raffle analogy is the correct one.

**Conclusion: directive 3(b) moves the design from an unusual model toward the universal one, and
the intuition it matches ("my ticket is for this draw") is the one every player already has.**

---

## PART 5 — `mustHitByEpochs`, and the remaining reconciliation

### 5.1 Current state — verified

`mustHitByEpochs` is **fully implemented on-chain** and **entirely absent from the live engine**:

- `contracts/PlankPowerboard.sol:109` — `uint256 public immutable mustHitByEpochs;`
- `:202` — `uint256 mustHitByEpochs; // 0 = disabled (pure geometric jackpot)`
- `:234` — `mustHitByEpochs = cfg.mustHitByEpochs;`
- `:405-407` — verbatim:
  ```solidity
  bool natural = (ball == jackpotBall);
  bool forced = mustHitByEpochs > 0 && epoch > lastJackpotHitEpoch && (epoch - lastJackpotHitEpoch) >= mustHitByEpochs;
  bool hit = natural || forced;
  ```
  and `:408` — `uint256 prize = hit ? jackpot : (jackpot * consolationBps) / 10000;` — so a forced
  hit pays the **FULL jackpot regardless of the ball**.
- `:469-471` — `guaranteedHitByEpoch()` returns `lastJackpotHitEpoch + mustHitByEpochs`, the
  deadline a UI can headline.

**Under `lib/`: zero occurrences** (grep across `lib/`, `app/`, `components/`; matches occur only
in `contracts/`). `CASINO-ARCHITECTURE.md` §10 states *"the full jackpot is **guaranteed** to pay
out at least every `mustHitByEpochs` epochs — **it can never roll forever**."*

> **So the on-chain contract keeps the "it can never roll forever" promise and the live playtest
> engine does not.** This is a truthfulness gap that exists **today**, independent of every other
> recommendation in this document.

### 5.2 Q1 — Quantify the tail. Real protection or theatre?

Under round-only eligibility the ball is drawn **every round**, independently, at
`p = 1/ballRange = 1/16` (`PLAYTEST_POWERBOARD_ODDS`, `playtest-room-core.ts:211`). Rounds-between-hits is
therefore **Geometric(1/16)**, and at 12 s/round:

| rounds N | `P(no hit in N)` | odds | wall-clock |
|---|---|---|---|
| 16 | 0.356074 | 1 in 3 | 3 min |
| 50 | 0.039679 | 1 in 25 | 10 min |
| 100 | 0.001574 | 1 in 635 | 20 min |
| 160 | 0.0000328 | 1 in 30,521 | 32 min |
| 200 | 0.00000248 | 1 in 403,408 | 40 min |
| 300 | 0.0000000039 | 1 in 256,222,391 | 60 min |
| 500 | ~1e-14 | 1 in 1.0×10¹⁴ | 100 min |

**Moments and quantiles:** `E[R] = 16.0` rounds (3.2 min); `sd[R] = 15.5` rounds; `p50 = 11`
(2.1 min); `p90 = 36` (7.1 min); **`p99 = 71` rounds (14.3 min)**; `p99.9 = 107` (21.4 min);
`p99.99 = 143` (28.5 min).

**Frequency of long dry spells** at 7,200 rounds/day (≈450 hits/day):

| dry run ≥ | expected occurrences | i.e. |
|---|---|---|
| 100 rounds | 0.709/day | once every **1.4 days** |
| 160 rounds | 0.0147/day | once every **68 days** |
| 200 rounds | 0.0011/day | once every **2.5 years** |
| 300 rounds | ~2×10⁻⁶/day | once every **1,560 years** |

> ### VERDICT Q1 — at `E[R] = 16`, a must-hit-by set anywhere it would not distort the game is
> **theatre against an already-thin tail.**
> The p99 wait is **14 minutes**. Any `N` large enough not to fire spuriously (≥160 rounds) fires
> **once every 68 days**; at `N = 200` it fires **once every 2.5 years**. It is a guarantee of
> something the geometric distribution already delivers. It changes the player's realized
> experience essentially never.

**But the verdict is parameter-dependent, and that matters.** At the recommended `E[R] = 256`
(§6.5 D1), the tail is materially fatter in wall-clock terms: `p99 = 1,177` rounds (**3.9 hours**),
`p99.9 = 1,765` rounds (**5.9 hours**), and `P(no hit in 2,000 rounds) = 0.0004`. **A 4–6 hour dry
spell is a real product event that a player will notice and resent.** So:

> **Must-hit-by is theatre at `E[R] = 16` and genuine protection at `E[R] = 256`.** Since D1
> recommends 256, **it is genuine protection under the recommended configuration.** The two
> decisions are coupled and must be made together.

### 5.3 Q2 — Does the progressive carve interact with the tail?

The coordinator's hypothesis is that a long dry spell inflates `P`, pushing `x(P)` toward its
ceiling, so a late hit carves a large seed — self-correcting. **The arithmetic says this is
directionally real but far too weak to matter, and the second-order effect runs the other way.**

Prize reached after a dry spell of N rounds (from the equilibrium seed, `f = 234`, `φ = 0.10`):

| dry rounds | P reached | × equilibrium | x(P) | winner take |
|---|---|---|---|---|
| 16 (`E[R]`) | 3,756 | 1.0× | 0.103 | 3,370 |
| 100 | 21,447 | 5.7× | 0.116 | 18,963 |
| 200 | 42,507 | 11.3× | 0.129 | 37,021 |
| 500 | 105,687 | **28.1×** | 0.159 | 88,837 |

> **VERDICT Q2 — the carve does NOT self-correct the tail, and the imbalance argues FOR
> must-hit-by, not against it.**

Three findings, each independent:

1. **The carve's response is far too slow.** A **28×** prize excursion moves `x` from 0.103 to
   only **0.159** — the seed share rises by 5.6 percentage points against a 28-fold prize
   increase. `x` is designed to saturate over a scale of `c = 250,000`, but dry-spell excursions
   at equilibrium reach only ~100,000. **The carve is essentially flat over the entire range the
   tail can reach.** It is a *volume* mechanism, not a *tail* mechanism, and it was never
   intended to be one.
2. **The self-correction, such as it is, is a correction of the wrong variable.** A larger seed
   makes the *next* board start higher — it does nothing for the player sitting through the
   current dry spell. The problem the tail creates is **waiting**, and the carve does not
   shorten waits.
3. **The decisive point — it makes the credibility problem WORSE, exactly as the coordinator
   suspected.** A 28× prize excursion means the board is displaying a number 28 times its normal
   size at the precise moment the game has visibly failed to pay for 100 minutes. This is the
   **worst** configuration for trust: a huge, conspicuous, unpaid headline. Cook–Clotfelter's
   mechanism (participation tracks *observed* win frequency) says the damage of a visible dry
   spell is real, and the inflated prize amplifies rather than offsets it, because it advertises
   the drought. **The bigger the pot can balloon, the more a "not paying" state costs — so the
   ability of the prize to grow without a cap (directive 3a) is precisely the reason a hard
   payout deadline is needed.**

> **Directive 3(a) — "it can grow forever" — is therefore not an argument against must-hit-by.
> It is the strongest argument FOR it.** With a cap, an unbounded wait is embarrassing; without
> a cap, an unbounded wait is embarrassing *and* the number on the screen keeps growing while it
> happens. Must-hit-by is the mechanism that lets the owner honestly say "no ceiling" without
> "no ceiling" ever becoming "no payout".

### 5.4 Q3 — Verdict: should `lib/` implement it, and at what N?

> ### VERDICT Q3 — YES. Implement `mustHitBy` in `lib/`. This is a truthfulness obligation, not
> an optimisation.

**The truthfulness argument is dispositive and stands alone.** `CASINO-ARCHITECTURE.md` §10
states the jackpot *"is guaranteed to pay out at least every `mustHitByEpochs` epochs — it can
never roll forever."* The live engine does not implement it. **A documented guarantee the engine
does not enforce is a false statement about the product**, and it fails the same standard as
`displayed == redeemable`: that constraint's substance is *every number and promise shown to a
player must reconcile with what the system actually does*. The thinness of the tail is **not a
defence** — a guarantee is either enforced or it is not, and "it would probably have happened
anyway" is exactly the reasoning the product's honesty constraints exist to forbid. It is also
inconsistent for the contract to bind itself to a promise the live engine ignores.

**Therefore exactly one of two things must happen, and doing neither is not an option:**
- **(A) Implement `mustHitByRounds` in `lib/`** — recommended; or
- **(B) Delete the guarantee from §10** and stop claiming it.

**(A) is strongly preferred**, because the guarantee is genuinely valuable at the recommended
`E[R] = 256`, it is already built and tested on-chain (so `lib/` parity is the smaller job), and
`guaranteedHitByEpoch()` supports a checkable *"guaranteed to pay by <date>"* headline — exactly
the kind of verifiable promise `PRODUCT.md`'s fairness-as-a-surface constraint rewards.

**The unit must change: ROUNDS (equivalently draws), not epochs.** Under round-only eligibility
every round is a draw and "epoch" no longer names the eligibility window, so an epoch-denominated
deadline counts a unit that governs nothing. Concept name: **`mustHitByRounds`**; counter resets
on every full payout, natural or forced.

**Recommended N**, chosen so the guarantee is a real bound that essentially never fires
spuriously — target `P(forced) ≈ 0.1–0.5%`, i.e. `N ≈ 5–8 × E[R]`:

| if D1 sets `E[R]` = | recommended `mustHitByRounds` | `P(guarantee fires)` | deadline in wall-clock |
|---|---|---|---|
| 16 (today) | 160 | 0.0033% | 32 min |
| **256 (recommended)** | **1,536** (6 × E[R]) | **0.25%** | **5.1 hours** |
| 1,024 | 6,144 | 0.25% | 20.5 hours |

At `E[R] = 256, N = 1,536`: the guarantee binds about **1 draw in 400**, caps the worst case at
**5.1 hours**, and cuts the p99.9 wait (5.9 h) down to the deadline. That is a real, cheap,
honest bound.

**Three interaction rules with the rest of the design** — each of which matters:

1. **A forced hit is settled by exactly the same split.** The winner receives `W(P) = P(1−x(P))`
   and `S(P) = P·x(P)` seeds the next board, identically to a natural hit. **No special-casing.**
   Any exception would create two different meanings for the same headline and break
   `displayed == redeemable` for the forced case.
2. **Draw from the winning ROUND's ticket set**, same as a natural hit. Pleasant consequence:
   the guarantee can never pay to someone who is not present, so there is no unclaimed-forced-
   jackpot case to handle. (This is strictly simpler than the contract's epoch-segment version.)
3. **The deadline must be displayed**, not merely enforced — `guaranteedHitByEpoch()`'s live
   analogue. An unenforced guarantee is a lie; an unadvertised one is a wasted asset.

**Reconciliation with `displayed == redeemable`:** the forced payout pays `W(P)` from a `P` that
is fully banked at that instant, so conservation (I3) holds exactly and no unbacked liability is
created. The guarantee changes *when* the pool is paid, never *what* is paid or whether it is
backed.

### 5.5 Reconciliation with every stated constraint

| Constraint | Status under this design | Note |
|---|---|---|
| **displayed == redeemable** | ✅ **only with the display law** | The pool headline must be labelled a **pool** with the split disclosed **from the outset**, never as "you win". This is a **hard prerequisite**, inherited unchanged from the prior report §7.4. Without it the design is the meter turn-back that GLI-12 / 205 CMR 143.02 prohibits: *"No progressive meter(s) shall be turned back to a lesser amount, unless: The amount indicated has been paid to a winning patron."* The reconciling precedent is **US 8,821,289 B2 "Partial pay progressives"** (Bally/LNW), where the player takes part of the pool and the remainder carries forward — lawful precisely because the meter is a **pool**, not a promise. |
| **Guaranteed reset** | ✅ **strengthened** | Now structural rather than pre-funded: the seed `S(P)` is carved from **already-banked** money at the instant of the hit. The board is never empty by construction, so the reset-reserve gate can be deleted. |
| **Prize base never decreases (C3)** | ✅ | `S(P) > 0` always, and the new board opens at `S(P)` and only rises. **Note:** the *cycle base* concept disappears with the exogenous target; what is preserved is that the live board never falls except by being paid. |
| **No unbacked liability** | ✅ **exactly conserved** | `W + S = P` at the instant of the hit; `accountedAssets()` (`simulation.ts:407-415`) is conserved. Zero house exposure — identical to status quo. |
| **No operator earnings displayed** | ✅ | The seed is **not** operator revenue — it stays in the prize pool and is paid to a future player. It must be labelled *"seeds the next board"*, never as a fee. The founder fee (`lotteryFounderFeeBps`) remains disclosed as a percentage only. |
| **Owner display law (USD/ETH primary, realized return leads)** | ✅ | Both `W` and `S` shown in USD · ETH · credits, in that order; the realized-return figure leads. |
| **Test credits have no cash value** | ✅ | Untouched. |
| **Provable fairness surface** | ✅ **strengthened** | The per-round draw is already derived from the committed reveal (`powerboardRoundDraw`, `playtest-room-core.ts:228-233`) and `weightedTicketWinner` is already an unbiased rejection sampler over the committed entropy. Round-only eligibility makes the verifiable object *smaller and simpler* — one round's ticket set instead of an epoch's accumulation. |

---

## PART 6 — THE INTEGRATED RECOMMENDATION

### 6.1 The five decisions, together

1. **THE VAULT'S ONE ROLE — the solvency floor of the house layer.** `emissionBuffer` is the
   bankroll; `protectedPrincipal` becomes its **floor** (monotone, never spent, but now
   *load-bearing* — the buffer may never be drawn below it) rather than an inert trophy. Surplus
   above `emissionBufferCap` continues to cascade to the Powerboard — already implemented at
   `simulation.ts:388-390`. Retire *"a reserve that only grows"* from `PRODUCT.md`'s Vault
   terminology; adopt §9's substance.

2. **x(P) — the saturating progressive carve.**
   ```
   x(P) = 0.10 + 0.20 · P/(P + 250,000)
   ```
   Winner receives `P(1−x(P))`, next board opens at `P·x(P)`. Admissible for all `P > 0`; both
   `W` and `S` strictly increasing everywhere; winner never receives less than 70%, never more
   than 90%.

3. **ROUND-ONLY ELIGIBILITY — adopt.** Tickets become per-round (`(room, round, user)`, no
   accumulation). This is the more conventional model, it is 5.6–56× better for the casual
   player, it reduces weight concentration, it is sybil-neutral, and **it is what makes the base
   endogenous and therefore self-limiting.**

4. **NO CAP — and none is needed.** Delete the exogenous ratchet target
   (`nextPrizeTarget`, `nextCycleBase()`, the reset-reserve gate). The prize equilibrates at
   `W(P*) = (1−φ)·f·E[R]`, scaling linearly with volume, converging from any starting point.
   **The owner's "it can grow forever" is satisfied literally: no ceiling exists anywhere.**

5. **MUST-HIT-BY — implement it in `lib/`.** Not optional: §10 promises a guarantee
   (`contracts/PlankPowerboard.sol:405-407`) that the live engine does not enforce, which is a
   truthfulness failure regardless of how thin the tail is. Counted in **rounds**
   (`mustHitByRounds`), settled by the **same split**, drawn from the **winning round's**
   tickets, and **displayed** as a "guaranteed by" deadline. At the recommended `E[R] = 256` it
   is genuine protection (it cuts a 5.9-hour p99.9 wait to a 5.1-hour hard bound), not theatre.
   **Because directive 3(a) removes the cap, the prize can balloon during a dry spell — which
   makes the deadline more necessary, not less (§5.3).**

### 6.2 The exact invariants

```
(I1)  VAULT ROLE
      emissionBuffer ≥ protectedPrincipal          (solvency floor, never breached)
      cumulative vault outflow ≤ cumulative rake inflow + bootstrap
      emissionBuffer > emissionBufferCap ⟹ excess released to lottery.pendingFunding

(I2)  CARVE ADMISSIBILITY
      −x(P)/P < x'(P) < (1 − x(P))/P    for all P > 0,   0 ≤ x(P) < 1
      ⟹ W(P) = P(1−x(P)) and S(P) = P·x(P) both strictly increasing

(I3)  CONSERVATION AT THE HIT
      W(P) + S(P) = P     exactly, at the instant of settlement
      accountedAssets() unchanged across the hit

(I4)  CADENCE
      W(P*) = (1 − φ)·f·E[R]        unique, attracting fixed point; no cap required

(I5)  ELIGIBILITY
      Pr[i wins round r] = p · w_i,r / W_r      depends ONLY on round r
      (independent of arrival time, epoch length, and prior play)

(I6)  DISPLAY (hard prerequisite for I3)
      the headline is a POOL; W and S are both disclosed before play, never only at payout;
      the figure labelled as the winner's receipt equals the credited balance exactly
```

### 6.3 What I would NOT change, and why

- **The 40/40/20 ratified rake split** (`economics.ts:181-183`) and the rake staircase
  (`evolutionQuote`). Untouched by everything here. This design reallocates *within* the prize
  leg only; the true 0.9% net house edge is unchanged. **Do not reopen a ratified parameter to
  solve a problem that lives downstream of it.**
- **`PRODUCT.md`'s "a community lottery whose prize can only grow."** This is about the **prize**,
  is protected by C3, and remains true: the live board only ever rises except by being paid. Only
  the **Vault**'s "only grows" wording is retired. These are easy to conflate and must not be.
- **The 1-in-16 committed-reveal draw and `weightedTicketWinner`.** Already unbiased, already
  derived from the committed reveal, already verifiable. The *value* 16 becomes a product dial
  (§6.5 D1) but the *mechanism* is correct and should not be touched.
- **Stake-proportional ticket weight.** It is sybil-invariant (proven §4.5), it is the honest
  expression of "your share of what you put in", and every alternative (equal tickets per player,
  capped weight) opens a sybil vector that stake-proportionality structurally closes.
- **Zero house exposure and the conservation checks** (`assertSimulationInvariants`). The carve is
  admissible *precisely because* it never violates them; they are what make it safe.
- **The founder fee mechanism** (`sealLotteryEpoch`, `minimumLotteryGross`). Its *rate* is an
  owner decision, but the mechanism — fee taken on constitution, disclosed as a percentage,
  never displayed as earnings — is correct and satisfies C6.
- **The prior report's display law (Part 7) in its entirety.** It is a hard prerequisite for this
  design, not an optional companion, and it needs no revision to accommodate the progressive
  carve — the two numbers it mandates are exactly `W(P)` and `S(P)`.

### 6.4 The display, under a progressive x

Because `x` now varies, the board must show **the two credit amounts**, not the rate — a player
should never have to evaluate a rational function to know what they are playing for.

```
POWERBOARD POOL   $XXX · 0.0YY ETH (250,000 cr)
  you receive     $XXX · 0.0YY ETH (200,000 cr)     ← 80% at this pool size
  seeds the next  $XXX · 0.0YY ETH  (50,000 cr)     ← never leaves the board
  odds this round 1 in 160
```

Both figures update live as the pool grows, and **both always go up** — which is the whole point
of the admissible-family condition, and is now a *visible, checkable* property of the board rather
than a claim. For a static explainer, present `x(P)` as a **marginal bracket table** (§2.3(e′)):
it is the most legible representation of a state-dependent rate, and it is monotone-safe.

### 6.5 Owner decisions — every one that remains

| # | Decision | Why it is the owner's | My recommendation |
|---|---|---|---|
| **D1** | **`E[R]` — the prize-size dial.** With no cap and no ratchet, `PLAYTEST_POWERBOARD_ODDS` sets the equilibrium prize: `W(P*) = (1−φ)·f·E[R]`. 16 → ~3,370 cr; 256 → ~54,000; 1,024 → ~216,000 (at a 20,000 pot). | **This is the central product trade-off** — frequent-and-small vs rare-and-large. The math is settled; the taste is not. | Start at **256** (a draw ~every 51 min, prize ~16× larger than today's equilibrium) as a middle path, and treat it as the one tunable. |
| **D2** | `x_max`, `x_min`, `c`. | Commercial configuration; **no regulator publishes a seed rate.** | `0.30 / 0.10 / 250,000`. Defensible against MUSL (≤20%) and the hidden-meter patents (37.5–60%). |
| **D3** | Whether `protectedPrincipal` becomes the solvency floor (preferred) or is deleted. | Changes the meaning of a live UI number. | **Becomes the floor.** Smallest change that makes directive 1 true. |
| **D4** | `mustHitByRounds` value. **Whether to implement is NOT an owner decision in the usual sense** — §10 promises it and `lib/` does not do it, so the only choice is implement (A) or retract the claim (B). | It is a public promise; leaving it unenforced is a truthfulness failure. | **Implement (A).** `mustHitByRounds = 6 × E[R]` → **1,536** at the recommended `E[R] = 256` (fires ~0.25% of draws, caps the wait at 5.1 h). Coupled to D1 — decide both together. |
| **D5** | The display law's exact wording and the pool-vs-prize labelling. | Legal exposure sits here (GLI-12 / 205 CMR 143.02). | Adopt prior report §7.4 verbatim. **Non-negotiable prerequisite.** |
| **D6** | Whether the fast-lane second prize (prior report §5(e)) is still wanted. | Product scope. | **Drop it.** Its entire purpose was frequent observable wins; round-only eligibility at `E[R]=16–256` already delivers that. Two lanes would now be redundant complexity. |
| **D7** | Whether `lotteryFounderFeeBps` (10%) should apply to the carried seed. | It currently would be charged again on re-constitution. | **Charge the fee once, on fresh inflow only** — charging it on the carried seed taxes the same credits every cycle and slowly bleeds the board. (The prior report flagged this as `lotteryFounderFeesOnRollover`, `simulation.ts:233`.) |

---

## PART 7 — Citations

All accessed **2026-09-04** unless noted. Classification: **PROVEN** (verbatim primary text
confirmed) / **PEER-REVIEWED** / **INDUSTRY-STANDARD** / **JUDGMENT**.

### Progressive-jackpot contribution mathematics

- **US 9,454,875 B2, "Methods for variable contribution progressive jackpots"** (LNW/Bally
  Gaming; priority 2007-05-15, published 2016-09-27).
  https://patents.google.com/patent/US9454875B2/en — **PROVEN.**
  *"The contribution rate is based on the jackpot level (e.g., the number of wagers placed during
  the actual game cycle ('wager count') or amount of the jackpot value), allowing the operator to
  vary or control the rate at which the jackpot grows."* Worked Table 1: jackpot <$60,000 → **35%**;
  <$110,000 → **33%**; ≥$210,000 → **30%**.
  **This is the direct precedent for a state-dependent x(P) — and it runs in the OPPOSITE
  direction to the owner's instinct** (rate *falls* as the jackpot grows, to reclaim overage).
  Reported honestly: industry practice front-loads the seed at small jackpots. The owner's design
  is defensible on different grounds (§2.5 elasticity), not on this precedent.

- **US 8,821,289 B2, "Partial pay progressives"** (Bally/LNW, 2014).
  https://patents.google.com/patent/US8821289B2/en — **PROVEN** (via prior report).
  A patented carve **at win time**: the player takes *"200 units from the base component plus 40
  units from the incremental component"* while the remainder **stays in the pool and carries
  forward.** **This is the legal reconciliation for the entire carve design.**

- **US 8,740,692 B2, "Variable contribution progressive jackpots"**;
  **US 9,830,777 B2** and **Aristocrat US 2013/0172076 A1** (hidden-meter reseed:
  *"a portion of the increments are added to the hidden meter and used to fund the reset value for
  future jackpots"*); **US 9,355,521 B2** (hidden share of contribution at **37.5%** and **60%**).
  https://patents.google.com/patent/US8740692B2/en ·
  https://patents.google.com/patent/US9830777B2/en ·
  https://patents.google.com/patent/US20130172076A1/en ·
  https://patents.google.com/patent/US9355521B2/en — **INDUSTRY-STANDARD.**
  The mainstream architecture carves from the **contribution stream**, not the payout.

- **US 2008/0153587 A1, "Progressive jackpot system accelerating increment rate of jackpot
  value"** (Konami Gaming; filed 2006-12-26, published 2008-06-26).
  https://patents.google.com/patent/US20080153587A1/en — **PROVEN.**
  A second meter incremented *"at a rate higher than the increment rate of the first jackpot
  value"* (worked example 5×), resetting on reaching an upper limit. Precedent that
  **state-dependent increment rates are established practice**, though for visible-growth
  engagement rather than reseeding.

### Multi-tier / must-hit-by ("mystery") jackpots

- **58 Pa. Code § 643c.1, "Must-Hit-By Mystery bonus."**
  https://www.law.cornell.edu/regulations/pennsylvania/58-Pa-Code-SS-643c-1 — **PROVEN.**
  Triggered when a contribution increases the meter *"in excess of a random dollar value
  preselected by an electronic random number generator, between a set minimum and maximum dollar
  value"*; the winner receives *"100% of the bonus jackpot amount on the progressive meter"*; the
  meter *"Reset[s]... to the minimum dollar value."*
  **Note the constraint this imposes on Plank:** where a must-hit-by is offered, the regulation
  contemplates the winner receiving **100% of the displayed meter** — reinforcing §5.5's
  requirement that Plank's headline be a **pool**, not a meter.

- **Shackleford, M., "Must-Hit-By Progressives," Wizard of Odds** (updated 2026-08-03).
  https://wizardofodds.com/games/slots/mystery-jackpot/ — **INDUSTRY-STANDARD.**
  *"A point at which the jackpot will hit is randomly chosen on a uniform distribution between the
  starting value and maximum possible jackpot."* Breakeven jackpot `j = m(1−f)/(1−f+r)`
  (short-term) and `j = m(1−f−r)/(1−f+r)` (long-term); average must-hit-by value
  `r + 2rn/(m−n)`.

- **GLI-12, "Progressive Gaming Devices in Casinos," v2.1/v3.0.**
  https://gaminglabs.com/wp-content/uploads/2026/01/GLI-12-v3-0-FINAL.pdf —
  **INDUSTRY-STANDARD.** *Honesty flag (inherited from prior report): the PDFs are compressed
  binary; verbatim clause numbers could not be extracted.*

### MUSL set-aside and carry-forward

- **18-553 C.M.R. ch. 20, § II-4.0 (Powerball Prize Pool).**
  https://www.law.cornell.edu/regulations/maine/18-553-C-M-R-ch-20-SS-II-4-0 — **PROVEN.**
  GPCFP *"is used to fund the starting minimum annuity Grand Prize... if such funds are available,
  and if sales do not fund the Grand Prize."* Deduction: *"An additional amount **up to twenty
  percent (20%)** of a Party Lottery's sales shall be deducted from a Party Lottery's GPP
  contribution and placed in trust in the GPCFP."* SAP *"used to fund the payment of the awarded
  minimum starting annuity Grand Prizes."* *"maximum balance amounts or balance limiter triggers
  are set by the Product Group."*
  **Directly load-bearing for directive 2:** the reseed rate is **state-dependent** — the
  deduction is governed by pool balance triggers (reported as GPCFP < $45M with the annuity Grand
  Prize > $120M), i.e. **the largest regulated jackpot game on earth already varies its carve with
  the state of the reserve and the size of the jackpot.** This is the strongest real-world
  precedent for a progressive carve, and it is the citable upper bound for `x` (20%).
  *Honesty flag: the specific $45M / $120M / 4%-of-sales trigger values appear in Oregon and Iowa
  restatements of the MUSL rules but were **not** located verbatim in the Maine text, which defers
  them to the Product Group. Treat the trigger values as **INDUSTRY-STANDARD**, the up-to-20%
  deduction as **PROVEN**.*

- **OAR 177-085-0025 (Powerball Prize Pool)** — grand prize pool = **29.1942%** of gross sales,
  set prizes = **20.8058%**. https://oregon.public.law/rules/oar_177-085-0025 —
  **INDUSTRY-STANDARD.**

### Rollover-demand literature

- **Cook, P.J. & Clotfelter, C.T., "The Peculiar Scale Economies of Lotto,"** *American Economic
  Review* 83(3), 1993, 634–643; NBER WP 3766. https://www.nber.org/papers/w3766 —
  **PEER-REVIEWED.** *Players judge the likelihood of winning by the frequency with which someone
  wins*, so a larger base can offer longer odds at the same perceived probability.
  **The single most load-bearing citation for directive 3(b):** round-only eligibility raises
  observed win frequency from ~never to ~19/hour.

- **Compiani, G., Magnolfi, L. & Smith, C., "An Equilibrium Model of Rollover Lotteries,"**
  BFI WP 2024-34. https://bfi.uchicago.edu/wp-content/uploads/2024/03/BFI_WP_2024-34.pdf ·
  https://giovannicompiani.com/documents/Lotteries.pdf — **PEER-REVIEWED** (working paper).
  Log sales grow **convexly** in log jackpot; **optimal lottery odds scale linearly in
  population.** *Honesty flag: the PDF resisted text extraction in this session; the two results
  are carried forward from the prior report's verified reading and corroborated by the BFI
  summary page (*"buyers pick their own numbers, and a jackpot not won adds to the next draw"*).
  Verify verbatim before quoting.*
  **The linear-scaling result is exactly what §3.2's fixed point delivers structurally.**

- **Combs, K.L. & Spry, J.A., "The sales effects of Powerball and Mega Millions game redesign,"**
  *Applied Economics* 57(29), 2025, 4083–4097.
  https://www.tandfonline.com/doi/abs/10.1080/00036846.2024.2348180 — **PEER-REVIEWED.**
  Redesigns raising the average jackpot **lowered** the elasticity of sales to jackpot size —
  quantified **jackpot fatigue**. **The bound on "does a bigger prize pay for itself".**

- **Jackpot fatigue in operator practice** — NC same-day Mega Millions sales **$10.1M at $830M
  (Jul 2022) → $3.7M at $820M** a year later (~63% collapse at the same prize).
  https://www.playusa.com/news/jackpot-fatigue-dulling-mega-millions-and-powerball-sales-ohio-lottery-says/
  — **INDUSTRY-STANDARD.**

### Eligibility model

- **Raffle (encyclopaedic summary).** https://en.wikipedia.org/wiki/Raffle — **INDUSTRY-STANDARD.**
  *"each of which has an equal chance of winning a prize"*; *"that ticket is then left out of the
  container. A second ticket is then drawn for the next prize, and that ticket also is
  discarded."* Per-draw eligibility with tickets discarded after each drawing is the conventional
  raffle/lottery structure. *Honesty flag: the article does not directly address multi-draw
  ticket validity; the per-draw norm is corroborated by the MUSL per-drawing ticket structure
  above and by slot progressives' per-spin eligibility.* **The rolling object in every one of
  these designs is the PRIZE, never the TICKETS** — which is precisely directive 3.

### Reserve / ruin theory (carried forward, unchanged)

- **Directive 2009/138/EC (Solvency II), Recital 64 & Art. 101(3)** — ruin no more than
  1-in-200; VaR at **99.5%** over one year, explicitly **not** 100% pre-funding of the
  obligation. https://eur-lex.europa.eu/legal-content/en/ALL/?uri=CELEX%3A32009L0138 —
  **PROVEN** (Recital 64).
- **Cramér–Lundberg ruin theory** — Lundberg (1903); Cramér (1930); Asmussen & Albrecher, *Ruin
  Probabilities* (2nd ed. 2010). https://link.springer.com/book/10.1007/978-3-642-33483-2 —
  **PEER-REVIEWED.** Lundberg inequality `ψ(u) ≤ e^(−Ru)`: **ruin probability decays exponentially
  in the initial reserve**, so reserve requirements grow only **logarithmically** in the
  reciprocal of the tolerated ruin probability.
  **Applied here:** this is why the vault's solvency floor (I1) can be modest and still safe, and
  why the deleted reset-reserve gate — which pre-funded **100%** of a future contingent obligation,
  stricter than Solvency II applies to guaranteed life benefits — was buying the last basis points
  of certainty at disproportionate cost in cadence.

---

## Appendix — verification method

- **Code claims** were read directly from the working tree at `C:\tmp\robinwood-sync-fix2`
  (`lib/casino/economics.ts`, `lib/casino/simulation.ts`, `lib/playtest-room-core.ts`,
  `lib/playtest-rooms.ts`) and are cited by `file:line`.
- **`mustHitByEpochs` absence from `lib/`** was established by grep across `lib/`, `app/`,
  `components/`, `contracts/`: matches occur only in `contracts/PlankPowerboard.sol`.
- **All numerics** (admissibility derivatives, cadence tables, fixed-point convergence,
  eligibility probabilities, sybil invariance) were computed from the live constants in
  `DEFAULT_PLAYTEST_POLICY` and `PLAYTEST_POWERBOARD_ODDS`, not assumed. The fixed point was
  verified both analytically (`W(P*) = (1−φ)f·E[R]`) and by iterating the map from `P₀ ∈
  {10³, 10⁵, 10⁷}`, all converging to the same value.
- **Every citation** was fetched in this session unless marked as carried forward from the prior
  report, in which case it is labelled as such with an honesty flag.
- **No file other than this one was created or modified.**
