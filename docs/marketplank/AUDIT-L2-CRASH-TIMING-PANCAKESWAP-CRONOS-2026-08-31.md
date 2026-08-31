# PlankCrash L2 timing, crash-game, PancakeSwap, and Cronos audit

Date: 2026-08-31

## Executive verdict

Plank's target architecture should be a **server/chain-authoritative game with a locally predicted, monotonically reconciled presentation**, not a stream of server-authored animation frames and not a browser-authored cash-out value.

The private multiplayer clock is already close to that form: the server owns `startedAt`, accepted locks, and settlement; `PrivateLiveClock` uses `performance.now()` for smooth frames, rejects stale versions, and never rewinds. The mainnet client has the same intent but still contains a fixed `LOCAL_BLOCK_MS = 100` extrapolator and a one-way correction that can run visibly ahead of a slow sequencer indefinitely. That is safe only if every displayed value remains explicitly estimated and settlement always uses the accepted on-chain block.

The mainnet drand contract has a more important pre-launch question. The future randomness pulse, the 100 ms block-derived multiplier, and transaction sequencing are separate clocks. Once the target drand value is publicly available, the outcome is knowable. A manual `cashOut()` accepted after that point but before the derived crash block would allow outcome-aware play. The current contract blocks the pre-relay interval but allows manual cash-out after `entropyRevealed` until the crash point. This needs a formal adversarial review and likely a successor rule that closes cash-out at randomness availability, or makes every cash-out an irrevocable preset committed before availability. It should not be represented as mainnet-ready until this invariant is proved.

## What was inspected

- `public/arcade/private-live-clock.js`
- `public/arcade/crash.html`, including both private-server and contract modes
- `lib/playtest-rooms.ts` and `lib/playtest-room-core.ts`
- `contracts/PlankCrashDrand.sol`, `PlankCrashV2.sol`, `PlankCrashEntropy.sol`, and `PlankCrashVRF.sol`
- contract, fuzz, clock, and playtest-room tests
- the current deployment defaults in `scripts/deploy-casino.ts`
- PancakeSwap Prediction documentation and contract mechanics
- Robinhood Chain and Arbitrum infrastructure documentation
- Cronos/Crypto.com material, including the distinction between Cronos EVM, Cronos zkEVM, and Crypto.com products
- Bustabit's archived open-source server/client and fairness documentation
- representative modern WebSocket crash-game repositories

## Industry comparison

| System | Economic authority | Presentation transport | Timing lesson | What Plank should take |
| --- | --- | --- | --- | --- |
| Bustabit v1 | game server; auto-cashout runs server-side even if client disconnects | event stream (`GAME_STARTING`, `GAME_STARTED`, `CASHED_OUT`, `GAME_ENDED`) | browser is a view/controller, never the clock of record | authoritative auto-lock, explicit lifecycle events, reconnect-safe results |
| Typical GitHub crash clones | central server | WebSocket ticks, often every 50 ms | simple and smooth, but ticks conflate animation with truth and lack adversarial timing semantics | use only as UX references; do not copy settlement or fairness claims |
| PancakeSwap Prediction | contract plus Chainlink lock/close values | faster Binance/TradingView feed for reference | reference UI may differ from settlement; transaction-confirmation buffer is disclosed | separate indicative animation from authoritative value; show pending/entered states; allow invalid-round refunds |
| Robinhood Chain | Arbitrum L2 sequencer/preconfirmation, later settlement/finality | official WebSocket RPC and sequencer feed | roughly 100 ms responsiveness is possible, but receipt stages remain distinct | subscribe instead of polling; surface sequenced acceptance immediately, then canonical confirmation |
| Cronos EVM / zkEVM | chain execution and chain-specific finality | RPC/WebSocket | “CRO” is not one timing model; product, EVM chain, and zkEVM must not be conflated | use a per-chain timing adapter and measured capability registry, never hard-coded brand assumptions |

### Source notes

- PancakeSwap documents five-minute rolling rounds, an immutable entry once placed, Chainlink as the settlement source, and a faster market feed for the live chart. It warns users to allow roughly 30 seconds for confirmation and separately documents a block buffer for delayed results: <https://docs.pancakeswap.finance/play/prediction> and <https://docs.pancakeswap.finance/play/prediction/prediction-guide>.
- The Prediction V2 contract uses `startTimestamp`, `lockTimestamp`, `closeTimestamp`, `bufferSeconds`, oracle round IDs, and an `oracleCalled` flag. A missed execution window produces a refundable round rather than invented settlement: <https://github.com/pancakeswap/pancake-smart-contracts>.
- Robinhood officially describes the chain as an Arbitrum L2 and publishes HTTP RPC, WebSocket RPC, and direct sequencer-feed endpoints: <https://docs.robinhood.com/chain/connecting/>. Arbitrum describes the production chain as using configurable block times and preconfirmations for about 100 ms latency: <https://blog.arbitrum.io/robinhood-chain-mainnet/>.
- Bustabit's archived API exposes distinct round events and documents that auto-cashout remains server-side when the client disconnects: <https://github.com/bustabit/autobet> and <https://github.com/bustabit/v1-gameserver>.
- Representative open-source crash servers expose `round_start`, multiplier ticks, cash-out requests, and crash events over WebSockets. They demonstrate transport patterns, not sufficient fairness or L2 settlement design: <https://github.com/mrskyy19-source/crash-games>, <https://github.com/nutcas3/aviator-fun>, and <https://github.com/sanjaykumar200599/BitRush>.

## The correct Plank timing model

There are five clocks, not one:

1. **Commit clock** — when the bet or auto-lock intent becomes irrevocable.
2. **Sequencer clock** — when Robinhood Chain orders the transaction.
3. **economic clock** — the contract block used to compute accepted claim weight.
4. **presentation clock** — local `performance.now()` frames between authoritative observations.
5. **finality clock** — when the result has the desired L2/L1 assurance.

Only clocks 1–3 can change money. Clock 4 can draw; clock 5 changes confidence and withdrawal/claim language. The UI must never silently collapse them.

### Recommended transaction state machine

`idle -> signing -> submitted -> sequenced -> locked -> settled`

- `signing`: wallet/session key action is being authorized.
- `submitted`: transaction hash or signed command exists; no lock is promised.
- `sequenced`: a Robinhood sequencer receipt/preconfirmation exists; show the accepted block and factor as provisional if reorg policy requires it.
- `locked`: contract event/state confirms the immutable cash-out block.
- `settled`: crash result and parimutuel payout are authoritative.

On rejection, preserve the user's last intent and display the exact reason: `after crash`, `already locked`, `round changed`, `nonce replaced`, or `RPC unavailable`. Never animate a win merely because a click was sent.

## Client prediction and reconciliation

The presentation should render every animation frame but ingest sparse authoritative anchors.

For anchor `A = {roundId, phase, blockNumber, blockTimestamp, observedMultiplierBps, sequence}`:

1. reject an older round, phase, sequence, or block;
2. estimate forward using measured recent block cadence, not one global constant;
3. clamp the displayed factor to never decrease within a live round;
4. limit how far prediction may lead the last observed block;
5. if error exceeds a threshold, ease toward truth without crossing it or replaying ignition;
6. snap only at terminal crash/settlement, where exactness is more important than continuity.

The current contract-mode `launchAt = min(launchAt, impliedLaunchAt)` prevents rewinds but never corrects an over-optimistic clock backward. The result can drift ahead until the chain catches up. Replace the unlimited lead with a bounded dead-reckoning window (for example, two observed block intervals), then hold the visible factor while marking connectivity degraded. This is more honest than displaying an attractive but unattainable lock value.

The private `PrivateLiveClock` is structurally stronger because it anchors to `serverNow - startedAt`, rejects stale versions, resets by round key, and takes a monotonic maximum. It should gain tests for background-tab suspension, a 60-second network partition, device clock changes, duplicate snapshots, and reconnect exactly across settlement.

## Cash-out semantics on a 100 ms L2

A 100 ms block time is shorter than ordinary human reaction plus internet/wallet latency. Manual clicking therefore cannot truthfully guarantee the factor visible at pointer-down. The defensible choices are:

- server-/contract-native preset auto-lock, committed before the outcome is knowable;
- manual lock at the sequencer-accepted block, with the accepted factor returned and celebrated only after receipt;
- an optional short-lived session key or smart account permission so the lock transaction avoids a wallet modal, with explicit amount/game/round/expiry limits.

The large button should show the **last attainable observed factor**, while the oversized stage number can show the smoothly estimated live factor. On click, freeze a ghost marker at the user's intended factor, then replace it with the accepted factor. The difference is latency slippage, not a hidden loss and not grounds to rewrite history.

## Critical drand timing invariant

For every round, define:

- `T_commit`: all cash-out policies are irrevocable;
- `T_random`: target randomness becomes publicly computable;
- `T_crash`: economic crash boundary;
- `T_accept(user)`: user's manual cash-out is accepted.

Fairness requires either:

`T_accept(user) < T_random` for every discretionary cash-out,

or a proof that every action after `T_random` was already committed before `T_random`.

Current `PlankCrashDrand.cashOut()` prevents action while the drand round is due but not relayed, yet permits cash-out after `entropyRevealed` while elapsed blocks are still below the now-public effective crash point. That violates the simple invariant above unless reveal is guaranteed to occur only at/after the crash boundary. The constructor does not prove that relation; its 20-period safety target is wall-clock based while the crash is block-count based. Deployment defaults (`maxElapsedBlocks = 1800`) and approximately 100 ms blocks permit a much longer economic horizon than a roughly 60-second drand safety lead.

Recommended successor designs, in order:

1. **Precommitted targets:** every participant submits a target before `T_random`; the contract resolves it deterministically. Manual UI interaction may update the commitment only before the cutoff.
2. **Hidden threshold service plus public proof after close:** suitable for the private test, but introduces an operator and is not the preferred trustless mainnet design.
3. **Continuous randomness schedule:** each interval has independently unavailable randomness and closes exactly when it becomes available. This is more complex and must prevent selective inclusion and relay races.

Do not “fix” this with CSS, faster polling, a keeper, or by hiding the drand endpoint. Public randomness is public whether the app displays it or not.

## PancakeSwap lessons to adopt directly

- Show three adjacent temporal cards or a compact equivalent: `Previous`, `Live`, `Next`. This makes queued entry comprehensible while a live round is immutable.
- Treat “entered” as a confirmed state, not a button-click state.
- Publish the settlement source and label any faster chart as reference-only.
- Have an explicit invalid/void round and deterministic refund path when the oracle/keeper window is missed.
- Keep claimable history recoverable after the user leaves the page.
- Do not copy PancakeSwap's five-minute cadence; its interaction is prediction, not reaction-time crash. Copy the state clarity and failure semantics.

## Cronos/CRO and CroCrash/Rugged conclusion

“CRO” must be resolved before making a technical comparison:

- **Crypto.com** is a product/operator whose interfaces provide useful mobile and trading-layout references.
- **Cronos EVM** is an EVM chain with its own consensus and RPC behavior.
- **Cronos zkEVM** is a separate L2 system with different sequencing/finality behavior.
- **CRO** is the token, not a timing protocol.
- **CroCrash** is a third-party Cronos game application at <https://crocrash.io>, not evidence of an official Crypto.com-operated casino.
- **Rugged** is a newly launched game inside CroCrash. It is distinct from CroCrash's conventional rising-multiplier crash mode.

### What Rugged actually is

Inspection of the currently deployed CroCrash client identifies Rugged as a **22-row Mines-style risk ladder with meme-coin presentation**, not a shared real-time crash curve:

- each row has a predetermined rug position;
- the player chooses a tile, advances through rows, and may stop/cash out between choices;
- row multipliers are configured as a progression (`multiplierPerRow` in the deployed client);
- there is no round timer, so reaction latency is deliberately removed from the economic decision;
- an active round persists when the browser closes and resumes on return;
- post-round verification recomputes every stored rug position using HMAC-SHA256 over a private seed plus a public seed described by the client as sourced from an EOS block;
- the interface exposes a round-detail verifier and reports whether all 22 computed positions match;
- CroCrash keeps Rugged history, recent wins, competitive leaderboards, missions, and share-to-X affordances alongside the core game.

CroCrash publicly announced Rugged as a new game on its X account and links play to `crocrash.io`: <https://x.com/Cro_Crash>. The deployed application exposes separate `crash` and `rugged` game states and a Rugged history endpoint, confirming they are separate modes rather than two names for the same game.

### What Plank should learn from Rugged

Rugged is a useful **continuity and verification** reference, not a mainnet live-cash-out timing solution:

- Persist an unfinished economic story and restore it exactly after refresh, tab closure, or device interruption.
- Put the verifier in the ordinary result journey rather than burying it in developer documentation.
- Let the result screen explain the committed input, public entropy, deterministic derivation, and pass/fail comparison in player language.
- Use missions, daily competition, recent wins, and one-tap social sharing to turn a mathematically simple loop into a community ritual.
- Provide fast stake preset buttons and a mobile-first primary-action region; CroCrash itself has publicly compared its crash amount controls against Rugged's quick-button UI.

What should **not** be transferred blindly:

- an EOS-derived public seed is only safe if the commitment and chosen future block eliminate operator/player seed selection and reorganization attacks;
- a central Heroku API and Socket.IO application can provide excellent responsiveness but does not establish on-chain execution or trustlessness;
- a turn-based ladder has no race between display time and transaction ordering, so its smoothness does not prove that a live L2 crash cash-out is fair;
- “provably fair” must include a reproducible specification and immutable precommitment, not only a post-round green check in the operator's own client.

No evidence found that Crypto.com itself operates Rugged. The corrected comparison is therefore: **CroCrash supplies a real Cronos-native product and UX precedent; Rugged supplies persistence, verification, missions, and mobile-control precedents; neither supplies the mainnet trust model for Plank's reactive on-chain lock.** A future Cronos deployment should still implement the same `ChainTimingCapabilities` interface and measure actual block arrival, reorg depth, receipt latency, WebSocket gaps, and finality on that target network.

## Implementation plan

### P0 — fairness before mainnet

- Formally specify and test `T_commit < T_random` for all discretionary actions.
- Remove or redesign post-reveal manual cash-out in the successor contract.
- Property-test that no participant with public randomness can improve payout by choosing an action after reveal.
- Make the chain-accepted block/factor the only lock authority.
- Audit session-key scopes, nonce races, duplicate clicks, replacement transactions, and sequencer reordering.

### P1 — production realtime transport

- Add a Robinhood Chain WebSocket/sequencer-feed adapter with HTTP fallback.
- Maintain a rolling robust estimate of block cadence and jitter.
- Bound forward prediction; enter degraded/held state when anchors stop.
- Use idempotent round and command IDs throughout.
- Persist the user's submitted lock intent across refresh and reconcile from chain state.

### P1 — UX parity

- Separate stage factor, attainable factor, intended marker, and accepted marker.
- Add signing/submitted/sequenced/locked microstates to the primary control.
- Make auto-lock visibly armed before launch and server/contract-executable without the tab.
- Preserve a `Previous / Live / Next` narrative on desktop and a swipe/stack version on mobile.
- On reconnect, lead with the authoritative outcome rather than replaying animation.

### P2 — observability and acceptance gates

Measure p50/p95/p99 for click-to-submit, submit-to-sequencer, sequencer-to-event, anchor jitter, prediction error, rejected-lock reasons, reconnect recovery, and client/server phase disagreement. Release gates should include:

- zero displayed rewinds in a round;
- zero false “locked” states;
- zero economic decisions from client time;
- no prediction more than the configured lead bound;
- auto-lock succeeds with the browser closed;
- refresh/background/reconnect never changes accepted value;
- terminal display equals contract settlement exactly.

## Bottom line

Plank should combine Bustabit's disposable-client/server-authority discipline, PancakeSwap's explicit transaction and round-state storytelling, and Robinhood Chain's low-latency sequencer feed. It should not copy the simplistic tick-stream architecture of most open-source crash clones, and it should not claim that a 100 ms L2 makes a visual multiplier instantly cashable.

The private alpha timing model is a useful rehearsal environment. The mainnet drand/manual-cash-out boundary is the highest-priority unresolved issue found in this review.
