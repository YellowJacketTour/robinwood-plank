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

## 1.1 — The daily sourcing/trigger model, precisely (revised — supersedes the
first draft of this section)

**Sourcing is continuous, not a hard-reset daily window.** Every game type
has exactly one live "sourcing pool" at all times, accepting stakes
continuously. Once a day, on a fixed clock, anyone can permissionlessly call
`triggerGame()`. What happens depends on what's actually in the pool at that
moment — this is the literal mechanism behind "real collateral sourced, or
no game launches":

```
function triggerGame() external {
    require(block.timestamp >= nextTriggerAt, "too early");
    if (pool.participants >= MIN_PARTICIPANTS && pool.total >= MIN_POOL_SIZE) {
        // Real collateral threshold met: snapshot everything sourced so
        // far, lock it in as today's game, and open a BRAND NEW empty
        // pool immediately -- sourcing for tomorrow starts in the same
        // transaction the current game locks, with zero gap.
        _lockAndLaunch(pool);
        pool = newEmptyPool();
    }
    // Threshold NOT met: do nothing to the pool. No game launches today
    // -- exactly as asked for -- but nothing is refunded or disturbed
    // either. The same pool keeps accumulating stakes it already had,
    // plus whatever sources in over the next 24h, and gets checked again
    // at the next trigger. A stake placed on a "quiet" day isn't lost or
    // returned -- it's simply still there, waiting for the pool it's part
    // of to actually clear the real-collateral bar.
    nextTriggerAt = block.timestamp + TRIGGER_INTERVAL; // 1 days
}
```

This reconciles every part of the request simultaneously:
- **"1 contest per game type per day"** — the trigger clock is fixed and
  daily, full stop.
- **"Guaranteed only running real games with real collateral sourced, or no
  game launches"** — the threshold check is a hard gate with no
  discretionary override in either direction; an under-collateralized day
  genuinely produces no game.
- **"Immediately begin sourcing funds for next game next day"** — sourcing
  never actually stops; a successful trigger just snapshots-and-resets in
  one atomic step, so there's no "off" period between one game locking and
  the next day's pool being open.
- **"No risk of users losing funds"** — nobody's stake is force-refunded
  just because one day's check came up short. It stays committed toward
  whichever day's pool eventually does clear the bar.

## 1.1a — "Maybe no refundable entries?" — yes, with one real safety valve

Confirmed: **entries do not unilaterally withdraw once staked into the live
sourcing pool.** This is the actual answer to "guaranteed liquidity" — the
failure mode a refundable-entry design has is a last-second bank run right
before `triggerGame()` fires, where participants who staked early pull out
the moment they suspect the pool won't clear the bar (or, worse, right after
it does, trying to un-commit from a game they no longer like the odds of).
PoolTogether's own production design hits this same tension and resolves it
the same direction: their docs describe "early withdrawal penalties that
maintain system integrity by preventing strategic deposits [and exits]
immediately before prize drawings" — this isn't a novel restriction, it's
the same real, audited precedent already field-tested at scale.

**The safety valve that keeps this from ever becoming "funds trapped
forever"**: if a pool goes an extended period without a single successful
trigger (proposed default: 30 days of continuous under-threshold checks),
individual participants unlock the ability to withdraw their own original
stake from that specific stale pool — a real, hard-coded, non-discretionary
escape hatch, not something that requires anyone's permission or
intervention. This is what makes "no refundable entries" compatible with
"no risk of users losing funds": entries are locked *while there's a
realistic path to a real game*, and unlock automatically the moment that
stops being true for long enough to matter.

## 1.1b — Timestamp-trigger manipulation, named and closed

A real, historical lesson worth building against directly: a 2024 lottery
exploit extracted **$12M** by manipulating timestamp validation to claim
already-expired prizes, and the older EtherLotto contract had the same class
of bug (timestamp-dependence around its draw trigger). Two concrete
mitigations, both already implicit in the design above but worth stating as
hard requirements:
- `triggerGame()` is a **tolerance window, not a knife-edge instant** — it's
  permissionlessly callable any time *at or after* `nextTriggerAt`, not
  required to land at an exact block. There's no "claim an expired prize"
  window at all, because nothing about the payout depends on exactly when
  within that window the trigger fires — only the roster/outcome seeds
  (`SPEC-plank-derby-racing.md` §4.1) do, and those are independent of
  `triggerGame()`'s own timing.
- No path anywhere in this design reads `block.timestamp` to compute a
  payout amount, an odds calculation, or anything financially meaningful —
  it is used exclusively as a gate (has enough time passed to check again),
  never as an input to a value calculation. This closes the entire class of
  bug both real incidents above share.

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

## 1.3 — Cadence enforcement is contract-level by construction, not a cron job

The "one per day" rule only means something if it can't quietly stop being
true. A backend scheduler that just happens to run once a day is not
enforcement — it's a convention that silently breaks the moment a deploy
script has a bug, a server restarts wrong, or someone spins up a second
competition by hand "just this once." §1.1's `triggerGame()` *is* this
enforcement, directly — `require(block.timestamp >= nextTriggerAt, ...)`
is the same interval-gate idea, just merged into the one function that also
does the real-collateral check, rather than living as a separate
`createCompetition` gate that could theoretically drift out of sync with it.
One function, one gate, no second code path that could disagree with it.

Nobody — not the team, not an admin key, not a compromised backend — can
trigger a second same-day competition, or force one to launch under the
real-collateral threshold, without changing `TRIGGER_INTERVAL` or
`MIN_PARTICIPANTS`/`MIN_POOL_SIZE` through the real, visible governance path
in §1.4. That's what makes this "impenetrable" in the literal sense: the
rule is enforced by the same contract that runs the competition, not by a
promise about how the team operates it.

## 1.4 — Scaling the cadence: a real governance path, not a silent admin lever

`TRIGGER_INTERVAL` (and the collateral thresholds) need to be adjustable —
the whole point is scaling as the community grows — but an instantly-
effective admin call to change either would just relocate the trust problem
rather than solve it (an admin key that can silently double the competition
frequency, or silently lower the real-collateral bar, is exactly the kind of
lever this whole design is trying to avoid). The pattern:

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
Eligible for 2/day when, over the trailing 10 triggered games of that type:
  - average unique participants     >= N1
  - average pool size               >= P1 (in the competition's stake asset)
  - zero under-threshold trigger checks (§1.1) in the trailing 30 days --
    i.e. every day's trigger actually launched a game, nothing rolled
    forward for lack of real collateral
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

## Part 3 — Zero exploit surface, closed against real, named incidents

"Low to no collateral" is already true of everything in this doc by
construction — the pari-mutuel model (`SPEC-plank-derby-racing.md` §4.4)
means the protocol never holds or risks its own capital; every dollar in
every pool is a user's own voluntary stake. What's specified here is the
remaining question: how the contracts holding *that* capital, for the time
it's genuinely in flight, avoid every real, documented way this exact class
of contract has actually been broken before. Every mitigation below is
tied to a real, named incident — not a hypothetical.

### 3.1 — Pull payments only, everywhere. Named incidents: Akutars ($34M),
King of the Ether, and the "Puppy Raffle" pattern taught as a canonical
teaching example in modern Solidity security courses specifically because
it's this common.

All three are the same root cause: a contract loops over recipients and
pushes payment to each one directly. One recipient with a reverting
fallback (malicious or just broken) permanently freezes the *entire*
distribution for *every* other winner too — Akutars lost $34M this way.

**Hard requirement**: every payout in this system — competition winnings,
bribe-pool shares, dev share, keeper tips, the emergency stale-pool
withdrawal in §1.1a — is **pull-based**. The contract only ever records
"this address is owed this amount"; the address claims it in its own
separate transaction, paying its own gas, on its own schedule. No function
anywhere loops over a list of winners and sends them money. This isn't a
style preference — it's the specific, direct fix for a $34M-and-counting
class of real loss.

### 3.2 — No unbounded loops, anywhere, ever

Same root vulnerability class as above, one level more general: any loop
whose length depends on the number of participants (refunding a roll-forward
pool, computing an all-time leaderboard, tallying bribe backers) will work
fine at 10 users and silently become unusable — not exploitable, just
*broken*, a real and common failure mode distinct from but related to 3.1 —
once participation exceeds what a single transaction's gas limit allows. All
per-user amounts owed are computed and stored individually, read via mapping
lookup, never summed by iterating a growing list inside a single
transaction.

### 3.3 — Reentrancy guards on every state-changing external function.
Named incident: Penpie DeFi, $27M, 2024 — a real, recent, non-hypothetical
loss, not a 2016-era cautionary tale.

`ReentrancyGuard` + `nonReentrant`, same as this repo's own
`MarketplankVaultV3.sol` already applies to every state-changing external
function (verified directly against the real file), applied identically
here. Checks-effects-interactions ordering throughout — state updates before
any external call or token transfer, never after.

### 3.4 — No admin custody of user funds, at any point, for any reason

Every dollar in a live sourcing pool sits in the pool contract itself, not
in a wallet or multisig anyone controls. There is no `withdraw()` function
callable by a deployer, owner, or any privileged role, on any contract in
this system — matching the exact bar `MarketplankVaultV3.sol` already sets
for this repo ("no admin withdrawal of pool ETH," verified). The only two
places value ever leaves a pool are (a) a user's own pull-claim of something
they're individually owed, and (b) the disclosed, non-discretionary rake
split in Part 2 (which itself has no admin lever — see Part 2's own
"nobody, ever, can withdraw it" property for the burned LP tokens
specifically).

### 3.5 — Randomness is commit-reveal, never derived from anything
predictable. Named incident: Roast Football Protocol, insecure RNG seeded
from block number, timestamp, and caller address/balance — all fully
predictable to the caller in advance.

Already the design in `SPEC-plank-derby-racing.md` §4.1 — the two-seed
commit-reveal split, never `block.timestamp`/`blockhash`/caller-derived
values used as entropy for anything that decides an outcome. Restated here
because it's directly load-bearing for the "zero exploit surface" claim,
not a separate concern from it.

### 3.6 — The liquidity-flywheel swap (Part 2) gets its own, stronger price
protection. Named incidents: multiple real flash-loan oracle-manipulation
drains (Mango Markets, $112M; an INV-token TWAP manipulation, $15.6M; a
plvGLP oracle manipulation, ~$6.5M) — the common pattern in all of them is a
contract trusting a price it read from a thin, manipulable pool in the same
transaction an attacker controls.

`harvestRake()`'s PLANK-side swap (Part 2, step 2) is the one place in this
whole design that touches an AMM price at all — everything else is pure
pari-mutuel math with no external price dependency whatsoever. That makes it
the single highest-value target for exactly this attack class, and it needs
real, specific protection beyond a generic slippage bound: a time-weighted
reference price (TWAP over a real window, not the instantaneous spot price
of the same pool being traded into) as the sanity check the swap's actual
execution price is compared against, reverting if they diverge beyond a
tight tolerance. A flat slippage percentage alone is not sufficient here,
specifically because the swap and the manipulation would both be touching
the *same* thin pool this flywheel is trying to deepen — the exact setup
every cited incident above exploited elsewhere.

### 3.7 — Professional audit is a hard gate, not a nice-to-have, before any
real value flows through any of this

Every pattern above is a real, well-understood mitigation for a real,
named, dollar-denominated incident — but "we followed the checklist" is not
the same claim as "an independent expert reviewed this specific
implementation and found no way around it." No contract in this document
should hold real user funds before a professional (non-AI) audit has
reviewed it specifically against this document's own claims — the same
bar already implicit in `docs/SPEC-plank-derby-racing.md` §1's rollout
phases, restated here as a hard requirement rather than an implication.

---

## Summary — every rule, where it's enforced, what breaks it

| Rule | Enforced by | What happens if violated |
|---|---|---|
| One competition per day (per game type) | `triggerGame()`'s on-chain interval + collateral gate, one function (§1.1, §1.3) | Call reverts if too early; silently rolls forward (no game, no loss) if collateral is short — there is no path around either case except the timelocked governance change |
| Guaranteed real collateral or no launch | `triggerGame()`'s `MIN_PARTICIPANTS`/`MIN_POOL_SIZE` check (§1.1) | Pool simply doesn't snapshot/launch that day — no discretion, no override, nothing lost |
| No last-second bank runs on a sourcing pool | No unilateral withdrawal function on a live pool (§1.1a) | Withdrawal calls revert until either a successful trigger includes that stake in a real game, or the 30-day stale-pool safety valve unlocks it |
| Funds are never permanently trapped | 30-day no-trigger emergency withdrawal (§1.1a) | Individual withdrawal unlocks automatically, no admin action needed |
| Trigger timing can't be gamed | Tolerance-window trigger, `block.timestamp` never used in a value calculation (§1.1b) | Closes the exact bug class of the real $12M 2024 lottery exploit and EtherLotto |
| No single wallet dominates a thin pool | Per-bet stake cap check (§1.2) | Bet rejected immediately at placement, not after the fact |
| Cadence/threshold changes are visible before they're live | Queue-then-timelock pattern (§1.4) | A change cannot take effect same-block; the community has the full timelock window to see it coming |
| Every round leaves $PLANK's liquidity stronger | Permissionless `harvestRake()` + LP-token burn (§2) | Nothing can be skipped by inaction — anyone can call it, and the tip means someone eventually will |
| The permanent liquidity really is permanent | LP tokens sent to `BURN_ADDRESS`, never a treasury (§2) | No withdrawal path exists for anyone, including the team |
| No payout distribution can freeze (Akutars/King-of-Ether/Puppy-Raffle class) | Pull payments only, no push loops anywhere (§3.1) | One bad recipient can never block anyone else's claim |
| No participant-count-dependent gas blowup | No unbounded loops over participant lists (§3.2) | Every function's gas cost stays flat regardless of how many people have ever played |
| No reentrancy drain (Penpie class) | `ReentrancyGuard`/`nonReentrant` on every state-changing function (§3.3) | Reentrant call reverts |
| No admin can ever move user funds | No `withdraw()` on any contract, verified against no privileged role anywhere (§3.4) | There is no function to call — the capability doesn't exist in the bytecode |
| No predictable-outcome exploit (Roast Football class) | Two-seed commit-reveal, never `block.timestamp`/caller-derived entropy (§3.5) | Outcome is cryptographically unpredictable before reveal, independently verifiable after |
| No flash-loan price manipulation on the liquidity-flywheel swap (Mango/INV/plvGLP class) | TWAP-referenced execution-price check, not spot-only slippage (§3.6) | Swap reverts if execution price diverges from the time-weighted reference beyond a tight tolerance |
| Nothing above is trusted on claim alone | Professional (non-AI) audit gate before real funds (§3.7) | No contract in this system holds real user value until independently reviewed against this document's own claims |

This is the same bar `SPEC-plank-derby-racing.md` §9 already set for the
racing game's fairness math, extended to the operating rules around every
competition this product runs: not "we're confident," but specific,
checkable claims about what a contract will and won't allow.
