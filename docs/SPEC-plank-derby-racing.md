# Plank Derby — Procedural Pari-Mutuel Racing Spec

Design spec for a new game surface: provably fair, non-custodial, pari-mutuel horse
racing rendered in RobinWood's own art style. No NFT is staked, locked, or
custodied — racers are procedurally generated per race using the collection's
existing trait/rarity system purely for visual identity. This document specs the
math to the point of "an independent engineer could re-implement the exact same
outcomes from the seed alone," and the growth/hype layer to the point of "a
designer could build the UI without asking what a screen is for."

**Status**: design only, no code written yet. Every section below is either (a)
grounded in a real, cited precedent researched before writing this, or (b) marked
explicitly as a judgment call for the owner. Nothing here is asserted as already
decided.

**Framing note, stated once so it isn't silently assumed**: this is described to
players as skill-flavored, provably-fair entertainment, not gambling. Worth
knowing before this ships: most jurisdictions' gambling tests look at substance
(real value staked, uncertain outcome, chance of gain) rather than framing —
pari-mutuel stakes moving based on race results will likely be evaluated as
wagering by a regulator regardless of what the product calls itself. That's a
business decision, not an engineering one, and it doesn't block writing the spec
— but it belongs in the same real-counsel review this whole game suite needs
before real money is staked (no legal-review doc exists in this repo yet for
either game — that's a real gap, not a pointer to something already written),
not shipped assuming the framing alone settles it.

---

## 1. What this is, in one paragraph

Every race, N racers are generated fresh from a public, verifiable random seed —
rendered in RobinWood's hand-drawn art style (reusing the collection's own
trait/rarity vocabulary for visual flavor only, never ownership) — and run a
deterministic, open-source race-simulation algorithm that any observer can
independently re-execute against the revealed seed to confirm the recorded
result couldn't have been anything else. Players stake into a shared pool before
the race locks; the pool (minus a fixed rake) redistributes to backers of the
in-the-money finishers after the race. No treasury pays winners — losers' stakes
do, which is the literal definition of pari-mutuel. A separate, optional "bribe"
pool lets anyone add PLANK, ETH, or an NFT to a specific racer's pot before lock;
if that racer places, its backers split the bribe pot too, on top of the normal
payout.

## 2. Real precedent this is built on (not invented from scratch)

- **Pari-mutuel settlement**: standard racetrack economics, formalized for
  smart contracts in ["Writing a Parimutuel Wager
  Contract"](https://programtheblockchain.com/posts/2018/05/08/writing-a-parimutuel-wager-contract/)
  and studied specifically for horse racing in [Springer's "Parimutuel Betting
  on Blockchain: A Case Study on Horse
  Racing"](https://link.springer.com/chapter/10.1007/978-3-031-87766-7_16).
- **Jockey/racer stat systems**: [ZED RUN](https://consensys.io/blog/zed-run-the-future-of-horse-breeding-and-racing)
  (visible traits like speed/stamina + hidden traits like reaction time,
  class ratings assigned from race history) and [Equine
  NFT](https://www.cardanocube.com/projects/equine-nft) (jockey personality
  modifies horse performance) are the two closest real systems.
- **Bribe pools**: this is Curve Wars' bribe-market pattern
  ([Votium](https://university.mitosis.org/vetokenomics-bribe-markets-gauge-voting-incentives-and-curve-wars-mechanics/),
  generalized across protocols by [Hidden
  Hand](https://university.mitosis.org/vetokenomics-bribe-markets-gauge-voting-incentives-and-curve-wars-mechanics/))
  applied to a race instead of a gauge vote: deposit an asset earmarked for a
  target, backers of that target split it if the target wins. Billions of
  real dollars have moved through this exact mechanic in DeFi; it is not a
  novel trust assumption.
- **Provably fair RNG**: the same commit-reveal / HMAC-seed pattern discussed
  for the crash game earlier in this design process (conversational so far,
  not yet written to its own spec doc — flagging that explicitly rather than
  citing a file that doesn't exist yet), and the same pattern every serious
  "provably fair" casino product (Aviator/Spribe, Stake) already uses.
- **Non-custodial entry**: matches this repo's own proven pattern —
  `contracts/MarketplankVaultV3.sol`'s header states its design explicitly
  excludes "no oracle, no external AMM, no owner-mutable fees, no
  upgradeability, no admin withdrawal of pool ETH, no pause" (verified
  directly against the real file in this repo, not assumed). Plank Derby's
  racer generation and settlement contracts should hold the same property:
  nothing about who wins is touchable by whoever deployed it, and no NFT
  ever leaves a holder's wallet because none is ever referenced by ownership
  at all.

## 3. Race lifecycle (state machine)

```
CREATED  →  OPEN (betting + bribes accepted)  →  LOCKED  →  SEED_REVEALED  →  SIMULATED  →  SETTLED
```

| State | What's true | What's allowed | What's forbidden |
|---|---|---|---|
| `CREATED` | Race exists, roster not yet generated, commit hash published | Nothing yet — this state exists so the commit hash is on record before anyone can bet | Betting |
| `OPEN` | Roster generated from a **second**, independent seed (visual/stat generation — see §4) published alongside `CREATED`; commit hash for the **outcome** seed already public | Betting, bribing | Revealing the outcome seed |
| `LOCKED` | Betting window closed (block-height or timestamp cutoff, on-chain enforced) | Nothing — this is a deliberate no-op window | Any bet, any bribe, any reveal |
| `SEED_REVEALED` | Outcome seed published, checked against the `CREATED`-stage commit hash | Public verification (anyone can now re-run the simulation off-chain) | New bets (already forbidden since `LOCKED`) |
| `SIMULATED` | Deterministic simulation run, finishing order recorded on-chain | — | Simulation logic must be identical to the published open-source version; a mismatch here is the actual "provably fair" bug bounty target |
| `SETTLED` | Pool distributed, bribe pots distributed, rake sent to treasury | Claims | Re-simulation, re-settlement |

**Why the roster-generation seed and the outcome seed are two separate commits,
not one**: if a single seed decided both which racers show up *and* who wins,
the house (or anyone who could see the roster before it's public) would have a
window to bias participation before the outcome is locked in. Splitting them
means the roster is public and stable throughout the `OPEN` betting window,
while the actual race outcome remains genuinely unknown until `LOCKED` closes —
this is the single most important structural decision in this spec, and it's
the fix for the most obvious way a naive version of this game could be gamed.

## 4. The math, specified to the point of re-implementability

### 4.1 Seeds

Two independent commit-reveal pairs per race:

- `rosterSeed` — revealed at `CREATED → OPEN` transition. Drives racer count,
  visual trait remix, and each racer's **published stat profile** (§4.2).
- `outcomeSeed` — committed (hash only) at `CREATED`, revealed at
  `LOCKED → SEED_REVEALED`. Drives the actual race simulation (§4.3).

Both follow the same commit-reveal shape: `commitHash = keccak256(secret)`,
published first; `secret` revealed later; anyone can verify
`keccak256(revealedSecret) == commitHash`. Chainlink VRF (if available on
Robinhood Chain — unconfirmed, needs a real check before relying on it) would
remove the operator-liveness dependency commit-reveal has (see §6.4), at the
cost of an external dependency. This is an open decision, not resolved here.

### 4.2 Racer stat profile (published, fixed before betting closes)

For a roster of N racers (N fixed per race type, e.g. 8), derive from
`rosterSeed`:

```
racerSeed[i]     = keccak256(rosterSeed, i)
speed[i]         = 40 + (racerSeed[i] mod 21)        // integer, range [40, 60]
stamina[i]        = 40 + (keccak256(racerSeed[i], "stamina") mod 21)
luckFactor[i]     = 40 + (keccak256(racerSeed[i], "luck") mod 21)
traitTier[i]      = weighted draw from the existing collection rarity table
                     (lib/rarity.ts) — VISUAL ONLY, no numeric effect on
                     speed/stamina/luck. Keeping trait tier decorative avoids
                     a "rich traits win more" perception problem entirely.
```

All integer math, no floats, no external calls mid-computation. This block is
100% deterministic from `rosterSeed` alone — publish it in full (not just the
final stats) so anyone can recompute it from the revealed roster seed and
confirm the displayed racer cards weren't hand-picked.

### 4.3 Race simulation (deterministic, segment-by-segment)

A race is divided into `S` fixed segments (e.g. 10, representing furlongs).
Each racer's segment performance:

```
for segment in 1..S:
  for racer i in field:
    roll[i]      = keccak256(outcomeSeed, raceId, segment, i) mod 10000
    // Weighted by that racer's published stats -- roll is compared against
    // a threshold derived from speed/stamina/luck, not simply summed, so
    // no single stat dominates and variance stays meaningful throughout.
    performance[i] = baseAdvance
                    + (speed[i] * SPEED_WEIGHT)
                    + (stamina[i] * STAMINA_WEIGHT * fatigueFactor(segment))
                    + (roll[i] mod (luckFactor[i] * LUCK_SCALAR))
    position[i]   += performance[i]
finishOrder = sort racers by position[] descending (ties broken by
              keccak256(outcomeSeed, raceId, "tiebreak", i))
```

`fatigueFactor(segment)` increases stamina's weight in later segments (a
racer with high speed but low stamina fades late — this is what makes the
published stats *feel* meaningful without letting one stat trivially dominate
the whole race). Exact constants (`SPEED_WEIGHT`, `STAMINA_WEIGHT`,
`LUCK_SCALAR`, `baseAdvance`) are tuning parameters, published alongside the
simulation source, never changed per-race.

**Re-implementability test, which is the actual bar for "fool proof" here**:
given only `rosterSeed`, `outcomeSeed`, `raceId`, and the published constants,
an independent party with no access to this codebase should be able to
reproduce the exact recorded finish order, byte for byte. If they can't, the
implementation — not the design — has a bug, and that mismatch is the concrete
thing a bug bounty or audit should be paid to find.

### 4.4 Pari-mutuel settlement

```
pool            = sum(all stakes for this race)
rake            = pool * RAKE_BPS / 10000        // e.g. 250 bps = 2.5%
distributable   = pool - rake
winningStakes   = sum(stakes on racers that finished "in the money",
                       e.g. top 3 of N -- win/place/show, same convention
                       as real pari-mutuel racing)
payout[bettor]  = distributable * bettor.stake / winningStakes
                  (only for bettors who backed an in-the-money racer)
```

This is the whole mechanism that makes the "no funded prize pool" property
true: `distributable` is bounded by `pool`, which is bounded by what was
actually staked. There is no code path where `payout` sums to more than
`distributable`. If `winningStakes == 0` (nobody backed any in-the-money
racer — a real possibility with a small field), the full `distributable`
amount rolls into next race's pool rather than being stranded or
misdirected — decide and document this explicitly rather than leaving it as
an implicit edge case.

### 4.5 Bribe pools

```
bribePot[racer]      = sum(all bribe deposits earmarked for that racer,
                            any asset type, tracked separately per asset)
if racer finished in the money:
  bribeShare[bettor] = bribePot[racer] * bettor.stakeOnRacer / totalStakeOnRacer
else:
  bribePot[racer] rolls forward to that racer-slot's NEXT race (a bribe on
  "lane 3" carries to whoever races in lane 3 next round) OR refunds to
  depositors -- pick one and document it; rolling forward creates a real
  incentive to bribe early/often, refunding is simpler and avoids the
  question of whether a bribe was "for this specific racer" or "for this
  slot." Recommend refund for v1 -- simpler, no ambiguity, revisit rolling
  bribes once the mechanic is proven.
```

NFT bribes need their own settlement path since an NFT can't be split
proportionally like a fungible token — either (a) NFTs are excluded from
proportional bribe pots and instead go to a single winner drawn from the
backers of the in-the-money racer (weighted by stake, same `outcomeSeed`-
derived randomness as the race itself, so it's provably fair too), or (b) NFT
bribes are restricted to a single flat prize claimed by whoever staked the
single largest amount on that racer. (a) is more interesting and more "in
the spirit of the game," (b) is simpler to reason about and audit. Owner
call.

## 5. Attack-surface analysis (adversarial, not just descriptive)

Every entry below is a real way a naive version of this design could be
broken, with the specific mitigation this spec already includes.

| Attack | How it would work naively | Mitigation already in this spec |
|---|---|---|
| **Outcome front-running** | Bettor sees the outcome seed before betting closes and bets the sure winner | Two-seed split (§3): outcome seed commits at `CREATED`, reveals only after `LOCKED`. Betting is cryptographically impossible after the commit is the only thing public. |
| **Roster bias** | House waits to see who's betting before deciding which racers even appear | Roster seed reveals at `OPEN`, before any bet is placed — the field is fixed and public for the entire betting window. |
| **Operator seed withholding (griefing)** | Operator commits a hash, then simply never reveals the real seed if the "wrong" racer is about to be favored | Same failure mode `clawd-crash` documented and solved with an emergency-refund timeout — if `SEED_REVEALED` hasn't happened within a fixed window after `LOCKED`, the race voids and all stakes (and bribes) refund automatically, no admin action required. |
| **Stat-computation grinding** | If stats were assigned by the house rather than derived from a hash, someone could grind for a favorable roster | Stats derive entirely from `keccak256(rosterSeed, i)` — nobody, including the deployer, picks a racer's stats; they fall out of the hash. |
| **Rounding-exploit settlement drain** | Repeatedly claiming payouts with adversarial rounding to extract more than a fair share | Settlement math (§4.4) uses integer division consistently; the CEI (checks-effects-interactions) pattern and a per-race claimed-bitmap prevent double-claiming — this needs the same fuzzed/randomized-invariant testing already proven in this repo (`test/contracts/VaultV3.fuzz.test.ts` and `VaultSolvency.fuzz.test.ts`, verified to exist directly against the real test tree), not just unit tests on the happy path. |
| **Sybil betting to manufacture a "winning" narrative** | One actor splits a large bet across many wallets to look like organic broad support for a racer they know backing | Doesn't break the math (payout is still proportional to total stake, sybil or not) — this is a *hype/perception* risk, not a solvency risk. Worth naming so the growth-mechanics section (§7) doesn't accidentally reward apparent-consensus signals that are trivially fakeable. |
| **Bribe-pool NFT valuation gaming** | Someone bribes with a worthless/spam NFT to inflate a racer's apparent bribe pot for social-proof effect | Display bribe pots by asset, not a single blended "value" number, unless there's a trusted price oracle for every possible bribed NFT (there won't be) — don't invent a fake valuation to make the UI look more exciting. |
| **Reentrancy on claim** | Classic reentrancy during payout/bribe-share claim | Standard OpenZeppelin `ReentrancyGuard` + `nonReentrant` guard, same as `contracts/MarketplankVaultV3.sol` already uses on every state-changing external function in this codebase (verified directly against the real file) — nothing novel needed here, just don't skip it. |
| **Front-running the bribe deposit itself** | Depositing a bribe right at the `OPEN → LOCKED` boundary to sway last-second betting | Bribes should close at the same moment betting does (`LOCKED`), not have their own later deadline — otherwise a whale can bribe *after* seeing final betting patterns to manufacture a specific outcome's popularity right before lock, which is a real, if subtle, manipulation vector worth closing explicitly. |

## 6. Open engineering questions (owner or eng-lead decisions, not resolved here)

1. **On-chain simulation vs. off-chain-computed + on-chain-verified?** Running
   the full segment-by-segment loop on-chain (§4.3) is expensive at scale (S
   segments × N racers × per-segment keccak = real gas). The cheaper,
   still-fully-verifiable alternative: compute the simulation off-chain,
   submit only the final result on-chain, and let the on-chain contract (or
   any watcher) independently re-run the same deterministic function to
   challenge a wrong result within a dispute window. This is a real
   trust/cost tradeoff, not a solved problem — needs a decision before
   writing the contract.
2. **Chainlink VRF availability on Robinhood Chain** — unconfirmed. If
   available, it removes the operator-liveness dependency commit-reveal has
   entirely (no possible "operator went offline" griefing case at all,
   because there's no operator reveal step). Worth checking before
   committing to commit-reveal as the final design.
3. **Race cadence** — continuous (a new race starts the moment the last one
   settles) vs. scheduled (races at fixed times, building anticipation).
   Scheduled races support the hype mechanics in §7 much better (countdown,
   "next race in 4:32," pre-race hype window) at the cost of lower total
   throughput.
4. **NFT bribe settlement** — flat single-winner draw vs. excluded from
   proportional splitting entirely (§4.5). Needs a decision before the
   bribe-pool contract can be finalized.

## 7. Growth and hype mechanics — addictive in the sense of *compelling*, not manipulative

Every mechanic below is disclosed, provably fair, and reversible for the
player (nobody is ever locked into a position they can't see the real odds
on) — the goal is genuine excitement from genuine uncertainty and genuine
stakes, not dark-pattern manipulation. That line matters: everything here
should survive being fully explained to the player without losing its appeal.

- **Live odds ticker during `OPEN`**: real-time implied odds per racer,
  updating as the pool grows — this is free, honest, and already
  psychologically compelling (watching a longshot's odds shift as bribes and
  bets land is a real, proven hook in every pari-mutuel product that's ever
  existed, not an invented manipulation).
- **Bribe-pool spectacle**: surface the biggest live bribe pot prominently —
  "12.4 ETH riding on Lane 4" is a genuine, real number that creates
  legitimate FOMO without fabricating anything.
- **Scheduled race cadence with a countdown** (§6.3): a fixed "next race in
  X" creates a natural rally point, same mechanic every live-drop/mint
  countdown already uses successfully across this whole space — well
  understood, not novel, works because anticipation is real.
- **Photo finish rendering**: when the top-2/3 margin in the simulation
  output is below a threshold, the race replay should visually emphasize
  it (slow-motion finish-line render) — this is presenting a *real* close
  result more legibly, not fabricating closeness that didn't happen in the
  underlying math.
- **Streaks and leaderboards**: track (and display) real, verifiable
  streaks — most consecutive in-the-money picks, biggest single payout,
  biggest bribe ever placed. All derived from on-chain history, nothing
  invented or seeded fake.
- **Social share card per race**: auto-generated image (racer art + final
  standings + the bettor's own result) — shareable, matches the "art as
  racers" identity, gives every race a artifact worth posting regardless of
  outcome (a beautiful loss card is still shareable).
- **Provably-fair verification as a feature, not fine print**: a real,
  one-click "verify this race" page that re-runs §4.3 in the browser against
  the public seed and shows it matches — this is both a trust mechanic and,
  done well, a genuinely compelling piece of UI in its own right (watching
  the math reproduce the exact race you just saw is a real "whoa" moment,
  not just a compliance checkbox).
- **What this deliberately does NOT do**: no artificial scarcity on
  entering a race, no near-miss manipulation (a "so close" outcome is only
  ever shown when the actual simulated margin was actually close — see photo
  finish above), no variable-reward schedules tuned specifically to
  encourage compulsive re-betting, no hiding the real odds or real rake.
  Hype comes from a genuinely well-built, genuinely fair game being fun to
  watch — not from engineered psychological pressure. This is a deliberate
  line, not an oversight if a growth idea from elsewhere in the industry is
  missing from this list.

## 8. Rollout plan

Same staged logic already used for ETH-crash-before-PLANK-crash:

1. **Phase 1 — simulation-only, no money.** Ship the race-simulation engine
   and the verification UI standalone (§4.3, §7's "verify this race"
   feature) with fake/demo seeds, zero staking. Proves the math and the art
   pipeline before any value is at risk, and doubles as the actual bug-bounty
   surface from §4.3's re-implementability test.
2. **Phase 2 — ETH-staked pari-mutuel, no bribes.** Smallest real-money
   surface: races, betting, settlement. No bribe pools yet — fewer moving
   parts to get right first.
3. **Phase 3 — bribe pools (PLANK + ETH only, no NFTs).** Adds §4.5's
   fungible-asset path once the core settlement has real-money proof.
4. **Phase 4 — NFT bribes**, once §6.4's settlement-path decision is made
   and the fungible-asset path has run cleanly for a real stretch of races.

Legal review (per this document's framing note, §0) should happen before
Phase 2, not after — the same discipline this session has held to
consistently across every game concept discussed so far (crash, racing),
even though no formal legal-review doc exists in this repo yet for any of
them.

## 9. What "fool proof" actually means here, restated plainly

Not "we're confident this is secure." Specifically:

- Every number a player sees can be recomputed by a stranger from public
  data alone, with the published open-source formulas, and will match
  exactly — every time, byte for byte.
- No admin key, owner role, or deployer privilege can change who wins, what
  the odds are, or who gets paid, at any point in the lifecycle.
- Every failure mode (operator goes dark, nobody backs the winner, a bribe
  target loses) has an explicit, pre-decided, non-discretionary resolution —
  not a case that falls through to "the team will handle it manually."
- The settlement math is bounded by construction: it is not possible for
  total payouts to exceed total stakes, in any code path, for any input.

That's the actual bar — not a marketing claim, a testable one.
