# Crash provider landscape and Plank pari-mutuel preservation doctrine

Status: research synthesis and design constraint; not production approval  
Date: 2026-08-27

## Decision

Plank's pari-mutuel settlement, fractionally seeded perpetual Vault, bust recycling, rake recirculation, capped overflow into Powerboard, and permissionless lottery settlement are the protected economic kernel. A redesign must preserve their conservation and bounded-liability properties unless a replacement is formally shown to dominate them.

Plank must **not** become a conventional house-banked crash game. Industry-standard live cash-out UX can be adopted without adopting industry-standard custodial accounting.

The optimal synthesis is:

- a canonical target committed with each bet;
- an optional live target update accepted before a predetermined intent deadline;
- immediate game-loop feedback that is visibly non-financial until chain acceptance;
- one predetermined, domain-separated randomness source/round;
- winners determined by committed target versus crash point;
- the existing fixed distributable pool shared by winning weight;
- Vault seed, bust capture, rake recirculation, and Powerboard liabilities kept segregated and conserved.

## What is genuinely novel in Plank

Most crash providers use a house bankroll:

```text
player loss -> operator/investor bankroll
player win  -> operator/investor bankroll liability
```

Plank instead uses:

```text
round pool = player stakes + fractional community Vault seed
distributable = round pool - published rake
winner weight = stake * successful locked multiplier
payout = distributable * winnerWeight / totalWinningWeight
```

This makes aggregate round payouts mechanically bounded by `distributable`. Extreme multipliers change the division of a fixed pot instead of creating an unbounded house promise.

The Vault adds a second novel loop:

```text
reserve sources:
  share of net rake
  fully busted distributable pools
  direct sponsor/community funding
  capped fuel-booster funding

next round seed:
  floor(reserve * seedNumerator / seedDenominator)
  where 0 < numerator < denominator

overflow above reserveCap:
  best-effort transfer to Powerboard jackpot
```

The seed is communal liquidity, not a player-specific subsidy or operator credit line. Because only a strict fraction is drawn, the arithmetic reserve remains positive when it starts positive, subject to correct accounting and no contract-level loss.

Powerboard then redistributes a separate community liability funded by designated inflows and Vault overflow. This creates a three-timescale economy:

1. immediate round competition;
2. persistent Vault compounding and seeding;
3. slower community jackpot accumulation and distribution.

That composition is materially different from server-seed crash plus a house bankroll.

## Live-provider landscape

No public survey can prove literal coverage of every deployed or white-label provider. The useful exhaustive method is to cover every materially different execution/economic archetype and the largest/documented representatives, then continuously add providers to a reproducible registry.

### Archetype A — custodial server-authoritative crash

Examples include Stake Crash, Roobet Crash, Aviator/Spribe integrations, BC.Game Crash, and many white-label engines.

Typical flow:

1. Player balance is already custodied in an operator ledger.
2. Bet and optional auto-cashout are sent to the game server before start.
3. Server broadcasts the display curve over WebSocket.
4. Manual cash-out is a client-to-server request.
5. Server receipt time/order is authoritative.
6. Internal ledger is updated instantly; blockchain is used only for deposits/withdrawals.
7. Outcome is later checkable through a committed server seed, client/public salt, nonce, or hash chain.

What this achieves well:

- tens-of-milliseconds interaction;
- smooth multiplayer presentation;
- cheap high-frequency ledger changes;
- straightforward auto-cashout during client disconnect;
- simple face-value payout display.

What it does not prove:

- neutral click-time adjudication;
- non-custodial funds;
- operator solvency;
- withdrawal liveness;
- server availability;
- absence of selective account/ledger intervention;
- regulatory permission in the player's jurisdiction.

Roobet's own support material explicitly says live cash-out depends on the connection reaching its servers and recommends auto-cashout when latency matters. It refunds a site-wide server incident but not a client-side missed request. That is an honest description of server-authoritative execution, and it strongly supports making Plank's precommitted target the safety baseline.

### Archetype B — precommitted hash-chain outcome

Bustabit and BC.Game document long reverse hash chains committed before play, commonly mixed with a later public seed/salt. This proves that the operator did not substitute a different committed outcome sequence after betting, assuming the seeding event and verifier are correct.

Advantages:

- cheap outcome generation and verification;
- compact public commitment;
- deterministic history verification;
- no per-round oracle transaction.

Limits:

- the operator still hosts the live game and adjudicates cash-out;
- custody and solvency remain separate;
- a verifier proves outcome derivation, not that a cash-out request was received fairly;
- seed-chain lifecycle, seeding event, skipped indices, and mapping math must be audited.

Plank's predesignated drand round is stronger against unilateral seed selection but more operationally expensive and liveness-sensitive. We should borrow their excellent verifier/history UX, not their custody model.

### Archetype C — per-player server/client seed and nonce

Stake documents HMAC-SHA256 over server seed, client seed, nonce, and cursor for many Originals. The casino precommits the server seed hash and reveals it on rotation. This is strong retrospective verification when implemented correctly.

It is less natural for one shared multiplayer crash round: participants need one common result and an unambiguous aggregate contribution to the seed. Server/client seed protocols also retain unilateral server custody and execution.

Enhancement to borrow: let the public verifier display every byte-to-integer conversion, rounding step, cap, and expected probability—not merely a green “fair” badge.

### Archetype D — house bankroll with public/investor liquidity

Bustabit publicly describes a bankroll against which players wager; wins leave it and losses enter it. Some crypto casinos allow outside bankroll investment and constrain maximum profit relative to available capital.

This can make solvency legible but still creates tail liability, investor-player conflicts, withdrawal-run risk, and risk-limit governance. It is inferior to Plank's bounded pari-mutuel liability for our intended community system.

Do not import:

- face-value promises backed only by a shared bankroll;
- dynamic max-profit rules that change after a bet;
- investor privilege over player claims;
- Kelly-style house exposure as a replacement for conservation.

### Archetype E — onchain house-vault games

Emerging EVM/Solana casinos place escrow and outcome verification onchain, often using VRF/Pyth and a central liquidity vault. They improve auditability and self-custody but still generally retain a house-liquidity liability model. Marketing claims such as “fully decentralized” require checking verified contracts, upgrade keys, oracle/provider control, frontend custody, and withdrawal paths.

Enhancements to borrow:

- public contract balances and liability reporting;
- permissionless outcome submission;
- deterministic claim transactions;
- independently runnable verifier;
- transaction-level proof history.

Do not infer safety from onchain location alone.

### Archetype F — offchain game loop with onchain escrow

State channels, app-specific rollups, signed-state rooms, and authoritative game hosts can deliver excellent latency while settling net results later. Their safety depends on the dispute predicate: if the base contract cannot independently determine which live cash-out was timely, the host/channel committee remains an adjudicator.

This architecture is useful for presentation and transport but cannot make a host receipt economically authoritative without adding an explicit trust/slashing system. Plank can run an Overwatch-like predicted room while ensuring host frames never affect payout.

## Provider feature matrix

| Pattern | Outcome proof | Cash-out authority | Custody/economics | Disconnect behavior | What Plank should learn |
|---|---|---|---|---|---|
| Stake-style Originals | server/client seed, nonce, HMAC or shared crash seeding | server | house ledger/bankroll | preset auto target is safest | polished multiplayer, transparent verifier, clear auto target |
| Bustabit | reverse hash chain plus public seeding event | server | public/investor house bankroll | server policy/auto target | auditable long history and bankroll visibility |
| BC.Game | reverse chain and published transform | server | custodial house | preset/manual server flow | public formula, chain verification, reseeding disclosure |
| Roobet | provably-fair outcome | server receipt | custodial house | auto-cashout survives client latency; manual miss generally loses | candid latency states and site-wide incident refunds |
| Aviator/Spribe | provider-generated pre-round coefficient and history verification | provider server | operator/provider ledger | provider rules | highly legible social two-panel UX; execution remains centralized |
| Generic WebSocket engines | operator seed or RNG | server event loop | internal database | implementation-specific | authoritative sequence numbers, snapshots, reconciliation |
| Onchain VRF/Pyth casinos | oracle proof | contract inclusion | usually liquidity vault | standing orders safer | permissionless verification and claims |
| Plank target design | predesignated shared beacon | contract-accepted signed target | bounded pari-mutuel pool + communal seed | committed fallback survives outage | preserve; improve timing, math, verifier, and UX |

Provider marketing pages are evidence of claimed behavior, not independent security proof. White-label deployments often share the same underlying provider, so counting skins as independent architectures would exaggerate diversity.

## Protected economic invariants

The redesigned protocol must prove all of these:

### Round conservation

```text
roundGross = seed + sum(netPlayerStakes)
distributable + roundRake = roundGross
sum(claims) + deterministicRoundDust = distributable
```

No live target update changes `roundGross` or `distributable`.

### Weight conservation

For player `i`:

```text
weight_i = won_i ? floor(stake_i * lockedTargetBps_i / 10_000) : 0
payout_i = floor(distributable * weight_i / totalWinningWeight)
```

The final implementation must specify whether the target or the discretized curve value is used. The target itself is simpler and avoids block/animation dependence. Transaction ordering of accepted targets must not change aggregate payout.

### Vault conservation

```text
reserveAfterSeed = reserveBeforeSeed - seed
0 <= seed < drawableReserve

reserveNext = reserveAfterSeed
            + reserveShareOfRake
            + bustedRoundCapture
            + directFunding
            + boundedFuelBoost
            - successfulOverflow
```

Physical contract assets must cover reserve, every open pool, settled claims, pending withdrawals, rake, and failed credits simultaneously. A positive accounting variable is insufficient if the same ETH is counted in another bucket.

### Lottery conservation

```text
jackpotBeforeDraw + fundingDuringEpoch
  = winnerPrize + drawerReward + jackpotAfterDraw + deterministicDust
```

The target randomness round and domain-separated ticket/ball seeds must be committed before ticket eligibility closes.

### Claim liveness

- Any participant's result can be registered without that participant being online.
- Every valid claim is pullable indefinitely or migratable through a proven escape path.
- One missing participant cannot prevent others from claiming.
- No registration deadline may silently confiscate a winner's economic entitlement.
- A fully busted pool can enter the Vault only after proving there are no winners, not merely that none registered.

The last two points require special scrutiny in the current registration-window design.

## Game-theory audit of the current weighting

In a standard house-banked crash game, a target `m` has approximately `1/m` success probability and pays `m`, less the edge. Target choice primarily changes variance.

In Plank pari-mutuel crash, target choice also changes a player's share of the winner pool:

```text
payoff_i = D * (s_i * m_i) / sum(winning s_j * m_j)
```

conditional on `m_i <= crash`.

Therefore the best response depends on the distribution of other players' stakes and targets. This is a strategic contest, not simply a house game with pooled custody. That novelty deserves formal analysis rather than being described as conventional RTP.

Required modeling:

- symmetric and asymmetric Nash equilibria over discrete targets;
- effect of visible versus sealed targets;
- whales splitting across wallets;
- last-mover observation of provisional weight;
- seed-to-player-pool ratio;
- empty, one-winner, and all-bust states;
- risk-neutral versus risk-averse play;
- whether high targets disproportionately capture communal seed;
- collusion and sacrificial bets;
- impact of rake and Powerboard external value;
- whether target privacy improves fairness or only adds reveal griefing.

The UI must call this a pool-share estimate, never a guaranteed `stake × multiplier` payout.

## Optimal execution without changing economics

### 1. Bet-time safety target

Every bet includes `safeTargetBps`. This is the canonical, disconnect-proof target. It becomes immutable at betting close unless a valid live update is accepted.

### 2. Live upward lock

During a deterministic live-intent window, the player may submit exactly one signed `LiveTarget` satisfying:

```text
safeTargetBps <= liveTargetBps <= maxTargetBps
```

Only a chain-accepted intent before `intentClose` replaces the safety target. Raising only prevents a player or stolen session permission from cashing the player out earlier than the consented floor; it also eliminates replace/cancel ordering games. Because settlement is pari-mutuel, it creates no platform liability.

Whether “upward only” matches user expectation must be tested. An alternative is one final replacement with explicit confirmation; it is economically safe but more exposed to sequencer ordering and compromised-session griefing.

### 3. Presentation clock

The rising curve is derived from the immutable envelope and a synchronized presentation epoch. It helps the player choose a target but never supplies economic time. The signed basis-point target is authoritative.

### 4. Proof-state UI

```text
CHOSEN_LOCALLY -> SENDING -> CHAIN_ACCEPTED -> SEALED -> RESULT -> CLAIMABLE -> SETTLED
```

An offchain frame acknowledgment may improve responsiveness but cannot advance `CHAIN_ACCEPTED`.

### 5. Failure semantics

- live submission misses deadline: safety target remains;
- host/RPC fails: safety target remains;
- sequencer halts: no false acceptance; round follows predetermined halt policy;
- beacon delayed: cash-out mutation remains frozen; result remains settleable;
- reorg: UI moves to explicit reorg state and falls back according to canonical inclusion;
- all players bust: distributable moves to Vault only after winner absence is objectively proven.

## Enhancements worth importing

1. **Auto-target as the headline control.** Major providers make it the disconnect-resistant path. Plank can make it elegant instead of secondary.
2. **Public verifier with test vectors.** Borrow Bustabit/Stake's inspectability, but verify envelope, signature, beacon proof, domain separation, transform, targets, weights, payout, seed, rake, and jackpot.
3. **Hash-linked proof history.** Link round proof bundles so skipped/replaced histories are obvious without using a server-controlled outcome chain.
4. **Authoritative sequence numbers and snapshots.** Borrow realtime-game reconciliation for animation and social feeds.
5. **Two-panel target exploration without autoplay.** A non-wagering rehearsal panel may let players compare safe and aspirational targets; do not permit automated repeat betting.
6. **Visible pool composition.** Show player stakes, communal seed, rake, estimated winning weight, and the fact payouts are variable.
7. **Runtime solvency report.** Improve on public-bankroll casinos by exposing every liability bucket, not only a gross balance.
8. **Deterministic incident policy.** Encode void/refund precedence instead of discretionary customer support.
9. **Free-play verifier mode.** Same distribution and pacing, no deposits, useful for comprehension and testing.
10. **Provider registry.** Maintain dated evidence for provider RNG, execution authority, custody, RTP, limits, disconnect policy, and verifier availability.

## Mechanics to reject

- house-backed face-value payout replacing the pari-mutuel pool;
- server receipt treated as financial lock;
- progression discounts or higher wagering caps earned through volume;
- autoplay, martingale controls, turbo rebet, or loss-chasing prompts;
- jackpot copy explicitly engineered around “chasing” or headline pressure;
- losses celebrated as wins;
- near-miss ball animation;
- player-specific odds or undisclosed VIP edge;
- hidden pool dilution or estimated payout presented as guaranteed;
- fallback randomness selected after any candidate is known;
- manual operator power to choose settlement versus refund.

## Powerboard preservation with corrections

Powerboard can remain a distinctive community redistribution layer, but its safest eligibility design should be re-evaluated.

The current wager-weighted ticket rule is simple and sybil-resistant in accounting terms, yet it makes lottery odds directly proportional to gambling intensity. Alternatives to model include:

- one capped ticket per valid round participant;
- concave weight such as integer square root of stake with a hard epoch cap;
- a base participation ticket plus a tightly capped stake component;
- non-purchasable contribution tickets separated from wagering tickets;
- rake-funded free community draws with no purchase-linked incremental odds.

None should be selected from intuition. Compare sybil cost, whale concentration, legal classification, expected jackpot ownership, player comprehension, and harm. Preserve fixed draw timing, predetermined randomness, bounded keeper reward, segregated jackpot liability, and deterministic rollover.

The current draw chooses its future drand round only after the epoch closes. That should change: commit the target schedule before ticket accumulation, and domain-separate ticket and ball with chain, contract, rules hash, epoch, target network, and target round.

## Research conclusions

1. The industry's best operational lesson is precommitted auto-cashout, not server custody.
2. “Provably fair” competitors generally prove outcome commitment, not cash-out ordering, solvency, or withdrawal.
3. Onchain house-vault designs improve transparency but reintroduce tail liability absent from Plank's pari-mutuel pool.
4. Plank's variable payout must be made unmistakable; copying a `stake × multiplier` display would be false.
5. Live target updates can be added without changing the pool equation because they change weights, not liabilities.
6. The Vault/Powerboard cascade is valuable but must be included in one global asset-liability invariant.
7. The progression and lottery eligibility layers need ethical/mechanism correction without removing the communal reserve architecture.
8. Exact equilibrium analysis is essential: Plank is strategically richer than standard crash and cannot borrow a conventional “99% RTP” label without a complete definition.

## Sources reviewed in this pass

### Live providers and implementations

- [Stake Crash](https://stake.com/casino/games/crash) — shared multiplayer curve, manual/auto modes, claimed 1% edge and 99% RTP.
- [Stake provably-fair implementation](https://stake.com/provably-fair/implementation) — HMAC inputs, seed lifecycle, nonce, and cursor.
- [Bustabit verifier](https://bustabit.github.io/verifier/) and [original seeding event](https://bitcointalk.org/index.php?topic=922898.0) — reverse hash-chain verification and external future-block seed.
- [Bustabit bankroll description](https://ibustabit.com/bankroll) — explicit house/investor bankroll model.
- [BC.Game fairness description](https://betting.bc.game/bc-game-fairness/) and [reseed notice](https://blog.bc.game/crash-at-bc-game-is-reseeding-heres-what-you-need-to-know/) — hash chain, transform, and operational seed transition claims.
- [Roobet crash incident/latency policy](https://help.roobet.com/en/articles/4797509-crash-issues) — server receipt, connection risk, refunds, and auto-cashout.
- [SPRIBE Aviator rules copy](https://yesplay.bet/assets/documents/spribe-Aviator.pdf) — provider-generated pre-round coefficient and cash-out model; distributor-hosted copy, so verify against licensed integration materials before relying on details.
- [Tower.bet disconnect FAQ](https://tower.bet/faq) — server continues an auto-cashout target after disconnect.
- [Hizi crash engine documentation](https://docs.hizi.io/engine/games/crash.html) — representative WebSocket curve and server `collect` architecture.
- [Riviera Crash](https://www.riviera.gg/game/crash) — representative current onchain/Pyth marketing claims; claims require contract/audit verification.

### Economics, integrity, and harm

- [High-Roller Impact: A Large Generalized Game Model of Pari-Mutuel Wagering](https://arxiv.org/abs/1605.03653) — strategic high-volume participant effects.
- [An Economist's Guide to Lottery Design](https://ideas.repec.org/a/ecj/econjl/v111y2001i475pf700-722.html) — prize distribution, rollover, sales, and pari-mutuel design.
- [An Equilibrium Model of Rollover Lotteries](https://bfi.uchicago.edu/working-paper/an-equilibrium-model-of-rollover-lotteries/) — rollover equilibrium and design.
- [Jackpot structural features](https://pubmed.ncbi.nlm.nih.gov/26063627/) — larger progressive jackpots increased bet sizes in the reported experiment.
- [Randomized Wagering Mechanisms](https://arxiv.org/abs/1809.04136) — wagering mechanism properties and randomized constructions.
- [Roobet community discussions](https://www.reddit.com/r/Roobet/comments/pt9q7i) — anecdotal evidence of martingale/chasing beliefs; useful for threat modeling UX, not authoritative evidence.

### Chain/runtime foundation

- [Robinhood Chain architecture](https://docs.robinhood.com/chain/) — documented FCFS sequencing and ERC-4337 support.
- [Robinhood Chain connectivity](https://docs.robinhood.com/chain/connecting/) — public RPC, sequencer feed, direct sequencer endpoint, and provider options.
- [drand API/network information](https://docs.drand.love/developer/API-v2/drand-http-api/) — evmnet chain identity, BN254, unchained mode, and three-second period.

This is a living landscape. Each provider row should be periodically reverified because formulas, operators, policies, licences, and technical architectures change.
