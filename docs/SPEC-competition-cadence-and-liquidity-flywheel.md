# Competition Cadence, Game Theory, and the Rake → Liquidity Flywheel

Cross-game design doc — applies to every provably fair competition this
product ships (ETH crash, PLANK crash, Plank Derby racing per
`docs/SPEC-plank-derby-racing.md`). Two questions, answered together because
they're the same underlying concern from two angles: **how fast do we run
competitions while the community is small**, and **where does the rake go so
every round leaves $PLANK stronger, not just the house richer**.

**Status**: design only, no code written. Every contract/address/file cited
below was independently verified against this actual repo before being
written down — see the correction commit on `docs/plank-derby-racing-spec`
(PR #65) for exactly why that verification step is non-negotiable now: an
earlier draft of the racing spec cited three files and a doc that don't exist
in this repo at all (they exist in an unrelated sandbox worked on the same
session). Every citation here has been checked the same way this time,
first, not after a mistake was caught.

---

## Part 1 — Why concentrate to one competition per day right now

### The actual game-theory problem with a young community

A pari-mutuel pool's fairness and its *feel* both depend on depth. With very
few participants, two real failure modes show up that don't exist once a pool
is deep:

1. **Degenerate payouts.** If two people bet on a race and only one backs the
   winner, that one bettor collects almost the entire pool — not because the
   math is wrong (it isn't; the settlement formula in
   `SPEC-plank-derby-racing.md` §4.4 is still correctly bounded), but because
   a 2-person pool isn't really a *competition* in any meaningful sense. It's
   a coin flip with extra steps, and it reads that way to everyone watching.
2. **Single-whale domination.** A well-capitalized actor who shows up to a
   thin pool and takes one side captures a disproportionate share of that
   round's payout economics — not by cheating (the outcome is still
   provably random), just by being the only meaningful liquidity in the
   room. Over enough thin rounds, this quietly transfers value from casual
   small bettors to whoever's willing to show up every time with size.

**The fix is concentration, not restriction.** Splitting a small community's
total activity across many parallel or frequent competitions divides
attention and stakes thinner *per event* than concentrating it into one. Real
horse racing tracks do the same thing on purpose — a scheduled card of
meaningful races produces better odds discovery and fairer payouts than
continuous racing would, for exactly this reason. One competition per day,
for now, is the version of this product that actually has deep enough pools
to be fair and to feel like something real is happening.

### This is a floor, not a permanent limit — see §1.4 for the actual scaling path.

## 1.1 — Degenerate-round protection (new rule, goes beyond the racing spec as written)

Add an explicit **minimum viable pool** before a competition is allowed to
settle normally:

```
MIN_PARTICIPANTS   = 5   (tunable, see §1.3's governance mechanism)
MIN_POOL_SIZE      = a real, disclosed floor in the competition's stake asset
```

If a competition locks (betting closes) without meeting both thresholds, it
**voids automatically**: every stake refunds in full, no rake is taken, no
payout is computed. This isn't a judgment call made after the fact — it's a
hard contract-level branch, checked once at the `OPEN → LOCKED` transition,
with no discretion for anyone (including the deployer) to override it either
direction. This single rule removes the "thin pool exploit" *by construction*
rather than by trusting nobody tries it.

## 1.2 — Whale-domination protection

Even above the minimum, one wallet's stake shouldn't be able to structurally
dominate a small pool's economics:

```
MAX_STAKE_PER_WALLET = min(fixed absolute cap, POOL_SHARE_CAP_BPS of
                            current pool size at time of bet)
```

Recommend a simple flat share cap for v1 — e.g., **no single wallet's stake
counts toward more than 30% of a competition's pool** (excess above that is
simply rejected at bet time, not capped-and-refunded-later, so the bettor
knows immediately). This is deliberately simple rather than a fancier
progressive/quadratic weighting — matches the "keep it simple while the
community is small" instruction directly, and can be revisited once pools are
consistently deep enough that a single wallet hitting 30% is already
practically rare.

## 1.3 — Cadence enforcement must be contract-level, not a cron job

The "one per day" rule only means something if it can't quietly stop being
true. A backend scheduler that just happens to run once a day is not
enforcement — it's a convention that silently breaks the moment a deploy
script has a bug, a server restarts wrong, or someone spins up a second
competition by hand "just this once."

```solidity
uint256 public lastCompetitionStart;
uint256 public minCompetitionInterval = 1 days; // starting value

function createCompetition(...) external {
    require(
        block.timestamp >= lastCompetitionStart + minCompetitionInterval,
        "cadence: too soon"
    );
    lastCompetitionStart = block.timestamp;
    // ... create the competition
}
```

Nobody — not the team, not an admin key, not a compromised backend — can
create a second same-day competition without either waiting out the interval
or changing `minCompetitionInterval` through the real, visible governance
path in §1.4. That's what makes this "impenetrable" in the literal sense:
the rule is enforced by the same contract that runs the competition, not by
a promise about how the team operates it.

## 1.4 — Scaling the cadence: a real governance path, not a silent admin lever

`minCompetitionInterval` needs to be adjustable — the whole point is scaling
as the community grows — but an instantly-effective admin call to change it
would just relocate the trust problem rather than solve it (an admin key that
can silently double the competition frequency is exactly the kind of lever
this whole design is trying to avoid). The pattern:

```
queueCadenceChange(newInterval)  →  [public timelock delay, e.g. 48h]  →  executeCadenceChange()
```

Anyone can call `queueCadenceChange`, the event is public and on-chain the
moment it's queued, and the change only takes effect after the timelock —
long enough that the community sees it coming and can react before it's
live. This is a real pattern this session has used before (crash/racing
design conversation referenced a queue-then-execute timelock shape earlier
in this design process — worth building fresh here since, per the citation
correction above, no existing contract in *this* repo has a timelock
implementation yet to copy from directly).

## 1.5 — Objective graduation thresholds, published

Don't scale cadence on a vibe. Publish real, measurable criteria and let the
community watch progress toward them — this doubles as a genuine hype
mechanic (per `SPEC-plank-derby-racing.md` §7's "hype from real mechanics,
not manipulation" principle):

```
Eligible for 2/day when, over the trailing 10 competitions of that game type:
  - average unique participants  >= N1
  - average pool size            >= P1 (in the competition's stake asset)
  - zero voided (degenerate) rounds in the trailing 10
```

Each threshold tier (2/day → 3/day → multiple concurrent game types) gets its
own published numbers, and — importantly — **each game type graduates
independently**. ETH crash proving itself doesn't automatically unlock a
second daily PLANK crash slot; each game earns its own cadence increase on
its own real numbers. This is the same staged-rollout discipline already
applied to which game ships first (`SPEC-plank-derby-racing.md` §8) extended
into an ongoing operating rule, not just a launch-sequence decision.

---

## Part 2 — The rake, and the permanent-liquidity flywheel

### The mandate

Every game's rake (the fixed cut taken from a settled pool, per
`SPEC-plank-derby-racing.md` §4.4) should be **collectively positive-sum
toward $PLANK**, not just revenue. Concretely: split the rake between real
operating funds and a mechanism that **permanently deepens the actual
PLANK/WETH liquidity pool** — not a straight token burn (which reduces
supply but does nothing for the people actually trying to trade the token),
and not a treasury buy-and-hold (which does nothing for liquidity either).
Buying PLANK and adding it as permanent liquidity does both: it's real buy
pressure, and it makes every future trade on the pool tighter, which is a
durable public good funded by game activity rather than a marketing line.

### The mechanism

**Split** (proposed default, adjustable through the same queue-then-timelock
governance pattern as §1.4 — not a silent lever):

```
rake
 ├─ DEV_SHARE_BPS      (proposed default: 40%) → real operating funds, sent
 │                                                 directly to a disclosed
 │                                                 treasury address
 └─ LIQUIDITY_SHARE_BPS (proposed default: 60%) → the permanent-liquidity flow below
```

**Permanent-liquidity flow**, run by a permissionless keeper function anyone
can call (no one needs to trust the team to remember to run it):

```
1. harvestRake() collects the accumulated LIQUIDITY_SHARE from every
   settled competition since the last harvest.
2. Half of that amount swaps for $PLANK via the real Uniswap Universal
   Router already used throughout this codebase
   (lib/constants.ts's UNIVERSAL_ROUTER_ADDRESS, verified real and already
   in production use here) -- with a real slippage bound, not an unlimited
   swap, so a thin-liquidity moment can't be sandwiched into a bad price.
3. The resulting PLANK + the remaining WETH-equivalent are added as
   liquidity to the real, existing PLANK/WETH v2 pool
   (0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73 -- the deepest of $PLANK's
   five real pools, independently verified in both lib/plank-price.ts and
   docs/ARCHITECTURE_MAP.md in this exact repo, not assumed).
4. The LP tokens minted by that deposit are sent to the same burn address
   this codebase already uses for the same "permanently gone" purpose
   (lib/constants.ts's BURN_ADDRESS, 0x000...dEaD) -- never to a treasury,
   never to any address anyone controls. The liquidity is added forever;
   nobody, ever, can withdraw it.
5. A small keeper tip (proposed default: 0.5-1% of the harvested amount)
   goes to whoever called harvestRake() -- this is what makes "reliably
   automated" actually true. A permissionless function nobody is
   economically motivated to call just doesn't get called; a small,
   disclosed tip means anyone (a bot, a community member, the team itself)
   is incentivized to keep the flywheel turning without needing to trust
   that the team remembers to babysit it.
```

### One real, unconfirmed dependency — flagged, not assumed

Swapping (step 2) goes through `UNIVERSAL_ROUTER_ADDRESS`, which is real and
already used for swaps throughout this repo. **Adding liquidity to a
Uniswap v2 pool (step 3) is typically a different contract** — the classic
`UniswapV2Router02`-style `addLiquidity` function — and **no v2 router
address exists anywhere in this repo's constants today** (checked directly;
only the pool address itself and the swap-side Universal Router are
present). This needs a real, independently verified address before step 3
can be implemented — the same verification discipline this whole document
was written under, not a placeholder to fill in later without checking.

### Why the LP tokens get burned rather than held

Burning the LP tokens (rather than holding them in a treasury) is what makes
this "forever" in the way the request asked for: a treasury-held LP position
is a lever someone could, in principle, someday withdraw — burning it removes
that possibility structurally, the same way `MarketplankVaultV3.sol`'s own
"no admin withdrawal of pool ETH" design principle (verified in this repo,
cited correctly this time) removes discretionary withdrawal from that
contract. The liquidity becomes a permanent floor under the token, funded
continuously by real game activity, not a promise about how a treasury will
be managed.

### Reliability concerns, named explicitly

- **MEV/sandwich risk on the swap step** — mitigated by a real slippage
  bound (revert if the swap would move price beyond a fixed tolerance),
  same class of protection this codebase's swap routes already need to have
  correct regardless of this feature.
- **Keeper liveness** — mitigated by the tip in step 5; if that still proves
  insufficient in practice, a fallback is a second, larger tip that scales
  up the longer the harvest goes uncalled (bounded, so it can't be gamed
  into taking the whole rake) — not specced further here since it's a
  tuning question, not a structural one.
- **Dust/frequency tradeoff** — harvesting after every single competition
  vs. batching several rounds' rake together before harvesting is a real
  gas-cost-vs-timeliness tradeoff. Given competitions run at most once a day
  per game type right now (Part 1), batching isn't really necessary yet —
  revisit once cadence scales up.

---

## Summary — every rule, where it's enforced, what breaks it

| Rule | Enforced by | What happens if violated |
|---|---|---|
| One competition per day (per game type) | `createCompetition`'s on-chain interval check (§1.3) | Transaction reverts — there is no path around it except the timelocked governance change |
| Degenerate rounds don't settle unfairly | `OPEN → LOCKED` transition's participant/pool-size check (§1.1) | Automatic full refund, zero rake taken, no discretionary override |
| No single wallet dominates a thin pool | Per-bet stake cap check (§1.2) | Bet rejected immediately at placement, not after the fact |
| Cadence changes are visible before they're live | Queue-then-timelock pattern (§1.4) | A change cannot take effect same-block; the community has the full timelock window to see it coming |
| Every round leaves $PLANK's liquidity stronger | Permissionless `harvestRake()` + LP-token burn (§2) | Nothing can be skipped by inaction — anyone can call it, and the tip means someone eventually will |
| The permanent liquidity really is permanent | LP tokens sent to `BURN_ADDRESS`, never a treasury (§2) | No withdrawal path exists for anyone, including the team |

This is the same bar `SPEC-plank-derby-racing.md` §9 already set for the
racing game's fairness math, extended to the operating rules around every
competition this product runs: not "we're confident," but specific,
checkable claims about what a contract will and won't allow.
