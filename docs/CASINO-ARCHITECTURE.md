# plank.love unified casino — architecture & economics

This is the reference for the on-chain casino: the crash game, the shared
randomness, and the community-economics loop that ties them together. It is
written to be honest about what the design does and does not achieve, so the
remaining business decisions (the bps parameters) can be made with eyes open.

Everything here is real, compiled, and tested (`npx hardhat test`, 186 passing
as of this writing). Nothing in this doc is aspirational unless explicitly
marked **OPEN**.

## 0. Status (2026-08-29)

- **Crash family (`PlankCrashDrand` + Bank/Rake/Powerboard/Progression/Fuel):
  hardenings (a)(b)(c) implemented on branch `feat/cos-p3-crash-hardening` —
  NOT deployed, constants NOT ratified.** Spec:
  `docs/marketplank/SPEC-CRASH-GO-LIVE-HARDENING.md`; tests:
  `test/contracts/PlankCrashHardening.test.ts` (C1–C8 + invariant I-a fuzz +
  pool-conservation property).
- (a) `placeBet(autoCashOutBps)` / `placeBetFor(player, autoCashOutBps)` commit
  the auto target with the bet (immutable per round/player; carried stakes keep
  it); `presetCashOut` REMOVED; `lockRound` stores `revealNotBefore` (beacon
  emission time of `targetDrandRound` MINUS `CASHOUT_CLOSE_MARGIN_PERIODS` = 2
  periods / 6 s, review MED-1); manual `cashOut` reverts `CashOutWindowClosed`
  once `block.timestamp >= revealNotBefore`, revealed or not, AND (clock-
  independent belt) once the beacon already holds the target round; settlement
  uses `effectiveCashOutBlock = min(manual, lockBlock + invert(auto))`.
- **The manual cash-out window is ~60 s (review LOW-5).** `lockRound` targets
  the drand round `TARGET_ROUND_SAFETY_PERIODS` (20) periods after the next one,
  so on quicknet (3 s) the target is emitted 60–63 s after lock and manual
  cash-outs close 6 s before that: a player has roughly 54–57 s of live block
  time after lock to choose an exit by hand; beyond it only the auto target
  committed with the bet can fire. This is a product constant, not a bug: it
  is what makes invariant I-a hold (no exit may be chosen once the randomness
  can exist anywhere). The UI must show the countdown and default players to an
  auto target; a longer manual window means a larger `TARGET_ROUND_SAFETY_
  PERIODS` at the cost of a longer wait per round.
- (b) `seedMaxBps` (immutable, bytecode ceiling `SEED_MAX_BPS_CEILING`=1000,
  review MED-3), `singlePayoutCapBps` on the house-side (seed) share of any one
  wallet's payout vs `reserveAtLock` — a per-wallet UX bound, NOT a sybil bound;
  the excess is credited to the Vault (pool conserved, proven in-test),
  `dailyDrawdownBps` (24h stepped window whose peak DECAYS by the allowed
  drawdown per elapsed window instead of resetting to the balance, review
  MED-2; seed returns never raise the peak) and `hwmDrawdownBps` circuits
  force seed=0 while play continues, and an explicit owner-supplied
  `maxMultiplierBps` (constructor-bounded) replaces the implicit block cap.
- **Seed is distributed by PROFIT weight (review HIGH-1):** the player-funded
  pot still splits by `stake × mult`, but the Vault seed splits by
  `stake × (mult − 1)` and is capped per winner at that same amount — house
  money never exceeds the fair-odds profit on the risk actually taken, so a
  1.0001× auto exit (P = 0.9999) earns 0.4% of its stake instead of the whole
  seed. Test `seedNotFarmableAtMinExit` reproduces the reviewer's 4-sybil probe:
  18.5% of the bankroll in 7 rounds on the old key, ≤ the fair-odds bound
  (0.06%) now. Spec §2.6. **This is NOT a sybil/collusion bound** (re-review
  NEW-1): the losing stakes go to the player pot, so an absorber + N winners
  recycle them and net `seed/m − rake × Σstakes` per round.
- **Seed bounded by HOUSE INCOME (re-review NEW-1, structural):** a rolling
  `seedBudget` credited with each round's net rake (after keeper bounties) and
  debited by every seed drawn (returns credited back); each round's seed ≤
  `seedBudget × SEED_INCOME_MULTIPLE_BPS/10⁴` (bytecode 10000) on top of every
  other cap, so cumulative house money paid out ≤ `seedBootstrapBudgetWei`
  (constructor, ≤ `reserveCap/10`) + 100% of cumulative net rake — the house
  recycles at most what it earned, and a colluding group can at best recover
  its own retained rake. `autoCashOutBps == 10000` (a P(win)=1 absorber) is
  rejected. Tests `colludingAbsorberIsNotProfitable` (fails on 0f21383),
  `seedBoundedByHouseIncome`, `autoTargetMustExceedOneX`. Spec §2.7.
- `estimatedPayout` during BETTING uses the current `reserve` as the
  single-payout cap base (`reserveAtLock` is 0 pre-lock — re-review NEW-2), so
  the bet-slip estimate equals the LIVE estimate on the same state.
- (c) `keeperRewardBps` must be > 0 and `rakeBps` must be > 0 (constructor
  reverts — review LOW-2, bounties are bps of the rake); `keeperRevealBps` /
  `keeperLockBps` pay the revealer / locker from the rake at `settleRound`, all
  via `_asyncTransfer` pull-payments.
- `scripts/deploy-casino.ts` carries the spec's §6 PROPOSED values only
  (loudly marked "PROPOSED — not ratified; do not deploy") and REVERTS unless
  the owner supplies `CASINO_MAX_MULTIPLIER_BPS`. Sections below that describe
  `presetCashOut` or a zero keeper reward predate this branch.

---

## 1. The one-paragraph version

Players bet ETH into a shared pari-mutuel pool on a crash game. A small **rake**
(4.50% declining to a 2.50% floor with volume, of which only 0.9% is a real house edge — see §5a) is skimmed from each settled round. That rake — instead of
leaking to a disconnected wallet — flows into a **router** that splits it
three ways: **40% buys and burns real $PLANK**, **40% funds the community leg**
(Powerboard prizes, protected Vault principal, emission buffer) paid back to
active bettors, and the **20% founder remainder** is the only leg that leaves
the community. Randomness for both the crash point and the raffle
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
| `PlankRakeDistributor.sol` | Immutable 3-way rake split — ratified legs: burn / community / founder (see §5a; `PlankEconomicRouterV2.sol` is the ratified constants implementation). Push-forwards on receipt. | No owner, no setter — changing the split needs a redeploy. |
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
   `receive()` fires and splits the ETH per the ratified §5a legs: 40% → burn
   engine, 40% → the community leg (Powerboard funding), 20% remainder → founder.
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
coordination — **for the player-funded pot.** The Vault seed is different: it is
house money, and a coordinated field CAN farm it (re-review NEW-1); that is why
the seed is bounded by house income (`seedBudget`, §0): the group can never take
out more than the rake it paid in.

**At larger N it smooths out** — your multiplier's *relative* rank matters
more than its absolute value, and the "everyone cashed at once" degenerate
outcome becomes vanishingly unlikely. The honest UI consequence at every N:
show `estimatedPayout()` — the player's **current** share of the current pot,
which may shrink as other players cash out ahead of the crash; it is not an
upper bound and not a promise — never `stake × multiplier`, which the game
never pays.

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
| `settleRound` | anyone | `keeperRewardBps` of the rake (must be > 0 since hardening (c)); `lockRound`/`revealEntropy` callers get `keeperLockBps`/`keeperRevealBps` of the same rake at settlement |
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

> **CORRECTED 2026-09-02** (owner decision: reconcile canon to the code). An
> earlier revision of this table read **40% dev / 40% jackpot / 20% burn** —
> that described a superseded pipeline. The implemented, ratified split is
> **40% burn / 40% community (→ Powerboard funding leg) / 20% founder**, as
> coded in `ratifiedRakeSplit` (`lib/casino/economics.ts`) and hard-coded in
> `contracts/PlankEconomicRouterV2.sol` (`BURN_BPS = 4_000`,
> `COMMUNITY_BPS = 4_000`, founder = remainder). The code is canon; this
> section now matches it exactly.

**The rake itself is evolutionary, not flat.** Starting rake is **450 bps
(4.50%)**, declining **−25 bps per 25,000,000 of qualified volume** to a
permanent **250 bps (2.50%) floor**
(`evolutionQuote`, `lib/casino/simulation.ts`):

```
effectiveRakeBps = 450 − min(floor(qualifiedVolume / 25_000_000) · 25, 200)
```

Wallet count never advances the meter — only rake-paid economic volume does.

**The split**, applied after the keeper carve (`keeperRewardBps`, currently 0,
comes off gross first), to net rake (`ratifiedRakeSplit`):

| Leg | % of pool (at 4.50%) | % of rake | Purpose |
|---|---|---|---|
| **$PLANK burn** | **1.80%** | 40% | Deflation accruing to all holders. `burn = netRake · 4000 / 10000`. |
| **Community** | **1.80%** | 40% | Routed by `powerboardFundingBps` into Powerboard prize funding; the remainder splits `protectedPrincipalBps` into the monotone protected Vault principal, rest to the emission buffer (overflow cascades to the lottery). |
| **Founder** | **0.90%** | 20% | The only leg that leaves the player/community economy. `founders = netRake − burn − community`. |
| **Total rake** | **4.50% → 2.50%** | 100% | 80% of the *rake* stays inside the community. |

**Read that table carefully — "4.5% rake" is NOT a 4.5% house edge.** Of every
100 ETH wagered at the starting rake:

- **95.50** is paid straight back out as crash winnings (the distributable).
- **1.80** returns to players as Powerboard prizes and Vault/reserve funding.
- **1.80** buys and burns $PLANK (accrues to token holders — overlapping with
  players, but not identical to them, so don't count it as a direct rebate).
- **0.90** is the only ETH that actually leaves the player economy (founder).

So the **true net house edge is 0.9%** (falling to 0.5% at the rake floor), and
**97.3% of wagered ETH comes back to players in ETH terms** (99.1% if you count
the burn as community value). Never say "4.5% rake" without that breakdown — it
reads as though the house keeps 4.5%, which is wrong by 5×.

Two deliberate choices worth keeping:
- **The total rake is low on purpose.** Rake is the single biggest driver of how
  long a bankroll survives, and therefore of lifetime plays — the low-rake
  poker-room lesson. Don't creep it up.
- **`keeperRewardBps` is 0** while the keeper is founder-run (settlement cost
  comes out of the founder leg). It is carved from the rake *before* the split,
  so raising it proportionally shrinks all three legs — only raise it if
  third-party keepers are opened up.

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

## 9. The Vault — a never-zero prize reserve that recycles the rake it keeps

Every game is seeded from **the Vault** (`reserve`), a persistent prize reserve
that is **mathematically incapable of reaching zero or going negative**, no matter
how much players win — and that, after its bootstrap, **only ever seeds out of rake
it has itself taken in** (re-review NEW-5). It is not a subsidy engine and it is
not a progressive pot that grows without limit; it is a rake rebate with a bankroll
behind it.

**The never-zero math.** Each new round is seeded with only a *strict fraction* of
the Vault:

```
seed = floor(reserve · seedNumerator / seedDenominator),   seedNumerator < seedDenominator
reserve ← reserve − seed
```

Because `seedNumerator < seedDenominator`, integer division gives `seed ≤ reserve·num/den < reserve`
for any `reserve ≥ 1`, so `reserve − seed` is strictly positive. The Vault's **only**
debit is this fractional seed; **winners are paid from the round pool, never from
the Vault**, so no sequence of wins ever touches it. This is enforced at construction
(`BadVaultConfig` rejects `num ≥ den`) and proven by a fuzz test that pays out far
more than the Vault holds across mixed win/bust rounds while the Vault stays strictly
positive (`PlankCrashDrandVault.test.ts`).

**The income budget (what the seed actually is).** The fraction above is only one
of the caps. Every seed is ALSO bounded by `seedBudget`, a running wei balance that
starts at the one-off bootstrap (`seedBootstrapBudgetWei`, ≤ 10% of the bankroll cap)
and is thereafter credited ONLY with each settled round's `reserveCut` — the
`reserveShareBps` share of the net rake (rake minus keeper bounties) that actually
entered the Vault. Seeds are debited from it; a voided round's rescued seed, a
busted round's returned seed and a capped payout's excess are credited back. So, after
the bootstrap is spent:

```
seed(round n) ≤ trailing reserveCut ≈ rake × reserveShare × stakes(prior rounds)
```

At the deploy default (`rakeBps = 450`, `reserveShareBps = 4000`, bounties ≈ 7% of
rake) that is ≈ 0.17% of the prior rounds' stakes. The seed is a **rebate of rake the
Vault took in, not a Vault subsidy**: under honest play the Vault can never lose more
than the bootstrap (`reserve + seed in flight + spilled ≥ reserve_start − bootstrap`,
test `vaultNeverBleedsUnderHonestPlay`), and a colluding field can at best recover
the rake the Vault kept, minus the bounties and treasury share it paid.

**Where `seedMaxBps` binds.** The 5% per-round bankroll ceiling (`seedMaxBps`) and
the `num/den` fraction only bind ABOVE the implied volume: with a 2 ETH bankroll the
5% cap is 0.1 ETH, which the income budget reaches only once prior-round stakes
exceed ≈ 60 ETH. Below that volume the seed is set by income, not by the Vault's
size; the `num/den` "release fraction" no longer describes a steady state.

**Three inflows.** The Vault is credited by:
1. **Rake carve** — `reserveCut` = `reserveShareBps` of every round's net rake flows
   into the Vault instead of the treasury (default 40%). Player-facing rake is
   unchanged; this only reallocates within the take. This is ALSO the only recurring
   seed income (above), so `reserveShareBps = 0` means a Vault that seeds only its
   bootstrap and then stops.
2. **Bust windfalls** — the entire pot of every fully-busted round rolls in whole
   (`sweepBustedRound`); the seed part of it returns to the budget, the player part
   does not (players' losses are house income, never re-seeded).
3. **Donations** — anyone can `fundVault()` to prime or boost the reserve. A donation
   raises the bankroll (and the caps that key off it) but NOT the seed budget: it
   cannot be seeded out faster than rake comes in.

**Steady state, honestly.** Over a run of rounds the Vault's balance moves by
`Σ reserveCut + Σ bust windfalls − Σ seed paid`, and `Σ seed paid ≤ bootstrap + Σ reserveCut`:
net of the one-off bootstrap it is non-decreasing, it grows by whatever rake rebate the
winners' fair-odds and single-payout caps leave unclaimed plus busted pots, and any
balance above `reserveCap` cascades to the Powerboard (§10). The earlier
"`R* = c·P/α`, always-compounding, un-emptyable progressive pot" description was the
pre-hardening formula and is withdrawn: the pot does not compound off a release
fraction, it recycles income.

**Optional hard floor.** `reserveFloorWei` clamps the draw so the Vault is never taken
below a fixed floor `F` — a stronger guarantee (`reserve ≥ F`) than the geometric one
(`reserve > 0`).

**UI hooks.** `reserve` (current Vault) and `nextSeed()` (what the next game starts
with) are public; `VaultSeeded` / `VaultGrew` / `VaultFunded` events stream every
change. Deploy knobs: `CASINO_SEED_NUMERATOR` / `CASINO_SEED_DENOMINATOR` /
`CASINO_RESERVE_SHARE_BPS` / `CASINO_RESERVE_FLOOR_WEI`, all immutable after deploy.

---

## 10. Unifying the Vault with the Powerboard: the cascade + the "must be won" guarantee

**Cascade — the crash's growth feeds the daily lottery.** The Vault is capped
(`reserveCap`); once it exceeds the cap, the overflow **spills into the Powerboard
jackpot** via `jackpotSink.fund()`. So the rake carve fills the Vault first
(short-cycle, per-game prizes) and, once it's full, everything above the cap flows
to the jackpot (long-cycle, daily prize). This resolves the earlier dilution: the
40% rake carve isn't lost to the Powerboard, it's *prioritized* — Vault first,
jackpot gets the steady overflow — so at steady state the jackpot's funding is
restored and the two are one coherent system. The spill is **best-effort** (a
low-level `call`; a broken/absent sink just leaves the ETH in the Vault to spill
next time), so a bad sink can never brick settlement, and only balance *above* the
cap is ever moved — the never-zero floor is untouched. Config: `reserveCap` (0 =
uncapped, no spill) and `jackpotSink` (0 = cascade off). Emits `VaultOverflow`.

> **SUPERSEDED 2026-09-05.** The paragraph below describes the retired `PlankPowerboard`
> (epoch tickets, consolation drain, `mustHitByEpochs`). The live lottery is
> `contracts/PlankLottery.sol`: round-only eligibility, the progressive carve, and the
> ACTUARIAL hit rule `p = min(1/oddsOneIn, c/(κ·W(P)))` with **no forced hit** (owner
> ruling). See `docs/marketplank/RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md`.
> The laboratory engine (`lib/casino/simulation.ts`) mirrors the same law.

**"Must be won" — the guaranteed jackpot.** Left alone, the full jackpot only pays
when the Plank Ball hits (`1/ballRange` per epoch — geometric, so the wait has an
unbounded tail even though it self-caps at ~`1/consolationBps` × per-epoch funding
via the consolation drain). `mustHitByEpochs` adds the real-lottery **"Must Be Won"**
mechanic: if the jackpot hasn't paid for that many epochs, the next drawn epoch
(with participants) **force-pays the entire jackpot regardless of the ball**. The
clock (`lastJackpotHitEpoch`) starts at deployment and resets on every full payout
(natural or forced). `guaranteedHitByEpoch()` exposes the deadline for a
"guaranteed by <date>" headline; `JackpotForced` fires when the guarantee triggers.
So: **someone wins a consolation every epoch** there are players, and **the full
jackpot is guaranteed to pay out at least every `mustHitByEpochs` epochs** — it can
never roll forever.

---

## 11. Fuel the pad, not your own odds: burning $PLANK into the Vault

`PlankFuelBooster.sol` lets any player burn real $PLANK on the launchpad (the
0→1.00x "fueling" window in the arcade) to grow the **shared** Vault — never
their own stake, cash-out timing, or crash-point odds, which stay fixed by
drand and the pari-mutuel pool, completely untouched by this contract.

**Why this can't become pay-to-win, by construction:** burning only ever calls
`crash.fundVault()` — the exact same permissionless function any donor could
call. A whale who burns a fortune buys the *whole table* a bigger future prize
pot, not a better bet for themselves.

**Where the ETH comes from, honestly:** burning $PLANK does not conjure ETH.
The booster holds a pre-funded `boostPool` (topped up via `fund()` — treasury,
sponsor, or well-wisher) and releases up to the **fair TWAP value** of what was
burned — priced by the *same* `PlankV2TwapOracle` `PlankBurnEngine`'s buybacks
already trust, so it inherits that oracle's sandwich-resistance. Burning past
the caps below still burns in full (real, honored deflation); only the *boost*
is capped:
- `maxBoostPerBurnWei` — ceiling on any one `burnFuel()` call.
- `maxBoostPerRoundWei` — ceiling on total boost while a given crash round is
  current, tracked against the crash's own `currentRoundId()` so it resets
  automatically every round with no separate epoch bookkeeping.
- `boostPool` itself — can never release more than it holds.

**Pricing safety:** if the oracle is unprimed or stale, `burnFuel()` reverts
**atomically** — the player's $PLANK is never spent on an unpriceable,
unrewarded boost (the same "funds wait, never move" discipline
`PlankBurnEngine` applies to its own swaps).

Deployed after the crash (needs its final address + the oracle); no dependency
cycle. Env knobs: `CASINO_FUEL_MAX_PER_BURN_WEI` / `CASINO_FUEL_MAX_PER_ROUND_WEI`.
