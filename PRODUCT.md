# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: crypto-native players ("degens").** People who already hold or trade
$PLANK and other tokens, who understand odds, multipliers, buy-and-burn, and
on-chain fairness claims, and who evaluate a game by whether its math and its
money flow hold up. They play predominantly on **mobile**, in short sessions,
often alongside other market activity, and they return many times a day rather
than sitting for one long session.

Because entry to a table is by **invite code or link from a host**, an invited
friend with no crypto background can land in a live table at any time. They are
not the design target, but nothing in the interface may become unusable or
unexplainable to them.

## Product Purpose

PlankCrash is a multiplayer crash/timing game where a shared flight climbs a
multiplier until it crashes, and each player chooses when to lock in. It exists
to turn play into two compounding public goods: rake buys and burns real
$PLANK, and rake funds a community lottery whose prize can only grow.

Success is a table that runs continuously and honestly: consecutive automatic
rounds with no host present, every player able to commit and lock on any
device, every credit's destination visible, and a lottery that measurably
approaches — and reaches — a real payable draw.

## Positioning

Four mechanisms operate as one integrated system. No neighboring crash game can
truthfully claim all of them:

1. **Parimutuel claim weight, not fixed odds.** Payouts are a shared player pot
   split by stake × ln(lock multiplier) with a survivor floor. The displayed
   multiplier is claim weight, never a fixed stake × multiplier promise, and
   the house never takes the other side of a player's bet.
2. **Rake that buys and burns real $PLANK.** 40% of every round's rake buys
   $PLANK on the open market and burns it. The burn engine can only burn what
   it buys.
3. **A built-in lottery any player can win on a minimum bet.** 40% of rake
   funds a community prize. Ticket weight follows stake, but the draw is
   1-in-16 from committed randomness with a proportional winner selection, so a
   minimum-stake player holds a real, non-zero, provable chance at the full
   sealed prize.
4. **A fully legible economy.** Vault, lottery, burn, and operations are shown
   live in credits, ETH, and USD with the exact formulas, so a player can audit
   the entire money flow while playing.

## Constraints

These are durable product truths. Every future design must preserve all of them.

- **Displayed == redeemable honesty.** Every number shown must reconcile
  exactly with what settles. No component may display a total whose parts sum
  short, and **operator/founder earnings are never shown to players** — the
  operations share is disclosed as a percentage only.
- **Provable fairness surface.** The committed-reveal randomness, the 1-in-16
  draw derivation, and the funded gate must remain visible and verifiable by
  the player. Fairness is a surface, never a marketing claim.
- **Guaranteed lottery reset.** A draw is only possible once the prize *and*
  its reset reserve are sealed, and the prize base never decreases. This must
  always be communicated, including while the prize is still funding.
- **Test credits have no cash value.** The playtest is explicitly a no-value
  laboratory; that disclosure survives every redesign.
- **Multiplier is claim weight, not a payout promise.** Any copy or animation
  implying stake × displayed multiplier is guaranteed is a defect.
- **Fail-closed play.** A lock that arrives after the committed crash is
  refused; committed auto-targets cannot be changed after launch; the UI must
  never advertise an action the server would reject.

## Terminology

- **Flight / round** — one launch, climb, and crash cycle.
- **Lock (lock in)** — claiming your position during flight; the accepted lock
  multiplier is your claim weight. Manual locks may improve on an armed
  auto-lock by locking earlier, never later.
- **Auto-lock** — a target committed with the bet that fires automatically.
- **Claim weight** — stake × ln(lock multiplier); your share of the player pot.
- **Player pot** — stakes after rake, paid entirely to that round's survivors.
- **The Powerboard** — the community lottery funded by the rake's community
  share.
- **Vault (protected principal)** — a reserve that only grows, funded from
  routed rake.
- **Credits** — test-credit unit; 1,000,000 credits = 1 ETH for display.

## Accessibility

Mobile-first reality: the game is played one-handed on phones. The single
primary action (COMMIT before launch, LOCK during flight) must always be
reachable in the thumb zone and never occluded by another surface; touch
targets are at least 44px; the lock control is the most time-critical element
in the product. Motion respects `prefers-reduced-motion` while preserving state
clarity.

## Operating context

Tables are private and invite-based, run automatic sequential rounds with no
host present, and are commonly observed by several devices on the same network
at once. Round cadence is fixed and predictable by design (a deliberate ethical
choice against surprise-timed draws).
