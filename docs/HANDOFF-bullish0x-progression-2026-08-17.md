# Handoff: PlankProgression (rank/leveling system) — for bullish0x

Branch: `feat/plank-arcade-crash-derby-local`
Commits in scope: `6cd4473`, `9da0f0a`, `7ecb87a`, `88be91e`, `4ee73bb`

## What this is

A rank/leveling system for PlankCrash: every wallet has a rank —
**Sapling → Stick → Board → Plank → Big Beam → Wooden Whale** — earned by
playing rounds and wagering ETH. Rank raises a wallet's max bet and lowers
the entry premium it pays on larger bets.

It exists to raise the cost of the known whale-cap-bypass attack (splitting
one bettor's capital across many wallets to exceed the existing 60%
per-wallet pool cap). **It does not, and cannot, eliminate that attack** —
there is no on-chain identity layer here, so nothing stops a determined
attacker from grinding N wallets to Sapling/Stick rank in parallel. What it
does is make that attack cost real time and gas per wallet instead of being
free, and it makes the legitimate, single-wallet path strictly cheaper and
higher-cap than the split-wallet path at every rank above Sapling. See the
header comment in `contracts/PlankProgression.sol` for the full reasoning,
including why naive quadratic-funding-style weighting was considered and
rejected (it makes Sybil-splitting *more* profitable without an identity
layer, not less — √N aggregate weight gain).

## Architecture

- **`contracts/PlankProgression.sol`** — the rank contract itself. Tracks
  `roundsPlayed`, `cumulativeWagered` (gross, pre-premium), `fuelBurns`,
  `powerboardClaims`, `firstBetAt` per wallet. `rankOf()` evaluates
  top-down (Wooden Whale → Sapling), each rank requiring ALL of its own
  thresholds. Pure view functions for the cap and premium; state-mutating
  `recordBet`/`recordFuelBurn`/`recordPowerboardClaim` are restricted to
  the three specific contracts that call them (`onlyCrash` /
  `onlyFuelBooster` / `onlyPowerboard` modifiers checking `msg.sender`
  against immutable addresses set in the constructor).

- **`contracts/IPlankProgression.sol`** — minimal interface the three
  integrated contracts import, so they don't need PlankProgression's full
  source.

- **Wiring pattern**: `PlankCrashDrand`, `PlankFuelBooster`, and
  `PlankPowerboard` each got a `setProgression(address)` function —
  **deployer-gated (checks `msg.sender == _deployer`, captured
  automatically in the constructor), settable exactly once**. This was a
  deliberate choice over two alternatives:
  - A constructor parameter would have forced updating every existing
    test file and deploy script that constructs these contracts, for a
    purely optional feature. Rejected.
  - A fully permissionless setter would let a front-runner grief a fresh
    deploy by wiring in a garbage address before the real one, since
    progression calls aren't wrapped in try/catch (a malicious
    `progression` contract could permanently revert every future
    `placeBet`). Rejected.
  - Deployer-gated, one-time: narrow blast radius, doesn't touch funds,
    zero backward-compat cost. **Chosen.**

  **With `progression` unset (the default, `address(0)`), every contract's
  behavior is byte-for-byte identical to before this feature existed** —
  this is the load-bearing property that let this ship without touching
  any of the 11 pre-existing test files. Verified by running the full
  suite after each integration step (see Testing below).

- **Entry premium**: skimmed into the real Vault `reserve` (via
  `fundVault`'s own accounting path — `VaultFunded` event, `_spillOverflow()`),
  never counted toward the bettor's own pool stake. A bet at or below
  `FIRST_BET_EXEMPT_WEI` (0.01 ETH) is never taxed, regardless of rank —
  a brand-new wallet's first small bet is always free of the entry fee.

- **`carryForwardStake()` deliberately has no progression call** — it
  moves already-recorded capital between rounds, and running it through
  `recordBet` again would double-count wagering volume that was already
  attributed on the original bet.

- **`placeBetFor(address player)` attributes progression to `player`, not
  `msg.sender`** — this is PlankBank's session-key delegated-betting path;
  the player who owns the bet should be the one whose rank advances, not
  whichever key happened to submit the transaction.

## Rank table

| Rank | Rounds | Wagered | Cap | Entry premium |
|---|---|---|---|---|
| Sapling | — | — | 0.02 ETH | 15% |
| Stick | 5 | 0.1 ETH | 0.05 ETH | 10% |
| Board | 20 | 0.5 ETH | 0.1 ETH | 6% |
| Plank | — | 0.5 ETH | 0.25 ETH | 3% |
| Big Beam | — | 2 ETH | 0.5 ETH | 1% |
| Wooden Whale | — | 10 ETH + 7d tenure | uncapped | 0% |

All thresholds/caps/premiums are named constants at the top of
`PlankProgression.sol` — tune there, not in the UI.

## Testing

- `test/contracts/PlankProgression.test.ts` (11 tests) — isolated rank
  math and access control, using EOA stand-ins for the three source
  contracts.
- `test/contracts/PlankCrashDrand.progression.test.ts` (6 tests) — full
  wired-up integration against a real `PlankCrashDrand`: deployer-gated
  one-time wiring, byte-identical unset behavior, cap rejection, premium
  landing correctly in `reserve`, exemption threshold, and a full scenario
  grinding real settled rounds until rank genuinely advances and unlocks a
  larger bet.
- `test/contracts/PlankFuelBooster.test.ts` / `PlankPowerboard.test.ts` —
  +2 tests each, appended to existing fixtures, covering the optional
  wiring on those two contracts.
- Full suite: **264/264 passing** (`npm run test:contracts`), zero
  regressions against the pre-existing 254.

## Frontend

- **`public/arcade/crash.html`** — rank chip in the topbar (matches the
  existing Powerboard chip's style/pattern exactly), click-through popover
  with max bet / rounds played / total wagered / progress bar to next
  rank, rank-up celebration (reuses the existing `toast()` + `celebrate()`
  infra — gold toast, particle burst), and a rank-aware
  `StakeExceedsCap` error message in `friendlyRevertReason()`.
- **`public/arcade/dev-panel.html`** — rank lookup for any test account,
  plus a "Fast-forward 7 days" button (`evm_increaseTime` + `evm_mine`,
  devnet-only) to test Wooden Whale's tenure requirement without waiting
  a real week.
- **`scripts/local-casino-setup.ts`** — deploys `PlankProgression` and
  wires it into the other three contracts; writes `progression` into
  `deploy-addresses.local.json`, which `crash.html`/`dev-panel.html` both
  auto-sync from on load.
- **`public/arcade/plankcrashv2-abi.json`** — regenerated from the
  compiled artifact; includes `setProgression`, `progression()`,
  `ProgressionAlreadySet`, `NotDeployer`.

## Verified

- Fresh local deploy → `crash.progression()` matches the manifest address
  on-chain.
- All four progression view functions used by the UI (`rankOf`, `capFor`,
  `wageredNeededForNextRank`, `statsOf`) resolve correctly against the
  live contract with the exact signatures the UI calls.
- Live browser check (crash.html + dev-panel.html): rank chip renders,
  popover populates, dev-panel rank lookup logs correct values — zero
  console errors in either page.
- `npm run lint:inmotion`: clean.
- `npm run test:market` + `npm run test:contracts` (= `npm test`):
  473 + 264 passing, 0 failing.

## Known pre-existing issues (NOT introduced by this work — do not attribute to progression)

- `npx tsc --noEmit` fails on `types/ethers-contracts/.../OwnershipBurner*`
  (a `target` property in that contract collides with ethers' own
  `BaseContract.target`) and on BigInt-literal / ES2020-target errors in
  `scripts/casino-keeper.ts`, `scripts/deploy-casino.ts`, and
  `scripts/local-casino-setup.ts` (the tsconfig `tsc --noEmit` uses at the
  repo root targets a lower ES version than the tsconfig Hardhat/ts-node
  actually run scripts against — these files run fine via
  `npx hardhat run`, they just fail the root-level standalone type check).
- `npm run build` fails for the same BigInt-literal reason, specifically
  in `scripts/casino-keeper.ts:173`.
- Confirmed both were present before any of this session's changes (none
  of the files above were touched by this work except
  `local-casino-setup.ts`, and its errors are on lines I didn't add, in
  the same pre-existing style as the rest of the file).

## What's NOT done yet

- No PR opened. Should branch from `origin/dev` per `CONTRIBUTING.md` and
  target `base: dev`.
- The pre-existing `tsc`/`build` failures above are real and should
  probably be fixed in their own, separate, unrelated PR before or after
  this one — they'll block CI on ANY PR touching those files' import
  graph, not just this one.
- A public-facing marketing/education one-pager explaining the whole game
  (crash mechanics, pari-mutuel payout, Vault, Powerboard, Fuel Booster,
  progression) in plain language, requested separately — not part of this
  contract/UI work, tracked independently.
