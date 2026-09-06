# SPEC — Monotonic Vault Toward Aggregate Positive-Sum (draft, 2026-09-05)

Status: **draft for owner review — no code written yet.** This document exists to get the
formula and numbers agreed before anything touches `PlankCrash.sol`, `PlankLottery.sol`, or
`PlankRakeRouter.sol`.

## 1. The goal, stated precisely

Today, PlankCrash and PlankLottery are provably negative-sum for players by exactly the rake
rate — every round distributes at most `stakes × (1 - rake)` to survivors
(`PlankCrash.sol:498`, `PlankCcs2LMath.sol:194-219`), and the lottery only redistributes
already-raked money among players (`PlankLottery.sol:19-26`). Neither system can make
aggregate players net-positive on its own.

The owner's goal: **as the game accumulates real volume over time, it should become
increasingly generous — eventually able to pay players, in aggregate, more than they staked
in a given round — without ever becoming *less* generous than it has been, and without ever
promising a payout the contract cannot actually fund.**

## 2. What research ruled out

A monotonic "vault that funds a bonus sized off the vault's own current balance" was the
original framing (superseded — see §3.4's revision history and the owner's 2026-09-05
feedback that a size-keyed curve creates an unwanted "grow the number first" gate). Two real
problems, found by comparing this to real precedent (progressive-jackpot gaming regulation,
and post-mortems of DeFi treasury-ratchet designs like OlympusDAO), motivated the fixes below
regardless of which signal (size or count) ultimately drives the curve:

1. **It's cosmetic unless the house commits to something real.** If the bonus is funded
   fresh from that round's own rake — never from vault principal — then linking its *size*
   to the vault's balance doesn't change how much money moves from players to house over
   time. It only changes the *display*. For players to become genuinely net-positive, the
   house has to actually give up a growing share of what it would otherwise keep — that must
   be an explicit, honest commitment, not implied by vault mechanics.
2. **Unbounded promises are unfundable.** If bonus size grows without bound as the vault
   grows without bound, there is a vault size at which the formula promises more than a
   single quiet round's rake can pay — a guaranteed underpayment. The fix is a bonus formula
   that *asymptotes* toward a cap, never scales linearly with vault size.

Real precedent for the discipline this needs: regulated progressive jackpots (Nevada Gaming
Reg. 5, Pennsylvania 58 Pa. Code §461a.12) require the pool be **fully funded before it is
advertised as available** — never a promise the operator hopes to cover later. The design
below keeps that same discipline: nothing is ever promised that isn't already, at that
moment, actually funded by same-round inflow.

## 3. The mechanism

### 3.1 Two vaults, not one

Earlier reasoning suggested one shared vault for crash + lottery, by loose analogy to
liquidity pooling. That analogy wasn't verified and doesn't hold up: the two games have very
different variance profiles (high-frequency/low-variance crash rounds vs. low-frequency/
high-variance lottery hits), and a shared pool means a shock or exploit on one game can
directly stall the other's growth. **Recommendation: keep `crashVaultWei` and
`lotteryVaultWei` as two separate, independently-tracked balances**, each following the same
rules below, with one addition — a **spillover rule** (§3.4) so success in one game still
accelerates the other's abundance, which is the actual thing the owner wants from "unified
economics," without coupling their risk.

### 3.2 The ratchet: vault balance only ever increases

Every round, a fixed slice of that round's **own net rake** — before it is routed by
`PlankRakeRouter` — is added to the relevant vault. This is the entire "never decreases"
guarantee: the vault is never debited by a payout. It is *only* ever credited. Concretely,
under the owner's proposed new rake split (§3.3), the vault's slice is exactly the "vault"
portion of the community share, credited via a new `creditVault()` call on `PlankCrash`/
`PlankLottery` (mirroring the existing `fundVault()` external-donation path already in
`PlankCrash.sol:662-667`, which stays as an *additional*, optional booster — sponsorships,
treasury seeding — on top of the guaranteed per-round trickle).

Invariant, checked on every write path that touches vault state:

```
vaultWei(t+1) >= vaultWei(t)   for all t
```

### 3.3 The rake split (owner's numbers)

Owner specified: **25% buy-and-burn, 69% vault + lottery, ~6% founders**, replacing the
current 40% burn / 40% community / 20% founders (`PlankRakeRouter.sol:38-40`).

| Leg | Current | Proposed | Change |
|---|---|---|---|
| Burn | 40% | 25% | −15pp — less permanent value destruction |
| Vault + lottery (was "community") | 40% | 69% | +29pp — this is the entire growth engine |
| Founders | 20% | 6% | −14pp |

At the current 4.50% rake (`CASINO_RAKE_BPS = 450`, `scripts/deploy-casino.ts:135`), on a
10,000-credit round:

| | Current split | Proposed split |
|---|---|---|
| Total rake | 450 | 450 |
| Burn | 180 | 112.5 |
| Vault + lottery pool | 180 | 310.5 |
| Founders | 90 | 27 |

**~72% more per round flowing into the growth engine**, at the cost of founders going from
2.0% of gross stakes to 0.27%, and burn dropping from 1.8% to 1.125% of gross stakes. This is
the real, numeric tradeoff the owner is making — flagged explicitly here rather than buried
in a bps constant, since it's a founder-economics decision as much as a player-economics one.

*(Open question for owner: how does the 69% further split between the crash vault and the
lottery vault? The existing `communityLotteryBps` pattern — currently 65% of the community
share to lottery on playtest tables, `PlankRakeRouter.sol:28` — is the natural place to
carry this forward. Needs a number before implementation.)*

### 3.4 The bonus formula — keyed to PARTICIPATION COUNT, not vault size

**Revised 2026-09-05, after owner feedback**: a vault-*size*-keyed curve (the original
framing below the line) has two real problems a size-keyed curve can't avoid: (a) it's
gameable — a single large deposit or coordinated push can jump the vault's balance and
unlock a materially bigger bonus tier in one shot, and (b) it structurally requires the
number to "get big" before it feels generous, which the owner explicitly does not want
("constant growth opportunities without growing minimum thresholds").

The fix, confirmed against real precedent (loyalty-program design, veTokenomics-style
engagement curves): key the curve to **how many distinct rounds have contributed to the
vault**, not the vault's dollar size. Every contributing round unlocks a real, immediately-
felt, non-shrinking-to-zero slice of headroom — from round 1 — and each subsequent round adds
a smoothly diminishing but never-zero amount. A single large one-off deposit (or `fundVault()`
donation) cannot buy its way up the curve; only sustained, repeated participation can.

```
roundsContributed = crashVaultRoundCount        // or lotteryVaultRoundCount
r = 0.999                                        // decay ratio -- how slowly the ratchet saturates
vaultBonusPct = maxVaultBonusPct × (1 - r^roundsContributed)
```

This is a geometric ratchet: `vaultBonusPct` starts at `maxVaultBonusPct × (1 - r)` on the
very first contributing round (a real, immediately meaningful, non-hardcoded floor of the
ceiling — see §3.4.1 for a worked number), rises with every subsequent round, and asymptotes
toward `maxVaultBonusPct` as `roundsContributed → ∞`. It never resets, never decreases
(`roundsContributed` only ever increments), and it responds to *activity*, not *accumulated
balance* — a whale cannot skip the line by depositing more.

The bonus itself is still funded fresh from that round's own rake, exactly as before, and
still hard-capped by what the round can actually afford — `vaultBonusPct` only ever decides
how much of the room already carved out by `houseRakeCapBps` gets used, it never creates new
room:

```
H_avail' = min(H, reserveAtLock × houseCapBps / BPS,
                  rakeWei × houseRakeCapBps / BPS,
                  rakeWei × vaultBonusPct / BPS)
```

Where `maxVaultBonusPct` is a ratified ceiling — **25%** (owner-confirmed) — on how much of
a round's rake the participation-count signal can ever unlock, however many rounds have
contributed. The vault's own balance (`vaultWei`) is *not* read anywhere in this formula —
it plays no role in sizing the bonus. Its only job (§3.2) is to be the permanent, monotonic
scoreboard of accumulated success — visible proof of the game's health — decoupled from the
mechanism that decides how generous today's round can be.

#### 3.4.1 Worked numbers (r = 0.999, maxVaultBonusPct = 25%)

| Rounds contributed | `vaultBonusPct` | % of ceiling reached |
|---|---|---|
| 1 | 0.025% | 0.1% |
| 100 | 2.38% | 9.5% |
| 500 | 9.84% | 39.4% |
| 1,000 | 15.81% | 63.2% |
| 2,000 | 21.62% | 86.5% |
| 5,000 | 24.83% | 99.3% |
| 10,000 | 25.00% | 100.0% |

(Verified by direct computation, not hand arithmetic — `25 × (1 - 0.999^n)` for each `n`.)

At 30-second launches (the manual's stated cadence, 120 rounds/hour at full tempo), 1,000
contributing rounds is under 9 hours of continuous play — the curve is already almost
two-thirds of the way to its ceiling well within the first day, and every round from round 1
onward visibly moves the needle. `r` is the one knob that controls this pace; 0.999 is a
starting proposal, not final — a smaller `r` (e.g. 0.995) reaches the ceiling faster, a
larger one (e.g. 0.9995) stretches the climb out longer.

### 3.5 Spillover — also participation-count-keyed

Once a vault's own `roundsContributed` passes a **spillover threshold** (a round-count, not a
dollar amount — e.g. once a vault is past ~90% of its own asymptote, around 3,000–4,000
rounds at `r = 0.999`), further contributing rounds for that game instead credit the *other*
game's `roundsContributed` counter. This is the actual "unified economics" mechanism: once
the crash game's own curve is essentially maxed out, its continued activity keeps
accelerating the lottery's curve too (and vice versa), without ever touching the other game's
vault *balance* or creating a shared-risk pool. This matches the owner's original
spillover-timing preference ("same order of magnitude as [the ramp-up scale]") — expressed
here in round-count terms as "same order of magnitude as the point where the curve is
already near-saturated," since the ramp-up scale is now `r` (§3.4), not a vault-size `K`.

### 3.6 Why this can never be exploited by timing or by size

Research flagged a real risk under the original vault-*size*-keyed framing: if vault size
(and therefore expected bonus) is publicly readable before betting closes, rational
players/bots would concentrate volume into high-vault rounds and skip low-vault ones —
potentially starving the low-vault periods of the very rake needed to keep growing, and a
single large deposit could jump the bonus tier in one shot.

The participation-count design (§3.4) closes both of these more thoroughly than a smoothed
read ever could:

1. **No size-based rush.** `vaultBonusPct` depends only on `roundsContributed`, a slow,
   monotonic counter that moves by exactly one per contributing round — there is no large
   one-time action (a whale bet, a coordinated push, a `fundVault()` donation) that jumps it.
   The bonus for the *next* round is always knowable in advance and never spikes.
2. **No "wait for it to be big" strategy.** Because the curve only ever *increases* and never
   resets, the correct rational strategy is unconditionally "play every round" — there is no
   round where sitting out is ever better than playing, and no round where rushing in ahead
   of others captures a disproportionate share the way a size-based jump would.
3. As an additional, cheap defense-in-depth measure (not load-bearing, since the curve itself
   is already timing-proof): still expose `roundsContributed`/the resulting bonus tier as a
   read taken at commitment-open, not recomputed mid-round, so the number a player commits
   against never moves under them during their own betting window.

## 4. Decisions (owner-confirmed 2026-09-05, "proceed with all recommended")

- ✅ `maxVaultBonusPct` = **25%** of a round's rake.
- ✅ Bonus curve is keyed to **participation count**, not vault balance (§3.4) —
  supersedes the original vault-size/half-saturation framing in §2 and §3.4's own history.
- ✅ `r` (decay ratio) = **0.999** (§3.4.1's proposed default) — curve ~63% saturated by
  1,000 contributing rounds (~9 hours of continuous play at full 30s-launch tempo), ~99.3%
  by 5,000 rounds.
- ✅ **Spillover threshold** = **4,000 rounds contributed** per vault — the point at
  `r = 0.999` where a vault's own curve is already at ~98.2% of `maxVaultBonusPct`
  (`25 × (1 - 0.999^4000) = 24.55%`, verified by direct computation). Past this point,
  further contributing rounds for that game credit the *other* game's `roundsContributed`
  instead — squeezing out the last ~1.8% of a maxed-out curve's own ceiling buys much more
  value by accelerating a still-climbing sibling curve than by chasing the last fraction of
  a percent on a curve that's already effectively full.
- ✅ **Split of the 69% vault+lottery share between crash-vault and lottery-vault**:
  mirrors the existing, already-ratified `communityLotteryBps` pattern exactly —
  **65% to the lottery vault, 35% to the crash vault**, same ratio this codebase already
  uses for the community share on playtest tables (`PlankRakeRouter.sol:28`). Reusing an
  already-audited ratio here, rather than inventing a new one, keeps the number of genuinely
  new judgment calls in this design to a minimum.

### 4.1 `fundVault()` and the participation counter — the exploit check

**Owner's request: let external `fundVault()` donations count toward `roundsContributed`,
but only if that cannot be exploited in any way.** It cannot be allowed unconditionally: a
donation costs only gas plus whatever amount the caller chooses to send (down to any
`msg.value > 0`), and `fundVault()` today is fully permissionless
(`PlankCrash.sol:662-667`) with no rate limit. Without a real constraint, a single actor
could call it in a tight loop — e.g. 4,000 donations of 1 wei each, well within one block's
gas budget spread across a handful of transactions — and race `roundsContributed` straight
to the spillover threshold with no real play at all. That is exactly the "buy your way up
the curve" exploit the participation-count design exists to prevent (§3.4), so an
unconditional yes would quietly reopen the hole this whole mechanism was built to close.

**The safe version — a donation counts, but at most once per real round, same as organic
play:**

```
// ONE shared "last credited round" per vault, checked by BOTH the organic
// per-round rake credit AND fundVault() -- whichever happens first in a
// given round claims that round's +1, the other is a no-op on the counter
// (though a fundVault() donation's ETH still lands in vaultWei either way).
if (currentRoundId != lastRoundCounted[vault]) {
    roundsContributed[vault] += 1;
    lastRoundCounted[vault] = currentRoundId;
}
```

This one shared gate — not a separate one for organic play vs. donations — closes the
obvious follow-up question: could a round that already incremented the counter via real play
be double-counted by a same-round donation? No, because both paths check and set the exact
same `lastRoundCounted[vault]`, so whichever happens first in a round wins that round's single
+1 and the other is inert on the counter (the donated ETH still lands in `vaultWei`
regardless, per §3.2). A donation can only ever advance the counter by the same +1-per-round
rate that organic play already does — it can never move faster than real time and real
rounds allow, however many times `fundVault()` is called within a single round, and however
large or small each donation is. This makes it genuinely unexploitable: the counter's rate of
advance is capped at exactly one per round no matter what, so the only way a donor can
meaningfully move `roundsContributed` faster than organic play would anyway is by *waiting
for* real rounds to pass — which is not an exploit, it's just time.

## 5. Implementation reconnaissance (2026-09-05) — two things already exist

Reading the real, current contracts before writing code surfaced two load-bearing facts that
change *how* this gets built, not *what* it delivers:

### 6.1 `PlankCrash.protectedPrincipal` is already the monotonic vault

`protectedPrincipal` (`PlankCrash.sol:199`) is credited only, via `fundCommunityReturn()`
(the router's community-return leg) and never decremented anywhere in the contract — confirmed
by direct grep: zero `protectedPrincipal -=` sites exist. Its own docstring already states the
exact invariant this spec calls for: "a monotone floor inside it — credited, never spent"
(`PlankCrash.sol:59`). **This means §3.2's "genuinely new monotonic vault state" is not new
state to invent — it's already live, audited, and correct.** The real remaining crash-game
work is: (a) route the new rake-split vault leg (§3.3/§4) into `protectedPrincipal` growth
the same way the existing community-return leg does, and (b) add the genuinely new piece —
`roundsContributed` (a counter, not a balance) and the participation-count bonus curve
(§3.4) that reads it, threaded into `PlankCcs2LMath.sol`'s house layer.

### 6.2 `PlankLottery` already has an equivalent saturating mechanism — adapt it, don't parallel it

`PlankLottery.carve()` (`PlankLottery.sol:234-240`) already implements the exact same family
of formula this spec proposed for the crash game: `x(P) = xMin + (xMax - xMin) × P/(P+c)`,
controlling how much of the pool `P` goes to the winner vs. reseeds the next board. It is
already audited (proven exact conservation `W + S == P`, and monotonicity
`S(P+1) - S(P) <= 1`) and already pool-size-keyed, not count-keyed.

Per owner direction: **adapt this existing formula rather than bolt a parallel
participation-count mechanism onto the lottery.** The chosen adaptation preserves the formula
exactly (so every existing proof still applies unchanged — verified by direct computation
that monotonicity and exact conservation hold for any positive `c`, not just the current
fixed constant) and instead makes the **half-saturation constant `c` itself GROW as
participation accumulates**.

**Correction made during implementation (2026-09-05):** an earlier draft of this section
proposed *shrinking* `c` toward a floor. Direct computation against the real `carve()`
formula caught this as backwards: `x(P) = xMin + (xMax − xMin) × P/(P+c)` is *decreasing* in
`c` — a **larger** `c` pushes `x` toward `xMin` (less reseeded, more to the winner), and a
**smaller** `c` pushes `x` toward `xMax` (more reseeded, less to the winner). Shrinking `c`
therefore would have made the winner's take *fall* as participation grew — the opposite of
the intended "the game pays more as it matures." The design below grows `c` instead, verified
correct by direct computation before it was implemented in `PlankLottery.sol`.

```
roundsContributed = lotteryRoundCount
r = 0.999                                          // same decay ratio as the crash-game curve
cEffective = cCeiling − (cCeiling − cBase) × r^roundsContributed
```

Where `cBase` is today's ratified `carveHalfSaturationWei` (unchanged as the starting value —
**a brand-new deployment behaves identically to today, no regression**: at
`roundsContributed = 0`, `r^0 = 1` and `cEffective = cBase` exactly), and `cCeiling` is a
ratified ceiling `c` grows toward (worked example below uses 10× base). As participation
grows, `c` rises toward `cCeiling`, which means the *same* pool size `P` produces a *larger*
winner payout than it would have earlier — real, growing generosity from sustained play,
expressed through the mechanism this game already has and already trusts, not a second one
bolted alongside it.

Verified by direct computation: `cEffective` depends **only** on `roundsContributed`, never
on `P` or on any single funding transaction's size — a whale funding a huge pool in one shot
moves `P`, not `c`, and gets exactly the standard curve at whatever participation level
already stands. This closes the same "buy your way up the curve" exploit the crash-game
design closes, using the lottery's own existing, audited formula shape.

Worked numbers (`r = 0.999`, `cBase = 250,000` credits — today's ratified value, `cCeiling =
2,500,000`, 10× base):

| Rounds contributed | `cEffective` (credits) | Winner take on a 5 ETH prize |
|---|---|---|
| 0 | 250,000 | 3.5476 ETH (today's exact behavior) |
| 100 | 464,217 | 3.5850 ETH |
| 500 | 1,135,647 | 3.6851 ETH |
| 1,000 | 1,672,685 | 3.7507 ETH |
| 2,000 | 2,195,800 | 3.8052 ETH |
| 4,000 | 2,458,872 | 3.8297 ETH |
| 10,000 | 2,499,898 | 3.8333 ETH (essentially at the ceiling) |

(Verified by direct computation, not hand arithmetic — cross-checked against the deployed
`PlankLottery.sol`'s own `effectiveHalfSaturationWei()`/`carve()` in
`test/contracts/PlankLottery.test.ts`'s "v3 participation-count carve adaptation" suite.)
`roundsContributed` for the lottery advances by exactly one per real, distinct `roundId` that
`recordRound()` receives from `PlankCrash` (the only caller `source` authorizes) — a donation
via `fund()` has no `roundId` to gate on and therefore can **never** advance this counter on
its own, at any size, any number of times: only a genuinely new settled crash round can.

## 6. What this spec deliberately does NOT change

- The existing negative-sum-by-rake identity for a *single, isolated* round with no vault
  bonus — that stays exactly as audited and proven in `PlankCcs2LMath.sol`'s own theorems.
- The "vault never decreases" invariant is absolute: nothing in this design ever reads
  `vaultWei` as a spendable balance, only as an input to a bounded formula.
- No change to drand-based randomness or settlement mechanics — this is purely an additive
  bonus-sizing layer on top of the existing, audited house-layer pattern.
