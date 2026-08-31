# Cronos, CroCrash, Rugged, and crash-clone product census

Date: 2026-08-31

## Scope and confidence

This census separates four commonly conflated classes:

1. a game whose economic actions execute on Cronos;
2. a centrally operated game that accepts CRO or uses a Cronos wallet;
3. a white-label crash title merely offered by a casino reachable by CRO holders;
4. a product whose name contains “crash” but is not a multiplier game.

Search engines and social posts frequently collapse those categories. **CroCrash is the only clearly substantiated Cronos-native shared crash product found in this pass.** Absence from this list is not proof that a small, private, abandoned, or non-indexed deployment does not exist.

## Verified Cronos-native reference: CroCrash

Public product: <https://crocrash.io>  
Social account: <https://x.com/Cro_Crash>

The deployed client identifies:

- a conventional shared `crash` mode;
- a separate `rugged` mode;
- Socket.IO realtime transport;
- a Heroku-hosted API under `/api/v1`;
- Cronos RPC and explorer integrations;
- balance, transaction, rank, reward, history, leaderboard, mission, and recent-win surfaces;
- distinct crash and Rugged histories;
- wallet-based funding/withdrawal around an application balance.

The client contains a GitHub link for `CroCrash/crocrash-app`, but that repository is not publicly retrievable at the time of review. The downloadable browser bundle can establish shipped interaction behavior, not backend correctness, fairness, custody, or source-level security.

### CroCrash features worth benchmarking

- compact mobile amount presets;
- always-present social activity and recent outcomes;
- ranks, rewards, missions, daily competition, and sharing;
- multiple games within one coherent balance/session shell;
- low-friction Socket.IO responsiveness;
- round history and re-entry continuity;
- explicit game switching rather than separate disconnected sites.

### CroCrash limitations Plank must improve upon

- centralized API and realtime authority are not equivalent to trustless settlement;
- application-balance custody and withdrawal availability add operator risk;
- a client bundle is not an independently reproducible fairness specification;
- client-visible green verification is insufficient without immutable precommitments and an external verifier;
- server ticks must not determine an on-chain lock value;
- product responsiveness must remain available when a specific application server restarts or scales horizontally.

## Rugged: adjacent game, transferable product system

Rugged is not a shared crash curve. It is a 22-row Mines/risk-ladder game with:

- one predetermined rug position per row;
- a rising row multiplier schedule;
- player-controlled advance or cash-out;
- no decision timer;
- persistent unfinished rounds that resume after closing the browser;
- HMAC-SHA256 verification over private and public seed material;
- a post-round 22-position verifier;
- dedicated history, recent wins, missions, competitive leaderboard, and X sharing.

For PlankCrash, its most valuable invention is the surrounding **game operating system**: persistence, verifier-as-story, social proof, missions, and a reusable mobile control language.

## Other Cronos risk-game references

### Croissant Games

Cronos Labs historically lists Croissant as a platform for on/off-chain risk-based RNG games: <https://blog.cronos.org/p/a-world-of-opportunities-your-guide>. Public discussion references directional price games and other casino-like products, but this pass did not substantiate a currently operating, shared rising-multiplier crash implementation with inspectable timing semantics. Treat it as an ecosystem/portfolio reference, not a CroCrash clone.

### Cronos gambling directories

DappRadar maintains a Cronos gambling category: <https://dappradar.com/rankings/protocol/cronos/category/gambling>. Directory membership proves categorization and activity signals, not that a title is chain-native, non-custodial, provably fair, or a shared crash game. Every candidate must be classified against the four categories above before inclusion.

## Global crash clones likely to appear in CRO-facing casinos

These are product/mechanic comparators, not verified Cronos-native protocols:

| Family | Distinctive mechanic | Plank adoption candidate | Do not copy |
| --- | --- | --- | --- |
| Bustabit | server-authoritative auto-cashout; lifecycle events; verifier culture | disposable client, reconnect-safe auto-lock, event log | house-bankroll payout model |
| Aviator | two simultaneous bets, social cash-out roster, short repeat loop | optional split-intent laboratory, strong friend presence | ambiguous “instant” cash-out language |
| JetX | dual bets, clear history strip, high-motion flight fantasy | readable history and two-lane testing | fixed stake-times-multiplier economics |
| Spaceman | highly simplified mobile control and character tension | thumb-zone primary control, compact progressive disclosure | hidden/opaque settlement implementation |
| Stake Crash | approximately five-second betting intermission, auto-cashout, huge tail, seed verifier | fast replay loop, verifier access, history | central house settlement and balance custody |
| Rollbit X-Crash | multiple simultaneous positions and individual exits | advanced simulation of multiple precommitted policies | complexity in the default novice HUD |
| Turbo Games Crash X | HTML5 mobile delivery, demo mode, very large advertised ceiling | no-install demo and device scaling | verification claims without sufficient player documentation |
| Rocketpot | social feed and jackpot trigger layered over high multipliers | a clearly separated Powerboard epilogue | making jackpot eligibility depend on attention-manipulating thresholds |

## PlankCrash synthesis

Plank should not become a visual CroCrash clone. It should combine:

- **CroCrash:** mobile presets, social visibility, missions, ranks, recent wins, coherent multi-game shell;
- **Rugged:** persistent unfinished state, verifier embedded in results, shareable conclusion, competitive rituals;
- **Bustabit:** server/contract-authoritative auto-lock and reconnect safety;
- **PancakeSwap:** explicit pending/confirmed round states, reference-versus-settlement disclosure, recoverable history;
- **Robinhood Chain:** sequencer-feed responsiveness with bounded client prediction;
- **Plank:** bounded parimutuel settlement, shared Vault, compounding Powerboard, transparent accounting, and non-house community economics.

## Implemented from this review

- The private presentation clock now accepts frequent authoritative heartbeats and bounds dead reckoning to 2.5 seconds. A network partition holds the factor rather than displaying an unattainable value.
- The long-poll route now returns a two-second heartbeat so normal animation stays continuous without converting the browser into economic authority.
- The conclusion ceremony now offers native mobile result sharing with clipboard fallback and intentionally omits the private room/invite URL.
- Existing accepted commitments, locks, settlement, verification, and conclusion state remain server-authoritative across refresh.

## Next implementation slices

1. Add `intent -> submitted -> accepted -> settled` lock microstates to contract mode, with a ghost marker for intended factor and a separate accepted factor.
2. Add a persistent player-facing fairness ledger that stores commitment, reveal, derivation version, verification result, and exact settlement for every round.
3. Add opt-in missions based on participation and community contribution, never loss-chasing, wager escalation, or near-miss manipulation.
4. Add privacy-safe result cards rendered for sharing without room codes, balances, wallet addresses, or hidden strategy data.
5. Add a multi-position **simulation-only** lab for comparing precommitted policies; do not introduce multiple live economic bets until Sybil and cap effects are formally modeled.
6. Replace contract-mode unbounded fixed-100-ms extrapolation with measured block cadence, bounded lead, WebSocket/sequencer anchors, and explicit degraded state.
7. Complete the drand `T_commit < T_random` successor-contract decision before representing reactive mainnet lock as fair.

## Responsible engagement constraints

Community mechanics must reward verification, contribution, hosting, learning, and durable participation—not larger losses, chasing, or time pressure. Sharing defaults must never expose private-table access. Rankings should remain reputation signals unless an independently audited economic rule proves Sybil resistance and equal treatment.
