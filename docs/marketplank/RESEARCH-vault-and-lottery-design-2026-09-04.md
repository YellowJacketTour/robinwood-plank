# RESEARCH — Is the reset-reserve design the best way to execute the vision for the Vault and the Powerboard lottery?

Date: 2026-09-04 · Analysis only — **no code, config, or economics were changed by this document.**
Working tree: `C:\tmp\robinwood-sync-fix2`

Owner's question, verbatim: *"deeply research if this is the best way to execute on my vision for vaults purpose and lottery designs."*

Asked immediately after observing: **the prize sits sealed at 150,000 credits and does not grow, no ball is ever drawn, while the Vault visibly climbs every round — even though the UI says each flight is "funding" things.**

**Headline verdict, stated once and up front:**

> **What the owner saw is a presentation defect, not a stalled lottery.** It is a **post-hit
> blackout of bounded length** (~3.2 hours at his table) that the interface **actively
> mis-describes**: the Powerboard popover shows a progress bar against a gate that cannot fire
> and never displays the number that actually gates the draw — even though the engine computes
> that number correctly and the Economy panel already shows it. **That fix requires no economic
> change at all.**
>
> **Separately, the owner's own instinct — "x% of the lottery seeds the next lottery" — is the
> better design, and this report recommends adopting it.** It is simpler, ~2.7x faster at every
> table size, preserves conservation and zero house exposure exactly, and has direct regulated-
> gaming precedent. It requires the display law (Part 7) as a hard prerequisite, and a **bounded
> base**, without which the cadence still diverges.
>
> Two further gaps: the ratchet is **unbounded**, and the `mustHitByEpochs` "can never roll
> forever" guarantee promised in the architecture doc **is not implemented in the live engine at
> all**.

---

## PART 1 — The vision, in the owner's own words

### What the LOTTERY is for

`PRODUCT.md` — Product Purpose:

> "It exists to turn play into two compounding public goods: rake buys and burns real
> $PLANK, and rake funds a community lottery **whose prize can only grow**."

> "Success is a table that runs continuously and honestly: ... and a lottery that
> **measurably approaches — and reaches — a real payable draw**."

`PRODUCT.md` — Positioning, mechanism 3:

> "**A built-in lottery any player can win on a minimum bet.** 40% of rake funds a community
> prize. Ticket weight follows stake, but the draw is 1-in-16 from committed randomness with
> a proportional winner selection, so **a minimum-stake player holds a real, non-zero,
> provable chance at the full sealed prize**."

`PRODUCT.md` — Constraints:

> "**Guaranteed lottery reset.** A draw is only possible once the prize *and* its reset
> reserve are sealed, and the prize base never decreases. **This must always be communicated,
> including while the prize is still funding.**"

> "**Displayed == redeemable honesty.** ... No component may display a total whose parts sum
> short, and operator/founder earnings are never shown to players."

### What the VAULT is for

`PRODUCT.md` — Terminology:

> "**Vault (protected principal)** — a reserve that **only grows**, funded from routed rake."

`docs/CASINO-ARCHITECTURE.md` §9, title and body:

> "**The Vault — a never-zero prize reserve that recycles the rake it keeps**"

> "a persistent prize reserve that is **mathematically incapable of reaching zero or going
> negative**, no matter how much players win — and that, after its bootstrap, only ever seeds
> out of rake it has itself taken in. **It is not a subsidy engine and it is not a progressive
> pot that grows without limit; it is a rake rebate with a bankroll behind it.**"

> "The Vault's **only** debit is this fractional seed; **winners are paid from the round pool,
> never from the Vault**, so no sequence of wins ever touches it."

`docs/CASINO-ARCHITECTURE.md` §10:

> "the rake carve fills the Vault first (short-cycle, per-game prizes) and, once it's full,
> everything above the cap flows to the jackpot (long-cycle, daily prize). ... **Vault first,
> jackpot gets the steady overflow**"

> "**'Must be won' — the guaranteed jackpot.** ... `mustHitByEpochs` adds the real-lottery
> 'Must Be Won' mechanic: if the jackpot hasn't paid for that many epochs, the next drawn
> epoch (with participants) **force-pays the entire jackpot regardless of the ball**. ... So:
> someone wins a consolation every epoch there are players, and **the full jackpot is
> guaranteed to pay out at least every `mustHitByEpochs` epochs — it can never roll forever.**"

### Do the two documents disagree? — Yes, in three places

**1. The Vault's role.** `PRODUCT.md` calls the Vault "a reserve that **only grows**" — a
monotone store of value. `CASINO-ARCHITECTURE.md` §9 explicitly **withdraws** that framing:

> "The earlier `R* = c·P/α`, always-compounding, un-emptyable progressive pot description was
> the pre-hardening formula and **is withdrawn**: the pot does not compound off a release
> fraction, **it recycles income**."

PRODUCT.md's terminology entry is the pre-hardening language. **The architecture doc is later
and more accurate.** In the live engine both readings are true of *different fields*:
`protectedPrincipal` only grows (asserted at `simulation.ts:422`), while `emissionBuffer`
recycles — credited from rake, then debited every round as the `crashSeed`.

**2. The cascade.** §10 presents the Vault→lottery overflow as the mechanism that restores
jackpot funding. It exists in the live engine (`simulation.ts:388-391`) but is **not
load-bearing at playtest volume** — see §2.6.

**3. "Must be won".** §10 promises a forced payout making an unbounded roll impossible.
**`mustHitByEpochs` appears in `contracts/PlankPowerboard.sol` and its tests, and in NO file
under `lib/`.** The live playtest simulation the owner is watching has **no must-hit-by
mechanic whatsoever**. The guarantee is real on-chain and absent off-chain. This is the gap
between the promised design and the running one.

---

## PART 2 — What the code actually does

### 2.1 The rake split, per round

`economics.ts:165-185`, `simulation.ts:333-391`. For a pot `P` at effective rake `r` bps:

```
rake       = P − floor(P·(10000−r)/10000)
burn       = floor(rake·4000/10000)              -> buys and burns $PLANK
community  = floor(rake·4000/10000)
founders   = rake − burn − community             (~20%, never shown to players)

PRIZE      = floor(community · powerboardFundingBps/10000)   65%  -> lottery.pendingFunding
retained   = community − PRIZE                               35%
principal  = floor(retained · protectedPrincipalBps/10000)   50% of retained -> protectedPrincipal
buffer     = retained − principal                            50% of retained -> emissionBuffer
```

Live constants (`playtest-room-core.ts:7-38`): `rakeBps 450` declining 25 per 25M qualified
volume to floor `250`; `powerboardFundingBps 6_500`; `protectedPrincipalBps 5_000`;
`lotteryFounderFeeBps 1_000`; `lotteryInitialBase 50_000`; `lotteryMinimumIncrease 50_000`;
`lotteryBaseGrowthBps 500`; `lotteryMinimumBaseStep 50_000`; `minimumStake 500`;
`emissionBufferCap 1_000_000`; `crashSeed 10_000`.

**Credits per round, derived (rake 450 bps):**

| pot | rake | burn | community | **PRIZE** | principal | buffer | ops |
|---|---|---|---|---|---|---|---|
| 1,000 | 45 | 18 | 18 | **11** | 3 | 4 | 9 |
| 5,000 | 225 | 90 | 90 | **58** | 16 | 16 | 45 |
| 10,000 | 450 | 180 | 180 | **117** | 31 | 32 | 90 |
| 20,000 | 900 | 360 | 360 | **234** | 63 | 63 | 180 |
| 35,500 | 1,598 | 639 | 639 | **415** | 112 | 112 | 320 |
| 60,000 | 2,700 | 1,080 | 1,080 | **702** | 189 | 189 | 540 |
| 130,000 | 5,850 | 2,340 | 2,340 | **1,521** | 409 | 410 | 1,170 |

**The prize receives 117 bps — 1.17% — of every pot.** The 35,500 row reproduces the
639-credit community figure independently observed in
`AUDIT-lottery-funding-eligibility-draw-2026-09-03.md` (round 1), confirming this derivation
against real runtime data rather than only against the source.

A realistic table — 2 to 13 players staking 500 to 10,000 credits — gives pots of roughly
1,000 to 130,000, i.e. **11 to 1,521 credits per round to the prize**. A 20,000-credit pot
(4 players x 5,000) giving **234 credits/round** is the reference case below.

### 2.2 The two gates

**Gate 1 — `sealFromFunding()` (`simulation.ts:221-244`).** Runs only while `awaitingSeal`.
Requires `rollover + pendingFunding >= minimumLotteryGross(nextPrizeTarget)`.
`minimumLotteryGross(n, 1000bps)` (`economics.ts:203-215`) is the exact integer inverse of the
10% founder fee: `minGross(50,000) = 55,555`; `minGross(150,000) = 166,666`;
`minGross(200,000) = 222,222`. On success the prize seals and `awaitingSeal = false`.

**Gate 2 — `fundResetReserve()` (`simulation.ts:246-257`).** Runs only when **not**
`awaitingSeal`. Moves pending into `resetReserve` until it covers
`minimumLotteryGross(nextCycleBase(cycleBase))` — the gross for the **next, larger** base.
**`readyForDraw` becomes true only when that is fully covered**, enforced as a runtime
invariant at `simulation.ts:428-431` ("draw exposed without reset coverage").

`nextCycleBase()` (`simulation.ts:212-219`): `base + max(floor(base·500/10000), 50,000)` —
**+5% or +50,000, whichever is LARGER**, monotonically, forever.

### 2.3 The owner's exact state, decoded

A prize sealed at 150,000 implies `cycleBase = 150,000`, `netPrize = 150,000`,
`awaitingSeal = false`.

- Sealing that prize already consumed **166,666** gross from pending.
- `nextCycleBase(150,000) = 200,000`.
- **The draw is gated on `resetReserve >= minimumLotteryGross(200,000) = 222,222`.**
- At 234 credits/round that is **950 rounds, about 3.2 hours** at a 12-second cadence, during
  which **no ball can be drawn for value**, regardless of what any player does.

At other table sizes the same gate takes: 20,202 rounds (~2.8 days) at a 1,000 pot; 3,831
rounds (~12.8 h) at 5,000; 317 rounds (~1.1 h) at 60,000; 146 rounds (~0.5 h) at 130,000.

### 2.4 The presentation defect — the heart of what the owner actually saw

After a hit, `simulation.ts:296` sets `nextPrizeTarget = netPrize`. The cockpit popover
(`public/arcade/crash.html:3772`) renders:

```
"Funding toward next seal"  ->  available / minimumLotteryGross(nextPrizeTarget)
                            ->  available / 166,666
```

But `sealFromFunding()` **returns immediately in this state** (`awaitingSeal` is false), so
**that bar measures a gate that cannot fire, and completing it would accomplish nothing.**

The number that actually gates the draw — **222,222** — is **never displayed as a target** on
this surface. `resetReserve` is rendered as a **bare number with no denominator**, both here
(`crash.html:3773`) and in the lab panel (`GameLaboratory.tsx:276`).

**An important correction, in fairness to the codebase:** `lib/casino/economy-report.ts:65-95`
(`lotteryActivationQuote`) computes all of this **correctly**, including the sealed case
(`requiredGross = 0` when not awaiting seal), and exposes `remaining`, `requiredTotal`,
`roundsToActivation` and `secondsToActivation`. The **Economy panel** (`crash.html:5686`)
renders it correctly. **The engine and one surface are right; the Powerboard popover — the
surface a player actually taps to ask "why is the prize not moving?" — recomputes its own wrong
denominator locally instead of using the correct quote already in the snapshot.** The fix is
therefore small and low-risk: use the value that already exists.

> **The player sees: a prize frozen at 150,000; a "funding" progress bar against 166,666 that
> does nothing; and a "Protected reset reserve" number silently climbing toward an undisplayed
> 222,222.**

The mechanism is working exactly as specified. **The interface is telling the player a false
story about it.** This directly violates the PRODUCT.md constraint that the guaranteed reset
"**must always be communicated**", and it is the proximate cause of the owner's question.

### 2.5 The blackout is post-HIT, not permanent — and misses are cheap

Reading `applyLotteryOutcome()` closely reveals an asymmetry that changes the whole diagnosis:

- **On a MISS** (`simulation.ts:269-283`): `resetReserve` is **not touched**. It is retained in
  full. The prize re-seals at a higher target from pending, and because the reserve is already
  full, the next draw arms **as soon as the re-seal completes**.
- **On a HIT** (`simulation.ts:286-303`): `resetReserve` is **consumed** to become the new
  prize and reset to zero, then must be rebuilt from scratch against the *next-next* base.

**So the blackout is a mandatory cooldown after every jackpot payment**, of length
`minimumLotteryGross(nextCycleBase) / prize-per-round` rounds. It is not a permanent stall,
and rolling misses do not compound it. The owner is inside a normal post-hit cooldown — but
nothing in the UI says so, and there is no countdown.

### 2.6 Does the Vault compete with the lottery? — Yes, by explicit and very recent decision

Of every 360 community credits at a 20,000 pot, **234 (65%) go to the prize and 126 (35%) go
to the Vault side**. This was a deliberate owner decision on 2026-09-03, recorded in the code
comment at `playtest-room-core.ts:16-20` and in `RATIFICATION-ccs2l-2026-09-02.md:135`:
`powerboardFundingBps` was cut from 10,000 to 6,500 specifically **"so the vault visibly
compounds"**.

**That decision is the direct cause of the phenomenon the owner is now unhappy about.** The
same 222,222 gate takes **950 rounds at 6,500 bps but only 617 rounds at 10,000 bps** — the
change made every draw **35% slower**, and it made the Vault climb visibly on exactly the
rounds where the prize appears frozen. The owner asked why the Vault grows while the prize
does not; the arithmetic answer is that 35% of the prize's fuel was redirected into the Vault
two days earlier.

The direction was intended. The **arm-time consequence was not computed at the time**. Note
also that `protectedPrincipal` is monotone and never spent (`simulation.ts:422`) — those
credits never return to the prize by any path.

**The cascade is not a mitigation at this scale.** The `emissionBuffer -> pendingFunding`
overflow (`simulation.ts:388-391`) fires only above `emissionBufferCap = 1,000,000`. The
buffer receives ~63 credits/round from retention while being debited up to `crashSeed =
10,000`/round; at playtest volume it is nowhere near the cap. **The "Vault first, jackpot gets
the overflow" story of CASINO-ARCHITECTURE §10 is currently inoperative** — the Vault takes
its 35% and returns nothing.

### 2.7 The ratchet over 20 cycles

Total credits that must flow through the prize leg to arm cycle *n* (seal gross + reset
reserve gross), and time at 234 credits/round, 12-second rounds:

| cycle | base | seal gross | reset reserve req. | **total needed** | rounds | hours |
|---|---|---|---|---|---|---|
| 1 | 50,000 | 55,555 | 111,111 | 166,666 | 712 | 2.4 |
| 2 | 100,000 | 111,111 | 166,666 | 277,777 | 1,187 | 4.0 |
| 3 | 150,000 | 166,666 | 222,222 | 388,888 | 1,662 | 5.5 |
| 4 | 200,000 | 222,222 | 277,777 | 499,999 | 2,137 | 7.1 |
| 5 | 250,000 | 277,777 | 333,333 | 611,110 | 2,612 | 8.7 |
| 8 | 400,000 | 444,444 | 499,999 | 944,443 | 4,036 | 13.5 |
| 10 | 500,000 | 555,555 | 611,111 | 1,166,666 | 4,986 | 16.6 |
| 15 | 750,000 | 833,333 | 888,888 | 1,722,221 | 7,360 | 24.5 |
| 20 | 1,000,000 | 1,111,111 | 1,166,666 | 2,277,777 | 9,734 | 32.4 |

Cumulative over 20 cycles: **24,444,423 credits, about 104,463 rounds, about 14.5 months** of
continuous 12-second play at a 20,000-credit pot.

**The +5% step only overtakes the +50,000 floor at cycle 20** (base 1,050,000). Therefore:

- **Cycles 1–20 (arithmetic phase):** the base grows by a constant 50,000, so time-to-draw
  grows **linearly** — cycle *n* takes roughly *n* times as long as cycle 1.
- **Cycle 20+ (geometric phase):** the base grows x1.05 per cycle, so time-to-draw grows
  **geometrically at 5% per cycle, without bound.** Base at cycle 100 is **52,039,103**; at
  cycle 200, **6,843,206,281**.

---

## PART 3 — The structural tension, stated honestly

### 3.1 What the rule genuinely buys — stated as strongly as it deserves

The reset-reserve rule delivers three things that are **rare and valuable**, and that most
crypto casinos conspicuously do not have:

1. **A win never empties the board.** The instant a jackpot is paid, the successor prize
   already exists in full, in segregated funds. There is no "prize resets to zero, come back
   next week" cliff — the single most common progressive-jackpot disappointment.
2. **No unbacked liability, ever.** Every credit displayed as a prize is already collected.
   This is precisely the `displayed == redeemable` constraint, *mechanized* rather than
   promised. `assertSimulationInvariants` makes it a runtime invariant, not a policy.
3. **Zero house exposure.** The house never fronts a prize and never needs a bankroll to cover
   the lottery. Solvency is structural, not managed.

**These are worth protecting. No recommendation below weakens any of them.**

### 3.2 The cost

- **Does time-to-draw grow without bound?** **Yes.** Linearly for 20 cycles, then
  geometrically at +5%/cycle forever. There is **no stable equilibrium at constant volume**;
  the mechanism asymptotically stops drawing.
- **What volume growth holds cadence constant?** In the geometric phase, **+5% per cycle,
  compounding, forever.** In the early phase the requirement is far harsher: **+100%** for
  cycle 2, **+50%** for cycle 3, **+33%** for cycle 4, **+25%** for cycle 5. **A table with
  flat volume gets a strictly worsening draw cadence from the very first cycle.**
- **Is there a stable equilibrium?** No. Prize funding is proportional to volume; the
  requirement grows regardless of volume. Volume is bounded by the player base; the base is
  not. That is the entire tension in one sentence.
- **Does it still honour "any player can win on a minimum bet"?** The *probability* claim
  survives exactly — weight is linear in stake and the 1-in-16 ball is honest (verified 14/14
  in the 09-03 forensic audit). But **the claim is about a real opportunity, not merely a
  ratio.** A minimum-stake player whose session is shorter than the arm-time has a **zero**
  chance, because no draw occurs at all during their visit. As cycles advance, the fraction of
  players who ever witness a live draw tends to zero. **The positioning degrades from true, to
  true-but-vacuous, to false in fact** — even though every displayed number stays honest.

### 3.3 The precise diagnosis

**The reset guarantee is not what is broken. The unconditional ratchet is.** These are two
separable rules currently welded together:

- *"A draw requires the next prize to be pre-funded"* — **sound; keep it.**
- *"The next prize is unconditionally 50,000 larger, forever, regardless of whether the economy
  can fund it"* — **this is the unbounded term**, and **nothing in PRODUCT.md requires it.**
  PRODUCT.md requires only that **"the prize base never decreases."** A base that stops
  growing has not decreased.

That distinction is the hinge of this entire report.

---

## PART 4 — State of the art

Evidence labels: **PROVEN** (primary regulatory/legal text or primary document quoted),
**PEER-REVIEWED** (published academic), **INDUSTRY-STANDARD** (trade/testing-lab/operator
practice), **JUDGMENT** (inference; no primary source found). All URLs accessed **2026-09-04**.

### 4.1 Progressive jackpot design in regulated gaming

**The single most important finding of this research, and it is a negative one:**

> **No regulator requires 100% pre-funding of the next reset before a payout is permitted.**
> The search was made specifically for such a mandate and found the opposite pattern
> everywhere: disclosure requirements, plus discretionary bankroll reserves, plus
> *parallel-accrual* reset funding.

- **UK Gambling Commission, Remote Gambling and Software Technical Standards, RTS 9
  "Progressive jackpot systems."**
  https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-9-progressive-jackpot-systems
  RTS 9A verbatim: *"An explanation of the jackpot rules must be clearly available to the
  customer before they commit to gamble."* Implementation guidance requires the rules to state
  *"how it is funded, what the start-up seed and any ceiling values are"*, how contributions
  are handled at a ceiling (e.g. *"redirected overflow or reserve pools"*), and that players
  are *"adequately notif[ied] of reset values"* after a win. RTS 9B requires jackpot systems be
  *"configured and operated with adequate fairness and security."*
  **PROVEN.** Note carefully: RTS 9 mandates **disclosure** of the seed and its funding, and
  recognises overflow/reserve pools — it does **not** mandate that the reseed be pre-funded.
  *Plank's rule is stricter than any regulator requires; its disclosure is weaker than RTS 9
  would require.* That inversion is this report's central regulatory observation.

- **Nevada Gaming Control Board — Technical Standard 1; Regulation 5; Reg. 6.150 minimum
  bankroll.** https://www.gaming.nv.gov/siteassets/content/regs/technical-standard-1.pdf ,
  https://www.gaming.nv.gov/siteassets/content/divisions/audit/2017bankroll-instructions-operator.pdf
  Nevada defines a **"reset fund"** as *"monies collected pursuant to a contribution schedule
  set by an operator that are intended to be used for the funding of future progressive payoff
  schedules"* — the reseed is an explicitly named, contribution-funded pool. The Chair *"may
  require the licensee to at all times maintain a reserve ... in an amount determined by the
  Chair."* **PROVEN** for the definition and the reserve power. Crucially, that reserve is
  **discretionary and administratively sized, not a fixed 100%-of-next-reset mandate.**

- **US Patent 9,830,777 B2, "Gaming systems for funding jackpots"** (Yoseloff et al., Bally /
  LNW Gaming, issued 2017-11-28). https://patents.google.com/patent/US9830777B2/en
  Verbatim: *"In order to soften the blow of funding the seed money, a hidden meter is provided
  that simply increments a predetermined amount with each wager made."* On a hit, *"the seed
  amount is transferred from the hidden meter to the progressive meter."*
  **PROVEN.** **This is the industry's actual answer to Plank's exact problem: a second,
  parallel accumulator funded from the same wager stream, drained into the visible meter the
  instant a jackpot pays — so the visible prize resets instantly and the draw never stalls.**
  Plank already has this component: it is called `resetReserve`. The difference is purely one
  of *sequencing* — Plank blocks the draw until the reserve is full; the industry lets the draw
  proceed and lets the reserve fill in parallel, carrying the residual on the house account.

- **US Patent 8,740,692 B2, "Variable contribution progressive jackpots."**
  https://patents.google.com/patent/US8740692B2/en
  Worked examples split coin-in, e.g. **0.5% funding the visible progressive and 0.5% held in
  reserve** (versus a *"usual 1.0%"* all-visible), with the explicit consequence that a smaller
  reserve share yields a smaller next reset. **INDUSTRY-STANDARD.** This is direct precedent
  for a *fractional* reserve split — alternative (b) below.

- **GLI-12, "Progressive Gaming Devices in Casinos," v2.1 / v3.0** (Gaming Laboratories
  International). https://gaminglabs.com/wp-content/uploads/2026/01/GLI-12-v3-0-FINAL.pdf
  The governing progressive standard (not GLI-11, which covers gaming devices generally).
  For **mystery-triggered** progressives, the trigger threshold may only be reselected within
  the range of the current jackpot value up to the ceiling — i.e. the must-hit-by ceiling is a
  hard upper bound. **INDUSTRY-STANDARD.** *Honesty flag: both PDFs are compressed binary and
  verbatim section-numbered clauses could not be extracted; open locally if quotable clause
  numbers are needed.*

- Typical wide-area progressive contribution rates of ~1–3% of wager are widely cited in trade
  press, but **no regulator mandates a rate**. **JUDGMENT.** (For reference, Plank's prize leg
  is 1.17% of pot — squarely inside that band.)

### 4.2 Rollover lottery economics and draw frequency

- **Cook, P.J. & Clotfelter, C.T., "The Peculiar Scale Economies of Lotto,"** *American
  Economic Review* 83(3), 1993, 634–643; NBER WP 3766. https://www.nber.org/papers/w3766
  Verbatim: *"The best-selling lottery game in the United States is lotto, a parimutuel game of
  long odds and large jackpots... there is a strong tendency for per-capita lotto sales to
  increase with the size of the population base."* The mechanism is decisive here: **players
  judge the likelihood of winning by the observed frequency with which someone wins.**
  **PEER-REVIEWED.** **This is the single most load-bearing citation in this report.** It is
  the primary academic statement that **visible win frequency — not true odds — governs
  participation**, which is exactly the quantity Plank's ratchet drives toward zero.

- **Clotfelter & Cook, *Selling Hope: State Lotteries in America*,** Harvard UP, 1989/1991.
  https://www.hup.harvard.edu/books/9780674800984 — **PEER-REVIEWED** (monograph; background).

- **Combs, K.L. & Spry, J.A., "The sales effects of Powerball and Mega Millions game
  redesign,"** *Applied Economics* 57(29), 2025, 4083–4097.
  https://www.tandfonline.com/doi/abs/10.1080/00036846.2024.2348180
  Drawing-by-drawing US sales 2010–2019 across redesigns that lengthened odds and **raised the
  minimum starting jackpot**. Finding: the redesign **lowered the elasticity of sales revenue
  with respect to jackpot size** while raising the average jackpot — **quantified jackpot
  fatigue**, and documentation that raising the starting jackpot is a deliberate roll-length
  management lever. **PEER-REVIEWED.**

- **Compiani, Magnolfi & Smith, "An Equilibrium Model of Rollover Lotteries,"** BFI WP 2024-34.
  https://bfi.uchicago.edu/wp-content/uploads/2024/03/BFI_WP_2024-34.pdf
  Log ticket sales grow **convexly** in log jackpot up to ~$409M; **optimal lottery odds scale
  linearly in population.** **PEER-REVIEWED** (working paper). The second result is the formal
  statement of Plank's problem: *the correct jackpot scale is a function of the player base, so
  a base that ratchets independently of the player base is mis-specified by construction.*

- **Jackpot fatigue in operator practice** — Ohio Lottery / North Carolina Education Lottery via
  PlayUSA and Charlotte Ledger, 2023–2026.
  https://www.playusa.com/news/jackpot-fatigue-dulling-mega-millions-and-powerball-sales-ohio-lottery-says/
  North Carolina same-day Mega Millions sales fell from **$10.1M at an $830M jackpot (July 2022)
  to $3.7M at an $820M jackpot a year later** — a ~63% handle collapse at essentially the same
  advertised prize. **INDUSTRY-STANDARD.**

- **Draw frequency.** Powerball added a third weekly drawing in Aug 2021 explicitly to build
  bigger jackpots faster. *Honesty flag: no clean peer-reviewed causal estimate of draw
  frequency -> participation in isolation was found. Treat "more draws = more participation" as
  **JUDGMENT**, not established.*

### 4.3 Crypto / on-chain prize designs

- **PoolTogether V5 Protocol Design — Prize Pool.**
  https://dev.pooltogether.com/protocol/design/prize-pool/
  Verbatim: *"Prize liquidity comes from prize vaults; each vault liquidates its yield for the
  prize token, then contributes the prize token to the Prize Pool."* Draws are **daily**.
  Prizes span **4 to 11 tiers** with prizes per tier `p = 4^t`, so *"Tier 0 is the infrequent
  grand prize, and the highest standard prize tier is the most common prize: **occurring every
  single draw**."* A `grandPrizePeriod` parameter (e.g. 365 with daily draws) sets grand-prize
  frequency. **Canary tiers** self-tune: *"The first canary tier is expected to be claimed every
  draw, if it isn't then the next draw will have one less tier than before... If it is claimed,
  then the next draw will have one more tier."*
  **PROVEN.** **This is the closest existing design to a never-stalling prize draw, and it is
  directly relevant to a "Vault" whose purpose is to only grow:** principal is never spent, only
  yield is, so the draw is *structurally* unstallable; and the tier system auto-adjusts prize
  granularity to available liquidity **rather than letting the draw fail.** Note the honest
  caveat in their own docs: prizes are currently partly treasury-incentivized, *"until we reach
  full sustainability"* — it is not yet purely yield-funded.

- **Kearney, Tufano, Guryan & Hurst, "Making Savers Winners: An Overview of Prize-Linked
  Savings Products,"** NBER WP 16433, 2010. https://www.nber.org/papers/w16433
  PLS accounts *"distribute periodic sizeable payments to some investors using a lottery-like
  drawing where an investor's chances of winning are proportional to one's account balances."*
  **PEER-REVIEWED.**

- **Atalay, Bakhtiar, Cheung & Slonim, "Savings and prize-linked savings accounts,"** *JEBO*
  107(A), 2014, 86–106. https://www.sciencedirect.com/science/article/abs/pii/S0167268114002194
  Introducing PLS accounts **increased total savings and significantly reduced lottery
  expenditure**, especially among the lowest-savings participants. **PEER-REVIEWED.**

- **Save to Win — 2009 Final Project Results** (Michigan Credit Union League / Filene / D2D).
  https://www.lcc.mn.gov/inactive/ladder/ADworkgroup/SavetoWin2009Report.pdf
  ~11,000–12,000 accounts, ~$8.5M saved in year one; 56–65% of participants were not previously
  regular savers. **The prize architecture is the relevant fact: a mixed ladder — 150+ monthly
  $25 prizes, quarterly prizes up to $5,000, plus a $100,000 annual grand prize.** The designers
  chose high-frequency small prizes **alongside** the headline number, not instead of it.
  **INDUSTRY-STANDARD** for the report; **PROVEN** for the documented prize ladder.

- *Honesty flag:* a citable empirical result that **frequent small prizes beat one large prize
  for engagement** was searched for specifically and **not found**. What exists is (a)
  Cook–Clotfelter's peer-reviewed finding that perceived winnability tracks *observed win
  frequency*, and (b) the revealed design preference of PoolTogether and Save to Win. **The
  claim itself is JUDGMENT** and is not presented here as a finding.

### 4.4 Reserve mathematics — the crux

> **Every major prudential regime reserves against a *probability* of payout at a stated
> confidence level. None pre-funds 100% of a future contingent obligation.**

- **Directive 2009/138/EC (Solvency II), Recital 64 and Article 101(3).**
  https://eur-lex.europa.eu/legal-content/en/ALL/?uri=CELEX%3A32009L0138
  Recital 64, verbatim: the SCR should ensure that *"ruin occurs no more often than once in
  every 200 cases or, alternatively, that those undertakings will still be in a position, **with
  a probability of at least 99.5%**, to meet their obligations to policy holders and
  beneficiaries **over the following 12 months**."* Article 101(3) requires the SCR to
  correspond to the **Value-at-Risk of basic own funds at a 99.5% confidence level over one
  year**. **PROVEN** for Recital 64 (verbatim confirmed); **PROVEN-with-caveat** for Art. 101(3)
  (content confirmed via multiple independent restatements; the EUR-Lex fetch truncated before
  the article body — verify wording before quoting verbatim).
  **This is the citable statement the brief asked for: the most conservative prudential regime
  in the world for guaranteed future obligations reserves to 99.5% over one year — explicitly
  not 100% of the obligation.** What it buys: ruin no more than 1-in-200. What it costs: an
  accepted 0.5% annual failure probability, in exchange for not sterilising capital.

- **Cramér–Lundberg ruin theory.** Lundberg (1903); Cramér, *On the Mathematical Theory of
  Risk* (1930). Accessible authority: Embrechts, Klüppelberg & Mikosch, *Modelling Extremal
  Events for Insurance and Finance* (Springer 1997); Asmussen & Albrecher, *Ruin Probabilities*
  (2nd ed., 2010). https://link.springer.com/book/10.1007/978-3-642-33483-2
  For surplus `R(t) = u + ct − S(t)`, the ultimate ruin probability satisfies the **Lundberg
  inequality `psi(u) <= e^(−Ru)`** — **ruin probability decays exponentially in the initial
  reserve.** **PEER-REVIEWED** (foundational).
  **This is the mathematical heart of the argument against 100% pre-funding: reserve
  requirements grow only logarithmically in the reciprocal of the tolerated ruin probability.
  Moving from a 5% to a 0.5% ruin tolerance costs roughly `ln(10)/R` in extra reserve — not
  twenty times the reserve.** The last basis points of certainty cost disproportionately more
  capital than they buy in safety.

- **Christiansen & Niemeyer, "The fundamental definition of the SCR in Solvency II,"** Ulm
  preprint 2012; later *ASTIN Bulletin* 44(3), 2014.
  https://www.uni-ulm.de/fileadmin/website_uni_ulm/mawi/forschung/PreprintServer/2012/DefinitionOfSCR.pdf
  **PEER-REVIEWED** — the actuarial-technical grounding for Art. 101(3).

- **BCBS d457, "Minimum capital requirements for market risk" (FRTB), Jan 2019.**
  https://www.bis.org/bcbs/publ/d457.htm
  Basel moved market-risk capital from **99% VaR to 97.5% Expected Shortfall** to capture tail
  severity beyond the threshold. **PROVEN.** Relevant because it shows the state-of-the-art
  debate is about *which confidence-level statistic* to reserve against — **never about whether
  to pre-fund 100%.**

- **CAS, "Solvency II Standard Formula and NAIC Risk-Based Capital," 2012.**
  https://www.casact.org/sites/default/files/database/forum_12fforumpt2_rbc-dcwprpt3.pdf
  Both major regimes are confidence-level-based. **INDUSTRY-STANDARD.**

**Applied to Plank:** the current design reserves **100% of a future obligation before
permitting the present one**, which is *stricter than Solvency II applies to life insurers'
guaranteed benefits*. The reason Plank can afford this strictness — and insurers cannot — is
that Plank's "capital" is players' rake rather than shareholder equity, so sterilising it has
no financing cost to the operator. **But it is not costless: the cost is paid in draw
frequency, which Cook–Clotfelter identifies as the primary driver of participation.** The
capital is not sterilised; *the product* is.

### 4.5 Player perception of a stalled progressive

**This is the weakest-evidenced topic, and the report treats it accordingly.**

- **Cook & Clotfelter (1993)** (§4.2) is the strongest available support, and it is *indirect*:
  if players calibrate perceived win probability on **observed win frequency**, a draw that
  becomes rare directly degrades perceived winnability and therefore participation.
  **PEER-REVIEWED** for the mechanism; **JUDGMENT** for the extension to stalled progressives.
- **Combs & Spry (2025)** documents declining elasticity of sales to jackpot size;
  the inverse reading — a jackpot that does not grow generates near-zero incremental handle —
  is reasonable but unstated. **PEER-REVIEWED** for the result; **JUDGMENT** for the corollary.
- **The NC 63% same-jackpot handle collapse** is real observed disengagement.
  **INDUSTRY-STANDARD.**
- **IMPORTANT CORRECTION on near-miss.** Pisklak, Yong & Spetch, "The Near-Miss Effect in Slot
  Machines: A Review and Experimental Analysis Over Half a Century Later," *J. Gambling Studies*
  36, 2020. https://link.springer.com/article/10.1007/s10899-019-09891-8
  This review concludes the near-miss effect on gambling persistence **does not reliably hold**:
  *"the near-miss effect on gambling persistence was founded on an early and imprecise account
  of conditional reinforcement,"* and Reid (1986)'s two systematic replications obtained no
  significant effects. **PEER-REVIEWED.** Contrast Clark et al., *Neuron* 61(3), 2009
  (https://www.sciencedirect.com/science/article/pii/S0896627309000373), the influential fMRI
  study finding the opposite. **The literature is contested; do not lean on near-miss or
  "anticipation" to justify a long dry spell.** The safe ground is Cook–Clotfelter's
  win-frequency mechanism.
- *Honesty flag: no primary source directly measuring disengagement from a stalled or
  non-growing progressive was found. The specific claim is **JUDGMENT**.*

---

## PART 5 — Alternatives evaluated against the vision

Constraints each option must satisfy: **(C1)** guaranteed reset — a win never empties the
board; **(C2)** displayed == redeemable, no unbacked liability; **(C3)** base never decreases;
**(C4)** any player can win on a minimum bet; **(C5)** fully legible to a player;
**(C6)** no operator earnings shown.

Arm-time per cycle, in rounds at 234 credits/round (reference table):

| cycle | base | (a) status quo | (b) 25% seed | (c) decoupled | (d) cap @250k | (e) two-lane |
|---|---|---|---|---|---|---|
| 1 | 50,000 | 712 | 356 | 237 | 712 | 534 |
| 3 | 150,000 | 1,662 | 950 | 712 | 1,662 | 1,246 |
| 5 | 250,000 | 2,612 | 1,543 | 1,187 | **2,374** | 1,959 |
| 8 | 400,000 | 4,036 | 2,434 | 1,899 | **2,374** | 3,027 |
| 12 | 600,000 | 5,935 | 3,621 | 2,849 | **2,374** | 4,452 |
| ∞ | — | **unbounded** | unbounded | unbounded | **2,374 (7.9 h)** | unbounded |

### (a) STATUS QUO — full pre-funding of the next base before any draw

**Mechanism:** `readyForDraw` requires `resetReserve >= minGross(nextCycleBase)`.
**Arithmetic:** §2.7. Arm-time grows linearly then geometrically, without bound.
**Preserves:** C1, C2, C3, C6 perfectly. **Breaks:** C4 progressively (a player whose session is
shorter than the arm-time has zero chance); C5 **as currently presented** (§2.4).
**House exposure:** zero. **Bounded cadence:** **no.**
**Verdict:** the guarantee is right; the unbounded ratchet and the presentation are wrong.

### (b) Reserve a FRACTION of the next base

**Mechanism:** require only `k` of the next base pre-funded (e.g. `k = 25%`, i.e. the seed
only), the remainder rolling in from subsequent play. Precedent: US 8,740,692 B2's explicit
0.5%/0.5% visible/reserve split (§4.1).
**Arithmetic:** at `k = 25%`, cycle 3 arms in 950 rounds instead of 1,662 — a 43% reduction —
and the improvement grows with the base.
**Preserves:** C3, C4 (improved), C5, C6. **Breaks: C1 and C2.** After a hit, the successor
prize is only `k`-funded, so either a partial prize is displayed (violating "a win never
empties the board" in spirit) or an unfunded remainder is displayed as money (violating
displayed == redeemable outright).
**House exposure:** the residual `(1−k)` becomes a house liability if the draw is to be honored
— exactly the exposure the design was built to eliminate.
**Bounded cadence:** **no** — it rescales the constant but the ratchet still diverges.
**Verdict:** *rejected.* It buys a one-off speedup by spending the design's best property, and
does not solve the unbounded term at all.

### (c) Decouple — draw on cadence once the CURRENT prize is sealed; ratchet only when supported

**Mechanism:** allow the draw as soon as `netPrize` is sealed. The base ratchets **only if**
the reserve actually supports the larger base at hit time; otherwise the next cycle re-seals at
the *same* base (never lower — C3 holds).
**Arithmetic:** fastest of all options per cycle (712 -> 237 rounds at cycle 1).
**Preserves:** C3 (base never decreases), C4 (strongly), C5, C6.
**Breaks: C1.** If a hit lands with an unfunded reserve, the board *does* empty — precisely the
outcome the guarantee exists to prevent. It converts a guarantee into a best-effort.
**House exposure:** zero, but the player-facing promise weakens.
**Bounded cadence:** yes in effect, but **by abandoning the guarantee**, not by bounding the
ratchet.
**Verdict:** *rejected as primary*, but **its conditional-ratchet half is the key idea** and is
adopted below. Making the *ratchet* conditional while keeping the *gate* absolute gets the
benefit without the cost.

### (d) Cap the ratchet — bounded time-to-draw

**Mechanism:** the base grows as now, but stops at a ceiling `B_max` (or grows only while
trailing volume grows). `nextCycleBase` returns `min(base + step, B_max)`.
**Arithmetic:** with `B_max = 250,000`, arm-time **converges to 2,374 rounds ≈ 7.9 hours and
stays there forever.** The mechanism reaches a **stable equilibrium** — the first option that
does.
**Preserves:** **all six constraints.** C3 is satisfied — a base that stops growing has not
decreased. C1 and C2 are untouched because the full-pre-funding gate is retained. C4 is
restored and *stays* restored. C5 improves: "the prize tops out at 250,000 and draws roughly
every 8 hours" is far more legible than an unbounded ratchet.
**House exposure:** unchanged — zero.
**Bounded cadence:** **yes, provably.**
**Cost:** the headline prize stops growing at the cap. Per Cook–Clotfelter, jackpot size drives
handle — so the cap trades headline growth for win frequency. Per Compiani et al., *optimal
odds scale with the player base*, which argues the cap should be **indexed to volume rather
than fixed**, and per Combs & Spry, an ever-larger jackpot has *declining* elasticity anyway.
**Verdict:** **the load-bearing fix.** This is the only option that bounds time-to-draw without
touching the guarantee.

### (e) Two lanes — a fast small prize and a slow grand prize

**Mechanism:** split the community prize leg, e.g. 75% to the grand Powerboard and 25% to a
fast lane that draws a small fixed prize frequently. Precedent: PoolTogether's tier system
(`p = 4^t`, highest tier *"occurring every single draw"*) and Save to Win's ladder (150+ monthly
$25 prizes + a $100,000 annual grand prize) — §4.3.
**Arithmetic:** at 25% of the prize leg (58 credits/round), a 5,000-credit small prize arms in
**96 rounds — about 19 minutes.** The grand lane slows by 33%.
**Preserves:** C1, C2, C3, C6 (each lane can keep its own full-pre-funding gate). **C4 is
served better than by any other option** — a minimum-stake player gets a real, frequent,
observable win path, which is precisely what Cook–Clotfelter says drives perceived winnability.
**C5:** slightly more to explain, but two clearly-named lanes are more legible than one lane
with an invisible gate.
**House exposure:** zero.
**Bounded cadence:** for the fast lane, yes; the grand lane still diverges unless combined
with (d).
**Verdict:** **strongly recommended as a complement to (d), not a substitute.** It is the
directly evidenced answer to "any player can win on a minimum bet."

### (f) Fund the reset from the VAULT rather than the prize pool

**Mechanism:** make the Vault's explicit purpose "the thing that guarantees the reset." The
reset reserve is funded from the Vault's retained 35% (and its growth), while 100% of the prize
leg funds the visible prize. Precedent: PoolTogether — principal preserved, prize paid from
yield (§4.3).
**Arithmetic:** the visible prize would fund at 360 credits/round instead of 234 (+54%), while
the reset draws on the 126 credits/round already flowing to the Vault side.
**Preserves:** C1, C2, C3, C4, C6.
**This is very likely what the owner means by the Vault's purpose**, and it resolves the
documentary tension in §1: it makes the Vault the *reset guarantor*, reconciling "a reserve
that only grows" (PRODUCT.md) with "recycles the rake it keeps" (§9) and finally making the
"Vault first, jackpot gets the overflow" cascade of §10 **operative** rather than inert.
**Problem, stated honestly:** at 126 credits/round the Vault side funds the reset *more slowly*
than the prize leg does at 234. On its own this makes the blackout **longer**, not shorter —
unless `protectedPrincipal` (currently monotone and never spent) is permitted to back the
reserve, which would **break the "only grows" property that is the Vault's defining
guarantee.** Using only the `emissionBuffer` half is safe but that half is consumed by
`crashSeed` every round.
**Verdict:** **conceptually right, arithmetically insufficient at current parameters.** Adopt
the *framing* (the Vault is the reset guarantor) and the cascade, but do not rely on it as the
mechanism that bounds draw time. Revisit at higher volume, where the `emissionBufferCap`
overflow actually fires.

### (h) SEED CARVE-OUT — the owner's candidate, and the winner of this analysis

> Owner's words: *"is there an easier way where x% of the lottery seeds the next lottery or
> something?"*

**Mechanism.** On a hit, the winner receives `(1−x)` of the sealed prize and `x` **remains as
the seed for the next prize**. Because the board is never empty by construction, **the
reset-reserve gate is no longer needed at all** — `readyForDraw` waiting on a fully pre-funded
next base can be deleted. The carve comes from a prize that is **already banked**, so nothing
is ever promised that is not already held.

**Conservation check (the critical property).** At the instant of a hit at base 250,000, x=20%:

```
before:  netPrize 250,000 (banked, sealed)
after :  winner paid 200,000 (from banked) + netPrize 50,000 retained (still banked)
```

`accountedAssets()` is conserved exactly. **There is no unbacked liability at any instant, and
zero house exposure** — identical to the status quo on both counts.

**Arithmetic — rounds to arm each cycle (234 credits/round, 20,000 pot, 12s rounds):**

| cycle | base | status quo | carve 10% | carve 20% | carve 30% |
|---|---|---|---|---|---|
| 1 | 50,000 | 712 | 237 | 237 | 237 |
| 2 | 100,000 | 1,187 | 451 | 427 | 404 |
| 3 | 150,000 | 1,662 | 665 | 617 | **570** |
| 5 | 250,000 | 2,612 | 1,092 | 997 | 902 |
| 10 | 500,000 | 4,986 | 2,160 | 1,947 | 1,733 |
| 20 | 1,000,000 | 9,734 | 4,297 | 3,846 | 3,395 |

**What the winner actually receives, and what seeds the next board (x=20%):**

| cycle | pool (base) | winner receives | seeds next board |
|---|---|---|---|
| 1 | 50,000 | 40,000 | 10,000 |
| 3 | 150,000 | 120,000 | 30,000 |
| 5 | 250,000 | 200,000 | 50,000 |
| 10 | 500,000 | 400,000 | 100,000 |
| 20 | 1,000,000 | 800,000 | 200,000 |

**How the per-round contribution now behaves.** It no longer splits between a prize bucket and
a reserve bucket. **Every credit goes to one visible number.** The funding requirement per cycle
falls from `minGross(base) + minGross(nextBase)` to `minGross(base) − minGross(carriedSeed)` —
roughly a **2.7x reduction at every table size** (verified at 1,000, 20,000 and 130,000 pots).

**Does the cadence stay BOUNDED as the base ratchets? — NO, and this is the crucial finding.**

Analytically, with proportional ratchet `g` and carve `x`:

```
fresh_n  = base_n/(1−fee) · (1 − x/(1+g))
rounds_n = fresh_n / f          -> grows at rate g forever
```

**The carve reduces the CONSTANT, not the GROWTH RATE.** Cadence is bounded **iff the base is
bounded.** (Note in passing: `x >= g/(1+g) = 4.76%` fully funds the *5% step*, but not the base
being re-funded each cycle — that is the term that diverges.)

> **Therefore the carve alone does not solve the unbounded problem. The carve plus a bounded
> base does.**

**COMBINED — carve 20% + cap 250,000 (the recommendation):**

| cycle | base | fresh needed | rounds | hours | winner | seeds |
|---|---|---|---|---|---|---|
| 1 | 50,000 | 55,555 | 237 | 0.8 | 40,000 | 10,000 |
| 3 | 150,000 | 144,444 | 617 | 2.1 | 120,000 | 30,000 |
| 5 | 250,000 | 233,333 | 997 | 3.3 | 200,000 | 50,000 |
| 6+ | 250,000 | **222,222** | **950** | **3.2** | **200,000** | **50,000** |

**Converges to a fixed cadence: a draw every ~950 rounds (~3.2 hours) forever**, winner
receiving 200,000, 50,000 seeding the next board. Steady-state cadence by carve rate:

| x | steady cadence | winner receives | seed |
|---|---|---|---|
| 0% | 1,187 rounds (4.0 h) | 250,000 | 0 |
| 10% | 1,068 rounds (3.6 h) | 225,000 | 25,000 |
| **20%** | **950 rounds (3.2 h)** | **200,000** | **50,000** |
| 30% | 831 rounds (2.8 h) | 175,000 | 75,000 |

**Against every PRODUCT.md constraint:**

- **C1 (a win never empties the board):** **preserved, and arguably strengthened.** See the
  guarantee analysis below.
- **C2 (displayed == redeemable):** **preserved only if the display law (Part 7) is
  implemented.** This is a hard prerequisite, not a nicety — see the regulatory finding below.
- **C3 (base never decreases):** preserved. The cap holds the base level; it never lowers it.
- **C4 (any player can win on a minimum bet):** **best of all options.** A bounded ~3.2 h
  cadence means an ordinary session can contain a draw.
- **C5 (legible):** **improved.** One number funding one prize, with a stated split, is far
  more legible than a prize bucket plus an invisible reserve bucket.
- **C6 (no operator earnings shown):** unaffected.

**Does removing the reserve gate weaken "a win never empties the board"?**
**The owner's read is correct, and I confirm it.** The guarantee shifts from *"the next prize is
fully banked"* to *"the next prize is seeded and grows from play."* That is **literally weaker** —
the successor board starts at 50,000 rather than at a full 250,000. But it is **a promise that
can always be kept**, at every instant, without ever blocking a draw; whereas the current
guarantee is stronger in words and **is currently being paid for with the draw itself**. A
guarantee that costs the event it guarantees is worth less to a player than a slightly weaker one
that never does. **The trade is sound.** Note also that the *floor* is genuinely never zero,
which is the property the guarantee actually exists to deliver.

**Regulatory verification — confirmed, refuted, and reconciled.**

The claim "regulated progressives seed resets by carving from the payout" is **REFUTED as
stated, but CONFIRMED in the form that matters**, and there is a hard rule the design must
respect:

- **The mainstream architecture carves from the CONTRIBUTION STREAM, not the payout.** The
  hidden-meter patents (US 9,830,777 B2; US 8,740,692 B2; Aristocrat US 2013/0172076 A1,
  *"a portion of the increments are added to the hidden meter and used to fund the reset value
  for future jackpots"*) accumulate the reseed in parallel. **PROVEN**, two independent
  manufacturers. https://patents.google.com/patent/US9830777B2/en ,
  https://patents.google.com/patent/US20130172076A1/en — accessed 2026-09-04.
- **The lottery analogue does the same.** Powerball/MUSL, codified at 18-553 C.M.R. ch. 20
  § II-4.0: the **Set-Aside Pool** *"used to fund the payment of the awarded minimum starting
  annuity Grand Prizes"* and the **Grand Prize Carry Forward Pool** are deductions **from
  sales**, at a disclosed rate of **up to 20%** of a party lottery's prize-pool contribution
  (4% of sales above a $120M annuity). **PROVEN.**
  https://www.law.cornell.edu/regulations/maine/18-553-C-M-R-ch-20-SS-II-4-0 — accessed
  2026-09-04. *The largest regulated jackpot game on earth seeds its reset from the contribution
  stream at up-to-20% — the closest thing to a regulator-blessed value for x.*
- **THE HARD RULE.** GLI-12 (Standards for Progressive Jackpots), adopted verbatim into binding
  state law at **205 CMR 143.02** (Massachusetts):
  > *"No progressive meter(s) shall be turned back to a lesser amount, unless: The amount
  > indicated has been paid to a winning patron..."*

  Nevada Reg. 5.110 has the same structure (meter may fall only by being paid, by documented
  malfunction correction, or by transfer of *"the entire incremental amount"* — no
  retain-a-slice branch). **PROVEN** for Massachusetts/GLI-12;
  **INDUSTRY-STANDARD** for Nevada (official PDFs are scanned images; substance corroborated by
  the machine-readable Massachusetts text).
  https://www.law.cornell.edu/regulations/massachusetts/205-CMR-143-02 — accessed 2026-09-04.

  **Consequence: you may not display "Jackpot: 250,000" and pay 200,000.** That is precisely the
  prohibited turn-back.
- **THE RECONCILIATION — partial-pay progressives.** **US 8,821,289 B2, "Partial pay
  progressives"** (Bally/LNW, 2014) is a genuine, patented carve at win time: a player takes
  *"200 units from the base component plus 40 units from the incremental component for a total
  progressive jackpot award of 240 units"* while the remainder **stays in the pool and carries
  forward**. **PROVEN.** https://patents.google.com/patent/US8821289B2/en — accessed 2026-09-04.

  This is regulator-compatible **precisely because the displayed meter is not represented as
  "what you win"** — it is a **pool**, against which a pre-disclosed rule determines the
  winner's share. The inviolable rule is *"the amount displayed as the player's win must be
  paid."* The design freedom is entirely in **what the headline number is defined to mean**, and
  **UKGC RTS 9A's pre-play disclosure requirement is the mechanism that makes such a design
  defensible** (§4.1).

- **The industry range for x.** From US 9,355,521 B2's worked examples (visible/secondary/hidden
  increments of 5/2/3 and 2/1/3, both with a $30,000 reset), the hidden share of contribution is
  **37.5% and 60%**. MUSL's GPCFP deduction is **up to 20%**. **So x = 10% is LOW; 20% is
  normal; 30% is comfortably within observed practice.** **INDUSTRY-STANDARD** for the range —
  *no regulator publishes an official seed rate; it is commercial configuration, not a standard.*
  https://patents.google.com/patent/US9355521B2/en — accessed 2026-09-04.
- **On-chain:** PoolTogether's reserve is likewise a **contribution-side** carve
  (*"A portion of the vault contributions are captured as reserve"*). Undistributed canary-tier
  liquidity rolls forward — a carry-forward from *unawarded* liquidity, not from a winner's
  prize. **JUDGMENT: no on-chain protocol found retains part of an awarded prize as the next seed.**

**The honest cost.** The winner receives **less than the pool headline**. At x=20% and a
250,000 pool the winner gets 200,000. **This is acceptable if and only if the headline is
presented as a pool with its split disclosed from the outset, never as the winner's prize.**
That is the Part 7 display law, and it is a **hard prerequisite** — without it this design is
the prohibited meter turn-back, and it breaks `displayed == redeemable`, the product's first
constraint. With it, the design has direct patent precedent and satisfies RTS 9A.

**Verdict: adopt, combined with a bounded base.** It is simpler than the status quo (one bucket,
not two; one gate, not two), 2.7x faster at every table size, converges to a fixed cadence, and
preserves conservation and zero house exposure exactly.

### (g) From the research — the hidden-meter sequencing, and must-hit-by

Two further options the literature surfaced:

**(g1) Hidden-meter sequencing** (US 9,830,777 B2, §4.1). The industry's actual solution: the
reserve accrues in parallel and is drained into the visible meter *at* the hit, so the draw
never stalls. **Plank already has the component (`resetReserve`) and already drains it at the
hit (`simulation.ts:288`). The only difference from industry practice is that Plank additionally
*blocks the draw* until the reserve is full.** Removing that block is option (c) and costs the
guarantee. **Retaining the block but bounding what the reserve must reach is option (d).** This
reframing is why (d) is the right answer: *Plank is one parameter away from the industry-standard
design, and that parameter is the ceiling, not the gate.*

**(g2) Must-hit-by / "must be won"** (GLI-12 mystery jackpots; CASINO-ARCHITECTURE §10).
Already specified in Plank's own architecture and **already implemented in
`contracts/PlankPowerboard.sol` — but entirely absent from `lib/`** (§1). Implementing
`mustHitByEpochs` in the live simulation would cap the *upper tail* of the wait. Note it does
**not** solve this problem: must-hit-by bounds the wait *for a ball to hit given draws are
occurring*; Plank's stall is a period in which **no draw occurs at all**. The two are
complementary, and the ratchet cap is the one that addresses the observed behaviour.

---

## PART 6 — Recommendation

### 6.0 The comparison the owner asked for — which combination wins, and why

Six candidates, judged on the four things that matter: **bounded cadence**, **the board never
empties**, **house exposure**, **legibility**.

| design | cadence at cycle 5 | bounded? | board never empties | house exposure | legible |
|---|---|---|---|---|---|
| (a) status quo | 2,612 rounds (8.7 h) | **no** | yes, fully banked | zero | **no** (as built) |
| (b) fraction of next base | 1,543 | no | **no** | **non-zero** | partly |
| (c) decouple, conditional ratchet | 1,187 | effectively | **no** | zero | yes |
| (d) cap the ratchet | 2,374 -> fixed | **yes** | yes | zero | yes |
| (f) vault underwrites reset | slower | no | yes | zero | yes |
| **(h) seed carve** | **997** | no (alone) | yes, seeded | zero | yes |
| **(h)+(d) carve 20% + cap** | **950 -> fixed forever** | **yes** | **yes, seeded** | **zero** | **yes** |

**Plainly: (h) + (d) is best, with (e) as a complement.** The reasoning:

- **It beats the status quo (a)** on every axis: 2.7x faster at every table size, converges to a
  fixed cadence instead of diverging, and collapses two buckets and two gates into one of each.
  It gives up only the *literal* "fully banked" wording — see the guarantee analysis in §5(h).
- **It beats reserving a fraction (b)** decisively. (b) creates a real unbacked liability and
  real house exposure to buy a one-off speedup; (h) achieves a larger speedup with **zero** of
  either, because the carve comes from money already banked.
- **It beats decoupling (c)** because (c) buys its speed by letting the board actually empty —
  abandoning the guarantee outright. (h) keeps a non-zero floor by construction.
- **It beats the proportional-only ratchet (dropping the +50,000 floor)** — that change helps
  only in cycles 1–20, where the +50,000 floor binds, and is *irrelevant* thereafter because the
  5% term takes over and still diverges. It treats a symptom in the arithmetic phase and does
  nothing about the unbounded term. **Use the cap instead; it is the only thing that bounds.**
- **It beats vault-underwrites-the-reset (f)** arithmetically: at 126 credits/round the Vault
  side funds the reset *more slowly* than the prize leg does at 234, so (f) alone makes the
  blackout **longer**. Adopt (f) as *framing* (it correctly answers "what is the Vault for"), not
  as the funding mechanism.
- **The cap (d) is not optional.** §5(h) proves the carve reduces the **constant** but not the
  **growth rate**: cadence is bounded **iff** the base is bounded. Carve without cap still
  diverges; cap without carve is 2.5x slower. **They solve different halves of the problem and
  are both required.**
- **(e) the fast lane remains the complement**, because it is the directly evidenced answer to
  "any player can win on a minimum bet" (Cook–Clotfelter on observed win frequency; the
  PoolTogether and Save to Win ladders).

### 6.1 Primary recommendation

> **Adopt the seed carve-out with a bounded base, and implement the display law that makes it
> honest. Delete the reset-reserve gate it replaces.**
>
> **Simultaneously and independently: the presentation defect in §2.4 is real and should be
> fixed regardless of whether the economics change at all.**

In priority order:

**FIRST — and this alone answers the owner's observation — fix the presentation.** No economics
change. Three changes in `public/arcade/crash.html` (and the mirror in `GameLaboratory.tsx`):

1. When `awaitingSeal === false`, **stop rendering "Funding toward next seal"** against
   `minGross(nextPrizeTarget)`. That bar is measuring a gate that cannot fire (§2.4).
2. Render the **real** gate: `resetReserve / minimumLotteryGross(nextCycleBase(cycleBase))` —
   for the owner's state, `x / 222,222` — labelled as what it is, e.g. *"Next draw arms when
   the guaranteed reset is funded."*
3. Show an **estimated rounds-to-arm** from the trailing per-round contribution rate, and state
   plainly that the prize is sealed and cannot change until the next draw. This is required by
   the PRODUCT.md constraint that the reset "must always be communicated", and is required by
   **RTS 9A** for any regulated deployment (§4.1).

**A large part of the owner's dissatisfaction is that the product currently hides its single
best feature and displays a meaningless bar in its place.** The guarantee is a selling point —
"the next prize is already in the bank before this one can be won" — and it is invisible.

**SECOND — adopt the seed carve at x = 20%, and delete the reset-reserve gate.**
On a hit: winner receives `netPrize × (1 − x)`; `netPrize × x` is retained as the opening
balance of the next board. `readyForDraw` no longer waits on `resetReserve`; the
`resetReserve` field and `fundResetReserve()` are removed entirely. **x = 20% is chosen because
it sits at the bottom of observed industry practice (MUSL's up-to-20% GPCFP deduction, against
patent examples at 37.5–60%), giving the winner the largest defensible share while still
converging the cadence.** The display law (Part 7) is a **hard prerequisite** and must ship in
the same change, never after it.

**THIRD — bound the ratchet.** Change `nextCycleBase()` to stop at a ceiling. Suggested
parameters, all requiring owner ratification (§6.3):

- `lotteryMaxBase = 250_000` credits for the playtest (arm-time converges to **~2,374 rounds,
  about 7.9 hours** and stays there — §5(d)), **or** preferably
- **index the ceiling to trailing volume:** `B_max = c · (trailing 24h prize-leg inflow)`, so
  the base grows only while the player base grows. This is the direct implementation of
  Compiani et al.'s result that **optimal odds scale linearly in population** (§4.2), and it
  means the prize grows when the game grows and holds steady when it does not.
- Equivalently, make the ratchet **conditional** — adopting the sound half of option (c): ratchet
  on a hit **only if** the reserve supports the larger base; otherwise re-seal at the same base.
  This never decreases the base, so C3 holds.

**FOURTH — add the fast lane** (§5(e)). Split the prize leg 75/25 into a grand Powerboard and a
frequent small prize (~5,000 credits, arming in ~96 rounds ≈ 19 minutes). This is the directly
evidenced way to honour "any player can win on a minimum bet", and it is what both PoolTogether
and Save to Win independently converged on.

**FIFTH — implement `mustHitByEpochs` in `lib/`** so the live engine actually delivers the
guarantee `CASINO-ARCHITECTURE.md` §10 already promises in writing (§1, §5(g2)).

**SIXTH — adopt the Vault-as-reset-guarantor framing** (§5(f)) in the documentation, and
reconcile the PRODUCT.md/architecture divergence. This makes the Vault's purpose legible and
answers the owner's question about what the Vault is *for*: **it is the thing that guarantees
the next prize exists.** Do not, however, rely on it to bound draw time at current parameters.

### 6.2 The invariant it must preserve

> **Every credit a player can win is already held before it is displayed, and the board's
> balance after any payout is strictly positive — where the base is bounded above and never
> below the current one.**

This replaces `simulation.ts:428-431`. Conservation (`accountedAssets()`) is unchanged; the
"underfunded reset reserve" throw disappears with the field it guarded; and the new
positive-floor property is checkable in the same invariant block:
`netPrizeAfterHit == priorNetPrize × x > 0`.

### 6.3 What I would NOT change, and why

- **The principle behind the gate — never display money you do not hold.** The *gate* is
  replaced, but the *principle* is not weakened by one credit: under the carve, the seed is
  carved from an already-banked prize, so no unbacked liability ever exists (§5(h)). What is
  given up is only the stricter-than-any-regulator requirement that the *next* prize also be
  fully banked before the *current* one may be won — a requirement no regulator imposes (§4.1)
  and stricter than Solvency II applies to guaranteed insurance benefits (§4.4). **The
  alternatives that genuinely relax the principle (b, c) remain rejected.**
- **The 40/40/20 split, the 1-in-16 ball, the linear stake weighting, the commit-reveal
  fairness surface.** All verified correct against real runtime data (14/14 rounds,
  chi-squared p >> 0.01) in the 2026-09-03 forensic audit. Nothing here touches them.
- **`protectedPrincipal` monotonicity.** It is a house-side floor funded from income, solvent
  by construction. Do not spend it on the reset reserve — that would destroy the one property
  that makes the Vault a Vault.
- **The fixed, predictable round cadence.** PRODUCT.md calls this "a deliberate ethical choice
  against surprise-timed draws." Variable-ratio timing would raise engagement and must stay
  rejected.
- **The founder fee's invisibility.** C6 holds throughout; none of these changes surfaces
  operator earnings.

### 6.4 Decisions only the owner can make

0. **The value of x, the seed carve.** 20% is recommended (winner receives 80%). 10% is below
   observed industry practice; 30% is still normal and gives a 2.8 h cadence. **This directly
   sets what a winner receives and is the single most consequential number in the proposal.**
1. **Should the headline prize be capped?** This is the core economic trade: **bounded draw
   frequency versus an unbounded headline number.** The evidence favours the cap
   (Cook–Clotfelter: win frequency drives participation; Combs & Spry: jackpot elasticity
   declines), but "the prize can only grow" is stated in PRODUCT.md's Product Purpose and a cap
   softens it to "the prize grows with the game." **That is a positioning decision, not a
   technical one.**
2. **The value of `lotteryMaxBase`, or the volume-indexing constant `c`.** 250,000 gives ~3.2 h
   with the carve; any value is defensible once the trade is understood.
3. **Whether to revert `powerboardFundingBps` from 6,500 toward 10,000.** The 2026-09-03 change
   is what made the Vault visibly outpace the prize (§2.6) and slowed draws 35%. If the Vault's
   purpose is reframed as the reset guarantor (§5(f)), the retention has a clear justification;
   if not, it is simply a 35% tax on draw frequency.
4. **Whether to introduce a fast lane, and its prize size** — this changes the product's shape,
   not just its parameters.
5. **Whether `consolation` should become non-zero** (currently `0n`), so every draw has a
   visible winner. The prior research doc already recommended this; Save to Win's ladder
   supports it.

### 6.5 The honest bottom line

**Is the current design the best way to execute the vision? No — but it is much closer than it
looks, and the single most urgent fix is presentational, not economic.**

Separating the three findings cleanly, because they have different urgencies and different costs:

1. **The presentation is wrong and the design underneath it is right.** The Powerboard popover
   shows a progress bar against a gate that cannot fire and hides the gate that can (§2.4).
   **This is the whole of what the owner actually observed, and it needs no economic change
   whatsoever** — the correct figures are *already computed* in `lib/casino/economy-report.ts`
   and *already displayed correctly in the Economy panel*. **Fix this first; it is nearly free.**
   *This is the part of the report where the honest answer is "the design is right and only its
   presentation is wrong," and I am stating it plainly rather than manufacturing a change.*
2. **The owner's seed-carve instinct is correct and is the better design.** It is simpler,
   2.7x faster, keeps conservation and zero house exposure exactly, has direct patent precedent,
   and removes an entire gate and an entire state field. **Adopt it — with the display law,
   which is a hard prerequisite, and with a bounded base, without which it still diverges.**
3. **The unconditional ratchet is the real structural flaw.** Neither the carve nor better
   presentation fixes it; **only bounding the base does.** But it is not what the owner is
   experiencing today — at cycle 3 the blackout is ~3.2 hours, not infinity. It is a problem for
   month six.

And one finding that is neither: **the Vault/lottery competition** is real, recent (2026-09-03),
deliberate, and was decided without computing its effect on draw time (a 35% slowdown, §2.6). It
deserves revisiting now that the number exists.

---

## PART 7 — The display law

> Owner, verbatim, 2026-09-04: *"ensure we always display to users the reality in x return terms
> after multiplier locks and game ends, and in funding amounts, usd value, eth value. credits are
> least useful units."*

This is a product-wide law, not a lottery detail. It is also the **hard prerequisite** for the
seed carve (§5(h)): without it, paying a winner less than a displayed jackpot is the meter
turn-back that GLI-12 and Nevada Reg. 5.110 prohibit; with it, the design is a disclosed
partial-pay pool with patent precedent (US 8,821,289 B2) and satisfies UKGC RTS 9A's pre-play
disclosure requirement.

### 7.0 Current state — the law is written but only ~20% applied

**Already correct** (do not rebuild):
- `privateMoney3()` (`crash.html:5607-5619`) already implements the canonical ordering, and its
  own comment already cites *"THE DISPLAY LAW (owner, 2026-09-04): credits are least useful
  units."*
- The **realized return** already leads the result card (`crash.html:5910-5923`), with an
  explicit comment that the lock multiplier *"is claim weight and not what the player received."*
- `lib/casino/economy-report.ts` already computes `requiredGross + requiredReserve`,
  `remaining`, `roundsToActivation`, `secondsToActivation`, `fundedBps` — **correctly, including
  the sealed case** (`requiredGross = 0` when not awaiting seal).
- The **Economy panel** (`crash.html:5675-5695`) already renders nearly everything in
  USD·ETH·credits via `privateMoney3`.

**The measurable defect:** the file contains **65 bare `privateCredits(...)` renders against 16
compliant `privateMoney3(...)` renders.** The law is specified and partially built; it is not
enforced. That ratio is the auditable acceptance criterion for this work.

### 7.1 Canonical unit ordering and formatting

**USD leads. ETH second. Credits parenthetical and last.** Fixed conversion: **1 credit =
0.000001 ETH** (1,000,000 credits = 1 ETH), exact and integral. USD comes from the live quote
already in the header (`privateEthUsd`, sourced via `privateEthPriceSource`).

```
canonical:            $12.34 · 0.005 ETH (5,000 cr)
no quote available:   0.005 ETH (5,000 cr) · USD quote unavailable
signed (net/delta):   +$12.34 · +0.005 ETH (+5,000 cr)
compact (chips):      $12.34
```

**Never invent a price.** When `privateEthUsd <= 0`, say *"USD quote unavailable"* and let ETH
lead — ETH is exact, USD is a reference. This is already the behaviour of `privateMoney3`; the
work is to route every money figure through it.

Every figure must remain reconcilable to exact integer credits, which stay the settlement unit.
The law changes **display order and prominence**, never settlement.

### 7.2 "Reality in x return terms"

**The rule:** after a lock and at settlement, the player must see **what they actually got as a
multiple of what they staked** — `realized = payout ÷ stake` — not the lock multiplier. Under
parimutuel settlement these differ, and PRODUCT.md already names the confusion a defect:
*"Multiplier is claim weight, not a payout promise. Any copy or animation implying stake ×
displayed multiplier is guaranteed is a defect."*

**The realized return leads; the lock multiplier is demoted to context.** Exact requirements:

**Result / reveal card** (`crash.html:5868+`) — already largely compliant; finish it:
```
survivor, profit:  +67% · 1.67× RETURNED
                   1.67× returned · $20.34 · 0.00835 ETH (8,350 cr) paid · +$8.14 net
survivor, loss:    0.83× RETURNED · LOCKED 2.40×
                   0.83× returned · $10.17 · 0.00417 ETH (4,175 cr) paid · -$2.03 net
busted:            CAUGHT IN THE CRASH
                   0.00× returned · $12.20 · 0.005 ETH (5,000 cr) staked and lost
```
Fix: `crash.html:5924` renders the balance as bare credits — route through `privateMoney3`.

**Seat / roster row** (`.sb-row`, `crash.html:3410-3411`) — currently shows only exit multiplier
and an ETH amount. Must show **realized return as the primary "x"**, with the lock multiplier
labelled as such:
```
Ana   1.67× ret   $20.34   (locked 2.40×)
```

**History ribbon chip** — the crash multiplier is a round property, legitimately shown as is. But
**a chip representing the player's own round must show their realized return, not the crash
point.** Distinguish the two visually; never let a round's crash multiplier read as a player's
return.

### 7.3 Funding amounts

Every funding figure in USD·ETH·credits: the prize/pool, the remaining-to-draw, the per-round
contribution ("this flight funded"), the vault delta and the vault total.

**The Powerboard popover (`crash.html:3758-3776`) is the primary defect and needs two fixes:**

1. **Stop recomputing its own denominator.** It calls `privateMinimumLotteryGross(nextPrizeTarget)`
   locally and gets 166,666 — the wrong gate, measuring a seal that cannot fire (§2.4). **Use the
   snapshot's `lotteryActivationQuote`, which is already correct**, exactly as the Economy panel
   does. This is the single highest-value line change in the product.
2. **Render every figure through `privateMoney3`** — lines 3767–3775 are all bare credits.

Required copy while funding (status quo economics):
```
Next draw arms when the guaranteed reset is funded
  $54.20 · 0.02224 ETH (22,240 cr) of $271.00 · 0.111 ETH (111,111 cr)   [20% funded]
  ≈ 730 rounds ≈ 2.4 h at this table's pace
The prize is sealed at $366 · 0.15 ETH (150,000 cr) and cannot change until the next draw.
```

**Under the seed carve** the second bucket disappears entirely and the copy simplifies to one
bar — a direct legibility gain:
```
Next draw arms in ≈ 950 rounds ≈ 3.2 h
  $542 · 0.222 ETH (222,222 cr) of $610 · 0.25 ETH (250,000 cr)
```

### 7.4 The jackpot headline under the seed carve — displayed == redeemable applied to the prize

**Mandatory, and non-negotiable.** The headline must disclose the split **from the outset**,
never only at payout. A headline number that is not what lands in the winner's balance is
forbidden (§5(h): GLI-12 / 205 CMR 143.02).

```
POWERBOARD POOL  $610 · 0.25 ETH (250,000 cr)
  you receive    $488 · 0.20 ETH (200,000 cr)      ← 80%
  seeds the next $122 · 0.05 ETH (50,000 cr)       ← 20%, never leaves the board
```

Header chip (space-constrained), the split still present:
```
POWERBOARD $610 · WIN $488 · ODDS 1 IN 2,549
```

Wording rules:
- The pool number **must never be labelled "PRIZE" or "you win"** — it is the **pool**.
- The winner's figure **must be labelled as what they receive** and must equal the credited
  balance exactly.
- The seed must be described as **"seeds the next board"**, not as a fee, and never counted as
  operator earnings (it is not — it stays in the prize pool; C6 is unaffected).
- At payout, the reveal states the same two numbers again.

### 7.5 Surfaces that must change

| # | surface | location | required change |
|---|---|---|---|
| 1 | **Powerboard popover** | `crash.html:3758-3776` | Use `lotteryActivationQuote` (stop local recompute); all figures via `privateMoney3`; add rounds/time-to-arm; add pool/receive/seed split |
| 2 | **Result / reveal card** | `crash.html:5868-5924` | Realized return already leads; route balance (5924) and all money via `privateMoney3` |
| 3 | **Powerball ledger in reveal** | `crash.html:5946` | `JACKPOT PAID`, `THIS FLIGHT FUNDED`, `NEXT PRIZE BASE` all bare credits -> `privateMoney3`; add the receive/seed split on a hit |
| 4 | **Header chips** | `crash.html:5638-5644` | Lottery chip shows pool + winner's share; vault chip USD-first; phone variant keeps USD |
| 5 | **Economy panel** | `crash.html:5675-5695` | Mostly compliant; fix residual bare credits (5657, 5662, 5666-5668, 5686-5687); update reset-reserve rows if the carve ships |
| 6 | **Roster / seat rows** | `crash.html:3410-3411`, `.sb-row` | Add realized return as primary; demote lock multiplier to a label |
| 7 | **History ribbon** | `crash.html:290+` | Distinguish round crash point from the player's realized return |
| 8 | **Lab metrics panel** | `GameLaboratory.tsx:276` | "Current prize"/"Reset reserve" bare credits -> USD·ETH·credits; add the gate denominator |
| 9 | **SYSTEM & MATH manual** | `public/playtest/plankcrash-system.html` | Document realized return vs claim weight; document the pool/receive/seed split and the unit ordering |
| 10 | **Balance / wallet readouts** | `crash.html:5513, 5527` | USD-first ordering |

**Acceptance test (mechanical):** no money figure reaches the DOM except through
`privateMoney3()` or `privateUsdShort()`. Concretely: **bare `privateCredits(...)` renders go
from 65 to 0**, except inside `privateMoney3` itself and where a value is genuinely not money
(ticket weights, round numbers, iteration counts). A lint rule or a test asserting that count is
the cheapest durable enforcement.

### 7.6 What the display law does NOT change

- **Settlement.** Credits remain the exact integer settlement unit; USD/ETH are display only.
  The existing disclaimer — *"Display only; never used for settlement"* — must survive.
- **The no-operator-earnings constraint (C6).** None of these surfaces exposes the founder leg;
  the seed is prize money, not operator income.
- **The test-credit disclosure.** *"Test credits have no cash value"* must remain on every
  surface showing a USD figure. Showing USD makes this disclosure **more** important, not less,
  and it is a PRODUCT.md durable constraint.

---

## Appendix — verification method

All arithmetic in Parts 2 and 5 was derived independently from the source (`simulation.ts`,
`economics.ts`, `playtest-room-core.ts`) using integer arithmetic matching the code's `bigint`
semantics, and cross-checked against the real runtime data in
`AUDIT-lottery-funding-eligibility-draw-2026-09-03.md` (the 639-credit community contribution
on a 35,500 pot, and the observed 1,000,000 -> 1,050,000 ratchet). Superseded conclusions in
`RESEARCH-vision-economics-sota-config-2026-09-02.md` and the SUPERSEDED-IN-PART dossier banner
were respected; where that document's recommendations bear on this one (its `powerboardFundingBps`
6,000–7,000 recommendation, its "keep the monotone guaranteed base" line, and its
consolation > 0 suggestion) they are cited as prior art rather than restated as new findings.

External citations were gathered from primary sources on 2026-09-04 and are labelled by
evidence class throughout Part 4, including explicit honesty flags where only JUDGMENT was
available and one correction (near-miss, §4.5) where the recent review literature contradicts
the common assumption.
