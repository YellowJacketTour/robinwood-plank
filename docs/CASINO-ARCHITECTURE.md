# plank.love unified casino — architecture & economics

This is the reference for the on-chain casino: the crash game, the shared
randomness, and the community-economics loop that ties them together. It is
written to be honest about what the design does and does not achieve, so the
remaining business decisions (the bps parameters) can be made with eyes open.

Everything here is real, compiled, and tested (`npx hardhat test`, 186 passing
as of this writing). Nothing in this doc is aspirational unless explicitly
marked **OPEN**.

---

## 1. The one-paragraph version

Players bet ETH into a shared pari-mutuel pool on a crash game. A small **rake**
(4.5%, of which only 1.8% is a real house edge — see §5a) is skimmed from each settled round. That rake — instead of
leaking to a disconnected wallet — flows into a **distributor** that splits it
three ways: a slice **buys and burns real $PLANK**, a slice **funds a
Powerboard rolling jackpot** paid back to active bettors, and the remainder goes
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
             │                    │PlankBurnEngine│ │PlankPowerboard│
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
| `PlankRakeDistributor.sol` | Immutable 3-way rake split (burn / jackpot / dev). Push-forwards on receipt. | No owner, no setter — changing the split needs a redeploy. |
| `PlankBurnEngine.sol` | Permissionless swap-and-burn. Caller supplies a real Universal-Router route; the contract verifies the real PLANK balance delta and burns it. | No owner. Swap output can only ever be burned, never redirected. |
| `PlankPowerboard.sol` | Rolling jackpot. Wager-weighted tickets read from a source's own `stakeOf`; a daily Plank Ball draw either pays the whole pot or a consolation slice and rolls the rest over. | No owner. Source allowlist is immutable. |
| `DrandBeacon.sol` | Shared, permissionless, verify-on-chain cache of drand rounds. | Deploy-time-verified drand key; no owner. |

The crash variants `PlankCrashV2 / VRF / Entropy` exist as alternative
randomness backends (see their headers). `PlankCrashDrand` is the lead mainnet
candidate because drand needs **no per-chain oracle deployment** — the other
two could not be confirmed live on Robinhood Chain (checked via `eth_getCode`).

---

## 3. The rake, followed end to end

1. Players bet; a round settles. `settleRound()` pays a keeper reward
   (`keeperRewardBps`, currently 0 — see §4b) to whoever settled, and accrues the remaining rake.
2. `claimRake()` moves the accrued rake into the crash's PullPayment escrow,
   credited to `treasury` — which on mainnet is the **distributor's** address.
3. Anyone calls `crash.withdrawPayments(distributor)`. The distributor's
   `receive()` fires and splits the ETH: `burnBps` → burn engine, `airdropBps`
   → the Powerboard jackpot, remainder → dev/ops treasury.
4. A keeper calls `burnEngine.executeBurn(route, ethAmount, minPlankOut, deadline)`
   with a route built off-chain (Uniswap Trading API, the same aggregator this
   repo's frontend already uses). Real $PLANK is bought and burned.
5. A keeper calls `powerboard.claimTickets(crash, roundId, player)` for each
   bettor, crediting them tickets equal to their real stake.
6. Once a day, `powerboard.requestDraw(epoch)` → relay the drand round →
   `powerboard.drawWinner(epoch)` draws the Plank Ball: a hit pays the whole
   rolling jackpot, a miss pays a consolation slice and rolls the rest over.
7. If the whole field busted, `crash.sweepBustedRound(roundId)` rolls that
   round's pot into the next round instead of stranding it.

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

## 4a. Game theory: what the game looks like at 1, 2, and N players

**At 1 player — the round does not run.** `minParticipants` (2) and
`minPoolSize` are checked at lock; failing either voids the round and every
stake carries forward to the next one. No rake is taken, nothing is lost. This
is correct (you always need a real counterparty) but it is a genuine **cold-start
problem**: with one player, nothing ever happens. Note a lone player *can*
bootstrap by betting from two addresses — that isn't an exploit, it just costs
them the rake to play against themselves, and if both entries bust they lose
everything to the rollover.

**At 2 players — a war of attrition, and the payout is counterintuitive.**
This is the case worth understanding, because pari-mutuel does *not* behave
the way players assume. With equal stakes *S* and both cashing out at
multipliers *m₁, m₂*, player 1 receives

```
distributable × m₁ / (m₁ + m₂)
```

The consequences are real and will surprise people:
- **If both cash out at the same multiplier, both LOSE the rake** — even if
  they both rode to 10x. Your multiplier buys a *share of the pot*, not a
  payout rate.
- Real profit at 2 players comes almost entirely from **the other player
  busting** (then you take the whole distributable, ~+91% on your stake).
- So the strategy is pure nerve: cash early for a small guaranteed loss, or
  hold for a chance the other player busts first.

**Collusion doesn't pay.** Two colluding players (or one sybil running both
sides) can only ever get back the distributable, which is strictly less than
what they put in — they simply pay the rake. Pari-mutuel is not exploitable by
coordination.

**At larger N it smooths out** — your multiplier's *relative* rank matters
more than its absolute value, and the "everyone cashed at once" degenerate
outcome becomes vanishingly unlikely. The honest UI consequence at every N:
show `estimatedPayout()` (a real share of a real pot), never `stake ×
multiplier`, which the game never pays.

**And if the whole field busts,** nobody wins — the pot is not stranded, it
rolls into the next round (`sweepBustedRound`). That's the mechanic that makes
a busted round *fund* the next one instead of vanishing.

## 4b. Running forever without a babysitter

Every state-advancing function is permissionless, and the ones that cost gas
carry a reward, so the loop does not depend on any single operator:

| Step | Who can call it | Incentive |
|---|---|---|
| `lockRound` | anyone | — (cheap, and gates everything downstream) |
| relay drand round to the beacon | anyone (`scripts/relay-drand.ts` exists) | — (shared across all consumers) |
| `revealEntropy` | anyone | — |
| `settleRound` | anyone | `keeperRewardBps` of the rake |
| `registerResult` / `claim` | **anyone, on any player's behalf** | — |
| `sweepBustedRound` | anyone | — |
| `executeBurn` | anyone | share of ETH spent |
| `requestDraw` / `drawWinner` | anyone | share of the prize |

Two things to set deliberately before mainnet: **`keeperRewardBps` is currently
0** (fine while the keeper is dev-run; raise it if third-party keepers should be
paid to take over), and someone must actually **run a keeper process** — the
void/rollover fallbacks are a safety net for when nobody does, not a substitute.

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

## 5a. RATIFIED: the rake and its split

Decided, and wired into `scripts/local-casino-setup.ts`:

| Leg | % of pool | % of rake | Purpose |
|---|---|---|---|
| **Dev / ops** | **1.80%** | 40% | Real bills. Memetically anchored to the 8.1% NFT royalty. |
| **Rolling jackpot** | **1.80%** | 40% | Matched 1:1 with the dev take — straight back to players. |
| **$PLANK burn** | **0.90%** | 20% | Deflation for holders. |
| **Total rake** | **4.50%** | 100% | 60% of the *rake* returns to players. |

**Read that table carefully — "4.5% rake" is NOT a 4.5% house edge.** Of every
100 ETH wagered:

- **95.50** is paid straight back out as crash winnings (the distributable).
- **1.80** returns to players as Powerboard jackpot prizes.
- **0.90** buys and burns $PLANK (accrues to token holders — overlapping with
  players, but not identical to them, so don't count it as a direct rebate).
- **1.80** is the only ETH that actually leaves the player economy (dev/ops).

So the **true net house edge is 1.8%**, and **97.3% of wagered ETH comes back to
players in ETH terms** (98.2% if you count the burn as community value). Never
say "4.5% rake, 60% to players" without that breakdown — it reads as though
players only get 60% of their money back, which is wrong by an order of
magnitude.

Two deliberate choices worth keeping:
- **The total rake is low on purpose.** Rake is the single biggest driver of how
  long a bankroll survives, and therefore of lifetime plays — the low-rake
  poker-room lesson. Don't creep it up.
- **`keeperRewardBps` is 0** while the keeper is dev-run (settlement cost comes
  out of the dev leg). It is carved from the rake *before* the split, so raising
  it proportionally shrinks all three legs — only raise it if third-party
  keepers are opened up.

## 6. OPEN decisions (business, not code)

These are exercised with example values in tests and the local deploy, but are
real parameters to set deliberately before mainnet:

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

---

## 8. Instant UX: PlankBank (deposit → play → withdraw) + session keys

`PlankBank` is the "sign to get in, play instantly, sign to leave" buffer that
removes the per-bet wallet popup without a rollup or any account-abstraction
infrastructure (none is live on Robinhood Chain yet). Robinhood Chain is already
a ~100ms-block L2, so instant play only needs the *signing* friction removed, not
a faster chain.

**The three-signature entry, then never again:**
1. `bank.deposit()` — fund a play buffer.
2. `bank.grantSession(localKey, spendCap, expiry)` — authorize a throwaway keypair
   the frontend holds locally, bounded by a cumulative spend cap and an expiry.
3. `crash.setPayoutRedirect(bank)` — opt winnings into recycling straight back
   into the buffer.

**Then play is popup-free:** the local session key calls `bank.betVia(game, amount)`
and `bank.cashOutVia(game, roundId)`. The bank debits the player's buffer and calls
the crash's additive `placeBetFor(player)` / `cashOutFor(roundId, player)` — the
stake is attributed to the *player* for pari-mutuel weight exactly as a self-placed
bet. **Exit** is `bank.withdraw` / `withdrawAll` (root key only).

**Money flow back:** a bank-funded bet records its funder; on `claim`, if the player
opted into the redirect, the crash *pushes* the payout to `bank.creditFor(player)`
(best-effort, with a safe fallback to the normal pull-escrow if the sink reverts),
so wins land back in the buffer and play continues with no re-deposit. Losses simply
leave the buffer smaller.

**Security invariants (from-scratch, tested in `PlankBank.test.ts`):**
- A **session key is strictly weaker than the root key**: it can bet only up to its
  cap, only until expiry, only on whitelisted games, and can **never** withdraw.
  `spent` is never reset on re-grant, so a raised cap is a true lifetime ceiling.
- **No balance minting**: `creditFor` is callable only by a whitelisted game; there
  is no bare `receive()`, so stray ETH can't be mis-credited.
- **No forced early cash-out**: `cashOutFor` is restricted to the exact address that
  funded the bet (the bank), which itself enforces the player's session authorization.
- **A griefing payout sink only harms its own owner** (the redirect is self-set) and
  even then falls back to escrow, so funds are never stuck.
- CEI + `nonReentrant` on every ETH move.

The bank has **no admin, no upgrade path**, and its whitelisted game set is fixed at
construction. It is deployed after the crash (step 4 in `scripts/deploy-casino.ts`);
no dependency cycle since it only needs the crash's final address.

> **Honest v1 note:** winnings recycle into the buffer *only if* the player set the
> payout redirect; without it, wins land in the crash's normal pull-escrow
> (withdrawable to their wallet) instead. The buffer only decreases during a session
> otherwise. This is a deliberate, safe scoping — not a stub.

---

## 9. The Vault — a perpetual, never-zero, always-compounding prize pot

Every game is seeded from **the Vault** (`reserve`), a persistent prize reserve
that is **mathematically incapable of reaching zero or going negative**, no matter
how much players win.

**The math (why it can never be emptied).** Each new round is seeded with only a
*strict fraction* of the Vault:

```
seed = floor(reserve · seedNumerator / seedDenominator),   seedNumerator < seedDenominator
reserve ← reserve − seed
```

Because `seedNumerator < seedDenominator`, integer division gives `seed ≤ reserve·num/den < reserve`
for any `reserve ≥ 1`, so `reserve − seed` is strictly positive. A draw multiplies
the balance by `(den−num)/den > 0` — a positive number times a positive number is
positive. The Vault's **only** debit is this fractional seed; **winners are paid from
the round pool, never from the Vault**, so no sequence of wins ever touches it. This
is enforced at construction (`BadVaultConfig` rejects `num ≥ den`) and proven by a
fuzz test that pays out far more than the Vault holds across mixed win/bust rounds
while the Vault stays strictly positive (`PlankCrashDrandVault.test.ts`).

**The growth engine (why it always grows).** Three streams feed the Vault, so it
compounds on winning rounds too, not just busts:
1. **Rake carve** — `reserveShareBps` of every round's net rake flows into the Vault
   instead of the treasury (default 40%). Player-facing rake is unchanged; this only
   reallocates within the take, so *more of the rake comes back as prizes*.
2. **Bust windfalls** — the entire pot of every fully-busted round rolls in whole
   (`sweepBustedRound`), for big jackpot jumps.
3. **Donations** — anyone can `fundVault()` to prime or boost the progressive pot;
   only a fraction is released per round, so a donation compounds across many games.

**Steady state.** With constant pool `P`, rake carve `c` per round and release
fraction `α`, the reserve converges to `R* = c·P/α` and the per-round seed converges
to `c·P` — a self-funding progressive pot sitting on a permanent, un-emptyable buffer.
Set `α` small (default `1/8`) for a large, slow-to-fill, visibly-growing pot.

**Optional hard floor.** `reserveFloorWei` clamps the draw so the Vault is never taken
below a fixed floor `F` — a stronger guarantee (`reserve ≥ F`) than the geometric one
(`reserve > 0`).

**UI hooks.** `reserve` (current Vault) and `nextSeed()` (what the next game starts
with) are public; `VaultSeeded` / `VaultGrew` / `VaultFunded` events stream every
change. Deploy knobs: `CASINO_SEED_NUMERATOR` / `CASINO_SEED_DENOMINATOR` /
`CASINO_RESERVE_SHARE_BPS` / `CASINO_RESERVE_FLOOR_WEI`, all immutable after deploy.
