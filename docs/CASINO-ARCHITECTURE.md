# plank.love unified casino — architecture & economics

This is the reference for the on-chain casino: the crash game, the shared
randomness, and the community-economics loop that ties them together. It is
written to be honest about what the design does and does not achieve, so the
remaining business decisions (the bps parameters) can be made with eyes open.

Everything here is real, compiled, and tested (`npx hardhat test`, 182 passing
as of this writing). Nothing in this doc is aspirational unless explicitly
marked **OPEN**.

---

## 1. The one-paragraph version

Players bet ETH into a shared pari-mutuel pool on a crash game. A small **rake**
(default 2.5%) is skimmed from each settled round. That rake — instead of
leaking to a disconnected wallet — flows into a **distributor** that splits it
three ways: a slice **buys and burns real $PLANK**, a slice **funds a
wager-weighted ETH raffle** paid back to active bettors, and the remainder goes
to the protocol treasury. Randomness for both the crash point and the raffle
draw comes from **one shared, verify-on-chain drand beacon** that the NFT vault
already uses. The result is not positive-EV for any individual bet (a rake from
a closed pool can't be), but it is **positive-sum for the community**: the rake
stays inside it.

---

## 2. Contracts and how they wire together

```
          bets (ETH)
             │
             ▼
   ┌───────────────────┐   rake    ┌──────────────────────┐
   │  PlankCrashDrand   │──────────▶│ PlankRakeDistributor │
   │  (pari-mutuel game)│           │  (immutable 3-way    │
   └─────────┬──────────┘           │   split, no setter)  │
             │ stakeOf(round,player) └───────┬──────┬───────┘
             │  (read, no coupling)          │      │      │
             │                          burn │  air │ trea │
             │                               ▼  drop▼ sury ▼
             │                    ┌──────────────┐ ┌──────────────┐  (EOA)
             │                    │PlankBurnEngine│ │PlankAirdropPool│
             │                    │ swaps ETH→PLANK│ │ wager-weighted │
             │                    │ and burns it   │ │ ETH raffle     │
             │                    └──────────────┘ └───────┬────────┘
             │                                             │ claimTickets reads
             └─────────────────────────────────────────────┘ the crash's stakeOf

   shared randomness for BOTH the crash point and the raffle draw:
   ┌──────────────┐   verified drand rounds (BN254 BLS, EVM precompiles)
   │  DrandBeacon  │◀── also used, unchanged, by MarketplankVaultV3
   └──────────────┘
```

| Contract | Role | Trust surface |
|---|---|---|
| `PlankCrashDrand.sol` | The crash game. Reads randomness from the shared beacon; pays rake to whatever `treasury` it's configured with. | No owner, no admin. |
| `PlankRakeDistributor.sol` | Immutable 3-way rake split (burn / airdrop / treasury). Push-forwards on receipt. | No owner, no setter — changing the split needs a redeploy. |
| `PlankBurnEngine.sol` | Permissionless swap-and-burn. Caller supplies a real Universal-Router route; the contract verifies the real PLANK balance delta and burns it. | No owner. Swap output can only ever be burned, never redirected. |
| `PlankAirdropPool.sol` | Wager-weighted ETH raffle on a fixed daily schedule. Tickets read from a source's own `stakeOf`. | No owner. Source allowlist is immutable. |
| `DrandBeacon.sol` | Shared, permissionless, verify-on-chain cache of drand rounds. | Deploy-time-verified drand key; no owner. |

The crash variants `PlankCrashV2 / VRF / Entropy` exist as alternative
randomness backends (see their headers). `PlankCrashDrand` is the lead mainnet
candidate because drand needs **no per-chain oracle deployment** — the other
two could not be confirmed live on Robinhood Chain (checked via `eth_getCode`).

---

## 3. The rake, followed end to end

1. Players bet; a round settles. `settleRound()` pays a small keeper reward
   (default 10% of rake) to whoever settled, and accrues the remaining rake.
2. `claimRake()` moves the accrued rake into the crash's PullPayment escrow,
   credited to `treasury` — which on mainnet is the **distributor's** address.
3. Anyone calls `crash.withdrawPayments(distributor)`. The distributor's
   `receive()` fires and splits the ETH: `burnBps` → burn engine, `airdropBps`
   → airdrop pool's current epoch, remainder → protocol treasury.
4. A keeper calls `burnEngine.executeBurn(route, ethAmount, minPlankOut, deadline)`
   with a route built off-chain (Uniswap Trading API, the same aggregator this
   repo's frontend already uses). Real $PLANK is bought and burned.
5. A keeper calls `airdropPool.claimTickets(crash, roundId, player)` for each
   bettor, crediting them tickets equal to their real stake.
6. Once a day, `airdropPool.requestDraw(epoch)` → relay the drand round →
   `airdropPool.drawWinner(epoch)` pays the winner the pot minus a drawer reward.

`scripts/local-casino-setup.ts` deploys this whole loop wired together on a
local node; `test/contracts/CasinoIntegration.test.ts` drives one full round
through it end to end.

---

## 4. Honesty: what this is and isn't

- **Not positive-EV.** A rake extracted from a closed pari-mutuel pool is
  negative-sum for players in aggregate. No mechanic here changes that math, and
  nothing in the code or UI should claim otherwise.
- **Positive-sum for the community.** The rake stays inside the ecosystem: the
  burn benefits $PLANK holders (largely the same people who play), and the
  raffle redistributes to active bettors, instead of the rake leaving to a
  disconnected treasury.
- **Deflation only compounds if total emissions don't outrun it.** Buyback-and-burn
  is real, but most burn programs fail to achieve net deflation because issuance
  elsewhere outpaces them. This only tightens $PLANK supply if $PLANK's overall
  emission schedule allows it — a token-level fact outside these contracts.
- **The draw schedule is fixed on purpose.** Unpredictable reward timing is the
  single strongest known driver of compulsive gambling engagement, and a crash
  game is already one such loop. The raffle draws on a public, deterministic
  daily schedule specifically so it is a predictable bonus, not a second source
  of compulsive uncertainty. **Do not** change this into a surprise trigger.

---

## 5. Security properties worth knowing

- **`presetCashOut` is gated on entropy *availability*, not the on-chain reveal
  flag.** A drand round's signature is public the instant its due time passes;
  gating on the flag would let anyone compute the true crash point off-chain and
  lock a guaranteed win. (Real CRITICAL bug, found in audit, fixed + regression-tested.)
- **The airdrop draw is O(log n).** Tickets are append-only cumulative
  checkpoints; the draw binary-searches. A sybil griefer placing many tiny real
  bets across many addresses cannot bloat the participant set to strand the pot.
- **The burn engine can never leak funds.** The swap output is measured by real
  balance delta and burned unconditionally; there is no code path that sends it
  or the engine's ETH to an arbitrary address. `minPlankOut` lets an honest
  keeper refuse a sandwiched fill.
- **Ticket weight is real stake, read from the source's own public state**, and
  the source must be on an immutable allowlist — otherwise anyone could deploy a
  fake `stakeOf()` reporting unlimited stake.
- **Trust model.** Randomness trusts a threshold of the drand League of Entropy
  (many independent orgs) rather than the single Robinhood sequencer — a
  strictly better assumption, disclosed plainly in `DrandBeacon.sol`.

---

## 6. OPEN decisions (business, not code)

These are exercised with example values in tests and the local deploy, but are
real parameters to set deliberately before mainnet:

- **Rake %** (`rakeBps`, default 2.5%) — the entire community-economics budget.
- **Rake split** (`burnBps` / `airdropBps` / remainder) — example 45/45/10.
- **Keeper/drawer/locker rewards** — sized to guarantee the permissionless
  functions actually get called without a dedicated operator, without meaningfully
  diluting the burn or the pot.
- **Airdrop epoch length** (`epochDuration`, example daily) and burn cadence /
  `maxEthPerCall`.
- **A real keeper process.** Every settle / reveal / relay / burn / draw call is
  permissionless; the reward mechanics make them *worth* doing, but a reliable
  keeper (bot or community) is still needed so the loop runs on schedule. The
  void/rollover fallbacks exist for when it doesn't, but they are a safety net,
  not a substitute.
- **Frontend surfacing** of burn totals, the live raffle pot, a player's ticket
  count, and the honest-EV disclosure — not yet built.

---

## 7. Deploy note: the immutable dependency cycle

The airdrop pool's source allowlist, the crash's treasury, and the distributor's
recipients are all **immutable** (no admin setters, by design). That creates a
3-way cycle: the airdrop needs the crash address, the crash needs the
distributor, the distributor needs the airdrop. It is resolved by predicting the
crash's deploy address from the deployer's nonce and passing it into the airdrop
pool up front — see `scripts/local-casino-setup.ts`. The three core deploys must
be consecutive with no intervening transactions, or the predicted nonce is wrong
(the script asserts the prediction matched).
